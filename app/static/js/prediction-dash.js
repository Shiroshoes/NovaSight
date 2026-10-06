/* ======================================================================
   prediction-dash.js \u2014 NovaSight Prediction Analysis
   Same components as maindash.js (filter popovers, table modals, sortable /
   searchable tables, fullscreen cards) so the two dashboards behave alike;
   the data comes from /api/pred/* (ml_route/prediction_api.py).
   ====================================================================== */
(function () {
'use strict';

/* -- DOM helpers ----------------------------------------------------------- */
const $   = id => document.getElementById(id);
const qsa = (sel, root=document) => [...root.querySelectorAll(sel)];

function loading(id) {
  const el = $(id);
  if (el) el.innerHTML = `<div class="chart-loading"><div class="chart-spinner"></div><span>Loading\u2026</span></div>`;
}
function empty(id, msg='No data for the selected filters.') {
  const el = $(id);
  if (el) el.innerHTML = `<div class="chart-empty">${msg}</div>`;
}

/* -- Download helpers ------------------------------------------------------ */
function downloadChartPng(canvasId, filename) {
  const c = $(canvasId);
  if (!c) return;
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = filename + '.png';
  a.click();
}
function downloadCsv(rows, headers, filename) {
  const csv = [headers.join(','),
    ...rows.map(r => headers.map(h => {
      const v = r[h] ?? '';
      return typeof v === 'string' && v.includes(',') ? `"${v}"` : v;
    }).join(','))
  ].join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
  a.download = filename + '.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 8000);
}

/* -- Delta badge ----------------------------------------------------------- */
function deltaHtml(val, unit='', invertGood=false) {
  if (val == null || isNaN(val) || val === 0) return '';
  const up  = val > 0;
  const cls = (up ? !invertGood : invertGood) ? 'up' : 'down';
  return `<span class="kpi-delta ${cls}">${up?'\u2191':'\u2193'}${Math.abs(val).toFixed(2)}${unit}</span>`;
}

/* White pill badge for numbers sitting on the dark red Total Enrollment
   card \u2014 plain colored text was unreadable directly on that background.
   up=true -> green (enrollment grew, good), false -> red, null -> neutral gray. */
function enrollPill(text, up, fontSize=14) {
  const color = up === null ? '#4b5563' : (up ? '#15803d' : '#b91c1c');
  return `<span style="display:inline-block;background:#fff;color:${color};`+
         `border-radius:999px;padding:2px 10px;font-size:${fontSize}px;font-weight:700;">`+
         `${text}</span>`;
}

/* -- Chart.js instance manager --------------------------------------------- */
const _charts = {};
function makeChart(id, config) {
  if (_charts[id]) _charts[id].destroy();
  const el = $(id);
  if (!el) return null;
  _charts[id] = new Chart(el, config);
  return _charts[id];
}

/* -- Populate select from list --------------------------------------------- */
function fillSelect(selId, items, labelFn = d => d, valFn = d => d) {
  const sel = $(selId);
  if (!sel) return;
  const cur = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  (items || []).forEach(d => sel.add(new Option(labelFn(d), valFn(d))));
  sel.value = cur;
}

/* -- Sortable / searchable / filterable / paginated HTML table --------------
   Backward compatible with the old buildTable(id, rows, headers, sort, dir)
   calls \u2014 pass an extra `opts` object to turn on the extra features:
     { pageSize, filename, searchable, filterable, downloadable }
   All default to sensible values (search/filter/download ON, pageSize 10). */
function buildTable(containerId, rows, headers, defaultSort=null, defaultDir='desc', opts={}) {
  const container = $(containerId);
  if (!container) return;

  const {
    pageSize     = 10,
    filename     = 'table_data',
    title        = '',
    description  = '',
    searchable   = true,
    filterable   = true,
    downloadable = false,
  } = opts;

  let sortCol     = defaultSort || headers[0];
  let sortDir     = defaultDir;
  let searchTerm  = '';
  const colFilters  = {};              // header -> Set of included values (absent = no filter)
  const visibleCols = new Set(headers);
  let page          = 1;
  let openFilterCol = null;            // header currently showing its filter popover
  let colsOpen      = false;           // "Columns" show/hide popover

  const activeHeaders = () => headers.filter(h => visibleCols.has(h));
  const uniqueValues  = h => [...new Set(rows.map(r => String(r[h] ?? '\u2014')))]
    .sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));

  function filtered() {
    return rows.filter(r => {
      if (searchTerm) {
        const hay = headers.map(h => String(r[h] ?? '')).join(' ').toLowerCase();
        if (!hay.includes(searchTerm)) return false;
      }
      for (const h in colFilters) {
        if (!colFilters[h].has(String(r[h] ?? '\u2014'))) return false;
      }
      return true;
    });
  }
  function sorted(list) {
    return [...list].sort((a,b) => {
      const va = a[sortCol] ?? '', vb = b[sortCol] ?? '';
      const na = parseFloat(va), nb = parseFloat(vb);
      const cmp = !isNaN(na) && !isNaN(nb) ? na-nb : String(va).localeCompare(String(vb));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }
  const exportRows = () => sorted(filtered());

  function csvValue(v) {
    v = String(v ?? '');
    return /[",\n]/.test(v) ? `"${v.replace(/"/g,'""')}"` : v;
  }
  function doDownloadCsv() {
    const hs = activeHeaders(), out = exportRows();
    const csv = [hs.join(','), ...out.map(r => hs.map(h => csvValue(r[h])).join(','))].join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], {type:'text/csv'}));
    a.download = filename + '.csv';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
  }
  function doDownloadExcel() {
    const hs = activeHeaders(), out = exportRows();
    const thead = `<tr>${hs.map(h=>`<th>${h}</th>`).join('')}</tr>`;
    const tbody = out.map(r => `<tr>${hs.map(h=>`<td>${r[h]??''}</td>`).join('')}</tr>`).join('');
    const html  = `<html><head><meta charset="UTF-8"></head><body><table>${thead}${tbody}</table></body></html>`;
    const a = document.createElement('a');
    a.href = 'data:application/vnd.ms-excel,' + encodeURIComponent(html);
    a.download = filename + '.xls';
    a.click();
  }

  // Popovers (filter / columns) are rendered fixed-position so they aren't
  // clipped by the table's horizontal scroll wrapper.
  function positionPopover() {
    const pop = container.querySelector('.dt-filter-pop');
    if (!pop) return;
    const anchor = pop.dataset.anchor === 'cols'
      ? $(`${containerId}_cols`)
      : container.querySelector(`.dt-filter-btn[data-filter-h="${CSS.escape(openFilterCol||'')}"]`);
    if (!anchor) return;
    const r = anchor.getBoundingClientRect();
    pop.style.top  = (r.bottom + 4) + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 250)) + 'px';
  }

  function renderFilterPop(h) {
    const vals = uniqueValues(h), selected = colFilters[h];
    const items = vals.map(v => `
      <label class="dt-filter-item">
        <input type="checkbox" value="${v.replace(/"/g,'&quot;')}" ${(!selected || selected.has(v)) ? 'checked' : ''}>
        <span>${v}</span>
      </label>`).join('');
    return `<div class="dt-filter-pop" data-for-h="${h}">
      <div class="dt-filter-list">${items || '<span class="dt-filter-item">No values</span>'}</div>
      <div class="dt-filter-pop-footer">
        <button type="button" class="dt-filter-clear">Clear</button>
        <button type="button" class="dt-filter-apply">Apply</button>
      </div>
    </div>`;
  }
  function renderColsPop() {
    const items = headers.map(h => `
      <label class="dt-filter-item">
        <input type="checkbox" value="${h}" ${visibleCols.has(h)?'checked':''}>
        <span>${h}</span>
      </label>`).join('');
    return `<div class="dt-filter-pop" data-anchor="cols"><div class="dt-filter-list">${items}</div></div>`;
  }

  function render() {
    const hs = activeHeaders();
    const all = sorted(filtered());
    const totalPages = Math.max(1, Math.ceil(all.length / pageSize));
    if (page > totalPages) page = totalPages;
    const pageRows = all.slice((page-1)*pageSize, (page-1)*pageSize + pageSize);

    const heading = (title || description) ? `
      <div class="dt-heading">
        ${title ? `<div class="dt-title">${title}</div>` : ''}
        ${description ? `<div class="dt-description">${description}</div>` : ''}
      </div>` : '';

    const toolbar = (searchable || downloadable || headers.length > 1) ? `
      <div class="dt-toolbar">
        <div class="dt-search-wrap">
          ${searchable ? `<input type="text" class="dt-search" id="${containerId}_search" placeholder="Search records\u2026" value="${searchTerm.replace(/"/g,'&quot;')}">` : ''}
        </div>
        <div class="dt-toolbar-actions">
          ${downloadable ? `<button type="button" class="btn-action" id="${containerId}_csv">Download CSV</button>
          <button type="button" class="btn-action" id="${containerId}_xls">Download Excel</button>` : ''}
          ${headers.length > 1 ? `<div class="dt-cols-wrap"><button type="button" class="btn-action" id="${containerId}_cols">Filter</button>${colsOpen ? renderColsPop() : ''}</div>` : ''}
        </div>
      </div>` : '';

    const head = hs.map(h => {
      const active   = !!colFilters[h];
      const arrow    = h === sortCol ? `<span class="sort-arrow">${sortDir==='asc'?'\u2191':'\u2193'}</span>` : '';
      const filterBt = filterable ? `<button type="button" class="dt-filter-btn${active?' active':''}" data-filter-h="${h}" title="Filter ${h}">\u25be</button>` : '';
      const pop      = (filterable && openFilterCol === h) ? renderFilterPop(h) : '';
      return `<th><div class="dt-th-inner"><span class="dt-th-label" data-sort-h="${h}">${h}${arrow}</span>${filterBt}</div>${pop}</th>`;
    }).join('');

    const body = pageRows.length
      ? pageRows.map(r => `<tr>${hs.map(h=>`<td>${r[h]??'\u2014'}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${hs.length}" class="dt-empty">No matching records.</td></tr>`;

    const pagination = `
      <div class="dt-pagination">
        <span>${all.length.toLocaleString()} record${all.length===1?'':'s'} \u00b7 Page ${page} of ${totalPages}</span>
        <div class="dt-page-btns">
          <button type="button" class="btn-action" id="${containerId}_prev" ${page<=1?'disabled':''}>Previous</button>
          <button type="button" class="btn-action" id="${containerId}_next" ${page>=totalPages?'disabled':''}>Next</button>
        </div>
      </div>`;

    container.innerHTML = `${heading}${toolbar}<div class="dt-scroll"><table class="dash-table"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>${pagination}`;

    // Sorting
    container.querySelectorAll('[data-sort-h]').forEach(el => {
      el.addEventListener('click', () => {
        const h = el.dataset.sortH;
        if (sortCol === h) sortDir = sortDir==='asc'?'desc':'asc';
        else { sortCol = h; sortDir = 'desc'; }
        render();
      });
    });

    // Column filters
    if (filterable) {
      container.querySelectorAll('[data-filter-h]').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const h = btn.dataset.filterH;
          openFilterCol = openFilterCol === h ? null : h;
          colsOpen = false;
          render();
        });
      });
      const fpop = container.querySelector('.dt-filter-pop[data-for-h]');
      if (fpop) {
        const h = fpop.dataset.forH;
        fpop.querySelectorAll('input[type=checkbox]').forEach(cb => {
          cb.addEventListener('change', () => {
            const vals = uniqueValues(h);
            if (!colFilters[h]) colFilters[h] = new Set(vals);
            cb.checked ? colFilters[h].add(cb.value) : colFilters[h].delete(cb.value);
            if (colFilters[h].size === vals.length) delete colFilters[h];
            page = 1;
            render();
          });
        });
        fpop.querySelector('.dt-filter-clear')?.addEventListener('click', e => { e.stopPropagation(); delete colFilters[h]; page = 1; render(); });
        fpop.querySelector('.dt-filter-apply')?.addEventListener('click', e => { e.stopPropagation(); openFilterCol = null; render(); });
      }
    }

    // Column show/hide
    if (headers.length > 1) {
      $(`${containerId}_cols`)?.addEventListener('click', e => {
        e.stopPropagation();
        colsOpen = !colsOpen;
        openFilterCol = null;
        render();
      });
      container.querySelector('.dt-filter-pop[data-anchor="cols"]')?.querySelectorAll('input[type=checkbox]').forEach(cb => {
        cb.addEventListener('change', () => {
          if (!cb.checked && visibleCols.size === 1) { cb.checked = true; return; } // always keep 1 column
          cb.checked ? visibleCols.add(cb.value) : visibleCols.delete(cb.value);
          render();
        });
      });
    }

    // Search
    if (searchable) {
      const inp = $(`${containerId}_search`);
      inp?.addEventListener('input', () => {
        searchTerm = inp.value.trim().toLowerCase();
        page = 1;
        render();
        const el = $(`${containerId}_search`);
        el.focus();
        el.selectionStart = el.selectionEnd = el.value.length;
      });
    }

    // Downloads
    if (downloadable) {
      $(`${containerId}_csv`)?.addEventListener('click', doDownloadCsv);
      $(`${containerId}_xls`)?.addEventListener('click', doDownloadExcel);
    }

    // Pagination
    $(`${containerId}_prev`)?.addEventListener('click', () => { if (page > 1) { page--; render(); } });
    $(`${containerId}_next`)?.addEventListener('click', () => { if (page < totalPages) { page++; render(); } });

    positionPopover();
  }

  // Close popovers on outside click (one listener per table instance).
  if (container._dtOutsideHandler) document.removeEventListener('click', container._dtOutsideHandler, true);
  container._dtOutsideHandler = e => {
    if (!openFilterCol && !colsOpen) return;
    const insideFilter = e.target.closest('.dt-filter-pop') || e.target.closest('.dt-filter-btn');
    const insideCols    = e.target.closest('.dt-cols-wrap');
    if (!insideFilter && !insideCols) { openFilterCol = null; colsOpen = false; render(); }
  };
  document.addEventListener('click', container._dtOutsideHandler, true);

  render();
}

/* -- Reusable header widgets (used by KPI + Heatmap) ----------------------- */
// Filter icon \u2192 floating popover. Closes on X, outside click, Escape, or Apply.
function initFilterPopover({ toggleId, popoverId, closeId, applyId }) {
  const toggleBtn = $(toggleId);
  const popover   = $(popoverId);
  const closeBtn  = $(closeId);
  const applyBtn  = $(applyId);
  if (!toggleBtn || !popover) return;

  function open() {
    popover.classList.remove('hidden');
    toggleBtn.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', onOutsideClick, true);
    document.addEventListener('keydown', onEscape);
  }
  function close() {
    popover.classList.add('hidden');
    toggleBtn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', onOutsideClick, true);
    document.removeEventListener('keydown', onEscape);
  }
  function onOutsideClick(e) {
    if (!popover.contains(e.target) && e.target !== toggleBtn && !toggleBtn.contains(e.target)) close();
  }
  function onEscape(e) { if (e.key === 'Escape') close(); }

  toggleBtn.addEventListener('click', () => {
    popover.classList.contains('hidden') ? open() : close();
  });
  closeBtn?.addEventListener('click', close);
  // Applying filters closes the popover so the results are visible again.
  applyBtn?.addEventListener('click', close);
}

// Table icon \u2192 floating modal (closes on X, backdrop click, or Escape).
function initTableModal({ openId, modalId, closeId, onOpen }) {
  const openBtn  = $(openId);
  const modal    = $(modalId);
  const closeBtn = $(closeId);
  if (!openBtn || !modal) return {};

  function open() {
    if (onOpen) onOpen();
    modal.classList.remove('hidden');
    document.addEventListener('keydown', onEscape);
  }
  function close() {
    modal.classList.add('hidden');
    document.removeEventListener('keydown', onEscape);
  }
  function onEscape(e) { if (e.key === 'Escape') close(); }

  openBtn.addEventListener('click', open);
  closeBtn?.addEventListener('click', close);
  // Click on the dimmed backdrop (outside the card) closes it.
  modal.addEventListener('click', e => { if (e.target === modal) close(); });

  // Exposed so other triggers (e.g. clicking a chart) can open/close the same modal.
  return { open, close };
}

/* ==========================================================================
   PREDICTION LAYER \u2014 everything below is specific to /api/pred/*
   KPI ............ always 1 semester ahead
   other charts ... up to `chart_steps` semesters ahead (grows with uploads)
   ========================================================================== */
const API = '/api/pred';
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const fmt = n => (n == null || isNaN(n)) ? '\u2014' : Number(n).toLocaleString('en-US');
const ordinal = n => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');
const STATUS_LABEL = { FAILED:'Failed', DRP:'Drop', UDR:'UDR', W:'W', INC:'INC', NGA:'NGA' };
const KPI_STATUSES = ['FAILED','DRP','INC','UDR','W','NGA'];
const PALETTE = ['#800000','#4E73DF','#1CC88A','#E74A3B','#8A2BE2','#36B9CC','#d97706',
                 '#fd7e14','#20c997','#d63384','#6c757d','#0d6efd','#8b5e3c','#4b8b3b'];
/* -- LINE COLORS (GWA Trend + At-Risk Forecast) \u2014 edit here -----------------
   "All" colleges  -> one line per college  -> COLLEGE_COLORS (key = college code)
   a college picked -> one line per course  -> COURSE_COLORS  (key = course name,
   upper-case, WITHOUT "Bachelor of Science in \u2026" \u2014 it is matched by containment,
   so 'NURSING' also matches "Bachelor of Science in Nursing").
   Anything not listed falls back to PALETTE. */
const COLLEGE_COLORS = {
  'CAHS': '#36b9cc',   // sky blue
  'CBA':  '#e74a3b',   // red
  'CCST': '#8a2be2',   // purple
  'CEA':  '#1cc88a',   // green
  'COAS': '#5a5c69',   // slate gray
  'CTEC': '#4e73df',   // blue
};
const COURSE_COLORS = {
  // CAHS
  'NURSING':                                 '#4e73df', // blue
  'PUBLIC HEALTH':                           '#ffb385', // peach
  'MIDWIFERY':                               '#e83e8c', // pink
  // CBA
  'TOURISM MANAGEMENT':                      '#f6c23e', // gold
  'HOSPITALITY MANAGEMENT':                  '#fd7e14', // orange
  // CCST
  'INFORMATION TECHNOLOGY':                  '#6f42c1', // purple
  'DATA SCIENCE':                            '#20c997', // teal
  'COMPUTER SCIENCE':                        '#17a2b8', // cyan
  'ENTERTAINMENT AND MULTIMEDIA COMPUTING':  '#d63384', // magenta
  // CEA
  'CIVIL ENGINEERING':                       '#1cc88a', // green
  'MECHANICAL ENGINEERING':                  '#858796', // slate gray
  'ARCHITECTURE':                            '#b8860b', // dark goldenrod
  'ELECTRICAL ENGINEERING':                  '#dc3545', // red
  'INDUSTRIAL ENGINEERING':                  '#6610f2', // indigo
  'COMPUTER ENGINEERING':                    '#36b9cc', // sky blue
  'ELECTRONICS ENGINEERING':                 '#495057', // dark gray
  // COAS
  'COMMUNICATION':                           '#ff6b6b', // coral
  // CTEC
  'INDUSTRIAL TECHNOLOGY':                   '#2e86de', // strong blue
  'TECHNICAL-VOCATIONAL TEACHER EDUCATION':  '#a55eea', // violet
};
const _colorMap = new Map();
const _norm = s => String(s == null ? '' : s).toUpperCase().replace(/\s+/g, ' ').trim();
const _courseKeys = Object.keys(COURSE_COLORS).sort((a, b) => b.length - a.length);   // longest match wins
const colorFor = label => {
  const u = _norm(label);
  if (COLLEGE_COLORS[u]) return COLLEGE_COLORS[u];
  if (COURSE_COLORS[u]) return COURSE_COLORS[u];
  const k = _courseKeys.find(key => u.includes(key));
  if (k) return COURSE_COLORS[k];
  if (!_colorMap.has(label)) _colorMap.set(label, PALETTE[_colorMap.size % PALETTE.length]);
  return _colorMap.get(label);
};
// Chart label for a program: its acronym (META.course_short, from /api/pred/meta).
// Filters keep the full name; anything not in the map (colleges, unknown programs)
// falls back to the old "BS in ..." shortening.
const shortCourse = c => (typeof META !== 'undefined' && META && META.course_short && META.course_short[c])
  || String(c || '').replace(/^Bachelor of Science in /, 'BS in ')
  .replace(/^Bachelor of Arts in /, 'BA in ').replace(/^Bachelor of /, 'B ');
const clip = (t, n) => (t && t.length > n ? t.slice(0, n - 1) + '\u2026' : (t || ''));

async function api(path, params) {
  const u = new URL(API + path, window.location.origin);
  Object.entries(params || {}).forEach(([k, v]) => {
    if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  });
  const r = await fetch(u, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`${path} \u2192 HTTP ${r.status}`);
  return r.json();
}

/* -- Global semester comparison (shared with main dashboard) -- */
/* -- Comparison lives in each chart's filter popover (default: None) --- */
const cmpOf = id => document.getElementById(id)?.value || '';
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('select[id$="Compare"]').forEach(sel => {
    const p = sel.id.replace(/Compare$/, '');
    document.getElementById(p + 'BtnReset')?.addEventListener('click', () => { sel.value = ''; }, true);
  });
});


