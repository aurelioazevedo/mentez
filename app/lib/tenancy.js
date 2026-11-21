// Mentez — várias clínicas no mesmo servidor, cada uma com o seu banco de dados e as suas chaves.
//
// Como funciona:
// - Um banco “de plataforma” (MENTEZ_PLATFORM_DB) guarda as clínicas (tenants) e os domínios de cada uma.
// - Cada requisição é atendida dentro do contexto da clínica do endereço acessado (subdomínio ou domínio próprio).
//   O contexto vale para todo o código assíncrono daquela requisição (AsyncLocalStorage), então lib/db.js
//   escolhe sozinho o banco certo e o restante do sistema não precisa saber que existem várias clínicas.
// - Cada clínica tem as próprias chaves (criptografia dos dados de saúde e assinatura das sessões), guardadas
//   no banco da plataforma cifradas com a chave mestra (MENTEZ_MASTER_KEY). Um login de uma clínica não abre outra.
// - Tarefas automáticas (lembretes, backups, cobranças) rodam uma vez para cada clínica ativa (forEachTenant).
//
// Sem MENTEZ_PLATFORM_DB o sistema funciona como antes, com uma clínica só (variáveis DB_* do ambiente).
import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import path from 'node:path';
import mysql from 'mysql2/promise';

const als = new AsyncLocalStorage();
export const multi = () => !!process.env.MENTEZ_PLATFORM_DB;
export const baseDomain = () => String(process.env.MENTEZ_BASE_DOMAIN || 'mentez.com.br').toLowerCase();
// Endereços da própria Mentez (site e painel), que não são de nenhuma clínica
export const platformHosts = () => new Set(String(process.env.MENTEZ_PLATFORM_HOSTS || `${baseDomain()},www.${baseDomain()},app.${baseDomain()}`).toLowerCase().split(/[\s,]+/).filter(Boolean));
// Subdomínios que nenhuma clínica pode usar
export const RESERVED = new Set(['www', 'app', 'api', 'admin', 'painel', 'mail', 'email', 'smtp', 'ftp', 'vps', 'status', 'ajuda', 'suporte', 'blog', 'static', 'cdn', 'teste', 'demo', 'mentez', 'evolution', 'whatsapp']);
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

// ---------- contexto da requisição ----------
export const current = () => als.getStore()?.tenant || null;
// Arquivos fora do banco (ex.: PDFs dos cadernos de exercícios): na Mentez, uma pasta por clínica em MENTEZ_FILES_DIR
export const filesDir = (fallback, sub = 'private') => (multi() && current() ? path.join(process.env.MENTEZ_FILES_DIR || '/data/files', current().slug, sub) : fallback);
export const run = (tenant, fn) => als.run({ tenant }, fn);
// Configuração da clínica atual (sobrepõe a do ambiente): PUBLIC_URL, SESSION_SECRET, ENCRYPTION_KEY…
export function env(name) {
  const t = current();
  if (t && t.env && t.env[name] !== undefined && t.env[name] !== null && t.env[name] !== '') return t.env[name];
  return process.env[name];
}
// Chave para caches em memória: dados de uma clínica nunca aparecem para outra
export const key = (k = '') => `${current()?.slug || '_'}|${k}`;

