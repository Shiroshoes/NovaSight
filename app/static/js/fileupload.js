// ── State ──────────────────────────────────────────────────
let activeRecordId = null;
let pollTimer      = null;

// ── DOM refs ───────────────────────────────────────────────
const dropZone       = document.getElementById('dropZone');
const fileInput      = document.getElementById('fileInput');
const uploadAlert    = document.getElementById('uploadAlert');
const pipelineCard   = document.getElementById('pipelineCard');
const pipelineResult = document.getElementById('pipelineResult');

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
  // Reset so the same file can be re-selected after an error
  fileInput.value = '';
});

// ── Alert helpers ──────────────────────────────────────────
function showAlert(msg, type = 'error') {
  uploadAlert.className = `upload-alert upload-alert--${type}`;
  uploadAlert.innerHTML = msg;
  uploadAlert.classList.remove('hidden');
  uploadAlert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideAlert() { uploadAlert.classList.add('hidden'); }

// ── Step helpers ───────────────────────────────────────────
function stepState(key, state) { // 'waiting' | 'running' | 'done' | 'error'
  const el = steps[key];
  if (el) el.className = `pipeline-step step--${state}`;
}
function allStepsWaiting() {
  Object.keys(steps).forEach(k => stepState(k, 'waiting'));
}

// ── Filename validator ─────────────────────────────────────
/**
 * Accepted patterns (spaces OR underscores between parts):
 *   2022-1 Student-Performance Dataset.xlsx
 *   2022-1_Student-Performance_Dataset.xlsx
 *   2022-1 Student-Performance Dataset
 *
 * Regex breakdown:
 *   ^\d{4}          → 4-digit year  e.g. 2022
 *   -[12]           → dash + semester number (1 or 2 only)
 *   [_ ]            → separator: space OR underscore
 *   Student-Performance   → literal (hyphen required)
 *   [_ ]            → separator
 *   Dataset         → literal
 *   (\.xlsx)?$      → optional extension (browser sometimes strips it)
 */
const FILENAME_REGEX = /^\d{4}-[12][_ ]Student-Performance[_ ]Dataset(\.xlsx)?$/i;

function validateFilename(name) {
  return FILENAME_REGEX.test(name);
}

// ── File picked ────────────────────────────────────────────
function handleFile(file) {
  hideAlert();
  allStepsWaiting();
  pipelineResult.classList.add('hidden');
  pipelineCard.classList.remove('hidden');

  document.getElementById('pipelineFilename').textContent = file.name;
  document.getElementById('pipelineSize').textContent     = formatBytes(file.size);

  stepState('validate', 'running');

  // 1. Extension check
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    stepState('validate', 'error');
    showAlert(
      'Invalid file type. Only <strong>.xlsx</strong> workbooks are accepted.<br>' +
      '<small>Received: <code>' + escHtml(file.name) + '</code></small>'
    );
    return;
  }

  // 2. Filename format check
  // Strip .xlsx for the regex test so both "2022-1 Student-Performance Dataset"
  // and "2022-1 Student-Performance Dataset.xlsx" both pass
  const nameWithoutExt = file.name.replace(/\.xlsx$/i, '');
  if (!validateFilename(nameWithoutExt + '.xlsx') && !validateFilename(file.name)) {
    stepState('validate', 'error');
    showAlert(
      'Filename does not match the required format.<br>' +
      'Expected: <strong>YYYY-N Student-Performance Dataset.xlsx</strong><br>' +
      'Where <strong>N</strong> is <code>1</code> (1st sem) or <code>2</code> (2nd sem).<br>' +
      'Examples:<br>' +
      '&nbsp;&nbsp;• <code>2022-1 Student-Performance Dataset.xlsx</code><br>' +
      '&nbsp;&nbsp;• <code>2025-2 Student-Performance Dataset.xlsx</code><br>' +
      '<small>Received: <code>' + escHtml(file.name) + '</code></small>'
    );
    return;
  }

  stepState('validate', 'done');
  stepState('upload', 'running');
  uploadToServer(file);
}

// ── Upload to Flask ────────────────────────────────────────
function uploadToServer(file) {
  const fd = new FormData();
  fd.append('file', file);

  fetch('/api/upload-dataset', { method: 'POST', body: fd })
    .then(r => r.json().then(data => ({ status: r.status, data })))
    .then(({ status, data }) => {
      if (!data.ok) {
        stepState('upload', 'error');
        if (data.duplicate) {
          showAlert(
            '<strong>Duplicate file detected.</strong><br>' + data.error,
            'warning'
          );
        } else {
          showAlert(data.error || 'Upload failed. Please try again.');
        }
        return;
      }
      stepState('upload', 'done');
      stepState('clean', 'running');
      activeRecordId = data.record_id;
      pollStatus();
    })
    .catch(err => {
      stepState('upload', 'error');
      showAlert('Network error — could not reach the server. Please check your connection and try again.');
      console.error('Upload error:', err);
    });
}

