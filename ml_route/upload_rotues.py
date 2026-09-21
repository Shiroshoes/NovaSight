import os
import re
import time
import threading
import traceback
from datetime import datetime

from flask import Blueprint, request, jsonify, session, render_template, current_app, send_file
from werkzeug.utils import secure_filename

from database.models import db, AcadUser, UploadedDataset
from util.db_io import (
    list_model_dataset_files,
    get_preprocessing_warnings, get_warning_counts,
    delete_preprocessing_warnings, save_preprocessing_warnings,
    upsert_model_dataset,
    get_csv_for_download, list_csv_separations,
    archive_semester, restore_semester, list_archives,
    mark_archives_blocked,
    # duplicate detection + staged-upload (resume) helpers
    compute_file_hash, check_file_hash, register_file_hash,
    find_live_upload_by_filename, purge_failed_uploads,
    find_staged_upload_by_hash, restage_for_upload,
    load_staged_upload, delete_staged_upload,
    save_training_run, load_training_run, count_rows,
)
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
from training.auto_train import run_full_pipeline
from util.db_io import load_training_state as _load_training_state

upload_bp = Blueprint('upload_bp', __name__)


# ── Auth gate ──────────────────────────────────────────────────────────────
@upload_bp.before_request
def _require_login():
    if 'user_id' not in session:
        return jsonify({'ok': False, 'error': 'Not logged in.'}), 401


# ── Helpers ────────────────────────────────────────────────────────────────

def _current_user():
    uid = session.get('user_id')
    return AcadUser.query.get(uid) if uid else None


def _validate_dataset_file(filename: str) -> tuple[bool, str]:
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
    m = re.match(r'(\d{4})-([12])', filename)
    if m:
        yr  = int(m.group(1))
        sem = int(m.group(2))
        return f"{yr}-{yr + 1}", f"{sem}sem"
    return 'Unknown', '1sem'


def _safe_stored_name(user_id: int, original: str) -> str:
    normalized = original.replace(' ', '_')
    return f"{user_id}_{int(time.time())}_{secure_filename(normalized)}"


def _canonical_name(filename: str) -> str:
    return filename.replace(' ', '_')


# ── Background workers ─────────────────────────────────────────────────────

def _wipe_record_files(record) -> None:
    if record.raw_path and os.path.exists(record.raw_path):
        try:
            os.remove(record.raw_path)
        except OSError as e:
            print(f"[upload_routes] file cleanup warning: {e}")


def _reload_ml_models():
    try:
        from ml_route.ml_analysis import reload_models
        reload_models()
    except Exception as e:
        print(f"[upload_routes] reload_models warning: {e}")


# ── Auto-training tracker ──────────────────────────────────────────────────
# After a confirmed upload the models retrain in the background. The run is
# recorded (db_io.save_training_run) as queued -> running -> done | failed, so
# the upload page can follow it and show the result when it finishes:
#   skipped      not enough semesters yet
#   queued       waiting for an earlier run to finish (one run at a time)
#   running      run_full_pipeline() in progress
#   done         finished (has_warnings=True if some models errored)
#   failed       run_full_pipeline() raised / produced nothing
#   interrupted  was queued/running but nothing updated it for _TRAIN_STALE_MIN
#                (server restarted mid-training)

_training_lock   = threading.Lock()
_TRAIN_ACTIVE    = ('queued', 'running')
_TRAIN_STALE_MIN = 120


def _now_iso() -> str:
    return datetime.now().isoformat(timespec='seconds')


def _save_run(run: dict) -> None:
    run['updated_at'] = _now_iso()
    try:
        save_training_run(run)
    except Exception as e:
        print(f"[upload_routes] save_training_run failed (non-fatal): {e}")


def _effective_training_run() -> dict:
    """The stored run, with a queued/running one that went silent reported as interrupted."""
    run = load_training_run()
    if not run:
        return {'status': 'none'}
    if run.get('status') in _TRAIN_ACTIVE:
        try:
            age_min = (datetime.now() - datetime.fromisoformat(run['updated_at'])).total_seconds() / 60
        except Exception:
            age_min = 0
        if age_min > _TRAIN_STALE_MIN:
            run = dict(run, status='interrupted',
                       error='Training did not report back — the server may have restarted while it was running.')
    return run


