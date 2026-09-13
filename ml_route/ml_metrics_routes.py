"""
ml_metrics_routes.py
─────────────────────────────────────────────────────────────────────────────
New blueprint: the routes the Model Performance page has been calling but
that never existed —

    GET /api/get_model_metrics             (mp-grid cards — ml_eval.js)
    GET /api/model-performance              (headline chart, status donut,
                                              diagnostics dropdowns)
    GET /api/model_predicted_vs_actual?model=<label>
    GET /api/model_feature_importance?model=<label>
    GET /api/model_confusion_matrix?model=<label>   (classifiers only)
    GET /api/model_residual_trend?model=<label>

Everything here reads training_state.json (written by auto_train.py's
run_full_pipeline) plus the already-loaded model objects in
ml_route.ml_analysis, so there's no re-training and no new .pkl files —
this is purely a read layer on top of what auto_train.py already produces.

ALGORITHM_MAP below is hand-built from auto_train.py's actual trainer
bodies (not guessed from model.type) — see the "WHICH TRAINER FEEDS WHICH
CHART" comment block near the top of that file for the source of truth:
LinearRegression x14, RandomForestRegressor x6, RandomForestClassifier x1
(irreg_reg — the ONLY classifier currently trained). Every model entry
below carries a real "algorithm" field, so the frontend's
classifyAlgorithm() in ml_eval.js uses it directly instead of falling
back to guessing from `type`.

Register in app.py the same way ml_bp/upload_bp/admin_bp already are:
    from ml_route.ml_metrics_routes import ml_diag_bp
    app.register_blueprint(ml_diag_bp)
─────────────────────────────────────────────────────────────────────────────
"""
import os
import json

import numpy as np
import pandas as pd
from flask import Blueprint, jsonify, request

from configs.config import ML_MODEL_DIR, MODEL_DATASETS_DIR
from ml_route import ml_analysis

ml_diag_bp = Blueprint('ml_diagnostics', __name__)

STATE_FILE = os.path.join(ML_MODEL_DIR, "training_state.json")


