// Integração com o Google Agenda (uma conexão OAuth por profissional).
// O sistema é a fonte da verdade: as sessões são enviadas para a agenda Google
// do(a) profissional responsável pelo paciente. Nenhum dado clínico é enviado.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { addMinutes } from './time.js';

// Endereços do Google (podem ser trocados por um servidor simulado nos testes).
const AUTH = process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com';
const OAUTH = process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com';
const API = process.env.GOOGLE_API_BASE || 'https://www.googleapis.com';
const SCOPES = [
  'openid', 'email',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const TZ = 'America/Sao_Paulo';
export const TITLE_OPTIONS = { iniciais: 'Iniciais (ex.: “Sessão · M. S.”)', primeiro_nome: 'Primeiro nome (ex.: “Sessão · Maria”)', nome_completo: 'Nome completo' };

// ---------- configuração (credenciais OAuth guardadas criptografadas no banco) ----------
let cfgCache = null;
export async function config() {
  if (cfgCache && cfgCache.at > Date.now() - 60e3) return cfgCache.v;
  const id = await getSetting('google_client_id');
  const secret = await getSetting('google_client_secret_enc');
  const v = id && secret ? { clientId: id, clientSecret: decrypt(secret) } : null;
  cfgCache = { at: Date.now(), v };
  return v;
}
export async function saveConfig(clientId, clientSecret) {
  await setSetting('google_client_id', clientId);
  if (clientSecret) await setSetting('google_client_secret_enc', encrypt(clientSecret));
  cfgCache = null;
}
export async function clearConfig() {
  await setSetting('google_client_id', null);
  await setSetting('google_client_secret_enc', null);
  cfgCache = null;
}
export const redirectUri = (req) => `${(process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '')}/conta/google/retorno`;

// ---------- OAuth ----------
function stateSecret() { return process.env.SESSION_SECRET; }
export function makeState(uid) {
  const body = Buffer.from(JSON.stringify({ uid, n: crypto.randomBytes(8).toString('hex'), exp: Date.now() + 10 * 60e3 })).toString('base64url');
  return `${body}.${crypto.createHmac('sha256', stateSecret()).update('g:' + body).digest('base64url')}`;
}
export function readState(state) {
  const [body, mac] = String(state || '').split('.');
  if (!body || !mac) return null;
  const good = crypto.createHmac('sha256', stateSecret()).update('g:' + body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  const o = JSON.parse(Buffer.from(body, 'base64url').toString());
  return o.exp > Date.now() ? o : null;
}

export async function authUrl(req, uid) {
  const c = await config();
  const p = new URLSearchParams({
    client_id: c.clientId, redirect_uri: redirectUri(req), response_type: 'code', scope: SCOPES.join(' '),
    access_type: 'offline', prompt: 'select_account consent', include_granted_scopes: 'true', state: makeState(uid),
  });
  return `${AUTH}/o/oauth2/v2/auth?${p}`;
}

async function tokenRequest(params) {
  const c = await config();
  if (!c) throw new Error('Integração Google não configurada.');
  const res = await fetch(`${OAUTH}/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.clientSecret, ...params }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error_description || data.error || `Google respondeu ${res.status}`); e.code = data.error; throw e; }
  return data;
}

export async function exchangeCode(req, code) {
  const t = await tokenRequest({ code, grant_type: 'authorization_code', redirect_uri: redirectUri(req) });
  let email = null;
  if (t.id_token) { try { email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email; } catch { /* ignore */ } }
  return { refreshToken: t.refresh_token, accessToken: t.access_token, expiresIn: t.expires_in, email };
}

const tokens = new Map(); // uid → { token, exp }
async function accessToken(user) {
  const c = tokens.get(user.id);
  if (c && c.exp > Date.now() + 60e3) return c.token;
  if (!user.google_refresh_enc) throw new Error('Google Agenda não conectada.');
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: decrypt(user.google_refresh_enc) });
    tokens.set(user.id, { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 });
    return t.access_token;
  } catch (e) {
    if (e.code === 'invalid_grant') {
      // Acesso revogado pela pessoa no Google: marca para reconectar.
      await q('UPDATE users SET google_error = ? WHERE id = ?', ['Acesso ao Google expirou ou foi revogado. Conecte novamente.', user.id]);
    }
    throw e;
  }
}

export async function gapi(user, method, path, { query, body } = {}) {
  const url = `${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method, headers: { Authorization: `Bearer ${await accessToken(user)}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(12000),
    });
    if (res.status === 401 && attempt === 0) { tokens.delete(user.id); continue; }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error?.message || `Google respondeu ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
}

export async function revoke(user) {
  tokens.delete(user.id);
  if (!user.google_refresh_enc) return;
  await fetch(`${OAUTH}/revoke?token=${encodeURIComponent(decrypt(user.google_refresh_enc))}`, { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {});
}

export async function listCalendars(user) {
  const data = await gapi(user, 'GET', '/calendar/v3/users/me/calendarList', { query: { minAccessRole: 'writer' } });
  return (data.items || []).map((c) => ({ id: c.id, name: c.summaryOverride || c.summary, primary: !!c.primary }));
}

// ---------- eventos ----------
const USER_COLS = 'id, name, google_refresh_enc, google_email, google_calendar_id, google_meet, google_title, google_error';
export const connected = (u) => !!(u && u.google_refresh_enc && !u.google_error);
const COLORS = { agendada: '6', confirmada: '7', realizada: '10', falta: '11' };

function titleFor(a, owner) {
  const name = a.social_name || a.name;
  const parts = name.trim().split(/\s+/);
  const who = owner.google_title === 'nome_completo' ? name
    : owner.google_title === 'primeiro_nome' ? parts[0]
      : parts.filter((w) => w.length > 2 || parts.length <= 2).slice(0, 3).map((w) => `${w[0].toUpperCase()}.`).join(' ');
  const prefix = a.status === 'falta' ? 'Falta · ' : a.status === 'realizada' ? '✓ ' : '';
  return `${prefix}Sessão · ${who}`;
}
const rfc = (dt) => dt.replace(' ', 'T');

function eventBody(a, owner, wantMeet) {
  const base = process.env.PUBLIC_URL || 'https://sistema.lorrainymendes.com.br';
  const ev = {
    summary: titleFor(a, owner),
    description: `Sessão de psicoterapia ${a.modality === 'online' ? 'on-line' : 'presencial'} · ${a.duration_min} min\n${base}/agenda/${a.id}\n\nEvento criado pelo sistema do consultório. Altere a sessão pelo sistema.`,
    location: a.modality === 'online' ? (a.meeting_link || 'On-line') : 'Presencial · Goiânia',
    start: { dateTime: rfc(a.starts_at), timeZone: TZ },
    end: { dateTime: rfc(addMinutes(a.starts_at, a.duration_min)), timeZone: TZ },
    colorId: COLORS[a.status] || '6',
    visibility: 'private',
    transparency: 'opaque',
    reminders: { useDefault: true },
    extendedProperties: { private: { lm_appt: String(a.id) } },
  };
  if (wantMeet) ev.conferenceData = { createRequest: { requestId: `lm-${a.id}-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } };
  return ev;
}

async function deleteEvent(user, cal, eventId) {
  try { await gapi(user, 'DELETE', `/calendar/v3/calendars/${encodeURIComponent(cal)}/events/${encodeURIComponent(eventId)}`, { query: { sendUpdates: 'none' } }); } catch (e) {
    if (e.status !== 404 && e.status !== 410) throw e;
  }
}

// Envia (cria, atualiza ou remove) uma sessão para a agenda Google do(a) responsável.
export async function syncAppointment(id) {
  const a = await one(`SELECT a.*, p.name, p.social_name, p.owner_id, p.demo FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?`, [id]);
  if (!a) return;
  // Teleconsulta: gera/atualiza o link da plataforma escolhida (sala própria, Zoom ou Meet)
  let prov = null;
  try { prov = await (await import('./tele.js')).ensureLink(a); } catch (e) { console.error('teleconsulta', a.id, e.message); }
  if (a.demo || !(await config())) return; // demonstração não vai para o Google Agenda
  try {
    // Paciente mudou de profissional: remove da agenda antiga.
    if (a.google_event_id && a.google_owner_id && a.google_owner_id !== a.owner_id) {
      const old = await one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [a.google_owner_id]);
      if (connected(old)) await deleteEvent(old, a.google_cal || 'primary', a.google_event_id);
      await q('UPDATE appointments SET google_event_id = NULL, google_cal = NULL, google_owner_id = NULL WHERE id = ?', [a.id]);
      a.google_event_id = null;
    }
    const owner = await one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [a.owner_id]);
    if (!connected(owner)) return;
    const cal = a.google_cal || owner.google_calendar_id || 'primary';
    if (a.status === 'cancelada') {
      if (a.google_event_id) await deleteEvent(owner, cal, a.google_event_id);
      await q('UPDATE appointments SET google_event_id = NULL, google_cal = NULL, google_owner_id = NULL, google_synced_at = NOW(), google_error = NULL WHERE id = ?', [a.id]);
      return;
    }
    const wantMeet = prov === 'meet' && a.modality === 'online' && !a.meeting_link;
    const body = eventBody(a, owner, wantMeet);
    const path = `/calendar/v3/calendars/${encodeURIComponent(cal)}/events`;
    let ev;
    if (a.google_event_id) {
      try {
        ev = await gapi(owner, 'PATCH', `${path}/${encodeURIComponent(a.google_event_id)}`, { query: { conferenceDataVersion: 1, sendUpdates: 'none' }, body });
      } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
    }
    if (!ev) ev = await gapi(owner, 'POST', path, { query: { conferenceDataVersion: 1, sendUpdates: 'none' }, body });
    const meet = wantMeet && ev.hangoutLink ? ev.hangoutLink : null;
    await q(`UPDATE appointments SET google_event_id = ?, google_cal = ?, google_owner_id = ?, google_synced_at = NOW(), google_error = NULL${meet ? ", meeting_link = ?, tele_used = 'meet'" : ''} WHERE id = ?`,
      [ev.id, cal, owner.id, ...(meet ? [meet] : []), a.id]);
  } catch (e) {
    console.error('google sync', a.id, e.message);
    await q('UPDATE appointments SET google_error = ? WHERE id = ?', [String(e.message).slice(0, 250), a.id]);
  }
}

// Sincroniza em segundo plano (não atrasa a tela).
export function syncLater(ids) {
  const list = [].concat(ids).filter(Boolean);
  if (!list.length) return;
  (async () => { for (const id of list) await syncAppointment(id); })().catch((e) => console.error('google bg', e.message));
}
export async function futureIds(where, params) {
  const rows = await q(`SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.starts_at >= DATE_SUB(NOW(), INTERVAL 1 DAY) AND (${where})`, params);
  return rows.map((r) => r.id);
}

// Compromissos pessoais no Google que batem com o horário (ignora eventos criados pelo sistema).
// Compromissos pessoais da Google Agenda do(a) profissional (sem os eventos criados pelo sistema e sem
// os marcados como “Disponível”). Devolve só horários — nunca título nem detalhes. Cache curto por período.
const busyCache = new Map();
const toLocal = (v) => new Date(new Date(v).getTime() - 3 * 3600e3).toISOString().slice(0, 19).replace('T', ' ');
export async function busyBlocks(ownerId, from, to) {
  if (!ownerId || !(await config())) return [];
  const key = `${ownerId}|${from}|${to}`;
  const hit = busyCache.get(key);
  if (hit && hit.at > Date.now() - (Number(process.env.GOOGLE_BUSY_CACHE_MS) || 60e3)) return hit.v;
  const owner = await one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [ownerId]);
  if (!connected(owner)) return [];
  try {
    const data = await gapi(owner, 'GET', `/calendar/v3/calendars/${encodeURIComponent(owner.google_calendar_id || 'primary')}/events`, {
      query: { timeMin: `${rfc(from)}-03:00`, timeMax: `${rfc(to)}-03:00`, singleEvents: 'true', orderBy: 'startTime', maxResults: '250' },
    });
    const v = (data.items || []).filter((e) => e.status !== 'cancelled' && e.transparency !== 'transparent' && !e.extendedProperties?.private?.lm_appt)
      .map((e) => (e.start?.dateTime
        ? { start: toLocal(e.start.dateTime), end: toLocal(e.end?.dateTime || e.start.dateTime), allDay: false }
        : e.start?.date ? { start: `${e.start.date} 00:00:00`, end: `${e.end?.date || e.start.date} 00:00:00`, allDay: true } : null))
      .filter((b) => b && b.end > from && b.start < to)
      .map((b) => ({ ...b, owner: ownerId }));
    busyCache.set(key, { at: Date.now(), v });
    if (busyCache.size > 300) busyCache.delete(busyCache.keys().next().value);
    return v;
  } catch { return hit ? hit.v : []; }
}
export const overlaps = (blocks, start, dur) => { const end = addMinutes(start, dur); return blocks.some((b) => b.start < end && b.end > start); };
export function clearBusyCache() { busyCache.clear(); }

export async function googleBusy(ownerId, start, dur) {
  if (!(await config())) return [];
  const owner = await one(`SELECT ${USER_COLS} FROM users WHERE id = ?`, [ownerId]);
  if (!connected(owner)) return [];
  try {
    const data = await gapi(owner, 'GET', `/calendar/v3/calendars/${encodeURIComponent(owner.google_calendar_id || 'primary')}/events`, {
      query: { timeMin: `${rfc(start)}-03:00`, timeMax: `${rfc(addMinutes(start, dur))}-03:00`, singleEvents: 'true', maxResults: '10' },
    });
    return (data.items || []).filter((e) => e.status !== 'cancelled' && e.transparency !== 'transparent' && !e.extendedProperties?.private?.lm_appt)
      .map((e) => e.summary || 'compromisso');
  } catch { return []; }
}

// Remove da agenda Google os eventos futuros de um(a) profissional (ao desconectar).
export async function removeFutureEvents(user) {
  const rows = await q('SELECT id, google_event_id, google_cal FROM appointments WHERE google_owner_id = ? AND google_event_id IS NOT NULL AND starts_at >= NOW()', [user.id]);
  for (const r of rows) {
    try { await deleteEvent(user, r.google_cal || 'primary', r.google_event_id); } catch { /* segue */ }
  }
  return rows.length;
}

// ---------- feed iCal (alternativa sem configuração) ----------
const icsEsc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (m) => `\\${m}`);
const icsUtc = (dt) => { const d = new Date(`${rfc(dt)}-03:00`); return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); };
function fold(line) {
  const out = []; let cur = '';
  for (const ch of line) { if (Buffer.byteLength(cur + ch) > 73) { out.push(cur); cur = ' ' + ch; } else cur += ch; }
  out.push(cur); return out.join('\r\n');
}
export async function icsFeed(user) {
  const rows = await q(`SELECT a.*, p.name, p.social_name FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.owner_id = ? AND a.status <> 'cancelada' AND a.starts_at >= DATE_SUB(NOW(), INTERVAL 30 DAY) AND a.starts_at < DATE_ADD(NOW(), INTERVAL 180 DAY) ORDER BY a.starts_at`, [user.id]);
  const base = process.env.PUBLIC_URL || 'https://sistema.lorrainymendes.com.br';
  const host = base.replace(/^https?:\/\//, '');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lorrainy Mendes//Sistema do consultorio//PT-BR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEsc(`Sessões · ${user.name}`)}`, 'X-WR-TIMEZONE:America/Sao_Paulo', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H'];
  for (const a of rows) {
    lines.push('BEGIN:VEVENT', `UID:sessao-${a.id}@${host}`, `DTSTAMP:${stamp}`, `DTSTART:${icsUtc(a.starts_at)}`, `DTEND:${icsUtc(addMinutes(a.starts_at, a.duration_min))}`,
      `SUMMARY:${icsEsc(titleFor(a, user))}`, `DESCRIPTION:${icsEsc(`Sessão ${a.modality === 'online' ? 'on-line' : 'presencial'} · ${base}/agenda/${a.id}`)}`,
      `LOCATION:${icsEsc(a.modality === 'online' ? (a.meeting_link || 'On-line') : 'Presencial · Goiânia')}`, 'CLASS:PRIVATE', 'TRANSP:OPAQUE', 'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
