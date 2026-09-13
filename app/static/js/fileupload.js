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
  const cancelPipelineBtn = document.getElementById('cancelPipelineBtn');

  const STEP_IDS = ['step-validate', 'step-upload', 'step-clean', 'step-merge', 'step-models'];

  let pollTimer = null;
  let currentRecordId = null;

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
    pipelineSize.textContent = file.size ? '- ' + formatBytes(file.size) : '';

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

        currentRecordId = data.record_id;
        if (cancelPipelineBtn) cancelPipelineBtn.classList.remove('hidden');

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
      currentRecordId = null;
      if (cancelPipelineBtn) cancelPipelineBtn.classList.add('hidden');

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
      currentRecordId = null;
      if (cancelPipelineBtn) cancelPipelineBtn.classList.add('hidden');

      // Immediately clear the pipeline card — a failed run shouldn't sit
      // around in the UI, it gets replaced by the floating notice below.
      pipelineCard.classList.add('hidden');
      clearAlert();

      showFailedCard(recordId, data.original_filename, data.error_message);
      refreshLists();
    }
  }

  // ─────────────────────────────────────────────────────────
  // Cancel an in-flight upload
  // ─────────────────────────────────────────────────────────

  if (cancelPipelineBtn) {
    cancelPipelineBtn.addEventListener('click', () => {
      if (!currentRecordId) return;
      showCancelUploadConfirm(currentRecordId);
    });
  }

  function showCancelUploadConfirm(recordId) {
    const modal = document.getElementById('cancelUploadConfirmModal');
    const text  = document.getElementById('cancelUploadConfirmText');
    const yesBtn = document.getElementById('confirmCancelUploadBtn');
    const backBtn = document.getElementById('backCancelUploadBtn');
    if (!modal) return;

    text.textContent = 'Cancel this upload? Anything already merged from it will be rolled back to the previous state.';
    modal.style.display = 'flex';

    const newYes = yesBtn.cloneNode(true);
    yesBtn.parentNode.replaceChild(newYes, yesBtn);
    newYes.addEventListener('click', () => {
      modal.style.display = 'none';
      fetch('/api/cancel-upload/' + recordId, { method: 'POST' })
        .then((res) => res.json())
        .then((data) => {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          currentRecordId = null;
          pipelineCard.classList.add('hidden');
          if (cancelPipelineBtn) cancelPipelineBtn.classList.add('hidden');
          showAlert(data.message || 'Upload cancelled.', data.ok ? 'success' : 'error');
          refreshLists();
        })
        .catch(() => {});
    });

    const newBack = backBtn.cloneNode(true);
    backBtn.parentNode.replaceChild(newBack, backBtn);
    newBack.addEventListener('click', () => { modal.style.display = 'none'; });
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
    loadDeletedList();
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
            <span>${(r.status === 'pending' || r.status === 'processing')
              ? `<button class="btn-refresh row-action-btn" data-cancel-id="${r.id}">Cancel</button>`
              : ''}</span>
          </div>`).join('');

        body.querySelectorAll('[data-cancel-id]').forEach((btn) => {
          btn.addEventListener('click', () => showCancelUploadConfirm(btn.getAttribute('data-cancel-id')));
        });
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
                <span class="cell-path" title="${escapeHtml(r.processed_path)}">${escapeHtml(r.processed_path)}</span>
                <span>${r.is_most_recent_deletable
                  ? `<button class="btn-refresh row-action-btn" data-delete-id="${r.id}" data-delete-name="${escapeHtml(r.original_filename)}">Delete</button>`
                  : ''}</span>
              </div>`).join('');

          procBody.querySelectorAll('[data-delete-id]').forEach((btn) => {
            btn.addEventListener('click', () => showDeleteRecentConfirm(
              btn.getAttribute('data-delete-id'),
              btn.getAttribute('data-delete-name')
            ));
          });
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
                <span><span class="status-badge ${f.status === 'Recent' ? 'badge--done' : 'badge--pending'}">${escapeHtml(f.status)}</span></span>
              </div>`).join('');
        }
      })
      .catch(() => { /* leave existing content on transient error */ });
  };

  // ─────────────────────────────────────────────────────────
  // Delete most-recent-upload flow (soft-delete + rollback to backup)
  // ─────────────────────────────────────────────────────────

  function showDeleteRecentConfirm(recordId, filename) {
    const modal = document.getElementById('deleteConfirmModal');
    const text  = document.getElementById('deleteConfirmText');
    const yesBtn = document.getElementById('confirmDeleteBtn');
    const backBtn = document.getElementById('cancelDeleteBtn');
    if (!modal) return;

    text.innerHTML =
      `Do you want to delete <strong>"${filename}"</strong>?<br><br>` +
      `This will revert the dashboard data and AI models back to the ` +
      `previous semester's state — not just remove a file.`;
    modal.style.display = 'flex';

    const newYes = yesBtn.cloneNode(true);
    yesBtn.parentNode.replaceChild(newYes, yesBtn);
    newYes.addEventListener('click', () => {
      modal.style.display = 'none';
      fetch('/api/delete-recent-upload/' + recordId, { method: 'DELETE' })
        .then((res) => res.json())
        .then((data) => {
          showAlert(data.message || (data.ok ? 'Deleted.' : 'Delete failed.'), data.ok ? 'success' : 'error');
          refreshLists();
        })
        .catch(() => {});
    });

    const newBack = backBtn.cloneNode(true);
    backBtn.parentNode.replaceChild(newBack, backBtn);
    newBack.addEventListener('click', () => { modal.style.display = 'none'; });
  }

  // ─────────────────────────────────────────────────────────
  // Recently Deleted (trash) table
  // ─────────────────────────────────────────────────────────

  window.loadDeletedList = function loadDeletedList() {
    const body = document.getElementById('deletedTableBody');
    if (!body) return;

    fetch('/api/deleted-list')
      .then((res) => res.json())
      .then((records) => {
        if (!Array.isArray(records) || records.length === 0) {
          body.innerHTML = `<div class="file-table__empty"><p>Nothing in the trash right now.</p></div>`;
          return;
        }

        body.innerHTML = records.map((r) => `
          <div class="file-table__row deleted-row">
            <span class="cell-filename" title="${escapeHtml(r.original_filename)}">${escapeHtml(r.original_filename)}</span>
            <span>${escapeHtml(r.academic_year)}</span>
            <span>${escapeHtml(r.semester)}</span>
            <span>${escapeHtml(r.deleted_at)}</span>
            <span>${escapeHtml(r.days_remaining)} day(s)</span>
            <span>
              <button class="btn-refresh row-action-btn" data-restore-id="${r.id}">Restore</button>
              <button class="btn-refresh row-action-btn" data-purge-id="${r.id}" data-purge-name="${escapeHtml(r.original_filename)}">Delete Permanently</button>
            </span>
          </div>`).join('');

        body.querySelectorAll('[data-restore-id]').forEach((btn) => {
          btn.addEventListener('click', () => {
            fetch('/api/restore-deleted/' + btn.getAttribute('data-restore-id'), { method: 'POST' })
              .then((res) => res.json())
              .then((data) => {
                showAlert(data.message || (data.ok ? 'Restoring…' : 'Restore failed.'), data.ok ? 'success' : 'error');
                refreshLists();
              })
              .catch(() => {});
          });
        });

        body.querySelectorAll('[data-purge-id]').forEach((btn) => {
          btn.addEventListener('click', () => {
            const filename = btn.getAttribute('data-purge-name');
            const modal = document.getElementById('deleteConfirmModal');
            const text  = document.getElementById('deleteConfirmText');
            const yesBtn = document.getElementById('confirmDeleteBtn');
            const backBtn = document.getElementById('cancelDeleteBtn');
            text.innerHTML = `Permanently delete <strong>"${filename}"</strong>? This cannot be undone.`;
            modal.style.display = 'flex';

            const newYes = yesBtn.cloneNode(true);
            yesBtn.parentNode.replaceChild(newYes, yesBtn);
            newYes.addEventListener('click', () => {
              modal.style.display = 'none';
              fetch('/api/permanently-delete/' + btn.getAttribute('data-purge-id'), { method: 'DELETE' })
                .then((res) => res.json())
                .then((data) => {
                  showAlert(data.message || (data.ok ? 'Permanently deleted.' : 'Delete failed.'), data.ok ? 'success' : 'error');
                  refreshLists();
                })
                .catch(() => {});
            });

            const newBack = backBtn.cloneNode(true);
            backBtn.parentNode.replaceChild(newBack, backBtn);
            newBack.addEventListener('click', () => { modal.style.display = 'none'; });
          });
        });
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