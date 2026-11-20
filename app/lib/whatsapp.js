// Integração com o WhatsApp via Evolution API (instância própria do consultório).
// Envia lembretes, links e confirmações; recebe respostas “1/2” por webhook.
// Nenhum conteúdo clínico é enviado. O texto das mensagens fica criptografado no registro.
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { brDate, weekday, money } from './html.js';
import { todayLocal, nowLocal, addDays } from './time.js';
import { notify } from './push.js';
import * as Agent from './agent.js';
import * as CRM from './crm.js';
import { proName } from './perm.js';
import * as Live from './live.js';
import * as Fin from './fin.js';
import * as Waitlist from './waitlist.js';
import QRCode from 'qrcode';

export const DEFAULT_TEMPLATES = {
  lembrete: 'Olá, {nome}! 😊\nPassando para lembrar da sua sessão {modalidade} *{quando} ({data}), às {hora}* com {profissional}.{link}\n\nPor favor, responda:\n*1* para confirmar\n*2* se precisar remarcar',
  confirmado: 'Obrigada, {nome}! Sua sessão de {dia_semana} ({data}) às {hora} está confirmada. ✅',
  agendamento: 'Olá, {nome}! 😊\nSua sessão {modalidade} com {profissional} está marcada *{quando} ({data}), às {hora}*.{datas_extra}{link}{recado}\n\nSe precisar remarcar, é só responder esta mensagem.',
  profissional: '📅 *Nova sessão agendada*\n{paciente} — {dia_semana}, {data}, às {hora} · {modalidade}{datas_extra}\nAgendado por {autor}.',
  aviso: 'Olá, {nome}! Sua sessão {modalidade} com {profissional} começa *hoje às {hora}*.{link}\n\nAté já! 😊',
  remarcar: 'Tudo bem, {nome}! Recebemos seu pedido para remarcar a sessão de {dia_semana} ({data}) às {hora}. Em breve entraremos em contato para combinar um novo horário.',
  exercicio: 'Olá, {nome}! Conforme combinamos na sessão, segue o exercício “{exercicio}”:\n{link}\n\nO link é pessoal, não compartilhe.',
  pagamento: 'Olá, {nome}! Confirmamos o recebimento de {valor} ({descricao}). Obrigada! Se precisar do recibo, é só pedir.',
  cobranca_pix: 'Olá, {nome}! Tudo bem? Segue o código Pix referente a *{descricao}*, no valor de *{valor}* (vencimento em {vencimento}).\n\nCopie o código da próxima mensagem e cole no app do seu banco, na opção “Pix copia e cola” — ou, se preferir, leia o QR code da imagem.\n\nSe já pagou, por favor desconsidere. 🙏',
  cobranca_link: 'Olá, {nome}! Tudo bem? Segue o pagamento de *{descricao}*, no valor de *{valor}* (vencimento em {vencimento}).\n\nPague por Pix, boleto ou cartão neste link seguro:\n{link}\n\nSe preferir Pix, o código vai na próxima mensagem. A confirmação chega aqui automaticamente. 🙏',
  cobranca: 'Olá, {nome}! Tudo bem? Passando para lembrar do pagamento de *{descricao}*, no valor de *{valor}*, com vencimento em {vencimento}.{pix}\n\nSe já pagou, por favor desconsidere. Qualquer dúvida, é só responder esta mensagem. 🙏',
};
export const TEMPLATE_LABELS = {
  agendamento: 'Confirmação de agendamento (para o paciente)', profissional: 'Aviso de nova sessão (para o profissional)',
  lembrete: 'Lembrete de sessão (pede confirmação)', aviso: 'Aviso pouco antes da sessão (sem pedir confirmação)', confirmado: 'Resposta à confirmação (1)', remarcar: 'Resposta ao pedido de remarcação (2)',
  exercicio: 'Envio de exercício', pagamento: 'Confirmação de pagamento', cobranca: 'Cobrança de pagamento em aberto (sem chave Pix)', cobranca_pix: 'Cobrança com Pix (1ª mensagem; depois vão o código e o QR code)', cobranca_link: 'Cobrança online — Asaas (link de Pix, boleto ou cartão; depois vão o código Pix e o QR code)',
};
export const PLACEHOLDERS = '{nome} {data} {hora} {dia_semana} {quando} {modalidade} {profissional} {link} {datas_extra} {recado} {paciente} {autor} {exercicio} {valor} {descricao} {vencimento} {pix}';

