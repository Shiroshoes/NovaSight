// var (not let/const) deliberately here: let/const share one global
// scope across every <script> tag on the page and throw a hard
// SyntaxError -- killing this ENTIRE file's execution -- if this script
// ever ends up parsed twice (stale cached response still served under
// the same ?v= URL after a deploy, a duplicate <script> include, etc.).
// var tolerates redeclaration silently, so one duplicate load can't take
// the whole dashboard down.
var gwaRankingChart;
var gwaScatterChart;
var statusRegularChart;
var statusIrregularChart;
var incForecastChart;
var dropoutRankingChart;
var riskByCollegeChart;
var maleStatusGridDonuts = {};   // one Regular/INC/Dropped donut per COLLEGE (or COURSE on dean dashboards), Male grid, keyed by group name
var femaleStatusGridDonuts = {}; // same as above, Female grid, keyed by group name
var courseStatusGenderDonuts = {};  // two Regular/Irregular donuts (Male + Female) per COURSE (all colleges), keyed by `${course}_male` / `${course}_female`
var hardestSubjectCharts = {};      // one Top-5-hardest-subjects line chart per COURSE, keyed by course name

// The 6 known college codes (matches chart-helpers.js COLLEGE_COLORS,
// minus the "MAIN CAMPUS"/"ALL" aggregate entries).
const ALL_COLLEGE_CODES = ['CAHS', 'CBA', 'CCST', 'CEA', 'COAS', 'CTEC'];

// ── COLOR UTILITIES ──────────────────────────────────────────────────
// RESTORED (2026-09-05): getGroupColor, hexToRgba, getGenderShade,
// getIncColor, getRiskColor, and renderColorLegend were called from ~25
// places each in this file (and again in maindash.js/deandash.js) but
// were never actually defined anywhere in the codebase, throwing
// "ReferenceError: X is not defined" the moment any chart tried to use
// them. Reconstructed from how every call site uses them: getGroupColor
// gives any label (college, course, or subject name) a consistent color
// everywhere it appears on the dashboard; getIncColor/getRiskColor are
// status-toned variants of that SAME base color (so a slice still ties
// back to its college/course visually); getGenderShade lightens/darkens
// a color for paired Male/Female series; hexToRgba adds transparency;
// renderColorLegend draws a simple dot+label legend into a container.

const COLLEGE_COLORS = {
    'CAHS': '#36b9cc',   // sky blue
    'CBA':  '#e74a3b',   // red
    'CCST': '#8a2be2',   // purple
    'CEA':  '#1cc88a',   // green
    'COAS': '#5a5c69',   // slate gray
    'CTEC': '#4e73df',   // blue
    'Main Campus': '#800000',
    'all': '#800000',
};

// Fixed colors for every named course, checked (as a substring match
// against the course's full name) before anything falls through to the
// college-shade auto-generator below. Courses get their own distinct
// hue on purpose — CAHS's 3 were the original set; the rest follow the
// same idea (one clearly different color per course, not a tint/shade
// of the parent college) so courses read as visually distinct from
// each other wherever they appear together (Department Dashboard,
// Prediction Analysis, hardest-subjects mini-cards, retention donuts).
const COURSE_COLORS = {
    // CAHS
    'NURSING':                                 '#4e73df', // blue
    'PUBLIC HEALTH':                           '#ffb385', // peach
    'MIDWIFERY':                                '#e83e8c', // pink
    // CBA
    'TOURISM MANAGEMENT':                       '#f6c23e', // gold
    'HOSPITALITY MANAGEMENT':                   '#fd7e14', // orange
    // CCST
    'INFORMATION TECHNOLOGY':                   '#6f42c1', // purple
    'DATA SCIENCE':                              '#20c997', // teal
    'COMPUTER SCIENCE':                          '#17a2b8', // cyan
    'ENTERTAINMENT AND MULTIMEDIA COMPUTING':    '#d63384', // magenta
    // CEA
    'CIVIL ENGINEERING':                         '#1cc88a', // green
    'MECHANICAL ENGINEERING':                    '#858796', // slate gray
    'ARCHITECTURE':                              '#b8860b', // dark goldenrod
    'ELECTRICAL ENGINEERING':                    '#dc3545', // red
    'INDUSTRIAL ENGINEERING':                    '#6610f2', // indigo
    'COMPUTER ENGINEERING':                      '#36b9cc', // sky blue
    'ELECTRONICS ENGINEERING':                   '#495057', // dark gray
    // COAS
    'COMMUNICATION':                             '#ff6b6b', // coral
    // CTEC
    'INDUSTRIAL TECHNOLOGY':                     '#2e86de', // strong blue
    'TECHNICAL-VOCATIONAL TEACHER EDUCATION':    '#a55eea', // violet
};


// ── ML ALGORITHM COLORS (Model Performance dashboard) ──────────────────
// Shared by this file's mp-grid model cards and by ml_diagnostics.js's
// Headline Score / Training Status charts, so every chart on the Model
// Performance page colors a model by which algorithm trained it — not
// by pass/fail status. Same 3 colors ml_eval.js's ALGO_META uses for the
// KPI cards and the "Models by Algorithm Type" donut/bar — kept in sync
// by hand since that file and this one don't share a module scope.
// 1. Add your Ground-truth algorithm mapping in JS
const ML_ALGO_META = {
    LinearRegression:       { label: 'Linear Regression',        color: '#1cc88a' },
    RandomForestRegressor:  { label: 'Random Forest Regression',  color: '#2A86FD' },
    RandomForestClassifier: { label: 'Random Forest Classifier',  color: '#8e44ad' },
};

const ML_ALGO_FALLBACK = { label: 'Other', color: '#858796' };

function mlAlgoMeta(algorithmKey) {
    if (!algorithmKey) return ML_ALGO_FALLBACK;

    let matchedAlgo = null;

    // 1. Check for exact matches first
    if (algorithmKey.startsWith("dropout_risk"))              matchedAlgo = "LinearRegression";
    else if (algorithmKey.startsWith("dropout_spike"))         matchedAlgo = "RandomForestRegressor";
    else if (algorithmKey.startsWith("dropout_ranking"))       matchedAlgo = "RandomForestRegressor";
    else if (algorithmKey.startsWith("gwa_ranking"))           matchedAlgo = "LinearRegression";
    else if (algorithmKey.startsWith("gwa_trend"))             matchedAlgo = "LinearRegression";
    else if (algorithmKey.startsWith("irreg_reg"))             matchedAlgo = "RandomForestClassifier";
    
    // 2. Catch multi-part keys (e.g., kpi_gwa, kpi_enrollment)
    else if (algorithmKey.startsWith("kpi"))                   matchedAlgo = "LinearRegression";
    
    // 3. Catch gender splits (e.g., gender_performance_male_dropout_rate)
    else if (algorithmKey.startsWith("gender_performance_male"))   matchedAlgo = "RandomForestRegressor";
    else if (algorithmKey.startsWith("gender_performance_female")) matchedAlgo = "RandomForestRegressor";
    
    // 4. Catch year level splits (e.g., year_level_performance_excellent)
    else if (algorithmKey.startsWith("year_level_performance"))    matchedAlgo = "LinearRegression";
    else if (algorithmKey.startsWith("year_level_inc_irreg"))      matchedAlgo = "LinearRegression";

    // Return the correct metadata coordinates or default to fallback if completely unknown
    return ML_ALGO_META[matchedAlgo] || ML_ALGO_FALLBACK;
}



// Fallback palette for labels outside the 6 colleges (specific courses,
// subjects, year levels, etc.) — picked deterministically by hashing the
// label so the same name always lands on the same color across every
// chart/legend on the page, without needing every possible label
// hardcoded above.
const _EXTRA_COLOR_PALETTE = [
    '#4e73df', '#1cc88a', '#36b9cc', '#f6c23e', '#e74a3b',
    '#858796', '#6f42c1', '#fd7e14', '#20c997', '#6610f2',
];

function _hashLabel(label) {
    const str = String(label == null ? '' : label);
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
    }
    return hash;
}

// A ladder of lighten/darken amounts (mixed toward white / toward black
// via _mixHex below) used to turn ONE college's own base color into a
// family of clearly-separated shades for its own courses, instead of
// handing each course an unrelated color from the flat fallback
// palette. 0 = the college's own exact color; each step after that
// alternates lighter/darker with increasing distance (±25%, ±45%,
// ±65%, ±80%) — so with several courses under one college, the first
// few are gently different and later ones stretch out to a near-white
// tint and a near-black shade, keeping every course visually distinct
// while all of them stay a tint/shade of that SAME hue.
const _COURSE_SHADE_STEPS = [0, -0.25, 0.25, -0.45, 0.45, -0.65, 0.65, -0.80, 0.80];

// Reverse lookup so two different courses under the SAME college don't
// land on the same shade step and look identical (mirrors how
// COLLEGE_COLORS itself never repeats a color across colleges).
const _courseShadeOwner = {}; // college's base color -> { stepIndex: label }

function _courseShadeOf(baseHex, label) {
    const startIdx = _hashLabel(label) % _COURSE_SHADE_STEPS.length;

    if (!_courseShadeOwner[baseHex]) _courseShadeOwner[baseHex] = {};
    const owner = _courseShadeOwner[baseHex];

    let stepIdx = startIdx;
    for (let step = 0; step < _COURSE_SHADE_STEPS.length; step++) {
        const candidateIdx = (startIdx + step) % _COURSE_SHADE_STEPS.length;
        if (!owner[candidateIdx] || owner[candidateIdx] === label) {
            stepIdx = candidateIdx;
            break;
        }
    }
    owner[stepIdx] = label;

    const amt = _COURSE_SHADE_STEPS[stepIdx];
    if (amt === 0) return baseHex;
    return amt > 0 ? _mixHex(baseHex, '#ffffff', amt) : _mixHex(baseHex, '#000000', -amt);
}

/**
 * getGroupColor(label, collegeHint?)
 * - Known college codes always return their own fixed color.
 * - If `collegeHint` is passed AND it's a known college, the label
 *   (almost always a course/program under that college) gets a shade
 *   of THAT college's own color instead of an unrelated hash-picked
 *   color — so e.g. every CBA course reads as a shade of CBA's own
 *   green, the same way it visually "belongs" to CBA everywhere else
 *   on the dashboard.
 * - With no hint (or an unknown one), falls back to the old
 *   deterministic hash-based palette, same as before.
 */
function getGroupColor(label, collegeHint) {
    if (COLLEGE_COLORS[label]) return COLLEGE_COLORS[label];

    const key = String(label || '').trim().toUpperCase();
    for (const courseKey in COURSE_COLORS) {
        if (key.includes(courseKey)) return COURSE_COLORS[courseKey];
    }

    const collegeColor = collegeHint && COLLEGE_COLORS[collegeHint];
    if (collegeColor) return _courseShadeOf(collegeColor, label);

    return _EXTRA_COLOR_PALETTE[_hashLabel(label) % _EXTRA_COLOR_PALETTE.length];
}

