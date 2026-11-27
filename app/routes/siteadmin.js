// Marketing → Site: editor do site da clínica (conteúdo por seções, aparência, imagens, endereço, SEO) e publicação.
import express from 'express';
import * as Tenancy from '../lib/tenancy.js';
import * as Brand from '../lib/brand.js';
import * as D from '../lib/domains.js';
import * as Sites from '../lib/sites.js';
import * as R from '../lib/siterender.js';
import { context, siteHeaders, sendMedia, clinicBase } from './sitepub.js';
import { audit } from '../lib/db.js';
import { page, html, raw, brDateTime, VERSION } from '../lib/html.js';
import { router, send, str } from '../lib/router.js';

export const admin = router();
const B = '/marketing/site';
const ck = (v) => (v ? raw('checked') : '');
const arr = (v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]) : []);
const kb = (n) => (n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const TABS = [['', 'Conteúdo'], ['aparencia', 'Aparência'], ['imagens', 'Imagens'], ['endereco', 'Endereço'], ['seo', 'Google e privacidade']];
async function shell(req, tab, title, body) {
  const st = await Sites.state();
  const url = await Sites.siteUrl();
  const status = !st.published ? html`<span class="badge b-agendada">Ainda não publicado</span>` : st.pending ? html`<span class="badge b-confirmada">No ar · há alterações não publicadas</span>` : html`<span class="badge b-realizada">No ar</span>`;
  return page(req, { title: `Site · ${title}`, active: 'marketing', body: html`
    <header class="ph"><div><p class="eyebrow">Marketing</p><h1>Site</h1>
      <p class="muted">Monte o site do consultório por seções prontas: escolha o visual, ajuste os textos e publique. ${status}</p></div>
      <div class="ph-actions"><a class="btn ghost" href="${B}/previa" target="_blank" rel="noopener">Ver prévia</a>
        <form method="post" action="${B}/publicar" class="inline"><button class="btn">${st.published ? 'Publicar alterações' : 'Publicar o site'}</button></form></div></header>
    <section class="card site-status">
      <div><p class="muted small">Endereço do site</p>${url ? html`<p class="site-url"><a href="${url}" target="_blank" rel="noopener">${url.replace(/^https:\/\//, '')}</a> <button class="chip" type="button" data-copy-text="${url}">Copiar</button></p>` : html`<p>—</p>`}</div>
      <div><p class="muted small">Situação</p><p>${st.published ? html`Publicado em ${brDateTime(st.at)}` : 'Rascunho: ninguém vê ainda'}</p></div>
      ${st.published ? html`<form method="post" action="${B}/despublicar" data-confirm="Tirar o site do ar? Quem abrir o endereço verá “Site em construção”."><button class="btn ghost btn-sm">Tirar do ar</button></form>` : ''}
    </section>
    <nav class="tabs">${TABS.map(([k, l]) => html`<a href="${B}${k ? `/${k}` : ''}" class="${tab === k ? 'on' : ''}">${l}</a>`)}</nav>
    ${body}
    <script src="/static/site-admin.js?v=${VERSION}" defer></script>` });
}

// ---------- Conteúdo ----------
const imgSelect = (name, val, media) => html`<span class="site-imgsel"><select name="${name}" data-imgsel><option value="">Sem imagem</option>${media.filter((m) => m.kind === 'img' || m.kind === 'svg').map((m) => html`<option value="${m.id}" data-thumb="${B}/m/${m.id}/${m.v}/o/480.${m.kind === 'svg' ? 'svg' : 'webp'}" ${Number(val) === m.id ? raw('selected') : ''}>${m.name || `Imagem ${m.id}`}</option>`)}</select><img class="site-imgsel__th" alt="" hidden></span>`;
function field(i, s, [k, label, kind], media) {
  const n = `s[${i}][${k}]`;
  const v = s[k];
  if (kind === 'text') return html`<label class="fld"><span>${label}</span><input name="${n}" value="${v || ''}" maxlength="200"></label>`;
  if (kind === 'area') return html`<label class="fld"><span>${label}</span><textarea name="${n}" rows="4" maxlength="3000">${v || ''}</textarea></label>`;
  if (kind === 'lines') return html`<label class="fld"><span>${label}</span><textarea name="${n}" rows="3">${(v || []).join('\n')}</textarea></label>`;
  if (kind === 'check') return html`<label class="fld check"><input type="checkbox" name="${n}" value="1" ${ck(v)}><span>${label}</span></label>`;
  if (kind === 'image') return html`<div class="fld"><span>${label}</span>${imgSelect(n, v, media)}</div>`;
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
admin.get('/', async (req, res) => {
  const site = await Sites.draft();
  const media = await Sites.mediaList();
  const bk = await (await import('../lib/booking.js')).config().catch(() => ({ enabled: false }));
  send(res, await shell(req, '', 'Conteúdo', html`
    <form method="post" action="${B}/conteudo" class="stack site-form">
      <p class="muted small">Marque as seções que aparecem no site e use as setas para mudar a ordem. Os textos começam com sugestões a partir dos dados da clínica: revise e escreva com a sua voz. Imagens: envie na aba <a href="${B}/imagens">Imagens</a> e escolha aqui.</p>
      ${site.sections.map((s, i) => { const def = Sites.SECTIONS[s.type]; return html`<section class="card site-sec ${s.on ? '' : 'is-off'}">
        <input type="hidden" name="s[${i}][type]" value="${s.type}">
        <div class="site-sec__head"><label class="check"><input type="checkbox" name="s[${i}][on]" value="1" ${ck(s.on)} data-sec-on> <b>${def.label}</b></label>
          ${s.type === 'agendamento' && !bk.enabled ? html`<small class="muted">Ligue o agendamento on-line em <a href="/configuracoes/agendamento-online">Configurações</a> para esta seção aparecer.</small>` : ''}
          <span class="site-sec__moves"><button class="chip" name="move" value="${i}:up" ${i === 0 ? raw('disabled') : ''} aria-label="Subir ${def.label}">↑</button><button class="chip" name="move" value="${i}:down" ${i === site.sections.length - 1 ? raw('disabled') : ''} aria-label="Descer ${def.label}">↓</button></span></div>
        <details ${s.type === 'inicio' ? raw('open') : ''}><summary>Editar</summary><div class="stack site-sec__body">${def.fields.map((f) => field(i, s, f, media))}</div></details>
      </section>`; })}
      <div class="actions site-save"><button class="btn">Salvar rascunho</button><a class="btn ghost" href="${B}/previa" target="_blank" rel="noopener">Ver prévia</a></div>
    </form>`));
});
admin.post('/conteudo', async (req, res) => {
  const site = await Sites.draft();
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
  await Sites.saveDraft({ ...site, sections: next.length ? next : site.sections });
  await audit(req, 'site-conteudo');
  res.flash(dir ? 'Ordem alterada.' : 'Rascunho salvo. Veja a prévia e publique quando estiver pronto.').redirect(B);
});

// ---------- Aparência ----------
admin.get('/aparencia', async (req, res) => {
  const site = await Sites.draft(); const b = Brand.get();
  send(res, await shell(req, 'aparencia', 'Aparência', html`
    <form method="post" action="${B}/aparencia" class="stack">
      <section class="card"><h2>Layout</h2><p class="muted small">A estrutura do site: como a abertura e as seções são apresentadas.</p>
        <div class="site-layouts">${Object.entries(Sites.LAYOUTS).map(([k, l]) => html`<label class="site-layout"><input type="radio" name="layout" value="${k}" ${ck(site.layout === k)} data-motion="${l.motion ? 1 : 0}">
          <span class="site-mock site-mock--${k}" aria-hidden="true"><i class="m-top"></i><i class="m-hero"></i><i class="m-img"></i><i class="m-row"></i><i class="m-row m-row2"></i></span>
          <b>${l.name}${l.motion ? html` <span class="badge b-confirmada">Animado</span>` : ''}</b><small class="muted">${l.desc}</small></label>`)}</div></section>
      <section class="card"><h2>Animações</h2><p class="muted small">Vale para qualquer layout; os marcados como “Animado” têm efeitos próprios (aurora, respiração, fotos flutuando, faixa de temas). Quem configurou o aparelho para “reduzir movimento” sempre vê o site parado.</p>
        <div class="site-motions">${Object.entries(Sites.MOTION).map(([k, m]) => html`<label class="site-style site-motion"><input type="radio" name="motion" value="${k}" ${ck(site.motion === k)}>
          <span class="site-mo site-mo--${k}" aria-hidden="true"><i></i><i></i><i></i></span><b>${m.name}</b><small class="muted">${m.desc}</small></label>`)}</div></section>
      <section class="card"><h2>Estilo</h2><p class="muted small">Cores e fontes. “Cores da marca” usa a cor principal cadastrada em <a href="/configuracoes/identidade">Identidade visual</a>${b.color ? '' : ' (nenhuma cadastrada ainda)'}. O contraste é ajustado automaticamente para a leitura ficar confortável.</p>
        <div class="site-styles">${Object.entries(Sites.STYLES).map(([k, st]) => { const p = Sites.palette({ style: k, layout: 'editorial' }, b); return html`<label class="site-style"><input type="radio" name="style" value="${k}" ${ck(site.style === k)}>
          <span class="site-sw" style="background:${p.bg};color:${p.ink}"><span class="site-sw__aa" style="font-family:'${p.serif}',Georgia,serif">Aa</span><span class="site-sw__dot" style="background:${p.accent}"></span></span>
          <b>${st.name}</b><small class="muted">${p.serif}${p.serif !== p.sans ? ` + ${p.sans}` : ''}</small></label>`; })}</div></section>
      <div class="actions"><button class="btn">Salvar aparência</button><a class="btn ghost" href="${B}/previa" target="_blank" rel="noopener">Ver prévia</a></div>
    </form>`));
});
admin.post('/aparencia', async (req, res) => {
  const site = await Sites.draft();
  await Sites.saveDraft({ ...site, layout: str(req.body.layout, 20), style: str(req.body.style, 20), motion: str(req.body.motion, 10) || site.motion });
  await audit(req, 'site-aparencia');
  res.flash('Aparência salva no rascunho.').redirect(`${B}/aparencia`);
});

// ---------- Imagens ----------
admin.get('/imagens', async (req, res) => {
  const site = await Sites.draft(); const used = Sites.usedMedia(site);
  const list = await Sites.mediaList();
  send(res, await shell(req, 'imagens', 'Imagens', html`
    <section class="card site-up" data-site-upload="${B}/imagens">
      <h2>Enviar imagens</h2>
      <p class="muted small">JPG, PNG, WebP ou HEIC (fotos do celular) até 15 MB; SVG para logos e ícones. As fotos são convertidas para <b>WebP</b> e recortadas nos tamanhos de cada espaço da página. Os dados escondidos da foto (localização GPS, aparelho, data) são apagados.</p>
      <label class="site-drop"><input type="file" accept="image/*,.heic,.heif,.svg" multiple data-site-file hidden><span>Arraste as imagens para cá ou <u>escolha no computador</u></span></label>
      <div class="site-up__log" data-site-log aria-live="polite"></div>
    </section>
    <section class="card"><h2>Biblioteca <small class="muted">(${list.length} de ${Sites.MAX_MEDIA})</small></h2>
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
admin.post('/imagens/:id', async (req, res) => {
  await Sites.mediaUpdate(Number(req.params.id), { alt: req.body.alt, fx: req.body.fx, fy: req.body.fy });
  res.flash('Imagem salva.').redirect(`${B}/imagens`);
});
admin.post('/imagens/:id/apagar', async (req, res) => {
  const id = Number(req.params.id);
  const site = await Sites.draft();
  for (const s of site.sections) { if (s.image === id) s.image = null; for (const p of s.people || []) if (p.image === id) p.image = null; }
  if (site.seo.image === id) site.seo.image = null;
  await Sites.saveDraft(site);
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
admin.get('/seo', async (req, res) => {
  const site = await Sites.draft(); const media = await Sites.mediaList(); const url = await Sites.siteUrl();
  send(res, await shell(req, 'seo', 'Google e privacidade', html`
    <form method="post" action="${B}/seo" class="stack">
      <section class="card stack"><h2>Como o site aparece no Google e ao compartilhar</h2>
        <label class="fld"><span>Título <small class="muted">(até 70 letras: nome, profissão e cidade)</small></span><input name="title" value="${site.seo.title}" maxlength="70" data-count></label>
        <label class="fld"><span>Descrição <small class="muted">(até 160 letras)</small></span><textarea name="description" rows="2" maxlength="170" data-count>${site.seo.description}</textarea></label>
        <div class="fld"><span>Imagem ao compartilhar (WhatsApp, Instagram, Facebook)</span>${imgSelect('image', site.seo.image, media)}<small class="muted">Vazio = a foto da abertura.</small></div>
        <div class="site-serp" aria-hidden="true"><small>${url.replace(/^https:\/\//, '')}</small><b data-serp-title>${site.seo.title}</b><span data-serp-desc>${site.seo.description}</span></div>
        <label class="fld"><span>Código de verificação do Google Search Console <small class="muted">(opcional: só o código da meta tag)</small></span><input name="google" value="${site.seo.google}" maxlength="100" placeholder="ex.: AbC123..."></label>
        <p class="muted small">O site já sai com sitemap (<code>/sitemap.xml</code>), dados estruturados para o Google e endereço canônico. Depois de publicar, cadastre o site no Search Console e no Perfil da Empresa no Google.</p>
      </section>
      <section class="card stack"><h2>Política de privacidade</h2>
        <p class="muted small">Gerada automaticamente com os dados da clínica (LGPD) e ligada no rodapé do site. <a href="${B}/previa/privacidade" target="_blank" rel="noopener">Ver a política</a>.</p>
        <label class="fld"><span>Informações adicionais (opcional)</span><textarea name="extra" rows="4" maxlength="4000" placeholder="Ex.: prazo de guarda de mensagens, contato do encarregado de dados…">${site.privacy.extra}</textarea></label>
      </section>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>`));
});
admin.post('/seo', async (req, res) => {
  const site = await Sites.draft();
  await Sites.saveDraft({ ...site, seo: { title: req.body.title, description: req.body.description, image: req.body.image, google: req.body.google }, privacy: { extra: req.body.extra } });
  await audit(req, 'site-seo');
  res.flash('Salvo no rascunho.').redirect(`${B}/seo`);
});

// ---------- prévia e publicação ----------
admin.get('/previa', async (req, res) => {
  const site = await Sites.draft();
  siteHeaders(res, clinicBase());
  res.set('Content-Security-Policy', String(res.get('Content-Security-Policy')).replace("frame-ancestors 'none'", "frame-ancestors 'self'")).removeHeader('X-Frame-Options');
  res.type('html').send(R.render(site, await context(site, { preview: true, mediaBase: `${B}/m` })));
});
admin.get('/previa/privacidade', async (req, res) => {
  const site = await Sites.draft();
  siteHeaders(res, clinicBase());
  res.type('html').send(R.privacy(site, await context(site, { preview: true, mediaBase: `${B}/m` })));
});
admin.post('/publicar', async (req, res) => {
  await Sites.publish(); await audit(req, 'site-publicar');
  const url = await Sites.siteUrl();
  let back = B; try { const r = new URL(String(req.get('referer') || '')); if (r.pathname.startsWith(B) && !r.pathname.includes('/previa')) back = r.pathname; } catch { /* sem referer */ }
  res.flash(`Site publicado${url ? `: ${url.replace(/^https:\/\//, '')}` : ''}.`).redirect(back);
});
admin.post('/despublicar', async (req, res) => { await Sites.unpublish(); await audit(req, 'site-despublicar'); res.flash('Site fora do ar.').redirect(B); });
