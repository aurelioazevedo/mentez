// Identidade da clínica: nome, profissional responsável, CRP, contatos, cidade, site, logo e cor.
// Fica em cada banco de clínica (settings “brand”, mais os dados de recibo em “fin_clinic”) e é editada em
// Configurações → Identidade da clínica.
//
// Valores padrão:
// - Sem a plataforma (sistema da Dra. Lorrainy, uma clínica só): exatamente os textos de antes, nada muda.
// - Na Mentez: o nome da clínica cadastrada e o visual da Mentez, até a clínica preencher a ficha.
//
// Uso: em páginas, Brand.get() (já carregado pelo middleware da requisição);
//      em tarefas automáticas e rotinas assíncronas, await Brand.load().
import { getSetting, setSetting } from './db.js';
import * as Tenancy from './tenancy.js';

const LEGACY = {
  name: 'Consultório Lorrainy Mendes', short: 'Lorrainy Mendes', proName: 'Dra. Lorrainy Mendes', proFirst: 'Dra. Lorrainy', proRole: 'Psicóloga',
  crp: '09/23862', phone: '(62) 98445-4631', email: 'contato@lorrainymendes.com.br', site: 'lorrainymendes.com.br', instagram: '@psilorrainymendes',
  city: 'Goiânia', uf: 'GO', address: '', color: '', appName: 'Sistema Lorrainy Mendes', legacy: true,
};
function mentezDefaults() {
  const t = Tenancy.current();
  const name = t?.name || 'Clínica';
  return { name, short: name, proName: '', proFirst: '', proRole: 'Psicologia', crp: '', phone: '', email: '', site: '', instagram: '', city: '', uf: '', address: '', color: '', appName: name, legacy: false };
}
export const isMentez = () => Tenancy.multi();
const S = Tenancy.scoped({ brand: null, at: 0 });
const TTL = 30e3;

