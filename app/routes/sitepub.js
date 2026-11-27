// Site público da clínica: <nome>.bemestarmental.com.br ou o domínio próprio do site. Já roda no contexto da clínica.
import * as Tenancy from '../lib/tenancy.js';
import * as Brand from '../lib/brand.js';
import * as Billing from '../lib/billing.js';
import * as BK from '../lib/booking.js';
import * as Sites from '../lib/sites.js';
import * as R from '../lib/siterender.js';
import express from 'express';
import { esc } from '../lib/html.js';
import * as Lead from '../lib/sitelead.js';
import * as Blog from '../lib/siteblog.js';
import * as WA from '../lib/whatsapp.js';

const formParser = express.urlencoded({ extended: false, limit: '20kb', parameterLimit: 40 });
const textParser = express.text({ type: () => true, limit: '2kb' });
const ipOf = (req) => String(req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();

// Endereço do sistema da clínica (onde fica a agenda on-line)
export const clinicBase = () => String(Tenancy.env('PUBLIC_URL') || `https://${Tenancy.current()?.slug}.${Tenancy.baseDomain()}`).replace(/\/+$/, '');

// Dados para montar a página (os mesmos na prévia e no site publicado)
export async function context(site, { preview = false, mediaBase = '/m', path = '', form = null } = {}) {
  const b = Brand.get();
  const list = await Sites.mediaList();
  const bk = await BK.config().catch(() => ({ enabled: false }));
  const { wa } = await BK.siteWhatsApp(bk).catch(() => ({ wa: b.wa }));
  return {
    b, preview, path, form, wa: wa || b.wa, base: clinicBase(), bookingOn: !!bk.enabled, blogCount: await Blog.count().catch(() => 0),
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
    // contagem de visitas e cliques (sem cookies)
    if (p === '/v' && req.method === 'POST') {
      await new Promise((ok) => textParser(req, res, ok));
      if (Lead.isBot(req.get('user-agent')) || !Lead.allow(ipOf(req), 'v', 120, 60e3)) return res.status(204).end();
      let d = {}; try { d = JSON.parse(String(req.body || '{}')); } catch { /* inválido */ }
      const path = String(d.p || '').slice(0, 76); const ab = d.ab === 'a' || d.ab === 'b' ? `#${d.ab}` : '';
      if ((path === '' || Sites.pathOk(path) || /^blog(\/[a-z0-9-]{1,90})?$/.test(path)) && Lead.KINDS[d.k]) await Lead.stat(path + ab, d.s, d.k).catch(() => {});
      return res.status(204).end();
    }
    // formulário de contato → CRM
    if (p === '/f' && req.method === 'POST') {
      await new Promise((ok) => formParser(req, res, ok));
      const bd = req.body || {};
      const path = Sites.pathOk(String(bd.p || '')) ? String(bd.p) : '';
      const back = (q) => res.redirect(303, `/${path}?${q}#form`);
      const host = String(req.hostname || '');
      const origin = String(req.get('origin') || req.get('referer') || '');
      if (origin && !origin.replace(/^https?:\/\//, '').startsWith(host)) return res.status(403).end();
      if (bd.website) return back('enviado=1'); // robô (campo escondido preenchido)
      if (!Lead.allow(ipOf(req), 'f', 6, 10 * 60e3)) return back('erro=limite');
      if (!bd.lgpd) return back('erro=lgpd');
      const page = await Sites.published(path);
      if (!page) return res.status(404).end();
      try {
        const pageName = page.name || page.seo?.title || '';
        const formSec = page.sections.find((x) => x.type === 'form' && x.on);
        const evt = page.sections.find((x) => x.type === 'evento' && x.on);
        const file = formSec?.file ? await Sites.fileInfo(formSec.file) : null;
        const amt = evt?.pix ? Lead.amountOf(evt.amount) : 0;
        const extra = [file ? `Material enviado: ${file.name}` : '', amt ? `Inscrição: aguardando Pix de R$ ${amt.toFixed(2).replace('.', ',')}` : ''];
        const card = await Lead.lead({ path, ab: bd.ab === 'a' || bd.ab === 'b' ? bd.ab : '', pageName, nome: bd.nome, whatsapp: bd.whatsapp, email: bd.email, mensagem: bd.mensagem, src: bd.src, cmp: bd.cmp, extra });
        const phone = WA.normalizePhone(bd.whatsapp); const first = String(bd.nome || '').trim().split(/\s+/)[0];
        const site0 = await Sites.siteUrl();
        if (file) await Lead.whatsapp(phone, `Olá, ${first}! Aqui está o material${pageName ? ` “${pageName}”` : ''}: ${site0}/d/${file.token}`);
        let extraQ = '';
        if (amt) {
          const px = await Lead.pixFor(amt, `INS${card.id}`, pageName);
          if (px) { extraQ = `&c=${card.id}`; await Lead.whatsapp(phone, `Olá, ${first}! Recebemos sua inscrição${pageName ? ` em “${pageName}”` : ''}. Para confirmar a vaga, pague R$ ${amt.toFixed(2).replace('.', ',')} pelo Pix copia e cola abaixo:\n\n${px.code}`); }
        }
        return back(`enviado=1${extraQ}`);
      } catch (e) { return back(`erro=${encodeURIComponent(e.message.slice(0, 120))}`); }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.status(405).end();
    const m = /^\/m\/(\d+)\/\d+\/(16x9|3x2|4x5|1x1|o)\/(\d+)\.(webp|svg)$/.exec(p);
    if (m) { req.params = { id: m[1], aspect: m[2], w: m[3] }; return sendMedia(req, res); }
    const dl = /^\/d\/([A-Za-z0-9_-]{24})$/.exec(p);
    if (dl) {
      const f = await Sites.fileByToken(dl[1]); if (!f) return res.status(404).type('text/plain').send('Material não encontrado.');
      res.set({ 'Content-Disposition': `inline; filename="${encodeURIComponent(f.name)}"`, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
      return res.type('application/pdf').send(f.data);
    }
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
      const lps = (await Sites.landings()).filter((x) => x.live);
      const posts = await Blog.published(500);
      return res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${u}/</loc><lastmod>${d}</lastmod></url>${lps.map((x) => `<url><loc>${u}/${x.path}</loc></url>`).join('')}${posts.length ? `<url><loc>${u}/blog</loc></url>` : ''}${posts.map((x) => `<url><loc>${u}/blog/${x.slug}</loc><lastmod>${new Date(x.updated_at).toISOString().slice(0, 10)}</lastmod></url>`).join('')}<url><loc>${u}/politica-de-privacidade</loc></url></urlset>`);
    }
    if (!live) return res.status(site ? 403 : 200).set('Cache-Control', 'no-store').type('html').send(simple(site ? 'Site temporariamente indisponível' : 'Site em construção', site ? 'Este site está fora do ar no momento. Para falar com o consultório, use os contatos que você já tem.' : 'Em breve, um novo site por aqui.', b));
    // blog
    const bm = /^\/blog(?:\/([a-z0-9-]{1,90}))?\/?$/.exec(p);
    if (bm) {
      const ctx = await context(site, { path: '' });
      if (!bm[1]) {
        const posts = await Blog.published(60);
        ctx.page = { blog: true, path: 'blog', title: `Blog · ${b.who || b.name}`, desc: `Artigos sobre saúde mental e emoções, por ${b.who || b.name}.`, main: R.blogIndex(posts, ctx, Blog.md) };
        return res.set('Cache-Control', 'public, max-age=60').type('html').send(R.render(site, ctx));
      }
      const post = await Blog.bySlug(bm[1]);
      if (!post) return res.status(404).set('Cache-Control', 'no-store').type('html').send(simple('Artigo não encontrado', 'Este artigo não existe ou saiu do ar.', b).replace('</main>', '<p><a class="btn" href="/blog">Ver todos os artigos</a></p></main>'));
      const related = (await Blog.published(4)).filter((x) => x.id !== post.id).slice(0, 3);
      const cm = post.cover && ctx.mediaMap.get(Number(post.cover));
      const share = cm && cm.kind === 'img' ? `${ctx.siteUrl}${ctx.media(cm.id, cm.v, '16x9', 1600)}` : '';
      ctx.page = { blog: true, type: 'article', path: `blog/${post.slug}`, title: `${post.title} · ${b.who || b.name}`, desc: post.seo || post.excerpt || '', share,
        ld: { '@context': 'https://schema.org', '@type': 'BlogPosting', headline: post.title, description: post.seo || post.excerpt || undefined, image: share || undefined, datePublished: new Date(post.published_at).toISOString(), dateModified: new Date(post.updated_at).toISOString(), author: { '@type': 'Person', name: post.author || b.who || b.name }, publisher: { '@type': 'Organization', name: b.name || b.who }, mainEntityOfPage: `${ctx.siteUrl}/blog/${post.slug}` },
        main: R.blogPost(post, related, ctx, Blog.md) };
      return res.set('Cache-Control', 'public, max-age=60').type('html').send(R.render(site, ctx));
    }
    // formulário: depois de enviar (ou com erro), a página volta sem cache, com o aviso
    const formState = req.query.enviado ? { sent: true } : req.query.erro ? { error: req.query.erro === 'lgpd' ? 'Para enviar, marque que concorda com a Política de privacidade.' : req.query.erro === 'limite' ? 'Muitos envios seguidos. Aguarde alguns minutos ou fale pelo WhatsApp.' : String(req.query.erro).slice(0, 140) } : null;
    const lp = /^\/([a-z0-9-]{1,60})\/?$/.exec(p);
    if (p === '/' || p === '/index.html' || (lp && Sites.pathOk(lp[1]))) {
      const path = p === '/' || p === '/index.html' ? '' : lp[1];
      const pg = path ? await Sites.published(path) : site;
      if (pg && formState?.sent) {
        const formSec = pg.sections.find((x) => x.type === 'form' && x.on); const evt = pg.sections.find((x) => x.type === 'evento' && x.on);
        const file = formSec?.file ? await Sites.fileInfo(formSec.file) : null;
        if (file) formState.file = { token: file.token, name: file.name };
        const amt = evt?.pix ? Lead.amountOf(evt.amount) : 0; const cid = Number(req.query.c);
        if (amt && cid > 0) formState.pix = await Lead.pixFor(amt, `INS${cid}`, pg.name || '');
      }
      if (!pg) return res.status(404).set('Cache-Control', 'no-store').type('html').send(simple('Página não encontrada', 'O endereço digitado não existe neste site.', b).replace('</main>', '<p><a class="btn" href="/">Ir para o início</a></p></main>'));
      if (formState) return res.set('Cache-Control', 'no-store').type('html').send(R.render(pg, await context(pg, { path, form: formState })));
      const key = `${t.slug}:${path}:${pg.at}`;
      const hit = Sites.cache.get(key);
      let out = hit && Date.now() - hit.at < 120e3 ? hit.html : null;
      if (!out) { out = R.render(pg, await context(pg, { path })); Sites.cache.set(key, { html: out, at: Date.now() }); }
      return res.set('Cache-Control', 'public, max-age=60').type('html').send(out);
    }
    if (p === '/politica-de-privacidade') return res.set('Cache-Control', 'public, max-age=300').type('html').send(R.privacy(site, await context(site)));
    return res.status(404).set('Cache-Control', 'no-store').type('html').send(simple('Página não encontrada', 'O endereço digitado não existe neste site.', b).replace('</main>', '<p><a class="btn" href="/">Ir para o início</a></p></main>'));
  } catch (e) { next(e); }
}
