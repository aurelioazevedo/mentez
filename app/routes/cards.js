// Marketing → Cartão digital (/cartao) e Link na bio (/links).
// Páginas públicas no endereço da clínica + telas de edição em /marketing/cartao e /marketing/links.
import express from 'express';
import { audit } from '../lib/db.js';
import { page, html, raw, VERSION } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import * as Brand from '../lib/brand.js';
import * as Cards from '../lib/cards.js';
import * as BK from '../lib/booking.js';
import * as Styles from '../lib/styles.js';

const digits = (v) => String(v || '').replace(/\D/g, '');
const fmtPhone = (p) => { const d = digits(p).replace(/^55(?=\d{10,11}$)/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : p || ''; };
const ig = (v) => String(v || '').replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/.*$/, '');

// ---------- visual (cores da clínica; na identidade legada, as da Dra. Lorrainy) ----------
function palette(b) {
  const st = Styles.STYLES[b.style] || Styles.STYLES.mentez; const w = Styles.swatch(b.style);
  const L = st.light || {}; const cls = b.style === 'classico';
  return {
    accent: b.colors?.[0] || w.accent, dark: b.colors?.[1] || (cls ? '#47291c' : L['strong-bg'] || w.ink),
    soft: b.colors?.[3] || w.soft, bg: w.bg, ink: w.ink, muted: cls ? '#6e5546' : L.muted || '#4F5E74',
    serif: st.serif, sans: st.sans, fonts: st.fonts,
  };
}
const CSS = (p) => `:root{--a:${p.accent};--d:${p.dark};--s:${p.soft};--bg:${p.bg};--ink:${p.ink};--mu:${p.muted};--serif:${p.serif};--sans:${p.sans}}
*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh;background:var(--bg);color:var(--ink);font-family:var(--sans);display:flex;justify-content:center;-webkit-font-smoothing:antialiased}
main{width:100%;max-width:440px;padding:max(32px,env(safe-area-inset-top)) 20px max(32px,env(safe-area-inset-bottom))}
a{color:inherit}.in{animation:up .6s cubic-bezier(.22,1,.36,1) both;animation-delay:calc(var(--i,0)*60ms)}@keyframes up{from{opacity:0;transform:translateY(10px)}}
@media (prefers-reduced-motion:reduce){.in{animation:none}}
.card{display:block;width:100%;aspect-ratio:1.6;perspective:1200px;border:0;padding:0;background:none;cursor:pointer;font:inherit;color:inherit}
.card__inner{position:relative;display:block;width:100%;height:100%;transition:transform .7s cubic-bezier(.22,1,.36,1);transform-style:preserve-3d}
.card.flip .card__inner{transform:rotateY(180deg)}
.card__face{position:absolute;inset:0;border-radius:20px;backface-visibility:hidden;-webkit-backface-visibility:hidden;overflow:hidden;box-shadow:0 18px 40px -18px rgba(0,0,0,.45)}
.card__front{background:linear-gradient(135deg,var(--a),var(--d));color:#fff;display:grid;grid-template-columns:auto 1fr;align-items:center;gap:16px;padding:22px;text-align:left}
.card__photo{width:96px;height:96px;border-radius:50%;overflow:hidden;border:3px solid rgba(255,255,255,.85);background:rgba(255,255,255,.15);display:grid;place-items:center;font:600 30px var(--serif)}
.card__photo img{width:100%;height:100%;object-fit:cover}
.card__name{display:block;font:500 clamp(20px,6vw,26px)/1.15 var(--serif)}.card__role{display:block;margin-top:6px;font-size:13px;opacity:.9}
.card__logo{position:absolute;right:18px;top:16px;max-width:110px;max-height:34px;opacity:.9}
.card__back{transform:rotateY(180deg);background:#fff;color:var(--ink);display:grid;grid-template-columns:auto 1fr;align-items:center;gap:16px;padding:20px;text-align:left}
.card__back svg{width:120px;height:120px}.card__back strong{display:block;font:500 18px var(--serif)}.card__back p{margin:6px 0;font-size:13px;color:var(--mu)}.card__back small{font-size:12px;color:var(--a);word-break:break-all}
.hint{display:flex;align-items:center;justify-content:center;gap:6px;font-size:12.5px;color:var(--mu);margin:12px 0 0}.hint svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2}
.intro{text-align:center;font-size:15px;line-height:1.55;margin:18px 6px 0}
.primary{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:20px}
.btn{display:flex;align-items:center;justify-content:center;gap:8px;padding:13px 14px;border-radius:14px;font:600 14.5px var(--sans);text-decoration:none;border:1.5px solid var(--a);cursor:pointer}
.btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.btn--save{background:var(--a);color:#fff}.btn--share{background:transparent;color:var(--a)}
.list{list-style:none;margin:22px 0 0;padding:0;display:grid;gap:10px}
.item{display:flex;align-items:center;gap:14px;padding:13px 14px;border-radius:16px;background:#fff;text-decoration:none;border:1px solid rgba(0,0,0,.06)}
.item:hover{border-color:var(--a)}.item__icon{flex:0 0 40px;height:40px;border-radius:12px;background:var(--s);color:var(--a);display:grid;place-items:center}
.item__icon svg{width:21px;height:21px}.stroke{fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.item--wa .item__icon{background:#25D366;color:#fff}.item__text{flex:1;min-width:0;display:grid}.item__label{font-size:12px;color:var(--mu)}.item__value{font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item__go{width:18px;height:18px;fill:none;stroke:var(--mu);stroke-width:2}
.info{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:16px}.info div{background:#fff;border-radius:14px;padding:12px 14px;border:1px solid rgba(0,0,0,.06)}.info span{display:block;font-size:11.5px;color:var(--mu)}.info b{font-size:13.5px}
footer{margin-top:28px;text-align:center;font-size:12px;line-height:1.6;color:var(--mu)}footer img{max-height:28px;max-width:120px;display:block;margin:0 auto 8px;opacity:.85}
.toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:var(--d);color:#fff;padding:10px 16px;border-radius:999px;font-size:13.5px;opacity:0;transition:opacity .3s;pointer-events:none}.toast.on{opacity:1}
.photo{width:132px;height:132px;margin:8px auto 14px;border-radius:50%;overflow:hidden;border:4px solid #fff;box-shadow:0 12px 30px -14px rgba(0,0,0,.45);background:var(--s);display:grid;place-items:center;font:600 40px var(--serif);color:var(--a)}.photo img{width:100%;height:100%;object-fit:cover}
.l-title{text-align:center;font:500 26px/1.2 var(--serif);margin:0}.l-logo{display:block;max-width:220px;max-height:80px;margin:0 auto}
.tagline{text-align:center;margin:8px 0 0;font-size:13px;letter-spacing:.06em;text-transform:uppercase;color:var(--a);font-weight:600}.bio{text-align:center;margin:10px 8px 0;font-size:15px;line-height:1.55}
.links{list-style:none;margin:22px 0 0;padding:0;display:grid;gap:12px}
.link{display:flex;align-items:center;gap:14px;padding:15px 16px;border-radius:18px;background:#fff;text-decoration:none;border:1.5px solid rgba(0,0,0,.06)}
.link:hover{border-color:var(--a)}.link--hl{background:var(--a);color:#fff;border-color:var(--a)}.link--hl .link__sub{color:rgba(255,255,255,.85)}
.link__icon{flex:0 0 42px;height:42px;border-radius:12px;background:var(--s);color:var(--a);display:grid;place-items:center}.link--hl .link__icon{background:rgba(255,255,255,.18);color:#fff}
.link__icon svg{width:22px;height:22px}.link__text{flex:1;display:grid;min-width:0}.link__title{font-weight:600;font-size:15.5px}.link__sub{font-size:12.5px;color:var(--mu)}
.link__arrow{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;opacity:.7}.sec{margin:22px 4px 0;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--mu);font-weight:600}
.off{text-align:center;padding:60px 20px;color:var(--mu)}`;

