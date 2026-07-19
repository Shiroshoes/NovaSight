import os
import joblib
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import io
import base64
from flask import Blueprint, jsonify, request


from configs.config import FINAL_MERGED_CSV, ML_MODEL_DIR, MODEL_DATASETS_DIR

ml_bp = Blueprint('ml_analysis', __name__)


# ── forecast_series() ────────────────────────────────────────────────────────
def forecast_series(history_values, steps: int, y_min: float = None, y_max: float = None, phi: float = 0.85):
    """
    Shared per-series forecaster — pure numpy, no statsmodels dependency.

    Fits a plain degree-1 line (numpy.polyfit) directly on THIS ONE
    series' own history, then extrapolates forward with a DAMPED slope
    instead of a straight one. This replaced two earlier approaches:
      1. subj_model.predict() + `(pred + last_val) / 2` smoothing —
         RandomForestRegressor can't extrapolate past its training
         years, so predictions came back flat; the averaging then
         compounded that into a plateau (the original bug).
      2. A statsmodels Holt's-smoothing version — worked, but added an
         extra dependency the project didn't want.
      3. A plain (undamped) linear extrapolation — this is what shipped
         right after (2), and it introduced a NEW bug: a straight line
         has no way to bend, so it kept adding the exact same slope
         every year all the way out to the forecast horizon (5-9 years
         out). A modest upward trend in the real history turned into an
         implausible straight-line climb by the final forecast year —
         the "sudden inaccurate result... goes straight upward" issue.
         Swapping to RandomForestRegressor or LogisticRegression would
         NOT have fixed this: RF can't extrapolate at all (flatlines —
         bug #1 again), and LogisticRegression is a classifier, not a
         fit for a continuous rate. The fix has to be in how the trend
         is extrapolated, not which regression algorithm computes it.

    DAMPED TREND (this version): each future step's slope contribution
    shrinks geometrically by `phi` (classic Holt damped-trend idea,
    reimplemented here in plain numpy). The near-term forecast still
    reflects the real trend, but the curve bends toward a plateau
    instead of climbing (or falling) in a straight line forever.
    phi=0.85 means step 1 gets the full slope, step 2 gets slope*0.85,
    step 3 gets slope*0.85^2, and so on — lower phi = faster taper,
    phi=1.0 reproduces the old undamped straight-line behavior exactly.

    history_values : list[float] — the real, historical points only
    steps           : how many future points to generate
    y_min / y_max   : optional clip range (e.g. 1.0-5.0 for grades)
    phi             : damping factor in (0, 1]. Default 0.85.

    Returns: list[float] of length `steps`.
    """
    clean = [float(v) for v in history_values if v is not None and not pd.isna(v)]

    if len(clean) < 3:
        # Too few points to fit a trend line reliably — carry the last
        # real value forward instead of inventing a slope from 2 points.
        base = clean[-1] if clean else 0.0
        out = [base] * steps
    else:
        x = np.arange(len(clean))
        slope, intercept = np.polyfit(x, clean, deg=1)
        last_fitted = slope * (len(clean) - 1) + intercept

        # Damped multi-step trend: cumulative sum of slope * phi^i,
        # added on top of the last real (fitted) value — NOT a straight
        # line through future_x like before. See docstring above.
        out = []
        cum = 0.0
        for i in range(1, steps + 1):
            cum += slope * (phi ** i)
            out.append(last_fitted + cum)

    if y_min is not None or y_max is not None:
        lo = y_min if y_min is not None else float("-inf")
        hi = y_max if y_max is not None else float("inf")
        out = [max(lo, min(hi, v)) for v in out]

    return [round(v, 2) for v in out]

COLLEGE_MAP = {
    "CEA":  ["CEA"],
    "CTEC": ["CTEC"],
    "CCST": ["CCST"],
    "COAS": ["COAS"],
    "CAHS": ["CAHS"],
    "CBA":  ["CBA"],
}

def expand_college(college_arg: str):
    """
    Return the list of full CSV college names that match the given short code.
    If the argument is already a full name (or 'all'), return it unchanged
    so historical filters still work when a full name is passed directly.
    """
    key = college_arg.strip().upper()
    return COLLEGE_MAP.get(key, [college_arg.strip()])


def resolve_scope(value: str):
    """
    The single "Department - Course" dropdown on every dean dashboard sends
    ONE value that can be EITHER a college code ("CAHS") OR a specific
    course name ("Bachelor of Science in Nursing") through the same
    `college=` query param. Every endpoint used to assume it was always a
    college code and filter the 'College' column with expand_college() —
    so picking an actual course matched zero rows everywhere (the course
    name never appears in the College column), silently breaking every
    chart, in both Recent and Prediction mode.

    This resolves that value once, correctly:
      - 'all' / 'main campus' / '' / None -> no filter at all
      - a known college code (CAHS, CBA, ...) -> college-column filter
      - anything else -> treated as a COURSE name, filtered on the
        'Course' column instead, with its parent college looked up from
        the data (needed by prediction models, which only have
        per-college features, never per-course ones).

    Returns a dict:
      {
        "type": "all" | "college" | "course",
        "college_names": [...],   # full College-column values to filter/match on (type all/college)
        "course_name": str|None,  # exact Course-column value to filter on (type course)
        "feature_college": str,   # best college code to use for model one-hot features
      }
    """
    raw = (value or 'all').strip()
    if raw.lower() in ('all', 'main campus', 'overall', ''):
        return {"type": "all", "college_names": [], "course_name": None, "feature_college": None}

    key = raw.upper()
    if key in COLLEGE_MAP:
        return {"type": "college", "college_names": COLLEGE_MAP[key], "course_name": None, "feature_college": key}

    # Not a recognized college code -> treat as a course name.
    feature_college = None
    try:
        if 'Course' in df_full_loaded.columns and 'College' in df_full_loaded.columns:
            match = df_full_loaded[df_full_loaded['Course'].astype(str).str.strip().str.upper() == key]
            if not match.empty:
                feature_college = str(match['College'].dropna().astype(str).str.strip().iloc[0]).upper()
    except Exception:
        feature_college = None

    return {"type": "course", "college_names": [], "course_name": raw, "feature_college": feature_college}


def apply_scope_filter(df, scope, college_col='College', course_col='Course'):
    """
    Apply a resolve_scope() result to a dataframe: filters by college code
    (scope['type'] == 'college') or by the exact course row (scope['type']
    == 'course'). No-ops for scope['type'] == 'all'.
    """
    if scope["type"] == "college":
        return df[df[college_col].astype(str).str.strip().str.upper().isin(
            [n.upper() for n in scope["college_names"]]
        )]
    if scope["type"] == "course":
        if course_col not in df.columns:
            return df.iloc[0:0]
        return df[df[course_col].astype(str).str.strip().str.upper() == scope["course_name"].upper()]
    return df

#  GLOBAL DATA LOADING & CLEANING
DATA_PATH = FINAL_MERGED_CSV
MODEL_DIR = ML_MODEL_DIR

print(" Loading ML Data & Models ")

def _load_data() -> pd.DataFrame:
    """
    Read + clean the master CSV from disk. Pulled out of the old one-shot
    module-level script so it can also be called by reload_data() after an
    upload — previously this logic only ever ran once at import time, so
    df_full_loaded stayed frozen at whatever the CSV looked like when Flask
    started. reload_models() (below) only ever re-loaded the .pkl model
    files, never this dataframe, which is why every historical-mode chart
    (KPI counts, GWA averages, status/dropout pies' "Actual" branch) kept
    showing stale numbers after an upload even though forecast-mode charts
    (which call .predict() on the freshly-reloaded models) updated fine.
    """
    if not os.path.exists(DATA_PATH):
        print(" CSV not found")
        return pd.DataFrame()

    try:
        df = pd.read_csv(DATA_PATH)

        #  FIX: DO NOT REMOVE GWA = 0 (important for INC)
        df = df[df['GWA'].notna()].copy()

        # Year extraction
        df['Year_Numeric'] = (
            df['Year']
            .astype(str)
            .str.extract(r'^(\d{4})')[0]
            .astype(float)
        )

        # Semester mapping
        sem_map = {
            "1sem": 1, "1st sem": 1,
            "2sem": 2, "2nd sem": 2,
            "summer": 3
        }

        df['Sem_Numeric'] = (
            df['Semester']
            .astype(str)
            .str.lower()
            .map(sem_map)
            .fillna(1)
        )

        df = df.dropna(subset=['Year_Numeric'])

        print(f" Data Loaded: {len(df)} rows")
        print(f" Unique Students: {df['Student_ID'].nunique()}")
        return df

    except Exception as e:
        print(f" Data Load Error: {e}")
        return pd.DataFrame()


df_full_loaded = _load_data()


def reload_data():
    """
    Re-read the master CSV from disk into df_full_loaded.
    Called alongside reload_models() so historical-mode charts pick up a
    newly-uploaded dataset immediately, the same way forecast-mode charts
    already do via the freshly-reloaded .pkl models.
    """
    global df_full_loaded
    df_full_loaded = _load_data()
    print("[reload_data] df_full_loaded refreshed from", DATA_PATH)



def gender_masks(series: pd.Series):
    """
    Returns (is_male, is_female) boolean masks for a Gender column that may
    be EITHER string values ("Male"/"Female") OR the numeric codes used in
    the master CSV (0 = Male, 1 = Female, -1 = Unknown) -- see
    Gender/Gender_Label in the gender-performance export.

    Endpoints that did `series.astype(str).str.startswith('M'/'F')`
    unconditionally silently matched ZERO students whenever Gender was
    numeric, because `str(0)` / `str(1)` never start with "M"/"F". That
    produced all-zero Male/Female buckets (looked like "no data") even
    though get_dropout_pie's gender split -- which DOES branch on dtype --
    was showing real numbers from the same rows.
    """
    if series.dtype == object:
        norm = series.astype(str).str.strip().str.upper()
        is_male = norm.str.startswith('M')
        is_female = norm.str.startswith('F')
    else:
        numeric = pd.to_numeric(series, errors='coerce')
        is_male = numeric == 0
        is_female = numeric == 1
    return is_male, is_female


def get_latest_real_year() -> int:
    """
    Returns the most recent school year actually present in the merged
    dataset. Previously this was hardcoded as `LATEST_REAL_YEAR = 2024` in
    five separate endpoints, so every upload of 2025+ data would still be
    treated as "the future" and forecast instead of shown as history.
    Falls back to 2024 only if the dataset is empty/unloaded.
    """
    if not df_full_loaded.empty and 'Year_Numeric' in df_full_loaded.columns:
        valid_years = df_full_loaded['Year_Numeric'].dropna()
        if len(valid_years):
            return int(valid_years.max())
    return 2024


def get_forecast_years(latest_year: int) -> list:
    """
    Shared with get_year_semester_options(): pulls the SAME horizon used
    for every other forecast on the dashboard (auto_train.py's
    compute_horizon(), which grows automatically as new school years get
    uploaded and retrained) rather than a separate hardcoded range, so
    every chart's "how far into the future" always agrees with each other
    and with whatever the models were actually trained to predict.
    """
    try:
        from training.auto_train import load_state as _load_state
        horizon = _load_state().get('horizon', {})
        years = [int(y.split('-')[0]) for y in horizon.get('prediction_years', [])]
        years = sorted({y for y in years if y > latest_year})
        if years:
            return years
    except Exception:
        pass
    return list(range(latest_year + 1, latest_year + 7))


