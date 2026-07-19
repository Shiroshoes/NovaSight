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

// ── Render a single model card ──────────────────────────────────
function buildCard(model, index) {
  const isClf = model.type === 'classification';
  const isErr = model.status === 'error';

  const typeLabel = isErr ? 'Error'
                 : isClf  ? 'Random Forest'
                 : 'Linear Regression';
  const typeCls   = isErr ? 'err' : isClf ? 'clf' : 'reg';

  // Build metric boxes
  let metricsHTML;
  if (isErr) {
    metricsHTML = `
      <div class="ml-metrics-row">
        <div class="ml-metric-box" style="flex:1;">
          <div class="ml-metric-key">Error</div>
          <div class="ml-metric-val val-poor" style="font-size:0.7rem; font-weight:600; word-break:break-word;">
            ${model.error || 'Unknown error'}
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

  return `
    <div class="ml-model-card ${typeCls}" style="${delay}">
      <span class="ml-card-label ${typeCls}">${typeLabel}</span>
      <div class="ml-card-title">${model.name}</div>
      <div class="ml-card-desc">${model.description}</div>
      ${metricsHTML}
    </div>`;
}

// ── Main loader ─────────────────────────────────────────────────
async function loadModelMetrics() {
  const grid      = document.getElementById('ml-eval-grid');
  const timestamp = document.getElementById('ml-eval-timestamp');
  const btn       = document.getElementById('ml-eval-refresh');

  if (!grid) return;

  // Show skeletons while loading
  grid.innerHTML = Array(6).fill('<div class="ml-skeleton"></div>').join('');
  if (timestamp) timestamp.textContent = 'Evaluating models…';
  if (btn) btn.disabled = true;

  try {
    const res  = await fetch('/api/get_model_metrics');
    const data = await res.json();

    if (data.error) {
      grid.innerHTML = `
        <div style="grid-column:1/-1; text-align:center; padding:2rem; color:#e74a3b;">
          <strong>Error loading metrics:</strong> ${data.error}
        </div>`;
      return;
    }

    // Render all cards
    grid.innerHTML = data.models.map((m, i) => buildCard(m, i)).join('');

    // Update timestamp
    const now = new Date().toLocaleString('en-PH', {
      month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true
    });
    if (timestamp) {
      timestamp.textContent = `Last evaluated: ${now} · ${data.total} models`;
    }

  } catch (err) {
    grid.innerHTML = `
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