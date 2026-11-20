import * as Tenancy from '../lib/tenancy.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, badge, brDate, brDateTime, waLink } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { encrypt, decrypt, randomToken, sha256 } from '../lib/crypto.js';
import { nowLocal, todayLocal, addDays } from '../lib/time.js';
import { EXERCISES, BOOKS, byKey } from '../lib/exercises.js';
import { renderForm, parseForm, renderResponse } from '../lib/forms.js';
import { patientScope, canSeePatient, forbidden } from '../lib/perm.js';
import * as WA from '../lib/whatsapp.js';
import { notify } from '../lib/push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE = path.join(__dirname, '..', 'private');
const r = router();
r.param('id', async (req, res, next, id) => {
  try {
    const s = await one('SELECT p.owner_id FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [int(id)]);
    if (s && !canSeePatient(req.user, s)) return next(forbidden());
    next();
  } catch (e) { next(e); }
});
const nm = (p) => p.social_name || p.name;
const baseUrl = (req) => Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`;

// ---------- catálogo ----------
r.get('/', async (req, res) => {
  const sc = patientScope(req.user);
  const counts = await q(`SELECT s.exercise_key, COUNT(*) n FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE 1=1 ${sc.sql} GROUP BY s.exercise_key`, sc.params);
  const used = Object.fromEntries(counts.map((c) => [c.exercise_key, c.n]));
  const pending = await q(`SELECT s.*, p.name, p.social_name FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.status IN ('enviado','aberto','respondido') ${sc.sql} ORDER BY s.created_at DESC LIMIT 30`, sc.params);
  send(res, page(req, {
    title: 'Exercícios', active: 'exercicios',
    body: html`
    <header class="ph"><div><p class="eyebrow">Cadernos do consultório</p><h1>Exercícios</h1></div></header>
    <p class="lead">Envie qualquer folha dos três cadernos para o paciente por um link seguro. As folhas <span class="badge b-confirmada">interativas</span> são preenchidas no celular e chegam aqui com gráficos; as demais são entregues em PDF para imprimir.</p>
    ${pending.length ? html`<section class="card flush"><h2 class="pad-h">Em andamento</h2><div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Paciente</th><th>Folha</th><th>Enviado</th><th>Situação</th></tr></thead>
      <tbody>${pending.map((s) => html`<tr data-href="/exercicios/envio/${s.id}"><td><a href="/exercicios/envio/${s.id}">${nm(s)}</a></td><td>${byKey(s.exercise_key)?.title || s.exercise_key}</td><td>${brDate(s.created_at)}</td><td>${badge(s.status)}</td></tr>`)}</tbody></table></div></section>` : ''}
    ${Object.entries(BOOKS).map(([k, b]) => html`
      <section class="card"><h2>${b.title}</h2>
      <div class="ex-grid">${EXERCISES.filter((e) => e.book === k).map((e) => html`
        <article class="ex"><span class="ex-n">${e.num}</span><div><b>${e.title}</b>
          <small>${e.form ? html`<span class="badge b-confirmada">interativa</span>` : html`<span class="badge b-agendada">PDF</span>`}${used[e.key] ? ` · enviada ${used[e.key]}×` : ''}</small></div>
          <div class="ex-actions">${e.form ? html`<a class="link small" href="/exercicios/ver/${e.key}">prévia</a>` : ''}<a class="link small" href="/folhas/${e.pdf}" target="_blank">PDF</a></div>
        </article>`)}</div></section>`)}`,
  }));
});

r.get('/ver/:book/:slug', (req, res, next) => {
  const ex = byKey(`${req.params.book}/${req.params.slug}`);
  if (!ex || !ex.form) return next();
  send(res, page(req, {
    title: ex.title, active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow">${ex.bookTitle} · prévia</p><h1>${ex.title}</h1></div><div class="ph-actions"><a class="btn ghost" href="/folhas/${ex.pdf}" target="_blank">PDF</a></div></header>
    <section class="card portal-form preview">${renderForm(ex.form)}</section>`,
  }));
});

