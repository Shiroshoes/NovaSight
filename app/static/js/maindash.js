/* maindash.js — Main Dashboard (Historical Only, v2)
 * Charts: KPI, Heatmap, Gender Pie, Hardest Subjects
 * Each chart has its own filter state. No global filter bar.
 */
(function () {
'use strict';

/* ── College & status colors ─────────────────────────────────────────────── */
const STATUS_COLORS = {
  FAILED:'#dc2626', DRP:'#7c3aed', INC:'#d97706',
  UDR:'#0284c7', W:'#059669', NGA:'#9ca3af', CONTINUING:'#16a34a',
};

/* ── DOM helpers ─────────────────────────────────────────────────────────── */
const $   = id => document.getElementById(id);
const qsa = (sel, root=document) => [...root.querySelectorAll(sel)];

/* ── Shared-helper bridge for maindash-registrar.js ──────────────────────────
   That file is a separate <script> (Registrar-only code lives there instead
   of in this shared file, which every role loads). It needs these utilities;
   function hoisting makes it safe to list them here even though most are
   defined further down. */
Object.assign(window, {
  $, skOn, skOff, skDone, loading, empty, makeChart, _perfColor,
  initFilterPopover, fillSelect, _fillCourses, downloadCsv, initTableModal,
  loadKpi, loadPerformance,
});

/* ── Skeleton loading (styles live in skeleton.css) ─────────────────────────
   A card shows placeholders while .is-loading is set. Each request holds it
   (skOn) and releases it (skDone) when it finishes; every card is also held
   once at start so nothing flashes "—" before the first response arrives. */
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
  if (_skInit[id]) { _skInit[id] = 0; skOff(id); }
}
const SK_CARDS = ['kpiCard', 'enrollTrendCard', 'kpiTrendCard', 'heatmapCard', 'perfCard', 'genderCard', 'hardestCard'];
SK_CARDS.forEach(id => { skOn(id); _skInit[id] = 1; });
setTimeout(() => SK_CARDS.forEach(id => { if (_skInit[id]) { _skInit[id] = 0; skOff(id); } }), 25000);

/* phones: smaller chart text and shorter labels */
const isNarrow = () => window.matchMedia('(max-width: 640px)').matches;

function loading(id) {
  const el = $(id);
  if (el) el.innerHTML = `<div class="chart-loading"><div class="chart-spinner"></div><span>Loading…</span></div>`;
}
function empty(id, msg='No data for the selected filters.') {
  const el = $(id);
  if (el) el.innerHTML = `<div class="chart-empty">${msg}</div>`;
}

/* ── Download helpers ────────────────────────────────────────────────────── */
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

/* ── Delta badge ─────────────────────────────────────────────────────────── */
function deltaHtml(val, unit='', invertGood=false) {
  if (val == null || isNaN(val) || val === 0) return '';
  const up  = val > 0;
  const cls = (up ? !invertGood : invertGood) ? 'up' : 'down';
  return `<span class="kpi-delta ${cls}">${up?'↑':'↓'}${Math.abs(val).toFixed(2)}${unit}</span>`;
}

/* White pill badge for numbers sitting on the dark red Total Enrollment
   card — plain colored text was unreadable directly on that background.
   up=true -> green (enrollment grew, good), false -> red, null -> neutral gray. */
function enrollPill(text, up, fontSize=14) {
  const color = up === null ? '#4b5563' : (up ? (CB.on ? '#005a8e' : '#15803d') : (CB.on ? '#a84a00' : '#b91c1c'));
  return `<span style="display:inline-block;background:#fff;color:${color};`+
         `border-radius:999px;padding:2px 10px;font-size:${fontSize}px;font-weight:700;">`+
         `${text}</span>`;
}

/* ── Chart.js instance manager ───────────────────────────────────────────── */
const _charts = {};
function makeChart(id, config) {
  if (_charts[id]) _charts[id].destroy();
  const el = $(id);
  if (!el) return null;
  _charts[id] = new Chart(el, config);
  return _charts[id];
}

/* ── Populate select from list ───────────────────────────────────────────── */
function fillSelect(selId, items, labelFn = d => d, valFn = d => d) {
  const sel = $(selId);
  if (!sel) return;
  const cur = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  (items || []).forEach(d => sel.add(new Option(labelFn(d), valFn(d))));
  sel.value = cur;
}

/* ── Academic-year select: no "All Years" option — only real years, with the
   most recently uploaded one selected. ─────────────────────────────────── */
function fillYearSelect(selId, years, recent) {
  const sel = $(selId);
  if (!sel) return;
  sel.innerHTML = '';
  (years || []).forEach(y => { const yr = parseInt(y); sel.add(new Option(`${yr}-${yr+1}`, y)); });
  const list = (years || []).map(String);
  if (recent && list.includes(String(recent))) sel.value = String(recent);
  else if (list.length) sel.value = list[list.length - 1];
}

/* ── Sortable / searchable / filterable / paginated HTML table ──────────────
   Backward compatible with the old buildTable(id, rows, headers, sort, dir)
   calls — pass an extra `opts` object to turn on the extra features:
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
  const uniqueValues  = h => [...new Set(rows.map(r => String(r[h] ?? '—')))]
    .sort((a,b) => a.localeCompare(b, undefined, {numeric:true}));

  function filtered() {
    return rows.filter(r => {
      if (searchTerm) {
        const hay = headers.map(h => String(r[h] ?? '')).join(' ').toLowerCase();
        if (!hay.includes(searchTerm)) return false;
      }
      for (const h in colFilters) {
        if (!colFilters[h].has(String(r[h] ?? '—'))) return false;
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
          ${searchable ? `<input type="text" class="dt-search" id="${containerId}_search" placeholder="Search records…" value="${searchTerm.replace(/"/g,'&quot;')}">` : ''}
        </div>
        <div class="dt-toolbar-actions">
          ${downloadable ? `<button type="button" class="btn-action" id="${containerId}_csv">Download CSV</button>
          <button type="button" class="btn-action" id="${containerId}_xls">Download Excel</button>` : ''}
          ${headers.length > 1 ? `<div class="dt-cols-wrap"><button type="button" class="btn-action" id="${containerId}_cols">Filter</button>${colsOpen ? renderColsPop() : ''}</div>` : ''}
        </div>
      </div>` : '';

    const head = hs.map(h => {
      const active   = !!colFilters[h];
      const arrow    = h === sortCol ? `<span class="sort-arrow">${sortDir==='asc'?'↑':'↓'}</span>` : '';
      const filterBt = filterable ? `<button type="button" class="dt-filter-btn${active?' active':''}" data-filter-h="${h}" title="Filter ${h}">▾</button>` : '';
      const pop      = (filterable && openFilterCol === h) ? renderFilterPop(h) : '';
      return `<th><div class="dt-th-inner"><span class="dt-th-label" data-sort-h="${h}">${h}${arrow}</span>${filterBt}</div>${pop}</th>`;
    }).join('');

    const body = pageRows.length
      ? pageRows.map(r => `<tr>${hs.map(h=>`<td>${r[h]??'—'}</td>`).join('')}</tr>`).join('')
      : `<tr><td colspan="${hs.length}" class="dt-empty">No matching records.</td></tr>`;

    const pagination = `
      <div class="dt-pagination">
        <span>${all.length.toLocaleString()} record${all.length===1?'':'s'} · Page ${page} of ${totalPages}</span>
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

/* ── Reusable header widgets (used by KPI + Heatmap) ─────────────────────── */
// Filter icon → floating popover. Closes on X, outside click, Escape, or Apply.
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

// Table icon → floating modal (closes on X, backdrop click, or Escape).
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

/* ══════════════════════════════════════════════════════════════════════════
   INIT — fetch meta, populate all filters, load all charts
   ══════════════════════════════════════════════════════════════════════════ */
/* Program name -> acronym, for CHART labels only. Filters, drill-downs and API
   params keep the full program name. Colleges are not in the map, so they pass
   through unchanged. Filled from /api/dash/meta (courses[].short). */
function courseShort(label) {
  const m = window._courseShort;
  return (m && m[label]) || label;
}
window.courseShort = courseShort;

async function initDashboard() {
  try {
    const res = await fetch('/api/dash/meta');
    if (!res.ok) throw new Error('meta ' + res.status);
    const meta = await res.json();
    window._metaYears   = meta.years || [];
    window._metaDepts   = meta.departments || [];
    window._allCourses  = meta.courses || [];
    window._courseShort = Object.fromEntries((meta.courses || []).map(c => [c.code, c.short || c.code]));
    window._ayToSems    = meta.ay_to_sems || {};

    // Populate KPI year filter
    fillYearSelect('kpi-year', window._metaYears, meta.recent_year);

    // Populate KPI semester based on most recent year
    _populateKpiSemesters(meta.recent_year || '');

    // Auto-select most recent year + semester (this is the dashboard's default view)
    window._kpiDefaultYear = meta.recent_year || '';
    window._kpiDefaultSem  = meta.recent_sem  || '';
    const kpiYearSel = $('kpi-year');
    if (kpiYearSel && meta.recent_year) {
      kpiYearSel.value = meta.recent_year;
      KF.year = meta.recent_year;
    }
    const kpiSemSel = $('kpi-sem');
    if (kpiSemSel && meta.recent_sem) {
      kpiSemSel.value = meta.recent_sem;
      KF.sem = meta.recent_sem;
    }

    fillSelect('kpi-dept', window._metaDepts);
    fillSelect('kpi-course', window._allCourses, c=>c.label||c.code, c=>c.code);

    // Heatmap: same academic-year / semester defaults as the KPI card
    fillYearSelect('hmYear', window._metaYears, meta.recent_year);
    _populateSemesters('hmSem', meta.recent_year || '');
    const hmYearSel = $('hmYear');
    if (hmYearSel && meta.recent_year) { hmYearSel.value = meta.recent_year; HF.year = meta.recent_year; }
    const hmSemSel = $('hmSem');
    if (hmSemSel && meta.recent_sem)   { hmSemSel.value = meta.recent_sem;   HF.sem  = meta.recent_sem; }
    fillSelect('hmDept', window._metaDepts);
    _fillCourses('hmDept', 'hmCourse');

    // Gender & Status: same academic-year / semester defaults as the KPI card + heatmap
    fillYearSelect('gdYear', window._metaYears, meta.recent_year);
    _populateSemesters('gdSem', meta.recent_year || '');
    const gdYearSel = $('gdYear');
    if (gdYearSel && meta.recent_year) { gdYearSel.value = meta.recent_year; GDF.year = meta.recent_year; }
    const gdSemSel = $('gdSem');
    if (gdSemSel && meta.recent_sem)   { gdSemSel.value = meta.recent_sem;   GDF.sem  = meta.recent_sem; }
    fillSelect('gdDept', window._metaDepts);
    _fillCourses('gdDept', 'gdCourse');

    // Hardest Subjects: same academic-year / semester defaults as the other cards
    fillYearSelect('hsYear', window._metaYears, meta.recent_year);
    _populateSemesters('hsSem', meta.recent_year || '');
    const hsYearSel = $('hsYear');
    if (hsYearSel && meta.recent_year) { hsYearSel.value = meta.recent_year; HSF.year = meta.recent_year; }
    const hsSemSel = $('hsSem');
    if (hsSemSel && meta.recent_sem)   { hsSemSel.value = meta.recent_sem;   HSF.sem  = meta.recent_sem; }
    fillSelect('hsDept', window._metaDepts);
    _fillCourses('hsDept', 'hsCourse');

    // Performance card: same defaults
    fillYearSelect('perfYear', window._metaYears, meta.recent_year);
    _populateSemesters('perfSem', meta.recent_year || '');
    const perfYearSel = $('perfYear');
    if (perfYearSel && meta.recent_year) { perfYearSel.value = meta.recent_year; PF.year = meta.recent_year; }
    const perfSemSel = $('perfSem');
    if (perfSemSel && meta.recent_sem)   { perfSemSel.value = meta.recent_sem;   PF.sem  = meta.recent_sem; }
    fillSelect('perfDept', window._metaDepts);
    _fillCourses('perfDept', 'perfCourse');

    // Global filter bar: Academic Year + Term show only real periods and
    // default to the most recently uploaded academic year + semester.
    fillYearSelect('globalYear', window._metaYears, meta.recent_year);
    _populateSemesters('globalSem', $('globalYear')?.value || meta.recent_year || '');
    const globalSemSel = $('globalSem');
    if (globalSemSel && meta.recent_sem) globalSemSel.value = meta.recent_sem;
    $('globalYear')?.addEventListener('change', () => _populateSemesters('globalSem', $('globalYear').value));

    // KPI Trend card: dept/course only (no year/sem — it always spans every period)
    fillSelect('kpiTrend-dept', window._metaDepts);
    _fillCourses('kpiTrend-dept', 'kpiTrend-course');

    // Enrollment Trend card: same deal
    fillSelect('enrollTrend-dept', window._metaDepts);
    _fillCourses('enrollTrend-dept', 'enrollTrend-course');

  } catch(e) {
    console.error('Dashboard meta failed:', e);
  }

  // Load all charts
  loadKpi();
  window.loadEnrollTrend?.();
  window.loadKpiTrend?.();
  loadHeatmap();
  loadPerformance();
  loadGenderPie();
  loadHardestSubjects();
}

/* ══════════════════════════════════════════════════════════════════════════
   1. KPI CARD
   ══════════════════════════════════════════════════════════════════════════ */
let kpiMetric       = 'all';
let kpiStatusMetric = 'all';
let kpiData         = null;
let KF = { year:'', sem:'', dept:'', course:'', yearlevel:'' };

// KPI dept → course cascade
// Cascade semester options when year changes
function _populateKpiSemesters(yr) { _populateSemesters('kpi-sem', yr); }
function _populateSemesters(selId, yr) {
  const semSel = $(selId);
  if (!semSel) return;
  const prevVal = semSel.value;
  semSel.innerHTML = '';
  // No "All" option: a specific semester is always selected. With no year chosen,
  // offer every semester that exists in any year (or 1st/2nd as a last resort).
  let sems = (window._ayToSems || {})[yr] || [];
  if (!sems.length) {
    const all = [];
    Object.values(window._ayToSems || {}).forEach(list => (list || []).forEach(x => { if (!all.includes(x)) all.push(x); }));
    sems = all.length ? all : ['1sem', '2sem'];
  }
  const semLabels = {
    '1sem':'1st Semester', '2sem':'2nd Semester', 'Summer':'Summer',
    '1st Semester':'1st Semester', '2nd Semester':'2nd Semester',
  };
  sems.forEach(sem => {
    semSel.add(new Option(semLabels[sem] || sem, sem));
  });
  // Restore or pick last
  if (sems.includes(prevVal)) semSel.value = prevVal;
  else if (sems.length) semSel.value = sems[sems.length - 1];
}

const _kpiYear = $('kpi-year');
if (_kpiYear) {
  _kpiYear.addEventListener('change', () => {
    _populateKpiSemesters(_kpiYear.value);
  });
}

const _kpiDept = $('kpi-dept');
if (_kpiDept) {
  _kpiDept.addEventListener('change', () => {
    const dept = _kpiDept.value;
    const courseSel = $('kpi-course');
    if (!courseSel) return;
    while (courseSel.options.length > 1) courseSel.remove(1);
    (dept ? (window._allCourses||[]).filter(c=>c.dept===dept) : (window._allCourses||[]))
      .forEach(c => courseSel.add(new Option(c.label||c.code, c.code)));
  });
}

// Apply / Reset
const _kpiBtnApply = $('kpiBtnApply');
if (_kpiBtnApply) {
  _kpiBtnApply.addEventListener('click', () => {
    KF.year      = $('kpi-year')?.value      || '';
    KF.sem       = $('kpi-sem')?.value       || '';
    KF.dept      = $('kpi-dept')?.value      || '';
    KF.course    = $('kpi-course')?.value    || '';
    KF.yearlevel = $('kpi-yearlevel')?.value || '';
    loadKpi();
  });
}
const _kpiBtnReset = $('kpiBtnReset');
if (_kpiBtnReset) {
  _kpiBtnReset.addEventListener('click', () => {
    // "Default" = the most recently uploaded academic year + semester, not blank/All.
    const defYear = window._kpiDefaultYear || '';
    const defSem  = window._kpiDefaultSem  || '';
    KF = { year: defYear, sem: defSem, dept:'', course:'', yearlevel:'' };

    const yearSel = $('kpi-year');
    if (yearSel) yearSel.value = defYear;
    _populateKpiSemesters(defYear);   // rebuilds the semester options for that year
    const semSel = $('kpi-sem');
    if (semSel) semSel.value = defSem;

    ['kpi-dept','kpi-course','kpi-yearlevel'].forEach(id => {
      const el = $(id); if (el) el.value = '';
    });
    loadKpi();
  });
}

// Metric buttons
qsa('[data-kpi-metric]').forEach(btn => {
  btn.addEventListener('click', () => {
    qsa('[data-kpi-metric]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    kpiMetric = btn.dataset.kpiMetric;
    if (kpiData) renderKpiEnroll(kpiData);
  });
});
qsa('[data-status-metric]').forEach(btn => {
  btn.addEventListener('click', () => {
    qsa('[data-status-metric]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    kpiStatusMetric = btn.dataset.statusMetric;
    if (kpiData) renderKpiStatus(kpiData);
  });
});

async function loadKpi() {
  try {
    const p = new URLSearchParams();
    if (KF.year)      p.set('year', KF.year);
    if (KF.sem)       p.set('sem', KF.sem);
    if (KF.dept)      p.set('dept', KF.dept);
    if (KF.course)    p.set('course', KF.course);
    if (KF.yearlevel) p.set('yearlevel', KF.yearlevel);
    { const c = cmpOf('kpiCompare'); if (c) p.set('compare', c); }

    const res = await fetch('/api/dash/kpi?' + p.toString());
    if (!res.ok) throw new Error('KPI ' + res.status);
    kpiData = await res.json();

    renderKpiEnroll(kpiData);
    renderKpiGwa(kpiData);
    renderKpiCompletion(kpiData);
    renderKpiStatus(kpiData);
    renderKpiYearLevel(kpiData);
    renderKpiTable(kpiData);
  } catch(e) {
    console.error('KPI load failed:', e);
    const el = $('kpiEnrollVal');
    if (el) el.textContent = '—';
  }
}

/* Flat metric/value table version of the KPI card — same numbers as the
   dashboard view above, just easier to scan/sort/copy in one column. */
let kpiTableRows = [];
function renderKpiTable(data) {
  if (!data) return;
  const reg   = Number(data.regular_count)   || 0;
  const irreg = Number(data.irregular_count) || 0;
  const totalRI = reg + irreg;
  const totalEnroll = data.total_enrollment || 0;
  const yl = data.year_level_counts || {};
  const sc = data.status_counts || {};

  const ylLabels = [['1','1st Year'],['2','2nd Year'],['3','3rd Year'],['4','4th Year'],['IRREG','Irregular']];
  const statusLabels = [
    ['FAILED','Failed'], ['DRP','Dropped'], ['INC','Incomplete'],
    ['UDR','Unofficial Drop'], ['W','Withdrawn'], ['NGA','No Grade Assigned'],
  ];

  let i = 0;
  const rows = [];
  const add = (metric, value) => rows.push({ '#': String(++i), 'Metric': metric, 'Value': value });

  add('Total Enrollment', totalEnroll.toLocaleString());
  add('Regular Students', `${reg.toLocaleString()}${totalRI ? ` (${(reg/totalRI*100).toFixed(1)}%)` : ''}`);
  add('Irregular Students', `${irreg.toLocaleString()}${totalRI ? ` (${(irreg/totalRI*100).toFixed(1)}%)` : ''}`);
  add('Average GWA', data.avg_gwa != null ? Number(data.avg_gwa).toFixed(2) : '—');
  add('Avg Completion Rate', data.avg_completion != null ? Number(data.avg_completion).toFixed(1) + '%' : '—');
  ylLabels.forEach(([k, label]) => {
    const n = Number(yl[k] || 0);
    add(`Year Level — ${label}`, `${n.toLocaleString()}${totalEnroll ? ` (${(n/totalEnroll*100).toFixed(1)}%)` : ''}`);
  });
  statusLabels.forEach(([k, label]) => add(`Status — ${label}`, Number(sc[k] || 0).toLocaleString()));

  kpiTableRows = rows;
  buildTable('kpiTableInner', rows, ['#','Metric','Value'], '#', 'asc', {
    filename: 'kpi_summary', pageSize: 8,
    title: 'Enrollment & Status Summary',
    description: 'Key enrollment, GWA, and status metrics for the currently selected filters.',
  });
}

$('kpiTableDownloadCsv')?.addEventListener('click', () => {
  if (!kpiTableRows.length) return;
  downloadCsv(kpiTableRows, ['Metric','Value'], 'kpi_summary');
});

// Table icon opens the KPI table as a floating modal.
initTableModal({
  openId: 'kpiViewTable', modalId: 'kpiTableModal', closeId: 'kpiTableModalClose',
  onOpen: () => { if (kpiData) renderKpiTable(kpiData); },
});

function renderKpiEnroll(data) {
  const map = {
    all: data.total_enrollment,
    regular: data.regular_count,
    irregular: data.irregular_count,
  };
  const val = map[kpiMetric] ?? data.total_enrollment ?? 0;
  const el = $('kpiEnrollVal');
  if (el) el.textContent = Number(val).toLocaleString();

  // Row 1: raw count change (how many more/fewer students vs previous semester)
  // Rendered as a white pill so the number stays readable on the dark red card.
  const delta = data.enrollment_delta;
  const deltaEl = $('kpiEnrollDelta');
  if (deltaEl) {
    if (delta != null && !isNaN(delta) && delta !== 0) {
      const up = delta > 0;
      deltaEl.innerHTML = enrollPill(`${up ? '▲' : '▼'} ${Math.abs(delta).toLocaleString()}`, up, 14);
    } else if (delta === 0) {
      deltaEl.innerHTML = enrollPill('No change', null, 14);
    } else {
      deltaEl.innerHTML = '';
    }
  }

  // Row 2: percentage change, below the raw count — same pill treatment
  const pct = data.enrollment_pct_change;
  const pctEl = $('kpiEnrollPct');
  if (pctEl) {
    if (pct != null && !isNaN(pct)) {
      const up = pct > 0;
      pctEl.innerHTML = enrollPill(`${up ? '▲' : '▼'} ${Math.abs(pct).toFixed(1)}%`, up, 18);
    } else {
      pctEl.innerHTML = '';
    }
  }

  renderKpiRegIrreg(data);
}

/* Regular vs Irregular split bar — same data the All/Regular/Irregular
   toggle above already switches between (regular_count / irregular_count
   from /api/dash/kpi), just shown side-by-side here instead of one at a time. */
function renderKpiRegIrreg(data) {
  const reg   = Number(data.regular_count)   || 0;
  const irreg = Number(data.irregular_count) || 0;
  const total = reg + irreg;
  const regPct   = total > 0 ? (reg   / total * 100) : 0;
  const irregPct = total > 0 ? (irreg / total * 100) : 0;

  const fillReg   = $('kpiRegIrregFillReg');
  const fillIrreg = $('kpiRegIrregFillIrreg');
  if (fillReg)   fillReg.style.flexBasis   = regPct + '%';
  if (fillIrreg) fillIrreg.style.flexBasis = irregPct + '%';

  const regVal   = $('kpiRegIrregRegVal');
  const irregVal = $('kpiRegIrregIrregVal');
  if (regVal)   regVal.textContent   = reg.toLocaleString();
  if (irregVal) irregVal.textContent = irreg.toLocaleString();

  const regPctEl   = $('kpiRegIrregRegPct');
  const irregPctEl = $('kpiRegIrregIrregPct');
  if (regPctEl)   regPctEl.textContent   = total > 0 ? ` (${regPct.toFixed(1)}%)`   : '';
  if (irregPctEl) irregPctEl.textContent = total > 0 ? ` (${irregPct.toFixed(1)}%)` : '';
}

function renderKpiGwa(data) {
  const el = $('kpiGwaVal');
  if (el) el.textContent = data.avg_gwa != null ? Number(data.avg_gwa).toFixed(2) : '—';
  // Delta text
  const d = $('kpiGwaDelta');
  if (d) d.innerHTML = deltaHtml(data.gwa_delta, '', true) || '';
  // Pct badge (GWA: lower is better so invert)
  const pctEl = $('kpiGwaPct');
  const pct = data.gwa_pct_change;
  if (pctEl) {
    if (pct != null && !isNaN(pct)) {
      const up = pct > 0;
      pctEl.className = 'kpi-mini-pct-badge ' + (pct === 0 ? 'flat' : (up ? 'down' : 'up'));
      pctEl.textContent = (up ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(1) + '%';
    } else {
      pctEl.className = 'kpi-mini-pct-badge flat';
      pctEl.textContent = '—';
    }
  }
}

function renderKpiCompletion(data) {
  const el = $('kpiCompVal');
  if (el) el.textContent = data.avg_completion != null ? Number(data.avg_completion).toFixed(1) + '%' : '—';
  // Delta text
  const d = $('kpiCompDelta');
  if (d) d.innerHTML = deltaHtml(data.completion_delta, '%') || '';
  // Pct badge (completion: higher is better)
  const pctEl = $('kpiCompPct');
  const pct = data.completion_pct_change;
  if (pctEl) {
    if (pct != null && !isNaN(pct)) {
      const up = pct > 0;
      pctEl.className = 'kpi-mini-pct-badge ' + (pct === 0 ? 'flat' : (up ? 'up' : 'down'));
      pctEl.textContent = (up ? '▲ ' : '▼ ') + Math.abs(pct).toFixed(1) + '%';
    } else {
      pctEl.className = 'kpi-mini-pct-badge flat';
      pctEl.textContent = '—';
    }
  }
}

function renderKpiStatus(data) {
  const statuses = ['FAILED','DRP','INC','UDR','W','NGA'];
  const sc = data.status_counts || {};
  const valEl = $('kpiStatusVal');
  const bdEl  = $('kpiStatusBreakdown');

  if (kpiStatusMetric === 'all') {
    const total = statuses.reduce((s,k) => s + (sc[k]||0), 0);
    if (valEl) valEl.textContent = total.toLocaleString();
    if (bdEl) bdEl.innerHTML = statuses.map(st =>
      `<div class="status-chip">
         <span class="status-chip-val">${(sc[st]||0).toLocaleString()}</span>
         <span class="status-chip-label">${st==='DRP'?'Drop':st}</span>
       </div>`
    ).join('');
  } else {
    const v = sc[kpiStatusMetric] || 0;
    if (valEl) valEl.textContent = v.toLocaleString();
    if (bdEl) bdEl.innerHTML = '';
  }
}

function renderKpiYearLevel(data) {
  const yl    = data.year_level_counts || {};
  const total = data.total_enrollment || 1;
  // 1st-4th + Irreg only (no 5th year)
  const labels = [['1','1st'],['2','2nd'],['3','3rd'],['4','4th'],['IRREG','Irreg']];
  const el = $('kpiYearLevelRow');
  if (!el) return;
  el.innerHTML = labels.map(([k, label]) => {
    const n   = Number(yl[k] || 0);
    const pct = total > 0 ? ((n / total) * 100).toFixed(1) : '0.0';
    return `<div class="kpi-yl-chip">
      <span class="kpi-yl-chip-num">${n.toLocaleString()}</span>
      <span class="kpi-yl-chip-label">${label}</span>
      <span class="kpi-yl-chip-pct">${pct}%</span>
    </div>`;
  }).join('');
}


/* ══════════════════════════════════════════════════════════════════════════
   2. HEATMAP
   ══════════════════════════════════════════════════════════════════════════ */
let hmData = null;

// ── Global semester comparison (shared across all cards) ──────────────────────
// 'prev_sem' = vs previous semester (default)
// '1sem'     = 1st Sem vs 1st Sem of previous year
// '2sem'     = 2nd Sem vs 2nd Sem of previous year
// ''         = no comparison
/* ── Comparison lives in each chart's filter popover (default: None) ─── */
const cmpOf = id => document.getElementById(id)?.value || '';
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('select[id$="Compare"]').forEach(sel => {
    const p = sel.id.replace(/Compare$/, '');
    document.getElementById(p + 'BtnReset')?.addEventListener('click', () => { sel.value = ''; }, true);
  });
});



// Applied heatmap filters (updated by Apply / Reset). Year + semester default to
// the most recent upload, same as the KPI card.
let HF = { year:'', sem:'', dept:'', course:'', yearlevel:'', status:'FAILED', sort:'desc', metric:'rate' };

// Rebuild a course <select> from the cached course list, limited to the chosen dept.
function _fillCourses(deptId, courseId) {
  const courseSel = $(courseId);
  if (!courseSel) return;
  const dept = $(deptId)?.value || '';
  while (courseSel.options.length > 1) courseSel.remove(1);
  (dept ? (window._allCourses||[]).filter(c => c.dept === dept) : (window._allCourses||[]))
    .forEach(c => courseSel.add(new Option(c.label||c.code, c.code)));
}

async function loadHeatmap() {
  const p = new URLSearchParams();
  Object.entries(HF).forEach(([k, v]) => { if (v !== '' && v !== undefined && v !== null) p.set(k, v); });
  { const c = cmpOf('hmCompare'); if (c) p.set('compare', c); }

  // Destroy existing chart before loading
  if (hmChart) { hmChart.destroy(); hmChart = null; }
  $('hmChartArea')?.classList.remove('clickable');
  loading('hmChartArea');

  // Update subtitle based on dept filter
  const subtitle = $('hmSubtitle');
  if (subtitle) {
    subtitle.textContent = HF.dept
      ? `Failure rate by course program — ${HF.dept}`
      : 'Failure rate by college — select a department to drill into course programs';
  }

  try {
    const res = await fetch('/api/dash/heatmap?' + p.toString());
    if (!res.ok) throw new Error('heatmap ' + res.status);
    hmData = await res.json();
    renderHeatmap(hmData);
  } catch(e) { hmData = null; empty('hmChartArea'); }
}

/* Green → yellow → red scale (ColorBrewer RdYlGn, reversed so red = worst) */
const HM_STOPS = ['#006837','#1a9850','#66bd63','#a6d96a','#d9ef8b','#ffffbf',
                  '#fee08b','#fdae61','#f46d43','#d73027','#a50026']
  .map(hex => [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16)));
const HM_STATUS_LABELS = { FAILED:'Failed', INC:'INC', DRP:'DRP', W:'W', UDR:'UDR' };

function hmColor(t) {
  t = Math.max(0, Math.min(1, t));
  const pos = t * (HM_STOPS.length - 1);
  const i = Math.min(Math.floor(pos), HM_STOPS.length - 2);
  const f = pos - i;
  return HM_STOPS[i].map((c, k) => Math.round(c + (HM_STOPS[i + 1][k] - c) * f));
}
const hmRgb = c => `rgb(${c[0]},${c[1]},${c[2]})`;
// White text on the dark greens/reds, dark text on the light yellows/oranges.
function hmTextColor(c) {
  return ((0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255) < 0.5 ? '#fff' : '#1f2937';
}

// Cell text: "12.3%" in Percentage mode, "45" in No. of Students mode.
function hmFormat(v, isCount) {
  return isCount ? Math.round(v).toLocaleString() : v.toFixed(1) + '%';
}

// Year level display labels and colors
const YL_LABELS = { '1':'1st Yr', '2':'2nd Yr', '3':'3rd Yr', '4':'4th Yr', '5':'5th Yr', 'IRREG':'Irreg' };
const YL_COLORS = ['#2563EB','#059669','#7C3AED','#0891B2','#D97706','#64748B'];

// Chart.js instance for the histogram
let hmChart = null;

// Sizes the histogram's wrap. Normally, height grows with row count (thicker,
// taller bars, page scrolls as needed). In fullscreen, height is capped to
// exactly the available viewport space instead, so all rows fit without an
// internal scrollbar — bars just get thinner if there are a lot of rows.
function sizeHistogramWrap() {
  const wrap = document.querySelector('#hmChartArea .hm-histogram-wrap');
  if (!wrap) return;
  wrap.style.width = '100%';
  const rows = parseInt(wrap.dataset.rows || '0', 10);
  const isFullscreen = document.getElementById('heatmapCard')?.classList.contains('is-fullscreen');
  if (isFullscreen) {
    const available = wrap.parentElement?.clientHeight || 650;
    wrap.style.height = available + 'px';
  } else {
    wrap.style.height = Math.max(480, rows * 95) + 'px';
  }
}

/* ── Compare-mode histogram: delta bars (current − previous) ──────────────
   Positive delta (got worse) → red bar above baseline
   Negative delta (improved)  → green bar below baseline
   Each group = one college/course, bars = year levels
   ──────────────────────────────────────────────────────────────────────── */
function renderHeatmapCompare(data) {
  const area = $('hmChartArea');
  if (hmChart) { hmChart.destroy(); hmChart = null; }

  const isCount   = data.metric === 'count';
  const isCollege = data.view !== 'course';
  const statusLabel = HM_STATUS_LABELS[HF.status] || 'Failed';
  const viewLabel   = isCollege ? 'College' : 'Course Program';
  const prevLabel   = data.prev_period || 'previous period';
  const yls = data.year_levels || [];
  const rows = data.rows;
  const labels = rows.map(r => courseShort(r.label));
  const isMobile = window.innerWidth < 640;
  const perGroup = isMobile ? 64 : 92;

  area.innerHTML = `<div class="hm-histogram-wrap" data-rows="${labels.length}">
    <div class="hm-compare-legend">
      <span class="hm-compare-pill worse">▲ Worse than ${prevLabel}</span>
      <span class="hm-compare-pill better">▼ Better than ${prevLabel}</span>
      <span class="hm-compare-pill same">— No change / No data</span>
    </div>
    <canvas id="hmHistCanvas"></canvas>
  </div>`;

  const wrap = area.querySelector('.hm-histogram-wrap');
  wrap.style.height = Math.max(isMobile ? 480 : 740, 100 + labels.length * perGroup) + 'px';
  const canvas = document.getElementById('hmHistCanvas');

  // One dataset per year level — split into positive/negative for colouring
  const datasets = yls.map((yl, i) => {
    const base = YL_COLORS[i % YL_COLORS.length];
    return {
      label: YL_LABELS[yl] || yl,
      data: rows.map(r => {
        const d = r.delta?.[yl];
        return (d === null || d === undefined) ? 0 : d;
      }),
      backgroundColor: rows.map(r => {
        const d = r.delta?.[yl];
        if (d === null || d === undefined || d === 0) return 'rgba(156,163,175,0.35)';
        return d > 0 ? 'rgba(220,38,38,0.75)' : 'rgba(22,163,74,0.75)';
      }),
      borderRadius: 3,
      borderSkipped: false,
      barPercentage: 0.95,
      categoryPercentage: 0.90,
    };
  });

  const hmComparePlugin = {
    id: 'hmCompare',
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      // Separator lines between groups
      const xScale = scales.x;
      ctx.save();
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 1;
      xScale.ticks.forEach((_, i) => {
        if (i === 0) return;
        const x = xScale.getPixelForTick(i) - (xScale.getPixelForTick(1) - xScale.getPixelForTick(0)) / 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath(); ctx.moveTo(x, chartArea.top); ctx.lineTo(x, chartArea.bottom); ctx.stroke();
      });
      ctx.restore();
    }
  };

  const suffix = isCount ? '' : '%';
  hmChart = new Chart(canvas, {
    type: 'bar',
    plugins: [hmComparePlugin],
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          display: true, position: 'top', align: 'start',
          labels: { boxWidth: isMobile?10:12, font:{size:isMobile?11:12,weight:'600'}, color:'#374151', padding:isMobile?10:14 }
        },
        tooltip: {
          mode: 'index', intersect: false,
          callbacks: {
            title: tt => rows[tt[0]?.dataIndex]?.label || tt[0]?.label || '',
            label: tt => {
              const yl = yls[tt.datasetIndex];
              const row = rows[tt.dataIndex];
              const cur  = row?.[yl]; const prv = row?.prev?.[yl]; const delta = row?.delta?.[yl];
              const ylLabel = YL_LABELS[yl] || yl;
              if (cur === null || cur === undefined) return `${ylLabel}: no data`;
              const sign = delta > 0 ? '+' : '';
              return `${ylLabel}: ${sign}${delta?.toFixed(1)}${suffix} (${prv?.toFixed(1)}${suffix} → ${cur?.toFixed(1)}${suffix})`;
            },
          }
        }
      },
      scales: {
        x: {
          border: { display: true, color: '#e5e7eb' },
          grid: { display: false },
          ticks: { color:'#374151', font:{size:isMobile?10:11}, autoSkip:false, maxRotation:isMobile?30:15 },
          title: { display:true, text:viewLabel, color:'#374151', font:{size:isMobile?11:12,weight:'600'} },
        },
        y: {
          border: { display:true, color:'#e5e7eb' },
          grid: { color:'#f0f0f0', drawTicks:false },
          ticks: {
            color:'#6b7280', font:{size:isMobile?10:11}, padding:4,
            callback: v => (v > 0 ? '+' : '') + v + suffix,
          },
          title: { display:!isMobile, text:`Δ ${statusLabel} rate vs ${prevLabel}`, color:'#374151', font:{size:12,weight:'600'} },
        }
      }
    }
  });
}

