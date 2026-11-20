// Teleconsulta: sala própria (vídeo pelo navegador, ponto a ponto), Google Meet ou Zoom.
// A clínica define o que é permitido e o padrão; cada profissional escolhe a sua plataforma;
// em cada sessão dá para trocar. O link certo é gerado/atualizado a cada mudança na sessão.
import * as Tenancy from './tenancy.js';
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { notify as push } from './push.js';
import * as Live from './live.js';

export const PROVIDERS = { propria: 'Teleconsulta própria (no navegador)', meet: 'Google Meet', zoom: 'Zoom', manual: 'Outro link (informado na sessão)' };
export const SHORT = { propria: 'Sala própria', meet: 'Google Meet', zoom: 'Zoom', manual: 'Link manual' };
const DEFAULTS = { ownAllowed: false, meetAllowed: true, zoomAllowed: false, clinicDefault: 'meet', zoomMode: 'link', zoomAccountId: '', zoomClientId: '', openBefore: 15, turnUrl: '', turnUser: '', cfTurnKeyId: '' };

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('tele_cfg')) || '{}'); } catch { /* padrão */ }
  const out = { ...DEFAULTS, ...c };
  const dec = (v) => { try { return v ? decrypt(v) : ''; } catch { return ''; } };
  out.zoomSecret = dec(c.zoom_secret_enc); out.turnPass = dec(c.turn_pass_enc); out.cfTurnToken = dec(c.cf_turn_token_enc);
  delete out.zoom_secret_enc; delete out.turn_pass_enc; delete out.cf_turn_token_enc;
  return out;
}
export const allowed = (c) => Object.keys(PROVIDERS).filter((k) => k === 'manual' || (k === 'propria' && c.ownAllowed) || (k === 'meet' && c.meetAllowed) || (k === 'zoom' && c.zoomAllowed));
export const zoomApiReady = (c) => c.zoomAllowed && c.zoomMode === 'api' && c.zoomAccountId && c.zoomClientId && c.zoomSecret;
export function checkInput(b) {
  if (b.turnUrl && !/^turns?:[^\s]+$/.test(String(b.turnUrl).trim())) return 'O servidor TURN deve começar com turn: ou turns:';
  return null;
}
export async function saveConfig(b, cur) {
  const keep = (v, old) => { const s = String(v || '').trim(); return s ? encrypt(s) : old ? encrypt(old) : null; };
  const next = {
    ownAllowed: !!b.ownAllowed, meetAllowed: !!b.meetAllowed, zoomAllowed: !!b.zoomAllowed,
    clinicDefault: PROVIDERS[b.clinicDefault] ? b.clinicDefault : 'manual', zoomMode: b.zoomMode === 'api' ? 'api' : 'link',
    zoomAccountId: String(b.zoomAccountId || '').trim().slice(0, 80), zoomClientId: String(b.zoomClientId || '').trim().slice(0, 80), zoom_secret_enc: keep(b.zoomSecret, cur.zoomSecret),
    openBefore: [5, 10, 15, 30].includes(Number(b.openBefore)) ? Number(b.openBefore) : 15,
    turnUrl: String(b.turnUrl || '').trim().slice(0, 200), turnUser: String(b.turnUser || '').trim().slice(0, 120), turn_pass_enc: keep(b.turnPass, cur.turnPass),
    cfTurnKeyId: String(b.cfTurnKeyId || '').trim().slice(0, 80), cf_turn_token_enc: b.cfTurnRemove ? null : keep(b.cfTurnToken, cur.cfTurnToken),
  };
  if (b.cfTurnRemove) next.cfTurnKeyId = '';
  S.cfCache = null;
  // o padrão da clínica precisa estar entre os permitidos
  if (!allowed(next).includes(next.clinicDefault)) next.clinicDefault = allowed(next).find((k) => k !== 'manual') || 'manual';
  await setSetting('tele_cfg', JSON.stringify(next));
  return next;
}
// Servidor de retransmissão (TURN): quando as redes bloqueiam a conexão direta, o vídeo passa por ele (criptografado).
// Cloudflare Realtime TURN: o sistema gera credenciais temporárias (24 h) a partir da chave da clínica.
const S = Tenancy.scoped({ cfCache: null, zoomTok: null }); // caches com um valor por clínica
// { at, list } — reaproveita por 6 h
const CF_BASE = () => process.env.TURN_CF_URL || 'https://rtc.live.cloudflare.com';
export const cfReady = (c) => !!(c.cfTurnKeyId && c.cfTurnToken);
export const relayReady = (c) => cfReady(c) || !!c.turnUrl;
async function cfServers(c) {
  if (S.cfCache && Date.now() - S.cfCache.at < 6 * 3600e3) return S.cfCache.list;
  const base = `${CF_BASE()}/v1/turn/keys/${encodeURIComponent(c.cfTurnKeyId)}/credentials`;
  const opt = { method: 'POST', signal: AbortSignal.timeout(8000), headers: { Authorization: `Bearer ${c.cfTurnToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl: 86400 }) };
  let r = await fetch(`${base}/generate-ice-servers`, opt);
  if (r.status === 404) r = await fetch(`${base}/generate`, opt);
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.errors?.[0]?.message || d?.error || `Cloudflare respondeu ${r.status}`);
  const list = [].concat(d.iceServers || []).filter((x) => x && x.urls)
    .map((x) => ({ ...x, urls: [].concat(x.urls).filter((u) => !/:53(\?|$)/.test(u)) })); // porta 53 costuma ser bloqueada nos navegadores
  if (!list.length) throw new Error('Cloudflare não devolveu servidores.');
  S.cfCache = { at: Date.now(), list };
  return list;
}
export async function testRelay(c) { S.cfCache = null; if (!cfReady(c)) throw new Error('Informe o Key ID e o token do TURN da Cloudflare.'); const l = await cfServers(c); return l.reduce((n, x) => n + x.urls.filter((u) => /^turns?:/.test(u)).length, 0); }
export async function iceServers(c) {
  const list = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (cfReady(c)) { try { list.push(...(await cfServers(c))); } catch (e) { console.error('TURN Cloudflare', e.message); } }
  if (c.turnUrl) list.push({ urls: c.turnUrl.split(/[\s,]+/).filter(Boolean), username: c.turnUser || undefined, credential: c.turnPass || undefined });
  return list;
}

// ---------- link seguro do paciente ----------
function sigOf(id) { return crypto.createHmac('sha256', Tenancy.env('SESSION_SECRET') || 'dev').update(`tele:${id}`).digest('base64url').slice(0, 16); }
export const tokenOf = (id) => `${id}.${sigOf(id)}`;
export function idOfToken(tok) {
  const m = /^(\d{1,10})\.([\w-]{16})$/.exec(String(tok || ''));
  if (!m) return null;
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sigOf(m[1]))) ? Number(m[1]) : null;
}
const base = () => (Tenancy.env('PUBLIC_URL') || 'https://sistema.lorrainymendes.com.br').replace(/\/+$/, '');
export const patientUrl = (id) => `${base()}/tc/${tokenOf(id)}`;
export const staffPath = (id) => `/teleconsulta/${id}`;

// ---------- plataforma de cada sessão ----------
export const guessUsed = (link) => (!link ? null : /meet\.google\.com/.test(link) ? 'meet' : /zoom\.us/.test(link) ? 'zoom' : /\/tc\//.test(link) ? 'propria' : 'manual');
export async function resolve(a, c = null, owner = null) {
  c = c || await config();
  owner = owner || (a.owner_id ? await one('SELECT id, tele_provider, google_meet, google_refresh_enc, google_error, zoom_link, zoom_email FROM users WHERE id = ?', [a.owner_id]) : null);
  const ok = allowed(c);
  let p = a.tele_provider && PROVIDERS[a.tele_provider] ? a.tele_provider : owner?.tele_provider && PROVIDERS[owner.tele_provider] ? owner.tele_provider : (owner && owner.google_meet === 0 && c.clinicDefault === 'meet' ? 'manual' : c.clinicDefault);
  if (!ok.includes(p)) p = ok.includes(c.clinicDefault) ? c.clinicDefault : 'manual';
  if (p === 'meet' && !(owner?.google_refresh_enc && !owner.google_error)) p = 'manual'; // Meet precisa da Google Agenda conectada
  if (p === 'zoom' && !zoomApiReady(c) && !owner?.zoom_link) p = 'manual';
  return { p, owner };
}

// Zoom (Server-to-Server OAuth)
async function zoomToken(c) {
  if (S.zoomTok && S.zoomTok.exp > Date.now() + 60e3 && S.zoomTok.key === c.zoomClientId) return S.zoomTok.v;
  const url = `${process.env.ZOOM_OAUTH_URL || 'https://zoom.us'}/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(c.zoomAccountId)}`;
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${c.zoomClientId}:${c.zoomSecret}`).toString('base64')}` }, signal: AbortSignal.timeout(15e3) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.reason || j.error || `Zoom recusou as credenciais (${r.status})`);
  S.zoomTok = { v: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000, key: c.zoomClientId };
  return S.zoomTok.v;
}
async function zoomApi(c, method, path, body) {
  const r = await fetch(`${process.env.ZOOM_API_URL || 'https://api.zoom.us'}/v2${path}`, { method, headers: { Authorization: `Bearer ${await zoomToken(c)}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15e3) });
  if (r.status === 204) return {};
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.message || `Zoom respondeu ${r.status}`); e.status = r.status; throw e; }
  return j;
}
export async function testZoom(c) { await zoomToken({ ...c }); return true; }
const zoomBody = (a) => ({ topic: 'Sessão de psicoterapia', type: 2, start_time: `${String(a.starts_at).replace(' ', 'T')}`, timezone: 'America/Sao_Paulo', duration: Number(a.duration_min) || 50,
  settings: { waiting_room: true, join_before_host: false, host_video: true, participant_video: true, mute_upon_entry: false, auto_recording: 'none', meeting_authentication: false } });
