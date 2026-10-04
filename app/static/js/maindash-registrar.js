/* maindash-registrar.js — Registrar-only additions to the Main Dashboard
 * Loaded AFTER maindash.js on the Registrar's maindashboardregistrar.html
 * ONLY. Uses maindash.js's shared helpers via window (exposed there for
 * exactly this purpose) and exposes window.loadKpiTrend / window.loadEnrollTrend
 * / window.REG back for maindash.js to call into.
 *
 * Contains:
 *   - Status Trend card (Status Breakdown, one metric at a time, by college/course)
 *   - Enrollment Trend card (All/Regular/Irregular, by college/course)
 *   - Per-chart Comparison buttons (KPI / Academic Performance) + the
 *     Global Filters bar's Comparison sync
 */
(function () {
'use strict';

// Program name -> acronym for chart labels (defined in maindash.js; colleges pass through).
const courseShort = x => (window.courseShort ? window.courseShort(x) : x);

/* ══════════════════════════════════════════════════════════════════════════
   1b. KPI TREND — Status Breakdown, one metric at a time, broken down by
   College (or by Course if a Department filter is active) across every
   recorded semester. Same grouping convention as the Heatmap. (The
   Prediction dashboard has the forecast counterpart, built from
   pred_cube.pkl instead of this DS01/CSV-backed endpoint.)
   ══════════════════════════════════════════════════════════════════════════ */
let KTF = { dept: '', course: '', yearlevel: '' };
let ktMetric = 'FAILED';
let ktData = null;
const KT_METRICS = {
  FAILED: 'Failed', DRP: 'Drop', INC: 'Incomplete',
  UDR: 'Unofficial Drop', W: 'Withdrawn', NGA: 'No Grade',
};

const COMPARE_DESC = {
  '':     '',
  '1sem': '1st Semester only, year-over-year',
  '2sem': '2nd Semester only, year-over-year',
};

function ktScopeOf() {
  const p = new URLSearchParams();
  if (KTF.dept)      p.set('dept', KTF.dept);
  if (KTF.course)    p.set('course', KTF.course);
  if (KTF.yearlevel) p.set('yearlevel', KTF.yearlevel);
  p.set('metric', ktMetric);
  const cmp = $('kpiTrendCompare')?.value || '';
  if (cmp) p.set('compare', cmp);
  return p;
}

async function loadKpiTrend() {
  const area = $('kpiTrendArea');
  if (!area) return;   // this dashboard variant doesn't ship this card
  skOn('kpiTrendCard');
  loading('kpiTrendArea');
  try {
    const res = await fetch('/api/dash/kpi-trend?' + ktScopeOf().toString());
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    ktData = d; window.ktData = d;
    if (!d.labels?.length || !d.datasets?.length) { ktData = null; window.ktData = null; empty('kpiTrendArea', 'No data for these filters.'); return; }
    const sub = $('kpiTrendSubtitle');
    const cmpDesc = COMPARE_DESC[d.compare || ''];
    if (sub) sub.textContent = `${KT_METRICS[ktMetric] || ktMetric} by ${d.group_by === 'course' ? 'program' : 'college'} across ${d.labels.length} recorded semester${d.labels.length === 1 ? '' : 's'} \u00b7 ${scopeTextKt()}` + (cmpDesc ? ` \u00b7 ${cmpDesc}` : '');
    renderKpiTrend();
  } catch (e) {
    console.error(e);
    ktData = null; window.ktData = null;
    empty('kpiTrendArea', 'Could not load the KPI trend.');
  } finally {
    skDone('kpiTrendCard');
  }
}

function scopeTextKt() {
  const parts = [];
  if (KTF.dept)      parts.push(KTF.dept);
  if (KTF.course)    parts.push(KTF.course);
  if (KTF.yearlevel) parts.push(KTF.yearlevel + ' year');
  return parts.length ? parts.join(', ') : 'All colleges';
}

function renderKpiTrend() {
  const area = $('kpiTrendArea');
  if (!area || !ktData) return;
  area.innerHTML = '<canvas id="kpiTrendChart"></canvas>';
  const datasets = ktData.datasets.map((ds, i) => {
    const color = _perfColor(ds.label, i);
    return {
      label: courseShort(ds.label),
      data: ds.data,
      borderColor: color,
      backgroundColor: color,
      pointBackgroundColor: color,
      tension: 0.3,
      spanGaps: true,
      pointRadius: 3,
      pointHoverRadius: 5,
      borderWidth: 2,
    };
  });
  makeChart('kpiTrendChart', {
    type: 'line',
    data: { labels: ktData.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 11 }, padding: 10 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.raw == null ? '\u2014' : Number(ctx.raw).toLocaleString()} students`,
          },
        },
        datalabels: {
          display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
          anchor: 'end', align: 'top', offset: 4, clip: false,
          font: { size: 9 }, color: ctx => ctx.dataset.borderColor,
          formatter: v => v == null ? '' : Number(v).toLocaleString(),
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 30 } },
        y: { beginAtZero: true, title: { display: true, text: KT_METRICS[ktMetric] || ktMetric }, ticks: { precision: 0 } },
      },
    },
  });
  area.classList.add('clickable');
}

function kpiTrendTableRows() {
  if (!ktData) return [];
  return ktData.labels.map((label, i) => {
    const row = { 'Semester': label };
    ktData.datasets.forEach(ds => { row[ds.label] = ds.data[i] == null ? '\u2014' : ds.data[i]; });
    return row;
  });
}
function renderKpiTrendTable() {
  const rows = kpiTrendTableRows();
  const inner = $('kpiTrendTableInner');
  if (!inner) return;
  if (!rows.length) { inner.innerHTML = '<div class="chart-empty">No data.</div>'; return; }
  const headers = Object.keys(rows[0]);
  ktTableHeaders = headers;
  inner.innerHTML = `<table class="dash-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => `<tr>${headers.map(h => `<td>${r[h]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
let ktTableHeaders = [];

document.addEventListener('DOMContentLoaded', () => {
  initFilterPopover({ toggleId: 'kpiTrendFilterToggle', popoverId: 'kpiTrendFilterPopover',
                       closeId: 'kpiTrendFilterClose', applyId: 'kpiTrendBtnApply' });

  document.querySelectorAll('[data-kt-metric]').forEach(b => b.addEventListener('click', () => {
    ktMetric = b.dataset.ktMetric;
    document.querySelectorAll('[data-kt-metric]').forEach(x => x.classList.toggle('active', x.dataset.ktMetric === ktMetric));
    loadKpiTrend();
  }));
  document.querySelectorAll('[data-kt-compare]').forEach(b => b.addEventListener('click', () => {
    const sel = $('kpiTrendCompare'); if (!sel) return;
    sel.value = b.dataset.ktCompare;
    document.querySelectorAll('[data-kt-compare]').forEach(x => x.classList.toggle('active', x.dataset.ktCompare === sel.value));
    loadKpiTrend();
  }));

  $('kpiTrendBtnApply')?.addEventListener('click', () => {
    KTF = {
      dept:      $('kpiTrend-dept')?.value || '',
      course:    $('kpiTrend-course')?.value || '',
      yearlevel: $('kpiTrend-yearlevel')?.value || '',
    };
    loadKpiTrend();
  });
  $('kpiTrendBtnReset')?.addEventListener('click', () => {
    KTF = { dept: '', course: '', yearlevel: '' };
    if ($('kpiTrend-dept'))      $('kpiTrend-dept').value = '';
    if ($('kpiTrend-course'))    $('kpiTrend-course').value = '';
    if ($('kpiTrend-yearlevel')) $('kpiTrend-yearlevel').value = '';
    ktMetric = 'FAILED';
    document.querySelectorAll('[data-kt-metric]').forEach(x => x.classList.toggle('active', x.dataset.ktMetric === 'FAILED'));
    if ($('kpiTrendCompare')) $('kpiTrendCompare').value = '';
    document.querySelectorAll('[data-kt-compare]').forEach(x => x.classList.toggle('active', x.dataset.ktCompare === ''));
    loadKpiTrend();
  });
  $('kpiTrend-dept')?.addEventListener('change', () => _fillCourses('kpiTrend-dept', 'kpiTrend-course'));

  const ktModal = initTableModal({ openId: 'kpiTrendViewTable', modalId: 'kpiTrendTableModal',
                                    closeId: 'kpiTrendTableModalClose', onOpen: renderKpiTrendTable });
  $('kpiTrendArea')?.addEventListener('click', () => { if (ktData && ktModal.open) ktModal.open(); });
  $('kpiTrendTableDownloadCsv')?.addEventListener('click', () => {
    const rows = kpiTrendTableRows();
    if (rows.length) downloadCsv(rows, ktTableHeaders.length ? ktTableHeaders : Object.keys(rows[0]), 'status_trend');
  });
});

/* ══════════════════════════════════════════════════════════════════════════
   1c. ENROLLMENT TREND — Total Enrollment, one metric at a time (All /
   Regular / Irregular), broken down by College (or Course if a Department
   filter is active) across every recorded semester. A separate card from
   KPI Trend's Status Breakdown. (The Prediction dashboard has the forecast
   counterpart, built from pred_cube.pkl.)
   ══════════════════════════════════════════════════════════════════════════ */
let ETF = { dept: '', course: '', yearlevel: '' };
let etMetric = 'all';
let etData = null;
const ET_METRICS = { all: 'All', regular: 'Regular', irregular: 'Irregular' };

function etScopeOf() {
  const p = new URLSearchParams();
  if (ETF.dept)      p.set('dept', ETF.dept);
  if (ETF.course)    p.set('course', ETF.course);
  if (ETF.yearlevel) p.set('yearlevel', ETF.yearlevel);
  p.set('metric', etMetric);
  const cmp = $('enrollTrendCompare')?.value || '';
  if (cmp) p.set('compare', cmp);
  return p;
}

async function loadEnrollTrend() {
  const area = $('enrollTrendArea');
  if (!area) return;   // this dashboard variant doesn't ship this card
  skOn('enrollTrendCard');
  loading('enrollTrendArea');
  try {
    const res = await fetch('/api/dash/enrollment-trend?' + etScopeOf().toString());
    const d = await res.json();
    if (d.error) throw new Error(d.error);
    etData = d; window.etData = d;
    if (!d.labels?.length || !d.datasets?.length) { etData = null; window.etData = null; empty('enrollTrendArea', 'No data for these filters.'); return; }
    const sub = $('enrollTrendSubtitle');
    const cmpDesc = COMPARE_DESC[d.compare || ''];
    if (sub) sub.textContent = `${ET_METRICS[etMetric] || etMetric} enrollment by ${d.group_by === 'course' ? 'program' : 'college'} across ${d.labels.length} recorded semester${d.labels.length === 1 ? '' : 's'} \u00b7 ${scopeTextEt()}` + (cmpDesc ? ` \u00b7 ${cmpDesc}` : '');
    renderEnrollTrend();
  } catch (e) {
    console.error(e);
    etData = null; window.etData = null;
    empty('enrollTrendArea', 'Could not load the enrollment trend.');
  } finally {
    skDone('enrollTrendCard');
  }
}

function scopeTextEt() {
  const parts = [];
  if (ETF.dept)      parts.push(ETF.dept);
  if (ETF.course)    parts.push(ETF.course);
  if (ETF.yearlevel) parts.push(ETF.yearlevel + ' year');
  return parts.length ? parts.join(', ') : 'All colleges';
}

function renderEnrollTrend() {
  const area = $('enrollTrendArea');
  if (!area || !etData) return;
  area.innerHTML = '<canvas id="enrollTrendChart"></canvas>';
  const datasets = etData.datasets.map((ds, i) => {
    const color = _perfColor(ds.label, i);
    return {
      label: courseShort(ds.label),
      data: ds.data,
      borderColor: color,
      backgroundColor: color,
      pointBackgroundColor: color,
      tension: 0.3,
      spanGaps: true,
      pointRadius: 3,
      pointHoverRadius: 5,
      borderWidth: 2,
    };
  });
  makeChart('enrollTrendChart', {
    type: 'line',
    data: { labels: etData.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: true, position: 'top', labels: { boxWidth: 10, font: { size: 11 }, padding: 10 } },
        tooltip: {
          callbacks: {
            label: ctx => ` ${ctx.dataset.label}: ${ctx.raw == null ? '\u2014' : Number(ctx.raw).toLocaleString()} students`,
          },
        },
        datalabels: {
          display: ctx => ctx.dataset.data[ctx.dataIndex] != null,
          anchor: 'end', align: 'top', offset: 4, clip: false,
          font: { size: 9 }, color: ctx => ctx.dataset.borderColor,
          formatter: v => v == null ? '' : Number(v).toLocaleString(),
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 11 }, maxRotation: 30 } },
        y: { beginAtZero: true, title: { display: true, text: ET_METRICS[etMetric] || etMetric }, ticks: { precision: 0 } },
      },
    },
  });
  area.classList.add('clickable');
}

