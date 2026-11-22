// Documentos psicológicos (Resolução CFP nº 06/2019): declaração, atestado, relatório, laudo e parecer.
// Gerados a partir da ficha, editáveis até a emissão; ao emitir ficam imutáveis (resumo SHA-256),
// com assinatura eletrônica do profissional e código de verificação público (sem o conteúdo).
import * as Brand from './brand.js';
import * as RT from './richtext.js';
import crypto from 'node:crypto';
import { cpfFmt } from './br.js';
import Anthropic from '@anthropic-ai/sdk';
import { q, one, getSetting, setSetting } from './db.js';
import * as Agent from './agent.js';
import * as AP from './aiproviders.js';
import * as Slot from './aislot.js';
import { encrypt, decrypt } from './crypto.js';
import { todayLocal, longDate } from './time.js';
import { proName } from './perm.js';

export const KINDS = {
  declaracao: { label: 'Declaração', title: 'DECLARAÇÃO', desc: 'Comparecimento, horário e acompanhamento. Não traz informação sobre o estado psicológico.' },
  atestado: { label: 'Atestado psicológico', title: 'ATESTADO PSICOLÓGICO', desc: 'Atesta condição psicológica (aptidão, afastamento, justificativa) com base na avaliação.' },
  relatorio: { label: 'Relatório psicológico', title: 'RELATÓRIO PSICOLÓGICO', desc: 'Comunica a atuação profissional: demanda, procedimentos, análise e conclusão.' },
  laudo: { label: 'Laudo psicológico', title: 'LAUDO PSICOLÓGICO', desc: 'Resultado de avaliação psicológica, com fundamentação técnica e referências.' },
  parecer: { label: 'Parecer psicológico', title: 'PARECER PSICOLÓGICO', desc: 'Resposta técnica a uma questão específica (análise de documento ou situação).' },
};
export const VARS = { paciente: 'nome do paciente', cpf: 'CPF do paciente', nascimento: 'data de nascimento', profissional: 'Dr./Dra. responsável', crp: 'CRP', data: 'data de hoje por extenso', data_sessao: 'data da sessão escolhida', inicio: 'horário de início', fim: 'horário de término', finalidade: 'finalidade informada', solicitante: 'quem solicitou', cidade: 'cidade' };

const DEFAULTS = {
  declaracao: `Declaro, para os devidos fins, que {paciente}, inscrito(a) no CPF {cpf}, compareceu a atendimento psicológico no dia {data_sessao}, das {inicio} às {fim}.

Finalidade: {finalidade}.`,
  atestado: `Atesto, para fins de {finalidade}, a pedido de {solicitante}, que {paciente}, inscrito(a) no CPF {cpf}, encontra-se em acompanhamento psicológico comigo.

[Descreva aqui a condição psicológica atestada, com base na avaliação realizada, e o período de afastamento ou a recomendação, se houver.]

O registro deste atendimento consta em prontuário, nos termos da Resolução CFP nº 01/2009.`,
  relatorio: `1. IDENTIFICAÇÃO
Autora/Autor: {profissional} — CRP {crp}
Interessado(a): {paciente}
Solicitante: {solicitante}
Finalidade: {finalidade}

2. DESCRIÇÃO DA DEMANDA
[Motivo do atendimento e do pedido deste relatório.]

3. PROCEDIMENTO
[Número de sessões, período, abordagem (Terapia Cognitivo-Comportamental), instrumentos e recursos utilizados.]

4. ANÁLISE
[Exposição descritiva e fundamentada do que foi observado, restrita ao necessário para a finalidade.]

5. CONCLUSÃO
[Síntese, encaminhamentos e recomendações.]`,
  laudo: `1. IDENTIFICAÇÃO
Autora/Autor: {profissional} — CRP {crp}
Interessado(a): {paciente} — nascimento: {nascimento}
Solicitante: {solicitante}
Finalidade: {finalidade}

2. DESCRIÇÃO DA DEMANDA
[Motivo da avaliação psicológica.]

3. PROCEDIMENTO
[Fontes de informação, número de encontros, testes e técnicas utilizados (com referência e situação no SATEPSI).]

4. ANÁLISE
[Integração dos resultados, fundamentada teoricamente.]

5. CONCLUSÃO
[Resposta à demanda, hipóteses e indicações. Diagnóstico/CID apenas quando pertinente e com consentimento.]

6. REFERÊNCIAS
[Referências técnicas e científicas utilizadas.]`,
  parecer: `1. IDENTIFICAÇÃO
Parecerista: {profissional} — CRP {crp}
Solicitante: {solicitante}
Assunto: {finalidade}

2. DESCRIÇÃO DA DEMANDA
[Questão apresentada para análise.]

3. ANÁLISE
[Discussão técnica e fundamentada, com base na literatura e na prática psicológica.]

4. CONCLUSÃO
[Posicionamento técnico sobre a questão.]

5. REFERÊNCIAS
[Referências utilizadas.]`,
};

