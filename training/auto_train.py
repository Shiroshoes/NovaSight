import os
import re
import json
import time
import argparse
import traceback
from datetime import datetime

import pandas as pd
import numpy as np
import joblib

from sklearn.linear_model    import LinearRegression
from sklearn.ensemble        import RandomForestRegressor, RandomForestClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics         import (
    r2_score, mean_squared_error, mean_absolute_error,
    accuracy_score, f1_score,
)

# Import our preprocessor
from preprocessing.preprocess import (
    process_file, export_model_datasets,
    FINAL_COLUMNS, PROCESSED_DIR, MODEL_DATA_DIR, FINAL_OUTPUT,
)

# PATHS
try:
    from configs.config import ML_MODEL_DIR as MODEL_DIR
except ImportError:
    MODEL_DIR = "Machine_Learning_Model"  # fallback for standalone CLI use

STATE_FILE  = os.path.join(MODEL_DIR, "training_state.json")
HORIZON_DEFAULT_STEPS = 3   # predict this many years beyond latest data year
# Rule of thumb: don't extrapolate further into the future than the length
# of real history backing the trend. With only `completed` years of actual
# data, a damped-trend line (see forecast_series()) has already run out of
# real signal well before year 5-9 — that's what was producing the
# "flattens out / doesn't predict anything" forecasts. HORIZON_MAX_STEPS
# hard-caps the total horizon so it scales with — and never wildly outruns —
# the data actually backing it.
HORIZON_MIN_STEPS = 2       # always show at least this many forecast years,
                             # even with very little history
HORIZON_MAX_STEPS_FACTOR = 1.0  # cap = completed_years * this factor

os.makedirs(MODEL_DIR, exist_ok=True)



# HELPERS


def _log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}")


def _save(obj, filename: str):
    path = os.path.join(MODEL_DIR, filename)
    joblib.dump(obj, path)
    return path


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
#   train_inc_forecast     -> inc_rate_model.pkl  (RandomForestRegressor)
#       Consumed by: /api/get_inc_forecast (helper: _inc_rate_series)
#       Chart(s): "INC Rate Forecast (Incomplete Grades)" line chart
#        R^2=0.276, UNRELIABLE (std=0.83) — down from Ridge's 0.883, the
#        single biggest loss from dropping Ridge. Live chart uses
#        forecast_series() in ml_analysis.py (per-college/per-course linear
#        fit, numpy-only) for the actual dashboard forecast, so this
#        trained model doesn't reach students directly either.
#
#   train_irreg_reg        -> status_forest_model.pkl  (RandomForestRegressor)
#       Consumed by: /api/get_status_pie, /api/get_status_by_course
#       Chart(s): Irregular-rate multiline / status-by-course views
#        R^2=0.213, UNRELIABLE (std=0.87) — down from Ridge's 0.848. Unlike
#        dropout_spike/inc_forecast, THIS chart reads the .pkl's predictions
#        directly (no forecast_series() fallback) — worth a closer look
#        before shipping, see caution above.
#
#   train_kpi (gwa half)   -> kpi_gwa_model.pkl  (LinearRegression)
#       Consumed by: /api/get_kpi_metrics
#       Chart(s): Dean-dashboard KPI tiles (predicted average GWA)
#        R^2=0.054 — needs better features, not a model swap.
#
#   train_kpi (enroll half)-> kpi_enrollment_model.pkl  (LinearRegression)
#       Consumed by: /api/get_kpi_metrics
#       Chart(s): Dean-dashboard KPI tiles (predicted headcount)
#        R^2=0.888, narrowly beats RandomForestRegressor's 0.888/0.8925 —
#        swapped from RandomForestRegressor since LinearRegression is now
#        the technical winner of the 2-model comparison; practically a wash.
#
#   train_subject_top      -> subject_grade_model.pkl  (LinearRegression)
#       Consumed by: /api/get_subject_forecast, /api/get_hardest_subjects_by_course
#       Chart(s): "Top 5 Hardest Subjects" line charts (main + per-course)
#        R^2=0.108, down from Ridge's 0.262. Live chart uses
#        forecast_series() in ml_analysis.py (a per-subject linear fit
#        computed on the fly) for the actual dashboard forecast, so this
#        trained model doesn't reach students directly.
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
    df = pd.read_csv(df_path)

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

    return {
        "status": "ok",
        "r2":   _r2(y_test, y_pred),
        "rmse": _rmse(y_test, y_pred),
    }


