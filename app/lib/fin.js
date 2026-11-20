// Financeiro: repasse por profissional, quem recebeu, pacotes, contas a pagar/receber e acerto mensal.
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { todayLocal, addDays, addMonths } from './time.js';
import { brcode, normalizeKey, KEY_TYPES } from './pix.js';

export const METHODS = ['pix', 'dinheiro', 'cartao', 'transferencia', 'boleto', 'outro'];
export const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const pad = (n) => String(n).padStart(2, '0');
const lastDay = (ym) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();

// ---------- dados da clínica (para recibos emitidos pela clínica) ----------
export async function clinic() {
  let c = {};
  try { c = JSON.parse((await getSetting('fin_clinic')) || '{}'); } catch { /* padrão */ }
  return { name: c.name || 'Consultório Lorrainy Mendes', doc: c.doc_enc ? decrypt(c.doc_enc) : '', address: c.address || '', city: c.city || 'Goiânia', phone: c.phone || '(62) 98445-4631', email: c.email || 'contato@lorrainymendes.com.br', pix_type: c.pix_type || null, pix_key: c.pix_key || '' };
}
export async function saveClinic({ name, doc, address, city, phone, email, pix_type, pix_key }) {
  await setSetting('fin_clinic', JSON.stringify({ name, doc_enc: doc ? encrypt(doc) : null, address, city, phone, email, pix_type: pix_type || null, pix_key: pix_key || '' }));
}

// Quem emite o documento fiscal do recebimento: se o paciente pagou direto ao(à) profissional, é sempre ele(a)
// (recibo no Receita Saúde ou nota com o CNPJ dele(a)); senão vale o escolhido no lançamento ou a regra do profissional.
export const ISSUER_SQL = "IF(x.receiver = 'profissional', 'profissional', COALESCE(x.issuer, r.receipt_by, 'clinica'))";
export const issuerOf = (x, rl) => (x.receiver === 'profissional' ? 'profissional' : x.issuer || rl?.receipt_by || 'clinica');

// ---------- política de faltas ----------
const POLICY0 = { noShow: false, noShowMode: 'integral', noShowValue: 100, noShowPackage: true };
export async function policy() {
  try { return { ...POLICY0, ...JSON.parse((await getSetting('fin_policy')) || '{}') }; } catch { return { ...POLICY0 }; }
}
export async function savePolicy(p) { await setSetting('fin_policy', JSON.stringify({ ...POLICY0, ...p })); }
export function noShowAmount(fee, pol) {
  if (pol.noShowMode === 'percent') return r2((Number(fee) * Number(pol.noShowValue)) / 100);
  if (pol.noShowMode === 'fixed') return r2(pol.noShowValue);
  return r2(fee);
}
export const policyText = (pol) => (!pol.noShow ? 'faltas não são cobradas' : `falta cobra ${pol.noShowMode === 'percent' ? `${String(pol.noShowValue).replace('.', ',')}% da sessão` : pol.noShowMode === 'fixed' ? brl(pol.noShowValue) : 'a sessão inteira'}${pol.noShowPackage ? ' (ou consome 1 sessão do pacote)' : ''}`);

// ---------- regra de repasse ----------
const RULE0 = { mode: 'none', value: 0, rent: 0, receipt_by: 'clinica', doc: '' };
export async function rule(userId) {
  const r = userId ? await one('SELECT * FROM fin_rules WHERE user_id = ?', [userId]) : null;
  if (!r) return { ...RULE0, user_id: userId, pix_type: null, pix_key: '' };
  return { user_id: userId, mode: r.mode, value: Number(r.value), rent: Number(r.rent), receipt_by: r.receipt_by, doc: r.doc_enc ? decrypt(r.doc_enc) : '', pix_type: r.pix_type || null, pix_key: r.pix_key || '' };
}
export async function saveRule(userId, { mode, value, rent, receipt_by, doc, pix_type, pix_key }) {
  await q(`INSERT INTO fin_rules (user_id, mode, value, rent, receipt_by, doc_enc, pix_type, pix_key) VALUES (?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE mode = VALUES(mode), value = VALUES(value), rent = VALUES(rent), receipt_by = VALUES(receipt_by), doc_enc = VALUES(doc_enc), pix_type = VALUES(pix_type), pix_key = VALUES(pix_key)`,
  [userId, mode, r2(value), r2(rent), receipt_by, doc ? encrypt(doc) : null, pix_type || null, pix_key || null]);
}

