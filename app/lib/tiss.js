// Convênios (fase 2): faturamento em lote no padrão TISS (ANS), guia SP/SADT, versão 4.03.00 por padrão.
// Junta as sessões realizadas do mês por convênio, aponta o que falta em cada uma, gera o XML do lote
// (com o hash do epílogo) e acompanha o envio (protocolo). Glosas e recebimentos: lib/tissret.js.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { decrypt } from './crypto.js';
import { nowLocal, todayLocal } from './time.js';
import * as Fiscal from './fiscal.js';

const NS = 'http://www.ans.gov.br/padroes/tiss/schemas';
const MAX_GUIDES = 100; // limite do esquema por lote
export const STATUS = { gerado: 'Gerado (falta enviar)', enviado: 'Enviado', analisado: 'Analisado (aguardando pagamento)', pago: 'Pago', cancelado: 'Cancelado' };
const DEFAULTS = { contratado: 'codigo', cnes: '9999999', uf: '52', cbos: '251510', conselho: '09' };
export async function config() { try { return { ...DEFAULTS, ...JSON.parse((await getSetting('tiss_cfg')) || '{}') }; } catch { return { ...DEFAULTS }; } }
export async function saveConfig(b) {
  const next = { contratado: ['codigo', 'cnpj', 'cpf'].includes(b.contratado) ? b.contratado : 'codigo', cnes: String(b.cnes || '').replace(/\D/g, '').slice(0, 7) || '9999999',
    uf: /^\d{2}$/.test(String(b.uf)) ? String(b.uf) : '52', cbos: /^\d{4,6}$/.test(String(b.cbos)) ? String(b.cbos) : '251510', conselho: '09' };
  await setSetting('tiss_cfg', JSON.stringify(next));
  return next;
}
export const UFS = { 11: 'RO', 12: 'AC', 13: 'AM', 14: 'RR', 15: 'PA', 16: 'AP', 17: 'TO', 21: 'MA', 22: 'PI', 23: 'CE', 24: 'RN', 25: 'PB', 26: 'PE', 27: 'AL', 28: 'SE', 29: 'BA', 31: 'MG', 32: 'ES', 33: 'RJ', 35: 'SP', 41: 'PR', 42: 'SC', 43: 'RS', 50: 'MS', 51: 'MT', 52: 'GO', 53: 'DF' };

// ---------- texto no XML (ISO-8859-1, tamanho máximo de cada campo) ----------
const latin = (s) => String(s ?? '').normalize('NFC').replace(/[^\x20-\x7E\xA0-\xFF]/g, ' ').replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const t = (s, max) => latin(s).slice(0, max);
const money = (v) => Number(v || 0).toFixed(2);
const digits = (s) => String(s || '').replace(/\D/g, '');
// Nó XML: [nome, valor | filhos[]]; vazio/nulo é omitido (campos opcionais)
export function render(node, out = []) {
  if (!node) return out;
  const [name, v] = node;
  if (Array.isArray(v)) { const inner = v.filter(Boolean); if (!inner.length) return out; out.push(`<ans:${name}>`); for (const c of inner) render(c, out); out.push(`</ans:${name}>`); }
  else if (v !== undefined && v !== null && v !== '') out.push(`<ans:${name}>${esc(String(v))}</ans:${name}>`);
  return out;
}
// Hash do epílogo: MD5 dos valores de todos os campos da mensagem, concatenados na ordem, em ISO-8859-1
function hashOf(nodes) {
  const vals = [];
  const walk = (n) => { if (!n) return; const [, v] = n; if (Array.isArray(v)) v.forEach(walk); else if (v !== undefined && v !== null && v !== '') vals.push(String(v)); };
  nodes.forEach(walk);
  return crypto.createHash('md5').update(Buffer.from(vals.join(''), 'latin1')).digest('hex');
}

// ---------- sessões do mês e o que falta em cada uma ----------
const SESS = `SELECT a.id, a.patient_id, a.starts_at, a.duration_min, a.modality, a.plan_id, a.auth_id, a.guide_signed_at, a.guide_token,
    p.name, p.social_name, p.owner_id, pp.card_enc, pp.valid_until card_until, pp.holder_name, pp.insurer_id,
    i.name insurer, i.ans_code, i.provider_code, i.credential, i.requires_auth, i.requires_signature, i.requires_token, i.guide_mode,
    au.password, au.valid_from auth_from, au.valid_until auth_until, au.proc_id,
    u.name pro, u.crp,
    (SELECT ti.batch_id FROM tiss_items ti JOIN tiss_batches tb ON tb.id = ti.batch_id WHERE ti.appointment_id = a.id AND tb.status <> 'cancelado' LIMIT 1) batch_id
  FROM appointments a JOIN patients p ON p.id = a.patient_id JOIN patient_plans pp ON pp.id = a.plan_id JOIN insurers i ON i.id = pp.insurer_id
  LEFT JOIN insurer_auths au ON au.id = a.auth_id LEFT JOIN users u ON u.id = p.owner_id`;