/* -- State (each card keeps its own applied filters, like the main dashboard) -- */
let META = null;
const seq = { kpi: 0, hs: 0, gwa: 0, risk: 0, kt: 0, et: 0, wl: 0 };      // drop stale async responses
const blank = () => ({ dept:'', course:'', yl:'' });
let KF  = blank();                                            // KPI
let HSF = { ...blank(), horizon:'', subject:'', top:'10' };   // Hardest subjects
let GF  = { ...blank(), horizon:'', history:true, zoom:false };
let RF  = { ...blank(), horizon:'', history:true };
let KTF = { ...blank(), horizon:'', history:true };           // KPI Trend
let ETF = { ...blank(), horizon:'', history:true };           // Enrollment Trend
let kpiMetric = 'all', kpiStatusMetric = 'all';
let hsMetric = 'avg_grade', hsView = 'bar', hsSortDir = 'desc', hsModalKey = null;
let riskMetric = 'FAILED';
let kpiData = null, hsData = null, gwaData = null, riskData = null, ktData = null, etData = null;
let ktMetric = 'FAILED', etMetric = 'all';
const ENROLL_METRIC_LABEL = { all: 'All', regular: 'Regular', irregular: 'Irregular' };
const COMPARE_DESC = {
  '':     '',
  '1sem': '1st Semester only, year-over-year',
  '2sem': '2nd Semester only, year-over-year',
};
const tableCtx = {};                                          // prefix -> {rows, headers, name}

/* -- skeleton loading (styles live in skeleton.css) -------------------------
   A card shows placeholders while .is-loading is set. Each request adds one
   hold (skOn) and releases it when it finishes (skDone); the page also holds
   every card once at start so nothing flashes "\u2014" before the first response. */
const _skCount = {}, _skInit = {};
function skOn(id) {
  const el = $(id); if (!el) return;
  _skCount[id] = (_skCount[id] || 0) + 1;
  el.classList.add('is-loading'); el.setAttribute('aria-busy', 'true');
}
function skOff(id) {
  const el = $(id); if (!el) return;
  _skCount[id] = Math.max(0, (_skCount[id] || 0) - 1);
  if (!_skCount[id]) { el.classList.remove('is-loading'); el.removeAttribute('aria-busy'); }
}
function skDone(id) {
  skOff(id);
  if (_skInit[id]) { _skInit[id] = 0; skOff(id); }              // release the start-up hold once
}
const SK_CARDS = ['kpiCard', 'enrollTrendCard', 'kpiTrendCard', 'hardestCard', 'gwaCard', 'riskCard'];
SK_CARDS.forEach(id => { skOn(id); _skInit[id] = 1; });
setTimeout(() => SK_CARDS.forEach(id => { if (_skInit[id]) { _skInit[id] = 0; skOff(id); } }), 25000);  // never stay grey forever

/* -- phones: smaller chart text, shorter labels ---------------------------- */
const isNarrow = () => window.matchMedia('(max-width: 640px)').matches;
const baseFs = card => (isFs(card) ? 13 : (isNarrow() ? 10 : 11));
const shortTerm = l => String(l).replace(/^(\d{4})-(\d{4})\s+(1st|2nd)\s+Sem$/, (m, a, b, sm) => `${a.slice(2)}-${b.slice(2)} ${sm}`);


const scopeOf = F => ({ department:F.dept, course:F.course, year_level:F.yl });
const isFs = id => !!$(id)?.classList.contains('is-fullscreen');

/* -- Forecast band + line chart (solid = recorded, dashed/hollow = forecast) -- */
const forecastBand = {
  id: 'forecastBand',
  beforeDatasetsDraw(chart, _a, opts) {
    const i = opts && opts.firstPred;
    if (i == null || i < 0) return;
    const { ctx, chartArea, scales } = chart, x = scales.x;
    const at = x.getPixelForValue(i);
    const from = i > 0 ? (x.getPixelForValue(i - 1) + at) / 2 : chartArea.left;
    ctx.save();
    ctx.fillStyle = 'rgba(128,0,0,0.05)';
    ctx.fillRect(from, chartArea.top, chartArea.right - from, chartArea.height);
    ctx.fillStyle = 'rgba(128,0,0,0.6)';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText('Forecast', chartArea.right - 6, chartArea.bottom - 8);
    ctx.restore();
  },
};

function lineChart(canvasId, data, o) {
  const pred = data.predicted || [];
  const fs = o.fs || 11;
  const cp = isNarrow() && !isFs(o.card || '');            // compact phone mode
  const datasets = data.datasets.map((d, i) => {
    const color = o.colorOf ? o.colorOf(d, i) : colorFor(d.label);
    return {
      label: o.labelOf ? o.labelOf(d) : shortCourse(d.label), data: d.data,
      borderColor: color, backgroundColor: color, borderWidth: cp ? 1.6 : 2,
      tension: 0.3, spanGaps: true, pointRadius: cp ? 2.5 : 4, pointHoverRadius: cp ? 5 : 6,
      pointBorderWidth: cp ? 1.5 : 2, pointBorderColor: color,
      pointBackgroundColor: c => (pred[c.dataIndex] ? '#fff' : color),
      segment: { borderDash: c => (pred[c.p1DataIndex] ? (cp ? [4, 3] : [6, 4]) : undefined) },
    };
  });
  const y = { title: { display: !cp, text: o.yTitle, font: { size: fs } }, ticks: { font: { size: fs }, maxTicksLimit: cp ? 6 : 11 } };
  if (o.reverse) y.reverse = true;
  if (o.beginAtZero) y.beginAtZero = true;
  if (o.min != null) y.min = o.min;
  if (o.max != null) y.max = o.max;
  if (o.step) y.ticks.stepSize = o.step;
  return makeChart(canvasId, {
    type: 'line',
    data: { labels: data.labels, datasets },
    plugins: [forecastBand],
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      layout: { padding: cp ? { left: 0, right: 4, top: 4, bottom: 0 } : { right: 4, top: 4 } },
      scales: {
        x: {
          border: { display: true, color: '#e5e7eb' },
          grid: { color: '#f0f0f0', drawTicks: false },
          ticks: { font: { size: fs }, maxRotation: cp ? 0 : 35, maxTicksLimit: cp ? 5 : 20, autoSkip: true,
            callback(v) { const l = this.getLabelForValue(v); return isNarrow() ? shortTerm(l) : l; } }
        },
        y: { ...y, border: { display: true, color: '#e5e7eb' }, grid: { color: '#f0f0f0', drawTicks: false } },
      },
      plugins: {
        datalabels: o.noLabels ? { display: false } : {
          display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
          anchor: 'end', align: 'top', offset: 4, clip: false,
          font: { size: cp ? 8 : 9 },
          color: ctx => ctx.dataset.borderColor,
          formatter: v => (v == null ? '' : (o.valFmt ? o.valFmt(v) : Number(v).toLocaleString())),
        },
        forecastBand: { firstPred: pred.indexOf(true) },
        legend: {
          display: !(cp && data.datasets.length > 6),
          position: 'top',
          align: 'center',
          rtl: false,
          labels: { usePointStyle: true, boxWidth: cp ? 6 : 8, padding: cp ? 8 : 12, font: { size: fs }, color: '#374151' },
        },
        tooltip: { callbacks: {
          title: items => items[0].label + (pred[items[0].dataIndex] ? '  \u2726 forecast' : '  \u00b7 recorded'),
          label: c => (c.parsed.y == null ? null : ` ${c.dataset.label}: ${o.valFmt ? o.valFmt(c.parsed.y) : c.parsed.y}`),
          afterBody: items => {
            if (!o.showTotal || items.length < 2) return [];
            const sum = items.reduce((acc, c) => acc + (c.parsed.y ?? 0), 0);
            return ['---------', `Total: ${o.valFmt ? o.valFmt(sum) : Math.round(sum)}`];
          },
        } },
      },
    },
  });
}

