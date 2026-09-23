"""
separation_csv.py — NovaSight CSV Separation Pipeline
======================================================
Runs AFTER the user confirms the preprocessing confirmation modal.
Reads the longform CSV from MySQL (semester_uploads) and produces
DS00–DS06 datasets stored in the new model_datasets table.

This is the updated version of export_datasets.py adapted for
integration with the Flask upload pipeline. Key differences:
  - Reads from MySQL (semester_uploads) instead of disk files
  - Writes to MySQL (model_datasets) instead of disk CSVs
  - Accepts a single upload_id or academic_year+semester
  - Also triggers auto_train.py if MIN_SEMESTERS_FOR_TRAINING is met

Usage (called from upload route after user confirms):
    from preprocessing.separation_csv import run_csv_separation
    result = run_csv_separation(upload_id=7, academic_year="2022-2023", semester="1st Semester")
"""

import io
import logging
import warnings
warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
from sklearn.preprocessing import LabelEncoder

log = logging.getLogger(__name__)

from sqlalchemy import text

from util.db_io import (
    upsert_model_dataset, count_rows, mark_archives_blocked,
    get_engine, _decompress_csv,
)
from configs.config import MIN_SEMESTERS_FOR_TRAINING

# pandas >= 2.2 wants include_groups=False in groupby.apply(); older versions
# don't know the kwarg and raise TypeError. Pick once, use everywhere.
_PD_VER = tuple(int(x) for x in pd.__version__.split(".")[:2])
_IG = {"include_groups": False} if _PD_VER >= (2, 2) else {}

# ─── Status columns used in multiple datasets ──────────────────────────────
AT_RISK_STATUSES  = {"FAILED", "DRP", "UDR", "W", "INC"}
FAILED_STATUSES   = {"FAILED", "DRP", "UDR", "W", "INC", "NGA"}
CONTINUING_STATUS = "CRD"  # CRD = credited/continuing, never at-risk

# ─── Performance band thresholds (Philippine GWA: lower = better) ──────────
def _perf_band(gwa):
    if pd.isna(gwa):
        return "Unknown"
    if gwa <= 1.50:  return "Excellent"
    if gwa <= 2.00:  return "Good"
    if gwa <= 2.75:  return "Average"
    if gwa <= 3.00:  return "Below Average"
    return "Failing"

# ─── Sem ordering helper ────────────────────────────────────────────────────
def _sem_order(sem: str) -> int:
    s = str(sem).lower()
    if "1" in s or "first" in s:   return 1
    if "2" in s or "second" in s:  return 2
    if "sum" in s:                  return 3
    return 9

def _ensure_numeric_cols(df: pd.DataFrame) -> pd.DataFrame:
    """Derive Year_Numeric and Sem_Numeric if missing (backward compat)."""
    if "Year_Numeric" not in df.columns:
        df = df.copy()
        df["Year_Numeric"] = df["Academic_Year"].apply(
            lambda x: int(str(x).split("-")[0].strip())
            if pd.notna(x) else None
        )
    if "Sem_Numeric" not in df.columns:
        df["Sem_Numeric"] = df["Semester"].apply(_sem_order)
    return df

# ─── Year level numeric ─────────────────────────────────────────────────────
def _year_level_num(yl: str) -> int:
    if not yl:
        return 0
    s = str(yl).upper()
    if "IRREG" in s:
        return -1
    for n in range(1, 6):
        if str(n) in s:
            return n
    return 0


# ══════════════════════════════════════════════════════════════════════════
#  DATASET BUILDERS (DS00–DS06)
# ══════════════════════════════════════════════════════════════════════════

# ─── Per-dataset accuracy (% of THIS dataset's own rows where every ────────
# listed column is non-null) — same idea/pattern as preprocess.py's
# _pct_valid() for the 01-17 CSVs. Columns picked per dataset are the
# fields that actually matter for that chart/table, not every column.
def _pct_valid(df: pd.DataFrame, cols: list[str]) -> float | None:
    if df is None or df.empty:
        return None
    cols = [c for c in cols if c in df.columns]
    if not cols:
        return None
    return round(100 * df[cols].notna().all(axis=1).mean(), 2)


