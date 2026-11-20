// Atendimento humano pelo WhatsApp da equipe: quando o atendente virtual passa a conversa para um humano,
// as mensagens do contato são encaminhadas ao WhatsApp de atendimento (identificando quem é); a resposta
// da equipe volta ao contato pelo número da clínica, identificada como atendimento humano.
// “reativar” devolve a conversa ao atendente virtual. Vale para várias conversas ao mesmo tempo,
// com áudios, fotos, vídeos e arquivos, e tudo fica no histórico.
import { q, one } from './db.js';
import * as WA from './whatsapp.js';
import * as Agent from './agent.js';
import * as Live from './live.js';

const RESUME = /^(reativar|reative|ativar|ative|devolver|devolva)(\s+(o|a))?(\s+(assistente|atendente))?(\s+virtual)?[.!]*$/i;
const LIST = /^(conversas|abertas|lista)[.!?]*$/i;
const HELP = /^(ajuda|comandos|\?)[.!]*$/i;
const MEDIA = { audioMessage: 'audio', imageMessage: 'image', videoMessage: 'video', documentMessage: 'document', documentWithCaptionMessage: 'document' };
const MEDIA_LABEL = { audio: 'um áudio', image: 'uma foto', video: 'um vídeo', document: 'um arquivo' };

const cleanOps = (list) => (Array.isArray(list) ? list : []).map((o) => ({ name: String(o.name || '').trim().slice(0, 60), phone: String(o.phone || '').trim().slice(0, 30), active: !!o.active })).filter((o) => o.name && WA.phoneKey(o.phone));
export const operators = (c, all = false) => cleanOps(c.relayOps).filter((o) => all || o.active);
export const enabled = (c) => !!c.relayOn && operators(c).length > 0;
export const operatorOf = (c, number) => { const k = WA.phoneKey(number); return enabled(c) ? operators(c).find((o) => WA.phoneKey(o.phone) === k) || null : null; };

const tag = (conv) => `#${conv.id}`;
async function labelOf(conv) {
  if (conv.patient_id) { const p = await one('SELECT name, social_name FROM patients WHERE id = ?', [conv.patient_id]); if (p) return { name: p.social_name || p.name, kind: 'paciente' }; }
  return { name: conv.contact_name || conv.phone, kind: 'contato (ainda não é paciente)' };
}
const fmtPhone = (n) => { const d = String(n || '').replace(/\D/g, '').replace(/^55/, ''); return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d; };
// Últimas mensagens trocadas com o contato (do registro do WhatsApp: inclui a mensagem que acabou de chegar)
async function lastLines(conv, n = 6) {
  const rows = await q("SELECT direction, body_enc FROM wa_messages WHERE phone = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 12 HOUR) ORDER BY id DESC LIMIT ?", [WA.normalizePhone(conv.phone), n]);
  return rows.reverse().map((r) => ({ who: r.direction === 'in' ? 'in' : 'out', text: WA.decryptBody(r.body_enc) })).filter((l) => l.text);
}
function textOf(msg) {
  const m = msg || {};
  return String(m.conversation || m.extendedTextMessage?.text || m.imageMessage?.caption || m.videoMessage?.caption || m.documentMessage?.caption || m.documentWithCaptionMessage?.message?.documentMessage?.caption || '').trim();
}
function quotedIdOf(msg) {
  for (const v of Object.values(msg || {})) { const id = v?.contextInfo?.stanzaId; if (id) return id; }
  return null;
}
function mediaOf(msg) {
  for (const [k, type] of Object.entries(MEDIA)) if (msg?.[k]) { const m = k === 'documentWithCaptionMessage' ? msg[k].message?.documentMessage : msg[k]; return { type, mimetype: m?.mimetype || null, fileName: m?.fileName || null }; }
  return null;
}
async function remember(convId, opKey, waId) { if (waId) await q('INSERT IGNORE INTO relay_msgs (conv_id, op_key, wa_id) VALUES (?,?,?)', [convId, opKey, waId]); }
async function note(convId, line) {
  const cv = await one('SELECT human_note FROM agent_conversations WHERE id = ?', [convId]);
  const lines = String(cv?.human_note || '').split('\n').filter(Boolean).concat(line.slice(0, 400)).slice(-14);
  await q('UPDATE agent_conversations SET human_note = ? WHERE id = ?', [lines.join('\n'), convId]);
}
async function keepPaused(convId) {
  const c = await Agent.config();
  await q("UPDATE agent_conversations SET status = 'humano', human_until = GREATEST(COALESCE(human_until, NOW()), DATE_ADD(NOW(), INTERVAL ? HOUR)) WHERE id = ?", [Number(c.pauseHours) || 12, convId]);
}
const openConvs = () => q("SELECT * FROM agent_conversations WHERE status = 'humano' AND relay_started_at IS NOT NULL AND (human_until IS NULL OR human_until > NOW()) ORDER BY last_inbound_at DESC LIMIT 20");

