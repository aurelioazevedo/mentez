// Bem-Estar Mental (bemestarmental.com.br): diretório de psicólogas e psicólogos.
// Perfil grátis para qualquer profissional (com CRP conferido pela equipe) e perfil ligado à Mentez (agenda on-line).
// Destaques Bronze, Prata e Ouro: pagos à parte ou incluídos nos planos da Mentez (recursos bem_bronze e bem_prata).
// Ordem justa: relevância (perfil completo, agenda, verificação) com peso do destaque; Ouro aparece no topo em
// rodízio, sempre marcado como “Patrocinado”, em no máximo 3 vagas por página.
import crypto from 'node:crypto';
import sharp from 'sharp';
import * as T from './tenancy.js';
import * as Billing from './billing.js';

export const hosts = () => new Set(String(process.env.MENTEZ_BEM_HOSTS ?? (process.env.MENTEZ_SITES_DOMAIN ?? 'bemestarmental.com.br')).toLowerCase().split(/[\s,]+/).filter(Boolean));
export const isHost = (h) => hosts().has(String(h || '').toLowerCase().replace(/:\d+$/, ''));
export const BRAND = 'Bem-Estar Mental';

export const TEMAS = {
  ansiedade: 'Ansiedade', depressao: 'Depressão', panico: 'Síndrome do pânico', estresse: 'Estresse e burnout', relacionamentos: 'Relacionamentos', autoestima: 'Autoestima',
  luto: 'Luto e perdas', traumas: 'Traumas', tdah: 'TDAH', autismo: 'Autismo (TEA)', toc: 'TOC', bipolaridade: 'Transtorno bipolar', fobias: 'Fobias',
  alimentar: 'Transtornos alimentares', dependencia: 'Dependência química', sono: 'Insônia e sono', sexualidade: 'Sexualidade', lgbtqia: 'Questões LGBTQIA+',
  maternidade: 'Maternidade e parentalidade', carreira: 'Carreira e orientação profissional', familia: 'Conflitos familiares', casal: 'Terapia de casal', idosos: 'Envelhecimento',
};
export const ABORDAGENS = {
  tcc: 'Terapia cognitivo-comportamental (TCC)', psicanalise: 'Psicanálise', humanista: 'Humanista', gestalt: 'Gestalt-terapia', junguiana: 'Analítica (junguiana)',
  comportamental: 'Análise do comportamento', sistemica: 'Sistêmica', act: 'Terapia de aceitação e compromisso (ACT)', dbt: 'Terapia comportamental dialética (DBT)',
  esquema: 'Terapia do esquema', emdr: 'EMDR', hipnoterapia: 'Hipnoterapia', existencial: 'Existencial', psicodrama: 'Psicodrama', neuropsicologia: 'Neuropsicologia',
};
export const PUBLICOS = { criancas: 'Crianças', adolescentes: 'Adolescentes', adultos: 'Adultos', idosos: 'Idosos', casais: 'Casais', familias: 'Famílias' };
export const UFS = ['AC', 'AL', 'AM', 'AP', 'BA', 'CE', 'DF', 'ES', 'GO', 'MA', 'MG', 'MS', 'MT', 'PA', 'PB', 'PE', 'PI', 'PR', 'RJ', 'RN', 'RO', 'RR', 'RS', 'SC', 'SE', 'SP', 'TO'];
export const TIERS = {
  gratis: { name: 'Grátis', price: 0, boost: 0, cities: 1, temas: 0 },
  bronze: { name: 'Bronze', price: 29, boost: 8, cities: 1, temas: 0 },
  prata: { name: 'Prata', price: 59, boost: 16, cities: 1, temas: 3 },
  ouro: { name: 'Ouro', price: 99, boost: 24, cities: 3, temas: 10 },
};
const RANK = { gratis: 0, bronze: 1, prata: 2, ouro: 3 };

export const slugify = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
export const citySlug = (city, uf) => (city && uf ? `${slugify(city)}-${String(uf).toLowerCase()}` : '');
const csv = (v, dict) => [...new Set((Array.isArray(v) ? v : String(v || '').split(',')).map((x) => String(x).trim()).filter((x) => dict[x]))].join(',');
export const list = (v) => String(v || '').split(',').filter(Boolean);