DATASET_ACCURACY_COLUMNS = {
    "DS00": ["College", "Course", "Student_Count"],
    "DS01": ["College", "Course", "GWA"],
    "DS02": ["College", "Course", "status_rate"],
    "DS03": ["College", "Course", "Gender", "pct"],
    # Avg_Grade is deliberately left out here: build_ds04_hardest_subjects()
    # sets it to None whenever a (College, Course, Subject, semester) group
    # had ZERO completed numeric grades (everyone in it was DRP/INC/W/UDR/CRD)
    # -- that's a legitimately empty value, not missing/bad data, so scoring
    # it against Avg_Grade was dragging otherwise-clean uploads down to
    # 97-98% for no real data-quality reason. Fail_Rate is always computed
    # (it only depends on Student_Count, which is never null), so it's the
    # column that actually reflects this dataset's completeness.
    "DS04": ["Fail_Rate"],
    "DS05": ["College", "Course", "status_rate"],
    # Std_GWA is 0.0 for singleton groups (Student_Count = 1) by design —
    # pandas .std() of one value is NaN, but zero spread is the mathematically
    # correct answer and is filled with 0.0 in build_ds06_gwa_trend(). Excluding
    # it from the accuracy check so a legitimate singleton never drags the score
    # below 100%. Avg_GWA alone reflects whether this dataset's rows are complete.
    "DS06": ["Avg_GWA"],
}


def build_ds00_enrollment(lf_full: pd.DataFrame) -> pd.DataFrame:
    """DS00 — True enrollment headcount (ALL students, including excluded)."""
    g = lf_full.drop_duplicates("Student_ID").groupby(
        ["College", "Course", "Gender", "Year_Level",
         "Academic_Year", "Semester", "Year_Numeric", "Sem_Numeric"],
        dropna=False
    ).size().reset_index(name="Student_Count")
    g["Is_Regular"]   = (g["Year_Level"].str.upper().str.contains("IRREG") == False)
    g["Is_Irregular"] = ~g["Is_Regular"]
    return g


def build_ds01_kpi_student(lf: pd.DataFrame) -> pd.DataFrame:
    """DS01 — One row per student per semester (training-ready only)."""
    lf = lf.copy()
    lf["Status_Upper"] = lf["Status"].fillna("").str.strip().str.upper()

    def agg_student(g):
        st = g["Status_Upper"]
        gwa_src = g["GWA_Source"].iloc[0] if "GWA_Source" in g.columns else None
        is_missing_gwa = (gwa_src == "MISSING")
        n_subj = max(g["Subject_Code"].nunique(), 1)
        return pd.Series({
            "GWA":                g["GWA"].iloc[0] if "GWA" in g.columns else None,
            "GWA_Source":         gwa_src,
            "Perf_Band":          _perf_band(g["GWA"].iloc[0] if "GWA" in g.columns else None),
            "Units_Enrolled_Reported": g["Units_Enrolled_Reported"].iloc[0] if "Units_Enrolled_Reported" in g.columns else None,
            "Units_Earned":       g["Units_Earned"].iloc[0] if "Units_Earned" in g.columns else None,
            "Completion_Rate":    round(
                g["Units_Earned"].iloc[0] / g["Units_Enrolled_Reported"].iloc[0] * 100, 2
            ) if (
                "Units_Earned" in g.columns and "Units_Enrolled_Reported" in g.columns
                and pd.notna(g["Units_Earned"].iloc[0])
                and pd.notna(g["Units_Enrolled_Reported"].iloc[0])
                and g["Units_Enrolled_Reported"].iloc[0] > 0
            ) else None,
            "Failed_Count":     int((st == "FAILED").sum()),
            "DRP_Count":        int((st == "DRP").sum()),
            "INC_Count":        int((st == "INC").sum()),
            "UDR_Count":        int((st == "UDR").sum()),
            "W_Count":          int((st == "W").sum()),
            "NGA_Count":        int((st == "NGA").sum()),
            "CRD_Count":        int((st == CONTINUING_STATUS).sum()),
            "Continuing_Count": int(((st == CONTINUING_STATUS) | g["Grade"].notna()).sum()),
            "At_Risk":          bool(st.isin(AT_RISK_STATUSES).any() or is_missing_gwa),
            "At_Risk_Ratio":    round(st.isin(AT_RISK_STATUSES).sum() / n_subj, 4),
            "MISSING_GWA":      bool(is_missing_gwa),
        })

    key = ["Student_ID", "College", "Course", "Gender", "Year_Level",
           "Academic_Year", "Semester", "Year_Numeric", "Sem_Numeric"]
    key_present = [k for k in key if k in lf.columns]

    agg = lf.groupby(key_present, dropna=False).apply(agg_student, **_IG).reset_index()
    agg["Year_Level_Num"] = agg["Year_Level"].apply(_year_level_num)
    agg["Is_Regular"]   = agg["Year_Level_Num"].isin([1, 2, 3, 4, 5])
    agg["Is_Irregular"] = agg["Year_Level_Num"] == -1
    return agg


