// Portal do paciente: entra com o WhatsApp (código de 6 dígitos ou link enviado pela clínica) e vê
// próximas sessões (confirmar, remarcar, cancelar), pagamentos (Pix e recibos), termos e exercícios.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { nowLocal, addDays, todayLocal } from './time.js';
import * as WA from './whatsapp.js';
import * as Booking from './booking.js';
import * as Agent from './agent.js';
import * as Waitlist from './waitlist.js';
import * as Live from './live.js';
import { notify } from './push.js';

export const COOKIE = 'lm_pac';
const DEFAULTS = { enabled: false, allowConfirm: true, allowReschedule: true, rescheduleMinHours: 24, allowCancel: true, cancelMinHours: 24, showPayments: true, showReceipts: true, showTerms: true, showExercises: true, checkin: true, welcome: '' };
export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('portal_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c };
}
export async function saveConfig(b) {
  const hrs = (v, d) => Math.min(168, Math.max(0, Number.isFinite(Number(v)) && v !== '' ? Number(v) : d));
  await setSetting('portal_cfg', JSON.stringify({
    enabled: !!b.enabled, allowConfirm: !!b.allowConfirm, allowReschedule: !!b.allowReschedule, rescheduleMinHours: hrs(b.rescheduleMinHours, 24),
    allowCancel: !!b.allowCancel, cancelMinHours: hrs(b.cancelMinHours, 24), showPayments: !!b.showPayments, showReceipts: !!b.showReceipts,
    showTerms: !!b.showTerms, showExercises: !!b.showExercises, checkin: !!b.checkin, welcome: String(b.welcome || '').trim().slice(0, 500),
  }));
}

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const hoursUntil = (dt) => (new Date(`${String(dt).replace(' ', 'T')}-03:00`) - Date.now()) / 3600e3;

// WhatsApps que dão acesso: o do paciente e o do responsável (menores)
const keysOf = (p) => [p.phone, p.responsible_phone].filter(Boolean).map((x) => WA.phoneKey(x)).filter(Boolean);
// Pacientes ativos com este WhatsApp (pais podem ter mais de um filho cadastrado com o mesmo número)
export const patientsByPhone = (phone) => patientsByKey(WA.phoneKey(phone));
export async function patientsByKey(key) {
  if (!key) return [];
  const all = await q("SELECT id, name, social_name, phone, responsible_phone, owner_id FROM patients WHERE ((phone IS NOT NULL AND phone <> '') OR (responsible_phone IS NOT NULL AND responsible_phone <> '')) AND status <> 'inativo'");
  return all.filter((p) => keysOf(p).includes(key));
}