// Só a chave Pix (o(a) próprio(a) profissional cadastra; não mexe na regra de repasse).
export async function savePix(userId, pix_type, pix_key) {
  await q(`INSERT INTO fin_rules (user_id, mode, value, rent, receipt_by, pix_type, pix_key) VALUES (?, 'none', 0, 0, 'clinica', ?, ?)
    ON DUPLICATE KEY UPDATE pix_type = VALUES(pix_type), pix_key = VALUES(pix_key)`, [userId, pix_type || null, pix_key || null]);
}

// ---------- Pix: chave de quem recebe (clínica ou profissional) ----------
export async function pixFor(x) {
  const c = await clinic();
  let type; let key; let name;
  if (x.receiver === 'profissional' && x.professional_id) {
    const r = await rule(x.professional_id); const u = await one('SELECT name FROM users WHERE id = ?', [x.professional_id]);
    type = r.pix_type; key = r.pix_key; name = u?.name;
  } else { type = c.pix_type; key = c.pix_key; name = c.name; }
  const k = type ? normalizeKey(type, key) : null;
  if (!k) return null;
  return { code: brcode({ key: k, name, city: c.city, amount: x.amount, txid: `PAG${x.id}` }), key: k, keyType: KEY_TYPES[type], name };
}
export const ruleText = (r) => [
  r.mode === 'percent' ? `clínica fica com ${String(r.value).replace('.', ',')}% de cada recebimento` : r.mode === 'fixed' ? `clínica fica com ${brl(r.value)} por sessão` : 'sem participação por sessão',
  r.rent ? `aluguel de sala ${brl(r.rent)}/mês` : '',
].filter(Boolean).join(' · ');
export const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Parte da clínica num recebimento (fixo por sessão nunca passa do valor recebido).
export function clinicShare(amount, sessions, r) {
  if (!r || r.mode === 'none') return 0;
  if (r.mode === 'percent') return r2((Number(amount) * Number(r.value)) / 100);
  return r2(Math.min(Number(amount), Number(r.value) * Math.max(1, Number(sessions) || 1)));
}
// Grava a parte da clínica no momento do recebimento (mudar a regra depois não altera o passado).
export async function stampShare(paymentId) {
  const x = await one('SELECT id, amount, sessions, professional_id, paid_at FROM payments WHERE id = ?', [paymentId]);
  if (!x) return;
  if (!x.paid_at) { await q('UPDATE payments SET clinic_share = NULL WHERE id = ?', [x.id]); return; }
  const share = clinicShare(x.amount, x.sessions, await rule(x.professional_id));
  await q('UPDATE payments SET clinic_share = ? WHERE id = ?', [share, x.id]);
}

// ---------- pacotes ----------
export async function activePackage(patientId) {
  return one("SELECT * FROM fin_packages WHERE patient_id = ? AND status = 'ativo' AND sessions_used < sessions_total ORDER BY id LIMIT 1", [patientId]);
}
export async function createPackage({ patientId, sessions, amount, dueDate, userId }) {
  const p = await one('SELECT id, owner_id, pay_to FROM patients WHERE id = ?', [patientId]);
  const r = await rule(p.owner_id);
  const pay = await q('INSERT INTO payments (patient_id, description, amount, due_date, professional_id, receiver, issuer, sessions) VALUES (?,?,?,?,?,?,?,?)',
    [p.id, `Pacote de ${sessions} sessões de psicoterapia`, r2(amount), dueDate, p.owner_id, p.pay_to, r.receipt_by, sessions]);
  const pk = await q('INSERT INTO fin_packages (patient_id, professional_id, sessions_total, amount, payment_id, created_by) VALUES (?,?,?,?,?,?)',
    [p.id, p.owner_id, sessions, r2(amount), pay.insertId, userId || null]);
  await q('UPDATE payments SET package_id = ? WHERE id = ?', [pk.insertId, pay.insertId]);
  return { packageId: pk.insertId, paymentId: pay.insertId };
}

