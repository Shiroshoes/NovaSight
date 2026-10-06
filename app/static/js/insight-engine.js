/* insight-engine.js — NovaSight rule-based chart insights (no AI service needed)
 * ---------------------------------------------------------------------------
 * Reads the numbers each chart ALREADY fetched from the Python APIs
 * (/api/dash/* and /api/pred/*) and writes numbered insights from them:
 * college, course/program, academic year, semester, year level, subjects,
 * grades, GWA, completion, statuses, gender, forecasts, and so on.
 *
 * Load this BEFORE maindash.js / prediction-dash.js:
 *   <script src="{{ url_for('static', filename='js/insight-engine.js') }}"></script>
 *
 * Usage:  InsightEngine.generate('heatmapCard', 'main')  -> string | null
 *         InsightEngine.generate('gwaCard',     'pred')  -> string | null
 * Returns null when the chart's data has not loaded yet.
 */
(function () {
'use strict';

/* ── formatting helpers ──────────────────────────────────────────────────── */
const num = v => (v == null || v === '' || isNaN(v)) ? null : Number(v);
const n0 = v => num(v) == null ? '—' : Math.round(v).toLocaleString('en-US');
const n1 = v => num(v) == null ? '—' : Number(v).toFixed(1);
const n2 = v => num(v) == null ? '—' : Number(v).toFixed(2);
const pc = v => num(v) == null ? '—' : Number(v).toFixed(1) + '%';
const plural = (n, w) => `${n0(n)} ${w}${Math.round(n) === 1 ? '' : 's'}`;
const sum = a => a.reduce((x, y) => x + (num(y) || 0), 0);
const sh = s => {
  try {
    if (window.PD && window.PD.sc) return window.PD.sc(s);
    if (window.courseShort) return window.courseShort(s);
  } catch (e) {}
  return s;
};

const ORD = { 1: '1st', 2: '2nd', 3: '3rd', 4: '4th', 5: '5th' };
function ylName(y) {
  const s = String(y).toUpperCase();
  if (s.includes('IRREG')) return 'Irregular';
  const m = s.match(/\d/);
  return m ? ORD[m[0]] + ' Year' : String(y);
}
const STATUS = { FAILED: 'Failed', DRP: 'Dropped', INC: 'Incomplete', UDR: 'Unofficial Drop',
                 W: 'Withdrawn', NGA: 'No Grade', CONTINUING: 'Continuing' };
const semName = s => ({ '1sem': '1st Semester', '2sem': '2nd Semester', Summer: 'Summer' }[s] || s);
const PERF_NAME = { avg_gwa_score: 'GWA score', passing_rate: 'passing rate', completion_rate: 'completion rate',
                    retention_rate: 'retention rate', regular_ratio: 'regular-student share' };

function gwaBand(g) {                     // Philippine scale: 1.00 best, 5.00 failing, 3.00 passing line
  if (g <= 1.75) return 'strong (honors range)';
  if (g <= 2.5)  return 'solid';
  if (g <= 3.0)  return 'passing but close to the 3.00 line';
  return 'below the passing line';
}

function scopeText(F) {
  if (typeof F === 'string') return F;
  F = F || {};
  const p = [];
  if (F.year) { const y = parseInt(F.year, 10); p.push(isNaN(y) ? `AY ${F.year}` : `AY ${y}-${y + 1}`); }
  if (F.sem) p.push(semName(F.sem));
  if (F.dept) p.push(F.dept);
  if (F.course) p.push(sh(F.course));
  const yl = F.yearlevel || F.yl;
  if (yl) p.push(ylName(yl) + (String(yl).toUpperCase().includes('IRREG') ? '' : ' students'));
  if (F.subject) p.push('subject ' + F.subject);
  return p.length ? p.join(' · ') : 'all colleges (no filters applied)';
}

function finish(scope, lines, action) {
  const out = ['Auto-generated summary — written by rules from the numbers currently on this chart (no AI). Review and edit before saving.',
               'Scope: ' + scope, ''];
  lines.forEach((l, i) => out.push(`${i + 1}. ${l}`));
  if (action) out.push('', 'Suggested action: ' + action);
  return out.join('\n');
}
const noData = (F, msg) => finish(scopeText(F), [msg || 'No records match these filters, so there is nothing to summarise. Try a different academic year, semester or college.']);

/* ══════════════════════════════════════════════════════════════════════════
   HISTORICAL DASHBOARD (/api/dash/*)
   ══════════════════════════════════════════════════════════════════════════ */
function kpiHist(d, F) {
  if (!d) return null;
  const total = num(d.total_enrollment) || 0;
  if (!total) return noData(F);
  const L = [];
  let s = `${n0(total)} students are enrolled`;
  const dl = num(d.enrollment_delta);
  if (dl != null) {
    s += dl === 0 ? ', unchanged from the comparison period'
      : `, ${dl > 0 ? 'up' : 'down'} ${n0(Math.abs(dl))}` +
        (num(d.enrollment_pct_change) != null ? ` (${n1(Math.abs(d.enrollment_pct_change))}%)` : '') + ' from the comparison period';
  }
  L.push(s + '.');

  const reg = num(d.regular_count) || 0, irr = num(d.irregular_count) || 0, ri = reg + irr;
  if (ri) {
    const irrShare = irr / ri * 100;
    L.push(`${n0(reg)} students (${pc(reg / ri * 100)}) are regular and ${n0(irr)} (${pc(irrShare)}) are irregular.` +
      (irrShare >= 25 ? ' The irregular share is high, which usually means many students are carrying back subjects.' : ''));
  }
  const g = num(d.avg_gwa);
  if (g != null) {
    let t = `The average GWA is ${n2(g)}, which is ${gwaBand(g)}`;
    const gd = num(d.gwa_delta);
    if (gd) t += `; it ${gd < 0 ? 'improved' : 'worsened'} by ${n2(Math.abs(gd))} points (1.00 is best)`;
    L.push(t + '.');
  }
  const c = num(d.avg_completion);
  if (c != null) {
    let t = `The average completion rate is ${pc(c)}`;
    const cd = num(d.completion_delta);
    if (cd) t += `, ${cd > 0 ? 'up' : 'down'} ${n1(Math.abs(cd))} points`;
    L.push(t + '.');
  }
  const ent = Object.entries(d.status_counts || {}).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  if (ent.length) {
    L.push(`There are ${n0(sum(ent.map(e => e[1])))} subject-level marks of concern (Failed, INC, DRP, UDR, W, NGA). ` +
      `${STATUS[ent[0][0]] || ent[0][0]} is the largest at ${n0(ent[0][1])}` +
      (ent[1] ? `, followed by ${STATUS[ent[1][0]] || ent[1][0]} at ${n0(ent[1][1])}.` : '.'));
  }
  const ye = Object.entries(d.year_level_counts || {}).sort((a, b) => b[1] - a[1]);
  if (ye.length) {
    L.push(`${ylName(ye[0][0])} is the largest group with ${n0(ye[0][1])} students (${pc(ye[0][1] / total * 100)} of enrollment)` +
      (ye.length > 1 ? `; ${ylName(ye[ye.length - 1][0])} is the smallest at ${n0(ye[ye.length - 1][1])}.` : '.'));
  }
  let act;
  const lead = ent.length ? ent[0][0] : '';
  if (lead === 'FAILED') act = 'target tutoring and early-warning checks at the subjects with the most failures.';
  else if (lead === 'INC' || lead === 'NGA') act = 'follow up with faculty on incomplete and ungraded records before they turn into failures.';
  else if (lead) act = 'review advising and retention support, since most concerns are drops and withdrawals.';
  else act = 'keep monitoring and compare against next semester.';
  if (g != null && g > 2.5) act += ' Also look at programs whose average GWA sits near the 3.00 line.';
  return finish(scopeText(F), L, act);
}

function heatHist(d, F) {
  if (!d || !d.rows || !d.rows.length) return null;
  const status = F.status || 'FAILED', st = STATUS[status] || status;
  const isCount = d.metric === 'count', yls = d.year_levels || [], what = d.view === 'course' ? 'program' : 'college';
  const f = v => isCount ? plural(v, 'student') : pc(v);
  const rows = d.rows, L = [];

  if (d.compare && rows[0].delta !== undefined) {              // delta view
    const cells = [];
    rows.forEach(r => yls.forEach(y => { const x = num(r.delta && r.delta[y]); if (x != null) cells.push({ r, y, x }); }));
    const worse = cells.filter(c => c.x > 0.05).sort((a, b) => b.x - a.x);
    const better = cells.filter(c => c.x < -0.05).sort((a, b) => a.x - b.x);
    const unit = isCount ? '' : ' points';
    L.push(`Compared with ${d.prev_period || 'the previous period'}, ${worse.length} of ${cells.length} ${what}/year-level groups got worse on ${st} and ${better.length} improved.`);
    if (worse.length) { const w = worse[0];
      L.push(`The biggest increase is ${sh(w.r.label)} ${ylName(w.y)}: +${isCount ? n0(w.x) : n1(w.x)}${unit} (${f(w.r.prev && w.r.prev[w.y])} → ${f(w.r[w.y])}).`); }
    if (better.length) { const b = better[0];
      L.push(`The biggest improvement is ${sh(b.r.label)} ${ylName(b.y)}: ${isCount ? n0(b.x) : n1(b.x)}${unit} (${f(b.r.prev && b.r.prev[b.y])} → ${f(b.r[b.y])}).`); }
    const net = rows.map(r => ({ label: r.label, s: sum(yls.map(y => r.delta && r.delta[y])) })).sort((a, b) => b.s - a.s);
    if (net.length > 1) L.push(`Summed across year levels, ${sh(net[0].label)} moved the most in the wrong direction (${net[0].s > 0 ? '+' : ''}${n1(net[0].s)}) and ${sh(net[net.length - 1].label)} the most in the right direction (${n1(net[net.length - 1].s)}).`);
    return finish(scopeText(F), L, worse.length ? `look first at ${sh(worse[0].r.label)} (${ylName(worse[0].y)}) and ask what changed since ${d.prev_period || 'last period'}.` : 'no group got worse; keep current support in place.');
  }

  const cells = [];
  rows.forEach(r => yls.forEach(y => { if (num(r[y]) != null) cells.push({ r, y, v: r[y], n: r.enrolled && r.enrolled[y], k: r.with_status && r.with_status[y] }); }));
  if (!cells.length) return noData(F);
  const top = cells.reduce((a, b) => b.v > a.v ? b : a);
  L.push(`${sh(top.r.label)} ${ylName(top.y)} has the highest ${st} ${isCount ? 'count' : 'rate'}: ${f(top.v)}` +
    (num(top.n) && num(top.k) != null ? ` (${n0(top.k)} of ${n0(top.n)} enrolled)` : '') + '.');

  const groups = rows.map(r => {
    let e = 0, k = 0; yls.forEach(y => { e += (r.enrolled && r.enrolled[y]) || 0; k += (r.with_status && r.with_status[y]) || 0; });
    return { label: r.label, e, k, rate: e ? k / e * 100 : null };
  }).filter(g => g.e > 0);
  groups.sort((a, b) => isCount ? b.k - a.k : b.rate - a.rate);
  if (groups.length > 1) {
    const hi = groups[0], lo = groups[groups.length - 1];
    L.push(`Across all year levels, ${sh(hi.label)} is highest at ${pc(hi.rate)} (${n0(hi.k)} of ${n0(hi.e)} students) and ${sh(lo.label)} is lowest at ${pc(lo.rate)} (${n0(lo.k)} of ${n0(lo.e)}), a gap of ${n1(hi.rate - lo.rate)} points between ${what}s.`);
  } else if (groups.length === 1) {
    L.push(`${sh(groups[0].label)} has ${pc(groups[0].rate)} of its students with ${st} (${n0(groups[0].k)} of ${n0(groups[0].e)}).`);
  }
  const yAgg = yls.map(y => {
    let e = 0, k = 0; rows.forEach(r => { e += (r.enrolled && r.enrolled[y]) || 0; k += (r.with_status && r.with_status[y]) || 0; });
    return { y, e, k, rate: e ? k / e * 100 : null };
  }).filter(x => x.e > 0).sort((a, b) => b.rate - a.rate);
  if (yAgg.length > 1) L.push(`By year level, ${ylName(yAgg[0].y)} students have the highest ${st} rate overall (${pc(yAgg[0].rate)}), while ${ylName(yAgg[yAgg.length - 1].y)} students have the lowest (${pc(yAgg[yAgg.length - 1].rate)}).`);
  const hot = cells.filter(c => !isCount && c.v >= 20).length;
  if (!isCount) L.push(hot ? `${hot} ${what}/year-level group${hot === 1 ? ' sits' : 's sit'} at 20% or higher, which is a heavy share of a cohort.` : `No ${what}/year-level group reaches 20%, so the problem is spread thinly rather than concentrated.`);
  const early = yAgg.length && ['1', '2'].some(n => String(yAgg[0].y).startsWith(n));
  return finish(scopeText(F), L, early
    ? `the early years carry the highest ${st} rate, so bridging classes and early advising for ${ylName(yAgg[0].y)} students should come first.`
    : `focus support on ${sh(top.r.label)} ${ylName(top.y)} and re-check the same cell next semester.`);
}

function perfHist(d, F) {
  if (!d || !d.rows || !d.rows.length) return null;
  const rk = d.rank_by || F.rank || 'avg_gwa_score', name = PERF_NAME[rk] || rk;
  const what = d.view === 'course' ? 'program' : 'college';
  const rows = d.rows.filter(r => num(r[rk]) != null);
  if (!rows.length) return noData(F);
  const L = [];
  const top = rows[0], bot = rows[rows.length - 1];
  const gwaNote = r => rk === 'avg_gwa_score' && r.avg_gwa != null ? ` (average GWA ${n2(r.avg_gwa)})` : '';
  if (rows.length > 1) L.push(`On ${name}, ${sh(top.label)} leads at ${pc(top[rk])}${gwaNote(top)} and ${sh(bot.label)} trails at ${pc(bot[rk])}${gwaNote(bot)}, a gap of ${n1(top[rk] - bot[rk])} points between ${what}s.`);
  else L.push(`${sh(top.label)} scores ${pc(top[rk])} on ${name}${gwaNote(top)}.`);
  const weak = rows.filter(r => r[rk] < 70);
  L.push(weak.length ? `${weak.length} of ${rows.length} ${what}${rows.length === 1 ? '' : 's'} score under 70% on ${name}: ${weak.slice(0, 4).map(r => `${sh(r.label)} (${pc(r[rk])})`).join(', ')}.`
                     : `Every ${what} scores 70% or higher on ${name}.`);
  const lowest = key => rows.filter(r => num(r[key]) != null).sort((a, b) => a[key] - b[key])[0];
  const lp = lowest('passing_rate'), lr = lowest('retention_rate'), lc = lowest('completion_rate');
  const bits = [];
  if (lp) bits.push(`passing rate is lowest at ${sh(lp.label)} (${pc(lp.passing_rate)})`);
  if (lr) bits.push(`retention is lowest at ${sh(lr.label)} (${pc(lr.retention_rate)})`);
  if (lc) bits.push(`completion is lowest at ${sh(lc.label)} (${pc(lc.completion_rate)})`);
  if (bits.length) L.push(`Across the other measures: ${bits.join('; ')}.`);
  if (d.has_prev) {
    const mv = rows.map(r => ({ r, x: (num(r.prev && r.prev[rk]) != null) ? r[rk] - r.prev[rk] : null })).filter(m => m.x != null).sort((a, b) => b.x - a.x);
    if (mv.length) {
      const up = mv[0], dn = mv[mv.length - 1];
      L.push(`Versus ${d.prev_period || 'the previous semester'}, ${sh(up.r.label)} moved the most ${up.x >= 0 ? 'up' : 'down'} (${up.x >= 0 ? '+' : ''}${n1(up.x)} points)` +
        (mv.length > 1 ? ` and ${sh(dn.r.label)} moved the most ${dn.x >= 0 ? 'up' : 'down'} (${dn.x >= 0 ? '+' : ''}${n1(dn.x)} points).` : '.'));
    }
  }
  const lown = rows.filter(r => r.low_n).length;
  if (lown) L.push(`${lown} ${what}${lown === 1 ? ' has' : 's have'} fewer than 30 students, so treat ${lown === 1 ? 'its' : 'their'} figures as indicative only.`);
  return finish(scopeText(F), L, `share what ${sh(top.label)} does in advising and assessment with ${sh(bot.label)}, and agree on one improvement target for ${name} next semester.`);
}

function pieStats(p) {
  if (!p || !p.labels || !p.labels.length) return null;
  const total = sum(p.values), ci = p.labels.indexOf('CONTINUING'), contN = ci >= 0 ? p.values[ci] : 0;
  let top = null;
  p.labels.forEach((l, i) => { if (l !== 'CONTINUING' && (!top || p.values[i] > top.n)) top = { l, n: p.values[i] }; });
  return { total, contN, contShare: total ? contN / total * 100 : null, top };
}

function genderHist(d, F) {
  if (!d) return null;
  const m = pieStats(d.male_pie), f = pieStats(d.female_pie);
  if (!m && !f) return noData(F);
  const L = [];
  const line = (lbl, s) => s ? `${lbl}: ${n0(s.total)} students, ${pc(s.contShare)} continuing without a flagged status` +
    (s.top && s.top.n ? `; the most common concern is ${STATUS[s.top.l] || s.top.l} at ${pc(s.top.n / s.total * 100)} (${n0(s.top.n)} students)` : '') + '.' : null;
  [line('Male', m), line('Female', f)].forEach(x => x && L.push(x));
  if (m && f) {
    const gap = (100 - f.contShare) - (100 - m.contShare);
    L.push(Math.abs(gap) < 2 ? `The share of students with a flagged status is nearly the same for both genders (${n1(Math.abs(gap))} point difference).`
      : `${gap > 0 ? 'Female' : 'Male'} students have the higher share with a flagged status, by ${n1(Math.abs(gap))} points.`);
  }
  const g = {};
  (d.table_rows || []).forEach(r => {
    const k = r.Group || r.Department; if (!k || !r.Gender) return;
    g[k] = g[k] || {}; const o = g[k][r.Gender] = g[k][r.Gender] || { t: 0, nc: 0 };
    o.t += r.Count || 0; if (r.Status !== 'CONTINUING') o.nc += r.Count || 0;
  });
  const gaps = Object.entries(g).filter(([, v]) => v.Male && v.Female && v.Male.t >= 20 && v.Female.t >= 20)
    .map(([k, v]) => ({ k, mm: v.Male.nc / v.Male.t * 100, ff: v.Female.nc / v.Female.t * 100 }))
    .map(x => ({ ...x, gap: x.ff - x.mm })).sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  if (gaps.length) {
    const x = gaps[0];
    L.push(`The widest gap by ${d.group_label === 'Course' ? 'program' : 'college'} is ${sh(x.k)}: ${pc(x.ff)} of female and ${pc(x.mm)} of male students have a flagged status (${n1(Math.abs(x.gap))} points, ${x.gap > 0 ? 'higher for female' : 'higher for male'}).`);
  }
  if (d.basis === 'ds03') L.push('Note: these figures come from status records, not unique students, so they can exceed enrollment.');
  return finish(scopeText(F), L, gaps.length && Math.abs(gaps[0].gap) >= 5
    ? `check whether advising and support services reach both genders equally in ${sh(gaps[0].k)}.`
    : 'no large gender gap here; keep monitoring across semesters before drawing conclusions.');
}

function hardestHist(M, F) {
  const d = M.hs();
  const rows = M.hsRows ? M.hsRows() : [];
  if (!d || !rows.length) return null;
  const L = [];
  const byGrade = rows.filter(s => num(s.avg_grade) != null).sort((a, b) => b.avg_grade - a.avg_grade);
  const stu = s => plural(s.student_count || 0, 'student');
  if (byGrade.length) {
    const h = byGrade[0], over = byGrade.filter(s => s.avg_grade > 3.0).length;
    L.push(`${h.label} (${h.code}${h.dept ? ', ' + h.dept : ''}) has the hardest average grade at ${n2(h.avg_grade)} across ${stu(h)}. ` +
      (rows.length === 1 ? (over ? 'That is above the 3.00 passing line.' : 'That is within the 3.00 passing line.') : over ? `${over} of the ${rows.length} subjects shown average above 3.00 (the passing line).` : `None of the ${rows.length} subjects shown averages above 3.00.`));
  }
  const byFail = [...rows].sort((a, b) => (b.FAILED || 0) - (a.FAILED || 0));
  if ((byFail[0].FAILED || 0) > 0) {
    const tot = sum(rows.map(s => s.FAILED)), t3 = sum(byFail.slice(0, 3).map(s => s.FAILED));
    L.push(`${byFail[0].label} has the most failures (${n0(byFail[0].FAILED)} students). The top three subjects account for ${pc(tot ? t3 / tot * 100 : 0)} of the ${n0(tot)} failures shown.`);
  }
  const mk = key => { const x = [...rows].sort((a, b) => (b[key] || 0) - (a[key] || 0))[0]; return x && (x[key] || 0) > 0 ? `${key} is highest in ${x.label} (${n0(x[key])})` : null; };
  const extra = ['INC', 'DRP', 'UDR', 'W'].map(mk).filter(Boolean);
  if (extra.length) L.push(`Other marks: ${extra.join('; ')}.`);
  const dep = {};
  rows.forEach(s => { if (s.dept) dep[s.dept] = (dep[s.dept] || 0) + 1; });
  const de = Object.entries(dep).sort((a, b) => b[1] - a[1]);
  if (de.length) L.push(`${de[0][0]} owns ${de[0][1]} of the ${rows.length} subjects listed${de.length > 1 ? `, followed by ${de[1][0]} (${de[1][1]})` : ''}.`);
  if (d.trend && d.trend.length && d.trend_labels && d.trend_labels.length > 1) {
    const mv = d.trend.map(s => {
      const v = (s.values || []).map((x, i) => [x, i]).filter(p => p[0] != null);
      return v.length > 1 ? { l: s.label, x: v[v.length - 1][0] - v[0][0], a: d.trend_labels[v[0][1]], b: d.trend_labels[v[v.length - 1][1]] } : null;
    }).filter(Boolean).sort((a, b) => b.x - a.x);
    if (mv.length) {
      const w = mv[0], b = mv[mv.length - 1];
      L.push(`Over time, ${w.l} worsened the most (${n2(w.x)} grade points from ${w.a} to ${w.b})` + (mv.length > 1 && b.x < 0 ? `, while ${b.l} improved the most (${n2(b.x)} points).` : '.'));
    }
  }
  const lead = byGrade[0] || rows[0];
  return finish(scopeText(F), L, `offer review sessions or remedial support for ${lead.label} and the other top subjects before the next enrollment period; check shared prerequisites if several come from one department.`);
}

function trendHist(d, F, kind) {
  if (!d || !d.labels || !d.labels.length || !d.datasets || !d.datasets.length) return null;
  const L = [], labels = d.labels, n = labels.length, W = d.group_by === 'course' ? 'program' : 'college';
  const isStatus = kind === 'status';
  const mname = isStatus ? (STATUS[d.metric] || d.metric || 'Failed') : ({ all: 'total', regular: 'regular', irregular: 'irregular' }[d.metric] || 'total');
  const totals = labels.map((_, i) => sum(d.datasets.map(ds => ds.data[i])));
  const series = d.datasets.map(ds => {
    let fi = -1, li = -1; ds.data.forEach((v, i) => { if (v != null) { if (fi < 0) fi = i; li = i; } });
    return { label: ds.label, fi, li, first: fi >= 0 ? ds.data[fi] : null, last: li >= 0 ? ds.data[li] : null, data: ds.data };
  });
  const mv = series.filter(s => s.li > s.fi && s.first > 0).map(s => ({ ...s, x: s.last - s.first, p: (s.last - s.first) / s.first * 100 })).sort((a, b) => b.p - a.p);
  const unitW = isStatus ? `students with ${mname}` : `${mname} students`;
  if (n > 1 && totals[0] > 0) {
    const ch = totals[n - 1] - totals[0];
    L.push(`From ${labels[0]} to ${labels[n - 1]}, the combined count of ${unitW} went from ${n0(totals[0])} to ${n0(totals[n - 1])} (${ch >= 0 ? '+' : ''}${n0(ch)}, ${pc(ch / totals[0] * 100)}).`);
  } else L.push(`Only one recorded period is available (${labels[0]}), with ${n0(totals[0])} ${unitW}.`);
  if (n > 1) {
    const ch = totals[n - 1] - totals[n - 2];
    L.push(`In the latest semester (${labels[n - 1]}) the count ${ch === 0 ? 'did not change' : (ch > 0 ? 'rose' : 'fell') + ' by ' + n0(Math.abs(ch))} compared with ${labels[n - 2]}.`);
    const pk = totals.indexOf(Math.max(...totals));
    L.push(`The peak was ${labels[pk]} at ${n0(totals[pk])}${pk === n - 1 ? ', which is the latest semester' : ''}.`);
  }
  if (mv.length > 1) {
    const up = mv[0], dn = mv[mv.length - 1];
    L.push(`The fastest-growing ${W} is ${sh(up.label)} (${n0(up.first)} → ${n0(up.last)}, ${up.p >= 0 ? '+' : ''}${n1(up.p)}%) and the biggest decline is ${sh(dn.label)} (${n0(dn.first)} → ${n0(dn.last)}, ${n1(dn.p)}%).`);
  }
  const big = [...series].filter(s => num(s.last) != null).sort((a, b) => b.last - a.last)[0];
  if (big) L.push(`${sh(big.label)} has the largest count in the latest data point (${n0(big.last)}).`);
  if (d.compare === '1sem' || d.compare === '2sem') L.push(`Only the ${d.compare === '1sem' ? '1st' : '2nd'} semester of each year is shown, so this is a year-over-year view.`);
  const act = isStatus
    ? (mv.length ? `share the rising ${W}s (starting with ${sh(mv[0].label)}) with their deans and set a follow-up target for next semester.` : 'keep monitoring; there is not enough history yet to call a trend.')
    : (mv.length ? `use this trend when planning sections and faculty load; look at retention in any ${W} that is shrinking while others grow.` : 'keep monitoring; there is not enough history yet to call a trend.');
  return finish(scopeText(F), L, act);
}

function genMain(id) {
  const M = window.MD;
  if (!M) return null;
  const F = (M.filters && M.filters(id)) || {};
  switch (id) {
    case 'kpiCard': return kpiHist(M.kpi(), F);
    case 'heatmapCard': return heatHist(M.hm(), F);
    case 'perfCard': return perfHist(M.perf(), F);
    case 'genderCard': return genderHist(M.gd(), F);
    case 'hardestCard': return hardestHist(M, F);
    case 'kpiTrendCard': return trendHist(M.kt(), F, 'status');
    case 'enrollTrendCard': return trendHist(M.et(), F, 'enroll');
  }
  return null;
}

/* ══════════════════════════════════════════════════════════════════════════
   PREDICTION DASHBOARD (/api/pred/*) — values are forecasts
   ══════════════════════════════════════════════════════════════════════════ */
const FC_NOTE = 'These are model forecasts, not recorded results; later semesters are less certain than the next one.';

function kpiPred(d, scope) {
  if (!d) return null;
  if (d.empty) return finish(scope, [`No students are forecast for ${d.term.label} with these filters.`]);
  const L = [], all = d.enrollment.all, reg = d.enrollment.regular.value, irr = d.enrollment.irregular.value;
  L.push(`For ${d.term.label}, the model forecasts ${n0(all.value)} students` +
    (all.prev != null ? `, ${all.value >= all.prev ? 'up' : 'down'} ${n0(Math.abs(all.value - all.prev))} (${n1(Math.abs(all.pct || 0))}%) from ${d.prev_term.label}, the last recorded semester.` : '.'));
  const t = reg + irr;
  if (t) L.push(`About ${pc(reg / t * 100)} (${n0(reg)}) are forecast to be regular and ${pc(irr / t * 100)} (${n0(irr)}) irregular.`);
  if (num(d.gwa.value) != null) {
    const dg = d.gwa.prev != null ? d.gwa.value - d.gwa.prev : null;
    L.push(`The forecast average GWA is ${n2(d.gwa.value)} (${gwaBand(d.gwa.value)})` + (dg ? `, ${dg < 0 ? 'better' : 'worse'} than the last recorded ${n2(d.gwa.prev)} by ${n2(Math.abs(dg))} points.` : '.'));
  }
  if (num(d.completion.value) != null) {
    const dc = d.completion.prev != null ? d.completion.value - d.completion.prev : null;
    L.push(`The forecast completion rate is ${pc(d.completion.value)}` + (dc ? `, ${dc > 0 ? 'up' : 'down'} ${n1(Math.abs(dc))} points from ${pc(d.completion.prev)}.` : '.'));
  }
  const st = Object.entries(d.statuses || {}).sort((a, b) => b[1].count - a[1].count);
  if (st.length) {
    const t0 = st[0];
    L.push(`${STATUS[t0[0]] || t0[0]} is forecast to be the largest concern with ${n0(t0[1].count)} students` + (num(t0[1].ratio) != null ? ` (${pc(t0[1].ratio)} of the forecast population)` : '') + '.');
    const mv = st.filter(([, v]) => num(v.ratio) != null && num(v.ratio_prev) != null).map(([k, v]) => ({ k, x: v.ratio - v.ratio_prev })).sort((a, b) => b.x - a.x);
    if (mv.length && Math.abs(mv[0].x) >= 0.1) L.push(`The status share expected to rise the most is ${STATUS[mv[0].k] || mv[0].k} (${mv[0].x >= 0 ? '+' : ''}${n1(mv[0].x)} points versus the last recorded semester).`);
  }
  const by = all.by_year || [];
  if (by.length) { const b = [...by].sort((a, c) => c.value - a.value)[0]; L.push(`${ylName(b.year_level)} is forecast to be the largest year level (${n0(b.value)} students, ${pc(b.share)}).`); }
  L.push(FC_NOTE);
  return finish(scope, L, 'use these projections to plan advising capacity and subject sections early, and re-check once the actual semester data is uploaded.');
}

function hardestPred(d, scope, F) {
  if (!d || !d.items) return null;
  const items = d.items;
  if (!items.length) return finish(scope, [`No subject with these filters is normally offered in ${d.target_term ? d.target_term.label : 'the next semester'}.`]);
  const isGrade = d.rank_by === 'grade', st = STATUS[d.metric] || d.metric || 'Failed';
  const L = [];
  const h = items[0];
  L.push(`For ${d.target_term.label}, ${h.title} (${h.code}, ${sh(h.course)}) is forecast to be the hardest: ` +
    (isGrade ? `an average grade of ${n2(h.avg_grade)}` : `a ${st} rate of ${pc(h.rate)}`) + ` among ${plural(h.students, 'student')} (about ${n0(h.affected)} affected).`);
  const worse = items.filter(i => (isGrade ? i.grade_change : i.rate_change) > 0).sort((a, b) => (isGrade ? b.grade_change - a.grade_change : b.rate_change - a.rate_change));
  if (worse.length) { const w = worse[0];
    L.push(`${worse.length} of ${items.length} subjects are forecast to be harder than their last recorded offering; the biggest jump is ${w.title} (${isGrade ? '+' + n2(w.grade_change) + ' grade points' : '+' + n1(w.rate_change) + ' points'}).`); }
  else L.push('None of the listed subjects is forecast to be harder than its last recorded offering.');
  const over = items.filter(i => num(i.avg_grade) != null && i.avg_grade > 3.0).length;
  if (over) L.push(`${over} listed subject${over === 1 ? ' is' : 's are'} forecast to average above 3.00, the passing line.`);
  const top5 = items.slice(0, 5), col = {};
  top5.forEach(i => { col[i.college] = (col[i.college] || 0) + 1; });
  const ce = Object.entries(col).sort((a, b) => b[1] - a[1])[0];
  if (ce) L.push((top5.length === 1 ? `${ce[0]} is the only subject listed, affecting about ${n0(top5[0].affected)} students.` : `${ce[0]} accounts for ${ce[1]} of the top ${top5.length} hardest subjects, and those ${top5.length} together affect about ${n0(sum(top5.map(i => i.affected)))} students.`));
  L.push(FC_NOTE);
  return finish(scope, L, `prepare tutoring or review sessions for ${h.title} and the other top subjects before the term starts.`);
}

function linePred(d, scope, kind) {
  if (!d || !d.datasets || !d.datasets.length || !d.labels) return null;
  const labels = d.labels, pred = d.predicted || [], n = labels.length;
  const lastRec = pred.lastIndexOf(false), firstPred = pred.indexOf(true);
  if (firstPred < 0) return finish(scope, ['The chart has no forecast points yet.']);
  const W = d.group_by === 'course' ? 'program' : 'college';
  const isGwa = kind === 'gwa';
  const f = v => isGwa ? n2(v) : n0(v);
  const noun = isGwa ? 'average GWA' : kind === 'status' ? `students with ${STATUS[d.metric] || d.metric}` : `${({ all: 'total', regular: 'regular', irregular: 'irregular' }[d.metric] || 'total')} enrollment`;
  const series = d.datasets.map(ds => {
    let b = null; for (let i = lastRec; i >= 0; i--) if (ds.data[i] != null) { b = ds.data[i]; break; }
    let e = null; for (let i = n - 1; i >= firstPred; i--) if (ds.data[i] != null) { e = ds.data[i]; break; }
    return { label: ds.label, b, e, x: (b != null && e != null) ? e - b : null };
  }).filter(s => s.x != null);
  const L = [];
  const lastLbl = lastRec >= 0 ? labels[lastRec] : 'the last recorded semester';
  L.push(`The forecast covers ${pred.filter(Boolean).length} semester${pred.filter(Boolean).length === 1 ? '' : 's'} after ${lastLbl}, up to ${labels[n - 1]}.`);
  if (!series.length) { L.push(FC_NOTE); return finish(scope, L); }
  if (!isGwa) {
    const tb = sum(series.map(s => s.b)), te = sum(series.map(s => s.e));
    L.push(`Combined ${noun} is forecast to go from ${n0(tb)} (${lastLbl}) to ${n0(te)} (${labels[n - 1]}), ${te >= tb ? '+' : ''}${n0(te - tb)}${tb ? ` (${pc((te - tb) / tb * 100)})` : ''}.`);
  }
  const srt = [...series].sort((a, b) => b.x - a.x), up = srt[0], dn = srt[srt.length - 1];
  if (isGwa) {
    L.push(`On the 1.00–5.00 scale a higher GWA is worse. ${sh(up.label)} is forecast to worsen the most (${f(up.b)} → ${f(up.e)}, ${up.x >= 0 ? '+' : ''}${n2(up.x)}) and ${sh(dn.label)} to improve the most (${f(dn.b)} → ${f(dn.e)}, ${n2(dn.x)}).`);
    const bad = series.filter(s => s.e > 3.0);
    L.push(bad.length ? `${bad.map(s => `${sh(s.label)} (${n2(s.e)})`).join(', ')} ${bad.length === 1 ? 'is' : 'are'} forecast above the 3.00 passing line.` : `Every ${W} is forecast to stay at or below 3.00.`);
  } else if (srt.length === 1) {
    L.push(`${sh(up.label)} is forecast to go from ${f(up.b)} to ${f(up.e)} (${up.x >= 0 ? '+' : ''}${n0(up.x)}) by ${labels[n - 1]}.`);
  } else {
    L.push(`${sh(up.label)} is forecast to change the most upward (${f(up.b)} → ${f(up.e)}, ${up.x >= 0 ? '+' : ''}${n0(up.x)}) and ${sh(dn.label)} the most downward (${f(dn.b)} → ${f(dn.e)}, ${dn.x >= 0 ? '+' : ''}${n0(dn.x)}).`);
    const big = [...series].sort((a, b) => b.e - a.e)[0];
    L.push(`${sh(big.label)} is forecast to have the largest count by ${labels[n - 1]} (${n0(big.e)}).`);
  }
  L.push(FC_NOTE);
  const act = isGwa ? `arrange advising or academic support for ${sh(up.label)} before the term begins.`
    : kind === 'status' ? `plan support for ${sh(up.label)}, where the count is forecast to rise the most.`
    : `use the projection to plan sections and faculty load, and revisit it when new actuals arrive.`;
  return finish(scope, L, act);
}

function genPred(id) {
  const P = window.PD;
  if (!P) return null;
  const scope = P.scope(id), F = (P.filters && P.filters(id)) || {};
  switch (id) {
    case 'kpiCard': return kpiPred(P.kpi(), scope);
    case 'hardestCard': return hardestPred(P.hs(), scope, F);
    case 'gwaCard': return linePred(P.gwa(), scope, 'gwa');
    case 'riskCard': return linePred(P.risk(), scope, 'status');
    case 'kpiTrendCard': return linePred(P.kpiTrend(), scope, 'status');
    case 'enrollTrendCard': return linePred(P.enrollTrend(), scope, 'enroll');
  }
  return null;
}

/* ── public API ──────────────────────────────────────────────────────────── */
window.InsightEngine = {
  generate(cardId, dash) {
    try { return dash === 'pred' ? genPred(cardId) : genMain(cardId); }
    catch (e) { console.warn('[InsightEngine]', e); return null; }
  },
};
})();