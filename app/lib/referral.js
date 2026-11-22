// Indique e ganhe: cada clínica tem um código de indicação. Quem se cadastra pelo link ganha dias a mais de teste grátis;
// quem indicou ganha desconto progressivo na mensalidade, conforme o número de clínicas indicadas que estão pagando
// (assinatura em dia). Se uma indicada deixa de pagar, o desconto volta para a faixa correspondente.
// Regras (faixas, bônus e texto da mensagem) no Painel → Indicações.
import crypto from 'node:crypto';
import * as T from './tenancy.js';

const DEF = { enabled: true, tiers: [[1, 10], [2, 20], [3, 30], [5, 40], [10, 50]], bonusDays: 7, message: 'Oi! Uso a Mentez para agenda, prontuário e financeiro do consultório e tenho gostado muito. Pelo meu link você ganha {dias} dias a mais de teste grátis: {link}' };
export const MAX_PCT = 90; // a mensalidade nunca zera (mínimo do Asaas/Mercado Pago)
export const MIN_VALUE = 5;
async function getS(k) { return (await T.pone('SELECT v FROM platform_settings WHERE k = ?', [k]))?.v || null; }
async function setS(k, v) { await T.pq('INSERT INTO platform_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]); }

export async function migrate() {
  for (const [c, def] of [['ref_code', 'VARCHAR(16) NULL'], ['referred_by', 'INT NULL'], ['ref_discount', 'INT NOT NULL DEFAULT 0'], ['referred_at', 'DATETIME NULL']]) {
    if (!(await T.pone('SELECT 1 x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['tenants', c]))) await T.pq(`ALTER TABLE tenants ADD COLUMN ${c} ${def}`);
  }
  if (!(await T.pone("SELECT 1 x FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'tenants' AND INDEX_NAME = 'uq_ref_code'"))) await T.pq('ALTER TABLE tenants ADD UNIQUE INDEX uq_ref_code (ref_code)');
}

let cache = null; let at = 0;
export async function config(force = false) {
  if (!force && cache && Date.now() - at < 30e3) return cache;
  let c = {}; try { c = JSON.parse((await getS('referral')) || '{}'); } catch { /* padrão */ }
  const tiers = Array.isArray(c.tiers) && c.tiers.length ? c.tiers : DEF.tiers;
  cache = { enabled: c.enabled ?? DEF.enabled, tiers: tiers.map(([n, p]) => [Number(n), Number(p)]).sort((a, b) => a[0] - b[0]), bonusDays: Number(c.bonusDays ?? DEF.bonusDays), message: c.message || DEF.message };
  at = Date.now();
  return cache;
}
export async function saveConfig(b) {
  const tiers = [];
  for (let i = 0; i < 8; i++) {
    const n = Math.round(Number(b[`n${i}`])); const p = Math.round(Number(b[`p${i}`]));
    if (n > 0 && p > 0) tiers.push([Math.min(n, 999), Math.min(p, MAX_PCT)]);
  }
  tiers.sort((a, b2) => a[0] - b2[0]);
  // faixas crescentes: mais indicações nunca dão menos desconto
  for (let i = 1; i < tiers.length; i++) if (tiers[i][0] === tiers[i - 1][0] || tiers[i][1] < tiers[i - 1][1]) return { error: 'As faixas precisam ser crescentes: mais indicações, desconto maior ou igual.' };
  if (!tiers.length) return { error: 'Cadastre pelo menos uma faixa de desconto.' };
  const message = String(b.message || '').trim().slice(0, 600) || DEF.message;
  if (!message.includes('{link}')) return { error: 'A mensagem precisa ter {link} (onde entra o link de indicação).' };
  await setS('referral', JSON.stringify({ enabled: !!b.enabled, tiers, bonusDays: Math.max(0, Math.min(60, Math.round(Number(b.bonusDays) || 0))), message }));
  cache = null;
  return { ok: true };
}

// Desconto (%) para um número de indicadas pagantes
export function pctFor(c, n) { let p = 0; for (const [k, v] of c.tiers) if (n >= k) p = v; return Math.min(p, MAX_PCT); }
export function nextTier(c, n) { return c.tiers.find(([k]) => k > n) || null; }

// Código da clínica (criado no primeiro uso): letras do endereço + 4 caracteres aleatórios
export async function codeOf(t) {
  const row = await T.pone('SELECT ref_code FROM tenants WHERE id = ?', [t.id]);
  if (row?.ref_code) return row.ref_code;
  const base = String(t.slug || 'mz').replace(/[^a-z0-9]/g, '').slice(0, 8) || 'mz';
  for (let i = 0; i < 6; i++) {
    const code = `${base}${crypto.randomBytes(3).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').toLowerCase().slice(0, 3)}${i}`;
    try { await T.pq('UPDATE tenants SET ref_code = ? WHERE id = ? AND ref_code IS NULL', [code, t.id]); break; } catch (e) { if (!/Duplicate/.test(e.message)) throw e; }
  }
  return (await T.pone('SELECT ref_code FROM tenants WHERE id = ?', [t.id])).ref_code;
}
export const cleanCode = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
export async function byCode(code) {
  const c = cleanCode(code); if (c.length < 4) return null;
  return T.pone("SELECT id, slug, name, owner_email FROM tenants WHERE ref_code = ? AND status <> 'cancelada'", [c]);
}
export function shareUrl(code) { return `https://${T.baseDomain()}/?ref=${encodeURIComponent(code)}`; }
export const fill = (msg, { link, days }) => String(msg).replaceAll('{link}', link).replaceAll('{dias}', String(days));

// Cadastro pelo link: registra quem indicou e soma os dias de bônus ao teste grátis
export async function attach(newTenant, code, { email } = {}) {
  const c = await config(); if (!c.enabled) return null;
  const ref = await byCode(code);
  if (!ref || ref.id === newTenant.id || (email && ref.owner_email && ref.owner_email.toLowerCase() === String(email).toLowerCase())) return null;
  await T.pq('UPDATE tenants SET referred_by = ?, referred_at = NOW(), trial_ends_at = DATE_ADD(COALESCE(trial_ends_at, NOW()), INTERVAL ? DAY) WHERE id = ? AND referred_by IS NULL', [ref.id, c.bonusDays, newTenant.id]);
  T.clearCache();
  await T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', ['indicacao', 'indicacao-cadastro', newTenant.id, `indicada por ${ref.slug}`]).catch(() => {});
  return ref;
}

// Situação das indicadas: só conta para o desconto quem está com a assinatura em dia
export const REF_STATE = { ativa: ['realizada', 'Assinante — conta para o desconto'], teste: ['confirmada', 'Em teste grátis'], pendente: ['agendada', 'Aguardando o 1º pagamento'], atrasada: ['falta', 'Mensalidade em aberto'], cancelada: ['cancelada', 'Cancelou'], cortesia: ['cancelada', 'Cortesia'] };
export async function referredOf(tenantId) {
  return T.pq('SELECT id, slug, name, billing_status, status, referred_at, created_at FROM tenants WHERE referred_by = ? ORDER BY COALESCE(referred_at, created_at) DESC', [tenantId]);
}
export const counts = (rows) => rows.filter((r) => r.billing_status === 'ativa' && r.status === 'ativa').length;
export async function summary(t) {
  const c = await config(); const rows = await referredOf(t.id); const paying = counts(rows);
  const row = await T.pone('SELECT ref_discount FROM tenants WHERE id = ?', [t.id]);
  return { config: c, rows, paying, pct: pctFor(c, paying), applied: Number(row?.ref_discount || 0), next: nextTier(c, paying) };
}