const digits = (s) => String(s || '').replace(/\D/g, '');
// WhatsApp com DDI (55) a partir do telefone da ficha
export function waNumber(phone) { const d = digits(phone); if (!d) return ''; return d.length <= 11 ? `55${d}` : d; }
function finish(b) {
  b.wa = waNumber(b.whatsapp || b.phone);
  b.siteUrl = b.site ? (/^https?:\/\//.test(b.site) ? b.site : `https://${b.site}`) : '';
  b.place = [b.city, b.uf].filter(Boolean).join(' - '); // “Goiânia - GO”
  b.placeSlash = [b.city, b.uf].filter(Boolean).join('/'); // “Goiânia/GO”
  b.signLine = [b.proRole || '', b.crp ? `CRP ${b.crp}` : ''].filter(Boolean).join(' · '); // “Psicóloga · CRP 09/23862”
  b.who = b.proName || b.short || b.name; // como a clínica se apresenta ao paciente
  b.logoUrl = b.logo ? `/marca/logo?v=${b.logo}` : (b.legacy ? '/static/img/logo-terracota.png' : '');
  b.logoDarkUrl = b.logoDark ? `/marca/logo-escuro?v=${b.logoDark}` : (b.legacy ? '/static/img/logo-creme.png' : b.logoUrl);
  return b;
}
export async function load(force = false) {
  if (!force && S.brand && Date.now() - S.at < TTL) return S.brand;
  const base = isMentez() ? mentezDefaults() : { ...LEGACY };
  let saved = {}; let fin = {};
  try { saved = JSON.parse((await getSetting('brand')) || '{}'); } catch { /* padrão */ }
  try { fin = JSON.parse((await getSetting('fin_clinic')) || '{}'); } catch { /* padrão */ }
  const pick = (k, alt) => (saved[k] !== undefined && saved[k] !== '' ? saved[k] : alt);
  const b = {
    ...base,
    name: fin.name || pick('name', base.name), city: fin.city || pick('city', base.city), phone: fin.phone || pick('phone', base.phone),
    email: fin.email || pick('email', base.email), address: fin.address || pick('address', base.address),
  };
  for (const k of ['short', 'proName', 'proFirst', 'proRole', 'crp', 'site', 'instagram', 'uf', 'color', 'whatsapp', 'logo', 'logoDark', 'appName']) b[k] = pick(k, b[k]);
  if (!saved.appName && saved.short) b.appName = isMentez() ? saved.short : `Sistema ${saved.short}`;
  b.appNameSaved = saved.appName || '';
  S.brand = finish(b); S.at = Date.now();
  return S.brand;
}
// Leitura imediata (páginas): o middleware já carregou; sem carga ainda, usa os padrões.
export function get() { return S.brand || finish(isMentez() ? mentezDefaults() : { ...LEGACY }); }
export function middleware(req, res, next) { load().then(() => next(), next); }

// Grava a ficha (os campos de recibo continuam também em fin_clinic, usados pelo financeiro)
export async function save(b) {
  const cur = JSON.parse((await getSetting('brand')) || '{}');
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const color = /^#[0-9a-fA-F]{6}$/.test(String(b.color || '')) ? b.color : '';
  const next = { ...cur, short: s(b.short, 80), proName: s(b.proName, 120), proFirst: s(b.proFirst, 60), proRole: s(b.proRole, 60), crp: s(b.crp, 30),
    site: s(b.site, 120).replace(/^https?:\/\//, '').replace(/\/+$/, ''), instagram: s(b.instagram, 60), uf: s(b.uf, 2).toUpperCase(), whatsapp: s(b.whatsapp, 40), color, appName: s(b.appName, 80) };
  await setSetting('brand', JSON.stringify(next));
  const fin = JSON.parse((await getSetting('fin_clinic')) || '{}');
  await setSetting('fin_clinic', JSON.stringify({ ...fin, name: s(b.name, 160), city: s(b.city, 80), phone: s(b.phone, 40), email: s(b.email, 120), address: s(b.address, 200) }));
  S.brand = null;
  return load(true);
}

// ---------- logo (PNG, JPEG ou WebP, até 2 MB; PNG e JPEG também entram nos PDFs) ----------
export async function saveLogo(kind, buf, mime) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Envie a logo em PNG, JPG ou WebP.');
  if (!buf?.length || buf.length > 2 * 1024 * 1024) throw new Error('A logo precisa ter até 2 MB.');
  // confere a assinatura do arquivo (não confia só no tipo informado pelo navegador)
  const sig = buf.subarray(0, 12);
  const real = sig[0] === 0x89 && sig[1] === 0x50 ? 'image/png' : sig[0] === 0xff && sig[1] === 0xd8 ? 'image/jpeg' : sig.toString('latin1', 0, 4) === 'RIFF' && sig.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (real !== mime) throw new Error('O arquivo não parece ser uma imagem PNG, JPG ou WebP válida.');
  const key = kind === 'escuro' ? 'brand_logo_dark' : 'brand_logo';
  await setSetting(key, JSON.stringify({ mime, data: buf.toString('base64') }));
  const cur = JSON.parse((await getSetting('brand')) || '{}');
  cur[kind === 'escuro' ? 'logoDark' : 'logo'] = Date.now().toString(36);
  await setSetting('brand', JSON.stringify(cur));
  S.brand = null;
}
export async function removeLogo(kind) {
  await setSetting(kind === 'escuro' ? 'brand_logo_dark' : 'brand_logo', null);
  const cur = JSON.parse((await getSetting('brand')) || '{}');
  delete cur[kind === 'escuro' ? 'logoDark' : 'logo'];
  await setSetting('brand', JSON.stringify(cur));
  S.brand = null;
}
export async function logoFile(kind = 'claro') {
  try {
    const raw = await getSetting(kind === 'escuro' ? 'brand_logo_dark' : 'brand_logo');
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o?.data ? { mime: o.mime, buf: Buffer.from(o.data, 'base64') } : null;
  } catch { return null; }
}

// Ícones do aplicativo: os da Dra. Lorrainy no sistema dela; os da Mentez nas clínicas da plataforma
export const icon = (file) => (isMentez() ? `/static/img/mentez/${file}` : `/static/img/${file}`);
// Manifesto do aplicativo instalável (nome e ícones da clínica)
export function manifest({ start = '/', scope = '/', suffix = '' } = {}) {
  const b = get();
  return {
    name: suffix ? `${b.short} · ${suffix}` : b.appName, short_name: (b.legacy && !suffix ? 'Consultório' : b.short).slice(0, 24), description: b.legacy ? 'Sistema de gestão do consultório — Lorrainy Mendes, Psicóloga' : `${b.name} · gestão pela Mentez`,
    start_url: start, scope, id: start, display: 'standalone', lang: 'pt-BR',
    background_color: b.legacy ? '#f6f0e8' : '#F5F7FC', theme_color: b.legacy ? '#47291c' : '#071936',
    icons: [{ src: icon('app-192.png'), sizes: '192x192', type: 'image/png' }, { src: icon('app-512.png'), sizes: '512x512', type: 'image/png' }, { src: icon('app-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' }],
  };
}

// ---------- tema (cores) ----------
// Mentez: paleta do manual de marca (Midnight Navy, Digital Teal, Electric Violet) e Plus Jakarta Sans.
// A cor da clínica, se escolhida, substitui a cor de destaque.
function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16); const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const m = c.map((v) => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f))));
  return `#${m.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
export function themeCss(b = get()) {
  const out = [];
  if (!b.legacy) {
    out.push(`:root,.letter{--terracota:#04857E;--terracota-d:#036B65;--terracota-l:#07C6BC;--creme:#E6F6EF;--creme-deep:#BDE5D2;--musgo:#5B47C9;--marrom:#1E3663;--marrom-deep:#071936;--bg:#F5F7FC;--bg2:#E8EDF5;--ink:#0D2246;--muted:#4F5E74;--line:#D9E0EC;--card:#fff;--surface:#fff;--surface-2:#F5F7FC;--strong-bg:#071936;--strong-ink:#F5F7FC;--strong-accent:#07C6BC;--serif:'Plus Jakarta Sans',system-ui,sans-serif;--sans:'Plus Jakarta Sans',system-ui,sans-serif}`);
    out.push(':root[data-theme="dark"]{--terracota:#07C6BC;--terracota-d:#3BD6CD;--terracota-l:#07C6BC;--creme:#132C57;--creme-deep:#1E3663;--marrom:#C9D2E3;--marrom-deep:#F5F7FC;--bg:#071936;--bg2:#0D2246;--ink:#F5F7FC;--muted:#A9B5CA;--line:#1E3663;--card:#0D2246;--surface:#0D2246;--surface-2:#132C57;--strong-bg:#132C57;--strong-ink:#F5F7FC}');
    out.push('@media (prefers-color-scheme: dark){:root[data-theme="auto"]{--terracota:#07C6BC;--terracota-d:#3BD6CD;--creme:#132C57;--creme-deep:#1E3663;--marrom:#C9D2E3;--marrom-deep:#F5F7FC;--bg:#071936;--bg2:#0D2246;--ink:#F5F7FC;--muted:#A9B5CA;--line:#1E3663;--card:#0D2246;--surface:#0D2246;--surface-2:#132C57}}');
    out.push('h1,h2,h3{font-weight:700;letter-spacing:-.01em}');
  }
  if (b.color) out.push(`:root,.letter{--terracota:${b.color};--terracota-d:${shade(b.color, -0.2)};--terracota-l:${shade(b.color, 0.25)}}`);
  return out.join('\n');
}
