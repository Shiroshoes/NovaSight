import os
import re
import io
import json
import time
import shutil
import argparse
import traceback
from datetime import datetime

import pandas as pd
import numpy as np
import joblib

from sklearn.linear_model    import LinearRegression, Ridge
from sklearn.ensemble        import RandomForestRegressor, RandomForestClassifier
from sklearn.model_selection import train_test_split, KFold, cross_val_score
from sklearn.metrics         import (
    r2_score, mean_squared_error, mean_absolute_error,
    accuracy_score, f1_score,
)

# Import our preprocessor
from preprocessing.preprocess import (
    process_file, export_model_datasets, load_all_semesters, count_semesters_with_data,
    FINAL_COLUMNS, PROCESSED_DIR, MODEL_DATA_DIR, FINAL_OUTPUT, BY_YEAR_DIR,
)

# Writes each trained model's eval metrics live into MySQL's trained_models
# table (db_io.py already had this function defined, it just was never
# called from here — every training run before this only ever saved to
# training_state.json on disk, so trained_models stayed empty forever).
#
# read_semester_csvs: FIX (2026-09-15) — since preprocess.py's
# export_model_datasets()/build_model_datasets() stopped writing the
# 02-15 model_datasets/*.csv files to disk (out_dir is now always None,
# data lives only in MySQL as per-semester CSV-blob rows — see
# _store_csv_blob() in preprocess.py), the trainers below were still
# doing pd.read_csv() against paths that no longer exist, which is why
# every trained_models row came back with everything NULL except
# model_name/status/error_message/horizon_year/trained_at (the trainer
# raised FileNotFoundError before computing anything else). See
# _dataset_from_table() / _as_df() below and the trainers list further
# down for the fix.
#
# record_training_summary: NEW — writes the same run-level "COMPUTED
# DATA STATISTICS & ANALYSIS ACCURACY" numbers _print_summary() already
# prints to the console into a `training_summary` MySQL table, so that
# info is queryable instead of only living in a log line. See
# _record_training_summary() below; requires the training_summary table
# from create_training_summary_table.sql to exist first.
from util.db_io import (
    record_trained_model, read_semester_csvs, record_training_summary,
    save_model_blob, save_training_state, load_training_state,
)

# PATHS
try:
    from configs.config import ML_MODEL_DIR as MODEL_DIR
except ImportError:
    MODEL_DIR = "Machine_Learning_Model"  # fallback for standalone CLI use

try:
    from configs.config import PROCESSED_BY_YEAR_DIR, MIN_SEMESTERS_FOR_TRAINING
except ImportError:
    PROCESSED_BY_YEAR_DIR = BY_YEAR_DIR
    MIN_SEMESTERS_FOR_TRAINING = 6  # fallback for standalone CLI use

# NOTE: the one-step-back backup feature (Backup/, snapshot_to_backup(),
# restore_from_backup(), clear_backup(), backup_exists()) was removed on
# 2026-09-15 — no more file-based rollback of the most recent upload. If
# your upload route still calls any of those four functions (the
# "delete most recent upload" button), that call site needs updating —
# it wasn't in this file, so it wasn't touched here.
HORIZON_DEFAULT_STEPS = 3   # predict this many years beyond latest data year
# Rule of thumb: don't extrapolate further into the future than the length
# of real history backing the trend. With only `completed` years of actual
# data, a damped-trend line (see forecast_series()) has already run out of
# real signal well before year 5-9 — that's what was producing the
# "flattens out / doesn't predict anything" forecasts. HORIZON_MAX_STEPS
# hard-caps the total horizon so it scales with — and never wildly outruns —
# the data actually backing it.
HORIZON_MIN_STEPS = 3       # always show at least this many forecast years,
                             # even with very little history — matches
                             # ml_analysis.py's _INC_FORECAST_YEARS=3, so
                             # every chart on the shared horizon agrees
                             # with the INC forecast's fixed 3-year window
                             # instead of dropping to 2 while
                             # completed_years is still 1 or 2
HORIZON_MAX_STEPS_FACTOR = 1.0  # cap = completed_years * this factor

# MODEL_DIR is no longer created on disk — trained models are stored as
# MySQL BLOBs now (see _save() below / db_io.save_model_blob()). It's
# kept as a name only because a lot of the trainer code below still
# refers to "MODEL_DIR" in comments/filenames; nothing writes to the
# actual folder anymore.


# HELPERS


def _log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def _save(obj, filename: str):
    """Used to be joblib.dump(obj, os.path.join(MODEL_DIR, filename)) —
    every one of the ~30 call sites below is unchanged, they just now
    land in MySQL's trained_model_files table (keyed by filename)
    instead of a .pkl file on disk. See db_io.save_model_blob()."""
    save_model_blob(filename, obj)
    return filename


def _as_df(source) -> pd.DataFrame:
    """Accept either an already-loaded DataFrame (the normal case now —
    see _dataset_from_table() below) or a legacy on-disk CSV path
    string, and return a DataFrame either way. Lets every trainer
    function below keep its existing `df = _as_df(df_path)`-shaped
    body (just swap in `_as_df(df_path)`) without caring whether the
    thing it was handed came from MySQL or an actual file."""
    if isinstance(source, pd.DataFrame):
        return source.copy()
    return pd.read_csv(source)


def _dataset_from_table(table_name: str) -> pd.DataFrame:
    """Rebuild one of the 02-15 model-dataset CSVs (see preprocess.py's
    FILENAME_TO_TABLE) from MySQL instead of disk.

    FIX (2026-09-15): these datasets used to be flat CSV files under
    Processed_Datasets/model_datasets/. Since build_model_datasets() /
    export_model_datasets() moved to MySQL-only (out_dir=None always),
    each one now lives as one CSV-blob ROW PER SEMESTER in its own
    table (same shape as semester_uploads — see _store_csv_blob() in
    preprocess.py), not a single combined file anywhere. This reads
    every semester's row for `table_name` and concatenates them back
    into one combined DataFrame, matching what the old on-disk CSV
    held. Returns an empty DataFrame if the table doesn't exist yet or
    has no rows (e.g. right after a schema reset) — trainers already
    handle an empty/too-small dataset via their own row-count checks.
    """
    rows = read_semester_csvs(table_name)
    if rows.empty or "csv_file" not in rows.columns:
        return pd.DataFrame()
    frames = [pd.read_csv(io.StringIO(text)) for text in rows["csv_file"].dropna()]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


_LONGFORM_CSV_NAME = "Final_LongForm_Student_Grades.csv"


def _longform_csv_path() -> str:
    return os.path.join(PROCESSED_DIR, _LONGFORM_CSV_NAME)


def _r2(y_true, y_pred) -> float:
    try:
        return round(float(r2_score(y_true, y_pred)), 4)
    except Exception:
        return 0.0


def _mse(y_true, y_pred) -> float:
    try:
        return round(float(mean_squared_error(y_true, y_pred)), 4)
    except Exception:
        return 0.0


def _rmse(y_true, y_pred) -> float:
    try:
        return round(float(mean_squared_error(y_true, y_pred) ** 0.5), 4)
    except Exception:
        return 0.0


def _mae(y_true, y_pred) -> float:
    try:
        return round(float(mean_absolute_error(y_true, y_pred)), 4)
    except Exception:
        return 0.0


def _reg_metrics(y_true, y_pred) -> dict:
    """Standard regressor metric bundle: R^2, RMSE, MSE, MAE."""
    return {
        "r2":   _r2(y_true, y_pred),
        "rmse": _rmse(y_true, y_pred),
        "mse":  _mse(y_true, y_pred),
        "mae":  _mae(y_true, y_pred),
    }


def _accuracy(y_true, y_pred) -> float:
    try:
        return round(float(accuracy_score(y_true, y_pred)), 4)
    except Exception:
        return 0.0


def _f1(y_true, y_pred) -> float:
    try:
        return round(float(f1_score(y_true, y_pred, zero_division=0)), 4)
    except Exception:
        return 0.0


def _clf_metrics(y_true, y_pred) -> dict:
    """Standard classifier metric bundle: Accuracy, F1. Keys are named to
    match ml_eval.js's classifyMetric()/QUALITY table ('accuracy'/'f1'
    substrings), same convention _reg_metrics follows for r2/rmse/mse/mae."""
    return {
        "accuracy": _accuracy(y_true, y_pred),
        "f1":       _f1(y_true, y_pred),
    }



# PREDICTION HORIZON CALCULATOR


def compute_horizon(df: pd.DataFrame,
                    unprocessed_dir: str = "Unprocessed_Datasets") -> dict:
    """
    Returns a dict with:
      latest_year        : "2024-2025"
      latest_year_start  : 2024
      completed_years    : 3     (school years with BOTH sems uploaded)
      horizon_year_start : 2031  (last prediction year start)
      horizon_year       : "2031-2032"
      prediction_years   : ["2025-2026", …, "2031-2032"]
    """
    # ── 1. Find latest year in data ─────────────────────────
    years_in_data = set()
    if "Year" in df.columns:
        for y in df["Year"].dropna().unique():
            m = re.search(r'(\d{4})', str(y))
            if m:
                years_in_data.add(int(m.group(1)))

    latest_start = max(years_in_data) if years_in_data else 2022

    # ── 2. Count completed school years (both sems uploaded) ─
    # A completed school year = files for both sem-1 and sem-2 exist
    uploaded = set()
    if os.path.isdir(unprocessed_dir):
        for fname in os.listdir(unprocessed_dir):
            m = re.match(r'(\d{4})-(\d)', fname)
            if m:
                uploaded.add((int(m.group(1)), int(m.group(2))))

    # Count years where sem 1 AND sem 2 are both present
    all_years = {y for (y, s) in uploaded}
    completed = sum(
        1 for y in all_years
        if (y, 1) in uploaded and (y, 2) in uploaded
    )

    # ── 3. Horizon = latest_start + base_steps + bonus ──────
    # bonus: +1 for each completed year beyond the first
    bonus        = max(0, completed - 1)
    horizon_add  = HORIZON_DEFAULT_STEPS + bonus

    # Hard cap: never extrapolate further out than the real history we
    # have (with a small floor so 1-2 forecast years always show even
    # early on). Previously this was uncapped, e.g. 5 base + 2 bonus = 7
    # forecast years from only 3 years of actual data — the damped trend
    # in forecast_series() had already flattened to near-zero movement
    # well before year 7, which is what made those far-out predictions
    # look flat/meaningless.
    horizon_cap  = max(HORIZON_MIN_STEPS, int(completed * HORIZON_MAX_STEPS_FACTOR))
    horizon_add  = min(horizon_add, horizon_cap)

    horizon_start = latest_start + horizon_add

    prediction_years = [
        f"{latest_start + i + 1}-{latest_start + i + 2}"
        for i in range(horizon_add)
    ]

    return {
        "latest_year"        : f"{latest_start}-{latest_start+1}",
        "latest_year_start"  : latest_start,
        "completed_years"    : completed,
        "bonus_years"        : bonus,
        "horizon_year_start" : horizon_start,
        "horizon_year"       : f"{horizon_start}-{horizon_start+1}",
        "total_steps_forward": horizon_add,
        "prediction_years"   : prediction_years,
    }



