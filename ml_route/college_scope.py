"""
college_scope.py  —  server-side college scoping for Dean accounts
=====================================================================
WHY THIS EXISTS
  Hiding the "other colleges" option in the filter only changes what the
  page *shows*.  The data itself comes from /api/dash/* and /api/pred/*,
  and anyone can call those URLs directly (browser address bar, DevTools,
  a script) with any ?dept= / ?department= value, or none at all, and get
  the whole campus.  A Dean account must therefore be limited HERE, on the
  server, no matter what the browser asks for.

HOW IT WORKS
  forced_college()  ->  "CAHS" for a CAHS Dean, None for everyone else
                        (Admin, MISO, Academic Affairs, Registrar, SASO see all).
  A scoped role can never see another college: the requested department is
  ignored and replaced by the forced one.

  FAIL CLOSED: a Dean whose college cannot be worked out gets NO data
  (a college code that matches nothing) instead of everything.

ROLES (from app.py)
  Dean roles  : CBAdean, CCSTdean, CEAdean, CoASdean, CTECdean + every role in CAHS_ROLES
  See everything: Academic_Affair, Registrar, SASO, MISO
  Anything else (or not logged in) gets NO data.  Edit the two tables below when you add a role.
"""
from flask import has_request_context, session

try:                                    # the four CAHS roles (Nursing / Public Health / Midwifery deans + CAHS director)
    from configs.config import CAHS_ROLES
except Exception:                       # pragma: no cover
    CAHS_ROLES = ()

# session["role"] is written once at login (app.py) and re-checked against the database on every
# request (sync_session_with_db), so it can be trusted.  These are the role names app.py uses.
DEAN_ROLE_COLLEGE = {
    "CBAdean":  "CBA",
    "CCSTdean": "CCST",
    "CEAdean":  "CEA",
    "CoASdean": "COAS",
    "CTECdean": "CTEC",
}
DEAN_ROLE_COLLEGE.update({r: "CAHS" for r in CAHS_ROLES})     # all four CAHS roles see CAHS

# Roles that may see every college.  Anything NOT listed here and NOT a dean role gets no data
# (fail closed), so a brand-new role must be added here on purpose.
FULL_ACCESS_ROLES = {"Academic_Affair", "Registrar", "SASO", "MISO"}

NO_COLLEGE = "__NO_COLLEGE__"           # matches no data -> empty result

_resolver = None


def set_scope_resolver(fn):
    """Override how the college is decided. fn() -> 'CAHS' | None."""
    global _resolver
    _resolver = fn


def forced_college():
    """The one college this request may see; None only for roles that see everything."""
    if _resolver is not None:
        return _resolver()
    if not has_request_context():
        return NO_COLLEGE
    role = session.get("role")
    if not role:
        return NO_COLLEGE                               # not logged in -> nothing
    if role in DEAN_ROLE_COLLEGE:
        return DEAN_ROLE_COLLEGE[role]
    if role in FULL_ACCESS_ROLES:
        return None
    return NO_COLLEGE                                   # unknown role -> nothing (fail closed)


# ── helpers for the main-dashboard API (/api/dash/*) ────────────────────────
def scoped_dept(requested=None):
    """Use instead of request.args.get('dept'):  dept = scoped_dept(request.args.get('dept'))"""
    forced = forced_college()
    return forced if forced else (requested or None)


def scope_dash_meta(meta):
    """Call on the dict returned by /api/dash/meta before jsonify():  meta = scope_dash_meta(meta)
    Removes the other colleges (and their courses) from the filter lists."""
    forced = forced_college()
    if not forced:
        return meta
    out = dict(meta)
    depts = out.get("departments") or []
    out["departments"] = [d for d in depts if (d.get("name") if isinstance(d, dict) else d) == forced]
    out["courses"] = [c for c in (out.get("courses") or []) if c.get("dept") == forced]
    out["scoped_to"] = forced
    return out