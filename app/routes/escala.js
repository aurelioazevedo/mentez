import { q, one, audit } from '../lib/db.js';
import { page, agendaTabs, html, raw, brDate } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { ownOnly, ROLES, forbidden } from '../lib/perm.js';
import { todayLocal, isYm, isYmd, isHm, addMonths, monthName, addDays } from '../lib/time.js';
import * as SC from '../lib/schedule.js';
import * as Agent from '../lib/agent.js';

const r = router();

// Profissionais que a pessoa pode configurar: psicólogo(a) só a própria escala.
async function professionals(user) {
  if (ownOnly(user)) return q('SELECT id, name, role, crp, google_refresh_enc, google_error FROM users WHERE id = ?', [user.id]);
  return q("SELECT id, name, role, crp, google_refresh_enc, google_error FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");
}
async function pickProfessional(req) {
  const pros = await professionals(req.user);
  const wanted = int(req.query.prof ?? req.body?.prof);
  const prof = pros.find((p) => p.id === wanted) || pros.find((p) => p.id === req.user.id) || pros[0];
  if (wanted && prof && prof.id !== wanted) throw forbidden();
  return { pros, prof };
}
const back = (prof, ym) => `/escala?prof=${prof}${ym ? `&mes=${ym}` : ''}`;

function monthDates(ym) {
  const out = [];
  let d = `${ym}-01`;
  while (d.slice(0, 7) === ym) { out.push(d); d = addDays(d, 1); }
  return out;
}

