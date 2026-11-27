// Agendamento online pelo próprio paciente: horários livres (escala, sessões, Google Agenda, antecedência),
// confirmação do WhatsApp por código de 6 dígitos e criação da sessão com os avisos de sempre.
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt } from './crypto.js';
import { todayLocal, nowLocal, addDays, addMinutes } from './time.js';
import { brDate, weekday } from './html.js';
import * as SC from './schedule.js';
import * as G from './google.js';
import * as WA from './whatsapp.js';
import * as CRM from './crm.js';
import * as Live from './live.js';
import { notify } from './push.js';
import { proName } from './perm.js';
import * as Agent from './agent.js';
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';

const DEFAULTS = { enabled: false, pros: [], allowNew: true, modalities: ['online', 'presencial'], duration: null, step: null, minLeadHours: 12, horizonDays: 21, fewSlots: false, fewCount: 3,
  intro: 'Escolha o melhor dia e horário para a sua sessão. Para confirmar, enviamos um código para o seu WhatsApp.',
  // No site da clínica (script /agendar/site.js): botão flutuante de WhatsApp e seção de agendamento
  siteWa: 'agente', siteWaAgent: '', siteWaMsg: 'Olá! Gostaria de agendar uma consulta.', siteTitle: 'Agende sua consulta on-line',
  siteText: 'Escolha o dia e o horário que cabem na sua rotina. Leva menos de um minuto e a confirmação chega no seu WhatsApp.' };
export const SITE_WA = { agente: 'Atendente virtual', clinica: 'WhatsApp da clínica', off: 'Sem botão' };
export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('booking_cfg')) || '{}'); } catch { /* padrão */ }
  const ag = await Agent.config();
  const out = { ...DEFAULTS, ...c };
  out.durationEff = Number(out.duration) || Number(ag.duration) || 40;
  out.stepEff = Number(out.step) || Number(ag.slotStep) || 60;
  return out;
}
export async function saveConfig(b) {
  const mods = [].concat(b.modalities || []).filter((m) => ['online', 'presencial'].includes(m));
  await setSetting('booking_cfg', JSON.stringify({
    enabled: !!b.enabled, pros: [].concat(b.pros || []).map(Number).filter((n) => n > 0), allowNew: !!b.allowNew,
    modalities: mods.length ? mods : ['online'], duration: Number(b.duration) > 0 ? Math.min(180, Number(b.duration)) : null, step: Number(b.step) > 0 ? Math.min(240, Number(b.step)) : null,
    minLeadHours: Math.max(1, Math.min(168, Number(b.minLeadHours) || 12)), horizonDays: Math.max(3, Math.min(90, Number(b.horizonDays) || 21)),
    intro: String(b.intro || '').trim().slice(0, 500) || DEFAULTS.intro,
    fewSlots: !!b.fewSlots, fewCount: Math.max(2, Math.min(4, Number(b.fewCount) || 3)),
    siteWa: SITE_WA[b.siteWa] ? b.siteWa : DEFAULTS.siteWa, siteWaAgent: String(b.siteWaAgent || '').replace(/\D/g, '').slice(0, 15),
    siteWaMsg: String(b.siteWaMsg || '').trim().slice(0, 300) || DEFAULTS.siteWaMsg,
    siteTitle: String(b.siteTitle || '').trim().slice(0, 120) || DEFAULTS.siteTitle, siteText: String(b.siteText || '').trim().slice(0, 400) || DEFAULTS.siteText,
  }));
}

// Número do WhatsApp conectado à clínica (o mesmo em que o atendente virtual responde); guardado por 10 min
const ownNum = new Map();
export async function connectedNumber() {
  const key = Tenancy.current()?.slug || '-'; const hit = ownNum.get(key);
  if (hit && hit.at > Date.now() - 600e3) return hit.n;
  let n = '';
  try {
    const c = await WA.config();
    if (WA.ready(c)) n = (await WA.listInstances(c)).find((i) => i.name === c.instance && /open/i.test(i.status))?.number || '';
  } catch { /* sem WhatsApp conectado */ }
  ownNum.set(key, { at: Date.now(), n });
  return n;
}
// Para onde o botão do site leva: atendente virtual (número informado ou o conectado), WhatsApp da clínica ou nenhum
export async function siteWhatsApp(c) {
  if (c.siteWa === 'off') return { wa: '', who: 'off' };
  if (c.siteWa === 'agente') { const n = c.siteWaAgent || await connectedNumber(); if (n) return { wa: Brand.waNumber(n), who: 'agente' }; }
  return { wa: Brand.get().wa, who: 'clinica' };
}

