/* =====================================================================
   PREDICTION-MODE-VISUALS.JS
   Reusable "this is a forecast, not real data" styling — one place to
   define what Prediction Mode LOOKS like, so every chart applies it
   consistently instead of each one improvising its own dashed-line hack.

   Designed to slot into your existing ModeAwareCharts object
   (mode-toggle.js) — it doesn't replace anything there, it's a toolkit
   ModeAwareCharts' _render* methods can call into.

   LOAD ORDER: after chart-helpers.js, before mode-toggle.js.
       <script src=".../chart-helpers.js"></script>
       <script src=".../prediction-mode-visuals.js"></script>
       <script src=".../maindash.js"></script>
       <script src=".../mode-toggle.js"></script>
   ===================================================================== */

const PredictionStyle = {

    /* ── 1. SCATTER PLOT ──────────────────────────────────────────────
       Real points -> normal filled circles (already how your student
       dots render). Forecast/predicted points -> hollow crosshairs, so
       a viewer can tell "measured" from "estimated" at a glance without
       reading a legend. Trendline -> solid over real years, dashed the
       moment it crosses into forecast years.

       Usage: spread this into a line/scatter dataset that mixes real +
       forecast points, where each point object carries `is_forecast`.
       This is exactly the shape /api/get_gwa_scatter's `line` array
       already returns — see gwaScatterChart in maindash.js/deandash.js
       for a live example of this pattern in use.
    */
    scatterForecastPointStyle() {
        return {
            pointStyle:       (ctx) => (ctx.raw && ctx.raw.is_forecast) ? 'crossRot' : 'circle',
            pointRadius:      (ctx) => (ctx.raw && ctx.raw.is_forecast) ? 5 : 3,
            pointBorderWidth: (ctx) => (ctx.raw && ctx.raw.is_forecast) ? 2 : 1,
            pointBorderColor: (ctx) => (ctx.raw && ctx.raw.is_forecast) ? '#6366f1' : ctx.dataset.borderColor,
            // Hollow = no fill on forecast points; real points keep a
            // solid fill so they read as "actual measurements".
            pointBackgroundColor: (ctx) => (ctx.raw && ctx.raw.is_forecast) ? 'transparent' : ctx.dataset.borderColor,
        };
    },

    /**
     * Segment-level line styling: dashed wherever EITHER endpoint of a
     * segment is a forecast point, solid otherwise. Chart.js v4 note:
     * segment context's p0/p1 are POINT ELEMENTS, not raw data objects —
     * they don't expose `.raw` directly. You have to look the original
     * data point up by index. (This exact mistake is what broke the GWA
     * scatter chart — using `ctx.p0.raw` threw mid-render and silently
     * killed the whole canvas.)
     */
    scatterTrendlineSegmentStyle() {
        return {
            borderDash: (segCtx) => {
                const pts = segCtx.chart.data.datasets[segCtx.datasetIndex].data;
                const p0 = pts[segCtx.p0DataIndex];
                const p1 = pts[segCtx.p1DataIndex];
                return (p0 && p0.is_forecast) || (p1 && p1.is_forecast) ? [6, 4] : undefined;
            },
        };
    },


    /* ── 2. BAR CHART ─────────────────────────────────────────────────
       50% opacity fill, dashed borders, optional diagonal hatch. Chart.js
       doesn't ship a hatch pattern natively — `backgroundColor` accepts
       any CanvasPattern though, so we draw one ourselves with a tiny
       offscreen canvas and hand that back as the fill.
    */

    /**
     * Builds a small offscreen canvas with a repeating diagonal-line
     * pattern in `color`, and returns it as a CanvasPattern Chart.js can
     * use directly as backgroundColor. Cache the result per color if
     * you're calling this every render — createPattern() is cheap, but
     * no reason to redo it on every chart.update().
     */
    createHatchPattern(color = '#4e73df', spacing = 6) {
        const patternCanvas = document.createElement('canvas');
        patternCanvas.width = spacing;
        patternCanvas.height = spacing;
        const pctx = patternCanvas.getContext('2d');

        pctx.strokeStyle = color;
        pctx.lineWidth = 1.5;
        pctx.beginPath();
        pctx.moveTo(0, spacing);
        pctx.lineTo(spacing, 0);
        pctx.stroke();

        // Base canvas context just needs any 2D context to call
        // createPattern on — using a detached one is fine.
        const baseCtx = document.createElement('canvas').getContext('2d');
        return baseCtx.createPattern(patternCanvas, 'repeat');
    },

    /**
     * Applies the full "this bar is a forecast" treatment to a Chart.js
     * bar dataset in place. Pass useHatch=false if you just want the
     * opacity+dashed-border look without the pattern fill (cheaper, and
     * some viewers find hatch fills busy on small cards).
     */
    applyBarForecastStyle(dataset, baseColor, { useHatch = true } = {}) {
        dataset.backgroundColor = useHatch
            ? this.createHatchPattern(baseColor)
            : hexToRgba(baseColor, 0.5);   // 50% opacity fallback
        dataset.borderColor = baseColor;
        dataset.borderWidth = 2;
        dataset.borderDash = [5, 4];
        return dataset;
    },


    /* ── 3. DONUT CHART ───────────────────────────────────────────────
       Wider gaps between segments (borderWidth + matching borderColor
       to the page background "cuts" a visible gap between slices — this
       is the standard Chart.js trick since there's no native "gap"
       option), plus a center-text plugin whose label swaps from "Total
       Actual" to "Projected Total" when the chart's data is forecast.
    */

    /** Call once per doughnut dataset to add spacing between slices. */
    applyDonutSpacing(dataset, pageBackgroundColor = '#ffffff', gapWidth = 4) {
        dataset.borderColor = pageBackgroundColor;
        dataset.borderWidth = gapWidth;
        dataset.borderRadius = 2; // subtle rounding reads nicer with a visible gap
        return dataset;
    },

    /**
     * A Chart.js plugin (auto-registered at the bottom of this file)
     * that draws centered text inside a doughnut's hole. It only
     * activates per-chart via `chart.config.options.plugins.centerText`
     * (see centerTextOptions() below), so charts that don't set that
     * option are unaffected even though the plugin is globally loaded.
     */
    centerTextPlugin: {
        id: 'centerText',
        afterDraw(chart) {
            const opts = chart.config.options.plugins.centerText;
            if (!opts || !opts.display) return;

            const { ctx, chartArea: { left, right, top, bottom } } = chart;
            const cx = (left + right) / 2;
            const cy = (top + bottom) / 2;

            ctx.save();
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            ctx.font = `600 ${opts.valueFontSize || 22}px sans-serif`;
            ctx.fillStyle = opts.valueColor || '#212529';
            ctx.fillText(opts.value, cx, cy - 10);

            ctx.font = `400 ${opts.labelFontSize || 12}px sans-serif`;
            ctx.fillStyle = opts.labelColor || '#858796';
            // This is the line that flips between "Total Actual" and
            // "Projected Total" — just pass the right string in when you
            // build/update the chart for the current mode.
            ctx.fillText(opts.label, cx, cy + 12);

            ctx.restore();
        },
    },

    /**
     * Convenience builder for the centerText plugin option block. Pass
     * mode='prediction' to get "Projected Total" automatically.
     */
    centerTextOptions(value, mode = 'recent') {
        return {
            display: true,
            value: String(value),
            label: mode === 'prediction' ? 'Projected Total' : 'Total Actual',
            labelColor: mode === 'prediction' ? '#6366f1' : '#858796',
        };
    },


    /* ── 4. KPI CARDS (HTML/CSS side) ─────────────────────────────────
       See the companion CSS block below (kpi-prediction.css). Takes
       explicit element references rather than assuming class names —
       your real markup uses fixed ids (kpi-val-gwa, kpi-card-gwa, etc,
       see updateKPIMetrics() in maindash.js/deandash.js), not a
       reusable .kpi-card/.kpi-value class pair.
    */
    applyKpiPredictionStyle(cardEl, valueEl, { rawValue, confidencePct = null } = {}) {
        if (cardEl) cardEl.classList.add('kpi-card--prediction');
        if (!valueEl) return;

        if (!valueEl.dataset.plainValue) valueEl.dataset.plainValue = valueEl.innerText;
        valueEl.innerText = `Est. ${rawValue}`;

        let rangeEl = valueEl.parentElement?.querySelector('.kpi-confidence-range');
        if (confidencePct !== null) {
            if (!rangeEl) {
                rangeEl = document.createElement('div');
                rangeEl.className = 'kpi-confidence-range';
                valueEl.insertAdjacentElement('afterend', rangeEl);
            }
            rangeEl.textContent = `±${confidencePct}%`;
        } else {
            // No real confidence figure available from the backend yet —
            // don't fabricate a number. Remove any stale range instead.
            rangeEl?.remove();
        }
    },

    /** Reverts a card back to its normal (Recent Data) appearance. */
    clearKpiPredictionStyle(cardEl, valueEl) {
        if (cardEl) cardEl.classList.remove('kpi-card--prediction');
        if (valueEl && valueEl.dataset.plainValue) {
            // Caller still sets the real number right after this via
            // innerText — this just strips the "Est." prefix/class state.
        }
        valueEl?.parentElement?.querySelector('.kpi-confidence-range')?.remove();
    },
};

