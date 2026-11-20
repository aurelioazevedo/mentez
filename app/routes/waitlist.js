// Agenda → Lista de espera: quem aguarda vaga, vagas abertas por cancelamento e ofertas pelo WhatsApp.
// Configurações → Lista de espera: regras (automático, uma pessoa por vez, tempo para responder, texto).
import { q, one, audit } from '../lib/db.js';
import { page, agendaTabs, html, raw, brDate, brDateTime } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { can, ownOnly, patientScope, canSeePatient, proName, forbidden } from '../lib/perm.js';
import * as W from '../lib/waitlist.js';
import * as WA from '../lib/whatsapp.js';
import { todayLocal, isYmd, isHm } from '../lib/time.js';

const r = router();
const BASE = '/agenda/lista-espera';
const nm = (p) => p.social_name || p.name;
const OFFER_LABEL = { enviada: ['agendada', 'Aguardando resposta'], aceita: ['realizada', 'Aceitou'], recusada: ['cancelada', 'Recusou'], expirada: ['falta', 'Não respondeu a tempo'], ocupada: ['cancelada', 'Vaga já preenchida'], falhou: ['falta', 'WhatsApp não enviado'] };
const offerBadge = (s) => html`<span class="badge b-${OFFER_LABEL[s]?.[0] || 'agendada'}">${OFFER_LABEL[s]?.[1] || s}</span>`;
const pros = () => q("SELECT id, name, title FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");
const mine = (req, w) => !ownOnly(req.user) || w.owner_id === req.user.id || w.p_owner === req.user.id;

async function loadEntry(req, id) {
  const w = await W.get(id);
  if (!w) return null;
  if (!mine(req, w)) throw forbidden();
  return w;
}
async function loadSlot(req, id) {
  const s = await one('SELECT s.*, u.name pro_name, u.title pro_title FROM waitlist_slots s LEFT JOIN users u ON u.id = s.owner_id WHERE s.id = ?', [id]);
  if (!s) return null;
  if (ownOnly(req.user) && s.owner_id !== req.user.id) throw forbidden();
  return s;
}

