/* =====================================================================
   CHART-HELPERS.JS
   Shared across maindash.js (Main / all-colleges view) and deandash.js
   (single-college "dean" dashboards like CAHS, CBA, etc).

   Purpose:
   1. Give every college / course ONE fixed color that never changes,
      no matter which chart it appears in (bar, pie, scatter, line).
   2. Provide small helper functions so every dashboard builds its
      legends, gender comparisons, and grouped scatter plots the
      same way instead of copy-pasted logic.

   Load this file BEFORE maindash.js / deandash.js in the HTML.
   ===================================================================== */

// ---- 0. DATA LABELS PLUGIN (optional) --------------------------------
// Guarded so pages that haven't added the
// chartjs-plugin-datalabels <script> tag yet don't break — they just
// won't get on-bar labels until that tag is added, everything else
// keeps working exactly as before. Registered OFF by default (a global
// "display: false") so every existing chart on the dashboard keeps
// looking exactly the same; only charts that explicitly set
// `datalabels: { display: ... }` in their own options (like the
// Performance-by-Year-Level chart below) opt in.
if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') {
    Chart.register(ChartDataLabels);
    Chart.defaults.set('plugins.datalabels', { display: false });
}

// ---- 1. FIXED COLLEGE PALETTE (Main Dashboard) ----------------------
// These are the "official" colors for each college. They are reused
// everywhere: ranking bars, scatter dots, forecast lines, legends.
const COLLEGE_COLORS = {
    'CAHS': '#36b9cc',   // teal
    'CBA':  '#e74a3b',   // red
    'CCST': '#8a2be2',   // purple
    'CEA':  '#1cc88a',   // green
    'COAS': '#5a5c69',   // slate gray
    'CTEC': '#4e73df',   // blue
    // Aggregate "all colleges" view on the Main dashboard. Given its own
    // fixed color (instead of falling into the auto-hash palette) so the
    // Main-Campus donuts/legends always look the same, page to page.
    'MAIN CAMPUS': '#2e59d9',
    'ALL': '#2e59d9',
};

// Universal "risk / irregular / at-risk" color. Used on every donut that
// has a "bad outcome" slice (Irregular, At Risk, Dropped) so red always
// means the same thing everywhere on the dashboard, regardless of which
// college or course the "good" slice is colored for.
const RISK_COLOR = '#e74a3b';

// Gender colors (kept the same everywhere a Male/Female split appears)
const GENDER_COLORS = {
    male:   '#4e73df',   // blue
    female: '#e83e8c',   // pink
};

// Generic "unknown / not risk" fallback
const NEUTRAL_COLOR = '#858796';

// Performance-band colors (matches preprocess.py's perf_band() buckets:
// Excellent/Good/Average/Below Average/Failing). Used by the Year-Level
// Risk Grid stacked bar, kept separate from COLLEGE_COLORS since a band
// name and a college code could theoretically collide as object keys.
const PERF_BAND_COLORS = {
    'Excellent':      '#1cc88a',   // green
    'Good':           '#36b9cc',   // teal
    'Average':        '#f6c23e',   // yellow
    'Below Average':  '#fd7e14',   // orange
    'Failing':        '#e74a3b',   // red (matches RISK_COLOR)
    'Unknown':        NEUTRAL_COLOR,
};

// Fixed colors for CAHS's three courses, checked (as a substring match
// against the course's full name) before anything falls through to the
// auto-hash palette below — so these three always render as requested
// instead of whatever the hash happens to land on.
const COURSE_COLORS = {
    'PUBLIC HEALTH': '#FFA07A',  // peach
    'NURSING':        '#4e73df', // blue
    'MIDWIFERY':      '#e83e8c', // pink
};

// A rotating palette used to auto-assign colors to things we don't
// know in advance (e.g. individual COURSES inside CAHS: BSN, BSPT, etc.)
// Colors are picked from this list in a stable order (hashed by name)
// so the same course always gets the same color across page loads.
const AUTO_PALETTE = [
    '#4e73df', '#1cc88a', '#e74a3b', '#f6c23e', '#36b9cc',
    '#8a2be2', '#fd7e14', '#20c997', '#6610f2', '#e83e8c',
    '#17a673', '#2c9faf', '#c0392b', '#5a5c69', '#0d6efd'
];

// Cache so the same course/label always maps to the same auto-color
// even across repeated calls / re-renders.
const _autoColorCache = {};

// Reverse lookup: which label currently "owns" each palette color. Used
// to detect hash collisions (two different labels landing on the same
// AUTO_PALETTE slot) so we can bump the second one to the next free
// color instead of silently letting them look identical, like Midwifery
// and Public Health both coming out the same pink.
const _autoColorOwner = {};

/**
 * Returns a stable hex color for any label (college code OR course name).
 * - Known college codes (CAHS, CBA, ...) always return their fixed color.
 * - Anything else (course names, program names) gets a deterministic
 *   color from AUTO_PALETTE based on a simple hash of the text, so the
 *   SAME course is always the SAME color everywhere on the page.
 * - If two different labels hash to the same slot, the one seen second
 *   is bumped forward to the next unclaimed color in the palette, so
 *   any set of courses shown together (e.g. a college's donut legend)
 *   always reads as visually distinct — the same guarantee colleges get
 *   for free from their fixed COLLEGE_COLORS palette.
 */
