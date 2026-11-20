// IA na sessão: grava (com autorização do paciente), transcreve e redige o rascunho da evolução,
// que a(o) psicóloga(o) revisa antes de salvar no prontuário.
// - O áudio fica criptografado em partes no banco só até a transcrição e é apagado em seguida.
// - A transcrição e o rascunho ficam criptografados até salvar ou descartar (no máximo 7 dias).
// - A redação usa a mesma IA e chave configuradas em Documentos psicológicos → Escrita com IA.
import { q, one, getSetting, setSetting } from './db.js';
import { can } from './perm.js';
import { encrypt, decrypt, encryptBuf, decryptBuf } from './crypto.js';
import { nowLocal } from './time.js';
import * as AP from './aiproviders.js';
import * as Agent from './agent.js';
import * as PsyDocs from './psydocs.js';
import * as Live from './live.js';
import * as RT from './richtext.js';

export const MAX_BYTES = 24 * 1024 * 1024; // limite de arquivo dos provedores de transcrição (25 MB)
export const MAX_CHUNK = 3 * 1024 * 1024;
export const DEFAULT_TEMPLATE = `Demanda e temas trazidos:
Intervenções e técnicas utilizadas:
Observações clínicas (humor, afeto, comportamento):
Evolução em relação às sessões anteriores:
Tarefas e encaminhamentos combinados:
Plano para a próxima sessão:`;
const DEFAULTS = { enabled: false, users: [], sttProvider: 'groq', sttModel: 'whisper-large-v3-turbo', sttBaseUrl: '', useHistory: true, maxMin: 110, template: DEFAULT_TEMPLATE };

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('session_ai')) || '{}'); } catch { /* padrão */ }
  const out = { ...DEFAULTS, ...c };
  if (!AP.STT[out.sttProvider]) out.sttProvider = 'groq';
  if (!out.sttModel) out.sttModel = AP.STT[out.sttProvider].models[0] || '';
  try { out.sttKey = c.stt_key_enc ? decrypt(c.stt_key_enc) : ''; } catch { out.sttKey = ''; }
  delete out.stt_key_enc;
  return out;
}
export function checkInput(b) {
  const p = AP.STT[b.sttProvider] ? b.sttProvider : 'groq';
  if (!String(b.sttModel || '').trim()) return 'Informe o modelo de transcrição.';
  if (p === 'custom' && AP.checkUrl(b.sttBaseUrl)) return AP.checkUrl(b.sttBaseUrl);
  const k = String(b.stt_key || '').trim();
  if (k && AP.checkKey(p, k)) return AP.checkKey(p, k);
  return null;
}
export async function saveConfig(b) {
  const cur = await config();
  const sttProvider = AP.STT[b.sttProvider] ? b.sttProvider : 'groq';
  let key = cur.sttKey && cur.sttProvider === sttProvider ? cur.sttKey : '';
  if (b.stt_key_remove) key = '';
  if (String(b.stt_key || '').trim()) key = String(b.stt_key).trim();
  await setSetting('session_ai', JSON.stringify({
    enabled: !!b.enabled, users: [].concat(b.users || []).map(Number).filter((n) => n > 0),
    sttProvider, sttModel: String(b.sttModel || '').trim().slice(0, 80), sttBaseUrl: String(b.sttBaseUrl || '').trim().slice(0, 300),
    useHistory: !!b.useHistory, maxMin: Math.min(180, Math.max(10, Number(b.maxMin) || DEFAULTS.maxMin)),
    template: String(b.template || '').trim().slice(0, 3000) || DEFAULT_TEMPLATE, stt_key_enc: key ? encrypt(key) : null,
  }));
}
export const allowed = (c, user) => !!c.enabled && ['admin', 'psicologo'].includes(user.role) && can(user, 'prontuario') && (!c.users.length || c.users.includes(user.id));

