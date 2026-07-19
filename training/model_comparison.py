"""
model_comparison.py
====================
Compares multiple candidate ML models on EACH of NovaSight's 12 training
datasets (including 11 and 12, which were previously exported by
preprocess.py but never evaluated or trained on), so you can see
side-by-side which model performs best per chart before committing to one
in auto_train.py.

Metrics used (matches your evaluation-metrics slide):
  Regression problems     -> MAE, MSE, RMSE, R^2
  Classification problems -> Accuracy, Precision, Recall, F1, Confusion Matrix

Candidate models compared per problem type (restricted set):
  Regression     -> LinearRegression, RandomForestRegressor
  Classification -> LogisticRegression, RandomForestClassifier

HOW TO RUN
----------
    python model_comparison.py

Reads the same CSVs from MODEL_DATASETS_DIR that auto_train.py trains on.
Writes a full results table to model_comparison_results.csv and prints a
readable summary to the console. Safe to run repeatedly — it never
overwrites your actual .pkl models, this is read-only evaluation.
"""

import os
import warnings
import numpy as np
import pandas as pd

from sklearn.model_selection import train_test_split, KFold, cross_val_score
from sklearn.linear_model import LinearRegression, LogisticRegression
from sklearn.ensemble import RandomForestRegressor, RandomForestClassifier
from sklearn.metrics import (
    mean_absolute_error, mean_squared_error, r2_score,
    accuracy_score, precision_score, recall_score, f1_score, confusion_matrix,
)

from configs.config import MODEL_DATASETS_DIR

warnings.filterwarnings("ignore")

RESULTS = []  # collected rows for the final CSV/summary


