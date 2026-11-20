// Monitoramento e alertas para o suporte: WhatsApp desconectado, IA sem saldo/suspensa, erros repetidos e backup.
// Os alertas saem por uma SEGUNDA instância do WhatsApp (“instância de alerta”), para continuarem chegando
// mesmo quando a instância principal do consultório cai. Também vão por notificação (push) aos usuários master.
// A queda do próprio sistema é vigiada por fora, pelo servidor do WhatsApp (Evolution), que consulta /saude.
import crypto from 'node:crypto';
import { q, one, db, getSetting, setSetting } from './db.js';
import * as WA from './whatsapp.js';
import * as Agent from './agent.js';
import { notify } from './push.js';
import { nowLocal } from './time.js';

const DEFAULTS = { enabled: false, phones: [], instance: '', checks: { whatsapp: true, ia: true, erros: true, backup: true, sistema: true }, errThreshold: 5, errWindowMin: 10, iaMinUsd: 2 };
export const CHECKS = {
  sistema: 'Sistema fora do ar (vigiado pelo servidor do WhatsApp)',
  whatsapp: 'WhatsApp do consultório desconectado',
  ia: 'Atendente virtual (IA) suspenso ou com saldo baixo',
  erros: 'Erro que se repete várias vezes em poucos minutos',
  backup: 'Falha no backup do Google Drive',
};

export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('monitor_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c, checks: { ...DEFAULTS.checks, ...(c.checks || {}) } };
}
export async function saveConfig(patch) { const c = await config(); const n = { ...c, ...patch }; await setSetting('monitor_cfg', JSON.stringify(n)); return n; }
export const normalizePhones = (txt) => [...new Set(String(txt || '').split(/[\n,;]+/).map((x) => WA.normalizePhone(x)).filter(Boolean))].slice(0, 5);

// ---------- erros repetidos ----------
export async function recordError(err, path = null) {
  try {
    const msg = String(err?.message || err || 'erro').replace(/\s+/g, ' ').slice(0, 300);
    if (/^(Not Found|Sem permissão|Forbidden)/i.test(msg) || err?.status === 404 || err?.status === 403) return;
    const sig = crypto.createHash('sha1').update(msg.replace(/\d+/g, '#')).digest('hex');
    await q('INSERT INTO app_errors (sig, message, path) VALUES (?,?,?)', [sig, msg, path ? String(path).slice(0, 200) : null]);
  } catch { /* nunca derruba a requisição */ }
}

// ---------- envio ----------
async function deliver(text, { viaMain = false } = {}) {
  const c = await config(); const w = await WA.config();
  const sent = [];
  if (c.phones.length && w?.url) {
    const inst = viaMain || !c.instance ? w.instance : c.instance;
    for (const ph of c.phones) {
      try { await WA.sendRaw(w, inst, ph, text); sent.push(`WhatsApp (${inst})`); } catch (e) {
        // instância de alerta fora: tenta pela principal
        if (!viaMain && c.instance && inst !== w.instance) { try { await WA.sendRaw(w, w.instance, ph, text); sent.push(`WhatsApp (${w.instance})`); } catch { /* sem WhatsApp */ } }
      }
    }
  }
  const masters = (await q('SELECT id FROM users WHERE is_master = 1 AND active = 1')).map((u) => u.id);
  if (masters.length) { notify(masters, { title: '🚨 Alerta do sistema', body: text.replace(/\*/g, '').slice(0, 180), url: '/configuracoes/monitoramento', tag: 'monitor' }); sent.push('push'); }
  return [...new Set(sent)];
}
const head = (t) => `🚨 *Sistema Lorrainy Mendes*\n${t}\n_${nowLocal().slice(0, 16).split(' ').reverse().join(' ').replace(/^(\d\d:\d\d) (\d{4})-(\d\d)-(\d\d)$/, '$4/$3 $1')}_`;
async function raise(key, text) {
  const st = await state();
  if (st[key]?.alerted) return false; // já avisado; espera normalizar
  const ch = await deliver(head(text), { viaMain: key === 'wa_alerta' });
  st[key] = { since: nowLocal(), alerted: true };
  await setSetting('monitor_state', JSON.stringify(st));
  await q("INSERT INTO monitor_alerts (alert_key, kind, message, channel) VALUES (?, 'alerta', ?, ?)", [key, text.slice(0, 500), ch.join(', ') || 'nenhum canal']);
  return true;
}
async function clear(key, text) {
  const st = await state();
  if (!st[key]?.alerted) return;
  const ch = await deliver(`✅ *Sistema Lorrainy Mendes*\n${text}`, { viaMain: key === 'wa_alerta' });
  delete st[key];
  await setSetting('monitor_state', JSON.stringify(st));
  await q("INSERT INTO monitor_alerts (alert_key, kind, message, channel) VALUES (?, 'normalizado', ?, ?)", [key, text.slice(0, 500), ch.join(', ') || 'nenhum canal']);
}
async function state() { try { return JSON.parse((await getSetting('monitor_state')) || '{}'); } catch { return {}; } }
export async function sendTest(userName) {
  const ch = await deliver(head(`Alerta de teste enviado por ${userName}. Se você recebeu esta mensagem, os alertas estão funcionando.`));
  await q("INSERT INTO monitor_alerts (alert_key, kind, message, channel) VALUES ('teste', 'teste', ?, ?)", [`Teste por ${userName}`, ch.join(', ') || 'nenhum canal']);
  return ch;
}

