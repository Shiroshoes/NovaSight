import os
import re

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

# ── Database ──────────────────────────────────────────────────
DB_DIR = os.path.join(BASE_DIR, 'database')
if not os.path.exists(DB_DIR):
    os.makedirs(DB_DIR)

SQLALCHEMY_DATABASE_URI = 'sqlite:///' + os.path.join(DB_DIR, 'nova.db')
SQLALCHEMY_TRACK_MODIFICATIONS = False
SECRET_KEY = 'your_secret_key_here'

# ── Profile image uploads ─────────────────────────────────────
UPLOAD_FOLDER      = os.path.join(BASE_DIR, 'app', 'static', 'uploads')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg'}
# Real image formats accepted after content verification (extension alone is spoofable)
ALLOWED_IMAGE_FORMATS = {'JPEG', 'PNG'}
# Avatars only — the unlimited size note below is specifically about dataset
# uploads (DATASET_MAX_SIZE_MB), not this. Avatars get their own small cap.
AVATAR_MAX_SIZE_MB = 5
AVATAR_MAX_DIMENSION_PX = 1024  # long edge is downscaled to this on upload
# No MAX_CONTENT_LENGTH set globally — dataset uploads below are intentionally unlimited

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

# ── Dataset file validation ───────────────────────────────────
DATASET_ALLOWED_EXTENSIONS = {'xlsx'}
DATASET_MAX_SIZE_MB = None  # No file size limit

# Accepted filename formats (spaces OR underscores between parts):
#   2022-1 Student-Performance Dataset.xlsx
#   2022-1_Student-Performance_Dataset.xlsx
#   2025-2 Student-Performance Dataset.xlsx
DATASET_FILENAME_REGEX = re.compile(
    r'^\d{4}-[12][_ ]Student-Performance[_ ]Dataset\.xlsx$',
    re.IGNORECASE
)

# ── Roles ─────────────────────────────────────────────────────
ALLOWED_ROLES = [
    'admin', 'Registrar', 'SASO', 'Academic_Affair',
    'CAHSdean', 'CBAdean', 'CCSTdean', 'CEAdean',
    'CoASdean', 'CTECdean',
]

# Roles that are allowed to upload grade-sheet datasets
UPLOAD_ALLOWED_ROLES = {'Academic_Affair', 'admin'}

# ── Auto-create folders on import ─────────────────────────────
for _d in (UNPROCESSED_DATASETS_DIR, PROCESSED_DATASETS_DIR, MODEL_DATASETS_DIR, ML_MODEL_DIR):
    os.makedirs(_d, exist_ok=True)