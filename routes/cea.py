from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from util.utils import allowed_file, save_file

# Create a new Blueprint for CEA Dean
cea_bp = Blueprint('cea_bp', __name__, url_prefix='/NovaSight/cea') 

# --- CEA Dean Routes ---

# Dashboard (CEA Dean Home)
@cea_bp.route('/home')
def home_cea():

    if 'user_id' not in session or session.get('role') != 'CEAdean':
        return redirect(url_for('home')) 
    return render_template('deans/CEADean/home/html/ceadeanhome.html')

# Profile Page (CEA Dean)
@cea_bp.route('/profile')
def profile_cea():

    if 'user_id' not in session or session.get('role') != 'CEAdean':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'deans/CEADean/profile/html/ceadeanprofile.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# Help (CEA Dean)
@cea_bp.route('/help')
def help_cea():

    if 'user_id' not in session or session.get('role') != 'CEAdean': 
        return redirect(url_for('home'))
    return render_template('deans/CEADean/help/html/ceadeanhelp.html')

# --- CEA Dean Specific Dashboards ---
# Main CEA Dean Dashboard
@cea_bp.route('/maindashboard')
def maindash_cea():
    if 'user_id' not in session or session.get('role') != 'CEAdean':
        return redirect(url_for('home'))

    return render_template('deans/CEADean/dashboard/maindashboardceadean.html', college_type='all') 

# cea dash
@cea_bp.route('/ceadashboard')
def ceadash_cea(): # Renamed function to avoid confusion
    if 'user_id' not in session or session.get('role') != 'CEAdean':
        return redirect(url_for('home'))

    return render_template('deans/CEADean/dashboard/ceadashboardceadean.html', college_type='CEA') 


# --- Common Routes (Password Update, Image Upload) ---
# These functions are generally role-agnostic if they operate on the logged-in user's ID.

# Update Password (CEA Dean)
@cea_bp.route('/update_password', methods=['POST'])
def update_password_cea():
    # Ensure user is logged in
    if 'user_id' not in session:
        return jsonify({"error": "Unauthorized"}), 401 

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

    user = AcadUser.query.get(session['user_id'])
    if not user:
        return jsonify({"error": "User not found"}), 404
        
    filepath = save_file(file, user.acaduser_id)
    user.profile_image_url = filepath
    db.session.commit()
    return jsonify({"image_url": filepath})