// ---------- configuração ----------
const S = Tenancy.scoped({ cache: null, stateCache: null }); // caches com um valor por clínica
export async function config() {
  if (S.cache && S.cache.at > Date.now() - 30e3) return S.cache.v;
  const raw = await getSetting('wa_config');
  let c = null;
  if (raw) {
    try {
      c = JSON.parse(raw);
      c.apiKey = c.key_enc ? decrypt(c.key_enc) : '';
    } catch { c = null; }
  }
  if (c) {
    c.templates = { ...DEFAULT_TEMPLATES, ...(c.templates || {}) };
    c.hours = Number(c.hours) || 24;
    c.secondHours = [1, 2, 3].includes(Number(c.secondHours)) ? Number(c.secondHours) : 2;
    c.windowStart = Number.isFinite(Number(c.windowStart)) ? Number(c.windowStart) : 8;
    c.windowEnd = Number.isFinite(Number(c.windowEnd)) ? Number(c.windowEnd) : 20;
  }
  S.cache = { at: Date.now(), v: c };
  return c;
}
export async function saveConfig(patch) {
  const cur = (await config()) || {};
  const next = { ...cur, ...patch };
  if (patch.apiKey) next.key_enc = encrypt(patch.apiKey);
  delete next.apiKey;
  if (!next.webhookSecret) next.webhookSecret = crypto.randomBytes(24).toString('base64url');
  if (!next.cronToken) next.cronToken = crypto.randomBytes(24).toString('base64url');
  await setSetting('wa_config', JSON.stringify(next));
  S.cache = null;
  return config();
}
export async function clearConfig() { await setSetting('wa_config', null); S.cache = null; }
export const ready = (c) => !!(c && c.enabled && c.url && c.apiKey && c.instance);

// ---------- Evolution API ----------
async function evo(c, method, path, body) {
  const res = await fetch(`${c.url.replace(/\/+$/, '')}${path}`, {
    method, headers: { apikey: c.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.response?.message ? [].concat(data.response.message).map((m) => (typeof m === 'string' ? m : JSON.stringify(m))).join('; ') : data?.message || `Evolution respondeu ${res.status}`;
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return data;
}
const inst = (c) => encodeURIComponent(c.instance);
// Baixa a mídia de uma mensagem recebida (áudio, foto, vídeo, arquivo) em base64
export async function downloadMedia(msgKey, c = null) {
  c = c || (await config());
  const d = await evo(c, 'POST', `/chat/getBase64FromMediaMessage/${inst(c)}`, { message: { key: msgKey }, convertToMp4: false });
  return d?.base64 ? { base64: d.base64, mimetype: d.mimetype || null, fileName: d.fileName || null } : null;
}

// ---------- foto de perfil do contato ----------
// A Evolution devolve uma URL temporária (pps.whatsapp.net); baixamos e guardamos no banco,
// para servir pelo próprio sistema (a CSP só permite imagens do próprio domínio).
const PIC_TTL_H = 72; const NOPIC_TTL_H = 24;
const IMG_SIG = { 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const picInflight = new Tenancy.TMap();  // separado por clínica
export async function profilePhoto(phone) {
  const key = phoneKey(phone);
  if (!key) return null;
  const row = await one('SELECT data, mime, TIMESTAMPDIFF(HOUR, fetched_at, NOW()) age FROM wa_photos WHERE phone_key = ?', [key]);
  if (row && row.age < (row.data ? PIC_TTL_H : NOPIC_TTL_H)) return row.data ? { data: row.data, mime: row.mime } : null;
  if (!picInflight.has(key)) picInflight.set(key, fetchPhoto(phone, key).finally(() => picInflight.delete(key)));
  const fresh = await picInflight.get(key);
  if (fresh === undefined) return row?.data ? { data: row.data, mime: row.mime } : null; // falhou agora: usa a antiga
  return fresh;
}
async function fetchPhoto(phone, key) {
  const c = await config();
  const number = normalizePhone(phone);
  if (!ready(c) || !number) return undefined;
  try {
    const r = await evo(c, 'POST', `/chat/fetchProfilePictureUrl/${inst(c)}`, { number });
    const url = r?.profilePictureUrl;
    let out = null;
    if (url) {
      const u = new URL(url); const evoHost = new URL(c.url).host;
      if (!(u.protocol === 'https:' && /(^|\.)whatsapp\.net$/.test(u.hostname)) && u.host !== evoHost) throw new Error('URL de foto inesperada');
      const res = await fetch(u, { signal: AbortSignal.timeout(10000), redirect: 'error' });
      const buf = res.ok ? Buffer.from(await res.arrayBuffer()) : null;
      const mime = buf && buf.length <= 1024 * 1024 && Object.keys(IMG_SIG).find((m) => IMG_SIG[m].every((b, i) => buf[i] === b));
      if (mime) out = { data: buf, mime };
    }
    await q('INSERT INTO wa_photos (phone_key, data, mime, fetched_at) VALUES (?,?,?,NOW()) ON DUPLICATE KEY UPDATE data = VALUES(data), mime = VALUES(mime), fetched_at = NOW()', [key, out?.data || null, out?.mime || null]);
    return out;
  } catch { return undefined; }
}

export async function connectionState(c, fresh = false) {
  if (!fresh && S.stateCache && S.stateCache.at > Date.now() - 120e3 && S.stateCache.key === c.url + c.instance) return S.stateCache.v;
  let v;
  try { v = (await evo(c, 'GET', `/instance/connectionState/${inst(c)}`)).instance?.state || 'desconhecido'; } catch (e) { v = `erro: ${e.message}`; }
  S.stateCache = { at: Date.now(), key: c.url + c.instance, v };
  return v;
}

// ---------- instâncias / pareamento do aparelho ----------
export const validInstanceName = (n) => /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$/.test(String(n || ''));
export async function listInstances(c) {
  const list = await evo(c, 'GET', '/instance/fetchInstances');
  return (Array.isArray(list) ? list : []).map((i) => ({
    name: i.name ?? i.instance?.instanceName,
    status: i.connectionStatus ?? i.instance?.status ?? 'desconhecido',
    number: String(i.ownerJid || i.instance?.owner || '').split('@')[0] || null,
    profileName: i.profileName ?? i.instance?.profileName ?? null,
    integration: i.integration ?? i.instance?.integration ?? null,
  })).filter((i) => i.name);
}
// QR code (base64 data URL) e/ou código de pareamento para conectar o aparelho.
export async function connectInstance(c, number = null) {
  const r = await evo(c, 'GET', `/instance/connect/${inst(c)}${number ? `?number=${encodeURIComponent(number)}` : ''}`);
  S.stateCache = null;
  const qr = r?.base64 || r?.qrcode?.base64 || null;
  return { qr: qr && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(qr) ? qr : null, pairingCode: r?.pairingCode || r?.qrcode?.pairingCode || null, state: r?.instance?.state || null };
}
// Envio direto por uma instância específica, sem registrar no histórico nem no CRM (alertas de suporte).
export async function sendRaw(c, instance, phone, text) {
  const number = normalizePhone(phone);
  if (!c || !c.url || !number) throw new Error('WhatsApp ou número inválido.');
  return evo(c, 'POST', `/message/sendText/${encodeURIComponent(instance)}`, { number, text });
}
export async function instanceState(c, instance) {
  try { return (await evo(c, 'GET', `/instance/connectionState/${encodeURIComponent(instance)}`)).instance?.state || 'desconhecido'; } catch (e) { return `erro: ${e.message}`; }
}
export async function createInstance(c, name) {
  S.stateCache = null;
  return evo(c, 'POST', '/instance/create', { instanceName: name, integration: 'WHATSAPP-BAILEYS', qrcode: true });
}
export async function logoutInstance(c) {
  S.stateCache = null;
  return evo(c, 'DELETE', `/instance/logout/${inst(c)}`);
}

export async function setWebhook(c, url) {
  return evo(c, 'POST', `/webhook/set/${inst(c)}`, { webhook: { enabled: true, url, events: ['MESSAGES_UPSERT'], byEvents: false, base64: false } });
}

// Número brasileiro → formato internacional sem símbolos (55 + DDD + número).
export function normalizePhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 || d.length === 11) d = `55${d}`;
  return d.length >= 12 && d.length <= 13 ? d : null;
}
// Chave de comparação tolerante ao “9” extra dos celulares: DDD + 8 últimos dígitos.
export function phoneKey(phone) {
  const d = normalizePhone(phone);
  if (!d) return null;
  const local = d.slice(2);
  return local.slice(0, 2) + local.slice(-8);
}

export function render(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined && vars[k] !== null ? String(vars[k]) : ''));
}