// ---------- entrar com código ----------
const ipHits = new Map();
export async function requestCode(phone, ip) {
  const now = Date.now(); const k = String(ip || '').slice(0, 64);
  const hits = (ipHits.get(k) || []).filter((t) => t > now - 3600e3);
  if (hits.length >= 10) return { ok: false, error: 'Muitas tentativas. Tente de novo mais tarde.' };
  hits.push(now); ipHits.set(k, hits);
  const num = WA.normalizePhone(phone);
  if (!num) return { ok: false, error: 'Informe o seu WhatsApp com DDD.' };
  if (Number((await one('SELECT COUNT(*) n FROM portal_codes WHERE phone = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)', [num])).n) >= 4) return { ok: false, error: 'Já enviamos vários códigos para este número. Tente de novo em 1 hora.' };
  const token = crypto.randomBytes(18).toString('base64url');
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  await q('INSERT INTO portal_codes (token, phone, code_hash, ip, expires_at) VALUES (?,?,?,?, DATE_ADD(NOW(), INTERVAL 10 MINUTE))', [token, num, sha(`${token}:${code}`), k]);
  // Só envia se o número for de um paciente; a tela é a mesma nos dois casos (não revela quem é paciente).
  const ps = await patientsByPhone(num);
  if (ps.length) {
    const waCfg = await WA.config();
    if (!WA.ready(waCfg)) return { ok: false, error: 'O portal está temporariamente indisponível. Fale com o consultório pelo WhatsApp.' };
    const r = await WA.send({ phone: num, text: `Seu código para entrar no portal do paciente é *${code}*.\n\nEle vale por 10 minutos. Se não foi você, ignore esta mensagem.`, kind: 'manual', patient_id: ps[0].id });
    if (!r.ok) return { ok: false, error: 'Não conseguimos enviar o código agora. Tente de novo em instantes.' };
  }
  return { ok: true, token };
}
export async function verifyCode(token, code) {
  const r = /^[A-Za-z0-9_-]{20,40}$/.test(String(token || '')) ? await one('SELECT * FROM portal_codes WHERE token = ?', [token]) : null;
  if (!r || r.used_at || String(r.expires_at) < nowLocal() || r.attempts >= 5) return { ok: false, restart: true, error: 'O código expirou. Peça um novo.' };
  if (sha(`${token}:${String(code || '').replace(/\D/g, '')}`) !== r.code_hash) {
    await q('UPDATE portal_codes SET attempts = attempts + 1 WHERE id = ?', [r.id]);
    return { ok: false, restart: r.attempts + 1 >= 5, error: r.attempts + 1 >= 5 ? 'Código incorreto muitas vezes. Peça um novo.' : 'Código incorreto. Confira a mensagem no seu WhatsApp.' };
  }
  await q('UPDATE portal_codes SET used_at = NOW() WHERE id = ?', [r.id]);
  const ps = await patientsByPhone(r.phone);
  if (!ps.length) return { ok: false, restart: true, error: 'Não encontramos um cadastro ativo com este WhatsApp. Fale com o consultório.' };
  return { ok: true, phone: r.phone, patients: ps };
}

// ---------- link de acesso enviado pela clínica ----------
export async function createLink(patientId, userId) {
  const token = crypto.randomBytes(24).toString('base64url');
  await q('INSERT INTO portal_links (patient_id, token_hash, created_by, expires_at) VALUES (?,?,?, DATE_ADD(NOW(), INTERVAL 7 DAY))', [patientId, sha(token), userId]);
  return token;
}
export async function useLink(token) {
  if (!/^[A-Za-z0-9_-]{30,40}$/.test(String(token || ''))) return null;
  const l = await one('SELECT * FROM portal_links WHERE token_hash = ?', [sha(token)]);
  if (!l || l.used_at || String(l.expires_at) < nowLocal()) return null;
  const p = await one("SELECT id, phone, responsible_phone FROM patients WHERE id = ? AND status <> 'inativo'", [l.patient_id]);
  if (!p) return null;
  return { link: l, patient: p };
}
export async function consumeLink(l) { await q('UPDATE portal_links SET used_at = NOW() WHERE id = ? AND used_at IS NULL', [l.id]); }