# ── shared evaluators ────────────────────────────────────────────────────────
def evaluate_regressors(X, y, dataset_name: str, chart_name: str):
    """
    Runs LinearRegression and RandomForestRegressor, and reports
    MAE / MSE / RMSE / R^2 for each.

    SMALL DATASETS (< 40 rows — most of your cohort/college-level files)
    use K-fold cross-validation instead of one train_test_split. A single
    80/20 split on ~10 rows leaves a 1-3 row test set, where R^2 is close
    to meaningless — one unlucky row can swing it from +0.9 to -2.0 with
    nothing about the model actually changing (this is exactly what
    happened between your two comparison runs on 02/09/10). Averaging
    R^2 across several folds gives a far more trustworthy number.

    LARGER DATASETS (>= 40 rows) keep the original single-split approach,
    since cross-validation adds little value once there's enough data for
    one held-out set to be representative.
    """
    if len(X) < 10:
        print(f"  [skip] {dataset_name}: only {len(X)} rows, too few to evaluate reliably.")
        return

    candidates = {
        "LinearRegression":      LinearRegression(),
        "RandomForestRegressor": RandomForestRegressor(n_estimators=200, max_depth=6, random_state=42),
    }

    use_cv = len(X) < 40
    print(f"\n--- {dataset_name}  (powers: {chart_name}) ---")

    if use_cv:
        n_folds = max(2, min(5, len(X) // 4))
        print(f"  [{len(X)} rows -> using {n_folds}-fold cross-validation, not a single split]")
        print(f"{'Model':<28}{'MAE (avg)':>12}{'MSE (avg)':>12}{'RMSE (avg)':>12}{'R^2 (avg)':>12}{'R^2 (std)':>12}")

        kf = KFold(n_splits=n_folds, shuffle=True, random_state=42)

        for name, model in candidates.items():
            try:
                r2_scores  = cross_val_score(model, X, y, cv=kf, scoring="r2")
                mae_scores = -cross_val_score(model, X, y, cv=kf, scoring="neg_mean_absolute_error")
                mse_scores = -cross_val_score(model, X, y, cv=kf, scoring="neg_mean_squared_error")
                rmse_scores = -cross_val_score(model, X, y, cv=kf, scoring="neg_root_mean_squared_error")

                mae_avg, mse_avg, rmse_avg = mae_scores.mean(), mse_scores.mean(), rmse_scores.mean()
                r2_avg, r2_std = r2_scores.mean(), r2_scores.std()

                print(f"{name:<28}{mae_avg:>12.3f}{mse_avg:>12.3f}{rmse_avg:>12.3f}{r2_avg:>12.3f}{r2_std:>12.3f}")

                RESULTS.append({
                    "dataset": dataset_name, "chart": chart_name, "task": "regression",
                    "model": name, "MAE": round(mae_avg, 4), "MSE": round(mse_avg, 4),
                    "RMSE": round(rmse_avg, 4), "R2": round(r2_avg, 4), "R2_std": round(r2_std, 4),
                    "Accuracy": None, "Precision": None, "Recall": None, "F1": None,
                })
            except Exception as e:
                print(f"{name:<28} FAILED: {e}")

        print(f"  (R^2 std shows how much the score swings between folds — a high")
        print(f"   std means DON'T trust any single 'winner' here, real signal is weak.)")

    else:
        X_train, X_test, y_train, y_test = train_test_split(
            X, y, test_size=0.2, random_state=42
        )
        print(f"{'Model':<28}{'MAE':>10}{'MSE':>10}{'RMSE':>10}{'R^2':>10}")

        for name, model in candidates.items():
            try:
                model.fit(X_train, y_train)
                preds = model.predict(X_test)
                mae = mean_absolute_error(y_test, preds)
                mse = mean_squared_error(y_test, preds)
                rmse = np.sqrt(mse)
                r2 = r2_score(y_test, preds)

                print(f"{name:<28}{mae:>10.3f}{mse:>10.3f}{rmse:>10.3f}{r2:>10.3f}")

                RESULTS.append({
                    "dataset": dataset_name, "chart": chart_name, "task": "regression",
                    "model": name, "MAE": round(mae, 4), "MSE": round(mse, 4),
                    "RMSE": round(rmse, 4), "R2": round(r2, 4), "R2_std": None,
                    "Accuracy": None, "Precision": None, "Recall": None, "F1": None,
                })
            except Exception as e:
                print(f"{name:<28} FAILED: {e}")


def evaluate_classifiers(X, y, dataset_name: str, chart_name: str):
    """
    Runs LogisticRegression and RandomForestClassifier, and reports
    Accuracy / Precision / Recall / F1 / Confusion Matrix for each.
    """
    if len(X) < 10 or y.nunique() < 2:
        print(f"  [skip] {dataset_name}: too few rows or only one class present.")
        return

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    candidates = {
        "LogisticRegression":     LogisticRegression(max_iter=1000),
        "RandomForestClassifier": RandomForestClassifier(n_estimators=200, max_depth=6, random_state=42),
    }

    print(f"\n--- {dataset_name}  (powers: {chart_name}) ---")
    print(f"{'Model':<28}{'Accuracy':>10}{'Precision':>11}{'Recall':>9}{'F1':>9}")

    for name, model in candidates.items():
        try:
            model.fit(X_train, y_train)
            preds = model.predict(X_test)

            acc = accuracy_score(y_test, preds)
            prec = precision_score(y_test, preds, zero_division=0)
            rec = recall_score(y_test, preds, zero_division=0)
            f1 = f1_score(y_test, preds, zero_division=0)
            cm = confusion_matrix(y_test, preds)

            print(f"{name:<28}{acc:>10.3f}{prec:>11.3f}{rec:>9.3f}{f1:>9.3f}")
            print(f"    Confusion Matrix [[TN FP] [FN TP]]: {cm.tolist()}")

            RESULTS.append({
                "dataset": dataset_name, "chart": chart_name, "task": "classification",
                "model": name, "MAE": None, "MSE": None, "RMSE": None, "R2": None,
                "Accuracy": round(acc, 4), "Precision": round(prec, 4),
                "Recall": round(rec, 4), "F1": round(f1, 4),
            })
        except Exception as e:
            print(f"{name:<28} FAILED: {e}")


def load(path):
    if not os.path.exists(path):
        print(f"  [missing] {path} not found — skipping this dataset.")
        return None
    return pd.read_csv(path)


# ── one block per dataset/chart, matching auto_train.py's feature setup ─────
def run_all():
    md = MODEL_DATASETS_DIR

    # 01. Dropout risk — REGRESSION (continuous risk score, feeds the
    # toggle-mode/forecast transform in ml_analysis.py's get_dropout_pie,
    # which already clips+rounds the model's raw output into 0/1)
    # Powers: /api/get_dropout_pie -> Student Status / Retention donuts
    df = load(f"{md}/01_dropout_risk_per_student.csv")
    if df is not None:
        X = pd.get_dummies(
            df.drop(columns=["is_drop"], errors="ignore").select_dtypes(include="number").fillna(0)
        )
        y = df["is_drop"]
        evaluate_regressors(X, y, "01_dropout_risk_per_student.csv", "Student Status / Retention donuts")

    # 02. Dropout spike — REGRESSION (cohort dropout %, time series)
    # Powers: /api/get_dropout_spike -> "Dropout Trend & Spike Detection"
    # NOTE: this chart has been switched to forecast_series() (Holt's) in
    # ml_analysis.py, so this comparison is now mainly a reference check —
    # not something you need to swap the .pkl model for.
    df = load(f"{md}/02_dropout_spike_cohort.csv")
    if df is not None:
        X = pd.get_dummies(df[["College"]], prefix="College")
        X["Year_Numeric"] = df["Year_Numeric"] if "Year_Numeric" in df else df.get("Year", 0)
        y = df["Dropout_Rate"]
        evaluate_regressors(X, y, "02_dropout_spike_cohort.csv", "Dropout Trend & Spike Detection")

    # 03. Dropout ranking — REGRESSION (college-level dropout proportion)
    # Powers: /api/get_dropout_ranking -> college dropout ranking view
    df = load(f"{md}/03_dropout_ranking_college.csv")
    if df is not None:
        X = pd.get_dummies(df[["College", "Semester"]], drop_first=False)
        y = df["is_drop"]
        evaluate_regressors(X, y, "03_dropout_ranking_college.csv", "College dropout ranking")

    # 04. GWA ranking — REGRESSION
    # Powers: /api/get_gwa_ranking_data/<year> -> "Academic Performance Ranking (GWA)" bar chart
    df = load(f"{md}/04_gwa_ranking_college.csv")
    if df is not None:
        X = pd.get_dummies(df[["College"]], prefix="College")
        y = df["GWA"]
        evaluate_regressors(X, y, "04_gwa_ranking_college.csv", "Academic Performance Ranking (GWA) bar chart")

    # 05. GWA trend — REGRESSION (time series)
    # Powers: GWA trend line chart (per-college, dean & main dashboards)
    df = load(f"{md}/05_gwa_trend_timeseries.csv")
    if df is not None:
        X = pd.get_dummies(df[["College"]], drop_first=False)
        y = df["Avg_GWA"]
        evaluate_regressors(X, y, "05_gwa_trend_timeseries.csv", "GWA trend line chart")

    # 06. INC forecast — REGRESSION (time series)
    # Powers: /api/get_inc_forecast -> "INC Rate Forecast (Incomplete Grades)"
    # NOTE: also switched to forecast_series() (Holt's) in ml_analysis.py —
    # comparison kept here for reference/thesis documentation purposes.
    df = load(f"{md}/06_inc_forecast_cohort.csv")
    if df is not None:
        X = pd.get_dummies(df[["College"]], prefix="College")
        y = df["INC_Rate"]
        evaluate_regressors(X, y, "06_inc_forecast_cohort.csv", "INC Rate Forecast chart")

    # 07. Irregular rate — REGRESSION
    # Powers: /api/get_status_pie, /api/get_status_by_course
    df = load(f"{md}/07_irreg_reg_cohort.csv")
    if df is not None:
        X = pd.get_dummies(df[["College"]], prefix="College")
        y = df["Irregular_Rate"]
        evaluate_regressors(X, y, "07_irreg_reg_cohort.csv", "Irregular-rate views")

    # 08 & 09. KPI (GWA half + Enrollment half) — REGRESSION
    # Powers: /api/get_kpi_metrics -> dean-dashboard KPI tiles
    df_gwa = load(f"{md}/08_kpi_gwa_student.csv")
    if df_gwa is not None:
        X = pd.get_dummies(df_gwa[["College"]], prefix="College")
        y = df_gwa["GWA"]
        evaluate_regressors(X, y, "08_kpi_gwa_student.csv", "Dean KPI tile: predicted GWA")

    df_en = load(f"{md}/09_kpi_enrollment_college.csv")
    if df_en is not None:
        X = pd.get_dummies(df_en[["College"]], prefix="College")
        y = df_en["Headcount"]
        evaluate_regressors(X, y, "09_kpi_enrollment_college.csv", "Dean KPI tile: predicted headcount")

    # 10. Subject grade forecast — REGRESSION (time series per subject)
    # Powers: "Top 5 Hardest Subjects" line charts (main + per-course)
    # NOTE: also switched to forecast_series() (Holt's) in ml_analysis.py —
    # comparison kept here for reference/thesis documentation purposes.
    df = load(f"{md}/10_subject_grade_forecast.csv")
    if df is not None:
        X = pd.get_dummies(df[["College", "Subject"]], prefix=["College", "Subject"])
        y = df["Avg_Grade"]
        evaluate_regressors(X, y, "10_subject_grade_forecast.csv", "Top 5 Hardest Subjects charts")

    # 11. Performance band distribution — REGRESSION (% of students per band)
    # Currently NOT wired to any endpoint or chart — this dataset was being
    # exported by preprocess.py but never trained on or evaluated, which is
    # why it never showed up in the metrics table at all ("skipped").
    # Target use: a genuine "GWA Distribution" prediction-mode chart —
    # forecasting what % of students land in each performance band
    # (Excellent/Good/Average/Below Average/Failing) per college/year,
    # instead of the current get_gwa_scatter behavior, which only forecasts
    # a single average-GWA line (from dataset 05) and leaves the scatter
    # dots themselves as static historical data in prediction mode.
    df = load(f"{md}/11_performance_band_dist.csv")
    if df is not None:
        X = pd.get_dummies(df[["College", "Perf_Band"]], prefix=["College", "Band"])
        X["Year_Numeric"] = df["Year_Numeric"]
        X["Sem_Numeric"]  = df["Sem_Numeric"]
        y = df["Pct"]
        evaluate_regressors(X, y, "11_performance_band_dist.csv", "GWA Distribution (performance-band %) forecast")

    # 12. Gender performance — REGRESSION (two targets, same feature set)
    # Also previously unused/never evaluated. Target use: the Male/Female
    # Retention Trend cards in Prediction mode. Right now those cards don't
    # call a trained model at all — mode-toggle.js's _renderRetentionCharts
    # explicitly swaps to /api/get_status_trend (a generic Holt fit on
    # overall status %, filtered by &gender=) specifically BECAUSE
    # /api/get_gender_status_breakdown is historical-only. Training real
    # regressors on this dataset (Dropout_Rate and Avg_GWA by
    # Year_Numeric x College x Gender) is the prerequisite for eventually
    # giving that chart a genuine per-gender forecast instead of the
    # current one-size-fits-all trend line.
    df = load(f"{md}/12_gender_performance.csv")
    if df is not None:
        X = pd.get_dummies(df[["College", "Gender_Label"]], prefix=["College", "Gender"])
        X["Year_Numeric"] = df["Year_Numeric"]

        y_dropout = df["Dropout_Rate"]
        evaluate_regressors(X, y_dropout, "12_gender_performance.csv (Dropout_Rate)", "Male/Female Retention Trend (dropout)")

        y_gwa = df["Avg_GWA"]
        evaluate_regressors(X, y_gwa, "12_gender_performance.csv (Avg_GWA)", "Male/Female GWA comparison")

    # ── save the full results table ──────────────────────────────────────
    if RESULTS:
        out_df = pd.DataFrame(RESULTS)
        out_path = "model_comparison_results.csv"
        out_df.to_csv(out_path, index=False)
        print(f"\nSaved full comparison table -> {out_path}")

        print("\n=== BEST MODEL PER DATASET ===")
        for dataset_name, group in out_df.groupby("dataset"):
            if group["task"].iloc[0] == "regression":
                best = group.loc[group["R2"].idxmax()]
                std = best.get("R2_std")
                if std is not None and std > 0.5:
                    flag = f"  ⚠ R^2 std={std:.2f} across folds — DON'T trust this as a real winner, dataset is too small/noisy"
                else:
                    flag = ""
                print(f"{dataset_name:<32} best = {best['model']:<28} (R^2={best['R2']}){flag}")
            else:
                best = group.loc[group["F1"].idxmax()]
                print(f"{dataset_name:<32} best = {best['model']:<28} (F1={best['F1']})")


if __name__ == "__main__":
    run_all()