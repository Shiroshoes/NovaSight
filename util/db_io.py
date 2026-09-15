"""
db_io.py — thin data-access layer over the MySQL/XAMPP database.

Goal: let preprocess.py / auto_train.py / ml_analysis.py swap their
`pd.read_csv(path)` / `df.to_csv(path)` calls for
`read_table(name)` / `write_table(df, name)` with minimal changes to
surrounding logic. Uses the SAME SQLAlchemy engine as database/models.py's
`db` object where possible so you're not juggling two connections.

Put this file in the same package as configs/config.py (e.g. util/db_io.py).
"""

import gzip
import base64
import io
import json
import joblib
import pandas as pd
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.dialects.mysql import LONGTEXT

from configs.config import SQLALCHEMY_DATABASE_URI


def _compress_csv(csv_text: str) -> str:
    """Gzip-compress a CSV text blob and base64-encode it for storage in
    a LONGTEXT column. Grade-sheet CSVs are highly repetitive (few
    distinct values across most columns -- grades, course codes, college
    codes), so this typically shrinks the blob 70-90% before it's ever
    sent over the wire to MySQL. That directly reduces the odds of a
    single INSERT statement tripping max_allowed_packet or timing out
    mid-transfer on a large upload, independent of how the XAMPP server
    itself is tuned.
    """
    raw = csv_text.encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6)
    return base64.b64encode(compressed).decode("ascii")


def _decompress_csv(blob: str) -> str:
    """Inverse of _compress_csv(). Falls back to returning the value
    unchanged if it doesn't look like a gzip blob, so any row written
    BEFORE this change (plain-text csv_file, from the old code path)
    still reads back correctly instead of raising."""
    try:
        raw = base64.b64decode(blob)
        return gzip.decompress(raw).decode("utf-8")
    except Exception:
        return blob  # legacy plain-text row, or already decompressed

# Reuse the same URI Flask-SQLAlchemy is already configured with, so this
# points at the same MySQL database as acad_user / uploaded_dataset.
# pool_recycle=280: recycle connections just under MySQL's wait_timeout so
# a connection that's been idle too long is replaced BEFORE use instead of
# being handed to a query and dying mid-transaction ("MySQL server has
# gone away"). pool_pre_ping alone only catches this on simple round trips
# -- it doesn't protect a multi-statement transaction (like
# upsert_semester_upload's DELETE+INSERT) from going stale partway through.
_engine = create_engine(SQLALCHEMY_DATABASE_URI, pool_pre_ping=True, pool_recycle=280)


def get_engine():
    return _engine


def _table_exists(table_name: str) -> bool:
    return inspect(_engine).has_table(table_name)


# Every MySQL table a full "Reset Database" action should empty.
# app_storage holds BOTH trained model blobs and training_state (see the
# CREATE TABLE note above), so truncating it clears models + horizon in
# one go. Keep this list in sync with preprocess.py's FILENAME_TO_TABLE
# whenever a new model-dataset table is added there.
RESET_TABLES = [
    "app_storage",
    "semester_uploads",
    "longform_uploads",
    "trained_models",
    "training_summary",
    "course_year_level_dropout",
    "dropout_spike_cohort",
    "dropout_ranking_college",
    "gwa_ranking_college",
    "gwa_trend_timeseries",
    "inc_forecast_cohort",
    "irreg_reg_cohort",
    "kpi_gwa_student",
    "kpi_enrollment_college",
    "subject_grade_forecast",
    "performance_band_dist",
    "gender_performance_male",
    "gender_performance_female",
    "year_level_performance",
    "year_level_inc_irreg",
    "kpi_drop_college",
]


def reset_all_data() -> None:
    """Empties every table in RESET_TABLES (no-op for any that don't
    exist yet). Does NOT touch acad_user or uploaded_dataset — those are
    Flask-SQLAlchemy models, so the caller (api_reset_database()) clears
    them through db.session instead, keeping one consistent ORM
    transaction for that part. Caller is responsible for calling
    ml_analysis.reload_models() afterward so the in-memory df_full_loaded
    + .pkl caches don't keep serving the just-deleted data."""
    with _engine.begin() as conn:
        for table_name in RESET_TABLES:
            if _table_exists(table_name):
                conn.exec_driver_sql(f"TRUNCATE TABLE {table_name}")


