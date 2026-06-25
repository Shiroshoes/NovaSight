from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()

class AcadUser(db.Model):
    __tablename__ = 'acad_user'
    acaduser_id   = db.Column(db.Integer, primary_key=True)
    first_name    = db.Column(db.String(100), nullable=False)
    last_name     = db.Column(db.String(100), nullable=False)
    mi            = db.Column(db.String(5),   nullable=True)
    account       = db.Column(db.String(255), unique=True, nullable=False)
    password      = db.Column(db.String(255), nullable=False)
    role          = db.Column(db.String(50),  nullable=False)
    date_created  = db.Column(db.DateTime, server_default=db.func.now())
    is_archived   = db.Column(db.Boolean, default=False, nullable=False)
    date_archived = db.Column(db.DateTime, nullable=True)
    profile_image_url = db.Column(db.String(255), nullable=True)

    # ── Convenience property: full name for display ──
    @property
    def username(self):
        """Full name string used throughout templates / old code."""
        if self.mi:
            return f"{self.first_name} {self.last_name} {self.mi}."
        return f"{self.first_name} {self.last_name}"

    def set_password(self, pwd):
        self.password = generate_password_hash(pwd)

    def check_password(self, pwd):
        return check_password_hash(self.password, pwd)