// Auto-register the center-text plugin as soon as this file loads —
// Chart.js is guaranteed to already be on the page per the load-order
// note at the top, so no separate init call is needed anywhere else.
Chart.register(PredictionStyle.centerTextPlugin);


/* =====================================================================
   EXAMPLE — wiring this into your real KPI cards
   (kpi-val-students / kpi-card-students / kpi-val-gwa / kpi-card-gwa,
   as built by updateKPIMetrics() in maindash.js/deandash.js)
   ===================================================================== */
function applyKpiPredictionModeFromData(data) {
    const isPred = data.is_prediction;

    const cardStudents = document.getElementById('kpi-card-students');
    const elStudents    = document.getElementById('kpi-val-students');
    const cardGWA       = document.getElementById('kpi-card-gwa');
    const elGWA         = document.getElementById('kpi-val-gwa');

    if (isPred) {
        PredictionStyle.applyKpiPredictionStyle(cardStudents, elStudents, {
            rawValue: data.students.toLocaleString(),
        });
        PredictionStyle.applyKpiPredictionStyle(cardGWA, elGWA, {
            rawValue: Number(data.gwa).toFixed(2),
        });
    } else {
        PredictionStyle.clearKpiPredictionStyle(cardStudents, elStudents);
        PredictionStyle.clearKpiPredictionStyle(cardGWA, elGWA);
        elStudents.innerText = data.students.toLocaleString();
        elGWA.innerText = Number(data.gwa).toFixed(2);
    }
}