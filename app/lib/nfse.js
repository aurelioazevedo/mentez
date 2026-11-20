// Nota fiscal de serviço (NFS-e) pelo Asaas, em nome de quem emite o recebimento:
// a clínica (CNPJ da clínica, uid = null) ou o(a) profissional que recebe direto e tem CNPJ próprio (uid = id do usuário).
// Fica pronta e desligada até haver CNPJ; com ela ligada, as notas saem sozinhas ao receber, em lote no mês ou uma a uma.
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import { q, one, getSetting, setSetting } from './db.js';
import { ISSUER_SQL } from './fin.js';
import { encrypt, decrypt } from './crypto.js';
import { nowLocal, todayLocal, monthName } from './time.js';
import * as Gateway from './gateway.js';
import * as WA from './whatsapp.js';
import * as Notify from './notify.js';
import * as Live from './live.js';

export const MODES = { auto: 'Automática: a cada pagamento recebido', lote: 'Em lote: eu escolho quando emitir as notas do mês', manual: 'Manual: uma a uma, no lançamento' };
export const REGIMES = { simples: 'Simples Nacional', mei: 'MEI', presumido: 'Lucro presumido', outro: 'Outro' };
export const STATUS = { pendente: 'Na fila', agendada: 'Enviada à prefeitura', emitida: 'Emitida', erro: 'Com erro', cancelando: 'Cancelando', cancelada: 'Cancelada' };
const MAP = { SCHEDULED: 'agendada', SYNCHRONIZED: 'agendada', AUTHORIZATION_PENDING: 'agendada', AUTHORIZED: 'emitida', PROCESSING_CANCELLATION: 'cancelando', CANCELED: 'cancelada', CANCELLATION_DENIED: 'emitida', ERROR: 'erro' };
const DEFAULTS = {
  enabled: false, keySource: 'cobranca', env: 'sandbox', cnpj: '', razao: '', im: '', regime: 'simples', city: '',
  serviceCode: '4.16', serviceName: 'Psicologia e psicanálise', municipalServiceId: '', cnae: '8650-0/03', issRate: 0, retainIss: false,
  mode: 'auto', description: 'Serviços de psicologia — atendimento psicológico ({data}).', observations: '', sendToPatient: true, startDate: '',
};
// uid = null: configuração da clínica; uid = id: configuração do CNPJ próprio do(a) profissional
export async function config(uid = null) {
  let c = {};
  try { c = JSON.parse((uid ? (await one('SELECT nfse_cfg FROM user_fiscal WHERE user_id = ?', [uid]))?.nfse_cfg : await getSetting('nfse_cfg')) || '{}'); } catch { /* padrão */ }
  const out = { ...DEFAULTS, ...c, uid: uid || null };
  if (uid) out.keySource = 'propria'; // o(a) profissional usa a conta do Asaas do próprio CNPJ
  try { out.ownKey = c.key_enc ? decrypt(c.key_enc) : ''; } catch { out.ownKey = ''; }
  delete out.key_enc;
  return out;
}
export const cnpjOk = (v) => {
  const d = String(v || '').replace(/\D/g, '');
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const calc = (n) => { let s = 0; let w = n - 7; for (let i = 0; i < n; i++) { s += Number(d[i]) * w--; if (w < 2) w = 9; } const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
};
// Conta do Asaas usada: a mesma da cobrança online ou uma chave própria (conta do CNPJ)
async function account(c) {
  if (c.keySource === 'propria') return { key: c.ownKey, env: c.env };
  const g = await Gateway.config();
  return { key: g.key, env: g.env };
}
export async function readiness(c = null) {
  c = c || await config();
  const acc = await account(c);
  const missing = [];
  if (!cnpjOk(c.cnpj)) missing.push(c.uid ? 'CNPJ' : 'CNPJ da clínica');
  if (!String(c.im).trim()) missing.push('inscrição municipal');
  if (!acc.key) missing.push(c.keySource === 'propria' ? 'chave da API do Asaas' : 'conta do Asaas na Cobrança online');
  if (!c.municipalServiceId && !c.serviceCode) missing.push('serviço municipal');
  return { ok: !missing.length, missing, acc };
}
export const ready = async (c = null) => { c = c || await config(); return c.enabled && (await readiness(c)).ok; };
export async function saveConfig(b, cur, uid = null) {
  const key = String(b.ownKey || '').trim();
  const next = {
    ...cur, enabled: !!b.enabled, keySource: uid || b.keySource === 'propria' ? 'propria' : 'cobranca', env: b.env === 'producao' ? 'producao' : 'sandbox',
    cnpj: String(b.cnpj || '').replace(/\D/g, '').slice(0, 14), razao: String(b.razao || '').trim().slice(0, 160), im: String(b.im || '').trim().slice(0, 30),
    regime: REGIMES[b.regime] ? b.regime : 'simples', city: String(b.city || Brand.get().city || '').trim().slice(0, 60),
    serviceCode: String(b.serviceCode || '').trim().slice(0, 20), serviceName: String(b.serviceName || '').trim().slice(0, 160), municipalServiceId: String(b.municipalServiceId || '').trim().slice(0, 40),
    cnae: String(b.cnae || '').trim().slice(0, 12), issRate: Math.min(5, Math.max(0, Number(String(b.issRate || 0).replace(',', '.')) || 0)), retainIss: !!b.retainIss,
    mode: MODES[b.mode] ? b.mode : 'auto', description: String(b.description || '').trim().slice(0, 500) || DEFAULTS.description, observations: String(b.observations || '').trim().slice(0, 500),
    sendToPatient: !!b.sendToPatient, startDate: cur.startDate || (b.enabled ? todayLocal() : ''),
  };
  if (b.enabled && !cur.enabled) next.startDate = todayLocal(); // notas automáticas só para pagamentos a partir de hoje
  delete next.ownKey; delete next.uid;
  next.key_enc = key ? encrypt(key) : cur.ownKey ? encrypt(cur.ownKey) : null;
  if (uid) await q("INSERT INTO user_fiscal (user_id, kind, nfse_cfg) VALUES (?, 'pj', ?) ON DUPLICATE KEY UPDATE nfse_cfg = VALUES(nfse_cfg)", [uid, JSON.stringify(next)]);
  else await setSetting('nfse_cfg', JSON.stringify(next));
  return next;
}

// ---------- API do Asaas ----------
const baseOf = (env) => process.env.ASAAS_BASE_URL || (env === 'producao' ? 'https://api.asaas.com/v3' : 'https://api-sandbox.asaas.com/v3');
async function api(acc, method, path, body) {
  const r = await fetch(`${baseOf(acc.env)}${path}`, { method, signal: AbortSignal.timeout(25000), headers: { access_token: acc.key, 'Content-Type': 'application/json', 'User-Agent': 'SistemaConsultorio/1.0' }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d?.errors?.[0]?.description || d?.message || `Asaas respondeu ${r.status}`); e.status = r.status; throw e; }
  return d;
}
export async function testConnection(c) {
  const { acc } = await readiness(c);
  if (!acc.key) throw new Error('Informe a conta do Asaas.');
  const me = await api(acc, 'GET', '/myAccount');
  return { name: me.companyName || me.name || 'conta Asaas', cnpj: String(me.cpfCnpj || '').replace(/\D/g, '') };
}
export async function searchServices(c, term) {
  const { acc } = await readiness(c);
  if (!acc.key) throw new Error('Informe a conta do Asaas antes de buscar o serviço.');
  const d = await api(acc, 'GET', `/invoices/municipalServices?description=${encodeURIComponent(term || 'psicolog')}`);
  return (d.data || []).map((s) => ({ id: String(s.id), code: s.code || '', description: s.description || '', iss: s.issTax ?? null }));
}
async function customerOf(acc, p) {
  let cpf = ''; try { cpf = (p.payer_cpf_enc ? decrypt(p.payer_cpf_enc) : '') || (p.cpf_enc ? decrypt(p.cpf_enc) : ''); } catch { /* ilegível */ }
  cpf = String(cpf).replace(/\D/g, '');
  if (!(cpf.length === 11 || cpf.length === 14)) { const e = new Error('Falta o CPF do paciente (ou do responsável financeiro) na ficha.'); e.needCpf = true; throw e; }
  const name = p.payer_name && p.payer_cpf_enc ? p.payer_name : p.name;
  const found = await api(acc, 'GET', `/customers?cpfCnpj=${cpf}`);
  if (found?.data?.[0]?.id) return found.data[0].id;
  const d = await api(acc, 'POST', '/customers', { name, cpfCnpj: cpf, email: p.email || undefined, externalReference: `pac:${p.id}`, notificationDisabled: true });
  return d.id;
}

// ---------- fila de notas ----------
const ISSUER = ISSUER_SQL;
const PAY_SQL = `SELECT x.*, p.name, p.social_name, p.cpf_enc, p.payer_name, p.payer_cpf_enc, p.email, p.phone, p.whatsapp_optin, p.email_optin, ${ISSUER} issuer_eff,
    (COALESCE(p.cpf_enc, '') <> '' OR COALESCE(p.payer_cpf_enc, '') <> '') has_doc
  FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN fin_rules r ON r.user_id = x.professional_id`;
export const noteOf = (paymentId) => one("SELECT * FROM nfse WHERE payment_id = ? AND status <> 'cancelada' ORDER BY id DESC LIMIT 1", [paymentId]);
export const historyOf = (paymentId) => q('SELECT * FROM nfse WHERE payment_id = ? ORDER BY id DESC LIMIT 10', [paymentId]);
export async function eligible(paymentId) {
  const x = await one(`${PAY_SQL} WHERE x.id = ?`, [paymentId]);
  if (!x) return { ok: false, error: 'Lançamento não encontrado.' };
  if (!x.paid_at) return { ok: false, error: 'A nota é emitida depois do pagamento.' };
  let uid = null;
  if (x.issuer_eff !== 'clinica') {
    // recebimento do(a) profissional: nota só se ele(a) tiver CNPJ próprio configurado; senão é recibo de pessoa física
    const kind = x.professional_id ? (await one('SELECT kind FROM user_fiscal WHERE user_id = ?', [x.professional_id]))?.kind : null;
    if (kind !== 'pj') return { ok: false, error: 'Este recebimento é do(a) profissional como pessoa física: o recibo é lançado por ele(a) no Receita Saúde.' };
    uid = x.professional_id;
  }
  if (!(Number(x.amount) > 0)) return { ok: false, error: 'Valor zerado.' };
  if (x.origin === 'convenio') return { ok: false, error: 'Recebimento de convênio: a nota para a operadora entra no faturamento do convênio.' };
  if (await noteOf(x.id)) return { ok: false, error: 'Este recebimento já tem nota.' };
  return { ok: true, x, uid };
}
// uid de quem emite a nota deste recebimento (null = clínica); undefined se não cabe nota
export async function issuerUserOf(paymentId) { const e = await eligible(paymentId); return e.ok ? e.uid : undefined; }
export async function queue(paymentId, userId = null, onlyUid) {
  const e = await eligible(paymentId);
  if (!e.ok) return e;
  if (onlyUid !== undefined && e.uid !== onlyUid) return { ok: false, error: e.uid ? 'A nota deste recebimento é emitida pelo(a) profissional, com o CNPJ dele(a).' : 'A nota deste recebimento é da clínica.' };
  const r = await q("INSERT INTO nfse (payment_id, patient_id, value, status, created_by, issuer_user_id) VALUES (?,?,?, 'pendente', ?, ?)", [e.x.id, e.x.patient_id, e.x.amount, userId, e.uid]);
  Live.emit('financeiro');
  return { ok: true, id: r.insertId };
}
const fill = (tpl, x) => String(tpl).replace(/\{data\}/g, String(x.paid_at).slice(0, 10).split('-').reverse().join('/')).replace(/\{mes\}/g, monthName(String(x.paid_at).slice(0, 7))).replace(/\{sessoes\}/g, String(x.sessions || 1));
export async function emit(id) {
  const n = await one('SELECT * FROM nfse WHERE id = ?', [id]);
  if (!n || !['pendente', 'erro'].includes(n.status)) return { ok: false, error: 'Esta nota não está na fila.' };
  const c = await config(n.issuer_user_id); const rd = await readiness(c);
  if (!c.enabled || !rd.ok) return { ok: false, error: `A nota fiscal ainda não está configurada (falta: ${rd.missing.join(', ') || 'ligar o módulo'}).` };
  const x = await one(`${PAY_SQL} WHERE x.id = ?`, [n.payment_id]);
  try {
    const customer = await customerOf(rd.acc, x);
    // nota anterior que deu erro (ou foi cancelada) na prefeitura: tenta com uma nota nova
    let prev = n.ext_id ? await api(rd.acc, 'GET', `/invoices/${encodeURIComponent(n.ext_id)}`).catch(() => null) : null;
    if (prev && ['ERROR', 'CANCELED'].includes(prev.status)) prev = null;
    const inv = prev || await api(rd.acc, 'POST', '/invoices', {
      customer, serviceDescription: fill(c.description, x), observations: c.observations || undefined, value: Number(x.amount), deductions: 0,
      effectiveDate: todayLocal(), externalReference: `nf:${n.id}`,
      municipalServiceId: c.municipalServiceId || undefined, municipalServiceCode: c.municipalServiceId ? undefined : c.serviceCode, municipalServiceName: c.serviceName,
      taxes: { retainIss: !!c.retainIss, iss: Number(c.issRate) || 0, cofins: 0, csll: 0, inss: 0, ir: 0, pis: 0 },
    });
    let st = inv.status;
    if (st === 'SCHEDULED') { const a = await api(rd.acc, 'POST', `/invoices/${encodeURIComponent(inv.id)}/authorize`); st = a.status || st; }
    await q('UPDATE nfse SET ext_id = ?, env = ?, status = ?, error = ?, sent_at = COALESCE(sent_at, NOW()), description = ? WHERE id = ?', [inv.id, rd.acc.env, MAP[st] || 'agendada', MAP[st] === 'erro' ? String(inv.statusDescription || 'Erro na prefeitura').slice(0, 255) : null, fill(c.description, x).slice(0, 500), n.id]);
    Live.emit('financeiro');
    return { ok: true };
  } catch (e) {
    await q("UPDATE nfse SET status = 'erro', error = ? WHERE id = ?", [String(e.message).slice(0, 255), n.id]);
    Live.emit('financeiro');
    return { ok: false, error: e.message };
  }
}
export async function refresh(id) {
  const n = await one('SELECT * FROM nfse WHERE id = ?', [id]);
  if (!n?.ext_id) return { ok: false };
  const c = await config(n.issuer_user_id); const { acc } = await readiness(c);
  try {
    const inv = await api({ ...acc, env: n.env || acc.env }, 'GET', `/invoices/${encodeURIComponent(n.ext_id)}`);
    const st = MAP[inv.status] || n.status;
    const denied = inv.status === 'CANCELLATION_DENIED';
    await q(`UPDATE nfse SET status = ?, number = COALESCE(?, number), pdf_url = COALESCE(?, pdf_url), xml_url = COALESCE(?, xml_url), error = ?,
        issued_at = IF(? = 'emitida' AND issued_at IS NULL, NOW(), issued_at), canceled_at = IF(? = 'cancelada' AND canceled_at IS NULL, NOW(), canceled_at) WHERE id = ?`,
      [st, inv.number || null, inv.pdfUrl || null, inv.xmlUrl || null, st === 'erro' ? String(inv.statusDescription || 'Erro na prefeitura').slice(0, 255) : denied ? 'Cancelamento negado pela prefeitura' : null, st, st, n.id]);
    if (st === 'emitida' && n.status !== 'emitida' && c.sendToPatient) await sendToPatient(n.id).catch(() => {});
    if (st !== n.status) Live.emit('financeiro');
    return { ok: true, status: st };
  } catch (e) { return { ok: false, error: e.message }; }
}
export async function cancel(id, userId = null) {
  const n = await one('SELECT * FROM nfse WHERE id = ?', [id]);
  if (!n) return { ok: false, error: 'Nota não encontrada.' };
  if (n.status === 'pendente' || (n.status === 'erro' && !n.ext_id)) { await q("UPDATE nfse SET status = 'cancelada', canceled_at = NOW(), canceled_by = ? WHERE id = ?", [userId, n.id]); Live.emit('financeiro'); return { ok: true }; }
  if (n.status !== 'emitida' && n.status !== 'agendada') return { ok: false, error: 'Esta nota não pode ser cancelada agora.' };
  const { acc } = await readiness(await config(n.issuer_user_id));
  try {
    const r = await api({ ...acc, env: n.env || acc.env }, 'POST', `/invoices/${encodeURIComponent(n.ext_id)}/cancel`);
    await q('UPDATE nfse SET status = ?, canceled_by = ? WHERE id = ?', [MAP[r.status] || 'cancelando', userId, n.id]);
    Live.emit('financeiro');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
}
export async function sendToPatient(id) {
  const n = await one('SELECT * FROM nfse WHERE id = ?', [id]);
  if (!n || n.status !== 'emitida' || !n.pdf_url) return { ok: false, error: 'A nota ainda não foi emitida.' };
  const p = await one('SELECT id, name, social_name, phone, email, whatsapp_optin, email_optin FROM patients WHERE id = ?', [n.patient_id]);
  const text = `Olá, ${WA.firstName(p)}! A nota fiscal${n.number ? ` nº ${n.number}` : ''} do seu atendimento (R$ ${Number(n.value).toFixed(2).replace('.', ',')}) está disponível: ${n.pdf_url}`;
  let r = { ok: false, error: 'O paciente não tem WhatsApp autorizado nem e-mail.' };
  if (p.whatsapp_optin && p.phone && WA.ready(await WA.config())) r = await WA.send({ phone: p.phone, text, kind: 'pagamento', patient_id: p.id });
  if (!r.ok && p.email && p.email_optin !== 0) {
    const nc = await Notify.config();
    if (Notify.emailReady(nc)) { try { await Notify.sendEmail(nc, { to: p.email, subject: `Nota fiscal${n.number ? ` nº ${n.number}` : ''} do seu atendimento`, text }); r = { ok: true }; } catch (e) { r = { ok: false, error: e.message }; } }
  }
  if (r.ok) await q('UPDATE nfse SET delivered_at = NOW() WHERE id = ?', [n.id]);
  return r;
}
// Recebimentos pagos no período, sem nota (para o lote): da clínica (uid null) ou do(a) profissional com CNPJ próprio
export async function withoutNote(from, to, uid = null) {
  const who = uid ? `${ISSUER} = 'profissional' AND x.professional_id = ?` : `${ISSUER} = 'clinica'`;
  return q(`${PAY_SQL} WHERE x.paid_at BETWEEN ? AND ? AND ${who} AND x.amount > 0 AND x.origin <> 'convenio'
    AND NOT EXISTS (SELECT 1 FROM nfse n WHERE n.payment_id = x.id AND n.status <> 'cancelada') ORDER BY x.paid_at, x.id`, uid ? [from, to, uid] : [from, to]);
}
export async function list(from, to, uid = null) {
  return q(`SELECT n.*, p.name, p.social_name, x.paid_at, x.description pay_desc FROM nfse n JOIN payments x ON x.id = n.payment_id JOIN patients p ON p.id = n.patient_id
    WHERE x.paid_at BETWEEN ? AND ? AND n.issuer_user_id <=> ? ORDER BY x.paid_at DESC, n.id DESC`, [from, to, uid || null]);
}

export function hasCpf(x) {
  try { const v = (x.payer_cpf_enc ? decrypt(x.payer_cpf_enc) : '') || (x.cpf_enc ? decrypt(x.cpf_enc) : ''); return [11, 14].includes(String(v).replace(/\D/g, '').length); } catch { return false; }
}
// ---------- rotina ----------
const RUNNING = Tenancy.scoped({ on: false }); // trava por clínica
export async function tick() {
  if (RUNNING.on) return { skipped: true };
  RUNNING.on = true;
  const out = { queued: 0, emitted: 0, refreshed: 0 };
  try {
    // clínica e cada profissional com CNPJ próprio: cada um com a sua configuração e a sua conta do Asaas
    const pjs = (await q("SELECT user_id FROM user_fiscal WHERE kind = 'pj' AND nfse_cfg IS NOT NULL")).map((r) => r.user_id);
    for (const uid of [null, ...pjs]) {
      const c = await config(uid);
      if (!c.enabled || c.mode !== 'auto' || !c.startDate || !(await readiness(c)).ok) continue;
      // sem CPF na ficha não entra sozinho: fica em “sem nota”, com o aviso para completar a ficha
      for (const x of (await withoutNote(c.startDate, todayLocal(), uid)).filter((y) => hasCpf(y)).slice(0, 30)) { const r = await queue(x.id, null, uid); if (r.ok) out.queued++; }
    }
    for (const n of await q("SELECT id FROM nfse WHERE status = 'pendente' ORDER BY id LIMIT 20")) { const r = await emit(n.id); if (r.ok) out.emitted++; }
    for (const n of await q("SELECT id FROM nfse WHERE status IN ('agendada','cancelando') AND ext_id IS NOT NULL ORDER BY id LIMIT 40")) { await refresh(n.id); out.refreshed++; }
    return out;
  } catch (e) { console.error('NFS-e', e.message); return { ...out, error: e.message }; } finally { RUNNING.on = false; }
}
export async function stats(from, to, uid = null) {
  return one(`SELECT SUM(n.status = 'emitida') emitidas, COALESCE(SUM(IF(n.status = 'emitida', n.value, 0)),0) valor, SUM(n.status IN ('pendente','agendada')) andamento, SUM(n.status = 'erro') erros
    FROM nfse n JOIN payments x ON x.id = n.payment_id WHERE x.paid_at BETWEEN ? AND ? AND n.issuer_user_id <=> ?`, [from, to, uid || null]);
}
export const now = nowLocal;
