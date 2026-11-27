// Marketing → Bem-Estar Mental: o profissional da clínica liga e edita o próprio perfil no diretório
// (os administradores também editam o perfil dos outros profissionais da clínica).
import express from 'express';
import * as Tenancy from '../lib/tenancy.js';
import * as Brand from '../lib/brand.js';
import * as Dir from '../lib/directory.js';
import * as Sites from '../lib/sites.js';
import * as BK from '../lib/booking.js';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw } from '../lib/html.js';
import { router, send, str } from '../lib/router.js';
import { can, proName } from '../lib/perm.js';

export const admin = router();
const P = '/marketing/bem-estar';
const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const ck = (v) => (v ? raw('checked') : '');
const portal = () => `https://${[...Dir.hosts()][0] || 'bemestarmental.com.br'}`;
const pick = (name, dict, sel) => html`<div class="wl-chips">${Object.entries(dict).map(([k, l]) => html`<label class="wl-chip"><input type="checkbox" name="${name}" value="${k}" ${ck(Dir.list(sel).includes(k))}><span>${l}</span></label>`)}</div>`;

async function target(req) {
  const id = can(req.user, 'usuarios') && Number(req.query.u || req.body?.u) > 0 ? Number(req.query.u || req.body?.u) : req.user.id;
  return one("SELECT id, name, title, crp, email, phone, photo, photo_v, attends, modalities FROM users WHERE id = ? AND active = 1", [id]);
}
// dados que vêm do sistema: agenda on-line (se o profissional está nela) e site publicado
async function autoLinks(u) {
  const out = { booking_url: null, site_url: null };
  try { const c = await BK.config(); if (c.enabled && (await BK.professionals(c)).some((x) => x.id === u.id)) out.booking_url = `${String(Tenancy.env('PUBLIC_URL') || '').replace(/\/+$/, '')}/agendar?prof=${u.id}`; } catch { /* sem agenda */ }
  try { if (await Sites.published()) out.site_url = await Sites.siteUrl(); } catch { /* sem site */ }
  return out;
}

