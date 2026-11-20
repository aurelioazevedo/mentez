// Escala semanal e bloqueios de datas por profissional.
// Profissional sem escala configurada não tem restrição (compatível com o uso anterior).
import { q, one } from './db.js';
import { addMinutes } from './time.js';

export const WEEKDAYS = ['DOM', 'SEG', 'TER', 'QUA', 'QUI', 'SEX', 'SÁB'];
export const WEEKDAY_NAMES = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];
export const WEEKDAY_PLURAL = ['Domingos', 'Segundas-feiras', 'Terças-feiras', 'Quartas-feiras', 'Quintas-feiras', 'Sextas-feiras', 'Sábados'];

export function dow(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export const PERIODS = { 1: 'Manhã', 2: 'Tarde', 3: 'Noite' };
// Escala: até 3 blocos por dia (manhã, tarde, noite) + grade (duração da sessão e intervalo entre sessões).
export async function getSchedule(userId) {
  const [meta, days] = await Promise.all([
    one('SELECT configured_at, session_min, interval_min FROM schedule_meta WHERE user_id = ?', [userId]),
    q('SELECT weekday, period, start_time, end_time FROM schedule_days WHERE user_id = ? ORDER BY weekday, start_time', [userId]),
  ]);
  const map = {};
  for (const d of days) {
    const day = (map[d.weekday] ||= { start: d.start_time, end: d.end_time, blocks: [] });
    day.blocks.push({ period: d.period, start: d.start_time, end: d.end_time });
    if (d.start_time < day.start) day.start = d.start_time;
    if (d.end_time > day.end) day.end = d.end_time;
  }
  return { configured: !!meta, days: map, grid: { duration: meta?.session_min || null, interval: meta?.interval_min ?? null } };
}

// days: { weekday: [{ period, start, end }, ...] } (aceita também { weekday: { start, end } }, um bloco só)
export async function saveSchedule(userId, days, grid = undefined) {
  await q('DELETE FROM schedule_days WHERE user_id = ?', [userId]);
  for (const [wd, v] of Object.entries(days)) {
    const blocks = Array.isArray(v) ? v : [{ period: 1, ...v }];
    for (const b of blocks) await q('INSERT INTO schedule_days (user_id, weekday, period, start_time, end_time) VALUES (?,?,?,?,?)', [userId, Number(wd), Number(b.period) || 1, b.start, b.end]);
  }
  await q('INSERT INTO schedule_meta (user_id) VALUES (?) ON DUPLICATE KEY UPDATE configured_at = NOW()', [userId]);
  if (grid !== undefined) await q('UPDATE schedule_meta SET session_min = ?, interval_min = ? WHERE user_id = ?', [grid?.duration || null, grid ? (grid.interval ?? null) : null, userId]);
}
// Grade do profissional (ou a padrão do sistema): duração da sessão e passo entre os horários oferecidos
export function gridOf(sched, fallbackDuration = 40, fallbackStep = 60) {
  const g = sched?.grid || {};
  const duration = g.duration || fallbackDuration;
  if (g.interval !== null && g.interval !== undefined) return { duration, step: duration + Number(g.interval), interval: Number(g.interval), own: true };
  if (g.duration) return { duration, step: duration + Math.max(0, fallbackStep - fallbackDuration), interval: Math.max(0, fallbackStep - fallbackDuration), own: true };
  return { duration, step: fallbackStep, interval: Math.max(0, fallbackStep - fallbackDuration), own: false };
}
// Horários de início possíveis num dia, respeitando cada bloco (manhã/tarde/noite)
export function startsIn(st, ymd, duration, step) {
  const out = [];
  const blocks = st.blocks?.length ? st.blocks : [{ start: st.start, end: st.end }];
  for (const b of blocks) {
    for (let t = `${ymd} ${b.start}:00`; addMinutes(t, duration).slice(0, 10) === ymd && addMinutes(t, duration).slice(11, 16) <= b.end; t = addMinutes(t, step)) out.push(t);
  }
  return out;
}

export async function clearSchedule(userId) {
  await q('DELETE FROM schedule_days WHERE user_id = ?', [userId]);
  await q('DELETE FROM schedule_meta WHERE user_id = ?', [userId]);
}

export async function blocksBetween(userId, from, to) {
  const rows = await q('SELECT id, block_date, reason FROM schedule_blocks WHERE user_id = ? AND block_date >= ? AND block_date <= ? ORDER BY block_date', [userId, from, to]);
  return rows.map((r) => ({ ...r, block_date: String(r.block_date).slice(0, 10) }));
}

// Situação de um dia para o profissional: { works, blocked, reason, start, end }
export async function dayStatus(userId, ymd, sched = null) {
  sched = sched || (await getSchedule(userId));
  const block = await one('SELECT reason FROM schedule_blocks WHERE user_id = ? AND block_date = ?', [userId, ymd]);
  if (block) return { works: false, blocked: true, reason: block.reason || 'Data bloqueada' };
  if (!sched.configured) return { works: true, unrestricted: true };
  const d = sched.days[dow(ymd)];
  if (!d) return { works: false, blocked: false, reason: `Folga (${WEEKDAY_NAMES[dow(ymd)]})` };
  return { works: true, start: d.start, end: d.end, blocks: d.blocks };
}

// Verifica se uma sessão cabe na escala. Retorna { ok, reason }.
export async function checkSlot(userId, startDt, durationMin, sched = null) {
  if (!userId) return { ok: true };
  const ymd = startDt.slice(0, 10);
  const st = await dayStatus(userId, ymd, sched);
  if (!st.works) return { ok: false, reason: st.reason };
  if (st.unrestricted) return { ok: true };
  const begin = startDt.slice(11, 16);
  const end = addMinutes(startDt, durationMin).slice(11, 16);
  const crossesMidnight = addMinutes(startDt, durationMin).slice(0, 10) !== ymd;
  const blocks = st.blocks?.length ? st.blocks : [{ start: st.start, end: st.end }];
  if (crossesMidnight || !blocks.some((b) => begin >= b.start && end <= b.end)) return { ok: false, reason: `Fora do horário de atendimento (${blocks.map((b) => `${b.start}–${b.end}`).join(', ')})` };
  return { ok: true };
}

// Resumo legível da escala: “QUI 08:00–18:00 · SEX 13:00–19:00”
export function summary(sched) {
  if (!sched.configured) return 'Sem escala definida (todos os dias liberados)';
  const ks = Object.keys(sched.days).map(Number).sort();
  if (!ks.length) return 'Nenhum dia de atendimento';
  return ks.map((k) => `${WEEKDAYS[k]} ${(sched.days[k].blocks || [sched.days[k]]).map((b) => `${b.start}–${b.end}`).join(' e ')}`).join(' · ');
}