function _hexToRgbArr(hex) {
    const str = String(hex == null ? '' : hex).trim();

    // getIncColor/getRiskColor (via _mixHex) and getGenderShade itself
    // all return "rgb(r, g, b)" strings, not "#rrggbb" hex. Any call
    // chain that shades a color twice — e.g.
    // getGenderShade(getIncColor(name), isFemale) — feeds one of those
    // rgb() strings back into THIS function. It used to only handle
    // "#rrggbb": parseInt() on a string starting with "rgb(" can't
    // parse the letter "r" as hex, silently returns NaN, and NaN || 0
    // collapsed everything to black (0,0,0) — which is exactly what was
    // painting every INC/Dropped slice black instead of a shade of its
    // college's own color. Parse rgb()/rgba() directly instead of
    // falling through to the hex path.
    const rgbMatch = str.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    if (rgbMatch) {
        return [parseInt(rgbMatch[1], 10), parseInt(rgbMatch[2], 10), parseInt(rgbMatch[3], 10)];
    }

    let h = str.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const num = parseInt(h, 16);
    // Fall back to a sane default blue (not black) if the string truly
    // isn't a recognizable color, so an unexpected input degrades
    // gracefully instead of silently painting a chart slice black.
    if (h.length !== 6 || isNaN(num)) return [78, 115, 223];
    return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function hexToRgba(hex, alpha = 1) {
    const [r, g, b] = _hexToRgbArr(hex);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Lighten (Female) / darken (Male) a base color a bit so paired
// Male/Female series read as clearly related but distinguishable.
function getGenderShade(hex, isFemale) {
    const [r, g, b] = _hexToRgbArr(hex);
    const amt = isFemale ? 35 : -35;
    const clamp = (v) => Math.max(0, Math.min(255, v + amt));
    return `rgb(${clamp(r)}, ${clamp(g)}, ${clamp(b)})`;
}

function _mixHex(hex1, hex2, ratio) {
    const [r1, g1, b1] = _hexToRgbArr(hex1);
    const [r2, g2, b2] = _hexToRgbArr(hex2);
    const mix = (a, b) => Math.round(a + (b - a) * ratio);
    return `rgb(${mix(r1, r2)}, ${mix(g1, g2)}, ${mix(b1, b2)})`;
}

// Caution/amber-toned variant of a label's normal color, for
// INC-status series/slices. Only a light nudge (20%) toward amber so
// the slice still clearly reads as "this college/course, but INC" —
// not a different, unrelated color. Accepts the same optional
// collegeHint as getGroupColor, so a COURSE's INC shade is built from
// that course's own (college-tied) color rather than an unrelated
// auto-hashed one — without this, INC/Dropped would silently ignore
// which college a course belongs to and drift away from its assigned
// Regular color.
function getIncColor(label, collegeHint) {
    return _mixHex(getGroupColor(label, collegeHint), '#f6c23e', 0.20);
}

// Warm, alarm-toned (red) variant of a label's normal color, for
// at-risk/dropout-risk series/slices — see updateRiskByCollege's doc
// comment below for the original intent this was written to match.
// Only a light nudge (22%) toward red so the slice stays recognizably
// tied to its own college/course color rather than turning into a flat,
// unrelated red for every group. Accepts the same optional collegeHint
// as getGroupColor/getIncColor, for the same reason.
function getRiskColor(label, collegeHint) {
    return _mixHex(getGroupColor(label, collegeHint), '#e02424', 0.22);
}

// Draws a simple dot + label legend into a container element.
// items: [{ label, color }, ...]
function renderColorLegend(elementId, items) {
    const el = document.getElementById(elementId);
    if (!el) return;
    el.innerHTML = (items || []).map(item => `
        <span style="display:inline-flex; align-items:center; margin-right:12px; font-size:0.75rem; white-space:nowrap;">
            <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color:${item.color}; margin-right:5px;"></span>
            ${item.label}
        </span>
    `).join('');
}

/* ── Chart loading / empty-state helper ───────────────────────────
   A handful of bare <canvas> charts (GWA Ranking, Dropout Ranking,
   INC Forecast, GWA Scatter) had no visual feedback when a fetch
   resolved with zero rows — the canvas just stayed blank, which reads
   like the chart is stuck loading forever. This gives any canvas that
   opts in a real Loading… -> No data -> chart lifecycle, matching the
   "No Data" grey-slice pattern the donut charts already use. Creates
   one small status <p> right after the canvas (once) and reuses it. */
function chartStatusEl(canvas) {
    if (!canvas) return null;
    let el = canvas.nextElementSibling;
    if (!el || !el.classList || !el.classList.contains('chart-status-msg')) {
        el = document.createElement('p');
        el.className = 'chart-status-msg';
        el.style.cssText = 'color:#858796; text-align:center; margin:0.75rem 0 0; font-size:0.85rem;';
        canvas.insertAdjacentElement('afterend', el);
    }
    return el;
}
function setChartLoading(canvas, label) {
    const el = chartStatusEl(canvas);
    if (!el || !canvas) return;
    el.textContent = label || 'Loading…';
    el.style.display = '';
    canvas.style.display = 'none';
}
function setChartEmpty(canvas, label) {
    const el = chartStatusEl(canvas);
    if (!el || !canvas) return;
    el.textContent = label || 'No data available yet.';
    el.style.display = '';
    canvas.style.display = 'none';
}
function setChartReady(canvas) {
    if (!canvas) return;
    const el = canvas.nextElementSibling;
    if (el && el.classList && el.classList.contains('chart-status-msg')) {
        el.style.display = 'none';
    }
    canvas.style.display = '';
}

/**
 * Fetches /api/get_status_pie once PER COLLEGE (reusing the same trusted
 * endpoint every other chart already uses) so we can show a genuine
 * per-college breakdown instead of one flat aggregate number. Returns
 * [{ college, regular, irregular, mode, year }, ...].
 */
function fetchStatusByCollege(year, semester) {
    const requests = ALL_COLLEGE_CODES.map(code =>
        fetch(`/api/get_status_pie?year=${year}&college=${code}&semester=${semester}`)
            .then(res => res.json())
            .then(data => ({
                college: code,
                regular: (data && !data.error) ? data.data[0] : 0,
                irregular: (data && !data.error) ? data.data[1] : 0,
                mode: (data && data.mode) ? data.mode : 'Actual',
                year: (data && data.year) ? data.year : year
            }))
            .catch(() => ({ college: code, regular: 0, irregular: 0, mode: 'Actual', year }))
    );
    return Promise.all(requests);
}

// FIX (2026-09-05): removed this file's own "CENTRAL FILTER LOGIC" block.
// maindash.js (admin dashboards) and deandash.js (dean dashboards) each
// already run their own version of this same init: fetch the year list,
// wire up the filter dropdowns' change listeners, run the first refresh.
// Since chart-helpers.js loads on EVERY dashboard alongside whichever of
// those two is page-specific, having a third near-identical copy here
// meant /api/get_year_semester_options got fetched twice per page load,
// and every filter change fired triggerUpdate() twice (once from here,
// once from the page's own script) -- wasted requests, and on dean pages
// this copy's admin-only chart calls (updateGWARanking etc.) were all
// silent no-ops the whole time since those functions don't exist there.
// The Year dropdown's actual population now happens in maindash.js's and
// deandash.js's own init blocks instead (see the FIX note there).




// SEPARATE MALE & FEMALE RETENTION DONUTS
// The API still returns one combined breakdown (Male Safe/Risk, Female
// Safe/Risk) but we now split it into two side-by-side donuts so a
// non-technical viewer can instantly see each gender's own Safe vs
// Risk split, plus a one-sentence "who is higher" comparison.
function updateDropoutPie(year, college) {
    const semDropdown = document.getElementById('filterSemester');
    const semester = semDropdown ? semDropdown.value : 'all';

    // ── Badge / title / campus-wide summary numbers / "who's higher"
    // sentence still come from the aggregate endpoint, unchanged.
    fetch(`/api/get_dropout_pie?year=${year}&college=${college}&semester=${semester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error || !data.data || data.total === 0) {
                ['val-drop', 'val-inc', 'val-pred'].forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.innerText = "0";
                });
                return;
            }

            // data.data = [m_stay, f_stay, m_risk, f_risk]
            const [mStay, fStay, mRisk, fRisk] = data.data;
            const mTotal = mStay + mRisk;
            const fTotal = fStay + fRisk;

            // Year label only, initially — the Retention & Risk donuts
            // underneath (get_gender_status_breakdown) get their own
            // Forecast/Actual badge below once that fetch resolves, since
            // this endpoint (get_dropout_pie) doesn't know whether the
            // gender models actually covered this selection. This is just
            // the placeholder shown while that second fetch is in flight.
            document.querySelectorAll('[id^="drop-pie-badge"]').forEach(badge => {
                badge.innerText = `${year}`;
                badge.style.backgroundColor = "transparent";
                badge.style.color = "#5a5c69";
            });

            document.querySelectorAll('[id^="dp-college-name"]').forEach(titleSpan => {
                let displayCollege = (college === 'all' || college === 'Overall') ? 'Main Campus' : college;
                let displaySem = (semester === 'all') ? '' : `(${semester})`;
                titleSpan.innerText = `${displayCollege} ${displaySem}`;
            });

            const b = data.breakdown;
            if (document.getElementById('val-pred')) document.getElementById('val-pred').innerText = b.forecast_risk || 0;
            if (document.getElementById('val-drop')) document.getElementById('val-drop').innerText = b.actual_drops || 0;
            if (document.getElementById('val-inc')) document.getElementById('val-inc').innerText = b.actual_incs || 0;

            // Plain-language "who is higher" comparison (uses shared helper
            // from chart-helpers.js)
            const compareEl = document.getElementById('gender-risk-comparison');
            if (compareEl && typeof buildComparisonSentence === 'function') {
                const maleRiskPct = mTotal > 0 ? Math.round((mRisk / mTotal) * 100) : 0;
                const femaleRiskPct = fTotal > 0 ? Math.round((fRisk / fTotal) * 100) : 0;
                compareEl.innerText = buildComparisonSentence('Male students', maleRiskPct, 'Female students', femaleRiskPct, '% at risk of dropping/incomplete');
            }

            // Recolor header dots to match the selected college (shared
            // palette — same treatment as the Status donut).
            const safeCollege = (college === 'all' || college === '' || college === 'Overall') ? 'Main Campus' : college;
            const entityLabel = safeCollege === 'Main Campus' ? 'Main Campus' : safeCollege.toUpperCase();
            const entityColor = typeof getGroupColor === 'function' ? getGroupColor(entityLabel) : "#4e73df";

            ['dp-dot-m', 'dp-dot-f'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.backgroundColor = entityColor;
            });
        })
        .catch(err => console.error("Dropout Pie Fatal Error:", err));

    // ── Precise Regular / INC / Dropped grid, grouped by COLLEGE on the
    // Main dashboard, or by COURSE on a dean dashboard (e.g. CAHS) —
    // whichever the `college` filter currently is.
    const maleContainer = document.getElementById('maleStatusGridContainer');
    const femaleContainer = document.getElementById('femaleStatusGridContainer');
    if (!maleContainer && !femaleContainer) return;

    fetch(`/api/get_gender_status_breakdown?year=${year}&college=${college}&semester=${semester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("Gender Status Breakdown API error:", data.error);
            }
            const rows = data.rows || [];
            renderGenderStatusGrid(maleContainer, maleStatusGridDonuts, rows, 'male', data.group_by);
            renderGenderStatusGrid(femaleContainer, femaleStatusGridDonuts, rows, 'female', data.group_by);

            // Forecast/Actual badge for the two Retention & Risk donuts —
            // only meaningful for the per-college view (Main dashboard):
            // that's the only grain the gender models were trained on
            // (College x Year, no Course), so a future year there is a
            // real model prediction, same Forecast/Actual convention as
            // updateRiskByCollege's badge. Per-course (dean dashboards)
            // has no model to back it, so it stays the plain year/
            // transparent placeholder set above in updateDropoutPie.
            if (data.group_by === 'college') {
                const mode = data.mode === 'Forecast' ? 'Forecast' : 'Actual';
                const modeLabel = typeof displayModeLabel === 'function' ? displayModeLabel(mode) : mode;
                document.querySelectorAll('[id^="drop-pie-badge"]').forEach(badge => {
                    badge.innerText = `${year} ${modeLabel}`;
                    badge.style.backgroundColor = mode === 'Forecast' ? "#f6c23e" : "rgb(28, 200, 138)";
                    badge.style.color = "#fff";
                });
            }
        })
        .catch(err => console.error("Gender Status Breakdown Error:", err));
}

/**
 * Renders ONE combined donut for a single gender ('male' or 'female')
 * into `container`, with slices grouped PER COURSE (dean dashboards) or
 * PER COLLEGE (Main dashboard) — one donut instead of the old grid of
 * many small mini-donuts — while still breaking each group down into
 * Regular / INC / Dropped (3 slices per group), so that detail isn't
 * lost. Regular = that group's own brand color (getGroupColor), INC =
 * a mid amber tint of that SAME color (getIncColor), Dropped = that
 * color's full risk-tint (getRiskColor), all lightened for Female via
 * getGenderShade — so every slice still visually relates back to its
 * own course/college, and Male vs Female stay a matched pair.
 * The header above the donut totals ONLY this gender's students (not
 * a combined all-gender total).
 */
function renderGenderStatusGrid(container, chartStore, rows, gender, groupBy) {
    if (!container) return;
    const groupLabel = groupBy === 'course' ? 'course' : 'college';

    const nonZero = rows.filter(r => (r[`${gender}_regular`] + r[`${gender}_inc`] + r[`${gender}_drop`]) > 0);
    if (nonZero.length === 0) {
        container.innerHTML = `<p style="color:#858796; text-align:center; width:100%;">No ${gender} ${groupLabel}-level data available yet.</p>`;
        return;
    }

    const isFemale = gender === 'female';
    const genderLabel = isFemale ? 'Female' : 'Male';

    // Per-gender total (THIS gender only, never all-gender combined).
    const genderTotal = nonZero.reduce((sum, r) =>
        sum + r[`${gender}_regular`] + r[`${gender}_inc`] + r[`${gender}_drop`], 0);

    // Aggregate Regular / INC / Dropped counts (summed across every
    // course/college shown), for the plain number readout next to the
    // donut — same 3 numbers the slices are built from, just totaled.
    const genderRegTotal = nonZero.reduce((sum, r) => sum + r[`${gender}_regular`], 0);
    const genderIncTotal = nonZero.reduce((sum, r) => sum + r[`${gender}_inc`], 0);
    const genderDropTotal = nonZero.reduce((sum, r) => sum + r[`${gender}_drop`], 0);

    // Build 3 slices (Regular / INC / Dropped) per group for the DONUT,
    // skipping any that are zero so the chart doesn't get 0-width
    // slivers. The LEGEND is built separately (legendEntries below) and
    // always lists all 3 statuses per group, even at 0, so Male/Female
    // legends stay structurally identical and a "0 Dropped" college
    // doesn't just silently vanish from the legend.
    const labels = [];
    const values = [];
    const colors = [];
    const legendEntries = [];
    nonZero.forEach(r => {
        const name = r.group;
        const base = getGenderShade(getGroupColor(name), isFemale);
        const inc = getGenderShade(getIncColor(name), isFemale);
        const risk = getGenderShade(getRiskColor(name), isFemale);

        const regular = r[`${gender}_regular`];
        const incVal = r[`${gender}_inc`];
        const drop = r[`${gender}_drop`];

        if (regular > 0) { labels.push(`${name} — Regular`); values.push(regular); colors.push(base); }
        if (incVal > 0) { labels.push(`${name} — INC`); values.push(incVal); colors.push(inc); }
        if (drop > 0) { labels.push(`${name} — Dropped`); values.push(drop); colors.push(risk); }

        legendEntries.push({ label: `${name} — Regular`, color: base });
        legendEntries.push({ label: `${name} — INC`, color: inc });
        legendEntries.push({ label: `${name} — Dropped`, color: risk });
    });

    const canvasId = `genderStatusDonut_${gender}`;
    const legendId = `genderStatusLegend_${gender}`;
    container.innerHTML = `
        <div style="text-align:center; font-weight:700; font-size:0.85rem; color:#5a5c69; margin-bottom:0.5rem;">
            Total ${genderLabel} Students: ${genderTotal.toLocaleString()}
        </div>
        <div style="display:flex; align-items:center; justify-content:center; gap:1.5rem; flex-wrap:wrap;">
            <div style="position:relative; height:260px; width:260px; flex:0 0 auto;">
                <canvas id="${canvasId}"></canvas>
            </div>
            <div style="display:flex; flex-direction:column; gap:0.5rem; font-size:0.85rem; min-width:150px;">
                <div style="color:#1cc88a; font-weight:700;">● ${genderRegTotal.toLocaleString()} Regular</div>
                <div style="color:#f6c23e; font-weight:700;">● ${genderIncTotal.toLocaleString()} INC</div>
                <div style="color:#e74a3b; font-weight:700;">● ${genderDropTotal.toLocaleString()} Dropped</div>
            </div>
        </div>
        <div id="${legendId}" style="margin-top:0.75rem; text-align:center;"></div>
    `;

    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    if (chartStore.chart) chartStore.chart.destroy();

    chartStore.chart = new Chart(canvas.getContext('2d'), {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: values,
                backgroundColor: colors,
                hoverBorderColor: "rgba(255, 255, 255, 1)",
                borderWidth: 2,
                hoverOffset: 8
            }]
        },
        options: {
            maintainAspectRatio: false,
            cutout: '60%',
            responsive: true,
            animation: { animateScale: true, animateRotate: true, duration: 800, easing: 'easeOutQuart' },
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const pct = genderTotal > 0 ? Math.round((ctx.raw / genderTotal) * 100) : 0;
                            return ` ${ctx.label}: ${ctx.raw.toLocaleString()} (${pct}% of ${genderLabel} total)`;
                        }
                    }
                }
            }
        }
    });

    // Compact chip legend below (native Chart.js legend gets crowded once
    // every group has 3 slices), grouped in the same order as the donut.
    // Uses legendEntries (not labels/colors) so every group always shows
    // all 3 statuses, even when a status is 0 for this gender — keeps
    // Male/Female legends structurally identical instead of a status
    // silently disappearing whenever its count happens to be zero.
    if (typeof renderColorLegend === 'function') {
        renderColorLegend(legendId, legendEntries);
    }
}



