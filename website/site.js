const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
function closeMenu() { menu?.setAttribute('aria-expanded', 'false'); navigation?.removeAttribute('data-open'); }
menu?.addEventListener('click', () => { const open = menu.getAttribute('aria-expanded') !== 'true'; menu.setAttribute('aria-expanded', String(open)); navigation?.setAttribute('data-open', String(open)); });
navigation?.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && menu?.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); } });
if (document.querySelector('.docs-layout')) {
  const button = document.createElement('button');
  button.className = 'docs-mobile-nav';
  button.textContent = 'On this page';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-controls', 'page-contents');
  const sidebar = document.querySelector('.docs-nav');
  sidebar.id = 'page-contents';
  sidebar.before(button);
}
const contents = document.querySelector('.docs-mobile-nav');
contents?.addEventListener('click', () => { const open = contents.getAttribute('aria-expanded') !== 'true'; contents.setAttribute('aria-expanded', String(open)); document.querySelector('.docs-nav')?.setAttribute('data-open', String(open)); });