const WA_ICON = raw('<svg viewBox="0 0 32 32" fill="currentColor" aria-hidden="true"><path d="M16 3a13 13 0 0 0-11.2 19.6L3 29l6.6-1.7A13 13 0 1 0 16 3zm0 23.7a10.7 10.7 0 0 1-5.5-1.5l-.4-.2-3.9 1 1-3.8-.3-.4A10.7 10.7 0 1 1 16 26.7zm5.9-8c-.3-.2-1.9-1-2.2-1-.3-.1-.5-.2-.7.2l-1 1.2c-.2.2-.4.3-.7.1a8.8 8.8 0 0 1-4.4-3.8c-.3-.6.3-.5 1-1.7.1-.2 0-.4 0-.6l-1-2.4c-.3-.6-.5-.5-.7-.5h-.6c-.2 0-.6.1-.9.4s-1.1 1.1-1.1 2.7 1.2 3.1 1.3 3.3c.2.2 2.3 3.5 5.5 4.9 2 .9 2.8 1 3.9.8.6-.1 1.9-.8 2.1-1.5.3-.7.3-1.4.2-1.5l-.7-.4z"/></svg>');
const IC = {
  phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z"/>',
  email: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 7l-10 6L2 7"/>',
  instagram: '<rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.5" cy="6.5" r=".6" fill="currentColor"/>',
  site: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/>',
  address: '<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  link: '<path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/>',
  agendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M9 15l2 2 4-4"/>',
  save: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
  share: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="M8.6 13.5l6.8 4M15.4 6.5l-6.8 4"/>',
  go: '<path d="M9 6l6 6-6 6"/>', arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>', flip: '<path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/>',
};
const svg = (k, cls = 'stroke') => raw(`<svg viewBox="0 0 24 24" class="${cls}" aria-hidden="true">${IC[k] || IC.link}</svg>`);
const initials = (n) => String(n || '').replace(/^(Dra?\.|Dr\.)\s+/i, '').split(/\s+/).filter(Boolean).map((x, i, a) => (i === 0 || i === a.length - 1 ? x[0] : '')).join('').toUpperCase();