function enrollTrendTableRows() {
  if (!etData) return [];
  return etData.labels.map((label, i) => {
    const row = { 'Semester': label };
    etData.datasets.forEach(ds => { row[ds.label] = ds.data[i] == null ? '\u2014' : ds.data[i]; });
    return row;
  });
}
function renderEnrollTrendTable() {
  const rows = enrollTrendTableRows();
  const inner = $('enrollTrendTableInner');
  if (!inner) return;
  if (!rows.length) { inner.innerHTML = '<div class="chart-empty">No data.</div>'; return; }
  const headers = Object.keys(rows[0]);
  etTableHeaders = headers;
  inner.innerHTML = `<table class="dash-table"><thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead>` +
    `<tbody>${rows.map(r => `<tr>${headers.map(h => `<td>${r[h]}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}
let etTableHeaders = [];

document.addEventListener('DOMContentLoaded', () => {
  initFilterPopover({ toggleId: 'enrollTrendFilterToggle', popoverId: 'enrollTrendFilterPopover',
                       closeId: 'enrollTrendFilterClose', applyId: 'enrollTrendBtnApply' });

  document.querySelectorAll('[data-et-metric]').forEach(b => b.addEventListener('click', () => {
    etMetric = b.dataset.etMetric;
    document.querySelectorAll('[data-et-metric]').forEach(x => x.classList.toggle('active', x.dataset.etMetric === etMetric));
    loadEnrollTrend();
  }));
  document.querySelectorAll('[data-et-compare]').forEach(b => b.addEventListener('click', () => {
    const sel = $('enrollTrendCompare'); if (!sel) return;
    sel.value = b.dataset.etCompare;
    document.querySelectorAll('[data-et-compare]').forEach(x => x.classList.toggle('active', x.dataset.etCompare === sel.value));
    loadEnrollTrend();
  }));

  $('enrollTrendBtnApply')?.addEventListener('click', () => {
    ETF = {
      dept:      $('enrollTrend-dept')?.value || '',
      course:    $('enrollTrend-course')?.value || '',
      yearlevel: $('enrollTrend-yearlevel')?.value || '',
    };
    loadEnrollTrend();
  });
  $('enrollTrendBtnReset')?.addEventListener('click', () => {
    ETF = { dept: '', course: '', yearlevel: '' };
    if ($('enrollTrend-dept'))      $('enrollTrend-dept').value = '';
    if ($('enrollTrend-course'))    $('enrollTrend-course').value = '';
    if ($('enrollTrend-yearlevel')) $('enrollTrend-yearlevel').value = '';
    etMetric = 'all';
    document.querySelectorAll('[data-et-metric]').forEach(x => x.classList.toggle('active', x.dataset.etMetric === 'all'));
    if ($('enrollTrendCompare')) $('enrollTrendCompare').value = '';
    document.querySelectorAll('[data-et-compare]').forEach(x => x.classList.toggle('active', x.dataset.etCompare === ''));
    loadEnrollTrend();
  });
  $('enrollTrend-dept')?.addEventListener('change', () => _fillCourses('enrollTrend-dept', 'enrollTrend-course'));

  const etModal = initTableModal({ openId: 'enrollTrendViewTable', modalId: 'enrollTrendTableModal',
                                    closeId: 'enrollTrendTableModalClose', onOpen: renderEnrollTrendTable });
  $('enrollTrendArea')?.addEventListener('click', () => { if (etData && etModal.open) etModal.open(); });
  $('enrollTrendTableDownloadCsv')?.addEventListener('click', () => {
    const rows = enrollTrendTableRows();
    if (rows.length) downloadCsv(rows, etTableHeaders.length ? etTableHeaders : Object.keys(rows[0]), 'enrollment_trend');
  });
});
/* ── Per-chart Comparison buttons (KPI / Academic Performance) ──────────────
   Visible replacement for the old per-chart Comparison dropdown (the Sex &
   Status Breakdown card never had one, so it's untouched). Clicking a button
   sets that chart's own hidden Comparison select and reloads just that
   chart. syncCompareBtns() re-highlights the right button whenever something
   else (the Global Filters bar) sets the select directly. */
function syncCompareBtns() {
  document.querySelectorAll('[data-kpi-compare]').forEach(b =>
    b.classList.toggle('active', b.dataset.kpiCompare === (document.getElementById('kpiCompare')?.value || '')));
  document.querySelectorAll('[data-perf-compare]').forEach(b =>
    b.classList.toggle('active', b.dataset.perfCompare === (document.getElementById('perfCompare')?.value || '')));
  document.querySelectorAll('[data-kt-compare]').forEach(b =>
    b.classList.toggle('active', b.dataset.ktCompare === (document.getElementById('kpiTrendCompare')?.value || '')));
  document.querySelectorAll('[data-et-compare]').forEach(b =>
    b.classList.toggle('active', b.dataset.etCompare === (document.getElementById('enrollTrendCompare')?.value || '')));
}
document.querySelectorAll('[data-kpi-compare]').forEach(b => b.addEventListener('click', () => {
  const sel = document.getElementById('kpiCompare'); if (!sel) return;
  sel.value = b.dataset.kpiCompare; syncCompareBtns();
  if (typeof loadKpi === 'function') loadKpi();
}));
document.querySelectorAll('[data-perf-compare]').forEach(b => b.addEventListener('click', () => {
  const sel = document.getElementById('perfCompare'); if (!sel) return;
  sel.value = b.dataset.perfCompare; syncCompareBtns();
  if (typeof loadPerformance === 'function') loadPerformance();
}));

/* ── Global comparison: pushes one value into every chart's Comparison select ──
   Same pattern as prediction-dash.js's global bar. Guarded on #globalCompare
   existing, so this only runs on dashboards that actually ship that control
   (currently the Registrar main dashboard) — everyone else's per-chart
   Comparison dropdowns are left exactly as they were. */
document.addEventListener('click', e => {
  const g = document.getElementById('globalCompare');
  if (!g) return;
  const b = e.target.closest && e.target.closest('#globalBtnApply, #globalBtnReset');
  if (!b) return;
  const v = b.id === 'globalBtnReset' ? '' : g.value;
  if (b.id === 'globalBtnReset') g.value = '';
  document.querySelectorAll('select[id$="Compare"]').forEach(sel => { sel.value = v; });
  syncCompareBtns();
  setTimeout(() => {
    if (typeof loadKpi === 'function') loadKpi();
    if (typeof loadPerformance === 'function') loadPerformance();
    loadKpiTrend();
    loadEnrollTrend();
  }, 60);
}, true);

window.loadKpiTrend = loadKpiTrend;
window.loadEnrollTrend = loadEnrollTrend;
window.REG = {
  ktFilters: () => ({ ...KTF, metric: ktMetric }),
  etFilters: () => ({ ...ETF, metric: etMetric }),
};

})();