async function log(entry) {
  await q('INSERT INTO wa_messages (patient_id, appointment_id, user_id, kind, direction, phone, body_enc, status, wa_id, error) VALUES (?,?,?,?,?,?,?,?,?,?)', [
    entry.patient_id || null, entry.appointment_id || null, entry.user_id || null, entry.kind, entry.direction || 'out',
    entry.phone || null, entry.body ? encrypt(entry.body) : null, entry.status, entry.wa_id || null, entry.error ? String(entry.error).slice(0, 250) : null,
  ]);
}

// Envio genérico com registro. Retorna { ok, error }.
export async function send({ phone, text, kind, patient_id, appointment_id, user_id, image, media }, c) {
  c = c || (await config());
  const number = normalizePhone(phone);
  if (!ready(c)) return { ok: false, error: 'WhatsApp não configurado ou desativado.' };
  // Paciente de demonstração: nada sai pelo WhatsApp (o envio é só simulado).
  if (patient_id && (await one('SELECT demo FROM patients WHERE id = ?', [patient_id]))?.demo) return { ok: true, simulated: true };
  if (appointment_id && (await one('SELECT p.demo FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [appointment_id]))?.demo) return { ok: true, simulated: true };
  if (!number) {
    await log({ kind, patient_id, appointment_id, user_id, phone, body: text, status: 'erro', error: 'Telefone inválido' });
    return { ok: false, error: 'Telefone do paciente ausente ou inválido.' };
  }
  try {
    // "Connection Closed"/503: a sessão estava reconectando e a mensagem NÃO saiu — seguro tentar de novo.
    // Timeout não é repetido: a mensagem pode ter saído e a resposta demorado (evita duplicar).
    let r;
    for (let tent = 1; ; tent++) {
      try {
        r = media?.type === 'audio' // áudio (ex.: encaminhado no atendimento humano) — chega como mensagem de voz
          ? await evo(c, 'POST', `/message/sendWhatsAppAudio/${inst(c)}`, { number, audio: media.base64 })
          : media // imagem, vídeo ou arquivo em base64, com legenda
            ? await evo(c, 'POST', `/message/sendMedia/${inst(c)}`, { number, mediatype: media.type, mimetype: media.mimetype || 'application/octet-stream', media: media.base64, fileName: media.fileName || 'arquivo', caption: text || '' })
            : image // imagem (ex.: QR code Pix) em base64, com legenda opcional
              ? await evo(c, 'POST', `/message/sendMedia/${inst(c)}`, { number, mediatype: 'image', mimetype: 'image/png', media: image, fileName: 'qrcode-pix.png', caption: text || '' })
              : await evo(c, 'POST', `/message/sendText/${inst(c)}`, { number, text });
        break;
      } catch (e) {
        const transient = e.status === 503 || e.status === 502 || /connection closed|not connected|connection.*(lost|failure)/i.test(e.message);
        if (!transient || tent >= 4) throw e;
        await new Promise((ok) => setTimeout(ok, Number(process.env.WA_RETRY_MS || 3000) * tent));
      }
    }
    await log({ kind, patient_id, appointment_id, user_id, phone: number, body: media ? `[${{ audio: 'áudio', image: 'imagem', video: 'vídeo', document: 'arquivo' }[media.type] || 'mídia'}] ${text || ''}`.trim() : image ? `[imagem] ${text || ''}`.trim() : text, status: 'enviado', wa_id: r?.key?.id });
    CRM.touchOutbound({ phone: number, kind, text, patientId: patient_id });
    Live.emit(['crm', 'agenda']);
    return { ok: true, waId: r?.key?.id || null };
  } catch (e) {
    const error = /"exists"\s*:\s*false|not.*whatsapp/i.test(e.message) ? 'Este número não tem WhatsApp.' : e.message;
    await log({ kind, patient_id, appointment_id, user_id, phone: number, body: text, status: 'erro', error });
    return { ok: false, error };
  }
}

// ---------- mensagens do consultório ----------
export const firstName = (p) => String(p.social_name || p.name || '').trim().split(/\s+/)[0];

export async function apptVars(a) {
  const prof = a.owner_id ? await one('SELECT name, title FROM users WHERE id = ?', [a.owner_id]) : null;
  const date = a.starts_at.slice(0, 10);
  const today = todayLocal();
  const dia = weekday(date);
  // “amanhã, quinta” · “hoje, segunda” · “no sábado” · “na terça”
  const quando = date === today ? `hoje, ${dia}` : date === addDays(today, 1) ? `amanhã, ${dia}` : `${['sábado', 'domingo'].includes(dia) ? 'no' : 'na'} ${dia}`;
  return {
    nome: firstName(a), data: brDate(date), hora: a.starts_at.slice(11, 16), dia_semana: weekday(date), quando,
    modalidade: a.modality === 'online' ? 'on-line' : 'presencial', profissional: prof ? proName(prof) : Brand.get().who,
    link: a.modality === 'online' && a.meeting_link ? `\n\nLink da chamada: ${a.meeting_link}` : '',
  };
}
const APPT_SQL = `SELECT a.*, p.name, p.social_name, p.phone, p.whatsapp_optin, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?`;

export async function sendReminder(apptId, userId = null) {
  const c = await config();
  const a = await one(APPT_SQL, [apptId]);
  if (!a) return { ok: false, error: 'Sessão não encontrada.' };
  if (!a.whatsapp_optin) return { ok: false, error: 'O paciente não autorizou mensagens pelo WhatsApp.' };
  if (!['agendada', 'confirmada'].includes(a.status)) return { ok: false, error: 'A sessão não está agendada.' };
  const text = render(c?.templates.lembrete, await apptVars(a));
  const r = await send({ phone: a.phone, text, kind: 'lembrete', patient_id: a.patient_id, appointment_id: a.id, user_id: userId }, c);
  if (r.ok) await q('UPDATE appointments SET wa_reminder_at = NOW(), wa_reply = NULL, wa_reply_at = NULL WHERE id = ?', [a.id]);
  return r;
}

// Aviso curto pouco antes da sessão — só informa, não pede confirmação nem oferece remarcar.
export async function sendShortNotice(apptId, userId = null) {
  const c = await config();
  const a = await one(APPT_SQL, [apptId]);
  if (!a) return { ok: false, error: 'Sessão não encontrada.' };
  if (!a.whatsapp_optin) return { ok: false, error: 'O paciente não autorizou mensagens pelo WhatsApp.' };
  if (!['agendada', 'confirmada'].includes(a.status)) return { ok: false, error: 'A sessão não está agendada.' };
  const text = render(c?.templates.aviso, await apptVars(a));
  const r = await send({ phone: a.phone, text, kind: 'aviso', patient_id: a.patient_id, appointment_id: a.id, user_id: userId }, c);
  if (r.ok) await q('UPDATE appointments SET wa_reminder2_at = NOW() WHERE id = ?', [a.id]);
  return r;
}

// Confirmação do agendamento para o paciente (uma mensagem para a série toda).
function extraDates(appts) {
  if (appts.length < 2) return '';
  const rest = appts.slice(1).map((x) => brDate(x.starts_at).slice(0, 5));
  return `\nE também nas próximas semanas, no mesmo horário: ${rest.join(', ')}.`;
}
export async function sendBookingToPatient(apptIds, userId) {
  const c = await config();
  const appts = [];
  for (const id of [].concat(apptIds)) { const a = await one(APPT_SQL, [id]); if (a) appts.push(a); }
  if (!appts.length) return { ok: false, error: 'Sessão não encontrada.' };
  const a = appts[0];
  if (!a.whatsapp_optin) return { ok: false, error: 'O paciente não autorizou mensagens pelo WhatsApp.' };
  const vars = await apptVars(a);
  const text = render(c?.templates.agendamento, { ...vars, datas_extra: extraDates(appts), recado: a.patient_note ? `\n\n📝 ${a.patient_note}` : '' });
  return send({ phone: a.phone, text, kind: 'agendamento', patient_id: a.patient_id, appointment_id: a.id, user_id: userId }, c);
}

// Aviso para o WhatsApp do(a) profissional responsável.
export async function sendBookingToProfessional(apptIds, userId) {
  const c = await config();
  const appts = [];
  for (const id of [].concat(apptIds)) { const a = await one(APPT_SQL, [id]); if (a) appts.push(a); }
  if (!appts.length) return { ok: false, error: 'Sessão não encontrada.' };
  const a = appts[0];
  const prof = await one('SELECT name, phone FROM users WHERE id = ?', [a.owner_id]);
  if (!prof?.phone) return { ok: false, error: 'O profissional não tem WhatsApp cadastrado (Usuários).' };
  const author = userId ? await one('SELECT name FROM users WHERE id = ?', [userId]) : null;
  const parts = String(a.social_name || a.name).trim().split(/\s+/);
  const paciente = parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1][0]}.` : parts[0];
  const text = render(c?.templates.profissional, { ...(await apptVars(a)), paciente, autor: author?.name || 'sistema', datas_extra: appts.length > 1 ? ` (+${appts.length - 1} semana(s))` : '' });
  return send({ phone: prof.phone, text, kind: 'profissional', appointment_id: a.id, user_id: userId }, c);
}

export async function sendExercise(patientId, exerciseTitle, link, userId) {
  const c = await config();
  const p = await one('SELECT id, name, social_name, phone, whatsapp_optin FROM patients WHERE id = ?', [patientId]);
  if (!p?.whatsapp_optin) return { ok: false, error: 'O paciente não autorizou mensagens pelo WhatsApp.' };
  const text = render(c?.templates.exercicio, { nome: firstName(p), exercicio: exerciseTitle, link });
  return send({ phone: p.phone, text, kind: 'exercicio', patient_id: p.id, user_id: userId }, c);
}

// Cobrança de um recebimento em aberto, com o Pix copia e cola de quem recebe (clínica ou profissional).
export async function sendCharge(paymentId, userId) {
  const c = await config();
  const x = await one('SELECT x.*, p.name, p.social_name, p.phone, p.whatsapp_optin FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ?', [paymentId]);
  if (!x) return { ok: false, error: 'Lançamento não encontrado.' };
  if (x.paid_at) return { ok: false, error: 'Este lançamento já está pago.' };
  if (x.origin === 'convenio') return { ok: false, error: 'Valor a receber do convênio: não é cobrado do paciente.' };
  if (!x.whatsapp_optin) return { ok: false, error: 'O paciente não autorizou mensagens pelo WhatsApp.' };
  const due = String(x.due_date).slice(0, 10).split('-').reverse().join('/');
  const vars = { nome: firstName(x), valor: money(x.amount), descricao: x.description, vencimento: due, pix: '' };
  const base = { phone: x.phone, kind: 'cobranca', patient_id: x.patient_id, user_id: userId };
  // Cobrança online ligada (Asaas): manda o link (Pix, boleto ou cartão) e o Pix da própria cobrança — a baixa é automática
  try {
    const G = await import('./gateway.js'); const gc = await G.config();
    if (G.ready(gc) && G.eligible(x)) {
      const out = await G.ensureCharge(x.id, { userId });
      if (out.ok && out.charge?.invoice_url) {
        const r = await send({ ...base, text: render(c?.templates.cobranca_link, { ...vars, link: out.charge.invoice_url }) }, c);
        if (r.ok) {
          const gp = await G.pixOf(out.charge).catch(() => null);
          if (gp?.payload) { await send({ ...base, text: gp.payload }, c); if (gp.image) await send({ ...base, text: `QR code Pix — ${money(x.amount)}`, image: gp.image.replace(/^data:image\/png;base64,/, '') }, c); }
          await q('UPDATE payments SET charged_at = NOW() WHERE id = ?', [x.id]); await Fin.logPay(x, 'lembrete', userId, 'WhatsApp com link do Asaas'); Live.emit('financeiro');
        }
        return r;
      }
    }
  } catch (e) { console.error('cobrança online no WhatsApp:', e.message); }
  const pix = await Fin.pixFor(x);
  // Com Pix: 3 mensagens — texto, o código sozinho (fácil de copiar no celular) e o QR code em imagem.
  const r = await send({ ...base, text: render(pix ? c?.templates.cobranca_pix : c?.templates.cobranca, vars) }, c);
  if (r.ok && pix) {
    await send({ ...base, text: pix.code }, c);
    const png = await QRCode.toBuffer(pix.code, { width: 480, margin: 2, errorCorrectionLevel: 'M' });
    await send({ ...base, text: `QR code Pix — ${money(x.amount)}`, image: png.toString('base64') }, c);
  }
  if (r.ok) { await q('UPDATE payments SET charged_at = NOW() WHERE id = ?', [x.id]); await Fin.logPay(x, 'lembrete', userId, pix ? 'WhatsApp com Pix' : 'WhatsApp'); Live.emit('financeiro'); }
  return r;
}

export async function sendPayment(paymentId, userId) {
  const c = await config();
  const x = await one('SELECT x.*, p.name, p.social_name, p.phone, p.whatsapp_optin FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ?', [paymentId]);
  if (!x?.paid_at) return { ok: false, error: 'O pagamento ainda não foi registrado.' };
  if (!x.whatsapp_optin) return { ok: false, error: 'O paciente não autorizou mensagens pelo WhatsApp.' };
  const text = render(c?.templates.pagamento, { nome: firstName(x), valor: money(x.amount), descricao: x.description });
  return send({ phone: x.phone, text, kind: 'pagamento', patient_id: x.patient_id, user_id: userId }, c);
}

// ---------- lembretes automáticos ----------
const RUNNING = Tenancy.scoped({ on: false }); // trava por clínica
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const AVISO_START = 6; const AVISO_END = 22; // o aviso curto pode sair entre 6h e 22h (sessões cedo/tarde)

export async function processDueReminders({ maxPerRun = 25, delayMs = null } = {}) {
  if (RUNNING.on) return { skipped: true };
  RUNNING.on = true;
  const out = { sent: 0, failed: 0, notices: 0 };
  try {
    const c = await config();
    if (!ready(c) || (!c.autoReminders && !c.secondReminder)) return out;
    const hour = Number(nowLocal().slice(11, 13));
    const anyTime = !!process.env.WA_IGNORE_WINDOW;
    const mainOk = c.autoReminders && (anyTime || (hour >= c.windowStart && hour < c.windowEnd));
    const noticeOk = c.secondReminder && (anyTime || (hour >= AVISO_START && hour < AVISO_END));
    if (!mainOk && !noticeOk) return { ...out, outsideWindow: true };
    if ((await connectionState(c, true)) !== 'open') return { ...out, disconnected: true };
    const pause = () => sleep(delayMs ?? 4000 + Math.floor(Math.random() * 5000)); // intervalo humano entre mensagens

    // 1) Lembrete principal (pede confirmação). Com o aviso curto ligado, sessões muito próximas recebem só o aviso.
    if (mainOk) {
      const minLead = c.secondReminder ? c.secondHours + 1 : 1;
      const due = await q(`SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.status IN ('agendada','confirmada') AND a.wa_reminder_at IS NULL AND p.whatsapp_optin = 1 AND p.phone IS NOT NULL AND p.phone <> ''
          AND a.starts_at > DATE_ADD(NOW(), INTERVAL ? HOUR) AND a.starts_at <= DATE_ADD(NOW(), INTERVAL ? HOUR)
        ORDER BY a.starts_at LIMIT ?`, [minLead, c.hours, maxPerRun]);
      for (const { id } of due) {
        // “Reserva” a sessão para não enviar duas vezes se houver execuções simultâneas.
        const claim = await q('UPDATE appointments SET wa_reminder_at = NOW() WHERE id = ? AND wa_reminder_at IS NULL', [id]);
        if (!claim.affectedRows) continue;
        // Em caso de falha a marca permanece (não insiste); o erro aparece no registro de mensagens.
        const r = await sendReminder(id);
        if (r.ok) out.sent++; else out.failed++;
        await pause();
      }
    }

    // 2) Aviso curto X horas antes (sem confirmação). Não envia se o lembrete saiu há menos de 3h
    //    nem se o paciente pediu para remarcar e isso ainda não foi resolvido.
    if (noticeOk) {
      const due = await q(`SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.status IN ('agendada','confirmada') AND a.wa_reminder2_at IS NULL AND p.whatsapp_optin = 1 AND p.phone IS NOT NULL AND p.phone <> ''
          AND a.starts_at > DATE_ADD(NOW(), INTERVAL 10 MINUTE) AND a.starts_at <= DATE_ADD(NOW(), INTERVAL ? HOUR)
          AND (a.wa_reminder_at IS NULL OR a.wa_reminder_at < DATE_SUB(NOW(), INTERVAL 3 HOUR))
          AND NOT (a.wa_reply <=> 'remarcar' AND a.wa_reschedule_done = 0)
        ORDER BY a.starts_at LIMIT ?`, [c.secondHours, maxPerRun]);
      for (const { id } of due) {
        const claim = await q('UPDATE appointments SET wa_reminder2_at = NOW() WHERE id = ? AND wa_reminder2_at IS NULL', [id]);
        if (!claim.affectedRows) continue;
        const r = await sendShortNotice(id);
        if (r.ok) out.notices++; else out.failed++;
        await pause();
      }
    }
    return out;
  } catch (e) {
    console.error('wa reminders', e.message);
    return { ...out, error: e.message };
  } finally { RUNNING.on = false; }
}

export function startScheduler() {
  if (process.env.WA_SCHEDULER_OFF) return;
  const tick = () => Tenancy.forEachTenant(() => Brand.load().then(() => processDueReminders()).catch((e) => console.error('wa tick', e.message)), 'lembretes WhatsApp');
  setTimeout(tick, 30e3);
  setInterval(tick, 5 * 60e3).unref();
}

// ---------- respostas dos pacientes (webhook) ----------
const CONFIRM = /^(1|1️⃣|sim|s|confirmo|confirmado|confirmada|confirmar|ok|okay|pode confirmar|👍)(?=\s|$)/i;
const RESCHEDULE = /^(2|2️⃣|remarcar|remarca|nao|não|n|cancelar|preciso remarcar)(?=\s|$)/i;

function textOf(m) {
  return m?.conversation || m?.extendedTextMessage?.text || m?.buttonsResponseMessage?.selectedDisplayText || m?.listResponseMessage?.title || '';
}

const MEDIA = { audioMessage: 'um áudio', imageMessage: 'uma imagem', videoMessage: 'um vídeo', documentMessage: 'um arquivo', stickerMessage: 'uma figurinha', locationMessage: 'uma localização', contactMessage: 'um contato' };

export async function handleWebhook(body) {
  const c = await config();
  if (!ready(c)) return { ignored: 'not-ready' };
  const event = String(body?.event || '').toLowerCase().replace(/_/g, '.');
  if (event !== 'messages.upsert') return { ignored: 'event' };
  if (body.instance && body.instance !== c.instance) return { ignored: 'instance' };
  const ag = await Agent.config();
  const agentOn = Agent.ready(ag);
  const items = Array.isArray(body.data) ? body.data : [body.data];
  const results = [];
  for (const d of items) {
    if (!d?.key) continue;
    let jid = d.key.remoteJid || '';
    if (jid.includes('@lid') && d.key.remoteJidAlt) jid = d.key.remoteJidAlt;
    if (!jid.endsWith('@s.whatsapp.net')) continue; // ignora grupos, status e listas
    const number = jid.split('@')[0];
    const key = phoneKey(number);
    if (!key) continue;
    // WhatsApp de atendimento da equipe falando com o número da clínica: resposta a um contato ou comando
    if (!d.key.fromMe && agentOn) {
      const Relay = await import('./relay.js');
      if (Relay.operatorOf(ag, number)) { const r = await Relay.fromOperator(d, number); results.push(`equipe:${Object.keys(r)[0] || 'ok'}`); continue; }
    }
    // Mensagem enviada pelo próprio número: se não foi o sistema, alguém respondeu à mão → pausa o atendente virtual.
    if (d.key.fromMe) {
      if (agentOn && d.key.id) {
        // Espera o sistema registrar os próprios envios antes de concluir que foi um humano.
        const id = d.key.id;
        setTimeout(async () => {
          try { if (!(await one('SELECT id FROM wa_messages WHERE wa_id = ?', [id]))) await Agent.humanTookOver(number); } catch (e) { console.error('wa human', e.message); }
        }, Number(process.env.WA_HUMAN_CHECK_MS || 8000));
        results.push('proprio');
      }
      continue;
    }
    let text = textOf(d.message).trim();
    if (!text) {
      const kind = Object.keys(d.message || {}).find((k) => MEDIA[k]);
      if (!kind || !agentOn) continue;
      text = `[O contato enviou ${MEDIA[kind]}, sem texto.]`;
    }
    const patients = await q("SELECT id, name, social_name, phone, owner_id, responsible_phone FROM patients WHERE phone IS NOT NULL AND phone <> '' AND status <> 'inativo'");
    const cands = patients.filter((x) => phoneKey(x.phone) === key);
    // Quem está conversando: o paciente dono do número (não alguém agendado por ele com o mesmo número).
    const self = cands.find((x) => !x.responsible_phone || phoneKey(x.responsible_phone) !== key) || null;
    // Resposta ao lembrete: o paciente deste número com lembrete pendente (pode ser alguém agendado por este contato).
    const pend = cands.length ? await one(`SELECT patient_id FROM appointments WHERE patient_id IN (?) AND status IN ('agendada','confirmada') AND wa_reminder_at IS NOT NULL AND wa_reply IS NULL AND starts_at > NOW() ORDER BY starts_at LIMIT 1`, [cands.map((x) => x.id)]) : null;
    const p = (pend && cands.find((x) => x.id === pend.patient_id)) || self;
    // Contatos que não são pacientes só são guardados se o CRM capturar novos contatos ou o atendente virtual atendê-los.
    const crm = await CRM.config();
    // Oferta da lista de espera em aberto para este número (pode ser alguém que ainda não é paciente).
    const offer = await Waitlist.activeOfferFor(number);
    if (!p && !offer && !(agentOn && ag.answerNew) && !crm.capture) { results.push('desconhecido'); continue; }
    await log({ kind: 'recebida', direction: 'in', patient_id: p?.id, phone: number, body: text, status: 'recebido', wa_id: d.key.id });
    await CRM.touchInbound({ phone: number, name: d.pushName, patientId: self?.id });
    // Conversa com atendimento humano: encaminha ao WhatsApp da equipe (texto, áudio, foto, vídeo, arquivo)
    if (agentOn) {
      const Relay = await import('./relay.js');
      if (await Relay.forwardIfHuman({ number, d, text })) { results.push('encaminhado-equipe'); continue; }
    }

    // Resposta “1”/“2” ao lembrete: tratada direto, sem custo de IA.
    const a = p ? await one(`SELECT a.*, p.name, p.social_name, p.phone, p.whatsapp_optin, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.patient_id = ? AND a.status IN ('agendada','confirmada') AND a.wa_reminder_at IS NOT NULL AND a.wa_reply IS NULL AND a.starts_at > NOW()
      ORDER BY a.starts_at LIMIT 1`, [p.id]) : null;
    const clean = text.replace(/[*_~.!,]/g, '').trim();
    // Resposta à oferta da lista de espera (quando ela é mais recente que o lembrete pendente).
    if (offer && (!a || String(offer.sent_at) >= String(a.wa_reminder_at))) {
      const h = await Waitlist.handleReply(offer, text);
      if (h) {
        if (h.reply) await send({ phone: number, text: h.reply, kind: 'lista_espera', patient_id: offer.patient_id || p?.id }, c);
        results.push(`lista-${h.action}`);
        continue;
      }
      if (agentOn) { // resposta livre (“pode ser às 16h?”): o atendente virtual conduz, com a oferta no contexto
        await Agent.enqueue({ phone: number, text, contactName: d.pushName, patientId: self?.id });
        results.push('lista-agente');
        continue;
      }
      notify(offer.owner_id, { title: '💬 Resposta à lista de espera', body: `${p ? firstName(p) : number} respondeu à oferta de ${Waitlist.whenTxt(offer.starts_at)}: “${text.slice(0, 80)}”`, url: '/agenda/lista-espera', tag: `wl-offer-${offer.id}` });
      results.push('lista-texto');
      continue;
    }
    if (a && CONFIRM.test(clean)) {
      await q("UPDATE appointments SET status = 'confirmada', wa_reply = 'confirmou', wa_reply_at = NOW(), reply_channel = NULL WHERE id = ?", [a.id]);
      await send({ phone: p.phone, text: render(c.templates.confirmado, await apptVars(a)), kind: 'confirmacao', patient_id: p.id, appointment_id: a.id }, c);
      notify(p.owner_id, { title: '✓ Sessão confirmada pelo WhatsApp', body: `${firstName(p)} — ${weekday(a.starts_at.slice(0, 10))} ${brDate(a.starts_at).slice(0, 5)} às ${a.starts_at.slice(11, 16)}`, url: `/agenda/${a.id}`, tag: `appt-${a.id}` });
      results.push('confirmou');
      continue;
    }
    if (a && RESCHEDULE.test(clean)) {
      await q("UPDATE appointments SET wa_reply = 'remarcar', wa_reply_at = NOW(), wa_reschedule_done = 0, reply_channel = NULL WHERE id = ?", [a.id]);
      notify(p.owner_id, { title: '↻ Pedido de remarcação', body: `${firstName(p)} pediu para remarcar a sessão de ${brDate(a.starts_at).slice(0, 5)} às ${a.starts_at.slice(11, 16)}`, url: `/agenda/${a.id}`, tag: `appt-${a.id}` });
      if (agentOn && ag.canReschedule) {
        // O atendente virtual conduz a remarcação oferecendo novos horários.
        await Agent.enqueue({ phone: number, text, contactName: d.pushName, patientId: self?.id, extra: `O contato respondeu "2" ao lembrete: quer remarcar a sessão #${a.id}${p !== self ? ` de ${firstName(p)}` : ''} (${weekday(a.starts_at.slice(0, 10))} ${brDate(a.starts_at)} ${a.starts_at.slice(11, 16)}). Ofereça novos horários e, após a confirmação, use remarcar_sessao.` });
        results.push('remarcar-agente');
      } else {
        await send({ phone: p.phone, text: render(c.templates.remarcar, await apptVars(a)), kind: 'remarcacao', patient_id: p.id, appointment_id: a.id }, c);
        results.push('remarcar');
      }
      continue;
    }
    if (agentOn) {
      await Agent.enqueue({ phone: number, text, contactName: d.pushName, patientId: self?.id });
      results.push('agente');
    } else results.push('texto-livre');
  }
  return { results };
}

export const decryptBody = (b) => { try { return decrypt(b); } catch { return ''; } };
