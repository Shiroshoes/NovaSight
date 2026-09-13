// ── Algorithm-type breakdown (KPI formulas / donut / bar / warnings) ──
// Linear Regression = green, Random Forest Regression = blue,
// Random Forest Classifier = violet.
const ALGO_META = {
  linreg: { label: 'Linear Regression',       color: '#1cc88a', formula: 'ŷ = β₀ + β₁x₁ + β₂x₂ + ... + βₙxₙ',
            desc: 'A straight-line trend fit, used for every forecast target (GWA, enrollment, INC/irregular/drop rate).' },
  rfreg:  { label: 'Random Forest Regression', color: '#2A86FD', formula: 'ŷ = (1/T) · Σ Treeₜ(x),  t = 1...T',
            desc: 'Averages many decision trees. More flexible than a straight line, but can\'t extrapolate past its training years.' },
  rfclf:  { label: 'Random Forest Classifier', color: '#8e44ad', formula: 'ŷ = mode{ Tree₁(x), Tree₂(x), ..., Treeₜ(x) }',
            desc: 'Each tree votes on a class (e.g. at-risk vs. safe); the majority vote wins.' },
};
// Tie-break order when two types have the same model count: Linear
// Regression wins, then Random Forest Regression, then Random Forest
// Classifier.
const ALGO_ORDER = ['linreg', 'rfreg', 'rfclf'];

// Classifies a model into one of ALGO_ORDER. Prefers an explicit
// `algorithm` field from the backend (e.g. "LinearRegression",
// "RandomForestRegressor", "RandomForestClassifier") — add this field
// to /api/get_model_metrics's response for exact grouping. Falls back
// to guessing from `model.type` (classification -> Random Forest
// Classifier, everything else -> Linear Regression), same convention
// buildCard() below already uses for its typeLabel.
function classifyAlgorithm(model) {
  const algo = (model.algorithm || '').toLowerCase();
  if (algo.includes('randomforestclassifier')) return 'rfclf';
  if (algo.includes('randomforestregressor')) return 'rfreg';
  if (algo.includes('linearregression') || algo.includes('ridge')) return 'linreg';
  return model.type === 'classification' ? 'rfclf' : 'linreg';
}

// Headline metric used for the breakdown bar chart and warnings —
// Accuracy for classifiers, R² for regressors, same pairing
// splitMetrics() below treats as "primary".
function headlineValue(model) {
  if (!model.metrics) return null;
  if (model.metrics.accuracy !== undefined) return model.metrics.accuracy;
  if (model.metrics.r2 !== undefined) return model.metrics.r2;
  return null;
}

function headlineQualityClass(v) {
  if (v === null || v === undefined) return 'val-poor';
  if (v >= 0.85) return 'val-great';
  if (v >= 0.65) return 'val-good';
  if (v >= 0.40) return 'val-fair';
  return 'val-poor';
}

let _typeDonutChart, _typeScoreChart;

