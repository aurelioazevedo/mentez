// Canais de envio da própria Mentez (Painel): WhatsApp da plataforma (instância “mentez-plataforma” na Evolution da Mentez)
// e e-mail (SMTP da Mentez). Usados para cobrar as clínicas e, depois, para relacionamento e captação.
// Configuração no banco da plataforma; senha do SMTP selada com a chave mestra. A instância usa a chave geral da Evolution.
import nodemailer from 'nodemailer';
import * as T from './tenancy.js';
import * as Evolution from './evolution.js';

export const INSTANCE = 'mentez-plataforma';
async function getS(k) { return (await T.pone('SELECT v FROM platform_settings WHERE k = ?', [k]))?.v || null; }
async function setS(k, v) { await T.pq('INSERT INTO platform_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]); }
export const digits = (v) => String(v || '').replace(/\D/g, '');
// Número no formato do WhatsApp (DDI 55 para números brasileiros sem DDI)
export const waNumber = (v) => { const d = digits(v); if (d.length < 10) return ''; return d.length <= 11 ? `55${d}` : d; };

// ---------- WhatsApp da plataforma ----------
export const waEnabled = () => Evolution.enabled();
export async function waStatus() {
  if (!waEnabled()) return { state: 'indisponivel' };
  const i = (await Evolution.listAll()).get(INSTANCE);
  if (!i) return { state: 'sem-instancia' };
  return { state: i.status === 'open' ? 'open' : i.status, number: i.number, profileName: i.profileName };
}
export async function waCreate() {
  const i = (await Evolution.listAll()).get(INSTANCE);
  if (!i) await Evolution.api('POST', '/instance/create', { instanceName: INSTANCE, integration: 'WHATSAPP-BAILEYS', qrcode: true, rejectCall: true, groupsIgnore: true, alwaysOnline: false, readMessages: false, syncFullHistory: false });
  return { created: !i };
}
// QR code (data URL) de uma instância qualquer da Evolution da Mentez (a da plataforma ou a de uma clínica)
export async function qrOf(instance) {
  const r = await Evolution.api('GET', `/instance/connect/${encodeURIComponent(instance)}`);
  const qr = r?.base64 || r?.qrcode?.base64 || null;
  return { qr: qr && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qr) ? qr : null, state: r?.instance?.state || null };
}
export async function stateOf(instance) {
  try { return (await Evolution.api('GET', `/instance/connectionState/${encodeURIComponent(instance)}`)).instance?.state || 'desconhecido'; } catch (e) { return `erro: ${e.message}`; }
}
export async function waLogout() { await Evolution.api('DELETE', `/instance/logout/${INSTANCE}`); }
export async function waSend(phone, text) {
  const number = waNumber(phone);
  if (!number) throw new Error('Celular inválido.');
  if ((await stateOf(INSTANCE)) !== 'open') throw new Error('O WhatsApp da Mentez não está conectado (Painel → Comunicação).');
  return Evolution.api('POST', `/message/sendText/${INSTANCE}`, { number, text });
}

// ---------- e-mail (SMTP da Mentez) ----------
export const SECURE = { ssl: 'SSL (porta 465)', starttls: 'STARTTLS (porta 587)' };
export async function mailConfig() {
  let c = {}; try { c = JSON.parse((await getS('plat_mail')) || '{}'); } catch { /* padrão */ }
  let pass = ''; try { pass = c.pass_sealed ? T.unseal(c.pass_sealed).pass : ''; } catch { pass = ''; }
  return { host: c.host || '', port: c.port || 465, secure: SECURE[c.secure] ? c.secure : 'ssl', user: c.user || '', pass, fromName: c.fromName || 'Mentez', fromEmail: c.fromEmail || '' };
}
export const mailReady = (c) => !!(c.host && c.port && c.fromEmail);
export async function saveMail(b, cur) {
  const pass = b.pass_clear ? '' : String(b.pass || '').trim() || cur.pass;
  const port = Math.min(65535, Math.max(1, Number(b.port) || 465));
  const fromEmail = String(b.fromEmail || '').trim().slice(0, 190);
  if (fromEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(fromEmail)) return { error: 'E-mail do remetente inválido.' };
  await setS('plat_mail', JSON.stringify({ host: String(b.host || '').trim().slice(0, 190), port, secure: SECURE[b.secure] ? b.secure : 'ssl', user: String(b.user || '').trim().slice(0, 190),
    pass_sealed: pass ? T.seal({ pass }) : null, fromName: String(b.fromName || 'Mentez').trim().slice(0, 80), fromEmail }));
  return { ok: true };
}
const escHtml = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
function mailHtml(body, button) {
  const paras = escHtml(body).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:#04857E">$1</a>').split(/\n{2,}/).map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, '<br>')}</p>`).join('');
  const btn = button ? `<p style="margin:22px 0 8px"><a href="${escHtml(button.url)}" style="display:inline-block;background:#07C6BC;color:#071936;text-decoration:none;padding:13px 24px;border-radius:12px;font-weight:700">${escHtml(button.label)}</a></p>` : '';
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#F5F7FC;padding:24px 12px;font-family:Helvetica,Arial,sans-serif;color:#0D2246">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;border:1px solid #D9E0EC">
<div style="background:#071936;padding:18px 24px;color:#F5F7FC;font-weight:800;font-size:20px;letter-spacing:-.02em">mentez</div>
<div style="padding:24px;font-size:15.5px;line-height:1.6">${paras}${btn}</div>
<div style="padding:14px 24px;border-top:1px solid #E9EEF7;font-size:12px;color:#4F5E74">Mentez · Inteligência para cuidar de quem cuida · mentez.com.br</div></div></body></html>`;
}
export async function mailSend(to, subject, body, button = null) {
  const c = await mailConfig();
  if (!mailReady(c)) throw new Error('O e-mail da Mentez não está configurado (Painel → Comunicação).');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to || ''))) throw new Error('E-mail do destinatário inválido.');
  const tr = nodemailer.createTransport({ host: c.host, port: Number(c.port), secure: c.secure === 'ssl', requireTLS: c.secure === 'starttls', auth: c.user ? { user: c.user, pass: c.pass } : undefined, connectionTimeout: 15e3, greetingTimeout: 15e3, socketTimeout: 30e3 });
  return tr.sendMail({ from: { name: c.fromName, address: c.fromEmail }, to, subject, text: `${body}${button ? `\n\n${button.label}: ${button.url}` : ''}`, html: mailHtml(body, button) });
}