/* -- shared: horizon / department / course / year-level selects -------------- */
function horizonOptions(p) {
  const sel = $(p + 'Horizon');
  if (!sel || !META) return;
  const hz = META.horizon || {};
  const terms = hz.terms || [];
  sel.innerHTML = terms.map(t =>
    `<option value="${t.step}">Next ${t.step} sem${t.step === 1 ? '' : 's'} (to ${esc(t.label)})</option>`).join('');
  sel.value = String(hz.chart_steps || terms.length || 1);
}
function fillCourses(p) {
  const dept = $(p + 'Dept')?.value, cs = $(p + 'Course');
  if (!cs) return;
  const cur = cs.value;
  while (cs.options.length > 1) cs.remove(1);
  (META.departments || []).filter(d => !dept || d.name === dept)
    .flatMap(d => d.courses).sort()
    .forEach(c => cs.add(new Option(c, c)));   // filter keeps the full program name
  cs.value = [...cs.options].some(o => o.value === cur) ? cur : '';
}
function fillScopeSelects(p) {
  const ds = $(p + 'Dept');
  if (ds) {
    while (ds.options.length > 1) ds.remove(1);
    (META.departments || []).forEach(d => ds.add(new Option(d.name, d.name)));
    ds.addEventListener('change', () => fillCourses(p));
  }
  fillCourses(p);
  const yl = $(p + 'YearLevel');
  if (yl) {
    while (yl.options.length > 1) yl.remove(1);
    (META.year_levels || []).forEach(n => yl.add(new Option(ordinal(n), String(n))));
  }
}
function readScope(p) {
  return { dept: $(p + 'Dept')?.value || '', course: $(p + 'Course')?.value || '', yl: $(p + 'YearLevel')?.value || '' };
}
function writeScope(p, F) {
  if ($(p + 'Dept')) $(p + 'Dept').value = F.dept;
  fillCourses(p);
  if ($(p + 'Course')) $(p + 'Course').value = F.course;
  if ($(p + 'YearLevel')) $(p + 'YearLevel').value = F.yl;
}
function scopeText(F) {
  const bits = [];
  if (F.dept) bits.push(F.dept);
  if (F.course) bits.push(shortCourse(F.course));
  if (F.yl) bits.push(ordinal(Number(F.yl)) + ' year');
  return bits.length ? bits.join(' \u00b7 ') : (window.NS_LOCK_COLLEGE || 'all colleges');
}

/* ==========================================================================
   1. KPI  (1 semester ahead)
   ========================================================================== */
async function loadKpi() {
  if (!$('kpiCard')) return;   // this page doesn't ship the KPI card — nothing to load
  const id = ++seq.kpi;
  skOn('kpiCard');
  $('kpiSubtitle').textContent = 'Loading forecast\u2026';
  try {
    const d = await api('/kpi', { ...scopeOf(KF), compare: cmpOf('kpiCompare') });
    if (id !== seq.kpi) return;
    kpiData = d;
    if (d.available === false) return kpiUnavailable(d.reason);
    renderKpi();
  } catch (e) {
    if (id !== seq.kpi) return;
    console.error(e);
    kpiUnavailable('Could not load the KPI forecast.');
  } finally {
    skDone('kpiCard');
  }
}
function kpiUnavailable(msg) {
  kpiData = null;
  $('kpiSubtitle').textContent = msg || 'No forecast available.';
  ['kpiEnrollVal','kpiGwaVal','kpiCompVal','kpiStatusVal'].forEach(i => { $(i).textContent = '\u2014'; });
  ['kpiEnrollPct','kpiEnrollDelta','kpiGwaDelta','kpiCompDelta','kpiYearLevelRow','kpiStatusBreakdown']
    .forEach(i => { $(i).innerHTML = ''; });
  ['kpiGwaPct','kpiCompPct','kpiStatusPct'].forEach(i => { $(i).className = 'kpi-mini-pct-badge flat'; $(i).textContent = '\u2014'; });
}
function pctBadge(el, pct, higherIsBetter) {
  if (pct == null || isNaN(pct)) { el.className = 'kpi-mini-pct-badge flat'; el.textContent = '\u2014'; return; }
  const up = pct > 0;
  el.className = 'kpi-mini-pct-badge ' + (pct === 0 ? 'flat' : ((up === higherIsBetter) ? 'up' : 'down'));
  el.textContent = (pct === 0 ? '' : (up ? '\u25b2 ' : '\u25bc ')) + Math.abs(pct).toFixed(1) + '%';
}
function renderKpi() {
  const d = kpiData;
  if (!d) return;
  if (d.empty) {
    kpiUnavailable(`No students are forecast for ${d.term.label} with these filters.`);
    return;
  }
  const prevLbl = d.prev_term.label;
  $('kpiSubtitle').innerHTML =
    `Predicted for <b>${esc(d.term.label)}</b> \u2014 1 semester ahead of ${esc(prevLbl)} \u00b7 ${esc(scopeText(KF))}`;
  $('kpiEnrollVs').textContent = `vs ${prevLbl}`;
  document.querySelectorAll('#kpiCard .kpi-delta-label').forEach(el => {
    if (el.id !== 'kpiEnrollVs') el.textContent = ` vs ${prevLbl}`;
  });

  // Enrollment (All / Regular / Irregular)
  const seg = d.enrollment[kpiMetric] || d.enrollment.all;
  $('kpiEnrollVal').textContent = fmt(seg.value);
  const delta = seg.prev == null ? null : seg.value - seg.prev;
  $('kpiEnrollDelta').innerHTML = delta == null ? ''
    : (delta === 0 ? enrollPill('No change', null, 14)
       : enrollPill(`${delta > 0 ? '\u25b2' : '\u25bc'} ${fmt(Math.abs(delta))}`, delta > 0, 14));
  $('kpiEnrollPct').innerHTML = seg.pct == null ? ''
    : enrollPill(`${seg.pct > 0 ? '\u25b2' : seg.pct < 0 ? '\u25bc' : ''} ${Math.abs(seg.pct).toFixed(1)}%`, seg.pct > 0 ? true : seg.pct < 0 ? false : null, 18);

  // Regular vs Irregular split bar
  const reg = d.enrollment.regular.value, irr = d.enrollment.irregular.value, tot = reg + irr;
  $('kpiRegIrregFillReg').style.flexBasis = (tot ? reg / tot * 100 : 0) + '%';
  $('kpiRegIrregFillIrreg').style.flexBasis = (tot ? irr / tot * 100 : 0) + '%';
  $('kpiRegIrregRegVal').textContent = fmt(reg);
  $('kpiRegIrregIrregVal').textContent = fmt(irr);
  $('kpiRegIrregRegPct').textContent = tot ? ` (${(reg / tot * 100).toFixed(1)}%)` : '';
  $('kpiRegIrregIrregPct').textContent = tot ? ` (${(irr / tot * 100).toFixed(1)}%)` : '';

  // Year-level chips (1st\u20134th + Irreg)
  const all = d.enrollment.all;
  $('kpiYearLevelRow').innerHTML = all.by_year.map(y => `
    <div class="kpi-yl-chip"><span class="kpi-yl-chip-num">${fmt(y.value)}</span>
      <span class="kpi-yl-chip-label">${ordinal(y.year_level)}</span>
      <span class="kpi-yl-chip-pct">${y.share.toFixed(1)}%</span></div>`).join('') + `
    <div class="kpi-yl-chip"><span class="kpi-yl-chip-num">${fmt(irr)}</span>
      <span class="kpi-yl-chip-label">Irreg</span>
      <span class="kpi-yl-chip-pct">${all.value ? (irr / all.value * 100).toFixed(1) : '0.0'}%</span></div>`;

  // GWA (lower is better)
  $('kpiGwaVal').textContent = d.gwa.value != null ? Number(d.gwa.value).toFixed(2) : '\u2014';
  $('kpiGwaDelta').innerHTML = (d.gwa.value != null && d.gwa.prev != null)
    ? deltaHtml(d.gwa.value - d.gwa.prev, '', true) : '';
  pctBadge($('kpiGwaPct'), d.gwa.pct, false);

  // Completion (higher is better)
  $('kpiCompVal').textContent = d.completion.value != null ? Number(d.completion.value).toFixed(1) + '%' : '\u2014';
  $('kpiCompDelta').innerHTML = (d.completion.value != null && d.completion.prev != null)
    ? deltaHtml(d.completion.value - d.completion.prev, '%') : '';
  pctBadge($('kpiCompPct'), d.completion.pct, true);

  renderKpiStatus();
}
function renderKpiStatus() {
  const d = kpiData, sc = d?.statuses || {};
  const keys = KPI_STATUSES.filter(s => s in sc);
  if (!d) return;
  if (kpiStatusMetric === 'all') {
    const sum = keys.reduce((s, k) => s + (sc[k].count || 0), 0);
    const prev = keys.reduce((s, k) => s + (sc[k].prev_count || 0), 0);
    $('kpiStatusVal').textContent = fmt(sum);
    pctBadge($('kpiStatusPct'), prev ? Math.round((sum - prev) / prev * 1000) / 10 : null, false);
    $('kpiStatusBreakdown').innerHTML = keys.map(k => `
      <div class="status-chip"><span class="status-chip-val">${fmt(sc[k].count)}</span>
        <span class="status-chip-label">${k === 'DRP' ? 'Drop' : k}</span></div>`).join('');
  } else {
    const s = sc[kpiStatusMetric] || { count: 0 };
    $('kpiStatusVal').textContent = fmt(s.count);
    pctBadge($('kpiStatusPct'), s.pct, false);
    $('kpiStatusBreakdown').innerHTML = `
      <div class="status-chip"><span class="status-chip-val">${s.ratio == null ? '\u2014' : s.ratio + '%'}</span>
        <span class="status-chip-label">of forecast students</span></div>
      <div class="status-chip"><span class="status-chip-val">${s.ratio_prev == null ? '\u2014' : s.ratio_prev + '%'}</span>
        <span class="status-chip-label">last recorded</span></div>`;
  }
}
function kpiTableRows() {
  const d = kpiData; if (!d || d.empty) return [];
  const rows = []; let i = 0;
  const add = (metric, now, prev, unit = '') => {
    const ch = (now == null || prev == null) ? '\u2014'
      : ((now - prev >= 0 ? '+' : '') + (Math.round((now - prev) * 100) / 100) + unit);
    rows.push({ '#': String(++i), 'Metric': metric, 'Predicted': now == null ? '\u2014' : fmt(now) + unit,
                [`Last recorded`]: prev == null ? '\u2014' : fmt(prev) + unit, 'Change': ch });
  };
  const e = d.enrollment;
  add('Total Enrollment', e.all.value, e.all.prev);
  add('Regular', e.regular.value, e.regular.prev);
  add('Irregular', e.irregular.value, e.irregular.prev);
  e.all.by_year.forEach(y => add(`${ordinal(y.year_level)} year`, y.value, null));
  add('Average GWA', d.gwa.value, d.gwa.prev);
  add('Avg Completion Rate', d.completion.value, d.completion.prev, '%');
  Object.keys(d.statuses).filter(k => KPI_STATUSES.includes(k)).forEach(k =>
    add(`${k === 'FAILED' ? 'Failed' : k} students`, d.statuses[k].count, d.statuses[k].prev_count));
  return rows;
}
function renderKpiTable() {
  const rows = kpiTableRows();
  const headers = ['#','Metric','Predicted','Last recorded','Change'];
  tableCtx.kpi = { rows, headers, name: 'kpi_forecast' };
  $('kpiTableModalTitle').textContent = `KPI \u2014 Table View (${kpiData?.term?.label || ''})`;
  buildTable('kpiTableInner', rows, headers, '#', 'asc',
    { pageSize: 25, filename: 'kpi_forecast', searchable: false, filterable: false });
}

/* ==========================================================================
   2. TOP HARDEST SUBJECTS
   ========================================================================== */
const hsIsGrade = () => hsMetric === 'avg_grade';
const hsMetricLabel = () => hsIsGrade() ? 'Predicted average grade (1.00 best \u2013 5.00 worst)'
  : `Predicted ${STATUS_LABEL[hsMetric]} rate (% of enrolled students)`;
const hsVal = i => hsIsGrade() ? i.avg_grade : i.rate;
const hsFmt = v => v == null ? '\u2014' : hsIsGrade() ? Number(v).toFixed(2) : Number(v).toFixed(1) + '%';
const hsKey = i => `${i.code}|${i.course}`;
const hsChange = i => hsIsGrade() ? i.grade_change : i.rate_change;
const hsPrevVal = i => !i.prev ? null : (hsIsGrade() ? i.prev.avg_grade : i.prev.rate);
const hsChgText = c => c == null ? '' : (c > 0 ? '\u25b2 ' : c < 0 ? '\u25bc ' : '')
  + (hsIsGrade() ? Math.abs(c).toFixed(2) : Math.abs(c).toFixed(1) + ' pts');
const hsChgClass = c => c == null || c === 0 ? 'flat' : (c > 0 ? 'worse' : 'better');   // higher grade / rate = worse
const hsBarText = i => {
  if (isNarrow()) { const c0 = hsChgText(hsChange(i)); return hsFmt(hsVal(i)) + (c0 ? '  ' + c0 : ''); }
  const base = hsIsGrade()
    ? `${hsFmt(i.avg_grade)} (${fmt(i.students)} ${i.students === 1 ? 'student' : 'students'})`
    : `${hsFmt(i.rate)} (${fmt(i.affected)} of ${fmt(i.students)})`;
  const c = hsChgText(hsChange(i));
  return c ? `${base}  ${c}` : base;
};