function entryForm(req, { w = {}, patients, proList, moves = [], action, title }) {
  const days = String(w.weekdays || '').split(',').filter(Boolean).map(Number);
  const pers = String(w.periods || '').split(',').filter(Boolean);
  const isNew = !w.id;
  return html`<form method="post" action="${action}" class="card form-grid wl-form" id="nova">
    <h2 class="span2">${title}</h2>
    ${isNew ? html`<label class="fld span2"><span>Paciente</span><select name="patient_id" data-wl-patient><option value="">Ainda não é paciente (informar nome e WhatsApp)</option>${patients.map((p) => html`<option value="${p.id}" data-owner="${p.owner_id || ''}" ${p.id === w.patient_id ? raw('selected') : ''}>${nm(p)}</option>`)}</select></label>
      <div class="span2 wl-new" data-wl-new ${w.patient_id ? raw('hidden') : ''}>
        <label class="fld"><span>Nome completo</span><input name="name" maxlength="160" autocomplete="off"></label>
        <label class="fld"><span>WhatsApp (com DDD)</span><input name="phone" maxlength="40" inputmode="tel" placeholder="(62) 99999-9999"></label>
      </div>`
    : html`<p class="span2"><b>${w.display}</b>${w.patient_id ? '' : html` <small class="muted">· ${w.phone}</small>`}</p>`}
    <label class="fld"><span>Profissional</span><select name="owner_id">
      ${ownOnly(req.user) ? '' : html`<option value="">Qualquer profissional</option>`}
      ${proList.map((u) => html`<option value="${u.id}" ${u.id === (w.owner_id ?? (isNew && ownOnly(req.user) ? req.user.id : null)) ? raw('selected') : ''}>${proName(u)}</option>`)}</select></label>
    <label class="fld"><span>Modalidade</span><select name="modality">
      ${[['qualquer', 'Tanto faz'], ['online', 'On-line'], ['presencial', 'Presencial']].map(([v, l]) => html`<option value="${v}" ${(w.modality || 'qualquer') === v ? raw('selected') : ''}>${l}</option>`)}</select></label>
    <fieldset class="fld span2 wl-chips"><legend>Dias que servem <small class="muted">(nenhum marcado = qualquer dia)</small></legend>
      ${[1, 2, 3, 4, 5, 6, 0].map((d) => html`<label class="wl-chip"><input type="checkbox" name="weekdays" value="${d}" ${days.includes(d) ? raw('checked') : ''}><span>${W.DAYS[d]}</span></label>`)}</fieldset>
    <fieldset class="fld span2 wl-chips"><legend>Períodos <small class="muted">(nenhum marcado = qualquer horário)</small></legend>
      ${Object.entries(W.PERIODS).map(([k, l]) => html`<label class="wl-chip"><input type="checkbox" name="periods" value="${k}" ${pers.includes(k) ? raw('checked') : ''}><span>${l}</span></label>`)}</fieldset>
    <label class="fld"><span>A partir de</span><input type="date" name="from_date" value="${w.from_date || ''}"></label>
    <label class="fld"><span>Aguardar até <small class="muted">(opcional)</small></span><input type="date" name="until_date" value="${w.until_date || ''}" min="${todayLocal()}"></label>
    ${moves.length ? html`<label class="fld span2"><span>Antecipar uma sessão já marcada?</span><select name="move_appt_id"><option value="">Não — é uma sessão nova</option>${moves.map((a) => html`<option value="${a.id}" ${a.id === w.move_appt_id ? raw('selected') : ''}>Sim, a de ${W.whenTxt(a.starts_at)}</option>`)}</select><small class="muted">Se aceitar a vaga, a sessão é trocada para o novo horário e o horário antigo é oferecido à próxima pessoa.</small></label>` : ''}
    <label class="fld span2"><span>Observação para a equipe</span><input name="notes" maxlength="500" value="${w.notes || ''}" placeholder="Ex.: prefere depois das 17h"></label>
    <label class="fld check span2"><input type="checkbox" name="priority" value="1" ${w.priority ? raw('checked') : ''}><span>Prioridade (recebe as ofertas antes dos demais)</span></label>
    <div class="actions span2"><button class="btn">${isNew ? 'Colocar na lista' : 'Salvar'}</button>${isNew ? '' : html`<a class="btn ghost" href="${BASE}">Cancelar</a>`}</div>
  </form>`;
}

