from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from models import AcadUser, db
from utils import allowed_file, save_file

# Create a new Blueprint for COAS Dean
coas_bp = Blueprint('coas_bp', __name__, url_prefix='/NovaSight/coas')

# --- COAS Dean Routes ---

# Dashboard (COAS Dean Home)
@coas_bp.route('/home')
def home_coas():

    if 'user_id' not in session or session.get('role') != 'CoASdean':
        return redirect(url_for('home')) 
    return render_template('deans/COASDean/home/html/coasdeanhome.html')

# Profile Page (COAS Dean)
@coas_bp.route('/profile')
def profile_coas():

    if 'user_id' not in session or session.get('role') != 'CoASdean':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'deans/COASDean/profile/html/coasdeanprofile.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# Help (COAS Dean)
@coas_bp.route('/help')
def help_coas():

    if 'user_id' not in session or session.get('role') != 'CoASdean':
        return redirect(url_for('home'))
    return render_template('deans/COASDean/help/html/coasdeanhelp.html')

# --- COAS Dean Specific Dashboards ---
# Main COAS Dean Dashboard
@coas_bp.route('/maindashboard')
def maindash_coas():
    if 'user_id' not in session or session.get('role') != 'CoASdean':
        return redirect(url_for('home'))

    return render_template('deans/COASDean/dashboard/maindashboardcoasdean.html') 

# coas dash (if there's a specific dashboard for COAS itself, distinct from the Dean's)
@coas_bp.route('/coasdashboard')
def coasdash_coas():
    if 'user_id' not in session or session.get('role') != 'CoASdean':
        return redirect(url_for('home'))

    return render_template('deans/COASDean/dashboard/coasdashboardcoasdean.html') 


# --- Common Routes (Password Update, Image Upload) ---
# These functions are generally role-agnostic if they operate on the logged-in user's ID.

# Update Password (COAS Dean)
@coas_bp.route('/update_password', methods=['POST'])
def update_password_coas():
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

# Upload Profile Image (COAS Dean)
@coas_bp.route('/upload_image', methods=['POST'])
def upload_image_coas():
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