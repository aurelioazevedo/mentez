// Componentes visuais do BI (HTML + SVG gerados no servidor, sem bibliotecas).
// Texto sempre em HTML (nítido no celular); dica ao passar o mouse/tocar via [data-tip]; tabela de dados em cada gráfico.
import { html, raw } from './html.js';

export const brl = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
export const brl2 = (v) => Number(v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const int = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 });
export const dec1 = (v) => Number(v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 1 });
export const pc = (v) => (v == null ? '—' : `${(v * 100).toLocaleString('pt-BR', { maximumFractionDigits: v < 0.1 && v > 0 ? 1 : 0 })}%`);
export const moneyShort = (v) => (Math.abs(v) >= 1000 ? `R$ ${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil` : `R$ ${int(v)}`);

export function niceMax(v) {
  if (!(v > 0)) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
function intMax(v) { if (!(v > 0)) return 4; let s = Math.ceil(v / 4); const p = 10 ** Math.floor(Math.log10(s)); for (const m of [1, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= s && Number.isInteger(m * p)) { s = m * p; break; } return s * 4; }
const xIdx = (n) => { if (n <= 8) return new Set([...Array(n).keys()]); const step = Math.ceil(n / 7); const s = new Set([0, n - 1]); for (let i = step; i < n - step / 2; i += step) s.add(i); return s; };
const tableOf = (head, rows) => html`<details class="bi-data"><summary>Ver dados em tabela</summary><div class="bi-tblwrap"><table class="tbl small"><thead><tr>${head.map((h, i) => html`<th class="${i ? 'num' : ''}">${h}</th>`)}</tr></thead><tbody>${rows.map((r) => html`<tr>${r.map((c, i) => html`<td class="${i ? 'num' : ''}">${c}</td>`)}</tr>`)}</tbody></table></div></details>`;
const yAxis = (max, fmt) => html`<div class="bi-grid">${[4, 3, 2, 1, 0].map((i) => html`<div class="bi-gl" style="bottom:${i * 25}%"><span>${fmt((max / 4) * i)}</span></div>`)}</div>`;

// ---------- cartão de indicador ----------
// delta: variação vs período anterior; up = "bom quando sobe"
export function kpi({ label, value, prev = null, fmtDelta = 'rel', good = 'up', hint = '', href = null, spark = null, sub = '' }) {
  let delta = '';
  if (prev && prev.show) {
    const a = prev.cur, b = prev.prev;
    let d = null; let txt = '';
    if (fmtDelta === 'pp' && a != null && b != null) { d = a - b; txt = `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.`; }
    else if (b) { d = (a - b) / Math.abs(b); txt = `${d >= 0 ? '+' : '−'}${Math.abs(d * 100).toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%`; }
    // base pequena demais (ex.: +41.700%): mostra o valor anterior em vez de uma variação sem sentido
    if (fmtDelta !== 'pp' && ((d != null && Math.abs(d) > 5) || (a && !b))) return kpiNoBase({ label, value, hint, href, spark, sub, prevTxt: prev.prevTxt });
    if (d != null && Math.abs(d) > 0.0005) {
      const isGood = good === 'neutral' ? null : (good === 'up') === (d > 0);
      delta = html`<span class="bi-delta ${isGood == null ? '' : isGood ? 'good' : 'bad'}" title="Período anterior: ${prev.prevTxt}"><b aria-hidden="true">${d > 0 ? '▲' : '▼'}</b> ${txt}<small> vs anterior</small></span>`;
    } else if (d != null) delta = html`<span class="bi-delta" title="Período anterior: ${prev.prevTxt}">= igual ao anterior</span>`;
  }
  const body = html`<span class="bi-kl">${label}</span><span class="bi-kv">${value}</span>${sub ? html`<span class="bi-ks">${sub}</span>` : ''}${delta}${spark ? sparkline(spark) : ''}${hint ? html`<span class="bi-kh">${hint}</span>` : ''}`;
  return href ? html`<a class="bi-kpi" href="${href}">${body}</a>` : html`<div class="bi-kpi">${body}</div>`;
}
function kpiNoBase({ label, value, hint, href, spark, sub, prevTxt }) {
  const body = html`<span class="bi-kl">${label}</span><span class="bi-kv">${value}</span>${sub ? html`<span class="bi-ks">${sub}</span>` : ''}<span class="bi-delta" title="Período anterior: ${prevTxt}">período anterior: ${prevTxt}</span>${spark ? sparkline(spark) : ''}${hint ? html`<span class="bi-kh">${hint}</span>` : ''}`;
  return href ? html`<a class="bi-kpi" href="${href}">${body}</a>` : html`<div class="bi-kpi">${body}</div>`;
}
export function sparkline(vals) {
  if (!vals || vals.length < 2) return '';
  const max = Math.max(...vals, 0) || 1; const n = vals.length;
  const pts = vals.map((v, i) => `${((i / (n - 1)) * 100).toFixed(2)},${(28 - (v / max) * 26).toFixed(2)}`).join(' ');
  return html`<svg class="bi-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------- legenda ----------
export const legend = (items) => html`<ul class="bi-legend">${items.map((it) => html`<li><i class="${it.cls}" style="${it.style || ''}"></i>${it.name}</li>`)}</ul>`;

// ---------- barras empilhadas (ex.: sessões por status) ----------
// rows: [{ label, full, href, [key]: n }], series: [{ key, name, cls }] (de baixo para cima)
export function stacked(rows, series, { fmt = int, title = '', unit = '' } = {}) {
  const totals = rows.map((r) => series.reduce((a, s) => a + (r[s.key] || 0), 0));
  const max = intMax(Math.max(...totals, 0));
  const lab = xIdx(rows.length);
  return html`<figure class="bi-chart" aria-label="${title}">
    ${legend(series.map((s) => ({ cls: `bi-sw ${s.cls}`, name: s.name })))}
    <div class="bi-plot">${yAxis(max, fmt)}
      <div class="bi-cols" style="--n:${rows.length}">${rows.map((r, i) => {
        const tip = `${r.full || r.label}\n${series.map((s) => `${s.name}: ${fmt(r[s.key] || 0)}${unit}`).join('\n')}`;
        const inner = html`<span class="bi-stack" style="height:${((totals[i] / max) * 100).toFixed(2)}%">${series.slice().reverse().map((s) => (r[s.key] ? html`<i class="${s.cls}" style="flex:${r[s.key]}"></i>` : ''))}</span>`;
        return r.href ? html`<a class="bi-col" href="${r.href}" data-tip="${tip}" aria-label="${tip}">${inner}</a>` : html`<span class="bi-col" data-tip="${tip}" tabindex="0">${inner}</span>`;
      })}</div></div>
    <div class="bi-xl" style="--n:${rows.length}">${rows.map((r, i) => html`<span>${lab.has(i) ? r.label : ''}</span>`)}</div>
    ${tableOf(['Período', ...series.map((s) => s.name), 'Total'], rows.map((r, i) => [r.full || r.label, ...series.map((s) => fmt(r[s.key] || 0)), fmt(totals[i])]))}
  </figure>`;
}

// ---------- linha: período atual × anterior ----------
// cur/prev: [{ label, full, value }] (prev opcional, alinhado por posição)
export function lineCompare(cur, prev, { fmt = int, fmtAxis = fmt, title = '', curName = 'Período atual', prevName = 'Período anterior' } = {}) {
  const n = cur.length;
  const max = niceMax(Math.max(...cur.map((p) => p.value), ...(prev || []).map((p) => p.value), 0));
  const X = (i) => (n === 1 ? 50 : (i / (n - 1)) * 100); const Y = (v) => 100 - (v / max) * 100;
  const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${X(i).toFixed(2)},${Y(p.value).toFixed(2)}`).join(' ');
  const p2 = prev ? prev.slice(0, n) : null;
  const lab = xIdx(n);
  const area = `${path(cur)} L${X(n - 1).toFixed(2)},100 L${X(0).toFixed(2)},100 Z`;
  return html`<figure class="bi-chart" aria-label="${title}">
    ${p2 ? legend([{ cls: 'bi-ln cur', name: curName }, { cls: 'bi-ln prev', name: prevName }]) : ''}
    <div class="bi-plot">${yAxis(max, fmtAxis)}
      <svg class="bi-line" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <path d="${area}" class="bi-area"/>${p2 && p2.length > 1 ? html`<path d="${path(p2)}" class="bi-prev" vector-effect="non-scaling-stroke"/>` : ''}<path d="${path(cur)}" class="bi-cur" vector-effect="non-scaling-stroke"/></svg>
      <div class="bi-hits" style="--n:${n}">${cur.map((p, i) => {
        const tip = `${p.full || p.label}: ${fmt(p.value)}${p2 && p2[i] ? `\n${prevName}${p2[i].full ? ` (${p2[i].full})` : ''}: ${fmt(p2[i].value)}` : ''}`;
        const w = n === 1 ? 100 : 100 / (n - 1);
        return html`<span class="bi-hit" data-tip="${tip}" tabindex="0" style="left:${Math.max(0, X(i) - w / 2).toFixed(2)}%;width:${(Math.min(100, X(i) + w / 2) - Math.max(0, X(i) - w / 2)).toFixed(2)}%"><i class="bi-dot" style="left:${(((X(i) - Math.max(0, X(i) - w / 2)) / (Math.min(100, X(i) + w / 2) - Math.max(0, X(i) - w / 2))) * 100).toFixed(2)}%;top:${Y(p.value).toFixed(2)}%"></i><i class="bi-cross" style="left:${(((X(i) - Math.max(0, X(i) - w / 2)) / (Math.min(100, X(i) + w / 2) - Math.max(0, X(i) - w / 2))) * 100).toFixed(2)}%"></i></span>`;
      })}</div></div>
    <div class="bi-xl line" style="--n:${n}">${cur.map((p, i) => html`<span style="left:${X(i).toFixed(2)}%">${lab.has(i) ? p.label : ''}</span>`)}</div>
    ${tableOf(['Período', curName, ...(p2 ? [prevName] : [])], cur.map((p, i) => [p.full || p.label, fmt(p.value), ...(p2 ? [p2[i] ? fmt(p2[i].value) : '—'] : [])]))}
  </figure>`;
}

// ---------- barras horizontais (ranking / composição) ----------
// rows: [{ label, value, sub, href, cls }]
export function hbars(rows, { fmt = int, total = null, empty = 'Sem dados no período.', share = true } = {}) {
  if (!rows.length || !rows.some((r) => r.value)) return html`<p class="muted small">${empty}</p>`;
  const max = Math.max(...rows.map((r) => r.value), 0) || 1;
  const sum = total ?? rows.reduce((a, r) => a + r.value, 0);
  return html`<ul class="bi-hbars">${rows.map((r) => {
    const bar = html`<span class="bi-hl">${r.label}${r.sub ? html` <small>${r.sub}</small>` : ''}</span><span class="bi-hv">${fmt(r.value)}${share && sum ? html`<small> · ${pc(r.value / sum)}</small>` : ''}</span><span class="bi-ht"><i class="${r.cls || 'bi-s1'}" style="width:${((r.value / max) * 100).toFixed(2)}%"></i></span>`;
    return html`<li>${r.href ? html`<a href="${r.href}">${bar}</a>` : bar}</li>`;
  })}</ul>`;
}

// ---------- composição (barra 100%) ----------
export function composition(parts, { fmt = int } = {}) {
  const tot = parts.reduce((a, p) => a + p.value, 0);
  if (!tot) return html`<p class="muted small">Sem dados no período.</p>`;
  return html`<div class="bi-comp">${parts.filter((p) => p.value).map((p) => html`<i class="${p.cls}" style="flex:${p.value}" data-tip="${p.name}: ${fmt(p.value)} (${pc(p.value / tot)})" tabindex="0"></i>`)}</div>
    <ul class="bi-legend">${parts.map((p) => html`<li><i class="bi-sw ${p.cls}"></i>${p.name} <b>${fmt(p.value)}</b> <small>${pc(p.value / tot)}</small></li>`)}</ul>`;
}

// ---------- mapa de calor ----------
// cells: [{ wd, h, v, tip }] · cores: escala de uma cor (mais escuro = mais)
const WDS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
export function heatmap(cells, { fmt = int, title = '' } = {}) {
  if (!cells.length) return html`<p class="muted small">Sem sessões no período.</p>`;
  const hours = cells.map((c) => c.h); const h0 = Math.min(...hours); const h1 = Math.max(...hours);
  const days = [1, 2, 3, 4, 5, 6, 0].filter((d) => d !== 0 || cells.some((c) => c.wd === 0)).filter((d) => d !== 6 || cells.some((c) => c.wd === 6));
  const max = Math.max(...cells.map((c) => c.v), 1);
  const at = (d, h) => cells.find((c) => c.wd === d && c.h === h);
  const step = (v) => (v <= 0 ? 0 : Math.min(5, Math.ceil((v / max) * 5)));
  const cols = h1 - h0 + 1;
  return html`<figure class="bi-chart" aria-label="${title}"><div class="bi-heat" style="--cols:${cols}">
    <span></span>${[...Array(cols).keys()].map((i) => html`<span class="bi-hh">${String(h0 + i).padStart(2, '0')}h</span>`)}
    ${days.map((d) => html`<span class="bi-hd">${WDS[d]}</span>${[...Array(cols).keys()].map((i) => { const c = at(d, h0 + i); return html`<span class="bi-hc q${step(c?.v || 0)}" data-tip="${WDS[d]} ${String(h0 + i).padStart(2, '0')}h — ${c ? c.tip : 'nenhuma sessão'}" tabindex="0">${c?.v ? fmt(c.v) : ''}</span>`; })}`)}
  </div><div class="bi-scale"><span>menos</span>${[1, 2, 3, 4, 5].map((q) => html`<i class="bi-hc q${q}"></i>`)}<span>mais</span></div>
  ${tableOf(['Dia e hora', 'Valor', 'Detalhe'], cells.slice().sort((a, b) => (a.wd - b.wd) || (a.h - b.h)).map((c) => [`${WDS[c.wd]} ${String(c.h).padStart(2, '0')}h`, fmt(c.v), c.tip]))}</figure>`;
}

// ---------- funil ----------
export function funnel(steps) {
  const top = steps[0]?.value || 0;
  if (!top) return html`<p class="muted small">Sem dados no período.</p>`;
  return html`<ol class="bi-funnel">${steps.map((s, i) => html`<li><span class="bi-fl">${s.label}</span><span class="bi-ft"><i style="width:${((s.value / top) * 100).toFixed(2)}%"></i></span>
    <span class="bi-fv">${int(s.value)}${i ? html`<small>${pc(steps[i - 1].value ? s.value / steps[i - 1].value : null)} da etapa anterior</small>` : ''}</span></li>`)}</ol>`;
}

// ---------- coortes de retenção ----------
export function cohortTable(rows, monthLabel) {
  const valid = rows.filter((r) => r.size);
  if (!valid.length) return html`<p class="muted small">Ainda não há pacientes suficientes para medir a retenção.</p>`;
  const H = rows[0]?.cells.length || 0;
  const q = (v) => (v == null ? 'na' : `q${Math.max(0, Math.min(5, Math.ceil(v * 5)))}`);
  return html`<div class="bi-tblwrap"><table class="tbl small bi-cohort"><thead><tr><th>Começou em</th><th class="num">Pacientes</th>${[...Array(H).keys()].map((k) => html`<th class="num">+${k + 1} ${k ? 'meses' : 'mês'}</th>`)}</tr></thead>
    <tbody>${valid.map((r) => html`<tr><td>${monthLabel(r.ym)}</td><td class="num">${r.size}</td>${r.cells.map((v, k) => html`<td class="num bi-hc ${q(v)}" data-tip="${monthLabel(r.ym)}: ${v == null ? 'mês ainda não chegou' : `${pc(v)} continuavam em atendimento ${k + 1} mês(es) depois`}" tabindex="0">${v == null ? '' : pc(v)}</td>`)}</tr>`)}</tbody></table></div>`;
}

// ---------- cartão de seção ----------
export const panel = (title, body, { sub = '', id = '', wide = false, actions = '' } = {}) => html`<section class="card bi-panel ${wide ? 'wide' : ''}" ${id ? raw(`id="${id}"`) : ''}><header class="bi-ph"><div><h2>${title}</h2>${sub ? html`<p class="muted small">${sub}</p>` : ''}</div>${actions}</header>${body}</section>`;
