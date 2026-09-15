import os
import re

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# ── Database (MySQL via XAMPP) ────────────────────────────────
# XAMPP's MySQL defaults: host=localhost, port=3306, user=root, no
# password. Overridable via environment variables so the same code
# works once you eventually move off XAMPP to a real production
# MySQL/MariaDB server (just set these env vars there instead).
DB_HOST = os.environ.get('DB_HOST', 'localhost')
DB_PORT = os.environ.get('DB_PORT', '3306')
DB_USER = os.environ.get('DB_USER', 'root')
DB_PASSWORD = os.environ.get('DB_PASSWORD', '')
DB_NAME = os.environ.get('DB_NAME', 'novasight')

SQLALCHEMY_DATABASE_URI = (
    f"mysql+pymysql://{DB_USER}:{DB_PASSWORD}@{DB_HOST}:{DB_PORT}/{DB_NAME}"
)
SQLALCHEMY_TRACK_MODIFICATIONS = False

# SECRET_KEY signs every session cookie — anyone who knows this value can
# forge a valid login session for ANY user, including admin. Must come from
# the environment (set it before starting the app: see the deployment
# guides' systemd Environment= line), never hardcoded here.
# SECRET_KEY signs every session cookie — anyone who knows this value can
# forge a valid login session for ANY user, including admin. Must come from
# the environment (set it before starting the app: see the deployment
# guides' systemd Environment= line), never hardcoded here.
SECRET_KEY = os.environ.get('SECRET_KEY')
if not SECRET_KEY:
    raise RuntimeError("SECRET_KEY environment variable is not set.")

# Minimum acceptable password length, enforced everywhere a password is
# created or changed (admin.py's add_user/update_user, and every role's
# own update_password route). Kept here as one shared constant so the
# requirement can't silently drift out of sync between routes.
MIN_PASSWORD_LENGTH = 8

# ── Profile image uploads ─────────────────────────────────────
UPLOAD_FOLDER      = os.path.join(BASE_DIR, 'app', 'static', 'uploads')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg'}
# Real image formats accepted after content verification (extension alone is spoofable)
ALLOWED_IMAGE_FORMATS = {'JPEG', 'PNG'}
# Avatars only — the unlimited size note below is specifically about dataset
# uploads (DATASET_MAX_SIZE_MB), not this. Avatars get their own small cap.
AVATAR_MAX_SIZE_MB = 5
AVATAR_MAX_DIMENSION_PX = 1024  # long edge is downscaled to this on upload
# Hard cap on decoded pixel count (width * height), checked BEFORE the image
# is resized down to AVATAR_MAX_DIMENSION_PX. A small file on disk can still
# decompress into a huge pixel buffer in memory (a "decompression bomb") —
# this catches that regardless of how small the uploaded file itself is.
# 40 megapixels comfortably covers even a high-res modern phone photo while
# sitting well below Pillow's own default warn/error thresholds (~89M/~179M).
AVATAR_MAX_PIXELS = 40_000_000
# No MAX_CONTENT_LENGTH set globally — dataset uploads below have their own
# separate cap (DATASET_MAX_SIZE_MB) instead of a single global limit.

# ── Grade-sheet dataset folders ───────────────────────────────
# Raw uploads land here first (used as the duplicate-check source)
UNPROCESSED_DATASETS_DIR = os.path.join(BASE_DIR, 'Unprocessed_Datasets')

# The preprocessor writes final CSVs here; models read from here
PROCESSED_DATASETS_DIR = os.path.join(BASE_DIR, 'Processed_Datasets')

# ── Per-year processed data ────────────────────────────────────
# LEGACY PATH CONSTANTS — NOT auto-created anymore (2026-09-15).
# Everything that used to live under these folders (semester grade
# data, model_datasets CSVs, trained .pkl models, one-step-back
# backups) now lives in MySQL only:
#   - semester/model data          -> semester_uploads / longform_uploads
#     tables (see db_io.py, preprocess.py)
#   - trained models + state       -> trained_model_files / training_state_kv
#     tables (see db_io.py's save_model_blob/load_model_blob,
#     save_training_state/load_training_state)
#   - one-step-back backup feature -> REMOVED. There is no backup/restore
#     anymore; deleting the most recent upload is no longer undoable this
#     way. (auto_train.py's snapshot_to_backup/restore_from_backup/
#     clear_backup/backup_exists were deleted along with BACKUP_DIR etc.)
#
# These path constants are kept ONLY because a couple of function
# signatures in preprocess.py still take a directory argument even
# though (per its own comments) it no longer writes there. Do not add
# any os.makedirs() calls back for these — if you find code that still
# actually needs one of these folders to exist on disk, that's a sign
# it hasn't finished migrating to MySQL yet, not a reason to recreate
# the folder.
PROCESSED_BY_YEAR_DIR = os.path.join(PROCESSED_DATASETS_DIR, 'by_year')

