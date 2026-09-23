/* ==========================================================================
   global-filter.js
   --------------------------------------------------------------------------
   Drives the "Global Filters" bar shown below the title bar on the
   dashboard pages. It does NOT talk to the API itself — it simply mirrors
   the picked values into each card's own filter controls (which already
   know how to fetch/render) and then clicks each card's existing Apply
   button, so it works with maindash.js / prediction-dash.js as-is.

   Configure per page with a window.GLOBAL_FILTER_CONFIG object BEFORE this
   script runs:

   window.GLOBAL_FILTER_CONFIG = {
     fields: ['dept', 'course', 'yearLevel'],   // any of: year, sem, dept, course, yearLevel
     cards: [
       { dept: 'kpiDept', course: 'kpiCourse', yearLevel: 'kpiYearLevel',
         apply: 'kpiBtnApply', reset: 'kpiBtnReset' },
       // ...one entry per card, ids matching that card's own <select>/<button>
     ]
   };

   The global bar's own <select> elements must use ids "global" + Field,
   e.g. globalYear, globalSem, globalDept, globalCourse, globalYearLevel.
   ========================================================================== */
(function () {
  'use strict';

  var config = window.GLOBAL_FILTER_CONFIG;
  if (!config || !config.fields || !config.cards) return;

  var COURSE_REBUILD_DELAY_MS = 80; // let a card's own Dept→Course cascade run first

  function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

  function byId(id) { return id ? document.getElementById(id) : null; }

  var globalSelects = {};
  config.fields.forEach(function (field) {
    globalSelects[field] = byId('global' + capitalize(field));
  });

  var globalBar = document.getElementById('globalFilterBar');
  if (!globalBar) return;

  function setSelectValue(select, value) {
    if (!select) return;
    var hasOption = Array.prototype.some.call(select.options, function (o) { return o.value === value; });
    select.value = hasOption ? value : '';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function cloneOptions(sourceEl, targetEl) {
    if (!sourceEl || !targetEl || sourceEl.options.length <= 1) return;
    var current = targetEl.value;
    targetEl.innerHTML = sourceEl.innerHTML;
    var stillThere = Array.prototype.some.call(targetEl.options, function (o) { return o.value === current; });
    targetEl.value = stillThere ? current : '';
  }

  // Populate the global Department/Course pickers from the first configured
  // card once that card's own (usually server-driven) options are loaded,
  // and keep them in sync if that card's list changes later.
  var sourceCard = config.cards[0];
  ['year', 'sem', 'dept', 'course'].forEach(function (field) {
    if (config.fields.indexOf(field) === -1 || !sourceCard || !sourceCard[field]) return;
    var sourceEl = byId(sourceCard[field]);
    var targetEl = globalSelects[field];
    if (!sourceEl || !targetEl) return;
    var sync = function () { cloneOptions(sourceEl, targetEl); };
    sync();
    new MutationObserver(sync).observe(sourceEl, { childList: true });
  });

  function applyToAllCards() {
    config.cards.forEach(function (card) {
      // Fields that don't cascade can be set right away.
      ['year', 'sem', 'yearLevel'].forEach(function (field) {
        if (config.fields.indexOf(field) !== -1 && card[field]) {
          setSelectValue(byId(card[field]), globalSelects[field].value);
        }
      });

      // Department first (may repopulate that card's Course list)...
      var hasDept = config.fields.indexOf('dept') !== -1 && card.dept;
      if (hasDept) setSelectValue(byId(card.dept), globalSelects.dept.value);

      // ...then Course, once, after giving the card a moment to rebuild it.
      window.setTimeout(function () {
        if (config.fields.indexOf('course') !== -1 && card.course) {
          setSelectValue(byId(card.course), globalSelects.course.value);
        }
        var applyBtn = byId(card.apply);
        if (applyBtn) applyBtn.click();
      }, hasDept ? COURSE_REBUILD_DELAY_MS : 0);
    });
  }

  function resetAllCards() {
    config.fields.forEach(function (field) {
      if (globalSelects[field]) globalSelects[field].value = '';
    });
    config.cards.forEach(function (card) {
      var resetBtn = byId(card.reset);
      if (resetBtn) resetBtn.click();
    });
  }

  var btnApply = document.getElementById('globalBtnApply');
  if (btnApply) btnApply.addEventListener('click', applyToAllCards);

  var btnReset = document.getElementById('globalBtnReset');
  if (btnReset) btnReset.addEventListener('click', resetAllCards);
})();