function renderHeatmap(data) {
  const area = $('hmChartArea');
  if (!data?.rows?.length) { empty('hmChartArea', data?.note || undefined); return; }

  // ── Compare mode: render delta chart ────────────────────────────────────
  if (data.compare && data.rows[0]?.delta !== undefined) {
    renderHeatmapCompare(data); return;
  }

  const isCount   = data.metric === 'count';
  const isCollege = data.view !== 'course';
  const statusLabel = HM_STATUS_LABELS[HF.status] || 'Failed';
  const viewLabel   = isCollege ? 'College' : 'Course Program';
  const yls = data.year_levels?.length
    ? data.year_levels
    : ['1','2','3','4','IRREG'];

  if (hmChart) { hmChart.destroy(); hmChart = null; }

  area.innerHTML = `<div class="hm-histogram-wrap"><canvas id="hmHistCanvas"></canvas></div>`;

  // Horizontal grouped bar: colleges/courses on Y-axis, rate on X-axis.
  // Server returns rows sorted per hmSort — no reversal needed.
  const rows   = [...data.rows];
  const labels = rows.map(r => courseShort(r.label));
  const maxX   = isCount ? (data.max_val || 1) : 100;

  // One dataset per year level
  const datasets = yls.map((yl, i) => ({
    label: YL_LABELS[yl] || yl,
    data:  rows.map(r => r[yl] ?? 0),
    backgroundColor: YL_COLORS[i % YL_COLORS.length],
    borderRadius: 3,
    borderSkipped: false,
    barPercentage: 0.92,
    categoryPercentage: 0.88,
  }));

  const canvas = document.getElementById('hmHistCanvas');
  const isMobile = window.innerWidth < 640;
  // More height per group on desktop, slightly less on mobile (horizontal scroll handles width).
  // The floor (not just the per-group amount) was raised too — with few groups (e.g. the default
  // "All Colleges" view, just 6 bars-groups) the chart was always sitting at the bare minimum.
  const perGroup = isMobile ? 64 : 92;
  canvas.parentElement.style.height = Math.max(isMobile ? 480 : 740, 100 + labels.length * perGroup) + 'px';

  // Plugin: value label to the right of each individual bar + horizontal separator lines between groups
  const hmInlinePlugin = {
    id: 'hmInline',
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      const yScale = scales.y;

      // Horizontal separator lines between college/course groups
      const n = yScale.ticks?.length || labels.length;
      for (let i = 0; i < n - 1; i++) {
        const y0 = yScale.getPixelForTick(i);
        const y1 = yScale.getPixelForTick(i + 1);
        const mid = (y0 + y1) / 2;
        ctx.save();
        ctx.strokeStyle = '#e5e7eb';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(chartArea.left, mid);
        ctx.lineTo(chartArea.right, mid);
        ctx.stroke();
        ctx.restore();
      }

      // Value label to the right of every bar (skip zeros)
      ctx.save();
      ctx.font = '600 9px Inter, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      const ylTag = { 1:'1st', 2:'2nd', 3:'3rd', 4:'4th', 5:'5th', IRREG:'Irreg' };
      chart.data.datasets.forEach((ds, dsIdx) => {
        const meta = chart.getDatasetMeta(dsIdx);
        if (meta.hidden) return;
        const tag = ylTag[yls[dsIdx]] || yls[dsIdx];
        meta.data.forEach((bar, rowIdx) => {
          const v = ds.data[rowIdx] ?? 0;
          if (v <= 0) return;
          const val = isCount ? v.toLocaleString() : v.toFixed(1) + '%';
          ctx.fillStyle = '#374151';
          ctx.fillText(`${val} ${tag}`, bar.x + 4, bar.y);
        });
      });

      ctx.restore();
    },
  };

  hmChart = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets },
    plugins: [hmInlinePlugin],
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 4, right: 64, bottom: 4 } },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'center',
          rtl: false,
          labels: {
            boxWidth: isMobile ? 10 : 12,
            boxHeight: isMobile ? 10 : 12,
            font: { size: isMobile ? 11 : 12, weight: '600' },
            color: '#374151',
            padding: isMobile ? 10 : 14,
            usePointStyle: false,
          },
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          callbacks: {
            label(ctx) {
              const row    = rows[ctx.dataIndex];
              const yl     = yls[ctx.datasetIndex];
              const val    = ctx.parsed.x;
              if (val == null || val === 0) return null;
              const base   = isCount ? `${val.toLocaleString()} students` : `${val.toFixed(1)}%`;
              const n      = row?.enrolled?.[yl];
              const k      = row?.with_status?.[yl];
              const detail = n != null && k != null
                ? ` (${k.toLocaleString()} of ${n.toLocaleString()} enrolled)`
                : '';
              return ` ${ctx.dataset.label}: ${base}${detail}`;
            },
            title(items) { return rows[items[0].dataIndex]?.label || items[0].label; },
          },
        },
      },
      scales: {
        y: {
          border: { display: true, color: '#e5e7eb' },
          grid: { display: false },
          ticks: {
            color: '#374151',
            font: { size: isMobile ? 10 : 11 },
            autoSkip: false,
          },
          title: {
            display: !isMobile,
            text: viewLabel,
            color: '#374151',
            font: { size: isMobile ? 11 : 12, weight: '600' },
          },
        },
        x: {
          min: 0,
          max: maxX,
          border: { display: true, color: '#e5e7eb' },
          grid: { color: '#f0f0f0', drawTicks: false },
          ticks: {
            color: '#6b7280',
            font: { size: isMobile ? 10 : 11 },
            padding: 4,
            callback: v => isCount ? v.toLocaleString() : v + '%',
          },
          title: {
            display: true,
            text: isCount ? `${statusLabel} (no. of students)` : `${statusLabel} rate (%)`,
            color: '#374151',
            font: { size: 12, weight: '600' },
          },
        },
      },
    },
  });

  area.classList.add('clickable');
}