def _summarize_training(state: dict) -> dict:
    """Slim, UI-ready view of auto_train's training_state."""
    models = []
    for key, result in (state.get('models') or {}).items():
        models.extend(_flatten_metric_block(key, result))
    slim = [{k: m.get(k) for k in ('key', 'label', 'status', 'headline_label',
                                    'headline_value', 'reason')} for m in models]
    bad     = sum(1 for m in slim if str(m['status']).lower() in ('error', 'failed'))
    skipped = sum(1 for m in slim if str(m['status']).lower() in ('skipped', 'skip'))
    return {
        'models':          slim,
        'models_total':    len(slim),
        'models_errored':  bad,
        'models_skipped':  skipped,
        'models_trained':  len(slim) - bad - skipped,
        'errors':          [str(e) for e in (state.get('errors') or [])][:20],
        'rows_in_master':  state.get('rows_in_master'),
        'elapsed_seconds': state.get('elapsed_seconds'),
        'trained_at':      state.get('trained_at'),
        'training_status': state.get('training_status'),
    }


def _run_training(app, run: dict) -> None:
    """Thread body. Serialised by _training_lock; only writes while `run` is still
    the current record (a newer upload's run, or a DB reset, supersedes it)."""
    with _training_lock, app.app_context():
        run_id = run['run_id']

        def is_current() -> bool:
            try:
                return load_training_run().get('run_id') == run_id
            except Exception:
                return False

        if not is_current():
            return
        run.update(status='running', started_at=_now_iso())
        _save_run(run)
        t0 = time.time()
        try:
            run_full_pipeline()
            state   = _load_training_state() or {}
            summary = _summarize_training(state)
            if str(state.get('training_status', '')).lower() in ('failed', 'error') \
                    or summary['models_total'] == 0:
                run.update(status='failed', summary=summary,
                           error='Training finished without producing any model results.'
                                 + (f" ({summary['errors'][0]})" if summary['errors'] else ''))
            else:
                run.update(status='done', summary=summary, error=None,
                           has_warnings=bool(summary['models_errored'] or summary['errors']))
        except Exception as exc:
            traceback.print_exc()
            run.update(status='failed', error=f"{type(exc).__name__}: {exc}")
        run.update(finished_at=_now_iso(), elapsed_seconds=round(time.time() - t0, 1))
        if is_current():
            _save_run(run)
        _reload_ml_models()          # pick up the freshly trained models


def _start_training(app, upload_id: int, filename: str | None) -> dict:
    """Record + launch the auto-training run for a just-confirmed upload."""
    try:
        n_sems = count_rows('semester_uploads')
    except Exception:
        n_sems = 0
    run = {
        'run_id':             f"{int(time.time())}-{upload_id}",
        'upload_id':          upload_id,
        'filename':           filename,
        'semesters_available': n_sems,
        'semesters_needed':   MIN_SEMESTERS_FOR_TRAINING,
        'queued_at':          _now_iso(),
    }
    if n_sems < MIN_SEMESTERS_FOR_TRAINING:
        run.update(status='skipped', finished_at=_now_iso(),
                   message=(f"Training starts once {MIN_SEMESTERS_FOR_TRAINING} semesters are uploaded "
                            f"({n_sems} so far)."))
        _save_run(run)
        return run
    run['status'] = 'queued'
    _save_run(run)
    threading.Thread(target=_run_training, args=(app, run), daemon=True).start()
    return run


