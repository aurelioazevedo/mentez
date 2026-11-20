// Lista de espera inteligente: quando uma sessão é cancelada (ou remarcada) e o horário fica livre,
// o atendente virtual oferece a vaga pelo WhatsApp a quem está aguardando, com preferência de dia,
// período, profissional e modalidade. Quem responder “SIM” primeiro fica com o horário.
// É diferente da fila da Recepção (pacientes que já chegaram ao consultório).
import { q, one, getSetting, setSetting } from './db.js';
import { nowLocal, todayLocal, addDays, addMinutes } from './time.js';
import { brDate, weekday } from './html.js';
import * as SC from './schedule.js';
import * as G from './google.js';
import * as WA from './whatsapp.js';
import * as CRM from './crm.js';
import * as Live from './live.js';
import { notify } from './push.js';
import { proName } from './perm.js';
import { encrypt } from './crypto.js';

export const MODES = {
  sequencial: 'Uma pessoa por vez, na ordem da lista (recomendado)',
  todos: 'Para várias pessoas ao mesmo tempo — fica com quem responder primeiro',
};
export const PERIODS = { manha: 'Manhã', tarde: 'Tarde', noite: 'Noite' };
export const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export const DEFAULT_MSG = 'Olá, {nome}! 😊 Abriu um horário com {profissional}: *{quando} ({data}), às {hora}* ({modalidade}).{troca}\n\nVocê está na nossa lista de espera. Quer ficar com esse horário?\nResponda *SIM* para confirmar ou *NÃO* para continuar na lista.\n\nO horário fica reservado para você por {minutos} minutos.';
const DEFAULTS = { enabled: true, auto: true, mode: 'sequencial', replyMinutes: 30, maxOffers: 5, minLeadHours: 2, msg: DEFAULT_MSG };

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('waitlist_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c };
}
export async function saveConfig(p) {
  const c = {
    enabled: !!p.enabled, auto: !!p.auto,
    mode: MODES[p.mode] ? p.mode : DEFAULTS.mode,
    replyMinutes: Math.max(5, Math.min(24 * 60, Math.round(Number(p.replyMinutes)) || DEFAULTS.replyMinutes)),
    maxOffers: Math.max(1, Math.min(30, Math.round(Number(p.maxOffers)) || DEFAULTS.maxOffers)),
    minLeadHours: Math.max(0, Math.min(72, Number(p.minLeadHours) >= 0 && p.minLeadHours !== '' ? Number(p.minLeadHours) : DEFAULTS.minLeadHours)),
    msg: String(p.msg || '').trim().slice(0, 1500) || DEFAULT_MSG,
  };
  await setSetting('waitlist_cfg', JSON.stringify(c));
  return c;
}

// ---------- utilidades ----------
const firstName = (s) => String(s || '').trim().split(/\s+/)[0];
const hoursUntil = (dt) => (new Date(`${dt.replace(' ', 'T')}-03:00`) - Date.now()) / 3600e3;
const periodOf = (dt) => { const h = Number(dt.slice(11, 13)); return h < 12 ? 'manha' : h < 18 ? 'tarde' : 'noite'; };
const dowOf = (dt) => SC.dow(dt.slice(0, 10));
const quandoTxt = (dt) => {
  const d = dt.slice(0, 10); const t = todayLocal(); const dia = weekday(d);
  return d === t ? `hoje, ${dia}` : d === addDays(t, 1) ? `amanhã, ${dia}` : `${['sábado', 'domingo'].includes(dia) ? 'no' : 'na'} ${dia}`;
};
export const whenTxt = (dt) => `${weekday(dt.slice(0, 10))} ${brDate(dt).slice(0, 5)} às ${dt.slice(11, 16)}`;
// Fora do horário comercial (20h–8h) as ofertas esperam a manhã seguinte.
const inWindow = () => { if (process.env.WA_IGNORE_WINDOW) return true; const h = Number(nowLocal().slice(11, 13)); return h >= 8 && h < 20; };

