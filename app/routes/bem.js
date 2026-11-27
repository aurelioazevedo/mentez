// Bem-Estar Mental (bemestarmental.com.br): páginas públicas do diretório, cadastro grátis e edição do perfil.
import express from 'express';
import * as T from '../lib/tenancy.js';
import * as Dir from '../lib/directory.js';
import * as PlatComm from '../lib/platcomm.js';
import * as PlatPush from '../lib/platpush.js';
import * as Lead from '../lib/sitelead.js';
import { html, raw, esc, VERSION } from '../lib/html.js';

export const router = express.Router();
const parse = express.urlencoded({ extended: true, limit: '60kb', parameterLimit: 300 });
const ipOf = (req) => String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
const B = Dir.BRAND;
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const money = (n) => `R$ ${Number(n).toLocaleString('pt-BR')}`;
const priceTxt = (p) => (p.price_min && p.price_max && p.price_max !== p.price_min ? `${money(p.price_min)} a ${money(p.price_max)}` : p.price_min ? `A partir de ${money(p.price_min)}` : '');
const ICO = {
  pin: '<path d="M12 21s7-6.3 7-11a7 7 0 1 0-14 0c0 4.7 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>',
  video: '<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5 21 7.5v9l-5.5-3"/>',
  check: '<path d="M20 6 9 17l-5-5"/>', search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>', cal: '<rect x="3" y="4.5" width="18" height="17" rx="3"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/>',
  wa: '<path fill="currentColor" stroke="none" d="M12 2.5a9.5 9.5 0 0 0-8.2 14.3L2.5 21.5l4.8-1.3A9.5 9.5 0 1 0 12 2.5zm0 17.3c-1.5 0-3-.4-4.2-1.2l-.3-.2-2.8.8.8-2.8-.2-.3A7.8 7.8 0 1 1 12 19.8zm4.3-5.8c-.2-.1-1.4-.7-1.6-.8s-.4-.1-.5.1l-.7.9c-.1.2-.3.2-.5.1a6.4 6.4 0 0 1-3.2-2.8c-.2-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.7-1.8c-.2-.5-.4-.4-.5-.4h-.5a.9.9 0 0 0-.7.3 2.8 2.8 0 0 0-.9 2.1 4.9 4.9 0 0 0 1 2.6 11.2 11.2 0 0 0 4.3 3.8c1.6.7 2.2.7 3 .6.5-.1 1.4-.6 1.6-1.1s.2-1 .1-1.1l-.4-.2z"/>',
  site: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>',
};
const ico = (k, cls = 'i') => raw(`<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICO[k]}</svg>`);
const tierBadge = (t) => (t && t !== 'gratis' ? html`<span class="tier tier--${t}">${ico('star')}${Dir.TIERS[t].name}</span>` : '');
const photoUrl = (p) => (p.photo_v ? `/foto/${p.id}/${p.photo_v}.webp` : '');
const initials = (n) => String(n || '').replace(/^(dra?\.?|psic\.?)\s+/i, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const avatar = (p, cls = 'av') => (p.photo_v ? html`<img class="${cls}" src="${photoUrl(p)}" alt="Foto de ${p.name}" width="320" height="320" loading="lazy" decoding="async">` : html`<span class="${cls} av--ph" aria-hidden="true">${initials(p.name)}</span>`);
const where = (p) => [p.presencial && p.city ? `${p.city} - ${p.uf}` : '', p.online ? 'On-line' : ''].filter(Boolean).join(' · ');

function shell(req, { title, desc = '', body, canonical = null, noindex = false, ld = null, active = '' }) {
  const host = `https://${String(req.hostname || '').replace(/:\d+$/, '')}`;
  const me = Dir.sessionOf(req);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>${desc ? `<meta name="description" content="${esc(desc)}">` : ''}
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${esc(host + (canonical ?? req.path))}">`}
<meta property="og:title" content="${esc(title)}"><meta property="og:type" content="website"><meta property="og:site_name" content="${B}">${desc ? `<meta property="og:description" content="${esc(desc)}">` : ''}
<meta name="theme-color" content="#071936"><link rel="icon" href="/static/bem/icone.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600&family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/static/bem/bem.css?v=${VERSION}">
${ld ? `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>` : ''}
</head><body>
<a class="skip" href="#conteudo">Pular para o conteúdo</a>
<header class="top"><div class="wrap top__in">
  <a class="logo" href="/"><span class="logo__ring" aria-hidden="true"></span>Bem-Estar <b>Mental</b></a>
  <nav class="top__nav" aria-label="Principal"><a href="/psicologos"${active === 'busca' ? ' class="on"' : ''}>Encontrar psicólogo</a><a href="/#temas">Temas</a><a href="/para-profissionais"${active === 'pro' ? ' class="on"' : ''}>Para profissionais</a></nav>
  <a class="btn btn--sm btn--line" href="${me ? '/meu-perfil' : '/entrar'}">${me ? 'Meu perfil' : 'Sou profissional'}</a>
</div></header>
<main id="conteudo">${body}</main>
<footer class="foot"><div class="wrap foot__in">
  <div><a class="logo" href="/"><span class="logo__ring" aria-hidden="true"></span>Bem-Estar <b>Mental</b></a><p>Encontre psicólogas e psicólogos com CRP conferido, perto de você ou on-line.</p></div>
  <nav><b>Pacientes</b><a href="/psicologos">Buscar profissionais</a><a href="/psicologos/online">Atendimento on-line</a><a href="/#temas">Temas</a></nav>
  <nav><b>Profissionais</b><a href="/para-profissionais">Planos e destaque</a><a href="/cadastro">Criar perfil grátis</a><a href="/entrar">Entrar</a><a href="https://mentez.com.br" target="_blank" rel="noopener">Sistema Mentez</a></nav>
  <nav><b>Bem-Estar Mental</b><a href="/termos">Termos de uso</a><a href="/privacidade">Privacidade</a></nav>
</div><div class="wrap foot__small"><p><b>Em crise ou emergência:</b> ligue 188 (CVV, 24 horas, gratuito) ou 192 (SAMU). Este site não presta atendimento de urgência.</p><p>© ${new Date().getFullYear()} Bem-Estar Mental · uma iniciativa <a href="https://mentez.com.br" target="_blank" rel="noopener">Mentez</a></p></div></footer>
<script src="/static/bem/bem.js?v=${VERSION}" defer></script>
</body></html>`;
}
const send = (res, s, cache = 'public, max-age=60') => res.set('Cache-Control', cache).type('html').send(s);
const NO_STORE = 'no-store';

// cabeçalhos de segurança do portal (sobrepõem os do sistema)
router.use((req, res, next) => {
  res.removeHeader('X-Robots-Tag');
  res.set({ 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'X-Frame-Options': 'DENY' });
  next();
});

// ---------- busca ----------
const card = (p, sponsored = false) => html`<article class="card${sponsored ? ' card--sp' : ''}">
  <a class="card__img" href="/p/${p.slug}">${avatar(p)}</a>
  <div class="card__body">
    <p class="card__tags">${sponsored ? html`<span class="sp">Patrocinado</span>` : ''}${tierBadge(p.tierEff)}${p.crp_ok ? html`<span class="ok">${ico('check')}CRP verificado</span>` : ''}</p>
    <h3><a href="/p/${p.slug}">${p.name}</a></h3>
    <p class="card__meta">${p.title || 'Psicóloga'}${p.crp ? ` · CRP ${p.crp}` : ''}</p>
    <p class="card__where">${p.presencial && p.city ? html`<span>${ico('pin')}${p.city} - ${p.uf}</span>` : ''}${p.online ? html`<span>${ico('video')}On-line</span>` : ''}</p>
    ${Dir.list(p.temas).length ? html`<p class="chips">${Dir.list(p.temas).slice(0, 4).map((t) => html`<span>${Dir.TEMAS[t]}</span>`)}</p>` : ''}
    <div class="card__foot">${priceTxt(p) ? html`<b>${priceTxt(p)}</b>` : html`<span></span>`}
      <span class="card__acts">${p.booking_url ? html`<a class="btn btn--sm" href="/p/${p.slug}/agendar" rel="nofollow">${ico('cal')}Agendar</a>` : ''}<a class="btn btn--sm btn--line" href="/p/${p.slug}">Ver perfil</a></span></div>
  </div></article>`;
async function searchPage(req, res, f, meta) {
  const r = await Dir.search(f);
  const cities = await Dir.cities();
  const sel = (name, dict, v, label) => html`<label class="fld"><span>${label}</span><select name="${name}" data-auto><option value="">Todos</option>${Object.entries(dict).map(([k, l]) => html`<option value="${k}" ${v === k ? raw('selected') : ''}>${l}</option>`)}</select></label>`;
  const body = html`<section class="hero hero--sm"><div class="wrap"><h1>${meta.h1}</h1><p>${meta.lead}</p></div></section>
  <div class="wrap search">
    <details class="fbox" open data-fbox><summary>${ico('search')}Filtros${[f.tema, f.abordagem, f.publico, f.cityLabel, f.ate, f.agenda].filter(Boolean).length ? html` <b>${[f.tema, f.abordagem, f.publico, f.cityLabel, f.ate, f.agenda].filter(Boolean).length}</b>` : ''}</summary>
    <form class="filters" method="get" action="/psicologos" data-filters>
      <label class="fld"><span>Cidade</span><input name="cidade" list="cidades" value="${f.cityLabel || ''}" placeholder="Ex.: Goiânia - GO" autocomplete="off"><datalist id="cidades">${cities.map((c) => html`<option value="${c.city} - ${c.uf}">`)}</datalist></label>
      <fieldset class="fld"><legend>Atendimento</legend><label class="ck"><input type="checkbox" name="online" value="1" ${f.online ? raw('checked') : ''} data-auto> On-line</label><label class="ck"><input type="checkbox" name="presencial" value="1" ${f.presencial ? raw('checked') : ''} data-auto> Presencial</label></fieldset>
      ${sel('tema', Dir.TEMAS, f.tema, 'Tema')}${sel('abordagem', Dir.ABORDAGENS, f.abordagem, 'Abordagem')}${sel('publico', Dir.PUBLICOS, f.publico, 'Público')}
      <label class="fld"><span>Valor da sessão até</span><select name="ate" data-auto><option value="">Qualquer</option>${[100, 150, 200, 250, 300].map((v) => html`<option value="${v}" ${Number(f.ate) === v ? raw('selected') : ''}>${money(v)}</option>`)}</select></label>
      <label class="ck"><input type="checkbox" name="agenda" value="1" ${f.agenda ? raw('checked') : ''} data-auto> Só com agenda on-line</label>
      <label class="fld"><span>Nome</span><input name="q" value="${f.q || ''}" maxlength="60" placeholder="Nome do profissional"></label>
      <button class="btn">${ico('search')}Buscar</button>
    </form></details>
    <section class="results" aria-live="polite">
      <p class="results__n">${r.total ? `${r.total} profissiona${r.total === 1 ? 'l encontrado' : 'is encontrados'}` : 'Nenhum profissional encontrado com esses filtros.'}</p>
      ${r.sponsored.map((p) => card(p, true))}${r.organic.map((p) => card(p))}
      ${!r.total ? html`<div class="empty"><p>Tente tirar algum filtro ou buscar <a href="/psicologos/online">atendimento on-line</a>, que funciona de qualquer lugar.</p></div>` : ''}
      <p class="results__note">A ordem considera perfil completo, agenda on-line, CRP verificado e destaque. Perfis com “Patrocinado” pagam para aparecer no topo, em rodízio.</p>
    </section>
  </div>`;
  return send(res, shell(req, { title: meta.title, desc: meta.desc, body, active: 'busca', canonical: meta.canonical, noindex: meta.noindex }));
}
function filtersOf(q) {
  const f = { tema: Dir.TEMAS[q.tema] ? q.tema : '', abordagem: Dir.ABORDAGENS[q.abordagem] ? q.abordagem : '', publico: Dir.PUBLICOS[q.publico] ? q.publico : '', online: !!q.online, presencial: !!q.presencial, agenda: !!q.agenda, ate: Number(q.ate) || 0, q: String(q.q || '').slice(0, 60) };
  const c = String(q.cidade || '').match(/^\s*(.+?)\s*[-/,]\s*([A-Za-z]{2})\s*$/);
  if (c) { f.city = Dir.citySlug(c[1], c[2].toUpperCase()); f.cityLabel = `${c[1]} - ${c[2].toUpperCase()}`; } else if (q.cidade) f.cityLabel = String(q.cidade).slice(0, 60);
  return f;
}
router.get('/psicologos', async (req, res, next) => {
  try {
    const f = filtersOf(req.query);
    const tema = f.tema ? Dir.TEMAS[f.tema].toLowerCase() : '';
    const place = f.cityLabel || (f.online ? 'on-line' : '');
    return searchPage(req, res, f, { h1: `Psicólogos${tema ? ` para ${tema}` : ''}${place ? ` ${f.online && !f.cityLabel ? '' : 'em '}${place}` : ''}`, lead: 'Compare abordagens, temas e valores e agende direto com o profissional.', title: `Encontre psicólogos${tema ? ` para ${tema}` : ''}${place ? ` · ${place}` : ''} | ${B}`, desc: 'Psicólogas e psicólogos com CRP conferido, presencial e on-line. Agende direto com o profissional.', canonical: '/psicologos', noindex: Object.values(req.query).some(Boolean) });
  } catch (e) { next(e); }
});
// páginas para o Google: /psicologos/goiania-go, /psicologos/goiania-go/ansiedade, /psicologos/online/ansiedade
router.get(/^\/psicologos\/([a-z0-9-]+)(?:\/([a-z0-9-]+))?\/?$/, async (req, res, next) => {
  try {
    const [where, temaKey] = [req.params[0], req.params[1]];
    if (temaKey && !Dir.TEMAS[temaKey]) return next();
    const online = where === 'online';
    const cityLabel = online ? '' : await Dir.cityName(where);
    if (!online && !cityLabel) return next();
    const tema = temaKey ? Dir.TEMAS[temaKey].toLowerCase() : '';
    const f = { tema: temaKey || '', online, city: online ? '' : where, cityLabel };
    const place = online ? 'on-line' : `em ${cityLabel}`;
    return searchPage(req, res, f, { h1: `Psicólogos${tema ? ` para ${tema}` : ''} ${place}`, lead: online ? 'Sessões por videochamada, de onde você estiver, com profissionais de todo o Brasil.' : `Profissionais que atendem presencialmente em ${cityLabel} e também on-line.`,
      title: `Psicólogos${tema ? ` para ${tema}` : ''} ${place} | ${B}`, desc: `Encontre psicólogas e psicólogos${tema ? ` que atendem ${tema}` : ''} ${place}. CRP conferido, valores e agendamento direto.`, canonical: req.path.replace(/\/$/, '') });
  } catch (e) { next(e); }
});

// ---------- perfil ----------
const slotsCache = new Map();
async function nextSlots(p) {
  if (!p.tenant_id || !p.user_id || !p.booking_url) return [];
  const hit = slotsCache.get(p.id); if (hit && Date.now() - hit.at < 300e3) return hit.v;
  let v = [];
  try {
    const t = (await T.all()).find((x) => x.id === p.tenant_id);
    if (t && t.status === 'ativa') v = await T.run(t, async () => { const BK = await import('../lib/booking.js'); const c = await BK.config(); if (!c.enabled) return []; return (await BK.slots(c, p.user_id, null, 10)).slice(0, 4); });
  } catch (e) { console.error('bem: horários', e.message); }
  slotsCache.set(p.id, { v, at: Date.now() }); return v;
}
router.get('/p/:slug', async (req, res, next) => {
  try {
    const p = await Dir.bySlug(req.params.slug);
    if (!p || p.status !== 'ativo') return next();
    p.tierEff = await Dir.tierOf(p);
    if (!Lead.isBot(req.get('user-agent'))) Dir.stat(p.id, 'view');
    const slots = await nextSlots(p);
    const paras = String(p.bio || '').split(/\n{2,}|\n/).map((x) => x.trim()).filter(Boolean);
    const host = `https://${req.hostname}`;
    const ld = { '@context': 'https://schema.org', '@type': 'Person', name: p.name, jobTitle: p.title || 'Psicóloga', url: `${host}/p/${p.slug}`, image: p.photo_v ? `${host}${photoUrl(p)}` : undefined, description: paras[0] || undefined,
      address: p.city ? { '@type': 'PostalAddress', addressLocality: p.city, addressRegion: p.uf, addressCountry: 'BR' } : undefined, knowsAbout: Dir.list(p.temas).map((t) => Dir.TEMAS[t]) };
    const body = html`<section class="prof"><div class="wrap prof__in">
      <div class="prof__head">${avatar(p, 'av av--xl')}
        <div><p class="card__tags">${tierBadge(p.tierEff)}${p.crp_ok ? html`<span class="ok">${ico('check')}CRP verificado</span>` : ''}${p.epsi ? html`<span class="ok">${ico('check')}Cadastro e-Psi (on-line)</span>` : ''}</p>
          <h1>${p.name}</h1><p class="prof__meta">${p.title || 'Psicóloga'}${p.crp ? ` · CRP ${p.crp}` : ''}</p>
          <p class="card__where">${p.presencial && p.city ? html`<span>${ico('pin')}${p.district ? `${p.district}, ` : ''}${p.city} - ${p.uf}</span>` : ''}${p.online ? html`<span>${ico('video')}Atende on-line</span>` : ''}</p></div></div>
      <div class="prof__grid">
        <div class="prof__main">
          ${paras.length ? html`<section class="box"><h2>Sobre</h2>${paras.map((x) => html`<p>${x}</p>`)}</section>` : ''}
          ${Dir.list(p.temas).length ? html`<section class="box"><h2>Temas que atende</h2><p class="chips">${Dir.list(p.temas).map((t) => html`<a href="/psicologos/${p.online ? 'online' : p.city_slug}/${t}">${Dir.TEMAS[t]}</a>`)}</p></section>` : ''}
          ${Dir.list(p.abordagens).length ? html`<section class="box"><h2>Abordagens</h2><ul class="ticks">${Dir.list(p.abordagens).map((a) => html`<li>${Dir.ABORDAGENS[a]}</li>`)}</ul></section>` : ''}
          ${Dir.list(p.publicos).length ? html`<section class="box"><h2>Público</h2><p class="chips">${Dir.list(p.publicos).map((a) => html`<span>${Dir.PUBLICOS[a]}</span>`)}</p></section>` : ''}
          ${p.video ? html`<section class="box"><h2>Vídeo de apresentação</h2><p><a href="${p.video}" target="_blank" rel="noopener nofollow">Assistir ao vídeo ↗</a></p></section>` : ''}
        </div>
        <aside class="prof__side"><div class="book">
          ${priceTxt(p) ? html`<p class="book__price"><small>Valor da sessão</small><b>${priceTxt(p)}</b></p>` : ''}
          ${p.convenios ? html`<p class="book__conv"><small>Convênios</small>${p.convenios}</p>` : ''}
          ${slots.length ? html`<div class="slots"><small>Próximos horários livres</small>${slots.map((d) => html`<p><b>${d.label}</b>${d.times.slice(0, 4).map((t) => html`<a href="/p/${p.slug}/agendar" rel="nofollow">${t}</a>`)}</p>`)}</div>` : ''}
          ${p.booking_url ? html`<a class="btn btn--block" href="/p/${p.slug}/agendar" rel="nofollow">${ico('cal')}Agendar consulta</a>` : ''}
          ${p.whatsapp ? html`<a class="btn btn--block btn--wa" href="/p/${p.slug}/whatsapp" rel="nofollow">${ico('wa')}Conversar pelo WhatsApp</a>` : ''}
          ${p.site_url ? html`<a class="btn btn--block btn--line" href="/p/${p.slug}/site" rel="nofollow">${ico('site')}Visitar o site</a>` : ''}
          <p class="book__note">O agendamento e o pagamento são feitos direto com o profissional. O ${B} não cobra comissão.</p>
        </div></aside>
      </div></div></section>`;
    return send(res, shell(req, { title: `${p.name} · ${p.title || 'Psicóloga'}${p.city ? ` em ${p.city}` : ''} | ${B}`, desc: (paras[0] || `${p.title} ${p.online ? 'com atendimento on-line' : ''}`).slice(0, 160), body, ld, canonical: `/p/${p.slug}` }));
  } catch (e) { next(e); }
});
router.get(/^\/p\/([a-z0-9-]+)\/(agendar|whatsapp|site)$/, async (req, res, next) => {
  const p = await Dir.bySlug(req.params[0]).catch(() => null);
  if (!p || p.status !== 'ativo') return next();
  const k = req.params[1];
  const wa = String(p.whatsapp || '').replace(/\D/g, '');
  const url = k === 'agendar' ? p.booking_url : k === 'site' ? p.site_url : wa ? `https://wa.me/${wa.length <= 11 ? `55${wa}` : wa}?text=${encodeURIComponent(`Olá! Encontrei seu perfil no ${B} e gostaria de agendar uma consulta.`)}` : '';
  if (!url) return res.redirect(302, `/p/${p.slug}`);
  if (!Lead.isBot(req.get('user-agent'))) Dir.stat(p.id, k === 'agendar' ? 'book' : k === 'site' ? 'site' : 'wa');
  res.set('Cache-Control', NO_STORE).redirect(302, url);
});
router.get(/^\/foto\/(\d+)\/\d+\.webp$/, async (req, res) => {
  const f = await Dir.photo(Number(req.params[0])).catch(() => null);
  if (!f) return res.status(404).end();
  res.set('Cache-Control', 'public, max-age=31536000, immutable').type('image/webp').send(f.data);
});

