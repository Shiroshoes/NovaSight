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

  const STEP_IDS = ['step-validate','step-upload','step-clean','step-confirm','step-separate','step-train'];

  let pollTimer       = null;
  let trainTimer      = null;   // polls /api/training-run while a run is queued/running
  let currentUploadId = null;   // upload_id from /api/upload-dataset response
  let pendingArchive  = null;   // {upload_id, ay, sem, label}
  let pendingRestore  = null;   // {id, ay, sem}
  // Upload IDs the user already confirmed. Belt-and-braces: even if the server
  // still reports 'preprocessing_done' for a moment, never re-open the modal
  // for an upload that is already being separated.
  const confirmedIds  = new Set();

  // ── Utilities ──────────────────────────────────────────────
  const esc = (s) => {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  };
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
  function resetSteps() { STEP_IDS.forEach(id => setStep(id, 'waiting')); }

  // ── Alert banner (the div right under the drop zone) ───────
  // Every message — upload accepted / finished / failed, archive, restore,
  // cancel, network errors — goes through showAlert(). It stays for ALERT_MS,
  // fades out, then hides itself. Strict timer: the mouse position is ignored.
  const ALERT_MS = 3000;   // how long the banner stays
  const FADE_MS  = 300;    // fade-out duration
  let alertTimer = null;
  let fadeTimer  = null;

  function scheduleAlertHide() {
    clearTimeout(alertTimer);
    alertTimer = setTimeout(() => {
      uploadAlert.style.opacity = '0';
      fadeTimer = setTimeout(clearAlert, FADE_MS);
    }, ALERT_MS);
  }
  function showAlert(msg, kind) {
    clearTimeout(alertTimer); clearTimeout(fadeTimer);   // a new alert restarts the 3s
    uploadAlert.className = 'upload-alert upload-alert--' + kind;
    uploadAlert.innerHTML = msg;
    uploadAlert.style.transition = 'opacity ' + FADE_MS + 'ms ease';
    uploadAlert.style.opacity = '1';
    uploadAlert.classList.remove('hidden');
    scheduleAlertHide();
  }
  function clearAlert() {
    clearTimeout(alertTimer); clearTimeout(fadeTimer);
    uploadAlert.classList.add('hidden');
    uploadAlert.innerHTML = '';
    uploadAlert.style.opacity = '';
  }

  // ── Pipeline card (progress steps) auto-hide ───────────────
  // Once the upload reaches an end state — finished, failed, or rejected — the
  // card fades out after CARD_HIDE_MS and is removed. It is NEVER scheduled
  // while the upload is still running or waiting on the confirmation modal, and
  // a new upload cancels any pending hide so an old timer can't remove the new
  // card.
  //
  // No hover-pause on purpose: an earlier version paused the countdown while the
  // pointer was over the card, and the pointer is usually still resting there
  // (or gets moved under it by the layout shift when the banner appears), so the
  // card never went away.
  const CARD_HIDE_MS = 3000;
  let cardTimer     = null;
  let cardFadeTimer = null;
  pipelineCard.style.transition = 'opacity ' + FADE_MS + 'ms ease';

  function cancelCardHide() {
    clearTimeout(cardTimer); clearTimeout(cardFadeTimer);
    cardTimer = cardFadeTimer = null;
    pipelineCard.style.opacity = '';
  }
  function showPipelineCard() {
    cancelCardHide();
    pipelineCard.style.display = '';
    pipelineCard.classList.remove('hidden');
  }
  function hidePipelineCard() {
    cancelCardHide();
    pipelineCard.classList.add('hidden');
    pipelineCard.style.display = 'none';   // inline too, so no stylesheet rule can keep it visible
  }
  function scheduleCardHide() {
    clearTimeout(cardTimer); clearTimeout(cardFadeTimer);
    pipelineCard.style.opacity = '1';
    cardTimer = setTimeout(() => {
      pipelineCard.style.opacity = '0';
      cardFadeTimer = setTimeout(hidePipelineCard, FADE_MS);
    }, CARD_HIDE_MS);
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
  function handleFile(file) {
    stopTrainPoll();
    clearAlert();
    showPipelineCard();               // a new upload cancels any pending hide

    pipelineResult.classList.add('hidden');
    pipelineResult.innerHTML = '';
    resetSteps();
    document.getElementById('pipelineFilename').textContent = file.name;
    document.getElementById('pipelineSize').textContent = file.size ? '· ' + fmt(file.size) : '';

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setStep('step-validate','error');
      showAlert('Only <strong>.xlsx</strong> files are accepted.','error');
      scheduleCardHide();
      return;
    }

    setStep('step-validate','running');
    const fd = new FormData();
    fd.append('file', file);

    fetch('/api/upload-dataset', { method:'POST', body:fd })
      .then(async r => ({ ok:r.ok, status:r.status, data: await r.json().catch(()=>({})) }))
      .then(({ ok, status, data }) => {
        if (!ok) {
          setStep('step-validate', status === 409 ? 'done' : 'error');
          setStep('step-upload','error');
          showAlert(data.error || 'Upload failed.', data.duplicate ? 'warning' : 'error');
          scheduleCardHide();
          return;
        }
        setStep('step-validate','done');
        setStep('step-upload','done');
        setStep('step-clean','running');
        showAlert(data.message || 'File accepted — preprocessing started.','success');
        currentUploadId = data.upload_id || data.record_id;
        pollStatus(currentUploadId);
      })
      .catch(err => {
        setStep('step-validate','error');
        showAlert('Network error: ' + esc(err.message || err),'error');
        scheduleCardHide();
      });
  }

  function pollStatus(uploadId) {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      fetch('/api/upload-status/' + uploadId)
        .then(r => r.json())
        .then(data => onStatusUpdate(uploadId, data))
        .catch(() => {});
    }, 2500);
  }

  function onStatusUpdate(uploadId, data) {
    if (data.status === 'processing') {
      setStep('step-clean','running');
      return;
    }
    if (data.status === 'separating') {
      // Confirmed; CSV separation (DS00–DS06) still running server-side.
      setStep('step-clean','done');
      setStep('step-confirm','done');
      setStep('step-separate','running');
      return;
    }
    if (data.status === 'preprocessing_done') {
      if (confirmedIds.has(uploadId)) {          // already confirmed → keep waiting, no modal
        setStep('step-confirm','done');
        setStep('step-separate','running');
        return;
      }
      if (preprocModal.classList.contains('open')) return;   // already showing
      // Preprocessing finished — open confirmation modal
      clearInterval(pollTimer); pollTimer = null;
      setStep('step-clean','done');
      setStep('step-confirm','running');
      openPreprocModal(uploadId, data);
      return;
    }
    if (data.status === 'done') {
      clearInterval(pollTimer); pollTimer = null;
      setStep('step-clean','done');
      setStep('step-confirm','done');
      setStep('step-separate','done');
      pipelineResult.classList.remove('hidden');
      pipelineResult.className = 'pipeline-result pipeline-result--success';
      pipelineResult.innerHTML =
        `<strong>${esc(data.original_filename)}</strong> processed successfully` +
        (data.row_count ? ` — ${fmtNum(data.row_count)} student rows.` : '.');
      showAlert(
        `<strong>${esc(data.original_filename || 'File')}</strong> uploaded successfully` +
        (data.row_count ? ` — ${fmtNum(data.row_count)} student rows.` : '.'), 'success');
      refreshAllTables();
      // Last step: model training. The pipeline card stays open until it ends.
      cancelCardHide();
      setStep('step-train','running');
      fetch('/api/training-run')
        .then(r => r.json())
        .then(run => followTraining(run && run.upload_id === uploadId ? run : null))
        .catch(() => followTraining(null));
      return;
    }
    if (data.status === 'failed') {
      clearInterval(pollTimer); pollTimer = null;
      STEP_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (el?.classList.contains('step--running')) setStep(id,'error');
      });
      pipelineResult.classList.remove('hidden');
      pipelineResult.className = 'pipeline-result pipeline-result--error';
      pipelineResult.innerHTML =
        `<strong>${esc(data.original_filename || 'Upload')}</strong> failed — ` +
        esc(data.error_message || 'Unknown error.');
      showAlert(
        `<strong>${esc(data.original_filename || 'Upload')}</strong> upload failed — ` +
        esc(data.error_message || 'Unknown error.'), 'error');
      scheduleCardHide();
      refreshAllTables();
    }
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
      setStep('step-train', 'waiting');
      setTrainDesc('No training run was recorded for this upload.');
      scheduleCardHide();
      return;
    }
    if (st === 'queued') {
      cancelCardHide();
      setStep('step-train', 'running');
      setTrainDesc('Waiting for an earlier training run to finish…');
    } else if (st === 'running') {
      cancelCardHide();
      setStep('step-train', 'running');
      setTrainDesc('Training the models on all uploaded semesters — this can take a few minutes.');
    } else if (st === 'skipped') {
      setStep('step-train', 'waiting');
      setTrainDesc(run.message || 'Not enough semesters yet — training skipped.');
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
  function showTrainedAlert(run) {
    dismissRun(run.run_id);                 // never re-announced on a later page load
    showAlert('<strong>Machine learning model trained successfully.</strong>', 'success');
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

  let modalUploadId   = null;
  let warnData        = { null:[], highlight:[], resolved:[] };
  let activeWarnTier  = 'null';

  function openPreprocModal(uploadId, statusData) {
    modalUploadId = uploadId;
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

    // Tier tabs
    // 3 pill buttons — Null / Highlight / Resolved
    preprocTabBar.innerHTML =
      [['null','Null'], ['highlight','Highlight'], ['resolved','Resolved']].map(([t, label], i) => {
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

  // Confirm — run CSV separation
  confirmBtn?.addEventListener('click', () => {
    if (!modalUploadId || confirmBtn.disabled) return;
    const uploadId = modalUploadId;
    const resetBtn = () => {
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Save & separate CSVs';
    };
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Separating CSVs…';
    confirmedIds.add(uploadId);          // set BEFORE the request so no poll tick can re-open the modal

    const startWaiting = () => {
      preprocModal.classList.remove('open');
      resetBtn();
      setStep('step-confirm','done');
      setStep('step-separate','running');
      pollStatus(uploadId);              // poll until 'done' / 'failed'
    };

    fetch('/api/confirm-upload/' + uploadId, { method:'POST' })
      .then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }))
      .then(({ status, data }) => {
        if (data.success || data.already_running || status === 409) {
          startWaiting();                // 409 = another request already started it → just wait
        } else {
          confirmedIds.delete(uploadId); // real failure: allow retry, keep modal open
          resetBtn();
          showAlert('Separation failed: ' + esc(data.error || 'Unknown error.'),'error');
          setStep('step-confirm','error');
        }
      })
      .catch(() => {
        confirmedIds.delete(uploadId);
        resetBtn();
        showAlert('Network error during confirmation.','error');
      });
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
    discardConfirmBtn.disabled = true;
    discardConfirmBtn.textContent = 'Discarding…';

    fetch('/api/upload-record/' + uploadId, { method:'DELETE' })
      .then(() => {
        discardModal.classList.remove('open');
        preprocModal.classList.remove('open');
        hidePipelineCard();
        clearAlert();
        setStep('step-confirm','error');
        showAlert('Upload cancelled and removed.','warning');
        refreshAllTables();
      })
      .catch(() => {
        discardModal.classList.remove('open');
        preprocModal.classList.remove('open');
      })
      .finally(() => {
        discardConfirmBtn.disabled = false;
        discardConfirmBtn.textContent = 'Discard upload';
      });
    modalUploadId = null;
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
      csvMode = 'raw';
      csvToggleViewBtn.textContent = 'Show flagged rows only';
      _loadRawCsv(csvCtx.title, csvCtx.apiUrl, csvCtx.dlUrl);
    } else {
      csvMode = 'warnings';
      csvToggleViewBtn.textContent = 'View full CSV';
      _loadWarnings(csvCtx.title, csvCtx.upload_id);
    }
  });

  // Full raw CSV (used directly by Tab 2 / Tab 3, and by the "View full
  // CSV" toggle from the flagged-rows view).
  function openCsvViewer(title, apiUrl, dlUrl) {
    csvCtx = { title, upload_id: null, apiUrl, dlUrl };
    csvMode = 'raw';
    csvToggleViewBtn.style.display = 'none';
    _loadRawCsv(title, apiUrl, dlUrl);
  }

  // Only the detected flag/warning entries for this upload (Tab 1 —
  // "Files with Errors or Flagged Rows"). Lets the user switch to the
  // full CSV via the toggle button if they need it.
  function openFlaggedViewer(title, uploadId, apiUrl, dlUrl) {
    csvCtx = { title, upload_id: uploadId, apiUrl, dlUrl };
    csvMode = 'warnings';
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
      return 'Rows flagged while preprocessing this file — null (required value missing), '
           + 'highlight (needs review) and resolved (auto-corrected).';
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
        initCsvColumns();
        applySearch();
        renderCsvPage(true);
      })
      .catch(() => {
        csvWrap.innerHTML = '<div class="csv-loading">Failed to load flagged rows.</div>';
      });
  }

  function downloadWarningsCsv() {
    if (!csvAllRows.length) return;
    const escCell = (v) => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [csvHeaders.map(escCell).join(',')]
      .concat(csvAllRows.map(row => row.map(escCell).join(',')));
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
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
  function renderCsvPage(full) {
    const start = csvPage * CSV_PAGE;
    const end   = Math.min(start + CSV_PAGE, csvFiltered.length);
    const pageRows = csvFiltered.slice(start, end);

    const tbHtml = pageRows.length
      ? pageRows.map(row => `<tr>${row.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')
      : `<tr><td class="csv-empty" colspan="${Math.max(csvHeaders.length, 1)}">No rows match the current search / filters.</td></tr>`;

    const table = csvWrap.querySelector('table.csv-tbl');
    if (!table || full) {
      csvWrap.innerHTML = `<table class="csv-tbl"><thead><tr>${csvHeadHtml()}</tr></thead><tbody>${tbHtml}</tbody></table>`;
    } else {
      table.tBodies[0].innerHTML = tbHtml;
    }

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
      `You can restore it unless the same semester is re-uploaded.`;
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

    fetch('/api/uploads-with-warnings')
      .then(r => r.json())
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
      .catch(() => {
        tbody.innerHTML = '<tr><td colspan="9" class="tbl-empty">Failed to load.</td></tr>';
      });
  };

  // Tab 2: Training CSV (semester_uploads)
  window.loadTrainingTable = function() {
    const tbody = document.getElementById('trainingTableBody');
    showTableSkeleton(tbody, 8);

    fetch('/api/training-csv-list')
      .then(r => r.json())
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
      .catch(() => {
        tbody.innerHTML = '<tr><td colspan="8" class="tbl-empty">Failed to load.</td></tr>';
      });
  };

  // Tab 3: CSV Separation (model_datasets DS00-DS06)
  const DS_NAMES = {
    DS00:'Enrollment headcount',DS01:'KPI student',DS02:'Heatmap risk',
    DS03:'Gender at-risk',DS04:'Hardest subjects',DS05:'At-risk forecast',DS06:'GWA trend',
  };

  window.loadSeparationTable = function() {
    const tbody = document.getElementById('separationTableBody');
    showTableSkeleton(tbody, 7);

    fetch('/api/model-datasets-list')
      .then(r => r.json())
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
      .catch(() => {
        tbody.innerHTML = '<tr><td colspan="7" class="tbl-empty">Failed to load.</td></tr>';
      });
  };

  // Tab 4: Archive
  window.loadArchiveTable = function() {
    const tbody = document.getElementById('archiveTableBody');
    showTableSkeleton(tbody, 8);

    fetch('/api/archives-list')
      .then(r => r.json())
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
      .catch(() => {
        tbody.innerHTML = '<tr><td colspan="8" class="tbl-empty">Failed to load.</td></tr>';
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

  // ── Refresh all ────────────────────────────────────────────
  function refreshAllTables() {
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
    fetch('/api/unprocessed-list')
      .then(r => r.json())
      .then(records => {
        const active = (records || []).find(r => ACTIVE_STATUSES.includes(r.status));
        if (!active) { resumeTraining(); return; }   // no upload in flight — maybe a training run is

        currentUploadId = active.id || active.upload_id;
        showPipelineCard();
        resetSteps();
        document.getElementById('pipelineFilename').textContent = active.original_filename || '';
        document.getElementById('pipelineSize').textContent =
          active.file_size_kb ? '· ' + fmt(active.file_size_kb * 1024) : '';

        setStep('step-validate', 'done');
        setStep('step-upload', 'done');

        if (active.status === 'pending' || active.status === 'processing') {
          setStep('step-clean', 'running');
          pollStatus(currentUploadId);
        } else if (active.status === 'preprocessing_done') {
          setStep('step-clean', 'done');
          setStep('step-confirm', 'running');
          // Re-open the confirmation modal exactly like a fresh
          // preprocessing_done status update would — same code path,
          // same warnings fetch, nothing special-cased.
          openPreprocModal(currentUploadId, active);
          pollStatus(currentUploadId);   // keep polling in case it changes from another tab
        } else if (active.status === 'separating') {
          setStep('step-clean', 'done');
          setStep('step-confirm', 'done');
          setStep('step-separate', 'running');
          confirmedIds.add(currentUploadId);   // already confirmed — never re-show the modal
          pollStatus(currentUploadId);
        }
      })
      .catch(() => {});   // no active upload / network hiccup — page just loads normally
  }

  // ── Init ───────────────────────────────────────────────────
  document.addEventListener('DOMContentLoaded', () => {
    loadInvalidTable();   // active tab on load
    resumeActiveUpload();
  });

})();