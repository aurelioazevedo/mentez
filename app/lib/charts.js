// Gráficos em SVG gerados no servidor (sem bibliotecas): uma série por gráfico, na cor da marca.
// Cada ponto/barra tem área de toque maior que a marca e um data-tip para a dica ao passar o mouse.
import { html, raw, esc } from './html.js';

const W = 340, H = 200, PAD = { l: 50, r: 8, t: 10, b: 26 };

function niceMax(v) {
  if (v <= 0) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
// Máximo do eixo para contagens: 4 divisões de passo inteiro (1, 2, 3, 4, 5, 6, 8 × 10ⁿ).
function intMax(v) {
  const raw = Math.max(1, v / 4); const p = 10 ** Math.floor(Math.log10(raw));
  for (const m of [1, 2, 3, 4, 5, 6, 8, 10]) if (Number.isInteger(m * p) && m * p >= raw) return m * p * 4;
  return Math.ceil(raw) * 4;
}
const brNum = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
export const fmtMoney = (n) => Number(n).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
export const fmtMoneyShort = (n) => (n >= 1000 ? `R$ ${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${brNum(n)}`);

// Rótulos do eixo x: no máximo ~8, sempre o primeiro e o último.
function xLabelIdx(n) {
  if (n <= 7) return new Set([...Array(n).keys()]);
  const step = Math.ceil(n / 6);
  const s = new Set([0, n - 1]);
  for (let i = 0; i < n - 1; i += step) s.add(i);
  return s;
}

function frame(max, fmtY) {
  const ih = H - PAD.t - PAD.b;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i; const y = PAD.t + ih - (ih * i) / 4;
    g += `<line x1="${PAD.l}" x2="${W - PAD.r}" y1="${y}" y2="${y}" class="ch-grid${i === 0 ? ' ch-base' : ''}"/>`;
    g += `<text x="${PAD.l - 8}" y="${y + 4}" text-anchor="end" class="ch-y">${esc(fmtY(v))}</text>`;
  }
  return g;
}

// Linha (ex.: receita). points: [{ label, full, value }]
export function lineChart(points, { fmt = brNum, fmtY = fmt, title = '' } = {}) {
  const n = points.length;
  const top = Math.max(...points.map((p) => p.value), 0);
  const max = fmt === brNum ? intMax(top) : niceMax(top); // contagens: eixo só com inteiros
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v) => PAD.t + ih - (ih * v) / max;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${d} L${x(n - 1).toFixed(1)},${PAD.t + ih} L${x(0).toFixed(1)},${PAD.t + ih} Z`;
  const labels = xLabelIdx(n);
  const step = n > 1 ? iw / (n - 1) : iw;
  let s = frame(max, fmtY);
  s += `<path d="${area}" class="ch-area"/><path d="${d}" class="ch-line"/>`;
  points.forEach((p, i) => {
    if (labels.has(i)) s += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="ch-x">${esc(p.label)}</text>`;
    s += `<g class="ch-hit" data-tip="${esc(`${p.full || p.label}: ${fmt(p.value)}`)}"><rect x="${(x(i) - step / 2).toFixed(1)}" y="${PAD.t}" width="${step.toFixed(1)}" height="${ih}" class="ch-target"/><line x1="${x(i)}" x2="${x(i)}" y1="${PAD.t}" y2="${PAD.t + ih}" class="ch-cross"/><circle cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="5" class="ch-dot"/></g>`;
  });
  return chartWrap(s, title, points, fmt);
}

// Barras (ex.: sessões). points: [{ label, full, value }]
export function barChart(points, { fmt = brNum, fmtY = fmt, title = '' } = {}) {
  const n = points.length;
  const top = Math.max(...points.map((p) => p.value), 0);
  const max = fmt === brNum ? intMax(top) : niceMax(top); // contagens: eixo só com inteiros
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const slot = iw / n; const bw = Math.max(4, Math.min(34, slot * 0.56));
  const labels = xLabelIdx(n);
  let s = frame(max, fmtY);
  points.forEach((p, i) => {
    const cx = PAD.l + slot * i + slot / 2; const h = (ih * p.value) / max; const top = PAD.t + ih - h;
    const r = Math.min(4, bw / 2, h);
    // topo arredondado (4 px), base reta sobre o eixo
    const path = h > 0 ? `M${cx - bw / 2},${PAD.t + ih} V${top + r} Q${cx - bw / 2},${top} ${cx - bw / 2 + r},${top} H${cx + bw / 2 - r} Q${cx + bw / 2},${top} ${cx + bw / 2},${top + r} V${PAD.t + ih} Z` : '';
    if (labels.has(i)) s += `<text x="${cx}" y="${H - 8}" text-anchor="middle" class="ch-x">${esc(p.label)}</text>`;
    s += `<g class="ch-hit" data-tip="${esc(`${p.full || p.label}: ${fmt(p.value)}`)}"><rect x="${PAD.l + slot * i}" y="${PAD.t}" width="${slot}" height="${ih}" class="ch-target"/>${path ? `<path d="${path}" class="ch-bar"/>` : ''}</g>`;
  });
  return chartWrap(s, title, points, fmt);
}

function chartWrap(svg, title, points, fmt) {
  return html`<div class="ch"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${raw(svg)}</svg><div class="ch-tip" hidden></div></div>
  <details class="ch-table"><summary>Ver dados em tabela</summary><table class="tbl small"><tbody>${points.map((p) => html`<tr><td>${p.full || p.label}</td><td class="num">${fmt(p.value)}</td></tr>`)}</tbody></table></details>`;
}
