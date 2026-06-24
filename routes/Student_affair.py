from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from util.utils import allowed_file, save_file

studentaffair_bp = Blueprint('studentaffair_bp', __name__, url_prefix='/NovaSight/studentaffair')

# Dashboard
@studentaffair_bp.route('/home')
def home_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/home/html/sahome.html')

# Profile Page
@studentaffair_bp.route('/profile')
def profile_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'studentaffair/profile/html/saprofile.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# help
@studentaffair_bp.route('/help')
def help_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/help/html/sahelp.html')


# dashbooaddd 
#main dash
@studentaffair_bp.route('/maindashboard')
def maindash_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/dashboard/maindashboardstudentaffair/html/maindashboardstudentaffair.html', college_type='all')

# cahs dash
@studentaffair_bp.route('/cahsdashboard')
def cahsdash_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/dashboard/cahsdashboardstudentaffair/html/cahsdashboardstudentaffair.html', college_type='CAHS')

# cba dash
@studentaffair_bp.route('/cbadashboard')
def cbadash_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/dashboard/cbadashboardstudentaffair/html/cbadashboardstudentaffair.html', college_type='CBA')

# ccst dash
@studentaffair_bp.route('/ccstdashboard')
def ccstdash_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/dashboard/ccstdashboardstudentaffair/html/ccstdashboardstudentaffair.html', college_type='CCST')

#cea dash
@studentaffair_bp.route('/ceadashboard')
def ceadash_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/dashboard/ceadashboardstudentaffair/html/ceadashboardstudentaffair.html', college_type='CEA')

#coas dash
@studentaffair_bp.route('/coasdashboard')
def coasdash_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/dashboard/coasdashboardstudentaffair/html/coasdashboardstudentaffair.html', college_type='COAS')

#ctec dash
@studentaffair_bp.route('/ctecdashboard')
def ctecdash_studentaffair():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
        return redirect(url_for('home'))
    return render_template('studentaffair/dashboard/ctecdashboardstudentaffair/html/ctecdashboardstudentaffair.html', college_type='CTEC')


# Update Password
@studentaffair_bp.route('/update_password', methods=['POST'])
def update_password():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
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
@studentaffair_bp.route('/upload_image', methods=['POST'])
def upload_image():
    if 'user_id' not in session or session.get('role') != 'Student_Affair':
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