export async function migrate() {
  await T.pq(`CREATE TABLE IF NOT EXISTS dir_profiles (
    id INT AUTO_INCREMENT PRIMARY KEY, slug VARCHAR(90) NOT NULL, kind VARCHAR(8) NOT NULL DEFAULT 'gratis',
    tenant_id INT NULL, user_id INT NULL, name VARCHAR(120) NOT NULL, title VARCHAR(40) NULL,
    crp VARCHAR(20) NULL, crp_uf CHAR(2) NULL, crp_ok DATETIME NULL, epsi TINYINT(1) NOT NULL DEFAULT 0,
    email VARCHAR(160) NULL, phone VARCHAR(30) NULL, whatsapp VARCHAR(30) NULL,
    city VARCHAR(80) NULL, uf CHAR(2) NULL, city_slug VARCHAR(100) NULL, district VARCHAR(80) NULL,
    online TINYINT(1) NOT NULL DEFAULT 1, presencial TINYINT(1) NOT NULL DEFAULT 0,
    temas VARCHAR(600) NULL, abordagens VARCHAR(400) NULL, publicos VARCHAR(200) NULL,
    price_min INT NULL, price_max INT NULL, convenios VARCHAR(300) NULL, bio TEXT NULL, video VARCHAR(300) NULL,
    photo_v INT NOT NULL DEFAULT 0, site_url VARCHAR(300) NULL, booking_url VARCHAR(300) NULL,
    tier VARCHAR(8) NOT NULL DEFAULT 'gratis', tier_until DATE NULL, extra_cities VARCHAR(300) NULL, extra_temas VARCHAR(600) NULL,
    status VARCHAR(10) NOT NULL DEFAULT 'pendente', last_login DATETIME NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY (slug), UNIQUE KEY tu (tenant_id, user_id), INDEX (status, city_slug), INDEX (email)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await T.pq('CREATE TABLE IF NOT EXISTS dir_photos (profile_id INT PRIMARY KEY, data MEDIUMBLOB NOT NULL) ENGINE=InnoDB');
  await T.pq('CREATE TABLE IF NOT EXISTS dir_tokens (token_hash CHAR(64) PRIMARY KEY, profile_id INT NOT NULL, expires_at DATETIME NOT NULL, INDEX (profile_id)) ENGINE=InnoDB');
  await T.pq(`CREATE TABLE IF NOT EXISTS dir_stats (day DATE NOT NULL, profile_id INT NOT NULL, kind VARCHAR(8) NOT NULL, n INT NOT NULL DEFAULT 0, PRIMARY KEY (day, profile_id, kind)) ENGINE=InnoDB`);
  await T.pq(`CREATE TABLE IF NOT EXISTS dir_requests (id INT AUTO_INCREMENT PRIMARY KEY, profile_id INT NOT NULL, tier VARCHAR(8) NOT NULL, status VARCHAR(10) NOT NULL DEFAULT 'novo',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (status)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// ---------- perfis ----------
export const byId = (id) => T.pone('SELECT * FROM dir_profiles WHERE id = ?', [id]);
export const bySlug = (slug) => T.pone('SELECT * FROM dir_profiles WHERE slug = ?', [slug]);
export const byUser = (tenantId, userId) => T.pone('SELECT * FROM dir_profiles WHERE tenant_id = ? AND user_id = ?', [tenantId, userId]);
export const byEmail = (email) => T.pone("SELECT * FROM dir_profiles WHERE email = ? AND kind = 'gratis' ORDER BY id LIMIT 1", [String(email || '').toLowerCase().trim()]);
async function freeSlug(base, id = 0) {
  const s0 = slugify(base).slice(0, 80) || 'psicologo';
  let s = s0; for (let i = 2; await T.pone('SELECT id FROM dir_profiles WHERE slug = ? AND id <> ?', [s, id]); i++) s = `${s0}-${i}`;
  return s;
}
const str = (v, n) => String(v ?? '').trim().slice(0, n);
const int = (v) => { const n = parseInt(String(v || '').replace(/\D/g, ''), 10); return Number.isFinite(n) && n > 0 && n < 100000 ? n : null; };
export function clean(b) {
  const city = str(b.city, 80); const uf = UFS.includes(String(b.uf || '').toUpperCase()) ? String(b.uf).toUpperCase() : null;
  const pmin = int(b.price_min); let pmax = int(b.price_max); if (pmin && pmax && pmax < pmin) pmax = pmin;
  return {
    name: str(b.name, 120), title: ['Psicóloga', 'Psicólogo', 'Psicólogue'].includes(b.title) ? b.title : 'Psicóloga',
    crp: str(b.crp, 20).replace(/[^\d/-]/g, ''), crp_uf: UFS.includes(String(b.crp_uf || '').toUpperCase()) ? String(b.crp_uf).toUpperCase() : uf,
    epsi: b.epsi ? 1 : 0, whatsapp: str(b.whatsapp, 30).replace(/[^\d+()\s-]/g, ''), city, uf, city_slug: citySlug(city, uf), district: str(b.district, 80),
    online: b.online ? 1 : 0, presencial: b.presencial ? 1 : 0,
    temas: csv(b.temas, TEMAS), abordagens: csv(b.abordagens, ABORDAGENS), publicos: csv(b.publicos, PUBLICOS),
    price_min: pmin, price_max: pmax, convenios: str(b.convenios, 300), bio: str(b.bio, 3000).replace(/\r/g, ''),
    video: /^https:\/\/(www\.)?(youtube\.com|youtu\.be|vimeo\.com)\//.test(String(b.video || '')) ? str(b.video, 300) : null,
  };
}
const COLS = ['name', 'title', 'crp', 'crp_uf', 'epsi', 'whatsapp', 'city', 'uf', 'city_slug', 'district', 'online', 'presencial', 'temas', 'abordagens', 'publicos', 'price_min', 'price_max', 'convenios', 'bio', 'video'];
export async function update(id, b, extra = {}) {
  const c = { ...clean(b), ...extra };
  if (!c.name) throw new Error('Informe o nome.');
  const sets = Object.keys(c).filter((k) => COLS.includes(k) || ['site_url', 'booking_url', 'email', 'phone', 'status'].includes(k));
  await T.pq(`UPDATE dir_profiles SET ${sets.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...sets.map((k) => c[k]), id]);
  return byId(id);
}
// Perfil grátis (fica “pendente” até a equipe conferir o CRP)
export async function createFree({ name, email, phone, crp, crp_uf, city, uf }) {
  const em = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) throw new Error('Informe um e-mail válido.');
  if (!String(crp || '').replace(/\D/g, '')) throw new Error('Informe o número do CRP.');
  if (await byEmail(em)) throw new Error('Já existe um perfil com este e-mail. Use “Entrar” para receber o link de acesso.');
  const c = clean({ name, crp, crp_uf, city, uf, online: 1 });
  if (!c.name) throw new Error('Informe seu nome.');
  const r = await T.pq("INSERT INTO dir_profiles (slug, kind, name, title, crp, crp_uf, email, phone, whatsapp, city, uf, city_slug, online, status) VALUES (?, 'gratis', ?, 'Psicóloga', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'pendente')",
    [await freeSlug(`${c.name} ${c.city || ''}`), c.name, c.crp, c.crp_uf, em, str(phone, 30), str(phone, 30), c.city, c.uf, c.city_slug]);
  return byId(r.insertId);
}
// Perfil de um profissional da Mentez (criado ou atualizado pelo sistema da clínica)
export async function upsertMentez(tenantId, userId, base) {
  let p = await byUser(tenantId, userId);
  if (!p) {
    const r = await T.pq("INSERT INTO dir_profiles (slug, kind, tenant_id, user_id, name, status, online) VALUES (?, 'mentez', ?, ?, ?, 'oculto', 1)", [await freeSlug(`${base.name} ${base.city || ''}`), tenantId, userId, str(base.name, 120) || 'Profissional']);
    p = await byId(r.insertId);
  }
  return p;
}
export async function setPhoto(id, buf) {
  if (!buf?.length) throw new Error('Envie uma foto.');
  let out;
  try { out = await sharp(buf, { limitInputPixels: 60e6 }).rotate().resize(640, 640, { fit: 'cover', position: 'attention' }).webp({ quality: 82 }).toBuffer(); } catch { throw new Error('Não foi possível ler a foto. Envie em JPG, PNG, WebP ou HEIC.'); }
  await T.pq('INSERT INTO dir_photos (profile_id, data) VALUES (?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data)', [id, out]);
  await T.pq('UPDATE dir_profiles SET photo_v = photo_v + 1 WHERE id = ?', [id]);
}
export const photo = (id) => T.pone('SELECT data FROM dir_photos WHERE profile_id = ?', [id]);

// ---------- destaque efetivo: o maior entre o pago (dentro da validade) e o incluído no plano da Mentez ----------
const incCache = new Map();
async function includedTier(tenantId) {
  if (!tenantId) return 'gratis';
  const hit = incCache.get(tenantId); if (hit && Date.now() - hit.at < 300e3) return hit.v;
  let v = 'gratis';
  try { const t = (await T.all()).find((x) => x.id === tenantId); if (t && t.status === 'ativa') { const f = await Billing.featuresOf(t); v = Billing.has(f, 'bem_prata') ? 'prata' : Billing.has(f, 'bem_bronze') ? 'bronze' : 'gratis'; } } catch { /* sem plano */ }
  incCache.set(tenantId, { v, at: Date.now() }); return v;
}
export async function tierOf(p) {
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  const paid = p.tier && p.tier !== 'gratis' && (!p.tier_until || String(p.tier_until instanceof Date ? p.tier_until.toISOString() : p.tier_until).slice(0, 10) >= today) ? p.tier : 'gratis';
  const inc = p.kind === 'mentez' ? await includedTier(p.tenant_id) : 'gratis';
  return RANK[paid] >= RANK[inc] ? paid : inc;
}

// ---------- busca ----------
const daySeed = () => new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
const hash = (s) => parseInt(crypto.createHash('sha1').update(s).digest('hex').slice(0, 8), 16);
export async function search(f = {}, { limit = 60 } = {}) {
  const where = ["status = 'ativo'"]; const args = [];
  if (f.city) { where.push('(city_slug = ? OR FIND_IN_SET(?, extra_cities))'); args.push(f.city, f.city); }
  if (f.online) where.push('online = 1');
  if (f.presencial) where.push('presencial = 1');
  if (f.tema && TEMAS[f.tema]) { where.push('(FIND_IN_SET(?, temas) OR FIND_IN_SET(?, extra_temas))'); args.push(f.tema, f.tema); }
  if (f.abordagem && ABORDAGENS[f.abordagem]) { where.push('FIND_IN_SET(?, abordagens)'); args.push(f.abordagem); }
  if (f.publico && PUBLICOS[f.publico]) { where.push('FIND_IN_SET(?, publicos)'); args.push(f.publico); }
  if (f.ate) { where.push('(price_min IS NULL OR price_min <= ?)'); args.push(Number(f.ate)); }
  if (f.agenda) where.push("booking_url IS NOT NULL AND booking_url <> ''");
  if (f.q) { where.push('(name LIKE ? OR bio LIKE ?)'); args.push(`%${String(f.q).slice(0, 60)}%`, `%${String(f.q).slice(0, 60)}%`); }
  const rows = await T.pq(`SELECT * FROM dir_profiles WHERE ${where.join(' AND ')} LIMIT 600`, args);
  const seed = daySeed();
  for (const p of rows) {
    p.tierEff = await tierOf(p);
    p.score = (p.photo_v ? 10 : 0) + (String(p.bio || '').length > 200 ? 10 : 0) + (list(p.temas).length >= 3 ? 5 : 0) + (p.price_min ? 4 : 0)
      + (p.booking_url ? 15 : 0) + (p.crp_ok ? 10 : 0) + (p.epsi ? 3 : 0) + TIERS[p.tierEff].boost + (hash(`${seed}|${p.id}`) % 9);
  }
  // até 3 patrocinados (Ouro), em rodízio a cada hora
  const hour = new Date().toISOString().slice(0, 13);
  const gold = rows.filter((p) => p.tierEff === 'ouro').sort((a, b) => hash(`${hour}|${a.id}`) - hash(`${hour}|${b.id}`)).slice(0, 3);
  const ids = new Set(gold.map((p) => p.id));
  const organic = rows.filter((p) => !ids.has(p.id)).sort((a, b) => b.score - a.score);
  return { sponsored: gold, organic: organic.slice(0, limit), total: rows.length };
}
export async function featured(n = 6) {
  const rows = await T.pq("SELECT * FROM dir_profiles WHERE status = 'ativo' AND photo_v > 0 LIMIT 400");
  const out = [];
  for (const p of rows) { p.tierEff = await tierOf(p); if (p.tierEff === 'ouro' || p.tierEff === 'prata') out.push(p); }
  const hour = new Date().toISOString().slice(0, 13);
  return out.sort((a, b) => (RANK[b.tierEff] - RANK[a.tierEff]) || (hash(`${hour}|${a.id}`) - hash(`${hour}|${b.id}`))).slice(0, n);
}
export async function cities() { return T.pq("SELECT city_slug, MAX(city) city, MAX(uf) uf, COUNT(*) n FROM dir_profiles WHERE status = 'ativo' AND city_slug IS NOT NULL AND city_slug <> '' GROUP BY city_slug ORDER BY n DESC, city LIMIT 200"); }
export async function cityName(slug) { const r = await T.pone("SELECT city, uf FROM dir_profiles WHERE city_slug = ? AND city IS NOT NULL LIMIT 1", [slug]); return r ? `${r.city} - ${r.uf}` : null; }

// ---------- estatísticas (sem cookies, sem dados de quem visita) ----------
export async function stat(profileId, kind) {
  if (!['view', 'wa', 'book', 'site'].includes(kind)) return;
  await T.pq('INSERT INTO dir_stats (day, profile_id, kind, n) VALUES (CURDATE(), ?, ?, 1) ON DUPLICATE KEY UPDATE n = n + 1', [profileId, kind]).catch(() => {});
}
export async function statsOf(profileId, days = 30) {
  const rows = await T.pq(`SELECT kind, SUM(n) n FROM dir_stats WHERE profile_id = ? AND day >= DATE_SUB(CURDATE(), INTERVAL ${Number(days) - 1} DAY) GROUP BY kind`, [profileId]);
  return Object.fromEntries(['view', 'wa', 'book', 'site'].map((k) => [k, Number(rows.find((r) => r.kind === k)?.n || 0)]));
}

// ---------- acesso por link (perfis grátis) ----------
export async function newToken(profileId, minutes = 60 * 24) {
  const tok = crypto.randomBytes(24).toString('base64url');
  await T.pq('INSERT INTO dir_tokens (token_hash, profile_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL ? MINUTE))', [crypto.createHash('sha256').update(tok).digest('hex'), profileId, minutes]);
  await T.pq('DELETE FROM dir_tokens WHERE expires_at < NOW()').catch(() => {});
  return tok;
}
export async function useToken(tok) {
  const h = crypto.createHash('sha256').update(String(tok || '')).digest('hex');
  const r = await T.pone('SELECT profile_id FROM dir_tokens WHERE token_hash = ? AND expires_at > NOW()', [h]);
  if (!r) return null;
  await T.pq('DELETE FROM dir_tokens WHERE token_hash = ?', [h]);
  await T.pq('UPDATE dir_profiles SET last_login = NOW() WHERE id = ?', [r.profile_id]);
  return byId(r.profile_id);
}
export const sessionCookie = (profileId) => T.seal({ p: profileId, e: Date.now() + 30 * 86400e3 });
export function sessionOf(req) {
  const m = /(?:^|;\s*)bm=([^;]+)/.exec(req.headers.cookie || ''); if (!m) return null;
  try { const s = T.unseal(decodeURIComponent(m[1])); return s?.p && s.e > Date.now() ? s.p : null; } catch { return null; }
}
export async function requestTier(profileId, tier) {
  if (!TIERS[tier] || tier === 'gratis') throw new Error('Plano inválido.');
  await T.pq("INSERT INTO dir_requests (profile_id, tier) VALUES (?, ?)", [profileId, tier]);
}
