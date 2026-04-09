from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from models import AcadUser, db
from utils import allowed_file, save_file

# Create a new Blueprint for CTEC Dean
ctec_bp = Blueprint('ctec_bp', __name__, url_prefix='/NovaSight/ctec')

# --- CTEC Dean Routes ---

# Dashboard (CTEC Dean Home)
@ctec_bp.route('/home')
def home_ctec():

    if 'user_id' not in session or session.get('role') != 'CTECdean':
        return redirect(url_for('home')) 
    return render_template('deans/CTECdean/home/html/ctecdeanhome.html') 

# Profile Page (CTEC Dean)
@ctec_bp.route('/profile')
def profile_ctec():

    if 'user_id' not in session or session.get('role') != 'CTECdean':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'deans/CTECdean/profile/html/ctecdeanprofile.html', 
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# Help (CTEC Dean)
@ctec_bp.route('/help')
def help_ctec():

    if 'user_id' not in session or session.get('role') != 'CTECdean':
        return redirect(url_for('home'))
    return render_template('deans/CTECdean/help/html/ctecdeanhelp.html') 

# --- CTEC Dean Specific Dashboards ---
# Main CTEC Dean Dashboard
@ctec_bp.route('/maindashboard')
def maindash_ctec():
    if 'user_id' not in session or session.get('role') != 'CTECdean':
        return redirect(url_for('home'))
    
    return render_template('deans/CTECdean/dashboard/maindashboardctecdean.html') 

# ctec dash
@ctec_bp.route('/ctecdashboard')
def ctecdash_ctec(): # Renamed function to avoid confusion
    if 'user_id' not in session or session.get('role') != 'CTECdean':
        return redirect(url_for('home'))
    
    return render_template('deans/CTECdean/dashboard/ctecdashboardctecdean.html') 


# --- Common Routes (Password Update, Image Upload) ---
# These functions are generally role-agnostic if they operate on the logged-in user's ID.

# Update Password (CTEC Dean)
@ctec_bp.route('/update_password', methods=['POST'])
def update_password_ctec():
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

# Upload Profile Image (CTEC Dean)
@ctec_bp.route('/upload_image', methods=['POST'])
def upload_image_ctec():
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