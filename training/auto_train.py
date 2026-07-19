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
from sklearn.ensemble        import RandomForestRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics         import r2_score, mean_squared_error, mean_absolute_error

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
HORIZON_DEFAULT_STEPS = 5   # predict this many years beyond latest data year

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
#   12_gender_performance.csv           NOW ADOPTED — see train_gender_performance
#     Dropout_Rate: RandomForestRegressor  R^2=0.5801
#     Avg_GWA:      LinearRegression       R^2=0.3618
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
#   train_gender_performance -> gender_dropout_model.pkl (RandomForestRegressor),
#                                gender_gwa_model.pkl (LinearRegression)
#       Consumed by: NOTHING YET — no endpoint reads either model.
#       R^2=0.580 (Dropout_Rate) / 0.362 (Avg_GWA) — previously this dataset
#       was skipped entirely (every candidate scored negative R^2 in the
#       unrestricted comparison). Worth training now; see docstring.
#       Intended for: real per-gender forecasts on the "Male/Female
#       Retention Trend" cards, which currently fall back to a generic
#       Holt-fit trend (/api/get_status_trend&gender=) in Prediction mode
#       because /api/get_gender_status_breakdown is historical-only.
# ─────────────────────────────────────────────────────────────────────────


def train_dropout_risk(df_path: str) -> dict:
    """LinearRegression — student-level dropout risk score (continuous).

    Powers: /api/get_dropout_pie -> Student Status / Retention donuts.

    Restricted-candidate model_comparison.py run (LinearRegression vs
    RandomForestRegressor only) shows LinearRegression winning with
    R^2=1.0 on this dataset.

     R^2=1.0 IS A RED FLAG, NOT A CLEAN WIN — same suspicion as the old
    LogisticRegression F1=1.0 result. A perfect fit on real student data
    almost always means one of the input features is a restatement of
    the label. Prime suspects here: "fail_rate" and "is_inc" — if either
    is computed FROM the same dropped/incomplete subject records used to
    build "is_drop", the model is just reading the answer off a reworded
    copy of itself. Before trusting this model's risk scores in production:
        1. Check preprocess.py for how fail_rate/is_inc/is_drop are each
           derived — do any of them share a source column/condition?
        2. Retrain with the suspect column dropped and see if R^2 drops
           to a believable range.
        3. Only then treat the dropout-risk donut's numbers as real.

    Outputs a continuous 0-1 risk score; get_dropout_pie's existing
    `np.clip(np.round(preds), 0, 1)` turns it back into the 0/1 flag the
    chart expects — no endpoint changes needed.
    """
    _log("Training dropout_risk model …")
    df = pd.read_csv(df_path)

    # 01_dropout_risk_per_student.csv columns match preprocess.py output
    feature_cols = ["Gender","College","Semester","Year_Numeric","Sem_Numeric",
                     "GWA","Avg_Grade","Sub_Count","is_inc","fail_rate"]

    # Drop rows with no label at all — can't train on those regardless.
    df = df.dropna(subset=["is_drop"])

    # Impute:
    #   - numeric grade/rate columns -> median (robust to outliers)
    #   - count-like columns         -> 0 (missing usually means "none logged")
    numeric_median_cols = ["GWA", "Avg_Grade", "fail_rate"]
    numeric_zero_cols   = ["Sub_Count", "is_inc", "Year_Numeric", "Sem_Numeric"]

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

    _save(model,              "dropout_model.pkl")
    _save(X.columns.tolist(), "dropout_features.pkl")

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

    _save(model,              "dropout_spike_model.pkl")
    _save(X.columns.tolist(), "dropout_spike_features.pkl")
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

    _save(model,              "college_dropout_model_final.pkl")
    _save(X.columns.tolist(), "dropout_ranking_features_final.pkl")
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

    _save(model,              "gwa_ranking_model_final.pkl")
    _save(X.columns.tolist(), "gwa_ranking_features_final.pkl")
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

    _save(model,              "gwa_trend_model_final.pkl")
    _save(X.columns.tolist(), "gwa_trend_features.pkl")
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

    _save(model,              "inc_rate_model.pkl")
    _save(X.columns.tolist(), "inc_rate_features.pkl")
    return {"status": "ok", **_reg_metrics(y, y_pred)}


def train_irreg_reg(df_path: str) -> dict:
    """RandomForestRegressor — Irregular student rate per cohort.

    Powers: /api/get_status_pie, /api/get_status_by_course -> irregular-rate views.

    Restricted-candidate model_comparison.py run shows RandomForestRegressor
    winning at R^2=0.2127 with a fold std of 0.87 (UNRELIABLE) — down
    sharply from Ridge's R^2=0.8476. UNLIKE dropout_spike/inc_forecast,
    this endpoint reads the .pkl's predictions directly rather than
    falling back to forecast_series(), so this drop in reliability is
    worth flagging before shipping — consider re-adding Ridge to the
    candidate pool for this dataset specifically if the numbers on the
    live chart look off.
    """
    _log("Training irreg_reg model …")
    df = pd.read_csv(df_path)

    if len(df) < 5:
        return {"status": "skipped", "reason": "too few cohort rows"}

    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"] = df["Year_Numeric"]
    X["Sem_Numeric"]  = df["Sem_Numeric"]
    y = df["Irregular_Rate"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42
    ) if len(df) >= 10 else (X, X, y, y)

    model = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42)
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    _save(model,              "status_forest_model.pkl")
    _save(X.columns.tolist(), "status_forest_features.pkl")
    return {"status": "ok", **_reg_metrics(y_test, y_pred)}


