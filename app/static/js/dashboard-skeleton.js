/**
 * dashboard-skeleton.js — swaps the shimmering skeleton cards for the
 * real #dashboardContent once it's ready to show.
 *
 * Include right after the two <section> blocks (#dashboardSkeleton and
 * #dashboardContent) on any page that uses that markup:
 *   <script src="{{ url_for('static', filename='js/dashboard-skeleton.js') }}"></script>
 *
 * There's no AJAX call here — the content is server-rendered — but the
 * dashboard card's background visual (set via data-visual-src) still
 * takes a moment to fetch, so the skeleton stays up until it's loaded
 * (or MAX_MS elapses, whichever comes first), with a MIN_MS floor so
 * it never flashes for an imperceptible instant on a fast connection.
 */
document.addEventListener('DOMContentLoaded', function () {
  const skeleton = document.getElementById('dashboardSkeleton');
  const content  = document.getElementById('dashboardContent');
  if (!skeleton || !content) return;

  const MIN_MS = 400;
  const MAX_MS = 1500;
  const started = Date.now();
  let settled = false;

  function reveal() {
    if (settled) return;
    settled = true;
    const wait = Math.max(0, MIN_MS - (Date.now() - started));
    setTimeout(function () {
      skeleton.classList.add('hidden');
      skeleton.setAttribute('aria-hidden', 'true');
      content.classList.remove('hidden');
      content.classList.add('is-visible');
    }, wait);
  }

  const src = content.dataset.visualSrc;
  if (src) {
    const probe = new Image();
    probe.onload = reveal;
    probe.onerror = reveal;
    probe.src = src;
  } else {
    reveal();
  }

  // Never let the skeleton hang forever if the image stalls.
  setTimeout(reveal, MAX_MS);
});
