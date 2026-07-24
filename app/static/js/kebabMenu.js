/* =====================================================================
   KEBAB-MENU.JS
   Makes the 3-dot "kebab" button on the View Mode card actually open
   and close the Chart Mode / Table Mode menu.

   This was the missing piece: the HTML/CSS for #displayFormatKebabBtn
   and #displayFormatMenu already existed, and table-view.js already
   handles what happens once "Chart Mode" or "Table Mode" is picked —
   but nothing ever toggled the `.open` class on the menu, so clicking
   the button did nothing.

   The menu is moved to <body> and positioned with `position: fixed`
   coordinates computed from the kebab button's on-screen position.
   That's so it always floats fully ON TOP of the page — instead of
   being clipped or squeezed by the small "View Mode" card it lives
   next to — no matter what overflow/sizing rules that card's own CSS
   happens to have.

   Responsibilities of this file ONLY:
     - toggle the menu open/closed when the kebab button is clicked
     - keep the menu positioned under the button (even on resize/scroll)
     - close the menu when clicking anywhere outside it
     - close the menu when pressing Escape
     - close the menu after a menu item is picked (Chart/Table Mode)

   It does NOT decide what Chart Mode / Table Mode do — that logic
   stays in table-view.js. This file only owns show/hide/position of
   the menu itself.

   LOAD ORDER: can load any time after the DOM elements below exist
   (i.e. after the "View Mode" card markup). Order relative to
   chart-helpers.js / maindash.js / deandash.js / mode-toggle.js /
   table-view.js does not matter.

       <link rel="stylesheet" href=".../kebab-menu.css">
       ...
       <script src=".../kebab-menu.js"></script>
   ===================================================================== */

(function () {
    function initKebabMenu() {
        const kebabBtn = document.getElementById('displayFormatKebabBtn');
        const menu = document.getElementById('displayFormatMenu');
        if (!kebabBtn || !menu) return;

        // Pull the menu out of the mini card and onto <body>, so no
        // ancestor's overflow/height/stacking-context can ever clip it.
        // We re-anchor it visually under the button with fixed coords
        // in positionMenu() below instead.
        document.body.appendChild(menu);
        menu.style.position = 'fixed';
        menu.style.zIndex = '2000';

        function positionMenu() {
            const rect = kebabBtn.getBoundingClientRect();
            const menuWidth = menu.offsetWidth || 140;
            let left = rect.right - menuWidth;
            left = Math.max(8, Math.min(left, window.innerWidth - menuWidth - 8));
            menu.style.top = `${rect.bottom + 6}px`;
            menu.style.left = `${left}px`;
            menu.style.right = 'auto';
        }

        function openMenu() {
            positionMenu();
            menu.classList.add('open');
            kebabBtn.setAttribute('aria-expanded', 'true');
        }

        function closeMenu() {
            menu.classList.remove('open');
            kebabBtn.setAttribute('aria-expanded', 'false');
        }

        function isOpen() {
            return menu.classList.contains('open');
        }

        kebabBtn.setAttribute('aria-expanded', 'false');

        kebabBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            isOpen() ? closeMenu() : openMenu();
        });

        // Picking Chart Mode / Table Mode closes the menu. table-view.js
        // has its own click listeners on these same buttons for switching
        // the view — this listener just additionally closes the menu and
        // doesn't interfere with that.
        menu.addEventListener('click', (e) => {
            if (e.target.closest('.kebab-menu-item')) closeMenu();
        });

        // Click outside the menu/button closes it.
        document.addEventListener('click', (e) => {
            if (!isOpen()) return;
            if (menu.contains(e.target) || kebabBtn.contains(e.target)) return;
            closeMenu();
        });

        // Escape closes it.
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isOpen()) closeMenu();
        });

        // Keep it anchored under the button if the page resizes or
        // scrolls while it's open (capture:true so this catches scrolls
        // on inner scroll containers too, not just the window).
        window.addEventListener('resize', () => { if (isOpen()) positionMenu(); });
        window.addEventListener('scroll', () => { if (isOpen()) positionMenu(); }, true);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initKebabMenu);
    } else {
        initKebabMenu();
    }
})();