function hsRows() {
  if (!hsData?.items?.length) return [];
  const rows = [...hsData.items].sort((a, b) => (hsVal(b) ?? -1) - (hsVal(a) ?? -1));
  return hsSortDir === 'asc' ? rows.reverse() : rows;
}
function hsColor(val, max, isGrade) {
  const t = isGrade ? Math.max(0, Math.min(1, (val - 1) / 4)) : (max > 0 ? Math.min(val / max, 1) : 0);
  if (t > 0.65) return 'rgba(220,38,38,0.85)';
  if (t > 0.35) return 'rgba(234,179,8,0.85)';
  return 'rgba(34,197,94,0.75)';
}
async function loadHardest() {
  if (!$('hardestCard')) return;   // this page doesn't ship the Subjects card — nothing to load
  const id = ++seq.hs;
  skOn('hardestCard');
  ['hsBarArea','hsCardsArea','hsTrendArea'].forEach(a => { const el = $(a); if (el && !el.classList.contains('hidden')) loading(a); });
  try {
    const d = await api('/hardest', {
      ...scopeOf(HSF), metric: hsIsGrade() ? 'FAILED' : hsMetric, rank_by: hsIsGrade() ? 'grade' : 'rate',
      compare: cmpOf('hsCompare'),
      top: HSF.top, subject: HSF.subject, horizon: HSF.horizon, history: 1,
    });
    if (id !== seq.hs) return;
    hsData = d;
    if (d.available === false) { hsData = null; return showHsEmpty(d.reason); }
    fillSubjectOptions(d.options || []);
    $('hsSubtitle').innerHTML = `Predicted for <b>${esc(d.target_term.label)}</b> (next semester) vs each subject\u2019s last recorded offering \u00b7 ${esc(scopeText(HSF))}`;
    renderHardestActive();
  } catch (e) {
    if (id !== seq.hs) return;
    console.error(e);
    hsData = null; showHsEmpty('Could not load the subject forecast.');
  } finally {
    skDone('hardestCard');
  }
}
function fillSubjectOptions(opts) {
  const sel = $('hsSubject'); if (!sel) return;
  // options are limited by the chosen scope but NOT by the subject itself
  const cur = HSF.subject;
  sel.innerHTML = '<option value="">All Subjects</option>' +
    opts.map(o => `<option value="${esc(o.code)}">${esc(o.title)} (${esc(o.code)})</option>`).join('');
  sel.value = [...sel.options].some(o => o.value === cur) ? cur : '';
}
function showHsEmpty(msg) {
  ['hsBarArea','hsCardsArea','hsTrendArea'].forEach(a => { if ($(a)) empty(a, msg); });
  $('hsBarArea')?.classList.remove('clickable');
}
function renderHardestActive() {
  const areas = { bar: 'hsBarArea', cards: 'hsCardsArea', trend: 'hsTrendArea' };
  Object.entries(areas).forEach(([v, a]) => $(a)?.classList.toggle('hidden', v !== hsView));
  if (!hsData) return;
  if (hsView === 'bar') renderHardestBar();
  else if (hsView === 'cards') renderHardestCards();
  else renderHardestTrend();
}
function renderHardestBar() {
  const area = $('hsBarArea'), subs = hsRows();
  const tgt = hsData?.target_term?.label || 'the next semester';
  if (!subs.length) { empty('hsBarArea', `No subject with these filters is normally offered in ${esc(tgt)}. Only subjects that run in that semester slot are listed.`); area.classList.remove('clickable'); return; }
  area.classList.add('clickable');
  area.innerHTML = '<canvas id="hsBarCanvas"></canvas>';
  area.style.setProperty('--hs-h', Math.max(isNarrow() ? 240 : 360, subs.length * ((isNarrow() && !isFs('hardestCard')) ? 44 : 74) + ((isNarrow() && !isFs('hardestCard')) ? 70 : 110)) + 'px');
  const fs = baseFs('hardestCard');
  const vals = subs.map(hsVal).map(v => v ?? 0);
  const prevVals = subs.map(i => hsPrevVal(i));
  const maxV = Math.max(...vals, ...prevVals.filter(v => v != null), 1), isGrade = hsIsGrade();
  const m = document.createElement('canvas').getContext('2d');
  m.font = `600 ${fs}px Inter, sans-serif`;
  const padR = Math.ceil(Math.max(...subs.map(hsBarText).map(t => m.measureText(t).width))) + 14;
  const prevLbl = subs.find(i => i.prev)?.prev.term.label;
  const prevText = v => v == null ? '' : (isGrade ? Number(v).toFixed(2) : Number(v).toFixed(1) + '%');
  makeChart('hsBarCanvas', {
    type: 'bar',
    data: { labels: subs.map(s => (isNarrow() && !isFs('hardestCard')) ? [clip(s.title, 24)] : [clip(s.title, 34), clip(shortCourse(s.course), 34)]),
      datasets: [
        { label: `Predicted \u00b7 ${tgt}`, data: vals,
          backgroundColor: vals.map(v => hsColor(v, maxV, isGrade)),
          minBarLength: 6, borderRadius: 5, borderSkipped: false, barPercentage: 0.9, categoryPercentage: 0.8,
          datalabels: { anchor: 'end', align: 'right', clip: false, color: '#111',
            font: { size: fs, weight: '600' }, formatter: (v, ctx) => hsBarText(subs[ctx.dataIndex]) } },
        { label: `Last recorded offering${prevLbl ? ' \u00b7 ' + prevLbl : ''}`, data: prevVals,
          backgroundColor: 'rgba(156,163,175,0.55)', minBarLength: 6, borderRadius: 5, borderSkipped: false,
          barPercentage: 0.9, categoryPercentage: 0.8,
          datalabels: { anchor: 'end', align: 'right', clip: false, color: '#6b7280',
            font: { size: fs, weight: '500' }, formatter: v => prevText(v) } },
      ] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      layout: { padding: { right: padR } },
      onClick: (evt, els) => {
        if (!els?.length) return;
        evt.native?.stopPropagation();
        hsModalKey = hsKey(subs[els[0].index]);
        hsModal?.open?.();
      },
      plugins: {
        legend: { display: true, position: 'bottom', labels: { usePointStyle: true, boxWidth: 8, font: { size: fs } } },
        tooltip: { callbacks: {
          title: it => { const s = subs[it[0].dataIndex]; return `${s.title} (${s.code})`; },
          label: c => {
            const s = subs[c.dataIndex];
            if (c.datasetIndex === 1) {
              return s.prev ? [`Last recorded (${s.prev.term.label}): ${prevText(c.raw)}`,
                               `${fmt(s.prev.students)} students \u00b7 ${fmt(s.prev.affected)} ${STATUS_LABEL[hsIsGrade() ? 'FAILED' : hsMetric]}`] : null;
            }
            return [
              `${isGrade ? 'Predicted avg grade' : 'Predicted ' + STATUS_LABEL[hsMetric] + ' rate'}: ${hsFmt(c.raw)}`,
              hsChgText(hsChange(s)) ? `Change vs last offering: ${hsChgText(hsChange(s))}` : 'No earlier offering to compare',
              shortCourse(s.course) + ' \u00b7 ' + s.college,
              `${fmt(s.students)} students \u00b7 ${fmt(s.affected)} ${STATUS_LABEL[hsIsGrade() ? 'FAILED' : hsMetric]}`,
            ];
          } } },
      },
      scales: {
        x: { min: isGrade ? 1 : 0, max: isGrade ? 5 : undefined, beginAtZero: !isGrade,
             title: { display: true, text: hsMetricLabel(), font: { size: fs } },
             ticks: { font: { size: fs }, callback: v => (isGrade ? v : v + '%') } },
        y: { ticks: { font: { size: fs }, autoSkip: false }, grid: { display: false } },
      },
    },
    plugins: window.ChartDataLabels ? [window.ChartDataLabels] : [],
  });
}
function renderHardestCards() {
  const area = $('hsCardsArea'), subs = hsRows();
  if (!subs.length) { area.innerHTML = '<div class="chart-empty">No subject with these filters is normally offered in the next semester.</div>'; return; }
  const isGrade = hsIsGrade(), vals = subs.map(hsVal).map(v => v ?? 0), maxV = Math.max(...vals, 1);
  const pct = v => Math.max(3, isGrade ? Math.max(0, Math.min(100, (v - 1) / 4 * 100))
                                        : (maxV > 0 ? Math.min(100, v / maxV * 100) : 0));
  area.innerHTML = `<div class="ranked-bars">${subs.map((s, i) => {
    const v = vals[i], c = s.counts || {};
    return `
    <div class="rb-row" data-key="${esc(hsKey(s))}" style="--i:${i}">
      <div class="rb-rank">${i + 1}</div>
      <div class="rb-body">
        <div class="rb-head">
          <span class="rb-title">${esc(s.title)}</span>
          <span class="rb-code">${esc(s.code)}</span>
          <span class="rb-value">${hsFmt(hsVal(s))}</span>
          ${hsChange(s) != null ? `<span class="rb-delta ${hsChgClass(hsChange(s))}">${hsChgText(hsChange(s)) || 'No change'}</span>` : ''}
        </div>
        <div class="rb-track"><div class="rb-fill" style="width:${pct(v).toFixed(1)}%; background:${hsColor(v, maxV, isGrade)}"></div></div>
        <div class="rb-meta">${esc(shortCourse(s.course))} \u00b7 ${esc(s.college)} \u00b7 ${fmt(s.students)} students predicted for ${esc(s.term.label)}</div>
        <div class="rb-prevline">${s.prev ? `Last recorded offering (${esc(s.prev.term.label)}): <b>${hsFmt(hsPrevVal(s))}</b> \u00b7 ${fmt(s.prev.students)} students` : 'No earlier recorded offering to compare'}</div>
        <div class="rb-chips">
          ${c.FAILED != null ? `<span class="rc-chip">F:${c.FAILED}</span>` : ''}
          ${c.INC != null ? `<span class="rc-chip inc">INC:${c.INC}</span>` : ''}
          ${c.DRP != null ? `<span class="rc-chip drp">DRP:${c.DRP}</span>` : ''}
          ${c.UDR != null ? `<span class="rc-chip udr">UDR:${c.UDR}</span>` : ''}
          ${c.W != null ? `<span class="rc-chip w">W:${c.W}</span>` : ''}
          ${s.avg_grade != null ? `<span class="rc-chip grade">GWA:${Number(s.avg_grade).toFixed(2)}</span>` : ''}
        </div>
      </div>
    </div>`; }).join('')}</div>`;
  area.querySelectorAll('.rb-row').forEach(row => row.addEventListener('click', evt => {
    evt.stopPropagation(); hsModalKey = row.dataset.key; hsModal?.open?.();
  }));
}
function renderHardestTrend() {
  const area = $('hsTrendArea'), L = hsData?.lines;
  if (!L?.datasets?.length) { empty('hsTrendArea', 'No trend data for the current filters.'); return; }
  area.innerHTML = '<canvas id="hsTrendCanvas"></canvas>';
  lineChart('hsTrendCanvas', L, {
    card: 'hardestCard', fs: baseFs('hardestCard'), reverse: true, min: 1, max: 5, step: 0.5,
    yTitle: 'Average Grade (1.00 = best, at top)', valFmt: v => Number(v).toFixed(2),
    labelOf: d => `${clip(d.label, isNarrow() ? 28 : 46)}`, colorOf: (d, i) => PALETTE[i % PALETTE.length],
  });
}
function hsTableRows(key) {
  const subs = hsRows().filter(s => !key || hsKey(s) === key);
  return subs.map((s, i) => {
    const c = s.counts || {};
    const r = { '#': String(i + 1), 'Code': s.code, 'Subject': s.title, 'Department': s.college,
      'Course': shortCourse(s.course), 'Predicted term': s.term.label, 'Students': fmt(s.students),
      'Failed': c.FAILED ?? '\u2014', 'INC': c.INC ?? '\u2014', 'DRP': c.DRP ?? '\u2014', 'UDR': c.UDR ?? '\u2014', 'W': c.W ?? '\u2014',
      'Avg Grade': s.avg_grade == null ? '\u2014' : Number(s.avg_grade).toFixed(2) };
    if (!hsIsGrade()) r[`${STATUS_LABEL[hsMetric]} rate`] = hsFmt(s.rate);
    r['Last recorded term'] = s.prev ? s.prev.term.label : '\u2014';
    r['Last recorded'] = s.prev ? hsFmt(hsPrevVal(s)) : '\u2014';
    r['Change'] = hsChange(s) == null ? '\u2014' : (hsChange(s) > 0 ? '+' : '') + (hsIsGrade() ? hsChange(s).toFixed(2) : hsChange(s).toFixed(1) + ' pts');
    return r;
  });
}
function renderHsTable() {
  const rows = hsTableRows(hsModalKey);
  const headers = rows.length ? Object.keys(rows[0]) : ['#'];
  tableCtx.hs = { rows, headers, name: 'hardest_subjects_forecast' };
  const one = hsModalKey ? rows[0] : null;
  $('hsTableModalTitle').textContent = one ? `${one['Subject']} \u2014 Table View` : 'Top Hardest Subjects \u2014 Table View';
  buildTable('hsTableInner', rows, headers, '#', 'asc', {
    pageSize: 10, filename: 'hardest_subjects_forecast',
    title: one ? '' : 'Predicted for the next semester, compared with the last recorded offering',
    description: hsData ? `Target: ${hsData.target_term.label}. Counts are predicted students.` : '',
  });
}

/* ==========================================================================
   3 + 4. GWA TREND and AT-RISK FORECAST (shared line-chart card logic)
   ========================================================================== */
