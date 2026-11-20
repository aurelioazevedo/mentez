// Mentez — planos, teste grátis, limites e cobrança recorrente das clínicas (Asaas).
// Tudo no banco da plataforma. A chave do Asaas fica cifrada com a chave mestra (Painel → Cobrança).
//
// Situação de acesso de uma clínica (accessOf):
//   cortesia  → clínicas piloto/parceiras, sem cobrança
//   teste     → dentro dos dias de teste grátis
//   ativa     → assinatura em dia
//   atrasada  → mensalidade vencida há poucos dias: usa normalmente, com aviso
//   bloqueada → teste terminado sem assinatura, ou atraso além da tolerância: só a tela de assinatura (dados guardados)
import crypto from 'node:crypto';
import * as T from './tenancy.js';

export const FEATURES = {
  teleconsulta: 'Teleconsulta própria', ia_sessao: 'IA na sessão (transcrição e rascunho)', atendente: 'Atendente virtual no WhatsApp',
  nfse: 'Nota fiscal de serviço (NFS-e)', convenios: 'Convênios e TISS', tv: 'Painel de chamadas (TV da recepção)', locacao: 'Locação de salas', portal: 'Portal do paciente',
};
// Partes do sistema que dependem de cada recurso (rotas e telas de configuração)
export const FEATURE_PATHS = [
  [/^\/(teleconsulta|conta\/teleconsulta|configuracoes\/teleconsulta)(\/|$)/, 'teleconsulta'],
  [/^\/(sessao-ia|configuracoes\/sessao-ia)(\/|$)/, 'ia_sessao'],
  [/^\/(atendimento|configuracoes\/agente)(\/|$)/, 'atendente'],
  [/^\/(financeiro\/notas|configuracoes\/nfse|conta\/fiscal\/nfse)(\/|$)/, 'nfse'],
  [/^\/(convenios|configuracoes\/convenios|financeiro\/convenios)(\/|$)/, 'convenios'],
  [/^\/configuracoes\/tv(\/|$)/, 'tv'],
  [/^\/(locacao|configuracoes\/locacao)(\/|$)/, 'locacao'],
  [/^\/(portal-paciente|configuracoes\/portal)(\/|$)/, 'portal'],
];
// Valores iniciais (editáveis no Painel → Planos). Preços a definir pela Mentez.
const SEED = [
  ['essencial', 'Essencial', 79, 1, 0, ['portal'], 1],
  ['profissional', 'Profissional', 129, 1, 0, ['portal', 'teleconsulta', 'ia_sessao', 'atendente', 'nfse', 'convenios'], 2],
  ['clinica', 'Clínica', 249, 5, 39, Object.keys(FEATURES), 3],
  ['piloto', 'Piloto (cortesia)', 0, 10, 0, Object.keys(FEATURES), 9],
];
export const TRIAL_DAYS = () => Number(process.env.MENTEZ_TRIAL_DAYS || 14);
export const GRACE_DAYS = () => Number(process.env.MENTEZ_GRACE_DAYS || 10);

