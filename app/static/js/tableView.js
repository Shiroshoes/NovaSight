/* =====================================================================
   TABLE-VIEW.JS
   Adds "Chart Mode / Table Mode" — picked from the kebab menu next to
   the Recent/Prediction pill switch (see kebab-menu.js for the menu
   open/close mechanics; this file only cares about what happens once
   Chart Mode or Table Mode is picked).

   HOW TABLE MODE WORKS (rewritten):
   Table Mode no longer fetches its own copy of the data and no longer
   hides/shows the whole #chartViewContainer. Both of those were the
   cause of the layout breaking (the container's `display:contents`
   was getting clobbered) and the numbers drifting from what the
   charts actually showed.

   Instead, for EVERY <canvas> inside #chartViewContainer, Table Mode
   asks Chart.js for that chart's live instance (Chart.getChart) and
   builds a small HTML table directly from that chart's own
   `chart.data` (labels + datasets) — the exact same numbers the chart
   is drawing, always in sync, one table per chart/card. The canvas is
   hidden and the table takes its place *inside the same card*.

   Table Mode also strips everything else out of EVERY card in
   #chartViewContainer so only its Title is left showing — legends,
   description text, footnotes, stat lines, metric-selector buttons,
   and any badge/subtitle next to the title all disappear, no matter
   how deep they're nested (see _sweepHide). This runs even for cards
   that have no <canvas> at all (e.g. the Male/Female Retention & Risk
   donuts, which render a custom color grid instead of a Chart.js
   chart) — there's nothing to tabulate there, so the whole body just
   hides, leaving the Title. Chart Mode restores every hidden element
   back to its original inline display value (_sweepRestore) and
   un-hides the canvases again. #chartViewContainer itself is never
   touched, so the grid layout and every filter/card around it stays
   exactly as it always was. While Table Mode is active,
   #chartViewContainer also gets a `df-table-active` class — the
   dashboard's own CSS uses that to let a card grow to fit its table
   instead of clipping it at the chart-tuned fixed height.

   A chart can also carry a `chart._historyCount` (set by
   chart-helpers.js / maindash.js / deandash.js on any chart that
   appends a predicted/forecast tail after its real data — e.g. the
   Top-5-Hardest-Subjects charts, which always draw one trailing
   forecast point regardless of the dashboard-wide Recent/Prediction
   toggle). When present, the generated table is trimmed to that many
   columns. Charts that instead pair up a separate "Actual" + "Predicted"
   dataset per series (e.g. the INC Rate Forecast chart) flag the
   predicted one with `isForecast: true`; Table Mode drops those
   datasets entirely. Either way, Table Mode only ever shows Recent
   Data, never predicted values (see _buildTableHTML).

   A tiny Chart.js plugin (registered once, below) fires whenever ANY
   chart on the page (re)renders. If Table Mode is active, that
   chart's table is rebuilt on the spot — so switching filters while
   already in Table Mode keeps every table current without this file
   needing to know about every individual update*() function in
   maindash.js / deandash.js.

   LOAD ORDER: after chart-helpers.js, maindash.js/deandash.js, and
   mode-toggle.js (doesn't matter which of those three loads first
   relative to this file, only that this loads after the DOM elements
   below exist). kebab-menu.js can load before or after this file.

       <script src=".../chart-helpers.js"></script>
       <script src=".../maindash.js"></script>      <!-- or deandash.js -->
       <script src=".../mode-toggle.js"></script>
       <script src=".../kebab-menu.js"></script>
       <script src=".../tableView.js"></script>
   ===================================================================== */

