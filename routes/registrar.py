from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

registrar_bp = Blueprint('registrar_bp', __name__, url_prefix='/NovaSight/registrar')


def _is_registrar():
    return 'user_id' in session and session.get('role') == 'Registrar'


def _current_user():
    return AcadUser.query.get(session['user_id'])


# Landing: the Registrar has no Home page any more. /NovaSight/registrar/ and
# anything that used to point at "home" goes straight to the main Dashboard.
@registrar_bp.route('/')
def registrar_landing():
    if not _is_registrar():
        return redirect(url_for('home'))
    return redirect(url_for('registrar_bp.maindash_registrar'))


# Compatibility shim: the old Home page is gone, but the two dashboard templates
# still have the OLD sidebar with a Home link (url_for('registrar_bp.home_registrar')).
# This keeps those pages from raising BuildError and sends the click to the Dashboard.
# DELETE this once both dashboards use registrar/_registrar_sidebar.html.
@registrar_bp.route('/home')
def home_registrar():
    return redirect(url_for('registrar_bp.maindash_registrar'))


# Main Dashboard  <-- first page a Registrar sees after logging in
@registrar_bp.route('/maindashboard')
def maindash_registrar():
    if not _is_registrar():
        return redirect(url_for('home'))
    return render_template(
        'registrar/dashboard/maindashboardregistrar/html/maindashboardregistrar.html',
        college_type='all',
        user=_current_user()
    )


# Prediction Dashboard
@registrar_bp.route('/predictivedashboard')
def preddash_registrar():
    if not _is_registrar():
        return redirect(url_for('home'))
    return render_template(
        'registrar/dashboard/predictiondashboardregistrar/predictiondashboardregistrar.html',
        college_type='all',
        user=_current_user()
    )


# Profile Page
@registrar_bp.route('/profile')
def profile_registrar():
    if not _is_registrar():
        return redirect(url_for('home'))

    user = _current_user()
    return render_template(
        'registrar/profile/html/registrarprofile.html',
        user=user,
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )


# Help
@registrar_bp.route('/help')
def help_registrar():
    if not _is_registrar():
        return redirect(url_for('home'))
    return render_template('registrar/help/html/registrarhelp.html', user=_current_user())


# Privacy Policy
@registrar_bp.route('/privacy-policy')
def privacy_pol_regis():
    if not _is_registrar():
        return redirect(url_for('home'))
    return render_template('registrar/privacypolregis/privacypolicyRegis.html', user=_current_user())


# Update Password
@registrar_bp.route('/update_password', methods=['POST'])
def update_password():
    if not _is_registrar():
        return jsonify({"error": "Unauthorized"}), 403

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


# Upload Profile Image
@registrar_bp.route('/upload_image', methods=['POST'])
def upload_image():
    if not _is_registrar():
        return jsonify({"error": "Unauthorized"}), 403

    file = request.files.get('image')
    if not file or file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400

    user = _current_user()
    filepath = save_file(file, user.acaduser_id)
    user.profile_image_url = filepath
    db.session.commit()
    return jsonify({"image_url": filepath})