const escA = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function shell(b, p, title0, desc0, body, path) {
  const url = `${Cards.base()}${path}`; const title = escA(title0); const desc = escA(desc0);
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title}</title><meta name="description" content="${desc}"><meta name="theme-color" content="${p.accent}"><meta name="robots" content="index, follow">
<meta property="og:title" content="${title}"><meta property="og:description" content="${desc}"><meta property="og:url" content="${url}">${b.photoUrl ? `<meta property="og:image" content="${Cards.base()}${b.photoUrl}">` : ''}
<link rel="icon" href="${Brand.icon('favicon.png')}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin><link href="${p.fonts}" rel="stylesheet">
<style>${CSS(p)}</style></head><body>${body}<div class="toast" role="status" aria-live="polite"></div><script src="/static/cartao.js?v=${VERSION}"></script></body></html>`;
}
const footer = (b, crisis) => html`<footer class="in" style="--i:9">${b.symbolUrl || b.logoUrl ? html`<img src="${b.symbolUrl || b.logoUrl}" alt="">` : ''}${b.who}${b.signLine ? ` · ${b.signLine}` : ''}${crisis ? html`<br>Em situação de crise, ligue 188 (CVV, 24 horas).` : ''}</footer>`;

// ---------- páginas públicas ----------
export const pub = router();
pub.get('/cartao', async (req, res) => {
  const b = await Brand.load(); const c = await Cards.config('cartao'); const p = palette(b);
  const title = `${c.name}${c.role ? ` · ${c.role}` : ''} | Cartão digital`;
  if (!c.enabled) return res.status(404).send(shell(b, p, title, '', String(html`<main><p class="off">Este cartão digital não está disponível.</p></main>`), '/cartao'));
  const url = `${Cards.base()}/cartao`; const qr = await Cards.qrSvg(url, p.dark);
  const ph = digits(b.whatsapp || b.phone);
  const items = [];
  if (c.show.whatsapp && ph) items.push(html`<li><a class="item item--wa" href="/wa?o=cartao&text=${encodeURIComponent(c.waText || '')}" target="_blank" rel="noopener"><span class="item__icon">${WA_ICON}</span><span class="item__text"><span class="item__label">Agendar pelo WhatsApp</span><span class="item__value">${fmtPhone(b.whatsapp || b.phone)}</span></span>${svg('go', 'item__go')}</a></li>`);
  if (c.show.phone && digits(b.phone)) items.push(html`<li><a class="item" href="/cartao/ir/telefone"><span class="item__icon">${svg('phone')}</span><span class="item__text"><span class="item__label">Ligar</span><span class="item__value">${fmtPhone(b.phone)}</span></span>${svg('go', 'item__go')}</a></li>`);
  if (c.show.email && b.email) items.push(html`<li><a class="item" href="/cartao/ir/email"><span class="item__icon">${svg('email')}</span><span class="item__text"><span class="item__label">E-mail</span><span class="item__value">${b.email}</span></span>${svg('go', 'item__go')}</a></li>`);
  if (c.show.instagram && ig(b.instagram)) items.push(html`<li><a class="item" href="/cartao/ir/instagram" target="_blank" rel="noopener"><span class="item__icon">${svg('instagram')}</span><span class="item__text"><span class="item__label">Instagram</span><span class="item__value">@${ig(b.instagram)}</span></span>${svg('go', 'item__go')}</a></li>`);
  if (c.show.site && b.siteUrl) items.push(html`<li><a class="item" href="/cartao/ir/site" target="_blank" rel="noopener"><span class="item__icon">${svg('site')}</span><span class="item__text"><span class="item__label">Site</span><span class="item__value">${b.site}</span></span>${svg('go', 'item__go')}</a></li>`);
  if (c.show.address && (b.address || b.city)) items.push(html`<li><a class="item" href="/cartao/ir/endereco" target="_blank" rel="noopener"><span class="item__icon">${svg('address')}</span><span class="item__text"><span class="item__label">Endereço</span><span class="item__value">${[b.address, b.place].filter(Boolean).join(' · ')}</span></span>${svg('go', 'item__go')}</a></li>`);
  c.extra.forEach((x, i) => items.push(html`<li><a class="item" href="/cartao/ir/extra${i}" target="_blank" rel="noopener"><span class="item__icon">${svg('link')}</span><span class="item__text"><span class="item__label">${x.label}</span><span class="item__value">${x.value || x.url.replace(/^https?:\/\//, '')}</span></span>${svg('go', 'item__go')}</a></li>`));
  const info = c.info.filter((x) => x.label && x.value);
  const body = html`<main>
    <button class="card in" style="--i:0" type="button" data-flip aria-label="Virar o cartão para ver o QR Code" aria-pressed="false"><span class="card__inner">
      <span class="card__face card__front">${b.logoDarkUrl ? html`<img class="card__logo" src="${b.logoDarkUrl}" alt="">` : ''}
        <span class="card__photo">${b.photoUrl ? html`<img src="${b.photoUrl}" alt="">` : initials(c.name)}</span>
        <span><span class="card__name">${c.name}</span><span class="card__role">${c.role}</span></span></span>
      <span class="card__face card__back">${raw(qr)}<span><strong>Compartilhe este cartão</strong><p>Aponte a câmera do celular para o código e abra o cartão.</p><small>${url.replace(/^https?:\/\//, '')}</small></span></span>
    </span></button>
    <p class="hint in" style="--i:1">${svg('flip', '')}Toque no cartão para ver o QR Code</p>
    ${c.intro ? html`<p class="intro in" style="--i:2">${c.intro}</p>` : ''}
    <div class="primary in" style="--i:3"><a class="btn btn--save" href="/cartao/contato.vcf">${svg('save', '')}Salvar contato</a><button class="btn btn--share" type="button" data-share="${url}" data-title="${c.name}">${svg('share', '')}Compartilhar</button></div>
    <ul class="list in" style="--i:4">${items}</ul>
    ${info.length ? html`<div class="info in" style="--i:5">${info.map((x) => html`<div><span>${x.label}</span><b>${x.value}</b></div>`)}</div>` : ''}
    ${footer(b, c.crisis)}</main>`;
  res.set('Cache-Control', 'public, max-age=300').send(shell(b, p, title, c.intro || `${c.name} · ${c.role}`, String(body), '/cartao'));
});
pub.get('/cartao/contato.vcf', async (req, res) => {
  const v = await Cards.vcard(); await Cards.click('cartao', 'contato').catch(() => {});
  const file = `${v.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'contato'}.vcf`;
  res.set({ 'Content-Type': 'text/vcard; charset=utf-8', 'Content-Disposition': `attachment; filename="${file}"`, 'Cache-Control': 'no-store' }).send(v.text);
});
pub.get(/^\/(cartao|links)\/qr\.(png|svg)$/, async (req, res) => {
  const url = `${Cards.base()}/${req.params[0]}`;
  if (req.params[1] === 'png') return res.set({ 'Content-Type': 'image/png', 'Content-Disposition': `attachment; filename="qrcode-${req.params[0]}.png"` }).send(await Cards.qrPng(url));
  res.type('image/svg+xml').send(await Cards.qrSvg(url));
});
// Saídas com contagem de cliques (o destino vem da configuração, nunca do endereço)
pub.get('/cartao/ir/:k', async (req, res) => {
  const b = await Brand.load(); const c = await Cards.config('cartao'); const k = req.params.k;
  const map = { telefone: digits(b.phone) && `tel:+${digits(b.phone).length <= 11 ? `55${digits(b.phone)}` : digits(b.phone)}`, email: b.email && `mailto:${b.email}`, instagram: ig(b.instagram) && `https://instagram.com/${ig(b.instagram)}`, site: b.siteUrl, endereco: (b.address || b.city) && `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([b.address, b.city, b.uf].filter(Boolean).join(', '))}` };
  const m = /^extra(\d)$/.exec(k); const dest = m ? c.extra[Number(m[1])]?.url : map[k];
  if (!dest) return res.redirect('/cartao');
  Cards.click('cartao', k).catch(() => {});
  res.set('Referrer-Policy', 'no-referrer').redirect(302, dest);
});
pub.get('/links', async (req, res) => {
  const b = await Brand.load(); const c = await Cards.config('links'); const p = palette(b);
  const title = `${c.title}${c.tagline ? ` · ${c.tagline}` : ''}`;
  if (!c.enabled) return res.status(404).send(shell(b, p, title, '', String(html`<main><p class="off">Esta página não está disponível.</p></main>`), '/links'));
  const bk = await BK.config().catch(() => ({ enabled: false }));
  let n = 4;
  const list = []; let open = [];
  const flush = () => { if (open.length) { list.push(html`<ul class="links">${open}</ul>`); open = []; } };
  c.items.forEach((x, i) => {
    if (x.kind === 'secao') { flush(); list.push(html`<p class="sec in" style="--i:${n++}">${x.title}</p>`); return; }
    if (x.kind === 'agendar' && !bk.enabled) return;
    const href = x.kind === 'whatsapp' ? `/wa?o=links&text=${encodeURIComponent(x.text || '')}` : `/links/ir/${i}`;
    const icon = x.kind === 'whatsapp' ? WA_ICON : svg(x.kind === 'site' ? 'site' : x.kind === 'instagram' ? 'instagram' : x.kind === 'agendar' ? 'agendar' : 'link');
    open.push(html`<li class="in" style="--i:${n++}"><a class="link ${x.highlight ? 'link--hl' : ''}" href="${href}" ${x.kind === 'agendar' ? '' : raw('target="_blank" rel="noopener"')}><span class="link__icon">${icon}</span><span class="link__text"><span class="link__title">${x.title}</span>${x.sub ? html`<span class="link__sub">${x.sub}</span>` : ''}</span>${svg('arrow', 'link__arrow')}</a></li>`);
  });
  flush();
  const body = html`<main>
    ${c.photo && b.photoUrl ? html`<div class="photo in" style="--i:0"><img src="${b.photoUrl}" alt="${c.title}"></div>` : ''}
    ${b.logo || b.legacy ? html`<h1 class="in" style="--i:1;margin:0"><img class="l-logo" src="${b.logoUrl}" alt="${c.title}"></h1>` : html`<h1 class="l-title in" style="--i:1">${c.title}</h1>`}
    ${c.tagline ? html`<p class="tagline in" style="--i:2">${c.tagline}</p>` : ''}
    ${c.bio ? html`<p class="bio in" style="--i:3">${c.bio}</p>` : ''}
    ${list}
    ${footer(b, c.crisis)}</main>`;
  res.set('Cache-Control', 'public, max-age=300').send(shell(b, p, title, c.bio || title, String(body), '/links'));
});
pub.get('/links/ir/:i', async (req, res) => {
  const c = await Cards.config('links'); const i = Number(req.params.i); const x = c.items[i];
  if (!x) return res.redirect('/links');
  Cards.click('links', `${i}`).catch(() => {});
  if (x.kind === 'agendar') return res.redirect(302, '/agendar');
  if (!x.url) return res.redirect('/links');
  res.set('Referrer-Policy', 'no-referrer').redirect(302, x.url);
});

