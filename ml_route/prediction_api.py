"""
ml_route/prediction_api.py — NovaSight Prediction Analysis API
===============================================================
Serves the *prediction-only* dashboard (predictiondashboardAdmin.html +
static/js/prediction-dash.js). Nothing here reads CSVs or the database: every
number comes from the two bundles auto_train.py writes —

    pred_cube.pkl      College x Course x Year_Level trends  -> KPI, At-Risk, GWA
    pred_subjects.pkl  ... x Subject_Code trends             -> Top Hardest Subjects

Register once in your app factory:

    from ml_route.prediction_api import pred_bp
    app.register_blueprint(pred_bp)

Endpoints (all GET, JSON; every one returns {"available": false, "reason": …}
instead of failing while no bundle exists yet):

    /api/pred/meta
    /api/pred/kpi         ?department=&course=&year_level=
    /api/pred/at_risk     ?metric=FAILED|INC|DRP|UDR|W &department=&course=&year_level=&horizon=&history=
    /api/pred/gwa_trend   ?department=&course=&year_level=&horizon=&history=
    /api/pred/hardest     ?metric=&rank_by=rate|grade &top=5|10|15|20|all &subject=&department=
                          &course=&year_level=&horizon=&history=

Horizon rules live in the bundle (compute_horizon in auto_train.py): KPI is always
1 semester ahead; the other charts get `chart_steps` semesters, which grows as more
semesters are uploaded.

NOTE: add your login/role guard (the same one the other /api routes use) with
`pred_bp.before_request(...)` — it is intentionally not guessed here.
"""

import os
import threading

import joblib
from flask import session, Blueprint, jsonify, request

try:
    from preprocessing.preprocess import PROCESSED_DIR
except Exception:                                    # pragma: no cover
    PROCESSED_DIR = os.getcwd()

# Must match PRED_MODEL_DIR in auto_train.py
PRED_MODEL_DIR = os.path.join(PROCESSED_DIR, "prediction_models")

try:                                        # college scoping for Dean accounts (see college_scope.py)
    from .college_scope import forced_college
except ImportError:                         # pragma: no cover
    from college_scope import forced_college

pred_bp = Blueprint("pred_bp", __name__)


@pred_bp.before_request
def _require_login():
    """Nothing under /api/pred/ may be read without a login (the pages that use it are all behind one)."""
    if "user_id" not in session:
        return jsonify({"available": False, "error": "Not logged in"}), 401

SUBJECT_STATUSES = ["FAILED", "INC", "DRP", "UDR", "W"]
_ALIASES = {"DROP": "DRP", "DROPPED": "DRP", "FAIL": "FAILED"}
_ALL = {None, "", "all", "All", "ALL", "Main Campus", "all_colleges"}

# ══════════════════════════════════════════════════════════════════════════
#  Bundle loading (cached by file mtime, so a retrain is picked up automatically)
# ══════════════════════════════════════════════════════════════════════════
_lock = threading.Lock()
_cache = {}          # filename -> (mtime, bundle)


def reload_bundles():
    with _lock:
        _cache.clear()


def _bundle(filename):
    path = os.path.join(PRED_MODEL_DIR, filename)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return None
    with _lock:
        hit = _cache.get(filename)
        if hit and hit[0] == mtime:
            return hit[1]
        obj = joblib.load(path)
        _cache[filename] = (mtime, obj)
        return obj


def _unavailable(reason):
    return jsonify({"available": False, "reason": reason})


# ══════════════════════════════════════════════════════════════════════════
#  Term / trend helpers   (mirror of auto_train._predict_trend)
# ══════════════════════════════════════════════════════════════════════════

def _sem(t):
    return int(t) % 2 + 1


def _label(t):
    y, s = int(t) // 2, _sem(t)
    return f"{y}-{y + 1} {'1st' if s == 1 else '2nd'} Sem"


def _term(t, last_t):
    return {"t": int(t), "label": _label(t), "sem": _sem(t),
            "predicted": int(t) > int(last_t)}