def _background_preprocess(app, record_id: int, raw_path: str, file_hash: str | None = None):
    """
    Background thread — NEW FLOW:
    1. Run preprocessing only (parse + feature-engineer + STAGE, not commit)
    2. Save warnings to preprocessing_warnings table
    3. Set status → 'preprocessing_done' (not 'done')
    4. Frontend opens confirmation modal; user reviews warnings
    5. User confirms → /api/confirm-upload/<id> → real commit + CSV separation + training

    RESUME: if `file_hash` matches an existing staged_uploads row (e.g. the
    exact same .xlsx was already parsed once but the browser/tab was closed
    or the connection dropped before the user got to confirm), we skip
    re-parsing entirely and jump straight to 'preprocessing_done' using the
    cached staged result — see find_staged_upload_by_hash() below.
    """
    with app.app_context():
        record = UploadedDataset.query.get(record_id)
        if not record:
            return

        # RESUME fast-path — reuse a previous staged parse of the same file
        # instead of re-parsing (no openpyxl read, no catalog cross-check,
        # no fuzzy matching — just a DB read).
        if file_hash:
            try:
                staged = find_staged_upload_by_hash(file_hash)
            except Exception as e:
                staged = None
                print(f"[upload_routes] find_staged_upload_by_hash failed (non-fatal): {e}")
            if staged:
                record.academic_year      = staged.get('academic_year', record.academic_year)
                record.semester           = staged.get('semester', record.semester)
                record.row_count          = staged.get('student_rows')
                record.training_row_count = staged.get('longform_rows')
                record.accuracy           = staged.get('accuracy')
                record.status             = 'preprocessing_done'
                db.session.commit()
                try:
                    import json
                    # Re-key the staged row (previously under the abandoned
                    # upload_id) to THIS record_id, so confirm-upload can
                    # find it later — and replay its warnings into
                    # preprocessing_warnings for this record_id so the
                    # confirmation modal has something to show.
                    restage_for_upload(old_staged=staged, new_upload_id=record_id)
                    warnings_list = json.loads(staged.get('warnings_json') or '[]')
                    if warnings_list:
                        save_preprocessing_warnings(record_id, warnings_list)
                except Exception as e:
                    print(f"[upload_routes] resume re-staging failed (non-fatal): {e}")
                print(f"[upload_routes] Upload {record_id} RESUMED from staged parse "
                      f"(file_hash={file_hash[:12]}…) — skipped re-parsing.")
                return

        record.status = 'processing'
        db.session.commit()

        try:
            from preprocessing.preprocess import process_file_v2
            result = process_file_v2(raw_path, upload_id=record_id, file_hash=file_hash)

            if not result.get('success'):
                record.status        = 'failed'
                record.error_message = result.get('error', 'Preprocessing failed.')
                db.session.commit()
                _wipe_record_files(record)
                return

            # Update record with preprocessing results
            record.academic_year     = result.get('academic_year', record.academic_year)
            record.semester          = result.get('semester', record.semester)
            record.row_count         = result.get('student_rows')
            record.training_row_count = result.get('longform_rows')
            record.excluded_row_count = result.get('excluded_rows')   # students held back by preprocess (Subject Count mismatch, etc.)
            record.accuracy          = result.get('accuracy')
            record.status            = 'preprocessing_done'
            db.session.commit()

            print(
                f"[upload_routes] Upload {record_id} preprocessing done — "
                f"{result.get('warning_counts', {})} warnings | "
                f"status=preprocessing_done"
            )

        except Exception as exc:
            import traceback
            traceback.print_exc()
            db.session.rollback()  # discard the broken/half-applied state first

            # The row may have been deleted concurrently (e.g. a reset-database
            # call mid-preprocessing) — re-check before trying to update it again.
            fresh = UploadedDataset.query.get(record_id)
            if fresh is not None:
                fresh.status        = 'failed'
                fresh.error_message = str(exc)
                try:
                    db.session.commit()
                except Exception:
                    db.session.rollback()
                    traceback.print_exc()
                _wipe_record_files(fresh)
            else:
                print(f"[upload_routes] Upload {record_id} vanished mid-preprocessing "
                      f"(likely deleted concurrently) — skipping failure update.")


def _run_separation_and_train(app, record_id: int, academic_year: str, semester: str):
    """
    Called after user confirms the preprocessing modal.
    0. REAL COMMIT: load the staged parse and write it into
       semester_uploads/longform_uploads (write_semester_folder()) — this is
       the point where the upload actually becomes part of the shared
       dataset. Before this point (staged only), cancelling never touched
       these tables.
    1. Run CSV separation (DS00-DS06)
    2. Start auto-training if >= MIN_SEMESTERS_FOR_TRAINING (tracked, see
       _start_training — the upload page shows the result when it finishes)
    3. Set status → 'done'
    """
    with app.app_context():
        record = UploadedDataset.query.get(record_id)
        if not record:
            return

        try:
            import io
            import pandas as pd
            from preprocessing.preprocess import write_semester_folder, BY_YEAR_DIR

            staged = load_staged_upload(record_id)
            if not staged:
                record.status        = 'failed'
                record.error_message = ('No staged preprocessing result found for this upload '
                                         '— it may have expired or already been confirmed. '
                                         'Please re-upload the file.')
                db.session.commit()
                return

            student_df = pd.read_csv(io.StringIO(staged['student_csv']))
            long_df    = pd.read_csv(io.StringIO(staged['longform_csv']))
            write_semester_folder(student_df, long_df, BY_YEAR_DIR,
                                   academic_year, semester,
                                   accuracy=staged.get('accuracy'))

            from preprocessing.separation_csv import run_csv_separation
            result = run_csv_separation(
                upload_id=record_id,
                academic_year=academic_year,
                semester=semester,
                trigger_training=False,      # tracked training is started below
            )

            if not result.get('success'):
                record.status        = 'failed'
                record.error_message = result.get('error', 'CSV separation failed.')
                db.session.commit()
                return

            # Record the training run BEFORE flipping to 'done', so the page's
            # next status poll (which fetches /api/training-run on 'done') can't
            # race ahead of it and find nothing.
            try:
                _start_training(app, record_id, record.original_filename)
            except Exception as e:
                print(f"[upload_routes] could not start auto-training (non-fatal): {e}")

            record.status    = 'done'
            record.processed = True
            db.session.commit()

            try:
                delete_staged_upload(record_id)
            except Exception as e:
                print(f"[upload_routes] delete_staged_upload failed (non-fatal, harmless leftover row): {e}")

            _wipe_record_files(record)
            # (no _reload_ml_models() here any more: it ran while training had only
            #  just started, so it reloaded the OLD models. _run_training reloads
            #  once the new ones exist.)

            print(
                f"[upload_routes] Upload {record_id} separation done — "
                f"datasets: {result.get('datasets', {})}"
            )

        except Exception as exc:
            import traceback
            traceback.print_exc()
            db.session.rollback()
            fresh = UploadedDataset.query.get(record_id)
            if fresh is not None:
                fresh.status        = 'failed'
                fresh.error_message = str(exc)
                db.session.commit()
            _reload_ml_models()


