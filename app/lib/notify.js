// Lembretes de sessão por e-mail e SMS (além do WhatsApp).
// E-mail: SMTP (por padrão o e-mail da clínica na Hostinger). SMS: Zenvia ou Twilio.
// Cada lembrete leva um link seguro para o paciente confirmar a presença ou pedir para remarcar.
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { nowLocal } from './time.js';
import * as WA from './whatsapp.js';
import * as Live from './live.js';

export const PROVIDERS = { zenvia: 'Zenvia', twilio: 'Twilio' };
export const MODES = { sempre: 'Sempre, junto com o WhatsApp', reserva: 'Só quando o WhatsApp não alcança o paciente (sem WhatsApp, sem autorização ou falha no envio)' };
export const SECURE = { ssl: 'SSL (porta 465)', starttls: 'STARTTLS (porta 587)', none: 'Sem criptografia (não recomendado)' };
export const DEFAULT_TEMPLATES = {
  emailSubject: 'Lembrete: sua sessão {quando} às {hora}',
  emailBody: 'Olá, {nome}!\n\nPassando para lembrar da sua sessão {modalidade} {quando} ({data}), às {hora}, com {profissional}.{link}\n\nPor favor, confirme sua presença pelo botão abaixo. Se precisar remarcar, é só avisar pelo mesmo link.\n\nAté breve!\n{clinica}',
  sms: '{clinica}: sua sessao e {quando}, {data_curta} as {hora}. Confirme ou remarque: {confirmar}',
};
const DEFAULTS = {
  emailOn: false, smtpHost: 'smtp.hostinger.com', smtpPort: 465, smtpSecure: 'ssl', smtpUser: '', fromEmail: '', fromName: '', // vazios: vêm da identidade da clínica replyTo: '', emailHours: 24,
  smsOn: false, smsProvider: 'zenvia', zenviaFrom: '', twilioSid: '', twilioFrom: '', smsHours: 3,
  mode: 'sempre', templates: { ...DEFAULT_TEMPLATES },
};
const WINDOW = [7, 21]; // envia entre 7h e 21h

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('notify_cfg')) || '{}'); } catch { /* padrão */ }
  const dec = (v) => { try { return v ? decrypt(v) : ''; } catch { return ''; } };
  const out = { ...DEFAULTS, ...c, templates: { ...DEFAULT_TEMPLATES, ...(c.templates || {}) } };
  const b = await Brand.load();
  out.fromName = out.fromName || b.name; out.fromEmail = out.fromEmail || b.email; out.smtpUser = out.smtpUser || b.email;
  out.smtpPass = dec(c.smtp_pass_enc); out.zenviaToken = dec(c.zenvia_token_enc); out.twilioToken = dec(c.twilio_token_enc);
  delete out.smtp_pass_enc; delete out.zenvia_token_enc; delete out.twilio_token_enc;
  if (!PROVIDERS[out.smsProvider]) out.smsProvider = 'zenvia';
  return out;
}
export const emailReady = (c) => !!(c.emailOn && c.smtpHost && c.smtpPort && c.fromEmail);
export const smsReady = (c) => !!(c.smsOn && (c.smsProvider === 'twilio' ? c.twilioSid && c.twilioToken && c.twilioFrom : c.zenviaToken && c.zenviaFrom));

