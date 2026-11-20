// Painel de chamadas (TV da recepção): senhas na chegada, chamada por sala/consultório com sinal e voz,
// várias TVs conectadas por código de 6 dígitos. A TV nunca recebe dado clínico: só senha (ou iniciais),
// sala e profissional.
import * as Tenancy from './tenancy.js';
import crypto from 'node:crypto';
import * as TTS from './tts.js';
import { q, one, getSetting, setSetting } from './db.js';
import { todayLocal } from './time.js';
import { proName } from './perm.js';
import * as Live from './live.js';
import * as WA from './whatsapp.js';
import * as Media from './tvmedia.js';

export const TYPES = { A: 'Atendimento agendado', P: 'Prioridade (60+, gestante, PcD)', R: 'Retorno / documento' };
export const DISPLAY = { senha: 'Só a senha (ex.: A-012) — recomendado', iniciais: 'Iniciais (ex.: M. S.)', nome: 'Primeiro nome e inicial (ex.: Mariana S.)' };
export const PREFIX = { tipo: 'Por tipo de atendimento (A, P, R)', profissional: 'Pela inicial do profissional', nenhum: 'Sem prefixo (só o número)' };
export const ROOM_WORDS = ['Sala', 'Consultório'];
export const CHIMES = { sino: 'Sino suave', dois: 'Dois toques', nenhum: 'Sem sinal' };
export const LAYOUTS = { mensagens: 'Chamada em destaque + mídia ao lado', midia: 'Mídia em tela cheia + faixa de chamada', chamadas: 'Só chamadas' };
export const THEMES = { escuro: 'Escuro', claro: 'Claro' };
const DEFAULTS = {
  enabled: true, display: 'senha', roomWord: 'Sala', prefixMode: 'tipo', dailyReset: true, autoTicket: true, autoPriority: true,
  voice: true, voiceText: 'Senha {senha}, {sala}.', chime: 'sino', repeat: 2, highlightSec: 20, chooseRoom: false, showPro: true,
  ticker: 'Chegue 5 minutos antes do seu horário · Mantenha o celular no silencioso durante a espera',
  messages: 'Psicoterapia on-line e presencial — Terapia Cognitivo-Comportamental para adultos.\nRespire: inspire em 4 tempos, segure 4, solte em 4. Repita algumas vezes.\nAgende ou remarque pelo nosso WhatsApp.',
  waTicket: false, waCall: false,
  waTicketText: 'Olá, {nome}! Sua senha é *{senha}*. Você será chamado(a) na TV da recepção.',
  waCallText: '{nome}, chegou a sua vez! Senha *{senha}* — {sala}.',
};

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('tv_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c };
}
export async function saveConfig(p) {
  const cur = await config();
  const pick = (v, map, d) => (Object.prototype.hasOwnProperty.call(map, v) ? v : d);
  const c = {
    enabled: !!p.enabled, display: pick(p.display, DISPLAY, cur.display), roomWord: ROOM_WORDS.includes(p.roomWord) ? p.roomWord : cur.roomWord,
    prefixMode: pick(p.prefixMode, PREFIX, cur.prefixMode), dailyReset: !!p.dailyReset, autoTicket: !!p.autoTicket, autoPriority: !!p.autoPriority,
    voice: !!p.voice, voiceText: String(p.voiceText || '').trim().slice(0, 160) || DEFAULTS.voiceText, chime: pick(p.chime, CHIMES, cur.chime),
    repeat: Math.max(1, Math.min(3, Number(p.repeat) || 2)), highlightSec: Math.max(5, Math.min(120, Number(p.highlightSec) || 20)),
    chooseRoom: !!p.chooseRoom, showPro: !!p.showPro,
    ticker: String(p.ticker ?? '').trim().slice(0, 400), messages: String(p.messages ?? '').trim().slice(0, 3000),
    waTicket: !!p.waTicket, waCall: !!p.waCall,
    waTicketText: String(p.waTicketText || '').trim().slice(0, 600) || DEFAULTS.waTicketText,
    waCallText: String(p.waCallText || '').trim().slice(0, 600) || DEFAULTS.waCallText,
  };
  await setSetting('tv_cfg', JSON.stringify(c));
  bump();
  return c;
}

