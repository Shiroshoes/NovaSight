from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

# Create a new Blueprint for CoAS Dean
coas_bp = Blueprint('coas_bp', __name__, url_prefix='/NovaSight/coas')


def _is_coas():
    return 'user_id' in session and session.get('role') == 'CoASdean'


def _current_user():
    return AcadUser.query.get(session['user_id'])


# --- CoAS Dean Routes ---

# Landing: CoAS has no Home page any more. /NovaSight/coas/ and the old
# /NovaSight/coas/home (kept so old bookmarks and any template still calling
# url_for('coas_bp.home_coas') keep working) go straight to the CoAS Dashboard.
# The Home tutorial now lives in the shared popup (_coas_tutorial.html),
# opened by the Tutorial button on every page.
@coas_bp.route('/')
@coas_bp.route('/home')
def home_coas():
    if not _is_coas():
        return redirect(url_for('home'))
    return redirect(url_for('coas_bp.coasdash_coas'))


# CoAS Dashboard  <-- first page a CoAS Dean sees after logging in
@coas_bp.route('/coasdashboard')
def coasdash_coas():
    if not _is_coas():
        return redirect(url_for('home'))
    return render_template(
        'deans/COASDean/dashboard/coasdashboardcoasdean.html',
        college_type='COAS',
        user=_current_user()
    )


# Prediction Dashboard
@coas_bp.route('/predictivedashboard')
def preddash_coas():
    if not _is_coas():
        return redirect(url_for('home'))
    return render_template(
        'deans/COASDean/dashboard/predictiondashboardcoas.html',
        college_type='all',
        user=_current_user()
    )


# Profile Page (CoAS Dean)
@coas_bp.route('/profile')
def profile_coas():
    if not _is_coas():
        return redirect(url_for('home'))

    user = _current_user()
    return render_template(
        'deans/COASDean/profile/html/coasdeanprofile.html',
        user=user,
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )


# Help (CoAS Dean)
@coas_bp.route('/help')
def help_coas():
    if not _is_coas():
        return redirect(url_for('home'))
    return render_template('deans/COASDean/help/html/coasdeanhelp.html', user=_current_user())


# Privacy Policy (CoAS Dean)
@coas_bp.route('/privacy-policy')
def privacy_policy_CoASdean():
    if not _is_coas():
        return redirect(url_for('home'))
    return render_template('deans/COASDean/privacypolCoAS/privacypolicyCoAS.html', user=_current_user())


# --- Common Routes (Password Update, Image Upload) ---
# Role-agnostic: they operate on the logged-in user's ID.

# Update Password (CoAS Dean)
@coas_bp.route('/update_password', methods=['POST'])
def update_password_coas():
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


# Upload Profile Image (CoAS Dean)
@coas_bp.route('/upload_image', methods=['POST'])
def upload_image_coas():
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
