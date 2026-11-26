import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import express from 'express';
import { q, one, audit } from '../lib/db.js';
import { cpfValid, cpfFmt, docFmt, docValid, phoneFmt } from '../lib/br.js';
import { patientTab as insuranceTab } from './insurance.js';
import { mode as InsMode } from '../lib/insurance.js';
import { attendanceBanner } from './recepcao.js';
import { patientTab as scalesTab } from './scales.js';
import { page, bare, html, raw, money, badge, brDate, brDateTime, label, waLink, logoTag } from '../lib/html.js';
import { router, send, int, str, dec } from '../lib/router.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { todayLocal, nowLocal, isYmd, longDate } from '../lib/time.js';
import * as ExLib from '../lib/exlib.js';
import { byKey, formOf } from '../lib/exlib.js';
import { FEATURES } from '../lib/html.js';
import * as Mood from '../lib/mood.js';
import { renderResponse } from '../lib/forms.js';
import { syncLater, futureIds } from '../lib/google.js';
import { patientMessages } from './whatsapp.js';
import * as WA from '../lib/whatsapp.js';
import * as Consent from '../lib/consent.js';
import * as PsyDocs from '../lib/psydocs.js';
import * as Privacy from '../lib/privacy.js';
import * as SessionAI from '../lib/sessionai.js';
import * as Rec from '../lib/records.js';
import * as CID from '../lib/cid.js';
import * as Ins from '../lib/insurance.js';
import { sessionPage, timeline, recordForm } from './session.js';
import { staffCard as portalCard } from './portal.js';
import { can, ownOnly, patientScope, canSeePatient, requirePerm, forbidden, isClinician } from '../lib/perm.js';

const r = router();

// Todo /:id passa por aqui: psicólogo(a) colaborador(a) só abre os próprios pacientes.
r.param('id', async (req, res, next, id) => {
  try {
    const p = await one('SELECT id, owner_id FROM patients WHERE id = ?', [int(id)]);
    if (p && !canSeePatient(req.user, p)) return next(forbidden());
    next();
  } catch (e) { next(e); }
});
// Dados clínicos exigem perfil clínico.
r.all(['/:id/registros', '/:id/registros/:rid', '/:id/prontuario', '/:id/sessao', '/:id/rascunho'], requirePerm('prontuario'));
// O prontuário é de quem atende: só perfis clínicos escrevem e leem (cada um, só os próprios registros).
r.all(['/:id/registros', '/:id/registros/:rid', '/:id/prontuario', '/:id/sessao', '/:id/rascunho'], (req, res, next) => (isClinician(req.user.role) ? next() : next(forbidden())));

// Profissionais que atendem (+ o responsável atual, para não trocar sem querer ao editar)
async function clinicians(keepId = 0) {
  return q("SELECT id, name, role FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND (attends = 1 OR id = ?) ORDER BY name", [keepId || 0]);
}
const nm = (p) => p.social_name || p.name;

function age(birth) {
  if (!birth) return '';
  const t = todayLocal();
  let a = Number(t.slice(0, 4)) - Number(birth.slice(0, 4));
  if (t.slice(5) < birth.slice(5, 10)) a--;
  return `${a} anos`;
}

// ---------- lista ----------
r.get('/', async (req, res) => {
  const busca = str(req.query.q, 80);
  const status = ['ativo', 'pausa', 'alta', 'inativo', 'todos'].includes(req.query.status) ? req.query.status : 'ativo';
  const sc = patientScope(req.user);
  const where = ['1=1' + sc.sql], params = [...sc.params];
  if (status !== 'todos') { where.push('p.status = ?'); params.push(status); }
  if (busca) { where.push('(p.name LIKE ? OR p.social_name LIKE ? OR p.phone LIKE ?)'); params.push(`%${busca}%`, `%${busca}%`, `%${busca}%`); }
  const rows = await q(`SELECT p.*,
      (SELECT MIN(starts_at) FROM appointments a WHERE a.patient_id = p.id AND a.starts_at >= ? AND a.status IN ('agendada','confirmada')) proxima,
      (SELECT MAX(starts_at) FROM appointments a WHERE a.patient_id = p.id AND a.status = 'realizada') ultima,
      u.name responsavel
    FROM patients p LEFT JOIN users u ON u.id = p.owner_id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY p.name LIMIT 500`, [nowLocal(), ...params]);

  send(res, page(req, {
    title: 'Pacientes', active: 'pacientes',
    body: html`
    <header class="ph"><div><p class="eyebrow">Cadastro</p><h1>Pacientes</h1></div><div class="ph-actions"><a class="btn" href="/pacientes/novo">+ Novo paciente</a></div></header>
    <form class="filters" method="get">
      <input type="search" name="q" value="${busca}" placeholder="Buscar por nome ou telefone">
      <select name="status">${['ativo', 'pausa', 'alta', 'inativo', 'todos'].map((s) => html`<option value="${s}" ${s === status ? raw('selected') : ''}>${s === 'todos' ? 'Todos' : label(s)}</option>`)}</select>
      <button class="btn ghost">Filtrar</button>
    </form>
    <section class="card flush">
      ${rows.length ? html`<div class="tbl-wrap"><table class="tbl hover">
        <thead><tr><th>Nome</th><th>Contato</th>${ownOnly(req.user) ? '' : html`<th>Responsável</th>`}<th>Modalidade</th><th>Última sessão</th><th>Próxima</th><th>Situação</th></tr></thead>
        <tbody>${rows.map((p) => html`<tr data-href="/pacientes/${p.id}">
          <td><a href="/pacientes/${p.id}"><b>${nm(p)}</b></a>${p.social_name ? html`<small class="muted"> (${p.name})</small>` : ''}</td>
          <td>${p.phone || '—'}</td>${ownOnly(req.user) ? '' : html`<td>${p.responsavel || '—'}</td>`}<td>${label(p.modality)}</td>
          <td>${p.ultima ? brDate(p.ultima) : '—'}</td><td>${p.proxima ? brDateTime(p.proxima) : '—'}</td><td>${badge(p.status)}</td></tr>`)}</tbody>
      </table></div>` : html`<p class="muted pad">Nenhum paciente encontrado.</p>`}
    </section>`,
  }));
});

