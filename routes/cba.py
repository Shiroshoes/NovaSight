from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

# Create a new Blueprint for CBA Dean
cba_bp = Blueprint('cba_bp', __name__, url_prefix='/NovaSight/cba')


def _is_cba():
    return 'user_id' in session and session.get('role') == 'CBAdean'


def _current_user():
    return AcadUser.query.get(session['user_id'])


# --- CBA Dean Routes ---

# Landing: CBA has no Home page any more. /NovaSight/cba/ and the old
# /NovaSight/cba/home (kept so old bookmarks and any template still calling
# url_for('cba_bp.home_cba') keep working) go straight to the CBA Dashboard.
# The Home tutorial now lives in the shared popup (_cba_tutorial.html),
# opened by the Tutorial button on every page.
@cba_bp.route('/')
@cba_bp.route('/home')
def home_cba():
    if not _is_cba():
        return redirect(url_for('home'))
    return redirect(url_for('cba_bp.cbadash_cba'))


# CBA Dashboard  <-- first page a CBA Dean sees after logging in
@cba_bp.route('/cbadashboard')
def cbadash_cba():
    if not _is_cba():
        return redirect(url_for('home'))
    return render_template(
        'deans/CBADean/dashboard/cbadashboardcbadean.html',
        college_type='CBA',
        user=_current_user()
    )


# Prediction Dashboard
@cba_bp.route('/predictivedashboard')
def preddash_cba():
    if not _is_cba():
        return redirect(url_for('home'))
    return render_template(
        'deans/CBADean/dashboard/predictiondashboardcba.html',
        college_type='all',
        user=_current_user()
    )


# Profile Page (CBA Dean)
@cba_bp.route('/profile')
def profile_cba():
    if not _is_cba():
        return redirect(url_for('home'))

    user = _current_user()
    return render_template(
        'deans/CBADean/profile/html/cbadeanprofile.html',
        user=user,
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )


# Help (CBA Dean)
@cba_bp.route('/help')
def help_cba():
    if not _is_cba():
        return redirect(url_for('home'))
    return render_template('deans/CBADean/help/html/cbadeanhelp.html', user=_current_user())


# Privacy Policy (CBA Dean)
@cba_bp.route('/privacy-policy')
def privacy_policy_CBADean():
    if not _is_cba():
        return redirect(url_for('home'))
    return render_template('deans/CBADean/privacypolCBA/privacypolicyCBA.html', user=_current_user())


# --- Common Routes (Password Update, Image Upload) ---
# Role-agnostic: they operate on the logged-in user's ID.

# Update Password (CBA Dean)
@cba_bp.route('/update_password', methods=['POST'])
def update_password_cba():
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


# Upload Profile Image (CBA Dean)
@cba_bp.route('/upload_image', methods=['POST'])
def upload_image_cba():
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