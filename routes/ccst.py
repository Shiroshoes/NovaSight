from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

# Create a new Blueprint for CCST Dean
ccst_bp = Blueprint('ccst_bp', __name__, url_prefix='/NovaSight/ccst')


def _is_ccst():
    return 'user_id' in session and session.get('role') == 'CCSTdean'


def _current_user():
    return AcadUser.query.get(session['user_id'])


# --- CCST Dean Routes ---

# Landing: CCST has no Home page any more. /NovaSight/ccst/ and the old
# /NovaSight/ccst/home (kept so old bookmarks and any template still calling
# url_for('ccst_bp.home_ccst') keep working) go straight to the CCST Dashboard.
# The Home tutorial now lives in the shared popup (_ccst_tutorial.html),
# opened by the Tutorial button on every page.
@ccst_bp.route('/')
@ccst_bp.route('/home')
def home_ccst():
    if not _is_ccst():
        return redirect(url_for('home'))
    return redirect(url_for('ccst_bp.ccstdash_ccst'))


# CCST Dashboard  <-- first page a CCST Dean sees after logging in
@ccst_bp.route('/ccstdashboard')
def ccstdash_ccst():
    if not _is_ccst():
        return redirect(url_for('home'))
    return render_template(
        'deans/CCSTDean/dashboard/ccstdashboardccstdean.html',
        college_type='CCST',
        user=_current_user()
    )


# Prediction Dashboard
@ccst_bp.route('/predictivedashboard')
def preddash_ccst():
    if not _is_ccst():
        return redirect(url_for('home'))
    return render_template(
        'deans/CCSTDean/dashboard/predictiondashboardccst.html',
        college_type='all',
        user=_current_user()
    )


# Profile Page (CCST Dean)
@ccst_bp.route('/profile')
def profile_ccst():
    if not _is_ccst():
        return redirect(url_for('home'))

    user = _current_user()
    return render_template(
        'deans/CCSTDean/profile/html/ccstdeanprofile.html',
        user=user,
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )


# Help (CCST Dean)
@ccst_bp.route('/help')
def help_ccst():
    if not _is_ccst():
        return redirect(url_for('home'))
    return render_template('deans/CCSTDean/help/html/ccstdeanhelp.html', user=_current_user())


# Privacy Policy (CCST Dean)
@ccst_bp.route('/privacy-policy')
def privacy_policy_CCSTdean():
    if not _is_ccst():
        return redirect(url_for('home'))
    return render_template('deans/CCSTDean/privacypolCCST/privacypolicyCCST.html', user=_current_user())


# --- Common Routes (Password Update, Image Upload) ---
# Role-agnostic: they operate on the logged-in user's ID.

# Update Password (CCST Dean)
@ccst_bp.route('/update_password', methods=['POST'])
def update_password_ccst():
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


# Upload Profile Image (CCST Dean)
@ccst_bp.route('/upload_image', methods=['POST'])
def upload_image_ccst():
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