async function loadGwa() {
  if (!$('gwaCard')) return;   // this page doesn't ship the GWA card — nothing to load
  const id = ++seq.gwa;
  skOn('gwaCard');
  loading('gwaArea');
  try {
    const d = await api('/gwa_trend', { ...scopeOf(GF), horizon: GF.horizon, history: GF.history ? 1 : 0, compare: cmpOf('gwaCompare') });
    if (id !== seq.gwa) return;
    gwaData = d.available === false ? null : d;
    if (!gwaData) return empty('gwaArea', d.reason);
    $('gwaSubtitle').innerHTML = `Predicted average GWA per ${d.group_by} \u2014 next <b>${d.steps}</b> semester${d.steps === 1 ? '' : 's'} \u00b7 ${esc(scopeText(GF))}`;
    renderGwa();
  } catch (e) {
    if (id !== seq.gwa) return;
    console.error(e); gwaData = null; empty('gwaArea', 'Could not load the GWA forecast.');
  } finally {
    skDone('gwaCard');
  }
}
function renderGwa() {
  const area = $('gwaArea');
  if (!gwaData?.datasets?.some(d => d.data.some(v => v != null))) {
    empty('gwaArea', 'No predicted GWA for this filter.'); area.classList.remove('clickable'); return;
  }
  area.classList.add('clickable');
  area.innerHTML = '<canvas id="gwaTrendChart"></canvas>';
  const vals = gwaData.datasets.flatMap(d => d.data).filter(v => v != null);
  const o = { fs: baseFs('gwaCard'), reverse: true, yTitle: 'Average GWA (1.00 = best, at top)',
              valFmt: v => Number(v).toFixed(2) };
  if (GF.zoom && vals.length) {
    const lo = Math.min(...vals), hi = Math.max(...vals), pad = Math.max(0.05, (hi - lo) * 0.2);
    o.min = Math.max(1, Math.floor((lo - pad) * 20) / 20); o.max = Math.min(5, Math.ceil((hi + pad) * 20) / 20);
  } else { o.min = 1; o.max = 5; o.step = 0.5; }
  o.card = 'gwaCard';
  lineChart('gwaTrendChart', gwaData, o);
}
async function loadKpiTrend() {
  if (!$('kpiTrendCard')) return;   // this page doesn't ship the Status Trend card — nothing to load
  const id = ++seq.kt;
  skOn('kpiTrendCard');
  loading('kpiTrendArea');
  try {
    const cmp = $('kpiTrendCompare')?.value || '';
    const d = await api('/kpi_trend', { ...scopeOf(KTF), metric: ktMetric, compare: cmp, horizon: KTF.horizon, history: KTF.history ? 1 : 0 });
    if (id !== seq.kt) return;
    ktData = d.available === false ? null : d;
    if (!ktData) return empty('kpiTrendArea', d.reason);
    const sub = $('kpiTrendSubtitle');
    const cmpDesc = COMPARE_DESC[d.compare || ''];
    if (sub) sub.innerHTML = `Predicted students with ${esc(STATUS_LABEL[ktMetric] || ktMetric)} per ${d.group_by} \u2014 next <b>${d.steps}</b> semester${d.steps === 1 ? '' : 's'} \u00b7 ${esc(scopeText(KTF))}` + (cmpDesc ? ` \u00b7 ${esc(cmpDesc)}` : '');
    renderKpiTrend();
  } catch (e) {
    if (id !== seq.kt) return;
    console.error(e); ktData = null; empty('kpiTrendArea', 'Could not load the status trend.');
  } finally {
    skDone('kpiTrendCard');
  }
}
function renderKpiTrend() {
  const area = $('kpiTrendArea');
  if (!ktData?.datasets?.some(d => d.data.some(v => v != null))) {
    empty('kpiTrendArea', 'No predicted status data for this filter.'); area.classList.remove('clickable'); return;
  }
  area.classList.add('clickable');
  area.innerHTML = '<canvas id="kpiTrendChart"></canvas>';
  lineChart('kpiTrendChart', ktData, { card: 'kpiTrendCard', fs: baseFs('kpiTrendCard'), beginAtZero: true,
    yTitle: `Students with ${STATUS_LABEL[ktMetric] || ktMetric}`,
    valFmt: v => fmt(Math.round(v)),
    showTotal: true });
}
async function loadEnrollTrend() {
  if (!$('enrollTrendCard')) return;   // this page doesn't ship the Enrollment Trend card — nothing to load
  const id = ++seq.et;
  skOn('enrollTrendCard');
  loading('enrollTrendArea');
  try {
    const cmp = $('enrollTrendCompare')?.value || '';
    const d = await api('/enrollment_trend', { ...scopeOf(ETF), metric: etMetric, compare: cmp, horizon: ETF.horizon, history: ETF.history ? 1 : 0 });
    if (id !== seq.et) return;
    etData = d.available === false ? null : d;
    if (!etData) return empty('enrollTrendArea', d.reason);
    const sub = $('enrollTrendSubtitle');
    const cmpDesc = COMPARE_DESC[d.compare || ''];
    if (sub) sub.innerHTML = `Predicted ${esc(ENROLL_METRIC_LABEL[etMetric] || etMetric)} enrollment per ${d.group_by} \u2014 next <b>${d.steps}</b> semester${d.steps === 1 ? '' : 's'} \u00b7 ${esc(scopeText(ETF))}` + (cmpDesc ? ` \u00b7 ${esc(cmpDesc)}` : '');
    renderEnrollTrend();
  } catch (e) {
    if (id !== seq.et) return;
    console.error(e); etData = null; empty('enrollTrendArea', 'Could not load the enrollment trend.');
  } finally {
    skDone('enrollTrendCard');
  }
}
function renderEnrollTrend() {
  const area = $('enrollTrendArea');
  if (!etData?.datasets?.some(d => d.data.some(v => v != null))) {
    empty('enrollTrendArea', 'No predicted enrollment data for this filter.'); area.classList.remove('clickable'); return;
  }
  area.classList.add('clickable');
  area.innerHTML = '<canvas id="enrollTrendChart"></canvas>';
  lineChart('enrollTrendChart', etData, { card: 'enrollTrendCard', fs: baseFs('enrollTrendCard'), beginAtZero: true,
    yTitle: `${ENROLL_METRIC_LABEL[etMetric] || etMetric} Enrollment`,
    valFmt: v => fmt(Math.round(v)),
    showTotal: true });
}
async function loadRisk() {
  if (!$('riskCard')) return;   // this page doesn't ship the Risk card — nothing to load
  const id = ++seq.risk;
  skOn('riskCard');
  loading('riskArea');
  try {
    const d = await api('/at_risk', { ...scopeOf(RF), metric: riskMetric, horizon: RF.horizon, history: RF.history ? 1 : 0, compare: cmpOf('riskCompare') });
    if (id !== seq.risk) return;
    riskData = d.available === false ? null : d;
    if (!riskData) return empty('riskArea', d.reason);
    $('riskSubtitle').innerHTML = `Predicted students with ${esc(STATUS_LABEL[riskMetric])} per ${d.group_by} \u2014 next <b>${d.steps}</b> semester${d.steps === 1 ? '' : 's'} \u00b7 ${esc(scopeText(RF))}`;
    renderRisk();
  } catch (e) {
    if (id !== seq.risk) return;
    console.error(e); riskData = null; empty('riskArea', 'Could not load the at-risk forecast.');
  } finally {
    skDone('riskCard');
  }
}
function renderRisk() {
  const area = $('riskArea');
  if (!riskData?.datasets?.some(d => d.data.some(v => v != null))) {
    empty('riskArea', 'No predicted students for this filter.'); area.classList.remove('clickable'); return;
  }
  area.classList.add('clickable');
  area.innerHTML = '<canvas id="atRiskChart"></canvas>';
  lineChart('atRiskChart', riskData, { card: 'riskCard', fs: baseFs('riskCard'), beginAtZero: true,
    yTitle: `Students with ${STATUS_LABEL[riskMetric] || riskMetric}`,
    valFmt: v => fmt(Math.round(v)),
    showTotal: true });
}
function lineTableRows(data, unit) {
  return data.labels.map((lbl, i) => {
    const r = { '#': String(i + 1), 'Term': lbl, 'Type': data.predicted[i] ? 'Forecast' : 'Recorded' };
    data.datasets.forEach(d => { const v = d.data[i]; r[shortCourse(d.label)] = v == null ? '\u2014' : (unit ? unit(v) : v); });
    return r;
  });
}
function renderLineTable(p, data, title, unit) {
  const rows = lineTableRows(data, unit);
  const headers = rows.length ? Object.keys(rows[0]) : ['#'];
  tableCtx[p] = { rows, headers, name: title.toLowerCase().replace(/[^a-z0-9]+/g, '_') };
  buildTable(p + 'TableInner', rows, headers, '#', 'asc',
    { pageSize: 12, filename: tableCtx[p].name, searchable: false, filterable: false });
}

/* ==========================================================================
   Banner + wiring
   ========================================================================== */
function setBanner(meta) {
  const b = $('predBanner'), t = $('predBannerText');
  if (!meta || meta.available === false) {
    b.classList.add('pred-note-warn');
    t.textContent = (meta && meta.reason) || 'No prediction model yet \u2014 upload enough semesters and let training finish.';
    return;
  }
  b.classList.remove('pred-note-warn');
  const hz = meta.horizon || {};
  const when = meta.trained_at ? new Date(meta.trained_at).toLocaleDateString('en-US') : '';
  t.innerHTML = `Every value on this page is a <b>forecast</b> built from <b>${hz.n_semesters}</b> recorded semesters ` +
    `(${esc(hz.first_term)} to ${esc(hz.last_term)}). KPI values look <b>1 semester</b> ahead; the charts look up to ` +
    `<b>${hz.chart_steps}</b> semesters ahead, and that range grows automatically as more semesters are uploaded.` +
    (when ? ` Model trained ${esc(when)}.` : '');
}
function unavailable(meta) {
  SK_CARDS.forEach(skDone);
  setBanner(meta);
  kpiUnavailable(meta?.reason);
  ['hsBarArea','hsCardsArea','hsTrendArea','gwaArea','riskArea','kpiTrendArea','enrollTrendArea'].forEach(a => empty(a, meta?.reason || 'No prediction model yet.'));
  ['hsBarArea','gwaArea','riskArea','kpiTrendArea','enrollTrendArea'].forEach(a => $(a)?.classList.remove('clickable'));
}
/* -- At-Risk Student Watchlist ---------------------------------------------
   The ONLY card reading at_risk_classifier / gwa_regression /
   completion_rate_forecast's output (via /api/pred/watchlist, which serves
   the student_risk_watchlist.pkl bundle auto_train.py now builds from
   them). Every other card above reads pred_cube.pkl / pred_subjects.pkl,
   which only ever give college/course/subject-level aggregate trends —
   this is the one place that answers "which specific students", not just
   "which group is trending worse". This card's HTML isn't part of this
   change (same situation as the main dashboard's Performance Trend), so
   it's built + styled here in JS rather than assumed to already exist. */
let wlData = null;
let wlSortBy = 'risk';
let wlOnlyAtRisk = false;

function _ensureWatchlistCard() {
  let card = $('watchlistCard');
  if (card) return card;
  const anchor = $('riskCard');
  if (!anchor) return null;   // this page doesn't ship the Risk card either — nothing to anchor to

  if (!$('watchlistCardStyle')) {
    const style = document.createElement('style');
    style.id = 'watchlistCardStyle';
    style.textContent = `
      #watchlistCard { margin-top: 18px; }
      .wl-header { display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:10px; }
      .wl-title { font-weight:700; font-size:14px; color:#1e293b; }
      .wl-controls { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
      .wl-btn { font-size:11px; padding:4px 10px; border-radius:999px; border:1px solid #e2e8f0; background:#fff; color:#475569; cursor:pointer; }
      .wl-btn.active { background:#7B1113; border-color:#7B1113; color:#fff; }
      .wl-toggle { font-size:11px; color:#475569; display:flex; align-items:center; gap:4px; }
      .wl-table-wrap { max-height: 420px; overflow-y:auto; border:1px solid #e2e8f0; border-radius:8px; }
      table.wl-table { width:100%; border-collapse:collapse; font-size:12px; }
      table.wl-table th { position:sticky; top:0; background:#f8fafc; text-align:left; padding:8px 10px; font-weight:600; color:#475569; border-bottom:1px solid #e2e8f0; z-index:1; }
      table.wl-table td { padding:7px 10px; border-bottom:1px solid #f1f5f9; }
      table.wl-table tr:hover { background:#f8fafc; }
      .wl-risk-pill { display:inline-block; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; }
      .wl-risk-high { background:#fee2e2; color:#991b1b; }
      .wl-risk-low  { background:#dcfce7; color:#166534; }
      .wl-summary { font-size:12px; color:#475569; margin-bottom:8px; }
    `;
    document.head.appendChild(style);
  }

  card = document.createElement('div');
  card.id = 'watchlistCard';
  card.className = 'card';
  card.innerHTML = `
    <div class="wl-header">
      <div class="wl-title">At-Risk Student Watchlist — next semester</div>
      <div class="wl-controls">
        <button type="button" class="wl-btn active" data-wl-sort="risk">By Risk</button>
        <button type="button" class="wl-btn" data-wl-sort="gwa">By GWA</button>
        <button type="button" class="wl-btn" data-wl-sort="completion">By Completion</button>
        <label class="wl-toggle"><input type="checkbox" id="wlOnlyAtRisk"> At-risk only</label>
      </div>
    </div>
    <div class="wl-summary" id="wlSummary"></div>
    <div id="wlArea"></div>`;
  anchor.insertAdjacentElement('afterend', card);

  card.querySelectorAll('[data-wl-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      card.querySelectorAll('[data-wl-sort]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      wlSortBy = btn.dataset.wlSort;
      loadWatchlist();
    });
  });
  $('wlOnlyAtRisk')?.addEventListener('change', (e) => {
    wlOnlyAtRisk = e.target.checked;
    loadWatchlist();
  });

  return card;
}

async function loadWatchlist() {
  // The "At-Risk Student Watchlist — next semester" card has been removed from the page.
  // Kept as a no-op so the existing loadWatchlist() calls elsewhere keep working and the card is never built.
  return;
  // eslint-disable-next-line no-unreachable
  const card = _ensureWatchlistCard();
  if (!card) return;
  const id = ++seq.wl;
  skOn('watchlistCard');
  loading('wlArea');
  try {
    const d = await api('/watchlist', {
      ...scopeOf(RF), sort_by: wlSortBy, only_at_risk: wlOnlyAtRisk ? 1 : 0, top: 25,
    });
    if (id !== seq.wl) return;
    if (d.available === false) { wlData = null; return empty('wlArea', d.reason); }
    wlData = d;
    const sum = $('wlSummary');
    if (sum) sum.textContent = `${d.count_at_risk} of ${d.total_students} currently-enrolled `
      + `students flagged at risk for ${esc(d.term)} \u00b7 showing ${d.count}`;
    renderWatchlist();
  } catch (e) {
    if (id !== seq.wl) return;
    console.error(e); wlData = null; empty('wlArea', 'Could not load the student risk watchlist.');
  } finally {
    skDone('watchlistCard');
  }
}

