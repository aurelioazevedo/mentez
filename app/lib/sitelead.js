// Site da clínica: formulário de contato → oportunidade no CRM, e resultados do site (visitas, origem, cliques).
// Resultados sem cookies e sem guardar IP: só contagens por dia, página, origem e tipo.
import { q, one } from './db.js';
import * as CRM from './crm.js';
import * as WA from './whatsapp.js';
import * as Push from './push.js';
import QRCode from 'qrcode';
import * as Pix from './pix.js';
import * as Fin from './fin.js';
import * as Brand from './brand.js';

export const KINDS = { view: 'Visitas', wa: 'Cliques no WhatsApp', book: 'Agendamentos on-line', form: 'Formulários enviados' };
const BOT = /bot|crawl|spider|slurp|facebookexternalhit|preview|headless|lighthouse|pingdom|monitor|curl|wget|python|axios/i;

// origem legível: utm_source, senão o site de onde a pessoa veio
export function sourceOf(raw) {
  let s = String(raw || '').toLowerCase().trim();
  s = s.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/?#].*$/, '');
  const map = [[/google\./, 'google'], [/(^|\.)instagram\.|^ig$|l\.instagram/, 'instagram'], [/facebook\.|^fb$|fb\.me|l\.facebook/, 'facebook'], [/whatsapp|wa\.me/, 'whatsapp'], [/bing\./, 'bing'], [/linkedin\./, 'linkedin'], [/tiktok\./, 'tiktok'], [/youtube\.|youtu\.be/, 'youtube'], [/doctoralia/, 'doctoralia']];
  for (const [re, v] of map) if (re.test(s)) return v;
  s = s.replace(/[^a-z0-9._-]/g, '').slice(0, 40);
  return s || 'direto';
}
export async function stat(path, source, kind) {
  if (!KINDS[kind]) return;
  await q('INSERT INTO site_stats (day, path, source, kind, n) VALUES (CURDATE(), ?, ?, ?, 1) ON DUPLICATE KEY UPDATE n = n + 1', [String(path || '').slice(0, 80), sourceOf(source), kind]);
}
// limite simples por IP (memória): evita encher a contagem ou o CRM com robôs
const hits = new Map();
export function allow(ip, key, max, windowMs) {
  const k = `${key}:${ip}`; const now = Date.now(); const h = hits.get(k) || { n: 0, at: now };
  if (now - h.at > windowMs) { h.n = 0; h.at = now; }
  h.n++; hits.set(k, h);
  if (hits.size > 20000) for (const [kk, v] of hits) if (now - v.at > windowMs) hits.delete(kk);
  return h.n <= max;
}
export const isBot = (ua) => !ua || BOT.test(ua);

// Formulário enviado: cria (ou reaproveita) o card do CRM pelo WhatsApp, guarda a mensagem criptografada e avisa a equipe
export async function lead({ path, ab = '', pageName, nome, whatsapp, email, mensagem, src, cmp, extra = [] }) {
  const phone = WA.normalizePhone(whatsapp);
  if (!phone) throw new Error('Confira o WhatsApp: informe o número com DDD.');
  const name = String(nome || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (name.length < 2) throw new Error('Informe seu nome.');
  const mail = String(email || '').trim().slice(0, 160);
  if (mail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) throw new Error('Confira o e-mail.');
  const existed = !!(await one('SELECT id FROM crm_cards WHERE phone_key = ?', [WA.phoneKey(phone)]).catch(() => null));
  const card = await CRM.cardFor({ phone, name, via: 'site' });
  if (!card) throw new Error('Não foi possível registrar o contato. Tente pelo WhatsApp.');
  if (!existed) await q("UPDATE crm_cards SET source = 'site' WHERE id = ?", [card.id]).catch(() => {});
  const origin = [sourceOf(src), cmp ? `campanha ${String(cmp).slice(0, 60)}` : ''].filter(Boolean).join(' · ');
  const lines = [`Formulário do site: ${pageName || (path ? `/${path}` : 'página inicial')}`, `Origem: ${origin}`, mail ? `E-mail: ${mail}` : '', mensagem ? `Mensagem: ${String(mensagem).trim().slice(0, 1000)}` : '', ...extra].filter(Boolean);
  await CRM.logEvent(card.id, 'site', lines.join('\n'));
  await stat(ab ? `${path}#${ab}` : path, src, 'form');
  const team = await q("SELECT id FROM users WHERE active = 1 AND role IN ('admin','secretaria')").catch(() => []);
  Push.notify(team.map((u) => u.id), { title: 'Novo contato pelo site', body: `${name} · ${pageName || 'site'}`, url: `/crm/${card.id}`, tag: `site-${card.id}` });
  return card;
}

// Resultados dos últimos N dias
export async function report(days = 30) {
  const since = `DATE_SUB(CURDATE(), INTERVAL ${Math.max(1, Math.min(365, Number(days) || 30)) - 1} DAY)`;
  const rows = await q(`SELECT day, path, source, kind, n FROM site_stats WHERE day >= ${since}`);
  const tot = { view: 0, wa: 0, book: 0, form: 0 }; const byDay = {}; const bySrc = {}; const byPath = {};
  const abt = {};
  for (const r of rows) {
    const n = Number(r.n); tot[r.kind] = (tot[r.kind] || 0) + n;
    const m = /^(.*)#([ab])$/.exec(r.path);
    if (m) { const t = ((abt[m[1]] ||= { a: { view: 0, act: 0 }, b: { view: 0, act: 0 } })[m[2]]); if (r.kind === 'view') t.view += n; else t.act += n; r.path = m[1]; }
    const d = String(r.day instanceof Date ? r.day.toISOString() : r.day).slice(0, 10);
    (byDay[d] ||= { view: 0, act: 0 }); (bySrc[r.source] ||= { view: 0, act: 0 }); (byPath[r.path] ||= { view: 0, act: 0 });
    for (const o of [byDay[d], bySrc[r.source], byPath[r.path]]) { if (r.kind === 'view') o.view += n; else o.act += n; }
  }
  return { tot, byDay, bySrc, byPath, ab: abt, days: Number(days) || 30 };
}

// Valor em reais a partir do texto do evento (“120,00”, “R$ 1.200”)
export function amountOf(v) { const n = Number(String(v || '').replace(/[^\d,.]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); return Number.isFinite(n) && n > 0 && n < 100000 ? Math.round(n * 100) / 100 : 0; }
// Pix da clínica (Financeiro → dados da clínica): código copia e cola e QR code
export async function pixFor(amount, txid, description) {
  const c = await Fin.clinic().catch(() => null);
  if (!c?.pix_key || !amount) return null;
  let key = c.pix_key; try { key = Pix.normalizeKey(c.pix_type, c.pix_key) || key; } catch { /* já normalizada */ }
  const code = Pix.brcode({ key, name: c.name || Brand.get().name, city: c.city || Brand.get().city, amount, txid, description });
  return { code, qr: await QRCode.toDataURL(code, { width: 280, margin: 1 }), amount };
}
// Mensagem pelo WhatsApp da clínica (material ou Pix), se o WhatsApp estiver conectado
export async function whatsapp(phone, text) {
  try { const c = await WA.config(); if (!WA.ready(c)) return false; const r = await WA.send({ phone, text, kind: 'manual' }, c); return r?.ok !== false; } catch { return false; }
}
