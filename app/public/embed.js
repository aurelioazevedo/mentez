// Agendamento exibido dentro do site (iframe): mantém o modo incorporado, abre links externos fora
// e informa ao site a altura do conteúdo (para a seção crescer sem barra de rolagem).
(() => {
  const add = (u) => { const x = new URL(u, location.href); if (x.origin === location.origin && x.pathname.startsWith('/agendar')) { x.searchParams.set('embed', '1'); return x.pathname + x.search + x.hash; } return null; };
  document.querySelectorAll('a[href]').forEach((a) => {
    const v = add(a.getAttribute('href'));
    if (v) a.setAttribute('href', v);
    else if (/^https?:/i.test(a.getAttribute('href'))) { a.target = '_blank'; a.rel = 'noopener'; }
  });
  document.querySelectorAll('form').forEach((f) => {
    if (f.querySelector('input[name=embed]')) return;
    const i = document.createElement('input'); i.type = 'hidden'; i.name = 'embed'; i.value = '1'; f.append(i);
  });
  let last = 0;
  const send = (extra = {}) => {
    const h = Math.ceil(document.documentElement.scrollHeight);
    if (h === last && !extra.nav) return;
    last = h;
    try { window.parent.postMessage({ type: 'lm-agendar', h, step: document.body.dataset.step || '', ...extra }, '*'); } catch (e) { /* sem site em volta */ }
  };
  send({ nav: true, path: location.pathname });
  window.addEventListener('load', () => send());
  if (window.ResizeObserver) new ResizeObserver(() => send()).observe(document.body);
  setTimeout(send, 600);
})();
