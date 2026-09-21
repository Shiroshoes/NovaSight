"""
auto_train.py — NovaSight ML Training Pipeline
===============================================

Two families of models are trained on every run (once MIN_SEMESTERS_FOR_TRAINING
semesters exist):

A) Student-level models (DS01, unchanged role)
  Algorithm              Target                 CV strategy
  ─────────────────────────────────────────────────────────────────
  LogisticRegression     At_Risk (True/False)   Temporal leave-one-sem-out
  Ridge (alpha=1)        GWA (1.00-5.00)        Temporal leave-one-sem-out
  Ridge (alpha=10)       Completion_Rate (%)    Temporal leave-one-sem-out

B) Prediction-dashboard bundles  (NEW — replaces the DS04/DS05/DS06 trainers)
  pred_cube.pkl      one Ridge trend per (College x Course x Year_Level) series
                     and measure: headcount, irregular rate, GWA, completion
                     rate, and the FAILED/DRP/INC/UDR/W/NGA/CRD student rates.
                     Feeds: KPI tiles, At-Risk Forecast, GWA Trend.
  pred_subjects.pkl  one Ridge trend per (College x Course x Year_Level x
                     Subject_Code) series and measure: enrolled students,
                     FAILED/INC/DRP/UDR/W rate, average grade.
                     Feeds: Top Hardest Subjects (bar / cards / lines).

  Why per-series instead of one shared model: a single Ridge over label-encoded
  College/Course cannot give each course its own level, so every line on the
  dashboard collapsed onto the same trend. A per-series trend is what the
  multi-line charts actually need, and it extrapolates (RF/GBM/KNN/DT do not).

  Both bundles are read straight from the per-semester CSVs (by_year/…) via
  load_all_semesters(), NOT from the DS0x tables, so they adapt automatically to
  whatever the preprocessor writes (new Credits_Earned, CRD status, Subject_Name
  tails, …). They are plain dicts of numbers — no fitted sklearn objects — so
  they stay small (MySQL max_allowed_packet) and unpickle anywhere.

Prediction horizon (see compute_horizon):
  * KPI tiles ............ always 1 semester ahead
  * every other chart .... 2 semesters ahead at 6 semesters of data, then grows
                           by HORIZON_GROWTH_PER_2_SEMS for every 2 extra
                           semesters (1 more year of data), capped at half the
                           length of the history.
"""

import os
import re
import io
import inspect
import time
import traceback
from datetime import datetime

import numpy as np
import pandas as pd
import joblib

from sklearn.linear_model    import LogisticRegression, Ridge
from sklearn.preprocessing   import LabelEncoder, StandardScaler
from sklearn.pipeline        import Pipeline
from sklearn.model_selection import KFold

from sklearn.metrics import (
    r2_score, mean_squared_error, mean_absolute_error,
    accuracy_score, f1_score, roc_auc_score,
)

from preprocessing.preprocess import (
    load_all_semesters, count_semesters_with_data,
    FINAL_COLUMNS, PROCESSED_DIR, MODEL_DATA_DIR, FINAL_OUTPUT, BY_YEAR_DIR,
)

from util.db_io import (
    record_trained_model, read_semester_csvs, record_training_summary,
    save_model_blob, save_training_state, load_training_state,
    get_model_dataset,
)

try:
    from configs.config import PROCESSED_BY_YEAR_DIR, MIN_SEMESTERS_FOR_TRAINING
except ImportError:
    PROCESSED_BY_YEAR_DIR = BY_YEAR_DIR
    MIN_SEMESTERS_FOR_TRAINING = 6

# ── Constants ──────────────────────────────────────────────────────────────
# Prediction horizon
HORIZON_MIN_STEPS         = 1     # never less than 1 semester
HORIZON_BASE_SEMESTERS    = 6     # data size the base horizon is defined for
HORIZON_BASE_STEPS        = 2     # chart horizon at HORIZON_BASE_SEMESTERS
HORIZON_GROWTH_PER_2_SEMS = 1     # +N steps per 2 extra semesters (1 year). Set 2 for the aggressive end.
HORIZON_MAX_STEPS_FACTOR  = 0.5   # never forecast further than half the history length
HORIZON_DEFAULT_STEPS     = HORIZON_BASE_STEPS
KPI_STEPS                 = 1     # KPI tiles: 1 semester ahead only

# Per-series trend fitting
TREND_ALPHA              = 1.0    # Ridge shrinkage on the slope
TREND_MIN_POINTS         = 3      # fewer points than this -> flat (mean) forecast
SEM_DUMMY_MIN_POINTS     = 5      # 1st/2nd-sem offset only when the series is long enough
SUBJECT_MIN_POINTS       = 2      # a subject needs >=2 recorded terms to be forecast
SUBJECT_MIN_AVG_STUDENTS = 5      # ignore tiny sections (rate is just noise)

# Where the prediction bundles are mirrored on disk for the API (same tree the
# preprocessor already writes to). The DB blob copy is still written too.
PRED_MODEL_DIR = os.path.join(PROCESSED_DIR, "prediction_models")

# Grade-status vocabulary (student-count column, aliases)
STATUS_COUNT_COLS = {
    "FAILED": ["Failed_Count", "FAILED_Count", "Fail_Count"],
    "DRP":    ["DRP_Count", "Drop_Count", "DROP_Count"],
    "INC":    ["INC_Count"],
    "UDR":    ["UDR_Count"],
    "W":      ["W_Count"],
    "NGA":    ["NGA_Count"],
    "CRD":    ["CRD_Count"],
}
SUBJECT_STATUSES = ["FAILED", "INC", "DRP", "UDR", "W"]


# ── Logging ────────────────────────────────────────────────────────────────
def _log(msg):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


# ══════════════════════════════════════════════════════════════════════════
#  HELPERS
# ══════════════════════════════════════════════════════════════════════════

def _save(obj, filename):
    save_model_blob(filename, obj)
    return filename


def _save_bundle(obj, filename):
    """DB blob (like every other model) + a disk mirror the prediction API reads."""
    save_model_blob(filename, obj)
    try:
        os.makedirs(PRED_MODEL_DIR, exist_ok=True)
        tmp = os.path.join(PRED_MODEL_DIR, filename + ".tmp")
        joblib.dump(obj, tmp)
        os.replace(tmp, os.path.join(PRED_MODEL_DIR, filename))   # atomic swap
    except Exception as e:
        _log(f"  [WARN] disk mirror of {filename} failed: {e}")
    return filename


