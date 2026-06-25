import os
import time
from werkzeug.utils import secure_filename
from configs.config import UPLOAD_FOLDER, ALLOWED_EXTENSIONS

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def generate_filename(user_id, original_filename):
    """
    Generate a collision-safe filename using user_id + timestamp + original filename.
    """
    return f"{user_id}_{int(time.time())}_{secure_filename(original_filename)}"

def save_file(file, user_id, upload_folder=UPLOAD_FOLDER):
    """
    Save file to disk with collision-safe filename.
    Returns the web-accessible path for database storage (e.g. /static/uploads/file.jpg).
    """
    # Ensure the upload directory exists before writing
    os.makedirs(upload_folder, exist_ok=True)

    filename = generate_filename(user_id, file.filename)
    filepath = os.path.join(upload_folder, filename)
    file.save(filepath)

    # Build a clean web path rooted at /static/uploads/
    return '/static/uploads/' + filename