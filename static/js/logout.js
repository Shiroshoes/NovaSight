// Get references to the elements
const logoutLink = document.getElementById('logoutLink');
const logoutModal = document.getElementById('logoutModal');
const confirmLogoutBtn = document.getElementById('confirmLogoutBtn');
const cancelLogoutBtn = document.getElementById('cancelLogoutBtn');

// Function to show the modal
function showLogoutModal() {
  logoutModal.style.display = 'flex'; // Use flex to center content
}

// Function to hide the modal
function hideLogoutModal() {
  logoutModal.style.display = 'none';
}

// Event listener for the logout link
logoutLink.addEventListener('click', function(event) {
  event.preventDefault(); // Prevent the default link behavior
  showLogoutModal();
});

// Event listener for the "Logout" button in the modal
confirmLogoutBtn.addEventListener('click', function() {
  // Instead of alert, redirect to the logout route
  window.location.href = '/logout';
});

// Event listener for the "Back" button in the modal
cancelLogoutBtn.addEventListener('click', function() {
  hideLogoutModal();
});

// Optional: Close modal if user clicks outside the card
logoutModal.addEventListener('click', function(event) {
  if (event.target === logoutModal) { // Check if the click was directly on the overlay
    hideLogoutModal();
  }
});