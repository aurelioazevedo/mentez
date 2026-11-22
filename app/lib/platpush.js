// Notificações push do Painel Mentez (aplicativo instalado da equipe): chamados, mensagens no WhatsApp da Mentez,
// novas clínicas em teste e pagamentos. Cada pessoa da equipe escolhe o que quer receber (Minha conta).
// Chaves VAPID próprias da plataforma (a privada selada com a chave mestra).
import webpush from 'web-push';
import crypto from 'node:crypto';
import * as T from './tenancy.js';

export const TOPICS = { chamados: 'Chamados novos e respostas das clínicas', conversas: 'Mensagens no WhatsApp da Mentez', cadastros: 'Novas clínicas em teste grátis', pagamentos: 'Pagamentos e atrasos das mensalidades' };
// quem recebe cada assunto por padrão (dá para ligar/desligar em Minha conta)
const DEFAULT_ROLES = { chamados: ['admin', 'suporte', 'financeiro'], conversas: ['admin', 'suporte'], cadastros: ['admin', 'suporte'], pagamentos: ['admin', 'financeiro'] };
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

let ready = null;
function migrate() {
  ready ||= (async () => {
    await T.pq(`CREATE TABLE IF NOT EXISTS plat_push_subs (id INT AUTO_INCREMENT PRIMARY KEY, user_id INT NOT NULL, endpoint VARCHAR(700) NOT NULL, endpoint_hash CHAR(64) NOT NULL UNIQUE,
      p256dh VARCHAR(255) NOT NULL, auth VARCHAR(255) NOT NULL, device VARCHAR(120) NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at DATETIME NULL, INDEX (user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    if (!(await T.pone("SELECT 1 x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'platform_users' AND COLUMN_NAME = 'push_prefs'"))) await T.pq('ALTER TABLE platform_users ADD COLUMN push_prefs VARCHAR(255) NULL');
  })().catch((e) => { ready = null; throw e; });
  return ready;
}
let vapid = null;
export async function keys() {
  if (vapid) return vapid;
  const raw = (await T.pone("SELECT v FROM platform_settings WHERE k = 'plat_vapid'"))?.v;
  if (raw) { const o = JSON.parse(raw); vapid = { publicKey: o.publicKey, privateKey: T.unseal(o.private_sealed).k }; return vapid; }
  const k = webpush.generateVAPIDKeys();
  await T.pq("INSERT IGNORE INTO platform_settings (k, v) VALUES ('plat_vapid', ?)", [JSON.stringify({ publicKey: k.publicKey, private_sealed: T.seal({ k: k.privateKey }) })]);
  vapid = null; return keys();
}
export async function subscribe(userId, sub, device) {
  await migrate();
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Inscrição inválida.');
  await T.pq(`INSERT INTO plat_push_subs (user_id, endpoint, endpoint_hash, p256dh, auth, device) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), device = VALUES(device)`,
  [userId, sub.endpoint.slice(0, 700), sha(sub.endpoint), String(sub.keys.p256dh).slice(0, 255), String(sub.keys.auth).slice(0, 255), String(device || '').slice(0, 120)]);
}
export async function unsubscribe(userId, endpointOrId) {
  await migrate();
  if (typeof endpointOrId === 'number') return T.pq('DELETE FROM plat_push_subs WHERE id = ? AND user_id = ?', [endpointOrId, userId]);
  return T.pq('DELETE FROM plat_push_subs WHERE endpoint_hash = ? AND user_id = ?', [sha(endpointOrId), userId]);
}
export async function devices(userId) { await migrate(); return T.pq('SELECT id, device, created_at, last_used_at FROM plat_push_subs WHERE user_id = ? ORDER BY id DESC', [userId]); }
export async function prefsOf(user) {
  await migrate();
  let p = null; try { p = JSON.parse((await T.pone('SELECT push_prefs FROM platform_users WHERE id = ?', [user.id]))?.push_prefs || 'null'); } catch { p = null; }
  return Object.fromEntries(Object.keys(TOPICS).map((k) => [k, p && k in p ? !!p[k] : DEFAULT_ROLES[k].includes(user.role)]));
}
export async function savePrefs(userId, body) {
  await migrate();
  await T.pq('UPDATE platform_users SET push_prefs = ? WHERE id = ?', [JSON.stringify(Object.fromEntries(Object.keys(TOPICS).map((k) => [k, !!body[`t_${k}`]]))), userId]);
}
async function sendTo(userId, payload) {
  const subs = await T.pq('SELECT * FROM plat_push_subs WHERE user_id = ?', [userId]); if (!subs.length) return 0;
  const k = await keys(); let ok = 0;
  const opts = { vapidDetails: { subject: 'mailto:contato@mentez.com.br', publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 6 * 3600, urgency: 'high', timeout: 10e3 };
  const body = JSON.stringify({ icon: '/static/img/mentez/app-192.png', badge: '/static/img/mentez/badge-96.png', ...payload });
  for (const s of subs) {
    try { await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, opts); await T.pq('UPDATE plat_push_subs SET last_used_at = NOW() WHERE id = ?', [s.id]); ok++; }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await T.pq('DELETE FROM plat_push_subs WHERE id = ?', [s.id]); else console.error('push painel', e.statusCode || '', e.message); }
  }
  return ok;
}
export async function test(userId) { await migrate(); return sendTo(userId, { title: 'Painel Mentez', body: 'Notificações ativadas neste aparelho. ✅', url: '/', tag: 'teste' }); }
// Envia para toda a equipe que quer receber este assunto (em segundo plano; não atrasa quem chamou)
export function notify(topic, payload) {
  (async () => {
    await migrate();
    const users = await T.pq('SELECT u.id, u.role FROM platform_users u WHERE u.active = 1 AND EXISTS (SELECT 1 FROM plat_push_subs s WHERE s.user_id = u.id)');
    for (const u of users) if ((await prefsOf(u))[topic]) await sendTo(u.id, { tag: topic, ...payload });
  })().catch((e) => console.error('push painel:', e.message));
}