# INDIVIDUAL MODEL TRAINERS
#
# ── FINALIZED MODEL CHOICES (restricted-candidate model_comparison.py run —
#    LinearRegression vs RandomForestRegressor only, per project decision to
#    drop Ridge/Lasso/ElasticNet/GradientBoosting/KNN/SVM/LogisticRegression
#    from the candidate pool) ──────────────────────────────────────────────
#   Dataset                             Winner                     Score
#   01_dropout_risk_per_student.csv     LinearRegression           R^2=1.0  ( SUSPICIOUS — see train_dropout_risk, same leakage concern as the old F1=1.0 result)
#   02_dropout_spike_cohort.csv         RandomForestRegressor      R^2=-0.9764  ( UNRELIABLE — std=1.35 across folds, see train_dropout_spike)
#   03_dropout_ranking_college.csv      RandomForestRegressor      R^2=0.0043  ( statistical noise, not a real win — see train_dropout_ranking)
#   04_gwa_ranking_college.csv          LinearRegression           R^2=0.0544 ( needs better features, not a new model)
#   05_gwa_trend_timeseries.csv         LinearRegression           R^2=0.5982 ( down from Ridge's 0.7586 — cost of dropping Ridge from the pool)
#   06_inc_forecast_cohort.csv          RandomForestRegressor      R^2=0.2762  ( UNRELIABLE — std=0.83 across folds; down from Ridge's 0.883, see train_inc_forecast)
#   07_irreg_reg_cohort.csv             RandomForestRegressor      R^2=0.2127  ( UNRELIABLE — std=0.87 across folds; down from Ridge's 0.8476, see train_irreg_reg)
#   08_kpi_gwa_student.csv              LinearRegression           R^2=0.0544 ( needs better features, not a new model)
#   09_kpi_enrollment_college.csv       LinearRegression           R^2=0.8879 ( swapped from RandomForestRegressor — narrowly wins the 2-model comparison, was 0.8925 for RF)
#   10_subject_grade_forecast.csv       LinearRegression           R^2=0.1082 ( down from Ridge's 0.2622 — cost of dropping Ridge from the pool)
#   11_performance_band_dist.csv        RandomForestRegressor      R^2=0.9331 ( up from GradientBoostingRegressor's 0.6224 — clear win, see train_performance_band)
#   12_gender_performance_male.csv,     NOW ADOPTED — see train_gender_performance_male/_female
#   12_gender_performance_female.csv
#     Dropout_Rate: RandomForestRegressor  R^2=0.5801
#     (Avg_GWA was trained here too but never consumed by any chart —
#      removed 2026-08-19, along with the CSV's unused Irregular_Rate col.)
#     Previously NOT ADOPTED (every candidate scored negative R^2 in the
#     unrestricted comparison: best was -0.22 / -0.39). The restricted
#     2-model comparison now shows real signal on both targets — worth
#     training even though nothing consumes these .pkl files yet.
#
#    IMPORTANT — read before trusting these numbers as-is:
#    Restricting the candidate pool to LinearRegression/RandomForestRegressor
#    cost real accuracy on the datasets Ridge used to win (02, 05, 06, 07,
#    10) — Ridge's coefficient shrinkage handled the many correlated
#    College_/Subject_ dummy columns on these small cohort datasets better
#    than plain LinearRegression, and unlike RandomForestRegressor it could
#    still extrapolate a trend into future years instead of flatlining past
#    the training range. 06 and 07 in particular went from R^2=0.88/0.85
#    (reliable, single-split) down to R^2=0.28/0.21 with high fold-to-fold
#    variance (UNRELIABLE per the std flags) — these are the two biggest
#    real losses from this restriction, not just noise like 03.
#
#    02's RandomForestRegressor R^2=-0.9764 is NEGATIVE — worse than just
#    predicting the mean every time — and flagged unreliable on top of
#    that. It's trained below because it's numerically "the winner" of the
#    2-model comparison, but treat this .pkl as a placeholder, not a model
#    you'd want live. Recall this trainer's output isn't even what powers
#    the live chart (see train_dropout_spike below) — the dashboard uses
#    forecast_series() directly, so this mainly matters for consistency/
#    reference and the thesis documentation, not what students see.
#
# ── WHICH TRAINER FEEDS WHICH CHART ─────────────────────────────────────────
#   train_dropout_risk    -> dropout_model.pkl  (LinearRegression)
#       Consumed by: /api/get_dropout_pie  (ml_analysis.py)
#       Chart(s): "Student Status Overview" donuts (Regular/Irregular),
#                 "Male/Female Retention & Risk" donuts
#        R^2=1.0 IS A RED FLAG, NOT A CLEAN WIN — a perfect fit on real
#        student data almost always means an input feature is a restatement
#        of the label. Same suspects as before: "fail_rate" / "is_inc" may
#        be derived from the same dropped/incomplete records used to build
#        "is_drop". Check preprocess.py before trusting the risk scores.
#        Outputs a continuous 0-1 risk score; get_dropout_pie's existing
#        np.clip(np.round(preds), 0, 1) turns it into the 0/1 flag the
#        chart expects — no endpoint changes needed for this swap.
#
#   train_dropout_spike    -> dropout_spike_model.pkl  (RandomForestRegressor)
#       Consumed by: /api/get_dropout_spike
#       Chart(s): "Dropout Trend & Spike Detection" line chart
#        R^2=-0.9764, UNRELIABLE (std=1.35) — see warning above. Live chart
#        uses forecast_series() in ml_analysis.py (per-college linear fit,
#        numpy-only) for the actual dashboard forecast, so this trained
#        model doesn't reach students directly.
#
#   train_dropout_ranking  -> college_dropout_model_final.pkl  (RandomForestRegressor)
#       Consumed by: /api/get_dropout_ranking
#       Chart(s): College dropout ranking (dean/main dashboard ranking view)
#        R^2=0.0043 — needs better features (see docstring), not a model swap.
#
#   train_gwa_ranking      -> gwa_ranking_model_final.pkl  (LinearRegression)
#       Consumed by: /api/get_gwa_ranking_data/<year>
#       Chart(s): "Academic Performance Ranking (GWA)" bar chart
#        R^2=0.054 in FORECAST mode only — historical/real-year mode is
#         unaffected. Predictive-mode note: this endpoint already switches
#         into forecast mode by itself when the requested year is beyond
#         the latest real year.
#
#   train_gwa_trend        -> gwa_trend_model_final.pkl  (LinearRegression)
#       Consumed by: GWA trend / KPI GWA-over-time views
#       Chart(s): GWA trend line (per-college, dean & main dashboards)
#        R^2=0.598, down from Ridge's 0.759 — cost of the restricted pool.
#
#   train_inc_forecast     -> inc_rate_model.pkl  (Ridge)
#       Consumed by: /api/get_inc_forecast (helper: _inc_rate_series)
#       Chart(s): "INC Rate Forecast (Incomplete Grades)" line chart
#        RESTORED 2026-09-15 with Ridge, at College x Course granularity
#        (preprocess.py's "06" block was College-only before, the actual
#        root cause of the old R^2=0.276/UNRELIABLE score — see
#        train_inc_forecast's docstring for the full fix). Model-first,
#        forecast_series() fallback for any College/Course combo not
#        covered in training data.
#
#   train_irreg_reg        -> status_pie_model.pkl  (RandomForestClassifier)
#       Consumed by: /api/get_status_pie (forecast mode)
#       Chart(s): Irregular-rate donut (see train_irreg_reg's own
#        docstring — switched from cohort-level regression to a
#        per-student classifier, accuracy ~0.94). Status Trend's
#        Irregular%/INC% by college/course lines are a SEPARATE chart —
#        see train_status_trend below, added 2026-09-15.
#
#   train_status_trend     -> status_trend_irregular_model.pkl,
#                              status_trend_inc_model.pkl  (Ridge x2)
#       Consumed by: /api/get_status_trend (by=college/course modes)
#       Chart(s): Status Trend — Irregular% line, INC% line
#        NEW 2026-09-15 — this chart had no trainer at all before,
#        forecast_series() was the entire design. Reads the same
#        College x Course "07" table inc_forecast reads.
#
#   train_dropout_combined -> retention_trend_chart_all_dropout_model.pkl
#                              (RandomForestRegressor)
#       Consumed by: /api/get_status_trend (gender='all', Dropped% line)
#       Chart(s): Status Trend — Dropped% (combined, not gender-split)
#        NEW 2026-09-15 — male/female each had a dedicated model already
#        (see train_gender_performance_male/female below), 'all' fell
#        back to forecast_series() until now. Same shape/algorithm as
#        the gender-specific halves, fit on the combined cohort table.
#
#   train_kpi (gwa half)   -> kpi_gwa_model.pkl  (LinearRegression)
#       Consumed by: /api/get_kpi_metrics
#       Chart(s): Dean-dashboard KPI tiles (predicted average GWA)
#        R^2=0.054 — needs better features, not a model swap.
#
#   train_kpi (enroll half)-> kpi_tiles_enrollment_model.pkl  (Ridge)
#       Consumed by: /api/get_kpi_metrics (fallback path only — primary
#        path is _college_enrollment_forecast()'s damped forecast_series()
#        in ml_analysis.py)
#       Chart(s): Dean-dashboard KPI tiles (predicted headcount)
#        FIXED 2026-09-15 — predicts log1p(Headcount) with each college's
#        training target capped at 3x its own historical max, instead of
#        an uncapped straight-line fit on raw Headcount (the old version's
#        "millions of students" bug several years out). Callers must
#        np.expm1() the prediction.
#
#   train_subject_top      -> subject_grade_model.pkl, subject_fail_rate_model.pkl  (Ridge x2)
#       Consumed by: /api/get_subject_forecast, /api/get_hardest_subjects_by_course
#       Chart(s): "Top 5 Hardest Subjects" line charts (main + per-course)
#        RESTORED 2026-09-15 with Ridge (the old RandomForestRegressor
#        couldn't extrapolate past its training years, which is why it
#        was removed 2026-09-06). Subjects with <4 years of history are
#        excluded from training and always use the forecast_series()
#        fallback instead.
#
#   train_performance_band -> performance_band_model.pkl  (RandomForestRegressor)
#       Consumed by: NOTHING YET — no endpoint reads this model.
#       Intended for: a "GWA Distribution" prediction-mode chart, forecasting
#       what % of students land in each performance band (Excellent/Good/
#       Average/Below Average/Failing) per college/year, instead of today's
#       get_gwa_scatter, which only forecasts a single average-GWA line and
#       leaves the scatter dots themselves static in prediction mode.
#       R^2=0.933 — UP from GradientBoostingRegressor's 0.6224, a genuine
#       win for RandomForestRegressor here, not a compromise.
#       Trained but not wired up: a new /api/get_gwa_distribution-style
#       endpoint (in ml_analysis.py) and a matching chart in the frontend
#       are still needed before this actually reaches the dashboard.
#
#   train_gender_performance_male   -> male_gender_dropout_model.pkl (RandomForestRegressor)
#   train_gender_performance_female -> female_gender_dropout_model.pkl (RandomForestRegressor)
#       Trained on 12_gender_performance_male.csv / _female.csv — the old
#       combined 12_gender_performance.csv (Gender as a one-hot feature on
#       one shared model) is now two dedicated per-gender files/models.
#       R^2=0.580 (Dropout_Rate) on the old combined run — previously this
#       dataset was skipped entirely (every candidate
#       scored negative R^2 in the unrestricted comparison).
#       CONSUMED BY: /api/get_status_trend (gender=male|female, single-line
#       mode) — the Dropout_Rate half now powers that endpoint's Dropped%
#       forecast for the "Male/Female Retention Trend" cards, in place of
#       the generic Holt-fit fallback it used to fall back on for every
#       forecast year. (/api/get_gender_status_breakdown stays
#       historical-only by design — unrelated, not changed here.)
# ─────────────────────────────────────────────────────────────────────────


