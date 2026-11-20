import { html, raw, esc } from './html.js';

const clip = (v, n) => String(v ?? '').slice(0, n).trim();
const MAX_ROWS = 31;

// ---------- formulário editável (portal do paciente) ----------
function scaleInput(name, value, left, right) {
  const v = value === undefined || value === '' ? '' : Number(value);
  return html`<div class="scale" role="radiogroup">
    <span class="scale-end">${left}</span>
    ${Array.from({ length: 11 }, (_, i) => html`<label><input type="radio" name="${name}" value="${i}" ${v === i ? raw('checked') : ''}><span>${i}</span></label>`)}
    <span class="scale-end">${right}</span>
  </div>`;
}

export function renderForm(schema, data = {}) {
  return schema.map((f) => {
    const name = `f[${f.name}]`;
    const val = data[f.name];
    switch (f.type) {
      case 'info':
        return html`<p class="form-info">${f.text}</p>`;
      case 'text':
        return html`<label class="fld"><span>${f.label}</span><input type="text" name="${name}" value="${val || ''}" maxlength="2000"></label>`;
      case 'textarea':
        return html`<label class="fld"><span>${f.label}</span><textarea name="${name}" rows="4" maxlength="8000">${val || ''}</textarea></label>`;
      case 'scale':
        return html`<fieldset class="fld"><legend>${f.label}</legend>${scaleInput(name, val, f.left, f.right)}</fieldset>`;
      case 'checks':
        return html`<fieldset class="fld"><legend>${f.label}</legend><div class="checks">${f.options.map((o) => html`<label><input type="checkbox" name="${name}[]" value="${o}" ${(val || []).includes(o) ? raw('checked') : ''}><span>${o}</span></label>`)}</div></fieldset>`;
      case 'table': {
        const rows = Array.isArray(val) && val.length ? val : [];
        const n = Math.max(f.rows, rows.length);
        return html`<fieldset class="fld"><legend>${f.label}</legend>
          <div class="rows" data-table="${f.name}">
          ${Array.from({ length: n }, (_, i) => html`<div class="row-card"><span class="row-n">${i + 1}</span>
            ${f.columns.map((c) => html`<label><span>${c.label}</span>${c.type === 'number'
              ? html`<input type="number" inputmode="decimal" step="any" name="f[${f.name}][${i}][${c.name}]" value="${rows[i]?.[c.name] ?? ''}">`
              : c.type === 'date'
                ? html`<input type="date" name="f[${f.name}][${i}][${c.name}]" value="${rows[i]?.[c.name] ?? ''}">`
                : html`<textarea rows="2" name="f[${f.name}][${i}][${c.name}]" maxlength="2000">${rows[i]?.[c.name] ?? ''}</textarea>`}</label>`)}
          </div>`)}
          </div>
          <button type="button" class="btn ghost add-row" data-max="${MAX_ROWS}">+ Adicionar linha</button>
        </fieldset>`;
      }
      default:
        return '';
    }
  });
}

export function parseForm(schema, body) {
  const src = (body && body.f) || {};
  const out = {};
  for (const f of schema) {
    const v = src[f.name];
    if (f.type === 'text') out[f.name] = clip(v, 2000);
    else if (f.type === 'textarea') out[f.name] = clip(v, 8000);
    else if (f.type === 'scale') {
      const n = Number(v);
      out[f.name] = v !== undefined && v !== '' && n >= 0 && n <= 10 ? Math.round(n) : '';
    } else if (f.type === 'checks') {
      const arr = Array.isArray(v) ? v : v ? [v] : [];
      out[f.name] = arr.filter((x) => f.options.includes(x));
    } else if (f.type === 'table') {
      const rows = Array.isArray(v) ? v : v && typeof v === 'object' ? Object.keys(v).sort((a, b) => a - b).map((k) => v[k]) : [];
      out[f.name] = rows.slice(0, MAX_ROWS).map((r) => {
        const row = {};
        for (const c of f.columns) row[c.name] = clip(r?.[c.name], 2000);
        return row;
      }).filter((r) => Object.values(r).some((x) => x !== ''));
    }
  }
  return out;
}