// Profissionais que aparecem na página (com escala configurada)
export async function professionals(c) {
  const rows = await q("SELECT id, name, title, crp, modalities FROM users WHERE active = 1 AND demo = 0 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");
  const out = [];
  for (const u of rows) {
    if (c.pros.length && !c.pros.includes(u.id)) continue;
    if (!(await SC.getSchedule(u.id)).configured) continue;
    // modalidades da agenda online que este profissional atende
    const mods = c.modalities.filter((m) => String(u.modalities || 'online,presencial').split(',').includes(m));
    if (!mods.length) continue;
    out.push({ ...u, display: proName(u), mods });
  }
  return out;
}

const hoursUntil = (dt) => (new Date(`${dt.replace(' ', 'T')}-03:00`) - Date.now()) / 3600e3;
async function busy(ownerId, start, dur, ignoreId = 0) {
  const end = addMinutes(start, dur);
  return one(`SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.status <> 'cancelada' AND p.owner_id <=> ? AND a.starts_at < ? AND DATE_ADD(a.starts_at, INTERVAL a.duration_min MINUTE) > ? AND a.id <> ?`, [ownerId, end, start, ignoreId || 0]);
}
// Grade do profissional (escala) > a do agendamento online > a do atendente virtual
export async function gridFor(c, ownerId) { return SC.gridOf(await SC.getSchedule(ownerId), c.durationEff, c.stepEff); }
// O horário pode ser agendado? (null = sim; senão o motivo)
// opts: { ignoreId (sessão sendo remarcada), dur (duração dela) }
export async function check(c, ownerId, start, blocks = null, opts = {}) {
  const dur = opts.dur || (await gridFor(c, ownerId)).duration;
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:00$/.test(start)) return 'Horário inválido.';
  if (hoursUntil(start) < c.minLeadHours) return `É preciso agendar com pelo menos ${c.minLeadHours} horas de antecedência.`;
  if (start.slice(0, 10) > addDays(todayLocal(), c.horizonDays)) return 'Data além do período disponível.';
  const sched = await SC.getSchedule(ownerId);
  if (!sched.configured) return 'Agenda indisponível.';
  const chk = await SC.checkSlot(ownerId, start, dur, sched);
  if (!chk.ok) return chk.reason;
  if (await busy(ownerId, start, dur, opts.ignoreId)) return 'Esse horário acabou de ser ocupado.';
  const bl = blocks || await G.busyBlocks(ownerId, `${start.slice(0, 10)} 00:00:00`, `${addDays(start.slice(0, 10), 1)} 00:00:00`).catch(() => []);
  if (G.overlaps(bl, start, dur)) return 'Esse horário não está disponível.';
  return null;
}
// Horários livres agrupados por dia
export async function slots(c, ownerId, from = null, days = 14, opts = {}) {
  const sched = await SC.getSchedule(ownerId);
  if (!sched.configured) return [];
  const start = from && from > todayLocal() ? from : todayLocal();
  const last = addDays(todayLocal(), c.horizonDays);
  const blocks = await G.busyBlocks(ownerId, `${start} 00:00:00`, `${addDays(start, days)} 00:00:00`).catch(() => []);
  const g = SC.gridOf(sched, c.durationEff, c.stepEff);
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    if (d > last) break;
    const st = await SC.dayStatus(ownerId, d, sched);
    if (!st.works || st.unrestricted) continue;
    const times = [];
    for (const t of SC.startsIn(st, d, opts.dur || g.duration, g.step)) {
      if (!(await check(c, ownerId, t, blocks, opts))) times.push(t.slice(11, 16));
    }
    if (times.length) out.push({ day: d, label: `${weekday(d)}, ${brDate(d).slice(0, 5)}`, times });
  }
  return out;
}

