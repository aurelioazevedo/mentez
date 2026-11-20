// Extrato bancário: leitura de OFX/CSV e conciliação com recebimentos de pacientes e contas.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import * as Fin from './fin.js';
import { addDays } from './time.js';

const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;

// ---------- decodificação ----------
function decode(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, ''); } catch { /* não é UTF-8 */ }
  try { return new TextDecoder('windows-1252').decode(buf); } catch { return buf.toString('latin1'); }
}

// Valor em texto (aceita 1.234,56 · -50,00 · 50.00 · R$ 10) → número com sinal.
export function money(s) {
  let v = String(s ?? '').trim().replace(/[R$\s]/g, '');
  if (!v) return null;
  let neg = false;
  if (/^\(.*\)$/.test(v)) { neg = true; v = v.slice(1, -1); }
  if (/[DC]$/i.test(v)) { neg = /D$/i.test(v); v = v.slice(0, -1); }
  if (v.includes(',') && v.includes('.')) v = v.lastIndexOf(',') > v.lastIndexOf('.') ? v.replace(/\./g, '').replace(',', '.') : v.replace(/,/g, '');
  else if (v.includes(',')) v = v.replace(',', '.');
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return r2(neg ? -Math.abs(n) : n);
}
const ymdOk = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T12:00:00Z`));
function dateOf(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})(\d{2})(\d{2})/); if (m) { const d = `${m[1]}-${m[2]}-${m[3]}`; return ymdOk(d) ? d : null; }
  m = t.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) { const d = `${m[1]}-${m[2]}-${m[3]}`; return ymdOk(d) ? d : null; }
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; const d = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; return ymdOk(d) ? d : null; }
  return null;
}
const clean = (s, n = 255) => String(s || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim().slice(0, n);

// ---------- OFX (SGML 1.x e XML 2.x) ----------
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([^<\\r\\n]*)`, 'i'));
  return m ? m[1].trim() : '';
}
export function parseOFX(text) {
  const blocks = text.split(/<STMTTRN>/i).slice(1).map((b) => b.split(/<\/STMTTRN>|<\/BANKTRANLIST>/i)[0]);
  const txs = [];
  for (const b of blocks) {
    const date = dateOf(tag(b, 'DTPOSTED'));
    const amount = money(tag(b, 'TRNAMT'));
    if (!date || amount === null || amount === 0) continue;
    const memo = clean([tag(b, 'NAME'), tag(b, 'MEMO')].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(' · '));
    txs.push({ fitid: clean(tag(b, 'FITID'), 100), date, amount, memo, type: clean(tag(b, 'TRNTYPE'), 20).toUpperCase() });
  }
  const balM = text.match(/<LEDGERBAL>[\s\S]*?<BALAMT>([^<\r\n]*)/i);
  return {
    format: 'OFX',
    bank: clean(tag(text, 'ORG') || tag(text, 'BANKID'), 60) || null,
    account: clean(tag(text, 'ACCTID'), 60) || null,
    start: dateOf(tag(text, 'DTSTART')), end: dateOf(tag(text, 'DTEND')),
    balance: balM ? money(balM[1]) : null,
    txs,
  };
}

