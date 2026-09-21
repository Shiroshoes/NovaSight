/**
 * sidebar-drawer.js — off-canvas sidebar for tablet / phone.
 *
 * Include on any page that uses studentaffair.css:
 *   <script src="{{ url_for('static', filename='js/sidebar-drawer.js') }}" defer></script>
 *
 * It injects, by itself (no HTML changes needed on the page):
 *   • a hamburger button at the start of the header's .brand block
 *   • a dimmed backdrop behind the drawer
 *   • a close (✕) button inside the sidebar
 * Which of these are visible is decided entirely by the @media (max-width:1100px)
 * rules in studentaffair.css, so on desktop nothing changes.
 *
 * Closes on: backdrop tap, ✕, Esc, swipe-left, following a real link,
 * or the window growing back to desktop width.
 */
(function () {
  'use strict';

  const sidebar = document.querySelector('.sidebar');
  const brand   = document.querySelector('.topmenu .brand');
  if (!sidebar || !brand) return;

  if (!sidebar.id) sidebar.id = 'appSidebar';

  const MQ = window.matchMedia('(max-width: 1100px)');

  const ICON_MENU  = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5M3.75 17.25h16.5"/></svg>';
  const ICON_CLOSE = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12"/></svg>';

  // hamburger
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'nav-toggle';
  toggle.setAttribute('aria-controls', sidebar.id);
  toggle.setAttribute('aria-expanded', 'false');
  toggle.setAttribute('aria-label', 'Open navigation menu');
  toggle.innerHTML = ICON_MENU;
  brand.insertBefore(toggle, brand.firstChild);

  // ✕ inside the drawer
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'nav-close';
  closeBtn.setAttribute('aria-label', 'Close navigation menu');
  closeBtn.innerHTML = ICON_CLOSE;
  sidebar.appendChild(closeBtn);

  // backdrop
  const backdrop = document.createElement('div');
  backdrop.className = 'sidebar-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  document.body.appendChild(backdrop);

  function isOpen() { return sidebar.classList.contains('is-open'); }

  function open() {
    if (!MQ.matches) return;
    sidebar.classList.add('is-open');
    backdrop.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    toggle.setAttribute('aria-label', 'Close navigation menu');
    // focus after the visibility transition has started
    requestAnimationFrame(() => closeBtn.focus({ preventScroll: true }));
  }

  function close(returnFocus) {
    if (!isOpen()) return;
    sidebar.classList.remove('is-open');
    backdrop.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.setAttribute('aria-label', 'Open navigation menu');
    if (returnFocus) toggle.focus({ preventScroll: true });
  }

  toggle.addEventListener('click', () => (isOpen() ? close(true) : open()));
  closeBtn.addEventListener('click', () => close(true));
  backdrop.addEventListener('click', () => close(true));

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen()) close(true);
  });

  // Follow-a-link closes the drawer. Links that only run JS / toggle a submenu
  // (href="#", href="javascript:…") must keep it open.
  sidebar.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (href === '#' || href.startsWith('javascript:')) return;
    close(false);
  });

  // swipe left on the drawer to dismiss
  let touchX = null, touchY = null;
  sidebar.addEventListener('touchstart', (e) => {
    touchX = e.touches[0].clientX;
    touchY = e.touches[0].clientY;
  }, { passive: true });
  sidebar.addEventListener('touchend', (e) => {
    if (touchX === null) return;
    const dx = e.changedTouches[0].clientX - touchX;
    const dy = e.changedTouches[0].clientY - touchY;
    touchX = touchY = null;
    if (dx < -60 && Math.abs(dx) > Math.abs(dy) * 1.5) close(true);
  }, { passive: true });

  // swipe right from the screen's left edge to open the drawer
  const EDGE_ZONE = 24; // px from the left edge that counts as an edge-swipe start
  let edgeX = null, edgeY = null, edgeSwipeActive = false;

  document.addEventListener('touchstart', (e) => {
    if (!MQ.matches || isOpen()) return;
    const t = e.touches[0];
    if (t.clientX > EDGE_ZONE) return;
    edgeX = t.clientX;
    edgeY = t.clientY;
    edgeSwipeActive = true;
  }, { passive: true });

  document.addEventListener('touchend', (e) => {
    if (!edgeSwipeActive) return;
    edgeSwipeActive = false;
    if (edgeX === null) return;
    const dx = e.changedTouches[0].clientX - edgeX;
    const dy = e.changedTouches[0].clientY - edgeY;
    edgeX = edgeY = null;
    if (dx > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) open();
  }, { passive: true });

  // rotate / resize back to desktop → reset
  const onChange = () => { if (!MQ.matches) close(false); };
  if (MQ.addEventListener) MQ.addEventListener('change', onChange);
  else if (MQ.addListener) MQ.addListener(onChange);
})();