//  GWA RANKING CHART (Bar)
function updateGWARanking(year, semester, college) {
    const canvas = document.getElementById('gwaRankingChart');
    if (!canvas) return;

    // Uses the SHARED palette (chart-helpers.js) so a college's color here
    // matches its color in every other chart on this dashboard.

    setChartLoading(canvas, 'Loading GWA ranking…');

    fetch(`/api/get_gwa_ranking_data/${year}?semester=${semester}&college=${college}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("GWA Ranking Error:", data.error);
                setChartEmpty(canvas, 'Unable to load GWA ranking data.');
                return;
            }

            //  1. FILTER DATA 
            let displayData = data;
            if (college && college !== 'all' && college !== 'Main Campus') {
                displayData = data.filter(d => d.college.toUpperCase() === college.toUpperCase());
            }

            const labels = displayData.map(item => item.college);
            const values = displayData.map(item => item.gwa);

            if (labels.length === 0) {
                if (gwaRankingChart) { gwaRankingChart.destroy(); gwaRankingChart = null; }
                setChartEmpty(canvas, 'No GWA ranking data available yet.');
                return;
            }
            setChartReady(canvas);

            //  2. COLORS (shared palette so this matches scatter/forecast/pie)
            const backgroundColors = labels.map(c => hexToRgba(getGroupColor(c), 0.85));

            const semText = semester === 'all' ? 'Overall' : semester;
            const collText = (college === 'all' || !college) ? 'Main Campus' : college;
            const newTitle = `Academic Performance: ${year} (${semText} - ${collText})`;

            const ctx = canvas.getContext('2d');

            //  3. ANIMATION LOGIC (Update vs Create) 
            // Only take the in-place "update" path if the tracked chart
            // is BOTH still alive AND still a bar chart — Prediction
            // mode swaps this same canvas to a line chart via its own
            // untracked instance, so `gwaRankingChart` can be stale/null
            // even though something is still drawn on the canvas. Check
            // Chart.js's own registry (keyed by canvas, not by our JS
            // variable) so any leftover chart — tracked or not — gets
            // torn down before we draw the replacement.
            const existingOnCanvas = Chart.getChart(canvas);
            if (gwaRankingChart && gwaRankingChart.canvas === canvas && existingOnCanvas === gwaRankingChart) {
                // IF CHART EXISTS: Update data and animate the transition
                gwaRankingChart.data.labels = labels;
                gwaRankingChart.data.datasets[0].data = values;
                gwaRankingChart.data.datasets[0].backgroundColor = backgroundColors;
                
                // Update Title
                if (gwaRankingChart.options.plugins.title) {
                    gwaRankingChart.options.plugins.title.text = newTitle;
                }
                
                gwaRankingChart.update(); // < THIS TRIGGERS THE ANIMATION
            } else {
                if (existingOnCanvas) existingOnCanvas.destroy();
                // IF CHART IS NEW: Create it from scratch
                gwaRankingChart = new Chart(ctx, {
                    type: 'bar',
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Average GWA (Lower is Better)',
                            data: values,
                            backgroundColor: backgroundColors,
                            borderColor: '#000000',
                            borderWidth: 1,
                            borderRadius: 4,
                            
                            // Layout Controls
                            barPercentage: 0.8,
                            categoryPercentage: 0.8,
                            maxBarThickness: 500 
                        }]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: {
                            duration: 500,
                            easing: 'easeOutQuart'
                        },
                        layout: {
                            padding: { left: 10, right: 10, top: 25, bottom: 0 }
                        },
                        plugins: {
                            legend: { display: false },
                            title: { 
                                display: true, 
                                text: newTitle,
                                font: { size: 14 }
                            },
                            tooltip: {
                                callbacks: {
                                    label: function(context) {
                                        return ` GWA: ${context.raw.toFixed(2)}`;
                                    }
                                }
                            }
                        },
                        scales: {
                            y: {
                                min: 1.0,
                                max: 3.5,
                                title: { display: true, text: 'GWA Scale (1.0 = Highest)' },
                                ticks: { stepSize: 0.25 }
                            },
                            x: {
                                grid: { display: false }
                            }
                        }
                    }
                });
            }
        })
        .catch(err => {
            console.error("GWA Ranking Fatal:", err);
            setChartEmpty(canvas, 'Unable to load GWA ranking data.');
        });
}




// DROPOUT RANKING CHART (Bar)
function updateDropoutRanking(year, semester, college = 'all', isPrediction = false) {
    const canvas = document.getElementById('dropoutRankingChart');
    const subtitle = document.getElementById('dropoutRankSubtitle');

    if (!canvas) return;

    // No real forecasting model backs this chart (/api/get_dropout_ranking
    // is a Recent-Data-only endpoint, same as the Course x Year-Level
    // heatmap) — it was previously faking a "prediction" by re-showing the
    // latest real year's actual rates under a hatched bar style, which
    // reads as a genuine forecast when it isn't one. Hide the whole card
    // in Prediction mode instead, same treatment the heatmap already gets.
    const card = canvas.closest('.card') || canvas.closest('.card-full-width1');
    if (isPrediction) {
        if (card) card.style.display = 'none';
        if (dropoutRankingChart) {
            dropoutRankingChart.destroy();
            dropoutRankingChart = null;
        }
        return;
    }
    if (card) card.style.display = '';

    // 1. Sanitize Inputs
    let safeCollege = String(college || 'all').trim();
    if (safeCollege.toLowerCase() === 'main campus' || safeCollege === '') {
        safeCollege = 'all';
    }
    const apiSemester = semester || 'all';

    // 2. Update Subtitle
    if (subtitle) {
        let colText = (safeCollege === 'all') ? 'Main Campus' : safeCollege;
        subtitle.textContent = `( ${year} | ${apiSemester} | ${colText} )`;
    }

    // 3. Fetch Data
    setChartLoading(canvas, 'Loading dropout ranking…');

    fetch(`/api/get_dropout_ranking?year=${year}&semester=${apiSemester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("Ranking API Error:", data.error);
                setChartEmpty(canvas, 'Unable to load dropout ranking data.');
                return;
            }

            const chartData = data.data || [];

            // 4. Handle Empty Data (Prevents Crash)
            if (chartData.length === 0) {
                if (dropoutRankingChart) {
                    dropoutRankingChart.destroy();
                    dropoutRankingChart = null;
                }
                setChartEmpty(canvas, 'No dropout ranking data available yet.');
                return;
            }
            setChartReady(canvas);

            const labels = chartData.map(d => d.college);
            const values = chartData.map(d => d.rate);

            // Use each college's OWN fixed color (same one used in every other
            // chart). If a specific college is selected, dim the others so the
            // selected one still stands out, instead of losing per-college color.
            const backgroundColors = chartData.map(d => {
                const base = getGroupColor(d.college);
                if (safeCollege !== 'all') {
                    return (d.college === safeCollege.toUpperCase()) ? base : hexToRgba(base, 0.25);
                }
                return hexToRgba(base, 0.85);
            });

            const borderColors = chartData.map(d => getGroupColor(d.college));

            const ctx = canvas.getContext('2d');

            if (dropoutRankingChart) {
                dropoutRankingChart.destroy();
            }

            // Prediction Mode: swap the solid fill for the shared
            // "this is a forecast" bar treatment (50% opacity / dashed
            // border / diagonal hatch) instead of a bespoke look here.
            let finalBackground = backgroundColors;
            let borderDash = [];
            if (isPrediction && typeof PredictionStyle !== 'undefined') {
                finalBackground = chartData.map(d => PredictionStyle.createHatchPattern(getGroupColor(d.college)));
                borderDash = [5, 4];
            }

            // 6. Calculate Axis Scale (Prevents -Infinity Crash)
            const maxVal = values.length > 0 ? Math.max(...values) : 0;
            // Add 20% padding so the longest bar doesn't hit the edge
            const xMax = maxVal === 0 ? 5 : maxVal + (maxVal * 0.2); 

            dropoutRankingChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: isPrediction ? 'Predicted Dropout Rate (%)' : 'Dropout Rate (%)',
                        data: values,
                        backgroundColor: finalBackground,
                        borderColor: borderColors,
                        borderWidth: isPrediction ? 2 : 1,
                        borderDash: borderDash,
                        barPercentage: 0.7,
                    }]
                },
                options: {
                    indexAxis: 'y', // Horizontal
                    maintainAspectRatio: false,
                    responsive: true,
                    layout: { padding: { left: 10, right: 30, top: 20, bottom: 0 } },
                    scales: {
                        x: {
                            beginAtZero: true,
                            max: xMax,
                            grid: { color: "rgb(234, 236, 244)", borderDash: [2], drawBorder: false },
                            ticks: { padding: 10, callback: function(value) { return value + '%' } }
                        },
                        y: {
                            grid: { display: false, drawBorder: false },
                            ticks: { font: { weight: 'bold', size: 11 }, color: "#5a5c69" }
                        }
                    },
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: "rgba(255,255,255,0.95)",
                            bodyColor: "#858796",
                            titleColor: "#6e707e",
                            borderColor: '#dddfeb',
                            borderWidth: 1,
                            callbacks: {
                                label: function(context) { return ` Dropout Rate: ${context.raw}%`; }
                            }
                        }
                    }
                }
            });
        })
        .catch(err => {
            console.error("Ranking Chart Fatal:", err);
            setChartEmpty(canvas, 'Unable to load dropout ranking data.');
        });
}




