const toggleBtn = document.querySelector('#togglePassword');
const passwordInput = document.querySelector('#password');
const eyeOpen = document.querySelector('#eye-open');
const eyeClosed = document.querySelector('#eye-closed');

toggleBtn.addEventListener('click', function () {
    // 1. Toggle password visibility
    const isPassword = passwordInput.getAttribute('type') === 'password';
    passwordInput.setAttribute('type', isPassword ? 'text' : 'password');

    // 2. Toggle SVG icons
    eyeOpen.classList.toggle('hidden');
    eyeClosed.classList.toggle('hidden');
});