r.get('/', async (req, res) => {
  const { pros, prof } = await pickProfessional(req);
  if (!prof) return send(res, page(req, { title: 'Escala', active: 'agenda', body: html`<p class="muted">Nenhum profissional cadastrado.</p>` }));
  const ym = isYm(req.query.mes) ? req.query.mes : todayLocal().slice(0, 7);
  const sched = await SC.getSchedule(prof.id);
  const dates = monthDates(ym);
  const blocks = await SC.blocksBetween(prof.id, dates[0], dates[dates.length - 1]);
  const blockMap = Object.fromEntries(blocks.map((b) => [b.block_date, b]));
  const sessions = await q(`SELECT DATE(a.starts_at) d, COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.owner_id = ? AND a.status IN ('agendada','confirmada') AND a.starts_at >= ? AND a.starts_at < ? GROUP BY DATE(a.starts_at)`, [prof.id, dates[0], addDays(dates[dates.length - 1], 1)]);
  const sessMap = Object.fromEntries(sessions.map((s) => [String(s.d).slice(0, 10), s.n]));
  const upcoming = await SC.blocksBetween(prof.id, todayLocal(), addDays(todayLocal(), 400));
  const workDays = sched.configured ? Object.keys(sched.days).map(Number).sort() : [];
  const ag = await Agent.config();
  const gDefault = SC.gridOf(null, ag.duration, ag.slotStep);
  const g = SC.gridOf(sched, ag.duration, ag.slotStep);
  const ex = SC.startsIn({ blocks: [{ start: '08:00', end: '12:00' }] }, '2000-01-03', g.duration, g.step).map((t) => t.slice(11, 16));
  const gridExample = `sessões de ${g.duration} min ${g.interval ? `com ${g.interval} min de intervalo` : 'sem intervalo'} → das 08:00 às 12:00: ${ex.join(', ')}`;
  const today = todayLocal();
  const gOk = prof.google_refresh_enc && !prof.google_error;

  send(res, page(req, {
    title: 'Escala', active: 'agenda',
    body: html`
    <header class="ph"><div><p class="eyebrow">Agenda</p><h1>Escala e bloqueios de atendimento</h1><p class="muted">Configure os dias da semana de atendimento e bloqueie datas específicas (folgas, feriados, férias).</p></div>
      <div class="ph-actions"><a class="btn" href="/agenda/nova">+ Agendar</a></div></header>
    ${agendaTabs('escala')}

    <section class="card esc-prof">
      <span class="dot" aria-hidden="true"></span>
      <div><b>${prof.name}</b><small>${ROLES[prof.role]?.label}${prof.crp ? ` · CRP ${prof.crp}` : ''}</small></div>
      <div class="esc-badges">${gOk ? html`<span class="badge b-realizada">Google Agenda sincronizada</span>` : ''}${prof.id === req.user.id ? html`<span class="badge b-confirmada">Seu perfil</span>` : ''}</div>
      ${pros.length > 1 ? html`<form method="get" class="esc-pick"><select name="prof" data-autosubmit>${pros.map((p) => html`<option value="${p.id}" ${p.id === prof.id ? raw('selected') : ''}>${p.name}</option>`)}</select><input type="hidden" name="mes" value="${ym}"><noscript><button class="btn ghost">Abrir</button></noscript></form>` : ''}
    </section>

    <form method="post" action="/escala/semana" class="card esc-week" id="semana">
      <input type="hidden" name="prof" value="${prof.id}"><input type="hidden" name="mes" value="${ym}">
      <div class="esc-head"><h2>Dias da semana de atendimento</h2>
        <div class="esc-quick"><span class="muted small">Atalhos:</span>
          <button type="button" class="chip" data-days="1,2,3,4,5">Seg a Sex</button>
          <button type="button" class="chip" data-days="0,1,2,3,4,5,6">Todos os dias</button>
          <button type="button" class="chip" data-days="">Limpar</button></div></div>
      <div class="esc-only"><span class="small"><b>Atender apenas em um dia da semana:</b></span>
        <div class="esc-only-btns">${SC.WEEKDAYS.map((w, i) => html`<button type="button" class="chip ${workDays.length === 1 && workDays[0] === i ? 'on' : ''}" data-days="${i}">Apenas ${w}</button>`)}</div></div>
      <div class="esc-days esc-rows">${SC.WEEKDAYS.map((w, i) => {
        const d = sched.days[i];
        const blk = (p) => d?.blocks?.find((b) => b.period === p);
        const def = { 1: ['08:00', '12:00'], 2: ['13:00', '18:00'], 3: ['18:00', '21:00'] };
        return html`<div class="esc-day ${d ? 'on' : ''}">
          <label class="esc-toggle"><input type="checkbox" name="day_${i}" value="1" ${d ? raw('checked') : ''}><span><b>${w}</b><em>${d ? 'Atende' : 'Folga'}</em></span></label>
          <div class="esc-blocks">${[1, 2, 3].map((p) => { const b = blk(p); return html`<div class="esc-block ${b ? 'on' : ''}">
            <label class="esc-bcheck"><input type="checkbox" name="b_${i}_${p}" value="1" ${b || (!d && p === 1) ? raw('checked') : ''}><span>${SC.PERIODS[p]}</span></label>
            <input type="time" name="s_${i}_${p}" value="${b?.start || def[p][0]}" step="300" aria-label="Início ${SC.PERIODS[p]} ${w}"><span>às</span><input type="time" name="e_${i}_${p}" value="${b?.end || def[p][1]}" step="300" aria-label="Fim ${SC.PERIODS[p]} ${w}">
          </div>`; })}</div>
        </div>`;
      })}</div>
      <div class="esc-grid">
        <h3>Grade de horários</h3>
        <p class="muted small">Define os horários que o atendente virtual e o agendamento online oferecem dentro de cada período.</p>
        <div class="form-grid">
          <label class="fld"><span>Duração da sessão</span><select name="session_min"><option value="">Padrão do sistema (${gDefault.duration} min)</option>${[30, 40, 45, 50, 60, 90].map((m) => html`<option value="${m}" ${sched.grid.duration === m ? raw('selected') : ''}>${m} min</option>`)}</select></label>
          <label class="fld"><span>Entre uma sessão e outra</span><select name="interval_min">${[[0, 'Sem intervalo (sessões seguidas)'], [5, 'Intervalo de 5 min'], [10, 'Intervalo de 10 min'], [15, 'Intervalo de 15 min'], [20, 'Intervalo de 20 min'], [30, 'Intervalo de 30 min']].map(([m, l]) => html`<option value="${m}" ${(sched.grid.interval ?? (gDefault.interval)) === m ? raw('selected') : ''}>${l}</option>`)}</select></label>
        </div>
        <p class="muted small">Exemplo com a grade atual: ${gridExample}.</p>
      </div>
      <p class="muted small">${sched.configured ? html`Escala atual: <b>${SC.summary(sched)}</b>` : 'Ainda sem escala: a agenda aceita sessões em qualquer dia e horário até você salvar.'}</p>
      <div class="actions"><button class="btn">Salvar escala</button>
        ${sched.configured ? html`<button class="btn ghost" formaction="/escala/remover" data-confirm-btn="Remover a escala? A agenda volta a aceitar qualquer dia e horário.">Remover escala</button>` : ''}</div>
    </form>

    <section class="card">
      <div class="esc-head"><h2>Bloquear dias específicos no mês</h2>
        <div class="esc-month"><a class="btn ghost" href="${back(prof.id, addMonths(ym, -1))}#mes" aria-label="Mês anterior">←</a><b>${monthName(ym)}</b><a class="btn ghost" href="${back(prof.id, addMonths(ym, 1))}#mes" aria-label="Próximo mês">→</a></div></div>
      <p class="muted small" id="mes">Toque em uma data para alternar entre <b>Atende</b> e <b>Folga</b>.</p>
      ${workDays.length ? html`
        <div class="actions" style="margin-bottom:14px">
          <form method="post" action="/escala/mes" data-confirm="Bloquear todos os dias de atendimento de ${monthName(ym)}?"><input type="hidden" name="prof" value="${prof.id}"><input type="hidden" name="mes" value="${ym}"><input type="hidden" name="acao" value="bloquear"><button class="chip danger">Bloquear todas do mês</button></form>
          <form method="post" action="/escala/mes"><input type="hidden" name="prof" value="${prof.id}"><input type="hidden" name="mes" value="${ym}"><input type="hidden" name="acao" value="liberar"><button class="chip okc">Liberar todas do mês</button></form>
        </div>
        ${workDays.map((wd) => {
          const list = dates.filter((d) => SC.dow(d) === wd);
          return html`<div class="esc-group"><div class="esc-group-h"><span class="dot"></span><b>${SC.WEEKDAY_PLURAL[wd]} de ${monthName(ym).split(' ')[0]}</b><small class="muted">${list.length} dias</small></div>
          <div class="esc-dates">${list.map((d, i) => {
            const bl = blockMap[d]; const past = d < today;
            return html`<form method="post" action="/escala/bloqueio" class="esc-date ${bl ? 'off' : ''} ${past ? 'past' : ''}">
              <input type="hidden" name="prof" value="${prof.id}"><input type="hidden" name="mes" value="${ym}"><input type="hidden" name="data" value="${d}">
              <button ${past ? raw('disabled') : ''} title="${bl ? 'Liberar este dia' : 'Bloquear este dia'}">
                <span class="esc-date-h"><b>${i + 1}ª ${SC.WEEKDAYS[wd].charAt(0) + SC.WEEKDAYS[wd].slice(1).toLowerCase()}</b><small>${d.slice(8, 10)}/${d.slice(5, 7)}</small></span>
                <span class="esc-state">${bl ? html`⊘ Folga${bl.reason ? html`<small>${bl.reason}</small>` : ''}` : html`✓ Atende`}</span>
                ${sessMap[d] ? html`<small class="esc-sess">${sessMap[d]} sessão(ões)</small>` : ''}
              </button></form>`;
          })}</div></div>`;
        })}` : html`<p class="flash warn">Defina primeiro os dias da semana de atendimento. Enquanto isso, você pode bloquear datas avulsas abaixo.</p>`}

      <h3 class="esc-sub">Bloquear outra data (qualquer dia do ano)</h3>
      <form method="post" action="/escala/avulsa" class="esc-avulsa">
        <input type="hidden" name="prof" value="${prof.id}"><input type="hidden" name="mes" value="${ym}">
        <label class="fld"><span>De</span><input type="date" name="de" required min="${today}"></label>
        <label class="fld"><span>Até (opcional, para férias)</span><input type="date" name="ate" min="${today}"></label>
        <label class="fld"><span>Motivo</span><input name="motivo" maxlength="120" placeholder="Feriado, férias, congresso…"></label>
        <button class="btn">Bloquear</button>
      </form>
    </section>

    <section class="card flush"><h2 class="pad-h">Próximos bloqueios</h2>
      ${upcoming.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Data</th><th>Dia</th><th>Motivo</th><th></th></tr></thead>
      <tbody>${upcoming.map((b) => html`<tr><td>${brDate(b.block_date)}</td><td>${SC.WEEKDAY_NAMES[SC.dow(b.block_date)]}</td><td>${b.reason || '—'}</td>
        <td><form method="post" action="/escala/liberar"><input type="hidden" name="prof" value="${prof.id}"><input type="hidden" name="mes" value="${ym}"><input type="hidden" name="id" value="${b.id}"><button class="link small btnlink">liberar</button></form></td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhuma data bloqueada.</p>`}
    </section>`,
  }));
});

