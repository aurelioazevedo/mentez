// Escalas e questionários de acompanhamento (instrumentos de uso livre): PHQ-9 e GAD-7.
// O paciente responde por link (WhatsApp), pelo portal ou na sessão; o sistema soma, classifica e
// mostra a evolução. O item 9 do PHQ-9 (pensamentos de se ferir) gera alerta imediato à psicóloga.
import crypto from 'node:crypto';
import { q, one } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { nowLocal, addDays } from './time.js';
import * as WA from './whatsapp.js';
import { notify as push } from './push.js';
import * as Live from './live.js';

const FREQ = [['Nenhuma vez', 0], ['Vários dias', 1], ['Mais da metade dos dias', 2], ['Quase todos os dias', 3]];
const FUNC = ['Nenhuma dificuldade', 'Alguma dificuldade', 'Muita dificuldade', 'Extrema dificuldade'];
export const INSTRUMENTS = {
  phq9: {
    key: 'phq9', short: 'PHQ-9', title: 'Questionário sobre a saúde do paciente (PHQ-9)', domain: 'Sintomas depressivos',
    intro: 'Durante as últimas 2 semanas, com que frequência você foi incomodado(a) por qualquer um dos problemas abaixo?',
    items: [
      'Pouco interesse ou pouco prazer em fazer as coisas',
      'Se sentir “para baixo”, deprimido(a) ou sem perspectiva',
      'Dificuldade para pegar no sono ou permanecer dormindo, ou dormir mais do que de costume',
      'Se sentir cansado(a) ou com pouca energia',
      'Falta de apetite ou comendo demais',
      'Se sentir mal consigo mesmo(a) — ou achar que você é um fracasso ou que decepcionou sua família ou você mesmo(a)',
      'Dificuldade para se concentrar nas coisas, como ler o jornal ou ver televisão',
      'Lentidão para se movimentar ou falar, a ponto das outras pessoas perceberem? Ou o oposto — estar tão agitado(a) ou irrequieto(a) que você fica andando de um lado para o outro muito mais do que de costume',
      'Pensar em se ferir de alguma maneira ou que seria melhor estar morto(a)',
    ],
    options: FREQ, func: true, max: 27, alertItem: 8, mcid: 5,
    bands: [[0, 4, 'Mínimos'], [5, 9, 'Leves'], [10, 14, 'Moderados'], [15, 19, 'Moderadamente graves'], [20, 27, 'Graves']],
    source: 'Spitzer, Williams, Kroenke e colaboradores (Pfizer) — uso livre. Versão em português do Brasil.',
  },
  gad7: {
    key: 'gad7', short: 'GAD-7', title: 'Questionário sobre ansiedade (GAD-7)', domain: 'Sintomas de ansiedade',
    intro: 'Durante as últimas 2 semanas, com que frequência você foi incomodado(a) pelos problemas abaixo?',
    items: [
      'Sentir-se nervoso(a), ansioso(a) ou muito tenso(a)',
      'Não ser capaz de impedir ou de controlar as preocupações',
      'Preocupar-se muito com diversas coisas',
      'Dificuldade para relaxar',
      'Ficar tão agitado(a) que se torna difícil permanecer sentado(a)',
      'Ficar facilmente aborrecido(a) ou irritado(a)',
      'Sentir medo como se algo horrível fosse acontecer',
    ],
    options: FREQ, func: true, max: 21, alertItem: null, mcid: 4,
    bands: [[0, 4, 'Mínimos'], [5, 9, 'Leves'], [10, 14, 'Moderados'], [15, 21, 'Graves']],
    source: 'Spitzer, Kroenke, Williams e Löwe (Pfizer) — uso livre. Versão em português do Brasil.',
  },
};
export const FUNC_Q = 'Se você assinalou qualquer um dos problemas, quanta dificuldade eles causaram para realizar seu trabalho, cuidar das coisas em casa ou se relacionar com as pessoas?';
export const FUNC_OPTS = FUNC;
export const band = (inst, score) => (INSTRUMENTS[inst]?.bands.findIndex(([a, b]) => score >= a && score <= b) ?? -1);
export const bandLabel = (inst, score) => INSTRUMENTS[inst]?.bands[band(inst, score)]?.[2] || '—';
export const VIA = { whatsapp: 'Link pelo WhatsApp', link: 'Link', portal: 'Portal do paciente', sessao: 'Na sessão' };

