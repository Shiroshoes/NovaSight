import os
import re
import time
import threading

from flask import Blueprint, request, jsonify, session, render_template, current_app
from werkzeug.utils import secure_filename

from database.models import db, AcadUser, UploadedDataset
from util.db_io import list_model_dataset_files
from configs.config import (
    UNPROCESSED_DATASETS_DIR,
    PROCESSED_DATASETS_DIR,
    PROCESSED_BY_YEAR_DIR,
    MODEL_DATASETS_DIR,
    FINAL_MERGED_CSV,
    DATASET_ALLOWED_EXTENSIONS,
    DATASET_MAX_SIZE_MB,
    DATASET_FILENAME_REGEX,
    UPLOAD_ALLOWED_ROLES,
    MIN_SEMESTERS_FOR_TRAINING,
)
from training.auto_train import (
    run_full_pipeline, load_state, MODEL_DIR as ML_MODEL_DIR,
)

upload_bp = Blueprint('upload_bp', __name__)


# ── Auth gate ─────────────────────────────────────────────────────────────
# CRITICAL FIX: /api/failed-uploads, /api/upload-status, /api/training-state,
# /api/model-performance, /api/unprocessed-list, and /api/processed-list had
# NO session check at all — fully public, and leaking uploader names and
# real server filesystem paths (raw_path/processed_path) to anyone. This is
# a FLOOR requirement (must be logged in) that sits underneath the stricter
# per-route role checks other routes in this file already have (e.g.
# UPLOAD_ALLOWED_ROLES for uploading) — those still run as before, just
# with this baseline added under everything.
@upload_bp.before_request
def _require_login():
    if 'user_id' not in session:
        return jsonify({'ok': False, 'error': 'Not logged in.'}), 401


# ─────────────────────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────────────────────

def _current_user():
    uid = session.get('user_id')
    return AcadUser.query.get(uid) if uid else None


def _validate_dataset_file(filename: str) -> tuple[bool, str]:
    """
    Two-rule validation:
      1. Extension must be .xlsx
      2. Filename must match DATASET_FILENAME_REGEX
         (YYYY-N[_ ]Student-Performance[_ ]Dataset.xlsx)
    No file size limit.
    """
    ext = filename.rsplit('.', 1)[-1].lower() if '.' in filename else ''
    if ext not in DATASET_ALLOWED_EXTENSIONS:
        return False, (
            f"Invalid file type <code>.{ext}</code>. "
            "Only <strong>.xlsx</strong> grade-sheet workbooks are accepted."
        )

    if not DATASET_FILENAME_REGEX.match(filename):
        return False, (
            "Filename does not match the required format.<br>"
            "Expected: <strong>YYYY-N Student-Performance Dataset.xlsx</strong><br>"
            "Where <strong>N</strong> is <code>1</code> (1st sem) or <code>2</code> (2nd sem).<br>"
            "Examples:<br>"
            "&nbsp;&nbsp;• <code>2022-1 Student-Performance Dataset.xlsx</code><br>"
            "&nbsp;&nbsp;• <code>2025-2 Student-Performance Dataset.xlsx</code><br>"
            f"Received: <code>{filename}</code>"
        )

    return True, ''


def _parse_filename_meta(filename: str) -> tuple[str, str]:
    """
    Parse academic year and semester from filename.
    '2022-1 Student-Performance Dataset.xlsx'  →  ('2022-2023', '1sem')
    '2023-2_Student-Performance_Dataset.xlsx'  →  ('2023-2024', '2sem')
    """
    m = re.match(r'(\d{4})-([12])', filename)
    if m:
        yr  = int(m.group(1))
        sem = int(m.group(2))
        return f"{yr}-{yr + 1}", f"{sem}sem"
    return 'Unknown', '1sem'


def _safe_stored_name(user_id: int, original: str) -> str:
    """Collision-safe stored filename: userid_timestamp_safename."""
    # Normalise spaces → underscores before securing
    normalized = original.replace(' ', '_')
    return f"{user_id}_{int(time.time())}_{secure_filename(normalized)}"


def _canonical_name(filename: str) -> str:
    """
    Return a normalised name used for duplicate detection ONLY (no file by
    this name is ever written to disk). Spaces and underscores are treated
    as equivalent.
    e.g. '2022-1 Student-Performance Dataset.xlsx'
      →  '2022-1_Student-Performance_Dataset.xlsx'
    """
    return filename.replace(' ', '_')