// Chave da transcrição: a cadastrada aqui; senão reaproveita uma chave do mesmo provedor (sua, de documentos ou do atendente).
export async function sttKeyFor(c, userId) {
  const base = { provider: c.sttProvider, model: c.sttModel, baseUrl: c.sttBaseUrl };
  const own = await PsyDocs.userAi(userId);
  const doc = await PsyDocs.aiConfig();
  const ownOk = own.key && own.provider === c.sttProvider && doc.keyMode !== 'clinica';
  if (ownOk && doc.keyMode === 'profissional') return { ...base, key: own.key, owner: 'profissional' };
  if (c.sttKey) return { ...base, key: c.sttKey, owner: 'clinica' };
  if (doc.clinicKey && doc.provider === c.sttProvider) return { ...base, key: doc.clinicKey, owner: 'clinica' };
  const ag = await Agent.config();
  if (ag.groqKey && (ag.altProvider || 'groq') === c.sttProvider) return { ...base, key: ag.groqKey, owner: 'clinica' };
  if (ownOk) return { ...base, key: own.key, owner: 'profissional' };
  return { error: `Falta a chave de transcrição (${AP.STT[c.sttProvider].label}) em Configurações → IA na sessão.` };
}

// ---------- autorização do paciente ----------
export async function consentOf(p) {
  const l = await one(`SELECT id, decided_at FROM consent_links WHERE patient_id = ? AND status = 'aceito' AND docs LIKE '%"kind":"gravacao_ia"%' ORDER BY decided_at DESC LIMIT 1`, [p.id]);
  const marks = [l?.decided_at && { at: String(l.decided_at), how: 'termo digital' }, p.ai_rec_paper_at && { at: String(p.ai_rec_paper_at), how: 'termo em papel' }].filter(Boolean).sort((a, b) => (a.at < b.at ? 1 : -1));
  const last = marks[0];
  const revoked = p.ai_rec_revoked_at ? String(p.ai_rec_revoked_at) : null;
  if (last && (!revoked || last.at > revoked)) return { ok: true, at: last.at, how: last.how };
  return { ok: false, revoked };
}
export const markPaper = (pid) => q('UPDATE patients SET ai_rec_paper_at = NOW() WHERE id = ?', [pid]);
export const revoke = (pid) => q('UPDATE patients SET ai_rec_revoked_at = NOW() WHERE id = ?', [pid]);

// ---------- gravações ----------
const shape = (r) => r && ({ ...r, transcript: r.transcript_enc ? safe(r.transcript_enc) : '', draft: r.draft_enc ? safe(r.draft_enc) : '', alerts: r.alerts_enc ? safe(r.alerts_enc) : '' });
function safe(x) { try { return decrypt(x); } catch { return ''; } }
export const get = async (id) => shape(await one('SELECT * FROM session_rec WHERE id = ?', [id]));
export const openFor = async (pid, uid) => (await q("SELECT * FROM session_rec WHERE patient_id = ? AND user_id = ? AND status IN ('gravando','processando','pronto','erro') ORDER BY id DESC LIMIT 5", [pid, uid])).map(shape);
export const chunkCount = async (id) => Number((await one('SELECT COUNT(*) n FROM session_rec_chunks WHERE rec_id = ?', [id])).n);