// 1) Passou para humano: avisa o WhatsApp de atendimento com quem é, o motivo e as últimas mensagens
export async function startHandoff(convId, reason, urgent = false) {
  const c = await Agent.config();
  if (!enabled(c)) return { skipped: true };
  const conv = await one('SELECT * FROM agent_conversations WHERE id = ?', [convId]);
  if (!conv) return { skipped: true };
  const who = await labelOf(conv);
  const lines = (await lastLines(conv)).map((l) => `› ${l.who === 'in' ? who.name.split(' ')[0] : 'Assistente'}: ${l.text.replace(/\s+/g, ' ').slice(0, 160)}`);
  const text = `${urgent ? '🚨 *URGENTE* — ' : '🙋 '}*Atendimento humano* ${tag(conv)}\n*${who.name}* (${who.kind}) · ${fmtPhone(conv.phone)}\nMotivo: ${String(reason || 'pediu para falar com a equipe').slice(0, 200)}${lines.length ? `\n\nÚltimas mensagens:\n${lines.join('\n')}` : ''}\n\n↩️ *Responda esta mensagem* (arraste para o lado) para falar com ${who.name.split(' ')[0]}. Ou comece com *${tag(conv)}*.\nPara devolver ao assistente virtual: *reativar*`;
  await q('UPDATE agent_conversations SET relay_started_at = NOW(), human_note = NULL WHERE id = ?', [conv.id]);
  for (const op of operators(c)) {
    const r = await WA.send({ phone: op.phone, text, kind: 'agente' });
    await remember(conv.id, WA.phoneKey(op.phone), r.waId);
  }
  Live.emit(['crm']);
  return { ok: true };
}

// 2) Mensagem do contato enquanto está com humano: encaminha (texto, áudio, foto, vídeo, arquivo)
export async function forwardIfHuman({ number, d, text }) {
  const c = await Agent.config();
  if (!enabled(c)) return false;
  const conv = await one("SELECT * FROM agent_conversations WHERE phone_key = ? AND status = 'humano' AND relay_started_at IS NOT NULL AND (human_until IS NULL OR human_until > NOW())", [WA.phoneKey(number)]);
  if (!conv) return false;
  await q('UPDATE agent_conversations SET last_inbound_at = NOW() WHERE id = ?', [conv.id]);
  const who = await labelOf(conv); const first = who.name.split(' ')[0];
  const media = mediaOf(d.message); const caption = textOf(d.message);
  let file = null;
  if (media) { try { file = await WA.downloadMedia(d.key); } catch (e) { console.error('encaminhar mídia:', e.message); } }
  for (const op of operators(c)) {
    const opKey = WA.phoneKey(op.phone);
    if (media && file) {
      if (media.type === 'audio') { const h = await WA.send({ phone: op.phone, text: `🎤 *${who.name}* ${tag(conv)} enviou um áudio:`, kind: 'agente' }); await remember(conv.id, opKey, h.waId); }
      const r = await WA.send({ phone: op.phone, text: media.type === 'audio' ? '' : `*${who.name}* ${tag(conv)}${caption ? `: ${caption}` : ''}`, kind: 'agente', media: { type: media.type, base64: file.base64, mimetype: file.mimetype || media.mimetype, fileName: file.fileName || media.fileName || 'arquivo' } });
      await remember(conv.id, opKey, r.waId);
    } else {
      const r = await WA.send({ phone: op.phone, text: `*${who.name}* ${tag(conv)}: ${media && !file ? `[enviou ${MEDIA_LABEL[media.type]} que não consegui baixar]${caption ? ` ${caption}` : ''}` : text}`, kind: 'agente' });
      await remember(conv.id, opKey, r.waId);
    }
  }
  await note(conv.id, `${first}: ${media ? `[${MEDIA_LABEL[media.type]}] ` : ''}${caption || (media ? '' : text)}`);
  await keepPaused(conv.id);
  return true;
}

