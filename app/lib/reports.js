// Relatórios gerenciais (BI): agenda e presença, financeiro, pacientes, profissionais e captação.
// Tudo calculado a partir dos dados do sistema, com filtros de período, profissional e modalidade,
// comparação com o período anterior e destaques automáticos.
import { q, one } from './db.js';
import { todayLocal, nowLocal, addDays, addMonths, monthName } from './time.js';

// ---------- período ----------
export const PRESETS = {
  mes: 'Este mês', mes_ant: 'Mês passado', '30d': 'Últimos 30 dias', '90d': 'Últimos 90 dias',
  tri: 'Este trimestre', ano: 'Este ano', ano_ant: 'Ano passado', '12m': 'Últimos 12 meses', custom: 'Personalizado',
};
const lastDay = (ym) => addDays(`${addMonths(ym, 1)}-01`, -1);
export function range(preset, de, ate) {
  const t = todayLocal(); const ym = t.slice(0, 7); const y = t.slice(0, 4);
  switch (preset) {
    case 'mes_ant': { const p = addMonths(ym, -1); return { from: `${p}-01`, to: lastDay(p) }; }
    case '30d': return { from: addDays(t, -29), to: t };
    case '90d': return { from: addDays(t, -89), to: t };
    case 'tri': { const m = Math.floor((Number(t.slice(5, 7)) - 1) / 3) * 3 + 1; const s = `${y}-${String(m).padStart(2, '0')}`; return { from: `${s}-01`, to: lastDay(addMonths(s, 2)) }; }
    case 'ano': return { from: `${y}-01-01`, to: `${y}-12-31` };
    case 'ano_ant': return { from: `${Number(y) - 1}-01-01`, to: `${Number(y) - 1}-12-31` };
    case '12m': return { from: `${addMonths(ym, -11)}-01`, to: lastDay(ym) };
    case 'custom': if (/^\d{4}-\d{2}-\d{2}$/.test(de) && /^\d{4}-\d{2}-\d{2}$/.test(ate) && de <= ate) return { from: de, to: ate > addDays(de, 3 * 366) ? addDays(de, 3 * 366) : ate }; // eslint-disable-line no-fallthrough
    default: return { from: `${ym}-01`, to: lastDay(ym) };
  }
}
export const daysBetween = (a, b) => Math.round((Date.UTC(...b.split('-').map((x, i) => (i === 1 ? x - 1 : +x))) - Date.UTC(...a.split('-').map((x, i) => (i === 1 ? x - 1 : +x)))) / 864e5);
export function previous(r) {
  const len = daysBetween(r.from, r.to) + 1;
  // meses inteiros comparam com os meses anteriores (fevereiro × janeiro), não com N dias
  if (r.from.endsWith('-01') && r.to === lastDay(r.to.slice(0, 7))) {
    const months = (Number(r.to.slice(0, 4)) - Number(r.from.slice(0, 4))) * 12 + Number(r.to.slice(5, 7)) - Number(r.from.slice(5, 7)) + 1;
    const s = addMonths(r.from.slice(0, 7), -months);
    return { from: `${s}-01`, to: lastDay(addMonths(s, months - 1)) };
  }
  return { from: addDays(r.from, -len), to: addDays(r.from, -1) };
}
// Agrupamento automático: dia (até 35 dias), semana (até ~6 meses) ou mês
export function grain(r) { const n = daysBetween(r.from, r.to) + 1; return n <= 35 ? 'dia' : n <= 190 ? 'semana' : 'mes'; }
export const bucketSql = (col, g) => (g === 'dia' ? `DATE(${col})` : g === 'semana' ? `DATE(DATE_SUB(${col}, INTERVAL WEEKDAY(${col}) DAY))` : `DATE_FORMAT(${col}, '%Y-%m-01')`);
function mondayOf(ymd) { const d = new Date(`${ymd}T12:00:00Z`).getUTCDay(); return addDays(ymd, d === 0 ? -6 : 1 - d); }
export function buckets(r, g) {
  const out = [];
  let k = g === 'dia' ? r.from : g === 'semana' ? mondayOf(r.from) : `${r.from.slice(0, 7)}-01`;
  while (k <= r.to && out.length < 400) { out.push(k); k = g === 'dia' ? addDays(k, 1) : g === 'semana' ? addDays(k, 7) : `${addMonths(k.slice(0, 7), 1)}-01`; }
  return out;
}
const MES3 = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export function bucketLabel(k, g) {
  const [y, m, d] = k.split('-');
  if (g === 'mes') return { label: `${MES3[m - 1]}${Number(y) % 100 !== Number(todayLocal().slice(2, 4)) ? `/${y.slice(2)}` : ''}`, full: monthName(`${y}-${m}`) };
  if (g === 'semana') return { label: `${d}/${m}`, full: `semana de ${d}/${m}/${y}` };
  return { label: `${d}/${m}`, full: `${d}/${m}/${y}` };
}
export const bucketRange = (k, g) => (g === 'dia' ? { from: k, to: k } : g === 'semana' ? { from: k, to: addDays(k, 6) } : { from: k, to: lastDay(k.slice(0, 7)) });