def train_dropout_risk(df_path: str) -> dict:
    """LinearRegression — student-level dropout risk score (continuous).

    Powers: /api/get_dropout_pie -> Student Status / Retention donuts.

    Restricted-candidate model_comparison.py run (LinearRegression vs
    RandomForestRegressor only) shows LinearRegression winning with
    R^2=1.0 on this dataset.

     R^2=1.0 WAS A RED FLAG, NOT A CLEAN WIN — same suspicion as the old
    LogisticRegression F1=1.0 result. A perfect fit on real student data
    almost always means one of the input features is a restatement of
    the label.

    LEAKAGE CHECK (done): pulled preprocess.py's derivation —
        is_inc      = (Grade == 5.0).any()
        is_drop     = (Grade == 0.0).any()
        fail_count  = (Grade >= 3.0).sum()      # includes 5.0 (INC), not 0.0 (drop)
        fail_rate   = fail_count / Sub_Count
    "is_drop"'s grade code (0.0) never falls inside fail_count's >=3.0
    threshold, so fail_rate isn't a literal restatement of is_drop —
    that's the good news. But fail_count DOES double-count INC as a
    "fail", which makes "is_inc" and "fail_rate" redundant with each
    other, and that redundancy alone can be enough to let a linear model
    fit a near-perfect line. FIX: "is_inc" removed from feature_cols
    below. Re-run training and check the new R^2:
        - if it drops to a believable range, the redundancy was the
          cause and the risk scores can be trusted going forward.
        - if R^2 stays near 1.0 even without is_inc, GWA/fail_rate are
          the next things to check — the leak just moved, it didn't
          necessarily go away.

    Outputs a continuous 0-1 risk score; get_dropout_pie's existing
    `np.clip(np.round(preds), 0, 1)` turns it back into the 0/1 flag the
    chart expects — no endpoint changes needed.
    """
    _log("Training dropout_risk model …")
    df = _as_df(df_path)

    # Year_Level_Num encodes 1=1st Year...4=4th Year, -1=Irregular,
    # 0=Unknown (see preprocess.py's parse_year_level()). -1 and 0 are
    # BOTH sentinels, not points on the seniority scale — feeding -1
    # straight into a LinearRegression as if it were "before 1st Year"
    # would distort the ordinal relationship the feature is meant to
    # capture. Irregular status is a different axis (non-standard course
    # load/schedule) than seniority, and it's a real, separately useful
    # signal on its own — registrar data shows Irregular students fail
    # at ~3x the rate of regular 4th-years — so split it into its own
    # binary flag and leave the ordinal column clean.
    df["is_irregular_year"] = (df["Year_Level_Num"] == -1).astype(int)
    df.loc[df["Year_Level_Num"] == -1, "Year_Level_Num"] = np.nan
    df.loc[df["Year_Level_Num"] == 0, "Year_Level_Num"] = np.nan  # Unknown -> also not a real ordinal point

    # 01_dropout_risk_per_student.csv columns match preprocess.py output.
    # "is_inc" is intentionally EXCLUDED here — see leakage-check note
    # above. fail_rate is kept for now since it isn't a literal
    # restatement of is_drop, but re-check it first if R^2 is still
    # suspiciously high after this change.
    feature_cols = ["Gender","College","Semester","Year_Numeric","Sem_Numeric",
                     "GWA","Avg_Grade","Sub_Count","fail_rate",
                     "Year_Level_Num","is_irregular_year"]

    # Drop rows with no label at all — can't train on those regardless.
    df = df.dropna(subset=["is_drop"])

    # Impute:
    #   - numeric grade/rate columns -> median (robust to outliers)
    #   - count-like columns         -> 0 (missing usually means "none logged")
    numeric_median_cols = ["GWA", "Avg_Grade", "fail_rate", "Year_Level_Num"]
    numeric_zero_cols   = ["Sub_Count", "Year_Numeric", "Sem_Numeric",
                            "is_irregular_year"]

    for col in numeric_median_cols:
        if col in df.columns:
            df[col] = df[col].fillna(df[col].median())
    for col in numeric_zero_cols:
        if col in df.columns:
            df[col] = df[col].fillna(0)

    # Categorical columns -> an explicit "Unknown" category rather than
    # silently dropping the row, so a missing Gender/College doesn't
    # shrink your training set.
    for col in ["Gender", "College", "Semester"]:
        if col in df.columns:
            df[col] = df[col].fillna("Unknown")

    X = pd.get_dummies(df[feature_cols], drop_first=False)
    y = df["is_drop"]

    if y.nunique() < 2 or len(df) < 20:
        _log("  [SKIP] Insufficient data for a reliable split.")
        return {"status": "skipped", "reason": "too few samples"}

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    model = LinearRegression()
    model.fit(X_train, y_train)

    y_pred = model.predict(X_test)
    # Continuous 0-1 risk score — get_dropout_pie's np.clip(np.round(...))
    # turns this into the same 0/1 flag it always expected.

    _save(model,              "dropout_pie_model.pkl")
    _save(X.columns.tolist(), "dropout_pie_features.pkl")

    # FIX (2026-09-15): this used to hand-build {"r2":..., "rmse":...}
    # only, unlike every sibling trainer (dropout_spike, gwa_ranking,
    # etc.), which all return **_reg_metrics(...) — the full r2/rmse/
    # mse/mae bundle. That's why trained_models' dropout_risk row only
    # ever had r2_score filled with mse/mae NULL: mae/mse were simply
    # never computed for it. Switched to _reg_metrics() so it matches
    # its siblings.
    return {"status": "ok", **_reg_metrics(y_test, y_pred)}


def train_dropout_spike(df_path: str) -> dict:
    """Ridge — cohort dropout rate trend, scored with real held-out CV.

    Powers: /api/get_dropout_spike -> "Dropout Trend & Spike Detection" chart.

    FIX (2026-09-15): the old version did model.fit(X, y) then
    model.predict(X) — scored on the SAME rows it trained on. That's why
    trained_models showed R^2=0.90 in the DB while the real held-out
    score (from the earlier model_comparison.py run) was R^2=-0.9764 —
    worse than predicting the mean every time. Two changes:
    1. Switched to K-fold cross_val_score so the reported R^2 reflects
       generalization, not memorization.
    2. Model swapped from RandomForestRegressor to Ridge — this dataset
       is small (few years x colleges) and dominated by College dummy
       columns; Ridge's coefficient shrinkage handles that shape far
       better than RF (Ridge scored R^2=0.6347 in the original
       comparison, RF scored -0.9764).
    3. Added a lag feature (each college's own PRIOR year Dropout_Rate)
       plus cohort size when available — trend continuation and cohort
       size are the two strongest real signals for a rate like this.

    Still gated behind the same bar before this can replace the live
    forecast_series() call in ml_analysis.py: it needs to beat both a
    naive average AND forecast_series()'s own output on held-out folds,
    not just be "less negative than before".
    """
    _log("Training dropout_spike model …")
    df = _as_df(df_path)
    if len(df) < 3:
        return {"status": "skipped", "reason": "too few cohort points"}

    df = df.sort_values(["College", "Year_Numeric"]).reset_index(drop=True)
    df["Dropout_Rate_Prev"] = df.groupby("College")["Dropout_Rate"].shift(1)
    df["Dropout_Rate_Prev"] = df["Dropout_Rate_Prev"].fillna(df["Dropout_Rate"].median())

    size_col = next((c for c in ("Total_Students", "Enrollment", "Headcount") if c in df.columns), None)

    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"]       = df["Year_Numeric"]
    X["Dropout_Rate_Prev"]  = df["Dropout_Rate_Prev"]
    if size_col:
        X[size_col] = df[size_col]
    y = df["Dropout_Rate"]

    if len(df) < 10:
        # Too few rows for a meaningful K-fold split — fit on everything
        # but flag the reported score as in-sample only, not a real
        # generalization estimate.
        model = Ridge(alpha=1.0).fit(X, y)
        metrics = _reg_metrics(y, model.predict(X))
        metrics["note"] = "in-sample only -- too few rows for cross-validation"
    else:
        n_splits = min(5, len(df))
        cv = KFold(n_splits=n_splits, shuffle=True, random_state=42)
        cv_scores = cross_val_score(Ridge(alpha=1.0), X, y, cv=cv, scoring="r2")
        model = Ridge(alpha=1.0).fit(X, y)  # final model refit on all data for saving
        metrics = {
            "r2":     round(float(cv_scores.mean()), 4),
            "r2_std": round(float(cv_scores.std()), 4),
            "rmse":   _rmse(y, model.predict(X)),  # in-sample, kept for reference only
            "mse":    _mse(y, model.predict(X)),
            "mae":    _mae(y, model.predict(X)),
        }

    _save(model,              "dropout_trend_chart_model.pkl")
    _save(X.columns.tolist(), "dropout_trend_chart_features.pkl")
    return {"status": "ok", **metrics}


def train_dropout_ranking(df_path: str) -> dict:
    """RandomForestRegressor — college-level dropout ranking.

    Powers: /api/get_dropout_ranking -> college dropout ranking view.

     model_comparison.py results: best model tested (RandomForestRegressor)
    only reached R^2=0.0043 — essentially no predictive power, and only a
    hair above LinearRegression's ~0.0000/0.0001. This is noise, not a
    real win. Switched to RandomForestRegressor anyway since it's
    technically the winner of this run, but don't read anything into it:
    College+Semester dummies alone barely explain any variance in
    individual dropout outcomes. This is NOT a model-choice problem —
    swapping algorithms again won't help. Needs better features — e.g.
    prior-year dropout rate, enrollment size, or average GWA per cohort.
    Treat this endpoint's numbers as provisional until R^2 improves
    meaningfully.
    """
    _log("Training dropout_ranking model …")
    df = _as_df(df_path)

    X = pd.get_dummies(df[["College","Semester"]], drop_first=False)
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["is_drop"]

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42)
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    _save(model,              "college_ranking_chart_model.pkl")
    _save(X.columns.tolist(), "college_ranking_chart_features.pkl")
    return {"status": "ok", **_reg_metrics(y_test, y_pred)}


