"""
migrate_to_mysql.py — ONE-TIME script. Run this AFTER:
  1. XAMPP MySQL is running
  2. You've run schema.sql in phpMyAdmin on the `novasight` database
  3. config.py's SQLALCHEMY_DATABASE_URI points at that MySQL database
  4. This file sits at your project root (same level as configs/, database/)

It reads your EXISTING by_year/ folders, model_datasets/ CSVs, .pkl
models, and training_state.json — and populates the MySQL tables.
Does not touch or delete anything on disk; safe to re-run (it uses
if_exists='replace' so re-running just re-syncs instead of duplicating).
"""

import os
import json
import pandas as pd
from sqlalchemy import create_engine

from configs.config import (
    SQLALCHEMY_DATABASE_URI, PROCESSED_BY_YEAR_DIR, MODEL_DATASETS_DIR, ML_MODEL_DIR,
)

engine = create_engine(SQLALCHEMY_DATABASE_URI)

STATE_FILE = os.path.join(ML_MODEL_DIR, "training_state.json")

# model_datasets/* chart tables are retired — charts now query
# student_data / longform_grades directly. No table map, no migration
# step for them anymore.


def migrate_grade_data():
    """
    Migrates each by_year/ semester folder into student_data /
    longform_grades AS ITS OWN APPEND — never concatenated with other
    semesters in memory first, and never if_exists='replace'. Every row
    carries its own academic_year/semester columns, so semesters stay
    distinguishable in MySQL exactly the way they stayed separate as
    standalone CSV folders on disk. Re-running re-appends everything, so
    this is still meant as a one-time migration (truncate the two tables
    first if you need to re-run it).
    """
    print("→ Migrating by_year/ folders into student_data / longform_grades (per-semester, no combining) ...")
    if not os.path.isdir(PROCESSED_BY_YEAR_DIR):
        print("   (no by_year/ folder found — skipping)")
        return

    for entry in sorted(os.listdir(PROCESSED_BY_YEAR_DIR)):
        sdir = os.path.join(PROCESSED_BY_YEAR_DIR, entry)
        if not os.path.isdir(sdir):
            continue
        spath = os.path.join(sdir, "Student_Data.csv")
        lpath = os.path.join(sdir, "LongForm_Grades.csv")

        if os.path.exists(spath):
            student_df = pd.read_csv(spath)
            student_df.to_sql("student_data", engine, if_exists="append", index=False)
            print(f"   [{entry}] student_data: {len(student_df):,} rows")

        if os.path.exists(lpath):
            long_df = pd.read_csv(lpath)
            long_df.to_sql("longform_grades", engine, if_exists="append", index=False)
            print(f"   [{entry}] longform_grades: {len(long_df):,} rows")


def migrate_trained_models():
    print("→ Migrating trained_models + eval metrics from training_state.json ...")
    if not os.path.exists(STATE_FILE):
        print("   (no training_state.json found — skipping)")
        return

    with open(STATE_FILE) as f:
        state = json.load(f)

    rows = []
    for model_name, result in state.get("models", {}).items():
        if not isinstance(result, dict):
            continue
        pkl_path = os.path.join(ML_MODEL_DIR, f"{model_name}.pkl")
        rows.append({
            "model_name": model_name,
            "algorithm": result.get("algorithm"),
            "target_column": result.get("target"),
            "source_dataset": result.get("source_dataset"),
            "file_path": pkl_path if os.path.exists(pkl_path) else None,
            "status": result.get("status", "ok" if "error" not in result else "error"),
            "error_message": result.get("error"),
            "r2_score": result.get("r2"),
            "mse": result.get("mse"),
            "mae": result.get("mae"),
            "accuracy": result.get("accuracy"),
            "f1_score": result.get("f1"),
            "horizon_year": state.get("horizon", {}).get("horizon_year"),
        })

    if rows:
        pd.DataFrame(rows).to_sql("trained_models", engine, if_exists="append", index=False)
        print(f"   trained_models: {len(rows)} rows inserted")


if __name__ == "__main__":
    migrate_grade_data()
    migrate_trained_models()
    print("\nDone. Spot-check counts in phpMyAdmin: SELECT COUNT(*) FROM student_data; etc.")