// Link do WhatsApp do site: o site aponta para /wa no sistema, que decide o destino —
// o número do atendente virtual (automatizado) ou o WhatsApp da Dra. Lorrainy.
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import { q, getSetting, setSetting } from './db.js';
import * as WA from './whatsapp.js';
import * as Agent from './agent.js';

// WhatsApp do(a) profissional: o da ficha de identidade da clínica
export const defaultDoctor = () => Brand.get().wa;
const DEFAULTS = { mode: 'doutora', doctorPhone: null, assistantPhone: null, fallback: true }; // sem número salvo: o WhatsApp da ficha da clínica

const S = Tenancy.scoped({ cache: null, numCache: null }); // caches com um valor por clínica
export async function config() {
  if (S.cache && S.cache.at > Date.now() - 30e3) return S.cache.v;
  let c = { ...DEFAULTS };
  try { const raw = await getSetting('site_wa'); if (raw) c = { ...c, ...JSON.parse(raw) }; } catch { /* padrão */ }
  S.cache = { at: Date.now(), v: c };
  return c;
}
export async function saveConfig(patch) {
  const next = { ...(await config()), ...patch };
  await setSetting('site_wa', JSON.stringify(next));
  S.cache = null;
  return config();
}

// Número do aparelho conectado à instância usada pelo atendente (guardado para não depender da Evolution a cada clique).
export async function assistantNumber(force = false) {
  const c = await config();
  const wac = await WA.config();
  const instance = wac?.instance || null;
  if (!force && S.numCache && S.numCache.instance === instance && S.numCache.at > Date.now() - 10 * 60e3) return S.numCache.v;
  // último número conhecido, só se for da mesma instância
  let v = c.assistantPhone && c.assistantInstance === instance ? c.assistantPhone : null;
  try {
    if (wac?.url && wac?.apiKey && instance) {
      const list = await withTimeout(WA.listInstances(wac), 4000);
      if (list) {
        const n = list.find((i) => i.name === instance)?.number || null;
        v = n && /^\d{10,15}$/.test(n) ? n : null;
        if (v !== c.assistantPhone || instance !== c.assistantInstance) await saveConfig({ assistantPhone: v, assistantInstance: instance });
      }
    }
  } catch { /* usa o último número conhecido */ }
  S.numCache = { at: Date.now(), instance, v };
  return v;
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((ok) => setTimeout(() => ok('__timeout'), ms))]).then((r) => (r === '__timeout' ? null : r));

// Decide o destino de um clique. Retorna { target, phone, reason }.
export async function route() {
  const c = await config();
  const doctor = { target: 'doutora', phone: c.doctorPhone || defaultDoctor() };
  if (c.mode !== 'assistente') return { ...doctor, reason: 'configurado' };
  const phone = await assistantNumber();
  if (!phone) return { ...doctor, reason: 'sem-numero' };
  if (c.fallback) {
    const ag = await Agent.config();
    if (!Agent.ready(ag)) return { ...doctor, reason: 'atendente-desligado' };
    if (!ag.answerNew) return { ...doctor, reason: 'nao-atende-novos' };
    const wac = await WA.config();
    if (!WA.ready(wac)) return { ...doctor, reason: 'whatsapp-pausado' };
    const st = await withTimeout(WA.connectionState(wac), 2500); // em cache por 2 min
    if (st && st !== 'open') return { ...doctor, reason: 'whatsapp-desconectado' };
  }
  return { target: 'assistente', phone, reason: 'configurado' };
}

export const cleanOrigin = (o) => String(o || 'site').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'site';
export const cleanText = (t) => String(t || '').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').slice(0, 400).trim();

export async function logClick(origin, r) {
  try { await q('INSERT INTO site_wa_clicks (origin, target, reason) VALUES (?,?,?)', [origin, r.target, r.reason]); } catch { /* a contagem não pode impedir o redirecionamento */ }
}

export async function stats(days = 30) {
  return q(`SELECT origin, SUM(target='assistente') assistente, SUM(target='doutora') doutora, COUNT(*) total
    FROM site_wa_clicks WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY origin ORDER BY total DESC`, [days]);
}

export const REASONS = {
  configurado: 'conforme a configuração', 'sem-numero': 'número do atendente desconhecido', 'atendente-desligado': 'atendente virtual desligado ou suspenso',
  'nao-atende-novos': 'atendente não atende novos contatos', 'whatsapp-pausado': 'envios do WhatsApp pausados', 'whatsapp-desconectado': 'WhatsApp do atendente desconectado',
};
