
const QUALITY = {
  r2:   [{ t: 0.85, cls: 'val-great' }, { t: 0.65, cls: 'val-good' },
         { t: 0.40, cls: 'val-fair'  }, { t: -Infinity, cls: 'val-poor' }],
  rmse: [{ t: 0.5,  cls: 'val-great' }, { t: 2,    cls: 'val-good' },
         { t: 5,    cls: 'val-fair'  }, { t: Infinity, cls: 'val-poor' }], // lower is better → reversed
  acc:  [{ t: 0.85, cls: 'val-great' }, { t: 0.70, cls: 'val-good' },
         { t: 0.55, cls: 'val-fair'  }, { t: -Infinity, cls: 'val-poor' }],
  f1:   [{ t: 0.80, cls: 'val-great' }, { t: 0.65, cls: 'val-good' },
         { t: 0.50, cls: 'val-fair'  }, { t: -Infinity, cls: 'val-poor' }],
};

function qualityClass(key, value) {
  const map = QUALITY[key] || [];
  if (key === 'rmse') {
    // For RMSE: lower is better — reverse thresholds
    if (value <= 0.5)  return 'val-great';
    if (value <= 2.0)  return 'val-good';
    if (value <= 5.0)  return 'val-fair';
    return 'val-poor';
  }
  for (const { t, cls } of map) {
    if (value >= t) return cls;
  }
  return 'val-poor';
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
  let metricsHTML = '';
  if (isErr) {
    metricsHTML = `
      <div class="ml-metric-box" style="flex:1;">
        <div class="ml-metric-key">Error</div>
        <div class="ml-metric-val val-poor" style="font-size:0.7rem; font-weight:600; word-break:break-word;">
          ${model.error || 'Unknown error'}
        </div>
      </div>`;
  } else {
    for (const [key, val] of Object.entries(model.metrics)) {
      // Map display key to quality-key
      const qKey = key.toLowerCase().includes('rmse') ? 'rmse'
                 : key.toLowerCase().includes('r²') || key.toLowerCase().includes('r2') ? 'r2'
                 : key.toLowerCase().includes('accuracy') ? 'acc'
                 : key.toLowerCase().includes('f1') ? 'f1'
                 : 'acc';

      const qCls  = qualityClass(qKey, val);
      const pct   = (qKey === 'rmse') ? '' : '%';  // Show % for ratio metrics
      const display = (qKey === 'rmse') ? val.toFixed(4)
                    : (val * (qKey === 'rmse' ? 1 : 100)).toFixed(2);

      // For r2 / accuracy / f1 we want 0→1 displayed as percentage
      const displayVal = (qKey === 'rmse') ? val.toFixed(4) : (val * 100).toFixed(1) + '%';

      metricsHTML += `
        <div class="ml-metric-box">
          <div class="ml-metric-key">${key}</div>
          <div class="ml-metric-val ${qCls}">${displayVal}</div>
        </div>`;
    }
  }

  // Stagger animation delay
  const delay = `animation-delay: ${index * 0.05}s;`;

  return `
    <div class="ml-model-card ${typeCls}" style="${delay}">
      <span class="ml-card-label ${typeCls}">${typeLabel}</span>
      <div class="ml-card-title">${model.name}</div>
      <div class="ml-card-desc">${model.description}</div>
      <div class="ml-metrics-row">${metricsHTML}</div>
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