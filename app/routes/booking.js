// Agendamento online: página pública (/agendar) e Configurações → Agendamento online.
import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import QRCode from 'qrcode';
import { botFields } from '../lib/ratelimit.js';
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, brDate, weekday, VERSION, logoTag } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { proName } from '../lib/perm.js';
import { addDays, todayLocal, longDate } from '../lib/time.js';
import * as BK from '../lib/booking.js';

const CONTACT = html`<p class="muted small bk-contact">${Brand.get().phone ? `Dúvidas: WhatsApp ${Brand.get().phone} · ` : ''}<a href="/privacidade">Política de Privacidade</a></p>`;
// embed=1: exibida dentro do site (sem logo/rodapé; o site ajusta a altura pelo tamanho que a página informa)
const shell = (req, title, body) => (req.embed
  ? bare(title, html`<main class="bkp bkp-embed">${body}<p class="bkp-embed-f">Dúvidas? <a href="https://wa.me/${Brand.get().wa}" target="_blank" rel="noopener">Fale no WhatsApp</a> · seus dados são protegidos (LGPD)</p></main><script src="/static/embed.js?v=${VERSION}"></script>`, 'bare bkp-page bkp-embed-page', req)
  : bare(title, html`<main class="legal bkp">
  <a href="/agendar">${logoTag('legal-logo-img', 150)}</a>
  ${body}${CONTACT}</main>`, 'bare legal-page bkp-page', req));
const qs = (o) => Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

export const publicBooking = router();
// Mantém o modo “dentro do site” em links, formulários (embed.js) e redirecionamentos
publicBooking.use((req, res, next) => {
  req.embed = req.query.embed === '1' || req.body?.embed === '1';
  if (req.embed) {
    const orig = res.redirect.bind(res);
    res.redirect = (u) => orig(String(u).startsWith('/agendar') ? `${u}${String(u).includes('?') ? '&' : '?'}embed=1` : u);
  }
  next();
});
publicBooking.get('/', async (req, res) => {
  const c = await BK.config();
  res.set('Cache-Control', 'no-store');
  if (!c.enabled) return send(res, shell(req, 'Agendamento', html`<h1>Agendamento online</h1><p>No momento o agendamento é feito pelo nosso WhatsApp. Será um prazer atender você!</p>`));
  const pros = await BK.professionals(c);
  if (!pros.length) return send(res, shell(req, 'Agendamento', html`<h1>Agendamento online</h1><p>Não há agendas disponíveis agora. Fale conosco pelo WhatsApp.</p>`));
  const prof = pros.find((u) => u.id === int(req.query.prof)) || (pros.length === 1 ? pros[0] : null);
  const modsOf = prof ? prof.mods : [...new Set(pros.flatMap((u) => u.mods))];
  const mod = modsOf.includes(req.query.mod) ? req.query.mod : (modsOf.length === 1 ? modsOf[0] : null);
  const from = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.de || '')) ? req.query.de : null;
  const days = prof && mod ? await BK.slots(c, prof.id, from, 14) : [];
  const g = prof ? await BK.gridFor(c, prof.id) : null;
  const nextFrom = addDays(from && from > todayLocal() ? from : todayLocal(), 14);
  send(res, shell(req, 'Agendar sessão', html`<h1>Agendar sessão</h1><p class="muted">${c.intro}</p>
    ${req.query.aviso ? html`<div class="flash warn">Você já é paciente desta profissional: escolha um horário na agenda dela.</div>` : ''}
    <ol class="bk-steps"><li class="on">Horário</li><li>Seus dados</li><li>Código</li></ol>
    ${pros.length > 1 ? html`<section class="bk-block"><h2>Com quem?</h2><div class="bk-opts">${pros.map((u) => html`<a class="bk-opt ${prof?.id === u.id ? 'on' : ''}" href="/agendar?${qs({ prof: u.id, mod: u.mods.includes(mod) ? mod : null })}"><b>${u.display}</b><small>${u.crp ? `CRP ${u.crp} · ` : ''}${u.mods.map((m) => (m === 'online' ? 'on-line' : 'presencial')).join(' e ')}</small></a>`)}</div></section>` : html`<p><b>${prof.display}</b>${prof.crp ? html` <small class="muted">· CRP ${prof.crp}</small>` : ''}</p>`}
    ${modsOf.length > 1 ? html`<section class="bk-block"><h2>Como prefere?</h2><div class="bk-opts">${[['online', 'On-line', 'por videochamada'], ['presencial', 'Presencial', (Brand.get().city ? `no consultório, em ${Brand.get().city}` : 'no consultório')]].filter(([k]) => modsOf.includes(k)).map(([k, l, d]) => html`<a class="bk-opt ${mod === k ? 'on' : ''}" href="/agendar?${qs({ prof: prof?.id, mod: k })}"><b>${l}</b><small>${d}</small></a>`)}</div></section>` : ''}
    ${prof && mod ? html`<section class="bk-block"><h2>Escolha o horário <small class="muted">(sessões de ${g ? g.duration : c.durationEff} min)</small></h2>
      ${days.length ? html`<div class="bk-days">${days.map((d) => html`<div class="bk-day"><b>${d.label}</b><div class="bk-times">${d.times.map((t) => html`<a class="bk-time" href="/agendar/dados?${qs({ prof: prof.id, mod, t: `${d.day} ${t}` })}">${t}</a>`)}</div></div>`)}</div>`
      : html`<p class="muted">Não há horários livres nestes dias.</p>`}
      ${nextFrom <= addDays(todayLocal(), c.horizonDays) ? html`<p><a class="link" href="/agendar?${qs({ prof: prof.id, mod, de: nextFrom })}">Ver mais datas →</a></p>` : ''}
      ${from ? html`<p><a class="link" href="/agendar?${qs({ prof: prof.id, mod })}">← Voltar para as primeiras datas</a></p>` : ''}
    </section>` : html`<p class="muted">${!prof ? 'Escolha a profissional para ver os horários.' : 'Escolha a modalidade para ver os horários.'}</p>`}`));
});

