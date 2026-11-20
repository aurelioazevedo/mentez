// Convênios (fase 5): números do faturamento por operadora para os relatórios (BI).
// Faturado/liberado/glosado contam pela data da sessão; recebido e recuperado, pela data em que o dinheiro entrou;
// "a faturar" e "aguardando pagamento" são a situação de hoje.
import { q, one } from './db.js';
import { todayLocal, addDays } from './time.js';
import { buckets, bucketLabel, bucketSql } from './reports.js';
import { GLOSAS } from './tissglosas.js';

const num = (v) => Number(v || 0);
const dt = (r) => [`${r.from} 00:00:00`, `${addDays(r.to, 1)} 00:00:00`];
// filtro de profissional/modalidade sobre a sessão (a) e o paciente (p)
function scope(f) {
  const w = []; const p = [];
  if (f.prof) { w.push('p.owner_id = ?'); p.push(f.prof); }
  if (f.mod) { w.push('a.modality = ?'); p.push(f.mod); }
  return { sql: w.map((x) => ` AND ${x}`).join(''), p };
}
const ITEMS = `FROM tiss_items ti JOIN tiss_batches b ON b.id = ti.batch_id AND b.status <> 'cancelado' JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id
  LEFT JOIN payments x ON x.appointment_id = ti.appointment_id AND x.origin = 'convenio'`;
const EXP = 'COALESCE(x.billed_amount, x.amount, ti.value)';

export async function totals(f, r) {
  const s = scope(f); const [a, z] = dt(r);
  const [ses, all, bill, rec, recov, toBill, waiting, lag] = await Promise.all([
    one(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status = 'realizada' AND a.plan_id IS NOT NULL AND a.starts_at >= ? AND a.starts_at < ? ${s.sql}`, [a, z, ...s.p]),
    one(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status = 'realizada' AND a.starts_at >= ? AND a.starts_at < ? ${s.sql}`, [a, z, ...s.p]),
    one(`SELECT COALESCE(SUM(${EXP}),0) fat, COUNT(*) n, COALESCE(SUM(IF(ti.released IS NULL, 0, ${EXP})),0) analisado, COALESCE(SUM(ti.released),0) rel, COALESCE(SUM(ti.glosa),0) gl,
        COALESCE(SUM(IF(ti.glosa > 0, 1, 0)),0) gln ${ITEMS} WHERE a.starts_at >= ? AND a.starts_at < ? ${s.sql}`, [a, z, ...s.p]),
    one(`SELECT COALESCE(SUM(x.amount),0) v, COUNT(*) n FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN appointments a ON a.id = x.appointment_id WHERE x.origin = 'convenio' AND x.paid_at BETWEEN ? AND ? ${s.sql}`, [r.from, r.to, ...s.p]),
    one(`SELECT COALESCE(SUM(ti.recovered),0) v, COALESCE(SUM(ti.appeal_value),0) asked FROM tiss_items ti JOIN tiss_appeals ap ON ap.id = ti.appeal_id JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id WHERE ap.received_at BETWEEN ? AND ? ${s.sql}`, [r.from, r.to, ...s.p]),
    one(`SELECT COUNT(*) n, COALESCE(SUM(x.amount),0) v FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN payments x ON x.appointment_id = a.id AND x.origin = 'convenio'
      WHERE a.status = 'realizada' AND NOT EXISTS (SELECT 1 FROM tiss_items ti JOIN tiss_batches b ON b.id = ti.batch_id AND b.status <> 'cancelado' WHERE ti.appointment_id = a.id) ${s.sql}`, s.p),
    one(`SELECT COUNT(DISTINCT b.id) lots, COALESCE(SUM(IF(ti.released IS NULL, ${EXP}, ti.released)),0) v ${ITEMS} WHERE b.status IN ('gerado','enviado','analisado') ${s.sql}`, s.p),
    one(`SELECT AVG(DATEDIFF(b.paid_at, DATE(b.sent_at))) d, COUNT(*) n FROM tiss_batches b WHERE b.status = 'pago' AND b.sent_at IS NOT NULL AND b.paid_at BETWEEN ? AND ?
      ${f.prof || f.mod ? `AND EXISTS (SELECT 1 FROM tiss_items ti JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id WHERE ti.batch_id = b.id ${s.sql})` : ''}`, [r.from, r.to, ...s.p]),
  ]);
  return {
    sessoes: num(ses.n), realizadas: num(all.n), share: num(all.n) ? num(ses.n) / num(all.n) : null,
    faturado: num(bill.fat), faturadoN: num(bill.n), analisado: num(bill.analisado), liberado: num(bill.rel), glosado: num(bill.gl), glosadoN: num(bill.gln),
    taxaGlosa: num(bill.analisado) ? num(bill.gl) / num(bill.analisado) : null,
    recebido: num(rec.v), recebidoN: num(rec.n), recuperado: num(recov.v), recorrido: num(recov.asked),
    aFaturar: num(toBill.v), aFaturarN: num(toBill.n), aguardando: num(waiting.v), aguardandoLotes: num(waiting.lots),
    prazo: lag.n ? num(lag.d) : null, prazoN: num(lag.n),
  };
}

