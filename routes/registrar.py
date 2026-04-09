from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from models import AcadUser, db
from utils import allowed_file, save_file

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


# dashbooaddd 
#main dash
@registrar_bp.route('/maindashboard')
def maindash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/maindashboardregistrar/html/maindashboardregistrar.html')

# cahs dash
@registrar_bp.route('/cahsdashboard')
def cahsdash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/cahsdashboardregistrar/html/cahsdashboardregistrar.html')

# cba dash
@registrar_bp.route('/cbadashboard')
def cbadash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/cbadashboardregistrar/html/cbadashboardregistrar.html')

# ccst dash
@registrar_bp.route('/ccstdashboard')
def ccstdash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/ccstdashboardregistrar/html/ccstdashboardregistrar.html')

#cea dash
@registrar_bp.route('/ceadashboard')
def ceadash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/ceadashboardregistrar/html/ceadashboardregistrar.html')

#coas dash
@registrar_bp.route('/coasdashboard')
def coasdash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/coasdashboardregistrar/html/coasdashboardregistrar.html')

#ctec dash
@registrar_bp.route('/ctecdashboard')
def ctecdash_registrar():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return redirect(url_for('home'))
    return render_template('registrar/dashboard/ctecdashboardregistrar/html/ctecdashboardregistrar.html')


# Update Password
@registrar_bp.route('/update_password', methods=['POST'])
def update_password():
    if 'user_id' not in session or session.get('role') != 'Registrar':
        return jsonify({"error": "Unauthorized"}), 403

    data = request.get_json()
    password = data.get('password')

    if not password:
        return jsonify({"error": "Password required"}), 400

    user = AcadUser.query.get(session['user_id'])
    if not user:
        return jsonify({"error": "User not found"}), 404

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