def _trend(m, t, t_ref):
    return m["b0"] + m["bt"] * (t - t_ref) + m["bs"] * (1.0 if int(t) % 2 == 1 else 0.0)


def _clamp(measure, v):
    if v is None:
        return None
    if measure == "students":
        return max(0.0, v)
    if measure in ("gwa", "avg_grade"):
        return min(5.0, max(1.0, v))
    return min(1.0, max(0.0, v))                       # every *_rate


def _value(s, measure, t, last_t, t_ref):
    """Recorded value if t was recorded, forecast if t is in the future, else None."""
    if t <= last_t:
        if t in s["t"]:
            return s["y"][measure][s["t"].index(t)] if measure in s["y"] else None
        return None
    m = s["m"].get(measure)
    return None if m is None else _clamp(measure, _trend(m, t, t_ref))


def _bad(v):
    return v is None or v != v


# ══════════════════════════════════════════════════════════════════════════
#  Request helpers
# ══════════════════════════════════════════════════════════════════════════

def _filters():
    dept = request.args.get("department")
    course = request.args.get("course")
    yl = request.args.get("year_level")
    try:
        yl = None if yl in _ALL else int(yl)
    except (TypeError, ValueError):
        yl = None
    forced = forced_college()               # a Dean can only ever see their own college
    if forced:
        dept = forced
    return (None if dept in _ALL else dept,
            None if course in _ALL else course,
            yl)


def _select(series, dept, course, yl):
    out = []
    for s in series:
        if dept and s["college"] != dept:
            continue
        if course and s["course"] != course:
            continue
        if yl is not None and s["yl"] != yl:
            continue
        out.append(s)
    return out


def _horizon_steps(hz):
    try:
        h = int(request.args.get("horizon", hz["chart_steps"]))
    except (TypeError, ValueError):
        h = hz["chart_steps"]
    return max(1, min(h, hz["chart_steps"]))


def _flag(name, default=True):
    v = request.args.get(name)
    if v is None:
        return default
    return v.lower() in ("1", "true", "yes", "on")


def _pct(new, old):
    if _bad(new) or _bad(old) or old == 0:
        return None
    return round((new - old) / old * 100.0, 1)


def _active(s, last_t):
    """A series that stopped being recorded (course/year level phased out) is not extrapolated."""
    return s["t"] and s["t"][-1] >= last_t - 1


# ══════════════════════════════════════════════════════════════════════════
#  pred_cube aggregation
# ══════════════════════════════════════════════════════════════════════════

def _aggregate(cube, series, t):
    """Pool a set of College x Course x YL series at one term."""
    last_t, t_ref = cube["horizon"]["last_t"], cube["t_ref"]
    statuses = cube["statuses"]
    tot = {"students": 0.0, "irregular": 0.0, "gwa_w": 0.0, "gwa_n": 0.0,
           "comp_w": 0.0, "comp_n": 0.0, "counts": {st: 0.0 for st in statuses}}
    seen = False
    for s in series:
        if t > last_t and not _active(s, last_t):
            continue
        n = _value(s, "students", t, last_t, t_ref)
        if _bad(n) or n <= 0:
            continue
        seen = True
        tot["students"] += n
        irr = _value(s, "irregular_rate", t, last_t, t_ref)
        tot["irregular"] += n * (0.0 if _bad(irr) else irr)
        g = _value(s, "gwa", t, last_t, t_ref)
        if not _bad(g):
            tot["gwa_w"] += n * g
            tot["gwa_n"] += n
        c = _value(s, "completion_rate", t, last_t, t_ref)
        if not _bad(c):
            tot["comp_w"] += n * c
            tot["comp_n"] += n
        for st in statuses:
            r = _value(s, f"{st.lower()}_rate", t, last_t, t_ref)
            tot["counts"][st] += n * (0.0 if _bad(r) else r)
    if not seen:
        return None
    n = tot["students"]
    return {
        "students": n,
        "irregular": tot["irregular"],
        "regular": n - tot["irregular"],
        "gwa": tot["gwa_w"] / tot["gwa_n"] if tot["gwa_n"] else None,
        "completion": tot["comp_w"] / tot["comp_n"] if tot["comp_n"] else None,
        "counts": tot["counts"],
    }


