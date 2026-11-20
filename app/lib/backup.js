// Backup do sistema no Google Drive: manual e automático (diário, semanal, mensal),
// com as partes num único .zip ("juntos") ou um arquivo por parte ("separados").
// Formato: SQL comum (um comando por linha) — restaurável pelo próprio sistema ou pelo phpMyAdmin.
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import mysql from 'mysql2';
import AdmZip from 'adm-zip';
import { q, one, db, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import * as G from './google.js';
import * as Live from './live.js';
import { nowLocal, todayLocal, startOfWeek } from './time.js';

const OAUTH = process.env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com';
const API = process.env.GOOGLE_API_BASE || 'https://www.googleapis.com';
const AUTH = process.env.GOOGLE_AUTH_BASE || 'https://accounts.google.com';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'; // só os arquivos criados pelo sistema
const folderName = () => `Backups — ${Brand.get().appName}`;

export const PARTS = {
  banco: { label: 'Banco de dados', desc: 'Pacientes, agenda, prontuários (criptografados), financeiro, CRM, usuários e configurações.' },
  anexos: { label: 'Anexos', desc: 'Boletos, comprovantes e notas anexados no financeiro (também como arquivos comuns, numa pasta) e as imagens e vídeos da TV da recepção.' },
};
export const KINDS = { manual: 'Manual', diario: 'Diário', semanal: 'Semanal', mensal: 'Mensal', restauracao: 'Antes de restaurar' };
const SKIP = new Set(['live_events', 'login_attempts', 'maint_backups', 'backup_runs', 'fin_files', 'tv_media', 'tv_media_chunks']); // temporárias, cópias internas e anexos (parte própria)
const DEFAULTS = { hour: 3, mode: 'juntos', parts: ['banco', 'anexos'], diario: { on: false, keep: 7 }, semanal: { on: true, keep: 4, dow: 0 }, mensal: { on: true, keep: 6, day: 1 } };

// ---------- configuração ----------
export async function config() {
  let c = {};
  try { c = JSON.parse((await getSetting('backup_cfg')) || '{}'); } catch { /* padrão */ }
  return { ...DEFAULTS, ...c, diario: { ...DEFAULTS.diario, ...c.diario }, semanal: { ...DEFAULTS.semanal, ...c.semanal }, mensal: { ...DEFAULTS.mensal, ...c.mensal } };
}
export async function saveConfig(patch) { const c = await config(); await setSetting('backup_cfg', JSON.stringify({ ...c, ...patch })); }
export const connected = (c) => !!(c && c.refresh_enc);

// ---------- Google Drive (OAuth próprio, reaproveitando as credenciais da Google Agenda) ----------
export async function authUrl(req, uid) {
  const g = await G.config();
  if (!g) return null;
  const p = new URLSearchParams({
    client_id: g.clientId, redirect_uri: G.redirectUri(req), response_type: 'code', scope: `openid email ${DRIVE_SCOPE}`,
    access_type: 'offline', prompt: 'select_account consent', state: G.makeState(`drive:${uid}`),
  });
  return `${AUTH}/o/oauth2/v2/auth?${p}`;
}
async function tokenReq(params) {
  const g = await G.config();
  if (!g) throw new Error('Credenciais do Google não configuradas (Configurações → Google Agenda).');
  const res = await fetch(`${OAUTH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, ...params }), signal: AbortSignal.timeout(15000) });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(d.error_description || d.error || `Google respondeu ${res.status}`); e.code = d.error; throw e; }
  return d;
}
export async function connect(req, code) {
  const t = await tokenReq({ code, grant_type: 'authorization_code', redirect_uri: G.redirectUri(req) });
  if (!t.refresh_token) throw new Error('O Google não enviou a autorização permanente. Remova o acesso em myaccount.google.com/permissions e conecte de novo.');
  let email = null;
  if (t.id_token) { try { email = JSON.parse(Buffer.from(t.id_token.split('.')[1], 'base64url').toString()).email; } catch { /* ignore */ } }
  S.tok = { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
  await saveConfig({ refresh_enc: encrypt(t.refresh_token), email, folderId: null, error: null });
  await folder();
  return email;
}
export async function disconnect() {
  const c = await config();
  if (c.refresh_enc) await fetch(`${OAUTH}/revoke?token=${encodeURIComponent(decrypt(c.refresh_enc))}`, { method: 'POST', signal: AbortSignal.timeout(8000) }).catch(() => {});
  S.tok = null;
  await saveConfig({ refresh_enc: null, email: null, folderId: null, error: null });
}
const S = Tenancy.scoped({ tok: null }); // caches com um valor por clínica
async function token() {
  if (S.tok && S.tok.exp > Date.now() + 60e3) return S.tok.token;
  const c = await config();
  if (!c.refresh_enc) throw new Error('Google Drive não conectado.');
  try {
    const t = await tokenReq({ grant_type: 'refresh_token', refresh_token: decrypt(c.refresh_enc) });
    S.tok = { token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 };
    return S.tok.token;
  } catch (e) {
    if (e.code === 'invalid_grant') await saveConfig({ error: 'O acesso ao Google Drive expirou ou foi revogado. Conecte novamente.' });
    throw e;
  }
}
async function drive(method, path, { query, body, raw, headers = {}, timeout = 30000 } = {}) {
  for (let i = 0; i < 2; i++) {
    const res = await fetch(`${API}${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
      method, headers: { Authorization: `Bearer ${await token()}`, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : raw, signal: AbortSignal.timeout(timeout),
    });
    if (res.status === 401 && i === 0) { S.tok = null; continue; }
    if (raw === undefined && method === 'GET' && query?.alt === 'media') { if (!res.ok) throw new Error(`Google Drive respondeu ${res.status}`); return Buffer.from(await res.arrayBuffer()); }
    if (res.status === 204) return null;
    const d = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(d.error?.message || `Google Drive respondeu ${res.status}`); e.status = res.status; throw e; }
    return d;
  }
}
async function folder() {
  const c = await config();
  if (c.folderId) {
    try { const f = await drive('GET', `/drive/v3/files/${c.folderId}`, { query: { fields: 'id,trashed' } }); if (f && !f.trashed) return c.folderId; } catch { /* recria */ }
  }
  const f = await drive('POST', '/drive/v3/files', { body: { name: folderName(), mimeType: 'application/vnd.google-apps.folder' }, query: { fields: 'id' } });
  await saveConfig({ folderId: f.id });
  return f.id;
}
export const folderUrl = (c) => (c.folderId ? `https://drive.google.com/drive/folders/${c.folderId}` : null);
async function upload(name, buf, mime) {
  const parent = await folder();
  const res = await fetch(`${API}/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,webViewLink`, {
    method: 'POST', headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': String(buf.length) },
    body: JSON.stringify({ name, parents: [parent], description: 'Backup automático do sistema do consultório' }), signal: AbortSignal.timeout(20000),
  });
  const loc = res.headers.get('location');
  if (!res.ok || !loc) throw new Error(`Google Drive recusou o envio (${res.status}). Verifique se a API do Google Drive está ativada no projeto do Google Cloud.`);
  const put = await fetch(loc, { method: 'PUT', headers: { 'Content-Type': mime, 'Content-Length': String(buf.length) }, body: buf, signal: AbortSignal.timeout(10 * 60e3) });
  const d = await put.json().catch(() => ({}));
  if (!put.ok) throw new Error(d.error?.message || `Falha no envio ao Google Drive (${put.status}).`);
  return { id: d.id, name: d.name || name, size: buf.length, link: d.webViewLink || `https://drive.google.com/file/d/${d.id}/view` };
}
export const downloadFile = (id) => drive('GET', `/drive/v3/files/${encodeURIComponent(id)}`, { query: { alt: 'media' }, timeout: 10 * 60e3 });
const deleteFile = (id) => drive('DELETE', `/drive/v3/files/${encodeURIComponent(id)}`).catch((e) => { if (e.status !== 404) throw e; });