function getGroupColor(label) {
    if (!label) return NEUTRAL_COLOR;
    const key = String(label).trim().toUpperCase();

    if (COLLEGE_COLORS[key]) return COLLEGE_COLORS[key];
    for (const courseKey in COURSE_COLORS) {
        if (key.includes(courseKey)) return COURSE_COLORS[courseKey];
    }
    if (_autoColorCache[key]) return _autoColorCache[key];

    let hash = 0;
    for (let i = 0; i < key.length; i++) {
        hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
    }
    const startIdx = hash % AUTO_PALETTE.length;

    // Walk forward from the hashed slot until we find a color nobody
    // else owns yet (or, worst case, we wrap all the way around and
    // just reuse the original slot — only happens once every distinct
    // label in the whole system exceeds the palette size).
    let color = AUTO_PALETTE[startIdx];
    for (let step = 0; step < AUTO_PALETTE.length; step++) {
        const candidateIdx = (startIdx + step) % AUTO_PALETTE.length;
        const candidateColor = AUTO_PALETTE[candidateIdx];
        if (!_autoColorOwner[candidateColor]) {
            color = candidateColor;
            break;
        }
    }

    _autoColorCache[key] = color;
    _autoColorOwner[color] = key;
    return color;
}

/** Convert "#rrggbb" -> "rgba(r,g,b,alpha)" for fills/highlights. */
function hexToRgba(hex, alpha = 1) {
    if (!hex) return `rgba(133,135,150,${alpha})`;
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const bigint = parseInt(hex, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    return `rgba(${r},${g},${b},${alpha})`;
}

/**
 * Picks black or white text for on-bar data labels so a percentage
 * printed directly on a colored segment (e.g. the yellow "Average" band,
 * or a light auto-palette course color) stays readable, instead of
 * always assuming white text works on every color.
 */
function getContrastTextColor(hex) {
    if (!hex) return '#ffffff';
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const bigint = parseInt(hex, 16);
    const r = (bigint >> 16) & 255, g = (bigint >> 8) & 255, b = bigint & 255;
    const yiq = (r * 299 + g * 587 + b * 114) / 1000;
    return yiq >= 150 ? '#212529' : '#ffffff';
}

/**
 * Injects a row of colored "chip" legend items into a container div.
 * entries = [{ label: 'CAHS', color: '#36b9cc' }, ...]
 * Used under multi-line / multi-color charts (INC forecast, scatter)
 * so users who don't know how to read charts can match color -> name.
 */
function renderColorLegend(containerId, entries) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = entries.map(e => `
        <span style="display:inline-flex; align-items:center; margin:0.15rem 0.75rem 0.15rem 0; font-size:0.8rem; color:#5a5c69;">
            <span style="display:inline-block; width:12px; height:12px; border-radius:50%; background-color:${e.color}; margin-right:6px; border:1px solid rgba(0,0,0,0.1);"></span>
            ${e.label}${e.subtitle ? ` <strong style="margin-left:4px; color:${RISK_COLOR};">${e.subtitle}</strong>` : ''}
        </span>
    `).join('');
}

/**
 * Populates #globalYearFilter and #filterSemester from real uploaded data
 * (via /api/get_year_semester_options) instead of a hardcoded "2024".
 *
 * - Year dropdown = real/actual uploaded years ONLY. Forecast years are
 *   deliberately left out — the Recent/Prediction toggle (mode-toggle.js)
 *   already owns showing forecast data, and its own dropdown-disable
 *   logic assumes this list never contains a forecast year.
 * - Semester default: if the latest year only has one semester uploaded
 *   so far, that semester is pre-selected (freshest partial view). Once
 *   both semesters exist for that year, "All Semesters" is selected.
 *
 * Call this once on page load, BEFORE the first chart refresh, and pass
 * your existing triggerUpdate function as the callback.
 */
function initYearSemesterFilters(onReady) {
    const yearSelect = document.getElementById('globalYearFilter');
    const semSelect = document.getElementById('filterSemester');

    if (!yearSelect) { if (onReady) onReady(); return; }

    fetch('/api/get_year_semester_options')
        .then(res => res.json())
        .then(data => {
            if (data.error || !data.years || data.years.length === 0) {
                // No data uploaded yet — leave a single sane default so the
                // page doesn't crash, charts will just show empty states.
                yearSelect.innerHTML = '<option value="2024" selected>2024</option>';
                if (onReady) onReady();
                return;
            }

            yearSelect.innerHTML = data.years.map(y => {
                const isSelected = y === data.latest_year;
                return `<option value="${y}" ${isSelected ? 'selected' : ''}>${y}${isSelected ? ' (Current)' : ''}</option>`;
            }).join('');

            if (semSelect && data.default_semester) {
                semSelect.value = data.default_semester;
            }

            if (onReady) onReady();
        })
        .catch(err => {
            console.error('Year/Semester init failed:', err);
            if (onReady) onReady();
        });
}

/** Convert "#rrggbb" -> [h, s, l] (h in 0-360, s/l in 0-100). */
function hexToHsl(hex) {
    hex = String(hex).replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = parseInt(hex.substr(0, 2), 16) / 255;
    const g = parseInt(hex.substr(2, 2), 16) / 255;
    const b = parseInt(hex.substr(4, 2), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h, s, l = (max + min) / 2;
    if (max === min) {
        h = s = 0;
    } else {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case r: h = (g - b) / d + (g < b ? 6 : 0); break;
            case g: h = (b - r) / d + 2; break;
            default: h = (r - g) / d + 4;
        }
        h /= 6;
    }
    return [h * 360, s * 100, l * 100];
}