def build_ds02_heatmap_risk(lf: pd.DataFrame) -> pd.DataFrame:
    """DS02 — Risk rate per College × Course × Year_Level × status_type."""
    lf = lf.copy()
    lf["Status_Upper"] = lf["Status"].fillna("").str.strip().str.upper()
    records = []
    for status in ["FAILED", "DRP", "INC", "W", "UDR"]:
        grp = lf.groupby(
            ["College", "Course", "Year_Level",
             "Academic_Year", "Semester", "Year_Numeric", "Sem_Numeric"],
            dropna=False
        ).apply(lambda g, s=status: pd.Series({
            "status_type":   s,
            "total_students": g["Student_ID"].nunique(),
            "status_count":  (g["Status_Upper"] == s).sum(),
            "status_rate":   round((g["Status_Upper"] == s).sum() /
                                   max(g["Student_ID"].nunique(), 1) * 100, 2),
        }), **_IG).reset_index()
        records.append(grp)
    return pd.concat(records, ignore_index=True)


def build_ds03_gender_at_risk(lf: pd.DataFrame) -> pd.DataFrame:
    """DS03 — Gender × Status breakdown (CRD counted as Continuing)."""
    lf = lf.copy()
    lf["Status_Upper"] = lf["Status"].fillna("").str.strip().str.upper()
    records = []
    for status in ["Continuing", "FAILED", "DRP", "INC", "W", "UDR", "NGA"]:
        grp = lf.groupby(
            ["College", "Course", "Gender", "Year_Level",
             "Academic_Year", "Semester", "Year_Numeric", "Sem_Numeric"],
            dropna=False
        ).apply(lambda g, s=status: pd.Series({
            "status_type": s,
            "student_count": (
                (g["Grade"].notna() | (g["Status_Upper"] == CONTINUING_STATUS)).sum()
                if s == "Continuing"
                else (g["Status_Upper"] == s).sum()
            ),
            "total_students": g["Student_ID"].nunique(),
            "pct": round(
                (
                    (g["Grade"].notna() | (g["Status_Upper"] == CONTINUING_STATUS)).sum()
                    if s == "Continuing"
                    else (g["Status_Upper"] == s).sum()
                ) / max(g["Student_ID"].nunique(), 1) * 100,
                2,
            ),
        }), **_IG).reset_index()
        records.append(grp)
    return pd.concat(records, ignore_index=True)


