document.addEventListener('DOMContentLoaded', function () {

    // ---------------- SELF-DEACTIVATION GUARD ----------------
    // An admin can never deactivate the account they are logged in with.
    // (The server route must enforce this too; this just hides the option.)
    const currentUserId = String(document.body.dataset.currentUserId || '');
    function isSelf(id) { return currentUserId !== '' && String(id) === currentUserId; }

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
        tip.className = 'admin-input-tip';
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

        ['password_input', 'confirm_password_input', 'editPassword', 'editConfirmPassword', 'resetPasswordInput'].forEach(function (id) { guard(document.getElementById(id), EMOJI, PW_MSG); });
        ['input[name="first_name"]', 'input[name="last_name"]'].forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (el) { guard(el, NAME_BAD, NAME_MSG); });
        });
        ['input[name="mi"]', 'input[name="suffix"]'].forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (el) { guard(el, EMAIL_BAD, SHORT_MSG); });
        });
        ['input[name="account"]:not([readonly])'].forEach(function (sel) {
            document.querySelectorAll(sel).forEach(function (el) { guard(el, EMAIL_BAD, EMAIL_MSG); });
        });
    })();

    // ---------------- PASSWORD EYE TOGGLE (shared helper) ----------------
    function wirePasswordToggle(toggleBtnId, inputId, eyeOpenId, eyeClosedId) {
        const toggleBtn = document.getElementById(toggleBtnId);
        const input     = document.getElementById(inputId);
        const eyeOpen   = document.getElementById(eyeOpenId);
        const eyeClosed = document.getElementById(eyeClosedId);
        if (!toggleBtn || !input || !eyeOpen || !eyeClosed) return null;

        function setRevealed(revealed) {
            input.type = revealed ? 'text' : 'password';
            eyeOpen.style.display   = revealed ? 'none' : '';
            eyeClosed.style.display = revealed ? '' : 'none';
        }

        toggleBtn.addEventListener('click', () => {
            setRevealed(input.type === 'password');
        });

        // Start hidden
        setRevealed(false);
        return setRevealed;
    }

    const setAddPasswordRevealed  = wirePasswordToggle('addTogglePassword', 'password_input', 'add-eye-open', 'add-eye-closed');
    const setEditPasswordRevealed = wirePasswordToggle('editTogglePassword', 'editPassword', 'edit-eye-open', 'edit-eye-closed');
    const setAddConfirmRevealed  = wirePasswordToggle('addToggleConfirmPassword', 'confirm_password_input', 'add-confirm-eye-open', 'add-confirm-eye-closed');
    const setEditConfirmRevealed = wirePasswordToggle('editToggleConfirmPassword', 'editConfirmPassword', 'edit-confirm-eye-open', 'edit-confirm-eye-closed');

    // ---------------- CUSTOM MODAL HELPERS ----------------
    function formatUserLabel(data) {
        const mi     = data.mi ? ` ${data.mi}.` : '';
        const suffix = data.suffix ? ` ${data.suffix}` : '';
        const name = `${data.first_name || ''}${mi} ${data.last_name || ''}${suffix}`.replace(/\s+/g, ' ').trim();
        const role = data.role || '';
        return `${name}${role ? ` — ${role}` : ''}`;
    }

    function showModal(overlay) {
        if (!overlay) return;
        overlay.style.display = 'flex';
        // Move focus into the dialog: the password box if there is one, otherwise
        // the safe (Back / No) button. Status toasts have neither, so nothing moves.
        const target = overlay.querySelector('input, .mbtn-ghost');
        if (target) setTimeout(() => target.focus({ preventScroll: true }), 40);
    }
    function hideModal(overlay) {
        if (overlay) overlay.style.display = 'none';
    }
    // Clicking the dark backdrop (not the card itself) closes the modal, like the logout modal.
    function wireOverlayOutsideClick(overlay) {
        if (!overlay) return;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) hideModal(overlay);
        });
    }

    // Esc closes the front-most open modal (same result as the X / Back button).
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        const open = Array.from(document.querySelectorAll('.modal-overlay'))
            .filter(o => getComputedStyle(o).display !== 'none');
        const top = open[open.length - 1];
        if (!top) return;
        const closeX = top.querySelector('.modal-close-x');
        if (closeX) closeX.click(); else hideModal(top);
    });

    // ---------------- DEACTIVATE CONFIRMATION MODAL ----------------
    const deactivateModal      = document.getElementById('deactivateModal');
    const confirmDeactivateBtn = document.getElementById('confirmDeactivateBtn');
    const cancelDeactivateBtn  = document.getElementById('cancelDeactivateBtn');
    const deactivateAccountInfo = document.getElementById('deactivateAccountInfo');
    wireOverlayOutsideClick(deactivateModal);

    let pendingDeactivateRequest = null;

    if (cancelDeactivateBtn) {
        cancelDeactivateBtn.addEventListener('click', () => {
            pendingDeactivateRequest = null;
            if (deactivateAccountInfo) deactivateAccountInfo.textContent = '';
            hideModal(deactivateModal);
        });
    }

    if (confirmDeactivateBtn) {
        confirmDeactivateBtn.addEventListener('click', () => {
            if (pendingDeactivateRequest) pendingDeactivateRequest();
            hideModal(deactivateModal);
        });
    }

    // ---------------- ACTIVATE CONFIRMATION MODAL ----------------
    const activateModal      = document.getElementById('activateModal');
    const confirmActivateBtn = document.getElementById('confirmActivateBtn');
    const cancelActivateBtn  = document.getElementById('cancelActivateBtn');
    const activateAccountInfo = document.getElementById('activateAccountInfo');
    wireOverlayOutsideClick(activateModal);

    let pendingActivateRequest = null;

    if (cancelActivateBtn) {
        cancelActivateBtn.addEventListener('click', () => {
            pendingActivateRequest = null;
            if (activateAccountInfo) activateAccountInfo.textContent = '';
            hideModal(activateModal);
        });
    }

    if (confirmActivateBtn) {
        confirmActivateBtn.addEventListener('click', () => {
            if (pendingActivateRequest) pendingActivateRequest();
            hideModal(activateModal);
        });
    }

    // ---------------- ACCOUNT CREATED / ERROR MODALS ----------------
    // Driven by the real flash() messages Flask set on the last request —
    // not a guess made before the form was even submitted. This is what
    // makes a failed submission (e.g. duplicate account) show the actual
    // reason instead of a false "Account successfully created!".
    const accountCreatedModal = document.getElementById('accountCreatedModal');
    const accountSuccessText  = document.getElementById('accountSuccessText');
    const accountErrorModal   = document.getElementById('accountErrorModal');
    const accountErrorText    = document.getElementById('accountErrorText');
    wireOverlayOutsideClick(accountCreatedModal);
    wireOverlayOutsideClick(accountErrorModal);

    const flashDataEl = document.getElementById('flashData');
    if (flashDataEl) {
        try {
            const messages = JSON.parse(flashDataEl.textContent || '[]');
            messages.forEach(([category, message]) => {
                if (category === 'success') {
                    if (accountSuccessText) accountSuccessText.textContent = message;
                    showModal(accountCreatedModal);
                    setTimeout(() => hideModal(accountCreatedModal), 3000);
                } else {
                    if (accountErrorText) accountErrorText.textContent = message;
                    showModal(accountErrorModal);
                    setTimeout(() => hideModal(accountErrorModal), 4000);
                }
            });
        } catch (err) {
            console.error("Flash message parse error:", err);
        }
    }

    // ---------------- EDIT USER ----------------
    const editButtons  = document.querySelectorAll('.edit-btn');
    const editSection  = document.getElementById('editUserSection');
    const editForm     = document.getElementById('editUserForm');

    // Save stays disabled until something is actually changed, so clicking it
    // with nothing edited is simply not possible (no pointless submit/reload,
    // no "nothing to save" alert needed either).
    const editSaveBtn = editForm ? editForm.querySelector('button[type="submit"]') : null;
    const EDIT_TRACKED_FIELDS = [
        'editFirstName', 'editLastName', 'editMI', 'editSuffix',
        'editRole', 'editPassword', 'editConfirmPassword',
    ];
    let editInitialSnapshot = null;

    function snapshotEditForm() {
        const snap = {};
        EDIT_TRACKED_FIELDS.forEach(id => {
            const el = document.getElementById(id);
            if (el) snap[id] = el.value;
        });
        editInitialSnapshot = snap;
    }

    function isEditFormDirty() {
        if (!editInitialSnapshot) return false;
        return EDIT_TRACKED_FIELDS.some(id => {
            const el = document.getElementById(id);
            return el && el.value !== editInitialSnapshot[id];
        });
    }

    function refreshEditSaveState() {
        if (editSaveBtn) editSaveBtn.disabled = !isEditFormDirty() || !editPasswordOk();
    }

    // One shared listener set (not re-attached per Edit click) — every open
    // just re-snapshots the freshly-loaded values and disables Save again.
    EDIT_TRACKED_FIELDS.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', refreshEditSaveState);
    });
    if (editForm) {
        const roleSelect = document.getElementById('editRole');
        if (roleSelect) roleSelect.addEventListener('change', refreshEditSaveState);
    }

    editButtons.forEach(button => {
        button.addEventListener('click', function () {
            const userId = this.getAttribute('data-user-id');

            // Toggle: clicking the same user's Edit button while the card is
            // already open for that user closes the card instead of re-opening it.
            const editUserIdField = document.getElementById('editUserId');
            if (editSection.classList.contains('open') && editUserIdField.value === userId) {
                editSection.classList.remove('open');
                return;
            }

            editSection.classList.add('open');

            fetch(`/NovaSight/admin/get_user/${userId}`)
                .then(res => res.json())
                .then(data => {
                    document.getElementById('editUserId').value        = data.acaduser_id;
                    document.getElementById('editFirstName').value     = data.first_name;
                    document.getElementById('editLastName').value      = data.last_name;
                    document.getElementById('editMI').value            = data.mi || '';
                    document.getElementById('editSuffix').value        = data.suffix || '';
                    document.getElementById('editAccount').value       = data.account;
                    document.getElementById('editRole').value          = data.role;
                    document.getElementById('editDateCreated').value   = data.date_created;

                    // Reset password fields, checklist and warnings
                    resetEditPasswordUI();

                    // Freshly loaded = the "unchanged" baseline — Save starts disabled.
                    snapshotEditForm();
                    refreshEditSaveState();

                    const deactivatedText = document.getElementById('editDeactivatedText');
                    const deactivateBtn   = document.getElementById('deactivateUserBtn');
                    const activateBtn     = document.getElementById('activateUserBtn');

                    if (data.is_archived) {
                        // Inactive user: show red text + Activate only
                        if (deactivatedText) deactivatedText.style.display = 'block';
                        if (deactivateBtn)   deactivateBtn.style.display   = 'none';
                        if (activateBtn)     activateBtn.style.display     = 'inline-block';
                    } else {
                        // Active user: hide red text + Activate; show Deactivate only
                        if (deactivatedText) deactivatedText.style.display = 'none';
                        if (deactivateBtn)   deactivateBtn.style.display   = isSelf(data.acaduser_id) ? 'none' : 'inline-block';
                        if (activateBtn)     activateBtn.style.display     = 'none';
                    }

                    // Own account: no Deactivate button, show a short note instead
                    const selfNote = document.getElementById('editSelfNote');
                    if (selfNote) selfNote.style.display = (!data.is_archived && isSelf(data.acaduser_id)) ? 'block' : 'none';

                    editForm.action = `/NovaSight/admin/update_user/${userId}`;

                    if (deactivateBtn) {
                        deactivateBtn.onclick = () => {
                            if (isSelf(data.acaduser_id)) return;
                            if (deactivateAccountInfo) deactivateAccountInfo.textContent = formatUserLabel(data);
                            pendingDeactivateRequest = () => {
                                fetch(`/NovaSight/admin/archive_user/${userId}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                                }).then(() => location.reload())
                                  .catch(err => console.error("Deactivate error:", err));
                            };
                            showModal(deactivateModal);
                        };
                    }

                    if (activateBtn) {
                        activateBtn.onclick = () => {
                            if (activateAccountInfo) activateAccountInfo.textContent = formatUserLabel(data);
                            pendingActivateRequest = () => {
                                fetch(`/NovaSight/admin/restore_user/${userId}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                                }).then(() => location.reload())
                                  .catch(err => console.error("Restore error:", err));
                            };
                            showModal(activateModal);
                        };
                    }
                })
                .catch(err => console.error("Fetch error:", err));
        });
    });

    // Archived-list edit buttons
    document.querySelectorAll('.edit-archived-btn').forEach(btn => {
        btn.classList.add('edit-btn');
        btn.addEventListener('click', function () {
            const userId = this.getAttribute('data-user-id');

            const editUserIdField = document.getElementById('editUserId');
            if (editSection.classList.contains('open') && editUserIdField.value === userId) {
                editSection.classList.remove('open');
                return;
            }

            editSection.classList.add('open');
            fetch(`/NovaSight/admin/get_user/${userId}`)
                .then(res => res.json())
                .then(data => {
                    document.getElementById('editUserId').value      = data.acaduser_id;
                    document.getElementById('editFirstName').value   = data.first_name;
                    document.getElementById('editLastName').value    = data.last_name;
                    document.getElementById('editMI').value          = data.mi || '';
                    document.getElementById('editSuffix').value      = data.suffix || '';
                    document.getElementById('editAccount').value     = data.account;
                    document.getElementById('editRole').value        = data.role;
                    document.getElementById('editDateCreated').value = data.date_created;
                    editForm.action = `/NovaSight/admin/update_user/${userId}`;
                    resetEditPasswordUI();

                    // Freshly loaded = the "unchanged" baseline — Save starts disabled.
                    snapshotEditForm();
                    refreshEditSaveState();

                    // Always archived — show red text + Activate only
                    const deactivatedText = document.getElementById('editDeactivatedText');
                    const deactivateBtn   = document.getElementById('deactivateUserBtn');
                    const activateBtn     = document.getElementById('activateUserBtn');
                    if (deactivatedText) deactivatedText.style.display = 'block';
                    if (deactivateBtn)   deactivateBtn.style.display   = 'none';
                    const selfNoteArchived = document.getElementById('editSelfNote');
                    if (selfNoteArchived) selfNoteArchived.style.display = 'none';
                    if (activateBtn) {
                        activateBtn.style.display = 'inline-block';
                        activateBtn.onclick = () => {
                            if (activateAccountInfo) activateAccountInfo.textContent = formatUserLabel(data);
                            pendingActivateRequest = () => {
                                fetch(`/NovaSight/admin/restore_user/${userId}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                                }).then(() => location.reload())
                                  .catch(err => console.error("Restore error:", err));
                            };
                            showModal(activateModal);
                        };
                    }
                })
                .catch(err => console.error("Fetch error:", err));
        });
    });


    // ---------------- PASSWORD RULES + LIVE CHECKLIST (shared by Add / Edit) ----------------
    // Same rules and same behaviour as the Profile page: every rule starts grey
    // and turns green the instant it is satisfied, so the admin sees what is
    // still missing while typing instead of finding out after pressing Save.
    const PW_SPECIAL_RE = /[!@#$%^&*()_+\-={}|:;"'<>?,./]/;
    const PW_RULES = [
        { key: 'length',  test: v => v.length >= 8 && v.length <= 16 },
        { key: 'upper',   test: v => /[A-Z]/.test(v) },
        { key: 'number',  test: v => /[0-9]/.test(v) },
        { key: 'special', test: v => PW_SPECIAL_RE.test(v) },
    ];
    const PW_CHECK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>';
    const PW_CROSS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';

    function updatePwChecklist(listEl, value) {
        if (!listEl) return;
        PW_RULES.forEach(rule => {
            const li = listEl.querySelector('[data-rule="' + rule.key + '"]');
            if (!li) return;
            const met = rule.test(value);
            li.classList.toggle('met', met);
            const icon = li.querySelector('.pw-req-icon');
            if (icon) icon.innerHTML = met ? PW_CHECK_ICON : PW_CROSS_ICON;
        });
    }

    function pwFormatError(value) {
        if (!value) return 'Password is required.';
        if (value.length < 8 || value.length > 16) return 'Password must be 8–16 characters.';
        if (!/[A-Z]/.test(value))   return 'Password must include at least one uppercase letter.';
        if (!/[0-9]/.test(value))   return 'Password must include at least one number.';
        if (!PW_SPECIAL_RE.test(value)) return 'Password must include at least one special character.';
        return ''; // valid
    }

    function generatePassword() {
        const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
        const lowercase = "abcdefghijklmnopqrstuvwxyz";
        const numbers   = "0123456789";
        const symbols   = "!@#$%^&*()_+";
        const allChars  = uppercase + lowercase + numbers + symbols;

        let password = "";
        // Guarantee one of each required category
        password += uppercase[Math.floor(Math.random() * uppercase.length)];
        password += lowercase[Math.floor(Math.random() * lowercase.length)];
        password += numbers[Math.floor(Math.random() * numbers.length)];
        password += symbols[Math.floor(Math.random() * symbols.length)];

        const targetLength = 12;
        for (let i = password.length; i < targetLength; i++) {
            password += allChars[Math.floor(Math.random() * allChars.length)];
        }
        return password.split('').sort(() => 0.5 - Math.random()).join('');
    }

    // ---------------- ADD USER: PASSWORD ----------------
    const pwdInput          = document.getElementById('password_input');
    const generateBtn       = document.getElementById('generatePasswordBtn');
    const confirmPwdInput   = document.getElementById('confirm_password_input');
    const addConfirmMismatch = document.getElementById('addConfirmMismatch');
    const addPwRequirements = document.getElementById('addPwRequirements');
    const addUserForm       = document.querySelector('#addUserSection form');
    const addSubmitBtn      = addUserForm ? addUserForm.querySelector('button[type="submit"]') : null;

    // Add stays greyed out until the password passes every rule and Confirm matches.
    function addPasswordOk() {
        if (!pwdInput) return true;
        const v = pwdInput.value;
        const confirmOk = !confirmPwdInput || (confirmPwdInput.value !== '' && confirmPwdInput.value === v);
        return !pwFormatError(v) && confirmOk;
    }
    function refreshAddSaveState() {
        if (addSubmitBtn) addSubmitBtn.disabled = !addPasswordOk();
    }

    function checkAddPasswordsMatch() {
        let matches = true;
        if (!confirmPwdInput || !pwdInput) {
            matches = true;
        } else if (confirmPwdInput.value === '') {
            confirmPwdInput.style.borderColor = '';
            confirmPwdInput.setCustomValidity('');
            if (addConfirmMismatch) addConfirmMismatch.style.display = 'none';
        } else {
            matches = confirmPwdInput.value === pwdInput.value;
            confirmPwdInput.style.borderColor = matches ? '#2ecc71' : '#ff4d4d';
            confirmPwdInput.setCustomValidity(matches ? '' : 'Passwords do not match.');
            if (addConfirmMismatch) addConfirmMismatch.style.display = matches ? 'none' : 'block';
        }
        refreshAddSaveState();
        return matches;
    }

    function resetAddPasswordUI() {
        if (pwdInput) {
            pwdInput.style.borderColor = '';
            pwdInput.setCustomValidity('');
            if (setAddPasswordRevealed) setAddPasswordRevealed(false);
        }
        if (confirmPwdInput) {
            confirmPwdInput.style.borderColor = '';
            confirmPwdInput.setCustomValidity('');
            if (setAddConfirmRevealed) setAddConfirmRevealed(false);
        }
        if (addConfirmMismatch) addConfirmMismatch.style.display = 'none';
        updatePwChecklist(addPwRequirements, pwdInput ? pwdInput.value : '');
        refreshAddSaveState();
    }

    if (pwdInput) {
        pwdInput.addEventListener('input', function () {
            const value = pwdInput.value;
            const msg = pwFormatError(value);
            pwdInput.setCustomValidity(msg);
            updatePwChecklist(addPwRequirements, value);
            pwdInput.style.borderColor = value === '' ? '' : (msg ? '#ff4d4d' : '#2ecc71');
            checkAddPasswordsMatch();   // also refreshes the Add button
        });
    }

    if (confirmPwdInput) {
        confirmPwdInput.addEventListener('input', checkAddPasswordsMatch);
    }

    // Intercept the Add User form submit and enforce validation before sending
    if (addUserForm && pwdInput) {
        addUserForm.addEventListener('submit', function (e) {
            // Re-sync type to password so value is accessible
            pwdInput.type = 'password';

            const msg = pwFormatError(pwdInput.value);
            if (msg) {
                e.preventDefault();
                pwdInput.setCustomValidity(msg);
                pwdInput.reportValidity();
                return;
            }
            pwdInput.setCustomValidity('');

            if (confirmPwdInput && !checkAddPasswordsMatch()) {
                e.preventDefault();
                confirmPwdInput.reportValidity();
                confirmPwdInput.focus();
                return;
            }
        });
    }

    if (generateBtn && pwdInput) {
        generateBtn.addEventListener('click', function () {
            const password = generatePassword();

            pwdInput.value = password;
            if (setAddPasswordRevealed) { setAddPasswordRevealed(true); } else { pwdInput.type = "text"; }
            pwdInput.setCustomValidity('');          // Clear any previous error
            pwdInput.style.borderColor = '#2ecc71';  // Show green border

            // Auto-fill + reveal the confirm field too — the admin didn't
            // type this one, so there's nothing for them to mistype.
            if (confirmPwdInput) {
                confirmPwdInput.value = password;
                confirmPwdInput.setCustomValidity('');
                confirmPwdInput.style.borderColor = '#2ecc71';
                if (setAddConfirmRevealed) setAddConfirmRevealed(true);
                if (addConfirmMismatch) addConfirmMismatch.style.display = 'none';
            }

            // Setting .value in JS doesn't fire 'input', so refresh by hand.
            updatePwChecklist(addPwRequirements, password);
            refreshAddSaveState();
        });
    }

    // Initial paint: every rule grey, Add disabled until the password is complete.
    resetAddPasswordUI();


    // ---------------- EDIT USER: PASSWORD ----------------
    const editPwdInput       = document.getElementById('editPassword');
    const generateEditBtn    = document.getElementById('generateEditPasswordBtn');
    const editConfirmPwdInput = document.getElementById('editConfirmPassword');
    const editConfirmMismatch = document.getElementById('editConfirmMismatch');
    const editPwRequirements = document.getElementById('editPwRequirements');
    const editPwSameAsCurrent = document.getElementById('editPwSameAsCurrent');

    const SAME_PW_MSG = 'This is the user\u2019s current password \u2014 please choose a new one.';

    function validateEditPassword(value) {
        if (!value) return ''; // blank = keep current, that's OK
        return pwFormatError(value);
    }

    // ---- "Same as current password" live check ----
    // The comparison can only happen on the server (the stored password is a hash).
    // Same idea as the Profile page: only asked once the new password already
    // passes every format rule, debounced, and a token drops stale responses.
    let editIsSameAsCurrent = false;
    let editReuseDebounce   = null;
    let editReuseToken      = 0;

    function applyEditSameAsCurrentUI() {
        if (editPwSameAsCurrent) editPwSameAsCurrent.style.display = editIsSameAsCurrent ? 'block' : 'none';
        if (editPwdInput) {
            editPwdInput.setCustomValidity(editIsSameAsCurrent ? SAME_PW_MSG : validateEditPassword(editPwdInput.value));
            if (editIsSameAsCurrent) editPwdInput.style.borderColor = '#ff4d4d';
        }
        refreshEditSaveState();
    }

    async function checkEditPasswordReuse(value) {
        const userId = (document.getElementById('editUserId') || {}).value;
        if (!userId) return;
        const myToken = ++editReuseToken;
        try {
            const res = await fetch(`/NovaSight/admin/check_password_reuse/${userId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: value }),
            });
            if (!res.ok) return;                       // server still enforces this on save
            const data = await res.json();
            if (myToken !== editReuseToken) return;    // a newer check superseded this one
            editIsSameAsCurrent = !!data.same;
            applyEditSameAsCurrentUI();
        } catch (err) {
            console.error('Password reuse check failed:', err);
        }
    }

    function scheduleEditReuseCheck() {
        // Never leave a stale warning up while the admin is still typing.
        editIsSameAsCurrent = false;
        editReuseToken++;                              // invalidate any in-flight check
        clearTimeout(editReuseDebounce);
        if (editPwSameAsCurrent) editPwSameAsCurrent.style.display = 'none';
        const v = editPwdInput ? editPwdInput.value : '';
        if (v !== '' && !validateEditPassword(v)) {
            editReuseDebounce = setTimeout(() => checkEditPasswordReuse(v), 400);
        }
    }

    // Blank password = "keep current", so a blank confirm field is fine too in
    // that case — the mismatch check only applies once a new password is typed.
    function checkEditPasswordsMatch() {
        let result;
        if (!editConfirmPwdInput || !editPwdInput) {
            result = true;
        } else if (editPwdInput.value === '' || editConfirmPwdInput.value === '') {
            editConfirmPwdInput.style.borderColor = '';
            editConfirmPwdInput.setCustomValidity('');
            if (editConfirmMismatch) editConfirmMismatch.style.display = 'none';
            result = editPwdInput.value === '';
        } else {
            const matches = editConfirmPwdInput.value === editPwdInput.value;
            editConfirmPwdInput.style.borderColor = matches ? '#2ecc71' : '#ff4d4d';
            editConfirmPwdInput.setCustomValidity(matches ? '' : 'Passwords do not match.');
            if (editConfirmMismatch) editConfirmMismatch.style.display = matches ? 'none' : 'block';
            result = matches;
        }
        refreshEditSaveState();
        return result;
    }

    // Password part of "can Save be pressed?" — blank is fine (keep current);
    // otherwise it must pass every rule, match Confirm and differ from the current one.
    function editPasswordOk() {
        if (!editPwdInput) return true;
        const v = editPwdInput.value;
        if (v === '') return true;
        const confirmOk = !editConfirmPwdInput || (editConfirmPwdInput.value !== '' && editConfirmPwdInput.value === v);
        return !validateEditPassword(v) && confirmOk && !editIsSameAsCurrent;
    }

    function resetEditPasswordUI() {
        clearTimeout(editReuseDebounce);
        editReuseToken++;
        editIsSameAsCurrent = false;
        if (editPwdInput) {
            editPwdInput.value = '';
            editPwdInput.style.borderColor = '';
            editPwdInput.setCustomValidity('');
            if (setEditPasswordRevealed) setEditPasswordRevealed(false);
        }
        if (editConfirmPwdInput) {
            editConfirmPwdInput.value = '';
            editConfirmPwdInput.style.borderColor = '';
            editConfirmPwdInput.setCustomValidity('');
            if (setEditConfirmRevealed) setEditConfirmRevealed(false);
        }
        if (editConfirmMismatch) editConfirmMismatch.style.display = 'none';
        if (editPwSameAsCurrent) editPwSameAsCurrent.style.display = 'none';
        updatePwChecklist(editPwRequirements, '');
    }

    if (editPwdInput) {
        editPwdInput.addEventListener('input', function () {
            const value = editPwdInput.value;
            const msg = validateEditPassword(value);
            editPwdInput.setCustomValidity(msg);
            updatePwChecklist(editPwRequirements, value);
            editPwdInput.style.borderColor = value === '' ? '' : (msg ? '#ff4d4d' : '#2ecc71');
            scheduleEditReuseCheck();
            checkEditPasswordsMatch();   // also refreshes the Save button
        });
    }

    if (editConfirmPwdInput) {
        editConfirmPwdInput.addEventListener('input', checkEditPasswordsMatch);
    }

    // Intercept edit form submit to enforce validation when a password is entered
    const editFormEl = document.getElementById('editUserForm');
    if (editFormEl && editPwdInput) {
        editFormEl.addEventListener('submit', function (e) {
            const msg = validateEditPassword(editPwdInput.value);
            if (msg) {
                e.preventDefault();
                editPwdInput.setCustomValidity(msg);
                editPwdInput.reportValidity();
                return;
            }
            editPwdInput.setCustomValidity('');

            if (editPwdInput.value !== '') {
                if (editIsSameAsCurrent) {
                    e.preventDefault();
                    editPwdInput.setCustomValidity(SAME_PW_MSG);
                    editPwdInput.reportValidity();
                    return;
                }
                if (editConfirmPwdInput && editConfirmPwdInput.value === '') {
                    e.preventDefault();
                    editConfirmPwdInput.setCustomValidity('Please confirm the new password.');
                    editConfirmPwdInput.reportValidity();
                    return;
                }
                if (editConfirmPwdInput && !checkEditPasswordsMatch()) {
                    e.preventDefault();
                    editConfirmPwdInput.reportValidity();
                    return;
                }
            }
        });
    }

    if (generateEditBtn && editPwdInput) {
        generateEditBtn.addEventListener('click', function () {
            const password = generatePassword();
            editPwdInput.value = password;
            if (setEditPasswordRevealed) { setEditPasswordRevealed(true); } else { editPwdInput.type = "text"; }
            editPwdInput.setCustomValidity('');
            editPwdInput.style.borderColor = '#2ecc71';

            // Auto-fill + reveal the confirm field too, same reasoning as Add User.
            if (editConfirmPwdInput) {
                editConfirmPwdInput.value = password;
                editConfirmPwdInput.style.borderColor = '#2ecc71';
                editConfirmPwdInput.setCustomValidity('');
                if (setEditConfirmRevealed) setEditConfirmRevealed(true);
                if (editConfirmMismatch) editConfirmMismatch.style.display = 'none';
            }

            // Setting .value in JS doesn't fire 'input', so refresh by hand.
            updatePwChecklist(editPwRequirements, password);
            scheduleEditReuseCheck();
            refreshEditSaveState();
        });
    }

    // Initial paint: all rules grey.
    updatePwChecklist(editPwRequirements, '');


    const backUserBtn = document.getElementById('backuserbtn');
    if (backUserBtn) {
        backUserBtn.addEventListener('click', () => editSection.classList.remove('open'));
    }

    // ---------------- ADD USER TOGGLE ----------------
    const plusBtn    = document.getElementById('plusToggle');
    const addSection = document.getElementById('addUserSection');
    const plusIcon   = plusBtn ? plusBtn.querySelector('.plus-icon') : null;
    if (plusBtn && addSection) {
        plusBtn.addEventListener('click', () => {
            addSection.classList.toggle('open');
            if (plusIcon) plusIcon.classList.toggle('rotated', addSection.classList.contains('open'));
        });
    }

    // ---------------- CLEAR ADD FORM ----------------
    const clearAddBtn = document.querySelector('#addUserSection .btn.grey');
    if (clearAddBtn) {
        clearAddBtn.addEventListener('click', () => {
            if (addUserForm) {
                addUserForm.reset();
                resetAddPasswordUI();
            }
        });
    }

    // ---------------- RESET DATABASE MODAL ----------------
    const resetDbBtn       = document.getElementById('resetDbBtn');
    const resetDbModal     = document.getElementById('resetDbModal');
    const confirmResetBtn  = document.getElementById('confirmResetBtn');
    const cancelResetBtn   = document.getElementById('cancelResetBtn');
    const resetPasswordInput = document.getElementById('resetPasswordInput');
    const resetPwdError    = document.getElementById('resetPwdError');
    const resetPwdToggle   = document.getElementById('resetPwdToggle');
    const resetEyeOpen     = document.getElementById('resetEyeOpen');
    const resetEyeClosed   = document.getElementById('resetEyeClosed');
    const resetSuccessModal = document.getElementById('resetSuccessModal');
    const resetSuccessCloseBtn = document.getElementById('resetSuccessCloseBtn');
    const resetErrorModal  = document.getElementById('resetErrorModal');
    const resetErrorText   = document.getElementById('resetErrorText');

    // Shared dismiss path for the reset-success modal — used by the X
    // button, clicking the backdrop, AND the auto-close timer, so however
    // it closes, it closes exactly once (no double reload if the user
    // closes it manually right as the timer was about to fire).
    let resetSuccessTimer = null;
    function dismissResetSuccess() {
        if (resetSuccessTimer) { clearTimeout(resetSuccessTimer); resetSuccessTimer = null; }
        hideModal(resetSuccessModal);
        location.reload();
    }
    if (resetSuccessCloseBtn) resetSuccessCloseBtn.addEventListener('click', dismissResetSuccess);
    if (resetSuccessModal) {
        resetSuccessModal.addEventListener('click', (e) => {
            if (e.target === resetSuccessModal) dismissResetSuccess();
        });
    }

    // Password eye toggle inside the reset modal
    if (resetPwdToggle && resetPasswordInput) {
        resetPwdToggle.addEventListener('click', () => {
            const isHidden = resetPasswordInput.type === 'password';
            resetPasswordInput.type = isHidden ? 'text' : 'password';
            if (resetEyeOpen)   resetEyeOpen.style.display   = isHidden ? 'none' : '';
            if (resetEyeClosed) resetEyeClosed.style.display = isHidden ? '' : 'none';
        });
    }

    // Open reset modal
    if (resetDbBtn) {
        resetDbBtn.addEventListener('click', () => {
            if (resetPasswordInput) {
                resetPasswordInput.value = '';
                resetPasswordInput.type  = 'password';
                resetPasswordInput.style.borderColor = '';
            }
            if (resetEyeOpen)   resetEyeOpen.style.display   = '';
            if (resetEyeClosed) resetEyeClosed.style.display = 'none';
            if (resetPwdError)  { resetPwdError.textContent = ''; resetPwdError.style.display = 'none'; }
            showModal(resetDbModal);
        });
    }

    // Close on backdrop click
    wireOverlayOutsideClick(resetDbModal);

    // Cancel
    if (cancelResetBtn) {
        cancelResetBtn.addEventListener('click', () => hideModal(resetDbModal));
    }

    // Confirm — verify password then call API
    if (confirmResetBtn) {
        confirmResetBtn.addEventListener('click', async () => {
            const pwd = resetPasswordInput ? resetPasswordInput.value.trim() : '';
            if (!pwd) {
                if (resetPwdError) {
                    resetPwdError.textContent = 'Please enter your password.';
                    resetPwdError.style.display = 'block';
                }
                if (resetPasswordInput) resetPasswordInput.style.borderColor = '#ff4d4d';
                return;
            }

            confirmResetBtn.disabled = true;
            confirmResetBtn.textContent = 'Resetting…';
            if (resetPwdError) { resetPwdError.textContent = ''; resetPwdError.style.display = 'none'; }

            try {
                const res = await fetch('/api/reset-database', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ confirm: 'RESET', password: pwd }),
                });
                const data = await res.json();

                if (data.ok) {
                    hideModal(resetDbModal);
                    showModal(resetSuccessModal);
                    resetSuccessTimer = setTimeout(dismissResetSuccess, 2500);
                } else {
                    // Wrong password or other error — show inline
                    const msg = data.error || 'Reset failed. Please try again.';
                    if (resetPwdError) {
                        resetPwdError.textContent = msg;
                        resetPwdError.style.display = 'block';
                    }
                    if (resetPasswordInput) {
                        resetPasswordInput.style.borderColor = '#ff4d4d';
                        resetPasswordInput.value = '';
                        resetPasswordInput.focus();
                    }
                }
            } catch (err) {
                if (resetPwdError) {
                    resetPwdError.textContent = 'Network error. Please try again.';
                    resetPwdError.style.display = 'block';
                }
            } finally {
                confirmResetBtn.disabled = false;
                confirmResetBtn.textContent = 'Reset';
            }
        });
    }

    // Allow pressing Enter in the password field to trigger confirm
    if (resetPasswordInput) {
        resetPasswordInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && confirmResetBtn) confirmResetBtn.click();
        });
        // Clear error styling on new input
        resetPasswordInput.addEventListener('input', () => {
            resetPasswordInput.style.borderColor = '';
            if (resetPwdError) { resetPwdError.textContent = ''; resetPwdError.style.display = 'none'; }
        });
    }
});