# ── Load training_state.json ──────────────────────────────────────────────
def _load_state() -> dict:
    if not os.path.exists(STATE_FILE):
        return {}
    try:
        with open(STATE_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


# ── Ground-truth algorithm per trainer (see module docstring) ─────────────
ALGORITHM_MAP = {
    "dropout_risk":              "LinearRegression",
    "dropout_spike":             "RandomForestRegressor",
    "dropout_ranking":           "RandomForestRegressor",
    "gwa_ranking":                "LinearRegression",
    "gwa_trend":                  "LinearRegression",
    "irreg_reg":                  "RandomForestClassifier",
    "kpi":                        "LinearRegression",
    "gender_performance_male":   "RandomForestRegressor",
    "gender_performance_female": "RandomForestRegressor",
    "year_level_performance":    "LinearRegression",
    "year_level_inc_irreg":      "LinearRegression",
}

DESCRIPTIONS = {
    "dropout_risk": "Per-student dropout risk score (continuous 0-1) — powers the Student Status "
                     "and Male/Female Retention & Risk donuts. An R² near 1.0 is a known leakage "
                     "flag (see train_dropout_risk's docstring in auto_train.py), not a clean win.",
    "dropout_spike": "Cohort dropout-rate trend per college — trained for reference; the live chart "
                      "uses forecast_series() directly, so this model doesn't reach students.",
    "dropout_ranking": "Per-student drop probability behind the college dropout ranking view. "
                        "Needs better features — R² is essentially zero.",
    "gwa_ranking": "GWA ranking per college — used only in forecast mode of the "
                   "Academic Performance Ranking (GWA) chart.",
    "gwa_trend": "GWA-over-time trend per college.",
    "irreg_reg": "Per-student behaviorally-Irregular classifier — powers the forecast-mode "
                 "Irregular-rate donut.",
    "kpi": "Three separate linear trend halves (GWA / Enrollment / Drop count) behind the "
           "dean-dashboard KPI tiles.",
    "gender_performance_male": "Male-only Dropout/INC rate trend — feeds the Male Retention "
                                "Trend forecast.",
    "gender_performance_female": "Female-only Dropout/INC rate trend — feeds the Female Retention "
                                  "Trend forecast.",
    "year_level_performance": "5 independent per-band trend models (Excellent…Failing) behind "
                              "\"Performance by Year Level\".",
    "year_level_inc_irreg": "INC / Irregular(behavioral) / Drop rate trend by year level.",
}

_METRIC_KEYS = ("r2", "rmse", "mse", "mae", "accuracy", "f1")


def _make_entry(name: str, result: dict, algorithm: str, description: str) -> dict:
    status = result.get("status", "error" if "error" in result else "ok")
    metrics = {k: v for k, v in result.items() if k in _METRIC_KEYS}
    kind = "classification" if "accuracy" in metrics else "regression"
    return {
        "name": name,
        "type": kind,
        "algorithm": algorithm,
        "status": status,
        "metrics": metrics,
        "description": result.get("reason") if status == "skipped" else description,
        "error": result.get("error"),
    }


def _flatten_models(models_dict: dict) -> list:
    """training_state.json's "models" dict has two shapes per trainer:
    a flat {"status", <metric keys>} dict (dropout_risk, dropout_spike,
    dropout_ranking, gwa_ranking, gwa_trend, irreg_reg), or a nested
    {sub_key: {"status", <metric keys>}} dict for trainers that fit more
    than one target (kpi, gender_performance_male/female,
    year_level_performance, year_level_inc_irreg). This splits both into
    one flat list of individually-scored entries."""
    out = []
    for trainer_name, result in (models_dict or {}).items():
        algo = ALGORITHM_MAP.get(trainer_name, "Unknown")
        desc = DESCRIPTIONS.get(trainer_name, "")
        if not isinstance(result, dict):
            continue
        is_flat = "status" in result or any(k in result for k in _METRIC_KEYS)
        if is_flat:
            out.append(_make_entry(trainer_name, result, algo, desc))
        else:
            for sub_key, sub_result in result.items():
                if not isinstance(sub_result, dict):
                    continue
                out.append(_make_entry(f"{trainer_name} ({sub_key})", sub_result, algo, desc))
    return out


def _headline_value(metrics: dict):
    if "accuracy" in metrics:
        return metrics["accuracy"]
    if "r2" in metrics:
        return metrics["r2"]
    return None


# ── GET /api/get_model_metrics ─────────────────────────────────────────────
@ml_diag_bp.route('/api/get_model_metrics')
def api_get_model_metrics():
    state = _load_state()
    if not state:
        return jsonify({"models": [], "total": 0, "error": "No training_state.json yet — run a training pass first."})

    models = _flatten_models(state.get("models", {}))
    return jsonify({
        "models": models,
        "total": len(models),
        "trained_at": state.get("trained_at"),
    })


# ── GET /api/model-performance ─────────────────────────────────────────────
@ml_diag_bp.route('/api/model-performance')
def api_model_performance():
    state = _load_state()
    models = _flatten_models(state.get("models", {}))
    if not state or not models:
        return jsonify({"models": [], "status": "no_training_yet", "trained_at": None})

    out = []
    for m in models:
        metrics = m["metrics"]
        headline_label = "Accuracy" if "accuracy" in metrics else ("R\u00b2" if "r2" in metrics else None)
        # FIX: the frontend's renderModelCard() (chart-helpers.js) has always
        # read model.metrics / model.headline_label / model.reason to fill in
        # the supporting-metrics rows and the skip/error explanation text —
        # this endpoint just wasn't sending any of the three, so every card
        # silently rendered with only a headline number and nothing else.
        reason = None
        if m["status"] == "skipped":
            reason = m["description"]
        elif m["status"] == "error":
            reason = m["error"]
        out.append({
            "label": m["name"],
            "headline_value": _headline_value(metrics),
            "headline_label": headline_label,
            "metrics": metrics,
            "status": m["status"],
            "algorithm": m["algorithm"],
            "reason": reason,
        })
    return jsonify({
        "models": out,
        "trained_at": state.get("trained_at"),
        # Also previously missing: renderErrors()/mp-trained-at in
        # chart-helpers.js read data.errors and data.rows_in_master off the
        # TOP-LEVEL response, not per-model — safe no-ops if training_state.json
        # doesn't happen to carry these keys.
        "errors": state.get("errors", []),
        "rows_in_master": state.get("rows_in_master"),
    })


# ═════════════════════════════════════════════════════════════════════════
#  Diagnostics: predicted-vs-actual / feature importance / confusion
#  matrix / residual trend. Each rebuilds the same X the model was
#  trained on (same dummy columns, reindexed to the saved *_features.pkl
#  list so extra/missing categories can't shift column order — same
#  reindex-to-feature-list trick ml_analysis.py's _predict_gender_pct
#  already uses) and scores it against the CURRENT full dataset — this is
#  a diagnostic view of fit quality, not a re-run of the original
#  train/test split, so treat these charts as "how well does the model
#  track today's data", not a strict held-out evaluation number.
# ═════════════════════════════════════════════════════════════════════════

def _dataset_path(filename: str) -> str:
    return os.path.join(MODEL_DATASETS_DIR, filename)


def _reindex(X: pd.DataFrame, feature_list) -> pd.DataFrame:
    if feature_list:
        X = X.reindex(columns=list(feature_list), fill_value=0)
    return X


def _sentinel_year_level(df: pd.DataFrame) -> pd.DataFrame:
    """Same -1 (Irregular)/0 (Unknown) sentinel handling as
    train_dropout_risk/train_irreg_reg in auto_train.py."""
    df = df.copy()
    df["is_irregular_year"] = (df["Year_Level_Num"] == -1).astype(int)
    df.loc[df["Year_Level_Num"] == -1, "Year_Level_Num"] = np.nan
    df.loc[df["Year_Level_Num"] == 0, "Year_Level_Num"] = np.nan
    return df


def _impute(df: pd.DataFrame, median_cols, zero_cols, cat_cols) -> pd.DataFrame:
    df = df.copy()
    for col in median_cols:
        if col in df.columns:
            df[col] = df[col].fillna(df[col].median())
    for col in zero_cols:
        if col in df.columns:
            df[col] = df[col].fillna(0)
    for col in cat_cols:
        if col in df.columns:
            df[col] = df[col].fillna("Unknown")
    return df


def _build_dropout_risk(df, feature_list):
    df = _sentinel_year_level(df)
    df = _impute(df, ["GWA", "Avg_Grade", "fail_rate", "Year_Level_Num"],
                     ["Sub_Count", "Year_Numeric", "Sem_Numeric", "is_irregular_year"],
                     ["Gender", "College", "Semester"])
    df = df.dropna(subset=["is_drop"])
    feature_cols = ["Gender", "College", "Semester", "Year_Numeric", "Sem_Numeric",
                     "GWA", "Avg_Grade", "Sub_Count", "fail_rate",
                     "Year_Level_Num", "is_irregular_year"]
    X = _reindex(pd.get_dummies(df[feature_cols], drop_first=False), feature_list)
    return X, df["is_drop"], df.get("Year_Numeric")


def _build_irreg_reg(df, feature_list):
    df = _sentinel_year_level(df)
    df = _impute(df, ["GWA", "Avg_Grade", "Year_Level_Num"],
                     ["Sub_Count", "Year_Numeric", "Sem_Numeric", "is_irregular_year"],
                     ["Gender", "College", "Semester"])
    df = df.dropna(subset=["is_irregular"])
    feature_cols = ["Gender", "College", "Semester", "Year_Numeric", "Sem_Numeric",
                     "GWA", "Avg_Grade", "Sub_Count", "Year_Level_Num", "is_irregular_year"]
    X = _reindex(pd.get_dummies(df[feature_cols], drop_first=False), feature_list)
    return X, df["is_irregular"], df.get("Year_Numeric")


def _build_college_numeric(df, target_col, cat_cols, numeric_cols, feature_list,
                            filter_col=None, filter_range=None, dropna_cols=None):
    """Shared shape for dropout_spike/dropout_ranking/gwa_ranking/gwa_trend/
    kpi halves/gender halves: one or more categorical dummy columns plus a
    couple of plain numeric columns (Year_Numeric, Sem_Numeric)."""
    d = df.copy()
    if dropna_cols:
        d = d.dropna(subset=dropna_cols)
    if filter_col and filter_range:
        lo, hi = filter_range
        d = d[(d[filter_col] >= lo) & (d[filter_col] <= hi)]
    X = pd.get_dummies(d[cat_cols], drop_first=False)
    for col in numeric_cols:
        X[col] = d[col]
    X = _reindex(X, feature_list)
    return X, d[target_col], d.get("Year_Numeric")


def _build_year_level_band(df, band, feature_list):
    d = df[df["Perf_Band"] == band]
    X = pd.get_dummies(d[["College", "Course"]], drop_first=False)
    X["Year_Level_Num"] = d["Year_Level_Num"]
    X["Year_Numeric"] = d["Year_Numeric"]
    X["Sem_Numeric"] = d["Sem_Numeric"]
    X = _reindex(X, feature_list)
    return X, d["Pct"], d.get("Year_Numeric")


def _build_year_level_rate(df, target_col, feature_list):
    d = df.dropna(subset=[target_col])
    X = pd.get_dummies(d[["College", "Course"]], drop_first=False)
    X["Year_Level_Num"] = d["Year_Level_Num"]
    X["Year_Numeric"] = d["Year_Numeric"]
    X["Sem_Numeric"] = d["Sem_Numeric"]
    X = _reindex(X, feature_list)
    return X, d[target_col], d.get("Year_Numeric")


# Every diagnostics-capable model: dataset csv + a build_fn(df, features) ->
# (X, y, year_series) + the live model/features attributes on ml_analysis.
MODEL_REGISTRY = {
    "dropout_risk": {
        "dataset": "01_dropout_risk_per_student_dropout_pie_status_pie.csv",
        "build": _build_dropout_risk,
        "model_attr": "drop_pie_model", "features_attr": "drop_pie_features",
        "kind": "regression",
    },
    "irreg_reg": {
        "dataset": "01_dropout_risk_per_student_dropout_pie_status_pie.csv",
        "build": _build_irreg_reg,
        "model_attr": "status_model", "features_attr": "status_features",
        "kind": "classification",
    },
    "dropout_spike": {
        "dataset": "02_dropout_spike_cohort_dropout_trend_chart.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "Dropout_Rate", ["College"], ["Year_Numeric"], feats),
        "model_attr": "dropout_spike_model", "features_attr": "dropout_spike_features",
        "kind": "regression",
    },
    "dropout_ranking": {
        "dataset": "03_dropout_ranking_college_college_ranking_chart.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "is_drop", ["College", "Semester"], ["Year_Numeric"], feats),
        "model_attr": "dropout_ranking_model", "features_attr": "dropout_ranking_features",
        "kind": "regression",
    },
    "gwa_ranking": {
        "dataset": "04_gwa_ranking_college_gwa_ranking_chart.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "GWA", ["College"], ["Year_Numeric", "Sem_Numeric"], feats,
            filter_col="GWA", filter_range=(1.0, 5.0),
            dropna_cols=["GWA", "College", "Year_Numeric"]),
        "model_attr": "gwa_ranking_model", "features_attr": "gwa_ranking_features",
        "kind": "regression",
    },
    "gwa_trend": {
        "dataset": "05_gwa_trend_timeseries_gwa_trend_chart.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "Avg_GWA", ["College"], ["Year_Numeric", "Sem_Numeric"], feats,
            filter_col="Avg_GWA", filter_range=(1.0, 5.0),
            dropna_cols=["Avg_GWA", "College", "Year_Numeric"]),
        "model_attr": "gwa_trend_model", "features_attr": "gwa_trend_features",
        "kind": "regression",
    },
    "kpi (gwa)": {
        "dataset": "08_kpi_gwa_student_kpi_tiles.csv",
        "build": lambda df, feats: _build_college_numeric(
            df.dropna(), "GWA", ["College"], ["Year_Numeric", "Sem_Numeric"], feats,
            filter_col="GWA", filter_range=(1.0, 5.0)),
        "model_attr": "kpi_gwa_model", "features_attr": "kpi_gwa_features",
        "kind": "regression",
    },
    "kpi (enrollment)": {
        "dataset": "09_kpi_enrollment_college_kpi_tiles.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "Headcount", ["College"], ["Year_Numeric"], feats),
        "model_attr": "kpi_enroll_model", "features_attr": "kpi_enroll_features",
        "kind": "regression",
    },
    "kpi (drop)": {
        "dataset": "15_kpi_drop_college_kpi_tiles.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "Drop_Count", ["College"], ["Year_Numeric", "Sem_Numeric"], feats),
        "model_attr": "kpi_drop_model", "features_attr": "kpi_drop_features",
        "kind": "regression",
    },
    "gender_performance_male (dropout_rate)": {
        "dataset": "12_gender_performance_male_retention_trend_chart.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "Dropout_Rate", ["College"], ["Year_Numeric"], feats),
        "model_attr": "male_gender_dropout_model", "features_attr": "male_gender_dropout_features",
        "kind": "regression",
    },
    "gender_performance_male (inc_rate)": {
        "dataset": "12_gender_performance_male_retention_trend_chart.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "INC_Rate", ["College"], ["Year_Numeric"], feats),
        "model_attr": "male_gender_inc_model", "features_attr": "male_gender_inc_features",
        "kind": "regression",
    },
    "gender_performance_female (dropout_rate)": {
        "dataset": "12_gender_performance_female_retention_trend_chart.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "Dropout_Rate", ["College"], ["Year_Numeric"], feats),
        "model_attr": "female_gender_dropout_model", "features_attr": "female_gender_dropout_features",
        "kind": "regression",
    },
    "gender_performance_female (inc_rate)": {
        "dataset": "12_gender_performance_female_retention_trend_chart.csv",
        "build": lambda df, feats: _build_college_numeric(
            df, "INC_Rate", ["College"], ["Year_Numeric"], feats),
        "model_attr": "female_gender_inc_model", "features_attr": "female_gender_inc_features",
        "kind": "regression",
    },
    "year_level_inc_irreg (inc_rate)": {
        "dataset": "14_year_level_inc_irreg.csv",
        "build": lambda df, feats: _build_year_level_rate(df, "INC_Rate", feats),
        "model_attr": "year_level_inc_rate_model", "features_attr": "year_level_inc_rate_features",
        "kind": "regression",
    },
    "year_level_inc_irreg (irregular_rate)": {
        "dataset": "14_year_level_inc_irreg.csv",
        "build": lambda df, feats: _build_year_level_rate(df, "Irregular_Rate", feats),
        "model_attr": "year_level_irregular_rate_model", "features_attr": "year_level_irregular_rate_features",
        "kind": "regression",
    },
    "year_level_inc_irreg (drop_rate)": {
        "dataset": "14_year_level_inc_irreg.csv",
        "build": lambda df, feats: _build_year_level_rate(df, "Drop_Rate", feats),
        "model_attr": "year_level_drop_rate_model", "features_attr": "year_level_drop_rate_features",
        "kind": "regression",
    },
}
# The 5 year_level_performance bands share one shape — register them in a loop.
for _band, _attr in [
    ("Excellent", "excellent"), ("Good", "good"), ("Average", "average"),
    ("Below Average", "below_average"), ("Failing", "failing"),
]:
    MODEL_REGISTRY[f"year_level_performance ({_band})"] = {
        "dataset": "13_year_level_performance.csv",
        "build": (lambda band: (lambda df, feats: _build_year_level_band(df, band, feats)))(_band),
        "model_attr": f"year_level_perf_{_attr}_model",
        "features_attr": f"year_level_perf_{_attr}_features",
        "kind": "regression",
    }