// ---------- telas de edição (Marketing) ----------
export const admin = router();
const ck = (v) => (v ? raw('checked') : '');
const tabsOf = (on) => html`<nav class="tabs"><a href="/marketing">Reativação de pacientes</a><a href="/marketing/aniversarios">Aniversários</a><a href="/marketing/cartao" class="${on === 'cartao' ? 'on' : ''}">Cartão digital</a><a href="/marketing/links" class="${on === 'links' ? 'on' : ''}">Link na bio</a></nav>`;
const photoCard = (b) => html`<section class="card brand-logos"><h2>Foto</h2><p class="muted small">Aparece no cartão digital, no link na bio e no contato salvo no celular. Envie uma foto de rosto; o sistema recorta em quadrado.</p>
  <form method="post" action="/marketing/foto" class="brand-logo bl-retrato" data-logo-form data-logo-kind="retrato">
    <div class="brand-logo-prev">${b.photoUrl ? html`<img src="${b.photoUrl}" alt="Foto atual" class="mk-photo">` : html`<span class="muted small">Sem foto: aparecem as iniciais</span>`}</div>
    <label class="btn ghost btn-sm">${b.photoUrl ? 'Trocar foto' : 'Escolher foto'}<input type="file" accept="image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp" data-logo-file hidden></label>
    <p class="small" data-logo-msg role="status"></p>
    ${b.photoUrl ? html`<button class="btn ghost btn-sm danger-text" formaction="/marketing/foto/remover">Remover</button>` : ''}</form></section>`;