// Re-render histogram on resize/orientation change for mobile responsiveness
(function () {
  let _hmResizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_hmResizeTimer);
    _hmResizeTimer = setTimeout(() => {
      if (hmData?.rows?.length) renderHeatmap(hmData);
    }, 300);
  });
})();

function renderHeatmapTable(data) {
  if (!data?.rows) return;
  const isCount = data.metric === 'count';
  const yls = data.year_levels || [];
  const ylLabels = {1:'1st',2:'2nd',3:'3rd',4:'4th',5:'5th',IRREG:'Irreg'};
  const headers = ['College / Course', ...yls.map(y => ylLabels[y] || y)];
  const rows = data.rows.map(r => {
    const o = { 'College / Course': r.label };
    yls.forEach(yl => {
      const v = r[yl];
      o[ylLabels[yl] || yl] = v != null
        ? (isCount ? Math.round(v).toLocaleString() : v.toFixed(1) + '%')
        : '—';
    });
    return o;
  });
  buildTable('hmTableInner', rows, headers, headers[1] || 'College / Course', 'desc', {
    filename: 'histogram_data',
    title: 'Risk Histogram — Table View',
    description: 'Values by college or course program × year level for the currently selected filters.',
  });
}

// Apply / Reset (filters live in the popover; nothing reloads until Apply)
$('hmDept')?.addEventListener('change', () => _fillCourses('hmDept', 'hmCourse'));
$('hmYear')?.addEventListener('change', () => _populateSemesters('hmSem', $('hmYear').value));

// Status metric buttons (outside the filter popover) — apply immediately, like the KPI metric buttons.
function syncHmStatusButtons() {
  qsa('[data-hm-status]').forEach(b => b.classList.toggle('active', b.dataset.hmStatus === HF.status));
}
qsa('[data-hm-status]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (HF.status === btn.dataset.hmStatus) return;
    HF.status = btn.dataset.hmStatus;
    syncHmStatusButtons();
    loadHeatmap();
  });
});

// Percentage / No. of Students toggle — also outside the popover, applies immediately.
function syncHmMetricButtons() {
  qsa('[data-hm-metric]').forEach(b => b.classList.toggle('active', b.dataset.hmMetric === HF.metric));
}
qsa('[data-hm-metric]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (HF.metric === btn.dataset.hmMetric) return;
    HF.metric = btn.dataset.hmMetric;
    syncHmMetricButtons();
    loadHeatmap();
  });
});

// Sort order sits in the header (outside the filter popover) and applies immediately.
$('hmSort')?.addEventListener('change', () => {
  HF.sort = $('hmSort').value || 'desc';
  loadHeatmap();
});

$('hmBtnApply')?.addEventListener('click', () => {
  HF = {
    year:      $('hmYear')?.value      || '',
    sem:       $('hmSem')?.value       || '',
    dept:      $('hmDept')?.value      || '',
    course:    $('hmCourse')?.value    || '',
    yearlevel: $('hmYearLevel')?.value || '',
    status:    HF.status,
    sort:      HF.sort,
    metric:    HF.metric,
  };
  loadHeatmap();
});

$('hmBtnReset')?.addEventListener('click', () => {
  // "Default" = the most recently uploaded academic year + semester, Failed, descending.
  const defYear = window._kpiDefaultYear || '';
  const defSem  = window._kpiDefaultSem  || '';
  HF = { year: defYear, sem: defSem, dept:'', course:'', yearlevel:'', status:'FAILED', sort:'desc', metric:'rate' };

  const yearSel = $('hmYear');
  if (yearSel) yearSel.value = defYear;
  _populateSemesters('hmSem', defYear);
  const semSel = $('hmSem');
  if (semSel) semSel.value = defSem;

  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('hmDept', '');
  _fillCourses('hmDept', 'hmCourse');
  set('hmCourse', '');
  set('hmYearLevel', '');
  syncHmStatusButtons();
  syncHmMetricButtons();
  set('hmSort', 'desc');
  loadHeatmap();
});

// Clicking the chart itself also opens the table (same as the table icon).
$('hmChartArea')?.addEventListener('click', () => {
  if (hmData?.rows?.length) $('hmViewTable')?.click();
});

// Table icon opens the heatmap table as a floating modal (same as KPI).
initTableModal({
  openId: 'hmViewTable', modalId: 'hmTableModal', closeId: 'hmTableModalClose',
  onOpen: () => { if (hmData) renderHeatmapTable(hmData); },
});

$('hmTableDownloadCsv')?.addEventListener('click', () => {
  if (!hmData?.rows) return;
  const yls = hmData.year_levels || [];
  downloadCsv(hmData.rows.map(r => { const o={Label:r.label}; yls.forEach(y=>{o[y]=r[y]??0}); return o; }),
    ['Label',...yls], 'heatmap');
});

/* ══════════════════════════════════════════════════════════════════════════
   3. GENDER PIE
   Same pattern as KPI + Heatmap: filter popover (Academic Year / Semester /
   Dept / Course / Year Level, defaulting to the most recent upload), table
   icon → modal, reset icon, fullscreen. Male and Female each get one row:
   donut on the left, department table on the right, so they line up.
   ══════════════════════════════════════════════════════════════════════════ */
let gdData      = null;
let gdMetric    = 'all';        // all | DRP | INC | FAILED | UDR | NGA
let gdEnroll    = 'all';        // all | regular | irregular
let gdSortCol   = 'Total';
let gdSortDir   = 'desc';
let gdReqId     = 0;            // ignore out-of-order responses
let GDF = { year:'', sem:'', dept:'', course:'', yearlevel:'' };
let gdModalGender = null;       // null = both genders (icon button); 'Male' / 'Female' when opened from a chart click

const GD_STATUS_COLORS = {
  CONTINUING:'#16a34a', DRP:'#7c3aed', INC:'#d97706',
  FAILED:'#dc2626', W:'#059669', UDR:'#0284c7', NGA:'#9ca3af',
};
const GD_STATUS_NAMES = {
  CONTINUING:'Continuing', DRP:'Dropped', INC:'Incomplete', FAILED:'Failed',
  W:'Withdrawn', UDR:'Unofficial Drop', NGA:'No Grade',
};
const gdEsc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

// Statuses always included + selected metric
function gdActiveStatuses() {
  return gdMetric === 'all'
    ? ['CONTINUING','DRP','INC','FAILED','UDR','NGA']
    : ['CONTINUING', gdMetric];
}

/* ── Outside labels with leader lines ────────────────────────────────────────
   "Name" on the first line, "12.3% (1,234)" (percent + number of students) on the
   second. Labels sit in a column beside the donut and are pushed apart so small
   slices never overlap. */
const gdOutsideLabels = {
  id: 'gdOutsideLabels',
  afterDatasetsDraw(chart, _args, opts) {
    const items = opts?.items;
    if (!items?.length) return;
    const meta = chart.getDatasetMeta(0);
    const ctx  = chart.ctx;
    const fs   = opts.fontSize || 12;
    const lh   = fs + 3;
    const blockH = lh * 2, minGap = blockH + 4;
    const GAP = 12, COL = 22;
    const maxW = opts.textMaxW || 150;

    const pts = items.map((it, i) => {
      const arc = meta.data[i];
      if (!arc) return null;
      const { x, y, startAngle, endAngle, outerRadius: R } =
        arc.getProps(['x','y','startAngle','endAngle','outerRadius'], true);
      const mid = (startAngle + endAngle) / 2, cos = Math.cos(mid), sin = Math.sin(mid);
      const side = cos >= 0 ? 1 : -1;
      return { it, side,
        x0: x + cos * R,          y0: y + sin * R,
        x1: x + cos * (R + GAP),  y1: y + sin * (R + GAP),
        xe: x + side * (R + GAP + COL),
        ty: y + sin * (R + GAP) };
    }).filter(Boolean);

    // De-overlap each side (top → bottom, then bottom → top)
    [1, -1].forEach(side => {
      const g = pts.filter(p => p.side === side).sort((a, b) => a.ty - b.ty);
      const top = blockH / 2 + 2, bottom = chart.height - blockH / 2 - 2;
      g.forEach((p, k) => {
        p.ty = Math.max(p.ty, top);
        if (k && p.ty < g[k - 1].ty + minGap) p.ty = g[k - 1].ty + minGap;
      });
      for (let k = g.length - 1; k >= 0; k--) {
        const lim = k === g.length - 1 ? bottom : g[k + 1].ty - minGap;
        if (g[k].ty > lim) g[k].ty = lim;
      }
    });

    const fit = (text, w) => {
      if (ctx.measureText(text).width <= w) return text;
      let t = text;
      while (t.length > 1 && ctx.measureText(t + '…').width > w) t = t.slice(0, -1);
      return t + '…';
    };

    ctx.save();
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.textBaseline = 'middle';
    pts.forEach(p => {
      ctx.strokeStyle = p.it.color;
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y0);
      ctx.lineTo(p.x1, p.y1);
      ctx.lineTo(p.xe, p.ty);
      ctx.stroke();

      const tx = p.xe + p.side * 6;
      ctx.textAlign = p.side > 0 ? 'left' : 'right';
      ctx.font = `700 ${fs}px Inter, sans-serif`;
      ctx.fillStyle = '#374151';
      ctx.fillText(fit(p.it.name, maxW), tx, p.ty - lh / 2);
      ctx.fillStyle = '#111';
      ctx.fillText(`${p.it.pct.toFixed(1)}% (${p.it.count.toLocaleString()})`, tx, p.ty + lh / 2);   // numbers are never cut off
    });
    ctx.restore();
  },
};

