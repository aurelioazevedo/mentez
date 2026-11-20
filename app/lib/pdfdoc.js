// PDF do documento psicológico (mesmo timbre da impressão), gerado no servidor para receber a assinatura digital.
import * as Brand from './brand.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import QRCode from 'qrcode';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const LOGO = path.join(DIR, '..', 'public', 'img', 'logo-terracota.png');
const INK = rgb(0.22, 0.14, 0.1); const MUTED = rgb(0.45, 0.36, 0.3); const ACCENT = rgb(0.5, 0.21, 0.1);
const brDate = (d) => { const s = String(d || '').slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s.split('-').reverse().join('/') : ''; };
const brDateTime = (d) => { const s = String(d || ''); return `${brDate(s)} ${s.slice(11, 16)}`.trim(); };

// Fontes padrão do PDF usam WinAnsi: troca o que não existe nela (emojis, símbolos raros)
function clean(font, text) {
  const map = { '→': '->', '•': '-', ' ': ' ', ' ': ' ', '​': '' };
  let out = '';
  for (const ch of String(text || '').replace(/\r/g, '').replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, '')) {
    const c = map[ch] ?? ch;
    if (c === '\n') { out += c; continue; }
    try { font.encodeText(c); out += c; } catch { out += '?'; }
  }
  return out;
}
function wrap(font, size, text, width) {
  const lines = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { lines.push(''); continue; }
    let line = '';
    for (const w of para.split(/(\s+)/)) {
      const t = line + w;
      if (font.widthOfTextAtSize(t.trimEnd(), size) <= width) { line = t; continue; }
      if (line.trim()) lines.push(line.trimEnd());
      line = w.trimStart();
      while (font.widthOfTextAtSize(line, size) > width) { // palavra maior que a linha
        let k = line.length; while (k > 1 && font.widthOfTextAtSize(line.slice(0, k), size) > width) k--;
        lines.push(line.slice(0, k)); line = line.slice(k);
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

// d: documento (psy_docs com signer_*); base: endereço público (verificação)
export async function buildPdf(d, { base, signaturePng = null, city = Brand.get().city } = {}) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(d.title || 'Documento psicológico'); pdf.setAuthor(d.signer_name || ''); pdf.setCreator('Sistema do consultório');
  pdf.setSubject(`psydoc:${d.id}:${d.hash || ''}`); // identifica o documento quando o PDF assinado volta ao sistema
  pdf.setKeywords([`psydoc-${d.id}`, d.verify_code || '']);
  pdf.setCreationDate(new Date(String(d.signed_at || new Date().toISOString()).replace(' ', 'T') + (String(d.signed_at || '').includes('T') ? '' : '-03:00')));
  const reg = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 595.28; const H = 841.89; const M = 64; const TW = W - 2 * M;
  let pg = pdf.addPage([W, H]); let y = H - M;
  const newPage = () => { pg = pdf.addPage([W, H]); y = H - M; };
  const need = (h) => { if (y - h < M + 40) newPage(); };
  // Logo: a enviada pela clínica (PNG ou JPG); no sistema da Dra. Lorrainy, a dela; sem logo, só o texto do documento
  const lf = await Brand.logoFile();
  if ((lf && lf.mime !== 'image/webp') || (!lf && Brand.get().legacy)) try { const logo = lf ? (lf.mime === 'image/png' ? await pdf.embedPng(lf.buf) : await pdf.embedJpg(lf.buf)) : await pdf.embedPng(fs.readFileSync(LOGO)); const s = 150 / logo.width; pg.drawImage(logo, { x: (W - 150) / 2, y: y - logo.height * s, width: 150, height: logo.height * s }); y -= logo.height * s + 26; } catch { y -= 10; }
  if (d.status === 'cancelado') { pg.drawText('DOCUMENTO CANCELADO', { x: M, y, size: 12, font: bold, color: rgb(0.7, 0.1, 0.1) }); y -= 22; }
  const title = clean(bold, d.title || '');
  for (const l of wrap(bold, 15, title, TW)) { pg.drawText(l, { x: (W - bold.widthOfTextAtSize(l, 15)) / 2, y, size: 15, font: bold, color: INK }); y -= 22; }
  y -= 12;
  const size = 11.5; const lh = 17;
  for (const l of wrap(reg, size, clean(reg, d.body || ''), TW)) { need(lh); if (l) pg.drawText(l, { x: M, y, size, font: reg, color: INK }); y -= lh; }
  y -= 14; need(120);
  const place = clean(reg, `${city}, ${brDate(d.signed_at) || brDate(new Date().toISOString())}.`);
  pg.drawText(place, { x: M, y, size, font: reg, color: INK }); y -= 70;
  need(80);
  if (signaturePng) {
    try { const img = /^data:image\/png/.test(signaturePng) ? await pdf.embedPng(Buffer.from(signaturePng.split(',')[1], 'base64')) : await pdf.embedJpg(Buffer.from(signaturePng.split(',')[1], 'base64')); const s = Math.min(160 / img.width, 54 / img.height); pg.drawImage(img, { x: (W - img.width * s) / 2, y: y + 4, width: img.width * s, height: img.height * s }); } catch { /* sem imagem */ }
  }
  pg.drawLine({ start: { x: W / 2 - 110, y }, end: { x: W / 2 + 110, y }, thickness: 0.6, color: MUTED }); y -= 15;
  const nm = clean(bold, d.signer_name || d.author_name || ''); pg.drawText(nm, { x: (W - bold.widthOfTextAtSize(nm, 11)) / 2, y, size: 11, font: bold, color: INK }); y -= 14;
  const crp = clean(reg, `Psicóloga(o) · CRP ${d.signer_crp || '-'}`); pg.drawText(crp, { x: (W - reg.widthOfTextAtSize(crp, 10)) / 2, y, size: 10, font: reg, color: MUTED });
  // rodapé de verificação (última página)
  if (d.verify_code && base) {
    const url = `${String(base).replace(/\/+$/, '')}/v/${d.verify_code}`;
    const qr = await pdf.embedPng(await QRCode.toBuffer(url, { width: 220, margin: 1, errorCorrectionLevel: 'M' }));
    const fy = M - 20;
    pg.drawImage(qr, { x: M, y: fy, width: 62, height: 62 });
    const lines = [
      `Documento emitido por ${d.signer_name || ''} (CRP ${d.signer_crp || '-'}) em ${brDateTime(d.signed_at)}.`,
      `Código de verificação: ${d.verify_code} · ${url}`,
      'Assinatura digital ICP-Brasil: confira também em validar.iti.gov.br',
      'Documento sigiloso (Resolução CFP nº 06/2019): destina-se exclusivamente à finalidade indicada.',
    ];
    lines.forEach((t, i) => pg.drawText(clean(reg, t), { x: M + 72, y: fy + 50 - i * 12, size: 7.6, font: i === 1 ? bold : reg, color: i === 1 ? ACCENT : MUTED }));
  }
  return Buffer.from(await pdf.save({ useObjectStreams: false }));
}