// ---------- filtros ----------
// f = { from, to, prof, mod, clinic (true = vê a clínica toda) }
const dt = (r) => [`${r.from} 00:00:00`, `${addDays(r.to, 1)} 00:00:00`];
function scopeA(f) {
  const w = []; const p = [];
  if (f.prof) { w.push('p.owner_id = ?'); p.push(f.prof); }
  if (f.mod) { w.push('a.modality = ?'); p.push(f.mod); }
  return { sql: w.map((x) => ` AND ${x}`).join(''), p };
}
function scopePay(f) {
  const w = []; const p = [];
  if (f.prof) { w.push('COALESCE(x.professional_id, p.owner_id) = ?'); p.push(f.prof); }
  if (f.mod) { w.push('ap.modality = ?'); p.push(f.mod); }
  return { sql: w.map((x) => ` AND ${x}`).join(''), p };
}
const PAY_FROM = 'FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN appointments ap ON ap.id = x.appointment_id';
const num = (v) => Number(v || 0);
const pct = (a, b) => (b ? a / b : null);

// ---------- agenda e presença ----------
export async function agendaTotals(f, r) {
  const s = scopeA(f); const [a, b] = dt(r);
  const rows = await q(`SELECT a.status, (a.starts_at < ?) past, COUNT(*) n, SUM(a.duration_min) mins FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY a.status, past`, [nowLocal(), a, b, ...s.p]);
  const t = { realizada: 0, falta: 0, cancelada: 0, agendada: 0, pendente: 0, total: 0, mins: 0, realizadaMins: 0 };
  for (const x of rows) {
    const n = num(x.n);
    if (x.status === 'realizada') { t.realizada += n; t.realizadaMins += num(x.mins); } else if (x.status === 'falta') t.falta += n; else if (x.status === 'cancelada') t.cancelada += n;
    else if (Number(x.past)) t.pendente += n; else t.agendada += n; // passou sem registrar presença
    t.total += n; if (x.status !== 'cancelada') t.mins += num(x.mins);
  }
  t.presenca = pct(t.realizada, t.realizada + t.falta);
  t.faltas = pct(t.falta, t.realizada + t.falta);
  t.cancelamento = pct(t.cancelada, t.total);
  return t;
}
export async function agendaSeries(f, r, g) {
  const s = scopeA(f); const [a, b] = dt(r);
  const rows = await q(`SELECT ${bucketSql('a.starts_at', g)} k, a.status, COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY k, a.status`, [a, b, ...s.p]);
  const map = {};
  for (const x of rows) { const k = String(x.k).slice(0, 10); (map[k] ||= {})[x.status === 'confirmada' ? 'agendada' : x.status] = ((map[k] || {})[x.status === 'confirmada' ? 'agendada' : x.status] || 0) + num(x.n); }
  return buckets(r, g).map((k) => ({ k, ...bucketLabel(k, g), realizada: map[k]?.realizada || 0, agendada: map[k]?.agendada || 0, falta: map[k]?.falta || 0, cancelada: map[k]?.cancelada || 0 }));
}
// Mapa de calor: dia da semana × hora (sessões realizadas e taxa de faltas)
export async function heat(f, r) {
  const s = scopeA(f); const [a, b] = dt(r);
  const rows = await q(`SELECT DAYOFWEEK(a.starts_at) - 1 wd, HOUR(a.starts_at) h, SUM(a.status = 'realizada') ok, SUM(a.status = 'falta') falta, SUM(a.status <> 'cancelada') n
    FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY wd, h`, [a, b, ...s.p]);
  return rows.map((x) => ({ wd: Number(x.wd), h: Number(x.h), ok: num(x.ok), falta: num(x.falta), n: num(x.n) }));
}
export async function weekdayStats(f, r) {
  const s = scopeA(f); const [a, b] = dt(r);
  const rows = await q(`SELECT DAYOFWEEK(a.starts_at) - 1 wd, SUM(a.status = 'realizada') ok, SUM(a.status = 'falta') falta, SUM(a.status = 'cancelada') canc
    FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY wd ORDER BY wd`, [a, b, ...s.p]);
  return rows.map((x) => ({ wd: Number(x.wd), ok: num(x.ok), falta: num(x.falta), canc: num(x.canc), faltas: pct(num(x.falta), num(x.ok) + num(x.falta)) }));
}
// Confirmação: quem confirmou falta menos? (sessões já ocorridas, com lembrete enviado)
export async function confirmations(f, r) {
  const s = scopeA(f); const [a, b] = dt(r);
  const end = b < nowLocal() ? b : nowLocal();
  const rows = await q(`SELECT CASE WHEN a.wa_reply = 'confirmou' THEN IF(a.reply_channel = 'link', 'link', 'whatsapp') WHEN a.wa_reply = 'remarcar' THEN 'remarcar'
        WHEN a.wa_reminder_at IS NOT NULL OR a.email_reminder_at IS NOT NULL OR a.sms_reminder_at IS NOT NULL THEN 'sem_resposta' ELSE 'sem_lembrete' END c,
      SUM(a.status = 'realizada') ok, SUM(a.status = 'falta') falta, COUNT(*) n
    FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status IN ('realizada','falta') ${s.sql} GROUP BY c`, [a, end, ...s.p]);
  const by = Object.fromEntries(rows.map((x) => [x.c, { ok: num(x.ok), falta: num(x.falta), n: num(x.n) }]));
  const conf = ['whatsapp', 'link'].reduce((acc, k) => ({ ok: acc.ok + (by[k]?.ok || 0), falta: acc.falta + (by[k]?.falta || 0) }), { ok: 0, falta: 0 });
  const nconf = ['sem_resposta', 'sem_lembrete'].reduce((acc, k) => ({ ok: acc.ok + (by[k]?.ok || 0), falta: acc.falta + (by[k]?.falta || 0) }), { ok: 0, falta: 0 });
  return { by, confFaltas: pct(conf.falta, conf.ok + conf.falta), naoConfFaltas: pct(nconf.falta, nconf.ok + nconf.falta), confN: conf.ok + conf.falta, naoConfN: nconf.ok + nconf.falta };
}
export const VIA = { sistema: 'Equipe (sistema)', agente: 'Atendente virtual (WhatsApp)', online: 'Agendamento online (site)', lista_espera: 'Lista de espera' };
export async function originOfBookings(f, r) {
  const s = scopeA(f); const [a, b] = dt(r);
  const rows = await q(`SELECT a.created_via v, COUNT(*) n, AVG(GREATEST(0, DATEDIFF(a.starts_at, a.created_at))) lead FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.created_at >= ? AND a.created_at < ? ${s.sql} GROUP BY v ORDER BY n DESC`, [a, b, ...s.p]);
  return rows.map((x) => ({ key: x.v, label: VIA[x.v] || x.v, n: num(x.n), lead: Number(x.lead || 0) }));
}
export async function modalitySplit(f, r) {
  const s = scopeA(f); const [a, b] = dt(r);
  const rows = await q(`SELECT a.modality m, COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status = 'realizada' ${s.sql} GROUP BY m`, [a, b, ...s.p]);
  return Object.fromEntries(rows.map((x) => [x.m, num(x.n)]));
}
// Ocupação: horas atendidas/agendadas ÷ horas disponíveis na escala (folgas descontadas)
export async function occupancy(f, r, profIds) {
  const ids = f.prof ? [f.prof] : profIds;
  if (!ids.length) return null;
  const days = await q(`SELECT user_id, weekday, start_time, end_time FROM schedule_days WHERE user_id IN (?)`, [ids]);
  if (!days.length) return null;
  const blocks = await q('SELECT user_id, block_date FROM schedule_blocks WHERE user_id IN (?) AND block_date BETWEEN ? AND ?', [ids, r.from, r.to]);
  const blocked = new Set(blocks.map((x) => `${x.user_id}|${String(x.block_date).slice(0, 10)}`));
  const per = {}; for (const d of days) (per[d.user_id] ||= {})[d.weekday] = ((per[d.user_id] || {})[d.weekday] || 0) + Math.max(0, (toMin(d.end_time) - toMin(d.start_time)));
  let cap = 0; const capBy = {};
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    for (const uid of Object.keys(per)) if (!blocked.has(`${uid}|${d}`)) { const m = per[uid][wd] || 0; cap += m; capBy[uid] = (capBy[uid] || 0) + m; }
  }
  const s = scopeA({ ...f, prof: null }); const [a, b] = dt(r);
  const used = await q(`SELECT p.owner_id u, SUM(a.duration_min) m FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= ? AND a.starts_at < ? AND a.status <> 'cancelada' AND p.owner_id IN (?) ${s.sql} GROUP BY u`, [a, b, Object.keys(per).map(Number), ...s.p]);
  const usedBy = Object.fromEntries(used.map((x) => [x.u, num(x.m)]));
  const usedTot = Object.values(usedBy).reduce((x, y) => x + y, 0);
  return { cap, used: usedTot, rate: pct(usedTot, cap), free: Math.max(0, cap - usedTot), by: Object.fromEntries(Object.keys(capBy).map((u) => [u, { cap: capBy[u], used: usedBy[u] || 0, rate: pct(usedBy[u] || 0, capBy[u]) }])) };
}
const toMin = (hm) => { const [h, m] = String(hm).split(':').map(Number); return h * 60 + (m || 0); };