def train_kpi(gwa_path: str, enroll_path: str) -> dict:
    """GWA half: LinearRegression | Enrollment half: LinearRegression.

    Powers: /api/get_kpi_metrics -> dean-dashboard KPI tiles (predicted GWA & headcount).

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
        _save(m,               "kpi_gwa_model.pkl")
        _save(X.columns.tolist(), "kpi_gwa_features.pkl")
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
        _save(m,               "kpi_enrollment_model.pkl")
        _save(X.columns.tolist(), "kpi_enrollment_features.pkl")
        results["enrollment"] = _reg_metrics(y, m.predict(X))
    else:
        results["enrollment"] = {"status": "skipped"}

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

    _save(model,              "subject_grade_model.pkl")
    _save(X.columns.tolist(), "subject_grade_features.pkl")
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

    _save(model,              "performance_band_model.pkl")
    _save(X.columns.tolist(), "performance_band_features.pkl")
    return {"status": "ok", **_reg_metrics(y, y_pred)}


def train_gender_performance(df_path: str) -> dict:
    """Dropout_Rate half: RandomForestRegressor | Avg_GWA half: LinearRegression.

    Dataset: 12_gender_performance.csv — cohort-level (College x Gender x
    Year) dropout rate and average GWA.

    Previously NOT ADOPTED: in the original unrestricted model_comparison.py
    run, every candidate model scored negative R^2 on both targets (best
    was R^2=-0.22 for Dropout_Rate, -0.39 for Avg_GWA) — not enough signal
    to train on, so no .pkl was ever produced for this dataset.

    The restricted-candidate run (LinearRegression vs RandomForestRegressor
    only) shows real predictive power on both targets:
      - Dropout_Rate: RandomForestRegressor won, R^2=0.5801
      - Avg_GWA:      LinearRegression won,      R^2=0.3618
    Worth adopting now.

     NOT CONSUMED BY ANY ENDPOINT YET. mode-toggle.js's
    _renderRetentionCharts currently swaps to a generic Holt-fit trend
    (/api/get_status_trend, filtered by &gender=) for the "Male/Female
    Retention Trend" cards in Prediction mode, specifically because
    /api/get_gender_status_breakdown is historical-only. These two models
    are the prerequisite for a genuine per-gender forecast — wiring that
    up needs a new endpoint in ml_analysis.py plus a small addition to
    upload_routes.py's _flatten_metric_block() to recognize this
    trainer's nested result shape (same pattern as train_kpi's
    'gwa'/'enrollment' sub-keys).
    """
    _log("Training gender_performance models …")
    df = pd.read_csv(df_path)

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    X = pd.get_dummies(df[["College", "Gender_Label"]], prefix=["College", "Gender"])
    X["Year_Numeric"] = df["Year_Numeric"]

    results = {}

    # Dropout_Rate half — RandomForestRegressor won (R^2=0.5801)
    y_drop = df["Dropout_Rate"]
    m_drop = RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42).fit(X, y_drop)
    _save(m_drop,              "gender_dropout_model.pkl")
    _save(X.columns.tolist(),  "gender_dropout_features.pkl")
    results["dropout_rate"] = _reg_metrics(y_drop, m_drop.predict(X))

    # Avg_GWA half — LinearRegression won (R^2=0.3618)
    y_gwa = df["Avg_GWA"]
    m_gwa = LinearRegression().fit(X, y_gwa)
    _save(m_gwa,               "gender_gwa_model.pkl")
    _save(X.columns.tolist(),  "gender_gwa_features.pkl")
    results["avg_gwa"] = _reg_metrics(y_gwa, m_gwa.predict(X))

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
        ("dropout_risk",     lambda: train_dropout_risk(f"{md}/01_dropout_risk_per_student.csv")),
        ("dropout_spike",    lambda: train_dropout_spike(f"{md}/02_dropout_spike_cohort.csv")),
        ("dropout_ranking",  lambda: train_dropout_ranking(f"{md}/03_dropout_ranking_college.csv")),
        ("gwa_ranking",      lambda: train_gwa_ranking(f"{md}/04_gwa_ranking_college.csv")),
        ("gwa_trend",        lambda: train_gwa_trend(f"{md}/05_gwa_trend_timeseries.csv")),
        ("inc_forecast",     lambda: train_inc_forecast(f"{md}/06_inc_forecast_cohort.csv")),
        ("irreg_reg",        lambda: train_irreg_reg(f"{md}/07_irreg_reg_cohort.csv")),
        ("kpi",              lambda: train_kpi(f"{md}/08_kpi_gwa_student.csv", f"{md}/09_kpi_enrollment_college.csv")),
        ("subject_grade",    lambda: train_subject_top(f"{md}/10_subject_grade_forecast.csv")),
        ("performance_band", lambda: train_performance_band(f"{md}/11_performance_band_dist.csv")),
        ("gender_performance", lambda: train_gender_performance(f"{md}/12_gender_performance.csv")),
        # 12_gender_performance.csv was previously skipped here (every
        # candidate scored negative R^2 in the unrestricted comparison).
        # The restricted LinearRegression/RandomForestRegressor comparison
        # shows real signal on both targets — now trained. See the
        # finalized model-choices table above for details.
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