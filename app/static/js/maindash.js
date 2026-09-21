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
const SK_CARDS = ['kpiCard', 'heatmapCard', 'genderCard', 'hardestCard'];
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
  const color = up === null ? '#4b5563' : (up ? '#15803d' : '#b91c1c');
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
async function initDashboard() {
  try {
    const res = await fetch('/api/dash/meta');
    if (!res.ok) throw new Error('meta ' + res.status);
    const meta = await res.json();
    window._metaYears   = meta.years || [];
    window._metaDepts   = meta.departments || [];
    window._allCourses  = meta.courses || [];
    window._ayToSems    = meta.ay_to_sems || {};

    // Populate KPI year filter
    fillSelect('kpi-year', window._metaYears,
      y => { const yr=parseInt(y); return `${yr}-${yr+1}`; }, y=>y);

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
    fillSelect('hmYear', window._metaYears,
      y => { const yr=parseInt(y); return `${yr}-${yr+1}`; }, y=>y);
    _populateSemesters('hmSem', meta.recent_year || '');
    const hmYearSel = $('hmYear');
    if (hmYearSel && meta.recent_year) { hmYearSel.value = meta.recent_year; HF.year = meta.recent_year; }
    const hmSemSel = $('hmSem');
    if (hmSemSel && meta.recent_sem)   { hmSemSel.value = meta.recent_sem;   HF.sem  = meta.recent_sem; }
    fillSelect('hmDept', window._metaDepts);
    _fillCourses('hmDept', 'hmCourse');

    // Gender & Status: same academic-year / semester defaults as the KPI card + heatmap
    fillSelect('gdYear', window._metaYears,
      y => { const yr=parseInt(y); return `${yr}-${yr+1}`; }, y=>y);
    _populateSemesters('gdSem', meta.recent_year || '');
    const gdYearSel = $('gdYear');
    if (gdYearSel && meta.recent_year) { gdYearSel.value = meta.recent_year; GDF.year = meta.recent_year; }
    const gdSemSel = $('gdSem');
    if (gdSemSel && meta.recent_sem)   { gdSemSel.value = meta.recent_sem;   GDF.sem  = meta.recent_sem; }
    fillSelect('gdDept', window._metaDepts);
    _fillCourses('gdDept', 'gdCourse');

    // Hardest Subjects: same academic-year / semester defaults as the other cards
    fillSelect('hsYear', window._metaYears,
      y => { const yr=parseInt(y); return `${yr}-${yr+1}`; }, y=>y);
    _populateSemesters('hsSem', meta.recent_year || '');
    const hsYearSel = $('hsYear');
    if (hsYearSel && meta.recent_year) { hsYearSel.value = meta.recent_year; HSF.year = meta.recent_year; }
    const hsSemSel = $('hsSem');
    if (hsSemSel && meta.recent_sem)   { hsSemSel.value = meta.recent_sem;   HSF.sem  = meta.recent_sem; }
    fillSelect('hsDept', window._metaDepts);
    _fillCourses('hsDept', 'hsCourse');

  } catch(e) {
    console.error('Dashboard meta failed:', e);
  }

  // Load all charts
  loadKpi();
  loadHeatmap();
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
  semSel.innerHTML = '<option value="">All</option>';
  const sems = (window._ayToSems || {})[yr] || [];
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
    if (el) el.textContent = 'Error';
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
  Object.entries(HF).forEach(([k, v]) => { if (v) p.set(k, v); });

  $('hmChartArea')?.classList.remove('clickable');   // no click-to-table hint while loading / empty
  loading('hmChartArea');
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

function renderHeatmap(data) {
  const area = $('hmChartArea');
  if (!data?.rows?.length) { empty('hmChartArea', data?.note || undefined); return; }

  const yls = data.year_levels || ['1','2','3','4','IRREG'];
  const maxV = data.max_val || 1;
  const ylLabels = {1:'1st',2:'2nd',3:'3rd',4:'4th',5:'5th',IRREG:'Irreg'};
  const statusLabel = HM_STATUS_LABELS[HF.status] || 'Failed';
  const isCount = data.metric === 'count';
  // Colour = share of the enrolled students who have the status, on a fixed 0–100% scale.
  // So a cell keeps the same colour in Percentage and No. of Students view, and a small
  // number of students in a big population stays green. Only if the API sent no enrolled
  // totals (old DS02 fallback) do we fall back to colouring relative to the biggest value.
  const hasEnrolled = data.rows.some(r => r.enrolled);
  const ratioScale  = !isCount || hasEnrolled;

  // Old backend (no `basis`): percentages come from DS02's status_rate, which isn't students ÷ enrolled.
  const staleApi = data.basis !== 'students';
  if (staleApi) console.warn('Heatmap: /api/dash/heatmap is not returning student-based data — update maindash_routes.py.');

  let html = (staleApi ? `<div class="hm-notice">⚠ The server is still using the old heatmap calculation, so percentages
      may not match the student counts. Replace <b>maindash_routes.py</b> with the latest version and restart the app.</div>` : '')
    + `<div class="hm-figure">
    <div class="hm-y-title">Course / Dept</div>
    <div class="hm-main">
      <div class="heatmap-wrap"><table class="heatmap-table">
        <thead><tr><th></th>${yls.map(y=>`<th>${ylLabels[y]||y}</th>`).join('')}</tr></thead>
        <tbody>`;

  data.rows.forEach(row => {
    html += `<tr><td class="heatmap-row-label" title="${row.label}">${row.label}</td>`;
    yls.forEach(yl => {
      const v = row[yl];
      if (v == null) {
        html += `<td class="heatmap-empty" title="${row.label} / ${yl}: no data">—</td>`;
        return;
      }
      // Tooltip: "69 of 150 students (46.0%)" when the API sends the enrolled / with-status counts
      const n = row.enrolled?.[yl], k = row.with_status?.[yl];
      let t;
      if (n != null && k != null) t = n > 0 ? k / n : 0;
      else                        t = ratioScale ? v / 100 : v / maxV;
      const rgb = hmColor(t);
      const detail = (n != null && k != null)
        ? `${k.toLocaleString()} of ${n.toLocaleString()} students (${n > 0 ? (k / n * 100).toFixed(1) : '0.0'}%)`
        : `${hmFormat(v, isCount)}${isCount ? ' students' : ''}`;
      html += `<td style="background:${hmRgb(rgb)};color:${hmTextColor(rgb)}" title="${row.label} / ${yl}: ${detail}">${hmFormat(v, isCount)}</td>`;
    });
    html += '</tr>';
  });
  html += '</tbody></table></div>';
  html += '<div class="hm-x-title">Year Level</div></div>';

  // Colour bar: 0% at the bottom, 100% of enrolled students at the top
  // (count view with no enrolled totals: 0 → biggest count instead)
  const gradient = HM_STOPS.map((c, i) => `${hmRgb(c)} ${(i / (HM_STOPS.length - 1) * 100).toFixed(1)}%`).join(',');
  const ticks = [1, 0.75, 0.5, 0.25, 0].map(f =>
    `<span>${ratioScale ? Math.round(f * 100) + '%' : Math.round(maxV * f).toLocaleString()}</span>`).join('');
  const legendTitle = hasEnrolled ? `${statusLabel} — % of enrolled students`
                    : isCount     ? `${statusLabel} (no. of students)`
                                  : `${statusLabel} rate (%)`;
  html += `<div class="hm-legend">
      <div class="hm-legend-bar" style="background:linear-gradient(to top,${gradient})"></div>
      <div class="hm-legend-ticks">${ticks}</div>
      <div class="hm-legend-title">${legendTitle}</div>
    </div></div>`;

  area.innerHTML = html;
  area.classList.add('clickable');   // show the "Click to view as table" hint
}

function renderHeatmapTable(data) {
  if (!data?.rows) return;
  const yls = data.year_levels || [];
  const ylLabels = {1:'1st',2:'2nd',3:'3rd',4:'4th',5:'5th',IRREG:'Irreg'};
  const headers = ['Course/Dept', ...yls.map(y => ylLabels[y] || y)];
  const rows = data.rows.map(r => {
    const o = {'Course/Dept': r.label};
    yls.forEach(yl => { o[ylLabels[yl] || yl] = r[yl]!=null ? hmFormat(r[yl], data.metric === 'count') : '—'; });
    return o;
  });
  buildTable('hmTableInner', rows, headers, headers[1] || 'Course/Dept', 'desc', {
    filename: 'heatmap_data',
    title: 'Heatmap Breakdown',
    description: 'Values by course/department across year levels for the currently selected filters.',
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

async function loadGenderPie() {
  const reqId = ++gdReqId;
  const p = new URLSearchParams();
  Object.entries(GDF).forEach(([k, v]) => { if (v) p.set(k, v); });
  if (gdEnroll !== 'all') p.set('enroll_type', gdEnroll);
  if (gdMetric !== 'all') p.set('status', gdMetric);
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
      acc.colors.push(pie.colors?.[i] || GD_STATUS_COLORS[lbl] || '#9ca3af');
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
          display: true, position: 'bottom',
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
    html += `<tr><td class="gd-dept">${gdEsc(row.dept)}</td>`;
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
  if (titleEl) titleEl.textContent = subj ? `${subj.label || subj.code} — Table View` : 'Top Hardest Subjects — Table View';
  buildTable('hsTableInner', hsTableRows(code), HS_TABLE_HEADERS, '#', 'asc', {
    filename: subj ? `hardest_subjects_${subj.code}` : 'hardest_subjects',
    title: subj ? `${subj.label || subj.code} — Subject Detail` : 'Top Hardest Subjects',
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
        <div class="rb-meta">${s.dept || '—'} · ${n.toLocaleString()} ${n===1?'student':'students'}</div>
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
  const colors = ['#800000','#4E73DF','#1CC88A','#E74A3B','#8A2BE2','#36B9CC','#d97706'];
  makeChart('hsTrendCanvas', {
    type:'line',
    data: { labels:data.trend_labels,
      datasets:data.trend.map((s,i)=>({
        label:s.label, data:s.values,
        borderColor:colors[i%colors.length],
        backgroundColor:colors[i%colors.length]+'20',
        tension:0.3, pointRadius: isNarrow() ? 2.5 : 4, borderWidth: isNarrow() ? 1.6 : 3, fill:false })) },
    options: { responsive:true, maintainAspectRatio:false,
      plugins:{legend:{display: !(isNarrow() && data.trend.length > 6), position:'bottom',labels:{font:{size: fs},boxWidth: isNarrow() ? 8 : 12, padding: isNarrow() ? 8 : 10}},
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
initFilterPopover({ toggleId:'kpiFilterToggle', popoverId:'kpiFilterPopover', closeId:'kpiFilterClose', applyId:'kpiBtnApply' });
initFilterPopover({ toggleId:'hmFilterToggle',  popoverId:'hmFilterPopover',  closeId:'hmFilterClose',  applyId:'hmBtnApply'  });
initFilterPopover({ toggleId:'gdFilterToggle',  popoverId:'gdFilterPopover',  closeId:'gdFilterClose',  applyId:'gdBtnApply'  });
initFilterPopover({ toggleId:'hsFilterToggle',  popoverId:'hsFilterPopover',  closeId:'hsFilterClose',  applyId:'hsBtnApply'  });

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

/* ── Skeleton loading: wrap each card's loader ─────────────────────────── */
{ const _o = loadKpi;            loadKpi            = function () { skOn('kpiCard');     return Promise.resolve(_o.apply(this, arguments)).finally(() => skDone('kpiCard')); }; }
{ const _o = loadHeatmap;        loadHeatmap        = function () { skOn('heatmapCard'); return Promise.resolve(_o.apply(this, arguments)).finally(() => skDone('heatmapCard')); }; }
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

/* ── INIT ────────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initDashboard);

})();