from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

# Create a new Blueprint for CTEC Dean
ctec_bp = Blueprint('ctec_bp', __name__, url_prefix='/NovaSight/ctec')


def _is_ctec():
    return 'user_id' in session and session.get('role') == 'CTECdean'


def _current_user():
    return AcadUser.query.get(session['user_id'])


# --- CTEC Dean Routes ---

# Landing: CTEC has no Home page any more. /NovaSight/ctec/ and the old
# /NovaSight/ctec/home (kept so old bookmarks and any template still calling
# url_for('ctec_bp.home_ctec') keep working) go straight to the CTEC Dashboard.
# The Home tutorial now lives in the shared popup (_ctec_tutorial.html),
# opened by the Tutorial button on every page.
@ctec_bp.route('/')
@ctec_bp.route('/home')
def home_ctec():
    if not _is_ctec():
        return redirect(url_for('home'))
    return redirect(url_for('ctec_bp.ctecdash_ctec'))


# CTEC Dashboard  <-- first page a CTEC Dean sees after logging in
@ctec_bp.route('/ctecdashboard')
def ctecdash_ctec():
    if not _is_ctec():
        return redirect(url_for('home'))
    return render_template(
        'deans/CTECdean/dashboard/ctecdashboardctecdean.html',
        college_type='CTEC',
        user=_current_user()
    )


# Prediction Dashboard
@ctec_bp.route('/predictivedashboard')
def preddash_ctec():
    if not _is_ctec():
        return redirect(url_for('home'))
    return render_template(
        'deans/CTECdean/dashboard/predictiondashboardctec.html',
        college_type='all',
        user=_current_user()
    )


# Profile Page (CTEC Dean)
@ctec_bp.route('/profile')
def profile_ctec():
    if not _is_ctec():
        return redirect(url_for('home'))

    user = _current_user()
    return render_template(
        'deans/CTECdean/profile/html/ctecdeanprofile.html',
        user=user,
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )


# Help (CTEC Dean)
@ctec_bp.route('/help')
def help_ctec():
    if not _is_ctec():
        return redirect(url_for('home'))
    return render_template('deans/CTECdean/help/html/ctecdeanhelp.html', user=_current_user())


# Privacy Policy (CTEC Dean)
@ctec_bp.route('/privacy-policy')
def privacy_policy_CTECdean():
    if not _is_ctec():
        return redirect(url_for('home'))
    return render_template('deans/CTECdean/privacypolCTEC/privacypolicyCTEC.html', user=_current_user())


# --- Common Routes (Password Update, Image Upload) ---
# Role-agnostic: they operate on the logged-in user's ID.

# Update Password (CTEC Dean)
@ctec_bp.route('/update_password', methods=['POST'])
def update_password_ctec():
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


# Upload Profile Image (CTEC Dean)
@ctec_bp.route('/upload_image', methods=['POST'])
def upload_image_ctec():
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
