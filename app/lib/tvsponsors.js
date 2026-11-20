// Painel de chamadas — etapa 3: patrocinadores (parceiros) com plano, mensalidade no Financeiro,
// aprovação das campanhas, categorias bloqueadas e relatório mensal com link para o parceiro.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { todayLocal, addMonths } from './time.js';
import * as Fin from './fin.js';

export const TIERS = { ouro: { label: 'Ouro', weight: 3 }, prata: { label: 'Prata', weight: 2 }, bronze: { label: 'Bronze', weight: 1 } };
export const CATEGORIES = ['Saúde e bem-estar', 'Educação e cursos', 'Alimentação saudável', 'Esporte e academia', 'Beleza e estética', 'Serviços profissionais', 'Comércio local', 'Farmácia de manipulação', 'Outros',
  'Apostas', 'Bebidas alcoólicas', 'Medicamentos', 'Política', 'Tabaco e cigarro eletrônico'];
const DEFAULTS = { requireApproval: true, blocked: ['Apostas', 'Bebidas alcoólicas', 'Medicamentos', 'Política', 'Tabaco e cigarro eletrônico'] };

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('tv_ads_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c };
}
export async function saveConfig(b) {
  const blocked = [].concat(b.blocked || []).filter((x) => CATEGORIES.includes(x));
  await setSetting('tv_ads_cfg', JSON.stringify({ requireApproval: !!b.requireApproval, blocked }));
}
export const isBlocked = (cat, c) => c.blocked.includes(cat);

// ---------- parceiros ----------
const SP = `SELECT s.*, (SELECT COUNT(*) FROM tv_campaigns c WHERE c.sponsor_id = s.id AND c.deleted = 0) camps,
    (SELECT COALESCE(SUM(st.plays),0) FROM tv_campaign_stats st JOIN tv_campaigns c ON c.id = st.campaign_id WHERE c.sponsor_id = s.id AND st.day >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) plays_month,
    (SELECT COALESCE(SUM(st.scans),0) FROM tv_campaign_stats st JOIN tv_campaigns c ON c.id = st.campaign_id WHERE c.sponsor_id = s.id AND st.day >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) scans_month
  FROM tv_sponsors s`;
export const list = () => q(`${SP} ORDER BY s.status = 'ativo' DESC, FIELD(s.tier, 'ouro', 'prata', 'bronze'), s.name`);
export const get = (id) => one(`${SP} WHERE s.id = ?`, [id]);
export const byToken = (t) => (/^[A-Za-z0-9_-]{20,48}$/.test(String(t || '')) ? one('SELECT * FROM tv_sponsors WHERE report_token = ?', [t]) : null);
// Parceiro em vigor hoje (ativo e dentro do período do contrato)
export function inForce(s) {
  const t = todayLocal();
  return s && s.status === 'ativo' && (!s.start_date || String(s.start_date).slice(0, 10) <= t) && (!s.end_date || String(s.end_date).slice(0, 10) >= t);
}

