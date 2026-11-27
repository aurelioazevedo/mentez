// Importar textos e imagens de um site existente para o rascunho do site da clínica.
// Segurança: só endereços públicos (http/https), sem IP interno, com tempo e tamanho limitados.
import dns from 'node:dns';
import net from 'node:net';
import * as Sites from './sites.js';

const PRIVATE = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^::1$/, /^f[cd]/i, /^fe80/i, /^::ffff:(10|127|192\.168|169\.254)\./i, /^::$/];
async function assertPublic(host) {
  if (/^(localhost|.*\.local|.*\.internal|db|app|caddy|evolution)$/i.test(host)) throw new Error('Endereço não permitido.');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.promises.lookup(host, { all: true }).catch(() => { throw new Error('Não encontramos este endereço na internet.'); });
  if (!addrs.length || addrs.some((a) => PRIVATE.some((re) => re.test(a.address)))) throw new Error('Endereço não permitido.');
}
async function get(url, { max = 2.5e6, accept = 'text/html' } = {}) {
  let u = new URL(url);
  for (let i = 0; i < 4; i++) {
    if (!/^https?:$/.test(u.protocol) || (u.port && !['80', '443'].includes(u.port))) throw new Error('Use um endereço http ou https.');
    await assertPublic(u.hostname);
    const r = await fetch(u, { redirect: 'manual', signal: AbortSignal.timeout(12e3), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MentezSiteImport/1.0)', Accept: accept } });
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location'), u); continue; }
    if (!r.ok) throw new Error(`O site respondeu com erro ${r.status}.`);
    const len = Number(r.headers.get('content-length') || 0); if (len > max) throw new Error('Arquivo grande demais.');
    const buf = Buffer.from(await r.arrayBuffer()); if (buf.length > max) throw new Error('Arquivo grande demais.');
    return { buf, type: r.headers.get('content-type') || '', url: u };
  }
  throw new Error('Redirecionamentos demais.');
}
const decode = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n))).replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const meta = (h, name) => decode((new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]*content=["']([^"']*)`, 'i').exec(h) || new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:name|property)=["']${name}["']`, 'i').exec(h) || [])[1]);

export async function fromUrl(input, { images = true } = {}) {
  let url = String(input || '').trim(); if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const page = await get(url);
  if (!/html/i.test(page.type)) throw new Error('O endereço não é uma página da web.');
  const found = parse(page.buf.toString('utf8'), page.url);
  const media = [];
  if (images) for (const src of found.images) {
    try { const r = await get(src, { max: 12e6, accept: 'image/*' }); const m = await Sites.upload(r.buf, `Importada de ${page.url.hostname}`); if (m.kind === 'img' && Math.min(m.w, m.h) >= 300) media.push(m.id); if (media.length >= 3) break; } catch { /* imagem que não deu para trazer */ }
  }
  return { ...found, media, host: page.url.hostname };
}

// Lê os textos e as imagens de uma página HTML
export function parse(h0, baseUrl) {
  let h = String(h0 || '');
  h = h.replace(/<(script|style|noscript|svg|nav|footer|form|iframe)[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(h) || [])[1]).slice(0, 120);
  const desc = meta(h, 'description') || meta(h, 'og:description');
  const h1 = decode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(h) || [])[1]).slice(0, 160);
  // blocos em ordem: subtítulos (h2/h3) e parágrafos
  const blocks = [...h.matchAll(/<(h[23]|p|li)[^>]*>([\s\S]*?)<\/\1>/gi)].map((m) => ({ tag: m[1].toLowerCase(), text: decode(m[2]) })).filter((b) => b.text.length > 2);
  const paras = blocks.filter((b) => b.tag === 'p' && b.text.length >= 60).map((b) => b.text.slice(0, 900));
  const items = [];
  for (let i = 0; i < blocks.length && items.length < 8; i++) {
    const b = blocks[i];
    if (b.tag === 'h3' || b.tag === 'h2') { const next = blocks[i + 1]; if (next && (next.tag === 'p' || next.tag === 'li') && b.text.length <= 70 && next.text.length >= 30) items.push({ t: b.text.slice(0, 160), d: next.text.slice(0, 400) }); }
  }
  // imagens: a de compartilhamento primeiro, depois as maiores declaradas na página
  const imgs = [];
  const og = meta(h, 'og:image'); if (og) imgs.push(og);
  for (const m of h.matchAll(/<img[^>]+>/gi)) {
    const tag = m[0]; const src = (/\s(?:data-src|src)=["']([^"']+)["']/i.exec(tag) || [])[1]; if (!src || /^data:|\.svg(\?|$)|logo|icon|sprite|pixel|avatar/i.test(src)) continue;
    const w = Number((/\swidth=["']?(\d+)/i.exec(tag) || [])[1] || 0); if (w && w < 300) continue;
    imgs.push(src);
  }
  return { title, desc, h1, paras: paras.slice(0, 12), items, images: [...new Set(imgs.map((s) => { try { return new URL(s, baseUrl).href; } catch { return null; } }).filter(Boolean))].slice(0, 5) };
}

// Aplica o que foi encontrado ao rascunho do site (mantém o resto)
export function apply(site, f) {
  const sec = (t) => site.sections.find((x) => x.type === t);
  const ini = sec('inicio'); const sobre = sec('sobre'); const ajuda = sec('ajuda');
  const done = [];
  if (f.h1 || f.title) { ini.title = (f.h1 || f.title).slice(0, 200); done.push('título da abertura'); }
  if (f.desc || f.paras[0]) { ini.text = (f.desc || f.paras[0]).slice(0, 600); done.push('texto da abertura'); }
  if (f.paras.length >= 2) { sobre.text = f.paras.slice(f.desc ? 0 : 1, 4).join('\n\n').slice(0, 3000); sobre.on = true; done.push('texto do “Sobre”'); }
  if (f.items.length >= 3) { ajuda.items = f.items.slice(0, 8); ajuda.on = true; done.push(`${f.items.length} temas em “Como posso ajudar”`); }
  if (f.media[0]) { ini.image = f.media[0]; done.push(`${f.media.length} imagem(ns)`); }
  if (f.media[1]) sobre.image = f.media[1];
  if (f.title) site.seo.title = f.title.slice(0, 70);
  if (f.desc) site.seo.description = f.desc.slice(0, 160);
  return done;
}