def _load_registry_entry(label: str):
    entry = MODEL_REGISTRY.get(label)
    if entry is None:
        return None, None
    model = getattr(ml_analysis, entry["model_attr"], None)
    features = getattr(ml_analysis, entry["features_attr"], None)
    if model is None:
        return None, None
    path = _dataset_path(entry["dataset"])
    if not os.path.exists(path):
        return None, None
    df = pd.read_csv(path)
    X, y, years = entry["build"](df, features)
    return entry, (model, X, y, years)


@ml_diag_bp.route('/api/model_predicted_vs_actual')
def api_model_predicted_vs_actual():
    label = request.args.get('model', '')
    entry, loaded = _load_registry_entry(label)
    if not entry:
        return jsonify({"error": f"'{label}' isn't a recognized model, or its dataset/pkl isn't available yet."}), 404
    model, X, y, _years = loaded
    try:
        preds = model.predict(X)
    except Exception as e:
        return jsonify({"error": f"Prediction failed: {e}"}), 500
    return jsonify({
        "model": label,
        "actual": [float(v) for v in y],
        "predicted": [float(v) for v in preds],
    })


@ml_diag_bp.route('/api/model_feature_importance')
def api_model_feature_importance():
    label = request.args.get('model', '')
    entry, loaded = _load_registry_entry(label)
    if not entry:
        return jsonify({"error": f"'{label}' isn't a recognized model, or its dataset/pkl isn't available yet."}), 404
    model, X, _y, _years = loaded

    if hasattr(model, "feature_importances_"):
        importance = np.asarray(model.feature_importances_, dtype=float)
    elif hasattr(model, "coef_"):
        importance = np.abs(np.asarray(model.coef_, dtype=float)).ravel()
    else:
        return jsonify({"error": "Model type doesn't expose feature importances."}), 400

    features = list(X.columns)
    order = np.argsort(importance)[::-1][:15]  # top 15, keeps the bar chart readable
    return jsonify({
        "model": label,
        "features": [features[i] for i in order],
        "importance": [round(float(importance[i]), 4) for i in order],
    })


