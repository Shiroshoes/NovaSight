document.addEventListener('DOMContentLoaded', () => {
    const pwToggle = document.getElementById('pwToggle');
    const pwFields = document.getElementById('pwFields');
    const passInput = document.getElementById('passInput');
    const saveBtn = document.getElementById('savePwBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const togglePassword = document.getElementById('togglePassword');
    const eyeOpen = document.getElementById('eye-open');
    const eyeClosed = document.getElementById('eye-closed');

    // Show/Hide password fields
    pwToggle.addEventListener('click', e => {
        e.preventDefault();
        pwFields.style.display = pwFields.style.display === 'none' ? 'block' : 'none';
    });

    // Cancel button
    cancelBtn.addEventListener('click', () => {
        pwFields.style.display = 'none';
        passInput.value = '';
    });

    // Eye toggle
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

    // Save password
    saveBtn.addEventListener('click', async () => {
        const password = passInput.value.trim();
        if (!password) {
            alert('Password cannot be empty');
            return;
        }

        try {
            const res = await fetch('/update-password', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({password})
            });
            const data = await res.json();
            if (data.success) {
                alert(data.message);
                pwFields.style.display = 'none';
                passInput.value = '';
            } else {
                alert(data.message);
            }
        } catch (err) {
            console.error(err);
            alert('Error updating password');
        }
    });
});

// ---------------- IMAGE UPLOAD ----------------
const fileInput = document.getElementById("fileInput");
const avatarDisplay = document.getElementById("avatarDisplay");

fileInput.addEventListener("change", async function () {
    const file = this.files[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("image", file);

    try {
        const res = await fetch("/NovaSight/admin/upload_image", {
            method: "POST",
            body: formData
        });

        const data = await res.json();

        if (data.image_url) {
            // Update UI
            avatarDisplay.innerHTML = `
                <img src="${data.image_url}" 
                     style="width:100%; height:100%; border-radius:50%; object-fit:cover;">
            `;
        } else {
            alert(data.error || "Upload failed");
        }
    } catch (err) {
        console.error(err);
        alert("Error uploading image");
    }
});