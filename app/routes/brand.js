// Configurações → Identidade da clínica (e as imagens da logo, públicas: aparecem também no portal e nos links do paciente)
import express from 'express';
import { audit } from '../lib/db.js';
import { page, html, raw, logoTag } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import * as Brand from '../lib/brand.js';

// /marca/logo e /marca/logo-escuro (sem login)
export async function logoRoute(req, res) {
  const f = await Brand.logoFile(req.params.tipo === 'logo-escuro' ? 'escuro' : 'claro');
  if (!f) { const b = Brand.get(); return b.legacy ? res.redirect('/static/img/logo-terracota.png') : res.sendStatus(404); }
  res.set({ 'Content-Type': f.mime, 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' }).send(f.buf);
}

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
      <h2 class="span2">Visual</h2>
      <label class="fld"><span>Cor de destaque <small class="muted">(botões e links; vazio = padrão)</small></span><span class="brand-color"><input type="color" name="color" value="${b.color || (b.legacy ? '#9c4422' : '#04857E')}">${b.color ? html`<label class="check small"><input type="checkbox" name="color_reset" value="1"> usar a cor padrão</label>` : ''}</span></label>
      <label class="fld"><span>Nome do sistema <small class="muted">(título das páginas)</small></span><input name="appName" maxlength="80" value="${v(b.appNameSaved)}" placeholder="${b.appName}"></label>
      <div class="span2 actions"><button class="btn">Salvar</button></div>
    </form>
    <section class="card brand-logos">
      <h2>Logo</h2>
      <p class="muted small">PNG (de preferência com fundo transparente), JPG ou WebP, até 2 MB, de preferência horizontal. A versão para o tema escuro é opcional (logo clara). Nos documentos em PDF entram só PNG e JPG.</p>
      <div class="brand-logo-grid">
        ${[['claro', 'Fundo claro', b.logo], ['escuro', 'Fundo escuro (opcional)', b.logoDark]].map(([k, l, has]) => html`<form method="post" action="/configuracoes/identidade/logo/${k}" enctype="application/octet-stream" class="brand-logo ${k}" data-logo-form>
          <b>${l}</b>
          <div class="brand-logo-prev">${has ? html`<img src="/marca/${k === 'escuro' ? 'logo-escuro' : 'logo'}?v=${has}" alt="Logo atual">` : html`<span class="muted small">Sem logo${k === 'claro' ? ' — o nome da clínica aparece no lugar' : ''}</span>`}</div>
          <label class="btn ghost btn-sm">Escolher imagem<input type="file" accept="image/png,image/jpeg,image/webp" data-logo-file hidden></label>
          <p class="small" data-logo-msg role="status"></p>
          ${has ? html`<button class="btn ghost btn-sm danger-text" name="remover" value="1" formaction="/configuracoes/identidade/logo/${k}/remover" formenctype="application/x-www-form-urlencoded">Remover</button>` : ''}
        </form>`)}
      </div>
      <p class="small">Prévia no menu: <span class="brand-prev">${logoTag('brand-prev-img')}</span></p>
    </section>` }));
});
settings.post('/', async (req, res) => {
  const b = req.body;
  if (!String(b.name || '').trim()) return res.flash('Informe o nome da clínica.', 'err').redirect('/configuracoes/identidade');
  await Brand.save({ ...b, color: b.color_reset ? '' : b.color });
  await audit(req, 'identidade-salvar');
  res.flash('Identidade da clínica salva.').redirect('/configuracoes/identidade');
});
// Envio da logo: o navegador manda o arquivo direto (corpo binário), com o tipo no cabeçalho
settings.post('/logo/:k', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '2200kb' }), async (req, res) => {
  const k = req.params.k === 'escuro' ? 'escuro' : 'claro';
  try { await Brand.saveLogo(k, Buffer.isBuffer(req.body) ? req.body : null, String(req.get('content-type') || '').split(';')[0]); }
  catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  await audit(req, 'identidade-logo', k);
  res.json({ ok: true });
});
settings.post('/logo/:k/remover', async (req, res) => {
  await Brand.removeLogo(req.params.k === 'escuro' ? 'escuro' : 'claro');
  await audit(req, 'identidade-logo-remover', req.params.k);
  res.flash('Logo removida.').redirect('/configuracoes/identidade');
});
