import * as Brand from '../lib/brand.js';
import express from 'express';
import * as Notify from '../lib/notify.js';
import { apptCard as notifyCard } from './notify.js';
import { q, one, audit } from '../lib/db.js';
import { page, agendaTabs, html, raw, badge, brDate, brDateTime, label, weekday, waLink, money } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { syncAppointment, syncLater, googleBusy, busyBlocks } from '../lib/google.js';
import * as WA from '../lib/whatsapp.js';
import * as SC from '../lib/schedule.js';
import * as PUSH from '../lib/push.js';
import * as CRM from '../lib/crm.js';
import * as Fin from '../lib/fin.js';
import * as Flow from '../lib/flow.js';
import * as Waitlist from '../lib/waitlist.js';
import * as Tele from '../lib/tele.js';
import * as Ins from '../lib/insurance.js';
import { apptCard as insuranceCard } from './insurance.js';
import { can, patientScope, canSeePatient, forbidden, ownOnly, proName } from '../lib/perm.js';
import { todayLocal, addDays, startOfWeek, addMinutes, isYmd, isHm, longDate } from '../lib/time.js';

const r = router();
const nm = (p) => p.social_name || p.name;
const STATUSES = ['agendada', 'confirmada', 'aguardando', 'em_atendimento', 'realizada', 'falta', 'cancelada'];

// Situação do WhatsApp da sessão (lembrete enviado, confirmou, pediu para remarcar).
function waStatus(a) {
  if (a.wa_reply === 'remarcar' && !a.wa_reschedule_done) return html`<span class="wa-tag warn">↻ Pediu para remarcar</span>`;
  if (a.wa_reply === 'confirmou') return html`<span class="wa-tag ok">✓ Confirmou ${a.reply_channel === 'link' ? 'pelo link do lembrete' : 'pelo WhatsApp'}</span>`;
  if (a.wa_reminder_at && ['agendada', 'confirmada'].includes(a.status)) return html`<span class="wa-tag">Lembrete enviado</span>`;
  return '';
}

r.param('id', async (req, res, next, id) => {
  try {
    const a = await one('SELECT p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [int(id)]);
    if (a && !canSeePatient(req.user, a)) return next(forbidden());
    next();
  } catch (e) { next(e); }
});

function reminder(a) {
  const first = nm(a).split(' ')[0];
  const when = `${weekday(a.starts_at)}, ${brDate(a.starts_at)}, às ${a.starts_at.slice(11, 16)}`;
  const where = a.modality === 'online' ? `on-line${a.meeting_link ? ` (link: ${a.meeting_link})` : ''}` : 'presencial';
  return waLink(a.phone, `Olá, ${first}! Passando para lembrar da nossa sessão ${where} na ${when}. Pode me confirmar, por favor? — ${Brand.get().proName || Brand.get().short}${Brand.get().proRole ? `, ${Brand.get().proRole}` : ''}`);
}

// ---------- visões: dia / semana / mês ----------
const VIEWS = ['dia', 'semana', 'mes'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const DIAS_CURTOS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const mins = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const hhmm = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
const firstOfMonth = (d) => `${d.slice(0, 7)}-01`;
const addMonthsYmd = (d, n) => { const dt = new Date(`${d.slice(0, 7)}-01T12:00:00Z`); dt.setUTCMonth(dt.getUTCMonth() + n); return dt.toISOString().slice(0, 10); };
const viewCookie = (req) => (/(?:^|;\s*)agenda_v=(dia|semana|mes)(?:;|$)/.exec(req.headers.cookie || '') || [])[1];

// Sessões + folgas/bloqueios de um intervalo de dias
// Cor fixa de cada profissional (pela ordem do cadastro)
const PRO_COLORS = ['#9c4422', '#3b5670', '#4f6b3a', '#7a4f8a', '#b7865a', '#2f7d7a', '#a3341f', '#5b6b8c'];
export const proColor = (id) => PRO_COLORS[(Number(id) || 0) % PRO_COLORS.length];
async function loadRange(req, start, end, profSel = null) {
  const sc0 = patientScope(req.user);
  const sc = profSel && !ownOnly(req.user) ? { sql: `${sc0.sql} AND p.owner_id = ? `, params: [...sc0.params, profSel] } : sc0;
  const rows = await q(`SELECT a.*, p.name, p.social_name, p.phone, p.owner_id, p.whatsapp_optin, u.name prof,
      (SELECT x.id FROM payments x WHERE x.appointment_id = a.id ORDER BY x.id DESC LIMIT 1) pay_id,
      (SELECT x.paid_at IS NOT NULL FROM payments x WHERE x.appointment_id = a.id ORDER BY x.id DESC LIMIT 1) pay_paid FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = p.owner_id
    WHERE a.starts_at >= ? AND a.starts_at < ? ${sc.sql} ORDER BY a.starts_at`, [start, end, ...sc.params]);
  const allPros = ownOnly(req.user) ? [{ id: req.user.id, name: req.user.name, title: req.user.title }] : await q("SELECT id, name, title FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY name");
  const pros = profSel && !ownOnly(req.user) ? allPros.filter((u) => u.id === profSel) : allPros;
  const showProf = pros.length > 1 && new Set(rows.map((x) => x.owner_id)).size > 1;
  const offs = {}; const offIds = {}; const hours = {};
  for (const u of pros) {
    const sch = await SC.getSchedule(u.id);
    for (let d = start; d < end; d = addDays(d, 1)) {
      const st = await SC.dayStatus(u.id, d, sch);
      if (!st.works) {
        (offIds[d] ||= new Set()).add(u.id);
        (offs[d] ||= []).push({ owner: u.id, name: pros.length > 1 ? u.name.split(' ')[0] : '', text: st.blocked ? (st.reason || 'Bloqueado') : 'Folga', blocked: st.blocked });
      } else if (!st.unrestricted) for (const b of (st.blocks?.length ? st.blocks : [st])) (hours[d] ||= []).push({ start: b.start, end: b.end, owner: u.id }); // manhã/tarde/noite
    }
  }
  // Compromissos pessoais da Google Agenda (só horários, sem detalhes). Se o Google demorar, a agenda abre sem eles.
  const withTimeout = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok([]), 3500))]);
  const gb = (await Promise.all(pros.map((u) => withTimeout(busyBlocks(u.id, `${start} 00:00:00`, `${end} 00:00:00`))))).flat()
    .map((b) => ({ ...b, prof: pros.length > 1 ? (pros.find((u) => u.id === b.owner)?.name || '').split(' ')[0] : '' }));
  return { rows, showProf, offs, offIds, hours, gbusy: gb, pros, allPros };
}
// Blocos “Ocupado (Google)” de um dia (eventos de dia inteiro viram uma faixa no topo)
const dayBusy = (ctx, d) => (ctx.gbusy || []).filter((b) => b.start < `${addDays(d, 1)} 00:00:00` && b.end > `${d} 00:00:00`);
const busyLabel = (b, d) => (b.allDay ? 'Dia todo' : `${b.start.slice(0, 10) < d ? '00:00' : b.start.slice(11, 16)}–${b.end.slice(0, 10) > d ? '24:00' : b.end.slice(11, 16)}`);
const busyChip = (b, d) => html`<div class="gbusy" title="Compromisso na Google Agenda${b.prof ? ` de ${b.prof}` : ''} (detalhes ocultos)"><b>${busyLabel(b, d)}</b> <span>Ocupado (Google)${b.prof ? ` · ${b.prof}` : ''}</span></div>`;