// ---------- chave mestra (cifra as chaves de cada clínica no banco da plataforma) ----------
function master() {
  const raw = process.env.MENTEZ_MASTER_KEY;
  if (!raw || raw.length < 32) throw new Error('MENTEZ_MASTER_KEY ausente ou curta demais.');
  return crypto.createHash('sha256').update(`mentez-master|${raw}`).digest();
}
export function seal(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', master(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}
export function unseal(s) {
  if (!s) return {};
  const [, iv, tag, enc] = String(s).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', master(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(enc, 'base64url')), d.final()]).toString('utf8'));
}
export const randomSecret = () => crypto.randomBytes(48).toString('base64url');

// ---------- banco da plataforma ----------
let ppool = null;
function connConfig(database) {
  if (process.env.MENTEZ_DB_URL) { const u = new URL(process.env.MENTEZ_DB_URL); return { host: u.hostname, port: Number(u.port || 3306), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password), database }; }
  return { host: process.env.MENTEZ_DB_HOST || process.env.DB_HOST, port: Number(process.env.MENTEZ_DB_PORT || process.env.DB_PORT || 3306), user: process.env.MENTEZ_DB_USER || process.env.DB_USER, password: process.env.MENTEZ_DB_PASSWORD || process.env.DB_PASSWORD, database };
}
export const connConfigFor = (database) => connConfig(database);
function makePool(database, limit) {
  const p = mysql.createPool({ ...connConfig(database), waitForConnections: true, connectionLimit: limit, maxIdle: 2, idleTimeout: 60000, charset: 'utf8mb4', timezone: 'Z', dateStrings: true });
  // mesmo modo SQL do MariaDB em que o sistema foi escrito (o MySQL 8 liga ONLY_FULL_GROUP_BY por padrão)
  p.pool.on('connection', (conn) => { conn.query("SET time_zone = '-03:00'"); conn.query("SET SESSION sql_mode = 'STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION'"); });
  return p;
}
export function platform() { if (!ppool) ppool = makePool(process.env.MENTEZ_PLATFORM_DB, 4); return ppool; }
export async function pq(sql, params = []) { const [rows] = await platform().query(sql, params); return rows; }
export async function pone(sql, params = []) { return (await pq(sql, params))[0] || null; }

const PLATFORM_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS tenants (
    id INT AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(40) NOT NULL UNIQUE,
    name VARCHAR(160) NOT NULL,
    db_name VARCHAR(64) NOT NULL UNIQUE,
    status ENUM('ativa','suspensa','cancelada') NOT NULL DEFAULT 'ativa',
    plan VARCHAR(30) NOT NULL DEFAULT 'piloto',
    owner_name VARCHAR(160) NULL,
    owner_email VARCHAR(190) NULL,
    secrets_enc TEXT NOT NULL,
    notes VARCHAR(1000) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  // Domínios próprios das clínicas (app.clinica.com.br). O subdomínio slug.mentez.com.br não precisa de registro aqui.
  `CREATE TABLE IF NOT EXISTS tenant_domains (
    domain VARCHAR(190) NOT NULL PRIMARY KEY,
    tenant_id INT NOT NULL,
    is_primary TINYINT(1) NOT NULL DEFAULT 0,
    verified_at DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (tenant_id),
    FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS platform_audit (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    actor VARCHAR(120) NULL,
    action VARCHAR(60) NOT NULL,
    tenant_id INT NULL,
    detail VARCHAR(500) NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX (tenant_id), INDEX (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
];
export async function migratePlatform() {
  const cfg = connConfig(undefined);
  const c = await mysql.createConnection(cfg);
  try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${process.env.MENTEZ_PLATFORM_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } finally { await c.end(); }
  for (const s of PLATFORM_SCHEMA) await pq(s);
}

// ---------- clínicas ----------
const pools = new Map(); // db_name → pool
export function poolFor(t) {
  if (!pools.has(t.db_name)) pools.set(t.db_name, makePool(t.db_name, Number(process.env.MENTEZ_TENANT_POOL || 4)));
  return pools.get(t.db_name);
}
// Pool do banco da clínica atual (lib/db.js usa isto)
export function currentPool() { const t = current(); return t ? poolFor(t) : null; }

function shape(row) {
  if (!row) return null;
  const secrets = unseal(row.secrets_enc);
  const primary = row.primary_domain || null;
  const url = `https://${primary || `${row.slug}.${baseDomain()}`}`;
  return { id: row.id, slug: row.slug, name: row.name, db_name: row.db_name, status: row.status, plan: row.plan, primaryDomain: primary,
    billingStatus: row.billing_status || 'cortesia', trialEndsAt: row.trial_ends_at || null, paidUntil: row.paid_until || null, overdueSince: row.overdue_since || null, extraPros: Number(row.extra_pros || 0),
    ownerEmail: row.owner_email || null, ownerName: row.owner_name || null, createdAt: row.created_at || null,
    env: { PUBLIC_URL: url, ...(secrets.env || {}), SESSION_SECRET: secrets.SESSION_SECRET, ENCRYPTION_KEY: secrets.ENCRYPTION_KEY } };
}
const cache = new Map(); // host → { t, at }
const TTL = 30e3;
const SELECT = `SELECT t.*, (SELECT d.domain FROM tenant_domains d WHERE d.tenant_id = t.id AND d.is_primary = 1 AND d.verified_at IS NOT NULL LIMIT 1) primary_domain FROM tenants t`;
export function slugOfHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const b = `.${baseDomain()}`;
  if (!h.endsWith(b)) return null;
  const s = h.slice(0, -b.length);
  return SLUG_RE.test(s) && !RESERVED.has(s) ? s : null;
}
export async function byHost(host) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  const hit = cache.get(h);
  if (hit && Date.now() - hit.at < (hit.t ? TTL : 5e3)) return hit.t; // “não existe” vale só 5 s (domínio recém-cadastrado)
  let row = null;
  const slug = slugOfHost(h);
  if (slug) row = await pone(`${SELECT} WHERE t.slug = ?`, [slug]);
  else row = await pone(`${SELECT} JOIN tenant_domains x ON x.tenant_id = t.id WHERE x.domain = ? AND x.verified_at IS NOT NULL`, [h]); // domínio próprio só depois de o DNS apontar para a Mentez
  const t = shape(row);
  cache.set(h, { t, at: Date.now() });
  return t;
}
export const bySlug = async (slug) => shape(await pone(`${SELECT} WHERE t.slug = ?`, [slug]));
export const active = async () => (await pq(`${SELECT} WHERE t.status = 'ativa' ORDER BY t.id`)).map(shape);
export const all = async () => (await pq(`${SELECT} ORDER BY t.id`)).map(shape);
export const clearCache = () => cache.clear();

