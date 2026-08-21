document.addEventListener('DOMContentLoaded', function() {
    const dashBtn = document.getElementById('dashboardToggle');
    const submenu = document.getElementById('dashboardSubmenu');
    const chevronPath = document.getElementById('dashboardChevronPath');

    // "off" (closed) — chevron pointing down
    const CHEVRON_OFF = 'M12.53 16.28a.75.75 0 0 1-1.06 0l-7.5-7.5a.75.75 0 0 1 1.06-1.06L12 14.69l6.97-6.97a.75.75 0 1 1 1.06 1.06l-7.5 7.5Z';
    // "active" (open) — chevron pointing up
    const CHEVRON_ACTIVE = 'M11.47 7.72a.75.75 0 0 1 1.06 0l7.5 7.5a.75.75 0 1 1-1.06 1.06L12 9.31l-6.97 6.97a.75.75 0 0 1-1.06-1.06l7.5-7.5Z';

    // force it open on load
    submenu.classList.add('open');
    if (chevronPath) chevronPath.setAttribute('d', CHEVRON_ACTIVE);

    dashBtn.addEventListener('click', function(e) {
        e.preventDefault(); // Prevents page jump
        const isOpen = submenu.classList.toggle('open'); // Shows/Hides the menu
        if (chevronPath) chevronPath.setAttribute('d', isOpen ? CHEVRON_ACTIVE : CHEVRON_OFF);
    });
});