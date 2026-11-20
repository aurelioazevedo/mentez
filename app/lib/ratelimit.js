// Proteções das páginas públicas: limite de requisições por endereço (IP) e armadilha invisível para robôs.
import { bare, html } from './html.js';

const hits = new Map(); // "nome|ip" → horários das requisições na janela
const factor = () => Math.max(1, Number(process.env.RATE_LIMIT_FACTOR) || 1);
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) { const keep = v.list.filter((t) => now - t < v.win); if (keep.length) v.list = keep; else hits.delete(k); }
}, 60e3).unref();

const tooMany = (req, res, retry) => {
  res.set('Retry-After', String(retry));
  if (req.get('accept')?.includes('json') || req.is('json')) return res.status(429).json({ ok: false, error: 'Muitas solicitações. Aguarde um pouco e tente de novo.' });
  return res.status(429).send(String(bare('Aguarde um pouco', html`<main class="legal"><h1>Muitas solicitações</h1><p>Recebemos muitas solicitações deste aparelho em pouco tempo. Aguarde ${retry > 90 ? `${Math.ceil(retry / 60)} minutos` : 'um minuto'} e tente de novo.</p><p class="muted small">Se precisar, fale com o consultório pelo WhatsApp.</p></main>`, 'bare legal-page', req)));
};
// limit({ name, windowMs, max }): no máximo `max` requisições por IP na janela
export function limit({ name, windowMs, max, methods = null }) {
  return (req, res, next) => {
    if (methods && !methods.includes(req.method)) return next();
    const k = `${name}|${req.ip}`; const now = Date.now();
    const e = hits.get(k) || { list: [], win: windowMs };
    e.list = e.list.filter((t) => now - t < windowMs);
    if (e.list.length >= max * factor()) { hits.set(k, e); return tooMany(req, res, Math.ceil((windowMs - (now - e.list[0])) / 1000)); }
    e.list.push(now); hits.set(k, e);
    next();
  };
}

const backOf = (req) => { try { const u = new URL(req.get('referer') || '', `${req.protocol}://${req.get('host')}`); return u.host === req.get('host') ? u.pathname + u.search : '/'; } catch { return '/'; } };
// Armadilha para robôs: um campo invisível que pessoas não preenchem e um tempo mínimo de preenchimento.
export const botFields = () => html`<div class="hp-field" aria-hidden="true"><label>Deixe este campo em branco<input type="text" name="website" tabindex="-1" autocomplete="off" value=""></label></div><input type="hidden" name="_ts" value="${Date.now()}">`;
export function botGuard(req, res, next) {
  if (req.method !== 'POST') return next();
  const minMs = Number(process.env.BOT_MIN_MS ?? 2000);
  const ts = Number(req.body?._ts);
  const robot = (req.body?.website && String(req.body.website).trim()) || !Number.isFinite(ts) || Date.now() - ts < minMs || Date.now() - ts > 6 * 3600e3;
  if (!robot) return next();
  console.warn('robô bloqueado', req.path, req.ip);
  return res.status(400).send(String(bare('Não foi possível enviar', html`<main class="legal"><h1>Não foi possível enviar</h1><p>Volte à página anterior, aguarde alguns segundos e envie de novo.</p><p><a href="${backOf(req)}">Voltar</a></p></main>`, 'bare legal-page', req)));
}
