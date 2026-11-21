// Marketing → Reativação de pacientes (convite para retomar), com configuração e o link público para não receber mais.
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, brDate } from '../lib/html.js';
import { router, send, int } from '../lib/router.js';
import { can, patientScope, canSeePatient, proName } from '../lib/perm.js';
import { todayLocal } from '../lib/time.js';
import * as RA from '../lib/reactivation.js';
import * as E from '../lib/engage.js';
import * as WA from '../lib/whatsapp.js';
import * as Notify from '../lib/notify.js';
import * as MAI from '../lib/mktai.js';
import express from 'express';

const r = router();
const nm = (p) => p.social_name || p.name;
const weeksAgo = (d) => Math.max(0, Math.floor((Date.parse(todayLocal()) - Date.parse(String(d).slice(0, 10))) / (7 * 864e5)));
const CH = { whatsapp: 'WhatsApp', email: 'E-mail' };
const tabs = (on, req) => html`<nav class="tabs"><a href="/marketing" class="${on === 'reativacao' ? 'on' : ''}">Reativação de pacientes</a><a href="/marketing/aniversarios" class="${on === 'aniversarios' ? 'on' : ''}">Aniversários</a><a href="/marketing/cartao">Cartão digital</a><a href="/marketing/links">Link na bio</a>${can(req.user, 'usuarios') ? html`<a href="/marketing/configurar" class="${on === 'config' ? 'on' : ''}">Configurar a reativação</a>` : ''}</nav>`;
const sel = (a, b) => (String(a) === String(b) ? raw('selected') : '');
// Gerar o texto com IA: o resultado aparece em cartões e “Usar esta” troca o texto da caixa
const aiBox = (kind, target) => html`<div class="mkt-ai" data-mkt-ai="${kind}" data-target="${target}">
  <span class="mkt-ai-h">✨ Gerar nova mensagem com IA</span>
  <select data-mkt-tone aria-label="Tom da mensagem">${Object.entries(MAI.TONES).map(([k, l]) => html`<option value="${k}">${l[0].toUpperCase() + l.slice(1)}</option>`)}</select>
  <button type="button" class="btn ghost btn-sm" data-mkt-go>Gerar 3 opções</button>
  <div class="mkt-ai-out" data-mkt-out aria-live="polite"></div></div>`;

