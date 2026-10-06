/* fileupload.dropdown.js — animated dropdown for the Academic Year / Term filters.
   Wraps each .gf-select in a custom menu and keeps the native <select> as the
   source of truth, so the existing filter code (value, options, disabled, change) keeps working. */
(function () {
  'use strict';
  var CHEV = '<svg class="fu-dd-chev" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.22 7.22a.75.75 0 0 1 1.06 0L10 10.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 8.28a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd"/></svg>';
  var desc = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  var all = [];

  function closeAll(except) { all.forEach(function (d) { if (d !== except) d.close(); }); }

  function enhance(sel) {
    if (sel.dataset.fuDd) return;
    sel.dataset.fuDd = '1';

    var wrap = document.createElement('div'); wrap.className = 'fu-dd';
    var btn  = document.createElement('button'); btn.type = 'button'; btn.className = 'fu-dd-btn';
    btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', sel.getAttribute('aria-label') || 'Filter');
    var menu = document.createElement('ul'); menu.className = 'fu-dd-menu'; menu.setAttribute('role', 'listbox');

    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel); wrap.appendChild(btn); wrap.appendChild(menu);

    var kb = -1;

    function sync() {
      var opts = Array.prototype.slice.call(sel.options);
      menu.innerHTML = opts.map(function (o, i) {
        var s = o.value === sel.value;
        return '<li class="fu-dd-item" role="option" data-i="' + i + '" aria-selected="' + s + '">' +
               '<span></span></li>';
      }).join('');
      Array.prototype.forEach.call(menu.children, function (li, i) { li.firstChild.textContent = opts[i].textContent; });
      var cur = sel.options[sel.selectedIndex];
      btn.innerHTML = '<span></span>' + CHEV;
      btn.firstChild.textContent = cur ? cur.textContent : '';
      btn.disabled = sel.disabled;
      btn.classList.toggle('is-active', sel.classList.contains('is-active'));
      if (sel.disabled) api.close();
    }

    function open() {
      if (sel.disabled) return;
      closeAll(api);
      var r = btn.getBoundingClientRect();
      wrap.classList.toggle('up', window.innerHeight - r.bottom < 280 && r.top > 280);
      wrap.classList.add('open'); btn.setAttribute('aria-expanded', 'true');
      var s = menu.querySelector('[aria-selected="true"]'); kb = s ? +s.dataset.i : 0;
      mark(); if (s) s.scrollIntoView({ block: 'nearest' });
    }
    function close() { wrap.classList.remove('open'); btn.setAttribute('aria-expanded', 'false'); }
    function mark() {
      Array.prototype.forEach.call(menu.children, function (li, i) { li.classList.toggle('kb', i === kb); });
      if (menu.children[kb]) menu.children[kb].scrollIntoView({ block: 'nearest' });
    }
    function pick(i) {
      var o = sel.options[i]; if (!o) return;
      var changed = o.value !== sel.value;
      desc.set.call(sel, o.value); sync(); close(); btn.focus();
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    }

    btn.addEventListener('click', function () { wrap.classList.contains('open') ? close() : open(); });
    menu.addEventListener('click', function (e) { var li = e.target.closest('.fu-dd-item'); if (li) pick(+li.dataset.i); });
    btn.addEventListener('keydown', function (e) {
      var isOpen = wrap.classList.contains('open'), n = sel.options.length;
      if (e.key === 'Escape' && isOpen) { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault(); if (!isOpen) return open();
        kb = (kb + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; mark();
      } else if ((e.key === 'Enter' || e.key === ' ') && isOpen) { e.preventDefault(); pick(kb); }
    });

    // keep in step with the existing filter code (it rebuilds options and sets .value / .disabled directly)
    Object.defineProperty(sel, 'value', {
      configurable: true,
      get: function () { return desc.get.call(this); },
      set: function (v) { desc.set.call(this, v); sync(); }
    });
    new MutationObserver(sync).observe(sel, { childList: true, attributes: true, attributeFilter: ['disabled', 'class'] });

    var api = { close: close }; all.push(api);
    sync();
  }

  function init() { document.querySelectorAll('select.gf-select').forEach(enhance); }
  document.addEventListener('click', function (e) { if (!e.target.closest('.fu-dd')) closeAll(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