function renderWatchlist() {
  const area = $('wlArea');
  if (!area) return;
  if (!wlData?.students?.length) { empty('wlArea', 'No students match this filter.'); return; }
  const rows = wlData.students.map(s => `
    <tr>
      <td>${esc(s.student_id)}</td>
      <td>${esc(s.college)}</td>
      <td>${esc(s.course_short || s.course)}</td>
      <td>${esc(String(s.year_level))}</td>
      <td>${s.current_gwa != null ? s.current_gwa.toFixed(2) : '\u2014'}</td>
      <td>${s.predicted_gwa_next.toFixed(2)}</td>
      <td>${s.predicted_completion_rate_next.toFixed(1)}%</td>
      <td><span class="wl-risk-pill ${s.predicted_at_risk ? 'wl-risk-high' : 'wl-risk-low'}">${Math.round(s.predicted_at_risk_proba * 100)}%</span></td>
    </tr>`).join('');
  area.innerHTML = `
    <div class="wl-table-wrap">
      <table class="wl-table">
        <thead><tr>
          <th>Student</th><th>College</th><th>Course</th><th>Yr</th>
          <th>Current GWA</th><th>Predicted GWA (next)</th><th>Predicted Completion (next)</th><th>Risk</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}


function refreshAll() { loadKpi(); loadEnrollTrend(); loadKpiTrend(); loadHardest(); loadGwa(); loadRisk(); loadWatchlist(); }

let hsModal = null;
function wire() {
  // filter popovers (the main dashboard's own widget)
  ['kpi','hs','gwa','risk','kt','et'].forEach(p => initFilterPopover({
    toggleId: p + 'FilterToggle', popoverId: p + 'FilterPopover', closeId: p + 'FilterClose', applyId: p + 'BtnApply' }));
  ['kpi','hs','gwa','risk','kt','et'].forEach(p => fillScopeSelects(p));
  ['hs','gwa','risk','kt','et'].forEach(p => horizonOptions(p));

  // Apply
  // Optional-chained throughout: a page that only ships a subset of the four
  // cards (e.g. a KPI-only prediction page) must not have missing elements
  // here abort the rest of wire() — every card wires up independently.
  $('kpiBtnApply')?.addEventListener('click', () => { KF = readScope('kpi'); loadKpi(); });
  $('hsBtnApply')?.addEventListener('click', () => {
    HSF = { ...readScope('hs'), horizon: $('hsHorizon').value, subject: $('hsSubject').value, top: $('hsTopN').value };
    loadHardest();
  });
  $('gwaBtnApply')?.addEventListener('click', () => {
    GF = { ...readScope('gwa'), horizon: $('gwaHorizon').value, history: $('gwaHistory').checked, zoom: $('gwaZoom').checked };
    loadGwa();
  });
  $('riskBtnApply')?.addEventListener('click', () => {
    RF = { ...readScope('risk'), horizon: $('riskHorizon').value, history: $('riskHistory').checked };
    loadRisk();
    loadWatchlist();   // shares RF's dept/course/year_level scope with the Risk card
  });
  $('ktBtnApply')?.addEventListener('click', () => {
    KTF = { ...readScope('kt'), horizon: $('ktHorizon').value, history: $('ktHistory').checked };
    loadKpiTrend();
  });
  $('etBtnApply')?.addEventListener('click', () => {
    ETF = { ...readScope('et'), horizon: $('etHorizon').value, history: $('etHistory').checked };
    loadEnrollTrend();
  });
  // Reset
  const maxH = String(META.horizon.chart_steps || 1);
  $('kpiBtnReset')?.addEventListener('click', () => { KF = blank(); writeScope('kpi', KF); kpiMetric = 'all'; kpiStatusMetric = 'all';
    if ($('kpiCompare')) $('kpiCompare').value = '';
    syncBtns('[data-kpi-metric]', 'kpiMetric', 'all'); syncBtns('[data-status-metric]', 'statusMetric', 'all');
    syncBtns('[data-kpi-compare]', 'kpiCompare', ''); loadKpi(); });
  $('hsBtnReset')?.addEventListener('click', () => {
    HSF = { ...blank(), horizon: maxH, subject: '', top: '10' };
    writeScope('hs', HSF); $('hsHorizon').value = maxH; $('hsSubject').value = ''; $('hsTopN').value = '10';
    hsMetric = 'avg_grade'; hsSortDir = 'desc'; $('hsSort').value = 'desc'; syncBtns('[data-hs-metric]', 'hsMetric', hsMetric); loadHardest(); });
  $('gwaBtnReset')?.addEventListener('click', () => {
    GF = { ...blank(), horizon: maxH, history: true, zoom: false };
    writeScope('gwa', GF); $('gwaHorizon').value = maxH; $('gwaHistory').checked = true; $('gwaZoom').checked = false; loadGwa(); });
  $('riskBtnReset')?.addEventListener('click', () => {
    RF = { ...blank(), horizon: maxH, history: true }; riskMetric = 'FAILED';
    writeScope('risk', RF); $('riskHorizon').value = maxH; $('riskHistory').checked = true;
    syncBtns('[data-risk-metric]', 'riskMetric', 'FAILED'); loadRisk(); loadWatchlist(); });
  $('ktBtnReset')?.addEventListener('click', () => {
    KTF = { ...blank(), horizon: maxH, history: true }; ktMetric = 'FAILED';
    writeScope('kt', KTF); $('ktHorizon').value = maxH; $('ktHistory').checked = true;
    if ($('kpiTrendCompare')) $('kpiTrendCompare').value = '';
    syncBtns('[data-kt-metric]', 'ktMetric', 'FAILED');
    syncBtns('[data-kt-compare]', 'ktCompare', '');
    loadKpiTrend(); });
  $('etBtnReset')?.addEventListener('click', () => {
    ETF = { ...blank(), horizon: maxH, history: true }; etMetric = 'all';
    writeScope('et', ETF); $('etHorizon').value = maxH; $('etHistory').checked = true;
    if ($('enrollTrendCompare')) $('enrollTrendCompare').value = '';
    syncBtns('[data-et-metric]', 'etMetric', 'all');
    syncBtns('[data-et-compare]', 'etCompare', '');
    loadEnrollTrend(); });
  HSF.horizon = GF.horizon = RF.horizon = KTF.horizon = ETF.horizon = maxH;
  if ($('hsTopN')) $('hsTopN').value = HSF.top;          // the dropdown must show what the chart is really using
  if ($('gwaHistory')) $('gwaHistory').checked = true;
  if ($('riskHistory')) $('riskHistory').checked = true;
  if ($('ktHistory')) $('ktHistory').checked = true;
  if ($('etHistory')) $('etHistory').checked = true;

  // metric buttons
  const bindBtns = (sel, dsKey, set) => document.querySelectorAll(sel).forEach(b => b.addEventListener('click', () => {
    set(b.dataset[dsKey]); syncBtns(sel, dsKey, b.dataset[dsKey]);
  }));
  bindBtns('[data-kpi-metric]', 'kpiMetric', v => { kpiMetric = v; renderKpi(); });
  bindBtns('[data-status-metric]', 'statusMetric', v => { kpiStatusMetric = v; renderKpiStatus(); });
  bindBtns('[data-hs-metric]', 'hsMetric', v => { hsMetric = v; loadHardest(); });
  bindBtns('[data-risk-metric]', 'riskMetric', v => { riskMetric = v; loadRisk(); });
  bindBtns('[data-kt-metric]', 'ktMetric', v => { ktMetric = v; loadKpiTrend(); });
  bindBtns('[data-et-metric]', 'etMetric', v => { etMetric = v; loadEnrollTrend(); });
  document.querySelectorAll('[data-kpi-compare]').forEach(b => b.addEventListener('click', () => {
    const sel = $('kpiCompare'); if (!sel) return;
    sel.value = b.dataset.kpiCompare;
    document.querySelectorAll('[data-kpi-compare]').forEach(x => x.classList.toggle('active', x.dataset.kpiCompare === sel.value));
    loadKpi();
  }));
  document.querySelectorAll('[data-kt-compare]').forEach(b => b.addEventListener('click', () => {
    const sel = $('kpiTrendCompare'); if (!sel) return;
    sel.value = b.dataset.ktCompare;
    document.querySelectorAll('[data-kt-compare]').forEach(x => x.classList.toggle('active', x.dataset.ktCompare === sel.value));
    loadKpiTrend();
  }));
  document.querySelectorAll('[data-et-compare]').forEach(b => b.addEventListener('click', () => {
    const sel = $('enrollTrendCompare'); if (!sel) return;
    sel.value = b.dataset.etCompare;
    document.querySelectorAll('[data-et-compare]').forEach(x => x.classList.toggle('active', x.dataset.etCompare === sel.value));
    loadEnrollTrend();
  }));
  document.querySelectorAll('[data-hs-view]').forEach(b => b.addEventListener('click', () => {
    hsView = b.dataset.hsView;
    document.querySelectorAll('[data-hs-view]').forEach(x => x.classList.toggle('active', x === b));
    renderHardestActive();
  }));
  $('hsSort')?.addEventListener('change', e => { hsSortDir = e.target.value; renderHardestActive(); });

  // table modals
  initTableModal({ openId: 'kpiViewTable', modalId: 'kpiTableModal', closeId: 'kpiTableModalClose', onOpen: renderKpiTable });
  $('hsViewTable')?.addEventListener('click', () => { hsModalKey = null; });   // icon = every subject (runs before the modal opens)
  hsModal = initTableModal({ openId: 'hsViewTable', modalId: 'hsTableModal', closeId: 'hsTableModalClose',
    onOpen: () => renderHsTable() });
  $('hsBarArea')?.addEventListener('click', () => { if (hsData?.items?.length) { hsModalKey = null; hsModal.open(); } });
  $('hsCardsArea')?.addEventListener('click', () => { if (hsData?.items?.length) { hsModalKey = null; hsModal.open(); } });
  const gwaModal = initTableModal({ openId: 'gwaViewTable', modalId: 'gwaTableModal', closeId: 'gwaTableModalClose',
    onOpen: () => gwaData && renderLineTable('gwa', gwaData, 'GWA Trend', v => Number(v).toFixed(2)) });
  const riskModal = initTableModal({ openId: 'riskViewTable', modalId: 'riskTableModal', closeId: 'riskTableModalClose',
    onOpen: () => riskData && renderLineTable('risk', riskData, 'At-Risk Forecast', v => fmt(Math.round(v))) });
  $('gwaArea')?.addEventListener('click', () => { if (gwaData) gwaModal.open(); });
  $('riskArea')?.addEventListener('click', () => { if (riskData) riskModal.open(); });
  const ktModal = initTableModal({ openId: 'ktViewTable', modalId: 'ktTableModal', closeId: 'ktTableModalClose',
    onOpen: () => ktData && renderLineTable('kt', ktData, 'Status Trend', v => fmt(Math.round(v))) });
  $('kpiTrendArea')?.addEventListener('click', () => { if (ktData) ktModal.open(); });
  const etModal = initTableModal({ openId: 'etViewTable', modalId: 'etTableModal', closeId: 'etTableModalClose',
    onOpen: () => etData && renderLineTable('et', etData, 'Enrollment Trend', v => fmt(Math.round(v))) });
  $('enrollTrendArea')?.addEventListener('click', () => { if (etData) etModal.open(); });
  ['kpi','hs','gwa','risk','kt','et'].forEach(p => $(p + 'TableDownloadCsv')?.addEventListener('click', () => {
    const c = tableCtx[p]; if (c && c.rows.length) downloadCsv(c.rows, c.headers, c.name);
  }));

  /* Download PDF is handled by pdf-export.js */

  // Chart text is drawn on the canvas, so re-draw when a card changes width / goes fullscreen.
  [['hardestCard', () => hsData && renderHardestActive()], ['gwaCard', () => gwaData && renderGwa()],
   ['riskCard', () => riskData && renderRisk()]].forEach(([cid, fn]) => {
    const card = $(cid);
    if (!card || typeof ResizeObserver === 'undefined') return;
    const keyOf = () => card.clientWidth + '|' + card.classList.contains('is-fullscreen');
    let last = keyOf(), timer = null;
    new ResizeObserver(() => {
      if (keyOf() === last) return;
      clearTimeout(timer);
      timer = setTimeout(() => { last = keyOf(); fn(); }, 150);
    }).observe(card);
  });
}
function syncBtns(sel, dsKey, val) {
  document.querySelectorAll(sel).forEach(b => b.classList.toggle('active', b.dataset[dsKey] === val));
}

/* -- Phones: each chart's description sits behind a dropdown (styles: responsive.css) --
   Desktop is untouched: the button is display:none and the description stays visible. */
(function initExplainerToggles() {
  const CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.22 8.22a.75.75 0 0 1 1.06 0L10 11.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 9.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>';
  document.querySelectorAll('.kpi-explainer').forEach((box, i) => {
    if (box.previousElementSibling && box.previousElementSibling.classList.contains('explainer-toggle')) return;
    if (!box.id) box.id = 'explainer-' + i;
    const isKpi = !!box.closest('#kpiCard');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'explainer-toggle';
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-controls', box.id);
    btn.innerHTML = '<span>' + (isKpi ? 'About these numbers' : 'About this chart') + '</span>' + CHEVRON;
    btn.addEventListener('click', () => {
      const open = box.classList.toggle('is-open');
      btn.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', String(open));
    });
    box.parentNode.insertBefore(btn, box);
  });
})();

async function initDashboard() {
  let meta = null;
  try { meta = await api('/meta'); } catch (e) { console.error(e); meta = { available: false, reason: 'Could not reach the prediction service.' }; }
  if (!meta || meta.available === false) return unavailable(meta);
  META = meta;
  setBanner(meta);
  wire();
  refreshAll();
}


/* -- Fullscreen card toggle (same as the main dashboard) ----------------- */
(function initFullscreenToggles() {
  const EXPAND_PATH = 'm13.28 7.78 3.22-3.22v2.69a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.69l-3.22 3.22a.75.75 0 0 0 1.06 1.06ZM2 17.25v-4.5a.75.75 0 0 1 1.5 0v2.69l3.22-3.22a.75.75 0 0 1 1.06 1.06L4.56 16.5h2.69a.75.75 0 0 1 0 1.5h-4.5a.747.747 0 0 1-.75-.75ZM12.22 13.28l3.22 3.22h-2.69a.75.75 0 0 0 0 1.5h4.5a.747.747 0 0 0 .75-.75v-4.5a.75.75 0 0 0-1.5 0v2.69l-3.22-3.22a.75.75 0 1 0-1.06 1.06ZM3.5 4.56l3.22 3.22a.75.75 0 0 0 1.06-1.06L4.56 3.5h2.69a.75.75 0 0 0 0-1.5h-4.5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0V4.56Z';
  const COMPRESS_PATH = 'M3.28 2.22a.75.75 0 0 0-1.06 1.06L5.44 6.5H2.75a.75.75 0 0 0 0 1.5h4.5A.75.75 0 0 0 8 7.25v-4.5a.75.75 0 0 0-1.5 0v2.69L3.28 2.22Zm10.22.53a.75.75 0 0 0-1.5 0v4.5c0 .414.336.75.75.75h4.5a.75.75 0 0 0 0-1.5h-2.69l3.22-3.22a.75.75 0 0 0-1.06-1.06L13.5 5.44V2.75ZM3.28 17.78l3.22-3.22v2.69a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.69l-3.22 3.22a.75.75 0 1 0 1.06 1.06Zm10.22-3.22 3.22 3.22a.75.75 0 1 0 1.06-1.06l-3.22-3.22h2.69a.75.75 0 0 0 0-1.5h-4.5a.75.75 0 0 0-.75.75v4.5a.75.75 0 0 0 1.5 0v-2.69Z';

  let backdrop = null;
  let activeCard = null;

  // Known font-size paths per canvas (chart.js options don't scale with CSS,
  // so bump them by hand when a card goes fullscreen and put them back after).
  const CHART_FONT_PATHS = {};   // charts size their own fonts at render time (re-drawn on resize)
  const FULLSCREEN_FONT_SCALE = 1.35;
  const _origFontSizes = {};

  function scaleChartFonts(card, factor) {
    qsa('canvas', card).forEach(canvasEl => {
      const chart = _charts[canvasEl.id];
      const paths = CHART_FONT_PATHS[canvasEl.id];
      if (!chart || !paths) return;
      paths.forEach((getFont, i) => {
        const fontObj = getFont(chart);
        if (!fontObj) return;
        const key = canvasEl.id + '#' + i;
        if (!(key in _origFontSizes)) _origFontSizes[key] = fontObj.size || 11;
        fontObj.size = Math.round(_origFontSizes[key] * factor);
      });
      chart.update('none');
    });
  }

  function resizeChartsIn(card) {
    // Nudge any Chart.js instances inside this card to relayout at their new size.
    qsa('canvas', card).forEach(c => { _charts[c.id]?.resize(); });
  }

  function collapse() {
    if (!activeCard) return;
    const btn = activeCard.querySelector('.btn-fullscreen');
    activeCard.classList.remove('is-fullscreen');
    if (btn) { btn.querySelector('path').setAttribute('d', EXPAND_PATH); btn.title = 'Expand'; }
    backdrop?.remove();
    backdrop = null;
    document.body.classList.remove('fullscreen-lock');
    const card = activeCard;
    activeCard = null;
    scaleChartFonts(card, 1);
    requestAnimationFrame(() => resizeChartsIn(card));
  }

  function expand(card, btn) {
    if (activeCard && activeCard !== card) collapse();
    card.classList.add('is-fullscreen');
    btn.querySelector('path').setAttribute('d', COMPRESS_PATH);
    btn.title = 'Collapse';
    backdrop = document.createElement('div');
    backdrop.className = 'fullscreen-backdrop';
    backdrop.addEventListener('click', collapse);
    document.body.appendChild(backdrop);
    document.body.classList.add('fullscreen-lock');
    activeCard = card;
    scaleChartFonts(card, FULLSCREEN_FONT_SCALE);
    requestAnimationFrame(() => resizeChartsIn(card));
  }

  qsa('.btn-fullscreen').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = $(btn.dataset.fullscreenTarget);
      if (!card) return;
      card.classList.contains('is-fullscreen') ? collapse() : expand(card, btn);
    });
  });

  document.addEventListener('keydown', e => { if (e.key === 'Escape' && activeCard) collapse(); });
})();

/* -- Global comparison: pushes one value into every chart's Comparison select -- */
document.addEventListener('click', e => {
  const b = e.target.closest && e.target.closest('#globalBtnApply, #globalBtnReset');
  if (!b) return;
  const g = document.getElementById('globalCompare');
  const v = b.id === 'globalBtnReset' ? '' : (g ? g.value : '');
  if (b.id === 'globalBtnReset' && g) g.value = '';
  ['kpi','hs','gwa','risk','kpiTrend','enrollTrend'].forEach(p => { const el = document.getElementById(p + 'Compare'); if (el) el.value = v; });
  document.querySelectorAll('[data-kt-compare]').forEach(x => x.classList.toggle('active', x.dataset.ktCompare === v));
  document.querySelectorAll('[data-et-compare]').forEach(x => x.classList.toggle('active', x.dataset.etCompare === v));
  setTimeout(() => { loadKpi(); loadHardest(); loadGwa(); loadRisk(); loadKpiTrend(); loadEnrollTrend(); loadWatchlist(); }, 60);
}, true);

/* -- data handed to the Insights modal (it lives outside this closure) ---- */
window.PD = {
  kpi: () => kpiData, hs: () => hsData, gwa: () => gwaData, risk: () => riskData, kpiTrend: () => ktData, enrollTrend: () => etData,
  riskLabel: () => STATUS_LABEL[riskMetric] || riskMetric,
  scope: id => scopeText({ kpiCard: KF, hardestCard: HSF, gwaCard: GF, riskCard: RF, kpiTrendCard: KTF, enrollTrendCard: ETF }[id] || KF),
  sc: shortCourse,
  filters: id => {
    const asof = META?.horizon?.last_t ?? '';
    const cmp = { kpiCard:'kpi', hardestCard:'hs', gwaCard:'gwa', riskCard:'risk', kpiTrendCard:'kpiTrend', enrollTrendCard:'enrollTrend' }[id];
    const c = cmp ? (document.getElementById(cmp + 'Compare')?.value || '') : '';
    const base = { kpiCard: KF, hardestCard: { ...HSF, metric: hsMetric }, gwaCard: GF, riskCard: { ...RF, metric: riskMetric }, kpiTrendCard: { ...KTF, metric: ktMetric }, enrollTrendCard: { ...ETF, metric: etMetric } }[id] || {};
    const o = { ...base, compare: c, asof };
    delete o.zoom;
    return o;
  },
};

/* -- INIT --------------------------------------------------------------- */
document.addEventListener('DOMContentLoaded', initDashboard);

})();

/* ==========================================================================
   DOWNLOAD CHART AS PNG \u2014 prediction dashboard
   ========================================================================== */
(function () {
  const DL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style="width:15px">
    <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z"/>
    <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z"/>
  </svg>`;

  const CARD_CANVAS = { kpiTrendCard:['kpiTrendChart'], enrollTrendCard:['enrollTrendChart'], gwaCard:['gwaTrendChart'], riskCard:['atRiskChart'], hardestCard:['hsBarCanvas','hsTrendCanvas'] };
  const CARD_TITLES = { kpiCard:'KPI Forecast', kpiTrendCard:'Status Trend Forecast', enrollTrendCard:'Enrollment Trend Forecast', gwaCard:'GWA Trend Forecast', riskCard:'At-Risk Forecast', hardestCard:'Hardest Subjects', watchlistCard:'At-Risk Student Watchlist' };
  // watchlistCard has no entry in CARD_CANVAS on purpose — it's a table, not a Chart.js canvas, so the
  // PNG-download flow (which iterates CARD_CANVAS[cardId]) correctly has nothing to export for it.

  // Confirmation modal
  const confirmModal = document.createElement('div');
  confirmModal.id = 'dlConfirmModal';
  confirmModal.className = 'dl-confirm-modal hidden';
  confirmModal.innerHTML = `
    <div class="dl-confirm-card">
      <div class="dl-confirm-icon">${DL_SVG.replace('style="width:15px"','style="width:28px;color:#7B1113"')}</div>
      <div class="dl-confirm-body">
        <h4 class="dl-confirm-title">Download Chart Image</h4>
        <p class="dl-confirm-sub" id="dlConfirmSub">Save this chart as a PNG image file?</p>
        <p class="dl-confirm-note">The image will include the chart with a white background, ready to insert into reports or presentations.</p>
      </div>
      <div class="dl-confirm-actions">
        <button class="dl-btn-cancel" id="dlConfirmCancel">Cancel</button>
        <button class="dl-btn-confirm" id="dlConfirmOk">${DL_SVG.replace('style="width:15px"','style="width:14px"')} Download PNG</button>
      </div>
    </div>`;
  document.body.appendChild(confirmModal);

  let _pending = null;
  document.getElementById('dlConfirmCancel').addEventListener('click', () => { confirmModal.classList.add('hidden'); _pending=null; });
  confirmModal.addEventListener('click', e => { if(e.target===confirmModal){confirmModal.classList.add('hidden');_pending=null;} });
  document.getElementById('dlConfirmOk').addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    if (_pending) { _doDownload(_pending); _pending=null; }
  });

  function _h2c() {
    return window.html2canvas ? Promise.resolve(window.html2canvas) : new Promise((ok, no) => {
      const sc = document.createElement('script');
      sc.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      sc.onload = () => ok(window.html2canvas); sc.onerror = () => no(new Error('html2canvas failed to load'));
      document.head.appendChild(sc);
    });
  }
  function _doKpi(fname) {
    const card = document.getElementById('kpiCard');
    _h2c().then(h => h(card, { backgroundColor: '#ffffff', scale: 2, useCORS: true,
      ignoreElements: el => el.classList && (el.classList.contains('kpi-header-actions') || el.classList.contains('kpi-filter-popover')) }))
      .then(c => _save(c, fname))
      .catch(() => {
        const sub = document.getElementById('dlConfirmSub');
        if (sub) sub.textContent = 'Could not create the KPI image. Check your connection and try again.';
        confirmModal.classList.remove('hidden');
      });
  }

  function _doDownload(cardId) {
    const title = CARD_TITLES[cardId]||cardId;
    const fname = 'novasight_'+title.toLowerCase().replace(/[^a-z0-9]+/g,'_');
    if (cardId === 'kpiCard') { _doKpi(fname); return; }
    for (const cid of (CARD_CANVAS[cardId]||[])) {
      const c = document.getElementById(cid);
      if (c && c.width>0) { _save(c,fname); return; }
    }
    const fallback = document.querySelector('#'+cardId+' .chart-area canvas');
    if (fallback && fallback.width>0) { _save(fallback,fname); return; }
    const sub=document.getElementById('dlConfirmSub');
    const ok=document.getElementById('dlConfirmOk');
    if(sub) sub.textContent='No chart found. Make sure the chart has finished loading.';
    if(ok) ok.style.display='none';
    confirmModal.classList.remove('hidden');
    setTimeout(()=>{ if(ok) ok.style.display=''; if(sub) sub.textContent='Save this chart as a PNG image file?'; },4000);
  }

  function _save(canvas, fname) {
    const off=document.createElement('canvas');
    off.width=canvas.width; off.height=canvas.height;
    const ctx=off.getContext('2d');
    ctx.fillStyle='#ffffff'; ctx.fillRect(0,0,off.width,off.height); ctx.drawImage(canvas,0,0);
    const a=document.createElement('a'); a.href=off.toDataURL('image/png'); a.download=fname+'.png'; a.click();
  }

  ['kpiCard','enrollTrendCard','kpiTrendCard','gwaCard','riskCard','hardestCard'].forEach(cardId => {
    const card=document.getElementById(cardId); if(!card) return;
    const actions=card.querySelector('.kpi-header-actions'); if(!actions) return;
    const btn=document.createElement('button');
    btn.className='btn-icon btn-download-chart';
    btn.title='Download chart as PNG'; btn.setAttribute('aria-label','Download chart as PNG');
    btn.innerHTML=DL_SVG;
    btn.addEventListener('click',()=>{
      _pending=cardId;
      const sub=document.getElementById('dlConfirmSub');
      if(sub) sub.textContent=`Save "${CARD_TITLES[cardId]||cardId}" as a PNG image?`;
      const ok=document.getElementById('dlConfirmOk'); if(ok) ok.style.display='';
      confirmModal.classList.remove('hidden');
    });
    const fsBtn=actions.querySelector('.btn-fullscreen');
    if(fsBtn) actions.insertBefore(btn,fsBtn); else actions.appendChild(btn);
  });
})();