@ml_diag_bp.route('/api/model_confusion_matrix')
def api_model_confusion_matrix():
    label = request.args.get('model', '')
    entry, loaded = _load_registry_entry(label)
    if not entry:
        return jsonify({"error": f"'{label}' isn't a recognized model, or its dataset/pkl isn't available yet."}), 404
    if entry["kind"] != "classification":
        return jsonify({"error": f"'{label}' is a regression model — confusion matrix only applies to classifiers."}), 400

    from sklearn.metrics import confusion_matrix
    model, X, y, _years = loaded
    try:
        preds = model.predict(X)
    except Exception as e:
        return jsonify({"error": f"Prediction failed: {e}"}), 500

    labels = sorted(pd.unique(pd.concat([pd.Series(y), pd.Series(preds)])))
    cm = confusion_matrix(y, preds, labels=labels)
    label_names = ["Regular" if v == 0 else "Irregular" for v in labels] if label == "irreg_reg" else [str(v) for v in labels]
    return jsonify({"model": label, "labels": label_names, "matrix": cm.tolist()})


@ml_diag_bp.route('/api/model_residual_trend')
def api_model_residual_trend():
    label = request.args.get('model', '')
    entry, loaded = _load_registry_entry(label)
    if not entry:
        return jsonify({"error": f"'{label}' isn't a recognized model, or its dataset/pkl isn't available yet."}), 404
    model, X, y, years = loaded
    if years is None:
        return jsonify({"error": f"'{label}'s dataset has no Year_Numeric column to trend against."}), 400

    try:
        preds = model.predict(X)
    except Exception as e:
        return jsonify({"error": f"Prediction failed: {e}"}), 500

    trend = pd.DataFrame({"year": years.values, "residual": np.asarray(preds) - y.values})
    grouped = trend.groupby("year")["residual"].mean().sort_index()
    return jsonify({
        "model": label,
        "years": [str(int(y_)) for y_ in grouped.index],
        "residual": [round(float(v), 4) for v in grouped.values],
    })