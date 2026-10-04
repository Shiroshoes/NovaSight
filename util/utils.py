import os
import time
import unicodedata
from io import BytesIO

from PIL import Image, UnidentifiedImageError

from configs.config import (
    UPLOAD_FOLDER,
    ALLOWED_EXTENSIONS,
    ALLOWED_IMAGE_FORMATS,
    AVATAR_MAX_DIMENSION_PX,
    AVATAR_MAX_PIXELS,
)

# Pillow's own default decompression-bomb threshold (~89M px warn, ~179M px
# hard error) is far more generous than anything an avatar needs. Tightening
# it here means a small-on-disk-but-massive-when-decoded image is rejected
# before it can blow up memory, regardless of the file size check elsewhere.
Image.MAX_IMAGE_PIXELS = AVATAR_MAX_PIXELS


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
    except Image.DecompressionBombError:
        raise ValueError("Image is too large to process.")
    except (UnidentifiedImageError, OSError, ValueError):
        raise ValueError("File is not a valid image.")

    file_storage.stream.seek(0)
    try:
        img = Image.open(file_storage.stream)  # re-open: verify() leaves the old handle dead
        img.load()  # this is where a decompression bomb actually decodes — now guarded
    except Image.DecompressionBombError:
        raise ValueError("Image is too large to process.")
    except (UnidentifiedImageError, OSError, ValueError):
        raise ValueError("File is not a valid image.")

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


# ───────────────────────────────────────────────────────────────
# Profile-name validation / sanitizing
# ───────────────────────────────────────────────────────────────
# Used by the shared POST /update-name route in app.py.
#
# SQL-injection defence is layered:
#   1. The route only writes through the SQLAlchemy ORM (attribute
#      assignment + commit), which sends every value as a bound
#      parameter — user text is never concatenated into SQL.
#   2. This function is a strict WHITELIST on top of that: anything that
#      isn't a plain letter / allowed punctuation is REJECTED (not
#      silently "cleaned"), so quotes, semicolons, comment markers,
#      angle brackets, control characters, etc. never reach the database.
#   3. Only the four known keys are ever read from the request, so extra
#      fields (role, account, acaduser_id ...) can't be mass-assigned.
# Limits sit at or below the acad_user column sizes (first/last 100,
# mi 5, suffix 10).

NAME_MAX_LEN   = 50
MI_MAX_LEN     = 5
SUFFIX_MAX_LEN = 10
_NAME_PUNCT    = set(" .'\u2019-")          # space . ' ’ -


def _tidy(value, label):
    """Type-check, normalise Unicode, collapse all whitespace. Returns '' for empty."""
    if value is None:
        return ''
    if not isinstance(value, str):                 # JSON could send a list / dict / number
        raise ValueError(f"{label} is invalid.")
    value = unicodedata.normalize('NFC', value)
    return ' '.join(value.split())                 # trims + collapses tabs/newlines/NBSP


def _is_name_char(ch):
    # letters (any language), combining accent marks, plus . ' ’ - and space
    return ch.isalpha() or unicodedata.category(ch).startswith('M') or ch in _NAME_PUNCT


def _clean_name(value, label, required):
    value = _tidy(value, label)
    if not value:
        if required:
            raise ValueError(f"{label} is required.")
        return None
    if len(value) > NAME_MAX_LEN:
        raise ValueError(f"{label} must be {NAME_MAX_LEN} characters or fewer.")
    if not value[0].isalpha():
        raise ValueError(f"{label} must start with a letter.")
    if not all(_is_name_char(c) for c in value):
        raise ValueError(f"{label} can only contain letters, spaces, periods, hyphens and apostrophes.")
    return value


def _clean_mi(value):
    value = _tidy(value, 'Middle initial').rstrip('.').strip()   # stored WITHOUT the dot; models.py adds it
    if not value:
        return None
    if len(value) > MI_MAX_LEN:
        raise ValueError(f"Middle initial must be {MI_MAX_LEN} letters or fewer.")
    if not all(c.isalpha() for c in value):
        raise ValueError("Middle initial can only contain letters.")
    return value.upper() if len(value) == 1 else value


def _clean_suffix(value):
    value = _tidy(value, 'Suffix')
    if not value:
        return None
    if len(value) > SUFFIX_MAX_LEN:
        raise ValueError(f"Suffix must be {SUFFIX_MAX_LEN} characters or fewer.")
    if not value[0].isalnum() or not all(c.isalnum() or c == '.' for c in value):
        raise ValueError("Suffix can only contain letters, numbers and periods (e.g. Jr., III).")
    return value


def clean_name_parts(data):
    """
    Validates and sanitizes the four editable name parts from a JSON body.
    Returns {'first_name', 'last_name', 'mi', 'suffix'} (mi / suffix may be None).
    Raises ValueError with a user-safe message on the first problem found.
    Ignores every other key in `data` on purpose.
    """
    if not isinstance(data, dict):
        raise ValueError("Invalid request.")
    return {
        'first_name': _clean_name(data.get('first_name'), 'First name', required=True),
        'last_name':  _clean_name(data.get('last_name'),  'Last name',  required=True),
        'mi':         _clean_mi(data.get('mi')),
        'suffix':     _clean_suffix(data.get('suffix')),
    }