// Estratégia “poucas opções”: em vez da grade inteira, oferece só n horários (2 a 4), os mais próximos,
// espalhados por dias e períodos diferentes (manhã, tarde, noite). A escolha é estável: muda só quando a agenda muda.
// page = 0 mostra os primeiros; “Ver outras opções” avança para os próximos n.
const period = (t) => (t < '12:00' ? 0 : t < '18:00' ? 1 : 2);
export async function fewSlots(c, ownerId, page = 0) {
  const n = Math.max(2, Math.min(4, Number(c.fewCount) || 3));
  const days = await slots(c, ownerId, null, Math.min(c.horizonDays, 45));
  const all = days.flatMap((d) => d.times.map((t) => ({ day: d.day, label: d.label, t })));
  const need = n * (page + 1);
  const picks = []; const taken = new Set(); let lastP = -1;
  // 1ª passada: no máximo um horário por dia, alternando o período em relação ao anterior
  for (const d of days) {
    if (picks.length >= need) break;
    const t = d.times.find((x) => period(x) !== lastP) || d.times[0];
    picks.push({ day: d.day, label: d.label, t }); taken.add(`${d.day} ${t}`); lastP = period(t);
  }
  // 2ª passada: completa com os demais horários, em ordem
  for (const x of all) { if (picks.length >= need) break; if (!taken.has(`${x.day} ${x.t}`)) { picks.push(x); taken.add(`${x.day} ${x.t}`); } }
  const shown = picks.slice(page * n, page * n + n).sort((a, b) => `${a.day} ${a.t}`.localeCompare(`${b.day} ${b.t}`));
  return { n, shown, more: all.length > need };
}

// ---------- pedido + código ----------
const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const ipHits = new Map();
export async function request(c, { ownerId, start, modality, name, phone, email, ip }) {
  const now = Date.now(); const k = String(ip || '');
  const hits = (ipHits.get(k) || []).filter((t) => t > now - 3600e3);
  if (hits.length >= 8) return { ok: false, error: 'Muitas tentativas. Tente de novo mais tarde ou fale conosco pelo WhatsApp.' };
  const num = WA.normalizePhone(phone);
  if (!num) return { ok: false, error: 'Informe um WhatsApp válido, com DDD.' };
  if ((await one('SELECT COUNT(*) n FROM booking_requests WHERE phone = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)', [num])).n >= 3) return { ok: false, error: 'Já enviamos códigos demais para este número. Tente de novo em 1 hora.' };
  const nm = String(name || '').trim().replace(/\s+/g, ' ');
  if (nm.split(' ').length < 2 || nm.length > 160) return { ok: false, error: 'Informe o nome completo (nome e sobrenome).' };
  const bad = await check(c, ownerId, start);
  if (bad) return { ok: false, error: bad };
  const waCfg = await WA.config();
  if (!WA.ready(waCfg)) return { ok: false, error: 'O agendamento online está temporariamente indisponível. Fale conosco pelo WhatsApp.' };
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, '0');
  const token = crypto.randomBytes(18).toString('base64url');
  await q('INSERT INTO booking_requests (token, owner_id, starts_at, duration_min, modality, name, phone, email, code_hash, ip, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?, DATE_ADD(NOW(), INTERVAL 15 MINUTE))',
    [token, ownerId, start, (await gridFor(c, ownerId)).duration, modality === 'presencial' ? 'presencial' : 'online', nm, num, String(email || '').trim().slice(0, 160) || null, hash(`${token}:${code}`), k.slice(0, 64)]);
  hits.push(now); ipHits.set(k, hits);
  const r = await WA.send({ phone: num, text: `Seu código para confirmar o agendamento é *${code}*.\n\nSe não foi você, ignore esta mensagem.`, kind: 'manual' });
  if (!r.ok) return { ok: false, error: 'Não conseguimos enviar o código para este WhatsApp. Confira o número.' };
  return { ok: true, token };
}
export const byToken = (t) => (/^[A-Za-z0-9_-]{20,48}$/.test(String(t || '')) ? one('SELECT * FROM booking_requests WHERE token = ?', [t]) : null);

