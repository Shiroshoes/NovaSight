/* ═══════════════════════════════════════════════════════════════════════
   NSModal — shared floating dialogs (confirm + status toast).
   Needs #nsConfirmModal and #nsStatusModal in the page; pages without them
   simply skip the dialogs (available() === false) and keep the old behaviour.
     NSModal.confirm({tone, icon, title, text, changes, okText, cancelText}) -> Promise<boolean>
     NSModal.notify ({tone, icon, title, text, duration})                    -> Promise (resolves when closed)
   ═══════════════════════════════════════════════════════════════════════ */
window.NSModal = (function () {
    var S = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';
    var ICONS = {
        check: '<svg ' + S + '><path d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>',
        x:     '<svg ' + S + '><path d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/></svg>',
        user:  '<svg ' + S + '><path d="M17.982 18.725A7.488 7.488 0 0 0 12 15.75a7.488 7.488 0 0 0-5.982 2.975m11.963 0a9 9 0 1 0-11.963 0m11.963 0A8.966 8.966 0 0 1 12 21a8.966 8.966 0 0 1-5.982-2.275M15 9.75a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/></svg>',
        lock:  '<svg ' + S + '><path d="M16.5 10.5V6.75a4.5 4.5 0 1 0-9 0v3.75m-.75 11.25h10.5a2.25 2.25 0 0 0 2.25-2.25v-6.75a2.25 2.25 0 0 0-2.25-2.25H6.75a2.25 2.25 0 0 0-2.25 2.25v6.75a2.25 2.25 0 0 0 2.25 2.25Z"/></svg>',
        photo: '<svg ' + S + '><path d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909m-18 3.75h16.5a1.5 1.5 0 0 0 1.5-1.5V6a1.5 1.5 0 0 0-1.5-1.5H3.75A1.5 1.5 0 0 0 2.25 6v12a1.5 1.5 0 0 0 1.5 1.5Zm10.5-11.25h.008v.008h-.008V8.25Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"/></svg>'
    };
    var state = { confirmResolve: null, statusResolve: null, statusTimer: null, lastFocus: null, wired: false };
    function $(id) { return document.getElementById(id); }
    function shown(id) { var el = $(id); return !!el && el.style.display !== 'none'; }

    function available() { return !!($('nsConfirmModal') && $('nsStatusModal')); }
    function isOpen() { return shown('nsConfirmModal') || shown('nsStatusModal'); }

    function setLook(card, iconEl, tone, icon) {
        card.classList.remove('tone-brand', 'tone-danger', 'tone-success');
        card.classList.add('tone-' + (tone || 'brand'));
        iconEl.innerHTML = ICONS[icon] || ICONS.check;
    }

    function closeConfirm(result) {
        var ov = $('nsConfirmModal');
        if (ov) ov.style.display = 'none';
        var r = state.confirmResolve; state.confirmResolve = null;
        if (state.lastFocus && document.contains(state.lastFocus)) { try { state.lastFocus.focus({ preventScroll: true }); } catch (e) {} }
        if (r) r(!!result);
    }
    function closeStatus() {
        clearTimeout(state.statusTimer);
        var ov = $('nsStatusModal');
        if (ov) ov.style.display = 'none';
        var r = state.statusResolve; state.statusResolve = null;
        if (r) r();
    }

    function wire() {
        if (state.wired) return;
        state.wired = true;
        $('nsConfirmOk').addEventListener('click', function () { closeConfirm(true); });
        $('nsConfirmCancel').addEventListener('click', function () { closeConfirm(false); });
        $('nsConfirmModal').addEventListener('click', function (e) { if (e.target === this) closeConfirm(false); });
        $('nsStatusClose').addEventListener('click', closeStatus);
        $('nsStatusModal').addEventListener('click', function (e) { if (e.target === this) closeStatus(); });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            if (shown('nsConfirmModal')) { e.stopPropagation(); closeConfirm(false); }
            else if (shown('nsStatusModal')) closeStatus();
        }, true);
    }

    function confirm(opts) {
        opts = opts || {};
        if (!available()) return Promise.resolve(true);        // no dialog on this page: just proceed
        wire();
        if (state.confirmResolve) closeConfirm(false);
        var card = $('nsConfirmCard'), ok = $('nsConfirmOk'), cancel = $('nsConfirmCancel'), list = $('nsConfirmChanges');
        setLook(card, $('nsConfirmIcon'), opts.tone, opts.icon);
        $('nsConfirmTitle').textContent = opts.title || '';
        $('nsConfirmText').textContent  = opts.text  || '';

        list.innerHTML = '';
        (opts.changes || []).forEach(function (c) {
            var li = document.createElement('li');
            var label = document.createElement('span'); label.className = 'c-label'; label.textContent = c.label;
            var from  = document.createElement('span'); from.className  = 'c-from';  from.textContent  = c.from;
            var arrow = document.createElement('span'); arrow.className = 'c-arrow'; arrow.textContent = '\u2192'; arrow.setAttribute('aria-hidden', 'true');
            var to    = document.createElement('span'); to.className    = 'c-to';    to.textContent    = c.to;
            li.appendChild(label); li.appendChild(from); li.appendChild(arrow); li.appendChild(to);
            list.appendChild(li);
        });
        list.hidden = !(opts.changes && opts.changes.length);

        ok.textContent = opts.okText || 'Confirm';
        cancel.textContent = opts.cancelText || 'Cancel';
        ok.className = 'mbtn ' + (opts.tone === 'danger' ? 'mbtn-danger' : (opts.tone === 'success' ? 'mbtn-success' : 'mbtn-primary'));

        state.lastFocus = document.activeElement;
        $('nsConfirmModal').style.display = 'flex';
        setTimeout(function () { cancel.focus({ preventScroll: true }); }, 40);   // safe default: Cancel
        return new Promise(function (resolve) { state.confirmResolve = resolve; });
    }

    function notify(opts) {
        opts = opts || {};
        if (!available()) return Promise.resolve();
        wire();
        if (state.statusResolve) closeStatus();
        var card = $('nsStatusCard');
        setLook(card, $('nsStatusIcon'), opts.tone || 'success', opts.icon || (opts.tone === 'danger' ? 'x' : 'check'));
        $('nsStatusTitle').textContent = opts.title || '';
        $('nsStatusText').textContent  = opts.text  || '';

        var ms = opts.duration || 3000;
        var old = card.querySelector('.m-progress');           // fresh bar = countdown restarts
        var bar = document.createElement('span');
        bar.className = 'm-progress'; bar.setAttribute('aria-hidden', 'true');
        bar.style.setProperty('--m-dur', ms + 'ms');
        if (old) old.replaceWith(bar); else card.appendChild(bar);

        $('nsStatusModal').style.display = 'flex';
        state.statusTimer = setTimeout(closeStatus, ms);
        return new Promise(function (resolve) { state.statusResolve = resolve; });
    }

    return { available: available, isOpen: isOpen, confirm: confirm, notify: notify };
})();

