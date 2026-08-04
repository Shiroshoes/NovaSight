let statusRegularChart;
let statusIrregularChart;
let incForecastChart;
let hardestSubjectCharts = {}; // one line chart per course, keyed by course name
let dropoutSpikeChart;
let maleStatusGridDonuts = {};   // one Regular/INC/Dropped donut per COURSE, Male grid, keyed by course name
let femaleStatusGridDonuts = {}; // same as above, Female grid, keyed by course name
let gwaScatterChart;
let courseStatusGenderDonuts = {}; // two Regular/Irregular donuts (Male + Female) per course, keyed by `${course}_male` / `${course}_female`

document.addEventListener("DOMContentLoaded", function() {
    console.log("--- Dashboard Logic Loaded ---");

    // GET FILTERS
    const yearSelector = document.getElementById('globalYearFilter');
    const semSelector = document.getElementById('filterSemester');
    // FIX: this dropdown (Department - Course) was never wired up in here.
    // It was only ever read once on page load by the inline HTML script
    // (for ModeAwareCharts.init) and on mode-toggle clicks — every chart
    // driven by THIS file always used the fixed COLLEGE_NAME Python
    // variable and completely ignored whatever course the user picked.
    const courseSelector = document.getElementById('filterCollege');

    // FIX: the old fallback here was a hardcoded `2024`, so once the
    // #globalYearFilter dropdown was removed from the page, every chart
    // silently requested year=2024 forever — never advancing even after
    // new school years were uploaded and retrained. Fetched once below
    // from /api/get_year_semester_options (same source the mode-toggle
    // pills use) and kept current for the life of the page.
    let LATEST_REAL_YEAR_FALLBACK = null;

    // MASTER TRIGGER FUNCTION
    function triggerUpdate() {
        // Get Values (default to the real latest uploaded year, not a
        // hardcoded one, if elements are missing)
        const year = yearSelector ? yearSelector.value : LATEST_REAL_YEAR_FALLBACK;
        const semester = semSelector ? semSelector.value : 'all';

        // CRITICAL: Uses the Python variable injected into HTML as the
        // baseline (whole college), but if the user picked a specific
        // course from the "Department - Course" dropdown, that course
        // takes priority over the whole-college default.
        const wholeCollege = (typeof COLLEGE_NAME !== 'undefined') ? COLLEGE_NAME : 'all';
        const courseValue = courseSelector ? courseSelector.value : null;
        const college = (courseValue && courseValue !== wholeCollege) ? courseValue : wholeCollege;

        if (college === 'all') {
            console.warn(" Warning: COLLEGE_NAME is 'all'. Is the Python variable set correctly?");
        }

        console.log(` Fetching Data for: ${college} | Year: ${year} | Sem: ${semester}`);

        // Scatter no longer needs `year` — it always shows every real
        // year plus the forecast horizon as its own columns.
        if (typeof updateGwaScatter === 'function') updateGwaScatter(college, semester);
        if (typeof updateDropoutPie === 'function') updateDropoutPie(year, college);
        
        if (typeof updateKPIMetrics === 'function') updateKPIMetrics(year, semester, college);
        if (typeof updateStatusChart === 'function') updateStatusChart(year, semester, college);
        if (typeof updateKPIMetrics === 'function') updateIncForecast(college);
        if (typeof updateDropoutSpike === 'function') updateDropoutSpike(college);
        if (typeof updateHardestSubjectsByCourse === 'function') updateHardestSubjectsByCourse(college);
        if (typeof updateStatusByCourse === 'function') updateStatusByCourse(year, semester, college);
        if (typeof updateYearLevelChart === 'function') updateYearLevelChart(year, semester, college);
        if (typeof updateYearLevelIncIrregChart === 'function') updateYearLevelIncIrregChart(year, semester, college);
        if (typeof updateCourseYearLevelHeatmap === 'function') updateCourseYearLevelHeatmap(year, semester, college);

        // Keep Table Mode (table-view.js) in sync too — no-op if Chart
        // Mode is currently active or the module isn't loaded.
        if (typeof DisplayFormat !== 'undefined') DisplayFormat.refresh(year, semester, college);
    }

    // INITIAL LOAD
    // Fetch the real latest uploaded year FIRST (so LATEST_REAL_YEAR_FALLBACK
    // is correct before anything renders), then populate Year/Semester from
    // real uploaded data (instead of assuming "2024"), then run the first
    // chart refresh.
    let _initFired = false;
    function _safeInit() {
        if (!_initFired) { _initFired = true; triggerUpdate(); }
    }
    fetch('/api/get_year_semester_options')
        .then(res => res.json())
        .then(info => {
            if (info && info.latest_year) LATEST_REAL_YEAR_FALLBACK = info.latest_year;
        })
        .catch(err => console.error('Failed to fetch latest uploaded year:', err))
        .finally(() => {
            if (typeof initYearSemesterFilters === 'function') {
                initYearSemesterFilters(_safeInit);
            } else {
                setTimeout(_safeInit, 800);
            }
        });

    // 4. LISTENERS
    if (yearSelector) yearSelector.addEventListener('change', function() {
        _initFired = true;        // cancel the timeout fallback
        // The Year dropdown only ever offers real/actual years — picking
        // one always means "show me Recent data for this year", so flip
        // the pill back to Recent first if Prediction was active.
        if (typeof ModeAwareCharts !== 'undefined' && ModeAwareCharts.currentMode === 'prediction') {
            const courseVal = courseSelector ? courseSelector.value : (typeof COLLEGE_NAME !== 'undefined' ? COLLEGE_NAME : 'all');
            const semVal = semSelector ? semSelector.value : 'all';
            ModeAwareCharts.setMode('recent', courseVal, semVal);
        }
        triggerUpdate();
    });
    if (semSelector) semSelector.addEventListener('change', triggerUpdate);
    if (courseSelector) courseSelector.addEventListener('change', function() {
        _initFired = true;        // cancel the timeout fallback
        triggerUpdate();
    });
});


