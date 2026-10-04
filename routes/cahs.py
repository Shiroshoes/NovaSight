from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from util.utils import allowed_file, save_file
from configs.config import CAHS_ROLES, ROLE_DISPLAY_NAMES, MIN_PASSWORD_LENGTH

# Create a new Blueprint for CAHS
cahs_bp = Blueprint('cahs_bp', __name__, url_prefix='/NovaSight/cahs')


def _is_cahs():
    return 'user_id' in session and session.get('role') in CAHS_ROLES


def _current_user():
    return AcadUser.query.get(session['user_id'])


# --- CAHS Routes ---

# Landing: CAHS has no Home page any more. /NovaSight/cahs/ and the old
# /NovaSight/cahs/home (kept only so old bookmarks and any template still
# calling url_for('cahs_bp.home_cahs') keep working) go straight to the
# CAHS Dashboard. The Home tutorial now lives in the shared tutorial popup
# (_cahs_tutorial.html), opened by the Tutorial button on every page.
@cahs_bp.route('/')
@cahs_bp.route('/home')
def home_cahs():
    if not _is_cahs():
        return redirect(url_for('home'))
    return redirect(url_for('cahs_bp.cahsdash_cahs'))


# CAHS Dashboard  <-- first page a CAHS user sees after logging in
@cahs_bp.route('/cahsdashboard')
def cahsdash_cahs():
    if not _is_cahs():
        return redirect(url_for('home'))
    return render_template(
        'deans/CAHSdean/dashboard/cahsdashboardcahsdean.html',
        college_type='CAHS',
        user=_current_user()
    )


# Prediction Dashboard
@cahs_bp.route('/predictivedashboard')
def preddash_cahs():
    if not _is_cahs():
        return redirect(url_for('home'))
    return render_template(
        'deans/CAHSdean/dashboard/predictiondashboardcahs.html',
        college_type='all',
        user=_current_user()
    )


# Profile Page (CAHS)
@cahs_bp.route('/profile')
def profile_cahs():
    if not _is_cahs():
        return redirect(url_for('home'))

    user = _current_user()
    return render_template(
        'deans/CAHSdean/profile/html/profilecahsdean.html',
        user=user,
        username=user.username,
        account=user.account,
        role=ROLE_DISPLAY_NAMES.get(user.role, user.role),
        user_image_url=user.profile_image_url
    )


# Help (CAHS)
@cahs_bp.route('/help')
def help_cahs():
    if not _is_cahs():
        return redirect(url_for('home'))
    return render_template('deans/CAHSdean/help/html/helpcahsdean.html', user=_current_user())


# Privacy Policy (CAHS)
@cahs_bp.route('/privacy-policy')
def privacy_policy_CAHSdean():
    if not _is_cahs():
        return redirect(url_for('home'))
    return render_template('deans/CAHSdean/privacypolCAHS/privacypolicyCAHS.html', user=_current_user())


# --- Common Routes (Password Update, Image Upload) ---
# Role-agnostic: they operate on the logged-in user's ID.

# Update Password (CAHS)
@cahs_bp.route('/update_password', methods=['POST'])
def update_password_cahs():
    # Ensure user is logged in
    if 'user_id' not in session:
        return jsonify({"error": "Unauthorized"}), 401

    data = request.get_json()
    password = data.get('password')

    if not password or len(password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"Password is required and must be at least {MIN_PASSWORD_LENGTH} characters."}), 400

    user = _current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404

    if user.check_password(password):
        return jsonify({"error": "New password must be different from your current password."}), 400

    user.set_password(password)
    db.session.commit()

    return jsonify({"success": True})


# Upload Profile Image (CAHS)
@cahs_bp.route('/upload_image', methods=['POST'])
def upload_image_cahs():
    # Ensure user is logged in
    if 'user_id' not in session:
        return jsonify({"error": "Unauthorized"}), 401

    file = request.files.get('image')
    if not file or file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400

    user = _current_user()
    if not user:
        return jsonify({"error": "User not found"}), 404

    filepath = save_file(file, user.acaduser_id)
    user.profile_image_url = filepath
    db.session.commit()
    return jsonify({"image_url": filepath})