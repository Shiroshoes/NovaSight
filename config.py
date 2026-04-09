import os

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# Flask & DB
SQLALCHEMY_DATABASE_URI = 'sqlite:///' + os.path.join(BASE_DIR, 'nova.db')
SQLALCHEMY_TRACK_MODIFICATIONS = False
SECRET_KEY = 'your_secret_key_here'

# File upload
UPLOAD_FOLDER = os.path.join(BASE_DIR, 'static/uploads')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg'}
MAX_CONTENT_LENGTH = 5 * 1024 * 1024  # 5MB max

# User roles
ALLOWED_ROLES = [
    'admin', 'Registrar', 'SASO',
    'CAHSdean', 'CBAdean', 'CCSTdean',
    'CEAdean', 'CoASdean', 'CTECdean'
]