// Marketing → Cartão digital (/cartao) e Link na bio (/links): páginas públicas de cada clínica, no endereço dela
// (ex.: aurelio.mentez.com.br/cartao ou app.aurelioazevedo.com/links). Os textos ficam em settings; a foto, junto das
// imagens da marca (Brand, tipo “foto”). Cliques contados em mkt_clicks (sem dados pessoais de quem clicou).
import QRCode from 'qrcode';
import { q, one, getSetting, setSetting } from './db.js';
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';

const s = (v, n) => String(v ?? '').trim().slice(0, n);
const digits = (v) => String(v || '').replace(/\D/g, '');
export const base = () => String(Tenancy.env('PUBLIC_URL') || '').replace(/\/+$/, '');

let ready = false;
async function ensure() {
  if (ready) return;
  await q(`CREATE TABLE IF NOT EXISTS mkt_clicks (
    id BIGINT AUTO_INCREMENT PRIMARY KEY, page VARCHAR(10) NOT NULL, item VARCHAR(40) NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (page, created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  ready = true;
}
export async function click(page, item) { await ensure(); await q('INSERT INTO mkt_clicks (page, item) VALUES (?,?)', [page, s(item, 40)]); }
export async function stats(page, days = 30) {
  await ensure();
  const rows = await q('SELECT item, COUNT(*) n FROM mkt_clicks WHERE page = ? AND created_at >= DATE_SUB(NOW(), INTERVAL ? DAY) GROUP BY item ORDER BY n DESC', [page, days]);
  return Object.fromEntries(rows.map((r) => [r.item, Number(r.n)]));
}

// ---------- configuração ----------
function cardDefaults(b) {
  return {
    enabled: true, name: b.proName || b.short || b.name, role: b.signLine || b.proRole || '',
    intro: '', waText: `Olá${b.proFirst ? `, ${b.proFirst}` : ''}! Vim pelo seu cartão digital e gostaria de agendar uma consulta.`,
    show: { whatsapp: true, phone: true, email: true, instagram: true, site: true, address: false },
    extra: [], info: [{ label: 'Atendimento', value: b.place ? `On-line e presencial em ${b.city || b.place}` : 'On-line e presencial' }, { label: '', value: '' }],
    crisis: true,
  };
}
function linksDefaults(b) {
  return {
    enabled: true, title: b.proName || b.short || b.name, tagline: [b.proRole, b.city].filter(Boolean).join(' · '), bio: '', photo: true,
    items: [
      { kind: 'whatsapp', title: 'Agendar minha sessão', sub: 'Pelo WhatsApp', url: '', text: `Olá${b.proFirst ? `, ${b.proFirst}` : ''}! Vim pelo seu Instagram e gostaria de agendar uma consulta.`, highlight: true },
      ...(b.siteUrl ? [{ kind: 'site', title: 'Conhecer o site', sub: b.site, url: b.siteUrl, text: '', highlight: false }] : []),
      { kind: 'agendar', title: 'Agendar on-line', sub: 'Escolha um horário livre', url: '', text: '', highlight: false },
    ],
    crisis: true,
  };
}
export async function config(kind) {
  const b = await Brand.load();
  const d = kind === 'cartao' ? cardDefaults(b) : linksDefaults(b);
  let saved = {}; try { saved = JSON.parse((await getSetting(kind === 'cartao' ? 'mkt_card' : 'mkt_links')) || '{}'); } catch { /* padrão */ }
  return { ...d, ...saved, show: { ...(d.show || {}), ...(saved.show || {}) } };
}
const KINDS = ['whatsapp', 'site', 'agendar', 'instagram', 'link', 'secao'];
const cleanUrl = (u) => { const v = s(u, 400); return /^(https?:\/\/|mailto:|tel:)/i.test(v) ? v : v ? `https://${v.replace(/^\/+/, '')}` : ''; };
export async function save(kind, body) {
  const arr = (v) => [].concat(v ?? []);
  if (kind === 'cartao') {
    const labels = arr(body.extra_label); const values = arr(body.extra_value); const urls = arr(body.extra_url);
    const extra = labels.map((l, i) => ({ label: s(l, 40), value: s(values[i], 80), url: cleanUrl(urls[i]) })).filter((x) => x.label && x.url).slice(0, 6);
    const il = arr(body.info_label); const iv = arr(body.info_value);
    const v = {
      enabled: !!body.enabled, name: s(body.name, 80), role: s(body.role, 80), intro: s(body.intro, 300), waText: s(body.waText, 300),
      show: Object.fromEntries(['whatsapp', 'phone', 'email', 'instagram', 'site', 'address'].map((k) => [k, !!body[`show_${k}`]])),
      extra, info: [0, 1].map((i) => ({ label: s(il[i], 30), value: s(iv[i], 60) })), crisis: !!body.crisis,
    };
    await setSetting('mkt_card', JSON.stringify(v));
  } else {
    const k = arr(body.item_kind); const t = arr(body.item_title); const sub = arr(body.item_sub); const u = arr(body.item_url); const tx = arr(body.item_text); const hl = arr(body.item_highlight).map(String);
    const items = k.map((kk, i) => ({ kind: KINDS.includes(kk) ? kk : 'link', title: s(t[i], 60), sub: s(sub[i], 80), url: ['whatsapp', 'agendar', 'secao'].includes(kk) ? '' : cleanUrl(u[i]), text: s(tx[i], 300), highlight: hl.includes(String(i)) }))
      .filter((x) => x.title && (x.url || ['whatsapp', 'agendar', 'secao'].includes(x.kind))).slice(0, 16);
    const v = { enabled: !!body.enabled, title: s(body.title, 80), tagline: s(body.tagline, 100), bio: s(body.bio, 300), photo: !!body.photo, items, crisis: !!body.crisis };
    await setSetting('mkt_links', JSON.stringify(v));
  }
  return config(kind);
}

// ---------- contato (vCard) e QR code ----------
const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
export async function vcard() {
  const b = await Brand.load(); const c = await config('cartao');
  const name = c.name || b.who; const parts = name.replace(/^(Dra?\.|Dr\.)\s+/i, '').split(/\s+/);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:${esc(parts.slice(1).join(' '))};${esc(parts[0] || '')};;;`, `FN:${esc(name)}`];
  if (b.name && b.name !== name) lines.push(`ORG:${esc(b.name)}`);
  if (c.role) lines.push(`TITLE:${esc(c.role)}`);
  const ph = digits(b.whatsapp || b.phone); if (ph) lines.push(`TEL;TYPE=CELL:+${ph.length <= 11 ? `55${ph}` : ph}`);
  if (b.email) lines.push(`EMAIL;TYPE=INTERNET:${b.email}`);
  if (b.siteUrl) lines.push(`URL:${b.siteUrl}`);
  if (b.address || b.city) lines.push(`ADR;TYPE=WORK:;;${esc(b.address || '')};${esc(b.city || '')};${esc(b.uf || '')};;Brasil`);
  const photo = await Brand.logoFile('foto').catch(() => null);
  if (photo && ['image/jpeg', 'image/png'].includes(photo.mime) && photo.buf.length < 400 * 1024) lines.push(`PHOTO;ENCODING=b;TYPE=${photo.mime === 'image/png' ? 'PNG' : 'JPEG'}:${photo.buf.toString('base64')}`);
  lines.push(`NOTE:${esc(`Cartão digital: ${base()}/cartao`)}`, 'END:VCARD');
  return { name, text: lines.join('\r\n') + '\r\n' };
}
export const qrSvg = (url, dark = '#000000') => QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark, light: '#00000000' } });
export const qrPng = (url) => QRCode.toBuffer(url, { type: 'png', margin: 2, width: 1024, errorCorrectionLevel: 'M' });
