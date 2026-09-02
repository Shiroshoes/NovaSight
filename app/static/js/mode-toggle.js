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

    // Canvas ids for cards that have NO real trained forecast behind
    // them (or whose model's accuracy is too low to present as a
    // genuine prediction — e.g. GWA Ranking's gwa_ranking_model sits at
    // R² ≈ 0.05). These cards simply disappear in Prediction mode
    // rather than showing stale Recent-mode content under a "Predicted
    // Data" label, or a forecast no one should trust. Add a canvas id
    // here any time a chart's underlying model isn't reliable enough
    // to forecast with — no other code changes needed.
    NON_PREDICTIVE_CHARTS: [
        'gwaRankingChart',
        'maleStatusGridContainer',    // Male Retention & Risk (Main Campus)
        'femaleStatusGridContainer',  // Female Retention & Risk (Main Campus)
        'heatmapCard',                // Dropout Rate Heatmap: Course × Year Level
    ],

    /** Hides (Prediction mode) or restores (Recent mode) the full card
     *  wrapper — header + body, not just the canvas — for every canvas
     *  id in NON_PREDICTIVE_CHARTS. No placeholder/note is shown; the
     *  card is simply absent while its data can't be trusted. */
    _applyNonPredictiveVisibility(mode) {
        this.NON_PREDICTIVE_CHARTS.forEach(canvasId => {
            const el = document.getElementById(canvasId);
            if (!el) return;
            const cardEl = el.closest('.card') || el;
            cardEl.style.display = (mode === 'prediction') ? 'none' : '';
        });
    },

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
            // updateStatusChart's plain-year badge (Recent mode only —
            // see _renderStatusCharts) sets this to a dark gray since it
            // sits on a transparent pill; that color otherwise lingers
            // when switching into Prediction mode's orange pill, so
            // reset it explicitly here rather than relying on whatever
            // Recent mode last left behind.
            el.style.color = mode === 'prediction' ? '#ffffff' : '#5a5c69';
        });

        // Prediction-only badges: unlike [data-mode-badge] above (which
        // always shows, just relabeling itself), these stay fully
        // hidden in Recent mode and only appear once Prediction mode is
        // active — used on cards where "Predicted Data" is only ever
        // worth calling out, not a state worth badging in Recent mode.
        document.querySelectorAll('[data-mode-badge-prediction-only]').forEach(el => {
            if (mode === 'prediction') {
                el.textContent = 'Predicted Data';
                el.style.display = 'inline-block';
            } else {
                el.style.display = 'none';
            }
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

        // Hide/restore any card whose model can't support a genuine
        // forecast BEFORE the individual render calls below, so a
        // render function never has to special-case its own hiding —
        // it can just bail out early if its card is already hidden.
        this._applyNonPredictiveVisibility(mode);

        this._renderGwaRanking(safeCollege, semester, year);
        this._renderStatusCharts(safeCollege, semester, year);
        this._renderDropoutRanking(safeCollege, semester, year);
        this._renderGwaScatter(safeCollege, semester, year);
        this._renderRetentionCharts(safeCollege, semester, year);
        this._renderKpiMetrics(safeCollege, semester, year);
        this._renderYearLevelCharts(safeCollege, semester, year);
    },

    /* ── GWA RANKING CARD ────────────────────────────────────────────
       Recent mode:      bar chart -> reuses your existing updateGWARanking()
       Prediction mode:  card is hidden entirely (see
                          NON_PREDICTIVE_CHARTS / _applyNonPredictiveVisibility,
                          called earlier in _setModeNow). gwa_ranking_model's
                          R² is only ~0.05, so /api/get_gwa_ranking_data's
                          forecast years aren't reliable enough to present
                          as a genuine prediction — we no longer fetch or
                          draw them at all rather than show a low-confidence
                          line chart under a "Predicted Data" label.
    */
    _renderGwaRanking(college, semester, year) {
        if (this.currentMode === 'prediction') {
            // Card is already hidden by _applyNonPredictiveVisibility.
            // Just make sure nothing stale is left mounted on the
            // canvas for when Recent mode restores the card.
            this._destroyCanvas('gwaRankingChart');
            this._resetOwnedVar('gwaRankingChart');
            return;
        }

        // NOTE: deliberately NOT destroying the canvas here. A previous
        // Prediction-mode chart type no longer exists (Prediction mode
        // hides this card instead of swapping chart types), but keeping
        // the non-destroy here still matters for the ordinary Recent
        // Chart.js instance mid-refresh — updateGWARanking() destroys
        // whatever's actually on the canvas right before drawing its
        // replacement, once its own fetch has actually succeeded. Doing
        // that eagerly here would leave the canvas permanently blank
        // if a slow/failed /api/get_gwa_ranking_data call left nothing
        // for updateGWARanking's `if (data.error) return` to redraw.
        if (typeof updateGWARanking === 'function') {
            updateGWARanking(year, semester, college);
        }
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
                                title: { display: true, text: `Regular % — Predicted Data — by ${byLabel}` },
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
                                title: { display: true, text: `Irregular % — Predicted Data — by ${byLabel}` },
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
       Card is hidden entirely in Prediction mode (see
       NON_PREDICTIVE_CHARTS / _applyNonPredictiveVisibility, called
       earlier in _setModeNow) — Main Campus only. We no longer fetch
       or draw the per-gender trend line at all in Prediction mode.
    */
    _renderRetentionCharts(college, semester, year) {
        const maleContainer = document.getElementById('maleStatusGridContainer');
        const femaleContainer = document.getElementById('femaleStatusGridContainer');
        if (!maleContainer && !femaleContainer) return;

        if (this.currentMode === 'prediction') {
            // Cards are already hidden by _applyNonPredictiveVisibility.
            // Just tear down any chart instance still mounted inside
            // these containers so a later Recent-mode restore isn't
            // fighting a stale Chart.js instance bound to a canvas
            // updateDropoutPie is about to overwrite anyway.
            [maleContainer, femaleContainer].forEach(container => {
                if (!container) return;
                const canvas = container.querySelector('canvas');
                if (!canvas) return;
                const existing = Chart.getChart(canvas);
                if (existing) existing.destroy();
            });
            return;
        }

        // Recent mode — hand back to the existing function — it owns
        // rebuilding these containers' real donut content itself.
        if (typeof updateDropoutPie === 'function') {
            updateDropoutPie(year, college);
        }
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