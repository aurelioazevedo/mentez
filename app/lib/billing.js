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
  nfse: 'Nota fiscal de serviço (NFS-e)', convenios: 'Convênio integrado (TISS, lotes XML e webservice)', convenios_simples: 'Convênio simples (sem integração com as operadoras)', tv: 'Painel de chamadas (TV da recepção)', locacao: 'Locação de salas', portal: 'Portal do paciente',
  personalizacao: 'Personalização (logo, cores, favicon e domínio próprio)',
};
// Partes do sistema que dependem de cada recurso (rotas e telas de configuração)
export const FEATURE_PATHS = [
  [/^\/configuracoes\/dominio(\/|$)/, 'personalizacao'],
  [/^\/(teleconsulta|conta\/teleconsulta|configuracoes\/teleconsulta)(\/|$)/, 'teleconsulta'],
  [/^\/(sessao-ia|configuracoes\/sessao-ia)(\/|$)/, 'ia_sessao'],
  [/^\/(atendimento|configuracoes\/agente)(\/|$)/, 'atendente'],
  [/^\/(financeiro\/notas|configuracoes\/nfse|conta\/fiscal\/nfse)(\/|$)/, 'nfse'],
  // convênio: as partes de integração (TISS, lotes, glosas, webservice) só no integrado; o resto também no simples
  [/^\/financeiro\/convenios\/(lote|recurso|demonstrativo|demonstrativos|glosas)(\/|$)/, 'convenios'],
  [/^\/configuracoes\/convenios\/(tiss|\d+\/(webservice|certificado))(\/|$)/, 'convenios'],
  [/^\/convenios\/paciente\/\d+\/(elegibilidade|pedir-autorizacao|pedido)(\/|$)/, 'convenios'],
  [/^\/(convenios|configuracoes\/convenios|financeiro\/convenios)(\/|$)/, 'convenios_any'],
  [/^\/configuracoes\/tv(\/|$)/, 'tv'],
  [/^\/(locacao|configuracoes\/locacao)(\/|$)/, 'locacao'],
  [/^\/(portal-paciente|configuracoes\/portal)(\/|$)/, 'portal'],
];
// Valores iniciais (editáveis no Painel → Planos). Preços a definir pela Mentez.
const SEED = [
  ['essencial', 'Essencial', 79, 1, 0, ['portal'], 1],
  ['profissional', 'Profissional', 129, 1, 0, ['portal', 'teleconsulta', 'ia_sessao', 'atendente', 'nfse', 'convenios', 'personalizacao'], 2],
  ['clinica', 'Clínica', 249, 5, 39, Object.keys(FEATURES), 3],
  ['piloto', 'Piloto (cortesia)', 0, 10, 0, Object.keys(FEATURES), 9],
];
export const TRIAL_DAYS = () => Number(process.env.MENTEZ_TRIAL_DAYS || 14);
export const GRACE_DAYS = () => Number(process.env.MENTEZ_GRACE_DAYS || 10);