def build_ds04_hardest_subjects(lf: pd.DataFrame) -> pd.DataFrame:
    """DS04 — Hardest subjects by avg grade and fail rate."""
    lf = lf.copy()
    lf["Status_Upper"] = lf["Status"].fillna("").str.strip().str.upper()
    rows = []
    for (college, course, subj_code, subj_name, ay, sem, yr_num, sem_num), g in \
            lf.groupby(["College", "Course", "Subject_Code", "Subject_Name",
                        "Academic_Year", "Semester", "Year_Numeric", "Sem_Numeric"],
                       dropna=False):
        students = g["Student_ID"].nunique()
        grades   = g["Grade"].dropna()
        grades   = grades[grades > 0]  # drop status sentinels (0.0 DRP/etc, -1.0 CRD) — not real grades
        statuses = g["Status_Upper"].dropna()
        rows.append({
            "College": college, "Course": course,
            "Subject_Code": subj_code, "Subject_Name": subj_name,
            "Academic_Year": ay, "Semester": sem,
            "Year_Numeric": yr_num, "Sem_Numeric": sem_num,
            "Student_Count": students,
            "Avg_Grade":    round(grades.mean(), 4) if len(grades) else None,
            "Failed_Count": int((statuses == "FAILED").sum()),
            "INC_Count":    int((statuses == "INC").sum()),
            "DRP_Count":    int((statuses == "DRP").sum()),
            "UDR_Count":    int((statuses == "UDR").sum()),
            "W_Count":      int((statuses == "W").sum()),
            "At_Risk_Count": int(statuses.isin(AT_RISK_STATUSES).sum()),
            "Fail_Rate": round(
                statuses.isin(AT_RISK_STATUSES).sum() / max(students, 1) * 100, 2),
        })
    return pd.DataFrame(rows)


def build_ds05_at_risk_forecast(lf: pd.DataFrame) -> pd.DataFrame:
    """DS05 — At-risk status rate per College × Course × Year_Level × status_type."""
    lf = lf.copy()
    lf["Status_Upper"] = lf["Status"].fillna("").str.strip().str.upper()
    records = []
    for status in ["FAILED", "DRP", "INC", "W", "UDR"]:
        grp = lf.groupby(
            ["College", "Course", "Year_Level",
             "Academic_Year", "Semester", "Year_Numeric", "Sem_Numeric"],
            dropna=False
        ).apply(lambda g, s=status: pd.Series({
            "status_type":    s,
            "total_students": g["Student_ID"].nunique(),
            "status_count":   (g["Status_Upper"] == s).sum(),
            "status_rate":    round(
                (g["Status_Upper"] == s).sum() /
                max(g["Student_ID"].nunique(), 1) * 100, 2),
        }), **_IG).reset_index()
        records.append(grp)
    out = pd.concat(records, ignore_index=True)
    out["Year_Level_Num"] = out["Year_Level"].apply(_year_level_num)
    return out


def build_ds06_gwa_trend(sm: pd.DataFrame) -> pd.DataFrame:
    """DS06 — Avg GWA per College × Course × Year_Level per semester.
    Source: student_summary (not longform). MISSING GWA students excluded.

    Std_GWA for singleton groups (Student_Count = 1) is set to 0.0 instead
    of NaN. pandas .std() of a single value is undefined (NaN), but zero
    spread is the correct interpretation — one student has no variation.
    This keeps those real students in the dataset while giving the ML model
    a meaningful, non-null feature value. Student_Count = 1 is also present
    as a feature so the model can learn to weight singletons appropriately.
    """
    sm = sm.copy()
    sm = _ensure_numeric_cols(sm)
    valid = sm[
        (sm["Include_In_Training"] == True) &
        sm["GWA"].notna() &
        (sm["GWA_Source"] != "MISSING")
    ]
    grp = valid.groupby(
        ["College", "Course", "Year_Level",
         "Academic_Year", "Semester", "Year_Numeric", "Sem_Numeric"],
        dropna=False
    ).agg(
        Avg_GWA=("GWA", "mean"),
        Std_GWA=("GWA", "std"),
        Student_Count=("Student_ID", "nunique"),
    ).reset_index()
    grp["Avg_GWA"] = grp["Avg_GWA"].round(4)
    grp["Std_GWA"] = grp["Std_GWA"].round(4)
    # Singleton groups (Student_Count = 1) produce NaN from .std() — fill
    # with 0.0 (zero spread is correct for a group of one, not missing data).
    grp["Std_GWA"] = grp["Std_GWA"].fillna(0.0)
    return grp