// ---------- início ----------
router.get('/', async (req, res, next) => {
  try {
    const [feat, cities] = await Promise.all([Dir.featured(6), Dir.cities()]);
    const temasTop = ['ansiedade', 'depressao', 'relacionamentos', 'autoestima', 'luto', 'estresse', 'tdah', 'casal', 'traumas', 'panico', 'autismo', 'maternidade'];
    const body = html`<section class="hero"><div class="wrap hero__in">
      <p class="eyebrow">Psicólogas e psicólogos com CRP conferido</p>
      <h1>Encontre quem pode te ajudar a <em>cuidar da sua mente</em>.</h1>
      <p class="hero__lead">Busque por tema, cidade ou atendimento on-line, compare abordagens e valores e agende direto com o profissional.</p>
      <form class="hsearch" method="get" action="/psicologos">
        <label><span>O que você procura?</span><select name="tema"><option value="">Qualquer tema</option>${Object.entries(Dir.TEMAS).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
        <label><span>Onde?</span><input name="cidade" list="hcidades" placeholder="Cidade - UF ou deixe vazio" autocomplete="off"><datalist id="hcidades">${cities.map((c) => html`<option value="${c.city} - ${c.uf}">`)}</datalist></label>
        <label class="ck"><input type="checkbox" name="online" value="1" checked> On-line</label>
        <button class="btn btn--lg">${ico('search')}Buscar</button>
      </form>
      <p class="hero__trust"><span>${ico('check')}CRP conferido pela equipe</span><span>${ico('check')}Agendamento direto, sem comissão</span><span>${ico('check')}Sem cadastro para buscar</span></p>
    </div></section>
    <section class="sec" id="temas"><div class="wrap"><h2>Temas mais buscados</h2><p class="chips chips--lg">${temasTop.map((t) => html`<a href="/psicologos?tema=${t}&online=1">${Dir.TEMAS[t]}</a>`)}</p></div></section>
    ${feat.length ? html`<section class="sec sec--alt"><div class="wrap"><h2>Profissionais em destaque</h2><div class="grid">${feat.map((p) => html`<a class="mini" href="/p/${p.slug}">${avatar(p)}<b>${p.name}</b><small>${where(p)}</small>${tierBadge(p.tierEff)}</a>`)}</div></div></section>` : ''}
    <section class="sec"><div class="wrap"><h2>Como funciona</h2><ol class="steps">
      <li><b>1</b><h3>Busque</h3><p>Escolha o tema, a cidade ou o atendimento on-line.</p></li>
      <li><b>2</b><h3>Compare</h3><p>Veja a abordagem, os temas, os valores e os horários livres.</p></li>
      <li><b>3</b><h3>Agende</h3><p>Marque direto com o profissional, pelo site dele ou pelo WhatsApp.</p></li></ol></div></section>
    ${cities.length ? html`<section class="sec sec--alt"><div class="wrap"><h2>Cidades</h2><p class="chips">${cities.slice(0, 30).map((c) => html`<a href="/psicologos/${c.city_slug}">${c.city} - ${c.uf}</a>`)}<a href="/psicologos/online">On-line (todo o Brasil)</a></p></div></section>` : ''}
    <section class="band"><div class="wrap band__in"><div><p class="eyebrow">Para profissionais</p><h2>Você é psicóloga ou psicólogo?</h2><p>Crie seu perfil grátis, receba pacientes e, se quiser, tenha agenda on-line, teleconsulta e prontuário com a Mentez.</p></div>
      <p><a class="btn btn--lg btn--light" href="/para-profissionais">Conheça os planos</a></p></div></section>
    <section class="sec"><div class="wrap crisis"><b>Precisa de ajuda agora?</b> Em crise ou emergência, ligue <a href="tel:188">188</a> (CVV, 24 horas, gratuito) ou <a href="tel:192">192</a> (SAMU).</div></section>`;
    return send(res, shell(req, { title: `${B} · Encontre psicólogas e psicólogos perto de você ou on-line`, desc: 'Psicólogas e psicólogos com CRP conferido, presencial e on-line. Compare abordagens, temas e valores e agende direto com o profissional.', body, canonical: '/',
      ld: { '@context': 'https://schema.org', '@type': 'WebSite', name: B, url: `https://${req.hostname}/`, potentialAction: { '@type': 'SearchAction', target: `https://${req.hostname}/psicologos?q={busca}`, 'query-input': 'required name=busca' } } }));
  } catch (e) { next(e); }
});