def train_gwa_ranking(df_path: str) -> dict:
    """LinearRegression — GWA ranking per college.

    Powers: /api/get_gwa_ranking_data/<year> -> "Academic Performance Ranking (GWA)" bar chart.

     model_comparison.py results: R^2=0.055 — weak. Same root cause as
    train_dropout_ranking above: College dummies + Year/Sem alone don't
    explain much GWA variance. This chart's HISTORICAL mode (real
    per-year averages) is fine and unaffected — only the FORECAST mode
    (predicting a future year's ranking via this model) should be treated
    as a rough estimate until richer features are added.
    """
    _log("Training gwa_ranking model …")
    df = _as_df(df_path)
    df = df[(df["GWA"] >= 1.0) & (df["GWA"] <= 5.0)].dropna(subset=["GWA","College","Year_Numeric"])

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few valid GWA rows"}

    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"] = df["Year_Numeric"]
    X["Sem_Numeric"]  = df["Sem_Numeric"]
    y = df["GWA"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = LinearRegression()
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    _save(model,              "gwa_ranking_chart_model.pkl")
    _save(X.columns.tolist(), "gwa_ranking_chart_features.pkl")
    return {"status": "ok", **_reg_metrics(y_test, y_pred)}


def train_gwa_trend(df_path: str) -> dict:
    """LinearRegression — GWA over time per college.

    Powers: GWA trend line chart (per-college, dean & main dashboards).

    Restricted-candidate model_comparison.py run shows LinearRegression
    winning at R^2=0.5982 — down from Ridge's 0.7586, the cost of
    dropping Ridge from the candidate pool on this dataset.
    """
    _log("Training gwa_trend model …")
    df = _as_df(df_path)
    # 05_gwa_trend_timeseries.csv uses Avg_GWA column
    df = df.dropna(subset=["Avg_GWA","College","Year_Numeric"])
    df = df[(df["Avg_GWA"] >= 1.0) & (df["Avg_GWA"] <= 5.0)]

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    X = pd.get_dummies(df[["College"]], drop_first=False)
    X["Year_Numeric"] = df["Year_Numeric"]
    X["Sem_Numeric"]  = df["Sem_Numeric"]
    y = df["Avg_GWA"]

    model = LinearRegression()
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "gwa_trend_chart_model.pkl")
    _save(X.columns.tolist(), "gwa_trend_chart_features.pkl")
    return {"status": "ok", **_reg_metrics(y, y_pred)}