# ══════════════════════════════════════════════════════════════════════════
#  STORAGE + INPUT HELPERS  (the actual fix lives here)
# ══════════════════════════════════════════════════════════════════════════

def _ensure_model_datasets_table() -> None:
    """
    upsert_model_dataset() does a raw INSERT and nothing else in the project
    creates `model_datasets`, so on a fresh DB every INSERT failed with
    "Table doesn't exist". Create it here (idempotent) and make sure csv_file
    is LONGTEXT — a TEXT column tops out at 64 KB and a gzip+base64 dataset
    blob is bigger than that.
    """
    eng = get_engine()
    with eng.begin() as conn:
        conn.execute(text("""
            CREATE TABLE IF NOT EXISTS model_datasets (
                id            INT AUTO_INCREMENT PRIMARY KEY,
                dataset_key   VARCHAR(10)  NOT NULL,
                dataset_name  VARCHAR(60)  NULL,
                academic_year VARCHAR(20)  NOT NULL,
                semester      VARCHAR(20)  NOT NULL,
                student_rows  INT          NULL,
                longform_rows INT          NULL,
                accuracy      DECIMAL(5,2) NULL,
                csv_file      LONGTEXT     NULL,
                created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
                INDEX idx_md_lookup (dataset_key, academic_year, semester)
            ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        """))
        col = conn.execute(text("""
            SELECT DATA_TYPE FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE()
              AND TABLE_NAME = 'model_datasets' AND COLUMN_NAME = 'csv_file'
        """)).scalar()
        if col and col.lower() != "longtext":
            conn.execute(text("ALTER TABLE model_datasets MODIFY csv_file LONGTEXT NULL"))


def _read_blob_csv(table: str, academic_year: str, semester: str) -> pd.DataFrame:
    """Read ONE semester's CSV blob from a *_uploads table (not the whole table)."""
    with get_engine().connect() as conn:
        row = conn.execute(
            text(f"SELECT csv_file FROM {table} "
                 "WHERE academic_year = :ay AND semester = :sem"),
            {"ay": academic_year, "sem": semester},
        ).fetchone()
    if row is None or not row[0]:
        return pd.DataFrame()
    return pd.read_csv(io.StringIO(_decompress_csv(row[0])))


def _grade_to_status(g) -> str:
    """
    LEGACY FALLBACK — only for longform rows with no Status column (old data).

    preprocess.py collapses multiple statuses into one sentinel:
      0.0  → was DRP *or* UDR *or* W *or* NGA  (indistinguishable)
      5.0  → was INC *or* FAILED               (indistinguishable)
      -1.0 → CRD (credited / continuing)
      ≥4.0 (a real numeric grade) → FAILED

    New uploads have a literal Status column in the longform, so this
    function is never called for them — _normalize_longform() only calls
    it when Status is absent.
    """
    if pd.isna(g):
        return "DRP"    # NaN = status row in old encoding (0.0 was sentinel)
    if g == 0.0:
        return "DRP"    # old encoding: 0.0 was DRP/UDR/W/NGA — best guess DRP
    if g == 5.0:
        return "INC"    # old encoding: 5.0 was INC/FAILED — best guess INC
    if g == -1.0:
        return "CRD"    # old encoding: -1.0 = CRD sentinel
    if g >= 4.0:
        return "FAILED"
    return "PASSED"


