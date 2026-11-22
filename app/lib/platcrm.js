// Relacionamento da Mentez com as clínicas (Painel): dados cadastrais, anotações internas e o registro das conversas
// pelo WhatsApp da Mentez (instância “mentez-plataforma”): tudo o que sai (cobranças, chamados, mensagens da equipe)
// e tudo o que chega (respostas das clínicas e de contatos novos). Textos guardados cifrados com a chave mestra.
import * as T from './tenancy.js';
import { phoneKey } from './whatsapp.js';

const seal = (t) => T.seal({ t: String(t ?? '') });
export const open = (s) => { try { return T.unseal(s).t ?? ''; } catch { return ''; } };
export const digits = (v) => String(v || '').replace(/\D/g, '');
export const fmtPhone = (v) => { const d = digits(v).replace(/^55(?=\d{10,11}$)/, ''); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : v || ''; };

const COLS = [['legal_name', 'VARCHAR(160) NULL'], ['doc_enc', 'TEXT NULL'], ['cep', 'VARCHAR(9) NULL'], ['street', 'VARCHAR(160) NULL'], ['addr_number', 'VARCHAR(20) NULL'], ['complement', 'VARCHAR(80) NULL'],
  ['district', 'VARCHAR(80) NULL'], ['city', 'VARCHAR(80) NULL'], ['uf', 'CHAR(2) NULL'], ['billing_email', 'VARCHAR(190) NULL'], ['site', 'VARCHAR(190) NULL'], ['instagram', 'VARCHAR(80) NULL'],
  ['source', 'VARCHAR(60) NULL'], ['extra_phones', 'VARCHAR(255) NULL'], ['pros_count', 'INT NULL']];