async function slotFromQuery(c, query) {
  const pros = await BK.professionals(c);
  const prof = pros.find((u) => u.id === int(query.prof));
  const mod = prof && prof.mods.includes(query.mod) ? query.mod : null;
  const t = String(query.t || '');
  const start = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(t) ? `${t}:00` : null;
  return { prof, mod, start };
}
const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
const summary = (prof, mod, start) => html`<div class="bk-sum"><b>${cap(weekday(start.slice(0, 10)))}, ${longDate(start.slice(0, 10))}, às ${start.slice(11, 16)}</b><span>${prof.display} · ${mod === 'online' ? 'on-line' : 'presencial'}</span></div>`;
// Formulário de dados: em caso de erro, volta preenchido com o que a pessoa já digitou
async function renderDados(req, res, c, { prof, mod, start, v = {}, error = '', field = '' }) {
  const bad = await BK.check(c, prof.id, start);
  const errCls = (f) => (field === f ? 'fld bk-err' : 'fld');
  res.set('Cache-Control', 'no-store');
  send(res, shell(req, 'Seus dados', html`<h1>Seus dados</h1>
    <ol class="bk-steps"><li class="done">Horário</li><li class="on">Seus dados</li><li>Código</li></ol>
    ${bad ? html`<div class="flash err">${bad} <a class="link" href="/agendar?${qs({ prof: prof.id, mod })}">Escolher outro horário</a></div>` : html`
    ${summary(prof, mod, start)}
    ${error ? html`<div class="flash err" role="alert">${error}</div>` : ''}
    <form method="post" action="/agendar/dados" class="card stack bk-form">
      <input type="hidden" name="prof" value="${prof.id}"><input type="hidden" name="mod" value="${mod}"><input type="hidden" name="t" value="${start.slice(0, 16)}">
      <label class="bk-hp" aria-hidden="true">Não preencha<input name="site" tabindex="-1" autocomplete="off"></label>${botFields()}
      <label class="${errCls('name')}"><span>Nome completo <small class="muted">(nome e sobrenome)</small></span><input name="name" required maxlength="160" autocomplete="name" value="${v.name || ''}" pattern=".*\\S+\\s+\\S+.*" title="Informe nome e sobrenome" ${field === 'name' ? raw('autofocus') : ''}></label>
      <label class="${errCls('phone')}"><span>WhatsApp (com DDD)</span><input name="phone" required inputmode="tel" autocomplete="tel" maxlength="20" placeholder="(62) 99999-9999" value="${v.phone || ''}" ${field === 'phone' ? raw('autofocus') : ''}></label>
      <label class="fld"><span>E-mail <small class="muted">(opcional)</small></span><input name="email" type="email" maxlength="160" autocomplete="email" value="${v.email || ''}"></label>
      <label class="cf-check ${field === 'lgpd' ? 'bk-err' : ''}"><input type="checkbox" name="lgpd" value="1" required ${v.lgpd ? raw('checked') : ''}> <span>Concordo com o uso destes dados para o agendamento e os lembretes, conforme a <a href="/privacidade" target="_blank">Política de Privacidade</a>.</span></label>
      <p class="muted small">Não escreva aqui informações sobre saúde: elas são tratadas apenas na sessão.</p>
      <div class="actions"><button class="btn">Receber código no WhatsApp</button><a class="btn ghost" href="/agendar?${qs({ prof: prof.id, mod })}">Voltar</a></div>
    </form>`}`));
}
publicBooking.get('/dados', async (req, res) => {
  const c = await BK.config();
  if (!c.enabled) return res.redirect('/agendar');
  const { prof, mod, start } = await slotFromQuery(c, req.query);
  if (!prof || !mod || !start) return res.redirect('/agendar');
  return renderDados(req, res, c, { prof, mod, start, error: req.query.erro ? str(req.query.erro, 200) : '' });
});
publicBooking.post('/dados', async (req, res) => {
  const c = await BK.config();
  if (!c.enabled) return res.redirect('/agendar');
  const b = req.body;
  if (b.site) return res.redirect('/agendar'); // robô (campo escondido preenchido)
  const { prof, mod, start } = await slotFromQuery(c, b);
  if (!prof || !mod || !start) return res.redirect('/agendar');
  const v = { name: str(b.name, 160).replace(/\s+/g, ' '), phone: str(b.phone, 20), email: str(b.email, 160), lgpd: !!b.lgpd };
  const back = (msg, field = '') => renderDados(req, res, c, { prof, mod, start, v, error: msg, field });
  if (!b.lgpd) return back('É preciso concordar com a Política de Privacidade.', 'lgpd');
  const out = await BK.request(c, { ownerId: prof.id, start, modality: mod, name: v.name, phone: v.phone, email: v.email, ip: req.ip });
  if (!out.ok) return back(out.error, /nome/i.test(out.error) ? 'name' : /WhatsApp|número/i.test(out.error) ? 'phone' : '');
  res.redirect(`/agendar/codigo/${out.token}`);
});
publicBooking.get('/codigo/:token', async (req, res) => {
  const b = await BK.byToken(req.params.token);
  if (!b) return res.redirect('/agendar');
  if (b.status === 'agendado') return res.redirect(`/agendar/pronto/${b.token}`);
  const u = await one('SELECT name, title FROM users WHERE id = ?', [b.owner_id]);
  const tail = String(b.phone).slice(-4);
  res.set('Cache-Control', 'no-store');
  send(res, shell(req, 'Confirmar código', html`<h1>Confirme pelo WhatsApp</h1>
    <ol class="bk-steps"><li class="done">Horário</li><li class="done">Seus dados</li><li class="on">Código</li></ol>
    ${summary({ display: proName(u) }, b.modality, String(b.starts_at))}
    ${req.query.erro ? html`<div class="flash err">${str(req.query.erro, 200)}</div>` : ''}
    ${b.status !== 'codigo' ? html`<div class="flash err">Este pedido expirou. <a class="link" href="/agendar">Escolher o horário de novo</a></div>` : html`
    <form method="post" class="card stack bk-form">
      <p>Enviamos um código de 6 dígitos para o WhatsApp terminado em <b>${tail}</b>. Ele vale por 15 minutos.</p>
      <label class="fld"><span>Código</span><input name="code" required inputmode="numeric" autocomplete="one-time-code" maxlength="7" pattern="[0-9 ]{6,7}" class="bk-code"></label>
      <div class="actions"><button class="btn">Confirmar agendamento</button></div>
    </form>`}`));
});
publicBooking.post('/codigo/:token', async (req, res) => {
  const c = await BK.config();
  const out = await BK.confirm(c, req.params.token, req.body.code);
  if (out.ok) return res.redirect(`/agendar/pronto/${req.params.token}`);
  if (out.otherOwner) return res.redirect(`/agendar?${qs({ prof: out.otherOwner })}&aviso=1`);
  res.redirect(out.restart ? `/agendar` : `/agendar/codigo/${encodeURIComponent(req.params.token)}?erro=${encodeURIComponent(out.error)}`);
});
publicBooking.get('/pronto/:token', async (req, res) => {
  const b = await BK.byToken(req.params.token);
  if (!b || b.status !== 'agendado') return res.redirect('/agendar');
  const u = await one('SELECT name, title FROM users WHERE id = ?', [b.owner_id]);
  res.set('Cache-Control', 'no-store');
  send(res, shell(req, 'Sessão agendada', html`<h1>Sessão agendada! 🎉</h1>
    ${summary({ display: proName(u) }, b.modality, String(b.starts_at))}
    <p>Você vai receber a confirmação e os lembretes pelo WhatsApp${b.modality === 'online' ? ', com o link da chamada' : ''}. Para remarcar ou cancelar, é só responder a mensagem.</p>`));
});