# Auto-train (model retraining) is gated on how many individual SEMESTERS
# currently have data — NOT distinct academic years. Uploads don't land
# a clean 2-per-year, so counting distinct years (the old
# MIN_YEARS_FOR_TRAINING gate) could fire training a semester early or
# late depending on how uploads happened to spread across years. Below
# this count, uploads still preprocess and save normally (so the
# dashboard's Recent Data view stays current) but no model (re)training
# runs — the trend-based models need multiple semesters of history to
# mean anything. Once the threshold is reached, training runs on ALL
# semesters accumulated so far and keeps growing from there (6, then 7,
# then 8, ...) — it is NOT a rolling window that drops old semesters.
# (Gate check itself now queries MySQL — see count_semesters_with_data()
# in preprocess.py — this constant is unaffected.)
MIN_SEMESTERS_FOR_TRAINING = 6

# Model-specific CSVs — superseded by MySQL tables, see note above.
MODEL_DATASETS_DIR = os.path.join(PROCESSED_DATASETS_DIR, 'model_datasets')

# Master merged file — superseded by `SELECT * FROM student_data`.
FINAL_MERGED_CSV = os.path.join(PROCESSED_DATASETS_DIR, 'Final_Merged_Student_Data.csv')

# Trained model files used to live here as .pkl + training_state.json.
# REMOVED (2026-09-15): models are now stored as BLOBs in MySQL's
# trained_model_files table and training_state.json's content now lives
# in training_state_kv — see db_io.py. This constant is kept only in
# case some other file still imports ML_MODEL_DIR; nothing should be
# writing to it anymore and it is no longer auto-created.
ML_MODEL_DIR = os.path.join(BASE_DIR, 'Machine_Learning_Model')

# ── One-step-back backup snapshot ──────────────────────────────
# REMOVED (2026-09-15) — per your call, the whole "delete-most-recent-
# upload restores a backup" feature is gone. There is no more Backup/
# folder, no snapshot before merge, no restore path. If you want an
# undo feature again later, it should be built on top of MySQL directly
# (e.g. keep the previous semester_uploads row instead of a file
# backup) rather than resurrecting this folder.

# Soft-deleted upload records (Recently Deleted table) are permanently
# purged after this many days.
SOFT_DELETE_EXPIRY_DAYS = 30

# ── Dataset file validation ───────────────────────────────────
DATASET_ALLOWED_EXTENSIONS = {'xlsx'}
# Was previously None (no limit) — a genuinely unbounded upload endpoint is
# a disk-fill DoS risk on its own, and combines badly with .xlsx files being
# zip archives: a small file can still expand into something huge once
# something actually tries to read it. 50MB is generous headroom over any
# realistic single-semester grade sheet while still bounding the worst case.
DATASET_MAX_SIZE_MB = 50

# Accepted filename formats (spaces OR underscores between parts):
#   2022-1 Student-Performance Dataset.xlsx
#   2022-1_Student-Performance_Dataset.xlsx
#   2025-2 Student-Performance Dataset.xlsx
DATASET_FILENAME_REGEX = re.compile(
    r'^\d{4}-[12][_ ]Student-Performance[_ ]Dataset\.xlsx$',
    re.IGNORECASE
)

# ── Roles ─────────────────────────────────────────────────────
# CAHS used to be one role (CAHSdean). It's now split into four
# program-level dean/director roles that all share the same CAHS pages
# (routes/cahs.py) and dashboard — CAHS_ROLES is the group used wherever
# code needs to check "is this a CAHS-side account" instead of a single
# hardcoded role string.
CAHS_ROLES = ['NurseDean', 'PHdean', 'MidwifeDeaan', 'CAHSdirector']

ALLOWED_ROLES = [
    'Academic_Affair', 'Registrar', 'SASO', 'MISO',
    *CAHS_ROLES, 'CBAdean', 'CCSTdean', 'CEAdean',
    'CoASdean', 'CTECdean',
]

# Human-readable label for each role code — same wording as the <option>
# labels in adminpage.html. Role codes (e.g. 'PHdean') are what's stored in
# the DB/session; this is only for displaying a role to a user (profile
# pages, etc). Falls back to the raw code for anything not listed here.
ROLE_DISPLAY_NAMES = {
    'MISO':           'MISO',
    'Registrar':       'Registrar',
    'SASO':            'SASO',
    'Academic_Affair': 'Academic Affair',
    'NurseDean':       'Nursing Dean',
    'PHdean':          'Public Health Dean',
    'MidwifeDeaan':    'Midwifery Dean',
    'CAHSdirector':    'CAHS Director',
    'CBAdean':         'CBA Dean',
    'CCSTdean':        'CCST Dean',
    'CEAdean':         'CEA Dean',
    'CoASdean':        'CoAS Dean',
    'CTECdean':        'CTEC Dean',
}

# Roles that are allowed to upload grade-sheet datasets
UPLOAD_ALLOWED_ROLES = {'MISO', 'Academic_Affair'}

# ── Auto-create folders on import ─────────────────────────────
# ONLY the folders code actually still writes to at runtime. Everything
# that moved to MySQL (by_year/, model_datasets/, Machine_Learning_Model/,
# Backup/) was removed from this list on purpose — see the comments on
# each constant above. UPLOAD_FOLDER (avatars) and UNPROCESSED_DATASETS_DIR
# (raw .xlsx staging + duplicate-check source) are the only two things
# still genuinely disk-based.
for _d in (UPLOAD_FOLDER, UNPROCESSED_DATASETS_DIR):
    os.makedirs(_d, exist_ok=True)