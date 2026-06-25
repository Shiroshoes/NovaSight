document.addEventListener('DOMContentLoaded', function () {

    // ---------------- EDIT USER ----------------
    const editButtons  = document.querySelectorAll('.edit-btn');
    const editSection  = document.getElementById('editUserSection');
    const editForm     = document.getElementById('editUserForm');

    editButtons.forEach(button => {
        button.addEventListener('click', function () {
            const userId = this.getAttribute('data-user-id');
            editSection.classList.add('open');

            fetch(`/NovaSight/admin/get_user/${userId}`)
                .then(res => res.json())
                .then(data => {
                    document.getElementById('editUserId').value        = data.acaduser_id;
                    document.getElementById('editFirstName').value     = data.first_name;
                    document.getElementById('editLastName').value      = data.last_name;
                    document.getElementById('editMI').value            = data.mi || '';
                    document.getElementById('editAccount').value       = data.account;
                    document.getElementById('editRole').value          = data.role;
                    document.getElementById('editDateCreated').value   = data.date_created;

                    // Reset password field
                    const ep = document.getElementById('editPassword');
                    if (ep) { ep.value = ''; ep.type = 'password'; ep.style.borderColor = ''; ep.setCustomValidity(''); }

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
                            if (confirm("Deactivate this user? They will no longer be able to log in.")) {
                                fetch(`/NovaSight/admin/archive_user/${userId}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                                }).then(() => location.reload())
                                  .catch(err => console.error("Deactivate error:", err));
                            }
                        };
                    }

                    if (activateBtn) {
                        activateBtn.onclick = () => {
                            if (confirm("Restore / activate this user?")) {
                                fetch(`/NovaSight/admin/restore_user/${userId}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                                }).then(() => location.reload())
                                  .catch(err => console.error("Restore error:", err));
                            }
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
            editSection.classList.add('open');
            fetch(`/NovaSight/admin/get_user/${userId}`)
                .then(res => res.json())
                .then(data => {
                    document.getElementById('editUserId').value      = data.acaduser_id;
                    document.getElementById('editFirstName').value   = data.first_name;
                    document.getElementById('editLastName').value    = data.last_name;
                    document.getElementById('editMI').value          = data.mi || '';
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
                            if (confirm("Restore / activate this user?")) {
                                fetch(`/NovaSight/admin/restore_user/${userId}`, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                                }).then(() => location.reload())
                                  .catch(err => console.error("Restore error:", err));
                            }
                        };
                    }
                })
                .catch(err => console.error("Fetch error:", err));
        });
    });


    // ---------------- PASSWORD GENERATOR & JS VALIDATION ----------------
    const pwdInput    = document.getElementById('password_input');
    const generateBtn = document.getElementById('generatePasswordBtn');

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

    if (pwdInput) {
        // Live feedback as user types
        pwdInput.addEventListener('input', function () {
            // Switch back to password type after generate reveals it
            if (pwdInput.type === 'text') pwdInput.type = 'password';

            const msg = validatePassword(pwdInput.value);
            pwdInput.setCustomValidity(msg);

            // Visual border feedback
            if (msg) {
                pwdInput.style.borderColor = '#ff4d4d';
            } else {
                pwdInput.style.borderColor = '#2ecc71';
            }
        });
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
            pwdInput.type  = "text"; // Reveal so admin can copy
            pwdInput.setCustomValidity(''); // Clear any previous error
            pwdInput.style.borderColor = '#2ecc71'; // Show green border
        });
    }


    // ---------------- EDIT PASSWORD GENERATOR & VALIDATION ----------------
    const editPwdInput    = document.getElementById('editPassword');
    const generateEditBtn = document.getElementById('generateEditPasswordBtn');

    function validateEditPassword(value) {
        if (!value) return ''; // blank = keep current, that's OK
        if (value.length < 8 || value.length > 16) return 'Password must be 8–16 characters.';
        if (!/[A-Z]/.test(value))   return 'Password must include at least one uppercase letter.';
        if (!/[0-9]/.test(value))   return 'Password must include at least one number.';
        if (!/[!@#$%^&*()_+\-={}|:;"'<>?,./]/.test(value)) return 'Password must include at least one special character.';
        return '';
    }

    if (editPwdInput) {
        editPwdInput.addEventListener('input', function () {
            if (editPwdInput.type === 'text') editPwdInput.type = 'password';
            const msg = validateEditPassword(editPwdInput.value);
            editPwdInput.setCustomValidity(msg);
            if (editPwdInput.value === '') {
                editPwdInput.style.borderColor = '';
            } else if (msg) {
                editPwdInput.style.borderColor = '#ff4d4d';
            } else {
                editPwdInput.style.borderColor = '#2ecc71';
            }
        });
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
            } else {
                editPwdInput.setCustomValidity('');
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
            editPwdInput.type  = "text";
            editPwdInput.setCustomValidity('');
            editPwdInput.style.borderColor = '#2ecc71';
        });
    }


    const backUserBtn = document.getElementById('backuserbtn');
    if (backUserBtn) {
        backUserBtn.addEventListener('click', () => editSection.classList.remove('open'));
    }

    // ---------------- CLEAR EDIT FORM ----------------
    const clearEditBtn = document.getElementById('clearEditFormBtn');
    if (clearEditBtn) {
        clearEditBtn.addEventListener('click', () => editForm.reset());
    }

    // ---------------- ADD USER TOGGLE ----------------
    const plusBtn    = document.getElementById('plusToggle');
    const addSection = document.getElementById('addUserSection');
    if (plusBtn && addSection) {
        plusBtn.addEventListener('click', () => addSection.classList.toggle('open'));
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
            }
        });
    }
});