r.get('/', async (req, res) => {
  const c = await RA.config();
  const weeks = RA.WEEKS.includes(int(req.query.semanas)) ? int(req.query.semanas) : c.weeks;
  const scope = patientScope(req.user);
  const pros = scope.params.length ? [] : await q("SELECT id, name, title FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY name");
  const prof = scope.params.length ? null : int(req.query.prof) || null;
  const list = await RA.candidates({ ...c, weeks, scope, ownerId: prof });
  const [st, hist] = await Promise.all([RA.stats({ scope }), RA.history({ scope })]);
  const reach = list.filter((p) => RA.channelOf(p, c)).length;
  const qs = (o) => `?${new URLSearchParams({ semanas: weeks, ...(prof ? { prof } : {}), ...o })}`;
  send(res, page(req, { title: 'Marketing · Reativação', active: 'marketing', body: html`<header class="ph"><div><p class="eyebrow">Marketing</p><h1>Reativação de pacientes</h1>
      <p class="muted">Quem parou de vir: sem sessão há ${weeks} semanas ou mais e sem nada marcado. Um convite gentil para retomar, com link para agendar e para não receber mais.</p></div></header>
    ${tabs('reativacao', req)}
    <section class="kpis">
      <div class="kpi"><span>Afastados agora</span><b>${list.length}</b><small>${reach} com WhatsApp ou e-mail autorizado</small></div>
      <div class="kpi"><span>Convidados (90 dias)</span><b>${st.sent}</b><small>${c.auto ? `automático: até ${c.maxPerDay} por dia às ${c.hour}h` : 'envio manual'}</small></div>
      <div class="kpi"><span>Voltaram</span><b>${st.back}</b><small>${st.sent ? `${Math.round((st.back / st.sent) * 100)}% marcaram sessão depois do convite` : 'ainda sem convites'}</small></div>
    </section>
    <div class="filters">${RA.WEEKS.map((w) => html`<a class="chip ${w === weeks ? 'on' : ''}" href="${qs({ semanas: w })}">${w < 26 ? `${w} semanas` : '6 meses'}</a>`)}
      ${pros.length > 1 ? html`<form method="get" class="inline"><input type="hidden" name="semanas" value="${weeks}"><select name="prof" data-autosubmit aria-label="Profissional"><option value="">Todos os profissionais</option>${pros.map((u) => html`<option value="${u.id}" ${prof === u.id ? raw('selected') : ''}>${proName(u)}</option>`)}</select></form>` : ''}</div>
    ${list.length ? html`<form method="post" action="/marketing/convidar" class="card flush" id="afastados">
      <input type="hidden" name="back" value="/marketing${qs({})}">
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" data-check-all aria-label="Selecionar todos"></th><th>Paciente</th><th>Última sessão</th><th class="num">Sessões</th><th>Profissional</th><th>Convite por</th><th></th></tr></thead>
      <tbody>${list.map((p) => { const ch = RA.channelOf(p, c); return html`<tr data-id="${p.id}"><td><input type="checkbox" name="ids" value="${p.id}" ${ch ? '' : raw('disabled')} aria-label="Selecionar ${nm(p)}"></td>
        <td><a href="/pacientes/${p.id}">${nm(p)}</a>${p.status !== 'ativo' ? html` <small class="muted">· ${p.status === 'pausa' ? 'em pausa' : 'alta'}</small>` : ''}${p.last_invite ? html`<br><small class="muted">convidado em ${brDate(p.last_invite)}</small>` : ''}</td>
        <td>${brDate(p.last_at)} <small class="muted">· há ${weeksAgo(p.last_at)} sem.</small></td><td class="num">${p.sessions}</td><td>${p.pro ? proName({ name: p.pro, title: p.pro_title }) : '—'}</td>
        <td>${ch ? CH[ch] : html`<small class="err-txt">sem contato autorizado</small>`}</td>
        <td class="nf-acts"><button class="btn ghost btn-sm" formaction="/marketing/nao-contatar/${p.id}" title="Não enviar convites para este paciente">Não contatar</button></td></tr>`; })}</tbody></table></div>
      <div class="actions pad"><button class="btn" data-confirm="Enviar o convite de retorno para os pacientes selecionados?">Enviar convite aos selecionados</button>
        <details class="react-prev"><summary class="small">Ver a mensagem</summary><pre class="react-msg">${await RA.render(list.find((p) => RA.channelOf(p, c)) || list[0], c)}</pre></details></div>
    </form>` : html`<section class="card"><p class="muted">Ninguém afastado há ${weeks} semanas ou mais. 🎉</p></section>`}
    <section class="card"><h2>Convites enviados (6 meses)</h2>
      ${hist.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Enviado em</th><th>Paciente</th><th>Canal</th><th>Resultado</th></tr></thead><tbody>
        ${hist.map((h) => html`<tr><td>${brDate(h.sent_at)} ${String(h.sent_at).slice(11, 16)}${h.auto ? html` <small class="muted">· automático</small>` : ''}</td><td><a href="/pacientes/${h.patient_id}">${nm(h)}</a></td><td>${CH[h.channel] || h.channel}</td>
          <td>${h.back_appt ? html`<span class="badge b-realizada">Voltou · marcou sessão</span>` : html`<span class="muted small">aguardando</span>`}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nenhum convite ainda.</p>`}
    </section>
    <p class="muted small">Só recebem convite pacientes que autorizaram WhatsApp ou e-mail e que não pediram para sair. Cada paciente recebe no máximo um convite a cada ${c.cooldownDays} dias. A mensagem não fala de saúde nem de motivos do afastamento.</p>` }));
});
r.post('/convidar', async (req, res) => {
  const c = await RA.config();
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean).slice(0, 100);
  let ok = 0; const fails = [];
  for (const id of ids) {
    const p = await one('SELECT id, owner_id FROM patients WHERE id = ?', [id]);
    if (!canSeePatient(req.user, p)) continue;
    const out = await RA.invite(p, { c, userId: req.user.id });
    if (out.ok) ok++; else fails.push(out.error);
  }
  await audit(req, 'marketing-reativacao', `${ok} convite(s)`);
  const back = String(req.body.back || '/marketing'); const dest = back.startsWith('/marketing') ? back : '/marketing';
  res.flash(ok ? `${ok} convite(s) enviado(s).${fails.length ? ` ${fails.length} não enviado(s): ${[...new Set(fails)].join('; ')}` : ''}` : `Nenhum convite enviado${fails.length ? `: ${[...new Set(fails)].join('; ')}` : '. Selecione os pacientes.'}`, ok ? (fails.length ? 'warn' : 'ok') : 'err').redirect(dest);
});
r.post('/nao-contatar/:id', async (req, res) => {
  const p = await one('SELECT id, owner_id, name, social_name FROM patients WHERE id = ?', [int(req.params.id)]);
  if (!canSeePatient(req.user, p)) return res.status(403).send('Sem permissão');
  await RA.optOut(p.id);
  await audit(req, 'marketing-nao-contatar', `patient:${p.id}`);
  const back = String(req.body.back || '/marketing');
  res.flash(`${nm(p)} não receberá mais convites de retorno.`).redirect(back.startsWith('/marketing') ? back : '/marketing');
});

