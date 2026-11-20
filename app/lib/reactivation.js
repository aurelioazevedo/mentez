// Marketing → Reativação: pacientes que pararam de vir (sem sessão há X semanas e sem nada marcado)
// recebem um convite gentil para retomar, pelo WhatsApp ou e-mail, com link para agendar e para não receber mais.
// Só para quem autorizou o contato; respeita um intervalo entre convites e mede quem voltou.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { nowLocal, todayLocal } from './time.js';
import * as WA from './whatsapp.js';
import * as Notify from './notify.js';

export const DEFAULTS = {
  auto: false, weeks: 6, includeAlta: false, cooldownDays: 90, maxPerDay: 10, hour: 10, email: true,
  text: 'Olá, {nome}! Faz um tempinho desde o nosso último encontro no {clinica}. Se fizer sentido para você retomar o acompanhamento, é só escolher um horário: {link}\n\nSe preferir não receber este tipo de mensagem: {sair}',
};
export const WEEKS = [4, 6, 8, 12, 26];
const clamp = (v, d, a, b) => Math.min(b, Math.max(a, Math.round(Number(v) || d)));
export async function config() {
  let c = {}; try { c = JSON.parse((await getSetting('react_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c };
}
export async function saveConfig(b) {
  const next = {
    auto: !!b.auto, weeks: WEEKS.includes(Number(b.weeks)) ? Number(b.weeks) : 6, includeAlta: !!b.includeAlta,
    cooldownDays: clamp(b.cooldownDays, 90, 30, 365), maxPerDay: clamp(b.maxPerDay, 10, 1, 50), hour: clamp(b.hour, 10, 8, 19), email: !!b.email,
    text: String(b.text || '').replace(/\r/g, '').trim().slice(0, 900) || DEFAULTS.text,
  };
  await setSetting('react_cfg', JSON.stringify(next));
  return next;
}
// O texto precisa do link de saída (LGPD): sem {sair}, ele é acrescentado ao final
export const withOptOut = (t) => (t.includes('{sair}') ? t : `${t}\n\nSe preferir não receber este tipo de mensagem: {sair}`);

// ---------- link para não receber mais ----------
const sig = (id) => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev').update(`reativacao:${id}`).digest('base64url').slice(0, 12);
export const optOutToken = (pid) => `${pid}.${sig(pid)}`;
export function idOfToken(t) {
  const m = /^(\d{1,10})\.([\w-]{12})$/.exec(String(t || ''));
  return m && crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sig(m[1]))) ? Number(m[1]) : null;
}
export const optOutUrl = (pid) => `${Notify.publicBase()}/sair/${optOutToken(pid)}`;
export const bookUrl = (ownerId) => `${Notify.publicBase()}/agendar${ownerId ? `?prof=${ownerId}` : ''}`;

// ---------- quem está afastado ----------
// scope: { sql, params } do perfil (patientScope); weeks: sem sessão realizada há pelo menos N semanas
export async function candidates({ weeks, includeAlta, cooldownDays, scope = { sql: ' ', params: [] }, ownerId = null, limit = 300 }) {
  const now = nowLocal();
  return q(`SELECT p.id, p.name, p.social_name, p.phone, p.email, p.whatsapp_optin, p.email_optin, p.status, p.owner_id, u.name pro, u.title pro_title,
      MAX(a.starts_at) last_at, COUNT(*) sessions,
      (SELECT MAX(l.sent_at) FROM react_log l WHERE l.patient_id = p.id) last_invite
    FROM patients p JOIN appointments a ON a.patient_id = p.id AND a.status = 'realizada' LEFT JOIN users u ON u.id = p.owner_id
    WHERE p.demo = 0 AND p.react_optin = 1 AND p.status IN (${includeAlta ? "'ativo','pausa','alta'" : "'ativo','pausa'"}) ${scope.sql}
      ${ownerId ? 'AND p.owner_id = ?' : ''}
      AND NOT EXISTS (SELECT 1 FROM appointments f WHERE f.patient_id = p.id AND f.status IN ('agendada','confirmada','aguardando','em_atendimento') AND f.starts_at >= DATE_SUB(?, INTERVAL 1 DAY))
      AND NOT EXISTS (SELECT 1 FROM react_log l WHERE l.patient_id = p.id AND l.sent_at >= DATE_SUB(?, INTERVAL ? DAY))
    GROUP BY p.id HAVING last_at < DATE_SUB(?, INTERVAL ? WEEK)
    ORDER BY last_at DESC LIMIT ?`, [...scope.params, ...(ownerId ? [ownerId] : []), now, now, cooldownDays, now, weeks, limit]);
}
export const channelOf = (p, c) => (p.whatsapp_optin && p.phone ? 'whatsapp' : c.email && p.email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.email) && p.email_optin !== 0 ? 'email' : null);
async function clinicName() { try { return JSON.parse((await getSetting('fin_clinic')) || '{}').name || 'Consultório Lorrainy Mendes'; } catch { return 'Consultório Lorrainy Mendes'; } }
export async function render(p, c = null) {
  c = c || await config();
  return WA.render(withOptOut(c.text), { nome: WA.firstName(p), clinica: await clinicName(), link: bookUrl(p.owner_id), sair: optOutUrl(p.id) });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);

// ---------- envio ----------
export async function invite(p, { c = null, userId = null, auto = false } = {}) {
  c = c || await config();
  const fresh = await one('SELECT id, name, social_name, phone, email, whatsapp_optin, email_optin, react_optin, owner_id, status FROM patients WHERE id = ?', [p.id]);
  if (!fresh?.react_optin) return { ok: false, error: 'O paciente não quer receber este tipo de mensagem.' };
  const recent = await one('SELECT id FROM react_log WHERE patient_id = ? AND sent_at >= DATE_SUB(?, INTERVAL ? DAY)', [fresh.id, nowLocal(), c.cooldownDays]);
  if (recent) return { ok: false, error: `Já convidado nos últimos ${c.cooldownDays} dias.` };
  const ch = channelOf(fresh, c);
  if (!ch) return { ok: false, error: 'Sem WhatsApp autorizado nem e-mail.' };
  const text = await render(fresh, c);
  let r;
  if (ch === 'whatsapp') {
    if (!WA.ready(await WA.config())) return { ok: false, error: 'WhatsApp desconectado.' };
    r = await WA.send({ phone: fresh.phone, text, kind: 'reativacao', patient_id: fresh.id, user_id: userId });
  } else {
    const nc = await Notify.config();
    if (!Notify.emailReady(nc)) return { ok: false, error: 'E-mail não configurado.' };
    const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#3b2a20;max-width:520px;margin:24px auto;padding:28px;background:#fffaf5;border-radius:18px;border:1px solid #ecdccd">${esc(text).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>')}</div>`;
    try { await Notify.sendEmail(nc, { to: fresh.email, subject: `${WA.firstName(fresh)}, sentimos sua falta`, text, html }); r = { ok: true }; } catch (e) { r = { ok: false, error: e.message }; }
  }
  if (r.ok) {
    const mark = Number((await one('SELECT COALESCE(MAX(id),0) m FROM appointments')).m);
    await q('INSERT INTO react_log (patient_id, owner_id, channel, sent_at, by_user, auto, appt_mark) VALUES (?,?,?,?,?,?,?)', [fresh.id, fresh.owner_id, ch, nowLocal(), userId, auto ? 1 : 0, mark]);
  }
  return { ...r, channel: ch };
}
export async function optOut(pid) { await q('UPDATE patients SET react_optin = 0 WHERE id = ?', [pid]); }

// ---------- resultado: quem voltou (marcou sessão depois do convite) ----------
const RETURNED = `(SELECT MIN(a.id) FROM appointments a WHERE a.patient_id = l.patient_id AND a.id > l.appt_mark AND a.status <> 'cancelada')`;
export async function history({ scope = { sql: ' ', params: [] }, days = 180, limit = 60 } = {}) {
  return q(`SELECT l.*, p.name, p.social_name, ${RETURNED} back_appt FROM react_log l JOIN patients p ON p.id = l.patient_id
    WHERE l.sent_at >= DATE_SUB(?, INTERVAL ? DAY) ${scope.sql} ORDER BY l.sent_at DESC LIMIT ?`, [nowLocal(), days, ...scope.params, limit]);
}
export async function stats({ scope = { sql: ' ', params: [] }, days = 90 } = {}) {
  const r = await one(`SELECT COUNT(*) sent, SUM(${RETURNED} IS NOT NULL) back FROM react_log l JOIN patients p ON p.id = l.patient_id
    WHERE l.sent_at >= DATE_SUB(?, INTERVAL ? DAY) ${scope.sql}`, [nowLocal(), days, ...scope.params]);
  return { sent: Number(r?.sent || 0), back: Number(r?.back || 0) };
}

// ---------- envio automático (uma vez por dia, no horário escolhido) ----------
let running = false;
export async function tick() {
  if (running) return { skipped: true };
  running = true;
  try {
    const c = await config();
    if (!c.auto) return { off: true };
    const now = nowLocal(); const today = todayLocal();
    if (Number(now.slice(11, 13)) < c.hour) return { early: true };
    const done = Number((await one('SELECT COUNT(*) n FROM react_log WHERE auto = 1 AND DATE(sent_at) = ?', [today])).n);
    let left = c.maxPerDay - done; let sent = 0;
    if (left <= 0) return { sent };
    for (const p of await candidates({ ...c, limit: 200 })) {
      if (left <= 0) break;
      if (!channelOf(p, c)) continue;
      const r = await invite(p, { c, auto: true });
      if (r.ok) { sent++; left--; }
    }
    return { sent };
  } finally { running = false; }
}
