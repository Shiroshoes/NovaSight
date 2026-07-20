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
            ${e.label}
        </span>
    `).join('');
}

/**
 * Populates #globalYearFilter and #filterSemester from real uploaded data
 * (via /api/get_year_semester_options) instead of a hardcoded "2024".
 *
 * - Year dropdown = every year that has real data, PLUS the forecast
 *   years the models can predict (marked "(Forecast)").
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

            const forecastYears = data.forecast_years || [];
            const allYears = [...data.years, ...forecastYears];

            yearSelect.innerHTML = allYears.map(y => {
                const isForecast = y > data.latest_year;
                const isSelected = y === data.latest_year;
                return `<option value="${y}" ${isSelected ? 'selected' : ''}>${y}${isForecast ? ' (Forecast)' : ''}</option>`;
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
 * The backend still calls the "not forecast" state "Actual" (data.mode).
 * On screen we show the friendlier "Recent Data" instead — this is the
 * ONLY place that mapping lives, so every badge/label across every
 * dashboard says the same thing.
 */
function displayModeLabel(mode) {
    return mode === 'Forecast' ? 'Forecast' : 'Recent Data';
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

function updateYearLevelChart(year, semester, college) {
    const canvas = document.getElementById('yearLevelChart');
    if (!canvas) return;

    const safeCollege = encodeURIComponent(college || 'all');
    const safeSemester = encodeURIComponent(semester || 'all');

    fetch(`/api/get_year_level_distribution?year=${year}&semester=${safeSemester}&college=${safeCollege}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("Year Level Distribution Error:", data.error);
                return;
            }

            const labels = data.labels || [];
            const totals = data.totals || [];

            // Tooltip needs both the % (what's plotted) and the raw
            // headcount (what a dean actually cares about) — "%" alone
            // can hide that e.g. "5th Year" is only 29 students total.
            const datasets = (data.datasets || []).map(ds => ({
                label: ds.label,
                data: ds.data,
                counts: ds.counts,
                backgroundColor: hexToRgba(
                    (typeof PERF_BAND_COLORS !== 'undefined' && PERF_BAND_COLORS[ds.label]) || '#858796',
                    0.85
                ),
                borderColor: '#ffffff',
                borderWidth: 1,
                stack: 'yearLevel',
            }));

            const collText = (college === 'all' || !college) ? 'Main Campus' : college;
            const semText = semester === 'all' ? 'Overall' : semester;
            const newTitle = `Performance by Year Level: ${year} (${semText} - ${collText})`;

            const ctx = canvas.getContext('2d');
            const existingOnCanvas = Chart.getChart(canvas);

            if (yearLevelChart && yearLevelChart.canvas === canvas && existingOnCanvas === yearLevelChart) {
                yearLevelChart.data.labels = labels;
                yearLevelChart.data.datasets = datasets;
                if (yearLevelChart.options.plugins.title) {
                    yearLevelChart.options.plugins.title.text = newTitle;
                }
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
                            tooltip: {
                                callbacks: {
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
                                },
                            },
                        },
                    },
                });
            }
        })
        .catch(err => console.error("Year Level Distribution fetch failed:", err));
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