// ---------- envio para o paciente ----------
r.post('/enviar', async (req, res) => {
  const p = await one('SELECT id, name, social_name, phone, owner_id FROM patients WHERE id = ?', [int(req.body.patient_id)]);
  if (p && !canSeePatient(req.user, p)) throw forbidden();
  const ex = byKey(req.body.exercise_key);
  if (!p || !ex) return res.flash('Selecione o paciente e a folha.', 'err').redirect('/exercicios');
  const days = [7, 14, 30].includes(int(req.body.days)) ? int(req.body.days) : 14;
  const token = randomToken();
  const out = await q('INSERT INTO assignments (patient_id, exercise_key, token_hash, instructions, expires_at) VALUES (?,?,?,?,?)',
    [p.id, ex.key, sha256(token), str(req.body.instructions, 1000) || null, `${addDays(todayLocal(), days)} 23:59:59`]);
  await audit(req, 'exercicio-enviar', `assignment:${out.insertId}`);
  let sent = null;
  if (req.body.wa) sent = await WA.sendExercise(p.id, ex.title, `${baseUrl(req)}/p/${token}`, req.user.id);
  showLink(req, res, out.insertId, token, sent);
});

// Gera um novo link e envia automaticamente pelo WhatsApp.
r.post('/envio/:id/whatsapp', async (req, res, next) => {
  const s = await one('SELECT id, patient_id, exercise_key FROM assignments WHERE id = ?', [int(req.params.id)]);
  if (!s) return next();
  const token = randomToken();
  await q('UPDATE assignments SET token_hash = ?, expires_at = GREATEST(expires_at, ?) WHERE id = ?', [sha256(token), `${addDays(todayLocal(), 7)} 23:59:59`, s.id]);
  const r2 = await WA.sendExercise(s.patient_id, byKey(s.exercise_key)?.title || 'exercício', `${baseUrl(req)}/p/${token}`, req.user.id);
  await audit(req, 'exercicio-whatsapp', `assignment:${s.id}`);
  res.flash(r2.ok ? 'Link enviado pelo WhatsApp.' : `Não enviado: ${r2.error}`, r2.ok ? 'ok' : 'err').redirect(`/exercicios/envio/${s.id}`);
});