// Ao mudar a situação da sessão:
//  • realizada → consome 1 sessão do pacote ativo; sem pacote, cobra a sessão (valor da ficha);
//  • falta (se a política cobrar) → consome do pacote (se configurado) ou cobra a falta;
//  • qualquer outra mudança desfaz o que deixou de valer (devolve a sessão ao pacote e apaga a
//    cobrança automática ainda não paga nem acertada).
// ---------- histórico dos lançamentos de pacientes ----------
export const PAY_ACTIONS = { criado: 'Lançamento criado', recebido: 'Pagamento recebido', confirmado: 'Recebimento confirmado pelo profissional', direto: 'Pagamento direto ao profissional (aguardando confirmação)', reaberto: 'Pagamento desfeito (voltou a receber)', editado: 'Lançamento editado', lembrete: 'Lembrete de pagamento enviado', cancelado: 'Lançamento cancelado' };
export async function logPay(paymentOrId, action, userId = null, detail = null) {
  const x = typeof paymentOrId === 'object' ? paymentOrId : await one('SELECT * FROM payments WHERE id = ?', [paymentOrId]);
  if (!x) return;
  await q('INSERT INTO payment_events (payment_id, appointment_id, patient_id, professional_id, action, amount, detail, user_id) VALUES (?,?,?,?,?,?,?,?)',
    [x.id, x.appointment_id || null, x.patient_id || null, x.professional_id || null, action, x.amount ?? null, detail ? String(detail).slice(0, 255) : null, userId]);
}
export const paymentHistory = (paymentId) => q('SELECT e.*, u.name who FROM payment_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.payment_id = ? ORDER BY e.id', [paymentId]);
// Situação do pagamento: pago · aguardando confirmação do profissional · a receber
export const payState = (x) => (!x ? null : x.paid_at ? 'pago' : x.receiver === 'profissional' ? 'aguardando' : 'aberto');
export const PAY_STATE_LABEL = { pago: 'Pago', aguardando: 'Aguardando confirmação do profissional', aberto: 'A receber' };
// Registra o recebimento (um único lugar: evita duplicidade e grava quem/quando)
export async function receive(paymentId, { method, paidAt, receiver, userId, action = 'recebido', detail = null }) {
  const x = await one('SELECT * FROM payments WHERE id = ?', [paymentId]);
  if (!x) return { ok: false, error: 'Lançamento não encontrado.' };
  if (x.paid_at) return { ok: false, error: 'Este pagamento já foi registrado.', already: true };
  await q('UPDATE payments SET paid_at = ?, method = ?, receiver = COALESCE(?, receiver), received_by = ?, received_at = NOW() WHERE id = ? AND paid_at IS NULL',
    [paidAt, METHODS.includes(method) ? method : 'pix', receiver || null, userId, x.id]);
  await stampShare(x.id);
  await logPay(x.id, action, userId, detail || `${method ? `Forma: ${method}` : ''}`.trim() || null);
  return { ok: true };
}

export async function onAppointmentStatus(a, userId = null) {
  let appt = await one('SELECT id, patient_id, starts_at, status, package_id, plan_id, auth_id FROM appointments WHERE id = ?', [a.id]);
  if (!appt) return;
  // Sessão por convênio: autorização + conta a receber da operadora (+ coparticipação); falta segue a política abaixo
  if (appt.plan_id) {
    const Ins = await import('./insurance.js');
    appt.auth_id = await Ins.syncAppt(appt.id);
    if (await Ins.billAppt(appt, { logPay, userId })) return;
  }
  const pol = await policy();
  const st = appt.status;
  const live = ['aguardando', 'em_atendimento', 'realizada'].includes(st); // a sessão aconteceu (ou o paciente já chegou)
  const chargeFalta = st === 'falta' && pol.noShow;
  let charged = await one('SELECT * FROM payments WHERE appointment_id = ?', [appt.id]);
  // 1) desfaz o que não vale mais
  const pkgOk = live || (chargeFalta && pol.noShowPackage);
  if (appt.package_id && !pkgOk) {
    await q("UPDATE fin_packages SET sessions_used = GREATEST(sessions_used - 1, 0), status = 'ativo' WHERE id = ?", [appt.package_id]);
    await q('UPDATE appointments SET package_id = NULL WHERE id = ?', [appt.id]);
    appt.package_id = null;
  }
  if (charged && !charged.paid_at && !charged.settlement_id
    && ((charged.origin === 'sessao' && !live) || (charged.origin === 'falta' && !chargeFalta))) {
    await logPay(charged, 'cancelado', userId, `Sessão passou para “${st}”`);
    await q('DELETE FROM payments WHERE id = ?', [charged.id]);
    charged = null;
  }
  // 2) aplica o que vale agora
  if (!live && !chargeFalta) return;
  if (appt.package_id || charged) return;
  const pk = await activePackage(appt.patient_id);
  if (pk && (live || pol.noShowPackage)) {
    await q("UPDATE fin_packages SET sessions_used = sessions_used + 1, status = IF(sessions_used >= sessions_total, 'encerrado', status) WHERE id = ?", [pk.id]);
    await q('UPDATE appointments SET package_id = ? WHERE id = ?', [pk.id, appt.id]);
    return;
  }
  const p = await one('SELECT session_fee, owner_id, pay_to FROM patients WHERE id = ?', [appt.patient_id]);
  if (!p?.session_fee) return;
  const amount = live ? r2(p.session_fee) : noShowAmount(p.session_fee, pol);
  if (amount <= 0) return;
  const r = await rule(p.owner_id);
  const d = appt.starts_at.slice(0, 10); const br = d.split('-').reverse().join('/');
  const ins = await q('INSERT IGNORE INTO payments (patient_id, appointment_id, description, amount, due_date, professional_id, receiver, issuer, origin) VALUES (?,?,?,?,?,?,?,?,?)',
    [appt.patient_id, appt.id, live ? `Sessão de psicoterapia (${br})` : `Falta sem aviso prévio (${br})`, amount, d, p.owner_id, p.pay_to, r.receipt_by, live ? 'sessao' : 'falta']);
  if (ins.affectedRows) await logPay(ins.insertId, 'criado', userId, live ? 'Sessão' : 'Falta sem aviso'); // índice único: nunca duas cobranças da mesma sessão
}

