document.addEventListener('DOMContentLoaded', function() {
    const dashBtn = document.getElementById('dashboardToggle');
    const submenu = document.getElementById('dashboardSubmenu');

    dashBtn.addEventListener('click', function(e) {
        e.preventDefault(); // Prevents page jump
        submenu.classList.toggle('open'); // Shows/Hides the menu
    });
});