// --- 1. CHART: GWA TREND SCATTER PLOT ---
function updateGwaScatter(college, semester) {
    const canvas = document.getElementById('gwaScatterChart');
    const titleEl = document.getElementById('scatterSubtitle'); // Get the new span
    if (!canvas) return;

    const safeCollege = college || 'all';
    const safeSemester = semester || 'all';

    // 1. Update the Header Text Immediately
    if (titleEl) {
        // Format College
        let colText = (safeCollege === 'all' || safeCollege === '') ? 'Main Campus' : safeCollege;
        
        // Format Semester
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
    fetch(`/api/get_gwa_scatter?college=${safeCollege}&semester=${safeSemester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("Scatter API Fail:", data.error);

            const ctx = canvas.getContext('2d');

            if (gwaScatterChart) {
                gwaScatterChart.destroy();
            }

            const allYears = [...(data.real_years || []), ...(data.forecast_years || [])];
            const minYear = allYears.length ? Math.min(...allYears) : 2024;
            const maxYear = allYears.length ? Math.max(...allYears) : 2024;
            const lastRealYear = data.latest_real_year;

            // Group dots by COURSE (e.g. BSN, BSPT...) and color each
            // group with the shared palette, so a dot's color tells you
            // the student's course at a glance — same colors used in the
            // hardest-subjects panels and INC forecast lines below.
            const groupsPresent = {};
            data.data.forEach(pt => {
                const g = pt.course || 'Unknown';
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

            if (typeof renderColorLegend === 'function') {
                renderColorLegend('scatterColorLegend', Object.keys(groupsPresent).sort().map(g => ({
                    label: g, color: getGroupColor(g)
                })));
            }
        })
        .catch(err => console.error("Scatter Chart Error:", err));
}


// --- MALE & FEMALE RETENTION DONUTS (separate, comparable) ---
function updateDropoutPie(year, college) {
    const semDropdown = document.getElementById('filterSemester');
    const semester = semDropdown ? semDropdown.value : 'all';

    // ── Badge / title / summary numbers / "who's higher" sentence still
    // come from the aggregate endpoint, unchanged.
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

            const [mStay, fStay, mRisk, fRisk] = data.data;
            const mTotal = mStay + mRisk;
            const fTotal = fStay + fRisk;

            // Year label only (shared across both cards) — no status
            // pill here. The Retention & Risk donuts underneath
            // (get_gender_status_breakdown) have no real prediction
            // model behind them; even when the dashboard is in
            // Prediction mode, that endpoint silently falls back to the
            // latest real year's actual data, so a "Current"/"Predicted"
            // badge would never be meaningful here — just show the year.
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

            const compareEl = document.getElementById('gender-risk-comparison');
            if (compareEl && typeof buildComparisonSentence === 'function') {
                const maleRiskPct = mTotal > 0 ? Math.round((mRisk / mTotal) * 100) : 0;
                const femaleRiskPct = fTotal > 0 ? Math.round((fRisk / fTotal) * 100) : 0;
                compareEl.innerText = buildComparisonSentence('Male students', maleRiskPct, 'Female students', femaleRiskPct, '% at risk of dropping/incomplete');
            }

            // Recolor header dots to match this college (shared palette —
            // same treatment as Main dashboard and the Status donut).
            const safeCollege = (college === 'all' || college === '' || college === 'Overall') ? 'Main Campus' : college;
            const entityLabel = safeCollege === 'Main Campus' ? 'Main Campus' : safeCollege.toUpperCase();
            const entityColor = typeof getGroupColor === 'function' ? getGroupColor(entityLabel) : "#36b9cc";

            ['dp-dot-m', 'dp-dot-f'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.style.backgroundColor = entityColor;
            });
        })
        .catch(err => console.error("Dropout Pie Fatal Error:", err));

    // ── Precise Regular / INC / Dropped grid, grouped PER COURSE inside
    // this college (e.g. every course inside CAHS).
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



// 3. KPI METRICS (Total Students & GWA)
function updateKPIMetrics(year, semester, college) {
    // Defensive: mirrors the same sanitization in maindash.js — a
    // literal "Main Campus" value (rather than "all") would otherwise
    // match zero rows on the backend.
    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;
    const url = `/api/get_kpi_metrics?year=${year}&semester=${semester}&college=${safeCollege}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.error("KPI Error:", data.error);
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

            if (!elStudents || !elGWA) {
                console.warn("KPI Elements not found in HTML.");
                return;
            }

            // 2. Update Values — data.students/gwa are required at this
            // point (error case already returned above), but keep a
            // last-line-of-defense fallback rather than silently
            // rendering "0" for a genuinely malformed-but-error-free
            // payload.
            if (data.students === undefined || data.gwa === undefined) {
                console.error("KPI response missing students/gwa, leaving cards as-is:", data);
                return;
            }
            const safeStudents = data.students;
            const safeGWA = data.gwa;
            // Total Drop is a newer field — default to 0 rather than
            // treating an older/malformed payload as a hard error.
            const safeDrop = data.drop === undefined ? 0 : data.drop;
            const isPred = data.is_prediction;

            if (isPred && typeof PredictionStyle !== 'undefined') {
                PredictionStyle.applyKpiPredictionStyle(cardStudents, elStudents, {
                    rawValue: safeStudents.toLocaleString(),
                });
                PredictionStyle.applyKpiPredictionStyle(cardGWA, elGWA, {
                    rawValue: Number(safeGWA).toFixed(2),
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
                elStudents.innerText = safeStudents.toLocaleString();
                elGWA.innerText = Number(safeGWA).toFixed(2);
                if (elDrop) elDrop.innerText = safeDrop.toLocaleString();
            }

            // 3. Dynamic Styling (Blue = History, Orange = AI Prediction)
            
            // Colors
            const colorPrimary = isPred ? '#f6ad55' : '#4e73df'; // Orange vs Blue
            const colorSecondary = isPred ? '#f6ad55' : '#1cc88a'; // Orange vs Green
            const suffix = isPred ? `(Predicted Data — ${year})` : `(${year})`;
            // Same predicted headcount as before — just a clearer label
            // while in Prediction mode, since "Total Enrollment" reads
            // as a snapshot rather than a forecast.
            const studentsLabel = isPred ? 'Enrollment Increase' : 'Total Enrollment';

            // Apply Styles: Students Card
            if(cardStudents) cardStudents.style.borderLeftColor = colorPrimary;
            if(titleStudents) {
                titleStudents.style.color = colorPrimary;
                titleStudents.innerText = `${studentsLabel} ${suffix}`;
            }

            // Apply Styles: GWA Card
            if(cardGWA) cardGWA.style.borderLeftColor = colorSecondary;
            if(titleGWA) {
                titleGWA.style.color = colorSecondary;
                titleGWA.innerText = `Average GWA ${suffix}`;
            }

            // Apply Styles: Total Drop Card (maroon stays maroon either
            // way — a dropout count reads as a warning color regardless
            // of Actual vs Predicted, unlike the blue/orange history-vs-
            // forecast split used for the other two cards)
            const dropLabel = isPred ? 'Projected Drop' : 'Total Drop';
            if(titleDrop) titleDrop.innerText = `${dropLabel} ${suffix}`;
        })
        .catch(err => console.error("KPI Error:", err));
}






// piechart
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

    const entityLabel = (safeCollege === 'all') ? 'Main Campus' : safeCollege.toUpperCase();

    // Same principle as the Main dashboard's "all colleges" view, just
    // applied TWICE: one donut breaks Regular into one slice PER COURSE
    // inside this college, and a second donut does the same for
    // Irregular — both colored with each course's own shared color
    // (getGroupColor), instead of Irregular being just a plain number.
    if (labelReg) labelReg.innerText = 'Regular — by Course';
    if (labelIrr) labelIrr.innerText = 'Irregular — by Course';
    if (dotReg) dotReg.style.color = getGroupColor(entityLabel);
    if (dotIrr) dotIrr.style.color = getRiskColor(entityLabel);

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
                // badges (drop-pie-badge, above): this only ever renders
                // in Recent mode — Prediction mode swaps in a separate
                // trend-line chart entirely (see mode-toggle.js's
                // _renderStatusCharts) — so a "Current Data" pill here
                // was implying a live/vs-forecast distinction that
                // doesn't actually exist on this card. Just show the year.
                badges.forEach(badge => {
                    badge.innerText = `${data.year || year}`;
                    badge.style.backgroundColor = "transparent";
                    badge.style.color = "#5a5c69";
                });
            }
            if (summaryEl && typeof buildDonutSummarySentence === 'function') {
                summaryEl.innerText = buildDonutSummarySentence(entityLabel, 'Regular', totalReg, 'Irregular', totalIrr);
            }

            const legendEl = document.getElementById('status-plain-summary-legend');
            const irrLegendEl = document.getElementById('status-irregular-legend');

            // --- REGULAR DONUT: one slice per course ---
            const regRows = courses.filter(c => c.regular > 0);
            if (regRows.length === 0) {
                statusRegularChart = renderDonut(statusRegularChart, regCtx, ['No Data'], [1], ['#e3e6f0'], () => ' No Data');
                if (legendEl) legendEl.innerHTML = '';
            } else {
                const regLabels = regRows.map(c => c.course);
                const regValues = regRows.map(c => c.regular);
                const regColors = regRows.map(c => getGroupColor(c.course));

                statusRegularChart = renderDonut(statusRegularChart, regCtx, regLabels, regValues, regColors, (context) => {
                    const row = regRows[context.dataIndex];
                    const pct = totalReg > 0 ? Math.round((row.regular / totalReg) * 100) : 0;
                    return ` ${row.course}: ${row.regular.toLocaleString()} Regular (${pct}% of ${entityLabel}'s Regular students)`;
                });

                if (typeof renderColorLegend === 'function') {
                    renderColorLegend('status-plain-summary-legend', regLabels.map(l => ({ label: l, color: getGroupColor(l) })));
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
                const irrColors = irrRows.map(c => getGroupColor(c.course));

                statusIrregularChart = renderDonut(statusIrregularChart, irrCtx, irrLabels, irrValues, irrColors, (context) => {
                    const row = irrRows[context.dataIndex];
                    const pct = totalIrr > 0 ? Math.round((row.irregular / totalIrr) * 100) : 0;
                    return ` ${row.course}: ${row.irregular.toLocaleString()} Irregular (${pct}% of ${entityLabel}'s Irregular students)`;
                });

                if (typeof renderColorLegend === 'function') {
                    renderColorLegend('status-irregular-legend', irrLabels.map(l => ({ label: l, color: getGroupColor(l) })));
                }
            }
        })
        .catch(err => console.error("Status Pie Fatal:", err));
}



