// Convênios (fase 4): integração direta com a operadora pelos webservices TISS (SOAP 1.1, document/literal, versão 4.03.00).
// Elegibilidade, pedido e situação de autorização, envio de lote, situação do protocolo, demonstrativos e recurso de glosa.
// Cada operadora publica os próprios endereços e dá login/senha ao prestador; algumas exigem certificado digital (A1) na conexão.
import https from 'node:https';
import http from 'node:http';
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { nowLocal, todayLocal } from './time.js';
import * as T from './tiss.js';
import * as Ret from './tissret.js';
import * as Ins from './insurance.js';
import * as Fiscal from './fiscal.js';

const NS = 'http://www.ans.gov.br/padroes/tiss/schemas';
const digits = (s) => String(s || '').replace(/\D/g, '');
const ymd = (d) => (d ? String(d instanceof Date ? d.toISOString() : d).slice(0, 10) : null);
const addDays = (d, n) => { const x = new Date(`${ymd(d)}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };

export const SERVICES = {
  elegibilidade: { label: 'Elegibilidade (carteirinha ativa)', ws: 'pedidoElegibilidadeWS', tipo: 'VERIFICA_ELEGIBILIDADE', body: 'pedidoElegibilidade' },
  autorizacao: { label: 'Solicitação de autorização', ws: 'solicitacaoProcedimentoWS', tipo: 'SOLICITACAO_PROCEDIMENTOS', body: 'solicitacaoProcedimento' },
  statusAutorizacao: { label: 'Situação da autorização', ws: 'solicitacaoStatusAutorizacaoWS', tipo: 'SOLICITA_STATUS_AUTORIZACAO', body: 'solicitacaoStatusAutorizacao' },
  lote: { label: 'Envio de lote de guias', ws: 'loteGuiasWS', tipo: 'ENVIO_LOTE_GUIAS', body: 'loteGuias' },
  statusProtocolo: { label: 'Situação do protocolo', ws: 'solicitacaoStatusProtocoloWS', tipo: 'SOLIC_STATUS_PROTOCOLO', body: 'solicitacaoStatusProtocolo' },
  demonstrativo: { label: 'Demonstrativos de retorno', ws: 'solicitacaoDemonstrativoRetornoWS', tipo: 'SOLIC_DEMONSTRATIVO_RETORNO', body: 'solicitacaoDemonstrativoRetorno' },
  recurso: { label: 'Recurso de glosa', ws: 'loteRecursoGlosaWS', tipo: 'RECURSO_GLOSA', body: 'loteRecurso' },
  statusRecurso: { label: 'Situação do recurso', ws: 'solicitacaoStatusRecursoGlosaWS', tipo: 'SOLIC_STATUS_RECURSO_GLOSA', body: 'solicitacaoStatusProtocoloRecurso' },
};
export const PROTOCOL_STATUS = { 1: 'Recebido', 2: 'Em análise', 3: 'Liberado para pagamento', 4: 'Encerrado sem pagamento', 5: 'Analisado e aguardando liberação para pagamento', 6: 'Pagamento efetuado', 7: 'Não localizado', 8: 'Aguardando informação complementar', 9: 'Cancelado', 10: 'Bloqueio judicial' };
export const AUTH_STATUS = { 1: 'Autorizado', 2: 'Em análise', 3: 'Negado', 4: 'Aguardando justificativa técnica', 5: 'Aguardando documentação', 6: 'Solicitação cancelada', 7: 'Autorizado parcialmente' };

// ---------- configuração por operadora ----------
export async function config(insurerId) {
  const i = await one('SELECT id, name, ans_code, provider_code, credential, tiss_version, ws_urls, ws_login, ws_pass_enc, ws_pass_mode, ws_cert_enc, ws_cert_pass_enc, ws_cert_name FROM insurers WHERE id = ?', [insurerId]);
  if (!i) return null;
  let urls = {}; try { urls = JSON.parse(i.ws_urls || '{}'); } catch { /* vazio */ }
  return { ...i, urls, hasPass: !!i.ws_pass_enc, hasCert: !!i.ws_cert_enc };
}
export const enabled = (c, svc) => !!(c && c.urls && /^https?:\/\//.test(c.urls[svc] || ''));
export async function saveConfig(insurerId, b) {
  const urls = {};
  for (const k of Object.keys(SERVICES)) { const u = String(b[`url_${k}`] || '').trim(); if (u && !/^https?:\/\/[^\s]+$/.test(u)) return { ok: false, error: `Endereço inválido em “${SERVICES[k].label}”.` }; if (u) urls[k] = u.slice(0, 300); }
  const sets = ['ws_urls = ?', 'ws_login = ?', 'ws_pass_mode = ?']; const vals = [JSON.stringify(urls), String(b.ws_login || '').trim().slice(0, 20) || null, b.ws_pass_mode === 'texto' ? 'texto' : 'md5'];
  if (b.ws_pass) { sets.push('ws_pass_enc = ?'); vals.push(encrypt(String(b.ws_pass).slice(0, 64))); }
  if (b.clear_pass) { sets.push('ws_pass_enc = NULL'); }
  if (b.clear_cert) { sets.push('ws_cert_enc = NULL', 'ws_cert_pass_enc = NULL', 'ws_cert_name = NULL'); }
  await q(`UPDATE insurers SET ${sets.join(', ')} WHERE id = ?`, [...vals, insurerId]);
  return { ok: true };
}
// Certificado A1 (PFX) para a conexão com a operadora (TLS com certificado do cliente)
export async function saveCert(insurerId, pfx, password) {
  try {
    // valida abrindo o PFX com a senha
    const tls = await import('node:tls');
    tls.createSecureContext({ pfx, passphrase: password });
  } catch (e) { return { ok: false, error: /mac|password|decrypt/i.test(e.message) ? 'Senha do certificado incorreta.' : 'Arquivo de certificado inválido (use o .pfx ou .p12 do A1).' }; }
  let name = 'Certificado A1';
  try { const forge = (await import('node-forge')).default; const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(pfx.toString('binary')), password); const bag = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]?.[0]; const cn = bag?.cert?.subject.getField('CN')?.value; if (cn) name = `${cn} · válido até ${bag.cert.validity.notAfter.toISOString().slice(0, 10).split('-').reverse().join('/')}`; } catch { /* sem nome */ }
  await q('UPDATE insurers SET ws_cert_enc = ?, ws_cert_pass_enc = ?, ws_cert_name = ? WHERE id = ?', [encrypt(pfx.toString('base64')), encrypt(String(password || '')), name.slice(0, 200), insurerId]);
  return { ok: true, name };
}

// ---------- identificação do prestador ----------
async function prestador(c, professionalId = null) {
  const cfg = await T.config(); const clinic = await T.clinicInfo();
  if (c.credential === 'profissional' || cfg.contratado === 'cpf') {
    const fp = professionalId ? await Fiscal.profile(professionalId) : null;
    const cpf = digits(fp?.cpf);
    return { origem: ['CPF', cpf], contratado: ['cpfContratado', cpf], name: fp?.fullName || '', ok: cpf.length === 11, need: 'CPF do profissional (Conta → Meus dados fiscais)' };
  }
  if (cfg.contratado === 'cnpj' && digits(clinic.cnpj).length === 14) return { origem: ['CNPJ', digits(clinic.cnpj)], contratado: ['cnpjContratado', digits(clinic.cnpj)], name: clinic.name, ok: true };
  return { origem: ['codigoPrestadorNaOperadora', T.t(c.provider_code, 14)], contratado: ['codigoPrestadorNaOperadora', T.t(c.provider_code, 14)], name: clinic.name, ok: !!c.provider_code, need: 'código do prestador no convênio' };
}

// ---------- chamada SOAP ----------
const redact = (xml) => String(xml).replace(/(<(?:\w+:)?senhaPrestador>)[^<]*/g, '$1***');
function post(url, xml, c) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch { resolve({ error: 'Endereço do webservice inválido.' }); return; }
    const body = Buffer.from(xml, 'latin1');
    const opts = { method: 'POST', hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: `${u.pathname}${u.search}`, timeout: Number(process.env.TISS_WS_TIMEOUT_MS) || 45000,
      headers: { 'Content-Type': 'text/xml; charset=ISO-8859-1', SOAPAction: '""', 'Content-Length': body.length, 'User-Agent': 'Sistema-Clinica-TISS/4.03' } };
    if (u.protocol === 'https:' && c.ws_cert_enc) { try { opts.pfx = Buffer.from(decrypt(c.ws_cert_enc), 'base64'); opts.passphrase = c.ws_cert_pass_enc ? decrypt(c.ws_cert_pass_enc) : ''; } catch { resolve({ error: 'Não foi possível abrir o certificado da operadora.' }); return; } }
    const req = (u.protocol === 'https:' ? https : http).request(opts, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (d) => { size += d.length; if (size < 20 * 1024 * 1024) chunks.push(d); });
      res.on('end', () => resolve({ status: res.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ error: e.message === 'timeout' ? 'A operadora não respondeu a tempo.' : `Falha de conexão com a operadora (${e.code || e.message}).` }));
    req.end(body);
  });
}
// bodyXml: conteúdo do elemento do serviço (já em XML). Devolve { ok, tree, raw, error, logId }
export async function call(insurerId, svc, bodyXml, { professionalId = null, userId = null, ref = null } = {}) {
  const c = await config(insurerId); const S = SERVICES[svc];
  if (!S) return { ok: false, error: 'Serviço inválido.' };
  if (!enabled(c, svc)) return { ok: false, error: `O webservice de ${S.label.toLowerCase()} não está configurado para ${c?.name || 'este convênio'}.` };
  const pr = await prestador(c, professionalId);
  if (!pr.ok) return { ok: false, error: `Falta o ${pr.need} para identificar o prestador.` };
  const log = await q('INSERT INTO tiss_ws_log (insurer_id, service, ref, user_id) VALUES (?,?,?,?)', [insurerId, svc, ref, userId]);
  const now = nowLocal();
  let pass = ''; try { pass = c.ws_pass_enc ? decrypt(c.ws_pass_enc) : ''; } catch { /* sem senha */ }
  const cab = ['cabecalho', [
    ['identificacaoTransacao', [['tipoTransacao', S.tipo], ['sequencialTransacao', String(log.insertId)], ['dataRegistroTransacao', now.slice(0, 10)], ['horaRegistroTransacao', now.slice(11, 19)]]],
    ['origem', [['identificacaoPrestador', [pr.origem]]]], ['destino', [['registroANS', digits(c.ans_code)]]], ['Padrao', c.tiss_version || '4.03.00'],
    c.ws_login ? ['loginSenhaPrestador', [['loginPrestador', T.t(c.ws_login, 20)], ['senhaPrestador', c.ws_pass_mode === 'texto' ? T.t(pass, 32) : crypto.createHash('md5').update(pass).digest('hex')]]] : null]];
  const cabXml = T.render(cab).join('');
  const inner = `${cabXml}<ans:${S.body}>${bodyXml}</ans:${S.body}>`;
  const hash = T.md5Latin(T.xmlValues(inner).join(''));
  const xml = `<?xml version="1.0" encoding="ISO-8859-1"?>\n<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ans="${NS}"><soapenv:Header/><soapenv:Body><ans:${S.ws}>${inner}<ans:hash>${hash}</ans:hash></ans:${S.ws}></soapenv:Body></soapenv:Envelope>`;
  const r = await post(c.urls[svc], xml, c);
  const raw = r.buf ? Ret.decodeXml(r.buf) : '';
  let tree = null; let error = r.error || null;
  if (raw) { try { tree = Ret.parseXml(raw); } catch { error ||= 'Resposta da operadora ilegível.'; } }
  if (!error && tree) {
    const fault = Ret.deep(tree, 'Fault')[0];
    if (fault) { const tf = Ret.deep(fault, 'tissFault')[0]?.text.trim(); error = `A operadora recusou: ${tf ? FAULTS[tf] || tf : Ret.val(fault, 'faultstring') || 'erro no webservice'}.`; }
    else if (!r.status || r.status >= 400) error = `A operadora respondeu com erro HTTP ${r.status}.`;
    else { const me = Ret.deep(tree, 'mensagemErro')[0]; if (me && !Ret.deep(tree, 'protocoloRecebimento').length) error = `A operadora devolveu: ${Ret.val(me, 'codigoGlosa')} ${Ret.val(me, 'descricaoGlosa') || GLOSA(Ret.val(me, 'codigoGlosa'))}`.trim(); }
  } else if (!error) error = `A operadora respondeu sem conteúdo (HTTP ${r.status}).`;
  await q('UPDATE tiss_ws_log SET ok = ?, http_status = ?, error = ?, request = ?, response = ? WHERE id = ?',
    [error ? 0 : 1, r.status || null, error ? String(error).slice(0, 500) : null, redact(xml).slice(0, 200000), raw.slice(0, 500000), log.insertId]);
  return { ok: !error, error, tree, raw, buf: r.buf, logId: log.insertId };
}
const FAULTS = { DestinatarioInvalido: 'destinatário inválido (registro ANS)', RemetenteInvalido: 'prestador não identificado', LoginInvalido: 'login ou senha do webservice incorretos', VersaoInvalida: 'versão do TISS não aceita', HashInvalido: 'código hash inválido', SchemaInvalido: 'mensagem fora do padrão' };
let GLOSA = (c) => c;
import('./tissglosas.js').then((m) => { GLOSA = (c) => m.GLOSAS[c] || ''; }).catch(() => {});
const X = (nodes) => nodes.map((n) => T.render(n).join('')).join('');
export const log = (insurerId, limit = 20) => q('SELECT id, service, ref, ok, http_status, error, created_at FROM tiss_ws_log WHERE insurer_id = ? ORDER BY id DESC LIMIT ?', [insurerId, limit]);
export const logEntry = (id) => one('SELECT * FROM tiss_ws_log WHERE id = ?', [id]);

// ---------- teste de conexão ----------
export async function test(insurerId, userId) {
  const c = await config(insurerId); const pr = await prestador(c);
  const svc = Object.keys(SERVICES).find((k) => enabled(c, k) && k === 'statusProtocolo') || Object.keys(SERVICES).find((k) => enabled(c, k));
  if (!svc) return { ok: false, error: 'Preencha ao menos um endereço de webservice.' };
  if (svc !== 'statusProtocolo') return { ok: true, info: 'Configuração salva. O teste automático usa o serviço de situação do protocolo; os outros serviços são testados no primeiro uso.' };
  const r = await call(insurerId, 'statusProtocolo', X([['dadosPrestador', [pr.contratado]], ['numeroProtocolo', '0']]), { userId, ref: 'teste' });
  if (r.tree && (r.ok || /devolveu/.test(r.error || ''))) return { ok: true, info: 'Conexão e login aceitos pela operadora.' };
  return { ok: false, error: r.error };
}

// ---------- elegibilidade ----------
export async function eligibility(planId, userId) {
  const pl = await one('SELECT pp.*, p.name patient, p.owner_id FROM patient_plans pp JOIN patients p ON p.id = pp.patient_id WHERE pp.id = ?', [planId]);
  if (!pl) return { ok: false, error: 'Carteirinha não encontrada.' };
  const c = await config(pl.insurer_id); const pr = await prestador(c, pl.owner_id);
  let card = ''; try { card = decrypt(pl.card_enc); } catch { /* ilegível */ }
  if (!card) return { ok: false, error: 'Carteirinha sem número.' };
  const r = await call(pl.insurer_id, 'elegibilidade', X([['dadosPrestador', [pr.contratado]], ['numeroCarteira', T.t(card.replace(/\s/g, ''), 20)], ['validadeCarteira', pl.valid_until ? ymd(pl.valid_until) : '']]),
    { professionalId: pl.owner_id, userId, ref: `plan:${pl.id}` });
  let ok = null; let msg = r.error;
  if (r.ok) {
    const rec = Ret.deep(r.tree, 'reciboElegibilidade')[0];
    if (rec) { ok = Ret.val(rec, 'respostaSolicitacao') === 'S'; msg = ok ? 'Carteirinha ativa: atendimento liberado pela operadora.' : `Negado pela operadora: ${Ret.deep(rec, 'motivoNegativa').map((m) => `${Ret.val(m, 'codigoGlosa')} ${Ret.val(m, 'descricaoGlosa') || GLOSA(Ret.val(m, 'codigoGlosa'))}`.trim()).join('; ') || 'sem motivo informado'}.`; }
    else msg = 'Resposta sem o resultado da elegibilidade.';
  }
  await q('UPDATE patient_plans SET elig_at = NOW(), elig_ok = ?, elig_msg = ? WHERE id = ?', [ok === null ? null : ok ? 1 : 0, String(msg || '').slice(0, 500), pl.id]);
  return { ok: r.ok && ok !== null, eligible: ok, message: msg };
}

// ---------- autorização ----------
function authResult(tree) {
  const a = Ret.deep(tree, 'autorizacaoServico')[0];
  if (!a) return null;
  const st = Ret.val(a, 'statusSolicitacao');
  const da = Ret.kid(a, 'dadosAutorizacao');
  const qty = Ret.deep(a, 'servicoAutorizado').reduce((s, x) => s + (Number(Ret.val(x, 'quantidadeAutorizada')) || 0), 0);
  const neg = [...Ret.deep(a, 'motivoNegativa').map((m) => `${Ret.val(m, 'codigoGlosa')} ${Ret.val(m, 'descricaoGlosa') || GLOSA(Ret.val(m, 'codigoGlosa'))}`.trim()), ...Ret.kids(a, 'codigoGlosa').map((x) => `${x.text.trim()} ${GLOSA(x.text.trim())}`.trim())];
  return { status: st, label: AUTH_STATUS[st] || `situação ${st}`, password: Ret.val(da, 'senha'), opGuide: Ret.val(da, 'numeroGuiaOperadora'), date: Ret.val(da, 'dataAutorizacao'), until: Ret.val(da, 'dataValidadeSenha'), qty, neg, obs: Ret.val(a, 'observacao') };
}
async function applyAuth(reqRow, res, userId) {
  const status = ['1', '7'].includes(res.status) ? 'autorizado' : res.status === '3' || res.status === '6' ? 'negado' : 'analise';
  let authId = reqRow.auth_id;
  if (status === 'autorizado' && !authId) {
    const out = await Ins.saveAuth(reqRow.patient_id, { plan_id: reqRow.plan_id, password: res.password || res.opGuide, sessions_total: res.qty || reqRow.sessions, proc_id: reqRow.proc_id, valid_from: res.date || todayLocal(), valid_until: res.until || '', notes: `Autorizada pelo webservice (guia ${reqRow.guide_number}${res.opGuide ? ` / operadora ${res.opGuide}` : ''})` }, userId);
    if (out.ok) authId = out.id;
  }
  const msg = [res.label, res.qty ? `${res.qty} sessão(ões)` : '', res.password ? `senha ${res.password}` : '', res.neg.join('; '), res.obs].filter(Boolean).join(' · ');
  await q('UPDATE tiss_auth_requests SET status = ?, op_guide = COALESCE(?, op_guide), auth_id = ?, message = ?, updated_at = NOW() WHERE id = ?', [status, res.opGuide || null, authId || null, msg.slice(0, 500), reqRow.id]);
  return { ok: true, status, message: msg, authId };
}
export async function requestAuth(planId, { sessions, procId, indication }, userId) {
  const pl = await one('SELECT pp.*, p.name patient, p.owner_id, i.sessions_per_auth, i.ans_code FROM patient_plans pp JOIN patients p ON p.id = pp.patient_id JOIN insurers i ON i.id = pp.insurer_id WHERE pp.id = ? AND pp.active = 1', [planId]);
  if (!pl) return { ok: false, error: 'Carteirinha não encontrada.' };
  const c = await config(pl.insurer_id); const pr = await prestador(c, pl.owner_id); const cfg = await T.config();
  const proc = (procId && await one('SELECT * FROM insurer_procs WHERE id = ? AND insurer_id = ?', [procId, pl.insurer_id])) || await one('SELECT * FROM insurer_procs WHERE insurer_id = ? ORDER BY is_default DESC, id LIMIT 1', [pl.insurer_id]);
  if (!proc || !digits(proc.tuss_code)) return { ok: false, error: 'Cadastre o procedimento com o código TUSS na tabela do convênio.' };
  const pro = await one('SELECT name, crp FROM users WHERE id = ?', [pl.owner_id]);
  if (!digits(String(pro?.crp || '').split('/').pop())) return { ok: false, error: 'Falta o CRP do profissional do paciente.' };
  let card = ''; try { card = decrypt(pl.card_enc); } catch { /* ilegível */ }
  if (!card) return { ok: false, error: 'Carteirinha sem número.' };
  const qty = Math.min(999, Math.max(1, Math.round(Number(sessions)) || pl.sessions_per_auth || 10));
  const ins = await one('SELECT next_guide FROM insurers WHERE id = ?', [pl.insurer_id]);
  await q('UPDATE insurers SET next_guide = next_guide + 1 WHERE id = ?', [pl.insurer_id]);
  const guide = String(ins.next_guide);
  const r0 = await q('INSERT INTO tiss_auth_requests (patient_id, plan_id, proc_id, guide_number, sessions, status, created_by) VALUES (?,?,?,?,?,?,?)', [pl.patient_id, pl.id, proc.id, guide, qty, 'enviado', userId]);
  const body = X([['solicitacaoSP-SADT', [
    ['cabecalhoSolicitacao', [['registroANS', digits(pl.ans_code)], ['numeroGuiaPrestador', guide]]],
    ['tipoEtapaAutorizacao', '1'],
    ['dadosBeneficiario', [['numeroCarteira', T.t(card.replace(/\s/g, ''), 20)], ['atendimentoRN', 'N']]],
    ['dadosSolicitante', [['contratadoSolicitante', [pr.contratado]], ['nomeContratadoSolicitante', T.t(pr.name || (await T.clinicInfo()).name, 70)],
      ['profissionalSolicitante', [['nomeProfissional', T.t(pro.name, 70)], ['conselhoProfissional', cfg.conselho], ['numeroConselhoProfissional', T.t(digits(String(pro.crp).split('/').pop()), 15)], ['UF', cfg.uf], ['CBOS', cfg.cbos]]]]],
    ['caraterAtendimento', '1'], ['dataSolicitacao', todayLocal()], ['indicacaoClinica', indication ? T.t(indication, 500) : ''],
    ['procedimentosSolicitados', [['procedimento', [['codigoTabela', '22'], ['codigoProcedimento', T.t(digits(proc.tuss_code), 10)], ['descricaoProcedimento', T.t(proc.description, 150)]]], ['quantidadeSolicitada', String(qty)]]],
  ]]]);
  const r = await call(pl.insurer_id, 'autorizacao', body, { professionalId: pl.owner_id, userId, ref: `authreq:${r0.insertId}` });
  const row = await one('SELECT * FROM tiss_auth_requests WHERE id = ?', [r0.insertId]);
  if (!r.ok) { await q("UPDATE tiss_auth_requests SET status = 'erro', message = ?, updated_at = NOW() WHERE id = ?", [String(r.error).slice(0, 500), row.id]); return { ok: false, error: r.error, id: row.id }; }
  const res = authResult(r.tree);
  if (!res) { await q("UPDATE tiss_auth_requests SET status = 'analise', message = 'Recebida pela operadora (sem resposta imediata).', updated_at = NOW() WHERE id = ?", [row.id]); return { ok: true, status: 'analise', message: 'Recebida pela operadora.', id: row.id }; }
  return { ...(await applyAuth(row, res, userId)), id: row.id };
}
export async function authStatus(requestId, userId) {
  const row = await one('SELECT ar.*, pp.card_enc, pp.insurer_id, p.owner_id, i.ans_code FROM tiss_auth_requests ar JOIN patient_plans pp ON pp.id = ar.plan_id JOIN patients p ON p.id = ar.patient_id JOIN insurers i ON i.id = pp.insurer_id WHERE ar.id = ?', [requestId]);
  if (!row) return { ok: false, error: 'Pedido não encontrado.' };
  const c = await config(row.insurer_id); const pr = await prestador(c, row.owner_id);
  let card = ''; try { card = decrypt(row.card_enc); } catch { /* ilegível */ }
  const r = await call(row.insurer_id, 'statusAutorizacao', X([['identificacaoSolicitacao', [['registroANS', digits(row.ans_code)], ['numeroGuiaPrestador', row.guide_number]]], ['dadosBeneficiario', [['numeroCarteira', T.t(card.replace(/\s/g, ''), 20)], ['atendimentoRN', 'N']]], ['dadosContratado', [pr.contratado]]]),
    { professionalId: row.owner_id, userId, ref: `authreq:${row.id}` });
  if (!r.ok) return { ok: false, error: r.error };
  const res = authResult(r.tree); if (!res) return { ok: false, error: 'Resposta sem a situação da autorização.' };
  return applyAuth(row, res, userId);
}
export const authRequests = (patientId) => q('SELECT ar.*, i.name insurer FROM tiss_auth_requests ar JOIN patient_plans pp ON pp.id = ar.plan_id JOIN insurers i ON i.id = pp.insurer_id WHERE ar.patient_id = ? ORDER BY ar.id DESC LIMIT 10', [patientId]);

// ---------- lote, protocolo e demonstrativos ----------
const between = (xml, tag) => { const m = String(xml || '').match(new RegExp(`<ans:${tag}>([\\s\\S]*)</ans:${tag}>`)); return m ? m[1] : null; };
export async function sendBatch(batchId, userId) {
  const b = await one('SELECT * FROM tiss_batches WHERE id = ?', [batchId]);
  if (!b || b.status !== 'gerado') return { ok: false, error: 'Só um lote gerado (ainda não enviado) pode ser enviado.' };
  const body = between(b.xml, 'loteGuias'); if (!body) return { ok: false, error: 'XML do lote ilegível.' };
  const r = await call(b.insurer_id, 'lote', body, { professionalId: b.professional_id, userId, ref: `batch:${b.id}` });
  if (!r.ok) return r;
  const prot = Ret.val(Ret.deep(r.tree, 'detalheProtocolo')[0], 'numeroProtocolo');
  if (!prot) return { ok: false, error: 'A operadora não devolveu o número do protocolo.' };
  await T.markSent(b.id, prot);
  await q('UPDATE tiss_batches SET ws_sent = 1, op_status = 1, op_status_at = NOW() WHERE id = ?', [b.id]);
  return { ok: true, protocol: prot };
}
export async function batchStatus(batchId, userId) {
  const b = await one('SELECT * FROM tiss_batches WHERE id = ?', [batchId]);
  if (!b?.protocol) return { ok: false, error: 'O lote ainda não tem protocolo.' };
  const c = await config(b.insurer_id); const pr = await prestador(c, b.professional_id);
  const r = await call(b.insurer_id, 'statusProtocolo', X([['dadosPrestador', [pr.contratado]], ['numeroProtocolo', T.t(b.protocol, 12)]]), { professionalId: b.professional_id, userId, ref: `batch:${b.id}` });
  if (!r.ok) return r;
  const st = Ret.val(Ret.deep(r.tree, 'detalheLote')[0], 'statusProtocolo');
  if (!st) return { ok: false, error: 'Resposta sem a situação do protocolo.' };
  await q('UPDATE tiss_batches SET op_status = ?, op_status_at = NOW() WHERE id = ?', [Number(st), b.id]);
  return { ok: true, status: Number(st), label: PROTOCOL_STATUS[st] || `situação ${st}` };
}
export async function fetchAnalysis(batchId, userId) {
  const b = await one('SELECT * FROM tiss_batches WHERE id = ?', [batchId]);
  if (!b?.protocol) return { ok: false, error: 'O lote ainda não tem protocolo.' };
  const c = await config(b.insurer_id); const pr = await prestador(c, b.professional_id);
  const r = await call(b.insurer_id, 'demonstrativo', X([['demonstrativoAnalise', [['dadosPrestador', [pr.contratado]], ['dataSolicitacao', todayLocal()], ['protocolos', [['numeroProtocolo', T.t(b.protocol, 12)]]]]]]), { professionalId: b.professional_id, userId, ref: `batch:${b.id}` });
  if (!r.ok) return r;
  return Ret.importDemo(r.buf, { fileName: `webservice-analise-lote-${b.lot_number}.xml`, userId });
}
export async function fetchPayments(insurerId, competence, userId) {
  const c = await config(insurerId); const pr = await prestador(c);
  const r = await call(insurerId, 'demonstrativo', X([['demonstrativoPagamento', [['dadosPrestador', [pr.contratado]], ['dataSolicitacao', todayLocal()], ['tipoDemonstrativo', '1'], ['periodo', [['competencia', competence.replace('-', '')]]]]]]), { userId, ref: `pagamentos:${competence}` });
  if (!r.ok) return r;
  return Ret.importDemo(r.buf, { fileName: `webservice-pagamento-${competence}.xml`, userId });
}

// ---------- recurso de glosa ----------
export async function sendAppeal(appealId, userId) {
  const a = await one('SELECT ap.*, b.insurer_id, b.professional_id FROM tiss_appeals ap JOIN tiss_batches b ON b.id = ap.batch_id WHERE ap.id = ?', [appealId]);
  if (!a || a.status !== 'rascunho') return { ok: false, error: 'Só um recurso ainda não enviado pode ser enviado.' };
  const g = between(a.xml, 'guiaRecursoGlosa'); if (!g) return { ok: false, error: 'XML do recurso ilegível.' };
  const r = await call(a.insurer_id, 'recurso', `<ans:guiaRecursoGlosa>${g}</ans:guiaRecursoGlosa>`, { professionalId: a.professional_id, userId, ref: `appeal:${a.id}` });
  if (!r.ok) return r;
  const prot = Ret.val(Ret.deep(r.tree, 'protocoloRecebimento')[0], 'nrProtocoloRecursoGlosa');
  if (!prot) return { ok: false, error: 'A operadora não devolveu o protocolo do recurso.' };
  await Ret.markAppealSent(a.id, prot);
  return { ok: true, protocol: prot };
}
export async function appealStatus(appealId, userId) {
  const a = await one('SELECT ap.*, b.insurer_id, b.professional_id FROM tiss_appeals ap JOIN tiss_batches b ON b.id = ap.batch_id WHERE ap.id = ?', [appealId]);
  if (!a?.protocol) return { ok: false, error: 'O recurso ainda não tem protocolo.' };
  const c = await config(a.insurer_id); const pr = await prestador(c, a.professional_id);
  const r = await call(a.insurer_id, 'statusRecurso', X([['dadosPrestador', [pr.contratado]], ['numeroProtocolo', T.t(a.protocol, 12)]]), { professionalId: a.professional_id, userId, ref: `appeal:${a.id}` });
  if (!r.ok) return r;
  const st = Ret.deep(r.tree, 'reciboGlosaStatus')[0];
  const recibo = Ret.deep(r.tree, 'reciboGlosa')[0];
  if (!recibo) return { ok: true, answered: false, message: st ? `Situação: ${PROTOCOL_STATUS[Ret.deep(st, 'statusProtocolo')[0]?.text.trim()] || 'em análise'}.` : 'Recurso ainda em análise na operadora.' };
  // resposta com os valores acatados por item: preenche o recuperado
  const items = await Ret.appealItems(a.id); const values = {};
  for (const it of Ret.deep(recibo, 'respostaGuiaItens').concat(Ret.deep(recibo, 'itensGuia'))) {
    const g = Ret.val(it, 'numeroGuiaPrestador'); const v = Number(Ret.val(it, 'valorAcatadado') || Ret.val(it, 'valorAcatado') || 0);
    const same = items.filter((x) => String(x.guide_number) === g.replace(/^0+(?=\d)/, ''));
    const target = same.find((x) => values[x.id] === undefined) || same[0];
    if (target) values[target.id] = (values[target.id] || 0) + v;
  }
  for (const g of Ret.deep(recibo, 'respostaGuia')) { // guia inteira acatada ou não
    const n = Ret.val(g, 'numeroGuiaPrestador').replace(/^0+(?=\d)/, ''); const ok = Ret.val(g, 'recursoGuiaAcatado') === 'S';
    for (const x of items.filter((y) => String(y.guide_number) === n && values[y.id] === undefined)) values[x.id] = ok ? Number(x.appeal_value) : 0;
  }
  if (!Object.keys(values).length) return { ok: true, answered: false, message: 'A operadora respondeu, mas sem os valores por sessão. Lance a resposta à mão.' };
  const out = await Ret.answerAppeal(a.id, values, { userId });
  return { ok: out.ok, answered: true, recovered: out.recovered, error: out.error, message: `Resposta da operadora registrada: recuperado R$ ${Number(out.recovered || 0).toFixed(2).replace('.', ',')}.` };
}
export { addDays };