def train_irreg_reg(df_path: str) -> dict:
    """RandomForestClassifier — per-student behaviorally-Irregular flag.

    Powers: /api/get_status_pie -> irregular-rate donut (forecast mode).

    MODEL-TYPE FIX: this used to be a RandomForestRegressor trained on
    07_irreg_reg_cohort.csv's cohort-level Irregular_Rate (a %), scoring
    R^2=0.2127 (fold std 0.87 — UNRELIABLE) and feeding that number
    straight into get_status_pie with no fallback. But "Irregular" is a
    category (a student either is or isn't), not a continuous quantity —
    modeling it as regression on a handful of cohort-aggregate rows was
    the wrong shape for the problem, which is likely WHY the R^2 was so
    weak. The label already exists as a real per-student binary column
    ("is_irregular" — see preprocess.py) inside
    01_dropout_risk_per_student.csv, the SAME file train_dropout_risk
    trains on, so this is switched to a RandomForestClassifier on that
    student-level table instead: get_status_pie can score a real
    population of students (same "advance last year's real cohort by
    one year" pattern get_dropout_pie already uses for its own forecast)
    and count how many come back Irregular, instead of trusting one
    cohort-level percentage.

    "is_inc" / "is_drop" are deliberately EXCLUDED from feature_cols:
    preprocess.py defines is_irregular literally as
    (is_inc == 1) | (is_drop == 1), so including either would be
    training the model to read the label off itself. "fail_rate" is
    excluded too since fail_count folds in Grade==5.0 (INC) and is
    highly redundant with is_inc for the same reason flagged in
    train_dropout_risk's docstring.
    """
    _log("Training irreg_reg model (classifier) …")
    df = _as_df(df_path)

    if len(df) < 20 or "is_irregular" not in df.columns or df["is_irregular"].nunique() < 2:
        _log("  [SKIP] Insufficient data or only one class present.")
        return {"status": "skipped", "reason": "too few samples / one class only"}

    # Same Year_Level_Num sentinel handling as train_dropout_risk (-1 =
    # Irregular course-load classification, 0 = Unknown — neither is a
    # real point on the seniority scale).
    df["is_irregular_year"] = (df["Year_Level_Num"] == -1).astype(int)
    df.loc[df["Year_Level_Num"] == -1, "Year_Level_Num"] = np.nan
    df.loc[df["Year_Level_Num"] == 0, "Year_Level_Num"] = np.nan

    feature_cols = ["Gender", "College", "Semester", "Year_Numeric", "Sem_Numeric",
                     "GWA", "Avg_Grade", "Sub_Count", "Year_Level_Num", "is_irregular_year"]

    numeric_median_cols = ["GWA", "Avg_Grade", "Year_Level_Num"]
    numeric_zero_cols   = ["Sub_Count", "Year_Numeric", "Sem_Numeric", "is_irregular_year"]
    for col in numeric_median_cols:
        if col in df.columns:
            df[col] = df[col].fillna(df[col].median())
    for col in numeric_zero_cols:
        if col in df.columns:
            df[col] = df[col].fillna(0)
    for col in ["Gender", "College", "Semester"]:
        if col in df.columns:
            df[col] = df[col].fillna("Unknown")

    df = df.dropna(subset=["is_irregular"])

    X = pd.get_dummies(df[feature_cols], drop_first=False)
    y = df["is_irregular"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    model = RandomForestClassifier(n_estimators=200, max_depth=6, random_state=42)
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    _save(model,              "status_pie_model.pkl")
    _save(X.columns.tolist(), "status_pie_features.pkl")
    return {"status": "ok", **_clf_metrics(y_test, y_pred)}


def train_kpi(gwa_path: str, enroll_path: str, drop_path: str = None) -> dict:
    """GWA half: LinearRegression | Enrollment half: LinearRegression |
    Drop half: LinearRegression.

    Powers: /api/get_kpi_metrics -> dean-dashboard KPI tiles (predicted GWA,
    headcount, and Total Drop).

    Restricted-candidate model_comparison.py results:
      - GWA half   (08_kpi_gwa_student.csv):        R^2=0.054  -- weak, same
        root cause as train_gwa_ranking/train_dropout_ranking: College
        dummies alone don't explain much GWA variance. NOT swapping model
        here since neither candidate did meaningfully better; needs
        better features, not a different algorithm.
      - Enrollment half (09_kpi_enrollment_college.csv): LinearRegression
        won with R^2=0.8879 -- swapped from RandomForestRegressor
        (previously 0.8925). The gap is small enough to be a wash; picked
        per the comparison's numeric winner.
      - Drop half (15_kpi_drop_college.csv): new, dedicated to this KPI.
        Previously the KPI endpoint borrowed college_dropout_model_final.pkl
        (train_dropout_ranking's model), which predicts a per-STUDENT
        drop probability with near-zero R^2 (~0.004) and was trained for a
        different chart entirely. This half instead predicts the
        per-college/year/sem drop COUNT directly (same shape as the
        Enrollment half), so it's a purpose-built regression rather than a
        borrowed classifier-ish rate applied post-hoc.
    """
    _log("Training kpi models …")
    results = {}

    # GWA model
    df_gwa = _as_df(gwa_path)
    df_gwa = df_gwa[(df_gwa["GWA"] >= 1.0) & (df_gwa["GWA"] <= 5.0)].dropna()
    if len(df_gwa) >= 10:
        X = pd.get_dummies(df_gwa[["College"]], prefix="College")
        X["Year_Numeric"] = df_gwa["Year_Numeric"]
        X["Sem_Numeric"]  = df_gwa["Sem_Numeric"]
        y = df_gwa["GWA"]
        m = LinearRegression().fit(X, y)
        _save(m,               "kpi_tiles_gwa_model.pkl")
        _save(X.columns.tolist(), "kpi_tiles_gwa_features.pkl")
        results["gwa"] = _reg_metrics(y, m.predict(X))
    else:
        results["gwa"] = {"status": "skipped"}

    # Enrollment model
    # FIX (2026-09-15): this used to fit LinearRegression directly on raw
    # Headcount, with no damping and no ceiling anywhere in training --
    # exactly what produced the "millions of students" bug several years
    # out (_college_enrollment_forecast() in ml_analysis.py now bypasses
    # this model for its primary predictions because of that; this model
    # is still used as a last-resort fallback when a college has zero
    # real history at all). Two changes so the fallback itself is safe:
    #   1. Target is log1p(Headcount) instead of raw Headcount, so a
    #      constant-slope Ridge fit in log-space is a DECELERATING curve
    #      in real headcount space, not a straight line.
    #   2. Each college's Headcount is capped at 3x that college's own
    #      historical max BEFORE fitting -- same ceiling
    #      _college_enrollment_forecast() applies at serve time, now
    #      baked into what the model is even allowed to learn from.
    # NOTE: callers must now wrap predictions in np.expm1(...) -- this
    # model predicts log1p(Headcount), not Headcount directly. See the
    # get_kpi_metrics() fallback-path call site in ml_analysis.py.
    df_en = _as_df(enroll_path)
    if len(df_en) >= 3:
        df_en = df_en.sort_values(["College", "Year_Numeric"]).reset_index(drop=True)
        college_max = df_en.groupby("College")["Headcount"].transform("max")
        df_en["Headcount_Capped"] = np.minimum(df_en["Headcount"], college_max * 3)
        df_en["Headcount_Prev"] = df_en.groupby("College")["Headcount"].shift(1)
        df_en["Headcount_Prev"] = df_en["Headcount_Prev"].fillna(df_en["Headcount"].median())

        X = pd.get_dummies(df_en[["College"]], prefix="College")
        X["Year_Numeric"]     = df_en["Year_Numeric"]
        X["Headcount_Prev"]   = df_en["Headcount_Prev"]
        y_log = np.log1p(df_en["Headcount_Capped"])

        m = Ridge(alpha=1.0).fit(X, y_log)
        y_pred_real = np.expm1(m.predict(X))  # back to real headcount scale for reporting

        if len(df_en) >= 10:
            n_splits = min(5, len(df_en))
            cv = KFold(n_splits=n_splits, shuffle=True, random_state=42)
            cv_scores = cross_val_score(Ridge(alpha=1.0), X, y_log, cv=cv, scoring="r2")
            cv_extra = {"r2_cv": round(float(cv_scores.mean()), 4),
                        "r2_cv_std": round(float(cv_scores.std()), 4)}
        else:
            cv_extra = {"note": "in-sample only -- too few rows for cross-validation"}

        _save(m,               "kpi_tiles_enrollment_model.pkl")
        _save(X.columns.tolist(), "kpi_tiles_enrollment_features.pkl")
        results["enrollment"] = {**_reg_metrics(df_en["Headcount"], y_pred_real), **cv_extra}
    else:
        results["enrollment"] = {"status": "skipped"}

    # Total Drop model — dedicated, separate from dropout_ranking's model.
    # FIX (2026-09-15): `drop_path` used to always be a disk path, so
    # `os.path.exists(drop_path)` was a valid "is there anything to
    # load" check. It's now normally a MySQL-loaded DataFrame (see
    # _dataset_from_table() and the trainers list), which os.path.exists
    # can't handle — check for that instead, and still allow the old
    # disk-path behavior too via _as_df().
    df_drop = _as_df(drop_path) if drop_path is not None else pd.DataFrame()
    if not df_drop.empty:
        if len(df_drop) >= 3:
            X = pd.get_dummies(df_drop[["College"]], prefix="College")
            X["Year_Numeric"] = df_drop["Year_Numeric"]
            X["Sem_Numeric"]  = df_drop["Sem_Numeric"]
            y = df_drop["Drop_Count"]
            m = LinearRegression().fit(X, y)
            _save(m,               "kpi_tiles_drop_model.pkl")
            _save(X.columns.tolist(), "kpi_tiles_drop_features.pkl")
            results["drop"] = _reg_metrics(y, m.predict(X))
        else:
            results["drop"] = {"status": "skipped", "reason": "too few rows"}
    else:
        results["drop"] = {"status": "skipped", "reason": "no drop data available"}

    return results


def train_inc_forecast(df_path: str) -> dict:
    """Ridge — INC rate trend, trained at College x Course granularity.

    Powers: /api/get_inc_forecast (helper: _inc_rate_series).

    Dataset: inc_forecast_cohort, now grouped by (Year_Numeric,
    Sem_Numeric, College, Course) — see the 2026-09-15 preprocess.py fix
    to the "06" block. The original trainer for this chart was removed
    2026-09-06 because the dataset was College-only, so every course
    under a college silently got the same forecast. This restores the
    trainer now that the data-layer root cause is fixed.

    Ridge over RandomForest for the same reason as dropout_spike: small,
    College/Course-dummy-heavy dataset where coefficient shrinkage beats
    tree ensembles.
    """
    _log("Training inc_forecast model …")
    df = _as_df(df_path)
    if len(df) < 10 or "Course" not in df.columns:
        return {"status": "skipped", "reason": "too few rows or missing Course column -- apply the preprocess.py dataset-06 fix first"}

    df = df.sort_values(["College", "Course", "Year_Numeric", "Sem_Numeric"]).reset_index(drop=True)
    df["INC_Rate_Prev"] = df.groupby(["College", "Course"])["INC_Rate"].shift(1)
    df["INC_Rate_Prev"] = df["INC_Rate_Prev"].fillna(df["INC_Rate"].median())

    X = pd.get_dummies(df[["College", "Course"]], prefix=["College", "Course"])
    X["Year_Numeric"]  = df["Year_Numeric"]
    X["Sem_Numeric"]   = df["Sem_Numeric"]
    X["INC_Rate_Prev"] = df["INC_Rate_Prev"]
    if "Total_Students" in df.columns:
        X["Total_Students"] = df["Total_Students"]
    y = df["INC_Rate"]

    if len(df) >= 15:
        n_splits = min(5, len(df))
        cv = KFold(n_splits=n_splits, shuffle=True, random_state=42)
        cv_scores = cross_val_score(Ridge(alpha=1.0), X, y, cv=cv, scoring="r2")
        cv_metrics = {"r2_cv": round(float(cv_scores.mean()), 4),
                      "r2_cv_std": round(float(cv_scores.std()), 4)}
    else:
        cv_metrics = {"note": "in-sample only -- too few rows for cross-validation"}

    model = Ridge(alpha=1.0).fit(X, y)
    _save(model,              "inc_rate_model.pkl")
    _save(X.columns.tolist(), "inc_rate_features.pkl")
    return {"status": "ok", **_reg_metrics(y, model.predict(X)), **cv_metrics}


def train_subject_top(df_path: str) -> dict:
    """Ridge — per-subject Avg_Grade and Fail_Rate trend.

    Powers: /api/get_subject_forecast, /api/get_hardest_subjects_by_course.

    Dataset: subject_grade_forecast (already has College/Course/Subject
    granularity in preprocess.py — no data-layer fix needed here, unlike
    inc_forecast). The original trainer was removed 2026-09-06 because
    RandomForestRegressor can't extrapolate past its training years;
    Ridge (a real linear trend) can.

    Subjects with fewer than 4 years of history are dropped from
    training entirely — a 2-3-point "trend" is noise, not signal, and
    those subjects should keep using the forecast_series() fallback
    instead of a memorized non-trend.
    """
    _log("Training subject_top models (Avg_Grade + Fail_Rate) …")
    df = _as_df(df_path)
    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    counts = df.groupby(["College", "Course", "Subject"])["Year_Numeric"].transform("count")
    df = df[counts >= 3].copy()
    if df.empty:
        return {"status": "skipped", "reason": "no subject has >=3 years of history"}

    df = df.sort_values(["College", "Course", "Subject", "Year_Numeric"]).reset_index(drop=True)
    df["Avg_Grade_Prev"] = df.groupby(["College", "Course", "Subject"])["Avg_Grade"].shift(1)
    df["Avg_Grade_Prev"] = df["Avg_Grade_Prev"].fillna(df["Avg_Grade"].median())

    X = pd.get_dummies(df[["College", "Course", "Subject"]],
                        prefix=["College", "Course", "Subject"])
    X["Year_Numeric"]   = df["Year_Numeric"]
    X["Avg_Grade_Prev"] = df["Avg_Grade_Prev"]
    if "Student_Cnt" in df.columns:
        X["Student_Cnt"] = df["Student_Cnt"]

    results = {}

    y_grade = df["Avg_Grade"]
    m_grade = Ridge(alpha=1.0).fit(X, y_grade)
    _save(m_grade,             "subject_grade_model.pkl")
    _save(X.columns.tolist(),  "subject_grade_features.pkl")
    results["avg_grade"] = _reg_metrics(y_grade, m_grade.predict(X))

    if "Fail_Rate" in df.columns:
        y_fail = df["Fail_Rate"]
        m_fail = Ridge(alpha=1.0).fit(X, y_fail)
        _save(m_fail,              "subject_fail_rate_model.pkl")
        _save(X.columns.tolist(),  "subject_fail_rate_features.pkl")
        results["fail_rate"] = _reg_metrics(y_fail, m_fail.predict(X))
    else:
        results["fail_rate"] = {"status": "skipped", "reason": "Fail_Rate column missing"}

    return {"status": "ok", **results}


def train_status_trend(df_path: str) -> dict:
    """Two Ridge models — Irregular_Rate and INC_Rate trend, at
    College x Course granularity.

    Powers: /api/get_status_trend (by=college/course modes, both the
    Irregular% line and the INC% line). New — these charts had no
    trainer at all before; forecast_series() was the entire design.

    Dataset: irreg_reg_cohort, same College x Course table
    train_inc_forecast() reads — INC_Rate is duplicated across that
    table and inc_forecast_cohort by construction, but trained
    separately here so this endpoint's accuracy is visible on its own
    and doesn't silently depend on inc_forecast's model staying in sync.
    """
    _log("Training status_trend models (Irregular_Rate + INC_Rate) …")
    df = _as_df(df_path)
    if len(df) < 10 or "Course" not in df.columns:
        return {"status": "skipped", "reason": "too few rows or missing Course column -- apply the preprocess.py dataset-07 fix first"}

    df = df.sort_values(["College", "Course", "Year_Numeric", "Sem_Numeric"]).reset_index(drop=True)
    df["Irregular_Rate_Prev"] = df.groupby(["College", "Course"])["Irregular_Rate"].shift(1)
    df["Irregular_Rate_Prev"] = df["Irregular_Rate_Prev"].fillna(df["Irregular_Rate"].median())
    df["INC_Rate_Prev"] = df.groupby(["College", "Course"])["INC_Rate"].shift(1)
    df["INC_Rate_Prev"] = df["INC_Rate_Prev"].fillna(df["INC_Rate"].median())

    X_base = pd.get_dummies(df[["College", "Course"]], prefix=["College", "Course"])
    X_base["Year_Numeric"] = df["Year_Numeric"]
    X_base["Sem_Numeric"]  = df["Sem_Numeric"]
    if "Total_Students" in df.columns:
        X_base["Total_Students"] = df["Total_Students"]

    results = {}

    X_irreg = X_base.copy()
    X_irreg["Irregular_Rate_Prev"] = df["Irregular_Rate_Prev"]
    y_irreg = df["Irregular_Rate"]
    m_irreg = Ridge(alpha=1.0).fit(X_irreg, y_irreg)
    _save(m_irreg,                   "status_trend_irregular_model.pkl")
    _save(X_irreg.columns.tolist(),  "status_trend_irregular_features.pkl")
    results["irregular_rate"] = _reg_metrics(y_irreg, m_irreg.predict(X_irreg))

    X_inc = X_base.copy()
    X_inc["INC_Rate_Prev"] = df["INC_Rate_Prev"]
    y_inc = df["INC_Rate"]
    m_inc = Ridge(alpha=1.0).fit(X_inc, y_inc)
    _save(m_inc,                   "status_trend_inc_model.pkl")
    _save(X_inc.columns.tolist(),  "status_trend_inc_features.pkl")
    results["inc_rate"] = _reg_metrics(y_inc, m_inc.predict(X_inc))

    return {"status": "ok", **results}


def train_dropout_combined(df_path: str, enroll_path: str) -> dict:
    """RandomForestRegressor — combined (all-gender) Dropout_Rate trend
    by College. Same shape as _train_gender_half()'s Dropout_Rate half,
    fit on the combined (ungendered) cohort table instead of a
    single-gender split.

    Powers: /api/get_status_trend (gender='all', single-line Dropped%
    mode) — previously the only gender value on this endpoint with no
    dedicated model, since male/female each got one but 'all' fell back
    to forecast_series().

    df_path should be a College x Year_Numeric table with Dropout_Rate
    computed directly from is_drop over ALL students (not a plain
    average of the existing male/female rate columns — that would
    misweight colleges with an uneven gender split).
    """
    _log("Training dropout_combined (status_trend, gender=all) model …")
    df = _as_df(df_path)
    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    # kpi_drop_college only has Drop_Count (no Headcount) -- pull
    # Headcount from kpi_enrollment_college and merge on College+Year
    # to derive the rate.
    if "Dropout_Rate" not in df.columns:
        df_en = _as_df(enroll_path)[["College", "Year_Numeric", "Headcount"]]
        df = df.merge(df_en, on=["College", "Year_Numeric"], how="inner")
        df["Dropout_Rate"] = df["Drop_Count"] / df["Headcount"].replace(0, pd.NA)
        df = df.dropna(subset=["Dropout_Rate"])
        if len(df) < 10:
            return {"status": "skipped", "reason": "too few rows after rate calc"}

    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["Dropout_Rate"]

    model = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42).fit(X, y)

    _save(model,              "retention_trend_chart_all_dropout_model.pkl")
    _save(X.columns.tolist(), "retention_trend_chart_all_dropout_features.pkl")
    return {"status": "ok", **_reg_metrics(y, model.predict(X))}


