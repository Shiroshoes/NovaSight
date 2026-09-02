document.addEventListener('DOMContentLoaded', () => {
    const pwToggle       = document.getElementById('pwToggle');
    const pwFields       = document.getElementById('pwFields');
    const passInput      = document.getElementById('passInput');
    const confirmPassInput = document.getElementById('confirmPassInput');
    const confirmPassMismatch = document.getElementById('confirmPassMismatch');
    const saveBtn        = document.getElementById('savePwBtn');
    const cancelBtn      = document.getElementById('cancelBtn');
    const togglePassword = document.getElementById('togglePassword');
    const eyeOpen        = document.getElementById('eye-open');
    const eyeClosed      = document.getElementById('eye-closed');
    const toggleConfirmPassword = document.getElementById('toggleConfirmPassword');
    const confirmEyeOpen        = document.getElementById('confirm-eye-open');
    const confirmEyeClosed      = document.getElementById('confirm-eye-closed');
    const fileInput      = document.getElementById('fileInput');
    const cameraInput    = document.getElementById('cameraInput');
    const avatarDisplay  = document.getElementById('avatarDisplay');
    const avatarPlusBtn  = document.getElementById('avatarPlusBtn');
    const avatarModal    = document.getElementById('avatarModal');
    const avatarModalPreview = document.getElementById('avatarModalPreview');
    const chooseDeviceBtn = document.getElementById('chooseDeviceBtn');
    const takePhotoBtn   = document.getElementById('takePhotoBtn');
    const avatarModalClose = document.getElementById('avatarModalClose');
    const avatarUploadError = document.getElementById('avatarUploadError');
    const pwStatusMsg    = document.getElementById('pwStatusMsg');

    // Live camera modal (real getUserMedia feed)
    const cameraModal      = document.getElementById('cameraModal');
    const cameraModalClose = document.getElementById('cameraModalClose');
    const cameraVideo      = document.getElementById('cameraVideo');
    const cameraCanvas     = document.getElementById('cameraCanvas');
    const captureBtn       = document.getElementById('captureBtn');

    // Confirmation modal (preview before actually uploading)
    const avatarConfirmModal = document.getElementById('avatarConfirmModal');
    const avatarConfirmImg   = document.getElementById('avatarConfirmImg');
    const confirmAvatarBtn   = document.getElementById('confirmAvatarBtn');
    const cancelAvatarBtn    = document.getElementById('cancelAvatarBtn');

    let pendingAvatarFile = null; // File/Blob chosen or captured, waiting on user confirmation
    let cameraStream      = null; // active getUserMedia stream, if the camera modal is open

    const ALLOWED_AVATAR_TYPES = ['image/jpeg', 'image/png'];
    const MAX_AVATAR_BYTES = 5 * 1024 * 1024; // keep in sync with config.AVATAR_MAX_SIZE_MB

    // ---------------- FLOATING PASSWORD STATUS MESSAGE ----------------
    let pwStatusTimeout;
    function showPwStatus(message, isSuccess) {
        if (!pwStatusMsg) return;
        clearTimeout(pwStatusTimeout);

        pwStatusMsg.textContent = message;
        pwStatusMsg.style.color = isSuccess ? '#1a7f37' : '#cc0000';
        pwStatusMsg.style.background = isSuccess ? '#e6f6ea' : '#fdecea';
        pwStatusMsg.style.display = 'block';
        pwStatusMsg.style.opacity = '1';

        pwStatusTimeout = setTimeout(() => {
            pwStatusMsg.style.opacity = '0';
            setTimeout(() => { pwStatusMsg.style.display = 'none'; }, 300);
        }, 3000);
    }

    // ---------------- PASSWORD RULE VALIDATION (matches admin page rules) ----------------
    function validatePassword(value) {
        if (!value) return 'Password cannot be empty.';
        if (value.length < 8 || value.length > 16) return 'Password must be 8–16 characters.';
        if (!/[A-Z]/.test(value)) return 'Password must include at least one uppercase letter.';
        if (!/[0-9]/.test(value)) return 'Password must include at least one number.';
        if (!/[!@#$%^&*()_+\-={}|:;"'<>?,./]/.test(value)) return 'Password must include at least one special character.';
        return '';
    }

    if (passInput) {
        passInput.addEventListener('input', () => {
            const msg = validatePassword(passInput.value);
            passInput.style.borderColor = passInput.value === '' ? '' : (msg ? '#ff4d4d' : '#2ecc71');
            checkPasswordsMatch();
        });
    }

    // ---------------- CONFIRM PASSWORD MATCH CHECK ----------------
    function checkPasswordsMatch() {
        if (!confirmPassInput || !confirmPassMismatch) return true;
        if (confirmPassInput.value === '') {
            confirmPassInput.style.borderColor = '';
            confirmPassMismatch.style.display = 'none';
            return true;
        }
        const matches = confirmPassInput.value === passInput.value;
        confirmPassInput.style.borderColor = matches ? '#2ecc71' : '#ff4d4d';
        confirmPassMismatch.style.display = matches ? 'none' : 'block';
        return matches;
    }

    if (confirmPassInput) {
        confirmPassInput.addEventListener('input', checkPasswordsMatch);
    }

    // ---------------- SHOW / HIDE PASSWORD FIELDS ----------------
    pwToggle.addEventListener('click', e => {
        e.preventDefault();
        pwFields.style.display = pwFields.style.display === 'none' ? 'block' : 'none';
    });

    // ---------------- CANCEL BUTTON ----------------
    cancelBtn.addEventListener('click', () => {
        pwFields.style.display = 'none';
        passInput.value = '';
        passInput.style.borderColor = '';
        if (confirmPassInput) {
            confirmPassInput.value = '';
            confirmPassInput.style.borderColor = '';
        }
        if (confirmPassMismatch) confirmPassMismatch.style.display = 'none';
    });

    // ---------------- EYE TOGGLE ----------------
    togglePassword.addEventListener('click', () => {
        if (passInput.type === 'password') {
            passInput.type = 'text';
            eyeOpen.classList.add('hidden');
            eyeClosed.classList.remove('hidden');
        } else {
            passInput.type = 'password';
            eyeOpen.classList.remove('hidden');
            eyeClosed.classList.add('hidden');
        }
    });

    if (toggleConfirmPassword && confirmPassInput) {
        toggleConfirmPassword.addEventListener('click', () => {
            if (confirmPassInput.type === 'password') {
                confirmPassInput.type = 'text';
                if (confirmEyeOpen) confirmEyeOpen.classList.add('hidden');
                if (confirmEyeClosed) confirmEyeClosed.classList.remove('hidden');
            } else {
                confirmPassInput.type = 'password';
                if (confirmEyeOpen) confirmEyeOpen.classList.remove('hidden');
                if (confirmEyeClosed) confirmEyeClosed.classList.add('hidden');
            }
        });
    }

    // ---------------- SAVE PASSWORD ----------------
    saveBtn.addEventListener('click', async () => {
        const password = passInput.value.trim();
        const validationMsg = validatePassword(password);
        if (validationMsg) {
            showPwStatus(validationMsg, false);
            passInput.style.borderColor = '#ff4d4d';
            return;
        }

        if (confirmPassInput) {
            const confirmPassword = confirmPassInput.value.trim();
            if (!confirmPassword) {
                showPwStatus('Please confirm your new password.', false);
                confirmPassInput.style.borderColor = '#ff4d4d';
                return;
            }
            if (confirmPassword !== password) {
                showPwStatus('Passwords do not match.', false);
                if (confirmPassMismatch) confirmPassMismatch.style.display = 'block';
                confirmPassInput.style.borderColor = '#ff4d4d';
                return;
            }
        }

        try {
            const res  = await fetch('/update-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (data.success) {
                showPwStatus('Password successfully changed', true);
                pwFields.style.display = 'none';
                passInput.value = '';
                passInput.style.borderColor = '';
                if (confirmPassInput) {
                    confirmPassInput.value = '';
                    confirmPassInput.style.borderColor = '';
                }
                if (confirmPassMismatch) confirmPassMismatch.style.display = 'none';
            } else {
                showPwStatus(data.message || 'Failed to update password', false);
            }
        } catch (err) {
            console.error(err);
            showPwStatus('Error updating password', false);
        }
    });

    // ---------------- AVATAR "+" MODAL (Choose from Gallery / Open Camera) ----------------
    // Mirrors the live #avatarDisplay (current photo or default icon,
    // including its --avatar-color/--avatar-icon-color) into the modal's
    // preview circle. Called on open so it's always current, even right
    // after a fresh upload.
    function syncAvatarModalPreview() {
        if (!avatarModalPreview || !avatarDisplay) return;
        avatarModalPreview.innerHTML = avatarDisplay.innerHTML;
        avatarModalPreview.style.cssText = avatarDisplay.style.cssText;
    }

    function openAvatarModal() {
        if (!avatarModal) return;
        syncAvatarModalPreview();
        avatarModal.style.display = 'flex';
        avatarPlusBtn.setAttribute('aria-expanded', 'true');
        document.addEventListener('keydown', handleEscape);
    }
    function closeAvatarModal() {
        if (!avatarModal) return;
        avatarModal.style.display = 'none';
        avatarPlusBtn.setAttribute('aria-expanded', 'false');
        document.removeEventListener('keydown', handleEscape);
    }
    function handleEscape(e) {
        if (e.key === 'Escape') closeAvatarModal();
    }

    if (avatarPlusBtn && avatarModal) {
        avatarPlusBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            openAvatarModal();
        });
    }
    if (avatarModalClose) {
        avatarModalClose.addEventListener('click', closeAvatarModal);
    }
    if (avatarModal) {
        // Click on the dark backdrop itself (not the card) closes the modal —
        // same behavior as tapping outside the Logout confirmation card.
        avatarModal.addEventListener('click', (e) => {
            if (e.target === avatarModal) closeAvatarModal();
        });
    }
    if (chooseDeviceBtn && fileInput) {
        chooseDeviceBtn.addEventListener('click', () => {
            closeAvatarModal();
            fileInput.click();
        });
    }
    if (takePhotoBtn) {
        takePhotoBtn.addEventListener('click', () => {
            closeAvatarModal();
            openCameraStream();
        });
    }

    // ---------------- AVATAR UPLOAD ERROR BANNER ----------------
    let avatarErrTimeout;
    function showAvatarError(message) {
        if (!avatarUploadError) { alert(message); return; }
        clearTimeout(avatarErrTimeout);
        avatarUploadError.textContent = message;
        avatarUploadError.style.display = 'block';
        avatarErrTimeout = setTimeout(() => { avatarUploadError.style.display = 'none'; }, 3500);
    }

    // ---------------- LIVE CAMERA (real device camera, not the OS picker) ----------------
    async function openCameraStream() {
        if (!cameraModal || !cameraVideo) return;
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            // No live-camera support in this browser/context (e.g. non-HTTPS) —
            // fall back to the OS's own camera capture via the hidden input.
            cameraInput.click();
            return;
        }
        try {
            cameraStream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: 'environment' },
                audio: false
            });
            cameraVideo.srcObject = cameraStream;
            cameraModal.style.display = 'flex';
            document.addEventListener('keydown', handleCameraEscape);
        } catch (err) {
            console.error(err);
            showAvatarError('Could not access the camera. Check your browser/device permissions.');
            cameraInput.click(); // fall back to native capture picker
        }
    }
    function stopCameraStream() {
        if (cameraStream) {
            cameraStream.getTracks().forEach(track => track.stop());
            cameraStream = null;
        }
        if (cameraVideo) cameraVideo.srcObject = null;
    }
    function closeCameraModal() {
        if (!cameraModal) return;
        stopCameraStream();
        cameraModal.style.display = 'none';
        document.removeEventListener('keydown', handleCameraEscape);
    }
    function handleCameraEscape(e) {
        if (e.key === 'Escape') closeCameraModal();
    }

    if (cameraModalClose) cameraModalClose.addEventListener('click', closeCameraModal);
    if (cameraModal) {
        cameraModal.addEventListener('click', (e) => {
            if (e.target === cameraModal) closeCameraModal();
        });
    }
    if (captureBtn) {
        captureBtn.addEventListener('click', () => {
            const w = cameraVideo.videoWidth;
            const h = cameraVideo.videoHeight;
            if (!w || !h) return;
            cameraCanvas.width = w;
            cameraCanvas.height = h;
            cameraCanvas.getContext('2d').drawImage(cameraVideo, 0, 0, w, h);
            cameraCanvas.toBlob(blob => {
                if (!blob) return;
                closeCameraModal();
                stageAvatarFile(new File([blob], 'camera-capture.jpg', { type: 'image/jpeg' }));
            }, 'image/jpeg', 0.92);
        });
    }
    // Fallback native-capture input — only reached if getUserMedia is
    // unsupported or the user denies camera permission above.
    if (cameraInput) {
        cameraInput.addEventListener('change', function () {
            stageAvatarFile(this.files[0]);
            this.value = '';
        });
    }

    // ---------------- STAGE A PICTURE (validate + preview, no upload yet) ----------------
    function stageAvatarFile(file) {
        if (!file) return;

        // Client-side gate: only JPEG/PNG, only up to the size cap.
        // This is a UX shortcut, not the real security boundary — the
        // server independently decodes and re-encodes the image before
        // trusting it, since a renamed file can lie about its extension
        // and even its Content-Type header.
        if (!ALLOWED_AVATAR_TYPES.includes(file.type)) {
            showAvatarError('Only JPEG or PNG images are allowed.');
            return;
        }
        if (file.size > MAX_AVATAR_BYTES) {
            showAvatarError('Image is too large (max 5MB).');
            return;
        }

        pendingAvatarFile = file;
        const reader = new FileReader();
        reader.onload = e => {
            if (avatarConfirmImg) avatarConfirmImg.src = e.target.result;
            openAvatarConfirmModal();
        };
        reader.readAsDataURL(file);
    }

    if (fileInput) {
        fileInput.addEventListener('change', function () {
            stageAvatarFile(this.files[0]);
            this.value = ''; // allow re-selecting the same file next time
        });
    }

    // ---------------- CONFIRMATION MODAL (Update Profile / No) ----------------
    function openAvatarConfirmModal() {
        if (!avatarConfirmModal) return;
        avatarConfirmModal.style.display = 'flex';
        document.addEventListener('keydown', handleConfirmEscape);
    }
    function closeAvatarConfirmModal() {
        if (!avatarConfirmModal) return;
        avatarConfirmModal.style.display = 'none';
        document.removeEventListener('keydown', handleConfirmEscape);
    }
    function handleConfirmEscape(e) {
        if (e.key === 'Escape') { pendingAvatarFile = null; closeAvatarConfirmModal(); }
    }
    if (avatarConfirmModal) {
        avatarConfirmModal.addEventListener('click', (e) => {
            if (e.target === avatarConfirmModal) { pendingAvatarFile = null; closeAvatarConfirmModal(); }
        });
    }
    if (cancelAvatarBtn) {
        cancelAvatarBtn.addEventListener('click', () => {
            pendingAvatarFile = null;
            closeAvatarConfirmModal();
        });
    }
    if (confirmAvatarBtn) {
        confirmAvatarBtn.addEventListener('click', async () => {
            if (!pendingAvatarFile) return;
            await uploadAvatarFile(pendingAvatarFile);
            pendingAvatarFile = null;
            closeAvatarConfirmModal();
        });
    }

    // ---------------- ACTUAL UPLOAD (only runs once the user confirms) ----------------
    // Each role blueprint (admin, deans, registrar, SASO, academic affairs)
    // has its own upload_image route. Pages set this via
    // data-upload-url="{{ url_for('<bp>.upload_image...') }}" on <body>;
    // if a page hasn't been updated with that attribute yet, fall back to
    // the original admin endpoint so nothing breaks.
    const uploadUrl = document.body.dataset.uploadUrl || '/NovaSight/admin/upload_image';

    async function uploadAvatarFile(file) {
        const formData = new FormData();
        formData.append('image', file);

        try {
            const res  = await fetch(uploadUrl, {
                method: 'POST',
                body: formData
            });
            const data = await res.json();

            if (res.ok && data.image_url) {
                // A full reload (rather than patching avatarDisplay's
                // innerHTML by hand) is what picks up the new picture
                // everywhere it's server-rendered — the header avatar
                // icon included, which the old manual patch never touched.
                window.location.reload();
            } else {
                showAvatarError(data.error || 'Upload failed');
            }
        } catch (err) {
            console.error(err);
            showAvatarError('Error uploading image');
        }
    }
});