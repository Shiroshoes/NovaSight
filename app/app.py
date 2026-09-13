from flask import Flask, render_template, redirect, session, request, flash, url_for
from configs.config import SECRET_KEY, SQLALCHEMY_DATABASE_URI, SQLALCHEMY_TRACK_MODIFICATIONS, CAHS_ROLES
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
from ml_route.ml_metrics_routes import ml_diag_bp
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
app.register_blueprint(ml_diag_bp)

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

    # Same story for uploaded_dataset: is_deleted/deleted_at are new
    # (soft-delete / Recently Deleted trash table feature) and won't
    # exist yet on a database created before this change.
    existing_upload_cols = {c['name'] for c in inspector.get_columns('uploaded_dataset')}
    if 'is_deleted' not in existing_upload_cols:
        db.session.execute(text(
            'ALTER TABLE uploaded_dataset ADD COLUMN is_deleted BOOLEAN NOT NULL DEFAULT 0'
        ))
        db.session.commit()
        print("Migrated: added uploaded_dataset.is_deleted")

    if 'deleted_at' not in existing_upload_cols:
        db.session.execute(text('ALTER TABLE uploaded_dataset ADD COLUMN deleted_at DATETIME'))
        db.session.commit()
        print("Migrated: added uploaded_dataset.deleted_at")

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

    # Default admin's domain changed from gmail.com to the official
    # bpsu.edu.ph one. On a database created before this change, the old
    # admin@gmail.com row is still sitting there — rename it in place
    # (preserving its password/history) instead of leaving it behind and
    # letting the block below create a brand-new second admin account.
    old_admin = AcadUser.query.filter_by(account='admin@gmail.com').first()
    if old_admin and not AcadUser.query.filter_by(account='admin@bpsu.edu.ph').first():
        old_admin.account = 'admin@bpsu.edu.ph'
        db.session.commit()
        print("Migrated: renamed admin@gmail.com -> admin@bpsu.edu.ph")

    if not AcadUser.query.filter_by(account='admin@bpsu.edu.ph').first():
        admin_user = AcadUser(
            first_name='Admin',
            last_name='User',
            mi=None,
            account='admin@bpsu.edu.ph',
            role='admin'
        )
        admin_user.set_password('Admin123!')
        assign_avatar_color(admin_user)
        db.session.add(admin_user)
        db.session.commit()
        print("Admin account created: admin@bpsu.edu.ph / Admin123!")
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

@app.route('/privacy-policy')
def privacy_policy():
    return render_template('privacypolicy.html')

# ---------------- Login / Logout ----------------
@app.route('/login', methods=['GET', 'POST'])
def login():
    if 'user_id' in session:
        # Clicking Login while already logged in (e.g. from the public
        # home page in a different tab) goes straight to that user's
        # own dashboard landing page — no detour through home.
        return _redirect_by_role(session.get('role'))

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
        'CBAdean':        '/NovaSight/cba/home',
        'CCSTdean':       '/NovaSight/ccst/home',
        'CEAdean':        '/NovaSight/cea/home',
        'CoASdean':       '/NovaSight/coas/home',
        'CTECdean':       '/NovaSight/ctec/home',
    }
    # All four CAHS roles (Nursing/PH/Midwifery deans + CAHS director) land
    # on the same CAHS home page.
    routes.update({r: '/NovaSight/cahs/home' for r in CAHS_ROLES})
    return redirect(routes.get(role, '/NovaSight'))


@app.route('/logout')
def logout():
    session.clear()
    return redirect('/')


# ---------------- No-Cache Headers (fix: Back button after logout) --------
@app.after_request
def add_no_cache_headers(response):
    """
    Without this, clicking the browser's Back button after /logout can
    redisplay the last dashboard page exactly as it looked while still
    logged in — not because the session is still valid (session.clear()
    in logout() already wiped it), but because the browser served the
    page straight from its cache/back-forward-cache instead of asking
    the server again. These headers tell the browser never to do that,
    so Back always triggers a fresh request, which then correctly hits
    the @login_required-style checks and bounces to /login.
    """
    response.headers['Cache-Control'] = 'no-cache, no-store, must-revalidate'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response

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


# ---------------- Keep session in sync with the DB ----------------
@app.before_request
def sync_session_with_db():
    """
    session['role'] is only ever written once, at login — every page
    guard in this app (session.get('role') != 'admin', etc.) checks
    THAT stashed value, never the database. So if an admin changes a
    user's role (or deactivates them) while that user is still logged
    in, the DB updates immediately but their session keeps the OLD role
    until they manually log out and back in.

    Re-checking the user's current role/archived status against the DB
    on every request catches that drift and forces them out (session
    cleared) the moment it's detected, instead of leaving them logged
    in under a role that no longer matches the database. On their next
    full-page navigation they're sent to the public home page (same as
    every other role guard in this app — admin.py, cahs.py, cba.py,
    etc. — which all redirect unauthorized access to url_for('home'),
    not to /login) with a message explaining why, so they can log back
    in from there and land on the dashboard for their new role. Skipped
    for static files — nothing to sync there.
    """
    if request.endpoint == 'static':
        return
    if 'user_id' not in session:
        return

    user = AcadUser.query.get(session['user_id'])
    if not user or user.is_archived:
        # Account was deleted or deactivated while logged in.
        session.clear()
        # Always queue the flash the moment we detect this, even if
        # THIS particular request is a background fetch() (chart data
        # polling, etc.) rather than a real page load — flash() writes
        # into the session cookie, which persists into whatever request
        # comes next. If we only flashed inside the GET/html branch
        # below, a background request catching the mismatch first would
        # clear the session with no message queued, and the user's next
        # real click would land on home with nothing to show (this was
        # the actual bug — the modal never appeared).
        flash("Your account has been deactivated. If this wasn't authorized, please contact the administrator.", "error")
        if request.method == 'GET' and request.accept_mimetypes.best == 'text/html':
            return redirect(url_for('home'))
        return

    if session.get('role') != user.role:
        # Role changed while the user was logged in — kick them out
        # entirely rather than silently swapping them into the new
        # role's dashboard mid-session.
        session.clear()
        flash("Your role was updated by an admin. Please log in again.", "info")

        # Same reasoning as the deactivated-account case above: flash
        # first (unconditionally), THEN only take over the response
        # for full-page navigations. request.accept_mimetypes.best is
        # 'text/html' for a clicked link/refresh, but '*/*' or
        # 'application/json' for the page's own background fetch()
        # calls (chart data, etc.) — redirecting one of THOSE to an
        # HTML page would hand the JS markup it can't parse as JSON,
        # so we leave those alone and let whatever 401/403 the specific
        # endpoint already returns handle it. The flash is already
        # queued in the session cookie by this point regardless, so the
        # next real page load still shows it even if this exact request
        # wasn't one.
        if request.method == 'GET' and request.accept_mimetypes.best == 'text/html':
            return redirect(url_for('home'))


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