r.get('/', async (req, res) => {
  const cfg = await W.config();
  const own = ownOnly(req.user);
  const all = await W.list('aguardando');
  const list = all.filter((w) => mine(req, w));
  const sc = patientScope(req.user);
  const patients = await q(`SELECT p.id, p.name, p.social_name, p.owner_id FROM patients p WHERE p.status IN ('ativo','pausa') ${sc.sql} ORDER BY p.name`, sc.params);
  const proList = own ? [{ id: req.user.id, name: req.user.name, title: req.user.title }] : await pros();
  const pre = int(req.query.paciente);
  const edit = int(req.query.editar) ? await loadEntry(req, int(req.query.editar)) : null;
  const movePid = edit?.patient_id || pre;
  const moves = movePid ? await q("SELECT id, starts_at FROM appointments WHERE patient_id = ? AND status IN ('agendada','confirmada') AND starts_at > NOW() ORDER BY starts_at LIMIT 10", [movePid]) : [];
  const slots = await q(`SELECT s.*, u.name pro_name, u.title pro_title,
      (SELECT COUNT(*) FROM waitlist_offers o WHERE o.slot_id = s.id AND o.status <> 'falhou') sent
    FROM waitlist_slots s LEFT JOIN users u ON u.id = s.owner_id WHERE s.status = 'aberta' ${own ? 'AND s.owner_id = ?' : ''} ORDER BY s.starts_at`, own ? [req.user.id] : []);
  for (const s of slots) {
    s.active = await one(`SELECT o.*, COALESCE(p.social_name, p.name, w.name) who FROM waitlist_offers o JOIN waitlist w ON w.id = o.waitlist_id LEFT JOIN patients p ON p.id = w.patient_id
      WHERE o.slot_id = ? AND o.status = 'enviada' ORDER BY o.id DESC LIMIT 1`, [s.id]);
    s.cands = (await W.candidates(s, cfg)).length;
  }
  const hist = await q(`SELECT s.*, u.name pro_name, u.title pro_title, COALESCE(p.social_name, p.name) who,
      (SELECT COUNT(*) FROM waitlist_offers o WHERE o.slot_id = s.id AND o.status <> 'falhou') sent
    FROM waitlist_slots s LEFT JOIN users u ON u.id = s.owner_id LEFT JOIN appointments a ON a.id = s.appointment_id LEFT JOIN patients p ON p.id = a.patient_id
    WHERE s.status <> 'aberta' ${own ? 'AND s.owner_id = ?' : ''} ORDER BY COALESCE(s.closed_at, s.created_at) DESC LIMIT 15`, own ? [req.user.id] : []);
  const st = await W.stats();
  const prefill = pre ? { patient_id: pre, owner_id: patients.find((p) => p.id === pre)?.owner_id ?? null } : {};

  send(res, page(req, {
    title: 'Lista de espera', active: 'agenda',
    body: html`<header class="ph"><div><p class="eyebrow">Agenda</p><h1>Lista de espera</h1>
        <p class="muted">Quando uma sessão é cancelada ou remarcada, o atendente virtual oferece o horário pelo WhatsApp a quem combina com ele, na ordem da lista. Quem responder <b>SIM</b> fica com a vaga.</p></div>
      <div class="ph-actions"><a class="btn" href="#nova">Adicionar à lista</a>${can(req.user, 'usuarios') ? html`<a class="btn ghost" href="/configuracoes/lista-espera">Regras</a>` : ''}</div></header>
    ${agendaTabs('espera')}
    ${!cfg.enabled ? html`<p class="flash warn">A lista de espera está desligada: as vagas não são oferecidas. ${can(req.user, 'usuarios') ? html`<a class="link" href="/configuracoes/lista-espera">Ligar</a>` : ''}</p>`
    : !cfg.auto ? html`<p class="flash warn">Modo manual: as vagas abertas aparecem abaixo e a equipe decide quando oferecer.</p>` : ''}
    <div class="kpis">
      <div class="kpi"><span>Aguardando vaga</span><b>${list.length}</b></div>
      <div class="kpi"><span>Vagas abertas agora</span><b>${slots.length}</b></div>
      <div class="kpi"><span>Vagas preenchidas (30 dias)</span><b>${st.filled30}</b></div>
      <div class="kpi"><span>Aproveitamento (30 dias)</span><b>${st.slots30 ? `${Math.round((st.filled30 / st.slots30) * 100)}%` : '—'}</b></div>
    </div>

    <section class="card"><h2>Vagas abertas</h2>
      ${slots.length ? html`<ul class="list wl-slots">${slots.map((s) => html`<li><div class="wl-row">
        <div><b>${W.whenTxt(s.starts_at)}</b> <small class="muted">· ${s.duration_min} min${own ? '' : html` · ${proName({ name: s.pro_name, title: s.pro_title })}`}</small>
          <small class="wl-sub">${s.active ? html`Oferecida a <b>${s.active.who}</b> — aguardando resposta até ${String(s.active.expires_at).slice(11, 16)}` : s.cands ? `${s.cands} pessoa(s) compatível(is) na lista` : 'Ninguém compatível na lista no momento'}${s.sent ? ` · ${s.sent} oferta(s) enviada(s)` : ''}</small></div>
        <div class="wl-acts"><a class="chip" href="${BASE}/vaga/${s.id}">Ver vaga</a>
          ${!cfg.auto && s.cands && !s.active ? html`<form method="post" action="${BASE}/vaga/${s.id}/oferecer"><button class="chip">Oferecer agora</button></form>` : ''}</div>
      </div></li>`)}</ul>` : html`<p class="muted">Nenhuma vaga aberta. Quando uma sessão futura for cancelada ou remarcada, o horário aparece aqui.</p>`}
      <details class="wl-open"><summary>Oferecer um horário livre da agenda</summary>
        <form method="post" action="${BASE}/vaga" class="form-grid">
          <label class="fld"><span>Profissional</span><select name="owner_id" required>${proList.map((u) => html`<option value="${u.id}">${proName(u)}</option>`)}</select></label>
          <label class="fld"><span>Data</span><input type="date" name="date" required min="${todayLocal()}"></label>
          <label class="fld"><span>Horário</span><input type="time" name="time" required step="300"></label>
          <label class="fld"><span>Duração (min)</span><input type="number" name="duration_min" min="10" max="240" value="40"></label>
          <div class="actions span2"><button class="btn ghost">Abrir vaga</button></div>
        </form></details>
    </section>

    <section class="card"><h2>Aguardando vaga <small class="muted">(${list.length})</small></h2>
      ${list.length ? html`<ol class="list wl-list">${list.map((w, i) => html`<li><div class="wl-row">
        <span class="wl-pos">${i + 1}º</span>
        <div class="wl-main"><b>${w.patient_id ? html`<a class="link" href="/pacientes/${w.patient_id}">${w.display}</a>` : w.display}</b>
          ${w.priority ? html`<span class="badge b-falta">Prioridade</span>` : ''}${w.move_appt_id && w.move_starts ? html`<span class="badge b-confirmada">Antecipar ${brDate(w.move_starts).slice(0, 5)}</span>` : ''}${!w.patient_id ? html`<span class="badge b-agendada">Novo contato</span>` : ''}
          <small class="wl-sub">${W.prefsText(w)}${w.owner_id ? ` · ${proName({ name: w.pro_name, title: w.pro_title })}` : ' · qualquer profissional'}</small>
          <small class="wl-sub muted">Na lista desde ${brDate(w.created_at)}${w.created_via === 'agente' ? ' (pelo atendente virtual)' : ''}${w.offers ? ` · ${w.offers} oferta(s) recebida(s)` : ''}${w.notes ? ` · ${w.notes}` : ''}</small>
          ${w.bookedElsewhere ? html`<small class="wl-warn">Já marcou sessão para ${brDateTime(w.bookedElsewhere)} — não recebe ofertas. Remover da lista?</small>` : ''}</div>
        <div class="wl-acts"><a class="chip" href="${BASE}?editar=${w.id}#nova">Editar</a>
          <form method="post" action="${BASE}/${w.id}/remover" data-confirm="Tirar ${w.display} da lista de espera?"><button class="chip">Remover</button></form></div>
      </div></li>`)}</ol>` : html`<p class="muted">Ninguém aguardando vaga. Adicione pacientes abaixo, pela ficha do paciente, ou deixe o atendente virtual oferecer a lista quando não houver horário.</p>`}
    </section>

    ${edit ? entryForm(req, { w: edit, patients, proList, moves, action: `${BASE}/${edit.id}`, title: 'Editar preferências' })
    : entryForm(req, { w: prefill, patients, proList, moves, action: BASE, title: 'Adicionar à lista de espera' })}

    <section class="card"><h2>Histórico de vagas</h2>
      ${hist.length ? html`<ul class="list wl-hist">${hist.map((s) => html`<li><div class="wl-row"><div><b>${W.whenTxt(s.starts_at)}</b>${own ? '' : html` <small class="muted">· ${proName({ name: s.pro_name, title: s.pro_title })}</small>`}
        <small class="wl-sub">${s.status === 'preenchida' ? html`<span class="badge b-realizada">Preenchida</span> por ${s.who || '—'}` : html`<span class="badge b-cancelada">Encerrada</span> ${s.reason || ''}`}${s.sent ? ` · ${s.sent} oferta(s)` : ''}</small></div>
        <a class="chip" href="${BASE}/vaga/${s.id}">Detalhes</a></div></li>`)}</ul>` : html`<p class="muted">Nenhuma vaga ainda.</p>`}
    </section>`,
  }));
});