// scatter plot
function updateGwaScatter(college, semester) {
    const canvas = document.getElementById('gwaScatterChart');
    const titleEl = document.getElementById('scatterSubtitle'); // Get the new span
    if (!canvas) return;

    const safeCollege = college || 'all';
    const safeSemester = semester || 'all';

    // 1. Update the Header Text Immediately
    if (titleEl) {
        let colText = (safeCollege === 'all' || safeCollege === '') ? 'Main Campus' : safeCollege;
        let semText = 'All Semesters';
        if (safeSemester.includes('1')) semText = '1st Sem';
        if (safeSemester.includes('2')) semText = '2nd Sem';
        if (safeSemester.toLowerCase().includes('summer')) semText = 'Summer';

        // "( All Years | 1st Sem | CAHS )" — no single year anymore, the
        // chart itself now shows every year as its own column.
        titleEl.textContent = `( All Years | ${semText} | ${colText} )`;
    }

    // 2. Fetch Data — no `year` param anymore, the endpoint always
    // returns every real year plus the forecast horizon.
    setChartLoading(canvas, 'Loading GWA distribution…');

    fetch(`/api/get_gwa_scatter?college=${safeCollege}&semester=${safeSemester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("Scatter API Fail:", data.error);
                setChartEmpty(canvas, 'Unable to load GWA distribution data.');
                return;
            }

            if (!data.data || !data.data.length) {
                if (gwaScatterChart) { gwaScatterChart.destroy(); gwaScatterChart = null; }
                setChartEmpty(canvas, 'No GWA distribution data available yet.');
                return;
            }
            setChartReady(canvas);

            const ctx = canvas.getContext('2d');

            if (gwaScatterChart) {
                gwaScatterChart.destroy();
            }

            const allYears = [...(data.real_years || []), ...(data.forecast_years || [])];
            const minYear = allYears.length ? Math.min(...allYears) : 2024;
            const maxYear = allYears.length ? Math.max(...allYears) : 2024;
            const lastRealYear = data.latest_real_year;

            // Group dots by College and color each group with the SHARED
            // palette (same colors used in the ranking bars / forecast
            // lines), so a student's dot color tells you their college
            // at a glance. If a specific college is already selected,
            // every dot is naturally the same group/color.
            const groupsPresent = {};
            data.data.forEach(pt => {
                const g = pt.college || 'Unknown';
                if (!groupsPresent[g]) groupsPresent[g] = [];
                groupsPresent[g].push(pt);
            });

            const scatterDatasets = Object.keys(groupsPresent).sort().map(g => {
                const color = getGroupColor(g);
                return {
                    label: g,
                    data: groupsPresent[g],
                    backgroundColor: hexToRgba(color, 0.55),
                    borderColor: color,
                    borderWidth: 1,
                    pointRadius: 4,
                    pointHoverRadius: 6,
                    order: 2
                };
            });

            // Average/prediction line spans every column, real AND
            // forecast — segment styling switches it to dashed the moment
            // it crosses into forecast years, so the trend visibly keeps
            // climbing (or dropping) past the real data instead of
            // stopping dead at the last upload.
            scatterDatasets.push({
                type: 'line',
                label: 'Avg GWA (dashed = predicted)',
                data: (data.line || []).map(p => ({ x: p.x, y: p.y, is_forecast: p.is_forecast })),
                borderColor: "#212529",
                borderWidth: 2,
                segment: {
                    // NOTE: segment context's p0/p1 are Point ELEMENTS, not
                    // raw data — they don't have a `.raw` property. Must
                    // look the original data up by index instead, per
                    // Chart.js's documented segment-styling pattern.
                    borderDash: (segCtx) => {
                        const pts = segCtx.chart.data.datasets[segCtx.datasetIndex].data;
                        const p0 = pts[segCtx.p0DataIndex];
                        const p1 = pts[segCtx.p1DataIndex];
                        return (p0 && p0.is_forecast) || (p1 && p1.is_forecast) ? [6, 4] : undefined;
                    }
                },
                // Forecast points render as hollow crosshairs (visually
                // "not real data yet"); real-year points stay invisible
                // dots (radius 0) since the individual student dots
                // already carry the real data — this line is purely the
                // average/trend, so only its forecast tail needs a marker.
                pointRadius: (ctx) => ctx.raw && ctx.raw.is_forecast ? 5 : 0,
                pointStyle: (ctx) => ctx.raw && ctx.raw.is_forecast ? 'crossRot' : 'circle',
                pointBorderColor: "#6366f1",
                pointBackgroundColor: "#212529",
                pointBorderWidth: 2,
                fill: false,
                order: 1
            });

            gwaScatterChart = new Chart(ctx, {
                type: 'scatter',
                data: { datasets: scatterDatasets },
                options: {
                    maintainAspectRatio: false,
                    responsive: true,
                    layout: { padding: { left: 10, right: 10, top: 20, bottom: 10 } },
                    scales: {
                        x: {
                            display: true,
                            type: 'linear',
                            min: minYear - 0.6,
                            max: maxYear + 0.6,
                            grid: {
                                // A vertical line marks where real data ends
                                // and the forecast columns begin.
                                color: (c) => (lastRealYear && Math.round(c.tick.value) === lastRealYear)
                                    ? "rgba(78, 115, 223, 0.35)" : "rgb(234, 236, 244)"
                            },
                            ticks: {
                                stepSize: 1,
                                callback: (v) => Math.round(v) === v ? Math.round(v) : ''
                            },
                            title: { display: true, text: 'School Year (dashed columns to the right are Predicted Data)' }
                        },
                        y: {
                            reverse: true, // 1.0 Top
                            min: 1.0,
                            max: 5.0,
                            grid: { color: "rgb(234, 236, 244)", borderDash: [2] },
                            ticks: {
                                stepSize: 0.25,
                                padding: 10,
                                callback: function(value) { return value.toFixed(2); }
                            },
                            title: { display: true, text: 'GWA (1.0 = Best, 5.0 = Failing) — dots near the top are stronger grades' }
                        }
                    },
                    plugins: {
                        legend: {
                            display: true,
                            position: 'top',
                            labels: { usePointStyle: true, font: { size: 11 } }
                        },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const pt = context.raw;
                                    if (context.dataset.type === 'line') {
                                        const tag = pt.is_forecast ? 'Predicted Avg' : 'Batch Avg';
                                        return ` ${pt.year} — ${tag}: ${pt.y}`;
                                    }
                                    return ` ${pt.year} — ${context.dataset.label} student ${pt.student_id}: GWA ${pt.y}`;
                                }
                            }
                        }
                    }
                }
            });

            // Build the plain-color legend under the chart too (in addition
            // to the built-in Chart.js legend) for users unfamiliar with charts.
            if (typeof renderColorLegend === 'function') {
                renderColorLegend('scatterColorLegend', Object.keys(groupsPresent).sort().map(g => ({
                    label: g, color: getGroupColor(g)
                })));
            }
        })
        .catch(err => {
            console.error("Scatter Chart Error:", err);
            setChartEmpty(canvas, 'Unable to load GWA distribution data.');
        });
}






// KPI

/** Up/down trend-arrow icons for the KPI %-change badge. `fill="currentColor"`
 *  so each icon inherits the badge's up/down/flat color automatically. */
const _KPI_TREND_ARROW_UP = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;vertical-align:-1px;"><path fill-rule="evenodd" d="M15.22 6.268a.75.75 0 0 1 .968-.431l5.942 2.28a.75.75 0 0 1 .431.97l-2.28 5.94a.75.75 0 1 1-1.4-.537l1.63-4.251-1.086.484a11.2 11.2 0 0 0-5.45 5.173.75.75 0 0 1-1.199.19L9 12.312l-6.22 6.22a.75.75 0 0 1-1.06-1.061l6.75-6.75a.75.75 0 0 1 1.06 0l3.606 3.606a12.695 12.695 0 0 1 5.68-4.974l1.086-.483-4.251-1.632a.75.75 0 0 1-.432-.97Z" clip-rule="evenodd" /></svg>`;
const _KPI_TREND_ARROW_DOWN = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:18px;height:18px;vertical-align:-1px;"><path fill-rule="evenodd" d="M1.72 5.47a.75.75 0 0 1 1.06 0L9 11.69l3.756-3.756a.75.75 0 0 1 .985-.066 12.698 12.698 0 0 1 4.575 6.832l.308 1.149 2.277-3.943a.75.75 0 1 1 1.299.75l-3.182 5.51a.75.75 0 0 1-1.025.275l-5.511-3.181a.75.75 0 0 1 .75-1.3l3.943 2.277-.308-1.149a11.194 11.194 0 0 0-3.528-5.617l-3.809 3.81a.75.75 0 0 1-1.06 0L1.72 6.53a.75.75 0 0 1 0-1.061Z" clip-rule="evenodd" /></svg>`;

/**
 * Renders one KPI card's trend indicator: a small colored %-change badge
 * (vs. the immediately preceding real period). Works identically in
 * Recent and Prediction mode — the backend's `pct_change` field is
 * always built the same way regardless of whether the CURRENT period is
 * real or forecasted (see get_kpi_metrics's 2026-09-06 TREND comment:
 * every period this walks back to is guaranteed real, since KPI
 * Prediction only ever targets one semester ahead).
 *
 * `goodDirection` is 'up' for a metric where growth is the good outcome
 * (enrollment), or 'down' for one where growth is bad (GWA — 1.0 is the
 * highest possible grade, so a falling average is an improvement — and
 * a drop count, where fewer is always better).
 *
 * `trendValues` is still accepted (and still populated by the backend)
 * for backward compatibility with existing call sites, but is no longer
 * used here now that the sparkline has been removed — only the badge
 * remains. Expects one element per card: #kpi-pct-<prefix> — see the
 * KPI card markup in maindashboardadmin.html / the dean dashboards.
 */
function renderKpiTrend(prefix, trendValues, pctChange, goodDirection) {
    const pctEl = document.getElementById(`kpi-pct-${prefix}`);

    if (pctEl) {
        if (pctChange === null || pctChange === undefined) {
            pctEl.innerHTML = '';
        } else {
            const isUp = pctChange > 0;
            const isFlat = pctChange === 0;
            const isGood = isFlat ? null : (goodDirection === 'up' ? isUp : !isUp);
            const color = isFlat ? '#858796' : (isGood ? '#1cc88a' : '#e74a3b');
            const arrow = isFlat ? '—' : (isUp ? _KPI_TREND_ARROW_UP : _KPI_TREND_ARROW_DOWN);
            const sign = isFlat ? '' : (isUp ? '+' : '-');
            pctEl.style.color = color;
            pctEl.innerHTML = `${arrow} ${sign}${Math.abs(pctChange).toFixed(1)}%`;
        }
    }
}

function updateKPIMetrics(year, semester, college) {
    // Defensive: the #filterCollege "All Colleges" option's value is
    // literally "Main Campus", not "all" — sanitize here too in case
    // this is ever called directly with the raw dropdown value.
    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;
    const url = `/api/get_kpi_metrics?year=${year}&semester=${semester}&college=${safeCollege}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            if (data.error || data.students === undefined || data.gwa === undefined) {
                console.error("KPI Error:", data.error || "malformed response, leaving cards as-is", data);
                return;
            }

            // 1. Get Elements
            const elStudents = document.getElementById('kpi-val-students');
            const elGWA = document.getElementById('kpi-val-gwa');
            const elDrop = document.getElementById('kpi-val-drop');
            const titleStudents = document.getElementById('kpi-title-students');
            const titleGWA = document.getElementById('kpi-title-gwa');
            const titleDrop = document.getElementById('kpi-title-drop');
            const cardStudents = document.getElementById('kpi-card-students');
            const cardGWA = document.getElementById('kpi-card-gwa');
            const cardDrop = document.getElementById('kpi-card-drop');

            if (!elStudents || !elGWA) return;

            // Total Drop is a newer field — default to 0 rather than
            // treating an older/malformed payload as a hard error.
            const safeDrop = data.drop === undefined ? 0 : data.drop;

            // 2. Update Numbers
            const isPred = data.is_prediction;
            if (isPred && typeof PredictionStyle !== 'undefined') {
                PredictionStyle.applyKpiPredictionStyle(cardStudents, elStudents, {
                    rawValue: data.students.toLocaleString(),
                });
                PredictionStyle.applyKpiPredictionStyle(cardGWA, elGWA, {
                    rawValue: data.gwa.toFixed(2),
                });
                if (elDrop) {
                    PredictionStyle.applyKpiPredictionStyle(cardDrop, elDrop, {
                        rawValue: safeDrop.toLocaleString(),
                    });
                }
            } else {
                if (typeof PredictionStyle !== 'undefined') {
                    PredictionStyle.clearKpiPredictionStyle(cardStudents, elStudents);
                    PredictionStyle.clearKpiPredictionStyle(cardGWA, elGWA);
                    if (elDrop) PredictionStyle.clearKpiPredictionStyle(cardDrop, elDrop);
                }
                elStudents.innerText = data.students.toLocaleString(); // 1,200
                elGWA.innerText = data.gwa.toFixed(2); // 1.25
                if (elDrop) elDrop.innerText = safeDrop.toLocaleString();
            }

            // 3. Dynamic Styling (Blue = History, Orange = AI Prediction)
            const color = isPred ? '#f6ad55' : '#6B7280'; // Orange vs Blue
            const gwaColor = isPred ? '#f6ad55' : '#6B7280'; // Orange vs Green
            const suffix = isPred ? `(Predicted Data — ${year})` : `(${year})`;

            const studentsLabel = isPred ? 'Enrollment Increase' : 'Total Enrollment';


            cardStudents.style.borderLeftColor = color;
            titleStudents.style.color = color;
            titleStudents.innerText = `${studentsLabel} ${suffix}`;

            cardGWA.style.borderLeftColor = gwaColor;
            titleGWA.style.color = gwaColor;
            titleGWA.innerText = `Average GWA ${suffix}`;

            // Total Drop stays maroon in both modes — a dropout count
            // reads as a warning regardless of Actual vs Predicted,
            // unlike the blue/orange history-vs-forecast split above.
            if (titleDrop) {
                const dropLabel = isPred ? 'Projected Drop' : 'Total Drop';
                titleDrop.style.color = '#800000';
                titleDrop.innerText = `${dropLabel} ${suffix}`;
            }
            if (cardDrop) cardDrop.style.borderLeftColor = '#800000';
        })
        .catch(err => console.error("KPI Error:", err));
}




//inc line chart — MULTI-LINE, one colored line per college
function updateIncForecast(college) {
    const canvas = document.getElementById('incForecastChart');
    if (!canvas) return;

    // Sanitize input (kept for the subtitle only — the chart itself
    // always shows ALL colleges at once so users can compare them)
    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;

    setChartLoading(canvas, 'Loading INC forecast…');

    fetch(`/api/get_inc_forecast?college=${safeCollege}&by=college`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("INC Forecast Error:", data.error);
                setChartEmpty(canvas, 'Unable to load INC forecast data.');
                return;
            }

            if (!data.series || !data.series.length) {
                if (incForecastChart) { incForecastChart.destroy(); incForecastChart = null; }
                setChartEmpty(canvas, 'No INC forecast data available yet.');
                return;
            }
            setChartReady(canvas);

            const ctx = canvas.getContext('2d');
            const labels = data.years;

            if (incForecastChart) {
                incForecastChart.destroy();
            }

            // One "Actual" (solid) + one "Predicted" (dashed) dataset PER
            // COLLEGE, all sharing that college's fixed color so a line's
            // color always means the same college everywhere else on the page.
            const datasets = [];
            (data.series || []).forEach(s => {
                const color = getGroupColor(s.label);
                datasets.push({
                    label: s.label,
                    data: s.history,
                    borderColor: color,
                    backgroundColor: hexToRgba(color, 0.08),
                    borderWidth: 3,
                    pointRadius: 3,
                    pointBackgroundColor: color,
                    spanGaps: false,
                    fill: false,
                    tension: 0.3
                });
                datasets.push({
                    label: s.label,
                    data: s.forecast,
                    borderColor: color,
                    borderDash: [8, 4],
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointRadius: 3,
                    pointStyle: 'rectRot',
                    pointBackgroundColor: '#ffffff',
                    pointBorderColor: color,
                    spanGaps: false,
                    fill: false,
                    tension: 0.3,
                    // Table Mode (table-view.js) drops any dataset
                    // flagged this way, so its generated table only
                    // ever shows the Recent/Actual line, never the
                    // predicted one.
                    isForecast: true,
                });
            });

            incForecastChart = new Chart(ctx, {
                type: 'line',
                data: { labels: labels, datasets: datasets },
                options: {
                    maintainAspectRatio: false,
                    scales: {
                        y: {
                            beginAtZero: true,
                            title: { display: true, text: 'INC Rate (%) — % of students with an Incomplete grade' },
                            grid: { color: "rgb(234, 236, 244)", borderDash: [2], drawBorder: false },
                            ticks: { padding: 10, callback: function(value) { return value + '%' } }
                        },
                        x: {
                            grid: { display: false },
                            ticks: { maxTicksLimit: 10 }
                        }
                    },
                    plugins: {
                        // The built-in legend would be cluttered with 12 entries
                        // (Actual + Predicted x 6 colleges), so we hide it and
                        // use the simple color-chip legend below the chart instead.
                        legend: { display: false },
                        tooltip: {
                            backgroundColor: "rgba(255,255,255,0.9)",
                            bodyColor: "#858796",
                            titleColor: "#6e707e",
                            borderColor: '#dddfeb',
                            borderWidth: 1,
                            callbacks: {
                                label: function(context) {
                                    if (context.parsed.y === null) return undefined;
                                    return ` ${context.dataset.label}: ${context.parsed.y.toFixed(2)}%`;
                                }
                            }
                        }
                    }
                }
            });

            // Simple color-chip legend: one chip per college, solid line = actual.
            if (typeof renderColorLegend === 'function') {
                renderColorLegend('incForecastLegend', (data.series || []).map(s => ({
                    label: s.label, color: getGroupColor(s.label)
                })));
            }
        })
        .catch(err => {
            console.error("INC Chart Fatal:", err);
            setChartEmpty(canvas, 'Unable to load INC forecast data.');
        });
}



// irreg multi line
function updateStatusChart(year, semester, college) {
    const regCanvas = document.getElementById('statusRegularChart');
    const irrCanvas = document.getElementById('statusIrregularChart');
    if (!regCanvas || !irrCanvas) return;

    // 1. Sanitize Inputs
    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;
    const safeSemester = semester || 'all';

    // 2. Update Title with Selection
    // NOTE: "status-chart-title" is duplicated across the separate
    // Regular / Irregular cards in the HTML, so update every match
    // instead of just the first (getElementById only grabs one, which
    // left the second card's title/badge stuck on its static "Loading..."
    // placeholder forever).
    const titleEls = document.querySelectorAll('[id="status-chart-title"]');
    titleEls.forEach(titleEl => {
        // Format Text: "Main Campus" instead of "all"
        const displayCollege = (safeCollege === 'all') ? 'Main Campus' : safeCollege.toUpperCase();
        const displaySemester = (safeSemester === 'all') ? 'All Sem' : safeSemester;

        titleEl.innerText = `Status: ${displayCollege} (${displaySemester})`;
    });

    const regCtx = regCanvas.getContext('2d');
    const irrCtx = irrCanvas.getContext('2d');
    const dotReg = document.getElementById('status-dot-regular');
    const dotIrr = document.getElementById('status-dot-irregular');
    const labelReg = document.getElementById('status-label-regular');
    const labelIrr = document.getElementById('status-label-irregular');
    const badges = document.querySelectorAll('[id="status-badge"]');
    const elReg = document.getElementById('val-regular');
    const elIrr = document.getElementById('val-irregular');
    const summaryEl = document.getElementById('status-plain-summary');
    const legendEl = document.getElementById('status-plain-summary-legend');
    const irrLegendEl = document.getElementById('status-irregular-legend');

    function renderDonut(existingChart, ctx, labels, chartData, chartColors, tooltipFn) {
        // Only trust `existingChart` if it's ACTUALLY the chart Chart.js
        // currently has registered on this canvas. The tracked JS
        // variable (statusRegularChart/statusIrregularChart) can go
        // stale — e.g. destroyed by mode-toggle.js's cleanup, or
        // superseded by an untracked Prediction-mode chart — and
        // blindly calling .update() on an already-destroyed Chart.js
        // instance throws deep inside Chart.js's resize/event-binding
        // logic ("Cannot read properties of null (reading
        // 'ownerDocument')"). Checking against Chart.getChart (Chart.js's
        // own source of truth for "what's on this canvas right now")
        // avoids that regardless of what the JS variable claims.
        const liveChart = Chart.getChart(ctx.canvas);

        if (existingChart && existingChart === liveChart) {
            existingChart.data.labels = labels;
            existingChart.data.datasets[0].data = chartData;
            existingChart.data.datasets[0].backgroundColor = chartColors;
            existingChart.options.plugins.tooltip.callbacks.label = tooltipFn;
            existingChart.update();
            return existingChart;
        }

        // No existing chart, or it's stale/superseded — clear whatever
        // is actually on the canvas (if anything) and start fresh.
        if (liveChart) liveChart.destroy();
        return new Chart(ctx, {
            type: 'doughnut',
            data: { labels: labels, datasets: [{
                data: chartData,
                backgroundColor: chartColors,
                hoverBorderColor: "rgba(255, 255, 255, 1)",
                borderWidth: 2,
                hoverOffset: 8
            }] },
            options: {
                maintainAspectRatio: false,
                cutout: '70%',
                responsive: true,
                animation: { animateScale: true, animateRotate: true, duration: 800, easing: 'easeOutQuart' },
                plugins: {
                    legend: { display: true, position: 'bottom', labels: { usePointStyle: true, font: { size: 11 } } },
                    tooltip: {
                        backgroundColor: "rgba(255,255,255,0.9)",
                        bodyColor: "#858796",
                        borderColor: '#dddfeb',
                        borderWidth: 1,
                        titleColor: '#6e707e',
                        callbacks: { label: tooltipFn }
                    }
                }
            }
        });
    }

    if (safeCollege === 'all') {
        // MAIN CAMPUS VIEW: two donuts, one for Regular and one for
        // Irregular, each broken out by COLLEGE (not just one plain
        // color) — every slice colored with that college's own brand color.
        if (labelReg) labelReg.innerText = 'Regular — by College';
        if (labelIrr) labelIrr.innerText = 'Irregular — by College';
        if (dotReg) dotReg.style.color = getGroupColor('Main Campus');
        if (dotIrr) dotIrr.style.color = getRiskColor('Main Campus');

        fetchStatusByCollege(year, safeSemester).then(rows => {
            const totalReg = rows.reduce((a, r) => a + r.regular, 0);
            const totalIrr = rows.reduce((a, r) => a + r.irregular, 0);
            const displayYear = rows[0] ? rows[0].year : year;

            if (elReg) elReg.innerText = totalReg.toLocaleString();
            if (elIrr) elIrr.innerText = totalIrr.toLocaleString();
            if (badges.length) {
                // Same reasoning as the Male/Female Retention & Risk
                // badges (drop-pie-badge): this only ever renders in
                // Recent mode — Prediction mode swaps in a separate
                // trend-line chart entirely (see mode-toggle.js's
                // _renderStatusCharts) — so an Actual/Forecast pill here
                // was implying a distinction that isn't meaningful on
                // this specific card. Just show the year.
                badges.forEach(badge => {
                    badge.innerText = `${displayYear}`;
                    badge.style.backgroundColor = "transparent";
                    badge.style.color = "#5a5c69";
                });
            }
            if (summaryEl && typeof buildDonutSummarySentence === 'function') {
                summaryEl.innerText = buildDonutSummarySentence('Main Campus', 'Regular', totalReg, 'Irregular', totalIrr);
            }

            // --- REGULAR DONUT: one slice per college ---
            const regRows = rows.filter(r => r.regular > 0);
            if (regRows.length === 0) {
                statusRegularChart = renderDonut(statusRegularChart, regCtx, ['No Data'], [1], ['#e3e6f0'], () => ' No Data');
                if (legendEl) legendEl.innerHTML = '';
            } else {
                const regLabels = regRows.map(r => r.college);
                const regValues = regRows.map(r => r.regular);
                const regColors = regRows.map(r => getGroupColor(r.college));
                statusRegularChart = renderDonut(statusRegularChart, regCtx, regLabels, regValues, regColors, (context) => {
                    const row = regRows[context.dataIndex];
                    const pct = totalReg > 0 ? Math.round((row.regular / totalReg) * 100) : 0;
                    return ` ${row.college}: ${row.regular.toLocaleString()} Regular (${pct}% of all Regular students)`;
                });
                if (typeof renderColorLegend === 'function') {
                    renderColorLegend('status-plain-summary-legend', regLabels.map(l => ({ label: l, color: getGroupColor(l) })));
                }
            }

            // --- IRREGULAR DONUT: one slice per college ---
            const irrRows = rows.filter(r => r.irregular > 0);
            if (irrRows.length === 0) {
                statusIrregularChart = renderDonut(statusIrregularChart, irrCtx, ['No Data'], [1], ['#e3e6f0'], () => ' No Data');
                if (irrLegendEl) irrLegendEl.innerHTML = '';
            } else {
                const irrLabels = irrRows.map(r => r.college);
                const irrValues = irrRows.map(r => r.irregular);
                const irrColors = irrRows.map(r => getGroupColor(r.college));
                statusIrregularChart = renderDonut(statusIrregularChart, irrCtx, irrLabels, irrValues, irrColors, (context) => {
                    const row = irrRows[context.dataIndex];
                    const pct = totalIrr > 0 ? Math.round((row.irregular / totalIrr) * 100) : 0;
                    return ` ${row.college}: ${row.irregular.toLocaleString()} Irregular (${pct}% of all Irregular students)`;
                });
                if (typeof renderColorLegend === 'function') {
                    renderColorLegend('status-irregular-legend', irrLabels.map(l => ({ label: l, color: getGroupColor(l) })));
                }
            }
        }).catch(err => console.error("Status By College Fatal:", err));

    } else {
        // SINGLE-COLLEGE VIEW: same two-donut idea, one level down — one
        // slice PER COURSE inside this college, for both Regular and
        // Irregular, each colored with that course's own shared color.
        const entityLabel = safeCollege.toUpperCase();

        if (dotReg) dotReg.style.color = getGroupColor(entityLabel);
        if (dotIrr) dotIrr.style.color = getRiskColor(entityLabel);
        if (labelReg) labelReg.innerText = 'Regular — by Course';
        if (labelIrr) labelIrr.innerText = 'Irregular — by Course';

        fetch(`/api/get_status_by_course?year=${year}&semester=${safeSemester}&college=${safeCollege}`)
            .then(res => res.json())
            .then(data => {
                if (data.error) return console.error("Status By Course Error:", data.error);

                const courses = data.courses || [];
                const totalReg = courses.reduce((a, c) => a + c.regular, 0);
                const totalIrr = courses.reduce((a, c) => a + c.irregular, 0);

                if (elReg) elReg.innerText = totalReg.toLocaleString();
                if (elIrr) elIrr.innerText = totalIrr.toLocaleString();
                if (badges.length) {
                    // Same reasoning as the Male/Female Retention & Risk
                    // badges (drop-pie-badge, deandash.js): this only
                    // ever renders in Recent mode — Prediction mode
                    // swaps in a separate trend-line chart entirely (see
                    // mode-toggle.js's _renderStatusCharts) — so a
                    // "Current Data" pill here was implying a live/vs
                    // forecast distinction that doesn't actually exist
                    // on this card. Just show the year.
                    badges.forEach(badge => {
                        badge.innerText = `${data.year || year}`;
                        badge.style.backgroundColor = "transparent";
                        badge.style.color = "#5a5c69";
                    });
                }
                if (summaryEl && typeof buildDonutSummarySentence === 'function') {
                    summaryEl.innerText = buildDonutSummarySentence(entityLabel, 'Regular', totalReg, 'Irregular', totalIrr);
                }

                // --- REGULAR DONUT: one slice per course ---
                const regRows = courses.filter(c => c.regular > 0);
                if (regRows.length === 0) {
                    statusRegularChart = renderDonut(statusRegularChart, regCtx, ['No Data'], [1], ['#e3e6f0'], () => ' No Data');
                    if (legendEl) legendEl.innerHTML = '';
                } else {
                    const regLabels = regRows.map(c => c.course);
                    const regValues = regRows.map(c => c.regular);
                    const regColors = regRows.map(c => getGroupColor(c.course, entityLabel));
                    statusRegularChart = renderDonut(statusRegularChart, regCtx, regLabels, regValues, regColors, (context) => {
                        const row = regRows[context.dataIndex];
                        const pct = totalReg > 0 ? Math.round((row.regular / totalReg) * 100) : 0;
                        return ` ${row.course}: ${row.regular.toLocaleString()} Regular (${pct}% of ${entityLabel}'s Regular students)`;
                    });
                    if (typeof renderColorLegend === 'function') {
                        renderColorLegend('status-plain-summary-legend', regLabels.map(l => ({ label: l, color: getGroupColor(l, entityLabel) })));
                    }
                }

                // --- IRREGULAR DONUT: one slice per course ---
                const irrRows = courses.filter(c => c.irregular > 0);
                if (irrRows.length === 0) {
                    statusIrregularChart = renderDonut(statusIrregularChart, irrCtx, ['No Data'], [1], ['#e3e6f0'], () => ' No Data');
                    if (irrLegendEl) irrLegendEl.innerHTML = '';
                } else {
                    const irrLabels = irrRows.map(c => c.course);
                    const irrValues = irrRows.map(c => c.irregular);
                    const irrColors = irrRows.map(c => getGroupColor(c.course, entityLabel));
                    statusIrregularChart = renderDonut(statusIrregularChart, irrCtx, irrLabels, irrValues, irrColors, (context) => {
                        const row = irrRows[context.dataIndex];
                        const pct = totalIrr > 0 ? Math.round((row.irregular / totalIrr) * 100) : 0;
                        return ` ${row.course}: ${row.irregular.toLocaleString()} Irregular (${pct}% of ${entityLabel}'s Irregular students)`;
                    });
                    if (typeof renderColorLegend === 'function') {
                        renderColorLegend('status-irregular-legend', irrLabels.map(l => ({ label: l, color: getGroupColor(l, entityLabel) })));
                    }
                }
            })
            .catch(err => console.error("Status Pie Fatal:", err));
    }
}


