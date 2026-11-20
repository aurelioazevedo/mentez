// Recepção — Hoje: fila de cada profissional, chegada, atendimento, finalização e pagamento, em tempo real.
import express from 'express';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, money, brDate, label } from '../lib/html.js';
import { router, send, int } from '../lib/router.js';
import { can, ownOnly, proName, forbidden } from '../lib/perm.js';
import * as Fin from '../lib/fin.js';
import * as Flow from '../lib/flow.js';
import * as TV from '../lib/tv.js';
import * as WA from '../lib/whatsapp.js';
import { notify } from '../lib/push.js';
import { todayLocal, nowLocal } from '../lib/time.js';
import * as Tele from '../lib/tele.js';

const r = router();
const METHODS = Fin.METHODS;
const nm = (p) => p.social_name || p.name;
const hm = (dt) => (dt ? String(dt).slice(11, 16) : '');
const COLS = [['agendado', 'Agendados'], ['aguardando', 'Aguardando'], ['em_atendimento', 'Em atendimento'], ['realizada', 'Finalizados']];
const colOf = (st) => (['agendada', 'confirmada'].includes(st) ? 'agendado' : st);
const methodSel = (name = 'method') => html`<select name="${name}" aria-label="Forma de pagamento">${METHODS.map((m) => html`<option value="${m}">${label(m)}</option>`)}</select>`;

async function loadAppt(req, id) {
  const a = await one(`SELECT a.*, p.name, p.social_name, p.owner_id, p.phone, p.whatsapp_optin, p.session_fee FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?`, [id]);
  if (!a) return null;
  if (ownOnly(req.user) && a.owner_id !== req.user.id) throw forbidden();
  return a;
}
const payOf = (apptId) => one("SELECT * FROM payments WHERE appointment_id = ? AND origin IN ('sessao','falta') ORDER BY id DESC LIMIT 1", [apptId]);
const back = (req) => { const b = String(req.body.back || '/recepcao'); return b.startsWith('/') && !b.startsWith('//') ? b : '/recepcao'; };

