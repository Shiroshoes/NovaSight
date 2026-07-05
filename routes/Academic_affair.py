from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from util.utils import allowed_file, save_file

academicaffair_bp = Blueprint('academicaffair_bp', __name__, url_prefix='/NovaSight/academicaffair')

# Dashboard
@academicaffair_bp.route('/home')
def home_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/home/html/sahome.html')

# Profile Page
@academicaffair_bp.route('/profile')
def profile_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'academicaffair/profile/html/saprofile.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

#file upload
@academicaffair_bp.route('/fileupload')
def fileupload_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/fileupload/fileupload.html')

# help
@academicaffair_bp.route('/help')
def help_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/help/html/sahelp.html')


# dashbooaddd 
#main dash
@academicaffair_bp.route('/maindashboard')
def maindash_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/dashboard/maindashboardacademicaffair/html/maindashboardacademicaffair.html', college_type='all')

# cahs dash
@academicaffair_bp.route('/cahsdashboard')
def cahsdash_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/dashboard/cahsdashboardacademicaffair/html/cahsdashboardacademicaffair.html', college_type='CAHS')

# cba dash
@academicaffair_bp.route('/cbadashboard')
def cbadash_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/dashboard/cbadashboardacademicaffair/html/cbadashboardacademicaffair.html', college_type='CBA')

# ccst dash
@academicaffair_bp.route('/ccstdashboard')
def ccstdash_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/dashboard/ccstdashboardacademicaffair/html/ccstdashboardacademicaffair.html', college_type='CCST')

#cea dash
@academicaffair_bp.route('/ceadashboard')
def ceadash_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/dashboard/ceadashboardacademicaffair/html/ceadashboardacademicaffair.html', college_type='CEA')

#coas dash
@academicaffair_bp.route('/coasdashboard')
def coasdash_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/dashboard/coasdashboardacademicaffair/html/coasdashboardacademicaffair.html', college_type='COAS')

#ctec dash
@academicaffair_bp.route('/ctecdashboard')
def ctecdash_academicaffair():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('academicaffair/dashboard/ctecdashboardacademicaffair/html/ctecdashboardacademicaffair.html', college_type='CTEC')


# Update Password
@academicaffair_bp.route('/update_password', methods=['POST'])
def update_password():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
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
@academicaffair_bp.route('/upload_image', methods=['POST'])
def upload_image():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
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