# ── Routes ─────────────────────────────────────────────────────────────────

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

    f.seek(0, 2); size_bytes = f.tell(); f.seek(0)

    ok, reason = _validate_dataset_file(f.filename)
    if not ok:
        return jsonify({'ok': False, 'error': reason}), 422

    if DATASET_MAX_SIZE_MB is not None:
        if size_bytes > DATASET_MAX_SIZE_MB * 1024 * 1024:
            return jsonify({'ok': False, 'error': (
                f"File is too large ({size_bytes/(1024*1024):.1f}MB, max {DATASET_MAX_SIZE_MB}MB)."
            )}), 413

    # Content validation
    try:
        from openpyxl import load_workbook
        wb = load_workbook(f.stream, read_only=True)
        sheet_count = len(wb.sheetnames)
        wb.close()
    except Exception:
        return jsonify({'ok': False, 'error': (
            "This file could not be opened as a valid Excel workbook. "
            "It may be corrupted, or not actually an .xlsx file."
        )}), 422
    finally:
        f.seek(0)

    # Duplicate check (by filename).
    # Only LIVE uploads count (pending / processing / preprocessing_done /
    # separating / done). A 'failed' record produced no data and its raw file is
    # already wiped, but it used to match here and reject every retry with
    # "already uploaded" — so stale failed rows for this filename are dropped
    # first. Their staged parse is kept (see purge_failed_uploads) so the retry
    # can resume instead of re-parsing.
    canonical = _canonical_name(f.filename)
    try:
        purge_failed_uploads(canonical)
    except Exception as e:
        print(f"[upload_routes] purge_failed_uploads failed (non-fatal): {e}")

    dup = find_live_upload_by_filename(canonical)
    if dup:
        return jsonify({
            'ok': False, 'duplicate': True,
            'error': (
                f"<strong>'{f.filename}'</strong> has already been uploaded"
                f" by <strong>{dup.get('uploader_name') or 'another user'}</strong>"
                f" on {dup['uploaded_at'].strftime('%b %d, %Y')}."
                "<br>If this is a different dataset please rename the file and re-upload."
            ),
        }), 409

    # Save raw file
    stored_name = _safe_stored_name(user.acaduser_id, f.filename)
    raw_path    = os.path.join(UNPROCESSED_DATASETS_DIR, stored_name)
    os.makedirs(UNPROCESSED_DATASETS_DIR, exist_ok=True)
    f.save(raw_path)

    # SHA-256 of the raw file. Used for (a) content-level duplicate detection —
    # the same workbook under a different filename — and (b) resuming from a
    # cached staged parse after a mid-flight failure. See _background_preprocess().
    try:
        file_hash = compute_file_hash(raw_path)
    except Exception as e:
        file_hash = None
        print(f"[upload_routes] compute_file_hash failed (non-fatal, dup-by-content/resume won't apply): {e}")

    if file_hash:
        dup_hash = check_file_hash(file_hash)
        if dup_hash:
            try:
                os.remove(raw_path)
            except OSError:
                pass
            return jsonify({
                'ok': False, 'duplicate': True,
                'error': (
                    "This file has the same content as "
                    f"<strong>'{dup_hash['original_filename']}'</strong>, uploaded"
                    f" by <strong>{dup_hash.get('uploader_name') or 'another user'}</strong>"
                    f" on {dup_hash['uploaded_at'].strftime('%b %d, %Y')}."
                    "<br>Renaming the file doesn't make it a different dataset."
                ),
            }), 409

    year, semester = _parse_filename_meta(f.filename)
    size_kb = round(size_bytes / 1024, 1)

    # NOTE: archives for this semester are deliberately NOT blocked here any more.
    # This runs at upload time, before preprocessing and before the user has
    # confirmed anything — blocking here meant a cancelled upload still locked the
    # archive. Restore now checks for a live upload itself (db_io.restore_semester).

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
        return jsonify({'ok': False, 'error': f"Could not save upload record: {exc}"}), 500

    # Persist the hash on the record (uploaded_dataset.file_hash, UNIQUE).
    # Non-fatal: if an archived row still holds this hash the upload carries on
    # without it, and resume still works via staged_uploads.file_hash.
    if file_hash:
        try:
            if not register_file_hash(record.id, file_hash):
                print("[upload_routes] file_hash not stored (held by an archived record) — continuing.")
        except Exception as e:
            print(f"[upload_routes] register_file_hash failed (non-fatal): {e}")

    # Launch preprocessing (stops at preprocessing_done, not full pipeline)
    app = current_app._get_current_object()
    threading.Thread(
        target=_background_preprocess,
        args=(app, record.id, raw_path, file_hash),
        daemon=True,
    ).start()

    return jsonify({
        'ok'       : True,
        'upload_id': record.id,
        'record_id': record.id,   # backward compat
        'message'  : f"'{f.filename}' accepted — preprocessing started.",
    }), 202