// ---------- formulário ----------
function form(req, p = {}, action, docs = [], ins = { list: [], plan: null }) {
  const sel = (name, opts, v) => html`<select name="${name}">${opts.map((o) => html`<option value="${o}" ${o === v ? raw('selected') : ''}>${label(o)}</option>`)}</select>`;
  return html`
  <form method="post" action="${action}" class="card form-grid">
    <h2 class="span2">Identificação</h2>
    <label class="fld"><span>Nome completo *</span><input name="name" required maxlength="160" value="${p.name || ''}"></label>
    <label class="fld"><span>Nome social</span><input name="social_name" maxlength="160" value="${p.social_name || ''}"></label>
    <label class="fld"><span>Data de nascimento</span><input type="date" name="birth_date" value="${p.birth_date ? p.birth_date.slice(0, 10) : ''}"></label>
    <label class="fld"><span>CPF (para recibos)</span><input name="cpf" maxlength="14" value="${p.cpf ? cpfFmt(p.cpf) : ''}" inputmode="numeric" placeholder="000.000.000-00" data-mask="cpf" autocomplete="off"></label>
    <h2 class="span2">Contato</h2>
    <label class="fld"><span>WhatsApp / telefone</span><input name="phone" maxlength="40" value="${p.phone ? phoneFmt(p.phone) : ''}" inputmode="tel" placeholder="(62) 9 0000-0000"></label>
    <label class="fld"><span>E-mail</span><input type="email" name="email" maxlength="190" value="${p.email || ''}"></label>
    <label class="fld span2"><span>Endereço</span><input name="address" maxlength="300" value="${p.address || ''}"></label>
    <label class="fld span2"><span>Contato de emergência (nome, vínculo e telefone)</span><input name="emergency" maxlength="300" value="${p.emergency || ''}"></label>
    <h2 class="span2">Atendimento</h2>
    <label class="fld"><span>Modalidade</span>${sel('modality', ['online', 'presencial', 'hibrido'], p.modality || 'online')}</label>
    ${ownOnly(req.user) ? '' : html`<label class="fld"><span>Psicólogo(a) responsável</span><select name="owner_id">${docs.map((d) => html`<option value="${d.id}" ${d.id === (p.owner_id || req.user.id) ? raw('selected') : ''}>${d.name}</option>`)}</select></label>`}
    <label class="fld"><span>Situação</span>${sel('status', ['ativo', 'pausa', 'alta', 'inativo'], p.status || 'ativo')}</label>
    <fieldset class="fld span2 pay-kind" data-pay-kind><legend>Tipo de atendimento</legend>
      <div class="seg-radio"><label><input type="radio" name="pay_kind" value="particular" ${p.pay_kind !== 'convenio' ? raw('checked') : ''}><span>Particular</span></label><label><input type="radio" name="pay_kind" value="convenio" ${p.pay_kind === 'convenio' ? raw('checked') : ''}><span>Convênio</span></label></div>
    </fieldset>
    <div class="span2 form-grid conv-box" data-show-when="pay_kind=convenio" ${p.pay_kind === 'convenio' ? '' : raw('hidden')}>
      ${ins.list.length ? html`<label class="fld"><span>Convênio *</span><select name="insurer_id"><option value="">Selecione…</option>${ins.list.map((i) => html`<option value="${i.id}" ${Number(p.insurer_id) === i.id ? raw('selected') : ''}>${i.name}</option>`)}</select></label>
      <label class="fld"><span>Número da carteirinha *</span><input name="card" maxlength="40" value="${p.card || ''}" autocomplete="off"></label>
      <label class="fld"><span>Plano</span><input name="plan_name" maxlength="80" value="${p.plan_name || ''}" placeholder="Ex.: Nacional, Enfermaria"></label>
      <label class="fld"><span>Validade da carteirinha</span><input type="date" name="valid_until" value="${p.valid_until ? String(p.valid_until).slice(0, 10) : ''}"></label>
      <p class="span2 muted small">Autorizações e guias ficam na aba Convênio da ficha.</p>`
      : html`<p class="span2 flash info">Nenhum convênio credenciado ainda. ${can(req.user, 'usuarios') ? html`<a class="link" href="/configuracoes/convenios">Ligar os convênios em Configurações → Convênios</a>.` : 'Peça à administração para ligar em Configurações → Convênios.'}</p>`}
    </div>
    <label class="fld"><span>Valor da sessão (R$)</span><input name="session_fee" inputmode="decimal" value="${p.session_fee ? String(p.session_fee).replace('.', ',') : ''}" placeholder="0,00"></label>
    <label class="fld"><span>Responsável financeiro (se outra pessoa paga)</span><input name="payer_name" maxlength="160" value="${p.payer_name || ''}" placeholder="Nome de quem paga"></label>
    <label class="fld"><span>CPF do responsável financeiro</span><input name="payer_cpf" maxlength="18" value="${p.payer_cpf ? docFmt(p.payer_cpf) : ''}" placeholder="Para o recibo / Receita Saúde" autocomplete="off" inputmode="numeric" data-mask="doc"></label>
    <label class="fld"><span>Onde o paciente paga</span><select name="pay_to"><option value="clinica" ${p.pay_to !== 'profissional' ? raw('selected') : ''}>Na clínica</option><option value="profissional" ${p.pay_to === 'profissional' ? raw('selected') : ''}>Direto ao profissional</option></select></label>
    <label class="fld check"><input type="checkbox" name="consent" value="1" ${p.consent_at ? raw('checked') : ''}><span>Termo de consentimento e de tratamento de dados (LGPD) assinado${p.consent_at ? ` em ${brDate(p.consent_at)}` : ''}</span></label>
    <label class="fld check"><input type="checkbox" name="whatsapp_optin" value="1" ${p.whatsapp_optin === undefined || p.whatsapp_optin ? raw('checked') : ''}><span>Autoriza receber lembretes e mensagens pelo WhatsApp</span></label>
    <label class="fld check"><input type="checkbox" name="email_optin" value="1" ${p.email_optin === undefined || p.email_optin ? raw('checked') : ''}><span>Receber lembretes de sessão por e-mail</span></label>
    <label class="fld check"><input type="checkbox" name="sms_optin" value="1" ${p.sms_optin === undefined || p.sms_optin ? raw('checked') : ''}><span>Receber lembretes de sessão por SMS</span></label>
    <label class="fld check"><input type="checkbox" name="birthday_optin" value="1" ${p.birthday_optin === undefined || p.birthday_optin ? raw('checked') : ''}><span>Receber mensagem de aniversário</span></label>
    <label class="fld check"><input type="checkbox" name="react_optin" value="1" ${p.react_optin === undefined || p.react_optin ? raw('checked') : ''}><span>Receber convite para retomar o acompanhamento (se ficar um tempo sem sessões)</span></label>
    <label class="fld check"><input type="checkbox" name="survey_optin" value="1" ${p.survey_optin === undefined || p.survey_optin ? raw('checked') : ''}><span>Receber pesquisa de satisfação</span></label>
    <label class="fld span2"><span>Observações administrativas (criptografadas)</span><textarea name="notes" rows="3">${p.notes || ''}</textarea></label>
    <div class="span2 actions"><button class="btn" type="submit">Salvar</button><a class="btn ghost" href="${p.id ? `/pacientes/${p.id}` : '/pacientes'}">Cancelar</a></div>
  </form>`;
}