// ---------- CSV (cabeçalho com Data / Descrição / Valor, ou Crédito e Débito separados) ----------
function splitCsv(line, sep) {
  const out = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') quoted = false; else cur += ch; }
    else if (ch === '"') quoted = true;
    else if (ch === sep) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out.map((c) => c.trim());
}
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
export function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const hi = lines.findIndex((l) => /data/i.test(norm(l)) && /(valor|credito|debito|entrada|saida)/.test(norm(l)));
  if (hi < 0) return { format: 'CSV', txs: [], error: 'Não encontrei o cabeçalho (colunas Data, Descrição e Valor).' };
  const sep = [';', '\t', ','].sort((a, b) => lines[hi].split(b).length - lines[hi].split(a).length)[0];
  const head = splitCsv(lines[hi], sep).map(norm);
  const col = (re) => head.findIndex((h) => re.test(h));
  const cDate = col(/^data/);
  const cDesc = col(/(descri|hist|lanca|memo|detalh|identif)/);
  const cVal = col(/^valor/);
  const cIn = col(/(credito|entrada)/);
  const cOut = col(/(debito|saida)/);
  if (cDate < 0 || (cVal < 0 && cIn < 0 && cOut < 0)) return { format: 'CSV', txs: [], error: 'O CSV precisa das colunas Data e Valor (ou Crédito/Débito).' };
  const seen = {};
  const txs = [];
  for (const l of lines.slice(hi + 1)) {
    const c = splitCsv(l, sep);
    const date = dateOf(c[cDate]);
    if (!date) continue;
    let amount = cVal >= 0 ? money(c[cVal]) : null;
    if (amount === null) { const i = cIn >= 0 ? money(c[cIn]) : null; const o = cOut >= 0 ? money(c[cOut]) : null; amount = i ? Math.abs(i) : o ? -Math.abs(o) : null; }
    if (!amount) continue;
    const memo = clean(cDesc >= 0 ? c[cDesc] : '');
    if (/^saldo/i.test(norm(memo))) continue;
    const base = `${date}|${amount}|${memo}`;
    seen[base] = (seen[base] || 0) + 1;
    const fitid = `csv-${crypto.createHash('sha1').update(`${base}|${seen[base]}`).digest('hex').slice(0, 24)}`;
    txs.push({ fitid, date, amount, memo, type: amount > 0 ? 'CREDIT' : 'DEBIT' });
  }
  const ds = txs.map((t) => t.date).sort();
  return { format: 'CSV', bank: null, account: null, start: ds[0] || null, end: ds[ds.length - 1] || null, balance: null, txs };
}

export function parse(buf) {
  const text = decode(buf);
  if (/<OFX>|OFXHEADER/i.test(text.slice(0, 4000))) return parseOFX(text);
  return parseCSV(text);
}

// Grava o extrato; transações já importadas antes (mesmo FITID na mesma conta) são ignoradas.
export async function importStatement({ ownerId, fileName, data, userId }) {
  const s = parse(data);
  if (s.error) return { ok: false, error: s.error };
  if (!s.txs.length) return { ok: false, error: 'Nenhuma movimentação encontrada no arquivo.' };
  const ownerKey = ownerId || 0;
  const acctKey = `${s.bank || ''}|${s.account || ''}`.slice(0, 80) || 'csv';
  const res = await q('INSERT INTO fin_imports (owner_id, bank, account, period_start, period_end, balance, file_name, created_by) VALUES (?,?,?,?,?,?,?,?)',
    [ownerId, s.bank, s.account, s.start, s.end, s.balance, String(fileName || 'extrato').slice(0, 160), userId]);
  const importId = res.insertId;
  let added = 0;
  for (const t of s.txs) {
    const fitid = t.fitid || `h-${crypto.createHash('sha1').update(`${t.date}|${t.amount}|${t.memo}`).digest('hex').slice(0, 24)}`;
    const r = await q('INSERT IGNORE INTO fin_bank_tx (import_id, owner_key, acct_key, fitid, posted, amount, memo, trn_type) VALUES (?,?,?,?,?,?,?,?)',
      [importId, ownerKey, acctKey, fitid, t.date, t.amount, t.memo || null, t.type || null]);
    added += r.affectedRows ? 1 : 0;
  }
  await q('UPDATE fin_imports SET total = ? WHERE id = ?', [added, importId]);
  return { ok: true, importId, added, skipped: s.txs.length - added, format: s.format };
}

// ---------- sugestões de conciliação ----------
const words = (s) => norm(s).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !['dos', 'das', 'para', 'pix', 'ted', 'doc', 'transf', 'recebido', 'recebida', 'enviado', 'pagamento', 'transferencia'].includes(w));
const nameHit = (memo, ...names) => {
  const m = new Set(words(memo));
  let best = 0;
  for (const n of names) { const w = words(n); if (!w.length) continue; const hit = w.filter((x) => m.has(x)).length; best = Math.max(best, hit >= 2 || (hit === 1 && w.length === 1) ? 2 : hit); }
  return best;
};
const dayDiff = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000);
const ymd = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);

