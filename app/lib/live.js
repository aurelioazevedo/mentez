// Atualização ao vivo: qualquer alteração vira um evento no banco (live_events) e todas as
// páginas abertas — de todos os usuários, em qualquer processo do servidor — são avisadas.
// O banco é o ponto de encontro porque a hospedagem roda vários processos Node ao mesmo tempo.
import { q, one } from './db.js';
import * as Tenancy from './tenancy.js';

export const TOPICS = ['agenda', 'crm', 'pacientes', 'financeiro', 'exercicios', 'usuarios', 'config'];

// Rota (prefixo) → tópicos alterados por um POST bem-sucedido nela.
const ROUTE_TOPICS = [
  [/^\/agenda/, ['agenda']],
  [/^\/recepcao/, ['agenda', 'financeiro']],
  [/^\/escala/, ['agenda']],
  [/^\/crm/, ['crm']],
  [/^\/atendimento/, ['crm']],
  [/^\/pacientes/, ['pacientes', 'agenda']],
  [/^\/financeiro/, ['financeiro']],
  [/^\/exercicios/, ['exercicios']],
  [/^\/usuarios/, ['usuarios']],
  [/^\/configuracoes/, ['config']],
  [/^\/webhooks\/whatsapp/, ['crm', 'agenda']],
  [/^\/p\//, ['exercicios']],
];
// POSTs que não alteram dados compartilhados
const IGNORE = [/^\/login/, /^\/logout/, /^\/conta/, /^\/configuracoes\/agente\/simular/, /^\/configuracoes\/whatsapp\/qr/, /^\/configuracoes\/whatsapp\/teste/];

// Fila de avisos por clínica (cada clínica grava no próprio banco)
const F = Tenancy.scoped({ pending: null, flushTimer: null });
// Registra a alteração. Agrupa as chamadas de ~150 ms num único evento.
export function emit(topics) {
  if (!F.pending) F.pending = new Set();
  for (const t of [].concat(topics)) if (TOPICS.includes(t)) F.pending.add(t);
  if (!F.pending.size || F.flushTimer) return;
  F.flushTimer = setTimeout(async () => { // o temporizador guarda o contexto da clínica
    const list = [...F.pending]; F.pending = new Set(); F.flushTimer = null;
    try { await q('INSERT INTO live_events (topics) VALUES (?)', [list.join(',')]); } catch (e) { console.error('live', e.message); }
  }, 150);
}

// Middleware: todo POST/PUT/DELETE que deu certo avisa os tópicos da rota.
export function middleware(req, res, next) {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  const path = req.originalUrl.split('?')[0];
  if (IGNORE.some((r) => r.test(path))) return next();
  const hit = ROUTE_TOPICS.find(([r]) => r.test(path));
  if (hit) res.on('finish', () => { if (res.statusCode < 400) emit(hit[1]); });
  next();
}

// ---------- distribuição para as páginas abertas neste processo (SSE) ----------
// Cada clínica tem as suas páginas abertas, o seu último evento lido e a sua consulta periódica.
const rooms = new Map(); // slug → { tenant, clients, lastId, poller }
function roomOf() {
  const t = Tenancy.current(); const k = t?.slug || '_';
  if (!rooms.has(k)) rooms.set(k, { tenant: t, clients: new Set(), lastId: null, poller: null });
  return rooms.get(k);
}
async function poll(room) {
  try {
    if (room.lastId === null) { room.lastId = Number((await one('SELECT COALESCE(MAX(id),0) m FROM live_events')).m); return; }
    const rows = await q('SELECT id, topics FROM live_events WHERE id > ? ORDER BY id LIMIT 200', [room.lastId]);
    if (!rows.length) return;
    room.lastId = Number(rows[rows.length - 1].id);
    const topics = [...new Set(rows.flatMap((r) => String(r.topics).split(',')))];
    const msg = `id: ${room.lastId}\nevent: change\ndata: ${JSON.stringify({ id: room.lastId, topics })}\n\n`;
    for (const c of room.clients) c.write(msg);
  } catch (e) { console.error('live poll', e.message); }
}
function ensurePoller(room) {
  if (!room.poller && room.clients.size) room.poller = setInterval(() => (room.tenant ? Tenancy.run(room.tenant, () => poll(room)) : poll(room)), Number(process.env.LIVE_POLL_MS || 1000));
  if (room.poller && !room.clients.size) { clearInterval(room.poller); room.poller = null; }
}

export async function stream(req, res) {
  const room = roomOf();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  if (room.lastId === null) await poll(room);
  res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ id: room.lastId })}\n\n`);
  room.clients.add(res); ensurePoller(room);
  const beat = setInterval(() => res.write(': ok\n\n'), 15000);
  // Encerra após 4 min; o navegador reconecta sozinho (evita conexões presas no proxy).
  const end = setTimeout(() => res.end(), 4 * 60000);
  req.on('close', () => { clearInterval(beat); clearTimeout(end); room.clients.delete(res); ensurePoller(room); });
}

// Reserva para quando o proxy não deixa o SSE passar: a página pergunta “houve algo desde X?”.
export async function since(req, res) {
  const from = Number(req.query.since);
  const max = Number((await one('SELECT COALESCE(MAX(id),0) m FROM live_events')).m);
  if (!Number.isFinite(from) || from < 0 || from > max) return res.json({ id: max, topics: [] });
  const rows = await q('SELECT topics FROM live_events WHERE id > ? AND id <= ? ORDER BY id LIMIT 500', [from, max]);
  res.set('Cache-Control', 'no-store').json({ id: max, topics: [...new Set(rows.flatMap((r) => String(r.topics).split(',')))] });
}

// Limpeza: eventos com mais de 1 dia não servem para mais nada.
export async function cleanup() {
  try { await q('DELETE FROM live_events WHERE created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)'); } catch { /* tabela ainda não criada */ }
}
