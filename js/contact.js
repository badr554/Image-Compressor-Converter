const contactForm = document.getElementById('contact-form');
const formSuccess = document.getElementById('form-success');
const submitButton = document.getElementById('form-submit');

contactForm?.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.textContent = 'Sending…';
  submitButton.disabled = true;

  try {
    const response = await fetch(contactForm.action, {
      method: 'POST',
      body: new FormData(contactForm),
      headers: { Accept: 'application/json' },
    });

    if (response.ok) {
      contactForm.style.display = 'none';
      formSuccess.style.display = 'block';
      return;
    }
  } catch {
    // Keep the user's text on this device and let them send it using their mail app.
  }

  submitButton.textContent = 'Send Message';
  submitButton.disabled = false;
  const message = document.getElementById('form-error');
  if (message) {
    message.textContent = 'The form is not connected yet. Please email contact@pixelsqueeze.com directly.';
    message.hidden = false;
  }
});
