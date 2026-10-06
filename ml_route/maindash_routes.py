"""
maindash_routes.py — Flask API endpoints for the Main Dashboard (historical only).

Endpoints:
  GET /api/dash/meta               — years, departments, courses (for filter dropdowns)
  GET /api/dash/kpi                — KPI card data
  GET /api/dash/heatmap            — heatmap rows (course x year level)
  GET /api/dash/gender-status      — gender + status breakdown (year/sem/dept/course/yearlevel + enroll_type)
  GET /api/dash/hardest-subjects   — top hardest subjects (bar, cards, trend)

All endpoints accept the following common query params:
  year       — academic year numeric prefix e.g. "2022" → filters 2022-2023
  sem        — semester code: 1sem | 2sem | Summer
  dept       — department code e.g. CEA
  course     — course code
  yearlevel  — year level: 1-5 or IRREG

Hardest subjects also accepts:
  top_n      — 5 | 10 | 15 | 20 | all  (default 10)
  subject    — specific subject code filter
  sort       — asc | desc (default asc)
  status     — FAILED | INC | DRP | W | UDR (for heatmap metric)
  metric     — rate | count  (heatmap only: % of enrolled students with the status, or the number of students; default rate)
"""

from flask import Blueprint, request, jsonify
import pandas as pd
import numpy as np

from util.db_io import get_model_dataset

try:                                        # program name -> acronym, for chart labels only
    from .course_acronyms import course_short
except ImportError:                         # pragma: no cover
    from course_acronyms import course_short
# get_model_dataset(key) returns all semesters concatenated from model_datasets table.
# Each upload creates one row per (dataset_key, academic_year, semester).
# Filtering by AY/semester is done in _apply_filters() using the DataFrame columns.

maindash_bp = Blueprint('maindash_bp', __name__)


def _safe_float(val, ndigits=4):
    """Convert to float and round; return None for NaN/inf/None."""
    try:
        v = float(val)
        if v != v or v == float('inf') or v == float('-inf'):
            return None
        return round(v, ndigits)
    except (TypeError, ValueError):
        return None


def _safe_int(val):
    try:
        v = float(val)
        if v != v:
            return None
        return int(v)
    except (TypeError, ValueError):
        return None

# ── Shared filter helper ──────────────────────────────────────────────────

def _get_filters():
    a = request.args
    return {
        'year':       a.get('year', ''),
        'sem':        a.get('sem', ''),
        'dept':       a.get('dept', ''),
        'course':     a.get('course', ''),
        'yearlevel':  a.get('yearlevel', ''),
        # '' = default (vs immediately-previous recorded semester)
        # '1sem' / '2sem' = that semester this year vs the SAME semester last year
        'compare':    a.get('compare', ''),
    }


def _apply_filters(df: pd.DataFrame, f: dict) -> pd.DataFrame:
    """Apply common filter params to a DataFrame."""
    if f['year'] and 'Academic_Year' in df.columns:
        yr = str(f['year'])
        df = df[df['Academic_Year'].astype(str).str.startswith(yr)]
    if f['sem'] and 'Semester' in df.columns:
        # DS01 may store semester as '2sem'/'1sem' (raw from CSV) or
        # '1st Semester'/'2nd Semester' (normalized). Try both.
        sem_raw = f['sem']  # e.g. '1sem', '2sem', 'Summer'
        sem_label_map = {'1sem': '1st Semester', '2sem': '2nd Semester', 'Summer': 'Summer'}
        sem_label = sem_label_map.get(sem_raw, sem_raw)
        df = df[df['Semester'].isin([sem_raw, sem_label])]
    if f['dept'] and 'College' in df.columns:
        df = df[df['College'] == f['dept']]
    if f['course'] and 'Course' in df.columns:
        df = df[df['Course'] == f['course']]
    if f['yearlevel'] and 'Year_Level' in df.columns:
        _YL_REVERSE = {'1':'1st Year','2':'2nd Year','3':'3rd Year','4':'4th Year',
                       '5':'5th Year','IRREG':'Irregular','irreg':'Irregular'}
        yl_val = _YL_REVERSE.get(f['yearlevel'], f['yearlevel'])
        df = df[df['Year_Level'].astype(str).str.strip().str.lower() == yl_val.lower()]
    return df


def _sem_sort_key(row):
    """Sort key for Academic_Year + Semester chronologically."""
    ay = str(row.get('Academic_Year', '')).split('-')[0]
    sem = str(row.get('Semester', ''))
    sem_ord = {'1st Semester': 1, '2nd Semester': 2, 'Summer': 3}.get(sem, 9)
    return (ay, sem_ord)


def _format_ay(ay_str: str) -> str:
    """'2022' → '2022-2023', '2022-2023' → '2022-2023'"""
    if '-' in str(ay_str):
        return str(ay_str)
    try:
        yr = int(ay_str)
        return f"{yr}-{yr+1}"
    except (ValueError, TypeError):
        return str(ay_str)


# ── /api/dash/meta ────────────────────────────────────────────────────────