def read_table(table_name: str, where: str = None) -> pd.DataFrame:
    """
    Equivalent of pd.read_csv(some_path). Reads an entire table (or a
    filtered slice if `where` is given, e.g. "academic_year = '2022-2023'").
    Only for plain typed-column tables — student_data / longform_grades
    are CSV-blob tables now (see read_semester_tables() below), not this.

    Returns an empty DataFrame if the table doesn't exist yet, same as
    count_rows()/count_distinct() below, instead of letting pd.read_sql
    raise "Table '...' doesn't exist" straight up to the caller. This
    matters for the 16 model-dataset tables in particular: even with
    schema.sql's CREATE TABLEs run, a fresh/rolled-back database, or a
    table dropped for a schema change, legitimately means "no data yet"
    rather than a 500.
    """
    if not _table_exists(table_name):
        return pd.DataFrame()
    query = f"SELECT * FROM {table_name}"
    if where:
        query += f" WHERE {where}"
    return pd.read_sql(query, _engine)


def read_semester_csvs(table_name: str) -> pd.DataFrame:
    """
    Like read_table(), but for tables where `csv_file` was written via
    upsert_semester_upload() (so it's gzip+base64 compressed). Decompresses
    every row's `csv_file` back into plain CSV text before returning, so
    callers can pd.read_csv(io.StringIO(row['csv_file'])) directly, the
    same way they would have before compression was added. Rows written
    before compression existed (plain-text csv_file) still come back
    correctly -- _decompress_csv() falls back to returning them unchanged.
    Use this instead of read_table() whenever you actually need the
    student-level data, not just the row-count metadata columns.
    """
    df = read_table(table_name)
    if not df.empty and "csv_file" in df.columns:
        df["csv_file"] = df["csv_file"].apply(
            lambda v: _decompress_csv(v) if pd.notna(v) else v
        )
    return df


def write_table(df: pd.DataFrame, table_name: str, if_exists: str = "append"):
    """
    Equivalent of df.to_csv(some_path). if_exists:
      - 'append'  : add rows (normal case — a new semester's data)
      - 'replace' : drop + recreate the table from this df, using
                    pandas' own inferred column types. Only use this on
                    a table you're fine having its schema overwritten —
                    for a manually-created, typed table you want kept
                    across rebuilds, use write_full_replace() instead.
    Only for plain typed-column tables — student_data / longform_grades
    are CSV-blob tables now (see write_semester_csv() below), not this.
    """
    df.to_sql(table_name, _engine, if_exists=if_exists, index=False)


def write_full_replace(df: pd.DataFrame, table_name: str):
    """
    Fully rebuilds `table_name` from `df` WITHOUT touching its schema —
    for the model-dataset tables (dropout_spike_cohort,
    gwa_ranking_college, etc.), which are meant to be manually created
    once via a CREATE TABLE script and then just have their rows
    refreshed on every training run, not dropped/recreated with
    whatever types pandas happens to infer that time.

    If the table already exists: TRUNCATE it, then insert `df`'s rows
    into the existing schema (to_sql(if_exists="append") — this fails
    loudly with "Unknown column ..." if df's columns don't match the
    table you created, which is the point: you'll notice immediately
    instead of the table quietly reshaping itself).

    If the table doesn't exist yet (no CREATE TABLE has been run for
    it): falls back to to_sql(if_exists="replace") so nothing breaks
    while you're getting the DDL in place — but that first
    auto-created shape is *not* preserved, since the next call, once
    the table exists, always requires a pre-existing schema.
    """
    if _table_exists(table_name):
        with _engine.begin() as conn:
            conn.exec_driver_sql(f"TRUNCATE TABLE {table_name}")
        df.to_sql(table_name, _engine, if_exists="append", index=False)
    else:
        df.to_sql(table_name, _engine, if_exists="replace", index=False)


def write_partial_replace(df: pd.DataFrame, table_name: str, key_columns: list[str]):
    """
    Same principle as upsert_semester_upload()/course_year_level_dropout:
    delete + re-insert only the rows for each distinct combination of
    `key_columns` (e.g. Year_Numeric[, Sem_Numeric]) present in `df`,
    each pair in its own atomic transaction — instead of
    write_full_replace()'s TRUNCATE, which wipes the WHOLE table first.
    A failure partway through only leaves the groups not yet written
    stale (old values), instead of the whole table sitting empty until
    every row re-inserts successfully.
    Falls back to write_full_replace() if the table doesn't exist yet.
    """
    if not _table_exists(table_name):
        write_full_replace(df, table_name)
        return
    for key_vals, group in df.groupby(key_columns):
        if not isinstance(key_vals, tuple):
            key_vals = (key_vals,)
        where = " AND ".join(f"`{c}` = %s" for c in key_columns)
        with _engine.begin() as conn:
            conn.exec_driver_sql(f"DELETE FROM {table_name} WHERE {where}", key_vals)
            group.to_sql(table_name, conn, if_exists="append", index=False)