def train_dropout_spike(df_path: str) -> dict:
    """RandomForestRegressor — cohort dropout rate trend.

    Powers: /api/get_dropout_spike -> "Dropout Trend & Spike Detection" chart.

    Restricted-candidate model_comparison.py run shows RandomForestRegressor
    as the technical "winner" here, but with R^2=-0.9764 and a fold std of
    1.35 — that's WORSE than predicting the mean every time, and flagged
    unreliable on top of it. This is a genuine loss versus the previous
    Ridge model (R^2=0.6347), not a real improvement; Ridge's coefficient
    shrinkage handled the College_ dummy columns on this small dataset far
    better than either LinearRegression or RandomForestRegressor manage.
    Kept as the "winner" here for consistency with the restricted-pool
    decision, but treat this .pkl as a placeholder rather than trustworthy.
    Note: the live chart itself uses forecast_series() in ml_analysis.py
    (a per-college linear fit computed on the fly) for the actual
    dashboard forecast, so this trained model doesn't reach students
    directly — mainly kept for consistency/reference/documentation.
    """
    _log("Training dropout_spike model …")
    df = pd.read_csv(df_path)
    if len(df) < 3:
        return {"status": "skipped", "reason": "too few cohort points"}

    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["Dropout_Rate"]

    model = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42)
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "dropout_trend_chart_model.pkl")
    _save(X.columns.tolist(), "dropout_trend_chart_features.pkl")
    return {"status": "ok", **_reg_metrics(y, y_pred)}


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
    df = pd.read_csv(df_path)

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
    df = pd.read_csv(df_path)
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
    df = pd.read_csv(df_path)
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


def train_inc_forecast(df_path: str) -> dict:
    """RandomForestRegressor — INC rate per college over time.

    Powers: /api/get_inc_forecast -> "INC Rate Forecast (Incomplete Grades)" chart.

    Restricted-candidate model_comparison.py run shows RandomForestRegressor
    as the technical "winner" here, but at R^2=0.2762 with a fold std of
    0.83 (UNRELIABLE) — down sharply from Ridge's R^2=0.883, which was the
    strongest result of all 12 datasets in the original unrestricted run.
    This is the single biggest real loss from restricting the candidate
    pool. Note: the live chart itself uses forecast_series() in
    ml_analysis.py (per-college/per-course linear fit computed on the fly)
    for the actual dashboard forecast, which sidesteps the earlier bug
    where course-level requests had no matching Course_ dummy in this
    model's feature set — so this weaker .pkl doesn't reach students
    directly either.
    """
    _log("Training inc_forecast model …")
    df = pd.read_csv(df_path)

    if len(df) < 3:
        return {"status": "skipped", "reason": "too few cohort points"}

    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["INC_Rate"]

    model = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42)
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "inc_rate_chart_model.pkl")
    _save(X.columns.tolist(), "inc_rate_chart_features.pkl")
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
    df = pd.read_csv(df_path)

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
    df_gwa = pd.read_csv(gwa_path)
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
    df_en = pd.read_csv(enroll_path)
    if len(df_en) >= 3:
        X = pd.get_dummies(df_en[["College"]], prefix="College")
        X["Year_Numeric"] = df_en["Year_Numeric"]
        y = df_en["Headcount"]
        m = LinearRegression().fit(X, y)
        _save(m,               "kpi_tiles_enrollment_model.pkl")
        _save(X.columns.tolist(), "kpi_tiles_enrollment_features.pkl")
        results["enrollment"] = _reg_metrics(y, m.predict(X))
    else:
        results["enrollment"] = {"status": "skipped"}

    # Total Drop model — dedicated, separate from dropout_ranking's model.
    if drop_path and os.path.exists(drop_path):
        df_drop = pd.read_csv(drop_path)
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
        results["drop"] = {"status": "skipped", "reason": "no drop_path provided"}

    return results