/* ── Controls ────────────────────────────────────────────────────────────── */
// Status metric + enrollment type (outside the popover → apply immediately, like the heatmap toolbar)
qsa('[data-gd-metric]').forEach(btn => {
  btn.addEventListener('click', () => {
    qsa('[data-gd-metric]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    gdMetric = btn.dataset.gdMetric;
    loadGenderPie();
  });
});
qsa('[data-gd-enroll]').forEach(btn => {
  btn.addEventListener('click', () => {
    qsa('[data-gd-enroll]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    gdEnroll = btn.dataset.gdEnroll;
    loadGenderPie();
  });
});

// Sort order — header select, applies immediately
$('gdTableSort')?.addEventListener('change', () => {
  gdSortDir = $('gdTableSort').value || 'desc';
  if (gdData) _renderGender();
});

// Filter popover: dept → course cascade, year → semester cascade, Apply / Reset
$('gdDept')?.addEventListener('change', () => _fillCourses('gdDept', 'gdCourse'));
$('gdYear')?.addEventListener('change', () => _populateSemesters('gdSem', $('gdYear').value));

$('gdBtnApply')?.addEventListener('click', () => {
  GDF = {
    year:      $('gdYear')?.value      || '',
    sem:       $('gdSem')?.value       || '',
    dept:      $('gdDept')?.value      || '',
    course:    $('gdCourse')?.value    || '',
    yearlevel: $('gdYearLevel')?.value || '',
  };
  loadGenderPie();
});

$('gdBtnReset')?.addEventListener('click', () => {
  // "Default" = the most recently uploaded academic year + semester, All / All, descending.
  const defYear = window._kpiDefaultYear || '';
  const defSem  = window._kpiDefaultSem  || '';
  GDF = { year: defYear, sem: defSem, dept:'', course:'', yearlevel:'' };
  gdEnroll = 'all'; gdMetric = 'all'; gdSortCol = 'Total'; gdSortDir = 'desc';

  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('gdYear', defYear);
  _populateSemesters('gdSem', defYear);
  set('gdSem', defSem);
  set('gdDept', '');
  _fillCourses('gdDept', 'gdCourse');
  set('gdCourse', '');
  set('gdYearLevel', '');
  set('gdTableSort', 'desc');
  qsa('[data-gd-enroll]').forEach(b => b.classList.toggle('active', b.dataset.gdEnroll === 'all'));
  qsa('[data-gd-metric]').forEach(b => b.classList.toggle('active', b.dataset.gdMetric === 'all'));
  loadGenderPie();
});

/* ── Table view (modal) ──────────────────────────────────────────────────── */
// Both-genders view (opened via the header "view as table" icon) keeps the Gender column.
const GD_TABLE_HEADERS        = ['Gender','Department','Course','Status','Students','% of Gender'];
// Single-gender view (opened by clicking the Male or Female chart) drops the redundant Gender column.
const GD_TABLE_HEADERS_SINGLE = ['Department','Course','Status','Students','% of Gender'];

// Flat rows for the current status selection; % = share of that gender's students in the chart.
// genderFilter: null/undefined = both genders; 'Male' / 'Female' = just that gender's rows.
function gdFlatRows(genderFilter) {
  if (!gdData?.table_rows?.length) return [];
  const active = gdActiveStatuses();
  let rows = gdData.table_rows.filter(r => active.includes(r.Status));
  if (genderFilter) rows = rows.filter(r => r.Gender === genderFilter);
  const totals = {};
  rows.forEach(r => { totals[r.Gender] = (totals[r.Gender] || 0) + (r.Count || 0); });
  return rows.map(r => {
    const row = {};
    if (!genderFilter) row['Gender'] = r.Gender || '—';
    row['Department']  = r.Department || r.College || '—';
    row['Course']       = r.Course || '—';
    row['Status']       = GD_STATUS_NAMES[r.Status] || r.Status;
    row['Students']     = r.Count || 0;
    row['% of Gender']  = totals[r.Gender] ? (r.Count / totals[r.Gender] * 100).toFixed(1) + '%' : '—';
    return row;
  });
}
function renderGdTable() {
  const single  = gdModalGender;
  const headers = single ? GD_TABLE_HEADERS_SINGLE : GD_TABLE_HEADERS;
  const titleEl = $('gdTableModalTitle');
  if (titleEl) titleEl.textContent = single ? `${single} — Table View` : 'Gender & Status — Table View';
  buildTable('gdTableInner', gdFlatRows(single), headers, 'Students', 'desc', {
    filename: single ? `gender_status_${single.toLowerCase()}` : 'gender_status',
    title: single ? `${single} — Status Breakdown` : 'Gender & Status Breakdown',
    description: single
      ? `${single} students by department and status for the currently selected filters.`
      : 'Students by gender, department and status for the currently selected filters.',
  });
}
// Header icon always shows both genders together.
$('gdViewTable')?.addEventListener('click', () => { gdModalGender = null; });
const gdModal = initTableModal({
  openId: 'gdViewTable', modalId: 'gdTableModal', closeId: 'gdTableModalClose',
  onOpen: () => { if (gdData) renderGdTable(); },
});
$('gdTableDownloadCsv')?.addEventListener('click', () => {
  const rows    = gdFlatRows(gdModalGender);
  const headers = gdModalGender ? GD_TABLE_HEADERS_SINGLE : GD_TABLE_HEADERS;
  const fname   = gdModalGender ? `gender_status_${gdModalGender.toLowerCase()}` : 'gender_status';
  if (rows.length) downloadCsv(rows, headers, fname);
});

// Clicking a donut chart (like the heatmap) opens the table modal scoped to that gender only.
['Male', 'Female'].forEach(gender => {
  const wrap = $(`gender${gender}Canvas`)?.parentElement;
  wrap?.addEventListener('click', () => {
    const hasData = gender === 'Male' ? gdData?.male_pie?.labels?.length : gdData?.female_pie?.labels?.length;
    if (!hasData) return;
    gdModalGender = gender;
    gdModal.open?.();
  });
});

/* ── Load + render ───────────────────────────────────────────────────────── */
function _gdShowEmpty(msg) {
  const body = $('gdBody'), emp = $('gdEmpty');
  ['genderMaleCanvas','genderFemaleCanvas'].forEach(id => {
    _charts[id]?.destroy(); delete _charts[id];
    $(id)?.parentElement?.classList.remove('clickable');
  });
  body?.classList.add('hidden');
  if (emp) { emp.textContent = msg || 'No data for the selected filters.'; emp.classList.remove('hidden'); }
}

/* ══════════════════════════════════════════════════════════════════════════
   ACADEMIC PERFORMANCE CARD — Leaderboard + Radar
   ══════════════════════════════════════════════════════════════════════════ */
// HTML-escape helper (used by leaderboard row rendering)
function _perfEsc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
let perfData   = null;
let perfChart  = null;
let perfRank   = 'avg_gwa_score';
let perfMetric = 'rate';   // 'rate' | 'count'
let PF = { year:'', sem:'', dept:'', course:'', yearlevel:'' };

const PERF_AXES = [
  { key:'avg_gwa_score',  label:'GWA Score' },
  { key:'passing_rate',   label:'Passing Rate' },
  { key:'completion_rate',label:'Completion' },
  { key:'retention_rate', label:'Retention' },
  { key:'regular_ratio',  label:'Regular' },
];

// Official per-college colors — matches generate_report.py
const COLLEGE_COLORS = {
  'CAHS': '#36b9cc',
  'CBA':  '#e74a3b',
  'CCST': '#8a2be2',
  'CEA':  '#1cc88a',
  'COAS': '#5a5c69',
  'CTEC': '#4e73df',
};
const PERF_FALLBACK_COLORS = ['#4e73df','#1cc88a','#e74a3b','#36b9cc','#8a2be2','#5a5c69','#d97706','#800000'];

function _perfColor(label, idx) {
  const upper = (label || '').toUpperCase().trim();
  if (COLLEGE_COLORS[upper]) return COLLEGE_COLORS[upper];
  for (const [code, color] of Object.entries(COLLEGE_COLORS)) {
    if (upper.startsWith(code + '-') || upper.startsWith(code + ' ')) return color;
  }
  return PERF_FALLBACK_COLORS[idx % PERF_FALLBACK_COLORS.length];
}

function hexAlpha(hex, a) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

// Skeleton rows for the leaderboard — same grid classes as the real rows (styles: skeleton.css)
function perfSkeleton() {
  const area = $('perfListArea');
  if (!area) return;
  const n = Math.min(8, Math.max(3, perfData?.rows?.length || 6));     // about as many rows as last time
  const W = [88, 74, 66, 58, 50, 42, 36, 30];                          // falling bars, like a real ranking
  const head = `<div class="perf-head perf-sk-head" aria-hidden="true">
      <span class="sk-blk" style="width:14px"></span><span></span>
      <span class="sk-blk" style="width:64px"></span>
      <span class="sk-blk" style="width:96px"></span>
      <span class="sk-blk right" style="width:70px"></span>
      <span class="sk-blk right" style="width:86px"></span></div>`;
  let rows = '';
  for (let i = 0; i < n; i++) {
    rows += `<div class="perf-list-row perf-sk-row" aria-hidden="true">
      <span class="sk-blk sk-rank"></span><span class="sk-blk sk-dot"></span>
      <span class="sk-blk sk-name" style="width:${58 - (i % 3) * 9}%"></span>
      <span class="perf-bar-cell"><div class="perf-bar"><div class="perf-bar-fill sk-blk sk-fill" style="width:${W[i]}%"></div></div></span>
      <span class="sk-val"><span class="sk-blk"></span><span class="sk-blk"></span></span>
      <span class="sk-blk sk-pill"></span></div>`;
  }
  area.innerHTML = head + `<div class="perf-list">${rows}</div>` +
    `<div class="perf-legend perf-sk-legend" aria-hidden="true">${'<span class="sk-blk"></span>'.repeat(4)}</div>`;
}

async function loadPerformance() {
  const p = new URLSearchParams();
  if (PF.year)      p.set('year', PF.year);
  if (PF.sem)       p.set('sem', PF.sem);
  if (PF.dept)      p.set('dept', PF.dept);
  if (PF.course)    p.set('course', PF.course);
  if (PF.yearlevel) p.set('yearlevel', PF.yearlevel);
  p.set('rank_by', perfRank);
  { const c = cmpOf('perfCompare'); if (c) p.set('compare', c); }

  const back = $('perfBackBtn');
  if (back) {
    back.classList.toggle('hidden', !(PF.dept || PF.course));
    back.textContent = PF.course ? `← Back to ${PF.dept || 'college'}` : '← All colleges';
  }
  perfSkeleton();
  if (perfChart) { perfChart.destroy(); perfChart = null; }
  const ra = $('perfRadarArea');
  if (ra) ra.innerHTML = '<canvas id="perfRadarCanvas"></canvas>';

  // Update subtitle
  const sub = $('perfSubtitle');
  if (sub) sub.textContent = PF.course
    ? `${PF.course} in ${PF.dept || 'its college'} — click the course again to go back to the college`
    : PF.dept
      ? `Course programs in ${PF.dept} — click a course to see only that course on the radar`
      : 'College rankings across five performance metrics — click a college to drill into its course programs';

  try {
    const res = await fetch('/api/dash/performance?' + p.toString());
    if (!res.ok) throw new Error('performance ' + res.status);
    perfData = await res.json();
    if (perfData.note || !perfData.rows?.length) {
      empty('perfListArea', perfData.note || 'No data for the selected filters.');
      return;
    }
    renderPerfLeaderboard(perfData);
    renderPerfRadar(perfData);
  } catch(e) {
    console.error('loadPerformance error:', e);
    empty('perfListArea');
    perfData = null;
  }
}

// ── Leaderboard helpers ─────────────────────────────────────
let perfSort = { key: 'value', dir: 'desc' };      // key: 'value' | 'label' | 'delta'

const PERF_RANK_LABEL = {
  avg_gwa_score: 'GWA Score', passing_rate: 'Passing Rate', completion_rate: 'Completion',
  retention_rate: 'Retention', regular_ratio: 'Regular',
};
const PERF_COUNT_KEY = {
  avg_gwa_score:   'avg_gwa',
  passing_rate:    'passing_count',
  completion_rate: 'completion_count',
  retention_rate:  'retention_count',
  regular_ratio:   'regular_count',
};
// How much of the population qualifies -> colour of the bar / number / pill
const PERF_TIERS = [
  { min: 85, color: '#16a34a', name: 'Excellent' },
  { min: 70, color: '#65a30d', name: 'Good'      },
  { min: 50, color: '#d97706', name: 'Fair'      },
  { min: 0,  color: '#dc2626', name: 'Low'       },
];
function _perfTier(pct) {
  if (pct == null || isNaN(pct)) return { color: '#9ca3af', name: '—' };
  return PERF_TIERS.find(t => pct >= t.min) || PERF_TIERS[PERF_TIERS.length - 1];
}
// Change vs previous semester (percentage points; every metric here is "higher = better")
function _perfDeltaVal(row, rankKey) {
  const c = row?.[rankKey], p = row?.prev?.[rankKey];
  return (c == null || p == null) ? null : c - p;
}
function _perfDeltaHtml(row, rankKey, data) {
  if (!data.has_prev) {
    return `<span class="perf-delta none" title="No earlier semester on record for these filters">—</span>`;
  }
  const d = _perfDeltaVal(row, rankKey);
  if (d == null) {
    return `<span class="perf-delta none" title="This row has no data in ${_perfEsc(data.prev_period || 'the previous period')}">—</span>`;
  }
  const cur = row[rankKey], prev = row.prev[rankKey];
  let title = `${data.prev_period || 'Previous'}: ${prev.toFixed(1)}% → ${cur.toFixed(1)}% now`;
  if (rankKey === 'avg_gwa_score' && row.avg_gwa != null && row.prev.avg_gwa != null) {
    title += `  (GWA ${row.prev.avg_gwa.toFixed(2)} → ${row.avg_gwa.toFixed(2)})`;
  }
  const n = row[PERF_COUNT_KEY[rankKey]], pn = row.prev[PERF_COUNT_KEY[rankKey]];
  if (rankKey !== 'avg_gwa_score' && n != null && pn != null) {
    title += `  · students ${pn.toLocaleString()} → ${n.toLocaleString()}`;
  }
  const abs = Math.abs(d).toFixed(1);
  if (d >= 0.05)  return `<span class="perf-delta up"   title="${_perfEsc(title)}">▲ ${abs} pts</span>`;
  if (d <= -0.05) return `<span class="perf-delta down" title="${_perfEsc(title)}">▼ ${abs} pts</span>`;
  return `<span class="perf-delta flat" title="${_perfEsc(title)}">▬ 0.0 pts</span>`;
}

function _perfSortedRows(data) {
  const rankKey = data.rank_by || perfRank;
  const rows = data.rows.map((row, i) => ({ row, rank: i + 1 }));   // rank = true position by the ranked metric
  const dir = perfSort.dir === 'asc' ? 1 : -1;
  const val = o => perfSort.key === 'label' ? String(o.row.label).toLowerCase()
                 : perfSort.key === 'delta' ? _perfDeltaVal(o.row, rankKey)
                 : o.row[rankKey];
  rows.sort((x, y) => {
    const vx = val(x), vy = val(y);
    if (vx == null && vy == null) return x.rank - y.rank;
    if (vx == null) return 1;                       // missing values always last
    if (vy == null) return -1;
    if (typeof vx === 'string') return dir * vx.localeCompare(vy, undefined, { numeric: true });
    return (vx - vy) * dir || (x.rank - y.rank);
  });
  return rows;
}

function syncPerfSort() {
  const sel = $('perfSort');
  if (sel) sel.value = perfSort.dir;
}

function renderPerfLeaderboard(data) {
  const area = $('perfListArea');
  if (!area) return;
  const isCount  = perfMetric === 'count';
  const rankKey  = data.rank_by || perfRank;
  const drillable = true;                                   // college row -> its courses; course row -> that course only
  const selCourse = data.course || '';

  function cells(row) {
    const pct = row[rankKey];
    // Percentage mode: big number, bar = the rate itself.
    if (!isCount) {
      const t = _perfTier(pct);
      return {
        tone: t.color, barPct: pct ?? 0, tip: `${row.label}: ${pct != null ? pct.toFixed(1) + '%' : 'no data'} (${t.name})`,
        value: `<span class="perf-value">${pct != null ? pct.toFixed(1) + '%' : '—'}</span>`,
      };
    }
    // Count mode: "X of Y students" coloured by the share of the population.
    if (rankKey === 'avg_gwa_score') {                       // GWA has no head-count: show the average + its 0-100 score
      const t = _perfTier(pct);
      return {
        tone: t.color, barPct: pct ?? 0, tip: `${row.label}: average GWA ${row.avg_gwa != null ? row.avg_gwa.toFixed(2) : '—'} (score ${pct != null ? pct.toFixed(1) : '—'}%)`,
        value: `<div class="perf-count">
                  <span class="perf-count-line">Avg GWA <span class="perf-count-n">${row.avg_gwa != null ? row.avg_gwa.toFixed(2) : '—'}</span></span>
                  <span class="perf-pill">${pct != null ? pct.toFixed(1) + '%' : '—'} · ${t.name}</span>
                </div>`,
      };
    }
    const n = row[PERF_COUNT_KEY[rankKey]], total = row.enrollment;
    if (n == null || !total) {
      const t = _perfTier(pct);
      return { tone: t.color, barPct: pct ?? 0, tip: row.label, value: `<span class="perf-value">${pct != null ? pct.toFixed(1) + '%' : '—'}</span>` };
    }
    const share = n / total * 100, t = _perfTier(share);
    return {
      tone: t.color, barPct: share,
      tip: `${n.toLocaleString()} of ${total.toLocaleString()} students (${share.toFixed(1)}%) — ${t.name}`,
      value: `<div class="perf-count">
                <span class="perf-count-line"><span class="perf-count-n">${n.toLocaleString()}</span> of ${total.toLocaleString()}</span>
                <span class="perf-pill">${share.toFixed(1)}% · ${t.name}</span>
              </div>`,
    };
  }

  // sortable column headers
  const arrow = k => perfSort.key === k ? (perfSort.dir === 'asc' ? '▲' : '▼') : '↕';
  const hb = (k, text, extra = '') =>
    `<button type="button" class="perf-head-btn ${extra} ${perfSort.key === k ? 'is-sorted' : ''}" data-perf-sort="${k}" title="Sort by ${text}">${text}<span class="perf-arrow">${arrow(k)}</span></button>`;
  let html = `<div class="perf-head">
      ${hb('value', '#')}<span></span>
      ${hb('label', data.view === 'course' ? 'Course' : 'College')}
      <span class="perf-head-static">${isCount ? 'Share of students' : PERF_RANK_LABEL[rankKey] || ''}</span>
      ${hb('value', isCount ? 'Students' : (PERF_RANK_LABEL[rankKey] || 'Value'), 'right')}
      ${hb('delta', 'vs prev sem', 'right')}
    </div><div class="perf-list">`;

  _perfSortedRows(data).forEach(({ row, rank }, idx) => {
    const color = _perfColor(row.label, rank - 1);
    const c = cells(row);
    const lowBadge = row.low_n
      ? `<span class="perf-low-n" title="Fewer than 30 students — results may not be representative">low n</span>` : '';
    const chevron = data.view === 'course' ? '' : `<span class="perf-chevron" aria-hidden="true">›</span>`;
    const isCourseView = data.view === 'course';
    const clickAttrs = `tabindex="0" role="button" aria-label="${isCourseView ? 'Show only ' + _perfEsc(row.label) + ' on the radar' : 'Show course programs of ' + _perfEsc(row.label)}"`;
    html += `
      <div class="perf-list-row is-clickable ${rank <= 3 ? 'is-top' : ''} ${selCourse && row.label === selCourse ? 'is-selected' : ''}" ${clickAttrs}
           data-label="${_perfEsc(row.label)}" title="${_perfEsc(c.tip)}${isCourseView ? (row.label === selCourse ? ' — click to show the whole college again' : ' — click to show only this course on the radar') : ' — click to drill into its courses'}"
           style="--perf-color:${color};--tone:${c.tone}">
        <span class="perf-rank">${rank}</span>
        <span class="perf-color-dot" data-shape="${(rank - 1) % 6}" style="background:${color}"></span>
        <span class="perf-name"><span class="perf-label" title="${_perfEsc(row.label)}">${_perfEsc(courseShort(row.label))}</span>${lowBadge}${chevron}</span>
        <span class="perf-bar-cell"><div class="perf-bar"><div class="perf-bar-fill" style="width:${Math.max(0, Math.min(100, c.barPct)).toFixed(1)}%"></div></div></span>
        ${c.value}
        ${_perfDeltaHtml(row, rankKey, data)}
      </div>`;
  });
  html += '</div>';
  html += `<div class="perf-legend">${PERF_TIERS.map((t, i) => {
    const hi = i === 0 ? '100' : (PERF_TIERS[i - 1].min - 0.1).toFixed(1).replace('.0', '');
    return `<span style="--c:${t.color}">${t.name} (${t.min}${i === 0 ? '%+' : '–' + hi + '%'})</span>`;
  }).join('')}${data.has_prev ? `<span style="--c:#9ca3af">Change compared with ${_perfEsc(data.prev_period || 'previous semester')}</span>` : ''}</div>`;
  area.innerHTML = html;

  // column-header sorting
  area.querySelectorAll('[data-perf-sort]').forEach(btn => {
    btn.addEventListener('click', () => {
      const k = btn.dataset.perfSort;
      perfSort = (perfSort.key === k)
        ? { key: k, dir: perfSort.dir === 'asc' ? 'desc' : 'asc' }
        : { key: k, dir: k === 'label' ? 'asc' : 'desc' };
      syncPerfSort();
      renderPerfLeaderboard(perfData);
    });
  });

  // row hover (radar highlight) + click / Enter to drill into a college's course programs
  area.querySelectorAll('.perf-list-row').forEach(row => {
    row.addEventListener('mouseenter', () => highlightPerf(row.dataset.label));
    row.addEventListener('mouseleave', () => highlightPerf(null));
    const go = () => data.view === 'course' ? perfPickCourse(row.dataset.label) : perfDrill(row.dataset.label);
    row.addEventListener('click', go);
    row.addEventListener('keydown', e => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
    });
  });
}

// Click a college -> same card, now ranking that college's courses
function perfDrill(label) {
  if (!label) return;
  PF.dept = label; PF.course = '';
  const sel = $('perfDept');
  if (sel) {
    if (![...sel.options].some(o => o.value === label)) sel.add(new Option(label, label));
    sel.value = label;
  }
  _fillCourses('perfDept', 'perfCourse');
  loadPerformance();
}

// Click a course -> radar shows only that course; click it again -> back to the whole college
function perfPickCourse(label) {
  PF.course = (PF.course === label) ? '' : label;
  const sel = $('perfCourse');
  if (sel) {
    if (PF.course && ![...sel.options].some(o => o.value === PF.course)) sel.add(new Option(PF.course, PF.course));
    sel.value = PF.course;
  }
  loadPerformance();
}

function renderPerfTable(data) {
  if (!data?.rows?.length) return;
  const isCount = perfMetric === 'count';
  const headers = ['College / Course', 'Enrolled', 'GWA', 'Passing', 'Completion', 'Retention', 'Regular'];
  const rows = data.rows.map(r => {
    function fmtCell(rateKey, countKey) {
      const pct = r[rateKey];
      const pctStr = pct != null ? pct.toFixed(1) + '%' : '—';
      if (!isCount) return pctStr;
      const n = r[countKey];
      return n != null ? `${n.toLocaleString()} of ${r.enrollment?.toLocaleString() ?? '?'} (${pctStr})` : pctStr;
    }
    return {
      'College / Course': r.label,
      'Enrolled':    r.enrollment?.toLocaleString() ?? '—',
      'GWA':         r.avg_gwa != null ? r.avg_gwa.toFixed(2) : '—',
      'Passing':     fmtCell('passing_rate',   'passing_count'),
      'Completion':  fmtCell('completion_rate','completion_count'),
      'Retention':   fmtCell('retention_rate', 'retention_count'),
      'Regular':     fmtCell('regular_ratio',  'regular_count'),
    };
  });
  buildTable('perfTableInner', rows, headers, 'GWA', 'asc', {
    filename: 'academic_performance',
    title: 'Academic Performance — Table View',
  });
}

function highlightPerf(label) {
  // Highlight leaderboard row
  document.querySelectorAll('.perf-list-row').forEach(r =>
    r.classList.toggle('perf-list-row--active', r.dataset.label === label));
  if (!perfChart) return;
  // The radar only holds one polygon; hovering some other row must not dim it
  if (label !== null && !perfChart.data.datasets.some(ds => (ds._full ?? ds.label) === label)) return;
  // Highlight radar polygon
  perfChart.data.datasets.forEach(ds => {
    const isAvg   = !!ds._isAvg;
    const isMatch = (ds._full ?? ds.label) === label;
    if (label === null) {
      ds.borderWidth      = isAvg ? 2 : 1.5;
      ds.borderDash       = isAvg ? [6,4] : (ds._dash || []);
      ds.pointRadius      = isAvg ? 0 : 3;
      ds.backgroundColor  = isAvg ? 'rgba(0,0,0,0.04)' : hexAlpha(ds.borderColor, 0.12);
    } else {
      ds.borderWidth      = isMatch ? 3 : (isAvg ? 1.5 : 1);
      ds.borderDash       = isAvg ? [6,4] : (ds._dash || []);
      ds.pointRadius      = isMatch ? 5 : (isAvg ? 0 : 2);
      ds.backgroundColor  = isMatch
        ? hexAlpha(ds.borderColor, 0.22)
        : (isAvg ? 'rgba(0,0,0,0.02)' : hexAlpha(ds.borderColor, 0.04));
    }
  });
  perfChart.update('none');
}

function renderPerfRadar(data) {
  const canvas = $('perfRadarCanvas');
  if (!canvas || !data?.rows?.length) return;

  // ONE polygon only: campus average (all colleges) / the selected college / the selected course
  const scope = data.radar_scope || 'campus';
  const rRows = data.radar || (data.average ? [data.average] : []);
  const cap = $('perfRadarCaption');
  if (cap) {
    const r0 = rRows[0];
    cap.innerHTML = !r0 ? '' :
      scope === 'course'  ? `<b title="${_perfEsc(r0.label)}">${_perfEsc(courseShort(r0.label))}</b> · course · ${(r0.enrollment ?? 0).toLocaleString()} students`
    : scope === 'college' ? `<b>${_perfEsc(r0.label)}</b> · whole college · ${(r0.enrollment ?? 0).toLocaleString()} students`
    :                       `<b>Campus average</b> · all colleges · ${(r0.enrollment ?? 0).toLocaleString()} students`;
  }
  const datasets = rRows.map(row => {
    let color, i;
    if (scope === 'course') {
      i = Math.max(0, data.rows.findIndex(r => r.label === row.label));     // same colour + shape as its leaderboard row
      color = _perfColor(row.label, i);
    } else if (scope === 'college') {
      i = Math.max(0, data.rows.findIndex(r => r.label === row.label));
      color = _perfColor(row.label, i);
    } else {
      i = 0; color = CB.on ? '#000000' : '#7B1113';                                              // campus average: theme maroon
    }
    return {
      label:            courseShort(row.label),
      _full:            row.label,
      data:             PERF_AXES.map(a => row[a.key] ?? 0),
      borderColor:      color,
      backgroundColor:  hexAlpha(color, 0.22),
      borderWidth:      2.5,
      borderDash:       CB.on ? CB_DASHES[i % CB_DASHES.length] : [],
      pointRadius:      CB.on ? 5 : 4,
      pointStyle:       CB.on ? CB_SHAPES[i % CB_SHAPES.length] : 'circle',
      pointBackgroundColor: color,
      pointHoverRadius: 6,
      _isAvg:           false,
      _dash:            CB.on ? CB_DASHES[i % CB_DASHES.length] : [],
    };
  });

  const fsz = $('perfCard')?.classList.contains('is-fullscreen') ? 14 : 11;   // canvas text can't follow CSS
  if (perfChart) { perfChart.destroy(); perfChart = null; }
  perfChart = new Chart(canvas, {
    type: 'radar',
    data: { labels: PERF_AXES.map(a => a.label), datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,          // fills its box (taller in fullscreen)
      animation: { duration: 300 },
      plugins: {
        legend: {
          display: true,
          position: 'top',
          align: 'start',
          rtl: false,
          labels: {
            boxWidth: 10, boxHeight: 10,
            font: { size: fsz },
            padding: 8,
            color: '#374151',
            usePointStyle: true,
            pointStyle: 'circle',
          },
        },
        tooltip: {
          callbacks: {
            label(ctx) {
              return ` ${ctx.dataset.label}: ${ctx.parsed.r?.toFixed(1) ?? '—'}%`;
            },
          },
        },
      },
      scales: {
        r: {
          // Start at 50 so differences are visible when all colleges cluster high
          min: 50, max: 100,
          ticks: {
            stepSize: 10,
            font: { size: fsz - 2 },
            color: '#9ca3af',
            backdropColor: 'transparent',
            callback: v => v + '%',
          },
          grid:        { color: 'rgba(0,0,0,0.07)' },
          angleLines:  { color: 'rgba(0,0,0,0.12)' },
          pointLabels: {
            font: { size: fsz, weight: '600' },
            color: '#374151',
            padding: 8,
          },
        },
      },
    },
  });
}

// ── Rank-by metric buttons ──────────────────────────────────
function syncPerfRankBtns() {
  qsa('[data-perf-rank]').forEach(b => b.classList.toggle('active', b.dataset.perfRank === perfRank));
}
qsa('[data-perf-rank]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (perfRank === btn.dataset.perfRank) return;
    perfRank = btn.dataset.perfRank;
    syncPerfRankBtns();
    loadPerformance();
  });
});

