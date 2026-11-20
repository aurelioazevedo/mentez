import { q, one } from '../lib/db.js';
import { page, html, money, badge, brDate, label, initials, icon } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import { todayLocal, addDays, startOfWeek, addMonths, isYm } from '../lib/time.js';
import { can, patientScope, homeFor, proName } from '../lib/perm.js';
import * as SC from '../lib/schedule.js';
import { lineChart, barChart, fmtMoney, fmtMoneyShort } from '../lib/charts.js';
import { forUser as notesFor } from '../lib/notes.js';

const r = router();
const DIAS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const MES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const dow = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
const daysIn = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();
const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : a ? 100 : 0);

// Séries por período (semana / mês / ano) a partir de um mapa { 'AAAA-MM-DD': valor }
function series(byDay, today) {
  const wk = startOfWeek(today); const ym = today.slice(0, 7); const yr = today.slice(0, 4);
  const semana = [...Array(7)].map((_, i) => { const d = addDays(wk, i); return { label: DIAS[dow(d)], full: `${DIAS[dow(d)]} ${brDate(d).slice(0, 5)}`, value: byDay[d] || 0 }; });
  const mes = [...Array(daysIn(ym))].map((_, i) => { const d = `${ym}-${String(i + 1).padStart(2, '0')}`; return { label: String(i + 1), full: brDate(d), value: byDay[d] || 0 }; });
  const ano = [...Array(12)].map((_, i) => { const m = `${yr}-${String(i + 1).padStart(2, '0')}`; return { label: MES[i], full: `${MESES[i]} de ${yr}`, value: Object.entries(byDay).filter(([k]) => k.startsWith(m)).reduce((s, [, v]) => s + Number(v), 0) }; });
  return { semana, mes, ano };
}

// Ocupação da escala na semana: minutos agendados ÷ minutos disponíveis na escala.
async function occupancy(user, today, sc) {
  const pros = user.role === 'psicologo' ? [{ id: user.id }] : await q("SELECT id FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1");
  const wk = startOfWeek(today); let cap = 0;
  for (const p of pros) {
    const sched = await SC.getSchedule(p.id);
    if (!sched.configured) continue;
    for (let i = 0; i < 7; i++) {
      const st = await SC.dayStatus(p.id, addDays(wk, i), sched);
      if (st.works && !st.unrestricted) for (const b of (st.blocks?.length ? st.blocks : [st])) { const [h1, m1] = b.start.split(':').map(Number); const [h2, m2] = b.end.split(':').map(Number); cap += (h2 * 60 + m2) - (h1 * 60 + m1); }
    }
  }
  if (!cap) return null;
  const used = await one(`SELECT COALESCE(SUM(a.duration_min),0) m FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status <> 'cancelada' ${sc.sql}`, [wk, addDays(wk, 7), ...sc.params]);
  return { pct: Math.min(100, Math.round((Number(used.m) / cap) * 100)), used: Number(used.m), cap };
}

function trend(delta, suffix = '%') {
  if (delta === null || delta === undefined) return '';
  const up = delta >= 0;
  return html`<span class="trend ${up ? 'up' : 'down'}">${up ? '↗' : '↘'} ${up ? '+' : ''}${delta}${suffix}</span>`;
}