// Particular ou convênio: dados do formulário a partir da carteirinha padrão do paciente
async function insForm(p) {
  const list = await Ins.list(true);
  const out = { list, fields: { pay_kind: 'particular' } };
  if (p?.default_plan_id) {
    const pl = await Ins.plan(p.default_plan_id);
    if (pl && pl.active) out.fields = { pay_kind: 'convenio', insurer_id: pl.insurer_id, card: pl.card, plan_name: pl.plan_name, valid_until: pl.valid_until, plan_id: pl.id };
  }
  return out;
}
// Salva a escolha: convênio cria/atualiza a carteirinha padrão; particular tira o convênio das próximas sessões
async function saveInsChoice(pid, b) {
  if (b.pay_kind !== 'convenio') { await Ins.setDefault(pid, null); return { ok: true }; }
  const cur = await one('SELECT default_plan_id FROM patients WHERE id = ?', [pid]);
  const pl = cur?.default_plan_id ? await Ins.plan(cur.default_plan_id) : null;
  const same = pl && pl.active && Number(pl.insurer_id) === Number(b.insurer_id);
  return Ins.savePlan(pid, same ? pl.id : null, { insurer_id: b.insurer_id, card: b.card, plan_name: b.plan_name, holder_name: same ? pl.holder_name : '', valid_until: b.valid_until, active: 1, default: 1 });
}

// CPF do paciente e CPF/CNPJ de quem paga: se preenchidos, precisam ser válidos
function docErrors(b) {
  const e = [];
  if (b.pay_kind === 'convenio' && (!int(b.insurer_id) || !str(b.card, 40))) e.push('Convênio: selecione o convênio e informe o número da carteirinha.');
  if (str(b.cpf, 20) && !cpfValid(b.cpf)) e.push('CPF do paciente inválido: confira os números.');
  if (str(b.payer_cpf, 20) && !docValid(b.payer_cpf)) e.push('CPF (ou CNPJ) do responsável financeiro inválido: confira os números.');
  return e;
}
const formAgain = async (req, res, p, action, msgs, title) => send(res, page(req, { title, active: 'pacientes', flash: { type: 'err', text: msgs.join(' ') },
  body: html`<header class="ph"><div><p class="eyebrow">Pacientes</p><h1>${title}</h1></div></header>${form(req, p, action, await clinicians(p.owner_id), { list: await Ins.list(true) })}` }));

function readBody(b, prevConsent, owner) {
  return {
    owner_id: owner,
    name: str(b.name, 160), social_name: str(b.social_name, 160) || null,
    birth_date: isYmd(b.birth_date) ? b.birth_date : null,
    phone: phoneFmt(str(b.phone, 40)) || null, email: str(b.email, 190) || null,
    cpf_enc: encrypt(cpfFmt(str(b.cpf, 20))), address_enc: encrypt(str(b.address, 300)), emergency_enc: encrypt(str(b.emergency, 300)),
    modality: ['online', 'presencial', 'hibrido'].includes(b.modality) ? b.modality : 'online',
    status: ['ativo', 'pausa', 'alta', 'inativo'].includes(b.status) ? b.status : 'ativo',
    session_fee: dec(b.session_fee),
    pay_to: b.pay_to === 'profissional' ? 'profissional' : 'clinica',
    payer_name: str(b.payer_name, 160) || null,
    payer_cpf_enc: str(b.payer_name, 160) && str(b.payer_cpf, 20) ? encrypt(docFmt(str(b.payer_cpf, 20))) : null,
    consent_at: b.consent ? prevConsent || nowLocal() : null,
    whatsapp_optin: b.whatsapp_optin ? 1 : 0,
    email_optin: b.email_optin ? 1 : 0, sms_optin: b.sms_optin ? 1 : 0, birthday_optin: b.birthday_optin ? 1 : 0, react_optin: b.react_optin ? 1 : 0, survey_optin: b.survey_optin ? 1 : 0,
    notes_enc: encrypt(str(b.notes, 5000)),
  };
}

r.get('/novo', async (req, res) => send(res, page(req, {
  title: 'Novo paciente', active: 'pacientes',
  body: html`<header class="ph"><div><p class="eyebrow">Pacientes</p><h1>Novo paciente</h1></div></header>${form(req, { pay_kind: 'particular' }, '/pacientes/novo', await clinicians(), { list: await Ins.list(true) })}`,
})));