// ── Show: Percentage / No. of Students ──────────────────────
function syncPerfMetricBtns() {
  qsa('[data-perf-metric]').forEach(b => b.classList.toggle('active', b.dataset.perfMetric === perfMetric));
}
qsa('[data-perf-metric]').forEach(btn => {
  btn.addEventListener('click', () => {
    if (perfMetric === btn.dataset.perfMetric) return;
    perfMetric = btn.dataset.perfMetric;
    syncPerfMetricBtns();
    // Re-render with existing data — no need to reload from server
    if (perfData) {
      renderPerfLeaderboard(perfData);
      highlightPerf(null);
    }
  });
});

// ── Sort order (Descending / Ascending) ─────────────────────
$('perfSort')?.addEventListener('change', () => {
  perfSort.dir = $('perfSort').value === 'asc' ? 'asc' : 'desc';
  if (perfData?.rows?.length) renderPerfLeaderboard(perfData);
});

// ── Back to all colleges (after drilling into one) ──────────
$('perfBackBtn')?.addEventListener('click', () => {
  if (PF.course) {                                   // course -> its college
    PF.course = '';
    const cs = $('perfCourse'); if (cs) cs.value = '';
  } else {                                           // college -> all colleges
    PF.dept = '';
    const sel = $('perfDept'); if (sel) sel.value = '';
    _fillCourses('perfDept', 'perfCourse');
  }
  loadPerformance();
});

// Radar text is drawn on the canvas, so redraw it when the card enters / leaves fullscreen.
(function watchPerfFullscreen() {
  const card = $('perfCard');
  if (!card || typeof MutationObserver === 'undefined') return;
  let last = card.classList.contains('is-fullscreen');
  new MutationObserver(() => {
    const now = card.classList.contains('is-fullscreen');
    if (now === last) return;
    last = now;
    requestAnimationFrame(() => { if (perfData?.rows?.length && $('perfRadarCanvas')) renderPerfRadar(perfData); });
  }).observe(card, { attributes: true, attributeFilter: ['class'] });
})();

// ── Filter popover wiring ────────────────────────────────────
$('perfDept')?.addEventListener('change', () => _fillCourses('perfDept', 'perfCourse'));
$('perfYear')?.addEventListener('change', () => _populateSemesters('perfSem', $('perfYear').value));

$('perfBtnApply')?.addEventListener('click', () => {
  PF = {
    year:      $('perfYear')?.value      || '',
    sem:       $('perfSem')?.value       || '',
    dept:      $('perfDept')?.value      || '',
    course:    $('perfCourse')?.value    || '',
    yearlevel: $('perfYearLevel')?.value || '',
  };
  loadPerformance();
});

$('perfViewTable')?.addEventListener('click', () => {
  if (!perfData?.rows?.length) return;
  renderPerfTable(perfData);
  $('perfTableModal')?.classList.remove('hidden');
});
$('perfTableModalClose')?.addEventListener('click', () => $('perfTableModal')?.classList.add('hidden'));
$('perfTableDownloadCsv')?.addEventListener('click', () => {
  const btn = document.querySelector('#perfTableInner [data-download-csv]');
  btn?.click();
});

$('perfBtnReset')?.addEventListener('click', () => {
  const defYear = window._kpiDefaultYear || '';
  const defSem  = window._kpiDefaultSem  || '';
  PF = { year: defYear, sem: defSem, dept:'', course:'', yearlevel:'' };
  perfRank   = 'avg_gwa_score';
  perfMetric = 'rate';
  perfSort   = { key: 'value', dir: 'desc' };
  syncPerfSort();

  const set = (id, v) => { const el=$(id); if (el) el.value = v; };
  set('perfYear', defYear);
  _populateSemesters('perfSem', defYear);
  set('perfSem', defSem);
  set('perfDept', '');
  _fillCourses('perfDept', 'perfCourse');
  set('perfCourse', '');
  set('perfYearLevel', '');
  syncPerfRankBtns();
  syncPerfMetricBtns();
  loadPerformance();
});

async function loadGenderPie() {
  const reqId = ++gdReqId;
  const p = new URLSearchParams();
  Object.entries(GDF).forEach(([k, v]) => { if (v) p.set(k, v); });
  if (gdEnroll !== 'all') p.set('enroll_type', gdEnroll);
  if (gdMetric !== 'all') p.set('status', gdMetric);
  { const c = cmpOf('gdCompare'); if (c) p.set('compare', c); }
  $('gdBody')?.classList.add('gd-busy');
  try {
    const res = await fetch('/api/dash/gender-status?' + p.toString());
    if (!res.ok) throw new Error('gender ' + res.status);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    if (reqId !== gdReqId) return;
    gdData = json;
    _renderGender();
  } catch (e) {
    if (reqId !== gdReqId) return;
    console.error('Gender:', e);
    gdData = null;
    _gdShowEmpty('Could not load the gender breakdown.');
  } finally {
    if (reqId === gdReqId) $('gdBody')?.classList.remove('gd-busy');
  }
}

function _renderGender() {
  if (!gdData) return;
  const active   = gdActiveStatuses();
  const hasMale  = !!gdData.male_pie?.labels?.length;
  const hasFem   = !!gdData.female_pie?.labels?.length;
  if (!hasMale && !hasFem) { _gdShowEmpty(); return; }

  $('gdEmpty')?.classList.add('hidden');
  $('gdBody')?.classList.remove('hidden');

  // Old backend / dataset without Academic_Year + Semester columns → the period filter can't apply.
  const note = $('gdNotice');
  if (note) {
    let msg = '';
    if (gdData.basis === 'ds03') {
      msg = '⚠ DS01 has no Gender column, so this is falling back to DS03 status records. These are not unique students ' +
            'and can exceed total enrollment' + ((GDF.year || GDF.sem) && gdData.period_supported === false
            ? ', and the period filter is not applied.' : '.');
    }
    note.classList.toggle('hidden', !msg);
    note.innerHTML = msg;
  }

  _renderDonut('genderMaleCanvas',   'genderMaleCenter',   gdData.male_pie,   active, 'Male');
  _renderDonut('genderFemaleCanvas', 'genderFemaleCenter', gdData.female_pie, active, 'Female');
  _renderSimpleTable('gdMaleTable',   gdData.table_rows, 'Male',   active);
  _renderSimpleTable('gdFemaleTable', gdData.table_rows, 'Female', active);

  if (!$('gdTableModal')?.classList.contains('hidden')) renderGdTable();
}

function _renderDonut(canvasId, centerId, pie, activeStatuses, genderLabel) {
  const cEl    = $(centerId);
  const canvas = $(canvasId);
  const wrap   = canvas?.parentElement;

  // Only the active statuses
  const filtered = (pie?.labels || []).reduce((acc, lbl, i) => {
    if (activeStatuses.includes(lbl)) {
      acc.codes.push(lbl);
      acc.values.push(pie.values[i]);
      acc.colors.push((CB.on ? GD_STATUS_COLORS[lbl] : pie.colors?.[i]) || GD_STATUS_COLORS[lbl] || pie.colors?.[i] || '#9ca3af');
    }
    return acc;
  }, { codes:[], values:[], colors:[] });

  if (!filtered.codes.length) {
    _charts[canvasId]?.destroy(); delete _charts[canvasId];
    if (cEl) cEl.innerHTML = `<span class="gd-nodata">No ${genderLabel.toLowerCase()} data<br>for these filters</span>`;
    wrap?.classList.remove('clickable');   // no click-to-table hint while empty
    return;
  }
  wrap?.classList.add('clickable');   // show the "Click to view as table" hint

  const total = filtered.values.reduce((s, v) => s + v, 0) || 1;
  const names = filtered.codes.map(c => GD_STATUS_NAMES[c] || c);
  const items = filtered.codes.map((c, i) => ({
    name: names[i], color: filtered.colors[i],
    count: filtered.values[i], pct: filtered.values[i] / total * 100,
  }));

  // Room for the labels. The number line ("77.1% (30,123)") must never be cut off, so it decides
  // the side padding; the status name is shortened with "…" only if it is wider than that.
  const fullscreen = $('genderCard')?.classList.contains('is-fullscreen');
  const wrapW  = wrap?.clientWidth || 520;
  const m = document.createElement('canvas').getContext('2d');
  const numText = it => `${it.pct.toFixed(1)}% (${it.count.toLocaleString()})`;
  const compact = wrapW < 480;                        // phones: no outside labels, legend below instead
  const maxSide = (wrapW - 170) / 2;                 // keep at least ~170px for the donut itself
  let fs = fullscreen ? 14 : 12, numW = 0;
  for (; fs >= 10; fs--) {
    m.font = `700 ${fs}px Inter, sans-serif`;
    numW = Math.max(...items.map(it => m.measureText(numText(it)).width));
    if (numW + 34 <= maxSide) break;
  }
  m.font = `700 ${fs}px Inter, sans-serif`;
  const nameW  = Math.max(...items.map(it => m.measureText(it.name).width));
  const textW  = Math.max(numW, Math.min(nameW, Math.max(numW, 120)));
  const padX   = compact ? 8 : Math.round(textW + 34);
  const padY   = compact ? 8 : fs * 3;

  makeChart(canvasId, {
    type: 'doughnut',
    data: {
      labels: names,
      datasets: [{
        data: filtered.values,
        backgroundColor: filtered.colors,
        borderWidth: 3, borderColor: '#fff',
        hoverOffset: 6,
      }],
    },
    options: {
      cutout: '58%',
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { left: padX, right: padX, top: padY, bottom: padY } },
      plugins: {
        legend: compact ? {
          display: true, position: 'top',
          labels: { boxWidth: 10, font: { size: 11 }, padding: 10,
            generateLabels: () => items.map((it, i) => ({
              text: `${it.name} — ${it.pct.toFixed(1)}% (${it.count.toLocaleString()})`,
              fillStyle: it.color, strokeStyle: it.color, lineWidth: 0, index: i })) },
          onClick: () => {},
        } : { display: false },
        datalabels: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.raw.toLocaleString()} students (${(ctx.raw / total * 100).toFixed(1)}%)`,
          },
        },
        gdOutsideLabels: { items: compact ? [] : items, fontSize: fs, textMaxW: textW },
      },
    },
    plugins: [gdOutsideLabels],
  });

  if (cEl) cEl.innerHTML = `<strong>${total.toLocaleString()}</strong>${genderLabel} students`;
  // compact (phone) donuts have the legend underneath: centre the label on the ring, not on ring + legend
  if (cEl) {
    const ch = _charts[canvasId];
    cEl.style.inset = compact && ch?.legend ? `0 0 ${Math.round(ch.legend.height) + 8}px 0` : '';
  }
}

function _renderSimpleTable(containerId, rows, gender, activeStatuses) {
  const wrap = $(containerId);
  if (!wrap) return;
  if (!rows?.length) { wrap.innerHTML = '<div class="chart-empty">No data.</div>'; return; }

  // Rows for this gender and the active statuses
  const gRows = rows.filter(r =>
    (!r.Gender || r.Gender === gender) &&
    activeStatuses.includes(r.Status)
  );
  if (!gRows.length) { wrap.innerHTML = '<div class="chart-empty">No data.</div>'; return; }

  // Pivot: dept → status counts
  const statuses = activeStatuses.filter(s => gRows.some(r => r.Status === s));
  const deptMap  = {};
  let grandTotal = 0;
  gRows.forEach(r => {
    const d = r.Group || r.Department || r.College || '—';
    if (!deptMap[d]) deptMap[d] = { dept: d, totals: {}, total: 0 };
    const c = r.Count || 0;
    deptMap[d].totals[r.Status] = (deptMap[d].totals[r.Status] || 0) + c;
    deptMap[d].total += c;
    grandTotal += c;
  });
  grandTotal = grandTotal || 1;

  const pivotRows = Object.values(deptMap);
  const keyOf = row => gdSortCol === 'Department' ? row.dept
                     : gdSortCol === 'Total'      ? row.total
                     : (row.totals[gdSortCol] || 0);
  pivotRows.sort((a, b) => {
    const sa = keyOf(a), sb = keyOf(b);
    const cmp = typeof sa === 'string' ? sa.localeCompare(sb) : sa - sb;
    return gdSortDir === 'asc' ? cmp : -cmp;
  });

  const thSort = (col, lbl, dot) => {
    const arrow = gdSortCol === col ? (gdSortDir === 'asc' ? '↑' : '↓') : '';
    return `<th data-col="${col}">${dot ? `<i class="gd-th-dot" style="background:${dot}"></i>` : ''}${lbl}` +
           `${arrow ? `<span class="sort-arrow">${arrow}</span>` : ''}</th>`;
  };

  let html = `<table class="gd-table"><thead><tr>
    ${thSort('Department', gdData?.group_label || 'Department')}
    ${statuses.map(st => thSort(st, st === 'CONTINUING' ? 'Cont.' : st, GD_STATUS_COLORS[st])).join('')}
    ${thSort('Total', 'Total')}
  </tr></thead><tbody>`;

  pivotRows.forEach(row => {
    html += `<tr><td class="gd-dept" title="${gdEsc(row.dept)}">${gdEsc(courseShort(row.dept))}</td>`;
    statuses.forEach(st => {
      const cnt = row.totals[st] || 0;
      html += `<td><span class="gd-count">${cnt.toLocaleString()}</span> ` +
              `<span class="gd-pct">${(cnt / grandTotal * 100).toFixed(1)}%</span></td>`;
    });
    html += `<td><span class="gd-count">${row.total.toLocaleString()}</span> ` +
            `<span class="gd-pct">${(row.total / grandTotal * 100).toFixed(1)}%</span></td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;

  // Sort on header click (same column toggles direction, new column starts descending)
  wrap.querySelectorAll('th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (gdSortCol === col) gdSortDir = gdSortDir === 'desc' ? 'asc' : 'desc';
      else { gdSortCol = col; gdSortDir = 'desc'; }
      const sel = $('gdTableSort'); if (sel) sel.value = gdSortDir;
      if (gdData) _renderGender();
    });
  });
}

