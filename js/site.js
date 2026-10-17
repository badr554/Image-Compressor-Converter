const themeToggle = document.getElementById('theme-toggle');
const menuButton = document.getElementById('mobile-menu-btn');
const siteNav = document.getElementById('site-nav');

document.documentElement.setAttribute('data-theme', localStorage.getItem('ps-theme') || 'light');

themeToggle?.addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  localStorage.setItem('ps-theme', next);
});

menuButton?.addEventListener('click', () => {
  const open = siteNav?.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});