function entryData(req) {
  const b = req.body;
  return { ...W.cleanPrefs(b), weekdays: b.weekdays, periods: b.periods, modality: b.modality, from_date: b.from_date, until_date: b.until_date,
    owner_id: ownOnly(req.user) ? req.user.id : int(b.owner_id) || null, notes: str(b.notes, 500), priority: !!b.priority, move_appt_id: int(b.move_appt_id) || null };
}

r.post('/', async (req, res) => {
  const b = req.body; const e = entryData(req);
  const pid = int(b.patient_id);
  if (pid) {
    const p = await one('SELECT id, owner_id, phone FROM patients WHERE id = ?', [pid]);
    if (!p || !canSeePatient(req.user, p)) throw forbidden();
    if (!WA.normalizePhone(p.phone)) return res.flash('O paciente não tem WhatsApp válido na ficha: cadastre o telefone para ele receber as ofertas.', 'err').redirect(`${BASE}?paciente=${pid}#nova`);
    if (e.move_appt_id && !(await one("SELECT id FROM appointments WHERE id = ? AND patient_id = ? AND status IN ('agendada','confirmada')", [e.move_appt_id, pid]))) e.move_appt_id = null;
  } else {
    if (str(b.name).split(/\s+/).length < 2) return res.flash('Informe o nome completo (nome e sobrenome).', 'err').redirect(`${BASE}#nova`);
    if (!WA.normalizePhone(b.phone)) return res.flash('Informe um WhatsApp válido, com DDD.', 'err').redirect(`${BASE}#nova`);
    e.move_appt_id = null;
  }
  const r2 = await W.add({ ...e, patient_id: pid || null, name: str(b.name, 160), phone: str(b.phone, 40), userId: req.user.id });
  await audit(req, 'lista-espera-incluir', `waitlist:${r2.id}`);
  res.flash(r2.existed ? 'Este paciente já estava na lista: preferências atualizadas.' : 'Incluído(a) na lista de espera. Quando abrir um horário compatível, a oferta vai pelo WhatsApp.').redirect(BASE);
});