async function apptFor(pid) {
  const a = await one(`SELECT id FROM appointments WHERE patient_id = ? AND status NOT IN ('cancelada','falta') AND DATE(starts_at) = CURDATE()
    ORDER BY ABS(TIMESTAMPDIFF(MINUTE, starts_at, NOW())) LIMIT 1`, [pid]);
  return a?.id || null;
}
export async function start(patient, user, { source = 'gravacao', mime = '', apptId = null } = {}) {
  // sessão informada (teleconsulta) só vale se for deste paciente
  const appt = apptId ? (await one('SELECT id FROM appointments WHERE id = ? AND patient_id = ?', [apptId, patient.id]))?.id : null;
  const r = await q('INSERT INTO session_rec (patient_id, user_id, appointment_id, source, mime) VALUES (?,?,?,?,?)',
    [patient.id, user.id, appt || await apptFor(patient.id), source === 'arquivo' ? 'arquivo' : 'gravacao', String(mime || '').slice(0, 80) || null]);
  return r.insertId;
}
export async function addChunk(rec, seq, buf) {
  if (rec.status !== 'gravando') return { ok: false, error: 'Esta gravação já foi encerrada.' };
  if (!buf?.length) return { ok: true, bytes: rec.bytes };
  if (rec.bytes + buf.length > MAX_BYTES) return { ok: false, limit: true, error: 'A gravação chegou ao limite de tamanho (cerca de 2 horas). Encerre para gerar o rascunho.' };
  const r = await q('INSERT IGNORE INTO session_rec_chunks (rec_id, seq, data) VALUES (?,?,?)', [rec.id, seq, encryptBuf(buf)]);
  if (r.affectedRows) await q('UPDATE session_rec SET bytes = bytes + ? WHERE id = ?', [buf.length, rec.id]);
  return { ok: true, bytes: rec.bytes + (r.affectedRows ? buf.length : 0) };
}
export async function finish(rec, durationS) {
  if (rec.status !== 'gravando') return;
  await q("UPDATE session_rec SET status = 'processando', step = 'transcrevendo', duration_s = ?, error = NULL WHERE id = ?", [Math.max(0, Math.min(6 * 3600, Number(durationS) || 0)), rec.id]);
  setImmediate(() => run(rec.id).catch((e) => console.error('IA na sessão', e.message)));
}
export async function fromText(patient, user, text) {
  const r = await q("INSERT INTO session_rec (patient_id, user_id, appointment_id, source, status, step, transcript_enc) VALUES (?,?,?, 'texto', 'processando', 'redigindo', ?)",
    [patient.id, user.id, await apptFor(patient.id), encrypt(String(text).slice(0, 200000))]);
  setImmediate(() => run(r.insertId).catch((e) => console.error('IA na sessão', e.message)));
  return r.insertId;
}
export async function retry(rec) {
  if (rec.status !== 'erro') return { ok: false, error: 'Nada para tentar de novo.' };
  if (!rec.transcript_enc && !(await chunkCount(rec.id))) return { ok: false, error: 'O áudio desta gravação já foi apagado. Grave de novo ou cole a transcrição.' };
  await q("UPDATE session_rec SET status = 'processando', step = ?, error = NULL WHERE id = ?", [rec.transcript_enc ? 'redigindo' : 'transcrevendo', rec.id]);
  setImmediate(() => run(rec.id).catch((e) => console.error('IA na sessão', e.message)));
  return { ok: true };
}
export async function discard(rec) {
  await q('DELETE FROM session_rec_chunks WHERE rec_id = ?', [rec.id]);
  await q("UPDATE session_rec SET status = 'descartado', transcript_enc = NULL, draft_enc = NULL, alerts_enc = NULL WHERE id = ?", [rec.id]);
}
export async function markSaved(recId, userId, patientId, recordId) {
  const rec = await one("SELECT id FROM session_rec WHERE id = ? AND user_id = ? AND patient_id = ? AND status = 'pronto'", [recId, userId, patientId]);
  if (!rec) return false;
  await q('DELETE FROM session_rec_chunks WHERE rec_id = ?', [rec.id]);
  await q("UPDATE session_rec SET status = 'salvo', record_id = ?, transcript_enc = NULL, draft_enc = NULL, alerts_enc = NULL WHERE id = ?", [recordId, rec.id]);
  return true;
}

const SYSTEM = `Você ajuda psicólogas e psicólogos no Brasil a registrar a evolução da sessão no prontuário (Resolução CFP nº 01/2009 e Código de Ética Profissional do Psicólogo).
Você recebe a transcrição automática de uma sessão, sem identificação de quem fala: deduza pelo contexto o que é fala da(o) psicóloga(o) e o que é fala do paciente.

Regras:
- Português técnico, claro, objetivo e conciso: registre o essencial para a continuidade do cuidado, não uma ata. Não transcreva falas longas; use citação curta só quando for clinicamente relevante.
- Siga exatamente as seções do modelo, na mesma ordem e com os mesmos títulos. Texto simples: sem Markdown, sem asteriscos.
- Refira-se ao paciente como {paciente}. Não escreva nomes de outras pessoas: use a relação (mãe, chefe, parceiro, amiga).
- Nunca invente. Não registre diagnóstico, CID ou hipótese diagnóstica que a(o) psicóloga(o) não tenha dito. Seção sem conteúdo: "Não abordado.".
- A transcrição automática pode conter erros: palavra importante duvidosa ou trecho confuso, sinalize com [verificar].
- Ao final, numa linha sozinha, escreva exatamente "PONTOS DE ATENÇÃO:" e, abaixo, em tópicos curtos iniciados por "- ", sinais que pedem atenção da(o) psicóloga(o) (ideação suicida, autolesão, violência, abuso, uso de substâncias, risco a terceiros, crise), cada um com o motivo. Se não houver, escreva "- Nenhum identificado.".`;

