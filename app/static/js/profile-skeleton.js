/* Skeleton loader for the Profile pages (admin, registrar, deans).
   - <head> inline script adds .is-loading to <html> (prevents a flash of content)
   - this file builds a placeholder card that reuses the real layout classes, then swaps it out.
   - window.ProfileSkeleton.show() / .hide() can be called manually. */
(function () {
  var MIN_MS = 600;   // never flash: keep the skeleton at least this long
  var MAX_MS = 5000;  // failsafe: always reveal the real content
  var started = Date.now();
  var root = document.documentElement;
  var layer = null, done = false;

  function el(cls) { var n = document.createElement('div'); n.className = cls; return n; }
  function panel() { return el('settings-panel'); }

  function field() {
    var f = el('sk-field');
    f.appendChild(el('sk sk-label'));
    f.appendChild(el('sk sk-input'));
    return f;
  }
  function grid(n) {
    var g = el('field-grid');
    for (var i = 0; i < n; i++) g.appendChild(field());
    return g;
  }

  function build() {
    var real = document.querySelector('.main-scroll > .settings-card');
    if (!real) return null;

    var wrap = el('profile-card settings-card sk-wrap');
    wrap.setAttribute('aria-hidden', 'true');
    var layout = el('settings-layout');

    // left: photo + password
    var side = el('settings-side');
    var p1 = panel();
    p1.appendChild(el('sk sk-title'));
    p1.appendChild(el('sk sk-square'));
    p1.appendChild(el('sk sk-box'));
    var p2 = panel();
    p2.appendChild(el('sk sk-title'));
    p2.appendChild(el('sk sk-btn'));
    side.appendChild(p1); side.appendChild(p2);

    // right: profile information + access
    var main = el('settings-main');
    var p3 = panel();
    var head = el('sk-head');
    head.appendChild(el('sk sk-title')); head.appendChild(el('sk sk-pill'));
    p3.appendChild(head);
    p3.appendChild(grid(4));
    var p4 = panel();
    p4.appendChild(el('sk sk-title'));
    p4.appendChild(grid(2));
    p4.appendChild(el('sk sk-hint'));
    main.appendChild(p3); main.appendChild(p4);

    layout.appendChild(side); layout.appendChild(main);
    wrap.appendChild(layout);
    real.parentNode.insertBefore(wrap, real);
    return wrap;
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
        root.classList.remove('is-loading');     // real card appears -> entrance animations play
        if (layer && layer.parentNode) layer.parentNode.removeChild(layer);
        layer = null;
      }, layer ? 240 : 0);
    }, wait);
  }

  window.ProfileSkeleton = { show: show, hide: hide };

  if (!root.classList.contains('is-loading')) root.classList.add('is-loading');
  layer = build();
  if (document.readyState === 'complete') hide();
  else window.addEventListener('load', hide);
  setTimeout(hide, MAX_MS);
})();