// ---------- geração ----------
const line = (s) => `${s.replace(/\r?\n/g, ' ')};\n`;
async function dumpTables(tables) {
  const out = [`-- Backup do ${Brand.get().appName} · ${nowLocal()}`, '-- Restaure pelo próprio sistema (Configurações → Backup) ou pelo phpMyAdmin.', '-- Campos sensíveis (prontuário, CPF, mensagens) seguem criptografados: só o sistema original consegue lê-los.', 'SET NAMES utf8mb4;', 'SET FOREIGN_KEY_CHECKS=0;'].map((x) => (x.startsWith('--') ? `${x}\n` : `${x}\n`));
  let rows = 0;
  for (const t of tables) {
    const id = mysql.escapeId(t);
    const cr = await one(`SHOW CREATE TABLE ${id}`);
    out.push(line(`DROP TABLE IF EXISTS ${id}`), line(cr['Create Table']));
    const data = await q(`SELECT * FROM ${id}`);
    rows += data.length;
    for (let i = 0; i < data.length; i += 100) {
      const chunk = data.slice(i, i + 100); const cols = Object.keys(chunk[0]);
      out.push(line(`INSERT INTO ${id} (${cols.map((c) => mysql.escapeId(c)).join(',')}) VALUES ${chunk.map((r) => `(${cols.map((c) => mysql.escape(r[c])).join(',')})`).join(',')}`));
    }
  }
  out.push('SET FOREIGN_KEY_CHECKS=1;\n');
  return { sql: Buffer.from(out.join('')), rows };
}
async function allTables() { return (await q('SHOW TABLES')).map((r) => Object.values(r)[0]).filter((t) => !SKIP.has(t)); }
const safeName = (s) => String(s).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120);
async function attachmentsFolder(zip) {
  const files = await q('SELECT id, entry_id, payment_id, name, data FROM fin_files ORDER BY id');
  for (const f of files) zip.addFile(`arquivos/${f.entry_id ? `conta-${f.entry_id}` : `recebimento-${f.payment_id}`}/${f.id}-${safeName(f.name)}`, f.data);
  return files.length;
}
const README = (parts, when) => `Backup — ${Brand.get().appName}
Gerado em: ${when}
Partes: ${parts.map((p) => PARTS[p].label).join(', ')}

• banco.sql — banco de dados completo (formato SQL). Restaure em Configurações → Backup → Restaurar,
  ou importe pelo phpMyAdmin. Prontuários, CPFs e mensagens ficam criptografados com a chave do sistema
  (variável ENCRYPTION_KEY da hospedagem): guarde essa chave em local seguro.
• anexos.sql — anexos do financeiro (para restaurar junto com o banco).
• arquivos/ — os mesmos anexos como arquivos comuns, para abrir direto.
`;