// Versão do painel: muda a cada chamada/alteração (as TVs só redesenham quando muda).
let version = Date.now();
export const bump = () => { version = Date.now(); };
export const currentVersion = () => version;

// ---------- salas / consultórios ----------
export async function rooms() {
  return q('SELECT r.*, u.name pro_name, u.title pro_title FROM tv_rooms r LEFT JOIN users u ON u.id = r.owner_id WHERE r.active = 1 ORDER BY r.number, r.id');
}
export const roomLabel = (r, c) => (!r ? '' : r.name ? r.name : `${c.roomWord} ${r.number}`);
export async function addRoom({ name, ownerId }) {
  const n = (await one('SELECT COALESCE(MAX(number), 0) + 1 n FROM tv_rooms WHERE active = 1')).n;
  await q('INSERT INTO tv_rooms (number, name, owner_id) VALUES (?,?,?)', [n, String(name || '').trim().slice(0, 60) || null, ownerId || null]);
  bump();
}
export async function updateRoom(id, { number, name, ownerId }) {
  await q('UPDATE tv_rooms SET number = ?, name = ?, owner_id = ? WHERE id = ?', [Math.max(1, Math.min(99, Number(number) || 1)), String(name || '').trim().slice(0, 60) || null, ownerId || null, id]);
  bump();
}
export async function removeRoom(id) { await q('UPDATE tv_rooms SET active = 0 WHERE id = ?', [id]); bump(); }
// Sala padrão do profissional (a primeira ligada a ele).
export const roomOf = (ownerId) => (ownerId ? one('SELECT * FROM tv_rooms WHERE active = 1 AND owner_id = ? ORDER BY number LIMIT 1', [ownerId]) : null);

// ---------- senhas ----------
const pad = (n) => String(n).padStart(3, '0');
const plainInitial = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().charAt(0).toUpperCase();
const ageOf = (b) => { if (!b) return null; const [y, m, d] = String(b).slice(0, 10).split('-').map(Number); const t = todayLocal().split('-').map(Number); return t[0] - y - ((t[1] < m || (t[1] === m && t[2] < d)) ? 1 : 0); };

const APPT = `SELECT a.*, p.name, p.social_name, p.phone, p.whatsapp_optin, p.owner_id, p.birth_date, u.name pro_name, u.title pro_title
  FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = p.owner_id WHERE a.id = ?`;

async function nextNumber(prefix, c) {
  const day = c.dailyReset ? todayLocal() : '2000-01-01';
  const r = await q('INSERT INTO tv_counters (day, prefix, n) VALUES (?,?,1) ON DUPLICATE KEY UPDATE n = LAST_INSERT_ID(n + 1)', [day, prefix]);
  return r.insertId || 1;
}

// Gera a senha da sessão (na chegada). type: A, P ou R. force: troca a senha existente (ex.: mudou para prioridade).
export async function assign(apptId, type = null, { force = false, notifyPatient = true } = {}) {
  const c = await config();
  const a = await one(APPT, [apptId]);
  if (!a) return null;
  if (a.ticket && !force) return a.ticket;
  let t = TYPES[type] ? type : null;
  if (!t) t = c.autoPriority && (ageOf(a.birth_date) ?? 0) >= 60 ? 'P' : 'A';
  const prefix = c.prefixMode === 'tipo' ? t : c.prefixMode === 'profissional' ? (plainInitial(a.pro_name) || 'A') : '';
  const n = await nextNumber(prefix || '#', c);
  const ticket = prefix ? `${prefix}-${pad(n)}` : pad(n);
  await q('UPDATE appointments SET ticket = ?, ticket_type = ? WHERE id = ?', [ticket, t, a.id]);
  bump();
  Live.emit(['agenda']);
  if (notifyPatient && c.waTicket && a.whatsapp_optin && !force) {
    WA.send({ phone: a.phone, text: WA.render(c.waTicketText, { nome: firstName(a), senha: ticket }), kind: 'manual', patient_id: a.patient_id, appointment_id: a.id }).catch(() => {});
  }
  return ticket;
}