const DisplayFormat = {
    current: 'chart',   // 'chart' | 'table'

    init() {
        const chartBtn = document.getElementById('displayFormatChartBtn');
        const tableBtn = document.getElementById('displayFormatTableBtn');
        if (!chartBtn || !tableBtn) return;

        chartBtn.addEventListener('click', () => this.setFormat('chart'));
        tableBtn.addEventListener('click', () => this.setFormat('table'));

        // If the Recent/Prediction toggle flips to Prediction while Table
        // Mode is active, snap back to Chart Mode — table view has no
        // forecast rows to show, per design.
        document.addEventListener('dashboardModeChanged', (e) => {
            if (e.detail && e.detail.mode === 'prediction') {
                tableBtn.disabled = true;
                if (this.current === 'table') this.setFormat('chart');
            } else {
                tableBtn.disabled = false;
            }
        });

        this._registerChartSyncPlugin();
    },

    /** Registers a single global Chart.js plugin (once) that rebuilds a
     *  chart's table whenever that chart (re)renders, so filter changes
     *  made while already in Table Mode keep every table current. */
    _registerChartSyncPlugin() {
        if (typeof Chart === 'undefined' || this._pluginRegistered) return;
        this._pluginRegistered = true;
        Chart.register({
            id: 'displayFormatTableSync',
            afterUpdate: (chart) => {
                if (DisplayFormat.current !== 'table') return;
                const container = document.getElementById('chartViewContainer');
                if (!container || !chart.canvas || !container.contains(chart.canvas)) return;
                DisplayFormat._renderTableForChart(chart);
            }
        });
    },

    setFormat(format) {
        this.current = format;

        const chartBtn = document.getElementById('displayFormatChartBtn');
        const tableBtn = document.getElementById('displayFormatTableBtn');
        if (chartBtn) chartBtn.classList.toggle('active', format === 'chart');
        if (tableBtn) tableBtn.classList.toggle('active', format === 'table');

        const container = document.getElementById('chartViewContainer');
        if (container) container.classList.toggle('df-table-active', format === 'table');

        if (format === 'table') {
            this._showAllTables();
        } else {
            this._hideAllTables();
        }
    },

    /** Kept so maindash.js / deandash.js's existing
     *  `DisplayFormat.refresh(year, semester, college)` call (fired after
     *  every filter change) keeps working without edits there. Tables
     *  now come straight from each chart's own live data via the sync
     *  plugin above, so the arguments aren't needed here — this just
     *  makes sure any tables already on screen reflect whatever's
     *  current right now. */
    refresh() {
        if (this.current === 'table') this._showAllTables();
    },

    /* ── Show a table for every chart currently inside #chartViewContainer,
     *  then strip every OTHER card down to just its Title too ── */
    _showAllTables() {
        const container = document.getElementById('chartViewContainer');
        if (!container || typeof Chart === 'undefined') return;
        container.querySelectorAll('canvas').forEach((canvas) => {
            const chart = Chart.getChart(canvas);
            if (chart) this._renderTableForChart(chart);
        });
        this._hideNonChartCardExtras(container);
    },

    /* ── Un-hide every chart's canvas again, hide the generated tables,
     *  and restore whatever legends/description/badges/stat-lines
     *  Table Mode hid — on every card, chart-backed or not ── */
    _hideAllTables() {
        const container = document.getElementById('chartViewContainer');
        if (!container) return;
        container.querySelectorAll('canvas').forEach((canvas) => {
            const wrapper = canvas.parentElement;
            if (wrapper) wrapper.style.display = '';
            const tableWrap = wrapper && wrapper.__dfTableWrap;
            if (tableWrap) tableWrap.style.display = 'none';
            this._restoreCardExtras(canvas, wrapper, tableWrap);
        });
        this._restoreNonChartCardExtras(container);
    },

    /** Hides `chart`'s canvas (well, its sizing wrapper div) and inserts/
     *  updates a table right after it, built from that chart's own data.
     *  Also strips everything else out of the card (legends, description
     *  text, footnotes, badges) so only the card's Title is left showing
     *  alongside the table. */
    _renderTableForChart(chart) {
        const canvas = chart.canvas;
        if (!canvas) return;
        const wrapper = canvas.parentElement || canvas;

        let tableWrap = wrapper.__dfTableWrap;
        if (!tableWrap) {
            tableWrap = document.createElement('div');
            tableWrap.className = 'df-generated-table';
            tableWrap.style.marginTop = '0.5rem';
            wrapper.insertAdjacentElement('afterend', tableWrap);
            wrapper.__dfTableWrap = tableWrap;
        }

        wrapper.style.display = 'none';
        tableWrap.style.display = '';
        tableWrap.innerHTML = this._buildTableHTML(chart);

        this._hideCardExtras(canvas, wrapper, tableWrap);
    },

    /** Remembers an element's current inline display value (only the
     *  first time it's touched) and hides it. */
    _dfHide(el) {
        if (el.__dfPrevDisplay === undefined) el.__dfPrevDisplay = el.style.display;
        el.style.display = 'none';
    },

    /** Restores an element's inline display to whatever it was before
     *  Table Mode hid it (leaves untouched elements alone). */
    _dfRestore(el) {
        if (el.__dfPrevDisplay !== undefined) {
            el.style.display = el.__dfPrevDisplay;
            delete el.__dfPrevDisplay;
        }
    },

    /** Recursively hides every child of `node` EXCEPT the elements in
     *  `keep` and whatever sits on the DOM path down to them — so a
     *  title several levels deep, or a table just inserted as a
     *  sibling somewhere inside the card, both stay visible while
     *  every unrelated bit of chrome (legends, descriptions, stat
     *  lines, badges, buttons) at any depth gets hidden. Works no
     *  matter how a given card's markup happens to be nested. */
    _sweepHide(node, keep) {
        Array.from(node.children).forEach((child) => {
            if (keep.includes(child)) return;
            if (keep.some((k) => child.contains(k))) {
                this._sweepHide(child, keep);
                return;
            }
            this._dfHide(child);
        });
    },

    /** Undoes _sweepHide over the same subtree. */
    _sweepRestore(node, keep) {
        Array.from(node.children).forEach((child) => {
            if (keep.includes(child)) return;
            if (keep.some((k) => child.contains(k))) {
                this._sweepRestore(child, keep);
                return;
            }
            this._dfRestore(child);
        });
    },

    /** Table Mode should leave only the card's Title visible next to the
     *  generated table. Sweeps the WHOLE card (not just the area right
     *  around the canvas), keeping only the title heading, the canvas
     *  wrapper, and the table — everything else, at any nesting depth,
     *  disappears. */
    _hideCardExtras(canvas, wrapper, tableWrap) {
        const card = canvas.closest('.card');
        if (!card) return;
        const heading = card.querySelector('h6');
        const keep = [heading, wrapper, tableWrap].filter(Boolean);
        this._sweepHide(card, keep);
    },

    /** Undoes _hideCardExtras. */
    _restoreCardExtras(canvas, wrapper, tableWrap) {
        const card = canvas.closest('.card');
        if (!card) return;
        const heading = card.querySelector('h6');
        const keep = [heading, wrapper, tableWrap].filter(Boolean);
        this._sweepRestore(card, keep);
    },

    /** Cards inside #chartViewContainer that have no <canvas> at all
     *  (e.g. the Male/Female Retention & Risk donuts, which render a
     *  custom color-coded grid instead of a Chart.js chart) don't get
     *  a table — there's nothing to tabulate — but Table Mode still
     *  strips them down to just their Title, same as every other card.
     *
     *  KPI cards (`.card-mini` / `.card-mini1` — Total Enrollment,
     *  Average GWA, etc.) and the Model Performance & Accuracy card
     *  (`#model-eval-card`) are the one exception: they're skipped
     *  entirely here, so Table Mode
     *  never touches them — they keep rendering exactly as they do in
     *  Chart Mode, same as the CSS comment on `.card-mini` already
     *  promises for height/sizing. */
    _hideNonChartCardExtras(container) {
        container.querySelectorAll('.card').forEach((card) => {
            if (this._isUntouchableCard(card)) return;
            if (card.querySelector('canvas')) return; // handled per-chart above
            const heading = card.querySelector('h6');
            this._sweepHide(card, heading ? [heading] : []);
        });
    },

    /** Undoes _hideNonChartCardExtras. */
    _restoreNonChartCardExtras(container) {
        container.querySelectorAll('.card').forEach((card) => {
            if (this._isUntouchableCard(card)) return;
            if (card.querySelector('canvas')) return;
            const heading = card.querySelector('h6');
            this._sweepRestore(card, heading ? [heading] : []);
        });
    },

    /** Cards Table Mode must never strip down, no matter what's inside
     *  them: KPI cards (`.card-mini` / `.card-mini1` / `.card-mini2` —
     *  Total Enrollment, Average GWA, Total Drop), the Model Performance
     *  & Accuracy card (`#model-eval-card` — Main/CAHS/CBA), the
     *  ml_eval.js-based equivalent used on some college dashboards
     *  (`#ml-eval-card` — CCST/CEA/COAS/CTEC), and the Course x
     *  Year-Level Dropout Heatmap (`#heatmapCard`) — it's rendered as a
     *  plain HTML table already (see updateCourseYearLevelHeatmap in
     *  chart-helpers.js), so stripping it down would just remove the
     *  numbers it exists to show, not simplify anything. Add classes/
     *  ids here rather than at every call site if more "always show
     *  as-is" cards come up later. */
    _isUntouchableCard(card) {
        return card.classList.contains('card-mini')
            || card.classList.contains('card-mini1')
            || card.classList.contains('card-mini2')
            || card.id === 'model-eval-card'
            || card.id === 'ml-eval-card'
            || card.id === 'heatmapCard';
    },

    /* ── Build table HTML straight from chart.data — no separate fetch,
     *  so it can never drift from what the chart itself is showing ── */
    _buildTableHTML(chart) {
        const type = chart.config && chart.config.type;
        const data = chart.data || {};
        let labels = data.labels || [];
        let datasets = data.datasets || [];

        // Some charts (e.g. the forecast line charts, and the Top-5-
        // Hardest-Subjects charts which always draw their own trailing
        // forecast point) append predicted points after their real
        // "Recent Data" — chart._historyCount marks where the real
        // data ends. Table Mode only ever shows Recent Data, so trim
        // both the labels and every dataset's values to that point.
        const historyCount = chart._historyCount;
        if (typeof historyCount === 'number' && historyCount < labels.length) {
            labels = labels.slice(0, historyCount);
            datasets = datasets.map(ds => ({
                ...ds,
                data: Array.isArray(ds.data) ? ds.data.slice(0, historyCount) : ds.data,
            }));
        }

        // Other charts (e.g. INC Rate Forecast) instead pair up a
        // separate "Actual" + "Predicted" dataset per series, both
        // sharing the same label — the predicted one is flagged
        // `isForecast: true` when it's built. Drop those entirely so
        // only the Recent/Actual line shows up in the table.
        datasets = datasets.filter(ds => !ds.isForecast);

        // Once forecast datasets are dropped, any trailing label
        // columns (e.g. future years) where every remaining dataset
        // is null-padded are just empty — trim them so the table
        // doesn't end with a run of blank "—" rows.
        let lastNonEmpty = -1;
        datasets.forEach(ds => {
            if (!Array.isArray(ds.data)) return;
            for (let i = ds.data.length - 1; i > lastNonEmpty; i--) {
                if (ds.data[i] !== null && ds.data[i] !== undefined) {
                    lastNonEmpty = Math.max(lastNonEmpty, i);
                    break;
                }
            }
        });
        if (lastNonEmpty > -1 && lastNonEmpty + 1 < labels.length) {
            labels = labels.slice(0, lastNonEmpty + 1);
            datasets = datasets.map(ds => ({
                ...ds,
                data: Array.isArray(ds.data) ? ds.data.slice(0, lastNonEmpty + 1) : ds.data,
            }));
        }

        if (!datasets.length) {
            return this._shell(['—'], [], 'No data.');
        }
        if (type === 'scatter' || type === 'bubble') {
            return this._scatterSummaryTable(datasets);
        }
        if (type === 'pie' || type === 'doughnut') {
            // The Male/Female Retention donuts (renderGenderStatusGrid in
            // maindash.js/deandash.js) build 3 slices per course/college
            // ("Name — Regular", "Name — INC", "Name — Dropped") sharing
            // one dataset. The generic Label/Value table would show that
            // flat and hard to compare across courses — this instead
            // regroups it into one row per course/college with
            // Regular/INC/Dropped as columns, matching the table already
            // used for its on-screen legend.
            if (chart.canvas && /^genderStatusDonut_/.test(chart.canvas.id)) {
                return this._genderStatusTable(labels, datasets[0]);
            }
            return this._singleColumnTable(labels, datasets[0]);
        }
        // bar / line / anything else with shared labels
        return this._matrixTable(labels, datasets);
    },

    /** Regroups the gender status donut's flat "Name — Status" slices
     *  back into one row per course/college, Regular/INC/Dropped as
     *  columns. */
    _genderStatusTable(labels, dataset) {
        const values = (dataset && dataset.data) || [];
        const groups = {};
        const order = [];

        labels.forEach((label, i) => {
            const sep = label.lastIndexOf(' — ');
            if (sep === -1) return;
            const name = label.slice(0, sep);
            const status = label.slice(sep + 3).trim().toLowerCase();

            if (!groups[name]) {
                groups[name] = { regular: 0, inc: 0, drop: 0 };
                order.push(name);
            }
            const v = values[i];
            const num = (v === null || v === undefined) ? 0 : v;
            if (status === 'regular') groups[name].regular = num;
            else if (status === 'inc') groups[name].inc = num;
            else if (status === 'dropped') groups[name].drop = num;
        });

        const rows = order.map(name => [name, groups[name].regular, groups[name].inc, groups[name].drop]);
        return this._shell(['Course', 'Regular', 'INC', 'Dropped'], rows);
    },

    _matrixTable(labels, datasets) {
        const headers = ['', ...datasets.map(ds => ds.label || '')];
        const rows = labels.map((label, i) => {
            const cells = datasets.map(ds => {
                let v = Array.isArray(ds.data) ? ds.data[i] : undefined;
                if (v && typeof v === 'object') v = (v.y != null ? v.y : JSON.stringify(v));
                return (v === null || v === undefined) ? '—' : v;
            });
            return [label, ...cells];
        });
        return this._shell(headers, rows);
    },

    _singleColumnTable(labels, dataset) {
        const values = (dataset && dataset.data) || [];
        const rows = labels.map((label, i) => [label, (values[i] === null || values[i] === undefined) ? '—' : values[i]]);
        return this._shell(['Label', 'Value'], rows);
    },

    /** Scatter/bubble charts plot one dot per student — far too many rows
     *  for a table, so this summarizes each dataset (group) instead of
     *  listing every point, while still being derived from the exact
     *  same data the chart is plotting. */
    _scatterSummaryTable(datasets) {
        const rows = datasets.map(ds => {
            const pts = (ds.data || []).filter(p => p && typeof p.y === 'number');
            const count = pts.length;
            const avg = count ? (pts.reduce((sum, p) => sum + p.y, 0) / count) : 0;
            return [ds.label || '—', count, count ? avg.toFixed(2) : '—'];
        });
        return this._shell(
            ['Group', 'Students', 'Avg'], rows,
            'The chart plots one dot per student; this table summarizes each group instead of listing every dot.'
        );
    },

    _shell(headers, rows, note) {
        const thead = headers.map(h =>
            `<th style="padding:0.5rem 0.75rem; text-align:left; background:#f8f9fc; border-bottom:2px solid #e3e6f0; font-size:0.75rem; text-transform:uppercase; color:#5a5c69;">${h}</th>`
        ).join('');
        const tbody = rows.length
            ? rows.map(r => `<tr>${r.map(c => `<td style="padding:0.5rem 0.75rem; border-bottom:1px solid #e3e6f0; font-size:0.85rem; color:#212529;">${c}</td>`).join('')}</tr>`).join('')
            : `<tr><td colspan="${headers.length}" style="padding:0.75rem; text-align:center; color:#858796;">No data.</td></tr>`;
        return `
            <div style="overflow-x:auto; background:#fff; border:1px solid #e3e6f0; border-radius:0.35rem; font-family:'Nunito',sans-serif;">
                ${note ? `<p style="margin:0.6rem 0.75rem 0 0.75rem; font-size:0.75rem; color:#858796;">${note}</p>` : ''}
                <table style="width:100%; border-collapse:collapse;">
                    <thead><tr>${thead}</tr></thead>
                    <tbody>${tbody}</tbody>
                </table>
            </div>`;
    },
};

document.addEventListener('DOMContentLoaded', () => DisplayFormat.init());