const COLS = [
  ['trial_ends_at', 'DATETIME NULL'], ['ins_mode', 'VARCHAR(10) NULL'], ['billing_provider', 'VARCHAR(12) NULL'], ['mp_preapproval', 'VARCHAR(60) NULL'], ['billing_status', "VARCHAR(20) NOT NULL DEFAULT 'cortesia'"], ['asaas_customer', 'VARCHAR(40) NULL'],
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
  // planos: textos e destaque usados no site (mentez.com.br)
  for (const [c, def] of [['tagline', 'VARCHAR(160) NULL'], ['audience', "VARCHAR(12) NOT NULL DEFAULT 'individual'"], ['highlight', 'TINYINT(1) NOT NULL DEFAULT 0']]) {
    if (!(await T.pone('SELECT 1 x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['plans', c]))) await T.pq(`ALTER TABLE plans ADD COLUMN ${c} ${def}`);
  }
  if (!(await T.pone("SELECT 1 x FROM platform_settings WHERE k = 'site_plans_v1'").catch(() => null))) {
    const seed = { essencial: ['Para tirar o consultório do papel.', 'individual', 0], profissional: ['Tudo para quem atende sozinho.', 'individual', 1], clinica: ['Profissionais, salas e recepção.', 'clinica', 0] };
    await T.pq('CREATE TABLE IF NOT EXISTS platform_settings (k VARCHAR(60) PRIMARY KEY, v TEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    for (const [k, [tg, au, hl]] of Object.entries(seed)) await T.pq('UPDATE plans SET tagline = COALESCE(tagline, ?), audience = ?, highlight = ? WHERE plan_key = ?', [tg, au, hl, k]);
    await T.pq("INSERT INTO platform_settings (k, v) VALUES ('site_plans_v1', '1')");
  }
  await T.pq(`CREATE TABLE IF NOT EXISTS billing_events (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant_id INT NULL, event VARCHAR(60) NOT NULL, payment_id VARCHAR(40) NULL, status VARCHAR(30) NULL,
    value DECIMAL(10,2) NULL, due_date DATE NULL, raw_hash CHAR(64) NULL UNIQUE, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (tenant_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await T.pq('CREATE TABLE IF NOT EXISTS platform_settings (k VARCHAR(60) PRIMARY KEY, v TEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
  // uma vez: “personalização” entra em todos os planos já cadastrados, menos o Essencial (o mais simples)
  if (!(await T.pone("SELECT 1 x FROM platform_settings WHERE k = 'feat_personalizacao_v1'"))) {
    for (const r of await T.pq('SELECT plan_key, features FROM plans')) {
      const f = JSON.parse(r.features || '[]');
      if (r.plan_key !== 'essencial' && !f.includes('personalizacao')) await T.pq('UPDATE plans SET features = ? WHERE plan_key = ?', [JSON.stringify([...f, 'personalizacao']), r.plan_key]);
    }
    await T.pq("INSERT INTO platform_settings (k, v) VALUES ('feat_personalizacao_v1', '1')");
    clearPlans();
  }
}

// ---------- planos (cache curto) ----------
let pcache = null;
export async function plans(force = false) {
  if (!force && pcache && Date.now() - pcache.at < 60e3) return pcache.v;
  const rows = await T.pq('SELECT * FROM plans ORDER BY position, price');
  const v = rows.map((r) => ({ key: r.plan_key, name: r.name, price: Number(r.price), maxPros: r.max_pros, extraPro: Number(r.extra_pro_price), features: JSON.parse(r.features || '[]'), public: !!r.public,
    tagline: r.tagline || '', audience: r.audience === 'clinica' ? 'clinica' : 'individual', highlight: !!r.highlight, position: r.position }));
  pcache = { at: Date.now(), v }; return v;
}
export const clearPlans = () => { pcache = null; };
export async function planOf(t) { const all = await plans(); return all.find((p) => p.key === t?.plan) || all.find((p) => p.key === 'profissional') || all[0]; }
// Durante o teste grátis: recursos do plano Profissional (ou do plano escolhido, se maior)
// O tipo do módulo de convênio pode ser definido por clínica no Painel (tenants.ins_mode), acima do plano:
// integrado | simples | nenhum; vazio = o que o plano dá.
export const INS_MODES = { '': 'Conforme o plano', integrado: 'Convênio integrado (TISS e webservice)', simples: 'Convênio simples (sem integração)', nenhum: 'Sem módulo de convênio' };
export async function featuresOf(t) {
  const p = await planOf(t);
  let f = p?.features || [];
  if (accessOf(t).state === 'teste') { const pro = (await plans()).find((x) => x.key === 'profissional'); f = [...new Set([...f, ...(pro?.features || [])])]; }
  const m = t?.insMode;
  if (m) { f = f.filter((x) => x !== 'convenios' && x !== 'convenios_simples'); if (m === 'integrado') f.push('convenios'); if (m === 'simples') f.push('convenios_simples'); }
  return f;
}
// O recurso está liberado? (convenios_any = qualquer um dos dois módulos de convênio)
export const has = (feats, k) => (k === 'convenios_any' ? feats.includes('convenios') || feats.includes('convenios_simples') : feats.includes(k));
// Tipo do convênio da clínica atual: 'integrado', 'simples' ou null
export async function insModeOf(t) {
  if (!T.multi() || !t) return 'integrado';
  const f = await featuresOf(t);
  return f.includes('convenios') ? 'integrado' : f.includes('convenios_simples') ? 'simples' : null;
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
// Provedores de cobrança das mensalidades: Asaas (Pix, boleto, cartão) ou Mercado Pago (assinatura no cartão).
// O escolhido vale para as novas assinaturas; cada clínica continua no provedor em que assinou.
export const PROVIDERS = {
  asaas: { label: 'Asaas', methods: ['Pix', 'boleto', 'cartão de crédito'] },
  mercadopago: { label: 'Mercado Pago', methods: ['cartão de crédito', 'saldo do Mercado Pago'] },
};
export async function config() {
  let c = {}; try { c = JSON.parse((await getS('billing_cfg')) || '{}'); } catch { /* padrão */ }
  const open = (v, f) => { try { return v ? T.unseal(v)[f] : ''; } catch { return ''; } };
  return { provider: PROVIDERS[c.provider] ? c.provider : 'asaas', env: c.env === 'producao' ? 'producao' : 'sandbox', key: open(c.key_sealed, 'key'),
    mpToken: open(c.mp_sealed, 'token'), mpSecret: open(c.mp_secret_sealed, 'secret'), token: c.token || '', dueDay: c.dueDay || null, webhookAt: c.webhookAt || null };
}
export async function saveConfig(b) {
  const cur = await config();
  const key = String(b.key || '').trim() || cur.key;
  const mpToken = String(b.mp_token || '').trim() || cur.mpToken;
  const mpSecret = b.mp_secret_clear ? '' : String(b.mp_secret || '').trim() || cur.mpSecret;
  const env = b.env === 'producao' ? 'producao' : 'sandbox';
  const provider = PROVIDERS[b.provider] ? b.provider : cur.provider;
  await setS('billing_cfg', JSON.stringify({ provider, env, key_sealed: key ? T.seal({ key }) : null, mp_sealed: mpToken ? T.seal({ token: mpToken }) : null, mp_secret_sealed: mpSecret ? T.seal({ secret: mpSecret }) : null,
    token: cur.token || crypto.randomBytes(24).toString('base64url'), webhookAt: env === cur.env && key === cur.key ? cur.webhookAt : null }));
  return config();
}
// Pronto para cobrar pelo provedor escolhido (ou por um específico)
export const ready = (c, provider = c.provider) => (provider === 'mercadopago' ? !!c.mpToken : !!c.key);
const base = (c) => process.env.MENTEZ_ASAAS_URL || (c.env === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3');
async function api(c, method, path, body) {
  const r = await fetch(`${base(c)}${path}`, { method, signal: AbortSignal.timeout(25000), headers: { access_token: c.key, 'Content-Type': 'application/json', 'User-Agent': 'Mentez/1.0' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Asaas ${r.status}: ${d?.errors?.[0]?.description || d?.message || 'erro'}`); e.status = r.status; throw e; }
  return d;
}
export async function testConnection(c, provider = c.provider) {
  if (provider === 'mercadopago') { const d = await mp(c, 'GET', '/users/me'); return d?.nickname || d?.email || 'conta Mercado Pago'; }
  const d = await api(c, 'GET', '/myAccount'); return d?.name || d?.email || 'conta Asaas';
}
// ---------- Mercado Pago (assinaturas: /preapproval) ----------
const mpBase = () => process.env.MENTEZ_MP_URL || 'https://api.mercadopago.com';
async function mp(c, method, path, body) {
  const r = await fetch(`${mpBase()}${path}`, { method, signal: AbortSignal.timeout(25000), headers: { Authorization: `Bearer ${c.mpToken}`, 'Content-Type': 'application/json', 'User-Agent': 'Mentez/1.0', ...(method === 'POST' ? { 'X-Idempotency-Key': crypto.randomUUID() } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Mercado Pago ${r.status}: ${d?.cause?.[0]?.description || d?.message || d?.error || 'erro'}`); e.status = r.status; throw e; }
  return d;
}
// De qual provedor é a assinatura desta clínica (a que já existe manda; senão, o escolhido no painel)
const providerOf = (row, c) => (row?.asaas_subscription ? 'asaas' : row?.mp_preapproval ? 'mercadopago' : c.provider);
// Webhook da plataforma (cobranças das clínicas): app.mentez.com.br/webhooks/asaas, autenticado pelo token
export async function registerWebhook(c, url, email) {
  await api(c, 'POST', '/webhooks', { name: 'Mentez — assinaturas', url, email, enabled: true, interrupted: false, authToken: c.token, sendType: 'SEQUENTIALLY',
    events: ['PAYMENT_CREATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED', 'SUBSCRIPTION_DELETED', 'SUBSCRIPTION_INACTIVATED'] });
  const raw = JSON.parse((await getS('billing_cfg')) || '{}'); raw.webhookAt = new Date().toISOString(); await setS('billing_cfg', JSON.stringify(raw));
}

// ---------- assinatura de uma clínica ----------
const docOk = (d) => /^(\d{11}|\d{14})$/.test(d);
export async function subscribe(t, opts) {
  const c = await config();
  const row = await T.pone('SELECT * FROM tenants WHERE id = ?', [t.id]);
  return providerOf(row, c) === 'mercadopago' ? subscribeMp(t, opts, c, row) : subscribeAsaas(t, opts, c);
}
async function subscribeMp(t, { planKey, payerName, payerDoc, email }, c, row) {
  if (!ready(c, 'mercadopago')) throw new Error('A cobrança da Mentez ainda não está configurada. Fale com a Mentez.');
  const plan = (await plans()).find((p) => p.key === planKey && p.public);
  if (!plan) throw new Error('Escolha um plano.');
  const doc = String(payerDoc || '').replace(/\D/g, '');
  if (doc && !docOk(doc)) throw new Error('Confira o CPF ou CNPJ.');
  const mail = String(email || row.owner_email || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(mail)) throw new Error('Informe o e-mail da conta do Mercado Pago que vai pagar.');
  const value = monthly(plan, row.extra_pros);
  const trialEnd = String(row.trial_ends_at || '').slice(0, 10);
  let pre = row.mp_preapproval; let checkout = null;
  if (pre) {
    await mp(c, 'PUT', `/preapproval/${pre}`, { reason: `Mentez — plano ${plan.name}`, auto_recurring: { transaction_amount: value, currency_id: 'BRL' } });
  } else {
    const d = await mp(c, 'POST', '/preapproval', {
      reason: `Mentez — plano ${plan.name}`, external_reference: `mentez:${t.slug}`, payer_email: mail, status: 'pending',
      back_url: `${t.env.PUBLIC_URL}/configuracoes/assinatura?mp=1`,
      // no teste grátis, a 1ª cobrança só acontece quando o teste acaba
      auto_recurring: { frequency: 1, frequency_type: 'months', transaction_amount: value, currency_id: 'BRL', ...(trialEnd && trialEnd > today() ? { start_date: `${trialEnd}T12:00:00.000-03:00` } : {}) },
    });
    pre = d.id; checkout = d.init_point || d.sandbox_init_point || null;
  }
  const status = row.billing_status === 'ativa' ? 'ativa' : (trialEnd && trialEnd > today() ? 'teste' : 'pendente');
  await T.pq("UPDATE tenants SET plan = ?, mp_preapproval = ?, billing_provider = 'mercadopago', payer_doc_enc = COALESCE(?, payer_doc_enc), billing_status = ?, overdue_since = IF(? = 'pendente', COALESCE(overdue_since, CURDATE()), overdue_since) WHERE id = ?",
    [plan.key, pre, doc ? T.seal({ doc }) : null, status, status, t.id]);
  T.clearCache();
  return { subscription: pre, value, provider: 'mercadopago', checkoutUrl: checkout };
}
async function subscribeAsaas(t, { planKey, payerName, payerDoc, email, phone }, c) {
  if (!ready(c, 'asaas')) throw new Error('A cobrança da Mentez ainda não está configurada. Fale com a Mentez.');
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
  await T.pq('UPDATE tenants SET plan = ?, asaas_customer = ?, asaas_subscription = ?, billing_provider = \'asaas\', payer_doc_enc = ?, billing_status = ?, overdue_since = IF(? = \'pendente\', COALESCE(overdue_since, CURDATE()), overdue_since) WHERE id = ?',
    [plan.key, customer, sub, T.seal({ doc }), status, status, t.id]);
  T.clearCache();
  return { subscription: sub, value, nextDue, invoiceUrl: await nextInvoiceUrl(c, sub) };
}
export async function invoices(t) {
  const c = await config(); const row = await T.pone('SELECT asaas_subscription, mp_preapproval FROM tenants WHERE id = ?', [t.id]);
  if (row?.mp_preapproval && ready(c, 'mercadopago')) {
    const d = await mp(c, 'GET', `/authorized_payments/search?preapproval_id=${encodeURIComponent(row.mp_preapproval)}&limit=12`);
    const ST = { approved: 'RECEIVED', rejected: 'OVERDUE', pending: 'PENDING', in_process: 'PENDING' };
    return (d.results || []).map((p) => ({ id: p.id, value: p.transaction_amount, due: String(p.debit_date || p.date_created || '').slice(0, 10), status: ST[p.payment?.status] || (p.status === 'scheduled' ? 'PENDING' : String(p.status || '').toUpperCase()), url: null, paidAt: p.payment?.status === 'approved' ? String(p.last_modified || p.debit_date || '').slice(0, 10) : null }));
  }
  if (!ready(c, 'asaas') || !row?.asaas_subscription) return [];
  const d = await api(c, 'GET', `/payments?subscription=${row.asaas_subscription}&limit=12`);
  return (d.data || []).map((p) => ({ id: p.id, value: p.value, due: p.dueDate, status: p.status, url: p.invoiceUrl, paidAt: p.paymentDate || p.clientPaymentDate }));
}
async function nextInvoiceUrl(c, sub) {
  try { const d = await api(c, 'GET', `/payments?subscription=${sub}&limit=5`); const open = (d.data || []).filter((p) => ['PENDING', 'OVERDUE'].includes(p.status)).sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1)); return open[0]?.invoiceUrl || null; } catch { return null; }
}
export async function cancel(t) {
  const c = await config(); const row = await T.pone('SELECT asaas_subscription, mp_preapproval FROM tenants WHERE id = ?', [t.id]);
  if (row?.asaas_subscription && ready(c, 'asaas')) await api(c, 'DELETE', `/subscriptions/${row.asaas_subscription}`).catch((e) => { if (e.status !== 404) throw e; });
  if (row?.mp_preapproval && ready(c, 'mercadopago')) await mp(c, 'PUT', `/preapproval/${row.mp_preapproval}`, { status: 'cancelled' }).catch((e) => { if (e.status !== 404) throw e; });
  await T.pq("UPDATE tenants SET billing_status = 'cancelada', asaas_subscription = NULL, mp_preapproval = NULL WHERE id = ?", [t.id]); T.clearCache();
}

// Profissional a mais (planos com valor por profissional extra): ajusta o contador e o valor da assinatura
export async function setExtraPros(t, delta) {
  if (!t) return;
  await T.pq('UPDATE tenants SET extra_pros = GREATEST(0, extra_pros + ?) WHERE id = ?', [delta, t.id]);
  const row = await T.pone('SELECT * FROM tenants WHERE id = ?', [t.id]); T.clearCache();
  const c = await config(); const plan = (await plans()).find((p) => p.key === row.plan);
  if (row.asaas_subscription && ready(c, 'asaas') && plan) await api(c, 'POST', `/subscriptions/${row.asaas_subscription}`, { value: monthly(plan, row.extra_pros), updatePendingPayments: true });
  if (row.mp_preapproval && ready(c, 'mercadopago') && plan) await mp(c, 'PUT', `/preapproval/${row.mp_preapproval}`, { auto_recurring: { transaction_amount: monthly(plan, row.extra_pros), currency_id: 'BRL' } });
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
// ---------- avisos do Mercado Pago (webhook) ----------
// O aviso traz só o tipo e o número; os dados vêm de uma consulta ao Mercado Pago.
export function mpSignatureOk(c, { signature, requestId, dataId }) {
  if (!c.mpSecret) return true;
  const parts = Object.fromEntries(String(signature || '').split(',').map((kv) => kv.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const h = crypto.createHmac('sha256', c.mpSecret).update(`id:${String(dataId || '').toLowerCase()};request-id:${requestId || ''};ts:${parts.ts};`).digest('hex');
  return h.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(parts.v1));
}
async function tenantOfPre(pre, extRef) {
  let t = pre ? await T.pone('SELECT id, slug, billing_status FROM tenants WHERE mp_preapproval = ?', [pre]) : null;
  const slug = /^mentez:([a-z0-9-]+)$/.exec(String(extRef || ''))?.[1];
  if (!t && slug) t = await T.pone('SELECT id, slug, billing_status FROM tenants WHERE slug = ?', [slug]);
  return t;
}
export async function handleMercadoPago(type, id) {
  const c = await config();
  if (!ready(c, 'mercadopago') || !/^[\w-]{3,60}$/.test(String(id || ''))) return { ignored: true };
  const log = async (t, event, status, value, due) => {
    const hash = crypto.createHash('sha256').update(JSON.stringify(['mp', event, id, status])).digest('hex');
    try { await T.pq('INSERT INTO billing_events (tenant_id, event, payment_id, status, value, due_date, raw_hash) VALUES (?,?,?,?,?,?,?)', [t?.id || null, event, String(id).slice(0, 40), status || null, value || null, due || null, hash]); return true; }
    catch (e) { if (/Duplicate/.test(e.message)) return false; throw e; }
  };
  if (type === 'subscription_authorized_payment') {
    const ap = await mp(c, 'GET', `/authorized_payments/${id}`);
    const pre = ap.preapproval_id; const st = ap.payment?.status || ap.status;
    const t = await tenantOfPre(pre, ap.external_reference);
    const due = String(ap.debit_date || ap.date_created || today()).slice(0, 10);
    if (!(await log(t, 'MP_AUTHORIZED_PAYMENT', st, ap.transaction_amount, due)) || !t) return { ignored: !t };
    if (st === 'approved') await T.pq("UPDATE tenants SET billing_status = 'ativa', overdue_since = NULL, paid_until = GREATEST(COALESCE(paid_until, '1970-01-01'), ?) WHERE id = ?", [addMonth(due), t.id]);
    else if (st === 'rejected') await T.pq("UPDATE tenants SET billing_status = IF(billing_status = 'cortesia', billing_status, 'atrasada'), overdue_since = COALESCE(overdue_since, ?) WHERE id = ?", [due, t.id]);
  } else if (type === 'subscription_preapproval') {
    const pa = await mp(c, 'GET', `/preapproval/${id}`);
    const t = await tenantOfPre(pa.id, pa.external_reference);
    if (!(await log(t, 'MP_PREAPPROVAL', pa.status, pa.auto_recurring?.transaction_amount, null)) || !t) return { ignored: !t };
    if (pa.status === 'authorized') await T.pq("UPDATE tenants SET mp_preapproval = ?, billing_provider = 'mercadopago' WHERE id = ?", [pa.id, t.id]);
    else if (pa.status === 'cancelled') await T.pq("UPDATE tenants SET billing_status = IF(billing_status = 'cortesia', billing_status, 'cancelada'), mp_preapproval = NULL WHERE id = ?", [t.id]);
    else if (pa.status === 'paused') await T.pq("UPDATE tenants SET billing_status = IF(billing_status IN ('cortesia','teste'), billing_status, 'atrasada'), overdue_since = COALESCE(overdue_since, CURDATE()) WHERE id = ?", [t.id]);
  } else return { ignored: true };
  T.clearCache();
  return { ok: true };
}
export async function webhookAuth(token) { const c = await config(); return !!c.token && typeof token === 'string' && token.length === c.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(c.token)); }

// ---------- conferência periódica (caso algum aviso do Asaas se perca) ----------
export async function tick() {
  const c = await config();
  // Mercado Pago: confere as cobranças recentes das assinaturas (caso algum aviso tenha se perdido)
  if (ready(c, 'mercadopago')) {
    for (const r of await T.pq("SELECT id, mp_preapproval FROM tenants WHERE mp_preapproval IS NOT NULL AND billing_status IN ('pendente','atrasada','ativa','teste')")) {
      try {
        const d = await mp(c, 'GET', `/authorized_payments/search?preapproval_id=${encodeURIComponent(r.mp_preapproval)}&limit=3`);
        for (const p of d.results || []) if (['approved', 'rejected'].includes(p.payment?.status)) await handleMercadoPago('subscription_authorized_payment', String(p.id));
      } catch (e) { console.error('cobrança Mentez (Mercado Pago):', e.message); }
    }
  }
  if (!ready(c, 'asaas')) return;
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

// ---------- informações públicas para o site (mentez.com.br) ----------
// Nomes dos recursos como aparecem no site (convênio sem destacar o TISS)
export const SITE_LABELS = {
  portal: 'App do paciente', teleconsulta: 'Teleconsulta própria', ia_sessao: 'IA na sessão e escrita de documentos', atendente: 'Atendente de IA no WhatsApp',
  nfse: 'NFS-e', convenios: 'Convênios', convenios_simples: 'Convênios', tv: 'Painel de chamada na TV', locacao: 'Locação de salas', personalizacao: 'Sua marca e domínio próprio',
};
export async function siteContact() { return (await getS('site_contact')) || 'contato@mentez.com.br'; }
export async function setSiteContact(v) { await setS('site_contact', String(v || '').trim().slice(0, 120) || 'contato@mentez.com.br'); }
export async function publicInfo() {
  const c = await config();
  const list = (await plans()).filter((p) => p.public).map((p) => ({ key: p.key, name: p.name, price: p.price, maxPros: p.maxPros, extraPro: p.extraPro, tagline: p.tagline, audience: p.audience, highlight: p.highlight,
    features: [...new Set(p.features.map((k) => (k === 'convenios_simples' ? 'convenios' : k)))] }));
  return { plans: list, labels: { ...SITE_LABELS }, payment: { provider: c.provider, label: PROVIDERS[c.provider].label, methods: PROVIDERS[c.provider].methods },
    contact: await siteContact(), trialDays: TRIAL_DAYS() };
}

// Link para a clínica pagar (Asaas: próxima fatura em aberto) ou autorizar a assinatura (Mercado Pago: checkout pendente).
// Mercado Pago já autorizado: cobrado no cartão automaticamente, sem link.
export async function paymentLink(t) {
  const c = await config(); const row = await T.pone('SELECT asaas_subscription, mp_preapproval FROM tenants WHERE id = ?', [t.id]);
  if (row?.mp_preapproval && ready(c, 'mercadopago')) {
    const pa = await mp(c, 'GET', `/preapproval/${row.mp_preapproval}`);
    if (pa.status === 'authorized') return { provider: 'mercadopago', url: null, auto: true };
    return { provider: 'mercadopago', url: pa.init_point || pa.sandbox_init_point || null, kind: 'autorizar' };
  }
  if (row?.asaas_subscription && ready(c, 'asaas')) return { provider: 'asaas', url: await nextInvoiceUrl(c, row.asaas_subscription), kind: 'pagar' };
  return null;
}
