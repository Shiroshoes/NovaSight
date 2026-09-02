document.addEventListener('DOMContentLoaded', function () {

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
    wirePasswordToggle('addToggleConfirmPassword', 'confirm_password_input', 'add-confirm-eye-open', 'add-confirm-eye-closed');
    wirePasswordToggle('editToggleConfirmPassword', 'editConfirmPassword', 'edit-confirm-eye-open', 'edit-confirm-eye-closed');

    // ---------------- CUSTOM MODAL HELPERS ----------------
    function formatUserLabel(data) {
        const mi     = data.mi ? ` ${data.mi}.` : '';
        const suffix = data.suffix ? ` ${data.suffix}` : '';
        const name = `${data.first_name || ''}${mi} ${data.last_name || ''}${suffix}`.replace(/\s+/g, ' ').trim();
        const role = data.role || '';
        return `${name}${role ? ` — ${role}` : ''}`;
    }

    function showModal(overlay) {
        if (overlay) overlay.style.display = 'flex';
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

                    // Reset password field
                    const ep = document.getElementById('editPassword');
                    if (ep) { ep.value = ''; ep.style.borderColor = ''; ep.setCustomValidity(''); }
                    if (setEditPasswordRevealed) setEditPasswordRevealed(false);

                    const ecp = document.getElementById('editConfirmPassword');
                    const ecm = document.getElementById('editConfirmMismatch');
                    if (ecp) { ecp.value = ''; ecp.style.borderColor = ''; ecp.setCustomValidity(''); }
                    if (ecm) ecm.style.display = 'none';

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
                        if (deactivateBtn)   deactivateBtn.style.display   = 'inline-block';
                        if (activateBtn)     activateBtn.style.display     = 'none';
                    }

                    editForm.action = `/NovaSight/admin/update_user/${userId}`;

                    if (deactivateBtn) {
                        deactivateBtn.onclick = () => {
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

                    // Always archived — show red text + Activate only
                    const deactivatedText = document.getElementById('editDeactivatedText');
                    const deactivateBtn   = document.getElementById('deactivateUserBtn');
                    const activateBtn     = document.getElementById('activateUserBtn');
                    if (deactivatedText) deactivatedText.style.display = 'block';
                    if (deactivateBtn)   deactivateBtn.style.display   = 'none';
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


    // ---------------- PASSWORD GENERATOR & JS VALIDATION ----------------
    const pwdInput    = document.getElementById('password_input');
    const generateBtn = document.getElementById('generatePasswordBtn');
    const confirmPwdInput   = document.getElementById('confirm_password_input');
    const addConfirmMismatch = document.getElementById('addConfirmMismatch');

    // Regex: 8-16 chars, at least one uppercase, one digit, one special char
    const pwdRegex = /^(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#$%^&*()_+\-={}|:;"'<>?,./]).{8,16}$/;

    function validatePassword(value) {
        if (!value) return 'Password is required.';
        if (value.length < 8 || value.length > 16) return 'Password must be 8–16 characters.';
        if (!/[A-Z]/.test(value))   return 'Password must include at least one uppercase letter.';
        if (!/[0-9]/.test(value))   return 'Password must include at least one number.';
        if (!/[!@#$%^&*()_+\-={}|:;"'<>?,./]/.test(value)) return 'Password must include at least one special character.';
        return ''; // valid
    }

    function checkAddPasswordsMatch() {
        if (!confirmPwdInput || !pwdInput) return true;
        if (confirmPwdInput.value === '') {
            confirmPwdInput.style.borderColor = '';
            confirmPwdInput.setCustomValidity('');
            if (addConfirmMismatch) addConfirmMismatch.style.display = 'none';
            return true;
        }
        const matches = confirmPwdInput.value === pwdInput.value;
        confirmPwdInput.style.borderColor = matches ? '#2ecc71' : '#ff4d4d';
        confirmPwdInput.setCustomValidity(matches ? '' : 'Passwords do not match.');
        if (addConfirmMismatch) addConfirmMismatch.style.display = matches ? 'none' : 'block';
        return matches;
    }

    if (pwdInput) {
        // Live feedback as user types
        pwdInput.addEventListener('input', function () {
            const msg = validatePassword(pwdInput.value);
            pwdInput.setCustomValidity(msg);

            // Visual border feedback
            if (msg) {
                pwdInput.style.borderColor = '#ff4d4d';
            } else {
                pwdInput.style.borderColor = '#2ecc71';
            }
            checkAddPasswordsMatch();
        });
    }

    if (confirmPwdInput) {
        confirmPwdInput.addEventListener('input', checkAddPasswordsMatch);
    }

    // Intercept the Add User form submit and enforce validation before sending
    const addUserForm = document.querySelector('#addUserSection form');
    if (addUserForm && pwdInput) {
        addUserForm.addEventListener('submit', function (e) {
            // Re-sync type to password so value is accessible
            const currentType = pwdInput.type;
            pwdInput.type = 'password';

            const msg = validatePassword(pwdInput.value);
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
            password = password.split('').sort(() => 0.5 - Math.random()).join('');

            pwdInput.value = password;
            if (setAddPasswordRevealed) { setAddPasswordRevealed(true); } else { pwdInput.type = "text"; }
            pwdInput.setCustomValidity(''); // Clear any previous error
            pwdInput.style.borderColor = '#2ecc71'; // Show green border

            // Auto-fill + reveal the confirm field too — the admin didn't
            // type this one, so there's nothing for them to mistype.
            if (confirmPwdInput) {
                confirmPwdInput.value = password;
                confirmPwdInput.style.borderColor = '#2ecc71';
                if (addConfirmMismatch) addConfirmMismatch.style.display = 'none';
            }
        });
    }



    // ---------------- EDIT PASSWORD GENERATOR & VALIDATION ----------------
    const editPwdInput    = document.getElementById('editPassword');
    const generateEditBtn = document.getElementById('generateEditPasswordBtn');
    const editConfirmPwdInput = document.getElementById('editConfirmPassword');
    const editConfirmMismatch = document.getElementById('editConfirmMismatch');

    function validateEditPassword(value) {
        if (!value) return ''; // blank = keep current, that's OK
        if (value.length < 8 || value.length > 16) return 'Password must be 8–16 characters.';
        if (!/[A-Z]/.test(value))   return 'Password must include at least one uppercase letter.';
        if (!/[0-9]/.test(value))   return 'Password must include at least one number.';
        if (!/[!@#$%^&*()_+\-={}|:;"'<>?,./]/.test(value)) return 'Password must include at least one special character.';
        return '';
    }

    // Blank password = "keep current", so a blank confirm field is fine
    // too in that case — the mismatch check only applies once a new
    // password is actually being typed.
    function checkEditPasswordsMatch() {
        if (!editConfirmPwdInput || !editPwdInput) return true;
        if (editPwdInput.value === '' || editConfirmPwdInput.value === '') {
            editConfirmPwdInput.style.borderColor = '';
            editConfirmPwdInput.setCustomValidity('');
            if (editConfirmMismatch) editConfirmMismatch.style.display = 'none';
            return editPwdInput.value === '' ? true : false;
        }
        const matches = editConfirmPwdInput.value === editPwdInput.value;
        editConfirmPwdInput.style.borderColor = matches ? '#2ecc71' : '#ff4d4d';
        editConfirmPwdInput.setCustomValidity(matches ? '' : 'Passwords do not match.');
        if (editConfirmMismatch) editConfirmMismatch.style.display = matches ? 'none' : 'block';
        return matches;
    }

    if (editPwdInput) {
        editPwdInput.addEventListener('input', function () {
            const msg = validateEditPassword(editPwdInput.value);
            editPwdInput.setCustomValidity(msg);
            if (editPwdInput.value === '') {
                editPwdInput.style.borderColor = '';
            } else if (msg) {
                editPwdInput.style.borderColor = '#ff4d4d';
            } else {
                editPwdInput.style.borderColor = '#2ecc71';
            }
            checkEditPasswordsMatch();
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
            const uppercase = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
            const lowercase = "abcdefghijklmnopqrstuvwxyz";
            const numbers   = "0123456789";
            const symbols   = "!@#$%^&*()_+";
            const allChars  = uppercase + lowercase + numbers + symbols;
            let password = "";
            password += uppercase[Math.floor(Math.random() * uppercase.length)];
            password += lowercase[Math.floor(Math.random() * lowercase.length)];
            password += numbers[Math.floor(Math.random() * numbers.length)];
            password += symbols[Math.floor(Math.random() * symbols.length)];
            const targetLength = 12;
            for (let i = password.length; i < targetLength; i++) {
                password += allChars[Math.floor(Math.random() * allChars.length)];
            }
            password = password.split('').sort(() => 0.5 - Math.random()).join('');
            editPwdInput.value = password;
            if (setEditPasswordRevealed) { setEditPasswordRevealed(true); } else { editPwdInput.type = "text"; }
            editPwdInput.setCustomValidity('');
            editPwdInput.style.borderColor = '#2ecc71';

            // Auto-fill + reveal the confirm field too, same reasoning as
            // the Add User generator.
            if (editConfirmPwdInput) {
                editConfirmPwdInput.value = password;
                editConfirmPwdInput.style.borderColor = '#2ecc71';
                editConfirmPwdInput.setCustomValidity('');
                if (editConfirmMismatch) editConfirmMismatch.style.display = 'none';
            }
        });
    }


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
                if (pwdInput) {
                    pwdInput.style.borderColor = '';
                    pwdInput.setCustomValidity('');
                }
                if (confirmPwdInput) {
                    confirmPwdInput.style.borderColor = '';
                    confirmPwdInput.setCustomValidity('');
                }
                if (addConfirmMismatch) addConfirmMismatch.style.display = 'none';
            }
        });
    }
});