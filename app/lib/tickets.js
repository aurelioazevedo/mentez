// Chamados (tickets) das clínicas para a equipe Mentez: suporte, financeiro, reclamações, sugestões…
// Ficam no banco da plataforma. O texto das mensagens e os anexos são guardados cifrados com a chave mestra
// (podem conter dados sensíveis). A clínica abre e acompanha em Suporte; a equipe responde no Painel → Chamados.
// Avisos: e-mail (e WhatsApp, se ligado) da Mentez para a equipe quando chega algo novo, e para quem abriu quando a equipe responde.
import * as T from './tenancy.js';
import * as PlatComm from './platcomm.js';

export const CATEGORIES = { suporte: 'Suporte técnico ou dúvida de uso', financeiro: 'Financeiro e cobrança', reclamacao: 'Reclamação', sugestao: 'Sugestão de melhoria', comercial: 'Plano e contratação', outro: 'Outro assunto' };
export const PRIORITIES = { normal: 'Normal', alta: 'Alta — atrapalha o atendimento', urgente: 'Urgente — sistema parado' };
export const PRIORITY_SHORT = { normal: 'Normal', alta: 'Alta', urgente: 'Urgente' };
// [classe do selo, rótulo para a equipe, rótulo para a clínica]
export const STATUS = {
  aberto: ['falta', 'Novo / respondido pela clínica', 'Aguardando a Mentez'],
  andamento: ['confirmada', 'Em andamento', 'Em andamento na Mentez'],
  aguardando: ['agendada', 'Aguardando a clínica', 'Aguardando a sua resposta'],
  resolvido: ['realizada', 'Resolvido', 'Resolvido'],
  fechado: ['cancelada', 'Fechado', 'Fechado'],
};
export const OPEN_STATES = ['aberto', 'andamento', 'aguardando'];
export const code = (id) => `#${String(id).padStart(5, '0')}`;
const MAX_FILE = 2.5 * 1024 * 1024; const MAX_FILES = 3;
const MIMES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' };