// ---------- gráficos SVG ----------
const PAL = ['#9c4422', '#3a3a1f', '#b7865a', '#634331', '#7d8a5a', '#c9a27e'];
const num = (v) => { const n = Number(String(v).replace(',', '.')); return Number.isFinite(n) ? n : null; };
const short = (s, n = 10) => { s = String(s || ''); if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s.slice(8, 10)}/${s.slice(5, 7)}`; return s.length > n ? s.slice(0, n - 1) + '…' : s; };

function lineChart(rows, chart, columns) {
  const pts = rows.filter((r) => chart.y.some((k) => num(r[k]) !== null));
  if (pts.length < 1) return '';
  const W = 640, H = 260, L = 34, R = 14, T = 16, B = 46;
  const maxY = Math.max(10, ...pts.flatMap((r) => chart.y.map((k) => num(r[k]) ?? 0)));
  const xs = (i) => L + (pts.length === 1 ? (W - L - R) / 2 : (i * (W - L - R)) / (pts.length - 1));
  const ys = (v) => T + (H - T - B) * (1 - v / maxY);
  const bar = chart.type === 'bar';
  let svg = '';
  for (let g = 0; g <= maxY; g += maxY > 10 ? Math.ceil(maxY / 5) : 2) {
    svg += `<line x1="${L}" x2="${W - R}" y1="${ys(g)}" y2="${ys(g)}" class="grid"/><text x="${L - 6}" y="${ys(g) + 4}" class="ax" text-anchor="end">${g}</text>`;
  }
  const bw = Math.min(40, (W - L - R) / pts.length / (chart.y.length + 1));
  chart.y.forEach((k, s) => {
    const color = PAL[s % PAL.length];
    if (bar) {
      pts.forEach((r, i) => {
        const v = num(r[k]); if (v === null) return;
        const cx = L + ((i + 0.5) * (W - L - R)) / pts.length + (s - (chart.y.length - 1) / 2) * bw;
        svg += `<rect x="${cx - bw / 2}" y="${ys(v)}" width="${bw - 2}" height="${ys(0) - ys(v)}" rx="3" fill="${color}"/>`;
      });
    } else {
      const p = pts.map((r, i) => (num(r[k]) === null ? null : [xs(i), ys(num(r[k]))])).filter(Boolean);
      svg += `<polyline points="${p.map((q) => q.join(',')).join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
      svg += p.map((q) => `<circle cx="${q[0]}" cy="${q[1]}" r="4.5" fill="#fff" stroke="${color}" stroke-width="2.5"/>`).join('');
    }
  });
  pts.forEach((r, i) => {
    const x = bar ? L + ((i + 0.5) * (W - L - R)) / pts.length : xs(i);
    svg += `<text x="${x}" y="${H - B + 18}" class="ax" text-anchor="middle">${esc(short(r[chart.x] || i + 1))}</text>`;
  });
  const legend = chart.y.map((k, s) => `<span><i style="background:${PAL[s % PAL.length]}"></i>${esc(columns.find((c) => c.name === k)?.label || k)}</span>`).join('');
  return `<figure class="chart"><figcaption>${esc(chart.title)}</figcaption><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(chart.title)}">${svg}</svg><div class="legend">${legend}</div></figure>`;
}

