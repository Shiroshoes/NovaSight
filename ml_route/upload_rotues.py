import os
import re
import time
import threading
import shutil

from flask import Blueprint, request, jsonify, session, render_template, current_app
from werkzeug.utils import secure_filename

from database.models import db, AcadUser, UploadedDataset
from configs.config import (
    UNPROCESSED_DATASETS_DIR,
    PROCESSED_DATASETS_DIR,
    MODEL_DATASETS_DIR,
    FINAL_MERGED_CSV,
    DATASET_ALLOWED_EXTENSIONS,
    DATASET_MAX_SIZE_MB,
    DATASET_FILENAME_REGEX,
    UPLOAD_ALLOWED_ROLES,
)
from training.auto_train import run_full_pipeline, load_state

upload_bp = Blueprint('upload_bp', __name__)


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
    Return a normalised canonical name used for duplicate detection.
    Spaces and underscores are treated as equivalent.
    e.g. '2022-1 Student-Performance Dataset.xlsx'
      →  '2022-1_Student-Performance_Dataset.xlsx'
    """
    return filename.replace(' ', '_')


# ─────────────────────────────────────────────────────────────
# BACKGROUND WORKER
# ─────────────────────────────────────────────────────────────

def _background_train(app, record_id: int, raw_path: str):
    """
    Background thread:
      1. Run full preprocessing + model retraining pipeline
      2. Update DB record on completion
    """
    with app.app_context():
        record = UploadedDataset.query.get(record_id)
        if not record:
            return

        record.status = 'processing'
        db.session.commit()

        try:
            state = run_full_pipeline(new_file=raw_path)

            row_count  = state.get('rows_in_master')
            label      = (record.academic_year or '').replace('-', '_')
            sem_csv    = os.path.join(
                PROCESSED_DATASETS_DIR,
                f"{label}_{record.semester}_cleaned.csv"
            )
            proc_path  = sem_csv if os.path.exists(sem_csv) else FINAL_MERGED_CSV

            record.processed      = True
            record.status         = 'done'
            record.processed_path = proc_path
            record.row_count      = row_count
            db.session.commit()

            # Hot-reload ML models so the dashboard reflects the new PKLs
            # immediately without requiring a Flask restart.
            try:
                from ml_route.ml_analysis import reload_models
                reload_models()
            except Exception as _re:
                print(f"[upload_routes] reload_models warning: {_re}")

        except Exception as exc:
            import traceback
            record.status        = 'failed'
            record.error_message = str(exc)
            db.session.commit()
            traceback.print_exc()


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

    # Measure size for display only (no limit enforced)
    f.seek(0, 2)
    size_bytes = f.tell()
    f.seek(0)

    # ── Format validation (extension + filename pattern only) ──
    ok, reason = _validate_dataset_file(f.filename)
    if not ok:
        return jsonify({'ok': False, 'error': reason}), 422

    # ── Duplicate check (canonical name in Unprocessed_Datasets/) ──
    canonical = _canonical_name(f.filename)
    orig_path = os.path.join(UNPROCESSED_DATASETS_DIR, canonical)

    if os.path.exists(orig_path):
        dup = UploadedDataset.query.filter(
            UploadedDataset.original_filename.in_([f.filename, canonical])
        ).first()
        return jsonify({
            'ok'       : False,
            'duplicate': True,
            'error'    : (
                f"<strong>'{f.filename}'</strong> has already been uploaded"
                + (
                    f" by <strong>{dup.uploader.username}</strong>"
                    f" on {dup.uploaded_at.strftime('%b %d, %Y')}"
                    if dup else ''
                )
                + ".<br>If this is a different dataset please rename the file and re-upload."
            ),
        }), 409

    # ── Save raw file ─────────────────────────────────────────
    stored_name = _safe_stored_name(user.acaduser_id, f.filename)
    raw_path    = os.path.join(UNPROCESSED_DATASETS_DIR, stored_name)
    f.save(raw_path)

    # Keep a canonical-name copy for future duplicate checks
    shutil.copy2(raw_path, orig_path)

    year, semester = _parse_filename_meta(f.filename)
    size_kb = round(size_bytes / 1024, 1)

    # ── Count sheets ─────────────────────────────────────────
    sheet_count = None
    try:
        from openpyxl import load_workbook
        wb = load_workbook(raw_path, read_only=True)
        sheet_count = len(wb.sheetnames)
        wb.close()
    except Exception:
        pass

    # ── Create DB record ──────────────────────────────────────
    record = UploadedDataset(
        original_filename = f.filename,
        stored_filename   = stored_name,
        raw_path          = raw_path,
        status            = 'pending',
        uploaded_by       = user.acaduser_id,
        academic_year     = year,
        semester          = semester,
        file_size_kb      = size_kb,
        sheet_count       = sheet_count,
    )
    db.session.add(record)
    db.session.commit()

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
_MODEL_LABELS = {
    'dropout_risk':       'Dropout Risk (per Student)',
    'dropout_spike':      'Dropout Spike (Cohort Trend)',
    'dropout_ranking':    'Dropout Ranking (per College)',
    'gwa_ranking':        'GWA Ranking (per College)',
    'gwa_trend':          'GWA Trend (Time-Series)',
    'inc_forecast':       'INC Rate Forecast',
    'irreg_reg':          'Irregular vs Regular Rate',
    'kpi':                'KPI — GWA, Enrollment & Drop',
    'subject_grade':      'Subject Grade Forecast',
    'performance_band':   'Performance Band Distribution',
    'gender_performance': 'Gender Performance (Dropout & GWA)',
}


def _flatten_metric_block(result: dict) -> dict:
    """
    Normalise the differently-shaped result dicts each trainer returns into
    one consistent set of display fields: status, a primary headline metric
    (accuracy if classification, R^2 if regression), and the rest as
    secondary metrics.

    Some trainers return a NESTED dict — one sub-result per sub-model —
    instead of a flat set of metrics (train_kpi's 'gwa'/'enrollment',
    train_gender_performance's 'dropout_rate'/'avg_gwa'). Detected
    generically here: if any top-level value is itself a dict, every such
    value is treated as a named sub-model result and flattened under
    `{sub_name}_{metric}` keys — so this covers any future multi-submodel
    trainer too, not just today's two, without hardcoding key names.
    """
    if not isinstance(result, dict):
        return {'status': 'unknown', 'headline_label': None, 'headline_value': None, 'metrics': {}}

    status = result.get('status', 'ok' if 'error' not in result else 'error')

    has_nested_submodels = any(isinstance(v, dict) for v in result.values())

    if has_nested_submodels:
        sub_metrics = {}
        for sub_name, sub_result in result.items():
            if isinstance(sub_result, dict):
                for k, v in sub_result.items():
                    sub_metrics[f"{sub_name}_{k}"] = v

        # Headline = first R^2 found, in insertion order (matches the old
        # hardcoded 'gwa_r2' behavior for train_kpi); falls back to the
        # first accuracy if a nested block is ever classification-based.
        headline_label, headline_value = None, None
        for k, v in sub_metrics.items():
            if k.endswith('_r2'):
                pretty = k[:-3].replace('_', ' ').title()
                headline_label, headline_value = f'R² ({pretty})', v
                break
        if headline_label is None:
            for k, v in sub_metrics.items():
                if k.endswith('_accuracy'):
                    pretty = k[:-9].replace('_', ' ').title()
                    headline_label, headline_value = f'Accuracy ({pretty})', v
                    break

        return {
            'status': 'ok' if sub_metrics else 'skipped',
            'headline_label': headline_label,
            'headline_value': headline_value,
            'metrics': sub_metrics,
        }

    metrics = {k: v for k, v in result.items() if k not in ('status', 'reason', 'error')}

    # Prefer accuracy/F1 for classifiers, R^2 for regressors
    if 'accuracy' in metrics:
        headline_label, headline_value = 'Accuracy', metrics['accuracy']
    elif 'r2' in metrics:
        headline_label, headline_value = 'R² Score', metrics['r2']
    else:
        headline_label, headline_value = None, None

    return {
        'status': status,
        'headline_label': headline_label,
        'headline_value': headline_value,
        'metrics': metrics,
        'reason': result.get('reason') or result.get('error'),
    }


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
        flat = _flatten_metric_block(result)
        models.append({
            'key': key,
            'label': _MODEL_LABELS.get(key, key.replace('_', ' ').title()),
            **flat,
        })

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
        .order_by(UploadedDataset.uploaded_at.desc())
        .all()
    )
    return jsonify([r.to_dict() for r in records])


@upload_bp.route('/api/processed-list')
def api_processed_list():
    records = (
        UploadedDataset.query
        .filter_by(status='done')
        .order_by(UploadedDataset.uploaded_at.desc())
        .all()
    )

    # Model dataset files on disk
    model_files = []
    if os.path.isdir(MODEL_DATASETS_DIR):
        for fname in sorted(os.listdir(MODEL_DATASETS_DIR)):
            if fname.endswith('.csv'):
                fpath = os.path.join(MODEL_DATASETS_DIR, fname)
                model_files.append({
                    'filename': fname,
                    'size_kb' : f"{os.path.getsize(fpath) / 1024:.1f} KB",
                    'modified': time.strftime(
                        '%b %d, %Y  %I:%M %p',
                        time.localtime(os.path.getmtime(fpath))
                    ),
                })

    state   = load_state()
    horizon = state.get('horizon', {})

    return jsonify({
        'uploaded_records'  : [r.to_dict() for r in records],
        'model_files'       : model_files,
        'merged_csv_exists' : os.path.exists(FINAL_MERGED_CSV),
        'horizon'           : horizon,
    })