r.post('/vaga', async (req, res) => {
  const b = req.body;
  const owner = ownOnly(req.user) ? req.user.id : int(b.owner_id);
  if (!owner || !isYmd(b.date) || !isHm(b.time)) return res.flash('Informe profissional, data e horário.', 'err').redirect(BASE);
  const start = `${b.date} ${b.time}:00`;
  const dur = Math.min(240, Math.max(10, int(b.duration_min) || 40));
  const busy = await one(`SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status <> 'cancelada' AND p.owner_id = ? AND a.starts_at < DATE_ADD(?, INTERVAL ? MINUTE) AND DATE_ADD(a.starts_at, INTERVAL a.duration_min MINUTE) > ?`, [owner, start, dur, start]);
  if (busy) return res.flash('Esse horário já tem sessão marcada.', 'err').redirect(BASE);
  const f = await W.openSlot(owner, start, dur, req.user.id);
  if (!f) return res.flash('Não foi possível abrir a vaga: verifique se a lista está ligada e se o horário não está em cima da hora.', 'err').redirect(BASE);
  await audit(req, 'lista-espera-vaga', `slot:${f.slotId}`);
  res.flash(f.candidates ? (f.auto ? `Vaga aberta e oferecida à lista (${f.candidates} pessoa[s] compatível[is]).` : `Vaga aberta: ${f.candidates} pessoa(s) compatível(is).`) : 'Vaga aberta. Ninguém da lista combina com ela por enquanto.').redirect(`${BASE}/vaga/${f.slotId}`);
});