function calendar(ym, today, busy) {
  const first = `${ym}-01`; const lead = (dow(first) + 6) % 7; // semana começa na segunda
  const cells = [...Array(lead).fill(null), ...[...Array(daysIn(ym))].map((_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`)];
  return html`<section class="card cal">
    <div class="cal-h"><a href="/?mes=${addMonths(ym, -1)}" aria-label="Mês anterior">‹</a><b>${MESES[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}</b><a href="/?mes=${addMonths(ym, 1)}" aria-label="Próximo mês">›</a></div>
    <div class="cal-g">${['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'].map((d) => html`<span class="cal-w">${d}</span>`)}
      ${cells.map((d) => (d ? html`<a href="/agenda?semana=${d}" class="cal-d${d === today ? ' today' : ''}${busy[d] ? ' busy' : ''}" title="${busy[d] ? `${busy[d]} sessão(ões)` : ''}">${Number(d.slice(8))}</a>` : html`<span></span>`))}
    </div>
    ${ym !== today.slice(0, 7) ? html`<a class="cal-today" href="/">Voltar para hoje</a>` : ''}
  </section>`;
}

r.get('/', async (req, res) => {
  if (homeFor(req.user) !== '/') return res.redirect(homeFor(req.user));
  const u = req.user;
  const fin = can(u, 'financeiro');
  const sc = patientScope(u);
  const today = todayLocal();
  const ym = today.slice(0, 7); const prevYm = addMonths(ym, -1);
  const wk = startOfWeek(today);
  const calYm = isYm(req.query.mes) ? req.query.mes : ym;
  const yr = today.slice(0, 4);

  const [todayAppts, activeP, newThis, newPrev, wkNow, wkPrev, att, attPrev, sessYear, revYear, recNow, recPrev, calBusy, newYear, soon] = await Promise.all([
    q(`SELECT a.*, p.name, p.social_name, u.name pro_name, u.title pro_title FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = p.owner_id
       WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status <> 'cancelada' ${sc.sql} ORDER BY a.starts_at`, [today, addDays(today, 1), ...sc.params]),
    one(`SELECT COUNT(*) n FROM patients p WHERE p.status = 'ativo' ${sc.sql}`, sc.params),
    one(`SELECT COUNT(*) n FROM patients p WHERE DATE_FORMAT(p.created_at,'%Y-%m') = ? ${sc.sql}`, [ym, ...sc.params]),
    one(`SELECT COUNT(*) n FROM patients p WHERE DATE_FORMAT(p.created_at,'%Y-%m') = ? ${sc.sql}`, [prevYm, ...sc.params]),
    one(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status <> 'cancelada' ${sc.sql}`, [wk, addDays(wk, 7), ...sc.params]),
    one(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status <> 'cancelada' ${sc.sql}`, [addDays(wk, -7), wk, ...sc.params]),
    one(`SELECT SUM(a.status='realizada') ok, SUM(a.status='falta') falta FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE DATE_FORMAT(a.starts_at,'%Y-%m') = ? ${sc.sql}`, [ym, ...sc.params]),
    one(`SELECT SUM(a.status='realizada') ok, SUM(a.status='falta') falta FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE DATE_FORMAT(a.starts_at,'%Y-%m') = ? ${sc.sql}`, [prevYm, ...sc.params]),
    q(`SELECT DATE(a.starts_at) d, COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE YEAR(a.starts_at) = ? AND a.status <> 'cancelada' ${sc.sql} GROUP BY DATE(a.starts_at)`, [yr, ...sc.params]),
    fin ? q('SELECT paid_at d, SUM(amount) v FROM payments WHERE paid_at IS NOT NULL AND YEAR(paid_at) = ? GROUP BY paid_at', [yr]) : [],
    fin ? one("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE paid_at IS NOT NULL AND DATE_FORMAT(paid_at,'%Y-%m') = ?", [ym]) : null,
    fin ? one("SELECT COALESCE(SUM(amount),0) v FROM payments WHERE paid_at IS NOT NULL AND DATE_FORMAT(paid_at,'%Y-%m') = ?", [prevYm]) : null,
    q(`SELECT DATE(a.starts_at) d, COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE DATE_FORMAT(a.starts_at,'%Y-%m') = ? AND a.status <> 'cancelada' ${sc.sql} GROUP BY DATE(a.starts_at)`, [calYm, ...sc.params]),
    fin ? [] : q(`SELECT DATE(p.created_at) d, COUNT(*) n FROM patients p WHERE YEAR(p.created_at) = ? ${sc.sql} GROUP BY DATE(p.created_at)`, [yr, ...sc.params]),
    one(`SELECT COUNT(*) n, SUM(a.status='confirmada') c FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= NOW() AND a.starts_at < DATE_ADD(NOW(), INTERVAL 48 HOUR) AND a.status IN ('agendada','confirmada') ${sc.sql}`, sc.params),
  ]);
  const ymd = (d) => (typeof d === 'string' ? d.slice(0, 10) : new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10));
  const sessMap = Object.fromEntries(sessYear.map((x) => [ymd(x.d), Number(x.n)]));
  const revMap = Object.fromEntries(revYear.map((x) => [ymd(x.d), Number(x.v)]));
  const busy = Object.fromEntries(calBusy.map((x) => [ymd(x.d), Number(x.n)]));
  const sSess = series(sessMap, today); const sRev = series(revMap, today);
  const sNew = series(Object.fromEntries(newYear.map((x) => [ymd(x.d), Number(x.n)])), today);
  const attRate = (a) => { const t = Number(a.ok || 0) + Number(a.falta || 0); return t ? Math.round((Number(a.ok) / t) * 100) : null; };
  const attNow = attRate(att); const attBefore = attRate(attPrev);
  const occ = await occupancy(u, today, sc);
  const notes = await notesFor(u, true); req.notes = notes; // painel sempre atualizado (e o sino da página junto)
  const nm = (x) => x.social_name || x.name;
  const nowHm = new Date(Date.now() - 3 * 3600e3).toISOString().slice(11, 16);

  const kpis = [
    { label: 'Pacientes em atendimento', value: activeP.n, trend: trend(pct(newThis.n, newPrev.n)), sub: `${newThis.n} novo(s) este mês`, href: '/pacientes' },
    { label: 'Sessões nesta semana', value: wkNow.n, trend: trend(pct(wkNow.n, wkPrev.n)), sub: `${wkNow.n - wkPrev.n >= 0 ? `${wkNow.n - wkPrev.n} a mais` : `${wkPrev.n - wkNow.n} a menos`} que a semana passada`, href: '/agenda' },
    fin ? { label: `Recebido em ${MESES[Number(ym.slice(5, 7)) - 1].toLowerCase()}`, value: fmtMoney(recNow.v), trend: trend(pct(Number(recNow.v), Number(recPrev.v))), sub: `${fmtMoney(recPrev.v)} no mês anterior`, href: '/financeiro' }
      : { label: 'Confirmadas (48h)', value: soon.n ? `${Math.round((Number(soon.c || 0) / soon.n) * 100)}%` : '—', trend: '', sub: `${Number(soon.c || 0)} de ${soon.n} sessão(ões)`, href: '/agenda' },
    { label: 'Comparecimento no mês', value: attNow === null ? '—' : `${attNow}%`, trend: attNow !== null && attBefore !== null ? trend(attNow - attBefore, ' p.p.') : '', sub: `${Number(att.ok || 0)} realizada(s) · ${Number(att.falta || 0)} falta(s)`, href: '/agenda' },
  ];

  const tabs = (id) => html`<div class="seg" role="tablist" data-seg="${id}">${[['semana', 'Semana'], ['mes', 'Mês'], ['ano', 'Ano']].map(([k, l], i) => html`<button type="button" role="tab" data-seg-k="${k}" class="${i === 0 ? 'on' : ''}" aria-selected="${i === 0 ? 'true' : 'false'}">${l}</button>`)}</div>`;
  const panes = (id, s, fn, opts) => html`${['semana', 'mes', 'ano'].map((k, i) => html`<div class="seg-pane" data-seg-pane="${id}:${k}" ${i ? 'hidden' : ''}>${fn(s[k], opts)}</div>`)}`;

  send(res, page(req, {
    title: 'Início', active: 'home',
    body: html`
    <header class="ph dash-h"><div><h1>Dashboard</h1><p class="muted">Bem-vind${u.title === 'Dr.' ? 'o' : 'a'} de volta, ${u.name.split(' ')[0]}! Veja o que acontece hoje.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/agenda/nova">${icon('agenda')} Nova sessão</a>${can(u, 'cadastro') ? html`<a class="btn" href="/pacientes/novo">${icon('pacientes')} Cadastrar paciente</a>` : ''}</div></header>

    <div class="dash">
      <div class="dash-main">
        <section class="kpis dash-kpis">${kpis.map((k) => html`<a class="kpi" href="${k.href}"><span>${k.label}</span><div class="kpi-v"><b>${k.value}</b>${k.trend}</div><small>${k.sub}</small></a>`)}</section>

        <div class="dash-charts">
          ${fin ? html`<section class="card chart-card"><div class="chart-h"><h2>Receita recebida</h2>${tabs('rev')}</div>
            ${panes('rev', sRev, lineChart, { fmt: fmtMoney, fmtY: fmtMoneyShort, title: 'Receita recebida' })}</section>`
          : html`<section class="card chart-card"><div class="chart-h"><h2>Novos pacientes</h2>${tabs('new')}</div>
            ${panes('new', sNew, lineChart, { title: 'Novos pacientes' })}</section>`}
          <section class="card chart-card"><div class="chart-h"><h2>Sessões</h2>${tabs('ses')}</div>
            ${panes('ses', sSess, barChart, { title: 'Sessões agendadas e realizadas' })}</section>
        </div>

        <div class="grid2 dash-lists">
          <section class="card"><h2>Sessões de hoje</h2><p class="muted small sub-h">${todayAppts.length ? `${todayAppts.length} sessão(ões) · ${todayAppts.filter((a) => a.status === 'realizada').length} realizada(s)` : 'Agenda livre hoje'}</p>
            ${todayAppts.length ? html`<ul class="people">${todayAppts.map((a) => html`<li><a href="/agenda/${a.id}"><span class="av av-sm av-ini">${initials(nm(a))}</span>
              <span class="pp"><b>${nm(a)}</b><small>${a.pro_name ? proName({ name: a.pro_name, title: a.pro_title }) : ''} · ${label(a.modality)}</small></span>
              <span class="pt">🕘 ${a.starts_at.slice(11, 16)}</span>${badge(a.status)}</a></li>`)}</ul>`
            : html`<p class="muted">Nenhuma sessão hoje.</p>`}
            <p><a class="link" href="/agenda">Ver agenda da semana →</a></p>
          </section>

          <section class="card"><h2>Alertas e notificações</h2><p class="muted small sub-h">Pendências que pedem atenção</p>
            ${notes.items.length ? html`<ul class="alerts">${notes.items.map((n) => html`<li class="${n.tone || ''}"><a href="${n.href}"><span>${n.text}</span>${n.sub ? html`<small>${n.sub}</small>` : ''}</a></li>`)}</ul>`
            : html`<p class="alerts-ok">✨ Nenhuma pendência no momento.</p>`}
            <div class="meters">
              ${occ ? html`<div class="gauge"><div><b>Ocupação da escala</b><small>${Math.round(occ.used / 60)}h de ${Math.round(occ.cap / 60)}h nesta semana</small></div><span>${occ.pct}%</span><i style="--p:${occ.pct}%"></i></div>` : ''}
              <div class="gauge"><div><b>Confirmação (próximas 48h)</b><small>${Number(soon.c || 0)} de ${soon.n} sessão(ões)</small></div><span>${soon.n ? Math.round((Number(soon.c || 0) / soon.n) * 100) : 0}%</span><i style="--p:${soon.n ? Math.round((Number(soon.c || 0) / soon.n) * 100) : 0}%"></i></div>
            </div>
          </section>
        </div>
      </div>

      <aside class="dash-side">
        ${calendar(calYm, today, busy)}
        <section class="timeline"><h2>Linha do tempo de hoje</h2>
          ${todayAppts.length ? html`<ol>${todayAppts.map((a) => { const end = new Date(new Date(`${a.starts_at.replace(' ', 'T')}Z`).getTime() + a.duration_min * 6e4).toISOString().slice(11, 16); const st = a.status === 'realizada' || a.status === 'falta' ? 'done' : a.starts_at.slice(11, 16) <= nowHm && end > nowHm ? 'now' : ''; return html`<li class="${st}">
            <a href="/agenda/${a.id}" class="tl-card"><div class="tl-top"><b>${nm(a)}</b><span>${a.starts_at.slice(11, 16)}</span></div>
              <small>${label(a.modality)} · ${a.duration_min} min${a.pro_name ? ` · ${proName({ name: a.pro_name, title: a.pro_title })}` : ''}</small>
              <div class="tl-foot">${badge(a.status)}${st === 'now' ? html`<em>agora</em>` : ''}</div></a></li>`; })}</ol>`
          : html`<p class="muted small">Sem sessões hoje. Aproveite para revisar exercícios e prontuários. 🌿</p>`}
        </section>
      </aside>
    </div>`,
  }));
});

export default r;