# ─────────────────────────────────────────────────────────────
# BACKGROUND WORKER
# ─────────────────────────────────────────────────────────────

def _wipe_record_files(record) -> None:
    """Remove a record's raw upload file from Unprocessed_Datasets/.
    Used for both failed-upload cleanup and cancel/permanent-delete.

    Unprocessed_Datasets/ holds exactly one file per upload (the original
    file itself, saved under its collision-safe stored name) — there is no
    separate canonical-name duplicate-marker copy to clean up alongside it
    (duplicate detection is done against the database, see
    api_upload_dataset())."""
    if record.raw_path and os.path.exists(record.raw_path):
        try:
            os.remove(record.raw_path)
        except OSError as cleanup_err:
            print(f"[upload_routes] file cleanup warning: {cleanup_err}")


def _reload_ml_models():
    try:
        from ml_route.ml_analysis import reload_models
        reload_models()
    except Exception as _re:
        print(f"[upload_routes] reload_models warning: {_re}")


def _background_train(app, record_id: int, raw_path: str):
    """
    Background thread:
      1. Run full preprocessing + model retraining pipeline
      2. Update DB record on completion, or mark it 'failed' if the
         pipeline raised or returned no usable row count.
    """
    with app.app_context():
        record = UploadedDataset.query.get(record_id)
        if not record:
            return

        record.status = 'processing'
        db.session.commit()

        try:
            state = run_full_pipeline(new_file=raw_path)

            # ── Did the pipeline actually succeed? ──────────────────
            # run_full_pipeline() can return EARLY — e.g. process_file()
            # extracted 0 rows from the sheet, or any other "preprocess"
            # step exception — without ever setting rows_in_file /
            # rows_in_master. That used to fall straight through to the
            # 'done' branch below with row_count=None: the upload was
            # reported as successful with a silently-null row count,
            # even though nothing was actually written to disk or MySQL.
            #
            # FIX (2026-09-15): treating ANY non-empty state['errors'] as
            # a full failure over-corrected that — it also discarded
            # row_count for uploads whose OWN preprocessing (Step 1)
            # genuinely succeeded (rows_in_file/rows_in_master IS in
            # state) but a later, non-fatal step errored (e.g.
            # export_model_datasets' try/except in run_full_pipeline,
            # which logs and continues rather than aborting). Those
            # uploads were being marked 'failed' with row_count stuck
            # null even though this file's data was safely saved. The
            # real signal for "nothing to report" is row_count itself
            # being unavailable, not merely state['errors'] being
            # non-empty.
            row_count = state.get('rows_in_master') or state.get('rows_in_file')

            if state.get('errors') and row_count is None:
                error_message = "; ".join(
                    f"[{e.get('step', '?')}] {e.get('error', 'unknown error')}"
                    for e in state['errors']
                )
                record.status        = 'failed'
                record.error_message = error_message
                db.session.commit()
                print(f"[upload_routes] Upload {record_id} failed during pipeline: {error_message}")

                _wipe_record_files(record)
                _reload_ml_models()
                return

            # This upload's own standalone semester folder — never
            # combined with any other semester, including another
            # semester of the same academic year (see
            # preprocess.write_semester_folder).
            # rows_in_file = just this upload's own row count (always
            # set by Step 1). rows_in_master only exists once training has
            # actually run (semesters_collected >= MIN_SEMESTERS_FOR_TRAINING) and
            # the shared master CSV was regenerated from all semesters.
            sem_csv    = os.path.join(
                PROCESSED_BY_YEAR_DIR,
                f"{record.academic_year or ''}_{record.semester or ''}",
                'Student_Data.csv'
            )
            proc_path  = sem_csv if os.path.exists(sem_csv) else FINAL_MERGED_CSV

            record.processed      = True
            record.status         = 'done'
            record.processed_path = proc_path
            # FIX (2026-09-15): this used to reuse `row_count` from the
            # signal-check above, which prefers rows_in_master — the
            # GRAND TOTAL of students across every semester combined, only
            # populated once the MIN_SEMESTERS_FOR_TRAINING gate is passed.
            # That made every record's displayed row_count balloon to
            # the whole dataset's size instead of showing what THIS
            # upload actually contributed, and made it look like row
            # counts kept "multiplying" on every later upload even
            # though nothing was duplicated — it was just the running
            # total. Always show this upload's own file count here;
            # rows_in_master belongs on dashboard-wide totals, not a
            # single upload's row.
            record.row_count      = state.get('rows_in_file') or row_count

            # Surface a non-fatal error (e.g. export_datasets/training
            # step) even though this upload is still marked 'done' —
            # this file's own data is safe, but something downstream of
            # it (model_datasets refresh, a trainer) needs attention.
            if state.get('errors'):
                record.error_message = "; ".join(
                    f"[{e.get('step', '?')}] {e.get('error', 'unknown error')}"
                    for e in state['errors']
                )
                print(f"[upload_routes] Upload {record_id} done with non-fatal errors: {record.error_message}")

            db.session.commit()

            # Unprocessed_Datasets/ is temp staging only — the raw file's
            # data now lives safely in its semester folder / MySQL, so the
            # original upload no longer needs to sit on disk. Previously
            # _wipe_record_files() only ran on the failure path (below) and
            # on cancel/delete, so a SUCCESSFUL upload's raw file was never
            # cleaned up and just accumulated in Unprocessed_Datasets/
            # forever.
            _wipe_record_files(record)

            # Model (re)training only actually runs once MIN_SEMESTERS_FOR_TRAINING
            # semesters have data — see run_full_pipeline()'s gate in
            # auto_train.py. Either way this upload's own data is
            # saved and 'done'; state['training_status'] just tells the caller
            # whether training happened this time.
            if state.get('training_status') == 'waiting_for_more_semesters':
                print(
                    f"[upload_routes] Upload {record_id} saved to {record.academic_year}. "
                    f"Training on hold: {state.get('semesters_collected', 0)}/"
                    f"{MIN_SEMESTERS_FOR_TRAINING} semesters collected."
                )

            # Hot-reload ML models so the dashboard reflects the new PKLs
            # immediately without requiring a Flask restart.
            _reload_ml_models()

        except Exception as exc:
            import traceback
            record.status        = 'failed'
            record.error_message = str(exc)
            db.session.commit()
            traceback.print_exc()

            # ── Clean up the physical files ─────────────────────
            # The duplicate check queries the database (see
            # api_upload_dataset()), not the filesystem, so as soon as this
            # failed record is deleted below (or via /api/upload-record/<id>)
            # a reupload of the same filename is accepted right away. Remove
            # the raw upload file now regardless. The DB record itself is
            # kept (status='failed') only long enough to drive the "file
            # failed to process" floating notice on the frontend — see
            # /api/upload-record/<id> for how it's removed for good.
            _wipe_record_files(record)
            _reload_ml_models()