// ---------- financeiro ----------
export const METHODS = { pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', transferencia: 'Transferência', boleto: 'Boleto', outro: 'Outro', null: 'Não informado' };
export const ORIGINS = { sessao: 'Sessões', pacote: 'Pacotes', falta: 'Faltas cobradas', avulso: 'Avulsos', convenio: 'Convênios' };
export async function financeTotals(f, r) {
  const s = scopePay(f);
  const today = todayLocal();
  const [rec, fat, open, overdue, share, sessions] = await Promise.all([
    one(`SELECT COALESCE(SUM(x.amount),0) v, COUNT(*) n ${PAY_FROM} WHERE x.paid_at BETWEEN ? AND ? ${s.sql}`, [r.from, r.to, ...s.p]),
    one(`SELECT COALESCE(SUM(x.amount),0) v, COUNT(*) n ${PAY_FROM} WHERE x.due_date BETWEEN ? AND ? ${s.sql}`, [r.from, r.to, ...s.p]),
    one(`SELECT COALESCE(SUM(x.amount),0) v, COUNT(*) n ${PAY_FROM} WHERE x.paid_at IS NULL AND x.due_date BETWEEN ? AND ? AND x.due_date >= ? ${s.sql}`, [r.from, r.to, today, ...s.p]),
    one(`SELECT COALESCE(SUM(x.amount),0) v, COUNT(*) n, COUNT(DISTINCT x.patient_id) pac ${PAY_FROM} WHERE x.paid_at IS NULL AND x.due_date < ? AND x.origin <> 'convenio' ${s.sql}`, [today, ...s.p]),
    one(`SELECT COALESCE(SUM(CASE WHEN x.clinic_share IS NOT NULL THEN x.clinic_share ELSE 0 END),0) clinic, COALESCE(SUM(CASE WHEN x.clinic_share IS NOT NULL THEN x.amount - x.clinic_share ELSE 0 END),0) pro ${PAY_FROM} WHERE x.paid_at BETWEEN ? AND ? ${s.sql}`, [r.from, r.to, ...s.p]),
    agendaTotals(f, r),
  ]);
  const recebido = num(rec.v); const faturado = num(fat.v);
  return { recebido, recebidoN: num(rec.n), faturado, faturadoN: num(fat.n), aReceber: num(open.v), atrasado: num(overdue.v), atrasadoN: num(overdue.n), atrasadoPac: num(overdue.pac),
    ticket: sessions.realizada ? recebido / sessions.realizada : null, repasseClinica: num(share.clinic), repasseProf: num(share.pro), conversao: pct(recebido, faturado) };
}
export async function revenueSeries(f, r, g) {
  const s = scopePay(f);
  const rows = await q(`SELECT ${bucketSql('x.paid_at', g)} k, SUM(x.amount) v FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN appointments ap ON ap.id = x.appointment_id
    WHERE x.paid_at BETWEEN ? AND ? ${s.sql} GROUP BY k`, [r.from, r.to, ...s.p]);
  const map = Object.fromEntries(rows.map((x) => [String(x.k).slice(0, 10), num(x.v)]));
  return buckets(r, g).map((k) => ({ k, ...bucketLabel(k, g), value: map[k] || 0 }));
}
export async function revenueBy(f, r, field) {
  const s = scopePay(f);
  const col = field === 'method' ? 'x.method' : field === 'origin' ? 'x.origin' : 'COALESCE(x.professional_id, p.owner_id)';
  const rows = await q(`SELECT ${col} k, SUM(x.amount) v, COUNT(*) n ${PAY_FROM} WHERE x.paid_at BETWEEN ? AND ? ${s.sql} GROUP BY k ORDER BY v DESC`, [r.from, r.to, ...s.p]);
  return rows.map((x) => ({ key: x.k, value: num(x.v), n: num(x.n) }));
}
export async function onlineShare(f, r) {
  const s = scopePay(f);
  const row = await one(`SELECT COALESCE(SUM(g.amount),0) v, COALESCE(SUM(g.amount - COALESCE(g.net_value, g.amount)),0) fees, COUNT(*) n FROM gw_charges g JOIN payments x ON x.id = g.payment_id JOIN patients p ON p.id = x.patient_id LEFT JOIN appointments ap ON ap.id = x.appointment_id
    WHERE g.status IN ('RECEIVED','CONFIRMED') AND g.paid_date BETWEEN ? AND ? ${s.sql}`, [r.from, r.to, ...s.p]).catch(() => null);
  return row ? { value: num(row.v), fees: num(row.fees), n: num(row.n) } : { value: 0, fees: 0, n: 0 };
}
export async function aging(f) {
  const s = scopePay(f); const today = todayLocal();
  const rows = await q(`SELECT CASE WHEN DATEDIFF(?, x.due_date) <= 30 THEN '1-30' WHEN DATEDIFF(?, x.due_date) <= 60 THEN '31-60' WHEN DATEDIFF(?, x.due_date) <= 90 THEN '61-90' ELSE '90+' END b,
      SUM(x.amount) v, COUNT(*) n ${PAY_FROM} WHERE x.paid_at IS NULL AND x.due_date < ? AND x.origin <> 'convenio' ${s.sql} GROUP BY b`, [today, today, today, today, ...s.p]);
  const by = Object.fromEntries(rows.map((x) => [x.b, { v: num(x.v), n: num(x.n) }]));
  return ['1-30', '31-60', '61-90', '90+'].map((b) => ({ key: b, label: b === '90+' ? 'mais de 90 dias' : `${b} dias`, value: by[b]?.v || 0, n: by[b]?.n || 0 }));
}
export async function debtors(f, limit = 15) {
  const s = scopePay(f);
  return q(`SELECT p.id, p.name, p.social_name, SUM(x.amount) v, COUNT(*) n, MIN(x.due_date) oldest ${PAY_FROM} WHERE x.paid_at IS NULL AND x.due_date < ? AND x.origin <> 'convenio' ${s.sql} GROUP BY p.id ORDER BY v DESC LIMIT ?`, [todayLocal(), ...s.p, limit]);
}
// Despesas e outras receitas (Financeiro → lançamentos), para o resultado do período
export async function ledger(f, r) {
  const own = f.prof ? ['e.owner_id = ?', [f.prof]] : f.clinic ? ['e.owner_id IS NULL', []] : null;
  if (!own) return null;
  const rows = await q(`SELECT e.kind, COALESCE(c.name, 'Sem categoria') cat, SUM(e.amount) v FROM fin_entries e LEFT JOIN fin_categories c ON c.id = e.category_id
    WHERE e.paid_at BETWEEN ? AND ? AND ${own[0]} GROUP BY e.kind, cat ORDER BY v DESC`, [r.from, r.to, ...own[1]]);
  const desp = rows.filter((x) => x.kind === 'pagar').map((x) => ({ label: x.cat, value: num(x.v) }));
  const outras = rows.filter((x) => x.kind === 'receber').map((x) => ({ label: x.cat, value: num(x.v) }));
  return { despesas: desp, outras, totalDesp: desp.reduce((a, x) => a + x.value, 0), totalOutras: outras.reduce((a, x) => a + x.value, 0) };
}
export async function expenseSeries(f, r, g) {
  const own = f.prof ? ['owner_id = ?', [f.prof]] : f.clinic ? ['owner_id IS NULL', []] : null;
  if (!own) return null;
  const rows = await q(`SELECT ${bucketSql('paid_at', g)} k, SUM(amount) v FROM fin_entries WHERE kind = 'pagar' AND paid_at BETWEEN ? AND ? AND ${own[0]} GROUP BY k`, [r.from, r.to, ...own[1]]);
  const map = Object.fromEntries(rows.map((x) => [String(x.k).slice(0, 10), num(x.v)]));
  return buckets(r, g).map((k) => ({ k, value: map[k] || 0 }));
}

// ---------- pacientes ----------
async function sessionsByPatient(f) {
  const s = scopeA(f);
  return q(`SELECT a.patient_id id, MIN(a.starts_at) first, MAX(a.starts_at) last, COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.status = 'realizada' ${s.sql} GROUP BY a.patient_id`, s.p);
}
export async function patientStats(f, r) {
  const s = scopeA(f); const [a, b] = dt(r);
  const [all, active, firstVia, pats, revenue] = await Promise.all([
    sessionsByPatient(f),
    q(`SELECT DISTINCT a.patient_id id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status = 'realizada' AND a.starts_at >= ? AND a.starts_at < ? ${s.sql}`, [a, b, ...s.p]),
    q(`SELECT a.patient_id id, SUBSTRING_INDEX(GROUP_CONCAT(a.created_via ORDER BY a.created_at, a.id), ',', 1) via FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE 1=1 ${s.sql} GROUP BY a.patient_id`, s.p),
    q(`SELECT p.id, p.birth_date, p.status, p.created_at FROM patients p WHERE 1=1 ${f.prof ? 'AND p.owner_id = ?' : ''}`, f.prof ? [f.prof] : []),
    q(`SELECT x.patient_id id, SUM(x.amount) v FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.paid_at IS NOT NULL ${f.prof ? 'AND COALESCE(x.professional_id, p.owner_id) = ?' : ''} GROUP BY x.patient_id`, f.prof ? [f.prof] : []),
  ]);
  const inR = (d) => d >= a && d < b;
  const fmt = (d) => String(d).replace('T', ' ').slice(0, 19);
  const novos = all.filter((x) => inR(fmt(x.first)));
  const via = Object.fromEntries(firstVia.map((x) => [x.id, x.via]));
  const origem = {}; for (const x of novos) { const k = via[x.id] || 'sistema'; origem[k] = (origem[k] || 0) + 1; }
  const ativosSet = new Set(active.map((x) => x.id));
  const birth = Object.fromEntries(pats.map((p) => [p.id, p.birth_date]));
  const today = todayLocal();
  const ageOf = (bd) => { if (!bd) return null; const s2 = String(bd).slice(0, 10); let y = Number(today.slice(0, 4)) - Number(s2.slice(0, 4)); if (today.slice(5) < s2.slice(5)) y--; return y; };
  const faixas = { 'até 17': 0, '18–24': 0, '25–34': 0, '35–44': 0, '45–59': 0, '60+': 0, 'sem data': 0 };
  for (const id of ativosSet) { const ag = ageOf(birth[id]); const k = ag == null ? 'sem data' : ag < 18 ? 'até 17' : ag < 25 ? '18–24' : ag < 35 ? '25–34' : ag < 45 ? '35–44' : ag < 60 ? '45–59' : '60+'; faixas[k]++; }
  const dist = { '1': 0, '2–4': 0, '5–10': 0, '11–20': 0, '21–40': 0, '41+': 0 };
  for (const x of all) { const n = num(x.n); dist[n === 1 ? '1' : n <= 4 ? '2–4' : n <= 10 ? '5–10' : n <= 20 ? '11–20' : n <= 40 ? '21–40' : '41+']++; }
  const durations = all.filter((x) => num(x.n) > 1).map((x) => daysBetween(fmt(x.first).slice(0, 10), fmt(x.last).slice(0, 10)));
  const rev = revenue.map((x) => num(x.v)).filter((v) => v > 0);
  const status = {}; for (const p of pats) status[p.status] = (status[p.status] || 0) + 1;
  return {
    ativos: ativosSet.size, novos: novos.length, origem, faixas, dist, status,
    mediaSessoes: all.length ? all.reduce((x, y) => x + num(y.n), 0) / all.length : null,
    mediaDias: durations.length ? durations.reduce((x, y) => x + y, 0) / durations.length : null,
    ltv: rev.length ? rev.reduce((x, y) => x + y, 0) / rev.length : null,
    totalPacientes: pats.length,
  };
}
// Em risco: pacientes ativos sem sessão há 30+ dias e sem nada agendado
export async function atRisk(f, days = 30, limit = 25) {
  const s = scopeA(f); const now = nowLocal();
  return q(`SELECT p.id, p.name, p.social_name, p.phone, MAX(a.starts_at) last, COUNT(*) n FROM patients p JOIN appointments a ON a.patient_id = p.id
    WHERE p.status = 'ativo' AND a.status = 'realizada' ${s.sql}
      AND NOT EXISTS (SELECT 1 FROM appointments z WHERE z.patient_id = p.id AND z.status IN ('agendada','confirmada') AND z.starts_at >= ?)
    GROUP BY p.id HAVING last < DATE_SUB(?, INTERVAL ? DAY) ORDER BY last DESC LIMIT ?`, [...s.p, now, now, days, limit]);
}
export async function atRiskCount(f, days = 30) {
  const s = scopeA(f); const now = nowLocal();
  const r = await one(`SELECT COUNT(*) n FROM (SELECT p.id, MAX(a.starts_at) last FROM patients p JOIN appointments a ON a.patient_id = p.id
    WHERE p.status = 'ativo' AND a.status = 'realizada' ${s.sql} AND NOT EXISTS (SELECT 1 FROM appointments z WHERE z.patient_id = p.id AND z.status IN ('agendada','confirmada') AND z.starts_at >= ?)
    GROUP BY p.id HAVING last < DATE_SUB(?, INTERVAL ? DAY)) t`, [...s.p, now, now, days]);
  return num(r?.n);
}
// Retenção por coorte: dos pacientes que começaram no mês M, quantos tiveram sessão no mês M+k
export async function cohorts(f, endYm, months = 12, horizon = 6) {
  const s = scopeA(f);
  const rows = await q(`SELECT a.patient_id id, DATE_FORMAT(a.starts_at, '%Y-%m') ym FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status = 'realizada' ${s.sql} GROUP BY id, ym`, s.p);
  const by = {}; for (const x of rows) (by[x.id] ||= new Set()).add(x.ym);
  const startYm = addMonths(endYm, -(months - 1));
  const out = [];
  for (let i = 0; i < months; i++) {
    const ym = addMonths(startYm, i);
    const members = Object.values(by).filter((set) => [...set].sort()[0] === ym);
    const cells = [];
    for (let k = 1; k <= horizon; k++) {
      const t = addMonths(ym, k);
      if (t > todayLocal().slice(0, 7)) { cells.push(null); continue; }
      cells.push(members.length ? members.filter((set) => [...set].some((m) => m >= t)).length / members.length : null);
    }
    out.push({ ym, size: members.length, cells });
  }
  return out;
}

// ---------- profissionais ----------
export async function professionals(f, r) {
  const fx = { ...f, prof: null }; const s = scopeA(fx); const [a, b] = dt(r);
  const sp = scopePay(fx);
  const where = f.prof ? 'AND u.id = ?' : ''; const wp = f.prof ? [f.prof] : [];
  const [users, ag, pay, novos] = await Promise.all([
    q(`SELECT u.id, u.name, u.title FROM users u WHERE u.active = 1 AND (u.attends = 1 OR EXISTS (SELECT 1 FROM patients p WHERE p.owner_id = u.id)) ${where} ORDER BY u.name`, wp),
    q(`SELECT p.owner_id u, SUM(a.status='realizada') ok, SUM(a.status='falta') falta, SUM(a.status='cancelada') canc, COUNT(*) n, COUNT(DISTINCT IF(a.status='realizada', a.patient_id, NULL)) pac
      FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY u`, [a, b, ...s.p]),
    q(`SELECT COALESCE(x.professional_id, p.owner_id) u, SUM(x.amount) v, SUM(COALESCE(x.clinic_share, 0)) clinic ${PAY_FROM} WHERE x.paid_at BETWEEN ? AND ? ${sp.sql} GROUP BY u`, [r.from, r.to, ...sp.p]),
    q(`SELECT t.u, COUNT(*) n FROM (SELECT p.owner_id u, a.patient_id, MIN(a.starts_at) first FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status='realizada' ${s.sql} GROUP BY u, a.patient_id) t WHERE t.first >= ? AND t.first < ? GROUP BY t.u`, [...s.p, a, b]),
  ]);
  const occ = await occupancy(fx, r, users.map((u) => u.id));
  const A = Object.fromEntries(ag.map((x) => [x.u, x])); const P = Object.fromEntries(pay.map((x) => [x.u, x])); const N2 = Object.fromEntries(novos.map((x) => [x.u, num(x.n)]));
  return users.map((u) => {
    const g = A[u.id] || {}; const ok = num(g.ok); const falta = num(g.falta); const rev = num(P[u.id]?.v);
    return { id: u.id, name: u.name, title: u.title, ok, falta, canc: num(g.canc), total: num(g.n), pac: num(g.pac), novos: N2[u.id] || 0,
      faltas: pct(falta, ok + falta), cancel: pct(num(g.canc), num(g.n)), receita: rev, ticket: ok ? rev / ok : null, clinica: num(P[u.id]?.clinic), ocupacao: occ?.by?.[u.id]?.rate ?? null };
  }).filter((x) => x.total || x.receita || f.prof);
}

// ---------- captação ----------
export async function funnel(f, r) {
  const [a, b] = dt(r);
  const pf = f.prof ? ' AND p.owner_id = ?' : ''; const pp = f.prof ? [f.prof] : [];
  const [crm, crmAg, crmOk, book, bookOk, conv, convAg, wl, wlOk, clicks, viaRows] = await Promise.all([
    one("SELECT COUNT(*) n FROM crm_cards c JOIN crm_stages s ON s.id = c.stage_id WHERE c.created_at >= ? AND c.created_at < ? AND COALESCE(s.auto_key,'') <> 'equipe'", [a, b]),
    one(`SELECT COUNT(DISTINCT c.id) n FROM crm_cards c JOIN crm_stages s ON s.id = c.stage_id JOIN appointments ap ON ap.patient_id = c.patient_id JOIN patients p ON p.id = c.patient_id WHERE c.created_at >= ? AND c.created_at < ? AND COALESCE(s.auto_key,'') <> 'equipe' ${pf}`, [a, b, ...pp]),
    one(`SELECT COUNT(DISTINCT c.id) n FROM crm_cards c JOIN crm_stages s ON s.id = c.stage_id JOIN appointments ap ON ap.patient_id = c.patient_id AND ap.status = 'realizada' JOIN patients p ON p.id = c.patient_id WHERE c.created_at >= ? AND c.created_at < ? AND COALESCE(s.auto_key,'') <> 'equipe' ${pf}`, [a, b, ...pp]),
    one(`SELECT COUNT(*) n FROM booking_requests WHERE created_at >= ? AND created_at < ? ${f.prof ? 'AND owner_id = ?' : ''}`, [a, b, ...pp]),
    one(`SELECT COUNT(*) n FROM booking_requests WHERE created_at >= ? AND created_at < ? AND status = 'agendado' ${f.prof ? 'AND owner_id = ?' : ''}`, [a, b, ...pp]),
    one('SELECT COUNT(*) n FROM agent_conversations WHERE started_at >= ? AND started_at < ?', [a, b]),
    one(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.created_via = 'agente' AND a.created_at >= ? AND a.created_at < ? ${pf}`, [a, b, ...pp]),
    one(`SELECT COUNT(*) n FROM waitlist WHERE created_at >= ? AND created_at < ? AND demo = 0 ${f.prof ? 'AND owner_id = ?' : ''}`, [a, b, ...pp]),
    one(`SELECT COUNT(*) n FROM waitlist WHERE created_at >= ? AND created_at < ? AND status = 'agendado' AND demo = 0 ${f.prof ? 'AND owner_id = ?' : ''}`, [a, b, ...pp]),
    one('SELECT COUNT(*) n, SUM(target = \'assistente\') ia FROM site_wa_clicks WHERE created_at >= ? AND created_at < ?', [a, b]),
    originOfBookings(f, r),
  ]);
  return {
    crm: { contatos: num(crm.n), agendaram: num(crmAg.n), compareceram: num(crmOk.n) },
    online: { iniciados: num(book.n), agendados: num(bookOk.n) },
    agente: { conversas: num(conv.n), agendamentos: num(convAg.n) },
    lista: { entradas: num(wl.n), agendados: num(wlOk.n) },
    site: { cliques: num(clicks.n), assistente: num(clicks.ia) },
    via: viaRows,
  };
}

// ---------- destaques automáticos ----------
const P1 = (v) => `${Math.round(v * 100)}%`;
const brl = (v) => Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const WD = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
export function insights({ ag, agPrev, fin, finPrev, conf, heatRows, occ, risk, cmp }) {
  const out = [];
  const add = (tone, text, href = null) => out.push({ tone, text, href });
  if (ag && agPrev && cmp && ag.faltas != null && agPrev.faltas != null && agPrev.realizada + agPrev.falta >= 10 && ag.realizada + ag.falta >= 10 && Math.abs(ag.faltas - agPrev.faltas) >= 0.03) {
    add(ag.faltas > agPrev.faltas ? 'bad' : 'good', `Faltas ${ag.faltas > agPrev.faltas ? 'subiram' : 'caíram'} de ${P1(agPrev.faltas)} para ${P1(ag.faltas)} em relação ao período anterior.`, '?aba=agenda');
  }
  if (fin && finPrev && cmp && finPrev.recebido > 0 && finPrev.recebidoN >= 5) {
    const d = (fin.recebido - finPrev.recebido) / finPrev.recebido;
    if (Math.abs(d) >= 0.05 && Math.abs(d) <= 5) add(d > 0 ? 'good' : 'bad', `Receita recebida ${d > 0 ? 'cresceu' : 'caiu'} ${P1(Math.abs(d))} (${brl(finPrev.recebido)} → ${brl(fin.recebido)}).`, '?aba=financeiro');
  }
  if (conf && conf.confN >= 5 && conf.naoConfN >= 5 && conf.naoConfFaltas != null && conf.confFaltas != null && conf.naoConfFaltas - conf.confFaltas >= 0.03) {
    add('info', `Quem confirma a sessão falta ${P1(conf.confFaltas)}; quem não confirma falta ${P1(conf.naoConfFaltas)}. Vale ligar para quem não respondeu ao lembrete.`, '?aba=agenda');
  }
  const hot = (heatRows || []).filter((x) => x.ok + x.falta >= 4).map((x) => ({ ...x, rate: x.falta / (x.ok + x.falta) })).sort((x, y) => y.rate - x.rate)[0];
  if (hot && hot.rate >= 0.2) add('bad', `${WD[hot.wd][0].toUpperCase()}${WD[hot.wd].slice(1)} às ${String(hot.h).padStart(2, '0')}h é o horário com mais faltas (${P1(hot.rate)} de ${hot.ok + hot.falta} sessões).`, '?aba=agenda');
  if (occ && occ.rate != null) add(occ.rate >= 0.85 ? 'good' : occ.rate < 0.5 ? 'bad' : 'info', `Ocupação da agenda: ${P1(occ.rate)} das horas da escala (${Math.round(occ.free / 60)} h livres no período).`, '?aba=agenda');
  if (fin && fin.atrasado > 0) add('bad', `${brl(fin.atrasado)} em atraso com ${fin.atrasadoPac} paciente(s).`, '?aba=financeiro#inadimplencia');
  if (risk > 0) add('info', `${risk} paciente(s) ativo(s) sem sessão há mais de 30 dias e sem nada agendado.`, '?aba=pacientes#em-risco');
  return out;
}