@maindash_bp.route('/api/dash/meta')
def api_dash_meta():
    """Return available years, departments, and courses for filter dropdowns."""
    try:
        ds01 = get_model_dataset('DS01')
        if ds01.empty:
            return jsonify({'years': [], 'departments': [], 'courses': []})

        # Collect all AY+semester combos, sorted chronologically
        ay_sem_pairs = []
        if 'Academic_Year' in ds01.columns and 'Semester' in ds01.columns:
            pairs = ds01[['Academic_Year','Semester']].dropna().drop_duplicates()
            ay_sem_pairs = sorted(
                [(str(r['Academic_Year']), str(r['Semester'])) for _, r in pairs.iterrows()],
                key=lambda x: (x[0], {'1st Semester':1,'1sem':1,'2nd Semester':2,'2sem':2,'Summer':3}.get(x[1],9))
            )

        # Most recent AY = last in sorted list; expose all AYs for the year filter
        all_years = sorted(set(str(ay).split('-')[0] for ay, _ in ay_sem_pairs), reverse=True)

        # Semesters available per AY (for frontend to cascade)
        ay_to_sems = {}
        for ay, sem in ay_sem_pairs:
            yr_key = str(ay).split('-')[0]
            ay_to_sems.setdefault(yr_key, [])
            if sem not in ay_to_sems[yr_key]:
                ay_to_sems[yr_key].append(sem)

        depts = sorted(ds01['College'].dropna().unique().tolist()) if 'College' in ds01 else []
        courses_raw = ds01[['College','Course']].dropna().drop_duplicates() if 'Course' in ds01 else pd.DataFrame()
        courses = [
            {'dept': r['College'], 'code': r['Course'], 'label': r['Course'], 'short': course_short(r['Course'])}
            for _, r in courses_raw.iterrows()
        ]

        return jsonify({
            'years':       all_years,
            'ay_to_sems':  ay_to_sems,
            'recent_year': all_years[0] if all_years else '',
            'recent_sem':  ay_to_sems.get(all_years[0], [''])[- 1] if all_years else '',
            'departments': depts,
            'courses':     courses,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── /api/dash/kpi ─────────────────────────────────────────────────────────

@maindash_bp.route('/api/dash/kpi')
def api_dash_kpi():
    """KPI card: enrollment, GWA, completion rate, status counts, year level breakdown."""
    try:
        f = _get_filters()
        ds01 = get_model_dataset('DS01')
        if ds01.empty:
            return jsonify({'error': 'No data'}), 404
        f = _resolve_compare_filters(ds01, f)

        df = _apply_filters(ds01, f)
        if df.empty:
            return jsonify({'total_enrollment': 0, 'avg_gwa': None})

        # Enrollment counts
        total = int(df['Student_ID'].nunique()) if 'Student_ID' in df.columns else len(df)

        # Use Is_Regular / Is_Irregular columns if present, else derive from Year_Level
        if 'Is_Regular' in df.columns and 'Is_Irregular' in df.columns:
            regular_count   = int(df['Is_Regular'].fillna(False).astype(bool).sum())
            irregular_count = int(df['Is_Irregular'].fillna(False).astype(bool).sum())
        else:
            _YL_MAP2 = {'1st year':'1','2nd year':'2','3rd year':'3','4th year':'4','1':'1','2':'2','3':'3','4':'4'}
            is_irreg = df['Year_Level'].astype(str).str.lower().apply(
                lambda x: 'irreg' in x or 'irregular' in x) if 'Year_Level' in df.columns else pd.Series([False]*len(df))
            regular_count   = int((~is_irreg).sum())
            irregular_count = int(is_irreg.sum())

        # GWA
        avg_gwa = _safe_float(df['GWA'].dropna().mean(), 4) if 'GWA' in df.columns else None

        # Completion rate — compute from Units_Earned / Units_Enrolled_Reported if available,
        # otherwise use the Completion_Rate column directly
        avg_comp = None
        if 'Units_Earned' in df.columns and 'Units_Enrolled_Reported' in df.columns:
            valid = df[(df['Units_Enrolled_Reported'].notna()) & (df['Units_Enrolled_Reported'] > 0) &
                       (df['Units_Earned'].notna())]
            if not valid.empty:
                cr_vals = (valid['Units_Earned'] / valid['Units_Enrolled_Reported'] * 100)
                avg_comp = _safe_float(cr_vals.mean(), 2)
        if avg_comp is None and 'Completion_Rate' in df.columns:
            avg_comp = _safe_float(df['Completion_Rate'].dropna().mean(), 2)
        # Fallback 1: status count columns
        if avg_comp is None:
            _sc = [c for c in ['INC_Count','DRP_Count','Failed_Count','UDR_Count','W_Count']
                   if c in df.columns]
            if _sc:
                _total = len(df)
                _at_risk = (df[_sc].fillna(0).sum(axis=1) > 0).sum()
                if _total > 0:
                    avg_comp = _safe_float((_total - _at_risk) / _total * 100, 2)
        # Fallback 2: At_Risk_Ratio (most reliable — always present in DS01)
        if avg_comp is None and 'At_Risk_Ratio' in df.columns:
            avg_comp = _safe_float((1 - df['At_Risk_Ratio'].fillna(0)).mean() * 100, 2)

        # Status counts
        status_cols = {
            'FAILED': 'Failed_Count', 'DRP': 'DRP_Count',
            'INC': 'INC_Count', 'UDR': 'UDR_Count',
            'W': 'W_Count', 'NGA': 'NGA_Count',
        }
        status_counts = {}
        for status, col in status_cols.items():
            if col in df.columns:
                status_counts[status] = int(df[col].fillna(0).sum())

        # Year level breakdown (1st-4th + IRREG only, no 5th year)
        _YL_MAP = {
            '1st year':'1','2nd year':'2','3rd year':'3','4th year':'4',
            '1':'1','2':'2','3':'3','4':'4',
            'irregular':'IRREG','irreg':'IRREG','5th year':'5','5':'5',
        }
        VALID_YL = {'1', '2', '3', '4', 'IRREG'}
        year_level_counts = {}
        if 'Year_Level' in df.columns:
            for yl, grp in df.groupby('Year_Level'):
                yl_str = _YL_MAP.get(str(yl).strip().lower(), None)
                if yl_str and yl_str in VALID_YL:
                    cnt = grp['Student_ID'].nunique() if 'Student_ID' in df.columns else len(grp)
                    year_level_counts[yl_str] = year_level_counts.get(yl_str, 0) + cnt

        # Delta vs previous semester (best-effort)
        enrollment_delta, enrollment_pct_change = _compute_enrollment_delta(ds01, f)
        gwa_delta             = _compute_gwa_delta(ds01, f)
        completion_delta, completion_pct_change = _compute_completion_delta(ds01, f)

        # Percentage change vs previous semester (or same-semester-last-year, per f['compare'])
        gwa_pct_change = None
        try:
            prev_df = _prev_df_for_compare(ds01, f)
            if not prev_df.empty and avg_gwa is not None and 'GWA' in prev_df.columns:
                prev_gwa = _safe_float(prev_df['GWA'].dropna().mean())
                if prev_gwa and prev_gwa != 0:
                    gwa_pct_change = _safe_float((avg_gwa - prev_gwa) / prev_gwa * 100, 1)
        except Exception:
            pass

        return jsonify({
            'total_enrollment':  total,
            'regular_count':     regular_count,
            'irregular_count':   irregular_count,
            'avg_gwa':           avg_gwa,
            'avg_completion':    avg_comp,
            'status_counts':     status_counts,
            'year_level_counts': year_level_counts,
            'enrollment_delta':       enrollment_delta,
            'enrollment_pct_change':  enrollment_pct_change,
            'gwa_delta':              gwa_delta,
            'completion_delta':       completion_delta,
            'gwa_pct_change':         gwa_pct_change,
            'completion_pct_change':  completion_pct_change,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _prev_semester_df(ds01: pd.DataFrame, f: dict) -> pd.DataFrame:
    """Return rows for the semester immediately before the current filter."""
    if not f['year'] or not f['sem']:
        return pd.DataFrame()
    _SEM_PREV = {
        '1sem':         ('Summer', int(f['year']) - 1),
        '2sem':         ('1sem',   int(f['year'])),
        'Summer':       ('2sem',   int(f['year'])),
        '1st Semester': ('Summer', int(f['year']) - 1),
        '2nd Semester': ('1sem',   int(f['year'])),
    }
    _SEM_ALIASES = {
        '1sem':   ['1sem', '1st Semester', '1st sem', '1'],
        '2sem':   ['2sem', '2nd Semester', '2nd sem', '2'],
        'Summer': ['Summer', 'summer', 'Sum'],
    }
    prev = _SEM_PREV.get(f['sem'])
    if not prev:
        return pd.DataFrame()
    prev_sem_key, prev_yr = prev
    accept = _SEM_ALIASES.get(prev_sem_key, [prev_sem_key])
    prev_df = ds01[
        ds01['Academic_Year'].astype(str).str.startswith(str(prev_yr)) &
        ds01['Semester'].isin(accept)
    ]
    if f.get('dept') and 'College' in prev_df.columns:
        prev_df = prev_df[prev_df['College'] == f['dept']]
    if f.get('course') and 'Course' in prev_df.columns:
        prev_df = prev_df[prev_df['Course'] == f['course']]
    return prev_df


def _compute_completion_from_df(df: pd.DataFrame):
    """Compute avg completion rate from a filtered df."""
    if 'Units_Earned' in df.columns and 'Units_Enrolled_Reported' in df.columns:
        valid = df[(df['Units_Enrolled_Reported'].notna()) & (df['Units_Enrolled_Reported'] > 0) & df['Units_Earned'].notna()]
        if not valid.empty:
            return _safe_float((valid['Units_Earned'] / valid['Units_Enrolled_Reported'] * 100).mean(), 2)
    if 'Completion_Rate' in df.columns:
        return _safe_float(df['Completion_Rate'].dropna().mean(), 2)
    return None


def _compute_enrollment_delta(ds01, f):
    """Returns (delta_count, pct_change) tuple."""
    try:
        cur  = _apply_filters(ds01, f)
        prev = _prev_df_for_compare(ds01, f)
        if cur.empty or prev.empty:
            return None, None
        c = cur['Student_ID'].nunique() if 'Student_ID' in cur.columns else len(cur)
        p = prev['Student_ID'].nunique() if 'Student_ID' in prev.columns else len(prev)
        delta = int(c - p)
        pct   = _safe_float(delta / p * 100, 1) if p > 0 else None
        return delta, pct
    except Exception:
        return None, None


def _compute_gwa_delta(ds01, f):
    try:
        if 'GWA' not in ds01.columns:
            return None
        cur  = _apply_filters(ds01, f)
        prev = _prev_df_for_compare(ds01, f)
        if cur.empty or prev.empty:
            return None
        return _safe_float(cur['GWA'].dropna().mean() - prev['GWA'].dropna().mean(), 4)
    except Exception:
        return None


def _compute_completion_delta(ds01, f):
    """Returns (delta, pct_change) using _compute_completion_from_df with At_Risk fallback."""
    try:
        cur  = _apply_filters(ds01, f)
        prev = _prev_df_for_compare(ds01, f)
        if cur.empty or prev.empty:
            return None, None
        cur_comp  = _compute_completion_from_df(cur)
        prev_comp = _compute_completion_from_df(prev)
        if cur_comp is None or prev_comp is None:
            return None, None
        delta = _safe_float(cur_comp - prev_comp, 2)
        pct   = _safe_float((cur_comp - prev_comp) / prev_comp * 100, 1) if prev_comp else None
        return delta, pct
    except Exception:
        return None, None


# ── Shared grouping for the two trend charts below ──────────────────────
# Same convention as the Heatmap: no dept filter -> one line per College;
# dept filter set -> one line per Course. Mirrors the prediction side's
# _line_groups()/_line_response() so both dashboards group lines the same way.

_TREND_SEM_ORDER = {'1st Semester': 1, '1sem': 1, '2nd Semester': 2, '2sem': 2, 'Summer': 3}
_TREND_SEM_SHORT = {'1sem': '1st Sem', '2sem': '2nd Sem'}


def _trend_periods(df):
    """Sorted [(academic_year, semester), ...] across the whole df, plus their display labels."""
    periods = df[['Academic_Year', 'Semester']].dropna().drop_duplicates()
    periods = sorted(
        [(str(r['Academic_Year']), str(r['Semester'])) for _, r in periods.iterrows()],
        key=lambda x: (x[0].split('-')[0], _TREND_SEM_ORDER.get(x[1], 9))
    )
    labels = [f'{_format_ay(ay)} {_TREND_SEM_SHORT.get(sem, sem)}' for ay, sem in periods]
    return periods, labels


def _trend_groups(df, f):
    """[(group_name, group_df), ...] — one per College, or per Course if a dept filter is active."""
    dept_filter = f.get('dept') or ''
    if dept_filter and 'Course' in df.columns:
        group_col = 'Course'
    elif 'College' in df.columns:
        group_col = 'College'
    else:
        group_col = 'Course' if 'Course' in df.columns else None

    if not group_col:
        return [('All', df)], 'college'
    names = sorted(df[group_col].dropna().unique().tolist())
    return [(name, df[df[group_col] == name]) for name in names], ('course' if group_col == 'Course' else 'college')


def _filter_compare_sem(df, compare):
    """
    '' (Default)   -> every period, unfiltered (1st and 2nd semester alike)
    '1sem'/'2sem'  -> keep only that semester type, so the trend becomes a
                      clean year-over-year comparison for that one semester
                      instead of alternating 1st/2nd semester points.
    """
    if compare not in ('1sem', '2sem'):
        return df
    want = _TREND_SEM_ORDER.get(compare)
    sem_ord = df['Semester'].astype(str).map(_TREND_SEM_ORDER)
    return df[sem_ord == want]


def _trend_response(df, f, value_fn, extra):
    """
    Builds the {labels, group_by, datasets} response shared by kpi-trend and
    enrollment-trend: one dataset per group (College/Course), one point per
    recorded period, value_fn(period_slice_df) picks the single metric.
    """
    periods, labels = _trend_periods(df)
    groups, group_by = _trend_groups(df, f)
    datasets = []
    for name, gdf in groups:
        data = []
        for ay, sem in periods:
            pdf = gdf[(gdf['Academic_Year'].astype(str) == ay) & (gdf['Semester'].astype(str) == sem)]
            data.append(value_fn(pdf) if len(pdf) else None)
        if any(v is not None for v in data):
            datasets.append({'label': name, 'data': data})
    return jsonify({
        'labels': labels, 'group_by': group_by, 'datasets': datasets,
        'scope': {'dept': f.get('dept') or '', 'course': f.get('course') or '', 'yearlevel': f.get('yearlevel') or ''},
        **extra,
    })


# ── /api/dash/kpi-trend ───────────────────────────────────────────────────

_TREND_STATUS_COLS = {
    'FAILED': 'Failed_Count', 'DRP': 'DRP_Count', 'INC': 'INC_Count',
    'UDR': 'UDR_Count', 'W': 'W_Count', 'NGA': 'NGA_Count',
}

@maindash_bp.route('/api/dash/kpi-trend')
def api_dash_kpi_trend():
    """
    Per-college/course trend version of the KPI card's Status Breakdown:
    pick ONE status (?metric=, default FAILED) and show it broken down by
    College (or by Course if a dept filter is active) across every recorded
    semester — year/sem filters are ignored on purpose, since spanning every
    period is the whole point of a trend chart. Same grouping convention as
    the Heatmap, and the prediction-side counterpart of this endpoint.
    """
    try:
        f = _get_filters()
        metric = (request.args.get('metric') or 'FAILED').upper()
        if metric not in _TREND_STATUS_COLS:
            metric = 'FAILED'
        col = _TREND_STATUS_COLS[metric]

        ds01 = get_model_dataset('DS01')
        if ds01.empty or 'Academic_Year' not in ds01.columns or 'Semester' not in ds01.columns:
            return jsonify({'labels': [], 'datasets': [], 'metric': metric})

        compare = request.args.get('compare') or ''
        f_scope = dict(f, year='', sem='')   # trend spans every period
        df = _apply_filters(ds01, f_scope)
        df = _filter_compare_sem(df, compare)
        if df.empty or col not in df.columns:
            return jsonify({'labels': [], 'datasets': [], 'metric': metric, 'compare': compare})

        return _trend_response(df, f, lambda pdf: int(pdf[col].fillna(0).sum()), {'metric': metric, 'compare': compare})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── /api/dash/enrollment-trend ───────────────────────────────────────────

@maindash_bp.route('/api/dash/enrollment-trend')
def api_dash_enrollment_trend():
    """
    Per-college/course trend version of the KPI card's Total Enrollment:
    pick ONE of All / Regular / Irregular (?metric=, default 'all') and show
    it broken down by College (or Course if a dept filter is active) across
    every recorded semester. Separate card from KPI Trend's Status
    Breakdown; same grouping convention as the Heatmap and as KPI Trend.
    """
    try:
        f = _get_filters()
        metric = (request.args.get('metric') or 'all').lower()
        if metric not in ('all', 'regular', 'irregular'):
            metric = 'all'

        ds01 = get_model_dataset('DS01')
        if ds01.empty or 'Academic_Year' not in ds01.columns or 'Semester' not in ds01.columns:
            return jsonify({'labels': [], 'datasets': [], 'metric': metric})

        compare = request.args.get('compare') or ''
        f_scope = dict(f, year='', sem='')   # trend spans every period
        df = _apply_filters(ds01, f_scope)
        df = _filter_compare_sem(df, compare)
        if df.empty:
            return jsonify({'labels': [], 'datasets': [], 'metric': metric, 'compare': compare})

        def value_fn(pdf):
            if metric == 'all':
                return int(pdf['Student_ID'].nunique()) if 'Student_ID' in pdf.columns else len(pdf)
            col = 'Is_Regular' if metric == 'regular' else 'Is_Irregular'
            if col not in pdf.columns:
                return None
            return int(pdf[col].fillna(False).astype(bool).sum())

        return _trend_response(df, f, value_fn, {'metric': metric, 'compare': compare})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── /api/dash/heatmap ─────────────────────────────────────────────────────

# DS01 (one row per student per semester) carries a per-status subject count column.
_HEATMAP_COUNT_COLS = {
    'FAILED': 'Failed_Count', 'INC': 'INC_Count', 'DRP': 'DRP_Count',
    'W': 'W_Count', 'UDR': 'UDR_Count',
}


def _yl_sort_key(y):
    """Order year levels 1st..5th then Irregular, whatever the label style ('1', '1st Year', 'IRREG', 'Irregular')."""
    s = str(y).strip().lower()
    if 'irreg' in s:
        return 6
    for n in range(1, 6):
        if s.startswith(str(n)):
            return n
    return 9


def _heatmap_from_students(f, status, sort, metric):
    """
    Histogram built from DS01.
    - No dept filter  → group by College  (one bar group per college)
    - Dept filter set → group by Course   (one bar group per course program)

    Each bar group has one bar per year level (1st, 2nd, 3rd, 4th, Irreg).
    Value = % of enrolled students with the status (or count).
    """
    col = _HEATMAP_COUNT_COLS.get(status)
    ds01 = get_model_dataset('DS01')
    empty = {'rows': [], 'year_levels': [], 'metric': metric, 'basis': 'students', 'view': 'college'}
    if ds01.empty:
        return {**empty, 'note': 'No student data (DS01) has been uploaded yet.'}
    if col is None:
        return {**empty, 'note': f"Unknown status '{status}'."}
    if col not in ds01.columns:
        return {**empty, 'note': f"DS01 has no '{col}' column, so {status} can't be computed."}
    if 'Year_Level' not in ds01.columns:
        return {**empty, 'note': "DS01 has no 'Year_Level' column."}

    df = _apply_filters(ds01, f)
    df = df[df['Year_Level'].notna()]
    if df.empty:
        return empty

    # Decide grouping level based on whether a dept filter is active
    dept_filter = f.get('dept') or f.get('department') or ''
    if dept_filter and 'Course' in df.columns:
        group_col = 'Course'
        view = 'course'
    elif 'College' in df.columns:
        group_col = 'College'
        view = 'college'
    else:
        group_col = 'Course' if 'Course' in df.columns else None
        view = 'course'

    if not group_col:
        return {**empty, 'note': 'DS01 has no College or Course column.'}

    df = df[df[group_col].notna()]
    if df.empty:
        return empty

    keys = [group_col, 'Year_Level']
    hit_df = df[df[col].fillna(0) > 0]
    if 'Student_ID' in df.columns:
        enrolled = df.groupby(keys)['Student_ID'].nunique()
        with_st  = hit_df.groupby(keys)['Student_ID'].nunique()
    else:
        enrolled = df.groupby(keys).size()
        with_st  = hit_df.groupby(keys).size()
    with_st = with_st.reindex(enrolled.index, fill_value=0)

    def _wide(series):
        w = series.unstack('Year_Level')
        w.columns = [str(c) for c in w.columns]
        return w

    enrolled_w, with_w = _wide(enrolled), _wide(with_st)
    year_levels = sorted(
        [c for c in enrolled_w.columns if c.upper() not in ('NAN', '')],
        key=_yl_sort_key
    )
    enrolled_w = enrolled_w.reindex(columns=year_levels, fill_value=0)
    with_w     = with_w.reindex(columns=year_levels, fill_value=0)

    if metric == 'count':
        values = with_w
    else:
        values = (with_w / enrolled_w.where(enrolled_w > 0) * 100).round(2)

    # Sort by total across all year levels
    totals = values.fillna(0).sum(axis=1).sort_values(ascending=(sort == 'asc'), kind='stable')
    values, enrolled_w, with_w = (
        values.loc[totals.index],
        enrolled_w.loc[totals.index],
        with_w.loc[totals.index],
    )

    rows = []
    for label in values.index:
        entry = {'label': label, 'enrolled': {}, 'with_status': {}}
        for yl in year_levels:
            v = values.at[label, yl]
            n = enrolled_w.at[label, yl]
            k = with_w.at[label, yl]
            entry[yl] = None if pd.isna(v) else (int(v) if metric == 'count' else float(v))
            entry['enrolled'][yl]    = None if pd.isna(n) else int(n)
            entry['with_status'][yl] = None if pd.isna(k) else int(k)
        rows.append(entry)

    max_val = _safe_float(values.max().max()) or 1.0
    return {
        'rows':        rows,
        'year_levels': year_levels,
        'max_val':     max_val,
        'metric':      metric,
        'basis':       'students',
        'view':        view,
    }



# ── Compare helpers ────────────────────────────────────────────────────────────

def _same_sem_prev_year_df(ds01, f):
    """
    Rows for the SAME semester but in the previous academic year.
    e.g. filters = 2024-2025, 1st Sem → returns 2023-2024, 1st Sem.
    Returns (df | None, label | None).
    """
    if not f.get('year') or not f.get('sem') or 'Academic_Year' not in ds01.columns:
        return None, None
    try:
        cur_ay = int(str(f['year']).split('-')[0])
    except ValueError:
        return None, None

    prev_ay     = cur_ay - 1
    prev_ay_str = f'{prev_ay}-{prev_ay + 1}'
    ay          = pd.to_numeric(ds01['Academic_Year'].astype(str).str.split('-').str[0], errors='coerce')
    mask        = ay == prev_ay
    if not mask.any():
        return None, None

    prev_f = dict(f, year=prev_ay_str)   # same sem, previous year
    prev   = _apply_filters(ds01[mask], prev_f)
    if prev.empty:
        return None, None
    label = f'{prev_ay_str} {_SEM_ORD_LABEL.get(_SEM_ORD_MAP.get(str(f["sem"]).strip().lower(), 0), f["sem"])}'.strip()
    return prev, label


def _heatmap_compare(f, status, metric, compare_mode):
    """
    Build current + previous histogram data and return delta rows.
    compare_mode: 'prev_sem' | 'same_sem'
    Returns the same shape as _heatmap_from_students but with extra fields:
      row[yl]         = current value
      row['prev'][yl] = previous value
      row['delta'][yl]= current - previous  (positive = worse, negative = better)
      top-level 'prev_period' label
    """
    ds01 = get_model_dataset('DS01')
    empty = {'rows':[], 'year_levels':[], 'metric':metric, 'basis':'students',
             'view':'college', 'compare':compare_mode}

    if ds01.empty:
        return {**empty, 'note':'No student data (DS01) has been uploaded yet.'}

    col = _HEATMAP_COUNT_COLS.get(status)
    if col is None or col not in ds01.columns:
        return {**empty, 'note': f"Status '{status}' not available for comparison."}

    # Current period
    df_cur = _apply_filters(ds01, f)

    # Previous period
    if compare_mode == 'same_sem':
        df_prev, prev_label = _same_sem_prev_year_df(ds01, f)
    else:
        df_prev, prev_label = _previous_period_df(ds01, f)

    if df_prev is None:
        return {**empty, 'note': 'No previous period data found for comparison.'}

    dept_filter = f.get('dept') or f.get('department') or ''
    group_col = 'Course' if (dept_filter and 'Course' in ds01.columns) else \
                ('College' if 'College' in ds01.columns else None)
    view = 'course' if group_col == 'Course' else 'college'
    if not group_col:
        return {**empty, 'note':'No College/Course column in DS01.'}

    def _compute(df):
        df = df[df.get('Year_Level', pd.Series(dtype=str)).notna() if 'Year_Level' in df.columns else df.index]
        if 'Year_Level' not in df.columns or df.empty:
            return pd.DataFrame(), pd.DataFrame()
        df = df[df[group_col].notna() & df['Year_Level'].notna()]
        keys = [group_col, 'Year_Level']
        hit  = df[df[col].fillna(0) > 0]
        if 'Student_ID' in df.columns:
            enrolled = df.groupby(keys)['Student_ID'].nunique()
            with_st  = hit.groupby(keys)['Student_ID'].nunique()
        else:
            enrolled = df.groupby(keys).size()
            with_st  = hit.groupby(keys).size()
        with_st = with_st.reindex(enrolled.index, fill_value=0)
        def _wide(s):
            w = s.unstack('Year_Level')
            w.columns = [str(c) for c in w.columns]
            return w
        ew, ww = _wide(enrolled), _wide(with_st)
        if metric == 'count':
            return ww, ew
        return (ww / ew.where(ew > 0) * 100).round(2), ew

    val_cur,  enr_cur  = _compute(df_cur)
    val_prev, enr_prev = _compute(df_prev)

    if val_cur.empty:
        return {**empty, 'note':'No data for selected period.'}

    all_yls = sorted(
        set(val_cur.columns.tolist()) | set(val_prev.columns.tolist()),
        key=_yl_sort_key
    )
    year_levels = [y for y in all_yls if y.upper() not in ('NAN', '')]

    val_cur  = val_cur.reindex(columns=year_levels, fill_value=0)
    val_prev = val_prev.reindex(index=val_cur.index, columns=year_levels, fill_value=0)

    rows = []
    for label in val_cur.index:
        entry = {'label': label, 'prev': {}, 'delta': {}}
        for yl in year_levels:
            c = val_cur.at[label, yl]  if label in val_cur.index  else None
            p = val_prev.at[label, yl] if label in val_prev.index else None
            entry[yl]          = None if (c is None or (isinstance(c, float) and pd.isna(c))) else (int(c) if metric=='count' else float(c))
            entry['prev'][yl]  = None if (p is None or (isinstance(p, float) and pd.isna(p))) else (int(p) if metric=='count' else float(p))
            entry['delta'][yl] = None if entry[yl] is None or entry['prev'][yl] is None else round(entry[yl] - entry['prev'][yl], 2)
        rows.append(entry)

    rows.sort(key=lambda r: sum(v for v in r['delta'].values() if v is not None), reverse=False)
    max_val = max((abs(r['delta'][yl]) for r in rows for yl in year_levels if r['delta'].get(yl) is not None), default=1.0)

    return {
        'rows':        rows,
        'year_levels': year_levels,
        'max_val':     float(max_val),
        'metric':      metric,
        'basis':       'students',
        'view':        view,
        'compare':     compare_mode,
        'prev_period': prev_label,
    }


# ── Previous-period lookup (used by the performance leaderboard) ───────────────
_SEM_ORD_MAP = {'1sem': 1, '1st semester': 1, '1st sem': 1,
                '2sem': 2, '2nd semester': 2, '2nd sem': 2,
                'summer': 3}
_SEM_ORD_LABEL = {1: '1st Semester', 2: '2nd Semester', 3: 'Summer'}


def _resolve_compare_filters(ds01, f):
    """
    When Comparison is '1sem' or '2sem', the CURRENT side must also be pinned to
    that one semester — otherwise, if no Term is separately selected, "current"
    silently stays "all terms combined" while "previous" is only one semester,
    which makes current look like it has way more students than it should.

    If no Academic Year is separately selected, use the most recent year that
    actually has data for that semester.
    """
    compare = f.get('compare') or ''
    if compare not in ('1sem', '2sem'):
        return f
    f2 = dict(f, sem=compare)
    if not f2.get('year') and {'Academic_Year', 'Semester'} <= set(ds01.columns):
        want = _SEM_ORD_MAP[compare]
        sem_ord = ds01['Semester'].astype(str).str.strip().str.lower().map(_SEM_ORD_MAP)
        years = pd.to_numeric(
            ds01.loc[sem_ord == want, 'Academic_Year'].astype(str).str.split('-').str[0], errors='coerce'
        ).dropna()
        if not years.empty:
            f2['year'] = str(int(years.max()))
    return f2


def _prev_df_for_compare(ds01, f):
    """
    The previous-period DataFrame to diff against, chosen by f['compare']:
      ''            -> immediately previous recorded semester (existing default)
      '1sem'/'2sem' -> the SAME semester, previous academic year
    Always returns just a DataFrame (never the (df, label) tuple), for drop-in
    use wherever _prev_semester_df(ds01, f) used to be called directly.
    """
    if f.get('compare') in ('1sem', '2sem'):
        df, _label = _same_sem_prev_year_df(ds01, f)
        return df if df is not None else pd.DataFrame()
    return _prev_semester_df(ds01, f)


def _previous_period_df(ds01, f):
    """
    Rows for the period just before the one selected in the filters, with the SAME
    dept / course / year-level filters applied.  Returns (df | None, label | None).

      year + sem picked -> the closest EARLIER semester that actually exists in the data
                           (so a missing Summer term is skipped instead of giving no comparison)
      year only         -> the closest earlier academic year
      no year           -> no comparison
    """
    if not f.get('year') or 'Academic_Year' not in ds01.columns:
        return None, None
    try:
        cur_ay = int(str(f['year']).split('-')[0])
    except ValueError:
        return None, None

    ay = pd.to_numeric(ds01['Academic_Year'].astype(str).str.split('-').str[0], errors='coerce')
    has_sem = 'Semester' in ds01.columns
    so = (ds01['Semester'].astype(str).str.strip().str.lower().map(_SEM_ORD_MAP)
          if has_sem else pd.Series(np.nan, index=ds01.index))
    periods = pd.DataFrame({'ay': ay, 'so': so}).dropna(subset=['ay'])

    if f.get('sem') and has_sem:
        cur_so = _SEM_ORD_MAP.get(str(f['sem']).strip().lower())
        if cur_so is None:
            return None, None
        pairs = periods.dropna(subset=['so']).drop_duplicates()
        earlier = pairs[(pairs['ay'] < cur_ay) | ((pairs['ay'] == cur_ay) & (pairs['so'] < cur_so))]
        if earlier.empty:
            return None, None
        p = earlier.sort_values(['ay', 'so']).iloc[-1]
        mask = (ay == p['ay']) & (so == p['so'])
        label = f"{_format_ay(str(int(p['ay'])))} {_SEM_ORD_LABEL.get(int(p['so']), '')}".strip()
    else:
        earlier_years = sorted(a for a in periods['ay'].unique() if a < cur_ay)
        if not earlier_years:
            return None, None
        pa = earlier_years[-1]
        mask = ay == pa
        label = _format_ay(str(int(pa)))

    prev = _apply_filters(ds01[mask], dict(f, year='', sem=''))
    return (prev if not prev.empty else None), label


# ── /api/dash/performance ─────────────────────────────────────────────────────
@maindash_bp.route('/api/dash/performance')
def api_dash_performance():
    """
    Leaderboard + Radar.
    No dept → rows = Colleges,  radar = all colleges + campus average.
    Dept set → rows = Courses,  radar = courses in that college + college average.
    Radar = ONE polygon: campus average (no dept) / that college (dept) / that course (course).
    Five axes (0–100, higher = better):
      avg_gwa_score  : (5 - GWA) / 4 * 100
      passing_rate   : % students with GWA <= 3.00
      completion_rate: mean Completion_Rate
      retention_rate : % students with 0 DRP/W/UDR
      regular_ratio  : % Is_Regular
    """
    try:
        f          = _get_filters()
        rank_by    = request.args.get('rank_by', 'avg_gwa_score')
        min_enroll = int(request.args.get('min_enrollment', 30))

        ds01 = get_model_dataset('DS01')
        if ds01 is None or ds01.empty:
            return jsonify({'rows': [], 'radar': [], 'average': None, 'view': 'college',
                            'note': 'No student data has been uploaded yet.'})
        f = _resolve_compare_filters(ds01, f)

        # A picked course does NOT shrink the leaderboard (its sibling courses stay listed so it can
        # be compared); it only decides what the radar shows.  A course implies its college.
        course_sel = f.get('course') or ''
        f = dict(f, course='')
        if course_sel and not f.get('dept') and {'Course', 'College'} <= set(ds01.columns):
            hit = ds01.loc[ds01['Course'] == course_sel, 'College'].dropna()
            if not hit.empty:
                f['dept'] = str(hit.iloc[0])

        df = _apply_filters(ds01, f)
        if df.empty:
            return jsonify({'rows': [], 'radar': [], 'average': None, 'view': 'college'})

        dept_filter = f.get('dept') or ''
        if dept_filter and 'Course' in df.columns:
            group_col, view = 'Course', 'course'
        elif 'College' in df.columns:
            group_col, view = 'College', 'college'
        else:
            return jsonify({'rows': [], 'average': None, 'view': 'college',
                            'note': 'DS01 has no College or Course column.'})

        df = df[df[group_col].notna()]
        if df.empty:
            return jsonify({'rows': [], 'average': None, 'view': view})

        METRICS = ('avg_gwa_score','passing_rate','completion_rate','retention_rate','regular_ratio')
        VALID_RANK = set(METRICS)
        if rank_by not in VALID_RANK:
            rank_by = 'avg_gwa_score'

        def _compute(g):
            n         = len(g)
            gwa_vals  = g['GWA'].dropna() if 'GWA' in g.columns else pd.Series([], dtype=float)
            avg_gwa   = float(gwa_vals.mean()) if not gwa_vals.empty else None
            gwa_score = round((5.0 - avg_gwa) / 4.0 * 100, 1) if avg_gwa is not None else None
            passing_n = int((gwa_vals <= 3.0).sum()) if not gwa_vals.empty else None
            passing   = round(passing_n / len(gwa_vals) * 100, 1) if passing_n is not None else None
            comp_vals = g['Completion_Rate'].dropna() if 'Completion_Rate' in g.columns else pd.Series([], dtype=float)
            completion     = round(float(comp_vals.mean()), 1) if not comp_vals.empty else None
            completion_n   = int((comp_vals >= 100).sum()) if not comp_vals.empty else None
            if all(c in g.columns for c in ['DRP_Count','W_Count','UDR_Count']):
                no_drop    = ((g['DRP_Count'].fillna(0) + g['W_Count'].fillna(0) + g['UDR_Count'].fillna(0)) == 0)
                retention  = round(float(no_drop.sum()) / n * 100, 1)
                retention_n = int(no_drop.sum())
            else:
                retention = None; retention_n = None
            is_reg     = g['Is_Regular'].fillna(False).astype(bool) if 'Is_Regular' in g.columns else pd.Series([False]*n)
            regular    = round(is_reg.sum() / n * 100, 1)
            regular_n  = int(is_reg.sum())
            return {
                'avg_gwa':        round(avg_gwa, 2) if avg_gwa is not None else None,
                'avg_gwa_score':  gwa_score,
                'passing_rate':   passing,    'passing_count':    passing_n,
                'completion_rate':completion, 'completion_count': completion_n,
                'retention_rate': retention,  'retention_count':  retention_n,
                'regular_ratio':  regular,    'regular_count':    regular_n,
            }

        # Previous period (same filters) so the leaderboard can show up / down arrows —
        # same semester last year when f['compare'] is '1sem'/'2sem', otherwise the
        # immediately-previous recorded semester (the existing default).
        if f.get('compare') in ('1sem', '2sem'):
            prev_df, prev_label = _same_sem_prev_year_df(ds01, f)
        else:
            prev_df, prev_label = _previous_period_df(ds01, f)
        prev_map = {}
        if prev_df is not None and group_col in prev_df.columns:
            for plabel, pg in prev_df[prev_df[group_col].notna()].groupby(group_col):
                prev_map[str(plabel)] = {'enrollment': len(pg), **_compute(pg)}

        rows = []
        for label, g in df.groupby(group_col):
            m = _compute(g)
            rows.append({'label': str(label), 'enrollment': len(g),
                         'low_n': len(g) < min_enroll,
                         'prev': prev_map.get(str(label)), **m})

        rows.sort(key=lambda r: (r[rank_by] is None, -(r[rank_by] or 0)))

        # Average row for the dashed radar line
        avg_label = 'Campus Average' if view == 'college' else f'{dept_filter} Average'
        avg_m = _compute(df)
        avg_row = {'label': avg_label, 'enrollment': len(df), 'low_n': False,
                   'is_average': True,
                   'prev': ({'enrollment': len(prev_df), **_compute(prev_df)} if prev_df is not None else None),
                   **avg_m}

        # Radar shows exactly ONE polygon, matching how far the filters are narrowed:
        #   no dept            -> the whole campus (one combined average)
        #   dept               -> that college only
        #   dept + course      -> that course only
        if course_sel and 'Course' in df.columns:
            cdf = df[df['Course'] == course_sel]
            radar = ([{'label': course_sel, 'enrollment': len(cdf), 'low_n': len(cdf) < min_enroll,
                       **_compute(cdf)}] if not cdf.empty else [])
            radar_scope = 'course'
        elif dept_filter:
            radar = [{'label': dept_filter, 'enrollment': len(df), 'low_n': len(df) < min_enroll, **avg_m}]
            radar_scope = 'college'
        else:
            radar = [avg_row]
            radar_scope = 'campus'

        return jsonify({
            'rows':    rows,
            'average': avg_row,
            'radar':   radar,
            'radar_scope': radar_scope,
            'course':  course_sel if radar_scope == 'course' else '',
            'dept':    dept_filter,
            'view':    view,
            'rank_by': rank_by,
            'prev_period': prev_label if prev_map else None,   # e.g. "2023-2024 2nd Semester"
            'has_prev':    bool(prev_map),
            'axes': [{'key': a['key'], 'label': a['label']} for a in [
                {'key':'avg_gwa_score',  'label':'GWA Score'},
                {'key':'passing_rate',   'label':'Passing Rate'},
                {'key':'completion_rate','label':'Completion'},
                {'key':'retention_rate', 'label':'Retention'},
                {'key':'regular_ratio',  'label':'Regular Students'},
            ]],
        })
    except Exception as e:
        import traceback
        return jsonify({'error': str(e), 'trace': traceback.format_exc()}), 500


@maindash_bp.route('/api/dash/heatmap')
def api_dash_heatmap():
    """
    Histogram: when no dept filter → bars = colleges (one per college).
               when dept filter    → bars = course programs within that college.
    compare: '' (default) | 'prev_sem' | 'same_sem'
    Returns {rows, year_levels, max_val, metric, basis, view, note?, compare?, prev_period?}
    """
    try:
        f       = _get_filters()
        status  = request.args.get('status', 'FAILED')
        sort    = request.args.get('sort', 'asc')
        metric  = request.args.get('metric', 'rate')
        compare = request.args.get('compare', '')

        if metric != 'count':
            metric = 'rate'

        if compare in ('prev_sem', 'same_sem'):
            return jsonify(_heatmap_compare(f, status, metric, compare))

        return jsonify(_heatmap_from_students(f, status, sort, metric))
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── /api/dash/gender-status ───────────────────────────────────────────────

_GD_STATUS_COLS = {            # priority order for the 'all' view: most serious first
    'DRP': 'DRP_Count', 'UDR': 'UDR_Count', 'FAILED': 'Failed_Count',
    'INC': 'INC_Count', 'NGA': 'NGA_Count',
}
_GD_ORDER  = ['CONTINUING', 'DRP', 'INC', 'FAILED', 'W', 'UDR', 'NGA']
_GD_COLORS = {'CONTINUING':'#16a34a','DRP':'#7c3aed','INC':'#d97706',
              'FAILED':'#dc2626','W':'#059669','UDR':'#0284c7','NGA':'#9ca3af'}


def _gender_status_from_students(f, enroll_type, status):
    """
    Gender x status built from DS01 (one row per student per semester) so the numbers are
    UNIQUE STUDENTS and follow the same filters as the KPI card (male + female ~ enrollment).

      status='all'  -> each student is placed in ONE slice: their most serious status
                       (DRP > UDR > FAILED > INC > NGA), otherwise CONTINUING.
      status='DRP'  -> students with that status vs everyone else (CONTINUING).

    Table rows are grouped by department, or by course once a department/course filter is set.
    Returns None when DS01 can't supply it (missing / no gender column) so the caller can fall back.
    """
    ds01 = get_model_dataset('DS01')
    if ds01.empty:
        return None
    gcol = next((c for c in ('Gender', 'Sex') if c in ds01.columns), None)
    if gcol is None:
        return None

    cols = {st: c for st, c in _GD_STATUS_COLS.items() if c in ds01.columns}
    if status != 'all' and status not in cols:
        status = 'all'

    df = _apply_filters(ds01, f).copy()
    if enroll_type == 'regular' and 'Is_Regular' in df.columns:
        df = df[df['Is_Regular'].fillna(False).astype(bool)]
    elif enroll_type == 'irregular' and 'Is_Irregular' in df.columns:
        df = df[df['Is_Irregular'].fillna(False).astype(bool)]

    def _g(v):
        v = str(v).strip().lower()
        return 'Male' if v in ('m', 'male') else ('Female' if v in ('f', 'female') else None)
    df['_g'] = df[gcol].map(_g)
    df = df[df['_g'].notna()]
    payload = {'male_pie': {}, 'female_pie': {}, 'table_rows': [], 'group_label': 'Department',
               'basis': 'students', 'period_supported': True}
    if df.empty:
        return payload

    by_course = bool(f['dept'] or f['course']) and 'Course' in df.columns
    grp_col = 'Course' if by_course else ('College' if 'College' in df.columns else None)
    df['_grp']  = df[grp_col].astype(str) if grp_col else 'All'
    df['_dept'] = df['College'].astype(str) if 'College' in df.columns else ''
    for st, c in cols.items():
        df[st] = df[c].fillna(0) > 0

    # one row per student (a student may appear in several semesters when no period is picked)
    if 'Student_ID' in df.columns:
        agg = {'_g': 'first', '_grp': 'first', '_dept': 'first', **{st: 'max' for st in cols}}
        t = df.dropna(subset=['Student_ID']).groupby('Student_ID').agg(agg).reset_index()
    else:
        t = df

    if status == 'all' and cols:
        t['_cat'] = np.select([t[st] for st in cols], list(cols), default='CONTINUING')
    elif status != 'all':
        t['_cat'] = np.where(t[status], status, 'CONTINUING')
    else:
        t['_cat'] = 'CONTINUING'

    def _pie(g):
        s = t[t['_g'] == g]['_cat'].value_counts()
        labels = [x for x in _GD_ORDER if s.get(x, 0) > 0]
        if not labels:
            return {}
        values = [int(s[x]) for x in labels]
        total = sum(values) or 1
        return {'labels': labels, 'values': values, 'total': total,
                'colors': [_GD_COLORS.get(l, '#9ca3af') for l in labels],
                'pcts': [round(v / total * 100, 1) for v in values]}

    tbl = t.groupby(['_g', '_dept', '_grp', '_cat']).size().reset_index(name='Count')
    payload.update({
        'male_pie': _pie('Male'), 'female_pie': _pie('Female'),
        'group_label': 'Course' if by_course else 'Department',
        'table_rows': [{'Gender': r['_g'], 'Department': r['_dept'],
                        'Course': r['_grp'] if by_course else '', 'Group': r['_grp'],
                        'Status': r['_cat'], 'Count': int(r['Count'])}
                       for r in tbl.to_dict(orient='records')],
    })
    return payload


def _gender_status_from_ds03(f, enroll_type):
    """FALLBACK only (DS03 = status records, NOT unique students, all semesters mixed).
    Used when DS01 has no gender column."""
    ds03 = get_model_dataset('DS03')
    # _apply_filters() silently skips a filter whose column is missing, so tell the UI
    # whether the academic-year / semester filter can actually be honoured for DS03.
    period_supported = ('Academic_Year' in ds03.columns) and ('Semester' in ds03.columns)
    if ds03.empty:
        return ({'male_pie':{}, 'female_pie':{}, 'table_rows':[],
                        'period_supported': period_supported})

    df = _apply_filters(ds03, f)
    if df.empty:
        return ({'male_pie':{}, 'female_pie':{}, 'table_rows':[],
                        'period_supported': period_supported})

    # Normalise
    if 'status_type' in df.columns:
        df['status_type'] = df['status_type'].replace(
            {'CRD':'CONTINUING','Continuing':'CONTINUING'})
    if 'Gender' in df.columns:
        df['Gender'] = df['Gender'].str.strip().str.title()

    # Enroll type filter via Is_Regular / Is_Irregular
    if enroll_type == 'regular' and 'Is_Regular' in df.columns:
        df = df[df['Is_Regular'].fillna(True).astype(bool)]
    elif enroll_type == 'irregular' and 'Is_Irregular' in df.columns:
        df = df[df['Is_Irregular'].fillna(False).astype(bool)]

    STATUS_ORDER  = ['CONTINUING','DRP','INC','FAILED','W','UDR','NGA']
    STATUS_COLORS = {
        'CONTINUING':'#16a34a','DRP':'#7c3aed','INC':'#d97706',
        'FAILED':'#dc2626','W':'#059669','UDR':'#0284c7','NGA':'#9ca3af',
    }

    def _build_pie(gender):
        gdf = df[df['Gender']==gender] if 'Gender' in df.columns else df
        totals = gdf.groupby('status_type', dropna=True)['student_count'].sum()
        labels = [s for s in STATUS_ORDER if s in totals.index and totals[s]>0]
        values = [int(totals[s]) for s in labels]
        total  = sum(values) or 1
        return {
            'labels': labels, 'values': values, 'total': total,
            'colors': [STATUS_COLORS.get(l,'#9ca3af') for l in labels],
            'pcts':   [round(v/total*100,1) for v in values],
        }

    male_pie   = _build_pie('Male')
    female_pie = _build_pie('Female')

    # Table rows — include Gender so JS can split Male/Female tables
    grp_cols = [c for c in ['Gender','College','status_type'] if c in df.columns]
    if len(grp_cols) >= 2:
        tbl = df.groupby(grp_cols, dropna=True)['student_count'].sum().reset_index()
        col_map = {'College':'Department', 'status_type':'Status', 'student_count':'Count'}
        tbl = tbl.rename(columns=col_map)
        tbl['Count'] = tbl['Count'].astype(int)
        grand = int(tbl['Count'].sum()) or 1
        tbl['Percentage'] = tbl['Count'].apply(lambda x: f"{x/grand*100:.1f}%")
        table_rows = tbl.sort_values('Count', ascending=False).to_dict(orient='records')
    else:
        table_rows = []

    return ({
        'male_pie':   male_pie,
        'female_pie': female_pie,
        'table_rows': table_rows,
        'period_supported': period_supported,
    })


@maindash_bp.route('/api/dash/gender-status')
def api_dash_gender_status():
    """
    Gender x Status breakdown.
    Params: year, sem, dept, course, yearlevel, enroll_type (all|regular|irregular),
            status (all|DRP|INC|FAILED|UDR|NGA)
    Returns: male_pie, female_pie, table_rows, group_label ('Department' | 'Course'), basis
    """
    try:
        f = _get_filters()
        enroll_type = request.args.get('enroll_type', 'all')
        status = request.args.get('status', 'all')

        payload = _gender_status_from_students(f, enroll_type, status)
        if payload is None:                       # DS01 has no gender column -> old DS03 numbers
            payload = _gender_status_from_ds03(f, enroll_type)
            payload['basis'] = 'ds03'
            payload['group_label'] = 'Department'
            for r in payload.get('table_rows', []):
                r['Group'] = r.get('Department')
        return jsonify(payload)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── /api/dash/hardest-subjects ────────────────────────────────────────────

@maindash_bp.route('/api/dash/hardest-subjects')
def api_dash_hardest_subjects():
    """
    Top hardest subjects: bar chart, ranked cards, and grade trend.
    Params: year, sem, dept, course, yearlevel, subject, top_n, sort, min_students.
    Returns {subjects, trend, trend_labels}. The trend covers all semesters for the same subjects.
    """
    try:
        f       = _get_filters()
        top_n   = request.args.get('top_n', '10')
        subject = request.args.get('subject', '')
        sort    = request.args.get('sort', 'desc')

        ds04 = get_model_dataset('DS04')
        if ds04.empty:
            return jsonify({'subjects': [], 'trend': [], 'trend_labels': []})

        df = _apply_filters(ds04, f)
        if subject and 'Subject_Code' in df.columns:
            df = df[df['Subject_Code'] == subject]
        if df.empty:
            return jsonify({'subjects': [], 'trend': [], 'trend_labels': []})

        # Aggregate across semesters, across every College/Course a subject is
        # cross-listed under, AND by Subject_Code alone rather than
        # (Subject_Code, Subject_Name). Two rows can share the exact same
        # Subject_Code but carry slightly different raw Subject_Name text
        # (extra whitespace, different casing/punctuation) when the grade
        # file already had its own title and course_catalog_checker's
        # canonical catalog title only ever fills in a BLANK Subject_Name —
        # it never overwrites one that's already there. Grouping by
        # Subject_Name too would silently re-split what is really one
        # subject into several low-count "duplicates". Subject_Code, after
        # the catalog's typo-correction pass, is the one column guaranteed
        # to be canonical, so it's the only real grouping key here.
        grp_cols = [c for c in ['Subject_Code'] if c in df.columns]

        def _agg_group(g):
            student_total = g['Student_Count'].sum() if 'Student_Count' in g.columns else 0
            at_risk_cols = [c for c in ['Failed_Count', 'INC_Count', 'DRP_Count', 'UDR_Count', 'W_Count']
                             if c in g.columns]
            # Avg_Grade weighted by each row's own student count, instead
            # of a flat average of averages.
            avg_grade = None
            if 'Avg_Grade' in g.columns and 'Student_Count' in g.columns:
                valid = g.dropna(subset=['Avg_Grade'])
                w = valid['Student_Count'].sum()
                if w:
                    avg_grade = round((valid['Avg_Grade'] * valid['Student_Count']).sum() / w, 2)
            out = {'Student_Count': student_total, 'Avg_Grade': avg_grade}
            for c in at_risk_cols:
                out[c] = int(g[c].sum())
            # Subject_Name/College/Course are shown as informational display
            # text, not filter keys here — use whichever value appears most
            # often for this subject code so the label stays a single, real
            # value instead of the exact-match text splitting the group.
            for c in ['Subject_Name', 'College', 'Course']:
                if c in g.columns and not g[c].dropna().empty:
                    out[c] = g[c].mode().iat[0]
            return pd.Series(out)

        agg = df.groupby(grp_cols, dropna=True).apply(_agg_group).reset_index()

        # Ignore subjects with too few students (e.g. 1 student = a shaky average)
        min_students = _safe_int(request.args.get('min_students', 0)) or 0
        if min_students and 'Student_Count' in agg.columns:
            agg = agg[agg['Student_Count'] >= min_students]
        if agg.empty:
            return jsonify({'subjects': [], 'trend': [], 'trend_labels': []})
        # Fail Rate was removed as a ranking/display metric (unreliable for
        # small cohorts) — rank by Avg_Grade instead. PH grading runs
        # 1.00 (best) to 5.00 (worst), so 'desc' still means hardest-first.
        agg = agg.sort_values('Avg_Grade', ascending=(sort == 'asc'), na_position='last')

        # Top N
        if top_n != 'all':
            try:
                agg = agg.head(int(top_n))
            except ValueError:
                pass

        def _safe(val):
            if val is None: return None
            try:
                v = float(val)
                if v != v: return None
                return round(v, 4) if isinstance(val, float) else _safe_int(v)
            except (TypeError, ValueError):
                return None

        subjects = []
        for _, r in agg.iterrows():
            subjects.append({
                'code':          r.get('Subject_Code', ''),
                'label':         r.get('Subject_Name', r.get('Subject_Code', '')),
                'dept':          r.get('College', ''),
                'course':        r.get('Course', ''),
                'student_count': _safe(r.get('Student_Count', 0)),
                'avg_grade':     _safe(r.get('Avg_Grade')),
                'FAILED':        _safe(r.get('Failed_Count')),
                'INC':           _safe(r.get('INC_Count')),
                'DRP':           _safe(r.get('DRP_Count')),
                'UDR':           _safe(r.get('UDR_Count')),
                'W':             _safe(r.get('W_Count')),
            })

        # Trend data — avg grade per semester for the SAME subjects shown in the bar chart
        # (the period filter is ignored inside, otherwise the trend would be a single point).
        top_codes = list(dict.fromkeys(agg['Subject_Code'].tolist())) if 'Subject_Code' in agg.columns else []
        trend_series, trend_labels = _build_hardest_trend(ds04, f, top_codes)

        # Subject list for filter dropdown
        all_subjects = []
        if 'Subject_Code' in ds04.columns and 'Subject_Name' in ds04.columns:
            sub_df = ds04[['Subject_Code', 'Subject_Name']].dropna().drop_duplicates()
            all_subjects = [{'code': r['Subject_Code'], 'label': r['Subject_Name']}
                            for _, r in sub_df.iterrows()]

        return jsonify({
            'subjects':     subjects,
            'trend':        trend_series,
            'trend_labels': trend_labels,
            'subjects':     subjects,   # for bar/cards
            'all_subjects_list': all_subjects,
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _build_hardest_trend(ds04: pd.DataFrame, f: dict, codes: list):
    """Multi-line trend: avg grade per semester for the given subject codes (all uploaded semesters)."""
    try:
        f_trend = {**f, 'year': '', 'sem': ''}
        df = _apply_filters(ds04, f_trend)
        if df.empty or 'Avg_Grade' not in df.columns:
            return [], []

        # Sort semesters chronologically
        if 'Academic_Year' in df.columns and 'Semester' in df.columns:
            df['_sort'] = df.apply(_sem_sort_key, axis=1)
            df = df.sort_values('_sort')
            sem_labels = df.groupby(['Academic_Year', 'Semester']).size().reset_index()
            sem_labels['_sort'] = sem_labels.apply(_sem_sort_key, axis=1)
            sem_labels = sem_labels.sort_values('_sort')
            x_labels = [f"{_format_ay(r['Academic_Year'])} {r['Semester']}"
                        for _, r in sem_labels.iterrows()]
        else:
            x_labels = []

        if not x_labels:
            return [], []

        top = [c for c in codes if c in set(df['Subject_Code'])] if 'Subject_Code' in df.columns else []
        if not top:
            return [], []

        series = []
        for code in top:
            sub_df = df[df['Subject_Code'] == code]
            name   = sub_df['Subject_Name'].iloc[0] if 'Subject_Name' in sub_df.columns else code
            vals_dict = sub_df.groupby(['Academic_Year', 'Semester'])['Avg_Grade'].mean().to_dict()
            values = []
            for _, row in sem_labels.iterrows():
                key = (row['Academic_Year'], row['Semester'])
                v   = vals_dict.get(key)
                values.append(_safe_float(v, 4) if v is not None else None)
            series.append({'label': name, 'values': values})

        return series, x_labels
    except Exception:
        return [], []

# ── /api/dash/insights (GET + POST) ──────────────────────────────────────────
# GET  ?chart_key=heatmapCard&dashboard=main  → latest saved insight for that chart
# POST { chart_key, dashboard, insight_text, filter_label, filter_hash }  → save/update

from database.models import db
from sqlalchemy import text as _sql_text
import hashlib as _hashlib
from flask import session as _session

import json as _json, os as _os, requests as _requests
try:
    from .college_scope import forced_college as _forced_college, NO_COLLEGE as _NO_COLLEGE
except Exception:
    from college_scope import forced_college as _forced_college, NO_COLLEGE as _NO_COLLEGE


def _insight_scope(raw):
    """One chart can hold many insights: one per filter combination.
    A Dean's college is forced here on the server, so a Dean's insight is always the one for
    their college, and Academic Affairs sees it when they filter to the same college."""
    forced = _forced_college()
    if forced == _NO_COLLEGE:
        return None, None
    f = {str(k): str(v) for k, v in (raw or {}).items() if v not in (None, '', False, 'false')}
    if forced:
        f['dept'] = forced
    return f, _hashlib.md5(_json.dumps(f, sort_keys=True).encode()).hexdigest()


def _filters_arg(src):
    try:
        v = _json.loads(src or '{}')
        return v if isinstance(v, dict) else {}
    except Exception:
        return {}


@maindash_bp.route('/api/dash/insights', methods=['GET'])
def api_get_insight():
    chart_key = request.args.get('chart_key', '').strip()
    dashboard = request.args.get('dashboard', 'main').strip()
    if not chart_key:
        return jsonify({'error': 'chart_key required'}), 400
    _, fh = _insight_scope(_filters_arg(request.args.get('filters')))
    if fh is None:
        return jsonify({'found': False})
    try:
        row = db.session.execute(
            _sql_text(
                'SELECT ci.id, ci.insight_text, ci.filter_label, ci.updated_at, '
                '  CONCAT(u.first_name, " ", u.last_name) AS updated_by '
                'FROM chart_insights ci '
                'LEFT JOIN acad_user u ON u.acaduser_id = ci.edited_by OR (ci.edited_by IS NULL AND u.acaduser_id = ci.generated_by) '
                'WHERE ci.chart_key = :k AND ci.dashboard = :d AND ci.filter_hash = :h '
                'ORDER BY ci.updated_at DESC LIMIT 1'
            ),
            {'k': chart_key, 'd': dashboard, 'h': fh}
        ).fetchone()
        legacy = False
        if not row and not _forced_college():          # full-access roles only: insights saved before per-filter keys
            row = db.session.execute(
                _sql_text(
                    'SELECT ci.id, ci.insight_text, ci.filter_label, ci.updated_at, NULL FROM chart_insights ci '
                    "WHERE ci.chart_key = :k AND ci.dashboard = :d AND (ci.filter_hash IS NULL OR ci.filter_hash = '') "
                    'ORDER BY ci.updated_at DESC LIMIT 1'),
                {'k': chart_key, 'd': dashboard}
            ).fetchone()
            legacy = bool(row)
        if not row:
            return jsonify({'found': False})
        return jsonify({'found': True, 'legacy': legacy, 'id': row[0], 'insight_text': row[1], 'filter_label': row[2],
                        'updated_at': str(row[3]), 'updated_by': row[4]})
    except Exception as e:
        print(f"[api_get_insight] load failed for chart_key={chart_key!r} dashboard={dashboard!r}: {e}")
        return jsonify({'error': 'load_failed', 'reason': str(e)}), 500


@maindash_bp.route('/api/dash/insights', methods=['POST'])
def api_save_insight():
    body = request.get_json(force=True, silent=True) or {}
    chart_key    = str(body.get('chart_key',    '')).strip()
    dashboard    = str(body.get('dashboard',    'main')).strip()
    insight_text = str(body.get('insight_text', '')).strip()
    filter_label = str(body.get('filter_label', '')).strip() or None
    f, fh = _insight_scope(body.get('filters') if isinstance(body.get('filters'), dict) else {})
    if fh is None:
        # Was a bare 403 with no detail — made a real permission failure
        # indistinguishable from "not logged in" / "role not recognized" /
        # anything else routed through this same branch. Now it says which.
        role = _session.get('role')
        reason = ('not logged in' if not role else f"role '{role}' has no data access")
        return jsonify({'error': 'not allowed', 'reason': reason}), 403
    if not chart_key or not insight_text:
        return jsonify({'error': 'chart_key and insight_text required'}), 400

    user_id = _session.get('user_id')  # set at login by app.py
    try:
        existing = db.session.execute(
            _sql_text('SELECT id FROM chart_insights WHERE chart_key=:k AND dashboard=:d AND filter_hash=:h '
                      'ORDER BY updated_at DESC LIMIT 1'),
            {'k': chart_key, 'd': dashboard, 'h': fh}
        ).fetchone()
        if existing:
            db.session.execute(
                _sql_text('UPDATE chart_insights SET insight_text=:txt, filter_label=:fl, edited_by=:uid WHERE id=:id'),
                {'txt': insight_text, 'fl': filter_label, 'uid': user_id, 'id': existing[0]}
            )
            rec_id = existing[0]
        else:
            result = db.session.execute(
                _sql_text('INSERT INTO chart_insights (chart_key, dashboard, filter_hash, filter_label, insight_text, generated_by) '
                          'VALUES (:k, :d, :fh, :fl, :txt, :uid)'),
                {'k': chart_key, 'd': dashboard, 'fh': fh, 'fl': filter_label, 'txt': insight_text, 'uid': user_id}
            )
            rec_id = result.lastrowid
        db.session.commit()
        return jsonify({'saved': True, 'id': rec_id})
    except Exception as e:
        db.session.rollback()
        # Printed server-side (visible in the Flask console / log file) AND
        # returned to the client — this used to only do the latter via a
        # generic 500, so the real cause (FK violation, bad column, etc.)
        # was only ever visible by someone manually reading server logs.
        print(f"[api_save_insight] save failed for chart_key={chart_key!r} "
              f"dashboard={dashboard!r} user_id={user_id!r}: {e}")
        return jsonify({'error': 'save_failed', 'reason': str(e)}), 500


# -- Free AI draft (Google Gemini free tier). Key stays on the server. ----------------------
@maindash_bp.route('/api/dash/insights/generate', methods=['POST'])
def api_generate_insight():
    if _forced_college() == _NO_COLLEGE:
        return jsonify({'error': 'not allowed'}), 403
    prompt = str((request.get_json(silent=True) or {}).get('prompt', ''))[:4000]
    key = _os.environ.get('GEMINI_API_KEY')
    if not prompt:
        return jsonify({'error': 'prompt required'}), 400
    if not key:
        return jsonify({'error': 'GEMINI_API_KEY is not set on the server'}), 503
    model = _os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash-lite')
    try:
        r = _requests.post(
            f'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent',
            headers={'x-goog-api-key': key, 'Content-Type': 'application/json'},
            json={'systemInstruction': {'parts': [{'text': 'You write concise numbered insights for university administrators from the aggregate numbers given. Never invent figures.'}]},
                  'contents': [{'parts': [{'text': prompt}]}],
                  'generationConfig': {'maxOutputTokens': 1000}},
            timeout=30)
        if r.status_code == 429:
            return jsonify({'error': 'Free AI limit reached - try again in a minute.'}), 429
        r.raise_for_status()
        parts = r.json()['candidates'][0]['content']['parts']
        return jsonify({'text': ''.join(x.get('text', '') for x in parts).strip()})
    except Exception as e:
        return jsonify({'error': str(e)}), 500