// ---------- salvar escala semanal ----------
r.post('/semana', async (req, res) => {
  const { prof } = await pickProfessional(req);
  const b = req.body; const days = {};
  const toMin = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  for (let i = 0; i < 7; i++) {
    if (!b[`day_${i}`]) continue;
    const blocks = [];
    for (const p of [1, 2, 3]) {
      if (!b[`b_${i}_${p}`]) continue;
      const start = isHm(b[`s_${i}_${p}`]) ? b[`s_${i}_${p}`] : null; const end = isHm(b[`e_${i}_${p}`]) ? b[`e_${i}_${p}`] : null;
      if (!start || !end) return res.flash(`Em ${SC.WEEKDAY_NAMES[i]}, preencha início e fim do período da ${SC.PERIODS[p].toLowerCase()}.`, 'err').redirect(back(prof.id, b.mes));
      if (end <= start) return res.flash(`Em ${SC.WEEKDAY_NAMES[i]} (${SC.PERIODS[p].toLowerCase()}), o horário final precisa ser depois do inicial.`, 'err').redirect(back(prof.id, b.mes));
      blocks.push({ period: p, start, end });
    }
    if (!blocks.length) return res.flash(`Em ${SC.WEEKDAY_NAMES[i]}, marque pelo menos um período (manhã, tarde ou noite) ou desmarque o dia.`, 'err').redirect(back(prof.id, b.mes));
    blocks.sort((x, y) => x.start.localeCompare(y.start));
    for (let k = 1; k < blocks.length; k++) if (toMin(blocks[k].start) < toMin(blocks[k - 1].end)) return res.flash(`Em ${SC.WEEKDAY_NAMES[i]}, os períodos ${SC.PERIODS[blocks[k - 1].period].toLowerCase()} e ${SC.PERIODS[blocks[k].period].toLowerCase()} se sobrepõem.`, 'err').redirect(back(prof.id, b.mes));
    days[i] = blocks;
  }
  const dur = [30, 40, 45, 50, 60, 90].includes(int(b.session_min)) ? int(b.session_min) : null;
  const interval = [0, 5, 10, 15, 20, 30].includes(int(b.interval_min)) ? int(b.interval_min) : 0;
  await SC.saveSchedule(prof.id, days, { duration: dur, interval });
  await audit(req, 'escala-salvar', `user:${prof.id}`);
  // Sessões futuras que ficaram fora da nova escala
  const future = await q(`SELECT a.id, a.starts_at, a.duration_min FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.owner_id = ? AND a.status IN ('agendada','confirmada') AND a.starts_at >= NOW() ORDER BY a.starts_at LIMIT 300`, [prof.id]);
  const sched = await SC.getSchedule(prof.id);
  let outside = 0;
  for (const a of future) if (!(await SC.checkSlot(prof.id, a.starts_at, a.duration_min, sched)).ok) outside++;
  res.flash(`Escala salva: ${SC.summary(sched)}.${outside ? ` Atenção: ${outside} sessão(ões) já agendada(s) ficaram fora da escala — confira a agenda.` : ''}`, outside ? 'warn' : 'ok')
    .redirect(back(prof.id, b.mes));
});

