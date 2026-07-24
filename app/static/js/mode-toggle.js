/* =====================================================================
   MODE-TOGGLE.JS
   A pill-style toggle switch — "Recent" / "Prediction" — PLUS the
   #globalYearFilter dropdown (real/actual years only, no forecast
   entries — see chart-helpers.js):
     - Recent mode:     uses whichever real year is picked in
                         #globalYearFilter, defaulting to the latest
                         real year if nothing's picked yet
     - Prediction mode: always starts at (latest real year + 1) and
                         completely ignores the Year dropdown — the
                         dropdown is disabled while Prediction is active
                         (see _syncToggleUI) since it has nothing
                         forecast-related to offer

   This file manages the GWA ranking, Status, Dropout ranking, GWA
   scatter, and Male/Female Retention canvases, plus the KPI tiles
   (Total Enrollment / Average GWA) — and fetches the latest real year
   independently via /api/get_year_semester_options for its own
   Prediction-mode math.

   Every other canvas on the dashboards (INC Forecast, Dropout Spike,
   Hardest Subjects) already renders its full real+forecast horizon in
   one shot regardless of mode, so it doesn't need to be re-rendered here.

   LOAD ORDER: after chart-helpers.js AND after maindash.js / deandash.js.

       <script src=".../chart-helpers.js"></script>
       <script src=".../maindash.js"></script>      <!-- or deandash.js -->
       <script src=".../mode-toggle.js"></script>   <!-- LAST -->
   ===================================================================== */