def _by_year_level(cube, series, t, key):
    last = {}
    for yl in sorted({s["yl"] for s in series if s["yl"] > 0}):
        a = _aggregate(cube, [s for s in series if s["yl"] == yl], t)
        last[yl] = 0.0 if a is None else a[key]
    total = sum(last.values())
    return [{"year_level": yl, "value": round(v),
             "share": round(v / total * 100.0, 1) if total else 0.0}
            for yl, v in last.items()]


# ══════════════════════════════════════════════════════════════════════════
#  Endpoints
# ══════════════════════════════════════════════════════════════════════════

@pred_bp.route("/api/pred/meta")
def pred_meta():
    cube = _bundle("pred_cube.pkl")
    if cube is None:
        return _unavailable("No prediction model yet — upload enough semesters "
                            "(6 required) and let training finish.")
    hz = cube["horizon"]
    depts = {}
    forced = forced_college()
    for s in cube["series"]:
        if forced and s["college"] != forced:
            continue
        depts.setdefault(s["college"], set()).add(s["course"])
    return jsonify({
        "available": True,
        "trained_at": cube["trained_at"],
        "horizon": hz,
        "departments": [{"name": d, "courses": sorted(c)} for d, c in sorted(depts.items())],
        "year_levels": sorted({s["yl"] for s in cube["series"] if s["yl"] > 0 and (not forced or s["college"] == forced)}),
        "scoped_to": forced,
        "statuses": cube["statuses"],
        "irregular_source": cube.get("irregular_source"),
        "has_subjects": _bundle("pred_subjects.pkl") is not None,
        "backtest": cube.get("backtest"),
    })


@pred_bp.route("/api/pred/kpi")
def pred_kpi():
    cube = _bundle("pred_cube.pkl")
    if cube is None:
        return _unavailable("No prediction model yet.")
    hz = cube["horizon"]
    last_t = hz["last_t"]
    t1, t0 = last_t + 1, last_t                    # KPI: always 1 semester ahead
    series = _select(cube["series"], *_filters())
    now, prev = _aggregate(cube, series, t1), _aggregate(cube, series, t0)
    if now is None:
        return jsonify({"available": True, "empty": True, "term": _term(t1, last_t),
                        "prev_term": _term(t0, last_t)})

    def seg(key):
        v, p = now[key], (prev or {}).get(key)
        return {"value": round(v), "prev": None if p is None else round(p),
                "pct": _pct(v, p), "by_year": _by_year_level(cube, series, t1, key)}

    statuses = {}
    for st, c in now["counts"].items():
        p = (prev or {}).get("counts", {}).get(st)
        ratio = c / now["students"] * 100.0 if now["students"] else None
        pratio = p / prev["students"] * 100.0 if prev and prev["students"] and p is not None else None
        statuses[st] = {"count": round(c),
                        "ratio": None if ratio is None else round(ratio, 1),
                        "prev_count": None if p is None else round(p),
                        "pct": _pct(c, p),
                        "ratio_prev": None if pratio is None else round(pratio, 1)}
    return jsonify({
        "available": True,
        "term": _term(t1, last_t), "prev_term": _term(t0, last_t),
        "steps": hz["kpi_steps"],
        "enrollment": {"all": seg("students"), "regular": seg("regular"), "irregular": seg("irregular")},
        "gwa": {"value": None if now["gwa"] is None else round(now["gwa"], 2),
                "prev": None if not prev or prev["gwa"] is None else round(prev["gwa"], 2),
                "pct": _pct(now["gwa"], (prev or {}).get("gwa"))},
        "completion": {"value": None if now["completion"] is None else round(now["completion"] * 100, 1),
                       "prev": None if not prev or prev["completion"] is None else round(prev["completion"] * 100, 1),
                       "pct": _pct(now["completion"], (prev or {}).get("completion"))},
        "statuses": statuses,
    })


