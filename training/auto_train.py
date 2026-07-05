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
from sklearn.metrics         import (
    r2_score, mean_squared_error, accuracy_score,
    f1_score,
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


def _f1(y_true, y_pred_class) -> float:
    try:
        return round(float(f1_score(y_true, y_pred_class, zero_division=0)), 4)
    except Exception:
        return 0.0



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


def train_dropout_risk(df_path: str) -> dict:
    """RandomForest — student-level dropout probability."""
    _log("Training dropout_risk model …")
    df = pd.read_csv(df_path)

    # 01_dropout_risk_per_student.csv columns match preprocess.py output
    X = pd.get_dummies(
        df[["Gender","College","Semester","Year_Numeric","Sem_Numeric",
            "GWA","Avg_Grade","Sub_Count","is_inc","fail_rate"]],
        drop_first=False
    )
    y = df["is_drop"]

    if y.nunique() < 2 or len(df) < 20:
        _log("  [SKIP] Insufficient data for stratified split.")
        return {"status": "skipped", "reason": "too few samples"}

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    model = RandomForestRegressor(n_estimators=200, random_state=42)
    model.fit(X_train, y_train)

    y_pred_raw   = np.clip(model.predict(X_test), 0, 1)
    y_pred_class = (y_pred_raw >= 0.5).astype(int)

    _save(model,              "dropout_model.pkl")
    _save(X.columns.tolist(), "dropout_features.pkl")

    return {
        "status"  : "ok",
        "f1_score": _f1(y_test, y_pred_class),
        "accuracy": round(float(accuracy_score(y_test, y_pred_class)), 4),
    }


def train_dropout_spike(df_path: str) -> dict:
    """LinearRegression — cohort dropout rate trend."""
    _log("Training dropout_spike model …")
    df = pd.read_csv(df_path)
    if len(df) < 3:
        return {"status": "skipped", "reason": "too few cohort points"}

    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["Dropout_Rate"]

    model = LinearRegression()
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "dropout_spike_model.pkl")
    _save(X.columns.tolist(), "dropout_spike_features.pkl")
    return {"status":"ok", "r2": _r2(y, y_pred), "rmse": _rmse(y, y_pred)}


def train_dropout_ranking(df_path: str) -> dict:
    """LinearRegression — college-level dropout ranking."""
    _log("Training dropout_ranking model …")
    df = pd.read_csv(df_path)

    X = pd.get_dummies(df[["College","Semester"]], drop_first=False)
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["is_drop"]

    if len(df) < 10:
        return {"status": "skipped", "reason": "too few rows"}

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)
    model = LinearRegression()
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    _save(model,              "college_dropout_model_final.pkl")
    _save(X.columns.tolist(), "dropout_ranking_features_final.pkl")
    return {"status":"ok", "r2": _r2(y_test, y_pred), "rmse": _rmse(y_test, y_pred)}


def train_gwa_ranking(df_path: str) -> dict:
    """LinearRegression — GWA ranking per college."""
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
    return {"status":"ok", "r2": _r2(y_test, y_pred), "rmse": _rmse(y_test, y_pred)}


def train_gwa_trend(df_path: str) -> dict:
    """LinearRegression — GWA over time per college."""
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
    return {"status":"ok", "r2": _r2(y, y_pred), "rmse": _rmse(y, y_pred)}


def train_inc_forecast(df_path: str) -> dict:
    """LinearRegression — INC rate per college over time."""
    _log("Training inc_forecast model …")
    df = pd.read_csv(df_path)

    if len(df) < 3:
        return {"status": "skipped", "reason": "too few cohort points"}

    X = pd.get_dummies(df[["College"]], prefix="College")
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["INC_Rate"]

    model = LinearRegression()
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "inc_rate_model.pkl")
    _save(X.columns.tolist(), "inc_rate_features.pkl")
    return {"status":"ok", "r2": _r2(y, y_pred), "rmse": _rmse(y, y_pred)}


def train_irreg_reg(df_path: str) -> dict:
    """LinearRegression — Irregular student rate per cohort."""
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

    model = LinearRegression()
    model.fit(X_train, y_train)
    y_pred = model.predict(X_test)

    _save(model,              "status_forest_model.pkl")
    _save(X.columns.tolist(), "status_forest_features.pkl")
    return {"status":"ok", "r2": _r2(y_test, y_pred), "rmse": _rmse(y_test, y_pred)}


def train_kpi(gwa_path: str, enroll_path: str) -> dict:
    """LinearRegression — GWA predictor + enrollment forecaster."""
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
        results["gwa"] = {"r2": _r2(y, m.predict(X)), "rmse": _rmse(y, m.predict(X))}
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
        results["enrollment"] = {"r2": _r2(y, m.predict(X))}
    else:
        results["enrollment"] = {"status": "skipped"}

    return results


def train_subject_top(df_path: str) -> dict:
    """RandomForest — subject grade forecast."""
    _log("Training subject_grade model …")
    df = pd.read_csv(df_path)

    if len(df) < 20:
        return {"status": "skipped", "reason": "too few aggregated rows"}

    X = pd.get_dummies(df[["College","Subject"]], prefix=["College","Subject"])
    X["Year_Numeric"] = df["Year_Numeric"]
    y = df["Avg_Grade"]

    model = RandomForestRegressor(n_estimators=100, random_state=42)
    model.fit(X, y)
    y_pred = model.predict(X)

    _save(model,              "subject_grade_model.pkl")
    _save(X.columns.tolist(), "subject_grade_features.pkl")
    return {"status":"ok", "r2": _r2(y, y_pred)}



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