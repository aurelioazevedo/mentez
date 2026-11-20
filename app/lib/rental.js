// Locação de espaços (consultórios, salas, auditórios): reservas avulsas por hora, período ou diária,
// planos mensais com horários fixos (mensalidade) e integração com o financeiro (contas a receber).
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { todayLocal, addDays } from './time.js';
import { FEATURES } from './html.js';
import * as Live from './live.js';
import * as WA from './whatsapp.js';
import { proName } from './perm.js';

export const KINDS = { consultorio: 'Consultório', sala: 'Sala', auditorio: 'Auditório', reuniao: 'Sala de reunião', outro: 'Outro' };
export const UNITS = { hora: 'Por hora', periodo: 'Por período', diaria: 'Diária', plano: 'Plano mensal' };
export const STATUS = { reservada: 'Reservada', confirmada: 'Confirmada', concluida: 'Concluída', cancelada: 'Cancelada' };
export const WEEK = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const DEFAULT_PERIODS = [{ key: 'manha', label: 'Manhã', start: '07:00', end: '12:00' }, { key: 'tarde', label: 'Tarde', start: '13:00', end: '18:00' }, { key: 'noite', label: 'Noite', start: '18:00', end: '22:00' }];
const DEFAULTS = { enabled: false, periods: DEFAULT_PERIODS, category: 'Locação de espaços', notifyWhatsApp: true, horizonWeeks: 8 };

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('rental_cfg')) || '{}'); } catch { /* padrão */ }
  const out = { ...DEFAULTS, ...c };
  if (!Array.isArray(out.periods) || !out.periods.length) out.periods = DEFAULT_PERIODS;
  FEATURES.locacao = !!out.enabled;
  return out;
}
const isHm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v || ''));
const isYmd = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
export async function saveConfig(b) {
  const periods = DEFAULT_PERIODS.map((p) => ({ ...p, label: String(b[`pl_${p.key}`] || p.label).trim().slice(0, 30) || p.label, start: isHm(b[`ps_${p.key}`]) ? b[`ps_${p.key}`] : p.start, end: isHm(b[`pe_${p.key}`]) ? b[`pe_${p.key}`] : p.end }));
  for (const p of periods) if (p.end <= p.start) return `O período “${p.label}” termina antes de começar.`;
  await setSetting('rental_cfg', JSON.stringify({ enabled: !!b.enabled, periods, category: String(b.category || DEFAULTS.category).trim().slice(0, 80) || DEFAULTS.category, notifyWhatsApp: !!b.notifyWhatsApp, horizonWeeks: Math.min(26, Math.max(2, Number(b.horizonWeeks) || 8)) }));
  await config();
  return null;
}

const money2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const hm = (t) => String(t || '').slice(0, 5);
const mins = (t) => { const [h, m] = hm(t).split(':').map(Number); return h * 60 + m; };
const weekdayOf = (ymd) => new Date(`${ymd}T12:00:00Z`).getUTCDay();
export const brMoney = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// ---------- espaços ----------
export const spaces = (all = false) => q(`SELECT * FROM rental_spaces ${all ? '' : 'WHERE active = 1'} ORDER BY sort, name`);
export const space = (id) => one('SELECT * FROM rental_spaces WHERE id = ?', [id]);
export function checkSpace(b) {
  if (!String(b.name || '').trim()) return 'Informe o nome do espaço.';
  if (!isHm(b.open_time) || !isHm(b.close_time) || b.close_time <= b.open_time) return 'Confira o horário de funcionamento.';
  if (![].concat(b.weekdays || []).length) return 'Marque os dias de funcionamento.';
  if (![b.price_hour, b.price_period, b.price_day].some((v) => Number(String(v || '').replace(',', '.')) > 0)) return 'Informe pelo menos um preço (hora, período ou diária).';
  return null;
}
export async function saveSpace(id, b) {
  const num = (v) => money2(String(v || '0').replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '') || 0);
  const vals = [String(b.name).trim().slice(0, 80), KINDS[b.kind] ? b.kind : 'sala', Math.max(0, Number(b.capacity) || 0) || null, String(b.description || '').trim().slice(0, 500) || null,
    String(b.amenities || '').trim().slice(0, 300) || null, num(b.price_hour), num(b.price_period), num(b.price_day), b.open_time, b.close_time,
    [].concat(b.weekdays || []).map(Number).filter((n) => n >= 0 && n <= 6).sort().join(','), Math.max(0.5, Number(String(b.min_hours || '1').replace(',', '.')) || 1), b.active === undefined ? 1 : (b.active ? 1 : 0)];
  if (id) { await q('UPDATE rental_spaces SET name=?, kind=?, capacity=?, description=?, amenities=?, price_hour=?, price_period=?, price_day=?, open_time=?, close_time=?, weekdays=?, min_hours=?, active=? WHERE id = ?', [...vals, id]); return id; }
  const r = await q('INSERT INTO rental_spaces (name, kind, capacity, description, amenities, price_hour, price_period, price_day, open_time, close_time, weekdays, min_hours, active) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', vals);
  return r.insertId;
}

