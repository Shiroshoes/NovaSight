document.addEventListener('DOMContentLoaded', function () {
    // ---------------- EDIT USER ----------------
    const editButtons = document.querySelectorAll('.edit-btn');
    const editSection = document.getElementById('editUserSection');
    const editForm = document.getElementById('editUserForm');

    editButtons.forEach(button => {
        button.addEventListener('click', function () {
            const userId = this.getAttribute('data-user-id');

            // Show form
            editSection.classList.add('open');

            // Fetch user data
            fetch(`/NovaSight/admin/get_user/${userId}`)
                .then(res => res.json())
                .then(data => {
                    document.getElementById('editUserId').value = data.acaduser_id;
                    document.getElementById('editUsername').value = data.username;
                    document.getElementById('editAccount').value = data.account;
                    document.getElementById('editRole').value = data.role;

                    // Set form action
                    editForm.action = `/NovaSight/admin/update_user/${userId}`;
                })
                .catch(err => console.error("Fetch error:", err));
        });
    });

    // ---------------- BACK BUTTON ----------------
    const backUserBtn = document.getElementById('backuserbtn');
    if (backUserBtn) {
        backUserBtn.addEventListener('click', () => {
            editSection.classList.remove('open');
        });
    }

    // ---------------- DELETE USER BUTTONS ----------------
    const deleteButtons = document.querySelectorAll('.delete-btn');
    deleteButtons.forEach(button => {
        button.addEventListener('click', function () {
            const userId = this.getAttribute('data-user-id');

            if (confirm("Are you sure you want to delete this user?")) {
                fetch(`/NovaSight/admin/delete_user/${userId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }).then(() => location.reload())
                  .catch(err => console.error("Delete error:", err));
            }
        });
    });

    // ---------------- DELETE FROM EDIT FORM ----------------
    const deleteEditBtn = document.getElementById('deleteUserBtn');
    if (deleteEditBtn) {
        deleteEditBtn.addEventListener('click', () => {
            const userId = document.getElementById('editUserId').value;

            if (!userId) {
                alert("No user selected.");
                return;
            }

            if (confirm("Are you sure you want to delete this user?")) {
                fetch(`/NovaSight/admin/delete_user/${userId}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded'
                    }
                }).then(() => location.reload())
                  .catch(err => console.error("Delete error:", err));
            }
        });
    }

    // ---------------- CLEAR EDIT FORM ----------------
    const clearEditBtn = document.getElementById('clearEditFormBtn');
    if (clearEditBtn) {
        clearEditBtn.addEventListener('click', () => editForm.reset());
    }

    // ---------------- ADD USER TOGGLE ----------------
    const plusBtn = document.getElementById('plusToggle');
    const addSection = document.getElementById('addUserSection');
    if (plusBtn && addSection) {
        plusBtn.addEventListener('click', () => addSection.classList.toggle('open'));
    }

    // ---------------- CLEAR ADD FORM ----------------
    const clearAddBtn = document.querySelector('#addUserSection .btn.grey');
    if (clearAddBtn) {
        clearAddBtn.addEventListener('click', () => {
            const addUserForm = document.querySelector('#addUserSection form');
            if (addUserForm) addUserForm.reset();
        });
    }
});