async function showLink(req, res, id, token, sent = null) {
  const waOn = WA.ready(await WA.config());
  const s = await one('SELECT s.*, p.name, p.social_name, p.phone FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [id]);
  const ex = byKey(s.exercise_key);
  const link = `${baseUrl(req)}/p/${token}`;
  const wa = waLink(s.phone, `Olá, ${nm(s).split(' ')[0]}! Conforme combinamos na sessão, segue o exercício “${ex.title}”. É só abrir o link: ${link}\n\nO link é pessoal, não compartilhe. — Dra. Lorrainy Mendes, Psicóloga`);
  send(res, page(req, {
    title: 'Link gerado', active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow">${nm(s)}</p><h1>Link do exercício</h1></div></header>
    <section class="card">
      <p><b>${ex.title}</b> · válido até ${brDate(s.expires_at)}</p>
      <div class="copy"><input readonly value="${link}" id="lnk"><button class="btn ghost" data-copy="#lnk">Copiar</button></div>
      ${sent ? html`<div class="flash ${sent.ok ? 'ok' : 'err'}">${sent.ok ? 'Link enviado automaticamente pelo WhatsApp.' : `WhatsApp não enviado: ${sent.error}`}</div>` : ''}
      <div class="actions">${waOn && !sent?.ok ? html`<form method="post" action="/exercicios/envio/${id}/whatsapp"><button class="btn">Enviar pelo WhatsApp (automático)</button></form>` : ''}${!waOn && wa ? html`<a class="btn" href="${wa}" target="_blank" rel="noopener">Enviar pelo WhatsApp</a>` : ''}<a class="btn ghost" href="/pacientes/${s.patient_id}?aba=exercicios">Voltar ao paciente</a></div>
      <p class="muted small">Por segurança, o link só é exibido agora. Se perder, use “Gerar novo link” na página do envio.</p>
    </section>`,
  }));
}

r.get('/envio/:id', async (req, res, next) => {
  const s = await one('SELECT s.*, p.name, p.social_name FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [int(req.params.id)]);
  if (!s) return next();
  const ex = byKey(s.exercise_key);
  const resp = s.response_enc ? JSON.parse(decrypt(s.response_enc)) : null;
  await audit(req, 'exercicio-ver', `assignment:${s.id}`);
  send(res, page(req, {
    title: ex?.title || 'Exercício', active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow"><a href="/pacientes/${s.patient_id}?aba=exercicios">${nm(s)}</a> · ${ex?.bookTitle || ''}</p><h1>${ex?.title || s.exercise_key}</h1></div>
      <div class="ph-actions">${badge(s.status)}
        ${s.status === 'respondido' ? html`<form method="post" action="/exercicios/envio/${s.id}/revisado"><button class="btn">Marcar como revisado</button></form>` : ''}
        <form method="post" action="/exercicios/envio/${s.id}/novo-link"><button class="btn ghost">Gerar novo link</button></form>
        ${WA.ready(await WA.config()) && s.status !== 'revisado' ? html`<form method="post" action="/exercicios/envio/${s.id}/whatsapp"><button class="btn ghost">Reenviar pelo WhatsApp</button></form>` : ''}
        ${resp ? html`<button class="btn ghost" data-print>Imprimir</button>` : ''}
      </div></header>
    <section class="card"><dl class="dl compact"><dt>Enviado</dt><dd>${brDateTime(s.created_at)}</dd><dt>Aberto</dt><dd>${brDateTime(s.opened_at)}</dd><dt>Respondido</dt><dd>${brDateTime(s.responded_at)}</dd><dt>Validade</dt><dd>${brDate(s.expires_at)}</dd>
      ${s.instructions ? html`<dt>Orientação</dt><dd>${s.instructions}</dd>` : ''}</dl></section>
    <section class="card answers">${ex?.form ? renderResponse(ex.form, resp) : html`<p>Folha entregue em PDF. <a class="link" href="/folhas/${ex?.pdf}" target="_blank">Abrir folha</a></p>`}</section>
    <form method="post" action="/exercicios/envio/${s.id}/excluir" class="danger-zone" data-confirm="Excluir este envio e a resposta?"><button class="btn danger">Excluir envio</button></form>`,
  }));
});

r.post('/envio/:id/revisado', async (req, res) => {
  await q(`UPDATE assignments SET status = 'revisado' WHERE id = ?`, [int(req.params.id)]);
  res.flash('Marcado como revisado.').redirect(`/exercicios/envio/${int(req.params.id)}`);
});

r.post('/envio/:id/novo-link', async (req, res, next) => {
  const s = await one('SELECT id FROM assignments WHERE id = ?', [int(req.params.id)]);
  if (!s) return next();
  const token = randomToken();
  await q(`UPDATE assignments SET token_hash = ?, expires_at = ?, status = IF(status='revisado','revisado',status) WHERE id = ?`, [sha256(token), `${addDays(todayLocal(), 14)} 23:59:59`, s.id]);
  await audit(req, 'exercicio-novo-link', `assignment:${s.id}`);
  showLink(req, res, s.id, token);
});

r.post('/envio/:id/excluir', async (req, res, next) => {
  const s = await one('SELECT id, patient_id FROM assignments WHERE id = ?', [int(req.params.id)]);
  if (!s) return next();
  await q('DELETE FROM assignments WHERE id = ?', [s.id]);
  await audit(req, 'exercicio-excluir', `assignment:${s.id}`);
  res.flash('Envio excluído.').redirect(`/pacientes/${s.patient_id}?aba=exercicios`);
});

