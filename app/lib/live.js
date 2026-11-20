// Atualização ao vivo: qualquer alteração vira um evento no banco (live_events) e todas as
// páginas abertas — de todos os usuários, em qualquer processo do servidor — são avisadas.
// O banco é o ponto de encontro porque a hospedagem roda vários processos Node ao mesmo tempo.
import { q, one } from './db.js';

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

let pending = new Set(); let flushTimer = null;
// Registra a alteração. Agrupa as chamadas de ~150 ms num único evento.
export function emit(topics) {
  for (const t of [].concat(topics)) if (TOPICS.includes(t)) pending.add(t);
  if (!pending.size || flushTimer) return;
  flushTimer = setTimeout(async () => {
    const list = [...pending]; pending = new Set(); flushTimer = null;
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
const clients = new Set();
let lastId = null; let poller = null;

async function poll() {
  try {
    if (lastId === null) { lastId = Number((await one('SELECT COALESCE(MAX(id),0) m FROM live_events')).m); return; }
    const rows = await q('SELECT id, topics FROM live_events WHERE id > ? ORDER BY id LIMIT 200', [lastId]);
    if (!rows.length) return;
    lastId = Number(rows[rows.length - 1].id);
    const topics = [...new Set(rows.flatMap((r) => String(r.topics).split(',')))];
    const msg = `id: ${lastId}\nevent: change\ndata: ${JSON.stringify({ id: lastId, topics })}\n\n`;
    for (const c of clients) c.write(msg);
  } catch (e) { console.error('live poll', e.message); }
}
function ensurePoller() {
  if (!poller && clients.size) poller = setInterval(poll, Number(process.env.LIVE_POLL_MS || 1000));
  if (poller && !clients.size) { clearInterval(poller); poller = null; }
}

export async function stream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  if (lastId === null) await poll();
  res.write(`retry: 3000\nevent: hello\ndata: ${JSON.stringify({ id: lastId })}\n\n`);
  clients.add(res); ensurePoller();
  const beat = setInterval(() => res.write(': ok\n\n'), 15000);
  // Encerra após 4 min; o navegador reconecta sozinho (evita conexões presas no proxy).
  const end = setTimeout(() => res.end(), 4 * 60000);
  req.on('close', () => { clearInterval(beat); clearTimeout(end); clients.delete(res); ensurePoller(); });
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