// ---------- locatários ----------
export const tenants = (all = false) => q(`SELECT * FROM rental_tenants ${all ? '' : 'WHERE active = 1'} ORDER BY name`);
export async function tenant(id) { const t = await one('SELECT * FROM rental_tenants WHERE id = ?', [id]); if (t) { try { t.doc = t.doc_enc ? decrypt(t.doc_enc) : ''; } catch { t.doc = ''; } } return t; }
// Profissionais da clínica (usuários) que podem ser locatários sem novo cadastro
export const clinicPros = () => q("SELECT id, name, title, crp, phone FROM users WHERE active = 1 AND demo = 0 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY name");
export async function tenantOptions() {
  const [tns, pros] = await Promise.all([q('SELECT t.*, u.name user_name FROM rental_tenants t LEFT JOIN users u ON u.id = t.user_id WHERE t.active = 1 ORDER BY t.name'), clinicPros()]);
  const linked = new Set(tns.filter((t) => t.user_id).map((t) => t.user_id));
  return { tenants: tns, pros: pros.filter((u) => !linked.has(u.id)).map((u) => ({ ...u, display: proName(u) })) };
}
// Locatário ligado a um profissional da clínica (cria na primeira locação, com os dados do cadastro dele)
export async function tenantForUser(userId) {
  const ex = await one('SELECT id FROM rental_tenants WHERE user_id = ?', [userId]);
  if (ex) { await q('UPDATE rental_tenants SET active = 1 WHERE id = ?', [ex.id]); return { id: ex.id }; }
  const u = await one("SELECT id, name, title, crp, phone, email FROM users WHERE id = ? AND active = 1 AND role IN ('admin','psicologo') AND attends = 1", [userId]);
  if (!u) return { error: 'Profissional não encontrado.' };
  const r = await q('INSERT INTO rental_tenants (name, phone, email, profession, reg, user_id) VALUES (?,?,?,?,?,?)', [u.name, u.phone || null, u.email || null, u.title === 'Dr.' ? 'Psicólogo' : 'Psicóloga', u.crp ? `CRP ${u.crp}` : null, u.id]);
  return { id: r.insertId, created: true };
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
// Já existe? (mesmo CPF/CNPJ, mesmo WhatsApp ou mesmo nome) — entre locatários e profissionais da clínica
export async function findExisting(b) {
  const name = norm(b.t_name ?? b.name); const doc = String(b.t_doc ?? b.doc ?? '').replace(/\D/g, ''); const key = WA.phoneKey(b.t_phone ?? b.phone);
  for (const t of await q('SELECT id, name, doc_enc, phone FROM rental_tenants')) {
    let d = ''; try { d = t.doc_enc ? decrypt(t.doc_enc) : ''; } catch { /* ilegível */ }
    if ((doc && d === doc) || (key && WA.phoneKey(t.phone) === key) || (name && norm(t.name) === name)) return { tenantId: t.id, name: t.name };
  }
  for (const u of await clinicPros()) if ((key && WA.phoneKey(u.phone) === key) || (name && norm(u.name) === name)) return { userId: u.id, name: u.name };
  return null;
}
// Resolve o locatário escolhido no formulário: existente, profissional da clínica (u:ID) ou novo (sem duplicar)
export async function resolveTenant(b) {
  const v = String(b.tenant_id || '');
  const m = v.match(/^u:(\d+)$/);
  if (m) return tenantForUser(Number(m[1]));
  if (Number(v)) return (await tenant(Number(v))) ? { id: Number(v) } : { error: 'Locatário não encontrado.' };
  if (!String(b.t_name || '').trim()) return { error: 'Escolha o locatário ou cadastre um novo.' };
  const ex = await findExisting(b);
  if (ex?.tenantId) return { id: ex.tenantId, reused: ex.name };
  if (ex?.userId) { const t = await tenantForUser(ex.userId); return t.error ? t : { ...t, reused: ex.name }; }
  return saveTenant(0, b);
}
export async function linkUser(tenantId, userId) {
  if (!userId) { await q('UPDATE rental_tenants SET user_id = NULL WHERE id = ?', [tenantId]); return null; }
  const other = await one('SELECT id, name FROM rental_tenants WHERE user_id = ? AND id <> ?', [userId, tenantId]);
  if (other) return `Este profissional já está vinculado ao locatário “${other.name}”.`;
  await q('UPDATE rental_tenants SET user_id = ? WHERE id = ?', [userId, tenantId]);
  return null;
}
export async function saveTenant(id, b) {
  const name = String(b.t_name ?? b.name ?? '').trim().replace(/\s+/g, ' ');
  if (name.length < 3) return { error: 'Informe o nome do locatário.' };
  const doc = String(b.t_doc ?? b.doc ?? '').replace(/[^\d]/g, '');
  if (doc && doc.length !== 11 && doc.length !== 14) return { error: 'CPF ou CNPJ inválido.' };
  const vals = [name.slice(0, 160), doc ? encrypt(doc) : null, String(b.t_phone ?? b.phone ?? '').trim().slice(0, 40) || null, String(b.t_email ?? b.email ?? '').trim().slice(0, 160) || null,
    String(b.t_profession ?? b.profession ?? '').trim().slice(0, 80) || null, String(b.t_reg ?? b.reg ?? '').trim().slice(0, 40) || null, String(b.notes || '').trim().slice(0, 500) || null];
  if (id) { await q('UPDATE rental_tenants SET name=?, doc_enc=?, phone=?, email=?, profession=?, reg=?, notes=? WHERE id = ?', [...vals, id]); return { id }; }
  const r = await q('INSERT INTO rental_tenants (name, doc_enc, phone, email, profession, reg, notes) VALUES (?,?,?,?,?,?,?)', vals);
  return { id: r.insertId };
}

// ---------- preço e validação ----------
// Monta o(s) intervalo(s) e o preço de uma reserva avulsa. Devolve { error } ou { slots:[{start,end}], unit, qty, price, label }.
export function quote(c, sp, b) {
  const unit = ['hora', 'periodo', 'diaria'].includes(b.unit) ? b.unit : 'hora';
  const date = String(b.date || '');
  if (!isYmd(date)) return { error: 'Escolha a data.' };
  const open = (d) => sp.weekdays.split(',').map(Number).includes(weekdayOf(d));
  if (unit === 'hora') {
    if (!(Number(sp.price_hour) > 0)) return { error: 'Este espaço não é alugado por hora.' };
    if (!isHm(b.start) || !isHm(b.end) || b.end <= b.start) return { error: 'Confira o horário de início e fim.' };
    if (!open(date)) return { error: 'O espaço não funciona neste dia da semana.' };
    if (b.start < hm(sp.open_time) || b.end > hm(sp.close_time)) return { error: `Fora do horário do espaço (${hm(sp.open_time)}–${hm(sp.close_time)}).` };
    const hours = (mins(b.end) - mins(b.start)) / 60;
    if (hours < Number(sp.min_hours)) return { error: `Mínimo de ${String(Number(sp.min_hours)).replace('.', ',')} hora(s) neste espaço.` };
    return { unit, qty: hours, price: money2(hours * sp.price_hour), slots: [{ start: `${date} ${b.start}:00`, end: `${date} ${b.end}:00` }], label: `${String(hours).replace('.', ',')} h × ${brMoney(sp.price_hour)}` };
  }
  if (unit === 'periodo') {
    if (!(Number(sp.price_period) > 0)) return { error: 'Este espaço não é alugado por período.' };
    const keys = [].concat(b.periods || []);
    const ps = c.periods.filter((p) => keys.includes(p.key));
    if (!ps.length) return { error: 'Escolha o(s) período(s).' };
    if (!open(date)) return { error: 'O espaço não funciona neste dia da semana.' };
    return { unit, qty: ps.length, price: money2(ps.length * sp.price_period), slots: ps.map((p) => ({ start: `${date} ${p.start}:00`, end: `${date} ${p.end}:00`, label: p.label })), label: `${ps.map((p) => p.label).join(' + ')} × ${brMoney(sp.price_period)}` };
  }
  if (!(Number(sp.price_day) > 0)) return { error: 'Este espaço não é alugado por diária.' };
  const until = isYmd(b.date_end) ? b.date_end : date;
  if (until < date) return { error: 'A data final é antes da inicial.' };
  const days = Math.round((new Date(`${until}T12:00:00Z`) - new Date(`${date}T12:00:00Z`)) / 864e5) + 1;
  if (days > 31) return { error: 'Diárias: no máximo 31 dias por reserva.' };
  return { unit, qty: days, price: money2(days * sp.price_day), slots: [{ start: `${date} ${hm(sp.open_time)}:00`, end: `${until} ${hm(sp.close_time)}:00` }], label: `${days} diária(s) × ${brMoney(sp.price_day)}` };
}
export async function conflict(spaceId, start, end, ignoreId = 0) {
  return one(`SELECT b.*, t.name tenant_name FROM rental_bookings b LEFT JOIN rental_tenants t ON t.id = b.tenant_id
    WHERE b.space_id = ? AND b.status <> 'cancelada' AND b.starts_at < ? AND b.ends_at > ? AND b.id <> ? LIMIT 1`, [spaceId, end, start, ignoreId || 0]);
}
const brDT = (dt) => `${dt.slice(8, 10)}/${dt.slice(5, 7)} ${dt.slice(11, 16)}`;

async function categoryId(c) {
  const name = c.category || DEFAULTS.category;
  let cat = await one("SELECT id FROM fin_categories WHERE name = ? AND kind = 'receita'", [name]);
  if (!cat) { await q("INSERT IGNORE INTO fin_categories (name, kind) VALUES (?, 'receita')", [name]); cat = await one("SELECT id FROM fin_categories WHERE name = ? AND kind = 'receita'", [name]); }
  return cat?.id || null;
}

// ---------- reserva avulsa ----------
export async function book(c, b, userId) {
  const sp = await space(Number(b.space_id));
  if (!sp || !sp.active) return { error: 'Escolha o espaço.' };
  const rt = await resolveTenant(b);
  if (rt.error) return rt;
  const tenantId = rt.id;
  const t = await tenant(tenantId);
  if (!t) return { error: 'Locatário não encontrado.' };
  const qt = quote(c, sp, b);
  if (qt.error) return qt;
  for (const s of qt.slots) {
    if (s.start.slice(0, 10) < todayLocal()) return { error: 'A data já passou.' };
    const cf = await conflict(sp.id, s.start, s.end);
    if (cf) return { error: `${sp.name} já está reservado(a) de ${brDT(cf.starts_at)} a ${brDT(cf.ends_at).slice(6)} (${cf.tenant_name || 'outra reserva'}).`, tenantId };
  }
  const discount = Math.min(qt.price, money2(String(b.discount || '0').replace(',', '.')));
  const total = money2(qt.price - discount);
  const ids = [];
  const share = qt.slots.length;
  for (const [i, s] of qt.slots.entries()) {
    // várias partes (períodos): o valor fica na primeira, para o financeiro ter um lançamento só
    const r = await q("INSERT INTO rental_bookings (space_id, tenant_id, starts_at, ends_at, unit, qty, price, discount, total, status, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      [sp.id, tenantId, s.start, s.end, qt.unit, i === 0 ? qt.qty : 0, i === 0 ? qt.price : 0, i === 0 ? discount : 0, i === 0 ? total : 0, b.confirm ? 'confirmada' : 'reservada', String(b.notes || '').trim().slice(0, 500) || null, userId]);
    ids.push(r.insertId);
  }
  if (share > 1) await q('UPDATE rental_bookings SET group_id = ? WHERE id IN (?)', [ids[0], ids]);
  if (total > 0) {
    const due = isYmd(b.due_date) ? b.due_date : qt.slots[0].start.slice(0, 10);
    const paid = b.paid ? todayLocal() : null;
    const e = await q('INSERT INTO fin_entries (owner_id, kind, category_id, description, counterpart, amount, due_date, paid_at, method, notes, created_by) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ['receber', await categoryId(c), `Locação ${sp.name} — ${brDT(qt.slots[0].start)}${qt.unit === 'diaria' && qt.qty > 1 ? ` (${qt.qty} diárias)` : ''}`.slice(0, 255), t.name, total, due, paid, paid ? (['pix', 'dinheiro', 'cartao', 'transferencia', 'boleto'].includes(b.method) ? b.method : 'pix') : null, `Reserva #${ids[0]}`, userId]);
    await q('UPDATE rental_bookings SET entry_id = ? WHERE id = ?', [e.insertId, ids[0]]);
  }
  Live.emit(['locacao', 'financeiro']);
  return { ok: true, id: ids[0], total, tenant: t, space: sp, quote: qt, reused: rt.reused };
}
export async function booking(id) {
  return one(`SELECT b.*, s.name space_name, s.kind space_kind, t.name tenant_name, t.phone tenant_phone, e.paid_at, e.amount entry_amount, e.due_date, e.method, p.monthly plan_monthly
    FROM rental_bookings b JOIN rental_spaces s ON s.id = b.space_id LEFT JOIN rental_tenants t ON t.id = b.tenant_id LEFT JOIN fin_entries e ON e.id = b.entry_id LEFT JOIN rental_plans p ON p.id = b.plan_id WHERE b.id = ?`, [id]);
}
export const groupOf = (b) => (b.group_id ? q('SELECT * FROM rental_bookings WHERE group_id = ? ORDER BY starts_at', [b.group_id]) : Promise.resolve([b]));
export async function setStatus(b, status) {
  const ids = (await groupOf(b)).map((x) => x.id);
  await q('UPDATE rental_bookings SET status = ? WHERE id IN (?)', [status, ids]);
  Live.emit(['locacao']);
}
export async function cancelBooking(b, reason) {
  const ids = (await groupOf(b)).map((x) => x.id);
  await q("UPDATE rental_bookings SET status = 'cancelada', cancelled_at = NOW(), cancel_reason = ? WHERE id IN (?)", [String(reason || '').slice(0, 200) || null, ids]);
  let refund = false;
  if (b.entry_id) {
    const e = await one('SELECT * FROM fin_entries WHERE id = ?', [b.entry_id]);
    if (e && !e.paid_at) await q('DELETE FROM fin_entries WHERE id = ?', [e.id]);
    else if (e) refund = true;
  }
  Live.emit(['locacao', 'financeiro']);
  return { refund };
}
export async function markPaid(b, method) {
  if (!b.entry_id) return false;
  await q('UPDATE fin_entries SET paid_at = CURDATE(), method = ? WHERE id = ? AND paid_at IS NULL', [['pix', 'dinheiro', 'cartao', 'transferencia', 'boleto'].includes(method) ? method : 'pix', b.entry_id]);
  Live.emit(['locacao', 'financeiro']);
  return true;
}

// ---------- planos mensais (horários fixos + mensalidade) ----------
export function checkPlan(b) {
  if (!Number(b.space_id)) return 'Escolha o espaço.';
  if (!String(b.tenant_id || '').trim() && !String(b.t_name || '').trim()) return 'Escolha o locatário ou cadastre um novo.';
  if (![].concat(b.weekdays || []).length) return 'Marque os dias da semana.';
  if (!isHm(b.start) || !isHm(b.end) || b.end <= b.start) return 'Confira o horário.';
  if (!isYmd(b.start_date)) return 'Informe o início do contrato.';
  if (b.end_date && (!isYmd(b.end_date) || b.end_date < b.start_date)) return 'Confira a data de término.';
  if (!(money2(String(b.monthly || '').replace(/\./g, '').replace(',', '.')) > 0)) return 'Informe o valor da mensalidade.';
  return null;
}
export async function createPlan(c, b, userId) {
  const bad = checkPlan(b);
  if (bad) return { error: bad };
  const sp = await space(Number(b.space_id));
  if (!sp) return { error: 'Espaço não encontrado.' };
  if (b.start < hm(sp.open_time) || b.end > hm(sp.close_time)) return { error: `Fora do horário do espaço (${hm(sp.open_time)}–${hm(sp.close_time)}).` };
  const wds = [].concat(b.weekdays).map(Number).filter((n) => n >= 0 && n <= 6);
  const closed = wds.filter((d) => !sp.weekdays.split(',').map(Number).includes(d));
  if (closed.length) return { error: `O espaço não funciona ${closed.map((d) => WEEK[d]).join(', ')}.` };
  const rt = await resolveTenant(b);
  if (rt.error) return rt;
  const tenantId = rt.id;
  // conflitos nas próximas semanas
  const preview = occurrences({ weekdays: wds.join(','), start_time: b.start, end_time: b.end, start_date: b.start_date, end_date: b.end_date || null }, c.horizonWeeks);
  for (const o of preview) { const cf = await conflict(sp.id, o.start, o.end); if (cf) return { error: `Conflito em ${brDT(o.start)}: ${sp.name} já reservado(a) para ${cf.tenant_name || 'outra reserva'}.`, tenantId }; }
  const monthly = money2(String(b.monthly).replace(/\./g, '').replace(',', '.'));
  const r = await q('INSERT INTO rental_plans (tenant_id, space_id, weekdays, start_time, end_time, monthly, due_day, start_date, end_date, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    [tenantId, sp.id, wds.sort().join(','), b.start, b.end, monthly, Math.min(28, Math.max(1, Number(b.due_day) || 10)), b.start_date, b.end_date || null, String(b.notes || '').trim().slice(0, 500) || null, userId]);
  await syncPlanFinance(c, r.insertId, userId);
  await extendPlan(c, r.insertId);
  Live.emit(['locacao', 'financeiro']);
  return { ok: true, id: r.insertId };
}
// Datas do plano a partir de hoje (ou do início) até o horizonte
export function occurrences(p, weeks, from = null) {
  const out = [];
  const start = [String(p.start_date).slice(0, 10), from || todayLocal()].sort()[1];
  const last = [addDays(todayLocal(), weeks * 7), p.end_date ? String(p.end_date).slice(0, 10) : '9999-12-31'].sort()[0];
  const wds = String(p.weekdays).split(',').map(Number);
  for (let d = start; d <= last; d = addDays(d, 1)) if (wds.includes(weekdayOf(d))) out.push({ start: `${d} ${hm(p.start_time)}:00`, end: `${d} ${hm(p.end_time)}:00` });
  return out;
}
export async function extendPlan(c, planId) {
  const p = await one("SELECT * FROM rental_plans WHERE id = ? AND status = 'ativo'", [planId]);
  if (!p) return { made: 0, skipped: [] };
  let made = 0; const skipped = [];
  for (const o of occurrences(p, c.horizonWeeks)) {
    if (await one('SELECT id FROM rental_bookings WHERE plan_id = ? AND starts_at = ?', [p.id, o.start])) continue;
    const cf = await conflict(p.space_id, o.start, o.end);
    if (cf) { skipped.push(o.start); continue; }
    await q("INSERT INTO rental_bookings (space_id, tenant_id, plan_id, starts_at, ends_at, unit, qty, price, total, status) VALUES (?,?,?,?,?, 'plano', 0, 0, 0, 'confirmada')", [p.space_id, p.tenant_id, p.id, o.start, o.end]);
    made++;
  }
  return { made, skipped };
}
async function syncPlanFinance(c, planId, userId) {
  const p = await one('SELECT p.*, s.name space_name, t.name tenant_name FROM rental_plans p JOIN rental_spaces s ON s.id = p.space_id JOIN rental_tenants t ON t.id = p.tenant_id WHERE p.id = ?', [planId]);
  const desc = `Mensalidade locação — ${p.space_name} (${WEEK.filter((_, i) => p.weekdays.split(',').map(Number).includes(i)).join('/')} ${hm(p.start_time)}–${hm(p.end_time)})`.slice(0, 255);
  const startYm = String(p.start_date).slice(0, 7); const endYm = p.end_date ? String(p.end_date).slice(0, 7) : null;
  if (p.recurring_id && await one('SELECT id FROM fin_recurring WHERE id = ?', [p.recurring_id])) {
    await q('UPDATE fin_recurring SET description = ?, counterpart = ?, amount = ?, day = ?, start_ym = ?, end_ym = ?, active = ? WHERE id = ?', [desc, p.tenant_name, p.monthly, p.due_day, startYm, endYm, p.status === 'ativo' ? 1 : 0, p.recurring_id]);
  } else {
    const r = await q("INSERT INTO fin_recurring (owner_id, kind, category_id, description, counterpart, amount, day, start_ym, end_ym, active, created_by) VALUES (NULL, 'receber', ?, ?, ?, ?, ?, ?, ?, 1, ?)", [await categoryId(c), desc, p.tenant_name, p.monthly, p.due_day, startYm, endYm, userId || null]);
    await q('UPDATE rental_plans SET recurring_id = ? WHERE id = ?', [r.insertId, p.id]);
  }
  try { const Fin = await import('./fin.js'); await Fin.ensureRecurring(); } catch (e) { console.error('locação: mensalidade', e.message); }
}
export async function endPlan(c, planId, endDate, userId) {
  const p = await one("SELECT * FROM rental_plans WHERE id = ? AND status = 'ativo'", [planId]);
  if (!p) return { error: 'Plano não encontrado.' };
  const end = isYmd(endDate) ? endDate : todayLocal();
  await q("UPDATE rental_plans SET status = IF(? <= CURDATE(), 'encerrado', status), end_date = ? WHERE id = ?", [end, end, p.id]);
  await q("UPDATE rental_bookings SET status = 'cancelada', cancelled_at = NOW(), cancel_reason = 'Plano encerrado' WHERE plan_id = ? AND starts_at > ? AND status <> 'cancelada'", [p.id, `${end} 23:59:59`]);
  // mensalidades futuras ainda não pagas saem do financeiro
  if (p.recurring_id) {
    await q('UPDATE fin_recurring SET end_ym = ?, active = IF(? < DATE_FORMAT(CURDATE(), "%Y-%m"), 0, active) WHERE id = ?', [end.slice(0, 7), end.slice(0, 7), p.recurring_id]);
    await q('DELETE FROM fin_entries WHERE recurring_id = ? AND rec_ym > ? AND paid_at IS NULL', [p.recurring_id, end.slice(0, 7)]);
  }
  Live.emit(['locacao', 'financeiro']);
  return { ok: true };
}
export const plans = (status = 'ativo') => q(`SELECT p.*, s.name space_name, t.name tenant_name FROM rental_plans p JOIN rental_spaces s ON s.id = p.space_id JOIN rental_tenants t ON t.id = p.tenant_id ${status ? 'WHERE p.status = ?' : ''} ORDER BY t.name`, status ? [status] : []);
export const plan = (id) => one('SELECT p.*, s.name space_name, t.name tenant_name, t.phone tenant_phone FROM rental_plans p JOIN rental_spaces s ON s.id = p.space_id JOIN rental_tenants t ON t.id = p.tenant_id WHERE p.id = ?', [id]);

// Rotina diária: estende os planos e conclui reservas que já passaram
export async function tick() {
  const c = await config();
  if (!c.enabled) return;
  for (const p of await q("SELECT id FROM rental_plans WHERE status = 'ativo'")) await extendPlan(c, p.id);
  await q("UPDATE rental_plans SET status = 'encerrado' WHERE status = 'ativo' AND end_date IS NOT NULL AND end_date < CURDATE()");
  await q("UPDATE rental_bookings SET status = 'concluida' WHERE status IN ('reservada','confirmada') AND ends_at < NOW()");
}

// ---------- painel ----------
export const dayBookings = (ymd) => q(`SELECT b.*, t.name tenant_name, s.name space_name FROM rental_bookings b JOIN rental_spaces s ON s.id = b.space_id LEFT JOIN rental_tenants t ON t.id = b.tenant_id
  WHERE b.status <> 'cancelada' AND b.starts_at < ? AND b.ends_at > ? ORDER BY b.starts_at`, [`${addDays(ymd, 1)} 00:00:00`, `${ymd} 00:00:00`]);
export async function stats(ymd) {
  const ym = ymd.slice(0, 7);
  const sp = await spaces();
  const avulsa = await one(`SELECT COALESCE(SUM(total),0) t, COUNT(*) n FROM rental_bookings WHERE status <> 'cancelada' AND plan_id IS NULL AND total > 0 AND DATE_FORMAT(starts_at, '%Y-%m') = ?`, [ym]);
  const pl = await one("SELECT COALESCE(SUM(monthly),0) t, COUNT(*) n FROM rental_plans WHERE status = 'ativo'");
  const open = await one('SELECT COALESCE(SUM(e.amount),0) t, COUNT(*) n FROM fin_entries e JOIN fin_categories c ON c.id = e.category_id WHERE e.kind = \'receber\' AND e.paid_at IS NULL AND c.name = ?', [(await config()).category]);
  // ocupação do dia: horas reservadas ÷ horas abertas dos espaços que funcionam no dia
  const wd = weekdayOf(ymd); let openH = 0; let usedH = 0;
  const day = await dayBookings(ymd);
  for (const s of sp) {
    if (!s.weekdays.split(',').map(Number).includes(wd)) continue;
    const a = mins(s.open_time); const z = mins(s.close_time); openH += (z - a) / 60;
    for (const b of day.filter((x) => x.space_id === s.id)) {
      const bs = b.starts_at.slice(0, 10) < ymd ? a : Math.max(a, mins(b.starts_at.slice(11, 16)));
      const be = b.ends_at.slice(0, 10) > ymd ? z : Math.min(z, mins(b.ends_at.slice(11, 16)));
      if (be > bs) usedH += (be - bs) / 60;
    }
  }
  return { revenue: Number(avulsa.t) + Number(pl.t), avulsa, plans: pl, open, occupancy: openH ? Math.round((usedH / openH) * 100) : 0, spaces: sp.length };
}
export const isoDay = (d) => (isYmd(d) ? d : todayLocal());
