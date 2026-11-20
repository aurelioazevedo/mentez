// Fluxo do atendimento: Agendado → Aguardando → Em atendimento → Finalizado → Pagamento registrado.
// Configurável em Configurações → Recepção e atendimento.
import * as Tenancy from './tenancy.js';
import { q, one, getSetting, setSetting } from './db.js';
import * as Fin from './fin.js';
import * as CRM from './crm.js';
import * as WA from './whatsapp.js';
import * as Live from './live.js';
import { syncLater } from './google.js';
import { nowLocal } from './time.js';
import * as Waitlist from './waitlist.js';
import * as TV from './tv.js';

const DEFAULTS = { payMoment: 'chegada', reminder: 'botao', reminderDelay: 3, reminderUnit: 'h', waitAlertMin: 15 };
// Tempo do lembrete automático, em minutos (configurado em minutos ou horas)
export const reminderMinutes = (c) => (c.reminderUnit === 'min' ? Number(c.reminderDelay) : Number(c.reminderDelay) * 60);
export const reminderText = (c) => `${c.reminderDelay} ${c.reminderUnit === 'min' ? 'min' : (Number(c.reminderDelay) === 1 ? 'hora' : 'horas')}`;
export const PAY_MOMENTS = { chegada: 'Na chegada do paciente (recomendado)', final: 'Ao finalizar a sessão', ambos: 'Na chegada e, se ficar pendente, de novo ao finalizar' };
export const REMINDERS = { botao: 'Só pelo botão (a equipe decide quando enviar)', auto: 'Automático, minutos ou horas depois da sessão', desligado: 'Não oferecer lembrete' };

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('flow_cfg')) || '{}'); } catch { /* padrão */ }
  if (c.reminderDelay === undefined && c.reminderHours) { c.reminderDelay = c.reminderHours; c.reminderUnit = 'h'; } // configuração antiga (só horas)
  return { ...DEFAULTS, ...c };
}
export async function saveConfig(p) {
  const c = {
    payMoment: PAY_MOMENTS[p.payMoment] ? p.payMoment : DEFAULTS.payMoment,
    reminder: REMINDERS[p.reminder] ? p.reminder : DEFAULTS.reminder,
    reminderUnit: p.reminderUnit === 'min' ? 'min' : 'h',
    reminderDelay: p.reminderUnit === 'min' ? Math.max(5, Math.min(1440, Math.round(Number(p.reminderDelay)) || 30)) : Math.max(1, Math.min(72, Math.round(Number(p.reminderDelay)) || 3)),
    waitAlertMin: Math.max(5, Math.min(120, Number(p.waitAlertMin) || DEFAULTS.waitAlertMin)),
  };
  await setSetting('flow_cfg', JSON.stringify(c));
  return c;
}

export const FLOW = ['agendada', 'confirmada', 'aguardando', 'em_atendimento', 'realizada'];
// Muda a situação da sessão registrando os horários do fluxo e mantendo o financeiro em dia.
export async function setStatus(apptId, status, userId) {
  const a = await one('SELECT a.*, p.session_fee FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [apptId]);
  if (!a) return null;
  const now = nowLocal();
  const sets = ['status = ?', 'flow_by = ?']; const vals = [status, userId];
  if (status === 'aguardando' && !a.arrived_at) { sets.push('arrived_at = ?'); vals.push(now); }
  if (status === 'em_atendimento' && !a.started_at) { sets.push('started_at = ?'); vals.push(now); }
  if (status === 'realizada') {
    if (!a.started_at && a.arrived_at) { sets.push('started_at = ?'); vals.push(now); }
    if (!a.finished_at) { sets.push('finished_at = ?'); vals.push(now); }
  }
  if (['agendada', 'confirmada'].includes(status)) sets.push('arrived_at = NULL', 'started_at = NULL', 'finished_at = NULL');
  await q(`UPDATE appointments SET ${sets.join(', ')} WHERE id = ?`, [...vals, a.id]);
  if (status === 'realizada' && a.status !== 'realizada') CRM.onSessionDone(a.patient_id);
  await Fin.onAppointmentStatus({ ...a, status }, userId);
  if (['cancelada', 'falta'].includes(status) || ['cancelada', 'falta'].includes(a.status)) syncLater(a.id);
  Live.emit(['agenda', 'financeiro']);
  // Chegou: gera a senha do painel de chamadas (TV da recepção).
  if (status === 'aguardando' && a.status !== 'aguardando') {
    const tc = await TV.config();
    if (tc.enabled && tc.autoTicket) await TV.assign(a.id).catch((e) => console.error('senha', e.message));
  }
  // Sessão futura cancelada: o horário vai para a lista de espera.
  let freed = null;
  if (status === 'cancelada' && ['agendada', 'confirmada'].includes(a.status)) freed = await Waitlist.slotFreed(a, userId);
  return { ...a, status, freed };
}

// Lembrete automático de pagamento: sessões finalizadas há N horas ainda sem pagamento (uma vez por cobrança).
const RUNNING = Tenancy.scoped({ on: false }); // trava por clínica
export async function autoReminders() {
  if (RUNNING.on) return; RUNNING.on = true;
  try {
    const c = await config();
    if (c.reminder !== 'auto') return;
    const hour = Number(nowLocal().slice(11, 13));
    if (!process.env.WA_IGNORE_WINDOW && (hour < 8 || hour >= 20)) return; // só em horário comercial
    const rows = await q(`SELECT x.id FROM payments x JOIN appointments a ON a.id = x.appointment_id JOIN patients p ON p.id = x.patient_id
      WHERE x.paid_at IS NULL AND x.charged_at IS NULL AND x.origin IN ('sessao','falta') AND p.whatsapp_optin = 1 AND p.demo = 0
        AND COALESCE(a.finished_at, DATE_ADD(a.starts_at, INTERVAL a.duration_min MINUTE)) <= DATE_SUB(NOW(), INTERVAL ? MINUTE)
        AND a.starts_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        AND NOT EXISTS (SELECT 1 FROM payment_events e WHERE e.payment_id = x.id AND e.action = 'lembrete')
      ORDER BY x.id LIMIT 10`, [reminderMinutes(c)]);
    for (const r of rows) {
      const out = await WA.sendCharge(r.id, null);
      if (!out.ok) await Fin.logPay(r.id, 'lembrete', null, `Automático — não enviado: ${out.error}`);
      await new Promise((ok) => setTimeout(ok, Number(process.env.WA_BULK_GAP_MS || 5000)));
    }
  } catch (e) { console.error('lembrete automático', e.message); } finally { RUNNING.on = false; }
}

// Indicadores do dia (para a recepção e o painel)
export async function todayStats(scopeSql = ' ', params = []) {
  const s = await one(`SELECT
      AVG(CASE WHEN a.arrived_at IS NOT NULL AND a.started_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, a.arrived_at, a.started_at) END) avg_wait,
      SUM(a.status = 'aguardando') waiting, SUM(a.status = 'em_atendimento') in_progress, SUM(a.status = 'realizada') done
    FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE DATE(a.starts_at) = CURDATE() ${scopeSql}`, params);
  return { avgWaitMin: s?.avg_wait ? Math.round(Number(s.avg_wait) / 60) : null, waiting: Number(s?.waiting || 0), inProgress: Number(s?.in_progress || 0), done: Number(s?.done || 0) };
}