// Labels are drawn on the canvas, so re-draw when the card changes width
// (window resize, sidebar, fullscreen expand / collapse).
(function watchGenderCard() {
  const card = $('genderCard');
  if (!card || typeof ResizeObserver === 'undefined') return;
  const keyOf = () => card.clientWidth + '|' + card.classList.contains('is-fullscreen');
  let lastKey = keyOf(), timer = null;
  new ResizeObserver(() => {
    if (keyOf() === lastKey) return;
    clearTimeout(timer);
    timer = setTimeout(() => { lastKey = keyOf(); if (gdData) _renderGender(); }, 150);
  }).observe(card);
})();

/* ══════════════════════════════════════════════════════════════════════════
   4. HARDEST SUBJECTS
   Same pattern as KPI / Heatmap / Gender: filter popover (Academic Year, Semester,
   Dept, Course, Year Level, Subject — defaulting to the most recent upload), table
   icon → modal, reset icon, fullscreen that fits the screen, and a glossary.
   ══════════════════════════════════════════════════════════════════════════ */
let hsMetric  = 'avg_grade';
let hsView    = 'bar';
let hsData    = null;
let hsSortDir = 'desc';
let hsReqId   = 0;
let HSF = { year:'', sem:'', dept:'', course:'', yearlevel:'', subject:'' };
let hsModalSubjectCode = null;  // null = every subject (icon button); a subject's code when opened from its bar

const hsMetricLabel = m => m === 'avg_grade' ? 'Avg Grade (1.00-5.00)' : `${m} Count`;
const hsFmt = (v, m = hsMetric) => v == null ? '—'
  : m === 'avg_grade' ? Number(v).toFixed(2)
  : Math.round(v).toLocaleString();
const hsIsFullscreen = () => !!$('hardestCard')?.classList.contains('is-fullscreen');
const hsAreaFor = v => v === 'cards' ? 'hsCardsArea' : v === 'trend' ? 'hsTrendArea' : 'hsBarArea';

// Subjects to plot: Top N (server picks them by fail rate), ordered by the selected metric.
function hsRows() {
  if (!hsData?.subjects?.length) return [];
  const topN = parseInt($('hsTopN')?.value);
  const subs = hsData.subjects.slice(0, isNaN(topN) ? 999 : topN);
  const dir = hsSortDir === 'asc' ? 1 : -1;
  return [...subs].sort((a, b) => dir * ((a[hsMetric] ?? 0) - (b[hsMetric] ?? 0)));
}

/* ── Controls ────────────────────────────────────────────────────────────── */
qsa('[data-hs-metric]').forEach(btn => {
  btn.addEventListener('click', () => {
    qsa('[data-hs-metric]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    hsMetric = btn.dataset.hsMetric;
    if (hsData && hsView === 'bar')   renderHardestBar(hsData);
    if (hsData && hsView === 'cards') renderHardestCards(hsData);
    if (!$('hsTableModal')?.classList.contains('hidden')) renderHsTable();
  });
});

qsa('[data-hs-view]').forEach(tab => {
  tab.addEventListener('click', () => {
    qsa('[data-hs-view]').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    hsView = tab.dataset.hsView;
    ['hsBarArea','hsCardsArea','hsTrendArea'].forEach(id => $(id)?.classList.add('hidden'));
    $(hsAreaFor(hsView))?.classList.remove('hidden');
    if (hsData) renderHardestActive();
  });
});

// Top N + sort sit in the header (outside the popover) and apply immediately.
$('hsTopN')?.addEventListener('change', loadHardestSubjects);
$('hsSort')?.addEventListener('change', () => { hsSortDir = $('hsSort').value || 'desc'; loadHardestSubjects(); });

// Popover: dept → course, year → semester, Apply / Reset
$('hsDept')?.addEventListener('change', () => _fillCourses('hsDept', 'hsCourse'));
$('hsYear')?.addEventListener('change', () => _populateSemesters('hsSem', $('hsYear').value));

$('hsBtnApply')?.addEventListener('click', () => {
  HSF = {
    year:      $('hsYear')?.value      || '',
    sem:       $('hsSem')?.value       || '',
    dept:      $('hsDept')?.value      || '',
    course:    $('hsCourse')?.value    || '',
    yearlevel: $('hsYearLevel')?.value || '',
    subject:   $('hsSubject')?.value   || '',
  };
  loadHardestSubjects();
});

$('hsBtnReset')?.addEventListener('click', () => {
  // "Default" = the most recently uploaded academic year + semester, Top 10, Avg Grade, descending.
  const defYear = window._kpiDefaultYear || '';
  const defSem  = window._kpiDefaultSem  || '';
  HSF = { year: defYear, sem: defSem, dept:'', course:'', yearlevel:'', subject:'' };
  hsMetric = 'avg_grade'; hsSortDir = 'desc';

  const set = (id, v) => { const el = $(id); if (el) el.value = v; };
  set('hsYear', defYear);
  _populateSemesters('hsSem', defYear);
  set('hsSem', defSem);
  set('hsDept', '');
  _fillCourses('hsDept', 'hsCourse');
  set('hsCourse', ''); set('hsYearLevel', ''); set('hsSubject', '');
  set('hsTopN', '10'); set('hsSort', 'desc');
  qsa('[data-hs-metric]').forEach(b => b.classList.toggle('active', b.dataset.hsMetric === 'avg_grade'));
  loadHardestSubjects();
});

/* ── Table view (modal) ──────────────────────────────────────────────────── */
const HS_TABLE_HEADERS = ['#','Subject','Code','Dept','Students','Avg Grade','Failed','INC','DRP','UDR','W'];
// subjectCode: falsy = every ranked subject; a code = just that one subject's row.
function hsTableRows(subjectCode) {
  const rows = subjectCode ? hsRows().filter(s => s.code === subjectCode) : hsRows();
  return rows.map((s, i) => ({
    '#': String(i + 1),
    'Subject':   s.label || s.code || '—',
    'Code':      s.code || '—',
    'Dept':      s.dept || '—',
    'Students':  s.student_count ?? 0,
    'Avg Grade': s.avg_grade != null ? s.avg_grade.toFixed(2) : '—',
    'Failed': s.FAILED ?? 0, 'INC': s.INC ?? 0, 'DRP': s.DRP ?? 0, 'UDR': s.UDR ?? 0, 'W': s.W ?? 0,
  }));
}
// Grade Trend table: one row per subject, one column per semester (avg grade for that semester).
function hsTrendHeaders() {
  return ['Subject', ...(hsData?.trend_labels || [])];
}
function hsTrendTableRows() {
  return (hsData?.trend || []).map(s => {
    const row = { 'Subject': s.label || '—' };
    (hsData?.trend_labels || []).forEach((lbl, i) => {
      const v = s.values?.[i];
      row[lbl] = v != null ? Number(v).toFixed(2) : '—';
    });
    return row;
  });
}
function renderHsTable() {
  const titleEl = $('hsTableModalTitle');

  if (hsView === 'trend') {
    if (titleEl) titleEl.textContent = 'Grade Trend — Table View';
    buildTable('hsTableInner', hsTrendTableRows(), hsTrendHeaders(), 'Subject', 'asc', {
      filename: 'hardest_subjects_grade_trend',
      title: 'Grade Trend',
      description: 'Average grade per semester for the currently plotted subjects.',
    });
    return;
  }

  const code = hsModalSubjectCode;
  const subj = code ? hsData?.subjects?.find(s => s.code === code) : null;
  if (titleEl) titleEl.textContent = subj ? `${subj.label || subj.code} — Table View` : 'Subjects Requiring Intervention — Table View';
  buildTable('hsTableInner', hsTableRows(code), HS_TABLE_HEADERS, '#', 'asc', {
    filename: subj ? `hardest_subjects_${subj.code}` : 'hardest_subjects',
    title: subj ? `${subj.label || subj.code} — Subject Detail` : 'Subjects Requiring Intervention',
    description: subj
      ? `Detailed breakdown for ${subj.label || subj.code}.`
      : 'Subjects ranked for the currently selected filters and metric.',
  });
}
// Header icon always shows every ranked subject.
$('hsViewTable')?.addEventListener('click', () => { hsModalSubjectCode = null; });
const hsModal = initTableModal({
  openId: 'hsViewTable', modalId: 'hsTableModal', closeId: 'hsTableModalClose',
  onOpen: () => { if (hsData) renderHsTable(); },
});
$('hsTableDownloadCsv')?.addEventListener('click', () => {
  if (hsView === 'trend') {
    const rows = hsTrendTableRows();
    if (rows.length) downloadCsv(rows, hsTrendHeaders(), 'hardest_subjects_grade_trend');
    return;
  }
  const code = hsModalSubjectCode;
  const subj = code ? hsData?.subjects?.find(s => s.code === code) : null;
  const rows = hsTableRows(code);
  const fname = subj ? `hardest_subjects_${subj.code}` : 'hardest_subjects';
  if (rows.length) downloadCsv(rows, HS_TABLE_HEADERS, fname);
});
// Clicking the bar chart also opens the table (same as the heatmap) — every subject.
// Clicking one specific bar instead opens the table scoped to just that subject
// (the bar's own onClick below stops this from also firing).
$('hsBarArea')?.addEventListener('click', () => { if (hsData?.subjects?.length) $('hsViewTable')?.click(); });
// Cards area: clicking empty space opens the full table; a single row is handled in renderHardestCards.
$('hsCardsArea')?.addEventListener('click', () => { if (hsData?.subjects?.length) $('hsViewTable')?.click(); });
// Trend area: clicking the chart opens the same table modal, showing the trend table (see renderHsTable).
$('hsTrendArea')?.addEventListener('click', () => { if (hsData?.trend?.length) $('hsViewTable')?.click(); });

/* ── Load + render ───────────────────────────────────────────────────────── */
async function loadHardestSubjects() {
  const reqId = ++hsReqId;
  const p = new URLSearchParams();
  Object.entries(HSF).forEach(([k, v]) => { if (v !== '' && v != null) p.set(k, v); });
  const topN = $('hsTopN')?.value; if (topN) p.set('top_n', topN);
  p.set('sort', hsSortDir);
  { const c = cmpOf('hsCompare'); if (c) p.set('compare', c); }

  if (hsView === 'bar') loading('hsBarArea');
  try {
    const res = await fetch('/api/dash/hardest-subjects?' + p.toString());
    if (!res.ok) throw new Error('hardest ' + res.status);
    const json = await res.json();
    if (json.error) throw new Error(json.error);
    if (reqId !== hsReqId) return;
    hsData = json;
    if (hsData.all_subjects_list) fillSelect('hsSubject', hsData.all_subjects_list, s => s.label || s.code, s => s.code);
    renderHardestActive();
    if (!$('hsTableModal')?.classList.contains('hidden')) renderHsTable();
  } catch (e) {
    if (reqId !== hsReqId) return;
    console.error('Hardest subjects:', e);
    hsData = null;
    empty(hsAreaFor(hsView), 'Could not load the hardest subjects.');
  }
}

function renderHardestActive() {
  if (hsView === 'bar')   renderHardestBar(hsData);
  if (hsView === 'cards') renderHardestCards(hsData);
  if (hsView === 'trend') renderHardestTrend(hsData);
  $('hsBarArea')?.classList.toggle('clickable', hsView === 'bar' && !!hsData?.subjects?.length);
  $('hsCardsArea')?.classList.toggle('clickable', hsView === 'cards' && !!hsData?.subjects?.length);
  $('hsTrendArea')?.classList.toggle('clickable', hsView === 'trend' && !!hsData?.trend?.length);
}

function hsColor(val, max, isGrade = false) {
  // avg_grade is a fixed 1.00 (best) – 5.00 (worst) scale, so color it against that
  // fixed range instead of the max among the subjects currently shown; otherwise a
  // decent grade like 1.5 can look "red" just because it's the worst of a good batch.
  const t = isGrade ? Math.max(0, Math.min(1, (val - 1) / 4))
                     : (max > 0 ? Math.min(val / max, 1) : 0);
  if (CB.on) {                                         // blue = good, yellow = middle, vermillion = bad
    if (t > 0.65) return 'rgba(213,94,0,0.9)';
    if (t > 0.35) return 'rgba(240,228,66,0.95)';
    return 'rgba(0,114,178,0.85)';
  }
  if (t > 0.65) return 'rgba(220,38,38,0.85)';
  if (t > 0.35) return 'rgba(234,179,8,0.85)';
  return 'rgba(34,197,94,0.75)';
}

function renderHardestBar(data) {
  const area = $('hsBarArea');
  const subs = hsRows();
  if (!subs.length) { empty('hsBarArea'); area?.classList.remove('clickable'); return; }
  area.innerHTML = '<canvas id="hsBarCanvas"></canvas>';
  area.style.setProperty('--hs-h', (isNarrow() && !hsIsFullscreen() ? Math.max(240, subs.length * 30 + 70) : Math.max(340, subs.length * 36 + 80)) + 'px');   // phones: thinner rows   // room for every bar (ignored in fullscreen)

  const fs     = hsIsFullscreen() ? 13 : (isNarrow() ? 10 : 11);
  const vals   = subs.map(s => s[hsMetric] ?? 0);
  const maxV   = Math.max(...vals, 1);
  const isGrade = hsMetric === 'avg_grade';
  const label  = hsMetricLabel(hsMetric);

  // Bar label = value + number of students in that subject, e.g. "23.4% (1,240 students)".
  const barText = (v, s) => { const n = s.student_count ?? 0; return isNarrow() ? hsFmt(v) : `${hsFmt(v)} (${n.toLocaleString()} ${n === 1 ? 'student' : 'students'})`; };
  const m = document.createElement('canvas').getContext('2d');
  m.font = `600 ${fs}px Inter, sans-serif`;
  const padR = Math.ceil(Math.max(...subs.map((s, i) => m.measureText(barText(vals[i], s)).width))) + 14;

  makeChart('hsBarCanvas', {
    type:'bar',
    data: { labels: subs.map(s => s.label || s.code),
      datasets:[{ label, data:vals,
        backgroundColor: vals.map(v => hsColor(v, maxV, isGrade)),
        minBarLength: 6, borderRadius:5, borderSkipped:false }] },
    options: {
      indexAxis:'y', responsive:true, maintainAspectRatio:false,
      layout: { padding: { right: padR } },
      // Clicking a specific bar opens the table modal scoped to just that subject; stopping
      // propagation keeps hsBarArea's own click handler (which opens the full, unscoped table)
      // from also firing for the same click.
      onClick: (evt, elements) => {
        if (!elements?.length) return;
        const subj = subs[elements[0].index];
        if (!subj) return;
        evt.native?.stopPropagation();
        hsModalSubjectCode = subj.code;
        hsModal?.open?.();
      },
      plugins: {
        legend:{display:false},
        tooltip:{callbacks:{
          title: items => subs[items[0].dataIndex].label || subs[items[0].dataIndex].code,
          label: ctx => {
            const s = subs[ctx.dataIndex];
            return [`${label}: ${hsFmt(ctx.raw)}`, `Dept: ${s.dept || '—'}`,
                    ...(s.course ? [`Program: ${courseShort(s.course)}`] : []),
                    `Students: ${(s.student_count ?? 0).toLocaleString()}`];
          }}},
        datalabels:{ anchor:'end', align:'right', clip:false,
          formatter:(v, ctx) => barText(v, subs[ctx.dataIndex]),
          font:{ size: fs, weight: '600' }, color:'#111' },
      },
      scales:{
        x:{ min: isGrade ? 1 : 0, max: isGrade ? 5 : undefined, beginAtZero: !isGrade,
            title:{display:true, text:label, font:{size: fs}}, ticks:{font:{size: fs}} },
        y:{ ticks:{ font:{size: fs},
              callback(v) { const t = String(this.getLabelForValue(v)); const max = isNarrow() ? 22 : 40; return t.length > max ? t.slice(0, max - 1) + '…' : t; } } },
      },
    },
    plugins:[ChartDataLabels],
  });
}

function renderHardestCards(data) {
  const area = $('hsCardsArea');
  const subs = hsRows();
  if (!subs.length) { area.innerHTML='<div class="chart-empty">No data.</div>'; return; }

  const isGrade = hsMetric === 'avg_grade';
  const vals = subs.map(s => s[hsMetric] ?? 0);
  const maxV = Math.max(...vals, 1);
  // Grade metric runs 1.00–5.00 (best–worst); everything else scales against the max shown.
  const pct = v => Math.max(3, isGrade ? Math.max(0, Math.min(100, (v - 1) / 4 * 100))
                                        : (maxV > 0 ? Math.min(100, v / maxV * 100) : 0));

  area.innerHTML = `<div class="ranked-bars">${subs.map((s,i)=>{
    const v = s[hsMetric] ?? 0;
    const n = s.student_count ?? 0;
    return `
    <div class="rb-row" data-code="${s.code || ''}">
      <div class="rb-rank">${i+1}</div>
      <div class="rb-body">
        <div class="rb-head">
          <span class="rb-title">${s.label || s.title || '—'}</span>
          ${s.code ? `<span class="rb-code">${s.code}</span>` : ''}
          <span class="rb-value">${hsFmt(v)}</span>
        </div>
        <div class="rb-track"><div class="rb-fill" style="width:${pct(v).toFixed(1)}%; background:${hsColor(v, maxV, isGrade)}"></div></div>
        <div class="rb-meta">${s.dept || '—'}${s.course ? ' · ' + courseShort(s.course) : ''} · ${n.toLocaleString()} ${n===1?'student':'students'}</div>
        <div class="rb-chips">
          ${s.FAILED!=null?`<span class="rc-chip">F:${s.FAILED}</span>`:''}
          ${s.INC!=null?`<span class="rc-chip inc">INC:${s.INC}</span>`:''}
          ${s.DRP!=null?`<span class="rc-chip drp">DRP:${s.DRP}</span>`:''}
          ${s.UDR!=null?`<span class="rc-chip udr">UDR:${s.UDR}</span>`:''}
          ${s.W!=null?`<span class="rc-chip w">W:${s.W}</span>`:''}
          ${s.avg_grade!=null?`<span class="rc-chip grade">GWA:${s.avg_grade.toFixed(2)}</span>`:''}
        </div>
      </div>
    </div>`;
  }).join('')}</div>`;

  // Clicking a row opens the table modal scoped to just that subject; stopping propagation
  // keeps hsCardsArea's own click handler (which opens the full, unscoped table) from firing too.
  qsa('.rb-row', area).forEach(row => {
    row.addEventListener('click', (evt) => {
      const code = row.dataset.code;
      if (!code) return;
      evt.stopPropagation();
      hsModalSubjectCode = code;
      hsModal?.open?.();
    });
  });
}

function renderHardestTrend(data) {
  const area = $('hsTrendArea');
  if (!data?.trend?.length) { area.innerHTML='<div class="chart-empty">No trend data.</div>'; return; }
  area.innerHTML = '<canvas id="hsTrendCanvas"></canvas>';
  const fs = hsIsFullscreen() ? 13 : (isNarrow() ? 10 : 11);
  const colors = CB.on ? CB_TREND : ['#800000','#4E73DF','#1CC88A','#E74A3B','#8A2BE2','#36B9CC','#d97706'];
  makeChart('hsTrendCanvas', {
    type:'line',
    data: { labels:data.trend_labels,
      datasets:data.trend.map((s,i)=>({
        label:s.label, data:s.values,
        borderColor:colors[i%colors.length],
        backgroundColor:colors[i%colors.length]+'20',
        tension:0.3, pointRadius: isNarrow() ? 2.5 : 4, borderWidth: isNarrow() ? 1.6 : 3, fill:false,
        borderDash: CB.on ? CB_DASHES[i % CB_DASHES.length] : [],
        pointStyle: CB.on ? CB_SHAPES[i % CB_SHAPES.length] : 'circle' })) },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display: !(isNarrow() && data.trend.length > 6), position:'top', align:'start', rtl:false, labels:{font:{size: fs},boxWidth: isNarrow() ? 8 : 12, padding: isNarrow() ? 8 : 10}},
               tooltip:{mode:'index',intersect:false}},
      scales:{
        y:{reverse:true,min:1.0,max:5.0,
           title:{display: !isNarrow(),text:'Average Grade',font:{size: fs}}, ticks:{font:{size: fs}}},
        x:{title:{display: !isNarrow(),text:'Academic Year · Semester',font:{size: fs}}, ticks:{font:{size: fs}, maxRotation: isNarrow() ? 0 : 50, maxTicksLimit: isNarrow() ? 4 : 20}},
      } },
  });
}