export async function sessions(insurerId, competence) {
  const rows = await q(`${SESS} WHERE pp.insurer_id = ? AND a.status = 'realizada' AND DATE_FORMAT(a.starts_at, '%Y-%m') = ? ORDER BY a.starts_at`, [insurerId, competence]);
  const procs = {}; const cfg = await config();
  const out = [];
  for (const r of rows) {
    let card = ''; try { card = r.card_enc ? decrypt(r.card_enc) : ''; } catch { /* ilegível */ }
    const pid = r.proc_id || null;
    const proc = pid ? (procs[`p${pid}`] ||= await one('SELECT * FROM insurer_procs WHERE id = ?', [pid])) : (procs[`d${r.insurer_id}`] ||= await one('SELECT * FROM insurer_procs WHERE insurer_id = ? ORDER BY is_default DESC, id LIMIT 1', [r.insurer_id]));
    const fp = r.credential === 'profissional' || cfg.contratado === 'cpf' ? await Fiscal.profile(r.owner_id) : null;
    const date = String(r.starts_at).slice(0, 10);
    const miss = [];
    if (!digits(r.ans_code) || digits(r.ans_code).length !== 6) miss.push('registro ANS do convênio (6 dígitos)');
    if ((r.credential !== 'profissional' && cfg.contratado === 'codigo') && !r.provider_code) miss.push('código do prestador no convênio');
    if (!card) miss.push('número da carteirinha');
    if (r.card_until && String(r.card_until).slice(0, 10) < date) miss.push('carteirinha vencida na data');
    if (r.requires_auth && !r.auth_id) miss.push('autorização (senha)');
    if (r.requires_signature && !r.guide_signed_at) miss.push('assinatura do paciente na guia');
    if (r.requires_token && !r.guide_token) miss.push('token do paciente');
    if (!proc) miss.push('procedimento na tabela do convênio');
    else if (!digits(proc.tuss_code)) miss.push('código TUSS do procedimento');
    if (!digits(String(r.crp || '').split('/').pop())) miss.push('CRP do profissional');
    if (fp && !Fiscal.cpfValid(fp.cpf)) miss.push('CPF do profissional (Conta → Meus dados fiscais)');
    out.push({ ...r, card, proc, fp, date, miss, ok: !miss.length && !r.batch_id });
  }
  return out;
}