def train_performance_band(df_path: str) -> dict:
    """RandomForestRegressor — % of students per performance band.

    Dataset: 11_performance_band_dist.csv (previously exported by
    preprocess.py but never trained on or evaluated at all — that's why
    it never showed up in the metrics table).

    Restricted-candidate model_comparison.py run shows RandomForestRegressor
    winning at R^2=0.9331 — a genuine improvement over the earlier
    GradientBoostingRegressor result (R^2=0.6224), not a compromise from
    dropping GradientBoosting. Strongest result across all 12 datasets.

     NOT CONSUMED BY ANY ENDPOINT YET. This trainer produces
    performance_band_model.pkl so it's ready to use, but ml_analysis.py
    has no route that loads it, and no chart calls one. Intended target:
    a "GWA Distribution" prediction-mode chart that forecasts what % of
    students will fall into each band (Excellent/Good/Average/Below
    Average/Failing) per college/year, replacing today's static-dots
    behavior in get_gwa_scatter's prediction mode. Wiring that up needs
    a new endpoint (e.g. /api/get_gwa_distribution_forecast) plus a
    matching chart in the frontend — this trainer alone doesn't change
    anything the dashboard shows.
    """
    _log("Training performance_band model …")
    df = _as_df(df_path)

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    X = pd.get_dummies(df[["College", "Perf_Band"]], prefix=["College", "Band"])
    X["Year_Numeric"] = df["Year_Numeric"]
    X["Sem_Numeric"]  = df["Sem_Numeric"]
    y = df["Pct"]

    model = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42)
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "gwa_distribution_chart_unused_model.pkl")
    _save(X.columns.tolist(), "gwa_distribution_chart_unused_features.pkl")
    return {"status": "ok", **_reg_metrics(y, y_pred)}


def _train_gender_half(df_path: str, gender: str) -> dict:
    """Shared trainer body for ONE gender's cohort file. Dropout_Rate half:
    RandomForestRegressor — same model choice the original combined trainer
    settled on (restricted-candidate run: RandomForestRegressor R^2=0.5801
    for Dropout_Rate), just fit separately per gender now instead of
    with Gender as a one-hot feature on one shared model. Saves
    gender-prefixed .pkl files so male and female each get their own model
    instead of overwriting each other.

    Avg_GWA half removed 2026-08-19: trained a model every run but fed no
    chart, and the source CSV's Avg_GWA column had no other reader either
    — removed end-to-end (preprocess.py column, this training block, the
    .pkl load in ml_analysis.py, and the label map in upload_rotues.py).
    Irregular_Rate was in the same source CSV and equally unread by this
    trainer — dropped from preprocess.py's gender aggregation too.

    INC_Rate half added 2026-08-19: the source CSV already carries an
    INC_Rate column (same preprocess.py student-level aggregation that
    produces Dropout_Rate) but nothing ever trained on it — Dropout_Rate
    alone can't reconstruct the Regular/INC/Dropped 3-way split the
    Retention & Risk donuts need, since INC and Dropped are separate,
    mutually-exclusive buckets. Modeled the same way as Dropout_Rate
    (RandomForestRegressor — same bounded-percentage shape), not folded
    into that call, so its own accuracy is visible on its own card.
    """
    _log(f"Training gender_performance ({gender}) models …")
    df = _as_df(df_path)

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    # Gender is no longer a feature — the file itself is already one
    # gender's data, so College + Year_Numeric are the only real signals.
    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"] = df["Year_Numeric"]

    results = {}
    prefix = gender.lower()  # "male" / "female"

    # Dropout_Rate half
    y_drop = df["Dropout_Rate"]
    m_drop = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42).fit(X, y_drop)
    _save(m_drop,              f"retention_trend_chart_{prefix}_dropout_model.pkl")
    _save(X.columns.tolist(),  f"retention_trend_chart_{prefix}_dropout_features.pkl")
    results["dropout_rate"] = _reg_metrics(y_drop, m_drop.predict(X))

    # INC_Rate half
    if "INC_Rate" in df.columns:
        y_inc = df["INC_Rate"]
        m_inc = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42).fit(X, y_inc)
        _save(m_inc,               f"retention_trend_chart_{prefix}_inc_model.pkl")
        _save(X.columns.tolist(),  f"retention_trend_chart_{prefix}_inc_features.pkl")
        results["inc_rate"] = _reg_metrics(y_inc, m_inc.predict(X))
    else:
        results["inc_rate"] = {"status": "skipped", "reason": "INC_Rate column missing from source CSV"}

    return results


def train_gender_performance_male(df_path: str) -> dict:
    """Male-only half of gender_performance — see _train_gender_half().

    Dataset: 12_gender_performance_male.csv (College x Year, Male
    students only — split out of the old combined
    12_gender_performance.csv so each gender gets its own dedicated
    model instead of sharing one with a Gender dummy feature).

    Consumed by: /api/get_status_trend (gender=male, single-line mode) —
    replaces that endpoint's generic Holt-fit fallback for the "Male
    Retention Trend" card's Dropped% forecast with a real per-gender
    model, now that one exists. (/api/get_gender_status_breakdown stays
    historical-only by design, unrelated to this.)
    """
    return _train_gender_half(df_path, "male")


def train_gender_performance_female(df_path: str) -> dict:
    """Female-only half of gender_performance — see _train_gender_half().

    Dataset: 12_gender_performance_female.csv. Same wiring as
    train_gender_performance_male, mirrored for Female.
    """
    return _train_gender_half(df_path, "female")


def train_year_level_performance(df_path: str) -> dict:
    """5 INDEPENDENT LinearRegression models, one per performance band
    (Excellent/Good/Average/Below Average/Failing), instead of one
    shared model that told bands apart via a Band_X dummy feature.

    REPLACES the 2026-09-04 shared-model design, which was removed
    entirely on 2026-09-06 after being confirmed (by directly testing the
    trained model) to flatline: with only ONE Year_Numeric coefficient
    shared across all 5 bands, every band's raw prediction shifted by
    almost the same amount each year, and get_year_level_gwa_forecast's
    band-mix-to-GWA renormalization step then canceled nearly all of that
    shared shift back out (~0.004 GWA/year over a 12-year test span —
    indistinguishable from flat). Training 5 separate models instead —
    the same "one model per target" pattern that already works for
    train_year_level_inc_irreg's 3 metrics and train_kpi's 3 tiles below
    — gives each band its OWN Year_Numeric coefficient, so genuinely
    different band trends stay genuinely different instead of collapsing
    together. The 5 predictions still get renormalized to sum to 100% in
    get_year_level_gwa_forecast (they're fit independently and won't
    naturally add up), but that renormalization no longer erases the
    trend since each band's slope is real and distinct going in.

    Dataset: 13_year_level_performance.csv (College x Course x
    Year_Level x Perf_Band x Year_Numeric x Sem_Numeric -> Pct).

    Powers: prediction-mode companion to /api/get_year_level_distribution
    ("Performance by Year Level"). Falls back to forecast_series() on
    each year level's own real GWA history (already the case since
    2026-09-06) for any band that's skipped below, or if this trainer
    hasn't run yet at all — see get_year_level_gwa_forecast for that
    fallback logic.
    """
    _log("Training year_level_performance models (5, one per band) …")
    df = _as_df(df_path)

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    bands = ["Excellent", "Good", "Average", "Below Average", "Failing"]
    results = {}

    for band in bands:
        band_df = df[df["Perf_Band"] == band]
        if len(band_df) < 5:
            results[band] = {"status": "skipped", "reason": "too few rows for this band"}
            continue

        X = pd.get_dummies(band_df[["College", "Course"]], prefix=["College", "Course"])
        X["Year_Level_Num"] = band_df["Year_Level_Num"]
        X["Year_Numeric"]   = band_df["Year_Numeric"]
        X["Sem_Numeric"]    = band_df["Sem_Numeric"]
        y = band_df["Pct"]

        model = LinearRegression()
        model.fit(X, y)
        y_pred = model.predict(X)

        band_slug = band.lower().replace(" ", "_")
        _save(model,              f"year_level_perf_{band_slug}_model.pkl")
        _save(X.columns.tolist(), f"year_level_perf_{band_slug}_features.pkl")
        results[band] = {"status": "ok", **_reg_metrics(y, y_pred)}

    return results


def train_year_level_inc_irreg(df_path: str) -> dict:
    """LinearRegression x3 — INC / Irregular(behavioral) / Drop rate, by year level, over time.

    Dataset: 14_year_level_inc_irreg.csv (College x Course x Year_Level x
    Year_Numeric x Sem_Numeric -> INC_Rate, Irregular_Rate, Drop_Rate).
    Trained once per target, same idiom as
    train_gender_performance_male/_female — one model per rate, returned as
    a nested dict so _flatten_metric_block's generic sub-model detection in
    upload_routes.py picks up all three automatically (inc_rate_r2,
    irregular_rate_r2, etc.).

    REPLACED (2026-09-04): this used to be a RandomForestRegressor per
    target, removed from the active trainer list on 2026-08-19 for the same
    extrapolation problem as train_year_level_performance — the Drop_Rate
    model specifically scored R^2=-0.63 (worse than predicting the mean)
    when actually tested on forecasting. Re-built here as LinearRegression
    trend models. Also no longer doubles as the Course x Year-Level Dropout
    Heatmap's accuracy read — that chart now has its own dedicated dataset
    (16) and trainer (train_course_year_level_dropout), so the two charts
    don't share a model.

    Powers: prediction-mode companion to /api/get_year_level_inc_irreg.
    """
    _log("Training year_level_inc_irreg models …")
    df = _as_df(df_path)

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    X = pd.get_dummies(df[["College", "Course"]], prefix=["College", "Course"])
    X["Year_Level_Num"] = df["Year_Level_Num"]
    X["Year_Numeric"]   = df["Year_Numeric"]
    X["Sem_Numeric"]    = df["Sem_Numeric"]

    targets = {
        "inc_rate":       ("INC_Rate",       "year_level_inc_rate_model.pkl",       "year_level_inc_rate_features.pkl"),
        "irregular_rate": ("Irregular_Rate", "year_level_irregular_rate_model.pkl", "year_level_irregular_rate_features.pkl"),
        "drop_rate":      ("Drop_Rate",      "year_level_drop_rate_model.pkl",      "year_level_drop_rate_features.pkl"),
    }

    # BUGFIX (2026-09-05): this loop used to call model.fit(X, y) with no
    # per-target isolation. dict iteration is insertion-ordered, so a
    # single NaN row in Irregular_Rate or Drop_Rate (LinearRegression.fit
    # raises on NaN in y) killed the loop right there -- inc_rate (fit
    # first) would already be saved, but whichever target the exception
    # hit, AND every target after it, never got trained or saved at all.
    # That's exactly why "Irregular" and "Drop" silently stopped loading
    # on the chart while "Inc" kept working: one bad value in an unrelated
    # column was taking down two good ones. Each target now drops its own
    # NaN rows and is wrapped in its own try/except, so a problem with one
    # rate can't prevent the other two from training and saving normally.
    results = {}
    for key, (col, model_file, features_file) in targets.items():
        try:
            sub = df.dropna(subset=[col])
            if len(sub) < 10:
                results[key] = {"status": "skipped", "reason": f"too few valid rows for {col}"}
                continue

            X_sub = X.loc[sub.index]
            y     = sub[col]

            model = LinearRegression()
            model.fit(X_sub, y)
            y_pred = model.predict(X_sub)

            _save(model,                  model_file)
            _save(X_sub.columns.tolist(), features_file)
            results[key] = {"status": "ok", **_reg_metrics(y, y_pred)}
        except Exception as e:
            results[key] = {"status": "error", "error": str(e)}
            _log(f"[year_level_inc_irreg] {key} failed: {e}")

    return results


# ORCHESTRATOR