async function step(id, s) { await q('UPDATE session_rec SET step = ? WHERE id = ?', [s, id]); }
async function fail(id, msg) { await q("UPDATE session_rec SET status = 'erro', step = NULL, error = ? WHERE id = ?", [String(msg).slice(0, 300), id]); Live.emit('sessao-ia'); }

async function run(id) {
  const rec = await one('SELECT * FROM session_rec WHERE id = ?', [id]);
  if (!rec || rec.status !== 'processando') return;
  const c = await config();
  const user = await one('SELECT id, role FROM users WHERE id = ?', [rec.user_id]);
  const patient = await one('SELECT * FROM patients WHERE id = ?', [rec.patient_id]);
  if (!user || !patient) return fail(id, 'Paciente ou profissional não encontrado.');
  let transcript = rec.transcript_enc ? safe(rec.transcript_enc) : '';
  if (!transcript) {
    await step(id, 'transcrevendo');
    const k = await sttKeyFor(c, user.id);
    if (k.error) return fail(id, k.error);
    const parts = await q('SELECT data FROM session_rec_chunks WHERE rec_id = ? ORDER BY seq', [id]);
    if (!parts.length) return fail(id, 'Nenhum áudio foi recebido. Verifique o microfone e grave de novo.');
    let buf;
    try { buf = Buffer.concat(parts.map((x) => decryptBuf(x.data))); } catch { return fail(id, 'Não foi possível ler o áudio gravado.'); }
    const mime = rec.mime || 'audio/webm';
    const ext = /mp4|m4a|aac/.test(mime) ? 'm4a' : /mpeg|mp3/.test(mime) ? 'mp3' : /wav/.test(mime) ? 'wav' : /ogg/.test(mime) ? 'ogg' : 'webm';
    try {
      transcript = await AP.transcribe(k.provider, k.key, k.baseUrl, { buf, mime: mime.split(';')[0], filename: `sessao.${ext}`, model: k.model, prompt: 'Sessão de psicoterapia em português do Brasil.' });
    } catch (e) {
      return fail(id, `Transcrição: ${e.message}${k.owner === 'profissional' ? ' (sua chave)' : ''}`);
    }
    // sem a duração (arquivo que o navegador não leu): estimativa pelo tamanho e formato
    const dur = rec.duration_s || Math.round(rec.bytes / (/wav/.test(mime) ? 32000 : /webm|ogg|opus/.test(mime) ? 3000 : 16000));
    const price = AP.STT[k.provider]?.usdPerMin?.[k.model] || 0;
    await PsyDocs.logUse(user.id, k, 'transcricao', k.model, 0, 0, Number(((dur / 60) * price).toFixed(5)));
    await q('DELETE FROM session_rec_chunks WHERE rec_id = ?', [id]); // o áudio é apagado logo após a transcrição
    if (!transcript) return fail(id, 'A transcrição voltou vazia (áudio sem fala ou muito baixo).');
    await q('UPDATE session_rec SET transcript_enc = ?, duration_s = ? WHERE id = ?', [encrypt(transcript), dur, id]);
  }
  await step(id, 'redigindo');
  const doc = await PsyDocs.aiConfig();
  const k = await PsyDocs.aiKeyFor(doc, user.id);
  if (k.error) return fail(id, `Redação: ${k.error}`);
  let history = '';
  if (c.useHistory) {
    // só os registros escritos por este profissional (o prontuário de cada um é só dele)
    const rows = await q("SELECT record_date, content_enc, format FROM records WHERE patient_id = ? AND author_id = ? AND kind = 'evolucao' ORDER BY record_date DESC, id DESC LIMIT 3", [patient.id, user.id]);
    history = rows.reverse().map((r) => `- ${String(r.record_date).slice(0, 10).split('-').reverse().join('/')}: ${PsyDocs.pseudonymize(RT.recordText(safe(r.content_enc), r.format), patient).slice(0, 2000)}`).join('\n');
  }
  const user0 = `Duração aproximada da sessão: ${Math.max(1, Math.round((rec.duration_s || 0) / 60)) || '?'} min

Modelo de evolução do consultório (use estas seções):
"""
${c.template}
"""${history ? `\n\nEvoluções anteriores deste paciente (sem identificação), para a seção de evolução:\n"""\n${history}\n"""` : ''}

Transcrição automática da sessão (sem identificação):
"""
${PsyDocs.pseudonymize(transcript, patient).slice(0, 150000)}
"""`;
  const w = await PsyDocs.aiWrite(k, SYSTEM, user0);
  if (w.model) await PsyDocs.logUse(user.id, k, 'sessao', w.model, w.inTok, w.outTok, w.cost);
  if (!w.ok) return fail(id, w.refusal ? 'A IA não conseguiu redigir esta evolução. Escreva manualmente a partir da transcrição.' : `Redação: ${w.error}`);
  const first = String(patient.social_name || patient.name || 'paciente').trim().split(/\s+/)[0];
  const clean = w.text.replace(/\*\*/g, '').replace(/\{paciente\}/g, first);
  const m = clean.split(/^\s*PONTOS DE ATENÇÃO:?\s*$/im);
  const draft = m[0].trim();
  const alerts = (m[1] || '').trim();
  const noAlerts = !alerts || /^-?\s*nenhum/i.test(alerts);
  await q("UPDATE session_rec SET status = 'pronto', step = NULL, draft_enc = ?, alerts_enc = ? WHERE id = ?", [encrypt(draft), noAlerts ? null : encrypt(alerts), id]);
  Live.emit('sessao-ia');
}

