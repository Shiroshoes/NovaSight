/* Skeleton loader for the Admin page.
   - <head> inline script adds .is-loading to <html> (prevents a flash of content)
   - this file builds placeholders that mirror the real layout, then swaps them out.
   - window.AdminSkeleton.show() / .hide() can be called manually (e.g. around a refetch). */
(function () {
  var MIN_MS = 600;     // never flash: show the skeleton at least this long
  var MAX_MS = 5000;    // failsafe: always reveal real content eventually
  var started = Date.now();
  var root = document.documentElement;
  var layer = null;
  var done = false;

  function el(cls, tag) { var n = document.createElement(tag || 'div'); n.className = cls; return n; }

  function rows(count) {
    var f = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      var r = el('sk-row');
      r.appendChild(el('sk sk-circle'));
      var t = el('sk-text'); t.appendChild(el('sk sk-line')); t.appendChild(el('sk sk-line'));
      r.appendChild(t);
      r.appendChild(el('sk sk-pill'));
      f.appendChild(r);
    }
    return f;
  }

  function listCard(count) {
    var c = el('sk-card');
    c.appendChild(el('sk sk-title'));
    c.appendChild(el('sk-rule'));
    c.appendChild(rows(count));
    return c;
  }

  function formCard() {
    var c = el('sk-card');
    var p = el('sk-portal');
    p.appendChild(el('sk sk-icon'));
    var t = el('sk-text'); t.appendChild(el('sk sk-line')); t.appendChild(el('sk sk-line'));
    p.appendChild(t);
    c.appendChild(p);
    c.appendChild(el('sk sk-add'));       // "Edit User" row
    c.appendChild(el('sk sk-add'));       // "Add User" row
    return c;
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  function build() {
    var grid = document.querySelector('.main-scroll > .dashboard-grid');
    if (!grid) return null;
    var cards = grid.querySelectorAll('.dashboard-col-left > .card');
    var active = cards[0] ? cards[0].querySelectorAll('.account-item').length : 0;
    var inactive = cards[1] ? cards[1].querySelectorAll('.account-item').length : 0;

    var sk = el('dashboard-grid sk-grid');
    sk.setAttribute('aria-hidden', 'true');
    var left = el('dashboard-col-left sk-col');
    left.appendChild(listCard(clamp(active || 4, 2, 6)));
    left.appendChild(listCard(clamp(inactive || 2, 1, 3)));
    var right = el('dashboard-col-right');
    right.appendChild(formCard());
    sk.appendChild(left); sk.appendChild(right);
    grid.parentNode.insertBefore(sk, grid);
    return sk;
  }

  function show() {
    done = false; started = Date.now();
    root.classList.add('is-loading');
    if (!layer || !layer.parentNode) layer = build();
  }

  function hide() {
    if (done) return;
    done = true;
    var wait = Math.max(0, MIN_MS - (Date.now() - started));
    setTimeout(function () {
      if (layer) layer.classList.add('sk-leaving');
      setTimeout(function () {
        root.classList.remove('is-loading');   // real grid appears -> entrance animations play
        if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
        layer = null;
      }, layer ? 260 : 0);
    }, wait);
  }

  window.AdminSkeleton = { show: show, hide: hide };

  if (!root.classList.contains('is-loading')) root.classList.add('is-loading');
  layer = build();
  if (document.readyState === 'complete') hide();
  else window.addEventListener('load', hide);
  setTimeout(hide, MAX_MS);
})();