# ══════════════════════════════════════════════════════════════════════════
#  TRAINED MODEL FILES (replaces Machine_Learning_Model/*.pkl on disk)
#  ──────────────────────────────────────────────────────────────────────
#  auto_train.py's _save()/joblib.dump(obj, path) and ml_analysis.py's
#  load_model()/joblib.load(path) used to read/write actual .pkl files
#  under ML_MODEL_DIR. That's the folder that kept filling up and never
#  emptied when the DB did. save_model_blob()/load_model_blob() below
#  are the drop-in MySQL replacement: same "one named thing in, the same
#  named thing back out" shape, just backed by a table instead of a
#  directory. And training_state.json — one JSON object — lives here too
#  under the fixed key "training_state". One table instead of two: both
#  are just "named blob of bytes in, same bytes back out", so they share
#  the same generic storage instead of needing their own schema each.
#
#  Requires this ONE table (run once in phpMyAdmin — not auto-created
#  here on purpose, same reasoning as the model_datasets tables above: a
#  missing table means "nothing stored yet", not a crash):
#
#    CREATE TABLE app_storage (
#      storage_key  VARCHAR(150) NOT NULL PRIMARY KEY,
#      data         LONGBLOB NOT NULL,
#      updated_at   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
#                   ON UPDATE CURRENT_TIMESTAMP
#    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
# ══════════════════════════════════════════════════════════════════════════

def _put_blob(key: str, data: bytes, _retries: int = 3) -> None:
    """Retries on dropped connections (MySQL 2006/2013 — e.g. blob bigger
    than max_allowed_packet, or a stale pooled connection). Disposes the
    pool before each retry so we don't just hand back the same dead
    connection; pool_pre_ping already covers most staleness but not a
    reset mid-INSERT."""
    import time
    from sqlalchemy.exc import OperationalError

    last_err = None
    for attempt in range(_retries):
        try:
            with _engine.begin() as conn:
                conn.execute(text("""
                    INSERT INTO app_storage (storage_key, data)
                    VALUES (:key, :data)
                    ON DUPLICATE KEY UPDATE data = :data, updated_at = CURRENT_TIMESTAMP
                """), {"key": key, "data": data})
            return
        except OperationalError as e:
            last_err = e
            _engine.dispose()  # drop the whole pool, force fresh connections
            if attempt < _retries - 1:
                time.sleep(2 ** attempt)  # 1s, 2s
    raise last_err


def _get_blob(key: str):
    if not _table_exists("app_storage"):
        return None
    with _engine.connect() as conn:
        row = conn.execute(
            text("SELECT data FROM app_storage WHERE storage_key = :key"),
            {"key": key},
        ).fetchone()
    return row[0] if row else None


def save_model_blob(model_name: str, obj) -> None:
    """Serializes `obj` with joblib straight into memory (no temp file)
    and upserts it into app_storage under key=model_name, replacing
    whatever was stored there before. This is what auto_train.py's
    _save() calls now instead of joblib.dump(obj, path) — the object
    never touches disk."""
    buf = io.BytesIO()
    joblib.dump(obj, buf)
    _put_blob(model_name, buf.getvalue())


def load_model_blob(model_name: str):
    """Inverse of save_model_blob(). Returns None if the table doesn't
    exist yet or has no row for this model_name — same "nothing trained
    yet" meaning as the old os.path.exists(path) check ml_analysis.py's
    load_model() used to do."""
    data = _get_blob(model_name)
    return joblib.load(io.BytesIO(data)) if data is not None else None


def delete_model_blob(model_name: str) -> None:
    """Removes one model's stored blob, if present. Mirrors deleting a
    single .pkl file used to. Safe no-op if the table or row doesn't
    exist."""
    if not _table_exists("app_storage"):
        return
    with _engine.begin() as conn:
        conn.execute(
            text("DELETE FROM app_storage WHERE storage_key = :key"),
            {"key": model_name},
        )


_TRAINING_STATE_KEY = "training_state"


def save_training_state(state: dict) -> None:
    """Used to write MODEL_DIR/training_state.json; now upserts the same
    JSON into app_storage under a fixed key, same table as the models."""
    _put_blob(_TRAINING_STATE_KEY, json.dumps(state).encode("utf-8"))


