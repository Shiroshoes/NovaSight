from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from models import AcadUser, db
from utils import allowed_file, save_file

# Create a new Blueprint for CCST Dean
ccst_bp = Blueprint('ccst_bp', __name__, url_prefix='/NovaSight/ccst') 

# --- CCST Dean Routes ---

# Dashboard (CCST Dean Home)
@ccst_bp.route('/home')
def home_ccst():

    if 'user_id' not in session or session.get('role') != 'CCSTdean': 
        return redirect(url_for('home')) 
    return render_template('deans/CCSTDean/home/html/ccstdeanhome.html')

# Profile Page (CCST Dean)
@ccst_bp.route('/profile')
def profile_ccst():

    if 'user_id' not in session or session.get('role') != 'CCSTdean': 
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'deans/CCSTDean/profile/html/ccstdeanprofile.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# Help (CCST Dean)
@ccst_bp.route('/help')
def help_ccst():
 
    if 'user_id' not in session or session.get('role') != 'CCSTdean': 
        return redirect(url_for('home'))
    return render_template('deans/CCSTDean/help/html/ccstdeanhelp.html')

# --- CCST Dean Specific Dashboards ---
# Main CCST Dean Dashboard
@ccst_bp.route('/maindashboard')
def maindash_ccst():
    if 'user_id' not in session or session.get('role') != 'CCSTdean':
        return redirect(url_for('home'))

    return render_template('deans/CCSTDean/dashboard/maindashboardccstdean.html') 

# ccst dash (if there's a specific dashboard for CCST itself, distinct from the Dean's)
@ccst_bp.route('/ccstdashboard')
def ccstdash_ccst(): # Renamed function to avoid confusion
    if 'user_id' not in session or session.get('role') != 'CCSTdean': 
        return redirect(url_for('home'))

    return render_template('deans/CCSTDean/dashboard/ccstdashboardccstdean.html') 


# --- Common Routes (Password Update, Image Upload) ---
# These functions are generally role-agnostic if they operate on the logged-in user's ID.

# Update Password (CCST Dean)
@ccst_bp.route('/update_password', methods=['POST'])
def update_password_ccst():
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

    user = AcadUser.query.get(session['user_id'])
    if not user:
        return jsonify({"error": "User not found"}), 404
        
    filepath = save_file(file, user.acaduser_id)
    user.profile_image_url = filepath
    db.session.commit()
    return jsonify({"image_url": filepath})