// ---------- montagem da guia SP/SADT ----------
// Identificação do contratado (na versão 4 o nome saiu deste bloco; vai em nomeContratadoSolicitante)
const nomeContratado = (s, clinic) => t(s.credential === 'profissional' ? (s.fp?.fullName || s.pro) : clinic.name, 70);
function contratado(s, cfg, clinic) {
  if (s.credential === 'profissional' || cfg.contratado === 'cpf') return [['cpfContratado', digits(s.fp?.cpf)]];
  if (cfg.contratado === 'cnpj' && digits(clinic.cnpj).length === 14) return [['cnpjContratado', digits(clinic.cnpj)]];
  return [['codigoPrestadorNaOperadora', t(s.provider_code, 14)]];
}
function guide(group, number, cfg, clinic) {
  const s = group[0]; const v = group.reduce((a, x) => a + Number(x.proc.value), 0);
  const ctr = contratado(s, cfg, clinic);
  const prof = ['profissionalSolicitante', [['nomeProfissional', t(s.pro, 70)], ['conselhoProfissional', cfg.conselho], ['numeroConselhoProfissional', t(digits(String(s.crp).split('/').pop()), 15)], ['UF', cfg.uf], ['CBOS', cfg.cbos]]];
  const hm = (d) => String(d).slice(11, 16) + ':00';
  const end = (x) => { const d = new Date(`${String(x.starts_at).replace(' ', 'T')}Z`); d.setUTCMinutes(d.getUTCMinutes() + Number(x.duration_min || 50)); return d.toISOString().slice(11, 19); };
  return ['guiaSP-SADT', [
    ['cabecalhoGuia', [['registroANS', digits(s.ans_code)], ['numeroGuiaPrestador', number]]],
    s.auth_id ? ['dadosAutorizacao', [['dataAutorizacao', String(s.auth_from).slice(0, 10)], ['senha', t(s.password, 20)], ['dataValidadeSenha', s.auth_until ? String(s.auth_until).slice(0, 10) : ''], ['codValidacao', group.length === 1 ? t(s.guide_token, 10) : '']]] : null,
    ['dadosBeneficiario', [['numeroCarteira', t(s.card.replace(/\s/g, ''), 20)], ['atendimentoRN', 'N']]], // na versão 4 a guia leva só a carteirinha (sem o nome)
    ['dadosSolicitante', [['contratadoSolicitante', ctr], ['nomeContratadoSolicitante', nomeContratado(s, clinic)], prof]],
    ['dadosSolicitacao', [['dataSolicitacao', String(s.auth_from || s.date).slice(0, 10)], ['caraterAtendimento', '1']]],
    ['dadosExecutante', [['contratadoExecutante', ctr], ['CNES', cfg.cnes]]],
    ['dadosAtendimento', [['tipoAtendimento', '03'], ['indicacaoAcidente', '9'], ['regimeAtendimento', group.every((x) => x.modality === 'online') ? '05' : '01']]],
    ['procedimentosExecutados', group.map((x, i) => ['procedimentoExecutado', [
      ['sequencialItem', String(i + 1)], ['dataExecucao', x.date], ['horaInicial', hm(x.starts_at)], ['horaFinal', end(x)],
      ['procedimento', [['codigoTabela', '22'], ['codigoProcedimento', t(digits(x.proc.tuss_code), 10)], ['descricaoProcedimento', t(x.proc.description, 150)]]],
      ['quantidadeExecutada', '1'], ['reducaoAcrescimo', '1.00'], ['valorUnitario', money(x.proc.value)], ['valorTotal', money(x.proc.value)]]])],
    ['valorTotal', [['valorProcedimentos', money(v)], ['valorTotalGeral', money(v)]]],
  ]];
}
async function clinicInfo() {
  let c = {}; try { c = JSON.parse((await getSetting('fin_clinic')) || '{}'); } catch { /* padrão */ }
  let nf = {}; try { nf = JSON.parse((await getSetting('nfse_cfg')) || '{}'); } catch { /* sem CNPJ */ }
  return { name: c.name || 'Consultório', cnpj: nf.cnpj || '' };
}
// Valores dos campos de um trecho de XML já montado (para o hash quando parte da mensagem vem pronta)
export const xmlValues = (str) => { const v = []; String(str).replace(/>([^<]+)</g, (m, x) => { if (x.trim()) v.push(x.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); return m; }); return v; };
export const md5Latin = (str) => crypto.createHash('md5').update(Buffer.from(str, 'latin1')).digest('hex');
export { clinicInfo, contratado as contratadoNodes };
// Mensagem TISS completa (cabeçalho + corpo + epílogo com o hash)
export function message(cab, body) {
  const hash = hashOf([cab, body]);
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>\n<ans:mensagemTISS xmlns:ans="${NS}">${render(cab).join('')}${render(body).join('')}<ans:epilogo><ans:hash>${hash}</ans:hash></ans:epilogo></ans:mensagemTISS>\n`;
  return { xml, hash };
}
// XML completo do lote (uma mensagem TISS) — devolve { xml, hash, total, guides }
export async function buildXml({ insurer, lotNumber, items, seq }) {
  const cfg = await config(); const clinic = await clinicInfo();
  const now = nowLocal();
  const s0 = items[0][2][0]; // primeira sessão do lote
  const origin = s0.credential === 'profissional' || cfg.contratado === 'cpf' ? ['CPF', digits(s0.fp?.cpf)] : cfg.contratado === 'cnpj' && digits(clinic.cnpj).length === 14 ? ['CNPJ', digits(clinic.cnpj)] : ['codigoPrestadorNaOperadora', t(insurer.provider_code, 14)];
  const cab = ['cabecalho', [
    ['identificacaoTransacao', [['tipoTransacao', 'ENVIO_LOTE_GUIAS'], ['sequencialTransacao', String(seq)], ['dataRegistroTransacao', now.slice(0, 10)], ['horaRegistroTransacao', now.slice(11, 19)]]],
    ['origem', [['identificacaoPrestador', [origin]]]],
    ['destino', [['registroANS', digits(insurer.ans_code)]]],
    ['Padrao', insurer.tiss_version || '4.03.00'],
  ]];
  const body = ['prestadorParaOperadora', [['loteGuias', [['numeroLote', lotNumber], ['guiasTISS', items.map(([, number, group]) => guide(group, number, cfg, clinic))]]]]];
  const { xml, hash } = message(cab, body);
  const total = items.reduce((a, [, , g]) => a + g.reduce((b, x) => b + Number(x.proc.value), 0), 0);
  return { xml, hash, total, guides: items.length };
}

// ---------- lotes ----------
// Gera os lotes do mês com as sessões prontas (no máximo 100 guias por lote; separados por profissional quando o credenciado é o profissional)
export async function generate(insurerId, competence, userId) {
  const insurer = await one('SELECT * FROM insurers WHERE id = ?', [insurerId]);
  if (!insurer?.active) return { ok: false, error: 'Convênio não credenciado.' };
  const ready = (await sessions(insurerId, competence)).filter((s) => s.ok);
  if (!ready.length) return { ok: false, error: 'Nenhuma sessão pronta para faturar neste mês.' };
  const byOwner = {};
  for (const s of ready) (byOwner[insurer.credential === 'profissional' ? s.owner_id : 0] ||= []).push(s);
  const made = [];
  for (const [owner, list] of Object.entries(byOwner)) {
    // guias: uma por sessão, ou uma por autorização (com as sessões como itens)
    const groups = [];
    if (insurer.guide_mode === 'autorizacao') { const by = {}; for (const s of list) (by[s.auth_id ? `a${s.auth_id}` : `s${s.id}`] ||= []).push(s); groups.push(...Object.values(by)); }
    else for (const s of list) groups.push([s]);
    for (let i = 0; i < groups.length; i += MAX_GUIDES) {
      const chunk = groups.slice(i, i + MAX_GUIDES);
      const ins = await one('SELECT next_lot, next_guide FROM insurers WHERE id = ? FOR UPDATE', [insurerId]);
      const lotNumber = String(ins.next_lot);
      const numbered = chunk.map((g, k) => [null, String(Number(ins.next_guide) + k), g]);
      await q('UPDATE insurers SET next_lot = next_lot + 1, next_guide = next_guide + ? WHERE id = ?', [chunk.length, insurerId]);
      const r = await q('INSERT INTO tiss_batches (insurer_id, professional_id, lot_number, competence, created_by) VALUES (?,?,?,?,?)', [insurerId, Number(owner) || null, lotNumber, competence, userId]);
      const built = await buildXml({ insurer, lotNumber, items: numbered, seq: r.insertId });
      await q('UPDATE tiss_batches SET xml = ?, hash = ?, guides = ?, total = ? WHERE id = ?', [built.xml, built.hash, built.guides, built.total, r.insertId]);
      for (const [, number, g] of numbered) for (const s of g) await q('INSERT INTO tiss_items (batch_id, appointment_id, guide_number, value) VALUES (?,?,?,?)', [r.insertId, s.id, number, s.proc.value]);
      made.push({ id: r.insertId, lotNumber, guides: built.guides, total: built.total });
    }
  }
  return { ok: true, batches: made };
}
export const batches = (filter = {}) => q(`SELECT b.*, i.name insurer, u.name pro FROM tiss_batches b JOIN insurers i ON i.id = b.insurer_id LEFT JOIN users u ON u.id = b.professional_id
  WHERE 1 ${filter.insurerId ? 'AND b.insurer_id = ?' : ''} ${filter.competence ? 'AND b.competence = ?' : ''} ORDER BY b.id DESC LIMIT 200`, [filter.insurerId, filter.competence].filter(Boolean));
export const batch = (id) => one('SELECT b.*, i.name insurer, i.portal_url FROM tiss_batches b JOIN insurers i ON i.id = b.insurer_id WHERE b.id = ?', [id]);
export const batchItems = (id) => q(`SELECT ti.*, a.starts_at, p.name, p.social_name FROM tiss_items ti JOIN appointments a ON a.id = ti.appointment_id JOIN patients p ON p.id = a.patient_id WHERE ti.batch_id = ? ORDER BY CAST(ti.guide_number AS UNSIGNED), a.starts_at`, [id]);
export async function markSent(id, protocol) {
  await q("UPDATE tiss_batches SET status = IF(status = 'gerado', 'enviado', status), protocol = ?, sent_at = COALESCE(sent_at, NOW()) WHERE id = ? AND status IN ('gerado','enviado','analisado','pago')", [String(protocol || '').trim().slice(0, 30) || null, id]);
}
export async function cancel(id) { await q("UPDATE tiss_batches SET status = 'cancelado', canceled_at = NOW() WHERE id = ? AND status IN ('gerado','enviado')", [id]); } // as sessões voltam para “prontas”
// Prazo de envio do mês: dia de fechamento do convênio no mês seguinte à competência
export function deadline(ins, competence) {
  if (!ins.close_day) return null;
  const [y, m] = competence.split('-').map(Number); const nm = m === 12 ? [y + 1, 1] : [y, m + 1];
  const last = new Date(Date.UTC(nm[0], nm[1], 0)).getUTCDate();
  return `${nm[0]}-${String(nm[1]).padStart(2, '0')}-${String(Math.min(ins.close_day, last)).padStart(2, '0')}`;
}