/**
 * NEW DONUT: "At-Risk Students — By College". Always breaks the current
 * campus-wide Irregular population down by college, so risk is visible
 * per-department rather than as one flat number/color. Each slice uses
 * getRiskColor(college) — a warm, alarm-toned variant of that SAME
 * college's normal color, so it still visually ties back to that
 * college everywhere else on the dashboard.
 */
function updateRiskByCollege(year, semester) {
    const canvas = document.getElementById('riskByCollegeChart');
    if (!canvas) return;
    const safeSemester = semester || 'all';

    fetchStatusByCollege(year, safeSemester).then(rows => {
        const totalIrr = rows.reduce((a, r) => a + r.irregular, 0);
        const mode = rows.find(r => r.mode === 'Forecast') ? 'Forecast' : 'Actual';

        const badge = document.getElementById('risk-college-badge');
        if (badge) {
            const modeLabel = typeof displayModeLabel === 'function' ? displayModeLabel(mode) : mode;
            badge.innerText = `${year} ${modeLabel}`;
            badge.style.backgroundColor = mode === 'Forecast' ? "#f6c23e" : "rgb(28, 200, 138)";
        }

        const nonZero = rows.filter(r => r.irregular > 0);
        const ctx = canvas.getContext('2d');
        const summaryEl = document.getElementById('risk-college-summary');

        let labels, values, colors, tooltipFn;
        if (nonZero.length === 0) {
            labels = ['No Data']; values = [1]; colors = ['#e3e6f0'];
            tooltipFn = () => ' No Data';
            if (summaryEl) summaryEl.innerText = "No at-risk students recorded for this period.";
        } else {
            labels = nonZero.map(r => r.college);
            values = nonZero.map(r => r.irregular);
            colors = nonZero.map(r => getRiskColor(r.college));
            tooltipFn = (context) => {
                const row = nonZero[context.dataIndex];
                const pct = totalIrr > 0 ? Math.round((row.irregular / totalIrr) * 100) : 0;
                return ` ${row.college}: ${row.irregular.toLocaleString()} At Risk (${pct}% of all at-risk students)`;
            };
            if (summaryEl) {
                const worst = nonZero.reduce((a, b) => (b.irregular > a.irregular ? b : a));
                const worstPct = totalIrr > 0 ? Math.round((worst.irregular / totalIrr) * 100) : 0;
                summaryEl.innerText = `${worst.college} has the most at-risk students campus-wide (${worst.irregular.toLocaleString()}, ${worstPct}% of all at-risk students).`;
            }
        }

        if (riskByCollegeChart) {
            riskByCollegeChart.data.labels = labels;
            riskByCollegeChart.data.datasets[0].data = values;
            riskByCollegeChart.data.datasets[0].backgroundColor = colors;
            riskByCollegeChart.options.plugins.tooltip.callbacks.label = tooltipFn;
            riskByCollegeChart.update();
        } else {
            riskByCollegeChart = new Chart(ctx, {
                type: 'doughnut',
                data: { labels: labels, datasets: [{
                    data: values,
                    backgroundColor: colors,
                    hoverBorderColor: "rgba(255,255,255,1)",
                    borderWidth: 2,
                    hoverOffset: 8
                }] },
                options: {
                    maintainAspectRatio: false,
                    cutout: '65%',
                    responsive: true,
                    animation: { animateScale: true, animateRotate: true, duration: 800, easing: 'easeOutQuart' },
                    plugins: {
                        legend: { display: false }, // dynamic chip legend rendered below instead
                        tooltip: {
                            backgroundColor: "rgba(255,255,255,0.9)",
                            bodyColor: "#858796",
                            borderColor: '#dddfeb',
                            borderWidth: 1,
                            titleColor: '#6e707e',
                            callbacks: { label: tooltipFn }
                        }
                    }
                }
            });
        }

        if (typeof renderColorLegend === 'function') {
            renderColorLegend('riskByCollegeLegend', labels.map(l => ({
                label: l, color: (l === 'No Data') ? '#e3e6f0' : getRiskColor(l)
            })));
        }
    }).catch(err => console.error("Risk By College Fatal:", err));
}


