// Relacionamento com o paciente: mensagem de aniversário e pesquisa de satisfação (NPS) após a sessão.
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import crypto from 'node:crypto';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { nowLocal, todayLocal } from './time.js';
import * as WA from './whatsapp.js';
import * as Notify from './notify.js';
import { notify as push } from './push.js';
import * as Live from './live.js';

export const DEFAULTS = {
  bdayOn: false, bdayHour: 9, bdayAlta: false, bdayEmail: true,
  bdayText: 'Feliz aniversário, {nome}! 🎉\nA equipe do {clinica} deseja um novo ano cheio de saúde, leveza e boas descobertas. Um abraço carinhoso! 💛',
  surveyOn: false, surveyDelayH: 3, surveyEveryDays: 60, surveyFirst: true, surveyEmail: true,
  surveyText: 'Olá, {nome}! Como foi sua experiência no {clinica}? Sua opinião leva menos de 1 minuto e nos ajuda a cuidar cada vez melhor de você: {link}',
  thanksText: 'Obrigado por responder! Sua opinião é muito importante para nós. 💛',
  reviewOn: false, reviewUrl: '', reviewMin: 9,
  alertMax: 6,
};
export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('engage_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c };
}
const clamp = (v, d, a, b) => Math.min(b, Math.max(a, Math.round(Number(v) || d)));
export function checkInput(b) {
  if (b.reviewOn && !/^https:\/\/[^\s]+$/.test(String(b.reviewUrl || '').trim())) return 'Informe o link de avaliação (começando com https://).';
  return null;
}
export async function saveConfig(part, b) {
  const cur = await config();
  const t = (k, max) => String(b[k] ?? '').replace(/\r/g, '').trim().slice(0, max) || DEFAULTS[k];
  const next = part === 'aniversario'
    ? { ...cur, bdayOn: !!b.bdayOn, bdayHour: clamp(b.bdayHour, 9, 7, 20), bdayAlta: !!b.bdayAlta, bdayEmail: !!b.bdayEmail, bdayText: t('bdayText', 1000) }
    : { ...cur, surveyOn: !!b.surveyOn, surveyDelayH: clamp(b.surveyDelayH, 3, 1, 48), surveyEveryDays: clamp(b.surveyEveryDays, 60, 7, 365), surveyFirst: !!b.surveyFirst, surveyEmail: !!b.surveyEmail,
      surveyText: t('surveyText', 800), thanksText: t('thanksText', 500), reviewOn: !!b.reviewOn, reviewUrl: String(b.reviewUrl || '').trim().slice(0, 400), reviewMin: clamp(b.reviewMin, 9, 7, 10), alertMax: clamp(b.alertMax, 6, 0, 8) };
  await setSetting('engage_cfg', JSON.stringify(next));
  return next;
}
async function clinicName() {
  return (await Brand.load()).name;
}
const firstName = (p) => WA.firstName(p);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------- aniversário ----------
// Aniversariantes de um dia (29/02 comemora em 28/02 nos anos não bissextos)
function bdaySql(ymd) {
  const md = ymd.slice(5);
  const y = Number(ymd.slice(0, 4)); const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  return md === '02-28' && !leap ? { sql: "DATE_FORMAT(p.birth_date, '%m-%d') IN ('02-28','02-29')", p: [] } : { sql: "DATE_FORMAT(p.birth_date, '%m-%d') = ?", p: [md] };
}
export async function birthdaysOn(ymd, c = null) {
  c = c || await config();
  const b = bdaySql(ymd);
  return q(`SELECT p.id, p.name, p.social_name, p.phone, p.email, p.email_optin, p.birth_date, p.whatsapp_optin, p.birthday_optin, p.birthday_sent_year, p.status, p.owner_id FROM patients p
    WHERE p.birth_date IS NOT NULL AND ${b.sql} AND p.status IN (${c.bdayAlta ? "'ativo','pausa','alta'" : "'ativo','pausa'"}) AND p.demo = 0 ORDER BY p.name`, b.p);
}
export async function upcoming(days = 30) {
  const rows = await q("SELECT p.id, p.name, p.social_name, p.birth_date, p.status, p.birthday_optin, p.birthday_sent_year, p.owner_id FROM patients p WHERE p.birth_date IS NOT NULL AND p.status IN ('ativo','pausa','alta') AND p.demo = 0");
  const today = todayLocal(); const y = Number(today.slice(0, 4));
  const out = [];
  for (const r of rows) {
    const bd = String(r.birth_date).slice(0, 10);
    let next = `${y}-${bd.slice(5)}`;
    if (bd.slice(5) === '02-29' && !((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0)) next = `${y}-02-28`;
    if (next < today) next = `${y + 1}-${bd.slice(5) === '02-29' ? '02-28' : bd.slice(5)}`;
    const d = Math.round((Date.parse(next) - Date.parse(today)) / 864e5);
    if (d <= days) out.push({ ...r, next, inDays: d, age: Number(next.slice(0, 4)) - Number(bd.slice(0, 4)) });
  }
  return out.sort((a, b) => a.inDays - b.inDays || a.name.localeCompare(b.name));
}
export async function sendBirthday(p, { c = null, force = false } = {}) {
  c = c || await config();
  const year = Number(todayLocal().slice(0, 4));
  if (!force && Number(p.birthday_sent_year) === year) return { ok: false, error: 'Já enviada este ano.' };
  if (!p.birthday_optin) return { ok: false, error: 'O paciente não quer receber mensagem de aniversário.' };
  const text = WA.render(c.bdayText, { nome: firstName(p), clinica: await clinicName() });
  let r = { ok: false, error: 'Sem WhatsApp autorizado nem e-mail.' };
  if (p.whatsapp_optin && p.phone && WA.ready(await WA.config())) r = await WA.send({ phone: p.phone, text, kind: 'aniversario', patient_id: p.id });
  if (!r.ok && c.bdayEmail && p.email && EMAIL_RE.test(p.email) && p.email_optin !== 0) {
    const nc = await Notify.config();
    if (Notify.emailReady(nc)) {
      try { await Notify.sendEmail(nc, { to: p.email, subject: `Feliz aniversário, ${firstName(p)}! 🎉`, text, html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:16px;line-height:1.55;color:#3b2a20;max-width:520px;margin:24px auto;padding:28px;background:#fffaf5;border-radius:18px;border:1px solid #ecdccd">${text.replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]).replace(/\n/g, '<br>')}</div>` }); r = { ok: true, via: 'email' }; } catch (e) { r = { ok: false, error: e.message }; }
    }
  }
  if (r.ok) await q('UPDATE patients SET birthday_sent_year = ? WHERE id = ?', [year, p.id]);
  return r;
}

// ---------- pesquisa de satisfação ----------
function sigOf(id) { return crypto.createHmac('sha256', Tenancy.env('SESSION_SECRET') || 'dev').update(`pesquisa:${id}`).digest('base64url').slice(0, 12); }
export const tokenOf = (id) => `${id}.${sigOf(id)}`;
export function idOfToken(tok) {
  const m = /^(\d{1,10})\.([\w-]{12})$/.exec(String(tok || ''));
  if (!m) return null;
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sigOf(m[1]))) ? Number(m[1]) : null;
}
export const surveyUrl = (id) => `${Notify.publicBase()}/s/${tokenOf(id)}`;

// Elegível: sessão realizada há pelo menos X horas (até 3 dias), paciente aceita pesquisas e não respondeu/recebeu há N dias
export async function dueSurveys(c, limit = 20) {
  const now = nowLocal();
  return q(`SELECT a.id appt, a.patient_id, p.name, p.social_name, p.phone, p.email, p.whatsapp_optin, p.email_optin, p.owner_id,
      (SELECT COUNT(*) FROM appointments z WHERE z.patient_id = a.patient_id AND z.status = 'realizada' AND z.starts_at <= a.starts_at) nth
    FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.status = 'realizada' AND p.survey_optin = 1 AND p.demo = 0 AND p.status IN ('ativo','pausa','alta')
      AND DATE_ADD(a.starts_at, INTERVAL a.duration_min + ? * 60 MINUTE) <= ? AND a.starts_at >= DATE_SUB(?, INTERVAL 3 DAY)
      AND NOT EXISTS (SELECT 1 FROM surveys s WHERE s.patient_id = a.patient_id AND s.created_at >= DATE_SUB(?, INTERVAL ? DAY))
      AND NOT EXISTS (SELECT 1 FROM appointments n WHERE n.patient_id = a.patient_id AND n.status = 'realizada' AND n.starts_at > a.starts_at AND n.starts_at <= ?)
    ${c.surveyFirst ? '' : 'HAVING nth > 1'} ORDER BY a.starts_at LIMIT ?`, [c.surveyDelayH, now, now, now, c.surveyEveryDays, now, limit]);
}
export async function sendSurvey(row, { c = null, userId = null } = {}) {
  c = c || await config();
  const ins = await q('INSERT INTO surveys (patient_id, appointment_id, owner_id) VALUES (?,?,?)', [row.patient_id, row.appt || null, row.owner_id || null]);
  const id = ins.insertId;
  const text = WA.render(c.surveyText, { nome: firstName(row), clinica: await clinicName(), link: surveyUrl(id) });
  let r = { ok: false, error: 'Sem WhatsApp autorizado nem e-mail.' }; let channel = 'whatsapp';
  if (row.whatsapp_optin && row.phone && WA.ready(await WA.config())) r = await WA.send({ phone: row.phone, text, kind: 'pesquisa', patient_id: row.patient_id, appointment_id: row.appt || null, user_id: userId });
  if (!r.ok && c.surveyEmail && row.email && EMAIL_RE.test(row.email) && row.email_optin !== 0) {
    const nc = await Notify.config();
    if (Notify.emailReady(nc)) {
      channel = 'email';
      const url = surveyUrl(id);
      try {
        await Notify.sendEmail(nc, { to: row.email, subject: `Como foi sua experiência, ${firstName(row)}?`, text,
          html: `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#3b2a20;max-width:520px;margin:24px auto;padding:28px;background:#fffaf5;border-radius:18px;border:1px solid #ecdccd"><p>${text.replace(url, '').replace(/[&<>]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[m]).replace(/:?\s*$/, '.')}</p><p style="margin-top:20px"><a href="${url}" style="display:inline-block;background:#9c4422;color:#fff;text-decoration:none;padding:12px 22px;border-radius:999px;font-weight:600">Responder (1 minuto)</a></p></div>` });
        r = { ok: true };
      } catch (e) { r = { ok: false, error: e.message }; }
    }
  }
  await q('UPDATE surveys SET channel = ?, sent_at = IF(?, NOW(), NULL), send_error = ? WHERE id = ?', [channel, r.ok ? 1 : 0, r.ok ? null : String(r.error || '').slice(0, 255), id]);
  return { ...r, id };
}
export async function answer(id, score, comment) {
  const s = await one('SELECT s.*, p.name, p.social_name FROM surveys s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [id]);
  if (!s) return null;
  const c = await config();
  await q('UPDATE surveys SET score = ?, comment_enc = ?, answered_at = COALESCE(answered_at, NOW()) WHERE id = ?', [score, comment ? encrypt(comment.slice(0, 1500)) : null, id]);
  if (score <= c.alertMax) push(s.owner_id, { title: '💬 Avaliação baixa na pesquisa de satisfação', body: `${firstName(s)} deu nota ${score}${comment ? `: “${comment.slice(0, 80)}”` : ''}`, url: '/relatorios?aba=satisfacao#comentarios', tag: `survey-${id}` });
  Live.emit('relatorios');
  return { ...s, score };
}

// ---------- rotina (a cada poucos minutos) ----------
const RUNNING = Tenancy.scoped({ on: false }); // trava por clínica
export async function tick() {
  if (RUNNING.on) return { skipped: true };
  RUNNING.on = true;
  const out = { bday: 0, survey: 0, failed: 0 };
  try {
    const c = await config();
    const now = nowLocal(); const hour = Number(now.slice(11, 13));
    const anyTime = !!process.env.WA_IGNORE_WINDOW;
    if (c.bdayOn && (anyTime || (hour >= c.bdayHour && hour < 21))) {
      const year = Number(now.slice(0, 4));
      for (const p of await birthdaysOn(now.slice(0, 10), c)) {
        if (Number(p.birthday_sent_year) === year || !p.birthday_optin) continue;
        const claim = await q('UPDATE patients SET birthday_sent_year = ? WHERE id = ? AND (birthday_sent_year IS NULL OR birthday_sent_year <> ?)', [year, p.id, year]);
        if (!claim.affectedRows) continue;
        const r = await sendBirthday({ ...p, birthday_sent_year: null }, { c });
        if (r.ok) out.bday++; else { out.failed++; await q('UPDATE patients SET birthday_sent_year = NULL WHERE id = ? AND birthday_sent_year = ?', [p.id, year]); }
      }
    }
    if (c.surveyOn && (anyTime || (hour >= 9 && hour < 21))) {
      for (const row of await dueSurveys(c)) {
        const r = await sendSurvey(row, { c });
        if (r.ok) out.survey++; else out.failed++;
      }
    }
    return out;
  } catch (e) { console.error('relacionamento', e.message); return { ...out, error: e.message }; } finally { RUNNING.on = false; }
}

// ---------- resultados (Relatórios → Satisfação) ----------
export async function results(f, r) {
  const w = []; const p = [`${r.from} 00:00:00`, `${r.to} 23:59:59`];
  if (f.prof) { w.push('s.owner_id = ?'); p.push(f.prof); }
  const ws = w.map((x) => ` AND ${x}`).join('');
  const [sent, ans, dist, byPro, recent, series] = await Promise.all([
    one(`SELECT COUNT(*) n FROM surveys s WHERE s.sent_at BETWEEN ? AND ? ${ws}`, p),
    one(`SELECT COUNT(*) n, AVG(score) avg, SUM(score >= 9) pro, SUM(score <= 6) det, SUM(review_clicked_at IS NOT NULL) rev FROM surveys s WHERE s.answered_at BETWEEN ? AND ? ${ws}`, p),
    q(`SELECT score, COUNT(*) n FROM surveys s WHERE s.answered_at BETWEEN ? AND ? ${ws} GROUP BY score`, p),
    q(`SELECT s.owner_id u, COUNT(*) n, AVG(score) avg, SUM(score >= 9) pro, SUM(score <= 6) det FROM surveys s WHERE s.answered_at BETWEEN ? AND ? ${ws} GROUP BY u`, p),
    q(`SELECT s.id, s.score, s.comment_enc, s.answered_at, s.followup_at, s.patient_id, pt.name, pt.social_name, u.name fname FROM surveys s JOIN patients pt ON pt.id = s.patient_id LEFT JOIN users u ON u.id = s.followup_by
       WHERE s.answered_at BETWEEN ? AND ? ${ws} ORDER BY (s.score <= 6 AND s.followup_at IS NULL) DESC, s.answered_at DESC LIMIT 40`, p),
    q(`SELECT DATE_FORMAT(s.answered_at, '%Y-%m-01') k, COUNT(*) n, SUM(score >= 9) pro, SUM(score <= 6) det FROM surveys s WHERE s.answered_at BETWEEN ? AND ? ${ws} GROUP BY k ORDER BY k`, p),
  ]);
  const n = Number(ans.n || 0);
  const nps = (pro, det, tot) => (tot ? Math.round(((Number(pro) - Number(det)) / tot) * 100) : null);
  return {
    sent: Number(sent.n || 0), answered: n, rate: Number(sent.n) ? n / Number(sent.n) : null, avg: ans.avg == null ? null : Number(ans.avg),
    nps: nps(ans.pro, ans.det, n), promoters: Number(ans.pro || 0), detractors: Number(ans.det || 0), passives: n - Number(ans.pro || 0) - Number(ans.det || 0), reviews: Number(ans.rev || 0),
    dist: Object.fromEntries(dist.map((x) => [x.score, Number(x.n)])),
    byPro: byPro.map((x) => ({ u: x.u, n: Number(x.n), avg: Number(x.avg), nps: nps(x.pro, x.det, Number(x.n)) })),
    series: series.map((x) => ({ k: String(x.k).slice(0, 10), n: Number(x.n), nps: nps(x.pro, x.det, Number(x.n)) })),
    recent: recent.map((x) => ({ ...x, comment: (() => { try { return x.comment_enc ? decrypt(x.comment_enc) : ''; } catch { return ''; } })() })),
  };
}
