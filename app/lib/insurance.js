// Convênios (fase 1): operadoras credenciadas, carteirinhas dos pacientes, autorizações (senha + sessões + validade)
// e a sessão por convênio na agenda e no financeiro (conta a receber da operadora e a coparticipação do paciente).
import { q, one } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { todayLocal, addDays } from './time.js';

export const COPAY = { nenhuma: 'Sem coparticipação', percentual: 'Percentual da sessão (%)', fixo: 'Valor fixo por sessão (R$)' };
export const TISS_VERSIONS = ['4.03.00', '4.02.00', '4.01.00'];
export const VIA = { portal: 'Portal da operadora', webservice: 'Webservice TISS', papel: 'Guia em papel' };
export const LIVE = ['aguardando', 'em_atendimento', 'realizada']; // a sessão aconteceu: consome a autorização e gera a conta
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const dec = (v) => { const n = Number(String(v ?? '').replace(/\./g, '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const d10 = (v) => (v ? String(v).slice(0, 10) : '');

// ---------- operadoras ----------
export const list = (onlyActive = false) => q(`SELECT i.*, (SELECT COUNT(*) FROM patient_plans pp WHERE pp.insurer_id = i.id AND pp.active = 1) plans FROM insurers i ${onlyActive ? 'WHERE i.active = 1' : ''} ORDER BY i.active DESC, i.name`);
export const get = (id) => one('SELECT * FROM insurers WHERE id = ?', [id]);
export async function save(id, b) {
  const name = String(b.name || '').trim().slice(0, 80);
  if (!name) return { ok: false, error: 'Informe o nome do convênio.' };
  const vals = [name, b.active ? 1 : 0, String(b.ans_code || '').trim().slice(0, 20) || null, String(b.provider_code || '').trim().slice(0, 40) || null,
    b.credential === 'profissional' ? 'profissional' : 'clinica', b.requires_auth ? 1 : 0, Math.min(200, Math.max(1, Math.round(dec(b.sessions_per_auth)) || 10)),
    Math.min(730, Math.max(1, Math.round(dec(b.auth_days)) || 60)), b.requires_signature ? 1 : 0, b.requires_token ? 1 : 0,
    COPAY[b.copay_mode] ? b.copay_mode : 'nenhuma', Math.max(0, r2(dec(b.copay_value))), Math.round(dec(b.close_day)) >= 1 && Math.round(dec(b.close_day)) <= 31 ? Math.round(dec(b.close_day)) : null,
    Math.min(180, Math.max(0, Math.round(dec(b.pay_days)) || 30)), VIA[b.send_via] ? b.send_via : 'portal', b.copay_where === 'prestador' ? 'prestador' : 'operadora',
    TISS_VERSIONS.includes(b.tiss_version) ? b.tiss_version : '4.03.00', b.guide_mode === 'autorizacao' ? 'autorizacao' : 'sessao',
    /^https?:\/\//.test(String(b.portal_url || '').trim()) ? String(b.portal_url).trim().slice(0, 300) : null, String(b.phone || '').trim().slice(0, 40) || null, String(b.notes || '').trim().slice(0, 1000) || null,
    Math.min(365, Math.max(1, Math.round(dec(b.appeal_days)) || 30))];
  if (b.copay_mode === 'percentual' && dec(b.copay_value) > 100) return { ok: false, error: 'A coparticipação percentual vai de 0 a 100%.' };
  try {
    if (id) await q(`UPDATE insurers SET name = ?, active = ?, ans_code = ?, provider_code = ?, credential = ?, requires_auth = ?, sessions_per_auth = ?, auth_days = ?, requires_signature = ?, requires_token = ?,
      copay_mode = ?, copay_value = ?, close_day = ?, pay_days = ?, send_via = ?, copay_where = ?, tiss_version = ?, guide_mode = ?, portal_url = ?, phone = ?, notes = ?, appeal_days = ? WHERE id = ?`, [...vals, id]);
    else id = (await q(`INSERT INTO insurers (name, active, ans_code, provider_code, credential, requires_auth, sessions_per_auth, auth_days, requires_signature, requires_token,
      copay_mode, copay_value, close_day, pay_days, send_via, copay_where, tiss_version, guide_mode, portal_url, phone, notes, appeal_days) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, vals)).insertId;
  } catch (e) { if (e.code === 'ER_DUP_ENTRY') return { ok: false, error: 'Já existe um convênio com esse nome.' }; throw e; }
  return { ok: true, id };
}
export const procs = (insurerId) => q('SELECT * FROM insurer_procs WHERE insurer_id = ? ORDER BY is_default DESC, description', [insurerId]);
export async function addProc(insurerId, b) {
  const desc = String(b.description || '').trim().slice(0, 160);
  if (!desc || !(dec(b.value) > 0)) return { ok: false, error: 'Informe a descrição e o valor do procedimento.' };
  const first = !(await one('SELECT id FROM insurer_procs WHERE insurer_id = ? LIMIT 1', [insurerId]));
  await q('INSERT INTO insurer_procs (insurer_id, tuss_code, description, value, is_default) VALUES (?,?,?,?,?)', [insurerId, String(b.tuss_code || '').replace(/[^\d.]/g, '').slice(0, 20) || null, desc, r2(dec(b.value)), first || b.is_default ? 1 : 0]);
  if (b.is_default && !first) { const last = await one('SELECT MAX(id) id FROM insurer_procs WHERE insurer_id = ?', [insurerId]); await setDefaultProc(insurerId, last.id); }
  return { ok: true };
}
export async function setDefaultProc(insurerId, procId) { await q('UPDATE insurer_procs SET is_default = (id = ?) WHERE insurer_id = ?', [procId, insurerId]); }
export async function removeProc(insurerId, procId) {
  await q('DELETE FROM insurer_procs WHERE id = ? AND insurer_id = ?', [procId, insurerId]);
  if (!(await one('SELECT id FROM insurer_procs WHERE insurer_id = ? AND is_default = 1', [insurerId]))) await q('UPDATE insurer_procs SET is_default = 1 WHERE insurer_id = ? ORDER BY id LIMIT 1', [insurerId]);
}
export const defaultProc = (insurerId) => one('SELECT * FROM insurer_procs WHERE insurer_id = ? ORDER BY is_default DESC, id LIMIT 1', [insurerId]);
// Coparticipação de uma sessão
export function copayOf(ins, value) {
  if (ins.copay_mode === 'percentual') return r2((Number(value) * Number(ins.copay_value)) / 100);
  if (ins.copay_mode === 'fixo') return Math.min(r2(ins.copay_value), r2(value));
  return 0;
}

// ---------- carteirinhas ----------
const cardOf = (pl) => { try { return pl.card_enc ? decrypt(pl.card_enc) : ''; } catch { return ''; } };
export const maskCard = (c) => (String(c).length > 4 ? `•••• ${String(c).slice(-4)}` : c || '');
export async function plansOf(pid, onlyActive = false) {
  const rows = await q(`SELECT pp.*, i.name insurer, i.active insurer_active, i.requires_auth FROM patient_plans pp JOIN insurers i ON i.id = pp.insurer_id WHERE pp.patient_id = ? ${onlyActive ? 'AND pp.active = 1 AND i.active = 1' : ''} ORDER BY pp.active DESC, pp.id DESC`, [pid]);
  return rows.map((r) => ({ ...r, card: cardOf(r), expired: r.valid_until && d10(r.valid_until) < todayLocal() }));
}
export async function plan(id) { const r = await one('SELECT pp.*, i.name insurer FROM patient_plans pp JOIN insurers i ON i.id = pp.insurer_id WHERE pp.id = ?', [id]); return r ? { ...r, card: cardOf(r) } : null; }
export async function savePlan(pid, id, b) {
  const ins = await one('SELECT id, active FROM insurers WHERE id = ?', [Number(b.insurer_id) || 0]);
  if (!ins?.active) return { ok: false, error: 'Escolha um convênio credenciado (ative-o em Configurações → Convênios).' };
  const card = String(b.card || '').trim().slice(0, 40);
  if (!card) return { ok: false, error: 'Informe o número da carteirinha.' };
  const vals = [ins.id, encrypt(card), String(b.plan_name || '').trim().slice(0, 80) || null, String(b.holder_name || '').trim().slice(0, 160) || null, ymd(b.valid_until), b.active === undefined ? 1 : (b.active ? 1 : 0)];
  if (id) await q('UPDATE patient_plans SET insurer_id = ?, card_enc = ?, plan_name = ?, holder_name = ?, valid_until = ?, active = ? WHERE id = ? AND patient_id = ?', [...vals, id, pid]);
  else id = (await q('INSERT INTO patient_plans (insurer_id, card_enc, plan_name, holder_name, valid_until, active, patient_id) VALUES (?,?,?,?,?,?,?)', [...vals, pid])).insertId;
  if (b.default) await q('UPDATE patients SET default_plan_id = ? WHERE id = ?', [id, pid]);
  else { const p = await one('SELECT default_plan_id FROM patients WHERE id = ?', [pid]); if (!p.default_plan_id && !b.particular) await q('UPDATE patients SET default_plan_id = ? WHERE id = ?', [id, pid]); }
  return { ok: true, id };
}
export async function setDefault(pid, planId) { await q('UPDATE patients SET default_plan_id = ? WHERE id = ?', [planId || null, pid]); }

// ---------- autorizações ----------
const USED = `(SELECT COUNT(*) FROM appointments a WHERE a.auth_id = au.id AND a.status IN ('aguardando','em_atendimento','realizada'))`;
export async function authsOf(pid) {
  const rows = await q(`SELECT au.*, ${USED} used, pp.insurer_id, i.name insurer, ip.description proc, ip.tuss_code FROM insurer_auths au JOIN patient_plans pp ON pp.id = au.plan_id JOIN insurers i ON i.id = pp.insurer_id
    LEFT JOIN insurer_procs ip ON ip.id = au.proc_id WHERE au.patient_id = ? ORDER BY au.status = 'ativa' DESC, au.valid_until DESC, au.id DESC`, [pid]);
  const t = todayLocal();
  return rows.map((r) => ({ ...r, used: Number(r.used), left: Math.max(0, r.sessions_total - Number(r.used)), expired: d10(r.valid_until) < t, current: r.status === 'ativa' && d10(r.valid_until) >= t && Number(r.used) < r.sessions_total }));
}
export async function saveAuth(pid, b, userId) {
  const pl = await one('SELECT pp.*, i.auth_days, i.sessions_per_auth FROM patient_plans pp JOIN insurers i ON i.id = pp.insurer_id WHERE pp.id = ? AND pp.patient_id = ?', [Number(b.plan_id) || 0, pid]);
  if (!pl) return { ok: false, error: 'Escolha a carteirinha do convênio.' };
  const from = ymd(b.valid_from) || todayLocal();
  const until = ymd(b.valid_until) || addDays(from, pl.auth_days);
  if (until < from) return { ok: false, error: 'A validade termina antes de começar.' };
  const total = Math.min(500, Math.max(1, Math.round(dec(b.sessions_total)) || pl.sessions_per_auth));
  const proc = b.proc_id ? await one('SELECT id FROM insurer_procs WHERE id = ? AND insurer_id = ?', [Number(b.proc_id), pl.insurer_id]) : null;
  const r = await q('INSERT INTO insurer_auths (patient_id, plan_id, proc_id, password, sessions_total, valid_from, valid_until, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
    [pid, pl.id, proc?.id || null, String(b.password || '').trim().slice(0, 40) || null, total, from, until, String(b.notes || '').trim().slice(0, 300) || null, userId]);
  await relink(pid); // sessões já realizadas sem autorização passam a usar esta
  return { ok: true, id: r.insertId };
}
export async function cancelAuth(pid, id) {
  await q("UPDATE insurer_auths SET status = 'cancelada' WHERE id = ? AND patient_id = ?", [id, pid]);
  await q('UPDATE appointments SET auth_id = NULL WHERE auth_id = ?', [id]);
  await relink(pid);
}
// Autorização válida para a sessão: do mesmo plano, na validade, com sessões sobrando (a que vence primeiro)
async function pickAuth(planId, date, exceptAppt = 0) {
  return one(`SELECT au.* FROM insurer_auths au WHERE au.plan_id = ? AND au.status = 'ativa' AND au.valid_from <= ? AND au.valid_until >= ?
      AND (SELECT COUNT(*) FROM appointments a WHERE a.auth_id = au.id AND a.id <> ? AND a.status IN ('aguardando','em_atendimento','realizada')) < au.sessions_total
    ORDER BY au.valid_until, au.id LIMIT 1`, [planId, date, date, exceptAppt]);
}
// Liga (ou solta) a autorização da sessão conforme a situação
export async function syncAppt(apptId) {
  const a = await one('SELECT id, patient_id, plan_id, auth_id, status, starts_at FROM appointments WHERE id = ?', [apptId]);
  if (!a) return null;
  if (!a.plan_id || !LIVE.includes(a.status)) { if (a.auth_id) await q('UPDATE appointments SET auth_id = NULL WHERE id = ?', [a.id]); return null; }
  if (a.auth_id) { const cur = await one("SELECT plan_id, status FROM insurer_auths WHERE id = ?", [a.auth_id]); if (cur && cur.plan_id === a.plan_id && cur.status === 'ativa') return a.auth_id; }
  const au = await pickAuth(a.plan_id, String(a.starts_at).slice(0, 10), a.id);
  await q('UPDATE appointments SET auth_id = ? WHERE id = ?', [au?.id || null, a.id]);
  return au?.id || null;
}
async function relink(pid) {
  for (const a of await q("SELECT id FROM appointments WHERE patient_id = ? AND plan_id IS NOT NULL AND status IN ('aguardando','em_atendimento','realizada') AND auth_id IS NULL ORDER BY starts_at", [pid])) await syncAppt(a.id);
}

// Situação do convênio para uma sessão (agenda, recepção): carteirinha, autorização e avisos
export async function statusFor(a) {
  if (!a.plan_id) return null;
  const pl = await one('SELECT pp.*, i.name insurer, i.requires_auth, i.requires_signature, i.requires_token, i.active insurer_active FROM patient_plans pp JOIN insurers i ON i.id = pp.insurer_id WHERE pp.id = ?', [a.plan_id]);
  if (!pl) return null;
  const date = String(a.starts_at).slice(0, 10);
  let au = null;
  if (a.auth_id) au = await one(`SELECT au.*, ${USED} used FROM insurer_auths au WHERE au.id = ?`, [a.auth_id]);
  if (!au) { const pk = await pickAuth(pl.id, date, a.id || 0); if (pk) au = await one(`SELECT au.*, ${USED} used FROM insurer_auths au WHERE au.id = ?`, [pk.id]); }
  const warn = [];
  if (!pl.active || !pl.insurer_active) warn.push('carteirinha ou convênio inativo');
  if (pl.valid_until && d10(pl.valid_until) < date) warn.push(`carteirinha vencida em ${d10(pl.valid_until).split('-').reverse().join('/')}`);
  if (pl.requires_auth && !au) warn.push('sem autorização válida para esta data');
  const left = au ? Math.max(0, au.sessions_total - Number(au.used) - (a.auth_id === au.id ? 0 : 0)) : null;
  if (au && left !== null && left <= 2 && left >= 0) warn.push(left === 0 ? 'esta é a última sessão da autorização' : `restam ${left} sessão(ões) na autorização`);
  if (au && d10(au.valid_until) <= addDays(todayLocal(), 7)) warn.push(`autorização vence em ${d10(au.valid_until).split('-').reverse().join('/')}`);
  return { plan: { ...pl, card: cardOf(pl) }, auth: au ? { ...au, used: Number(au.used), left } : null, warn, needSignature: !!pl.requires_signature, needToken: !!pl.requires_token };
}
// Avisos da ficha: autorizações para renovar e carteirinhas a vencer
export async function alertsFor(pid) {
  const out = [];
  for (const pl of await plansOf(pid, true)) {
    if (pl.expired) out.push(`Carteirinha ${pl.insurer} vencida.`);
    else if (pl.valid_until && d10(pl.valid_until) <= addDays(todayLocal(), 30)) out.push(`Carteirinha ${pl.insurer} vence em ${d10(pl.valid_until).split('-').reverse().join('/')}.`);
  }
  const auths = (await authsOf(pid)).filter((x) => x.status === 'ativa');
  const byPlan = {}; for (const x of auths) (byPlan[x.plan_id] ||= []).push(x);
  for (const xs of Object.values(byPlan)) {
    const cur = xs.filter((x) => x.current);
    if (!cur.length) { if (xs[0].requires_auth !== 0) out.push(`${xs[0].insurer}: sem autorização válida. Peça uma nova.`); continue; }
    const left = cur.reduce((s, x) => s + x.left, 0);
    if (left <= 2) out.push(`${xs[0].insurer}: restam ${left} sessão(ões) autorizada(s). Peça a renovação.`);
  }
  return out;
}

// ---------- financeiro: a sessão por convênio ----------
// Gera (ou remove) a conta a receber da operadora e a coparticipação do paciente. Devolve true se tratou a sessão.
export async function billAppt(appt, { logPay, userId }) {
  if (!appt.plan_id) return false;
  const live = LIVE.includes(appt.status);
  const pays = await q("SELECT * FROM payments WHERE appointment_id = ? AND origin IN ('convenio','sessao')", [appt.id]);
  if (!live) {
    for (const x of pays) if (!x.paid_at && !x.settlement_id) { await logPay(x, 'cancelado', userId, `Sessão passou para “${appt.status}”`); await q('DELETE FROM payments WHERE id = ?', [x.id]); }
    return appt.status !== 'falta'; // falta segue a política de faltas (cobrança do paciente), se houver
  }
  if (pays.length) return true; // já lançada
  const pl = await one('SELECT pp.*, i.*, pp.id plan_id_, i.id insurer_id_ FROM patient_plans pp JOIN insurers i ON i.id = pp.insurer_id WHERE pp.id = ?', [appt.plan_id]);
  if (!pl) return false;
  const au = appt.auth_id ? await one('SELECT proc_id FROM insurer_auths WHERE id = ?', [appt.auth_id]) : null;
  const proc = (au?.proc_id && await one('SELECT * FROM insurer_procs WHERE id = ?', [au.proc_id])) || await defaultProc(pl.insurer_id_);
  if (!proc) return true; // sem tabela: nada a lançar (a tela do convênio avisa)
  const p = await one('SELECT owner_id, pay_to FROM patients WHERE id = ?', [appt.patient_id]);
  const d = String(appt.starts_at).slice(0, 10); const br = d.split('-').reverse().join('/');
  const copay = pl.copay_where === 'prestador' ? copayOf(pl, proc.value) : 0; // em geral a operadora cobra a coparticipação do paciente na mensalidade
  const recv = pl.credential === 'profissional' ? 'profissional' : 'clinica';
  const ins = await q("INSERT IGNORE INTO payments (patient_id, appointment_id, description, amount, due_date, professional_id, receiver, issuer, origin, insurer_id) VALUES (?,?,?,?,?,?,?,?,'convenio',?)",
    [appt.patient_id, appt.id, `${pl.name} · ${proc.description} (${br})`, r2(proc.value - copay), addDays(d, pl.pay_days || 30), p.owner_id, recv, recv, pl.insurer_id_]);
  if (ins.affectedRows) await logPay(ins.insertId, 'criado', userId, `Convênio ${pl.name}`);
  if (copay > 0) {
    const c = await q("INSERT IGNORE INTO payments (patient_id, appointment_id, description, amount, due_date, professional_id, receiver, issuer, origin) VALUES (?,?,?,?,?,?,?,?,'sessao')",
      [appt.patient_id, appt.id, `Coparticipação ${pl.name} (${br})`, copay, d, p.owner_id, p.pay_to, recv]);
    if (c.affectedRows) await logPay(c.insertId, 'criado', userId, 'Coparticipação');
  }
  return true;
}
// Folha de assinaturas de uma autorização (sessões realizadas, para o paciente assinar)
export async function sheet(authId) {
  const au = await one(`SELECT au.*, pp.card_enc, pp.holder_name, pp.plan_name, i.name insurer, i.provider_code, i.ans_code, ip.description proc, ip.tuss_code, p.name patient, p.social_name, u.name pro, u.title pro_title, u.crp
    FROM insurer_auths au JOIN patient_plans pp ON pp.id = au.plan_id JOIN insurers i ON i.id = pp.insurer_id JOIN patients p ON p.id = au.patient_id LEFT JOIN users u ON u.id = p.owner_id
    LEFT JOIN insurer_procs ip ON ip.id = au.proc_id WHERE au.id = ?`, [authId]);
  if (!au) return null;
  const sessions = await q("SELECT id, starts_at, status, guide_signed_at, guide_token FROM appointments WHERE auth_id = ? AND status IN ('aguardando','em_atendimento','realizada') ORDER BY starts_at", [authId]);
  return { ...au, card: cardOf(au), sessions };
}