// Cadastro rápido direto da agenda (nome, WhatsApp e e-mail): devolve o paciente para já agendar; o resto da ficha fica para depois
r.post('/rapido', async (req, res) => {
  const b = req.body;
  const d = readBody({ name: b.name, phone: b.phone, email: b.email, modality: b.modality, whatsapp_optin: b.whatsapp_optin, email_optin: b.email_optin }, null, await ownerFrom(req));
  if (!d.name || d.name.length < 3) return res.status(400).json({ ok: false, error: 'Informe o nome do paciente.' });
  if (d.email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) return res.status(400).json({ ok: false, error: 'E-mail inválido.' });
  const cols = Object.keys(d);
  const out = await q(`INSERT INTO patients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(d));
  await audit(req, 'paciente-criar', `patient:${out.insertId} (agenda)`);
  res.json({ ok: true, id: out.insertId, name: d.name, owner: d.owner_id || '', phone: d.phone || '', optin: d.whatsapp_optin, modality: d.modality });
});
r.post('/novo', async (req, res) => {
  const d = readBody(req.body, null, await ownerFrom(req));
  if (!d.name) return res.flash('Informe o nome.', 'err').redirect('/pacientes/novo');
  const errs = docErrors(req.body);
  if (errs.length) return formAgain(req, res, { ...req.body, consent_at: d.consent_at, owner_id: d.owner_id, session_fee: d.session_fee, whatsapp_optin: d.whatsapp_optin, email_optin: d.email_optin, sms_optin: d.sms_optin, birthday_optin: d.birthday_optin, react_optin: d.react_optin, survey_optin: d.survey_optin }, '/pacientes/novo', errs, 'Novo paciente');
  const cols = Object.keys(d);
  const out = await q(`INSERT INTO patients (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, Object.values(d));
  await audit(req, 'paciente-criar', `patient:${out.insertId}`);
  const ins = await saveInsChoice(out.insertId, req.body);
  if (!ins.ok) return res.flash(`Paciente cadastrado, mas o convênio não foi salvo: ${ins.error}`, 'warn').redirect(`/pacientes/${out.insertId}/editar`);
  res.flash(`Paciente cadastrado${req.body.pay_kind === 'convenio' ? ' (convênio)' : ''}.`).redirect(`/pacientes/${out.insertId}`);
});

// Responsável: psicólogo(a) colaborador(a) sempre fica com o paciente; os demais escolhem entre perfis clínicos.
async function ownerFrom(req, current) {
  if (ownOnly(req.user)) return req.user.id;
  const docs = await clinicians(current);
  const want = int(req.body.owner_id);
  if (docs.some((d) => d.id === want)) return want;
  return current || docs.find((d) => d.role === 'admin')?.id || docs[0]?.id || null;
}

async function loadPatient(id) {
  const p = await one('SELECT * FROM patients WHERE id = ?', [id]);
  if (!p) return null;
  p.cpf = decrypt(p.cpf_enc); p.address = decrypt(p.address_enc); p.emergency = decrypt(p.emergency_enc); p.notes = decrypt(p.notes_enc); p.payer_cpf = p.payer_cpf_enc ? decrypt(p.payer_cpf_enc) : '';
  return p;
}

r.get('/:id/editar', async (req, res, next) => {
  const p = await loadPatient(int(req.params.id));
  if (!p) return next();
  const ins = await insForm(p);
  send(res, page(req, { title: 'Editar paciente', active: 'pacientes', body: html`<header class="ph"><div><p class="eyebrow">Pacientes</p><h1>Editar · ${nm(p)}</h1></div></header>${form(req, { ...p, ...ins.fields }, `/pacientes/${p.id}/editar`, await clinicians(p.owner_id), ins)}` }));
});

r.post('/:id/editar', async (req, res, next) => {
  const p = await one('SELECT id, consent_at, owner_id FROM patients WHERE id = ?', [int(req.params.id)]);
  if (!p) return next();
  const d = readBody(req.body, p.consent_at, await ownerFrom(req, p.owner_id));
  if (!d.name) return res.flash('Informe o nome.', 'err').redirect(`/pacientes/${p.id}/editar`);
  const errs = docErrors(req.body);
  if (errs.length) return formAgain(req, res, { ...req.body, id: p.id, consent_at: d.consent_at, owner_id: d.owner_id, session_fee: d.session_fee, whatsapp_optin: d.whatsapp_optin, email_optin: d.email_optin, sms_optin: d.sms_optin, birthday_optin: d.birthday_optin, react_optin: d.react_optin, survey_optin: d.survey_optin }, `/pacientes/${p.id}/editar`, errs, 'Editar paciente');
  await q(`UPDATE patients SET ${Object.keys(d).map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(d), p.id]);
  await audit(req, 'paciente-editar', `patient:${p.id}`);
  syncLater(await futureIds('a.patient_id = ?', [p.id])); // nome ou responsável podem ter mudado
  const ins = await saveInsChoice(p.id, req.body);
  if (!ins.ok) return res.flash(`Dados atualizados, mas o convênio não foi salvo: ${ins.error}`, 'warn').redirect(`/pacientes/${p.id}/editar`);
  res.flash('Dados atualizados.').redirect(`/pacientes/${p.id}`);
});

// ---------- ficha do paciente ----------
r.get('/:id', async (req, res, next) => {
  const p = await loadPatient(int(req.params.id));
  if (!p) return next();
  const clin = can(req.user, 'prontuario'), fin = can(req.user, 'financeiro') || can(req.user, 'meufin');
  const [appts, records, assigns, pays, owner] = await Promise.all([
    q('SELECT * FROM appointments WHERE patient_id = ? ORDER BY starts_at DESC LIMIT 60', [p.id]),
    [],
    clin ? q('SELECT * FROM assignments WHERE patient_id = ? ORDER BY created_at DESC', [p.id]) : [],
    fin ? q('SELECT * FROM payments WHERE patient_id = ? ORDER BY due_date DESC LIMIT 60', [p.id]) : [],
    one('SELECT name FROM users WHERE id = ?', [p.owner_id]),
  ]);
  await audit(req, clin ? 'prontuario-ver' : 'paciente-ver', `patient:${p.id}`);
  const now = nowLocal();
  const upcoming = appts.filter((a) => a.starts_at >= now && ['agendada', 'confirmada'].includes(a.status)).reverse();
  const done = appts.filter((a) => a.status === 'realizada').length;
  const open = pays.filter((x) => !x.paid_at && x.origin !== 'convenio').reduce((s, x) => s + Number(x.amount), 0);
  const wa = waLink(p.phone, `Olá, ${nm(p).split(' ')[0]}! `);
  const waOn = WA.ready(await WA.config());
  const onWait = can(req.user, 'agenda') ? await one("SELECT id FROM waitlist WHERE patient_id = ? AND status = 'aguardando'", [p.id]) : null;
  const ins = await insForm(p);
  const TABS = [['prontuario', 'Prontuário', clin && isClinician(req.user.role)], ['sessoes', 'Sessões', true], ['exercicios', 'Exercícios', clin && FEATURES.exercicios], ['escalas', 'Escalas', clin], ['humor', 'Humor', clin], ['financeiro', 'Financeiro', fin], ['convenio', 'Convênio', !!(await InsMode())], ['mensagens', 'WhatsApp', true], ['termos', 'Termos', true], ['documentos', 'Documentos', clin], ['dados', 'Dados', true]].filter((t) => t[2]);
  const tab = TABS.some((t) => t[0] === req.query.aba) ? req.query.aba : TABS[0][0];
  if (tab === 'exercicios') await ExLib.warm();
  const myModels = tab === 'exercicios' ? ExLib.sendable() : [];
  const interactive = ExLib.cadernos().filter((e) => e.form);
  const printable = ExLib.cadernos().filter((e) => !e.form);

  send(res, page(req, {
    title: nm(p), active: 'pacientes',
    body: html`
    <header class="ph"><div><p class="eyebrow">${label(p.status)} · ${label(p.modality)} · ${ins.fields.pay_kind === 'convenio' ? `Convênio ${ins.list.find((i) => i.id === ins.fields.insurer_id)?.name || ''}` : 'Particular'}${p.birth_date ? ` · ${age(p.birth_date)}` : ''}${owner ? ` · resp. ${owner.name}` : ''}</p><h1>${nm(p)}</h1>
      ${p.social_name ? html`<p class="muted">Nome civil: ${p.name}</p>` : ''}</div>
      <div class="ph-actions">
        ${clin && isClinician(req.user.role) ? html`<a class="btn" href="/pacientes/${p.id}/sessao">Sessão / registro</a>` : ''}
        <a class="btn ${clin && isClinician(req.user.role) ? 'ghost' : ''}" href="/agenda/nova?paciente=${p.id}">+ Agendar</a>
        ${can(req.user, 'agenda') ? (onWait ? html`<a class="btn ghost" href="/agenda/lista-espera?editar=${onWait.id}#nova" title="Ver as preferências na lista de espera">⏳ Na lista de espera</a>` : html`<a class="btn ghost" href="/agenda/lista-espera?paciente=${p.id}#nova">Lista de espera</a>`) : ''}
        ${wa ? html`<a class="btn ghost" href="${wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
        <a class="btn ghost" href="/pacientes/${p.id}/editar">Editar</a>
      </div></header>

    <section class="kpis small">
      <div class="kpi"><span>Sessões realizadas</span><b>${done}</b></div>
      <div class="kpi"><span>Próxima sessão</span><b>${upcoming[0] ? brDateTime(upcoming[0].starts_at) : '—'}</b></div>
      ${clin ? html`<div class="kpi"><span>Exercícios</span><b>${assigns.length}</b><small>${assigns.filter((a) => a.status === 'respondido').length} para revisar</small></div>` : ''}
      ${fin ? html`<div class="kpi"><span>Em aberto</span><b>${money(open)}</b></div>` : ''}
    </section>
    ${!p.consent_at ? html`<div class="flash warn">Termo de consentimento/LGPD ainda não registrado para este paciente.</div>` : ''}

    ${await attendanceBanner(req, p)}
    <nav class="tabs">${TABS.map(([k, l]) => html`<a href="?aba=${k}" class="${tab === k ? 'on' : ''}">${l}</a>`)}</nav>

    ${tab === 'documentos' ? await (async () => {
      const docs = await PsyDocs.forPatient(p.id);
      const ST = { rascunho: ['agendada', 'Rascunho'], emitido: ['realizada', 'Emitido'], cancelado: ['cancelada', 'Cancelado'] };
      return html`<section class="card"><h2>Novo documento</h2>
        <p class="muted small sub-h">Documentos psicológicos conforme a Resolução CFP nº 06/2019. O texto vem preenchido com os dados da ficha; você revisa, emite e assina eletronicamente.</p>
        <div class="psy-new">${Object.entries(PsyDocs.KINDS).map(([k, v]) => html`<a class="psy-new-card" href="/documentos/novo/${p.id}?tipo=${k}"><b>${v.label}</b><small>${v.desc}</small></a>`)}</div>
      </section>
      <section class="card"><h2>Documentos do paciente <small class="muted">(${docs.length})</small></h2>
        ${docs.length ? html`<ul class="list">${docs.map((d) => html`<li><a href="/documentos/${d.id}"><span class="psy-li"><b>${d.title}</b><small>${PsyDocs.KINDS[d.kind]?.label || ''} · ${d.signed_at ? `emitido em ${brDateTime(d.signed_at)}` : `criado em ${brDateTime(d.created_at)}`}${d.verify_code ? ` · código ${d.verify_code}` : ''}${d.purpose ? ` · ${d.purpose}` : ''}</small></span><span class="badge b-${ST[d.status][0]}">${ST[d.status][1]}</span></a></li>`)}</ul>` : html`<p class="muted">Nenhum documento ainda.</p>`}
      </section>`;
    })() : ''}
    ${tab === 'termos' ? await (async () => {
      const links = await Consent.forPatient(p.id); const tpl = await Consent.templates();
      const base = (Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
      const newLink = int(req.query.link) && /^[A-Za-z0-9_-]{20,}$/.test(String(req.query.t || '')) ? `${base}/t/${req.query.t}` : null;
      const ST = { pendente: ['agendada', 'Aguardando aceite'], aceito: ['realizada', 'Aceito'], recusado: ['falta', 'Recusado'], cancelado: ['cancelada', 'Cancelado'] };
      return html`<section class="card">
        <h2>Enviar para leitura e aceite</h2>
        <p class="muted small sub-h">O paciente (ou o responsável legal) lê e aceita pelo link. Ficam registrados o texto exato, data, hora e IP.</p>
        ${newLink ? html`<div class="flash ok consent-new">Link criado: <input readonly value="${newLink}" id="consent-link" aria-label="Link"> <button type="button" class="chip" data-copy="#consent-link">Copiar</button></div>` : ''}
        <form method="post" action="/termos/enviar/${p.id}" class="stack">
          ${Object.entries(tpl).filter(([, d]) => d.active).map(([k, d]) => html`<label class="fld check"><input type="checkbox" name="k_${k}" value="1" ${k !== 'gravacao_ia' ? raw('checked') : ''}><span>${d.title}${k === 'gravacao_ia' ? ' (opcional)' : ''}</span></label>`)}
          <div class="actions"><button class="btn" name="via" value="enviar">Enviar por WhatsApp e e-mail</button><button class="btn ghost" name="via" value="link">Só gerar o link</button>
            <small class="muted">${[p.phone && p.whatsapp_optin && waOn ? 'WhatsApp ✓' : 'sem WhatsApp', p.email ? 'e-mail ✓' : 'sem e-mail'].join(' · ')}</small>
            ${can(req.user, 'usuarios') ? html`<a class="link small" href="/configuracoes/termos">Editar textos</a>` : ''}</div>
        </form></section>
      <section class="card"><h2>Histórico de termos</h2>
        ${links.length ? html`<ul class="list">${links.map((l) => { const docs = JSON.parse(l.docs); return html`<li><div class="maint-bk"><span><b>${docs.map((d) => d.title).join(' + ')}</b> <span class="badge b-${ST[l.status][0]}">${ST[l.status][1]}</span>
          <small>Enviado ${brDateTime(l.created_at)}${l.who ? ` por ${l.who}` : ''}${l.opened_at ? ` · aberto ${brDateTime(l.opened_at)}` : ' · ainda não aberto'}${l.decided_at ? ` · ${l.status === 'aceito' ? 'aceito' : 'respondido'} ${brDateTime(l.decided_at)} por ${l.signer_name}${l.signer_role === 'responsavel' ? ' (responsável)' : ''} · IP ${l.ip}` : ''}</small></span>
          <a class="chip" href="/termos/${l.id}/comprovante" target="_blank" rel="noopener">Comprovante</a>
          ${l.status === 'pendente' ? html`<form method="post" action="/termos/${l.id}/cancelar" data-confirm="Cancelar este link? O paciente não poderá mais aceitar por ele."><button class="chip">Cancelar link</button></form>` : ''}</div></li>`; })}</ul>` : html`<p class="muted">Nenhum termo enviado ainda.</p>`}
      </section>`;
    })() : ''}
    ${tab === 'prontuario' ? await timeline(req, p) : ''}

    ${tab === 'sessoes' ? html`
    <section class="card flush">
      ${appts.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Data</th><th>Horário</th><th>Modalidade</th><th>Situação</th></tr></thead>
      <tbody>${appts.map((a) => html`<tr data-href="/agenda/${a.id}"><td><a href="/agenda/${a.id}">${brDate(a.starts_at)}</a></td><td>${a.starts_at.slice(11, 16)} (${a.duration_min} min)</td><td>${label(a.modality)}</td><td>${badge(a.status)}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhuma sessão agendada.</p>`}
    </section>` : ''}

    ${tab === 'escalas' ? await scalesTab(req, p) : ''}
    ${tab === 'humor' ? await moodTab(req, p) : ''}
    ${tab === 'convenio' ? await insuranceTab(req, p) : ''}
    ${tab === 'exercicios' ? html`
    <section class="card">
      <h2>Enviar exercício</h2>
      ${!myModels.length && !interactive.length && !printable.length ? html`<p class="muted">Nenhum exercício aprovado ainda. <a class="link" href="/exercicios">Monte a biblioteca da clínica</a> a partir da Biblioteca Mentez, do zero ou com IA.</p>` : ''}
      <form method="post" action="/exercicios/enviar" class="form-grid">
        <input type="hidden" name="patient_id" value="${p.id}">
        <label class="fld span2"><span>Folha</span><select name="exercise_key" required>
          ${myModels.length ? html`<optgroup label="Exercícios da clínica">${myModels.map((e) => html`<option value="${e.key}">${e.title}</option>`)}</optgroup>` : ''}
          ${interactive.length ? html`<optgroup label="Interativos — o paciente preenche pelo celular">${interactive.map((e) => html`<option value="${e.key}">${e.bookTitle.split('·')[0]}· ${e.title}</option>`)}</optgroup>` : ''}
          ${printable.length ? html`<optgroup label="Somente PDF — o paciente baixa e imprime">${printable.map((e) => html`<option value="${e.key}">${e.bookTitle.split('·')[0]}· ${e.title}</option>`)}</optgroup>` : ''}
        </select></label>
        <label class="fld span2"><span>Orientação para o paciente (opcional)</span><textarea name="instructions" rows="2" maxlength="1000"></textarea></label>
        ${waOn ? html`<label class="fld check span2"><input type="checkbox" name="wa" value="1" ${p.whatsapp_optin && p.phone ? raw('checked') : raw('disabled')}><span>Enviar o link automaticamente pelo WhatsApp${!p.whatsapp_optin ? ' (paciente não autorizou)' : !p.phone ? ' (sem telefone)' : ''}</span></label>` : ''}
        <label class="fld"><span>Link válido por</span><select name="days"><option value="7">7 dias</option><option value="14" selected>14 dias</option><option value="30">30 dias</option></select></label>
        <div class="actions"><button class="btn">Gerar link</button></div>
      </form>
    </section>
    ${assigns.map((s) => {
      const ex = byKey(s.exercise_key);
      const resp = s.response_enc ? JSON.parse(decrypt(s.response_enc)) : null;
      return html`<article class="card"><header class="row-head"><div><b>${ex?.title || s.exercise_key}</b><small class="muted"> · ${ex?.bookTitle || ''} · enviado em ${brDate(s.created_at)}</small></div>${badge(s.status)}<a class="link small" href="/exercicios/envio/${s.id}">abrir</a></header>
      ${resp && formOf(s, ex) ? html`<details><summary>Ver resposta</summary>${renderResponse(formOf(s, ex), resp)}</details>` : ''}</article>`;
    })}` : ''}

    ${tab === 'financeiro' ? html`
    <section class="card">
      <h2>Novo lançamento</h2>
      <p class="small"><a class="link" href="/financeiro/pacotes?paciente=${p.id}">Vender pacote de sessões →</a> · paga ${p.pay_to === 'profissional' ? 'direto ao profissional' : 'na clínica'}</p>
      <form method="post" action="/financeiro/novo" class="form-grid">
        <input type="hidden" name="patient_id" value="${p.id}"><input type="hidden" name="back" value="/pacientes/${p.id}?aba=financeiro">
        <label class="fld span2"><span>Descrição</span><input name="description" value="Sessão de psicoterapia" required></label>
        <label class="fld"><span>Valor (R$)</span><input name="amount" inputmode="decimal" value="${p.session_fee ? String(p.session_fee).replace('.', ',') : ''}" required></label>
        <label class="fld"><span>Vencimento</span><input type="date" name="due_date" value="${todayLocal()}" required></label>
        <div class="span2 actions"><button class="btn">Lançar</button></div>
      </form>
    </section>
    <section class="card flush">${pays.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Vencimento</th><th>Descrição</th><th>Valor</th><th>Situação</th><th></th></tr></thead>
      <tbody>${pays.map((x) => html`<tr><td>${brDate(x.due_date)}</td><td>${x.description}</td><td>${money(x.amount)}</td>
      <td>${x.paid_at ? html`<span class="badge b-realizada">Pago ${brDate(x.paid_at)}</span>` : html`<span class="badge b-${x.due_date < todayLocal() ? 'falta' : 'agendada'}">${x.due_date < todayLocal() ? 'Atrasado' : 'Em aberto'}</span>`}</td>
      <td>${x.paid_at ? html`<a class="link small" href="/financeiro/${x.id}/recibo" target="_blank">recibo</a>` : html`<a class="link small" href="/financeiro/${x.id}">receber</a>`}</td></tr>`)}</tbody></table></div>` : html`<p class="muted pad">Sem lançamentos.</p>`}</section>` : ''}

    ${tab === 'mensagens' ? html`<section class="card">${await patientMessages(p.id, clin)}</section>` : ''}

    ${tab === 'dados' ? html`
    ${await portalCard(req, p)}
    <section class="card"><dl class="dl">
      <dt>Nome civil</dt><dd>${p.name}</dd>
      <dt>Nome social</dt><dd>${p.social_name || '—'}</dd>
      <dt>Nascimento</dt><dd>${brDate(p.birth_date)} ${p.birth_date ? `(${age(p.birth_date)})` : ''}</dd>
      <dt>CPF</dt><dd>${p.cpf ? html`${cpfFmt(p.cpf)}${cpfValid(p.cpf) ? '' : html` <small class="err-txt">(inválido — corrija em Editar)</small>`}` : '—'}</dd>
      <dt>Telefone</dt><dd>${p.phone ? phoneFmt(p.phone) : '—'}${p.whatsapp_optin ? '' : ' (não autoriza WhatsApp)'}</dd>
      ${p.responsible_phone ? html`<dt>Agendado por</dt><dd>${p.responsible_name || 'contato'} · ${p.responsible_phone}${p.phone && p.responsible_phone && p.phone.replace(/\D/g, '') === p.responsible_phone.replace(/\D/g, '') ? ' (lembretes vão para este número)' : ''}</dd>` : ''}
      <dt>E-mail</dt><dd>${p.email || '—'}</dd>
      <dt>Endereço</dt><dd>${p.address || '—'}</dd>
      <dt>Emergência</dt><dd>${p.emergency || '—'}</dd>
      <dt>Responsável</dt><dd>${owner ? owner.name : '—'}</dd>
      <dt>Tipo de atendimento</dt><dd>${ins.fields.pay_kind === 'convenio' ? `Convênio · ${ins.list.find((i) => i.id === ins.fields.insurer_id)?.name || ''}${ins.fields.card ? ` · carteirinha ${Ins.maskCard(ins.fields.card)}` : ''}` : 'Particular'}</dd>
      <dt>Valor da sessão</dt><dd>${money(p.session_fee)} · paga ${p.pay_to === 'profissional' ? 'direto ao profissional' : 'na clínica'}</dd>
      ${p.payer_name ? html`<dt>Responsável financeiro</dt><dd>${p.payer_name}${p.payer_cpf ? ` · ${String(p.payer_cpf).replace(/\D/g, '').length === 14 ? 'CNPJ' : 'CPF'} ${docFmt(p.payer_cpf)}` : ''}</dd>` : ''}
      <dt>Consentimento/LGPD</dt><dd>${p.consent_at ? brDate(p.consent_at) : 'não registrado'}</dd>
      <dt>Observações</dt><dd class="pre">${p.notes || '—'}</dd>
      <dt>Cadastro</dt><dd>${brDate(p.created_at)}</dd>
    </dl>
    <p class="muted small">Os registros do prontuário devem ser guardados por no mínimo 5 anos (Resolução CFP nº 01/2009). Para desligar o paciente, altere a situação para “Alta” ou “Inativo”.</p>
    <p><a class="btn ghost" href="/pacientes/${p.id}/exportar" data-export>⬇ Exportar dados (LGPD)</a> <small class="muted">Cópia dos dados para o paciente (direito de acesso e portabilidade)${clin ? ', incluindo o prontuário' : ''}.</small></p></section>` : ''}
    `,
  }));
});

// ---------- registros do prontuário ----------
// Cópia dos dados do paciente (LGPD art. 18): .zip com cadastro, sessões, pagamentos, mensagens, termos e (perfis clínicos) prontuário
r.get('/:id/exportar', async (req, res, next) => {
  const p = await one('SELECT id, owner_id FROM patients WHERE id = ?', [int(req.params.id)]);
  if (!p) return next();
  if (!canSeePatient(req.user, p)) throw forbidden();
  const out = await Privacy.exportPatient(p.id, { withRecords: can(req.user, 'prontuario') && isClinician(req.user.role) ? req.user.id : false });
  await audit(req, 'lgpd-exportar', `patient:${p.id}${can(req.user, 'prontuario') ? ' com prontuário' : ''}`);
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${out.name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(out.buf);
});

// ---------- tela da sessão ----------
r.get('/:id/sessao', async (req, res, next) => {
  const p = await loadPatient(int(req.params.id));
  if (!p) return next();
  await audit(req, 'sessao-abrir', `patient:${p.id}${int(req.query.a) ? ` appointment:${int(req.query.a)}` : ''}`);
  send(res, page(req, { title: `Sessão · ${nm(p)}`, active: 'pacientes', live: 'sessao', body: await sessionPage(req, p, { apptId: int(req.query.a), auto: req.query.auto === '1', fim: req.query.fim === '1' }) }));
});
// Rascunho salvo sozinho (a cada pausa na digitação)
r.post('/:id/rascunho', express.json({ limit: '600kb' }), async (req, res) => {
  const p = await one('SELECT id FROM patients WHERE id = ?', [int(req.params.id)]);
  if (!p) return res.status(404).json({ ok: false, error: 'Paciente não encontrado.' });
  if (req.body?.drop) { await Rec.dropDraft(req.user.id, p.id); return res.json({ ok: true, dropped: true }); }
  const appt = int(req.body?.appt) ? (await one('SELECT id FROM appointments WHERE id = ? AND patient_id = ?', [int(req.body.appt), p.id]))?.id : null;
  await Rec.saveDraft(req.user.id, p.id, appt, req.body || {});
  res.json({ ok: true, at: nowLocal().slice(11, 16) });
});

r.post('/:id/registros', async (req, res, next) => {
  const p = await one('SELECT id FROM patients WHERE id = ?', [int(req.params.id)]);
  if (!p) return next();
  const d = Rec.readForm(req.body);
  if (d.empty && !d.demand) return res.flash('O registro está vazio.', 'err').redirect(`/pacientes/${p.id}/sessao`);
  const appt = int(req.body.appt) ? (await one('SELECT id FROM appointments WHERE id = ? AND patient_id = ?', [int(req.body.appt), p.id]))?.id : null;
  const id = await Rec.create(p.id, req.user.id, d, { date: isYmd(req.body.record_date) ? req.body.record_date : todayLocal(), apptId: appt || null });
  await Rec.dropDraft(req.user.id, p.id);
  const sai = int(req.body.sai_rec) && await SessionAI.markSaved(int(req.body.sai_rec), req.user.id, p.id, id);
  await audit(req, 'prontuario-registrar', `patient:${p.id}${sai ? ` ia-sessao rec:${req.body.sai_rec}` : ''}`);
  res.flash(sai ? 'Registro salvo no prontuário. A transcrição da sessão foi apagada.' : 'Registro salvo no prontuário.').redirect(`/pacientes/${p.id}?aba=prontuario`);
});

r.get('/:id/registros/:rid', async (req, res, next) => {
  const p = await one('SELECT id, name, social_name FROM patients WHERE id = ?', [int(req.params.id)]);
  if (!p) return next();
  const rec = await Rec.get(int(req.params.rid), p.id, req.user.id); // só quem escreveu abre e altera
  if (!rec) return next();
  send(res, page(req, {
    title: 'Editar registro', active: 'pacientes', live: 'sessao',
    body: html`<header class="ph"><div><p class="eyebrow">Prontuário · ${nm(p)}</p><h1>Registro de ${brDate(rec.record_date)}</h1></div></header>
    ${recordForm({ action: `/pacientes/${p.id}/registros/${rec.id}`, rec, apptId: rec.appointment_id, submit: 'Salvar alterações', cancelHref: `/pacientes/${p.id}?aba=prontuario` })}
    <p class="muted small">Criado em ${brDateTime(rec.created_at)} · última alteração ${brDateTime(rec.updated_at)}</p>`,
  }));
});

r.post('/:id/registros/:rid', async (req, res, next) => {
  const rec = await one('SELECT id, patient_id, author_id, appointment_id FROM records WHERE id = ? AND patient_id = ?', [int(req.params.rid), int(req.params.id)]);
  if (!rec) return next();
  if (rec.author_id !== req.user.id) return next(forbidden());
  const d = Rec.readForm(req.body);
  if (d.empty && !d.demand) return res.flash('O registro está vazio.', 'err').redirect(req.originalUrl);
  await Rec.update(rec.id, d, isYmd(req.body.record_date) ? req.body.record_date : todayLocal());
  await audit(req, 'prontuario-editar', `record:${rec.id}`);
  res.flash('Registro atualizado.').redirect(`/pacientes/${rec.patient_id}?aba=prontuario`);
});

// ---------- prontuário para impressão (papel timbrado): só os registros de quem imprime ----------
r.get('/:id/prontuario', async (req, res, next) => {
  const p = await loadPatient(int(req.params.id));
  if (!p) return next();
  const records = await Rec.forPatient(p.id, req.user.id, { asc: true });
  const me = await one('SELECT name, title, crp FROM users WHERE id = ?', [req.user.id]);
  await audit(req, 'prontuario-imprimir', `patient:${p.id}`);
  send(res, bare(`Prontuário · ${nm(p)}`, html`
  <div class="print-bar"><button class="btn" data-print>Imprimir / salvar em PDF</button></div>
  <article class="letter">
    <header class="lh">${logoTag('')}<div><b>${me?.name || Brand.get().short}</b><span>${me?.title === 'Dr.' ? 'Psicólogo' : 'Psicóloga'}${me?.crp ? ` · CRP ${me.crp}` : ''}</span></div></header>
    <h1>Prontuário psicológico</h1>
    <p class="confid">Documento sigiloso — Código de Ética Profissional do Psicólogo, art. 9º.</p>
    <dl class="dl compact"><dt>Paciente</dt><dd>${p.name}${p.social_name ? ` (nome social: ${p.social_name})` : ''}</dd><dt>Nascimento</dt><dd>${brDate(p.birth_date)}</dd><dt>Início</dt><dd>${brDate(p.created_at)}</dd><dt>Modalidade</dt><dd>${label(p.modality)}</dd></dl>
    ${records.map((rec) => html`<section class="lrec"><h3>${brDate(rec.record_date)} · ${label(rec.kind)}${Rec.sessionType(rec) ? ` · ${Rec.sessionType(rec)}` : ''}</h3>
      ${rec.demand ? html`<p><b>Demanda trazida:</b> ${rec.demand}</p>` : ''}
      <div class="rt">${raw(rec.html)}</div>
      ${rec.hypothesis || rec.cid10.length || rec.cid11.length ? html`<p><b>Hipótese diagnóstica:</b> ${rec.hypothesis || '—'}${rec.cid10.length ? ` · CID-10: ${rec.cid10.map((c) => `${c}${CID.nameOf('cid10', c) ? ` (${CID.nameOf('cid10', c)})` : ''}`).join(', ')}` : ''}${rec.cid11.length ? ` · CID-11: ${rec.cid11.map((c) => `${c}${CID.nameOf('cid11', c) ? ` (${CID.nameOf('cid11', c)})` : ''}`).join(', ')}` : ''}</p>` : ''}</section>`)}
    <footer class="lf"><p>${Brand.get().city ? `${Brand.get().city}, ` : ''}${longDate(todayLocal())}.</p><div class="sign">${me?.name || ''}<br>${me?.title === 'Dr.' ? 'Psicólogo' : 'Psicóloga'}${me?.crp ? ` · CRP ${me.crp}` : ''}</div>
    <p class="lf-contact">${[Brand.get().phone, Brand.get().email, Brand.get().site].filter(Boolean).join(' · ')}</p></footer>
  </article>`, 'bare print'));
});

export default r;

// Aba Humor: check-ins diários do paciente pelo portal (só o profissional responsável vê, como o prontuário)
async function moodTab(req, p) {
  const list = await Mood.history(p.id, 90);
  if (list.some((x) => x.risk && !x.risk_seen_at)) await Mood.markSeen(p.id);
  const last14 = []; const by = Object.fromEntries(list.map((x) => [x.day, x]));
  for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - 3 * 3600e3 - i * 864e5).toISOString().slice(0, 10); last14.push({ d, x: by[d] }); }
  const color = (x) => (x.e.tone === 'pos' ? 'var(--ok)' : x.e.tone === 'dif' ? 'var(--err)' : 'var(--muted)');
  return html`<section class="card"><h2>Humor (check-in diário)</h2>
    <p class="muted small">O paciente registra pelo portal a emoção do dia e a intensidade (0 a 10). Ligue em Configurações → Portal do paciente → Check-in diário. ${list.length ? `${list.length} registro(s) nos últimos 90 dias.` : ''}</p>
    ${list.length ? html`<div class="mood-strip" role="img" aria-label="Últimos 14 dias">${last14.map(({ d, x }) => html`<div class="mood-day ${x?.risk ? 'risk' : ''}" title="${brDate(d)}${x ? ` · ${x.e.label} ${x.intensity}/10` : ' · sem registro'}">
        <span class="mood-bar"><i style="height:${x ? Math.max(8, x.intensity * 10) : 0}%;background:${x ? color(x) : 'transparent'}"></i></span><span class="mood-emo">${x ? x.e.emoji : '·'}</span><small>${d.slice(8, 10)}/${d.slice(5, 7)}</small></div>`)}</div>
      <p class="muted small mood-leg"><span style="color:var(--ok)">■</span> emoções agradáveis · <span style="color:var(--err)">■</span> emoções difíceis · altura = intensidade</p>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Dia</th><th>Emoção</th><th>Intensidade</th><th>O que aconteceu</th></tr></thead><tbody>
      ${list.map((x) => html`<tr class="${x.risk ? 'mood-risk' : ''}"><td>${brDate(x.day)}</td><td>${x.e.emoji} ${x.e.label}${x.risk ? html` <span class="badge b-falta">sinal de risco</span>` : ''}</td><td>${x.intensity}/10</td><td class="small">${x.note || '—'}</td></tr>`)}
      </tbody></table></div>` : html`<p class="muted">Nenhum check-in ainda.</p>`}
  </section>`;
}