@upload_bp.route('/api/upload-status/<int:record_id>')
def api_upload_status(record_id: int):
    """Poll for status. Returns preprocessing_done when modal should open."""
    record = UploadedDataset.query.get_or_404(record_id)
    data   = record.to_dict()
    state  = _load_training_state()
    if state.get('horizon'):
        data['horizon'] = state['horizon']
    return jsonify(data)


@upload_bp.route('/api/preprocessing-warnings/<int:upload_id>')
def api_preprocessing_warnings(upload_id: int):
    """Returns all warnings for the confirmation modal."""
    warnings = get_preprocessing_warnings(upload_id)
    counts   = get_warning_counts(upload_id)
    record   = UploadedDataset.query.get(upload_id)
    return jsonify({
        'warnings': warnings,
        'counts':   counts,
        'original_filename': record.original_filename if record else None,
        'academic_year':     record.academic_year     if record else None,
        'semester':          record.semester           if record else None,
        'accuracy':          float(record.accuracy)   if record and record.accuracy else None,
        'training_rows':     record.training_row_count if record else None,
    })


@upload_bp.route('/api/confirm-upload/<int:upload_id>', methods=['POST'])
def api_confirm_upload(upload_id: int):
    """
    User clicked "Save & separate CSVs" on the preprocessing modal.
    Triggers CSV separation + training in a background thread.
    """
    user = _current_user()
    if not user or user.role not in UPLOAD_ALLOWED_ROLES:
        return jsonify({'ok': False, 'error': 'Unauthorized.'}), 403

    record = UploadedDataset.query.get(upload_id)
    if not record:
        return jsonify({'ok': False, 'error': 'Upload record not found.'}), 404
    if record.status == 'separating':
        # Already running (double-click, second tab, retry) — don't start a 2nd thread.
        return jsonify({'ok': False, 'already_running': True,
                        'error': 'Separation is already running for this upload.'}), 409
    if record.status not in ('preprocessing_done', 'done'):
        return jsonify({'ok': False, 'error': f"Cannot confirm — status is '{record.status}'."}), 400

    ay  = record.academic_year
    sem = record.semester

    # Claim the upload atomically. The old code left status='preprocessing_done'
    # for the whole time the background thread ran, so the page's status poll
    # kept seeing 'preprocessing_done' and re-opened the confirmation modal.
    # A conditional UPDATE also guarantees only ONE request wins the race.
    claimed = (
        UploadedDataset.query
        .filter(UploadedDataset.id == upload_id,
                UploadedDataset.status.in_(['preprocessing_done', 'done']))
        .update({'status': 'separating', 'error_message': None},
                synchronize_session=False)
    )
    db.session.commit()
    if not claimed:
        return jsonify({'ok': False, 'already_running': True,
                        'error': 'Separation is already running for this upload.'}), 409

    app = current_app._get_current_object()
    threading.Thread(
        target=_run_separation_and_train,
        args=(app, upload_id, ay, sem),
        daemon=True,
    ).start()

    return jsonify({'success': True, 'ok': True, 'status': 'separating',
                    'message': 'CSV separation started.'})


@upload_bp.route('/api/upload-record/<int:record_id>', methods=['DELETE'])
def api_delete_upload_record(record_id: int):
    """
    Cancel / remove a pending, preprocessing_done, or failed upload.
    Deletes warnings, raw file, and DB record.
    """
    user = _current_user()
    if not user or user.role not in UPLOAD_ALLOWED_ROLES:
        return jsonify({'ok': False, 'error': 'Unauthorized.'}), 403

    record = UploadedDataset.query.get(record_id)
    if not record:
        return jsonify({'ok': False, 'error': 'Record not found.'}), 404
    if record.status not in ('failed', 'pending', 'preprocessing_done'):
        return jsonify({'ok': False, 'error': f"Cannot remove status '{record.status}'."}), 400

    try:
        delete_preprocessing_warnings(record_id)
    except Exception:
        pass

    _wipe_record_files(record)
    db.session.delete(record)
    db.session.commit()

    # CHANGED: preprocessing now only STAGES its result (staged_uploads
    # table) — it no longer writes into semester_uploads/longform_uploads
    # until the user confirms (see _run_separation_and_train()). So
    # cancelling a 'pending'/'failed'/'preprocessing_done' upload never
    # touched the shared tables in the first place; all that's left to
    # clean up is this upload's own staged row. (The old purge_semester_data()
    # round-trip is no longer needed on this path.)
    try:
        delete_staged_upload(record_id)
    except Exception as exc:
        print(f"[upload_routes] cancel cleanup warning (non-fatal, harmless leftover staged row): {exc}")

    return jsonify({'ok': True, 'message': 'Upload record removed.'})