// Atributos do menu de contexto (botão direito / segurar) e do arrastar para remarcar.
const movable = (a) => ['agendada', 'confirmada'].includes(a.status);
const waDigits = (phone) => { const d = WA.normalizePhone(phone); return d || ''; };
const ctxData = (a) => html`data-ctx="appt" data-prof="${a.owner_id || ''}" data-id="${a.id}" data-st="${a.status}" data-pid="${a.patient_id}" data-name="${nm(a)}" data-when="${a.starts_at.slice(0, 16)}" data-dur="${a.duration_min}" data-phone="${waDigits(a.phone)}" data-optin="${a.whatsapp_optin ? 1 : 0}" data-link="${a.meeting_link || ''}" data-pay="${a.pay_id || ''}" data-paid="${a.pay_paid ? 1 : 0}" ${movable(a) ? raw('draggable="true" data-move="1"') : ''}`;

const offTags = (list) => (list || []).map((o) => html`<span class="off-tag ${o.blocked ? 'blk' : ''}">${o.blocked ? '⊘' : '☾'} ${o.name ? `${o.name}: ` : ''}${o.text}</span>`);

function apptCard(a, ctx, back) {
  const wa = reminder(a);
  return html`<article class="appt s-${a.status}" ${ctxData(a)} style="--pro:${proColor(a.owner_id)}">
    <button type="button" class="ctx-btn" data-ctx-open aria-label="Mais ações">⋯</button>
    <a href="/agenda/${a.id}" class="appt-main" draggable="false"><b>${a.starts_at.slice(11, 16)}–${addMinutes(a.starts_at, a.duration_min).slice(11, 16)}</b><span>${nm(a)}</span><small>${label(a.modality)}${ctx.showProf && a.prof ? ` · ${a.prof.split(' ')[0]}` : ''}</small></a>
    ${['agendada', 'confirmada'].includes(a.status) && ctx.offIds[a.starts_at.slice(0, 10)]?.has(a.owner_id) ? html`<span class="wa-tag warn" title="O(a) profissional está de folga ou com o dia bloqueado — remarque">⚠ Fora da escala</span>` : ''}
    ${waStatus(a)}
    <div class="appt-actions">${badge(a.status)}
      ${['agendada', 'confirmada'].includes(a.status) ? html`
      <form method="post" action="/agenda/${a.id}/status"><input type="hidden" name="status" value="realizada"><input type="hidden" name="back" value="${back}"><button class="chip" title="Marcar como realizada">✓ Realizada</button></form>
      ${ctx.waOn && !a.wa_reminder_at ? html`<form method="post" action="/agenda/${a.id}/whatsapp"><input type="hidden" name="back" value="${back}"><button class="chip" title="Enviar lembrete automático pelo WhatsApp">Lembrete</button></form>`
        : !ctx.waOn && wa ? html`<a class="chip" href="${wa}" target="_blank" rel="noopener" title="Enviar lembrete pelo WhatsApp">Lembrete</a>` : ''}` : ''}
    </div></article>`;
}

// Grade de horários do dia: cada sessão posicionada pela hora e com altura pela duração.
// Contexto só de um(a) profissional (colunas da visão Dia com todos)
const ctxFor = (ctx, prof) => ({ ...ctx, rows: ctx.rows.filter((a) => a.owner_id === prof), gbusy: (ctx.gbusy || []).filter((b) => b.owner === prof),
  hours: Object.fromEntries(Object.entries(ctx.hours).map(([k, v]) => [k, v.filter((h) => h.owner === prof)])), showProf: false });
function dayGrid(d, ctxIn, today, opts = {}) {
  const ctx = opts.prof ? ctxFor(ctxIn, opts.prof) : ctxIn;
  const list = ctx.rows.filter((a) => a.starts_at.slice(0, 10) === d && a.status !== 'cancelada');
  let from = 8 * 60; let to = 20 * 60;
  for (const h of ctx.hours[d] || []) { from = Math.min(from, mins(h.start)); to = Math.max(to, mins(h.end)); }
  for (const a of list) { const s = mins(a.starts_at.slice(11, 16)); from = Math.min(from, s); to = Math.max(to, Math.min(24 * 60, s + a.duration_min)); }
  const busy = dayBusy(ctx, d).filter((b) => !b.allDay).map((b) => ({ b, s: b.start.slice(0, 10) < d ? 0 : mins(b.start.slice(11, 16)), e: b.end.slice(0, 10) > d ? 24 * 60 : mins(b.end.slice(11, 16)) }));
  for (const x of busy) { from = Math.min(from, x.s); to = Math.max(to, x.e); }
  from = Math.floor(from / 60) * 60; to = Math.ceil(to / 60) * 60;
  if (opts.range) [from, to] = opts.range; // colunas alinhadas no mesmo intervalo
  if (opts.rangeOnly) return [from, to];
  const PX = 1.4; // pixels por minuto
  // colunas para sessões sobrepostas
  const lanes = []; const place = list.map((a) => {
    const s = mins(a.starts_at.slice(11, 16)); const e = s + a.duration_min;
    let lane = lanes.findIndex((end) => end <= s); if (lane < 0) { lane = lanes.length; lanes.push(e); } else lanes[lane] = e;
    return { a, s, e, lane };
  });
  const nLanes = Math.max(1, lanes.length);
  const now = mins(new Date(Date.now() - 3 * 3600e3).toISOString().slice(11, 16));
  const work = (ctx.hours[d] || []).map((h) => ({ top: (mins(h.start) - from) * PX, h: (mins(h.end) - mins(h.start)) * PX }));
  return html`<div class="dgrid" style="height:${(to - from) * PX}px" data-slot-day="${d}" data-from="${from}" data-px="${PX}" ${opts.prof ? raw(`data-prof="${opts.prof}"`) : ''}>
    ${work.map((w) => html`<div class="dg-work" style="top:${w.top}px;height:${w.h}px" title="Horário de atendimento"></div>`)}
    ${Array.from({ length: (to - from) / 60 + 1 }, (_, i) => html`<div class="dg-hour" style="top:${i * 60 * PX}px"><span>${hhmm(from + i * 60)}</span></div>`)}
    ${busy.map(({ b, s, e }) => html`<div class="dg-busy" style="top:${(s - from) * PX}px;height:${Math.max(18, (e - s) * PX - 2)}px" title="Compromisso na Google Agenda${b.prof ? ` de ${b.prof}` : ''} (detalhes ocultos)"><span>${hhmm(s)}–${hhmm(e)} · Ocupado (Google)${b.prof ? ` · ${b.prof}` : ''}</span></div>`)}
    ${place.map(({ a, s, e, lane }) => html`<a href="/agenda/${a.id}" class="dg-ev s-${a.status}" ${ctxData(a)} style="--pro:${proColor(a.owner_id)};top:${(s - from) * PX}px;height:${Math.max(24, (e - s) * PX - 2)}px;left:calc(56px + (100% - 60px) * ${lane / nLanes});width:calc((100% - 60px) / ${nLanes} - 4px)">
      <b>${a.starts_at.slice(11, 16)}–${hhmm(e)}</b> <span>${nm(a)}</span><small>${label(a.modality)}${ctx.showProf && a.prof ? ` · ${a.prof.split(' ')[0]}` : ''}</small></a>`)}
    ${d === today && now >= from && now <= to ? html`<div class="dg-now" style="top:${(now - from) * PX}px" title="Agora"></div>` : ''}
  </div>`;
}

