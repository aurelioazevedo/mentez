// Termos digitais: o paciente lê e aceita por um link. Guarda o texto exato aceito (com resumo criptográfico),
// data/hora, IP, navegador e quem assinou (o próprio paciente ou o responsável legal).
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { encrypt } from './crypto.js';
import * as Fin from './fin.js';
import { proName } from './perm.js';
import * as Live from './live.js';
import { nowLocal, todayLocal, longDate } from './time.js';

export const KINDS = {
  consentimento: 'Termo de Consentimento Livre e Esclarecido',
  contrato: 'Contrato Terapêutico',
  gravacao_ia: 'Autorização de gravação de áudio e uso de inteligência artificial',
};
export const VARS = { paciente: 'nome do paciente', profissional: 'Dr./Dra. responsável', crp: 'CRP do profissional', valor_sessao: 'valor da sessão', politica_faltas: 'regra de faltas', modalidade: 'presencial/on-line', data: 'data de hoje', clinica: 'nome do consultório' };

const DEFAULTS = {
  consentimento: `Eu, {paciente}, declaro que fui informado(a) e concordo com as condições do atendimento psicológico realizado por {profissional} (CRP {crp}), no consultório {clinica}.

1. NATUREZA DO ATENDIMENTO
A psicoterapia é um processo de cuidado da saúde mental baseado em conhecimentos científicos e no Código de Ética Profissional do Psicólogo. Os resultados dependem de diversos fatores e não podem ser garantidos. Posso interromper o acompanhamento a qualquer momento, preferencialmente conversando antes com o(a) profissional.

2. SIGILO PROFISSIONAL
Tudo o que for tratado nas sessões é sigiloso. O sigilo só poderá ser quebrado nas situações previstas no Código de Ética (como risco à minha vida ou à de terceiros), limitando-se ao estritamente necessário.

3. ATENDIMENTO ON-LINE (quando houver)
Nas sessões on-line, devo estar em local reservado e com conexão adequada. O atendimento segue as normas do Conselho Federal de Psicologia para serviços prestados por meio de tecnologias da informação e da comunicação.

4. PRONTUÁRIO
O(A) profissional manterá registro documental dos atendimentos (prontuário), guardado com sigilo por no mínimo 5 (cinco) anos, conforme as resoluções do Conselho Federal de Psicologia. Tenho direito de acesso às informações a meu respeito.

5. PROTEÇÃO DE DADOS PESSOAIS (LGPD – Lei 13.709/2018)
Meus dados pessoais e dados sensíveis de saúde serão tratados apenas para a prestação do serviço de saúde, agendamento, comunicação, emissão de recibos e cumprimento de obrigações legais. Os dados ficam em sistema protegido, com acesso restrito e criptografia das informações mais sensíveis. Para o funcionamento do serviço, podem ser utilizados prestadores como hospedagem, WhatsApp (lembretes e comunicação) e Google Agenda (organização das sessões), sempre com o mínimo necessário. Posso solicitar a qualquer momento acesso, correção, cópia (portabilidade) ou eliminação dos meus dados, respeitados os prazos legais de guarda, e revogar este consentimento.

6. COMUNICAÇÃO
Autorizo o contato pelo WhatsApp e telefone informados para lembretes, confirmações, remarcações e assuntos administrativos.

Declaro que li, compreendi e concordo com este termo.
{data}`,
  contrato: `CONTRATO TERAPÊUTICO

Paciente: {paciente}
Profissional: {profissional} (CRP {crp})
Modalidade: {modalidade}

1. SESSÕES: as sessões têm duração aproximada de 50 minutos, com frequência combinada entre paciente e profissional.
2. VALOR: o valor de cada sessão é {valor_sessao}, pago conforme combinado (por sessão ou por pacote), por Pix, cartão, transferência ou dinheiro. Os valores podem ser reajustados mediante aviso prévio.
3. FALTAS E REMARCAÇÕES: pedidos de remarcação devem ser feitos com pelo menos 24 horas de antecedência. Política de faltas: {politica_faltas}.
4. ATRASOS: em caso de atraso do paciente, a sessão termina no horário previsto.
5. INTERRUPÇÃO: o paciente pode encerrar o acompanhamento a qualquer momento; recomenda-se uma sessão de encerramento.
6. COMUNICAÇÃO: o WhatsApp do consultório é usado para assuntos administrativos (agendamento, lembretes, pagamentos). Questões clínicas são tratadas nas sessões.

Declaro que li e concordo com as condições deste contrato.
{data}`,
  gravacao_ia: `AUTORIZAÇÃO DE GRAVAÇÃO DE ÁUDIO E USO DE INTELIGÊNCIA ARTIFICIAL (opcional)

Eu, {paciente}, autorizo {profissional} (CRP {crp}) a captar o áudio das sessões exclusivamente para gerar, com apoio de ferramentas de inteligência artificial, um rascunho do registro da sessão, que será revisado pelo(a) profissional antes de entrar no prontuário.

- O áudio não fica armazenado: é processado em ambiente temporário e apagado logo após a transcrição.
- A transcrição e o rascunho podem ser processados por serviços de tecnologia contratados (inclusive com servidores fora do Brasil), apenas para essa finalidade.
- A responsabilidade pelo registro no prontuário continua sendo do(a) profissional.
- Esta autorização é opcional: posso recusar ou revogar a qualquer momento, sem prejuízo do atendimento.

{data}`,
};