# ─────────────────────────────────────────────────────────────
# ROUTES
# ─────────────────────────────────────────────────────────────

@upload_bp.route('/upload-file')
def upload_file_page():
    user = _current_user()
    return render_template('studentaffair/fileupload/fileupload.html', user=user)


@upload_bp.route('/api/upload-dataset', methods=['POST'])
def api_upload_dataset():
    user = _current_user()
    if not user:
        return jsonify({'ok': False, 'error': 'Not logged in.'}), 401
    if user.role not in UPLOAD_ALLOWED_ROLES:
        return jsonify({'ok': False, 'error': 'Your role is not permitted to upload datasets.'}), 403

    if 'file' not in request.files:
        return jsonify({'ok': False, 'error': 'No file included in the request.'}), 400

    f = request.files['file']
    if not f.filename:
        return jsonify({'ok': False, 'error': 'Empty filename.'}), 400

    # Measure size for the cap below and for display
    f.seek(0, 2)
    size_bytes = f.tell()
    f.seek(0)

    # ── Format validation (extension + filename pattern) ──
    ok, reason = _validate_dataset_file(f.filename)
    if not ok:
        return jsonify({'ok': False, 'error': reason}), 422

    # ── Size cap ─────────────────────────────────────────────
    if DATASET_MAX_SIZE_MB is not None:
        max_bytes = DATASET_MAX_SIZE_MB * 1024 * 1024
        if size_bytes > max_bytes:
            return jsonify({
                'ok': False,
                'error': (
                    f"File is too large "
                    f"({size_bytes / (1024 * 1024):.1f}MB, max "
                    f"{DATASET_MAX_SIZE_MB}MB)."
                ),
            }), 413

    # ── Content validation ───────────────────────────────────
    # Filename/extension checks above only prove the NAME looks right —
    # this confirms the bytes themselves are a genuine, openable .xlsx
    # workbook, straight from the in-memory stream, before anything
    # touches disk. A file that fails here (corrupted, a renamed
    # non-Excel file, or a malformed archive) is rejected outright
    # instead of being silently accepted with sheet_count left blank.
    try:
        from openpyxl import load_workbook
        wb = load_workbook(f.stream, read_only=True)
        sheet_count = len(wb.sheetnames)
        wb.close()
    except Exception:
        return jsonify({
            'ok': False,
            'error': (
                "This file could not be opened as a valid Excel workbook. "
                "It may be corrupted, or not actually an .xlsx file despite "
                "its name — please re-export it and try again."
            ),
        }), 422
    finally:
        f.seek(0)  # rewind regardless of outcome — f.save() below needs this

    # ── Duplicate check (database, NOT a marker file on disk) ──
    # Unprocessed_Datasets/ holds only the one raw file per successful
    # upload — no second canonical-name copy is written just to support
    # this check. Space/underscore variants of the same filename are
    # still treated as the same dataset (e.g. '2022-1 ... .xlsx' and
    # '2022-1_...xlsx' both match), so the check compares against every
    # non-deleted record's filename in its canonical form.
    canonical = _canonical_name(f.filename)
    dup = UploadedDataset.query.filter(
        UploadedDataset.is_deleted.is_(False)
    ).filter(
        db.func.replace(UploadedDataset.original_filename, ' ', '_') == canonical
    ).first()

    if dup:
        return jsonify({
            'ok'       : False,
            'duplicate': True,
            'error'    : (
                f"<strong>'{f.filename}'</strong> has already been uploaded"
                f" by <strong>{dup.uploader.username}</strong>"
                f" on {dup.uploaded_at.strftime('%b %d, %Y')}"
                ".<br>If this is a different dataset please rename the file and re-upload."
            ),
        }), 409

    # ── Save raw file ─────────────────────────────────────────
    # Exactly one file lands in Unprocessed_Datasets/ per upload — the
    # original file itself, under a collision-safe stored name.
    stored_name = _safe_stored_name(user.acaduser_id, f.filename)
    raw_path    = os.path.join(UNPROCESSED_DATASETS_DIR, stored_name)
    # Defensive: OneDrive (or manual deletion) can remove this folder out
    # from under a running process even though config.py creates it on
    # import — re-ensure it exists right before every save instead of
    # trusting the one-time startup makedirs().
    os.makedirs(UNPROCESSED_DATASETS_DIR, exist_ok=True)
    f.save(raw_path)

    year, semester = _parse_filename_meta(f.filename)
    size_kb = round(size_bytes / 1024, 1)

    # ── Create DB record ──────────────────────────────────────
    record = UploadedDataset(
        original_filename = f.filename,
        raw_path          = raw_path,
        status            = 'pending',
        uploaded_by       = user.acaduser_id,
        academic_year     = year,
        semester          = semester,
        file_size_kb      = size_kb,
        sheet_count       = sheet_count,
    )
    db.session.add(record)
    try:
        db.session.commit()
    except Exception as exc:
        db.session.rollback()
        if os.path.exists(raw_path):
            os.remove(raw_path)
        return jsonify({
            'ok': False,
            'error': f"Could not save upload record: {exc}",
        }), 500

    # ── Launch background training ────────────────────────────
    app    = current_app._get_current_object()
    thread = threading.Thread(
        target=_background_train,
        args=(app, record.id, raw_path),
        daemon=True,
    )
    thread.start()

    return jsonify({
        'ok'       : True,
        'record_id': record.id,
        'message'  : (
            f"'{f.filename}' accepted. "
            "Preprocessing and model retraining have started in the background."
        ),
    }), 202


