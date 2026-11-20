// CRM dos atendimentos de WhatsApp: um card por contato, organizado em etapas (Kanban).
// Os cards andam sozinhos com os eventos do sistema; movimentos manuais são respeitados.
import * as Tenancy from './tenancy.js';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt } from './crypto.js';
import { phoneKey } from './whatsapp.js';
import * as Live from './live.js';

export const DEFAULT_STAGES = [
  ['novo', 'Novo contato', '#b7865a'],
  ['atendimento', 'Em atendimento', '#3b5670'],
  ['humano', 'Aguardando humano', '#a3341f'],
  ['ebook', 'Interesse em e-book', '#7d8a5a'],
  ['agendado', '1ª sessão agendada', '#9c4422'],
  ['paciente', 'Paciente ativo', '#4f6b3a'],
  ['perdido', 'Sem retorno', '#7a6f66'],
  ['equipe', 'Equipe WhatsApp', '#2f6b5a'],
];
const FUNNEL = DEFAULT_STAGES.map(([k]) => k);
const MANUAL_DAYS = 3; // depois de mover à mão, só eventos fortes mexem no card por 3 dias

const S = Tenancy.scoped({ seeded: false }); // por clínica
export async function ensureStages() {
  if (S.seeded) return;
  const n = await one('SELECT COUNT(*) n FROM crm_stages');
  if (!Number(n.n)) {
    let i = 0;
    for (const [key, name, color] of DEFAULT_STAGES) await q('INSERT IGNORE INTO crm_stages (name, color, position, auto_key) VALUES (?,?,?,?)', [name, color, i++, key]);
  } else if (!(await one("SELECT id FROM crm_stages WHERE auto_key = 'equipe'"))) {
    // Etapa da equipe (WhatsApp de atendimento humano): aproveita a etapa que já tiver esse nome
    const same = (await q('SELECT id, name FROM crm_stages WHERE auto_key IS NULL')).find((x) => /equipe/i.test(x.name) && /whats/i.test(x.name));
    if (same) await q("UPDATE crm_stages SET auto_key = 'equipe' WHERE id = ?", [same.id]);
    else { const m = await one('SELECT MAX(position) p FROM crm_stages'); await q("INSERT IGNORE INTO crm_stages (name, color, position, auto_key) VALUES ('Equipe WhatsApp', '#2f6b5a', ?, 'equipe')", [Number(m?.p ?? 0) + 1]); }
  }
  S.seeded = true;
  await syncTeam().catch((e) => console.error('crm equipe', e.message));
}

// Reordena as etapas (arrastar no quadro ou na tela de etapas)
export async function reorderStages(ids) {
  const all = await q('SELECT id FROM crm_stages');
  const known = new Set(all.map((x) => x.id));
  const list = ids.map(Number).filter((id) => known.has(id));
  if (new Set(list).size !== list.length || list.length !== all.length) return false;
  for (let i = 0; i < list.length; i++) await q('UPDATE crm_stages SET position = ? WHERE id = ?', [i, list[i]]);
  Live.emit('crm');
  return true;
}