// eval
      (function () {
        // Colors for each status now live in modelEval.css (.status-ok /
        // .status-skipped / .status-error) — this just keeps the label text
        // and which status key to fall back to for an unknown status.
        const STATUS_COLORS = {
          ok:      { label: 'Trained' },
          skipped: { label: 'Skipped' },
          error:   { label: 'Error' },
        };

        function fmtPct(v) {
          if (v === null || v === undefined) return '—';
          return (v * 100 <= 100 && v <= 1) ? (v * 100).toFixed(1) + '%' : v.toFixed(2);
        }

        function fmtMetricValue(key, val) {
          if (val === null || val === undefined) return '—';
          if (typeof val !== 'number') return String(val);
          if (key.toLowerCase().includes('accuracy') || key.toLowerCase().includes('f1')) {
            return (val <= 1 ? (val * 100).toFixed(1) + '%' : val.toFixed(2));
          }
          return val.toFixed(4);
        }

        function renderModelCard(model) {
          const statusKey = STATUS_COLORS[model.status] ? model.status : 'skipped';
          const palette = STATUS_COLORS[statusKey];
          const headline = (model.headline_value !== null && model.headline_value !== undefined)
            ? fmtMetricValue(model.headline_label || '', model.headline_value)
            : '—';

          const metricRows = Object.entries(model.metrics || {})
            .filter(([k]) => k !== (model.headline_label || '').toLowerCase())
            .map(([k, v]) => `
              <div class="mec-metric-row">
                <span class="mec-metric-key">${k.replace(/_/g, ' ')}</span>
                <span class="mec-metric-val">${fmtMetricValue(k, v)}</span>
              </div>
            `).join('');

          const reasonRow = model.reason
            ? `<div class="mec-reason">${model.reason}</div>`
            : '';

          // Colored by which algorithm trained the model (not its
          // trained/skipped/error status — that's still shown by the
          // badge text/background below) so every card visually groups
          // with the same model's color everywhere else on this page.
          const algoMeta = mlAlgoMeta(model.id || model.name || model.key); 

          return `
            <div class="model-eval-card status-${statusKey}" style="border-left:5px solid ${algoMeta.color};">
              <div class="mec-header">
                <span class="mec-label">${model.label}</span>
                <span class="mec-badge">${palette.label}</span>
              </div>
              <div class="mec-algo-tag" style="color:${algoMeta.color};">
                <span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:${algoMeta.color}; margin-right:5px;"></span>${algoMeta.label}
              </div>
              <div class="mec-headline">${headline}</div>
              ${model.headline_label ? `<div class="mec-headline-label">${model.headline_label}</div>` : ''}
              <div class="mec-metrics">${metricRows}</div>
              ${reasonRow}
            </div>
          `;
        }

        function renderErrors(errors) {
          const wrap = document.getElementById('mp-errors');
          const list = document.getElementById('mp-errors-list');
          if (!errors || !errors.length) {
            wrap.style.display = 'none';
            return;
          }
          wrap.style.display = 'block';
          list.innerHTML = errors.map(e => `<li><strong>${e.step}:</strong> ${e.error}</li>`).join('');
        }

        function loadModelPerformance() {
          fetch('/api/model-performance')
            .then(res => res.json())
            .then(data => {
              const grid = document.getElementById('mp-grid');
              const empty = document.getElementById('mp-empty-state');
              const trainedAtEl = document.getElementById('mp-trained-at');

              if (data.status === 'no_training_yet' || !data.models || !data.models.length) {
                grid.style.display = 'none';
                empty.style.display = 'block';
                trainedAtEl.textContent = '';
                return;
              }

              grid.style.display = 'grid';
              empty.style.display = 'none';
              grid.innerHTML = data.models.map(renderModelCard).join('');
              renderErrors(data.errors);

              if (data.trained_at) {
                const d = new Date(data.trained_at);
                trainedAtEl.textContent = 'Last trained: ' + d.toLocaleString() +
                  (data.rows_in_master ? ` · ${data.rows_in_master.toLocaleString()} rows` : '');
              }
            })
            .catch(err => {
              console.error('Model performance fetch failed:', err);
              const trainedAtEl = document.getElementById('mp-trained-at');
              trainedAtEl.textContent = 'Unable to load model performance.';
            });
        }

        document.addEventListener('DOMContentLoaded', loadModelPerformance);
      })();

