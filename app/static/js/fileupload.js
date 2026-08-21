/* fileupload.js — grade-sheet upload page (shared by Academic Affair & Admin) */

(function () {
  'use strict';

  const dropZone   = document.getElementById('dropZone');
  const fileInput  = document.getElementById('fileInput');
  const uploadAlert = document.getElementById('uploadAlert');

  const pipelineCard     = document.getElementById('pipelineCard');
  const pipelineFilename = document.getElementById('pipelineFilename');
  const pipelineSize     = document.getElementById('pipelineSize');
  const pipelineResult   = document.getElementById('pipelineResult');

  const STEP_IDS = ['step-validate', 'step-upload', 'step-clean', 'step-merge', 'step-models'];

  let pollTimer = null;

  // ─────────────────────────────────────────────────────────
  // Small helpers
  // ─────────────────────────────────────────────────────────

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function formatBytes(bytes) {
    if (!bytes && bytes !== 0) return '';
    const kb = bytes / 1024;
    return kb > 1024 ? (kb / 1024).toFixed(1) + ' MB' : kb.toFixed(1) + ' KB';
  }

  function setStepState(stepId, state) {
    // state: 'waiting' | 'running' | 'done' | 'error'
    const el = document.getElementById(stepId);
    if (!el) return;
    el.classList.remove('step--waiting', 'step--running', 'step--done', 'step--error');
    el.classList.add('step--' + state);
  }

  function resetSteps() {
    STEP_IDS.forEach((id) => setStepState(id, 'waiting'));
  }

  function showAlert(message, kind) {
    // kind: 'error' | 'warning' | 'success'
    uploadAlert.className = 'upload-alert upload-alert--' + kind;
    uploadAlert.innerHTML = message;
    uploadAlert.classList.remove('hidden');
  }

  function clearAlert() {
    uploadAlert.classList.add('hidden');
    uploadAlert.innerHTML = '';
  }

  function statusBadgeClass(status) {
    switch (status) {
      case 'pending':    return 'badge--pending';
      case 'processing': return 'badge--processing';
      case 'done':       return 'badge--done';
      case 'failed':      return 'badge--failed';
      default:           return 'badge--pending';
    }
  }

  // ─────────────────────────────────────────────────────────
  // Drag & drop / browse wiring
  // ─────────────────────────────────────────────────────────

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', (e) => {
      // The "Browse File" button already opens the picker itself —
      // avoid opening it a second time when its click bubbles up here.
      if (e.target.closest('.btn-upload-browse')) return;
      fileInput.click();
    });

    ['dragenter', 'dragover'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dragover');
      });
    });

    ['dragleave', 'drop'].forEach((evt) => {
      dropZone.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
      });
    });

    dropZone.addEventListener('drop', (e) => {
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });

    fileInput.addEventListener('change', () => {
      const file = fileInput.files && fileInput.files[0];
      if (file) handleFile(file);
      fileInput.value = ''; // allow re-selecting the same file later
    });
  }

  // ─────────────────────────────────────────────────────────
  // Upload flow
  // ─────────────────────────────────────────────────────────

  function handleFile(file) {
    clearAlert();
    hideFailedCard();

    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }

    pipelineCard.classList.remove('hidden');
    pipelineResult.classList.add('hidden');
    pipelineResult.innerHTML = '';
    resetSteps();

    pipelineFilename.textContent = file.name;
    pipelineSize.textContent = file.size ? '· ' + formatBytes(file.size) : '';

    if (!file.name.toLowerCase().endsWith('.xlsx')) {
      setStepState('step-validate', 'error');
      showAlert('Invalid file type. Only <strong>.xlsx</strong> grade-sheet workbooks are accepted.', 'error');
      return;
    }

    setStepState('step-validate', 'running');

    const formData = new FormData();
    formData.append('file', file);

    fetch('/api/upload-dataset', { method: 'POST', body: formData })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        return { ok: res.ok, status: res.status, data };
      })
      .then(({ ok, status, data }) => {
        if (!ok) {
          setStepState('step-validate', status === 409 ? 'done' : 'error');
          setStepState('step-upload', 'error');
          showAlert(
            data.error || 'Upload failed.',
            data.duplicate ? 'warning' : 'error'
          );
          return;
        }

        setStepState('step-validate', 'done');
        setStepState('step-upload', 'done');
        setStepState('step-clean', 'running');

        showAlert(data.message || 'File accepted. Processing started.', 'success');

        pollStatus(data.record_id);
        refreshLists();
      })
      .catch((err) => {
        setStepState('step-validate', 'error');
        showAlert('Network error while uploading: ' + escapeHtml(err.message || err), 'error');
      });
  }

  function pollStatus(recordId) {
    if (pollTimer) clearInterval(pollTimer);

    pollTimer = setInterval(() => {
      fetch('/api/upload-status/' + recordId)
        .then((res) => res.json())
        .then((data) => onStatusUpdate(recordId, data))
        .catch(() => { /* transient network hiccup — try again next tick */ });
    }, 2500);
  }

  function onStatusUpdate(recordId, data) {
    if (data.status === 'processing') {
      setStepState('step-clean', 'running');
      return;
    }

    if (data.status === 'done') {
      clearInterval(pollTimer);
      pollTimer = null;

      ['step-clean', 'step-merge', 'step-models'].forEach((id) => setStepState(id, 'done'));

      pipelineResult.classList.remove('hidden');
      pipelineResult.className = 'pipeline-result pipeline-result--success';
      pipelineResult.innerHTML =
        `<strong>${escapeHtml(data.original_filename)}</strong> processed successfully` +
        (data.row_count ? ` — ${escapeHtml(String(data.row_count))} rows merged.` : '.');

      refreshLists();
      return;
    }

    if (data.status === 'failed') {
      clearInterval(pollTimer);
      pollTimer = null;

      // Immediately clear the pipeline card — a failed run shouldn't sit
      // around in the UI, it gets replaced by the floating notice below.
      pipelineCard.classList.add('hidden');
      clearAlert();

      showFailedCard(recordId, data.original_filename, data.error_message);
      refreshLists();
    }
  }

  // ─────────────────────────────────────────────────────────
  // Floating "upload failed" card
  // ─────────────────────────────────────────────────────────

  let failedCardEl = null;

  function ensureFailedCard() {
    if (failedCardEl) return failedCardEl;

    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.id = 'uploadFailedModal';
    overlay.style.display = 'none';
    overlay.innerHTML = `
      <div class="logout-card upload-failed-card">
        <h1 class="brand-name">NovaSight</h1>
        <p class="confirmation-text upload-failed-text">
          <strong id="uploadFailedFilename">This file</strong> failed to process.
        </p>
        <p class="upload-failed-reason" id="uploadFailedReason"></p>
        <div class="button-group">
          <button id="uploadFailedReupload" class="btn btn-primary">Reupload</button>
          <button id="uploadFailedRemove"   class="btn btn-primary">Remove</button>
          <button id="uploadFailedCancel"   class="btn btn-primary">Cancel</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    failedCardEl = overlay;

    overlay.querySelector('#uploadFailedCancel').addEventListener('click', hideFailedCard);
    return overlay;
  }

  function showFailedCard(recordId, filename, reason) {
    const overlay = ensureFailedCard();
    overlay.querySelector('#uploadFailedFilename').textContent = filename ? `"${filename}"` : 'This file';
    overlay.querySelector('#uploadFailedReason').textContent = reason || 'An unexpected error occurred during preprocessing.';

    const removeBtn   = overlay.querySelector('#uploadFailedRemove');
    const reuploadBtn = overlay.querySelector('#uploadFailedReupload');

    // Replace listeners each time so we don't stack duplicate handlers
    // across multiple failed uploads in the same session.
    const newRemoveBtn = removeBtn.cloneNode(true);
    removeBtn.parentNode.replaceChild(newRemoveBtn, removeBtn);
    newRemoveBtn.addEventListener('click', () => {
      fetch('/api/upload-record/' + recordId, { method: 'DELETE' })
        .then((res) => res.json())
        .then(() => {
          hideFailedCard();
          refreshLists();
        })
        .catch(() => hideFailedCard());
    });

    const newReuploadBtn = reuploadBtn.cloneNode(true);
    reuploadBtn.parentNode.replaceChild(newReuploadBtn, reuploadBtn);
    newReuploadBtn.addEventListener('click', () => {
      // The failed record's files were already cleared server-side, so
      // the same filename can be picked again without tripping the
      // duplicate check.
      fetch('/api/upload-record/' + recordId, { method: 'DELETE' })
        .then(() => {
          hideFailedCard();
          refreshLists();
          if (fileInput) fileInput.click();
        })
        .catch(() => {
          hideFailedCard();
          if (fileInput) fileInput.click();
        });
    });

    overlay.style.display = 'flex';
  }

  function hideFailedCard() {
    if (failedCardEl) failedCardEl.style.display = 'none';
  }

  function checkForLingeringFailures() {
    fetch('/api/failed-uploads')
      .then((res) => res.json())
      .then((records) => {
        if (Array.isArray(records) && records.length > 0) {
          const latest = records[0];
          showFailedCard(latest.id, latest.original_filename, latest.error_message);
        }
      })
      .catch(() => { /* non-critical */ });
  }

  // ─────────────────────────────────────────────────────────
  // List rendering
  // ─────────────────────────────────────────────────────────

  function refreshLists() {
    loadUnprocessedList();
    loadProcessedList();
  }

  window.loadUnprocessedList = function loadUnprocessedList() {
    const body = document.getElementById('unprocessedTableBody');
    if (!body) return;

    fetch('/api/unprocessed-list')
      .then((res) => res.json())
      .then((records) => {
        if (!Array.isArray(records) || records.length === 0) {
          body.innerHTML = `
            <div class="file-table__empty">
              <p>No files uploaded yet.</p>
            </div>`;
          return;
        }

        body.innerHTML = records.map((r) => `
          <div class="file-table__row">
            <span class="cell-filename" title="${escapeHtml(r.original_filename)}">${escapeHtml(r.original_filename)}</span>
            <span>${escapeHtml(r.academic_year)}</span>
            <span>${escapeHtml(r.semester)}</span>
            <span>${escapeHtml(r.file_size_kb)}</span>
            <span>${escapeHtml(r.sheet_count)}</span>
            <span>${escapeHtml(r.uploader_name)}</span>
            <span><span class="role-badge">${escapeHtml(r.uploader_role)}</span></span>
            <span>${escapeHtml(r.uploaded_at)}</span>
            <span><span class="status-badge ${statusBadgeClass(r.status)}">${escapeHtml(r.status)}</span></span>
          </div>`).join('');
      })
      .catch(() => { /* leave existing content on transient error */ });
  };

  window.loadProcessedList = function loadProcessedList() {
    const procBody  = document.getElementById('processedTableBody');
    const modelBody = document.getElementById('modelFilesBody');
    const modelBadge = document.getElementById('modelFileBadge');

    fetch('/api/processed-list')
      .then((res) => res.json())
      .then((data) => {
        const records = data.uploaded_records || [];
        if (procBody) {
          procBody.innerHTML = records.length === 0
            ? `<div class="file-table__empty"><p>No processed files yet.</p></div>`
            : records.map((r) => `
              <div class="file-table__row processed-row">
                <span class="cell-filename" title="${escapeHtml(r.original_filename)}">${escapeHtml(r.original_filename)}</span>
                <span>${escapeHtml(r.academic_year)}</span>
                <span>${escapeHtml(r.semester)}</span>
                <span>${escapeHtml(r.row_count)}</span>
                <span>${escapeHtml(r.uploader_name)}</span>
                <span>${escapeHtml(r.uploaded_at)}</span>
                <span title="${escapeHtml(r.processed_path)}">${escapeHtml(r.processed_path)}</span>
              </div>`).join('');
        }

        const modelFiles = data.model_files || [];
        if (modelBadge) modelBadge.textContent = String(modelFiles.length);
        if (modelBody) {
          modelBody.innerHTML = modelFiles.length === 0
            ? `<div class="file-table__empty"><p>No model files generated yet.</p></div>`
            : modelFiles.map((f) => `
              <div class="file-table__row model-row">
                <span class="cell-filename" title="${escapeHtml(f.filename)}">${escapeHtml(f.filename)}</span>
                <span>${escapeHtml(f.size_kb)}</span>
                <span>${escapeHtml(f.modified)}</span>
              </div>`).join('');
        }
      })
      .catch(() => { /* leave existing content on transient error */ });
  };

  // ─────────────────────────────────────────────────────────
  // Init
  // ─────────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    refreshLists();
    checkForLingeringFailures();
  });
})();