const firstName = (p) => String(p.social_name || p.name || '').trim().split(/\s+/)[0];
// O que aparece na TV, conforme a privacidade escolhida.
export function displayName(row, c) {
  const n = String(row.social_name || row.name || '').trim().split(/\s+/).filter((w) => /\p{L}/u.test(w) && !/^(d[aeo]s?|e)$/i.test(w));
  if (c.display === 'iniciais' && n.length) return n.length > 1 ? `${n[0][0]}. ${n[n.length - 1][0]}.`.toUpperCase() : `${n[0][0].toUpperCase()}.`;
  if (c.display === 'nome' && n.length) return n.length > 1 ? `${n[0]} ${n[n.length - 1][0].toUpperCase()}.` : n[0];
  return row.ticket || '—';
}

// ---------- voz da chamada ----------
const CALL_SQL = `SELECT x.id, x.ticket, x.room_id, x.called_at, TIMESTAMPDIFF(SECOND, x.called_at, NOW()) age,
      p.name, p.social_name, r.number room_number, r.name room_name, u.name pro_name, u.title pro_title
    FROM tv_calls x LEFT JOIN appointments a ON a.id = x.appointment_id LEFT JOIN patients p ON p.id = a.patient_id
    LEFT JOIN tv_rooms r ON r.id = x.room_id LEFT JOIN users u ON u.id = COALESCE(r.owner_id, x.owner_id)`;
function speechOf(x, c) {
  const room = x.room_number ? { number: x.room_number, name: x.room_name } : null;
  const label = x.ticket === 'TESTE' ? 'TESTE' : displayName({ ...x, ticket: x.ticket }, c);
  return WA.render(c.voiceText, { senha: x.ticket === 'TESTE' ? 'de teste' : spoken(label), sala: roomLabel(room, c) || 'na recepção' });
}
// Frase de uma chamada de hoje (só se a TV puder vê-la)
export async function callSpeech(callId, screen = null) {
  const x = await one(`${CALL_SQL} WHERE x.id = ? AND x.called_at >= CURDATE()`, [callId]);
  if (!x) return null;
  const filter = String(screen?.rooms || '').split(',').filter(Boolean).map(Number);
  if (filter.length && x.room_id && !filter.includes(x.room_id)) return null;
  return speechOf(x, await config());
}
// Gera o áudio logo ao chamar, para a TV tocar sem espera
function prefetchVoice(callId) {
  (async () => {
    const t = await TTS.config();
    if (!TTS.ready(t) || !(await config()).voice) return;
    const text = await callSpeech(callId);
    if (text) await TTS.synth(t, text);
  })().catch((e) => console.error('voz da chamada:', e.message));
}

