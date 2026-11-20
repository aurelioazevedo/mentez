import * as Tenancy from './tenancy.js';
import crypto from 'node:crypto';
import { one } from './db.js';

const COOKIE = 'lm_sess';
const PENDING = 'lm_mfa';

function secret() {
  const s = Tenancy.env('SESSION_SECRET');
  if (!s || s.length < 32) throw new Error('SESSION_SECRET ausente ou curta demais.');
  return s;
}
function sign(obj) {
  const body = Buffer.from(JSON.stringify(obj)).toString('base64url');
  const mac = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  return `${body}.${mac}`;
}
function unsign(value) {
  if (!value || !value.includes('.')) return null;
  const [body, mac] = value.split('.');
  const good = crypto.createHmac('sha256', secret()).update(body).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try {
    const obj = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch { return null; }
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, name, value, maxAgeSec) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`);
}

const SESSION_HOURS = 10;
export function startSession(res, user) {
  setCookie(res, COOKIE, sign({ uid: user.id, sv: user.session_version || 1, exp: Date.now() + SESSION_HOURS * 3600e3 }), SESSION_HOURS * 3600);
  setCookie(res, PENDING, '', 0);
}
export function startPending(res, user) {
  setCookie(res, PENDING, sign({ uid: user.id, exp: Date.now() + 5 * 60e3 }), 300);
}
export function pendingUser(req) {
  return unsign(parseCookies(req)[PENDING]);
}
export function endSession(res) {
  setCookie(res, COOKIE, '', 0);
  setCookie(res, PENDING, '', 0);
}

export async function loadUser(req, _res, next) {
  try { await load(req); next(); } catch (e) { next(e); }
}
async function load(req) {
  const s = unsign(parseCookies(req)[COOKIE]);
  const u = s ? await one('SELECT id, name, email, role, crp, title, photo_v, is_master, active, totp_enabled, must_change_password, session_version FROM users WHERE id = ?', [s.uid]) : null;
  // Sessão invalidada se o usuário foi desativado ou teve senha/perfil alterados.
  req.user = u && u.active && (s.sv || 1) === u.session_version ? u : null;
}

export function requireUser(req, res, next) {
  if (!req.user) return res.redirect('/login');
  // Senha provisória: obriga a troca antes de usar o sistema.
  if (req.user.must_change_password && !req.path.startsWith('/conta/trocar-senha')) return res.redirect('/conta/trocar-senha');
  next();
}

// Proteção CSRF: cookies SameSite=Strict + conferência da origem em todo POST.
export function checkOrigin(req, res, next) {
  if (req.method !== 'POST') return next();
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    try {
      if (new URL(origin).host !== host) return res.status(403).send('Origem inválida.');
    } catch { return res.status(403).send('Origem inválida.'); }
  }
  next();
}
