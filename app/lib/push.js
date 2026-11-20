// Notificações push (Web Push) para os aparelhos dos profissionais.
// As mensagens são curtas e não levam informação clínica.
import webpush from 'web-push';
import { q, getSetting } from './db.js';
import { encrypt, decrypt, sha256 } from './crypto.js';

let vapid = null;
export async function keys() {
  if (vapid) return vapid;
  const raw = await getSetting('vapid');
  if (raw) {
    const o = JSON.parse(raw);
    vapid = { publicKey: o.publicKey, privateKey: decrypt(o.private_enc) };
  } else {
    // Gera uma única vez; se outro processo gerar ao mesmo tempo, prevalece o primeiro gravado.
    const k = webpush.generateVAPIDKeys();
    await q('INSERT IGNORE INTO settings (k, v) VALUES (?, ?)', ['vapid', JSON.stringify({ publicKey: k.publicKey, private_enc: encrypt(k.privateKey) })]);
    const o = JSON.parse(await getSetting('vapid'));
    vapid = { publicKey: o.publicKey, privateKey: decrypt(o.private_enc) };
  }
  return vapid;
}

export async function subscribe(userId, sub, device) {
  if (!sub?.endpoint || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) throw new Error('Inscrição inválida.');
  await q(`INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, device) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), device = VALUES(device)`,
  [userId, sub.endpoint.slice(0, 700), sha256(sub.endpoint), String(sub.keys.p256dh).slice(0, 255), String(sub.keys.auth).slice(0, 255), String(device || '').slice(0, 120)]);
}
export async function unsubscribe(userId, endpointOrId) {
  if (typeof endpointOrId === 'number') return q('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?', [endpointOrId, userId]);
  return q('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?', [sha256(endpointOrId), userId]);
}
export const devices = (userId) => q('SELECT id, device, created_at, last_used_at FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC', [userId]);

// Envia para todos os aparelhos do usuário. Retorna quantos receberam.
export async function sendToUser(userId, payload) {
  if (!userId) return 0;
  const subs = await q('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  if (!subs.length) return 0;
  const k = await keys();
  const opts = { vapidDetails: { subject: 'mailto:contato@lorrainymendes.com.br', publicKey: k.publicKey, privateKey: k.privateKey }, TTL: 6 * 3600, urgency: 'high', timeout: 10000 };
  let ok = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), opts);
      await q('UPDATE push_subscriptions SET last_used_at = NOW() WHERE id = ?', [s.id]);
      ok++;
    } catch (e) {
      // Aparelho desinstalou ou revogou a permissão: remove a inscrição.
      if (e.statusCode === 404 || e.statusCode === 410) await q('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
      else console.error('push', e.statusCode || '', e.message);
    }
  }
  return ok;
}

// Envio em segundo plano (não atrasa a tela).
export function notify(userIds, payload) {
  const ids = [...new Set([].concat(userIds).filter(Boolean))];
  (async () => { for (const id of ids) await sendToUser(id, payload); })().catch((e) => console.error('push bg', e.message));
}