// Finalidades e solicitantes sugeridos (um clique preenche o campo; editáveis em Configurações → Documentos)
export const PURPOSES = {
  declaracao: ['Comprovação de comparecimento junto ao empregador', 'Justificativa de ausência no trabalho', 'Justificativa de ausência escolar ou acadêmica', 'Comprovação de acompanhamento psicológico', 'Reembolso junto ao plano de saúde', 'Apresentação à instituição de ensino'],
  atestado: ['Afastamento das atividades laborais', 'Justificativa de faltas', 'Aptidão psicológica para atividade específica', 'Acompanhamento de condição psicológica', 'Solicitação de condições especiais (provas, trabalho)'],
  relatorio: ['Encaminhamento para avaliação psiquiátrica', 'Encaminhamento para outro profissional de saúde', 'Atendimento a solicitação da escola', 'Atendimento a solicitação do plano de saúde', 'Acompanhamento multiprofissional', 'Atendimento a solicitação judicial'],
  laudo: ['Avaliação psicológica para cirurgia bariátrica', 'Avaliação psicológica para cirurgia (outras)', 'Avaliação psicológica para porte ou posse de arma', 'Avaliação psicológica para concurso público', 'Avaliação neuropsicológica', 'Avaliação para processo judicial'],
  parecer: ['Resposta a consulta técnica', 'Análise de documento psicológico', 'Orientação técnica à instituição solicitante'],
};
export const REQUESTERS = ['O(a) próprio(a) paciente', 'Responsável legal', 'Empregador', 'Instituição de ensino', 'Plano de saúde', 'Médico(a) assistente', 'Poder Judiciário'];
export async function options() {
  let o = {};
  try { o = JSON.parse((await getSetting('psydoc_options')) || '{}'); } catch { /* padrão */ }
  const purposes = {};
  for (const k of Object.keys(KINDS)) purposes[k] = Array.isArray(o.purposes?.[k]) ? o.purposes[k] : PURPOSES[k];
  return { purposes, requesters: Array.isArray(o.requesters) ? o.requesters : REQUESTERS, custom: !!o.purposes || !!o.requesters };
}
export async function saveOptions(b) {
  const lines = (v, max) => [...new Set(String(v || '').split(/\r?\n/).map((x) => x.trim().slice(0, max)).filter(Boolean))].slice(0, 30);
  if (b.padrao) return setSetting('psydoc_options', '{}');
  const purposes = {};
  for (const k of Object.keys(KINDS)) purposes[k] = lines(b[`p_${k}`], 200);
  await setSetting('psydoc_options', JSON.stringify({ purposes, requesters: lines(b.requesters, 160) }));
}
export async function templates() {
  let saved = {};
  try { saved = JSON.parse((await getSetting('psydoc_templates')) || '{}'); } catch { /* padrão */ }
  const out = {};
  for (const k of Object.keys(KINDS)) out[k] = { body: saved[k] || DEFAULTS[k], isDefault: !saved[k] };
  return out;
}
export async function saveTemplate(kind, body) {
  let saved = {};
  try { saved = JSON.parse((await getSetting('psydoc_templates')) || '{}'); } catch { /* padrão */ }
  if (body && body.trim() && body.trim() !== DEFAULTS[kind]) saved[kind] = body.trim().slice(0, 20000); else delete saved[kind];
  await setSetting('psydoc_templates', JSON.stringify(saved));
}

