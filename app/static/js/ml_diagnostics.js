// ── Model Diagnostics ─────────────────────────────────────────
      // Populates all 4 model dropdowns from the same /api/model-performance
      // response the metrics grid above already uses, then wires each
      // section's own fetch. The 4 fetch targets below (predicted-vs-actual,
      // feature-importance, confusion-matrix, residual-trend) don't exist
      // in the backend yet — these calls are written against the response
      // shape each chart needs, so wiring up real endpoints with these
      // names/shapes (or adjusting the .then() below to match whatever
      // shape they end up returning) is the only remaining step.
      let DIAG_MODELS = [];

      function populateDiagDropdowns() {
        const selects = ['diagModelSelect_pva', 'diagModelSelect_fi', 'diagModelSelect_cm', 'diagModelSelect_res'];
        selects.forEach(id => {
          const sel = document.getElementById(id);
          if (!sel) return;
          sel.innerHTML = DIAG_MODELS.map(m => `<option value="${m}">${m}</option>`).join('');
        });
        if (DIAG_MODELS.length) {
          loadPredictedVsActual(DIAG_MODELS[0]);
          loadFeatureImportance(DIAG_MODELS[0]);
          loadConfusionMatrix(DIAG_MODELS[0]);
          loadResidualTrend(DIAG_MODELS[0]);
        }
      }

      fetch('/api/model-performance')
        .then(res => res.json())
        .then(data => {
          DIAG_MODELS = (data.models || []).map(m => m.label).filter(Boolean);
          populateDiagDropdowns();
          renderModelPerformanceCharts(data);
        })
        .catch(err => console.error('Model list fetch failed:', err));

      const MODEL_STATUS_HEX = { ok: '#1cc88a', skipped: '#f6c23e', error: '#e74a3b' };
      const STATUS_LABELS = { ok: 'Trained', skipped: 'Skipped', error: 'Error' };

      function renderModelPerformanceCharts(data) {
        const models = data.models || [];

        // Headline score bar chart — only models that actually produced
        // a headline number (status "ok"); skipped/error models have no
        // score to plot. Colored by which algorithm trained the model
        // (mlAlgoColor, shared with chart-helpers.js's mp-grid cards and
        // ml_eval.js's donut/bar) instead of by status, so a bar's color
        // tells you WHAT trained it, not just that it succeeded.
        const scored = models.filter(m => m.headline_value !== null && m.headline_value !== undefined);
        const headlineCtx = document.getElementById('modelHeadlineChart');
        if (headlineCtx && scored.length) {
          if (window._modelHeadlineChart) window._modelHeadlineChart.destroy();
          window._modelHeadlineChart = new Chart(headlineCtx.getContext('2d'), {
            type: 'bar',
            data: {
              labels: scored.map(m => m.label),
              datasets: [{
                label: 'Headline score',
                data: scored.map(m => m.headline_value <= 1 ? m.headline_value * 100 : m.headline_value),
                backgroundColor: scored.map(m => mlAlgoColor(m.algorithm)),
                borderRadius: 4,
              }]
            },
            options: {
              maintainAspectRatio: false,
              indexAxis: scored.length > 6 ? 'y' : 'x',
              scales: { x: { ticks: { autoSkip: false } }, y: { beginAtZero: true, max: 100, ticks: { callback: (v) => v + '%' } } },
              plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y ?? ctx.parsed.x}%` } }
              }
            }
          });
        }
        if (typeof renderColorLegend === 'function') {
          renderColorLegend('headlineAlgoLegend', Object.keys(ML_ALGO_META).map(k => ({ label: ML_ALGO_META[k].label, color: ML_ALGO_META[k].color })));
        }

        // Training Status — was a single donut of pooled Trained/Skipped/
        // Error counts, which couldn't say WHICH model was skipped or
        // errored. Rebuilt to match the Gender Retention donuts elsewhere
        // on the dashboard (renderGenderStatusGrid in chart-helpers.js):
        // one slice per MODEL instead of per status, colored by that
        // model's algorithm (mlAlgoColor) — full color if trained, a
        // muted shade of that same color if skipped, solid red if
        // errored — plus a side readout of status counts and a chip
        // legend listing every model, same layout as those donuts.
        renderTrainingStatusDonut(models);
      }

      let _modelStatusChart;

      function renderTrainingStatusDonut(models) {
        const container = document.getElementById('modelStatusContainer');
        if (!container) return;

        if (!models.length) {
          container.innerHTML = `<p style="color:#858796; text-align:center;">No models trained yet.</p>`;
          return;
        }

        const counts = { ok: 0, skipped: 0, error: 0 };
        models.forEach(m => { counts[m.status] = (counts[m.status] || 0) + 1; });

        const labels = models.map(m => m.label);
        const values = models.map(() => 1); // one equally-sized slice per model
        const colors = models.map(m => {
          const base = mlAlgoColor(m.algorithm);
          if (m.status === 'error') return MODEL_STATUS_HEX.error;
          if (m.status === 'skipped') return hexToRgba(base, 0.35);
          return base;
        });
        const legendEntries = models.map((m, i) => ({ label: `${m.label} (${STATUS_LABELS[m.status] || m.status})`, color: colors[i] }));

        container.innerHTML = `
          <div style="text-align:center; font-weight:700; font-size:0.85rem; color:#5a5c69; margin-bottom:0.5rem;">
            Total Models: ${models.length}
          </div>
          <div style="display:flex; align-items:center; justify-content:center; gap:1.5rem; flex-wrap:wrap;">
            <div style="position:relative; height:260px; width:260px; flex:0 0 auto;">
              <canvas id="modelStatusChart"></canvas>
            </div>
            <div style="display:flex; flex-direction:column; gap:0.5rem; font-size:0.85rem; min-width:150px;">
              <div style="color:#1cc88a; font-weight:700;">● ${counts.ok} Trained</div>
              <div style="color:#f6c23e; font-weight:700;">● ${counts.skipped} Skipped</div>
              <div style="color:#e74a3b; font-weight:700;">● ${counts.error} Error</div>
            </div>
          </div>
          <div id="modelStatusLegend" style="margin-top:0.75rem; text-align:center;"></div>
        `;

        const canvas = document.getElementById('modelStatusChart');
        if (!canvas) return;
        if (_modelStatusChart) _modelStatusChart.destroy();

        _modelStatusChart = new Chart(canvas.getContext('2d'), {
          type: 'doughnut',
          data: { labels, datasets: [{
            data: values,
            backgroundColor: colors,
            hoverBorderColor: 'rgba(255,255,255,1)',
            borderWidth: 2,
            hoverOffset: 8,
          }] },
          options: {
            maintainAspectRatio: false,
            cutout: '60%',
            responsive: true,
            animation: { animateScale: true, animateRotate: true, duration: 800, easing: 'easeOutQuart' },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (ctx) => ` ${ctx.label}: ${STATUS_LABELS[models[ctx.dataIndex].status] || models[ctx.dataIndex].status}`
                }
              }
            }
          }
        });

        if (typeof renderColorLegend === 'function') {
          renderColorLegend('modelStatusLegend', legendEntries);
        }
      }

      let predictedVsActualChart, featureImportanceChart, residualTrendChart;

      function loadPredictedVsActual(model) {
        const statusEl = document.getElementById('predictedVsActualStatus');
        if (!statusEl) return; // element not on this page/section — nothing to update
        fetch(`/api/model_predicted_vs_actual?model=${encodeURIComponent(model)}`)
          .then(res => { if (!res.ok) throw new Error('not implemented yet'); return res.json(); })
          .then(data => {
            statusEl.textContent = '';
            const ctx = document.getElementById('predictedVsActualChart').getContext('2d');
            if (predictedVsActualChart) predictedVsActualChart.destroy();
            const points = (data.actual || []).map((a, i) => ({ x: a, y: (data.predicted || [])[i] }));
            const minMax = [Math.min(...data.actual, ...data.predicted), Math.max(...data.actual, ...data.predicted)];
            predictedVsActualChart = new Chart(ctx, {
              type: 'scatter',
              data: { datasets: [
                { label: model, data: points, backgroundColor: '#4e73df' },
                { label: 'Perfect prediction', data: [{x: minMax[0], y: minMax[0]}, {x: minMax[1], y: minMax[1]}], type: 'line', borderColor: '#e74a3b', borderDash: [5,4], pointRadius: 0 }
              ]},
              options: { maintainAspectRatio: false, scales: { x: { title: { display: true, text: 'Actual' } }, y: { title: { display: true, text: 'Predicted' } } } }
            });
          })
          .catch(() => { statusEl.textContent = 'Not available yet — needs the /api/model_predicted_vs_actual endpoint.'; });
      }

      function loadFeatureImportance(model) {
        const statusEl = document.getElementById('featureImportanceStatus');
        if (!statusEl) return; // element not on this page/section — nothing to update
        fetch(`/api/model_feature_importance?model=${encodeURIComponent(model)}`)
          .then(res => { if (!res.ok) throw new Error('not implemented yet'); return res.json(); })
          .then(data => {
            statusEl.textContent = '';
            const ctx = document.getElementById('featureImportanceChart').getContext('2d');
            if (featureImportanceChart) featureImportanceChart.destroy();
            featureImportanceChart = new Chart(ctx, {
              type: 'bar',
              data: { labels: data.features || [], datasets: [{ label: 'Importance', data: data.importance || [], backgroundColor: '#4e73df' }] },
              options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } } }
            });
          })
          .catch(() => { statusEl.textContent = 'Not available yet — needs the /api/model_feature_importance endpoint.'; });
      }

      function loadConfusionMatrix(model) {
        const statusEl = document.getElementById('confusionMatrixStatus');
        if (!statusEl) return; // element not on this page/section — nothing to update
        const grid = document.getElementById('confusionMatrixGrid');
        fetch(`/api/model_confusion_matrix?model=${encodeURIComponent(model)}`)
          .then(res => { if (!res.ok) throw new Error('not implemented yet'); return res.json(); })
          .then(data => {
            statusEl.textContent = '';
            const labels = data.labels || [];
            const matrix = data.matrix || [];
            const max = Math.max(1, ...matrix.flat());
            grid.innerHTML = `
              <table style="width:100%; border-collapse:collapse; text-align:center; font-size:0.8rem;">
                <tr><td></td>${labels.map(l => `<th style="padding:0.4rem;">${l}</th>`).join('')}</tr>
                ${matrix.map((row, i) => `
                  <tr>
                    <th style="padding:0.4rem; text-align:right;">${labels[i]}</th>
                    ${row.map(v => `<td style="padding:0.6rem; background:rgba(78,115,223,${(v/max*0.8).toFixed(2)}); font-weight:700;">${v}</td>`).join('')}
                  </tr>`).join('')}
              </table>`;
          })
          .catch(() => { statusEl.textContent = 'Not available yet — needs the /api/model_confusion_matrix endpoint (classifiers only).'; grid.innerHTML = ''; });
      }

      function loadResidualTrend(model) {
        const statusEl = document.getElementById('residualTrendStatus');
        if (!statusEl) return; // element not on this page/section — nothing to update
        fetch(`/api/model_residual_trend?model=${encodeURIComponent(model)}`)
          .then(res => { if (!res.ok) throw new Error('not implemented yet'); return res.json(); })
          .then(data => {
            statusEl.textContent = '';
            const ctx = document.getElementById('residualTrendChart').getContext('2d');
            if (residualTrendChart) residualTrendChart.destroy();
            residualTrendChart = new Chart(ctx, {
              type: 'line',
              data: { labels: data.years || [], datasets: [{ label: 'Residual (Predicted − Actual)', data: data.residual || [], borderColor: '#e74a3b', backgroundColor: 'rgba(231,74,59,0.08)', fill: true, tension: 0.3 }] },
              options: { maintainAspectRatio: false, scales: { y: { grid: { color: (c) => c.tick.value === 0 ? '#5a5c69' : '#eaecf4' } } } }
            });
          })
          .catch(() => { statusEl.textContent = 'Not available yet — needs the /api/model_residual_trend endpoint.'; });
      }