export default r;

// =====================================================================
// Portal do paciente: /p/:token  (sem login; link pessoal com validade)
// =====================================================================
export const portal = router();

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(String(token))) return null;
  const s = await one('SELECT s.*, p.name, p.social_name FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.token_hash = ?', [sha256(token)]);
  if (!s || s.expires_at < nowLocal()) return null;
  return s;
}

const portalShell = (title, inner) => bare(title, html`
  <div class="portal">
    <header class="portal-h"><img class="logo-light" src="/static/img/logo-terracota.png" alt="Lorrainy Mendes"><img class="logo-dark" src="/static/img/logo-creme.png" alt="Lorrainy Mendes"><span>Psicóloga · CRP 09/23862</span></header>
    ${inner}
    <footer class="portal-f">Este link é pessoal e sigiloso. Suas respostas são vistas apenas pela sua psicóloga.<br>Em caso de crise: CVV 188 · SAMU 192</footer>
  </div>`, 'bare portal-bg');

const expired = () => portalShell('Link indisponível', html`<section class="portal-card"><h1>Link indisponível</h1><p>Este link expirou ou não é válido. Peça um novo link à sua psicóloga.</p></section>`);

portal.get('/:token', async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) return res.status(404).type('html').send(String(expired()));
  const ex = byKey(s.exercise_key);
  if (!s.opened_at) await q(`UPDATE assignments SET opened_at = ?, status = IF(status='enviado','aberto',status) WHERE id = ?`, [nowLocal(), s.id]);
  const resp = s.response_enc ? JSON.parse(decrypt(s.response_enc)) : {};
  const locked = s.status === 'revisado';
  const done = req.query.ok === '1';
  send(res, portalShell(ex.title, html`
    <section class="portal-card">
      <p class="eyebrow">Olá, ${nm(s).split(' ')[0]}</p>
      <h1>${ex.title}</h1>
      ${s.instructions ? html`<p class="note">${s.instructions}</p>` : ''}
      ${done ? html`<div class="flash ok">Pronto! Suas respostas foram enviadas. Você pode voltar a este link para completar até ${brDate(s.expires_at)}.</div>` : ''}
      <p><a class="btn ghost" href="/p/${req.params.token}/folha.pdf">Baixar a folha em PDF</a></p>
      ${ex.form ? (locked ? html`<div class="answers">${renderResponse(ex.form, resp)}</div><p class="muted">Este exercício já foi revisado pela sua psicóloga.</p>` : html`
        <form method="post" class="portal-form">${renderForm(ex.form, resp)}
          <button class="btn big" type="submit">Enviar respostas</button>
          <p class="muted small">Não existe resposta certa ou errada. Escreva do seu jeito.</p>
        </form>`) : html`<p>Imprima a folha (ou preencha à mão) e leve para a próxima sessão.</p>`}
    </section>`));
});

portal.post('/:token', async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) return res.status(404).type('html').send(String(expired()));
  const ex = byKey(s.exercise_key);
  if (!ex.form || s.status === 'revisado') return res.redirect(`/p/${req.params.token}`);
  const data = parseForm(ex.form, req.body);
  await q(`UPDATE assignments SET response_enc = ?, responded_at = ?, status = 'respondido' WHERE id = ?`, [encrypt(JSON.stringify(data)), nowLocal(), s.id]);
  const owner = await one('SELECT owner_id FROM patients WHERE id = ?', [s.patient_id]);
  notify(owner?.owner_id, { title: '📝 Exercício respondido', body: `${nm(s).split(' ')[0]} respondeu “${ex.title}”`, url: `/exercicios/envio/${s.id}`, tag: `ex-${s.id}` });
  res.redirect(`/p/${req.params.token}?ok=1`);
});

portal.get('/:token/folha.pdf', async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) return res.sendStatus(404);
  const file = path.join(PRIVATE, byKey(s.exercise_key).pdf);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.sendFile(file);
});
