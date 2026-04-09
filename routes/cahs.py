from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from models import AcadUser, db
from utils import allowed_file, save_file

# Create a new Blueprint for CAHS
cahs_bp = Blueprint('cahs_bp', __name__, url_prefix='/NovaSight/cahs')

# --- CAHS Routes ---

# Dashboard (CAHS Home)
@cahs_bp.route('/home')
def home_cahs():
    # Check if user is logged in and has the 'CAHS' role
    if 'user_id' not in session or session.get('role') != 'CAHSdean':
        return redirect(url_for('home')) 
    return render_template('deans/CAHSdean/home/html/HomeCahsdean.html') 

# Profile Page (CAHS)
@cahs_bp.route('/profile')
def profile_cahs():
    # Check if user is logged in and has the 'CAHS' role
    if 'user_id' not in session or session.get('role') != 'CAHSdean':
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'deans/CAHSdean/profile/html/profilecahsdean.html', 
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# Help (CAHS)
@cahs_bp.route('/help')
def help_cahs():
    # Check if user is logged in and has the 'CAHS' role
    if 'user_id' not in session or session.get('role') != 'CAHSdean':
        return redirect(url_for('home'))
    return render_template('deans/CAHSdean/help/html/helpcahsdean.html') 

# --- CAHS Specific Dashboards ---
# Main CAHS Dashboard
@cahs_bp.route('/maindashboard')
def maindash_cahs():
    if 'user_id' not in session or session.get('role') != 'CAHSdean':
        return redirect(url_for('home'))
    return render_template('deans/CAHSdean/dashboard/maindashboardcahsdean.html') 

# cahs dash
@cahs_bp.route('/cahsdashboard')
def cahsdash_cahs():
    if 'user_id' not in session or session.get('role') != 'CAHSdean':
        return redirect(url_for('home'))
    return render_template('deans/CAHSdean/dashboard/cahsdashboardcahsdean.html') 

# --- Common Routes (Password Update, Image Upload) ---
# These functions are generally role-agnostic if they operate on the logged-in user's ID.

# Update Password (CAHS)
@cahs_bp.route('/update_password', methods=['POST'])
def update_password_cahs():
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

# Upload Profile Image (CAHS)
@cahs_bp.route('/upload_image', methods=['POST'])
def upload_image_cahs():
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