export async function templates() {
  const rows = await q('SELECT * FROM consent_templates');
  const out = {};
  for (const [k, title] of Object.entries(KINDS)) out[k] = rows.find((r) => r.kind === k) || { kind: k, title, body: DEFAULTS[k], version: 1, active: 1, isDefault: true };
  return out;
}
export async function saveTemplate(kind, { title, body, active }, userId) {
  const cur = await one('SELECT * FROM consent_templates WHERE kind = ?', [kind]);
  const changed = !cur || cur.body !== body || cur.title !== title;
  await q(`INSERT INTO consent_templates (kind, title, body, version, active, updated_by) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), version = IF(?, version + 1, version), active = VALUES(active), updated_by = VALUES(updated_by), updated_at = NOW()`,
  [kind, title, body, cur ? cur.version : 1, active ? 1 : 0, userId, changed && !!cur]);
}
export const defaultBody = (kind) => DEFAULTS[kind];

async function vars(patient) {
  const pro = patient.owner_id ? await one('SELECT name, title, crp FROM users WHERE id = ?', [patient.owner_id]) : null;
  const clinic = await Fin.clinic(); const pol = await Fin.policy();
  return {
    paciente: patient.social_name || patient.name, profissional: pro ? proName(pro) : Brand.get().who, crp: pro?.crp || Brand.get().crp,
    valor_sessao: patient.session_fee ? Fin.brl(patient.session_fee) : 'combinado com o(a) profissional', politica_faltas: Fin.policyText(pol),
    modalidade: { online: 'on-line', presencial: 'presencial', hibrido: 'presencial e on-line' }[patient.modality] || 'presencial',
    data: `${Brand.get().city ? `${Brand.get().city}, ` : ''}${longDate(todayLocal())}.`, clinica: clinic.name || Brand.get().name,
  };
}
const fill = (text, v) => String(text).replace(/\{(\w+)\}/g, (m, k) => (v[k] !== undefined ? v[k] : m));
export const hashOf = (t) => crypto.createHash('sha256').update(t).digest('hex');

// Cria o link (válido por 30 dias) com o texto exato de cada documento escolhido.
export async function createLink(patient, kinds, userId) {
  const tpl = await templates(); const v = await vars(patient);
  const docs = kinds.filter((k) => KINDS[k]).map((k) => { const body = fill(tpl[k].body, v); return { kind: k, title: tpl[k].title, version: tpl[k].version, body, hash: hashOf(body) }; });
  if (!docs.length) return null;
  const token = crypto.randomBytes(24).toString('base64url');
  const r = await q('INSERT INTO consent_links (patient_id, token_hash, docs, created_by, expires_at) VALUES (?,?,?,?, DATE_ADD(NOW(), INTERVAL 30 DAY))', [patient.id, hashOf(token), JSON.stringify(docs), userId]);
  return { id: r.insertId, token, docs };
}
export async function byToken(token) {
  const l = await one('SELECT * FROM consent_links WHERE token_hash = ?', [hashOf(String(token || ''))]);
  if (!l) return null;
  return { ...l, docs: JSON.parse(l.docs), expired: l.status === 'pendente' && String(l.expires_at) < nowLocal() };
}
export async function decide(link, { accept, signerName, signerCpf, role, relation, ip, ua }) {
  await q('UPDATE consent_links SET status = ?, decided_at = NOW(), ip = ?, user_agent = ?, signer_name = ?, signer_cpf_enc = ?, signer_role = ?, signer_relation = ? WHERE id = ? AND status = ?',
    [accept ? 'aceito' : 'recusado', String(ip || '').slice(0, 64), String(ua || '').slice(0, 255), String(signerName || '').slice(0, 160), signerCpf ? encrypt(signerCpf) : null, role === 'responsavel' ? 'responsavel' : 'paciente', String(relation || '').slice(0, 60) || null, link.id, 'pendente']);
  if (accept && link.docs.some((d) => d.kind === 'consentimento')) await q('UPDATE patients SET consent_at = NOW() WHERE id = ?', [link.patient_id]);
  Live.emit('pacientes');
}
export const forPatient = (pid) => q('SELECT l.*, u.name who FROM consent_links l LEFT JOIN users u ON u.id = l.created_by WHERE l.patient_id = ? ORDER BY l.id DESC', [pid]);