// ---------- para profissionais ----------
router.get('/para-profissionais', (req, res) => {
  const T2 = Dir.TIERS;
  const rows = [
    ['Perfil com foto, abordagens, temas e valores', 1, 1, 1, 1], ['Selo de CRP verificado', 1, 1, 1, 1], ['Botão de WhatsApp e link do site', 1, 1, 1, 1], ['Estatísticas de visitas e cliques', 1, 1, 1, 1],
    ['Selo do plano no perfil', 0, 1, 1, 1], ['Mais peso na ordem da busca', 0, 1, 1, 1], ['Destaque nas páginas de cidade e de temas', 0, 0, '1 cidade · 3 temas', '3 cidades · 10 temas'],
    ['Vitrine “Profissionais em destaque” na página inicial', 0, 0, 1, 1], ['Topo da busca (Patrocinado, em rodízio)', 0, 0, 0, 1],
  ];
  const cell = (v) => (v === 1 ? html`<span class="yes" aria-label="Sim">${ico('check')}</span>` : v ? html`<span class="part">${v}</span>` : html`<span class="no" aria-label="Não">—</span>`);
  const body = html`<section class="hero hero--pro"><div class="wrap hero__in">
      <p class="eyebrow">Para psicólogas e psicólogos</p><h1>Mais pacientes, <em>sem comissão</em> sobre as sessões.</h1>
      <p class="hero__lead">Crie seu perfil grátis no ${B} e seja encontrado por quem procura ajuda. Quer agenda on-line, teleconsulta e prontuário? A Mentez faz tudo isso, e o seu perfil já vem com destaque.</p>
      <p class="hero__acts"><a class="btn btn--lg" href="/cadastro">Criar meu perfil grátis</a><a class="btn btn--lg btn--line" href="https://mentez.com.br/criar-conta" target="_blank" rel="noopener">Testar a Mentez grátis</a></p>
    </div></section>
    <section class="sec"><div class="wrap three">
      <article class="feat"><span class="feat__n">1</span><h3>Perfil grátis</h3><p>Foto, abordagens, temas, valores e WhatsApp. A equipe confere o seu CRP e o perfil vai ao ar com o selo de verificado.</p></article>
      <article class="feat"><span class="feat__n">2</span><h3>Agenda on-line com a Mentez</h3><p>Com a Mentez, o paciente vê seus horários livres e agenda sozinho. Você ganha teleconsulta, prontuário, lembretes no WhatsApp, site próprio e financeiro.</p></article>
      <article class="feat"><span class="feat__n">3</span><h3>Destaque</h3><p>Bronze, Prata ou Ouro: mais visibilidade nas buscas e nas páginas da sua cidade. Os planos Profissional e Clínica da Mentez já incluem Bronze e Prata.</p></article>
    </div></section>
    <section class="sec sec--alt" id="planos"><div class="wrap"><h2>Planos de destaque</h2><p class="lead">Sem fidelidade e sem comissão. Destaques pagos aparecem sempre marcados, e o perfil grátis continua aparecendo na busca.</p>
      <div class="plans">${['gratis', 'bronze', 'prata', 'ouro'].map((k) => html`<article class="plan plan--${k}">${k === 'prata' ? html`<span class="plan__tag">Mais escolhido</span>` : ''}<h3>${tierBadge(k) || 'Grátis'}</h3>
        <p class="plan__price">${T2[k].price ? html`<b>R$ ${T2[k].price}</b><small>/mês</small>` : html`<b>R$ 0</b><small>para sempre</small>`}</p>
        <p class="plan__inc">${k === 'bronze' ? 'Incluído no plano Profissional da Mentez' : k === 'prata' ? 'Incluído no plano Clínica da Mentez' : k === 'ouro' ? 'Máxima visibilidade' : 'Para começar'}</p>
        <a class="btn ${k === 'gratis' ? 'btn--line' : ''}" href="/cadastro${k === 'gratis' ? '' : `?plano=${k}`}">${k === 'gratis' ? 'Criar perfil grátis' : `Quero o ${T2[k].name}`}</a></article>`)}</div>
      <div class="tablewrap"><table class="cmp"><thead><tr><th>O que você recebe</th>${['Grátis', 'Bronze', 'Prata', 'Ouro'].map((n) => html`<th>${n}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr><td>${r[0]}</td>${r.slice(1).map((v) => html`<td>${cell(v)}</td>`)}</tr>`)}</tbody></table></div>
    </div></section>
    <section class="sec"><div class="wrap mentez"><div><p class="eyebrow">Sistema Mentez</p><h2>O consultório inteiro num lugar só</h2>
      <ul class="ticks"><li>Agenda com lembretes e confirmação pelo WhatsApp</li><li>Agendamento on-line e atendente virtual no WhatsApp</li><li>Teleconsulta própria, sem instalar nada</li><li>Prontuário seguro, documentos e recibos</li><li>Financeiro, Pix e nota fiscal</li><li>Site profissional e landing pages</li></ul>
      <p><a class="btn btn--lg" href="https://mentez.com.br" target="_blank" rel="noopener">Conhecer a Mentez</a></p></div>
      <div class="mentez__card"><b>Com a Mentez no ${B}</b><p>Seu perfil mostra os <b>horários livres de verdade</b> e o botão “Agendar”, que leva direto à sua agenda. É o que mais converte visitas em pacientes.</p></div></div></section>
    <section class="sec sec--alt"><div class="wrap faq"><h2>Dúvidas</h2>
      <details><summary>O ${B} cobra comissão das sessões?</summary><p>Não. O paciente agenda e paga direto com você. Os planos de destaque têm valor fixo por mês, sem fidelidade.</p></details>
      <details><summary>Quanto tempo leva para o perfil aparecer?</summary><p>A equipe confere o CRP no cadastro do Conselho em até 2 dias úteis. Depois disso, o perfil aparece na busca com o selo de verificado.</p></details>
      <details><summary>Atendo on-line. Preciso de algo a mais?</summary><p>Sim: para atender on-line, o Conselho Federal de Psicologia exige o cadastro e-Psi. Marque no seu perfil que você tem o cadastro.</p></details>
      <details><summary>Como o destaque é cobrado?</summary><p>Depois que você escolhe o plano, a equipe envia a cobrança por Pix. Clientes da Mentez nos planos Profissional e Clínica já têm Bronze ou Prata incluídos.</p></details>
      <details><summary>Os destaques passam na frente de todo mundo?</summary><p>Não. O destaque dá mais peso, mas a relevância do perfil continua contando. O topo da busca tem no máximo 3 perfis Ouro, em rodízio e marcados como “Patrocinado”.</p></details>
    </div></section>`;
  return send(res, shell(req, { title: `Para psicólogos: perfil grátis e planos de destaque | ${B}`, desc: 'Crie seu perfil grátis, seja encontrado por novos pacientes e tenha agenda on-line com a Mentez. Destaques Bronze, Prata e Ouro, sem comissão.', body, active: 'pro', canonical: '/para-profissionais' }));
});

