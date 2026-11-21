// Folha para imprimir (ou salvar em PDF pelo navegador) de um modelo de exercício, com a identidade visual da clínica:
// logo, cor principal, nome e contato do profissional no rodapé. Campos em branco para preencher à mão.
import * as Brand from './brand.js';
import { html, raw } from './html.js';

const lines = (k) => raw(Array.from({ length: k }, () => '<div class="ln"></div>').join(''));

function field(f) {
  switch (f.type) {
    case 'info': return html`<p class="info">${f.text}</p>`;
    case 'text': return html`<div class="f"><h3>${f.label}</h3>${lines(1)}</div>`;
    case 'textarea': return html`<div class="f"><h3>${f.label}</h3>${lines(4)}</div>`;
    case 'scale': return html`<div class="f"><h3>${f.label}</h3><div class="scale"><span>${f.left}</span>${raw(Array.from({ length: 11 }, (_, i) => `<i>${i}</i>`).join(''))}<span>${f.right}</span></div></div>`;
    case 'checks': return html`<div class="f"><h3>${f.label}</h3><ul class="checks">${f.options.map((o) => html`<li><b></b>${o}</li>`)}</ul></div>`;
    case 'table': return html`<div class="f"><h3>${f.label}</h3><table><thead><tr>${f.columns.map((c) => html`<th>${c.label}</th>`)}</tr></thead>
      <tbody>${raw(Array.from({ length: f.rows }, () => `<tr>${f.columns.map(() => '<td></td>').join('')}</tr>`).join(''))}</tbody></table></div>`;
    default: return '';
  }
}

export function sheet(m, { patient = '' } = {}) {
  const b = Brand.get();
  const c1 = b.colors?.[0] || '#2b2b2b'; const c2 = b.colors?.[1] || c1;
  const contact = [b.phone, b.email, b.site, b.instagram].filter(Boolean).join(' · ');
  return html`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${m.title} · ${b.who}</title>
<style>
  @page { size: A4; margin: 16mm 15mm 18mm; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 11pt/1.45 "Helvetica Neue", Arial, sans-serif; color: #222; background: #eee; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { max-width: 190mm; margin: 12px auto; background: #fff; padding: 14mm 14mm 10mm; box-shadow: 0 2px 12px rgba(0,0,0,.12); }
  header { display: flex; justify-content: space-between; align-items: center; gap: 12px; border-bottom: 2px solid ${raw(c1)}; padding-bottom: 8px; margin-bottom: 14px; }
  header img { max-height: 46px; max-width: 200px; object-fit: contain; }
  header .w { font-weight: 700; font-size: 14pt; color: ${raw(c1)}; }
  header .who { text-align: right; font-size: 9pt; color: #555; }
  h1 { font-size: 18pt; margin: 0 0 4px; color: ${raw(c1)}; }
  .meta { display: flex; gap: 18px; font-size: 9.5pt; color: #444; margin: 8px 0 12px; }
  .meta span { flex: 1; border-bottom: 1px solid #999; padding-bottom: 2px; }
  .intro { background: color-mix(in srgb, ${raw(c2)} 10%, white); border-left: 3px solid ${raw(c2)}; padding: 8px 10px; border-radius: 4px; margin: 0 0 12px; white-space: pre-line; }
  .f { break-inside: avoid; margin: 0 0 14px; }
  .f h3 { font-size: 11pt; margin: 0 0 6px; }
  .ln { border-bottom: 1px solid #aaa; height: 24px; }
  .info { font-size: 10pt; color: #333; background: #f5f5f5; padding: 7px 10px; border-radius: 4px; }
  .scale { display: flex; align-items: center; gap: 4px; font-size: 9pt; color: #555; }
  .scale i { font-style: normal; width: 24px; height: 24px; border: 1px solid #999; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; color: #222; }
  .scale span { padding: 0 6px; }
  .checks { list-style: none; padding: 0; margin: 0; columns: 2; }
  .checks li { display: flex; gap: 8px; align-items: center; margin: 0 0 6px; break-inside: avoid; }
  .checks b { width: 13px; height: 13px; border: 1px solid #777; border-radius: 2px; flex: none; }
  table { width: 100%; border-collapse: collapse; font-size: 9pt; table-layout: fixed; }
  th { background: ${raw(c1)}; color: #fff; text-align: left; padding: 5px 6px; font-weight: 600; }
  td { border: 1px solid #bbb; height: 30px; }
  footer { margin-top: 18px; padding-top: 6px; border-top: 1px solid #ccc; font-size: 8.5pt; color: #666; display: flex; justify-content: space-between; gap: 10px; }
  .bar { max-width: 190mm; margin: 12px auto 0; display: flex; gap: 8px; justify-content: flex-end; }
  .bar button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 0; background: ${raw(c1)}; color: #fff; cursor: pointer; }
  @media print { body { background: #fff; } .page { box-shadow: none; margin: 0; padding: 0; max-width: none; } .bar { display: none; } }
</style></head><body>
<div class="bar"><button type="button" data-print>Imprimir ou salvar em PDF</button></div>
<main class="page">
  <header>${b.logoUrl ? html`<img src="${b.logoUrl}" alt="${b.short}">` : html`<span class="w">${b.short || b.name}</span>`}<div class="who"><b>${b.who}</b>${b.signLine ? html`<br>${b.signLine}` : ''}</div></header>
  <h1>${m.title}</h1>
  <div class="meta"><span>Nome: ${patient}</span><span style="flex:.45">Data:</span></div>
  ${m.intro ? html`<p class="intro">${m.intro}</p>` : ''}
  ${m.fields.map(field)}
  <footer><span>${b.who}${contact ? ` · ${contact}` : ''}</span><span>Em caso de crise: CVV 188 · SAMU 192</span></footer>
</main>
<script src="/static/app.js"></script>
</body></html>`;
}
