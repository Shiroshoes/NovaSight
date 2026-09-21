"""
db_io.py — NovaSight data-access layer (updated)

Changes from original:
  - Added save_preprocessing_warnings() / get_preprocessing_warnings()
  - Added upsert_model_dataset() / get_model_dataset()
  - Added archive_semester() / restore_semester() / list_archives()
  - Added check_file_hash() / register_file_hash()
  - Added list_csv_files() for the file download modal
  - Added staged_uploads (stage_semester_upload / find_staged_upload_by_hash /
    restage_for_upload / load_staged_upload / delete_staged_upload) — the
    preprocessing result is parked here until the user confirms
  - Added save_training_run() / load_training_run() — lifecycle of the
    auto-training run, shown to the user at the end of the upload pipeline
  - file_hash duplicate detection is now actually wired up
    (check_file_hash / register_file_hash / find_live_upload_by_filename /
    purge_failed_uploads); a 'failed' upload no longer blocks a retry
  - Existing functions kept intact for backward compatibility
"""

import gzip
import base64
import hashlib
import io
import json
import joblib
import pandas as pd
from sqlalchemy import create_engine, inspect, text
from sqlalchemy.dialects.mysql import LONGTEXT

from configs.config import SQLALCHEMY_DATABASE_URI


# ── Compression helpers (unchanged) ─────────────────────────────────────
def _compress_csv(csv_text: str) -> str:
    raw = csv_text.encode("utf-8")
    compressed = gzip.compress(raw, compresslevel=6)
    return base64.b64encode(compressed).decode("ascii")


def _decompress_csv(blob: str) -> str:
    try:
        raw = base64.b64decode(blob)
        return gzip.decompress(raw).decode("utf-8")
    except Exception:
        return blob


_engine = create_engine(SQLALCHEMY_DATABASE_URI, pool_pre_ping=True, pool_recycle=280)


def get_engine():
    return _engine


def _table_exists(table_name: str) -> bool:
    return inspect(_engine).has_table(table_name)


# ── File hash — duplicate detection ─────────────────────────────────────

def compute_file_hash(filepath: str) -> str:
    """SHA-256 hash of the file content. Used for duplicate detection."""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _uploader_name_sql() -> str:
    return "TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, '')))"


def check_file_hash(file_hash: str) -> dict | None:
    """
    Returns the existing LIVE uploaded_dataset row (as a dict, incl.
    `uploader_name`) if a file with this content hash is already uploaded,
    else None. Caller shows a duplicate warning if not None.

    "Live" = not soft-deleted (archived) and not 'failed'. A failed upload
    produced no data, so it must not be reported as a duplicate — that was
    what made a retry of the same file impossible.
    """
    if not file_hash or not _table_exists("uploaded_dataset"):
        return None
    with _engine.connect() as conn:
        row = conn.execute(
            text(f"""
                SELECT d.id, d.original_filename, d.uploaded_at, d.academic_year,
                       d.semester, d.status, {_uploader_name_sql()} AS uploader_name
                FROM uploaded_dataset d
                LEFT JOIN acad_user u ON u.acaduser_id = d.uploaded_by
                WHERE d.file_hash = :h
                  AND d.is_deleted = 0
                  AND d.status IN {_BLOCKING_SQL}
                ORDER BY d.id DESC LIMIT 1
            """),
            {"h": file_hash},
        ).fetchone()
    return dict(row._mapping) if row else None


def find_live_upload_by_filename(canonical_name: str) -> dict | None:
    """
    Same idea as check_file_hash() but by filename (spaces == underscores).
    Ignores 'failed' and archived rows so they don't block a re-upload.
    """
    if not _table_exists("uploaded_dataset"):
        return None
    with _engine.connect() as conn:
        row = conn.execute(
            text(f"""
                SELECT d.id, d.original_filename, d.uploaded_at, d.academic_year,
                       d.semester, d.status, {_uploader_name_sql()} AS uploader_name
                FROM uploaded_dataset d
                LEFT JOIN acad_user u ON u.acaduser_id = d.uploaded_by
                WHERE REPLACE(d.original_filename, ' ', '_') = :n
                  AND d.is_deleted = 0
                  AND d.status IN {_BLOCKING_SQL}
                ORDER BY d.id DESC LIMIT 1
            """),
            {"n": canonical_name},
        ).fetchone()
    return dict(row._mapping) if row else None


def purge_failed_uploads(canonical_name: str) -> int:
    """
    Remove stale 'failed' uploaded_dataset rows for this filename so the retry
    can create a fresh record. Their preprocessing_warnings go with them
    (ON DELETE CASCADE). staged_uploads is deliberately NOT touched: a failed
    confirm still has its staged parse, and that is what lets the retry resume
    without re-parsing (see find_staged_upload_by_hash).
    Returns the number of rows removed.
    """
    if not _table_exists("uploaded_dataset"):
        return 0
    with _engine.begin() as conn:
        res = conn.execute(
            text("""DELETE FROM uploaded_dataset
                    WHERE status = 'failed' AND is_deleted = 0
                      AND REPLACE(original_filename, ' ', '_') = :n"""),
            {"n": canonical_name},
        )
    return res.rowcount or 0


def register_file_hash(upload_id: int, file_hash: str) -> bool:
    """
    Store the hash on the uploaded_dataset row. `unique_file_hash` is a UNIQUE
    key over ALL rows, so:
      - stale 'failed' rows holding the same hash are cleared first (junk);
      - if an archived (soft-deleted) row still holds it, the UPDATE would hit
        the unique key — we skip and return False instead of crashing the upload.
    Returns True if the hash was stored.
    """
    from sqlalchemy.exc import IntegrityError
    if not file_hash:
        return False
    try:
        with _engine.begin() as conn:
            conn.execute(
                text("""UPDATE uploaded_dataset SET file_hash = NULL
                        WHERE file_hash = :h AND status = 'failed' AND id <> :id"""),
                {"h": file_hash, "id": upload_id},
            )
            conn.execute(
                text("UPDATE uploaded_dataset SET file_hash = :h WHERE id = :id"),
                {"h": file_hash, "id": upload_id},
            )
        return True
    except IntegrityError:
        return False