/** Convert [h, s, l] (h in 0-360, s/l in 0-100) -> "#rrggbb". */
function hslToHex(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    let r, g, b;
    if (s === 0) {
        r = g = b = l;
    } else {
        const hue2rgb = (p, q, t) => {
            if (t < 0) t += 1;
            if (t > 1) t -= 1;
            if (t < 1 / 6) return p + (q - p) * 6 * t;
            if (t < 1 / 2) return q;
            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
            return p;
        };
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        r = hue2rgb(p, q, h + 1 / 3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1 / 3);
    }
    const toHex = x => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Shifts hue `h` toward `targetHue` by at most `maxDegrees`, always along
 * the shortest arc between them. Used instead of a percentage-of-distance
 * blend so every department gets an equally SMALL, consistent nudge —
 * a percentage blend (e.g. "20% of the way to red") moves hues that
 * start far from red (like teal) much more than hues that start close
 * to it, which is what was pushing CAHS's teal into blue-purple instead
 * of staying a recognizable teal.
 */
function shiftHueToward(h, targetHue, maxDegrees) {
    let diff = ((targetHue - h + 540) % 360) - 180; // shortest signed distance, range -180..180
    const clamped = Math.max(-maxDegrees, Math.min(maxDegrees, diff));
    return ((h + clamped) % 360 + 360) % 360;
}

// Cache so the same label's risk-tint doesn't get recomputed every call.
const _riskColorCache = {};

/**
 * Returns a "risk" version of a college/course's own color — warm-shifted
 * toward red so it still clearly reads as "danger", but the hue is only
 * blended partway, not replaced outright, so a college/course's risk
 * slice still visually relates back to its normal color everywhere else
 * on the dashboard. This is what every "At Risk / Irregular / High Risk"
 * slice should use instead of one flat, generic red.
 */
function getRiskColor(label) {
    const base = getGroupColor(label);
    if (_riskColorCache[base]) return _riskColorCache[base];

    const [h, s, l] = hexToHsl(base);
    // Only a small, FIXED-degree nudge toward red's hue (0/360°) — enough
    // that "Dropped" reads slightly warmer/more alarming, but never more
    // than 15° away from the department's own hue, so the slice is
    // instantly recognizable as belonging to that same department.
    const targetHue = shiftHueToward(h, 0, 15);

    // Differentiate mostly via lightness (a darker SHADE of the same
    // color) rather than a big hue jump, and keep saturation close to
    // the base instead of forcing it to a fixed "always vivid red" level.
    const newSat = Math.min(s + 5, 95);
    const newLight = Math.max(l - 16, 22);

    const result = hslToHex(targetHue, newSat, newLight);
    _riskColorCache[base] = result;
    return result;
}


// Cache so the same label's INC-tint doesn't get recomputed every call.
const _incColorCache = {};

/**
 * Returns an "INC" version of a college/course's own color — shifted
 * partway toward amber/orange, NOT all the way to red like getRiskColor.
 * This lets a donut show Regular / INC / Dropped as three precise,
 * visually distinct slices for the same college or course (instead of
 * lumping INC and Dropped together into one flat "risk" red), while all
 * three still clearly belong to the same color family.
 */
function getIncColor(label) {
    const base = getGroupColor(label);
    if (_incColorCache[base]) return _incColorCache[base];

    const [h, s, l] = hexToHsl(base);
    // Only a small, FIXED-degree nudge toward amber — smaller than
    // getRiskColor's nudge toward red — so Regular/INC/Dropped read as a
    // light → dark family of ONE department color rather than three
    // unrelated hues.
    const targetHue = shiftHueToward(h, 38, 8);

    // Differentiate mostly via lightness (a lighter TINT of the same
    // color, between Regular and the darker Dropped shade).
    const newSat = Math.max(s - 5, 20);
    const newLight = Math.min(l + 14, 78);

    const result = hslToHex(targetHue, newSat, newLight);
    _incColorCache[base] = result;
    return result;
}


/**
 * Returns a lightened variant of a base color for the "Female" slice of
 * a combined Gender x Status donut, so Male/Female stays visually tied
 * to THAT SAME department/course's own color (like every other chart on
 * the dashboard) instead of a generic, unrelated blue/pink pair. Male
 * keeps the base color unchanged; Female is the same hue, just lighter,
 * so the two are still clearly a matched pair belonging to one course.
 */
function getGenderShade(baseHex, isFemale) {
    if (!isFemale) return baseHex;
    const [h, s, l] = hexToHsl(baseHex);
    const newL = Math.min(l + 22, 88);       // lighten, but stay visible
    const newS = Math.max(s - 8, 20);         // slightly softer, not washed out
    return hslToHex(h, newS, newL);
}


/**
 * The backend still calls the two states "Actual" / "Forecast"
 * (data.mode). On screen every badge instead says "Current Data" /
 * "Predicted Data" — this is the ONLY place that mapping lives, so
 * every badge across every dashboard uses the exact same two labels.
 * Only call this for charts that have a REAL prediction model behind
 * them (i.e. `mode` can genuinely be 'Forecast') — a chart with no
 * prediction mode at all should just hardcode "Current Data" directly
 * rather than route through here.
 */
function displayModeLabel(mode) {
    return mode === 'Forecast' ? 'Predicted Data' : 'Current Data';
}

/**
 * Builds a plain-English one-liner for a two-slice donut (Regular vs
 * Irregular, Safe vs At Risk, etc.) so a non-technical viewer gets the
 * takeaway without having to read the chart itself.
 */
function buildDonutSummarySentence(groupLabel, goodLabel, goodValue, badLabel, badValue) {
    const total = goodValue + badValue;
    if (total === 0) return `No data yet for ${groupLabel}.`;
    const badPct = Math.round((badValue / total) * 100);
    const goodPct = 100 - badPct;
    return `Out of ${total.toLocaleString()} ${groupLabel} students, ${goodValue.toLocaleString()} (${goodPct}%) are ${goodLabel} and ${badValue.toLocaleString()} (${badPct}%) are ${badLabel}.`;
}

// ---- YEAR-LEVEL RISK GRID (Stacked Bar) ------------------------------
// Shared by maindash.js (Main dashboard) and deandash.js (dean
// dashboards) — both already pass the exact same three args
// (year, semester, college) into their respective triggerUpdate()
// pipelines, and `college` is ALREADY resolved by the caller before it
// gets here:
//   - Main dashboard: 'all' by default; a specific department/program
//     once the "Department - Course" dropdown picks one.
//   - Dean dashboard (e.g. CAHS): the whole college by default; a
//     specific course once ITS course dropdown picks one.
// Either way this function (and /api/get_year_level_distribution on the
// backend, via resolve_scope()) doesn't need to know or care which
// dashboard called it.
let yearLevelChart;
let yearLevelIncIrregChart;

function updateYearLevelChart(year, semester, college, isPrediction = false) {
    const canvas = document.getElementById('yearLevelChart');
    if (!canvas) return;

    const safeCollege = encodeURIComponent(college || 'all');
    const safeSemester = encodeURIComponent(semester || 'all');

    // Chart TYPE changes between modes (stacked bar <-> multi-line), so
    // any existing instance must be fully destroyed and rebuilt rather
    // than updated in place — Chart.js can't hot-swap type on update().
    const rebuildIfModeChanged = () => {
        const existingOnCanvas = Chart.getChart(canvas);
        if (existingOnCanvas && (!yearLevelChart || yearLevelChart._isPrediction !== isPrediction)) {
            existingOnCanvas.destroy();
            yearLevelChart = null;
        }
    };

    if (isPrediction) {
        fetch(`/api/get_year_level_gwa_forecast?college=${safeCollege}`)
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    console.error("Year Level GWA Forecast Error:", data.error);
                    return;
                }
                rebuildIfModeChanged();

                const labels = data.labels || [];
                const historyCount = data.history_count != null ? data.history_count : labels.length;
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
                        pointRadius: (ctx) => ctx.dataIndex >= historyCount ? 2 : 3,
                        pointBackgroundColor: color,
                        segment: {
                            borderDash: (ctx) => (ctx.p0DataIndex >= historyCount - 1) ? [5, 4] : undefined,
                        },
                    };
                });

                const collText = (college === 'all' || !college) ? 'Main Campus' : college;
                const newTitle = `Predicted GWA by Year Level (${collText})`;
                const ctx = canvas.getContext('2d');

                yearLevelChart = new Chart(ctx, {
                    type: 'line',
                    data: { labels: labels, datasets: datasets },
                    options: {
                        maintainAspectRatio: false,
                        responsive: true,
                        scales: {
                            y: { min: 1.0, max: 5.0, title: { display: true, text: 'Avg GWA (lower = better)' } },
                            x: { title: { display: true, text: 'Academic Year' } },
                        },
                        plugins: {
                            title: { display: true, text: newTitle },
                            legend: { display: true, position: 'bottom' },
                            tooltip: {
                                callbacks: {
                                    label: (ctx) => {
                                        if (ctx.parsed.y === null) return undefined;
                                        const mode = ctx.dataIndex >= historyCount ? 'Forecast' : 'Recent Data';
                                        return ` ${ctx.dataset.label} (${mode}): ${ctx.parsed.y}`;
                                    },
                                },
                            },
                        },
                    },
                });
                yearLevelChart._isPrediction = true;
                // Table Mode (table-view.js) reads this to cut off the
                // dashed forecast tail and only ever show the "Recent
                // Data" rows/columns, never the predicted ones.
                yearLevelChart._historyCount = historyCount;
            })
            .catch(err => console.error("Year Level GWA Forecast fetch failed:", err));
        return;
    }

    fetch(`/api/get_year_level_distribution?year=${year}&semester=${safeSemester}&college=${safeCollege}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("Year Level Distribution Error:", data.error);
                return;
            }

            const labels = data.labels || [];
            const totals = data.totals || [];
            // 'band'    -> one course selected, nothing left to segment by,
            //              so this falls back to the original band-stacked view.
            // 'college' -> Main dashboard: each segment IS a college.
            // 'course'  -> Dean dashboard (e.g. CAHS): each segment IS a course.
            const breakdown = data.breakdown || 'band';

            // Tooltip needs both the % (what's plotted) and the raw
            // headcount (what a dean actually cares about) — "%" alone
            // can hide that e.g. "5th Year" is only 29 students total.
            const datasets = (data.datasets || []).map(ds => {
                const baseColor = breakdown === 'band'
                    ? ((typeof PERF_BAND_COLORS !== 'undefined' && PERF_BAND_COLORS[ds.label]) || '#858796')
                    : getGroupColor(ds.label);
                return {
                    label: ds.label,
                    data: ds.data,
                    counts: ds.counts,
                    bandMix: ds.bandMix,
                    backgroundColor: hexToRgba(baseColor, 0.85),
                    borderColor: '#ffffff',
                    borderWidth: 1,
                    stack: 'yearLevel',
                    // Used only by the on-bar % label below, to pick
                    // readable text color for THIS segment's own fill.
                    _labelTextColor: getContrastTextColor(baseColor),
                };
            });

            const collText = (college === 'all' || !college) ? 'Main Campus' : college;
            const semText = semester === 'all' ? 'Overall' : semester;
            const segmentText = breakdown === 'college' ? 'by College' : breakdown === 'course' ? 'by Course' : 'by Performance Band';
            const newTitle = `Performance by Year Level ${segmentText}: ${year} (${semText} - ${collText})`;

            rebuildIfModeChanged();
            const ctx = canvas.getContext('2d');
            const existingOnCanvas = Chart.getChart(canvas);

            const tooltipCallbacks = {
                afterTitle: (items) => {
                    const idx = items[0].dataIndex;
                    const total = totals[idx];
                    return total ? `${total.toLocaleString()} students` : '';
                },
                label: (ctx) => {
                    const count = ctx.dataset.counts ? ctx.dataset.counts[ctx.dataIndex] : null;
                    const countText = count !== null ? ` (${count.toLocaleString()} students)` : '';
                    return ` ${ctx.dataset.label}: ${ctx.raw}%${countText}`;
                },
                // Only present when breakdown is college/course — shows the
                // performance-band mix INSIDE that segment (e.g. what % of
                // this college's/course's slice is Excellent vs Failing),
                // so that detail isn't lost just because it's no longer the
                // primary stacking dimension.
                afterLabel: (ctx) => {
                    const mix = ctx.dataset.bandMix ? ctx.dataset.bandMix[ctx.dataIndex] : null;
                    if (!mix || !mix.length) return undefined;
                    return mix.map(m => `   ${m.band}: ${m.pct}%`);
                },
            };

            if (yearLevelChart && yearLevelChart.canvas === canvas && existingOnCanvas === yearLevelChart) {
                yearLevelChart.data.labels = labels;
                yearLevelChart.data.datasets = datasets;
                if (yearLevelChart.options.plugins.title) {
                    yearLevelChart.options.plugins.title.text = newTitle;
                }
                yearLevelChart.options.plugins.tooltip.callbacks = tooltipCallbacks;
                yearLevelChart.update();
            } else {
                if (existingOnCanvas) existingOnCanvas.destroy();
                yearLevelChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels: labels, datasets: datasets },
                    options: {
                        maintainAspectRatio: false,
                        responsive: true,
                        scales: {
                            x: { stacked: true, title: { display: true, text: 'Year Level' } },
                            y: {
                                stacked: true,
                                min: 0,
                                max: 100,
                                title: { display: true, text: '% of students in this year level' },
                            },
                        },
                        plugins: {
                            title: { display: true, text: newTitle },
                            legend: { display: true, position: 'bottom' },
                            tooltip: { callbacks: tooltipCallbacks },
                            // Prints the % right on each segment so a
                            // dean can read the breakdown at a glance,
                            // without needing to hover every bar. Hidden
                            // on slivers under 6% so tiny slices don't
                            // get an overlapping/illegible label.
                            datalabels: {
                                display: (context) => {
                                    const v = context.dataset.data[context.dataIndex];
                                    return v !== null && v !== undefined && v >= 6;
                                },
                                color: (context) => context.dataset._labelTextColor || '#ffffff',
                                font: { weight: 'bold', size: 11 },
                                formatter: (value) => `${Math.round(value)}%`,
                            },
                        },
                    },
                });
                yearLevelChart._isPrediction = false;
            }
        })
        .catch(err => console.error("Year Level Distribution fetch failed:", err));
}


// ---- INC / IRREGULAR(behavioral) / DROP RATE BY YEAR LEVEL (Grouped Bar) ----
// Companion to updateYearLevelChart() above — same shared function used
// by both maindash.js and deandash.js, same college-or-course scope
// passthrough. Grouped (not stacked) bar since these three rates are
// independent metrics, not parts of one whole.
// Cache of the last args this chart was drawn with, so the metric
// selector buttons (INC / Irregular / Drop) can re-fetch with a new
// metric without every caller in maindash.js/deandash.js/mode-toggle.js
// needing to track and pass the currently-selected metric themselves.
let _lastIncIrregArgs = { year: null, semester: 'all', college: 'all', isPrediction: false, metric: 'inc' };

// Each metric button carries its own border/text color inline (set in the
// HTML), so "active" just means: filled with that color, white text;
// "inactive" means: white fill, colored border/text. Kept as a plain JS
// helper (rather than a CSS class) since each button's color differs.
function _paintIncIrregMetricButtons(activeMetric) {
    document.querySelectorAll('.inc-irreg-metric-btn').forEach(btn => {
        const isActive = btn.dataset.metric === activeMetric;
        const color = btn.dataset.color || '#4e73df';
        btn.classList.toggle('active', isActive);
        btn.style.background = isActive ? color : '#fff';
        btn.style.color = isActive ? '#fff' : color;
    });
}

function setIncIrregMetric(metric) {
    _lastIncIrregArgs.metric = metric;
    updateYearLevelIncIrregChart(
        _lastIncIrregArgs.year,
        _lastIncIrregArgs.semester,
        _lastIncIrregArgs.college,
        _lastIncIrregArgs.isPrediction,
        metric
    );
    _paintIncIrregMetricButtons(metric);
}

function updateYearLevelIncIrregChart(year, semester, college, isPrediction = false, metric = 'inc') {
    const canvas = document.getElementById('yearLevelIncIrregChart');
    if (!canvas) return;

    _lastIncIrregArgs = { year, semester, college, isPrediction, metric };

    const safeCollege = encodeURIComponent(college || 'all');
    const safeSemester = encodeURIComponent(semester || 'all');

    const rebuildIfModeChanged = () => {
        const existingOnCanvas = Chart.getChart(canvas);
        if (existingOnCanvas && (!yearLevelIncIrregChart || yearLevelIncIrregChart._isPrediction !== isPrediction)) {
            existingOnCanvas.destroy();
            yearLevelIncIrregChart = null;
        }
    };

    if (isPrediction) {
        fetch(`/api/get_year_level_inc_irreg_forecast?college=${safeCollege}&metric=${encodeURIComponent(metric)}`)
            .then(res => res.json())
            .then(data => {
                if (data.error) {
                    console.error("Year Level INC/Irregular Forecast Error:", data.error);
                    return;
                }
                rebuildIfModeChanged();

                const labels = data.labels || [];
                const historyCount = data.history_count != null ? data.history_count : labels.length;
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
                        pointRadius: (ctx) => ctx.dataIndex >= historyCount ? 2 : 3,
                        pointBackgroundColor: color,
                        segment: {
                            borderDash: (ctx) => (ctx.p0DataIndex >= historyCount - 1) ? [5, 4] : undefined,
                        },
                    };
                });

                const collText = (college === 'all' || !college) ? 'Main Campus' : college;
                const metricLabel = data.metric || 'INC Rate';
                const newTitle = `Predicted ${metricLabel} by Year Level (${collText})`;
                const ctx = canvas.getContext('2d');

                yearLevelIncIrregChart = new Chart(ctx, {
                    type: 'line',
                    data: { labels: labels, datasets: datasets },
                    options: {
                        maintainAspectRatio: false,
                        responsive: true,
                        scales: {
                            y: { min: 0, max: 100, title: { display: true, text: 'Rate (%)' } },
                            x: { title: { display: true, text: 'Academic Year' } },
                        },
                        plugins: {
                            title: { display: true, text: newTitle },
                            legend: { display: true, position: 'bottom' },
                            tooltip: {
                                callbacks: {
                                    label: (ctx) => {
                                        if (ctx.parsed.y === null) return undefined;
                                        const mode = ctx.dataIndex >= historyCount ? 'Forecast' : 'Recent Data';
                                        return ` ${ctx.dataset.label} (${mode}): ${ctx.parsed.y}%`;
                                    },
                                },
                            },
                        },
                    },
                });
                yearLevelIncIrregChart._isPrediction = true;
                // Table Mode (table-view.js) reads this to cut off the
                // dashed forecast tail and only ever show the "Recent
                // Data" rows/columns, never the predicted ones.
                yearLevelIncIrregChart._historyCount = historyCount;
            })
            .catch(err => console.error("Year Level INC/Irregular Forecast fetch failed:", err));
        return;
    }

    const safeMetric = encodeURIComponent(metric || 'inc');
    fetch(`/api/get_year_level_inc_irreg?year=${year}&semester=${safeSemester}&college=${safeCollege}&metric=${safeMetric}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("Year Level INC/Irregular Error:", data.error);
                return;
            }

            const labels = data.labels || [];
            const totals = data.totals || [];
            // 'metric'  -> one course selected, nothing left to segment by,
            //              so this falls back to all 3 metrics side by side.
            // 'college' -> Main dashboard: each bar IS a college, for
            //              whichever single metric is currently selected.
            // 'course'  -> Dean dashboard: each bar IS a course.
            const breakdown = data.breakdown || 'metric';

            // Fixed metric->color mapping (not per-year-level) since
            // these are three independent rate series, not a palette
            // keyed by category like PERF_BAND_COLORS.
            const METRIC_COLORS = {
                "INC Rate": '#f6c23e',                        // amber
                "Irregular Rate (behavioral)": '#6f42c1',     // purple
                "Drop Rate": RISK_COLOR,                       // red — matches Failing/dropout elsewhere
            };

            const datasets = (data.datasets || []).map(ds => ({
                label: ds.label,
                data: ds.data,
                counts: ds.counts,
                totalsPerSeg: ds.totals,
                backgroundColor: hexToRgba(
                    breakdown === 'metric' ? (METRIC_COLORS[ds.label] || '#4e73df') : getGroupColor(ds.label),
                    0.85
                ),
                borderColor: '#ffffff',
                borderWidth: 1,
            }));

            const collText = (college === 'all' || !college) ? 'Main Campus' : college;
            const semText = semester === 'all' ? 'Overall' : semester;
            const metricLabel = data.metricLabel || 'INC / Irregular / Drop Rate';
            const segmentText = breakdown === 'college' ? 'by College' : breakdown === 'course' ? 'by Course' : '';
            const newTitle = breakdown === 'metric'
                ? `INC / Irregular / Drop Rate by Year Level: ${year} (${semText} - ${collText})`
                : `${metricLabel} by Year Level ${segmentText}: ${year} (${semText} - ${collText})`;

            // Toggle the metric-selector buttons: only meaningful once a
            // breakdown is active (college/course) — with a single course
            // selected all 3 metrics show at once, so there's nothing to
            // "select" yet.
            document.querySelectorAll('.inc-irreg-metric-selector').forEach(el => {
                el.style.display = breakdown === 'metric' ? 'none' : '';
            });
            _paintIncIrregMetricButtons(metric);

            const tooltipCallbacks = {
                afterTitle: (items) => {
                    const idx = items[0].dataIndex;
                    if (breakdown === 'metric') {
                        const total = totals[idx];
                        return total ? `${total.toLocaleString()} students` : '';
                    }
                    return '';
                },
                label: (ctx) => {
                    const count = ctx.dataset.counts ? ctx.dataset.counts[ctx.dataIndex] : null;
                    if (breakdown === 'metric') {
                        const countText = count !== null ? ` (${count.toLocaleString()} students)` : '';
                        return ` ${ctx.dataset.label}: ${ctx.raw}%${countText}`;
                    }
                    const segTotal = ctx.dataset.totalsPerSeg ? ctx.dataset.totalsPerSeg[ctx.dataIndex] : null;
                    const countText = count !== null && segTotal !== null
                        ? ` (${count.toLocaleString()} of ${segTotal.toLocaleString()} students)`
                        : '';
                    return ` ${ctx.dataset.label}: ${ctx.raw}%${countText}`;
                },
            };

            rebuildIfModeChanged();
            const ctx = canvas.getContext('2d');
            const existingOnCanvas = Chart.getChart(canvas);

            if (yearLevelIncIrregChart && yearLevelIncIrregChart.canvas === canvas && existingOnCanvas === yearLevelIncIrregChart) {
                yearLevelIncIrregChart.data.labels = labels;
                yearLevelIncIrregChart.data.datasets = datasets;
                if (yearLevelIncIrregChart.options.plugins.title) {
                    yearLevelIncIrregChart.options.plugins.title.text = newTitle;
                }
                yearLevelIncIrregChart.options.plugins.tooltip.callbacks = tooltipCallbacks;
                yearLevelIncIrregChart.update();
            } else {
                if (existingOnCanvas) existingOnCanvas.destroy();
                yearLevelIncIrregChart = new Chart(ctx, {
                    type: 'bar',
                    data: { labels: labels, datasets: datasets },
                    options: {
                        maintainAspectRatio: false,
                        responsive: true,
                        scales: {
                            x: { title: { display: true, text: 'Year Level' } },
                            y: {
                                min: 0,
                                title: { display: true, text: 'Rate (%)' },
                            },
                        },
                        plugins: {
                            title: { display: true, text: newTitle },
                            legend: { display: true, position: 'bottom' },
                            tooltip: { callbacks: tooltipCallbacks },
                        },
                    },
                });
                yearLevelIncIrregChart._isPrediction = false;
            }
        })
        .catch(err => console.error("Year Level INC/Irregular fetch failed:", err));
}


