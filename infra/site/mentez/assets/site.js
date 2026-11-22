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

// ---------- planos, pagamento e contato vindos do painel da Mentez ----------
// O HTML já traz uma versão pronta (para buscadores e caso a plataforma não responda); aqui ela é atualizada.
(() => {
  const API = 'https://app.mentez.com.br/api/site';
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const brl = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 });
  const BASE = ['Agenda, escala e lista de espera', 'Prontuário e documentos do CFP', 'Financeiro, Pix e recibos', 'Lembretes automáticos'];
  const SIGNUP = 'https://app.mentez.com.br/criar-conta';
  const join = (a) => (a.length > 1 ? `${a.slice(0, -1).join(', ')} e ${a[a.length - 1]}` : a[0] || '');

  function bullets(p, prev, labels) {
    const pros = p.maxPros === 1 ? '1 profissional' : `Até ${p.maxPros} profissionais`;
    const feats = (k) => [...new Set(k.map((x) => labels[x]).filter(Boolean))];
    if (prev && prev.features.every((f) => p.features.includes(f))) {
      const add = feats(p.features.filter((f) => !prev.features.includes(f)));
      return [pros, `Tudo do ${prev.name}`, ...add, ...(p.extraPro ? [`Profissional extra: R$ ${brl(p.extraPro)}/mês`] : [])];
    }
    return [pros, ...BASE, ...feats(p.features), ...(p.extraPro ? [`Profissional extra: R$ ${brl(p.extraPro)}/mês`] : [])];
  }
  function card(p, prev, labels, tag) {
    const hot = p.highlight;
    return `<article class="plan${hot ? ' hot' : ''}">${hot ? `<span class="tag">${esc(tag || 'Mais escolhido')}</span>` : ''}<h3>${esc(p.name)}</h3>${p.tagline ? `<p class="for">${esc(p.tagline)}</p>` : ''}
      <div class="price"><small>R$</small><b>${brl(p.price)}</b><small>/mês</small></div>
      <ul>${bullets(p, prev, labels).map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
      <a class="btn${hot ? '' : ' line'}" href="${SIGNUP}">Testar grátis</a></article>`;
  }
  function render(d) {
    const all = d.plans; if (!all?.length) return;
    const labels = d.labels || {};
    // página inicial: todos os planos visíveis
    document.querySelectorAll('[data-plans="todos"]').forEach((el) => {
      el.innerHTML = all.map((p, i) => card(p, all[i - 1], labels)).join(''); el.dataset.count = all.length;
    });
    // página de preços: por perfil
    ['individual', 'clinica'].forEach((aud) => document.querySelectorAll(`[data-plans="${aud}"]`).forEach((el) => {
      const list = all.filter((p) => p.audience === aud);
      if (!list.length) { el.innerHTML = `<p class="plan-foot">Em breve. Fale com a gente: <a href="mailto:${esc(d.contact)}">${esc(d.contact)}</a></p>`; return; }
      let html = list.map((p) => card(p, all[all.indexOf(p) - 1], labels, aud === 'clinica' ? 'Para equipes' : 'Mais escolhido')).join('');
      const grow = list.find((p) => p.extraPro);
      if (aud === 'clinica' && grow) html += `<article class="plan"><h3>A clínica cresceu?</h3><p class="for">O plano cresce junto, sem trocar de sistema.</p><div class="price"><small>+R$</small><b>${brl(grow.extraPro)}</b><small>/profissional</small></div><ul><li>Adicione profissionais quando precisar</li><li>Mesmos recursos para toda a equipe</li><li>Cada profissional com o próprio acesso</li><li>Sem taxa de implantação</li></ul><a class="btn line" href="${SIGNUP}">Começar pelo teste</a></article>`;
      el.innerHTML = html; el.dataset.count = (el.children.length || 1);
    }));
    // tabela comparativa
    document.querySelectorAll('[data-cmp]').forEach((tb) => {
      const Y = '<td class="y">●</td>'; const N = '<td class="n">—</td>';
      const head = `<tr><th scope="col">Recurso</th>${all.map((p) => `<th scope="col">${esc(p.name)}<br><small style="font-weight:500;opacity:.75">R$ ${brl(p.price)}</small></th>`).join('')}</tr>`;
      const row = (name, f) => `<tr><th scope="row">${esc(name)}</th>${all.map((p) => { const v = f(p); return v === true ? Y : v === false ? N : `<td>${esc(v)}</td>`; }).join('')}</tr>`;
      const grp = (t) => `<tr class="grp"><th colspan="${all.length + 1}" scope="rowgroup">${esc(t)}</th></tr>`;
      const keys = Object.keys(labels).filter((k, i, arr) => arr.findIndex((x) => labels[x] === labels[k]) === i);
      const body = [grp('Base'), row('Profissionais', (p) => (p.maxPros === 1 ? '1' : `até ${p.maxPros}${p.extraPro ? ` (+R$ ${brl(p.extraPro)} cada)` : ''}`)), row('Pacientes e sessões', () => 'ilimitados'),
        ...BASE.map((b) => row(b, () => true)), row('Exercícios e escalas', () => true), row('Cartão digital e link na bio', () => true),
        grp('Recursos por plano'), ...keys.map((k) => row(labels[k], (p) => p.features.includes(k) || (k === 'convenios' && p.features.includes('convenios_simples'))))].join('');
      const t = tb.closest('table'); t.tHead.innerHTML = head; tb.innerHTML = body; t.style.minWidth = `${Math.max(640, 200 + all.length * 140)}px`;
    });
    // forma de pagamento e contato
    const methods = join(d.payment?.methods || []);
    document.querySelectorAll('[data-pay-methods]').forEach((el) => { el.textContent = methods; });
    document.querySelectorAll('[data-pay-provider]').forEach((el) => { el.textContent = d.payment?.label || ''; });
    document.querySelectorAll('[data-trial]').forEach((el) => { el.textContent = d.trialDays; });
    if (d.contact) document.querySelectorAll('[data-contact]').forEach((a) => { a.textContent = d.contact; if (a.tagName === 'A') a.href = `mailto:${d.contact}`; });
  }
  if (!document.querySelector('[data-plans],[data-cmp],[data-pay-methods],[data-contact]')) return;
  fetch(API, { mode: 'cors', credentials: 'omit' }).then((r) => (r.ok ? r.json() : null)).then((d) => d && render(d)).catch(() => { /* fica a versão do HTML */ });
})();

// ---------- hero: vídeo de fundo (só em telas largas, com movimento permitido e sem economia de dados) ----------
(() => {
  const v = document.querySelector('.hero-video'); if (!v) return;
  const saveData = navigator.connection && (navigator.connection.saveData || /2g/.test(navigator.connection.effectiveType || ''));
  if (saveData || matchMedia('(prefers-reduced-motion: reduce)').matches || !matchMedia('(min-width: 760px)').matches) return;
  [['webm', 'video/webm'], ['mp4', 'video/mp4']].forEach(([k, t]) => { const s = document.createElement('source'); s.src = v.dataset[k]; s.type = t; v.appendChild(s); });
  v.load();
  v.addEventListener('canplay', () => { v.play().then(() => v.classList.add('on')).catch(() => {}); }, { once: true });
  // pausa quando o hero sai da tela (economiza bateria)
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { if (e.isIntersecting) v.play().catch(() => {}); else v.pause(); }).observe(v);
})();