r.post('/remover', async (req, res) => {
  const { prof } = await pickProfessional(req);
  await SC.clearSchedule(prof.id);
  await audit(req, 'escala-remover', `user:${prof.id}`);
  res.flash('Escala removida: a agenda aceita qualquer dia e horário.').redirect(back(prof.id, req.body.mes));
});

async function sessionsOn(profId, ymd) {
  const row = await one(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.owner_id = ? AND a.status IN ('agendada','confirmada') AND a.starts_at >= ? AND a.starts_at < ?`, [profId, ymd, addDays(ymd, 1)]);
  return Number(row.n);
}

// ---------- alternar uma data ----------
r.post('/bloqueio', async (req, res) => {
  const { prof } = await pickProfessional(req);
  const d = req.body.data;
  if (!isYmd(d) || d < todayLocal()) return res.flash('Data inválida.', 'err').redirect(back(prof.id, req.body.mes));
  const ex = await one('SELECT id FROM schedule_blocks WHERE user_id = ? AND block_date = ?', [prof.id, d]);
  if (ex) {
    await q('DELETE FROM schedule_blocks WHERE id = ?', [ex.id]);
    await audit(req, 'escala-liberar', `user:${prof.id} ${d}`);
    return res.flash(`${brDate(d)} liberado para atendimento.`).redirect(`${back(prof.id, req.body.mes)}#mes`);
  }
  await q('INSERT INTO schedule_blocks (user_id, block_date, reason, created_by) VALUES (?,?,?,?)', [prof.id, d, 'Folga', req.user.id]);
  await audit(req, 'escala-bloquear', `user:${prof.id} ${d}`);
  const n = await sessionsOn(prof.id, d);
  res.flash(n ? `${brDate(d)} bloqueado. Atenção: há ${n} sessão(ões) agendada(s) nesse dia — remarque pela agenda.` : `${brDate(d)} bloqueado.`, n ? 'warn' : 'ok')
    .redirect(`${back(prof.id, req.body.mes)}#mes`);
});