# Load Models
def load_model(filename):
    path = os.path.join(MODEL_DIR, filename)
    return joblib.load(path) if os.path.exists(path) else None
drop_pie_model = load_model("dropout_model.pkl")
drop_pie_features = load_model("dropout_features.pkl")

gwa_ranking_model = load_model("gwa_ranking_model_final.pkl")
gwa_ranking_features = load_model("gwa_ranking_features_final.pkl")

dropout_ranking_model = load_model("college_dropout_model_final.pkl")
dropout_ranking_features = load_model("dropout_ranking_features_final.pkl")

gwa_trend_model = load_model("gwa_trend_model_final.pkl")
gwa_trend_features = load_model("gwa_trend_features.pkl")

kpi_gwa_model = load_model("kpi_gwa_model.pkl")
kpi_gwa_features = load_model("kpi_gwa_features.pkl")

kpi_enroll_model = load_model("kpi_enrollment_model.pkl")
kpi_enroll_features = load_model("kpi_enrollment_features.pkl")

status_model = load_model("status_forest_model.pkl")
status_features = load_model("status_forest_features.pkl")

inc_model = load_model("inc_rate_model.pkl")
inc_features = load_model("inc_rate_features.pkl")

subj_model = load_model("subject_grade_model.pkl")
subj_features = load_model("subject_grade_features.pkl")

dropout_spike_model = load_model("dropout_spike_model.pkl")
dropout_spike_features = load_model("dropout_spike_features.pkl")


# ── reload_models() ──────────────────────────────────────────────────────────
def reload_models():
    """Re-load every .pkl from MODEL_DIR into the module-level globals."""
    global drop_pie_model, drop_pie_features
    global gwa_ranking_model, gwa_ranking_features
    global dropout_ranking_model, dropout_ranking_features
    global gwa_trend_model, gwa_trend_features
    global kpi_gwa_model, kpi_gwa_features
    global kpi_enroll_model, kpi_enroll_features
    global status_model, status_features
    global inc_model, inc_features
    global subj_model, subj_features
    global dropout_spike_model, dropout_spike_features

    drop_pie_model          = load_model("dropout_model.pkl")
    drop_pie_features       = load_model("dropout_features.pkl")
    gwa_ranking_model       = load_model("gwa_ranking_model_final.pkl")
    gwa_ranking_features    = load_model("gwa_ranking_features_final.pkl")
    dropout_ranking_model   = load_model("college_dropout_model_final.pkl")
    dropout_ranking_features= load_model("dropout_ranking_features_final.pkl")
    gwa_trend_model         = load_model("gwa_trend_model_final.pkl")
    gwa_trend_features      = load_model("gwa_trend_features.pkl")
    kpi_gwa_model           = load_model("kpi_gwa_model.pkl")
    kpi_gwa_features        = load_model("kpi_gwa_features.pkl")
    kpi_enroll_model        = load_model("kpi_enrollment_model.pkl")
    kpi_enroll_features     = load_model("kpi_enrollment_features.pkl")
    status_model            = load_model("status_forest_model.pkl")
    status_features         = load_model("status_forest_features.pkl")
    inc_model               = load_model("inc_rate_model.pkl")
    inc_features            = load_model("inc_rate_features.pkl")
    subj_model              = load_model("subject_grade_model.pkl")
    subj_features           = load_model("subject_grade_features.pkl")
    dropout_spike_model     = load_model("dropout_spike_model.pkl")
    dropout_spike_features  = load_model("dropout_spike_features.pkl")
    print("[reload_models] All models reloaded from", MODEL_DIR)
    reload_data()


@ml_bp.route('/api/reload-models', methods=['POST'])
def api_reload_models():
    """
    POST /api/reload-models
    Hot-reload all .pkl files after auto_train finishes.
    Called by upload_routes._background_train() on status='done'.
    """
    try:
        reload_models()
        loaded = {name: os.path.exists(os.path.join(MODEL_DIR, name))
                  for name in [
                      "dropout_model.pkl", "gwa_ranking_model_final.pkl",
                      "college_dropout_model_final.pkl", "gwa_trend_model_final.pkl",
                      "kpi_gwa_model.pkl", "kpi_enrollment_model.pkl",
                      "status_forest_model.pkl", "inc_rate_model.pkl",
                      "subject_grade_model.pkl", "dropout_spike_model.pkl",
                  ]}
        return jsonify({"status": "ok", "models_found": loaded})
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500



# ML piechart (Gender Analysis) 
@ml_bp.route('/api/get_dropout_pie')
def get_dropout_pie():
    try:

        #  INPUTS ─
        year = int(request.args.get('year', 2024))
        college_arg = request.args.get('college', 'all').strip()
        semester = request.args.get('semester', 'all').strip()

        # normalize college filter
        if college_arg.lower() in ['main campus', 'overall', 'all', '']:
            target_college = 'all'
        else:
            target_college = college_arg

        #  MODE ─
        LATEST_REAL_YEAR = get_latest_real_year()
        is_forecast = year > LATEST_REAL_YEAR
        mode_label = "Forecast" if is_forecast else "Actual History"

        #  YEAR COLUMN FIX 
        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = (
                df_full_loaded['Year']
                .astype(str)
                .str.extract(r'^(\d{4})')[0]
                .astype(float)
            )

        #  SELECT COHORT ─
        if is_forecast:
            cohort = df_full_loaded[
                df_full_loaded['Year_Numeric'] == LATEST_REAL_YEAR
            ].copy()
        else:
            cohort = df_full_loaded[
                df_full_loaded['Year_Numeric'] == year
            ].copy()

        #  FILTERS
        # `target_college` can be a college code OR a course name (dean
        # dashboards' combined dropdown) — resolve_scope tells them apart
        # and filters the College or Course column accordingly.
        scope = resolve_scope(target_college)
        cohort = apply_scope_filter(cohort, scope)

        if semester.lower() not in ['all', 'overall']:
            cohort = cohort[
                cohort['Semester'].astype(str).str.strip().str.upper()
                == semester.upper()
            ]

        if cohort.empty:
            return jsonify({
                "labels": [],
                "data": [],
                "total": 0,
                "mode": mode_label
            })

        # ── STUDENT FLAGS ─────────────────────────────────────────────────────
        agg_cols = {"Gender": "first", "College": "first",
                    "Semester": "first", "Year": "first"}
        if "is_drop" in cohort.columns:
            agg_cols["is_drop"] = "max"   # 1 if the student dropped in any row
        if "is_inc" in cohort.columns:
            agg_cols["is_inc"] = "max"

        student_cohort = cohort.groupby("Student_ID").agg(agg_cols).reset_index()

        # Ensure flags exist even if columns were absent
        if "is_drop" not in student_cohort.columns:
            student_cohort["is_drop"] = 0
        if "is_inc" not in student_cohort.columns:
            student_cohort["is_inc"] = 0

        student_cohort["Risk_Status"] = (
            (student_cohort["is_drop"] == 1) | (student_cohort["is_inc"] == 1)
        ).astype(int)

        actual_drops = int(student_cohort["is_drop"].sum())
        actual_incs  = int(student_cohort["is_inc"].sum())


        forecast_risk = 0

        if is_forecast:

            # SAFE: student-level prediction base
            student_features = student_cohort.copy()

            X_pred = pd.DataFrame(
                0,
                index=np.arange(len(student_features)),
                columns=drop_pie_features
            )

            X_pred["Year_Numeric"] = year

            # Gender
            if "Gender" in drop_pie_features:
                if student_features["Gender"].dtype == "object":
                    X_pred["Gender"] = student_features["Gender"].map(
                        {"Male": 0, "Female": 1}
                    ).fillna(0).values
                else:
                    X_pred["Gender"] = student_features["Gender"].fillna(0).values

            # College encoding
            for col in drop_pie_features:
                if col.startswith("College_"):
                    c_name = col.replace("College_", "").strip()
                    mask = student_features["College"].astype(str).str.strip() == c_name
                    X_pred.loc[mask.values, col] = 1

                if col.startswith("Semester_"):
                    s_name = col.replace("Semester_", "").strip()
                    mask = student_features["Semester"].astype(str).str.strip() == s_name
                    X_pred.loc[mask.values, col] = 1

            # PREDICT (STUDENT LEVEL ONLY)
            preds = drop_pie_model.predict(X_pred)
            preds = np.clip(np.round(preds), 0, 1)

            student_features["Risk_Status"] = preds

            forecast_risk = int(np.sum(preds))

            # overwrite for pie chart consistency
            student_cohort = student_features

        # PIE CHART COMPUTATION (STUDENT LEVEL ONLY)

        df_final = student_cohort.copy()

        if df_final["Gender"].dtype == "object":
            df_final["Gender_Num"] = df_final["Gender"].map(
                {"Male": 0, "Female": 1}
            ).fillna(0)
        else:
            df_final["Gender_Num"] = df_final["Gender"].fillna(0)

        m_stay = len(df_final[(df_final["Risk_Status"] == 0) & (df_final["Gender_Num"] == 0)])
        f_stay = len(df_final[(df_final["Risk_Status"] == 0) & (df_final["Gender_Num"] == 1)])
        m_risk = len(df_final[(df_final["Risk_Status"] == 1) & (df_final["Gender_Num"] == 0)])
        f_risk = len(df_final[(df_final["Risk_Status"] == 1) & (df_final["Gender_Num"] == 1)])

        total = len(df_final)

        risk_pct = round(((m_risk + f_risk) / total * 100), 1) if total > 0 else 0

        #  RESPONSE 

        return jsonify({
            "labels": ["Male (Safe)", "Female (Safe)", "Male (Risk)", "Female (Risk)"],
            "data": [m_stay, f_stay, m_risk, f_risk],
            "colors": ["#4e73df", "#36b9cc", "#e74a3b", "#f6c23e"],
            "total": total,
            "risk_pct": risk_pct,
            "mode": mode_label,
            "breakdown": {
                "actual_drops": actual_drops,
                "actual_incs": actual_incs,
                "forecast_risk": forecast_risk
            }
        })

    except Exception as e:
        print(f"Dropout Pie Error: {e}")
        return jsonify({"error": str(e)}), 500
    