const fill = (text, v) => String(text).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined && v[k] !== '' ? v[k] : m));
const br = (d) => (d ? `${String(d).slice(8, 10)}/${String(d).slice(5, 7)}/${String(d).slice(0, 4)}` : '');
// Dados da ficha usados nos documentos (e quais estão faltando)
export async function docVars(patient, author, { apptId, purpose, requester } = {}) {
  const appt = apptId ? await one('SELECT starts_at, duration_min FROM appointments WHERE id = ? AND patient_id = ?', [apptId, patient.id]) : null;
  let fim = '';
  if (appt) { const [h, m] = String(appt.starts_at).slice(11, 16).split(':').map(Number); const t2 = h * 60 + m + Number(appt.duration_min || 40); fim = `${String(Math.floor(t2 / 60) % 24).padStart(2, '0')}:${String(t2 % 60).padStart(2, '0')}`; }
  let cpf = ''; try { cpf = patient.cpf_enc ? decrypt(patient.cpf_enc) : ''; } catch { /* sem CPF */ }
  return {
    paciente: patient.social_name || patient.name, cpf: cpf ? cpfFmt(cpf) : '[CPF]', nascimento: patient.birth_date ? br(patient.birth_date) : '[data de nascimento]',
    profissional: author ? proName(author) : '', crp: author?.crp || '[CRP]', data: longDate(todayLocal()), cidade: Brand.get().city || '[cidade]',
    data_sessao: appt ? br(appt.starts_at) : '[data]', inicio: appt ? String(appt.starts_at).slice(11, 16) : '[início]', fim: fim || '[término]',
    finalidade: purpose || '[finalidade]', solicitante: requester || 'o(a) próprio(a) interessado(a)',
  };
}
export async function draftBody(kind, patient, author, opts = {}) {
  const t = (await templates())[kind];
  return fill(t.body, await docVars(patient, author, opts));
}
// Finalidade/solicitante digitados depois de gerar o texto substituem os marcadores que ficaram
export function applyFields(body, { purpose, requester }) {
  let b = String(body || '');
  if (purpose) b = b.split('[finalidade]').join(purpose);
  if (requester) b = b.split('[solicitante]').join(requester);
  return b;
}

// ---------- documentos ----------
const DOC = 'SELECT d.*, p.name p_name, p.social_name p_social, p.owner_id p_owner, u.name author_name FROM psy_docs d JOIN patients p ON p.id = d.patient_id LEFT JOIN users u ON u.id = d.author_id';
const shape = (d) => (d ? { ...d, body: (() => { try { return decrypt(d.body_enc); } catch { return ''; } })() } : null);
export const get = async (id) => shape(await one(`${DOC} WHERE d.id = ?`, [id]));
export const forPatient = (pid) => q(`${DOC} WHERE d.patient_id = ? ORDER BY d.id DESC`, [pid]);
export const byShare = async (t) => (/^[A-Za-z0-9_-]{20,48}$/.test(String(t || '')) ? shape(await one(`${DOC} WHERE d.share_token = ?`, [t])) : null);
export const byCode = (c) => (/^[A-Z0-9]{8,12}$/.test(String(c || '')) ? one(`${DOC} WHERE d.verify_code = ?`, [String(c)]) : null);

