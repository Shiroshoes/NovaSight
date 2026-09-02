from flask import Flask, render_template, redirect, session, request, flash, url_for
from configs.config import SECRET_KEY, SQLALCHEMY_DATABASE_URI, SQLALCHEMY_TRACK_MODIFICATIONS
from database.models import db, AcadUser, assign_avatar_color, ensure_avatar_color, resync_avatar_colors
from werkzeug.security import generate_password_hash
from flask import jsonify
from sqlalchemy import inspect, text
from routes.admin import admin_bp
from routes.registrar import registrar_bp
from routes.saso import saso_bp
from routes.Academic_affair import academicaffair_bp
from routes.cahs import cahs_bp
from routes.cba import cba_bp
from routes.ccst import ccst_bp
from routes.cea import cea_bp
from routes.coas import coas_bp
from routes.ctec import ctec_bp
from ml_route.ml_analysis import ml_bp
from ml_route.upload_rotues import upload_bp
import os


app = Flask(__name__)
app.secret_key = SECRET_KEY
app.config['SQLALCHEMY_DATABASE_URI'] = SQLALCHEMY_DATABASE_URI
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = SQLALCHEMY_TRACK_MODIFICATIONS

db.init_app(app)

# ---------------- Register Blueprints ----------------
app.register_blueprint(admin_bp)
app.register_blueprint(registrar_bp)
app.register_blueprint(saso_bp)
app.register_blueprint(academicaffair_bp)
app.register_blueprint(cahs_bp)
app.register_blueprint(cba_bp)
app.register_blueprint(ccst_bp)
app.register_blueprint(cea_bp)
app.register_blueprint(coas_bp)
app.register_blueprint(ctec_bp)
app.register_blueprint(ml_bp)
app.register_blueprint(upload_bp, url_prefix='')

# ---------------- Default Admin Creation ----------------
with app.app_context():
    db.create_all()

    # db.create_all() only creates missing TABLES, not missing COLUMNS on a
    # table that already exists. avatar_icon_color is new, so add it by
    # hand for any database created before this column existed — a no-op
    # once the column is present.
    inspector = inspect(db.engine)
    existing_cols = {c['name'] for c in inspector.get_columns('acad_user')}
    if 'avatar_icon_color' not in existing_cols:
        db.session.execute(text('ALTER TABLE acad_user ADD COLUMN avatar_icon_color VARCHAR(7)'))
        db.session.commit()
        print("Migrated: added acad_user.avatar_icon_color")

    if 'seen_tutorials' not in existing_cols:
        db.session.execute(text('ALTER TABLE acad_user ADD COLUMN seen_tutorials TEXT'))
        db.session.commit()
        print("Migrated: added acad_user.seen_tutorials")

    # Same story as the column above: models.py declares account as
    # unique=True, but db.create_all() never retrofits a constraint onto a
    # table that already exists. A plain UNIQUE index is also
    # case-sensitive, so 'Juan@bpsu.edu.ph' and 'juan@bpsu.edu.ph' would
    # still count as two different accounts — COLLATE NOCASE fixes both
    # problems in one index (ASCII case-insensitive comparison, enforced
    # by SQLite itself on every insert/update from here on).
    existing_indexes = {idx['name'] for idx in inspector.get_indexes('acad_user')}
    if 'ix_acad_user_account_ci' not in existing_indexes:
        try:
            db.session.execute(text(
                'CREATE UNIQUE INDEX ix_acad_user_account_ci '
                'ON acad_user (account COLLATE NOCASE)'
            ))
            db.session.commit()
            print("Migrated: added case-insensitive unique index on acad_user.account")
        except Exception as e:
            db.session.rollback()
            print(f"WARNING: could not add case-insensitive unique index on acad_user.account: {e}")
            dupes = db.session.execute(text(
                'SELECT LOWER(account) AS acct, COUNT(*) AS c '
                'FROM acad_user GROUP BY LOWER(account) HAVING c > 1'
            )).fetchall()
            if dupes:
                print("These accounts only differ by case and must be manually merged/renamed first:")
                for row in dupes:
                    print(f"  - {row.acct}  ({row.c} accounts)")

    if not AcadUser.query.filter_by(account='admin@gmail.com').first():
        admin_user = AcadUser(
            first_name='Admin',
            last_name='User',
            mi=None,
            account='admin@gmail.com',
            role='admin'
        )
        admin_user.set_password('Admin123!')
        assign_avatar_color(admin_user)
        db.session.add(admin_user)
        db.session.commit()
        print("Admin account created: admin@gmail.com / Admin123!")
    else:
        print("Admin account already exists")

    # Push the "real" department colors (from ROLE_COLOR_FAMILIES, which
    # mirrors chart-helpers.js's COLLEGE_COLORS) onto every existing user.
    # Cheap and idempotent — only writes when a stored color has drifted
    # from the current palette.
    if resync_avatar_colors():
        print("Resynced avatar colors to current ROLE_COLOR_FAMILIES palette")