const clampH = (v, d, max) => Math.min(max, Math.max(1, Math.round(Number(v) || d)));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function checkInput(b) {
  if (b.emailOn) {
    if (!String(b.smtpHost || '').trim()) return 'Informe o servidor SMTP do e-mail.';
    if (!EMAIL_RE.test(String(b.fromEmail || '').trim())) return 'Informe o e-mail remetente (ex.: contato@suaclinica.com.br).';
  }
  if (b.replyTo && !EMAIL_RE.test(String(b.replyTo).trim())) return 'O e-mail de resposta parece inválido.';
  return null;
}
export async function saveConfig(b, cur) {
  const keep = (v, old) => { const s = String(v || '').trim(); return s ? encrypt(s) : old ? encrypt(old) : null; };
  const t = (k, max) => String(b[k] ?? '').replace(/\r/g, '').trim().slice(0, max) || DEFAULT_TEMPLATES[k];
  await setSetting('notify_cfg', JSON.stringify({
    emailOn: !!b.emailOn, smtpHost: String(b.smtpHost || '').trim().slice(0, 120), smtpPort: Math.min(65535, Math.max(1, Number(b.smtpPort) || 465)),
    smtpSecure: SECURE[b.smtpSecure] ? b.smtpSecure : 'ssl', smtpUser: String(b.smtpUser || '').trim().slice(0, 190), smtp_pass_enc: keep(b.smtpPass, cur.smtpPass),
    fromEmail: String(b.fromEmail || '').trim().slice(0, 190), fromName: String(b.fromName || '').trim().slice(0, 80), replyTo: String(b.replyTo || '').trim().slice(0, 190),
    emailHours: clampH(b.emailHours, 24, 72),
    smsOn: !!b.smsOn, smsProvider: PROVIDERS[b.smsProvider] ? b.smsProvider : 'zenvia',
    zenvia_token_enc: keep(b.zenviaToken, cur.zenviaToken), zenviaFrom: String(b.zenviaFrom || '').trim().slice(0, 60),
    twilioSid: String(b.twilioSid || '').trim().slice(0, 64), twilio_token_enc: keep(b.twilioToken, cur.twilioToken), twilioFrom: String(b.twilioFrom || '').trim().slice(0, 30),
    smsHours: clampH(b.smsHours, 3, 48), mode: MODES[b.mode] ? b.mode : 'sempre',
    templates: { emailSubject: t('emailSubject', 160), emailBody: t('emailBody', 3000), sms: t('sms', 300) },
  }));
}

// ---------- link seguro de confirmação ----------
function sigOf(id) {
  const s = Tenancy.env('SESSION_SECRET') || 'dev';
  return crypto.createHmac('sha256', s).update(`lembrete:${id}`).digest('base64url').slice(0, 12);
}
export const tokenOf = (id) => `${id}.${sigOf(id)}`;
export function idOfToken(tok) {
  const m = /^(\d{1,10})\.([\w-]{12})$/.exec(String(tok || ''));
  if (!m) return null;
  const good = sigOf(m[1]);
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(good)) ? Number(m[1]) : null;
}
export const publicBase = () => (Tenancy.env('PUBLIC_URL') || 'https://sistema.lorrainymendes.com.br').replace(/\/+$/, '');
export const confirmUrl = (id) => `${publicBase()}/l/${tokenOf(id)}`;