const shareCard = (path, label, st) => { const url = `${Cards.base()}${path}`; return html`<section class="card mk-share"><h2>${label}</h2>
  <div class="mk-share-grid"><img src="${path}/qr.svg" alt="QR code de ${url}" class="mk-qr" width="140" height="140">
    <div class="stack"><div class="copy"><input readonly value="${url}" id="mk-url-${path.slice(1)}"><button class="btn ghost" type="button" data-copy="#mk-url-${path.slice(1)}">Copiar</button></div>
      <p class="actions"><a class="btn" href="${path}" target="_blank" rel="noopener">Abrir a página</a><a class="btn ghost" href="${path}/qr.png">Baixar QR code (PNG)</a></p>
      <p class="muted small">Cliques nos últimos 30 dias: <b>${Object.values(st).reduce((a, n) => a + n, 0)}</b>${Object.keys(st).length ? ` (${Object.entries(st).slice(0, 6).map(([k, n]) => `${k}: ${n}`).join(' · ')})` : ''}</p></div></div></section>`; };

admin.get('/cartao', async (req, res) => {
  const b = await Brand.load(); const c = await Cards.config('cartao'); const st = await Cards.stats('cartao');
  const extra = [...c.extra, ...Array(Math.max(0, 3 - c.extra.length)).fill({ label: '', value: '', url: '' })].slice(0, 6);
  const SH = [['whatsapp', `WhatsApp (${fmtPhone(b.whatsapp || b.phone) || 'cadastre em Identidade da clínica'})`], ['phone', `Ligar (${fmtPhone(b.phone) || 'sem telefone'})`], ['email', `E-mail (${b.email || 'sem e-mail'})`], ['instagram', `Instagram (${b.instagram || 'sem Instagram'})`], ['site', `Site (${b.site || 'sem site'})`], ['address', `Endereço (${[b.address, b.place].filter(Boolean).join(' · ') || 'sem endereço'})`]];
  send(res, page(req, { title: 'Marketing · Cartão digital', active: 'marketing', body: html`<header class="ph"><div><p class="eyebrow">Marketing</p><h1>Cartão digital</h1>
      <p class="muted">Um cartão de visitas no celular: o paciente salva o contato, chama no WhatsApp e compartilha. Telefone, e-mail, Instagram, site e endereço vêm da <a class="link" href="/configuracoes/identidade">Identidade da clínica</a>.</p></div></header>
    ${tabsOf('cartao')}
    ${shareCard('/cartao', 'Endereço do cartão', st)}
    <form method="post" class="card form-grid">
      <label class="fld check span2"><input type="checkbox" name="enabled" value="1" ${ck(c.enabled)}><span><b>Cartão publicado</b> (desmarque para tirar do ar)</span></label>
      <label class="fld"><span>Nome no cartão</span><input name="name" maxlength="80" value="${c.name}"></label>
      <label class="fld"><span>Linha abaixo do nome</span><input name="role" maxlength="80" value="${c.role}" placeholder="Psicóloga · CRP 00/00000"></label>
      <label class="fld span2"><span>Apresentação curta</span><textarea name="intro" rows="2" maxlength="300" placeholder="Terapia Cognitivo-Comportamental com acolhimento e método. On-line e presencial.">${c.intro}</textarea></label>
      <fieldset class="span2 mk-fs"><legend>Botões do cartão</legend>${SH.map(([k, l]) => html`<label class="fld check"><input type="checkbox" name="show_${k}" value="1" ${ck(c.show[k])}><span>${l}</span></label>`)}</fieldset>
      <label class="fld span2"><span>Mensagem já escrita ao abrir o WhatsApp</span><input name="waText" maxlength="300" value="${c.waText}"></label>
      <fieldset class="span2 mk-fs"><legend>Outros links (e-book, artigo, avaliação no Google…)</legend>
        ${extra.map((x) => html`<div class="mk-row"><input name="extra_label" maxlength="40" value="${x.label}" placeholder="Rótulo (ex.: E-book)" aria-label="Rótulo"><input name="extra_value" maxlength="80" value="${x.value}" placeholder="Texto (ex.: Respire, você não está só)" aria-label="Texto"><input name="extra_url" maxlength="400" value="${x.url}" placeholder="https://…" aria-label="Endereço"></div>`)}</fieldset>
      <fieldset class="span2 mk-fs"><legend>Informações (aparecem em dois quadros)</legend>
        ${c.info.map((x) => html`<div class="mk-row two"><input name="info_label" maxlength="30" value="${x.label}" placeholder="Ex.: Sessões" aria-label="Título"><input name="info_value" maxlength="60" value="${x.value}" placeholder="Ex.: 50 minutos · TCC" aria-label="Texto"></div>`)}</fieldset>
      <label class="fld check span2"><input type="checkbox" name="crisis" value="1" ${ck(c.crisis)}><span>Mostrar no rodapé: “Em situação de crise, ligue 188 (CVV, 24 horas)”</span></label>
      <div class="span2 actions"><button class="btn">Salvar</button><a class="btn ghost" href="/cartao" target="_blank" rel="noopener">Ver como fica</a></div>
    </form>
    ${photoCard(b)}` }));
});
admin.post('/cartao', async (req, res) => { await Cards.save('cartao', req.body); await audit(req, 'marketing-cartao'); res.flash('Cartão digital salvo.').redirect('/marketing/cartao'); });