def _line_groups(series, dept, course):
    """One line per department (All Colleges) / per course (a department picked) / one line (a course picked)."""
    if course:
        return [(course, series)]
    key = "course" if dept else "college"
    names = sorted({s[key] for s in series})
    return [(n, [s for s in series if s[key] == n]) for n in names]


def _line_response(cube, pick, series, dept, course, yl, extra):
    hz = cube["horizon"]
    last_t = hz["last_t"]
    steps = _horizon_steps(hz)
    with_hist = _flag("history", True)
    groups = _line_groups(series, dept, course)
    hist_ts = sorted({t for s in series for t in s["t"]}) if with_hist else []
    ts = hist_ts + list(range(last_t + 1, last_t + steps + 1))
    datasets = []
    for name, ss in groups:
        data = []
        for t in ts:
            a = _aggregate(cube, ss, t)
            v = None if a is None else pick(a)
            data.append(None if _bad(v) else v)
        datasets.append({"label": name, "data": data})
    return jsonify({
        "available": True, "steps": steps, "max_steps": hz["chart_steps"],
        "group_by": "course" if (dept or course) else "college",
        "labels": [_label(t) for t in ts],
        "predicted": [t > last_t for t in ts],
        "datasets": datasets, **extra,
    })


@pred_bp.route("/api/pred/at_risk")
def pred_at_risk():
    cube = _bundle("pred_cube.pkl")
    if cube is None:
        return _unavailable("No prediction model yet.")
    metric = request.args.get("metric", "FAILED").upper()
    metric = _ALIASES.get(metric, metric)
    if metric not in SUBJECT_STATUSES or metric not in cube["statuses"]:
        return jsonify({"available": False, "reason": f"Unknown metric {metric}"}), 400
    dept, course, yl = _filters()
    series = _select(cube["series"], dept, course, yl)
    return _line_response(cube, lambda a: round(a["counts"][metric]), series, dept, course, yl,
                          {"metric": metric})


@pred_bp.route("/api/pred/gwa_trend")
def pred_gwa_trend():
    cube = _bundle("pred_cube.pkl")
    if cube is None:
        return _unavailable("No prediction model yet.")
    dept, course, yl = _filters()
    series = _select(cube["series"], dept, course, yl)
    return _line_response(cube, lambda a: None if a["gwa"] is None else round(a["gwa"], 2),
                          series, dept, course, yl, {})


# ── Top Hardest Subjects ───────────────────────────────────────────────────

def _subject_pool(bundle, group, t):
    """Pool one (college, course, code) group's year-level series at term t.
    Only series actually offered in t's semester slot and still running take part."""
    last_t, t_ref = bundle["horizon"]["last_t"], bundle["t_ref"]
    n_tot, g_w, g_n = 0.0, 0.0, 0.0
    counts = {st: 0.0 for st in SUBJECT_STATUSES}
    for s in group:
        if t > last_t:
            if _sem(t) not in s["sems"] or s["last_t"] < last_t - 3:
                continue
        n = _value(s, "students", t, last_t, t_ref)
        if _bad(n) or n <= 0:
            continue
        n_tot += n
        for st in SUBJECT_STATUSES:
            r = _value(s, f"{st.lower()}_rate", t, last_t, t_ref)
            counts[st] += n * (0.0 if _bad(r) else r)
        g = _value(s, "avg_grade", t, last_t, t_ref)
        if not _bad(g):
            g_w += n * g
            g_n += n
    if n_tot <= 0:
        return None
    return {"students": n_tot, "counts": counts, "avg_grade": g_w / g_n if g_n else None}