// ---------- link seguro ----------
function sigOf(id) { return crypto.createHmac('sha256', process.env.SESSION_SECRET || 'dev').update(`escala:${id}`).digest('base64url').slice(0, 16); }
export const tokenOf = (id) => `${id}.${sigOf(id)}`;
export function idOfToken(tok) {
  const m = /^(\d{1,10})\.([\w-]{16})$/.exec(String(tok || ''));
  if (!m) return null;
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sigOf(m[1]))) ? Number(m[1]) : null;
}
export const urlOf = (id) => `${(process.env.PUBLIC_URL || 'https://sistema.lorrainymendes.com.br').replace(/\/+$/, '')}/e/${tokenOf(id)}`;

// ---------- aplicações ----------
export async function create(patientId, instrument, { via = 'link', userId = null, days = 7 } = {}) {
  if (!INSTRUMENTS[instrument]) throw new Error('Instrumento desconhecido.');
  const p = await one('SELECT id, owner_id FROM patients WHERE id = ?', [patientId]);
  if (!p) throw new Error('Paciente não encontrado.');
  const exp = `${addDays(nowLocal().slice(0, 10), days)} 23:59:59`;
  const r = await q('INSERT INTO scale_apps (patient_id, owner_id, instrument, via, expires_at, created_by) VALUES (?,?,?,?,?,?)', [p.id, p.owner_id, instrument, via, exp, userId]);
  return r.insertId;
}
export async function sendWhatsApp(id, userId = null) {
  const a = await one('SELECT s.*, p.name, p.social_name, p.phone, p.whatsapp_optin, p.owner_id FROM scale_apps s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [id]);
  if (!a) return { ok: false, error: 'Questionário não encontrado.' };
  if (!a.whatsapp_optin || !a.phone) return { ok: false, error: 'O paciente não autorizou o WhatsApp ou não tem telefone.' };
  const prof = a.owner_id ? await one('SELECT name, title FROM users WHERE id = ?', [a.owner_id]) : null;
  const who = prof ? `${prof.title || 'Dra.'} ${prof.name.split(' ')[0]}` : 'Sua psicóloga';
  // Texto neutro: não diz o assunto do questionário (pode ser lido por outras pessoas no celular)
  const text = `Olá, ${WA.firstName(a)}! ${who} pediu que você responda um questionário curto de acompanhamento (cerca de 2 minutos). É só tocar no link: ${urlOf(a.id)}\nSuas respostas são confidenciais.`;
  const r = await WA.send({ phone: a.phone, text, kind: 'exercicio', patient_id: a.patient_id, user_id: userId });
  if (r.ok) await q("UPDATE scale_apps SET sent_at = NOW(), via = 'whatsapp' WHERE id = ?", [a.id]);
  return r;
}
export function scoreOf(inst, answers) {
  const I = INSTRUMENTS[inst];
  const vals = I.items.map((_, i) => Number(answers[i]));
  if (vals.some((v) => !Number.isInteger(v) || v < 0 || v > 3)) return null;
  const score = vals.reduce((a, b) => a + b, 0);
  return { score, band: band(inst, score), alert: I.alertItem != null && vals[I.alertItem] > 0 };
}
export async function answer(id, answers, func, via = null) {
  const a = await one('SELECT s.*, p.name, p.social_name FROM scale_apps s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [id]);
  if (!a || a.status !== 'pendente') return null;
  const r = scoreOf(a.instrument, answers);
  if (!r) return { error: 'Responda todas as perguntas.' };
  const f = Number.isInteger(Number(func)) && Number(func) >= 0 && Number(func) <= 3 ? Number(func) : null;
  await q(`UPDATE scale_apps SET status = 'respondido', answered_at = NOW(), answers_enc = ?, result_enc = ?, alert = ?${via ? ', via = ?' : ''} WHERE id = ? AND status = 'pendente'`,
    [encrypt(JSON.stringify({ a: answers.map(Number), f })), encrypt(JSON.stringify({ score: r.score, band: r.band })), r.alert ? 1 : 0, ...(via ? [via] : []), a.id]);
  const I = INSTRUMENTS[a.instrument];
  if (r.alert) push(a.owner_id, { title: `⚠️ Atenção: item 9 do ${I.short} positivo`, body: `${WA.firstName(a)} indicou pensamentos de se ferir ou de que seria melhor estar morto(a). Avalie o risco o quanto antes.`, url: `/pacientes/${a.patient_id}?aba=escalas`, tag: `scale-alert-${a.id}` });
  else push(a.owner_id, { title: `📊 ${I.short} respondido`, body: `${WA.firstName(a)}: ${r.score} pontos (${bandLabel(a.instrument, r.score).toLowerCase()})`, url: `/pacientes/${a.patient_id}?aba=escalas`, tag: `scale-${a.id}` });
  Live.emit('pacientes');
  return { ...r, alertItem: I.alertItem };
}
const dec = (v) => { try { return v ? JSON.parse(decrypt(v)) : null; } catch { return null; } };
export async function history(patientId) {
  const rows = await q('SELECT * FROM scale_apps WHERE patient_id = ? ORDER BY COALESCE(answered_at, created_at) DESC, id DESC LIMIT 200', [patientId]);
  return rows.map((r) => ({ ...r, ans: dec(r.answers_enc), res: dec(r.result_enc) }));
}
export async function pendingForPortal(patientId) {
  return q("SELECT id, instrument, created_at, expires_at FROM scale_apps WHERE patient_id = ? AND status = 'pendente' AND expires_at > NOW() ORDER BY created_at", [patientId]);
}
export async function unseenAlerts(patientId) {
  return q('SELECT id, instrument, answered_at FROM scale_apps WHERE patient_id = ? AND alert = 1 AND alert_seen_at IS NULL ORDER BY answered_at DESC', [patientId]);
}

// ---------- reaplicação automática ----------
export async function plans(patientId) { return q('SELECT * FROM scale_plans WHERE patient_id = ? AND active = 1', [patientId]); }
export async function setPlan(patientId, instrument, everyDays, userId) {
  if (!INSTRUMENTS[instrument]) return;
  if (!everyDays) { await q('UPDATE scale_plans SET active = 0 WHERE patient_id = ? AND instrument = ?', [patientId, instrument]); return; }
  const next = `${addDays(nowLocal().slice(0, 10), everyDays)} 09:00:00`;
  await q(`INSERT INTO scale_plans (patient_id, instrument, every_days, next_at, active, created_by) VALUES (?,?,?,?,1,?)
    ON DUPLICATE KEY UPDATE every_days = VALUES(every_days), next_at = VALUES(next_at), active = 1, created_by = VALUES(created_by)`, [patientId, instrument, everyDays, next, userId]);
}
let running = false;
export async function tick() {
  if (running) return { skipped: true };
  running = true;
  const out = { sent: 0, failed: 0 };
  try {
    const hour = Number(nowLocal().slice(11, 13));
    if (!process.env.WA_IGNORE_WINDOW && (hour < 9 || hour >= 20)) return out;
    const due = await q(`SELECT sp.* FROM scale_plans sp JOIN patients p ON p.id = sp.patient_id WHERE sp.active = 1 AND sp.next_at <= ? AND p.status = 'ativo' LIMIT 20`, [nowLocal()]);
    for (const sp of due) {
      const claim = await q('UPDATE scale_plans SET next_at = ? WHERE id = ? AND next_at = ?', [`${addDays(nowLocal().slice(0, 10), sp.every_days)} 09:00:00`, sp.id, sp.next_at]);
      if (!claim.affectedRows) continue;
      // não manda outro se ainda há um pendente do mesmo instrumento
      if (await one("SELECT id FROM scale_apps WHERE patient_id = ? AND instrument = ? AND status = 'pendente' AND expires_at > NOW()", [sp.patient_id, sp.instrument])) continue;
      const id = await create(sp.patient_id, sp.instrument, { via: 'whatsapp', userId: sp.created_by, days: 7 });
      const r = await sendWhatsApp(id, sp.created_by);
      if (r.ok) out.sent++; else { out.failed++; await q("UPDATE scale_apps SET via = 'portal' WHERE id = ?", [id]); }
    }
    return out;
  } catch (e) { console.error('escalas', e.message); return { ...out, error: e.message }; } finally { running = false; }
}