def load_training_state() -> dict:
    """Read training_state back out of app_storage; empty dict if not
    found (same meaning as training_state.json not existing yet did)."""
    data = _get_blob(_TRAINING_STATE_KEY)
    return json.loads(data.decode("utf-8")) if data is not None else {}


# ══════════════════════════════════════════════════════════════════════════
#  CSV-BLOB UPLOAD TABLES (semester_uploads, course_year_level_dropout)
#  ──────────────────────────────────────────────────────────────────────
#  upsert_semester_upload() is used by TWO tables, both with the identical
#  shape (academic_year, semester, student_rows, longform_rows, accuracy,
#  csv_file):
#
#    - semester_uploads: one row PER (academic_year, semester) upload.
#      `csv_file` is that semester's student-level CSV
#      (student_df.to_csv() — see write_semester_folder() in
#      preprocess.py). This table also backs count_distinct()/
#      count_rows() below for "how many years/semesters uploaded".
#
#    - course_year_level_dropout: one row PER (academic_year, semester),
#      same as semester_uploads -- `csv_file` is that semester's slice
#      of the Course x Year-Level Dropout Heatmap (grouped by
#      Year_Numeric/Sem_Numeric among other keys, so the heatmap data
#      already splits cleanly per semester). Rebuilt from the FULL
#      cumulative history on every upload, but written back out ONE
#      upsert per semester found in that history, each keyed by its own
#      real academic_year/semester -- NOT a combined single-row blob
#      under a fixed sentinel. See the "16 –" block in preprocess.py's
#      build_model_datasets().
#
#  NOTE (2026-09-15): course_year_level_dropout used to be misused to
#  hold what's now semester_uploads' data (wrong name for what was
#  stored). That was fixed by moving to the correctly-named
#  `semester_uploads` table (see migrate_semester_uploads.sql) —
#  course_year_level_dropout has since gone back to its own real job,
#  the heatmap CSV, stored per-semester the same way semester_uploads
#  is (an earlier version of this fix used one combined row under a
#  fixed ("ALL", "ALL") sentinel key instead — that collapsed every
#  semester into one blob, so uploading a single new file silently
#  overwrote the whole combined heatmap including every OTHER
#  semester's data; per-semester rows fix that).
#
#  `csv_file` is gzip+base64 compressed before being stored (see
#  _compress_csv() above) and must be read back through
#  read_semester_csvs(), not read_table() directly.
#
#  No UNIQUE constraint on either table, so "re-upload"/"rebuild" is
#  handled explicitly: delete any existing row for that key first, then
#  insert the new one.
# ══════════════════════════════════════════════════════════════════════════