export async function create(patientId, kind, { title, body, purpose, requester, apptId }, userId) {
  if (!KINDS[kind]) return { ok: false, error: 'Tipo de documento inválido.' };
  body = applyFields(body, { purpose, requester });
  const r = await q('INSERT INTO psy_docs (patient_id, author_id, kind, title, body_enc, purpose, requester, appointment_id) VALUES (?,?,?,?,?,?,?,?)',
    [patientId, userId, kind, String(title || KINDS[kind].title).slice(0, 120), encrypt(String(body || '').slice(0, 60000)), String(purpose || '').slice(0, 200) || null, String(requester || '').slice(0, 160) || null, apptId || null]);
  return { ok: true, id: r.insertId };
}
export async function update(id, { title, body, purpose, requester }) {
  const d = await one('SELECT status FROM psy_docs WHERE id = ?', [id]);
  if (!d || d.status !== 'rascunho') return { ok: false, error: 'Documento já emitido não pode ser alterado: cancele e emita outro.' };
  body = applyFields(body, { purpose, requester });
  await q('UPDATE psy_docs SET title = ?, body_enc = ?, purpose = ?, requester = ?, updated_at = NOW() WHERE id = ?', [String(title || '').slice(0, 120), encrypt(String(body || '').slice(0, 60000)), String(purpose || '').slice(0, 200) || null, String(requester || '').slice(0, 160) || null, id]);
  return { ok: true };
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.randomBytes(10), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
export const hashOf = (d, body) => crypto.createHash('sha256').update([d.kind, d.title, body, d.patient_id, d.author_id].join('\n')).digest('hex');
// Emitir: congela o texto, registra quem assinou e quando, e gera o código de verificação.
export async function issue(id, user) {
  const d = await get(id);
  if (!d || d.status !== 'rascunho') return { ok: false, error: 'Documento não está em rascunho.' };
  if (/\[[^\]]{3,}\]/.test(d.body)) return { ok: false, error: 'Ainda há campos entre colchetes [ ] para preencher no texto.' };
  if (!d.body.trim()) return { ok: false, error: 'O documento está vazio.' };
  let code = newCode();
  for (let i = 0; i < 5 && (await one('SELECT id FROM psy_docs WHERE verify_code = ?', [code])); i++) code = newCode();
  await q("UPDATE psy_docs SET status = 'emitido', hash = ?, verify_code = ?, signer_name = ?, signer_crp = ?, signed_at = NOW() WHERE id = ? AND status = 'rascunho'",
    [hashOf(d, d.body), code, proName(user), user.crp || null, id]);
  return { ok: true, code };
}
export async function cancel(id, reason) { await q("UPDATE psy_docs SET status = 'cancelado', cancel_reason = ?, share_token = NULL WHERE id = ? AND status = 'emitido'", [String(reason || '').slice(0, 200) || null, id]); }
export async function removeDraft(id) { await q("DELETE FROM psy_docs WHERE id = ? AND status = 'rascunho'", [id]); }
export async function share(id) {
  const t = crypto.randomBytes(18).toString('base64url');
  await q("UPDATE psy_docs SET share_token = ?, share_expires = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ? AND status = 'emitido'", [t, id]);
  return t;
}
export const intact = (d) => d.status !== 'rascunho' && d.hash === hashOf(d, d.body);

// ---------- PDF e assinatura digital ICP-Brasil ----------
// O PDF base é gerado uma vez (na primeira vez que é pedido) e guardado: é ele que recebe a assinatura,
// seja no sistema (certificado A1) seja fora (nuvem, token, assinador do ITI) e devolvido aqui.
export async function basePdf(d, base) {
  const f = await one('SELECT base FROM psy_doc_files WHERE doc_id = ?', [d.id]);
  if (f?.base) return Buffer.from(f.base);
  const { buildPdf } = await import('./pdfdoc.js');
  const author = d.author_id ? await one('SELECT signature_png FROM users WHERE id = ?', [d.author_id]) : null;
  const pdf = await buildPdf(d, { base, signaturePng: author?.signature_png || null });
  await q('INSERT INTO psy_doc_files (doc_id, base) VALUES (?, ?) ON DUPLICATE KEY UPDATE base = COALESCE(base, VALUES(base))', [d.id, pdf]);
  return Buffer.from((await one('SELECT base FROM psy_doc_files WHERE doc_id = ?', [d.id])).base);
}
export async function signedPdf(id) { const f = await one('SELECT signed FROM psy_doc_files WHERE doc_id = ?', [id]); return f?.signed ? Buffer.from(f.signed) : null; }
export async function saveSigned(id, pdf, sig, via) {
  await q('INSERT INTO psy_doc_files (doc_id, signed) VALUES (?, ?) ON DUPLICATE KEY UPDATE signed = VALUES(signed)', [id, pdf]);
  await q('UPDATE psy_docs SET icp_via = ?, icp_provider = ?, icp_name = ?, icp_cpf_enc = ?, icp_issuer = ?, icp_signed_at = NOW() WHERE id = ?',
    [via, sig.provider || null, String(sig.name || '').slice(0, 160), sig.cpf ? encrypt(sig.cpf) : null, String(sig.issuer || '').slice(0, 160), id]);
}
export const icpCpf = (d) => { try { return d.icp_cpf_enc ? decrypt(d.icp_cpf_enc) : ''; } catch { return ''; } };