r.get('/', async (req, res) => {
  const cfg = await Flow.config();
  const own = ownOnly(req.user);
  const canFin = can(req.user, 'financeiro');
  const pros = own ? [{ id: req.user.id, name: req.user.name, title: req.user.title }] : await q("SELECT id, name, title FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY name");
  const prof = own ? req.user.id : int(req.query.prof) || null;
  const where = prof ? ' AND p.owner_id = ? ' : ' '; const params = prof ? [prof] : [];
  const rows = await q(`SELECT a.*, p.name, p.social_name, p.owner_id, p.phone, p.whatsapp_optin, p.session_fee, u.name pro, u.title pro_title,
      (SELECT i.name FROM patient_plans pp JOIN insurers i ON i.id = pp.insurer_id WHERE pp.id = a.plan_id) ins_name,
      x.id pay_id, x.amount pay_amount, x.paid_at pay_paid, x.method pay_method, x.receiver pay_receiver, x.charged_at pay_charged
    FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN payments x ON x.appointment_id = a.id AND x.origin IN ('sessao','falta')
    WHERE DATE(a.starts_at) = CURDATE() AND a.status NOT IN ('cancelada') ${where} ORDER BY a.starts_at`, params);
  const stats = await Flow.todayStats(where, params);
  const tvc = await TV.config(); const tvRooms = tvc.enabled ? await TV.rooms() : [];
  const now = nowLocal();
  const longWait = rows.filter((a) => a.status === 'aguardando' && a.arrived_at && (Date.parse(now.replace(' ', 'T')) - Date.parse(String(a.arrived_at).replace(' ', 'T'))) / 60000 >= cfg.waitAlertMin);
  const byPro = pros.map((u) => ({ u, n: rows.filter((a) => a.owner_id === u.id && a.status === 'em_atendimento').length, w: rows.filter((a) => a.owner_id === u.id && a.status === 'aguardando').length })).filter((x) => x.n || x.w);
  const toReceive = rows.filter((a) => ['realizada', 'falta'].includes(a.status) && a.pay_id && !a.pay_paid);
  const B = `/recepcao${prof && !own ? `?prof=${prof}` : ''}`;
  const hidden = html`<input type="hidden" name="back" value="${B}">`;

  const payChip = (a) => {
    if (a.package_id) return html`<span class="badge b-confirmada">Pacote</span>`;
    if (a.plan_id && !a.pay_id) return html`<span class="badge b-confirmada">Convênio · ${a.ins_name || ''}</span>`; // sem coparticipação: nada a cobrar do paciente
    if (!a.pay_id) return ['aguardando', 'em_atendimento', 'realizada'].includes(a.status) && !Number(a.session_fee) ? html`<span class="badge b-cancelada">Sem valor na ficha</span>` : '';
    const st = Fin.payState({ paid_at: a.pay_paid, receiver: a.pay_receiver });
    return html`<span class="badge ${st === 'pago' ? 'b-realizada' : st === 'aguardando' ? 'b-confirmada' : 'b-agendada'}">${st === 'pago' ? `Pago · ${label(a.pay_method)}` : st === 'aguardando' ? 'Direto ao profissional · a confirmar' : `A receber ${money(a.pay_amount)}`}</span>`;
  };
  const card = (a) => {
    const isPro = a.owner_id === req.user.id;
    const waitingMin = a.arrived_at ? Math.floor((Date.parse(now.replace(' ', 'T')) - Date.parse(String(a.arrived_at).replace(' ', 'T'))) / 60000) : 0;
    const askAtArrival = cfg.payMoment !== 'final' && !a.package_id && !a.plan_id && Number(a.session_fee) > 0; // convênio: o valor vem da operadora
    const unpaid = a.pay_id && !a.pay_paid;
    const askClinicAtEnd = unpaid && a.pay_receiver === 'clinica' && canFin && (cfg.payMoment !== 'chegada' || !a.arrived_at);
    const askProAtEnd = unpaid && a.pay_receiver === 'profissional' && (isPro || canFin);
    return html`<article class="rc-card s-${a.status} ${longWait.includes(a) ? 'late' : ''}" data-ctx="appt" data-id="${a.id}" data-st="${a.status}" data-pid="${a.patient_id}" data-name="${nm(a)}" data-when="${String(a.starts_at).slice(0, 16)}" data-dur="${a.duration_min}" data-phone="${WA.normalizePhone(a.phone) || ''}" data-optin="${a.whatsapp_optin ? 1 : 0}" data-link="${a.meeting_link || ''}" data-pay="${a.pay_id || ''}" data-paid="${a.pay_paid ? 1 : 0}">
      <div class="rc-top"><b class="time">${hm(a.starts_at)}</b><span class="rc-name"><a href="/pacientes/${a.patient_id}">${nm(a)}</a><small>${proName({ name: a.pro || '', title: a.pro_title })} · ${label(a.modality)}</small></span></div>
      <div class="rc-meta">
        ${a.ticket && ['aguardando', 'em_atendimento'].includes(a.status) ? html`<span class="rc-ticket" title="Senha do painel de chamadas">${a.ticket}</span>` : ''}
        ${a.arrived_at ? html`<span>Chegou ${hm(a.arrived_at)}</span>` : ''}
        ${a.called_at && a.status === 'aguardando' ? html`<span class="rc-called">Chamado ${hm(a.called_at)}${a.call_count > 1 ? ` (${a.call_count}×)` : ''}</span>` : ''}
        ${a.status === 'aguardando' ? html`<span class="rc-timer ${waitingMin >= cfg.waitAlertMin ? 'late' : ''}" data-since="${a.arrived_at}" data-alert="${cfg.waitAlertMin}">⏱ ${waitingMin} min</span>` : ''}
        ${a.status === 'em_atendimento' && a.started_at ? html`<span class="rc-timer" data-since="${a.started_at}">● ${Math.floor((Date.parse(now.replace(' ', 'T')) - Date.parse(String(a.started_at).replace(' ', 'T'))) / 60000)} min</span>` : ''}
        ${a.status === 'realizada' && a.started_at && a.finished_at ? html`<span>${hm(a.started_at)}–${hm(a.finished_at)}</span>` : ''}
        ${a.status === 'falta' ? html`<span class="badge b-falta">Falta</span>` : ''}
        ${payChip(a)}
      </div>
      <div class="rc-actions">
        ${['agendada', 'confirmada'].includes(a.status) ? (a.modality === 'online'
    ? html`<form method="post" action="/recepcao/${a.id}/iniciar">${hidden}<button class="btn sm">▶ Iniciar on-line</button></form>`
    : askAtArrival ? html`<details class="rc-pop"><summary class="btn sm">✓ Chegou</summary><form method="post" action="/recepcao/${a.id}/chegou" class="rc-form">${hidden}
        <p class="small"><b>Pagamento desta sessão (${money(a.session_fee)})</b></p>
        ${canFin ? html`<label class="check"><input type="radio" name="plan" value="clinica" checked> Pago agora na clínica ${methodSel()}</label>` : ''}
        <label class="check"><input type="radio" name="plan" value="profissional" ${canFin ? '' : raw('checked')}> Paga direto ao profissional</label>
        <label class="check"><input type="radio" name="plan" value="pendente"> Ainda não pagou (a receber)</label>
        <button class="btn sm">Registrar chegada</button></form></details>`
      : html`<form method="post" action="/recepcao/${a.id}/chegou">${hidden}<button class="btn sm">✓ Chegou</button></form>`)
    : ''}
        ${['agendada', 'confirmada'].includes(a.status) ? html`<form method="post" action="/recepcao/${a.id}/falta" data-confirm="Marcar falta de ${nm(a)}?">${hidden}<button class="chip">Faltou</button></form>` : ''}
        ${tvc.enabled && a.status === 'aguardando' ? html`<form method="post" action="/recepcao/${a.id}/chamar" class="rc-call">${hidden}
          ${tvc.chooseRoom && tvRooms.length ? html`<select name="room_id" aria-label="${tvc.roomWord}">${tvRooms.map((rm) => html`<option value="${rm.id}" ${(a.room_id ? rm.id === a.room_id : rm.owner_id === a.owner_id) ? raw('selected') : ''}>${TV.roomLabel(rm, tvc)}</option>`)}</select>` : ''}
          <button class="btn sm ${a.call_count ? 'ghost' : ''}">${a.call_count ? '↻ Chamar de novo' : '📣 Chamar na TV'}</button></form>` : ''}
        ${tvc.enabled && a.status === 'aguardando' && a.ticket && tvc.prefixMode === 'tipo' ? html`<form method="post" action="/recepcao/${a.id}/senha" class="rc-tt">${hidden}<select name="type" data-autosubmit aria-label="Tipo de senha">${[['A', 'Agendado'], ['P', 'Prioridade'], ['R', 'Retorno']].map(([k, l]) => html`<option value="${k}" ${a.ticket_type === k ? raw('selected') : ''}>${k} · ${l}</option>`)}</select><noscript><button class="chip">Trocar</button></noscript></form>` : ''}
        ${a.status === 'aguardando' ? html`<form method="post" action="/recepcao/${a.id}/iniciar">${hidden}<button class="btn sm">▶ Iniciar atendimento</button></form>` : ''}
        ${a.status === 'em_atendimento' ? (askProAtEnd || askClinicAtEnd
    ? html`<details class="rc-pop"><summary class="btn sm">■ Finalizar</summary><form method="post" action="/recepcao/${a.id}/finalizar" class="rc-form">${hidden}
        <p class="small"><b>${askProAtEnd ? `Recebeu ${money(a.pay_amount)} do paciente?` : `O pagamento (${money(a.pay_amount)}) já foi feito na clínica?`}</b></p>
        <label class="check"><input type="radio" name="received" value="sim"> Sim ${methodSel()}</label>
        <label class="check"><input type="radio" name="received" value="nao" checked> Ainda não</label>
        <button class="btn sm">Finalizar sessão</button></form></details>`
    : html`<form method="post" action="/recepcao/${a.id}/finalizar">${hidden}<button class="btn sm">■ Finalizar</button></form>`) : ''}
        ${['realizada', 'falta'].includes(a.status) && unpaid ? html`
          ${a.pay_receiver === 'clinica' && canFin ? html`<details class="rc-pop"><summary class="chip">Registrar recebimento</summary><form method="post" action="/recepcao/pag/${a.pay_id}/receber" class="rc-form">${hidden}${methodSel()}<button class="btn sm">Recebido ${money(a.pay_amount)}</button></form></details>` : ''}
          ${a.pay_receiver === 'profissional' && (isPro || canFin) ? html`<details class="rc-pop"><summary class="chip">Confirmar recebimento</summary><form method="post" action="/recepcao/pag/${a.pay_id}/confirmar" class="rc-form">${hidden}${methodSel()}<button class="btn sm">Recebi ${money(a.pay_amount)}</button></form></details>` : ''}
          ${cfg.reminder !== 'desligado' && a.whatsapp_optin && a.phone ? html`<form method="post" action="/recepcao/pag/${a.pay_id}/lembrete" data-confirm="Enviar lembrete de pagamento com Pix para ${nm(a)} pelo WhatsApp?">${hidden}<button class="chip">${a.pay_charged ? `Lembrete enviado ${hm(a.pay_charged)} · reenviar` : '💬 Lembrete WhatsApp'}</button></form>` : ''}` : ''}
      </div></article>`;
  };

  let fech = null;
  if (true) { // profissional vê o próprio fechamento (prof = ele mesmo)
    const sc = prof ? ' AND x.professional_id = ? ' : ' ';
    fech = {
      byMethod: await q(`SELECT x.method, x.receiver, SUM(x.amount) total, COUNT(*) n FROM payments x WHERE DATE(x.paid_at) = CURDATE() ${sc} GROUP BY x.method, x.receiver ORDER BY total DESC`, params),
      pend: await one(`SELECT COUNT(*) n, COALESCE(SUM(x.amount),0) t FROM payments x JOIN appointments a ON a.id = x.appointment_id WHERE DATE(a.starts_at) = CURDATE() AND x.paid_at IS NULL AND x.receiver = 'clinica' AND x.origin <> 'convenio' ${sc}`, params),
      conf: await q(`SELECT u.name, u.title, COUNT(*) n, SUM(x.amount) t FROM payments x JOIN users u ON u.id = x.professional_id WHERE x.paid_at IS NULL AND x.receiver = 'profissional' AND x.origin IN ('sessao','falta') AND x.due_date <= CURDATE() ${sc} GROUP BY u.id ORDER BY t DESC`, params),
    };
  } else {
    fech = { byMethod: [], pend: null, conf: await q("SELECT COUNT(*) n, SUM(amount) t FROM payments WHERE paid_at IS NULL AND receiver = 'profissional' AND professional_id = ? AND origin IN ('sessao','falta') AND due_date <= CURDATE()", [req.user.id]) };
  }

  send(res, page(req, {
    title: 'Recepção', active: 'recepcao',
    body: html`<header class="ph"><div><p class="eyebrow">${brDate(todayLocal())} · ${own ? 'Meu dia' : prof ? `Fila de ${proName(pros.find((u) => u.id === prof) || { name: '' })}` : 'Todas as filas'}</p><h1>Recepção — Hoje</h1></div>
      <div class="ph-actions">${!own ? html`<form method="get" class="rc-filter"><select name="prof" data-autosubmit aria-label="Profissional"><option value="">Todos os profissionais</option>${pros.map((u) => html`<option value="${u.id}" ${u.id === prof ? raw('selected') : ''}>${proName(u)}</option>`)}</select><noscript><button class="btn ghost">Filtrar</button></noscript></form>` : ''}
        <a class="btn ghost" href="/recepcao/fila">Fila de atendimento</a><a class="btn ghost" href="/agenda?v=dia">Agenda do dia</a></div></header>
    <section class="kpis rc-kpis">
      <div class="kpi"><span>Aguardando agora</span><b>${stats.waiting}</b>${longWait.length ? html`<small class="neg">${longWait.length} há mais de ${cfg.waitAlertMin} min</small>` : html`<small>ninguém esperando demais</small>`}</div>
      <div class="kpi"><span>Espera média hoje</span><b>${stats.avgWaitMin === null ? '—' : `${stats.avgWaitMin} min`}</b><small>da chegada ao início</small></div>
      <div class="kpi"><span>Em atendimento</span><b>${stats.inProgress}</b><small>${byPro.length ? byPro.map((x) => `${(x.u.name || '').split(' ')[0]}: ${x.n}${x.w ? ` (+${x.w} na fila)` : ''}`).join(' · ') : 'nenhum agora'}</small></div>
      <div class="kpi"><span>Finalizados hoje</span><b>${stats.done}</b><small>${toReceive.length ? `${toReceive.length} com pagamento pendente` : 'pagamentos em dia'}</small></div>
    </section>
    <div class="rc-board">${COLS.map(([k, l]) => {
      const list = rows.filter((a) => (k === 'realizada' ? ['realizada', 'falta'].includes(a.status) : colOf(a.status) === k));
      return html`<section class="rc-col rc-${k}"><header><b>${l}</b><span class="kcount">${list.length}</span></header>${list.length ? list.map(card) : html`<p class="muted small">—</p>`}</section>`;
    })}</div>
    <section class="card rc-fech"><h2>Fechamento do dia</h2>
      ${fech.byMethod.length ? html`<table class="tbl"><thead><tr><th>Forma</th><th>Recebido por</th><th>Lançamentos</th><th>Total</th></tr></thead><tbody>${fech.byMethod.map((m) => html`<tr><td>${label(m.method || 'outro')}</td><td>${m.receiver === 'clinica' ? 'Clínica' : 'Profissional'}</td><td>${m.n}</td><td>${money(m.total)}</td></tr>`)}</tbody></table>
        <p><b>Total recebido hoje: ${money(fech.byMethod.reduce((s, m) => s + Number(m.total), 0))}</b></p>` : (canFin ? html`<p class="muted">Nenhum recebimento registrado hoje.</p>` : '')}
      ${fech.pend ? html`<p>A receber na clínica (sessões de hoje): <b>${money(fech.pend.t)}</b> em ${fech.pend.n} sessão(ões).</p>` : ''}
      ${fech.conf.filter((c) => Number(c.n)).length ? html`<p>Aguardando confirmação do profissional: ${fech.conf.filter((c) => Number(c.n)).map((c) => html`<span class="badge b-confirmada">${c.name ? `${proName(c)}: ` : ''}${c.n} · ${money(c.t)}</span> `)}</p>` : ''}
      <p class="muted small">Regras atuais: pagamento definido ${Flow.PAY_MOMENTS[cfg.payMoment].toLowerCase()} · lembrete ${cfg.reminder === 'auto' ? `automático ${Flow.reminderText(cfg)} após a sessão` : cfg.reminder === 'botao' ? 'pelo botão' : 'desligado'} · alerta de espera com ${cfg.waitAlertMin} min.${can(req.user, 'usuarios') ? html` <a class="link" href="/configuracoes/atendimento">Alterar</a>` : ''}</p>
    </section>`,
  }));
});