r.get('/vaga/:id', async (req, res, next) => {
  const s = await loadSlot(req, int(req.params.id));
  if (!s) return next();
  const cfg = await W.config();
  const offers = await q(`SELECT o.*, COALESCE(p.social_name, p.name, w.name) who, w.patient_id FROM waitlist_offers o JOIN waitlist w ON w.id = o.waitlist_id LEFT JOIN patients p ON p.id = w.patient_id WHERE o.slot_id = ? ORDER BY o.id`, [s.id]);
  const cands = s.status === 'aberta' ? await W.candidates(s, cfg) : [];
  const open = s.status === 'aberta';
  send(res, page(req, {
    title: 'Vaga da lista de espera', active: 'agenda',
    body: html`<header class="ph"><div><p class="eyebrow">Lista de espera · vaga</p><h1>${W.whenTxt(s.starts_at)}</h1>
      <p class="muted">${proName({ name: s.pro_name, title: s.pro_title })} · ${s.duration_min} min · ${open ? 'aberta' : s.status === 'preenchida' ? 'preenchida' : `encerrada${s.reason ? `: ${s.reason}` : ''}`}</p></div>
      <div class="ph-actions"><a class="btn ghost" href="${BASE}">Voltar</a>${s.appointment_id ? html`<a class="btn ghost" href="/agenda/${s.appointment_id}">Abrir sessão</a>` : ''}
      ${open ? html`<form method="post" action="${BASE}/vaga/${s.id}/encerrar" data-confirm="Encerrar esta vaga? Ninguém mais recebe a oferta."><button class="btn ghost">Encerrar vaga</button></form>` : ''}</div></header>
    <section class="card"><h2>Ofertas enviadas</h2>
      ${offers.length ? html`<ul class="list">${offers.map((o) => html`<li><div class="wl-row"><div><b>${o.patient_id ? html`<a class="link" href="/pacientes/${o.patient_id}">${o.who}</a>` : o.who}</b>
        <small class="wl-sub">Enviada ${brDateTime(o.sent_at)}${o.status === 'enviada' ? ` · reservada até ${String(o.expires_at).slice(11, 16)}` : ''}${o.answered_at ? ` · resposta ${brDateTime(o.answered_at)}${o.via === 'agente' ? ' (atendente virtual)' : o.via === 'equipe' ? ' (equipe)' : ''}` : ''}${o.error ? ` · ${o.error}` : ''}</small></div>
        <div class="wl-acts">${offerBadge(o.status)}${open && ['enviada', 'expirada'].includes(o.status) ? html`<form method="post" action="${BASE}/oferta/${o.id}/aceitar" data-confirm="Registrar que ${o.who} aceitou? A sessão será agendada agora."><button class="chip">Marcar como aceita</button></form>` : ''}</div></div></li>`)}</ul>`
      : html`<p class="muted">Nenhuma oferta enviada ainda.</p>`}
    </section>
    ${open ? html`<section class="card"><h2>Pessoas compatíveis <small class="muted">(${cands.length})</small></h2>
      <p class="muted small sub-h">Na ordem em que recebem a oferta${cfg.mode === 'sequencial' ? `, uma por vez, com ${cfg.replyMinutes} min para responder` : ', todas ao mesmo tempo'}.</p>
      ${cands.length ? html`<ol class="list">${cands.map((w) => html`<li><div class="wl-row"><div><b>${w.display}</b>${w.priority ? html` <span class="badge b-falta">Prioridade</span>` : ''}<small class="wl-sub">${W.prefsText(w)}</small></div>
        <form method="post" action="${BASE}/vaga/${s.id}/oferecer/${w.id}"><button class="chip">Oferecer</button></form></div></li>`)}</ol>`
      : html`<p class="muted">Ninguém na lista combina com este horário (dia, período, profissional ou modalidade).</p>`}
    </section>` : ''}`,
  }));
});

r.post('/vaga/:id/oferecer', async (req, res, next) => {
  const s = await loadSlot(req, int(req.params.id));
  if (!s) return next();
  await W.processSlot(s.id, { force: true });
  const n = await one("SELECT COUNT(*) n FROM waitlist_offers WHERE slot_id = ? AND status = 'enviada'", [s.id]);
  res.flash(n.n ? 'Oferta enviada pelo WhatsApp.' : 'Nenhuma oferta enviada (fora do horário comercial, ninguém compatível ou WhatsApp desconectado).', n.n ? 'ok' : 'warn').redirect(`${BASE}/vaga/${s.id}`);
});
r.post('/vaga/:id/oferecer/:wid', async (req, res, next) => {
  const s = await loadSlot(req, int(req.params.id));
  if (!s) return next();
  const out = await W.offerTo(s.id, int(req.params.wid));
  await audit(req, 'lista-espera-oferta', `slot:${s.id} waitlist:${int(req.params.wid)}`);
  res.flash(out.ok ? 'Oferta enviada pelo WhatsApp.' : out.error, out.ok ? 'ok' : 'err').redirect(`${BASE}/vaga/${s.id}`);
});
r.post('/vaga/:id/encerrar', async (req, res, next) => {
  const s = await loadSlot(req, int(req.params.id));
  if (!s) return next();
  await q("UPDATE waitlist_slots SET status = 'encerrada', reason = 'encerrada pela equipe', closed_at = NOW() WHERE id = ? AND status = 'aberta'", [s.id]);
  await q("UPDATE waitlist_offers SET status = 'expirada' WHERE slot_id = ? AND status = 'enviada'", [s.id]);
  await audit(req, 'lista-espera-encerrar', `slot:${s.id}`);
  res.flash('Vaga encerrada.').redirect(BASE);
});
r.post('/oferta/:id/aceitar', async (req, res, next) => {
  const o = await one('SELECT * FROM waitlist_offers WHERE id = ?', [int(req.params.id)]);
  if (!o) return next();
  await loadSlot(req, o.slot_id);
  const out = await W.accept(o.id, 'equipe');
  await audit(req, 'lista-espera-aceite-manual', `offer:${o.id}`);
  if (!out.ok) return res.flash(out.error, 'err').redirect(`${BASE}/vaga/${o.slot_id}`);
  res.flash(`Sessão agendada para ${out.when}. O paciente recebeu a confirmação pelo WhatsApp.`).redirect(`/agenda/${out.appointmentId}`);
});

