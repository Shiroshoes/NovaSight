// ===== Floating Page Tutorial Video Modal =====
// Reads data-video-src / data-video-title / data-video-key / data-tutorial-seen
// off #pageTutorialModal and auto-opens the FIRST time this user visits
// this page. "Seen" is tracked server-side (AcadUser.seen_tutorials) rather
// than in localStorage, since localStorage is per-browser and doesn't
// survive incognito windows, a cleared cache, or a different device/browser
// opening the same account. After the first watch, users can re-watch any
// tutorial via the "Tutorial" button on the Home page.
document.addEventListener('DOMContentLoaded', () => {
    const modal    = document.getElementById('pageTutorialModal');
    if (!modal) return;

    const video    = document.getElementById('pageTutorialVideo');
    const titleEl  = document.getElementById('pageTutorialTitle');
    const closeBtn = document.getElementById('closePageTutorialBtn');

    const src        = modal.dataset.videoSrc;
    const title      = modal.dataset.videoTitle;
    const key        = modal.dataset.videoKey || 'page';
    const alreadySeen = modal.dataset.tutorialSeen === 'true';

    if (titleEl) titleEl.textContent = title || 'Tutorial';
    if (video && src) video.setAttribute('src', src);

    function closeModal() {
        modal.style.display = 'none';
        if (video) {
            video.pause();
            video.currentTime = 0;
        }
    }

    function openModal() {
        modal.style.display = 'flex';
        if (video) {
            video.play().catch(() => {
                /* Autoplay may be blocked until the user interacts with the player. */
            });
        }
    }

    // Fire-and-forget: even if this fails (offline, etc.), the video still
    // played, which is what actually matters to the person watching it.
    function markSeenOnServer() {
        fetch('/mark_tutorial_seen', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key })
        }).catch(err => console.error('mark_tutorial_seen failed:', err));
    }

    if (closeBtn) closeBtn.addEventListener('click', closeModal);

    // Close when clicking the dark overlay itself (not the card)
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display !== 'none') closeModal();
    });

    if (!alreadySeen) {
        openModal();
        markSeenOnServer();
    }
});