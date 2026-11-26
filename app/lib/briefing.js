// “Seu dia”: resumo da manhã para cada profissional — agenda do dia, confirmações, horários vagos e pendências
// que travam o dia (evoluções, termos, pagamentos, links de teleconsulta), além de lembretes humanos (aniversário, 1ª sessão).
// Aparece no Início (com nomes, só para quem está logado) e é enviado no horário escolhido pelos canais ligados:
// notificação no celular (padrão), e-mail e WhatsApp do profissional (opcionais). Fora do sistema vão só números e o link:
// nenhum nome de paciente ou conteúdo clínico sai por notificação, e-mail ou WhatsApp.
import { q, one } from './db.js';
import * as Tenancy from './tenancy.js';
import { todayLocal, addDays } from './time.js';

export const DEFAULTS = { on: true, hour: '07:00', push: true, email: false, wa: false, days: [1, 2, 3, 4, 5, 6] };
export const DAY_NAMES = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export function cfgOf(u) {
  let c = {}; try { c = JSON.parse(u?.brief_cfg || '{}') || {}; } catch { c = {}; }
  const hour = /^([01]\d|2[0-3]):[0-5]\d$/.test(c.hour || '') ? c.hour : DEFAULTS.hour;
  const days = Array.isArray(c.days) ? c.days.map(Number).filter((d) => d >= 0 && d <= 6) : DEFAULTS.days;
  return { on: c.on ?? DEFAULTS.on, hour, push: c.push ?? DEFAULTS.push, email: !!(c.email ?? DEFAULTS.email), wa: !!(c.wa ?? DEFAULTS.wa), days };
}
export async function saveCfg(userId, b) {
  const days = [0, 1, 2, 3, 4, 5, 6].filter((d) => b[`d${d}`]);
  const hour = /^([01]\d|2[0-3]):[0-5]\d$/.test(String(b.hour || '')) ? b.hour : DEFAULTS.hour;
  await q('UPDATE users SET brief_cfg = ? WHERE id = ?', [JSON.stringify({ on: !!b.on, hour, push: !!b.push, email: !!b.email, wa: !!b.wa, days }), userId]);
}

const hm = (d) => String(d).slice(11, 16);
const nm = (x) => x.social_name || x.name;
const minOf = (s) => { const [h, m] = String(s).slice(11, 16).split(':').map(Number); return h * 60 + m; };

// Dados do dia de um(a) profissional (pacientes dele(a))
export async function dayOf(u, day = todayLocal()) {
  const appts = await q(`SELECT a.id, a.patient_id, a.starts_at, a.duration_min, a.modality, a.status, a.meeting_link, a.wa_reminder_at, a.wa_reply,
      p.name, p.social_name, p.birth_date, p.consent_at,
      (SELECT COUNT(*) FROM appointments z WHERE z.patient_id = a.patient_id AND z.starts_at < a.starts_at AND z.status IN ('realizada','confirmada','agendada')) prev_n
    FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.owner_id = ? AND a.starts_at >= ? AND a.starts_at < ? AND a.status <> 'cancelada' ORDER BY a.starts_at`, [u.id, day, addDays(day, 1)]);
  const open = appts.filter((a) => ['agendada', 'confirmada'].includes(a.status));
  const confirmed = open.filter((a) => a.status === 'confirmada');
  const reschedule = open.filter((a) => a.wa_reply === 'remarcar');
  const noReply = open.filter((a) => a.status === 'agendada' && a.wa_reminder_at && !a.wa_reply);
  const noReminder = open.filter((a) => a.status === 'agendada' && !a.wa_reminder_at);
  // intervalos livres de 50 min ou mais entre as sessões do dia
  const gaps = [];
  for (let i = 1; i < appts.length; i++) {
    const end = minOf(appts[i - 1].starts_at) + Number(appts[i - 1].duration_min || 50); const next = minOf(appts[i].starts_at);
    if (next - end >= 50) gaps.push({ from: `${String(Math.floor(end / 60)).padStart(2, '0')}:${String(end % 60).padStart(2, '0')}`, to: hm(appts[i].starts_at), min: next - end });
  }
  const ids = [...new Set(appts.map((a) => a.patient_id))];
  const [wait, evo, pay] = await Promise.all([
    one("SELECT COUNT(*) n FROM waitlist WHERE status = 'aguardando' AND (owner_id = ? OR owner_id IS NULL)", [u.id]).catch(() => ({ n: 0 })),
    q(`SELECT a.id, a.starts_at, p.name, p.social_name FROM appointments a JOIN patients p ON p.id = a.patient_id
       WHERE p.owner_id = ? AND a.status = 'realizada' AND a.starts_at >= ? AND a.starts_at < ?
         AND NOT EXISTS (SELECT 1 FROM records r WHERE r.kind = 'evolucao' AND (r.appointment_id = a.id OR (r.patient_id = a.patient_id AND r.record_date = DATE(a.starts_at)))) ORDER BY a.starts_at DESC LIMIT 21`, [u.id, addDays(day, -30), day]).catch(() => []),
    ids.length ? q('SELECT patient_id, COUNT(*) n, SUM(amount) v FROM payments WHERE patient_id IN (?) AND paid_at IS NULL AND due_date <= ? GROUP BY patient_id', [ids, day]).catch(() => []) : [],
  ]);
  const md = day.slice(5, 10);
  const birthdays = appts.filter((a) => a.birth_date && String(a.birth_date).slice(5, 10) === md);
  const firsts = appts.filter((a) => Number(a.prev_n) === 0);
  const noConsent = appts.filter((a) => !a.consent_at);
  const noLink = open.filter((a) => a.modality === 'online' && !a.meeting_link);
  const payBy = Object.fromEntries(pay.map((x) => [x.patient_id, { n: Number(x.n), v: Number(x.v) }]));
  const withDebt = appts.filter((a) => payBy[a.patient_id]);
  return {
    day, appts, open, confirmed, reschedule, noReply, noReminder, gaps, waitlist: Number(wait?.n || 0), evo, withDebt, payBy, birthdays, firsts, noConsent, noLink,
    first: appts[0] ? hm(appts[0].starts_at) : null, last: appts.length ? hm(appts[appts.length - 1].starts_at) : null,
    online: appts.filter((a) => a.modality === 'online').length, presencial: appts.filter((a) => a.modality === 'presencial').length,
    nm, hm,
  };
}