// Cria o link e envia ao paciente pelo WhatsApp e por e-mail (o que estiver disponível).
// Devolve o link e o resultado de cada canal, para a tela avisar o que saiu e o que não saiu.
export async function sendLink(patient, kinds, userId, { base, wa = true, email = true } = {}) {
  const l = await createLink(patient, kinds, userId);
  if (!l) return null;
  const url = `${String(base || Tenancy.env('PUBLIC_URL') || '').replace(/\/+$/, '')}/t/${l.token}`;
  const first = String(patient.social_name || patient.name).split(' ')[0];
  const titles = l.docs.map((d) => d.title).join(', ');
  const text = `Olá, ${first}! Segue o link para leitura e aceite ${l.docs.length > 1 ? 'dos documentos' : 'do documento'} do seu atendimento psicológico (${titles}):\n${url}\n\nO link é pessoal e vale por 30 dias.`;
  const out = { link: l, url, wa: null, email: null };
  if (wa) {
    const WA = await import('./whatsapp.js');
    if (!patient.phone) out.wa = { ok: false, error: 'sem telefone' };
    else if (!patient.whatsapp_optin) out.wa = { ok: false, error: 'paciente não autorizou WhatsApp' };
    else out.wa = await WA.send({ phone: patient.phone, text, kind: 'manual', patient_id: patient.id, user_id: userId }).catch((e) => ({ ok: false, error: e.message }));
  }
  if (email) {
    const N = await import('./notify.js');
    const nc = await N.config();
    if (!patient.email) out.email = { ok: false, error: 'sem e-mail' };
    else if (!N.emailReady(nc)) out.email = { ok: false, error: 'e-mail não configurado' };
    else {
      const esc = (s) => String(s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
      const htmlBody = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#3b2a20;max-width:520px;margin:24px auto;padding:28px;background:#fffaf5;border-radius:18px;border:1px solid #ecdccd">
<p>Olá, ${esc(first)}!</p><p>Segue o link para leitura e aceite ${l.docs.length > 1 ? 'dos documentos' : 'do documento'} do seu atendimento psicológico: <b>${esc(titles)}</b>.</p>
<p style="margin:24px 0"><a href="${esc(url)}" style="background:#b5603f;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;display:inline-block">Ler e aceitar</a></p>
<p style="font-size:13px;color:#7a6658">O link é pessoal e vale por 30 dias.</p></div>`;
      try { await N.sendEmail(nc, { to: patient.email, subject: `Documento para leitura e aceite — ${titles}`, text, html: htmlBody }); out.email = { ok: true }; } catch (e) { out.email = { ok: false, error: e.message }; }
    }
  }
  return out;
}
// Resumo do envio em uma frase
export function sentText(r) {
  const ok = [r.wa?.ok && 'WhatsApp', r.email?.ok && 'e-mail'].filter(Boolean);
  const bad = [r.wa && !r.wa.ok && `WhatsApp: ${r.wa.error}`, r.email && !r.email.ok && `e-mail: ${r.email.error}`].filter(Boolean);
  return `${ok.length ? `Termo enviado por ${ok.join(' e ')}.` : 'O termo não foi enviado automaticamente.'}${bad.length ? ` Não saiu por ${bad.join('; ')}.` : ''}${ok.length ? '' : ' Copie o link e envie por outro meio.'}`;
}
