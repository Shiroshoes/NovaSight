from flask import Blueprint, render_template, request, session, redirect, flash, jsonify, url_for
from database.models import AcadUser, db
from util.utils import allowed_file, save_file
from configs.config import ALLOWED_ROLES

# ---------------- Blueprint Setup ----------------
admin_bp = Blueprint('admin_bp', __name__, url_prefix='/NovaSight/admin')

# ---------------- Homeadmin ----------------
@admin_bp.route('/')
def dashboard():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))  # redirect to public home

    users = AcadUser.query.all()
    return render_template('admin/homeadmin/html/homeadmin.html', users=users)

# ---------------- Admin Management Page (Adminpage) ----------------
@admin_bp.route('/adminpage')
def admin_page():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))

    all_users = AcadUser.query.all()
    return render_template('admin/adminpage/html/adminpage.html', users=all_users)

# ---------------- Profile Page (Profileadmin) ----------------
@admin_bp.route('/profile')
def profile():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))

    user = AcadUser.query.get(session['user_id'])
    return render_template(
        'admin/settings/html/profileadmin.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )


# ------------ Help admin ------------
@admin_bp.route('/help')
def help_admin():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))
    
    return render_template('admin/helpadmin/html/helpadmin.html')


# --------- dasshboard naaa --------
#main dashboard
@admin_bp.route('/maindashboard')
def maindash_admin():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))
    
    return render_template('admin/dashboard/maindashboardadmin/html/maindashboardadmin.html', college_type='all')

#cahs dashboard
@admin_bp.route('/cahsdashboard')
def cahsdash_admin():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))
    
    return render_template('admin/dashboard/cahsdashboardadmin/html/cahsdashboardadmin.html', college_type='CAHS')

#cba dashboard
@admin_bp.route('/cbadashboard')
def cbadash_admin():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))
    
    return render_template('admin/dashboard/cbadashboardadmin/html/cbadashboardadmin.html', college_type='CBA')


#ccst dash
@admin_bp.route('/ccstdashboard')
def ccstdash_admin():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))
    
    return render_template('admin/dashboard/ccstdashboardadmin/html/ccstdashboardadmin.html', college_type='CCST')


#cea dash

@admin_bp.route('/ceadashboard')
def ceadash_admin():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))
    
    return render_template('admin/dashboard/ceadashboardadmin/html/ceadashboardadmin.html', college_type='CEA')


#coas dash
@admin_bp.route('/coasdashboard')
def coasdash_admin():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))
    
    return render_template('admin/dashboard/coasdashboardadmin/html/coasdashboardadmin.html', college_type='COAS')


#ctec dash
@admin_bp.route('/ctecdashboard')
def ctecdash_admin():
    if 'user_id' not in session or session.get('role') != 'admin':
        return redirect(url_for('home'))
    
    return render_template('admin/dashboard/ctecdashboardadmin/html/ctecdashboardadmin.html', college_type='CTEC')


# ---------------- Add User ----------------
@admin_bp.route('/add_user', methods=['POST'])
def add_user():
    if 'user_id' not in session or session.get('role') != 'admin':
        flash("Unauthorized", "error")
        return redirect(url_for('admin_bp.admin_page'))

    username = request.form.get('username')
    account = request.form.get('account')
    password = request.form.get('password')
    role = request.form.get('role')

    if not all([username, account, password, role]):
        flash("All fields required", "error")
        return redirect(url_for('admin_bp.admin_page'))

    if role not in ALLOWED_ROLES:
        flash("Invalid role", "error")
        return redirect(url_for('admin_bp.admin_page'))

    if AcadUser.query.filter_by(username=username).first():
        flash("Username already exists", "error")
        return redirect(url_for('admin_bp.admin_page'))
    if AcadUser.query.filter_by(account=account).first():
        flash("Account already exists", "error")
        return redirect(url_for('admin_bp.admin_page'))

    user = AcadUser(username=username, account=account, role=role)
    user.set_password(password)
    db.session.add(user)
    db.session.commit()
    flash("User added successfully!", "success")
    return redirect(url_for('admin_bp.admin_page'))

# ---------------- Update User ----------------
@admin_bp.route('/update_user/<int:user_id>', methods=['POST'])
def update_user(user_id):
    if 'user_id' not in session or session.get('role') != 'admin':
        return "Unauthorized", 403

    user = AcadUser.query.get(user_id)
    if not user:
        return "User not found", 404

    username = request.form.get('username')
    password = request.form.get('password')
    role = request.form.get('role')

    if not username or not role:
        return "Username and role required", 400
    if role not in ALLOWED_ROLES:
        return "Invalid role", 400

    # Collision check
    existing_user = AcadUser.query.filter(AcadUser.username == username, AcadUser.acaduser_id != user_id).first()
    if existing_user:
        return "Username already exists", 400

    user.username = username
    if password:
        user.set_password(password)
    user.role = role

    db.session.commit()
    flash("User updated successfully!", "success")
    return redirect(url_for('admin_bp.admin_page'))

# ---------------- Delete User ----------------
@admin_bp.route('/delete_user/<int:user_id>', methods=['POST'])
def delete_user(user_id):
    if 'user_id' not in session or session.get('role') != 'admin':
        return "Unauthorized", 403

    user = AcadUser.query.get(user_id)
    if not user:
        return "User not found", 404

    if user.acaduser_id == session['user_id']:
        return "Cannot delete yourself", 403

    db.session.delete(user)
    db.session.commit()
    flash("User deleted successfully!", "success")
    return redirect(url_for('admin_bp.admin_page'))

# ---------------- Upload Profile Image ----------------
@admin_bp.route('/upload_image', methods=['POST'])
def upload_image():
    if 'user_id' not in session:
        return redirect(url_for('home'))

    file = request.files.get('image')
    if not file or file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "Invalid file type"}), 400

    user = AcadUser.query.get(session['user_id'])
    if not user:
        return jsonify({"error": "User not found"}), 404

    # Save file collision-safe
    filepath = save_file(file, user.acaduser_id)

    # Update user
    user.profile_image_url = filepath
    db.session.commit()

    return jsonify({"image_url": filepath})


# fetch
@admin_bp.route('/get_user/<int:user_id>')
def get_user(user_id):
    if 'user_id' not in session or session.get('role') != 'admin':
        return jsonify({"error": "Unauthorized"}), 403
    user = AcadUser.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({
        "acaduser_id": user.acaduser_id,
        "username": user.username,
        "account": user.account,
        "role": user.role
    })

# updating password
@admin_bp.route('/update_password', methods=['POST'])
def update_password():
    if 'user_id' not in session:
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