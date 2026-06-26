import os

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


DB_DIR = os.path.join(BASE_DIR, 'database')

if not os.path.exists(DB_DIR):
    os.makedirs(DB_DIR)

SQLALCHEMY_DATABASE_URI = 'sqlite:///' + os.path.join(DB_DIR, 'nova.db')
SQLALCHEMY_TRACK_MODIFICATIONS = False
SECRET_KEY = 'your_secret_key_here'

UPLOAD_FOLDER = os.path.join(BASE_DIR, 'app', 'static', 'uploads')
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg'}
MAX_CONTENT_LENGTH = 5 * 1024 * 1024 # 5MB max

ALLOWED_ROLES = [
    'admin', 'Registrar', 'SASO', 'Student_Affair', 
    'CAHSdean', 'CBAdean', 'CCSTdean', 'CEAdean', 
    'CoASdean', 'CTECdean'
]