// Confere o código e cria a sessão (cadastra o paciente se for novo).
export async function confirm(c, token, code) {
  const b = await byToken(token);
  if (!b) return { ok: false, error: 'Pedido não encontrado.' };
  if (b.status === 'agendado') return { ok: true, already: true, appointmentId: b.appointment_id };
  if (b.status !== 'codigo' || String(b.expires_at) < nowLocal()) { await q("UPDATE booking_requests SET status = 'expirado' WHERE id = ? AND status = 'codigo'", [b.id]); return { ok: false, error: 'O código expirou. Escolha o horário de novo.', restart: true }; }
  if (hash(`${token}:${String(code || '').replace(/\D/g, '')}`) !== b.code_hash) {
    const r = await q("UPDATE booking_requests SET attempts = attempts + 1, status = IF(attempts + 1 >= 5, 'bloqueado', status) WHERE id = ?", [b.id]);
    return { ok: false, error: b.attempts + 1 >= 5 ? 'Código incorreto muitas vezes. Escolha o horário de novo.' : 'Código incorreto. Confira a mensagem no seu WhatsApp.', restart: b.attempts + 1 >= 5 && !!r };
  }
  // Paciente já cadastrado com este WhatsApp?
  const key = WA.phoneKey(b.phone);
  const all = await q("SELECT id, name, social_name, owner_id, phone FROM patients WHERE phone IS NOT NULL AND phone <> '' AND status <> 'inativo'");
  const cand = all.filter((p) => WA.phoneKey(p.phone) === key);
  let p = cand.find((x) => x.name.toLowerCase() === b.name.toLowerCase()) || (cand.length === 1 ? cand[0] : null);
  if (p && p.owner_id && p.owner_id !== b.owner_id) return { ok: false, error: 'Você já é paciente de outro(a) profissional do consultório: escolha um horário na agenda dele(a).', otherOwner: p.owner_id, restart: true };
  if (!p && !c.allowNew) return { ok: false, error: 'O agendamento online é só para pacientes em acompanhamento. Fale conosco pelo WhatsApp para a primeira sessão.' };
  const bad = await check(c, b.owner_id, String(b.starts_at));
  if (bad) { await q("UPDATE booking_requests SET status = 'expirado' WHERE id = ?", [b.id]); return { ok: false, error: `${bad} Escolha outro horário.`, restart: true }; }
  // trava o pedido (evita duplo clique)
  const lock = await q("UPDATE booking_requests SET status = 'agendado' WHERE id = ? AND status = 'codigo'", [b.id]);
  if (!lock.affectedRows) return { ok: true, already: true };
  if (!p) {
    const fmt = (n) => { let d = n.replace(/\D/g, ''); if (d.startsWith('55') && d.length >= 12) d = d.slice(2); if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`; return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : n; };
    const ins = await q('INSERT INTO patients (owner_id, name, phone, email, modality, status, whatsapp_optin, notes_enc) VALUES (?,?,?,?,?,?,1,?)',
      [b.owner_id, b.name, fmt(b.phone), b.email, b.modality, 'ativo', encrypt(`Cadastro criado pelo agendamento online em ${brDate(todayLocal())}. Completar dados e termo de consentimento.`)]);
    p = { id: ins.insertId, name: b.name, owner_id: b.owner_id };
  }
  const a = await q("INSERT INTO appointments (patient_id, starts_at, duration_min, modality, created_via) VALUES (?,?,?,?, 'online')", [p.id, b.starts_at, b.duration_min, b.modality]);
  await q('UPDATE booking_requests SET appointment_id = ? WHERE id = ?', [a.insertId, b.id]);
  await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['agendamento-online', `appointment:${a.insertId}`]);
  G.syncLater(a.insertId);
  Live.emit(['agenda', 'pacientes', 'crm']);
  const n = String(p.social_name || p.name).trim().split(/\s+/);
  notify(b.owner_id, { title: '🌐 Agendamento online', body: `${n[0]}${n.length > 1 ? ` ${n[n.length - 1][0]}.` : ''} — ${weekday(String(b.starts_at).slice(0, 10))} ${brDate(b.starts_at).slice(0, 5)} às ${String(b.starts_at).slice(11, 16)}`, url: `/agenda/${a.insertId}`, tag: `appt-${a.insertId}` });
  WA.sendBookingToPatient([a.insertId], null).catch(() => {});
  WA.sendBookingToProfessional([a.insertId], null).catch(() => {});
  try { await CRM.cardFor({ phone: b.phone, name: b.name, patientId: p.id }); CRM.onAppointment(p.id); } catch (e) { console.error('crm', e.message); }
  return { ok: true, appointmentId: a.insertId };
}
