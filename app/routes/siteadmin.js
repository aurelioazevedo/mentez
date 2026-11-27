// Marketing → Site: editor do site da clínica (conteúdo por seções, aparência, imagens, endereço, SEO) e publicação.
import express from 'express';
import * as Tenancy from '../lib/tenancy.js';
import * as Brand from '../lib/brand.js';
import * as D from '../lib/domains.js';
import * as Sites from '../lib/sites.js';
import * as R from '../lib/siterender.js';
import { context, siteHeaders, sendMedia, clinicBase } from './sitepub.js';
import { audit } from '../lib/db.js';
import * as Lead from '../lib/sitelead.js';
import * as Blog from '../lib/siteblog.js';
import * as SAI from '../lib/siteai.js';
import * as Import from '../lib/siteimport.js';
import { page, html, raw, brDateTime, VERSION } from '../lib/html.js';
import { router, send, str } from '../lib/router.js';

export const admin = router();
const ed = router(); // páginas que existem no site e em cada landing page (conteúdo, aparência, Google, versões, prévia)
const B = '/marketing/site';
const ck = (v) => (v ? raw('checked') : '');
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]) : []);
// página em edição: o site (req.sp = '') ou uma landing page (/lp/<endereço>)
admin.use((req, res, next) => { req.sp = ''; req.sb = B; next(); });
const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const TABS = [['', 'Conteúdo'], ['aparencia', 'Aparência'], ['imagens', 'Imagens e PDFs'], ['blog', 'Blog'], ['landing', 'Landing pages'], ['resultados', 'Resultados'], ['endereco', 'Endereço'], ['seo', 'Google e privacidade'], ['versoes', 'Versões']];
const LP_TABS = [['', 'Conteúdo'], ['aparencia', 'Aparência'], ['seo', 'Google e endereço'], ['versoes', 'Versões']];
async function shell(req, tab, title, body) {
  const sp = req.sp || ''; const sb = req.sb || B;
  const st = await Sites.state(sp);
  const base = await Sites.siteUrl();
  const url = base ? `${base}${sp ? `/${sp}` : ''}` : '';
  const name = sp ? ((await Sites.draft(sp))?.name || sp) : '';
  const status = !st.published ? html`<span class="badge b-agendada">Ainda não publicado</span>` : st.pending ? html`<span class="badge b-confirmada">No ar · há alterações não publicadas</span>` : html`<span class="badge b-realizada">No ar</span>`;
  return page(req, { title: `${sp ? 'Landing page' : 'Site'} · ${title}`, active: 'marketing', body: html`
    <header class="ph"><div><p class="eyebrow">${sp ? html`<a href="${B}/landing">Marketing · Site · Landing pages</a>` : 'Marketing'}</p><h1>${sp ? name : 'Site'}</h1>
      <p class="muted">${sp ? 'Landing page: uma página com um objetivo só (captar contatos, inscrições ou interessados).' : 'Monte o site do consultório por seções prontas: escolha o visual, ajuste os textos e publique.'} ${status}</p></div>
      <div class="ph-actions"><a class="btn ghost" href="${sb}/previa" target="_blank" rel="noopener">Ver prévia</a>
        <form method="post" action="${sb}/publicar" class="inline"><button class="btn">${st.published ? 'Publicar alterações' : sp ? 'Publicar a página' : 'Publicar o site'}</button></form></div></header>
    <section class="card site-status">
      <div><p class="muted small">Endereço ${sp ? 'da página' : 'do site'}</p>${url ? html`<p class="site-url"><a href="${url}" target="_blank" rel="noopener">${url.replace(/^https:\/\//, '')}</a> <button class="chip" type="button" data-copy-text="${url}">Copiar</button></p>` : html`<p>—</p>`}</div>
      <div><p class="muted small">Situação</p><p>${st.published ? html`Publicado em ${brDateTime(st.at)}` : 'Rascunho: ninguém vê ainda'}</p></div>
      ${st.published ? html`<form method="post" action="${sb}/despublicar" data-confirm="Tirar do ar? Quem abrir o endereço verá “página não encontrada” (o site) ou “Site em construção”."><button class="btn ghost btn-sm">Tirar do ar</button></form>` : ''}
    </section>
    <nav class="tabs">${(sp ? LP_TABS : TABS).map(([k, l]) => html`<a href="${sb}${k ? `/${k}` : ''}" class="${tab === k ? 'on' : ''}">${l}</a>`)}</nav>
    ${body}
    <script src="/static/site-admin.js?v=${VERSION}" defer></script>` });
}

// ---------- Conteúdo ----------
const imgSelect = (name, val, media) => html`<span class="site-imgsel"><select name="${name}" data-imgsel><option value="">Sem imagem</option>${media.filter((m) => m.kind === 'img' || m.kind === 'svg').map((m) => html`<option value="${m.id}" data-thumb="${B}/m/${m.id}/${m.v}/o/480.${m.kind === 'svg' ? 'svg' : 'webp'}" ${Number(val) === m.id ? raw('selected') : ''}>${m.name || `Imagem ${m.id}`}</option>`)}</select><img class="site-imgsel__th" alt="" hidden></span>`;
function field(i, s, [k, label, kind], media) {
  const n = `s[${i}][${k}]`;
  const v = s[k];
  const ai = (k2) => html`<button type="button" class="chip site-ai" data-site-ai data-section="${Sites.SECTIONS[s.type]?.label}" data-label="${label}" data-kind="${k2}" title="Sugerir um texto com IA">✨ IA</button>`;
  if (kind === 'text') return html`<label class="fld"><span>${label} ${['title', 'eyebrow', 'cta', 'button'].includes(k) && k !== 'cta' ? ai('text') : ''}</span><input name="${n}" value="${v || ''}" maxlength="200"></label>`;
  if (kind === 'area') return html`<label class="fld"><span>${label} ${ai('area')}</span><textarea name="${n}" rows="4" maxlength="3000">${v || ''}</textarea></label>`;
  if (kind === 'lines') return html`<label class="fld"><span>${label}</span><textarea name="${n}" rows="3">${(v || []).join('\n')}</textarea></label>`;
  if (kind === 'check') return html`<label class="fld check"><input type="checkbox" name="${n}" value="1" ${ck(v)}><span>${label}</span></label>`;
  if (kind === 'image') return html`<div class="fld"><span>${label}</span>${imgSelect(n, v, media)}</div>`;
  if (kind === 'file') return html`<label class="fld"><span>${label}</span><select name="${n}"><option value="">Nenhum</option>${(media.files || []).map((f) => html`<option value="${f.id}" ${Number(v) === f.id ? raw('selected') : ''}>${f.name}</option>`)}</select><small class="muted">Envie o PDF na aba <a href="${B}/imagens#pdfs">Imagens e PDFs</a>.</small></label>`;
  if (kind === 'items') {
    const faq = s.type === 'duvidas'; const rows = [...(v || []), { t: '', d: '' }, { t: '', d: '' }];
    return html`<fieldset class="fld site-items"><legend>${label} <small class="muted">(deixe em branco para apagar uma linha)</small></legend>
      ${rows.map((x, j) => html`<div class="site-item"><input name="${n}[${j}][t]" value="${x.t}" placeholder="${faq ? 'Pergunta' : 'Título'}" maxlength="160"><textarea name="${n}[${j}][d]" rows="2" placeholder="${faq ? 'Resposta' : 'Texto curto'}" maxlength="900">${x.d}</textarea></div>`)}</fieldset>`;
  }
  if (kind === 'people') {
    const rows = [...(v || []), { name: '', role: '', text: '', image: null }];
    return html`<fieldset class="fld site-items"><legend>${label} <small class="muted">(deixe o nome em branco para tirar alguém)</small></legend>
      ${rows.map((p, j) => html`<div class="site-item site-person"><input name="${n}[${j}][name]" value="${p.name}" placeholder="Nome" maxlength="120"><input name="${n}[${j}][role]" value="${p.role}" placeholder="Área (ex.: Psicóloga clínica)" maxlength="120"><textarea name="${n}[${j}][text]" rows="2" placeholder="Apresentação curta (CRP, abordagem, públicos)" maxlength="600">${p.text}</textarea>${imgSelect(`${n}[${j}][image]`, p.image, media)}</div>`)}</fieldset>`;
  }
  return '';
}
ed.get('/', async (req, res) => {
  const site = await Sites.draft(req.sp);
  const media = await Sites.mediaList(); media.files = await Sites.fileList();
  const bk = await (await import('../lib/booking.js')).config().catch(() => ({ enabled: false }));
  send(res, await shell(req, '', 'Conteúdo', html`
    ${req.sp ? '' : html`<details class="card site-import"><summary><b>Já tem um site?</b> Importe os textos e as imagens dele para começar mais rápido</summary>
      <form method="post" action="${B}/importar" class="site-slug" data-confirm="Os textos da abertura, do “Sobre” e de “Como posso ajudar” do rascunho serão substituídos pelos do site importado. Continuar?">
        <label class="fld"><span>Endereço do site atual</span><input name="url" required maxlength="300" placeholder="https://seusite.com.br"></label>
        <label class="fld check"><input type="checkbox" name="imgs" value="1" checked><span>Trazer imagens (até 3)</span></label>
        <button class="btn ghost" data-busy="Importando…">Importar</button></form>
      <p class="muted small">Traz o título, a descrição, parágrafos e temas para o rascunho; nada vai ao ar sem você publicar. Revise tudo: textos de outros sites podem precisar de ajustes.</p></details>`}
    <form method="post" action="${req.sb}/conteudo" class="stack site-form">
      <p class="muted small">Marque as seções que aparecem no site e use as setas para mudar a ordem. Os textos começam com sugestões a partir dos dados da clínica: revise e escreva com a sua voz. Imagens: envie na aba <a href="${B}/imagens">Imagens</a> do site e escolha aqui.</p>
      ${site.sections.map((s, i) => { const def = Sites.SECTIONS[s.type]; return html`<section class="card site-sec ${s.on ? '' : 'is-off'}">
        <input type="hidden" name="s[${i}][type]" value="${s.type}">
        <div class="site-sec__head"><label class="check"><input type="checkbox" name="s[${i}][on]" value="1" ${ck(s.on)} data-sec-on> <b>${def.label}</b></label>
          ${s.type === 'agendamento' && !bk.enabled ? html`<small class="muted">Ligue o agendamento on-line em <a href="/configuracoes/agendamento-online">Configurações</a> para esta seção aparecer.</small>` : ''}
          <span class="site-sec__moves"><button class="chip" name="move" value="${i}:up" ${i === 0 ? raw('disabled') : ''} aria-label="Subir ${def.label}">↑</button><button class="chip" name="move" value="${i}:down" ${i === site.sections.length - 1 ? raw('disabled') : ''} aria-label="Descer ${def.label}">↓</button></span></div>
        <details ${s.type === 'inicio' ? raw('open') : ''}><summary>Editar</summary><div class="stack site-sec__body">${def.fields.map((f) => field(i, s, f, media))}</div></details>
      </section>`; })}
      <div class="actions site-save"><button class="btn">Salvar rascunho</button><a class="btn ghost" href="${req.sb}/previa" target="_blank" rel="noopener">Ver prévia</a></div>
    </form>`));
});
ed.post('/conteudo', async (req, res) => {
  const site = await Sites.draft(req.sp);
  const incoming = arr(req.body.s);
  const next = [];
  for (const raw0 of incoming) {
    const type = String(raw0?.type || ''); const def = Sites.SECTIONS[type]; if (!def) continue;
    const s = { type, on: !!raw0.on };
    for (const [k, , kind] of def.fields) {
      const v = raw0[k];
      if (kind === 'lines') s[k] = String(v || '').split('\n');
      else if (kind === 'items') s[k] = arr(v).map((x) => ({ t: x?.t, d: x?.d }));
      else if (kind === 'people') s[k] = arr(v).map((x) => ({ name: x?.name, role: x?.role, text: x?.text, image: x?.image }));
      else if (kind === 'check') s[k] = !!v;
      else s[k] = v;
    }
    next.push(s);
  }
  const [iS, dir] = String(req.body.move || '').split(':'); const i = Number(iS);
  if (dir && Number.isInteger(i)) { const j = dir === 'up' ? i - 1 : i + 1; if (next[i] && next[j]) [next[i], next[j]] = [next[j], next[i]]; }
  await Sites.saveDraft({ ...site, sections: next.length ? next : site.sections }, req.sp);
  await audit(req, 'site-conteudo');
  res.flash(dir ? 'Ordem alterada.' : 'Rascunho salvo. Veja a prévia e publique quando estiver pronto.').redirect(req.sb);
});

// ---------- Aparência ----------
ed.get('/aparencia', async (req, res) => {
  const site = await Sites.draft(req.sp); const b = Brand.get();
  send(res, await shell(req, 'aparencia', 'Aparência', html`
    <form method="post" action="${req.sb}/aparencia" class="stack">
      <section class="card"><h2>Layout</h2><p class="muted small">A estrutura do site: como a abertura e as seções são apresentadas.</p>
        <div class="site-layouts">${Object.entries(Sites.LAYOUTS).map(([k, l]) => html`<label class="site-layout"><input type="radio" name="layout" value="${k}" ${ck(site.layout === k)} data-motion="${l.motion ? 1 : 0}">
          <span class="site-mock site-mock--${k}" aria-hidden="true"><i class="m-top"></i><i class="m-hero"></i><i class="m-img"></i><i class="m-row"></i><i class="m-row m-row2"></i></span>
          <b>${l.name}${l.motion ? html` <span class="badge b-confirmada">Animado</span>` : ''}</b><small class="muted">${l.desc}</small></label>`)}</div></section>
      <section class="card"><h2>Menu do site</h2><p class="muted small">O menu do topo. “Vidro” flutua sobre a página com efeito de vidro fosco, e um destaque de vidro desliza até o item ao passar o mouse e acompanha a seção que está na tela.</p>
        <div class="site-motions">${Object.entries(Sites.NAVS).map(([k, l]) => html`<label class="site-style site-motion"><input type="radio" name="nav" value="${k}" ${ck(site.nav === k)}>
          <span class="site-nv site-nv--${k}" aria-hidden="true"><i class="nv-bar"></i><i class="nv-pill"></i><i class="nv-a"></i><i class="nv-b"></i></span><b>${l}</b></label>`)}</div></section>
      <section class="card"><h2>Animações</h2><p class="muted small">Vale para qualquer layout; os marcados como “Animado” têm efeitos próprios (aurora, respiração, fotos flutuando, faixa de temas). Quem configurou o aparelho para “reduzir movimento” sempre vê o site parado.</p>
        <div class="site-motions">${Object.entries(Sites.MOTION).map(([k, m]) => html`<label class="site-style site-motion"><input type="radio" name="motion" value="${k}" ${ck(site.motion === k)}>
          <span class="site-mo site-mo--${k}" aria-hidden="true"><i></i><i></i><i></i></span><b>${m.name}</b><small class="muted">${m.desc}</small></label>`)}</div></section>
      <section class="card"><h2>Estilo</h2><p class="muted small">Cores e fontes. “Cores da marca” usa a cor principal cadastrada em <a href="/configuracoes/identidade">Identidade visual</a>${b.color ? '' : ' (nenhuma cadastrada ainda)'}. O contraste é ajustado automaticamente para a leitura ficar confortável.</p>
        <div class="site-styles">${Object.entries(Sites.STYLES).map(([k, st]) => { const p = Sites.palette({ style: k, layout: 'editorial' }, b); return html`<label class="site-style"><input type="radio" name="style" value="${k}" ${ck(site.style === k)}>
          <span class="site-sw" style="background:${p.bg};color:${p.ink}"><span class="site-sw__aa" style="font-family:'${p.serif}',Georgia,serif">Aa</span><span class="site-sw__dot" style="background:${p.accent}"></span></span>
          <b>${st.name}</b><small class="muted">${p.serif}${p.serif !== p.sans ? ` + ${p.sans}` : ''}</small></label>`; })}</div></section>
      <div class="actions"><button class="btn">Salvar aparência</button><a class="btn ghost" href="${req.sb}/previa" target="_blank" rel="noopener">Ver prévia</a></div>
    </form>`));
});
ed.post('/aparencia', async (req, res) => {
  const site = await Sites.draft(req.sp);
  await Sites.saveDraft({ ...site, layout: str(req.body.layout, 20), style: str(req.body.style, 20), motion: str(req.body.motion, 10) || site.motion, nav: str(req.body.nav, 10) || site.nav }, req.sp);
  await audit(req, 'site-aparencia');
  res.flash('Aparência salva no rascunho.').redirect(`${req.sb}/aparencia`);
});

// ---------- Imagens ----------
admin.get('/imagens', async (req, res) => {
  const site = await Sites.draft(); const used = Sites.usedMedia(site);
  const list = await Sites.mediaList(); const files = await Sites.fileList();
  send(res, await shell(req, 'imagens', 'Imagens', html`
    <section class="card site-up" data-site-upload="${B}/imagens">
      <h2>Enviar imagens</h2>
      <p class="muted small">JPG, PNG, WebP ou HEIC (fotos do celular) até 15 MB; SVG para logos e ícones. As fotos são convertidas para <b>WebP</b> e recortadas nos tamanhos de cada espaço da página. Os dados escondidos da foto (localização GPS, aparelho, data) são apagados.</p>
      <label class="site-drop"><input type="file" accept="image/*,.heic,.heif,.svg" multiple data-site-file hidden><span>Arraste as imagens para cá ou <u>escolha no computador</u></span></label>
      <div class="site-up__log" data-site-log aria-live="polite"></div>
    </section>
    <section class="card" id="pdfs"><h2>Materiais em PDF <small class="muted">(${files.length} de ${Sites.MAX_FILES})</small></h2>
      <p class="muted small">E-books, guias e exercícios oferecidos nas landing pages. Escolha o PDF na seção “Formulário de contato”: depois do envio, a pessoa recebe o link na tela e pelo WhatsApp.</p>
      ${files.length ? html`<ul class="list">${files.map((f) => html`<li class="site-dom"><span><b>${f.name}</b><br><small class="muted">${kb(f.bytes)} · enviado em ${brDateTime(f.created_at)}</small></span>
        <form method="post" action="${B}/arquivos/${f.id}/apagar" data-confirm="Apagar ${f.name}? Quem tem o link deixa de conseguir baixar."><button class="btn ghost btn-sm danger-text">Apagar</button></form></li>`)}</ul>` : ''}
      <label class="btn ghost site-pdf-up">Enviar PDF<input type="file" accept="application/pdf,.pdf" data-site-pdf="${B}/arquivos" hidden></label></section>
    <section class="card"><h2>Biblioteca de imagens <small class="muted">(${list.length} de ${Sites.MAX_MEDIA})</small></h2>
      ${list.length ? html`<p class="muted small">Clique na foto para marcar o <b>ponto de foco</b> (o rosto, por exemplo): os recortes da página ficam centrados nele.</p>
      <div class="site-media">${list.map((m) => html`<form method="post" action="${B}/imagens/${m.id}" class="site-m">
        <div class="site-focal" data-focal>${m.kind === 'svg' ? html`<img src="${B}/m/${m.id}/${m.v}/o/480.svg" alt="">` : html`<img src="${B}/m/${m.id}/${m.v}/o/768.webp" alt="" width="${m.w}" height="${m.h}"><i class="site-focal__dot" style="left:${Number(m.fx) * 100}%;top:${Number(m.fy) * 100}%"></i>`}</div>
        <input type="hidden" name="fx" value="${m.fx}"><input type="hidden" name="fy" value="${m.fy}">
        <p class="small"><b>${m.name || `Imagem ${m.id}`}</b>${used.has(m.id) ? html` <span class="badge b-realizada">em uso</span>` : ''}<br><span class="muted">${m.kind === 'svg' ? 'SVG' : `${m.w}×${m.h} px · WebP ${kb(m.bytes)}`}${m.orig_bytes && m.kind !== 'svg' ? ` (original ${kb(m.orig_bytes)})` : ''}</span></p>
        <label class="fld"><span>Descrição (para leitores de tela e Google)</span><input name="alt" value="${m.alt || ''}" maxlength="300" placeholder="Ex.: Foto da psicóloga sorrindo no consultório"></label>
        <div class="actions"><button class="btn btn-sm">Salvar</button><button class="btn ghost btn-sm danger-text" formaction="${B}/imagens/${m.id}/apagar" data-confirm-btn="${used.has(m.id) ? 'Esta imagem está em uso no site. Apagar mesmo assim? Ela sai das seções onde aparece.' : 'Apagar esta imagem?'}">Apagar</button></div>
      </form>`)}</div>` : html`<p class="muted">Nenhuma imagem ainda.</p>`}
    </section>`));
});
admin.post('/imagens', express.raw({ type: () => true, limit: '16mb' }), async (req, res) => {
  try {
    const name = decodeURIComponent(String(req.get('x-file-name') || '')).slice(0, 160);
    const m = await Sites.upload(Buffer.isBuffer(req.body) ? req.body : null, name);
    await audit(req, 'site-imagem-enviar', String(m.id));
    res.json({ ok: true, ...m });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
admin.post('/arquivos', express.raw({ type: () => true, limit: '13mb' }), async (req, res) => {
  try { const f = await Sites.fileUpload(Buffer.isBuffer(req.body) ? req.body : null, decodeURIComponent(String(req.get('x-file-name') || '')).slice(0, 160)); await audit(req, 'site-pdf-enviar', String(f.id)); res.json({ ok: true }); } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
admin.post('/arquivos/:id/apagar', async (req, res) => { await Sites.fileDelete(Number(req.params.id)); await audit(req, 'site-pdf-apagar', req.params.id); res.flash('PDF apagado.').redirect(`${B}/imagens#pdfs`); });
admin.post('/imagens/:id', async (req, res) => {
  await Sites.mediaUpdate(Number(req.params.id), { alt: req.body.alt, fx: req.body.fx, fy: req.body.fy });
  res.flash('Imagem salva.').redirect(`${B}/imagens`);
});
admin.post('/imagens/:id/apagar', async (req, res) => {
  const id = Number(req.params.id);
  for (const path of ['', ...(await Sites.landings()).map((x) => x.path)]) {
    const site = await Sites.draft(path); if (!site) continue;
    for (const s of site.sections) { if (s.image === id) s.image = null; for (const p of s.people || []) if (p.image === id) p.image = null; }
    if (site.seo.image === id) site.seo.image = null;
    await Sites.saveDraft(site, path);
  }
  await Sites.mediaDelete(id);
  await audit(req, 'site-imagem-apagar', String(id));
  res.flash('Imagem apagada. Se o site publicado usava esta imagem, publique de novo.').redirect(`${B}/imagens`);
});
admin.get(/^\/m\/(\d+)\/\d+\/(16x9|3x2|4x5|1x1|o)\/(\d+)\.(webp|svg)$/, (req, res, next) => { req.params = { id: req.params[0], aspect: req.params[1], w: req.params[2] }; sendMedia(req, res).catch(next); });

// ---------- Endereço ----------
admin.get('/endereco', async (req, res) => {
  const t = Tenancy.current(); const base = Sites.sitesDomain();
  const row = await Tenancy.pone('SELECT slug, site_slug FROM tenants WHERE id = ?', [t.id]);
  const rows = await D.list(t.id, 'site');
  const ips = await D.serverIps().catch(() => ({ v4: [] }));
  send(res, await shell(req, 'endereco', 'Endereço', html`
    <section class="card stack"><h2>Endereço grátis</h2>
      <form method="post" action="${B}/endereco/nome" class="site-slug"><label class="fld"><span>Nome no endereço</span>
        <span class="site-slug__in"><span class="muted">https://</span><input name="slug" value="${row?.site_slug || row?.slug}" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" maxlength="40" required><span class="muted">.${base}</span></span></label>
        <button class="btn ghost">Salvar endereço</button></form>
      <p class="muted small">Letras minúsculas, números e hífen. Ex.: <code>dra-ana-souza</code>. Ao trocar, o endereço antigo deixa de funcionar.</p></section>
    <section class="card stack"><h2>Domínio próprio</h2>
      <p class="muted small">Use um endereço seu (ex.: <code>anasouza.com.br</code>). O endereço grátis continua funcionando.</p>
      ${rows.length ? html`<ul class="list">${rows.map((r) => { const s = D.stateOf(r); return html`<li class="site-dom"><span><b>${r.domain}</b> <span class="badge b-${s.badge}">${s.label}</span>${r.last_check ? html`<br><small class="muted">${r.last_check}</small>` : ''}</span>
        <span class="actions"><form method="post" action="${B}/endereco/verificar"><input type="hidden" name="domain" value="${r.domain}"><button class="btn ghost btn-sm">Verificar agora</button></form>
        <form method="post" action="${B}/endereco/remover" data-confirm="Remover ${r.domain} do site?"><input type="hidden" name="domain" value="${r.domain}"><button class="btn ghost btn-sm danger-text">Remover</button></form></span></li>`; })}</ul>` : ''}
      <form method="post" action="${B}/endereco/dominio" class="site-slug"><label class="fld"><span>Cadastrar domínio</span><input name="domain" placeholder="seudominio.com.br" required></label><button class="btn">Cadastrar</button></form>
      <div class="site-dns"><p><b>Como apontar o domínio</b> (no Registro.br, Hostinger, Cloudflare ou onde o domínio foi comprado):</p>
        <table class="tbl"><thead><tr><th>Tipo</th><th>Nome</th><th>Valor</th></tr></thead><tbody>
          <tr><td>A</td><td>@ (o próprio domínio)</td><td><code>${ips.v4[0] || '—'}</code></td></tr>
          <tr><td>A</td><td>www</td><td><code>${ips.v4[0] || '—'}</code></td></tr></tbody></table>
        <p class="muted small">Apague outros registros A ou AAAA desses nomes. Na Cloudflare, deixe o proxy desligado (nuvem cinza). Depois de apontar, a Mentez confere sozinha a cada 10 minutos e ativa o HTTPS; o “www” passa a levar ao endereço sem www.</p></div>
    </section>`));
});
admin.post('/endereco/nome', async (req, res) => {
  try { await Sites.setSiteSlug(Tenancy.current().id, req.body.slug); await audit(req, 'site-endereco', str(req.body.slug, 40)); res.flash('Endereço do site salvo.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`${B}/endereco`);
});
admin.post('/endereco/dominio', async (req, res) => {
  try { const d = await D.add(Tenancy.current().id, req.body.domain, `clinica:${req.user?.email || req.user?.id || ''}`, 'site'); Sites.clearHostCache(); await audit(req, 'site-dominio', d); res.flash(`Domínio ${d} cadastrado. Agora crie os registros no DNS (veja abaixo).`); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`${B}/endereco`);
});
admin.post('/endereco/verificar', async (req, res) => {
  try { const r = await D.check(D.normalize(req.body.domain), Tenancy.current().id); Sites.clearHostCache(); res.flash(r.ok && r.https ? 'Tudo certo: o domínio já abre o site.' : (r.problems?.join(' ') || 'O DNS já aponta para a Mentez; o HTTPS está sendo ativado.'), r.ok ? 'ok' : 'warn'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`${B}/endereco`);
});
admin.post('/endereco/remover', async (req, res) => {
  try { const d = D.normalize(req.body.domain); await D.remove(Tenancy.current().id, d, `clinica:${req.user?.email || req.user?.id || ''}`); Sites.clearHostCache(); await audit(req, 'site-dominio-remover', d); res.flash('Domínio removido do site.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`${B}/endereco`);
});

// ---------- Google e privacidade ----------
ed.get('/seo', async (req, res) => {
  const site = await Sites.draft(req.sp); const media = await Sites.mediaList(); const url = (await Sites.siteUrl()) + (req.sp ? `/${req.sp}` : '');
  send(res, await shell(req, 'seo', 'Google e privacidade', html`
    ${req.sp ? html`<form method="post" action="${req.sb}/endereco" class="card site-slug"><label class="fld"><span>Nome interno da página</span><input name="name" value="${site.name}" maxlength="120" required></label>
      <label class="fld"><span>Endereço</span><span class="site-slug__in"><span class="muted">${url.replace(/^https:\/\//, '').replace(/\/[^/]*$/, '')}/</span><input name="path" value="${req.sp}" maxlength="60" pattern="[a-z0-9][a-z0-9-]{0,58}[a-z0-9]?" required></span></label>
      <button class="btn ghost">Salvar</button>
      <button class="btn ghost danger-text" formaction="${req.sb}/apagar" data-confirm-btn="Apagar esta landing page? Ela sai do ar e não dá para desfazer.">Apagar a página</button></form>` : ''}
    <form method="post" action="${req.sb}/seo" class="stack">
      <section class="card stack"><h2>Como o site aparece no Google e ao compartilhar</h2>
        <label class="fld"><span>Título <small class="muted">(até 70 letras: nome, profissão e cidade)</small></span><input name="title" value="${site.seo.title}" maxlength="70" data-count></label>
        <label class="fld"><span>Descrição <small class="muted">(até 160 letras)</small></span><textarea name="description" rows="2" maxlength="170" data-count>${site.seo.description}</textarea></label>
        <div class="fld"><span>Imagem ao compartilhar (WhatsApp, Instagram, Facebook)</span>${imgSelect('image', site.seo.image, media)}<small class="muted">Vazio = a foto da abertura.</small></div>
        <div class="site-serp" aria-hidden="true"><small>${url.replace(/^https:\/\//, '')}</small><b data-serp-title>${site.seo.title}</b><span data-serp-desc>${site.seo.description}</span></div>
        <label class="fld"><span>Código de verificação do Google Search Console <small class="muted">(opcional: só o código da meta tag)</small></span><input name="google" value="${site.seo.google}" maxlength="100" placeholder="ex.: AbC123..."></label>
        <p class="muted small">O site já sai com sitemap (<code>/sitemap.xml</code>), dados estruturados para o Google e endereço canônico. Depois de publicar, cadastre o site no Search Console e no Perfil da Empresa no Google.</p>
      </section>
      ${req.sp ? '' : html`<section class="card stack"><h2>Política de privacidade</h2>
        <p class="muted small">Gerada automaticamente com os dados da clínica (LGPD) e ligada no rodapé do site. <a href="${req.sb}/previa/privacidade" target="_blank" rel="noopener">Ver a política</a>.</p>
        <label class="fld"><span>Informações adicionais (opcional)</span><textarea name="extra" rows="4" maxlength="4000" placeholder="Ex.: prazo de guarda de mensagens, contato do encarregado de dados…">${site.privacy.extra}</textarea></label>
      </section>`}
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>`));
});
ed.post('/seo', async (req, res) => {
  const site = await Sites.draft(req.sp);
  await Sites.saveDraft({ ...site, seo: { title: req.body.title, description: req.body.description, image: req.body.image, google: req.body.google }, privacy: { extra: req.body.extra } }, req.sp);
  await audit(req, 'site-seo');
  res.flash('Salvo no rascunho.').redirect(`${req.sb}/seo`);
});
ed.post('/endereco', async (req, res) => {
  if (!req.sp) return res.redirect(B);
  try {
    const site = await Sites.draft(req.sp); await Sites.saveDraft({ ...site, name: str(req.body.name, 120) || site.name }, req.sp);
    const np = await Sites.renameLanding(req.sp, str(req.body.path, 60) || req.sp);
    await audit(req, 'site-landing-endereco', np); res.flash('Página salva.').redirect(`${B}/lp/${np}/seo`);
  } catch (e) { res.flash(e.message, 'err').redirect(`${req.sb}/seo`); }
});
ed.post('/apagar', async (req, res) => {
  if (!req.sp) return res.redirect(B);
  await Sites.deleteLanding(req.sp); await audit(req, 'site-landing-apagar', req.sp);
  res.flash('Landing page apagada.').redirect(`${B}/landing`);
});

// ---------- Versões publicadas ----------
ed.get('/versoes', async (req, res) => {
  const list = await Sites.versions(req.sp);
  send(res, await shell(req, 'versoes', 'Versões', html`<section class="card"><h2>Versões publicadas</h2>
    <p class="muted small">Cada vez que você publica, a versão fica guardada (as 15 últimas). Dá para ver como estava e trazer de volta para o rascunho; depois é só publicar de novo.</p>
    ${list.length ? html`<ul class="list">${list.map((v, i) => html`<li class="site-dom"><span><b>${brDateTime(v.created_at)}</b>${i === 0 ? html` <span class="badge b-realizada">atual</span>` : ''}<br><small class="muted">${v.user_name ? `por ${v.user_name}` : ''}</small></span>
      <span class="actions"><a class="btn ghost btn-sm" href="${req.sb}/versoes/${v.id}" target="_blank" rel="noopener">Ver</a>
      <form method="post" action="${req.sb}/versoes/${v.id}/restaurar" data-confirm="Trazer esta versão para o rascunho? O rascunho atual é substituído (o que está no ar não muda até você publicar)."><button class="btn ghost btn-sm">Restaurar no rascunho</button></form></span></li>`)}</ul>` : html`<p class="muted">Nenhuma versão ainda: elas aparecem aqui depois da primeira publicação.</p>`}</section>`));
});
ed.get('/versoes/:id', async (req, res) => {
  const site = await Sites.version(Number(req.params.id), req.sp); if (!site) return res.status(404).send('Versão não encontrada.');
  siteHeaders(res, clinicBase());
  res.type('html').send(R.render(site, await context(site, { preview: true, mediaBase: `${B}/m`, path: req.sp })));
});
ed.post('/versoes/:id/restaurar', async (req, res) => {
  const site = await Sites.version(Number(req.params.id), req.sp); if (!site) return res.redirect(`${req.sb}/versoes`);
  await Sites.saveDraft(site, req.sp); await audit(req, 'site-versao-restaurar', String(req.params.id));
  res.flash('Versão trazida para o rascunho. Veja a prévia e publique quando quiser.').redirect(`${req.sb}/versoes`);
});

// ---------- prévia e publicação ----------
ed.get('/previa', async (req, res) => {
  const site = await Sites.draft(req.sp);
  siteHeaders(res, clinicBase());
  res.set('Content-Security-Policy', String(res.get('Content-Security-Policy')).replace("frame-ancestors 'none'", "frame-ancestors 'self'")).removeHeader('X-Frame-Options');
  res.type('html').send(R.render(site, await context(site, { preview: true, mediaBase: `${B}/m`, path: req.sp })));
});
ed.get('/previa/privacidade', async (req, res) => {
  const site = await Sites.draft(req.sp);
  siteHeaders(res, clinicBase());
  res.type('html').send(R.privacy(site, await context(site, { preview: true, mediaBase: `${B}/m` })));
});
ed.post('/publicar', async (req, res) => {
  await Sites.publish(req.sp, req.user?.id || null); await audit(req, req.sp ? 'site-landing-publicar' : 'site-publicar', req.sp || null);
  const url = (await Sites.siteUrl()) + (req.sp ? `/${req.sp}` : '');
  let back = req.sb; try { const r = new URL(String(req.get('referer') || '')); if (r.pathname.startsWith(req.sb) && !r.pathname.includes('/previa')) back = r.pathname; } catch { /* sem referer */ }
  res.flash(`${req.sp ? 'Página publicada' : 'Site publicado'}${url ? `: ${url.replace(/^https:\/\//, '')}` : ''}.`).redirect(back);
});
ed.post('/despublicar', async (req, res) => { await Sites.unpublish(req.sp); await audit(req, 'site-despublicar', req.sp || null); res.flash(req.sp ? 'Página fora do ar.' : 'Site fora do ar.').redirect(req.sb); });

// ---------- Landing pages ----------
admin.get('/landing', async (req, res) => {
  const list = await Sites.landings(); const base = await Sites.siteUrl();
  send(res, await shell(req, 'landing', 'Landing pages', html`
    <section class="card"><h2>Suas landing pages</h2>
      <p class="muted small">Páginas com um objetivo só, para anúncios, Instagram ou eventos. Usam as imagens do site e o mesmo endereço (ex.: <code>${base.replace(/^https:\/\//, '')}/workshop-ansiedade</code>). Os contatos do formulário entram no CRM com a origem da visita.</p>
      ${list.length ? html`<ul class="list">${list.map((x) => html`<li class="site-dom"><span><a href="${B}/lp/${x.path}"><b>${x.name}</b></a> ${x.live ? html`<span class="badge b-realizada">No ar</span>` : html`<span class="badge b-agendada">Rascunho</span>`}<br><small class="muted">/${x.path}</small></span>
        <span class="actions">${x.live ? html`<a class="btn ghost btn-sm" href="${base}/${x.path}" target="_blank" rel="noopener">Abrir</a>` : ''}<a class="btn btn-sm" href="${B}/lp/${x.path}">Editar</a>
          <form method="post" action="${B}/lp/${x.path}/apagar" data-confirm="Apagar a landing page “${x.name}”? Ela sai do ar e não dá para desfazer (os contatos que já chegaram continuam no CRM)."><button class="btn ghost btn-sm danger-text">Apagar</button></form></span></li>`)}</ul>` : html`<p class="muted">Nenhuma ainda.</p>`}
    </section>
    <form method="post" action="${B}/landing" class="card stack"><h2>Criar landing page</h2>
      <label class="fld"><span>Nome (também vira o endereço)</span><input name="name" required maxlength="120" placeholder="Ex.: Workshop de ansiedade"></label>
      <div class="site-motions">${Object.entries(Sites.TEMPLATES).map(([k, t], i) => html`<label class="site-style site-motion"><input type="radio" name="tpl" value="${k}" ${i === 0 ? raw('checked') : ''}><b>${t.name}</b><small class="muted">${t.desc}</small></label>`)}</div>
      <p class="muted small">A página começa com o visual do site e textos de exemplo para você ajustar. Ela só vai ao ar quando você publicar.</p>
      <div class="actions"><button class="btn">Criar</button></div></form>`));
});
admin.post('/landing', async (req, res) => {
  try { const path = await Sites.createLanding(str(req.body.tpl, 20), str(req.body.name, 120) || 'Nova página'); await audit(req, 'site-landing-criar', path); res.flash('Landing page criada. Ajuste os textos e publique.').redirect(`${B}/lp/${path}`); } catch (e) { res.flash(e.message, 'err').redirect(`${B}/landing`); }
});

// ---------- Resultados ----------
admin.get('/resultados', async (req, res) => {
  const days = [7, 30, 90].includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;
  const r = await Lead.report(days);
  const names = Object.fromEntries((await Sites.landings()).map((x) => [x.path, x.name]));
  const contacts = r.tot.wa + r.tot.book + r.tot.form;
  const conv = r.tot.view ? `${((contacts / r.tot.view) * 100).toFixed(1).replace('.', ',')}%` : '—';
  const series = []; for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - 3 * 3600e3 - i * 86400e3).toISOString().slice(0, 10); series.push([d, r.byDay[d] || { view: 0, act: 0 }]); }
  const max = Math.max(1, ...series.map(([, v]) => v.view));
  const rank = (o) => Object.entries(o).sort((a, b) => b[1].view + b[1].act * 10 - (a[1].view + a[1].act * 10)).slice(0, 12);
  const SRC = { direto: 'Direto (digitou ou link salvo)', google: 'Google', instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', bing: 'Bing', linkedin: 'LinkedIn', tiktok: 'TikTok', youtube: 'YouTube', doctoralia: 'Doctoralia' };
  send(res, await shell(req, 'resultados', 'Resultados', html`
    <nav class="chips site-period">${[7, 30, 90].map((d) => html`<a class="chip ${d === days ? 'on' : ''}" href="${B}/resultados?dias=${d}">${d} dias</a>`)}</nav>
    <section class="kpis site-kpis">
      <div class="kpi"><small>Visitas</small><b>${r.tot.view}</b></div>
      <div class="kpi"><small>Cliques no WhatsApp</small><b>${r.tot.wa}</b></div>
      <div class="kpi"><small>Agendamentos on-line</small><b>${r.tot.book}</b></div>
      <div class="kpi"><small>Formulários enviados</small><b>${r.tot.form}</b></div>
      <div class="kpi"><small>Conversão (contatos ÷ visitas)</small><b>${conv}</b></div>
    </section>
    <section class="card"><h2>Visitas por dia</h2>
      <div class="site-bars" role="img" aria-label="Visitas por dia nos últimos ${days} dias">${series.map(([d, v]) => html`<span title="${d.slice(8, 10)}/${d.slice(5, 7)}: ${v.view} visita(s), ${v.act} contato(s)"><i style="height:${Math.round((v.view / max) * 100)}%"></i>${v.act ? html`<b style="height:${Math.min(100, Math.round((v.act / max) * 100) + 6)}%"></b>` : ''}</span>`)}</div>
      <p class="muted small"><i class="site-lg site-lg--v"></i> visitas · <i class="site-lg site-lg--a"></i> contatos (WhatsApp, agendamento e formulário)</p></section>
    <div class="grid2">
      <section class="card"><h2>De onde vêm</h2>${Object.keys(r.bySrc).length ? html`<table class="tbl"><thead><tr><th>Origem</th><th>Visitas</th><th>Contatos</th></tr></thead><tbody>${rank(r.bySrc).map(([k, v]) => html`<tr><td>${SRC[k] || k}</td><td>${v.view}</td><td>${v.act}</td></tr>`)}</tbody></table>` : html`<p class="muted">Sem dados ainda.</p>`}
        <p class="muted small">Para saber qual anúncio ou post trouxe a pessoa, use links com <code>?utm_source=instagram&amp;utm_campaign=nome</code>.</p></section>
      <section class="card"><h2>Páginas</h2>${Object.keys(r.byPath).length ? html`<table class="tbl"><thead><tr><th>Página</th><th>Visitas</th><th>Contatos</th></tr></thead><tbody>${rank(r.byPath).map(([k, v]) => html`<tr><td>${k ? names[k] || `/${k}` : 'Página inicial'}</td><td>${v.view}</td><td>${v.act}</td></tr>`)}</tbody></table>` : html`<p class="muted">Sem dados ainda.</p>`}</section>
    </div>
    ${Object.keys(r.ab).length ? html`<section class="card"><h2>Teste A/B dos títulos</h2>
      <table class="tbl"><thead><tr><th>Página</th><th>Título</th><th>Visitas</th><th>Contatos</th><th>Conversão</th></tr></thead><tbody>
      ${Object.entries(r.ab).map(([k, v]) => { const cv = (x) => (x.view ? (x.act / x.view) * 100 : 0); const best = cv(v.a) === cv(v.b) ? '' : cv(v.a) > cv(v.b) ? 'a' : 'b'; return ['a', 'b'].map((x) => html`<tr><td>${x === 'a' ? (k ? names[k] || `/${k}` : 'Página inicial') : ''}</td><td>${x === 'a' ? 'Principal (A)' : 'Alternativo (B)'}${best === x && (v.a.view + v.b.view) >= 40 ? html` <span class="badge b-realizada">melhor</span>` : ''}</td><td>${v[x].view}</td><td>${v[x].act}</td><td>${v[x].view ? `${cv(v[x]).toFixed(1).replace('.', ',')}%` : '—'}</td></tr>`); })}
      </tbody></table><p class="muted small">O “melhor” aparece a partir de 40 visitas somadas. Quando um título vencer com folga, deixe só ele (apague o título alternativo) e publique.</p></section>` : ''}
    <p class="muted small">Contagem sem cookies e sem guardar dados de quem visita (LGPD). Robôs de busca não entram na conta. Os contatos do formulário ficam no <a href="/crm">CRM</a>.</p>`));
});



// ---------- IA nos textos ----------
admin.post('/ia/secao', express.json({ limit: '20kb' }), async (req, res) => {
  const b = req.body || {};
  const about = (await Sites.draft())?.sections.find((x) => x.type === 'sobre')?.text || '';
  const r = await SAI.sectionText({ section: str(b.section, 80), label: str(b.label, 120), kind: b.kind === 'text' ? 'text' : 'area', current: str(b.current, 3000), about, tone: str(b.tone, 20), userId: req.user.id });
  res.status(r.ok ? 200 : 400).json(r);
});

// ---------- Blog ----------
const postForm = async (req, p) => {
  const media = await Sites.mediaList(); const base = await Sites.siteUrl();
  return html`<form method="post" action="${B}/blog/${p.id || 'novo'}" class="stack site-post">
    <section class="card stack">
      <label class="fld"><span>Título</span><input name="title" value="${p.title || ''}" maxlength="160" required></label>
      <label class="fld"><span>Resumo <small class="muted">(aparece na lista de artigos e ao compartilhar)</small></span><textarea name="excerpt" rows="2" maxlength="300">${p.excerpt || ''}</textarea></label>
      <div class="fld"><span>Imagem de capa</span>${imgSelect('cover', p.cover, media)}</div>
      <label class="fld"><span>Texto</span><textarea name="body" rows="22" class="site-post__body">${p.body || ''}</textarea></label>
      <p class="muted small">Formatação: linha em branco separa parágrafos · <code>## Subtítulo</code> · <code>- item de lista</code> · <code>**negrito**</code> · <code>*itálico*</code> · <code>&gt; citação</code> · <code>[texto do link](https://…)</code></p>
    </section>
    <section class="card stack"><h2>Google</h2>
      <label class="fld"><span>Endereço do artigo</span><span class="site-slug__in"><span class="muted">${base.replace(/^https:\/\//, '')}/blog/</span><input name="slug" value="${p.slug || ''}" maxlength="90" placeholder="(gerado pelo título)"></span></label>
      <label class="fld"><span>Descrição para o Google <small class="muted">(até 160 letras)</small></span><textarea name="seo" rows="2" maxlength="170">${p.seo || ''}</textarea></label>
    </section>
    <div class="actions site-save">
      <label class="fld check"><input type="radio" name="status" value="rascunho" ${p.status !== 'publicado' ? raw('checked') : ''}><span>Rascunho</span></label>
      <label class="fld check"><input type="radio" name="status" value="publicado" ${p.status === 'publicado' ? raw('checked') : ''}><span>Publicado</span></label>
      <button class="btn">Salvar</button>
      ${p.id ? html`<a class="btn ghost" href="${B}/blog/${p.id}/previa" target="_blank" rel="noopener">Ver prévia</a>${p.status === 'publicado' ? html`<a class="btn ghost" href="${base}/blog/${p.slug}" target="_blank" rel="noopener">Abrir no site</a>` : ''}
        <button class="btn ghost danger-text" formaction="${B}/blog/${p.id}/apagar" data-confirm-btn="Apagar este artigo?">Apagar</button>` : ''}
    </div></form>`;
};
admin.get('/blog', async (req, res) => {
  const posts = await Blog.list(); const base = await Sites.siteUrl();
  send(res, await shell(req, 'blog', 'Blog', html`
    <form method="post" action="${B}/blog/ia" class="card stack site-blog-ai"><h2>✨ Escrever um artigo com IA</h2>
      <p class="muted small">Diga o tema e a IA escreve um rascunho completo (título, resumo, texto e descrição para o Google), seguindo as normas de publicidade da psicologia. Você revisa, ajusta com a sua voz e publica.</p>
      <div class="form-grid"><label class="fld"><span>Tema</span><input name="topic" required maxlength="300" placeholder="Ex.: Como diferenciar ansiedade normal de um transtorno de ansiedade"></label>
        <label class="fld"><span>Para quem <small class="muted">(opcional)</small></span><input name="audience" maxlength="200" placeholder="Ex.: mães de primeira viagem"></label>
        <label class="fld"><span>Tom</span><select name="tone">${Object.entries(SAI.TONES).map(([k, l]) => html`<option value="${k}" ${k === 'claro' ? raw('selected') : ''}>${l}</option>`)}</select></label></div>
      <div class="actions"><button class="btn" data-busy="Escrevendo… pode levar até 1 minuto">Escrever rascunho</button><a class="btn ghost" href="${B}/blog/novo">Escrever do zero</a></div></form>
    <section class="card"><h2>Artigos</h2>
      ${posts.length ? html`<ul class="list">${posts.map((p) => html`<li class="site-dom"><span><a href="${B}/blog/${p.id}"><b>${p.title}</b></a> ${p.status === 'publicado' ? html`<span class="badge b-realizada">Publicado</span>` : html`<span class="badge b-agendada">Rascunho</span>`}<br><small class="muted">${p.published_at ? brDateTime(p.published_at) : 'não publicado'}${p.author ? ` · ${p.author}` : ''}</small></span>
        <span class="actions">${p.status === 'publicado' ? html`<a class="btn ghost btn-sm" href="${base}/blog/${p.slug}" target="_blank" rel="noopener">Abrir</a>` : ''}<a class="btn btn-sm" href="${B}/blog/${p.id}">Editar</a></span></li>`)}</ul>` : html`<p class="muted">Nenhum artigo ainda. O link “Blog” aparece no menu do site quando o primeiro artigo for publicado.</p>`}
    </section>`));
});
admin.post('/blog/ia', async (req, res) => {
  const r = await SAI.blogPost({ topic: str(req.body.topic, 300), audience: str(req.body.audience, 200), tone: str(req.body.tone, 20), userId: req.user.id });
  if (!r.ok) return res.flash(r.error || 'Não foi possível escrever agora.', 'err').redirect(`${B}/blog`);
  const p = await Blog.save(null, { title: r.title, excerpt: r.excerpt, seo: r.seo, body: r.body, status: 'rascunho' }, req.user.id);
  await audit(req, 'site-blog-ia', String(p.id));
  res.flash(`Rascunho escrito pela IA. Revise com atenção antes de publicar${r.risks?.length ? ` (atenção: ${r.risks.join(', ')})` : ''}.`, r.risks?.length ? 'warn' : 'ok').redirect(`${B}/blog/${p.id}`);
});
admin.get('/blog/novo', async (req, res) => send(res, await shell(req, 'blog', 'Novo artigo', await postForm(req, { status: 'rascunho' }))));
admin.get('/blog/:id', async (req, res, next) => {
  const p = await Blog.byId(Number(req.params.id)); if (!p) return next();
  send(res, await shell(req, 'blog', p.title, await postForm(req, p)));
});
admin.post('/blog/:id', async (req, res) => {
  const id = req.params.id === 'novo' ? null : Number(req.params.id);
  try { const p = await Blog.save(id, req.body, req.user.id); await audit(req, 'site-blog-salvar', String(p.id)); res.flash(p.status === 'publicado' ? 'Artigo publicado.' : 'Rascunho salvo.').redirect(`${B}/blog/${p.id}`); } catch (e) { res.flash(e.message, 'err').redirect(id ? `${B}/blog/${id}` : `${B}/blog/novo`); }
});
admin.post('/blog/:id/apagar', async (req, res) => { await Blog.remove(Number(req.params.id)); await audit(req, 'site-blog-apagar', req.params.id); res.flash('Artigo apagado.').redirect(`${B}/blog`); });
admin.get('/blog/:id/previa', async (req, res, next) => {
  const p = await Blog.byId(Number(req.params.id)); if (!p) return next();
  const site = await Sites.draft();
  siteHeaders(res, clinicBase());
  const ctx = await context(site, { preview: true, mediaBase: `${B}/m` });
  ctx.page = { blog: true, path: `blog/${p.slug}`, title: p.title, desc: p.seo || '', main: R.blogPost({ ...p, published_at: p.published_at || new Date() }, [], ctx, Blog.md) };
  res.type('html').send(R.render(site, ctx));
});



// ---------- importar site existente ----------
admin.post('/importar', async (req, res) => {
  try {
    const f = await Import.fromUrl(str(req.body.url, 300), { images: !!req.body.imgs });
    const site = await Sites.draft();
    const done = Import.apply(site, f);
    if (!done.length) throw new Error('Não encontramos textos para importar nesta página.');
    await Sites.saveDraft(site); await audit(req, 'site-importar', f.host);
    res.flash(`Importado de ${f.host}: ${done.join(', ')}. Revise o rascunho e veja a prévia.`);
  } catch (e) { res.flash(`Não foi possível importar: ${e.message}`, 'err'); }
  res.redirect(B);
});

// landing page em edição: as mesmas telas do site, em /marketing/site/lp/<endereço>/…
admin.use('/lp/:path', async (req, res, next) => {
  const p = String(req.params.path || '');
  if (!Sites.pathOk(p) || !(await Sites.state(p)).exists) return res.status(404).redirect(`${B}/landing`);
  req.sp = p; req.sb = `${B}/lp/${p}`; next();
}, ed);
admin.use(ed);