// Chart text is drawn on the canvas, so re-draw when the card changes width (window resize, fullscreen).
(function watchHardestCard() {
  const card = $('hardestCard');
  if (!card || typeof ResizeObserver === 'undefined') return;
  const keyOf = () => card.clientWidth + '|' + card.classList.contains('is-fullscreen');
  let lastKey = keyOf(), timer = null;
  new ResizeObserver(() => {
    if (keyOf() === lastKey) return;
    clearTimeout(timer);
    timer = setTimeout(() => { lastKey = keyOf(); if (hsData) renderHardestActive(); }, 150);
  }).observe(card);
})();

/* ── PDF ─────────────────────────────────────────────────────────────────── */
/* Download PDF is handled by pdf-export.js */

/* ── Filter popovers (KPI + Heatmap + Gender + Hardest) ─────────────────────────────────────── */
initFilterPopover({ toggleId:'kpiFilterToggle',  popoverId:'kpiFilterPopover',  closeId:'kpiFilterClose',  applyId:'kpiBtnApply'  });
initFilterPopover({ toggleId:'hmFilterToggle',   popoverId:'hmFilterPopover',   closeId:'hmFilterClose',   applyId:'hmBtnApply'   });
initFilterPopover({ toggleId:'perfFilterToggle', popoverId:'perfFilterPopover', closeId:'perfFilterClose', applyId:'perfBtnApply' });
initFilterPopover({ toggleId:'gdFilterToggle',   popoverId:'gdFilterPopover',   closeId:'gdFilterClose',   applyId:'gdBtnApply'   });
initFilterPopover({ toggleId:'hsFilterToggle',   popoverId:'hsFilterPopover',   closeId:'hsFilterClose',   applyId:'hsBtnApply'   });

/* ── Fullscreen card toggle (works on any card with a .btn-fullscreen icon) ─
   Expanding covers the viewport; collapsing returns the card to its normal
   place in the grid with no leftover layout side-effects. */
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
    if (card.id === 'heatmapCard') sizeHistogramWrap();
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
    if (card.id === 'heatmapCard') sizeHistogramWrap();
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

/* ── Skeleton loading: wrap each card's loader ─────────────────────────── */
{ const _o = loadKpi;            loadKpi            = function () { skOn('kpiCard');     return Promise.resolve(_o.apply(this, arguments)).finally(() => skDone('kpiCard')); }; }
{ const _o = loadHeatmap;        loadHeatmap        = function () { skOn('heatmapCard'); return Promise.resolve(_o.apply(this, arguments)).finally(() => skDone('heatmapCard')); }; }
{ const _o = loadPerformance;    loadPerformance    = function () { skOn('perfCard');     return Promise.resolve(_o.apply(this, arguments)).finally(() => skDone('perfCard')); }; }
{ const _o = loadGenderPie;      loadGenderPie      = function () { skOn('genderCard');  return Promise.resolve(_o.apply(this, arguments)).finally(() => skDone('genderCard')); }; }
{ const _o = loadHardestSubjects; loadHardestSubjects = function () { skOn('hardestCard'); return Promise.resolve(_o.apply(this, arguments)).finally(() => skDone('hardestCard')); }; }

/* ── Phones: each chart's description sits behind a dropdown (styles: responsive.css) ──
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

/* ── COLOR-BLIND MODE ─────────────────────────────────────────────────────────
   One switch swaps every palette in place (status colours, colleges, year levels,
   heatmap scale, performance tiers, trend lines), then re-draws the cards.
   Colours: Okabe-Ito set + the blue-red RdYlBu scale, both safe for red-green
   (deuteranopia / protanopia) and blue-yellow (tritanopia) colour blindness.
   Point shapes and dash patterns are added as a second cue.  Saved in localStorage. */
const CB_KEY = 'dashColorblind';
let _cbSaved = false;
try { _cbSaved = localStorage.getItem(CB_KEY) === '1'; } catch (e) {}
const CB = { on: _cbSaved };                                   // read by the render functions above

const CB_SHAPES = ['circle', 'triangle', 'rect', 'rectRot', 'star', 'crossRot'];
const CB_DASHES = [[], [7, 4], [2, 3], [9, 3, 2, 3], [], [7, 4], [2, 3]];
const CB_TREND  = ['#0072B2', '#E69F00', '#009E73', '#CC79A7', '#56B4E9', '#D55E00', '#000000'];

const _hexRgb = hex => [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16));
const PALETTES = {
  normal: {
    status:  { FAILED:'#dc2626', DRP:'#7c3aed', INC:'#d97706', UDR:'#0284c7', W:'#059669', NGA:'#9ca3af', CONTINUING:'#16a34a' },
    college: { CAHS:'#36b9cc', CBA:'#e74a3b', CCST:'#8a2be2', CEA:'#1cc88a', COAS:'#5a5c69', CTEC:'#4e73df' },
    yl:      ['#2563EB','#059669','#7C3AED','#0891B2','#D97706','#64748B'],
    heat:    ['#006837','#1a9850','#66bd63','#a6d96a','#d9ef8b','#ffffbf','#fee08b','#fdae61','#f46d43','#d73027','#a50026'],
    tiers:   ['#16a34a', '#65a30d', '#d97706', '#dc2626'],
    perfFallback: ['#4e73df','#1cc88a','#e74a3b','#36b9cc','#8a2be2','#5a5c69','#d97706','#800000'],   // course-program rows / radar lines
  },
  cb: {
    status:  { FAILED:'#D55E00', DRP:'#CC79A7', INC:'#E69F00', UDR:'#0072B2', W:'#56B4E9', NGA:'#999999', CONTINUING:'#009E73' },
    college: { CAHS:'#56B4E9', CBA:'#D55E00', CCST:'#CC79A7', CEA:'#009E73', COAS:'#E69F00', CTEC:'#0072B2' },
    yl:      ['#0072B2','#56B4E9','#009E73','#E69F00','#D55E00','#CC79A7'],
    heat:    ['#313695','#4575b4','#74add1','#abd9e9','#e0f3f8','#ffffbf','#fee090','#fdae61','#f46d43','#d73027','#a50026'],
    tiers:   ['#0072B2', '#56B4E9', '#E69F00', '#D55E00'],
    perfFallback: ['#0072B2','#009E73','#D55E00','#56B4E9','#CC79A7','#E69F00','#000000','#999999'],
  },
};

function applyPalette() {
  const P = CB.on ? PALETTES.cb : PALETTES.normal;
  Object.assign(STATUS_COLORS, P.status);
  Object.assign(GD_STATUS_COLORS, P.status);
  Object.assign(COLLEGE_COLORS, P.college);
  YL_COLORS.splice(0, YL_COLORS.length, ...P.yl);
  HM_STOPS.splice(0, HM_STOPS.length, ...P.heat.map(_hexRgb));
  PERF_TIERS.forEach((t, i) => { t.color = P.tiers[i]; });
  PERF_FALLBACK_COLORS.splice(0, PERF_FALLBACK_COLORS.length, ...P.perfFallback);
  document.documentElement.classList.toggle('cb-mode', CB.on);
  const btn = $('btnColorblind');
  if (btn) btn.setAttribute('aria-checked', String(CB.on));
}
applyPalette();                                                // before the first render

$('btnColorblind')?.addEventListener('click', () => {
  CB.on = !CB.on;
  try { localStorage.setItem(CB_KEY, CB.on ? '1' : '0'); } catch (e) {}
  applyPalette();
  // re-draw every card with the new colours (each keeps its own filters)
  [loadKpi, loadHeatmap, loadPerformance, loadGenderPie, loadHardestSubjects]
    .forEach(fn => { try { fn(); } catch (e) { console.error(e); } });
});

/* ── INIT ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initDashboard);

/* Chart data + filters handed to the Insights modal and insight-engine.js
   (they live outside this closure, so they can't see the `let` variables above). */
const _stripSort = o => { const r = { ...o }; delete r.sort; return r; };
window.MD = {
  kpi: () => kpiData, hm: () => hmData, perf: () => perfData, gd: () => gdData, hs: () => hsData,
  hsRows: () => hsRows(),
  kt: () => window.ktData, et: () => window.etData,
  filters(id) {
    switch (id) {
      case 'kpiCard':         return _stripSort(KF);
      case 'kpiTrendCard':    return window.REG ? window.REG.ktFilters() : {};
      case 'enrollTrendCard': return window.REG ? window.REG.etFilters() : {};
      case 'heatmapCard':     return _stripSort(HF);
      case 'perfCard':        return { ..._stripSort(PF), rank: perfRank };
      case 'genderCard':      return { ..._stripSort(GDF), enroll: gdEnroll, status: gdMetric };
      case 'hardestCard':     return { ..._stripSort(HSF), metric: hsMetric, top_n: $('hsTopN')?.value || '' };
    }
    return {};
  },
};
window.MD.insightFilters = window.MD.filters;

})();

/* ══════════════════════════════════════════════════════════════════════════
   DOWNLOAD CHART AS PNG
   ══════════════════════════════════════════════════════════════════════════ */