@upload_bp.route('/api/upload-record/<int:record_id>', methods=['DELETE'])
def api_delete_upload_record(record_id: int):
    """
    Permanently remove a 'failed' or still-'pending' upload record —
    used by the Remove/Reupload buttons on the failed-upload floating
    card, so a failed filename doesn't stay blocked as a duplicate
    forever. Not the soft-delete/backup feature — that's been removed.
    """
    user = _current_user()
    if not user:
        return jsonify({'ok': False, 'error': 'Not logged in.'}), 401
    if user.role not in UPLOAD_ALLOWED_ROLES:
        return jsonify({'ok': False, 'error': 'Your role is not permitted to modify uploads.'}), 403

    record = UploadedDataset.query.get(record_id)
    if not record:
        return jsonify({'ok': False, 'error': 'Record not found.'}), 404

    if record.status not in ('failed', 'pending'):
        return jsonify({
            'ok': False,
            'error': f"Cannot remove a record with status '{record.status}'.",
        }), 400

    _wipe_record_files(record)
    db.session.delete(record)
    db.session.commit()

    return jsonify({'ok': True, 'message': 'Upload record removed.'})


@upload_bp.route('/api/reset-database', methods=['POST'])
def api_reset_database():
    """
    Wipes EVERY uploaded dataset, derived model-dataset table, trained
    .pkl model, and training_state — for clearing demo/seed data before
    a real deploy, so nobody sees leftover charts on first login.

    Admin-only, and requires the request body to include
    {"confirm": "RESET"} — a raw button click isn't enough for something
    this destructive and irreversible.

    Also clears the in-memory ml_route.ml_analysis caches (df_full_loaded
    + every loaded .pkl) afterward — without this, the running process
    keeps serving the just-deleted data until the server restarts, since
    those are plain Python globals, not re-read from MySQL per request.
    """
    user = _current_user()
    if not user:
        return jsonify({'ok': False, 'error': 'Not logged in.'}), 401
    role = str(getattr(user, 'role', '') or '').strip().lower().replace(' ', '_').replace('-', '_')
    if role != 'academic_affair':
        return jsonify({'ok': False, 'error': f'Admin role required. (your role: {role or "none"})'}), 403

    body = request.get_json(silent=True) or {}
    if body.get('confirm') != 'RESET':
        return jsonify({'ok': False, 'error': 'Send {"confirm": "RESET"} to proceed.'}), 400

    try:
        # 1. Uploaded-record rows (ORM table, not in db_io.RESET_TABLES).
        UploadedDataset.query.delete()
        db.session.commit()

        # 2. Every MySQL table holding uploaded/derived data + trained
        #    models + training_state.
        from util.db_io import reset_all_data
        reset_all_data()

        # 3. Files on disk — same dirs api_upload_dataset() writes into.
        import shutil
        for dir_path in (UNPROCESSED_DATASETS_DIR, PROCESSED_DATASETS_DIR,
                          PROCESSED_BY_YEAR_DIR, MODEL_DATASETS_DIR):
            if dir_path and os.path.isdir(dir_path):
                for name in os.listdir(dir_path):
                    full = os.path.join(dir_path, name)
                    try:
                        shutil.rmtree(full) if os.path.isdir(full) else os.remove(full)
                    except OSError as cleanup_err:
                        print(f"[reset-database] file cleanup warning: {cleanup_err}")
        if FINAL_MERGED_CSV and os.path.exists(FINAL_MERGED_CSV):
            os.remove(FINAL_MERGED_CSV)

        # 4. Drop the in-memory cache LAST, once everything backing it is
        #    actually gone, so a request racing this one can't reload
        #    from a half-cleared database.
        _reload_ml_models()

        return jsonify({'ok': True, 'message': 'Database reset. All uploads, models, and training state cleared.'})
    except Exception as e:
        db.session.rollback()
        return jsonify({'ok': False, 'error': str(e)}), 500


