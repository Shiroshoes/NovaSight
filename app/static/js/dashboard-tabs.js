/* =====================================================================
   DASHBOARD-TABS.JS
   Category tabs for the dashboard grid: only cards whose
   data-tab-category matches the active tab are shown. Everything else
   (Recent/Prediction mode, Chart/Table mode, filters) is untouched —
   this only adds/removes one class on top of whatever those already do.

   LOAD ORDER: anywhere after the HTML for #dashTabs and the
   data-tab-category cards exists, and after Chart.js. Safe to load
   near the bottom of the page, e.g. right after tableView.js:
       <script src=".../table-view.js"></script>
       <script src=".../dashboard-tabs.js"></script>

   STORAGE KEY: remembers the last tab per dashboard page (by URL
   pathname) in sessionStorage, so switching Chart/Table mode or
   Recent/Prediction mode doesn't reset which tab you were looking at.
   ===================================================================== */

(function () {
    const STORAGE_KEY = 'dashTab:' + window.location.pathname;
    const DEFAULT_TAB = 'overview';

    function getActiveTab() {
        try {
            return sessionStorage.getItem(STORAGE_KEY) || DEFAULT_TAB;
        } catch (e) {
            return DEFAULT_TAB;
        }
    }

    function setActiveTab(tab) {
        try {
            sessionStorage.setItem(STORAGE_KEY, tab);
        } catch (e) { /* private-browsing storage errors: ignore, just don't persist */ }
    }

    /**
     * Shows only the cards belonging to `tab`, hides the rest, updates
     * button active-states, and nudges any now-visible Chart.js
     * instances to resize. Chart.js computes canvas dimensions based on
     * its parent's size at draw time; a canvas that was `display:none`
     * during its last draw can come back with a stale/zero size, so a
     * single resize() call per newly-shown canvas is the safe fix here
     * (same justified pattern already used for #incForecastCard in
     * mode-toggle.js — a synchronous class toggle plus one resize call,
     * not a blanket automatic hook).
     */
    function applyTab(tab) {
        const cards = document.querySelectorAll('[data-tab-category]');
        cards.forEach((card) => {
            // "overview" is the show-everything tab — every other tab
            // filters down to just its own category.
            const match = tab === 'overview' || card.getAttribute('data-tab-category') === tab;
            card.classList.toggle('dash-tab-hidden', !match);
        });

        document.querySelectorAll('.dash-tab-btn').forEach((btn) => {
            const isActive = btn.dataset.tab === tab;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        });

        // A card that was `display:none` a moment ago can still report
        // stale/zero layout size to Chart.js if resize() runs in the
        // same synchronous tick as the class toggle above — the browser
        // hasn't necessarily finished reflow yet. Two animation frames
        // (not one — some browsers still haven't committed layout after
        // just one) reliably lands after the browser has laid the now-
        // visible card out at its real size.
        if (window.Chart && typeof Chart.getChart === 'function') {
            requestAnimationFrame(() => requestAnimationFrame(() => {
                // In "overview" every card is visible, so resize every
                // chart on the page rather than just the active category's.
                const selector = tab === 'overview' ? 'canvas' : `[data-tab-category="${tab}"] canvas`;
                document.querySelectorAll(selector).forEach((canvas) => {
                    const chart = Chart.getChart(canvas);
                    if (chart) chart.resize();
                });
            }));
        }

        setActiveTab(tab);
    }

    function init() {
        const tabBar = document.getElementById('dashTabs');
        if (!tabBar) return;

        tabBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.dash-tab-btn');
            if (!btn) return;
            applyTab(btn.dataset.tab);
        });

        applyTab(getActiveTab());
    }

    document.addEventListener('DOMContentLoaded', init);
})();