admin.get('/', async (req, res) => {
  const u = await target(req); if (!u) return res.redirect('/marketing');
  const t = Tenancy.current();
  const p = await Dir.byUser(t.id, u.id);
  const tier = p ? await Dir.tierOf(p) : 'gratis';
  const st = p ? await Dir.statsOf(p.id) : { view: 0, wa: 0, book: 0, site: 0 };
  const links = await autoLinks(u); const b = Brand.get();
  const pros = can(req.user, 'usuarios') ? await q("SELECT id, name, title FROM users WHERE active = 1 AND demo = 0 AND attends = 1 AND role IN ('admin','psicologo') ORDER BY name") : [];
  const v = p || { name: proName(u), title: /^dr\.?\s/i.test(proName(u)) || u.title === 'dr' ? 'Psicólogo' : 'Psicóloga', crp: u.crp || '', online: 1, presencial: 1, city: b.city || '', uf: b.uf || '', whatsapp: b.whatsapp || b.phone || '' };
  const field = (name, label, val, o = '') => html`<label class="fld"><span>${label}</span><input name="${name}" value="${val ?? ''}" ${raw(o)}></label>`;
  send(res, page(req, { title: 'Marketing · Bem-Estar Mental', active: 'marketing', body: html`
    <header class="ph"><div><p class="eyebrow">Marketing</p><h1>Bem-Estar Mental</h1>
      <p class="muted">Seu perfil no diretório de psicólogos <a href="${portal()}" target="_blank" rel="noopener">${portal().replace('https://', '')}</a>. Pacientes encontram você por tema, cidade ou atendimento on-line${links.booking_url ? ' e agendam direto na sua agenda' : ''}. Sem comissão.</p></div>
      ${p && p.status === 'ativo' ? html`<div class="ph-actions"><a class="btn ghost" href="${portal()}/p/${p.slug}" target="_blank" rel="noopener">Ver meu perfil</a></div>` : ''}</header>
    ${pros.length > 1 ? html`<form method="get" class="card bem-who"><label class="fld"><span>Perfil de</span><select name="u" data-autosubmit>${pros.map((x) => html`<option value="${x.id}" ${x.id === u.id ? raw('selected') : ''}>${proName(x)}</option>`)}</select></label></form>` : ''}
    <section class="kpis bem-kpis">
      <div class="kpi"><small>Situação</small><b>${!p ? 'Desligado' : p.status === 'ativo' ? 'No ar' : p.status === 'suspenso' ? 'Suspenso' : 'Oculto'}</b></div>
      <div class="kpi"><small>Destaque</small><b>${Dir.TIERS[tier].name}</b></div>
      <div class="kpi"><small>Visitas (30 dias)</small><b>${st.view}</b></div>
      <div class="kpi"><small>Cliques em Agendar e WhatsApp</small><b>${st.book + st.wa}</b></div>
    </section>
    <form method="post" action="${P}" class="stack">
      <input type="hidden" name="u" value="${u.id}">
      <section class="card stack">
        <label class="fld check"><input type="checkbox" name="on" value="1" ${ck(!p || p.status === 'ativo')}><span><b>Mostrar meu perfil no Bem-Estar Mental</b></span></label>
        <p class="muted small">${links.booking_url ? html`✅ O botão <b>Agendar</b> leva à sua agenda on-line, com os próximos horários livres no perfil.` : html`Ligue o <a href="/configuracoes/agendamento-online">agendamento on-line</a> para o perfil mostrar seus horários livres e o botão Agendar.`}
          ${links.site_url ? html` ✅ O perfil leva ao seu site (${links.site_url.replace('https://', '')}).` : ''} O selo “CRP verificado” aparece depois da conferência da equipe.</p>
      </section>
      <section class="card form-grid">
        ${field('name', 'Nome profissional', v.name, 'required maxlength="120"')}
        <label class="fld"><span>Como aparece</span><select name="title">${['Psicóloga', 'Psicólogo', 'Psicólogue'].map((x) => html`<option ${v.title === x ? raw('selected') : ''}>${x}</option>`)}</select></label>
        ${field('crp', 'CRP', v.crp, 'maxlength="20"')}
        <label class="fld"><span>UF do CRP</span><select name="crp_uf"><option value="">—</option>${Dir.UFS.map((x) => html`<option ${x === (v.crp_uf || v.uf) ? raw('selected') : ''}>${x}</option>`)}</select></label>
        <label class="fld check span2"><input type="checkbox" name="epsi" value="1" ${ck(v.epsi)}><span>Tenho cadastro e-Psi (exigido pelo CFP para atender on-line)</span></label>
        <label class="fld check"><input type="checkbox" name="online" value="1" ${ck(v.online)}><span>Atendo on-line</span></label>
        <label class="fld check"><input type="checkbox" name="presencial" value="1" ${ck(v.presencial)}><span>Atendo presencial</span></label>
        ${field('city', 'Cidade', v.city, 'maxlength="80"')}
        <label class="fld"><span>UF</span><select name="uf"><option value="">—</option>${Dir.UFS.map((x) => html`<option ${x === v.uf ? raw('selected') : ''}>${x}</option>`)}</select></label>
        ${field('district', 'Bairro (opcional)', v.district, 'maxlength="80"')}
        ${field('whatsapp', 'WhatsApp para pacientes', v.whatsapp, 'maxlength="20" inputmode="tel"')}
        ${field('price_min', 'Valor da sessão: a partir de (R$)', v.price_min, 'inputmode="numeric" maxlength="6"')}
        ${field('price_max', 'Até (R$, opcional)', v.price_max, 'inputmode="numeric" maxlength="6"')}
        <label class="fld span2"><span>Convênios (opcional)</span><input name="convenios" value="${v.convenios || ''}" maxlength="300"></label>
        <label class="fld span2"><span>Apresentação</span><textarea name="bio" rows="6" maxlength="3000" placeholder="Como você trabalha, para quem e como é o primeiro contato. Sem promessas de resultado.">${v.bio || ''}</textarea></label>
        <label class="fld span2"><span>Vídeo de apresentação (link do YouTube ou Vimeo, opcional)</span><input name="video" value="${v.video || ''}" maxlength="300"></label>
      </section>
      <section class="card stack"><h2>Temas que atende</h2>${pick('temas', Dir.TEMAS, v.temas)}<h2>Abordagens</h2>${pick('abordagens', Dir.ABORDAGENS, v.abordagens)}<h2>Público</h2>${pick('publicos', Dir.PUBLICOS, v.publicos)}</section>
      <section class="card stack"><h2>Foto</h2><p class="muted small">${u.photo ? 'Usamos a sua foto do sistema (Minha conta). Ao salvar, ela é atualizada no perfil.' : 'Envie uma foto em Minha conta para aparecer no perfil (perfis com foto recebem muito mais cliques).'}</p></section>
      <div class="actions"><button class="btn">Salvar perfil</button></div>
    </form>
    <section class="card"><h2>Destaque</h2>
      <p>Seu plano da Mentez inclui: <b>${Dir.TIERS[tier].name}</b>. ${tier === 'ouro' ? '' : html`Quer aparecer no topo da busca e na vitrine da página inicial? O <b>Ouro</b> custa R$ ${Dir.TIERS.ouro.price}/mês.`}</p>
      ${p && tier !== 'ouro' ? html`<form method="post" action="${P}/ouro"><input type="hidden" name="u" value="${u.id}"><button class="btn ghost">Quero o destaque Ouro</button></form>` : ''}
      <p class="muted small"><a href="${portal()}/para-profissionais#planos" target="_blank" rel="noopener">Compare os planos</a></p></section>` }));
});
admin.post('/', async (req, res) => {
  const u = await target(req); if (!u) return res.redirect('/marketing');
  const t = Tenancy.current();
  try {
    const p = await Dir.upsertMentez(t.id, u.id, { name: req.body.name, city: req.body.city });
    const links = await autoLinks(u);
    await Dir.update(p.id, { ...req.body, temas: arr(req.body.temas), abordagens: arr(req.body.abordagens), publicos: arr(req.body.publicos) },
      { ...links, email: u.email || null, phone: u.phone || null, status: req.body.on ? (p.status === 'suspenso' ? 'suspenso' : 'ativo') : 'oculto' });
    if (u.photo) await Dir.setPhoto(p.id, u.photo).catch((e) => console.error('bem foto', e.message));
    await audit(req, 'bem-perfil', String(u.id));
    res.flash(req.body.on ? 'Perfil salvo e no ar no Bem-Estar Mental.' : 'Perfil salvo (oculto).');
  } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`${P}${Number(req.body.u) !== req.user.id ? `?u=${Number(req.body.u)}` : ''}`);
});
admin.post('/ouro', async (req, res) => {
  const u = await target(req); const p = u && await Dir.byUser(Tenancy.current().id, u.id);
  if (p) { await Dir.requestTier(p.id, 'ouro'); await audit(req, 'bem-ouro', String(u.id)); res.flash('Pedido enviado! A equipe da Mentez entra em contato com a cobrança do destaque Ouro.'); }
  res.redirect(P);
});
