// Notificações do sino (barra superior): pendências que pedem ação, por perfil.
import { q, one } from './db.js';
import { can, patientScope } from './perm.js';
import { todayLocal } from './time.js';
import { brDate, money } from './html.js';
import * as WA from './whatsapp.js';
import * as Agent from './agent.js';

const cache = new Map(); // por usuário, 20 s

export async function forUser(user, fresh = false) {
  // O cache vale enquanto não houver alteração nova no sistema (live_events), por até 20 s.
  let mark = 0;
  try { mark = Number((await one('SELECT COALESCE(MAX(id),0) m FROM live_events')).m); } catch { /* tabela ainda não existe */ }
  const hit = cache.get(user.id);
  if (!fresh && hit && hit.mark === mark && hit.at > Date.now() - 20e3) return hit.v;
  const items = [];
  let extra = 0; // pendências além das listadas (o número do sino mostra o total)
  const sc = patientScope(user);
  const today = todayLocal();
  try {
    if (can(user, 'agenda')) {
      // Recepção: quem espera além do limite configurado
      let fc = { waitAlertMin: 15 }; try { fc = { ...fc, ...JSON.parse((await one("SELECT v FROM settings WHERE k = 'flow_cfg'"))?.v || '{}') }; } catch { /* padrão */ }
      const lw = await q(`SELECT a.id, a.arrived_at, p.name, p.social_name, TIMESTAMPDIFF(MINUTE, a.arrived_at, NOW()) mins FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.status = 'aguardando' AND a.arrived_at <= DATE_SUB(NOW(), INTERVAL ? MINUTE) ${sc.sql} ORDER BY a.arrived_at LIMIT 5`, [Number(fc.waitAlertMin) || 15, ...sc.params]);
      for (const x of lw) items.push({ tone: 'err', href: '/recepcao', text: `⏳ ${(x.social_name || x.name).split(' ')[0]} aguarda há ${x.mins} min`, sub: `chegou às ${String(x.arrived_at).slice(11, 16)}` });
    }
    // Profissional: recebimentos diretos para confirmar
    const pc = await one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM payments WHERE paid_at IS NULL AND receiver = 'profissional' AND professional_id = ? AND origin IN ('sessao','falta') AND due_date <= CURDATE()", [user.id]);
    if (Number(pc?.n)) items.push({ tone: 'warn', href: '/recepcao', text: `💳 ${pc.n} recebimento(s) direto(s) para confirmar`, sub: money(pc.t) });
    if (can(user, 'agenda')) {
      const h = await q(`SELECT cv.id, cv.contact_name, cv.phone, cv.human_reason, p.name pn FROM agent_conversations cv LEFT JOIN patients p ON p.id = cv.patient_id
        WHERE cv.status = 'humano' AND (cv.human_until IS NULL OR cv.human_until > NOW()) ORDER BY cv.last_inbound_at DESC LIMIT 5`);
      for (const x of h) items.push({ tone: 'warn', href: `/atendimento/${x.id}`, text: `🙋 ${x.pn || x.contact_name || x.phone} aguarda atendimento humano`, sub: x.human_reason || '' });
      const hc = await one("SELECT COUNT(*) n FROM agent_conversations WHERE status = 'humano' AND (human_until IS NULL OR human_until > NOW())");
      if (hc.n > h.length) { items.push({ tone: 'warn', href: '/atendimento', text: `+${hc.n - h.length} outra(s) conversa(s) aguardando atendimento humano` }); extra += hc.n - h.length - 1; }
      const r = await q(`SELECT a.id, a.starts_at, p.name, p.social_name FROM appointments a JOIN patients p ON p.id = a.patient_id
        WHERE a.wa_reply = 'remarcar' AND a.wa_reschedule_done = 0 AND a.status <> 'cancelada' ${sc.sql} ORDER BY a.starts_at LIMIT 5`, sc.params);
      for (const x of r) items.push({ tone: 'warn', href: `/agenda/${x.id}`, text: `↻ ${x.social_name || x.name} pediu para remarcar`, sub: `sessão de ${brDate(x.starts_at)} às ${x.starts_at.slice(11, 16)}` });
      const rc = await one(`SELECT COUNT(*) n FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.wa_reply = 'remarcar' AND a.wa_reschedule_done = 0 AND a.status <> 'cancelada' ${sc.sql}`, sc.params);
      if (rc.n > r.length) { items.push({ tone: 'warn', href: '/agenda', text: `+${rc.n - r.length} outro(s) pedido(s) de remarcação` }); extra += rc.n - r.length - 1; }
      const wac = await WA.config();
      if (WA.ready(wac)) {
        const st = await WA.connectionState(wac);
        if (st !== 'open') items.push({ tone: 'err', href: can(user, 'usuarios') ? '/configuracoes/whatsapp#aparelho' : '/', text: '📵 WhatsApp do consultório desconectado', sub: 'Lembretes e atendente virtual parados' });
      }
    }
    if (user.is_master) {
      // Backup: falha recente ou acesso ao Drive expirado
      const bset = await one("SELECT v FROM settings WHERE k = 'backup_cfg'");
      let bcfg = {}; try { bcfg = JSON.parse(bset?.v || '{}'); } catch { /* sem backup */ }
      const lastB = await one("SELECT status, error FROM backup_runs WHERE dest = 'drive' AND kind <> 'restauracao' ORDER BY id DESC LIMIT 1");
      if (bcfg.error) items.push({ tone: 'err', href: '/configuracoes/backup', text: '☁️ Backup parado: reconecte o Google Drive', sub: bcfg.error });
      else if (lastB?.status === 'erro') items.push({ tone: 'err', href: '/configuracoes/backup', text: '☁️ O último backup falhou', sub: String(lastB.error || '').slice(0, 90) });
    }
    if (can(user, 'prontuario')) {
      const e = await one(`SELECT COUNT(*) n FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.status = 'respondido' ${sc.sql}`, sc.params);
      if (e.n) items.push({ href: '/exercicios', text: `📝 ${e.n} exercício(s) respondido(s) para revisar` });
    }
    // Pacientes que avisaram pelo portal que já pagaram (clínica: financeiro; recebimento direto: o profissional)
    {
      const fin = can(user, 'financeiro');
      const inf = await one(`SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM payments WHERE paid_at IS NULL AND informed_at IS NOT NULL AND (${fin ? "receiver = 'clinica' OR " : ''}(receiver = 'profissional' AND professional_id = ?))`, [user.id]);
      if (Number(inf?.n)) items.push({ tone: 'warn', href: '/financeiro/receber', text: `💳 ${inf.n} pagamento(s) informado(s) pelo paciente para conferir`, sub: money(inf.t) });
    }
    // Contas da clínica (financeiro) e contas próprias (profissionais) vencidas ou vencendo em 3 dias
    if (can(user, 'financeiro') || can(user, 'meufin')) {
      const mine = ['admin', 'psicologo'].includes(user.role);
      const cl = can(user, 'financeiro') ? await one('SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM fin_entries WHERE owner_id IS NULL AND kind = \'pagar\' AND paid_at IS NULL AND due_date <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)') : { n: 0 };
      if (cl.n) items.push({ tone: 'warn', href: '/financeiro/contas?status=aberto', text: `🧾 ${cl.n} conta(s) da clínica vencendo ou vencida(s)`, sub: money(cl.t) });
      const ow = mine ? await one('SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM fin_entries WHERE owner_id = ? AND kind = \'pagar\' AND paid_at IS NULL AND due_date <= DATE_ADD(CURDATE(), INTERVAL 3 DAY)', [user.id]) : { n: 0 };
      if (ow.n) items.push({ tone: 'warn', href: `/financeiro/contas${can(user, 'financeiro') ? '?de=eu' : ''}`, text: `🧾 ${ow.n} conta(s) sua(s) vencendo ou vencida(s)`, sub: money(ow.t) });
    }
    if (can(user, 'financeiro')) {
      const o = await one('SELECT COUNT(*) n, COALESCE(SUM(amount),0) t FROM payments WHERE paid_at IS NULL AND due_date < ?', [today]);
      if (o.n) items.push({ tone: 'warn', href: '/financeiro?status=atrasado', text: `💳 ${o.n} pagamento(s) em atraso`, sub: money(o.t) });
    }
    if (user.role === 'admin') {
      const ag = await Agent.config();
      if (ag.enabled && ag.suspended) items.push({ tone: Agent.groqReady(ag) ? 'warn' : 'err', href: '/configuracoes/agente', text: Agent.groqReady(ag) ? `🔁 Atendente usando a reserva ${Agent.altLabel(ag)}` : '⛔ Atendente virtual suspenso', sub: ag.suspended.reason });
      else if (ag.enabled) {
        const b = await Agent.balance();
        if (b.known && b.estimated <= b.alertUsd) items.push({ tone: 'warn', href: '/configuracoes/agente#saldo', text: '🤖 Saldo da IA acabando', sub: `≈ US$ ${b.estimated.toFixed(2)}` });
      }
    }
  } catch (e) { console.error('notas', e.message); }
  const v = { count: items.length + extra, items };
  cache.set(user.id, { at: Date.now(), v, mark });
  return v;
}

export function middleware(req, _res, next) {
  if (!req.user || req.method !== 'GET') return next();
  forUser(req.user).then((v) => { req.notes = v; next(); }, () => next());
}