@pred_bp.route("/api/pred/hardest")
def pred_hardest():
    b = _bundle("pred_subjects.pkl")
    if b is None:
        return _unavailable("No subject model yet — needs the long-form grades from at least 6 semesters.")
    hz = b["horizon"]
    last_t = hz["last_t"]
    steps = _horizon_steps(hz)
    metric = request.args.get("metric", "FAILED").upper()
    metric = _ALIASES.get(metric, metric)
    if metric not in SUBJECT_STATUSES:
        return jsonify({"available": False, "reason": f"Unknown metric {metric}"}), 400
    rank_by = request.args.get("rank_by", "rate")
    top = request.args.get("top", "10")
    subject = request.args.get("subject") or None
    with_hist = _flag("history", True)

    series = _select(b["series"], *_filters())
    groups = {}
    for s in series:
        groups.setdefault((s["college"], s["course"], s["code"]), []).append(s)

    options = {}
    for (col, course, code), g in groups.items():
        options.setdefault(code, g[0]["title"])

    # Bar chart + ranked cards: ONE semester ahead only (last_t + 1), compared with the subject's
    # most recent recorded offering. Subjects normally offered in the other semester slot are
    # therefore not listed. (Only the Grade Trend lines use the longer `horizon`.)
    t_next = last_t + 1
    items = []
    for (col, course, code), g in groups.items():
        if subject and code != subject:
            continue
        p = _subject_pool(b, g, t_next)
        if not p:
            continue
        n = p["students"]
        affected = p["counts"][metric]
        rate = affected / n * 100.0

        # last recorded offering of this subject (the newest term any of its series has)
        t_prev = max(s["t"][-1] for s in g if s["t"])
        q = _subject_pool(b, g, t_prev) if t_prev <= last_t else None
        prev = None
        if q:
            qn = q["students"]
            q_aff = q["counts"][metric]
            prev = {"term": _term(t_prev, last_t), "students": round(qn), "affected": round(q_aff),
                    "rate": round(q_aff / qn * 100.0, 1),
                    "avg_grade": None if q["avg_grade"] is None else round(q["avg_grade"], 2)}
        rate_r = round(rate, 1)
        grade_r = None if p["avg_grade"] is None else round(p["avg_grade"], 2)
        items.append({
            "code": code, "title": g[0]["title"], "college": col, "course": course,
            "term": _term(t_next, last_t), "students": round(n),
            "affected": round(affected), "rate": rate_r, "avg_grade": grade_r,
            "counts": {st: round(v) for st, v in p["counts"].items()},
            "prev": prev,
            "rate_change": None if not prev else round(rate_r - prev["rate"], 1),
            "grade_change": None if not prev or prev["avg_grade"] is None or grade_r is None
                            else round(grade_r - prev["avg_grade"], 2),
            "_g": g,
        })

    if rank_by == "grade":
        items.sort(key=lambda i: (-(i["avg_grade"] or 0), -i["rate"]))
    else:
        items.sort(key=lambda i: (-i["rate"], -i["students"]))
    if top != "all":
        try:
            items = items[:int(top)]
        except ValueError:
            items = items[:10]
    top_aff = max((i["affected"] for i in items), default=0)
    for r, i in enumerate(items, 1):
        i["rank"] = r
        i["saturation"] = round(i["affected"] / top_aff, 3) if top_aff else 0.0

    # multi-line: avg grade per term for the returned subjects
    line_ts = set()
    lines = []
    for i in items[:20]:
        pts = {}
        if with_hist:
            for t in sorted({t for s in i["_g"] for t in s["t"]}):
                p = _subject_pool(b, i["_g"], t)
                if p and p["avg_grade"] is not None:
                    pts[t] = round(p["avg_grade"], 2)
        for t in range(last_t + 1, last_t + steps + 1):
            p = _subject_pool(b, i["_g"], t)
            if p and p["avg_grade"] is not None:
                pts[t] = round(p["avg_grade"], 2)
        line_ts |= set(pts)
        lines.append((i, pts))
    ts = sorted(line_ts)
    for i in items:
        i.pop("_g", None)

    return jsonify({
        "available": True, "metric": metric, "rank_by": rank_by, "steps": steps,
        "target_term": _term(t_next, last_t),
        "max_steps": hz["chart_steps"], "count": len(items), "items": items,
        "options": sorted(({"code": c, "title": t} for c, t in options.items()),
                          key=lambda o: o["title"]),
        "lines": {"labels": [_label(t) for t in ts], "predicted": [t > last_t for t in ts],
                  "datasets": [{"label": f"{i['title']} — {i['course']}", "code": i["code"],
                                "data": [pts.get(t) for t in ts]} for i, pts in lines]},
    })