// =====================================================================
// Fila de atendimento (para o profissional ver quem já chegou) e faixa “Em atendimento” na ficha do paciente
// =====================================================================
const minsSince = (dt) => (dt ? Math.max(0, Math.floor((Date.parse(nowLocal().replace(' ', 'T')) - Date.parse(String(dt).replace(' ', 'T'))) / 60000)) : 0);
const minsUntil = (dt) => Math.round((Date.parse(String(dt).replace(' ', 'T')) - Date.parse(nowLocal().replace(' ', 'T'))) / 60000);
// Situação de chegada de cada sessão, em palavras
function arrival(a) {
  const tele = a.modality === 'online' && Tele.presence(a.id).pac;
  if (a.status === 'em_atendimento') return { k: 'atendendo', t: `Em atendimento há ${minsSince(a.started_at)} min`, since: a.started_at, tpl: 'Em atendimento há {m} min' };
  if (a.status === 'realizada') return { k: 'fim', t: `Finalizado ${hm(a.finished_at)}` };
  if (a.status === 'falta') return { k: 'fim', t: 'Faltou' };
  if (a.status === 'aguardando') return { k: 'chegou', t: `Chegou ${hm(a.arrived_at)} · esperando ${minsSince(a.arrived_at)} min`, since: a.arrived_at, tpl: `Chegou ${hm(a.arrived_at)} · esperando {m} min` };
  if (tele) return { k: 'chegou', t: 'Na sala de espera on-line' };
  const m = minsUntil(a.starts_at);
  if (m < -5) return { k: 'atrasado', t: `Ainda não chegou · ${-m} min de atraso` };
  if (m <= 0) return { k: 'agora', t: 'Horário agora · ainda não chegou' };
  return { k: 'aguarda', t: m < 60 ? `Ainda não chegou · em ${m} min` : 'Ainda não chegou' };
}
const queueRows = (ownerId) => q(`SELECT a.*, p.name, p.social_name, p.owner_id, u.name pro, u.title pro_title FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = p.owner_id
  WHERE DATE(a.starts_at) = CURDATE() AND a.status <> 'cancelada' ${ownerId ? 'AND p.owner_id = ?' : ''} ORDER BY a.starts_at, a.id`, ownerId ? [ownerId] : []);