// =====================================================================
// Escrita com IA (habilitada pelo administrador; chave da clínica ou do profissional)
// =====================================================================
export const KEY_MODES = { clinica: 'Chave da clínica (a mesma do atendente virtual)', profissional: 'Chave de cada profissional (cada um paga o próprio uso)', profissional_ou_clinica: 'Chave do profissional; se não tiver, a da clínica' };
const AI_DEFAULTS = { enabled: false, users: [], provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: '', keyMode: 'profissional_ou_clinica', allowRecords: false };
export const PROVIDERS = { anthropic: 'Anthropic (Claude)', ...Object.fromEntries(Object.entries(AP.PROVIDERS).map(([k, v]) => [k, v.label])) };
export async function aiConfig() {
  let c = {};
  try { c = JSON.parse((await getSetting('psydoc_ai')) || '{}'); } catch { /* padrão */ }
  const out = { ...AI_DEFAULTS, ...c };
  if (!PROVIDERS[out.provider]) out.provider = 'anthropic';
  if (out.provider === 'anthropic' && !Agent.MODELS[out.model]) out.model = AI_DEFAULTS.model;
  try { out.clinicKey = c.clinic_key_enc ? decrypt(c.clinic_key_enc) : ''; } catch { out.clinicKey = ''; }
  if (out.provider !== 'custom') out.baseUrl = ''; // endereço só vale para “Outro”
  out.first = { provider: out.provider, model: out.model, baseUrl: out.baseUrl, key: out.clinicKey, on: true };
  out.second = Slot.read(c.p2); // provedor secundário da clínica (reserva)
  return out;
}
// Formulário: vagas p1 (principal) e p2 (secundário). Devolve { error } ou grava.
export async function saveAiConfig(b) {
  const cur = await aiConfig();
  const r1 = Slot.fromBody(b, 'p1', cur.first, [cur.second]);
  const r2 = Slot.fromBody(b, 'p2', cur.second, [cur.first]);
  for (const [r, nm] of [[r1, 'Principal'], [r2, 'Secundário']]) {
    if (r.error) return { error: `${nm}: ${r.error}` };
    if (r.slot.on && r.slot.provider !== 'anthropic') {
      const x = r.slot.key ? r.slot : { ...r.slot, key: Agent.keyForProvider(await Agent.config(), r.slot.provider)?.key || '' };
      await Slot.fillModel(x); r.slot.model = x.model;
    }
    if (r.slot.on && r.slot.provider !== 'anthropic' && !r.slot.model) return { error: `${nm}: informe o modelo de ${Slot.labelOf(r.slot.provider)}.` };
  }
  const p1 = r1.slot;
  await setSetting('psydoc_ai', JSON.stringify({
    enabled: !!b.enabled, users: [].concat(b.users || []).map(Number).filter((n) => n > 0), provider: p1.provider, model: p1.model, baseUrl: p1.baseUrl,
    keyMode: KEY_MODES[b.keyMode] ? b.keyMode : AI_DEFAULTS.keyMode, allowRecords: !!b.allowRecords, clinic_key_enc: p1.key ? encrypt(p1.key) : null,
    p2: r2.slot.provider ? Slot.store(r2.slot) : null,
  }));
  return { ok: true };
}
export const aiAllowed = (c, user) => !!c.enabled && ['admin', 'psicologo'].includes(user.role) && (!c.users.length || c.users.includes(user.id));
// Chave própria do profissional (provedor, modelo e chave escolhidos por ele)
export async function userAi(userId) {
  const u = await one('SELECT ai_key_enc, ai_provider, ai_model, ai_base_url, ai2_json FROM users WHERE id = ?', [userId]);
  let key = ''; try { key = u?.ai_key_enc ? decrypt(u.ai_key_enc) : ''; } catch { /* inválida */ }
  let second = null; try { second = u?.ai2_json ? Slot.read(JSON.parse(u.ai2_json)) : null; } catch { second = null; }
  const provider = PROVIDERS[u?.ai_provider] ? u.ai_provider : 'anthropic';
  return { key, provider, model: u?.ai_model || '', baseUrl: provider === 'custom' ? u?.ai_base_url || '' : '', second };
}
// Qual chave (e provedor/modelo) paga esta geração
export async function aiKeyFor(c, userId) {
  const own = await userAi(userId);
  const ownCfg = own.key ? { key: own.key, owner: 'profissional', provider: own.provider, model: own.model || (own.provider === c.provider ? c.model : (own.provider === 'anthropic' ? AI_DEFAULTS.model : '')), baseUrl: own.baseUrl } : null;
  if (ownCfg && !ownCfg.model) ownCfg.error = 'Informe o modelo da sua chave em Conta → Escrita com IA.';
  // sem chave própria da escrita com IA, a clínica reaproveita a do atendente virtual do mesmo provedor
  const ag = await Agent.config();
  const clinicOf = (x) => { if (!x?.provider) return null; const key = x.key || Agent.keyForProvider(ag, x.provider)?.key || ''; return key ? { key, owner: 'clinica', provider: x.provider, model: x.model || (x.provider === 'anthropic' ? AI_DEFAULTS.model : ''), baseUrl: x.baseUrl } : null; };
  const clinicCfg = clinicOf(c.first);
  const clinic2 = c.second?.on ? clinicOf(c.second) : null;
  const s2 = own.second;
  const own2 = s2?.on && s2.key ? { key: s2.key, owner: 'profissional', provider: s2.provider, model: s2.model || (s2.provider === 'anthropic' ? AI_DEFAULTS.model : ''), baseUrl: s2.baseUrl } : null;
  // ordem de tentativa: o primeiro que funcionar escreve; os demais são reserva (aiWrite)
  const chain = (c.keyMode === 'profissional' ? [ownCfg, own2] : c.keyMode === 'clinica' ? [clinicCfg, clinic2] : [ownCfg, own2, clinicCfg, clinic2]).filter((x) => x && x.model);
  const head = chain.find((x) => !x.error);
  if (head) return { ...head, fallbacks: chain.filter((x) => x !== head && !x.error) };
  if (ownCfg?.error) return ownCfg;
  if (c.keyMode === 'profissional') return { error: 'Cadastre a sua chave de IA em Conta → Escrita com IA.' };
  if (c.keyMode === 'clinica') return { error: `A chave da clínica para ${PROVIDERS[c.provider]} não está configurada (Configurações → Documentos psicológicos).` };
  return { error: 'Nenhuma chave de IA configurada: cadastre a sua em Conta → Escrita com IA.' };
}