def _record(**kw):
    """record_trained_model() that never breaks training (and tolerates an older
    db_io that has no rmse column/param)."""
    if kw.get("error_message"):
        kw["error_message"] = str(kw["error_message"])[:480]      # keep it inside a VARCHAR
    try:
        try:
            record_trained_model(**kw)
        except TypeError:
            kw.pop("rmse", None)
            record_trained_model(**kw)
    except Exception as e:
        _log(f"  [WARN] record_trained_model({kw.get('model_name')}): {e}")


def _as_df(source):
    if isinstance(source, pd.DataFrame):
        return source.copy()
    return pd.read_csv(source)


def _dataset_from_table(table_name: str) -> pd.DataFrame:
    """Read from model_datasets (new) or legacy CSV-blob tables."""
    try:
        df = get_model_dataset(table_name)
        if not df.empty:
            return df
    except Exception:
        pass
    rows = read_semester_csvs(table_name)
    if rows.empty or "csv_file" not in rows.columns:
        return pd.DataFrame()
    frames = [pd.read_csv(io.StringIO(t)) for t in rows["csv_file"].dropna()]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def _r2(y_true, y_pred):
    try: return round(float(r2_score(y_true, y_pred)), 4)
    except Exception: return 0.0

def _mse(y_true, y_pred):
    try: return round(float(mean_squared_error(y_true, y_pred)), 4)
    except Exception: return 0.0

def _rmse(y_true, y_pred):
    try: return round(float(mean_squared_error(y_true, y_pred) ** 0.5), 4)
    except Exception: return 0.0

def _mae(y_true, y_pred):
    try: return round(float(mean_absolute_error(y_true, y_pred)), 4)
    except Exception: return 0.0

def _reg_metrics(y_true, y_pred):
    return {"r2": _r2(y_true, y_pred), "rmse": _rmse(y_true, y_pred),
            "mse": _mse(y_true, y_pred), "mae": _mae(y_true, y_pred)}


def _pick(df, candidates):
    """First candidate column present in df (case-insensitive), else None."""
    lower = {c.lower(): c for c in df.columns}
    for c in candidates:
        if c.lower() in lower:
            return lower[c.lower()]
    return None


# ══════════════════════════════════════════════════════════════════════════
#  TERM (academic year + semester) HELPERS
# ══════════════════════════════════════════════════════════════════════════
# A term is identified by  t = 2*start_year + (sem-1)  so consecutive semesters
# are consecutive integers, e.g. 2024-2025 1st sem = 4048, 2nd sem = 4049.

def _parse_year(v):
    m = re.search(r"(?:19|20)\d{2}", str(v))
    return int(m.group(0)) if m else None


def _parse_sem(v):
    s = str(v).strip().lower()
    if not s or s in ("nan", "none"):
        return None
    if "summer" in s or "mid" in s:
        return None                       # dashboard only knows 1st / 2nd sem
    if "first" in s or "1st" in s:
        return 1
    if "second" in s or "2nd" in s:
        return 2
    m = re.search(r"[12]", s)
    return int(m.group(0)) if m else None


def _term_label(year, sem):
    return f"{year}-{year + 1} {'1st' if sem == 1 else '2nd'} Sem"


def _t_of(year, sem):
    return 2 * int(year) + (int(sem) - 1)


def _year_sem_of(t):
    return int(t) // 2, int(t) % 2 + 1


def _term_frame(df):
    """Copy of df with _T (term index), _Y (start year) and _S (1/2) columns.
    Rows whose year/semester cannot be parsed are dropped."""
    out = df.copy()
    ycol = None
    for c in ("Academic_Year", "School_Year", "AY", "Year_Numeric", "Year"):
        col = _pick(out, [c])
        if col is not None and out[col].map(_parse_year).notna().any():
            ycol = col
            break
    scol = None
    for c in ("Semester", "Sem_Numeric", "Sem"):
        col = _pick(out, [c])
        if col is not None and out[col].map(_parse_sem).notna().any():
            scol = col
            break
    if ycol is None or scol is None:
        _log(f"  [WARN] cannot find year/semester columns (year={ycol}, sem={scol}); "
             f"columns seen: {list(out.columns)[:25]}")
        return out.iloc[0:0].assign(_Y=pd.Series(dtype="Int64"),
                                    _S=pd.Series(dtype="Int64"),
                                    _T=pd.Series(dtype="Int64"))
    out["_Y"] = out[ycol].map(_parse_year)
    out["_S"] = out[scol].map(_parse_sem)
    out = out[out["_Y"].notna() & out["_S"].isin([1, 2])].copy()
    out["_Y"] = out["_Y"].astype(int)
    out["_S"] = out["_S"].astype(int)
    out["_T"] = 2 * out["_Y"] + (out["_S"] - 1)
    return out