// Gera os arquivos do backup: [{ name, buf, mime }]
export async function build({ parts, mode }) {
  const ts = nowLocal().slice(0, 16).replace(' ', '_').replace(':', 'h');
  const when = nowLocal().slice(0, 16);
  const outs = []; let rows = 0;
  const sqlBanco = parts.includes('banco') ? await dumpTables(await allTables()) : null;
  const sqlAnexos = parts.includes('anexos') ? await dumpTables(['fin_files', 'tv_media', 'tv_media_chunks']) : null;
  rows += (sqlBanco?.rows || 0) + (sqlAnexos?.rows || 0);
  if (mode === 'juntos') {
    const zip = new AdmZip();
    zip.addFile('LEIA-ME.txt', Buffer.from(README(parts, when)));
    if (sqlBanco) zip.addFile('banco.sql', sqlBanco.sql);
    if (sqlAnexos) { zip.addFile('anexos.sql', sqlAnexos.sql); await attachmentsFolder(zip); }
    outs.push({ name: `backup-completo-${ts}.zip`, buf: zip.toBuffer(), mime: 'application/zip' });
  } else {
    if (sqlBanco) outs.push({ name: `banco-${ts}.sql.gz`, buf: zlib.gzipSync(sqlBanco.sql, { level: 9 }), mime: 'application/gzip' });
    if (sqlAnexos) { const zip = new AdmZip(); zip.addFile('LEIA-ME.txt', Buffer.from(README(['anexos'], when))); zip.addFile('anexos.sql', sqlAnexos.sql); await attachmentsFolder(zip); outs.push({ name: `anexos-${ts}.zip`, buf: zip.toBuffer(), mime: 'application/zip' }); }
  }
  return { files: outs, rows };
}