// ---------- chamadas ----------
export async function call(apptId, { roomId = null, userId = null } = {}) {
  const c = await config();
  let a = await one(APPT, [apptId]);
  if (!a) return { ok: false, error: 'Sessão não encontrada.' };
  if (!['aguardando', 'agendada', 'confirmada', 'em_atendimento'].includes(a.status)) return { ok: false, error: 'Esta sessão não está aguardando atendimento.' };
  if (!a.ticket) { await assign(a.id, null, { notifyPatient: false }); a = await one(APPT, [apptId]); }
  let room = roomId ? await one('SELECT * FROM tv_rooms WHERE id = ? AND active = 1', [roomId]) : null;
  if (!room && a.room_id) room = await one('SELECT * FROM tv_rooms WHERE id = ? AND active = 1', [a.room_id]);
  if (!room) room = await roomOf(a.owner_id);
  const r = await q('INSERT INTO tv_calls (appointment_id, ticket, room_id, owner_id, called_by) VALUES (?,?,?,?,?)', [a.id, a.ticket, room?.id || null, a.owner_id, userId]);
  await q('UPDATE appointments SET called_at = NOW(), call_count = call_count + 1, room_id = ? WHERE id = ?', [room?.id || null, a.id]);
  bump();
  Live.emit(['agenda']);
  if (c.waCall && a.whatsapp_optin) {
    WA.send({ phone: a.phone, text: WA.render(c.waCallText, { nome: firstName(a), senha: a.ticket, sala: roomLabel(room, c) || 'na recepção' }), kind: 'manual', patient_id: a.patient_id, appointment_id: a.id }).catch(() => {});
  }
  prefetchVoice(r.insertId);
  return { ok: true, id: r.insertId, ticket: a.ticket, room: roomLabel(room, c), again: a.call_count > 0 };
}
// Chamada de teste (para conferir som e tela sem paciente)
export async function testCall(userId) {
  const room = await one('SELECT * FROM tv_rooms WHERE active = 1 ORDER BY number LIMIT 1');
  const r = await q('INSERT INTO tv_calls (appointment_id, ticket, room_id, owner_id, called_by) VALUES (NULL, ?, ?, ?, ?)', ['TESTE', room?.id || null, room?.owner_id || null, userId]);
  prefetchVoice(r.insertId);
  bump();
}

// ---------- telas (TVs) ----------
const hash = (t) => crypto.createHash('sha256').update(String(t)).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1e6)).padStart(6, '0');
export async function createPending() {
  await q("DELETE FROM tv_screens WHERE status = 'pendente' AND created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)");
  const token = crypto.randomBytes(24).toString('base64url');
  let code = newCode();
  for (let i = 0; i < 5 && (await one("SELECT id FROM tv_screens WHERE status = 'pendente' AND pair_code = ?", [code])); i++) code = newCode();
  await q("INSERT INTO tv_screens (name, token_hash, pair_code, pair_expires, status) VALUES ('Nova TV', ?, ?, DATE_ADD(NOW(), INTERVAL 30 MINUTE), 'pendente')", [hash(token), code]);
  return { token, code };
}
export const byToken = (token) => (token ? one('SELECT * FROM tv_screens WHERE token_hash = ?', [hash(token)]) : null);
export async function refreshCode(screen) {
  if (screen.status !== 'pendente') return screen;
  if (screen.pair_code && String(screen.pair_expires) > (await one('SELECT NOW() n')).n) return screen;
  const code = newCode();
  await q('UPDATE tv_screens SET pair_code = ?, pair_expires = DATE_ADD(NOW(), INTERVAL 30 MINUTE) WHERE id = ?', [code, screen.id]);
  return { ...screen, pair_code: code };
}
export async function pair(code, name) {
  const c = String(code || '').replace(/\D/g, '');
  const s = c.length === 6 ? await one("SELECT * FROM tv_screens WHERE status = 'pendente' AND pair_code = ? AND pair_expires > NOW()", [c]) : null;
  if (!s) return null;
  await q("UPDATE tv_screens SET status = 'ativa', pair_code = NULL, name = ?, paired_at = NOW() WHERE id = ?", [String(name || '').trim().slice(0, 60) || 'TV da recepção', s.id]);
  bump();
  return s.id;
}
export const screens = () => q("SELECT * FROM tv_screens WHERE status = 'ativa' ORDER BY id");
export async function updateScreen(id, { name, theme, layout, rooms: rs }) {
  const list = [].concat(rs || []).map(Number).filter((n) => n > 0);
  await q('UPDATE tv_screens SET name = ?, theme = ?, layout = ?, rooms = ? WHERE id = ?', [String(name || '').trim().slice(0, 60) || 'TV', THEMES[theme] ? theme : 'escuro', LAYOUTS[layout] ? layout : 'mensagens', list.join(','), id]);
  bump();
}
export async function reloadScreen(id) { await q('UPDATE tv_screens SET reload_at = NOW() WHERE id = ?', [id]); bump(); }
export async function removeScreen(id) { await q('DELETE FROM tv_screens WHERE id = ?', [id]); bump(); }
export const isOnline = (s) => s.last_seen && (Date.now() - new Date(`${String(s.last_seen).replace(' ', 'T')}-03:00`)) < 60e3;

