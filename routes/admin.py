from flask import Blueprint, render_template, request, session, redirect, flash, jsonify, url_for
from database.models import AcadUser, db, assign_avatar_color, ensure_avatar_color
from util.utils import allowed_file, save_file
from configs.config import (
    ALLOWED_ROLES, AVATAR_MAX_SIZE_MB, MIN_PASSWORD_LENGTH,
    UNPROCESSED_DATASETS_DIR,
)
from datetime import datetime
from sqlalchemy.exc import IntegrityError
from sqlalchemy import text
import os
import shutil

# ---------------- Blueprint Setup ----------------
admin_bp = Blueprint('admin_bp', __name__, url_prefix='/NovaSight/admin')

# ---------------- Homeadmin ----------------
@admin_bp.route('/')
def dashboard():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))

    users = AcadUser.query.filter_by(is_archived=False).all()
    return render_template('admin/homeadmin/html/homeadmin.html', users=users)

# ---------------- Admin Management Page (Adminpage) ----------------
@admin_bp.route('/adminpage')
def admin_page():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))

    active_users   = AcadUser.query.filter_by(is_archived=False).all()
    archived_users = AcadUser.query.filter_by(is_archived=True).all()
    for u in active_users + archived_users:
        ensure_avatar_color(u)
    return render_template(
        'admin/adminpage/html/adminpage.html',
        users=active_users,
        archived_users=archived_users
    )

# ---------------- Profile Page (Profileadmin) ----------------
@admin_bp.route('/profile')
def profile():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))

    user = AcadUser.query.get(session['user_id'])
    ensure_avatar_color(user)
    return render_template(
        'admin/Profileadmin/html/profileadmin.html',
        username=user.username,
        account=user.account,
        role=user.role,
        user_image_url=user.profile_image_url
    )

# ---------------- File Upload ----------------
@admin_bp.route('/fileupload')
def fileupload_admin():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('admin/fileupload/fileupload.html')


# ------------ Help admin ------------
@admin_bp.route('/help')
def help_admin():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('admin/helpadmin/html/helpadmin.html')

# --------- Dashboards --------
@admin_bp.route('/maindashboard')
def maindash_admin():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('admin/dashboard/maindashboardadmin/html/maindashboardadmin.html', college_type='all')


@admin_bp.route('/preddash')
def preddash_admin():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('admin/dashboard/predictiondashboardAdmin/predictiondashboardAdmin.html', college_type='all')

# ----------------- Privacy Policy Page ----------------
@admin_bp.route('/privacypolicyAdmin')
def privacy_policy_admin():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return redirect(url_for('home'))
    return render_template('admin/privacypoladmin/privacypolicyAdmin.html')


