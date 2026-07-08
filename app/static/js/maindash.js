let gwaRankingChart;
let gwaScatterChart;
let statusRegularChart;
let statusIrregularChart;
let incForecastChart;
let dropoutRankingChart;
let riskByCollegeChart;
let maleStatusGridDonuts = {};   // one Regular/INC/Dropped donut per COLLEGE (or COURSE on dean dashboards), Male grid, keyed by group name
let femaleStatusGridDonuts = {}; // same as above, Female grid, keyed by group name
let courseStatusGenderDonuts = {};  // two Regular/Irregular donuts (Male + Female) per COURSE (all colleges), keyed by `${course}_male` / `${course}_female`
let hardestSubjectCharts = {};      // one Top-5-hardest-subjects line chart per COURSE, keyed by course name

// The 6 known college codes (matches chart-helpers.js COLLEGE_COLORS,
// minus the "MAIN CAMPUS"/"ALL" aggregate entries).
const ALL_COLLEGE_CODES = ['CAHS', 'CBA', 'CCST', 'CEA', 'COAS', 'CTEC'];

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

//  1. CENTRAL FILTER LOGIC 
document.addEventListener("DOMContentLoaded", function() {
    const yearSelector = document.getElementById('globalYearFilter'); // or 'selectYear'
    const semSelector = document.getElementById('filterSemester');
    const collegeSelector = document.getElementById('filterCollege'); // or 'selectCollege'

    function triggerUpdate() {
        const year = yearSelector ? yearSelector.value : 2024;
        const semester = semSelector ? semSelector.value : 'all';
        
        //  FIX: HANDLE 'Main' LOGIC 
        let collegeRaw = collegeSelector ? collegeSelector.value : 'all';
        // If the value is "Main campus" or empty, send 'all' to Python
        let college = (collegeRaw === 'Main Campus' || collegeRaw === '') ? 'all' : collegeRaw;

        console.log(`Updating all charts for: ${year}, ${semester}, ${college}`);

        // Update Bar Charts
        if (typeof updateGWARanking === 'function') updateGWARanking(year, semester, college);
        if (typeof updateDropoutRanking === 'function') updateDropoutRanking(year, semester, college);
        
        // Update ML Charts
        if (typeof updateGwaTrend === 'function') updateGwaTrend(year, semester, college); 
        if (typeof updateStatusChart === 'function') updateStatusChart(year, semester, college);
        if (typeof updateKPIMetrics === 'function') updateKPIMetrics(year, semester, college);
        if (typeof updateIncForecast === 'function') updateIncForecast(college);
        if (typeof updateDropoutPie === 'function') updateDropoutPie(year, college);
        if (typeof updateGwaScatter === 'function') updateGwaScatter(year, college, semester);
        if (typeof updateRiskByCollege === 'function') updateRiskByCollege(year, semester);
        if (typeof updateHardestSubjectsByCourse === 'function') updateHardestSubjectsByCourse(college);
    }

    // Initial load — populate Year/Semester from real uploaded data first
    // (instead of assuming "2024"), THEN run the first chart refresh.
    if (typeof initYearSemesterFilters === 'function') {
        initYearSemesterFilters(triggerUpdate);
    } else {
        triggerUpdate();
    }

    // Listen for changes
    if (yearSelector) yearSelector.addEventListener('change', triggerUpdate);
    if (semSelector) semSelector.addEventListener('change', triggerUpdate);
    if (collegeSelector) collegeSelector.addEventListener('change', triggerUpdate);
});



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

            // Badge + title (shared across both cards)
            const dpModeLabel = typeof displayModeLabel === 'function' ? displayModeLabel(data.mode) : data.mode;
            document.querySelectorAll('[id^="drop-pie-badge"]').forEach(badge => {
                badge.innerText = `${year} ${dpModeLabel}`;
                badge.style.backgroundColor = data.mode === "Forecast" ? "#ffc107" : "rgb(28, 200, 138)";
                badge.style.color = data.mode === "Forecast" ? "#212529" : "#fff";
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

    fetch(`/api/get_gwa_ranking_data/${year}?semester=${semester}&college=${college}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("GWA Ranking Error:", data.error);

            //  1. FILTER DATA 
            let displayData = data;
            if (college && college !== 'all' && college !== 'Main Campus') {
                displayData = data.filter(d => d.college.toUpperCase() === college.toUpperCase());
            }

            const labels = displayData.map(item => item.college);
            const values = displayData.map(item => item.gwa);
            
            //  2. COLORS (shared palette so this matches scatter/forecast/pie)
            const backgroundColors = labels.map(c => hexToRgba(getGroupColor(c), 0.85));

            const semText = semester === 'all' ? 'Overall' : semester;
            const collText = (college === 'all' || !college) ? 'Main Campus' : college;
            const newTitle = `Academic Performance: ${year} (${semText} - ${collText})`;

            const ctx = canvas.getContext('2d');

            //  3. ANIMATION LOGIC (Update vs Create) 
            if (gwaRankingChart) {
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
        .catch(err => console.error("GWA Ranking Fatal:", err));
}




// DROPOUT RANKING CHART (Bar)
function updateDropoutRanking(year, semester, college = 'all') {
    const canvas = document.getElementById('dropoutRankingChart');
    const subtitle = document.getElementById('dropoutRankSubtitle');
    
    if (!canvas) return;

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
    fetch(`/api/get_dropout_ranking?year=${year}&semester=${apiSemester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("Ranking API Error:", data.error);

            const chartData = data.data || [];

            // 4. Handle Empty Data (Prevents Crash)
            if (chartData.length === 0) {
                if (dropoutRankingChart) {
                    dropoutRankingChart.data.labels = [];
                    dropoutRankingChart.data.datasets[0].data = [];
                    dropoutRankingChart.update();
                }
                return;
            }

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

            // 6. Calculate Axis Scale (Prevents -Infinity Crash)
            const maxVal = values.length > 0 ? Math.max(...values) : 0;
            // Add 20% padding so the longest bar doesn't hit the edge
            const xMax = maxVal === 0 ? 5 : maxVal + (maxVal * 0.2); 

            dropoutRankingChart = new Chart(ctx, {
                type: 'bar',
                data: {
                    labels: labels,
                    datasets: [{
                        label: 'Dropout Rate (%)',
                        data: values,
                        backgroundColor: backgroundColors,
                        borderColor: borderColors,
                        borderWidth: 1,
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
        .catch(err => console.error("Ranking Chart Fatal:", err));
}




// scatter plot
function updateGwaScatter(year, college, semester) {
    const canvas = document.getElementById('gwaScatterChart');
    const titleEl = document.getElementById('scatterSubtitle'); // Get the new span
    if (!canvas) return;

    // 1. Update the Header Text Immediately
    if (titleEl) {
        // Format College
        let colText = (college === 'all' || college === '') ? 'Main Campus' : college;
        
        // Format Semester
        let semText = 'All Semesters';
        if (semester.includes('1')) semText = '1st Sem';
        if (semester.includes('2')) semText = '2nd Sem';
        if (semester.toLowerCase().includes('summer')) semText = 'Summer';

        // Set Text: "( 2024 | 1st Sem | CAHS )"
        titleEl.textContent = `( ${year} | ${semText} | ${colText} )`;
    }

    const safeSemester = semester || 'all';

    // 2. Fetch Data
    fetch(`/api/get_gwa_scatter?year=${year}&college=${college}&semester=${safeSemester}`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("Scatter API Fail:", data.error);

            const ctx = canvas.getContext('2d');

            if (gwaScatterChart) {
                gwaScatterChart.destroy();
            }

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

            scatterDatasets.push({
                type: 'line',
                label: data.line_label, // "Batch Avg" or "Predicted Avg"
                data: [
                    { x: 0, y: data.average },
                    { x: 4, y: data.average }
                ],
                borderColor: "#212529",
                borderWidth: 2,
                borderDash: [6, 4],
                pointRadius: 0,
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
                        x: { display: false, min: 0, max: 4 },
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
                                        return ` ${data.line_label}: ${pt.y}`;
                                    }
                                    return ` ${context.dataset.label} student ${pt.student_id} — GWA ${pt.y}`;
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
        .catch(err => console.error("Scatter Chart Error:", err));
}






// KPI
function updateKPIMetrics(year, semester, college) {
    const url = `/api/get_kpi_metrics?year=${year}&semester=${semester}&college=${college}`;

    fetch(url)
        .then(res => res.json())
        .then(data => {
            // 1. Get Elements
            const elStudents = document.getElementById('kpi-val-students');
            const elGWA = document.getElementById('kpi-val-gwa');
            const titleStudents = document.getElementById('kpi-title-students');
            const titleGWA = document.getElementById('kpi-title-gwa');
            const cardStudents = document.getElementById('kpi-card-students');
            const cardGWA = document.getElementById('kpi-card-gwa');

            if (!elStudents || !elGWA) return;

            // 2. Update Numbers
            elStudents.innerText = data.students.toLocaleString(); // 1,200
            elGWA.innerText = data.gwa.toFixed(2); // 1.25

            // 3. Dynamic Styling (Blue = History, Orange = AI Prediction)
            const isPred = data.is_prediction;
            const color = isPred ? '#f6ad55' : '#4e73df'; // Orange vs Blue
            const gwaColor = isPred ? '#f6ad55' : '#1cc88a'; // Orange vs Green
            const suffix = isPred ? '(AI Predicted)' : '';

            // Apply Colors
            cardStudents.style.borderLeftColor = color;
            titleStudents.style.color = color;
            titleStudents.innerText = `Total Enrollment ${suffix}`;

            cardGWA.style.borderLeftColor = gwaColor;
            titleGWA.style.color = gwaColor;
            titleGWA.innerText = `Average GWA ${suffix}`;
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

    fetch(`/api/get_inc_forecast?college=${safeCollege}&by=college`)
        .then(res => res.json())
        .then(data => {
            if (data.error) return console.error("INC Forecast Error:", data.error);

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
                    tension: 0.3
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
        .catch(err => console.error("INC Chart Fatal:", err));
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
        if (existingChart) {
            existingChart.data.labels = labels;
            existingChart.data.datasets[0].data = chartData;
            existingChart.data.datasets[0].backgroundColor = chartColors;
            existingChart.options.plugins.tooltip.callbacks.label = tooltipFn;
            existingChart.update();
            return existingChart;
        }
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
            const mode = rows.find(r => r.mode === 'Forecast') ? 'Forecast' : 'Actual';
            const displayYear = rows[0] ? rows[0].year : year;

            if (elReg) elReg.innerText = totalReg.toLocaleString();
            if (elIrr) elIrr.innerText = totalIrr.toLocaleString();
            if (badges.length) {
                const modeLabel = typeof displayModeLabel === 'function' ? displayModeLabel(mode) : mode;
                badges.forEach(badge => {
                    badge.innerText = `${displayYear} ${modeLabel}`;
                    badge.style.backgroundColor = mode === 'Forecast' ? "#f6c23e" : "rgb(28, 200, 138)";
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
                    badges.forEach(badge => {
                        badge.innerText = `${data.year || year} Recent Data`;
                        badge.style.backgroundColor = "rgb(28, 200, 138)";
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
        const STATUS_COLORS = {
          ok:      { bg: '#eaf7ef', border: '#1cc88a', text: '#1cc88a', label: 'Trained' },
          skipped: { bg: '#fff8e6', border: '#f6c23e', text: '#b88a00', label: 'Skipped' },
          error:   { bg: '#fdeeee', border: '#e74a3b', text: '#e74a3b', label: 'Error' },
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
          const palette = STATUS_COLORS[model.status] || STATUS_COLORS.skipped;
          const headline = (model.headline_value !== null && model.headline_value !== undefined)
            ? fmtMetricValue(model.headline_label || '', model.headline_value)
            : '—';

          const metricRows = Object.entries(model.metrics || {})
            .filter(([k]) => k !== (model.headline_label || '').toLowerCase())
            .map(([k, v]) => `
              <div style="display:flex; justify-content:space-between; font-size:0.68rem; color:#5a5c69; padding:2px 0; gap: 0.5rem;">
                <span style="text-transform:uppercase; letter-spacing:0.02em; white-space:nowrap;">${k.replace(/_/g, ' ')}</span>
                <span style="font-weight:700; white-space:nowrap;">${fmtMetricValue(k, v)}</span>
              </div>
            `).join('');

          const reasonRow = model.reason
            ? `<div style="font-size:0.68rem; color:#858796; margin-top:0.35rem;">${model.reason}</div>`
            : '';

          return `
            <div style="border:1px solid ${palette.border}33; background:${palette.bg}; border-radius:0.5rem; padding:0.75rem 0.6rem; min-width: 150px;">
              <div style="display:flex; flex-direction: column; gap: 0.35rem;">
                <span style="font-weight:700; font-size:0.75rem; color:#3a3b45; line-height:1.2;">${model.label}</span>
                <span style="font-size:0.62rem; font-weight:700; color:${palette.text}; background:#fff; border:1px solid ${palette.border}55; border-radius:1rem; padding:0.1rem 0.5rem; align-self:flex-start;">
                  ${palette.label}
                </span>
              </div>
              <div style="margin-top:0.5rem; font-size:1.3rem; font-weight:800; color:${palette.text}; line-height:1.1;">
                ${headline}
              </div>
              ${model.headline_label ? `<div style="font-size:0.62rem; font-weight:600; color:#858796;">${model.headline_label}</div>` : ''}
              <div style="margin-top:0.5rem;">${metricRows}</div>
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
        const color = getGroupColor(s.subject);
        return {
            label: s.subject,
            data: s.data,
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
                        }
                    }
                }
            }
        }
    });

    if (legendEl && typeof renderColorLegend === 'function') {
        renderColorLegend(legendEl.id, subjects.map(s => ({
            label: s.subject, color: getGroupColor(s.subject)
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