// O que a TV mostra agora (consultado a cada 2 segundos).
const lastTouch = new Tenancy.TMap();  // separado por clínica
export async function feed(screen) {
  const now = Date.now();
  if ((lastTouch.get(screen.id) || 0) < now - 20e3) { lastTouch.set(screen.id, now); await q('UPDATE tv_screens SET last_seen = NOW() WHERE id = ?', [screen.id]); }
  const c = await config();
  const filter = String(screen.rooms || '').split(',').filter(Boolean).map(Number);
  const rows = await q(`SELECT x.id, x.ticket, x.room_id, x.called_at, TIMESTAMPDIFF(SECOND, x.called_at, NOW()) age,
      p.name, p.social_name, r.number room_number, r.name room_name, u.name pro_name, u.title pro_title
    FROM tv_calls x LEFT JOIN appointments a ON a.id = x.appointment_id LEFT JOIN patients p ON p.id = a.patient_id
    LEFT JOIN tv_rooms r ON r.id = x.room_id LEFT JOIN users u ON u.id = COALESCE(r.owner_id, x.owner_id)
    WHERE x.called_at >= CURDATE() ${filter.length ? 'AND (x.room_id IN (?) OR x.room_id IS NULL)' : ''} ORDER BY x.id DESC LIMIT 7`, filter.length ? [filter] : []);
  const calls = rows.map((x) => {
    const room = x.room_number ? { number: x.room_number, name: x.room_name } : null;
    const label = x.ticket === 'TESTE' ? 'TESTE' : displayName({ ...x, ticket: x.ticket }, c);
    const sala = roomLabel(room, c);
    return {
      id: x.id, label, sala, pro: c.showPro && x.pro_name ? proName({ name: x.pro_name, title: x.pro_title }) : '',
      at: String(x.called_at).slice(11, 16), fresh: Number(x.age) <= c.highlightSec,
      speech: speechOf(x, c),
    };
  });
  return {
    state: 'ativa', name: screen.name, theme: screen.theme || 'escuro', layout: screen.layout || 'mensagens',
    reloadAt: screen.reload_at ? String(screen.reload_at) : null,
    sound: { voice: c.voice, chime: c.chime, repeat: c.repeat, tts: TTS.ready(await TTS.config()) }, highlightSec: c.highlightSec,
    ticker: c.ticker, items: screen.layout === 'chamadas' ? [] : await playlist(screen, c),
    current: calls[0] || null, recent: calls.slice(1, 7), enabled: c.enabled,
  };
}
// Campanhas no ar para esta TV + mensagens de texto simples (Configurações → Mensagens na TV)
async function playlist(screen, c) {
  const camps = await Media.liveFor(screen).catch(() => []);
  const texts = String(c.messages || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 20)
    .map((t, i) => ({ id: `m${i}`, kind: 'Bem-vindo(a)', format: 'texto', title: '', body: t, duration: 12, weight: 1 }));
  return [...camps, ...texts];
}
// “A-012” → “A, 0, 1, 2” soa estranho; o leitor fala melhor “A 12”.
function spoken(label) {
  const m = /^([A-Z])-0*(\d+)$/.exec(label);
  return m ? `${m[1]}, ${m[2]}` : label;
}