export function prefsText(w) {
  const parts = [];
  const days = String(w.weekdays || '').split(',').filter(Boolean).map(Number);
  parts.push(days.length && days.length < 7 ? days.map((d) => DAYS[d]).join(', ') : 'qualquer dia');
  const per = String(w.periods || '').split(',').filter(Boolean);
  parts.push(per.length && per.length < 3 ? per.map((p) => PERIODS[p]?.toLowerCase()).join(' ou ') : 'qualquer horário');
  if (w.modality && w.modality !== 'qualquer') parts.push(w.modality === 'online' ? 'on-line' : 'presencial');
  if (w.from_date && w.from_date > todayLocal()) parts.push(`a partir de ${brDate(w.from_date)}`);
  if (w.until_date) parts.push(`até ${brDate(w.until_date)}`);
  return parts.join(' · ');
}

async function busyAt(ownerId, start, dur, ignoreId = 0) {
  const end = addMinutes(start, dur);
  return one(`SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.status <> 'cancelada' AND a.id <> ? AND p.owner_id <=> ? AND a.starts_at < ? AND DATE_ADD(a.starts_at, INTERVAL a.duration_min MINUTE) > ?`, [ignoreId, ownerId, end, start]);
}
// O horário continua livre? (escala, bloqueios, outra sessão e compromissos pessoais da Google Agenda)
async function stillFree(slot, ignoreId = 0) {
  const chk = await SC.checkSlot(slot.owner_id, slot.starts_at, slot.duration_min);
  if (!chk.ok) return chk.reason;
  if (await busyAt(slot.owner_id, slot.starts_at, slot.duration_min, ignoreId)) return 'o horário já foi ocupado na agenda';
  try {
    const blocks = await G.busyBlocks(slot.owner_id, `${slot.starts_at.slice(0, 10)} 00:00:00`, `${addDays(slot.starts_at.slice(0, 10), 1)} 00:00:00`);
    if (G.overlaps(blocks, slot.starts_at, slot.duration_min)) return 'há um compromisso pessoal na Google Agenda';
  } catch { /* sem Google: segue */ }
  return null;
}

// ---------- cadastro na lista ----------
const ENTRY_SQL = `SELECT w.*, p.name p_name, p.social_name p_social, p.phone p_phone, p.owner_id p_owner, p.demo p_demo, u.name pro_name, u.title pro_title,
    m.starts_at move_starts, m.status move_status
  FROM waitlist w LEFT JOIN patients p ON p.id = w.patient_id LEFT JOIN users u ON u.id = w.owner_id LEFT JOIN appointments m ON m.id = w.move_appt_id`;
const shape = (w) => (w ? { ...w, display: w.p_social || w.p_name || w.name, phone: w.p_phone || w.phone } : null);
export const get = async (id) => shape(await one(`${ENTRY_SQL} WHERE w.id = ?`, [id]));