// ---------- relatório para Receita Saúde / Carnê-Leão ----------
// Recebimentos pagos no mês, com beneficiário (paciente) e pagador (responsável financeiro, se houver).
export async function report(ym, { profId = null, issuer = null } = {}) {
  const where = ["x.paid_at IS NOT NULL", "DATE_FORMAT(x.paid_at,'%Y-%m') = ?", "x.origin <> 'convenio'"]; const args = [ym]; // o que a operadora paga não é recibo de paciente (Receita Saúde)
  if (profId) { where.push('x.professional_id = ?'); args.push(profId); }
  if (issuer) { where.push(`${ISSUER_SQL} = ?`); args.push(issuer); }
  const rows = await q(`SELECT x.id, x.paid_at, x.amount, x.method, x.description, x.professional_id, x.patient_id, x.rs_issued_at, x.receiver, ${ISSUER_SQL} issuer_eff,
      p.name, p.cpf_enc, p.payer_name, p.payer_cpf_enc, u.name pro, u.crp
    FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN users u ON u.id = x.professional_id LEFT JOIN fin_rules r ON r.user_id = x.professional_id
    WHERE ${where.join(' AND ')} ORDER BY x.paid_at, x.id`, args);
  return rows.map((x) => {
    const cpf = x.cpf_enc ? decrypt(x.cpf_enc) : '';
    const payerCpf = x.payer_cpf_enc ? decrypt(x.payer_cpf_enc) : '';
    return { id: x.id, patient_id: x.patient_id, rs_issued_at: x.rs_issued_at, receiver: x.receiver, date: String(x.paid_at).slice(0, 10), amount: Number(x.amount), method: x.method, description: x.description, issuer: x.issuer_eff,
      professional_id: x.professional_id, pro: x.pro || '', crp: x.crp || '',
      beneficiary: x.name, beneficiary_cpf: cpf, payer: x.payer_name || x.name, payer_cpf: x.payer_name ? payerCpf : cpf };
  });
}

// ---------- contas recorrentes ----------
// Gera as contas do mês atual e do próximo (idempotente: uma por recorrência e mês).
export async function ensureRecurring() {
  const ym = todayLocal().slice(0, 7);
  const recs = await q('SELECT * FROM fin_recurring WHERE active = 1');
  for (const rc of recs) {
    for (const m of [ym, addMonths(ym, 1)]) {
      if (m < rc.start_ym || (rc.end_ym && m > rc.end_ym)) continue;
      const due = `${m}-${pad(Math.min(rc.day, lastDay(m)))}`;
      await q('INSERT IGNORE INTO fin_entries (owner_id, kind, category_id, description, counterpart, amount, due_date, recurring_id, rec_ym, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
        [rc.owner_id, rc.kind, rc.category_id, rc.description, rc.counterpart, rc.amount, due, rc.id, m, rc.created_by]);
    }
  }
}