# ---------------- Add User ----------------
@admin_bp.route('/add_user', methods=['POST'])
def add_user():
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        flash("Unauthorized", "error")
        return redirect(url_for('admin_bp.admin_page'))

    first_name  = request.form.get('first_name', '').strip()
    last_name   = request.form.get('last_name', '').strip()
    mi          = request.form.get('mi', '').strip() or None
    suffix      = request.form.get('suffix', '').strip() or None
    account     = request.form.get('account', '').strip().lower()
    password    = request.form.get('password', '').strip()
    role        = request.form.get('role', '').strip()

    if not all([first_name, last_name, account, password, role]):
        flash("First name, last name, account, password, and role are required.", "error")
        return redirect(url_for('admin_bp.admin_page'))

    # BPSU account validation
    if not account.endswith('@bpsu.edu.ph'):
        flash("Please use a valid BPSU account ending with @bpsu.edu.ph.", "error")
        return redirect(url_for('admin_bp.admin_page'))

    if role not in ALLOWED_ROLES:
        flash("Invalid role", "error")
        return redirect(url_for('admin_bp.admin_page'))

    if len(password) < MIN_PASSWORD_LENGTH:
        flash(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.", "error")
        return redirect(url_for('admin_bp.admin_page'))

    if AcadUser.query.filter(db.func.lower(AcadUser.account) == account).first():
        flash("Account already exists", "error")
        return redirect(url_for('admin_bp.admin_page'))

    user = AcadUser(
        first_name=first_name,
        last_name=last_name,
        mi=mi,
        suffix=suffix,
        account=account,
        role=role
    )
    user.set_password(password)
    assign_avatar_color(user)
    db.session.add(user)
    try:
        db.session.commit()
    except IntegrityError:
        # Belt-and-suspenders: catches the rare case of two submissions
        # for the same account landing at almost the same instant, which
        # would otherwise slip past the query check above and hit the DB
        # constraint directly as an unhandled 500.
        db.session.rollback()
        flash("Account already exists", "error")
        return redirect(url_for('admin_bp.admin_page'))

    flash("User added successfully!", "success")
    return redirect(url_for('admin_bp.admin_page'))

# ---------------- Update User ----------------
@admin_bp.route('/update_user/<int:user_id>', methods=['POST'])
def update_user(user_id):
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return "Unauthorized", 403

    user = AcadUser.query.get(user_id)
    if not user:
        return "User not found", 404

    first_name  = request.form.get('first_name', '').strip()
    last_name   = request.form.get('last_name', '').strip()
    mi          = request.form.get('mi', '').strip() or None
    suffix      = request.form.get('suffix', '').strip() or None
    password    = request.form.get('password', '').strip()
    role        = request.form.get('role', '').strip()

    if not first_name or not last_name or not role:
        return "First name, last name, and role are required.", 400
    if role not in ALLOWED_ROLES:
        return "Invalid role", 400

    user.first_name = first_name
    user.last_name  = last_name
    user.mi         = mi
    user.suffix     = suffix
    if password:
        if len(password) < MIN_PASSWORD_LENGTH:
            flash(f"Password must be at least {MIN_PASSWORD_LENGTH} characters.", "error")
            return redirect(url_for('admin_bp.admin_page'))
        if user.check_password(password):
            flash("New password must be different from the user's current password.", "error")
            return redirect(url_for('admin_bp.admin_page'))
        user.set_password(password)
    if role != user.role:
        user.role = role
        assign_avatar_color(user)  # new department → new color family
    else:
        user.role = role

    db.session.commit()
    flash("User updated successfully!", "success")
    return redirect(url_for('admin_bp.admin_page'))

# ---------------- Archive (Deactivate) User ----------------
@admin_bp.route('/archive_user/<int:user_id>', methods=['POST'])
def archive_user(user_id):
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return "Unauthorized", 403

    user = AcadUser.query.get(user_id)
    if not user:
        return "User not found", 404

    if user.acaduser_id == session['user_id']:
        return "Cannot deactivate yourself", 403

    user.is_archived   = True
    user.date_archived = datetime.utcnow()
    db.session.commit()
    flash("User deactivated successfully!", "success")
    return redirect(url_for('admin_bp.admin_page'))

# ---------------- Restore (Activate) User ----------------
@admin_bp.route('/restore_user/<int:user_id>', methods=['POST'])
def restore_user(user_id):
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return "Unauthorized", 403

    user = AcadUser.query.get(user_id)
    if not user:
        return "User not found", 404

    user.is_archived   = False
    user.date_archived = None
    db.session.commit()
    flash("User activated successfully!", "success")
    return redirect(url_for('admin_bp.admin_page'))

# ---------------- Delete User (permanent) ----------------
@admin_bp.route('/delete_user/<int:user_id>', methods=['POST'])
def delete_user(user_id):
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
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
    # JSON, not a redirect — this endpoint is only ever called via fetch(),
    # and a 302 body isn't something the client-side JSON parser can use.
    if 'user_id' not in session:
        return jsonify({"error": "Not logged in"}), 401

    file = request.files.get('image')
    if not file or file.filename == '':
        return jsonify({"error": "No file selected"}), 400
    if not allowed_file(file.filename):
        return jsonify({"error": "Only JPEG or PNG files are allowed."}), 400

    max_bytes = AVATAR_MAX_SIZE_MB * 1024 * 1024
    if request.content_length and request.content_length > max_bytes:
        return jsonify({"error": f"Image too large (max {AVATAR_MAX_SIZE_MB}MB)."}), 413

    user = AcadUser.query.get(session['user_id'])
    if not user:
        return jsonify({"error": "User not found"}), 404

    try:
        # save_file re-decodes and re-encodes the image itself, so a renamed
        # non-image file (or a polyglot) fails here even though the filename
        # and Content-Type header both looked fine.
        filepath = save_file(file, user.acaduser_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        print("Avatar upload error:", e)
        return jsonify({"error": "Could not process that image. Try a different file."}), 500

    user.profile_image_url = filepath
    db.session.commit()
    return jsonify({"image_url": filepath, "avatar_color": user.avatar_color})

# ---------------- Get User (JSON) ----------------
@admin_bp.route('/get_user/<int:user_id>')
def get_user(user_id):
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return jsonify({"error": "Unauthorized"}), 403
    user = AcadUser.query.get(user_id)
    if not user:
        return jsonify({"error": "User not found"}), 404
    return jsonify({
        "acaduser_id": user.acaduser_id,
        "first_name":  user.first_name,
        "last_name":   user.last_name,
        "mi":          user.mi or "",
        "suffix":      user.suffix or "",
        "account":     user.account,
        "role":        user.role,
        "is_archived": user.is_archived,
        "date_created": user.date_created.strftime('%Y-%m-%d %H:%M') if user.date_created else "",
        "date_archived": user.date_archived.strftime('%Y-%m-%d %H:%M') if user.date_archived else ""
    })

# ---------------- Update Password ----------------
@admin_bp.route('/update_password', methods=['POST'])
def update_password():
    if 'user_id' not in session:
        return jsonify({"error": "Unauthorized"}), 403

    data     = request.get_json()
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


# ---------------- FULL RESET (database + all files) ----------------
# Every table this app writes to, in the order schema.sql creates them.
# There's no UI button for this on purpose — it's meant to be run from
# the browser console (F12) by an admin who's already logged in:
#
#   fetch('/NovaSight/admin/reset_database', {
#     method: 'POST',
#     headers: {'Content-Type': 'application/json'},
#     body: JSON.stringify({
#       password: 'your-own-admin-password',
#       confirm: 'RESET DATABASE'
#     })
#   }).then(r => r.json()).then(console.log)
#
# Keep this list in sync with schema.sql if a table is ever added/removed.
_ALL_DB_TABLES = [
    'acad_user', 'uploaded_dataset',
    'semester_uploads', 'longform_uploads',
    'dropout_spike_cohort', 'dropout_ranking_college',
    'gwa_ranking_college', 'kpi_gwa_student', 'gwa_trend_timeseries',
    'inc_forecast_cohort', 'irreg_reg_cohort', 'kpi_enrollment_college',
    'kpi_drop_college', 'subject_grade_forecast', 'performance_band_dist',
    'year_level_performance', 'year_level_inc_irreg',
    'course_year_level_dropout', 'gender_performance_male',
    'gender_performance_female', 'trained_models', 'training_summary',
    'app_storage',
]


def _clear_dir(path):
    """Deletes everything INSIDE `path` but keeps the folder itself.
    Only ever called on UNPROCESSED_DATASETS_DIR now — the other
    dataset/model/backup folders this used to also clear are gone
    (see configs/config.py)."""
    if not os.path.isdir(path):
        return
    for entry in os.listdir(path):
        full = os.path.join(path, entry)
        if os.path.isdir(full):
            shutil.rmtree(full, ignore_errors=True)
        else:
            try:
                os.remove(full)
            except OSError:
                pass


@admin_bp.route('/reset_database', methods=['POST'])
def reset_database():
    """
    IRREVERSIBLE full reset: truncates every table (users, uploads,
    grade data, every model_datasets table, trained_models), deletes
    every uploaded/processed/trained file on disk, then recreates the
    single default admin account — the exact same "brand new install"
    state app.py creates the very first time the app is ever run.

    Two separate confirmations are required because this route has no
    "are you sure?" browser dialog like a real button would — the
    caller's own password plus an exact-match confirm phrase are the
    only things stopping an accidental paste, a stale open tab, or
    someone finding this URL from wiping the database.
    """
    if 'user_id' not in session or session.get('role') != 'Academic_Affair':
        return jsonify({"error": "Unauthorized"}), 403

    data     = request.get_json(silent=True) or {}
    password = data.get('password', '')
    confirm  = data.get('confirm', '')

    user = AcadUser.query.get(session['user_id'])
    if not user or not user.check_password(password):
        return jsonify({"error": "Incorrect password"}), 403

    if confirm != 'RESET DATABASE':
        return jsonify({"error": 'Type confirm exactly as: "RESET DATABASE"'}), 400

    try:
        # ---- 1. Wipe every table ----
        with db.engine.begin() as conn:
            conn.execute(text('SET FOREIGN_KEY_CHECKS=0'))
            for table in _ALL_DB_TABLES:
                # Several of these (semester_uploads, longform_uploads,
                # training_summary, app_storage, and each model_datasets
                # table) are only CREATEd lazily on first write (see
                # db_io.py) — on a fresh install, or before anything's
                # been uploaded/trained yet, they simply don't exist.
                # TRUNCATE on a missing table raises and used to abort
                # the WHOLE reset (including tables listed after it) —
                # skip anything not there instead of crashing on it.
                exists = conn.execute(text(
                    "SELECT 1 FROM information_schema.tables "
                    "WHERE table_schema = DATABASE() AND table_name = :t"
                ), {"t": table}).fetchone()
                if exists:
                    conn.execute(text(f'TRUNCATE TABLE {table}'))
            conn.execute(text('SET FOREIGN_KEY_CHECKS=1'))

        # ---- 2. Wipe every file the app still actually generates ----
        # (Processed_Datasets/by_year/, model_datasets/, Machine_Learning_
        # Model/, and Backup/ are gone — that data lives in MySQL now, and
        # was already cleared in step 1. Only the raw .xlsx upload staging
        # folder is still real disk state.)
        _clear_dir(UNPROCESSED_DATASETS_DIR)

        # ---- 3. Recreate the default admin (mirrors app.py's first-run logic) ----
        admin_user = AcadUser(
            first_name='Admin',
            last_name='User',
            account='admin@bpsu.edu.ph',
            role='Academic_Affair'
        )
        admin_user.set_password('Admin123!')
        assign_avatar_color(admin_user)
        db.session.add(admin_user)
        db.session.commit()

    except Exception as e:
        db.session.rollback()
        print("Database reset error:", e)
        return jsonify({"error": f"Reset failed: {e}"}), 500

    # The account that made this request no longer exists (acad_user was
    # just truncated), so clear the session instead of leaving a session
    # cookie pointing at a acaduser_id that's gone.
    session.clear()
    return jsonify({
        "success": True,
        "message": "Database and all files reset. Log back in as admin@bpsu.edu.ph / Admin123!"
    })