const COLS = [
  ['trial_ends_at', 'DATETIME NULL'], ['billing_status', "VARCHAR(20) NOT NULL DEFAULT 'cortesia'"], ['asaas_customer', 'VARCHAR(40) NULL'],
  ['asaas_subscription', 'VARCHAR(40) NULL'], ['paid_until', 'DATE NULL'], ['overdue_since', 'DATE NULL'], ['owner_phone', 'VARCHAR(40) NULL'],
  ['owner_crp', 'VARCHAR(30) NULL'], ['payer_doc_enc', 'TEXT NULL'], ['signup_ip', 'VARCHAR(64) NULL'], ['extra_pros', 'INT NOT NULL DEFAULT 0'],
];
export async function migrate() {
  await T.pq(`CREATE TABLE IF NOT EXISTS plans (
    plan_key VARCHAR(30) PRIMARY KEY, name VARCHAR(60) NOT NULL, price DECIMAL(10,2) NOT NULL DEFAULT 0, max_pros INT NOT NULL DEFAULT 1,
    extra_pro_price DECIMAL(10,2) NOT NULL DEFAULT 0, features TEXT NOT NULL, public TINYINT(1) NOT NULL DEFAULT 1, position INT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  for (const [k, n, p, m, x, f, pos] of SEED) await T.pq('INSERT IGNORE INTO plans (plan_key, name, price, max_pros, extra_pro_price, features, public, position) VALUES (?,?,?,?,?,?,?,?)', [k, n, p, m, x, JSON.stringify(f), k === 'piloto' ? 0 : 1, pos]);
  for (const [c, def] of COLS) {
    if (!(await T.pone('SELECT 1 x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['tenants', c]))) await T.pq(`ALTER TABLE tenants ADD COLUMN ${c} ${def}`);
  }
  await T.pq(`CREATE TABLE IF NOT EXISTS billing_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant_id INT NULL, event VARCHAR(60) NOT NULL, payment_id VARCHAR(40) NULL, status VARCHAR(30) NULL,
    value DECIMAL(10,2) NULL, due_date DATE NULL, raw_hash CHAR(64) NULL UNIQUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await T.pq('CREATE TABLE IF NOT EXISTS platform_settings (k VARCHAR(60) PRIMARY KEY, v TEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
}

// ---------- planos (cache curto) ----------
let pcache = null;
export async function plans(force = false) {
  if (!force && pcache && Date.now() - pcache.at < 60e3) return pcache.v;
  const rows = await T.pq('SELECT * FROM plans ORDER BY position, price');
  const v = rows.map((r) => ({ key: r.plan_key, name: r.name, price: Number(r.price), maxPros: r.max_pros, extraPro: Number(r.extra_pro_price), features: JSON.parse(r.features || '[]'), public: !!r.public }));
  pcache = { at: Date.now(), v }; return v;
}
export const clearPlans = () => { pcache = null; };
export async function planOf(t) { const all = await plans(); return all.find((p) => p.key === t?.plan) || all.find((p) => p.key === 'profissional') || all[0]; }
// Durante o teste grátis: recursos do plano Profissional (ou do plano escolhido, se maior)
export async function featuresOf(t) {
  const p = await planOf(t);
  if (accessOf(t).state === 'teste') { const pro = (await plans()).find((x) => x.key === 'profissional'); return [...new Set([...(p?.features || []), ...(pro?.features || [])])]; }
  return p?.features || [];
}
export async function maxPros(t) { const p = await planOf(t); return (p?.maxPros || 1) + Number(t?.extraPros || 0); }
export const monthly = (plan, extra = 0) => Number(plan.price) + Number(extra || 0) * Number(plan.extraPro || 0);

// ---------- situação de acesso ----------
const today = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);
export function accessOf(t) {
  if (!T.multi() || !t) return { state: 'cortesia' };
  const st = t.billingStatus || 'cortesia';
  const d = today();
  if (st === 'cortesia') return { state: 'cortesia' };
  if (st === 'teste') {
    const end = String(t.trialEndsAt || '').slice(0, 10);
    const left = end ? daysBetween(d, end) : 0;
    return left >= 0 ? { state: 'teste', daysLeft: left, ends: end } : { state: 'bloqueada', reason: 'teste', ends: end };
  }
  if (st === 'ativa') return { state: 'ativa', paidUntil: t.paidUntil };
  if (st === 'atrasada' || st === 'pendente') {
    const since = String(t.overdueSince || '').slice(0, 10);
    const late = since ? daysBetween(since, d) : 0;
    return late > GRACE_DAYS() ? { state: 'bloqueada', reason: 'atraso', late } : { state: 'atrasada', late, graceLeft: GRACE_DAYS() - late };
  }
  if (st === 'cancelada') return { state: 'bloqueada', reason: 'cancelada' };
  return { state: 'cortesia' };
}
// Rotas que continuam abertas com o acesso bloqueado (para conseguir assinar e pagar)
export const OPEN_WHEN_BLOCKED = [/^\/configuracoes\/assinatura(\/|$)/, /^\/(login|logout|setup|conta)(\/|$)/, /^\/(static|marca|manifest\.webmanifest|sw\.js|favicon\.ico|robots\.txt|privacidade|termos|live)(\/|$)/, /^\/_mentez\//];

// ---------- configuração do Asaas (plataforma) ----------
async function getS(k) { return (await T.pone('SELECT v FROM platform_settings WHERE k = ?', [k]))?.v || null; }
async function setS(k, v) { await T.pq('INSERT INTO platform_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]); }
export async function config() {
  let c = {}; try { c = JSON.parse((await getS('billing_cfg')) || '{}'); } catch { /* padrão */ }
  let key = ''; try { key = c.key_sealed ? T.unseal(c.key_sealed).key : ''; } catch { key = ''; }
  return { env: c.env === 'producao' ? 'producao' : 'sandbox', key, token: c.token || '', dueDay: c.dueDay || null, webhookAt: c.webhookAt || null };
}
export async function saveConfig(b) {
  const cur = await config();
  const key = String(b.key || '').trim() || cur.key;
  const env = b.env === 'producao' ? 'producao' : 'sandbox';
  await setS('billing_cfg', JSON.stringify({ env, key_sealed: key ? T.seal({ key }) : null, token: cur.token || crypto.randomBytes(24).toString('base64url'), webhookAt: env === cur.env && key === cur.key ? cur.webhookAt : null }));
  return config();
}
export const ready = (c) => !!c.key;
const base = (c) => process.env.MENTEZ_ASAAS_URL || (c.env === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3');
async function api(c, method, path, body) {
  const r = await fetch(`${base(c)}${path}`, { method, signal: AbortSignal.timeout(25000), headers: { access_token: c.key, 'Content-Type': 'application/json', 'User-Agent': 'Mentez/1.0' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Asaas ${r.status}: ${d?.errors?.[0]?.description || d?.message || 'erro'}`); e.status = r.status; throw e; }
  return d;
}
export async function testConnection(c) { const d = await api(c, 'GET', '/myAccount'); return d?.name || d?.email || 'conta Asaas'; }
// Webhook da plataforma (cobranças das clínicas): app.mentez.com.br/webhooks/asaas, autenticado pelo token
export async function registerWebhook(c, url, email) {
  await api(c, 'POST', '/webhooks', { name: 'Mentez — assinaturas', url, email, enabled: true, interrupted: false, authToken: c.token, sendType: 'SEQUENTIALLY',
    events: ['PAYMENT_CREATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED', 'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED'] });
  const raw = JSON.parse((await getS('billing_cfg')) || '{}'); raw.webhookAt = new Date().toISOString(); await setS('billing_cfg', JSON.stringify(raw));
}

// ---------- assinatura de uma clínica ----------
const docOk = (d) => /^(\d{11}|\d{14})$/.test(d);
export async function subscribe(t, { planKey, payerName, payerDoc, email, phone }) {
  const c = await config();
  if (!ready(c)) throw new Error('A cobrança da Mentez ainda não está configurada. Fale com a Mentez.');
  const plan = (await plans()).find((p) => p.key === planKey && p.public);
  if (!plan) throw new Error('Escolha um plano.');
  const doc = String(payerDoc || '').replace(/\D/g, '');
  if (!docOk(doc)) throw new Error('Informe um CPF ou CNPJ válido para a cobrança.');
  const row = await T.pone('SELECT * FROM tenants WHERE id = ?', [t.id]);
  let customer = row.asaas_customer;
  const cust = { name: String(payerName || t.name).slice(0, 120), cpfCnpj: doc, email: email || row.owner_email || undefined, mobilePhone: String(phone || row.owner_phone || '').replace(/\D/g, '') || undefined, externalReference: `mentez:${t.slug}`, notificationDisabled: false };
  if (customer) await api(c, 'POST', `/customers/${customer}`, cust); else customer = (await api(c, 'POST', '/customers', cust)).id;
  const value = monthly(plan, row.extra_pros);
  const trialEnd = String(row.trial_ends_at || '').slice(0, 10);
  const nextDue = trialEnd && trialEnd > today() ? trialEnd : today(); // no teste: a 1ª cobrança vence quando o teste acaba
  let sub = row.asaas_subscription;
  if (sub) await api(c, 'POST', `/subscriptions/${sub}`, { value, description: `Mentez — plano ${plan.name}`, updatePendingPayments: true });
  else sub = (await api(c, 'POST', '/subscriptions', { customer, billingType: 'UNDEFINED', value, nextDueDate: nextDue, cycle: 'MONTHLY', description: `Mentez — plano ${plan.name}`, externalReference: `mentez:${t.slug}` })).id;
  const status = row.billing_status === 'ativa' ? 'ativa' : (trialEnd && trialEnd > today() ? 'teste' : 'pendente');
  await T.pq('UPDATE tenants SET plan = ?, asaas_customer = ?, asaas_subscription = ?, payer_doc_enc = ?, billing_status = ?, overdue_since = IF(? = \'pendente\', COALESCE(overdue_since, CURDATE()), overdue_since) WHERE id = ?',
    [plan.key, customer, sub, T.seal({ doc }), status, status, t.id]);
  T.clearCache();
  return { subscription: sub, value, nextDue, invoiceUrl: await nextInvoiceUrl(c, sub) };
}
export async function invoices(t) {
  const c = await config(); const row = await T.pone('SELECT asaas_subscription FROM tenants WHERE id = ?', [t.id]);
  if (!ready(c) || !row?.asaas_subscription) return [];
  const d = await api(c, 'GET', `/payments?subscription=${row.asaas_subscription}&limit=12`);
  return (d.data || []).map((p) => ({ id: p.id, value: p.value, due: p.dueDate, status: p.status, url: p.invoiceUrl, paidAt: p.paymentDate || p.clientPaymentDate }));
}
async function nextInvoiceUrl(c, sub) {
  try { const d = await api(c, 'GET', `/payments?subscription=${sub}&limit=5`); const open = (d.data || []).filter((p) => ['PENDING', 'OVERDUE'].includes(p.status)).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)); return open[0]?.invoiceUrl || null; } catch { return null; }
}
export async function cancel(t) {
  const c = await config(); const row = await T.pone('SELECT asaas_subscription FROM tenants WHERE id = ?', [t.id]);
  if (row?.asaas_subscription && ready(c)) await api(c, 'DELETE', `/subscriptions/${row.asaas_subscription}`).catch((e) => { if (e.status !== 404) throw e; });
  await T.pq("UPDATE tenants SET billing_status = 'cancelada', asaas_subscription = NULL WHERE id = ?", [t.id]); T.clearCache();
}

// Profissional a mais (planos com valor por profissional extra): ajusta o contador e o valor da assinatura
export async function setExtraPros(t, delta) {
  if (!t) return;
  await T.pq('UPDATE tenants SET extra_pros = GREATEST(0, extra_pros + ?) WHERE id = ?', [delta, t.id]);
  const row = await T.pone('SELECT * FROM tenants WHERE id = ?', [t.id]); T.clearCache();
  const c = await config(); const plan = (await plans()).find((p) => p.key === row.plan);
  if (row.asaas_subscription && ready(c) && plan) await api(c, 'POST', `/subscriptions/${row.asaas_subscription}`, { value: monthly(plan, row.extra_pros), updatePendingPayments: true });
}

// ---------- avisos do Asaas (webhook) ----------
const PAID = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
function addMonth(ymd) { const [y, m, d] = ymd.split('-').map(Number); const dt = new Date(Date.UTC(y, m, Math.min(d, 28))); return dt.toISOString().slice(0, 10); }
export async function handleEvent(ev) {
  const p = ev.payment || {}; const s = ev.subscription || {};
  const subId = p.subscription || s.id;
  const t = subId ? await T.pone('SELECT * FROM tenants WHERE asaas_subscription = ?', [subId]) : null;
  const hash = crypto.createHash('sha256').update(JSON.stringify([ev.event, p.id, p.status, s.id, ev.dateCreated || ''])).digest('hex');
  try { await T.pq('INSERT INTO billing_events (tenant_id, event, payment_id, status, value, due_date, raw_hash) VALUES (?,?,?,?,?,?,?)', [t?.id || null, ev.event, p.id || null, p.status || s.status || null, p.value || null, p.dueDate || null, hash]); }
  catch (e) { if (/Duplicate/.test(e.message)) return { duplicate: true }; throw e; }
  if (!t) return { ignored: true };
  if (['PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED'].includes(ev.event) || PAID.includes(p.status)) {
    const until = addMonth(p.dueDate || today());
    await T.pq("UPDATE tenants SET billing_status = 'ativa', overdue_since = NULL, paid_until = GREATEST(COALESCE(paid_until, '1970-01-01'), ?) WHERE id = ?", [until, t.id]);
  } else if (ev.event === 'PAYMENT_OVERDUE') {
    await T.pq("UPDATE tenants SET billing_status = IF(billing_status = 'cortesia', billing_status, 'atrasada'), overdue_since = COALESCE(overdue_since, ?) WHERE id = ?", [p.dueDate || today(), t.id]);
  } else if (['SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED'].includes(ev.event)) {
    await T.pq("UPDATE tenants SET billing_status = IF(billing_status = 'cortesia', billing_status, 'cancelada'), asaas_subscription = NULL WHERE id = ?", [t.id]);
  }
  T.clearCache();
  return { ok: true, tenant: t.slug };
}
export async function webhookAuth(token) { const c = await config(); return !!c.token && typeof token === 'string' && token.length === c.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(c.token)); }

// ---------- conferência periódica (caso algum aviso do Asaas se perca) ----------
export async function tick() {
  const c = await config(); if (!ready(c)) return;
  const rows = await T.pq("SELECT id, asaas_subscription FROM tenants WHERE asaas_subscription IS NOT NULL AND billing_status IN ('pendente','atrasada','ativa','teste')");
  for (const r of rows) {
    try {
      const d = await api(c, 'GET', `/payments?subscription=${r.asaas_subscription}&limit=3`);
      for (const p of (d.data || []).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))) {
        const ev = PAID.includes(p.status) ? 'PAYMENT_RECEIVED' : p.status === 'OVERDUE' ? 'PAYMENT_OVERDUE' : null;
        if (ev) await handleEvent({ event: ev, payment: p, dateCreated: `conferencia-${p.status}` });
      }
    } catch (e) { console.error('cobrança Mentez:', e.message); }
  }
}