// ---------- cadastro grátis e acesso por link ----------
const field = (name, label, v = '', o = '') => html`<label class="fld"><span>${label}</span><input name="${name}" value="${v}" ${raw(o)}></label>`;
const ufSel = (name, v) => html`<select name="${name}" required><option value="">UF</option>${Dir.UFS.map((u) => html`<option ${u === v ? raw('selected') : ''}>${u}</option>`)}</select>`;
router.get('/cadastro', (req, res) => {
  const plano = Dir.TIERS[req.query.plano] && req.query.plano !== 'gratis' ? req.query.plano : '';
  const body = html`<section class="sec"><div class="wrap narrow"><div class="formcard">
    <p class="eyebrow">Perfil grátis</p><h1>Crie seu perfil no ${B}</h1><p class="muted">Em 2 minutos. Depois você completa a foto, a apresentação e os temas.${plano ? html` Em seguida, a equipe envia a cobrança do plano <b>${Dir.TIERS[plano].name}</b>.` : ''}</p>
    ${req.query.erro ? html`<p class="err">${String(req.query.erro).slice(0, 200)}</p>` : ''}
    <form method="post" action="/cadastro" class="stack"><input type="hidden" name="plano" value="${plano}">
      <label class="hp" aria-hidden="true">Não preencha<input name="website" tabindex="-1" autocomplete="off"></label>
      ${field('name', 'Nome profissional', '', 'required maxlength="120" autocomplete="name"')}
      <div class="row">${field('email', 'E-mail', '', 'type="email" required maxlength="160" autocomplete="email"')}${field('phone', 'WhatsApp (com DDD)', '', 'required maxlength="20" inputmode="tel" autocomplete="tel"')}</div>
      <div class="row"><label class="fld"><span>CRP</span><input name="crp" required maxlength="20" placeholder="Ex.: 09/12345"></label><label class="fld"><span>UF do CRP</span>${ufSel('crp_uf', '')}</label></div>
      <div class="row"><label class="fld"><span>Cidade onde atende</span><input name="city" maxlength="80" placeholder="Deixe vazio se só atende on-line"></label><label class="fld"><span>UF</span>${ufSel('uf', '')}</label></div>
      <label class="ck"><input type="checkbox" name="aceite" value="1" required> Li e aceito os <a href="/termos" target="_blank">Termos de uso</a> e a <a href="/privacidade" target="_blank">Política de privacidade</a>.</label>
      <button class="btn btn--lg">Criar meu perfil</button>
      <p class="muted small">Já tem perfil? <a href="/entrar">Receba o link de acesso</a>.</p>
    </form></div></div></section>`;
  send(res, shell(req, { title: `Criar perfil grátis | ${B}`, body, noindex: true, active: 'pro' }), NO_STORE);
});
async function sendAccess(p, req) {
  const link = `https://${req.hostname}/acesso/${await Dir.newToken(p.id)}`;
  const text = `Olá, ${String(p.name).split(' ')[0]}! Este é o seu link de acesso ao perfil no ${B} (vale por 24 horas):\n${link}`;
  const ok = [];
  try { await PlatComm.mailSend(p.email, `Seu acesso ao ${B}`, text.replace(link, '').trim(), { label: 'Entrar no meu perfil', url: link }); ok.push('e-mail'); } catch (e) { console.error('bem: e-mail', e.message); }
  if (p.phone || p.whatsapp) { try { await PlatComm.waSend(p.phone || p.whatsapp, text, { kind: 'bem' }); ok.push('WhatsApp'); } catch (e) { console.error('bem: whatsapp', e.message); } }
  return ok;
}
router.post('/cadastro', parse, async (req, res) => {
  const b = req.body || {};
  if (b.website) return res.redirect(303, '/cadastro/enviado');
  if (!Lead.allow(ipOf(req), 'bem-cad', 5, 3600e3)) return res.redirect(303, '/cadastro?erro=Muitas tentativas. Tente mais tarde.');
  if (!b.aceite) return res.redirect(303, `/cadastro?erro=${encodeURIComponent('Para criar o perfil, aceite os termos.')}`);
  try {
    const p = await Dir.createFree({ name: b.name, email: b.email, phone: b.phone, crp: b.crp, crp_uf: b.crp_uf, city: b.city, uf: b.uf });
    if (Dir.TIERS[b.plano] && b.plano !== 'gratis') await Dir.requestTier(p.id, b.plano);
    const via = await sendAccess(p, req);
    try { PlatPush.notify('cadastros', { title: `${B}: novo perfil`, body: `${p.name} · CRP ${p.crp}${b.plano ? ` · quer ${Dir.TIERS[b.plano]?.name}` : ''}`, url: '/diretorio' }); } catch { /* sem aviso */ }
    res.redirect(303, `/cadastro/enviado?via=${encodeURIComponent(via.join(' e ') || '')}`);
  } catch (e) { res.redirect(303, `/cadastro?erro=${encodeURIComponent(e.message)}`); }
});
router.get('/cadastro/enviado', (req, res) => {
  const via = String(req.query.via || '');
  const body = html`<section class="sec"><div class="wrap narrow"><div class="formcard center"><span class="bigok">${ico('check')}</span><h1>Perfil criado!</h1>
    <p>${via ? html`Enviamos o link para completar o seu perfil por <b>${via}</b>.` : 'Já recebemos o seu cadastro. Se o link de acesso não chegar, use “Entrar” para pedir outro.'}</p>
    <p class="muted">A equipe confere o seu CRP em até 2 dias úteis. Depois disso, o perfil aparece na busca com o selo de verificado.</p>
    <p><a class="btn btn--line" href="/entrar">Pedir o link de novo</a></p></div></div></section>`;
  send(res, shell(req, { title: `Perfil criado | ${B}`, body, noindex: true }), NO_STORE);
});
router.get('/entrar', (req, res) => {
  const body = html`<section class="sec"><div class="wrap narrow"><div class="formcard">
    <p class="eyebrow">Área do profissional</p><h1>Entrar no meu perfil</h1>
    ${req.query.enviado ? html`<p class="ok-box">Se o e-mail estiver cadastrado, você vai receber o link de acesso por e-mail e pelo WhatsApp em instantes.</p>` : ''}
    ${req.query.expirado ? html`<p class="err">O link expirou ou já foi usado. Peça outro abaixo.</p>` : ''}
    <form method="post" action="/entrar" class="stack">${field('email', 'E-mail do cadastro', '', 'type="email" required maxlength="160" autocomplete="email"')}<button class="btn btn--lg">Receber link de acesso</button></form>
    <p class="muted small">Usa a Mentez? O seu perfil é editado no sistema da clínica, em <b>Marketing → Bem-Estar Mental</b>.</p>
    <p class="muted small">Ainda não tem perfil? <a href="/cadastro">Crie grátis</a>.</p></div></div></section>`;
  send(res, shell(req, { title: `Entrar | ${B}`, body, noindex: true }), NO_STORE);
});
router.post('/entrar', parse, async (req, res) => {
  if (Lead.allow(ipOf(req), 'bem-entrar', 8, 3600e3)) { const p = await Dir.byEmail(req.body?.email).catch(() => null); if (p && p.status !== 'suspenso') await sendAccess(p, req).catch(() => {}); }
  res.redirect(303, '/entrar?enviado=1');
});
router.get('/acesso/:tok', async (req, res) => {
  const p = await Dir.useToken(req.params.tok).catch(() => null);
  if (!p) return res.redirect(302, '/entrar?expirado=1');
  res.append('Set-Cookie', `bm=${encodeURIComponent(Dir.sessionCookie(p.id))}; Path=/; Max-Age=${30 * 86400}; HttpOnly; SameSite=Lax${req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : ''}`);
  res.set('Cache-Control', NO_STORE).redirect(302, '/meu-perfil');
});
router.post('/sair', (req, res) => { res.append('Set-Cookie', 'bm=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax'); res.redirect(303, '/'); });

