// Portal do paciente (/paciente): entrada pelo WhatsApp e área pessoal instalável no celular.
import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import path from 'node:path';
import { botFields } from '../lib/ratelimit.js';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, icon, brDate, brDateTime, money, label, waLink, logoTag } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { parseCookies } from '../lib/auth.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { nowLocal } from '../lib/time.js';
import { byKey } from '../lib/exercises.js';
import { renderForm, parseForm, renderResponse } from '../lib/forms.js';
import { notify } from '../lib/push.js';
import { proName, canSeePatient, forbidden } from '../lib/perm.js';
import * as P from '../lib/portal.js';
import * as C from '../lib/consent.js';
import * as Fin from '../lib/fin.js';
import * as G from '../lib/gateway.js';
import { encrypt as enc2 } from '../lib/crypto.js';
import * as WA from '../lib/whatsapp.js';
import * as Scales from '../lib/scales.js';
import { scaleForm, readAnswers, thanks as scaleThanks } from './scales.js';
import { receiptPage } from './finance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE = path.join(__dirname, '..', 'private');
const BASE = '/paciente';
const DAY_MS = 864e5;
const r = router();
const WEEK = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
const wd = (dt) => WEEK[new Date(`${String(dt).slice(0, 10)}T12:00:00Z`).getUTCDay()];
const when = (dt) => `${wd(dt)}, ${brDate(dt).slice(0, 5)} às ${String(dt).slice(11, 16)}`;
const ipOf = (req) => String(req.get('cf-connecting-ip') || req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
const cpfOk = (v) => { const d = String(v || '').replace(/\D/g, ''); return !d || d.length === 11; };

function setCookie(res, token, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${P.COOKIE}=${token}; Path=${BASE}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`);
}
const O = { manifest: `${BASE}/manifest.webmanifest`, get appTitle() { return Brand.get().short; }, suffix: 'Portal do paciente' };
const clinicWa = async () => { const c = await Fin.clinic(); return { phone: c.phone, link: waLink(c.phone, 'Olá! Sou paciente e preciso de ajuda.') }; };

// Tela sem login (entrada)
const gate = (req, title, inner) => bare(title, html`<main class="pp-gate">
  ${logoTag('pp-logo')}
  ${inner}
  <p class="pp-foot muted small">Área pessoal e sigilosa do paciente · <a href="/privacidade">Privacidade</a></p>
</main>`, 'bare pp-bg', req, O);

// Área logada: topo com nome, conteúdo e barra de abas embaixo
async function shell(req, title, tab, inner) {
  const { p } = req.pp; const c = req.ppc;
  const others = (await P.switchable(req.pp)).filter((x) => x.id !== p.id);
  const tabs = [['inicio', 'Início', 'home', ''], ['sessoes', 'Sessões', 'agenda', '/sessoes'], c.showPayments && ['pagamentos', 'Pagamentos', 'financeiro', '/pagamentos'], c.showTerms && ['termos', 'Termos', 'termos', '/termos'], c.showExercises && ['exercicios', 'Exercícios', 'exercicios', '/exercicios']].filter(Boolean);
  return bare(title, html`<div class="pp-app">
  <header class="pp-top">
    ${logoTag('pp-mark')}
    <div class="pp-who"><b>${p.social_name || p.name}</b>${others.length ? html`<a class="link small" href="${BASE}/quem">trocar</a>` : ''}</div>
    <button type="button" class="tinstall" data-install hidden title="Instalar o portal no celular">${icon('baixar')}<span class="ti-short">Instalar</span></button>
    <form method="post" action="${BASE}/sair"><button class="pp-out" title="Sair deste aparelho" aria-label="Sair">${icon('sair')}</button></form>
  </header>
  <main class="pp-main">${req.flashMsg ? html`<div class="flash ${req.flashMsg.type || 'ok'}">${req.flashMsg.text}</div>` : ''}${inner}</main>
  <nav class="pp-tabs" aria-label="Seções">${tabs.map(([k, l, ic, href]) => html`<a href="${BASE}${href}" class="${tab === k ? 'on' : ''}" ${tab === k ? raw('aria-current="page"') : ''}>${icon(ic)}<span>${l}</span></a>`)}</nav>
</div>
<div class="inst-banner" data-install-banner hidden role="region" aria-label="Instalar o portal">
  <img src="${Brand.icon('app-192.png')}" alt="" width="44" height="44">
  <div><b>Instale o portal no seu celular</b><small>Acesse suas sessões e pagamentos direto pelo ícone.</small></div>
  <button type="button" class="btn" data-install-go>Instalar</button><button type="button" class="btn ghost" data-install-later>Agora não</button>
</div>
<dialog class="inst-dlg" data-install-dlg><form method="dialog"><h2>Instalar o portal</h2><ol data-install-steps></ol>
  <p class="muted small">Depois é só abrir pelo ícone “${Brand.get().short}”.</p><div class="actions"><button class="btn">Entendi</button></div></form></dialog>`, 'bare pp-bg', req, O);
}

// ---------- público ----------
r.get('/manifest.webmanifest', (req, res) => {
  const m = Brand.manifest({ start: BASE, scope: `${BASE}/`, suffix: 'Portal do paciente' });
  res.type('application/manifest+json').set('Cache-Control', 'public, max-age=3600').send(JSON.stringify({ ...m, id: `${BASE}/`, description: 'Suas sessões, pagamentos, termos e exercícios.' }));
});
r.use(async (req, res, next) => { req.ppc = await P.config(); next(); });
const off = async (req, res) => { const w = await clinicWa(); return send(res.status(503), gate(req, 'Portal indisponível', html`<section class="pp-card"><h1>Portal do paciente</h1><p>O portal está indisponível no momento. Para falar com o consultório, use o WhatsApp.</p>${w.link ? html`<a class="btn" href="${w.link}" target="_blank" rel="noopener">Falar pelo WhatsApp</a>` : ''}</section>`)); };

const loginForm = (req, err = '', phone = '') => gate(req, 'Entrar', html`<section class="pp-card">
  <h1>Portal do paciente</h1>
  <p class="muted">${req.ppc.welcome || 'Veja suas sessões, remarque, pague com Pix, baixe recibos e responda termos e exercícios.'}</p>
  ${err ? html`<p class="flash err">${err}</p>` : ''}
  <form method="post" action="${BASE}/entrar" class="stack">${botFields()}
    <label class="fld"><span>Seu WhatsApp (com DDD)</span><input name="phone" type="tel" inputmode="tel" autocomplete="tel" required placeholder="(62) 90000-0000" value="${phone}" autofocus></label>
    <button class="btn big">Receber código no WhatsApp</button>
  </form>
  <p class="muted small">Use o número cadastrado no consultório (para menores, o do responsável).</p>
</section>`);
const codeForm = (req, token, err = '') => gate(req, 'Código', html`<section class="pp-card">
  <h1>Digite o código</h1>
  <p class="muted">Se o número estiver cadastrado, você recebeu um código de 6 dígitos no WhatsApp.</p>
  ${err ? html`<p class="flash err">${err}</p>` : ''}
  <form method="post" action="${BASE}/entrar/codigo" class="stack">
    <input type="hidden" name="token" value="${token}">
    <label class="fld"><span>Código</span><input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9 ]{6,7}" maxlength="7" required autofocus class="pp-code"></label>
    <button class="btn big">Entrar</button>
  </form>
  <p class="small"><a class="link" href="${BASE}/entrar">Não recebeu? Tentar de novo</a></p>
</section>`);

r.get('/entrar', async (req, res) => {
  if (!req.ppc.enabled) return off(req, res);
  if (await P.sessionOf(parseCookies(req)[P.COOKIE])) return res.redirect(BASE);
  send(res, loginForm(req));
});
r.post('/entrar', async (req, res) => {
  if (!req.ppc.enabled) return off(req, res);
  const out = await P.requestCode(str(req.body.phone, 30), ipOf(req));
  if (!out.ok) return send(res.status(400), loginForm(req, out.error, str(req.body.phone, 30)));
  send(res, codeForm(req, out.token));
});
async function enter(req, res, patients, phone, via) {
  const token = await P.startSession(patients[0].id, phone, req);
  setCookie(res, token, 90 * 86400);
  for (const p of patients.slice(0, 1)) await q('INSERT INTO audit_log (user_id, action, target, ip) VALUES (NULL, ?, ?, ?)', ['portal-entrar', `patient:${p.id} ${via}`, ipOf(req).slice(0, 64)]).catch(() => {});
  res.redirect(patients.length > 1 ? `${BASE}/quem` : BASE);
}
r.post('/entrar/codigo', async (req, res) => {
  if (!req.ppc.enabled) return off(req, res);
  const out = await P.verifyCode(str(req.body.token, 60), str(req.body.code, 10));
  if (!out.ok) return out.restart ? send(res.status(400), loginForm(req, out.error)) : send(res.status(400), codeForm(req, str(req.body.token, 60), out.error));
  await enter(req, res, out.patients, out.phone, 'codigo');
});
// Link enviado pela clínica: a página pede um toque (pré-visualizações do WhatsApp não gastam o link)
r.get('/acesso/:token', async (req, res) => {
  if (!req.ppc.enabled) return off(req, res);
  const l = await P.useLink(req.params.token);
  if (!l) return send(res.status(404), gate(req, 'Link expirado', html`<section class="pp-card"><h1>Link expirado</h1><p>Este link de acesso já foi usado ou expirou. Entre com o seu WhatsApp:</p><a class="btn" href="${BASE}/entrar">Entrar com código</a></section>`));
  send(res, gate(req, 'Entrar', html`<section class="pp-card"><h1>Portal do paciente</h1><p>Toque para entrar. Neste aparelho você fica conectado(a) por até 90 dias.</p>
    <form method="post"><button class="btn big">Entrar no portal</button></form></section>`));
});
r.post('/acesso/:token', async (req, res) => {
  if (!req.ppc.enabled) return off(req, res);
  const l = await P.useLink(req.params.token);
  if (!l) return res.redirect(`${BASE}/acesso/${encodeURIComponent(req.params.token)}`);
  await P.consumeLink(l.link);
  await enter(req, res, [l.patient], l.patient.phone || l.patient.responsible_phone, 'link');
});

// ---------- área logada ----------
r.use(async (req, res, next) => {
  if (!req.ppc.enabled) return off(req, res);
  const sess = await P.sessionOf(parseCookies(req)[P.COOKIE]);
  if (!sess) return res.redirect(`${BASE}/entrar`);
  req.pp = sess;
  const f = parseCookies(req).pp_msg;
  if (f) { try { req.flashMsg = JSON.parse(Buffer.from(f, 'base64url').toString()); } catch { /* ignora */ } res.append('Set-Cookie', `pp_msg=; Path=${BASE}; Max-Age=0`); }
  res.set('Cache-Control', 'no-store');
  next();
});
const flash = (res, text, type = 'ok') => res.append('Set-Cookie', `pp_msg=${Buffer.from(JSON.stringify({ text, type })).toString('base64url')}; Path=${BASE}; HttpOnly; SameSite=Lax; Max-Age=60`);

r.post('/sair', async (req, res) => {
  await P.endSession(req.pp);
  setCookie(res, '', 0);
  res.redirect(`${BASE}/entrar`);
});
r.get('/quem', async (req, res) => {
  const list = await P.switchable(req.pp);
  send(res, await shell(req, 'Quem está acessando', '', html`<section class="pp-card"><h1>Quem está acessando?</h1><p class="muted">Este WhatsApp está cadastrado para mais de uma pessoa.</p>
    <div class="pp-list">${list.map((x) => html`<form method="post" action="${BASE}/quem"><input type="hidden" name="pid" value="${x.id}"><button class="pp-pick ${x.id === req.pp.p.id ? 'on' : ''}">${x.social_name || x.name}</button></form>`)}</div></section>`));
});
r.post('/quem', async (req, res) => {
  await P.switchTo(req.pp, int(req.body.pid));
  res.redirect(BASE);
});

function apptCard(a, c, big = false) {
  const late = (h) => P.hoursUntil(a.starts_at) < h;
  const canMove = ['agendada', 'confirmada'].includes(a.status) && P.hoursUntil(a.starts_at) > 0;
  return html`<article class="pp-appt ${big ? 'big' : ''}">
    <div class="pp-when"><b>${when(a.starts_at)}</b><small>${a.duration_min} min · ${label(a.modality)}${a.pro_name ? ` · ${proName({ name: a.pro_name, title: a.pro_title })}` : ''}</small></div>
    <span class="badge ${a.status === 'confirmada' ? 'b-confirmada' : 'b-agendada'}">${a.status === 'confirmada' ? 'Confirmada' : a.status === 'agendada' ? 'Agendada' : label(a.status)}</span>
    ${a.modality === 'online' && a.meeting_link && P.hoursUntil(a.starts_at) < 1 ? html`<a class="btn" href="${a.meeting_link}" target="_blank" rel="noopener">Entrar na sessão on-line</a>` : a.modality === 'online' && a.meeting_link ? html`<p class="muted small">O link da sessão on-line aparece aqui 1 hora antes.</p>` : ''}
    ${canMove ? html`<div class="pp-acts">
      ${c.allowConfirm && a.status === 'agendada' ? html`<form method="post" action="${BASE}/sessoes/${a.id}/confirmar"><button class="btn">Confirmar presença</button></form>` : ''}
      ${c.allowReschedule ? (late(c.rescheduleMinHours) ? '' : html`<a class="btn ghost" href="${BASE}/sessoes/${a.id}/remarcar">Remarcar</a>`) : ''}
      ${c.allowCancel ? (late(c.cancelMinHours) ? '' : html`<a class="btn ghost danger-text" href="${BASE}/sessoes/${a.id}/cancelar">Cancelar</a>`) : ''}
    </div>
    ${(c.allowReschedule && late(c.rescheduleMinHours)) || (c.allowCancel && late(c.cancelMinHours)) ? html`<p class="muted small">Faltam menos de ${Math.max(c.rescheduleMinHours, c.cancelMinHours)} horas: para remarcar ou cancelar, fale com o consultório.</p>` : ''}` : ''}
  </article>`;
}

r.get('/', async (req, res) => {
  const { p } = req.pp; const c = req.ppc;
  const [next, pays, terms, ex, scl] = await Promise.all([P.upcoming(p.id), c.showPayments ? P.openPayments(p.id) : [], c.showTerms ? P.terms(p.id) : [], c.showExercises ? P.exercises(p.id) : [], Scales.pendingForPortal(p.id)]);
  const pendTerms = terms.filter((t) => t.status === 'pendente' && String(t.expires_at) > nowLocal());
  const pendEx = ex.filter((e) => ['enviado', 'aberto'].includes(e.status) && String(e.expires_at) > nowLocal());
  const total = pays.reduce((s, x) => s + Number(x.amount), 0);
  const w = await clinicWa();
  send(res, await shell(req, 'Início', 'inicio', html`
    <h1 class="pp-hi">Olá, ${P.firstName(p)}!</h1>
    <section class="pp-sec"><h2>Próxima sessão</h2>
      ${next.length ? apptCard(next[0], c, true) : html`<p class="pp-empty">Nenhuma sessão agendada.${w.link ? html` <a class="link" href="${w.link}" target="_blank" rel="noopener">Agendar pelo WhatsApp</a>` : ''}</p>`}
      ${next.length > 1 ? html`<p class="small"><a class="link" href="${BASE}/sessoes">Ver as outras ${next.length - 1} sessão(ões) agendada(s) →</a></p>` : ''}
    </section>
    ${pendTerms.length || pendEx.length || pays.length || scl.length ? html`<section class="pp-sec"><h2>Pendências</h2><div class="pp-todo">
      ${scl.map((x) => html`<a href="${BASE}/questionarios/${x.id}" class="pp-item warn"><b>📋 Questionário de acompanhamento</b><small>cerca de 2 minutos · disponível até ${brDate(x.expires_at)}</small></a>`)}
      ${pays.length ? html`<a href="${BASE}/pagamentos" class="pp-item warn"><b>💳 ${pays.length} pagamento(s) em aberto</b><small>${money(total)} · pague com Pix pelo portal</small></a>` : ''}
      ${pendTerms.map((t) => html`<a href="${BASE}/termos/${t.id}" class="pp-item"><b>📄 Termo para ler e aceitar</b><small>${JSON.parse(t.docs).map((d) => d.title).join(', ')}</small></a>`)}
      ${pendEx.map((e) => html`<a href="${BASE}/exercicios/${e.id}" class="pp-item"><b>📝 ${byKey(e.exercise_key)?.title || 'Exercício'}</b><small>enviado em ${brDate(e.created_at)} · disponível até ${brDate(e.expires_at)}</small></a>`)}
    </div></section>` : html`<section class="pp-sec"><p class="pp-empty">✨ Tudo em dia por aqui.</p></section>`}
    ${w.link ? html`<p class="pp-help"><a class="btn ghost" href="${w.link}" target="_blank" rel="noopener">Falar com o consultório no WhatsApp</a></p>` : ''}
    <p class="pp-crisis muted small">Em caso de crise: CVV 188 (24 h) · SAMU 192</p>`));
});

// ---------- sessões ----------
r.get('/sessoes', async (req, res) => {
  const { p } = req.pp;
  const [next, old] = await Promise.all([P.upcoming(p.id), P.past(p.id)]);
  send(res, await shell(req, 'Sessões', 'sessoes', html`<h1>Sessões</h1>
    <section class="pp-sec"><h2>Agendadas</h2>${next.length ? next.map((a) => apptCard(a, req.ppc)) : html`<p class="pp-empty">Nenhuma sessão agendada.</p>`}</section>
    ${old.length ? html`<section class="pp-sec"><h2>Anteriores</h2><ul class="pp-hist">${old.map((a) => html`<li><span>${brDate(a.starts_at)} · ${a.starts_at.slice(11, 16)}</span><span class="badge b-${a.status}">${label(a.status)}</span></li>`)}</ul></section>` : ''}`));
});
r.post('/sessoes/:id/confirmar', async (req, res) => {
  const out = await P.confirmAppt(req.ppc, req.pp.p.id, int(req.params.id));
  flash(res, out.ok ? 'Presença confirmada. Até lá!' : out.error, out.ok ? 'ok' : 'err');
  res.redirect(req.get('referer')?.includes('/sessoes') ? `${BASE}/sessoes` : BASE);
});
r.get('/sessoes/:id/remarcar', async (req, res) => {
  const out = await P.rescheduleSlots(req.ppc, req.pp.p.id, int(req.params.id));
  if (!out.a) { flash(res, out.error, 'err'); return res.redirect(`${BASE}/sessoes`); }
  const w = await clinicWa();
  send(res, await shell(req, 'Remarcar', 'sessoes', html`<h1>Remarcar sessão</h1>
    <p class="muted">Sessão atual: <b>${when(out.a.starts_at)}</b>. Escolha o novo horário:</p>
    ${out.error ? html`<p class="flash err">${out.error}</p>${w.link ? html`<a class="btn" href="${w.link}" target="_blank" rel="noopener">Falar pelo WhatsApp</a>` : ''}` : out.days.length ? html`
      <form method="post" class="pp-slots">
        ${out.days.map((d) => html`<fieldset class="pp-day"><legend>${d.label}</legend><div>${d.times.map((t) => html`<button class="chip" name="start" value="${d.day} ${t}:00">${t}</button>`)}</div></fieldset>`)}
      </form>` : html`<p class="pp-empty">Não há horários livres nas próximas 3 semanas.${w.link ? html` <a class="link" href="${w.link}" target="_blank" rel="noopener">Fale com o consultório</a>.` : ''}</p>`}
    <p><a class="link" href="${BASE}/sessoes">← Voltar</a></p>`));
});
r.post('/sessoes/:id/remarcar', async (req, res) => {
  const out = await P.reschedule(req.ppc, req.pp.p.id, int(req.params.id), str(req.body.start, 20));
  if (!out.ok) { flash(res, out.error, 'err'); return res.redirect(`${BASE}/sessoes/${int(req.params.id)}/remarcar`); }
  flash(res, `Pronto! Sessão remarcada para ${when(out.start)}.`);
  res.redirect(`${BASE}/sessoes`);
});
r.get('/sessoes/:id/cancelar', async (req, res) => {
  const a = await P.ownAppt(req.pp.p.id, int(req.params.id));
  if (!a) return res.redirect(`${BASE}/sessoes`);
  send(res, await shell(req, 'Cancelar', 'sessoes', html`<h1>Cancelar sessão</h1>
    <section class="pp-card"><p>Cancelar a sessão de <b>${when(a.starts_at)}</b>?</p>
    ${req.ppc.allowReschedule ? html`<p class="muted small">Se preferir, você pode <a class="link" href="${BASE}/sessoes/${a.id}/remarcar">remarcar para outro horário</a>.</p>` : ''}
    <form method="post" class="stack"><label class="fld"><span>Motivo (opcional)</span><input name="reason" maxlength="120"></label>
      <div class="actions"><button class="btn danger">Cancelar a sessão</button><a class="btn ghost" href="${BASE}/sessoes">Voltar</a></div></form></section>`));
});
r.post('/sessoes/:id/cancelar', async (req, res) => {
  const out = await P.cancel(req.ppc, req.pp.p.id, int(req.params.id), str(req.body.reason, 120));
  flash(res, out.ok ? 'Sessão cancelada. O consultório foi avisado.' : out.error, out.ok ? 'ok' : 'err');
  res.redirect(`${BASE}/sessoes`);
});

// ---------- pagamentos e recibos ----------
r.get('/pagamentos', async (req, res, next) => {
  if (!req.ppc.showPayments) return next();
  const { p } = req.pp;
  const [open, paid] = await Promise.all([P.openPayments(p.id), P.paidPayments(p.id)]);
  const gwOn = G.ready(await G.config());
  const pix = await Promise.all(open.map(async (x) => { if (gwOn && G.eligible(x)) return null; const k = await Fin.pixFor(x); return k ? { ...k, qr: await QRCode.toDataURL(k.code, { margin: 1, width: 240 }) } : null; }));
  send(res, await shell(req, 'Pagamentos', 'pagamentos', html`<h1>Pagamentos</h1>
    <section class="pp-sec"><h2>Em aberto</h2>
      ${open.length ? open.map((x, i) => html`<article class="pp-pay">
        <div class="pp-pay-h"><div><b>${x.description}</b><small>vencimento ${brDate(x.due_date)}</small></div><b class="pp-amt">${money(x.amount)}</b></div>
        ${x.informed_at ? html`<p class="pp-ok small">✓ Você avisou que pagou em ${brDateTime(x.informed_at)}. O consultório vai conferir.</p>` : ''}
        ${gwOn && G.eligible(x) ? html`<a class="btn big" href="${BASE}/pagamentos/${x.id}/pagar">Pagar agora — Pix, boleto ou cartão</a><p class="muted small">Pagamento seguro; a confirmação é automática.</p>` : ''}
        ${pix[i] ? html`<details class="pp-pix" ${i === 0 && !x.informed_at ? raw('open') : ''}><summary>Pagar com Pix</summary>
          <div class="pp-qr"><img src="${pix[i].qr}" alt="QR Code Pix de ${money(x.amount)}" width="200" height="200"></div>
          <label class="fld"><span>Pix copia e cola</span><textarea id="pix-${x.id}" rows="3" readonly>${pix[i].code}</textarea></label>
          <button type="button" class="btn ghost" data-copy="#pix-${x.id}">Copiar código Pix</button>
          <p class="muted small">Recebedor: ${pix[i].name} · chave ${pix[i].keyType}</p>
        </details>` : html`<p class="muted small">Combine a forma de pagamento com o consultório.</p>`}
        ${!x.informed_at ? html`<form method="post" action="${BASE}/pagamentos/${x.id}/paguei"><button class="btn ghost">Já paguei — avisar o consultório</button></form>` : ''}
      </article>`) : html`<p class="pp-empty">Nenhum pagamento em aberto. ✨</p>`}
    </section>
    ${paid.length ? html`<section class="pp-sec"><h2>Pagos</h2><ul class="pp-hist">${paid.map((x) => html`<li><span><b>${x.description}</b><small>${money(x.amount)} · pago em ${brDate(x.paid_at)}</small></span>${req.ppc.showReceipts ? html`<a class="chip" href="${BASE}/recibos/${x.id}" target="_blank">Recibo</a>` : ''}</li>`)}</ul></section>` : ''}`));
});
// Pagar online (Asaas): Pix com baixa automática ou link para boleto/cartão
async function openPayOf(req) {
  const x = await one("SELECT * FROM payments WHERE id = ? AND patient_id = ? AND paid_at IS NULL AND origin <> 'convenio'", [int(req.params.id), req.pp.p.id]);
  return x && G.eligible(x) && G.ready(await G.config()) ? x : null;
}
r.get('/pagamentos/:id/pagar', async (req, res, next) => {
  if (!req.ppc.showPayments) return next();
  const x = await openPayOf(req); if (!x) return res.redirect(`${BASE}/pagamentos`);
  const out = await G.ensureCharge(x.id);
  if (!out.ok && out.needCpf) {
    return send(res, await shell(req, 'Pagar', 'pagamentos', html`<h1>Pagar ${money(x.amount)}</h1><section class="pp-card"><p>Para gerar o pagamento, informe o CPF de quem vai pagar (o seu ou o do responsável).</p>
      <form method="post" action="${BASE}/pagamentos/${x.id}/cpf" class="stack"><label class="fld"><span>CPF</span><input name="cpf" inputmode="numeric" required maxlength="14" placeholder="000.000.000-00" autocomplete="off"></label><button class="btn big">Continuar</button></form>
      <p class="muted small">Usado só para emitir a cobrança (exigência dos bancos para boleto e Pix).</p></section><p><a class="link" href="${BASE}/pagamentos">← Pagamentos</a></p>`));
  }
  if (!out.ok) { flash(res, `Não foi possível gerar o pagamento agora: ${out.error}`, 'err'); return res.redirect(`${BASE}/pagamentos`); }
  const px = await G.pixOf(out.charge).catch(() => null);
  send(res, await shell(req, 'Pagar', 'pagamentos', html`<h1>Pagar ${money(x.amount)}</h1><p class="muted">${x.description} · vence ${brDate(out.charge.due_date)}</p>
    ${px?.payload ? html`<section class="pp-pay"><b>Pix — confirmação na hora</b>${px.image ? html`<div class="pp-qr"><img src="${px.image}" alt="QR Code Pix de ${money(x.amount)}" width="210" height="210"></div>` : ''}
      <label class="fld"><span>Pix copia e cola</span><textarea id="gwpix" rows="3" readonly>${px.payload}</textarea></label><button type="button" class="btn ghost" data-copy="#gwpix">Copiar código Pix</button></section>` : ''}
    <section class="pp-pay"><b>Boleto ou cartão de crédito</b><p class="muted small">Abre a página segura de pagamento.</p><a class="btn" href="${out.charge.invoice_url}" target="_blank" rel="noopener">Pagar com boleto ou cartão ↗</a></section>
    <p class="muted small">Depois de pagar, o pagamento aparece como pago aqui automaticamente (Pix e cartão em instantes; boleto em até 2 dias úteis).</p>
    <p><a class="link" href="${BASE}/pagamentos">← Pagamentos</a></p>`));
});
r.post('/pagamentos/:id/cpf', async (req, res, next) => {
  const x = await openPayOf(req); if (!x) return res.redirect(`${BASE}/pagamentos`);
  const d = String(req.body.cpf || '').replace(/\D/g, '');
  const okCpf = d.length === 11 && !/^(\d)\1+$/.test(d) && [9, 10].every((n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11 % 10; return r === Number(d[n]); });
  if (!okCpf) { flash(res, 'CPF inválido. Confira os números.', 'err'); return res.redirect(`${BASE}/pagamentos/${x.id}/pagar`); }
  const p = req.pp.p;
  if (p.payer_name) await q('UPDATE patients SET payer_cpf_enc = ? WHERE id = ?', [enc2(d), p.id]); else await q('UPDATE patients SET cpf_enc = ? WHERE id = ? AND (cpf_enc IS NULL OR cpf_enc = \'\')', [enc2(d), p.id]);
  await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['portal-cpf-pagamento', `patient:${p.id}`]);
  res.redirect(`${BASE}/pagamentos/${x.id}/pagar`);
});
r.post('/pagamentos/:id/paguei', async (req, res) => {
  const out = await P.informPaid(req.pp.p.id, int(req.params.id));
  flash(res, out.ok ? 'Obrigado! Avisamos o consultório para conferir o pagamento.' : out.error, out.ok ? 'ok' : 'err');
  res.redirect(`${BASE}/pagamentos`);
});
r.get('/recibos/:id', async (req, res, next) => {
  if (!req.ppc.showReceipts) return next();
  const x = await one("SELECT x.*, p.name, p.cpf_enc FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ? AND x.patient_id = ? AND x.paid_at IS NOT NULL AND x.origin <> 'convenio'", [int(req.params.id), req.pp.p.id]);
  if (!x) return next();
  await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['portal-recibo', `payment:${x.id}`]);
  send(res, await receiptPage(x, req));
});

// ---------- termos ----------
r.get('/termos', async (req, res, next) => {
  if (!req.ppc.showTerms) return next();
  const list = await P.terms(req.pp.p.id);
  send(res, await shell(req, 'Termos', 'termos', html`<h1>Termos</h1>
    ${list.length ? html`<div class="pp-todo">${list.map((t) => { const docs = JSON.parse(t.docs); const exp = t.status === 'pendente' && String(t.expires_at) < nowLocal(); return html`<a href="${BASE}/termos/${t.id}" class="pp-item ${t.status === 'pendente' && !exp ? 'warn' : ''}"><b>${docs.map((d) => d.title).join(', ')}</b><small>${t.status === 'aceito' ? `✓ aceito em ${brDateTime(t.decided_at)}` : t.status === 'recusado' ? `recusado em ${brDateTime(t.decided_at)}` : exp ? 'expirado — peça um novo ao consultório' : 'aguardando sua leitura e aceite'}</small></a>`; })}</div>` : html`<p class="pp-empty">Nenhum termo enviado.</p>`}`));
});
async function termOf(req) {
  const l = await one('SELECT * FROM consent_links WHERE id = ? AND patient_id = ?', [int(req.params.id), req.pp.p.id]);
  return l && l.status !== 'cancelado' ? { ...l, docs: JSON.parse(l.docs), expired: l.status === 'pendente' && String(l.expires_at) < nowLocal() } : null;
}
r.get('/termos/:id', async (req, res, next) => {
  if (!req.ppc.showTerms) return next();
  const l = await termOf(req);
  if (!l) return next();
  if (!l.opened_at) await q('UPDATE consent_links SET opened_at = NOW() WHERE id = ?', [l.id]);
  const done = l.status !== 'pendente'; const { p } = req.pp;
  send(res, await shell(req, 'Termo', 'termos', html`<h1>${l.docs.length > 1 ? 'Documentos' : l.docs[0].title}</h1>
    ${l.expired ? html`<div class="flash err">Este termo expirou. Peça um novo ao consultório.</div>` : ''}
    ${done ? html`<div class="flash ${l.status === 'aceito' ? 'ok' : 'warn'}">${l.status === 'aceito' ? `Aceito em ${brDateTime(l.decided_at)} por ${l.signer_name}.` : `Você informou que não concorda (${brDateTime(l.decided_at)}).`}</div>` : ''}
    ${l.docs.map((d, i) => html`<section class="pp-card consent-doc"><h2>${l.docs.length > 1 ? `${i + 1}. ` : ''}${d.title}</h2><div class="consent-text">${d.body}</div></section>`)}
    ${!done && !l.expired ? html`<form method="post" class="pp-card stack consent-form">
      <h2>Aceite</h2>
      ${l.docs.map((d, i) => html`<label class="cf-check"><input type="checkbox" name="doc_${i}" value="1" required> <span>Li e concordo${l.docs.length > 1 ? ` com o documento ${i + 1}: ${d.title}` : ''}</span></label>`)}
      <div class="bk-mode"><label class="maint-g"><input type="radio" name="role" value="paciente" checked><span><b>Sou o(a) paciente</b></span></label><label class="maint-g"><input type="radio" name="role" value="responsavel"><span><b>Sou o responsável legal</b></span></label></div>
      <label class="fld"><span>Nome completo de quem aceita</span><input name="signer_name" required minlength="5" maxlength="160" value="${p.name}"></label>
      <label class="fld"><span>CPF (opcional)</span><input name="signer_cpf" inputmode="numeric" maxlength="14" placeholder="000.000.000-00"></label>
      <label class="fld"><span>Parentesco (se responsável)</span><input name="relation" maxlength="60"></label>
      <p class="muted small">Registramos data, hora, endereço IP e o texto exato aceito, como comprovante.</p>
      <div class="actions"><button class="btn" name="decisao" value="aceito">Confirmar aceite</button><button class="btn ghost" name="decisao" value="recusado" formnovalidate>Não concordo</button></div>
    </form>` : ''}
    <p><a class="link" href="${BASE}/termos">← Termos</a></p>`));
});
r.post('/termos/:id', async (req, res, next) => {
  if (!req.ppc.showTerms) return next();
  const l = await termOf(req);
  if (!l) return next();
  if (l.status !== 'pendente' || l.expired) return res.redirect(`${BASE}/termos/${l.id}`);
  const b = req.body; const accept = b.decisao === 'aceito';
  if (accept && (!l.docs.every((_, i) => b[`doc_${i}`]) || str(b.signer_name, 160).length < 5 || !cpfOk(b.signer_cpf))) { flash(res, 'Marque o aceite e informe o nome completo.', 'err'); return res.redirect(`${BASE}/termos/${l.id}`); }
  await C.decide(l, { accept, signerName: str(b.signer_name, 160) || '(não informado)', signerCpf: String(b.signer_cpf || '').replace(/\D/g, '') || null, role: b.role, relation: str(b.relation, 60), ip: ipOf(req), ua: `${req.get('user-agent') || ''} [portal]` });
  flash(res, accept ? 'Obrigado! Aceite registrado.' : 'Registramos que você não concorda. O consultório entrará em contato.', accept ? 'ok' : 'warn');
  res.redirect(`${BASE}/termos`);
});

// ---------- questionários (escalas) ----------
async function scaleOf(req) {
  const a = await one("SELECT * FROM scale_apps WHERE id = ? AND patient_id = ? AND status <> 'cancelado'", [int(req.params.id), req.pp.p.id]);
  return a && Scales.INSTRUMENTS[a.instrument] ? a : null;
}
r.get('/questionarios/:id', async (req, res, next) => {
  const a = await scaleOf(req); if (!a) return next();
  const I = Scales.INSTRUMENTS[a.instrument];
  if (a.status === 'respondido') return send(res, await shell(req, I.short, 'inicio', html`<h1>Questionário respondido</h1><p class="pp-empty">Obrigado! Suas respostas já foram enviadas à sua psicóloga.</p><p><a class="link" href="${BASE}">← Início</a></p>`));
  if (String(a.expires_at) < nowLocal()) return send(res, await shell(req, I.short, 'inicio', html`<h1>Prazo encerrado</h1><p class="pp-empty">Peça um novo questionário à sua psicóloga.</p>`));
  if (!a.opened_at) await q('UPDATE scale_apps SET opened_at = NOW() WHERE id = ?', [a.id]);
  send(res, await shell(req, I.short, 'inicio', html`<h1>${I.title}</h1><div class="pp-card">${scaleForm(I.key)}</div>`));
});
r.post('/questionarios/:id', async (req, res, next) => {
  const a = await scaleOf(req); if (!a) return next();
  if (a.status !== 'pendente' || String(a.expires_at) < nowLocal()) return res.redirect(`${BASE}/questionarios/${a.id}`);
  const out = await Scales.answer(a.id, readAnswers(a.instrument, req.body), req.body.func, 'portal');
  if (!out || out.error) { flash(res, out?.error || 'Responda todas as perguntas.', 'err'); return res.redirect(`${BASE}/questionarios/${a.id}`); }
  send(res, await shell(req, 'Obrigado', 'inicio', html`${scaleThanks(out)}<p><a class="link" href="${BASE}">← Início</a></p>`));
});

// ---------- exercícios ----------
r.get('/exercicios', async (req, res, next) => {
  if (!req.ppc.showExercises) return next();
  const list = await P.exercises(req.pp.p.id);
  const st = { enviado: 'novo', aberto: 'começado', respondido: '✓ respondido', revisado: '✓ revisado pela psicóloga' };
  send(res, await shell(req, 'Exercícios', 'exercicios', html`<h1>Exercícios</h1>
    ${list.length ? html`<div class="pp-todo">${list.map((e) => html`<a href="${BASE}/exercicios/${e.id}" class="pp-item ${['enviado', 'aberto'].includes(e.status) ? 'warn' : ''}"><b>${byKey(e.exercise_key)?.title || 'Exercício'}</b><small>${st[e.status]} · enviado em ${brDate(e.created_at)}</small></a>`)}</div>` : html`<p class="pp-empty">Nenhum exercício enviado.</p>`}`));
});
async function exOf(req) {
  const s = await one('SELECT * FROM assignments WHERE id = ? AND patient_id = ?', [int(req.params.id), req.pp.p.id]);
  if (!s || !byKey(s.exercise_key)) return null;
  return s;
}
r.get('/exercicios/:id', async (req, res, next) => {
  if (!req.ppc.showExercises) return next();
  const s = await exOf(req);
  if (!s) return next();
  const ex = byKey(s.exercise_key);
  const open = String(s.expires_at) > nowLocal() && s.status !== 'revisado';
  if (!s.opened_at) await q("UPDATE assignments SET opened_at = ?, status = IF(status='enviado','aberto',status) WHERE id = ?", [nowLocal(), s.id]);
  const resp = s.response_enc ? JSON.parse(decrypt(s.response_enc)) : {};
  send(res, await shell(req, ex.title, 'exercicios', html`<h1>${ex.title}</h1>
    ${s.instructions ? html`<p class="note">${s.instructions}</p>` : ''}
    ${ex.pdf ? html`<p><a class="btn ghost" href="${BASE}/exercicios/${s.id}/folha.pdf">Baixar a folha em PDF</a></p>` : ''}
    ${ex.form ? (open ? html`<form method="post" class="pp-card portal-form">${renderForm(ex.form, resp)}<button class="btn big">Enviar respostas</button><p class="muted small">Não existe resposta certa ou errada. Escreva do seu jeito.</p></form>`
      : html`<section class="pp-card answers">${Object.keys(resp).length ? renderResponse(ex.form, resp) : html`<p class="muted">Sem respostas.</p>`}</section><p class="muted">${s.status === 'revisado' ? 'Este exercício já foi revisado pela sua psicóloga.' : 'O prazo para responder terminou.'}</p>`)
      : html`<p>Imprima a folha (ou preencha à mão) e leve para a próxima sessão.</p>`}
    <p><a class="link" href="${BASE}/exercicios">← Exercícios</a></p>`));
});
r.post('/exercicios/:id', async (req, res, next) => {
  if (!req.ppc.showExercises) return next();
  const s = await exOf(req);
  if (!s) return next();
  const ex = byKey(s.exercise_key);
  if (!ex.form || s.status === 'revisado' || String(s.expires_at) < nowLocal()) return res.redirect(`${BASE}/exercicios/${s.id}`);
  await q("UPDATE assignments SET response_enc = ?, responded_at = ?, status = 'respondido' WHERE id = ?", [encrypt(JSON.stringify(parseForm(ex.form, req.body))), nowLocal(), s.id]);
  notify(req.pp.p.owner_id, { title: '📝 Exercício respondido', body: `${P.firstName(req.pp.p)} respondeu “${ex.title}” pelo portal`, url: `/exercicios/envio/${s.id}`, tag: `ex-${s.id}` });
  flash(res, 'Pronto! Suas respostas foram enviadas.');
  res.redirect(`${BASE}/exercicios/${s.id}`);
});
r.get('/exercicios/:id/folha.pdf', async (req, res, next) => {
  const s = await exOf(req);
  if (!s) return next();
  const file = path.join(Tenancy.filesDir(PRIVATE), byKey(s.exercise_key).pdf || '');
  if (!byKey(s.exercise_key).pdf || !fs.existsSync(file)) return next();
  res.sendFile(file);
});
r.use((req, res) => res.redirect(BASE));
export default r;

// ---------- lado da equipe ----------
export const staff = router();
staff.post('/enviar/:pid', async (req, res, next) => {
  const p = await one('SELECT * FROM patients WHERE id = ?', [int(req.params.pid)]);
  if (!p) return next();
  if (!canSeePatient(req.user, p)) throw forbidden();
  const c = await P.config();
  if (!c.enabled) return res.flash('Ligue o portal em Configurações → Portal do paciente.', 'err').redirect(`/pacientes/${p.id}?aba=dados#portal`);
  const phone = p.phone || p.responsible_phone;
  if (!phone) return res.flash('O paciente não tem WhatsApp cadastrado.', 'err').redirect(`/pacientes/${p.id}?aba=dados#portal`);
  const token = await P.createLink(p.id, req.user.id);
  const url = `${Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`}${BASE}/acesso/${token}`;
  const out = await WA.send({ phone, text: `Olá, ${P.firstName(p)}! Este é o seu acesso ao portal do paciente, onde você vê suas sessões, remarca, paga com Pix, baixa recibos e responde termos e exercícios:\n${url}\n\nO link é pessoal e vale por 7 dias. Depois, entre em ${Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`}${BASE} com o seu WhatsApp. Dá para instalar no celular como aplicativo.`, kind: 'manual', patient_id: p.id, user_id: req.user.id });
  await audit(req, 'portal-enviar-acesso', `patient:${p.id}`);
  res.flash(out.ok ? 'Acesso ao portal enviado pelo WhatsApp.' : `Não foi possível enviar pelo WhatsApp (${out.error || 'erro'}). Link (vale 7 dias): ${url}`, out.ok ? 'ok' : 'err').redirect(`/pacientes/${p.id}?aba=dados#portal`);
});
staff.post('/encerrar/:pid', async (req, res, next) => {
  const p = await one('SELECT * FROM patients WHERE id = ?', [int(req.params.pid)]);
  if (!p) return next();
  if (!canSeePatient(req.user, p)) throw forbidden();
  await P.revokeAll(p.id);
  await audit(req, 'portal-encerrar-acessos', `patient:${p.id}`);
  res.flash('Acessos ao portal encerrados em todos os aparelhos.').redirect(`/pacientes/${p.id}?aba=dados#portal`);
});
export async function staffCard(req, p) {
  const c = await P.config();
  const s = await P.activeSessions(p.id);
  return html`<section class="card" id="portal"><h2>Portal do paciente</h2>
    ${!c.enabled ? html`<p class="muted">O portal está desligado (Configurações → Portal do paciente).</p>` : html`
    <p class="muted small">${p.portal_last_at ? `Último acesso: ${brDateTime(p.portal_last_at)}` : 'Ainda não acessou.'}${Number(s.n) ? ` · conectado em ${s.n} aparelho(s)` : ''}. O paciente também pode entrar sozinho em <b>/paciente</b> com o WhatsApp do cadastro${p.responsible_phone ? ' ou o do responsável' : ''}.</p>
    <div class="actions"><form method="post" action="/portal-paciente/enviar/${p.id}" class="inline"><button class="btn ghost" ${p.phone || p.responsible_phone ? '' : raw('disabled')}>Enviar acesso pelo WhatsApp</button></form>
      ${Number(s.n) ? html`<form method="post" action="/portal-paciente/encerrar/${p.id}" class="inline"><button class="btn ghost danger-text" data-confirm="Encerrar o acesso ao portal em todos os aparelhos deste paciente?">Encerrar acessos</button></form>` : ''}</div>`}
  </section>`;
}