// Resumo curto da sessão (a partir da transcrição), para consulta rápida ou para completar o registro
const SUMMARY = `Você ajuda psicólogas e psicólogos no Brasil a registrar sessões (Resolução CFP nº 01/2009).
Receberá a transcrição automática de uma sessão, sem identificação de quem fala. Escreva um RESUMO CURTO da sessão em português, em 5 a 8 tópicos iniciados por "- ":
temas principais trazidos, como o paciente se apresentou, intervenções e combinados (tarefas, próximos passos).
Regras: texto simples sem Markdown; refira-se ao paciente como {paciente}; não use nomes de outras pessoas (use a relação: mãe, chefe…); nunca invente; não registre diagnóstico que não tenha sido dito; trecho duvidoso: [verificar].`;
export async function summarize(rec) {
  if (!rec?.transcript_enc) return { ok: false, error: 'A transcrição desta sessão não está disponível.' };
  const patient = await one('SELECT * FROM patients WHERE id = ?', [rec.patient_id]);
  const doc = await PsyDocs.aiConfig();
  const k = await PsyDocs.aiKeyFor(doc, rec.user_id);
  if (k.error) return { ok: false, error: k.error };
  const tr = PsyDocs.pseudonymize(safe(rec.transcript_enc), patient).slice(0, 150000);
  const w = await PsyDocs.aiWrite(k, SUMMARY, `Transcrição automática (sem identificação):\n"""\n${tr}\n"""`, { effort: 'low' });
  if (w.model) await PsyDocs.logUse(rec.user_id, k, 'resumo', w.model, w.inTok, w.outTok, w.cost);
  if (!w.ok) return { ok: false, error: w.refusal ? 'A IA não conseguiu resumir esta sessão.' : w.error };
  const first = String(patient.social_name || patient.name || 'paciente').trim().split(/\s+/)[0];
  return { ok: true, summary: w.text.replace(/\*\*/g, '').replace(/\{paciente\}/g, first).trim() };
}

// Limpeza: processamento interrompido vira erro; áudio esquecido some em 24 h; rascunhos não salvos em 7 dias.
export async function tick() {
  await q("UPDATE session_rec SET status = 'erro', step = NULL, error = 'O processamento foi interrompido. Tente de novo.' WHERE status = 'processando' AND updated_at < DATE_SUB(NOW(), INTERVAL 20 MINUTE)");
  const old = await q("SELECT id FROM session_rec WHERE status IN ('gravando','erro') AND updated_at < DATE_SUB(NOW(), INTERVAL 24 HOUR)");
  for (const r of old) await discard(r);
  const stale = await q("SELECT id FROM session_rec WHERE status = 'pronto' AND updated_at < DATE_SUB(NOW(), INTERVAL 7 DAY)");
  for (const r of stale) await discard(r);
}
export async function usage(days = 30) {
  return one(`SELECT COUNT(DISTINCT CASE WHEN kind = 'sessao' THEN id END) n, COALESCE(SUM(cost_usd),0) cost FROM ai_doc_usage WHERE kind IN ('sessao','transcricao') AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)`, [days]);
}
export const now = nowLocal;
