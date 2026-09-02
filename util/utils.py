import os
import time
from io import BytesIO

from PIL import Image, UnidentifiedImageError

from configs.config import (
    UPLOAD_FOLDER,
    ALLOWED_EXTENSIONS,
    ALLOWED_IMAGE_FORMATS,
    AVATAR_MAX_DIMENSION_PX,
)


def allowed_file(filename):
    """Cheap first-pass filter on the filename. Not a security boundary by
    itself — validate_and_reencode_image() below checks the actual bytes."""
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def validate_and_reencode_image(file_storage):
    """
    Confirms the uploaded file is a genuine JPEG or PNG (not just named like
    one) by having Pillow decode it, then re-encodes it fresh. This strips
    any non-image payload/metadata hidden in the original bytes and caps
    dimensions, so a renamed executable or a polyglot file can't get through.

    Returns (BytesIO, extension). Raises ValueError with a user-safe message
    on anything that isn't a clean JPEG/PNG.
    """
    file_storage.stream.seek(0)
    try:
        probe = Image.open(file_storage.stream)
        probe.verify()  # structural check only; the file object is unusable after this
    except (UnidentifiedImageError, OSError, ValueError):
        raise ValueError("File is not a valid image.")

    file_storage.stream.seek(0)
    img = Image.open(file_storage.stream)  # re-open: verify() leaves the old handle dead
    img.load()

    fmt = (img.format or '').upper()
    if fmt not in ALLOWED_IMAGE_FORMATS:
        raise ValueError("Only JPEG or PNG images are allowed.")

    # Normalize mode and cap dimensions
    if img.mode not in ('RGB', 'RGBA'):
        img = img.convert('RGBA' if 'A' in img.mode else 'RGB')
    img.thumbnail((AVATAR_MAX_DIMENSION_PX, AVATAR_MAX_DIMENSION_PX))

    buf = BytesIO()
    if fmt == 'JPEG':
        if img.mode == 'RGBA':
            img = img.convert('RGB')
        img.save(buf, format='JPEG', quality=88, optimize=True)
        ext = 'jpg'
    else:
        img.save(buf, format='PNG', optimize=True)
        ext = 'png'

    buf.seek(0)
    return buf, ext


def generate_filename(user_id, extension):
    """Collision-safe filename. We never touch the client-supplied filename —
    the extension comes from Pillow's own read of the re-encoded bytes."""
    return f"{user_id}_{int(time.time())}.{extension}"


def save_file(file, user_id, upload_folder=UPLOAD_FOLDER):
    """
    Validates the upload is a genuine JPEG/PNG, re-encodes it, and writes the
    clean bytes to disk with a collision-safe name.
    Returns the web-accessible path for database storage
    (e.g. /static/uploads/file.jpg).

    Raises ValueError (safe to show the user) if the file isn't a valid image.
    """
    os.makedirs(upload_folder, exist_ok=True)

    clean_buf, ext = validate_and_reencode_image(file)

    filename = generate_filename(user_id, ext)
    filepath = os.path.join(upload_folder, filename)
    with open(filepath, 'wb') as f:
        f.write(clean_buf.read())

    return '/static/uploads/' + filename