r.get('/configurar', async (req, res) => {
  if (!can(req.user, 'usuarios')) return res.status(403).send('Sem permissão');
  const c = await RA.config();
  const ck = (v) => (v ? raw('checked') : '');
  send(res, page(req, { title: 'Marketing · Configurar', active: 'marketing', body: html`<header class="ph"><div><p class="eyebrow">Marketing</p><h1>Configurar a reativação</h1></div></header>
    ${tabs('config', req)}
    <form method="post" class="card stack">
      <div class="form-grid">
        <label class="fld"><span>Afastado depois de</span><select name="weeks">${RA.WEEKS.map((w) => html`<option value="${w}" ${c.weeks === w ? raw('selected') : ''}>${w < 26 ? `${w} semanas sem sessão` : '6 meses sem sessão'}</option>`)}</select></label>
        <label class="fld"><span>Intervalo mínimo entre convites (dias)</span><input type="number" name="cooldownDays" min="30" max="365" value="${c.cooldownDays}"></label>
      </div>
      <label class="fld check"><input type="checkbox" name="includeAlta" value="1" ${ck(c.includeAlta)}><span>Incluir pacientes que tiveram alta</span></label>
      <label class="fld check"><input type="checkbox" name="email" value="1" ${ck(c.email)}><span>Sem WhatsApp autorizado, enviar por e-mail</span></label>
      <label class="fld"><span>Mensagem</span><textarea name="text" id="react-text" rows="6" maxlength="900">${c.text}</textarea>
        <small class="muted">Variáveis: {nome}, {clinica}, {link} (agendar com o mesmo profissional), {sair} (não receber mais; sempre incluído). Evite mencionar saúde, diagnóstico ou motivos: a mensagem pode ser lida por outras pessoas.</small></label>
      ${aiBox('reativacao', '#react-text')}
      <fieldset class="card soft stack"><legend><b>Envio automático</b></legend>
        <label class="fld check"><input type="checkbox" name="auto" value="1" ${ck(c.auto)}><span>Enviar sozinho, uma vez por dia</span></label>
        <div class="form-grid">
          <label class="fld"><span>A partir das</span><select name="hour">${[8, 9, 10, 11, 14, 15, 16, 17, 18].map((h) => html`<option value="${h}" ${c.hour === h ? raw('selected') : ''}>${h}h</option>`)}</select></label>
          <label class="fld"><span>Máximo de convites por dia</span><input type="number" name="maxPerDay" min="1" max="50" value="${c.maxPerDay}"></label>
        </div>
      </fieldset>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>` }));
});
r.post('/configurar', async (req, res) => {
  if (!can(req.user, 'usuarios')) return res.status(403).send('Sem permissão');
  const c = await RA.saveConfig(req.body);
  await audit(req, 'marketing-reativacao-config', c.auto ? 'automático' : 'manual');
  res.flash('Reativação salva.').redirect('/marketing/configurar');
});
// ---------- Aniversários ----------
r.get('/aniversarios', async (req, res) => {
  const c = await E.config(); const scope = patientScope(req.user);
  const up = (await E.upcoming(30)).filter((p) => canSeePatient(req.user, p));
  const year = Number(todayLocal().slice(0, 4));
  const waOn = WA.ready(await WA.config()); const mailOn = Notify.emailReady(await Notify.config());
  const admin = can(req.user, 'usuarios');
  const missing = Number((await one(`SELECT COUNT(*) n FROM patients p WHERE p.status = 'ativo' AND p.birth_date IS NULL AND p.demo = 0 ${scope.sql}`, scope.params)).n);
  const ck = (v) => (v ? raw('checked') : '');
  send(res, page(req, { title: 'Marketing · Aniversários', active: 'marketing', body: html`<header class="ph"><div><p class="eyebrow">Marketing</p><h1>Mensagem de aniversário</h1>
      <p class="muted">No dia do aniversário, o paciente recebe uma mensagem carinhosa da equipe pelo WhatsApp${mailOn ? ' (ou por e-mail, se não tiver WhatsApp)' : ''}. Uma vez por ano, só para quem autorizou.</p></div></header>
    ${tabs('aniversarios', req)}
    ${!waOn ? html`<div class="flash warn">O WhatsApp não está conectado: ${mailOn ? 'as mensagens irão só por e-mail.' : 'nenhuma mensagem será enviada até conectar o WhatsApp ou o e-mail.'}</div>` : ''}
    <section class="kpis"><div class="kpi"><span>Envio automático</span><b>${c.bdayOn ? 'Ligado' : 'Desligado'}</b><small>${c.bdayOn ? `a partir das ${c.bdayHour}h` : admin ? 'ligue abaixo' : 'a administração liga'}</small></div>
      <div class="kpi"><span>Próximos 30 dias</span><b>${up.length}</b><small>${up.filter((p) => p.inDays === 0).length} hoje</small></div>
      <div class="kpi"><span>Sem data de nascimento</span><b>${missing}</b><small>pacientes ativos</small></div></section>
    <section class="card"><h2>Próximos 30 dias</h2>
      ${up.length ? html`<div class="bi-tblwrap"><table class="tbl small"><thead><tr><th>Paciente</th><th>Data</th><th class="num">Idade</th><th>Situação</th><th></th></tr></thead><tbody>
        ${up.map((p) => html`<tr data-id="${p.id}"><td><a href="/pacientes/${p.id}">${p.social_name || p.name}</a>${p.status !== 'ativo' ? html` <small class="muted">(${p.status})</small>` : ''}</td>
          <td>${p.inDays === 0 ? html`<b>Hoje 🎉</b>` : p.inDays === 1 ? 'Amanhã' : brDate(p.next).slice(0, 5)}</td><td class="num">${p.age}</td>
          <td>${!p.birthday_optin ? html`<span class="muted">não recebe</span>` : Number(p.birthday_sent_year) === year && p.inDays === 0 ? '✓ enviada' : p.inDays === 0 ? 'a enviar' : ''}</td>
          <td class="num">${p.inDays === 0 && p.birthday_optin && Number(p.birthday_sent_year) !== year ? html`<form method="post" action="/marketing/aniversarios/${p.id}/enviar" class="inline"><button class="btn ghost btn-sm">Enviar agora</button></form>` : ''}</td></tr>`)}
      </tbody></table></div>` : html`<p class="muted small">Nenhum aniversário nos próximos 30 dias (ou faltam datas de nascimento nas fichas).</p>`}
    </section>
    ${admin ? html`<form method="post" action="/marketing/aniversarios" class="card stack" id="aniv-config"><h2>Configurar</h2>
      <label class="fld check"><input type="checkbox" name="bdayOn" value="1" ${ck(c.bdayOn)}><span><b>Enviar mensagem de aniversário automaticamente</b></span></label>
      <div class="form-grid"><label class="fld"><span>A partir de</span><select name="bdayHour">${[7, 8, 9, 10, 11, 12, 14, 16, 18].map((h) => html`<option value="${h}" ${sel(c.bdayHour, h)}>${h}h</option>`)}</select></label></div>
      <label class="fld check"><input type="checkbox" name="bdayAlta" value="1" ${ck(c.bdayAlta)}><span>Enviar também para pacientes que já tiveram alta</span></label>
      <label class="fld check"><input type="checkbox" name="bdayEmail" value="1" ${ck(c.bdayEmail)}><span>Sem WhatsApp autorizado, enviar por e-mail ${mailOn ? '' : html`<small class="muted">(configure em Lembretes por e-mail e SMS)</small>`}</span></label>
      <label class="fld"><span>Mensagem</span><textarea name="bdayText" id="bday-text" rows="4" maxlength="1000">${c.bdayText}</textarea>
        <small class="muted">Variáveis: {nome} (primeiro nome ou nome social) e {clinica}. Evite conteúdo clínico: a mensagem pode ser vista por outras pessoas no celular do paciente.</small></label>
      ${aiBox('aniversario', '#bday-text')}
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>` : ''}` }));
});
r.post('/aniversarios', async (req, res) => {
  if (!can(req.user, 'usuarios')) return res.status(403).send('Sem permissão');
  await E.saveConfig('aniversario', req.body);
  await audit(req, 'aniversario-config');
  res.flash(req.body.bdayOn ? 'Mensagem de aniversário ligada.' : 'Configuração salva (envio automático desligado).').redirect('/marketing/aniversarios');
});
r.post('/aniversarios/:id/enviar', async (req, res) => {
  const p = await one('SELECT id, owner_id, name, social_name, phone, email, email_optin, whatsapp_optin, birthday_optin, birthday_sent_year FROM patients WHERE id = ?', [int(req.params.id)]);
  if (!canSeePatient(req.user, p)) return res.status(403).send('Sem permissão');
  const out = await E.sendBirthday(p);
  await audit(req, 'aniversario-enviar', `patient:${p.id}`);
  res.flash(out.ok ? `Mensagem de aniversário enviada${out.via === 'email' ? ' por e-mail' : ''}.` : `Não enviada: ${out.error}`, out.ok ? 'ok' : 'err').redirect('/marketing/aniversarios');
});

