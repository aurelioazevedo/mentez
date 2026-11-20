// Convênios (fase 3): retorno da operadora. Importa o demonstrativo (análise de conta e pagamento, XML TISS)
// ou recebe a análise lançada à mão, registra o pagamento do lote (com baixa nas cobranças e repasse sobre o
// valor recebido), lista as glosas e monta o recurso de glosa (XML TISS RECURSO_GLOSA).
import { q, one } from './db.js';
import { nowLocal, todayLocal } from './time.js';
import * as Fin from './fin.js';
import * as T from './tiss.js';
import { GLOSAS } from './tissglosas.js';

const r2 = (v) => Math.round(Number(v || 0) * 100) / 100;
const digits = (s) => String(s || '').replace(/\D/g, '');
const ymd = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
const addDays = (d, n) => { const x = new Date(`${ymd(d)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
export const validCode = (c) => /^\d{4}$/.test(String(c || '')) && !!GLOSAS[c];

// ---------- leitura de XML (sem dependências: só o que o TISS usa) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unesc = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
export function decodeXml(buf) {
  const head = buf.subarray(0, 200).toString('latin1');
  const enc = (head.match(/encoding=["']([\w-]+)["']/i) || [])[1] || 'utf-8';
  return /8859|latin|1252/i.test(enc) ? buf.toString('latin1') : buf.toString('utf8').replace(/^﻿/, '');
}
export function parseXml(str) {
  const root = { name: '#root', kids: [], text: '' }; const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)(?:[\w.-]+:)?([\w.-]+)(?:\s[^>]*?)?(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(str))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) {
      if (m[2]) { if (stack.length > 1) stack.pop(); continue; }
      const n = { name: m[3], kids: [], text: '' }; top.kids.push(n);
      if (!m[4]) stack.push(n);
    } else if (m[5] !== undefined) top.text += unesc(m[5]);
  }
  return root;
}
const kid = (n, name) => n?.kids.find((k) => k.name === name) || null;
const kids = (n, name) => (n ? n.kids.filter((k) => k.name === name) : []);
const val = (n, ...path) => { let c = n; for (const p of path) c = kid(c, p); return c ? c.text.trim() : ''; };
const num = (n, ...path) => { const v = val(n, ...path); return v === '' ? null : Number(v); };
export { kid, kids, val };
export function deep(n, name, out = []) { if (!n) return out; for (const k of n.kids) { if (k.name === name) out.push(k); deep(k, name, out); } return out; }

// ---------- itens do lote (com o valor esperado: o que a cobrança da sessão espera receber) ----------
export const items = (batchId) => q(`SELECT ti.*, a.starts_at, a.patient_id, p.name, p.social_name, x.id pay_id, x.amount pay_amount, x.billed_amount, x.paid_at pay_paid, x.settlement_id,
    COALESCE(x.billed_amount, x.amount, ti.value) expected
  FROM tiss_items ti JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id
  LEFT JOIN payments x ON x.appointment_id = ti.appointment_id AND x.origin = 'convenio'
  WHERE ti.batch_id = ? ORDER BY CAST(ti.guide_number AS UNSIGNED), a.starts_at, ti.id`, [batchId]);

// ---------- análise da conta (o que a operadora liberou e glosou em cada sessão) ----------
// rows: [{ itemId, released, code, note, opGuide }]
export async function saveAnalysis(batchId, rows, { date = null, demoId = null } = {}) {
  const b = await one('SELECT * FROM tiss_batches WHERE id = ?', [batchId]);
  if (!b || b.status === 'cancelado') return { ok: false, error: 'Lote não encontrado.' };
  if (b.status === 'pago') return { ok: false, error: 'Este lote já foi pago. Desfaça o pagamento para mudar a análise.' };
  const list = await items(batchId); const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  for (const r of rows) {
    const it = byId[r.itemId]; if (!it) continue;
    const exp = Number(it.expected);
    const rel = Math.max(0, Math.min(exp, r2(r.released ?? exp)));
    const gl = r2(exp - rel);
    const code = gl > 0 && r.code ? String(r.code).replace(/\D/g, '').slice(0, 4) || null : null;
    await q('UPDATE tiss_items SET released = ?, glosa = ?, glosa_code = ?, glosa_note = ?, op_guide = COALESCE(?, op_guide) WHERE id = ?',
      [rel, gl, code, gl > 0 && r.note ? String(r.note).slice(0, 500) : null, r.opGuide ? String(r.opGuide).slice(0, 20) : null, it.id]);
  }
  const t = await one('SELECT SUM(released) rel, SUM(glosa) gl, SUM(released IS NULL) open FROM tiss_items WHERE batch_id = ?', [batchId]);
  await q("UPDATE tiss_batches SET status = 'analisado', analyzed_at = COALESCE(?, analyzed_at, ?), released = ?, glosa = ?, demo_id = COALESCE(?, demo_id) WHERE id = ?",
    [date, todayLocal(), r2(t.rel), r2(t.gl), demoId, batchId]);
  return { ok: true, released: r2(t.rel), glosa: r2(t.gl), open: Number(t.open) };
}

// ---------- pagamento do lote: baixa nas cobranças das sessões, proporcional ao que entrou na conta ----------
export async function registerPayment(batchId, { date, net = null, userId = null, demoId = null, note = 'Pagamento do convênio' } = {}) {
  const b = await one('SELECT * FROM tiss_batches WHERE id = ?', [batchId]);
  if (!b || b.status === 'cancelado') return { ok: false, error: 'Lote não encontrado.' };
  if (b.status === 'pago') return { ok: false, error: 'Este lote já está pago.' };
  if (b.status === 'gerado') return { ok: false, error: 'Marque o lote como enviado antes de registrar o pagamento.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, error: 'Informe a data do pagamento.' };
  let list = await items(batchId);
  if (list.some((x) => x.released === null)) { // sem análise: a operadora pagou tudo o que foi cobrado
    await saveAnalysis(batchId, list.filter((x) => x.released === null).map((x) => ({ itemId: x.id, released: x.expected })), { date });
    list = await items(batchId);
  }
  const rel = r2(list.reduce((a, x) => a + Number(x.released), 0));
  const paidNet = net === null || net === '' || !Number.isFinite(Number(net)) ? rel : r2(Number(net));
  if (paidNet < 0) return { ok: false, error: 'Valor recebido inválido.' };
  if (list.some((x) => x.settlement_id)) return { ok: false, error: 'Há sessões deste lote num acerto fechado com o profissional. Reabra o acerto antes.' };
  // rateio do líquido entre as sessões (descontos/impostos retidos pela operadora entram proporcionalmente)
  let left = paidNet; const withVal = list.filter((x) => Number(x.released) > 0);
  for (const x of list) {
    let p = 0;
    if (Number(x.released) > 0) p = x === withVal[withVal.length - 1] ? r2(left) : r2(rel ? (Number(x.released) * paidNet) / rel : 0);
    left = r2(left - p);
    await q('UPDATE tiss_items SET paid = ? WHERE id = ?', [p, x.id]);
    if (!x.pay_id) continue;
    await q("UPDATE payments SET billed_amount = COALESCE(billed_amount, amount), amount = ?, paid_at = ?, method = 'transferencia', received_by = ?, received_at = NOW() WHERE id = ?", [p, date, userId, x.pay_id]);
    await Fin.stampShare(x.pay_id);
    await Fin.logPay(x.pay_id, 'recebido', userId, `${note}: lote ${b.lot_number}${Number(x.glosa) > 0 ? ` (glosa de R$ ${Number(x.glosa).toFixed(2).replace('.', ',')})` : ''}`);
  }
  await q("UPDATE tiss_batches SET status = 'pago', paid_at = ?, paid_net = ?, demo_id = COALESCE(?, demo_id) WHERE id = ?", [date, paidNet, demoId, batchId]);
  return { ok: true, net: paidNet, released: rel };
}
export async function undoPayment(batchId, userId = null) {
  const b = await one('SELECT * FROM tiss_batches WHERE id = ?', [batchId]);
  if (!b || b.status !== 'pago') return { ok: false, error: 'O lote não está pago.' };
  if (await one("SELECT 1 x FROM tiss_appeals WHERE batch_id = ? AND received_at IS NOT NULL", [batchId])) return { ok: false, error: 'Já há recurso recebido neste lote.' };
  const list = await items(batchId);
  if (list.some((x) => x.settlement_id)) return { ok: false, error: 'Há sessões deste lote num acerto fechado com o profissional. Reabra o acerto antes.' };
  for (const x of list) {
    if (!x.pay_id) continue;
    await q('UPDATE payments SET amount = COALESCE(billed_amount, amount), billed_amount = NULL, paid_at = NULL, method = NULL, received_by = NULL, received_at = NULL WHERE id = ?', [x.pay_id]);
    await Fin.stampShare(x.pay_id); await Fin.logPay(x.pay_id, 'reaberto', userId, `Pagamento do lote ${b.lot_number} desfeito`);
  }
  await q('UPDATE tiss_items SET paid = NULL WHERE batch_id = ?', [batchId]);
  await q("UPDATE tiss_batches SET status = 'analisado', paid_at = NULL, paid_net = NULL WHERE id = ?", [batchId]);
  await q("UPDATE fin_bank_tx SET status = 'pendente', match_type = NULL, match_id = NULL, set_paid = 0, done_by = NULL, done_at = NULL WHERE match_type = 'tiss' AND match_id = ?", [batchId]);
  return { ok: true };
}

// ---------- importação do demonstrativo (XML TISS da operadora) ----------
async function findBatch(insurerIds, lot, protocol) {
  if (!insurerIds.length) return null;
  const ph = insurerIds.map(() => '?').join(',');
  return (await one(`SELECT * FROM tiss_batches WHERE insurer_id IN (${ph}) AND lot_number = ? AND status <> 'cancelado' ORDER BY id DESC LIMIT 1`, [...insurerIds, String(lot).replace(/^0+(?=\d)/, '')]))
    || (protocol ? await one(`SELECT * FROM tiss_batches WHERE insurer_id IN (${ph}) AND protocol = ? AND status <> 'cancelado' ORDER BY id DESC LIMIT 1`, [...insurerIds, protocol]) : null);
}
// itens de uma guia do lote, na ordem dos procedimentos (sequencialItem)
const guideItems = (list, guide) => list.filter((x) => String(x.guide_number) === String(guide).replace(/^0+(?=\d)/, ''));
function guideRows(list, g) {
  const its = guideItems(list, val(g, 'numeroGuiaPrestador')); if (!its.length) return null;
  const opGuide = val(g, 'numeroGuiaOperadora') || null;
  const gCode = val(kid(g, 'motivoGlosaGuia'), 'codigoGlosa') || null;
  const gNote = val(kid(g, 'motivoGlosaGuia'), 'descricaoGlosa') || null;
  const det = kids(g, 'detalhesGuia');
  if (det.length) {
    return det.map((d, i) => {
      const seq = Number(val(d, 'sequencialItem')) || i + 1;
      const it = its[seq - 1] || its[i]; if (!it) return null;
      const gl = kids(d, 'relacaoGlosa');
      return { itemId: it.id, released: num(d, 'valorLiberado'), code: gl.length ? val(gl[0], 'tipoGlosa') : gCode, note: gNote, opGuide };
    }).filter(Boolean);
  }
  // só os totais da guia: divide o liberado entre as sessões da guia
  const relG = num(g, 'valorLiberadoGuia') ?? 0; const expG = its.reduce((a, x) => a + Number(x.expected), 0);
  let left = relG;
  return its.map((it, i) => { const v = i === its.length - 1 ? r2(left) : r2(expG ? (Number(it.expected) * relG) / expG : 0); left = r2(left - v); return { itemId: it.id, released: v, code: gCode, note: gNote, opGuide }; });
}
export async function importDemo(buf, { fileName = 'demonstrativo.xml', userId = null } = {}) {
  let tree;
  try { tree = parseXml(decodeXml(buf)); } catch { return { ok: false, error: 'Não foi possível ler o arquivo XML.' }; }
  const tipo = deep(tree, 'tipoTransacao')[0]?.text.trim() || '';
  const analises = deep(tree, 'demonstrativoAnaliseConta'); const pagamentos = deep(tree, 'demonstrativoPagamento');
  const err = deep(tree, 'mensagemErro')[0];
  if (!analises.length && !pagamentos.length) return { ok: false, error: err ? `A operadora devolveu um erro: ${val(err, 'codigoGlosa')} ${val(err, 'descricaoGlosa')}`.trim() : `O arquivo não é um demonstrativo de análise de conta nem de pagamento${tipo ? ` (tipo: ${tipo})` : ''}.` };
  const demo = analises[0] || pagamentos[0];
  const cab = kid(demo, 'cabecalhoDemonstrativo');
  const ans = digits(val(cab, 'registroANS'));
  const insIds = ans ? (await q('SELECT id, ans_code FROM insurers')).filter((i) => digits(i.ans_code) === ans).map((i) => i.id) : [];
  if (!insIds.length) return { ok: false, error: `Nenhum convênio com o registro ANS ${ans || '(vazio)'} — confira o cadastro em Configurações → Convênios.` };
  const kind = analises.length ? 'analise' : 'pagamento';
  const issued = val(cab, 'dataEmissao') || null;
  const r = await q('INSERT INTO tiss_demos (insurer_id, kind, number, issued, file_name, xml, created_by) VALUES (?,?,?,?,?,?,?)',
    [insIds[0], kind, val(cab, 'numeroDemonstrativo').slice(0, 20) || null, issued, String(fileName).slice(0, 160), buf.toString('latin1').slice(0, 15000000), userId]);
  const demoId = r.insertId;
  const lots = []; const missing = [];
  if (kind === 'analise') {
    for (const d of analises) for (const p of deep(d, 'dadosProtocolo')) {
      const lot = val(p, 'numeroLotePrestador'); const prot = val(p, 'numeroProtocolo');
      const b = await findBatch(insIds, lot, prot);
      if (!b) { missing.push(`lote ${lot}${prot ? ` (protocolo ${prot})` : ''}`); continue; }
      if (b.status === 'pago') { lots.push({ id: b.id, lot: b.lot_number, skipped: 'já pago' }); continue; }
      if (b.status === 'gerado') await T.markSent(b.id, prot || b.protocol);
      else if (prot && !b.protocol) await q('UPDATE tiss_batches SET protocol = ? WHERE id = ?', [prot.slice(0, 30), b.id]);
      const list = await items(b.id);
      const rows = []; const pCode = val(kid(p, 'GlosaProtocolo'), 'codigoGlosa');
      const guias = kids(p, 'relacaoGuias');
      if (!guias.length && pCode) for (const it of list) rows.push({ itemId: it.id, released: 0, code: pCode, note: val(kid(p, 'GlosaProtocolo'), 'descricaoGlosa') }); // lote inteiro glosado
      for (const g of guias) { const gr = guideRows(list, g); if (gr) rows.push(...gr); else missing.push(`guia ${val(g, 'numeroGuiaPrestador')} do lote ${lot}`); }
      const out = await saveAnalysis(b.id, rows, { date: issued, demoId });
      lots.push({ id: b.id, lot: b.lot_number, released: out.released, glosa: out.glosa });
    }
  } else {
    const d = pagamentos[0];
    for (const pd of deep(d, 'pagamentosPorData')) {
      const date = val(pd, 'dadosPagamento', 'dataPagamento');
      const bruto = num(pd, 'totaisBrutosPorData', 'totaLiberadoPorData') || 0; const liq = num(pd, 'totaisLiquidosPorData', 'liquidoPorData');
      for (const rp of deep(pd, 'relacaoProtocolos')) {
        const lot = val(rp, 'numeroLote'); const prot = val(rp, 'numeroProtocolo');
        const b = await findBatch(insIds, lot, prot);
        if (!b) { missing.push(`lote ${lot}${prot ? ` (protocolo ${prot})` : ''}`); continue; }
        if (b.status === 'pago') { lots.push({ id: b.id, lot: b.lot_number, skipped: 'já pago' }); continue; }
        if (b.status === 'gerado') await T.markSent(b.id, prot || b.protocol);
        const list = await items(b.id);
        if (list.some((x) => x.released === null)) { // sem análise lançada: usa os valores por guia do demonstrativo de pagamento
          const rows = [];
          for (const g of kids(rp, 'guiasDoLote')) {
            const its = guideItems(list, val(g, 'numeroGuiaPrestador')); const relG = num(g, 'valorLiberadoGuia') ?? 0; const expG = its.reduce((a, x) => a + Number(x.expected), 0);
            let left = relG; its.forEach((it, i) => { const v = i === its.length - 1 ? r2(left) : r2(expG ? (Number(it.expected) * relG) / expG : 0); left = r2(left - v); rows.push({ itemId: it.id, released: v, opGuide: val(g, 'numeroGuiaOperadora') || null }); });
          }
          await saveAnalysis(b.id, rows, { date: issued || date, demoId });
        }
        const relLot = num(rp, 'valorLiberado') ?? 0;
        const net = liq !== null && bruto > 0 ? r2((relLot * liq) / bruto) : relLot;
        const out = await registerPayment(b.id, { date, net, userId, demoId, note: 'Demonstrativo de pagamento' });
        lots.push({ id: b.id, lot: b.lot_number, net: out.ok ? out.net : null, error: out.ok ? null : out.error });
      }
      if (date) await q('UPDATE tiss_demos SET pay_date = COALESCE(pay_date, ?) WHERE id = ?', [date, demoId]);
    }
    await q('UPDATE tiss_demos SET total = ? WHERE id = ?', [num(d, 'totaisDemonstrativo', 'totaisLiquidosDemonstrativo', 'valorLiberadoDemonstrativo'), demoId]);
  }
  await q('UPDATE tiss_demos SET summary = ? WHERE id = ?', [JSON.stringify({ lots, missing }), demoId]);
  return { ok: true, demoId, kind, lots, missing };
}
export const demos = (limit = 20) => q('SELECT d.id, d.kind, d.number, d.issued, d.pay_date, d.total, d.file_name, d.summary, d.created_at, i.name insurer FROM tiss_demos d LEFT JOIN insurers i ON i.id = d.insurer_id ORDER BY d.id DESC LIMIT ?', [limit]);

// ---------- glosas ----------
export function appealDeadline(b, ins) { return b.analyzed_at ? addDays(b.analyzed_at, Number(ins?.appeal_days ?? b.appeal_days ?? 30)) : null; }
// filtro: abertas (sem recurso), recurso (em andamento), encerradas
export async function glosas(filter = 'abertas') {
  const rows = await q(`SELECT ti.*, a.starts_at, p.name, p.social_name, b.lot_number, b.competence, b.analyzed_at, b.status batch_status, b.insurer_id, i.name insurer, i.appeal_days,
      ap.status appeal_status, ap.number appeal_number, ap.protocol appeal_protocol, ap.received_at appeal_received
    FROM tiss_items ti JOIN tiss_batches b ON b.id = ti.batch_id JOIN insurers i ON i.id = b.insurer_id JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id
    LEFT JOIN tiss_appeals ap ON ap.id = ti.appeal_id
    WHERE ti.glosa > 0 AND b.status <> 'cancelado' ORDER BY b.analyzed_at, b.id, CAST(ti.guide_number AS UNSIGNED)`);
  const today = todayLocal();
  for (const x of rows) { x.deadline = appealDeadline(x, x); x.late = !x.appeal_id && x.deadline && x.deadline < today; }
  if (filter === 'recurso') return rows.filter((x) => x.appeal_id && x.appeal_status !== 'respondido');
  if (filter === 'encerradas') return rows.filter((x) => (x.appeal_id && x.appeal_status === 'respondido') || (!x.appeal_id && x.late));
  return rows.filter((x) => !x.appeal_id && !x.late);
}

// ---------- recurso de glosa ----------
// Dados que vieram no XML do lote: identificação do prestador, senha e procedimentos de cada guia
function batchXmlInfo(xml) {
  const tree = parseXml(xml || '');
  const origem = deep(tree, 'identificacaoPrestador')[0]?.kids[0];
  const exec = deep(tree, 'contratadoExecutante')[0]?.kids[0];
  const guides = {};
  for (const g of deep(tree, 'guiaSP-SADT')) {
    const n = val(g, 'cabecalhoGuia', 'numeroGuiaPrestador');
    guides[n] = { senha: val(g, 'dadosAutorizacao', 'senha'), procs: deep(g, 'procedimentoExecutado').map((p) => ({ seq: val(p, 'sequencialItem'), date: val(p, 'dataExecucao'), tab: val(p, 'procedimento', 'codigoTabela'), code: val(p, 'procedimento', 'codigoProcedimento'), desc: val(p, 'procedimento', 'descricaoProcedimento') })) };
  }
  return { origem: origem ? [origem.name, origem.text.trim()] : null, exec: exec ? [exec.name, exec.text.trim()] : null, guides };
}
const tx = (s, max) => String(s ?? '').normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
// picks: [{ itemId, value, text }]
export async function createAppeal(batchId, picks, userId) {
  const b = await one('SELECT b.*, i.name insurer, i.ans_code, i.tiss_version, i.next_appeal FROM tiss_batches b JOIN insurers i ON i.id = b.insurer_id WHERE b.id = ?', [batchId]);
  if (!b || !['analisado', 'pago'].includes(b.status)) return { ok: false, error: 'O recurso é feito depois da análise da operadora (lote analisado ou pago).' };
  const prot = digits(b.protocol);
  if (!prot || prot.length > 12) return { ok: false, error: 'Anote no lote o número do protocolo que o portal devolveu (só números, até 12 dígitos): ele é obrigatório no recurso.' };
  const list = await items(batchId); const byId = Object.fromEntries(list.map((x) => [x.id, x]));
  const chosen = [];
  for (const p of picks) {
    const it = byId[p.itemId]; if (!it || !(Number(it.glosa) > 0) || it.appeal_id) continue;
    const v = r2(Math.min(Number(it.glosa), Number(p.value ?? it.glosa)));
    const text = tx(p.text, 500);
    if (!(v > 0)) continue;
    if (!validCode(it.glosa_code)) return { ok: false, error: `Sessão de ${ymd(it.starts_at).split('-').reverse().join('/')}: informe o código da glosa na análise antes de recorrer.` };
    if (text.length < 10) return { ok: false, error: `Sessão de ${ymd(it.starts_at).split('-').reverse().join('/')}: escreva a justificativa do recurso.` };
    chosen.push({ it, v, text });
  }
  if (!chosen.length) return { ok: false, error: 'Escolha ao menos uma glosa para recorrer.' };
  const info = batchXmlInfo(b.xml);
  if (!info.exec || !info.origem) return { ok: false, error: 'Não foi possível ler o XML original do lote.' };
  const number = String(b.next_appeal);
  await q('UPDATE insurers SET next_appeal = next_appeal + 1 WHERE id = ?', [b.insurer_id]);
  // agrupa por guia; o sequencial do item é o da guia original
  const byGuide = {};
  for (const c of chosen) (byGuide[c.it.guide_number] ||= []).push(c);
  const guiasRec = Object.entries(byGuide).map(([g, cs]) => {
    const gi = info.guides[g] || { senha: '', procs: [] }; const its = guideItems(list, g);
    return ['recursoGuia', [['numeroGuiaOrigem', g], ['numeroGuiaOperadora', cs[0].it.op_guide || ''], ['senha', gi.senha],
      ['opcaoRecursoGuia', cs.map((c) => {
        const idx = its.findIndex((x) => x.id === c.it.id); const pr = gi.procs[idx] || gi.procs[0] || {};
        return ['itensGuia', [['sequencialItem', pr.seq || String(idx + 1)], ['dataInicio', pr.date || ymd(c.it.starts_at)],
          ['procRecurso', [['codigoTabela', pr.tab || '22'], ['codigoProcedimento', pr.code || ''], ['descricaoProcedimento', pr.desc || 'Sessao de psicoterapia']]],
          ['codGlosaItem', c.it.glosa_code], ['valorRecursado', c.v.toFixed(2)], ['justificativaItem', c.text]]];
      })]]];
  });
  const total = r2(chosen.reduce((a, c) => a + c.v, 0));
  const r = await q('INSERT INTO tiss_appeals (batch_id, number, total, created_by) VALUES (?,?,?,?)', [batchId, number, total, userId]);
  const now = nowLocal();
  const cab = ['cabecalho', [
    ['identificacaoTransacao', [['tipoTransacao', 'RECURSO_GLOSA'], ['sequencialTransacao', String(r.insertId)], ['dataRegistroTransacao', now.slice(0, 10)], ['horaRegistroTransacao', now.slice(11, 19)]]],
    ['origem', [['identificacaoPrestador', [info.origem]]]], ['destino', [['registroANS', digits(b.ans_code)]]], ['Padrao', b.tiss_version || '4.03.00']]];
  const body = ['prestadorParaOperadora', [['recursoGlosa', [['guiaRecursoGlosa', [
    ['registroANS', digits(b.ans_code)], ['numeroGuiaRecGlosaPrestador', number], ['nomeOperadora', tx(b.insurer, 70)], ['objetoRecurso', '2'],
    ['dadosContratado', [info.exec]], ['numeroLote', b.lot_number], ['numeroProtocolo', prot],
    ['opcaoRecurso', guiasRec], ['valorTotalRecursado', total.toFixed(2)], ['dataRecurso', now.slice(0, 10)]]]]]]];
  const { xml, hash } = T.message(cab, body);
  await q('UPDATE tiss_appeals SET xml = ?, hash = ? WHERE id = ?', [xml, hash, r.insertId]);
  for (const c of chosen) await q('UPDATE tiss_items SET appeal_id = ?, appeal_value = ?, appeal_text = ? WHERE id = ?', [r.insertId, c.v, c.text, c.it.id]);
  return { ok: true, id: r.insertId, number, total };
}
export const appeal = (id) => one('SELECT ap.*, b.lot_number, b.protocol batch_protocol, b.insurer_id, b.competence, i.name insurer, i.portal_url FROM tiss_appeals ap JOIN tiss_batches b ON b.id = ap.batch_id JOIN insurers i ON i.id = b.insurer_id WHERE ap.id = ?', [id]);
export const appealsOf = (batchId) => q('SELECT * FROM tiss_appeals WHERE batch_id = ? ORDER BY id', [batchId]);
export const appealItems = (id) => q('SELECT ti.*, a.starts_at, p.name, p.social_name FROM tiss_items ti JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id WHERE ti.appeal_id = ? ORDER BY CAST(ti.guide_number AS UNSIGNED), a.starts_at', [id]);
export async function markAppealSent(id, protocol) {
  await q("UPDATE tiss_appeals SET status = IF(status = 'rascunho', 'enviado', status), protocol = ?, sent_at = COALESCE(sent_at, NOW()) WHERE id = ?", [String(protocol || '').trim().slice(0, 30) || null, id]);
}
export async function deleteAppeal(id) {
  const ap = await one('SELECT * FROM tiss_appeals WHERE id = ?', [id]);
  if (!ap || ap.status !== 'rascunho') return { ok: false, error: 'Só dá para excluir um recurso que ainda não foi enviado.' };
  await q('UPDATE tiss_items SET appeal_id = NULL, appeal_value = NULL, appeal_text = NULL WHERE appeal_id = ?', [id]);
  await q('DELETE FROM tiss_appeals WHERE id = ?', [id]);
  return { ok: true };
}
// Resposta da operadora: valor recuperado em cada sessão; com a data, o valor entra na cobrança da sessão (e no repasse)
export async function answerAppeal(id, values, { receivedAt = null, userId = null } = {}) {
  const ap = await one('SELECT * FROM tiss_appeals WHERE id = ?', [id]);
  if (!ap || ap.status === 'rascunho') return { ok: false, error: 'Marque o recurso como enviado antes de registrar a resposta.' };
  if (ap.received_at) return { ok: false, error: 'A resposta deste recurso já foi registrada e recebida.' };
  const its = await appealItems(id);
  for (const it of its) {
    const v = values[it.id]; if (v === undefined) continue;
    await q('UPDATE tiss_items SET recovered = ? WHERE id = ?', [Math.max(0, Math.min(Number(it.appeal_value), r2(v))), it.id]);
  }
  const t = await one('SELECT SUM(recovered) s FROM tiss_items WHERE appeal_id = ?', [id]);
  await q("UPDATE tiss_appeals SET status = 'respondido', answered_at = COALESCE(answered_at, NOW()), recovered = ? WHERE id = ?", [r2(t.s), id]);
  if (receivedAt) return receiveAppeal(id, receivedAt, userId);
  return { ok: true, recovered: r2(t.s) };
}
export async function receiveAppeal(id, date, userId = null) {
  const ap = await one('SELECT ap.*, b.lot_number, b.status batch_status FROM tiss_appeals ap JOIN tiss_batches b ON b.id = ap.batch_id WHERE ap.id = ?', [id]);
  if (!ap || ap.status !== 'respondido' || ap.received_at) return { ok: false, error: 'Nada a receber neste recurso.' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return { ok: false, error: 'Informe a data do recebimento.' };
  if (ap.batch_status !== 'pago') return { ok: false, error: 'Registre antes o pagamento do lote.' };
  for (const it of await appealItems(id)) {
    if (!(Number(it.recovered) > 0)) continue;
    const x = await one("SELECT * FROM payments WHERE appointment_id = ? AND origin = 'convenio'", [it.appointment_id]);
    if (!x) continue;
    if (x.settlement_id) return { ok: false, error: 'Há sessões deste recurso num acerto fechado com o profissional. Reabra o acerto antes.' };
    await q('UPDATE payments SET amount = amount + ? WHERE id = ?', [it.recovered, x.id]);
    await Fin.stampShare(x.id); await Fin.logPay(x.id, 'recebido', userId, `Recurso de glosa nº ${ap.number} (lote ${ap.lot_number}): + R$ ${Number(it.recovered).toFixed(2).replace('.', ',')}`);
  }
  await q('UPDATE tiss_appeals SET received_at = ? WHERE id = ?', [date, id]);
  return { ok: true, recovered: Number(ap.recovered) };
}

// ---------- conciliação bancária: lotes analisados à espera do depósito ----------
export async function bankCandidates(scope, amount, posted) {
  const rows = await q(`SELECT b.id, b.lot_number, b.released, b.analyzed_at, b.competence, i.name insurer FROM tiss_batches b JOIN insurers i ON i.id = b.insurer_id
    WHERE b.status = 'analisado' AND ${scope.owner ? 'b.professional_id = ?' : 'b.professional_id IS NULL'} AND b.released > 0`, scope.owner ? [scope.owner] : []);
  return rows.filter((b) => Math.abs(Number(b.released) - amount) <= Math.max(0.01, Number(b.released) * 0.2) && (!b.analyzed_at || ymd(b.analyzed_at) <= addDays(posted, 5)));
}