// ── Poll /api/upload-status/<id> ──────────────────────────
function pollStatus() {
  if (!activeRecordId) return;
  clearTimeout(pollTimer);

  fetch(`/api/upload-status/${activeRecordId}`)
    .then(r => r.json())
    .then(data => {
      const s = data.status;

      if (s === 'processing') {
        stepState('clean', 'running');
        pollTimer = setTimeout(pollStatus, 1500);

      } else if (s === 'done') {
        stepState('clean',  'done');
        stepState('merge',  'done');
        stepState('models', 'done');

        // Show horizon info if available
        let horizonMsg = '';
        if (data.horizon && data.horizon.horizon_year) {
          horizonMsg =
            ` Prediction horizon extended to <strong>${data.horizon.horizon_year}</strong>.`;
        }

        pipelineResult.className = 'pipeline-result pipeline-result--success';
        pipelineResult.innerHTML =
          `<strong>✓ Processing complete.</strong> ` +
          `${data.row_count || '—'} records merged into the master dataset. ` +
          `All model CSVs have been rebuilt.` +
          horizonMsg;
        pipelineResult.classList.remove('hidden');

        loadUnprocessedList();
        loadProcessedList();

      } else if (s === 'failed') {
        stepState('clean', 'error');
        pipelineResult.className = 'pipeline-result pipeline-result--error';
        pipelineResult.innerHTML =
          `<strong>Processing failed.</strong> ${escHtml(data.error_message || 'Unknown error.')}`;
        pipelineResult.classList.remove('hidden');

      } else {
        // 'pending' — server hasn't picked it up yet
        pollTimer = setTimeout(pollStatus, 1000);
      }
    })
    .catch(() => {
      // Network blip — keep trying
      pollTimer = setTimeout(pollStatus, 2500);
    });
}

// ── Load unprocessed list ──────────────────────────────────
function loadUnprocessedList() {
  const body = document.getElementById('unprocessedTableBody');
  body.innerHTML = loadingRow(9);

  fetch('/api/unprocessed-list')
    .then(r => r.json())
    .then(records => {
      if (!records.length) {
        body.innerHTML = emptyState('No files uploaded yet.');
        return;
      }
      body.innerHTML = records.map(r => `
        <div class="file-table__row">
          <span class="cell-filename" title="${escHtml(r.original_filename)}">
            ${xlsxIcon('#800000')}
            ${escHtml(r.original_filename)}
          </span>
          <span>${escHtml(r.academic_year)}</span>
          <span>${escHtml(r.semester)}</span>
          <span>${escHtml(r.file_size_kb)}</span>
          <span>${escHtml(String(r.sheet_count))}</span>
          <span>${escHtml(r.uploader_name)}</span>
          <span><span class="role-badge">${escHtml(r.uploader_role)}</span></span>
          <span>${escHtml(r.uploaded_at)}</span>
          <span>${statusBadge(r.status)}</span>
        </div>`).join('');
    })
    .catch(() => {
      body.innerHTML = emptyState('Failed to load list. Refresh to try again.');
    });
}

