from flask_sqlalchemy import SQLAlchemy
from werkzeug.security import generate_password_hash, check_password_hash

db = SQLAlchemy()

# ── Avatar colors ─────────────────────────────────────────────
# One color "family" per role/department. Each family has 3 closely-related
# shades (same hue, stepped lightness) so that when two+ users share a role,
# MIS can still tell their avatars apart at a glance without the families
# themselves being confusable with each other.
#
# Each shade is a (background, icon) pair:
#   - background is the actual avatar/chip fill color.
#   - icon is the color the little person-silhouette SVG is painted, chosen
#     per-shade for WCAG-ish contrast so the icon stays legible whether the
#     background lands light or dark.
#
# The dean roles' FIRST shade is deliberately the exact hex from
# COLLEGE_COLORS in chart-helpers.js (the "official"/"real" color already
# used for that college everywhere on the dashboards) — the 2nd and 3rd
# shades are just lighter tints of that same real color, generated to keep
# multiple users on the same role visually distinct.
ROLE_COLOR_FAMILIES = {
    'admin':           [('#4A4A4A', '#FFFFFF'), ('#6E6E6E', '#FFFFFF'), ('#8C8C8C', '#FFFFFF')],  # neutral grey — MIS/admin
    'Registrar':       [('#1E5AA8', '#FFFFFF'), ('#2E72C9', '#FFFFFF'), ('#5B93D8', '#FFFFFF')],  # blue
    'SASO':            [('#B8860B', '#FFFFFF'), ('#D4A017', '#FFFFFF'), ('#E6B84D', '#1F2937')],  # gold
    'Academic_Affair': [('#6A1B9A', '#FFFFFF'), ('#8E24AA', '#FFFFFF'), ('#AB47BC', '#FFFFFF')],  # purple
    'CAHSdean':        [('#36B9CC', '#FFFFFF'), ('#62C8D7', '#1F2937'), ('#8AD6E1', '#1F2937')],  # teal — matches COLLEGE_COLORS.CAHS
    'CBAdean':         [('#E74A3B', '#FFFFFF'), ('#EC7266', '#FFFFFF'), ('#F1968D', '#1F2937')],  # red — matches COLLEGE_COLORS.CBA
    'CCSTdean':        [('#8A2BE2', '#FFFFFF'), ('#A45AE8', '#FFFFFF'), ('#BB84EE', '#FFFFFF')],  # purple — matches COLLEGE_COLORS.CCST
    'CEAdean':         [('#1CC88A', '#1F2937'), ('#4ED4A4', '#1F2937'), ('#7BDFBB', '#1F2937')],  # green — matches COLLEGE_COLORS.CEA
    'CoASdean':        [('#5A5C69', '#FFFFFF'), ('#7E808A', '#FFFFFF'), ('#9FA0A8', '#FFFFFF')],  # slate gray — matches COLLEGE_COLORS.COAS
    'CTECdean':        [('#4E73DF', '#FFFFFF'), ('#7592E6', '#FFFFFF'), ('#98AEEC', '#1F2937')],  # blue — matches COLLEGE_COLORS.CTEC
}
DEFAULT_COLOR_FAMILY = [('#800000', '#FFFFFF'), ('#9A2A2A', '#FFFFFF'), ('#B85454', '#FFFFFF')]  # fallback: house maroon


def assign_avatar_color(user):
    """
    Picks this user's avatar shade (background + contrast-safe icon color)
    and sets both on the instance (does NOT commit). Call this once, at
    creation time or when a user's role changes, so the colors are stored
    rather than recomputed on every request.

    The shade index is based on how many other users of the same role
    already HAVE a color assigned, so assignments only move forward as
    people are added — they don't shuffle around later if someone else on
    the same role gets archived or deleted.
    """
    family = ROLE_COLOR_FAMILIES.get(user.role, DEFAULT_COLOR_FAMILY)
    existing_count = (
        AcadUser.query
        .filter_by(role=user.role)
        .filter(AcadUser.avatar_color.isnot(None))
        .count()
    )
    bg, icon = family[existing_count % len(family)]
    user.avatar_color = bg
    user.avatar_icon_color = icon
    return user.avatar_color, user.avatar_icon_color


