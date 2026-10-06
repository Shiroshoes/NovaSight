/* fileupload.flags.js (v2) — "Flag review" for the CSV viewer modal, flagged-rows mode.
   One issue per line, like a cleanup report:
       Sheet | Row | Column | Value found | Why it was flagged
   Three tabs (Missing / Needs review / Fixed automatically), filters, search, paging.
   Exposes window.FlagReview = { render(container, apiData), csv(), hasData() }.
   Input: JSON from /api/preprocessing-warnings/<id>. Works with old grouped warnings
   (locations are listed) and with the new one-per-issue warnings. */
(function () {
  'use strict';

  var PAGE = 100;        // rows per page in the flat list
  var GROUP_STEP = 50;   // rows shown per issue group before "Show more"

  var TIERS = {
    'null':    { label: 'Missing',             dot: 'bad',
                 blurb: 'A required value is empty. Fix these in your file so the data can be trusted.' },
    highlight: { label: 'Needs review',        dot: 'warn',
                 blurb: 'The value didn\u2019t match any rule the system knows. It was kept as written \u2014 find the row and column in your file to check it.' },
    resolved:  { label: 'Fixed automatically', dot: 'ok',
                 blurb: 'The system corrected these or handled them by its rules. No action needed unless a fix looks wrong.' }
  };
  var TIER_ORDER = ['null', 'highlight', 'resolved'];

  /* ── Plain-language copy per category ─────────────────────── */
  var INFO = {
    'Subject Count mismatch': ['Subject count doesn\u2019t match', 'The subject total in column Q differs from the number of subject codes found for this student. Left out of training until it matches.'],
    'Abnormal subject count': ['Unusual number of subjects', 'The student has far more or fewer subjects than a normal semester load.'],
    'Zero subjects': ['Student has no subjects', 'A student row was found but no subject codes belong to it.'],
    'Conflicting Catalog Entry': ['Conflicting catalog entry', 'The same course code appears more than once in the catalog with different details.'],
    'Grade 5.00 \u2192 FAILED': ['Grade 5.00 saved as Failed', 'A grade of 5.00 is a failing grade, so it was saved as FAILED.'],
    'Grade 0 \u2192 DRP': ['Grade 0 saved as Dropped', 'A grade of 0 isn\u2019t a real grade, so it was saved as DRP (dropped).'],
    'Grade blank \u2192 DRP': ['Blank grade saved as Dropped', 'The grade cell was empty or held a placeholder, so it was saved as DRP (dropped).'],
    'NGA found': ['No Grade Assigned (NGA)', 'The grade cell says NGA, so the final grade is unknown. Look up the real grade.'],
    'Slash resolved': ['Combined grade split', 'The cell held both a status and a grade (like INC/2.75). The system picked the final value.'],
    'Slash resolved \u2192 FAILED': ['Combined grade saved as Failed', 'The cell had a 5.00 on one side, which always counts as FAILED.'],
    'CAHS centralization': ['Sheet merged into its college', 'A sub-college sheet was combined under its parent college.'],
    'Invalid grade text': ['Grade text not recognized', 'The cell holds text that isn\u2019t a grade or a known status.'],
    'Unusual grade value': ['Unusual grade value', 'The grade is a number the grading scale doesn\u2019t normally use.'],
    'Orphan grade (no code)': ['Grade with no subject code', 'The grade sits in a column with no subject code above it, so it can\u2019t be matched to a subject.'],
    'Unknown Course Code (not in catalog)': ['Course code not in the catalog', 'This course code doesn\u2019t exist in the course catalog. Add it to the catalog or correct the code.'],
    'Not included in dataset': ['Students left out of the dataset', 'These records were unreliable, so they were held back. See the related \u201CMissing\u201D flags.'],
    'Flagged for exclusion (kept anyway)': ['Unreliable students kept anyway', 'These records have problems but were kept because exclusion is switched off.'],
    'Grade rows skipped': ['Grades that couldn\u2019t be used', 'These grade cells had no usable grade, so they are not in the training table.'],
    'GWA out of range \u2192 MISSING': ['GWA outside the valid range', 'The computed average falls outside 1.00\u20135.00, so GWA was set to missing.'],
    'GWA not summable (majority non-numeric)': ['Too few numeric grades for a GWA', 'More than half of the subjects have a status (INC, DRP, W\u2026) instead of a number, so GWA was set to missing.'],
    'GWA fallback (unweighted average)': ['GWA estimated from a plain average', 'The credit-weighted GWA couldn\u2019t be computed, so an unweighted average was used.'],
    'Catalog check failed': ['Course catalog check didn\u2019t finish', 'The check against the course catalog stopped with an error. Try the upload again.'],
    'No course catalog': ['No course catalog found', 'There is no catalog to check course codes and credits against. Upload the catalog first.']
  };

  function describe(cat, tier) {
    var c = String(cat || ''), m;
    if (INFO[c]) return { title: INFO[c][0], what: INFO[c][1] };
    if ((m = c.match(/^Null (.+?)(?: \((Catalog)\))?$/)))
      return { title: 'Missing ' + m[1].toLowerCase() + (m[2] ? ' (catalog)' : ''), what: 'This required field is empty. Fill it in and upload again.' };
    if ((m = c.match(/^Typo \((.+)\)$/)))
      return { title: 'Typo fixed in ' + m[1].toLowerCase(), what: 'The value was misspelled and was matched to the closest known option.' };
    if ((m = c.match(/^(?:Unknown|Unrecognised|Unrecognized) (.+)$/)))
      return { title: m[1] + ' not recognized', what: 'The value didn\u2019t match any known option, even after trying to fix typos. Kept as written.' };
    return { title: c || 'Other', what: TIERS[tier] ? TIERS[tier].blurb : '' };
  }

  /* ── Parsing ──────────────────────────────────────────────── */
  function colLetter(i) {                       // 0 -> A, 16 -> Q, 26 -> AA   (refs use 0-based columns)
    i = Number(i);
    if (isNaN(i) || i < 0) return '';
    var s = '';
    do { s = String.fromCharCode(65 + (i % 26)) + s; i = Math.floor(i / 26) - 1; } while (i >= 0);
    return s;
  }

  function parseRef(ref) {
    var s = ref == null ? '' : String(ref).trim();
    var out = { sheet: '', row: null, col: '', extra: '', text: '', program: '' };
    s = s.replace(/\s@@(.*)$/, function (_, g) { out.program = g.trim(); return ''; });   // "…row56 @@BSCS"
    if (!s || s === 'file') return out;
    if (/^sheet:/.test(s)) { out.sheet = s.slice(6); return out; }
    var m = s.match(/^(.*?)!row(\d+)(?:\s+col(\d+))?(?:\s+(.*))?$/);
    if (m) {
      out.sheet = m[1]; out.row = parseInt(m[2], 10);
      out.col = m[3] != null ? colLetter(m[3]) : '';
      out.extra = m[4] || '';
      return out;
    }
    out.text = s;                               // e.g. a student key, or a sheet name on its own
    out.ref = parseKey(s);
    if (out.ref && out.ref.program && !out.program) out.program = out.ref.program;
    return out;
  }

  /* Break the long space-less refs into labelled parts so they read in 2-3 short lines.
     student=449_CEA_BACHELOROFSCIENCEINARCHITECTURE_1_20222023 subject=PRCT0413
     catalog row 207   |   catalog codes=TEAN0223/TEAU0223/...                         */
  function prettyProgram(raw) {
    return String(raw)
      .replace(/^BACHELOROFSCIENCEIN/, 'BS ').replace(/^BACHELOROFARTSIN/, 'AB ')
      .replace(/^BACHELOROFSCIENCE/, 'BS').replace(/^BACHELOROFARTS/, 'AB')
      .replace(/^MASTEROFSCIENCEIN/, 'MS ').replace(/^MASTEROFARTSIN/, 'MA ');
  }
  function parseKey(s) {
    var m = s.match(/^student=(\S+?)(?:\s+subject=(\S+))?$/);
    if (m) {
      var k = m[1], sm = k.match(/^(.+?)_([A-Z]+)_(.+)_(\d)_(\d{4})(\d{4})$/);
      var r = { kind: 'student', subject: m[2] || '', key: k };
      if (sm) {
        r.id = sm[1]; r.college = sm[2]; r.program = sm[2] + ' \u00B7 ' + prettyProgram(sm[3]);
        r.term = (sm[4] === '1' ? '1st' : sm[4] === '2' ? '2nd' : sm[4] === '3' ? 'Summer' : 'Sem ' + sm[4]) + ' sem \u00B7 AY ' + sm[5] + '\u2013' + sm[6];
      } else { r.id = k; }
      return r;
    }
    m = s.match(/^catalog row (\d+)$/i);
    if (m) return { kind: 'catrow', row: m[1] };
    m = s.match(/^catalog codes=(.+)$/i);
    if (m) return { kind: 'catcodes', codes: m[1].split('/').filter(Boolean) };
    return null;
  }

  var AGG = /^(\d+) occurrence\(s\)(?: in sheet '([^']*)')? \u2014 e\.g\.: ([\s\S]*?)(?: \u2014 Refs: ([\s\S]*))?$/;

  function makeRow(w, tier, p, why, info, note) {
    var q = String(why).match(/^'([^']*)'/);
    if (!q) q = String(why).match(/^Grade is ([0-9]+(?:\.[0-9]+)?)\b/);   // "Grade is 5.00 — treated as FAILED" has no quotes
    if (!p.col) { var cm = String(why).match(/\(col ([A-Z]{1,3})\)/); if (cm) p = { sheet: p.sheet, row: p.row, col: cm[1], extra: p.extra, text: p.text, program: p.program, ref: p.ref }; }
    var sc = !q && String(why).match(/reports (\d+) subject\(s\) but only (\d+)/);   // Subject Count mismatch
    return {
      tier: tier, category: String(w.category || 'Other'), issue: info.title,
      sheet: p.sheet || '\u2014', program: p.program || '', row: p.row,
      rowLabel: p.row != null ? 'Row ' + p.row : (p.text || '\u2014'),
      ref: p.ref || null,
      col: p.col, extra: p.extra, value: q ? q[1] : (sc ? sc[1] + ' (' + sc[2] + ' coded)' : ''), why: why, note: note || ''
    };
  }

  function expand(w) {
    var tier = String(w.tier || '').toLowerCase();
    if (!TIERS[tier]) tier = 'resolved';
    var info = describe(w.category, tier);
    var msg = String(w.message || '');
    var agg = msg.match(AGG);
    if (!agg) return [makeRow(w, tier, parseRef(w.ref), msg, info)];

    // Older upload: many hits were saved as one grouped line. List every location we kept.
    var count = parseInt(agg[1], 10) || 1, sheet = agg[2] || parseRef(w.ref).sheet;
    var refs = [], more = 0;
    if (agg[4]) agg[4].split(', ').forEach(function (r) {
      var mm = r.match(/^\+(\d+) more$/);
      if (mm) more = parseInt(mm[1], 10); else if (r.trim()) refs.push(r.trim());
    });
    var rows = refs.map(function (r) {
      var p = parseRef(r); if (!p.sheet) p.sheet = sheet;
      return makeRow(w, tier, p, info.what, info, 'grouped');
    });
    var unlisted = count - refs.length;
    if (!rows.length || unlisted > 0) {
      rows.push(makeRow(w, tier, { sheet: sheet, row: null, col: '', extra: '', text: '\u2026' },
        (rows.length ? unlisted : count).toLocaleString() + ' more place(s) in this sheet were not listed individually. ' + info.what,
        info, 'grouped'));
    }
    return rows;
  }

  /* ── Helpers ──────────────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) { return Number(n).toLocaleString(); }

  var COLS = [
    { k: 'sheet', label: 'Sheet',              w: 11 },
    { k: 'prog',  label: 'Program',            w: 13 },
    { k: 'row',   label: 'Row in file',        w: 17 },
    { k: 'col',   label: 'Column',             w: 10 },
    { k: 'val',   label: 'Value found',        w: 14 },
    { k: 'why',   label: 'Why it was flagged', w: 46 }
  ];
  var LONG = 190;   // messages longer than this get a "Show more" toggle

  var last = null;  // most recent view (used by csv())

  // one document-level listener closes any open "Columns" menu when clicking elsewhere
  document.addEventListener('click', function (e) {
    var open = document.querySelectorAll('.flagrev-cols[open]');
    for (var i = 0; i < open.length; i++) if (!open[i].contains(e.target)) open[i].removeAttribute('open');
  });

  /* ── Excel export: one tab per sheet (hand-written .xlsx, no library needed) ── */
  var CRC_T = (function () { var t = [], n, k, c; for (n = 0; n < 256; n++) { c = n; for (k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function zipStore(files) {                               // files: [{name, data: Uint8Array}] — no compression
    var enc = new TextEncoder(), parts = [], central = [], offset = 0;
    files.forEach(function (f) {
      var name = enc.encode(f.name), crc = crc32(f.data), sz = f.data.length;
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
      lh.setUint16(12, 0x21, true); lh.setUint32(14, crc, true); lh.setUint32(18, sz, true); lh.setUint32(22, sz, true);
      lh.setUint16(26, name.length, true);
      parts.push(new Uint8Array(lh.buffer), name, f.data);
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(14, 0x21, true); ch.setUint32(16, crc, true); ch.setUint32(20, sz, true); ch.setUint32(24, sz, true);
      ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + sz;
    });
    var csize = central.reduce(function (a, p) { return a + p.length; }, 0);
    var end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    return new Blob(parts.concat(central, [new Uint8Array(end.buffer)]),
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }
  function xe(v) {                                          // XML-escape + drop characters XML can't hold
    return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function sheetXML(header, widths, rows, wrapLast) {
    var lastCol = colLetter(header.length - 1), n = rows.length + 1;
    var x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>' +
      widths.map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('') + '</cols><sheetData>';
    function cell(ci, ri, v, st) {
      var ref = colLetter(ci) + ri;
      if (typeof v === 'number') return '<c r="' + ref + '"' + (st ? ' s="' + st + '"' : '') + '><v>' + v + '</v></c>';
      return '<c r="' + ref + '" t="inlineStr"' + (st ? ' s="' + st + '"' : '') + '><is><t xml:space="preserve">' + xe(v) + '</t></is></c>';
    }
    x += '<row r="1">' + header.map(function (h, i) { return cell(i, 1, h, 1); }).join('') + '</row>';
    rows.forEach(function (r, ri) {
      x += '<row r="' + (ri + 2) + '">' + r.map(function (v, i) { return cell(i, ri + 2, v, wrapLast && i === r.length - 1 ? 2 : 0); }).join('') + '</row>';
    });
    return x + '</sheetData><autoFilter ref="A1:' + lastCol + n + '"/></worksheet>';
  }
  function buildXlsx(all, hasProg) {
    // One tab per tier — Missing, Needs review, Fixed automatically — each with a Sheet column.
    var header = ['Issue', 'Sheet'].concat(hasProg ? ['Program'] : [], ['Row in file', 'Column', 'Value found', 'Why it was flagged']);
    var widths = [34, 14].concat(hasProg ? [12] : [], [12, 16, 18, 90]);
    var tabs = TIER_ORDER.map(function (t) {
      return { name: TIERS[t].label, rows: all.filter(function (r) { return r.tier === t; }) };
    });
    var enc = new TextEncoder(), files = [], NS = 'http://schemas.openxmlformats.org/';
    function add(name, text) { files.push({ name: name, data: enc.encode(text) }); }
    var H = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
    add('[Content_Types].xml', H + '<Types xmlns="' + NS + 'package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      tabs.map(function (t, i) { return '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'; }).join('') + '</Types>');
    add('_rels/.rels', H + '<Relationships xmlns="' + NS + 'package/2006/relationships"><Relationship Id="rId1" Type="' + NS + 'officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
    add('xl/workbook.xml', H + '<workbook xmlns="' + NS + 'spreadsheetml/2006/main" xmlns:r="' + NS + 'officeDocument/2006/relationships"><sheets>' +
      tabs.map(function (t, i) { return '<sheet name="' + xe(t.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; }).join('') + '</sheets></workbook>');
    add('xl/_rels/workbook.xml.rels', H + '<Relationships xmlns="' + NS + 'package/2006/relationships">' +
      tabs.map(function (t, i) { return '<Relationship Id="rId' + (i + 1) + '" Type="' + NS + 'officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'; }).join('') +
      '<Relationship Id="rId' + (tabs.length + 1) + '" Type="' + NS + 'officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    add('xl/styles.xml', H + '<styleSheet xmlns="' + NS + 'spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF3F1EC"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf></cellXfs>' +
      '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
    tabs.forEach(function (t, i) {
      var rows = t.rows.map(function (r) {
        return [r.issue, r.sheet && r.sheet !== '\u2014' ? r.sheet : 'Whole file'].concat(hasProg ? [r.program || ''] : [],
          [r.row != null ? r.row : r.rowLabel, r.col + (r.extra ? ' (' + r.extra + ')' : ''), r.value, r.why]);
      });
      add('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXML(header, widths, rows, true));
    });
    return zipStore(files);
  }

  function create(container, data, opts) {
    opts = opts || {};
    var rows = [];
    ((data && data.warnings) || []).forEach(function (w) { rows = rows.concat(expand(w)); });
    rows.sort(function (a, b) {
      if (a.sheet !== b.sheet) return a.sheet < b.sheet ? -1 : 1;
      return (a.row == null ? 1e9 : a.row) - (b.row == null ? 1e9 : b.row);
    });

    var S = {
      all: rows, file: (data && data.original_filename) || '', tab: 'null', q: '', cat: '', sheet: '',
      mode: opts.mode === 'grouped' ? 'grouped' : 'flat', page: 0,
      shown: {}, closed: {}, hide: {}, root: null,
      grouped: rows.some(function (r) { return r.note === 'grouped'; }),
      hasProg: rows.some(function (r) { return !!r.program; }),
      multi: (function () { var u = {}, n = 0; rows.forEach(function (r) { if (r.sheet && r.sheet !== '\u2014' && !u[r.sheet]) { u[r.sheet] = 1; n++; } }); return n > 1; })()
    };
    function inTab(t) { return S.all.filter(function (r) { return r.tier === t; }); }
    S.tab = TIER_ORDER.filter(function (t) { return inTab(t).length; })[0] || 'null';

    function visible() {
      var q = S.q.trim().toLowerCase();
      return inTab(S.tab).filter(function (r) {
        if (S.cat && r.category !== S.cat) return false;
        if (S.sheet && r.sheet !== S.sheet) return false;
        if (!q) return true;
        return (r.issue + ' ' + r.sheet + ' ' + r.program + ' ' + r.rowLabel + ' ' + r.col + ' ' + r.extra + ' ' + r.value + ' ' + r.why)
          .toLowerCase().indexOf(q) !== -1;
      });
    }
    function $(sel) { return S.root.querySelector(sel); }

    /* ── pieces ── */
    function summaryHTML() {
      var n = S.all.length, a = inTab('null').length, b = inTab('highlight').length, c = inTab('resolved').length, bits = [];
      if (a) bits.push('<strong>' + fmt(a) + '</strong> missing a required value');
      if (b) bits.push('<strong>' + fmt(b) + '</strong> need a review');
      if (c) bits.push('<strong>' + fmt(c) + '</strong> fixed automatically');
      var out = '<p class="flagrev-summary">' + (S.file && !opts.confirm ? '<span class="flagrev-file">' + esc(S.file) + '</span>: ' : '') +
        '<strong>' + fmt(n) + '</strong> issue' + (n === 1 ? '' : 's') + ' flagged' + (bits.length ? ' \u2014 ' + bits.join(', ') : '') + '. ' +
        'Your uploaded file is not changed. Row numbers and column letters match your spreadsheet.</p>';
      if (opts.confirm) {
        out += '<p class="flagrev-next"><strong>What to do:</strong> look through the tabs below. Choose ' +
          '<em>Save &amp; separate CSVs</em> to continue, or <em>Cancel/discard this upload</em> to fix your file and upload it again.</p>';
      }
      if (S.grouped) out += '<p class="flagrev-note">This upload saved some repeated issues as one grouped line, so only some locations are listed. Uploads made after the update list every issue.</p>';
      return out;
    }

    function tabsHTML() {
      return '<div class="flagrev-tabs" role="tablist" aria-label="Flag type">' + TIER_ORDER.map(function (t) {
        return '<button type="button" role="tab" class="flagrev-tab' + (S.tab === t ? ' is-active' : '') + '" data-tab="' + t +
          '" aria-selected="' + (S.tab === t) + '"><span class="flagrev-dot flagrev-dot--' + TIERS[t].dot + '"></span>' +
          TIERS[t].label + ' <span class="flagrev-tab-n">' + fmt(inTab(t).length) + '</span></button>';
      }).join('') + '</div>';
    }

    function filterOptions() {
      var sc = {}, ss = {}, cats = [], sheets = [];
      inTab(S.tab).forEach(function (r) {
        if (!sc[r.category]) { sc[r.category] = 1; cats.push([r.category, r.issue]); }
        if (!ss[r.sheet]) { ss[r.sheet] = 1; sheets.push(r.sheet); }
      });
      $('.flagrev-cat').innerHTML = '<option value="">' + (S.tab === 'resolved' ? 'All Fixed Issue type' : 'All issue types') + '</option>' + cats.map(function (c) {
        return '<option value="' + esc(c[0]) + '"' + (S.cat === c[0] ? ' selected' : '') + '>' + esc(c[1]) + '</option>'; }).join('');
      paintSheets();
    }

    function paintSheets() {
      var bar = $('.flagrev-sheetbar');
      if (!S.multi) { bar.style.display = 'none'; bar.innerHTML = ''; return; }
      var cnt = {}, order = [], total = 0;
      inTab(S.tab).forEach(function (r) {
        if (S.cat && r.category !== S.cat) return;
        total++; if (!cnt[r.sheet]) { cnt[r.sheet] = 0; order.push(r.sheet); } cnt[r.sheet]++;
      });
      if (S.sheet && !cnt[S.sheet]) S.sheet = '';
      var chip = function (val, label, n) {
        return '<button type="button" class="flagrev-chip' + (S.sheet === val ? ' is-active' : '') + '" data-sheet="' + esc(val) + '">' + esc(label) +
          ' <span class="flagrev-tab-n">' + fmt(n) + '</span></button>';
      };
      bar.style.display = '';
      bar.innerHTML = '<span class="flagrev-sheetlabel">Sheet</span>' + chip('', 'All sheets', total) +
        order.map(function (k) { return chip(k, k === '\u2014' ? 'Whole file' : k, cnt[k]); }).join('');
    }
    function availCols() { return COLS.filter(function (c) { return (c.k !== 'prog' || S.hasProg) && (c.k !== 'sheet' || !S.multi); }); }   // multi-sheet files are split into sheet sections instead   // no Program column for older uploads
    function visCols() { return availCols().filter(function (c) { return !S.hide[c.k]; }); }

    function tableHTML(list, showIssue) {
      var cols = visCols().filter(function (c) {          // drop any column that would show only "\u2014" in this table
        if (c.k === 'prog') return list.some(function (r) { return r.program; });
        if (c.k === 'row')  return list.some(function (r) { return r.ref || r.row != null || (r.rowLabel && r.rowLabel !== '\u2014'); });
        if (c.k === 'col')  return list.some(function (r) { return r.col || r.extra || r.row != null; });
        if (c.k === 'val')  return list.some(function (r) { return shownValue(r); });
        return true;
      }), total = cols.reduce(function (a, c) { return a + c.w; }, 0);
      if (!cols.length) return '<div class="flagrev-empty">All columns are hidden \u2014 turn some back on under \u201CColumns\u201D.</div>';
      var cg = '<colgroup>' + cols.map(function (c) { return '<col style="width:' + (c.w / total * 100).toFixed(2) + '%">'; }).join('') + '</colgroup>';
      var th = '<thead><tr>' + cols.map(function (c) { return '<th>' + c.label + '</th>'; }).join('') + '</tr></thead>';
      var body = list.map(function (r) {
        return '<tr>' + cols.map(function (c) { return cell(c.k, r, showIssue); }).join('') + '</tr>';
      }).join('');
      return '<div class="flagrev-tablewrap"><table class="flagrev-table">' + cg + th + '<tbody>' + body + '</tbody></table></div>';
    }

    function shownValue(r) {          // a value already visible as a code chip isn't repeated
      if (!r.value) return '';
      if (r.ref && r.ref.kind === 'catcodes' && r.ref.codes.indexOf(r.value) !== -1) return '';
      return r.value;
    }

    function refHTML(r) {
      var f = r.ref;
      if (!f) return esc(r.rowLabel);
      if (f.kind === 'student') {
        return '<span class="flagrev-refmain">Student ' + esc(f.id) + '</span>' +
          (f.term ? '<span class="flagrev-sub">' + esc(f.term) + '</span>' : '') +
          (f.subject ? '<span class="flagrev-sub">Subject <code>' + esc(f.subject) + '</code></span>' : '');
      }
      if (f.kind === 'catrow') return '<span class="flagrev-refmain">Catalog row ' + esc(f.row) + '</span>';
      var chips = f.codes.map(function (c) { return '<code class="flagrev-chipcode">' + esc(c) + '</code>'; }).join('');
      return '<span class="flagrev-refmain">' + f.codes.length + ' catalog codes</span><span class="flagrev-codes">' + chips + '</span>';
    }

    function cell(k, r, showIssue) {
      if (k === 'sheet') return '<td class="flagrev-c-sheet">' + (r.sheet && r.sheet !== '\u2014' ? esc(r.sheet) : '<span class="flagrev-sub">Whole file</span>') + '</td>';
      if (k === 'prog')  return '<td class="flagrev-c-prog">' + (r.program ? esc(r.program) : '\u2014') + '</td>';
      if (k === 'row')   return '<td class="flagrev-c-ref">' + refHTML(r) + '</td>';
      if (k === 'col')   return '<td>' + (r.col ? '<span class="flagrev-col">' + esc(r.col) + '</span>' : (r.row != null ? '<span class="flagrev-sub">Whole row</span>' : '\u2014')) +
                           (r.extra ? '<span class="flagrev-sub">' + esc(r.extra) + '</span>' : '') + '</td>';
      if (k === 'val')   return '<td>' + (shownValue(r) ? '<code>' + esc(shownValue(r)) + '</code>' : '\u2014') + '</td>';
      var long = r.why.length > LONG;
      return '<td class="flagrev-c-why">' + (showIssue ? '<span class="flagrev-issue">' + esc(r.issue) + '</span>' : '') +
        '<span class="flagrev-msg' + (long ? ' is-clamped' : '') + '">' + esc(r.why) + '</span>' +
        (long ? '<button type="button" class="flagrev-linkbtn" data-clamp>Show more</button>' : '') + '</td>';
    }

    function sectionedHTML(slice, full, showIssue) {
      if (!S.multi) return tableHTML(slice, showIssue);
      var cnt = {}, out = '', run = [], cur = null;
      full.forEach(function (r) { cnt[r.sheet] = (cnt[r.sheet] || 0) + 1; });
      function flush() {
        if (!run.length) return;
        out += '<div class="flagrev-sheetsec"><div class="flagrev-sheethead"><span class="flagrev-sheetname">' +
          (cur && cur !== '\u2014' ? esc(cur) : 'Whole file') + '</span><span class="flagrev-gcount">' +
          fmt(cnt[cur]) + (cnt[cur] === 1 ? ' flag' : ' flags') + '</span></div>' + tableHTML(run, showIssue) + '</div>';
        run = [];
      }
      slice.forEach(function (r) { if (r.sheet !== cur) { flush(); cur = r.sheet; } run.push(r); });
      flush();
      return out;
    }

    function groupsHTML(list) {
      var g = {}, order = [];
      list.forEach(function (r) { if (!g[r.category]) { g[r.category] = []; order.push(r.category); } g[r.category].push(r); });
      order.sort(function (a, b) { return g[b].length - g[a].length; });
      return order.map(function (cat, i) {
        var key = S.tab + '|' + cat, items = g[cat], info = describe(cat, S.tab);
        if (S.closed[key] === undefined) S.closed[key] = order.length > 3 && i > 0;
        var n = S.shown[key] || GROUP_STEP, slice = items.slice(0, n), left = items.length - slice.length;
        return '<section class="flagrev-group' + (S.closed[key] ? ' is-closed' : '') + '" data-key="' + esc(key) + '">' +
          '<button type="button" class="flagrev-ghead" data-ghead aria-expanded="' + !S.closed[key] + '">' +
          '<span class="flagrev-dot flagrev-dot--' + TIERS[S.tab].dot + '"></span>' +
          '<span class="flagrev-gtitle">' + esc(info.title) + '</span>' +
          (info.title !== cat ? '<span class="flagrev-raw">' + esc(cat) + '</span>' : '') +
          '<span class="flagrev-gcount">' + fmt(items.length) + (items.length === 1 ? ' place' : ' places') + '</span>' +
          '<span class="flagrev-chev" aria-hidden="true"></span></button>' +
          '<div class="flagrev-gbody">' + (info.what ? '<p class="flagrev-what">' + esc(info.what) + '</p>' : '') +
          sectionedHTML(slice, items, false) +
          (left > 0 ? '<div class="flagrev-moreline"><span>Showing ' + fmt(slice.length) + ' of ' + fmt(items.length) + '</span>' +
            '<button type="button" class="flagrev-pgbtn" data-more="' + esc(key) + '">Show ' + fmt(Math.min(100, left)) + ' more</button>' +
            (left > 100 ? '<button type="button" class="flagrev-pgbtn" data-all="' + esc(key) + '">Show all</button>' : '') + '</div>' : '') +
          '</div></section>';
      }).join('');
    }

    function paintResults() {
      var list = visible(), box = $('.flagrev-results'), pager = $('.flagrev-pager');
      $('.flagrev-groupctl').style.display = S.mode === 'grouped' && list.length ? '' : 'none';
      if (!list.length) {
        box.innerHTML = '<div class="flagrev-empty">' + (inTab(S.tab).length ? 'No flags match your filters.'
          : 'Nothing under \u201C' + TIERS[S.tab].label + '\u201D \u2014 good news.') + '</div>';
        pager.style.display = 'none'; return;
      }
      if (S.mode === 'grouped') { box.innerHTML = groupsHTML(list); pager.style.display = 'none'; return; }
      var pages = Math.max(1, Math.ceil(list.length / PAGE));
      if (S.page >= pages) S.page = pages - 1;
      var from = S.page * PAGE;
      box.innerHTML = sectionedHTML(list.slice(from, from + PAGE), list, true);
      pager.style.display = list.length > PAGE ? '' : 'none';
      $('.flagrev-pager-info').textContent = 'Showing ' + fmt(from + 1) + '\u2013' + fmt(Math.min(from + PAGE, list.length)) + ' of ' + fmt(list.length);
      $('[data-prev]').disabled = S.page === 0;
      $('[data-next]').disabled = S.page >= pages - 1;
    }

    function paintMode() {
      var b = S.root.querySelectorAll('[data-mode]');
      for (var i = 0; i < b.length; i++) b[i].classList.toggle('is-active', b[i].dataset.mode === S.mode);
    }
    function paintAll() {
      $('.flagrev-tabs-slot').innerHTML = tabsHTML();
      $('.flagrev-tierblurb').textContent = TIERS[S.tab].blurb;
      filterOptions(); paintMode(); paintResults();
    }
    function scrollTop() { if (container.scrollTop) container.scrollTop = 0; }

    /* ── shell ── */
    container.innerHTML = '<div class="flagrev' + (opts.confirm ? ' flagrev--confirm' : '') + '">' + summaryHTML() +
      '<div class="flagrev-sticky"><div class="flagrev-bar"><div class="flagrev-tabs-slot"></div><div class="flagrev-tools">' +
      '<select class="flagrev-cat" aria-label="Filter by issue type"></select>' +
      '<input type="search" class="flagrev-search" placeholder="Search flags\u2026" aria-label="Search flags">' +
      '</div></div><div class="flagrev-sheetbar"></div></div>' +
      '<div class="flagrev-bar2"><p class="flagrev-tierline"><span class="flagrev-tierblurb"></span></p><div class="flagrev-tools2">' +
      '<span class="flagrev-groupctl"><button type="button" class="flagrev-linkbtn" data-collapse>Collapse all</button>' +
      '<button type="button" class="flagrev-linkbtn" data-expand>Expand all</button></span>' +
      '<span class="flagrev-seg" role="group" aria-label="Layout"><button type="button" data-mode="grouped">By issue</button><button type="button" data-mode="flat">All rows</button></span>' +
      '<details class="flagrev-cols"><summary>Columns</summary><div class="flagrev-colmenu">' +
      availCols().map(function (c) { return '<label><input type="checkbox" data-col="' + c.k + '" checked> ' + c.label + '</label>'; }).join('') +
      '</div></details></div></div>' +
      '<div class="flagrev-results"></div>' +
      '<div class="flagrev-pager"><span class="flagrev-pager-info"></span><span>' +
      '<button type="button" class="flagrev-pgbtn" data-prev>\u2190 Prev</button><button type="button" class="flagrev-pgbtn" data-next>Next \u2192</button></span></div></div>';
    S.root = container.querySelector('.flagrev');

    /* ── events ── */
    S.root.addEventListener('click', function (e) {
      var el;
      if ((el = e.target.closest('[data-tab]')))  { S.tab = el.dataset.tab; S.cat = ''; S.sheet = ''; S.page = 0; paintAll(); scrollTop(); return; }
      if ((el = e.target.closest('[data-sheet]'))) { S.sheet = el.dataset.sheet; S.page = 0; paintSheets(); paintResults(); scrollTop(); return; }
      if ((el = e.target.closest('[data-mode]'))) { S.mode = el.dataset.mode; S.page = 0; paintMode(); paintResults(); return; }
      if (e.target.closest('[data-prev]')) { S.page--; paintResults(); scrollTop(); return; }
      if (e.target.closest('[data-next]')) { S.page++; paintResults(); scrollTop(); return; }
      if ((el = e.target.closest('[data-ghead]'))) {
        var g = el.closest('.flagrev-group'), closed = !g.classList.contains('is-closed');
        g.classList.toggle('is-closed', closed); S.closed[g.dataset.key] = closed;
        el.setAttribute('aria-expanded', String(!closed)); return;
      }
      if ((el = e.target.closest('[data-more]'))) { S.shown[el.dataset.more] = (S.shown[el.dataset.more] || GROUP_STEP) + 100; paintResults(); return; }
      if ((el = e.target.closest('[data-all]')))  { S.shown[el.dataset.all] = 1e9; paintResults(); return; }
      if (e.target.closest('[data-collapse]') || e.target.closest('[data-expand]')) {
        var shut = !!e.target.closest('[data-collapse]');
        S.root.querySelectorAll('.flagrev-group').forEach(function (g) { S.closed[g.dataset.key] = shut; });
        paintResults(); return;
      }
      if ((el = e.target.closest('[data-clamp]'))) {
        var msg = el.previousElementSibling, open = msg.classList.contains('is-clamped');
        msg.classList.toggle('is-clamped', !open); el.textContent = open ? 'Show less' : 'Show more';
      }
    });
    S.root.addEventListener('change', function (e) {
      var cb = e.target.closest('[data-col]');
      if (cb) { S.hide[cb.dataset.col] = !cb.checked; paintResults(); }
    });
    $('.flagrev-search').addEventListener('input', function (e) { S.q = e.target.value; S.page = 0; paintResults(); });
    $('.flagrev-cat').addEventListener('change', function (e) { S.cat = e.target.value; S.page = 0; paintSheets(); paintResults(); });
    paintAll();

    last = {
      hasData: function () { return S.all.length > 0; },
      xlsx: function () { return buildXlsx(S.all, S.hasProg); },
      csv: function () {
        var q = function (v) { var s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
        var lines = [['Type', 'Issue', 'Sheet', 'Program', 'Row in file', 'Column', 'Value found', 'Why it was flagged'].join(',')];
        TIER_ORDER.forEach(function (t) { inTab(t).forEach(function (r) {
          lines.push([TIERS[t].label, r.issue, r.sheet, r.program, r.row != null ? r.row : r.rowLabel,
            r.col + (r.extra ? ' (' + r.extra + ')' : ''), r.value, r.why].map(q).join(','));
        }); });
        return lines.join('\n');
      }
    };
  }

  /* render(container, apiData, { mode: 'flat'|'grouped', confirm: bool })  */
  window.FlagReview = {
    render: create,
    csv: function () { return last ? last.csv() : ''; },
    hasData: function () { return !!last && last.hasData(); },
    xlsx: function () { return last ? last.xlsx() : null; },       // Blob: one tab per sheet
    xlsxFromData: function (data) { var r = []; ((data && data.warnings) || []).forEach(function (w) { r = r.concat(expand(w)); }); return buildXlsx(r, r.some(function (x) { return !!x.program; })); }
  };
})();