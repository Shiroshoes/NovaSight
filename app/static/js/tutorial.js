// ===== Tutorial modal open / close =====
const tutorialLink = document.getElementById('tutorialLink');
const tutorialModal = document.getElementById('tutorialModal');
const closeTutorialBtn = document.getElementById('closeTutorialBtn');

function showTutorialModal() {
  tutorialModal.style.display = 'flex'; // Use flex to center content
  const video = document.getElementById('tutorialVideo');
  if (video && video.getAttribute('src')) {
    video.play().catch(() => {
      /* Autoplay may be blocked until the user interacts with the player controls. */
    });
  }
}

function hideTutorialModal() {
  tutorialModal.style.display = 'none';

  const video = document.getElementById('tutorialVideo');
  if (video) {
    video.pause();
    video.currentTime = 0;
  }

  // Reset the scrubber UI back to 0 so it doesn't show stale progress
  // the next time the modal is opened.
  const seekBar = document.getElementById('tutorialSeekBar');
  const currentTimeLabel = document.getElementById('tutorialCurrentTime');
  if (seekBar) {
    seekBar.value = 0;
    seekBar.style.background = 'linear-gradient(to right, #800000 0%, #DCD6C9 0%)';
  }
  if (currentTimeLabel) currentTimeLabel.textContent = '0:00';

  // Clear any caption text left on screen
  const captionsOverlay = document.getElementById('tutorialCaptionsOverlay');
  if (captionsOverlay) {
    captionsOverlay.classList.remove('active');
    captionsOverlay.innerHTML = '';
  }

  // Close the settings popup so it doesn't reopen mid-panel next time
  const settingsMenu = document.getElementById('tutorialSettingsMenu');
  if (settingsMenu) settingsMenu.classList.add('hidden');
}

if (tutorialLink) tutorialLink.addEventListener('click', showTutorialModal);
if (closeTutorialBtn) closeTutorialBtn.addEventListener('click', hideTutorialModal);

// Close when clicking the dark overlay itself (not the card)
if (tutorialModal) {
  tutorialModal.addEventListener('click', (e) => {
    if (e.target === tutorialModal) hideTutorialModal();
  });
}