# ---------------- Public Routes ----------------
@app.route('/')
def home():
    return render_template('home_nologin.html')

@app.route('/help')
def help():
    return render_template('helpnonlogin.html')

# ---------------- Login / Logout ----------------
@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        flash("You are already logged in.", "info")
        role = session.get('role')
        return _redirect_by_role(role)

    if request.method == 'POST':
        account  = request.form.get('account', '').strip()
        password = request.form.get('password')
        # Case-insensitive to match the ix_acad_user_account_ci index —
        # otherwise a user who registered as 'Juan@bpsu.edu.ph' but types
        # 'juan@bpsu.edu.ph' at login would get "Invalid credentials".
        user = AcadUser.query.filter(db.func.lower(AcadUser.account) == account.lower()).first()

        if user and user.check_password(password):
            if user.is_archived:
                flash("This account has been deactivated. Please contact the administrator.", "error")
                return render_template('login.html')

            session['user_id'] = user.acaduser_id
            session['role']    = user.role
            # Every role's landing page shows its own once-only tutorial
            # video instead (see each page's pageTutorialModal), so the
            # generic welcome flash is not needed.
            return _redirect_by_role(user.role)
        else:
            flash("Invalid credentials", "error")

    return render_template('login.html')


def _redirect_by_role(role):
    """Central role-to-URL mapper used in login and the already-logged-in guard."""
    routes = {
        'admin':          '/NovaSight/admin',
        'Registrar':      '/NovaSight/registrar/home',
        'SASO':           '/NovaSight/saso/home',
        'Academic_Affair': '/NovaSight/academicaffair/home',
        'CAHSdean':       '/NovaSight/cahs/home',
        'CBAdean':        '/NovaSight/cba/home',
        'CCSTdean':       '/NovaSight/ccst/home',
        'CEAdean':        '/NovaSight/cea/home',
        'CoASdean':       '/NovaSight/coas/home',
        'CTECdean':       '/NovaSight/ctec/home',
    }
    return redirect(routes.get(role, '/NovaSight'))


@app.route('/logout')
def logout():
    session.clear()
    return redirect('/')

# ---------------- Change Password (generic) ----------------
@app.route('/update-password', methods=['POST'])
def update_password():
    if 'user_id' not in session:
        return jsonify({"success": False, "message": "Not logged in"}), 401

    data         = request.get_json()
    new_password = data.get('password', '').strip()

    if not new_password:
        return jsonify({"success": False, "message": "Password cannot be empty"}), 400

    try:
        user = AcadUser.query.get(session['user_id'])
        if not user:
            return jsonify({"success": False, "message": "User not found"}), 404
        if user.check_password(new_password):
            return jsonify({"success": False, "message": "New password must be different from your current password."}), 400
        user.set_password(new_password)
        db.session.commit()
        return jsonify({"success": True, "message": "Password updated successfully"})
    except Exception as e:
        print("Error updating password:", e)
        return jsonify({"success": False, "message": "Error updating password"}), 500


# ---------------- Mark Tutorial Seen (shared across all roles) ----------------
@app.route('/mark_tutorial_seen', methods=['POST'])
def mark_tutorial_seen():
    if 'user_id' not in session:
        return jsonify({"success": False, "message": "Not logged in"}), 401

    data = request.get_json(silent=True) or {}
    key  = (data.get('key') or '').strip()
    if not key:
        return jsonify({"success": False, "message": "key required"}), 400

    user = AcadUser.query.get(session['user_id'])
    if not user:
        return jsonify({"success": False, "message": "User not found"}), 404

    user.mark_tutorial_seen(key)
    db.session.commit()
    return jsonify({"success": True})


# ---------------- Context Processor ----------------
@app.context_processor
def inject_user():
    """Make 'user' available in all templates"""
    user = None
    if 'user_id' in session:
        user = AcadUser.query.get(session['user_id'])
        if user:
            ensure_avatar_color(user)
    return dict(user=user)



# ---------------- Run Server ----------------
if __name__ == '__main__':
    app.run(debug=True)