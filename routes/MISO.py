from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

MISO_bp = Blueprint('MISO_bp', __name__, url_prefix='/NovaSight/MISO')

# Dashboard
@MISO_bp.route('/home')
def home_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    return render_template('MISO/home/html/sahome.html')

# Profile Page
@MISO_bp.route('/profile')
def profile_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'MISO/profile/html/saprofile.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

#file upload
@MISO_bp.route('/fileupload')
def fileupload_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    return render_template('MISO/fileupload/fileupload.html')

# help
@MISO_bp.route('/help')
def help_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    return render_template('MISO/help/html/sahelp.html')


# privacy policy
@MISO_bp.route('/privacy-policyAA')
def privacy_policy_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    return render_template('MISO/privacypolaa/privacypolicyAA.html')

# dashbooaddd 
#main dash
@MISO_bp.route('/maindashboard')
def maindash_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    return render_template('MISO/dashboard/maindashboardMISO/html/maindashboardMISO.html', college_type='all')

# dept dash
@MISO_bp.route('/deptdashboard')
def deptdash_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    return render_template('MISO/dashboard/deptdashAA/deptdashAA.html', college_type='CAHS')

# pred dash
@MISO_bp.route('/predictivedashboard')
def preddash_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    return render_template('MISO/dashboard/predictiondashboardAA/predictiondashboardAA.html', college_type='all')

# modal dash
@MISO_bp.route('/modaldashboard')
def modeldash_MISO():
    if 'user_id' not in session or session.get('role') != 'MISO':
        return redirect(url_for('home'))
    return render_template('MISO/dashboard/modelperformancedashAA/modelperformancedashAA.html', college_type='all')


# Update Password
@MISO_bp.route('/update_password', methods=['POST'])
def update_password():
    if 'user_id' not in session or session.get('role') != 'MISO':
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
@MISO_bp.route('/upload_image', methods=['POST'])
def upload_image():
    if 'user_id' not in session or session.get('role') != 'MISO':
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