
    async function populateYearFilter() {
      const select = document.getElementById('globalYearFilter');
      if (!select) return;

      let latestStart = 2024;
      let predYears   = [];

      try {
        const res   = await fetch('/api/training-state');
        const state = await res.json();
        const h     = state.horizon || {};
        latestStart = h.latest_year_start  || 2024;
        predYears   = h.prediction_years   || [];
      } catch (e) {
        console.warn('Could not load training state:', e);
      }

      const firstYear = 2022;
      select.innerHTML = '';

      // Historical options
      for (let y = firstYear; y <= latestStart; y++) {
        const opt = document.createElement('option');
        opt.value = y;
        opt.textContent = (y === latestStart) ? `${y} (Current)` : `${y} (Actual)`;
        if (y === latestStart) opt.selected = true;
        select.appendChild(opt);
      }

      // Predicted options
      predYears.forEach(function(yearLabel) {
        const startYear = parseInt(yearLabel.split('-')[0]);
        const opt = document.createElement('option');
        opt.value       = startYear;
        opt.textContent = startYear + ' (Predicted)';
        select.appendChild(opt);
      });

      // Re-fire chart update
      const ev = new Event('change');
      select.dispatchEvent(ev);
    }

    document.addEventListener('DOMContentLoaded', populateYearFilter);

    