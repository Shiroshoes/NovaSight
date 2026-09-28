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
            {'dept': r['College'], 'code': r['Course'], 'label': r['Course']}
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

        # Percentage change vs previous semester
        gwa_pct_change = None
        try:
            prev_df = _prev_semester_df(ds01, f)
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
        prev = _prev_semester_df(ds01, f)
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
        prev = _prev_semester_df(ds01, f)
        if cur.empty or prev.empty:
            return None
        return _safe_float(cur['GWA'].dropna().mean() - prev['GWA'].dropna().mean(), 4)
    except Exception:
        return None


def _compute_completion_delta(ds01, f):
    """Returns (delta, pct_change) using _compute_completion_from_df with At_Risk fallback."""
    try:
        cur  = _apply_filters(ds01, f)
        prev = _prev_semester_df(ds01, f)
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



# ── Previous-period lookup (used by the performance leaderboard) ───────────────
_SEM_ORD_MAP = {'1sem': 1, '1st semester': 1, '1st sem': 1,
                '2sem': 2, '2nd semester': 2, '2nd sem': 2,
                'summer': 3}
_SEM_ORD_LABEL = {1: '1st Semester', 2: '2nd Semester', 3: 'Summer'}


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

        # Previous semester (same filters) so the leaderboard can show up / down arrows
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
    Returns {rows, year_levels, max_val, metric, basis, view, note?}
    view = 'college' | 'course'
    """
    try:
        f      = _get_filters()
        status = request.args.get('status', 'FAILED')
        sort   = request.args.get('sort', 'asc')
        metric = request.args.get('metric', 'rate')

        if metric != 'count':
            metric = 'rate'

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