// ---------- acerto mensal clínica ↔ profissional ----------
// Positivo: a clínica deve ao profissional. Negativo: o profissional deve à clínica.
export async function settlement(profId, ym) {
  const closed = await one('SELECT * FROM fin_settlements WHERE professional_id = ? AND ym = ?', [profId, ym]);
  if (closed) {
    let detail = {}; try { detail = JSON.parse(closed.detail || '{}'); } catch { /* vazio */ }
    return { ...detail, closed, net: Number(closed.net) };
  }
  const r = await rule(profId);
  const rows = await q(`SELECT x.id, x.amount, x.sessions, x.receiver, x.clinic_share, x.paid_at, x.description, p.name, p.social_name FROM payments x JOIN patients p ON p.id = x.patient_id
    WHERE x.professional_id = ? AND x.paid_at IS NOT NULL AND DATE_FORMAT(x.paid_at,'%Y-%m') = ? AND x.settlement_id IS NULL ORDER BY x.paid_at, x.id`, [profId, ym]);
  const lines = rows.map((x) => {
    const share = x.clinic_share !== null ? Number(x.clinic_share) : clinicShare(x.amount, x.sessions, r);
    const prof = r2(Number(x.amount) - share);
    return { id: x.id, date: x.paid_at.slice(0, 10), patient: x.social_name || x.name, description: x.description, amount: Number(x.amount), receiver: x.receiver, clinic: share, prof,
      // quem recebeu fica devendo a parte do outro
      effect: x.receiver === 'clinica' ? prof : -share };
  });
  const sum = (f) => r2(lines.filter(f).reduce((s, l) => s + l.amount, 0));
  const tot = {
    received_clinic: sum((l) => l.receiver === 'clinica'), received_prof: sum((l) => l.receiver === 'profissional'),
    clinic_part: r2(lines.reduce((s, l) => s + l.clinic, 0)), prof_part: r2(lines.reduce((s, l) => s + l.prof, 0)), rent: r2(r.rent),
  };
  const net = r2(lines.reduce((s, l) => s + l.effect, 0) - tot.rent);
  return { ym, professional_id: profId, rule: r, lines, tot, net, closed: null };
}