async function zoomDelete(c, a) {
  if (!a.zoom_meeting_id) return;
  try { if (zoomApiReady(c)) await zoomApi(c, 'DELETE', `/meetings/${encodeURIComponent(a.zoom_meeting_id)}`); } catch (e) { if (e.status !== 404) console.error('zoom delete', e.message); }
  await q('UPDATE appointments SET zoom_meeting_id = NULL WHERE id = ?', [a.id]);
}

// Gera/atualiza o link da sessão conforme a plataforma. Devolve a plataforma em uso (o Google Meet é criado pela sincronização com a Google Agenda).
export async function ensureLink(a) {
  if (!a) return null;
  const c = await config();
  const used = a.tele_used || guessUsed(a.meeting_link);
  const auto = used && used !== 'manual';
  const set = async (link, u) => { await q('UPDATE appointments SET meeting_link = ?, tele_used = ? WHERE id = ?', [link, u, a.id]); a.meeting_link = link; a.tele_used = u; };
  if (a.modality !== 'online' || a.status === 'cancelada') {
    await zoomDelete(c, a);
    if (auto && used !== 'meet') await set(null, null);
    return null;
  }
  const { p, owner } = await resolve(a, c);
  if (p !== 'zoom' && a.zoom_meeting_id) await zoomDelete(c, a);
  if (p === 'propria') { const link = patientUrl(a.id); if (a.meeting_link !== link || used !== 'propria') await set(link, 'propria'); return p; }
  if (p === 'zoom') {
    if (zoomApiReady(c)) {
      try {
        const user = owner?.zoom_email ? encodeURIComponent(owner.zoom_email) : 'me';
        if (a.zoom_meeting_id) {
          await zoomApi(c, 'PATCH', `/meetings/${encodeURIComponent(a.zoom_meeting_id)}`, zoomBody(a));
          if (used !== 'zoom') await set(a.meeting_link, 'zoom');
        } else {
          const m = await zoomApi(c, 'POST', `/users/${user}/meetings`, zoomBody(a));
          await q('UPDATE appointments SET zoom_meeting_id = ? WHERE id = ?', [String(m.id), a.id]); a.zoom_meeting_id = String(m.id);
          await set(m.join_url, 'zoom');
        }
        await q('UPDATE appointments SET tele_error = NULL WHERE id = ?', [a.id]);
      } catch (e) {
        console.error('zoom', a.id, e.message);
        await q('UPDATE appointments SET tele_error = ? WHERE id = ?', [`Zoom: ${String(e.message).slice(0, 200)}`, a.id]);
      }
    } else if (owner?.zoom_link && (a.meeting_link !== owner.zoom_link || used !== 'zoom')) await set(owner.zoom_link, 'zoom');
    return p;
  }
  if (p === 'meet') { if (used !== 'meet' && auto) await set(null, null); return p; }
  // manual: tira links gerados automaticamente por outra plataforma
  if (auto) await set(null, 'manual'); else if (used !== 'manual' && a.meeting_link) await q("UPDATE appointments SET tele_used = 'manual' WHERE id = ?", [a.id]);
  return p;
}
// Link que a profissional usa para entrar (na sala própria ela entra autenticada)
export const staffLink = (a) => (a.tele_used === 'propria' || guessUsed(a.meeting_link) === 'propria' ? staffPath(a.id) : a.meeting_link || null);

