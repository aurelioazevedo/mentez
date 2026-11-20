// Texto formatado do prontuário (editor com negrito, itálico, sublinhado, tamanho da fonte e listas).
// O navegador envia HTML; aqui só passa uma lista curta de marcações, sem atributos (exceto o tamanho da fonte,
// convertido em classe). Todo o resto vira texto. Assim o registro nunca carrega script, link ou estilo de fora.
const KEEP = new Set(['b', 'strong', 'i', 'em', 'u', 'br', 'p', 'div', 'ul', 'ol', 'li', 'span', 'h3', 'h4']);
const VOID = new Set(['br']);
const DROP_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'noscript', 'svg', 'math', 'head', 'title', 'textarea', 'select']);
const ENTITY = /^&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/i;

const escText = (t) => String(t).replace(/&/g, (m, i, s) => (ENTITY.test(s.slice(i)) ? '&' : '&amp;')).replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Tamanho da fonte: <font size="1..7"> (execCommand) ou class="fs-N" → <span class="fs-N">
function sizeOf(attrs) {
  const m = /\bsize\s*=\s*["']?([1-7])/i.exec(attrs) || /\bclass\s*=\s*["'][^"']*\bfs-([1-7])\b/i.exec(attrs);
  return m ? m[1] : null;
}

export function sanitize(input) {
  const src = String(input || '').slice(0, 400000).replace(/<!--[\s\S]*?-->/g, '');
  const out = []; const stack = []; let skip = null;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
  let last = 0; let m;
  while ((m = re.exec(src))) {
    const text = src.slice(last, m.index); last = re.lastIndex;
    if (!skip && text) out.push(escText(text));
    const close = !!m[1]; let tag = m[2].toLowerCase(); const attrs = m[3] || '';
    if (skip) { if (close && tag === skip) skip = null; continue; }
    if (DROP_CONTENT.has(tag)) { if (!close && !/\/\s*$/.test(attrs)) skip = tag; continue; }
    let cls = '';
    if (tag === 'font' || tag === 'span') { const sz = close ? null : sizeOf(attrs); tag = 'span'; if (sz) cls = `fs-${sz}`; }
    if (tag === 'strong') tag = 'b';
    if (tag === 'em') tag = 'i';
    if (tag === 'h1' || tag === 'h2') tag = 'h3';
    if (!KEEP.has(tag)) continue;
    if (VOID.has(tag)) { if (!close) out.push('<br>'); continue; }
    if (close) {
      const at = stack.lastIndexOf(tag);
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
    } else {
      if (tag === 'span' && !cls) { stack.push('span'); out.push('<span>'); continue; }
      stack.push(tag); out.push(cls ? `<${tag} class="${cls}">` : `<${tag}>`);
    }
  }
  if (!skip) out.push(escText(src.slice(last)));
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join('').replace(/<span><\/span>|<span>([^<]*)<\/span>/g, '$1').trim();
}

// HTML → texto simples (impressão alternativa, IA, exportação)
export function toText(htmlStr) {
  return String(htmlStr || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|h3|h4|li|ul|ol)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
    .trim();
}
// Texto simples → HTML do editor (rascunho da IA, registros antigos)
export const fromText = (t) => String(t || '').split(/\n/).map((l) => `<div>${l.trim() ? esc(l) : '<br>'}</div>`).join('');
// Conteúdo de um registro já pronto para a tela (HTML seguro)
export const recordHtml = (content, format) => (format === 'html' ? sanitize(content) : fromText(content));
export const recordText = (content, format) => (format === 'html' ? toText(content) : String(content || ''));