// Roda fn uma vez para cada clínica ativa (tarefas automáticas). Um erro numa clínica não para as outras.
export async function forEachTenant(fn, label = 'tarefa') {
  if (!multi()) return fn();
  for (const t of await active().catch((e) => { console.error(`${label}: lista de clínicas`, e.message); return []; })) {
    try { await run(t, fn); } catch (e) { console.error(`${label} [${t.slug}]:`, e.message); }
  }
}

// Certificado HTTPS sob demanda (Caddy pergunta antes de emitir): só endereços de clínicas ativas ou da plataforma
export async function allowCertificate(domain) {
  const d = String(domain || '').toLowerCase();
  if (platformHosts().has(d)) return true;
  const t = await byHost(d).catch(() => null);
  if (!t || t.status === 'cancelada') return false;
  if (slugOfHost(d)) return true;
  return !!(await pone('SELECT 1 x FROM tenant_domains WHERE domain = ? AND tenant_id = ? AND verified_at IS NOT NULL', [d, t.id]));
}

// ---------- criar uma clínica ----------
// secrets: opcional, para trazer uma clínica que já existe (ex.: Dra. Lorrainy) com as chaves que ela já usa.
export async function createTenant({ slug, name, ownerName = null, ownerEmail = null, plan = 'piloto', secrets = null, dbName = null, actor = 'cli' }) {
  slug = String(slug || '').toLowerCase().trim();
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) throw new Error('Endereço inválido: use de 3 a 40 letras minúsculas, números ou hífen (e não um nome reservado).');
  if (await pone('SELECT id FROM tenants WHERE slug = ?', [slug])) throw new Error('Já existe uma clínica com este endereço.');
  const db = dbName || `mz_${slug.replace(/-/g, '_')}`;
  if (!/^[a-z0-9_]{3,64}$/.test(db)) throw new Error('Nome de banco inválido.');
  const c = await mysql.createConnection(connConfig(undefined));
  try { await c.query(`CREATE DATABASE IF NOT EXISTS \`${db}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } finally { await c.end(); }
  const sec = { SESSION_SECRET: secrets?.SESSION_SECRET || randomSecret(), ENCRYPTION_KEY: secrets?.ENCRYPTION_KEY || randomSecret(), env: secrets?.env || {} };
  const r = await pq('INSERT INTO tenants (slug, name, db_name, plan, owner_name, owner_email, secrets_enc) VALUES (?,?,?,?,?,?,?)', [slug, name, db, plan, ownerName, ownerEmail, seal(sec)]);
  await pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', [actor, 'clinica-criar', r.insertId, slug]);
  clearCache();
  return bySlug(slug);
}
// Altera uma configuração guardada (cifrada) da clínica, ex.: SETUP_TOKEN do convite de primeiro acesso
export async function setSecretEnv(tenantId, name, value) {
  const row = await pone('SELECT secrets_enc FROM tenants WHERE id = ?', [tenantId]);
  if (!row) throw new Error('Clínica não encontrada.');
  const sec = unseal(row.secrets_enc); sec.env = sec.env || {};
  if (value === null || value === undefined || value === '') delete sec.env[name]; else sec.env[name] = value;
  await pq('UPDATE tenants SET secrets_enc = ? WHERE id = ?', [seal(sec), tenantId]);
  clearCache();
}
// Troca as chaves da clínica (ex.: ao trazer uma clínica de outro servidor, para as sessões e os dados cifrados continuarem valendo)
export async function setCoreSecrets(tenantId, { SESSION_SECRET, ENCRYPTION_KEY, env = {} }) {
  const row = await pone('SELECT secrets_enc FROM tenants WHERE id = ?', [tenantId]);
  if (!row) throw new Error('Clínica não encontrada.');
  const sec = unseal(row.secrets_enc);
  if (SESSION_SECRET) sec.SESSION_SECRET = SESSION_SECRET;
  if (ENCRYPTION_KEY) sec.ENCRYPTION_KEY = ENCRYPTION_KEY;
  sec.env = { ...(sec.env || {}), ...env };
  await pq('UPDATE tenants SET secrets_enc = ? WHERE id = ?', [seal(sec), tenantId]);
  clearCache();
}
export async function addDomain(tenantId, domain, { primary = false, verified = false } = {}) {
  const d = String(domain || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!/^(?=.{4,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(d)) throw new Error('Domínio inválido.');
  if (d.endsWith(`.${baseDomain()}`) || d === baseDomain()) throw new Error(`Subdomínios de ${baseDomain()} já funcionam sem cadastro.`);
  if (primary) await pq('UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?', [tenantId]);
  await pq('INSERT INTO tenant_domains (domain, tenant_id, is_primary, verified_at) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE is_primary = VALUES(is_primary), verified_at = COALESCE(VALUES(verified_at), verified_at)',
    [d, tenantId, primary ? 1 : 0, verified ? new Date() : null]);
  clearCache();
  return d;
}

// ---------- caches em memória separados por clínica ----------
// Mapa cujas chaves ficam separadas por clínica (ids de usuário, conversa e mídia se repetem entre clínicas).
export class TMap extends Map {
  get(k) { return super.get(key(k)); }
  set(k, v) { return super.set(key(k), v); }
  has(k) { return super.has(key(k)); }
  delete(k) { return super.delete(key(k)); }
  deleteRaw(k) { return super.delete(k); }
}
// Variáveis de cache com um valor por clínica: S.cache = …; S.cache?.at
export function scoped(defaults = {}) {
  const store = new Map();
  const bucket = () => { const k = current()?.slug || '_'; if (!store.has(k)) store.set(k, { ...defaults }); return store.get(k); };
  return new Proxy({}, { get: (_, p) => bucket()[p], set: (_, p, v) => { bucket()[p] = v; return true; } });
}