function renderAlgorithmTypeCharts(models) {
  const counts = { linreg: 0, rfreg: 0, rfclf: 0 };
  models.forEach(m => counts[classifyAlgorithm(m)]++);

  const donutCtx = document.getElementById('typeDonutChart');
  if (donutCtx && window.Chart) {
    if (_typeDonutChart) _typeDonutChart.destroy();
    _typeDonutChart = new Chart(donutCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ALGO_ORDER.map(t => ALGO_META[t].label),
        datasets: [{
          data: ALGO_ORDER.map(t => counts[t]),
          backgroundColor: ALGO_ORDER.map(t => ALGO_META[t].color),
          borderColor: '#fff',
          borderWidth: 3,
        }]
      },
      options: { maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } } }
    });
  }

  const scored = models.filter(m => headlineValue(m) !== null);
  const scoreCtx = document.getElementById('typeScoreChart');
  if (scoreCtx && window.Chart && scored.length) {
    if (_typeScoreChart) _typeScoreChart.destroy();
    _typeScoreChart = new Chart(scoreCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: scored.map(m => m.name),
        datasets: [{
          label: 'Headline score',
          data: scored.map(m => headlineValue(m) * 100),
          backgroundColor: scored.map(m => ALGO_META[classifyAlgorithm(m)].color),
          borderRadius: 4,
        }]
      },
      options: {
        maintainAspectRatio: false,
        indexAxis: scored.length > 6 ? 'y' : 'x',
        scales: { x: { ticks: { autoSkip: false, font: { size: 9 } } }, y: { beginAtZero: true, max: 100, ticks: { callback: v => v + '%' } } },
        plugins: {
          // A single-dataset bar chart with per-bar colors gets no
          // legend from Chart.js itself (there's only one "series") —
          // the dot-legend below stands in for it, keyed to the same
          // algorithm colors the donut and every model card use.
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => `${(ctx.parsed.y ?? ctx.parsed.x).toFixed(1)}%` } }
        }
      }
    });
  }

  if (typeof renderColorLegend === 'function') {
    renderColorLegend('modelAlgoLegend', ALGO_ORDER.map(t => ({ label: ALGO_META[t].label, color: ALGO_META[t].color })));
  }
}

function renderAlgorithmBreakdown(models) {
  renderAlgorithmTypeCharts(models);
}

const QUALITY = {
  r2:   [{ t: 0.85, cls: 'val-great' }, { t: 0.65, cls: 'val-good' },
         { t: 0.40, cls: 'val-fair'  }, { t: -Infinity, cls: 'val-poor' }],
  rmse: [{ t: 0.5,  cls: 'val-great' }, { t: 2,    cls: 'val-good' },
         { t: 5,    cls: 'val-fair'  }, { t: Infinity, cls: 'val-poor' }], // lower is better → reversed
  mae:  [{ t: 0.5,  cls: 'val-great' }, { t: 2,    cls: 'val-good' },
         { t: 5,    cls: 'val-fair'  }, { t: Infinity, cls: 'val-poor' }], // lower is better → reversed
  mse:  [{ t: 0.25, cls: 'val-great' }, { t: 4,    cls: 'val-good' },
         { t: 25,   cls: 'val-fair'  }, { t: Infinity, cls: 'val-poor' }], // lower is better → reversed (squared-error scale)
  acc:  [{ t: 0.85, cls: 'val-great' }, { t: 0.70, cls: 'val-good' },
         { t: 0.55, cls: 'val-fair'  }, { t: -Infinity, cls: 'val-poor' }],
  f1:   [{ t: 0.80, cls: 'val-great' }, { t: 0.65, cls: 'val-good' },
         { t: 0.50, cls: 'val-fair'  }, { t: -Infinity, cls: 'val-poor' }],
};

function qualityClass(key, value) {
  const map = QUALITY[key] || [];
  if (key === 'rmse' || key === 'mae') {
    // For RMSE/MAE: lower is better — reverse thresholds (same error-unit scale)
    if (value <= 0.5)  return 'val-great';
    if (value <= 2.0)  return 'val-good';
    if (value <= 5.0)  return 'val-fair';
    return 'val-poor';
  }
  if (key === 'mse') {
    // For MSE: lower is better — reverse thresholds (squared-error scale)
    if (value <= 0.25) return 'val-great';
    if (value <= 4.0)  return 'val-good';
    if (value <= 25.0) return 'val-fair';
    return 'val-poor';
  }
  for (const { t, cls } of map) {
    if (value >= t) return cls;
  }
  return 'val-poor';
}

// ── Metric classification helpers ───────────────────────────────
function classifyMetric(key) {
  // Check 'rmse' and 'mae' before the generic 'mse' substring match,
  // since "rmse".includes('mse') is true.
  const lowKey = key.toLowerCase();
  if (lowKey.includes('rmse'))     return 'rmse';
  if (lowKey.includes('mae'))      return 'mae';
  if (lowKey.includes('mse'))      return 'mse';
  if (lowKey.includes('r²') || lowKey.includes('r2')) return 'r2';
  if (lowKey.includes('accuracy')) return 'acc';
  if (lowKey.includes('f1'))       return 'f1';
  return 'acc';
}

