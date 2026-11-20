// Cobrança automática pelo Asaas ou pelo Mercado Pago: boleto, Pix e cartão (o paciente escolhe), com baixa
// automática no financeiro quando o serviço avisa (webhook). Só para recebimentos da clínica.
// Uma rotina de conferência cancela no serviço o que foi pago de outro jeito, excluído ou alterado.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { todayLocal, addDays } from './time.js';
import * as Fin from './fin.js';
import * as Live from './live.js';
import { notify } from './push.js';

export const PROVIDERS = { asaas: 'Asaas', mercadopago: 'Mercado Pago' };
export const providerLabel = (k) => PROVIDERS[k] || k;
export const BILLING = { UNDEFINED: 'O paciente escolhe: Pix, boleto ou cartão', PIX: 'Só Pix', BOLETO: 'Boleto (com Pix no boleto)', CREDIT_CARD: 'Só cartão de crédito' };
const METHOD_OF = { PIX: 'pix', BOLETO: 'boleto', CREDIT_CARD: 'cartao', DEBIT_CARD: 'cartao', UNDEFINED: 'pix' };
const ACTIVE = ['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS'];
const PAID = ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'];
export const STATUS_LABEL = { PENDING: 'Aguardando pagamento', OVERDUE: 'Vencida', RECEIVED: 'Paga', CONFIRMED: 'Paga (cartão confirmado)', RECEIVED_IN_CASH: 'Paga', CANCELLED: 'Cancelada', REFUNDED: 'Estornada', AWAITING_RISK_ANALYSIS: 'Em análise', ERROR: 'Erro' };
const DEFAULTS = { enabled: false, provider: 'asaas', env: 'sandbox', billing: 'UNDEFINED', autoDays: 0, fine: 0, interest: 0, confirmWhatsApp: true, gatewayEmails: false, publicUrl: '' };

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('gateway_cfg')) || '{}'); } catch { /* padrão */ }
  const out = { ...DEFAULTS, ...c };
  const dec = (v) => { try { return v ? decrypt(v) : ''; } catch { return ''; } };
  out.key = dec(c.key_enc); out.mpKey = dec(c.mp_key_enc); out.mpSecret = dec(c.mp_secret_enc);
  if (!PROVIDERS[out.provider]) out.provider = 'asaas';
  delete out.key_enc; delete out.mp_key_enc; delete out.mp_secret_enc;
  if (!out.token) out.token = '';
  return out;
}
export const keyOf = (c, provider = c.provider) => (provider === 'mercadopago' ? c.mpKey : c.key);
export const ready = (c) => !!(c.enabled && keyOf(c));
export function checkInput(b, cur) {
  const provider = PROVIDERS[b.provider] ? b.provider : 'asaas';
  if (provider === 'mercadopago') {
    const k = String(b.mpKey || '').trim();
    if (b.enabled && !k && !cur.mpKey) return 'Informe o Access Token do Mercado Pago.';
    if (k && !/^(APP_USR|TEST)-[\w-]{20,}$/.test(k)) return 'Access Token inválido (no Mercado Pago ele começa com APP_USR- ou TEST-).';
    return null;
  }
  const k = String(b.key || '').trim();
  if (b.enabled && !k && !cur.key) return 'Informe a chave de API do Asaas.';
  if (k && (k.length < 20 || /\s/.test(k))) return 'Chave de API inválida (no Asaas ela começa com $aact_).';
  return null;
}
export async function saveConfig(b, cur, publicUrl = '') {
  const k = String(b.key || '').trim();
  const mk = String(b.mpKey || '').trim(); const ms = String(b.mpSecret || '').trim();
  const provider = PROVIDERS[b.provider] ? b.provider : 'asaas';
  const env = b.env === 'producao' ? 'producao' : 'sandbox';
  const keyChanged = (k && k !== cur.key) || env !== cur.env || provider !== cur.provider;
  await setSetting('gateway_cfg', JSON.stringify({
    enabled: !!b.enabled, provider, env, billing: BILLING[b.billing] ? b.billing : 'UNDEFINED', publicUrl: String(publicUrl || cur.publicUrl || '').replace(/\/$/, ''),
    mp_key_enc: (mk || cur.mpKey) ? encrypt(mk || cur.mpKey) : null, mp_secret_enc: b.mpSecretRemove ? null : (ms || cur.mpSecret) ? encrypt(ms || cur.mpSecret) : null,
    autoDays: Math.min(30, Math.max(0, Number(b.autoDays) || 0)), fine: Math.min(2, Math.max(0, Number(String(b.fine || 0).replace(',', '.')) || 0)),
    interest: Math.min(1, Math.max(0, Number(String(b.interest || 0).replace(',', '.')) || 0)), confirmWhatsApp: !!b.confirmWhatsApp, gatewayEmails: !!b.gatewayEmails,
    key_enc: (k || cur.key) ? encrypt(k || cur.key) : null, token: cur.token || crypto.randomBytes(24).toString('base64url'),
    webhookAt: provider === 'mercadopago' ? 'automatico' : keyChanged ? null : (cur.webhookAt === 'automatico' ? null : cur.webhookAt || null),
  }));
  if (keyChanged) await q('UPDATE patients SET gw_customer = NULL');
}