# GWA RANKING (Bar Chart) 
@ml_bp.route('/api/get_gwa_ranking_data/<int:selected_year>')
def get_gwa_ranking_data(selected_year):
    try:
        
        # Inputs
        sel_sem = request.args.get('semester', 'all')
        # Note: GWA Ranking usually compares ALL colleges, so 'sel_college' is unused for filtering,
        # but we parse it just in case specific highlighting is needed later.
        
        # Mode Logic
        LATEST_REAL_YEAR = get_latest_real_year()
        is_forecast = selected_year > LATEST_REAL_YEAR

        results = []

        # Get List of Colleges
        if 'College' not in df_full_loaded.columns:
             return jsonify({"error": "Data missing College column"}), 500
        
        all_colleges = df_full_loaded['College'].dropna().unique().tolist()
        all_colleges = [str(c).strip().upper() for c in all_colleges if str(c).strip() != '']
        all_colleges = list(set(all_colleges))

        # --- A. FORECAST MODE (AI) ---
        if is_forecast and gwa_ranking_model:
            # Map Semester to Numeric (Average = 1.5)
            sem_val = 1.5
            if '1' in sel_sem: sem_val = 1
            elif '2' in sel_sem: sem_val = 2
            elif 'summer' in sel_sem.lower(): sem_val = 3

            for college in all_colleges:
                # Init Input Vector
                input_data = pd.DataFrame(0, index=[0], columns=gwa_ranking_features)
                input_data['Year_Numeric'] = selected_year
                input_data['Sem_Numeric'] = sem_val
                
                # Set College Feature
                col_feat = f"College_{college}"
                if col_feat in gwa_ranking_features:
                    input_data[col_feat] = 1
                
                try:
                    pred_gwa = gwa_ranking_model.predict(input_data)[0]
                    # Clamp to valid 1.0 - 5.0 range
                    final_gwa = round(max(1.0, min(5.0, pred_gwa)), 2)
                    results.append({"college": college, "gwa": final_gwa})
                except:
                    results.append({"college": college, "gwa": 0})

        # --- B. HISTORICAL MODE (Actuals) ---
        else:
            cohort = df_full_loaded[df_full_loaded['Year_Numeric'] == selected_year].copy()
            
            # Filter Semester
            if sel_sem.lower() not in ['all', 'overall']:
                cohort = cohort[cohort['Semester'].astype(str).str.contains(sel_sem, case=False, na=False)]

            for college in all_colleges:
                c_data = cohort[cohort['College'].str.upper() == college]
                
                if not c_data.empty:
                    # Filter valid grades only (1.0 - 5.0)
                    c_data['GWA'] = pd.to_numeric(c_data['GWA'], errors='coerce')
                    valid_gwa = c_data[(c_data['GWA'] >= 1.0) & (c_data['GWA'] <= 5.0)]
                    
                    if not valid_gwa.empty:
                        avg_gwa = round(valid_gwa['GWA'].mean(), 2)
                    else:
                        avg_gwa = 0
                else:
                    avg_gwa = 0
                
                results.append({"college": college, "gwa": avg_gwa})

        # 4. SORTING
        # For GWA, 1.0 is Best. Sort Ascending so Best is First.
        results = sorted(results, key=lambda x: x['gwa'] if x['gwa'] > 0 else 99, reverse=False)

        return jsonify(results)

    except Exception as e:
        print(f"GWA Ranking Error: {e}")
        return jsonify({"error": str(e)}), 500
    