(function () {

  // ── Download icon — arrow-down-tray, clearly "save/download" ────────────
  const DL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style="width:15px">
    <path d="M10.75 2.75a.75.75 0 0 0-1.5 0v8.614L6.295 8.235a.75.75 0 1 0-1.09 1.03l4.25 4.5a.75.75 0 0 0 1.09 0l4.25-4.5a.75.75 0 0 0-1.09-1.03l-2.955 3.129V2.75Z"/>
    <path d="M3.5 12.75a.75.75 0 0 0-1.5 0v2.5A2.75 2.75 0 0 0 4.75 18h10.5A2.75 2.75 0 0 0 18 15.25v-2.5a.75.75 0 0 0-1.5 0v2.5c0 .69-.56 1.25-1.25 1.25H4.75c-.69 0-1.25-.56-1.25-1.25v-2.5Z"/>
  </svg>`;

  // ── Map card → canvas ids ────────────────────────────────────────────────
  const CARD_CANVAS = {
    kpiCard:         [],   // KPI = text/numbers, no canvas — we note this to user
    kpiTrendCard:    ['kpiTrendChart'],
    enrollTrendCard: ['enrollTrendChart'],
    heatmapCard:     ['hmHistCanvas'],
    perfCard:        ['perfRadarCanvas'],
    genderCard:      [],   // multiple canvases, fallback to chart-area scan
    hardestCard:     ['hsBarCanvas', 'hsTrendCanvas'],
  };

  const CARD_TITLES = {
    kpiCard:         'KPI Overview',
    kpiTrendCard:    'Status Trend',
    enrollTrendCard: 'Enrollment Trend',
    heatmapCard:     'Risk Histogram',
    perfCard:        'Academic Performance',
    genderCard:      'Gender Breakdown',
    hardestCard:     'Subjects Requiring Intervention',
  };

  // ── Confirmation modal ───────────────────────────────────────────────────
  const confirmModal = document.createElement('div');
  confirmModal.id = 'dlConfirmModal';
  confirmModal.className = 'dl-confirm-modal hidden';
  confirmModal.innerHTML = `
    <div class="dl-confirm-card">
      <div class="dl-confirm-icon">
        ${DL_SVG.replace('style="width:15px"', 'style="width:28px;color:#7B1113"')}
      </div>
      <div class="dl-confirm-body">
        <h4 class="dl-confirm-title">Download Chart Image</h4>
        <p class="dl-confirm-sub" id="dlConfirmSub">Save this chart as a PNG image file?</p>
        <p class="dl-confirm-note">The image will include the chart with a white background, ready to insert into reports or presentations.</p>
      </div>
      <div class="dl-confirm-actions">
        <button class="dl-btn-cancel" id="dlConfirmCancel">Cancel</button>
        <button class="dl-btn-confirm" id="dlConfirmOk">
          ${DL_SVG.replace('style="width:15px"', 'style="width:14px"')} Download PNG
        </button>
      </div>
    </div>`;
  document.body.appendChild(confirmModal);

  let _pendingCardId = null;

  document.getElementById('dlConfirmCancel').addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    _pendingCardId = null;
  });
  confirmModal.addEventListener('click', e => {
    if (e.target === confirmModal) { confirmModal.classList.add('hidden'); _pendingCardId = null; }
  });
  document.getElementById('dlConfirmOk').addEventListener('click', () => {
    confirmModal.classList.add('hidden');
    if (_pendingCardId) { _doDownload(_pendingCardId); _pendingCardId = null; }
  });

  // ── Core download ────────────────────────────────────────────────────────
  function _doDownload(cardId) {
    const canvasIds = CARD_CANVAS[cardId] || [];
    const title     = CARD_TITLES[cardId] || cardId;
    const filename  = 'novasight_' + title.toLowerCase().replace(/[^a-z0-9]+/g, '_');

    // Try named canvas ids first
    for (const cid of canvasIds) {
      const c = document.getElementById(cid);
      if (c && c.width > 0) { _saveCanvas(c, filename); return; }
    }

    // Fallback: first visible canvas inside the card's chart-area
    const fallback = document.querySelector('#' + cardId + ' .chart-area canvas');
    if (fallback && fallback.width > 0) { _saveCanvas(fallback, filename); return; }

    // KPI card: no canvas — inform user
    if (cardId === 'kpiCard') {
      _showNoCanvas('The KPI card displays numbers, not a chart image.\nUse the table download or take a screenshot instead.');
      return;
    }
    _showNoCanvas('No chart found. Make sure the chart has finished loading, then try again.');
  }

  function _saveCanvas(canvas, filename) {
    const off = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    const ctx = off.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, off.width, off.height);
    ctx.drawImage(canvas, 0, 0);
    const a = document.createElement('a');
    a.href = off.toDataURL('image/png');
    a.download = filename + '.png';
    a.click();
  }

  function _showNoCanvas(msg) {
    const sub = document.getElementById('dlConfirmSub');
    // Repurpose the modal to show the error
    const ok  = document.getElementById('dlConfirmOk');
    if (sub) sub.textContent = msg;
    if (ok)  ok.style.display = 'none';
    confirmModal.classList.remove('hidden');
    setTimeout(() => {
      if (ok) ok.style.display = '';
      if (sub) sub.textContent = 'Save this chart as a PNG image file?';
    }, 4000);
  }

  // ── Inject buttons ───────────────────────────────────────────────────────
  const ALL_CARDS = ['kpiCard', 'kpiTrendCard', 'enrollTrendCard', 'heatmapCard', 'perfCard', 'genderCard', 'hardestCard'];
  ALL_CARDS.forEach(cardId => {
    const card    = document.getElementById(cardId); if (!card) return;
    const actions = card.querySelector('.kpi-header-actions'); if (!actions) return;

    const btn = document.createElement('button');
    btn.className = 'btn-icon btn-download-chart';
    btn.title     = 'Download chart as PNG';
    btn.setAttribute('aria-label', 'Download chart as PNG');
    btn.innerHTML = DL_SVG;
    btn.addEventListener('click', () => {
      _pendingCardId = cardId;
      const sub = document.getElementById('dlConfirmSub');
      if (sub) sub.textContent = `Save "${CARD_TITLES[cardId] || cardId}" as a PNG image?`;
      const ok = document.getElementById('dlConfirmOk');
      if (ok) ok.style.display = '';
      confirmModal.classList.remove('hidden');
    });

    const fsBtn = actions.querySelector('.btn-fullscreen');
    if (fsBtn) actions.insertBefore(btn, fsBtn);
    else actions.appendChild(btn);
  });

})();

/* ══════════════════════════════════════════════════════════════════════════
   AI INSIGHTS — "Generate Chart Insights"
   Editable floating modal, shared across users via /api/dash/insights.
   No external API — users write/edit insights directly.
   ══════════════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', function () {
  const _$ = id => document.getElementById(id);

  const modal    = _$('aiInsightsModal');
  if (!modal) return;

  const titleEl  = _$('aiInsightsTitle');
  const ctxEl    = _$('aiInsightsContext');
  const loadEl   = _$('aiInsightsLoading');
  const textArea = _$('aiInsightsTextarea');
  const badge    = _$('aiInsightsSaveBadge');
  const metaEl   = _$('aiInsightsMeta');
  const saveBtn  = _$('aiInsightsSave');
  const regenBtn = _$('aiInsightsRegen');

  let _card      = null;
  let _dirty     = false;
  let _savedText = '';
  const filtersOf = id => (window.MD ? window.MD.insightFilters(id) : _legacyFiltersOf(id));
  const _legacyFiltersOf = id => {
    try {
      const strip = o => { const r = {...o}; delete r.sort; return r; };
      switch (id) {
        case 'kpiCard':         return strip(KF);
        case 'kpiTrendCard':    return window.REG ? window.REG.ktFilters() : {};
        case 'enrollTrendCard': return window.REG ? window.REG.etFilters() : {};
        case 'heatmapCard':     return strip(HF);
        case 'perfCard':    return { ...strip(PF), rank: perfRank };
        case 'genderCard':  return { ...strip(GDF), enroll: gdEnroll, status: gdMetric };
        case 'hardestCard': return { ...strip(HSF), metric: hsMetric, top_n: _$('hsTopN')?.value || '' };
      }
    } catch (e) {}
    return {};
  };

  const TITLES = {
    kpiCard:'KPI Overview', kpiTrendCard:'Status Trend', enrollTrendCard:'Enrollment Trend', heatmapCard:'Risk Histogram',
    perfCard:'Academic Performance', genderCard:'Gender Breakdown',
    hardestCard:'Subjects Requiring Intervention',
  };
  const PLACEHOLDER = {
    kpiCard:     'Add your insights about the KPI overview here. What do the enrollment, GWA, and at-risk numbers reveal this semester?',
    kpiTrendCard: 'Add your insights about the KPI trend here. How has the status breakdown shifted across semesters — any statuses rising or falling over time?',
    enrollTrendCard: 'Add your insights about the enrollment trend here. Is total enrollment growing or shrinking, and how has the regular/irregular mix shifted over time?',
    heatmapCard: 'Add your insights about the risk histogram here. Which colleges or courses show the highest failure rates, and by which year level?',
    perfCard:    'Add your insights about academic performance here. Which departments lead, and which need intervention?',
    genderCard:  'Add your insights about the gender breakdown here. Are there notable gaps between male and female academic outcomes?',
    hardestCard: 'Add your insights about subjects requiring intervention here. What patterns appear in the top failing subjects?',
  };

  /* ── Dirty state — Save button turns maroon when changed ─────────────── */
  function setDirty(val) {
    _dirty = val;
    if (!saveBtn) return;
    saveBtn.classList.toggle('ai-save-btn-dirty', val);
    saveBtn.disabled = !val;
    saveBtn.title = val ? 'Save changes' : 'No unsaved changes';
  }

  function setBadge(cls, txt) {
    if (!badge) return;
    badge.textContent = txt;
    badge.className = 'ai-save-badge' + (cls ? ' ' + cls : '');
  }

  /* ── Load from server ────────────────────────────────────────────────── */
  async function loadInsight(cardId) {
    try {
      const r = await fetch('/api/dash/insights?chart_key=' + cardId + '&dashboard=main&filters=' + encodeURIComponent(JSON.stringify(filtersOf(cardId))));
      if (!r.ok) return null;
      const d = await r.json();
      return d.found ? d : null;
    } catch { return null; }
  }

  /* ── Save (explicit only) ────────────────────────────────────────────── */
  async function doSave() {
    const text = textArea?.innerText?.trim() || '';
    if (!text || !_card) return;
    setBadge('unsaved', 'Saving…');
    const sub = document.querySelector('#' + _card + ' .card-subtitle')?.textContent || '';
    try {
      const r = await fetch('/api/dash/insights', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({chart_key:_card, dashboard:'main', insight_text:text, filter_label:sub, filters: filtersOf(_card) }),
      });
      const d = await r.json();
      if (d.saved) {
        _savedText = text;
        setBadge('saved', 'Saved — visible to all users');
        setDirty(false);
        if (metaEl) metaEl.textContent = 'Just saved by you';
      } else { setBadge('error', 'Save failed' + (d.reason ? ': ' + d.reason : '')); }
    } catch (e) { setBadge('error', 'Save failed: ' + (e?.message || 'network error')); }
  }

  /* ── Open modal ──────────────────────────────────────────────────────── */
  async function openModal(cardId) {
    _card = cardId; _savedText = '';
    setDirty(false);
    if (titleEl) {
      const svg = titleEl.querySelector('svg');
      titleEl.textContent = ' Generate Chart Insights — ' + (TITLES[cardId] || cardId);
      if (svg) titleEl.prepend(svg);
    }
    if (ctxEl)  ctxEl.textContent  = document.querySelector('#' + cardId + ' .card-subtitle')?.textContent || '';
    if (metaEl) metaEl.textContent = '';
    setBadge('', '');
    if (textArea) { textArea.textContent = ''; textArea.contentEditable = 'true'; }

    // Some cards (kpiCard is stat tiles, not a Chart.js canvas) have nothing
    // for "Include chart image" to actually capture — previously the
    // checkbox stayed checked and enabled regardless, so Download as Word
    // silently produced a document with NO <img> at all and no indication
    // why. Disable + uncheck + explain instead of failing silently.
    const includeChartEl = _$('aiInsightsIncludeChart');
    if (includeChartEl) {
      const hasChart = !!document.querySelector('#' + cardId + ' .chart-area canvas');
      includeChartEl.disabled = !hasChart;
      if (!hasChart) includeChartEl.checked = false;
      const label = includeChartEl.closest('label');
      if (label) label.title = hasChart ? '' : 'This card has no chart image to include.';
      label?.classList.toggle('disabled-note', !hasChart);
    }

    modal.classList.remove('hidden');

    if (loadEl) loadEl.classList.add('active');
    const saved = await loadInsight(cardId);
    if (loadEl) loadEl.classList.remove('active');

    if (saved?.insight_text) {
      _savedText = saved.insight_text;
      textArea.innerText = saved.insight_text;
      setBadge('saved', 'Saved — visible to all users');
      if (saved.legacy) { _savedText = ''; setDirty(true); setBadge('unsaved', 'Earlier general insight - click Save to keep it for these filters'); }
      if (metaEl && saved.updated_at) {
        const dt = new Date(saved.updated_at);
        metaEl.textContent = 'Last updated ' + dt.toLocaleDateString('en-PH',{month:'short',day:'numeric',year:'numeric'})
          + (saved.updated_by ? ' by ' + saved.updated_by : '');
      }
    } else {
      textArea.textContent = '';
      textArea.setAttribute('data-placeholder', PLACEHOLDER[cardId] || 'Type your insight here…');
      setBadge('', '');
      regenBtn?.click();   // no saved insight yet: let the AI draft one to review
    }
  }

  /* ── Track edits: dirty only when text differs from last save ───────── */
  textArea?.addEventListener('input', () => {
    const current = textArea.innerText?.trim() || '';
    const differs = current !== _savedText;
    if (differs !== _dirty) setDirty(differs);
    // If user reverted to saved text, restore badge
    if (!differs) setBadge(_savedText ? 'saved' : '', _savedText ? 'Saved — visible to all users' : '');
    else if (!badge.classList.contains('unsaved')) setBadge('unsaved', 'Unsaved — click Save to share');
  });

  /* ── Save button ─────────────────────────────────────────────────────── */
  saveBtn?.addEventListener('click', () => { if (_dirty) doSave(); });

  /* ── Regenerate — calls Claude API with current chart context ────────── */
  const INST  = 'Bataan Peninsula State University (BPSU) Main Campus';
  const SCALE = 'GWA uses the Philippine 1.00\u20135.00 scale \u2014 1.00 is best, 5.00 is failing.';

  function buildPrompt(cardId) {
    const sub = document.querySelector('#' + cardId + ' .card-subtitle')?.textContent || '';
    const ctx = sub ? `Filters active: ${sub}\n` : '';
    switch (cardId) {
      case 'kpiCard': {
        const vals = ['kpiEnrollVal','kpiGwaVal','kpiCompVal','kpiStatusVal']
          .map(id => _$(id)?.textContent?.trim()).filter(Boolean).join(', ');
        return `You are an academic analytics assistant for ${INST}. ${SCALE}\n${ctx}KPI snapshot: ${vals || 'see dashboard'}.\nProvide 3\u20135 concise numbered insights for administrators about what these numbers reveal and what actions to consider.`;
      }
      case 'kpiTrendCard': {
        if (!window.ktData?.labels?.length) return null;
        const n = window.ktData.labels.length;
        const groupWord = window.ktData.group_by === 'course' ? 'program' : 'college';
        const trend = (window.ktData.datasets || []).map(ds => {
          const first = ds.data[0], last = ds.data[n - 1];
          return `${ds.label}: ${first ?? '\u2014'} \u2192 ${last ?? '\u2014'}`;
        }).join('; ');
        return `You are an academic analytics assistant for ${INST}.\n${ctx}Status Trend \u2014 ${window.ktData.metric || 'FAILED'} status, by ${groupWord}, from ${window.ktData.labels[0]} to ${window.ktData.labels[n-1]}: ${trend}.\nProvide 3\u20135 concise numbered insights about which ${groupWord}s are rising or falling over time and what that suggests.`;
      }
      case 'enrollTrendCard': {
        if (!window.etData?.labels?.length) return null;
        const n = window.etData.labels.length;
        const groupWord = window.etData.group_by === 'course' ? 'program' : 'college';
        const trend = (window.etData.datasets || []).map(ds => {
          const first = ds.data[0], last = ds.data[n - 1];
          return `${ds.label}: ${first ?? '\u2014'} \u2192 ${last ?? '\u2014'}`;
        }).join('; ');
        return `You are an academic analytics assistant for ${INST}.\n${ctx}Enrollment Trend \u2014 ${window.etData.metric || 'all'} enrollment, by ${groupWord}, from ${window.etData.labels[0]} to ${window.etData.labels[n-1]}: ${trend}.\nProvide 3\u20135 concise numbered insights about which ${groupWord}s are growing or shrinking over time.`;
      }
      case 'heatmapCard': {
        if (!window.hmData?.rows?.length) return null;
        const isCount = window.hmData.metric === 'count';
        const top = window.hmData.rows.slice(0,6).map(r => {
          const yls = (window.hmData.year_levels||[]).map(yl => {
            const v = r[yl]; return v!=null ? `${yl}:${isCount?v+' students':v.toFixed(1)+'%'}` : null;
          }).filter(Boolean).join(' ');
          return `${r.label}(${yls})`;
        }).join('; ');
        return `You are an academic analytics assistant for ${INST}.\n${ctx}Risk Histogram \u2014 ${window.HM_STATUS_LABELS?.[window.HF?.status]||'Failed'} rates: ${top}.\nProvide 3\u20135 concise numbered insights about risk patterns by college/year level and recommended interventions.`;
      }
      case 'perfCard': {
        if (!window.perfData?.rows?.length) return null;
        const top = window.perfData.rows.slice(0,5).map((r,i) =>
          `${i+1}.${r.label}:GWA${r.avg_gwa_score?.toFixed(1)}% Pass${r.passing_rate?.toFixed(1)}% Ret${r.retention_rate?.toFixed(1)}%`
        ).join('; ');
        return `You are an academic analytics assistant for ${INST}. ${SCALE}\n${ctx}Academic Performance leaderboard: ${top}.\nProvide 3\u20135 concise numbered insights about strengths, weaknesses, and recommendations.`;
      }
      case 'genderCard':
        return `You are an academic analytics assistant for ${INST}.\n${ctx}Analyze gender-disaggregated academic status distribution. Provide 3\u20134 concise numbered insights about what gender gaps in academic outcomes typically indicate and what administrators should examine.`;
      case 'hardestCard': {
        const subs = window.hsData?.subjects || window.hsData?.ranked || [];
        if (!subs.length) return null;
        const top = subs.slice(0,6).map((s,i)=>`${i+1}.${s.title||s.code}(${s.fail_rate!=null?(s.fail_rate*100).toFixed(1)+'%':'?'})`).join(' ');
        return `You are an academic analytics assistant for ${INST}.\n${ctx}Top subjects by failure rate: ${top}.\nProvide 3\u20135 concise numbered insights about patterns and practical curriculum/support interventions.`;
      }
      default: return null;
    }
  }

  /* TEMPORARY fallback: the AI service (/api/dash/insights/generate) is not available, so a hard-coded
     sample insight is shown instead. It says so explicitly and contains no real figures. Remove this
     block (and the applyFallback() calls) once the AI endpoint exists. */
  const FALLBACK_INSIGHT = {
    kpiCard: [
      "1. Read enrollment, average GWA and the at-risk count together. A rising at-risk count with steady enrollment points to academic pressure rather than a change in intake.",
      "2. Check the regular/irregular split. A growing irregular share usually means more students are carrying back subjects.",
      "3. Suggested action: ask program chairs to review the at-risk list early in the term and schedule advising before midterms."
    ].join("\n"),
    kpiTrendCard: [
      "1. Look at which colleges or programs are moving in the opposite direction from the overall line; those are the ones to investigate first.",
      "2. A status that rises for several consecutive semesters is a pattern, not noise. A single-semester spike may be a one-off.",
      "3. Suggested action: share the groups with the sharpest changes with their deans and agree on a follow-up target for next semester."
    ].join("\n"),
    enrollTrendCard: [
      "1. Compare the direction of total enrollment with the regular/irregular mix to see whether growth is coming from new intake or from students staying longer.",
      "2. Groups that shrink while others grow may need a closer look at retention rather than admissions.",
      "3. Suggested action: use this trend when planning section offerings and faculty load for the coming term."
    ].join("\n"),
    heatmapCard: [
      "1. The darkest cells mark the college, course and year-level combinations with the highest rates; start intervention planning there.",
      "2. Compare year levels within the same course. A high rate only in the early years suggests a bridging or foundation-subject issue.",
      "3. Suggested action: pair the highest-rate groups with tutoring or peer-mentoring and re-check the same cells next semester."
    ].join("\n"),
    perfCard: [
      "1. Departments at the top of the ranking can share what they do in advising and assessment with those at the bottom.",
      "2. Look at the gap between first and last place; a wide gap suggests uneven support rather than uniformly hard programs.",
      "3. Suggested action: schedule a short review with the lowest-ranked departments and agree on one improvement target."
    ].join("\n"),
    genderCard: [
      "1. Compare the status mix for male and female students. Small differences are normal; consistent gaps across semesters deserve attention.",
      "2. Check whether any gap is concentrated in specific colleges before drawing campus-wide conclusions.",
      "3. Suggested action: if a gap persists, review whether advising and support services reach both groups equally."
    ].join("\n"),
    hardestCard: [
      "1. Subjects at the top of the list combine many failures with a high failure rate; these are the first candidates for intervention.",
      "2. Look for patterns across the list, such as several math or foundation subjects, which would point to a shared prerequisite gap.",
      "3. Suggested action: offer review sessions or remedial support for the top subjects before the next enrollment period."
    ].join("\n"),
    _default: [
      "1. Compare the largest and smallest values on this chart to find where attention is needed first.",
      "2. Check whether the pattern holds across semesters before treating it as a trend.",
      "3. Suggested action: share the main finding with the relevant deans and agree on a follow-up."
    ].join("\n"),
  };
  /* Rule-based insight written from the data the chart already loaded from Python
     (insight-engine.js). Used instead of the AI service, which isn't available. */
  function applyEngine() {
    const txt = window.InsightEngine && window.InsightEngine.generate(_card, 'main');
    if (!txt) return false;
    textArea.innerText = txt;
    setDirty(true);
    setBadge('unsaved', 'Auto-generated from the current chart data (rule-based, no AI). Review, edit, then click Save.');
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
    if (!_card || !textArea) return;
    if (applyEngine()) return;   // real numbers from the loaded chart; skips the unavailable AI call
    const prompt = buildPrompt(_card);
    if (!prompt) {
      setBadge('error', 'Load the chart data first, then regenerate.');
      return;
    }
    if (loadEl) loadEl.classList.add('active');
    textArea.contentEditable = 'false';
    regenBtn.disabled = true;
    try {
      const res = await fetch('/api/dash/insights/generate', { method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type':'application/json'}, body: JSON.stringify({ prompt }) });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const text = (data.text || '').trim();
      if (text) {
        textArea.innerText = text;
        setDirty(true);
        setBadge('unsaved', 'AI draft \u2014 review and edit, then click Save to share');
      } else {
        applyFallback(prompt);   // empty response
      }
    } catch (e) {
      console.warn('[insights] AI unavailable, using temporary fallback:', e.message);
      applyFallback(prompt);
    } finally {
      if (loadEl) loadEl.classList.remove('active');
      textArea.contentEditable = 'true';
      regenBtn.disabled = false;
    }
  });

  /* ── Download as Word ────────────────────────────────────────────────── */
  _$('aiInsightsDownloadWord')?.addEventListener('click', () => {
    const title = TITLES[_card] || _card || '';
    const sub   = ctxEl?.textContent || '';
    const text  = textArea?.innerText || '';
    let imgHtml = '';
    if (_$('aiInsightsIncludeChart')?.checked) {
      const canvas = document.querySelector('#' + _card + ' .chart-area canvas');
      if (canvas) {
        const off = document.createElement('canvas');
        off.width = canvas.width; off.height = canvas.height;
        const c = off.getContext('2d');
        c.fillStyle='#fff'; c.fillRect(0,0,off.width,off.height); c.drawImage(canvas,0,0);
        imgHtml = '<img src="' + off.toDataURL('image/png') + '" style="max-width:100%;margin:12px 0;" alt="' + title + '">';
      }
    }
    const doc = '<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{font-family:Calibri,Arial,sans-serif;margin:2cm;color:#1f2937;line-height:1.7}h1{font-size:17pt;color:#7B1113;margin-bottom:2px}p.sub{font-size:10pt;color:#6b7280;margin:0 0 14px}hr{border:none;border-top:1px solid #e5e7eb;margin:14px 0}pre{font-family:inherit;font-size:11pt;white-space:pre-wrap;margin:0}footer{font-size:8pt;color:#9ca3af;margin-top:28px}</style></head><body><h1>'
      + title + '</h1><p class="sub">' + sub + '</p><hr>' + imgHtml + '<pre>' + text.replace(/</g,'&lt;')
      + '</pre><hr><footer>NovaSight Academic Analytics &middot; Bataan Peninsula State University<br>For informational purposes only.</footer></body></html>';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿'+doc],{type:'application/msword'}));
    a.download = 'novasight_insight_' + title.toLowerCase().replace(/[^a-z0-9]+/g,'_') + '.doc';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  /* ── Close: discard changes, revert text ────────────────────────────── */
  function closeModal() {
    if (_dirty) {
      if (_savedText) textArea.innerText = _savedText;
      else textArea.textContent = '';
      setDirty(false);
      setBadge(_savedText ? 'saved' : '', _savedText ? 'Saved — visible to all users' : '');
    }
    modal.classList.add('hidden');
  }
  _$('aiInsightsClose')?.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  /* ── Wire buttons ────────────────────────────────────────────────────── */
  document.querySelectorAll('[data-ai-card]').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.aiCard));
  });

});