// ---------- envio ----------
const ascii = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[–—]/g, '-').replace(/[^\x20-\x7E\n]/g, '');
export function smsNumber(phone) {
  const d = WA.normalizePhone(phone);
  return d && d.length === 13 && d[4] === '9' ? d : null; // celular brasileiro: 55 + DDD + 9 dígitos
}
async function clinicName(c) {
  if (c.fromName) return c.fromName;
  return (await Brand.load()).name;
}
function transport(c) {
  return nodemailer.createTransport({
    host: c.smtpHost, port: Number(c.smtpPort), secure: c.smtpSecure === 'ssl', requireTLS: c.smtpSecure === 'starttls', ignoreTLS: c.smtpSecure === 'none',
    auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass } : undefined, connectionTimeout: 15e3, greetingTimeout: 15e3, socketTimeout: 30e3,
  });
}
const escHtml = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
function emailHtml({ body, clinic, confirm }) {
  const paras = escHtml(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#9c4422">$1</a>').split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  const btn = confirm ? `<p style="margin:22px 0 8px"><a href="${confirm}" style="display:inline-block;background:#9c4422;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">Confirmar presença</a>
    <a href="${confirm}?remarcar=1" style="display:inline-block;color:#9c4422;text-decoration:none;padding:12px 16px;font-weight:600">Preciso remarcar</a></p>` : '';
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f6efe8;padding:24px 12px;font-family:Helvetica,Arial,sans-serif;color:#3b2a20">
  <div style="max-width:560px;margin:0 auto;background:#fffaf5;border-radius:18px;padding:28px 26px;border:1px solid #ecdccd">
    <p style="margin:0 0 18px;font-family:Georgia,serif;font-size:20px;color:#9c4422">${escHtml(clinic)}</p>
    <div style="font-size:15px;line-height:1.55">${paras}${btn}</div>
  </div>
  <p style="max-width:560px;margin:14px auto 0;font-size:11px;color:#8a7a6e;text-align:center">Você recebe este e-mail porque tem sessão agendada. Para não receber lembretes por e-mail, avise a equipe.</p>
</body></html>`;
}
function ics(a, clinic) {
  const st = String(a.starts_at).replace(' ', 'T');
  const start = new Date(`${st}-03:00`); const end = new Date(start.getTime() + (Number(a.duration_min) || 50) * 60e3);
  const f = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${Brand.get().short}//Lembretes//PT-BR`, 'METHOD:PUBLISH', 'BEGIN:VEVENT', `UID:sessao-${a.id}@${new URL(publicBase()).hostname}`,
    `DTSTAMP:${f(new Date())}`, `DTSTART:${f(start)}`, `DTEND:${f(end)}`, `SUMMARY:Sessão ${a.modality === 'online' ? 'on-line' : 'presencial'} — ${clinic.replace(/[,;]/g, ' ')}`,
    ...(a.meeting_link ? [`LOCATION:${a.meeting_link}`] : []), 'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', 'DESCRIPTION:Sessão em 1 hora', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
}

export async function sendEmail(c, { to, subject, text, html, attachments }) {
  const info = await transport(c).sendMail({ from: { name: await clinicName(c), address: c.fromEmail }, to, replyTo: c.replyTo || undefined, subject, text, html, attachments });
  return { id: info.messageId || null };
}
export async function sendSms(c, { to, text }) {
  const body = ascii(text).slice(0, 300);
  if (c.smsProvider === 'twilio') {
    const base = process.env.SMS_TWILIO_URL || 'https://api.twilio.com';
    const r = await fetch(`${base}/2010-04-01/Accounts/${encodeURIComponent(c.twilioSid)}/Messages.json`, { method: 'POST', signal: AbortSignal.timeout(20e3),
      headers: { Authorization: `Basic ${Buffer.from(`${c.twilioSid}:${c.twilioToken}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: `+${to}`, From: c.twilioFrom, Body: body }) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.message || `Twilio respondeu ${r.status}`);
    return { id: j.sid || null };
  }
  const base = process.env.SMS_ZENVIA_URL || 'https://api.zenvia.com';
  const r = await fetch(`${base}/v2/channels/sms/messages`, { method: 'POST', signal: AbortSignal.timeout(20e3),
    headers: { 'X-API-TOKEN': c.zenviaToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: c.zenviaFrom, to, contents: [{ type: 'text', text: body }] }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.message || j.details?.[0]?.message || `Zenvia respondeu ${r.status}`);
  return { id: j.id || null };
}

async function log({ appt = null, patient = null, channel, kind = 'lembrete', dest, status, error = null, providerId = null }) {
  await q('INSERT INTO notify_log (appointment_id, patient_id, channel, kind, dest_enc, status, error, provider_id) VALUES (?,?,?,?,?,?,?,?)',
    [appt, patient, channel, kind, dest ? encrypt(String(dest)) : null, status, error ? String(error).slice(0, 255) : null, providerId ? String(providerId).slice(0, 120) : null]);
}

const APPT_SQL = 'SELECT a.*, p.name, p.social_name, p.phone, p.email, p.email_optin, p.sms_optin, p.whatsapp_optin, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?';
async function varsOf(a, c) {
  const v = await WA.apptVars(a);
  return { ...v, data_curta: String(v.data).slice(0, 5), confirmar: confirmUrl(a.id), clinica: await clinicName(c) };
}

export async function reminderEmail(apptId, { c = null } = {}) {
  c = c || await config();
  if (!emailReady(c)) return { ok: false, error: 'E-mail não configurado ou desligado.' };
  const a = await one(APPT_SQL, [apptId]);
  if (!a) return { ok: false, error: 'Sessão não encontrada.' };
  if (!['agendada', 'confirmada'].includes(a.status)) return { ok: false, error: 'A sessão não está agendada.' };
  if (!a.email || !EMAIL_RE.test(a.email)) return { ok: false, error: 'O paciente não tem e-mail válido na ficha.' };
  if (!a.email_optin) return { ok: false, error: 'O paciente não quer lembretes por e-mail.' };
  const v = await varsOf(a, c);
  const text = WA.render(c.templates.emailBody, v);
  try {
    const r = await sendEmail(c, { to: a.email, subject: WA.render(c.templates.emailSubject, v).replace(/\s+/g, ' ').trim(), text: `${text}\n\nConfirmar presença ou remarcar: ${v.confirmar}`,
      html: emailHtml({ body: text, clinic: v.clinica, confirm: v.confirmar }), attachments: [{ filename: 'sessao.ics', content: ics(a, v.clinica), contentType: 'text/calendar; charset=utf-8; method=PUBLISH' }] });
    await q('UPDATE appointments SET email_reminder_at = NOW() WHERE id = ?', [a.id]);
    await log({ appt: a.id, patient: a.patient_id, channel: 'email', dest: a.email, status: 'enviado', providerId: r.id });
    Live.emit('agenda');
    return { ok: true };
  } catch (e) {
    await log({ appt: a.id, patient: a.patient_id, channel: 'email', dest: a.email, status: 'erro', error: e.message });
    return { ok: false, error: e.message };
  }
}

export async function reminderSms(apptId, { c = null } = {}) {
  c = c || await config();
  if (!smsReady(c)) return { ok: false, error: 'SMS não configurado ou desligado.' };
  const a = await one(APPT_SQL, [apptId]);
  if (!a) return { ok: false, error: 'Sessão não encontrada.' };
  if (!['agendada', 'confirmada'].includes(a.status)) return { ok: false, error: 'A sessão não está agendada.' };
  const to = smsNumber(a.phone);
  if (!to) return { ok: false, error: 'O paciente não tem celular válido na ficha.' };
  if (!a.sms_optin) return { ok: false, error: 'O paciente não quer lembretes por SMS.' };
  const text = WA.render(c.templates.sms, await varsOf(a, c));
  try {
    const r = await sendSms(c, { to, text });
    await q('UPDATE appointments SET sms_reminder_at = NOW() WHERE id = ?', [a.id]);
    await log({ appt: a.id, patient: a.patient_id, channel: 'sms', dest: to, status: 'enviado', providerId: r.id });
    Live.emit('agenda');
    return { ok: true };
  } catch (e) {
    await log({ appt: a.id, patient: a.patient_id, channel: 'sms', dest: to, status: 'erro', error: e.message });
    return { ok: false, error: e.message };
  }
}

export async function testEmail(to) {
  const c = await config();
  if (!c.smtpHost || !c.fromEmail) return { ok: false, error: 'Preencha e salve o servidor e o remetente antes de testar.' };
  if (!EMAIL_RE.test(String(to || ''))) return { ok: false, error: 'Informe um e-mail válido para o teste.' };
  const clinic = await clinicName(c);
  try {
    const r = await sendEmail(c, { to, subject: `Teste de lembrete — ${clinic}`, text: 'Este é um teste dos lembretes por e-mail do sistema. Se chegou, está tudo certo.', html: emailHtml({ body: 'Este é um teste dos lembretes por e-mail do sistema.\n\nSe chegou, está tudo certo. ✓', clinic, confirm: null }) });
    await log({ channel: 'email', kind: 'teste', dest: to, status: 'enviado', providerId: r.id });
    return { ok: true };
  } catch (e) { await log({ channel: 'email', kind: 'teste', dest: to, status: 'erro', error: e.message }); return { ok: false, error: e.message }; }
}
export async function testSms(phone) {
  const c = await config();
  const to = smsNumber(phone);
  if (!to) return { ok: false, error: 'Informe um celular com DDD para o teste.' };
  if (!(c.smsProvider === 'twilio' ? c.twilioSid && c.twilioToken && c.twilioFrom : c.zenviaToken && c.zenviaFrom)) return { ok: false, error: 'Preencha e salve as credenciais do SMS antes de testar.' };
  try {
    const r = await sendSms(c, { to, text: `${await clinicName(c)}: teste dos lembretes por SMS. Se chegou, esta tudo certo.` });
    await log({ channel: 'sms', kind: 'teste', dest: to, status: 'enviado', providerId: r.id });
    return { ok: true };
  } catch (e) { await log({ channel: 'sms', kind: 'teste', dest: to, status: 'erro', error: e.message }); return { ok: false, error: e.message }; }
}

// ---------- envio automático ----------
// No modo “reserva”, só vai por e-mail/SMS quando o WhatsApp não alcança o paciente.
async function whatsappReaches(a, wac) {
  if (!WA.ready(wac) || !wac.autoReminders || !a.whatsapp_optin || !a.phone) return false;
  if (!a.wa_reminder_at) return null; // ainda não tentou: espera
  const last = await one("SELECT status FROM wa_messages WHERE appointment_id = ? AND kind = 'lembrete' ORDER BY id DESC LIMIT 1", [a.id]);
  return last ? last.status !== 'erro' : null;
}
const RUNNING = Tenancy.scoped({ on: false }); // trava por clínica
export async function tick({ max = 25 } = {}) {
  if (RUNNING.on) return { skipped: true };
  RUNNING.on = true;
  const out = { email: 0, sms: 0, failed: 0 };
  try {
    const c = await config();
    const eOk = emailReady(c); const sOk = smsReady(c);
    if (!eOk && !sOk) return out;
    const hour = Number(nowLocal().slice(11, 13));
    if (!process.env.WA_IGNORE_WINDOW && (hour < WINDOW[0] || hour >= WINDOW[1])) return { ...out, outsideWindow: true };
    const wac = c.mode === 'reserva' ? await WA.config() : null;
    for (const [ch, ok, hours, col, cond] of [
      ['email', eOk, c.emailHours, 'email_reminder_at', "p.email_optin = 1 AND p.email LIKE '%@%'"],
      ['sms', sOk, c.smsHours, 'sms_reminder_at', "p.sms_optin = 1 AND p.phone IS NOT NULL AND p.phone <> ''"],
    ]) {
      if (!ok) continue;
      const due = await q(`SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.status IN ('agendada','confirmada') AND a.${col} IS NULL AND ${cond}
          AND a.starts_at > DATE_ADD(NOW(), INTERVAL 15 MINUTE) AND a.starts_at <= DATE_ADD(NOW(), INTERVAL ? HOUR)
        ORDER BY a.starts_at LIMIT ?`, [hours, max]);
      for (const { id } of due) {
        if (c.mode === 'reserva') {
          const a = await one(APPT_SQL, [id]);
          const reach = await whatsappReaches(a, wac);
          if (reach === null) continue; // espera o WhatsApp tentar primeiro
          if (reach) { await q(`UPDATE appointments SET ${col} = '1970-01-01 00:00:00' WHERE id = ?`, [id]); continue; } // WhatsApp entregou: não precisa
        }
        const claim = await q(`UPDATE appointments SET ${col} = NOW() WHERE id = ? AND ${col} IS NULL`, [id]);
        if (!claim.affectedRows) continue;
        const r = ch === 'email' ? await reminderEmail(id, { c }) : await reminderSms(id, { c });
        if (r.ok) out[ch]++; else out.failed++;
      }
    }
    return out;
  } catch (e) { console.error('lembretes e-mail/SMS', e.message); return { ...out, error: e.message }; } finally { RUNNING.on = false; }
}

export async function historyOf(apptId) {
  const rows = await q("SELECT * FROM notify_log WHERE appointment_id = ? ORDER BY id DESC LIMIT 10", [apptId]);
  return rows.map((r) => ({ ...r, dest: (() => { try { return r.dest_enc ? decrypt(r.dest_enc) : ''; } catch { return ''; } })() }));
}
export async function stats() {
  return one(`SELECT SUM(channel='email' AND status='enviado') email, SUM(channel='sms' AND status='enviado') sms, SUM(status='erro') erros
    FROM notify_log WHERE kind = 'lembrete' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`);
}
export async function recent(n = 12) {
  const rows = await q(`SELECT l.*, p.name, p.social_name FROM notify_log l LEFT JOIN patients p ON p.id = l.patient_id ORDER BY l.id DESC LIMIT ?`, [n]);
  return rows.map((r) => ({ ...r, dest: (() => { try { return r.dest_enc ? decrypt(r.dest_enc) : ''; } catch { return ''; } })() }));
}