// Texto curto, sem nomes de pacientes (para notificação, e-mail e WhatsApp)
export function summaryText(d, firstName) {
  if (!d.appts.length) return { title: 'Seu dia', body: 'Sem sessões hoje.' };
  const n = d.appts.length;
  const parts = [`${n} ${n === 1 ? 'sessão' : 'sessões'} hoje (${d.first}${n > 1 ? `–${d.last}` : ''})`];
  if (d.confirmed.length) parts.push(`${d.confirmed.length} confirmada(s)`);
  if (d.noReply.length) parts.push(`${d.noReply.length} sem resposta ao lembrete`);
  if (d.reschedule.length) parts.push(`${d.reschedule.length} pediu(ram) para remarcar`);
  const pend = [];
  if (d.evo.length) pend.push(`${d.evo.length > 20 ? 'mais de 20' : d.evo.length} evolução(ões) pendente(s)`);
  if (d.noConsent.length) pend.push(`${d.noConsent.length} termo(s) a assinar`);
  if (d.withDebt.length) pend.push(`${d.withDebt.length} paciente(s) com pagamento em aberto`);
  if (d.noLink.length) pend.push(`${d.noLink.length} sessão(ões) on-line sem link`);
  return { title: `Bom dia${firstName ? `, ${firstName}` : ''}! Seu dia na clínica`, body: parts.join(' · ') + (pend.length ? `\nPendências: ${pend.join(' · ')}` : '') };
}

// ---------- envio no horário escolhido (cada clínica, cada profissional) ----------
const localNow = () => { const d = new Date(Date.now() - 3 * 3600e3); return { ymd: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16), dow: d.getUTCDay() }; };
export async function tick() {
  const now = localNow();
  const users = await q("SELECT id, name, email, phone, role, brief_cfg, brief_last FROM users WHERE active = 1 AND attends = 1 AND role IN ('admin','psicologo')").catch(() => []);
  for (const u of users) {
    const c = cfgOf(u);
    if (!c.on || !c.days.includes(now.dow) || now.hm < c.hour || String(u.brief_last || '').slice(0, 10) === now.ymd) continue;
    if (!c.push && !c.email && !c.wa) continue;
    await q('UPDATE users SET brief_last = ? WHERE id = ?', [now.ymd, u.id]); // marca antes de enviar: nunca duas vezes no mesmo dia
    try { await deliver(u, c, await dayOf(u, now.ymd)); } catch (e) { console.error(`seu dia [${Tenancy.current()?.slug}] ${u.id}:`, e.message); }
  }
}
export async function deliver(u, c, d, { force = false } = {}) {
  if (!d.appts.length && !force) return { skipped: 'sem sessões' };
  const first = String(u.name || '').split(' ')[0];
  const s = summaryText(d, first);
  const url = `${String(Tenancy.env('PUBLIC_URL') || '').replace(/\/+$/, '')}/`;
  const out = [];
  if (c.push) { try { const Push = await import('./push.js'); const n = await Push.sendToUser(u.id, { title: s.title, body: s.body.replace(/\n/g, ' · '), url: '/', tag: 'seu-dia' }); if (n) out.push('notificação'); } catch (e) { console.error('seu dia (push):', e.message); } }
  if (c.email && u.email) {
    try { const N = await import('./notify.js'); const nc = await N.config(); if (N.emailReady(nc)) { await N.sendEmail(nc, { to: u.email, subject: s.title, text: `${s.body}\n\nVeja os detalhes no sistema: ${url}` }); out.push('e-mail'); } } catch (e) { console.error('seu dia (e-mail):', e.message); }
  }
  if (c.wa && u.phone) {
    try { const W = await import('./whatsapp.js'); const wc = await W.config(); if (W.ready(wc)) { const r = await W.send({ phone: u.phone, text: `*${s.title}*\n${s.body}\n\nDetalhes: ${url}`, kind: 'aviso', user_id: u.id }, wc); if (r?.ok !== false) out.push('WhatsApp'); } } catch (e) { console.error('seu dia (WhatsApp):', e.message); }
  }
  return { sent: out };
}