// ---------- bloquear / liberar o mês inteiro (dias de atendimento) ----------
r.post('/mes', async (req, res) => {
  const { prof } = await pickProfessional(req);
  const ym = isYm(req.body.mes) ? req.body.mes : todayLocal().slice(0, 7);
  const sched = await SC.getSchedule(prof.id);
  const today = todayLocal();
  const dates = monthDates(ym).filter((d) => d >= today && sched.days[SC.dow(d)]);
  if (req.body.acao === 'liberar') {
    const out = await q('DELETE FROM schedule_blocks WHERE user_id = ? AND block_date >= ? AND block_date <= ?', [prof.id, `${ym}-01`, `${ym}-31`]);
    await audit(req, 'escala-liberar-mes', `user:${prof.id} ${ym}`);
    return res.flash(`${out.affectedRows} dia(s) liberado(s) em ${monthName(ym)}.`).redirect(`${back(prof.id, ym)}#mes`);
  }
  let n = 0, withSessions = 0;
  for (const d of dates) {
    const r2 = await q('INSERT IGNORE INTO schedule_blocks (user_id, block_date, reason, created_by) VALUES (?,?,?,?)', [prof.id, d, 'Folga', req.user.id]);
    n += r2.affectedRows;
    if (await sessionsOn(prof.id, d)) withSessions++;
  }
  await audit(req, 'escala-bloquear-mes', `user:${prof.id} ${ym}`);
  res.flash(`${n} dia(s) bloqueado(s) em ${monthName(ym)}.${withSessions ? ` Atenção: ${withSessions} dia(s) têm sessões agendadas.` : ''}`, withSessions ? 'warn' : 'ok').redirect(`${back(prof.id, ym)}#mes`);
});

// ---------- data avulsa ou período (férias) ----------
r.post('/avulsa', async (req, res) => {
  const { prof } = await pickProfessional(req);
  const b = req.body;
  const de = b.de, ate = isYmd(b.ate) ? b.ate : b.de;
  if (!isYmd(de) || de < todayLocal() || ate < de) return res.flash('Período inválido.', 'err').redirect(back(prof.id, b.mes));
  const motivo = str(b.motivo, 120) || 'Bloqueado';
  let n = 0, withSessions = 0;
  for (let d = de, i = 0; d <= ate && i < 120; d = addDays(d, 1), i++) {
    await q('INSERT INTO schedule_blocks (user_id, block_date, reason, created_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE reason = VALUES(reason)', [prof.id, d, motivo, req.user.id]);
    n++;
    if (await sessionsOn(prof.id, d)) withSessions++;
  }
  await audit(req, 'escala-bloquear-periodo', `user:${prof.id} ${de}..${ate}`);
  res.flash(`${n === 1 ? brDate(de) : `${n} dias (${brDate(de)} a ${brDate(ate)})`} bloqueado(s): ${motivo}.${withSessions ? ` Atenção: ${withSessions} dia(s) têm sessões agendadas.` : ''}`, withSessions ? 'warn' : 'ok')
    .redirect(back(prof.id, b.mes));
});

r.post('/liberar', async (req, res) => {
  const { prof } = await pickProfessional(req);
  await q('DELETE FROM schedule_blocks WHERE id = ? AND user_id = ?', [int(req.body.id), prof.id]);
  await audit(req, 'escala-liberar', `user:${prof.id}`);
  res.flash('Data liberada.').redirect(back(prof.id, req.body.mes));
});

export default r;