// ---------- IA: gerar mensagens ----------
r.post('/ia', express.json({ limit: '8kb' }), async (req, res) => {
  if (!can(req.user, 'usuarios')) return res.status(403).json({ ok: false, error: 'Sem permissão.' });
  const out = await MAI.generate({ kind: String(req.body.kind || ''), tone: String(req.body.tone || ''), current: String(req.body.current || ''), userId: req.user.id });
  await audit(req, 'marketing-ia', String(req.body.kind || ''));
  res.json(out);
});
export default r;

// Público: não receber mais convites de retorno
export async function publicOptOut(req, res) {
  const id = RA.idOfToken(req.params.tok);
  const p = id ? await one('SELECT id, name, social_name FROM patients WHERE id = ?', [id]) : null;
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  if (!p) return res.status(404).send(String(bare('Link inválido', html`<main class="legal"><h1>Link inválido</h1><p>Confira o link recebido.</p></main>`, 'bare legal-page', req)));
  if (req.method === 'POST') { await RA.optOut(p.id); return res.send(String(bare('Pronto', html`<main class="legal"><h1>Pronto, ${nm(p).split(' ')[0]}</h1><p>Você não vai mais receber convites para retomar o acompanhamento. Lembretes das suas sessões continuam normalmente.</p></main>`, 'bare legal-page', req))); }
  res.send(String(bare('Não receber mais convites', html`<main class="legal"><h1>Não receber mais convites</h1><p>Olá, ${nm(p).split(' ')[0]}. Confirme para não receber mais mensagens convidando a retomar o acompanhamento.</p>
    <form method="post"><button class="btn">Confirmar</button></form></main>`, 'bare legal-page', req)));
}