// ---------- salas (sinalização do vídeo) ----------
// Cada sala = uma sessão. Dois papéis: “pro” (profissional) e “pac” (paciente). Mensagens via SSE + POST.
// A hospedagem roda vários processos Node ao mesmo tempo: a conexão de cada um pode cair em processos diferentes,
// então o estado da sala e as mensagens ficam no banco (tele_rooms / tele_signals), como nas atualizações ao vivo.
// O paciente entra na sala de espera e só passa para a chamada quando a profissional autoriza (admitted).
const ALIVE_MS = 15e3;      // conexão sem sinal de vida há mais que isso = fora da sala
const POLL_MS = 300;        // entrega das mensagens
const BEAT_MS = 4e3;        // sinal de vida
const READMIT_MS = 120e3;   // paciente que ficou fora mais que isso precisa ser autorizado de novo
const newConn = () => crypto.randomBytes(9).toString('base64url');
const alive = (seen, now = Date.now()) => Number(seen || 0) > now - ALIVE_MS;
async function roomRow(id) { return one('SELECT * FROM tele_rooms WHERE appt_id = ?', [id]); }
async function put(id, to, msg) { await q('INSERT INTO tele_signals (appt_id, to_role, msg, created) VALUES (?,?,?,?)', [id, to, JSON.stringify(msg), Date.now()]); }