def ensure_avatar_color(user):
    """
    Lazy backfill for users that existed before the avatar_color /
    avatar_icon_color columns did. Safe to call on every page load — it's
    a no-op once both are stored.
    """
    if not user.avatar_color or not user.avatar_icon_color:
        assign_avatar_color(user)
        db.session.commit()
    return user.avatar_color, user.avatar_icon_color


def resync_avatar_colors():
    """
    Recomputes avatar_color + avatar_icon_color for EVERY user (active and
    archived) from the current ROLE_COLOR_FAMILIES, ordered by
    acaduser_id so shade assignment is deterministic and repeatable.

    This exists separately from assign_avatar_color()/ensure_avatar_color()
    because those two only ever fill in a MISSING color — they won't touch
    a color a user already has. This function is what actually pushes the
    "real" chart-helpers.js department colors onto existing rows that were
    colored under the old palette. Safe to call on every startup: it's a
    no-op once every row already matches the current palette.
    """
    users_by_role = {}
    for user in AcadUser.query.order_by(AcadUser.acaduser_id).all():
        users_by_role.setdefault(user.role, []).append(user)

    changed = False
    for role, users in users_by_role.items():
        family = ROLE_COLOR_FAMILIES.get(role, DEFAULT_COLOR_FAMILY)
        for i, user in enumerate(users):
            bg, icon = family[i % len(family)]
            if user.avatar_color != bg or user.avatar_icon_color != icon:
                user.avatar_color = bg
                user.avatar_icon_color = icon
                changed = True

    if changed:
        db.session.commit()
    return changed


class AcadUser(db.Model):
    __tablename__ = 'acad_user'
    acaduser_id       = db.Column(db.Integer, primary_key=True)
    first_name        = db.Column(db.String(100), nullable=False)
    last_name         = db.Column(db.String(100), nullable=False)
    mi                = db.Column(db.String(5),   nullable=True)
    suffix            = db.Column(db.String(10),  nullable=True)
    account           = db.Column(db.String(255), unique=True, nullable=False)
    password          = db.Column(db.String(255), nullable=False)
    role              = db.Column(db.String(50),  nullable=False)
    date_created      = db.Column(db.DateTime,    server_default=db.func.now())
    is_archived       = db.Column(db.Boolean,     default=False, nullable=False)
    date_archived     = db.Column(db.DateTime,    nullable=True)
    profile_image_url = db.Column(db.String(255), nullable=True)
    avatar_color       = db.Column(db.String(7),   nullable=True)  # e.g. '#36B9CC' — real dept color, set by assign_avatar_color()
    avatar_icon_color  = db.Column(db.String(7),   nullable=True)  # e.g. '#FFFFFF' — contrast-safe icon fill paired with avatar_color
    # Comma-separated data-video-key values (see page-video-modal.js) this
    # user has already had auto-played once, e.g. "admin,cahs_home". A
    # server-side flag rather than localStorage because localStorage is
    # per-browser — it doesn't survive incognito windows, a cleared cache,
    # or (once this ships) a thesis evaluator opening the same account
    # from a different device than whoever demoed it last.
    seen_tutorials     = db.Column(db.Text,        nullable=True)

    # relationship
    uploaded_datasets = db.relationship('UploadedDataset', backref='uploader', lazy=True)

    @property
    def username(self):
        """'Last, First MI. Suffix' — used for uploaded-by / audit-trail displays."""
        name = self.last_name
        name += f", {self.first_name}"
        if self.mi:
            name += f" {self.mi}."
        if self.suffix:
            name += f" {self.suffix}"
        return name

    @property
    def profile_name(self):
        """'First MI. Last Suffix' — used for profile / header display."""
        name = self.first_name
        if self.mi:
            name += f" {self.mi}."
        name += f" {self.last_name}"
        if self.suffix:
            name += f" {self.suffix}"
        return name

    def set_password(self, pwd):
        self.password = generate_password_hash(pwd)

    def check_password(self, pwd):
        return check_password_hash(self.password, pwd)

    def has_seen_tutorial(self, key):
        """Whether this user has already had the given data-video-key tutorial auto-played."""
        seen = (self.seen_tutorials or '').split(',')
        return key in seen

    def mark_tutorial_seen(self, key):
        """Adds `key` to this user's seen-tutorials list. Does NOT commit — caller commits."""
        seen = set((self.seen_tutorials or '').split(','))
        seen.discard('')
        seen.add(key)
        self.seen_tutorials = ','.join(sorted(seen))


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