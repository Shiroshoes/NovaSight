from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()

class AcadUser(db.Model):
    __tablename__ = 'acad_user'
    acaduser_id       = db.Column(db.Integer, primary_key=True)
    first_name        = db.Column(db.String(100), nullable=False)
    last_name         = db.Column(db.String(100), nullable=False)
    mi                = db.Column(db.String(5),   nullable=True)
    account           = db.Column(db.String(255), unique=True, nullable=False)
    password          = db.Column(db.String(255), nullable=False)
    role              = db.Column(db.String(50),  nullable=False)
    date_created      = db.Column(db.DateTime,    server_default=db.func.now())
    is_archived       = db.Column(db.Boolean,     default=False, nullable=False)
    date_archived     = db.Column(db.DateTime,    nullable=True)
    profile_image_url = db.Column(db.String(255), nullable=True)

    # relationship
    uploaded_datasets = db.relationship('UploadedDataset', backref='uploader', lazy=True)

    @property
    def username(self):
        """'Last, First MI.' — used for uploaded-by / audit-trail displays."""
        if self.mi:
            return f"{self.last_name}, {self.first_name} {self.mi}."
        return f"{self.last_name}, {self.first_name}"

    @property
    def profile_name(self):
        """'First MI. Last' — used for profile / header display."""
        if self.mi:
            return f"{self.first_name} {self.mi}. {self.last_name}"
        return f"{self.first_name} {self.last_name}"

    def set_password(self, pwd):
        self.password = generate_password_hash(pwd)

    def check_password(self, pwd):
        return check_password_hash(self.password, pwd)


class UploadedDataset(db.Model):
    """
    Tracks every Excel grade-sheet uploaded by a user.

    Columns
    -------
    id                  PK
    original_filename   The exact filename as uploaded (used as duplicate checker)
    stored_filename     Collision-safe name on disk (user_id + timestamp + filename)
    raw_path            Absolute path in Unprocessed_Datasets/
    processed           Whether preprocessing completed successfully
    processed_path      Absolute path of the merged CSV in Processed_Datasets/
    status              'pending' | 'processing' | 'done' | 'failed' | 'duplicate'
    error_message       Human-readable failure reason (if any)
    uploaded_at         UTC timestamp of upload
    uploaded_by         FK → AcadUser.acaduser_id
    academic_year       Extracted from filename  e.g. '2022-2023'
    semester            Extracted from filename  e.g. '1sem'
    file_size_kb        Original file size in KB
    sheet_count         Number of sheets found in the workbook
    row_count           Total long-form rows produced after preprocessing
    """
    __tablename__ = 'uploaded_dataset'

    id                = db.Column(db.Integer,      primary_key=True)
    original_filename = db.Column(db.String(255),  nullable=False)
    stored_filename   = db.Column(db.String(255),  nullable=False, unique=True)
    raw_path          = db.Column(db.String(512),  nullable=False)
    processed         = db.Column(db.Boolean,      default=False, nullable=False)
    processed_path    = db.Column(db.String(512),  nullable=True)
    status            = db.Column(db.String(30),   default='pending', nullable=False)
    error_message     = db.Column(db.Text,         nullable=True)
    uploaded_at       = db.Column(db.DateTime,     server_default=db.func.now(), nullable=False)
    uploaded_by       = db.Column(db.Integer,      db.ForeignKey('acad_user.acaduser_id'), nullable=False)
    academic_year     = db.Column(db.String(20),   nullable=True)
    semester          = db.Column(db.String(20),   nullable=True)
    file_size_kb      = db.Column(db.Float,        nullable=True)
    sheet_count       = db.Column(db.Integer,      nullable=True)
    row_count         = db.Column(db.Integer,      nullable=True)

    def to_dict(self):
        return {
            'id':                self.id,
            'original_filename': self.original_filename,
            'stored_filename':   self.stored_filename,
            'processed':         self.processed,
            'status':            self.status,
            'error_message':     self.error_message,
            'uploaded_at':       self.uploaded_at.strftime('%b %d, %Y  %I:%M %p') if self.uploaded_at else '—',
            'uploader_name':     self.uploader.username if self.uploader else '—',
            'uploader_role':     self.uploader.role    if self.uploader else '—',
            'academic_year':     self.academic_year or '—',
            'semester':          self.semester     or '—',
            'file_size_kb':      f"{self.file_size_kb:.1f} KB" if self.file_size_kb else '—',
            'sheet_count':       self.sheet_count  or '—',
            'row_count':         f"{self.row_count:,}" if self.row_count else '—',
            'raw_path':          self.raw_path,
            'processed_path':    self.processed_path or '—',
        }