export function cleanPrefs(b) {
  const arr = (v) => [].concat(v ?? []).flatMap((x) => String(x).split(','));
  const days = [...new Set(arr(b.weekdays).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const pers = [...new Set(arr(b.periods).filter((x) => PERIODS[x]))];
  const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
  return {
    weekdays: days.length === 7 ? '' : days.join(','), periods: pers.length === 3 ? '' : pers.join(','),
    modality: ['online', 'presencial'].includes(b.modality) ? b.modality : 'qualquer',
    from_date: ymd(b.from_date), until_date: ymd(b.until_date),
  };
}

export async function add(e) {
  const pr = cleanPrefs(e);
  if (e.patient_id) {
    const dup = await one("SELECT id FROM waitlist WHERE patient_id = ? AND status = 'aguardando'", [e.patient_id]);
    if (dup) { await update(dup.id, e); return { id: dup.id, existed: true }; }
  }
  const r = await q(`INSERT INTO waitlist (patient_id, name, phone, owner_id, weekdays, periods, modality, from_date, until_date, notes, priority, move_appt_id, created_via, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [e.patient_id || null, e.patient_id ? null : String(e.name || '').slice(0, 160), e.patient_id ? null : String(e.phone || '').slice(0, 40),
    e.owner_id || null, pr.weekdays, pr.periods, pr.modality, pr.from_date, pr.until_date, String(e.notes || '').slice(0, 500) || null, e.priority ? 1 : 0,
    e.move_appt_id || null, e.via === 'agente' ? 'agente' : 'equipe', e.userId || null]);
  Live.emit(['agenda']);
  setTimeout(() => tick().catch(() => {}), 100); // pode haver vaga aberta compatível
  return { id: r.insertId };
}
export async function update(id, e) {
  const pr = cleanPrefs(e);
  await q('UPDATE waitlist SET owner_id = ?, weekdays = ?, periods = ?, modality = ?, from_date = ?, until_date = ?, notes = ?, priority = ?, move_appt_id = ? WHERE id = ?',
    [e.owner_id || null, pr.weekdays, pr.periods, pr.modality, pr.from_date, pr.until_date, String(e.notes || '').slice(0, 500) || null, e.priority ? 1 : 0, e.move_appt_id || null, id]);
  Live.emit(['agenda']);
}
export async function remove(id, reason = 'removido') {
  await q("UPDATE waitlist SET status = ?, closed_at = NOW() WHERE id = ? AND status = 'aguardando'", [reason === 'expirado' ? 'expirado' : 'removido', id]);
  await q("UPDATE waitlist_offers SET status = 'recusada', answered_at = NOW() WHERE waitlist_id = ? AND status = 'enviada'", [id]);
  Live.emit(['agenda']);
}

// Lista (ordem de atendimento: prioridade, depois quem entrou primeiro).
export async function list(status = 'aguardando') {
  const rows = await q(`${ENTRY_SQL} WHERE w.status = ? ORDER BY w.priority DESC, w.created_at, w.id LIMIT 300`, [status]);
  const out = rows.map(shape);
  // Já conseguiu horário por outro caminho? (sessão marcada depois de entrar na lista)
  const pids = out.filter((w) => w.patient_id && !w.move_appt_id).map((w) => w.patient_id);
  const later = pids.length ? await q(`SELECT patient_id, MIN(starts_at) s, MIN(created_at) c FROM appointments WHERE patient_id IN (?) AND status IN ('agendada','confirmada') AND starts_at > NOW() GROUP BY patient_id`, [pids]) : [];
  for (const w of out) { const l = later.find((x) => x.patient_id === w.patient_id); if (l && !w.move_appt_id && l.c > w.created_at) w.bookedElsewhere = l.s; }
  return out;
}

// ---------- vagas ----------
// Um horário ficou livre (cancelamento, remarcação, exclusão). Registra a vaga e, se automático, começa a oferecer.
export async function slotFreed(a, userId = null) {
  try {
    const c = await config();
    if (!c.enabled || !a?.starts_at) return null;
    const ownerId = a.owner_id ?? (await one('SELECT p.owner_id FROM appointments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ?', [a.id]))?.owner_id;
    if (!ownerId || hoursUntil(a.starts_at) < Math.max(0.5, c.minLeadHours)) return null;
    const dur = Number(a.duration_min) || 40;
    // Sessão de paciente de demonstração: a vaga só é oferecida às pessoas de demonstração (e vice-versa).
    const demo = a.id ? Number((await one('SELECT p.demo FROM appointments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ?', [a.id]))?.demo || 0) : Number(a.demo || 0);
    await q(`INSERT INTO waitlist_slots (owner_id, starts_at, duration_min, modality, source_appt_id, created_by, demo) VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE created_at = IF(status = 'aberta', created_at, NOW()), status = 'aberta', duration_min = VALUES(duration_min), modality = VALUES(modality), source_appt_id = VALUES(source_appt_id), reason = NULL, closed_at = NULL, appointment_id = NULL, notified = 0, demo = VALUES(demo)`,
    [ownerId, a.starts_at, dur, a.modality || null, a.id || null, userId, demo]);
    const slot = await one('SELECT * FROM waitlist_slots WHERE owner_id = ? AND starts_at = ?', [ownerId, a.starts_at]);
    const n = (await candidates(slot, c)).length;
    if (c.auto && n) setTimeout(() => processSlot(slot.id).catch((e) => console.error('lista de espera', e.message)), 50);
    Live.emit(['agenda']);
    return { slotId: slot.id, candidates: n, auto: c.auto };
  } catch (e) { console.error('lista de espera (vaga)', e.message); return null; }
}

// Vaga avulsa criada pela equipe (ex.: horário que sobrou na escala).
export async function openSlot(ownerId, start, dur, userId) {
  const r = await slotFreed({ owner_id: ownerId, starts_at: start, duration_min: dur, modality: null, id: null }, userId);
  return r;
}

// Quem pode receber a oferta desta vaga, na ordem.
export async function candidates(slot, c = null) {
  c = c || (await config());
  const day = slot.starts_at.slice(0, 10);
  const rows = (await q(`${ENTRY_SQL} WHERE w.status = 'aguardando' AND (w.owner_id IS NULL OR w.owner_id = ?)
      AND (w.from_date IS NULL OR w.from_date <= ?) AND (w.until_date IS NULL OR w.until_date >= ?)
      AND NOT EXISTS (SELECT 1 FROM waitlist_offers o WHERE o.slot_id = ? AND o.waitlist_id = w.id)
      AND NOT EXISTS (SELECT 1 FROM waitlist_offers o2 WHERE o2.waitlist_id = w.id AND o2.status = 'enviada' AND o2.expires_at > NOW())
      AND (w.demo = 1 OR COALESCE(p.demo, 0) = 1) = ?
    ORDER BY w.priority DESC, w.created_at, w.id`, [slot.owner_id, day, day, slot.id || 0, slot.demo ? 1 : 0])).map(shape);
  const dow = String(dowOf(slot.starts_at)); const per = periodOf(slot.starts_at);
  const out = [];
  for (const w of rows) {
    if (!w.phone || !WA.normalizePhone(w.phone)) continue;
    if (w.weekdays && !w.weekdays.split(',').includes(dow)) continue;
    if (w.periods && !w.periods.split(',').includes(per)) continue;
    if (w.move_appt_id) { // antecipar: só serve se a vaga for antes da sessão atual (e ela ainda estiver marcada)
      if (!['agendada', 'confirmada'].includes(w.move_status) || !(slot.starts_at < w.move_starts)) continue;
    }
    if (w.patient_id) {
      // Não oferece a quem já tem sessão nesse horário, nem a quem já conseguiu horário por outro caminho.
      const end = addMinutes(slot.starts_at, slot.duration_min);
      if (await one("SELECT id FROM appointments WHERE patient_id = ? AND status <> 'cancelada' AND id <> ? AND starts_at < ? AND DATE_ADD(starts_at, INTERVAL duration_min MINUTE) > ?", [w.patient_id, w.move_appt_id || 0, end, slot.starts_at])) continue;
      if (!w.move_appt_id && await one("SELECT id FROM appointments WHERE patient_id = ? AND status IN ('agendada','confirmada') AND starts_at > NOW() AND created_at > ?", [w.patient_id, w.created_at])) continue;
    }
    out.push(w);
  }
  return out;
}

async function closeSlot(slot, reason, notifyTeam = false) {
  const r = await q("UPDATE waitlist_slots SET status = 'encerrada', reason = ?, closed_at = NOW() WHERE id = ? AND status = 'aberta'", [String(reason).slice(0, 120), slot.id]);
  await q("UPDATE waitlist_offers SET status = 'expirada' WHERE slot_id = ? AND status = 'enviada'", [slot.id]);
  if (r.affectedRows && notifyTeam) notify(slot.owner_id, { title: '⏳ Lista de espera: horário não preenchido', body: `${whenTxt(slot.starts_at)} — ${reason}.`, url: '/agenda/lista-espera', tag: `wl-slot-${slot.id}` });
  Live.emit(['agenda']);
}

// Oferece a vaga a quem estiver na vez (chamado ao abrir a vaga, a cada minuto e após cada resposta).
const running = new Set();
export async function processSlot(slotId, { force = false } = {}) {
  if (running.has(slotId)) return; running.add(slotId);
  try {
    const c = await config();
    const slot = await one('SELECT * FROM waitlist_slots WHERE id = ?', [slotId]);
    if (!slot || slot.status !== 'aberta') return;
    if (hoursUntil(slot.starts_at) < Math.max(0.5, c.minLeadHours)) return closeSlot(slot, 'ficou em cima da hora sem resposta', (await one('SELECT COUNT(*) n FROM waitlist_offers WHERE slot_id = ?', [slot.id])).n > 0);
    const busy = await stillFree(slot);
    if (busy) return closeSlot(slot, busy);
    if (!force && !c.auto) return;
    if (!inWindow()) return;
    const active = await one("SELECT COUNT(*) n FROM waitlist_offers WHERE slot_id = ? AND status = 'enviada' AND expires_at > NOW()", [slot.id]);
    const sent = (await one("SELECT COUNT(*) n FROM waitlist_offers WHERE slot_id = ? AND status <> 'falhou'", [slot.id])).n;
    if (c.mode === 'sequencial' && active.n) return;
    const room = c.mode === 'todos' ? c.maxOffers - sent : (sent < c.maxOffers ? 1 : 0);
    if (room <= 0) { if (!active.n) await closeSlot(slot, `ninguém aceitou após ${sent} oferta(s)`, true); return; }
    const cands = await candidates(slot, c);
    if (!cands.length) {
      // A vaga continua aberta (alguém compatível pode entrar na lista); a equipe é avisada uma vez se ninguém aceitou.
      if (!active.n && sent && !slot.notified) {
        await q('UPDATE waitlist_slots SET notified = 1 WHERE id = ?', [slot.id]);
        notify(slot.owner_id, { title: '⏳ Lista de espera: ninguém aceitou ainda', body: `${whenTxt(slot.starts_at)} — ${sent} pessoa(s) receberam a oferta. O horário continua livre.`, url: '/agenda/lista-espera', tag: `wl-slot-${slot.id}` });
      }
      return;
    }
    let ok = 0;
    for (const w of cands) {
      if (ok >= room) break;
      if (await sendOffer(c, slot, w)) ok++;
    }
  } finally { running.delete(slotId); }
}

// Oferece a vaga a uma pessoa específica (botão “Oferecer” na tela da vaga).
export async function offerTo(slotId, waitlistId) {
  const c = await config();
  const slot = await one('SELECT * FROM waitlist_slots WHERE id = ?', [slotId]);
  if (!slot || slot.status !== 'aberta') return { ok: false, error: 'Esta vaga não está mais aberta.' };
  const busy = await stillFree(slot);
  if (busy) { await closeSlot(slot, busy); return { ok: false, error: `Vaga encerrada: ${busy}.` }; }
  const w = await get(waitlistId);
  if (!w || w.status !== 'aguardando') return { ok: false, error: 'Esta pessoa não está mais na lista.' };
  if (await one('SELECT id FROM waitlist_offers WHERE slot_id = ? AND waitlist_id = ?', [slot.id, w.id])) return { ok: false, error: 'O horário já foi oferecido a esta pessoa.' };
  const r = await sendOffer(c, slot, w);
  return r ? { ok: true } : { ok: false, error: 'Não foi possível enviar pelo WhatsApp.' };
}

async function sendOffer(c, slot, w) {
  const pro = await one('SELECT name, title FROM users WHERE id = ?', [slot.owner_id]);
  const modality = w.modality !== 'qualquer' ? w.modality : (slot.modality || 'online');
  const startMs = new Date(`${slot.starts_at.replace(' ', 'T')}-03:00`).getTime();
  const expMs = Math.min(Date.now() + c.replyMinutes * 60e3, startMs - Math.max(0.5, c.minLeadHours) * 3600e3);
  const minutes = Math.max(5, Math.round((expMs - Date.now()) / 60e3));
  const exp = addMinutes(nowLocal(), minutes);
  const text = WA.render(c.msg || DEFAULT_MSG, {
    nome: firstName(w.display), profissional: pro ? proName(pro) : 'a Dra. Lorrainy Mendes', quando: quandoTxt(slot.starts_at), data: brDate(slot.starts_at),
    hora: slot.starts_at.slice(11, 16), dia_semana: weekday(slot.starts_at.slice(0, 10)), modalidade: modality === 'online' ? 'on-line' : 'presencial', minutos: minutes,
    troca: w.move_appt_id && w.move_starts ? `\nSe aceitar, ele substitui a sua sessão de ${whenTxt(w.move_starts)}.` : '',
  });
  const ins = await q("INSERT IGNORE INTO waitlist_offers (slot_id, waitlist_id, status, modality, sent_at, expires_at) VALUES (?,?,'enviada',?,NOW(),?)", [slot.id, w.id, modality, exp]);
  if (!ins.affectedRows) return false;
  // Demonstração: nada sai pelo WhatsApp (o envio é só simulado).
  const r = w.demo || w.p_demo ? { ok: true, simulated: true } : await WA.send({ phone: w.phone, text, kind: 'lista_espera', patient_id: w.patient_id || null });
  if (!r.ok) {
    await q("UPDATE waitlist_offers SET status = 'falhou', error = ? WHERE id = ?", [String(r.error || '').slice(0, 200), ins.insertId]);
    return false;
  }
  await q('UPDATE waitlist SET offers = offers + 1, last_offer_at = NOW() WHERE id = ?', [w.id]);
  Live.emit(['agenda']);
  return true;
}

// ---------- respostas ----------
// Oferta em aberto para este WhatsApp (a mais recente).
export async function activeOfferFor(phone) {
  const key = WA.phoneKey(phone);
  if (!key) return null;
  const rows = await q(`SELECT o.*, s.owner_id, s.starts_at, s.duration_min, s.status slot_status, w.patient_id, w.phone w_phone, p.phone p_phone, w.move_appt_id
    FROM waitlist_offers o JOIN waitlist_slots s ON s.id = o.slot_id JOIN waitlist w ON w.id = o.waitlist_id LEFT JOIN patients p ON p.id = w.patient_id
    WHERE o.status IN ('enviada','expirada','ocupada') AND o.answered_at IS NULL AND o.sent_at > DATE_SUB(NOW(), INTERVAL 1 DAY) ORDER BY o.id DESC LIMIT 200`);
  return rows.find((o) => WA.phoneKey(o.p_phone || o.w_phone) === key) || null;
}
// A oferta ainda pode ser aceita? (enviada, ou expirada com a vaga ainda aberta)
export const isLive = (o) => !!o && (o.status === 'enviada' || (o.status === 'expirada' && o.slot_status === 'aberta'));

export const YES = /^(sim|s|quero|aceito|aceitar|pode ser|pode|pode marcar|fechado|ok|okay|confirmo|confirmar|1|1️⃣|👍)(?=\s|$)/i;
export const NO = /^(n[aã]o|n|2|2️⃣|não quero|nao quero|não posso|nao posso|não consigo|nao consigo|dispenso)(?=\s|$)/i;
export const OUT = /^(sair|sair da lista|me tira da lista|remover)(?=\s|$)/i;

// Aceite: confere se a vaga ainda está livre, agenda (ou antecipa a sessão) e avisa todo mundo.
export async function accept(offerId, via = 'whatsapp') {
  const o = await one('SELECT * FROM waitlist_offers WHERE id = ?', [offerId]);
  if (!o) return { ok: false, error: 'Oferta não encontrada.' };
  if (o.status === 'ocupada') { await q('UPDATE waitlist_offers SET answered_at = NOW() WHERE id = ?', [o.id]); return { ok: false, error: 'Esse horário acabou de ser preenchido.', code: 'ocupada' }; }
  if (!['enviada', 'expirada'].includes(o.status)) return { ok: false, error: 'Esta oferta já foi respondida.', code: 'respondida' };
  const slot = await one('SELECT * FROM waitlist_slots WHERE id = ?', [o.slot_id]);
  const w = await get(o.waitlist_id);
  if (!slot || !w) return { ok: false, error: 'Vaga não encontrada.' };
  // Trava a vaga: só um aceite vence.
  const lock = await q("UPDATE waitlist_slots SET status = 'preenchida', closed_at = NOW() WHERE id = ? AND status = 'aberta'", [slot.id]);
  if (!lock.affectedRows) {
    await q("UPDATE waitlist_offers SET status = 'ocupada', answered_at = NOW() WHERE id = ?", [o.id]);
    return { ok: false, error: 'Esse horário acabou de ser preenchido.', code: 'ocupada' };
  }
  const busy = await stillFree(slot, w.move_appt_id || 0);
  if (busy) {
    await q("UPDATE waitlist_slots SET status = 'encerrada', reason = ? WHERE id = ?", [busy.slice(0, 120), slot.id]);
    await q("UPDATE waitlist_offers SET status = 'ocupada', answered_at = NOW() WHERE id = ?", [o.id]);
    return { ok: false, error: 'Esse horário não está mais disponível.', code: 'ocupada' };
  }
  let patientId = w.patient_id;
  if (!patientId) { // ainda não é paciente: cria o cadastro
    const ins = await q('INSERT INTO patients (owner_id, name, phone, modality, status, whatsapp_optin, notes_enc) VALUES (?,?,?,?,?,1,?)',
      [slot.owner_id, String(w.name).slice(0, 160), w.phone, o.modality || 'online', 'ativo', encrypt(`Cadastro criado pela lista de espera em ${brDate(todayLocal())}. Completar dados e termo de consentimento.`)]);
    patientId = ins.insertId;
    await q('UPDATE waitlist SET patient_id = ? WHERE id = ?', [patientId, w.id]);
  }
  let apptId; let moved = null;
  if (w.move_appt_id && ['agendada', 'confirmada'].includes(w.move_status)) {
    const old = await one('SELECT a.*, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [w.move_appt_id]);
    await q("UPDATE appointments SET starts_at = ?, duration_min = ?, status = 'agendada', wa_reminder_at = NULL, wa_reminder2_at = NULL, wa_reply = NULL, wa_reply_at = NULL WHERE id = ?", [slot.starts_at, slot.duration_min, old.id]);
    apptId = old.id; moved = old;
  } else {
    const ins = await q("INSERT INTO appointments (patient_id, starts_at, duration_min, modality, created_via) VALUES (?,?,?,?, 'lista_espera')", [patientId, slot.starts_at, slot.duration_min, o.modality || 'online']);
    apptId = ins.insertId;
  }
  await q("UPDATE waitlist_slots SET appointment_id = ? WHERE id = ?", [apptId, slot.id]);
  await q("UPDATE waitlist_offers SET status = 'aceita', answered_at = NOW(), via = ? WHERE id = ?", [via.slice(0, 20), o.id]);
  await q("UPDATE waitlist_offers SET status = 'ocupada' WHERE slot_id = ? AND status = 'enviada'", [slot.id]);
  await q("UPDATE waitlist SET status = 'agendado', appointment_id = ?, closed_at = NOW() WHERE id = ?", [apptId, w.id]);
  // Outras ofertas em aberto para a mesma pessoa deixam de valer (e essas vagas seguem para a próxima da fila).
  const others = await q("SELECT id, slot_id FROM waitlist_offers WHERE waitlist_id = ? AND id <> ? AND status IN ('enviada','expirada') AND answered_at IS NULL", [w.id, o.id]);
  if (others.length) {
    await q("UPDATE waitlist_offers SET status = 'expirada', answered_at = NOW() WHERE id IN (?)", [others.map((x) => x.id)]);
    for (const x of others) setTimeout(() => processSlot(x.slot_id).catch(() => {}), 100);
  }
  await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['lista-espera-aceite', `appointment:${apptId} waitlist:${w.id}`]);
  // Google Agenda, avisos e CRM
  G.syncLater(apptId);
  Live.emit(['agenda', 'crm', 'pacientes']);
  const n = String(w.display).trim().split(/\s+/);
  notify(slot.owner_id, { title: moved ? '⏩ Lista de espera: sessão antecipada' : '✅ Lista de espera: vaga preenchida', body: `${n[0]}${n.length > 1 ? ` ${n[n.length - 1][0]}.` : ''} — ${whenTxt(slot.starts_at)}`, url: `/agenda/${apptId}`, tag: `appt-${apptId}` });
  WA.sendBookingToPatient([apptId], null).catch(() => {});
  WA.sendBookingToProfessional([apptId], null).catch(() => {});
  try { await CRM.cardFor({ phone: w.phone, patientId }); CRM.onAppointment(patientId); } catch (e) { console.error('crm', e.message); }
  // Antecipou: o horário antigo ficou livre e entra na lista para a próxima pessoa.
  if (moved) await slotFreed(moved);
  return { ok: true, appointmentId: apptId, moved: !!moved, when: whenTxt(slot.starts_at) };
}

export async function decline(offerId, { leave = false } = {}) {
  const o = await one('SELECT * FROM waitlist_offers WHERE id = ?', [offerId]);
  if (!o || !['enviada', 'expirada', 'ocupada'].includes(o.status) || o.answered_at) return { ok: false };
  await q("UPDATE waitlist_offers SET status = IF(status = 'ocupada', 'ocupada', 'recusada'), answered_at = NOW() WHERE id = ?", [o.id]);
  if (leave) await remove(o.waitlist_id);
  setTimeout(() => processSlot(o.slot_id).catch(() => {}), 50); // próxima pessoa da lista
  Live.emit(['agenda']);
  return { ok: true };
}

// Resposta direta “SIM/NÃO/SAIR” (sem custo de IA). Devolve null se a mensagem não for uma resposta simples.
export async function handleReply(offer, text) {
  const clean = String(text || '').replace(/[*_~.!,]/g, '').trim();
  const name = firstName((await get(offer.waitlist_id))?.display);
  if (YES.test(clean)) {
    const r = await accept(offer.id, 'whatsapp');
    if (r.ok) return { action: 'aceitou', reply: null }; // a confirmação do agendamento já vai pela mensagem padrão
    return { action: 'ocupada', reply: `Poxa, ${name}, esse horário acabou de ser preenchido. 😕 Você continua na lista de espera e avisamos assim que abrir outro.` };
  }
  if (OUT.test(clean)) { await decline(offer.id, { leave: true }); return { action: 'saiu', reply: `Pronto, ${name}! Tirei você da lista de espera. Se precisar, é só chamar por aqui. 😊` }; }
  if (NO.test(clean)) { await decline(offer.id); return { action: 'recusou', reply: `Tudo bem, ${name}! Você continua na lista de espera e avisamos quando abrir outro horário. 😊` }; }
  return null;
}

// Texto para o contexto do atendente virtual (quando a resposta não é um simples SIM/NÃO).
export async function contextFor(phone) {
  const o = await activeOfferFor(phone);
  if (!o) return null;
  if (!isLive(o)) return `A oferta da lista de espera enviada a este contato (${whenTxt(o.starts_at)}) não está mais disponível: o horário foi preenchido ou encerrado. Se a pessoa quiser esse horário, explique com gentileza que ele não está mais livre, diga que ela continua na lista e ofereça outros horários com consultar_horarios.`;
  const exp = String(o.expires_at).slice(11, 16);
  return `OFERTA DA LISTA DE ESPERA em aberto para este contato (oferta_id ${o.id}): horário ${whenTxt(o.starts_at)} (${o.modality === 'presencial' ? 'presencial' : 'on-line'}), reservado até ${exp}${o.move_appt_id ? '; se aceitar, substitui a sessão já marcada' : ''}. Se a pessoa aceitar, use responder_oferta_vaga com aceitar = true; se recusar, aceitar = false (e sair_da_lista = true se ela não quiser mais esperar). Se ela pedir outro horário, recuse a oferta e ofereça horários com consultar_horarios.`;
}

// ---------- rotina (a cada minuto) ----------
let ticking = false;
export async function tick() {
  if (ticking) return; ticking = true;
  try {
    await q("UPDATE waitlist_offers SET status = 'expirada' WHERE status = 'enviada' AND expires_at <= NOW()");
    await q("UPDATE waitlist SET status = 'expirado', closed_at = NOW() WHERE status = 'aguardando' AND until_date IS NOT NULL AND until_date < CURDATE()");
    await q("UPDATE waitlist_slots SET status = 'encerrada', reason = 'o horário passou', closed_at = NOW() WHERE status = 'aberta' AND starts_at <= NOW()");
    const open = await q("SELECT id FROM waitlist_slots WHERE status = 'aberta' ORDER BY starts_at LIMIT 30");
    for (const s of open) await processSlot(s.id).catch((e) => console.error('lista de espera', e.message));
  } catch (e) { console.error('lista de espera (rotina)', e.message); } finally { ticking = false; }
}

// Números para a tela e para o painel
export async function stats() {
  const s = await one(`SELECT (SELECT COUNT(*) FROM waitlist WHERE status = 'aguardando') waiting,
    (SELECT COUNT(*) FROM waitlist_slots WHERE status = 'aberta') open,
    (SELECT COUNT(*) FROM waitlist_slots WHERE status = 'preenchida' AND closed_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) filled30,
    (SELECT COUNT(*) FROM waitlist_slots WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) slots30`);
  return { waiting: Number(s.waiting), open: Number(s.open), filled30: Number(s.filled30), slots30: Number(s.slots30) };
}