// ---------- sessão no aparelho (90 dias) ----------
export async function startSession(patientId, phone, req) {
  const token = crypto.randomBytes(32).toString('base64url');
  await q('INSERT INTO portal_sessions (token_hash, patient_id, phone_key, ip, user_agent, expires_at) VALUES (?,?,?,?,?, DATE_ADD(NOW(), INTERVAL 90 DAY))',
    [sha(token), patientId, WA.phoneKey(phone) || null, String(req.ip || '').slice(0, 64), String(req.get('user-agent') || '').slice(0, 255)]);
  await q('UPDATE patients SET portal_last_at = NOW() WHERE id = ?', [patientId]);
  return token;
}
export async function sessionOf(token) {
  if (!/^[A-Za-z0-9_-]{40,50}$/.test(String(token || ''))) return null;
  const s = await one('SELECT * FROM portal_sessions WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > NOW()', [sha(token)]);
  if (!s) return null;
  const p = await one("SELECT * FROM patients WHERE id = ? AND status <> 'inativo'", [s.patient_id]);
  if (!p) return null;
  // trocou o WhatsApp do cadastro: acessos antigos deixam de valer
  if (s.phone_key && !keysOf(p).includes(s.phone_key)) return null;
  if (!s.last_seen_at || String(s.last_seen_at) < nowLocal().slice(0, 13)) { q('UPDATE portal_sessions SET last_seen_at = NOW() WHERE id = ?', [s.id]).catch(() => {}); q('UPDATE patients SET portal_last_at = NOW() WHERE id = ?', [p.id]).catch(() => {}); }
  return { s, p };
}
export const switchable = async (sess) => (sess.s.phone_key ? (await patientsByKey(sess.s.phone_key)) : [sess.p]);
export async function switchTo(sess, pid) {
  const ok = (await switchable(sess)).some((x) => x.id === pid);
  if (ok) await q('UPDATE portal_sessions SET patient_id = ? WHERE id = ?', [pid, sess.s.id]);
  return ok;
}
export const endSession = (sess) => q('UPDATE portal_sessions SET revoked_at = NOW() WHERE id = ?', [sess.s.id]);
export const revokeAll = (pid) => q('UPDATE portal_sessions SET revoked_at = NOW() WHERE patient_id = ? AND revoked_at IS NULL', [pid]);
export const activeSessions = (pid) => one('SELECT COUNT(*) n, MAX(last_seen_at) last FROM portal_sessions WHERE patient_id = ? AND revoked_at IS NULL AND expires_at > NOW()', [pid]);

// ---------- dados do paciente ----------
export const upcoming = (pid) => q(`SELECT a.*, u.name pro_name, u.title pro_title FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = p.owner_id
  WHERE a.patient_id = ? AND a.status IN ('agendada','confirmada','aguardando','em_atendimento') AND DATE_ADD(a.starts_at, INTERVAL a.duration_min MINUTE) >= NOW() ORDER BY a.starts_at LIMIT 20`, [pid]);
export const past = (pid) => q("SELECT * FROM appointments WHERE patient_id = ? AND (starts_at < NOW() OR status = 'cancelada') AND status IN ('realizada','falta','cancelada') ORDER BY starts_at DESC LIMIT 30", [pid]);
export const ownAppt = (pid, id) => one("SELECT a.*, p.name, p.social_name, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ? AND a.patient_id = ? AND a.status IN ('agendada','confirmada') AND a.starts_at > NOW()", [id, pid]);
// o que o convênio paga não aparece para o paciente
export const openPayments = (pid) => q("SELECT * FROM payments WHERE patient_id = ? AND paid_at IS NULL AND origin <> 'convenio' ORDER BY due_date, id", [pid]);
export const paidPayments = (pid) => q("SELECT * FROM payments WHERE patient_id = ? AND paid_at IS NOT NULL AND origin <> 'convenio' ORDER BY paid_at DESC, id DESC LIMIT 40", [pid]);
export const terms = (pid) => q("SELECT * FROM consent_links WHERE patient_id = ? AND status IN ('pendente','aceito','recusado') ORDER BY id DESC LIMIT 20", [pid]);
export const exercises = (pid) => q("SELECT * FROM assignments WHERE patient_id = ? AND (expires_at > NOW() OR status IN ('respondido','revisado')) ORDER BY created_at DESC LIMIT 30", [pid]);

const first = (p) => String(p.social_name || p.name).trim().split(/\s+/)[0];
const short = (p) => { const n = String(p.social_name || p.name).trim().split(/\s+/); return `${n[0]}${n.length > 1 ? ` ${n[n.length - 1][0]}.` : ''}`; };