const startBtn = (a, back, label = '▶ Iniciar') => html`<form method="post" action="/recepcao/${a.id}/iniciar" class="inline"><input type="hidden" name="back" value="${back}"><button class="btn sm">${label}</button></form>`;
const arrivedBtn = (a, back) => html`<form method="post" action="/recepcao/${a.id}/chegou" class="inline"><input type="hidden" name="back" value="${back}"><button class="btn ghost sm">✓ Chegou</button></form>`;

r.get('/fila', async (req, res) => {
  const own = ownOnly(req.user);
  const pros = own ? [] : await q("SELECT id, name, title FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY name");
  const prof = own ? req.user.id : int(req.query.prof) || (pros.some((u) => u.id === req.user.id) ? req.user.id : null);
  const rows = await queueRows(prof);
  const tvc = await TV.config();
  const B = `/recepcao/fila${prof && !own ? `?prof=${prof}` : ''}`;
  const groups = [
    ['atendendo', 'Em atendimento', rows.filter((a) => a.status === 'em_atendimento')],
    ['chegou', 'Chegaram — aguardando', rows.filter((a) => a.status === 'aguardando' || (['agendada', 'confirmada'].includes(a.status) && arrival(a).k === 'chegou'))],
    ['aguarda', 'Ainda não chegaram', rows.filter((a) => ['agendada', 'confirmada'].includes(a.status) && arrival(a).k !== 'chegou')],
    ['fim', 'Finalizados hoje', rows.filter((a) => ['realizada', 'falta'].includes(a.status))],
  ];
  const canStart = (a) => a.owner_id === req.user.id || can(req.user, 'prontuario');
  const row = (a) => {
    const st = arrival(a);
    return html`<li class="fq-row fq-${st.k}" data-ctx="appt" data-id="${a.id}">
      <b class="fq-time">${hm(a.starts_at)}</b>
      <span class="fq-who"><a href="/pacientes/${a.patient_id}">${nm(a)}</a><small>${a.modality === 'online' ? 'on-line' : 'presencial'}${!prof && a.pro ? ` · ${proName({ name: a.pro, title: a.pro_title })}` : ''}${a.ticket ? ` · senha ${a.ticket}` : ''}</small></span>
      <span class="fq-st"><i aria-hidden="true"></i><span ${st.since ? raw(`data-since="${st.since}" data-tpl="${st.tpl}"`) : ''}>${st.t}</span></span>
      <span class="fq-act">
        ${['agendada', 'confirmada'].includes(a.status) && a.modality !== 'online' ? arrivedBtn(a, B) : ''}
        ${['agendada', 'confirmada', 'aguardando'].includes(a.status) && canStart(a) ? startBtn(a, B) : ''}
        ${a.status === 'aguardando' && tvc.enabled ? html`<form method="post" action="/recepcao/${a.id}/chamar" class="inline"><input type="hidden" name="back" value="${B}"><button class="btn ghost sm">📣 Chamar</button></form>` : ''}
        ${a.status === 'em_atendimento' && canStart(a) ? html`<a class="btn ghost sm" href="/pacientes/${a.patient_id}/sessao?a=${a.id}">Abrir a sessão</a>` : ''}
      </span></li>`;
  };
  const waiting = groups[1][2].length;
  send(res, page(req, {
    title: 'Fila de atendimento', active: 'recepcao',
    body: html`<header class="ph"><div><p class="eyebrow">${brDate(todayLocal())} · ${prof ? proName((own ? req.user : pros.find((u) => u.id === prof)) || { name: '' }) : 'Todos os profissionais'}</p><h1>Fila de atendimento</h1>
        <p class="muted">${waiting ? `${waiting} paciente(s) já chegaram e estão aguardando.` : 'Ninguém aguardando agora.'} A tela se atualiza sozinha.</p></div>
      <div class="ph-actions">${!own ? html`<form method="get"><select name="prof" data-autosubmit aria-label="Profissional"><option value="">Todos os profissionais</option>${pros.map((u) => html`<option value="${u.id}" ${u.id === prof ? raw('selected') : ''}>${proName(u)}</option>`)}</select></form>` : ''}
        <a class="btn ghost" href="/recepcao">Recepção</a></div></header>
    ${groups.map(([k, l, list]) => (k === 'fim' ? html`<details class="card fq-group fq-g-${k}"><summary><b>${l}</b> <span class="kcount">${list.length}</span></summary>${list.length ? html`<ul class="fq-list">${list.map(row)}</ul>` : ''}</details>`
      : html`<section class="card fq-group fq-g-${k}"><h2>${l} <span class="kcount">${list.length}</span></h2>${list.length ? html`<ul class="fq-list">${list.map(row)}</ul>` : html`<p class="muted small">—</p>`}</section>`))}`,
  }));
});