// Executa um backup e registra no histórico. dest: 'drive' | 'download'
export async function run({ kind = 'manual', parts, mode, dest = 'drive', userId = null }) {
  const c = await config();
  parts = (parts || c.parts).filter((p) => PARTS[p]);
  mode = mode === 'separados' ? 'separados' : 'juntos';
  if (!parts.length) return { ok: false, error: 'Escolha pelo menos uma parte.' };
  if (dest === 'drive' && !connected(c)) return { ok: false, error: 'Conecte o Google Drive primeiro.' };
  const r = await q('INSERT INTO backup_runs (kind, mode, parts, dest, created_by) VALUES (?,?,?,?,?)', [kind, mode, parts.join(','), dest, userId]);
  const id = r.insertId; Live.emit('config');
  try {
    const b = await build({ parts, mode });
    const size = b.files.reduce((s, f) => s + f.buf.length, 0);
    let files = b.files.map((f) => ({ name: f.name, size: f.buf.length }));
    if (dest === 'drive') { files = []; for (const f of b.files) files.push(await upload(f.name, f.buf, f.mime)); }
    await q("UPDATE backup_runs SET status = 'ok', files = ?, size = ?, finished_at = NOW() WHERE id = ?", [JSON.stringify(files), size, id]);
    if (dest === 'drive') { await saveConfig({ error: null }); await prune(kind); }
    Live.emit('config');
    return { ok: true, id, files, size, build: dest === 'download' ? b : null };
  } catch (e) {
    await q("UPDATE backup_runs SET status = 'erro', error = ?, finished_at = NOW() WHERE id = ?", [String(e.message).slice(0, 500), id]);
    Live.emit('config');
    return { ok: false, id, error: e.message };
  }
}

// Mantém só as N cópias mais recentes de cada tipo automático (apaga as antigas do Drive também).
async function prune(kind) {
  const c = await config();
  const keep = c[kind]?.keep;
  if (!keep) return;
  const old = await q("SELECT id, files FROM backup_runs WHERE kind = ? AND status = 'ok' AND dest = 'drive' ORDER BY id DESC LIMIT 1000 OFFSET ?", [kind, Number(keep)]);
  for (const r of old) {
    for (const f of JSON.parse(r.files || '[]')) if (f.id) await deleteFile(f.id).catch(() => {});
    await q('DELETE FROM backup_runs WHERE id = ?', [r.id]);
  }
}
export async function remove(id) {
  const r = await one('SELECT * FROM backup_runs WHERE id = ?', [id]);
  if (!r) return;
  for (const f of JSON.parse(r.files || '[]')) if (f.id) await deleteFile(f.id).catch(() => {});
  await q('DELETE FROM backup_runs WHERE id = ?', [id]);
}
export const history = () => q('SELECT b.*, u.name who FROM backup_runs b LEFT JOIN users u ON u.id = b.created_by ORDER BY b.id DESC LIMIT 60');