// Strip a known metric suffix to find which sub-model a key belongs to,
// e.g. "dropout_rate_rmse" -> "dropout_rate"; "r2" -> "" (flat/top-level).
function familyOf(key) {
  const suffixes = ['_rmse', '_mae', '_mse', '_r2', '_accuracy', '_f1'];
  const lowKey = key.toLowerCase();
  for (const s of suffixes) {
    if (lowKey.endsWith(s)) return key.slice(0, key.length - s.length);
  }
  return '';
}

function metricBoxHTML(key, val) {
  const qKey = classifyMetric(key);
  const qCls = qualityClass(qKey, val);
  // RMSE/MSE/MAE are raw error values, not ratios — show as plain numbers.
  const isErrorMetric = qKey === 'rmse' || qKey === 'mse' || qKey === 'mae';
  const displayVal = isErrorMetric ? val.toFixed(4) : (val * 100).toFixed(1) + '%';
  return `
    <div class="ml-metric-box">
      <div class="ml-metric-key">${key}</div>
      <div class="ml-metric-val ${qCls}">${displayVal}</div>
    </div>`;
}

// Pick the 2 most informative metrics per sub-model for the visible row
// (R² + RMSE for regressors, Accuracy + F1 for classifiers), and return
// the rest so they can be tucked into an expandable "show more" section.
// This guarantees all 4 metrics (R², RMSE, MSE, MAE) stay reachable even
// though only 2 show by default.
function splitMetrics(metrics) {
  const families = {};
  for (const [key, val] of Object.entries(metrics)) {
    const fam = familyOf(key);
    (families[fam] = families[fam] || []).push([key, val]);
  }

  const primary = [];
  const secondary = [];

  for (const items of Object.values(families)) {
    const byType = {};
    for (const [key, val] of items) byType[classifyMetric(key)] = [key, val];

    const isClfFamily = byType.acc || byType.f1;
    const primaryTypes = isClfFamily ? ['acc', 'f1'] : ['r2', 'rmse'];
    const secondaryTypes = isClfFamily ? [] : ['mse', 'mae'];
    const handled = new Set([...primaryTypes, ...secondaryTypes]);

    for (const t of primaryTypes) if (byType[t]) primary.push(byType[t]);
    for (const t of secondaryTypes) if (byType[t]) secondary.push(byType[t]);
    // Any metric type we don't explicitly plan for still gets shown, just
    // deferred to the expandable section rather than dropped.
    for (const [type, pair] of Object.entries(byType)) {
      if (!handled.has(type)) secondary.push(pair);
    }
  }

  return { primary, secondary };
}