// 3) Mensagem do WhatsApp de atendimento: resposta ao contato ou comando (reativar, conversas, ajuda)
export async function fromOperator(d, number) {
  const c = await Agent.config();
  const op = operatorOf(c, number);
  if (!op) return { ignored: true };
  const opKey = WA.phoneKey(op.phone);
  let text = textOf(d.message);
  const reply = (t) => WA.send({ phone: op.phone, text: t, kind: 'agente' });
  // qual conversa: a mensagem respondida (arrastar para o lado) > código #N > a única aberta
  let conv = null;
  const qid = quotedIdOf(d.message);
  if (qid) { const m = await one('SELECT conv_id FROM relay_msgs WHERE wa_id = ?', [qid]); if (m) conv = await one('SELECT * FROM agent_conversations WHERE id = ?', [m.conv_id]); }
  const code = /^#(\d+)\b\s*/.exec(text);
  if (!conv && code) conv = await one('SELECT * FROM agent_conversations WHERE id = ?', [Number(code[1])]);
  if (code) text = text.slice(code[0].length).trim();
  const open = await openConvs();
  if (HELP.test(text)) { await reply('ℹ️ *Atendimento humano*\n• Responda (arraste para o lado) a mensagem do contato para falar com ele.\n• Ou comece com o código, ex.: *#12 Olá!*\n• Áudios, fotos e arquivos também vão.\n• *reativar* — devolve a conversa ao assistente virtual.\n• *conversas* — mostra as conversas abertas.'); return { help: true }; }
  if (LIST.test(text) && !conv) {
    const rows = await Promise.all(open.map(async (cv) => `• ${tag(cv)} ${(await labelOf(cv)).name}`));
    await reply(rows.length ? `Conversas com atendimento humano:\n${rows.join('\n')}` : 'Nenhuma conversa aberta com atendimento humano agora.');
    return { list: true };
  }
  if (!conv) {
    if (open.length === 1) conv = open[0];
    else if (!open.length) { await reply('Não há conversa aberta com atendimento humano agora. (Envie *ajuda* para ver os comandos.)'); return { none: true }; }
    else {
      const rows = await Promise.all(open.map(async (cv) => `• ${tag(cv)} ${(await labelOf(cv)).name}`));
      await reply(`Você tem ${open.length} conversas abertas. Responda (arraste para o lado) a mensagem do contato ou comece com o código:\n${rows.join('\n')}`);
      return { ambiguous: true };
    }
  }
  const who = await labelOf(conv); const first = who.name.split(' ')[0];
  if (RESUME.test(text)) return resume(conv, op);
  // reabre se o assistente já tinha voltado e a equipe respondeu mesmo assim
  if (conv.status !== 'humano' || !conv.relay_started_at) await q("UPDATE agent_conversations SET status = 'humano', relay_started_at = COALESCE(relay_started_at, NOW()), human_reason = ? WHERE id = ?", [`Assumida por ${op.name} pelo WhatsApp`, conv.id]);
  const media = mediaOf(d.message);
  const label = `👩‍💼 *Atendimento humano — ${op.name}:*`;
  let r;
  if (media) {
    let file = null; try { file = await WA.downloadMedia(d.key); } catch (e) { console.error('mídia da equipe:', e.message); }
    if (!file) { await reply(`⚠ Não consegui baixar ${MEDIA_LABEL[media.type]} para enviar a ${first}. Tente de novo.`); return { error: true }; }
    if (media.type === 'audio') await WA.send({ phone: conv.phone, text: `${label} (áudio)`, kind: 'manual', patient_id: conv.patient_id });
    r = await WA.send({ phone: conv.phone, text: media.type === 'audio' ? '' : `${label}${text ? `\n${text}` : ''}`, kind: 'manual', patient_id: conv.patient_id, media: { type: media.type, base64: file.base64, mimetype: file.mimetype || media.mimetype, fileName: file.fileName || media.fileName || 'arquivo' } });
  } else {
    if (!text) return { empty: true };
    r = await WA.send({ phone: conv.phone, text: `${label}\n${text}`, kind: 'manual', patient_id: conv.patient_id });
  }
  if (!r.ok) { await reply(`⚠ Não foi possível entregar a ${first}: ${r.error}`); return { error: r.error }; }
  await note(conv.id, `Equipe (${op.name}): ${media ? `[${MEDIA_LABEL[media.type]}] ` : ''}${text}`);
  await keepPaused(conv.id);
  // as outras pessoas da equipe acompanham quem respondeu
  for (const o of operators(c).filter((x) => WA.phoneKey(x.phone) !== opKey)) {
    const e = await WA.send({ phone: o.phone, text: `↪ *${op.name}* para ${who.name} ${tag(conv)}: ${media ? `[${MEDIA_LABEL[media.type]}] ` : ''}${text}`.trim(), kind: 'agente' });
    await remember(conv.id, WA.phoneKey(o.phone), e.waId);
  }
  Live.emit(['crm']);
  return { sent: true, conv: conv.id };
}

// 4) Devolver ao atendente virtual
export async function resume(conv, op) {
  const c = await Agent.config();
  await Agent.resume(conv.id);
  await q('UPDATE agent_conversations SET relay_started_at = NULL WHERE id = ?', [conv.id]);
  const who = await labelOf(conv);
  await WA.send({ phone: conv.phone, text: `Oi de novo! 😊 Aqui é o ${c.assistantName || 'assistente virtual'}; voltei a te atender. Se precisar falar com a equipe outra vez, é só pedir.`, kind: 'agente', patient_id: conv.patient_id });
  for (const o of operators(c)) await WA.send({ phone: o.phone, text: `✓ ${tag(conv)} ${who.name}: conversa devolvida ao assistente virtual${op ? ` por ${op.name}` : ''}.`, kind: 'agente' });
  Live.emit(['crm']);
  return { resumed: true };
}
// Retomada pelo sistema (botão “Retomar”): só avisa a equipe
export async function notifyResumed(convId, byName) {
  const c = await Agent.config();
  const conv = await one('SELECT * FROM agent_conversations WHERE id = ?', [convId]);
  if (!enabled(c) || !conv?.relay_started_at) return;
  await q('UPDATE agent_conversations SET relay_started_at = NULL WHERE id = ?', [convId]);
  const who = await labelOf(conv);
  for (const o of operators(c)) await WA.send({ phone: o.phone, text: `✓ ${tag(conv)} ${who.name}: conversa devolvida ao assistente virtual pelo sistema${byName ? ` (${byName})` : ''}.`, kind: 'agente' });
}
