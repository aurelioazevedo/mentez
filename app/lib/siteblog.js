// Blog do site da clínica: posts com formatação simples (Markdown básico), publicados em /blog/<endereço>.
import { q, one } from './db.js';
import { esc } from './html.js';
import * as Sites from './sites.js';

export const list = () => q('SELECT p.id, p.slug, p.title, p.excerpt, p.cover, p.status, p.published_at, p.updated_at, u.name author FROM site_posts p LEFT JOIN users u ON u.id = p.author_id ORDER BY COALESCE(p.published_at, p.created_at) DESC');
export const published = (limit = 50) => q("SELECT p.id, p.slug, p.title, p.excerpt, p.seo, p.body, p.cover, p.published_at, p.updated_at, u.name author FROM site_posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.status = 'publicado' AND p.published_at <= NOW() ORDER BY p.published_at DESC LIMIT ?", [limit]);
export const bySlug = (slug) => one("SELECT p.*, u.name author FROM site_posts p LEFT JOIN users u ON u.id = p.author_id WHERE p.slug = ? AND p.status = 'publicado' AND p.published_at <= NOW()", [slug]);
export const byId = (id) => one('SELECT * FROM site_posts WHERE id = ?', [id]);
export const count = async () => Number((await one("SELECT COUNT(*) n FROM site_posts WHERE status = 'publicado' AND published_at <= NOW()"))?.n || 0);

export async function save(id, b, userId) {
  const title = String(b.title || '').trim().slice(0, 160);
  if (!title) throw new Error('Dê um título ao post.');
  let slug = Sites.slugify(b.slug || title).slice(0, 90);
  for (let i = 2; await one('SELECT id FROM site_posts WHERE slug = ? AND id <> ?', [slug, id || 0]); i++) slug = `${Sites.slugify(b.slug || title).slice(0, 84)}-${i}`;
  const status = b.status === 'publicado' ? 'publicado' : 'rascunho';
  const vals = [slug, title, String(b.excerpt || '').trim().slice(0, 300) || null, String(b.seo || '').trim().slice(0, 170) || null, String(b.body || '').replace(/\r/g, '').slice(0, 60000), Number(b.cover) > 0 ? Number(b.cover) : null, status];
  if (id) {
    await q("UPDATE site_posts SET slug = ?, title = ?, excerpt = ?, seo = ?, body = ?, cover = ?, status = ?, published_at = IF(? = 'publicado', COALESCE(published_at, NOW()), published_at) WHERE id = ?", [...vals, status, id]);
  } else {
    const r = await q("INSERT INTO site_posts (slug, title, excerpt, seo, body, cover, status, author_id, published_at) VALUES (?,?,?,?,?,?,?,?, IF(? = 'publicado', NOW(), NULL))", [...vals, userId || null, status]);
    id = r.insertId;
  }
  Sites.cache.clear();
  return byId(id);
}
export async function remove(id) { await q('DELETE FROM site_posts WHERE id = ?', [id]); Sites.cache.clear(); }

// Markdown básico e seguro: parágrafos, ## subtítulos, listas (- e 1.), > citação, **negrito**, *itálico*, [link](https://…)
function inline(t) {
  let s = esc(t);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*|#[^)\s]*)\)/g, (m, label, href) => `<a href="${href}"${/^https?:/.test(href) ? ' target="_blank" rel="noopener"' : ''}>${label}</a>`);
  return s;
}
export function md(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n');
  const out = []; let para = []; let list = null;
  const flush = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) { flush(); continue; }
    let m;
    if ((m = /^(#{2,4})\s+(.+)$/.exec(l))) { flush(); const lvl = Math.min(4, m[1].length + 0); out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`); continue; }
    if ((m = /^#\s+(.+)$/.exec(l))) { flush(); out.push(`<h2>${inline(m[1])}</h2>`); continue; }
    if ((m = /^>\s?(.+)$/.exec(l))) { flush(); out.push(`<blockquote><p>${inline(m[1])}</p></blockquote>`); continue; }
    if ((m = /^[-*•]\s+(.+)$/.exec(l))) { if (para.length) flush(); if (!list || list.tag !== 'ul') { flush(); list = { tag: 'ul', items: [] }; } list.items.push(m[1]); continue; }
    if ((m = /^\d+[.)]\s+(.+)$/.exec(l))) { if (para.length) flush(); if (!list || list.tag !== 'ol') { flush(); list = { tag: 'ol', items: [] }; } list.items.push(m[1]); continue; }
    if (list) flush();
    para.push(l);
  }
  flush();
  return out.join('\n');
}
export const readingMinutes = (text) => Math.max(1, Math.round(String(text || '').split(/\s+/).filter(Boolean).length / 200));
