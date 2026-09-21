/* ==========================================================================
   pdf-export.js — "Download PDF" for the Main Dashboard and Prediction Analysis
   --------------------------------------------------------------------------
   Clicking Download PDF opens a preview first:
     • pick which charts go in (default: all of them)
     • pick paper size + orientation
     • see the real pages and the page count BEFORE downloading
   The PDF contains only the charts (title, filters in use, and the chart) —
   no sidebar, header, filter buttons or descriptions.

   How it works: the selected cards are cloned into a hidden <iframe> that is
   exactly as wide as the paper, so the layout you preview is the layout that
   prints (the dashboard's phone/tablet CSS does not leak in). Canvases are
   swapped for images, cards are packed onto pages, and "Download PDF" prints
   that iframe — choose "Save as PDF" in the browser's print window.

   Needs: css/admin/pdf-export.css  +  a #btnDownloadPdf button on the page.
   ========================================================================== */
(function () {
  'use strict';

  const MM = 96 / 25.4;                                  // CSS px per mm
  const PAPER = { a4: { w: 210, h: 297, label: 'A4' }, letter: { w: 215.9, h: 279.4, label: 'Letter' } };
  const MARGIN = 10, HEAD = 9, FOOT = 8, GAP = 4;        // mm

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = { paper: 'a4', orient: 'portrait', off: new Set(), token: 0, pageInfo: [], busy: false };
  let modal = null, frame = null, sizer = null, built = false;

  /* ── which cards are charts on this page ─────────────────────────────── */
  const cards = () => [...document.querySelectorAll('.dash-grid > .card[id]')];
  const titleOf = (card) => (card.querySelector('.card-title')?.textContent || card.id).trim();

  /* ── what the user had selected in a card (metric buttons, tabs, filters) ── */
  function captionOf(card) {
    const bits = [];
    card.querySelectorAll('.hm-toolbar').forEach((tb) => {
      let label = '';
      [...tb.children].forEach((ch) => {
        if (ch.classList.contains('hm-toolbar-label')) label = ch.textContent.trim();
        else if (ch.classList.contains('kpi-metrics-btns')) {
          const on = ch.querySelector('.metric-btn.active');
          if (on) bits.push((label ? label + ': ' : '') + on.textContent.trim());
        }
      });
    });
    const tab = card.querySelector('.sub-tab.active');
    if (tab) bits.push('View: ' + tab.textContent.trim());
    const sort = card.querySelector('select.hm-sort');
    if (sort && sort.selectedOptions[0]) bits.push('Order: ' + sort.selectedOptions[0].textContent.trim());
    card.querySelectorAll('.kpi-filter-popover .gf-group').forEach((g) => {
      const lab = g.querySelector('.gf-label')?.textContent.trim();
      const sel = g.querySelector('select');
      if (lab === 'Grade Trend horizon' && tab && tab.textContent.trim() !== 'Grade Trend') return;   // only relevant to that view
      if (sel && lab && sel.value !== '' && sel.selectedOptions[0]) bits.push(lab + ': ' + sel.selectedOptions[0].textContent.trim());
    });
    return bits;
  }

  /* ── clone one card into a print-ready element ───────────────────────── */
  function makeItem(card) {
    const src = [...card.querySelectorAll('canvas')];
    const clone = card.cloneNode(true);
    const dst = [...clone.querySelectorAll('canvas')];
    const caption = captionOf(card);

    dst.forEach((c, i) => {
      const o = src[i];
      const r = o ? o.getBoundingClientRect() : { width: 0, height: 0 };
      if (!o || r.width < 2 || r.height < 2) { c.remove(); return; }
      let url = '';
      try { url = o.toDataURL('image/png'); } catch (e) { c.remove(); return; }
      const img = document.createElement('img');
      img.src = url; img.alt = '';
      img.className = 'pdf-img';
      img.style.aspectRatio = o.width + ' / ' + o.height;
      img.style.maxWidth = Math.round(r.width * 1.7) + 'px';     // a small phone-sized chart is not stretched to a full page
      img.style.margin = '0 auto';
      c.replaceWith(img);
    });

    clone.querySelectorAll(
      '.kpi-header-actions, .kpi-filter-popover, .kpi-table-modal, .kpi-explainer, .explainer-toggle,' +
      '.hm-toolbar, .sub-tabs, .btn-fullscreen, .chart-loading, .gender-donut-center:empty'
    ).forEach((n) => n.remove());
    clone.classList.remove('is-loading', 'is-fullscreen');
    clone.removeAttribute('aria-busy');
    clone.querySelectorAll('.clickable').forEach((n) => n.classList.remove('clickable'));
    clone.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    clone.removeAttribute('id');
    clone.classList.add('pdf-item');

    if (caption.length) {
      const cap = document.createElement('div');
      cap.className = 'pdf-caption';
      cap.textContent = caption.join('  ·  ');
      const head = clone.querySelector('.kpi-card-header');
      (head || clone.firstChild).insertAdjacentElement(head ? 'afterend' : 'beforebegin', cap);
    }
    return clone;
  }

  /* ── the document that lives in the iframe ───────────────────────────── */
  function pageSize() {
    const p = PAPER[state.paper];
    const land = state.orient === 'landscape';
    return { w: land ? p.h : p.w, h: land ? p.w : p.h };
  }

  function docHtml(items, title) {
    const { w, h } = pageSize();
    const styles = [...document.querySelectorAll('link[rel="stylesheet"]')]
      .filter((l) => !/pdf-export\.css|dashboard-print\.css/.test(l.href))      // the old print CSS would fight this layout
      .map((l) => `<link rel="stylesheet" href="${esc(l.href)}">`).join('\n');
    const inline = [...document.querySelectorAll('head style')].map((s) => s.outerHTML).join('\n');
    return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
${styles}
${inline}
<style>
  @page { size: ${w}mm ${h}mm; margin: 0; }
  *, *::before, *::after { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  html, body { height: auto !important; overflow: visible !important; display: block !important; margin: 0; width: auto !important; }
  body { background: #e5e7eb; padding: 16px; font-family: 'Inter', Arial, sans-serif; }
  #pool { position: absolute; left: -99999px; top: 0; visibility: hidden; }
  .pdf-page { position: relative; box-sizing: border-box; background: #fff; overflow: hidden; margin: 0 auto 16px;
    width: ${w}mm; height: ${h}mm; padding: ${MARGIN}mm; display: flex; flex-direction: column; box-shadow: 0 2px 12px rgba(0,0,0,.25); }
  .pdf-head, .pdf-foot { flex: 0 0 auto; display: flex; justify-content: space-between; align-items: center; color: #6b7280; font-size: 9pt; }
  .pdf-head { height: ${HEAD}mm; border-bottom: 1px solid #e5e7eb; margin-bottom: ${GAP}mm; }
  .pdf-head b { color: #800000; }
  .pdf-foot { height: ${FOOT}mm; border-top: 1px solid #e5e7eb; margin-top: ${GAP}mm; }
  .pdf-body { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: ${GAP}mm; overflow: hidden; }
  .pdf-fit { transform-origin: top left; box-sizing: border-box; }
  .pdf-item * { max-width: 100%; }
  .pdf-item { box-sizing: border-box !important; margin: 0 !important; width: 100% !important; max-width: none !important; box-shadow: none !important;
    break-inside: avoid; overflow: visible; }
  .pdf-item .chart-area, .pdf-item .gender-donut-wrap { min-height: 0 !important; height: auto !important; }
  .pdf-item .chart-area::before, .pdf-item .chart-area::after { display: none !important; }
  .pdf-img { display: block; width: 100%; height: auto; }
  .pdf-caption { font-size: 10.5pt; color: #4b5563; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
    padding: 6px 10px; margin: -4px 0 12px; }
  .pdf-item .kpi-layout { grid-template-columns: 1.15fr 1.6fr !important; }
  .pdf-item .kpi-main { min-width: 0; }
  .pdf-item .kpi-layout { overflow: visible !important; }
  .pdf-item .kpi-mini { flex: 0 0 auto !important; min-height: 0 !important; }
  .pdf-item .kpi-main-label { font-size: 20px; }
  .pdf-item .kpi-main-value { font-size: 3rem; }
  .pdf-item .kpi-main-body { flex-wrap: wrap; row-gap: 6px; }
  @media print {
    body { background: #fff !important; padding: 0 !important; }
    .pdf-page { margin: 0 !important; box-shadow: none !important; break-after: page; page-break-after: always; }
    .pdf-page:last-child { break-after: auto; page-break-after: auto; }
  }
</style></head><body><div id="pool">${items.map((n) => n.outerHTML).join('')}</div></body></html>`;
  }

  /* measure the cards at page width, then pack them onto pages */
  function paginate(doc, dashTitle) {
    const { w, h } = pageSize();
    const cw = (w - 2 * MARGIN) * MM;
    const ch = (h - 2 * MARGIN - HEAD - FOOT - 2 * GAP) * MM;
    const gapPx = GAP * MM;
    const pool = doc.getElementById('pool');
    pool.style.width = cw + 'px';
    const items = [...pool.children];
    const meta = items.map((el) => ({ el, h: el.getBoundingClientRect().height, name: el.querySelector('.card-title')?.textContent.trim() || '' }));

    const pages = [];
    let cur = null, used = 0;
    meta.forEach((m) => {
      let scale = 1;
      if (m.h > ch) scale = ch / m.h;
      const need = m.h * scale;
      if (!cur || used + (cur.items.length ? gapPx : 0) + need > ch + 0.5) { cur = { items: [] }; pages.push(cur); used = 0; }
      used += (cur.items.length ? gapPx : 0) + need;
      cur.items.push({ ...m, scale });
    });

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    pages.forEach((pg, i) => {
      const page = doc.createElement('section');
      page.className = 'pdf-page';
      page.innerHTML = `<div class="pdf-head"><span><b>NovaSight</b> · ${esc(dashTitle)}</span><span>${esc(today)}</span></div>
        <div class="pdf-body"></div>
        <div class="pdf-foot"><span>Bataan Peninsula State University</span><span>Page ${i + 1} of ${pages.length}</span></div>`;
      const body = page.querySelector('.pdf-body');
      pg.items.forEach((m) => {
        if (m.scale < 1) {
          const box = doc.createElement('div');
          box.style.cssText = `height:${m.h * m.scale}px;width:${cw * m.scale}px;overflow:hidden;`;
          const fit = doc.createElement('div');
          fit.className = 'pdf-fit';
          fit.style.cssText = `width:${cw}px;transform:scale(${m.scale});`;
          fit.appendChild(m.el); box.appendChild(fit); body.appendChild(box);
        } else body.appendChild(m.el);
      });
      doc.body.appendChild(page);
    });
    pool.remove();
    return pages.map((pg) => ({ names: pg.items.map((m) => m.name), scaled: pg.items.filter((m) => m.scale < 1).map((m) => m.name) }));
  }

  /* ── build / rebuild the preview ─────────────────────────────────────── */
  async function render() {
    const token = ++state.token;
    const selected = cards().filter((c) => !state.off.has(c.id));
    setBusy(true);
    if (!selected.length) { state.pageInfo = []; showInfo(); setBusy(false); return; }

    const dashTitle = document.querySelector('.dash-title')?.textContent.trim() || document.title;
    const items = selected.map(makeItem);
    await new Promise((resolve) => {
      frame.onload = resolve;
      frame.style.width = ((pageSize().w * MM) + 32) + 'px';
      frame.srcdoc = docHtml(items, dashTitle);
    });
    if (token !== state.token) return;
    const doc = frame.contentDocument;
    try { await (doc.fonts && doc.fonts.ready); } catch (e) { /* ignore */ }
    await Promise.all([...doc.images].map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
    if (token !== state.token) return;
    state.pageInfo = paginate(doc, dashTitle);
    frame.style.height = doc.documentElement.scrollHeight + 'px';
    fitPreview();
    showInfo();
    setBusy(false);
  }

  function fitPreview() {
    const wrap = modal.querySelector('.pdf-preview');
    const natural = pageSize().w * MM + 32;
    const k = Math.min(1, (wrap.clientWidth - 4) / natural);
    frame.style.transform = `scale(${k})`;
    sizer.style.width = natural * k + 'px';
    sizer.style.height = (frame.contentDocument ? frame.contentDocument.documentElement.scrollHeight : 0) * k + 'px';
  }

  /* ── modal ───────────────────────────────────────────────────────────── */
  function build() {
    if (built) return;
    built = true;
    modal = document.createElement('div');
    modal.className = 'kpi-table-modal pdf-modal hidden';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Download PDF');
    modal.innerHTML = `
      <div class="kpi-table-modal-card pdf-modal-card">
        <div class="kpi-table-modal-header">
          <span>Download PDF</span>
          <div class="kpi-table-modal-header-actions">
            <button type="button" class="kpi-filter-popover-close" data-pdf-close aria-label="Close">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor" style="width:20px"><path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"/></svg>
            </button>
          </div>
        </div>
        <div class="kpi-table-modal-body pdf-body-wrap">
          <div class="pdf-options">
            <div class="pdf-count" id="pdfCount" aria-live="polite"></div>
            <div class="pdf-group">
              <div class="pdf-label">Charts to include</div>
              <div id="pdfCharts" class="pdf-checks"></div>
            </div>
            <div class="pdf-group pdf-row">
              <label class="pdf-field"><span class="pdf-label">Paper</span>
                <select id="pdfPaper" class="gf-select"><option value="a4">A4</option><option value="letter">Letter</option></select></label>
              <div class="pdf-field"><span class="pdf-label">Orientation</span>
                <div class="pdf-seg" id="pdfOrient">
                  <button type="button" data-o="portrait" class="active">Portrait</button>
                  <button type="button" data-o="landscape">Landscape</button>
                </div></div>
            </div>
            <div class="pdf-pages" id="pdfPages"></div>
            <p class="pdf-hint">Only the charts are printed. A print window opens next — choose <b>Save as PDF</b> as the destination.</p>
          </div>
          <div class="pdf-preview-col">
            <div class="pdf-label">Preview</div>
            <div class="pdf-preview"><div class="pdf-sizer" id="pdfSizer"><iframe id="pdfFrame" title="PDF preview" tabindex="-1"></iframe></div>
              <div class="pdf-busy" id="pdfBusy"><div class="chart-spinner"></div><span>Preparing pages…</span></div></div>
          </div>
        </div>
        <div class="pdf-footer">
          <button type="button" class="btn-action" data-pdf-close>Cancel</button>
          <button type="button" class="btn-apply" id="pdfGo">Download PDF</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    frame = $('pdfFrame');
    sizer = $('pdfSizer');

    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
    modal.querySelectorAll('[data-pdf-close]').forEach((b) => b.addEventListener('click', close));
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modal.classList.contains('hidden')) close(); });
    $('pdfPaper').addEventListener('change', (e) => { state.paper = e.target.value; render(); });
    $('pdfOrient').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-o]'); if (!b) return;
      state.orient = b.dataset.o;
      $('pdfOrient').querySelectorAll('button').forEach((x) => x.classList.toggle('active', x === b));
      render();
    });
    $('pdfGo').addEventListener('click', doPrint);
    window.addEventListener('resize', () => { if (!modal.classList.contains('hidden') && frame.contentDocument) fitPreview(); });
  }

  function open() {
    build();
    const list = $('pdfCharts');
    list.innerHTML = cards().map((c) => `
      <label class="pdf-check"><input type="checkbox" value="${esc(c.id)}" ${state.off.has(c.id) ? '' : 'checked'}>
      <span>${esc(titleOf(c))}</span>${c.classList.contains('is-loading') ? '<em>loading…</em>' : ''}</label>`).join('');
    list.onchange = (e) => {
      const cb = e.target; if (!cb || cb.type !== 'checkbox') return;
      cb.checked ? state.off.delete(cb.value) : state.off.add(cb.value);
      render();
    };
    modal.classList.remove('hidden');
    document.body.classList.add('pdf-modal-open');
    render();
  }

  function close() {
    if (!modal) return;
    modal.classList.add('hidden');
    document.body.classList.remove('pdf-modal-open');
    state.token++;
    if (frame) frame.srcdoc = '<!DOCTYPE html><title></title>';
  }

  function setBusy(b) {
    state.busy = b;
    const el = $('pdfBusy'); if (el) el.classList.toggle('on', b);
    const go = $('pdfGo'); if (go) go.disabled = b || !state.pageInfo.length;
  }

  function showInfo() {
    const n = state.pageInfo.length;
    const c = $('pdfCount');
    c.innerHTML = n ? `This PDF will have <b>${n} page${n === 1 ? '' : 's'}</b>` : 'Select at least one chart to include';
    $('pdfPages').innerHTML = state.pageInfo.map((p, i) => `
      <div class="pdf-pageitem"><b>Page ${i + 1}</b><span>${esc(p.names.join(', '))}</span>${p.scaled.length ? '<em>scaled to fit</em>' : ''}</div>`).join('');
    const go = $('pdfGo');
    go.textContent = n ? `Download PDF (${n} page${n === 1 ? '' : 's'})` : 'Download PDF';
    go.disabled = !n || state.busy;
  }

  function doPrint() {
    if (!frame || !frame.contentWindow || !state.pageInfo.length) return;
    const dash = (document.querySelector('.dash-title')?.textContent.trim() || 'Dashboard').replace(/\s+/g, '-');
    const stamp = new Date().toISOString().slice(0, 10);
    const oldTitle = document.title;
    const name = `NovaSight-${dash}-${stamp}`;
    document.title = name;                                   // browsers suggest this as the file name
    try { frame.contentDocument.title = name; } catch (e) { /* ignore */ }
    const restore = () => { document.title = oldTitle; };
    frame.contentWindow.addEventListener('afterprint', restore, { once: true });
    setTimeout(restore, 60000);
    frame.contentWindow.focus();
    frame.contentWindow.print();
  }

  /* ── wire the page's button ───────────────────────────────────────────── */
  function init() {
    const btn = $('btnDownloadPdf');
    if (!btn || btn.dataset.pdfBound) return;
    btn.dataset.pdfBound = '1';
    btn.addEventListener('click', open);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();