# ── Preprocessing warnings ───────────────────────────────────────────────

def save_preprocessing_warnings(upload_id: int, warnings: list[dict]) -> None:
    """
    Bulk-insert all preprocessing warnings for an upload.
    Each warning dict must have: tier, category, message, ref (optional).
    Tier values: 'null' | 'highlight' | 'resolved'
    Called after preprocessing completes, before the confirmation modal.
    """
    if not warnings:
        return
    rows = [
        {
            "upload_id": upload_id,
            "tier":      w.get("tier", "resolved"),
            "category":  w.get("category", ""),
            "message":   w.get("message", ""),
            "ref":       w.get("ref"),
        }
        for w in warnings
    ]
    pd.DataFrame(rows).to_sql(
        "preprocessing_warnings", _engine, if_exists="append", index=False
    )


def get_preprocessing_warnings(upload_id: int) -> list[dict]:
    """
    Returns all warnings for an upload, sorted by tier priority:
    null → highlight → plain (most critical first).
    Used by the confirmation modal to display flagged rows.
    """
    if not _table_exists("preprocessing_warnings"):
        return []
    with _engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT tier, category, message, ref
                FROM preprocessing_warnings
                WHERE upload_id = :uid
                ORDER BY FIELD(tier, 'null', 'highlight', 'resolved'), id
            """),
            {"uid": upload_id},
        ).fetchall()
    return [dict(r._mapping) for r in rows]


def get_warning_counts(upload_id: int) -> dict:
    """Returns count per tier — for the modal header badge."""
    if not _table_exists("preprocessing_warnings"):
        return {"null": 0, "highlight": 0, "resolved": 0}
    with _engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT tier, COUNT(*) as cnt
                FROM preprocessing_warnings
                WHERE upload_id = :uid
                GROUP BY tier
            """),
            {"uid": upload_id},
        ).fetchall()
    counts = {"null": 0, "highlight": 0, "resolved": 0}
    for r in rows:
        counts[r.tier] = r.cnt
    return counts


def delete_preprocessing_warnings(upload_id: int) -> None:
    """Called when user cancels — removes all warnings for that upload."""
    if not _table_exists("preprocessing_warnings"):
        return
    with _engine.begin() as conn:
        conn.execute(
            text("DELETE FROM preprocessing_warnings WHERE upload_id = :uid"),
            {"uid": upload_id},
        )


# ── model_datasets — consolidated dataset storage ────────────────────────

# Maps dataset_key → human-readable name
DATASET_NAMES = {
    "DS00": "00_enrollment",
    "DS01": "01_kpi_student",
    "DS02": "02_heatmap_risk",
    "DS03": "03_gender_at_risk",
    "DS04": "04_hardest_subjects",
    "DS05": "05_at_risk_forecast",
    "DS06": "06_gwa_trend",
}


def upsert_model_dataset(
    dataset_key: str,
    academic_year: str,
    semester: str,
    df: pd.DataFrame,
    student_rows: int = None,
    accuracy: float = None,
) -> None:
    """
    Upsert one dataset CSV for a (dataset_key, academic_year, semester).
    Replaces the 16 individual upsert calls with one unified function.
    """
    csv_text = df.to_csv(index=False)
    csv_blob = _compress_csv(csv_text)
    dataset_name = DATASET_NAMES.get(dataset_key, dataset_key.lower())

    with _engine.begin() as conn:
        # delete existing row for this key+semester
        conn.execute(
            text("""
                DELETE FROM model_datasets
                WHERE dataset_key = :key
                  AND academic_year = :ay
                  AND semester = :sem
            """),
            {"key": dataset_key, "ay": academic_year, "sem": semester},
        )
        conn.execute(
            text("""
                INSERT INTO model_datasets
                  (dataset_key, dataset_name, academic_year, semester,
                   student_rows, longform_rows, accuracy, csv_file)
                VALUES
                  (:key, :name, :ay, :sem,
                   :srows, :lrows, :acc, :csv)
            """),
            {
                "key":   dataset_key,
                "name":  dataset_name,
                "ay":    academic_year,
                "sem":   semester,
                "srows": student_rows or len(df),
                "lrows": len(df),
                "acc":   accuracy,
                "csv":   csv_blob,
            },
        )