// scope: { owner: null } clínica · { owner: id } profissional
export async function candidates(scope, tx) {
  const amt = Math.abs(Number(tx.amount));
  const posted = ymd(tx.posted);
  const out = [];
  const linked = (await q("SELECT match_type, match_id FROM fin_bank_tx WHERE status = 'conciliado' AND match_id IS NOT NULL AND id <> ?", [tx.id || 0])).map((x) => `${x.match_type}:${x.match_id}`);
  const free = (t, id) => !linked.includes(`${t}:${id}`);
  const ownerSql = scope.owner ? 'owner_id = ?' : 'owner_id IS NULL'; const ownerArg = scope.owner ? [scope.owner] : [];
  if (tx.amount > 0) {
    const pid = (String(tx.memo || '').match(/PAG\s?(\d{1,9})/i) || [])[1];
    const pays = await q(`SELECT x.id, x.amount, x.due_date, x.paid_at, x.description, p.name, p.social_name, p.payer_name, p.responsible_name FROM payments x JOIN patients p ON p.id = x.patient_id
      WHERE ${scope.owner ? "x.professional_id = ? AND x.receiver = 'profissional'" : "x.receiver = 'clinica'"} AND x.amount = ? AND x.origin <> 'convenio'
        AND ((x.paid_at IS NULL AND x.due_date BETWEEN ? AND ?) OR (x.paid_at BETWEEN ? AND ?))`,
    [...(scope.owner ? [scope.owner] : []), amt, addDays(posted, -60), addDays(posted, 20), addDays(posted, -5), addDays(posted, 5)]);
    if (pid) { const x = await one(`SELECT x.id, x.amount, x.due_date, x.paid_at, x.description, p.name, p.social_name, p.payer_name, p.responsible_name FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ? AND ${scope.owner ? "x.professional_id = ? AND x.receiver = 'profissional'" : "x.receiver = 'clinica'"}`, [int(pid), ...(scope.owner ? [scope.owner] : [])]); if (x && !pays.some((y) => y.id === x.id)) pays.push(x); }
    for (const x of pays) {
      if (!free('payment', x.id)) continue;
      const exact = pid && Number(pid) === x.id;
      const nh = nameHit(tx.memo, x.name, x.social_name, x.payer_name, x.responsible_name);
      const near = x.paid_at ? Math.abs(dayDiff(posted, ymd(x.paid_at))) : Math.abs(dayDiff(posted, ymd(x.due_date)));
      const score = (exact ? 100 : 0) + nh * 20 + Math.max(0, 15 - near / 2) + (x.paid_at ? (near <= 2 ? 4 : -4) : 0);
      out.push({ type: 'payment', id: x.id, already: !!x.paid_at, score, exact: !!exact, name: x.social_name || x.name, label: `${x.social_name || x.name} — ${x.description}`, due: ymd(x.due_date), paid: ymd(x.paid_at), amount: Number(x.amount) });
    }
  }
  if (tx.amount > 0) { // lote de convênio analisado, à espera do depósito da operadora
    const Ret = await import('./tissret.js');
    for (const b of await Ret.bankCandidates(scope, amt, posted)) {
      if (!free('tiss', b.id)) continue;
      const exact = Math.abs(Number(b.released) - amt) <= 0.01;
      out.push({ type: 'tiss', id: b.id, already: false, score: (exact ? 25 : 8) + nameHit(tx.memo, b.insurer) * 10, label: `Convênio ${b.insurer} — lote nº ${b.lot_number}${exact ? '' : ` (liberado ${Number(b.released).toFixed(2).replace('.', ',')}; diferença como desconto/imposto retido)`}`, due: ymd(b.analyzed_at), paid: null, amount: amt });
    }
  }
  const kind = tx.amount > 0 ? 'receber' : 'pagar';
  const ents = await q(`SELECT e.id, e.amount, e.due_date, e.paid_at, e.description, e.counterpart FROM fin_entries e WHERE ${ownerSql} AND e.kind = ? AND e.amount = ?
    AND ((e.paid_at IS NULL AND e.due_date BETWEEN ? AND ?) OR (e.paid_at BETWEEN ? AND ?))`,
  [...ownerArg, kind, amt, addDays(posted, -45), addDays(posted, 30), addDays(posted, -5), addDays(posted, 5)]);
  for (const e of ents) {
    if (!free('entry', e.id)) continue;
    const nh = nameHit(tx.memo, e.description, e.counterpart);
    const near = e.paid_at ? Math.abs(dayDiff(posted, ymd(e.paid_at))) : Math.abs(dayDiff(posted, ymd(e.due_date)));
    out.push({ type: 'entry', id: e.id, already: !!e.paid_at, score: nh * 20 + Math.max(0, 15 - near / 2) + (e.paid_at ? (near <= 2 ? 4 : -4) : 0), label: `${e.description}${e.counterpart ? ` — ${e.counterpart}` : ''}`, due: ymd(e.due_date), paid: ymd(e.paid_at), amount: Number(e.amount) });
  }
  return out.sort((a, b) => b.score - a.score);
}
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// Sugestão para cada transação pendente do extrato, sem usar o mesmo lançamento duas vezes.
export async function suggestions(scope, txs) {
  const used = new Set();
  const res = {};
  const all = [];
  for (const t of txs) { const c = await candidates(scope, t); res[t.id] = { list: c, pick: null, sure: false }; for (const x of c) all.push({ t, x }); }
  all.sort((a, b) => b.x.score - a.x.score);
  for (const { t, x } of all) {
    const k = `${x.type}:${x.id}`;
    if (res[t.id].pick || used.has(k)) continue;
    const list = res[t.id].list;
    const second = list.find((y) => `${y.type}:${y.id}` !== k && !used.has(`${y.type}:${y.id}`));
    res[t.id].pick = x;
    res[t.id].sure = x.exact || x.score >= 30 || !second || x.score - second.score >= 10;
    used.add(k);
  }
  return res;
}