def run_full_pipeline(new_file: str = None) -> dict:
    """
    Full pipeline:
      1. (optional) preprocess & merge the new file
      2. Train all models
      3. Compute prediction horizon
      4. Save training_state.json
    Returns the training state dict.
    """
    start_time = time.time()
    state = {
        "trained_at"   : datetime.utcnow().isoformat() + "Z",
        "triggered_by" : new_file or "manual",
        "models"       : {},
        "horizon"      : {},
        "errors"       : [],
    }

    # ── Step 1: Preprocess new file into its OWN, standalone semester
    #    folder — nothing gets combined on disk ─────────────────────────
    # process_file() writes this upload into its own folder under
    # by_year/ (see preprocessing.preprocess.write_semester_folder) — it
    # never reads or merges with any other semester's or year's data, not
    # even a different semester of the same academic year. The shared
    # master CSV / model_datasets are only ever rebuilt, wholesale, from
    # ALL semester folders together — see Step 2/3 below — and only once
    # enough distinct years exist to be worth training on.
    if new_file:
        _log(f"Preprocessing new file: {new_file}")
        try:
            new_df = process_file(new_file)
            if new_df.empty:
                raise ValueError("Preprocessor returned empty DataFrame.")

            state["rows_in_file"] = len(new_df)
            _log(f"File processed: {len(new_df):,} student rows saved to its own standalone semester folder")

        except Exception as e:
            state["errors"].append({"step": "preprocess", "error": str(e)})
            _log(f"[ERROR] Preprocess failed: {e}")
            traceback.print_exc()
            _save_state(state)
            return state

    # ── Step 2: Gate training on how many SEMESTERS have data ──────────
    # CHANGED (2026-09-15): this used to gate on count_years_with_data()
    # (distinct academic years) against MIN_YEARS_FOR_TRAINING=3, on the
    # assumption every year contributes exactly 2 semesters. Uploads
    # don't actually land 2-per-year in practice — a year can show up as
    # "collected" off a single semester — so the old gate could let
    # training fire with only 4 or 5 semesters actually uploaded, or
    # (less obviously) also delay it past 6 if some year had 3+ semesters
    # padding the year count without new distinct years. Gating on the
    # raw semester count directly (count_semesters_with_data) is what
    # actually matches "wait for all 6 semesters before training."
    #
    # Below MIN_SEMESTERS_FOR_TRAINING, this upload's own data is already
    # safely saved in its own semester folder (Step 1) — we just don't
    # rebuild the shared master CSV / model_datasets or train anything
    # yet, since the trend-based models need multiple semesters of
    # history to mean anything. Once the threshold is reached, ALL
    # semesters collected so far are combined (in memory only — see
    # load_all_semesters()) and it keeps growing from there; it is never
    # a rolling window that drops old semesters.
    semesters_collected = count_semesters_with_data(PROCESSED_BY_YEAR_DIR)
    state["semesters_collected"] = semesters_collected
    state["semesters_needed"]    = MIN_SEMESTERS_FOR_TRAINING

    if semesters_collected < MIN_SEMESTERS_FOR_TRAINING:
        state["training_status"] = "waiting_for_more_semesters"
        state["elapsed_seconds"] = round(time.time() - start_time, 1)
        _log(
            f"Only {semesters_collected}/{MIN_SEMESTERS_FOR_TRAINING} semesters "
            f"collected — data saved, but skipping training for now."
        )
        _save_state(state)
        return state

    state["training_status"] = "trained"

    # ── Step 3: Rebuild the shared master CSV / long-form CSV / model
    #    datasets from EVERY semester folder together. This is a full,
    #    from-scratch regeneration each time (never an append) —
    #    by_year/ (one standalone folder per semester) is the only
    #    on-disk source of truth these are derived from, per
    #    preprocessing.preprocess.load_all_semesters(). ─────────────────
    master_df, long_df = load_all_semesters(PROCESSED_BY_YEAR_DIR)
    if master_df.empty:
        _log("[ERROR] No data found across semester folders. Aborting training.")
        state["errors"].append({"step": "load", "error": "No data in by_year/ folders."})
        _save_state(state)
        return state

    keep      = [c for c in FINAL_COLUMNS if c in master_df.columns]
    master_df = master_df[keep]
    master_df["GWA"] = pd.to_numeric(master_df["GWA"], errors="coerce").round(2)

    # No longer written to disk (2026-09-15) — master_df/long_df live only
    # in memory here; MySQL (semester_uploads/longform_uploads, already
    # written by write_semester_folder) is the real source of truth. This
    # used to write Final_Merged_Student_Data.csv / Final_LongForm_*.csv
    # to Processed_Datasets/ every training run for no reader that needed
    # them — that was the folder that kept filling up.
    state["rows_in_master"] = len(master_df)
    _log(f"Master data regenerated (in memory) from {semesters_collected} semesters: {len(master_df):,} rows")

    try:
        # out_dir=None: MySQL-only, no more model_datasets/*.csv on disk
        # (was previously passed MODEL_DATA_DIR, writing 16 CSVs to disk
        # on every single training run).
        export_model_datasets(master_df, None, long_df=long_df)
        _log("model_datasets regenerated (MySQL only)")
    except Exception as e:
        state["errors"].append({"step": "export_datasets", "error": str(e)})
        _log(f"[ERROR] Dataset export failed: {e}")
        traceback.print_exc()

    # ── Step 4: Train all models ─────────────────────────────
    # FIX (2026-09-15): trainers used to be handed an f"{md}/NN_....csv"
    # disk path. Since export_model_datasets() above now writes datasets
    # 02-15 to MySQL only (no CSV files land in MODEL_DATA_DIR anymore —
    # see the import comment at the top of this file), every one of
    # those paths pointed at a file that no longer exists, so every
    # trainer below immediately raised FileNotFoundError before
    # computing anything — which is why trained_models rows were coming
    # back with everything NULL except model_name/status/error_message/
    # horizon_year/trained_at. Each dataset is now loaded straight from
    # its MySQL table via _dataset_from_table() (see FILENAME_TO_TABLE
    # in preprocess.py for the file-number -> table-name mapping);
    # dataset 01 was always "student_df itself" (see preprocess.py's "01
    # –" comment) so it's just master_df here, no lookup needed.
    trainers = [
        ("dropout_risk",     lambda: train_dropout_risk(master_df)),
        ("dropout_spike",    lambda: train_dropout_spike(_dataset_from_table("dropout_spike_cohort"))),
        # dropout_combined (gender='all' Dropped% line) ADDED 2026-09-15 —
        # see train_dropout_combined docstring. Swap kpi_drop_college for
        # a dedicated ungendered cohort table if/when one exists; it's
        # used here as-is since it already carries College x Year rows
        # with no gender split.
        ("dropout_combined", lambda: train_dropout_combined(_dataset_from_table("kpi_drop_college"), _dataset_from_table("kpi_enrollment_college"))),
        ("dropout_ranking",  lambda: train_dropout_ranking(_dataset_from_table("dropout_ranking_college"))),
        ("gwa_ranking",      lambda: train_gwa_ranking(_dataset_from_table("gwa_ranking_college"))),
        ("gwa_trend",        lambda: train_gwa_trend(_dataset_from_table("gwa_trend_timeseries"))),
        # inc_forecast (06) RESTORED 2026-09-15 — removed 2026-09-06
        # because inc_rate_chart_model was only ever trained on
        # College-level cohort data, so per-course forecasts silently
        # fell back to one shared baseline and collapsed into each
        # other. preprocess.py's "06" block now groups by College AND
        # Course (root cause fixed), so train_inc_forecast can produce a
        # real per-course model instead of a College-only one.
        ("inc_forecast",     lambda: train_inc_forecast(_dataset_from_table("inc_forecast_cohort"))),
        ("irreg_reg",        lambda: train_irreg_reg(master_df)),
        # status_trend (Irregular%/INC% by college/course) ADDED
        # 2026-09-15 — these charts never had a trainer at all before;
        # forecast_series() was the entire design. Reads the same
        # College x Course "07" table inc_forecast now reads too.
        ("status_trend",     lambda: train_status_trend(_dataset_from_table("irreg_reg_cohort"))),
        ("kpi",              lambda: train_kpi(_dataset_from_table("kpi_gwa_student"), _dataset_from_table("kpi_enrollment_college"), _dataset_from_table("kpi_drop_college"))),
        # subject_grade (10) RESTORED 2026-09-15 — removed 2026-09-06,
        # same story as inc_forecast above: hardest_subjects_chart_model
        # was a RandomForestRegressor that couldn't extrapolate past its
        # training years, so get_subject_forecast/get_hardest_subjects_
        # by_course both already bypassed it in favor of forecast_series()
        # on each subject's own grade history. Restored with Ridge
        # instead (train_subject_top) so it can actually extrapolate.
        ("subject_top",      lambda: train_subject_top(_dataset_from_table("subject_grade_forecast"))),
        ("gender_performance_male",   lambda: train_gender_performance_male(_dataset_from_table("gender_performance_male"))),
        ("gender_performance_female", lambda: train_gender_performance_female(_dataset_from_table("gender_performance_female"))),
        # 12_gender_performance.csv was previously skipped here (every
        # candidate scored negative R^2 in the unrestricted comparison).
        # The restricted LinearRegression/RandomForestRegressor comparison
        # shows real signal on both targets — now trained, and split into
        # a Male file/model pair and a Female file/model pair instead of
        # one combined dataset with a Gender dummy feature. See the
        # finalized model-choices table above for details.
        #
        # year_level_performance's design history (RandomForestRegressor
        # -> shared LinearRegression -> 5 independent per-band
        # LinearRegressions) is documented on train_year_level_performance
        # itself and on its trainers-list entry below, not repeated here.
        #
        # RE-ADDED (2026-09-04): year_level_performance and
        # year_level_inc_irreg were removed on 2026-08-19 as
        # RandomForestRegressors that couldn't extrapolate future years.
        # Re-added here as LinearRegression trend models instead -- same
        # fix pattern already used by train_gwa_trend -- so they can
        # safely power forecasts instead of only fitting historical rows.
        # Each chart also now has its own file (13, 14, 16) and its own
        # model(s); the heatmap no longer reuses year_level_inc_irreg's
        # Drop_Rate eval.
        #
        # year_level_performance (13) RESTORED 2026-09-06 as 5
        # INDEPENDENT per-band LinearRegression models instead of the
        # single shared-model design that was removed earlier the same
        # day for flatlining (see train_year_level_performance's own
        # docstring for the full history: RandomForestRegressor ->
        # shared LinearRegression with a Band_X dummy -> this). Each
        # band now gets its own Year_Numeric coefficient, so
        # get_year_level_gwa_forecast's renormalize-to-100% step no
        # longer cancels out genuinely different band trends. Falls back
        # to forecast_series() per year level (unchanged) if any band's
        # model isn't available yet.
        ("year_level_performance",    lambda: train_year_level_performance(_dataset_from_table("year_level_performance"))),
        #
        # performance_band (dataset 11) stays out: its target chart was
        # never built, so there's nothing to wire it to yet. If that chart
        # gets built, use forecast_series() per band, not a re-trained RF
        # regressor -- it would hit the same extrapolation ceiling.
        ("year_level_inc_irreg",      lambda: train_year_level_inc_irreg(_dataset_from_table("year_level_inc_irreg"))),
        # course_year_level_dropout (16) REMOVED 2026-09-06 — trained but
        # never actually loaded/used anywhere in ml_analysis.py at all
        # (the Course x Year-Level Dropout Heatmap is Recent-Data-only by
        # design, no prediction mode). Also confirmed it's a
        # RandomForestRegressor that flatlines identically for every
        # future year the same way the two removed above did, so it
        # wouldn't have been usable as-is even if wired up later without
        # the same forecast_series()-on-own-history treatment.
    ]

    for name, trainer_fn in trainers:
        try:
            result = trainer_fn()
            state["models"][name] = result
            _log(f"  ✓ {name}: {result}")
        except Exception as e:
            state["models"][name] = {"status": "error", "error": str(e)}
            state["errors"].append({"step": name, "error": str(e)})
            _log(f"  ✗ {name}: {e}")
            traceback.print_exc()

    # ── Step 5: Prediction horizon ────────────────────────────
    state["horizon"] = compute_horizon(master_df)
    _log(f"  Horizon: predict up to {state['horizon']['horizon_year']}")
    _log(f"  Prediction years: {state['horizon']['prediction_years']}")

    # ── Step 4b: Write every model's eval metrics into MySQL's
    #    trained_models table ───────────────────────────────────────────
    # record_trained_model() already existed in db_io.py but was never
    # called anywhere — training_state.json was the only place results
    # ever landed, so trained_models stayed empty even after a full
    # training run. Some trainers (kpi, gender_performance_*,
    # year_level_performance, year_level_inc_irreg) return a NESTED dict
    # (one sub-result per sub-model) instead of a flat metrics dict —
    # each sub-model gets its own row here, named "{model}_{submodel}",
    # same split used for the dashboard cards in upload_rotues.py.
    for name, result in state["models"].items():
        if not isinstance(result, dict):
            continue
        is_nested = any(isinstance(v, dict) for v in result.values())
        sub_results = result.items() if is_nested else [(None, result)]
        for sub_name, sub_result in sub_results:
            if not isinstance(sub_result, dict):
                continue
            row_name = f"{name}_{sub_name}" if sub_name else name
            pkl_path = os.path.join(MODEL_DIR, f"{row_name}.pkl")
            try:
                record_trained_model(
                    model_name     = row_name,
                    algorithm      = sub_result.get("algorithm"),
                    target_column  = sub_result.get("target"),
                    source_dataset = sub_result.get("source_dataset"),
                    file_path      = pkl_path if os.path.exists(pkl_path) else None,
                    status         = sub_result.get("status", "ok" if "error" not in sub_result else "error"),
                    error_message  = sub_result.get("error") or sub_result.get("reason"),
                    r2_score       = sub_result.get("r2"),
                    mse            = sub_result.get("mse"),
                    # FIX (2026-09-15): _reg_metrics() (used by every
                    # regressor trainer) has always computed "rmse", but
                    # nothing here ever read it out and trained_models
                    # had no rmse column to put it in — so it was
                    # computed every run and silently discarded. Added
                    # the column (see create_training_summary_table.sql
                    # note in add_rmse_column.sql) and wired it through.
                    rmse           = sub_result.get("rmse"),
                    mae            = sub_result.get("mae"),
                    accuracy       = sub_result.get("accuracy"),
                    f1_score       = sub_result.get("f1"),
                    horizon_year   = state.get("horizon", {}).get("horizon_year"),
                )
            except Exception as e:
                _log(f"  [WARN] record_trained_model failed for {row_name} (non-fatal): {e}")

    state["elapsed_seconds"] = round(time.time() - start_time, 1)
    _log(f"Pipeline complete in {state['elapsed_seconds']}s")

    _print_summary(master_df, state)

    # ── Step 4c: Write one "total summary of this validation run" row
    #    into MySQL's training_summary table — same numbers
    #    _print_summary() above prints to the console, plus a
    #    trained/errored model rollup, so this run's overall dataset
    #    stats + validation result are queryable later instead of only
    #    ever existing as a log line. Requires the training_summary
    #    table (see create_training_summary_table.sql) to exist.
    _record_training_summary(master_df, state)

    _save_state(state)

    # Hot-reload models in ml_analysis so the running Flask process picks up
    # the new .pkl files immediately — no restart required.
    #
    # NOTE: this used to import from "analysis.ml_analysis", but the actual
    # package is "ml_route" (see app.py: `from ml_route.ml_analysis import
    # ml_bp`). That wrong path meant this call silently failed on every
    # single run — caught by the except below and logged as one easy-to-miss
    # line buried in the training output. The dashboard was only ever
    # getting hot-reloaded by the second, correctly-pathed reload_models()
    # call inside upload_routes.py's _background_train(), which runs after
    # this function returns.
    try:
        from ml_route.ml_analysis import reload_models
        reload_models()
    except Exception as _re:
        _log(f"[auto_train] reload_models skipped: {_re}")

    return state