def get_model_dataset(
    dataset_key: str,
    academic_year: str = None,
    semester: str = None,
) -> pd.DataFrame:
    """
    Retrieve a model dataset. If academic_year/semester omitted, returns
    all semesters concatenated (same as export_datasets.py's multi-semester output).
    """
    if not _table_exists("model_datasets"):
        return pd.DataFrame()

    where = "WHERE dataset_key = :key"
    params: dict = {"key": dataset_key}
    if academic_year:
        where += " AND academic_year = :ay"
        params["ay"] = academic_year
    if semester:
        where += " AND semester = :sem"
        params["sem"] = semester

    with _engine.connect() as conn:
        rows = conn.execute(
            text(f"SELECT csv_file FROM model_datasets {where}"),
            params,
        ).fetchall()

    frames = []
    for r in rows:
        if r.csv_file:
            csv_text = _decompress_csv(r.csv_file)
            frames.append(pd.read_csv(io.StringIO(csv_text)))
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def list_model_dataset_files() -> list[dict]:
    """
    Returns metadata for the fileupload page's Training CSV table.
    One entry per (dataset_key, academic_year, semester).
    """
    if not _table_exists("model_datasets"):
        return []
    with _engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT dataset_key, dataset_name, academic_year, semester,
                       student_rows, accuracy,
                       (csv_file IS NOT NULL) AS has_csv
                FROM model_datasets
                ORDER BY academic_year, semester, dataset_key
            """)
        ).fetchall()
    return [dict(r._mapping) for r in rows]


# ── CSV file download ─────────────────────────────────────────────────────

def get_csv_for_download(
    table_type: str,
    academic_year: str,
    semester: str,
    dataset_key: str = None,
) -> str | None:
    """
    Returns decompressed CSV text for download.
    table_type: 'longform' | 'dataset' | 'archive'
    For 'dataset', also pass dataset_key (DS00–DS06).
    Returns None if not found.
    """
    # The Training CSV tab requests type=training. It was never handled here, so
    # every "View CSV" on that tab came back 404 "CSV not found". Training rows
    # are the student-level CSV in semester_uploads, same source as 'longform'.
    if table_type in ("longform", "training"):
        if not _table_exists("semester_uploads"):
            return None
        with _engine.connect() as conn:
            row = conn.execute(
                text("""
                    SELECT csv_file FROM semester_uploads
                    WHERE academic_year = :ay AND semester = :sem
                """),
                {"ay": academic_year, "sem": semester},
            ).fetchone()
        return _decompress_csv(row.csv_file) if row and row.csv_file else None

    elif table_type == "dataset" and dataset_key:
        if not _table_exists("model_datasets"):
            return None
        with _engine.connect() as conn:
            row = conn.execute(
                text("""
                    SELECT csv_file FROM model_datasets
                    WHERE dataset_key = :key
                      AND academic_year = :ay
                      AND semester = :sem
                """),
                {"key": dataset_key, "ay": academic_year, "sem": semester},
            ).fetchone()
        return _decompress_csv(row.csv_file) if row and row.csv_file else None

    return None


# ── CSV separation — by categorical ──────────────────────────────────────

def list_csv_separations(academic_year: str, semester: str) -> list[dict]:
    """
    Returns the list of available CSV separations for a semester.
    Each row is one (dataset_key × college/course group) from model_datasets.
    Used by the CSV Separation table in fileupload.html.
    """
    if not _table_exists("model_datasets"):
        return []
    with _engine.connect() as conn:
        rows = conn.execute(
            text("""
                SELECT dataset_key, dataset_name, academic_year, semester,
                       student_rows, accuracy,
                       (csv_file IS NOT NULL) AS has_csv
                FROM model_datasets
                WHERE academic_year = :ay AND semester = :sem
                ORDER BY dataset_key
            """),
            {"ay": academic_year, "sem": semester},
        ).fetchall()
    return [dict(r._mapping) for r in rows]


# ── staged_uploads — preprocessing result parked until the user confirms ───
#
# process_file_v2() writes here instead of into semester_uploads/longform_uploads.
# Confirming (_run_separation_and_train) loads it back and does the real write.
# Cancelling only has to delete this row. If the confirm step FAILS, the row is
# kept so re-uploading the same file resumes from it (matched by file_hash).
#
# Deliberately no FK to uploaded_dataset: purge_failed_uploads() deletes the
# failed record but the staged parse must survive it.

_STAGED_DDL = """
CREATE TABLE IF NOT EXISTS staged_uploads (
  id            INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  upload_id     INT NOT NULL,
  file_hash     VARCHAR(64) DEFAULT NULL,
  academic_year VARCHAR(20) NOT NULL,
  semester      VARCHAR(20) NOT NULL,
  student_rows  BIGINT DEFAULT NULL,
  longform_rows BIGINT DEFAULT NULL,
  accuracy      DECIMAL(5,2) DEFAULT NULL,
  student_csv   LONGTEXT NOT NULL COMMENT 'gzip+base64 student-level CSV',
  longform_csv  LONGTEXT NOT NULL COMMENT 'gzip+base64 subject-level CSV',
  warnings_json LONGTEXT DEFAULT NULL,
  staged_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_staged_upload (upload_id),
  KEY idx_staged_hash (file_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
"""
_STAGED_TTL_DAYS = 30
_staged_ready = False


def _ensure_staged_table() -> None:
    """Idempotent CREATE TABLE IF NOT EXISTS (novasight.sql predates this table)."""
    global _staged_ready
    if _staged_ready:
        return
    with _engine.begin() as conn:
        conn.exec_driver_sql(_STAGED_DDL)
    _staged_ready = True


def stage_semester_upload(
    upload_id: int,
    academic_year: str,
    semester: str,
    student_csv: str,
    longform_csv: str,
    student_rows: int | None = None,
    longform_rows: int | None = None,
    accuracy: float | None = None,
    file_hash: str | None = None,
    warnings_json: str | None = None,
) -> None:
    """Park a parsed upload. Replaces any earlier staged row for the same upload
    or the same file content, and sweeps rows older than _STAGED_TTL_DAYS."""
    _ensure_staged_table()
    with _engine.begin() as conn:
        conn.execute(
            text("DELETE FROM staged_uploads WHERE upload_id = :uid"),
            {"uid": upload_id},
        )
        if file_hash:
            conn.execute(
                text("DELETE FROM staged_uploads WHERE file_hash = :h"),
                {"h": file_hash},
            )
        conn.execute(
            text("DELETE FROM staged_uploads WHERE staged_at < NOW() - INTERVAL :d DAY"),
            {"d": _STAGED_TTL_DAYS},
        )
        conn.execute(
            text("""
                INSERT INTO staged_uploads
                  (upload_id, file_hash, academic_year, semester,
                   student_rows, longform_rows, accuracy,
                   student_csv, longform_csv, warnings_json)
                VALUES
                  (:uid, :h, :ay, :sem, :srows, :lrows, :acc, :scsv, :lcsv, :warn)
            """),
            {
                "uid": upload_id, "h": file_hash, "ay": academic_year, "sem": semester,
                "srows": None if student_rows is None else int(student_rows),
                "lrows": None if longform_rows is None else int(longform_rows),
                "acc":   None if accuracy is None else float(accuracy),
                "scsv": _compress_csv(student_csv),
                "lcsv": _compress_csv(longform_csv),
                "warn": warnings_json,
            },
        )


def load_staged_upload(upload_id: int) -> dict | None:
    """Full staged row for an upload, CSVs already decompressed
    (keys: student_csv, longform_csv, warnings_json, academic_year, semester,
    student_rows, longform_rows, accuracy, file_hash). None if not found."""
    if not _table_exists("staged_uploads"):
        return None
    with _engine.connect() as conn:
        row = conn.execute(
            text("SELECT * FROM staged_uploads WHERE upload_id = :uid"),
            {"uid": upload_id},
        ).fetchone()
    if not row:
        return None
    d = dict(row._mapping)
    d["student_csv"] = _decompress_csv(d["student_csv"])
    d["longform_csv"] = _decompress_csv(d["longform_csv"])
    return d


def find_staged_upload_by_hash(file_hash: str) -> dict | None:
    """
    Newest staged parse of this exact file, for the resume fast-path. Metadata
    + warnings_json only (no CSV blobs). Skips staged rows whose upload record
    is still alive (that's someone's in-progress upload, not an abandoned one).
    """
    if not file_hash or not _table_exists("staged_uploads"):
        return None
    with _engine.connect() as conn:
        row = conn.execute(
            text("""
                SELECT s.id, s.upload_id, s.file_hash, s.academic_year, s.semester,
                       s.student_rows, s.longform_rows, s.accuracy, s.warnings_json
                FROM staged_uploads s
                WHERE s.file_hash = :h
                  AND NOT EXISTS (SELECT 1 FROM uploaded_dataset d
                                  WHERE d.id = s.upload_id AND d.status <> 'failed')
                ORDER BY s.staged_at DESC, s.id DESC LIMIT 1
            """),
            {"h": file_hash},
        ).fetchone()
    return dict(row._mapping) if row else None


def restage_for_upload(old_staged: dict, new_upload_id: int) -> None:
    """Re-key a staged row (from find_staged_upload_by_hash) to the new upload id,
    so confirm-upload's load_staged_upload(new_id) finds it."""
    _ensure_staged_table()
    with _engine.begin() as conn:
        conn.execute(
            text("DELETE FROM staged_uploads WHERE upload_id = :uid AND id <> :id"),
            {"uid": new_upload_id, "id": old_staged["id"]},
        )
        conn.execute(
            text("UPDATE staged_uploads SET upload_id = :uid WHERE id = :id"),
            {"uid": new_upload_id, "id": old_staged["id"]},
        )


def delete_staged_upload(upload_id: int) -> None:
    """Drop the staged row — on cancel, or after a successful confirm."""
    if not _table_exists("staged_uploads"):
        return
    with _engine.begin() as conn:
        conn.execute(
            text("DELETE FROM staged_uploads WHERE upload_id = :uid"),
            {"uid": upload_id},
        )


# ── Archive / Restore ─────────────────────────────────────────────────────
#
# What a semester consists of (everything below must go INTO the archive and
# come back OUT of it, otherwise a restored semester is only half there):
#
#   uploaded_dataset          the upload record (soft-deleted on archive)
#   semester_uploads          student-level CSV      -> "Training CSV" tab
#   longform_uploads          subject-level CSV
#   model_datasets            DS00–DS06 chart CSVs   -> "CSV Separation" tab
#   preprocessing_warnings    null/highlight/plain   -> "Invalid / Flagged" tab
#
# The old archive only saved semester_uploads + DS01–DS06 and DELETED the
# warnings without saving them; restore then never un-deleted the
# uploaded_dataset row. The Training and Flagged tabs both JOIN on
# uploaded_dataset.is_deleted = 0, so they stayed empty after a restore even
# though the blobs were back — only the CSV Separation tab (which reads
# model_datasets directly) showed anything.

# Columns added to dataset_archives (schema.sql only has the legacy ones).
_ARCHIVE_EXTRA_COLUMNS = {
    "upload_id":            "INT NULL",
    "csv_ds00":             "LONGTEXT NULL",   # DS00 enrollment (was never archived)
    "csv_subject_longform": "LONGTEXT NULL",   # longform_uploads blob
    "warnings_json":        "LONGTEXT NULL",   # preprocessing_warnings rows
    "snapshot_meta_json":   "LONGTEXT NULL",   # upload record + per-table row counts/accuracy
}
_archive_cols_ready = False


def _ensure_archive_columns() -> None:
    """Idempotent: add the extra dataset_archives columns if they're missing."""
    global _archive_cols_ready
    if _archive_cols_ready or not _table_exists("dataset_archives"):
        return
    with _engine.connect() as conn:
        existing = {
            str(r[0]).lower() for r in conn.execute(text("""
                SELECT COLUMN_NAME FROM information_schema.COLUMNS
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'dataset_archives'
            """)).fetchall()
        }
    missing = {k: v for k, v in _ARCHIVE_EXTRA_COLUMNS.items() if k.lower() not in existing}
    if missing:
        with _engine.begin() as conn:
            for name, ddl in missing.items():
                conn.execute(text(f"ALTER TABLE dataset_archives ADD COLUMN `{name}` {ddl}"))
    _archive_cols_ready = True


# An upload for the same semester only stands in the way of a restore while it is
# alive. A cancelled upload is hard-deleted and a failed one never produced
# data, so neither counts.
_BLOCKING_STATUSES = ("pending", "processing", "preprocessing_done", "separating", "done")
_BLOCKING_SQL = "(" + ",".join(f"'{s}'" for s in _BLOCKING_STATUSES) + ")"


def _blocking_upload_statuses(conn, academic_year: str, semester: str) -> list[str]:
    rows = conn.execute(
        text(f"""SELECT status FROM uploaded_dataset
                 WHERE academic_year = :ay AND semester = :sem
                   AND is_deleted = 0 AND status IN {_BLOCKING_SQL}"""),
        {"ay": academic_year, "sem": semester},
    ).fetchall()
    return [r[0] for r in rows]


def _jdump(obj) -> str:
    return json.dumps(obj, default=str)


def _num(v, cast=float):
    """JSON round-trips Decimals as strings — turn them back into numbers."""
    if v is None or v == "":
        return None
    try:
        return cast(v)
    except (TypeError, ValueError):
        return None


def _fetch_blob_row(conn, table: str, academic_year: str, semester: str) -> dict | None:
    if not _table_exists(table):
        return None
    row = conn.execute(
        text(f"""SELECT student_rows, longform_rows, accuracy, csv_file
                 FROM {table} WHERE academic_year = :ay AND semester = :sem"""),
        {"ay": academic_year, "sem": semester},
    ).fetchone()
    return dict(row._mapping) if row else None


def archive_semester(
    upload_id: int,
    academic_year: str,
    semester: str,
    archived_by: int,
) -> int:
    """
    Archives EVERYTHING for a (academic_year, semester) in one transaction:
      - student-level CSV (semester_uploads)      -> csv_longform (legacy name)
      - subject-level CSV (longform_uploads)      -> csv_subject_longform
      - DS00–DS06 (model_datasets)                -> csv_ds00 … csv_ds06
      - preprocessing warnings                    -> warnings_json
      - upload record + row counts / accuracy     -> snapshot_meta_json
    then removes them from the live tables and soft-deletes the upload record.
    Returns the new archive id.
    """
    _ensure_archive_columns()

    with _engine.begin() as conn:
        # ── read ────────────────────────────────────────────────────────
        urow = conn.execute(
            text("SELECT * FROM uploaded_dataset WHERE id = :id"), {"id": upload_id}
        ).fetchone()
        upload = dict(urow._mapping) if urow else {}

        su = _fetch_blob_row(conn, "semester_uploads", academic_year, semester)
        lu = _fetch_blob_row(conn, "longform_uploads", academic_year, semester)

        ds = {}
        if _table_exists("model_datasets"):
            for r in conn.execute(
                text("""SELECT dataset_key, dataset_name, student_rows, longform_rows,
                               accuracy, csv_file
                        FROM model_datasets
                        WHERE academic_year = :ay AND semester = :sem"""),
                {"ay": academic_year, "sem": semester},
            ).fetchall():
                ds[r.dataset_key] = dict(r._mapping)

        warnings = []
        if _table_exists("preprocessing_warnings"):
            warnings = [
                dict(r._mapping) for r in conn.execute(
                    text("""SELECT tier, category, message, ref
                            FROM preprocessing_warnings
                            WHERE upload_id = :uid ORDER BY id"""),
                    {"uid": upload_id},
                ).fetchall()
            ]

        def _meta(row):
            return None if row is None else {
                k: row.get(k) for k in ("student_rows", "longform_rows", "accuracy")}

        snapshot = {
            "version":          2,
            "upload":           upload,
            "semester_uploads": _meta(su),
            "longform_uploads": _meta(lu),
            "model_datasets":   {k: _meta(v) | {"dataset_name": v.get("dataset_name")}
                                 for k, v in ds.items()},
        }

        # ── write archive row ───────────────────────────────────────────
        result = conn.execute(
            text("""
                INSERT INTO dataset_archives
                  (original_filename, academic_year, semester, file_hash,
                   student_rows, archived_by, upload_id,
                   csv_longform, csv_subject_longform,
                   csv_ds00, csv_ds01, csv_ds02, csv_ds03,
                   csv_ds04, csv_ds05, csv_ds06,
                   warnings_json, snapshot_meta_json, restore_blocked)
                VALUES
                  (:fname, :ay, :sem, :fhash,
                   :srows, :by, :uid,
                   :lf, :sublf,
                   :d0, :d1, :d2, :d3, :d4, :d5, :d6,
                   :warn, :snap, 0)
            """),
            {
                "fname": upload.get("original_filename") or "",
                "ay": academic_year, "sem": semester,
                "fhash": upload.get("file_hash"),
                "srows": upload.get("row_count"),
                "by": archived_by, "uid": upload_id,
                "lf":    su["csv_file"] if su else None,
                "sublf": lu["csv_file"] if lu else None,
                "d0": ds.get("DS00", {}).get("csv_file"),
                "d1": ds.get("DS01", {}).get("csv_file"),
                "d2": ds.get("DS02", {}).get("csv_file"),
                "d3": ds.get("DS03", {}).get("csv_file"),
                "d4": ds.get("DS04", {}).get("csv_file"),
                "d5": ds.get("DS05", {}).get("csv_file"),
                "d6": ds.get("DS06", {}).get("csv_file"),
                "warn": _jdump(warnings) if warnings else None,
                "snap": _jdump(snapshot),
            },
        )
        archive_id = result.lastrowid

        # ── remove from live tables ─────────────────────────────────────
        # (longform_uploads was never cleaned up before, so an archived
        #  semester's subject rows kept feeding everything that reads it.)
        for table in ("semester_uploads", "longform_uploads", "model_datasets"):
            if _table_exists(table):
                conn.execute(
                    text(f"DELETE FROM {table} WHERE academic_year = :ay AND semester = :sem"),
                    {"ay": academic_year, "sem": semester},
                )
        if _table_exists("preprocessing_warnings"):
            conn.execute(text("DELETE FROM preprocessing_warnings WHERE upload_id = :uid"),
                         {"uid": upload_id})

        conn.execute(
            text("UPDATE uploaded_dataset SET is_deleted = 1, deleted_at = NOW() WHERE id = :id"),
            {"id": upload_id},
        )

    return archive_id


def restore_semester(archive_id: int) -> dict:
    """
    Restore a semester from archive — ALL of it:
      upload record (un-deleted, or recreated if it was purged), Training CSV,
      subject-level longform, DS00–DS06, and the flagged warnings.

    Blocked if the same academic_year+semester already has an active upload.
    Returns {'ok': True, 'restored': [...], 'missing': [...], 'partial': bool}
    or {'ok': False, 'reason': str}.

    Archives made before this change didn't store DS00, subject-level
    longform or warnings, so those come back in `missing` — the data simply
    isn't in the archive; re-uploading the .xlsx regenerates it.
    """
    if not _table_exists("dataset_archives"):
        return {"ok": False, "reason": "Archive table not found."}
    _ensure_archive_columns()

    with _engine.connect() as conn:
        row = conn.execute(
            text("SELECT * FROM dataset_archives WHERE id = :id"), {"id": archive_id}
        ).fetchone()
    if not row:
        return {"ok": False, "reason": "Archive record not found."}
    a = dict(row._mapping)
    ay, sem = a["academic_year"], a["semester"]

    # Blocking is worked out from what is in uploaded_dataset RIGHT NOW instead of
    # a sticky restore_blocked flag. The old flag was set the moment a file for
    # this semester was *uploaded* (before the confirmation modal), so cancelling
    # that upload left the archive blocked forever.
    with _engine.connect() as conn:
        statuses = _blocking_upload_statuses(conn, ay, sem)
    if "done" in statuses:
        return {"ok": False, "reason":
                f"Cannot restore — {ay} {sem} has already been re-uploaded with a new file."}
    if statuses:
        return {"ok": False, "reason":
                f"Cannot restore yet — a new upload for {ay} {sem} is still in progress. "
                "Finish or cancel it, then try again."}

    snap = json.loads(a["snapshot_meta_json"]) if a.get("snapshot_meta_json") else {}
    up_meta = snap.get("upload") or {}
    restored, missing = [], []

    with _engine.begin() as conn:
        # ── 1. upload record — the Training + Flagged tabs JOIN on this ─────
        found = None
        if a.get("upload_id"):
            found = conn.execute(
                text("SELECT id FROM uploaded_dataset WHERE id = :id"),
                {"id": a["upload_id"]}).fetchone()
        if not found and a.get("file_hash"):
            found = conn.execute(
                text("""SELECT id FROM uploaded_dataset
                        WHERE file_hash = :h AND academic_year = :ay AND semester = :sem
                        ORDER BY id DESC LIMIT 1"""),
                {"h": a["file_hash"], "ay": ay, "sem": sem}).fetchone()
        if not found:                       # legacy archive: newest soft-deleted 'done' upload
            found = conn.execute(
                text("""SELECT id FROM uploaded_dataset
                        WHERE academic_year = :ay AND semester = :sem
                          AND is_deleted = 1 AND status = 'done'
                        ORDER BY deleted_at DESC, id DESC LIMIT 1"""),
                {"ay": ay, "sem": sem}).fetchone()

        if found:
            upload_id = found[0]
            conn.execute(
                text("""UPDATE uploaded_dataset
                        SET is_deleted = 0, deleted_at = NULL,
                            status = 'done', processed = 1
                        WHERE id = :id"""),
                {"id": upload_id})
        else:                               # row was purged (30-day expiry) — recreate it
            res = conn.execute(
                text("""
                    INSERT INTO uploaded_dataset
                      (original_filename, raw_path, processed, processed_path, status,
                       uploaded_at, uploaded_by, academic_year, semester,
                       file_size_kb, sheet_count, row_count, training_row_count,
                       excluded_row_count, accuracy, file_hash, is_deleted)
                    VALUES
                      (:fname, :raw, 1, :proc, 'done',
                       COALESCE(:up_at, NOW()), :up_by, :ay, :sem,
                       :kb, :sheets, :rows, :trows, :xrows, :acc, :fhash, 0)
                """),
                {
                    "fname":  up_meta.get("original_filename") or a.get("original_filename") or "restored.xlsx",
                    "raw":    up_meta.get("raw_path") or "",
                    "proc":   up_meta.get("processed_path"),
                    "up_at":  up_meta.get("uploaded_at"),
                    "up_by":  up_meta.get("uploaded_by") or a.get("archived_by"),
                    "ay": ay, "sem": sem,
                    "kb":     _num(up_meta.get("file_size_kb")),
                    "sheets": _num(up_meta.get("sheet_count"), int),
                    "rows":   _num(up_meta.get("row_count"), int) or a.get("student_rows"),
                    "trows":  _num(up_meta.get("training_row_count"), int),
                    "xrows":  _num(up_meta.get("excluded_row_count"), int),
                    "acc":    _num(up_meta.get("accuracy")),
                    "fhash":  up_meta.get("file_hash") or a.get("file_hash"),
                },
            )
            upload_id = res.lastrowid
        restored.append("Upload record")

        # ── 2. Training CSV (student-level) + subject-level longform ────────
        for table, blob_col, label, meta_key in (
            ("semester_uploads", "csv_longform",         "Training CSV",         "semester_uploads"),
            ("longform_uploads", "csv_subject_longform", "Subject-level CSV",    "longform_uploads"),
        ):
            blob = a.get(blob_col)
            if not blob:
                missing.append(label)
                continue
            if not _table_exists(table):
                missing.append(f"{label} (table '{table}' missing)")
                continue
            m = snap.get(meta_key) or {}
            conn.execute(text(f"DELETE FROM {table} WHERE academic_year = :ay AND semester = :sem"),
                         {"ay": ay, "sem": sem})
            conn.execute(
                text(f"""INSERT INTO {table}
                           (academic_year, semester, student_rows, longform_rows, accuracy, csv_file)
                         VALUES (:ay, :sem, :srows, :lrows, :acc, :csv)"""),
                {"ay": ay, "sem": sem,
                 "srows": _num(m.get("student_rows"), int) or a.get("student_rows"),
                 "lrows": _num(m.get("longform_rows"), int),
                 "acc":   _num(m.get("accuracy")),
                 "csv":   blob},
            )
            restored.append(label)

        # ── 3. Chart datasets DS00–DS06 ─────────────────────────────────────
        if _table_exists("model_datasets"):
            conn.execute(text("DELETE FROM model_datasets WHERE academic_year = :ay AND semester = :sem"),
                         {"ay": ay, "sem": sem})
            ds_meta = snap.get("model_datasets") or {}
            got, lost = [], []
            for key in ("DS00", "DS01", "DS02", "DS03", "DS04", "DS05", "DS06"):
                blob = a.get(f"csv_{key.lower()}")
                if not blob:
                    lost.append(key)
                    continue
                m = ds_meta.get(key) or {}
                conn.execute(
                    text("""INSERT INTO model_datasets
                              (dataset_key, dataset_name, academic_year, semester,
                               student_rows, longform_rows, accuracy, csv_file)
                            VALUES (:key, :name, :ay, :sem, :srows, :lrows, :acc, :csv)"""),
                    {"key": key, "name": m.get("dataset_name") or DATASET_NAMES.get(key, key),
                     "ay": ay, "sem": sem,
                     "srows": _num(m.get("student_rows"), int) or a.get("student_rows"),
                     "lrows": _num(m.get("longform_rows"), int),
                     "acc":   _num(m.get("accuracy")),
                     "csv":   blob},
                )
                got.append(key)
            if got:
                restored.append(f"Chart datasets ({', '.join(got)})")
            if lost:
                missing.append(f"Chart datasets ({', '.join(lost)})")
        else:
            missing.append("Chart datasets (table 'model_datasets' missing)")

        # ── 4. Flagged / warning rows ───────────────────────────────────────
        if a.get("warnings_json"):
            warns = json.loads(a["warnings_json"])
            conn.execute(text("DELETE FROM preprocessing_warnings WHERE upload_id = :uid"),
                         {"uid": upload_id})
            for w in warns:
                conn.execute(
                    text("""INSERT INTO preprocessing_warnings (upload_id, tier, category, message, ref)
                            VALUES (:uid, :tier, :cat, :msg, :ref)"""),
                    {"uid": upload_id, "tier": w.get("tier", "resolved"),
                     "cat": w.get("category", ""), "msg": w.get("message", ""),
                     "ref": w.get("ref")},
                )
            restored.append(f"Flagged warnings ({len(warns)})")
        elif snap:
            restored.append("Flagged warnings (none were recorded)")
        else:
            missing.append("Flagged warnings")

        # ── 5. done — drop the archive row ──────────────────────────────────
        conn.execute(text("DELETE FROM dataset_archives WHERE id = :id"), {"id": archive_id})

    return {"ok": True, "upload_id": upload_id, "restored": restored,
            "missing": missing, "partial": bool(missing)}


def list_archives() -> list[dict]:
    """All archived semesters for the archive panel in fileupload.html."""
    if not _table_exists("dataset_archives"):
        return []
    _ensure_archive_columns()
    with _engine.connect() as conn:
        rows = conn.execute(
            text(f"""
                SELECT a.id, a.original_filename, a.academic_year, a.semester,
                       a.student_rows, a.archived_at,
                       EXISTS (SELECT 1 FROM uploaded_dataset d
                               WHERE d.academic_year = a.academic_year
                                 AND d.semester = a.semester
                                 AND d.is_deleted = 0
                                 AND d.status IN {_BLOCKING_SQL}) AS restore_blocked,
                       (a.snapshot_meta_json IS NOT NULL) AS is_complete,
                       u.first_name, u.last_name
                FROM dataset_archives a
                LEFT JOIN acad_user u ON a.archived_by = u.acaduser_id
                ORDER BY a.archived_at DESC
            """)
        ).fetchall()
    return [dict(r._mapping) for r in rows]


def mark_archives_blocked(academic_year: str, semester: str) -> None:
    """
    Kept only so existing imports keep working. It used to flip a permanent
    restore_blocked = 1 flag, and the upload route called it as soon as a file
    was uploaded — before the user had confirmed anything — so cancelling the
    upload still left the archive blocked. Whether an archive can be restored
    is now derived from the live uploaded_dataset rows (see
    _blocking_upload_statuses), so there is nothing to record here.
    """
    return None


def purge_semester_data(academic_year: str, semester: str) -> None:
    """
    Remove everything preprocessing/separation wrote for one semester
    (student CSV, subject-level CSV, DS00–DS06). Used when an unconfirmed
    upload is cancelled, so it doesn't linger in the tables training reads.
    """
    with _engine.begin() as conn:
        for table in ("semester_uploads", "longform_uploads", "model_datasets"):
            if _table_exists(table):
                conn.execute(
                    text(f"DELETE FROM {table} WHERE academic_year = :ay AND semester = :sem"),
                    {"ay": academic_year, "sem": semester},
                )


# ══════════════════════════════════════════════════════════════
# EXISTING FUNCTIONS — unchanged, kept for backward compatibility
# ══════════════════════════════════════════════════════════════

# Tables cleared during a full database reset.
# dataset_archives is excluded — archives are user data, not pipeline data.
# acad_user and uploaded_dataset are excluded — managed separately via ORM.
RESET_TABLES = [
    "app_storage",              # trained model blobs + training_state
    "semester_uploads",         # per-semester student CSV blobs
    "longform_uploads",         # per-semester subject-level CSV blobs
    "model_datasets",           # DS00-DS06 chart datasets
    "preprocessing_warnings",   # flagged rows from preprocessing
    "staged_uploads",           # parsed-but-unconfirmed uploads (resume cache)
    "trained_models",           # per-model eval metrics
    "training_summary",         # per-run training stats
]


def reset_all_data() -> None:
    with _engine.begin() as conn:
        for table_name in RESET_TABLES:
            if _table_exists(table_name):
                conn.exec_driver_sql(f"TRUNCATE TABLE {table_name}")


def read_table(table_name: str, where: str = None) -> pd.DataFrame:
    if not _table_exists(table_name):
        return pd.DataFrame()
    query = f"SELECT * FROM {table_name}"
    if where:
        query += f" WHERE {where}"
    return pd.read_sql(query, _engine)


def read_semester_csvs(table_name: str) -> pd.DataFrame:
    df = read_table(table_name)
    if not df.empty and "csv_file" in df.columns:
        df["csv_file"] = df["csv_file"].apply(
            lambda v: _decompress_csv(v) if pd.notna(v) else v
        )
    return df


def write_table(df: pd.DataFrame, table_name: str, if_exists: str = "append"):
    df.to_sql(table_name, _engine, if_exists=if_exists, index=False)


def write_full_replace(df: pd.DataFrame, table_name: str):
    if _table_exists(table_name):
        with _engine.begin() as conn:
            conn.exec_driver_sql(f"TRUNCATE TABLE {table_name}")
        df.to_sql(table_name, _engine, if_exists="append", index=False)
    else:
        df.to_sql(table_name, _engine, if_exists="replace", index=False)


def write_partial_replace(df: pd.DataFrame, table_name: str, key_columns: list[str]):
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


def _put_blob(key: str, data: bytes, _retries: int = 3) -> None:
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
            _engine.dispose()
            if attempt < _retries - 1:
                time.sleep(2 ** attempt)
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
    buf = io.BytesIO()
    joblib.dump(obj, buf)
    _put_blob(model_name, buf.getvalue())


def load_model_blob(model_name: str):
    data = _get_blob(model_name)
    return joblib.load(io.BytesIO(data)) if data is not None else None


def delete_model_blob(model_name: str) -> None:
    if not _table_exists("app_storage"):
        return
    with _engine.begin() as conn:
        conn.execute(
            text("DELETE FROM app_storage WHERE storage_key = :key"),
            {"key": model_name},
        )


_TRAINING_STATE_KEY = "training_state"


def save_training_state(state: dict) -> None:
    _put_blob(_TRAINING_STATE_KEY, json.dumps(state).encode("utf-8"))


def load_training_state() -> dict:
    data = _get_blob(_TRAINING_STATE_KEY)
    return json.loads(data.decode("utf-8")) if data is not None else {}


# Auto-training run tracker. auto_train.py owns "training_state" (metrics of the
# last finished run); this is a separate, tiny record of the CURRENT/last run's
# lifecycle (queued -> running -> done/failed) so the upload page can follow it.
_TRAINING_RUN_KEY = "training_run"


def save_training_run(run: dict) -> None:
    _put_blob(_TRAINING_RUN_KEY, json.dumps(run, default=str).encode("utf-8"))


def load_training_run() -> dict:
    data = _get_blob(_TRAINING_RUN_KEY)
    return json.loads(bytes(data).decode("utf-8")) if data is not None else {}


def upsert_semester_upload(
    table_name: str, academic_year: str, semester: str,
    student_rows: int, longform_rows: int,
    accuracy: float | None = None, csv_file: str | None = None,
):
    csv_file_stored = _compress_csv(csv_file) if csv_file is not None else None
    if not _table_exists(table_name):
        row = pd.DataFrame([{
            "academic_year": academic_year, "semester": semester,
            "student_rows": student_rows, "longform_rows": longform_rows,
            "accuracy": accuracy, "csv_file": csv_file_stored,
        }])
        row.to_sql(table_name, _engine, if_exists="append", index=False,
                   dtype={"csv_file": LONGTEXT})
        return
    with _engine.begin() as conn:
        conn.exec_driver_sql(
            f"DELETE FROM {table_name} WHERE academic_year = %s AND semester = %s",
            (academic_year, semester),
        )
        row = pd.DataFrame([{
            "academic_year": academic_year, "semester": semester,
            "student_rows": student_rows, "longform_rows": longform_rows,
            "accuracy": accuracy, "csv_file": csv_file_stored,
        }])
        row.to_sql(table_name, conn, if_exists="append", index=False)


def delete_semester_upload(table_name: str, academic_year: str, semester: str):
    if not _table_exists(table_name):
        return
    with _engine.begin() as conn:
        conn.exec_driver_sql(
            f"DELETE FROM {table_name} WHERE academic_year = %s AND semester = %s",
            (academic_year, semester),
        )


def count_distinct(table_name: str, column: str) -> int:
    if not _table_exists(table_name):
        return 0
    result = pd.read_sql(
        f"SELECT COUNT(DISTINCT {column}) AS n FROM {table_name}", _engine)
    return int(result["n"].iloc[0])


def count_rows(table_name: str) -> int:
    if not _table_exists(table_name):
        return 0
    result = pd.read_sql(f"SELECT COUNT(*) AS n FROM {table_name}", _engine)
    return int(result["n"].iloc[0])


def record_trained_model(
    model_name, algorithm=None, target_column=None, source_dataset=None,
    file_path=None, status="ok", error_message=None, r2_score=None,
    mse=None, rmse=None, mae=None, accuracy=None, f1_score=None,
    horizon_year=None,
):
    row = pd.DataFrame([{
        "model_name": model_name, "algorithm": algorithm,
        "target_column": target_column, "source_dataset": source_dataset,
        "file_path": file_path, "status": status,
        "error_message": error_message, "r2_score": r2_score,
        "mse": mse, "rmse": rmse, "mae": mae, "accuracy": accuracy,
        "f1_score": f1_score, "horizon_year": horizon_year,
    }])
    row.to_sql("trained_models", _engine, if_exists="append", index=False)


def record_training_summary(
    total_students=None, gwa_mean=None, gwa_std=None, gwa_min=None,
    gwa_max=None, male_pct=None, female_pct=None, regular_pct=None,
    irregular_pct=None, models_trained=None, models_errored=None,
    horizon_year=None, training_status=None, elapsed_seconds=None,
):
    row = pd.DataFrame([{
        "total_students": total_students, "gwa_mean": gwa_mean,
        "gwa_std": gwa_std, "gwa_min": gwa_min, "gwa_max": gwa_max,
        "male_pct": male_pct, "female_pct": female_pct,
        "regular_pct": regular_pct, "irregular_pct": irregular_pct,
        "models_trained": models_trained, "models_errored": models_errored,
        "horizon_year": horizon_year, "training_status": training_status,
        "elapsed_seconds": elapsed_seconds,
    }])
    row.to_sql("training_summary", _engine, if_exists="append", index=False)


def read_model_dataset(table_name: str) -> pd.DataFrame:
    rows = read_semester_csvs(table_name)
    if rows.empty or "csv_file" not in rows.columns:
        return pd.DataFrame()
    frames = [pd.read_csv(io.StringIO(t)) for t in rows["csv_file"].dropna()]
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def latest_model_runs() -> pd.DataFrame:
    query = """
        SELECT t.* FROM trained_models t
        INNER JOIN (
            SELECT model_name, MAX(trained_at) AS max_trained_at
            FROM trained_models GROUP BY model_name
        ) latest ON t.model_name = latest.model_name
               AND t.trained_at = latest.max_trained_at
    """
    return pd.read_sql(query, _engine)