/* ==========================================================================
   GENERATE CHART INSIGHTS - same floating, editable, shared modal as the main dashboard
   (saved through /api/dash/insights with dashboard = 'pred')
   ========================================================================== */
document.addEventListener('DOMContentLoaded', function () {
  const _$ = id => document.getElementById(id);
  const modal = _$('aiInsightsModal');
  if (!modal) return;
  const titleEl = _$('aiInsightsTitle'), ctxEl = _$('aiInsightsContext'), loadEl = _$('aiInsightsLoading'),
        textArea = _$('aiInsightsTextarea'), badge = _$('aiInsightsSaveBadge'), metaEl = _$('aiInsightsMeta'),
        saveBtn = _$('aiInsightsSave'), regenBtn = _$('aiInsightsRegen');
  const DASH = 'pred';
  let _card = null, _dirty = false, _savedText = '';
  const filtersOf = id => PD.filters(id);

  const AI_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px"><path fill-rule="evenodd" d="M9 4.5a.75.75 0 0 1 .721.544l.813 2.846a3.75 3.75 0 0 0 2.576 2.576l2.846.813a.75.75 0 0 1 0 1.442l-2.846.813a3.75 3.75 0 0 0-2.576 2.576l-.813 2.846a.75.75 0 0 1-1.442 0l-.813-2.846a3.75 3.75 0 0 0-2.576-2.576l-2.846-.813a.75.75 0 0 1 0-1.442l2.846-.813A3.75 3.75 0 0 0 7.466 7.89l.813-2.846A.75.75 0 0 1 9 4.5ZM18 1.5a.75.75 0 0 1 .728.568l.258 1.036c.236.94.97 1.674 1.91 1.91l1.036.258a.75.75 0 0 1 0 1.456l-1.036.258c-.94.236-1.674.97-1.91 1.91l-.258 1.036a.75.75 0 0 1-1.456 0l-.258-1.036a2.625 2.625 0 0 0-1.91-1.91l-1.036-.258a.75.75 0 0 1 0-1.456l1.036-.258a2.625 2.625 0 0 0 1.91-1.91l.258-1.036A.75.75 0 0 1 18 1.5ZM16.5 15a.75.75 0 0 1 .712.513l.394 1.183c.15.447.5.799.948.948l1.183.395a.75.75 0 0 1 0 1.422l-1.183.395c-.447.15-.799.5-.948.948l-.395 1.183a.75.75 0 0 1-1.422 0l-.395-1.183a1.5 1.5 0 0 0-.948-.948l-1.183-.395a.75.75 0 0 1 0-1.422l1.183-.395c.447-.15.799-.5.948-.948l.395-1.183A.75.75 0 0 1 16.5 15Z" clip-rule="evenodd"/></svg>';
  ['kpiCard','kpiTrendCard','enrollTrendCard','hardestCard','gwaCard','riskCard'].forEach(id => {
    const actions = document.querySelector('#' + id + ' .kpi-header-actions');
    if (!actions || actions.querySelector('[data-ai-card]')) return;
    const b = document.createElement('button');
    b.className = 'btn-icon btn-ai-insights'; b.dataset.aiCard = id; b.title = 'Generate Chart Insights';
    b.setAttribute('aria-label', 'Generate Chart Insights'); b.innerHTML = AI_SVG;
    const fs = actions.querySelector('.btn-fullscreen');
    fs ? actions.insertBefore(b, fs) : actions.appendChild(b);
    b.addEventListener('click', () => openModal(id));
  });

  const TITLES = { kpiCard:'KPI Forecast', kpiTrendCard:'Status Trend Forecast', enrollTrendCard:'Enrollment Trend Forecast', hardestCard:'Subjects Requiring Intervention', gwaCard:'GWA Trend Forecast', riskCard:'At-Risk Forecast' };
  const PLACEHOLDER = {
    kpiCard: 'Add your insights about the KPI forecast here. What do the predicted enrollment, GWA and at-risk numbers imply for next semester?',
    kpiTrendCard: 'Add your insights about the status trend forecast here. Which colleges or programs are predicted to see this status rise or fall?',
    enrollTrendCard: 'Add your insights about the enrollment trend forecast here. Is total enrollment predicted to grow or shrink, and how might the regular/irregular mix shift?',
    hardestCard: 'Add your insights about the predicted hardest subjects here. Which subjects need support first?',
    gwaCard: 'Add your insights about the GWA forecast here. Which colleges or courses are improving or worsening?',
    riskCard: 'Add your insights about the at-risk forecast here. Where should support be planned first?',
  };

  function setDirty(v) { _dirty = v; if (!saveBtn) return; saveBtn.classList.toggle('ai-save-btn-dirty', v); saveBtn.disabled = !v; saveBtn.title = v ? 'Save changes' : 'No unsaved changes'; }
  function setBadge(cls, txt) { if (!badge) return; badge.textContent = txt; badge.className = 'ai-save-badge' + (cls ? ' ' + cls : ''); }
  const subOf = id => document.querySelector('#' + id + ' .card-subtitle')?.textContent || '';

  /* No AI call anymore, so hide the "Generating insights…" indicator wherever the template puts it. */
  function hideSpinner() {
    if (loadEl) { loadEl.classList.remove('active'); loadEl.style.display = 'none'; }
    modal.querySelectorAll('*').forEach(el => {
      if (el === textArea || textArea.contains(el) || el.contains(textArea)) return;
      if (/^\s*generating insights/i.test(el.textContent || '') && (el.textContent || '').length < 60) {
        let t = el; while (t.parentElement && t.parentElement !== modal && (t.parentElement.textContent || '').trim() === (el.textContent || '').trim()) t = t.parentElement;
        t.style.display = 'none';
      }
    });
  }
  hideSpinner();
  async function loadInsight(id) {
    try { const r = await fetch('/api/dash/insights?chart_key=' + id + '&dashboard=' + DASH + '&filters=' + encodeURIComponent(JSON.stringify(filtersOf(id)))); if (!r.ok) return null; const d = await r.json(); return d.found ? d : null; }
    catch { return null; }
  }
  async function doSave() {
    const text = textArea?.innerText?.trim() || '';
    if (!text || !_card) return;
    setBadge('unsaved', 'Saving\u2026');
    try {
      const r = await fetch('/api/dash/insights', { method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ chart_key: _card, dashboard: DASH, insight_text: text, filter_label: subOf(_card), filters: filtersOf(_card) }) });
      const d = await r.json();
      if (d.saved) { _savedText = text; setBadge('saved', 'Saved \u2014 visible to all users'); setDirty(false); if (metaEl) metaEl.textContent = 'Just saved by you'; }
      else setBadge('error', 'Save failed' + (d.reason ? ': ' + d.reason : ''));
    } catch (e) { setBadge('error', 'Save failed: ' + (e?.message || 'network error')); }
  }
  async function openModal(id) {
    _card = id; _savedText = ''; setDirty(false);
    if (titleEl) { const svg = titleEl.querySelector('svg'); titleEl.textContent = ' Generate Chart Insights \u2014 ' + (TITLES[id] || id); if (svg) titleEl.prepend(svg); }
    if (ctxEl) ctxEl.textContent = subOf(id);
    if (metaEl) metaEl.textContent = '';
    setBadge('', '');
    textArea.textContent = ''; textArea.contentEditable = 'true';
    modal.classList.remove('hidden');
    try { hideSpinner(); } catch (e) {}
    const saved = await loadInsight(id);
    if (saved?.insight_text) {
      _savedText = saved.insight_text; textArea.innerText = saved.insight_text;
      setBadge('saved', 'Saved \u2014 visible to all users');
      if (saved.legacy) { _savedText = ''; setDirty(true); setBadge('unsaved', 'Earlier general insight - click Save to keep it for these filters'); }
      if (metaEl && saved.updated_at) metaEl.textContent = 'Last updated ' + new Date(saved.updated_at).toLocaleDateString('en-PH', {month:'short', day:'numeric', year:'numeric'}) + (saved.updated_by ? ' by ' + saved.updated_by : '');
    } else { textArea.setAttribute('data-placeholder', PLACEHOLDER[id] || 'Type your insight here\u2026'); regenBtn?.click(); }
  }
  textArea?.addEventListener('input', () => {
    const differs = (textArea.innerText?.trim() || '') !== _savedText;
    if (differs !== _dirty) setDirty(differs);
    if (!differs) setBadge(_savedText ? 'saved' : '', _savedText ? 'Saved \u2014 visible to all users' : '');
    else setBadge('unsaved', 'Unsaved \u2014 click Save to share');
  });
  saveBtn?.addEventListener('click', () => { if (_dirty) doSave(); });

  const INST = 'Bataan Peninsula State University (BPSU) Main Campus';
  const SCALE = 'GWA uses the Philippine 1.00\u20135.00 scale \u2014 1.00 is best, 5.00 is failing.';
  function lines(d, f) { return d.datasets.slice(0, 6).map(x => { const v = x.data.filter(n => n != null); return '  ' + PD.sc(x.label) + ': ' + f(v[v.length - 1]); }).join('\n'); }
  function buildPrompt(id) {
    const ctx = 'Filters: ' + PD.scope(id) + '\n';
    const head = 'You are an academic analytics assistant for ' + INST + '. ' + SCALE + '\n' + ctx;
    const tail = '\nProvide 3\u20135 concise numbered insights and recommended actions for administrators.';
    if (id === 'kpiCard') {
      const d = PD.kpi(); if (!d || d.empty || !d.enrollment) return null;
      const e = d.enrollment, st = d.statuses || {};
      const sl = Object.keys(st).map(k => '  ' + k + ': ' + st[k].count + ' (last recorded ' + (st[k].prev_count ?? 'n/a') + ')').join('\n');
      return head + 'KPI forecast for ' + d.term.label + ' vs last recorded ' + d.prev_term.label + ':\n  Enrollment ' + e.all.value + ' (was ' + (e.all.prev ?? 'n/a') + '); regular ' + e.regular.value + ', irregular ' + e.irregular.value + '\n  GWA ' + (d.gwa.value ?? 'n/a') + ' (was ' + (d.gwa.prev ?? 'n/a') + ')\n  Completion ' + (d.completion.value ?? 'n/a') + '% (was ' + (d.completion.prev ?? 'n/a') + '%)\n' + sl + tail;
    }
    if (id === 'kpiTrendCard') { const d = PD.kpiTrend(); if (!d?.datasets?.length) return null; return head + `Predicted ${STATUS_LABEL[ktMetric] || ktMetric} status, by ${d.group_by} (latest forecast point):\n` + lines(d, v => Math.round(v ?? 0) + ' students') + tail; }
    if (id === 'enrollTrendCard') { const d = PD.enrollTrend(); if (!d?.datasets?.length) return null; return head + `Predicted ${ENROLL_METRIC_LABEL[etMetric] || etMetric} enrollment, by ${d.group_by} (latest forecast point):\n` + lines(d, v => Math.round(v ?? 0) + ' students') + tail; }
    if (id === 'gwaCard') { const d = PD.gwa(); if (!d?.datasets?.length) return null; return head + 'Predicted average GWA per ' + d.group_by + ' (latest forecast point):\n' + lines(d, v => v == null ? 'n/a' : Number(v).toFixed(2)) + tail; }
    if (id === 'riskCard') { const d = PD.risk(); if (!d?.datasets?.length) return null; return head + 'Predicted students with ' + PD.riskLabel() + ' status per ' + d.group_by + ':\n' + lines(d, v => Math.round(v ?? 0) + ' students') + tail; }
    if (id === 'hardestCard') {
      const subs = PD.hs()?.subjects || []; if (!subs.length) return null;
      return head + 'Subjects predicted to be hardest next semester:\n' + subs.slice(0, 8).map((s, i) => '  ' + (i + 1) + '. ' + (s.title || s.code) + ' (' + s.students + ' students)').join('\n') + tail;
    }
    return null;
  }
  /* TEMPORARY fallback: the AI service (/api/dash/insights/generate) is not available, so a hard-coded
     sample insight is shown instead. It says so explicitly and contains no real figures. Remove this
     block (and the applyFallback() calls) once the AI endpoint exists. */
  const FALLBACK_INSIGHT = {
    kpiCard: [
      "1. Compare the forecast enrollment, GWA and at-risk figures with the last recorded semester to see the direction of change.",
      "2. A forecast at-risk count that rises faster than enrollment suggests more students will need support next term.",
      "3. Suggested action: use these projections for early planning of advising capacity and subject sections, and re-check once actual data is uploaded."
    ].join("\n"),
    kpiTrendCard: [
      "1. Focus on groups whose forecast line moves against the overall direction; they are the likeliest to need attention.",
      "2. Forecasts get less certain further out, so give more weight to the next semester than to later points.",
      "3. Suggested action: flag the groups with rising projections to their deans now, while there is time to prepare."
    ].join("\n"),
    enrollTrendCard: [
      "1. Compare the projected direction of total enrollment with the regular/irregular mix to see where change is expected.",
      "2. A projected rise in irregular students can signal more back subjects and larger classes in required courses.",
      "3. Suggested action: use the projection when planning sections and faculty load, and revisit it when new actuals arrive."
    ].join("\n"),
    hardestCard: [
      "1. The subjects at the top are projected to have the most failures next semester, so they are the first candidates for support.",
      "2. Check the change against the last recorded offering; subjects getting harder deserve earlier action than stable ones.",
      "3. Suggested action: prepare tutoring or review sessions for the top subjects before the term starts."
    ].join("\n"),
    gwaCard: [
      "1. Remember that on the Philippine scale a lower GWA is better, so a rising line means performance is projected to worsen.",
      "2. Compare groups against each other; the ones moving toward 3.00 or higher are the ones to look at first.",
      "3. Suggested action: arrange advising or academic support for projected decliners before the term begins."
    ].join("\n"),
    riskCard: [
      "1. The groups with the highest projected at-risk counts are where support should be planned first.",
      "2. Compare the projection with the last recorded semester to see whether risk is expected to grow or ease.",
      "3. Suggested action: line up advising, tutoring and early-warning checks for these groups ahead of the term."
    ].join("\n"),
    _default: [
      "1. Compare the highest and lowest projected values to see where attention is needed first.",
      "2. Treat later forecast points with caution; they are less certain than the next semester.",
      "3. Suggested action: share the main projection with the relevant deans and plan around it."
    ].join("\n"),
  };
  /* Rule-based insight written from the forecast data the chart already loaded from Python
     (insight-engine.js). Used instead of the AI service, which isn't available. */
  function applyEngine() {
    const txt = window.InsightEngine && window.InsightEngine.generate(_card, 'pred');
    if (!txt) return false;
    textArea.innerText = txt;
    setDirty(true);
    setBadge('unsaved', 'Auto-generated from the current forecast data (rule-based, no AI). Review, edit, then click Save.');
    return true;
  }
  function applyFallback(prompt) {
    const m = /Filters:\s*([^\n]+)/.exec(prompt || '');
    const body = FALLBACK_INSIGHT[_card] || FALLBACK_INSIGHT._default;
    textArea.innerText =
      'Temporary sample insight \u2014 the AI service is not connected yet, so this is placeholder text, not an analysis of your data.' +
      (m ? '\nScope: ' + m[1].trim() : '') + '\n\n' + body;
    setDirty(true);
    setBadge('unsaved', 'Temporary placeholder \u2014 AI service unavailable. Edit it, then click Save.');
  }
  regenBtn?.addEventListener('click', async () => {
    if (!_card) return;
    if (applyEngine()) return;   // real numbers from the loaded chart; skips the unavailable AI call
    const prompt = buildPrompt(_card);
    if (!prompt) { setBadge('error', 'Load the chart data first, then regenerate.'); return; }
    loadEl?.classList.add('active'); textArea.contentEditable = 'false'; regenBtn.disabled = true;
    try {
      const res = await fetch('/api/dash/insights/generate', { method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type':'application/json'}, body: JSON.stringify({ prompt }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.text || '').trim();
      if (text) { textArea.innerText = text; setDirty(true); setBadge('unsaved', 'AI draft \u2014 review and edit, then click Save to share'); }
      else applyFallback(prompt);   // empty response
    } catch (e) { console.warn('[insights] AI unavailable, using temporary fallback:', e.message); applyFallback(prompt); }
    finally { loadEl?.classList.remove('active'); textArea.contentEditable = 'true'; regenBtn.disabled = false; }
  });

  _$('aiInsightsDownloadWord')?.addEventListener('click', () => {
    const title = TITLES[_card] || _card || '', sub = ctxEl?.textContent || '', text = textArea?.innerText || '';
    let img = '';
    if (_$('aiInsightsIncludeChart')?.checked) {
      const c = document.querySelector('#' + _card + ' .chart-area:not(.hidden) canvas');
      if (c && c.width) { const o = document.createElement('canvas'); o.width = c.width; o.height = c.height; const x = o.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, o.width, o.height); x.drawImage(c, 0, 0); img = '<img src="' + o.toDataURL('image/png') + '" style="max-width:100%;margin:12px 0;" alt="' + title + '">'; }
    }
    const doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Calibri,Arial,sans-serif;margin:2cm;color:#1f2937;line-height:1.7}h1{font-size:17pt;color:#7B1113;margin-bottom:2px}p.sub{font-size:10pt;color:#6b7280;margin:0 0 14px}hr{border:none;border-top:1px solid #e5e7eb;margin:14px 0}pre{font-family:inherit;font-size:11pt;white-space:pre-wrap;margin:0}footer{font-size:8pt;color:#9ca3af;margin-top:28px}</style></head><body><h1>' + title + '</h1><p class="sub">' + sub + '</p><hr>' + img + '<pre>' + text.replace(/</g, '&lt;') + '</pre><hr><footer>NovaSight Prediction Analysis &middot; Bataan Peninsula State University<br>Forecasts are for planning only.</footer></body></html>';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['\ufeff' + doc], { type: 'application/msword' }));
    a.download = 'novasight_insight_' + title.toLowerCase().replace(/[^a-z0-9]+/g, '_') + '.doc';
    a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  function closeModal() {
    if (_dirty) { if (_savedText) textArea.innerText = _savedText; else textArea.textContent = ''; setDirty(false); setBadge(_savedText ? 'saved' : '', _savedText ? 'Saved \u2014 visible to all users' : ''); }
    modal.classList.add('hidden');
  }
  _$('aiInsightsClose')?.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
});