// ---------- equipe do atendimento humano ----------
// Os números cadastrados para receber o atendimento humano (Atendente virtual → Atendimento humano)
// ficam sempre na etapa “Equipe WhatsApp”: não andam pelo funil como se fossem contatos.
async function teamOps() {
  try { const c = JSON.parse((await getSetting('agent_config')) || '{}'); return (Array.isArray(c.relayOps) ? c.relayOps : []).filter((o) => o?.name && phoneKey(o.phone)); } catch { return []; }
}
async function teamOpOf(phone) { const k = phoneKey(phone); return k ? (await teamOps()).find((o) => phoneKey(o.phone) === k) || null : null; }
async function toTeam(card, op) {
  const st = await stageByKey('equipe');
  if (!st || !card) return;
  const name = `${String(op.name).slice(0, 120)} (equipe)`;
  if (card.stage_id !== st.id) {
    const from = await one('SELECT name FROM crm_stages WHERE id = ?', [card.stage_id]);
    await q('UPDATE crm_cards SET stage_id = ?, prev_stage_id = NULL, position = ?, name = ?, archived = 0 WHERE id = ?', [st.id, await topPosition(st.id), name, card.id]);
    await logEvent(card.id, 'etapa', `${from?.name || '—'} → ${st.name} (WhatsApp de atendimento humano)`);
    card.stage_id = st.id;
  } else if (card.name !== name && !card.patient_id) await q('UPDATE crm_cards SET name = ? WHERE id = ?', [name, card.id]);
}
// Coloca na etapa da equipe os cards dos números já cadastrados (chamado ao salvar a configuração)
export async function syncTeam() {
  for (const op of await teamOps()) {
    const card = await one('SELECT * FROM crm_cards WHERE phone_key = ?', [phoneKey(op.phone)]);
    if (card) await toTeam(card, op);
  }
}
export async function stages() { await ensureStages(); return q('SELECT * FROM crm_stages ORDER BY position, id'); }
async function stageByKey(key) { await ensureStages(); return one('SELECT * FROM crm_stages WHERE auto_key = ?', [key]); }

export async function config() {
  const raw = await getSetting('crm_config');
  try { return { capture: true, ...(raw ? JSON.parse(raw) : {}) }; } catch { return { capture: true }; }
}
export async function saveConfig(c) { await setSetting('crm_config', JSON.stringify(c)); }

export async function logEvent(cardId, type, text = null, userId = null) {
  Live.emit('crm');
  await q('INSERT INTO crm_events (card_id, user_id, type, text_enc) VALUES (?,?,?,?)', [cardId, userId, type, text ? encrypt(String(text).slice(0, 2000)) : null]);
}

async function topPosition(stageId) {
  const r = await one('SELECT MIN(position) p FROM crm_cards WHERE stage_id = ? AND archived = 0', [stageId]);
  return r?.p == null ? 0 : Number(r.p) - 1;
}

// Card do contato (cria se não existir).
export async function cardFor({ phone, name, patientId = null }) {
  const key = phoneKey(phone);
  if (!key) return null;
  let card = await one('SELECT * FROM crm_cards WHERE phone_key = ?', [key]);
  const op = await teamOpOf(phone);
  if (op) {
    if (!card) {
      const st = await stageByKey('equipe');
      await q("INSERT IGNORE INTO crm_cards (phone_key, phone, name, stage_id, position, source) VALUES (?,?,?,?,?, 'whatsapp')", [key, String(phone).slice(0, 30), `${String(op.name).slice(0, 120)} (equipe)`, st.id, await topPosition(st.id)]);
      card = await one('SELECT * FROM crm_cards WHERE phone_key = ?', [key]);
      await logEvent(card.id, 'criado', 'Card da equipe (WhatsApp de atendimento humano)');
    } else await toTeam(card, op);
    if (card.archived) { await q('UPDATE crm_cards SET archived = 0 WHERE id = ?', [card.id]); card.archived = 0; }
    return card;
  }
  if (!card) {
    const novo = await stageByKey('paciente');
    const first = await stageByKey('novo');
    // Paciente que já tem sessão realizada entra direto como “Paciente ativo”.
    let stage = first;
    if (patientId && (await one("SELECT id FROM appointments WHERE patient_id = ? AND status = 'realizada' LIMIT 1", [patientId]))) stage = novo;
    const pname = patientId ? await one('SELECT name, social_name FROM patients WHERE id = ?', [patientId]) : null;
    const ins = await q('INSERT IGNORE INTO crm_cards (phone_key, phone, name, patient_id, stage_id, position) VALUES (?,?,?,?,?,?)',
      [key, String(phone).slice(0, 30), (pname?.social_name || pname?.name || name || `Contato ${String(phone).slice(-4)}`).slice(0, 160), patientId, stage.id, await topPosition(stage.id)]);
    card = await one('SELECT * FROM crm_cards WHERE phone_key = ?', [key]);
    if (ins.affectedRows) await logEvent(card.id, 'criado', 'Card criado a partir do WhatsApp');
  } else if (patientId && !card.patient_id) {
    const pname = await one('SELECT name, social_name FROM patients WHERE id = ?', [patientId]);
    await q('UPDATE crm_cards SET patient_id = ?, name = ? WHERE id = ?', [patientId, (pname.social_name || pname.name).slice(0, 160), card.id]);
    card.patient_id = patientId;
  }
  if (card.archived) { await q('UPDATE crm_cards SET archived = 0 WHERE id = ?', [card.id]); card.archived = 0; }
  return card;
}

