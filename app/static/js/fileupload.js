
  // ── State ──────────────────────────────────────────────────
  let activeRecordId = null;
  let pollTimer      = null;

  // ── DOM refs ───────────────────────────────────────────────
  const dropZone      = document.getElementById('dropZone');
  const fileInput     = document.getElementById('fileInput');
  const uploadAlert   = document.getElementById('uploadAlert');
  const pipelineCard  = document.getElementById('pipelineCard');
  const pipelineResult= document.getElementById('pipelineResult');

  const steps = {
    validate : document.getElementById('step-validate'),
    upload   : document.getElementById('step-upload'),
    clean    : document.getElementById('step-clean'),
    merge    : document.getElementById('step-merge'),
    models   : document.getElementById('step-models'),
  };

  // ── Drag & drop ────────────────────────────────────────────
  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFile(fileInput.files[0]);
  });

  // ── Alert helpers ──────────────────────────────────────────
  function showAlert(msg, type = 'error') {
    uploadAlert.className = `upload-alert upload-alert--${type}`;
    uploadAlert.innerHTML = msg;
    uploadAlert.classList.remove('hidden');
  }
  function hideAlert() { uploadAlert.classList.add('hidden'); }

  // ── Step helpers ───────────────────────────────────────────
  function stepState(key, state) {        // 'waiting' | 'running' | 'done' | 'error'
    const el = steps[key];
    el.className = `pipeline-step step--${state}`;
  }
  function allStepsWaiting() {
    Object.keys(steps).forEach(k => stepState(k, 'waiting'));
  }

  // ── File picked ────────────────────────────────────────────
  function handleFile(file) {
    hideAlert();
    allStepsWaiting();
    pipelineResult.classList.add('hidden');

    document.getElementById('pipelineFilename').textContent = file.name;
    document.getElementById('pipelineSize').textContent     = formatBytes(file.size);
    pipelineCard.classList.remove('hidden');

    stepState('validate', 'running');

    // Client-side format check before hitting the server
    if (!file.name.endsWith('.xlsx')) {
      stepState('validate', 'error');
      showAlert('Invalid file type. Only <strong>.xlsx</strong> grade-sheet workbooks are accepted.');
      return;
    }
    if (!/\d{4}[-_]\d{4}/.test(file.name)) {
      stepState('validate', 'error');
      showAlert(
        'Filename must include an academic year range (e.g. <strong>2022-2023</strong>). ' +
        'Please rename the file and try again.'
      );
      return;
    }
    if (file.size > 50 * 1024 * 1024) {
      stepState('validate', 'error');
      showAlert(`File is ${formatBytes(file.size)}, which exceeds the 50 MB limit.`);
      return;
    }

    stepState('validate', 'done');
    stepState('upload',   'running');
    uploadToServer(file);
  }

  // ── Upload to Flask endpoint ───────────────────────────────
  function uploadToServer(file) {
    const fd = new FormData();
    fd.append('file', file);

    fetch('/api/upload-dataset', { method: 'POST', body: fd })
      .then(r => r.json().then(data => ({ status: r.status, data })))
      .then(({ status, data }) => {
        if (!data.ok) {
          stepState('upload', 'error');
          if (data.duplicate) {
            showAlert(`<strong>Duplicate file detected.</strong><br>${data.error}`, 'warning');
          } else {
            showAlert(data.error || 'Upload failed.');
          }
          return;
        }
        stepState('upload', 'done');
        stepState('clean',  'running');
        activeRecordId = data.record_id;
        pollStatus();
      })
      .catch(() => {
        stepState('upload', 'error');
        showAlert('Network error — could not reach the server. Please try again.');
      });
  }

  // ── Poll /api/upload-status/<id> until done/failed ─────────
  function pollStatus() {
    if (!activeRecordId) return;
    clearTimeout(pollTimer);

    fetch(`/api/upload-status/${activeRecordId}`)
      .then(r => r.json())
      .then(data => {
        const s = data.status;

        if (s === 'processing') {
          // Still cleaning — keep running animation on step-clean
          stepState('clean', 'running');
          pollTimer = setTimeout(pollStatus, 1500);

        } else if (s === 'done') {
          stepState('clean',  'done');
          stepState('merge',  'done');
          stepState('models', 'done');

          pipelineResult.className = 'pipeline-result pipeline-result--success';
          pipelineResult.innerHTML =
            `<strong>✓ Processing complete.</strong> ` +
            `${data.row_count} records merged into the master dataset. ` +
            `Model CSVs have been rebuilt.`;
          pipelineResult.classList.remove('hidden');

          // Refresh both lists
          loadUnprocessedList();
          loadProcessedList();

        } else if (s === 'failed') {
          stepState('clean', 'error');
          pipelineResult.className = 'pipeline-result pipeline-result--error';
          pipelineResult.innerHTML =
            `<strong>Processing failed.</strong> ${data.error_message || 'Unknown error.'}`;
          pipelineResult.classList.remove('hidden');
        } else {
          // pending — server hasn't started yet
          pollTimer = setTimeout(pollStatus, 1000);
        }
      })
      .catch(() => {
        pollTimer = setTimeout(pollStatus, 2000);
      });
  }

  // ── Load unprocessed list ──────────────────────────────────
  function loadUnprocessedList() {
    fetch('/api/unprocessed-list')
      .then(r => r.json())
      .then(records => {
        const body = document.getElementById('unprocessedTableBody');
        if (!records.length) {
          body.innerHTML = emptyState('No files uploaded yet.');
          return;
        }
        body.innerHTML = records.map(r => `
          <div class="file-table__row">
            <span class="cell-filename" title="${r.original_filename}">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px;flex-shrink:0;color:#800000"><path fill-rule="evenodd" d="M5.625 1.5H9a3.75 3.75 0 0 1 3.75 3.75v1.875c0 1.036.84 1.875 1.875 1.875H16.5a3.75 3.75 0 0 1 3.75 3.75v7.875c0 1.035-.84 1.875-1.875 1.875H5.625a1.875 1.875 0 0 1-1.875-1.875V3.375c0-1.036.84-1.875 1.875-1.875Z" clip-rule="evenodd"/></svg>
              ${r.original_filename}
            </span>
            <span>${r.academic_year}</span>
            <span>${r.semester}</span>
            <span>${r.file_size_kb}</span>
            <span>${r.sheet_count}</span>
            <span>${r.uploader_name}</span>
            <span><span class="role-badge">${r.uploader_role}</span></span>
            <span>${r.uploaded_at}</span>
            <span>${statusBadge(r.status)}</span>
          </div>`).join('');
      });
  }

  // ── Load processed list ────────────────────────────────────
  function loadProcessedList() {
    fetch('/api/processed-list')
      .then(r => r.json())
      .then(data => {
        // --- Processed uploads ---
        const procBody = document.getElementById('processedTableBody');
        const recs = data.uploaded_records;
        if (!recs.length) {
          procBody.innerHTML = emptyState('No processed files yet.');
        } else {
          procBody.innerHTML = recs.map(r => `
            <div class="file-table__row processed-row">
              <span class="cell-filename" title="${r.original_filename}">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px;flex-shrink:0;color:#800000"><path fill-rule="evenodd" d="M5.625 1.5H9a3.75 3.75 0 0 1 3.75 3.75v1.875c0 1.036.84 1.875 1.875 1.875H16.5a3.75 3.75 0 0 1 3.75 3.75v7.875c0 1.035-.84 1.875-1.875 1.875H5.625a1.875 1.875 0 0 1-1.875-1.875V3.375c0-1.036.84-1.875 1.875-1.875Z" clip-rule="evenodd"/></svg>
                ${r.original_filename}
              </span>
              <span>${r.academic_year}</span>
              <span>${r.semester}</span>
              <span>${r.row_count}</span>
              <span>${r.uploader_name}</span>
              <span>${r.uploaded_at}</span>
              <span class="cell-filename" style="font-size:.78rem;color:#555">${r.processed_path}</span>
            </div>`).join('');
        }

        // --- Model files ---
        const modelBody = document.getElementById('modelFilesBody');
        const badge     = document.getElementById('modelFileBadge');
        const mf = data.model_files;
        badge.textContent = mf.length ? `${mf.length} files` : '—';
        if (!mf.length) {
          modelBody.innerHTML = emptyState('No model files generated yet.');
        } else {
          modelBody.innerHTML = mf.map(f => `
            <div class="file-table__row model-row">
              <span class="cell-filename">
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:16px;flex-shrink:0;color:#2a6fd4"><path d="M18.375 2.25c-1.035 0-1.875.84-1.875 1.875v15.75c0 1.035.84 1.875 1.875 1.875h.75c1.035 0 1.875-.84 1.875-1.875V4.125c0-1.035-.84-1.875-1.875-1.875h-.75Z"/><path d="M9.75 8.625c0-1.035.84-1.875 1.875-1.875h.75c1.035 0 1.875.84 1.875 1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-.75a1.875 1.875 0 0 1-1.875-1.875V8.625ZM3 13.125c0-1.035.84-1.875 1.875-1.875h.75c1.035 0 1.875.84 1.875 1.875v6.75c0 1.035-.84 1.875-1.875 1.875h-.75A1.875 1.875 0 0 1 3 19.875v-6.75Z"/></svg>
                ${f.filename}
              </span>
              <span>${f.size_kb}</span>
              <span>${f.modified}</span>
            </div>`).join('');
        }
      });
  }

  // ── Utility ────────────────────────────────────────────────
  function statusBadge(status) {
    const map = {
      pending    : ['badge--pending',    'Pending'],
      processing : ['badge--processing', 'Processing…'],
      done       : ['badge--done',       'Done'],
      failed     : ['badge--failed',     'Failed'],
      duplicate  : ['badge--warning',    'Duplicate'],
    };
    const [cls, label] = map[status] || ['badge--pending', status];
    return `<span class="status-badge ${cls}">${label}</span>`;
  }

  function emptyState(msg) {
    return `<div class="file-table__empty"><p>${msg}</p></div>`;
  }

  function formatBytes(b) {
    if (b < 1024)        return b + ' B';
    if (b < 1048576)     return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
  }

  // ── Init ───────────────────────────────────────────────────
  loadUnprocessedList();
  loadProcessedList();