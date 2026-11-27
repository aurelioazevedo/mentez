// Site público da clínica: <nome>.bemestarmental.com.br ou o domínio próprio do site. Já roda no contexto da clínica.
import * as Tenancy from '../lib/tenancy.js';
import * as Brand from '../lib/brand.js';
import * as Billing from '../lib/billing.js';
import * as BK from '../lib/booking.js';
import * as Sites from '../lib/sites.js';
import * as R from '../lib/siterender.js';
import { esc } from '../lib/html.js';

// Endereço do sistema da clínica (onde fica a agenda on-line)
export const clinicBase = () => String(Tenancy.env('PUBLIC_URL') || `https://${Tenancy.current()?.slug}.${Tenancy.baseDomain()}`).replace(/\/+$/, '');

// Dados para montar a página (os mesmos na prévia e no site publicado)
export async function context(site, { preview = false, mediaBase = '/m' } = {}) {
  const b = Brand.get();
  const list = await Sites.mediaList();
  const bk = await BK.config().catch(() => ({ enabled: false }));
  const { wa } = await BK.siteWhatsApp(bk).catch(() => ({ wa: b.wa }));
  return {
    b, preview, wa: wa || b.wa, base: clinicBase(), bookingOn: !!bk.enabled,
    siteUrl: preview ? '' : await Sites.siteUrl(), mediaMap: new Map(list.map((m) => [m.id, m])),
    media: (id, v, aspect, w) => `${mediaBase}/${id}/${v}/${aspect}/${w}.${list.find((m) => m.id === Number(id))?.kind === 'svg' ? 'svg' : 'webp'}`,
  };
}
export function siteHeaders(res, base) {
  res.removeHeader('X-Robots-Tag');
  res.set({
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; frame-src ${base}; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    'X-Frame-Options': 'DENY',
  });
}
export async function sendMedia(req, res) {
  const id = Number(req.params.id); const w = Number(req.params.w);
  const out = await Sites.variant(id, req.params.aspect, w).catch((e) => { console.error('site imagem', e.message); return null; });
  if (!out) return res.status(404).end();
  res.set({ 'Cache-Control': 'public, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  if (out.mime === 'image/svg+xml') res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  res.type(out.mime).send(out.data);
}
const simple = (title, text, b) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title><link rel="stylesheet" href="/static/site/site.css"></head><body class="L-minimalista S-areia legal-page" style="--bg:#F7F5F0;--ink:#171717;--muted:#66625C;--accent:#8A6E45;--accent-text:#8A6E45;--line:rgba(0,0,0,.1);--serif:Georgia,serif;--sans:system-ui,sans-serif"><main class="wrap legal center"><p class="eyebrow">${esc(b.name || b.who || '')}</p><h1 class="h2">${esc(title)}</h1><p>${esc(text)}</p></main></body></html>`;

export async function handle(req, res, next) {
  try {
    await Brand.load();
    const b = Brand.get();
    const base = clinicBase();
    siteHeaders(res, base);
    const p = req.path;
    if (p === '/_mentez/saude') return res.json({ ok: true });
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
    const m = /^\/m\/(\d+)\/\d+\/(16x9|3x2|4x5|1x1|o)\/(\d+)\.(webp|svg)$/.exec(p);
    if (m) { req.params = { id: m[1], aspect: m[2], w: m[3] }; return sendMedia(req, res); }
    const mk = /^\/marca\/(logo|logo-escuro|favicon)$/.exec(p);
    if (mk) {
      const f = await Brand.logoFile({ logo: 'claro', 'logo-escuro': 'escuro', favicon: 'favicon' }[mk[1]]);
      if (!f) return res.status(404).end();
      return res.set('Cache-Control', 'public, max-age=86400').type(f.mime).send(f.buf);
    }
    const t = Tenancy.current();
    const feats = await Billing.featuresOf(t).catch(() => []);
    const site = await Sites.published();
    const live = site && Billing.has(feats, 'site');
    if (p === '/robots.txt') return res.type('text/plain').send(live ? `User-agent: *\nAllow: /\nSitemap: ${await Sites.siteUrl()}/sitemap.xml\n` : 'User-agent: *\nDisallow: /\n');
    if (p === '/sitemap.xml') {
      if (!live) return res.status(404).end();
      const u = await Sites.siteUrl(); const d = String(site.at ? new Date(site.at).toISOString() : new Date().toISOString()).slice(0, 10);
      return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${u}/</loc><lastmod>${d}</lastmod></url><url><loc>${u}/politica-de-privacidade</loc></url></urlset>`);
    }
    if (!live) return res.status(site ? 403 : 200).set('Cache-Control', 'no-store').type('html').send(simple(site ? 'Site temporariamente indisponível' : 'Site em construção', site ? 'Este site está fora do ar no momento. Para falar com o consultório, use os contatos que você já tem.' : 'Em breve, um novo site por aqui.', b));
    if (p === '/' || p === '/index.html') {
      const key = `${t.slug}:${site.at}`;
      const hit = Sites.cache.get(key);
      let out = hit && Date.now() - hit.at < 120e3 ? hit.html : null;
      if (!out) { out = R.render(site, await context(site)); Sites.cache.set(key, { html: out, at: Date.now() }); }
      return res.set('Cache-Control', 'public, max-age=60').type('html').send(out);
    }
    if (p === '/politica-de-privacidade') return res.set('Cache-Control', 'public, max-age=300').type('html').send(R.privacy(site, await context(site)));
    return res.status(404).set('Cache-Control', 'no-store').type('html').send(simple('Página não encontrada', 'O endereço digitado não existe neste site.', b).replace('</main>', '<p><a class="btn" href="/">Ir para o início</a></p></main>'));
  } catch (e) { next(e); }
}