@upload_bp.route('/api/failed-uploads')
def api_failed_uploads():
    """
    Any 'failed' upload records still sitting in the DB (not yet dismissed
    via the Remove button). Polled once on page load so the failed-upload
    floating card can resurface after a refresh instead of only appearing
    during the same in-flight upload session.
    """
    records = (
        UploadedDataset.query
        .filter_by(status='failed')
        .order_by(UploadedDataset.uploaded_at.desc())
        .all()
    )
    return jsonify([r.to_dict() for r in records])


@upload_bp.route('/api/upload-status/<int:record_id>')
def api_upload_status(record_id: int):
    """Poll until status is 'done' or 'failed'."""
    record = UploadedDataset.query.get_or_404(record_id)
    data   = record.to_dict()

    # Attach prediction horizon from training_state.json
    state = load_state()
    if state.get('horizon'):
        data['horizon'] = state['horizon']

    return jsonify(data)


@upload_bp.route('/api/training-state')
def api_training_state():
    """Full training_state.json — model metrics + prediction horizon."""
    state = load_state()
    if not state:
        return jsonify({'status': 'no_training_yet'}), 200
    return jsonify(state)


# ── Human-readable labels for each trained model ────────────────
# For models that train several sub-models at once (kpi, gender_performance_*,
# year_level_performance, year_level_inc_irreg), this is the SHARED prefix —
# the actual sub-model name comes from _SUBMODEL_LABELS below and each
# sub-model gets rendered as its own dashboard card instead of one bundled
# card.
#
# performance_band was never built into a chart, so it's deliberately not
# listed here — if it ever shows up in training_state.json, the
# Title-Cased-key + "Not Used in Any Chart Yet" fallback is the correct
# signal that nothing consumes it yet.
_MODEL_LABELS = {
    'dropout_risk':       'Dropout Risk (per Student)',
    'dropout_spike':      'Dropout Spike (Cohort Trend)',
    'dropout_ranking':    'Dropout Ranking (per College)',
    'gwa_ranking':        'GWA Ranking (per College)',
    'gwa_trend':          'GWA Trend (Time-Series)',
    'inc_forecast':       'INC Rate Forecast',
    'irreg_reg':          'Irregular vs Regular (per Student)',
    'kpi':                'KPI',
    'subject_grade':      'Subject Grade Forecast',
    'gender_performance_male':   'Gender Performance — Male',
    'gender_performance_female': 'Gender Performance — Female',
    # RESTORED 2026-09-06: year_level_performance came back the same day
    # it was removed, this time as 5 INDEPENDENT per-band LinearRegression
    # models (Excellent/Good/Average/Below Average/Failing) instead of the
    # one-shared-model design that flatlined — see
    # auto_train.train_year_level_performance's docstring for the full
    # history. year_level_inc_irreg was never actually harmful in its
    # current (2026-09-04+) form — the "-0.63 R^2" note above described
    # the OLD RandomForestRegressor version; the LinearRegression
    # replacement has 3 genuinely separate per-metric models with real,
    # non-cancelling Year_Numeric coefficients (verified directly against
    # the trained models), and IS what /api/get_year_level_inc_irreg_forecast
    # actually calls — it just never got a label/chart-usage entry here.
    'year_level_performance': 'Performance by Year Level',
    'year_level_inc_irreg':   'INC / Irregular / Drop Rate by Year Level',
}

