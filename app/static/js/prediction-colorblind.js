/* =====================================================================
   PREDICTION-COLORBLIND.JS  —  color-blind mode for the Prediction page
   ---------------------------------------------------------------------
   Same switch, same palette (Okabe-Ito) and same saved setting as the
   main dashboard (localStorage key "dashColorblind"), so turning it on
   in one place turns it on in the other.

   What it does
     1. Toggles  html.cb-mode  (maindashboardadmin.css already restyles the
        shared badges / deltas under that class; preddashAdmin.css covers
        the prediction-only ones).
     2. Registers a Chart.js plugin that, while the mode is on, swaps the
        red / green / orange colours of every chart dataset for
        color-blind-safe ones, and gives multi-line charts distinct point
        shapes as a second cue. Turning it off restores the original
        colours exactly. Nothing in prediction-dash.js needs to change.

   LOAD ORDER: after Chart.js, BEFORE prediction-dash.js.
   ===================================================================== */
(function () {
  'use strict';

  const KEY = 'dashColorblind';
  let on = false;
  try { on = localStorage.getItem(KEY) === '1'; } catch (e) {}

  /* ── Palette (identical to PALETTES.cb in maindash.js) ─────────────── */
  const OI = { vermilion: '#D55E00', orange: '#E69F00', green: '#009E73',
               sky: '#56B4E9', blue: '#0072B2', pink: '#CC79A7', grey: '#999999' };

  // Exact matches: the dashboard's normal colours -> their safe counterpart.
  const EXACT = {
    // status
    'dc2626': OI.vermilion, '7c3aed': OI.pink, 'd97706': OI.orange, '0284c7': OI.blue,
    '059669': OI.sky, '9ca3af': OI.grey, '16a34a': OI.green,
    // colleges
    '36b9cc': OI.sky, 'e74a3b': OI.vermilion, '8a2be2': OI.pink, '1cc88a': OI.green,
    '5a5c69': OI.orange, '4e73df': OI.blue,
    // year levels
    '7b1113': OI.blue, 'c0392b': OI.sky, 'e67e22': OI.green, 'f1c40f': OI.orange,
    '27ae60': OI.vermilion, '2980b9': OI.pink,
    // performance tiers (the 16a34a / d97706 / dc2626 ones are already above)
    '65a30d': OI.sky,
  };

  /* ── Colour parsing ─────────────────────────────────────────────────── */
  function parse(str) {
    const s = str.trim().toLowerCase();
    let m = /^#([0-9a-f]{3})$/.exec(s);
    if (m) { const h = m[1]; return { r: parseInt(h[0]+h[0],16), g: parseInt(h[1]+h[1],16), b: parseInt(h[2]+h[2],16), a: 1, fmt: 'hex' }; }
    m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(s);
    if (m) { const h = m[1]; return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16),
                                      a: m[2] ? parseInt(m[2],16)/255 : 1, fmt: m[2] ? 'hex8' : 'hex' }; }
    m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4], fmt: 'rgb' };
    return null;                                     // named colours, hsl(), gradients: leave alone
  }
  const hex2 = n => Math.round(n).toString(16).padStart(2, '0');
  function hue(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    if (d < 0.12) return null;                       // grey-ish: nothing to fix
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60; return h < 0 ? h + 360 : h;
  }
  // Colours that aren't in the table: only red / orange / green need rescuing.
  function fallback(c) {
    const h = hue(c.r, c.g, c.b);
    if (h === null) return null;
    if (h < 15 || h >= 345) return OI.vermilion;     // reds, maroon
    if (h < 65)             return OI.orange;        // orange / amber / yellow
    if (h < 170)            return OI.green;         // yellow-green / green
    return null;                                     // blue, cyan, purple already safe
  }
  function mapColor(str) {
    const c = parse(str);
    if (!c) return str;
    const key = (c.r << 16 | c.g << 8 | c.b).toString(16).padStart(6, '0');
    const to = EXACT[key] || fallback(c);
    if (!to) return str;
    const t = parse(to);
    if (c.fmt === 'rgb')  return c.a < 1 ? `rgba(${t.r},${t.g},${t.b},${c.a})` : `rgb(${t.r},${t.g},${t.b})`;
    if (c.fmt === 'hex8') return to + hex2(c.a * 255);
    return to;
  }
  const mapVal = v => Array.isArray(v) ? v.map(mapVal) : (typeof v === 'string' ? mapColor(v) : v);

  /* ── Chart.js plugin ────────────────────────────────────────────────── */
  const COLOR_PROPS = ['backgroundColor', 'borderColor', 'hoverBackgroundColor', 'hoverBorderColor',
                       'pointBackgroundColor', 'pointBorderColor', 'pointHoverBackgroundColor'];
  const SHAPES = ['circle', 'triangle', 'rect', 'rectRot', 'star', 'crossRot'];
  const saved = new WeakMap();                       // dataset -> { prop: { orig, mapped } }

  const same = (a, b) => a === b || (Array.isArray(a) && Array.isArray(b) && JSON.stringify(a) === JSON.stringify(b));

  function sync(ds, prop, cur) {
    const rec = saved.get(ds) || {}; saved.set(ds, rec);
    const r = rec[prop];
    if (on) {
      if (r && same(cur, r.mapped)) return;          // already ours
      const mapped = mapVal(cur);
      rec[prop] = { orig: cur, mapped };
      ds[prop] = mapped;
    } else if (r) {
      if (same(cur, r.mapped)) ds[prop] = r.orig;    // put the original back
      delete rec[prop];
    }
  }

  const plugin = {
    id: 'pdColorblind',
    beforeUpdate(chart) {
      const sets = chart.config.data.datasets || [];
      const lines = sets.filter(d => (d.type || chart.config.type) === 'line');
      sets.forEach((ds) => {
        COLOR_PROPS.forEach(p => { if (ds[p] !== undefined) sync(ds, p, ds[p]); });
        // second cue for multi-line charts: a different point shape per line
        // (skipped when prediction-dash.js already drives pointStyle with a function)
        const isLine = (ds.type || chart.config.type) === 'line';
        if (isLine && lines.length > 1 && typeof ds.pointStyle !== 'function') {
          const i = lines.indexOf(ds);
          if (on) {
            const rec = saved.get(ds) || {}; saved.set(ds, rec);
            if (!rec.pointStyle || ds.pointStyle !== rec.pointStyle.mapped) {
              rec.pointStyle = { orig: ds.pointStyle, mapped: SHAPES[i % SHAPES.length] };
              ds.pointStyle = rec.pointStyle.mapped;
            }
          } else if (saved.get(ds)?.pointStyle) {
            const r = saved.get(ds).pointStyle;
            if (ds.pointStyle === r.mapped) ds.pointStyle = r.orig;
            delete saved.get(ds).pointStyle;
          }
        }
      });
    },
  };
  if (window.Chart && Chart.register) Chart.register(plugin);

  /* ── Toggle wiring ──────────────────────────────────────────────────── */
  function apply() {
    document.documentElement.classList.toggle('cb-mode', on);
    const btn = document.getElementById('btnColorblind');
    if (btn) btn.setAttribute('aria-checked', String(on));
  }
  function redrawCharts() {
    if (!window.Chart || !Chart.instances) return;
    Object.values(Chart.instances).forEach(c => { try { c.update('none'); } catch (e) { console.error(e); } });
  }

  apply();                                           // before the first chart is drawn
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    document.getElementById('btnColorblind')?.addEventListener('click', () => {
      on = !on;
      try { localStorage.setItem(KEY, on ? '1' : '0'); } catch (e) {}
      apply();
      redrawCharts();
      // hook for prediction-dash.js if it ever needs to re-render HTML it colours itself
      document.dispatchEvent(new CustomEvent('cbmodechange', { detail: { on } }));
    });
  });

  window.PredColorblind = { get on() { return on; } };
})();