def compute_horizon(master_df) -> dict:
    """
    How far ahead the dashboard is allowed to predict, given the data on hand.

      KPI tiles ........ KPI_STEPS (1) semester, always.
      other charts ..... HORIZON_BASE_STEPS (2) at 6 semesters, +HORIZON_GROWTH_PER_2_SEMS
                         for every 2 extra semesters, never more than
                         HORIZON_MAX_STEPS_FACTOR x the history length.
    Returns a plain dict that is also embedded in every prediction bundle so the
    API/dashboard never has to recompute it.
    """
    tf = _term_frame(master_df)
    ts = sorted(int(t) for t in tf["_T"].unique()) if not tf.empty else []
    n = len(ts)
    if n == 0:
        return {"n_semesters": 0, "kpi_steps": 0, "chart_steps": 0, "terms": []}

    if n >= HORIZON_BASE_SEMESTERS:
        steps = HORIZON_BASE_STEPS + ((n - HORIZON_BASE_SEMESTERS) // 2) * HORIZON_GROWTH_PER_2_SEMS
    else:
        steps = max(HORIZON_MIN_STEPS, n // 3)
    steps = min(steps, max(HORIZON_MIN_STEPS, int(n * HORIZON_MAX_STEPS_FACTOR)))
    steps = max(HORIZON_MIN_STEPS, steps)

    last_t = ts[-1]
    terms = []
    for k in range(1, steps + 1):
        y, s = _year_sem_of(last_t + k)
        terms.append({"step": k, "t": last_t + k, "year": y, "sem": s, "label": _term_label(y, s)})
    fy, fs = _year_sem_of(ts[0])
    ly, ls = _year_sem_of(last_t)
    return {
        "n_semesters": n,
        "first_term": _term_label(fy, fs),
        "last_term": _term_label(ly, ls),
        "last_t": last_t,
        "kpi_steps": min(KPI_STEPS, steps),
        "chart_steps": steps,
        "min_steps": HORIZON_MIN_STEPS,
        "terms": terms,
        "horizon_year": terms[-1]["year"],
    }


# ══════════════════════════════════════════════════════════════════════════
#  PER-SERIES TREND (Ridge on term index)
# ══════════════════════════════════════════════════════════════════════════

def _fit_trend(t, y, t_ref, allow_sem=True):
    """
    Ridge(alpha=TREND_ALPHA) of y on term index (+ a 2nd-sem offset when the
    series is long enough).  Returns plain floats:
        y_hat(t) = b0 + bt*(t - t_ref) + bs*[t is a 2nd sem]
    Fewer than TREND_MIN_POINTS points -> flat forecast at the mean.
    None if there is nothing to fit.
    """
    t = np.asarray(t, dtype=float)
    y = np.asarray([np.nan if v is None else v for v in y], dtype=float)
    ok = np.isfinite(y)
    t, y = t[ok], y[ok]
    n = len(y)
    if n == 0:
        return None
    if n < TREND_MIN_POINTS:
        return {"b0": float(y.mean()), "bt": 0.0, "bs": 0.0, "n": int(n),
                "fit_rmse": float(y.std()) if n > 1 else 0.0, "kind": "flat"}

    cols = [t - t_ref]
    sem2 = (t.astype(int) % 2 == 1).astype(float)
    use_sem = bool(allow_sem and n >= SEM_DUMMY_MIN_POINTS
                   and sem2.sum() >= 2 and (n - sem2.sum()) >= 2)
    if use_sem:
        cols.append(sem2)
    X = np.column_stack(cols)
    reg = Ridge(alpha=TREND_ALPHA).fit(X, y)
    pred = reg.predict(X)
    return {
        "b0": float(reg.intercept_),
        "bt": float(reg.coef_[0]),
        "bs": float(reg.coef_[1]) if use_sem else 0.0,
        "n": int(n),
        "fit_rmse": float(np.sqrt(np.mean((y - pred) ** 2))),
        "kind": "ridge",
    }


def _predict_trend(m, t, t_ref):
    return m["b0"] + m["bt"] * (t - t_ref) + m["bs"] * (1.0 if int(t) % 2 == 1 else 0.0)


def _backtest(series_list, measure, t_ref, allow_sem=True, min_points=TREND_MIN_POINTS + 1):
    """Leave-last-term-out over every series: the fitted trend vs 'repeat last value'.
    A series needs `min_points` recorded terms to take part; with only 2 prior
    points _fit_trend falls back to a flat forecast, so a short-series backtest
    validates that fallback, not the slope."""
    err_m, err_n = [], []
    for s in series_list:
        y = s["y"].get(measure)
        if y is None:
            continue
        pts = [(t, v) for t, v in zip(s["t"], y) if v is not None and np.isfinite(v)]
        if len(pts) < min_points:
            continue
        tt, yy = zip(*pts)
        m = _fit_trend(tt[:-1], yy[:-1], t_ref, allow_sem=allow_sem)
        if m is None:
            continue
        err_m.append(abs(_predict_trend(m, tt[-1], t_ref) - yy[-1]))
        err_n.append(abs(yy[-2] - yy[-1]))
    if not err_m:
        return {"mae": None, "rmse": None, "naive_mae": None, "n": 0}
    return {"mae": round(float(np.mean(err_m)), 4),
            "rmse": round(float(np.sqrt(np.mean(np.square(err_m)))), 4),
            "naive_mae": round(float(np.mean(err_n)), 4), "n": len(err_m)}


# ══════════════════════════════════════════════════════════════════════════
#  COLUMN NORMALISERS
# ══════════════════════════════════════════════════════════════════════════

def _year_level_num(df):
    col = _pick(df, ["Year_Level_Num", "Year_Level", "YearLevel", "Year Level"])
    if col is None:
        return pd.Series(0, index=df.index)
    s = pd.to_numeric(df[col], errors="coerce")
    if s.isna().all():
        s = pd.to_numeric(df[col].astype(str).str.extract(r"(\d)")[0], errors="coerce")
    s = s.where(s.between(1, 6)).fillna(0).astype(int)
    return s


def _irregular_flag(df):
    """Registrar Regular/Irregular flag if the file has one; else the dashboard's
    own definition (>=1 failed or dropped subject). Returns (bool Series, source)."""
    for c in ("is_irregular", "Is_Irregular", "IsIrregular", "Irregular"):
        col = _pick(df, [c])
        if col:
            s = df[col]
            if s.dtype == object:
                sl = s.astype(str).str.lower().str.strip()
                return (sl.str.contains("irreg") | sl.isin(["1", "true", "yes", "y"])), col
            return (pd.to_numeric(s, errors="coerce").fillna(0) > 0), col
    for c in ("Student_Type", "Regular_Irregular", "Regularity", "Classification"):
        col = _pick(df, [c])
        if col:
            return df[col].astype(str).str.lower().str.contains("irreg"), col
    f = _pick(df, STATUS_COUNT_COLS["FAILED"])
    d = _pick(df, STATUS_COUNT_COLS["DRP"])
    fv = pd.to_numeric(df[f], errors="coerce").fillna(0) if f else 0
    dv = pd.to_numeric(df[d], errors="coerce").fillna(0) if d else 0
    return ((fv > 0) | (dv > 0)), "derived(Failed_Count>0 or DRP_Count>0)"


def _norm_status(status_s, grade_num, grade_txt):
    """Upper-case status; falls back to a text 'grade' like DRP/INC when the
    Status column is blank; DROP/DROPPED -> DRP, FAIL -> FAILED."""
    st = status_s.astype(str).str.upper().str.strip()
    st = st.where(~st.isin(["NAN", "NONE", "NULL"]), "")
    st = st.where(st != "", grade_txt.where(grade_num.isna(), ""))
    return st.replace({"DROP": "DRP", "DROPPED": "DRP", "FAIL": "FAILED"})


# ══════════════════════════════════════════════════════════════════════════
#  BUNDLE 1 — pred_cube  (College x Course x Year_Level)
# ══════════════════════════════════════════════════════════════════════════

def _build_student_cube(master_df):
    df = _term_frame(master_df)
    if df.empty:
        return None, {}
    c_col = _pick(df, ["College", "Department"])
    r_col = _pick(df, ["Course", "Course_Program", "Program"])
    if c_col is None or r_col is None:
        _log(f"  [WARN] pred_cube: need College+Course columns, have {list(df.columns)[:25]}")
        return None, {}

    sid = _pick(df, ["Student_ID", "StudentID"])
    df["_sid"] = df[sid] if sid else df.index
    df["_C"] = df[c_col].astype(str).str.strip()
    df["_R"] = df[r_col].astype(str).str.strip()
    df["_YL"] = _year_level_num(df)
    df["_irr"], irr_src = _irregular_flag(df)
    df["_irr"] = df["_irr"].astype(int)

    gcol = _pick(df, ["GWA"])
    gwa = pd.to_numeric(df[gcol], errors="coerce") if gcol else pd.Series(np.nan, index=df.index)
    # blank/0 GWA = student with (almost) all subjects failed/status -> accurate,
    # not invalid, but it has no average to contribute to the mean.
    df["_gwa"] = gwa.where(gwa > 0)

    statuses = []
    for st, cands in STATUS_COUNT_COLS.items():
        col = _pick(df, cands)
        if col:
            df[f"_has_{st}"] = (pd.to_numeric(df[col], errors="coerce").fillna(0) > 0).astype(int)
            statuses.append(st)

    ue = _pick(df, ["Units_Enrolled_Reported", "Credits_Enrolled", "Units_Enrolled"])
    uu = _pick(df, ["Units_Earned", "Credits_Earned"])
    if ue and uu:
        df["_ue"] = pd.to_numeric(df[ue], errors="coerce").fillna(0)
        df["_uu"] = pd.to_numeric(df[uu], errors="coerce").fillna(0)

    spec = {"students": ("_sid", "nunique"), "irregular": ("_irr", "sum"), "gwa": ("_gwa", "mean")}
    for st in statuses:
        spec[f"n_{st}"] = (f"_has_{st}", "sum")
    if ue and uu:
        spec["ue"] = ("_ue", "sum")
        spec["uu"] = ("_uu", "sum")

    cube = df.groupby(["_T", "_C", "_R", "_YL"]).agg(**spec).reset_index()
    s = cube["students"].replace(0, np.nan)
    cube["irregular_rate"] = cube["irregular"] / s
    for st in statuses:
        cube[f"{st.lower()}_rate"] = cube[f"n_{st}"] / s
    if ue and uu:
        cube["completion_rate"] = (cube["uu"] / cube["ue"].replace(0, np.nan)).clip(0, 1)
    info = {"statuses": statuses, "irregular_source": irr_src, "has_completion": bool(ue and uu)}
    return cube, info


def train_pred_cube(state: dict, master_df: pd.DataFrame):
    """KPI / At-Risk Forecast / GWA Trend backbone: one Ridge trend per series+measure."""
    _log("Training pred_cube (Ridge trend per College x Course x Year_Level)…")
    cube, info = _build_student_cube(master_df)
    if cube is None or cube.empty:
        _log("  pred_cube: no usable student data — skipping")
        return
    _log(f"  irregular flag from: {info['irregular_source']}; statuses: {info['statuses']}")

    measures = ["students", "irregular_rate", "gwa"]
    measures += [f"{st.lower()}_rate" for st in info["statuses"]]
    if info["has_completion"]:
        measures.append("completion_rate")

    horizon = state.get("horizon") or compute_horizon(master_df)
    t_ref = int(cube["_T"].min())

    series = []
    for (c, r, yl), g in cube.sort_values("_T").groupby(["_C", "_R", "_YL"]):
        ts = [int(x) for x in g["_T"]]
        y = {m: [None if pd.isna(v) else float(v) for v in g[m]] for m in measures}
        models = {m: _fit_trend(ts, y[m], t_ref, allow_sem=True) for m in measures}
        series.append({"college": c, "course": r, "yl": int(yl), "t": ts, "y": y,
                       "m": {k: v for k, v in models.items() if v is not None}})

    bt_students = _backtest(series, "students", t_ref)
    bt_gwa = _backtest(series, "gwa", t_ref)
    bt_fail = _backtest(series, "failed_rate", t_ref) if "FAILED" in info["statuses"] else {}
    _log(f"  backtest students: MAE={bt_students['mae']} (repeat-last MAE={bt_students['naive_mae']}, n={bt_students['n']})")
    _log(f"  backtest GWA     : MAE={bt_gwa['mae']} (repeat-last MAE={bt_gwa['naive_mae']}, n={bt_gwa['n']})")

    bundle = {
        "format": "novasight_pred_cube_v1",
        "trained_at": datetime.now().isoformat(),
        "horizon": horizon,
        "t_ref": t_ref,
        "measures": measures,
        "statuses": info["statuses"],
        "irregular_source": info["irregular_source"],
        "series": series,
        "backtest": {"students": bt_students, "gwa": bt_gwa, "failed_rate": bt_fail},
    }
    fname = _save_bundle(bundle, "pred_cube.pkl")
    state["models"]["pred_cube"] = {
        "algorithm": "Ridge(alpha=1) per series", "series": len(series),
        "measures": measures, "backtest": bundle["backtest"], "status": "ok",
    }
    _log(f"  pred_cube: {len(series)} series x {len(measures)} measures saved")

    hy = horizon.get("horizon_year")
    _record(model_name="pred_cube_students", algorithm="Ridge(alpha=1) per series",
            target_column="students (headcount)", source_dataset="by_year master",
            file_path=fname, status="ok", mae=bt_students["mae"], rmse=bt_students["rmse"],
            horizon_year=hy)
    _record(model_name="pred_cube_gwa", algorithm="Ridge(alpha=1) per series",
            target_column="GWA", source_dataset="by_year master",
            file_path=fname, status="ok", mae=bt_gwa["mae"], rmse=bt_gwa["rmse"],
            horizon_year=hy)


# ══════════════════════════════════════════════════════════════════════════
#  BUNDLE 2 — pred_subjects  (College x Course x Year_Level x Subject)
# ══════════════════════════════════════════════════════════════════════════

def _build_subject_cube(long_df, master_df=None):
    df = _term_frame(long_df)
    if df.empty:
        raise ValueError("long-form grades are empty or have no Academic_Year/Semester column; "
                         f"columns: {list(long_df.columns)[:15]}")
    code = _pick(df, ["Subject_Code", "Course_Code", "Code", "Subject_ID", "Subj_Code", "Subject"])
    title = _pick(df, ["Subject_Name", "Subject_Title_Catalog", "Subject_Title", "Subject_Description",
                       "Descriptive_Title", "Subject"])
    g_col = _pick(df, ["Grade", "Grade_Numeric", "Final_Grade", "Grade_Value", "Final_Rating"])
    s_col = _pick(df, ["Status", "Grade_Status", "Remarks"])
    sid = _pick(df, ["Student_ID", "StudentID", "Student_No", "ID"])
    c_col = _pick(df, ["College", "Department"])
    r_col = _pick(df, ["Course", "Course_Program", "Program"])
    yl_col = _pick(df, ["Year_Level_Num", "Year_Level", "YearLevel", "Year Level"])
    df["_sid"] = df[sid].astype(str) if sid else df.index.astype(str)

    # The long-form grade file usually has one row per student x subject and may NOT repeat
    # the student's College / Course / Year level -- those live in the student file. Borrow
    # whatever is missing from master_df, matched on Student_ID + term.
    df["_C"] = df[c_col].astype(str).str.strip() if c_col else None
    df["_R"] = df[r_col].astype(str).str.strip() if r_col else None
    df["_YL"] = _year_level_num(df) if yl_col else 0
    if (not c_col or not r_col or not yl_col) and master_df is not None and sid:
        m = _term_frame(master_df)
        msid = _pick(m, ["Student_ID", "StudentID", "Student_No", "ID"])
        mc = _pick(m, ["College", "Department"])
        mr = _pick(m, ["Course", "Course_Program", "Program"])
        if msid and mc and mr and not m.empty:
            m["_sid"] = m[msid].astype(str)
            m["_mC"] = m[mc].astype(str).str.strip()
            m["_mR"] = m[mr].astype(str).str.strip()
            m["_mYL"] = _year_level_num(m)
            m = m[["_sid", "_T", "_mC", "_mR", "_mYL"]].drop_duplicates(["_sid", "_T"])
            n0 = len(df)
            df = df.merge(m, on=["_sid", "_T"], how="left")
            hit = float(df["_mC"].notna().mean()) if n0 else 0.0
            _log(f"  pred_subjects: borrowed College/Course/Year_Level from the student file "
                 f"for {hit:.0%} of {n0:,} grade rows")
            if not c_col:
                df["_C"] = df["_mC"]
            if not r_col:
                df["_R"] = df["_mR"]
            if not yl_col:
                df["_YL"] = df["_mYL"].fillna(0).astype(int)
            df = df[df["_C"].notna() & df["_R"].notna()].copy()

    missing = [n for n, ok in (("Subject_Code", code), ("Grade or Status", g_col or s_col),
                               ("College", c_col or ("_mC" in df.columns)),
                               ("Course", r_col or ("_mR" in df.columns))) if not ok]
    if missing or df.empty:
        raise ValueError(f"long-form grades: missing {missing or 'students matching the student file'}; "
                         f"long-form columns: {list(long_df.columns)[:15]}"
                         + (f"; student-file columns: {list(master_df.columns)[:15]}" if master_df is not None else ""))

    if title == code:
        title = None
    df["_code"] = df[code].astype(str).str.strip()
    df["_title"] = df[title].astype(str).str.strip() if title else df["_code"]

    g_num = pd.to_numeric(df[g_col], errors="coerce") if g_col else pd.Series(np.nan, index=df.index)
    g_txt = df[g_col].astype(str).str.upper().str.strip() if g_col else pd.Series("", index=df.index)
    st_raw = df[s_col] if s_col else pd.Series("", index=df.index)
    st = _norm_status(st_raw, g_num, g_txt)

    df["_failed"] = ((st == "FAILED") | (g_num >= 5.0)).astype(int)
    for s_ in ("INC", "DRP", "UDR", "W"):
        df[f"_{s_}"] = (st == s_).astype(int)
    # CRD (credited) is a passing status: counts as enrolled, never as a problem.
    df["_g"] = g_num.where(g_num.between(1.0, 5.0))

    keys = ["_T", "_C", "_R", "_YL", "_code"]
    cube = df.groupby(keys).agg(
        students=("_sid", "nunique"), failed=("_failed", "sum"), inc=("_INC", "sum"),
        drp=("_DRP", "sum"), udr=("_UDR", "sum"), w=("_W", "sum"), avg_grade=("_g", "mean"),
    ).reset_index()
    s = cube["students"].replace(0, np.nan)
    for a in ("failed", "inc", "drp", "udr", "w"):
        cube[f"{a}_rate"] = cube[a] / s

    # one display title per code (most frequent wins)
    titles = (df.groupby("_code")["_title"]
                .agg(lambda x: x.value_counts().index[0]).to_dict())
    cube.attrs["titles"] = titles
    return cube


def train_pred_subjects(state: dict, long_df: pd.DataFrame, master_df: pd.DataFrame):
    """Top Hardest Subjects backbone: one Ridge trend per subject series+measure."""
    _log("Training pred_subjects (Ridge trend per College x Course x Year_Level x Subject)…")
    cube = _build_subject_cube(long_df, master_df)
    if cube is None or cube.empty:
        raise ValueError("no usable rows in the long-form grades")
    titles = cube.attrs.get("titles", {})
    measures = ["students", "failed_rate", "inc_rate", "drp_rate", "udr_rate", "w_rate", "avg_grade"]
    horizon = state.get("horizon") or compute_horizon(master_df)
    t_ref = int(cube["_T"].min())

    series, dropped = [], 0
    for (c, r, yl, code), g in cube.sort_values("_T").groupby(["_C", "_R", "_YL", "_code"]):
        if len(g) < SUBJECT_MIN_POINTS or g["students"].mean() < SUBJECT_MIN_AVG_STUDENTS:
            dropped += 1
            continue
        ts = [int(x) for x in g["_T"]]
        y = {m: [None if pd.isna(v) else float(v) for v in g[m]] for m in measures}
        # a subject is offered in one semester slot, so no 1st/2nd-sem offset here
        models = {m: _fit_trend(ts, y[m], t_ref, allow_sem=False) for m in measures}
        series.append({
            "college": c, "course": r, "yl": int(yl), "code": code,
            "title": titles.get(code, code),
            "sems": sorted({t % 2 + 1 for t in ts}), "last_t": ts[-1],
            "t": ts, "y": y, "m": {k: v for k, v in models.items() if v is not None},
        })
    if not series:
        raise ValueError(f"every subject series was dropped ({dropped} of them): a subject needs "
                         f">={SUBJECT_MIN_POINTS} recorded terms and >={SUBJECT_MIN_AVG_STUDENTS} students on average")

    bt_grade = _backtest(series, "avg_grade", t_ref, allow_sem=False, min_points=3)
    bt_fail = _backtest(series, "failed_rate", t_ref, allow_sem=False, min_points=3)
    _log(f"  {len(series)} subject series kept, {dropped} dropped (too short/small)")
    _log(f"  backtest avg_grade : MAE={bt_grade['mae']} (repeat-last MAE={bt_grade['naive_mae']}, n={bt_grade['n']})")
    _log(f"  backtest failed_rate: MAE={bt_fail['mae']} (repeat-last MAE={bt_fail['naive_mae']}, n={bt_fail['n']})")

    bundle = {
        "format": "novasight_pred_subjects_v1",
        "trained_at": datetime.now().isoformat(),
        "horizon": horizon,
        "t_ref": t_ref,
        "measures": measures,
        "series": series,
        "backtest": {"avg_grade": bt_grade, "failed_rate": bt_fail},
    }
    fname = _save_bundle(bundle, "pred_subjects.pkl")
    state["models"]["pred_subjects"] = {
        "algorithm": "Ridge(alpha=1) per series", "series": len(series),
        "backtest": bundle["backtest"], "status": "ok",
    }
    hy = horizon.get("horizon_year")
    _record(model_name="pred_subjects_avg_grade", algorithm="Ridge(alpha=1) per series",
            target_column="Avg_Grade", source_dataset="by_year long-form",
            file_path=fname, status="ok", mae=bt_grade["mae"], rmse=bt_grade["rmse"],
            horizon_year=hy)
    _record(model_name="pred_subjects_fail_rate", algorithm="Ridge(alpha=1) per series",
            target_column="Fail_Rate", source_dataset="by_year long-form",
            file_path=fname, status="ok", mae=bt_fail["mae"], rmse=bt_fail["rmse"],
            horizon_year=hy)


# ══════════════════════════════════════════════════════════════════════════
#  TEMPORAL CV HELPER (DS01 models)
# ══════════════════════════════════════════════════════════════════════════

def _temporal_splits(df: pd.DataFrame):
    """
    Yield (train_pos, test_pos) POSITIONAL index arrays for leave-one-semester-out
    temporal CV (train on every earlier semester, test on the next one).
    Falls back to 5-fold KFold when Year_Numeric/Sem_Numeric are missing or there
    is only 1 semester.
    """
    def _kfold():
        kf = KFold(n_splits=5, shuffle=True, random_state=42)
        yield from kf.split(df)

    if "Year_Numeric" not in df.columns or "Sem_Numeric" not in df.columns:
        yield from _kfold(); return

    k = (pd.to_numeric(df["Year_Numeric"], errors="coerce") * 2
         + pd.to_numeric(df["Sem_Numeric"], errors="coerce")).to_numpy()
    uniq = np.unique(k[~np.isnan(k)])
    if len(uniq) < 2:
        yield from _kfold(); return

    for cur in uniq[1:]:
        train_pos = np.where(k < cur)[0]
        test_pos = np.where(k == cur)[0]
        if len(train_pos) and len(test_pos):
            yield train_pos, test_pos


def _encode_features(df, cat_cols, feat_cols):
    """LabelEncode categoricals; returns (X, used_columns, encoders).
    The encoders are returned so they can be stored WITH the model — without them
    the pickled model cannot be applied to new rows consistently."""
    df = df.copy()
    encoders = {}
    for col in cat_cols:
        if col in df.columns:
            le = LabelEncoder()
            df[col + "_enc"] = le.fit_transform(df[col].astype(str).fillna("Unknown"))
            encoders[col] = le
    cols = [c for c in feat_cols if c in df.columns]
    return df[cols].fillna(0).values, cols, encoders


# ══════════════════════════════════════════════════════════════════════════
#  DS01 STUDENT-LEVEL TRAINERS
# ══════════════════════════════════════════════════════════════════════════

_DS01_CAT = ["College", "Course", "Gender", "Year_Level", "GWA_Source"]
_DS01_FEAT = ["College_enc", "Course_enc", "Gender_enc", "Year_Level_Num",
              "Units_Enrolled_Reported", "Failed_Count", "DRP_Count",
              "INC_Count", "UDR_Count", "W_Count", "NGA_Count", "GWA_Source_enc",
              "At_Risk_Ratio", "Completion_Rate"]


def train_at_risk(state: dict):
    """
    DS01 — At_Risk classification using Logistic Regression.
    Temporal leave-one-semester-out CV (metrics are out-of-fold).
    """
    _log("Training at_risk model (LogisticRegression)…")
    df = _dataset_from_table("DS01")
    if df.empty or "At_Risk" not in df.columns:
        _log("  DS01 empty — skipping")
        return

    # NOTE: rows are NOT filtered on GWA here. A student whose GWA is blank/0
    # because (nearly) every subject is failed/status is a real, accurate,
    # highest-risk case — dropping them removed exactly the positives this
    # classifier exists to find. GWA isn't a feature of this model anyway.
    df = df.reset_index(drop=True)
    X, used, encs = _encode_features(df, _DS01_CAT, _DS01_FEAT)
    y = df["At_Risk"].astype(int).values

    def _new_clf():
        return Pipeline([
            ("sc",  StandardScaler()),
            ("clf", LogisticRegression(
                max_iter=1000, class_weight="balanced", C=1.0, random_state=42)),
        ])

    f1s, aucs, accs = [], [], []
    for train_pos, test_pos in _temporal_splits(df):
        if len(np.unique(y[train_pos])) < 2:
            continue                                    # cannot fit on one class
        m = _new_clf().fit(X[train_pos], y[train_pos])
        y_pred = m.predict(X[test_pos])
        f1s.append(f1_score(y[test_pos], y_pred, zero_division=0))
        accs.append(accuracy_score(y[test_pos], y_pred))
        if len(np.unique(y[test_pos])) == 2:            # AUC undefined on one class
            aucs.append(roc_auc_score(y[test_pos], m.predict_proba(X[test_pos])[:, 1]))

    clf = _new_clf().fit(X, y)
    clf.encoders_ = encs
    clf.feature_names_ = used
    _save(clf, "at_risk_classifier.pkl")

    result = {
        "algorithm": "LogisticRegression", "target": "At_Risk", "source_dataset": "DS01",
        "f1": round(float(np.mean(f1s)), 4) if f1s else None,
        "accuracy": round(float(np.mean(accs)), 4) if accs else None,
        "r2": None, "mae": None, "rmse": None, "mse": None, "status": "ok",
    }
    state["models"]["at_risk"] = result
    _log(f"  at_risk: F1={result['f1']}  acc={result['accuracy']}  "
         f"AUC≈{round(float(np.mean(aucs)), 4) if aucs else None}")

    _record(model_name="at_risk_classifier", algorithm="LogisticRegression",
            target_column="At_Risk", source_dataset="DS01",
            file_path="at_risk_classifier.pkl", status="ok",
            f1_score=result["f1"], accuracy=result["accuracy"],
            horizon_year=state.get("horizon", {}).get("horizon_year"))


def train_gwa(state: dict):
    """
    DS01 — GWA regression using Ridge(alpha=1).
    Temporal leave-one-semester-out CV.
    """
    _log("Training gwa model (Ridge α=1)…")
    df = _dataset_from_table("DS01")
    if df.empty or "GWA" not in df.columns:
        _log("  DS01 empty — skipping")
        return

    gwa = pd.to_numeric(df["GWA"], errors="coerce")
    df = df[gwa.notna() & (gwa > 0)].reset_index(drop=True)     # blank/0 = no average to learn from
    if df.empty:
        _log("  DS01 has no valid GWA rows — skipping"); return
    X, used, encs = _encode_features(df, _DS01_CAT, _DS01_FEAT)
    y = pd.to_numeric(df["GWA"]).values

    def _new_reg():
        return Pipeline([("sc", StandardScaler()), ("reg", Ridge(alpha=1.0))])

    r2s, maes = [], []
    for train_pos, test_pos in _temporal_splits(df):
        pred = _new_reg().fit(X[train_pos], y[train_pos]).predict(X[test_pos])
        r2s.append(r2_score(y[test_pos], pred))
        maes.append(mean_absolute_error(y[test_pos], pred))

    reg = _new_reg().fit(X, y)
    reg.encoders_ = encs
    reg.feature_names_ = used
    _save(reg, "gwa_regression.pkl")

    result = {
        "algorithm": "Ridge", "alpha": 1, "target": "GWA", "source_dataset": "DS01",
        "r2": round(float(np.mean(r2s)), 4) if r2s else None,
        "mae": round(float(np.mean(maes)), 4) if maes else None,
        "rmse": None, "mse": None, "accuracy": None, "f1": None, "status": "ok",
    }
    state["models"]["gwa_regression"] = result
    _log(f"  gwa_regression: R²={result['r2']}  MAE={result['mae']}")

    _record(model_name="gwa_regression", algorithm="Ridge(alpha=1)",
            target_column="GWA", source_dataset="DS01",
            file_path="gwa_regression.pkl", status="ok",
            r2_score=result["r2"], mae=result["mae"],
            horizon_year=state.get("horizon", {}).get("horizon_year"))


def train_completion_rate_forecast(state: dict):
    """
    DS01 — Completion_Rate (Credits_Earned / Credits_Enrolled) using Ridge(alpha=10).
    Stricter regularization to avoid data leakage.
    """
    _log("Training completion_rate forecast (Ridge α=10)…")
    df = _dataset_from_table("DS01")
    if df.empty or "Completion_Rate" not in df.columns:
        _log("  DS01 empty — skipping"); return

    df = df[df["Completion_Rate"].notna()].reset_index(drop=True)
    if df.empty:
        _log("  DS01 has no Completion_Rate rows — skipping"); return
    feat = [f for f in _DS01_FEAT if f not in ("Units_Enrolled_Reported", "Completion_Rate")]
    X, used, encs = _encode_features(df, _DS01_CAT, feat)
    y = df["Completion_Rate"].values

    def _new_reg():
        return Pipeline([("sc", StandardScaler()), ("reg", Ridge(alpha=10.0))])

    r2s, maes = [], []
    for train_pos, test_pos in _temporal_splits(df):
        pred = _new_reg().fit(X[train_pos], y[train_pos]).predict(X[test_pos])
        r2s.append(r2_score(y[test_pos], pred))
        maes.append(mean_absolute_error(y[test_pos], pred))

    reg = _new_reg().fit(X, y)
    reg.encoders_ = encs
    reg.feature_names_ = used
    _save(reg, "completion_rate_forecast.pkl")

    result = {
        "algorithm": "Ridge", "alpha": 10, "target": "Completion_Rate", "source_dataset": "DS01",
        "r2": round(float(np.mean(r2s)), 4) if r2s else None,
        "mae": round(float(np.mean(maes)), 4) if maes else None,
        "status": "ok",
    }
    state["models"]["completion_rate_forecast"] = result
    _log(f"  completion_rate_forecast: R²={result['r2']}  MAE={result['mae']}")
    _record(model_name="completion_rate_forecast", algorithm="Ridge(alpha=10)",
            target_column="Completion_Rate", source_dataset="DS01",
            file_path="completion_rate_forecast.pkl", status="ok",
            r2_score=result["r2"], mae=result["mae"],
            horizon_year=state.get("horizon", {}).get("horizon_year"))


# 2026-09-21: train_hardest_subjects (DS04), train_at_risk_forecast (DS05) and
# train_gwa_trend (DS06) were removed. DS04's Ridge used Failed_Count/Student_Count
# as features to predict Fail_Rate (= Failed_Count/Student_Count: it predicted its own
# inputs and had no time axis, so it could not forecast a future semester at all), and
# DS05/DS06 fit ONE Ridge over label-encoded College/Course, which cannot give each
# course its own level. train_pred_subjects / train_pred_cube above replace them with a
# real per-series trend built from the per-semester CSVs.


# ══════════════════════════════════════════════════════════════════════════
#  TRAINING SUMMARY (db_io.record_training_summary)
# ══════════════════════════════════════════════════════════════════════════

def _dataset_summary(master_df: pd.DataFrame) -> dict:
    out = {}
    sid = _pick(master_df, ["Student_ID"])
    out["total_students"] = int(master_df[sid].nunique()) if sid else int(len(master_df))
    g = pd.to_numeric(master_df[_pick(master_df, ["GWA"])], errors="coerce") \
        if _pick(master_df, ["GWA"]) else pd.Series(dtype=float)
    g = g[g > 0].dropna()
    if len(g):
        out.update(gwa_mean=round(float(g.mean()), 4), gwa_std=round(float(g.std()), 4),
                   gwa_min=round(float(g.min()), 4), gwa_max=round(float(g.max()), 4))
    gender = _pick(master_df, ["Gender", "Sex"])
    if gender:
        gs = master_df[gender].astype(str).str.strip().str.lower()
        out["male_pct"] = round(float(gs.isin(["m", "male"]).mean() * 100), 2)
        out["female_pct"] = round(float(gs.isin(["f", "female"]).mean() * 100), 2)
    irr, _ = _irregular_flag(master_df)
    out["irregular_pct"] = round(float(irr.mean() * 100), 2)
    out["regular_pct"] = round(100.0 - out["irregular_pct"], 2)
    return out


def _record_training_summary(state: dict, master_df: pd.DataFrame):
    """One row per full run. record_training_summary()'s signature is inspected so
    this works whether it takes one dict or keyword columns."""
    try:
        models = state.get("models", {})
        errs = sum(1 for v in models.values() if isinstance(v, dict) and v.get("status") == "error")
        summary = _dataset_summary(master_df)
        summary.update(
            models_trained=len(models) - errs, models_errored=errs,
            horizon_year=state.get("horizon", {}).get("horizon_year"),
            training_status=state.get("training_status"),
            elapsed_seconds=state.get("elapsed_seconds"),
            trained_at=state.get("trained_at"),
        )
        params = [p for p in inspect.signature(record_training_summary).parameters.values()
                  if p.kind in (p.POSITIONAL_ONLY, p.POSITIONAL_OR_KEYWORD, p.KEYWORD_ONLY)]
        if len(params) == 1 and params[0].name not in summary:
            record_training_summary(summary)                       # takes one dict
        else:
            names = {p.name for p in params}
            record_training_summary(**{k: v for k, v in summary.items() if k in names})
    except Exception as e:
        _log(f"  [WARN] record_training_summary: {e}")


# ══════════════════════════════════════════════════════════════════════════
#  PIPELINE
# ══════════════════════════════════════════════════════════════════════════

def run_full_pipeline(new_file=None) -> dict:
    """
    Run the full ML training pipeline (skipped until MIN_SEMESTERS_FOR_TRAINING
    semesters of data exist).
      1. DS01 student-level models
      2. Prediction-dashboard bundles (pred_cube, pred_subjects) built from the
         per-semester CSVs, with the horizon from compute_horizon().
    """
    start_time = time.time()
    _log("=" * 55)
    _log("Starting NovaSight ML Training Pipeline")
    _log("=" * 55)

    n_sems = count_semesters_with_data(BY_YEAR_DIR)
    _log(f"Semesters with data: {n_sems} / {MIN_SEMESTERS_FOR_TRAINING} required")

    if n_sems < MIN_SEMESTERS_FOR_TRAINING:
        _log("Not enough semesters — training skipped")
        return {
            "success": False,
            "reason": f"Need {MIN_SEMESTERS_FOR_TRAINING} semesters, have {n_sems}",
            "models": {},
        }

    master_df, long_df = load_all_semesters(BY_YEAR_DIR)
    if master_df.empty:
        _log("No student data found — training skipped")
        return {"success": False, "reason": "No data", "models": {}}

    state = {
        "training_status": "running",
        "models": {},
        "errors": [],
        "trained_at": datetime.now().isoformat(),
    }

    # ── Horizon (1 sem for KPI, 2+ sems for charts; grows with data) ──────
    try:
        state["horizon"] = compute_horizon(master_df)
        h = state["horizon"]
        _log(f"Horizon: {h.get('n_semesters')} semesters recorded "
             f"({h.get('first_term')} → {h.get('last_term')}); "
             f"KPI {h.get('kpi_steps')} sem ahead, charts {h.get('chart_steps')} sems ahead")
    except Exception as e:
        state["horizon"] = {}
        _log(f"  [WARN] compute_horizon failed: {e}")

    trainers = [
        ("at_risk",                  lambda s: train_at_risk(s)),
        ("gwa_regression",           lambda s: train_gwa(s)),
        ("completion_rate_forecast", lambda s: train_completion_rate_forecast(s)),
        ("pred_cube",                lambda s: train_pred_cube(s, master_df)),
        ("pred_subjects",            lambda s: train_pred_subjects(s, long_df, master_df)),
    ]
    for name, fn in trainers:
        try:
            fn(state)
        except Exception as e:
            _log(f"  [ERROR] {name} failed: {e}")
            _log(traceback.format_exc())
            state["errors"].append({"trainer": name, "error": str(e)})
            state["models"][name] = {"status": "error", "error": str(e)}
            _record(model_name=name, status="error", error_message=str(e),
                    horizon_year=state.get("horizon", {}).get("horizon_year"))

    state["training_status"] = "done"
    state["elapsed_seconds"] = round(time.time() - start_time, 1)
    ok = len([v for v in state["models"].values()
              if isinstance(v, dict) and v.get("status") != "error"])
    _log(f"Pipeline complete in {state['elapsed_seconds']}s — models trained: {ok}")

    _record_training_summary(state, master_df)

    try:
        save_training_state(state)
    except Exception as e:
        _log(f"  [WARN] save_training_state failed: {e}")

    try:
        from ml_route.ml_analysis import reload_models
        reload_models()
    except Exception as e:
        _log(f"  [WARN] reload_models: {e}")

    try:
        from ml_route.prediction_api import reload_bundles
        reload_bundles()
    except Exception as e:
        _log(f"  [WARN] reload_bundles: {e}")

    return state


# ── End of auto_train.py ─────────────────────────────────────────────────