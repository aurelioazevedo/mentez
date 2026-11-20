import express from 'express';
import { parseCookies } from './auth.js';

// Router com tratamento de erros assíncronos (Express 4).
export function router() {
  const r = express.Router();
  for (const m of ['get', 'post']) {
    const orig = r[m].bind(r);
    r[m] = (p, ...fns) => orig(p, ...fns.map((fn) => (req, res, next) => {
      try { const out = fn(req, res, next); if (out && out.catch) out.catch(next); } catch (e) { next(e); }
    }));
  }
  return r;
}

// Mensagens rápidas entre redirecionamentos (cookie de curta duração).
export function flash(req, res, next) {
  const c = parseCookies(req).lm_flash;
  if (c) {
    try { req.flash = JSON.parse(Buffer.from(c, 'base64url').toString()); } catch { /* ignore */ }
    res.append('Set-Cookie', 'lm_flash=; Path=/; Max-Age=0; SameSite=Strict');
  }
  res.flash = (text, type = 'ok') => {
    res.append('Set-Cookie', `lm_flash=${Buffer.from(JSON.stringify({ text, type })).toString('base64url')}; Path=/; Max-Age=60; HttpOnly; SameSite=Strict`);
    return res;
  };
  next();
}

export const send = (res, page) => res.type('html').send(String(page));
export const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
export const str = (v, n = 255) => String(v ?? '').trim().slice(0, n);
export const dec = (v) => {
  let s = String(v ?? '').trim().replace(/[R$\s]/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};