let ready = null;
export function migrate() {
  ready ||= (async () => {
    for (const [c, def] of COLS) if (!(await T.pone('SELECT 1 x FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?', ['tenants', c]))) await T.pq(`ALTER TABLE tenants ADD COLUMN ${c} ${def}`);
    await T.pq(`CREATE TABLE IF NOT EXISTS plat_notes (id INT AUTO_INCREMENT PRIMARY KEY, tenant_id INT NOT NULL, author VARCHAR(120) NULL, author_email VARCHAR(190) NULL, body_enc TEXT NOT NULL,
      pinned TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (tenant_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await T.pq(`CREATE TABLE IF NOT EXISTS plat_wa_messages (id BIGINT AUTO_INCREMENT PRIMARY KEY, phone VARCHAR(20) NOT NULL, phone_key VARCHAR(20) NULL, tenant_id INT NULL, direction CHAR(3) NOT NULL,
      kind VARCHAR(20) NOT NULL DEFAULT 'manual', author VARCHAR(120) NULL, body_enc MEDIUMTEXT NOT NULL, wa_id VARCHAR(80) NULL, status VARCHAR(10) NOT NULL DEFAULT 'enviado', error VARCHAR(255) NULL,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (phone_key), INDEX (tenant_id), INDEX (wa_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await T.pq(`CREATE TABLE IF NOT EXISTS plat_wa_contacts (phone_key VARCHAR(20) PRIMARY KEY, phone VARCHAR(20) NOT NULL, tenant_id INT NULL, name VARCHAR(120) NULL, last_at DATETIME NULL,
      last_dir CHAR(3) NULL, last_enc TEXT NULL, unread INT NOT NULL DEFAULT 0, INDEX (tenant_id), INDEX (last_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// ---------- dados cadastrais ----------
export const SOURCES = ['Indicação', 'Instagram', 'Google', 'Site da Mentez', 'Evento ou palestra', 'Parceiro', 'Outro'];
export async function profile(id) {
  await migrate();
  const r = await T.pone('SELECT * FROM tenants WHERE id = ?', [id]); if (!r) return null;
  let doc = ''; try { doc = r.doc_enc ? T.unseal(r.doc_enc).d || '' : ''; } catch { doc = ''; }
  return { ...r, doc };
}
const clip = (v, n) => String(v ?? '').trim().slice(0, n) || null;
export async function saveProfile(id, b) {
  await migrate();
  const email = clip(b.owner_email, 190); const bill = clip(b.billing_email, 190);
  for (const e of [email, bill]) if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { error: `E-mail inválido: ${e}` };
  const doc = digits(b.doc);
  if (doc && ![11, 14].includes(doc.length)) return { error: 'CPF ou CNPJ incompleto.' };
  const uf = clip(b.uf, 2)?.toUpperCase() || null;
  const extra = String(b.extra_phones || '').split(/[,;\n]/).map((x) => digits(x)).filter((x) => x.length >= 10).slice(0, 5).join(',') || null;
  await T.pq(`UPDATE tenants SET legal_name = ?, doc_enc = ?, owner_name = ?, owner_crp = ?, owner_email = ?, owner_phone = ?, billing_email = ?, extra_phones = ?, cep = ?, street = ?, addr_number = ?,
    complement = ?, district = ?, city = ?, uf = ?, site = ?, instagram = ?, source = ?, pros_count = ? WHERE id = ?`,
  [clip(b.legal_name, 160), doc ? T.seal({ d: doc }) : null, clip(b.owner_name, 120), clip(b.owner_crp, 30), email, clip(b.owner_phone, 40), bill, extra, clip(digits(b.cep), 9), clip(b.street, 160), clip(b.addr_number, 20),
    clip(b.complement, 80), clip(b.district, 80), clip(b.city, 80), uf, clip(b.site, 190), clip(String(b.instagram || '').replace(/^@/, ''), 80), clip(b.source, 60), Number(b.pros_count) > 0 ? Math.min(999, Math.round(Number(b.pros_count))) : null, id]);
  T.clearCache();
  await relinkTenantPhones(id);
  return { ok: true };
}
// Telefones da clínica (responsável e outros WhatsApps cadastrados)
export async function phonesOf(id) {
  const r = await T.pone('SELECT owner_phone, extra_phones FROM tenants WHERE id = ?', [id]);
  return [...new Set([r?.owner_phone, ...String(r?.extra_phones || '').split(',')].map((x) => digits(x)).filter((x) => x.length >= 10))];
}
export async function tenantOfPhone(phone) {
  const k = phoneKey(phone); if (!k) return null;
  for (const r of await T.pq("SELECT id, owner_phone, extra_phones FROM tenants WHERE (owner_phone IS NOT NULL AND owner_phone <> '') OR (extra_phones IS NOT NULL AND extra_phones <> '')")) {
    if ([r.owner_phone, ...String(r.extra_phones || '').split(',')].some((x) => x && phoneKey(x) === k)) return r.id;
  }
  return null;
}
async function relinkTenantPhones(id) {
  for (const p of await phonesOf(id)) {
    const k = phoneKey(p); if (!k) continue;
    await T.pq('UPDATE plat_wa_messages SET tenant_id = ? WHERE phone_key = ? AND tenant_id IS NULL', [id, k]);
    await T.pq('UPDATE plat_wa_contacts SET tenant_id = ? WHERE phone_key = ?', [id, k]);
  }
}
export async function linkPhone(phone, tenantId) {
  const d = digits(phone); const r = await T.pone('SELECT extra_phones FROM tenants WHERE id = ?', [tenantId]); if (!r) return;
  const list = String(r.extra_phones || '').split(',').filter(Boolean);
  if (!list.some((x) => phoneKey(x) === phoneKey(d))) list.push(d);
  await T.pq('UPDATE tenants SET extra_phones = ? WHERE id = ?', [list.slice(-5).join(','), tenantId]);
  await relinkTenantPhones(tenantId);
}

// ---------- anotações ----------
export async function notes(id) { await migrate(); return (await T.pq('SELECT * FROM plat_notes WHERE tenant_id = ? ORDER BY pinned DESC, id DESC LIMIT 300', [id])).map((n) => ({ ...n, body: open(n.body_enc) })); }
export async function addNote(id, admin, body, pinned) {
  const text = String(body || '').trim().slice(0, 6000); if (text.length < 2) throw new Error('Escreva a anotação.');
  await migrate(); await T.pq('INSERT INTO plat_notes (tenant_id, author, author_email, body_enc, pinned) VALUES (?,?,?,?,?)', [id, admin.name || null, admin.email || null, seal(text), pinned ? 1 : 0]);
}
export async function togglePin(id, nid) { await T.pq('UPDATE plat_notes SET pinned = 1 - pinned WHERE id = ? AND tenant_id = ?', [nid, id]); }
export async function deleteNote(id, nid, admin) {
  const n = await T.pone('SELECT author_email FROM plat_notes WHERE id = ? AND tenant_id = ?', [nid, id]);
  if (!n) return false; if (admin.role !== 'admin' && n.author_email !== admin.email) throw new Error('Só quem escreveu (ou um administrador) pode excluir.');
  await T.pq('DELETE FROM plat_notes WHERE id = ?', [nid]); return true;
}
export async function pinnedNotes(id) { await migrate(); return (await T.pq('SELECT * FROM plat_notes WHERE tenant_id = ? AND pinned = 1 ORDER BY id DESC LIMIT 5', [id])).map((n) => ({ ...n, body: open(n.body_enc) })); }
export async function counts(id) {
  await migrate();
  const n = await T.pone('SELECT COUNT(*) n FROM plat_notes WHERE tenant_id = ?', [id]);
  const u = await T.pone('SELECT COALESCE(SUM(unread),0) n FROM plat_wa_contacts WHERE tenant_id = ?', [id]);
  return { notes: Number(n?.n || 0), unread: Number(u?.n || 0) };
}

// ---------- conversas do WhatsApp da Mentez ----------
async function touch(phone, tenantId, dir, text, { name, unread } = {}) {
  const k = phoneKey(phone); if (!k) return;
  await T.pq(`INSERT INTO plat_wa_contacts (phone_key, phone, tenant_id, name, last_at, last_dir, last_enc, unread) VALUES (?,?,?,?,NOW(),?,?,?)
    ON DUPLICATE KEY UPDATE phone = VALUES(phone), tenant_id = COALESCE(VALUES(tenant_id), tenant_id), name = COALESCE(VALUES(name), name), last_at = NOW(), last_dir = VALUES(last_dir), last_enc = VALUES(last_enc),
    unread = IF(VALUES(last_dir) = 'in', unread + 1, 0)`, [k, digits(phone), tenantId || null, name ? String(name).slice(0, 120) : null, dir, seal(String(text).slice(0, 300)), unread ? 1 : 0]);
}
// Toda mensagem que o WhatsApp da Mentez envia passa por aqui (cobrança, chamados, avisos, equipe)
export async function logOut({ phone, text, kind = 'manual', author = null, waId = null, status = 'enviado', error = null, tenantId = null }) {
  await migrate();
  const tid = tenantId || (await tenantOfPhone(phone));
  await T.pq('INSERT INTO plat_wa_messages (phone, phone_key, tenant_id, direction, kind, author, body_enc, wa_id, status, error) VALUES (?,?,?,?,?,?,?,?,?,?)',
    [digits(phone), phoneKey(phone), tid, 'out', kind, author, seal(text), waId, status, error ? String(error).slice(0, 255) : null]);
  if (status !== 'erro') await touch(phone, tid, 'out', text);
}
const MEDIA = { audioMessage: '🎤 áudio', imageMessage: '📷 imagem', videoMessage: '🎬 vídeo', documentMessage: '📄 arquivo', stickerMessage: 'figurinha', locationMessage: '📍 localização', contactMessage: '👤 contato' };
const textOf = (m) => m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || m?.documentMessage?.caption || m?.buttonsResponseMessage?.selectedDisplayText || m?.listResponseMessage?.title || '';
export async function handleWebhook(body, instance) {
  await migrate();
  const event = String(body?.event || '').toLowerCase().replace(/_/g, '.');
  if (event !== 'messages.upsert') return { ignored: 'event' };
  if (body.instance && body.instance !== instance) return { ignored: 'instance' };
  const items = Array.isArray(body.data) ? body.data : [body.data]; let n = 0;
  for (const d of items) {
    if (!d?.key) continue;
    let jid = d.key.remoteJid || ''; if (jid.includes('@lid') && d.key.remoteJidAlt) jid = d.key.remoteJidAlt;
    if (!jid.endsWith('@s.whatsapp.net')) continue; // grupos, status e listas não entram
    const phone = jid.split('@')[0];
    let text = textOf(d.message).trim();
    if (!text) { const k = Object.keys(d.message || {}).find((x) => MEDIA[x]); if (!k) continue; text = `[${MEDIA[k]}]`; }
    else { const k = Object.keys(d.message || {}).find((x) => MEDIA[x] && x !== 'extendedTextMessage'); if (k && ['imageMessage', 'videoMessage', 'documentMessage'].includes(k)) text = `[${MEDIA[k]}] ${text}`; }
    if (d.key.id && (await T.pone('SELECT id FROM plat_wa_messages WHERE wa_id = ?', [d.key.id]))) continue; // já registrada (envio do sistema)
    const tid = await tenantOfPhone(phone);
    if (d.key.fromMe) {
      // enviada à mão pelo celular da Mentez: espera o sistema registrar os próprios envios antes de concluir
      setTimeout(async () => { try { if (!(await T.pone('SELECT id FROM plat_wa_messages WHERE wa_id = ?', [d.key.id]))) await logOut({ phone, text, kind: 'celular', author: 'Celular da Mentez', waId: d.key.id, tenantId: tid }); } catch (e) { console.error('whatsapp mentez:', e.message); } }, 6000);
      continue;
    }
    await T.pq('INSERT INTO plat_wa_messages (phone, phone_key, tenant_id, direction, kind, author, body_enc, wa_id, status) VALUES (?,?,?,?,?,?,?,?,?)',
      [digits(phone), phoneKey(phone), tid, 'in', 'recebida', d.pushName ? String(d.pushName).slice(0, 120) : null, seal(text), d.key.id || null, 'recebido']);
    await touch(phone, tid, 'in', text, { name: d.pushName, unread: true }); n++;
  }
  return { ok: true, saved: n };
}
export async function threadOf({ tenantId = null, phone = null }) {
  await migrate();
  const rows = tenantId
    ? await T.pq('SELECT * FROM plat_wa_messages WHERE tenant_id = ? ORDER BY id DESC LIMIT 300', [tenantId])
    : await T.pq('SELECT * FROM plat_wa_messages WHERE phone_key = ? ORDER BY id DESC LIMIT 300', [phoneKey(phone)]);
  return rows.reverse().map((m) => ({ ...m, body: open(m.body_enc) }));
}
export async function markRead({ tenantId = null, phone = null }) {
  if (tenantId) await T.pq('UPDATE plat_wa_contacts SET unread = 0 WHERE tenant_id = ?', [tenantId]);
  else await T.pq('UPDATE plat_wa_contacts SET unread = 0 WHERE phone_key = ?', [phoneKey(phone)]);
}
export async function inbox() {
  await migrate();
  return (await T.pq('SELECT c.*, n.name tenant_name FROM plat_wa_contacts c LEFT JOIN tenants n ON n.id = c.tenant_id ORDER BY c.unread > 0 DESC, c.last_at DESC LIMIT 300')).map((c) => ({ ...c, last: open(c.last_enc) }));
}
export async function unreadTotal() { await migrate(); return Number((await T.pone('SELECT COUNT(*) n FROM plat_wa_contacts WHERE unread > 0'))?.n || 0); }
export async function contact(phone) { await migrate(); return T.pone('SELECT * FROM plat_wa_contacts WHERE phone_key = ?', [phoneKey(phone)]); }