// Move o card por um evento automático, respeitando a ordem do funil e os movimentos manuais.
export async function autoMove(card, key, { force = false, reason = '' } = {}) {
  if (!card) return;
  const target = await stageByKey(key);
  if (!target || target.id === card.stage_id) return;
  if (card.phone && (await teamOpOf(card.phone))) return; // card da equipe não anda pelo funil
  const cur = await one('SELECT * FROM crm_stages WHERE id = ?', [card.stage_id]);
  const manualLock = card.manual_until && new Date(`${String(card.manual_until).replace(' ', 'T')}-03:00`) > new Date();
  // “Avançar” segue a ordem lógica do funil, não a posição das colunas (que pode ser arrastada à vontade)
  const rank = (st) => FUNNEL.indexOf(st.auto_key);
  const forward = !cur || ['novo', 'perdido'].includes(cur.auto_key) || (rank(cur) >= 0 && rank(target) >= 0 ? rank(target) > rank(cur) : target.position > cur.position);
  if (!force && (manualLock || !forward)) return;
  await q('UPDATE crm_cards SET prev_stage_id = ?, stage_id = ?, position = ? WHERE id = ?', [card.stage_id, target.id, await topPosition(target.id), card.id]);
  await logEvent(card.id, 'etapa', `${cur ? cur.name : '—'} → ${target.name}${reason ? ` (${reason})` : ''}`);
  card.prev_stage_id = card.stage_id; card.stage_id = target.id;
}

// ---------- ganchos chamados pelo restante do sistema (nunca derrubam o fluxo) ----------
const safe = (fn) => (...a) => fn(...a).catch((e) => console.error('crm', e.message));

export const touchInbound = safe(async ({ phone, name, patientId }) => {
  const card = await cardFor({ phone, name, patientId });
  if (!card) return;
  await q("UPDATE crm_cards SET last_message_at = NOW(), last_direction = 'in' WHERE id = ?", [card.id]);
  const cur = await one('SELECT auto_key FROM crm_stages WHERE id = ?', [card.stage_id]);
  if (cur?.auto_key === 'perdido') await autoMove(card, 'atendimento', { force: true, reason: 'voltou a falar' });
});

const SKIP_KINDS = new Set(['profissional', 'teste', 'aniversario', 'pesquisa', 'reativacao']); // equipe, testes e mensagens de relacionamento não mexem no funil
export const touchOutbound = safe(async ({ phone, kind, text, patientId }) => {
  if (SKIP_KINDS.has(kind)) return;
  const key = phoneKey(phone);
  let card = key ? await one('SELECT * FROM crm_cards WHERE phone_key = ?', [key]) : null;
  if (!card && (kind === 'agente' || kind === 'manual')) card = await cardFor({ phone, patientId });
  if (!card) return;
  if (await teamOpOf(phone)) { await cardFor({ phone }); await q("UPDATE crm_cards SET last_message_at = NOW(), last_direction = 'out' WHERE id = ?", [card.id]); return; }
  await q("UPDATE crm_cards SET last_message_at = NOW(), last_direction = 'out' WHERE id = ?", [card.id]);
  if (patientId && !card.patient_id) await cardFor({ phone, patientId });
  if (kind === 'agente' && /pay\.hotmart\.com/.test(text || '')) await autoMove(card, 'ebook', { reason: 'link de e-book enviado' });
  else await autoMove(card, 'atendimento');
});