r.post('/:id', async (req, res, next) => {
  const w = await loadEntry(req, int(req.params.id));
  if (!w) return next();
  const e = entryData(req);
  if (e.move_appt_id && !(w.patient_id && await one("SELECT id FROM appointments WHERE id = ? AND patient_id = ? AND status IN ('agendada','confirmada')", [e.move_appt_id, w.patient_id]))) e.move_appt_id = null;
  await W.update(w.id, e);
  await audit(req, 'lista-espera-editar', `waitlist:${w.id}`);
  res.flash('Preferências salvas.').redirect(BASE);
});
r.post('/:id/remover', async (req, res, next) => {
  const w = await loadEntry(req, int(req.params.id));
  if (!w) return next();
  await W.remove(w.id);
  await audit(req, 'lista-espera-remover', `waitlist:${w.id}`);
  res.flash(`${w.display} saiu da lista de espera.`).redirect(BASE);
});

// ---------- Configurações → Lista de espera ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const c = await W.config();
  send(res, page(req, {
    title: 'Lista de espera', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Lista de espera</h1><p class="muted">Como as vagas que abrem com cancelamentos são oferecidas pelo WhatsApp.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="${BASE}">Abrir a lista</a><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <label class="fld check"><input type="checkbox" name="enabled" value="1" ${c.enabled ? raw('checked') : ''}><span><b>Lista de espera ligada</b> — sessões futuras canceladas ou remarcadas viram vagas para a lista</span></label>
      <label class="fld check"><input type="checkbox" name="auto" value="1" ${c.auto ? raw('checked') : ''}><span><b>Oferecer automaticamente</b> pelo WhatsApp (desmarcado: a equipe decide quando oferecer)</span></label>
      <label class="fld"><span>Como oferecer</span><select name="mode">${Object.entries(W.MODES).map(([k, l]) => html`<option value="${k}" ${c.mode === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <div class="form-grid">
        <label class="fld"><span>Tempo para responder (minutos)</span><input type="number" name="replyMinutes" min="5" max="1440" value="${c.replyMinutes}"></label>
        <label class="fld"><span>Máximo de ofertas por vaga</span><input type="number" name="maxOffers" min="1" max="30" value="${c.maxOffers}"></label>
        <label class="fld"><span>Não oferecer vagas com menos de (horas) de antecedência</span><input type="number" name="minLeadHours" min="0" max="72" step="0.5" value="${c.minLeadHours}"></label>
      </div>
      <p class="muted small">As ofertas saem só das 8h às 20h; vagas que abrem à noite são oferecidas na manhã seguinte. Ninguém recebe a mesma vaga duas vezes.</p>
      <label class="fld"><span>Mensagem da oferta</span><textarea name="msg" rows="8">${c.msg}</textarea></label>
      <p class="muted small">Campos: {nome} {profissional} {quando} {data} {hora} {dia_semana} {modalidade} {minutos} {troca} (frase sobre antecipar a sessão, quando houver). As respostas <b>SIM</b>, <b>NÃO</b> e <b>SAIR</b> são entendidas na hora; outras respostas o atendente virtual interpreta.</p>
      <div class="actions"><button class="btn">Salvar</button><button class="btn ghost" name="reset" value="1" formnovalidate>Restaurar texto padrão</button></div>
    </form>`,
  }));
});
settings.post('/', async (req, res) => {
  const b = req.body;
  await W.saveConfig({ ...b, msg: b.reset ? '' : b.msg });
  await audit(req, 'lista-espera-config');
  res.flash('Regras da lista de espera salvas.').redirect('/configuracoes/lista-espera');
});

export default r;