# Sub-model display names, keyed by parent model key -> {sub_name: label}.
# Only needed for trainers that return a nested dict (one dict per sub-model).
_SUBMODEL_LABELS = {
    'kpi': {'gwa': 'GWA', 'enrollment': 'Enrollment', 'drop': 'Drop Rate'},
    'gender_performance_male':   {'dropout_rate': 'Dropout Rate', 'inc_rate': 'INC Rate'},
    'gender_performance_female': {'dropout_rate': 'Dropout Rate', 'inc_rate': 'INC Rate'},
    # Keys here must match auto_train.train_year_level_performance's band
    # names EXACTLY (including the space in "Below Average") since
    # _flatten_metric_block builds sub_key as f"{key}_{sub_name}" straight
    # from the trainer's own result dict keys, not a normalized/lowercased
    # version of them.
    'year_level_performance': {
        'Excellent': 'Excellent', 'Good': 'Good', 'Average': 'Average',
        'Below Average': 'Below Average', 'Failing': 'Failing',
    },
    'year_level_inc_irreg': {
        'inc_rate': 'INC Rate', 'irregular_rate': 'Irregular Rate', 'drop_rate': 'Drop Rate',
    },
}

# Which chart/endpoint actually consumes each model's predictions, keyed by
# the FULL model key (parent key, or "parent_subname" for split sub-models).
# None/absent = trained but not wired to anything yet — surfaced on the
# dashboard card instead of silently hidden, so a dead model is visible
# the moment it happens instead of needing another grep session to find.
# Short chart NAME each model's predictions feed — deliberately short
# (no endpoint paths/descriptions) since this gets folded straight into
# the card title as "<Model Label> — <Chart Name>", same pattern as the
# "KPI — GWA" sub-model labels, rather than shown as a separate row.
# None/absent = trained but not wired to any chart yet.
_CHART_USAGE = {
    'dropout_risk':    'Student Status Donut',
    'dropout_spike':   'Dropout Trend & Spike Chart',
    'dropout_ranking': 'College Dropout Ranking',
    'gwa_ranking':     'GWA Ranking Bar Chart',
    'gwa_trend':       'GWA Trend Line Chart',
    'inc_forecast':    'INC Rate Forecast Chart',
    'irreg_reg':       'Irregular-Rate Donut (Forecast Mode)',
    'subject_grade':   'Subject Forecast / Hardest Subjects Chart',
    'kpi_gwa':         'KPI Tile',
    'kpi_enrollment':  'KPI Tile',
    'kpi_drop':        'KPI Tile',
    'gender_performance_male_dropout_rate':   'Retention & Risk Donut (Male, per-college)',
    'gender_performance_male_inc_rate':       'Retention & Risk Donut (Male, per-college)',
    'gender_performance_female_dropout_rate': 'Retention & Risk Donut (Female, per-college)',
    'gender_performance_female_inc_rate':     'Retention & Risk Donut (Female, per-college)',
    # ADDED 2026-09-06 — both models existed and were genuinely consumed
    # by their charts already; they'd just never been given entries here,
    # which is exactly why every card from either one showed "Not Used in
    # Any Chart Yet" despite /api/get_year_level_gwa_forecast and
    # /api/get_year_level_inc_irreg_forecast actively calling them.
    'year_level_performance_Excellent':      'Performance by Year Level Chart (Forecast Mode)',
    'year_level_performance_Good':           'Performance by Year Level Chart (Forecast Mode)',
    'year_level_performance_Average':        'Performance by Year Level Chart (Forecast Mode)',
    'year_level_performance_Below Average':  'Performance by Year Level Chart (Forecast Mode)',
    'year_level_performance_Failing':        'Performance by Year Level Chart (Forecast Mode)',
    'year_level_inc_irreg_inc_rate':         'INC / Irregular / Drop Rate by Year Level Chart (Forecast Mode)',
    'year_level_inc_irreg_irregular_rate':   'INC / Irregular / Drop Rate by Year Level Chart (Forecast Mode)',
    'year_level_inc_irreg_drop_rate':        'INC / Irregular / Drop Rate by Year Level Chart (Forecast Mode)',
}