# DROPOUT RANKING (Bar Chart) 
@ml_bp.route('/api/get_year_semester_options')
def get_year_semester_options():
    """
    Tells the frontend which years/semesters actually have data, so the
    Year dropdown is never stuck on a hardcoded '2024' and instead grows
    automatically as new datasets get uploaded and trained.

    Behavior the frontend uses this for:
      - Default YEAR = the most recent year that has any real data.
      - Default SEMESTER for that year:
          * Only 1st Sem uploaded so far  -> default to "1st Sem"
          * Only 2nd Sem uploaded so far  -> default to "2nd Sem"
          * BOTH semesters uploaded       -> default to "All Semesters"
        This way, right after a single semester is uploaded the dashboard
        shows exactly that fresh partial data, and once the second
        semester for the same year comes in it automatically switches to
        showing the full year.
    """
    try:
        df = df_full_loaded.copy()
        if 'Year_Numeric' not in df.columns:
            df['Year_Numeric'] = (
                df['Year'].astype(str).str.extract(r'^(\d{4})')[0].astype(float)
            )

        years = sorted({int(y) for y in df['Year_Numeric'].dropna().unique()})

        if not years:
            return jsonify({
                "years": [], "latest_year": None,
                "latest_year_semesters": [], "default_semester": "all",
                "forecast_years": []
            })

        latest_year = max(years)

        sem_raw = (
            df.loc[df['Year_Numeric'] == latest_year, 'Semester']
            .astype(str).str.strip().str.upper().unique().tolist()
            if 'Semester' in df.columns else []
        )
        has_1st = any('1' in s for s in sem_raw)
        has_2nd = any('2' in s for s in sem_raw)

        if has_1st and has_2nd:
            default_semester = 'all'
        elif has_1st:
            default_semester = '1sem'
        elif has_2nd:
            default_semester = '2sem'
        else:
            default_semester = 'all'

        # Forecast years come from the same horizon used everywhere else,
        # so the dropdown's "future" options always match what the models
        # can actually predict.
        forecast_years = get_forecast_years(latest_year)

        return jsonify({
            "years": years,
            "latest_year": latest_year,
            "latest_year_semesters": sem_raw,
            "default_semester": default_semester,
            "forecast_years": forecast_years
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@ml_bp.route('/api/get_dropout_ranking')
def get_dropout_ranking():
    try:

        # 1. INPUTS
        year = int(request.args.get('year', 2024))
        semester_arg = request.args.get('semester', 'all').strip()

        # 2. MODE
        LATEST_REAL_YEAR = get_latest_real_year()
        is_forecast = year > LATEST_REAL_YEAR

        # 3. GET COLLEGES
        if 'College' not in df_full_loaded.columns:
             return jsonify({"error": "College column missing"}), 500
             
        all_colleges = df_full_loaded['College'].dropna().unique().tolist()
        # Clean list
        all_colleges = [str(c).strip().upper() for c in all_colleges if str(c).strip() != '']
        all_colleges = list(set(all_colleges)) 

        results = []

        # --- A. FORECAST MODE (AI Prediction 2026-2030) ---
        if is_forecast and 'dropout_ranking_model' in globals() and dropout_ranking_model:
            for college in all_colleges:
                # Init Input Vector
                input_data = pd.DataFrame(0, index=[0], columns=dropout_ranking_features)
                input_data['Year_Numeric'] = year
                
                # Map College
                col_feat = f"College_{college}"
                if col_feat in dropout_ranking_features: input_data[col_feat] = 1
                
                # Map Semester
                target_sem = "1ST SEMESTER" if semester_arg == 'all' else semester_arg.upper()
                for feat in dropout_ranking_features:
                    if "Semester_" in feat and target_sem in feat.upper():
                        input_data[feat] = 1
                        break

                try:
                    pred_prob = dropout_ranking_model.predict(input_data)[0]
                    pred_pct = round(max(0, pred_prob * 100), 2) 
                    results.append({"college": college, "rate": pred_pct})
                except:
                    results.append({"college": college, "rate": 0})

        # --- B. HISTORICAL MODE (Actual Data) ---
        else:
            # Filter Year
            # (Year_Numeric created in global load)
            cohort = df_full_loaded[df_full_loaded['Year_Numeric'] == year].copy()

            # Clean Status Column
            if 'Status' in cohort.columns:
                cohort['Status'] = cohort['Status'].astype(str).str.strip().str.upper()
            else:
                cohort['Status'] = "UNKNOWN"

            # Filter Semester
            if semester_arg.lower() not in ['all', 'overall']:
                cohort = cohort[cohort['Semester'].astype(str).str.upper().str.contains(semester_arg.upper(), na=False)]

            # Calculate Rates
            for college in all_colleges:
                c_data = cohort[cohort['College'].astype(str).str.strip().str.upper() == college]
                
                # Count Total Unique Students
                total_students = c_data['Student_ID'].nunique()
                
                if total_students > 0:
                    # Use pre-computed is_drop flag (master CSV has no raw Status column)
                    if 'is_drop' in c_data.columns:
                        drop_count = int(c_data.groupby('Student_ID')['is_drop'].max().sum())
                    elif 'Status' in c_data.columns:
                        c_data = c_data.copy()
                        c_data['Status'] = c_data['Status'].astype(str).str.strip().str.upper()
                        drop_rows = c_data[c_data['Status'].str.contains("DROP", na=False)]
                        drop_count = drop_rows['Student_ID'].nunique()
                    else:
                        drop_count = 0
                    
                    rate = round((drop_count / total_students) * 100, 2)
                else:
                    rate = 0
                
                results.append({"college": college, "rate": rate})

        # 4. SORT RESULTS
        results = sorted(results, key=lambda x: x['rate'], reverse=True)

        return jsonify({
            "data": results,
            "mode": "Forecast" if is_forecast else "Actual History",
            "year": year
        })

    except Exception as e:
        print(f"Dropout Ranking Error: {e}")
        return jsonify({"error": str(e)}), 500





# GWA TREND (Scatter Plot) 
@ml_bp.route('/api/get_gwa_scatter')
def get_gwa_scatter():
    """
    GWA Distribution scatter — ONE COLUMN PER SCHOOL YEAR.

    Every real year in the uploaded data gets its own column of actual
    student dots (x = year, jittered slightly left/right so dots don't
    overlap). Every forecast year gets a column too, but with NO dots —
    there's no real cohort yet — just a predicted-average point from
    gwa_trend_model. The average/prediction line connects ALL of these
    points across every column, real and forecast, so it visibly keeps
    climbing (or dropping) into the future.

    Which years count as "real" and how far the forecast columns extend
    both come from get_latest_real_year() / get_forecast_years() — the
    same horizon every other chart uses — so BOTH grow automatically the
    moment a new school year is uploaded and retrained. No year filter
    needed anymore: this endpoint no longer takes a `year` param at all.
    """
    try:
        # 1. INPUTS — college/semester still filter which students show up
        # in the dot columns; year selection is gone, this always shows
        # every real year plus the forecast horizon.
        college_arg = request.args.get('college', 'all').strip()
        semester = request.args.get('semester', 'all').strip()

        target_college = 'all' if college_arg.lower() in ['main campus', 'overall', 'all', ''] else college_arg

        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = (
                df_full_loaded['Year'].astype(str)
                .str.extract(r'^(\d{4})')[0]
                .fillna(0).astype(int)
            )

        LATEST_REAL_YEAR = get_latest_real_year()
        real_years = sorted({
            int(y) for y in df_full_loaded['Year_Numeric'].dropna().unique() if int(y) > 0
        })
        # Cap forecast columns at 4 so the chart doesn't get crowded —
        # still grows on its own as LATEST_REAL_YEAR advances each upload.
        forecast_years = get_forecast_years(LATEST_REAL_YEAR)[:4]

        # 2. FILTERING (college/semester only — every real year included)
        # `target_college` can be a college code OR a course name (dean
        # dashboards' combined dropdown) — resolve which one it is.
        scope = resolve_scope(target_college)
        cohort = df_full_loaded.copy()
        cohort = apply_scope_filter(cohort, scope)
        if semester.lower() not in ['all', 'overall']:
            cohort = cohort[
                cohort['Semester'].astype(str).str.strip().str.upper() == semester.upper()
            ]

        # 3. VALIDATION (filter valid GWA 1.0-5.0)
        cohort['GWA'] = pd.to_numeric(cohort['GWA'], errors='coerce')
        valid_data = cohort[(cohort['GWA'] >= 1.0) & (cohort['GWA'] <= 5.0)].copy()

        # 4. SAMPLE (cap TOTAL dots across all years combined, spread
        # roughly evenly per year so early/small years don't get
        # drowned out by a much bigger recent year)
        n_years = max(len(real_years), 1)
        per_year_cap = max(60, 1200 // n_years)
        if not valid_data.empty:
            # NOTE: deliberately NOT using groupby(...).apply(lambda g: g.sample(...)).
            # As of pandas 2.2+ (hard default in pandas 3.0), DataFrameGroupBy.apply()
            # excludes the grouping column ('Year_Numeric') from the sub-frame `g`
            # passed into the lambda, and there's no way to opt back in (the old
            # include_groups=True escape hatch was removed in pandas 3.0). That
            # silently dropped Year_Numeric from the result here, which then blew
            # up every downstream `row['Year_Numeric']` lookup with a 500 error.
            # A plain loop over groupby() sidesteps this entirely.
            sampled_parts = [
                g.sample(n=min(len(g), per_year_cap), random_state=42)
                for _, g in valid_data.groupby('Year_Numeric')
            ]
            valid_data = (
                pd.concat(sampled_parts, ignore_index=False)
                if sampled_parts else valid_data.iloc[0:0]
            )

        valid_data['jitter'] = np.random.uniform(-0.32, 0.32, size=len(valid_data))

        # 5. BUILD DOTS — x = year + small jitter, so each year forms its
        # own visual column on the x-axis
        scatter_points = []
        for _, row in valid_data.iterrows():
            yr = int(row['Year_Numeric'])
            if yr not in real_years:
                continue
            scatter_points.append({
                "x": round(yr + row['jitter'], 2),
                "y": round(row['GWA'], 2),
                "year": yr,
                "student_id": str(row['Student_ID'])[:4] + "-***",
                # Included so the frontend can color-code each dot:
                # Main dashboard groups by College, CAHS/dean dashboards
                # group by Course.
                "college": str(row.get('College', '')).strip(),
                "course": str(row.get('Course', '')).strip()
            })

        # 6. BUILD THE AVERAGE/PREDICTION LINE — one point per year,
        # real years use the ACTUAL batch average, forecast years use
        # gwa_trend_model's prediction. Connecting all of them shows the
        # trend keep moving into the forecast columns automatically.
        line_points = []
        for yr in real_years:
            yr_data = valid_data[valid_data['Year_Numeric'] == yr]
            if not yr_data.empty:
                line_points.append({
                    "x": yr, "y": round(float(yr_data['GWA'].mean()), 2),
                    "year": yr, "is_forecast": False
                })

        if gwa_trend_model:
            for yr in forecast_years:
                X_pred = pd.DataFrame(0, index=[0], columns=gwa_trend_features)
                X_pred['Year_Numeric'] = yr

                if '1' in semester: sem_val = 1
                elif '2' in semester: sem_val = 2
                else: sem_val = 1.5
                X_pred['Sem_Numeric'] = sem_val

                # Model only has per-college features — for a course
                # selection, use that course's own parent college so the
                # forecast line still reflects the right department
                # (there's no per-course GWA trend model).
                feature_match = scope["feature_college"] if scope["type"] == "course" else (
                    target_college if scope["type"] == "college" else None
                )
                if feature_match:
                    for col in gwa_trend_features:
                        if feature_match.upper() in col.upper():
                            X_pred[col] = 1
                            break

                pred_val = round(float(gwa_trend_model.predict(X_pred)[0]), 2)
                line_points.append({
                    "x": yr, "y": pred_val, "year": yr, "is_forecast": True
                })

        return jsonify({
            "data": scatter_points,
            "line": line_points,
            "real_years": real_years,
            "forecast_years": forecast_years,
            "latest_real_year": LATEST_REAL_YEAR,
            "count": len(scatter_points)
        })

    except Exception as e:
        print(f"GWA Scatter Error: {e}")
        return jsonify({"error": str(e)}), 500
    



# KPI METRICS (Actual vs Predicted)
@ml_bp.route('/api/get_kpi_metrics')
def get_kpi_metrics():
    try:
        # Parse Inputs
        year = int(request.args.get('year', 2024))
        semester = request.args.get('semester', 'all')
        college = request.args.get('college', 'all')
        
        # Define "Future" Boundary
        # Was hardcoded as CURRENT_YEAR = 2024, separate from every other
        # endpoint's LATEST_REAL_YEAR — meant this one wouldn't update
        # even after the others started recognizing new years.
        CURRENT_YEAR = get_latest_real_year()
        is_prediction = year > CURRENT_YEAR

        # `college` can be a college code OR a specific course name from the
        # dean dashboards' "Department - Course" dropdown — resolve which
        # one it actually is instead of assuming it's always a college.
        scope = resolve_scope(college)

        # SCENARIO A: ACTUAL DATA (Historical)
        if not is_prediction:
            # Filter Global Data
            df_scope = df_full_loaded.copy()

            # Filter by College OR Course (see resolve_scope)
            df_scope = apply_scope_filter(df_scope, scope)

            # Filter by Year
            df_scope = df_scope[df_scope['Year_Numeric'] == year]
            
            # Filter by Semester (Optional for Student Count, Important for GWA)
            # Note: Usually enrollment is counted per year, but GWA varies by sem.
            if semester != 'all':
                sem_val = 1 if '1' in semester else 2
                df_scope = df_scope[df_scope['Sem_Numeric'] == sem_val]

            if df_scope.empty:
                return jsonify({"students": 0, "gwa": 0, "is_prediction": False})
            
            total_students = int(df_scope['Student_ID'].nunique())
            avg_gwa = round(df_scope['GWA'].mean(), 2)

        # SCENARIO B: PREDICTIVE DATA (Future AI)
        else:
            # We need to predict for specific colleges.
            # If 'all' is selected, we predict for EVERY college and sum/average the results.
            
            # 1. Identify which colleges to predict for
            colleges_to_process = []
            if scope["type"] == "college":
                colleges_to_process = [scope["feature_college"]]
            elif scope["type"] == "course":
                # There is no per-course enrollment/GWA model — only
                # per-college ones. Use the course's parent college for
                # the model's College_ feature, and scale the college-wide
                # enrollment prediction down by that course's historical
                # share of its college's headcount, so a course selection
                # doesn't just silently show its WHOLE college's numbers.
                colleges_to_process = [scope["feature_college"] or college]
            else:
                # Extract college names from the One-Hot features (e.g., 'College_CCST')
                colleges_to_process = [feat.replace('College_', '') for feat in kpi_enroll_features if feat.startswith('College_')]

            course_share = 1.0
            if scope["type"] == "course" and scope["feature_college"]:
                try:
                    base_year = get_latest_real_year()
                    college_rows = df_full_loaded[
                        (df_full_loaded['Year_Numeric'] == base_year)
                        & (df_full_loaded['College'].astype(str).str.strip().str.upper() == scope["feature_college"])
                    ]
                    course_rows = college_rows[
                        college_rows['Course'].astype(str).str.strip().str.upper() == scope["course_name"].upper()
                    ]
                    college_count = college_rows['Student_ID'].nunique()
                    course_count = course_rows['Student_ID'].nunique()
                    if college_count > 0:
                        course_share = course_count / college_count
                except Exception:
                    course_share = 1.0

            total_students_accum = 0
            gwa_accum = []

            for col_name in colleges_to_process:
                # A. Predict Enrollment
                # Build Feature Vector
                X_enroll = pd.DataFrame(np.zeros((1, len(kpi_enroll_features))), columns=kpi_enroll_features)
                X_enroll['Year_Numeric'] = year
                
                # Set College Bit
                col_feat = f"College_{col_name}"
                if col_feat in kpi_enroll_features:
                    X_enroll[col_feat] = 1
                
                pred_count = int(kpi_enroll_model.predict(X_enroll)[0])
                if scope["type"] == "course":
                    pred_count = int(round(pred_count * course_share))
                total_students_accum += max(0, pred_count) # Add to total

                # B. Predict GWA
                # If semester is 'all', we predict Sem 1 & Sem 2 and average them
                sem_loop = [1, 2] if semester == 'all' else [1] if '1' in semester else [2]
                
                for s in sem_loop:
                    X_gwa = pd.DataFrame(np.zeros((1, len(kpi_gwa_features))), columns=kpi_gwa_features)
                    X_gwa['Year_Numeric'] = year
                    X_gwa['Sem_Numeric'] = s
                    
                    if col_feat in kpi_gwa_features:
                        X_gwa[col_feat] = 1
                    
                    pred_grade = float(kpi_gwa_model.predict(X_gwa)[0])
                    gwa_accum.append(pred_grade)

            # Final Calculation
            total_students = total_students_accum
            avg_gwa = round(sum(gwa_accum) / len(gwa_accum), 2) if gwa_accum else 0

        return jsonify({
            "students": total_students,
            "gwa": avg_gwa,
            "is_prediction": is_prediction,
            "year": year
        })

    except Exception as e:
        print(f"KPI Error: {e}")
        return jsonify({"students": 0, "gwa": 0, "error": str(e)}), 500




# piechart
@ml_bp.route('/api/get_status_distribution')
def get_status_distribution():
    try:
        # Inputs
        year = int(request.args.get('year', 2024))
        semester = request.args.get('semester', 'all')
        college = request.args.get('college', 'all')

        print(f"\n--- DEBUG: STATUS DISTRIBUTION ({college}) ---")

        # Data Safety & Virtual Cohort
        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = df_full_loaded['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
        
        # Use the latest available year as the base population
        LATEST_REAL_YEAR = get_latest_real_year()
        base_df = df_full_loaded[df_full_loaded['Year_Numeric'] == LATEST_REAL_YEAR].copy()
        
        # Filter by College OR Course — `college` can be either, coming
        # from the dean dashboards' combined dropdown (see resolve_scope).
        scope = resolve_scope(college)
        base_df = apply_scope_filter(base_df, scope)

        print(f" > Students Found: {len(base_df)}")
        
        if base_df.empty:
            print(" > WARNING: No students found. Check CSV Spelling vs College Variable.")
            return jsonify({"labels": ["No Data"], "data": [0, 0, 0], "colors": ["#ccc"], "year": year, "total": 0})

        # Build Prediction Features
        X_pred = pd.DataFrame(0, index=np.arange(len(base_df)), columns=status_features)
        X_pred['Year_Numeric'] = year
        X_pred['Sem_Numeric'] = 1 if '1' in semester else 2

        # ROBUST MAPPING (The Fix)
        # We iterate through the specific college features the model knows
        matched_count = 0
        for feat in status_features:
            if feat.startswith('College_'):
                # Extract model's expected name (e.g., "CAHS" from "College_CAHS")
                model_col_name = feat.replace('College_', '').strip().upper()
                
                # Check against CSV data (Case Insensitive)
                # We find rows where CSV College matches the Model Feature
                mask = base_df['College'].str.strip().str.upper() == model_col_name
                
                if mask.any():
                    X_pred.loc[mask.values, feat] = 1
                    matched_count += 1
        
        print(f" > Colleges Matched in Model: {matched_count}")
        if matched_count == 0 and college != 'all':
            print(f" > CRITICAL ERROR: Model does not have a feature for '{college}'.") 
            print(f" > Available Model Features: {[f for f in status_features if 'College_' in f]}")

        # Predict
        predicted_gwas = status_model.predict(X_pred)

        high = int(np.sum(predicted_gwas >= 950))
        average = int(np.sum((predicted_gwas >= 900) & (predicted_gwas < 950)))
        risk = int(np.sum(predicted_gwas < 900))
        
        print(f" > Prediction: High={high}, Avg={average}, Risk={risk}")

        return jsonify({
            "labels": ["High (≥950)", "Average (900-949)", "At-Risk (<900)"],
            "data": [high, average, risk],
            "colors": ["#1cc88a", "#f6c23e", "#e74a3b"], 
            "year": year,
            "total": high + average + risk
        })

    except Exception as e:
        print(f" Status Error: {e}")
        return jsonify({"error": str(e)}), 500
    



# inc forecast
def _inc_rate_series(df_scope, feature_col_name, global_forecast_years):
    """Shared helper: computes (years, history%, forecast_years, forecast%)
    for a single slice of the dataframe (one college OR one course).
    feature_col_name is the exact one-hot column to flip on for the model
    (e.g. 'College_CAHS' or 'Course_BSN'). Pass None to leave it at baseline.
    """
    years = sorted(df_scope['Year_Numeric'].unique())
    history_data = []

    for yr in years:
        yr_df = df_scope[df_scope['Year_Numeric'] == yr]
        total = yr_df['Student_ID'].nunique()
        if total > 0:
            if 'is_inc' in yr_df.columns:
                inc_students = yr_df.groupby('Student_ID')['is_inc'].max().sum()
            elif 'Status' in yr_df.columns:
                inc_students = yr_df[yr_df['Status'].astype(str).str.contains('INC', case=False, na=False)]['Student_ID'].nunique()
            else:
                inc_students = 0
            history_data.append(round((inc_students / total) * 100, 2))
        else:
            history_data.append(0)

    forecast_years = global_forecast_years or (
        list(range(int(max(years)) + 1, int(max(years)) + 6)) if years else [2025, 2026, 2027, 2028, 2029]
    )

    # Was: inc_model.predict() with a Course_/College_ dummy column that
    # frequently didn't exist in inc_features (inc_model was only ever
    # trained on College-level cohort data — see train_inc_forecast in
    # auto_train.py), so every course silently fell back to the same
    # baseline prediction and lines collapsed into each other.
    # Now: forecast THIS group's own INC-rate history directly, so each
    # college/course line reflects its own trend.
    forecast_data = forecast_series(history_data, len(forecast_years), y_min=0, y_max=100)

    return [int(y) for y in years], history_data, forecast_years, forecast_data


@ml_bp.route('/api/get_inc_forecast')
def get_inc_forecast():
    try:
        import pandas as pd

        # 1. INPUTS
        college = request.args.get('college', 'all').strip()
        # 'by' = '' (single line, original behavior), 'college', or 'course'
        breakdown = request.args.get('by', '').strip().lower()

        # Shared forecast horizon (years driven by training_state.json)
        try:
            from training.auto_train import load_state as _load_state
            _hs = _load_state().get('horizon', {})
            global_forecast_years = [int(y.split('-')[0]) for y in _hs.get('prediction_years', [])]
        except Exception:
            global_forecast_years = []

        df_base = df_full_loaded.copy()

        # ── MULTI-LINE MODE ────────────────────────────────────────────
        # Used by the Main dashboard (one line per college) and by the
        # CAHS/dean dashboards (one line per course), so every line can
        # be colored consistently with the rest of the dashboard.
        if breakdown in ('college', 'course'):
            if breakdown == 'college':
                groups = sorted(df_base['College'].dropna().astype(str).str.strip().unique())
            else:
                # Course breakdown is scoped to the selected college by
                # default (e.g. CAHS dean dashboard shows all of CAHS's
                # courses). But if the dropdown itself has a SPECIFIC
                # course selected, narrow down to just that one course's
                # line instead of showing every sibling course.
                inc_scope = resolve_scope(college)
                if inc_scope["type"] == "college":
                    scope_df = df_base[df_base['College'].astype(str).str.strip().str.upper().isin(
                        [n.upper() for n in inc_scope["college_names"]]
                    )]
                elif inc_scope["type"] == "course" and inc_scope["feature_college"]:
                    scope_df = df_base[df_base['College'].astype(str).str.strip().str.upper() == inc_scope["feature_college"]]
                else:
                    scope_df = df_base
                df_base = scope_df
                groups = sorted(df_base['Course'].dropna().astype(str).str.strip().unique()) if 'Course' in df_base.columns else []
                if inc_scope["type"] == "course":
                    groups = [g for g in groups if g.strip().upper() == inc_scope["course_name"].upper()]

            per_group = []
            all_years_set = set()

            for g in groups:
                if breakdown == 'college':
                    g_df = df_full_loaded[df_full_loaded['College'].astype(str).str.strip().str.upper() == g.upper()]
                    feat_col = f"College_{g.upper()}"
                else:
                    g_df = df_base[df_base['Course'].astype(str).str.strip() == g]
                    feat_col = f"Course_{g}"

                if g_df.empty:
                    continue

                yrs, hist, fyrs, fc = _inc_rate_series(g_df, feat_col, global_forecast_years)
                all_years_set.update(yrs)
                all_years_set.update(fyrs)
                per_group.append({"label": g, "years": yrs, "history": hist, "forecast_years": fyrs, "forecast": fc})

            all_years = sorted(all_years_set)

            series = []
            for pg in per_group:
                hist_map = dict(zip(pg["years"], pg["history"]))
                fc_map = dict(zip(pg["forecast_years"], pg["forecast"]))
                history_line = [hist_map.get(y) for y in all_years]
                forecast_line = [fc_map.get(y) for y in all_years]
                # Bridge the last real point into the forecast line so the
                # dashed line visually connects to the solid line.
                last_idx = max([i for i, v in enumerate(history_line) if v is not None], default=None)
                if last_idx is not None and last_idx + 1 < len(forecast_line):
                    forecast_line[last_idx] = history_line[last_idx]
                series.append({"label": pg["label"], "history": history_line, "forecast": forecast_line})

            return jsonify({"years": all_years, "series": series, "breakdown": breakdown})

        # ── ORIGINAL SINGLE-LINE MODE (unchanged, backward compatible) ──
        single_scope = resolve_scope(college)
        df_scope = apply_scope_filter(df_base, single_scope)

        feat_col = f"College_{college.upper()}" if single_scope["type"] != "all" else None
        years, history_data, forecast_years, forecast_data = _inc_rate_series(df_scope, feat_col, global_forecast_years)

        return jsonify({
            "years": years + forecast_years,
            "history": history_data,
            "forecast": forecast_data
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500





#subject top
@ml_bp.route('/api/get_subject_forecast')
def get_subject_forecast():
    try:
        college = request.args.get('college', 'all').strip()

        # Use the dedicated per-subject dataset built by preprocess.py
        # (model_datasets/10_subject_grade_forecast.csv) instead of
        # re-deriving 'Subject' from the master CSV on every request.
        # That file already has exactly the columns this endpoint needs:
        # Year_Numeric, College, Course, Subject, Avg_Grade, Std_Grade,
        # Student_Cnt, Fail_Count, Fail_Rate — pre-aggregated per
        # year x college x subject. This also fixes "Subject column
        # missing", which happened whenever df_full_loaded came back
        # empty (e.g. wrong/missing master CSV) since that endpoint had
        # no other source for subject-level data.
        subject_csv_path = os.path.join(MODEL_DATASETS_DIR, "10_subject_grade_forecast.csv")

        if not os.path.exists(subject_csv_path):
            return jsonify({"error": "Subject dataset not found. Upload a dataset to generate it."}), 200

        df_scope = pd.read_csv(subject_csv_path)

        if 'Subject' not in df_scope.columns:
            return jsonify({"error": "Subject column missing"})

        # Filter by College OR Course — `college` may be a specific course
        # from the dean dashboards' combined dropdown.
        subj_scope = resolve_scope(college)
        df_scope = apply_scope_filter(df_scope, subj_scope)

        if df_scope.empty:
            return jsonify({"labels": [], "datasets": [], "error": "No valid grade data found"})

        # 2. IDENTIFY TOP 5 HARDEST SUBJECTS
        # Avg_Grade is already the per-subject average — weight by
        # Student_Cnt so subjects with more students count more.
        difficulty = (
            df_scope.groupby('Subject')
            .apply(lambda g: np.average(g['Avg_Grade'], weights=g['Student_Cnt'])
                   if g['Student_Cnt'].sum() > 0 else g['Avg_Grade'].mean())
            .sort_values(ascending=False)
        )
        top_subjects = difficulty.head(5).index.tolist()

        # 3. BUILD TIMELINE — driven by training_state.json horizon
        try:
            from training.auto_train import load_state as _load_state2
            _hs2 = _load_state2().get('horizon', {})
            _latest2 = _hs2.get('latest_year_start', 2024)
            _pred_labels = _hs2.get('prediction_years', [])
            years_pred = [int(y.split('-')[0]) for y in _pred_labels]
        except Exception:
            _latest2 = 2024
            years_pred = [2025, 2026, 2027, 2028, 2029, 2030]
        years_hist = sorted([
            int(y) for y in df_scope['Year_Numeric'].dropna().unique()
            if int(y) <= _latest2
        ])
        if not years_hist:
            years_hist = [2022, 2023, 2024]
        all_years = years_hist + years_pred

        datasets = []

        for subj in top_subjects:
            data_points = []
            subj_rows = df_scope[df_scope['Subject'] == subj]
            overall_avg = difficulty[subj]

            # --- A. HISTORY (2022-2024) ---
            for y in years_hist:
                mask = subj_rows['Year_Numeric'] == y
                vals = subj_rows.loc[mask, 'Avg_Grade']
                val = vals.mean() if not vals.empty else np.nan

                if pd.notna(val):
                    data_points.append(round(float(val), 2))
                else:
                    # GAP FILLER: Use overall average so the line doesn't break
                    data_points.append(round(float(overall_avg), 2))

            # --- B. FORECAST (2025-2028) ---
            # Was: subj_model.predict() + `(pred + last_val) / 2` smoothing.
            # RandomForestRegressor can't extrapolate past the years it was
            # trained on, so pred came back nearly constant every future
            # year; averaging that with last_val every step then converged
            # every subject toward one flat plateau by ~2027 — the bug
            # visible on the CEA/CTEC/COAS/CAHS "Top 5 Hardest Subjects"
            # charts. Now forecast THIS subject's own grade history directly.
            if years_pred:
                forecast_vals = forecast_series(data_points, len(years_pred), y_min=1.0, y_max=5.0)
                data_points.extend(forecast_vals)

            datasets.append({
                "label": subj,
                "data": data_points
            })

        return jsonify({
            "labels": all_years,
            "datasets": datasets,
            "college": college
        })

    except Exception as e:
        print(f"Subject Forecast Error: {e}")
        return jsonify({"error": str(e)}), 500




#subject top - per course breakdown
@ml_bp.route('/api/get_hardest_subjects_by_course')
def get_hardest_subjects_by_course():
    """Same idea as get_subject_forecast, but instead of one Top-5 list
    for the whole college, it returns a SEPARATE Top-5 hardest-subject
    ranking for each GROUP — where "group" depends on the 'college'
    filter, same convention as get_gender_status_breakdown:

      - college='all' / 'Main Campus' -> one Top-5 ranking PER COLLEGE
        (department) — e.g. CAHS gets one ranking pooling every course
        inside CAHS together, instead of one ranking per individual
        course. This is what the Main Dashboard shows.
      - college='CAHS' (etc.)         -> one Top-5 ranking PER COURSE
        inside that college (e.g. CAHS -> BSN, BSPT, BSMT... each gets
        its own ranking). This is what the dean dashboards show.

    Each of those 5 subjects is returned as its OWN year-by-year series
    (Avg_Grade per Year_Numeric) so the frontend can draw 5 lines on one
    chart per group — one line per subject, tracking that subject's
    average grade over time.

    Like every other forecast chart on the dashboard, the timeline isn't
    fixed to "history only": it follows the SAME shared horizon as
    /api/training-state (training_state.json's 'horizon' block) — so as
    more years get trained, this chart's prediction years automatically
    grow too, exactly like the global year filter (yearUpdate.js) does.
    The forecast values themselves reuse subj_model (Subject + College
    level — there's no Course-level model). In per-course mode, each
    course's line still starts its forecast from THAT course's own last
    real data point (but uses its parent college for the College_
    feature) so the projected trend stays anchored to what that course
    actually looks like instead of collapsing every course onto one
    shared line. In per-college mode, the college IS the group, so the
    College_ feature is just that college's own code directly.
    """
    try:
        college = request.args.get('college', 'all').strip()

        subject_csv_path = os.path.join(MODEL_DATASETS_DIR, "10_subject_grade_forecast.csv")
        if not os.path.exists(subject_csv_path):
            return jsonify({"error": "Subject dataset not found. Upload a dataset to generate it."}), 200

        df_scope = pd.read_csv(subject_csv_path)

        required_cols = {'Subject', 'Course', 'Year_Numeric'}
        if not required_cols.issubset(df_scope.columns):
            return jsonify({"error": "Subject/Course/Year column missing"})

        is_main = college.lower() in ['all', 'main campus', 'overall', '']

        if not is_main:
            # `college` may itself be a specific COURSE (dean dashboards'
            # combined dropdown) rather than a college code — this chart
            # always breaks a COLLEGE down into its courses, so a course
            # selection scopes to THAT course's own parent college (still
            # showing every sibling course) instead of matching nothing.
            hsc_scope = resolve_scope(college)
            if hsc_scope["type"] == "course" and hsc_scope["feature_college"]:
                df_scope = df_scope[df_scope['College'].astype(str).str.strip().str.upper() == hsc_scope["feature_college"]]
            else:
                full_names = expand_college(college)
                df_scope = df_scope[df_scope['College'].astype(str).str.strip().isin(full_names)]

        if df_scope.empty:
            return jsonify({"group_by": "college" if is_main else "course", "courses": []})

        # Shared forecast horizon (years driven by training_state.json) —
        # same source yearUpdate.js reads via /api/training-state, so the
        # (Predicted) years shown there and the dashed years drawn here
        # always agree, and both grow together as training re-runs.
        try:
            from training.auto_train import load_state as _load_state_hsc
            _hs = _load_state_hsc().get('horizon', {})
            latest_year_start = _hs.get('latest_year_start', 2024)
            years_pred = [int(y.split('-')[0]) for y in _hs.get('prediction_years', [])]
        except Exception:
            latest_year_start = 2024
            years_pred = [2025, 2026, 2027, 2028, 2029, 2030]

        result = []

        # ── Build the list of (group_label, group_df, feature_college)
        # tuples to rank. Per-college mode pools every course inside that
        # college into ONE group; per-course mode keeps each course
        # separate, same as before. ──
        if is_main:
            groups = []
            for code in ['CAHS', 'CBA', 'CCST', 'CEA', 'COAS', 'CTEC']:
                full_names = expand_college(code)
                g_df = df_scope[df_scope['College'].astype(str).str.strip().str.upper().isin(
                    [n.upper() for n in full_names]
                )]
                if g_df.empty:
                    continue
                groups.append((code, g_df, code))
        else:
            course_names = sorted(df_scope['Course'].dropna().astype(str).str.strip().unique())
            if hsc_scope["type"] == "course":
                course_names = [c for c in course_names if c.strip().upper() == hsc_scope["course_name"].upper()]
            groups = []
            for course in course_names:
                g_df = df_scope[df_scope['Course'].astype(str).str.strip() == course]
                if g_df.empty:
                    continue
                # That course's own college, for the model's College_ feature.
                course_college = str(g_df['College'].dropna().astype(str).str.strip().iloc[0]) if 'College' in g_df.columns and not g_df['College'].dropna().empty else college
                groups.append((course, g_df, course_college))

        for group_label, g_df, feature_college in groups:
            # Overall (all-years) difficulty ranking, same weighting logic
            # as before, just used to pick WHICH 5 subjects, not the values.
            difficulty = (
                g_df.groupby('Subject')
                .apply(lambda g: np.average(g['Avg_Grade'], weights=g['Student_Cnt'])
                       if g['Student_Cnt'].sum() > 0 else g['Avg_Grade'].mean())
                .sort_values(ascending=False)
            )
            top5_subjects = difficulty.head(5).index.tolist()

            years_hist = sorted(
                int(y) for y in g_df['Year_Numeric'].dropna().unique()
                if int(y) <= latest_year_start
            )
            if not years_hist:
                continue

            all_years = years_hist + years_pred

            subject_series = []
            for subj in top5_subjects:
                subj_rows = g_df[g_df['Subject'] == subj]
                overall_avg = float(difficulty[subj])

                # --- A. HISTORY (real, uploaded years) ---
                data_points = []
                last_val = overall_avg
                for y in years_hist:
                    yr_rows = subj_rows[subj_rows['Year_Numeric'] == y]
                    if not yr_rows.empty:
                        if yr_rows['Student_Cnt'].sum() > 0:
                            val = np.average(yr_rows['Avg_Grade'], weights=yr_rows['Student_Cnt'])
                        else:
                            val = yr_rows['Avg_Grade'].mean()
                        val = round(float(val), 2)
                        last_val = val
                    else:
                        # GAP FILLER: no data for this subject in this year
                        # yet — reuse the last known value so the line
                        # doesn't break/drop to zero.
                        val = round(float(last_val), 2)
                    data_points.append(val)

                # --- B. FORECAST (years_pred, from training_state horizon) ---
                # Was: subj_model.predict() + `(pred + last_val) / 2`
                # smoothing — same flattening bug as get_subject_forecast
                # above. Now forecast THIS subject's own history directly,
                # so each course keeps its own distinct trend instead of
                # collapsing toward a shared value.
                if years_pred:
                    data_points.extend(
                        forecast_series(data_points, len(years_pred), y_min=1.0, y_max=5.0)
                    )

                subject_series.append({
                    "subject": subj,
                    "avg_grade": round(overall_avg, 2),
                    "data": data_points
                })

            result.append({
                "course": group_label,
                "years": all_years,
                "history_count": len(years_hist),
                "subjects": subject_series
            })

        return jsonify({"group_by": "college" if is_main else "course", "courses": result})

    except Exception as e:
        print(f"Hardest Subjects By Course Error: {e}")
        return jsonify({"error": str(e)}), 500


#drop spike
@ml_bp.route('/api/get_dropout_spike')
def get_dropout_spike():
    try:

        # 1. INPUT
        college = request.args.get('college', 'all').strip()
        
        # 2. LOAD DATA
        local_df = df_full_loaded.copy()
        
        # The master CSV has never had a raw 'Status' column — every other
        # endpoint in this file (get_status_pie, get_dropout_pie, etc.) already
        # uses the pre-computed 'is_drop' flag instead. This check was looking
        # for a column that doesn't exist, so it failed unconditionally on
        # every request regardless of data quality. Use is_drop here too.
        if 'is_drop' not in local_df.columns:
             return jsonify({"error": "is_drop column missing"}), 500

        # Filter by College OR Course — `college` may be a specific course
        # from the dean dashboards' combined dropdown.
        spike_scope = resolve_scope(college)
        local_df = apply_scope_filter(local_df, spike_scope)

        # 3. HISTORY
        if 'Year_Numeric' not in local_df.columns:
             local_df['Year_Numeric'] = local_df['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)
        
        years_hist = sorted(local_df['Year_Numeric'].unique())
        data_points = []
        
        for yr in years_hist:
            yr_df = local_df[local_df['Year_Numeric'] == yr]
            total = yr_df['Student_ID'].nunique()
            
            if total > 0:
                # Use pre-computed is_drop flag (master CSV has no raw Status column)
                if 'is_drop' in yr_df.columns:
                    drop_count = yr_df.groupby('Student_ID')['is_drop'].max().sum()
                elif 'Status' in yr_df.columns:
                    drop_rows = yr_df[yr_df['Status'].str.contains("DROP", na=False)]
                    drop_count = drop_rows['Student_ID'].nunique()
                else:
                    drop_count = 0
                rate = (drop_count / total) * 100
                data_points.append(round(rate, 2))
            else:
                data_points.append(0)

        # 4. PREDICTION — years driven by training_state.json horizon
        try:
            from training.auto_train import load_state as _load_state3
            _hs3 = _load_state3().get('horizon', {})
            years_pred = [int(y.split('-')[0]) for y in _hs3.get('prediction_years', [])]
        except Exception:
            years_pred = []
        if not years_pred:
            _base = int(max(years_hist)) if years_hist else 2024
            years_pred = list(range(_base + 1, _base + 6))
        
        # Filter out years we already have in history to avoid overlap
        last_hist_year = years_hist[-1] if years_hist else 2024
        years_pred = [y for y in years_pred if y > last_hist_year]

        # Was: dropout_spike_model.predict() — a LinearRegression fit across
        # ALL colleges at once via dummy variables, which only ever produces
        # a straight-line trend and doesn't react to this college's own
        # recent acceleration/deceleration.
        # Now: forecast THIS college's own dropout-rate history directly.
        if years_pred:
            forecast_vals = forecast_series(data_points, len(years_pred), y_min=0, y_max=100)
            data_points.extend(forecast_vals)

        all_years = [int(y) for y in list(years_hist) + years_pred]
        
        # Find index where prediction starts (for JS dashed line)
        pred_start_index = len(years_hist) - 1 

        # 5. SPIKE DETECTION
        spikes = []
        for i in range(len(data_points)):
            if i == 0:
                spikes.append(False)
            else:
                prev = data_points[i-1]
                curr = data_points[i]
                # Spike logic: 10% relative increase or raw jump > 5%
                is_spike = False
                if prev > 0:
                    if ((curr - prev) / prev) > 0.15: is_spike = True
                elif curr > 5: 
                    is_spike = True
                spikes.append(is_spike)

        return jsonify({
            "labels": all_years,
            "data": data_points,
            "spikes": spikes,
            "pred_start_index": pred_start_index # Send to JS
        })

    except Exception as e:
        print(f"Dropout Spike Error: {e}")
        return jsonify({"error": str(e)}), 500
    


# Irreg multiline
@ml_bp.route('/api/get_status_pie')
def get_status_pie():
    try:
        # 1. INPUTS
        year = int(request.args.get('year', 2024))
        college_arg = request.args.get('college', 'all').strip()
        semester_arg = request.args.get('semester', 'all').strip()

        # 2. MODE
        LATEST_REAL_YEAR = get_latest_real_year()
        is_forecast = year > LATEST_REAL_YEAR

        regular_count = 0
        irregular_count = 0

        # `college_arg` can be a college code OR a specific course name
        # (dean dashboards' combined dropdown) — resolve once, use everywhere below.
        pie_scope = resolve_scope(college_arg)

        # --- HELPER: Filter Data ---
        def get_filtered_data(target_year):
            df = df_full_loaded.copy()
            if 'Year_Numeric' in df.columns:
                df = df[df['Year_Numeric'] == target_year]

            df = apply_scope_filter(df, pie_scope)

            if semester_arg.lower() not in ['all', 'overall']:
                df = df[df['Semester'].astype(str).str.contains(semester_arg, case=False, na=False)]
            return df

        # --- A. FORECAST MODE ---
        if is_forecast:
            # 1. Predict Rate (%)
            pred_rate = 0
            if status_model and status_features:
                # Build Input Vector
                X_in = pd.DataFrame(0, index=[0], columns=status_features)
                X_in['Year_Numeric'] = year
                
                # Map Semester
                sem_val = 1.5 # Default
                if '1' in semester_arg: sem_val = 1
                elif '2' in semester_arg: sem_val = 2
                elif 'summer' in semester_arg.lower(): sem_val = 3
                
                if 'Sem_Numeric' in status_features:
                    X_in['Sem_Numeric'] = sem_val
                
                # Map College — no per-course model, so a course selection
                # uses its own parent college's feature bit.
                feat_college = pie_scope["feature_college"] or (
                    college_arg if pie_scope["type"] == "college" else None
                )
                if feat_college:
                    col_feat = f"College_{feat_college.upper()}"
                    if col_feat in status_features:
                        X_in[col_feat] = 1
                
                try:
                    # Predict and Clamp (0-100%)
                    pred_rate = float(status_model.predict(X_in)[0])
                    pred_rate = max(0, min(100, pred_rate))
                except:
                    pred_rate = 0

            # 2. Estimate Population (Baseline = Last Actual Year)
            last_cohort = get_filtered_data(LATEST_REAL_YEAR)
            base_pop = last_cohort['Student_ID'].nunique()
            
            if base_pop == 0: base_pop = 100 # Fallback

            # 3. Calculate Counts
            irregular_count = int(base_pop * (pred_rate / 100))
            regular_count = int(base_pop - irregular_count)

        # --- B. HISTORICAL MODE ---
        else:
            cohort = get_filtered_data(year)
            
            if not cohort.empty:
                # The master CSV has no raw "Grade" or "Status" column.
                # Use pre-computed flags: is_irregular, is_drop, is_inc.
                def check_status(group):
                    if 'is_irregular' in group.columns and group['is_irregular'].max() == 1:
                        return 1
                    if 'is_drop' in group.columns and group['is_drop'].max() == 1:
                        return 1
                    if 'is_inc' in group.columns and group['is_inc'].max() == 1:
                        return 1
                    return 0

                irreg_flags = cohort.groupby('Student_ID').apply(check_status)
                irregular_count = int(irreg_flags.sum())
                regular_count = int(len(irreg_flags) - irregular_count)

        # Final Data
        total = regular_count + irregular_count
        reg_pct = round((regular_count / total * 100), 1) if total > 0 else 0
        irr_pct = round((irregular_count / total * 100), 1) if total > 0 else 0

        return jsonify({
            "labels": ["Regular", "Irregular"],
            "data": [regular_count, irregular_count],
            "colors": ["#1cc88a", "#e74a3b"], 
            "percentages": [reg_pct, irr_pct],
            "year": year,
            "mode": "Forecast" if is_forecast else "Actual"
        })

    except Exception as e:
        print(f"Status Pie Error: {e}")
        return jsonify({"error": str(e)}), 500


# ── STATUS TREND (prediction-mode counterpart to get_status_pie) ────────────
# get_status_pie gives ONE year's snapshot (good for a donut).
# This endpoint gives the SAME Regular/INC/Dropped breakdown, but as three
# year-by-year series (good for a multi-line chart) — this is what the
# frontend should call when the user switches to "Prediction Mode" on the
# Student Status card, instead of just re-drawing the donut for a future
# year.
#
# Real years come straight from the data. Future years are produced by
# forecast_series() (Holt's damped trend, defined near the top of this
# file) applied separately to each of the three percentage lines, so
# Regular/INC/Dropped each get their own trend instead of being derived
# from one shared classifier's single risk score.
@ml_bp.route('/api/get_status_trend')
def get_status_trend():
    try:
        college_arg = request.args.get('college', 'all').strip()
        semester_arg = request.args.get('semester', 'all').strip()
        # NEW: optional gender filter — powers the Male/Female Retention &
        # Risk cards' Prediction-mode trend lines. 'all' (default) keeps
        # the original combined-campus behavior unchanged.
        gender_arg = request.args.get('gender', 'all').strip()
        # NEW: optional breakdown — '' (default) keeps the original single
        # aggregate-line response exactly as-is. 'college' or 'course'
        # switches to a multi-line response, one Regular%/Irregular% pair
        # PER college (Main dashboard) or PER course (dean dashboards,
        # scoped to whichever college is selected) — same convention
        # already used by /api/get_inc_forecast's own by= parameter, so
        # colors and grouping behave identically across both charts.
        breakdown = request.args.get('by', '').strip().lower()

        df_base = df_full_loaded.copy()
        if 'Year_Numeric' not in df_base.columns:
            df_base['Year_Numeric'] = (
                df_base['Year'].astype(str).str.extract(r'^(\d{4})')[0].astype(float)
            )

        if gender_arg.lower() not in ['all', '']:
            df_base = df_base[df_base['Gender'].astype(str).str.strip().str.lower() == gender_arg.lower()]

        if semester_arg.lower() not in ['all', 'overall']:
            df_base = df_base[df_base['Semester'].astype(str).str.contains(semester_arg, case=False, na=False)]

        # One row per (Year, Student) with mutually-exclusive status flags —
        # same three-category logic used elsewhere on the dashboards
        # (Regular / INC / Dropped, not the old binary Safe/Risk split).
        # Shared by both the aggregate branch below AND every per-group
        # line in the multi-line branch, so a group's numbers always
        # match what the recent-mode donut for that same group would show.
        def pct_series(scope_df):
            agg_cols = {}
            if "is_drop" in scope_df.columns: agg_cols["is_drop"] = "max"
            if "is_inc" in scope_df.columns: agg_cols["is_inc"] = "max"

            yrs = sorted(scope_df['Year_Numeric'].dropna().unique().tolist())
            reg_pct, inc_pct, drop_pct = [], [], []

            for yr in yrs:
                yr_df = scope_df[scope_df['Year_Numeric'] == yr]
                student_flags = yr_df.groupby('Student_ID').agg(agg_cols).reset_index()

                if "is_drop" not in student_flags.columns: student_flags["is_drop"] = 0
                if "is_inc" not in student_flags.columns: student_flags["is_inc"] = 0

                total = len(student_flags)
                if total == 0:
                    reg_pct.append(0.0); inc_pct.append(0.0); drop_pct.append(0.0)
                    continue

                dropped = int(student_flags["is_drop"].sum())
                # INC and Dropped are mutually exclusive — a dropped student
                # isn't double counted in the INC bucket even if is_inc is
                # also flagged for them.
                inc = int(((student_flags["is_inc"] == 1) & (student_flags["is_drop"] == 0)).sum())
                regular = total - dropped - inc

                reg_pct.append(round(regular / total * 100, 1))
                inc_pct.append(round(inc / total * 100, 1))
                drop_pct.append(round(dropped / total * 100, 1))

            return yrs, reg_pct, inc_pct, drop_pct

        # ── MULTI-LINE MODE ──────────────────────────────────────────
        if breakdown in ('college', 'course'):
            scope_df = df_base
            if college_arg.lower() not in ('all', 'main campus', ''):
                # `college_arg` may itself be a specific COURSE (dean
                # dashboards' combined dropdown), not a college code — in
                # that case scope to ITS parent college so the by-course
                # trend still shows every sibling course of that college.
                trend_scope = resolve_scope(college_arg)
                if trend_scope["type"] == "course" and trend_scope["feature_college"]:
                    scope_df = scope_df[scope_df['College'].astype(str).str.strip().str.upper() == trend_scope["feature_college"]]
                else:
                    full_names = expand_college(college_arg)
                    scope_df = scope_df[scope_df['College'].astype(str).str.strip().isin(full_names)]

            if breakdown == 'college':
                group_col = 'College'
                groups = sorted(scope_df['College'].dropna().astype(str).str.strip().unique())
            else:
                # Course breakdown defaults to every course in the scoped
                # college — but if a SPECIFIC course is selected, narrow
                # down to just that one course's line.
                group_col = 'Course'
                groups = (
                    sorted(scope_df['Course'].dropna().astype(str).str.strip().unique())
                    if 'Course' in scope_df.columns else []
                )
                if college_arg.lower() not in ('all', 'main campus', '') and trend_scope["type"] == "course":
                    groups = [g for g in groups if g.strip().upper() == trend_scope["course_name"].upper()]

            per_group = []
            all_years_set = set()

            for g in groups:
                g_df = scope_df[scope_df[group_col].astype(str).str.strip() == g]
                if g_df.empty:
                    continue

                yrs, reg_pct, inc_pct, drop_pct = pct_series(g_df)
                if not yrs:
                    continue

                # Irregular = INC + Dropped combined — matches the binary
                # Regular/Irregular framing every other status donut on
                # the dashboard already uses, so a group's Irregular line
                # here means the same thing as its Irregular donut slice.
                irr_pct = [round(100 - r, 1) for r in reg_pct]

                latest = int(max(yrs))
                fyrs = list(range(latest + 1, latest + 6))
                reg_fore = forecast_series(reg_pct, len(fyrs), y_min=0, y_max=100)
                irr_fore = forecast_series(irr_pct, len(fyrs), y_min=0, y_max=100)

                all_years_set.update(int(y) for y in yrs)
                all_years_set.update(fyrs)
                per_group.append({
                    "label": g, "years": [int(y) for y in yrs],
                    "regular": reg_pct, "irregular": irr_pct,
                    "forecast_years": fyrs,
                    "regular_forecast": reg_fore, "irregular_forecast": irr_fore,
                })

            all_years = sorted(all_years_set)

            def build_series(hist_key, fore_key):
                out = []
                for pg in per_group:
                    hist_map = dict(zip(pg["years"], pg[hist_key]))
                    fc_map = dict(zip(pg["forecast_years"], pg[fore_key]))
                    hist_line = [hist_map.get(y) for y in all_years]
                    fc_line = [fc_map.get(y) for y in all_years]
                    # Bridge the last real point into the forecast line so
                    # the dashed line visually connects to the solid one.
                    last_idx = max([i for i, v in enumerate(hist_line) if v is not None], default=None)
                    if last_idx is not None and last_idx + 1 < len(fc_line):
                        fc_line[last_idx] = hist_line[last_idx]
                    out.append({"label": pg["label"], "history": hist_line, "forecast": fc_line})
                return out

            return jsonify({
                "years": all_years,
                "breakdown": breakdown,
                "regular_series": build_series("regular", "regular_forecast"),
                "irregular_series": build_series("irregular", "irregular_forecast"),
            })

        # ── ORIGINAL SINGLE-LINE AGGREGATE MODE (unchanged) ────────────
        df = apply_scope_filter(df_base, resolve_scope(college_arg))

        if df.empty:
            return jsonify({"error": "No data available for this filter."}), 200

        years, regular_pct, inc_pct, dropped_pct = pct_series(df)

        latest_year = int(max(years)) if years else get_latest_real_year()
        forecast_years = list(range(latest_year + 1, latest_year + 6))

        # Each line gets its OWN trend — no shared dummy-variable model,
        # so Regular/INC/Dropped don't collapse toward each other the way
        # the old per-college classifier approach tended to.
        regular_forecast = forecast_series(regular_pct, len(forecast_years), y_min=0, y_max=100)
        inc_forecast_vals = forecast_series(inc_pct, len(forecast_years), y_min=0, y_max=100)
        dropped_forecast = forecast_series(dropped_pct, len(forecast_years), y_min=0, y_max=100)

        return jsonify({
            "years": [int(y) for y in years],
            "regular_pct": regular_pct,
            "inc_pct": inc_pct,
            "dropped_pct": dropped_pct,
            "forecast_years": forecast_years,
            "regular_forecast": regular_forecast,
            "inc_forecast": inc_forecast_vals,
            "dropped_forecast": dropped_forecast,
            "history_count": len(years),
        })

    except Exception as e:
        print(f"Status Trend Error: {e}")
        return jsonify({"error": str(e)}), 500


#  STATUS + GENDER, BROKEN DOWN PER COURSE 
@ml_bp.route('/api/get_status_by_course')
def get_status_by_course():
    """Per-COURSE breakdown of Regular vs Irregular, PLUS a Male/Female
    Safe-vs-Risk split for that same course. This is the course-level
    companion to get_status_pie (which only goes down to the college
    level) and get_dropout_pie (which only returns one combined gender
    split for the whole selection).

    - college='CAHS' (etc.)  -> every course INSIDE that one college.
    - college='all'          -> every course across EVERY college, each
      row tagged with its own "college" field, so the Main dashboard can
      group/label them (e.g. for small-multiple donut grids).

    Historical (real, uploaded) data only — same student-level flags
    (is_irregular / is_drop / is_inc) the Status and Dropout donuts
    already trust — so this works even for courses with no trained
    per-course forecast model.
    """
    try:
        year = int(request.args.get('year', get_latest_real_year()))
        college_arg = request.args.get('college', 'all').strip()
        semester_arg = request.args.get('semester', 'all').strip()

        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = df_full_loaded['Year'].astype(str).str.extract(r'^(\d{4})').astype(int)

        df = df_full_loaded[df_full_loaded['Year_Numeric'] == year].copy()

        if college_arg.lower() not in ['all', 'main campus']:
            # This chart always breaks a COLLEGE down into its courses.
            # `college_arg` may itself be a specific COURSE — scope to
            # ITS parent college so every sibling course still shows,
            # instead of matching nothing.
            sbc_scope = resolve_scope(college_arg)
            if sbc_scope["type"] == "course" and sbc_scope["feature_college"]:
                df = df[df['College'].astype(str).str.strip().str.upper() == sbc_scope["feature_college"]]
            else:
                full_names = expand_college(college_arg)
                df = df[df['College'].astype(str).str.strip().isin(full_names)]

        if semester_arg.lower() not in ['all', 'overall']:
            df = df[df['Semester'].astype(str).str.contains(semester_arg, case=False, na=False)]

        if df.empty or 'Course' not in df.columns:
            return jsonify({"year": year, "courses": []})

        def check_status(group):
            if 'is_irregular' in group.columns and group['is_irregular'].max() == 1:
                return 1
            if 'is_drop' in group.columns and group['is_drop'].max() == 1:
                return 1
            if 'is_inc' in group.columns and group['is_inc'].max() == 1:
                return 1
            return 0

        courses = sorted(df['Course'].dropna().astype(str).str.strip().unique())
        if college_arg.lower() not in ['all', 'main campus'] and sbc_scope["type"] == "course":
            courses = [c for c in courses if c.strip().upper() == sbc_scope["course_name"].upper()]
        results = []

        for course in courses:
            c_df = df[df['Course'].astype(str).str.strip() == course]
            if c_df.empty:
                continue

            # One row per student: Gender/College (first seen) + Irregular flag.
            student_rows = c_df.groupby('Student_ID').agg({'Gender': 'first', 'College': 'first'})
            student_rows['Irregular'] = c_df.groupby('Student_ID').apply(check_status)  # aligns by Student_ID index

            if student_rows.empty:
                continue

            regular = int((student_rows['Irregular'] == 0).sum())
            irregular = int((student_rows['Irregular'] == 1).sum())

            is_male, is_female = gender_masks(student_rows['Gender'])

            male_safe = int(((student_rows['Irregular'] == 0) & is_male).sum())
            male_risk = int(((student_rows['Irregular'] == 1) & is_male).sum())
            female_safe = int(((student_rows['Irregular'] == 0) & is_female).sum())
            female_risk = int(((student_rows['Irregular'] == 1) & is_female).sum())

            parent_college = str(student_rows['College'].iloc[0]).strip() if not student_rows.empty else college_arg

            results.append({
                "course": course,
                "college": parent_college,
                "regular": regular,
                "irregular": irregular,
                "male_safe": male_safe,
                "male_risk": male_risk,
                "female_safe": female_safe,
                "female_risk": female_risk,
                "total": regular + irregular
            })

        return jsonify({"year": year, "mode": "Actual", "courses": results})

    except Exception as e:
        print(f"Status By Course Error: {e}")
        return jsonify({"error": str(e)}), 500


#  GENDER x PRECISE STATUS (Regular / INC / Dropped), grouped by COLLEGE or COURSE 
@ml_bp.route('/api/get_gender_status_breakdown')
def get_gender_status_breakdown():
    """
    Powers the Male/Female Retention & Risk grids.

    Unlike get_dropout_pie (one aggregate Safe-vs-Risk split for the whole
    selection), this returns ONE ROW PER GROUP with three PRECISE,
    mutually-exclusive status buckets per gender — Regular, INC, Dropped —
    instead of collapsing INC + Dropped together into a single "risk" slice.

    Grouping depends on the 'college' filter, same convention as
    get_status_by_course:
      - college='all' / 'Main Campus' -> one row PER COLLEGE (the 6 known
        college codes), for the Main dashboard's college-colored grid.
      - college='CAHS' (etc.)         -> one row PER COURSE inside that
        college, for the dean dashboards' course-colored grid.

    A student is "Dropped" if is_drop==1 (checked first), else "INC" if
    is_inc==1, else "Regular" — so the three buckets always sum to that
    group's total instead of double-counting a student who is both.

    Historical (real, uploaded) data only — same student-level flags the
    Status/Dropout donuts already trust — so it works even without a
    trained per-course/per-college forecast model.
    """
    try:
        year = int(request.args.get('year', get_latest_real_year()))
        college_arg = request.args.get('college', 'all').strip()
        semester_arg = request.args.get('semester', 'all').strip()

        if 'Year_Numeric' not in df_full_loaded.columns:
            df_full_loaded['Year_Numeric'] = (
                df_full_loaded['Year'].astype(str).str.extract(r'^(\d{4})')[0].astype(float)
            )

        LATEST_REAL_YEAR = get_latest_real_year()
        is_forecast = year > LATEST_REAL_YEAR
        cohort_year = LATEST_REAL_YEAR if is_forecast else year
        mode_label = "Forecast" if is_forecast else "Actual History"

        df = df_full_loaded[df_full_loaded['Year_Numeric'] == cohort_year].copy()

        if semester_arg.lower() not in ['all', 'overall']:
            df = df[df['Semester'].astype(str).str.contains(semester_arg, case=False, na=False)]

        is_main = college_arg.lower() in ['all', 'main campus', 'overall', '']

        def bucket_group(sub_df):
            """Collapse rows to one per Student_ID, then split into
            Regular / INC / Dropped x Male / Female, mutually exclusive
            (Dropped takes priority over INC)."""
            agg = {'Gender': 'first'}
            if 'is_drop' in sub_df.columns:
                agg['is_drop'] = 'max'
            if 'is_inc' in sub_df.columns:
                agg['is_inc'] = 'max'
            students = sub_df.groupby('Student_ID').agg(agg).reset_index()
            if 'is_drop' not in students.columns:
                students['is_drop'] = 0
            if 'is_inc' not in students.columns:
                students['is_inc'] = 0

            is_male, is_female = gender_masks(students['Gender'])

            dropped = students['is_drop'] == 1
            inc = (~dropped) & (students['is_inc'] == 1)
            regular = (~dropped) & (~inc)

            return {
                "male_regular": int((regular & is_male).sum()),
                "male_inc": int((inc & is_male).sum()),
                "male_drop": int((dropped & is_male).sum()),
                "female_regular": int((regular & is_female).sum()),
                "female_inc": int((inc & is_female).sum()),
                "female_drop": int((dropped & is_female).sum()),
            }

        results = []

        if is_main:
            # ── PER-COLLEGE MODE (Main dashboard) ──
            for code in ['CAHS', 'CBA', 'CCST', 'CEA', 'COAS', 'CTEC']:
                full_names = expand_college(code)
                c_df = df[df['College'].astype(str).str.strip().str.upper().isin(
                    [n.upper() for n in full_names]
                )]
                if c_df.empty:
                    continue
                row = bucket_group(c_df)
                row['group'] = code
                row['college'] = code
                results.append(row)
        else:
            # ── PER-COURSE MODE (dean dashboards, e.g. CAHS) ──
            # `college_arg` may itself be a specific COURSE — scope to
            # ITS parent college so every sibling course still shows.
            gsb_scope = resolve_scope(college_arg)
            if gsb_scope["type"] == "course" and gsb_scope["feature_college"]:
                col_df = df[df['College'].astype(str).str.strip().str.upper() == gsb_scope["feature_college"]]
            else:
                full_names = expand_college(college_arg)
                col_df = df[df['College'].astype(str).str.strip().str.upper().isin(
                    [n.upper() for n in full_names]
                )]

            if col_df.empty or 'Course' not in col_df.columns:
                return jsonify({"year": year, "mode": mode_label, "group_by": "course", "rows": []})

            courses = sorted(col_df['Course'].dropna().astype(str).str.strip().unique())
            if gsb_scope["type"] == "course":
                courses = [c for c in courses if c.strip().upper() == gsb_scope["course_name"].upper()]
            for course in courses:
                c_df = col_df[col_df['Course'].astype(str).str.strip() == course]
                if c_df.empty:
                    continue
                row = bucket_group(c_df)
                row['group'] = course
                row['college'] = college_arg.upper()
                results.append(row)

        return jsonify({
            "year": year,
            "mode": mode_label,
            "group_by": "college" if is_main else "course",
            "rows": results
        })

    except Exception as e:
        print(f"Gender Status Breakdown Error: {e}")
        return jsonify({"error": str(e)}), 500