function buildComparisonSentence(labelA, valueA, labelB, valueB, metricName) {
    if (valueA === valueB) {
        return `${labelA} and ${labelB} currently have the same ${metricName} (${valueA} each).`;
    }
    const higher = valueA > valueB ? labelA : labelB;
    const lower = valueA > valueB ? labelB : labelA;
    const hiVal = Math.max(valueA, valueB);
    const loVal = Math.min(valueA, valueB);
    const diff = hiVal - loVal;
    return `${higher} has the higher ${metricName} (${hiVal} vs ${loVal} for ${lower}), a difference of ${diff}.`;
}


// COURSE x YEAR-LEVEL DROPOUT/AT-RISK HEATMAP
// Rows = course/program — every course campus-wide on the Main
// dashboard, or just this college's own courses on a dean dashboard;
// columns = year level (1st Year, 2nd Year, 3rd Year, 4th Year,
// Irregular). Each cell's color is that course's Drop Rate (%) for
// that year level, pulled from the same
// /api/get_course_year_level_heatmap numbers behind the "INC/Irregular/
// Drop Rate by Year Level" chart (14_year_level_inc_irreg.csv), just
// pivoted into a full grid instead of collapsed to one bar per level.
// Rendered as a plain HTML table (not Chart.js) since a heatmap IS
// already tabular — table-view.js treats this card as "untouchable"
// (see tableView.js) so Table Mode leaves it exactly as-is.
//
// #heatmapCourseFilter (see maindashboardacademicaffair.html /
// cahsdashboardacademicaffair.html etc) narrows the rows shown to a
// single course. It's intentionally self-contained: it does NOT call
// triggerUpdate() and does NOT re-fetch — it only re-slices the last
// fetched matrix client-side, so it never affects any other chart on
// the page. The global year/semester/college filters still drive the
// actual data fetch as before.
//
// On dean dashboards the page's own "Department - Course" filter
// (#filterCollege there) can already narrow everything down to one
// specific course. When that happens we want the heatmap to follow it
// AND have its own #heatmapCourseFilter dropdown visibly reflect the
// same course, rather than sitting on "All Courses" while every other
// chart is scoped to just one program. Callers do this by passing the
// selected course as the optional 4th argument, `preselectedCourse`.