def upsert_semester_upload(table_name: str, academic_year: str, semester: str,
                            student_rows: int, longform_rows: int,
                            accuracy: float | None = None,
                            csv_file: str | None = None):
    """
    Records (or re-records, on a re-upload) one semester's row counts —
    and its validation Accuracy percentage, if known — as a single small
    row in `table_name` (semester_uploads — see the module-level note
    above). `accuracy` is the % of grade cells in the
    source file that parsed cleanly into a real grade point (see
    preprocess.py's parse_sheet()/_accuracy_pct()); pass None when it
    isn't available. `csv_file` is the actual CSV TEXT of this
    semester's student-level dataset (same shape as dataset 01,
    "01_dropout_risk_per_student_dropout_pie_status_pie.csv" from
    build_model_datasets() — i.e. student_df.to_csv()), stored as-is in
    the `csv_file` LONGTEXT column; pass None when there's nothing to
    store. A re-upload of the same (academic_year, semester) deletes the
    old row first so it doesn't duplicate.

    FIX (2026-09-15): the delete and the insert used to run as two
    SEPARATE transactions (DELETE auto-committed via its own
    `_engine.begin()`, then a completely separate `to_sql()` call for
    the insert). `csv_file` can be a multi-megabyte blob (the full
    semester's student_df.to_csv()), so a mid-upload connection drop
    (e.g. "MySQL server has gone away" from max_allowed_packet or a
    timeout) during the INSERT left the DELETE permanently committed
    with no replacement row -- the semester's row silently vanished
    even though nothing was actually wrong with the parsed data.
    Both statements now run on the SAME connection inside ONE
    transaction: if the INSERT fails for any reason, the whole
    transaction (including the DELETE) rolls back, so a failed upload
    at worst leaves the OLD row untouched instead of leaving no row at
    all.

    FIX (2026-09-15, part 2): `csv_file` is now gzip+base64 compressed
    before it's sent to MySQL (see _compress_csv()). Even after raising
    max_allowed_packet server-side, a large upload can still overwhelm a
    modest XAMPP dev install (large single-statement allocation, or the
    transfer just takes long enough to hit wait_timeout). Compressing
    the blob shrinks what actually goes over the wire, which helps
    regardless of server tuning. Reading it back out must go through
    read_semester_csvs() below (or _decompress_csv() directly), not
    read_table() -- read_table() returns the raw compressed blob.
    """
    csv_file_stored = _compress_csv(csv_file) if csv_file is not None else None

    if not _table_exists(table_name):
        # First-ever upload: table doesn't exist yet, nothing to delete.
        # Let the normal to_sql path below create it.
        row = pd.DataFrame([{
            "academic_year": academic_year,
            "semester": semester,
            "student_rows": student_rows,
            "longform_rows": longform_rows,
            "accuracy": accuracy,
            "csv_file": csv_file_stored,
        }])
        # FIX (2026-09-15, part 6): without an explicit dtype, pandas/
        # SQLAlchemy auto-creates csv_file as plain MySQL TEXT (65,535
        # byte cap) on a brand-new table -- fine for a small blob, but a
        # large semester's compressed CSV (e.g. long-form/subject-level
        # data) silently gets truncated by MySQL on INSERT (non-strict
        # mode doesn't error), corrupting the gzip stream. Reading it
        # back then fails, which was breaking every model-dataset build
        # that runs after this table's read. Every OTHER CSV-blob table
        # here was manually created with `csv_file longtext` from the
        # start; this makes any NEW auto-created blob table match that,
        # instead of only working by accident for small blobs.
        row.to_sql(table_name, _engine, if_exists="append", index=False,
                   dtype={"csv_file": LONGTEXT})
        return

    with _engine.begin() as conn:
        conn.exec_driver_sql(
            f"DELETE FROM {table_name} WHERE academic_year = %s AND semester = %s",
            (academic_year, semester),
        )
        row = pd.DataFrame([{
            "academic_year": academic_year,
            "semester": semester,
            "student_rows": student_rows,
            "longform_rows": longform_rows,
            "accuracy": accuracy,
            "csv_file": csv_file_stored,
        }])
        # Pass `conn`, not `_engine` -- keeps the insert on the SAME
        # connection/transaction as the DELETE above, so `_engine.begin()`'s
        # automatic commit-on-success / rollback-on-exception covers both
        # statements together instead of just the DELETE alone.
        row.to_sql(table_name, conn, if_exists="append", index=False)


def delete_semester_upload(table_name: str, academic_year: str, semester: str):
    """
    Deletes one semester's metadata row outright (as opposed to
    upsert_semester_upload()'s delete-then-insert-in-place). Used by the
    one-step-back delete/restore flow when a semester needs to be
    removed rather than replaced. No-op if the table doesn't exist yet.
    Note: this only removes the row-count metadata row — the actual
    by_year/<academic_year>_<semester>/ folder on disk is deleted
    separately by the caller.
    """
    if not _table_exists(table_name):
        return
    with _engine.begin() as conn:
        conn.exec_driver_sql(
            f"DELETE FROM {table_name} WHERE academic_year = %s AND semester = %s",
            (academic_year, semester),
        )


def count_distinct(table_name: str, column: str) -> int:
    """COUNT(DISTINCT column) — e.g. count_distinct('semester_uploads',
    'academic_year') for how many academic years have any data uploaded,
    without pulling every CSV blob into memory just to count them.
    Returns 0 if the table doesn't exist yet (no upload so far)."""
    if not _table_exists(table_name):
        return 0
    result = pd.read_sql(f"SELECT COUNT(DISTINCT {column}) AS n FROM {table_name}", _engine)
    return int(result["n"].iloc[0])


def count_rows(table_name: str) -> int:
    """COUNT(*) — with one row per (academic_year, semester) upload in
    the CSV-blob tables, this doubles as 'how many semesters uploaded'.
    Returns 0 if the table doesn't exist yet."""
    if not _table_exists(table_name):
        return 0
    result = pd.read_sql(f"SELECT COUNT(*) AS n FROM {table_name}", _engine)
    return int(result["n"].iloc[0])