// Faixa no topo da ficha do paciente: em atendimento (com finalizar) ou recém-finalizado, e os próximos da fila
export async function attendanceBanner(req, p) {
  if (!can(req.user, 'agenda')) return '';
  const cur = await one(`SELECT a.*, p.session_fee, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.patient_id = ? AND DATE(a.starts_at) = CURDATE()
    AND (a.status = 'em_atendimento' OR (a.status = 'realizada' AND a.finished_at >= DATE_SUB(?, INTERVAL 30 MINUTE))) ORDER BY a.status = 'em_atendimento' DESC, a.finished_at DESC LIMIT 1`, [p.id, nowLocal()]);
  if (!cur) return '';
  const back = `/pacientes/${p.id}?aba=prontuario`;
  const x = await payOf(cur.id);
  const canFin = can(req.user, 'financeiro');
  const unpaid = x && !x.paid_at;
  const canReceive = unpaid && (x.receiver === 'profissional' ? (x.professional_id === req.user.id || canFin) : canFin);
  const next = (await queueRows(cur.owner_id)).filter((a) => a.id !== cur.id && ['agendada', 'confirmada', 'aguardando'].includes(a.status)).slice(0, 3);
  const live = cur.status === 'em_atendimento';
  const telLink = live && cur.modality === 'online' ? Tele.staffLink(cur) : null;
  return html`<section class="att-bar ${live ? 'on' : 'done'}" id="atendimento" aria-live="polite">
    <div class="att-main">
      <span class="att-st"><i aria-hidden="true"></i><span ${live && cur.started_at ? raw(`data-since="${cur.started_at}" data-tpl="Em atendimento há {m} min"`) : ''}>${live ? `Em atendimento há ${minsSince(cur.started_at)} min` : `Atendimento finalizado às ${hm(cur.finished_at)}`}</span></span>
      <small>Sessão das ${hm(cur.starts_at)} · ${cur.modality === 'online' ? 'on-line' : 'presencial'}${cur.started_at ? ` · início ${hm(cur.started_at)}` : ''}</small>
    </div>
    <div class="att-act">
      ${telLink ? html`<a class="btn ghost sm" href="${telLink}" ${/^\//.test(telLink) ? '' : raw('target="_blank" rel="noopener"')}>Abrir a chamada</a>` : ''}
      ${live ? (canReceive ? html`<details class="rc-pop att-pop"><summary class="btn">■ Finalizar atendimento</summary><form method="post" action="/recepcao/${cur.id}/finalizar" class="rc-form"><input type="hidden" name="back" value="${back}">
          <p class="small">Pagamento de ${money(x.amount)} ${x.receiver === 'profissional' ? '(direto ao profissional)' : ''}</p>
          <label class="fld"><span>Já recebeu?</span><select name="received"><option value="nao">Ainda não</option><option value="sim">Sim</option></select></label>${methodSel()}
          <button class="btn sm">Finalizar</button></form></details>`
        : html`<form method="post" action="/recepcao/${cur.id}/finalizar" class="inline" data-confirm="Finalizar o atendimento de ${nm(p).split(' ')[0]}?"><input type="hidden" name="back" value="${back}"><button class="btn">■ Finalizar atendimento</button></form>`) : ''}
      <a class="btn ghost sm" href="/recepcao/fila">Fila de atendimento</a>
    </div>
    ${next.length ? html`<div class="att-next"><b>Próximos:</b>${next.map((a) => { const st = arrival(a); return html`<span class="att-n fq-${st.k}"><i aria-hidden="true"></i><a href="/pacientes/${a.patient_id}">${hm(a.starts_at)} ${nm(a).split(' ')[0]}</a> <small>${st.k === 'chegou' ? 'chegou' : st.k === 'atrasado' ? 'atrasado' : 'não chegou'}</small>${!live && ['aguardando', 'agendada', 'confirmada'].includes(a.status) && a === next[0] ? startBtn(a, back, '▶ Iniciar') : ''}</span>`; })}</div>` : ''}
  </section>`;
}

// ---------- ações ----------
async function pushArrival(a, userId) {
  if (a.owner_id && a.owner_id !== userId) notify(a.owner_id, { title: '🔔 Paciente chegou', body: `${nm(a).split(' ')[0]} chegou para a sessão das ${hm(a.starts_at)}.`, url: '/recepcao', tag: `chegou-${a.id}` });
}
r.post('/:id/chegou', async (req, res, next) => {
  const a = await loadAppt(req, int(req.params.id));
  if (!a) return next();
  if (!['agendada', 'confirmada'].includes(a.status)) return res.flash('Esta sessão já não está aguardando chegada.', 'warn').redirect(back(req));
  await Flow.setStatus(a.id, 'aguardando', req.user.id);
  const x = await payOf(a.id);
  const plan = req.body.plan;
  if (x && !x.paid_at) {
    if (plan === 'clinica' && can(req.user, 'financeiro')) await Fin.receive(x.id, { method: req.body.method, paidAt: todayLocal(), receiver: 'clinica', userId: req.user.id, detail: `Na chegada · ${label(req.body.method)}` });
    else if (plan === 'profissional') { await q("UPDATE payments SET receiver = 'profissional' WHERE id = ?", [x.id]); await Fin.logPay(x.id, 'direto', req.user.id, 'Informado na chegada'); }
    else if (plan === 'pendente' && x.receiver !== 'clinica') await q("UPDATE payments SET receiver = 'clinica' WHERE id = ?", [x.id]);
  }
  await pushArrival(a, req.user.id);
  await audit(req, 'recepcao-chegou', `appointment:${a.id} ${plan || ''}`);
  res.flash(`${nm(a).split(' ')[0]} na fila de espera.${plan === 'clinica' ? ' Pagamento registrado.' : ''}`).redirect(back(req));
});
// Chamar na TV (e chamar de novo)
r.post('/:id/chamar', async (req, res, next) => {
  const a = await loadAppt(req, int(req.params.id));
  if (!a) return next();
  const out = await TV.call(a.id, { roomId: int(req.body.room_id), userId: req.user.id });
  await audit(req, 'recepcao-chamar', `appointment:${a.id}`);
  if (!out.ok) return res.flash(out.error, 'err').redirect(back(req));
  res.flash(`Senha ${out.ticket} chamada na TV${out.room ? ` · ${out.room}` : ''}.`).redirect(back(req));
});
// Trocar o tipo da senha (ex.: virou prioridade): gera nova senha com o prefixo certo
r.post('/:id/senha', async (req, res, next) => {
  const a = await loadAppt(req, int(req.params.id));
  if (!a) return next();
  if (!TV.TYPES[req.body.type] || a.ticket_type === req.body.type) return res.redirect(back(req));
  const t = await TV.assign(a.id, req.body.type, { force: true });
  res.flash(`Nova senha: ${t}.`).redirect(back(req));
});
r.post('/:id/iniciar', async (req, res, next) => {
  const a = await loadAppt(req, int(req.params.id));
  if (!a) return next();
  if (!['agendada', 'confirmada', 'aguardando'].includes(a.status)) return res.redirect(back(req));
  await Flow.setStatus(a.id, 'em_atendimento', req.user.id);
  await audit(req, 'recepcao-iniciar', `appointment:${a.id}`);
  // quem atende vai direto para a tela da sessão (a recepção continua na fila); on-line na sala própria → sala de vídeo
  if (can(req.user, 'prontuario') && a.owner_id === req.user.id) {
    const link = a.modality === 'online' ? Tele.staffLink(a) : null;
    if (link && link.startsWith('/')) return res.redirect(`${link}?auto=1`);
    return res.redirect(`/pacientes/${a.patient_id}/sessao?a=${a.id}&auto=1`);
  }
  res.redirect(back(req));
});
// Pagamento da sessão informado pelo profissional na tela da sessão (Pago / Não pago), com as mesmas regras da recepção:
// pagamento direto ao profissional é confirmado por ele; na clínica, por quem tem o financeiro; o profissional sem o
// financeiro que diz “Pago” recebeu direto (passa a ser “direto ao profissional”, como na chegada).
async function payJson(req, a) {
  const x = await payOf(a.id);
  if (!x) return { pay: null, ask: false, info: a.package_id ? 'Sessão de pacote: nada a cobrar agora.' : a.plan_id ? 'Sessão pelo convênio: o valor vem da operadora.' : !Number(a.session_fee) ? 'Sem valor da sessão na ficha: nada a cobrar.' : '' };
  const canAct = x.receiver === 'profissional' ? (x.professional_id === req.user.id || can(req.user, 'financeiro')) : (can(req.user, 'financeiro') || x.professional_id === req.user.id);
  return { pay: { id: x.id, amount: Number(x.amount), amountText: money(x.amount), receiver: x.receiver, paid: !!x.paid_at, method: x.method ? label(x.method) : '' }, ask: !x.paid_at && canAct };
}
r.post('/:id/pagamento', express.json(), async (req, res) => {
  const a = await loadAppt(req, int(req.params.id));
  if (!a) return res.status(404).json({ ok: false, error: 'Sessão não encontrada.' });
  const x = await payOf(a.id);
  if (!x) return res.json({ ok: true, message: 'Nada a cobrar nesta sessão.' });
  if (x.paid_at) return res.json({ ok: true, message: 'Este pagamento já estava registrado.' });
  if (req.body?.pago !== 'sim') {
    await Fin.logPay(x.id, 'pendente', req.user.id, 'Informado ao finalizar a sessão: não pago');
    await audit(req, 'sessao-pagamento', `appointment:${a.id} nao-pago`);
    return res.json({ ok: true, message: `Pagamento de ${money(x.amount)} ficou pendente. A recepção e os lembretes seguem as regras de cobrança.` });
  }
  const method = Fin.METHODS.includes(req.body?.method) ? req.body.method : 'pix';
  let out;
  if (x.receiver === 'clinica' && can(req.user, 'financeiro')) out = await Fin.receive(x.id, { method, paidAt: todayLocal(), receiver: 'clinica', userId: req.user.id, detail: `Ao finalizar a sessão · ${label(method)}` });
  else if (x.receiver === 'profissional' ? (x.professional_id === req.user.id || can(req.user, 'financeiro')) : x.professional_id === req.user.id) {
    if (x.receiver !== 'profissional') { await q("UPDATE payments SET receiver = 'profissional' WHERE id = ?", [x.id]); await Fin.logPay(x.id, 'direto', req.user.id, 'Pago ao profissional (informado ao finalizar a sessão)'); }
    out = await Fin.receive(x.id, { method, paidAt: todayLocal(), receiver: 'profissional', userId: req.user.id, action: 'confirmado', detail: `Ao finalizar a sessão · ${label(method)}` });
  } else return res.status(403).json({ ok: false, error: 'Seu perfil não registra este recebimento. A recepção registra.' });
  await audit(req, 'sessao-pagamento', `appointment:${a.id} pago ${method}`);
  res.status(out.ok ? 200 : 400).json(out.ok ? { ok: true, message: `Pagamento de ${money(x.amount)} registrado (${label(method)}).` } : { ok: false, error: out.error });
});
r.post('/:id/finalizar', async (req, res, next) => {
  const wantsJson = (req.get('accept') || '').includes('json');
  const a = await loadAppt(req, int(req.params.id));
  if (!a) return wantsJson ? res.status(404).json({ ok: false, error: 'Sessão não encontrada.' }) : next();
  if (!['aguardando', 'em_atendimento'].includes(a.status)) return wantsJson ? res.json({ ok: true, already: a.status === 'realizada', ...(await payJson(req, a)) }) : res.redirect(back(req));
  await Flow.setStatus(a.id, 'realizada', req.user.id);
  if (wantsJson) { await audit(req, 'recepcao-finalizar', `appointment:${a.id} sessao`); return res.json({ ok: true, ...(await payJson(req, a)) }); }
  const x = await payOf(a.id);
  let msg = 'Sessão finalizada.';
  if (x && !x.paid_at && req.body.received === 'sim') {
    const isConfirm = x.receiver === 'profissional';
    if (isConfirm ? (x.professional_id === req.user.id || can(req.user, 'financeiro')) : can(req.user, 'financeiro')) {
      await Fin.receive(x.id, { method: req.body.method, paidAt: todayLocal(), userId: req.user.id, action: isConfirm ? 'confirmado' : 'recebido', detail: `Ao finalizar · ${label(req.body.method)}` });
      msg += ' Pagamento registrado.';
    }
  } else if (x && !x.paid_at) msg += ' Pagamento ficou pendente.';
  await audit(req, 'recepcao-finalizar', `appointment:${a.id}`);
  res.flash(msg).redirect(back(req));
});
r.post('/:id/falta', async (req, res, next) => {
  const a = await loadAppt(req, int(req.params.id));
  if (!a) return next();
  await Flow.setStatus(a.id, 'falta', req.user.id);
  await audit(req, 'recepcao-falta', `appointment:${a.id}`);
  res.flash(`Falta registrada para ${nm(a).split(' ')[0]}.`).redirect(back(req));
});

async function loadPay(req, id) {
  const x = await one('SELECT x.*, p.owner_id FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ?', [id]);
  if (!x) return null;
  if (!can(req.user, 'financeiro') && x.professional_id !== req.user.id) throw forbidden();
  return x;
}
r.post('/pag/:pid/receber', async (req, res, next) => {
  const x = await loadPay(req, int(req.params.pid));
  if (!x) return next();
  if (!can(req.user, 'financeiro')) throw forbidden();
  const out = await Fin.receive(x.id, { method: req.body.method, paidAt: todayLocal(), receiver: 'clinica', userId: req.user.id, detail: `Recepção · ${label(req.body.method)}` });
  await audit(req, 'recepcao-receber', `payment:${x.id}`);
  res.flash(out.ok ? 'Recebimento registrado.' : out.error, out.ok ? 'ok' : 'warn').redirect(back(req));
});
r.post('/pag/:pid/confirmar', async (req, res, next) => {
  const x = await loadPay(req, int(req.params.pid));
  if (!x) return next();
  const out = await Fin.receive(x.id, { method: req.body.method, paidAt: todayLocal(), receiver: 'profissional', userId: req.user.id, action: 'confirmado', detail: label(req.body.method) });
  await audit(req, 'recepcao-confirmar', `payment:${x.id}`);
  res.flash(out.ok ? 'Recebimento confirmado.' : out.error, out.ok ? 'ok' : 'warn').redirect(back(req));
});
r.post('/pag/:pid/lembrete', async (req, res, next) => {
  const x = await loadPay(req, int(req.params.pid));
  if (!x) return next();
  const out = await WA.sendCharge(x.id, req.user.id);
  await audit(req, 'recepcao-lembrete', `payment:${x.id}`);
  res.flash(out.ok ? 'Lembrete de pagamento enviado pelo WhatsApp.' : `Não enviado: ${out.error}`, out.ok ? 'ok' : 'err').redirect(back(req));
});

// ---------- Configurações → Recepção e atendimento ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const c = await Flow.config();
  const radios = (name, opts, cur) => Object.entries(opts).map(([k, l]) => html`<label class="maint-g"><input type="radio" name="${name}" value="${k}" ${cur === k ? raw('checked') : ''}><span><b>${l}</b></span></label>`);
  send(res, page(req, {
    title: 'Recepção e atendimento', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Recepção e atendimento</h1><p class="muted">Regras do fluxo Agendado → Aguardando → Em atendimento → Finalizado → Pagamento.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <h2>Quando perguntar sobre o pagamento</h2><div class="bk-mode">${radios('payMoment', Flow.PAY_MOMENTS, c.payMoment)}</div>
      <p class="muted small">Na chegada: a recepção escolhe “pago na clínica”, “direto ao profissional” ou “a receber”. Quando o pagamento é direto ao profissional, ele confirma ao finalizar a sessão ou depois, no próprio painel.</p>
      <h2>Lembrete de pagamento pendente (WhatsApp, com Pix)</h2><div class="bk-mode">${radios('reminder', Flow.REMINDERS, c.reminder)}</div>
      <div class="fld bk-hour rc-delay"><span>Enviar automático depois de</span><div><input type="number" name="reminderDelay" min="1" max="1440" value="${c.reminderDelay}" aria-label="Tempo"><select name="reminderUnit" aria-label="Unidade"><option value="min" ${c.reminderUnit === 'min' ? raw('selected') : ''}>minutos</option><option value="h" ${c.reminderUnit !== 'min' ? raw('selected') : ''}>horas</option></select></div></div>
      <p class="muted small">O automático sai uma única vez por sessão, entre 8h e 20h, só para pacientes que autorizaram WhatsApp.</p>
      <h2>Alerta de espera</h2>
      <label class="fld bk-hour"><span>Avisar quando o paciente esperar mais de (minutos)</span><input type="number" name="waitAlertMin" min="5" max="120" value="${c.waitAlertMin}"></label>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>`,
  }));
});
settings.post('/', async (req, res) => {
  await Flow.saveConfig(req.body);
  await audit(req, 'config-atendimento');
  res.flash('Regras de atendimento salvas.').redirect('/configuracoes/atendimento');
});

export default r;