document.addEventListener('DOMContentLoaded', () => {

    // ---------------- INPUT HYGIENE (client side only; the server must validate too) ----------------
    // Account / email-style fields: letters, numbers and . - @ only.
    // Name, MI and suffix fields: same set (plus a space in first/last names).
    // Password fields: every character is allowed except emoji.
    (function () {
        'use strict';
        var EMOJI     = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{1F3FB}-\u{1F3FF}\uFE0F\u200D\u20E3]/gu;
        var EMAIL_BAD = /[^A-Za-z0-9.\-@]/g;
        var NAME_BAD  = /[^A-Za-z0-9.\-@ ]/g;

        var tip = document.createElement('div');
        tip.setAttribute('role', 'status');
        tip.className = 'ns-input-tip';
        tip.style.cssText = 'position:fixed;z-index:99999;display:none;max-width:290px;padding:9px 13px;' +
                            'border-radius:12px;background:rgba(36,24,26,.96);color:#fff;font-size:12.5px;line-height:1.4;' +
                            'font-weight:500;pointer-events:none;border:1px solid rgba(255,255,255,.08);' +
                            'box-shadow:0 12px 28px -8px rgba(0,0,0,.45);';
        document.body.appendChild(tip);
        var tipTimer = null;
        function showTip(input, text) {
            var r = input.getBoundingClientRect();
            tip.textContent = text;
            tip.style.left = Math.max(8, r.left) + 'px';
            tip.style.top  = (r.bottom + 6) + 'px';
            tip.style.display = 'block';
            clearTimeout(tipTimer);
            tipTimer = setTimeout(function () { tip.style.display = 'none'; }, 3000);
        }

        function guard(input, badRe, message) {
            if (!input) return;
            function clean() {
                var before = input.value;
                var after  = before.replace(badRe, '');
                if (after !== before) { input.value = after; showTip(input, message); }
            }
            input.addEventListener('input', clean);
            input.addEventListener('blur', clean);
            if (input.form) input.form.addEventListener('submit', clean, true);
        }

        var EMAIL_MSG = 'Only letters, numbers and . - @ are allowed.';
        var NAME_MSG  = 'Only letters, numbers, spaces and . - @ are allowed.';
        var SHORT_MSG = 'Only letters, numbers and . - @ are allowed.';
        var PW_MSG    = 'Emoji are not allowed in the password.';

        ['passInput', 'confirmPassInput'].forEach(function (id) { guard(document.getElementById(id), EMOJI, PW_MSG); });
        ['#firstNameInput', '#lastNameInput'].forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (el) { guard(el, NAME_BAD, NAME_MSG); });
        });
        ['#miInput', '#suffixInput'].forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (el) { guard(el, EMAIL_BAD, SHORT_MSG); });
        });
        [].forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (el) { guard(el, EMAIL_BAD, EMAIL_MSG); });
        });
    })();
    const pwToggle       = document.getElementById('pwToggle');
    const pwFields       = document.getElementById('pwFields');
    const passInput      = document.getElementById('passInput');
    const confirmPassInput = document.getElementById('confirmPassInput');
    const confirmPassMismatch = document.getElementById('confirmPassMismatch');
    const pwRequirements = document.getElementById('pwRequirements');
    const pwSameAsCurrent = document.getElementById('pwSameAsCurrent');
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

    // ---------------- LIVE REQUIREMENTS CHECKLIST ----------------
    // Same rules as validatePassword(), broken out per-item so each line can
    // light up green independently as it's satisfied (matches the mockup).
    const PW_RULES = [
        { key: 'length',  test: v => v.length >= 8 && v.length <= 16 },
        { key: 'upper',   test: v => /[A-Z]/.test(v) },
        { key: 'number',  test: v => /[0-9]/.test(v) },
        { key: 'special', test: v => /[!@#$%^&*()_+\-={}|:;"'<>?,./]/.test(v) },
    ];
    const PW_CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';
    const PW_CROSS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    function updatePwRequirements(value) {
        if (!pwRequirements) return;
        PW_RULES.forEach(rule => {
            const li = pwRequirements.querySelector('[data-rule="' + rule.key + '"]');
            if (!li) return;
            const met = rule.test(value);
            li.classList.toggle('met', met);
            const icon = li.querySelector('.pw-req-icon');
            if (icon) icon.innerHTML = met ? PW_CHECK_ICON : PW_CROSS_ICON;
        });
    }

    // ---------------- LIVE "SAME AS CURRENT PASSWORD" CHECK ----------------
    // The hash comparison can only happen server-side, so this debounces a
    // small check to /check-password-reuse (same reuse check /update-password
    // already makes on submit — this just surfaces it immediately instead of
    // only after a full Save attempt). Only fires once the candidate already
    // passes every format rule, so a half-typed password never triggers a
    // request, and a request token guards against a stale response landing
    // after the user has kept typing.
    let isSameAsCurrent = false;
    let pwReuseDebounce = null;
    let pwReuseToken = 0;

    async function checkPasswordReuse(value) {
        const myToken = ++pwReuseToken;
        try {
            const res = await fetch('/check-password-reuse', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: value }),
            });
            const data = await res.json();
            if (myToken !== pwReuseToken) return;   // a newer check superseded this one
            isSameAsCurrent = !!data.same;
            if (pwSameAsCurrent) pwSameAsCurrent.style.display = isSameAsCurrent ? 'block' : 'none';
            if (isSameAsCurrent) passInput.style.borderColor = '#ff4d4d';
            refreshSaveButtonState();
        } catch (err) {
            console.error('Password reuse check failed:', err);
        }
    }

    // ---------------- SAVE BUTTON GATING ----------------
    // Disabled (greyed out, matches the mockup) until the new password is
    // non-empty, passes every rule, matches Confirm, and isn't flagged as
    // the current password.
    function refreshSaveButtonState() {
        if (!saveBtn || !passInput) return;
        const value = passInput.value;
        const formatOk = value !== '' && !validatePassword(value);
        const confirmOk = !confirmPassInput || (confirmPassInput.value !== '' && confirmPassInput.value === value);
        saveBtn.disabled = !(formatOk && confirmOk && !isSameAsCurrent);
    }

    if (passInput) {
        passInput.addEventListener('input', () => {
            const value = passInput.value;
            updatePwRequirements(value);
            const msg = validatePassword(value);
            passInput.style.borderColor = value === '' ? '' : (msg ? '#ff4d4d' : '#2ecc71');
            checkPasswordsMatch();

            // Never show a stale "this is your current password" warning
            // while the user is still typing — reset immediately, then
            // re-check (debounced) only once the format is actually valid.
            isSameAsCurrent = false;
            pwReuseToken++;   // invalidate any in-flight check right away
            if (pwSameAsCurrent) pwSameAsCurrent.style.display = 'none';
            clearTimeout(pwReuseDebounce);
            if (!msg && value !== '') {
                pwReuseDebounce = setTimeout(() => checkPasswordReuse(value), 400);
            }

            refreshSaveButtonState();
        });
    }

    // ---------------- CONFIRM PASSWORD MATCH CHECK ----------------
    function checkPasswordsMatch() {
        if (!confirmPassInput || !confirmPassMismatch) { refreshSaveButtonState(); return true; }
        if (confirmPassInput.value === '') {
            confirmPassInput.style.borderColor = '';
            confirmPassMismatch.style.display = 'none';
            refreshSaveButtonState();
            return true;
        }
        const matches = confirmPassInput.value === passInput.value;
        confirmPassInput.style.borderColor = matches ? '#2ecc71' : '#ff4d4d';
        confirmPassMismatch.style.display = matches ? 'none' : 'block';
        refreshSaveButtonState();
        return matches;
    }

    if (confirmPassInput) {
        confirmPassInput.addEventListener('input', checkPasswordsMatch);
    }

    // Initial paint: all requirements unmet (grey X), Save disabled —
    // matches the mockup's default state before anything has been typed.
    updatePwRequirements(passInput ? passInput.value : '');
    refreshSaveButtonState();

    // ---------------- SHOW / HIDE PASSWORD FIELDS ----------------
    // Pages whose #pwFields has class "pw-collapse" get the animated open/close
    // (class .is-open, see CSS); older markup falls back to display none/block.
    const pwAnimated = !!(pwFields && pwFields.classList.contains('pw-collapse'));
    function isPwOpen() {
        return pwAnimated ? pwFields.classList.contains('is-open') : pwFields.style.display !== 'none';
    }
    function setPwOpen(open) {
        if (pwAnimated) {
            pwFields.classList.toggle('is-open', open);
            pwFields.setAttribute('aria-hidden', String(!open));
            pwFields.inert = !open;
            if (open && passInput) setTimeout(() => passInput.focus({ preventScroll: true }), 380);
        } else {
            pwFields.style.display = open ? 'block' : 'none';
        }
        pwToggle.setAttribute('aria-expanded', String(open));
    }

    pwToggle.addEventListener('click', e => {
        e.preventDefault();
        setPwOpen(!isPwOpen());
        // Always open on a clean slate — checklist all-unmet, no stale
        // reuse warning, Save disabled — even if the fields still held a
        // leftover value from before (e.g. the panel was hidden without
        // Cancel/Save clearing it).
        updatePwRequirements(passInput.value);
        isSameAsCurrent = false;
        if (pwSameAsCurrent) pwSameAsCurrent.style.display = 'none';
        refreshSaveButtonState();
    });

    // ---------------- CANCEL BUTTON ----------------
    cancelBtn.addEventListener('click', () => {
        setPwOpen(false);
        passInput.value = '';
        passInput.style.borderColor = '';
        if (confirmPassInput) {
            confirmPassInput.value = '';
            confirmPassInput.style.borderColor = '';
        }
        if (confirmPassMismatch) confirmPassMismatch.style.display = 'none';
        isSameAsCurrent = false;
        pwReuseToken++;
        clearTimeout(pwReuseDebounce);
        if (pwSameAsCurrent) pwSameAsCurrent.style.display = 'none';
        updatePwRequirements('');
        refreshSaveButtonState();
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

        // Belt-and-braces: the button is already disabled whenever this is
        // true, but /update-password enforces the same rule server-side
        // regardless, so this is just avoiding a pointless round trip.
        if (isSameAsCurrent) {
            showPwStatus('This is your current password — please choose a new one.', false);
            if (pwSameAsCurrent) pwSameAsCurrent.style.display = 'block';
            passInput.style.borderColor = '#ff4d4d';
            return;
        }

        // Floating confirmation (Cancel = nothing is changed). Pages without the
        // dialog markup skip this and behave exactly as before.
        const useModals = !!(window.NSModal && NSModal.available());
        if (useModals) {
            const ok = await NSModal.confirm({
                tone: 'brand', icon: 'lock',
                title: 'Change password?',
                text: 'You will use your new password the next time you log in.',
                okText: 'Change password', cancelText: 'Cancel'
            });
            if (!ok) return;
        }

        const saveLabel = saveBtn.textContent;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving\u2026';

        try {
            const res  = await fetch('/update-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (data.success) {
                if (useModals) {
                    NSModal.notify({ tone: 'success', icon: 'lock', title: 'Password changed',
                                     text: 'Your password was updated successfully.', duration: 2600 });
                } else {
                    showPwStatus('Password successfully changed', true);
                }
                setPwOpen(false);
                passInput.value = '';
                passInput.style.borderColor = '';
                if (confirmPassInput) {
                    confirmPassInput.value = '';
                    confirmPassInput.style.borderColor = '';
                }
                if (confirmPassMismatch) confirmPassMismatch.style.display = 'none';
                isSameAsCurrent = false;
                pwReuseToken++;
                clearTimeout(pwReuseDebounce);
                if (pwSameAsCurrent) pwSameAsCurrent.style.display = 'none';
                updatePwRequirements('');
                refreshSaveButtonState();
            } else {
                const m = data.message || 'Failed to update password';
                if (useModals) NSModal.notify({ tone: 'danger', icon: 'x', title: 'Couldn\u2019t change password', text: m, duration: 4200 });
                else showPwStatus(m, false);
            }
        } catch (err) {
            console.error(err);
            if (useModals) NSModal.notify({ tone: 'danger', icon: 'x', title: 'Couldn\u2019t change password', text: 'Error updating password. Please try again.', duration: 4200 });
            else showPwStatus('Error updating password', false);
        } finally {
            saveBtn.textContent = saveLabel;
            refreshSaveButtonState();
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
        if (window.NSModal && NSModal.available()) {
            NSModal.notify({ tone: 'danger', icon: 'x', title: 'Couldn\u2019t update picture', text: message, duration: 4000 });
            return;
        }
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
            const file = pendingAvatarFile;
            pendingAvatarFile = null;
            closeAvatarConfirmModal();          // close first so the status dialog is never stacked behind it
            await uploadAvatarFile(file);
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
                if (window.NSModal && NSModal.available()) {
                    await NSModal.notify({ tone: 'success', icon: 'photo', title: 'Profile picture updated',
                                           text: 'Your new picture has been saved.', duration: 1500 });
                }
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