def _titled_label(key: str, label: str) -> str:
    """Fold the chart-usage name straight into the card title: '<label> — <chart>',
    or '<label> — Not Used in Any Chart Yet' if nothing consumes this model —
    so an unwired model is impossible to miss without a separate badge row."""
    chart = _CHART_USAGE.get(key)
    return f"{label} — {chart}" if chart else f"{label} — Not Used in Any Chart Yet"


def _build_flat_entry(key: str, label: str, result: dict) -> dict:
    """Build one dashboard-card entry for a flat (non-nested) result dict."""

    status = result.get('status', 'ok' if 'error' not in result else 'error')
    metrics = {k: v for k, v in result.items() if k not in ('status', 'reason', 'error')}

    if 'accuracy' in metrics:
        headline_label, headline_value = 'Accuracy', metrics['accuracy']
    elif 'r2' in metrics:
        headline_label, headline_value = 'R² Score', metrics['r2']
    else:
        headline_label, headline_value = None, None

    return {
        'key': key,
        'label': _titled_label(key, label),
        'status': status,
        'headline_label': headline_label,
        'headline_value': headline_value,
        'metrics': metrics,
        'reason': result.get('reason') or result.get('error'),
    }


def _flatten_metric_block(key: str, result: dict) -> list:
    """
    Normalise a trainer's result dict into one or more dashboard-card
    entries: status, a primary headline metric (accuracy if classification,
    R^2 if regression), and the rest as secondary metrics.

    Some trainers return a NESTED dict — one sub-result per sub-model
    (train_kpi's 'gwa'/'enrollment'/'drop', train_gender_performance's
    'dropout_rate'/'inc_rate'). Each sub-model gets its OWN entry/card here
    (rather than one bundled card with prefixed metric keys) so each
    sub-model's accuracy is visible on its own, instead of averaging
    distinct sub-models' evals into one card. Which chart each card feeds
    is baked directly into its title via _titled_label() (e.g.
    "KPI — GWA — KPI Tile") rather than shown as a separate row.
    """
    if not isinstance(result, dict):
        return [{'key': key, 'label': _titled_label(key, key), 'status': 'unknown',
                  'headline_label': None, 'headline_value': None, 'metrics': {}}]

    has_nested_submodels = any(isinstance(v, dict) for v in result.values())
    if not has_nested_submodels:
        label = _MODEL_LABELS.get(key, key.replace('_', ' ').title())
        return [_build_flat_entry(key, label, result)]

    base_label = _MODEL_LABELS.get(key, key.replace('_', ' ').title())
    sub_labels = _SUBMODEL_LABELS.get(key, {})
    entries = []
    for sub_name, sub_result in result.items():
        if not isinstance(sub_result, dict):
            continue
        sub_key = f"{key}_{sub_name}"
        sub_label = sub_labels.get(sub_name, sub_name.replace('_', ' ').title())
        entries.append(_build_flat_entry(sub_key, f"{base_label} — {sub_label}", sub_result))
    return entries or [_build_flat_entry(key, base_label, {'status': 'skipped'})]


