from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

registrar_bp = Blueprint('registrar_bp', __name__, url_prefix='/NovaSight/registrar')

# Dashboard
@registrar_bp.route('/home')
def home_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/home/html/registrarhome.html')

# Profile Page
@registrar_bp.route('/profile')
def profile_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'registrar/profile/html/registrarprofile.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# help
@registrar_bp.route('/help')
def help_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/help/html/registrarhelp.html')

# privacy
@registrar_bp.route('/privacy-policy')
def privacy_pol_regis():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/privacypolregis/privacypolicyRegis.html')

# dashbooaddd 
#main dash
@registrar_bp.route('/maindashboard')
def maindash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/maindashboardregistrar/html/maindashboardregistrar.html', college_type='all')

# dept dash
@registrar_bp.route('/deptdashboard')
def deptdash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/deptdashregistrar/deptdashregistrar.html', college_type='CAHS')

# prwd dash
@registrar_bp.route('/predictivedashboard')
def preddash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/predictiondashboardregistrar/predictiondashboardregistrar.html', college_type='all')

# model dash
@registrar_bp.route('/modeldashboard')
def modeldash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/modelperformancedashregistrar/modelperformancedashregistrar.html', college_type='all')


# Update Password
@registrar_bp.route('/update_password', methods=['POST'])
def update_password():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json()
    password = data.get('password')

    if not password or len(password) < MIN_PASSWORD_LENGTH:
        return jsonify({"error": f"Password is required and must be at least {MIN_PASSWORD_LENGTH} characters."}), 400

    user = AcadUser.query.get(session['user_id'])
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
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return jsonify({"error": "Unauthorized"}), 403

    file = request.files.get('image')
    if not file or file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400

    user = AcadUser.query.get(session['user_id'])
    filepath = save_file(file, user.acaduser_id)
    user.profile_image_url = filepath
    db.session.commit()
    return jsonify({"image_url": filepath})