# ── Tab data endpoints ─────────────────────────────────────────────────────

@upload_bp.route('/api/uploads-with-warnings')
def api_uploads_with_warnings():
    """Tab 1 — files with any warnings (null/highlight/resolved counts per upload)."""
    from util.db_io import get_engine
    from sqlalchemy import text
    try:
        with get_engine().connect() as conn:
            rows = conn.execute(text("""
                SELECT
                    u.id, u.original_filename, u.academic_year, u.semester,
                    u.accuracy, u.uploaded_at,
                    SUM(CASE WHEN w.tier = 'null'      THEN 1 ELSE 0 END) AS null_count,
                    SUM(CASE WHEN w.tier = 'highlight' THEN 1 ELSE 0 END) AS highlight_count,
                    SUM(CASE WHEN w.tier = 'resolved'  THEN 1 ELSE 0 END) AS resolved_count
                FROM uploaded_dataset u
                LEFT JOIN preprocessing_warnings w ON w.upload_id = u.id
                WHERE u.is_deleted = 0
                  AND u.status NOT IN ('failed','pending')
                GROUP BY u.id
                HAVING (null_count + highlight_count + resolved_count) > 0
                ORDER BY u.uploaded_at DESC
            """)).fetchall()
        return jsonify([dict(r._mapping) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@upload_bp.route('/api/training-csv-list')
def api_training_csv_list():
    """Tab 2 — confirmed uploads (semester_uploads)."""
    from util.db_io import get_engine
    from sqlalchemy import text
    try:
        with get_engine().connect() as conn:
            rows = conn.execute(text("""
                SELECT
                    u.id AS upload_id,
                    u.original_filename,
                    s.academic_year, s.semester,
                    s.student_rows, s.longform_rows AS training_rows,
                    u.excluded_row_count AS excluded_rows,
                    s.accuracy,
                    u.uploaded_at
                FROM semester_uploads s
                JOIN uploaded_dataset u
                  ON u.academic_year = s.academic_year
                  AND u.semester     = s.semester
                  AND u.is_deleted   = 0
                ORDER BY s.academic_year DESC, s.semester DESC
            """)).fetchall()
        return jsonify([dict(r._mapping) for r in rows])
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@upload_bp.route('/api/model-datasets-list')
def api_model_datasets_list():
    """Tab 3 — DS00-DS06 entries per semester."""
    try:
        files = list_model_dataset_files()
        return jsonify(files)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@upload_bp.route('/api/archives-list')
def api_archives_list():
    """Tab 4 — all archived semesters."""
    try:
        archives = list_archives()
        # Convert datetime objects to string for JSON
        for a in archives:
            for k, v in a.items():
                if hasattr(v, 'isoformat'):
                    a[k] = v.strftime('%b %d, %Y %I:%M %p')
        return jsonify(archives)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── CSV preview / download ─────────────────────────────────────────────────

@upload_bp.route('/api/csv-preview')
def api_csv_preview():
    """
    Returns {csv: "..."} for the CSV viewer modal.
    ?type=longform|training|dataset  &ay=  &sem=  [&key=DS01]
    """
    table_type  = request.args.get('type', 'longform')
    ay          = request.args.get('ay', '')
    sem         = request.args.get('sem', '')
    dataset_key = request.args.get('key')

    try:
        csv_text = get_csv_for_download(table_type, ay, sem, dataset_key)
        if csv_text is None:
            return jsonify({'error': 'CSV not found.'}), 404
        return jsonify({'csv': csv_text})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@upload_bp.route('/api/csv-download')
def api_csv_download():
    """
    Returns the CSV file for download.
    Same params as /api/csv-preview.
    """
    import io as _io
    table_type  = request.args.get('type', 'longform')
    ay          = request.args.get('ay', '')
    sem         = request.args.get('sem', '')
    dataset_key = request.args.get('key')

    try:
        csv_text = get_csv_for_download(table_type, ay, sem, dataset_key)
        if csv_text is None:
            return jsonify({'error': 'CSV not found.'}), 404

        fname = f"{dataset_key or table_type}_{ay}_{sem}.csv".replace(' ', '_')
        return send_file(
            _io.BytesIO(csv_text.encode('utf-8')),
            mimetype='text/csv',
            as_attachment=True,
            download_name=fname,
        )
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Archive / restore ──────────────────────────────────────────────────────

@upload_bp.route('/api/archive-semester', methods=['POST'])
def api_archive_semester():
    """Archive all data for one (upload_id, academic_year, semester)."""
    user = _current_user()
    if not user or user.role not in UPLOAD_ALLOWED_ROLES:
        return jsonify({'ok': False, 'error': 'Unauthorized.'}), 403

    body      = request.get_json(silent=True) or {}
    upload_id = body.get('upload_id')
    ay        = body.get('academic_year', '')
    sem       = body.get('semester', '')

    if not upload_id or not ay or not sem:
        return jsonify({'ok': False, 'error': 'upload_id, academic_year, and semester are required.'}), 400

    try:
        archive_id = archive_semester(
            upload_id=upload_id,
            academic_year=ay,
            semester=sem,
            archived_by=user.acaduser_id,
        )
        return jsonify({'success': True, 'archive_id': archive_id})
    except Exception as e:
        return jsonify({'success': False, 'error': str(e)}), 500


@upload_bp.route('/api/restore-archive/<int:archive_id>', methods=['POST'])
def api_restore_archive(archive_id: int):
    """Restore a semester from archive."""
    user = _current_user()
    if not user or user.role not in UPLOAD_ALLOWED_ROLES:
        return jsonify({'ok': False, 'error': 'Unauthorized.'}), 403

    try:
        result = restore_semester(archive_id)
        return jsonify(result)
    except Exception as e:
        return jsonify({'ok': False, 'reason': str(e)}), 500


# ── Existing routes (unchanged) ────────────────────────────────────────────

@upload_bp.route('/api/reset-database', methods=['POST'])
def api_reset_database():
    user = _current_user()
    if not user:
        return jsonify({'ok': False, 'error': 'Not logged in.'}), 401
    role = str(getattr(user, 'role', '') or '').strip().lower().replace(' ', '_').replace('-', '_')
    if role != 'academic_affair':
        return jsonify({'ok': False, 'error': f'Admin role required. (your role: {role or "none"})'}), 403

    body = request.get_json(silent=True) or {}
    if body.get('confirm') != 'RESET':
        return jsonify({'ok': False, 'error': 'Send {"confirm": "RESET"} to proceed.'}), 400

    active = UploadedDataset.query.filter(
        UploadedDataset.status.in_(['processing', 'preprocessing_done', 'separating'])
    ).all()
    if active and not body.get('force'):
        names = ', '.join(a.original_filename or f'#{a.id}' for a in active)
        return jsonify({
            'ok': False,
            'error': f'Upload(s) still processing or awaiting confirmation: {names}. '
                     f'Wait for them to finish (or cancel them) before resetting, '
                     f'or send {{"confirm":"RESET","force":true}} to override.',
        }), 409

    try:
        UploadedDataset.query.delete()
        db.session.commit()

        from util.db_io import reset_all_data
        reset_all_data()

        import shutil
        for dir_path in (UNPROCESSED_DATASETS_DIR, PROCESSED_DATASETS_DIR,
                          PROCESSED_BY_YEAR_DIR, MODEL_DATASETS_DIR):
            if dir_path and os.path.isdir(dir_path):
                for name in os.listdir(dir_path):
                    full = os.path.join(dir_path, name)
                    try:
                        shutil.rmtree(full) if os.path.isdir(full) else os.remove(full)
                    except OSError as e:
                        print(f"[reset-database] cleanup warning: {e}")
        if FINAL_MERGED_CSV and os.path.exists(FINAL_MERGED_CSV):
            os.remove(FINAL_MERGED_CSV)

        _reload_ml_models()
        return jsonify({'ok': True, 'message': 'Database reset. All uploads, models, and training state cleared.'})
    except Exception as e:
        db.session.rollback()
        return jsonify({'ok': False, 'error': str(e)}), 500


@upload_bp.route('/api/failed-uploads')
def api_failed_uploads():
    records = (
        UploadedDataset.query
        .filter_by(status='failed')
        .order_by(UploadedDataset.uploaded_at.desc())
        .all()
    )
    return jsonify([r.to_dict() for r in records])


@upload_bp.route('/api/training-run')
def api_training_run():
    """Lifecycle + result of the latest auto-training run (drives the last step
    of the upload pipeline and the 'training complete' card)."""
    try:
        return jsonify(_effective_training_run())
    except Exception as e:
        return jsonify({'status': 'none', 'error': str(e)}), 200


@upload_bp.route('/api/training-state')
def api_training_state():
    state = _load_training_state()
    if not state:
        return jsonify({'status': 'no_training_yet'}), 200
    return jsonify(state)


# ── Model performance (unchanged logic, updated labels) ───────────────────

_MODEL_LABELS = {
    # New DS01-DS06 models
    'at_risk':                  'At-Risk Classification',
    'gwa_regression':           'GWA Prediction',
    'completion_rate_forecast': 'Completion Rate Forecast',
    'subject_Fail_Rate':        'Subject Fail Rate',
    'subject_Avg_Grade':        'Subject Average Grade',
    'at_risk_forecast':         'At-Risk Forecast (per Group)',
    'gwa_trend_forecast':       'GWA Trend Forecast (per Group)',
}

_CHART_USAGE = {
    'at_risk':                  'Student Status Donut / At-Risk Flag',
    'gwa_regression':           'GWA KPI Tile / GWA Trend Chart',
    'completion_rate_forecast': 'Completion Rate KPI Tile',
    'subject_Fail_Rate':        'Hardest Subjects Chart (Fail Rate)',
    'subject_Avg_Grade':        'Hardest Subjects Chart (Avg Grade)',
    'at_risk_forecast':         'At-Risk Forecast Line Chart (DS05)',
    'gwa_trend_forecast':       'GWA Trend Forecast Chart (DS06)',
}


def _titled_label(key: str, label: str) -> str:
    chart = _CHART_USAGE.get(key)
    return f"{label} — {chart}" if chart else f"{label} — Not Used in Any Chart Yet"


def _build_flat_entry(key: str, label: str, result: dict) -> dict:
    status  = result.get('status', 'ok' if 'error' not in result else 'error')
    metrics = {k: v for k, v in result.items() if k not in ('status', 'reason', 'error')}
    if 'f1' in metrics:
        headline_label, headline_value = 'F1 Score', metrics['f1']
    elif 'accuracy' in metrics:
        headline_label, headline_value = 'Accuracy', metrics['accuracy']
    elif 'r2' in metrics:
        headline_label, headline_value = 'R² Score', metrics['r2']
    else:
        headline_label, headline_value = None, None
    return {
        'key': key, 'label': _titled_label(key, label),
        'status': status,
        'headline_label': headline_label, 'headline_value': headline_value,
        'metrics': metrics,
        'reason': result.get('reason') or result.get('error'),
    }


def _flatten_metric_block(key: str, result: dict) -> list:
    if not isinstance(result, dict):
        return [{'key': key, 'label': _titled_label(key, key), 'status': 'unknown',
                  'headline_label': None, 'headline_value': None, 'metrics': {}}]
    has_nested = any(isinstance(v, dict) for v in result.values())
    if not has_nested:
        label = _MODEL_LABELS.get(key, key.replace('_', ' ').title())
        return [_build_flat_entry(key, label, result)]
    base_label = _MODEL_LABELS.get(key, key.replace('_', ' ').title())
    entries = []
    for sub_name, sub_result in result.items():
        if not isinstance(sub_result, dict):
            continue
        sub_key   = f"{key}_{sub_name}"
        sub_label = sub_name.replace('_', ' ').title()
        entries.append(_build_flat_entry(sub_key, f"{base_label} — {sub_label}", sub_result))
    return entries or [_build_flat_entry(key, base_label, {'status': 'skipped'})]


@upload_bp.route('/api/model-performance')
def api_model_performance():
    state = _load_training_state()
    if not state:
        return jsonify({'status': 'no_training_yet', 'message': 'No model trained yet.', 'models': []}), 200
    models = []
    for key, result in state.get('models', {}).items():
        models.extend(_flatten_metric_block(key, result))
    return jsonify({
        'status': 'ok',
        'trained_at':      state.get('trained_at'),
        'rows_in_master':  state.get('rows_in_master'),
        'elapsed_seconds': state.get('elapsed_seconds'),
        'errors':          state.get('errors', []),
        'horizon':         state.get('horizon', {}),
        'models':          models,
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


@upload_bp.route('/api/processed-list')
def api_processed_list():
    """Kept for backward compat — old frontend still calls this."""
    records = (
        UploadedDataset.query
        .filter_by(status='done', is_deleted=False)
        .order_by(UploadedDataset.uploaded_at.desc())
        .all()
    )
    model_files = list_model_dataset_files()
    state       = _load_training_state()
    return jsonify({
        'uploaded_records'   : [r.to_dict() for r in records],
        'model_files'        : model_files,
        'merged_csv_exists'  : os.path.exists(FINAL_MERGED_CSV),
        'horizon'            : state.get('horizon', {}),
        'semesters_collected': state.get('semesters_collected', 0),
        'semesters_needed'   : MIN_SEMESTERS_FOR_TRAINING,
        'training_status'    : state.get('training_status'),
    })