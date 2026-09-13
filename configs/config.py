import os
import re

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# ── Database ──────────────────────────────────────────────────
DB_DIR = os.path.join(BASE_DIR, 'database')
if not os.path.exists(DB_DIR):
    os.makedirs(DB_DIR)

SQLALCHEMY_DATABASE_URI = 'sqlite:///' + os.path.join(DB_DIR, 'nova.db')
SQLALCHEMY_TRACK_MODIFICATIONS = False

# SECRET_KEY signs every session cookie — anyone who knows this value can
# forge a valid login session for ANY user, including admin. Must come from
# the environment (set it before starting the app: see the deployment
# guides' systemd Environment= line), never hardcoded here.
SECRET_KEY = os.environ.get('SECRET_KEY')
if not SECRET_KEY:
    raise RuntimeError(
        "SECRET_KEY environment variable is not set. Generate one with:\n"
        "  python3 -c \"import secrets; print(secrets.token_hex(32))\"\n"
        "then set it in your environment before starting the app."
    )

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

# Model-specific CSVs live inside a sub-folder
MODEL_DATASETS_DIR = os.path.join(PROCESSED_DATASETS_DIR, 'model_datasets')

# Master merged file (all years combined)
FINAL_MERGED_CSV = os.path.join(PROCESSED_DATASETS_DIR, 'Final_Merged_Student_Data.csv')

# Trained model files (.pkl) + training_state.json live here.
# Anchored to BASE_DIR for the same reason as the dataset folders above:
# auto_train.py (writer) and ml_analysis.py (reader) must agree on one
# physical folder no matter what directory the process is launched from.
ML_MODEL_DIR = os.path.join(BASE_DIR, 'Machine_Learning_Model')

# ── One-step-back backup snapshot (delete-most-recent-upload feature) ──
# Right before a new semester file is merged into the shared master
# CSV/models, auto_train.py copies the CURRENT ("Recent") state of the
# master CSV, the long-form CSV, every model_datasets/*.csv, and every
# trained .pkl + training_state.json into this folder, OVERWRITING
# whatever backup was there before. This means there is only ever ONE
# backup slot (the state right before the most recent upload) — deleting
# the most recent upload restores this snapshot and then the slot is
# empty again until the next upload creates a fresh one.
BACKUP_DIR                 = os.path.join(BASE_DIR, 'Backup')
BACKUP_MODEL_DATASETS_DIR  = os.path.join(BACKUP_DIR, 'model_datasets')
BACKUP_ML_MODEL_DIR        = os.path.join(BACKUP_DIR, 'Machine_Learning_Model')
BACKUP_FINAL_MERGED_CSV    = os.path.join(BACKUP_DIR, 'Final_Merged_Student_Data.csv')
BACKUP_LONGFORM_CSV        = os.path.join(BACKUP_DIR, 'Final_LongForm_Student_Grades.csv')

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
    'admin', 'Registrar', 'SASO', 'Academic_Affair',
    *CAHS_ROLES, 'CBAdean', 'CCSTdean', 'CEAdean',
    'CoASdean', 'CTECdean',
]

# Human-readable label for each role code — same wording as the <option>
# labels in adminpage.html. Role codes (e.g. 'PHdean') are what's stored in
# the DB/session; this is only for displaying a role to a user (profile
# pages, etc). Falls back to the raw code for anything not listed here.
ROLE_DISPLAY_NAMES = {
    'admin':           'Admin',
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
UPLOAD_ALLOWED_ROLES = {'Academic_Affair', 'admin'}

# ── Auto-create folders on import ─────────────────────────────
for _d in (UNPROCESSED_DATASETS_DIR, PROCESSED_DATASETS_DIR, MODEL_DATASETS_DIR, ML_MODEL_DIR,
           BACKUP_DIR, BACKUP_MODEL_DATASETS_DIR, BACKUP_ML_MODEL_DIR):
    os.makedirs(_d, exist_ok=True)