// ---------- aplicar / desfazer ----------
const methodOf = (tx) => (/pix/i.test(tx.memo || '') ? 'pix' : /boleto|bloqueto|cobran/i.test(tx.memo || '') ? 'boleto' : /cart|cielo|stone|rede|getnet|pagseguro|sumup/i.test(tx.memo || '') ? 'cartao' : tx.amount < 0 && /deb\.? autom/i.test(tx.memo || '') ? 'outro' : 'transferencia');

// action: { type: 'payment'|'entry', id } | { type: 'create', category_id, description } | { type: 'ignore' }
export async function apply(scope, tx, action, userId) {
  const posted = ymd(tx.posted);
  const method = methodOf(tx);
  if (action.type === 'ignore') {
    await q("UPDATE fin_bank_tx SET status = 'ignorado', match_type = NULL, match_id = NULL, set_paid = 0, done_by = ?, done_at = NOW() WHERE id = ?", [userId, tx.id]);
    return { ok: true };
  }
  if (action.type === 'payment') {
    const x = await one(`SELECT * FROM payments WHERE id = ? AND ${scope.owner ? "professional_id = ? AND receiver = 'profissional'" : "receiver = 'clinica'"}`, [action.id, ...(scope.owner ? [scope.owner] : [])]);
    if (!x || tx.amount <= 0) return { ok: false, error: 'Recebimento não encontrado.' };
    const setPaid = !x.paid_at;
    if (setPaid) { await q('UPDATE payments SET paid_at = ?, method = ?, received_by = ?, received_at = NOW() WHERE id = ?', [posted, method, userId, x.id]); await Fin.stampShare(x.id); await Fin.logPay(x.id, 'recebido', userId, 'Conciliação do extrato bancário'); }
    await q("UPDATE fin_bank_tx SET status = 'conciliado', match_type = 'payment', match_id = ?, set_paid = ?, done_by = ?, done_at = NOW() WHERE id = ?", [x.id, setPaid ? 1 : 0, userId, tx.id]);
    return { ok: true };
  }
  if (action.type === 'tiss') {
    if (tx.amount <= 0) return { ok: false, error: 'Lote não encontrado.' };
    const b = await one(`SELECT id FROM tiss_batches WHERE id = ? AND status = 'analisado' AND ${scope.owner ? 'professional_id = ?' : 'professional_id IS NULL'}`, [action.id, ...(scope.owner ? [scope.owner] : [])]);
    if (!b) return { ok: false, error: 'Lote não encontrado.' };
    const Ret = await import('./tissret.js');
    const out = await Ret.registerPayment(b.id, { date: posted, net: Math.abs(Number(tx.amount)), userId, note: 'Conciliação do extrato bancário' });
    if (!out.ok) return out;
    await q("UPDATE fin_bank_tx SET status = 'conciliado', match_type = 'tiss', match_id = ?, set_paid = 1, done_by = ?, done_at = NOW() WHERE id = ?", [b.id, userId, tx.id]);
    return { ok: true };
  }
  if (action.type === 'entry') {
    const e = await one(`SELECT * FROM fin_entries WHERE id = ? AND ${scope.owner ? 'owner_id = ?' : 'owner_id IS NULL'}`, [action.id, ...(scope.owner ? [scope.owner] : [])]);
    if (!e || (e.kind === 'pagar') !== (tx.amount < 0)) return { ok: false, error: 'Conta não encontrada.' };
    const setPaid = !e.paid_at;
    if (setPaid) await Fin.markEntryPaid(e.id, posted, method);
    await q("UPDATE fin_bank_tx SET status = 'conciliado', match_type = 'entry', match_id = ?, set_paid = ?, done_by = ?, done_at = NOW() WHERE id = ?", [e.id, setPaid ? 1 : 0, userId, tx.id]);
    return { ok: true };
  }
  if (action.type === 'create') {
    const kind = tx.amount < 0 ? 'pagar' : 'receber';
    const cat = action.category_id ? await one('SELECT id FROM fin_categories WHERE id = ? AND kind = ?', [action.category_id, kind === 'pagar' ? 'despesa' : 'receita']) : null;
    const r = await q('INSERT INTO fin_entries (owner_id, kind, category_id, description, amount, due_date, paid_at, method, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [scope.owner, kind, cat ? cat.id : null, String(action.description || tx.memo || 'Movimentação do extrato').slice(0, 255), Math.abs(Number(tx.amount)), posted, posted, method, 'Criada pela conciliação do extrato', userId]);
    await q("UPDATE fin_bank_tx SET status = 'conciliado', match_type = 'created', match_id = ?, set_paid = 1, done_by = ?, done_at = NOW() WHERE id = ?", [r.insertId, userId, tx.id]);
    return { ok: true };
  }
  return { ok: false, error: 'Ação inválida.' };
}

// Desfaz a conciliação: o que a conciliação marcou como pago volta a ficar em aberto; o que ela criou é apagado.
export async function undo(tx) {
  if (tx.status === 'conciliado' && tx.set_paid) {
    if (tx.match_type === 'payment') {
      const x = await one('SELECT id, settlement_id FROM payments WHERE id = ?', [tx.match_id]);
      if (x && x.settlement_id) return { ok: false, error: 'Esse recebimento já entrou num acerto fechado. Reabra o acerto antes.' };
      if (x) { await q('UPDATE payments SET paid_at = NULL, method = NULL, received_by = NULL, received_at = NULL WHERE id = ?', [x.id]); await Fin.stampShare(x.id); await Fin.logPay(x.id, 'reaberto', null, 'Conciliação desfeita'); }
    } else if (tx.match_type === 'tiss') {
      const Ret = await import('./tissret.js');
      await q("UPDATE fin_bank_tx SET match_type = NULL WHERE id = ?", [tx.id]); // evita que o desfazer do lote solte esta mesma transação duas vezes
      const out = await Ret.undoPayment(tx.match_id);
      if (!out.ok) { await q("UPDATE fin_bank_tx SET match_type = 'tiss' WHERE id = ?", [tx.id]); return out; }
    } else if (tx.match_type === 'entry') {
      const e = await one('SELECT id, settlement_id FROM fin_entries WHERE id = ?', [tx.match_id]);
      if (e) { if (e.settlement_id) await q('UPDATE fin_entries SET paid_at = NULL, method = NULL WHERE settlement_id = ?', [e.settlement_id]); else await q('UPDATE fin_entries SET paid_at = NULL, method = NULL WHERE id = ?', [e.id]); }
    } else if (tx.match_type === 'created') {
      await q('DELETE FROM fin_files WHERE entry_id = ?', [tx.match_id]);
      await q('DELETE FROM fin_entries WHERE id = ?', [tx.match_id]);
    }
  }
  await q("UPDATE fin_bank_tx SET status = 'pendente', match_type = NULL, match_id = NULL, set_paid = 0, done_by = NULL, done_at = NULL WHERE id = ?", [tx.id]);
  return { ok: true };
}

// Lançamento excluído em outra tela: a transação do extrato volta a ficar pendente.
export async function unlink(type, id) {
  await q("UPDATE fin_bank_tx SET status = 'pendente', match_type = NULL, match_id = NULL, set_paid = 0, done_by = NULL, done_at = NULL WHERE match_type = ? AND match_id = ?", [type, id]);
  if (type === 'entry') await q("UPDATE fin_bank_tx SET status = 'pendente', match_type = NULL, match_id = NULL, set_paid = 0, done_by = NULL, done_at = NULL WHERE match_type = 'created' AND match_id = ?", [id]);
}
