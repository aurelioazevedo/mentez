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
import * as Billing from './billing.js';
import * as Styles from './styles.js';

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
// Identidade “legada” (a da Dra. Lorrainy): no sistema de uma clínica só, e na Mentez para a clínica marcada com MENTEZ_BRAND=legacy
export const legacyBrand = () => !Tenancy.multi() || Tenancy.env('MENTEZ_BRAND') === 'legacy';
// O plano da clínica inclui personalização visual e domínio próprio? (sem a plataforma: sempre)
export async function canCustomize(t = Tenancy.current()) {
  if (!isMentez()) return true;
  if (!t) return false;
  try { return (await Billing.featuresOf(t)).includes('personalizacao'); } catch { return false; }
}
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
  // Personalização visual (logo, símbolo, favicon e cores): sistema da Dra. Lorrainy sempre; na Mentez, conforme o plano
  if (b.custom === false) { b.logo = ''; b.logoDark = ''; b.symbol = ''; b.symbolDark = ''; b.favicon = ''; b.colors = []; b.color = ''; }
  b.style = Styles.keyOf(b.custom === false ? '' : b.style, b.legacy);
  b.colors = (b.colors && b.colors.length ? b.colors : [b.color || '', '', '', '']).concat(['', '', '', '']).slice(0, 4);
  b.color = b.colors[0];
  // logoUrl: logo da própria clínica (documentos, portal e páginas do paciente; vazio = nome em texto)
  b.logoUrl = b.logo ? `/marca/logo?v=${b.logo}` : (b.legacy ? '/static/img/logo-terracota.png' : '');
  b.logoDarkUrl = b.logoDark ? `/marca/logo-escuro?v=${b.logoDark}` : (b.legacy ? '/static/img/logo-creme.png' : b.logoUrl);
  // appLogo*: telas do sistema (menu, login). Sem logo enviada, a da Mentez.
  const mz = '/static/img/mentez';
  b.appLogoUrl = b.logoUrl || `${mz}/logo.png`;
  b.appLogoDarkUrl = b.logo ? b.logoDarkUrl : (b.logoUrl ? b.logoDarkUrl : `${mz}/logo-dark.png`);
  // símbolo (logo sem o nome) para o menu recolhido
  b.symbolUrl = b.symbol ? `/marca/simbolo?v=${b.symbol}` : (b.legacy ? '/static/img/simbolo-terracota.png' : (b.logo ? '' : `${mz}/simbolo.png`));
  b.symbolDarkUrl = b.symbolDark ? `/marca/simbolo-escuro?v=${b.symbolDark}` : (b.legacy ? '/static/img/simbolo-creme.png' : b.symbolUrl);
  b.faviconUrl = b.favicon ? `/marca/favicon?v=${b.favicon}` : '';
  b.photoUrl = b.photo ? `/marca/foto?v=${b.photo}` : '';
  return b;
}
export async function load(force = false) {
  if (!force && S.brand && Date.now() - S.at < TTL) return S.brand;
  const base = legacyBrand() ? { ...LEGACY } : mentezDefaults();
  let saved = {}; let fin = {};
  try { saved = JSON.parse((await getSetting('brand')) || '{}'); } catch { /* padrão */ }
  try { fin = JSON.parse((await getSetting('fin_clinic')) || '{}'); } catch { /* padrão */ }
  const pick = (k, alt) => (saved[k] !== undefined && saved[k] !== '' ? saved[k] : alt);
  const b = {
    ...base,
    name: fin.name || pick('name', base.name), city: fin.city || pick('city', base.city), phone: fin.phone || pick('phone', base.phone),
    email: fin.email || pick('email', base.email), address: fin.address || pick('address', base.address),
  };
  for (const k of ['short', 'proName', 'proFirst', 'proRole', 'crp', 'site', 'instagram', 'uf', 'color', 'whatsapp', 'logo', 'logoDark', 'symbol', 'symbolDark', 'favicon', 'photo', 'appName']) b[k] = pick(k, b[k]);
  b.colors = Array.isArray(saved.colors) ? saved.colors : [];
  b.style = saved.style || '';
  b.custom = await canCustomize();
  if (!saved.appName && saved.short) b.appName = legacyBrand() ? `Sistema ${saved.short}` : saved.short;
  b.appNameSaved = saved.appName || '';
  S.brand = finish(b); S.at = Date.now();
  return S.brand;
}
// Leitura imediata (páginas): o middleware já carregou; sem carga ainda, usa os padrões.
export function get() { return S.brand || finish(legacyBrand() ? { ...LEGACY } : mentezDefaults()); }
export function middleware(req, res, next) { load().then(() => next(), next); }