const ModeAwareCharts = {
    currentMode: 'recent',   // 'recent' | 'prediction'
    latestRealYear: null,    // filled in by init(), used for both modes

    _destroyCanvas(canvasId) {
        const existing = Chart.getChart(canvasId);
        if (existing) existing.destroy();
    },

    _resetOwnedVar(varName) {
        try {
            if (typeof window[varName] !== 'undefined') {
                window[varName] = null;
            } else {
                // eslint-disable-next-line no-eval
                eval(`if (typeof ${varName} !== 'undefined') { ${varName} = null; }`);
            }
        } catch (e) { /* variable doesn't exist on this page — fine */ }
    },

    /**
     * Call once on page load. Fetches the latest real year ITSELF —
     * no DOM year filter involved anymore — and records mode state
     * without rendering (rendering happens only through setMode/toggle,
     * to avoid the canvas-reuse race from double-rendering on load).
     */
    init(college = 'all', semester = 'all') {
        this._college = college;
        this._semester = semester;
        this.currentMode = 'recent';
        this._syncToggleUI('recent');

        // Stored so setMode()/toggle() can wait for this to resolve
        // instead of racing it — a fast Recent<->Prediction toggle
        // before this fetch finishes used to send year=null to every
        // "Recent" API call, which the backend legitimately answers
        // with all-zero data (KPI shows 0, charts render empty) since
        // nothing errors — it's a valid response for a year that
        // doesn't exist.
        this._yearReady = fetch('/api/get_year_semester_options')
            .then(res => res.json())
            .then(data => {
                this.latestRealYear = data.latest_year || new Date().getFullYear();
            })
            .catch(err => {
                console.error('ModeAwareCharts init failed:', err);
                // Fall back rather than leaving latestRealYear as null
                // forever — see the recent-mode fallback in setMode().
                this.latestRealYear = this.latestRealYear || new Date().getFullYear();
            });
    },

    _syncToggleUI(mode) {
        document.querySelectorAll('[data-mode-badge]').forEach(el => {
            el.textContent = mode === 'prediction' ? 'Predicted Data' : 'Recent Data';
            el.style.backgroundColor = mode === 'prediction' ? '#f6ad55' : '#1cc88a';
        });

        const wrap = document.getElementById('modeSwitchWrap');
        if (wrap) wrap.classList.toggle('is-prediction', mode === 'prediction');

        // The Year dropdown only ever lists real/actual years (see
        // chart-helpers.js) — it has nothing meaningful to select while
        // Prediction mode is showing forecast years, so grey it out
        // rather than let it silently do nothing.
        const yearSelect = document.getElementById('globalYearFilter');
        if (yearSelect) yearSelect.disabled = (mode === 'prediction');

        // Let table-view.js (or anything else) react to mode changes
        // without this file needing to know it exists.
        document.dispatchEvent(new CustomEvent('dashboardModeChanged', { detail: { mode } }));
    },

    /** Called by the pill switch's onclick — flips mode and re-renders. */
    toggle(college = 'all', semester = 'all') {
        const nextMode = this.currentMode === 'prediction' ? 'recent' : 'prediction';
        this.setMode(nextMode, college, semester);
    },

    /**
     * The ONLY function that renders the 3 mode-aware canvases. Called
     * exclusively by the toggle switch (directly or via toggle() above).
     */
    setMode(mode, college = 'all', semester = 'all') {
        // If the initial year fetch hasn't resolved yet, wait for it
        // instead of rendering with year=null (which the backend was
        // happily returning valid, all-zero data for).
        if (this.latestRealYear == null && this._yearReady) {
            this._yearReady.then(() => this._setModeNow(mode, college, semester));
            return;
        }
        this._setModeNow(mode, college, semester);
    },

    _setModeNow(mode, college = 'all', semester = 'all') {
        this.currentMode = mode;
        this._syncToggleUI(mode);

        // The #filterCollege dropdown's "All Colleges" option has
        // value="Main Campus" (not "all") — updateStatusChart already
        // converts that internally, but updateKPIMetrics and a few
        // others don't, so they were querying the backend for a
        // college literally named "Main Campus" and legitimately
        // getting back zero matching rows. Normalize once, here, so
        // every render call downstream gets the same clean value.
        const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;

        const fallbackYear = new Date().getFullYear();
        let year;
        if (mode === 'prediction') {
            // Prediction always auto-computes its own forecast year —
            // the Year dropdown (real years only) never applies here.
            year = (this.latestRealYear || fallbackYear) + 1;
        } else {
            // Recent mode: honor the Year dropdown if the user picked a
            // specific real year; fall back to the latest real year if
            // the dropdown isn't there or hasn't loaded yet.
            const yearSelect = document.getElementById('globalYearFilter');
            const picked = (yearSelect && yearSelect.value) ? parseInt(yearSelect.value, 10) : null;
            year = picked || this.latestRealYear || fallbackYear;
        }

        this._renderGwaRanking(safeCollege, semester, year);
        this._renderStatusCharts(safeCollege, semester, year);
        this._renderDropoutRanking(safeCollege, semester, year);
        this._renderGwaScatter(safeCollege, semester, year);
        this._renderRetentionCharts(safeCollege, semester, year);
        this._renderKpiMetrics(safeCollege, semester, year);
        this._renderYearLevelCharts(safeCollege, semester, year);
    },

    /* ── GWA RANKING CARD ────────────────────────────────────────────
       Recent mode:     bar chart  -> reuses your existing updateGWARanking()
       Prediction mode: line chart -> loops get_gwa_ranking_data across
                         several forecast years starting the year after
                         your latest real data (that endpoint already
                         switches into gwa_ranking_model forecasting by
                         itself whenever the year is beyond the latest
                         real year — no separate trend endpoint needed)
    */
    _renderGwaRanking(college, semester, year) {
        if (this.currentMode === 'recent') {
            // NOTE: deliberately NOT destroying the canvas here anymore.
            // The previous chart might be the Prediction-mode line chart
            // (an untracked instance — see the prediction branch below),
            // so a hard destroy is still needed for that type swap, but
            // it now happens INSIDE updateGWARanking itself, right
            // before drawing the replacement, once the fetch has
            // actually succeeded. Destroying it eagerly here meant any
            // failed/slow /api/get_gwa_ranking_data call left the
            // canvas permanently blank, since updateGWARanking's own
            // `if (data.error) return` had nothing left to redraw.
            if (typeof updateGWARanking === 'function') {
                updateGWARanking(year, semester, college);
            }
            return;
        }

        this._destroyCanvas('gwaRankingChart');
        this._resetOwnedVar('gwaRankingChart');

        const forecastYears = [0, 1, 2, 3, 4].map(i => year + i);
        const requests = forecastYears.map(y =>
            fetch(`/api/get_gwa_ranking_data/${y}?semester=${semester}&college=${college}`)
                .then(res => res.json())
        );

        const canvas = document.getElementById('gwaRankingChart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');

        const chart = new Chart(ctx, {
            type: 'line',
            data: { labels: forecastYears, datasets: [] },
            options: {
                maintainAspectRatio: false,
                scales: {
                    y: { min: 1.0, max: 3.5, title: { display: true, text: 'GWA Scale (1.0 = Highest)' } },
                },
                plugins: {
                    legend: { position: 'bottom' },
                    title: { display: true, text: `Academic Performance Forecast: ${forecastYears[0]}–${forecastYears[forecastYears.length - 1]}` },
                },
            },
        });

        Promise.all(requests).then(allYearsData => {
            if (allYearsData.some(d => d.error)) {
                console.warn('GWA forecast fetch returned an error for one or more years.');
                return;
            }
            // Defensive: if the mode was toggled again while this fetch
            // was in flight, bail out instead of drawing stale data.
            if (this.currentMode !== 'prediction') return;

            const colleges = [...new Set(allYearsData[0].map(d => d.college))];
            chart.data.datasets = colleges.map(c => ({
                label: c,
                data: allYearsData.map(yearData => {
                    const row = yearData.find(d => d.college === c);
                    return row ? row.gwa : null;
                }),
                borderColor: getGroupColor(c),
                backgroundColor: hexToRgba(getGroupColor(c), 0.06),
                borderWidth: 2,
                borderDash: [5, 4],
                tension: 0.3,
                pointRadius: 3,
            }));
            chart.update();
        });
    },

    /* ── STATUS CARDS (Regular / Irregular) ──────────────────────────
       Recent mode:     two doughnuts -> reuses your existing updateStatusChart()
       Prediction mode: two MULTI-LINE charts — one line per DEPARTMENT
                         (college='all', Main dashboard) or per COURSE (a
                         specific college is selected, dean dashboards),
                         fed by /api/get_status_trend?by=college|course.
                         Same convention as the GWA Ranking / INC Forecast
                         prediction-mode charts, so a line's color always
                         means the same college/course everywhere else on
                         the page, and the two legend boxes underneath
                         (#status-plain-summary-legend / #status-irregular-legend)
                         are the SAME containers Recent mode already uses
                         for its per-college/per-course donut legend —
                         just repopulated with the forecast lines' colors
                         instead, so both modes present group breakdowns
                         in the same spot.
    */
    _renderStatusCharts(college, semester, year) {
        if (this.currentMode === 'recent') {
            // Deliberately not destroying the canvases here — same
            // reasoning as _renderGwaRanking above. Prediction mode's
            // multi-line charts on these canvases are untracked, so an
            // eager destroy here left them permanently blank whenever
            // /api/get_status_trend (or the college/course lookups
            // updateStatusChart depends on) errored or was slow.
            // renderDonut() (inside updateStatusChart) now destroys
            // whatever's actually on the canvas right before drawing.
            if (typeof updateStatusChart === 'function') {
                updateStatusChart(year, semester, college);
            }
            return;
        }

        this._destroyCanvas('statusRegularChart');
        this._destroyCanvas('statusIrregularChart');
        this._resetOwnedVar('statusRegularChart');
        this._resetOwnedVar('statusIrregularChart');

        const safeCollege = (college === 'Main Campus' || !college) ? 'all' : college;
        const safeSemester = semester || 'all';
        // 'all' colleges -> one line per DEPARTMENT; one college selected
        // -> one line per COURSE inside it. Mirrors updateStatusChart's
        // own Recent-mode drill-down logic exactly.
        const breakdown = safeCollege === 'all' ? 'college' : 'course';

        fetch(`/api/get_status_trend?college=${safeCollege}&semester=${safeSemester}&by=${breakdown}`)
            .then(res => res.json())
            .then(data => {
                if (data.error) { console.warn('Status trend error:', data.error); return; }

                // Defensive: if the mode was toggled again while this
                // fetch was in flight, bail out instead of racing
                // against whatever render happened after this one
                // started (this is what caused "Canvas already in use").
                if (this.currentMode !== 'prediction') return;

                // Destroy again right here, in case a Recent-mode render
                // slipped in between the destroy at the top of this
                // function and this fetch resolving.
                this._destroyCanvas('statusRegularChart');
                this._destroyCanvas('statusIrregularChart');

                const labels = data.years;
                const byLabel = breakdown === 'college' ? 'Department' : 'Course';

                const regCanvas = document.getElementById('statusRegularChart');
                if (regCanvas) {
                    new Chart(regCanvas.getContext('2d'), {
                        type: 'line',
                        data: { labels, datasets: this._buildGroupLineDatasets(data.regular_series) },
                        options: {
                            maintainAspectRatio: false,
                            scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } } },
                            plugins: {
                                legend: { display: false }, // color-chip legend below instead
                                title: { display: true, text: `Regular % Forecast — by ${byLabel}` },
                                tooltip: {
                                    callbacks: {
                                        label: (ctx) => (ctx.parsed.y === null) ? undefined : ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
                                    },
                                },
                            },
                        },
                    });
                }
                if (typeof renderColorLegend === 'function') {
                    renderColorLegend('status-plain-summary-legend', data.regular_series.map(s => ({
                        label: s.label, color: getGroupColor(s.label),
                    })));
                }

                const irrCanvas = document.getElementById('statusIrregularChart');
                if (irrCanvas) {
                    new Chart(irrCanvas.getContext('2d'), {
                        type: 'line',
                        data: { labels, datasets: this._buildGroupLineDatasets(data.irregular_series) },
                        options: {
                            maintainAspectRatio: false,
                            scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } } },
                            plugins: {
                                legend: { display: false },
                                title: { display: true, text: `Irregular % Forecast — by ${byLabel}` },
                                tooltip: {
                                    callbacks: {
                                        label: (ctx) => (ctx.parsed.y === null) ? undefined : ` ${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}%`,
                                    },
                                },
                            },
                        },
                    });
                }
                if (typeof renderColorLegend === 'function') {
                    renderColorLegend('status-irregular-legend', data.irregular_series.map(s => ({
                        label: s.label, color: getGroupColor(s.label),
                    })));
                }
            })
            .catch(err => console.error('Status trend fetch failed:', err));
    },

    /** Turns [{label, history, forecast}, ...] into Chart.js datasets —
     *  one solid "history" line + one dashed "forecast" line PER group,
     *  both sharing that group's fixed color (getGroupColor), same
     *  solid/dashed convention used by the GWA Ranking and INC Forecast
     *  prediction-mode charts. */
    _buildGroupLineDatasets(series) {
        const datasets = [];
        (series || []).forEach(s => {
            const color = getGroupColor(s.label);
            datasets.push({
                label: s.label,
                data: s.history,
                borderColor: color,
                backgroundColor: hexToRgba(color, 0.08),
                borderWidth: 2,
                pointRadius: 2,
                spanGaps: false,
                fill: false,
                tension: 0.3,
            });
            datasets.push({
                label: s.label,
                data: s.forecast,
                borderColor: color,
                borderDash: [6, 4],
                backgroundColor: 'transparent',
                borderWidth: 2,
                pointRadius: 2,
                pointStyle: 'rectRot',
                pointBackgroundColor: '#ffffff',
                pointBorderColor: color,
                spanGaps: false,
                fill: false,
                tension: 0.3,
            });
        });
        return datasets;
    },

    /* ── DROPOUT RISK RANKING CARD ───────────────────────────────────
       Same bar chart in BOTH modes — no type swap needed. Unlike the
       GWA/Status cards, /api/get_dropout_ranking already has a REAL
       trained model (dropout_ranking_model) behind forecast years.
       updateDropoutRanking() now takes an isPrediction flag and applies
       PredictionStyle's forecast bar treatment (hatch fill + dashed
       border) when true — see prediction-mode-visuals.js.
    */
    _renderDropoutRanking(college, semester, year) {
        if (typeof updateDropoutRanking === 'function') {
            updateDropoutRanking(year, semester, college, this.currentMode === 'prediction');
        }
    },

    /* ── YEAR-LEVEL CHARTS (Risk Grid + INC/Irregular/Drop) ───────────
       Recent mode:     Risk Grid = stacked bar of perf bands;
                         INC chart = grouped bar (INC/Irregular/Drop).
       Prediction mode: Risk Grid -> multi-line GWA-by-year-level forecast
                         (a stacked-band forecast would be unreadable, so
                         GWA trend is the prediction-mode analog instead);
                         INC chart -> multi-line INC-rate-by-year-level
                         forecast (one metric at a time; INC by default). */
    _renderYearLevelCharts(college, semester, year) {
        const isPred = this.currentMode === 'prediction';
        if (typeof updateYearLevelChart === 'function') {
            updateYearLevelChart(year, semester, college, isPred);
        }
        if (typeof updateYearLevelIncIrregChart === 'function') {
            // Keep whatever metric the user had selected via the
            // INC/Irregular/Drop buttons (defaults to 'inc' the first
            // time, before any button has been clicked).
            const activeMetric = (typeof _lastIncIrregArgs !== 'undefined' && _lastIncIrregArgs.metric) || 'inc';
            updateYearLevelIncIrregChart(year, semester, college, isPred, activeMetric);
        }
    },

    /* ── GWA DISTRIBUTION (SCATTER) CARD ─────────────────────────────
       No longer mode-dependent at all: /api/get_gwa_scatter always
       returns EVERY real year (with real dots) PLUS the forecast
       horizon (predicted-average points only) in one response, so past
       data and predictions are always shown together regardless of
       which pill is active. Called here just to keep it in sync with
       the college/semester filters — `year` is intentionally NOT passed,
       updateGwaScatter() no longer takes one.
    */
    _renderGwaScatter(college, semester, year) {
        if (typeof updateGwaScatter === 'function') {
            updateGwaScatter(college, semester);
        }
    },

    /* ── MALE / FEMALE RETENTION & RISK CARDS ────────────────────────
       These do NOT get real forecast numbers from their normal endpoint
       (/api/get_gender_status_breakdown is documented as historical-only
       — passing it a future year just re-shows the latest real data
       under a "Forecast" label, which would be misleading to present as
       a genuine prediction). So Prediction mode here swaps the donut
       grid for a real trend line per gender, fed by /api/get_status_trend
       (Holt-style per-series forecast, same one powering the Status
       Regular/Irregular cards) with a &gender= filter added.
    */
    _renderRetentionCharts(college, semester, year) {
        const maleContainer = document.getElementById('maleStatusGridContainer');
        const femaleContainer = document.getElementById('femaleStatusGridContainer');
        if (!maleContainer && !femaleContainer) return;

        if (this.currentMode === 'recent') {
            // Hand back to the existing function — it owns rebuilding
            // these containers' real donut content itself.
            if (typeof updateDropoutPie === 'function') {
                updateDropoutPie(year, college);
            }
            return;
        }

        // Prediction mode — genuine trend line per gender.
        [['male', maleContainer], ['female', femaleContainer]].forEach(([gender, container]) => {
            if (!container) return;

            fetch(`/api/get_status_trend?college=${college}&semester=${semester}&gender=${gender === 'male' ? 'Male' : 'Female'}`)
                .then(res => res.json())
                .then(data => {
                    if (data.error) { console.warn(`Retention trend (${gender}) error:`, data.error); return; }
                    if (this.currentMode !== 'prediction') return; // stale response guard

                    container.innerHTML = `<canvas style="max-height: 260px;"></canvas>`;
                    const canvas = container.querySelector('canvas');
                    const ctx = canvas.getContext('2d');

                    const labels = [...data.years, ...data.forecast_years];
                    const historyCount = data.history_count;
                    const dashAfterHistory = (ctx) =>
                        (ctx.p0DataIndex >= historyCount - 1) ? [5, 4] : undefined;

                    new Chart(ctx, {
                        type: 'line',
                        data: {
                            labels,
                            datasets: [
                                {
                                    label: 'Regular %',
                                    data: [...data.regular_pct, ...data.regular_forecast],
                                    borderColor: '#1cc88a',
                                    backgroundColor: hexToRgba('#1cc88a', 0.08),
                                    borderWidth: 2, tension: 0.3,
                                    pointRadius: (c) => c.dataIndex >= historyCount ? 2 : 3,
                                    segment: { borderDash: dashAfterHistory },
                                },
                                {
                                    label: 'INC %',
                                    data: [...data.inc_pct, ...data.inc_forecast],
                                    borderColor: '#f6c23e',
                                    backgroundColor: hexToRgba('#f6c23e', 0.08),
                                    borderWidth: 2, tension: 0.3,
                                    pointRadius: (c) => c.dataIndex >= historyCount ? 2 : 3,
                                    segment: { borderDash: dashAfterHistory },
                                },
                                {
                                    label: 'Dropped %',
                                    data: [...data.dropped_pct, ...data.dropped_forecast],
                                    borderColor: '#e74a3b',
                                    backgroundColor: hexToRgba('#e74a3b', 0.08),
                                    borderWidth: 2, tension: 0.3,
                                    pointRadius: (c) => c.dataIndex >= historyCount ? 2 : 3,
                                    segment: { borderDash: dashAfterHistory },
                                },
                            ],
                        },
                        options: {
                            maintainAspectRatio: false,
                            scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } } },
                            plugins: {
                                legend: { position: 'bottom' },
                                title: { display: true, text: `${gender === 'male' ? 'Male' : 'Female'} Retention Trend` },
                            },
                        },
                    });
                })
                .catch(err => console.error(`Retention trend (${gender}) fetch failed:`, err));
        });
    },

    /* ── KPI TILES (Total Enrollment / Average GWA) ──────────────────
       No chart-type swap needed here at all — updateKPIMetrics() already
       reads the `is_prediction` flag /api/get_kpi_metrics returns for
       ANY year beyond the latest real one, and re-colors/re-labels the
       exact same two cards (blue/green "(Current Data)" vs orange
       "(Predicted Data — <year>)", via PredictionStyle) entirely on its
       own — see the small addition to updateKPIMetrics() in
       maindash.js/deandash.js that appends the year into that suffix.
       It just needs to be CALLED with the mode-appropriate year on
       every toggle — previously it only ever ran once on page load via
       triggerUpdate(), so the tiles stayed frozen on whatever the
       initial "Recent" numbers were even after switching to Prediction.
       Same function powers both the main dashboard and every dean
       dashboard (identical card IDs on both), so no per-page branching
       is needed here.

       KPI predictions deliberately stay ONE year out only — never
       further — and are hard-capped at 2030 regardless of how far
       latestRealYear has advanced, so the KPI tiles never extrapolate
       into a range the underlying regression models were never tuned
       for. (Other charts' own forecast horizons — e.g. GWA Ranking's
       5-year line, Status trend's 5-year line — are unaffected; this
       cap is local to the KPI tiles only.)
    */
    _renderKpiMetrics(college, semester, year) {
        if (typeof updateKPIMetrics !== 'function') return;

        if (this.currentMode === 'prediction') {
            const nextYear = Math.min((this.latestRealYear || new Date().getFullYear()) + 1, 2030);
            updateKPIMetrics(nextYear, semester, college);
            return;
        }

        updateKPIMetrics(year, semester, college);
    },
};



/* =====================================================================
   WIRING

   1. A single pill-style toggle switch:

   <div class="mode-switch" id="modeSwitchWrap"
        onclick="ModeAwareCharts.toggle(document.getElementById('filterCollege').value, document.getElementById('filterSemester').value)">
       <div class="mode-switch-thumb"></div>
       <span class="mode-switch-option" data-value="recent">Recent</span>
       <span class="mode-switch-option" data-value="prediction">Prediction</span>
   </div>

   (See the CSS block shipped alongside this file / inlined in the HTML
   for the .mode-switch styling.)

   2. On page load — triggerUpdate() (your page's own function) renders
      every chart once using whatever year is selected in
      #globalYearFilter (defaulting to the latest real year, populated
      by chart-helpers.js's initYearSemesterFilters). ModeAwareCharts.init()
      separately fetches the latest real year for ITS OWN internal use
      (Prediction mode's forecast start year), entirely independent of
      the dropdown:

   document.addEventListener('DOMContentLoaded', () => {
       if (typeof triggerUpdate === 'function') triggerUpdate();

       const college = document.getElementById('filterCollege').value;
       const semester = document.getElementById('filterSemester').value;
       ModeAwareCharts.init(college, semester);
   });
   ===================================================================== */