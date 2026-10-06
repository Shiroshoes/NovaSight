/* fileupload.js — NovaSight Upload File page (redesigned)
 *
 * Features:
 *  - Upload + pipeline steps (validate → save → preprocess → confirm → separate → train)
 *  - Auto-training: the last step follows /api/training-run and a result card
 *    (#trainCard) is shown when the run finishes
 *  - Preprocessing confirmation modal (null/highlight/plain tabs, warn table)
 *  - Three tables: Invalid/Flagged | Training CSV | CSV Separation (DS00-DS06)
 *  - Archive tab: list archives, restore, blocked indicator
 *  - CSV viewer modal: subtitle, global search + per-column filters, pagination, download, sortable columns
 *  - Section tab switching
 */

(function () {
  'use strict';

  // ── DOM refs ───────────────────────────────────────────────
  const dropZone        = document.getElementById('dropZone');
  const fileInput       = document.getElementById('fileInput');
  const uploadAlert     = document.getElementById('uploadAlert');
  const pipelineCard    = document.getElementById('pipelineCard');
  const pipelineResult  = document.getElementById('pipelineResult');
  const trainCard       = document.getElementById('trainCard');
  const pipelineQueue   = document.getElementById('pipelineQueue');
  const queueSection    = document.getElementById('queueSection');
  const queueCount      = document.getElementById('queueCount');

  const STEP_IDS = ['step-validate','step-upload','step-clean','step-confirm','step-separate','step-train'];

  // Upload queue — one card per concurrent upload
  // Map<uploadId, { card, pollTimer }>
  const uploadQueue = new Map();

  // FIFO queue for sequential processing
  // Each entry: { file, card } — waiting to start preprocessing
  const fileQueue    = [];
  let isProcessing   = false;  // true while any upload is in pending/processing/separating
  // The single processing slot. Exactly ONE card owns it from the moment its
  // preprocessing starts until its training step has finished. drainQueue()
  // refuses to start anything while the slot is taken, so a stray/duplicate
  // "finished" signal can never launch the rest of the queue at once.
  let activeCard     = null;

  let pollTimer       = null;
  let trainTimer      = null;
  let currentUploadId = null;
  let pendingArchive  = null;
  let pendingRestore  = null;
  const confirmedIds  = new Set();

  // ── Utilities ──────────────────────────────────────────────
  const esc = (s) => {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  };

  // fetch() + JSON, but a non-2xx response becomes an Error carrying the
  // server's own message ({"error": "..."} from the API, or a hint when Flask
  // returned its HTML error page). Without this a 500 from a list endpoint was
  // either swallowed or rendered as an empty table ("No ... found").
  async function fetchJson(url, opts) {
    const r = await fetch(url, opts);
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
    if (!r.ok) {
      let msg = data && (data.error || data.message);
      if (!msg) msg = (text && !text.trim().startsWith('<') && text.length < 300)
        ? text.trim()
        : 'server error page returned — check the server log';
      const err = new Error(`HTTP ${r.status}: ${msg}`);
      err.status = r.status;
      throw err;
    }
    return data;
  }
  const fmt = (b) => {
    if (!b && b !== 0) return '';
    const kb = b / 1024;
    return kb > 1024 ? (kb/1024).toFixed(1)+' MB' : kb.toFixed(1)+' KB';
  };
  const fmtNum = (n) => n != null ? Number(n).toLocaleString() : '—';
  const fmtAcc = (v) => {
    if (v == null) return '—';
    const n = parseFloat(v);
    const cls = n >= 99 ? 'acc-good' : n >= 95 ? 'acc-warn' : 'acc-bad';
    return `<span class="badge-acc ${cls}">${n.toFixed(1)}%</span>`;
  };

  function setStep(id, state) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('step--waiting','step--running','step--done','step--error');
    el.classList.add('step--' + state);
  }
  function resetSteps() {
    STEP_IDS.forEach(id => setStep(id, 'waiting'));
    showTrainStep(false);
  }
  // The "Model training" step is only shown when a training run really happens
  // (6 semesters for the first training, then every 2 new semesters).
  // Otherwise it stays hidden so the pipeline doesn't show a step that never runs.
  function showTrainStep(show) {
    const el = document.getElementById('step-train');
    if (el) el.classList.toggle('step--off', !show);
  }
  function showTrainStepOn(card, show) {
    const el = card.querySelector('[data-step="train"]');
    if (el) el.classList.toggle('step--off', !show);
  }

  // ── Per-card step helpers ──────────────────────────────────
  function setStepOn(card, key, state) {
    const el = card.querySelector('[data-step="' + key + '"]');
    if (!el) return;
    el.classList.remove('step--waiting','step--running','step--done','step--error');
    el.classList.add('step--' + state);
  }

  // ── Queue section show/hide ────────────────────────────────
  function updateQueueSection() {
    if (!queueSection) return;
    const count = pipelineQueue ? pipelineQueue.children.length : 0;
    if (count === 0) {
      queueSection.style.display = 'none';
    } else {
      queueSection.style.display = '';
      if (queueCount) queueCount.textContent = count === 1 ? '1 upload' : count + ' uploads';
    }
  }

  // ── Alert banner ───────────────────────────────────────────
  const ALERT_MS = 60000;   // 1 minute auto-hide
  const FADE_MS  = 300;
  let alertTimer = null;
  let fadeTimer  = null;

  let alertOwner = null;   // pipeline card that owns the current alert (if any)

  function scheduleAlertHide() {
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => {
      uploadAlert.style.opacity = '0';
      fadeTimer = setTimeout(clearAlert, FADE_MS);
    }, ALERT_MS);
  }
  // `owner` = the pipeline card this alert belongs to. An owned alert stays
  // until that card is gone (no timed auto-hide); un-owned alerts auto-hide.
  function showAlert(msg, kind, owner) {
    clearTimeout(alertTimer); clearTimeout(fadeTimer);
    alertOwner = owner || null;
    uploadAlert.className = 'upload-alert upload-alert--' + kind;
    uploadAlert.innerHTML = `<span class="alert-msg">${msg}</span>`;
    uploadAlert.style.transition = 'opacity ' + FADE_MS + 'ms ease';
    uploadAlert.style.opacity = '1';
    uploadAlert.classList.remove('hidden');
    if (!alertOwner) scheduleAlertHide();
  }
  // Clear the banner only if it belongs to this card
  function clearAlertFor(card) {
    if (card && alertOwner === card) clearAlert();
  }
  function clearAlert() {
    alertOwner = null;
    clearTimeout(alertTimer); clearTimeout(fadeTimer);
    uploadAlert.classList.add('hidden');
    uploadAlert.innerHTML = '';
    uploadAlert.style.opacity = '';
  }

  // ── Pipeline card (legacy — training-resume only) ──────────
  const CARD_HIDE_MS = 3000;
  let cardTimer = null, cardFadeTimer = null;
  if (pipelineCard) pipelineCard.style.transition = 'opacity ' + FADE_MS + 'ms ease';

  function cancelCardHide() {
    clearTimeout(cardTimer); clearTimeout(cardFadeTimer);
    cardTimer = cardFadeTimer = null;
    if (pipelineCard) pipelineCard.style.opacity = '';
  }
  function showPipelineCard() {
    cancelCardHide();
    if (!pipelineCard) return;
    pipelineCard.style.display = '';
    pipelineCard.classList.remove('hidden');
  }
  function hidePipelineCard() {
    cancelCardHide();
    if (!pipelineCard) return;
    pipelineCard.classList.add('hidden');
    pipelineCard.style.display = 'none';
  }
  function scheduleCardHide() {
    clearTimeout(cardTimer); clearTimeout(cardFadeTimer);
    if (!pipelineCard) return;
    pipelineCard.style.opacity = '1';
    cardTimer = setTimeout(() => {
      pipelineCard.style.opacity = '0';
      cardFadeTimer = setTimeout(hidePipelineCard, FADE_MS);
    }, CARD_HIDE_MS);
  }

  // ── Queue card factory ─────────────────────────────────────
  // Cards start COMPACT — just the file header + a "Queued" status pill.
  // Once the upload is accepted and processing begins, expandCard() is called
  // to reveal the full pipeline steps. Rejected cards stay compact and show
  // the error inline — never expand.
  function createQueueCard(filename, filesize) {
    const card = document.createElement('div');
    card.className = 'pipeline-card pipeline-card--compact';

    const steps = [
      ['validate', 'Validating format',    'Checking extension, filename pattern, and workbook structure'],
      ['upload',   'Saving file',          'Duplicate check passed · stored in Unprocessed Datasets'],
      ['clean',    'Preprocessing',        'Parsing sheets, resolving grades, computing GWA'],
      ['confirm',  'Awaiting confirmation','Review flagged rows then confirm or cancel'],
      ['separate', 'CSV separation',       'Building DS00–DS06 chart datasets'],
      ['train',    'Model training',       'Retraining the prediction models on all uploaded semesters'],
    ];

    card.innerHTML = `
      <div class="pipeline-file">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
             style="width:20px;color:#800000;flex-shrink:0">
          <path fill-rule="evenodd" d="M17.663 3.118c.225.015.45.032.673.05C19.876 3.298 21
            4.604 21 6.109v9.642a3 3 0 0 1-3 3V16.5c0-5.922-4.576-10.775-10.384-11.217.324-1.132
            1.3-2.01 2.548-2.114.224-.019.448-.036.673-.051A3 3 0 0 1 13.5 1.5H15a3 3 0 0 1
            2.663 1.618ZM12 4.5A1.5 1.5 0 0 1 13.5 3H15a1.5 1.5 0 0 1 1.5 1.5H12Z"
            clip-rule="evenodd"/>
          <path d="M3 8.625c0-1.036.84-1.875 1.875-1.875h.375A3.75 3.75 0 0 1 9 10.5v1.875c0
            1.036.84 1.875 1.875 1.875h1.875A3.75 3.75 0 0 1 16.5 18v2.625c0 1.035-.84
            1.875-1.875 1.875h-9.75A1.875 1.875 0 0 1 3 20.625v-12Z"/>
          <path d="M10.5 10.5a5.23 5.23 0 0 0-1.279-3.434 9.768 9.768 0 0 1 6.963 6.963
            5.23 5.23 0 0 0-3.434-1.279h-1.875a.375.375 0 0 1-.375-.375V10.5Z"/>
        </svg>
        <span class="pipeline-filename">${esc(filename)}</span>
        <span class="pipeline-size">${filesize ? '· ' + filesize : ''}</span>
        <span class="queue-status-pill">Uploading…</span>
        <button class="queue-cancel-btn" style="display:none"
                title="Cancel and remove this upload" aria-label="Cancel">Cancel</button>
        <button class="pipeline-close-btn" style="display:none"
                title="Dismiss" aria-label="Dismiss">×</button>
      </div>
      <div class="pipeline-steps" style="display:none">
        ${steps.map(([key, label, desc]) => `
          <div class="pipeline-step step--waiting${key === 'train' ? ' step--off' : ''}" data-step="${key}">
            <div class="step-dot"><span class="step-spinner"></span></div>
            <div class="step-info">
              <span class="step-label">${label}</span>
              <span class="step-desc">${desc}</span>
            </div>
          </div>`).join('')}
      </div>
      <div class="pipeline-result hidden"></div>`;

    // Close button — appears on terminal states only (done/failed/rejected)
    card.querySelector('.pipeline-close-btn').addEventListener('click', () => {
      card.style.transition = 'opacity 300ms ease';
      card.style.opacity = '0';
      clearAlertFor(card);
      setTimeout(() => {
        card.remove();
        if (card._uploadId) uploadQueue.delete(card._uploadId);
        updateQueueSection();
      }, 300);
    });

    // Cancel button — appears on queued cards, removes from DB and queue
    card.querySelector('.queue-cancel-btn').addEventListener('click', () => {
      const uploadId = card._uploadId;
      const btn = card.querySelector('.queue-cancel-btn');
      btn.disabled = true;
      btn.textContent = 'Cancelling…';

      const removeCard = () => {
        // Remove from fileQueue
        const idx = fileQueue.findIndex(item => item.card === card || item.uploadId === uploadId);
        if (idx !== -1) fileQueue.splice(idx, 1);
        if (uploadId) uploadQueue.delete(uploadId);
        clearAlertFor(card);
        card.style.transition = 'opacity 300ms ease';
        card.style.opacity = '0';
        setTimeout(() => { card.remove(); updateQueueSection(); }, 300);
      };

      if (uploadId) {
        fetch('/api/upload-record/' + uploadId, { method: 'DELETE' })
          .then(() => removeCard())
          .catch(() => removeCard()); // remove card regardless
      } else {
        // File not yet saved to server (edge case) — just remove locally
        removeCard();
      }
    });

    if (pipelineQueue) pipelineQueue.appendChild(card);
    updateQueueSection();
    return card;
  }

  // Expand a compact card to show the full pipeline steps
  function expandCard(card) {
    if (!card.classList.contains('pipeline-card--compact')) return;
    card.classList.remove('pipeline-card--compact');
    const steps = card.querySelector('.pipeline-steps');
    if (steps) steps.style.display = '';
    // Remove the status pill and cancel button — steps take over
    card.querySelector('.queue-status-pill')?.remove();
    const cancelBtn = card.querySelector('.queue-cancel-btn');
    if (cancelBtn) cancelBtn.style.display = 'none';
  }

  // Update the status pill text on a compact card
  function setCardPill(card, text, kind) {
    const pill = card.querySelector('.queue-status-pill');
    if (!pill) return;
    pill.textContent = text;
    pill.className = 'queue-status-pill' + (kind ? ' queue-status-pill--' + kind : '');
    // Show cancel button only when genuinely queued (waiting, not uploading or rejected)
    const cancelBtn = card.querySelector('.queue-cancel-btn');
    if (cancelBtn) {
      cancelBtn.style.display = (!kind && text === 'Queued') ? '' : 'none';
    }
  }

  function revealCardClose(card) {
    const btn = card.querySelector('.pipeline-close-btn');
    if (btn) btn.style.display = '';
    // Auto-remove failed/rejected cards after 30 seconds
    setTimeout(() => {
      if (!card.isConnected) return;
      card.style.transition = 'opacity 400ms ease';
      card.style.opacity = '0';
      clearAlertFor(card);
      setTimeout(() => {
        card.remove();
        if (card._uploadId) uploadQueue.delete(card._uploadId);
        updateQueueSection();
      }, 400);
    }, 30000);
  }

  // Single poller per upload: always clears any previous timer first, so a
  // second interval can never be left running (that orphan kept re-firing the
  // 'done' handler -> repeated alerts + table reloads).
  function startQueuePoll(uploadId, card) {
    stopQueuePoll(uploadId);
    const timer = setInterval(() => {
      fetch('/api/upload-status/' + uploadId)
        .then(r => r.json())
        .then(d => onQueueStatusUpdate(uploadId, card, d))
        .catch(() => {});
    }, 2500);
    const entry = uploadQueue.get(uploadId);
    if (entry) entry.pollTimer = timer;
    else uploadQueue.set(uploadId, { card, pollTimer: timer });
  }

  function stopQueuePoll(uploadId) {
    const entry = uploadQueue.get(uploadId);
    if (entry && entry.pollTimer) { clearInterval(entry.pollTimer); entry.pollTimer = null; }
  }

  // ── Section tab switching ─────────────────────────────────
  document.querySelectorAll('.section-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.section-tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(tab.dataset.tab).classList.add('active');
      // lazy-load the active tab
      const loaders = {
        'tab-invalid':    loadInvalidTable,
        'tab-training':   loadTrainingTable,
        'tab-separation': loadSeparationTable,
        'tab-archive':    loadArchiveTable,
      };
      loaders[tab.dataset.tab]?.();
    });
  });

  // ── Drag & drop / browse ──────────────────────────────────
  if (dropZone && fileInput) {
    dropZone.addEventListener('click', (e) => {
      if (e.target.closest('.btn-upload-browse')) return;
      fileInput.click();
    });
    ['dragenter','dragover'].forEach(evt =>
      dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(evt =>
      dropZone.addEventListener(evt, e => { e.preventDefault(); dropZone.classList.remove('dragover'); }));
    dropZone.addEventListener('drop', e => {
      const f = e.dataTransfer.files?.[0];
      if (f) handleFile(f);
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      if (f) handleFile(f);
      fileInput.value = '';
    });
  }

  // ── Upload flow ────────────────────────────────────────────
  // handleFile: validate extension, create compact card.
  // If nothing is processing → start immediately.
  // Otherwise → save the file to server with ?defer=1 (survives navigation)
  // and show a Queued card. drainQueue() triggers preprocessing when ready.
  function handleFile(file) {
    clearAlert();

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      showAlert('Only <strong>.xlsx</strong> files are accepted.', 'error');
      return;
    }

    const card = createQueueCard(file.name, file.size ? fmt(file.size) : '');

    freeStaleSlot();
    if (!activeCard && fileQueue.length === 0) {
      startUpload(file, card);
    } else {
      deferUpload(file, card);
    }
  }

  // Save file to server with defer=1 — record created but preprocessing held
  function deferUpload(file, card) {
    setCardPill(card, 'Queued', null);
    const fd = new FormData();
    fd.append('file', file);

    // Reserve this file's spot in line RIGHT NOW, synchronously, in the
    // order the user actually picked it — not whenever its defer POST
    // happens to come back. Two files' requests can resolve out of order
    // (server/network timing), and without this, whichever response
    // landed first got pushed first — jumping an earlier-picked file.
    const queueItem = { uploadId: null, card };
    fileQueue.push(queueItem);

    fetch('/api/upload-dataset?defer=1', { method:'POST', body:fd })
      .then(async r => ({ ok:r.ok, data: await r.json().catch(()=>({})) }))
      .then(({ ok, data }) => {
        if (!ok) {
          const idx = fileQueue.indexOf(queueItem);
          if (idx !== -1) fileQueue.splice(idx, 1);   // rejected — give up its reserved spot
          const isDup = !!data.duplicate;
          const kind  = isDup ? 'warning' : 'error';
          setCardPill(card, isDup ? 'Duplicate' : 'Rejected', kind);
          const resultEl = card.querySelector('.pipeline-result');
          resultEl.classList.remove('hidden');
          resultEl.className = `pipeline-result pipeline-result--${kind}`;
          resultEl.innerHTML =
            `<span class="result-icon">${isDup ? HI.warn : HI.xmark}</span>` +
            `<span class="result-body">` +
              `<strong class="result-label">${isDup ? 'Rejected — Duplicate' : 'Rejected — Invalid file'}</strong>` +
              `<span class="result-msg">${data.error || 'Upload failed.'}</span>` +
            `</span>`;
          showAlert(data.error || 'Upload failed.', kind, card);
          revealCardClose(card);
          drainQueue();   // this slot is free now — let the next ready item go
          return;
        }
        // File saved on server — won’t be lost on page navigation
        const uploadId = data.upload_id || data.record_id;
        card._uploadId = uploadId;
        queueItem.uploadId = uploadId;   // fill in the reserved spot — position unchanged
        uploadQueue.set(uploadId, { card, pollTimer: null });
        // The slot may have been freed while this request was in flight —
        // without this the card would sit on "Queued" forever.
        drainQueue();
      })
      .catch(err => {
        const idx = fileQueue.indexOf(queueItem);
        if (idx !== -1) fileQueue.splice(idx, 1);
        setCardPill(card, 'Error', 'error');
        const resultEl = card.querySelector('.pipeline-result');
        resultEl.classList.remove('hidden');
        resultEl.className = 'pipeline-result pipeline-result--error';
        resultEl.innerHTML =
          `<span class="result-icon">${HI.xmark}</span>` +
          `<span class="result-body">` +
            `<strong class="result-label">Network error</strong>` +
            `<span class="result-msg">${esc(err.message || String(err))}</span>` +
          `</span>`;
        showAlert('Network error: ' + esc(err.message || String(err)), 'error');
        revealCardClose(card);
        drainQueue();
      });
  }

  // Safety net: a card that was discarded or is no longer on the page can't own the
  // processing slot. Clears it so a new upload starts instead of sitting on "Queued".
  function freeStaleSlot() {
    if (activeCard && (activeCard._discarded || !activeCard.isConnected)) {
      activeCard._released = true;
      activeCard = null;
    }
  }

  // Drain next item from fileQueue when the active upload finishes
  function drainQueue() {
    freeStaleSlot();
    if (activeCard) return;                       // slot busy — one at a time
    if (fileQueue.length === 0) { isProcessing = false; return; }
    const front = fileQueue[0];
    // The file at the front of the line is still waiting on its own defer
    // POST to resolve (reserved a spot, but no uploadId yet) — do nothing;
    // its own .then() will call drainQueue() again once it's ready, and by
    // then it's still correctly at the front.
    if (!front.uploadId && !front.file) return;
    const item = fileQueue.shift();
    activeCard = item.card;
    setCardPill(item.card, 'Uploading…', null);
    if (item.uploadId) {
      startDeferred(item.uploadId, item.card);
    } else {
      startUpload(item.file, item.card);
    }
  }

  // Called when a card is completely finished (done / failed / skipped).
  // Idempotent per card, so repeated status polls can't release the slot twice.
  function releaseSlot(card) {
    if (!card || card._released) return;
    card._released = true;
    if (activeCard === card) activeCard = null;
    drainQueue();
  }

  // Trigger preprocessing for a deferred upload already saved on server
  function startDeferred(uploadId, card) {
    isProcessing = true;
    activeCard = card;
    stopTrainPoll();

    fetch('/api/start-preprocessing/' + uploadId, { method: 'POST' })
      .then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (!ok) {
          setCardPill(card, 'Error', 'error');
          const resultEl = card.querySelector('.pipeline-result');
          resultEl.classList.remove('hidden');
          resultEl.className = 'pipeline-result pipeline-result--error';
          resultEl.innerHTML =
            `<span class="result-icon">${HI.xmark}</span>` +
            `<span class="result-body">` +
              `<strong class="result-label">Failed to start</strong>` +
              `<span class="result-msg">${data.error || 'Could not start preprocessing.'}</span>` +
            `</span>`;
          revealCardClose(card);
          releaseSlot(card);
          return;
        }
        expandCard(card);
        setStepOn(card, 'validate', 'done');
        setStepOn(card, 'upload', 'done');
        setStepOn(card, 'clean', 'running');
        startQueuePoll(uploadId, card);
      })
      .catch(() => { setCardPill(card, 'Error', 'error'); revealCardClose(card); releaseSlot(card); });
  }

  // Send file to server and begin the pipeline for this card
  function startUpload(file, card) {
    isProcessing = true;
    activeCard = card;
    stopTrainPoll();
    setCardPill(card, 'Uploading…', null);

    const fd = new FormData();
    fd.append('file', file);

    fetch('/api/upload-dataset', { method:'POST', body:fd })
      .then(async r => ({ ok:r.ok, status:r.status, data: await r.json().catch(()=>({})) }))
      .then(({ ok, status, data }) => {
        if (!ok) {
          const isDup  = !!data.duplicate;
          const kind   = isDup ? 'warning' : 'error';
          const icon   = isDup ? HI.warn : HI.xmark;
          const label  = isDup ? 'Rejected — Duplicate' : 'Rejected — Invalid file';

          setCardPill(card, isDup ? 'Duplicate' : 'Rejected', kind);

          const resultEl = card.querySelector('.pipeline-result');
          resultEl.classList.remove('hidden');
          resultEl.className = `pipeline-result pipeline-result--${kind}`;
          resultEl.innerHTML =
            `<span class="result-icon">${HI.warn}</span>` +
            `<span class="result-body">` +
              `<strong class="result-label">${label}</strong>` +
              `<span class="result-msg">${data.error || 'Upload failed.'}</span>` +
            `</span>`;

          showAlert(data.error || 'Upload failed.', kind, card);
          revealCardClose(card);
          releaseSlot(card);   // rejection doesn't block the queue
          return;
        }

        expandCard(card);
        setStepOn(card, 'validate', 'done');
        setStepOn(card, 'upload', 'done');
        setStepOn(card, 'clean', 'running');
        showAlert(data.message || 'File accepted — preprocessing started.', 'success', card);

        const uploadId = data.upload_id || data.record_id;
        card._uploadId = uploadId;

        startQueuePoll(uploadId, card);
      })
      .catch(err => {
        setCardPill(card, 'Error', 'error');
        const resultEl = card.querySelector('.pipeline-result');
        resultEl.classList.remove('hidden');
        resultEl.className = 'pipeline-result pipeline-result--error';
        resultEl.innerHTML =
          `<span class="result-icon">${HI.xmark}</span>` +
          `<span class="result-body">` +
            `<strong class="result-label">Network error</strong>` +
            `<span class="result-msg">${esc((err && err.message) || 'Upload failed.')}</span>` +
          `</span>`;
        console.error('[fileupload] upload failed:', err);
        showAlert('Network error: ' + esc((err && err.message) || 'Upload failed.'), 'error', card);
        revealCardClose(card);
        releaseSlot(card);
      });
  }

  // ── Queue status handler ───────────────────────────────────
  function onQueueStatusUpdate(uploadId, card, data) {
    if (card && card._discarded) { stopQueuePoll(uploadId); return; }   // late poll for a discarded upload
    if (data.status === 'processing') {
      setStepOn(card, 'clean', 'running');
      return;
    }
    if (data.status === 'separating') {
      setStepOn(card, 'clean', 'done');
      setStepOn(card, 'confirm', 'done');
      setStepOn(card, 'separate', 'running');
      return;
    }
    if (data.status === 'preprocessing_done') {
      if (confirmedIds.has(uploadId)) {
        setStepOn(card, 'confirm', 'done');
        setStepOn(card, 'separate', 'running');
        return;
      }
      if (preprocModal.classList.contains('open')) return;
      stopQueuePoll(uploadId);
      setStepOn(card, 'clean', 'done');
      setStepOn(card, 'confirm', 'running');
      openPreprocModal(uploadId, data, card);
      startQueuePoll(uploadId, card);
      return;
    }
    if (data.status === 'done') {
      stopQueuePoll(uploadId);
      if (card._doneHandled) return;     // handle success exactly once
      card._doneHandled = true;
      setStepOn(card, 'clean', 'done');
      setStepOn(card, 'confirm', 'done');
      setStepOn(card, 'separate', 'done');
      const resultEl = card.querySelector('.pipeline-result');
      resultEl.classList.remove('hidden');
      resultEl.className = 'pipeline-result pipeline-result--success';
      resultEl.innerHTML =
        `<strong>${esc(data.original_filename)}</strong> processed successfully` +
        (data.row_count ? ` — ${fmtNum(data.row_count)} student rows.` : '.');
      showAlert(
        `<strong>${esc(data.original_filename || 'File')}</strong> uploaded successfully` +
        (data.row_count ? ` — ${fmtNum(data.row_count)} student rows.` : '.'), 'success', card);
      refreshAllTables();            // one reload: upload succeeded
      // Train step stays hidden until /api/training-run says a run really exists.
      // Don't drain the queue yet — wait until training finishes
      fetch('/api/training-run')
        .then(r => r.json())
        .then(run => followTrainingOnCard(run, card))
        .catch(() => followTrainingOnCard(null, card));
      return;
    }
    if (data.status === 'failed') {
      stopQueuePoll(uploadId);
      if (card._failHandled) return;
      card._failHandled = true;
      card.querySelectorAll('[data-step]').forEach(el => {
        if (el.classList.contains('step--running')) {
          el.classList.remove('step--running');
          el.classList.add('step--error');
        }
      });
      const resultEl = card.querySelector('.pipeline-result');
      resultEl.classList.remove('hidden');
      resultEl.className = 'pipeline-result pipeline-result--error';
      resultEl.innerHTML =
        `<strong>${esc(data.original_filename || 'Upload')}</strong> failed — ` +
        esc(data.error_message || 'Unknown error.');
      showAlert(
        `<strong>${esc(data.original_filename || 'Upload')}</strong> upload failed — ` +
        esc(data.error_message || 'Unknown error.'), 'error', card);
      revealCardClose(card);
      refreshAllTables();
      // Failed — release the slot so the next queued file can start
      releaseSlot(card);
    }
  }

  // Per-card training follow
  function followTrainingOnCard(run, card) {
    stopTrainPoll();
    applyTrainingToCard(run, card);
    if (!run || !TRAIN_ACTIVE.includes(run.status)) return;
    trainTimer = setInterval(() => {
      fetch('/api/training-run')
        .then(r => r.json())
        .then(latest => {
          applyTrainingToCard(latest, card);
          if (!latest || !TRAIN_ACTIVE.includes(latest.status)) stopTrainPoll();
        })
        .catch(() => {});
    }, 3000);
  }

  function applyTrainingToCard(run, card) {
    const stepDesc = card.querySelector('[data-step="train"] .step-desc');
    // /api/training-run returns the LATEST run. If it belongs to a different
    // upload it is not ours — treat it as "no run for this upload" instead of
    // reading someone else's 'done' as our own and releasing the slot early.
    if (run && run.upload_id != null && card._uploadId != null &&
        String(run.upload_id) !== String(card._uploadId)) {
      run = null;
    }
    const st = run && run.status;
    if (!st || st === 'none') {
      showTrainStepOn(card, false);     // nothing to train -> no step
      revealCardClose(card);
      releaseSlot(card);   // training skipped/absent — start next
      return;
    }
    showTrainStepOn(card, st !== 'skipped');   // skipped = not enough semesters -> hide
    if (st === 'queued') {
      setStepOn(card, 'train', 'running');
      if (stepDesc) stepDesc.textContent = 'Waiting for an earlier training run to finish…';
    } else if (st === 'running') {
      setStepOn(card, 'train', 'running');
      if (stepDesc) stepDesc.textContent = 'Training models on all uploaded semesters — this can take a few minutes.';
    } else if (st === 'skipped') {
      revealCardClose(card);
      releaseSlot(card);   // training skipped — start next
    } else if (st === 'done') {
      setStepOn(card, 'train', 'done');
      if (stepDesc) stepDesc.textContent = run.has_warnings ? 'Models trained — some had warnings' : 'Models trained successfully';
      if (!card._trainHandled) {
        card._trainHandled = true;
        if (run.has_warnings) { showAlert('Model training finished <strong>with warnings</strong>.', 'warning', card); showTrainingResult(run); }
        else showTrainedAlert(run, card);
        refreshAllTables();          // one reload: training succeeded
      }
      revealCardClose(card);
      releaseSlot(card);   // training done — start next
    } else {
      setStepOn(card, 'train', 'error');
      if (stepDesc) stepDesc.textContent = run.error || 'Training did not complete.';
      showAlert('Model training <strong>' + esc(st) + '</strong> — ' + esc(run.error || 'see details below.'), 'error', card);
      showTrainingResult(run);
      revealCardClose(card);
      releaseSlot(card);   // training errored — start next anyway
    }
  }

  // Legacy poll (training-resume only)
  function pollStatus(uploadId) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      fetch('/api/upload-status/' + uploadId)
        .then(r => r.json())
        .then(data => onStatusUpdate(uploadId, data))
        .catch(() => {});
    }, 2500);
  }

  // ── Auto-training (last pipeline step + result card) ───────
  // The server records the run (queued → running → done | failed | skipped) at
  // /api/training-run. We poll it while it is active, mirror it on the
  // "Model training" step, and — when it finishes — show a result card.
  // (Model evaluation metrics are intentionally NOT shown. A clean success is
  // just an alert that auto-hides; only a failure or errored models keep a card
  // on screen.)
  const TRAIN_ACTIVE      = ['queued', 'running'];
  const TRAIN_DISMISS_KEY = 'ns_train_dismissed_run';

  const fmtDuration = (sec) => {
    if (sec == null || isNaN(sec)) return '—';
    sec = Math.round(sec);
    return sec < 60 ? sec + 's' : Math.floor(sec / 60) + 'm ' + String(sec % 60).padStart(2, '0') + 's';
  };
  const HI = {
    check: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clip-rule="evenodd"/></svg>',
    xmark: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16ZM8.28 7.22a.75.75 0 0 0-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 1 0 1.06 1.06L10 11.06l1.72 1.72a.75.75 0 1 0 1.06-1.06L11.06 10l1.72-1.72a.75.75 0 0 0-1.06-1.06L10 8.94 8.28 7.22Z" clip-rule="evenodd"/></svg>',
    clock: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm.75-13a.75.75 0 0 0-1.5 0v5c0 .414.336.75.75.75h4a.75.75 0 0 0 0-1.5h-3.25V5Z" clip-rule="evenodd"/></svg>',
    warn:  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495ZM10 5a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 10 5Zm0 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" clip-rule="evenodd"/></svg>',
  };
  const dismissedRun = () => { try { return localStorage.getItem(TRAIN_DISMISS_KEY); } catch (e) { return null; } };
  const dismissRun   = (id) => { try { localStorage.setItem(TRAIN_DISMISS_KEY, id || ''); } catch (e) {} };

  function stopTrainPoll() { if (trainTimer) { clearInterval(trainTimer); trainTimer = null; } }
  function setTrainDesc(t) {
    const el = document.querySelector('#step-train .step-desc');
    if (el) el.textContent = t;
  }

  function followTraining(run) {
    stopTrainPoll();
    applyTraining(run);
    if (!run || !TRAIN_ACTIVE.includes(run.status)) return;
    trainTimer = setInterval(() => {
      fetch('/api/training-run')
        .then(r => r.json())
        .then(latest => {
          applyTraining(latest);
          if (!latest || !TRAIN_ACTIVE.includes(latest.status)) stopTrainPoll();
        })
        .catch(() => {});
    }, 3000);
  }

  // Mirror one run state on the step + (when finished) the result card.
  function applyTraining(run) {
    const st = run && run.status;
    if (!st || st === 'none') {                       // nothing recorded for this upload
      showTrainStep(false);
      scheduleCardHide();
      return;
    }
    if (st && st !== 'none' && st !== 'skipped') showTrainStep(true);
    if (st === 'queued') {
      cancelCardHide();
      setStep('step-train', 'running');
      setTrainDesc('Waiting for an earlier training run to finish…');
    } else if (st === 'running') {
      cancelCardHide();
      setStep('step-train', 'running');
      setTrainDesc('Training the models on all uploaded semesters — this can take a few minutes.');
    } else if (st === 'skipped') {
      showTrainStep(false);             // not enough semesters yet -> hide the step
      scheduleCardHide();
    } else if (st === 'done') {
      setStep('step-train', 'done');
      setTrainDesc(run.has_warnings ? 'Models trained — some had warnings' : 'Models trained successfully');
      if (run.has_warnings) {
        showAlert('Model training finished <strong>with warnings</strong> — see the details below.', 'warning');
        showTrainingResult(run);            // stays until dismissed
      } else {
        showTrainedAlert(run);              // plain alert, auto-hides (ALERT_MS)
      }
      scheduleCardHide();
    } else {                                          // failed | interrupted
      setStep('step-train', 'error');
      setTrainDesc(run.error || 'Training did not complete.');
      showAlert('Model training <strong>' + esc(st) + '</strong> — ' + esc(run.error || 'see details below.'), 'error');
      showTrainingResult(run);
      scheduleCardHide();
    }
  }

  // Clean success: only a short alert (same banner as every other message, gone
  // after ALERT_MS). No numbers, no metrics — it just signals that a model was trained.
  function showTrainedAlert(run, card) {
    dismissRun(run.run_id);                 // never re-announced on a later page load
    showAlert('<strong>Machine learning model trained successfully.</strong>', 'success', card);
  }

  // Failed / interrupted / finished with errored models: stays until dismissed.
  // Lists WHAT went wrong — no evaluation metrics.
  function showTrainingResult(run) {
    if (!trainCard) return;
    const s      = run.summary || {};
    const failed = run.status !== 'done';
    const title  = failed
      ? (run.status === 'interrupted' ? 'Model training was interrupted' : 'Model training failed')
      : 'Model training finished with warnings';
    const when = run.finished_at ? new Date(run.finished_at).toLocaleString() : '';

    const chips = [];
    if (!failed) {
      chips.push(`<span class="train-chip train-chip--ok">${HI.check}${fmtNum(s.models_trained)} trained</span>`);
      if (s.models_errored) chips.push(`<span class="train-chip train-chip--err">${HI.xmark}${fmtNum(s.models_errored)} errored</span>`);
    }
    if (run.elapsed_seconds != null) chips.push(`<span class="train-chip">${HI.clock}${fmtDuration(run.elapsed_seconds)}</span>`);

    const problems = (s.models || [])
      .filter(m => ['error', 'failed'].includes(String(m.status || '').toLowerCase()))
      .map(m => {
        const cut  = (m.label || '').lastIndexOf(' — ');
        const name = cut > 0 ? m.label.slice(0, cut) : (m.label || m.key);
        return `<li><strong>${esc(name)}</strong>${m.reason ? ' — ' + esc(m.reason) : ''}</li>`;
      });
    (s.errors || []).forEach(e => problems.push(`<li>${esc(e)}</li>`));

    trainCard.className = 'train-card' + (failed ? ' train-card--error' : ' train-card--warn');
    trainCard.innerHTML = `
      <div class="train-head">
        <div>
          <h3 class="train-title">${title}</h3>
          <div class="train-sub">${run.filename ? esc(run.filename) + ' · ' : ''}${esc(when)}</div>
        </div>
        <button type="button" class="btn-train-dismiss" data-train-dismiss>Dismiss</button>
      </div>
      ${chips.length ? `<div class="train-chips">${chips.join('')}</div>` : ''}
      ${failed && run.error ? `<div class="train-msg">${esc(run.error)}</div>` : ''}
      ${problems.length ? `<ul class="train-errors">${problems.join('')}</ul>` : ''}`;
    trainCard.classList.remove('hidden');
    trainCard.querySelector('[data-train-dismiss]')?.addEventListener('click', () => {
      dismissRun(run.run_id);
      trainCard.classList.add('hidden');
    });
  }

  // On page load: pick up a run that is still going, or show one that finished
  // while the user was away (once — until dismissed).
  function resumeTraining() {
    fetch('/api/training-run')
      .then(r => r.json())
      .then(run => {
        const st = run && run.status;
        if (!st || st === 'none' || st === 'skipped') return;
        if (TRAIN_ACTIVE.includes(st)) {
          showPipelineCard();
          resetSteps();
          document.getElementById('pipelineFilename').textContent = run.filename || '';
          document.getElementById('pipelineSize').textContent = '';
          ['step-validate','step-upload','step-clean','step-confirm','step-separate']
            .forEach(id => setStep(id, 'done'));
          followTraining(run);
        } else if (dismissedRun() !== run.run_id) {
          // finished while the user was away
          if (run.status === 'done' && !run.has_warnings) showTrainedAlert(run);
          else showTrainingResult(run);
        }
      })
      .catch(() => {});
  }

  // ── Preprocessing confirmation modal ──────────────────────
  const preprocModal   = document.getElementById('preprocModal');
  const preprocBody    = document.getElementById('preprocBody');
  const preprocSummary = document.getElementById('preprocSummary');
  const preprocTabBar  = document.getElementById('preprocTabBar');
  const preprocTitle   = document.getElementById('preprocTitle');
  const preprocMeta    = document.getElementById('preprocMeta');
  const confirmBtn     = document.getElementById('preprocConfirmBtn');
  const cancelBtn      = document.getElementById('preprocCancelBtn');
  const dlFlagsBtn     = document.getElementById('preprocDownloadBtn');
  let   warnFileName   = 'flags';

  // Download ONLY the flag list (Missing / Needs review / Fixed) as an Excel file with one
  // tab per sheet, so the user can still find every null in their spreadsheet after cancelling.
  if (dlFlagsBtn) dlFlagsBtn.addEventListener('click', () => {
    if (!(window.FlagReview && window.FlagReview.hasData())) return;
    const blob = window.FlagReview.xlsx();          // Excel file, one tab per sheet
    if (!blob) return;
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = warnFileName.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') + '_flags.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  let modalUploadId   = null;
  let modalCard       = null;
  let warnData        = { null:[], highlight:[], resolved:[] };
  let activeWarnTier  = 'null';

  function openPreprocModal(uploadId, statusData, card) {
    modalUploadId = uploadId;
    modalCard     = card || null;
    preprocModal.classList.add('open');
    preprocTitle.textContent = 'Preprocessing Complete';
    preprocMeta.textContent  =
      `${esc(statusData.original_filename || '')} · ${statusData.academic_year||''} ${statusData.semester||''}`;

    showPreprocSkeleton();

    // Fetch warnings from server
    fetch('/api/preprocessing-warnings/' + uploadId)
      .then(r => r.json())
      .then(data => renderWarnModal(data, statusData))
      .catch(() => {
        preprocBody.innerHTML = '<div class="warn-empty">Could not load warnings.</div>';
      });
  }

  function renderWarnModal(data, statusData) {
    warnData = {
      null:      (data.warnings || []).filter(w => w.tier === 'null'),
      highlight: (data.warnings || []).filter(w => w.tier === 'highlight'),
      resolved:  (data.warnings || []).filter(w => w.tier === 'resolved'),
    };
    const counts = data.counts || {};

    // Summary badges
    const acc    = statusData.accuracy != null ? parseFloat(statusData.accuracy).toFixed(1) + '%' : null;
    const trRows = statusData.training_rows != null ? fmtNum(statusData.training_rows) : null;
    preprocSummary.innerHTML =
      `<div class="warn-stats">` +
        (acc    ? `<span class="wstat wstat-acc"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm3.857-9.809a.75.75 0 0 0-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 1 0-1.06 1.061l2.5 2.5a.75.75 0 0 0 1.137-.089l4-5.5Z" clip-rule="evenodd"/></svg>${acc} accuracy</span>` : '') +
        (trRows ? `<span class="wstat wstat-rows"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z"/><path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z"/></svg>${trRows} training rows</span>` : '') +
      `</div>`;

    // Readable, collapsible flag list (fileupload.flags.js). It brings its own tabs,
    // so the old pill bar is hidden. Falls back to the old table if the script is missing.
    if (window.FlagReview) {
      preprocTabBar.innerHTML = '';
      preprocTabBar.style.display = 'none';
      window.FlagReview.render(preprocBody, data, { mode: 'grouped', confirm: true });
      warnFileName = data.original_filename || statusData.original_filename || 'flags';
      if (dlFlagsBtn) { dlFlagsBtn.style.display = ''; dlFlagsBtn.disabled = !window.FlagReview.hasData(); }
      return;
    }
    if (dlFlagsBtn) dlFlagsBtn.style.display = 'none';
    preprocTabBar.style.display = '';

    // Tier tabs
    // 3 pill buttons — Null / Highlight / Resolved
    preprocTabBar.innerHTML =
      [['null','Missing'], ['highlight','Needs Review'], ['resolved','Fixed Automatically']].map(([t, label], i) => {
        const cnt = warnData[t].length;
        return `<button class="warn-pill${i===0?' active':''}" data-tier="${t}">
          <span class="pill-dot pill-dot-${t}"></span>
          <span class="pill-label">${label}</span>
          <span class="pill-count ${cnt===0?'pill-count-zero':''}">${cnt}</span>
        </button>`;
      }).join('');

    preprocTabBar.querySelectorAll('.warn-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        preprocTabBar.querySelectorAll('.warn-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeWarnTier = btn.dataset.tier;
        renderWarnTable(activeWarnTier);
      });
    });

    activeWarnTier = 'null';
    renderWarnTable('null');
  }

  function renderWarnTable(tier) {
    const rows = warnData[tier] || [];
    const labels = {
      null:     'No null warnings — all required fields are present.',
      highlight:'No highlight warnings for this upload.',
      resolved: 'No resolved items for this upload.',
    };
    if (rows.length === 0) {
      preprocBody.innerHTML =
        `<div class="warn-empty">
          <span class="pill-dot pill-dot-${tier}" style="width:20px;height:20px;display:inline-block;margin-bottom:6px;border-radius:50%;"></span>
          <span>${labels[tier]||'No warnings.'}</span>
        </div>`;
      return;
    }
    preprocBody.innerHTML =
      `<table class="warn-table">
        <thead><tr><th>Category</th><th>Message</th><th>Reference</th></tr></thead>
        <tbody>${rows.map(w =>
          `<tr class="warn-row-${esc(w.tier)}">
            <td class="warn-cat">${esc(w.category)}</td>
            <td class="warn-msg">${esc(w.message)}</td>
            <td class="warn-ref">${esc(w.ref||'—')}</td>
          </tr>`).join('')}
        </tbody>
      </table>`;
  }

  confirmBtn?.addEventListener('click', () => {
    if (!modalUploadId || confirmBtn.disabled) return;
    const uploadId = modalUploadId;
    const card     = modalCard;
    const resetBtn = () => { confirmBtn.disabled = false; confirmBtn.textContent = 'Save & separate CSVs'; };
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Separating CSVs…';
    confirmedIds.add(uploadId);

    const startWaiting = () => {
      preprocModal.classList.remove('open');
      resetBtn();
      if (card) {
        setStepOn(card, 'confirm', 'done');
        setStepOn(card, 'separate', 'running');
        startQueuePoll(uploadId, card);
      } else {
        setStep('step-confirm','done');
        setStep('step-separate','running');
        pollStatus(uploadId);
      }
    };

    fetch('/api/confirm-upload/' + uploadId, { method:'POST' })
      .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }))
      .then(({ status, data }) => {
        if (data.success || data.already_running || status === 409) { startWaiting(); }
        else {
          confirmedIds.delete(uploadId); resetBtn();
          showAlert('Separation failed: ' + esc(data.error || 'Unknown error.'),'error');
          if (card) setStepOn(card, 'confirm', 'error');
          else setStep('step-confirm','error');
        }
      })
      .catch(() => { confirmedIds.delete(uploadId); resetBtn(); showAlert('Network error during confirmation.','error'); });
  });

  // Cancel — delete the upload (confirmed via discardUploadModal, not window.confirm())
  const discardModal      = document.getElementById('discardUploadModal');
  const discardBackBtn    = document.getElementById('discardUploadBackBtn');
  const discardConfirmBtn = document.getElementById('discardUploadConfirmBtn');

  cancelBtn?.addEventListener('click', () => {
    if (!modalUploadId) { preprocModal.classList.remove('open'); return; }
    discardModal.classList.add('open');
  });

  discardBackBtn?.addEventListener('click', () => {
    discardModal.classList.remove('open');
  });

  discardConfirmBtn?.addEventListener('click', () => {
    if (!modalUploadId || discardConfirmBtn.disabled) return;
    const uploadId = modalUploadId;
    const card     = modalCard;
    discardConfirmBtn.disabled = true;
    discardConfirmBtn.textContent = 'Discarding…';

    fetch('/api/upload-record/' + uploadId, { method:'DELETE' })
      .then(async r => {
        // 404 = the record is already gone, which is what we wanted anyway.
        if (!r.ok && r.status !== 404) {
          const d = await r.json().catch(() => ({}));
          throw new Error(d.error || 'Could not discard this upload.');
        }
        discardModal.classList.remove('open');
        preprocModal.classList.remove('open');
        // Free the processing slot. Without this the discarded card kept owning it, so the
        // next file was shown as "Queued" and drainQueue() never started it.
        if (card) card._discarded = true;
        stopQueuePoll(uploadId);
        releaseSlot(card || (activeCard && activeCard._uploadId === uploadId ? activeCard : null));
        if (card) {
          stopQueuePoll(uploadId);
          clearAlertFor(card);
          card.style.transition = 'opacity 300ms ease';
          card.style.opacity = '0';
          setTimeout(() => { card.remove(); uploadQueue.delete(uploadId); updateQueueSection(); }, 300);
        } else { hidePipelineCard(); }
        clearAlert();
        showAlert('Upload cancelled and removed.','warning');
        refreshAllTables();
      })
      .catch(err => {
        // Delete failed: keep the review open so the user can try again (the record still exists).
        discardModal.classList.remove('open');
        modalUploadId = uploadId; modalCard = card;
        showAlert(esc((err && err.message) || 'Could not discard this upload.'), 'error');
      })
      .finally(() => { discardConfirmBtn.disabled = false; discardConfirmBtn.textContent = 'Discard upload'; });
    modalUploadId = null; modalCard = null;
  });

  // ── CSV viewer modal ───────────────────────────────────────
  const csvModal    = document.getElementById('csvModal');
  const csvWrap     = document.getElementById('csvWrap');
  const csvMeta     = document.getElementById('csvMeta');
  const csvTitle    = document.getElementById('csvModalTitle');
  const csvSearch   = document.getElementById('csvSearch');
  const csvSubtitle = document.getElementById('csvSubtitle');
  const csvClearBtn = document.getElementById('csvClearFilters');
  const csvDlBtn    = document.getElementById('csvDlBtn');
  const csvPrev     = document.getElementById('csvPrevBtn');
  const csvNext     = document.getElementById('csvNextBtn');
  const csvPagerInfo= document.getElementById('csvPagerInfo');
  const csvCloseBtn = document.getElementById('csvCloseBtn');
  const csvToggleViewBtn = document.getElementById('csvToggleViewBtn');

  let csvAllRows   = [];   // all parsed rows
  let csvHeaders   = [];
  let csvFiltered  = [];   // after search
  let csvPage      = 0;
  const CSV_PAGE   = 200; // rows per page
  let csvSortCol   = -1;
  let csvSortAsc   = true;
  let csvColFilters = [];  // per-column filter values ('' = off)
  let csvColOptions = [];  // per-column distinct values (→ <select>), or null (→ text box)
  let csvDlUrl     = null; // API URL for download

  // 'raw' = showing the actual CSV rows | 'warnings' = showing only the
  // flagged/warning entries detected during preprocessing for this upload.
  let csvMode = 'raw';
  // Remembers enough to toggle between the two views without re-fetching
  // everything from scratch: { title, upload_id, apiUrl, dlUrl }
  let csvCtx  = null;

  csvCloseBtn?.addEventListener('click', () => csvModal.classList.remove('open'));

  // ── Click outside the card to close ────────────────────────
  // Applied to: CSV viewer, tutorial video, Archive confirm, Restore confirm.
  // deliberately NOT applied to preprocModal (Save & separate CSVs / Cancel —
  // that one has to be answered with its buttons) nor the delete/logout modals.
  // A click only counts if the press STARTED on the backdrop too, so dragging
  // to select text inside the card and releasing over the backdrop doesn't
  // close it.
  function closeOnBackdropClick(modalEl, closeFn) {
    if (!modalEl) return;
    let pressStartedOnBackdrop = false;
    modalEl.addEventListener('mousedown', (e) => {
      pressStartedOnBackdrop = (e.target === modalEl);
    });
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl && pressStartedOnBackdrop) closeFn();
      pressStartedOnBackdrop = false;
    });
  }

  closeOnBackdropClick(csvModal, () => csvModal.classList.remove('open'));

  // Tutorial video modal is owned by page-video-modal.js — go through its own
  // close button so the video still pauses / is marked as seen.
  closeOnBackdropClick(
    document.getElementById('pageTutorialModal'),
    () => document.getElementById('closePageTutorialBtn')?.click()
  );
  csvSearch?.addEventListener('input', () => { csvPage = 0; applySearch(); renderCsvPage(); });

  // Per-column filters. The inputs live inside the sticky header and are only
  // re-created on a full render (load / sort / clear), so typing keeps focus.
  function onColFilter(e) {
    const el = e.target.closest ? e.target.closest('.csv-colfilter') : null;
    if (!el) return;
    if (e.type === 'input' && el.tagName === 'SELECT') return;   // selects use 'change'
    csvColFilters[Number(el.dataset.col)] = el.value;
    el.classList.toggle('active', el.value !== '');
    csvPage = 0;
    applySearch();
    renderCsvPage();
  }
  csvWrap?.addEventListener('input',  onColFilter);
  csvWrap?.addEventListener('change', onColFilter);
  csvClearBtn?.addEventListener('click', () => {
    csvSearch.value = '';
    csvColFilters = csvHeaders.map(() => '');
    csvPage = 0;
    applySearch();
    renderCsvPage(true);
  });
  csvPrev?.addEventListener('click', () => { if (csvPage > 0) { csvPage--; renderCsvPage(); } });
  csvNext?.addEventListener('click', () => {
    if ((csvPage+1)*CSV_PAGE < csvFiltered.length) { csvPage++; renderCsvPage(); }
  });
  csvDlBtn?.addEventListener('click', () => {
    if (csvMode === 'warnings') {
      downloadWarningsCsv();
    } else if (csvDlUrl) {
      window.location.href = csvDlUrl;
    }
  });

  csvToggleViewBtn?.addEventListener('click', () => {
    if (!csvCtx) return;
    if (csvMode === 'warnings') {
      csvMode = 'raw'; setDlLabel();
      csvToggleViewBtn.textContent = 'Show flagged rows only';
      _loadRawCsv(csvCtx.title, csvCtx.apiUrl, csvCtx.dlUrl);
    } else {
      csvMode = 'warnings'; setDlLabel();
      csvToggleViewBtn.textContent = 'View full CSV';
      _loadWarnings(csvCtx.title, csvCtx.upload_id);
    }
  });

  // Full raw CSV (used directly by Tab 2 / Tab 3, and by the "View full
  // CSV" toggle from the flagged-rows view).
  function openCsvViewer(title, apiUrl, dlUrl) {
    csvCtx = { title, upload_id: null, apiUrl, dlUrl };
    csvMode = 'raw'; setDlLabel();
    csvToggleViewBtn.style.display = 'none';
    _loadRawCsv(title, apiUrl, dlUrl);
  }

  // Only the detected flag/warning entries for this upload (Tab 1 —
  // "Files with Errors or Flagged Rows"). Lets the user switch to the
  // full CSV via the toggle button if they need it.
  function openFlaggedViewer(title, uploadId, apiUrl, dlUrl) {
    csvCtx = { title, upload_id: uploadId, apiUrl, dlUrl };
    csvMode = 'warnings'; setDlLabel();
    csvToggleViewBtn.style.display = '';
    csvToggleViewBtn.textContent = 'View full CSV';
    _loadWarnings(title, uploadId);
  }

  // One-line description under the viewer title.
  const CSV_DS_DESC = {
    DS00: 'Enrollment headcount per program and year level.',
    DS01: 'KPI per student — GWA, status and risk flags (main ML source).',
    DS02: 'Heatmap data — at-risk rate by program and year level.',
    DS03: 'At-risk students broken down by gender.',
    DS04: 'Hardest subjects — fail rate and average grade per subject.',
    DS05: 'At-risk history used to forecast future at-risk counts.',
    DS06: 'GWA trend per group across semesters.',
  };
  function csvSubtitleFor(mode, apiUrl) {
    if (mode === 'warnings') {
      return 'Every issue found while checking this file: where it is, what was found, and what to do about it.';
    }
    let q;
    try { q = new URL(apiUrl, window.location.origin).searchParams; } catch (e) { return ''; }
    const type = q.get('type');
    if (type === 'dataset') return CSV_DS_DESC[q.get('key')] || 'Chart dataset for this semester.';
    if (type === 'training' || type === 'longform') return 'Student-level training data — one row per student for this semester.';
    return '';
  }
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');

  function _loadRawCsv(title, apiUrl, dlUrl) {
    csvModal.classList.remove('csv-modal--flags');
    csvModal.classList.add('open');
    csvTitle.textContent = title;
    csvSubtitle.textContent = csvSubtitleFor('raw', apiUrl);
    csvClearBtn.classList.add('hidden');
    csvWrap.innerHTML = csvSkeletonHTML(8, 12);
    csvMeta.textContent = '';
    csvDlUrl = dlUrl || null;
    csvSearch.value = '';
    csvAllRows = []; csvHeaders = []; csvFiltered = []; csvPage = 0; csvSortCol = -1;
    csvColFilters = []; csvColOptions = [];

    fetch(apiUrl)
      .then(r => r.json())
      .then(data => {
        if (!data.csv) { csvWrap.innerHTML = '<div class="csv-loading">No CSV data available.</div>'; return; }
        parseAndRenderCsv(data.csv, title);
      })
      .catch(() => {
        csvWrap.innerHTML = '<div class="csv-loading">Failed to load CSV.</div>';
      });
  }

  function _loadWarnings(title, uploadId) {
    csvModal.classList.toggle('csv-modal--flags', !!window.FlagReview);
    csvModal.classList.add('open');
    csvTitle.textContent = title;
    csvSubtitle.textContent = csvSubtitleFor('warnings');
    csvClearBtn.classList.add('hidden');
    csvWrap.innerHTML = csvSkeletonHTML(4, 12);
    csvMeta.textContent = '';
    csvDlUrl = null;
    csvSearch.value = '';
    csvAllRows = []; csvHeaders = []; csvFiltered = []; csvPage = 0; csvSortCol = -1;
    csvColFilters = []; csvColOptions = [];

    if (!uploadId) {
      csvWrap.innerHTML = '<div class="csv-loading">No upload ID for this file.</div>';
      return;
    }

    fetch(`/api/preprocessing-warnings/${uploadId}`)
      .then(r => r.json())
      .then(data => {
        const warnings = data.warnings || [];
        if (!warnings.length) {
          csvWrap.innerHTML = '<div class="csv-loading">No flagged rows detected for this file.</div>';
          csvMeta.textContent = '0 flags';
          return;
        }
        csvHeaders = ['Tier', 'Category', 'Message', 'Reference'];
        csvAllRows = warnings.map(w => [w.tier || '—', w.category || '—', w.message || '—', w.ref || '—']);
        const c = data.counts || {};
        csvMeta.textContent =
          `${csvAllRows.length.toLocaleString()} flag(s) — ` +
          `${c.null||0} null · ${c.highlight||0} highlight · ${c.resolved||0} resolved`;
        if (window.FlagReview) {            // readable grouped view (fileupload.flags.js)
          window.FlagReview.render(csvWrap, data, { mode: 'grouped' });   // same by-issue sections as the confirmation
          return;
        }
        initCsvColumns();                   // fallback: old flat table
        applySearch();
        renderCsvPage(true);
      })
      .catch(() => {
        csvWrap.innerHTML = '<div class="csv-loading">Failed to load flagged rows.</div>';
      });
  }

  // Flag review downloads an Excel file; everything else is still a CSV — label the button to match.
  function setDlLabel() {
    const flags = csvMode === 'warnings';
    const el = document.getElementById('csvDlLabel');
    if (el) el.textContent = flags ? 'Download Excel' : 'Download CSV';
    if (csvDlBtn) csvDlBtn.title = flags ? 'Download the flags as an Excel file (one tab per tier)' : 'Download this CSV';
  }

  function downloadWarningsCsv() {
    // Flag review → Excel only (one tab per sheet). The plain CSV below is just the
    // fallback for non-flag files (no flag viewer loaded).
    if (window.FlagReview && window.FlagReview.hasData()) {
      const xl = window.FlagReview.xlsx();
      if (xl) {
        const url = URL.createObjectURL(xl), a = document.createElement('a');
        a.href = url;
        a.download = (csvCtx?.title || 'flagged-rows').replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '_') + '_flags.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return;
      }
    }
    if (!csvAllRows.length) return;
    const escCell = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csvText = (window.FlagReview && window.FlagReview.hasData())
      ? window.FlagReview.csv()
      : [csvHeaders.map(escCell).join(',')]
          .concat(csvAllRows.map(row => row.map(escCell).join(','))).join('\n');
    const blob = new Blob([csvText], { type: 'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const safeTitle = (csvCtx?.title || 'flagged-rows').replace(/[^\w.-]+/g, '_');
    a.href = url;
    a.download = `${safeTitle}_flags.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function parseAndRenderCsv(csvText, title) {
    const lines = csvText.split('\n').filter(l => l.trim());
    if (!lines.length) { csvWrap.innerHTML = '<div class="csv-loading">Empty CSV.</div>'; return; }

    // Simple CSV parse (handles quoted fields)
    const parseRow = (line) => {
      const result = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') { inQ = !inQ; continue; }
        if (c === ',' && !inQ) { result.push(cur); cur = ''; continue; }
        cur += c;
      }
      result.push(cur);
      return result;
    };

    csvHeaders = parseRow(lines[0]);
    csvAllRows = lines.slice(1).map(parseRow);
    csvMeta.textContent = `${csvAllRows.length.toLocaleString()} rows · ${csvHeaders.length} columns`;
    initCsvColumns();
    applySearch();
    renderCsvPage(true);
  }

  // A column with few distinct, short values (Tier, College, Gender, Status…)
  // gets a dropdown; everything else gets a "contains" text box.
  function initCsvColumns() {
    csvColFilters = csvHeaders.map(() => '');
    csvColOptions = csvHeaders.map((_, c) => {
      const seen = new Set();
      for (const row of csvAllRows) {
        const v = String(row[c] ?? '');
        if (v === '') continue;
        if (v.length > 60) return null;
        seen.add(v);
        if (seen.size > 30) return null;
      }
      if (!seen.size || seen.size * 2 > csvAllRows.length) return null;
      return Array.from(seen).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    });
  }

  function applySearch() {
    const q = (csvSearch.value || '').toLowerCase();
    const active = [];
    csvColFilters.forEach((v, i) => { if (v !== '' && v != null) active.push(i); });
    csvFiltered = (q || active.length)
      ? csvAllRows.filter(row => {
          for (const i of active) {
            const cell = String(row[i] ?? '');
            const f = csvColFilters[i];
            if (csvColOptions[i]) { if (cell !== f) return false; }
            else if (!cell.toLowerCase().includes(String(f).toLowerCase())) return false;
          }
          return !q || row.some(cell => String(cell).toLowerCase().includes(q));
        })
      : csvAllRows.slice();
    if (csvSortCol >= 0) sortCsv();
  }

  function sortCsv() {
    const col = csvSortCol;
    const asc = csvSortAsc;
    csvFiltered.sort((a, b) => {
      const va = a[col] ?? ''; const vb = b[col] ?? '';
      const na = parseFloat(va); const nb = parseFloat(vb);
      if (!isNaN(na) && !isNaN(nb)) return asc ? na - nb : nb - na;
      return asc ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
    });
  }

  function csvHeadHtml() {
    return csvHeaders.map((h, i) => {
      const arrow = csvSortCol === i ? (csvSortAsc ? ' ↑' : ' ↓') : '';
      const val   = csvColFilters[i] || '';
      const cls   = 'csv-colfilter' + (val ? ' active' : '');
      const label = escAttr('Filter ' + h);
      const ctl = csvColOptions[i]
        ? `<select class="${cls}" data-col="${i}" aria-label="${label}">` +
            `<option value="">All</option>` +
            csvColOptions[i].map(o =>
              `<option value="${escAttr(o)}"${o === val ? ' selected' : ''}>${esc(o)}</option>`).join('') +
          `</select>`
        : `<input type="text" class="${cls}" data-col="${i}" value="${escAttr(val)}" placeholder="Filter…" aria-label="${label}">`;
      return `<th><div class="csv-th-label" onclick="csvSortBy(${i})" title="Sort by ${escAttr(h)}">${esc(h)}${arrow}</div>${ctl}</th>`;
    }).join('');
  }

  // full=true rebuilds header + body (load / sort / clear). Otherwise only the
  // body and pager change, so a filter box being typed in keeps its focus.
  // Columns long enough to crowd out the rest of the table (right now just
  // "Message" from the warnings viewer) get truncated with an ellipsis and
  // expand in place on click, instead of forcing every other column to
  // shrink or scroll off. Matched by header name, so this only affects
  // whichever table actually has that column.
  const CSV_TRUNCATE_COLS = new Set(['Message']);
  const CSV_TRUNCATE_LEN = 70;

  function csvCellHtml(cell, colIdx) {
    const text = esc(cell);
    if (!CSV_TRUNCATE_COLS.has(csvHeaders[colIdx]) || String(cell ?? '').length <= CSV_TRUNCATE_LEN) {
      return `<td>${text}</td>`;
    }
    const short = esc(String(cell).slice(0, CSV_TRUNCATE_LEN)) + '&hellip;';
    return `<td class="csv-cell-truncated" tabindex="0" role="button" title="Click to view the full message">` +
             `<span class="csv-cell-short">${short}</span>` +
             `<span class="csv-cell-full">${text}</span>` +
           `</td>`;
  }

  function renderCsvPage(full) {
    const start = csvPage * CSV_PAGE;
    const end   = Math.min(start + CSV_PAGE, csvFiltered.length);
    const pageRows = csvFiltered.slice(start, end);

    const tipEl = document.getElementById('csvTruncateTip');
    if (tipEl) tipEl.classList.toggle('hidden', !csvHeaders.some(h => CSV_TRUNCATE_COLS.has(h)));

    const tbHtml = pageRows.length
      ? pageRows.map(row => `<tr>${row.map((cell, i) => csvCellHtml(cell, i)).join('')}</tr>`).join('')
      : `<tr><td class="csv-empty" colspan="${Math.max(csvHeaders.length, 1)}">No rows match the current search / filters.</td></tr>`;

    const table = csvWrap.querySelector('table.csv-tbl');
    if (!table || full) {
      csvWrap.innerHTML = `<table class="csv-tbl"><thead><tr>${csvHeadHtml()}</tr></thead><tbody>${tbHtml}</tbody></table>`;
    } else {
      table.tBodies[0].innerHTML = tbHtml;
    }
    csvWrap.querySelectorAll('.csv-cell-truncated').forEach(td => {
      const toggle = () => td.classList.toggle('is-expanded');
      td.addEventListener('click', toggle);
      td.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    });

    const narrowed = csvFiltered.length < csvAllRows.length;
    csvPagerInfo.textContent = csvFiltered.length
      ? `Showing ${(start+1).toLocaleString()}–${end.toLocaleString()} of ${csvFiltered.length.toLocaleString()} rows`
        + (narrowed ? ` (filtered from ${csvAllRows.length.toLocaleString()})` : '')
      : 'No rows match the search / filters.';
    csvPrev.disabled = csvPage === 0;
    csvNext.disabled = end >= csvFiltered.length;

    const anyFilter = (csvSearch.value || '') !== '' || csvColFilters.some(v => v !== '' && v != null);
    csvClearBtn.classList.toggle('hidden', !anyFilter);
  }

  window.csvSortBy = function(col) {
    if (csvSortCol === col) { csvSortAsc = !csvSortAsc; }
    else { csvSortCol = col; csvSortAsc = true; }
    sortCsv();
    renderCsvPage(true);
  };

  // ── Archive modal ──────────────────────────────────────────
  const archiveModal   = document.getElementById('archiveConfirmModal');
  const archiveCancelBtn = document.getElementById('archiveCancelBtn');
  const archiveDoBtn   = document.getElementById('archiveDoBtn');
  const archiveConfirmText = document.getElementById('archiveConfirmText');

  archiveCancelBtn?.addEventListener('click', () => archiveModal.classList.remove('open'));
  // click outside = "Back". Ignored while the archive request is running so the
  // modal can't vanish mid-operation.
  closeOnBackdropClick(archiveModal, () => {
    if (archiveDoBtn && archiveDoBtn.disabled) return;
    archiveModal.classList.remove('open');
  });
  archiveDoBtn?.addEventListener('click', () => {
    if (!pendingArchive) return;
    archiveDoBtn.disabled = true;
    archiveDoBtn.textContent = 'Archiving…';

    fetch('/api/archive-semester', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify(pendingArchive),
    })
      .then(r => r.json())
      .then(data => {
        archiveModal.classList.remove('open');
        archiveDoBtn.disabled = false;
        archiveDoBtn.textContent = 'Archive';
        pendingArchive = null;
        if (data.success) {
          refreshAllTables();
          showAlert('Semester archived successfully.','success');
        } else {
          showAlert('Archive failed: ' + esc(data.error),'error');
        }
      })
      .catch(() => {
        archiveModal.classList.remove('open');
        archiveDoBtn.disabled = false;
        archiveDoBtn.textContent = 'Archive';
        showAlert('Network error while archiving.','error');
      });
  });

  function openArchiveConfirm(uploadId, ay, sem, filename) {
    pendingArchive = { upload_id: uploadId, academic_year: ay, semester: sem };
    archiveConfirmText.textContent =
      `Archive "${filename}" (${ay} ${sem})? All CSV data will move to the archive. ` +
      `You can restore it unless the same semester is re-uploaded. ` +
      `Prediction models already trained on it keep using it until the next retrain.`;
    archiveModal.classList.add('open');
  }

  // ── Skeleton loaders ───────────────────────────────────────
  // Grey placeholder shapes shown while a fetch is in flight, so the layout
  // doesn't jump when the real rows arrive. Styles: .skel* in fileupload.css.
  const SKEL_WIDTHS = [72, 34, 42, 54, 28, 28, 28, 64, 58];

  function skeletonRowsHTML(cols, rows) {
    let out = '';
    for (let r = 0; r < rows; r++) {
      let tds = '';
      for (let c = 0; c < cols; c++) {
        const last = c === cols - 1;                       // Actions column → button-shaped
        const w = Math.max(24, SKEL_WIDTHS[c % SKEL_WIDTHS.length] - ((r * 9 + c * 5) % 16));
        tds += '<td>' +
          (r === 0 && c === 0 ? '<span class="sr-only">Loading…</span>' : '') +
          '<span class="skel' + (last ? ' skel--btn' : '') + '"' +
          (last ? '' : ' style="width:' + w + '%"') + '></span></td>';
      }
      out += '<tr class="skel-row"' + (r ? ' aria-hidden="true"' : '') + '>' + tds + '</tr>';
    }
    return out;
  }

  function showTableSkeleton(tbody, cols, rows) {
    tbody.setAttribute('aria-busy', 'true');
    tbody.innerHTML = skeletonRowsHTML(cols, rows || 5);
  }

  function csvSkeletonHTML(cols, rows) {
    const bar = (r, c) => '<span class="skel" style="width:' +
      Math.max(30, 88 - ((r * 13 + c * 17) % 44)) + '%"></span>';
    const row = (cls, r) => '<div class="skel-grid-row ' + cls + '">' +
      Array.from({ length: cols }, (_, c) => bar(r, c)).join('') + '</div>';
    let body = '';
    for (let r = 0; r < rows; r++) body += row('', r);
    return '<div class="skel-grid" style="--cols:' + cols + '" aria-busy="true">' +
      '<span class="sr-only">Loading…</span>' + row('skel-grid-row--head', 99) + body + '</div>';
  }

  function warnSkeletonHTML(rows) {
    let out = '<div class="skel-warn" aria-busy="true"><span class="sr-only">Loading warnings…</span>';
    for (let r = 0; r < rows; r++) {
      out += '<div class="skel-warn-row">' +
        '<span class="skel" style="width:' + (78 - (r * 11) % 30) + '%"></span>' +
        '<span class="skel" style="width:' + (92 - (r * 17) % 40) + '%"></span>' +
        '<span class="skel" style="width:' + (70 - (r * 7) % 25) + '%"></span></div>';
    }
    return out + '</div>';
  }

  function showPreprocSkeleton() {
    preprocSummary.innerHTML =
      '<div class="warn-stats"><span class="skel skel--chip"></span><span class="skel skel--chip"></span></div>';
    preprocTabBar.innerHTML = '<span class="skel skel--tab"></span>'.repeat(3);
    preprocBody.innerHTML = warnSkeletonHTML(6);
  }

  // Phone layout turns each table row into a card and needs to know which
  // column each cell belongs to. Copy the <th> texts onto the <td>s as
  // data-label whenever a table body is (re)filled — done with an observer so
  // none of the four loaders had to change — and drop aria-busy once the
  // skeleton has been replaced.
  function labelCells(tbody) {
    const table = tbody.closest('table');
    if (!table) return;
    const heads = Array.from(table.querySelectorAll('thead th')).map(th => th.textContent.trim());
    tbody.querySelectorAll('tr').forEach(tr => {
      if (tr.classList.contains('skel-row')) return;
      Array.from(tr.children).forEach((td, i) => {
        if (td.tagName === 'TD' && !td.classList.contains('tbl-empty') && heads[i]) {
          td.setAttribute('data-label', heads[i]);
        }
      });
    });
  }

  ['invalidTableBody', 'trainingTableBody', 'separationTableBody', 'archiveTableBody'].forEach(id => {
    const tb = document.getElementById(id);
    if (!tb) return;
    new MutationObserver(() => {
      const loading = !!tb.querySelector('.skel-row');
      tb.setAttribute('aria-busy', loading ? 'true' : 'false');
      if (!loading) labelCells(tb);
    }).observe(tb, { childList: true });
  });

  // ── Table loaders ──────────────────────────────────────────

  // Tab 1: Invalid/Flagged uploads
  window.loadInvalidTable = function() {
    const tbody = document.getElementById('invalidTableBody');
    showTableSkeleton(tbody, 9);

    fetchJson('/api/uploads-with-warnings')
      .then(rows => {
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="9" class="tbl-empty">No flagged uploads found.</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(r => `
          <tr onclick="openFlaggedViewer('${esc(r.original_filename)}', ${r.id},
            '/api/csv-preview?type=longform&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}',
            '/api/csv-download?type=longform&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}')"
            style="cursor:pointer">
            <td title="${esc(r.original_filename)}" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.original_filename)}</td>
            <td>${esc(r.academic_year||'—')}</td>
            <td>${esc(r.semester||'—')}</td>
            <td>${fmtAcc(r.accuracy)}</td>
            <td style="color:#dc2626;font-weight:600">${r.null_count||0}</td>
            <td style="color:#d97706;font-weight:600">${r.highlight_count||0}</td>
            <td style="color:#059669">${r.resolved_count||0}</td>
            <td style="font-size:14px;color:#6b7280">${esc(r.uploaded_at||'—')}</td>
            <td onclick="event.stopPropagation()">
              <button class="btn-view-csv" onclick="openFlaggedViewer('${esc(r.original_filename)}', ${r.id},
                '/api/csv-preview?type=longform&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}',
                '/api/csv-download?type=longform&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}')">View Flags</button>
            </td>
          </tr>`).join('');
      })
      .catch(err => {
        console.error('[fileupload] table load failed:', err);
        tbody.innerHTML = `<tr><td colspan="9" class="tbl-empty">Failed to load — ${esc(err.message)}</td></tr>`;
      });
  };

  // Tab 2: Training CSV (semester_uploads)
  window.loadTrainingTable = function() {
    const tbody = document.getElementById('trainingTableBody');
    showTableSkeleton(tbody, 8);

    fetchJson('/api/training-csv-list')
      .then(rows => {
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="8" class="tbl-empty">No confirmed uploads yet.</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(r => `
          <tr onclick="openCsvViewer('${r.academic_year} ${r.semester} — Training',
            '/api/csv-preview?type=training&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}',
            '/api/csv-download?type=training&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}')"
            style="cursor:pointer">
            <td>${esc(r.academic_year||'—')}</td>
            <td>${esc(r.semester||'—')}</td>
            <td>${fmtNum(r.student_rows)}</td>
            <td>${fmtNum(r.training_rows)}</td>
            <td style="color:#9ca3af">${fmtNum(r.excluded_rows)}</td>
            <td>${fmtAcc(r.accuracy)}</td>
            <td style="font-size:14px;color:#6b7280">${esc(r.uploaded_at||'—')}</td>
            <td onclick="event.stopPropagation()" style="display:flex;gap:6px">
              <button class="btn-view-csv" onclick="openCsvViewer('${r.academic_year} ${r.semester} — Training',
                '/api/csv-preview?type=training&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}',
                '/api/csv-download?type=training&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}')">View CSV</button>
              <button class="btn-archive" onclick="openArchiveConfirm(${r.upload_id},'${esc(r.academic_year)}','${esc(r.semester)}','${esc(r.original_filename||r.academic_year+' '+r.semester)}')">Archive</button>
            </td>
          </tr>`).join('');
      })
      .catch(err => {
        console.error('[fileupload] table load failed:', err);
        tbody.innerHTML = `<tr><td colspan="8" class="tbl-empty">Failed to load — ${esc(err.message)}</td></tr>`;
      });
  };

  // Tab 3: CSV Separation (model_datasets DS00-DS06)
  const DS_NAMES = {
    DS00:'Enrollment headcount',DS01:'KPI student',DS02:'Histogram risk',
    DS03:'Gender at-risk',DS04:'Hardest subjects',DS05:'At-risk forecast',DS06:'GWA trend',
  };

  window.loadSeparationTable = function() {
    const tbody = document.getElementById('separationTableBody');
    showTableSkeleton(tbody, 7);

    fetchJson('/api/model-datasets-list')
      .then(rows => {
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="7" class="tbl-empty">No chart datasets yet. Confirm an upload to generate them.</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(r => `
          <tr onclick="openCsvViewer('${esc(r.dataset_key)} — ${esc(r.academic_year)} ${esc(r.semester)}',
            '/api/csv-preview?type=dataset&key=${esc(r.dataset_key)}&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}',
            '/api/csv-download?type=dataset&key=${esc(r.dataset_key)}&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}')"
            style="cursor:pointer">
            <td><span class="ds-key">${esc(r.dataset_key)}</span></td>
            <td style="color:#6b7280;font-size:14.5px">${esc(DS_NAMES[r.dataset_key]||r.dataset_name||'—')}</td>
            <td>${esc(r.academic_year||'—')}</td>
            <td>${esc(r.semester||'—')}</td>
            <td>${fmtNum(r.longform_rows||r.student_rows)}</td>
            <td>${fmtAcc(r.accuracy)}</td>
            <td onclick="event.stopPropagation()">
              <button class="btn-view-csv" onclick="openCsvViewer('${esc(r.dataset_key)} — ${esc(r.academic_year)} ${esc(r.semester)}',
                '/api/csv-preview?type=dataset&key=${esc(r.dataset_key)}&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}',
                '/api/csv-download?type=dataset&key=${esc(r.dataset_key)}&ay=${esc(r.academic_year)}&sem=${esc(r.semester)}')">View CSV</button>
            </td>
          </tr>`).join('');
      })
      .catch(err => {
        console.error('[fileupload] table load failed:', err);
        tbody.innerHTML = `<tr><td colspan="7" class="tbl-empty">Failed to load — ${esc(err.message)}</td></tr>`;
      });
  };

  // Tab 4: Archive
  window.loadArchiveTable = function() {
    const tbody = document.getElementById('archiveTableBody');
    showTableSkeleton(tbody, 8);

    fetchJson('/api/archives-list')
      .then(rows => {
        if (!rows.length) {
          tbody.innerHTML = '<tr><td colspan="8" class="tbl-empty">No archives yet.</td></tr>';
          return;
        }
        tbody.innerHTML = rows.map(r => `
          <tr>
            <td title="${esc(r.original_filename)}" style="max-width:180px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(r.original_filename)}</td>
            <td>${esc(r.academic_year)}</td>
            <td>${esc(r.semester)}</td>
            <td>${fmtNum(r.student_rows)}</td>
            <td style="font-size:14.5px">${esc((r.first_name||'')+' '+(r.last_name||''))}</td>
            <td style="font-size:14px;color:#6b7280">${esc(r.archived_at||'—')}</td>
            <td>${r.restore_blocked
              ? '<span class="badge-blocked">Blocked</span>'
              : '<span class="badge-restore">Restorable</span>'}</td>
            <td>
              <button class="btn-restore" ${r.restore_blocked ? 'disabled title="This semester has a new upload (or one in progress) — cannot restore"' : ''}
                onclick="restoreSemester(${r.id}, '${esc(r.academic_year)}', '${esc(r.semester)}', ${r.is_complete ? 'true' : 'false'})">
                Restore
              </button>
            </td>
          </tr>`).join('');
      })
      .catch(err => {
        console.error('[fileupload] table load failed:', err);
        tbody.innerHTML = `<tr><td colspan="8" class="tbl-empty">Failed to load — ${esc(err.message)}</td></tr>`;
      });
  };

  // ── Restore confirmation modal (replaces the native confirm() popup) ──
  const restoreModal   = document.getElementById('restoreConfirmModal');
  const restoreText    = document.getElementById('restoreConfirmText');
  const restoreCancel  = document.getElementById('restoreCancelBtn');
  const restoreDoBtn   = document.getElementById('restoreDoBtn');

  const closeRestoreModal = () => {
    restoreModal.classList.remove('open');
    restoreDoBtn.disabled = false;
    restoreDoBtn.textContent = 'Restore';
    pendingRestore = null;
  };

  window.restoreSemester = function(archiveId, ay, sem, isComplete) {
    pendingRestore = { id: archiveId, ay, sem };
    restoreText.textContent =
      `Restore ${ay} ${sem} from the archive? This brings back the Training CSV, ` +
      `the chart datasets (CSV Separation) and the flagged-file warnings.` +
      (isComplete === false
        ? ' Note: this archive was made before full snapshots existed, so some of that ' +
          'may not be available — re-upload the .xlsx to regenerate it.'
        : '');
    restoreModal.classList.add('open');
  };

  restoreCancel?.addEventListener('click', closeRestoreModal);
  closeOnBackdropClick(restoreModal, () => {
    if (restoreDoBtn && restoreDoBtn.disabled) return;   // busy restoring — leave it open
    closeRestoreModal();
  });

  restoreDoBtn?.addEventListener('click', () => {
    if (!pendingRestore || restoreDoBtn.disabled) return;
    const { id, ay, sem } = pendingRestore;
    restoreDoBtn.disabled = true;
    restoreDoBtn.textContent = 'Restoring…';

    fetch('/api/restore-archive/' + id, { method:'POST' })
      .then(r => r.json())
      .then(data => {
        closeRestoreModal();
        if (data.ok) {
          const done = (data.restored || []).join(', ');
          if (data.missing && data.missing.length) {
            showAlert(`${esc(ay)} ${esc(sem)} restored (${esc(done)}). ` +
                      `Not in this archive: ${esc(data.missing.join(', '))} — re-upload the file to regenerate.`,
                      'warning');
          } else {
            showAlert(`${esc(ay)} ${esc(sem)} restored — ${esc(done)}.`, 'success');
          }
          refreshAllTables();
        } else {
          showAlert('Restore failed: ' + esc(data.reason || data.error || 'Unknown error.'), 'error');
          loadArchiveTable();
        }
      })
      .catch(() => {
        closeRestoreModal();
        showAlert('Network error during restore.', 'error');
      });
  });

  // ── Model backup / rollback ────────────────────────────────
  const backupCard      = document.getElementById('modelBackupCard');
  const backupText      = document.getElementById('modelBackupText');
  const rollbackBtn     = document.getElementById('modelRollbackBtn');
  const rollbackModal   = document.getElementById('rollbackConfirmModal');
  const rollbackCancel  = document.getElementById('rollbackCancelBtn');
  const rollbackDoBtn   = document.getElementById('rollbackDoBtn');

  function loadModelBackup() {
    if (!backupCard) return;
    fetchJson('/api/model-backup-info')
      .then(info => {
        if (!info || !info.has_backup) { backupCard.classList.add('hidden'); return; }
        const when = info.created_at ? new Date(info.created_at).toLocaleString() : '';
        backupText.textContent =
          `A backup of the previous models (trained on ${info.trained_semesters ?? '?'} semesters, ` +
          `saved ${when}) is kept. If the latest training was confirmed by mistake, restore it — ` +
          `the newer models then become the backup.`;
        rollbackBtn.disabled = !!info.training_active;
        rollbackBtn.title = info.training_active ? 'Wait for training to finish' : '';
        backupCard.classList.remove('hidden');
      })
      .catch(() => { /* non-critical */ });
  }

  rollbackBtn?.addEventListener('click', () => rollbackModal.classList.add('open'));
  rollbackCancel?.addEventListener('click', () => rollbackModal.classList.remove('open'));
  closeOnBackdropClick(rollbackModal, () => {
    if (rollbackDoBtn && rollbackDoBtn.disabled) return;
    rollbackModal.classList.remove('open');
  });
  rollbackDoBtn?.addEventListener('click', () => {
    if (rollbackDoBtn.disabled) return;
    rollbackDoBtn.disabled = true;
    rollbackDoBtn.textContent = 'Restoring…';
    fetch('/api/rollback-models', { method: 'POST' })
      .then(async r => ({ ok: r.ok, data: await r.json().catch(() => ({})) }))
      .then(({ ok, data }) => {
        if (ok && data.ok) showAlert('<strong>Previous models restored.</strong> The prediction dashboard now uses them.', 'success');
        else showAlert('Restore failed: ' + esc(data.error || 'Unknown error.'), 'error');
      })
      .catch(() => showAlert('Network error while restoring models.', 'error'))
      .finally(() => {
        rollbackModal.classList.remove('open');
        rollbackDoBtn.disabled = false;
        rollbackDoBtn.textContent = 'Restore models';
        loadModelBackup();
      });
  });

  // ── Refresh all ────────────────────────────────────────────
  function refreshAllTables() {
    loadModelBackup();
    loadInvalidTable();
    loadTrainingTable();
    loadSeparationTable();
    loadArchiveTable();
  }

  // ── Expose to inline onclick="" handlers ───────────────────
  // Everything above lives inside this IIFE, so inline handlers written into
  // the table rows (onclick="openCsvViewer(...)") can't see these names unless
  // they're put on window. That was the "openCsvViewer is not defined" error.
  window.openCsvViewer     = openCsvViewer;
  window.openFlaggedViewer = openFlaggedViewer;
  window.openArchiveConfirm = openArchiveConfirm;

  // ── Resume an in-progress upload after navigating away & back ──
  // Everything above (currentUploadId, pollTimer, confirmedIds, the
  // pipeline card's step states) lives only in JS memory, so leaving the
  // page and coming back — or a plain refresh — used to wipe all of it
  // even though the upload was still running server-side. The backend
  // already tracks status persistently (UploadedDataset.status in MySQL),
  // so on load we just ask it whether anything is still active and
  // rebuild the UI state from that, instead of asking the user to start
  // over or leaving them with a "confirm" step that silently vanished.
  const ACTIVE_STATUSES = ['pending', 'processing', 'preprocessing_done', 'separating'];

  function resumeActiveUpload() {
    fetchJson('/api/unprocessed-list')
      .then(records => {
        if (!records?.length) { resumeTraining(); return; }

        // Rebuild the queue in upload order (oldest first), whatever order the
        // server returned, so it matches what the user saw before leaving.
        records = records.slice().sort((a, b) =>
          (Date.parse(a.uploaded_at) || 0) - (Date.parse(b.uploaded_at) || 0) ||
          (a.id || a.upload_id || 0) - (b.id || b.upload_id || 0));

        const inProgress = (records || []).filter(r =>
          ['processing','preprocessing_done','separating'].includes(r.status)
        );
        const pending = (records || []).filter(r => r.status === 'pending');

        if (!inProgress.length && !pending.length) { resumeTraining(); return; }

        // Only the FIRST in-progress record gets polled — it owns isProcessing.
        // Any extras are re-queued as deferred items (shouldn't normally happen,
        // but guards against a race where two uploads started simultaneously).
        inProgress.forEach((active, idx) => {
          const uploadId = active.id || active.upload_id;
          if (uploadQueue.has(uploadId)) return;

          const card = createQueueCard(
            active.original_filename || '',
            active.file_size_kb ? fmt(active.file_size_kb * 1024) : ''
          );
          card._uploadId = uploadId;

          if (idx === 0) {
            // Primary — restore with full pipeline and start polling
            expandCard(card);
            setStepOn(card, 'validate', 'done');
            setStepOn(card, 'upload', 'done');
            isProcessing = true;
            activeCard = card;

            if (active.status === 'processing') {
              setStepOn(card, 'clean', 'running');
            } else if (active.status === 'preprocessing_done') {
              setStepOn(card, 'clean', 'done');
              setStepOn(card, 'confirm', 'running');
              if (!preprocModal.classList.contains('open')) openPreprocModal(uploadId, active, card);
            } else if (active.status === 'separating') {
              setStepOn(card, 'clean', 'done');
              setStepOn(card, 'confirm', 'done');
              setStepOn(card, 'separate', 'running');
              confirmedIds.add(uploadId);
            }

            startQueuePoll(uploadId, card);
          } else {
            // Extra in-progress — re-queue as deferred, it will start after primary finishes
            setCardPill(card, 'Queued', null);
            fileQueue.push({ uploadId, card });
            uploadQueue.set(uploadId, { card, pollTimer: null });
          }
        });

        // Pending (deferred) records — show as Queued cards
        pending.forEach(active => {
          const uploadId = active.id || active.upload_id;
          if (uploadQueue.has(uploadId)) return;

          const card = createQueueCard(
            active.original_filename || '',
            active.file_size_kb ? fmt(active.file_size_kb * 1024) : ''
          );
          card._uploadId = uploadId;
          setCardPill(card, 'Queued', null);
          fileQueue.push({ uploadId, card });
          uploadQueue.set(uploadId, { card, pollTimer: null });
        });

        // If nothing is actively processing, start the first queued item
        if (!inProgress.length && pending.length) {
          drainQueue();
        }
      })
      .catch(err => console.warn('[fileupload] could not check for active uploads:', err.message));
  }

  // ── Init ───────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    loadInvalidTable();   // active tab on load
    loadModelBackup();
    resumeActiveUpload();
  });

})();


/* ═══════════════════════════════════════════════════════════
   Table filters (Academic Year + Term) for the four tabs:
   Files with Errors / Flags · Training CSV · CSV Separation · Archive
   Pick values in the dropdowns, then press Apply. Reset clears both.
   Runs on top of the existing loaders — it reads each table after the
   rows are rendered, builds the dropdown choices from the data that is
   actually there, and hides the rows that don't match.
   ═══════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function cellText(tr, col) {
    var td = tr.children[col];
    return td ? td.textContent.trim() : '';
  }
  function isRealValue(v) { return v && v !== '\u2014' && v !== '-'; }

  // "2024-2025" newest first; terms in natural order (1st, 2nd, Summer…)
  function sortAY(a, b)   { return b.localeCompare(a, undefined, { numeric: true }); }
  function sortTerm(a, b) { return a.localeCompare(b, undefined, { numeric: true }); }

  function setupFilter(bar) {
    var tbody = document.getElementById(bar.dataset.body);
    if (!tbody) return;
    var ayCol   = parseInt(bar.dataset.ayCol, 10);
    var termCol = parseInt(bar.dataset.semCol, 10);   // (data attr kept from the first version)
    var selAY   = bar.querySelector('.flt-ay');
    var selTerm = bar.querySelector('.flt-sem');
    var applyBtn = bar.querySelector('.flt-apply');
    var resetBtn = bar.querySelector('.flt-reset');
    var count   = bar.querySelector('.flt-count');
    var colSpan = tbody.closest('table').querySelectorAll('thead th').length;

    var applied = { ay: '', term: '' };               // what the table is filtered by right now

    function dataRows() {
      return Array.prototype.filter.call(tbody.children, function (tr) {
        return !tr.classList.contains('skel-row') &&
               !tr.classList.contains('flt-empty') &&
               !tr.querySelector('.tbl-empty');
      });
    }

    function fillOptions(select, values, sorter, allLabel) {
      var keep = select.value;
      var uniq = Array.from(new Set(values.filter(isRealValue))).sort(sorter);
      select.innerHTML = '<option value="">' + allLabel + '</option>' +
        uniq.map(function (v) {
          var o = document.createElement('option');
          o.value = v; o.textContent = v;
          return o.outerHTML;
        }).join('');
      select.value = uniq.indexOf(keep) !== -1 ? keep : '';
      return uniq;
    }

    // Show/hide rows using the APPLIED values (not the dropdowns).
    function filterRows() {
      var rows = dataRows(), shown = 0;
      rows.forEach(function (tr) {
        var ok = (!applied.ay   || cellText(tr, ayCol)   === applied.ay) &&
                 (!applied.term || cellText(tr, termCol) === applied.term);
        tr.style.display = ok ? '' : 'none';
        if (ok) shown++;
      });

      var empty = tbody.querySelector('.flt-empty');
      if (rows.length && !shown) {
        if (!empty) {
          empty = document.createElement('tr');
          empty.className = 'flt-empty';
          empty.innerHTML = '<td colspan="' + colSpan + '" class="tbl-empty">No records match the selected filters.</td>';
          tbody.appendChild(empty);
        }
      } else if (empty) {
        empty.remove();
      }

      var filtering = !!(applied.ay || applied.term);
      count.textContent = rows.length
        ? (filtering ? 'Showing ' + shown + ' of ' + rows.length
                     : rows.length + (rows.length === 1 ? ' record' : ' records'))
        : '';
      updateControls(rows.length);
    }

    // Apply is live only when the dropdowns differ from what's applied;
    // Reset is live when anything is picked or applied.
    function updateControls(rowCount) {
      if (rowCount === undefined) rowCount = dataRows().length;
      var pendingChange = selAY.value !== applied.ay || selTerm.value !== applied.term;
      selAY.disabled = selTerm.disabled = !rowCount;
      applyBtn.disabled = !rowCount || !pendingChange;
      resetBtn.disabled = !rowCount || !(selAY.value || selTerm.value || applied.ay || applied.term);
      selAY.classList.toggle('is-active', !!applied.ay);
      selTerm.classList.toggle('is-active', !!applied.term);
    }

    function rebuild() {
      var rows = dataRows();
      var ays   = fillOptions(selAY,   rows.map(function (tr) { return cellText(tr, ayCol);   }), sortAY, 'All Years');
      var terms = fillOptions(selTerm, rows.map(function (tr) { return cellText(tr, termCol); }), sortTerm, 'All Terms');
      // an applied value that no longer exists in the data (e.g. after archiving) is dropped
      if (applied.ay   && ays.indexOf(applied.ay)     === -1) applied.ay = '';
      if (applied.term && terms.indexOf(applied.term) === -1) applied.term = '';
      filterRows();
    }

    selAY.addEventListener('change', function () { updateControls(); });
    selTerm.addEventListener('change', function () { updateControls(); });

    applyBtn.addEventListener('click', function () {
      applied.ay = selAY.value;
      applied.term = selTerm.value;
      filterRows();
    });
    resetBtn.addEventListener('click', function () {
      selAY.value = ''; selTerm.value = '';
      applied.ay = ''; applied.term = '';
      filterRows();
    });

    // Re-run whenever the table is re-rendered (first load, Refresh, archive/restore…).
    var obs = new MutationObserver(function () {
      if (tbody.querySelector('.skel-row')) return;      // still loading
      rebuild();
      obs.takeRecords();                                  // ignore our own "no match" row change
    });
    obs.observe(tbody, { childList: true });
    rebuild();
  }

  function init() { document.querySelectorAll('.tbl-filters').forEach(setupFilter); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();