r.get('/', async (req, res) => {
  const legacyWeek = isYmd(req.query.semana) ? req.query.semana : null;
  const view = VIEWS.includes(req.query.v) ? req.query.v : legacyWeek ? 'semana' : (viewCookie(req) || 'semana');
  if (VIEWS.includes(req.query.v)) res.append('Set-Cookie', `agenda_v=${view}; Path=/; Max-Age=31536000; SameSite=Lax`);
  const today = todayLocal();
  const ref = isYmd(req.query.d) ? req.query.d : legacyWeek || today;
  const waOn = WA.ready(await WA.config());
  const url = (v, d) => `/agenda?v=${v}&d=${d}`;
  // Profissional selecionado (Todos ou um só); a escolha fica lembrada neste navegador
  let profSel = null;
  if (!ownOnly(req.user)) {
    const qp = req.query.prof; const ck = (/(?:^|;\s*)agenda_prof=(\d+|todos)(?:;|$)/.exec(req.headers.cookie || '') || [])[1];
    const v = qp !== undefined ? String(qp) : ck || 'todos';
    profSel = /^\d+$/.test(v) ? Number(v) : null;
    if (qp !== undefined) res.append('Set-Cookie', `agenda_prof=${profSel || 'todos'}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }

  let start; let end; let title; let prev; let next; let body;
  if (view === 'dia') {
    start = ref; end = addDays(ref, 1);
    title = `${weekday(ref)}, ${brDate(ref)}`; prev = url('dia', addDays(ref, -1)); next = url('dia', addDays(ref, 1));
  } else if (view === 'mes') {
    const m1 = firstOfMonth(ref); start = startOfWeek(m1);
    const mEnd = addMonthsYmd(m1, 1); end = addDays(startOfWeek(addDays(mEnd, -1)), 7);
    title = `${MESES[Number(m1.slice(5, 7)) - 1]} de ${m1.slice(0, 4)}`; prev = url('mes', addMonthsYmd(m1, -1)); next = url('mes', addMonthsYmd(m1, 1));
  } else {
    start = startOfWeek(ref); end = addDays(start, 7);
    title = `Semana de ${brDate(start)} a ${brDate(addDays(start, 6))}`; prev = url('semana', addDays(start, -7)); next = url('semana', addDays(start, 7));
  }
  const ctx = { ...(await loadRange(req, start, end, profSel)), waOn };
  if (profSel && !ctx.pros.length) profSel = null;
  const back = url(view, ref);

  if (view === 'dia') {
    const list = ctx.rows.filter((a) => a.starts_at.slice(0, 10) === ref);
    body = html`<div class="ag-day">
      ${ctx.pros.length > 1 ? (() => {
        // Todos os profissionais: uma coluna por profissional, no mesmo intervalo de horas
        const rs = ctx.pros.map((u) => dayGrid(ref, ctx, today, { prof: u.id, rangeOnly: true }));
        const range = [Math.min(...rs.map((x) => x[0])), Math.max(...rs.map((x) => x[1]))];
        return html`<section class="card ag-grid-card ag-multi" style="--cols:${ctx.pros.length}">${ctx.pros.map((u) => html`<div class="ag-col">
          <div class="ag-col-top"><a class="ag-col-h" href="/agenda?v=dia&d=${ref}&prof=${u.id}" title="Ver só a agenda de ${proName(u)}"><i class="pro-dot" style="background:${proColor(u.id)}"></i>${proName(u)}<small>${ctx.rows.filter((a) => a.owner_id === u.id && a.starts_at.slice(0, 10) === ref && a.status !== 'cancelada').length} sessão(ões)</small></a>
          ${offTags((ctx.offs[ref] || []).filter((o) => o.owner === u.id))}${dayBusy(ctxFor(ctx, u.id), ref).filter((b) => b.allDay).map((b) => busyChip(b, ref))}</div>
          ${dayGrid(ref, ctx, today, { prof: u.id, range })}</div>`)}</section>`;
      })() : html`<section class="card ag-grid-card">${offTags(ctx.offs[ref])}${dayBusy(ctx, ref).filter((b) => b.allDay).map((b) => busyChip(b, ref))}${dayGrid(ref, ctx, today)}</section>`}
      <aside class="ag-day-list"><h2>${list.length ? `${list.length} sessão(ões)` : 'Dia livre'}</h2>
        ${list.length ? list.map((a) => apptCard(a, ctx, back)) : html`<p class="muted small">Nenhuma sessão neste dia.</p>`}
        <a class="btn ghost" href="/agenda/nova?data=${ref}">+ Agendar neste dia</a></aside>
    </div>`;
  } else if (view === 'mes') {
    const month = firstOfMonth(ref).slice(0, 7);
    const days = []; for (let d = start; d < end; d = addDays(d, 1)) days.push(d);
    body = html`<div class="ag-month">
      ${DIAS_CURTOS.map((x) => html`<span class="am-w">${x}</span>`)}
      ${days.map((d) => {
        const list = ctx.rows.filter((a) => a.starts_at.slice(0, 10) === d && a.status !== 'cancelada');
        const off = ctx.offs[d] || [];
        return html`<div class="am-cell ${d.slice(0, 7) !== month ? 'out' : ''} ${d === today ? 'today' : ''} ${off.length && !list.length ? 'off' : ''}" data-slot-day="${d}" data-drop-day="${d}">
          <a class="am-num" href="${url('dia', d)}" title="Ver o dia">${Number(d.slice(8))}</a>
          ${off.length ? html`<span class="am-off" title="${off.map((o) => `${o.name ? `${o.name}: ` : ''}${o.text}`).join(' · ')}">${off.some((o) => o.blocked) ? '⊘' : '☾'}</span>` : ''}
          <div class="am-evs">${list.slice(0, 3).map((a) => html`<a href="/agenda/${a.id}" class="am-ev s-${a.status}" ${ctxData(a)} style="--pro:${proColor(a.owner_id)}" title="${a.starts_at.slice(11, 16)} ${nm(a)} · ${label(a.status)}"><b>${a.starts_at.slice(11, 16)}</b> ${nm(a).split(' ')[0]}</a>`)}
            ${list.length > 3 ? html`<a class="am-more" href="${url('dia', d)}">+${list.length - 3} mais</a>` : ''}
            ${(() => { const bz = dayBusy(ctx, d); return bz.length ? html`<span class="am-busy" title="Compromissos na Google Agenda (detalhes ocultos)">${bz[0].allDay ? 'Dia todo' : busyLabel(bz[0], d).slice(0, 5)} ocupado${bz.length > 1 ? ` +${bz.length - 1}` : ''}</span>` : ''; })()}</div>
          ${list.length ? html`<a class="am-count" href="${url('dia', d)}">${list.length}</a>` : ''}
        </div>`;
      })}
    </div>`;
  } else {
    const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
    body = html`<div class="week">
      ${days.map((d) => {
        const list = ctx.rows.filter((a) => a.starts_at.slice(0, 10) === d);
        return html`<section class="day ${d === today ? 'today' : ''}" data-slot-day="${d}" data-drop-day="${d}">
          <h3><a href="${url('dia', d)}" title="Ver o dia"><span>${weekday(d)}</span><b>${d.slice(8, 10)}/${d.slice(5, 7)}</b></a></h3>
          ${offTags(ctx.offs[d])}
          ${(() => {
            const items = [...list.map((a) => ({ t: a.starts_at.slice(11, 16), h: apptCard(a, ctx, back) })), ...dayBusy(ctx, d).map((b) => ({ t: b.allDay ? '00:00' : busyLabel(b, d).slice(0, 5), h: busyChip(b, d) }))].sort((x, y) => (x.t < y.t ? -1 : x.t > y.t ? 1 : 0));
            return items.length ? items.map((x) => x.h) : html`<p class="muted small">Livre</p>`;
          })()}
        </section>`;
      })}
    </div>`;
  }

  send(res, page(req, {
    title: 'Agenda', active: 'agenda',
    body: html`
    <header class="ph"><div><p class="eyebrow">${title}</p><h1>Agenda</h1></div>
      <div class="ph-actions">
        <nav class="seg ag-views" aria-label="Visão da agenda">${[['dia', 'Dia'], ['semana', 'Semana'], ['mes', 'Mês']].map(([v, l]) => html`<a href="${url(v, ref)}" class="${view === v ? 'on' : ''}" ${view === v ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>
        <a class="btn ghost" href="${prev}" aria-label="Anterior">←</a><a class="btn ghost" href="${url(view, today)}">Hoje</a><a class="btn ghost" href="${next}" aria-label="Próximo">→</a>
        <a class="btn" href="/agenda/nova">+ Agendar</a>
      </div></header>
    ${agendaTabs('semana')}
    ${!ownOnly(req.user) && ctx.allPros.length > 1 ? html`<nav class="ag-pros" aria-label="Agenda de">
      <a href="/agenda?v=${view}&d=${ref}&prof=todos" class="${!profSel ? 'on' : ''}">Todos os profissionais</a>
      ${ctx.allPros.map((u) => html`<a href="/agenda?v=${view}&d=${ref}&prof=${u.id}" class="${profSel === u.id ? 'on' : ''}"><i class="pro-dot" style="background:${proColor(u.id)}"></i>${proName(u)}</a>`)}</nav>` : ''}
    <div class="ag-live" ${ctx.pros.length > 1 ? raw('data-multi="1"') : ''} data-agenda data-view="${view}" data-back="${back}" data-wa="${waOn ? 1 : 0}" data-pront="${can(req.user, 'prontuario') ? 1 : 0}" data-fin="${can(req.user, 'financeiro') ? 1 : 0}">${body}</div>
    <p class="muted small ag-hint">Dica: clique num horário livre para agendar · arraste uma sessão para remarcar · botão direito (ou segure o dedo) numa sessão para mais ações.</p>`,
  }));
});

// ---------- nova sessão ----------
async function patientOptions(req, selected, prof = null) {
  const sc0 = patientScope(req.user);
  const sc = prof && !ownOnly(req.user) ? { sql: `${sc0.sql} AND p.owner_id = ? `, params: [...sc0.params, prof] } : sc0;
  const ps = await q(`SELECT p.id, p.name, p.social_name, p.modality, p.owner_id, p.phone, p.whatsapp_optin, p.default_plan_id FROM patients p WHERE p.status IN ('ativo','pausa') ${sc.sql} ORDER BY p.name`, sc.params);
  // convênios de cada paciente (para o campo “Atendimento” da sessão)
  const pls = await q("SELECT pp.id, pp.patient_id, i.name FROM patient_plans pp JOIN insurers i ON i.id = pp.insurer_id WHERE pp.active = 1 AND i.active = 1");
  const byP = {}; for (const x of pls) (byP[x.patient_id] ||= []).push([x.id, x.name]);
  return html`${ps.map((p) => html` <option value="${p.id}" data-mod="${p.modality}" data-owner="${p.owner_id || ''}" data-phone="${p.phone || ''}" data-optin="${p.whatsapp_optin ? 1 : 0}" data-plans="${JSON.stringify(byP[p.id] || [])}" data-defplan="${byP[p.id]?.some(([id]) => id === p.default_plan_id) ? p.default_plan_id : ''}" ${p.id === selected ? raw('selected') : ''}>${nm(p)}</option>`)}`;
}

function apptForm(a, opts, action, isNew) {
  return html`<form method="post" action="${action}" class="card form-grid">
    <label class="fld span2"><span>Paciente *</span><select name="patient_id" required ${isNew ? '' : raw('disabled')}><option value="">Selecione…</option>${opts}</select></label>
    <label class="fld"><span>Data *</span><input type="date" name="date" required value="${a.starts_at ? a.starts_at.slice(0, 10) : a.date || todayLocal()}"></label>
    <label class="fld"><span>Horário *</span><input type="time" name="time" required step="300" value="${a.starts_at ? a.starts_at.slice(11, 16) : a.time || ''}"></label>
    <label class="fld"><span>Duração (min)</span><input type="number" name="duration_min" min="10" max="240" value="${a.duration_min || 40}"></label>
    <label class="fld" data-ins-field><span>Atendimento</span><select name="plan_id" data-ins-plan data-cur="${a.plan_id ?? (isNew ? '' : '0')}"><option value="0">Particular</option>${(a.plans || []).map(([id, n]) => html`<option value="${id}" ${id === a.plan_id ? raw('selected') : ''}>Convênio · ${n}</option>`)}</select></label>
    <label class="fld"><span>Modalidade</span><select name="modality">${['online', 'presencial'].map((m) => html`<option value="${m}" ${m === (a.modality || 'online') ? raw('selected') : ''}>${label(m)}</option>`)}</select></label>
    <label class="fld" data-tele-only><span>Plataforma da chamada</span><select name="tele_provider" data-tele-prov>
      <option value="">Padrão do(a) profissional</option>${(a.teleAllowed || ['manual']).map((k) => html`<option value="${k}" ${k === a.tele_provider ? raw('selected') : ''}>${Tele.SHORT[k]}</option>`)}</select></label>
    <label class="fld" data-tele-only data-tele-manual><span>Link da chamada <small class="muted">(opcional: cole para usar outro link)</small></span><input type="url" name="meeting_link" maxlength="500" value="${(a.tele_used || Tele.guessUsed(a.meeting_link)) === 'manual' ? a.meeting_link || '' : ''}" placeholder="https://…"></label>
    ${!isNew && a.modality === 'online' && a.meeting_link ? html`<p class="span2 muted small" data-tele-only>Link atual (${Tele.SHORT[a.tele_used || Tele.guessUsed(a.meeting_link)] || 'link'}): <a href="${a.meeting_link}" target="_blank" rel="noopener">${a.meeting_link}</a>${a.tele_error ? html` · <span class="err-txt">${a.tele_error}</span>` : ''}</p>` : ''}
    ${isNew ? html`<label class="fld"><span>Repetir semanalmente</span><select name="repeat">${[1, 2, 4, 8, 12, 24].map((n) => html`<option value="${n}">${n === 1 ? 'Não repetir' : `${n} semanas`}</option>`)}</select></label>`
      : html`<label class="fld"><span>Situação</span><select name="status">${STATUSES.map((s) => html`<option value="${s}" ${s === a.status ? raw('selected') : ''}>${label(s)}</option>`)}</select></label>`}
    <div class="span2 esc-hint" id="esc-hint" data-map="${JSON.stringify(a.escalas || {})}" ${a.escalaAtual ? '' : raw('hidden')}>${a.escalaAtual || ''}</div>
    <label class="fld check span2"><input type="checkbox" name="encaixe" value="1"><span><b>Encaixe:</b> agendar mesmo fora da escala ou em data bloqueada</span></label>
    ${isNew ? html`
    <div class="span2 notify-box" id="notify" data-wa="${a.notify?.waOn ? 1 : 0}" data-pros="${JSON.stringify(a.notify?.pros || {})}">
      <label class="nt nt-push"><span class="nt-ic" aria-hidden="true">🔔</span><span class="nt-t"><b>Notificar aparelhos via push</b><small>Avisa o celular/computador do profissional responsável</small></span><input type="checkbox" name="n_push" value="1" checked></label>
      <label class="nt nt-wa"><span class="nt-ic" aria-hidden="true">💬</span><span class="nt-t"><b>Avisar paciente via WhatsApp <em class="nt-num" data-for="patient"></em></b><small data-msg="patient">Envia a confirmação do agendamento</small></span><input type="checkbox" name="n_wa_patient" value="1"></label>
      <label class="nt nt-pro"><span class="nt-ic" aria-hidden="true">🩺</span><span class="nt-t"><b>Avisar profissional via WhatsApp</b><small data-msg="pro">Envia o aviso para o WhatsApp do profissional</small></span><input type="checkbox" name="n_wa_pro" value="1"></label>
      <label class="fld"><span>Recado para o paciente (opcional — vai junto na mensagem)</span><textarea name="patient_note" rows="2" maxlength="500" placeholder="Ex.: traga o caderno de exercícios; o link da chamada será enviado antes da sessão."></textarea></label>
    </div>` : ''}
    <div class="span2 actions"><button class="btn">Salvar</button><a class="btn ghost" href="/agenda">Cancelar</a></div>
  </form>`;
}

// Resumo da escala de cada profissional (mostrado ao escolher o paciente).
async function escalaMap() {
  const pros = await q("SELECT id, name FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1");
  const map = {};
  for (const u of pros) {
    const s = await SC.getSchedule(u.id);
    const blocks = await SC.blocksBetween(u.id, todayLocal(), addDays(todayLocal(), 30));
    map[u.id] = `Escala de ${u.name}: ${SC.summary(s)}${blocks.length ? ` · bloqueios nos próximos 30 dias: ${blocks.slice(0, 6).map((x) => brDate(x.block_date).slice(0, 5)).join(', ')}${blocks.length > 6 ? '…' : ''}` : ''}`;
  }
  return map;
}

r.get('/nova', async (req, res) => {
  const pid = int(req.query.paciente);
  const escalas = await escalaMap();
  const waOn = WA.ready(await WA.config());
  const prosRows = await q("SELECT id, name, phone FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1");
  const pros = Object.fromEntries(prosRows.map((u) => [u.id, { name: u.name, phone: u.phone || '' }]));
  send(res, page(req, {
    title: 'Agendar sessão', active: 'agenda',
    body: html`<header class="ph"><div><p class="eyebrow">Agenda</p><h1>Agendar sessão</h1></div></header>${apptForm({ teleAllowed: Tele.allowed(await Tele.config()), escalas, notify: { waOn, pros }, date: isYmd(req.query.data) ? req.query.data : null, time: isHm(req.query.hora) ? req.query.hora : null }, await patientOptions(req, pid, int(req.query.prof)), '/agenda/nova', true)}`,
  }));
});

// Conflito = mesmo(a) profissional responsável com sessões sobrepostas.
async function conflicts(start, dur, ownerId, ignoreId = 0) {
  const end = addMinutes(start, dur);
  return q(`SELECT a.starts_at, p.name, p.social_name FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.status <> 'cancelada' AND a.id <> ? AND p.owner_id <=> ? AND a.starts_at < ? AND DATE_ADD(a.starts_at, INTERVAL a.duration_min MINUTE) > ?`, [ignoreId, ownerId, end, start]);
}

r.post('/nova', async (req, res) => {
  const b = req.body;
  const p = await one('SELECT id, name, social_name, owner_id FROM patients WHERE id = ?', [int(b.patient_id)]);
  if (p && !canSeePatient(req.user, p)) throw forbidden();
  if (!p || !isYmd(b.date) || !isHm(b.time)) return res.flash('Preencha paciente, data e horário.', 'err').redirect('/agenda/nova');
  const dur = Math.min(240, Math.max(10, int(b.duration_min) || 40));
  const modality = b.modality === 'presencial' ? 'presencial' : 'online';
  const link = str(b.meeting_link, 500) || null;
  // plataforma: escolhida na sessão; um link digitado sem escolher vira “link manual”
  const prov = ['propria', 'meet', 'zoom', 'manual'].includes(b.tele_provider) ? b.tele_provider : link ? 'manual' : null;
  const repeat = [1, 2, 4, 8, 12, 24].includes(int(b.repeat)) ? int(b.repeat) : 1;
  const planId = await planFor(p.id, b.plan_id);
  if (p.owner_id) {
    const pro = await one('SELECT name, title, modalities FROM users WHERE id = ?', [p.owner_id]);
    const mods = String(pro?.modalities || 'online,presencial').split(',');
    if (pro && !mods.includes(modality)) return res.flash(`${proName(pro)} não atende ${modality === 'online' ? 'on-line' : 'presencial'} (atende só ${mods.map((m) => (m === 'online' ? 'on-line' : 'presencial')).join(' e ')}). Escolha a outra modalidade ou ajuste o cadastro em Usuários.`, 'err').redirect(`/agenda/nova?paciente=${p.id}`);
  }
  const warnings = [], created = [], skipped = [];
  const sched = p.owner_id ? await SC.getSchedule(p.owner_id) : null;
  for (let i = 0; i < repeat; i++) {
    const start = `${addDays(b.date, i * 7)} ${b.time}:00`;
    // Escala e bloqueios do(a) profissional (a menos que seja um encaixe).
    if (!b.encaixe && p.owner_id) {
      const chk = await SC.checkSlot(p.owner_id, start, dur, sched);
      if (!chk.ok) { skipped.push(`${brDate(start)}: ${chk.reason}`); continue; }
    }
    const c = await conflicts(start, dur, p.owner_id);
    if (c.length) warnings.push(`${brDate(start)} ${b.time} (com ${nm(c[0])})`);
    else if (i < 4) {
      const busy = await googleBusy(p.owner_id, start, dur);
      if (busy.length) warnings.push(`${brDate(start)} ${b.time} (Google Agenda: ${busy[0]})`);
    }
    const ins = await q('INSERT INTO appointments (patient_id, starts_at, duration_min, modality, meeting_link, tele_provider, tele_used, patient_note, created_by, plan_id) VALUES (?,?,?,?,?,?,?,?,?,?)', [p.id, start, dur, modality, prov === 'manual' ? link : null, prov, prov === 'manual' && link ? 'manual' : null, str(b.patient_note, 500) || null, req.user.id, planId]);
    created.push(ins.insertId);
  }
  if (!created.length) {
    return res.flash(`Não agendado — ${skipped.join('; ')}. Escolha outro dia/horário ou marque “Encaixe”.`, 'err').redirect(`/agenda/nova?paciente=${p.id}`);
  }
  await audit(req, 'agenda-criar', `patient:${p.id}`);
  CRM.onAppointment(p.id);
  // A primeira sessão vai na hora (para já trazer o link do Meet); as repetições em segundo plano.
  if (created.length) { await syncAppointment(created[0]); syncLater(created.slice(1)); }
  const parts = [created.length > 1 ? `${created.length} sessões agendadas.` : 'Sessão agendada.'];
  // Avisos escolhidos no formulário
  if (b.n_wa_patient) { const r1 = await WA.sendBookingToPatient(created, req.user.id); parts.push(r1.ok ? 'Paciente avisado pelo WhatsApp.' : `WhatsApp do paciente não enviado: ${r1.error}`); if (!r1.ok) warnings.push('whatsapp'); }
  if (b.n_wa_pro) { const r2 = await WA.sendBookingToProfessional(created, req.user.id); parts.push(r2.ok ? 'Profissional avisado pelo WhatsApp.' : `WhatsApp do profissional não enviado: ${r2.error}`); if (!r2.ok) warnings.push('whatsapp'); }
  if (b.n_push && p.owner_id) {
    const first = await one('SELECT starts_at FROM appointments WHERE id = ?', [created[0]]);
    const pn = String(p.social_name || p.name).trim().split(/\s+/);
    PUSH.notify(p.owner_id, { title: '📅 Nova sessão agendada', body: `${pn[0]}${pn.length > 1 ? ` ${pn[pn.length - 1][0]}.` : ''} — ${weekday(first.starts_at.slice(0, 10))} ${brDate(first.starts_at).slice(0, 5)} às ${first.starts_at.slice(11, 16)}${created.length > 1 ? ` (+${created.length - 1})` : ''}`, url: `/agenda/${created[0]}`, tag: `appt-${created[0]}` });
  }
  if (skipped.length) parts.push(`Puladas por escala/bloqueio: ${skipped.join('; ')}.`);
  const conflictsW = warnings.filter((w) => w !== 'whatsapp');
  if (conflictsW.length) parts.push(`Atenção, conflito de horário em ${conflictsW.join('; ')}.`);
  res.flash(parts.join(' '), skipped.length || warnings.length ? 'warn' : 'ok');
  res.redirect(`/agenda?semana=${b.date}`);
});

// ---------- detalhe / edição ----------
r.get('/:id', async (req, res, next) => {
  const a = await one('SELECT a.*, p.name, p.social_name, p.phone, p.session_fee, p.owner_id, u.name prof, u.google_refresh_enc IS NOT NULL gconn, u.google_email FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = p.owner_id WHERE a.id = ?', [int(req.params.id)]);
  if (!a) return next();
  const fin = can(req.user, 'financeiro');
  const pays = fin ? await q('SELECT * FROM payments WHERE appointment_id = ? ORDER BY id', [a.id]) : [];
  const wa = reminder(a);
  const waOn = WA.ready(await WA.config());
  const waLast = await one("SELECT * FROM wa_messages WHERE appointment_id = ? AND direction = 'out' ORDER BY id DESC LIMIT 1", [a.id]);
  send(res, page(req, {
    title: 'Sessão', active: 'agenda',
    body: html`<header class="ph"><div><p class="eyebrow">${weekday(a.starts_at)}, ${longDate(a.starts_at.slice(0, 10))} · ${a.starts_at.slice(11, 16)}</p><h1><a href="/pacientes/${a.patient_id}">${nm(a)}</a></h1></div>
      <div class="ph-actions">${badge(a.status)}${a.modality === 'online' && a.meeting_link ? (Tele.staffLink(a) !== a.meeting_link ? html`<a class="btn" href="${Tele.staffLink(a)}">${Tele.presence(a.id).pac ? html`<i class="tele-dot" aria-hidden="true"></i>Paciente aguardando — entrar` : 'Entrar na teleconsulta'}</a>` : html`<a class="btn" href="${a.meeting_link}" target="_blank" rel="noopener">${(a.tele_used || Tele.guessUsed(a.meeting_link)) === 'manual' ? 'Entrar na chamada' : `Entrar no ${Tele.SHORT[a.tele_used || Tele.guessUsed(a.meeting_link)]}`}</a>`) : ''}${!waOn && wa ? html`<a class="btn ghost" href="${wa}" target="_blank" rel="noopener">Lembrete no WhatsApp</a>` : ''}
      ${can(req.user, 'prontuario') ? html`<a class="btn ghost" href="/pacientes/${a.patient_id}?aba=prontuario">Registrar evolução</a>` : ''}</div></header>
    ${apptForm({ ...a, plans: (await Ins.plansOf(a.patient_id, true)).map((x) => [x.id, x.insurer]), teleAllowed: Tele.allowed(await Tele.config()), escalaAtual: (await escalaMap())[a.owner_id] || '' }, await patientOptions(req, a.patient_id), `/agenda/${a.id}`, false)}
    ${await insuranceCard(req, a)}
    ${a.patient_note ? html`<section class="card"><h2>Recado para o paciente</h2><p class="pre">${a.patient_note}</p></section>` : ''}
    <section class="card"><h2>WhatsApp</h2>
      ${!waOn ? html`<p class="muted">Envio automático desativado.${wa ? html` <a class="link" href="${wa}" target="_blank" rel="noopener">Abrir conversa no WhatsApp</a>` : ''}</p>`
      : html`
        ${waStatus(a) || html`<p class="muted">Nenhum lembrete enviado ainda${a.status === 'agendada' || a.status === 'confirmada' ? ' — o envio automático acontece antes da sessão' : ''}.</p>`}
        ${a.wa_reminder_at ? html`<p class="small muted">Lembrete enviado em ${brDateTime(a.wa_reminder_at)}${a.wa_reply_at ? ` · resposta em ${brDateTime(a.wa_reply_at)}` : ''}</p>` : ''}
        ${a.wa_reminder2_at ? html`<p class="small muted">Aviso curto enviado em ${brDateTime(a.wa_reminder2_at)}</p>` : ''}
        ${waLast?.status === 'erro' ? html`<p class="flash err">Último envio falhou: ${waLast.error}</p>` : ''}
        <div class="actions">
          ${['agendada', 'confirmada'].includes(a.status) ? html`<form method="post" action="/agenda/${a.id}/whatsapp"><button class="btn ghost">${a.wa_reminder_at ? 'Reenviar lembrete' : 'Enviar lembrete agora'}</button></form>` : ''}
          ${a.wa_reply === 'remarcar' && !a.wa_reschedule_done ? html`<form method="post" action="/agenda/${a.id}/remarcacao-ok"><button class="btn ghost">Marcar remarcação como resolvida</button></form>` : ''}
          <a class="link small" href="/pacientes/${a.patient_id}?aba=mensagens">Ver mensagens do paciente</a>
        </div>`}
    </section>
    ${await notifyCard(a)}
    <section class="card gsync"><h2>Google Agenda</h2>
      ${a.google_error ? html`<p class="flash err">Não sincronizou: ${a.google_error}</p><form method="post" action="/agenda/${a.id}/google"><button class="btn ghost">Tentar de novo</button></form>`
      : a.google_event_id ? html`<p><span class="badge b-realizada">Na agenda de ${a.prof || 'profissional'}</span> <small class="muted">${a.google_email || ''} · atualizado ${brDateTime(a.google_synced_at)}</small></p>`
      : a.gconn ? html`<p class="muted">${a.status === 'cancelada' ? 'Sessão cancelada: removida da agenda Google.' : 'Aguardando sincronização.'}</p>${a.status !== 'cancelada' ? html`<form method="post" action="/agenda/${a.id}/google"><button class="btn ghost">Sincronizar agora</button></form>` : ''}`
      : html`<p class="muted">${a.prof || 'O(a) profissional responsável'} ainda não conectou a Google Agenda (Conta → Google Agenda).</p>`}
    </section>
    ${fin ? html`<section class="card"><h2>Pagamento desta sessão</h2>
      ${pays.length ? pays.map((pay) => html`<p>${pay.description} · ${money(pay.amount)} · <b>${pay.paid_at ? `pago em ${brDate(pay.paid_at)}` : pay.origin === 'convenio' ? `a receber do convênio (previsto ${brDate(pay.due_date)})` : 'em aberto'}</b> · <a class="link" href="/financeiro/${pay.id}">abrir lançamento</a></p>`)
      : html`<p class="muted">Ao marcar a sessão como realizada, o lançamento é criado automaticamente${a.plan_id ? ' com o valor da tabela do convênio (e a coparticipação, se houver)' : ` com o valor cadastrado do paciente${a.session_fee ? '' : ' (cadastre o valor da sessão na ficha)'}`}.</p>`}
    </section>` : ''}`,
  }));
});

// Sessão realizada: consome o pacote do paciente ou gera a cobrança (valor da ficha, quem recebe, quem emite o recibo).
async function autoPayment(a) {
  if (a.status === 'realizada') CRM.onSessionDone(a.patient_id);
  await Fin.onAppointmentStatus(a);
}

r.post('/:id', async (req, res, next) => {
  const a = await one('SELECT * FROM appointments WHERE id = ?', [int(req.params.id)]);
  if (!a) return next();
  const b = req.body;
  if (!isYmd(b.date) || !isHm(b.time)) return res.flash('Data ou horário inválido.', 'err').redirect(`/agenda/${a.id}`);
  const start = `${b.date} ${b.time}:00`;
  const dur = Math.min(240, Math.max(10, int(b.duration_min) || 40));
  const status = STATUSES.includes(b.status) ? b.status : a.status;
  if (!b.encaixe && ['agendada', 'confirmada'].includes(status) && (start !== a.starts_at || dur !== a.duration_min)) {
    const owner = await one('SELECT owner_id FROM patients WHERE id = ?', [a.patient_id]);
    const chk = await SC.checkSlot(owner?.owner_id, start, dur);
    if (!chk.ok) return res.flash(`Não alterado — ${brDate(start)}: ${chk.reason}. Escolha outro horário ou marque “Encaixe”.`, 'err').redirect(`/agenda/${a.id}`);
  }
  if (start !== a.starts_at) await q('UPDATE appointments SET wa_reminder_at = NULL, wa_reminder2_at = NULL, wa_reply = NULL, wa_reply_at = NULL WHERE id = ?', [a.id]); // novo horário → novos lembretes
  const typed = str(b.meeting_link, 500) || null;
  const prov = ['propria', 'meet', 'zoom', 'manual'].includes(b.tele_provider) ? b.tele_provider : (typed && typed !== a.meeting_link ? 'manual' : null);
  // link manual: grava o que foi digitado; nas outras plataformas o link é gerado na sincronização
  const usedNow = a.tele_used || Tele.guessUsed(a.meeting_link);
  const manual = prov === 'manual' || (!prov && (usedNow === 'manual' || !usedNow) && typed);
  const planId = b.plan_id === undefined ? a.plan_id : await planFor(a.patient_id, b.plan_id);
  if (planId !== a.plan_id) { // trocou particular ⇄ convênio: refaz a cobrança ainda não paga desta sessão
    await q("DELETE FROM payments WHERE appointment_id = ? AND paid_at IS NULL AND settlement_id IS NULL AND origin IN ('sessao','convenio')", [a.id]);
    await q('UPDATE appointments SET auth_id = NULL WHERE id = ?', [a.id]);
  }
  await q(`UPDATE appointments SET starts_at = ?, duration_min = ?, modality = ?, tele_provider = ?, status = ?, plan_id = ?${manual ? ", meeting_link = ?, tele_used = 'manual'" : ''} WHERE id = ?`,
    [start, dur, b.modality === 'presencial' ? 'presencial' : 'online', prov, status, planId, ...(manual ? [typed] : []), a.id]);
  const p = await one('SELECT session_fee, owner_id FROM patients WHERE id = ?', [a.patient_id]);
  if (status !== a.status) await Flow.setStatus(a.id, status, req.user.id);
  else await autoPayment({ ...a, starts_at: start, status, session_fee: p.session_fee });
  await syncAppointment(a.id);
  // Cancelou ou mudou o horário de uma sessão marcada: o horário antigo vai para a lista de espera.
  const freed = ['agendada', 'confirmada'].includes(a.status) && (status === 'cancelada' || start !== a.starts_at) ? await Waitlist.slotFreed({ ...a, owner_id: p.owner_id }, req.user.id) : null;
  const c = status === 'cancelada' ? [] : await conflicts(start, dur, p.owner_id, a.id);
  await audit(req, 'agenda-editar', `appointment:${a.id}`);
  res.flash((c.length ? `Salvo, mas há conflito com ${nm(c[0])} às ${c[0].starts_at.slice(11, 16)}.` : 'Sessão atualizada.') + freedMsg(freed), c.length ? 'warn' : 'ok').redirect(`/agenda?semana=${b.date}`);
});

// Atendimento da sessão: “0” = particular; um id = carteirinha ativa do próprio paciente; vazio = a padrão do paciente
async function planFor(pid, v) {
  if (String(v ?? '') === '0') return null;
  const id = int(v) || (await one('SELECT default_plan_id FROM patients WHERE id = ?', [pid]))?.default_plan_id;
  if (!id) return null;
  const ok = await one('SELECT pp.id FROM patient_plans pp JOIN insurers i ON i.id = pp.insurer_id WHERE pp.id = ? AND pp.patient_id = ? AND pp.active = 1 AND i.active = 1', [id, pid]);
  return ok?.id || null;
}

// Frase para o aviso da tela quando um horário vai para a lista de espera.
export const freedMsg = (f) => (!f ? '' : f.candidates ? (f.auto ? ` Horário oferecido à lista de espera (${f.candidates} pessoa(s) compatível(is)).` : ` ${f.candidates} pessoa(s) da lista de espera combinam com este horário: ofereça em Agenda → Lista de espera.`) : '');
const safeBack = (b, d) => (typeof b === 'string' && b.startsWith('/') && !b.startsWith('//') ? b : d);
r.post('/:id/whatsapp', async (req, res) => {
  const id = int(req.params.id);
  const r = await WA.sendReminder(id, req.user.id);
  await audit(req, 'whatsapp-lembrete', `appointment:${id}`);
  res.flash(r.ok ? 'Lembrete enviado pelo WhatsApp.' : `Não enviado: ${r.error}`, r.ok ? 'ok' : 'err').redirect(safeBack(req.body.back, `/agenda/${id}`));
});

r.post('/:id/lembrete-email', async (req, res) => {
  const id = int(req.params.id);
  const r = await Notify.reminderEmail(id);
  await audit(req, 'lembrete-email', `appointment:${id}`);
  res.flash(r.ok ? 'Lembrete enviado por e-mail.' : `Não enviado: ${r.error}`, r.ok ? 'ok' : 'err').redirect(safeBack(req.body.back, `/agenda/${id}`));
});
r.post('/:id/lembrete-sms', async (req, res) => {
  const id = int(req.params.id);
  const r = await Notify.reminderSms(id);
  await audit(req, 'lembrete-sms', `appointment:${id}`);
  res.flash(r.ok ? 'Lembrete enviado por SMS.' : `Não enviado: ${r.error}`, r.ok ? 'ok' : 'err').redirect(safeBack(req.body.back, `/agenda/${id}`));
});

r.post('/:id/remarcacao-ok', async (req, res) => {
  const id = int(req.params.id);
  await q('UPDATE appointments SET wa_reschedule_done = 1 WHERE id = ?', [id]);
  res.flash('Pedido de remarcação marcado como resolvido.').redirect(safeBack(req.body.back, `/agenda/${id}`));
});

r.post('/:id/google', async (req, res) => {
  await syncAppointment(int(req.params.id));
  const a = await one('SELECT google_error FROM appointments WHERE id = ?', [int(req.params.id)]);
  res.flash(a?.google_error ? `Falhou: ${a.google_error}` : 'Sincronizado com a Google Agenda.', a?.google_error ? 'err' : 'ok').redirect(`/agenda/${int(req.params.id)}`);
});

r.post('/:id/status', async (req, res, next) => {
  const a = await one('SELECT a.*, p.session_fee FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [int(req.params.id)]);
  if (!a || !STATUSES.includes(req.body.status)) return next();
  const st = await Flow.setStatus(a.id, req.body.status, req.user.id); // horários do fluxo + financeiro + histórico + lista de espera
  syncLater(a.id);
  await audit(req, 'agenda-status', `appointment:${a.id}`);
  const back = String(req.body.back || '/agenda');
  res.flash(`Sessão marcada como ${label(req.body.status).toLowerCase()}.${freedMsg(st?.freed)}`).redirect(back.startsWith('/') && !back.startsWith('//') ? back : '/agenda');
});

// ---------- arrastar para remarcar (JSON) ----------
r.post('/:id/mover', express.json({ limit: '4kb' }), async (req, res) => {
  const a = await one('SELECT a.*, p.owner_id, p.name, p.social_name FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [int(req.params.id)]);
  if (!a) return res.status(404).json({ ok: false, error: 'Sessão não encontrada.' });
  if (!['agendada', 'confirmada'].includes(a.status)) return res.json({ ok: false, error: 'Só sessões agendadas ou confirmadas podem ser remarcadas.' });
  const b = req.body || {};
  const date = isYmd(b.date) ? b.date : a.starts_at.slice(0, 10);
  const time = isHm(b.time) ? b.time : a.starts_at.slice(11, 16);
  const start = `${date} ${time}:00`;
  if (start === a.starts_at) return res.json({ ok: true, same: true });
  if (!b.encaixe) {
    const chk = await SC.checkSlot(a.owner_id, start, a.duration_min);
    if (!chk.ok) return res.json({ ok: false, needForce: true, error: `${brDate(start)} às ${time}: ${chk.reason}.` });
    const c = await conflicts(start, a.duration_min, a.owner_id, a.id);
    if (c.length) return res.json({ ok: false, needForce: true, error: `Conflito com ${nm(c[0])} às ${c[0].starts_at.slice(11, 16)}.` });
  }
  await q('UPDATE appointments SET starts_at = ?, wa_reminder_at = NULL, wa_reminder2_at = NULL, wa_reply = NULL, wa_reply_at = NULL WHERE id = ?', [start, a.id]);
  await syncAppointment(a.id);
  await audit(req, 'agenda-remarcar', `appointment:${a.id} ${a.starts_at.slice(0, 16)} -> ${start.slice(0, 16)}`);
  let msg = `${nm(a)} remarcado(a) para ${weekday(date)}, ${brDate(date)} às ${time}.`;
  if (b.notify) { const w = await WA.sendBookingToPatient([a.id], req.user.id); msg += w.ok ? ' Paciente avisado pelo WhatsApp.' : ` WhatsApp não enviado: ${w.error}`; }
  msg += freedMsg(await Waitlist.slotFreed(a, req.user.id)); // o horário antigo vai para a lista de espera
  res.flash(msg);
  res.json({ ok: true });
});

// Repetir a sessão na semana seguinte (mesmo horário)
r.post('/:id/repetir', async (req, res, next) => {
  const a = await one('SELECT a.*, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [int(req.params.id)]);
  if (!a) return next();
  const back = safeBack(req.body.back, '/agenda');
  const start = `${addDays(a.starts_at.slice(0, 10), 7)} ${a.starts_at.slice(11, 19)}`;
  const chk = await SC.checkSlot(a.owner_id, start, a.duration_min);
  if (!chk.ok) return res.flash(`Não repetido — ${brDate(start)}: ${chk.reason}.`, 'err').redirect(back);
  const c = await conflicts(start, a.duration_min, a.owner_id);
  if (c.length) return res.flash(`Não repetido — conflito com ${nm(c[0])} às ${c[0].starts_at.slice(11, 16)} em ${brDate(start)}.`, 'err').redirect(back);
  const ins = await q('INSERT INTO appointments (patient_id, starts_at, duration_min, modality, meeting_link, created_by) VALUES (?,?,?,?,?,?)', [a.patient_id, start, a.duration_min, a.modality, a.modality === 'online' ? a.meeting_link : null, req.user.id]);
  syncLater([ins.insertId]);
  await audit(req, 'agenda-repetir', `appointment:${a.id} -> ${ins.insertId}`);
  res.flash(`Sessão repetida em ${weekday(start.slice(0, 10))}, ${brDate(start)} às ${start.slice(11, 16)}.`).redirect(back);
});

// Excluir a sessão (não permitido se já houver pagamento recebido)
r.post('/:id/excluir', async (req, res, next) => {
  const a = await one('SELECT a.*, p.session_fee, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [int(req.params.id)]);
  if (!a) return next();
  const back = safeBack(req.body.back, '/agenda');
  if (await one('SELECT id FROM payments WHERE appointment_id = ? AND (paid_at IS NOT NULL OR settlement_id IS NOT NULL)', [a.id])) return res.flash('Esta sessão tem pagamento recebido — cancele em vez de excluir.', 'err').redirect(back);
  let freed = null;
  if (a.status !== 'cancelada') { await q("UPDATE appointments SET status = 'cancelada' WHERE id = ?", [a.id]); await autoPayment({ ...a, status: 'cancelada' }); }
  if (['agendada', 'confirmada'].includes(a.status)) freed = await Waitlist.slotFreed({ ...a, id: null }, req.user.id);
  await syncAppointment(a.id); // remove da Google Agenda
  await q('UPDATE payments SET appointment_id = NULL WHERE appointment_id = ?', [a.id]);
  await q('UPDATE wa_messages SET appointment_id = NULL WHERE appointment_id = ?', [a.id]);
  await q('DELETE FROM appointments WHERE id = ?', [a.id]);
  await audit(req, 'agenda-excluir', `appointment:${a.id}`);
  res.flash(`Sessão excluída.${freedMsg(freed)}`).redirect(back);
});

export default r;
