/* ==========================================================================
   college-lock.js — keep a Dean's dashboard on ONE college
   --------------------------------------------------------------------------
   Turn it on with   <body data-lock-college="CAHS">   and load it BEFORE
   maindash.js / prediction-dash.js.  With no data-lock-college it does
   nothing, so the same page files serve every other role unchanged.

   What it does
     • adds the college to every /api/dash/* and /api/pred/* request, so the
       charts can never ask for "all colleges"
     • trims the filter lists (meta) to that college and its courses
     • hides the Department / College filters (there is nothing to choose)

   IMPORTANT: this is only the user-interface half.  Anyone can still type an
   API URL into the browser, so the server MUST enforce the same limit — see
   college_scope.py (already applied to /api/pred/*; add the two lines shown
   in that file to your /api/dash/* routes).
   ========================================================================== */
(function () {
  'use strict';
  var LOCK = ((document.body && document.body.dataset.lockCollege) || window.NS_LOCK_COLLEGE || '').trim();
  if (!LOCK) return;
  window.NS_LOCK_COLLEGE = LOCK;

  var realFetch = window.fetch.bind(window);

  function trimMeta(json, isPred) {
    if (!json || typeof json !== 'object') return json;
    if (Array.isArray(json.departments)) {
      json.departments = json.departments.filter(function (d) {
        return (d && typeof d === 'object' ? d.name : d) === LOCK;
      });
    }
    if (!isPred && Array.isArray(json.courses)) {
      json.courses = json.courses.filter(function (c) { return c && c.dept === LOCK; });
    }
    json.scoped_to = LOCK;
    return json;
  }

  window.fetch = function (input, init) {
    var u;
    try { u = new URL(typeof input === 'string' ? input : (input && input.url) || String(input), window.location.origin); }
    catch (e) { return realFetch(input, init); }
    var isPred = u.pathname.indexOf('/api/pred/') === 0;
    var isDash = u.pathname.indexOf('/api/dash/') === 0;
    if (!isPred && !isDash) return realFetch(input, init);

    u.searchParams.set(isPred ? 'department' : 'dept', LOCK);          // overrides anything the page asked for
    return realFetch(u.toString(), init).then(function (res) {
      if (!res.ok || !/\/meta$/.test(u.pathname)) return res;
      return res.clone().json().then(function (j) {
        return new Response(JSON.stringify(trimMeta(j, isPred)), {
          status: res.status, statusText: res.statusText, headers: { 'Content-Type': 'application/json' }
        });
      }).catch(function () { return res; });
    });
  };

  function hideDeptFilters() {
    document.querySelectorAll('select[id$="Dept"], select#kpi-dept').forEach(function (sel) {
      var g = sel.closest('.gf-group') || sel.parentElement;
      if (g) g.style.display = 'none';
      sel.setAttribute('aria-hidden', 'true');
      sel.tabIndex = -1;
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', hideDeptFilters);
  else hideDeptFilters();
})();
