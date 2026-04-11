from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from util.utils import allowed_file, save_file

# Create a new Blueprint for SASO
saso_bp = Blueprint('saso_bp', __name__, url_prefix='/NovaSight/saso')

# --- SASO Routes ---

# Dashboard (SASO Home)
@saso_bp.route('/home')
def home_saso():
    # Check if user is logged in and has the 'SASO' role
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home')) # Redirect to the main login/home page if not authorized
    return render_template('saso/home/html/sasohome.html') # Assuming a template path for SASO home

# Profile Page (SASO)
@saso_bp.route('/profile')
def profile_saso():
    # Check if user is logged in and has the 'SASO' role
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'saso/profile/html/sasoprofile.html', # Assuming a template path for SASO profile
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# Help (SASO)
@saso_bp.route('/help')
def help_saso():
    # Check if user is logged in and has the 'SASO' role
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    return render_template('saso/help/html/sasohelp.html') # Assuming a template path for SASO help

# --- SASO Dashboards ---
# Main Dashboard (SASO)
@saso_bp.route('/maindashboard')
def maindash_saso():
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    return render_template('saso/dashboard/maindashboardsaso/html/maindashboardsaso.html', college_type='all')

# CAHS Dashboard (SASO)
@saso_bp.route('/cahsdashboard')
def cahsdash_saso():
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    return render_template('saso/dashboard/cahsdashboardsaso/html/cahsdashboardsaso.html', college_type='CAHS')

# CBA Dashboard (SASO)
@saso_bp.route('/cbadashboard')
def cbadash_saso():
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    return render_template('saso/dashboard/cbadashboardsaso/html/cbadashboardsaso.html', college_type='CBA')

# CCST Dashboard (SASO)
@saso_bp.route('/ccstdashboard')
def ccstdash_saso():
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    return render_template('saso/dashboard/ccstdashboardsaso/html/ccstdashboardsaso.html', college_type='CCST')

# CEA Dashboard (SASO)
@saso_bp.route('/ceadashboard')
def ceadash_saso():
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    return render_template('saso/dashboard/ceadashboardsaso/html/ceadashboardsaso.html', college_type='CEA')

# COAS Dashboard (SASO)
@saso_bp.route('/coasdashboard')
def coasdash_saso():
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    return render_template('saso/dashboard/coasdashboardsaso/html/coasdashboardsaso.html', college_type='COAS')

# CTEC Dashboard (SASO)
@saso_bp.route('/ctecdashboard')
def ctecdash_saso():
    if 'user_id' not in session or session.get('role') != 'SASO':
        return redirect(url_for('home'))
    return render_template('saso/dashboard/ctecdashboardsaso/html/ctecdashboardsaso.html', college_type='CTEC')


# --- Common Routes (Password Update, Image Upload) ---
# These functions are generally role-agnostic if they operate on the logged-in user's ID.
# However, you might want to add role checks if these actions are restricted.

# Update Password (SASO)
@saso_bp.route('/update_password', methods=['POST'])
def update_password_saso():
    # You might want to ensure the user is logged in, but the role check might be less strict here
    # if any logged-in user can change their own password.
    if 'user_id' not in session:
        return jsonify({"error": "Unauthorized"}), 401 # Use 401 for authentication errors

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

# Upload Profile Image (SASO)
@saso_bp.route('/upload_image', methods=['POST'])
def upload_image_saso():
    # Similar to update_password, ensure user is logged in.
    if 'user_id' not in session:
        return jsonify({"error": "Unauthorized"}), 401

    file = request.files.get('image')
    if not file or file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400

    user = AcadUser.query.get(session['user_id'])
    # Ensure the user exists before trying to save the file
    if not user:
        return jsonify({"error": "User not found"}), 404
        
    filepath = save_file(file, user.acaduser_id)
    user.profile_image_url = filepath
    db.session.commit()
    return jsonify({"image_url": filepath})