// Tira identificação do texto enviado à IA: nome vira {paciente}; CPF e telefones saem.
export function pseudonymize(text, patient) {
  let t = String(text || '');
  const names = [patient.name, patient.social_name].filter(Boolean).map((n) => n.trim()).sort((a, b) => b.length - a.length);
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const n of names) t = t.replace(new RegExp(esc(n), 'gi'), '{paciente}');
  for (const n of names) for (const w of n.split(/\s+/)) if (w.length >= 3 && !/^(da|de|do|das|dos)$/i.test(w)) t = t.replace(new RegExp(`\\b${esc(w)}\\b`, 'gi'), '{paciente}');
  t = t.replace(/\{paciente\}(\s+\{paciente\})+/g, '{paciente}');
  t = t.replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, '[CPF]').replace(/\(?\b\d{2}\)?\s?9?\d{4}-?\d{4}\b/g, '[telefone]');
  return t;
}
const SYSTEM = `Você ajuda psicólogas e psicólogos no Brasil a redigir documentos psicológicos conforme a Resolução CFP nº 06/2019 e o Código de Ética Profissional do Psicólogo.

Regras:
- Português formal, técnico, claro e objetivo. Restrinja-se ao estritamente necessário para a finalidade informada (sigilo profissional).
- Siga a estrutura do modelo recebido (mesmas seções e numeração). Texto simples: sem Markdown, sem asteriscos, sem títulos extras.
- Onde entram dados de identificação, use exatamente estes marcadores: {paciente}, {cpf}, {nascimento}, {profissional}, {crp}, {data_sessao}, {inicio}, {fim}, {finalidade}, {solicitante}. O sistema os preenche depois.
- Nunca invente fatos, datas, número de sessões, resultados de testes, diagnósticos ou CID. Use só o que estiver nas anotações. Quando faltar uma informação necessária, escreva uma instrução curta entre colchetes, por exemplo [informar o período de acompanhamento].
- Diagnóstico ou CID só se estiverem explicitamente nas anotações.
- Declaração não traz informação sobre o estado psicológico; atestado, relatório, laudo e parecer seguem a finalidade de cada um.
- Responda somente com o corpo do documento: sem título, sem local e data, sem assinatura (o sistema acrescenta).`;