// ---------- API do Asaas ----------
const baseOf = (c) => process.env.ASAAS_BASE_URL || (c.env === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3');
async function api(c, method, path, body) {
  const r = await fetch(`${baseOf(c)}${path}`, {
    method, signal: AbortSignal.timeout(25000),
    headers: { access_token: c.key, 'Content-Type': 'application/json', 'User-Agent': 'SistemaConsultorio/1.0' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Asaas ${r.status}: ${d?.errors?.[0]?.description || d?.message || 'erro'}`); e.status = r.status; throw e; }
  return d;
}
// ---------- API do Mercado Pago ----------
const mpBase = () => process.env.MP_BASE_URL || 'https://api.mercadopago.com';
async function mp(c, method, path, body) {
  const r = await fetch(`${mpBase()}${path}`, {
    method, signal: AbortSignal.timeout(25000),
    headers: { Authorization: `Bearer ${c.mpKey}`, 'Content-Type': 'application/json', 'User-Agent': 'SistemaConsultorio/1.0', ...(method === 'POST' ? { 'X-Idempotency-Key': crypto.randomUUID() } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(`Mercado Pago ${r.status}: ${d?.cause?.[0]?.description || d?.message || d?.error || 'erro'}`); e.status = r.status; throw e; }
  return d;
}
const mpNotifyUrl = (c) => (c.publicUrl ? `${c.publicUrl}/webhooks/cobranca/mercadopago?t=${encodeURIComponent(c.token)}` : undefined);
const mpExclude = (billing) => ({ PIX: ['credit_card', 'debit_card', 'ticket'], CREDIT_CARD: ['ticket', 'bank_transfer', 'debit_card'], BOLETO: ['credit_card', 'debit_card', 'bank_transfer'] }[billing] || []);
const MP_METHOD = { credit_card: 'cartao', debit_card: 'cartao', prepaid_card: 'cartao', ticket: 'boleto', bank_transfer: 'pix', account_money: 'pix' };
const MP_BILLING = { credit_card: 'CREDIT_CARD', debit_card: 'DEBIT_CARD', prepaid_card: 'CREDIT_CARD', ticket: 'BOLETO', bank_transfer: 'PIX', account_money: 'PIX' };

export async function testConnection(c) {
  if (c.provider === 'mercadopago') { const d = await mp(c, 'GET', '/users/me'); return { ok: true, name: d.nickname || d.email || 'conta Mercado Pago' }; }
  const d = await api(c, 'GET', '/myAccount');
  return { ok: true, name: d.name || d.companyName || d.email || 'conta Asaas' };
}
export async function registerWebhook(c, publicUrl, email) {
  const url = `${publicUrl.replace(/\/$/, '')}/webhooks/cobranca/asaas`;
  await api(c, 'POST', '/webhooks', {
    name: 'Sistema do Consultório', url, email: email || undefined, enabled: true, interrupted: false, apiVersion: 3, authToken: c.token, sendType: 'SEQUENTIALLY',
    events: ['PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE', 'PAYMENT_DELETED', 'PAYMENT_REFUNDED', 'PAYMENT_RECEIVED_IN_CASH_UNDONE'],
  });
  const cur = JSON.parse((await getSetting('gateway_cfg')) || '{}');
  await setSetting('gateway_cfg', JSON.stringify({ ...cur, webhookAt: new Date().toISOString() }));
  return url;
}

// Quem paga: o responsável financeiro (se houver) ou o próprio paciente
function payerOf(p) {
  let cpf = ''; try { cpf = (p.payer_cpf_enc ? decrypt(p.payer_cpf_enc) : '') || (p.cpf_enc ? decrypt(p.cpf_enc) : ''); } catch { /* ilegível */ }
  return { name: (p.payer_name && p.payer_cpf_enc ? p.payer_name : p.name), cpf: String(cpf).replace(/\D/g, ''), phone: String(p.phone || p.responsible_phone || '').replace(/\D/g, ''), email: p.email || '' };
}
async function customerFor(c, p) {
  const who = payerOf(p);
  if (!(who.cpf.length === 11 || who.cpf.length === 14)) { const e = new Error('Cadastre o CPF do paciente (ou do responsável financeiro) para gerar boleto/Pix pelo Asaas.'); e.needCpf = true; throw e; }
  const tag = `${c.env}:`;
  if (p.gw_customer && p.gw_customer.startsWith(tag)) return p.gw_customer.slice(tag.length);
  const found = await api(c, 'GET', `/customers?cpfCnpj=${who.cpf}`);
  let id = found?.data?.[0]?.id;
  if (!id) {
    const d = await api(c, 'POST', '/customers', { name: who.name, cpfCnpj: who.cpf, mobilePhone: who.phone.slice(-11) || undefined, email: who.email || undefined, externalReference: `pac:${p.id}`, notificationDisabled: !c.gatewayEmails });
    id = d.id;
  }
  await q('UPDATE patients SET gw_customer = ? WHERE id = ?', [`${tag}${id}`, p.id]);
  return id;
}

// ---------- cobranças ----------
export const chargeOf = (paymentId) => one(`SELECT * FROM gw_charges WHERE payment_id = ? AND status IN (${ACTIVE.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 1`, [paymentId, ...ACTIVE]);
export const historyOf = (paymentId) => q('SELECT * FROM gw_charges WHERE payment_id = ? ORDER BY id DESC LIMIT 10', [paymentId]);
export const eligible = (x) => x && !x.paid_at && x.receiver !== 'profissional' && Number(x.amount) > 0;

// Cria (ou reaproveita) a cobrança online de um recebimento em aberto
export async function ensureCharge(paymentId, { userId = null } = {}) {
  const c = await config();
  if (!ready(c)) return { ok: false, error: 'Cobrança online desligada.' };
  const x = await one('SELECT * FROM payments WHERE id = ?', [paymentId]);
  if (!x) return { ok: false, error: 'Lançamento não encontrado.' };
  if (x.paid_at) return { ok: false, error: 'Este lançamento já está pago.' };
  if (x.receiver === 'profissional') return { ok: false, error: 'Recebimento direto do profissional: a cobrança online é só para valores da clínica.' };
  if (x.origin === 'convenio') return { ok: false, error: 'Valor a receber do convênio: não é cobrado do paciente.' };
  const cur = await chargeOf(x.id);
  if (cur && Number(cur.amount) === Number(x.amount) && String(cur.due_date).slice(0, 10) === String(x.due_date).slice(0, 10)) return { ok: true, charge: cur, reused: true };
  if (cur) await cancelCharge(cur, 'valor ou vencimento alterado');
  const p = await one('SELECT * FROM patients WHERE id = ?', [x.patient_id]);
  if (c.provider === 'mercadopago') return mpCharge(c, x, p, userId);
  try {
    const customer = await customerFor(c, p);
    const due = String(x.due_date).slice(0, 10) < todayLocal() ? todayLocal() : String(x.due_date).slice(0, 10);
    const d = await api(c, 'POST', '/payments', {
      customer, billingType: c.billing, value: Number(x.amount), dueDate: due, description: String(x.description).slice(0, 500), externalReference: `pay:${x.id}`,
      ...(c.fine ? { fine: { value: c.fine } } : {}), ...(c.interest ? { interest: { value: c.interest } } : {}),
    });
    await q('INSERT INTO gw_charges (payment_id, provider, env, gw_id, customer_id, amount, due_date, status, billing_type, invoice_url, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [x.id, 'asaas', c.env, d.id, customer, x.amount, due, d.status || 'PENDING', d.billingType || c.billing, d.invoiceUrl || null, userId]);
    await Fin.logPay(x, 'lembrete', userId, `Cobrança online criada no Asaas (${BILLING[c.billing]})`);
    Live.emit('financeiro');
    return { ok: true, charge: await chargeOf(x.id), created: true };
  } catch (e) {
    return { ok: false, error: e.message, needCpf: !!e.needCpf };
  }
}
// Mercado Pago: “preferência” (link com Pix, cartão e boleto). O Pix com QR é gerado na hora (pixOf).
async function mpCharge(c, x, p, userId) {
  try {
    const who = payerOf(p);
    const due = String(x.due_date).slice(0, 10) < todayLocal() ? todayLocal() : String(x.due_date).slice(0, 10);
    const ex = mpExclude(c.billing);
    const d = await mp(c, 'POST', '/checkout/preferences', {
      items: [{ id: `pay-${x.id}`, title: String(x.description).slice(0, 250), quantity: 1, unit_price: Number(x.amount), currency_id: 'BRL' }],
      external_reference: `pay:${x.id}`, notification_url: mpNotifyUrl(c), statement_descriptor: 'CONSULTORIO',
      payer: { name: who.name, ...(who.email ? { email: who.email } : {}), ...(who.cpf.length === 11 || who.cpf.length === 14 ? { identification: { type: who.cpf.length === 11 ? 'CPF' : 'CNPJ', number: who.cpf } } : {}) },
      ...(ex.length ? { payment_methods: { excluded_payment_types: ex.map((id) => ({ id })) } } : {}),
    });
    const url = c.env === 'sandbox' ? d.sandbox_init_point || d.init_point : d.init_point;
    await q('INSERT INTO gw_charges (payment_id, provider, env, gw_id, amount, due_date, status, billing_type, invoice_url, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [x.id, 'mercadopago', c.env, d.id, x.amount, due, 'PENDING', c.billing, url || null, userId]);
    await Fin.logPay(x, 'lembrete', userId, `Cobrança online criada no Mercado Pago (${BILLING[c.billing]})`);
    Live.emit('financeiro');
    return { ok: true, charge: await chargeOf(x.id), created: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
// Pix da cobrança (QR em imagem + copia e cola) — dá baixa automática ao pagar
export async function pixOf(charge) {
  const c = await config();
  if (charge.provider === 'mercadopago') {
    if (charge.pix_id) {
      const cur = await mp(c, 'GET', `/v1/payments/${charge.pix_id}`).catch(() => null);
      const td = cur?.point_of_interaction?.transaction_data;
      if (cur && cur.status === 'pending' && td?.qr_code) return { image: td.qr_code_base64 ? `data:image/png;base64,${td.qr_code_base64}` : null, payload: td.qr_code, expires: cur.date_of_expiration || null };
    }
    const x = await one('SELECT * FROM payments WHERE id = ?', [charge.payment_id]);
    const p = x ? await one('SELECT * FROM patients WHERE id = ?', [x.patient_id]) : null;
    if (!x || !p) throw new Error('Lançamento não encontrado.');
    const who = payerOf(p); const clinic = await Fin.clinic();
    const [first, ...rest] = String(who.name || 'Paciente').split(' ');
    const d = await mp(c, 'POST', '/v1/payments', {
      transaction_amount: Number(charge.amount), description: String(x.description).slice(0, 250), payment_method_id: 'pix', external_reference: `pay:${x.id}`,
      notification_url: mpNotifyUrl(c), date_of_expiration: `${String(charge.due_date).slice(0, 10) < todayLocal() ? todayLocal() : String(charge.due_date).slice(0, 10)}T23:59:59.000-03:00`,
      payer: { email: who.email || clinic.email, first_name: first, last_name: rest.join(' ') || first, ...(who.cpf.length === 11 ? { identification: { type: 'CPF', number: who.cpf } } : {}) },
    });
    await q('UPDATE gw_charges SET pix_id = ? WHERE id = ?', [String(d.id), charge.id]);
    const td = d.point_of_interaction?.transaction_data || {};
    return { image: td.qr_code_base64 ? `data:image/png;base64,${td.qr_code_base64}` : null, payload: td.qr_code || '', expires: d.date_of_expiration || null };
  }
  const d = await api(c, 'GET', `/payments/${charge.gw_id}/pixQrCode`);
  return { image: d.encodedImage ? `data:image/png;base64,${d.encodedImage}` : null, payload: d.payload || '', expires: d.expirationDate || null };
}
export async function cancelCharge(charge, reason = '') {
  const c = await config();
  try {
    if (charge.provider === 'mercadopago') {
      if (c.mpKey) {
        await mp(c, 'PUT', `/checkout/preferences/${charge.gw_id}`, { expires: true, expiration_date_to: new Date().toISOString() });
        if (charge.pix_id) await mp(c, 'PUT', `/v1/payments/${charge.pix_id}`, { status: 'cancelled' }).catch(() => {});
      }
    } else if (c.key) await api(c, 'DELETE', `/payments/${charge.gw_id}`);
  } catch (e) { if (e.status !== 404) { await q('UPDATE gw_charges SET error = ? WHERE id = ?', [String(e.message).slice(0, 250), charge.id]); return false; } }
  await q("UPDATE gw_charges SET status = 'CANCELLED', error = ? WHERE id = ?", [reason ? `cancelada: ${reason}`.slice(0, 250) : null, charge.id]);
  return true;
}

// ---------- webhook (o Asaas avisa pagamento, vencimento, estorno…) ----------
export function validToken(c, given) {
  const a = Buffer.from(String(c.token || '')); const b = Buffer.from(String(given || ''));
  return a.length > 10 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
export async function handleEvent(ev) {
  const pm = ev?.payment;
  if (!pm?.id) return { ignored: true };
  let ch = await one('SELECT * FROM gw_charges WHERE gw_id = ?', [pm.id]);
  if (!ch) {
    const ref = /^pay:(\d+)$/.exec(String(pm.externalReference || ''));
    if (!ref) return { ignored: true };
    await q('INSERT IGNORE INTO gw_charges (payment_id, provider, env, gw_id, customer_id, amount, due_date, status, billing_type, invoice_url) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [Number(ref[1]), 'asaas', (await config()).env, pm.id, pm.customer || null, pm.value || 0, pm.dueDate || todayLocal(), pm.status || 'PENDING', pm.billingType || null, pm.invoiceUrl || null]);
    ch = await one('SELECT * FROM gw_charges WHERE gw_id = ?', [pm.id]);
  }
  const status = String(pm.status || '').toUpperCase() || ch.status;
  const paid = ['PAYMENT_RECEIVED', 'PAYMENT_CONFIRMED'].includes(ev.event) || PAID.includes(status);
  return settle(ch, { status: paid && !PAID.includes(status) ? 'RECEIVED' : status, billing: String(pm.billingType || '').toUpperCase() || null, net: pm.netValue ?? null,
    paidDate: pm.paymentDate || pm.clientPaymentDate || pm.confirmedDate || null, value: pm.value, refunded: status === 'REFUNDED' || ev.event === 'PAYMENT_REFUNDED', ref: pm.id });
}

// Mercado Pago: o aviso traz só o número do pagamento; os dados vêm de uma consulta ao próprio Mercado Pago
export async function handleMercadoPago(paymentId) {
  const c = await config();
  if (!c.mpKey || !/^\d{3,20}$/.test(String(paymentId || ''))) return { ignored: true };
  const pm = await mp(c, 'GET', `/v1/payments/${paymentId}`);
  const ref = /^pay:(\d+)$/.exec(String(pm.external_reference || ''));
  if (!ref) return { ignored: true };
  const ch = await one("SELECT * FROM gw_charges WHERE provider = 'mercadopago' AND payment_id = ? ORDER BY (pix_id = ?) DESC, (status IN ('PENDING','OVERDUE')) DESC, id DESC LIMIT 1", [Number(ref[1]), String(pm.id)]);
  if (!ch) return { ignored: true };
  const st = String(pm.status || '');
  const status = st === 'approved' ? 'RECEIVED' : ['refunded', 'charged_back'].includes(st) ? 'REFUNDED' : ch.status; // pendente/recusado: a cobrança continua aberta
  return settle(ch, { status, billing: MP_BILLING[pm.payment_type_id] || (pm.payment_method_id === 'pix' ? 'PIX' : null), net: pm.transaction_details?.net_received_amount ?? null,
    paidDate: pm.date_approved ? String(pm.date_approved).slice(0, 10) : null, value: pm.transaction_amount, refunded: status === 'REFUNDED', ref: String(pm.id), method: MP_METHOD[pm.payment_type_id] || (pm.payment_method_id === 'pix' ? 'pix' : null) });
}
// Assinatura do aviso do Mercado Pago (x-signature), quando a clínica cadastrou a “assinatura secreta”
export function validMpSignature(c, { signature, requestId, dataId }) {
  if (!c.mpSecret) return true;
  const parts = Object.fromEntries(String(signature || '').split(',').map((kv) => kv.trim().split('=')));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${String(dataId || '').toLowerCase()};request-id:${requestId || ''};ts:${parts.ts};`;
  const h = crypto.createHmac('sha256', c.mpSecret).update(manifest).digest('hex');
  return h.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(parts.v1));
}

// Comum aos dois serviços: atualiza a cobrança e, se paga, dá baixa no lançamento (uma vez só)
async function settle(ch, { status, billing, net, paidDate, value, refunded, ref, method }) {
  const was = ch.status; // para reconhecer aviso repetido do mesmo pagamento
  await q('UPDATE gw_charges SET status = ?, billing_type = COALESCE(?, billing_type), net_value = COALESCE(?, net_value), paid_date = COALESCE(?, paid_date) WHERE id = ?',
    [status, billing || null, net ?? null, paidDate || null, ch.id]);
  const svc = providerLabel(ch.provider);
  const x = ch.payment_id ? await one('SELECT x.*, p.owner_id, p.name, p.social_name FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ?', [ch.payment_id]) : null;
  const who = x ? String(x.social_name || x.name).split(' ')[0] : 'paciente';
  if (PAID.includes(status)) {
    if (!x) { notifyStaff(null, `⚠ Pagamento recebido no ${svc} sem lançamento`, `Cobrança ${ref} — confira no Financeiro.`); return { orphan: true }; }
    if (x.paid_at) {
      if (PAID.includes(was)) return { repeated: true }; // o serviço reenviou o mesmo aviso
      if (!ch.dup_alert) { await q('UPDATE gw_charges SET dup_alert = 1 WHERE id = ?', [ch.id]); notifyStaff(x, '⚠ Possível pagamento em dobro', `${who} pagou pelo ${svc} um lançamento que já estava pago. Confira e, se for o caso, estorne no ${svc}.`); }
      return { already: true };
    }
    const out = await Fin.receive(x.id, { method: method || METHOD_OF[String(billing || '').toUpperCase()] || 'pix', paidAt: String(paidDate || todayLocal()).slice(0, 10), userId: null, detail: `Baixa automática pelo ${svc} (${String(billing || '').toLowerCase().replace('credit_card', 'cartão') || 'online'})` });
    if (out.ok) {
      notifyStaff(x, '💰 Pagamento recebido', `${who} pagou ${Number(value || x.amount).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} pelo ${svc} (${x.description}).`);
      Live.emit('financeiro');
      const c = await config();
      if (c.confirmWhatsApp) { try { const WA = await import('./whatsapp.js'); await WA.sendPayment(x.id, null); } catch (e) { console.error('confirmação de pagamento:', e.message); } }
    }
    return { paid: out.ok };
  }
  if (refunded && was !== 'REFUNDED') notifyStaff(x, `↩ Pagamento estornado no ${svc}`, `${who}: ${x?.description || ref}. O lançamento continua como pago; ajuste no Financeiro se for o caso.`);
  Live.emit('financeiro');
  return { status };
}
async function notifyStaff(x, title, body) {
  const fin = await q("SELECT id FROM users WHERE active = 1 AND role IN ('admin','financeiro')");
  notify([...new Set([...(x?.owner_id ? [x.owner_id] : []), ...fin.map((u) => u.id)])], { title, body, url: x ? `/financeiro/${x.id}` : '/financeiro/receber', tag: x ? `gw-${x.id}` : 'gw' });
}

// ---------- rotina: conferência e geração automática ----------
export async function tick() {
  const c = await config();
  if (!c.key && !c.mpKey) return;
  // cobranças ativas cujo lançamento sumiu, foi pago de outro jeito, virou recebimento do profissional ou mudou de valor/vencimento
  const stale = await q(`SELECT g.*, x.id pid, x.paid_at, x.receiver, x.amount pamount, x.due_date pdue FROM gw_charges g LEFT JOIN payments x ON x.id = g.payment_id
    WHERE g.status IN (${ACTIVE.map(() => '?').join(',')}) AND g.env = ?`, [...ACTIVE, c.env]);
  for (const g of stale) {
    if (!g.pid) await cancelCharge(g, 'lançamento excluído');
    else if (g.paid_at) await cancelCharge(g, 'pago por outro meio');
    else if (g.receiver === 'profissional') await cancelCharge(g, 'passou a ser recebimento do profissional');
    else if (Number(g.amount) !== Number(g.pamount)) await cancelCharge(g, 'valor alterado');
  }
  // geração automática X dias antes do vencimento
  if (c.enabled && c.autoDays > 0) {
    const due = addDays(todayLocal(), c.autoDays);
    const rows = await q(`SELECT x.id FROM payments x WHERE x.paid_at IS NULL AND x.receiver = 'clinica' AND x.origin <> 'convenio' AND x.amount > 0 AND x.due_date <= ? AND x.due_date >= DATE_SUB(CURDATE(), INTERVAL 60 DAY)
      AND NOT EXISTS (SELECT 1 FROM gw_charges g WHERE g.payment_id = x.id AND (g.status IN (${ACTIVE.map(() => '?').join(',')}) OR g.created_at > DATE_SUB(NOW(), INTERVAL 1 DAY))) LIMIT 50`, [due, ...ACTIVE]);
    for (const r of rows) await ensureCharge(r.id).catch(() => {});
  }
}
export async function stats() {
  return one(`SELECT SUM(status IN ('PENDING','OVERDUE')) open, SUM(status IN ('RECEIVED','CONFIRMED') AND paid_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01')) paid_month,
    COALESCE(SUM(CASE WHEN status IN ('RECEIVED','CONFIRMED') AND paid_date >= DATE_FORMAT(CURDATE(), '%Y-%m-01') THEN amount END),0) paid_value FROM gw_charges`);
}