//inc line chart
function updateIncForecast(college) {
    const canvas = document.getElementById('incForecastChart');
    if (!canvas) return;

    // Sanitize input
    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;

    // by=course -> one colored line per COURSE inside this college (e.g.
    // CAHS's BSN, BSPT, BSMT...), instead of one flat line for the whole college.
    fetch(`/api/get_inc_forecast?college=${safeCollege}&by=course`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("INC Forecast Error:", data.error);

            const ctx = canvas.getContext('2d');
            const labels = data.years;

            if (incForecastChart) {
                incForecastChart.destroy();
            }

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
                        legend: { display: false }, // using color-chip legend below instead
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

            if (typeof renderColorLegend === 'function') {
                renderColorLegend('incForecastLegend', (data.series || []).map(s => ({
                    label: s.label, color: getGroupColor(s.label)
                })));
            }
        })
        .catch(err => console.error("INC Chart Fatal:", err));
}


// --- TOP 5 HARDEST SUBJECTS, MULTI-LINE CHART PER COURSE ---
// One card + one MULTI-line chart per course (own canvas): each of that
// course's top-5 hardest subjects gets its OWN line, tracking that
// subject's average grade across the years of real data. Still one
// chart PER COURSE (never mixing courses together) — just now each
// course's chart itself has 5 lines instead of 1. Subject lines are
// colored with getGroupColor (same stable auto-palette used for course
// names) so a subject's color stays consistent across re-renders.
function updateHardestSubjectsByCourse(college) {
    // Two supported layouts, chosen automatically:
    //
    // 1. DEDICATED PER-COURSE CARDS — used when the page defines
    //    window.HARDEST_SUBJECTS_COURSE_CARDS = { keyword: containerId, ... }
    //    (e.g. the CAHS dean dashboard, which has one named card per
    //    course). Each course's chart is matched to its own card by a
    //    case-insensitive substring match on the course name, and drawn
    //    bigger since it's the only chart in that card.
    //
    // 2. SHARED CONTAINER — the old behavior, still used on pages (like
    //    the Main dashboard) that show every course's chart together in
    //    one #hardestSubjectsByCourseContainer, as a grid of mini-cards.
    const cardMap = window.HARDEST_SUBJECTS_COURSE_CARDS;
    const dedicatedMode = !!cardMap;

    const sharedContainer = document.getElementById('hardestSubjectsByCourseContainer');
    if (!dedicatedMode && !sharedContainer) return;

    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;

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

/** Draws one course's 5-subject line chart + legend into a canvas/legend pair. */
function drawHardestSubjectChart(course, canvas, legendEl) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (hardestSubjectCharts[course.course]) {
        hardestSubjectCharts[course.course].destroy();
    }

    const years = course.years || [];
    const subjects = course.subjects || [];
    const historyCount = course.history_count != null ? course.history_count : years.length;

    const datasets = subjects.map(s => {
        const color = getGroupColor(s.subject);
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

    hardestSubjectCharts[course.course] = new Chart(ctx, {
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
    hardestSubjectCharts[course.course]._historyCount = historyCount;

    if (legendEl && typeof renderColorLegend === 'function') {
        renderColorLegend(legendEl.id, subjects.map(s => ({
            label: s.subject,
            color: getGroupColor(s.subject),
            // Fail count front-and-center in the legend, not just on
            // hover — the easiest place to spot it at a glance.
            subtitle: s.failCount ? `${s.failCount.toLocaleString()} failed` : null
        })));
    }
}

/** Layout 1: one course's chart per its own dedicated card (bigger, since it's the only chart there). */
function renderHardestSubjectsDedicated(courses, cardMap) {
    Object.entries(cardMap).forEach(([keyword, containerId]) => {
        const el = document.getElementById(containerId);
        if (!el) return;

        // The card wrapping this container (title + description + the
        // container itself) — hidden entirely when this course isn't part
        // of the current selection, instead of showing an empty/placeholder
        // card. Falls back to just the container itself if no wrapping
        // ".card" is found, so this still degrades gracefully on markup
        // that doesn't use that class.
        const card = el.closest('.card') || el;

        const match = courses.find(c => c.course && c.course.toLowerCase().includes(keyword.toLowerCase()));
        if (!match) {
            card.style.display = 'none';
            return;
        }

        card.style.display = '';
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

/** Layout 2 (unchanged): every course's chart together as a grid of mini-cards in one container. */
function renderHardestSubjectsShared(courses, container) {
    // Build one card + canvas + legend div per course (only once — reuse on updates)
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



// --- IRREGULAR + GENDER, TWO DONUTS PER COURSE (MALE / FEMALE) ---
// One card PER COURSE, with TWO separate small donuts side by side:
// one for Male (Regular vs Irregular), one for Female (Regular vs
// Irregular). Colored from THAT course's own color family
// (getGroupColor / getRiskColor via getGenderShade), so Male/Female
// still ties back to that course's color everywhere else on the
// dashboard instead of a generic, unrelated blue/pink pair.
function updateStatusByCourse(year, semester, college) {
    const container = document.getElementById('courseStatusBreakdownContainer');
    if (!container) return;

    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;
    const safeSemester = semester || 'all';

    fetch(`/api/get_status_by_course?year=${year}&semester=${safeSemester}&college=${safeCollege}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                container.innerHTML = `<p style="color:#858796; text-align:center; width:100%;">${data.error}</p>`;
                return;
            }
            const courses = data.courses || [];
            if (courses.length === 0) {
                container.innerHTML = `<p style="color:#858796; text-align:center; width:100%;">No course-level status data available yet.</p>`;
                return;
            }

            // Build one card per course, with TWO canvases inside (Male / Female)
            container.innerHTML = courses.map(c => {
                const id = c.course.replace(/[^a-zA-Z0-9]/g, '_');
                const color = getGroupColor(c.course);
                const courseTotal = (c.male_safe + c.male_risk) + (c.female_safe + c.female_risk);
                return `
                <div style="flex: 1 1 420px; max-width: 480px; background:#fff; border:1px solid #e3e6f0; border-radius: 0.5rem; padding: 1rem; margin: 0.5rem;">
                    <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:0.5rem;">
                        <h6 style="margin:0; font-size:0.95rem; font-weight:700; color:${color};">
                            <span style="display:inline-block; width:11px; height:11px; border-radius:50%; background-color:${color}; margin-right:6px;"></span>
                            ${c.course}
                        </h6>
                        <span style="font-size:0.8rem; font-weight:700; color:#fff; background-color:${color}; border-radius:1rem; padding:0.2rem 0.65rem; white-space:nowrap;">
                            ${courseTotal.toLocaleString()} students
                        </span>
                    </div>
                    <div style="display:flex; gap:0.75rem;">
                        <div style="flex:1; text-align:center;">
                            <div style="position:relative; height:260px;">
                                <canvas id="courseStatusMaleDonut_${id}"></canvas>
                            </div>
                            <div style="font-size:0.75rem; font-weight:600; color:#5a5c69; margin-top:0.3rem;">Male</div>
                            <div id="courseStatusMaleLegend_${id}" style="margin-top:0.35rem; font-size:0.72rem;"></div>
                        </div>
                        <div style="flex:1; text-align:center;">
                            <div style="position:relative; height:260px;">
                                <canvas id="courseStatusFemaleDonut_${id}"></canvas>
                            </div>
                            <div style="font-size:0.75rem; font-weight:600; color:#5a5c69; margin-top:0.3rem;">Female</div>
                            <div id="courseStatusFemaleLegend_${id}" style="margin-top:0.35rem; font-size:0.72rem;"></div>
                        </div>
                    </div>
                    <div style="text-align:center; font-size:0.7rem; color:#858796; margin-top:0.5rem;">
                        Regular vs Irregular, per gender
                    </div>
                </div>`;
            }).join('');

            courses.forEach(c => {
                const id = c.course.replace(/[^a-zA-Z0-9]/g, '_');

                const maleCanvas = document.getElementById(`courseStatusMaleDonut_${id}`);
                const femaleCanvas = document.getElementById(`courseStatusFemaleDonut_${id}`);
                if (!maleCanvas || !femaleCanvas) return;

                if (courseStatusGenderDonuts[c.course + '_male']) courseStatusGenderDonuts[c.course + '_male'].destroy();
                if (courseStatusGenderDonuts[c.course + '_female']) courseStatusGenderDonuts[c.course + '_female'].destroy();

                const maleTotal = c.male_safe + c.male_risk;
                const femaleTotal = c.female_safe + c.female_risk;

                const courseColor = getGroupColor(c.course);
                const courseRisk = getRiskColor(c.course);

                const donutOptions = (total) => ({
                    maintainAspectRatio: false,
                    cutout: '55%',
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: (ctx) => {
                                    const pct = total > 0 ? Math.round((ctx.raw / total) * 100) : 0;
                                    return ` ${ctx.label}: ${ctx.raw} (${pct}%)`;
                                }
                            }
                        }
                    }
                });

                // Text value-legend under each donut, bullet-colored to match
                // that donut's own slices (course color / risk-tint), same
                // "● count Label (Gender)" style used for the campus-wide
                // Confirmed Drop / Incomplete / AI-Predicted legend.
                const maleLegendEl = document.getElementById(`courseStatusMaleLegend_${id}`);
                if (maleLegendEl) {
                    maleLegendEl.innerHTML = `
                        <div style="color:${courseColor}; font-weight:700;">● ${c.male_safe.toLocaleString()} Regular (Male)</div>
                        <div style="color:${courseRisk}; font-weight:700;">● ${c.male_risk.toLocaleString()} Irregular (Male)</div>
                    `;
                }
                const femaleLegendEl = document.getElementById(`courseStatusFemaleLegend_${id}`);
                if (femaleLegendEl) {
                    femaleLegendEl.innerHTML = `
                        <div style="color:${getGenderShade(courseColor, true)}; font-weight:700;">● ${c.female_safe.toLocaleString()} Regular (Female)</div>
                        <div style="color:${getGenderShade(courseRisk, true)}; font-weight:700;">● ${c.female_risk.toLocaleString()} Irregular (Female)</div>
                    `;
                }

                courseStatusGenderDonuts[c.course + '_male'] = new Chart(maleCanvas.getContext('2d'), {
                    type: 'doughnut',
                    data: {
                        labels: ['Regular', 'Irregular'],
                        datasets: [{
                            data: [c.male_safe, c.male_risk],
                            backgroundColor: [courseColor, courseRisk],
                            borderWidth: 2
                        }]
                    },
                    options: donutOptions(maleTotal)
                });

                courseStatusGenderDonuts[c.course + '_female'] = new Chart(femaleCanvas.getContext('2d'), {
                    type: 'doughnut',
                    data: {
                        labels: ['Regular', 'Irregular'],
                        datasets: [{
                            data: [c.female_safe, c.female_risk],
                            backgroundColor: [getGenderShade(courseColor, true), getGenderShade(courseRisk, true)],
                            borderWidth: 2
                        }]
                    },
                    options: donutOptions(femaleTotal)
                });
            });
        })
        .catch(err => console.error("Status By Course Error:", err));
}





// spike drop
// by=course -> one colored line per COURSE inside this college (e.g. CAHS's
// BSN, BSPT, BSMT...), same multi-line pattern as the INC forecast chart,
// instead of one flat line for the whole college. Falls back gracefully to
// a single-college line if the backend hasn't been updated to support
// `by=course` yet (old {labels, data, spikes} shape).
function updateDropoutSpike(college) {
    const canvas = document.getElementById('dropoutSpikeChart');
    if (!canvas) return;

    const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;

    fetch(`/api/get_dropout_spike?college=${safeCollege}&by=course`)
        .then(res => res.json())
        .then(data => {
            if (data.error) {
                console.warn("Dropout Spike: No Data");
                return;
            }

            const ctx = canvas.getContext('2d');

            if (dropoutSpikeChart) {
                dropoutSpikeChart.destroy();
            }

            // --- Legacy shape support: {labels, data, spikes} (single line) ---
            // Keeps the chart working even before the backend adds `by=course`.
            if (!data.series && data.labels && data.data) {
                const predictionStartIndex = data.pred_start_index || (data.labels.length - 5);
                const lineColor = getGroupColor(safeCollege === 'all' ? (typeof COLLEGE_NAME !== 'undefined' ? COLLEGE_NAME : 'CAHS') : safeCollege);
                const pointColors = data.spikes.map(s => s ? '#e74a3b' : lineColor);
                const pointRadii = data.spikes.map(s => s ? 6 : 3);

                dropoutSpikeChart = new Chart(ctx, {
                    type: 'line',
                    data: {
                        labels: data.labels,
                        datasets: [{
                            label: 'Dropout Rate',
                            data: data.data,
                            borderColor: lineColor,
                            backgroundColor: hexToRgba(lineColor, 0.06),
                            borderWidth: 2,
                            pointBackgroundColor: pointColors,
                            pointBorderColor: "#fff",
                            pointRadius: pointRadii,
                            pointHoverRadius: 8,
                            tension: 0.3,
                            fill: true,
                            segment: {
                                borderDash: ctx => (ctx.p0DataIndex >= predictionStartIndex) ? [6, 6] : undefined
                            }
                        }]
                    },
                    options: dropoutSpikeBaseOptions(data.labels, [data.spikes])
                });

                if (typeof renderColorLegend === 'function') {
                    const legendEl = document.getElementById('dropoutSpikeLegend');
                    if (legendEl) legendEl.innerHTML = '';
                }
                return;
            }

            // --- New shape: {labels, series: [{label, history, forecast, spikes}] } ---
            if (!data.series || !data.series.length) {
                console.warn("Dropout Spike: No Data");
                return;
            }

            const labels = data.labels || [];
            const predictionStartIndex = data.pred_start_index != null
                ? data.pred_start_index
                : Math.max(0, labels.length - 5);

            const datasets = [];
            const allSpikes = [];
            (data.series || []).forEach(s => {
                const color = getGroupColor(s.label);
                const combined = (s.history || []).map((v, i) => (v != null ? v : (s.forecast || [])[i]));
                const spikes = s.spikes || [];
                allSpikes.push(spikes);

                const pointColors = combined.map((_, i) => (spikes[i] ? '#e74a3b' : color));
                const pointRadii = combined.map((_, i) => (spikes[i] ? 6 : 3));

                datasets.push({
                    label: s.label,
                    data: combined,
                    borderColor: color,
                    backgroundColor: 'transparent',
                    borderWidth: 2,
                    pointBackgroundColor: pointColors,
                    pointBorderColor: "#fff",
                    pointRadius: pointRadii,
                    pointHoverRadius: 8,
                    spanGaps: false,
                    tension: 0.3,
                    fill: false,
                    segment: {
                        borderDash: ctx => (ctx.p0DataIndex >= predictionStartIndex) ? [6, 6] : undefined
                    }
                });
            });

            dropoutSpikeChart = new Chart(ctx, {
                type: 'line',
                data: { labels: labels, datasets: datasets },
                options: dropoutSpikeBaseOptions(labels, allSpikes)
            });

            if (typeof renderColorLegend === 'function') {
                renderColorLegend('dropoutSpikeLegend', (data.series || []).map(s => ({
                    label: s.label, color: getGroupColor(s.label)
                })));
            }
        })
        .catch(err => console.error("Dropout Chart Fatal:", err));
}

/** Shared Chart.js options for the (single- or multi-course) dropout spike chart. */
function dropoutSpikeBaseOptions(labels, allSpikesPerDataset) {
    return {
        maintainAspectRatio: false,
        interaction: {
            mode: 'index',
            intersect: false,
        },
        plugins: {
            legend: { display: false }, // using color-chip legend below instead
            tooltip: {
                backgroundColor: "rgba(255,255,255,0.95)",
                bodyColor: "#858796",
                titleColor: "#6e707e",
                borderColor: '#dddfeb',
                borderWidth: 1,
                callbacks: {
                    label: function(context) {
                        const val = context.parsed.y;
                        if (val === null || val === undefined) return undefined;
                        const spikes = allSpikesPerDataset[context.datasetIndex] || [];
                        const spikeMsg = spikes[context.dataIndex] ? " — Spike" : "";
                        return ` ${context.dataset.label}: ${val}%${spikeMsg}`;
                    }
                }
            },
            annotation: {
                annotations: {
                    line1: {
                        type: 'line',
                        xMin: Math.max(0, (labels || []).length - 5),
                        xMax: Math.max(0, (labels || []).length - 5),
                        borderColor: 'rgba(0,0,0,0.2)',
                        borderWidth: 1,
                        borderDash: [2, 2],
                        label: {
                            content: 'Predicted Data Start',
                            enabled: true,
                            position: 'top'
                        }
                    }
                }
            }
        },
        scales: {
            x: {
                grid: { display: false },
                ticks: { color: "#858796" }
            },
            y: {
                beginAtZero: true,
                title: { display: true, text: 'Dropout Rate (%)' },
                grid: { color: "rgb(234, 236, 244)", borderDash: [2] },
                ticks: { color: "#858796", padding: 10 }
            }
        }
    };
}



// --- eval
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

          return `
            <div class="model-eval-card status-${statusKey}">
              <div class="mec-header">
                <span class="mec-label">${model.label}</span>
                <span class="mec-badge">${palette.label}</span>
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