@upload_bp.route('/api/model-performance')
def api_model_performance():
    """
    Dashboard-ready model evaluation summary.
    Reshapes training_state.json into a flat list, one entry per model,
    each with a headline accuracy/R² figure plus the full metric set —
    so the frontend can render a 'Model Performance' card without having
    to know each trainer's individual result shape.
    """
    state = load_state()
    if not state:
        return jsonify({
            'status': 'no_training_yet',
            'message': 'No model has been trained yet. Upload a dataset to begin.',
            'models': [],
        }), 200

    models = []
    for key, result in state.get('models', {}).items():
        models.extend(_flatten_metric_block(key, result))

    return jsonify({
        'status': 'ok',
        'trained_at': state.get('trained_at'),
        'triggered_by': state.get('triggered_by'),
        'rows_in_master': state.get('rows_in_master'),
        'elapsed_seconds': state.get('elapsed_seconds'),
        'errors': state.get('errors', []),
        'horizon': state.get('horizon', {}),
        'models': models,
    })


@upload_bp.route('/api/unprocessed-list')
def api_unprocessed_list():
    records = (
        UploadedDataset.query
        .filter(UploadedDataset.status != 'failed')
        .filter_by(is_deleted=False)
        .order_by(UploadedDataset.uploaded_at.desc())
        .all()
    )
    return jsonify([r.to_dict() for r in records])


def _list_model_files(dir_path: str, status_label: str) -> list:
    out = []
    if os.path.isdir(dir_path):
        for fname in sorted(os.listdir(dir_path)):
            if fname.endswith('.csv'):
                fpath = os.path.join(dir_path, fname)
                out.append({
                    'filename': fname,
                    'size_kb' : f"{os.path.getsize(fpath) / 1024:.1f} KB",
                    'modified': time.strftime(
                        '%b %d, %Y  %I:%M %p',
                        time.localtime(os.path.getmtime(fpath))
                    ),
                    'status'  : status_label,
                })
    return out


@upload_bp.route('/api/processed-list')
def api_processed_list():
    records = (
        UploadedDataset.query
        .filter_by(status='done', is_deleted=False)
        .order_by(UploadedDataset.uploaded_at.desc())
        .all()
    )

    # Model dataset files -- read from MySQL, not disk (see
    # list_model_dataset_files()'s docstring for why).
    model_files = list_model_dataset_files()

    state   = load_state()
    horizon = state.get('horizon', {})

    records_out = [r.to_dict() for r in records]

    return jsonify({
        'uploaded_records'  : records_out,
        'model_files'       : model_files,
        'merged_csv_exists' : os.path.exists(FINAL_MERGED_CSV),
        'horizon'           : horizon,
        # Auto-train gate: models don't (re)train until this many
        # semesters have data — see run_full_pipeline() in auto_train.py.
        'semesters_collected': state.get('semesters_collected', 0),
        'semesters_needed'   : MIN_SEMESTERS_FOR_TRAINING,
        'training_status'   : state.get('training_status'),
    })