export const onHuman = safe(async ({ phone, reason }) => {
  const key = phoneKey(phone);
  const card = key ? await one('SELECT * FROM crm_cards WHERE phone_key = ?', [key]) : null;
  if (card) await autoMove(card, 'humano', { force: true, reason });
});

export const onResume = safe(async ({ phone }) => {
  const key = phoneKey(phone);
  const card = key ? await one('SELECT c.*, s.auto_key FROM crm_cards c JOIN crm_stages s ON s.id = c.stage_id WHERE c.phone_key = ?', [key]) : null;
  if (card?.auto_key === 'humano' && card.prev_stage_id) {
    const prev = await one('SELECT name FROM crm_stages WHERE id = ?', [card.prev_stage_id]);
    await q('UPDATE crm_cards SET stage_id = ?, prev_stage_id = NULL, position = ? WHERE id = ?', [card.prev_stage_id, await topPosition(card.prev_stage_id), card.id]);
    await logEvent(card.id, 'etapa', `Aguardando humano → ${prev?.name || 'etapa anterior'} (devolvido ao atendente virtual)`);
  }
});

export const onAppointment = safe(async (patientId) => {
  const cards = await q('SELECT * FROM crm_cards WHERE patient_id = ?', [patientId]);
  if (!cards.length) return;
  const done = await one("SELECT id FROM appointments WHERE patient_id = ? AND status = 'realizada' LIMIT 1", [patientId]);
  for (const c of cards) await autoMove(c, done ? 'paciente' : 'agendado', { reason: 'sessão agendada' });
});

export const onSessionDone = safe(async (patientId) => {
  const cards = await q('SELECT * FROM crm_cards WHERE patient_id = ?', [patientId]);
  for (const c of cards) await autoMove(c, 'paciente', { reason: 'sessão realizada' });
});

// Movimento manual (arrastar no quadro).
export async function moveManual(cardId, stageId, beforeId, userId) {
  const card = await one('SELECT * FROM crm_cards WHERE id = ?', [cardId]);
  const target = await one('SELECT * FROM crm_stages WHERE id = ?', [stageId]);
  if (!card || !target) return false;
  let pos;
  if (beforeId) {
    const b = await one('SELECT position FROM crm_cards WHERE id = ? AND stage_id = ?', [beforeId, stageId]);
    const prev = b ? await one('SELECT MAX(position) p FROM crm_cards WHERE stage_id = ? AND archived = 0 AND position < ? AND id <> ?', [stageId, b.position, cardId]) : null;
    pos = b ? (prev?.p == null ? Number(b.position) - 1 : (Number(prev.p) + Number(b.position)) / 2) : null;
  }
  if (pos == null) { const r = await one('SELECT MAX(position) p FROM crm_cards WHERE stage_id = ? AND archived = 0 AND id <> ?', [stageId, cardId]); pos = r?.p == null ? 0 : Number(r.p) + 1; }
  await q(`UPDATE crm_cards SET stage_id = ?, prev_stage_id = ?, position = ?, manual_until = DATE_ADD(NOW(), INTERVAL ${MANUAL_DAYS} DAY) WHERE id = ?`, [stageId, card.stage_id === stageId ? card.prev_stage_id : card.stage_id, pos, cardId]);
  if (card.stage_id !== stageId) {
    const from = await one('SELECT name FROM crm_stages WHERE id = ?', [card.stage_id]);
    await logEvent(cardId, 'etapa', `${from?.name || '—'} → ${target.name} (manual)`, userId);
  }
  return true;
}