const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const money = (v) => { const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0; };
export async function save(id, b, userId) {
  const name = String(b.name || '').trim().slice(0, 120);
  if (name.length < 2) return { ok: false, error: 'Informe o nome do parceiro.' };
  const vals = [name, String(b.contact || '').trim().slice(0, 120) || null, String(b.phone || '').trim().slice(0, 40) || null, String(b.email || '').trim().slice(0, 160) || null,
    String(b.doc || '').trim().slice(0, 30) || null, CATEGORIES.includes(b.category) ? b.category : 'Outros', TIERS[b.tier] ? b.tier : 'prata', money(b.monthly),
    Math.max(1, Math.min(28, Number(b.due_day) || 10)), ymd(b.start_date), ymd(b.end_date), ['ativo', 'pausado', 'encerrado'].includes(b.status) ? b.status : 'ativo', b.to_finance ? 1 : 0,
    String(b.notes || '').trim().slice(0, 500) || null];
  let sid = id;
  if (id) await q('UPDATE tv_sponsors SET name = ?, contact = ?, phone = ?, email = ?, doc = ?, category = ?, tier = ?, monthly = ?, due_day = ?, start_date = ?, end_date = ?, status = ?, to_finance = ?, notes = ? WHERE id = ?', [...vals, id]);
  else sid = (await q('INSERT INTO tv_sponsors (name, contact, phone, email, doc, category, tier, monthly, due_day, start_date, end_date, status, to_finance, notes, report_token, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    [...vals, crypto.randomBytes(18).toString('base64url'), userId || null])).insertId;
  await syncFinance(sid, userId);
  return { ok: true, id: sid };
}
export async function setStatus(id, status, userId) { await q('UPDATE tv_sponsors SET status = ? WHERE id = ?', [status, id]); await syncFinance(id, userId); }
export async function newToken(id) { await q('UPDATE tv_sponsors SET report_token = ? WHERE id = ?', [crypto.randomBytes(18).toString('base64url'), id]); }

// Mensalidade do parceiro como conta fixa a receber no Financeiro (categoria “Patrocínio”).
async function syncFinance(id, userId) {
  const s = await one('SELECT * FROM tv_sponsors WHERE id = ?', [id]);
  if (!s) return;
  const on = s.to_finance && s.status === 'ativo' && Number(s.monthly) > 0;
  if (!on) { if (s.recurring_id) await q('UPDATE fin_recurring SET active = 0 WHERE id = ?', [s.recurring_id]); return; }
  const cat = (await one("SELECT id FROM fin_categories WHERE name = 'Patrocínio' AND kind = 'receita'"))?.id || null;
  const start = (s.start_date ? String(s.start_date).slice(0, 7) : todayLocal().slice(0, 7));
  const end = s.end_date ? String(s.end_date).slice(0, 7) : null;
  const desc = `Patrocínio da TV da recepção — ${s.name}`;
  if (s.recurring_id && await one('SELECT id FROM fin_recurring WHERE id = ?', [s.recurring_id])) {
    await q('UPDATE fin_recurring SET kind = ?, category_id = ?, description = ?, counterpart = ?, amount = ?, day = ?, start_ym = ?, end_ym = ?, active = 1 WHERE id = ?', ['receber', cat, desc, s.name, s.monthly, s.due_day, start, end, s.recurring_id]);
    // lançamentos futuros ainda não recebidos acompanham o novo valor/dia
    await q("UPDATE fin_entries SET amount = ?, description = ?, counterpart = ? WHERE recurring_id = ? AND paid_at IS NULL AND rec_ym >= ?", [s.monthly, desc, s.name, s.recurring_id, todayLocal().slice(0, 7)]);
  } else {
    const r = await q('INSERT INTO fin_recurring (owner_id, kind, category_id, description, counterpart, amount, day, start_ym, end_ym, active, created_by) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)', ['receber', cat, desc, s.name, s.monthly, s.due_day, start, end, userId || null]);
    await q('UPDATE tv_sponsors SET recurring_id = ? WHERE id = ?', [r.insertId, id]);
  }
  await Fin.ensureRecurring();
}

// ---------- relatório mensal ----------
export function months(n = 6) { const out = []; let m = todayLocal().slice(0, 7); for (let i = 0; i < n; i++) { out.push(m); m = addMonths(m, -1); } return out; }
export async function report(sponsorId, ym) {
  const from = `${ym}-01`; const to = `${addMonths(ym, 1)}-01`;
  const camps = await q(`SELECT c.id, c.title, c.format, c.duration_sec, c.deleted, c.approval, COALESCE(SUM(st.plays),0) plays, COALESCE(SUM(st.scans),0) scans
    FROM tv_campaigns c LEFT JOIN tv_campaign_stats st ON st.campaign_id = c.id AND st.day >= ? AND st.day < ?
    WHERE c.sponsor_id = ? GROUP BY c.id, c.title, c.format, c.duration_sec, c.deleted, c.approval ORDER BY plays DESC, c.id`, [from, to, sponsorId]);
  const days = await q(`SELECT DATE_FORMAT(st.day, '%Y-%m-%d') d, SUM(st.plays) plays, SUM(st.scans) scans FROM tv_campaign_stats st JOIN tv_campaigns c ON c.id = st.campaign_id
    WHERE c.sponsor_id = ? AND st.day >= ? AND st.day < ? GROUP BY st.day ORDER BY st.day`, [sponsorId, from, to]);
  const rows = camps.filter((c) => Number(c.plays) || Number(c.scans) || (!c.deleted && c.approval === 'aprovada')).map((c) => ({ ...c, plays: Number(c.plays), scans: Number(c.scans), seconds: Number(c.plays) * Number(c.duration_sec) }));
  const total = rows.reduce((t, c) => ({ plays: t.plays + c.plays, scans: t.scans + c.scans, seconds: t.seconds + c.seconds }), { plays: 0, scans: 0, seconds: 0 });
  return { ym, campaigns: rows, days: days.map((d) => ({ d: d.d, plays: Number(d.plays), scans: Number(d.scans) })), total, screens: Number((await one("SELECT COUNT(*) n FROM tv_screens WHERE status = 'ativa'")).n) };
}
export const duration = (s) => { const h = Math.floor(s / 3600); const m = Math.round((s % 3600) / 60); return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`; };
export const monthLabel = (ym) => { const M = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']; return `${M[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`; };
