// Mentez — interações do site (sem dependências)
document.documentElement.classList.add('js');

// cabeçalho: borda ao rolar e menu no celular
const hdr = document.querySelector('.top');
const onScroll = () => hdr && hdr.classList.toggle('scrolled', window.scrollY > 8);
onScroll(); addEventListener('scroll', onScroll, { passive: true });
const burger = document.querySelector('.burger');
burger?.addEventListener('click', () => {
  const open = document.body.classList.toggle('menu-open');
  burger.setAttribute('aria-expanded', open ? 'true' : 'false');
});
document.querySelectorAll('.nav a').forEach((a) => a.addEventListener('click', () => document.body.classList.remove('menu-open')));

// vitrine com abas (setas do teclado navegam entre as abas)
document.querySelectorAll('[data-tabs]').forEach((box) => {
  const btns = [...box.querySelectorAll('[role="tab"]')];
  const show = (b, focus) => {
    btns.forEach((x) => { const on = x === b; x.setAttribute('aria-selected', on); x.tabIndex = on ? 0 : -1; document.getElementById(x.getAttribute('aria-controls'))?.classList.toggle('on', on); });
    if (focus) b.focus();
  };
  btns.forEach((b, i) => {
    b.addEventListener('click', () => show(b));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
      if (d) { e.preventDefault(); show(btns[(i + d + btns.length) % btns.length], true); }
    });
  });
});

// aparição ao rolar (uma vez), com pequena cascata nos grupos [data-stagger]
document.querySelectorAll('[data-stagger]').forEach((g) => [...g.children].forEach((c, i) => { c.classList.add('rv'); c.style.setProperty('--d', `${Math.min(i, 8) * 60}ms`); }));
const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 }) : null;
document.querySelectorAll('.rv').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));

// ano no rodapé
document.querySelectorAll('[data-year]').forEach((el) => { el.textContent = new Date().getFullYear(); });