// Full unfiltered payload from the most recent fetch, so the course
// filter can re-slice it instantly without hitting the API again.
let _heatmapLatestData = null;
// Persists across global filter changes (year/semester/college) within
// the same page load, so switching e.g. Semester doesn't silently reset
// a course the user deliberately picked.
let _heatmapSelectedCourse = 'all';

function updateCourseYearLevelHeatmap(year, semester, college, preselectedCourse) {
    const container = document.getElementById('courseYearLevelHeatmap');
    if (!container) return;

    // #heatmapCard shares the same .card / .card-full-width1 styling as
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

    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;
    const safeSemester = semester || 'all';

    const badge = document.getElementById('heatmap-year-badge');
    if (badge) badge.innerText = `${year}`;

    // If the caller told us which course is selected on the page's own
    // course filter, sync it into the heatmap's local selection now —
    // before the fetch even resolves — so a slow request doesn't leave
    // the dropdown briefly showing the previous course.
    if (typeof preselectedCourse !== 'undefined' && preselectedCourse !== null) {
        _heatmapSelectedCourse = preselectedCourse || 'all';
    }

    fetch(`/api/get_course_year_level_heatmap?year=${year}&semester=${safeSemester}&college=${safeCollege}`)
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
            populateHeatmapCourseFilter(courses);
            renderCourseYearLevelHeatmap();
        })
        .catch(err => {
            console.error("Course Year-Level Heatmap Error:", err);
            _heatmapLatestData = null;
            container.innerHTML = `<p style="color:#858796; text-align:center;">Unable to load heatmap.</p>`;
        });
}

