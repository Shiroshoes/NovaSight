from flask import Flask, render_template, redirect, session, request, flash, url_for
from configs.config import SECRET_KEY, SQLALCHEMY_DATABASE_URI, SQLALCHEMY_TRACK_MODIFICATIONS
from database.models import db, AcadUser
from werkzeug.security import generate_password_hash
from flask import jsonify
from routes.admin import admin_bp
from routes.registrar import registrar_bp
from routes.saso import saso_bp
from routes.cahs import cahs_bp
from routes.cba import cba_bp
from routes.ccst import ccst_bp
from routes.cea import cea_bp
from routes.coas import coas_bp
from routes.ctec import ctec_bp
from ml_route.ml_analysis import ml_bp
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
app.register_blueprint(cahs_bp)
app.register_blueprint(cba_bp)
app.register_blueprint(ccst_bp)
app.register_blueprint(cea_bp)
app.register_blueprint(coas_bp)
app.register_blueprint(ctec_bp)
app.register_blueprint(ml_bp)

# ---------------- Default Admin Creation ----------------
with app.app_context():
    db.create_all()
    if not AcadUser.query.filter_by(username='admin').first():
        admin_user = AcadUser(username='admin', account='admin@gmail.com', role='admin')
        admin_user.set_password('Admin123!')
        db.session.add(admin_user)
        db.session.commit()
        print("Admin account created: admin/Admin123!")
    else:
        print("Admin account already exists")

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
    # Only redirect if user is really logged in
    if 'user_id' in session:
        flash("You are already logged in.", "info")
        role = session.get('role')
        if role == 'admin':
            return redirect('/NovaSight/admin')
        elif role == 'Registrar':
            return redirect('/NovaSight/registrar/home')
        elif role == 'SASO':
            return redirect('/NovaSight/saso/home')
        elif role == 'CAHSdean':
            return redirect('/NovaSight/cahs/home')
        elif role == 'CBAdean':
            return redirect('/NovaSight/cba/home')
        elif role == 'CCSTdean':
            return redirect('/NovaSight/ccst/home')
        elif role == 'CEAdean':
            return redirect('/NovaSight/cea/home')
        elif role == 'CoASdean':
            return redirect('/NovaSight/coas/home')
        elif role == 'CTECdean':
            return redirect('/NovaSight/ctec/home')
        else:
            return redirect('/NovaSight') # Default redirection for other roles

    if request.method == 'POST':
        account = request.form.get('account')
        password = request.form.get('password')
        user = AcadUser.query.filter_by(account=account).first()
        if user and user.check_password(password):
            session['user_id'] = user.acaduser_id
            session['role'] = user.role
            flash(f"Welcome, {user.username}!", "success")
            if user.role == 'admin':
                return redirect('/NovaSight/admin')
            elif user.role == 'Registrar': 
                return redirect('/NovaSight/registrar/home')
            elif user.role == 'SASO':
                return redirect('/NovaSight/saso/home')
            elif user.role == 'CAHSdean':
                return redirect('NovaSight/cahs/home')
            elif user.role == 'CBAdean':
                return redirect('/NovaSight/cba/home')
            elif user.role == 'CCSTdean':
                return redirect('/NovaSight/ccst/home')
            elif user.role == 'CEAdean':
                return redirect('/NovaSight/cea/home')
            elif user.role == 'CoASdean':
                return redirect('/NovaSight/coas/home')
            elif user.role == 'CTECdean':
                return redirect('/NovaSight/ctec/home')
            else:
                return redirect('/NovaSight') # Default redirection for other roles
        else:
            flash("Invalid credentials", "error")

    return render_template('login.html')

@app.route('/logout')
def logout():
    if 'user_id' in session:
        session.clear()
    return redirect('/')

#change password
@app.route('/update-password', methods=['POST'])
def update_password():
    if 'user_id' not in session:
        return jsonify({"success": False, "message": "Not logged in"}), 401

    data = request.get_json()
    new_password = data.get('password', '').strip()

    if not new_password:
        return jsonify({"success": False, "message": "Password cannot be empty"}), 400

    try:
        user = AcadUser.query.get(session['user_id'])
        user.set_password(new_password) 
        db.session.commit()
        return jsonify({"success": True, "message": "Password updated successfully"})
    except Exception as e:
        print("Error updating password:", e)
        return jsonify({"success": False, "message": "Error updating password"}), 500


# ---------------- Context Processor ----------------
@app.context_processor
def inject_user():
    """Make 'user' available in all templates"""
    user = None
    if 'user_id' in session:
        user = AcadUser.query.get(session['user_id'])
    return dict(user=user)




# ---------------- Run Server ----------------
if __name__ == '__main__':
    app.run(debug=True)