// ---------- verificações (a cada poucos minutos, um processo por vez) ----------
let running = false; const waDown = { n: 0 };
export async function tick() {
  if (running) return; running = true;
  let conn;
  try {
    const c = await config();
    if (!c.enabled) return;
    conn = await db().getConnection();
    const [[lk]] = await conn.query("SELECT GET_LOCK('lm_monitor', 0) ok");
    if (!lk.ok) return;
    const w = await WA.config();
    // 1) WhatsApp principal
    if (c.checks.whatsapp && WA.ready(w)) {
      const st = await WA.connectionState(w, true);
      if (st !== 'open') { waDown.n++; if (waDown.n >= 2) await raise('wa_principal', `📵 O WhatsApp do consultório (${w.instance}) está *desconectado* (${st}). Lembretes, confirmações e atendente virtual estão parados.\nReconecte em Configurações → WhatsApp (ler o QR code).`); }
      else { waDown.n = 0; await clear('wa_principal', `O WhatsApp do consultório (${w.instance}) voltou a funcionar.`); }
    }
    // 1b) a própria instância de alerta
    if (c.instance && w?.url) {
      const st = await WA.instanceState(w, c.instance);
      if (st !== 'open') await raise('wa_alerta', `⚠️ A instância de alerta (${c.instance}) está desconectada (${st}). Os próximos alertas sairão pela instância principal.\nReconecte em Configurações → Monitoramento e alertas.`);
      else await clear('wa_alerta', `A instância de alerta (${c.instance}) voltou a funcionar.`);
    }
    // 2) IA
    if (c.checks.ia) {
      const ag = await Agent.config();
      if (ag.enabled) {
        const bal = await Agent.balance();
        const suspended = !Agent.claudeReady(ag);
        const low = bal.known && bal.estimated < Number(c.iaMinUsd || 2);
        if (suspended) await raise('ia', `🤖 O atendente virtual (Claude) está *suspenso*: ${ag.suspended?.reason || 'indisponível'}.${Agent.groqReady(ag) ? ' As respostas seguem pela reserva (Groq).' : ' Os pacientes não estão recebendo resposta automática.'}\nResolva em Configurações → Atendente virtual.`);
        else if (low) await raise('ia', `🤖 Saldo da IA *baixo*: cerca de US$ ${bal.estimated.toFixed(2)}. Recarregue os créditos da Anthropic para o atendente virtual não parar.`);
        else await clear('ia', 'O atendente virtual (IA) está funcionando normalmente.');
      }
    }
    // 3) erros repetidos
    if (c.checks.erros) {
      const top = await one('SELECT sig, message, COUNT(*) n FROM app_errors WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? MINUTE) GROUP BY sig, message ORDER BY n DESC LIMIT 1', [Number(c.errWindowMin) || 10]);
      if (top && Number(top.n) >= Number(c.errThreshold || 5)) await raise(`erro_${top.sig.slice(0, 12)}`, `🐞 Um erro se repetiu *${top.n} vezes* nos últimos ${c.errWindowMin} min:\n“${top.message.slice(0, 200)}”`);
      const st = await state();
      for (const k of Object.keys(st).filter((x) => x.startsWith('erro_'))) {
        const recent = await one('SELECT COUNT(*) n FROM app_errors WHERE sig LIKE ? AND created_at >= DATE_SUB(NOW(), INTERVAL 60 MINUTE)', [`${k.slice(5)}%`]);
        if (!Number(recent.n)) await clear(k, 'O erro que estava se repetindo parou de acontecer (1 hora sem ocorrências).');
      }
      await q('DELETE FROM app_errors WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)');
    }
    // 4) backup
    if (c.checks.backup) {
      const last = await one("SELECT id, status, error FROM backup_runs WHERE dest = 'drive' AND kind <> 'restauracao' AND status <> 'andamento' ORDER BY id DESC LIMIT 1");
      if (last?.status === 'erro') await raise('backup', `☁️ O último backup no Google Drive *falhou*: ${String(last.error || '').slice(0, 160)}\nConfira em Configurações → Backup.`);
      else if (last?.status === 'ok') await clear('backup', 'O backup no Google Drive voltou a funcionar.');
    }
  } catch (e) { console.error('monitor', e.message); } finally {
    if (conn) { await conn.query("SELECT RELEASE_LOCK('lm_monitor')").catch(() => {}); conn.release(); }
    running = false;
  }
}

// ---------- “vigia” externo (servidor do WhatsApp) ----------
// Dados que o vigia precisa para avisar quando o sistema cair; ele guarda uma cópia para usar justamente nessa hora.
export async function watcherInfo() {
  const c = await config(); const w = await WA.config();
  return { enabled: !!(c.enabled && c.checks.sistema && c.phones.length), phones: c.phones, instance: c.instance || w?.instance || '', fallback: w?.instance || '' };
}
export const history = () => q('SELECT * FROM monitor_alerts ORDER BY id DESC LIMIT 30');
