// Prontuário: registros, demanda trazida, hipótese diagnóstica (CID-10/CID-11) e rascunho da sessão.
// Regra de acesso: cada registro só é visto por quem o escreveu (author_id). Nem outro profissional,
// nem a administração, nem quem passa a atender o paciente depois de uma transferência.
import { q, one } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import * as RT from './richtext.js';
import * as CID from './cid.js';

const safe = (x) => { try { return x ? decrypt(x) : ''; } catch { return ''; } };
export const KINDS = ['evolucao', 'anamnese', 'observacao', 'documento'];

function shape(r) {
  if (!r) return r;
  const content = safe(r.content_enc);
  let dx = {}; try { dx = JSON.parse(safe(r.diagnosis_enc) || '{}'); } catch { dx = {}; }
  const text = RT.recordText(content, r.format);
  return {
    ...r, content, text, html: RT.recordHtml(content, r.format),
    demand: safe(r.demand_enc) || demandFrom(text),
    demandStored: !!r.demand_enc,
    hypothesis: dx.hypothesis || '', cid10: dx.cid10 || [], cid11: dx.cid11 || [],
  };
}
// Registros antigos (sem o campo): pega a seção “Demanda…” do texto, ou o começo dele
export function demandFrom(text) {
  const t = String(text || '');
  const m = /^\s*demanda[^:\n]*:[ \t]*([\s\S]*?)(?=\n\s*[A-ZÀ-Úa-zà-ú][^:\n]{2,60}:|(?![\s\S]))/im.exec(t);
  const out = (m && m[1].trim()) || t.trim();
  return out.length > 320 ? `${out.slice(0, 317).replace(/\s+\S*$/, '')}…` : out;
}

// Registros que o usuário pode ver (só os dele), mais recentes primeiro
export async function forPatient(pid, userId, { asc = false, kind = null, limit = null } = {}) {
  const rows = await q(`SELECT r.*, u.name autor, u.title autor_title, u.crp, a.modality appt_modality, a.starts_at appt_at, a.tele_used, a.meeting_link
    FROM records r LEFT JOIN users u ON u.id = r.author_id LEFT JOIN appointments a ON a.id = r.appointment_id
    WHERE r.patient_id = ? AND r.author_id = ? ${kind ? 'AND r.kind = ?' : ''}
    ORDER BY r.record_date ${asc ? 'ASC' : 'DESC'}, r.id ${asc ? 'ASC' : 'DESC'} ${limit ? `LIMIT ${Number(limit)}` : ''}`, [pid, userId, ...(kind ? [kind] : [])]);
  return rows.map(shape);
}
export async function get(id, pid, userId) {
  return shape(await one('SELECT r.* FROM records r WHERE r.id = ? AND r.patient_id = ? AND r.author_id = ?', [id, pid, userId]));
}
// Tipo de sessão para a linha do tempo
export function sessionType(r) {
  if (!r.appointment_id || !r.appt_modality) return null;
  if (r.appt_modality === 'online') return r.tele_used === 'propria' || /\/tc\//.test(r.meeting_link || '') ? 'Teleconsulta' : 'On-line';
  return 'Presencial';
}

// Lê o formulário (editor + campos) e devolve o que vai para o banco
export function readForm(b) {
  const html = RT.sanitize(b.content_html || '');
  const plain = String(b.content || '').trim();
  const useHtml = !!RT.toText(html);
  const content = useHtml ? html : plain;
  const diagnosis = {
    hypothesis: String(b.hypothesis || '').trim().slice(0, 2000),
    cid10: CID.parseCodes(b.cid10, 'cid10'), cid11: CID.parseCodes(b.cid11, 'cid11'),
  };
  const hasDx = diagnosis.hypothesis || diagnosis.cid10.length || diagnosis.cid11.length;
  return {
    content: content.slice(0, 300000), format: useHtml ? 'html' : 'texto', empty: !RT.recordText(content, useHtml ? 'html' : 'texto').trim(),
    demand: String(b.demand || '').trim().slice(0, 3000),
    kind: KINDS.includes(b.kind) ? b.kind : 'evolucao',
    diagnosis: hasDx ? diagnosis : null,
  };
}
export async function create(pid, userId, d, { date, apptId = null }) {
  const r = await q('INSERT INTO records (patient_id, appointment_id, author_id, kind, record_date, content_enc, format, demand_enc, diagnosis_enc) VALUES (?,?,?,?,?,?,?,?,?)',
    [pid, apptId, userId, d.kind, date, encrypt(d.content), d.format, d.demand ? encrypt(d.demand) : null, d.diagnosis ? encrypt(JSON.stringify(d.diagnosis)) : null]);
  return r.insertId;
}
export async function update(id, d, date) {
  await q('UPDATE records SET content_enc = ?, format = ?, kind = ?, record_date = ?, demand_enc = ?, diagnosis_enc = ? WHERE id = ?',
    [encrypt(d.content), d.format, d.kind, date, d.demand ? encrypt(d.demand) : null, d.diagnosis ? encrypt(JSON.stringify(d.diagnosis)) : null, id]);
}
// Hipótese diagnóstica mais recente registrada por este profissional
export async function latestDiagnosis(pid, userId) {
  const r = await one('SELECT id, record_date, diagnosis_enc FROM records WHERE patient_id = ? AND author_id = ? AND diagnosis_enc IS NOT NULL ORDER BY record_date DESC, id DESC LIMIT 1', [pid, userId]);
  if (!r) return null;
  let dx = {}; try { dx = JSON.parse(safe(r.diagnosis_enc) || '{}'); } catch { return null; }
  return { ...dx, cid10: dx.cid10 || [], cid11: dx.cid11 || [], date: r.record_date };
}

// ---------- rascunho da sessão (salvo sozinho) ----------
export async function draftOf(userId, pid) {
  const r = await one('SELECT * FROM record_drafts WHERE user_id = ? AND patient_id = ?', [userId, pid]);
  if (!r) return null;
  let d = {}; try { d = JSON.parse(safe(r.data_enc) || '{}'); } catch { return null; }
  return { ...d, appointment_id: r.appointment_id, updated_at: r.updated_at };
}
export async function saveDraft(userId, pid, apptId, b) {
  const data = {
    content_html: RT.sanitize(b.content_html || ''), demand: String(b.demand || '').slice(0, 3000), kind: KINDS.includes(b.kind) ? b.kind : 'evolucao',
    record_date: /^\d{4}-\d{2}-\d{2}$/.test(String(b.record_date || '')) ? b.record_date : null,
    hypothesis: String(b.hypothesis || '').slice(0, 2000), cid10: CID.parseCodes(b.cid10, 'cid10'), cid11: CID.parseCodes(b.cid11, 'cid11'),
    sai_rec: Number(b.sai_rec) || null,
  };
  await q('INSERT INTO record_drafts (user_id, patient_id, appointment_id, data_enc) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE appointment_id = COALESCE(VALUES(appointment_id), appointment_id), data_enc = VALUES(data_enc), updated_at = NOW()',
    [userId, pid, apptId || null, encrypt(JSON.stringify(data))]);
}
export const dropDraft = (userId, pid) => q('DELETE FROM record_drafts WHERE user_id = ? AND patient_id = ?', [userId, pid]);