// ---------- Configurações → Portal do paciente ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const c = await P.config();
  const n = await one('SELECT COUNT(DISTINCT patient_id) n FROM portal_sessions WHERE last_seen_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)');
  const yes = (v) => (v ? raw('checked') : '');
  send(res, page(req, { title: 'Portal do paciente', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Portal do paciente</h1>
      <p class="muted">Área do paciente, instalável no celular: próximas sessões (confirmar, remarcar, cancelar), pagamentos com Pix, recibos, termos e exercícios. Entrada com código pelo WhatsApp do cadastro.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/paciente" target="_blank">Abrir o portal</a><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <label class="fld check"><input type="checkbox" name="enabled" value="1" ${yes(c.enabled)}><span><b>Ligar o portal do paciente</b> <small class="muted">(endereço: ${req.protocol}://${req.get('host')}/paciente)</small></span></label>
      <h3>Sessões</h3>
      <label class="fld check"><input type="checkbox" name="allowConfirm" value="1" ${yes(c.allowConfirm)}><span>Paciente pode confirmar presença</span></label>
      <div class="form-grid">
        <label class="fld check"><input type="checkbox" name="allowReschedule" value="1" ${yes(c.allowReschedule)}><span>Paciente pode remarcar (horários livres da escala do profissional)</span></label>
        <label class="fld"><span>Até quantas horas antes</span><input type="number" name="rescheduleMinHours" min="0" max="168" value="${c.rescheduleMinHours}"></label>
        <label class="fld check"><input type="checkbox" name="allowCancel" value="1" ${yes(c.allowCancel)}><span>Paciente pode cancelar</span></label>
        <label class="fld"><span>Até quantas horas antes</span><input type="number" name="cancelMinHours" min="0" max="168" value="${c.cancelMinHours}"></label>
      </div>
      <p class="muted small">Dentro desse prazo o portal pede para falar com o consultório. Remarcações e cancelamentos avisam o profissional (notificação), atualizam o Google Agenda e oferecem o horário livre à lista de espera.</p>
      <h3>O que aparece</h3>
      <label class="fld check"><input type="checkbox" name="showPayments" value="1" ${yes(c.showPayments)}><span>Pagamentos em aberto, com Pix copia e cola e QR Code (e o botão “Já paguei”, que avisa a equipe)</span></label>
      <label class="fld check"><input type="checkbox" name="showReceipts" value="1" ${yes(c.showReceipts)}><span>Recibos dos pagamentos confirmados</span></label>
      <label class="fld check"><input type="checkbox" name="showTerms" value="1" ${yes(c.showTerms)}><span>Termos enviados (o paciente lê e aceita pelo portal)</span></label>
      <label class="fld check"><input type="checkbox" name="showExercises" value="1" ${yes(c.showExercises)}><span>Exercícios enviados (responde pelo portal)</span></label>
      <label class="fld"><span>Mensagem na tela de entrada (opcional)</span><textarea name="welcome" rows="2" maxlength="500">${c.welcome}</textarea></label>
      <div class="actions"><button class="btn">Salvar</button></div>
      <p class="muted small">Segurança: o código vale 10 minutos e só é enviado para WhatsApp cadastrado; o aparelho fica conectado por até 90 dias; trocar o WhatsApp no cadastro desconecta os aparelhos antigos. Na ficha do paciente (aba Dados) dá para enviar o acesso e encerrar os acessos. Pacientes que usaram nos últimos 30 dias: ${n.n}.</p>
    </form>` }));
});
settings.post('/', async (req, res) => {
  await P.saveConfig(req.body);
  await audit(req, 'portal-config');
  res.flash('Portal do paciente salvo.').redirect('/configuracoes/portal');
});
export const DAY = DAY_MS;