def _normalize_longform(lf: pd.DataFrame, student_df: pd.DataFrame) -> pd.DataFrame:
    """
    The DS builders were written for a schema (Academic_Year, Subject_Code,
    Status, GWA, Include_In_Training ...) that preprocess.py does NOT produce.
    What it actually stores in longform_uploads is:
        Student_ID, Student_Seq, Gender, College, Course, Year_Level,
        Year_Level_Num, Subject, Grade, Semester, Year, Year_Numeric, Sem_Numeric
    Map one onto the other here so every builder finds its columns.
    """
    lf = lf.copy()

    if "Academic_Year" not in lf.columns and "Year" in lf.columns:
        lf["Academic_Year"] = lf["Year"]
    if "Subject_Code" not in lf.columns and "Subject" in lf.columns:
        lf["Subject_Code"] = lf["Subject"]
    if "Subject_Name" not in lf.columns:
        lf["Subject_Name"] = lf["Subject_Code"]
    if "Status" not in lf.columns:
        # Legacy path: preprocess.py before 2026-09 stored no Status column.
        # Reconstruct from Grade sentinel — 0.0 → "DRP" (UDR/W/NGA are lost),
        # 5.0 → "INC" (FAILED is lost). Best effort for old stored data.
        lf["Status"] = lf["Grade"].apply(_grade_to_status)
    else:
        # New path: Status is the literal string (DRP/UDR/W/NGA/INC/FAILED/CRD).
        # Normalise to uppercase so all .isin() and == checks match correctly.
        lf["Status"] = lf["Status"].fillna("").str.strip().str.upper()

    lf["Year_Level"] = lf["Year_Level"].fillna("Unknown").astype(str)
    lf["Gender"]     = lf["Gender"].fillna("Unknown")

    # Student-level GWA lives in student_df (semester_uploads) — bring it over.
    if "GWA" not in lf.columns and not student_df.empty and "GWA" in student_df.columns:
        gwa = student_df.drop_duplicates("Student_ID")[["Student_ID", "GWA"]]
        lf = lf.merge(gwa, on="Student_ID", how="left")

    # Same idea for Units_Enrolled_Reported / Units_Earned: these are
    # per-student totals that now come through in longform_uploads
    # directly (preprocess.py's _wide_to_legacy_long carries them since
    # 2026-09), but older stored longform_uploads rows predate that fix
    # and won't have the columns — bring them over from semester_uploads
    # the same way GWA is bridged above, so build_ds01_kpi_student's
    # Completion_Rate calc doesn't silently go to None for that data.
    if "Units_Enrolled_Reported" not in lf.columns and not student_df.empty \
            and "Units_Enrolled_Reported" in student_df.columns:
        units_enr = student_df.drop_duplicates("Student_ID")[["Student_ID", "Units_Enrolled_Reported"]]
        lf = lf.merge(units_enr, on="Student_ID", how="left")
    if "Units_Earned" not in lf.columns and not student_df.empty \
            and "Units_Earned" in student_df.columns:
        units_earn = student_df.drop_duplicates("Student_ID")[["Student_ID", "Units_Earned"]]
        lf = lf.merge(units_earn, on="Student_ID", how="left")

    if "GWA_Source" not in lf.columns:
        lf["GWA_Source"] = np.where(lf.get("GWA", pd.Series(index=lf.index)).notna(),
                                    "COMPUTED", "MISSING")
    if "Include_In_Training" not in lf.columns:
        lf["Include_In_Training"] = True

    return _ensure_numeric_cols(lf)


def _normalize_student(sm: pd.DataFrame) -> pd.DataFrame:
    """Same idea for DS06's source (student-level CSV from semester_uploads)."""
    sm = sm.copy()
    if "Academic_Year" not in sm.columns and "Year" in sm.columns:
        sm["Academic_Year"] = sm["Year"]
    sm["Year_Level"] = sm["Year_Level"].fillna("Unknown").astype(str)
    if "GWA_Source" not in sm.columns:
        sm["GWA_Source"] = np.where(sm["GWA"].notna(), "COMPUTED", "MISSING")
    if "Include_In_Training" not in sm.columns:
        sm["Include_In_Training"] = True
    return _ensure_numeric_cols(sm)


# ══════════════════════════════════════════════════════════════════════════
#  MAIN PIPELINE
# ══════════════════════════════════════════════════════════════════════════