// ---------- ações sobre as sessões ----------
export async function confirmAppt(c, pid, id) {
  if (!c.allowConfirm) return { ok: false, error: 'Confirmação pelo portal desativada.' };
  const a = await ownAppt(pid, id);
  if (!a) return { ok: false, error: 'Sessão não encontrada.' };
  await q("UPDATE appointments SET status = 'confirmada', wa_reply = 'confirmou', wa_reply_at = NOW() WHERE id = ?", [a.id]);
  await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['portal-confirmar', `appointment:${a.id}`]);
  Live.emit(['agenda', 'recepcao']);
  return { ok: true };
}
export async function rescheduleSlots(c, pid, id) {
  const a = await ownAppt(pid, id);
  if (!a) return { error: 'Sessão não encontrada.' };
  if (!c.allowReschedule) return { error: 'A remarcação pelo portal está desativada. Fale com o consultório.' };
  if (hoursUntil(a.starts_at) < c.rescheduleMinHours) return { a, late: true, error: `Faltam menos de ${c.rescheduleMinHours} horas para a sessão: para remarcar, fale com o consultório pelo WhatsApp.` };
  const bc = await Booking.config();
  return { a, days: await Booking.slots(bc, a.owner_id, null, 21, { ignoreId: a.id, dur: a.duration_min }) };
}
export async function reschedule(c, pid, id, start) {
  const r = await rescheduleSlots(c, pid, id);
  if (r.error) return { ok: false, error: r.error };
  const { a } = r;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(start)) return { ok: false, error: 'Escolha um horário.' };
  const bad = await Booking.check(await Booking.config(), a.owner_id, start, null, { ignoreId: a.id, dur: a.duration_min });
  if (bad) return { ok: false, error: `${bad} Escolha outro horário.` };
  await q("UPDATE appointments SET starts_at = ?, status = 'agendada', wa_reminder_at = NULL, wa_reminder2_at = NULL, wa_reply = NULL, wa_reply_at = NULL, wa_reschedule_done = 1 WHERE id = ?", [start, a.id]);
  await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['portal-remarcar', `appointment:${a.id} de ${a.starts_at} para ${start}`]);
  Agent.afterChange(await Agent.config(), a.id, a.owner_id, `↻ ${short(a)} remarcou pelo portal (era ${a.starts_at.slice(8, 10)}/${a.starts_at.slice(5, 7)} ${a.starts_at.slice(11, 16)})`, a, start, false);
  Waitlist.slotFreed(a);
  return { ok: true, start };
}
export async function cancel(c, pid, id, reason) {
  const a = await ownAppt(pid, id);
  if (!a) return { ok: false, error: 'Sessão não encontrada.' };
  if (!c.allowCancel) return { ok: false, error: 'O cancelamento pelo portal está desativado. Fale com o consultório.' };
  if (hoursUntil(a.starts_at) < c.cancelMinHours) return { ok: false, error: `Faltam menos de ${c.cancelMinHours} horas para a sessão: para cancelar, fale com o consultório pelo WhatsApp.` };
  await q("UPDATE appointments SET status = 'cancelada', wa_reschedule_done = 1 WHERE id = ?", [a.id]);
  await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['portal-cancelar', `appointment:${a.id} ${String(reason || '').slice(0, 80)}`]);
  Agent.afterChange(await Agent.config(), a.id, a.owner_id, `✕ ${short(a)} cancelou pelo portal${reason ? `: ${String(reason).slice(0, 60)}` : ''}`, a, a.starts_at, false);
  Waitlist.slotFreed(a);
  return { ok: true };
}
// “Já paguei”: avisa a equipe para conferir (o recebimento continua sendo confirmado pela clínica)
export async function informPaid(pid, payId) {
  const x = await one("SELECT x.*, p.name, p.social_name, p.owner_id FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ? AND x.patient_id = ? AND x.paid_at IS NULL AND x.origin <> 'convenio'", [payId, pid]);
  if (!x) return { ok: false, error: 'Pagamento não encontrado.' };
  if (!x.informed_at) {
    await q('UPDATE payments SET informed_at = NOW() WHERE id = ?', [x.id]);
    await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['portal-informou-pagamento', `payment:${x.id}`]);
    notify(x.receiver === 'profissional' && x.professional_id ? x.professional_id : x.owner_id, { title: '💳 Paciente informou pagamento', body: `${short(x)} — ${Number(x.amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} (${x.description})`, url: '/financeiro/receber', tag: `pay-${x.id}` });
    Live.emit(['financeiro']);
  }
  return { ok: true };
}
export { first as firstName };
export const today = todayLocal;
export const plusDays = addDays;
