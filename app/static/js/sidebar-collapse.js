// Collapse / expand the admin sidebar (desktop). State is remembered per browser.
(function () {
  var KEY = 'adminSidebarCollapsed', body = document.body;
  var btn = document.getElementById('sidebarCollapseBtn');
  function apply(c) {
    body.classList.toggle('sidebar-collapsed', c);
    if (btn) { btn.setAttribute('aria-expanded', String(!c)); btn.title = c ? 'Expand sidebar' : 'Collapse sidebar'; }
    // charts size themselves to their container — nudge them after the width transition
    setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 280);
  }
  try { apply(localStorage.getItem(KEY) === '1'); } catch (e) { apply(false); }
  if (btn) btn.addEventListener('click', function () {
    var c = !body.classList.contains('sidebar-collapsed');
    try { localStorage.setItem(KEY, c ? '1' : '0'); } catch (e) {}
    apply(c);
  });

  // Mobile drawer (burger)
  var burger = document.getElementById('sidebarBurger');
  function drawer(open) { body.classList.toggle('drawer-open', open); if (burger) burger.setAttribute('aria-expanded', String(open)); }
  if (burger) burger.addEventListener('click', function () { drawer(!body.classList.contains('drawer-open')); });
  ['sidebarBackdrop', 'sidebarClose'].forEach(function (id) { var e = document.getElementById(id); if (e) e.addEventListener('click', function () { drawer(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') drawer(false); });
  document.querySelectorAll('#adminSidebar a.menu-btn, #adminSidebar a.menu-active').forEach(function (a) { a.addEventListener('click', function () { drawer(false); }); });

})();