def train_subject_top(df_path: str) -> dict:
    """LinearRegression — subject grade forecast.

    Powers: /api/get_subject_forecast, /api/get_hardest_subjects_by_course
    -> "Top 5 Hardest Subjects" line charts.

    Restricted-candidate model_comparison.py run shows LinearRegression
    winning at R^2=0.1082 — down from Ridge's 0.2622, the cost of
    dropping Ridge from the pool. Still meaningfully better than
    RandomForestRegressor, which is what caused the original flat-plateau
    bug: RF can't extrapolate past its training year range, LinearRegression
    can since it's linear. R^2=0.11 means College+Subject dummies only
    explain a modest share of grade variance — consider adding features
    like prior-semester average or enrollment count per subject to
    improve this further.

    Note: the live "Top 5 Hardest Subjects" charts use forecast_series()
    in ml_analysis.py (a per-subject linear fit computed on the fly) for
    the actual dashboard forecast rather than calling this model directly
    — same reasoning as train_inc_forecast above.
    """
    _log("Training subject_grade model …")
    df = pd.read_csv(df_path)

    if len(df) < 20:
        return {"status": "skipped", "reason": "too few aggregated rows"}

    X = pd.get_dummies(df[["College","Subject"]], prefix=["College","Subject"])
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["Avg_Grade"]

    model = LinearRegression()
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "hardest_subjects_chart_model.pkl")
    _save(X.columns.tolist(), "hardest_subjects_chart_features.pkl")
    return {"status": "ok", **_reg_metrics(y, y_pred)}


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
    df = pd.read_csv(df_path)

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
    df = pd.read_csv(df_path)

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
    """RandomForestRegressor — % of students per performance band, by year level.

    Dataset: 13_year_level_performance.csv (College x Course x Year_Level x
    Perf_Band x Year_Numeric x Sem_Numeric -> Pct). Same recipe as
    train_performance_band (dataset 11), which scored R^2=0.9331 on the
    college-level cut of this same shape — Course/Year_Level_Num are just
    added here as extra features rather than a new architecture.

    Powers: prediction-mode companion to /api/get_year_level_distribution
    ("Performance by Year Level"). ml_analysis.py currently forecasts that
    chart on the fly via forecast_series() instead of a trained model —
    wiring get_year_level_gwa_forecast (or a new distribution-forecast
    endpoint) to call this .pkl for forecast years is a follow-up step,
    not done here; this trainer just makes the model + its eval available.
    """
    _log("Training year_level_performance model …")
    df = pd.read_csv(df_path)

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    X = pd.get_dummies(df[["College", "Course", "Perf_Band"]],
                        prefix=["College", "Course", "Band"])
    X["Year_Level_Num"] = df["Year_Level_Num"]
    X["Year_Numeric"]   = df["Year_Numeric"]
    X["Sem_Numeric"]    = df["Sem_Numeric"]
    y = df["Pct"]

    model = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42)
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "year_level_chart_unused_model.pkl")
    _save(X.columns.tolist(), "year_level_chart_unused_features.pkl")
    return {"status": "ok", **_reg_metrics(y, y_pred)}