// Which chart on the dashboard each model feeds, keyed by keywords found
// in the model's name/key. Falls back to model.chart_type from the API
// if the backend already supplies it — this map only covers the gap.
const CHART_LABELS = [
  { match: /dropout.*risk|risk.*dropout/i, label: 'Dropout Risk (Donut)' },
  // year_level_performance (RESTORED 2026-09-06 as 5 independent
  // per-band LinearRegression models — Excellent/Good/Average/Below
  // Average/Failing) powers the Prediction-mode LINE view of
  // "Performance by Year Level". Matches both possible card-naming
  // conventions: one card named "year_level_performance", or 5
  // separate cards named after each band directly — whichever the
  // backend's flattening does, this still labels correctly. Checked
  // before the generic /year.*level/i fallback below (a band name alone
  // wouldn't match that pattern anyway, but keeping the specific rule
  // first makes the precedence explicit) and before /irreg/i, /gwa.*
  // trend/, etc., which a bare band name wouldn't collide with, but
  // "year_level_performance" as a whole string could partially overlap
  // with in principle.
  { match: /year_level_performance|^(excellent|good|average|below average|failing)$/i,
    label: 'Performance by Year Level (Line)' },
  // Year-level INC/Irregular/Drop Rate sub-metrics (inc_rate,
  // irregular_rate, drop_rate under year_level_inc_irreg) need to be
  // checked BEFORE the generic /irreg/i rule below, or the
  // irregular_rate sub-metric would incorrectly get labeled a Donut
  // (from the /irreg/i match) instead of the bar chart it actually
  // powers.
  { match: /year.*level.*(inc|irreg|drop)|(inc|irreg|drop).*year.*level/i, label: 'INC/Irregular/Drop Rate by Year Level (Bar)' },
  { match: /irreg/i,                       label: 'Irregular Students (Donut)' },
  { match: /dropout.*spike|spike/i,        label: 'Dropout Trend (Line)' },
  { match: /gwa.*trend|trend.*gwa/i,       label: 'GWA Trend (Line)' },
  { match: /forecast/i,                    label: 'Forecast (Line)' },
  { match: /subject.*grade/i,              label: 'Subject Grades (Line)' },
  { match: /gender/i,                      label: 'Gender Performance (Line)' },
  { match: /ranking/i,                     label: 'Ranking (Bar)' },
  { match: /^kpi$|kpi/i,                   label: 'KPI Tile' },
  // FIX (2026-09-06): course_year_level_dropout (the only model that
  // was ever actually meant to power a heatmap, but never got wired up)
  // was removed as dead code. Nothing that can still reach this
  // fallback is confirmed to be any specific chart type — kept only as
  // a safety net for a year-level model name that doesn't match either
  // more specific rule above, so the label stays generic ('Year Level')
  // instead of asserting a chart type ('Bar'/'Heatmap') that might be
  // wrong for whatever unexpected name lands here.
  { match: /year.*level/i,                 label: 'Year Level' },
];

function chartLabelFor(model) {
  if (model.chart_type) return model.chart_type;
  const key = model.name || model.key || '';
  const hit = CHART_LABELS.find(({ match }) => match.test(key));
  return hit ? hit.label : null;
}

// ── Render a single model card ──────────────────────────────────
function buildCard(model, index) {
  const isClf     = model.type === 'classification';
  const isErr     = model.status === 'error';
  const isSkipped = model.status === 'skipped';

  const typeLabel = isErr ? 'Error'
                 : isSkipped ? 'Skipped'
                 : isClf  ? 'Random Forest'
                 : 'Linear Regression';
  const typeCls   = isErr ? 'err' : isSkipped ? 'skip' : isClf ? 'clf' : 'reg';

  // Build metric boxes
  let metricsHTML;
  if (isErr || isSkipped) {
    // Skipped models (usually "not enough data yet") carry the same
    // free-text explanation an error would, just without implying
    // something actually broke.
    const message = isErr
      ? (model.error || 'Unknown error')
      : (model.description || 'Skipped — not enough data for this model yet.');
    metricsHTML = `
      <div class="ml-metrics-row">
        <div class="ml-metric-box" style="flex:1;">
          <div class="ml-metric-key">${isErr ? 'Error' : 'Why'}</div>
          <div class="ml-metric-val ${isErr ? 'val-poor' : 'val-fair'}" style="font-size:0.7rem; font-weight:600; word-break:break-word;">
            ${message}
          </div>
        </div>
      </div>`;
  } else {
    const { primary, secondary } = splitMetrics(model.metrics);

    const primaryHTML = primary.map(([k, v]) => metricBoxHTML(k, v)).join('');
    metricsHTML = `<div class="ml-metrics-row">${primaryHTML}</div>`;

    if (secondary.length > 0) {
      const secondaryHTML = secondary.map(([k, v]) => metricBoxHTML(k, v)).join('');
      metricsHTML += `
        <details class="ml-metrics-more">
          <summary style="cursor:pointer; font-size:0.72rem; opacity:0.7; margin-top:0.4rem;">
            Show ${secondary.length} more metric${secondary.length > 1 ? 's' : ''}
          </summary>
          <div class="ml-metrics-row ml-metrics-row-secondary" style="margin-top:0.4rem;">${secondaryHTML}</div>
        </details>`;
    }
  }

  // Stagger animation delay
  const delay = `animation-delay: ${index * 0.05}s;`;

  const chartLabel = chartLabelFor(model);
  const chartBadge = chartLabel
    ? `<span class="ml-card-chart-used" style="font-size:0.65rem; opacity:0.65; margin-left:0.4rem;">Used in: ${chartLabel}</span>`
    : '';

  const algoColor = ALGO_META[classifyAlgorithm(model)].color;

  return `
    <div class="ml-model-card ${typeCls}" style="${delay} --type-color:${algoColor};">
      <span class="ml-card-label ${typeCls}">${typeLabel}</span>${chartBadge}
      <div class="ml-card-title">${model.name}</div>
      <div class="ml-card-desc">${model.description || ''}</div>
      ${metricsHTML}
    </div>`;
}