admin.get('/links', async (req, res) => {
  const b = await Brand.load(); const c = await Cards.config('links'); const st = await Cards.stats('links'); const bk = await BK.config().catch(() => ({ enabled: false }));
  const items = [...c.items, ...Array(Math.max(0, c.items.length + 2 - c.items.length)).fill({ kind: 'link', title: '', sub: '', url: '', text: '', highlight: false })].slice(0, 16);
  const KL = { whatsapp: 'WhatsApp (agendar)', agendar: 'Agendamento on-line', site: 'Site', instagram: 'Instagram', link: 'Outro link', secao: 'Título de seção' };
  send(res, page(req, { title: 'Marketing · Link na bio', active: 'marketing', body: html`<header class="ph"><div><p class="eyebrow">Marketing</p><h1>Link na bio</h1>
      <p class="muted">Uma página com seus links para colocar na bio do Instagram (e no TikTok, LinkedIn…). Os cliques no WhatsApp ficam em WhatsApp → WhatsApp do site; os outros, aqui.</p></div></header>
    ${tabsOf('links')}
    ${shareCard('/links', 'Endereço da página', st)}
    <form method="post" class="card form-grid">
      <label class="fld check span2"><input type="checkbox" name="enabled" value="1" ${ck(c.enabled)}><span><b>Página publicada</b> (desmarque para tirar do ar)</span></label>
      <label class="fld"><span>Nome ${b.logo || b.legacy ? html`<small class="muted">(a logo aparece no lugar)</small>` : ''}</span><input name="title" maxlength="80" value="${c.title}"></label>
      <label class="fld"><span>Linha de destaque</span><input name="tagline" maxlength="100" value="${c.tagline}" placeholder="Psicóloga · TCC · Goiânia"></label>
      <label class="fld span2"><span>Bio</span><textarea name="bio" rows="2" maxlength="300" placeholder="Terapia que transforma, com acolhimento e método.">${c.bio}</textarea></label>
      <label class="fld check span2"><input type="checkbox" name="photo" value="1" ${ck(c.photo)}><span>Mostrar a foto no topo</span></label>
      <fieldset class="span2 mk-fs"><legend>Botões, na ordem em que aparecem</legend>
        <p class="muted small">“WhatsApp” abre a conversa com a mensagem escrita abaixo; “Agendamento on-line” leva à página de agendar${bk.enabled ? '' : ' (hoje desligada em Configurações, então não aparece)'}; “Título de seção” separa grupos de botões. Deixe o título vazio para apagar um botão. Destaque = botão colorido.</p>
        ${items.map((x, i) => html`<div class="mk-item">
          <select name="item_kind" aria-label="Tipo do botão ${i + 1}">${Object.entries(KL).map(([k, l]) => html`<option value="${k}" ${k === x.kind ? raw('selected') : ''}>${l}</option>`)}</select>
          <input name="item_title" maxlength="60" value="${x.title}" placeholder="Título do botão" aria-label="Título">
          <input name="item_sub" maxlength="80" value="${x.sub}" placeholder="Linha de apoio (opcional)" aria-label="Linha de apoio">
          <input name="item_url" maxlength="400" value="${x.url}" placeholder="https://… (site, Instagram, outro link)" aria-label="Endereço">
          <input name="item_text" maxlength="300" value="${x.text}" placeholder="Mensagem do WhatsApp (só para o tipo WhatsApp)" aria-label="Mensagem do WhatsApp">
          <label class="check small"><input type="checkbox" name="item_highlight" value="${i}" ${ck(x.highlight)}> destaque</label></div>`)}
        <p class="muted small">Precisa de mais botões? Salve e reabra: sempre aparecem duas linhas vazias no fim (até 16).</p></fieldset>
      <label class="fld check span2"><input type="checkbox" name="crisis" value="1" ${ck(c.crisis)}><span>Mostrar no rodapé: “Em situação de crise, ligue 188 (CVV, 24 horas)”</span></label>
      <div class="span2 actions"><button class="btn">Salvar</button><a class="btn ghost" href="/links" target="_blank" rel="noopener">Ver como fica</a></div>
    </form>
    ${photoCard(b)}` }));
});
admin.post('/links', async (req, res) => { await Cards.save('links', req.body); await audit(req, 'marketing-links'); res.flash('Link na bio salvo.').redirect('/marketing/links'); });

admin.post('/foto', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '2200kb' }), async (req, res) => {
  try { await Brand.saveLogo('foto', Buffer.isBuffer(req.body) ? req.body : null, String(req.get('content-type') || '').split(';')[0]); } catch (e) { return res.status(400).json({ ok: false, error: e.message }); }
  await audit(req, 'marketing-foto'); res.json({ ok: true });
});
admin.post('/foto/remover', async (req, res) => { await Brand.removeLogo('foto'); await audit(req, 'marketing-foto-remover'); res.flash('Foto removida.').redirect(req.get('referer')?.includes('/marketing/links') ? '/marketing/links' : '/marketing/cartao'); });