// ===== Accordion menu + video swapping =====
document.addEventListener('DOMContentLoaded', () => {
  const video = document.getElementById('tutorialVideo');
  const videoTitle = document.getElementById('tutorialVideoTitle');
  const menuList = document.getElementById('tutorialMenuList');
  const captionsTrack = document.getElementById('tutorialCaptionsTrack');
  const captionsOverlay = document.getElementById('tutorialCaptionsOverlay');

  if (!video || !menuList) return;

  const accordions = Array.from(menuList.querySelectorAll('.tutorial-accordion'));
  const allLinks = Array.from(menuList.querySelectorAll('.tutorial-video-link'));

  // --- Accordion open/close (single-open) ---
  accordions.forEach((acc) => {
    const header = acc.querySelector('.tutorial-accordion-header');
    const panel = acc.querySelector('.tutorial-accordion-panel');

    header.addEventListener('click', () => {
      const isOpen = panel.classList.contains('open');

      accordions.forEach((other) => {
        other.querySelector('.tutorial-accordion-header').classList.remove('active');
        other.querySelector('.tutorial-accordion-panel').classList.remove('open');
      });

      if (!isOpen) {
        header.classList.add('active');
        panel.classList.add('open');
      }
    });
  });

  // ===== Captions state (persists across topic changes) =====
  let captionsEnabled = false;

  // Renders the currently active cue(s) into our own overlay element
  // (YouTube-style: bold, semi-transparent boxes anchored near the bottom
  // of the player) instead of relying on the browser's native ::cue box,
  // whose size/position varies a lot across browsers.
  function renderActiveCues() {
    if (!captionsOverlay) return;

    if (!captionsEnabled || !captionsTrack || !captionsTrack.track) {
      captionsOverlay.classList.remove('active');
      captionsOverlay.innerHTML = '';
      return;
    }

    const activeCues = captionsTrack.track.activeCues;
    if (!activeCues || activeCues.length === 0) {
      captionsOverlay.classList.remove('active');
      captionsOverlay.innerHTML = '';
      return;
    }

    captionsOverlay.innerHTML = '';
    Array.from(activeCues).forEach((cue) => {
      const line = document.createElement('span');
      line.className = 'tutorial-caption-line';
      // getCueAsHTML keeps basic VTT markup (<i>, <b>, line breaks, etc.)
      if (typeof cue.getCueAsHTML === 'function') {
        line.appendChild(cue.getCueAsHTML());
      } else {
        line.textContent = cue.text;
      }
      captionsOverlay.appendChild(line);
    });
    captionsOverlay.classList.add('active');
  }

  function applyCaptionsState() {
    if (!captionsTrack || !captionsTrack.track) return;
    // Keep the track's mode at 'hidden' (never 'showing') so the browser
    // never paints its own native subtitle box — cues still fire
    // cuechange events while hidden, and we render them ourselves via
    // renderActiveCues() so styling/position matches the rest of the player.
    captionsTrack.track.mode = captionsEnabled ? 'hidden' : 'disabled';
    renderActiveCues();
  }

  // The TextTrack object stays the same for the lifetime of the <track>
  // element (only its cues change when we swap the src), so bind this once.
  if (captionsTrack && captionsTrack.track) {
    captionsTrack.track.addEventListener('cuechange', renderActiveCues);
  }

  // --- Selecting a topic swaps the video, title, and captions ---
  function selectLink(link) {
    allLinks.forEach((l) => l.classList.remove('active'));
    link.classList.add('active');

    const src = link.dataset.src;
    const title = link.dataset.title;
    const captions = link.dataset.captions;

    if (src && video.getAttribute('src') !== src) {
      video.setAttribute('src', src);
      video.load();
      if (captionsOverlay) {
        captionsOverlay.classList.remove('active');
        captionsOverlay.innerHTML = '';
      }
    }
    if (title) videoTitle.textContent = title;

    if (captionsTrack) {
      if (captions) {
        captionsTrack.setAttribute('src', captions);
      } else {
        captionsTrack.removeAttribute('src');
      }
      // Re-apply the on/off state once the browser has (re)loaded the track
      applyCaptionsState();
    }

    video.play().catch(() => {
      /* Autoplay may be blocked until the user interacts with the player controls. */
    });
  }

  allLinks.forEach((link) => {
    link.addEventListener('click', () => selectLink(link));
  });

  // Load the very first topic by default so the player isn't empty
  if (allLinks.length) {
    const firstAccordion = accordions[0];
    firstAccordion.querySelector('.tutorial-accordion-header').classList.add('active');
    firstAccordion.querySelector('.tutorial-accordion-panel').classList.add('open');
    allLinks[0].classList.add('active');
    const firstSrc = allLinks[0].dataset.src;
    const firstCaptions = allLinks[0].dataset.captions;
    if (firstSrc) video.setAttribute('src', firstSrc);
    if (captionsTrack && firstCaptions) captionsTrack.setAttribute('src', firstCaptions);
    videoTitle.textContent = allLinks[0].dataset.title || 'Tutorial: Select a topic';
  }

  // ===== Player controls =====
  const playPauseBtn = document.getElementById('tutorialPlayPauseBtn');
  const playIcon = document.getElementById('tutorialPlayIcon');
  const pauseIcon = document.getElementById('tutorialPauseIcon');
  const prevBtn = document.getElementById('tutorialPrevBtn');
  const nextBtn = document.getElementById('tutorialNextBtn');
  const muteBtn = document.getElementById('tutorialMuteBtn');
  const volumeOnIcon = document.getElementById('tutorialVolumeOnIcon');
  const volumeOffIcon = document.getElementById('tutorialVolumeOffIcon');
  const captionsBtn = document.getElementById('tutorialCaptionsBtn');
  const settingsBtn = document.getElementById('tutorialSettingsBtn');
  const seekBackIndicator = document.getElementById('tutorialSeekBackIndicator');
  const seekForwardIndicator = document.getElementById('tutorialSeekForwardIndicator');
  const seekBar = document.getElementById('tutorialSeekBar');
  const currentTimeLabel = document.getElementById('tutorialCurrentTime');
  const durationLabel = document.getElementById('tutorialDuration');

  // Play / Pause
  const centerFlash = document.getElementById('tutorialCenterFlash');
  const flashPlayIcon = document.getElementById('tutorialFlashPlayIcon');
  const flashPauseIcon = document.getElementById('tutorialFlashPauseIcon');

  function flashCenterIcon(isPlaying) {
    if (!centerFlash) return;
    if (flashPlayIcon) flashPlayIcon.classList.toggle('hidden', isPlaying);
    if (flashPauseIcon) flashPauseIcon.classList.toggle('hidden', !isPlaying);
    centerFlash.classList.remove('show');
    void centerFlash.offsetWidth; // restart animation on rapid repeat clicks
    centerFlash.classList.add('show');
    clearTimeout(centerFlash._hideTimeout);
    centerFlash._hideTimeout = setTimeout(() => centerFlash.classList.remove('show'), 500);
  }

  function togglePlayPause() {
    if (video.paused || video.ended) {
      video.play().catch(() => {});
      flashCenterIcon(true);
    } else {
      video.pause();
      flashCenterIcon(false);
    }
  }

  function updatePlayPauseIcon() {
    if (video.paused || video.ended) {
      playIcon.classList.remove('hidden');
      pauseIcon.classList.add('hidden');
    } else {
      playIcon.classList.add('hidden');
      pauseIcon.classList.remove('hidden');
    }
  }

  if (playPauseBtn) {
    playPauseBtn.addEventListener('click', togglePlayPause);
  }
  // Clicking the video itself also toggles play/pause, same as YouTube
  video.addEventListener('click', togglePlayPause);
  video.addEventListener('play', updatePlayPauseIcon);
  video.addEventListener('pause', updatePlayPauseIcon);
  video.addEventListener('ended', updatePlayPauseIcon);

  // ===== YouTube-style "+10 / -10" flash indicator =====
  function flashSeekIndicator(el) {
    if (!el) return;
    el.classList.remove('show');
    // Force reflow so the animation restarts even on rapid repeat clicks
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(el._hideTimeout);
    el._hideTimeout = setTimeout(() => el.classList.remove('show'), 650);
  }

  // Previous / Next: rewind or fast-forward the current video by 10 seconds
  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      video.currentTime = Math.max(0, video.currentTime - 10);
      flashSeekIndicator(seekBackIndicator);
    });
  }

  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const duration = isFinite(video.duration) ? video.duration : Infinity;
      video.currentTime = Math.min(duration, video.currentTime + 10);
      flashSeekIndicator(seekForwardIndicator);
    });
  }

  // Mute / Unmute + hover volume slider
  const volumeSlider = document.getElementById('tutorialVolumeSlider');
  let lastVolume = video.volume > 0 ? video.volume : 1;

  function updateVolumeUI() {
    const isMuted = video.muted || video.volume === 0;
    volumeOnIcon.classList.toggle('hidden', isMuted);
    volumeOffIcon.classList.toggle('hidden', !isMuted);
    if (volumeSlider) volumeSlider.value = isMuted ? 0 : Math.round(video.volume * 100);
  }

  if (muteBtn) {
    muteBtn.addEventListener('click', () => {
      if (video.muted || video.volume === 0) {
        video.muted = false;
        video.volume = lastVolume || 1;
      } else {
        lastVolume = video.volume || 1;
        video.muted = true;
      }
      updateVolumeUI();
    });
  }

  if (volumeSlider) {
    volumeSlider.addEventListener('input', () => {
      const v = Number(volumeSlider.value) / 100;
      video.volume = v;
      video.muted = v === 0;
      if (v > 0) lastVolume = v;
      updateVolumeUI();
    });
  }

  updateVolumeUI();

  // Captions on/off toggle — shared by the round CC button and the
  // Subtitles/CC row inside the settings popup so both stay in sync.
  const subtitlesToggleRow = document.getElementById('tutorialSubtitlesToggleRow');
  const subtitlesToggleSwitch = document.getElementById('tutorialSubtitlesToggleSwitch');

  function setCaptionsUI() {
    if (captionsBtn) {
      captionsBtn.classList.toggle('active', captionsEnabled);
      captionsBtn.setAttribute('aria-pressed', String(captionsEnabled));
    }
    if (subtitlesToggleSwitch) subtitlesToggleSwitch.classList.toggle('on', captionsEnabled);
    if (subtitlesToggleRow) subtitlesToggleRow.setAttribute('aria-pressed', String(captionsEnabled));
  }

  function toggleCaptions() {
    captionsEnabled = !captionsEnabled;
    applyCaptionsState();
    setCaptionsUI();
  }

  if (captionsBtn) {
    captionsBtn.setAttribute('aria-pressed', 'false');
    captionsBtn.addEventListener('click', toggleCaptions);
  }
  if (subtitlesToggleRow) {
    subtitlesToggleRow.addEventListener('click', toggleCaptions);
  }

  // ===== Settings popup: playback speed / quality / subtitles =====
  const settingsMenu = document.getElementById('tutorialSettingsMenu');
  const speedValueLabel = document.getElementById('tutorialSpeedValue');
  const qualityValueLabel = document.getElementById('tutorialQualityValue');
  const qualityOptionsContainer = document.getElementById('tutorialQualityOptions');

  if (settingsBtn && settingsMenu) {
    function openSettingsMenu() {
      buildQualityOptions();
      settingsMenu.classList.remove('hidden');
      settingsBtn.setAttribute('aria-expanded', 'true');
    }

    function closeSettingsMenu() {
      settingsMenu.classList.add('hidden');
      settingsBtn.setAttribute('aria-expanded', 'false');
      // Collapse any expanded row so the menu reopens fresh next time
      settingsMenu.querySelectorAll('.tutorial-settings-row.expanded').forEach((r) => r.classList.remove('expanded'));
      settingsMenu.querySelectorAll('.tutorial-settings-options.expanded').forEach((o) => o.classList.remove('expanded'));
    }

    settingsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (settingsMenu.classList.contains('hidden')) {
        openSettingsMenu();
      } else {
        closeSettingsMenu();
      }
    });

    // Rows that expand to show their options in place, right below them.
    // Only one row (speed or quality) can be expanded at a time — opening
    // one closes the other.
    const toggleRows = Array.from(settingsMenu.querySelectorAll('[data-toggle-section]'));
    toggleRows.forEach((row) => {
      const section = settingsMenu.querySelector(`.tutorial-settings-options[data-section="${row.dataset.toggleSection}"]`);
      row.addEventListener('click', () => {
        const isExpanded = row.classList.contains('expanded');

        // Collapse every other row/section first
        toggleRows.forEach((otherRow) => {
          if (otherRow === row) return;
          otherRow.classList.remove('expanded');
          const otherSection = settingsMenu.querySelector(`.tutorial-settings-options[data-section="${otherRow.dataset.toggleSection}"]`);
          if (otherSection) otherSection.classList.remove('expanded');
        });

        // Then toggle the clicked row
        row.classList.toggle('expanded', !isExpanded);
        if (section) section.classList.toggle('expanded', !isExpanded);
      });
    });

    // --- Playback speed ---
    const speedOptions = Array.from(settingsMenu.querySelectorAll('[data-speed]'));

    function speedLabel(rate) {
      return rate === 1 ? 'Normal' : `${rate}x`;
    }

    function markSelectedSpeed(rate) {
      speedOptions.forEach((opt) => {
        opt.classList.toggle('selected', parseFloat(opt.dataset.speed) === rate);
      });
    }

    speedOptions.forEach((opt) => {
      opt.addEventListener('click', () => {
        const rate = parseFloat(opt.dataset.speed);
        video.playbackRate = rate;
        if (speedValueLabel) speedValueLabel.textContent = speedLabel(rate);
        markSelectedSpeed(rate);
      });
    });
    markSelectedSpeed(video.playbackRate || 1);

    // --- Quality ---
    // Each topic can optionally provide real per-resolution files as JSON
    // in data-qualities on its .tutorial-video-link, e.g.
    //   data-qualities='{"720p":"video-720.mp4","360p":"video-360.mp4"}'
    // Without that attribute, these standard labels are shown but all
    // point at the same source file (there's only one file per topic
    // right now), so switching just relabels rather than changing quality.
    const DEFAULT_QUALITIES = ['720p', '360p', '240p', '144p'];

    // Suggests a resolution from the browser's Network Information API
    // (navigator.connection), when the browser exposes it. Falls back to
    // 720p when the API isn't available (e.g. Safari/Firefox).
    function suggestAutoQuality() {
      const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      const type = conn && conn.effectiveType;
      switch (type) {
        case 'slow-2g':
        case '2g':
          return '144p';
        case '3g':
          return '360p';
        case '4g':
        default:
          return '720p';
      }
    }

    function buildQualityOptions() {
      if (!qualityOptionsContainer) return;
      qualityOptionsContainer.innerHTML = '';

      const activeLink = allLinks.find((l) => l.classList.contains('active'));
      let qualities = null;
      if (activeLink && activeLink.dataset.qualities) {
        try {
          qualities = JSON.parse(activeLink.dataset.qualities);
        } catch (err) {
          qualities = null;
        }
      }

      const fallbackSrc = activeLink ? activeLink.dataset.src : null;
      const resolutionEntries = qualities
        ? Object.entries(qualities)
        : DEFAULT_QUALITIES.map((label) => [label, fallbackSrc]);

      const isAutoSelected = !qualityValueLabel || qualityValueLabel.textContent.indexOf('Auto') === 0;

      const autoBtn = document.createElement('button');
      autoBtn.type = 'button';
      autoBtn.className = 'tutorial-settings-option';
      autoBtn.textContent = 'Auto';
      if (isAutoSelected) autoBtn.classList.add('selected');
      autoBtn.addEventListener('click', () => {
        const picked = suggestAutoQuality();
        // Auto follows the network's suggested resolution when a matching
        // source is available; otherwise it just keeps the current file.
        const match = resolutionEntries.find(([label]) => label === picked);
        if (match && match[1] && match[1] !== video.getAttribute('src')) {
          switchQualitySource(match[1]);
        }
        if (qualityValueLabel) qualityValueLabel.textContent = `Auto (${picked})`;
        qualityOptionsContainer.querySelectorAll('.tutorial-settings-option').forEach((o) => {
          o.classList.toggle('selected', o === autoBtn);
        });
      });
      qualityOptionsContainer.appendChild(autoBtn);

      function switchQualitySource(src) {
        const resumeTime = video.currentTime;
        const wasPlaying = !video.paused;
        video.setAttribute('src', src);
        video.load();
        video.addEventListener('loadedmetadata', function resume() {
          video.currentTime = resumeTime;
          if (wasPlaying) video.play().catch(() => {});
          video.removeEventListener('loadedmetadata', resume);
        });
      }

      resolutionEntries.forEach(([label, src]) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tutorial-settings-option';
        btn.textContent = label;
        if (!isAutoSelected && qualityValueLabel && qualityValueLabel.textContent === label) {
          btn.classList.add('selected');
        }
        btn.addEventListener('click', () => {
          if (src && src !== video.getAttribute('src')) {
            switchQualitySource(src);
          }
          if (qualityValueLabel) qualityValueLabel.textContent = label;
          qualityOptionsContainer.querySelectorAll('.tutorial-settings-option').forEach((o) => {
            o.classList.toggle('selected', o === btn);
          });
        });
        qualityOptionsContainer.appendChild(btn);
      });
    }

    // Close on outside click / Escape
    document.addEventListener('click', (e) => {
      if (!settingsMenu.classList.contains('hidden') && !settingsMenu.contains(e.target) && e.target !== settingsBtn) {
        closeSettingsMenu();
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeSettingsMenu();
    });
  }

  // ===== YouTube-style scrubber / progress bar =====
  function formatTime(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '0:00';
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function paintSeekBarFill() {
    if (!seekBar) return;
    const max = Number(seekBar.max) || 100;
    const value = Number(seekBar.value) || 0;
    const percent = max ? (value / max) * 100 : 0;
    seekBar.style.background = `linear-gradient(to right, #800000 ${percent}%, #DCD6C9 ${percent}%)`;
  }

  let isScrubbing = false;

  if (seekBar) {
    video.addEventListener('loadedmetadata', () => {
      seekBar.max = isFinite(video.duration) ? video.duration : 0;
      durationLabel.textContent = formatTime(video.duration);
      seekBar.value = video.currentTime;
      paintSeekBarFill();
    });

    video.addEventListener('timeupdate', () => {
      if (isScrubbing) return;
      seekBar.value = video.currentTime;
      currentTimeLabel.textContent = formatTime(video.currentTime);
      paintSeekBarFill();
    });

    // Live-update the time label and fill while the user drags the thumb
    seekBar.addEventListener('input', () => {
      isScrubbing = true;
      currentTimeLabel.textContent = formatTime(Number(seekBar.value));
      paintSeekBarFill();
    });

    // Commit the seek once the user releases the thumb (or clicks a point)
    seekBar.addEventListener('change', () => {
      video.currentTime = Number(seekBar.value);
      isScrubbing = false;
    });
  }

  updatePlayPauseIcon();
  paintSeekBarFill();
});