// ── Main loader ─────────────────────────────────────────────────
async function loadModelMetrics() {
  const grid      = document.getElementById('ml-eval-grid');
  const timestamp = document.getElementById('ml-eval-timestamp');
  const btn       = document.getElementById('ml-eval-refresh');

  // NOTE: `grid`/`timestamp`/`btn` (#ml-eval-grid etc.) are an OPTIONAL
  // card list some pages have; the Model Performance page doesn't (it
  // uses chart-helpers.js's #mp-grid for that instead). Every use below
  // is guarded with `if (grid)` etc. so this function still fetches and
  // calls renderAlgorithmBreakdown() — which drives the KPI formula row,
  // the type donut/bar, and the warnings list — even on pages with no
  // grid element at all.

  // Show skeletons while loading
  if (grid) grid.innerHTML = Array(6).fill('<div class="ml-skeleton"></div>').join('');
  if (timestamp) timestamp.textContent = 'Evaluating models…';
  if (btn) btn.disabled = true;

  try {
    const res  = await fetch('/api/get_model_metrics');
    const data = await res.json();

    if (data.error) {
      if (grid) grid.innerHTML = `
        <div style="grid-column:1/-1; text-align:center; padding:2rem; color:#e74a3b;">
          <strong>Error loading metrics:</strong> ${data.error}
        </div>`;
      if (timestamp) timestamp.textContent = '';
      renderAlgorithmBreakdown([]);
      return;
    }

    if (!data.models || !data.models.length) {
      if (grid) grid.innerHTML = `
        <div style="grid-column:1/-1; text-align:center; color:#858796; padding:1.5rem 0;">
          No model has been trained yet. Upload a dataset to begin.
        </div>`;
      if (timestamp) timestamp.textContent = '';
      renderAlgorithmBreakdown([]);
      return;
    }

    // Render cards (only if this page has its own #ml-eval-grid)
    if (grid) grid.innerHTML = data.models.map((m, i) => buildCard(m, i)).join('');

    // Same response, grouped by algorithm type — formula KPI row,
    // donut/bar breakdown, and warnings (see top of this file).
    renderAlgorithmBreakdown(data.models);

    // Update timestamp
    const now = new Date().toLocaleString('en-PH', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    });
    if (timestamp) {
      timestamp.textContent = `Last evaluated: ${now} · ${data.total} models`;
    }

  } catch (err) {
    if (grid) grid.innerHTML = `
      <div style="grid-column:1/-1; text-align:center; padding:2rem; color:#e74a3b;">
        <strong>Network error:</strong> ${err.message}
      </div>`;
    console.error('ML Eval fetch error:', err);
  } finally {
    if (btn) btn.disabled = false;
  }
}

// ── Auto-load on DOMContentLoaded ───────────────────────────────
document.addEventListener('DOMContentLoaded', function () {
  // Slight delay so other charts initialize first
  setTimeout(loadModelMetrics, 800);
});