// presença (cache por processo, renovado a cada 3 s) — usada na agenda e na recepção
// Um mapa por clínica (os ids das sessões se repetem entre clínicas)
const P = Tenancy.scoped({ cache: new Map() });
async function refreshOne() {
  try {
    const now = Date.now();
    const rows = await q('SELECT appt_id, owner_id, pac_name, admitted, pro_seen, pac_seen, waiting_since FROM tele_rooms WHERE pro_seen > ? OR pac_seen > ?', [now - ALIVE_MS, now - ALIVE_MS]);
    P.cache = new Map(rows.map((r) => [Number(r.appt_id), { pro: alive(r.pro_seen, now), pac: alive(r.pac_seen, now), admitted: !!r.admitted, waitingSince: r.waiting_since ? Number(r.waiting_since) : null, ownerId: r.owner_id, name: r.pac_name }]));
  } catch { /* banco indisponível: mantém o último */ }
}
// Dentro de uma requisição: só a clínica atual; no relógio de 3 s: todas as clínicas ativas
const refreshCache = () => (Tenancy.current() || !Tenancy.multi() ? refreshOne() : Tenancy.forEachTenant(refreshOne, 'presença na teleconsulta'));
setInterval(refreshCache, 3000).unref?.();
export const presence = (id) => { const r = P.cache.get(Number(id)); return { pro: !!r?.pro, pac: !!r?.pac, admitted: !!r?.admitted, waitingSince: r?.pac && !r?.admitted ? r.waitingSince : null }; };
// Pacientes na sala de espera (ainda não autorizados) das sessões da profissional
export async function waitingFor(ownerId) {
  const now = Date.now();
  const rows = await q('SELECT appt_id, pac_name, waiting_since FROM tele_rooms WHERE owner_id = ? AND admitted = 0 AND pac_seen > ?', [ownerId, now - ALIVE_MS]);
  return rows.map((r) => ({ id: Number(r.appt_id), name: r.pac_name || 'Paciente', since: r.waiting_since ? Number(r.waiting_since) : now, url: staffPath(r.appt_id) }));
}
export async function join(id, role, res, meta = {}) {
  const other = role === 'pro' ? 'pac' : 'pro'; const conn = newConn(); const now = Date.now();
  await q('INSERT IGNORE INTO tele_rooms (appt_id) VALUES (?)', [id]);
  if (meta.ownerId) await q('UPDATE tele_rooms SET owner_id = ?, pac_name = ? WHERE appt_id = ?', [meta.ownerId, String(meta.name || '').slice(0, 80), id]);
  let r = await roomRow(id);
  if (role === 'pac' && r.admitted && !alive(r.pac_seen, now) && r.pac_left && now - Number(r.pac_left) > READMIT_MS) { await q('UPDATE tele_rooms SET admitted = 0 WHERE appt_id = ?', [id]); r.admitted = 0; }
  const otherAlive = alive(r[`${other}_seen`], now);
  await q(`UPDATE tele_rooms SET ${role}_conn = ?, ${role}_seen = ?${role === 'pac' ? ', waiting_since = IF(admitted = 1, NULL, COALESCE(waiting_since, ?))' : ''} WHERE appt_id = ?`, role === 'pac' ? [conn, now, now, id] : [conn, now, id]);
  let lastId = Number((await one('SELECT COALESCE(MAX(id), 0) m FROM tele_signals WHERE appt_id = ? AND to_role = ?', [id, role])).m);
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders?.();
  const write = (obj) => { try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* fechado */ } };
  const admitted = !!r.admitted;
  res.write('retry: 2000\n');
  if (role === 'pro') write({ type: 'hello', peer: otherAlive && admitted, waiting: otherAlive && !admitted ? { name: r.pac_name || 'Paciente' } : null });
  else write({ type: 'hello', peer: otherAlive && admitted, waiting: !admitted });
  if (role === 'pro') { if (otherAlive && admitted) await put(id, 'pac', { type: 'peer-joined', role }); }
  else if (admitted) { if (otherAlive) await put(id, 'pro', { type: 'peer-joined', role }); }
  else await put(id, 'pro', { type: 'waiting', name: r.pac_name || 'Paciente' });
  if (role === 'pac' && (!otherAlive || !admitted) && meta.ownerId) push(meta.ownerId, { title: 'Paciente na sala de espera', body: `${meta.name || 'Paciente'} está aguardando autorização para entrar na teleconsulta`, url: staffPath(id), tag: `tele-${id}` });
  Live.emit('agenda'); refreshCache();
  if (Math.random() < 0.05) q('DELETE FROM tele_signals WHERE created < ?', [now - 3 * 3600e3]).catch(() => {});
  let closed = false; let busy = false; let lastBeat = now; let lastPing = now;
  const loop = setInterval(async () => {
    if (closed || busy) return; busy = true;
    try {
      const t = Date.now();
      if (t - lastBeat >= BEAT_MS) {
        lastBeat = t;
        const u = await q(`UPDATE tele_rooms SET ${role}_seen = ? WHERE appt_id = ? AND ${role}_conn = ?`, [t, id, conn]);
        if (!u.affectedRows) { write({ type: 'replaced' }); closed = true; clearInterval(loop); try { res.end(); } catch { /* ok */ } return; }
      }
      const rows = await q('SELECT id, msg FROM tele_signals WHERE appt_id = ? AND to_role = ? AND id > ? ORDER BY id LIMIT 100', [id, role, lastId]);
      for (const m of rows) { lastId = Number(m.id); try { res.write(`data: ${m.msg}\n\n`); } catch { /* fechado */ } }
      if (t - lastPing > 20e3) { lastPing = t; try { res.write(': ping\n\n'); } catch { /* fechado */ } }
    } catch { /* tenta de novo */ } finally { busy = false; }
  }, POLL_MS);
  res.on('close', async () => {
    closed = true; clearInterval(loop);
    try {
      const u = await q(`UPDATE tele_rooms SET ${role}_conn = NULL, ${role}_seen = 0${role === 'pac' ? ', pac_left = ?, waiting_since = NULL' : ''} WHERE appt_id = ? AND ${role}_conn = ?`, role === 'pac' ? [Date.now(), id, conn] : [id, conn]);
      if (u.affectedRows) { await put(id, other, { type: 'peer-left', role }); Live.emit('agenda'); refreshCache(); }
    } catch { /* ok */ }
  });
}
export async function signal(id, fromRole, msg) {
  const r = await roomRow(id);
  if (!r) return false;
  const to = fromRole === 'pro' ? 'pac' : 'pro';
  if (msg?.type === 'admit') {
    if (fromRole !== 'pro') return false;
    await q('UPDATE tele_rooms SET admitted = 1, waiting_since = NULL WHERE appt_id = ?', [id]);
    await put(id, 'pac', { type: 'peer-joined', role: 'pro' }); Live.emit('agenda'); refreshCache();
    return true;
  }
  if (!['offer', 'answer', 'ice', 'bye', 'state', 'chat'].includes(msg?.type)) return false;
  const clean = { type: msg.type, from: fromRole, sdp: msg.sdp, candidate: msg.candidate, state: msg.state, text: msg.type === 'chat' ? String(msg.text || '').slice(0, 1000) : undefined, mid: msg.type === 'chat' ? String(msg.mid || '').slice(0, 20) : undefined };
  if (JSON.stringify(clean).length > 100e3) return false;
  if (msg.type === 'bye' && fromRole === 'pro') await q('UPDATE tele_rooms SET admitted = 0 WHERE appt_id = ?', [id]);
  await put(id, to, clean);
  return true;
}
// Janela da sala: abre X minutos antes e fecha 2 horas depois do horário marcado
export function windowOf(a, c) {
  const start = new Date(`${String(a.starts_at).replace(' ', 'T')}-03:00`).getTime();
  return { opensAt: start - (c.openBefore || 15) * 60e3, closesAt: start + ((Number(a.duration_min) || 50) + 120) * 60e3, start };
}
