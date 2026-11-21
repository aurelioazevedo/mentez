// Configurações → Identidade da clínica (e as imagens da logo, públicas: aparecem também no portal e nos links do paciente)
import express from 'express';
import { audit } from '../lib/db.js';
import { page, html, raw, logoTag, appLogo } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import * as Brand from '../lib/brand.js';
import * as Styles from '../lib/styles.js';

// /marca/logo, /marca/logo-escuro, /marca/simbolo, /marca/simbolo-escuro e /marca/favicon (sem login)
const ROUTE_KIND = { logo: 'claro', 'logo-escuro': 'escuro', simbolo: 'simbolo', 'simbolo-escuro': 'simbolo-escuro', favicon: 'favicon', foto: 'foto' };
const FALLBACK = { logo: 'logo.png', 'logo-escuro': 'logo-dark.png', simbolo: 'simbolo.png', 'simbolo-escuro': 'simbolo.png', favicon: 'favicon.png' };
export async function logoRoute(req, res) {
  const kind = ROUTE_KIND[req.params.tipo] || 'claro';
  const b = await Brand.load();
  if (kind === 'foto') { const f = await Brand.logoFile('foto'); return f ? res.set({ 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' }).send(f.buf) : res.sendStatus(404); }
  let f = kind === 'claro' || b.custom !== false ? await Brand.logoFile(kind) : null;
  if (!f && b.custom !== false && (kind === 'escuro' || kind === 'simbolo-escuro')) f = await Brand.logoFile(kind === 'escuro' ? 'claro' : 'simbolo'); // sem versão escura: a clara
  if (!f) return res.redirect(b.legacy ? `/static/img/${{ logo: 'logo-terracota.png', 'logo-escuro': 'logo-creme.png', simbolo: 'simbolo-terracota.png', 'simbolo-escuro': 'simbolo-creme.png', favicon: 'favicon.png' }[req.params.tipo]}` : `/static/img/mentez/${FALLBACK[req.params.tipo] || 'logo.png'}`);
  res.set({ 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' }).send(f.buf);
}

const PALETTE = [
  ['Cor principal', 'botões, links e menu ativo', '#04857E'],
  ['Cor escura', 'títulos e textos fortes', '#071936'],
  ['Cor de destaque', 'gradientes, ícones e gráficos', '#5B47C9'],
  ['Cor clara', 'fundos suaves e etiquetas', '#E6F6EF'],
];
// [tipo, rota pública, rótulo, dica, campo da marca, formato]
const SLOTS = [
  ['claro', 'logo', 'Logo — fundo claro', 'Logo completa, de preferência horizontal.', 'logo', 'logo'],
  ['escuro', 'logo-escuro', 'Logo — fundo escuro', 'Opcional: versão clara da logo para o tema escuro.', 'logoDark', 'logo'],
  ['simbolo', 'simbolo', 'Símbolo (sem o nome)', 'Aparece com o menu recolhido. Formato quadrado.', 'symbol', 'simbolo'],
  ['simbolo-escuro', 'simbolo-escuro', 'Símbolo — fundo escuro', 'Opcional, para o tema escuro.', 'symbolDark', 'simbolo'],
  ['favicon', 'favicon', 'Favicon', 'Ícone da aba do navegador e do aplicativo instalado. Quadrado, simples.', 'favicon', 'favicon'],
];
export const settings = router();
const v = (x) => x || '';
settings.get('/', async (req, res) => {
  const b = await Brand.load(true);
  send(res, page(req, { title: 'Identidade da clínica', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Identidade da clínica</h1>
      <p class="muted">Estes dados aparecem nas telas do sistema, nos documentos e recibos, nas mensagens aos pacientes, no agendamento on-line e no portal do paciente.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card form-grid">
      <h2 class="span2">Clínica</h2>
      <label class="fld"><span>Nome da clínica ou consultório *</span><input name="name" required maxlength="160" value="${v(b.name)}" placeholder="Consultório Ana Souza"></label>
      <label class="fld"><span>Nome curto <small class="muted">(menu, aplicativo e mensagens)</small></span><input name="short" maxlength="80" value="${v(b.short)}" placeholder="Ana Souza"></label>
      <h2 class="span2">Profissional responsável</h2>
      <label class="fld"><span>Nome com tratamento</span><input name="proName" maxlength="120" value="${v(b.proName)}" placeholder="Dra. Ana Souza"></label>
      <label class="fld"><span>Forma curta</span><input name="proFirst" maxlength="60" value="${v(b.proFirst)}" placeholder="Dra. Ana"></label>
      <label class="fld"><span>Profissão</span><input name="proRole" maxlength="60" value="${v(b.proRole)}" placeholder="Psicóloga"></label>
      <label class="fld"><span>CRP</span><input name="crp" maxlength="30" value="${v(b.crp)}" placeholder="00/00000"></label>
      <h2 class="span2">Contato e endereço</h2>
      <label class="fld"><span>Telefone</span><input name="phone" maxlength="40" value="${v(b.phone)}" placeholder="(62) 99999-9999" inputmode="tel"></label>
      <label class="fld"><span>WhatsApp <small class="muted">(se for outro número)</small></span><input name="whatsapp" maxlength="40" value="${v(b.whatsapp)}" inputmode="tel"></label>
      <label class="fld"><span>E-mail</span><input type="email" name="email" maxlength="120" value="${v(b.email)}" placeholder="contato@suaclinica.com.br"></label>
      <label class="fld"><span>Site</span><input name="site" maxlength="120" value="${v(b.site)}" placeholder="suaclinica.com.br"></label>
      <label class="fld"><span>Instagram</span><input name="instagram" maxlength="60" value="${v(b.instagram)}" placeholder="@suaclinica"></label>
      <label class="fld span2"><span>Endereço do consultório</span><input name="address" maxlength="200" value="${v(b.address)}"></label>
      <label class="fld"><span>Cidade</span><input name="city" maxlength="80" value="${v(b.city)}" placeholder="Goiânia"></label>
      <label class="fld"><span>UF</span><input name="uf" maxlength="2" value="${v(b.uf)}" placeholder="GO"></label>
      <label class="fld span2"><span>Nome do sistema <small class="muted">(título das páginas e do aplicativo)</small></span><input name="appName" maxlength="80" value="${v(b.appNameSaved)}" placeholder="${b.appName}"></label>
      ${b.custom !== false ? html`<h2 class="span2">Estilo do sistema</h2>
      <p class="span2 muted small">Muda as cores, as fontes, os cantos e as sombras de todas as telas, do cartão digital e do link na bio. Cada estilo tem versão clara e escura. A paleta de cores abaixo, se preenchida, vai por cima do estilo.</p>
      <link rel="stylesheet" href="${Styles.allFonts()}">
      <div class="span2 st-grid" role="radiogroup" aria-label="Estilo do sistema">${Object.entries(Styles.STYLES).map(([k, st]) => { const w = Styles.swatch(k); return html`<label class="st-opt">
        <input type="radio" name="style" value="${k}" ${k === b.style ? raw('checked') : ''}>
        <span class="st-prev" style="background:${w.bg};border-radius:${Math.min(st.r, 16)}px">
          <span class="st-bar" style="background:${w.dark || w.ink}"></span>
          <span class="st-body"><b style="font-family:${st.serif};color:${w.ink}">Aa Agenda</b>
            <span class="st-line" style="background:${w.soft}"></span><span class="st-line short" style="background:${w.soft}"></span>
            <span class="st-btn" style="background:${w.accent};border-radius:${Math.max(4, st.r - 8)}px;font-family:${st.sans}">Salvar</span></span></span>
        <span class="st-txt"><b>${st.label}</b><small>${st.desc}</small></span></label>`; })}</div>
      <h2 class="span2">Paleta de cores</h2>
      <p class="span2 muted small">Até 4 cores da clínica ou do profissional. Deixe em branco para usar as cores padrão${b.legacy ? '' : ' da Mentez'}. Os textos dos botões mudam sozinhos para escuro quando a cor principal é muito clara.</p>
      <div class="span2 pal-grid" data-palette>
        ${PALETTE.map(([label, hint, def], i) => html`<label class="pal"><span class="pal-sw"><input type="color" value="${b.colors[i] || def}" data-pal-pick="${i}" aria-label="Escolher ${label}"></span>
          <span class="pal-txt"><b>${label}</b><small class="muted">${hint}</small><input name="colors" value="${b.colors[i] || ''}" placeholder="padrão" maxlength="7" pattern="#[0-9a-fA-F]{6}" data-pal-hex="${i}" data-pal-def="${def}" autocomplete="off" spellcheck="false" aria-label="${label} (código, ex.: #04857E)"></span></label>`)}
      </div>
      <div class="span2 pal-prev" data-pal-prev aria-hidden="true"><b class="pp-title">Prévia</b><span class="pp-btn">Botão principal</span><span class="pp-chip">Etiqueta</span><span class="pp-bar"></span></div>
      <div class="span2"><button type="button" class="btn ghost btn-sm" data-pal-reset>Usar as cores padrão</button></div>` : ''}
      <div class="span2 actions"><button class="btn">Salvar</button></div>
    </form>
    ${b.custom === false ? html`<section class="card brand-locked"><h2>Logo, cores, favicon e domínio próprio</h2>
      <p>No seu plano atual o sistema usa a identidade visual da Mentez. Para usar a logo, as cores e o favicon da clínica, e um endereço próprio (ex.: app.suaclinica.com.br), mude para um plano com personalização.</p>
      <p class="actions"><a class="btn" href="/configuracoes/assinatura">Ver planos</a></p></section>` : html`<section class="card brand-logos">
      <h2>Logo, símbolo e favicon</h2>
      <p class="muted small">Envie PNG, JPG, WebP ou SVG — o sistema ajusta o tamanho e converte sozinho. Prefira imagens com fundo transparente. Enquanto não houver imagem, aparece ${b.legacy ? 'a padrão' : 'a da Mentez'}.</p>
      <div class="brand-logo-grid">
        ${SLOTS.map(([k, route, label, hint, field, shape]) => { const has = b[field]; return html`<form method="post" action="/configuracoes/identidade/logo/${k}" class="brand-logo ${k.includes('escuro') ? 'escuro' : 'claro'} bl-${shape}" data-logo-form data-logo-kind="${shape}">
          <b>${label}</b><small class="muted">${hint}</small>
          <div class="brand-logo-prev">${has ? html`<img src="/marca/${route}?v=${has}" alt="${label} atual">` : html`<img src="/marca/${route}" alt="" class="bl-default"><span class="bl-tag">padrão ${b.legacy ? '' : 'Mentez'}</span>`}</div>
          <label class="btn ghost btn-sm">${has ? 'Trocar imagem' : 'Escolher imagem'}<input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif,image/avif,.png,.jpg,.jpeg,.webp,.svg" data-logo-file hidden></label>
          <p class="small" data-logo-msg role="status"></p>
          ${has ? html`<button class="btn ghost btn-sm danger-text" name="remover" value="1" formaction="/configuracoes/identidade/logo/${k}/remover">Remover</button>` : ''}
        </form>`; })}
      </div>
      <p class="small">Prévia no menu: <span class="brand-prev">${appLogo('brand-prev-img')}</span></p>
    </section>`}` }));
});
settings.post('/', async (req, res) => {
  const b = req.body;
  if (!String(b.name || '').trim()) return res.flash('Informe o nome da clínica.', 'err').redirect('/configuracoes/identidade');
  const custom = await Brand.canCustomize();
  await Brand.save({ ...b, colors: custom && b.colors !== undefined ? [].concat(b.colors) : undefined });
  await audit(req, 'identidade-salvar');
  res.flash('Identidade da clínica salva.').redirect('/configuracoes/identidade');
});
// Envio das imagens: o navegador manda o arquivo já convertido (corpo binário), com o tipo no cabeçalho
settings.post('/logo/:k', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '2200kb' }), async (req, res) => {
  const k = Brand.ASSETS[req.params.k] ? req.params.k : 'claro';
  if (!(await Brand.canCustomize())) return res.status(402).json({ ok: false, error: 'O seu plano não inclui personalização da logo. Veja os planos em Configurações → Plano e assinatura.' });
  try { await Brand.saveLogo(k, Buffer.isBuffer(req.body) ? req.body : null, String(req.get('content-type') || '').split(';')[0]); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  await audit(req, 'identidade-logo', k);
  res.json({ ok: true });
});
settings.post('/logo/:k/remover', async (req, res) => {
  const k = Brand.ASSETS[req.params.k] ? req.params.k : 'claro';
  await Brand.removeLogo(k);
  await audit(req, 'identidade-logo-remover', k);
  res.flash('Imagem removida.').redirect('/configuracoes/identidade');
});