def record_trained_model(
    model_name: str,
    algorithm: str = None,
    target_column: str = None,
    source_dataset: str = None,
    file_path: str = None,
    status: str = "ok",
    error_message: str = None,
    r2_score: float = None,
    mse: float = None,
    rmse: float = None,
    mae: float = None,
    accuracy: float = None,
    f1_score: float = None,
    horizon_year: int = None,
):
    """
    Insert one row into trained_models — call this instead of / alongside
    joblib.dump() each time auto_train.py finishes training a model.
    The .pkl itself still lives on disk (file_path); this row is the
    queryable metadata + eval metrics record.

    `rmse`: FIX (2026-09-15) — every regressor trainer's _reg_metrics()
    bundle has always included rmse, but this function had no parameter
    for it (and the table had no column for it), so it was computed and
    thrown away every run. Requires the `rmse` column added by
    add_rmse_column.sql to exist on trained_models first.
    """
    row = pd.DataFrame([{
        "model_name": model_name,
        "algorithm": algorithm,
        "target_column": target_column,
        "source_dataset": source_dataset,
        "file_path": file_path,
        "status": status,
        "error_message": error_message,
        "r2_score": r2_score,
        "mse": mse,
        "rmse": rmse,
        "mae": mae,
        "accuracy": accuracy,
        "f1_score": f1_score,
        "horizon_year": horizon_year,
    }])
    row.to_sql("trained_models", _engine, if_exists="append", index=False)


def record_training_summary(
    total_students: int = None,
    gwa_mean: float = None,
    gwa_std: float = None,
    gwa_min: float = None,
    gwa_max: float = None,
    male_pct: float = None,
    female_pct: float = None,
    regular_pct: float = None,
    irregular_pct: float = None,
    models_trained: int = None,
    models_errored: int = None,
    horizon_year: int = None,
    training_status: str = None,
    elapsed_seconds: float = None,
):
    """
    Insert one row into `training_summary` — the "total summary of this
    validation run" table: the same dataset-level stats auto_train.py's
    _print_summary() prints to the console (sample size, GWA mean/std/
    range, gender split, regular/irregular split), plus a rollup of the
    run itself (models trained vs errored, horizon, overall status,
    elapsed time). One row per full training run — see
    create_training_summary_table.sql for the schema. Call this once,
    at the end of run_full_pipeline(), alongside (not instead of) the
    per-model record_trained_model() calls above: trained_models is
    per-model detail, training_summary is the run-level rollup.
    """
    row = pd.DataFrame([{
        "total_students":   total_students,
        "gwa_mean":         gwa_mean,
        "gwa_std":          gwa_std,
        "gwa_min":          gwa_min,
        "gwa_max":          gwa_max,
        "male_pct":         male_pct,
        "female_pct":       female_pct,
        "regular_pct":      regular_pct,
        "irregular_pct":    irregular_pct,
        "models_trained":   models_trained,
        "models_errored":   models_errored,
        "horizon_year":     horizon_year,
        "training_status":  training_status,
        "elapsed_seconds":  elapsed_seconds,
    }])
    row.to_sql("training_summary", _engine, if_exists="append", index=False)


def read_model_dataset(table_name: str) -> pd.DataFrame:
    """
    Rebuild one of the model-dataset tables (dropout_spike_cohort,
    gwa_ranking_college, kpi_gwa_student, etc.) from its per-semester
    CSV-blob rows -- same logic as auto_train.py's own
    _dataset_from_table() helper, exposed here so any other module
    (e.g. ml_metrics_routes.py's true-vs-predicted / feature-importance /
    residual-trend diagnostics) can read the EXACT same MySQL-backed data
    the trainers were fit on, instead of the retired on-disk
    Processed_Datasets/model_datasets/*.csv files (export_model_datasets()
    stopped writing those; out_dir is always None now).

    Returns an empty DataFrame if the table doesn't exist yet or has no
    rows, same as read_table()/read_semester_csvs().
    """
    rows = read_semester_csvs(table_name)
    if rows.empty or "csv_file" not in rows.columns:
        return pd.DataFrame()
    frames = [pd.read_csv(io.StringIO(text)) for text in rows["csv_file"].dropna()]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def latest_model_runs() -> pd.DataFrame:
    """One row per model_name — its most recent training run. Used by the
    Model Performance dashboard instead of parsing training_state.json."""
    query = """
        SELECT t.*
        FROM trained_models t
        INNER JOIN (
            SELECT model_name, MAX(trained_at) AS max_trained_at
            FROM trained_models
            GROUP BY model_name
        ) latest
        ON t.model_name = latest.model_name AND t.trained_at = latest.max_trained_at
    """
    return pd.read_sql(query, _engine)