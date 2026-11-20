// LGPD e CFP: prazos de guarda, limpeza automática de contatos antigos do CRM, anonimização e exportação dos dados do paciente.
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import * as RT from './richtext.js';
import AdmZip from 'adm-zip';
import { q, one, db, getSetting, setSetting } from './db.js';
import { decrypt } from './crypto.js';
import { decryptBody } from './whatsapp.js';
import * as Live from './live.js';
import { nowLocal } from './time.js';

const DEFAULTS = { recordsYears: 5, crmAuto: true, crmMonths: 12 };
export async function config() {
  let c = {}; try { c = JSON.parse((await getSetting('privacy_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c };
}
export async function saveConfig(p) {
  const c = { recordsYears: Math.max(5, Math.min(30, Math.round(Number(p.recordsYears)) || 5)), crmAuto: !!p.crmAuto, crmMonths: Math.max(3, Math.min(60, Math.round(Number(p.crmMonths)) || 12)) };
  await setSetting('privacy_cfg', JSON.stringify(c));
  return c;
}

// ---------- CRM: contatos que nunca viraram pacientes ----------
const crmOldSql = `FROM crm_cards c WHERE c.patient_id IS NULL AND c.demo = 0 AND COALESCE(c.last_message_at, c.updated_at, c.created_at) < DATE_SUB(NOW(), INTERVAL ? MONTH)`;
export const crmCandidates = async (months) => Number((await one(`SELECT COUNT(*) n ${crmOldSql}`, [months])).n);
export async function purgeCrm(months) {
  const cards = await q(`SELECT c.id, c.phone, c.phone_key ${crmOldSql} LIMIT 500`, [months]);
  for (const c of cards) {
    await q('DELETE FROM crm_events WHERE card_id = ?', [c.id]);
    if (c.phone) await q('DELETE FROM wa_messages WHERE patient_id IS NULL AND phone = ?', [c.phone]);
    if (c.phone_key) {
      const cv = await one('SELECT id FROM agent_conversations WHERE phone_key = ? AND patient_id IS NULL', [c.phone_key]);
      if (cv) { await q('DELETE FROM agent_inbox WHERE conversation_id = ?', [cv.id]); await q('DELETE FROM agent_conversations WHERE id = ?', [cv.id]); }
      await q('DELETE FROM wa_photos WHERE phone_key = ?', [c.phone_key]);
    }
    await q('DELETE FROM crm_cards WHERE id = ?', [c.id]);
  }
  await setSetting('privacy_last', JSON.stringify({ at: nowLocal(), removed: cards.length }));
  if (cards.length) Live.emit('crm');
  return cards.length;
}
const RUNNING = Tenancy.scoped({ on: false }); // trava por clínica
export async function tick() {
  if (RUNNING.on) return; RUNNING.on = true; let conn;
  try {
    const c = await config(); if (!c.crmAuto) return;
    conn = await db().getConnection();
    const [[lk]] = await conn.query("SELECT GET_LOCK('lm_privacy', 0) ok"); if (!lk.ok) return;
    await purgeCrm(c.crmMonths);
  } catch (e) { console.error('privacidade', e.message); } finally {
    if (conn) { await conn.query("SELECT RELEASE_LOCK('lm_privacy')").catch(() => {}); conn.release(); }
    RUNNING.on = false;
  }
}

// ---------- pacientes com prazo de guarda vencido ----------
export async function expiredPatients(years) {
  return q(`SELECT p.id, p.name, p.social_name, p.status, p.updated_at,
      GREATEST(COALESCE((SELECT MAX(a.starts_at) FROM appointments a WHERE a.patient_id = p.id), '1970-01-01'), COALESCE((SELECT MAX(r.record_date) FROM records r WHERE r.patient_id = p.id), '1970-01-01'), p.created_at) last_activity
    FROM patients p WHERE p.status IN ('alta','inativo') AND p.demo = 0 AND p.name NOT LIKE 'Paciente anonimizado%'
    HAVING last_activity < DATE_SUB(NOW(), INTERVAL ? YEAR) ORDER BY last_activity LIMIT 200`, [years]);
}
// Anonimiza: apaga prontuário, exercícios, mensagens e identificação; mantém sessões e valores (sem identidade) para a contabilidade.
export async function anonymize(id) {
  const p = await one('SELECT id, phone FROM patients WHERE id = ?', [id]);
  if (!p) return false;
  await q('DELETE FROM records WHERE patient_id = ?', [id]);
  await q('DELETE FROM assignments WHERE patient_id = ?', [id]);
  await q('DELETE FROM wa_messages WHERE patient_id = ?', [id]);
  await q('DELETE FROM notify_log WHERE patient_id = ?', [id]);
  await q('DELETE FROM surveys WHERE patient_id = ?', [id]);
  await q('DELETE FROM scale_apps WHERE patient_id = ?', [id]);
  await q('DELETE FROM scale_plans WHERE patient_id = ?', [id]);
  const wl = (await q('SELECT id FROM waitlist WHERE patient_id = ?', [id])).map((w) => w.id);
  if (wl.length) { await q('DELETE FROM waitlist_offers WHERE waitlist_id IN (?)', [wl]); await q('DELETE FROM waitlist WHERE id IN (?)', [wl]); }
  await q('UPDATE consent_links SET signer_name = NULL, signer_cpf_enc = NULL, ip = NULL, user_agent = NULL, docs = ? WHERE patient_id = ?', ['[]', id]);
  const cards = await q('SELECT id FROM crm_cards WHERE patient_id = ?', [id]);
  for (const c of cards) { await q('DELETE FROM crm_events WHERE card_id = ?', [c.id]); await q('DELETE FROM crm_cards WHERE id = ?', [c.id]); }
  await q('UPDATE agent_conversations SET patient_id = NULL, messages_enc = NULL, contact_name = NULL WHERE patient_id = ?', [id]);
  await q('UPDATE appointments SET patient_note = NULL, meeting_link = NULL WHERE patient_id = ?', [id]);
  await q("UPDATE payments SET description = 'Sessão (paciente anonimizado)' WHERE patient_id = ?", [id]);
  await q(`UPDATE patients SET name = ?, social_name = NULL, birth_date = NULL, phone = NULL, email = NULL, cpf_enc = NULL, address_enc = NULL, emergency_enc = NULL,
    notes_enc = NULL, payer_name = NULL, payer_cpf_enc = NULL, responsible_name = NULL, responsible_phone = NULL, whatsapp_optin = 0, status = 'inativo' WHERE id = ?`, [`Paciente anonimizado #${id}`, id]);
  Live.emit(['pacientes', 'agenda', 'crm']);
  return true;
}

// ---------- exportação (direito de acesso / portabilidade) ----------
const csv = (rows, cols) => '﻿' + [cols.map((c) => c[0]).join(';'), ...rows.map((r) => cols.map(([, f]) => `"${String(f(r) ?? '').replace(/"/g, '""')}"`).join(';'))].join('\r\n');
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export async function exportPatient(id, { withRecords }) {
  const p = await one('SELECT p.*, u.name pro, u.title pro_title, u.crp FROM patients p LEFT JOIN users u ON u.id = p.owner_id WHERE p.id = ?', [id]);
  if (!p) return null;
  const z = new AdmZip(); const when = nowLocal().slice(0, 16);
  const cad = {
    nome: p.name, nome_social: p.social_name, nascimento: p.birth_date, telefone: p.phone, email: p.email, cpf: decrypt(p.cpf_enc) || null,
    endereco: decrypt(p.address_enc) || null, contato_emergencia: decrypt(p.emergency_enc) || null, modalidade: p.modality, situacao: p.status,
    valor_sessao: p.session_fee, responsavel_financeiro: p.payer_name, responsavel_contato: p.responsible_name, profissional: p.pro ? `${p.pro_title || ''} ${p.pro} (CRP ${p.crp || '—'})`.trim() : null,
    autoriza_whatsapp: !!p.whatsapp_optin, consentimento_registrado_em: p.consent_at, cadastrado_em: p.created_at,
  };
  z.addFile('cadastro.json', Buffer.from(JSON.stringify(cad, null, 2)));
  const ap = await q('SELECT starts_at, duration_min, modality, status, arrived_at, started_at, finished_at FROM appointments WHERE patient_id = ? ORDER BY starts_at', [id]);
  z.addFile('sessoes.csv', Buffer.from(csv(ap, [['Data e hora', (r) => r.starts_at], ['Duração (min)', (r) => r.duration_min], ['Modalidade', (r) => r.modality], ['Situação', (r) => r.status], ['Chegada', (r) => r.arrived_at], ['Início', (r) => r.started_at], ['Fim', (r) => r.finished_at]])));
  const pays = await q('SELECT description, amount, due_date, paid_at, method FROM payments WHERE patient_id = ? ORDER BY due_date', [id]);
  z.addFile('pagamentos.csv', Buffer.from(csv(pays, [['Descrição', (r) => r.description], ['Valor', (r) => String(r.amount).replace('.', ',')], ['Vencimento', (r) => r.due_date], ['Pago em', (r) => r.paid_at], ['Forma', (r) => r.method]])));
  const msgs = await q('SELECT created_at, direction, kind, body_enc, status FROM wa_messages WHERE patient_id = ? ORDER BY id', [id]);
  z.addFile('mensagens-whatsapp.csv', Buffer.from(csv(msgs, [['Data e hora', (r) => r.created_at], ['Sentido', (r) => (r.direction === 'in' ? 'recebida do paciente' : 'enviada pelo consultório')], ['Tipo', (r) => r.kind], ['Mensagem', (r) => decryptBody(r.body_enc)], ['Situação', (r) => r.status]])));
  const links = await q("SELECT * FROM consent_links WHERE patient_id = ? AND status IN ('aceito','recusado') ORDER BY id", [id]);
  z.addFile('termos-aceitos.html', Buffer.from(`<!doctype html><meta charset="utf-8"><title>Termos</title><body style="font-family:sans-serif;max-width:760px;margin:auto">${links.map((l) => `<h2>${l.status === 'aceito' ? 'Aceito' : 'Recusado'} em ${esc(l.decided_at)} por ${esc(l.signer_name)} (IP ${esc(l.ip)})</h2>${JSON.parse(l.docs).map((d) => `<h3>${esc(d.title)}</h3><pre style="white-space:pre-wrap">${esc(d.body)}</pre><p><small>SHA-256: ${d.hash}</small></p>`).join('')}`).join('<hr>') || '<p>Nenhum termo respondido.</p>'}</body>`));
  if (withRecords) {
    // withRecords = id de quem exporta: só os registros escritos por essa pessoa (o prontuário de cada profissional é só dele)
    const recs = (await q('SELECT r.record_date, r.kind, r.content_enc, r.format, r.demand_enc, r.diagnosis_enc, u.name autor, u.title FROM records r LEFT JOIN users u ON u.id = r.author_id WHERE r.patient_id = ? AND r.author_id = ? ORDER BY r.record_date, r.id', [id, Number(withRecords) || 0]))
      .map((r) => { let dx = {}; try { dx = JSON.parse(r.diagnosis_enc ? decrypt(r.diagnosis_enc) : '{}'); } catch { /* ilegível */ } return { ...r, text: RT.recordText(decrypt(r.content_enc), r.format), demand: r.demand_enc ? decrypt(r.demand_enc) : '', dx }; });
    z.addFile('prontuario.html', Buffer.from(`<!doctype html><meta charset="utf-8"><title>Prontuário</title><body style="font-family:sans-serif;max-width:760px;margin:auto"><h1>Prontuário psicológico — ${esc(p.social_name || p.name)}</h1><p>Exportado em ${esc(when)}. Documento sigiloso.</p>${recs.map((r) => `<h3>${esc(r.record_date)} · ${esc(r.kind)} · ${esc(`${r.title || ''} ${r.autor || ''}`.trim())}</h3>${r.demand ? `<p><b>Demanda trazida:</b> ${esc(r.demand)}</p>` : ''}${r.dx.hypothesis || (r.dx.cid10 || []).length || (r.dx.cid11 || []).length ? `<p><b>Hipótese diagnóstica:</b> ${esc(r.dx.hypothesis || '—')}${(r.dx.cid10 || []).length ? ` · CID-10: ${esc(r.dx.cid10.join(', '))}` : ''}${(r.dx.cid11 || []).length ? ` · CID-11: ${esc(r.dx.cid11.join(', '))}` : ''}</p>` : ''}<pre style="white-space:pre-wrap;font-family:inherit">${esc(r.text)}</pre>`).join('') || '<p>Sem registros.</p>'}</body>`));
    const asg = await q('SELECT exercise_key, status, created_at, responded_at, response_enc FROM assignments WHERE patient_id = ? ORDER BY id', [id]);
    z.addFile('exercicios.json', Buffer.from(JSON.stringify(asg.map((a) => ({ exercicio: a.exercise_key, situacao: a.status, enviado_em: a.created_at, respondido_em: a.responded_at, resposta: a.response_enc ? JSON.parse(decrypt(a.response_enc) || 'null') : null })), null, 2)));
  }
  z.addFile('LEIA-ME.txt', Buffer.from(`Cópia dos dados pessoais — ${p.social_name || p.name}
Gerada em ${when} pelo ${Brand.get().appName}${Brand.get().crp ? ` (CRP ${Brand.get().crp})` : ''}, em atenção ao direito de acesso
e portabilidade previsto na LGPD (Lei 13.709/2018, art. 18).

Arquivos:
• cadastro.json — dados de cadastro
• sessoes.csv — sessões agendadas e realizadas
• pagamentos.csv — cobranças e pagamentos
• mensagens-whatsapp.csv — mensagens trocadas com o WhatsApp do consultório
• termos-aceitos.html — termos lidos e aceitos, com data, hora e IP
${withRecords ? '• prontuario.html — registros do prontuário psicológico\n• exercicios.json — exercícios enviados e respostas\n' : '• (prontuário não incluído nesta cópia)\n'}
Documento com dados sensíveis: guarde em local seguro.`));
  return { buf: z.toBuffer(), name: `dados-${String(p.social_name || p.name).normalize('NFD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}-${when.slice(0, 10)}.zip` };
}