def _print_summary(master_df: pd.DataFrame, state: dict):
    """
    Console report shown after every full training run — same idea as the
    'COMPUTED DATA STATISTICS & ANALYSIS ACCURACY' summary, adapted to
    NovaSight's real schema (FINAL_COLUMNS: GWA, Gender, is_irregular, ...)
    instead of the standalone script's Grade1/2/3-vs-GWA formula, which
    doesn't apply here — R²/MAE/accuracy below come straight from each
    trainer's own real evaluation in state['models'], not a recomputed
    manual formula.
    """
    total_students = len(master_df)
    gwa = pd.to_numeric(master_df.get("GWA"), errors="coerce")
    gwa_mean, gwa_std = gwa.mean(), gwa.std()
    gwa_min,  gwa_max = gwa.min(),  gwa.max()

    gender_dist = (
        master_df["Gender"].value_counts(normalize=True) * 100
        if "Gender" in master_df.columns else {}
    )

    if "is_irregular" in master_df.columns:
        irregular_pct = pd.to_numeric(master_df["is_irregular"], errors="coerce").mean() * 100
        regular_pct   = 100 - irregular_pct
    else:
        regular_pct = irregular_pct = None

    print("=" * 55)
    print("     COMPUTED DATA STATISTICS & ANALYSIS ACCURACY     ")
    print("=" * 55)
    print(f"Total Student Sample  : {total_students:,}")
    print(f"Mean GWA              : {gwa_mean:.4f} (Std: {gwa_std:.4f})")
    print(f"GWA Range             : {gwa_min:.2f} to {gwa_max:.2f}")
    print(f"Gender Demographics   : Male: {gender_dist.get('Male', 0):.2f}% | Female: {gender_dist.get('Female', 0):.2f}%")
    if regular_pct is not None:
        print(f"Academic Standing     : Regular: {regular_pct:.2f}% | Irregular: {irregular_pct:.2f}%")
    print("-" * 55)
    print("--- ANALYSIS ACCURACY (PER TRAINED MODEL) ---")
    for name, result in state.get("models", {}).items():
        if not isinstance(result, dict) or result.get("status") == "error":
            continue
        parts = []
        if "accuracy" in result: parts.append(f"Accuracy {result['accuracy'] * 100:.2f}%")
        if "r2"       in result: parts.append(f"R² {result['r2']:.4f}")
        if "mae"      in result: parts.append(f"MAE {result['mae']:.4f}")
        if "f1"       in result: parts.append(f"F1 {result['f1']:.4f}")
        if parts:
            print(f"{name:<28}: " + " | ".join(parts))
    print("=" * 55)


def _record_training_summary(master_df: pd.DataFrame, state: dict):
    """Insert one row into MySQL's `training_summary` table — the
    dataset-level stats _print_summary() prints (sample size, GWA
    mean/std/range, gender split, regular/irregular split) plus a
    rollup of this run itself (how many models trained OK vs errored,
    the prediction horizon, overall status, elapsed time). This is the
    "total summary of our validation" table: one row per full training
    run, so it can be queried/charted over time instead of only ever
    being printed to the console or buried per-model in trained_models.
    Non-fatal on failure (e.g. table not created yet) — logged and
    skipped, same pattern as the trained_models write above.
    """
    total_students = len(master_df)
    gwa = pd.to_numeric(master_df.get("GWA"), errors="coerce")

    gender_dist = (
        master_df["Gender"].value_counts(normalize=True) * 100
        if "Gender" in master_df.columns else {}
    )

    if "is_irregular" in master_df.columns:
        irregular_pct = pd.to_numeric(master_df["is_irregular"], errors="coerce").mean() * 100
        regular_pct   = 100 - irregular_pct
    else:
        regular_pct = irregular_pct = None

    models = state.get("models", {})
    models_trained = sum(
        1 for r in models.values()
        if isinstance(r, dict) and r.get("status") != "error"
    )
    models_errored = sum(
        1 for r in models.values()
        if isinstance(r, dict) and r.get("status") == "error"
    )

    def _clean(x):
        """NaN/None -> None so MySQL gets NULL instead of a rejected 'nan'."""
        return None if x is None or (isinstance(x, float) and np.isnan(x)) else float(x)

    try:
        record_training_summary(
            total_students  = total_students,
            gwa_mean        = _clean(gwa.mean())  if not gwa.empty else None,
            gwa_std         = _clean(gwa.std())   if not gwa.empty else None,
            gwa_min         = _clean(gwa.min())   if not gwa.empty else None,
            gwa_max         = _clean(gwa.max())   if not gwa.empty else None,
            male_pct        = _clean(gender_dist.get("Male", 0))   if len(gender_dist) else None,
            female_pct      = _clean(gender_dist.get("Female", 0)) if len(gender_dist) else None,
            regular_pct     = _clean(regular_pct),
            irregular_pct   = _clean(irregular_pct),
            models_trained  = models_trained,
            models_errored  = models_errored,
            horizon_year    = state.get("horizon", {}).get("horizon_year"),
            training_status = state.get("training_status"),
            elapsed_seconds = state.get("elapsed_seconds"),
        )
    except Exception as e:
        _log(f"  [WARN] record_training_summary failed (non-fatal): {e}")


def _save_state(state: dict):
    """Used to write MODEL_DIR/training_state.json; now upserts the same
    dict into MySQL's training_state_kv table. See db_io.save_training_state()."""
    save_training_state(state)
    _log("State saved → training_state_kv (MySQL)")


def load_state() -> dict:
    """Read training_state_kv; return empty dict if not found. Same
    signature/behavior as before, just MySQL-backed instead of reading
    training_state.json off disk."""
    return load_training_state()



# CLI


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Train all AI models after upload")
    parser.add_argument("--new-file", default=None,
                        help="Path to newly uploaded .xlsx file (triggers incremental merge)")
    args = parser.parse_args()

    result = run_full_pipeline(new_file=args.new_file)

    print("\n" + "="*60)
    print("TRAINING COMPLETE")
    print(f"  Models trained : {len(result['models'])}")
    print(f"  Errors         : {len(result['errors'])}")
    print(f"  Horizon        : {result['horizon'].get('horizon_year','—')}")
    print(f"  Predict years  : {result['horizon'].get('prediction_years','—')}")
    if result["errors"]:
        print("\nErrors:")
        for e in result["errors"]:
            print(f"  [{e['step']}] {e['error']}")