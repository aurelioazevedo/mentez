// Painel de chamadas — etapa 2: mídias (imagem, vídeo curto sem som) e campanhas da clínica na TV,
// com período, dias, horário, tempo na tela, peso e escolha das TVs. A chamada sempre interrompe a mídia.
import * as Tenancy from './tenancy.js';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { q, one } from './db.js';
import { todayLocal, nowLocal, addDays } from './time.js';
import * as SC from './schedule.js';
import * as Sp from './tvsponsors.js';

export const KINDS = { servico: 'Nossos serviços', bemestar: 'Bem-estar', aviso: 'Aviso', patrocinador: 'Parceiro do consultório' };
export const FORMATS = { texto: 'Só texto', imagem: 'Imagem', video: 'Vídeo curto (sem som)' };
export const WEIGHTS = { 1: 'Normal', 2: 'Destaque — aparece 2× mais', 3: 'Máximo — aparece 3× mais' };
export const DAYS = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
const TYPES = {
  'image/jpeg': { kind: 'imagem', ok: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { kind: 'imagem', ok: (b) => b[0] === 0x89 && b.slice(1, 4).toString() === 'PNG' },
  'image/webp': { kind: 'imagem', ok: (b) => b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP' },
  'video/mp4': { kind: 'video', ok: (b) => b.slice(4, 8).toString() === 'ftyp' },
  'video/webm': { kind: 'video', ok: (b) => b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
};
export const LIMITS = { imagem: 5 * 1024 * 1024, video: 40 * 1024 * 1024 };
const CHUNK = 512 * 1024; // guardado em partes (o banco aceita pacotes limitados)

// ---------- arquivos ----------
export async function saveMedia(buf, mime, name, userId) {
  const t = TYPES[mime];
  if (!buf || !buf.length) return { ok: false, error: 'Arquivo vazio.' };
  if (!t || !t.ok(buf)) return { ok: false, error: 'Envie uma imagem JPG, PNG ou WebP, ou um vídeo MP4 ou WebM.' };
  if (buf.length > LIMITS[t.kind]) return { ok: false, error: t.kind === 'video' ? 'O vídeo passa de 40 MB: encurte ou comprima antes de enviar.' : 'A imagem passa de 5 MB.' };
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  const same = await one('SELECT id, kind FROM tv_media WHERE sha = ?', [sha]);
  if (same) return { ok: true, id: same.id, kind: same.kind, sha };
  const r = await q('INSERT INTO tv_media (kind, mime, size, sha, name, created_by) VALUES (?,?,?,?,?,?)', [t.kind, mime, buf.length, sha, String(name || 'arquivo').slice(0, 160), userId || null]);
  for (let i = 0, seq = 0; i < buf.length; i += CHUNK, seq++) await q('INSERT INTO tv_media_chunks (media_id, seq, data) VALUES (?,?,?)', [r.insertId, seq, buf.subarray(i, i + CHUNK)]);
  return { ok: true, id: r.insertId, kind: t.kind, sha };
}
const cache = new Tenancy.TMap(); let cacheBytes = 0;  // separado por clínica
export async function readMedia(id) {
  if (cache.has(id)) { const v = cache.get(id); cache.delete(id); cache.set(id, v); return v; }
  const m = await one('SELECT id, kind, mime, size, sha FROM tv_media WHERE id = ?', [id]);
  if (!m) return null;
  const parts = await q('SELECT data FROM tv_media_chunks WHERE media_id = ? ORDER BY seq', [id]);
  const v = { ...m, buf: Buffer.concat(parts.map((p) => p.data)) };
  cache.set(id, v); cacheBytes += v.buf.length;
  for (const [k, x] of cache) { if (cacheBytes <= 120 * 1024 * 1024) break; cache.deleteRaw(k); cacheBytes -= x.buf.length; }
  return v;
}
// Responde o arquivo com suporte a “Range” (os vídeos pedem pedaços).
export function sendMedia(req, res, m) {
  res.set({ 'Content-Type': m.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${m.sha.slice(0, 16)}"` });
  if (req.headers['if-none-match'] === `"${m.sha.slice(0, 16)}"`) return res.status(304).end();
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (range) {
    const size = m.buf.length;
    let start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
    let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : size - 1;
    if (!(start >= 0) || start >= size || end < start) return res.status(416).set('Content-Range', `bytes */${size}`).end();
    end = Math.min(end, size - 1);
    res.status(206).set({ 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    return res.end(m.buf.subarray(start, end + 1));
  }
  res.set('Content-Length', m.buf.length);
  res.end(m.buf);
}
async function pruneMedia() {
  const orphans = await q('SELECT m.id FROM tv_media m WHERE NOT EXISTS (SELECT 1 FROM tv_campaigns c WHERE c.media_id = m.id) AND m.created_at < DATE_SUB(NOW(), INTERVAL 1 DAY)');
  for (const o of orphans) { await q('DELETE FROM tv_media_chunks WHERE media_id = ?', [o.id]); await q('DELETE FROM tv_media WHERE id = ?', [o.id]); cache.delete(o.id); }
}

// ---------- campanhas ----------
const CAMP = `SELECT c.*, m.kind media_kind, m.mime media_mime, m.sha media_sha, m.size media_size,
    sp.name sp_name, sp.status sp_status, sp.start_date sp_start, sp.end_date sp_end, sp.category sp_cat, sp.tier sp_tier,
    (SELECT COALESCE(SUM(plays),0) FROM tv_campaign_stats s WHERE s.campaign_id = c.id AND s.day >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) plays30,
    (SELECT COALESCE(SUM(scans),0) FROM tv_campaign_stats s WHERE s.campaign_id = c.id AND s.day >= DATE_SUB(CURDATE(), INTERVAL 30 DAY)) scans30
  FROM tv_campaigns c LEFT JOIN tv_media m ON m.id = c.media_id LEFT JOIN tv_sponsors sp ON sp.id = c.sponsor_id`;
// Ordem de exibição na TV: a clínica arrasta ou usa ↑ ↓ (campanhas novas entram no fim)
export async function list() {
  await q('UPDATE tv_campaigns SET position = id WHERE position IS NULL');
  return q(`${CAMP} WHERE c.deleted = 0 ORDER BY c.position, c.id`);
}
// Reordena um grupo: as campanhas recebem as mesmas posições que o grupo já ocupava, na nova ordem
export async function reorder(ids) {
  ids = [...new Set([].concat(ids || []).map(Number).filter((n) => n > 0))].slice(0, 500);
  if (ids.length < 2) return false;
  const rows = await q(`SELECT id, COALESCE(position, id) pos FROM tv_campaigns WHERE deleted = 0 AND id IN (${ids.map(() => '?').join(',')})`, ids);
  if (rows.length !== ids.length) return false;
  const slots = rows.map((r) => Number(r.pos)).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1; // posições repetidas
  for (let i = 0; i < ids.length; i++) await q('UPDATE tv_campaigns SET position = ? WHERE id = ?', [slots[i], ids[i]]);
  return true;
}
export const get = (id) => one(`${CAMP} WHERE c.id = ? AND c.deleted = 0`, [id]);

export function statusOf(c, ads = null) {
  const t = todayLocal();
  if (!c.active) return ['cancelada', 'Pausada'];
  if (c.approval === 'recusada') return ['falta', 'Recusada'];
  if (c.approval === 'pendente') return ['agendada', 'Aguardando aprovação'];
  if (c.sponsor_id && !Sp.inForce({ status: c.sp_status, start_date: c.sp_start, end_date: c.sp_end })) return ['cancelada', 'Parceiro fora do contrato'];
  if (c.sponsor_id && ads && Sp.isBlocked(c.sp_cat, ads)) return ['falta', 'Categoria bloqueada'];
  if (c.start_date && String(c.start_date).slice(0, 10) > t) return ['agendada', `Começa em ${String(c.start_date).slice(8, 10)}/${String(c.start_date).slice(5, 7)}`];
  if (c.end_date && String(c.end_date).slice(0, 10) < t) return ['falta', 'Encerrada'];
  const now = nowLocal().slice(11, 19);
  if (c.weekdays && !String(c.weekdays).split(',').includes(String(SC.dow(t)))) return ['agendada', 'Hoje não passa'];
  if ((c.time_from && String(c.time_from) > now) || (c.time_to && String(c.time_to) <= now)) return ['agendada', 'Fora do horário agora'];
  return ['realizada', 'No ar'];
}
const ymd = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : null);
const hm = (v) => (/^\d{2}:\d{2}$/.test(String(v || '')) ? `${v}:00` : null);
const httpUrl = (v) => { const s = String(v || '').trim(); return /^https?:\/\/[^\s"<>]{3,}$/i.test(s) ? s.slice(0, 500) : null; };

export async function save(id, b, { userId, base }) {
  const days = [...new Set([].concat(b.weekdays ?? []).flatMap((x) => String(x).split(',')).map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort();
  const format = FORMATS[b.format] ? b.format : 'texto';
  const media = format === 'texto' ? null : (Number(b.media_id) || null);
  if (media) { const m = await one('SELECT kind FROM tv_media WHERE id = ?', [media]); if (!m || m.kind !== format) return { ok: false, error: format === 'video' ? 'Envie o vídeo da campanha.' : 'Envie a imagem da campanha.' }; }
  if (format !== 'texto' && !media) return { ok: false, error: format === 'video' ? 'Envie o vídeo da campanha.' : 'Envie a imagem da campanha.' };
  const title = String(b.title || '').trim().slice(0, 90);
  const showTitle = b.show_title_f === undefined && b.show_title === undefined ? 1 : (b.show_title ? 1 : 0); // título só para organizar (não aparece na TV)
  if (!title && format === 'texto') return { ok: false, error: 'Escreva o título da campanha.' };
  if (format === 'texto' && !showTitle && !String(b.body || '').trim()) return { ok: false, error: 'Com o título escondido, escreva o texto que vai aparecer na TV.' };
  const qrUrl = httpUrl(b.qr_url);
  if (String(b.qr_url || '').trim() && !qrUrl) return { ok: false, error: 'O link do QR code precisa começar com https://' };
  const screens = [].concat(b.screens || []).map(Number).filter((n) => n > 0);
  const kind = KINDS[b.kind] ? b.kind : 'servico';
  let sponsor = null; let approval = 'aprovada';
  if (kind === 'patrocinador') {
    sponsor = await one('SELECT * FROM tv_sponsors WHERE id = ?', [Number(b.sponsor_id) || 0]);
    if (!sponsor) return { ok: false, error: 'Escolha o parceiro desta campanha (cadastre em Parceiros).' };
    const ads = await Sp.config();
    if (Sp.isBlocked(sponsor.category, ads)) return { ok: false, error: `A categoria “${sponsor.category}” está bloqueada para anúncios na TV.` };
    if (ads.requireApproval) approval = 'pendente';
  }
  const vals = [title, kind, format, String(b.body || '').trim().slice(0, 300) || null, media, qrUrl, String(b.qr_label || '').trim().slice(0, 60) || null,
    ymd(b.start_date), ymd(b.end_date), days.length === 7 ? '' : days.join(','), hm(b.time_from), hm(b.time_to),
    Math.max(5, Math.min(60, Number(b.duration_sec) || 12)), WEIGHTS[b.weight] ? Number(b.weight) : 1, screens.join(','), b.active ? 1 : 0, sponsor?.id || null, approval];
  let cid = id;
  const fixTitle = async (x) => q('UPDATE tv_campaigns SET show_title = ? WHERE id = ?', [showTitle, x]);
  if (id) await q(`UPDATE tv_campaigns SET title = ?, kind = ?, format = ?, body = ?, media_id = ?, qr_url = ?, qr_label = ?, start_date = ?, end_date = ?, weekdays = ?, time_from = ?, time_to = ?,
      duration_sec = ?, weight = ?, screens = ?, active = ?, sponsor_id = ?, approval = ?, approved_by = NULL, approved_at = NULL, reject_reason = NULL, updated_at = NOW() WHERE id = ?`, [...vals, id]);
  else cid = (await q(`INSERT INTO tv_campaigns (title, kind, format, body, media_id, qr_url, qr_label, start_date, end_date, weekdays, time_from, time_to, duration_sec, weight, screens, active, sponsor_id, approval, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [...vals, userId || null])).insertId;
  await fixTitle(cid);
  // QR code: aponta para /q/<id> (conta a leitura) e de lá vai para o link
  const png = qrUrl ? await QRCode.toDataURL(`${String(base).replace(/\/+$/, '')}/q/${cid}`, { width: 420, margin: 1, errorCorrectionLevel: 'M' }) : null;
  await q('UPDATE tv_campaigns SET qr_png = ? WHERE id = ?', [png, cid]);
  pruneMedia().catch(() => {});
  return { ok: true, id: cid, pending: approval === 'pendente' };
}
export async function approve(id, userId) { await q("UPDATE tv_campaigns SET approval = 'aprovada', approved_by = ?, approved_at = NOW(), reject_reason = NULL WHERE id = ?", [userId, id]); }
export async function reject(id, reason, userId) { await q("UPDATE tv_campaigns SET approval = 'recusada', approved_by = ?, approved_at = NOW(), reject_reason = ? WHERE id = ?", [userId, String(reason || '').slice(0, 200) || null, id]); }
export async function setActive(id, on) { await q('UPDATE tv_campaigns SET active = ? WHERE id = ?', [on ? 1 : 0, id]); }
export async function remove(id) { await q('UPDATE tv_campaigns SET deleted = 1, active = 0, media_id = NULL WHERE id = ?', [id]); pruneMedia().catch(() => {}); }
export async function duplicate(id, userId) {
  const c = await one('SELECT * FROM tv_campaigns WHERE id = ?', [id]);
  if (!c) return null;
  const r = await q(`INSERT INTO tv_campaigns (title, kind, format, body, media_id, qr_url, qr_label, qr_png, start_date, end_date, weekdays, time_from, time_to, duration_sec, weight, screens, active, sponsor_id, approval, created_by, show_title)
    SELECT CONCAT(title, ' (cópia)'), kind, format, body, media_id, qr_url, qr_label, NULL, start_date, end_date, weekdays, time_from, time_to, duration_sec, weight, screens, 0, sponsor_id, IF(sponsor_id IS NULL, 'aprovada', 'pendente'), ?, show_title FROM tv_campaigns WHERE id = ?`, [userId, id]);
  return r.insertId;
}

// O que está no ar agora para esta TV (período, dia da semana, horário e TVs escolhidas).
export async function liveFor(screen) {
  const now = nowLocal(); const day = now.slice(0, 10); const time = now.slice(11, 19); const dow = String(SC.dow(day));
  const ads = await Sp.config();
  const rows = await q(`SELECT c.id, c.title, c.show_title, c.kind, c.format, c.body, c.qr_png, c.qr_label, c.duration_sec, c.weight, c.weekdays, c.time_from, c.time_to, c.screens, c.sponsor_id, m.id mid, m.mime, m.sha,
      sp.name sp_name, sp.status sp_status, sp.start_date sp_start, sp.end_date sp_end, sp.category sp_cat, sp.tier sp_tier
    FROM tv_campaigns c LEFT JOIN tv_media m ON m.id = c.media_id LEFT JOIN tv_sponsors sp ON sp.id = c.sponsor_id
    WHERE c.deleted = 0 AND c.active = 1 AND c.approval = 'aprovada' AND (c.start_date IS NULL OR c.start_date <= ?) AND (c.end_date IS NULL OR c.end_date >= ?) ORDER BY COALESCE(c.position, c.id), c.id`, [day, day]);
  return rows.filter((c) => (!c.sponsor_id || (Sp.inForce({ status: c.sp_status, start_date: c.sp_start, end_date: c.sp_end }) && !Sp.isBlocked(c.sp_cat, ads))))
    .filter((c) => (!c.weekdays || c.weekdays.split(',').includes(dow))
    && (!c.time_from || String(c.time_from) <= time) && (!c.time_to || String(c.time_to) > time)
    && (!c.screens || c.screens.split(',').map(Number).includes(screen.id))
    && (c.format === 'texto' || c.mid))
    .map((c) => ({
      id: `c${c.id}`, cid: c.id, kind: c.sponsor_id ? `Parceiro · ${c.sp_name}` : (KINDS[c.kind] || ''), format: c.format, title: c.show_title === 0 ? '' : (c.title || ''), body: c.body || '',
      media: c.mid ? `/tv/midia/${c.mid}?v=${String(c.sha).slice(0, 12)}` : null, mime: c.mime || null,
      qr: c.qr_png || null, qrLabel: c.qr_png ? (c.qr_label || 'Aponte a câmera do celular') : null, duration: c.duration_sec, weight: c.sponsor_id ? (Sp.TIERS[c.sp_tier]?.weight || 1) : c.weight,
    }));
}

// ---------- números ----------
export async function recordPlay(cid) { await q('INSERT INTO tv_campaign_stats (campaign_id, day, plays) VALUES (?, CURDATE(), 1) ON DUPLICATE KEY UPDATE plays = plays + 1', [cid]); }
export async function recordScan(cid) { await q('INSERT INTO tv_campaign_stats (campaign_id, day, scans) VALUES (?, CURDATE(), 1) ON DUPLICATE KEY UPDATE scans = scans + 1', [cid]); }

// ---------- conteúdos prontos ----------
const yr = () => Number(todayLocal().slice(0, 4));
const nextRange = (m1, d1, m2, d2) => {
  const t = todayLocal(); let y = yr();
  const end = `${y}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;
  if (end < t) y += 1;
  return [`${y}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}`, `${y}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`];
};
export function templates() {
  const jan = nextRange(1, 1, 1, 31); const set = nextRange(9, 1, 9, 30);
  return {
    janeiro: { label: 'Janeiro Branco', kind: 'bemestar', title: 'Janeiro Branco', body: 'Quem cuida da mente cuida da vida. Comece o ano olhando para a sua saúde emocional.', start_date: jan[0], end_date: jan[1] },
    setembro: { label: 'Setembro Amarelo', kind: 'bemestar', title: 'Setembro Amarelo', body: 'Falar é a melhor solução. Se precisar, ligue 188 (CVV): 24 horas, gratuito.', start_date: set[0], end_date: set[1] },
    respira: { label: 'Respiração em 4 tempos', kind: 'bemestar', title: 'Uma pausa para respirar', body: 'Inspire em 4 tempos, segure 4, solte em 4. Repita algumas vezes enquanto espera.' },
    sono: { label: 'Higiene do sono', kind: 'bemestar', title: 'Dormir bem também é cuidado', body: 'Horários regulares, menos telas antes de deitar e um quarto escuro ajudam o sono.' },
    agende: { label: 'Agende pelo WhatsApp', kind: 'servico', title: 'Agende sua sessão pelo WhatsApp', body: 'Psicoterapia on-line e presencial. Aponte a câmera do celular para o QR code.', qr_label: 'Agende pelo WhatsApp' },
    silencio: { label: 'Celular no silencioso', kind: 'aviso', title: 'Ambiente de cuidado', body: 'Por favor, mantenha o celular no silencioso e fale baixo na sala de espera.' },
  };
}
export const nextYearEnd = () => addDays(todayLocal(), 365);