def run_csv_separation(upload_id: int, academic_year: str, semester: str,
                       trigger_training: bool = True) -> dict:
    """
    Build DS00–DS06 for one semester and store them in model_datasets.

    trigger_training: True (default, old behaviour) fires auto-training in a
    fire-and-forget thread. upload_routes passes False and runs/tracks training
    itself, so the result can be shown to the user when it finishes.

    Returns success=True ONLY if every dataset was actually written. (Before,
    a failing builder was logged and skipped, so this returned success=True
    with every dataset at 0 rows — the UI said "done" and the table was empty.)
    """
    log.info(f"CSV separation starting — {academic_year} {semester} (upload_id={upload_id})")

    try:
        _ensure_model_datasets_table()

        # Step 1: subject-level rows are in longform_uploads; student-level in semester_uploads
        lf_raw = _read_blob_csv("longform_uploads", academic_year, semester)
        if lf_raw.empty:
            return {"success": False,
                    "error": f"No longform data found in longform_uploads for {academic_year} {semester}"}
        student_raw = _read_blob_csv("semester_uploads", academic_year, semester)

        lf_full = _normalize_longform(lf_raw, student_raw)
        sm = _normalize_student(student_raw) if not student_raw.empty \
            else lf_full.drop_duplicates("Student_ID").copy()

        lf = lf_full[lf_full["Include_In_Training"] == True].copy()
        log.info(f"  Longform rows: {len(lf_full):,} | Training-ready: {len(lf):,}")

        n_students = int(lf_full["Student_ID"].nunique())

        builders = [
            ("DS00", lambda: build_ds00_enrollment(lf_full)),
            ("DS01", lambda: build_ds01_kpi_student(lf)),
            ("DS02", lambda: build_ds02_heatmap_risk(lf)),
            ("DS03", lambda: build_ds03_gender_at_risk(lf)),
            ("DS04", lambda: build_ds04_hardest_subjects(lf)),
            ("DS05", lambda: build_ds05_at_risk_forecast(lf)),
            ("DS06", lambda: build_ds06_gwa_trend(sm)),
        ]

        dataset_sizes, dataset_accuracy, failures = {}, {}, {}
        for key, builder in builders:
            try:
                df = builder()
                if df is None or df.empty:
                    raise ValueError("builder returned 0 rows")
                accuracy = _pct_valid(df, DATASET_ACCURACY_COLUMNS.get(key, []))
                upsert_model_dataset(
                    dataset_key=key, academic_year=academic_year, semester=semester,
                    df=df, student_rows=n_students, accuracy=accuracy,
                )
                dataset_sizes[key] = len(df)
                dataset_accuracy[key] = accuracy
                acc_log = f", accuracy {accuracy}%" if accuracy is not None else ""
                log.info(f"  {key}: {len(df):,} rows saved{acc_log}")
            except Exception as e:
                log.exception(f"  {key} failed")
                dataset_sizes[key] = 0
                failures[key] = f"{type(e).__name__}: {e}"

        if failures:
            detail = "; ".join(f"{k} -> {v}" for k, v in failures.items())
            return {"success": False, "datasets": dataset_sizes,
                    "dataset_accuracy": dataset_accuracy,
                    "error": f"{len(failures)}/{len(builders)} datasets failed: {detail}"}

        try:
            mark_archives_blocked(academic_year, semester)
        except Exception as e:
            log.warning(f"  mark_archives_blocked failed (non-fatal): {e}")

        # Step 6: training gate (unchanged)
        n_sems = count_rows("semester_uploads")
        training_triggered = False
        if trigger_training and n_sems >= MIN_SEMESTERS_FOR_TRAINING:
            try:
                from training.auto_train import run_full_pipeline
                import threading
                threading.Thread(target=run_full_pipeline, daemon=True).start()
                training_triggered = True
                log.info(f"  Auto-training triggered ({n_sems} semesters available)")
            except Exception as e:
                log.warning(f"  Auto-training could not be triggered: {e}")

        return {"success": True, "datasets": dataset_sizes,
                "dataset_accuracy": dataset_accuracy,
                "training_triggered": training_triggered,
                "semesters_total": n_sems, "error": None}

    except Exception as e:
        log.exception("CSV separation failed")
        return {"success": False, "error": f"{type(e).__name__}: {e}"}


def get_separation_summary(academic_year: str, semester: str) -> list[dict]:
    """DS00–DS06 rows for one semester — used by the CSV Separation tab."""
    from util.db_io import list_csv_separations
    return list_csv_separations(academic_year, semester)