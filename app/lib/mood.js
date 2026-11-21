// App do paciente: check-in diário de humor (emoção principal, intensidade, anotação opcional).
// Dado de saúde: anotação cifrada; só o profissional responsável vê (como o prontuário).
// Sinal de risco (o paciente marca que não está seguro, ou intensidade 10 numa emoção difícil): a tela mostra CVV/SAMU
// na hora e o profissional recebe alerta (sino e notificação no celular). O app não é canal de emergência.
import { q, one } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { todayLocal } from './time.js';
import { notify } from './push.js';

export const EMOTIONS = [
  ['calma', 'Calma', '🍃', 'pos'], ['alegria', 'Alegria', '☀️', 'pos'], ['gratidao', 'Gratidão', '🌷', 'pos'], ['esperanca', 'Esperança', '🌱', 'pos'],
  ['tristeza', 'Tristeza', '🌧️', 'dif'], ['ansiedade', 'Ansiedade', '🌬️', 'dif'], ['raiva', 'Raiva', '🔥', 'dif'], ['confusao', 'Confusão', '🌫️', 'dif'],
  ['medo', 'Medo', '⛈️', 'dif'], ['saudade', 'Saudade', '🌙', 'neu'], ['vergonha', 'Vergonha', '✨', 'dif'], ['culpa', 'Culpa', '🥀', 'dif'],
  ['cansaco', 'Cansaço', '🪫', 'dif'], ['solidao', 'Solidão', '🕯️', 'dif'],
];
export const byEmotion = Object.fromEntries(EMOTIONS.map(([k, l, e, t]) => [k, { key: k, label: l, emoji: e, tone: t }]));

let ready = false;
async function ensure() {
  if (ready) return;
  await q(`CREATE TABLE IF NOT EXISTS mood_checkins (
    id INT AUTO_INCREMENT PRIMARY KEY, patient_id INT NOT NULL, owner_id INT NULL, day DATE NOT NULL,
    emotion VARCHAR(20) NOT NULL, intensity TINYINT NOT NULL, note_enc TEXT NULL, risk TINYINT(1) NOT NULL DEFAULT 0,
    risk_seen_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (patient_id, day), INDEX (owner_id, risk)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  ready = true;
}
const dec = (r) => (r ? { ...r, note: r.note_enc ? (() => { try { return decrypt(r.note_enc); } catch { return ''; } })() : '', e: byEmotion[r.emotion] || { label: r.emotion, emoji: '•', tone: 'neu' } } : null);

export async function today(pid) { await ensure(); return dec(await one('SELECT * FROM mood_checkins WHERE patient_id = ? AND day = ?', [pid, todayLocal()])); }
export async function history(pid, days = 60) { await ensure(); return (await q('SELECT * FROM mood_checkins WHERE patient_id = ? AND day >= DATE_SUB(CURDATE(), INTERVAL ? DAY) ORDER BY day DESC', [pid, days])).map(dec); }

// Grava (ou corrige) o check-in de hoje
export async function save(p, b) {
  await ensure();
  const e = byEmotion[b.emotion]; if (!e) return { error: 'Escolha a emoção mais próxima do que você sente.' };
  const intensity = Math.min(10, Math.max(0, Math.round(Number(b.intensity)))); if (!Number.isFinite(intensity)) return { error: 'Escolha a intensidade.' };
  const note = String(b.note || '').trim().slice(0, 2000);
  const risk = !!b.unsafe || (e.tone === 'dif' && intensity >= 10) ? 1 : 0;
  await q(`INSERT INTO mood_checkins (patient_id, owner_id, day, emotion, intensity, note_enc, risk) VALUES (?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE emotion = VALUES(emotion), intensity = VALUES(intensity), note_enc = VALUES(note_enc), risk = GREATEST(risk, VALUES(risk)), risk_seen_at = IF(VALUES(risk) = 1, NULL, risk_seen_at)`,
  [p.id, p.owner_id || null, todayLocal(), e.key, intensity, note ? encrypt(note) : null, risk]);
  if (risk && p.owner_id) notify([p.owner_id], { title: '⚠️ Atenção a um paciente', body: `${(p.social_name || p.name).split(' ')[0]} sinalizou no check-in de hoje que pode não estar bem. Veja a ficha.`, url: `/pacientes/${p.id}?aba=humor`, tag: `mood-${p.id}` });
  return { ok: true, risk, emotion: e, intensity };
}

// Alertas para o profissional (sino): sinais de risco ainda não vistos
export async function alertsFor(user, scopeSql = ' ', params = []) {
  await ensure();
  return q(`SELECT m.patient_id, m.day, p.name, p.social_name FROM mood_checkins m JOIN patients p ON p.id = m.patient_id WHERE m.risk = 1 AND m.risk_seen_at IS NULL ${scopeSql} ORDER BY m.day DESC LIMIT 5`, params);
}
export async function markSeen(pid) { await ensure(); await q('UPDATE mood_checkins SET risk_seen_at = NOW() WHERE patient_id = ? AND risk = 1 AND risk_seen_at IS NULL', [pid]); }