// Por operadora (tabela principal)
export async function byInsurer(f, r) {
  const s = scope(f); const [a, z] = dt(r);
  const [ins, ses, bill, rec, toBill, waiting, lag, ap] = await Promise.all([
    q('SELECT id, name, active FROM insurers ORDER BY name'),
    q(`SELECT pp.insurer_id k, COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN patient_plans pp ON pp.id = a.plan_id WHERE a.status = 'realizada' AND a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY k`, [a, z, ...s.p]),
    q(`SELECT b.insurer_id k, SUM(${EXP}) fat, SUM(IF(ti.released IS NULL, 0, ${EXP})) an, SUM(ti.released) rel, SUM(ti.glosa) gl ${ITEMS} WHERE a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY k`, [a, z, ...s.p]),
    q(`SELECT x.insurer_id k, SUM(x.amount) v FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN appointments a ON a.id = x.appointment_id WHERE x.origin = 'convenio' AND x.paid_at BETWEEN ? AND ? ${s.sql} GROUP BY k`, [r.from, r.to, ...s.p]),
    q(`SELECT x.insurer_id k, COUNT(*) n, SUM(x.amount) v FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN payments x ON x.appointment_id = a.id AND x.origin = 'convenio'
      WHERE a.status = 'realizada' AND NOT EXISTS (SELECT 1 FROM tiss_items ti JOIN tiss_batches b ON b.id = ti.batch_id AND b.status <> 'cancelado' WHERE ti.appointment_id = a.id) ${s.sql} GROUP BY k`, s.p),
    q(`SELECT b.insurer_id k, SUM(IF(ti.released IS NULL, ${EXP}, ti.released)) v ${ITEMS} WHERE b.status IN ('gerado','enviado','analisado') ${s.sql} GROUP BY k`, s.p),
    q("SELECT insurer_id k, AVG(DATEDIFF(paid_at, DATE(sent_at))) d FROM tiss_batches WHERE status = 'pago' AND sent_at IS NOT NULL AND paid_at BETWEEN ? AND ? GROUP BY k", [r.from, r.to]),
    q(`SELECT b.insurer_id k, SUM(ti.appeal_value) asked, SUM(ti.recovered) got FROM tiss_items ti JOIN tiss_appeals tap ON tap.id = ti.appeal_id JOIN tiss_batches b ON b.id = tap.batch_id JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id
      WHERE tap.created_at >= ? AND tap.created_at < ? ${s.sql} GROUP BY k`, [a, z, ...s.p]),
  ]);
  const m = (rows) => Object.fromEntries(rows.map((x) => [x.k, x]));
  const S = m(ses); const Bm = m(bill); const Rm = m(rec); const T = m(toBill); const W = m(waiting); const L = m(lag); const A = m(ap);
  return ins.map((i) => {
    const b = Bm[i.id] || {}; const an = num(b.an);
    return { id: i.id, name: i.name, sessoes: num(S[i.id]?.n), faturado: num(b.fat), liberado: num(b.rel), glosado: num(b.gl), taxaGlosa: an ? num(b.gl) / an : null,
      recebido: num(Rm[i.id]?.v), aFaturar: num(T[i.id]?.v), aFaturarN: num(T[i.id]?.n), aguardando: num(W[i.id]?.v), prazo: L[i.id] ? num(L[i.id].d) : null,
      recorrido: num(A[i.id]?.asked), recuperado: num(A[i.id]?.got) };
  }).filter((x) => x.sessoes || x.faturado || x.recebido || x.aFaturar || x.aguardando || x.recorrido);
}