async function getS(k) { return (await T.pone('SELECT v FROM platform_settings WHERE k = ?', [k]))?.v || null; }
async function setS(k, v) { await T.pq('INSERT INTO platform_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]); }

let ready = null;
export function migrate() {
  ready ||= (async () => {
    await T.pq(`CREATE TABLE IF NOT EXISTS tickets (
      id INT AUTO_INCREMENT PRIMARY KEY, tenant_id INT NOT NULL, user_id INT NULL, user_name VARCHAR(120) NULL, user_email VARCHAR(190) NULL, user_phone VARCHAR(40) NULL,
      category VARCHAR(20) NOT NULL DEFAULT 'suporte', priority VARCHAR(10) NOT NULL DEFAULT 'normal', subject VARCHAR(160) NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'aberto',
      assignee VARCHAR(190) NULL, page VARCHAR(200) NULL, unread_team TINYINT(1) NOT NULL DEFAULT 1, unread_client TINYINT(1) NOT NULL DEFAULT 0,
      created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, last_from VARCHAR(10) NOT NULL DEFAULT 'cliente',
      first_response_at DATETIME NULL, resolved_at DATETIME NULL, closed_at DATETIME NULL, rating TINYINT NULL, rating_comment VARCHAR(500) NULL,
      INDEX (tenant_id, status), INDEX (status, updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await T.pq(`CREATE TABLE IF NOT EXISTS ticket_messages (
      id INT AUTO_INCREMENT PRIMARY KEY, ticket_id INT NOT NULL, author_type VARCHAR(10) NOT NULL, author_name VARCHAR(120) NULL, body_enc MEDIUMTEXT NOT NULL,
      internal TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (ticket_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await T.pq(`CREATE TABLE IF NOT EXISTS ticket_files (
      id INT AUTO_INCREMENT PRIMARY KEY, ticket_id INT NOT NULL, message_id INT NOT NULL, name VARCHAR(160) NOT NULL, mime VARCHAR(40) NOT NULL, size INT NOT NULL,
      data_enc LONGTEXT NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (ticket_id), INDEX (message_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

// ---------- configuração (Painel → Chamados) ----------
export async function config() {
  let c = {}; try { c = JSON.parse((await getS('tickets')) || '{}'); } catch { /* padrão */ }
  return { notifyEmail: c.notifyEmail ?? 'suporte@mentez.com.br', notifyPhone: c.notifyPhone || '', autoResolveDays: Number(c.autoResolveDays ?? 7), autoCloseDays: Number(c.autoCloseDays ?? 7) };
}
export async function saveConfig(b) {
  const email = String(b.notifyEmail || '').trim().slice(0, 190);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { error: 'E-mail de aviso inválido.' };
  const d = (v, def) => Math.max(1, Math.min(60, Math.round(Number(v) || def)));
  await setS('tickets', JSON.stringify({ notifyEmail: email, notifyPhone: String(b.notifyPhone || '').trim().slice(0, 40), autoResolveDays: d(b.autoResolveDays, 7), autoCloseDays: d(b.autoCloseDays, 7) }));
  return { ok: true };
}

// ---------- anexos (vindos do navegador como data URL; imagens já reduzidas lá) ----------
export function parseFiles(raw) {
  const list = (Array.isArray(raw) ? raw : raw ? [raw] : []).slice(0, MAX_FILES);
  const out = [];
  for (const item of list) {
    let o; try { o = JSON.parse(item); } catch { continue; }
    const m = /^data:([a-z/+.-]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(o?.data || ''));
    if (!m || !MIMES[m[1]]) throw new Error('Anexo não aceito: envie imagens (JPG, PNG) ou PDF.');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > MAX_FILE) throw new Error('Cada anexo pode ter no máximo 2,5 MB.');
    // confere a assinatura do arquivo (não confia só no tipo informado)
    const sig = buf.subarray(0, 12);
    const okSig = m[1] === 'application/pdf' ? sig.toString('latin1').startsWith('%PDF') : m[1] === 'image/png' ? sig[0] === 0x89 && sig[1] === 0x50 : m[1] === 'image/jpeg' ? sig[0] === 0xff && sig[1] === 0xd8 : sig.toString('latin1', 8, 12) === 'WEBP';
    if (!okSig) throw new Error('Um dos anexos está corrompido ou não é do tipo informado.');
    const name = String(o.name || `anexo.${MIMES[m[1]]}`).replace(/[^\w .()-]/g, '_').slice(0, 120) || `anexo.${MIMES[m[1]]}`;
    out.push({ name, mime: m[1], buf });
  }
  return out;
}
async function saveFiles(ticketId, messageId, files) {
  for (const f of files) await T.pq('INSERT INTO ticket_files (ticket_id, message_id, name, mime, size, data_enc) VALUES (?,?,?,?,?,?)', [ticketId, messageId, f.name, f.mime, f.buf.length, T.seal({ b: f.buf.toString('base64') })]);
}
export async function file(id) {
  const r = await T.pone('SELECT id, ticket_id, name, mime, data_enc FROM ticket_files WHERE id = ?', [id]);
  if (!r) return null;
  return { ticketId: r.ticket_id, name: r.name, mime: r.mime, buf: Buffer.from(T.unseal(r.data_enc).b || '', 'base64') };
}

// ---------- leitura ----------
export async function get(id) { return T.pone('SELECT t.*, n.name tenant_name, n.slug tenant_slug FROM tickets t LEFT JOIN tenants n ON n.id = t.tenant_id WHERE t.id = ?', [id]); }
export async function messages(id, { internal = false } = {}) {
  const rows = await T.pq(`SELECT * FROM ticket_messages WHERE ticket_id = ? ${internal ? '' : 'AND internal = 0'} ORDER BY id`, [id]);
  const files = await T.pq('SELECT id, message_id, name, mime, size FROM ticket_files WHERE ticket_id = ?', [id]);
  return rows.map((m) => { let body = ''; try { body = T.unseal(m.body_enc).t || ''; } catch { body = '(mensagem ilegível)'; } return { ...m, body, files: files.filter((f) => f.message_id === m.id) }; });
}
// Lista da clínica: a administração vê todos os chamados da clínica; os demais, só os próprios
export async function listForClinic(tenantId, user, isAdmin) {
  return T.pq(`SELECT id, subject, category, priority, status, unread_client, created_at, updated_at, user_name FROM tickets WHERE tenant_id = ? ${isAdmin ? '' : 'AND user_id = ?'} ORDER BY FIELD(status,'aguardando','aberto','andamento','resolvido','fechado'), updated_at DESC LIMIT 200`, isAdmin ? [tenantId] : [tenantId, user.id]);
}
export async function unreadForClinic(tenantId, user, isAdmin) {
  return T.pq(`SELECT id, subject FROM tickets WHERE tenant_id = ? AND unread_client = 1 ${isAdmin ? '' : 'AND user_id = ?'} ORDER BY updated_at DESC LIMIT 5`, isAdmin ? [tenantId] : [tenantId, user.id]);
}
export const canSee = (tk, tenantId, user, isAdmin) => !!tk && tk.tenant_id === tenantId && (isAdmin || tk.user_id === user.id);

// ---------- escrita ----------
const seal = (t) => T.seal({ t: String(t || '') });
export async function create(t, user, { category, priority, subject, body, page, files }) {
  await migrate();
  const cat = CATEGORIES[category] ? category : 'suporte'; const pri = PRIORITIES[priority] ? priority : 'normal';
  const subj = String(subject || '').trim().slice(0, 160); const text = String(body || '').trim().slice(0, 8000);
  if (subj.length < 4) throw new Error('Escreva um assunto (pelo menos 4 letras).');
  if (text.length < 10) throw new Error('Descreva o que aconteceu (pelo menos 10 letras).');
  const r = await T.pq('INSERT INTO tickets (tenant_id, user_id, user_name, user_email, user_phone, category, priority, subject, page) VALUES (?,?,?,?,?,?,?,?,?)',
    [t.id, user.id, String(user.name || '').slice(0, 120), String(user.email || '').slice(0, 190) || null, String(user.phone || '').slice(0, 40) || null, cat, pri, subj, String(page || '').slice(0, 200) || null]);
  const id = r.insertId;
  const m = await T.pq('INSERT INTO ticket_messages (ticket_id, author_type, author_name, body_enc) VALUES (?,?,?,?)', [id, 'cliente', user.name || null, seal(text)]);
  await saveFiles(id, m.insertId, files || []);
  notifyTeam(id, 'novo').catch(() => {});
  return id;
}
export async function clientReply(tk, user, { body, files }) {
  const text = String(body || '').trim().slice(0, 8000);
  if (text.length < 2 && !(files || []).length) throw new Error('Escreva a mensagem.');
  if (tk.status === 'fechado') throw new Error('Este chamado está fechado. Abra um novo chamado.');
  const m = await T.pq('INSERT INTO ticket_messages (ticket_id, author_type, author_name, body_enc) VALUES (?,?,?,?)', [tk.id, 'cliente', user.name || null, seal(text || '(anexo)')]);
  await saveFiles(tk.id, m.insertId, files || []);
  // resposta da clínica volta o chamado para a fila da equipe (inclusive se estava resolvido)
  await T.pq("UPDATE tickets SET status = 'aberto', unread_team = 1, unread_client = 0, last_from = 'cliente', updated_at = NOW(), resolved_at = NULL WHERE id = ?", [tk.id]);
  notifyTeam(tk.id, 'resposta').catch(() => {});
}
export async function clientSetStatus(tk, status) {
  if (status === 'resolvido' && OPEN_STATES.includes(tk.status)) {
    await T.pq("UPDATE tickets SET status = 'resolvido', resolved_at = NOW(), updated_at = NOW(), unread_client = 0 WHERE id = ?", [tk.id]);
    await system(tk.id, 'A clínica marcou o chamado como resolvido.');
  } else if (status === 'aberto' && tk.status === 'resolvido') {
    await T.pq("UPDATE tickets SET status = 'aberto', resolved_at = NULL, unread_team = 1, updated_at = NOW() WHERE id = ?", [tk.id]);
    await system(tk.id, 'A clínica reabriu o chamado.');
    notifyTeam(tk.id, 'reaberto').catch(() => {});
  }
}
export async function rate(tk, rating, comment) {
  const n = Math.round(Number(rating));
  if (!(n >= 1 && n <= 5) || !['resolvido', 'fechado'].includes(tk.status)) return;
  await T.pq('UPDATE tickets SET rating = ?, rating_comment = ? WHERE id = ?', [n, String(comment || '').trim().slice(0, 500) || null, tk.id]);
}
export async function markReadClient(id) { await T.pq('UPDATE tickets SET unread_client = 0 WHERE id = ?', [id]); }
export async function markReadTeam(id) { await T.pq('UPDATE tickets SET unread_team = 0 WHERE id = ?', [id]); }
async function system(id, text) { await T.pq('INSERT INTO ticket_messages (ticket_id, author_type, author_name, body_enc) VALUES (?,?,?,?)', [id, 'sistema', 'Mentez', seal(text)]); }

// Equipe: resposta (visível para a clínica) ou nota interna (só a equipe vê)
export async function teamReply(tk, admin, { body, files, internal, status, whatsapp, phone }) {
  const text = String(body || '').trim().slice(0, 8000);
  if (text.length < 2) throw new Error('Escreva a mensagem.');
  const m = await T.pq('INSERT INTO ticket_messages (ticket_id, author_type, author_name, body_enc, internal) VALUES (?,?,?,?,?)', [tk.id, 'equipe', admin.name || 'Equipe Mentez', seal(text), internal ? 1 : 0]);
  await saveFiles(tk.id, m.insertId, files || []);
  if (internal) { await T.pq('UPDATE tickets SET updated_at = NOW() WHERE id = ?', [tk.id]); return { notified: [] }; }
  const next = STATUS[status] ? status : 'aguardando';
  await T.pq(`UPDATE tickets SET status = ?, unread_client = 1, unread_team = 0, last_from = 'equipe', updated_at = NOW(), first_response_at = COALESCE(first_response_at, NOW()),
    resolved_at = ${next === 'resolvido' ? 'NOW()' : 'NULL'}, closed_at = ${next === 'fechado' ? 'NOW()' : 'NULL'}, assignee = COALESCE(assignee, ?) WHERE id = ?`, [next, admin.email || null, tk.id]);
  // número escolhido na resposta: fica guardado no chamado para as próximas
  const ph = String(phone || '').replace(/\D/g, '');
  if (whatsapp && ph.length >= 10 && ph !== String(tk.user_phone || '').replace(/\D/g, '')) await T.pq('UPDATE tickets SET user_phone = ? WHERE id = ?', [ph, tk.id]);
  return { notified: await notifyClient(tk.id, text, { whatsapp, phone: ph.length >= 10 ? ph : null }) };
}
export async function teamUpdate(tk, admin, { status, priority, category, assignee, assigneeName }) {
  const sets = []; const vals = []; const log = [];
  if (STATUS[status] && status !== tk.status) { sets.push('status = ?', `resolved_at = ${status === 'resolvido' ? 'NOW()' : 'resolved_at'}`, `closed_at = ${status === 'fechado' ? 'NOW()' : 'NULL'}`); vals.push(status); log.push(`situação: ${STATUS[status][1]}`); }
  if (PRIORITIES[priority] && priority !== tk.priority) { sets.push('priority = ?'); vals.push(priority); log.push(`prioridade: ${PRIORITY_SHORT[priority]}`); }
  if (CATEGORIES[category] && category !== tk.category) { sets.push('category = ?'); vals.push(category); log.push(`categoria: ${CATEGORIES[category]}`); }
  if (assignee !== undefined && (assignee || null) !== (tk.assignee || null)) { sets.push('assignee = ?'); vals.push(assignee || null); log.push(assignee ? `responsável: ${assigneeName || assignee}` : 'sem responsável'); }
  if (!sets.length) return null;
  await T.pq(`UPDATE tickets SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`, [...vals, tk.id]);
  await T.pq('INSERT INTO ticket_messages (ticket_id, author_type, author_name, body_enc, internal) VALUES (?,?,?,?,1)', [tk.id, 'sistema', admin.name || 'Equipe', seal(`${admin.name || 'Equipe'} alterou ${log.join(' · ')}.`)]);
  return log;
}

// ---------- painel ----------
export async function listForTeam({ status = 'abertos', category = '', tenant = '', assignee = '', q = '' } = {}) {
  const w = []; const p = [];
  if (status === 'abertos') w.push("t.status IN ('aberto','andamento','aguardando')");
  else if (STATUS[status]) { w.push('t.status = ?'); p.push(status); }
  if (CATEGORIES[category]) { w.push('t.category = ?'); p.push(category); }
  if (Number(tenant)) { w.push('t.tenant_id = ?'); p.push(Number(tenant)); }
  if (assignee === '-') w.push('t.assignee IS NULL'); else if (assignee) { w.push('t.assignee = ?'); p.push(assignee); }
  if (q) { const id = Number(String(q).replace(/\D/g, '')); w.push(`(t.subject LIKE ? OR n.name LIKE ? OR t.user_name LIKE ?${id ? ' OR t.id = ?' : ''})`); p.push(`%${q}%`, `%${q}%`, `%${q}%`, ...(id ? [id] : [])); }
  return T.pq(`SELECT t.*, n.name tenant_name, TIMESTAMPDIFF(HOUR, t.updated_at, NOW()) idle_h FROM tickets t LEFT JOIN tenants n ON n.id = t.tenant_id ${w.length ? `WHERE ${w.join(' AND ')}` : ''}
    ORDER BY t.unread_team DESC, FIELD(t.priority,'urgente','alta','normal'), FIELD(t.status,'aberto','andamento','aguardando','resolvido','fechado'), t.updated_at ${status === 'abertos' ? 'ASC' : 'DESC'} LIMIT 300`, p);
}
export async function teamCounts() {
  await migrate();
  const r = await T.pone("SELECT SUM(unread_team = 1 AND status IN ('aberto','andamento','aguardando')) novos, SUM(status IN ('aberto','andamento')) fila, SUM(status = 'aguardando') aguardando, SUM(priority = 'urgente' AND status IN ('aberto','andamento')) urgentes FROM tickets");
  const s = await T.pone("SELECT AVG(TIMESTAMPDIFF(MINUTE, created_at, first_response_at)) resp, AVG(rating) nota, COUNT(rating) notas FROM tickets WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)");
  return { novos: Number(r?.novos || 0), fila: Number(r?.fila || 0), aguardando: Number(r?.aguardando || 0), urgentes: Number(r?.urgentes || 0), resp: s?.resp == null ? null : Number(s.resp), nota: s?.nota == null ? null : Number(s.nota), notas: Number(s?.notas || 0) };
}

// ---------- avisos ----------
const PANEL = () => `https://app.${T.baseDomain()}`;
async function notifyTeam(id, kind) {
  const c = await config(); const tk = await get(id); if (!tk) return;
  const what = { novo: 'Novo chamado', resposta: 'A clínica respondeu', reaberto: 'Chamado reaberto' }[kind] || 'Chamado';
  const text = `${what} ${code(id)} — ${tk.tenant_name || 'clínica'}\n${CATEGORIES[tk.category]} · prioridade ${PRIORITY_SHORT[tk.priority]}\nAssunto: ${tk.subject}\nAberto por: ${tk.user_name || '—'}`;
  if (c.notifyEmail) await PlatComm.mailSend(c.notifyEmail, `[Chamado ${code(id)}] ${tk.subject} — ${tk.tenant_name || ''}`, text, { label: 'Abrir no painel', url: `${PANEL()}/chamados/${id}` }).catch((e) => console.error('chamados (e-mail):', e.message));
  if (c.notifyPhone && (kind === 'novo' || tk.priority !== 'normal')) await PlatComm.waSend(c.notifyPhone, `${text}\n\n${PANEL()}/chamados/${id}`, { kind: 'equipe' }).catch((e) => console.error('chamados (WhatsApp):', e.message));
}
async function notifyClient(id, text, { whatsapp, phone } = {}) {
  const tk = await get(id); if (!tk) return [];
  const t = await T.bySlug(tk.tenant_slug); const url = `${t?.env?.PUBLIC_URL || ''}/suporte/${id}`;
  const first = String(tk.user_name || '').split(' ')[0] || 'tudo bem';
  const short = text.length > 600 ? `${text.slice(0, 600)}…` : text;
  const msg = `Olá, ${first}! A equipe Mentez respondeu o seu chamado ${code(id)} — “${tk.subject}”:\n\n${short}`;
  const out = [];
  if (tk.user_email) { try { await PlatComm.mailSend(tk.user_email, `Mentez — resposta ao chamado ${code(id)}: ${tk.subject}`, `${msg}\n\nPara responder, abra o chamado no sistema.`, { label: 'Ver e responder', url }); out.push('e-mail'); } catch (e) { console.error('chamados (e-mail cliente):', e.message); } }
  const to = phone || tk.user_phone;
  if (whatsapp && to) { try { await PlatComm.waSend(to, `${msg}\n\nPara responder: ${url}`, { kind: 'chamado', tenantId: tk.tenant_id }); out.push('WhatsApp'); } catch (e) { console.error('chamados (WhatsApp cliente):', e.message); } }
  return out;
}

// ---------- rotina: resolve chamados sem resposta da clínica e fecha os resolvidos antigos ----------
export async function tick() {
  await migrate(); const c = await config();
  for (const r of await T.pq("SELECT id FROM tickets WHERE status = 'aguardando' AND updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)", [c.autoResolveDays])) {
    await T.pq("UPDATE tickets SET status = 'resolvido', resolved_at = NOW(), updated_at = NOW() WHERE id = ?", [r.id]);
    await system(r.id, `Marcado como resolvido automaticamente: sem resposta da clínica em ${c.autoResolveDays} dias. Se precisar, é só responder para reabrir.`);
  }
  await T.pq("UPDATE tickets SET status = 'fechado', closed_at = NOW() WHERE status = 'resolvido' AND resolved_at < DATE_SUB(NOW(), INTERVAL ? DAY)", [c.autoCloseDays]);
}