export async function aiDraft({ kind, patient, author, user, notes, useRecords, apptId, purpose, requester }) {
  const c = await aiConfig();
  if (!aiAllowed(c, user)) return { ok: false, error: 'A escrita com IA não está liberada para você.' };
  if (!KINDS[kind]) return { ok: false, error: 'Tipo de documento inválido.' };
  const k = await aiKeyFor(c, user.id);
  if (k.error) return { ok: false, error: k.error };
  const tpl = (await templates())[kind].body;
  let records = '';
  if (useRecords && c.allowRecords) {
    // só as evoluções escritas por quem está redigindo (o prontuário de cada profissional é só dele)
    const rows = await q("SELECT record_date, content_enc, format FROM records WHERE patient_id = ? AND author_id = ? AND kind = 'evolucao' ORDER BY record_date DESC, id DESC LIMIT 8", [patient.id, user.id]);
    records = rows.reverse().map((r) => { let t = ''; try { t = RT.recordText(decrypt(r.content_enc), r.format); } catch { /* ilegível */ } return `- ${br(r.record_date)}: ${pseudonymize(t, patient).slice(0, 2500)}`; }).join('\n');
  }
  const n = await one("SELECT COUNT(*) n, MIN(starts_at) a, MAX(starts_at) b FROM appointments WHERE patient_id = ? AND status = 'realizada'", [patient.id]);
  const user0 = `Tipo de documento: ${KINDS[kind].label}
Finalidade: ${purpose ? pseudonymize(purpose, patient) : '{finalidade}'}
Solicitante: ${requester ? pseudonymize(requester, patient) : '{solicitante}'}
Sessões realizadas: ${n.n}${n.n ? ` (de ${br(n.a)} a ${br(n.b)})` : ''}

Modelo do consultório:
"""
${tpl}
"""

Anotações da(o) psicóloga(o) sobre o que o documento deve conter:
"""
${pseudonymize(notes, patient).slice(0, 8000) || '(sem anotações)'}
"""${records ? `\n\nEvoluções recentes do prontuário (sem identificação):\n"""\n${records}\n"""` : ''}`;
  const w = await aiWrite(k, SYSTEM, user0);
  if (w.model) await logUse(user.id, k, kind, w.model, w.inTok, w.outTok, w.cost);
  if (!w.ok) return { ok: false, error: w.refusal ? 'A IA não conseguiu redigir este documento. Escreva manualmente ou reformule as anotações.' : w.error };
  const text = w.text; const cost = w.cost;
  if (!text) return { ok: false, error: 'A IA não devolveu texto. Tente de novo.' };
  const vars = await docVars(patient, author, { apptId, purpose, requester });
  return { ok: true, body: fill(text.replace(/\*\*/g, ''), vars), owner: k.owner, cost, provider: k.provider };
}
// Chamada à IA de texto com a chave/provedor escolhidos (Claude ou provedor compatível com OpenAI).
// Escreve com o provedor da chave escolhida; se falhar (créditos, chave, limite, fora do ar), tenta os de reserva.
export async function aiWrite(k, system, user0, opts = {}) {
  let r = await aiWriteOne(k, system, user0, opts);
  k.used = k;
  if (r.ok || r.refusal || !k.fallbacks?.length) return r;
  for (const f of k.fallbacks) {
    const r2 = await aiWriteOne(f, system, user0, opts);
    if (r2.ok) { k.used = f; return { ...r2, via: f, note: `${PROVIDERS[k.provider]} não respondeu (${r.error}); o texto foi escrito por ${PROVIDERS[f.provider]}.` }; }
    r = r2;
  }
  return r;
}
async function aiWriteOne(k, system, user0, { effort = 'medium' } = {}) {
  const who = k.owner === 'profissional' ? ' (sua chave)' : ' (chave da clínica)';
  if (k.provider === 'anthropic') {
    const model = Agent.MODELS[k.model] ? k.model : AI_DEFAULTS.model;
    const client = new Anthropic({ apiKey: k.key, maxRetries: 2, timeout: 300e3 });
    let res;
    try {
      res = await client.beta.messages.create({
        model, max_tokens: 16000,
        ...(Agent.MODELS[model].fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
        output_config: { effort },
        system,
        messages: [{ role: 'user', content: user0 }],
      });
    } catch (e) {
      return { ok: false, error: `${Agent.classifyError(e).reason}${who}.` };
    }
    const usedModel = res.model || model;
    const out = { model: usedModel, cost: Agent.costOf(usedModel, res.usage), inTok: (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0), outTok: res.usage?.output_tokens || 0 };
    if (res.stop_reason === 'refusal') return { ...out, ok: false, refusal: true, error: 'A IA recusou o pedido.' };
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return text ? { ...out, ok: true, text } : { ...out, ok: false, error: 'A IA não devolveu texto. Tente de novo.' };
  }
  try {
    const data = await AP.chat(k.provider, k.key, k.baseUrl, { model: k.model, temperature: 0.3, messages: [{ role: 'system', content: system }, { role: 'user', content: user0 }] });
    const text = String(data.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    const out = { model: k.model, cost: 0, inTok: data.usage?.prompt_tokens || 0, outTok: data.usage?.completion_tokens || 0 };
    return text ? { ...out, ok: true, text } : { ...out, ok: false, error: 'A IA não devolveu texto. Tente de novo.' };
  } catch (e) {
    return { ok: false, error: `${e.message}${who}.` };
  }
}
export async function logUse(userId, k0, kind, model, inTok, outTok, cost) {
  const k = k0.used || k0;
  await q('INSERT INTO ai_doc_usage (user_id, key_owner, kind, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?,?,?)',
    [userId, k.owner, kind, `${k.provider === 'anthropic' ? '' : `${k.provider}:`}${model}`.slice(0, 60), inTok, outTok, cost]);
}
export async function aiUsage(days = 30) {
  return q(`SELECT u.id, u.name, u.title, x.key_owner, COUNT(*) n, SUM(x.cost_usd) cost, SUM(x.input_tokens + x.output_tokens) tokens, SUM(x.model NOT LIKE 'claude%') other FROM ai_doc_usage x JOIN users u ON u.id = x.user_id
    WHERE x.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY u.id, u.name, u.title, x.key_owner ORDER BY cost DESC`, [days]);
}
export const myUsage = (userId) => one("SELECT COUNT(*) n, COALESCE(SUM(cost_usd),0) cost FROM ai_doc_usage WHERE user_id = ? AND created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')", [userId]);
