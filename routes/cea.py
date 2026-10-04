from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

# Create a new Blueprint for CEA Dean
cea_bp = Blueprint('cea_bp', __name__, url_prefix='/NovaSight/cea')


def _is_cea():
    return 'user_id' in session and session.get('role') == 'CEAdean'


def _current_user():
    return AcadUser.query.get(session['user_id'])


# --- CEA Dean Routes ---

# Landing: CEA has no Home page any more. /NovaSight/cea/ and the old
# /NovaSight/cea/home (kept so old bookmarks and any template still calling
# url_for('cea_bp.home_cea') keep working) go straight to the CEA Dashboard.
# The Home tutorial now lives in the shared popup (_cea_tutorial.html),
# opened by the Tutorial button on every page.
@cea_bp.route('/')
@cea_bp.route('/home')
def home_cea():
    if not _is_cea():
        return redirect(url_for('home'))
    return redirect(url_for('cea_bp.ceadash_cea'))


# CEA Dashboard  <-- first page a CEA Dean sees after logging in
@cea_bp.route('/ceadashboard')
def ceadash_cea():
    if not _is_cea():
        return redirect(url_for('home'))
    return render_template(
        'deans/CEADean/dashboard/ceadashboardceadean.html',
        college_type='CEA',
        user=_current_user()
    )


# Prediction Dashboard
@cea_bp.route('/predictivedashboard')
def preddash_cea():
    if not _is_cea():
        return redirect(url_for('home'))
    return render_template(
        'deans/CEADean/dashboard/predictiondashboardcea.html',
        college_type='all',
        user=_current_user()
    )


# Profile Page (CEA Dean)
@cea_bp.route('/profile')
def profile_cea():
    if not _is_cea():
        return redirect(url_for('home'))

    user = _current_user()
    return render_template(
        'deans/CEADean/profile/html/ceadeanprofile.html',
        user=user,
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )


# Help (CEA Dean)
@cea_bp.route('/help')
def help_cea():
    if not _is_cea():
        return redirect(url_for('home'))
    return render_template('deans/CEADean/help/html/ceadeanhelp.html', user=_current_user())


# Privacy Policy (CEA Dean)
@cea_bp.route('/privacy-policy')
def privacy_policy_CEAdean():
    if not _is_cea():
        return redirect(url_for('home'))
    return render_template('deans/CEADean/privacypolCEA/privacypolicyCEA.html', user=_current_user())


# --- Common Routes (Password Update, Image Upload) ---
# Role-agnostic: they operate on the logged-in user's ID.

# Update Password (CEA Dean)
@cea_bp.route('/update_password', methods=['POST'])
def update_password_cea():
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


# Upload Profile Image (CEA Dean)
@cea_bp.route('/upload_image', methods=['POST'])
def upload_image_cea():
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