// Rebuilds the #heatmapCourseFilter <option> list from whatever courses
// came back in the latest fetch (this changes as the global college
// filter changes — e.g. picking a single college on the Main dashboard
// shrinks the list to that college's programs). Keeps the user's current
// selection if it's still a valid option; otherwise falls back to "All
// Courses" rather than silently pointing at a course that's no longer
// in the data.
function populateHeatmapCourseFilter(courses) {
    const filterEl = document.getElementById('heatmapCourseFilter');
    if (!filterEl) return;

    const stillValid = courses.includes(_heatmapSelectedCourse);
    if (!stillValid) _heatmapSelectedCourse = 'all';

    const optionsHtml = ['<option value="all">All Courses</option>']
        .concat(courses.map(c => `<option value="${escapeHtmlAttr(c)}">${c}</option>`))
        .join('');
    filterEl.innerHTML = optionsHtml;
    filterEl.value = _heatmapSelectedCourse;

    // A <select> with no explicit width sizes itself to whatever option
    // text is currently selected — pick a long course name and the box
    // itself grows/shrinks, unlike the fixed-size Semester/College/Year
    // filters next to it. Lock it to match one of those siblings once,
    // so it always stays the same size as "the other" dropdowns no
    // matter which course gets selected afterward.
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
            renderCourseYearLevelHeatmap();
        });
    }
}