// ---------- Configurações → Agendamento online ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const c = await BK.config();
  const all = await q("SELECT id, name, title FROM users WHERE active = 1 AND demo = 0 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");
  const shown = await BK.professionals({ ...c, pros: [] });
  const base = Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`;
  const link = `${base}/agendar`;
  const qr = await QRCode.toDataURL(link, { width: 260, margin: 1 });
  const recent = await q("SELECT a.id, a.starts_at, a.created_at, p.name, p.social_name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.created_via = 'online' ORDER BY a.id DESC LIMIT 8");
  send(res, page(req, { title: 'Agendamento online', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Agendamento online</h1>
      <p class="muted">Página onde o paciente escolhe um horário livre e confirma pelo WhatsApp, sem precisar conversar.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/agendar" target="_blank" rel="noopener">Abrir a página</a></div></header>
    <section class="card bk-link"><img src="${qr}" alt="QR code da página de agendamento" width="130" height="130">
      <div><h2>Link para divulgar</h2><p><input class="bk-url" value="${link}" readonly aria-label="Link da página de agendamento"> <button class="chip" type="button" data-copy="${link}">Copiar</button></p>
      <p class="muted small">Use no site, no Instagram, na assinatura do WhatsApp e numa campanha da TV da recepção (QR code). ${c.enabled ? '' : html`<b>A página está desligada:</b> ligue abaixo.`}</p></div></section>
    <form method="post" class="card stack">
      <h2>Regras</h2>
      <label class="fld check"><input type="checkbox" name="enabled" value="1" ${c.enabled ? raw('checked') : ''}><span><b>Agendamento online ligado</b></span></label>
      <label class="fld check"><input type="checkbox" name="allowNew" value="1" ${c.allowNew ? raw('checked') : ''}><span>Aceitar novos pacientes (primeira sessão). Desmarcado: só quem já é paciente.</span></label>
      <fieldset class="fld wl-chips"><legend>Profissionais na página <small class="muted">(nenhum marcado = todos com escala configurada)</small></legend>
        ${all.map((u) => html`<label class="wl-chip"><input type="checkbox" name="pros" value="${u.id}" ${c.pros.includes(u.id) ? raw('checked') : ''}><span>${proName(u)}${shown.some((x) => x.id === u.id) ? '' : ' (sem escala)'}</span></label>`)}</fieldset>
      <fieldset class="fld wl-chips"><legend>Modalidades</legend>
        ${[['online', 'On-line'], ['presencial', 'Presencial']].map(([k, l]) => html`<label class="wl-chip"><input type="checkbox" name="modalities" value="${k}" ${c.modalities.includes(k) ? raw('checked') : ''}><span>${l}</span></label>`)}</fieldset>
      <div class="form-grid">
        <label class="fld"><span>Antecedência mínima (horas)</span><input type="number" name="minLeadHours" min="1" max="168" value="${c.minLeadHours}"></label>
        <label class="fld"><span>Mostrar horários até (dias à frente)</span><input type="number" name="horizonDays" min="3" max="90" value="${c.horizonDays}"></label>
        <label class="fld"><span>Duração da sessão (min) <small class="muted">(vazio = a do atendente: ${c.durationEff})</small></span><input type="number" name="duration" min="10" max="180" value="${c.duration || ''}"></label>
        <label class="fld"><span>Intervalo entre horários (min) <small class="muted">(vazio = ${c.stepEff})</small></span><input type="number" name="step" min="10" max="240" value="${c.step || ''}"></label>
      </div>
      <label class="fld"><span>Texto de abertura</span><textarea name="intro" rows="2" maxlength="500">${c.intro}</textarea></label>
      <p class="muted small">Os horários seguem a escala de cada profissional (Agenda → Escala e bloqueios), as sessões já marcadas e os compromissos da Google Agenda. O paciente confirma com um código enviado ao WhatsApp; a sessão entra na agenda e todos recebem os avisos de sempre.</p>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>
    <section class="card"><h2>Últimos agendamentos online</h2>
      ${recent.length ? html`<ul class="list">${recent.map((a) => html`<li><a href="/agenda/${a.id}"><span>${a.social_name || a.name}</span><small class="muted">${weekday(String(a.starts_at).slice(0, 10))} ${brDate(a.starts_at)} às ${String(a.starts_at).slice(11, 16)} · feito em ${brDate(a.created_at)}</small></a></li>`)}</ul>` : html`<p class="muted">Nenhum ainda.</p>`}
    </section>` }));
});
settings.post('/', async (req, res) => {
  await BK.saveConfig(req.body);
  await audit(req, 'agendamento-online-config');
  res.flash('Agendamento online salvo.').redirect('/configuracoes/agendamento-online');
});