// --- TOP 5 HARDEST SUBJECTS, MULTI-LINE CHART PER DEPARTMENT ---
// Campus-wide version of the same feature on the Dean dashboards, but
// grouped by DEPARTMENT (college) instead of by individual course: the
// backend (college='all') now pools every course inside a college
// together and returns ONE Top-5 ranking per college, so each card here
// is one department, not one course. Each department's chart still has
// 5 lines (one per top-5 hardest subject), tracking that subject's
// average grade across the years of real data.
// (Note: the field is still called "course" in the API response for
// backward compatibility with the dean dashboards' per-course mode —
// in this Main Dashboard "all colleges" mode it actually holds the
// department/college code, e.g. "CAHS".)
//
// Same two-layout pattern as the CAHS dean dashboard:
// 1. DEDICATED CARDS — if the page defines
//    window.HARDEST_SUBJECTS_COURSE_CARDS = { keyword: containerId, ... }
//    each department gets matched to its own named, full-width card
//    (e.g. { cahs: 'hardestSubjectsCard_CAHS', cba: 'hardestSubjectsCard_CBA', ... }),
//    drawn bigger since it's the only chart in that card.
// 2. SHARED CONTAINER — fallback: every department's chart together in
//    one #hardestSubjectsByCourseContainer, as a grid of mini-cards.
function updateHardestSubjectsByCourse(college) {
    const cardMap = window.HARDEST_SUBJECTS_COURSE_CARDS;
    const dedicatedMode = !!cardMap;

    const sharedContainer = document.getElementById('hardestSubjectsByCourseContainer');
    if (!dedicatedMode && !sharedContainer) return;

    // Show/hide each department's whole card the moment the global
    // college filter changes — don't wait on the fetch below, so
    // switching departments feels instant instead of flashing every
    // card before narrowing back down.
    if (dedicatedMode) applyDepartmentCardVisibility(cardMap, college);

    // This section is always the campus-wide PER-DEPARTMENT overview
    // (that's the whole point of the dedicated CAHS/CBA/CCST/CEA/COAS/
    // CTEC cards below), so it always requests college=all — regardless
    // of the page's global college filter, which only narrows the OTHER
    // charts on this dashboard. Filtering this one down to a single
    // college would flip the backend into per-COURSE mode (individual
    // course names), which wouldn't match the department-keyed card map.
    const safeCollege = 'all';

    fetch(`/api/get_hardest_subjects_by_course?college=${safeCollege}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                if (dedicatedMode) {
                    Object.values(cardMap).forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.innerHTML = `<p style="color:#858796; text-align:center; width:100%;">${data.error}</p>`;
                    });
                } else {
                    sharedContainer.innerHTML = `<p style="color:#858796; text-align:center;">${data.error}</p>`;
                }
                return;
            }
            const courses = data.courses || [];
            if (courses.length === 0) {
                const msg = '<p style="color:#858796; text-align:center; width:100%;">No subject data available yet.</p>';
                if (dedicatedMode) {
                    Object.values(cardMap).forEach(id => {
                        const el = document.getElementById(id);
                        if (el) el.innerHTML = msg;
                    });
                } else {
                    sharedContainer.innerHTML = msg;
                }
                return;
            }

            if (dedicatedMode) {
                renderHardestSubjectsDedicated(courses, cardMap);
            } else {
                renderHardestSubjectsShared(courses, sharedContainer);
            }
        })
        .catch(err => console.error("Hardest Subjects By Course Error:", err));
}

/**
 * Shows every "Top 5 Hardest Subjects: <DEPT>" card when the global
 * college filter is set to "all"/"Main Campus", or hides all but the
 * one matching card when a specific department is selected — instead
 * of always showing all 6 side by side.
 */
function applyDepartmentCardVisibility(cardMap, college) {
    const raw = String(college || 'all').trim();
    const showAll = raw === '' || raw.toLowerCase() === 'all' || raw.toLowerCase() === 'main campus';
    const selected = raw.toUpperCase();

    Object.entries(cardMap).forEach(([keyword, containerId]) => {
        const inner = document.getElementById(containerId);
        if (!inner) return;
        // The container div is nested inside the full card wrapper
        // (header + body); hide/show that whole wrapper, not just the
        // inner chart area, so no empty card shell is left behind.
        const cardEl = inner.closest('.card') || inner;
        const isMatch = showAll || keyword.toUpperCase() === selected;
        cardEl.style.display = isMatch ? '' : 'none';
        // When exactly one department is isolated, stretch its card to
        // the full grid width (see .dept-card-focused in the CSS)
        // instead of leaving it at half width with an empty gap next
        // to it. Goes back to the normal half-width span once "all"/
        // Main Campus is selected again.
        cardEl.classList.toggle('dept-card-focused', isMatch && !showAll);
    });
}

/** Draws one group's (department or course) 5-subject line chart + legend into a canvas/legend pair. */
function drawHardestSubjectChart(group, canvas, legendEl) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (hardestSubjectCharts[group.course]) {
        hardestSubjectCharts[group.course].destroy();
    }

    const years = group.years || [];
    const subjects = group.subjects || [];
    const historyCount = group.history_count != null ? group.history_count : years.length;

    const datasets = subjects.map(s => {
        const color = getGroupColor(s.subject, group.course);
        return {
            label: s.subject,
            data: s.data,
            failCount: s.failCount || 0,
            failRate: s.failRate || 0,
            borderColor: color,
            backgroundColor: hexToRgba(color, 0.08),
            fill: false,
            borderWidth: 2,
            tension: 0.3,
            pointRadius: (ctx) => ctx.dataIndex >= historyCount ? 2 : 3,
            pointBackgroundColor: color,
            // Dash the FORECAST portion only, so the line visually
            // switches style right where real data ends — same
            // "Recent Data" vs "Forecast" split used elsewhere.
            segment: {
                borderDash: (ctx) => (ctx.p0DataIndex >= historyCount - 1) ? [5, 4] : undefined
            }
        };
    });

    hardestSubjectCharts[group.course] = new Chart(ctx, {
        type: 'line',
        data: {
            labels: years,
            datasets: datasets
        },
        options: {
            maintainAspectRatio: false,
            responsive: true,
            scales: {
                y: { min: 1.0, max: 5.0, ticks: { stepSize: 1 }, grid: { borderDash: [2], color: "#eaecf4" }, title: { display: true, text: 'Avg Grade (higher = harder)' } },
                x: { grid: { display: false }, ticks: { font: { size: 9 } } }
            },
            plugins: {
                legend: { display: false }, // using color-chip legend below instead
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            if (context.parsed.y === null) return undefined;
                            const mode = context.dataIndex >= historyCount ? 'Forecast' : 'Recent Data';
                            return ` ${context.dataset.label}: ${context.parsed.y.toFixed(2)} (${mode})`;
                        },
                        afterLabel: function(context) {
                            const fc = context.dataset.failCount;
                            const fr = context.dataset.failRate;
                            if (!fc) return undefined;
                            return `   ${fc.toLocaleString()} students failed (${fr}%)`;
                        }
                    }
                }
            }
        }
    });

    // Table Mode (table-view.js) reads this to cut off the dashed
    // forecast tail and only ever show the "Recent Data" years/
    // columns, never the predicted ones — even though this chart
    // always draws its own trailing forecast point regardless of the
    // dashboard-wide Recent/Prediction toggle.
    hardestSubjectCharts[group.course]._historyCount = historyCount;

    if (legendEl && typeof renderColorLegend === 'function') {
        renderColorLegend(legendEl.id, subjects.map(s => ({
            label: s.subject,
            color: getGroupColor(s.subject, group.course),
            // Fail count front-and-center in the legend, not just on
            // hover — the easiest place to spot it at a glance.
            subtitle: s.failCount ? `${s.failCount.toLocaleString()} failed` : null
        })));
    }
}

/** Layout 1: one department's chart per its own dedicated card (bigger, since it's the only chart there). */
function renderHardestSubjectsDedicated(courses, cardMap) {
    Object.entries(cardMap).forEach(([keyword, containerId]) => {
        const el = document.getElementById(containerId);
        if (!el) return;

        const match = courses.find(c => c.course && c.course.toLowerCase().includes(keyword.toLowerCase()));
        if (!match) {
            el.innerHTML = `<p style="color:#858796; text-align:center; width:100%;">No subject data available yet for this department.</p>`;
            return;
        }

        const safeId = match.course.replace(/[^a-zA-Z0-9]/g, '_');
        el.innerHTML = `
            <div style="width:100%;">
                <div style="position:relative; height:320px;">
                    <canvas id="hardestChart_${safeId}"></canvas>
                </div>
                <div id="hardestLegend_${safeId}" style="margin-top:0.6rem; text-align:center;"></div>
            </div>
        `;

        const canvas = document.getElementById(`hardestChart_${safeId}`);
        const legendEl = document.getElementById(`hardestLegend_${safeId}`);
        drawHardestSubjectChart(match, canvas, legendEl);
    });
}

/** Layout 2 (fallback): every department's chart together as a grid of mini-cards in one container. */
function renderHardestSubjectsShared(courses, container) {
    container.innerHTML = courses.map(c => `
        <div style="flex: 1 1 300px; max-width: 380px; background:#fff; border:1px solid #e3e6f0; border-radius: 0.5rem; padding: 0.85rem; margin: 0.4rem;">
            <h6 style="margin:0 0 0.5rem 0; font-size:0.85rem; font-weight:700; color:${getGroupColor(c.course)};">
                <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background-color:${getGroupColor(c.course)}; margin-right:6px;"></span>
                ${c.course} — Top 5 Hardest Subjects
            </h6>
            <div style="position:relative; height:220px;">
                <canvas id="hardestChart_${c.course.replace(/[^a-zA-Z0-9]/g, '_')}"></canvas>
            </div>
            <div id="hardestLegend_${c.course.replace(/[^a-zA-Z0-9]/g, '_')}" style="margin-top:0.4rem;"></div>
        </div>
    `).join('');

    courses.forEach(c => {
        const safeId = c.course.replace(/[^a-zA-Z0-9]/g, '_');
        const canvas = document.getElementById(`hardestChart_${safeId}`);
        const legendEl = document.getElementById(`hardestLegend_${safeId}`);
        drawHardestSubjectChart(c, canvas, legendEl);
    });
}

/* =====================================================================
   YEAR-LEVEL CHARTS (RESTORED 2026-09-06)
   updateYearLevelChart, updateYearLevelIncIrregChart,
   updateCourseYearLevelHeatmap, setIncIrregMetric, and
   _syncHeatmapCardVisibility were called from maindash.js, deandash.js,
   tableView.js, and inline onclick="" handlers in every dashboard's
   HTML, but were never actually defined anywhere in the codebase —
   same class of bug as the getGroupColor/getIncColor/etc. functions
   restored above. Every call site guards with `typeof X === 'function'`,
   so the missing functions failed completely silently: no console
   error, the three cards ("Performance by Year Level", "INC / Irregular
   / Drop Rate by Year Level", and the Course x Year-Level Dropout
   Heatmap) just never rendered, in Recent mode, Prediction mode, Chart
   Mode, or Table Mode alike.

   Reconstructed here from: the API responses the backend endpoints in
   ml_analysis.py already return (get_year_level_distribution,
   get_year_level_inc_irreg, get_course_year_level_heatmap,
   get_year_level_gwa_forecast, get_year_level_inc_irreg_forecast), the
   canvas/element ids in maindashboardadmin.html / cahsdashboardadmin.html
   (yearLevelChart, yearLevelIncIrregChart, heatmapCard,
   courseYearLevelHeatmap, heatmap-year-badge, heatmapCourseFilter,
   .inc-irreg-metric-btn), the call signatures already used in
   mode-toggle.js's _renderYearLevelCharts (year, semester, college,
   isPred[, metric]) and maindash.js/deandash.js's triggerUpdate(), and
   the history+dashed-forecast-tail line convention already established
   by drawHardestSubjectChart above.
   ===================================================================== */

var yearLevelChart;
var yearLevelIncIrregChart;
var _heatmapLatestData = null; // last successful /api/get_course_year_level_heatmap response ({courses, levels, matrix})
var _heatmapSelectedCourse = 'all'; // persists across global filter changes within the page load
var _lastIncIrregArgs = { metric: 'inc' }; // read by mode-toggle.js's _renderYearLevelCharts

function _ylSafeCollege(college) {
    return (college === 'Main Campus' || !college) ? 'all' : college;
}

/* ── PERFORMANCE BY YEAR LEVEL ────────────────────────────────────────
   Recent mode:     stacked bar from /api/get_year_level_distribution —
                     segments are College (Main dashboard, college='all'),
                     Course (a dean dashboard), or performance Band (a
                     single course selected) depending on scope, exactly
                     as that endpoint's own docstring lays out.
   Prediction mode: /api/get_year_level_distribution has no forecast for
                     the College/Course breakdown (only the Band view),
                     so per mode-toggle.js's own design comment this
                     switches to a multi-line GWA-by-year-level forecast
                     via /api/get_year_level_gwa_forecast instead — one
                     line per year level, solid history + dashed
                     predicted tail (same convention as
                     drawHardestSubjectChart above).
*/
function updateYearLevelChart(year, semester, college, isPred = false) {
    const canvas = document.getElementById('yearLevelChart');
    if (!canvas) return;

    const safeCollege = _ylSafeCollege(college);
    const safeSemester = semester || 'all';

    setChartLoading(canvas, 'Loading year-level performance…');

    if (isPred) {
        fetch(`/api/get_year_level_gwa_forecast?college=${encodeURIComponent(safeCollege)}`)
            .then(res => res.json())
            .then(data => {
                if (data.error || !data.labels || !data.labels.length) {
                    if (yearLevelChart) { yearLevelChart.destroy(); yearLevelChart = null; }
                    setChartEmpty(canvas, data.error || 'No forecast data available yet.');
                    return;
                }
                setChartReady(canvas);

                const historyCount = data.history_count != null ? data.history_count : data.labels.length;
                const datasets = (data.datasets || []).map(ds => {
                    const color = getGroupColor(ds.label);
                    return {
                        label: ds.label,
                        data: ds.data,
                        borderColor: color,
                        backgroundColor: hexToRgba(color, 0.08),
                        fill: false,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: (ctx) => (ctx.dataIndex >= historyCount) ? 4 : 3,
                        pointBackgroundColor: color,
                        segment: {
                            borderDash: (ctx) => (ctx.p0DataIndex >= historyCount - 1) ? [6, 4] : undefined,
                        },
                    };
                });

                const existing = Chart.getChart(canvas);
                if (existing) existing.destroy();

                yearLevelChart = new Chart(canvas.getContext('2d'), {
                    type: 'line',
                    data: { labels: data.labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: {
                                min: 1.0, max: 5.0, ticks: { stepSize: 0.5 },
                                title: { display: true, text: 'Avg GWA (1.0 = Highest)' },
                            },
                            x: { grid: { display: false } },
                        },
                        plugins: {
                            legend: { display: true, position: 'bottom' },
                            title: { display: true, text: 'Performance by Year Level — Predicted GWA Trend' },
                            tooltip: {
                                callbacks: {
                                    label: (ctx) => {
                                        if (ctx.parsed.y === null) return undefined;
                                        const mode = ctx.dataIndex >= historyCount ? 'Predicted' : 'Recent Data';
                                        return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(2)} (${mode})`;
                                    },
                                },
                            },
                        },
                    },
                });
                // Table Mode (tableView.js) reads this to trim the
                // predicted tail and only ever show Recent Data columns.
                yearLevelChart._historyCount = historyCount;
            })
            .catch(err => {
                console.error('Year Level GWA Forecast Fatal:', err);
                setChartEmpty(canvas, 'Unable to load forecast data.');
            });
        return;
    }

    fetch(`/api/get_year_level_distribution?year=${year}&semester=${safeSemester}&college=${encodeURIComponent(safeCollege)}`)
        .then(res => res.json())
        .then(data => {
            if (data.error || !data.labels || !data.labels.length) {
                if (yearLevelChart) { yearLevelChart.destroy(); yearLevelChart = null; }
                setChartEmpty(canvas, data.error || 'No year-level data available yet.');
                return;
            }
            setChartReady(canvas);

            const isBand = data.breakdown === 'band';
            const collegeHint = (!isBand && safeCollege !== 'all') ? safeCollege : undefined;

            const datasets = (data.datasets || []).map(ds => {
                const color = getGroupColor(ds.label, collegeHint);
                return {
                    label: ds.label,
                    data: ds.data,
                    counts: ds.counts,
                    bandMix: ds.bandMix,
                    backgroundColor: hexToRgba(color, 0.85),
                    borderColor: color,
                    borderWidth: 1,
                    maxBarThickness: 110,
                };
            });

            const existing = Chart.getChart(canvas);
            if (existing) existing.destroy();

            yearLevelChart = new Chart(canvas.getContext('2d'), {
                type: 'bar',
                data: { labels: data.labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    // Only 5 categories (1st–4th Year + Irregular) share the
                    // canvas, so the default 0.8/0.9 category/bar percentages
                    // left a lot of unused space per slot and made the bars
                    // read as skinny. Widening both, together with the
                    // higher maxBarThickness above, fills that space instead.
                    categoryPercentage: 0.9,
                    barPercentage: 0.95,
                    scales: {
                        x: { stacked: true, grid: { display: false } },
                        y: {
                            stacked: true, min: 0, max: 100,
                            ticks: { callback: (v) => v + '%' },
                            title: { display: true, text: '% of Students' },
                        },
                    },
                    plugins: {
                        legend: { display: true, position: 'bottom' },
                        title: { display: true, text: 'Performance by Year Level' },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => {
                                    const count = ctx.dataset.counts ? ctx.dataset.counts[ctx.dataIndex] : null;
                                    const base = ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%` +
                                        (count != null ? ` (${count.toLocaleString()})` : '');
                                    const mix = ctx.dataset.bandMix ? ctx.dataset.bandMix[ctx.dataIndex] : null;
                                    if (mix && mix.length) {
                                        return [base, ...mix.map(m => `   ${m.band}: ${m.pct}%`)];
                                    }
                                    return base;
                                },
                            },
                        },
                    },
                },
            });
            // Recent mode never carries a forecast tail on this chart —
            // the whole dataset is "Recent Data" for Table Mode's purposes.
            yearLevelChart._historyCount = data.labels.length;
        })
        .catch(err => {
            console.error('Year Level Distribution Fatal:', err);
            setChartEmpty(canvas, 'Unable to load year-level data.');
        });
}

/* ── INC / IRREGULAR / DROP RATE BY YEAR LEVEL ────────────────────────
   Recent mode:     grouped (non-stacked) bar from
                     /api/get_year_level_inc_irreg. When a single course
                     is selected, that endpoint has nothing left to
                     segment by and returns all 3 metrics side by side
                     instead (breakdown:"metric") — rendered as-is here
                     rather than forcing the one-metric-at-a-time view
                     the selector buttons imply, since the buttons have
                     nothing to switch between in that scope either way.
   Prediction mode: multi-line forecast (one line per year level, for
                     whichever single metric is selected) via
                     /api/get_year_level_inc_irreg_forecast, same
                     history+dashed-tail convention as the chart above.
*/
function updateYearLevelIncIrregChart(year, semester, college, isPred = false, metric = 'inc') {
    const canvas = document.getElementById('yearLevelIncIrregChart');
    if (!canvas) return;

    const safeCollege = _ylSafeCollege(college);
    const safeSemester = semester || 'all';
    const safeMetric = metric || 'inc';
    _lastIncIrregArgs = { metric: safeMetric };

    setChartLoading(canvas, 'Loading INC / Irregular / Drop rates…');

    if (isPred) {
        fetch(`/api/get_year_level_inc_irreg_forecast?college=${encodeURIComponent(safeCollege)}&metric=${safeMetric}`)
            .then(res => res.json())
            .then(data => {
                if (data.error || !data.labels || !data.labels.length) {
                    if (yearLevelIncIrregChart) { yearLevelIncIrregChart.destroy(); yearLevelIncIrregChart = null; }
                    setChartEmpty(canvas, data.error || 'No forecast data available yet.');
                    return;
                }
                setChartReady(canvas);

                const historyCount = data.history_count != null ? data.history_count : data.labels.length;
                const datasets = (data.datasets || []).map(ds => {
                    const color = getGroupColor(ds.label);
                    return {
                        label: ds.label,
                        data: ds.data,
                        borderColor: color,
                        backgroundColor: hexToRgba(color, 0.08),
                        fill: false,
                        borderWidth: 2,
                        tension: 0.3,
                        pointRadius: (ctx) => (ctx.dataIndex >= historyCount) ? 4 : 3,
                        pointBackgroundColor: color,
                        segment: {
                            borderDash: (ctx) => (ctx.p0DataIndex >= historyCount - 1) ? [6, 4] : undefined,
                        },
                    };
                });

                const existing = Chart.getChart(canvas);
                if (existing) existing.destroy();

                const metricLabel = data.metric || 'Rate';
                yearLevelIncIrregChart = new Chart(canvas.getContext('2d'), {
                    type: 'line',
                    data: { labels: data.labels, datasets },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        scales: {
                            y: {
                                min: 0, max: 100, ticks: { callback: (v) => v + '%' },
                                title: { display: true, text: `${metricLabel} (%)` },
                            },
                            x: { grid: { display: false } },
                        },
                        plugins: {
                            legend: { display: true, position: 'bottom' },
                            title: { display: true, text: `${metricLabel} by Year Level — Predicted` },
                            tooltip: {
                                callbacks: {
                                    label: (ctx) => {
                                        if (ctx.parsed.y === null) return undefined;
                                        const mode = ctx.dataIndex >= historyCount ? 'Predicted' : 'Recent Data';
                                        return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}% (${mode})`;
                                    },
                                },
                            },
                        },
                    },
                });
                yearLevelIncIrregChart._historyCount = historyCount;
            })
            .catch(err => {
                console.error('Year Level INC/Irreg Forecast Fatal:', err);
                setChartEmpty(canvas, 'Unable to load forecast data.');
            });
        return;
    }

    fetch(`/api/get_year_level_inc_irreg?year=${year}&semester=${safeSemester}&college=${encodeURIComponent(safeCollege)}&metric=${safeMetric}`)
        .then(res => res.json())
        .then(data => {
            if (data.error || !data.labels || !data.labels.length) {
                if (yearLevelIncIrregChart) { yearLevelIncIrregChart.destroy(); yearLevelIncIrregChart = null; }
                setChartEmpty(canvas, data.error || 'No year-level data available yet.');
                return;
            }
            setChartReady(canvas);

            const isMetricBreakdown = data.breakdown === 'metric';
            // Fixed colors matching the 3 selector buttons' own data-color
            // attributes, so a metric reads the same color everywhere.
            const METRIC_COLORS = {
                'INC Rate': '#f6c23e',
                'Irregular Rate (behavioral)': '#6f42c1',
                'Drop Rate': '#e74a3b',
            };
            const collegeHint = (!isMetricBreakdown && safeCollege !== 'all') ? safeCollege : undefined;

            const datasets = (data.datasets || []).map(ds => {
                const color = isMetricBreakdown
                    ? (METRIC_COLORS[ds.label] || getGroupColor(ds.label))
                    : getGroupColor(ds.label, collegeHint);
                return {
                    label: ds.label,
                    data: ds.data,
                    counts: ds.counts,
                    backgroundColor: hexToRgba(color, 0.85),
                    borderColor: color,
                    borderWidth: 1,
                    maxBarThickness: 50,
                };
            });

            const existing = Chart.getChart(canvas);
            if (existing) existing.destroy();

            const metricLabel = data.metricLabel || 'Rate';
            yearLevelIncIrregChart = new Chart(canvas.getContext('2d'), {
                type: 'bar',
                data: { labels: data.labels, datasets },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    scales: {
                        x: { grid: { display: false } },
                        y: {
                            min: 0, ticks: { callback: (v) => v + '%' },
                            title: { display: true, text: `${metricLabel} (%)` },
                        },
                    },
                    plugins: {
                        legend: { display: true, position: 'bottom' },
                        title: {
                            display: true,
                            text: isMetricBreakdown ? 'INC / Irregular / Drop Rate by Year Level' : `${metricLabel} by Year Level`,
                        },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => {
                                    const count = ctx.dataset.counts ? ctx.dataset.counts[ctx.dataIndex] : null;
                                    return ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%` +
                                        (count != null ? ` (${count.toLocaleString()})` : '');
                                },
                            },
                        },
                    },
                },
            });
            yearLevelIncIrregChart._historyCount = data.labels.length;
        })
        .catch(err => {
            console.error('Year Level INC/Irreg Fatal:', err);
            setChartEmpty(canvas, 'Unable to load year-level data.');
        });
}

/** Wired to the 3 .inc-irreg-metric-btn buttons' onclick="" in the HTML.
 *  Re-styles the buttons (they carry their look via inline style, not a
 *  CSS .active rule) and re-renders the chart with whatever mode/filters
 *  are currently active — read straight from the DOM / ModeAwareCharts
 *  since the onclick="" handler passes nothing but the metric name. */
function setIncIrregMetric(metricValue) {
    document.querySelectorAll('.inc-irreg-metric-btn').forEach((btn) => {
        const isActive = btn.dataset.metric === metricValue;
        btn.classList.toggle('active', isActive);
        const color = btn.dataset.color || '#4e73df';
        btn.style.background = isActive ? color : '#fff';
        btn.style.color = isActive ? '#fff' : color;
    });

    const isPred = (typeof ModeAwareCharts !== 'undefined') && ModeAwareCharts.currentMode === 'prediction';
    const yearSelect = document.getElementById('globalYearFilter');
    const semSelect = document.getElementById('filterSemester');
    const collegeSelect = document.getElementById('filterCollege');

    let year;
    if (isPred && typeof ModeAwareCharts !== 'undefined') {
        year = (ModeAwareCharts.latestRealYear || new Date().getFullYear()) + 1;
    } else {
        year = yearSelect ? yearSelect.value : undefined;
    }
    const semester = semSelect ? semSelect.value : 'all';
    const college = collegeSelect ? collegeSelect.value : 'all';

    if (typeof updateYearLevelIncIrregChart === 'function') {
        updateYearLevelIncIrregChart(year, semester, college, isPred, metricValue);
    }
}

/* ── COURSE x YEAR-LEVEL DROPOUT HEATMAP ──────────────────────────────
   Real-data only (no prediction mode — see mode-toggle.js's
   NON_PREDICTIVE_CHARTS, which already hides #heatmapCard whenever
   Prediction mode is active; this file only has to render its Recent
   Data content and stay out of that hiding logic's way).

   Rendered as a plain HTML table (not Chart.js), pivoted from
   /api/get_course_year_level_heatmap's {courses, levels, matrix} shape:
   rows = course/program, columns = year level, each cell = that
   course's dropout rate (%) at that year level, colored on a FIXED
   0-50%+ green -> amber -> orange -> red scale (not this selection's
   own min/max) so a cell's color always means the same real-world risk
   level no matter which college/year is currently filtered.

   Builds TWO views into the same container — a colored heatmap grid
   (Chart Mode) and a plain numbers-only table (Table Mode), same rows/
   columns, just without the color scale — and _syncHeatmapCardVisibility
   (called here after every render, and from tableView.js's setFormat())
   toggles between them. This is what "manages its own card visibility"
   means in tableView.js's comment: since the heatmap has no <canvas>,
   it doesn't go through the generic per-canvas table-generation sweep
   that every other chart card uses — it keeps its own pre-built plain
   table alongside the colored one and just swaps which is visible.

   The "Course:" dropdown (#heatmapCourseFilter) only re-slices the
   already-fetched matrix client-side — it never re-fetches and never
   affects any other chart on the page, per the card's own footnote
   text. The selection persists across global filter changes within the
   page load (e.g. switching Semester doesn't reset a course the user
   deliberately picked), and dean dashboards can sync it to their own
   course dropdown via the optional 4th argument.
*/

function _heatmapEscapeHtmlAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Fixed color stops so a given dropout rate always paints the same
// color everywhere, regardless of what else is currently in view.
function _heatmapColor(rate) {
    const stops = [
        { pct: 0,  color: [28, 200, 138] },   // #1cc88a green  — low risk
        { pct: 15, color: [246, 194, 62] },   // #f6c23e amber
        { pct: 30, color: [230, 126, 34] },   // orange
        { pct: 50, color: [231, 74, 59] },    // #e74a3b red    — high risk
    ];
    const clamped = Math.max(0, Math.min(rate, 50));
    let lo = stops[0], hi = stops[stops.length - 1];
    for (let i = 0; i < stops.length - 1; i++) {
        if (clamped >= stops[i].pct && clamped <= stops[i + 1].pct) {
            lo = stops[i]; hi = stops[i + 1]; break;
        }
    }
    const span = (hi.pct - lo.pct) || 1;
    const t = (clamped - lo.pct) / span;
    const rgb = lo.color.map((c, i) => Math.round(c + (hi.color[i] - c) * t));
    return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}
// Text stays readable against both light green and dark red.
function _heatmapTextColor(rate) {
    return rate >= 22 ? '#ffffff' : '#212529';
}

// Rebuilds #heatmapCourseFilter's <option> list from whatever courses
// came back in the latest fetch. Keeps the current selection if it's
// still valid; otherwise falls back to "All Courses" instead of
// silently pointing at a course that's no longer in the data.
function _populateHeatmapCourseFilter(courses) {
    const filterEl = document.getElementById('heatmapCourseFilter');
    if (!filterEl) return;

    if (!courses.includes(_heatmapSelectedCourse)) _heatmapSelectedCourse = 'all';

    filterEl.innerHTML = ['<option value="all">All Courses</option>']
        .concat(courses.map(c => `<option value="${_heatmapEscapeHtmlAttr(c)}">${c}</option>`))
        .join('');
    filterEl.value = _heatmapSelectedCourse;

    // A <select> with no explicit width sizes itself to whichever option
    // text is currently selected, unlike the fixed-size Semester/
    // College/Year filters next to it — lock it to match one of those
    // siblings once, so it doesn't visibly resize as courses are picked.
    if (!filterEl.dataset.widthLocked) {
        const reference = document.getElementById('filterCollege')
            || document.getElementById('filterSemester')
            || document.getElementById('globalYearFilter');
        if (reference) {
            const refWidth = reference.getBoundingClientRect().width;
            if (refWidth) filterEl.style.width = `${refWidth}px`;
        }
        filterEl.dataset.widthLocked = '1';
    }

    // Wire the change listener once — re-renders from the cached data
    // only, no fetch, no effect on any other chart on the page.
    if (!filterEl.dataset.wired) {
        filterEl.dataset.wired = '1';
        filterEl.addEventListener('change', () => {
            _heatmapSelectedCourse = filterEl.value;
            _renderCourseYearLevelHeatmap();
        });
    }
}

// Renders both the colored Chart-Mode grid and the plain Table-Mode
// table from _heatmapLatestData, sliced down to _heatmapSelectedCourse
// if it isn't "all". Pure re-render — never fetches, never touches any
// other chart.
function _renderCourseYearLevelHeatmap() {
    const container = document.getElementById('courseYearLevelHeatmap');
    if (!container || !_heatmapLatestData) return;

    const { levels } = _heatmapLatestData;
    let courses = _heatmapLatestData.courses;
    let matrix = _heatmapLatestData.matrix;

    if (_heatmapSelectedCourse && _heatmapSelectedCourse !== 'all') {
        const idx = courses.indexOf(_heatmapSelectedCourse);
        courses = idx >= 0 ? [courses[idx]] : [];
        matrix = idx >= 0 ? [matrix[idx]] : [];
    }

    if (courses.length === 0) {
        container.innerHTML = `<p style="color:#858796; text-align:center;">No data for the selected course.</p>`;
        return;
    }

    const headerCells = levels.map(level => `
        <th style="padding:0.55rem 0.6rem; font-size:0.72rem; font-weight:700; color:#5a5c69; text-align:center; white-space:nowrap; border-bottom:2px solid #e3e6f0;">${level}</th>
    `).join('');

    const bodyRows = courses.map((course, ci) => {
        const cells = (matrix[ci] || []).map(cell => {
            const rate = cell.rate || 0;
            const total = cell.total || 0;
            const bg = total > 0 ? _heatmapColor(rate) : '#eef0f5';
            const fg = total > 0 ? _heatmapTextColor(rate) : '#b7bdc9';
            const label = total > 0 ? `${rate.toFixed(1)}%` : '—';
            const title = total > 0
                ? `${course}: ${rate.toFixed(1)}% dropout (${cell.count.toLocaleString()} of ${total.toLocaleString()} students)`
                : `${course}: no students recorded at this year level`;
            return `<td title="${title}" style="padding:0.55rem 0.3rem; text-align:center; font-size:0.78rem; font-weight:700; background-color:${bg}; color:${fg}; border:1px solid rgba(255,255,255,0.6);">${label}</td>`;
        }).join('');
        return `
            <tr>
                <th scope="row" style="padding:0.55rem 0.5rem; font-size:0.78rem; font-weight:700; color:#5a5c69; text-align:left; white-space:normal; word-break:break-word; line-height:1.25; border-right:2px solid #e3e6f0; background:#f8f9fc; position:sticky; left:0;">${course}</th>
                ${cells}
            </tr>
        `;
    }).join('');

    // Plain (uncolored) version of the same rows/columns for Table Mode.
    const plainHeaderCells = levels.map(level => `
        <th style="padding:0.5rem 0.75rem; text-align:center; background:#f8f9fc; border-bottom:2px solid #e3e6f0; font-size:0.75rem; text-transform:uppercase; color:#5a5c69;">${level}</th>
    `).join('');

    const plainBodyRows = courses.map((course, ci) => {
        const cells = (matrix[ci] || []).map(cell => {
            const rate = cell.rate || 0;
            const total = cell.total || 0;
            const label = total > 0 ? `${rate.toFixed(1)}%` : '—';
            return `<td style="padding:0.5rem 0.75rem; text-align:center; border-bottom:1px solid #e3e6f0; font-size:0.85rem; color:#212529;">${label}</td>`;
        }).join('');
        return `
            <tr>
                <th scope="row" style="padding:0.5rem 0.75rem; text-align:left; border-bottom:1px solid #e3e6f0; font-size:0.85rem; color:#212529; background:#f8f9fc;">${course}</th>
                ${cells}
            </tr>
        `;
    }).join('');

    container.innerHTML = `
        <div id="courseYearLevelHeatmapChartView" style="width:100%; height:100%;">
            <div style="overflow-x:auto; width:100%; height:100%;">
                <table style="border-collapse:collapse; width:100%; height:100%; table-layout:fixed; min-width:${Math.max(400, levels.length * 90 + 120)}px;">
                    <colgroup>
                        <col style="width:160px;">
                        ${levels.map(() => '<col>').join('')}
                    </colgroup>
                    <thead>
                        <tr>
                            <th style="padding:0.55rem 0.5rem; border-bottom:2px solid #e3e6f0; background:#f8f9fc; position:sticky; left:0;"></th>
                            ${headerCells}
                        </tr>
                    </thead>
                    <tbody>${bodyRows}</tbody>
                </table>
            </div>
            <div style="display:flex; align-items:center; justify-content:center; gap:0.4rem; margin-top:1rem; font-size:0.72rem; color:#858796;">
                <span>Low</span>
                <div style="width:160px; height:10px; border-radius:5px; background:linear-gradient(90deg, #1cc88a, #f6c23e, #e17e34, #e74a3b);"></div>
                <span>High (50%+) dropout rate</span>
            </div>
        </div>
        <div id="courseYearLevelHeatmapTableView" style="display:none;">
            <div style="overflow-x:auto; background:#fff; border:1px solid #e3e6f0; border-radius:0.35rem;">
                <table style="width:100%; border-collapse:collapse;">
                    <thead>
                        <tr>
                            <th style="padding:0.5rem 0.75rem; text-align:left; background:#f8f9fc; border-bottom:2px solid #e3e6f0; font-size:0.75rem; text-transform:uppercase; color:#5a5c69;">Course</th>
                            ${plainHeaderCells}
                        </tr>
                    </thead>
                    <tbody>${plainBodyRows}</tbody>
                </table>
            </div>
            <div style="display:flex; align-items:center; justify-content:center; gap:0.4rem; margin-top:1rem; font-size:0.72rem; color:#858796;">
                <span>0% Low</span>
                <div style="width:160px; height:10px; border-radius:5px; background:linear-gradient(90deg, #1cc88a, #f6c23e, #e17e34, #e74a3b);"></div>
                <span>High (50%+) dropout rate</span>
            </div>
        </div>
    `;

    _syncHeatmapCardVisibility();
}

/** Shows whichever of the two views built by _renderCourseYearLevelHeatmap
 *  matches the dashboard's current Chart Mode / Table Mode — the colored
 *  heatmap grid in Chart Mode, the plain numbers table in Table Mode.
 *  Called here after every re-render, and from tableView.js's setFormat()
 *  when the Chart/Table pill itself is toggled — this is the function
 *  that comment already refers to. */
function _syncHeatmapCardVisibility() {
    const chartView = document.getElementById('courseYearLevelHeatmapChartView');
    const tableView = document.getElementById('courseYearLevelHeatmapTableView');
    if (!chartView || !tableView) return;
    const isTable = (typeof DisplayFormat !== 'undefined' && DisplayFormat.current === 'table');
    chartView.style.display = isTable ? 'none' : '';
    tableView.style.display = isTable ? '' : 'none';
}

function updateCourseYearLevelHeatmap(year, semester, college, heatmapCourse) {
    const container = document.getElementById('courseYearLevelHeatmap');
    if (!container) return;

    // #heatmapCard shares the same .card / .card-full-width* styling as
    // the chart cards around it, which are height-constrained for their
    // canvases. This card is always a plain HTML table though (never a
    // chart), so — same idea as the df-table-active height override
    // Table Mode applies to chart cards — force it to size to its own
    // content instead of clipping/scrolling internally.
    const heatmapCard = document.getElementById('heatmapCard');
    if (heatmapCard) {
        heatmapCard.style.height = 'auto';
        heatmapCard.style.maxHeight = 'none';
        heatmapCard.style.overflow = 'visible';
    }
    container.style.height = '100%';
    container.style.width = '100%';

    const safeCollege = _ylSafeCollege(college);
    const safeSemester = semester || 'all';

    const badge = document.getElementById('heatmap-year-badge');
    if (badge) badge.textContent = `${year}`;

    // If the caller told us which course is selected on the page's own
    // course filter (deandash.js's 4th arg), sync it into the heatmap's
    // local selection now — before the fetch even resolves — so a slow
    // request doesn't leave the dropdown briefly showing the previous
    // course.
    if (typeof heatmapCourse !== 'undefined' && heatmapCourse !== null) {
        _heatmapSelectedCourse = heatmapCourse || 'all';
    }

    container.innerHTML = `<p style="color:#858796; text-align:center;">Loading heatmap...</p>`;

    fetch(`/api/get_course_year_level_heatmap?year=${year}&semester=${safeSemester}&college=${encodeURIComponent(safeCollege)}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                _heatmapLatestData = null;
                container.innerHTML = `<p style="color:#858796; text-align:center;">${data.error}</p>`;
                return;
            }
            const courses = data.courses || [];
            const levels = data.levels || [];
            const matrix = data.matrix || [];

            if (courses.length === 0 || levels.length === 0) {
                _heatmapLatestData = null;
                container.innerHTML = `<p style="color:#858796; text-align:center;">No year-level dropout data available yet.</p>`;
                return;
            }

            _heatmapLatestData = { courses, levels, matrix };
            _populateHeatmapCourseFilter(courses);
            _renderCourseYearLevelHeatmap();
        })
        .catch(err => {
            console.error('Course Year-Level Heatmap Error:', err);
            _heatmapLatestData = null;
            container.innerHTML = `<p style="color:#858796; text-align:center;">Unable to load heatmap data.</p>`;
        });
}