def train_year_level_inc_irreg(df_path: str) -> dict:
    """RandomForestRegressor x3 — INC / Irregular(behavioral) / Drop rate, by year level.

    Dataset: 14_year_level_inc_irreg.csv (College x Course x Year_Level x
    Year_Numeric x Sem_Numeric -> INC_Rate, Irregular_Rate, Drop_Rate). Same
    recipe as train_irreg_reg (dataset 07's college-level Irregular_Rate),
    with Course/Year_Level_Num added as extra features, trained once per
    target the same way train_gender_performance_male/_female trains its two targets —
    one RandomForestRegressor per rate, returned as a nested dict so
    _flatten_metric_block's generic sub-model detection in upload_routes.py
    picks up all three automatically (inc_rate_r2, irregular_rate_r2, etc.).

    The Drop_Rate half is the same signal behind the Course x Year-Level
    Dropout Heatmap — its eval here doubles as that chart's accuracy read,
    without a separate trainer/dataset needed for the heatmap.

    NOT CONSUMED BY ANY ENDPOINT YET — same status train_performance_band /
    train_gender_performance_male/_female had before being adopted: this produces the
    .pkl files so they're ready to wire in, but
    get_year_level_inc_irreg_forecast and the heatmap endpoint still use
    forecast_series() / real-data-only respectively until a follow-up
    endpoint change swaps them over.
    """
    _log("Training year_level_inc_irreg models …")
    df = pd.read_csv(df_path)

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    X = pd.get_dummies(df[["College", "Course"]], prefix=["College", "Course"])
    X["Year_Level_Num"] = df["Year_Level_Num"]
    X["Year_Numeric"]   = df["Year_Numeric"]
    X["Sem_Numeric"]    = df["Sem_Numeric"]

    targets = {
        "inc_rate":       ("INC_Rate",       "year_level_heatmap_unused_inc_model.pkl",       "year_level_heatmap_unused_inc_features.pkl"),
        "irregular_rate": ("Irregular_Rate", "year_level_heatmap_unused_irregular_model.pkl", "year_level_heatmap_unused_irregular_features.pkl"),
        "drop_rate":      ("Drop_Rate",      "year_level_heatmap_unused_drop_model.pkl",      "year_level_heatmap_unused_drop_features.pkl"),
    }

    results = {}
    for key, (col, model_file, features_file) in targets.items():
        y = df[col]
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42
        ) if len(df) >= 10 else (X, X, y, y)

        model = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42)
        model.fit(X_train, y_train)
        y_pred = model.predict(X_test)

        _save(model,              model_file)
        _save(X.columns.tolist(), features_file)
        results[key] = _reg_metrics(y_test, y_pred)

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

    # ── Step 1: Preprocess new file (if any) ────────────────
    if new_file:
        _log(f"Preprocessing new file: {new_file}")
        try:
            new_df = process_file(new_file)
            if new_df.empty:
                raise ValueError("Preprocessor returned empty DataFrame.")

            # Merge with existing master
            if os.path.exists(FINAL_OUTPUT):
                existing = pd.read_csv(FINAL_OUTPUT)
                merged   = pd.concat([existing, new_df], ignore_index=True)
            else:
                merged = new_df

            merged = merged.drop_duplicates(
                subset=["Student_ID", "Semester", "Year"], keep="last"
            )
            keep   = [c for c in FINAL_COLUMNS if c in merged.columns]
            merged = merged[keep]
            merged["GWA"] = pd.to_numeric(merged["GWA"], errors="coerce").round(2)
            merged.to_csv(FINAL_OUTPUT, index=False)

            export_model_datasets(merged, MODEL_DATA_DIR)
            state["rows_in_master"] = len(merged)
            _log(f"Master CSV updated: {len(merged):,} rows")

        except Exception as e:
            state["errors"].append({"step": "preprocess", "error": str(e)})
            _log(f"[ERROR] Preprocess failed: {e}")
            traceback.print_exc()

    # ── Step 2: Load master CSV ───────────────────────────────
    if not os.path.exists(FINAL_OUTPUT):
        _log("[ERROR] No master CSV found. Aborting training.")
        state["errors"].append({"step": "load", "error": "Master CSV missing."})
        _save_state(state)
        return state

    master_df = pd.read_csv(FINAL_OUTPUT)
    state["rows_in_master"] = state.get("rows_in_master", len(master_df))

    md = MODEL_DATA_DIR   # shorthand

    # ── Step 3: Train all models ─────────────────────────────
    trainers = [
        ("dropout_risk",     lambda: train_dropout_risk(f"{md}/01_dropout_risk_per_student_dropout_pie_status_pie.csv")),
        ("dropout_spike",    lambda: train_dropout_spike(f"{md}/02_dropout_spike_cohort_dropout_trend_chart.csv")),
        ("dropout_ranking",  lambda: train_dropout_ranking(f"{md}/03_dropout_ranking_college_college_ranking_chart.csv")),
        ("gwa_ranking",      lambda: train_gwa_ranking(f"{md}/04_gwa_ranking_college_gwa_ranking_chart.csv")),
        ("gwa_trend",        lambda: train_gwa_trend(f"{md}/05_gwa_trend_timeseries_gwa_trend_chart.csv")),
        ("inc_forecast",     lambda: train_inc_forecast(f"{md}/06_inc_forecast_cohort_inc_rate_chart.csv")),
        ("irreg_reg",        lambda: train_irreg_reg(f"{md}/01_dropout_risk_per_student_dropout_pie_status_pie.csv")),
        ("kpi",              lambda: train_kpi(f"{md}/08_kpi_gwa_student_kpi_tiles.csv", f"{md}/09_kpi_enrollment_college_kpi_tiles.csv", f"{md}/15_kpi_drop_college_kpi_tiles.csv")),
        ("subject_grade",    lambda: train_subject_top(f"{md}/10_subject_grade_forecast_hardest_subjects_chart.csv")),
        ("gender_performance_male",   lambda: train_gender_performance_male(f"{md}/12_gender_performance_male_retention_trend_chart.csv")),
        ("gender_performance_female", lambda: train_gender_performance_female(f"{md}/12_gender_performance_female_retention_trend_chart.csv")),
        # 12_gender_performance.csv was previously skipped here (every
        # candidate scored negative R^2 in the unrestricted comparison).
        # The restricted LinearRegression/RandomForestRegressor comparison
        # shows real signal on both targets — now trained, and split into
        # a Male file/model pair and a Female file/model pair instead of
        # one combined dataset with a Gender dummy feature. See the
        # finalized model-choices table above for details.
        #
        # REMOVED (2026-08-19): performance_band, year_level_performance,
        # and year_level_inc_irreg used to train here. All three were
        # RandomForestRegressor models whose whole job was to power a
        # FUTURE-YEAR forecast — but RandomForestRegressor cannot
        # extrapolate past the years it was trained on (see the bug #1
        # writeup in forecast_series()'s docstring above — this is the
        # exact same failure mode that was already hit and fixed once for
        # the subject-grade forecast). Their strong-looking R^2 scores
        # only measured fit on HISTORICAL rows, not forecasting skill,
        # which is the one thing they were trained for.
        #   - year_level_inc_irreg was additionally proven actively bad
        #     (Drop_Rate R^2 = -0.63, worse than predicting the mean) AND
        #     fully redundant: /api/get_year_level_inc_irreg_forecast
        #     already forecasts all three rates live via forecast_series(),
        #     which the RF model never fed.
        #   - year_level_performance's target (/api/get_year_level_distribution)
        #     had no forecast branch at all — see ml_analysis.py, which
        #     now forecasts per-band % there with forecast_series() instead
        #     of ever loading this model.
        #   - performance_band's target chart (a "GWA Distribution"
        #     prediction-mode view) was never built. If that chart gets
        #     built later, use forecast_series() per band the same way,
        #     not a re-trained RF regressor — it will hit the same
        #     extrapolation ceiling.
        # If reviving any of these, don't just re-add the lambda: swap the
        # trainer to fit a per-series trend (like train_gwa_trend /
        # forecast_series) instead of a scikit RandomForestRegressor.
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

    # ── Step 4: Prediction horizon ────────────────────────────
    state["horizon"] = compute_horizon(master_df)
    _log(f"  Horizon: predict up to {state['horizon']['horizon_year']}")
    _log(f"  Prediction years: {state['horizon']['prediction_years']}")

    state["elapsed_seconds"] = round(time.time() - start_time, 1)
    _log(f"Pipeline complete in {state['elapsed_seconds']}s")

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


def _save_state(state: dict):
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)
    _log(f"State saved → {STATE_FILE}")


def load_state() -> dict:
    """Read training_state.json; return empty dict if not found."""
    if os.path.exists(STATE_FILE):
        with open(STATE_FILE) as f:
            return json.load(f)
    return {}



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