// ── Load processed list ────────────────────────────────────
function loadProcessedList() {
  const procBody  = document.getElementById('processedTableBody');
  const modelBody = document.getElementById('modelFilesBody');
  procBody.innerHTML  = loadingRow(7);
  modelBody.innerHTML = loadingRow(3);

  fetch('/api/processed-list')
    .then(r => r.json())
    .then(data => {
      // ── Processed uploads ──
      const recs = data.uploaded_records || [];
      if (!recs.length) {
        procBody.innerHTML = emptyState('No processed files yet.');
      } else {
        procBody.innerHTML = recs.map(r => `
          <div class="file-table__row processed-row">
            <span class="cell-filename" title="${escHtml(r.original_filename)}">
              ${xlsxIcon('#800000')}
              ${escHtml(r.original_filename)}
            </span>
            <span>${escHtml(r.academic_year)}</span>
            <span>${escHtml(r.semester)}</span>
            <span>${escHtml(String(r.row_count))}</span>
            <span>${escHtml(r.uploader_name)}</span>
            <span>${escHtml(r.uploaded_at)}</span>
            <span class="cell-path"
                  title="${escHtml(r.processed_path.split(/[\\/]/).pop())}">
                ${escHtml(r.processed_path.split(/[\\/]/).pop())}
            </span>
          </div>`).join('');
      }

      // ── Model files ──
      const badge = document.getElementById('modelFileBadge');
      const mf    = data.model_files || [];
      badge.textContent = mf.length ? `${mf.length} files` : '—';

      if (!mf.length) {
        modelBody.innerHTML = emptyState('No model files generated yet.');
      } else {
        modelBody.innerHTML = mf.map(f => `
          <div class="file-table__row model-row">
            <span class="cell-filename">
              ${csvIcon()}
              ${escHtml(f.filename)}
            </span>
            <span>${escHtml(f.size_kb)}</span>
            <span>${escHtml(f.modified)}</span>
          </div>`).join('');
      }

      // ── Horizon banner (if available) ──
      const h = data.horizon;
      if (h && h.horizon_year) {
        let banner = document.getElementById('horizonBanner');
        if (!banner) {
          banner = document.createElement('div');
          banner.id = 'horizonBanner';
          banner.className = 'horizon-banner';
          const processedCard = document.getElementById('processedCard');
          processedCard.insertBefore(banner, processedCard.querySelector('hr.divider').nextSibling);
        }
        banner.innerHTML =
          `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" style="width:18px;flex-shrink:0">
             <path d="M12.75 12.75a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0ZM7.5 15.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm.75 2.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm3.75-2.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm.75 2.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Zm3.75-2.25a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm.75 2.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0Z"/>
             <path fill-rule="evenodd" d="M6.75 2.25A.75.75 0 0 1 7.5 3v1.5h9V3A.75.75 0 0 1 18 3v1.5h.75a3 3 0 0 1 3 3v11.25a3 3 0 0 1-3 3H5.25a3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3H6V3a.75.75 0 0 1 .75-.75Zm13.5 9a1.5 1.5 0 0 0-1.5-1.5H5.25a1.5 1.5 0 0 0-1.5 1.5v7.5a1.5 1.5 0 0 0 1.5 1.5h13.5a1.5 1.5 0 0 0 1.5-1.5v-7.5Z" clip-rule="evenodd"/>
           </svg>
           <span>
             Latest data: <strong>${escHtml(h.latest_year)}</strong> &nbsp;·&nbsp;
             Predicting up to: <strong>${escHtml(h.horizon_year)}</strong>
             (${h.total_steps_forward} years forward, ${h.completed_years} completed school year${h.completed_years !== 1 ? 's' : ''} uploaded)
           </span>`;
      }
    })
    .catch(() => {
      procBody.innerHTML  = emptyState('Failed to load. Refresh to try again.');
      modelBody.innerHTML = emptyState('Failed to load. Refresh to try again.');
    });
}

// ── Utility ────────────────────────────────────────────────
function statusBadge(status) {
  const map = {
    pending    : ['badge--pending',    'Pending'],
    processing : ['badge--processing', 'Processing…'],
    done       : ['badge--done',       '✓ Done'],
    failed     : ['badge--failed',     '✗ Failed'],
    duplicate  : ['badge--warning',    'Duplicate'],
  };
  const [cls, label] = map[status] || ['badge--pending', status];
  return `<span class="status-badge ${cls}">${label}</span>`;
}

function emptyState(msg) {
  return `<div class="file-table__empty"><p>${msg}</p></div>`;
}

function loadingRow(cols) {
  return `<div class="file-table__empty"><p style="color:#aaa">Loading…</p></div>`;
}

function formatBytes(b) {
  if (b < 1024)    return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
}

function escHtml(str) {
  if (str == null) return '—';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xlsxIcon(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
    style="width:16px;flex-shrink:0;color:${color}">
    <path fill-rule="evenodd" d="M5.625 1.5H9a3.75 3.75 0 0 1 3.75 3.75v1.875c0 1.036.84 1.875 1.875
    1.875H16.5a3.75 3.75 0 0 1 3.75 3.75v7.875c0 1.035-.84 1.875-1.875 1.875H5.625a1.875
    1.875 0 0 1-1.875-1.875V3.375c0-1.036.84-1.875 1.875-1.875Z" clip-rule="evenodd"/>
  </svg>`;
}

function csvIcon() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"
    style="width:16px;flex-shrink:0;color:#2a6fd4">
    <path d="M18.375 2.25c-1.035 0-1.875.84-1.875 1.875v15.75c0 1.035.84 1.875 1.875
    1.875h.75c1.035 0 1.875-.84 1.875-1.875V4.125c0-1.035-.84-1.875-1.875-1.875h-.75Z"/>
    <path d="M9.75 8.625c0-1.035.84-1.875 1.875-1.875h.75c1.035 0 1.875.84 1.875
    1.875v11.25c0 1.035-.84 1.875-1.875 1.875h-.75a1.875 1.875 0 0 1-1.875-1.875V8.625Z"/>
    <path d="M3 13.125c0-1.035.84-1.875 1.875-1.875h.75c1.035 0 1.875.84 1.875
    1.875v6.75c0 1.035-.84 1.875-1.875 1.875h-.75A1.875 1.875 0 0 1 3 19.875v-6.75Z"/>
  </svg>`;
}

// ── Init ───────────────────────────────────────────────────
loadUnprocessedList();
loadProcessedList(); 