export async function closeSettlement(profId, ym, userId) {
  const s = await settlement(profId, ym);
  if (s.closed) return s.closed;
  const pro = await one('SELECT name FROM users WHERE id = ?', [profId]);
  const ins = await q('INSERT INTO fin_settlements (professional_id, ym, net, detail, closed_by) VALUES (?,?,?,?,?)',
    [profId, ym, s.net, JSON.stringify({ ym, professional_id: profId, rule: { ...s.rule, doc: undefined }, lines: s.lines, tot: s.tot }), userId]);
  const sid = ins.insertId;
  if (s.lines.length) await q(`UPDATE payments SET settlement_id = ? WHERE id IN (${s.lines.map(() => '?').join(',')})`, [sid, ...s.lines.map((l) => l.id)]);
  if (s.net !== 0) {
    const due = addDays(todayLocal(), 5); const mm = `${ym.slice(5, 7)}/${ym.slice(0, 4)}`;
    const catPay = (await one("SELECT id FROM fin_categories WHERE name = 'Repasse a profissionais' AND kind = 'despesa'"))?.id || null;
    const catRec = (await one("SELECT id FROM fin_categories WHERE name = 'Acerto de profissional' AND kind = 'receita'"))?.id || null;
    const clinicKind = s.net > 0 ? 'pagar' : 'receber';
    const amount = Math.abs(s.net);
    // lado da clínica
    await q('INSERT INTO fin_entries (owner_id, kind, category_id, description, counterpart, amount, due_date, settlement_id, created_by) VALUES (NULL,?,?,?,?,?,?,?,?)',
      [clinicKind, clinicKind === 'pagar' ? catPay : catRec, `Acerto ${mm} — ${pro.name}`, pro.name, amount, due, sid, userId]);
    // lado do(a) profissional (espelho)
    await q('INSERT INTO fin_entries (owner_id, kind, category_id, description, counterpart, amount, due_date, settlement_id, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [profId, clinicKind === 'pagar' ? 'receber' : 'pagar', null, `Acerto ${mm} com a clínica`, 'Clínica', amount, due, sid, userId]);
  }
  return one('SELECT * FROM fin_settlements WHERE id = ?', [sid]);
}

export async function reopenSettlement(sid) {
  const paid = await one('SELECT id FROM fin_entries WHERE settlement_id = ? AND paid_at IS NOT NULL', [sid]);
  if (paid) return { ok: false, error: 'O acerto já foi pago. Desfaça o pagamento antes de reabrir.' };
  await q('DELETE FROM fin_entries WHERE settlement_id = ?', [sid]);
  await q('UPDATE payments SET settlement_id = NULL WHERE settlement_id = ?', [sid]);
  await q('DELETE FROM fin_settlements WHERE id = ?', [sid]);
  return { ok: true };
}

// Pagar um lado do acerto quita o espelho do outro lado.
export async function markEntryPaid(id, paidAt, method) {
  const e = await one('SELECT * FROM fin_entries WHERE id = ?', [id]);
  if (!e) return;
  if (e.settlement_id) await q('UPDATE fin_entries SET paid_at = ?, method = ? WHERE settlement_id = ?', [paidAt, method, e.settlement_id]);
  else await q('UPDATE fin_entries SET paid_at = ?, method = ? WHERE id = ?', [paidAt, method, id]);
}

// ---------- visão geral ----------
// scope: { owner: null } para a clínica; { owner: userId } para as finanças de um(a) profissional.
export async function overview(scope, ym) {
  const prof = scope.owner;
  const recv = prof
    ? await one(`SELECT COALESCE(SUM(amount),0) total, COALESCE(SUM(amount - COALESCE(clinic_share,0)),0) mine FROM payments WHERE professional_id = ? AND paid_at IS NOT NULL AND DATE_FORMAT(paid_at,'%Y-%m') = ?`, [prof, ym])
    : await one(`SELECT COALESCE(SUM(CASE WHEN receiver='clinica' THEN amount END),0) at_clinic, COALESCE(SUM(CASE WHEN receiver='profissional' THEN amount END),0) at_prof, COALESCE(SUM(COALESCE(clinic_share,0)),0) share FROM payments WHERE paid_at IS NOT NULL AND DATE_FORMAT(paid_at,'%Y-%m') = ?`, [ym]);
  const ent = await one(`SELECT COALESCE(SUM(CASE WHEN kind='pagar' AND paid_at IS NOT NULL AND settlement_id IS NULL THEN amount END),0) paid_out,
      COALESCE(SUM(CASE WHEN kind='receber' AND paid_at IS NOT NULL AND settlement_id IS NULL THEN amount END),0) paid_in
    FROM fin_entries WHERE ${prof ? 'owner_id = ?' : 'owner_id IS NULL'} AND paid_at IS NOT NULL AND DATE_FORMAT(paid_at,'%Y-%m') = ?`, prof ? [prof, ym] : [ym]);
  // aluguel de sala do mês (clínica recebe / profissional paga), pela regra atual
  const rents = prof ? Number((await rule(prof)).rent) : Number((await one('SELECT COALESCE(SUM(r.rent),0) t FROM fin_rules r JOIN users u ON u.id = r.user_id AND u.active = 1')).t);
  const income = prof ? r2(Number(recv.mine)) : r2(Number(recv.share) + rents);
  const expense = r2(Number(ent.paid_out) + (prof ? rents : 0));
  const other = r2(Number(ent.paid_in));
  return { recv, income, other, expense, result: r2(income + other - expense), rents };
}

// Projeção de caixa: o que entra e sai nos próximos dias (pendentes).
export async function projection(scope, days) {
  const today = todayLocal(); const until = addDays(today, days); const prof = scope.owner;
  const inPat = prof
    ? await one('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE professional_id = ? AND receiver = \'profissional\' AND paid_at IS NULL AND due_date <= ?', [prof, until])
    : await one('SELECT COALESCE(SUM(amount),0) t FROM payments WHERE receiver = \'clinica\' AND paid_at IS NULL AND due_date <= ?', [until]);
  const e = await one(`SELECT COALESCE(SUM(CASE WHEN kind='receber' THEN amount END),0) inn, COALESCE(SUM(CASE WHEN kind='pagar' THEN amount END),0) outt
    FROM fin_entries WHERE ${prof ? 'owner_id = ?' : 'owner_id IS NULL'} AND paid_at IS NULL AND due_date <= ?`, prof ? [prof, until] : [until]);
  const inn = r2(Number(inPat.t) + Number(e.inn)); const out = r2(Number(e.outt));
  return { days, in: inn, out, net: r2(inn - out) };
}
