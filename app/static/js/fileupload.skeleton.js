/* fileupload.skeleton.js — shows a skeleton of the pipeline steps inside an upload card
   while it is in the "Uploading…" state (file being sent + validated). It disappears as soon as
   the card changes state (expanded steps, Queued, Rejected, Error). Reads the DOM only; fileupload.js is untouched. */
(function () {
  'use strict';
  var queue = document.getElementById('pipelineQueue');
  if (!queue) return;

  var ROWS = [[38, 72], [30, 64], [42, 58]];
  function skeletonHTML() {
    return ROWS.map(function (w) {
      return '<div class="up-skel-row"><span class="skel skel--dot"></span><div class="up-skel-lines">' +
             '<span class="skel" style="width:' + w[0] + '%"></span>' +
             '<span class="skel" style="width:' + w[1] + '%"></span></div></div>';
    }).join('');
  }

  function sync(card) {
    var pill = card.querySelector('.queue-status-pill');
    var uploading = !!pill && /^uploading/i.test(pill.textContent.trim());
    var el = card.querySelector('.up-skel');
    if (uploading && !el) {
      el = document.createElement('div');
      el.className = 'up-skel';
      el.setAttribute('aria-busy', 'true');
      el.innerHTML = '<span class="sr-only">Uploading and validating…</span>' + skeletonHTML();
      card.appendChild(el);
    } else if (!uploading && el) {
      el.remove();
    }
  }

  function syncAll() { queue.querySelectorAll('.pipeline-card').forEach(sync); }

  new MutationObserver(syncAll).observe(queue, { childList: true, subtree: true, characterData: true });
  syncAll();
})();
