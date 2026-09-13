from flask import Blueprint, render_template, session, redirect, url_for, request, jsonify
from database.models import AcadUser, db
from configs.config import MIN_PASSWORD_LENGTH
from util.utils import allowed_file, save_file

# Create a new Blueprint for CBA Dean
cba_bp = Blueprint('cba_bp', __name__, url_prefix='/NovaSight/cba') 

# --- CBA Dean Routes ---

# Dashboard (CBA Dean Home)
@cba_bp.route('/home')
def home_cba():
    # Check if user is logged in and has the 'CBAdean' role
    if 'user_id' not in session or session.get('role') != 'CBAdean': 
        return redirect(url_for('home')) 
    return render_template('deans/CBADean/home/html/cbadeanhome.html') 

# prwd dash
@cba_bp.route('/predictivedashboard')
def preddash_cba():
    if 'user_id' not in session or session.get('role') != 'CBAdean':
        return redirect(url_for('home'))
    return render_template('deans/CBAdean/dashboard/predictiondashboardcba.html', college_type='all')

# model dash
@cba_bp.route('/modeldashboard')
def modeldash_cba():
    if 'user_id' not in session or session.get('role') != 'CBAdean':
        return redirect(url_for('home'))
    return render_template('deans/CBAdean/dashboard/modelperformancedashcba.html', college_type='all')

# Profile Page (CBA Dean)
@cba_bp.route('/profile')
def profile_cba():
    # Check if user is logged in and has the 'CBAdean' role
    if 'user_id' not in session or session.get('role') != 'CBAdean': 
        return redirect(url_for('home'))
    
    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'deans/CBADean/profile/html/cbadeanprofile.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# Help (CBA Dean)
@cba_bp.route('/help')
def help_cba():
    # Check if user is logged in and has the 'CBAdean' role
    if 'user_id' not in session or session.get('role') != 'CBAdean':
        return redirect(url_for('home'))
    return render_template('deans/CBADean/help/html/cbadeanhelp.html')

# privacy policy
@cba_bp.route('/privacy-policy')
def privacy_policy_CBADean():
    if 'user_id' not in session or session.get('role') != 'CBAdean':
        return redirect(url_for('home'))
    return render_template('deans/CBADean/privacypolCBA/privacypolicyCBA.html')

# --- CBA Dean Specific Dashboards ---

@cba_bp.route('/cbadashboard')
def cbadash_cba():
    if 'user_id' not in session or session.get('role') != 'CBAdean':
        return redirect(url_for('home'))

    return render_template('deans/CBADean/dashboard/cbadashboardcbadean.html', college_type='CBA')


# --- Common Routes (Password Update, Image Upload) ---
# These functions are generally role-agnostic if they operate on the logged-in user's ID.

# Update Password (CBA Dean)
@cba_bp.route('/update_password', methods=['POST'])
def update_password_cba():
    # Ensure user is logged in
    if 'user_id' not in session:
        return jsonify({"error": "Unauthorized"}), 401 

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

# Upload Profile Image (CBA Dean)
@cba_bp.route('/upload_image', methods=['POST'])
def upload_image_cba():
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