// Grava a ficha (os campos de recibo continuam também em fin_clinic, usados pelo financeiro)
export async function save(b) {
  const cur = JSON.parse((await getSetting('brand')) || '{}');
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const hex = (v) => (/^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? String(v).toLowerCase() : '');
  const colors = b.colors === undefined ? [...(cur.colors || [cur.color || ''])] : [].concat(b.colors).slice(0, 4).map(hex);
  while (colors.length < 4) colors.push('');
  const color = colors[0];
  const next = { ...cur, short: s(b.short, 80), proName: s(b.proName, 120), proFirst: s(b.proFirst, 60), proRole: s(b.proRole, 60), crp: s(b.crp, 30),
    site: s(b.site, 120).replace(/^https?:\/\//, '').replace(/\/+$/, ''), instagram: s(b.instagram, 60), uf: s(b.uf, 2).toUpperCase(), whatsapp: s(b.whatsapp, 40), color, colors, style: b.style === undefined ? (cur.style || '') : (Styles.STYLES[b.style] ? b.style : ''), appName: s(b.appName, 80) };
  await setSetting('brand', JSON.stringify(next));
  const fin = JSON.parse((await getSetting('fin_clinic')) || '{}');
  await setSetting('fin_clinic', JSON.stringify({ ...fin, name: s(b.name, 160), city: s(b.city, 80), phone: s(b.phone, 40), email: s(b.email, 120), address: s(b.address, 200) }));
  S.brand = null;
  return load(true);
}

// ---------- imagens da marca (PNG, JPEG ou WebP, até 2 MB) ----------
// claro/escuro: logo completa; simbolo/simbolo-escuro: logo sem o nome (menu recolhido); favicon: ícone da aba e do aplicativo.
// O navegador já converte e reduz a imagem antes de enviar (public/app.js); aqui só conferimos.
export const ASSETS = {
  claro: { setting: 'brand_logo', field: 'logo', label: 'logo' },
  escuro: { setting: 'brand_logo_dark', field: 'logoDark', label: 'logo para fundo escuro' },
  simbolo: { setting: 'brand_symbol', field: 'symbol', label: 'símbolo' },
  'simbolo-escuro': { setting: 'brand_symbol_dark', field: 'symbolDark', label: 'símbolo para fundo escuro' },
  favicon: { setting: 'brand_favicon', field: 'favicon', label: 'favicon' },
  foto: { setting: 'brand_photo', field: 'photo', label: 'foto do profissional' }, // cartão digital e link na bio
};
const asset = (kind) => ASSETS[kind] || ASSETS.claro;
export async function saveLogo(kind, buf, mime) {
  const a = asset(kind);
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) throw new Error('Envie a imagem em PNG, JPG ou WebP.');
  if (!buf?.length || buf.length > 2 * 1024 * 1024) throw new Error('A imagem precisa ter até 2 MB.');
  // confere a assinatura do arquivo (não confia só no tipo informado pelo navegador)
  const sig = buf.subarray(0, 12);
  const real = sig[0] === 0x89 && sig[1] === 0x50 ? 'image/png' : sig[0] === 0xff && sig[1] === 0xd8 ? 'image/jpeg' : sig.toString('latin1', 0, 4) === 'RIFF' && sig.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp' : null;
  if (!real) throw new Error('O arquivo não parece ser uma imagem PNG, JPG ou WebP válida.');
  await setSetting(a.setting, JSON.stringify({ mime: real, data: buf.toString('base64') }));
  const cur = JSON.parse((await getSetting('brand')) || '{}');
  cur[a.field] = Date.now().toString(36);
  await setSetting('brand', JSON.stringify(cur));
  S.brand = null;
}
export async function removeLogo(kind) {
  const a = asset(kind);
  await setSetting(a.setting, null);
  const cur = JSON.parse((await getSetting('brand')) || '{}');
  delete cur[a.field];
  await setSetting('brand', JSON.stringify(cur));
  S.brand = null;
}
export async function logoFile(kind = 'claro') {
  try {
    if (kind === 'claro' && !(await load()).logo) return null; // fora do plano, a logo enviada não aparece nos documentos
    const raw = await getSetting(asset(kind).setting);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o?.data ? { mime: o.mime, buf: Buffer.from(o.data, 'base64') } : null;
  } catch { return null; }
}

// Ícones do aplicativo: os da Dra. Lorrainy no sistema dela; os da Mentez nas clínicas da plataforma
export const icon = (file) => {
  const b = get();
  if (b.faviconUrl && /^(favicon|apple-touch-icon|app-192|app-512)/.test(file)) return b.faviconUrl;
  return legacyBrand() ? `/static/img/${file}` : `/static/img/mentez/${file}`;
};
// Manifesto do aplicativo instalável (nome e ícones da clínica)
export function manifest({ start = '/', scope = '/', suffix = '' } = {}) {
  const b = get();
  const icons = b.faviconUrl
    ? [{ src: b.faviconUrl, sizes: '512x512', type: 'image/png', purpose: 'any' }]
    : [{ src: icon('app-192.png'), sizes: '192x192', type: 'image/png' }, { src: icon('app-512.png'), sizes: '512x512', type: 'image/png' }, { src: icon('app-maskable-512.png'), sizes: '512x512', type: 'image/png', purpose: 'maskable' }];
  return {
    name: suffix ? `${b.short} · ${suffix}` : b.appName, short_name: (b.legacy && !suffix ? 'Consultório' : b.short).slice(0, 24), description: b.legacy ? 'Sistema de gestão do consultório — Lorrainy Mendes, Psicóloga' : `${b.name} · gestão pela Mentez`,
    start_url: start, scope, id: start, display: 'standalone', lang: 'pt-BR',
    background_color: Styles.swatch(b.style).bg, theme_color: b.colors[1] || Styles.swatch(b.style).dark || (b.legacy ? '#47291c' : '#071936'),
    icons,
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
function lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}
export function themeCss(b = get()) {
  const out = [];
  out.push(Styles.css(b.style || Styles.keyOf('', b.legacy))); // estilo escolhido (cores, fontes, cantos, sombras)
  // Paleta da clínica (até 4 cores): 1 principal (botões, links, menu ativo), 2 escura (títulos e textos fortes),
  // 3 de destaque (gradientes, ícones e gráficos), 4 clara (fundos suaves e etiquetas). Vazias = cores padrão.
  const [c1, c2, c3, c4] = b.colors || [b.color];
  if (c1) out.push(`:root,.letter{--terracota:${c1};--terracota-d:${shade(c1, -0.2)};--terracota-l:${shade(c1, 0.25)}}`);
  if (c2) out.push(`:root:not([data-theme="dark"]),.letter{--marrom-deep:${c2};--marrom:${shade(c2, 0.2)};--ink:${c2};--strong-bg:${c2}}`);
  if (c3) out.push(`:root,.letter{--musgo:${c3};--strong-accent:${c3}}`);
  if (c4) out.push(`:root:not([data-theme="dark"]),.letter{--creme:${c4};--creme-deep:${shade(c4, -0.12)}}`);
  if (c2 || c4) out.push('@media (prefers-color-scheme: dark){:root[data-theme="auto"]{' + (c2 ? '--marrom-deep:#F5F7FC;--marrom:#C9D2E3;--ink:#F5F7FC;--strong-bg:#132C57;' : '') + (c4 ? '--creme:#132C57;--creme-deep:#1E3663;' : '') + '}}');
  // contraste mínimo do texto branco sobre a cor principal (botões)
  if (c1 && lum(c1) > 0.3) out.push(`.btn:not(.ghost),.side nav a.on,.ag-views a.on{color:#0D2246 !important}`);
  return out.join('\n');
}