// ---------- agendamento ----------
// Período atual de cada tipo; o backup roda uma vez por período, a partir da hora escolhida.
function due(kind, c, last) {
  const now = nowLocal(); const today = todayLocal(); const hour = Number(now.slice(11, 13));
  if (hour < Number(c.hour)) return false;
  const lastDay = last ? String(last).slice(0, 10) : '';
  if (kind === 'diario') return lastDay < today;
  if (kind === 'semanal') {
    const ws = startOfWeek(today); // segunda-feira
    const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
    const target = (Number(c.semanal.dow) + 6) % 7; // 0=segunda … 6=domingo
    return (dow + 6) % 7 >= target && lastDay < ws;
  }
  if (kind === 'mensal') return Number(today.slice(8)) >= Number(c.mensal.day) && lastDay < `${today.slice(0, 7)}-01`;
  return false;
}
const TICKING = Tenancy.scoped({ on: false }); // trava por clínica
export async function tick() {
  if (TICKING.on) return; TICKING.on = true;
  let conn;
  try {
    const c = await config();
    if (!connected(c) || c.error) return;
    conn = await db().getConnection();
    const [[lk]] = await conn.query("SELECT GET_LOCK('lm_backup', 0) ok");
    if (!lk.ok) return; // outro processo já está fazendo
    for (const kind of ['mensal', 'semanal', 'diario']) {
      if (!c[kind].on) continue;
      const last = await one("SELECT started_at FROM backup_runs WHERE kind = ? AND status = 'ok' ORDER BY id DESC LIMIT 1", [kind]);
      const recentFail = await one("SELECT id FROM backup_runs WHERE kind = ? AND status = 'erro' AND started_at > DATE_SUB(NOW(), INTERVAL 2 HOUR) LIMIT 1", [kind]);
      if (recentFail || !due(kind, c, last?.started_at)) continue;
      await run({ kind });
      break; // um por vez
    }
  } catch { /* tenta de novo no próximo ciclo */ } finally {
    if (conn) { await conn.query("SELECT RELEASE_LOCK('lm_backup')").catch(() => {}); conn.release(); }
    TICKING.on = false;
  }
}

// ---------- restauração ----------
// Aceita .zip (juntos ou anexos), .sql.gz ou .sql. Restaura as partes presentes.
export function readArchive(buf, name = '') {
  const parts = {};
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const zip = new AdmZip(buf);
    for (const e of zip.getEntries()) { if (e.entryName === 'banco.sql') parts.banco = e.getData(); if (e.entryName === 'anexos.sql') parts.anexos = e.getData(); }
  } else if (buf[0] === 0x1f && buf[1] === 0x8b) parts[/anexo/i.test(name) ? 'anexos' : 'banco'] = zlib.gunzipSync(buf);
  else if (/^--|^SET |^DROP /.test(buf.slice(0, 20).toString())) parts[/anexo/i.test(name) ? 'anexos' : 'banco'] = buf;
  return parts;
}
export async function restore(parts, userId) {
  if (!parts.banco && !parts.anexos) return { ok: false, error: 'Arquivo sem dados de backup reconhecíveis.' };
  const keepCfg = await getSetting('backup_cfg'); // não perde a conexão com o Drive
  const c = await config();
  let before = null;
  if (connected(c)) { before = await run({ kind: 'restauracao', parts: ['banco', 'anexos'], mode: 'juntos', userId }); if (!before.ok) return { ok: false, error: `Não restaurei: a cópia de segurança antes da restauração falhou (${before.error}).` }; }
  const conn = await db().getConnection();
  let n = 0;
  try {
    for (const k of ['banco', 'anexos']) {
      if (!parts[k]) continue;
      for (const stmt of parts[k].toString('utf8').split(';\n')) {
        const s = stmt.trim();
        if (!s || s.startsWith('--')) continue;
        if (/^(DROP TABLE IF EXISTS `(backup_runs|maint_backups)`|CREATE TABLE `(backup_runs|maint_backups)`)/.test(s)) continue;
        await conn.query(s); n++;
      }
    }
  } finally { await conn.query('SET FOREIGN_KEY_CHECKS=1').catch(() => {}); conn.release(); }
  await setSetting('backup_cfg', keepCfg);
  Live.emit(['agenda', 'pacientes', 'financeiro', 'crm', 'usuarios', 'config']);
  return { ok: true, statements: n, beforeId: before?.id || null };
}
export const _due = due; // testes
export const newState = () => crypto.randomBytes(4).toString('hex');