// Small helper so course names with quotes/ampersands can't break the
// generated <option value="..."> markup.
function escapeHtmlAttr(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Renders the heatmap from _heatmapLatestData, sliced down to
// _heatmapSelectedCourse if it isn't "all". Pure re-render — never
// fetches, never touches any other chart.
//
// Builds TWO views into the same container: the colored heatmap grid
// (Chart Mode) and a plain numbers-only table (Table Mode) — same
// rows/columns, just without the color scale, matching how every other
// chart on the dashboard turns into a plain table in Table Mode.
// _syncHeatmapCardVisibility() (called at the end here, and from
// tableView.js's setFormat()) shows whichever one matches the current
// mode.
function renderCourseYearLevelHeatmap() {
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

    // Fixed 0-50%+ color scale (not this selection's own min/max)
    // so a cell's color always means the same real-world risk
    // level no matter which college/year is filtered — switching
    // filters won't silently repaint "10% dropout" dark red just
    // because everything else currently in view happens to be
    // even lower.
    function heatColor(rate) {
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
    const textColor = (rate) => (rate >= 22 ? '#ffffff' : '#212529');

    // Columns = year level, rows = course/program.
    const headerCells = levels.map(level => `
        <th style="padding:0.55rem 0.6rem; font-size:0.72rem; font-weight:700; color:#5a5c69; text-align:center; white-space:nowrap; border-bottom:2px solid #e3e6f0;">${level}</th>
    `).join('');

    const bodyRows = courses.map((course, ci) => {
        const cells = (matrix[ci] || []).map(cell => {
            const rate = cell.rate || 0;
            const total = cell.total || 0;
            const bg = total > 0 ? heatColor(rate) : '#eef0f5';
            const fg = total > 0 ? textColor(rate) : '#b7bdc9';
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

    // Plain (uncolored) version of the exact same rows/columns for
    // Table Mode — no background scale, no title tooltips, just the
    // numbers, same as every other chart's generated table elsewhere
    // on the dashboard.
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

// Shows whichever of the two views built by renderCourseYearLevelHeatmap
// above matches the dashboard's current Chart Mode / Table Mode — the
// colored heatmap grid in Chart Mode, the plain numbers table in Table
// Mode. Called here after every re-render and from tableView.js's
// setFormat() when the pill itself is toggled.
function _syncHeatmapCardVisibility() {
    const chartView = document.getElementById('courseYearLevelHeatmapChartView');
    const tableView = document.getElementById('courseYearLevelHeatmapTableView');
    if (!chartView || !tableView) return;
    const isTable = (typeof DisplayFormat !== 'undefined' && DisplayFormat.current === 'table');
    chartView.style.display = isTable ? 'none' : '';
    tableView.style.display = isTable ? '' : 'none';
}