// ---------- meu perfil (perfis grátis) ----------
const mine = async (req) => { const id = Dir.sessionOf(req); return id ? Dir.byId(id) : null; };
const chk = (name, dict, sel) => html`<div class="pick">${Object.entries(dict).map(([k, l]) => html`<label><input type="checkbox" name="${name}" value="${k}" ${Dir.list(sel).includes(k) ? raw('checked') : ''}><span>${l}</span></label>`)}</div>`;
router.get('/meu-perfil', async (req, res, next) => {
  try {
    const p = await mine(req); if (!p) return res.redirect(302, '/entrar');
    const tier = await Dir.tierOf(p); const st = await Dir.statsOf(p.id);
    const status = { pendente: 'Aguardando a conferência do CRP: ainda não aparece na busca.', ativo: 'No ar: aparece na busca.', oculto: 'Oculto: não aparece na busca.', suspenso: 'Suspenso pela equipe.' }[p.status] || p.status;
    const body = html`<section class="sec"><div class="wrap me">
      <header class="me__head"><div><p class="eyebrow">Meu perfil</p><h1>${p.name}</h1><p class="me__status me__status--${p.status}">${status}</p></div>
        <div class="me__acts">${p.status === 'ativo' ? html`<a class="btn btn--line" href="/p/${p.slug}" target="_blank" rel="noopener">Ver meu perfil público</a>` : ''}<form method="post" action="/sair"><button class="btn btn--line">Sair</button></form></div></header>
      ${req.query.ok ? html`<p class="ok-box">${req.query.ok === 'foto' ? 'Foto atualizada.' : req.query.ok === 'plano' ? 'Pedido recebido! A equipe envia a cobrança por Pix em breve.' : 'Perfil salvo.'}</p>` : ''}
      ${req.query.erro ? html`<p class="err">${String(req.query.erro).slice(0, 200)}</p>` : ''}
      <div class="me__grid">
        <form method="post" action="/meu-perfil" class="formcard stack">
          <h2>Dados do perfil</h2>
          <div class="row">${field('name', 'Nome profissional', p.name, 'required maxlength="120"')}<label class="fld"><span>Como aparece</span><select name="title">${['Psicóloga', 'Psicólogo', 'Psicólogue'].map((t) => html`<option ${p.title === t ? raw('selected') : ''}>${t}</option>`)}</select></label></div>
          <div class="row"><label class="fld"><span>CRP</span><input name="crp" value="${p.crp || ''}" maxlength="20"></label><label class="fld"><span>UF do CRP</span>${ufSel('crp_uf', p.crp_uf)}</label></div>
          <label class="ck"><input type="checkbox" name="epsi" value="1" ${p.epsi ? raw('checked') : ''}> Tenho cadastro e-Psi (exigido pelo CFP para atender on-line)</label>
          <fieldset class="fld"><legend>Atendimento</legend><label class="ck"><input type="checkbox" name="online" value="1" ${p.online ? raw('checked') : ''}> On-line</label><label class="ck"><input type="checkbox" name="presencial" value="1" ${p.presencial ? raw('checked') : ''}> Presencial</label></fieldset>
          <div class="row">${field('city', 'Cidade', p.city || '', 'maxlength="80"')}<label class="fld"><span>UF</span><select name="uf"><option value="">—</option>${Dir.UFS.map((u) => html`<option ${u === p.uf ? raw('selected') : ''}>${u}</option>`)}</select></label></div>
          ${field('district', 'Bairro (opcional)', p.district || '', 'maxlength="80"')}
          ${field('whatsapp', 'WhatsApp para pacientes', p.whatsapp || '', 'maxlength="20" inputmode="tel"')}
          <div class="row">${field('price_min', 'Valor da sessão (a partir de, R$)', p.price_min || '', 'inputmode="numeric" maxlength="6"')}${field('price_max', 'Até (opcional, R$)', p.price_max || '', 'inputmode="numeric" maxlength="6"')}</div>
          ${field('convenios', 'Convênios (opcional)', p.convenios || '', 'maxlength="300" placeholder="Ex.: Unimed, Bradesco Saúde"')}
          <label class="fld"><span>Apresentação</span><textarea name="bio" rows="7" maxlength="3000" placeholder="Conte como você trabalha, para quem e como é o primeiro contato. Sem promessas de resultado.">${p.bio || ''}</textarea></label>
          <fieldset class="fld"><legend>Temas que atende</legend>${chk('temas', Dir.TEMAS, p.temas)}</fieldset>
          <fieldset class="fld"><legend>Abordagens</legend>${chk('abordagens', Dir.ABORDAGENS, p.abordagens)}</fieldset>
          <fieldset class="fld"><legend>Público</legend>${chk('publicos', Dir.PUBLICOS, p.publicos)}</fieldset>
          ${field('video', 'Vídeo de apresentação (link do YouTube ou Vimeo, opcional)', p.video || '', 'maxlength="300"')}
          <button class="btn btn--lg">Salvar perfil</button>
        </form>
        <aside class="me__side">
          <div class="formcard center"><h2>Foto</h2>${avatar(p, 'av av--xl')}<label class="btn btn--line">Trocar foto<input type="file" accept="image/*" data-photo="/meu-perfil/foto" hidden></label><p class="muted small">Foto de rosto, bem iluminada. Ajustamos o tamanho sozinhos.</p></div>
          <div class="formcard"><h2>Últimos 30 dias</h2><dl class="kp"><div><dt>Visitas</dt><dd>${st.view}</dd></div><div><dt>WhatsApp</dt><dd>${st.wa}</dd></div><div><dt>Agendar</dt><dd>${st.book}</dd></div><div><dt>Site</dt><dd>${st.site}</dd></div></dl></div>
          <div class="formcard"><h2>Destaque</h2><p>Plano atual: ${tierBadge(tier) || html`<b>Grátis</b>`}${p.tier_until ? html` <small class="muted">até ${new Date(p.tier_until).toLocaleDateString('pt-BR')}</small>` : ''}</p>
            <form method="post" action="/meu-perfil/destaque" class="tiers">${['bronze', 'prata', 'ouro'].filter((k) => Dir.TIERS[k].boost > Dir.TIERS[tier].boost).map((k) => html`<button class="btn btn--line" name="tier" value="${k}">${Dir.TIERS[k].name} · R$ ${Dir.TIERS[k].price}/mês</button>`)}</form>
            <p class="muted small"><a href="/para-profissionais#planos">Compare os planos</a>. Com a Mentez, o Bronze ou o Prata já vêm incluídos.</p></div>
          <div class="formcard mentez-cta"><h2>Agenda on-line?</h2><p>Com a Mentez, seu perfil mostra os horários livres e o paciente agenda sozinho.</p><a class="btn" href="https://mentez.com.br/criar-conta" target="_blank" rel="noopener">Testar a Mentez grátis</a></div>
        </aside>
      </div></div></section>`;
    send(res, shell(req, { title: `Meu perfil | ${B}`, body, noindex: true }), NO_STORE);
  } catch (e) { next(e); }
});
router.post('/meu-perfil', parse, async (req, res) => {
  const p = await mine(req); if (!p) return res.redirect(303, '/entrar');
  if (p.kind !== 'gratis') return res.redirect(303, '/meu-perfil?erro=Este perfil é editado no sistema Mentez.');
  try { await Dir.update(p.id, { ...req.body, temas: arr(req.body.temas), abordagens: arr(req.body.abordagens), publicos: arr(req.body.publicos) }); res.redirect(303, '/meu-perfil?ok=1'); } catch (e) { res.redirect(303, `/meu-perfil?erro=${encodeURIComponent(e.message)}`); }
});
router.post('/meu-perfil/foto', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  const p = await mine(req); if (!p) return res.status(401).json({ ok: false, error: 'Entre de novo.' });
  try { await Dir.setPhoto(p.id, Buffer.isBuffer(req.body) ? req.body : null); res.json({ ok: true }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
router.post('/meu-perfil/destaque', parse, async (req, res) => {
  const p = await mine(req); if (!p) return res.redirect(303, '/entrar');
  try { await Dir.requestTier(p.id, String(req.body.tier || '')); try { PlatPush.notify('cadastros', { title: `${B}: pedido de destaque`, body: `${p.name} quer o ${Dir.TIERS[req.body.tier]?.name}`, url: '/diretorio' }); } catch { /* sem aviso */ } res.redirect(303, '/meu-perfil?ok=plano'); } catch (e) { res.redirect(303, `/meu-perfil?erro=${encodeURIComponent(e.message)}`); }
});

// ---------- termos, privacidade, robôs ----------
const legal = (title, items) => html`<section class="sec"><div class="wrap narrow legal"><h1>${title}</h1>${items.map(([h, t]) => html`<h2>${h}</h2><p>${t}</p>`)}<p class="muted small">Atualizado em ${new Date().toLocaleDateString('pt-BR')}.</p></div></section>`;
router.get('/termos', (req, res) => send(res, shell(req, { title: `Termos de uso | ${B}`, body: legal('Termos de uso', [
  ['O que é', `O ${B} é um diretório que ajuda pacientes a encontrar psicólogas e psicólogos. Não presta atendimento psicológico nem de urgência.`],
  ['Profissionais', 'Cada profissional é responsável pelas informações do próprio perfil e pelo atendimento, seguindo o Código de Ética do Psicólogo e as normas do Conselho Federal de Psicologia (inclusive o cadastro e-Psi para atendimento on-line). Perfis com informações falsas podem ser removidos.'],
  ['Verificação', 'A equipe confere o número do CRP antes de o perfil aparecer. A verificação não é uma avaliação do trabalho do profissional.'],
  ['Agendamento e pagamento', 'O agendamento e o pagamento das sessões são combinados direto entre paciente e profissional. O diretório não cobra comissão.'],
  ['Destaques', 'Planos de destaque dão mais visibilidade, sempre identificados. O topo da busca mostra no máximo 3 perfis patrocinados, em rodízio.'],
  ['Urgência', 'Em crise ou emergência, ligue 188 (CVV) ou 192 (SAMU).'],
]) }), 'public, max-age=3600'));
router.get('/privacidade', (req, res) => send(res, shell(req, { title: `Privacidade | ${B}`, body: legal('Política de privacidade', [
  ['Pacientes', 'Para buscar, não é preciso cadastro. Não usamos cookies de rastreamento nem guardamos o que você busca ligado a você. Contamos apenas visitas e cliques de forma agregada para mostrar resultados aos profissionais.'],
  ['Profissionais', 'Guardamos os dados do perfil (nome, CRP, contatos, cidade, temas, foto e apresentação) para exibi-lo no diretório e para contato da equipe. Você pode editar ou pedir a exclusão a qualquer momento.'],
  ['Cookies', 'Usamos um cookie apenas para manter o profissional conectado à área “Meu perfil”.'],
  ['Operação', 'O diretório é operado pela Mentez, com os mesmos cuidados de segurança do sistema usado pelas clínicas. Seus direitos seguem a Lei Geral de Proteção de Dados (LGPD).'],
]) }), 'public, max-age=3600'));
router.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nAllow: /\nDisallow: /meu-perfil\nDisallow: /acesso/\nDisallow: /p/*/agendar\nDisallow: /p/*/whatsapp\nSitemap: https://${req.hostname}/sitemap.xml\n`));
router.get('/sitemap.xml', async (req, res) => {
  const h = `https://${req.hostname}`;
  const profs = await T.pq("SELECT slug, updated_at, city_slug, online, temas FROM dir_profiles WHERE status = 'ativo'");
  const urls = new Set(['/', '/psicologos', '/psicologos/online', '/para-profissionais']);
  for (const p of profs) { if (p.city_slug) urls.add(`/psicologos/${p.city_slug}`); for (const t of Dir.list(p.temas)) { if (p.city_slug) urls.add(`/psicologos/${p.city_slug}/${t}`); if (p.online) urls.add(`/psicologos/online/${t}`); } }
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${[...urls].map((u) => `<url><loc>${h}${u}</loc></url>`).join('')}${profs.map((p) => `<url><loc>${h}/p/${p.slug}</loc><lastmod>${new Date(p.updated_at).toISOString().slice(0, 10)}</lastmod></url>`).join('')}</urlset>`);
});
router.get('/_mentez/saude', (req, res) => res.json({ ok: true }));
router.use((req, res) => res.status(404).type('html').set('Cache-Control', NO_STORE).send(shell(req, { title: `Página não encontrada | ${B}`, noindex: true, body: html`<section class="sec"><div class="wrap narrow center"><h1>Página não encontrada</h1><p>O endereço não existe ou o perfil saiu do ar.</p><p><a class="btn" href="/psicologos">Buscar profissionais</a></p></div></section>` })));