// Faturado × recebido ao longo do período
export async function series(f, r, g) {
  const s = scope(f); const [a, z] = dt(r);
  const [fat, rec] = await Promise.all([
    q(`SELECT ${bucketSql('a.starts_at', g)} k, SUM(${EXP}) v, SUM(COALESCE(ti.glosa,0)) gl ${ITEMS} WHERE a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY k`, [a, z, ...s.p]),
    q(`SELECT ${bucketSql('x.paid_at', g)} k, SUM(x.amount) v FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN appointments a ON a.id = x.appointment_id WHERE x.origin = 'convenio' AND x.paid_at BETWEEN ? AND ? ${s.sql} GROUP BY k`, [r.from, r.to, ...s.p]),
  ]);
  const F = Object.fromEntries(fat.map((x) => [String(x.k).slice(0, 10), x])); const R = Object.fromEntries(rec.map((x) => [String(x.k).slice(0, 10), num(x.v)]));
  return buckets(r, g).map((k) => ({ k, ...bucketLabel(k, g), faturado: num(F[k]?.v), glosa: num(F[k]?.gl), liberado: num(F[k]?.v) - num(F[k]?.gl), recebido: R[k] || 0 }));
}

// Glosas por motivo (código da tabela TISS)
export async function glosaReasons(f, r, limit = 10) {
  const s = scope(f); const [a, z] = dt(r);
  const rows = await q(`SELECT COALESCE(ti.glosa_code, '') k, SUM(ti.glosa) v, COUNT(*) n ${ITEMS} WHERE ti.glosa > 0 AND a.starts_at >= ? AND a.starts_at < ? ${s.sql} GROUP BY k ORDER BY v DESC LIMIT ?`, [a, z, ...s.p, limit]);
  return rows.map((x) => ({ code: x.k, label: x.k ? `${x.k} · ${GLOSAS[x.k] || 'código da operadora'}` : 'Sem código informado', value: num(x.v), n: num(x.n) }));
}

// Lotes parados (situação de hoje): gerados e não enviados, enviados sem análise, analisados sem pagamento
export async function pendingLots(f) {
  const s = scope(f);
  const rows = await q(`SELECT b.id, b.lot_number, b.status, b.competence, b.created_at, b.sent_at, b.analyzed_at, b.total, b.released, i.name insurer,
      DATEDIFF(?, DATE(COALESCE(b.analyzed_at, b.sent_at, b.created_at))) dias
    FROM tiss_batches b JOIN insurers i ON i.id = b.insurer_id WHERE b.status IN ('gerado','enviado','analisado')
      ${s.sql ? `AND EXISTS (SELECT 1 FROM tiss_items ti JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id WHERE ti.batch_id = b.id ${s.sql})` : ''}
    ORDER BY dias DESC LIMIT 30`, [todayLocal(), ...s.p]);
  return rows.map((x) => ({ ...x, dias: num(x.dias) }));
}

// Detalhe das glosas do período (CSV)
export async function glosaList(f, r) {
  const s = scope(f); const [a, z] = dt(r);
  return q(`SELECT a.starts_at, p.name, p.social_name, i.name insurer, b.lot_number, ti.guide_number, ${EXP} cobrado, ti.released, ti.glosa, ti.glosa_code, ti.glosa_note, tap.number appeal_number, tap.status appeal_status, ti.appeal_value, ti.recovered
    ${ITEMS} JOIN insurers i ON i.id = b.insurer_id LEFT JOIN tiss_appeals tap ON tap.id = ti.appeal_id
    WHERE ti.glosa > 0 AND a.starts_at >= ? AND a.starts_at < ? ${s.sql} ORDER BY a.starts_at`, [a, z, ...s.p]);
}