function pieChart(rows, chart) {
  const items = rows.map((r) => ({ l: r[chart.label], v: num(r[chart.value]) })).filter((x) => x.v > 0);
  const total = items.reduce((a, b) => a + b.v, 0);
  if (!total) return '';
  let a0 = -Math.PI / 2, svg = '';
  items.forEach((it, i) => {
    const a1 = a0 + (it.v / total) * Math.PI * 2;
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (a) => `${100 + 90 * Math.cos(a)},${100 + 90 * Math.sin(a)}`;
    svg += items.length === 1
      ? `<circle cx="100" cy="100" r="90" fill="${PAL[0]}"/>`
      : `<path d="M100,100 L${p(a0)} A90,90 0 ${large} 1 ${p(a1)} Z" fill="${PAL[i % PAL.length]}" stroke="#fff" stroke-width="2"/>`;
    a0 = a1;
  });
  const legend = items.map((it, i) => `<span><i style="background:${PAL[i % PAL.length]}"></i>${esc(it.l)} — ${Math.round((it.v / total) * 100)}%</span>`).join('');
  return `<figure class="chart pie"><figcaption>${esc(chart.title)}</figcaption><svg viewBox="0 0 200 200" role="img" aria-label="${esc(chart.title)}">${svg}</svg><div class="legend">${legend}</div></figure>`;
}

function radarChart(schema, data, f) {
  const labels = f.fields.map((k) => schema.find((x) => x.name === k)?.label || k);
  const vals = f.fields.map((k) => num(data[k]) ?? 0);
  if (!vals.some((v) => v > 0)) return '';
  const n = vals.length, CX = 230, C = 175, Rr = 115;
  const pt = (i, r) => [CX + r * Math.cos(-Math.PI / 2 + (i * 2 * Math.PI) / n), C + r * Math.sin(-Math.PI / 2 + (i * 2 * Math.PI) / n)];
  let svg = '';
  for (const lvl of [2, 4, 6, 8, 10]) svg += `<polygon points="${vals.map((_, i) => pt(i, (Rr * lvl) / 10).join(',')).join(' ')}" class="grid" fill="none"/>`;
  vals.forEach((_, i) => { const [x, y] = pt(i, Rr); svg += `<line x1="${CX}" y1="${C}" x2="${x}" y2="${y}" class="grid"/>`; });
  svg += `<polygon points="${vals.map((v, i) => pt(i, (Rr * v) / 10).join(',')).join(' ')}" fill="rgba(156,68,34,.28)" stroke="#9c4422" stroke-width="2.5"/>`;
  labels.forEach((l, i) => { const [x, y] = pt(i, Rr + 24); svg += `<text x="${x}" y="${y + 4}" class="ax" text-anchor="middle">${esc(short(l, 20))} (${vals[i]})</text>`; });
  return `<figure class="chart radar"><figcaption>${esc(f.title)}</figcaption><svg viewBox="0 0 460 350" role="img" aria-label="${esc(f.title)}">${svg}</svg></figure>`;
}

// ---------- resposta somente leitura ----------
export function renderResponse(schema, data) {
  if (!data) return html`<p class="muted">Sem resposta ainda.</p>`;
  return schema.map((f) => {
    const v = data[f.name];
    switch (f.type) {
      case 'text': case 'textarea':
        return v ? html`<div class="ans"><h4>${f.label}</h4><p class="pre">${v}</p></div>` : '';
      case 'scale':
        return v !== '' && v !== undefined ? html`<div class="ans"><h4>${f.label}</h4><div class="meter"><span style="width:${Number(v) * 10}%"></span></div><b>${v}/10</b></div>` : '';
      case 'checks':
        return v && v.length ? html`<div class="ans"><h4>${f.label}</h4><p>${v.join(' · ')}</p></div>` : '';
      case 'table': {
        if (!v || !v.length) return '';
        const chart = f.chart ? (f.chart.type === 'pie' ? pieChart(v, f.chart) : lineChart(v, f.chart, f.columns)) : '';
        return html`<div class="ans"><h4>${f.label}</h4>
          <div class="tbl-wrap"><table class="tbl"><thead><tr>${f.columns.map((c) => html`<th>${c.label}</th>`)}</tr></thead>
          <tbody>${v.map((r) => html`<tr>${f.columns.map((c) => html`<td>${c.type === 'date' && r[c.name] ? short(r[c.name]) : r[c.name]}</td>`)}</tr>`)}</tbody></table></div>
          ${raw(chart)}</div>`;
      }
      case 'radar':
        return raw(radarChart(schema, data, f));
      default:
        return '';
    }
  });
}
