import express from 'express';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDate, brDateTime, money, waLink } from '../lib/html.js';
import { router, send, int, str, dec } from '../lib/router.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { ownOnly, can, forbidden } from '../lib/perm.js';
import { todayLocal, isYmd, nowLocal } from '../lib/time.js';
import * as CRM from '../lib/crm.js';
import * as WA from '../lib/whatsapp.js';

const r = router();
const dtxt = (enc) => { try { return decrypt(enc); } catch { return ''; } };

// Psicólogo(a) colaborador(a) vê só os cards dos próprios pacientes ou sob sua responsabilidade.
function scope(user) {
  return ownOnly(user) ? { sql: ' AND (p.owner_id = ? OR c.responsible_id = ?) ', params: [user.id, user.id] } : { sql: ' ', params: [] };
}
async function loadCard(req, id) {
  const sc = scope(req.user);
  const card = await one(`SELECT c.*, s.name stage_name, s.auto_key, p.owner_id FROM crm_cards c JOIN crm_stages s ON s.id = c.stage_id LEFT JOIN patients p ON p.id = c.patient_id WHERE c.id = ? ${sc.sql}`, [id, ...sc.params]);
  if (!card && (await one('SELECT id FROM crm_cards WHERE id = ?', [id]))) throw forbidden();
  return card;
}
function ago(dt) {
  if (!dt) return '';
  const m = Math.round((Date.now() - new Date(`${String(dt).replace(' ', 'T')}-03:00`)) / 60000);
  if (m < 1) return 'agora'; if (m < 60) return `${m} min`; if (m < 1440) return `${Math.round(m / 60)} h`;
  return `${Math.round(m / 1440)} d`;
}
async function lastMessage(card) {
  const last8 = String(card.phone_key || '').slice(-8);
  if (!last8 && !card.patient_id) return null;
  const rows = await q(`SELECT direction, body_enc, kind, created_at, phone FROM wa_messages WHERE (patient_id <=> ? AND ? IS NOT NULL) OR phone LIKE ? ORDER BY id DESC LIMIT 5`, [card.patient_id, card.patient_id, `%${last8}`]);
  const m = rows.find((x) => !card.phone_key || WA.phoneKey(x.phone) === card.phone_key || x.direction === 'out');
  return m ? { ...m, text: dtxt(m.body_enc) } : null;
}
// “556281234567” → “(62) 98123-4567” (repõe o 9 dos celulares)
function fmtPhone(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : (phone || '');
}
const initials = (n) => String(n || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

// ---------- quadro ----------
r.get('/', async (req, res) => {
  const stages = await CRM.stages();
  const sc = scope(req.user);
  const busca = str(req.query.q, 80); const resp = req.query.resp; const tag = str(req.query.tag, 40); const venc = req.query.venc === '1';
  const where = ['c.archived = 0' + sc.sql]; const params = [...sc.params];
  if (busca) { where.push('(c.name LIKE ? OR c.phone LIKE ?)'); params.push(`%${busca}%`, `%${busca.replace(/\D/g, '') || busca}%`); }
  if (resp === 'meus') { where.push('c.responsible_id = ?'); params.push(req.user.id); } else if (int(resp)) { where.push('c.responsible_id = ?'); params.push(int(resp)); }
  if (tag) { where.push('FIND_IN_SET(?, REPLACE(c.tags, ", ", ","))'); params.push(tag); }
  if (venc) { where.push('c.next_action_at IS NOT NULL AND c.next_action_at <= ?'); params.push(todayLocal()); }
  const cards = await q(`SELECT c.*, u.name resp_name, p.owner_id, ag.status agent_status FROM crm_cards c LEFT JOIN users u ON u.id = c.responsible_id
    LEFT JOIN patients p ON p.id = c.patient_id LEFT JOIN agent_conversations ag ON ag.phone_key = c.phone_key
    WHERE ${where.join(' AND ')} ORDER BY c.position, c.id DESC LIMIT 600`, params);
  for (const c of cards) c.last = await lastMessage(c);
  const users = await q("SELECT id, name FROM users WHERE active = 1 AND role IN ('admin','psicologo','secretaria') ORDER BY name");
  const tags = [...new Set(cards.flatMap((c) => String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean)))].sort();
  const today = todayLocal();
  const cfg = await CRM.config();

  send(res, page(req, {
    title: 'CRM', active: 'crm',
    body: html`
    <header class="ph"><div><p class="eyebrow">WhatsApp</p><h1>CRM de atendimentos</h1></div>
      <div class="ph-actions"><button type="button" class="btn ghost" data-toggle="#novo-card">+ Card</button>${can(req.user, 'usuarios') ? html`<a class="btn ghost" href="/crm/etapas">Etapas</a>` : ''}<a class="btn ghost" href="/atendimento">Conversas do atendente</a></div></header>
    <form method="post" action="/crm/novo" class="card form-grid" id="novo-card" hidden>
      <label class="fld"><span>Nome</span><input name="name" required maxlength="160"></label>
      <label class="fld"><span>WhatsApp</span><input name="phone" inputmode="tel" placeholder="(62) 9 0000-0000"></label>
      <label class="fld"><span>Etapa</span><select name="stage_id">${stages.map((s) => html`<option value="${s.id}">${s.name}</option>`)}</select></label>
      <label class="fld"><span>Etiquetas (separadas por vírgula)</span><input name="tags" maxlength="255" placeholder="Instagram, indicação"></label>
      <div class="span2 actions"><button class="btn">Criar card</button></div>
    </form>
    <form class="filters crm-filters" method="get">
      <input type="search" name="q" value="${busca}" placeholder="Buscar nome ou telefone">
      <select name="resp"><option value="">Todos os responsáveis</option><option value="meus" ${resp === 'meus' ? raw('selected') : ''}>Meus cards</option>${users.map((u) => html`<option value="${u.id}" ${String(u.id) === resp ? raw('selected') : ''}>${u.name}</option>`)}</select>
      ${tags.length ? html`<select name="tag"><option value="">Todas as etiquetas</option>${tags.map((t) => html`<option ${t === tag ? raw('selected') : ''}>${t}</option>`)}</select>` : ''}
      <label class="fld check"><input type="checkbox" name="venc" value="1" ${venc ? raw('checked') : ''}><span>Próxima ação vencida</span></label>
      <button class="btn ghost">Filtrar</button>
    </form>
    <div class="kanban" data-kanban ${can(req.user, 'usuarios') ? raw('data-col-sort') : ''} data-stages="${JSON.stringify(stages.map((x) => ({ id: x.id, name: x.name, color: x.color })))}" data-users="${JSON.stringify(users.map((u) => ({ id: u.id, name: u.name })))}" data-me="${req.user.id}" data-cadastro="${can(req.user, 'cadastro') ? 1 : 0}">
      ${stages.map((s) => {
        const list = cards.filter((c) => c.stage_id === s.id);
        const total = list.reduce((a, c) => a + Number(c.value || 0), 0);
        return html`<section class="kcol" data-stage="${s.id}" style="--stage:${s.color}">
          <header class="kcol-h" ${can(req.user, 'usuarios') ? raw('draggable="true" data-col-drag title="Arraste para mudar a posição da etapa"') : ''}>${can(req.user, 'usuarios') ? html`<span class="kgrip" aria-hidden="true">⠿</span>` : ''}<span class="kdot"></span><b>${s.name}</b><span class="kcount">${list.length}</span>${total ? html`<small>${money(total)}</small>` : ''}</header>
          <div class="kcards" data-drop>
            ${list.map((c) => {
              const late = c.next_action_at && String(c.next_action_at).slice(0, 10) <= today;
              const waiting = c.last_direction === 'in' && c.last_message_at && (Date.now() - new Date(`${String(c.last_message_at).replace(' ', 'T')}-03:00`)) > 60 * 60e3;
              return html`<a class="kcard" href="/crm/${c.id}" draggable="true" data-card="${c.id}" data-ctx="card" data-id="${c.id}" data-name="${c.name}" data-stage="${c.stage_id}" data-resp="${c.responsible_id || ''}" data-pid="${c.patient_id || ''}" data-phone="${c.phone ? String(c.phone).replace(/\D/g, '') : ''}" data-agent="${c.phone_key ? c.agent_status || 'ativo' : ''}" data-tags="${c.tags || ''}">
                <button type="button" class="ctx-btn" data-ctx-open aria-label="Mais ações">⋯</button>
                <div class="kcard-h"><b>${c.name}</b>${c.resp_name ? html`<span class="kav" title="${c.resp_name}">${initials(c.resp_name)}</span>` : ''}</div>
                <div class="kmeta">${s.auto_key === 'equipe' && !c.patient_id ? html`<span class="ktag eq">equipe</span>` : c.patient_id ? html`<span class="ktag pac">paciente</span>` : html`<span class="ktag lead">novo</span>`}${c.agent_status === 'humano' ? html`<span class="ktag hum">humano</span>` : ''}${String(c.tags || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 3).map((t) => html`<span class="ktag">${t}</span>`)}</div>
                ${c.last ? html`<p class="klast ${c.last.direction}">${c.last.direction === 'in' ? '⬅' : '➡'} ${c.last.text.slice(0, 90)}</p>` : ''}
                <div class="kfoot">${c.last_message_at ? html`<span class="${waiting ? 'kwait' : ''}">${waiting ? '⏳ ' : ''}${ago(c.last_message_at)}</span>` : html`<span></span>`}
                  ${c.next_action_at ? html`<span class="${late ? 'klate' : ''}">📌 ${brDate(c.next_action_at).slice(0, 5)}${c.next_action ? ` · ${c.next_action.slice(0, 24)}` : ''}</span>` : ''}${c.value ? html`<span>${money(c.value)}</span>` : ''}</div>
              </a>`;
            })}
          </div></section>`;
      })}
    </div>
    <p class="muted small">Arraste os cards entre as colunas${can(req.user, 'usuarios') ? ' e as etapas pelo título para mudar a posição' : ''}. Os cards também andam sozinhos: transferência para humano, link de e-book enviado, sessão agendada e sessão realizada. O WhatsApp da equipe que recebe o atendimento humano fica na etapa “Equipe WhatsApp”. Depois de mover à mão, o card fica ${raw('<b>3 dias</b>')} sem movimentos automáticos (exceto “Aguardando humano”).
      ${can(req.user, 'usuarios') ? html`<form method="post" action="/crm/config" style="display:inline"> · <label><input type="checkbox" name="capture" value="1" ${cfg.capture ? raw('checked') : ''} data-autosubmit-check> criar cards também para quem ainda não é paciente</label></form>` : ''}</p>`,
  }));
});

// ---------- mover (arrastar) ----------
r.post('/mover', express.json({ limit: '5kb' }), async (req, res) => {
  const card = await loadCard(req, int(req.body?.card));
  if (!card) return res.status(404).json({ ok: false });
  const ok = await CRM.moveManual(card.id, int(req.body?.stage), int(req.body?.before), req.user.id);
  res.json({ ok });
});

r.post('/etapas/ordem', express.json({ limit: '5kb' }), async (req, res) => {
  if (!can(req.user, 'usuarios')) return res.status(403).json({ ok: false });
  const ok = await CRM.reorderStages(Array.isArray(req.body?.order) ? req.body.order : []);
  if (ok) await audit(req, 'crm-etapas', 'ordem');
  res.status(ok ? 200 : 400).json({ ok });
});

r.post('/config', async (req, res) => {
  if (!can(req.user, 'usuarios')) throw forbidden();
  await CRM.saveConfig({ ...(await CRM.config()), capture: !!req.body.capture });
  res.flash('Configuração do CRM salva.').redirect('/crm');
});

// ---------- novo card manual ----------
r.post('/novo', async (req, res) => {
  const name = str(req.body.name, 160);
  if (!name) return res.flash('Informe o nome.', 'err').redirect('/crm');
  const phone = str(req.body.phone, 30);
  const key = WA.phoneKey(phone);
  if (key && (await one('SELECT id FROM crm_cards WHERE phone_key = ?', [key]))) return res.flash('Já existe um card com este WhatsApp.', 'err').redirect('/crm');
  // Etapa inexistente ou não informada: entra na primeira etapa do quadro.
  const stage = (await one('SELECT id FROM crm_stages WHERE id = ?', [int(req.body.stage_id)]))?.id || (await one('SELECT id FROM crm_stages ORDER BY position LIMIT 1'))?.id;
  if (!stage) return res.flash('Crie uma etapa no CRM antes de adicionar cards.', 'err').redirect('/crm');
  const ins = await q("INSERT INTO crm_cards (phone_key, phone, name, stage_id, position, tags, responsible_id, source) VALUES (?,?,?,?,-1000,?,?, 'manual')",
    [key, phone || null, name, stage, str(req.body.tags, 255) || null, req.user.id]);
  await CRM.logEvent(ins.insertId, 'criado', 'Card criado manualmente', req.user.id);
  res.flash('Card criado.').redirect(`/crm/${ins.insertId}`);
});

// ---------- etapas (administração) ----------
r.get('/etapas', async (req, res) => {
  if (!can(req.user, 'usuarios')) throw forbidden();
  const stages = await q('SELECT s.*, (SELECT COUNT(*) FROM crm_cards c WHERE c.stage_id = s.id AND c.archived = 0) n FROM crm_stages s ORDER BY position, id');
  if (!stages.length) { await CRM.ensureStages(); return res.redirect('/crm/etapas'); }
  send(res, page(req, {
    title: 'Etapas do CRM', active: 'crm',
    body: html`<header class="ph"><div><p class="eyebrow">CRM</p><h1>Etapas do funil</h1></div><div class="ph-actions"><a class="btn ghost" href="/crm">Voltar ao quadro</a></div></header>
    <form method="post" action="/crm/etapas" class="card">
      <div class="stage-list" data-stage-sort>${stages.map((s, i) => html`<div class="stage-row" data-stage-row>
        <span class="kgrip" title="Arraste para mudar a posição" aria-hidden="true">⠿</span>
        <input type="hidden" name="id[]" value="${s.id}">
        <input type="color" name="color[]" value="${s.color}" aria-label="Cor">
        <input name="name[]" value="${s.name}" maxlength="60" required aria-label="Nome">
        <input type="number" name="pos[]" value="${i + 1}" min="1" max="99" aria-label="Ordem" class="pos">
        <small class="muted">${s.auto_key ? `automática (${s.auto_key})` : 'personalizada'} · ${s.n} card(s)</small>
        ${!s.auto_key && !Number(s.n) ? html`<label class="check small"><input type="checkbox" name="del[]" value="${s.id}"> excluir</label>` : ''}
      </div>`)}</div>
      <h3 class="esc-sub">Nova etapa</h3>
      <div class="stage-row"><input type="color" name="new_color" value="#634331"><input name="new_name" maxlength="60" placeholder="Ex.: Retorno pós-alta"><input type="number" name="new_pos" value="${stages.length + 1}" class="pos"></div>
      <div class="actions" style="margin-top:14px"><button class="btn">Salvar etapas</button></div>
      <p class="muted small">Arraste as etapas pelo ⠿ (ou mude o número) para trocar a ordem. Etapas automáticas recebem os cards pelos eventos do sistema; você pode renomeá-las, mudar a cor e a ordem. Etapas personalizadas só recebem cards movidos à mão.</p>
    </form>`,
  }));
});

r.post('/etapas', async (req, res) => {
  if (!can(req.user, 'usuarios')) throw forbidden();
  const b = req.body; const arr = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]);
  const ids = arr(b.id), names = arr(b.name), colors = arr(b.color), pos = arr(b.pos);
  const del = new Set(arr(b.del).map(Number));
  for (let i = 0; i < ids.length; i++) {
    const id = int(ids[i]);
    if (del.has(id)) { await q('DELETE FROM crm_stages WHERE id = ? AND auto_key IS NULL AND NOT EXISTS (SELECT 1 FROM crm_cards WHERE stage_id = ?)', [id, id]); continue; }
    await q('UPDATE crm_stages SET name = ?, color = ?, position = ? WHERE id = ?', [str(names[i], 60) || 'Etapa', /^#[0-9a-f]{6}$/i.test(colors[i]) ? colors[i] : '#9c4422', int(pos[i]) || i, id]);
  }
  if (str(b.new_name, 60)) await q('INSERT INTO crm_stages (name, color, position) VALUES (?,?,?)', [str(b.new_name, 60), /^#[0-9a-f]{6}$/i.test(b.new_color) ? b.new_color : '#634331', int(b.new_pos) || 99]);
  await audit(req, 'crm-etapas');
  res.flash('Etapas salvas.').redirect('/crm/etapas');
});

// ---------- card ----------
// Foto do WhatsApp do contato (ou as iniciais, quando não há foto pública)
const PALETTE = ['#a4532f', '#7a5a43', '#5f7a52', '#8a6a2f', '#6b4f6e', '#3f6b72'];
r.get('/:id/foto', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  const ph = card.phone ? await WA.profilePhoto(card.phone) : null;
  res.set({ 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  if (ph) return res.type(ph.mime).send(ph.data);
  const ini = initials(card.name) || '?';
  const bg = PALETTE[[...String(card.name)].reduce((a, ch) => a + ch.charCodeAt(0), 0) % PALETTE.length];
  const esc = (t) => t.replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[m]);
  res.type('image/svg+xml').send(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" fill="${bg}"/><text x="48" y="50" dy=".35em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="38" font-weight="600" fill="#fff">${esc(ini)}</text></svg>`);
});

r.get('/:id', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  const [stages, users, events] = await Promise.all([
    CRM.stages(),
    q("SELECT id, name FROM users WHERE active = 1 AND role IN ('admin','psicologo','secretaria') ORDER BY name"),
    q('SELECT e.*, u.name uname FROM crm_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.card_id = ? ORDER BY e.id DESC LIMIT 100', [card.id]),
  ]);
  const last8 = String(card.phone_key || '').slice(-8);
  const msgs = (card.phone_key || card.patient_id) ? (await q(`SELECT m.*, u.name uname FROM wa_messages m LEFT JOIN users u ON u.id = m.user_id
      WHERE (m.patient_id <=> ? AND ? IS NOT NULL) OR (? <> '' AND m.phone LIKE ?) ORDER BY m.id DESC LIMIT 150`, [card.patient_id, card.patient_id, last8, `%${last8}`]))
    .filter((m) => !card.phone_key || m.patient_id === card.patient_id || WA.phoneKey(m.phone) === card.phone_key) : [];
  const KIND_LABEL = { aniversario: 'Aniversário', pesquisa: 'Pesquisa de satisfação', agente: 'Atendente virtual', lembrete: 'Lembrete automático', aviso: 'Aviso automático', agendamento: 'Confirmação de agendamento', confirmacao: 'Confirmação', remarcacao: 'Remarcação', exercicio: 'Exercício', pagamento: 'Pagamento', cobranca: 'Cobrança', lista_espera: 'Lista de espera' };
  // Conversa em ordem cronológica (a mais recente embaixo, como no WhatsApp).
  const timeline = [
    ...msgs.map((m) => ({ at: m.created_at, kind: 'msg', dir: m.direction, text: dtxt(m.body_enc),
      label: m.direction === 'in' ? '' : m.kind === 'manual' ? `Equipe${m.uname ? ` · ${m.uname}` : ''}` : (KIND_LABEL[m.kind] || m.kind), err: m.status === 'erro' ? m.error : null })),
    ...events.filter((e) => e.type !== 'mensagem').map((e) => ({ at: e.created_at, kind: e.type === 'nota' ? 'nota' : 'ev', text: e.text_enc ? dtxt(e.text_enc) : '', label: e.uname || 'Sistema' })),
  ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const today = todayLocal(); const yest = new Date(Date.now() - 3 * 3600e3 - 864e5).toISOString().slice(0, 10);
  const dayLabel = (d) => (d === today ? 'Hoje' : d === yest ? 'Ontem' : brDate(d));
  let lastDay = '';
  const agent = card.phone_key ? await one('SELECT id, status, human_reason FROM agent_conversations WHERE phone_key = ?', [card.phone_key]) : null;
  const waOn = WA.ready(await WA.config());
  const wa = waLink(card.phone, '');
  await audit(req, 'crm-ver', `card:${card.id}`);

  send(res, page(req, {
    title: card.name, active: 'crm',
    body: html`<header class="ph"><div><p class="eyebrow">CRM · ${card.stage_name}</p><h1>${card.name}</h1><p class="muted">${card.phone ? fmtPhone(card.phone) : 'sem telefone'}${card.patient_id ? ' · paciente' : ' · novo contato'}</p></div>
      <div class="ph-actions">
        ${wa ? html`<a class="btn ghost" href="${wa}" target="_blank" rel="noopener">Abrir no WhatsApp</a>` : ''}
        ${card.patient_id ? html`<a class="btn ghost" href="/pacientes/${card.patient_id}">Ficha do paciente</a>` : can(req.user, 'cadastro') ? html`<form method="post" action="/crm/${card.id}/paciente"><button class="btn ghost">Cadastrar como paciente</button></form>` : ''}
        ${agent ? html`<a class="btn ghost" href="/atendimento/${agent.id}">Conversa do atendente</a>` : ''}
        <a class="btn ghost" href="/crm">Quadro</a></div></header>
    ${agent?.status === 'humano' ? html`<div class="flash warn">Atendente virtual pausado neste contato: ${agent.human_reason || 'atendimento humano'}. <form method="post" action="/atendimento/${agent.id}/retomar" style="display:inline"><button class="link btnlink">Devolver ao atendente virtual</button></form></div>` : ''}
    <div class="grid2 crm-detail">
      <div>
        <form method="post" action="/crm/${card.id}" class="card form-grid">
          <h2 class="span2">Dados do card</h2>
          <label class="fld span2"><span>Etapa</span><select name="stage_id">${stages.map((s) => html`<option value="${s.id}" ${s.id === card.stage_id ? raw('selected') : ''}>${s.name}</option>`)}</select></label>
          <label class="fld"><span>Nome</span><input name="name" value="${card.name}" maxlength="160" required></label>
          <label class="fld"><span>Responsável</span><select name="responsible_id"><option value="">—</option>${users.map((u) => html`<option value="${u.id}" ${u.id === card.responsible_id ? raw('selected') : ''}>${u.name}</option>`)}</select></label>
          <label class="fld"><span>Etiquetas</span><input name="tags" value="${card.tags || ''}" maxlength="255" placeholder="Instagram, indicação, ansiedade"></label>
          <label class="fld"><span>Valor potencial (R$)</span><input name="value" inputmode="decimal" value="${card.value ? String(card.value).replace('.', ',') : ''}"></label>
          <label class="fld"><span>Próxima ação</span><input name="next_action" value="${card.next_action || ''}" maxlength="160" placeholder="Ex.: retornar sobre horário"></label>
          <label class="fld"><span>Data da próxima ação</span><input type="date" name="next_action_at" value="${card.next_action_at ? String(card.next_action_at).slice(0, 10) : ''}"></label>
          <label class="fld span2"><span>Anotações (criptografadas, sem conteúdo clínico)</span><textarea name="notes" rows="4" maxlength="4000">${card.notes_enc ? dtxt(card.notes_enc) : ''}</textarea></label>
          <div class="span2 actions"><button class="btn">Salvar</button></div>
        </form>
        <form method="post" action="/crm/${card.id}/arquivar" class="danger-zone" data-confirm="Arquivar este card? Ele volta sozinho se o contato mandar nova mensagem."><button class="btn danger">Arquivar card</button></form>
      </div>
      <section class="card chat">
        <header class="chat-h"><div class="chat-who"><img class="chat-av" src="/crm/${card.id}/foto" alt="" width="42" height="42" loading="lazy"><span><b>${card.name}</b><small class="muted">${card.phone ? fmtPhone(card.phone) : 'sem telefone'}</small></span></div><small class="muted">Conversa</small></header>
        <div class="chat-body" data-chat-body>
          ${timeline.length ? timeline.map((t) => {
            const d = String(t.at).slice(0, 10);
            const sep = d !== lastDay ? html`<div class="chat-day"><span>${dayLabel(d)}</span></div>` : '';
            lastDay = d;
            const hm = String(t.at).slice(11, 16);
            if (t.kind === 'ev') return html`${sep}<div class="chat-ev"><span>${t.text.includes('→') ? `↪ ${t.text}` : t.text} · ${hm}</span></div>`;
            if (t.kind === 'nota') return html`${sep}<div class="bub note"><small class="bub-who">📝 Anotação interna · ${t.label}</small><p>${t.text}</p><span class="bub-time">${hm}</span></div>`;
            return html`${sep}<div class="bub ${t.dir === 'in' ? 'in' : 'out'} ${t.err ? 'err' : ''}">${t.label ? html`<small class="bub-who">${t.label}</small>` : ''}<p>${t.text}</p>
              <span class="bub-time">${hm}${t.dir === 'out' ? (t.err ? ' ⚠' : ' ✓') : ''}</span>${t.err ? html`<small class="bub-err">Não enviada: ${t.err}</small>` : ''}</div>`;
          }) : html`<p class="chat-empty">Nenhuma mensagem ainda.</p>`}
        </div>
        <form method="post" action="/crm/${card.id}/${card.phone && waOn ? 'mensagem' : 'nota'}" class="chat-compose" data-chat-compose>
          <textarea name="text" rows="1" maxlength="2000" required placeholder="${card.phone && waOn ? 'Digite uma mensagem' : 'Escreva uma anotação interna'}" data-autogrow></textarea>
          <button class="btn ghost chat-note" formaction="/crm/${card.id}/nota" title="Salvar como anotação interna (não envia ao contato)">📝 Anotar</button>
          ${card.phone && waOn ? html`<button class="btn chat-send" title="Enviar pelo WhatsApp (Enter)">Enviar ➤</button>` : ''}
        </form>
        ${card.phone && waOn ? html`<p class="chat-hint muted">Enter envia · Shift+Enter quebra a linha · ao responder por aqui o atendente virtual fica pausado neste contato.</p>` : ''}
      </section>
    </div>`,
  }));
});

r.post('/:id', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  const b = req.body;
  const stage = int(b.stage_id);
  if (stage && stage !== card.stage_id) await CRM.moveManual(card.id, stage, null, req.user.id);
  await q('UPDATE crm_cards SET name = ?, responsible_id = ?, tags = ?, value = ?, next_action = ?, next_action_at = ?, notes_enc = ? WHERE id = ?', [
    str(b.name, 160) || card.name, int(b.responsible_id) || null, str(b.tags, 255).split(',').map((t) => t.trim()).filter(Boolean).join(', ') || null,
    dec(b.value), str(b.next_action, 160) || null, isYmd(b.next_action_at) ? b.next_action_at : null, str(b.notes, 4000) ? encrypt(str(b.notes, 4000)) : null, card.id]);
  res.flash('Card atualizado.').redirect(`/crm/${card.id}`);
});

r.post('/:id/nota', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  const text = str(req.body.text, 2000);
  if (text) await CRM.logEvent(card.id, 'nota', text, req.user.id);
  res.redirect(`/crm/${card.id}`);
});

r.post('/:id/mensagem', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  const text = str(req.body.text, 2000);
  if (!text || !card.phone) return res.flash('Mensagem vazia ou contato sem telefone.', 'err').redirect(`/crm/${card.id}`);
  const r2 = await WA.send({ phone: card.phone, text, kind: 'manual', patient_id: card.patient_id, user_id: req.user.id });
  if (r2.ok) {
    // A equipe assumiu: pausa o atendente virtual neste contato.
    if (card.phone_key) await q("UPDATE agent_conversations SET status = 'humano', human_reason = ?, human_until = DATE_ADD(NOW(), INTERVAL 12 HOUR) WHERE phone_key = ?", [`Atendido por ${req.user.name} (CRM)`, card.phone_key]);
    await CRM.logEvent(card.id, 'mensagem', `Mensagem enviada por ${req.user.name}`, req.user.id);
  }
  await audit(req, 'crm-mensagem', `card:${card.id}`);
  res.flash(r2.ok ? 'Mensagem enviada.' : `Não enviada: ${r2.error}`, r2.ok ? 'ok' : 'err').redirect(`/crm/${card.id}`);
});

r.post('/:id/paciente', async (req, res, next) => {
  if (!can(req.user, 'cadastro')) throw forbidden();
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  if (card.patient_id) return res.redirect(`/pacientes/${card.patient_id}`);
  const owner = ownOnly(req.user) ? req.user.id : (await one("SELECT id FROM users WHERE active = 1 AND role = 'admin' ORDER BY id LIMIT 1"))?.id;
  const ins = await q("INSERT INTO patients (owner_id, name, phone, status, whatsapp_optin, notes_enc) VALUES (?,?,?, 'ativo', 1, ?)",
    [owner, card.name, card.phone, encrypt(`Cadastro criado a partir do CRM em ${brDate(todayLocal())}.`)]);
  await q('UPDATE crm_cards SET patient_id = ? WHERE id = ?', [ins.insertId, card.id]);
  if (card.phone_key) await q('UPDATE agent_conversations SET patient_id = ? WHERE phone_key = ?', [ins.insertId, card.phone_key]);
  await CRM.logEvent(card.id, 'paciente', 'Cadastrado como paciente', req.user.id);
  await audit(req, 'crm-converter', `card:${card.id} patient:${ins.insertId}`);
  res.flash('Paciente cadastrado. Complete os dados e o termo de consentimento.').redirect(`/pacientes/${ins.insertId}/editar`);
});

r.post('/:id/arquivar', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  await q('UPDATE crm_cards SET archived = 1 WHERE id = ?', [card.id]);
  await CRM.logEvent(card.id, 'arquivado', 'Card arquivado', req.user.id);
  res.flash('Card arquivado.').redirect(String(req.body.back || '').startsWith('/crm') ? req.body.back : '/crm');
});

// ---------- ações rápidas (menu do botão direito no quadro) ----------
const backOf = (req) => { const b = String(req.body.back || '/crm'); return b.startsWith('/') && !b.startsWith('//') ? b : '/crm'; };
r.post('/:id/responsavel', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  const u = int(req.body.user) ? await one("SELECT id, name FROM users WHERE id = ? AND active = 1", [int(req.body.user)]) : null;
  await q('UPDATE crm_cards SET responsible_id = ? WHERE id = ?', [u?.id || null, card.id]);
  await CRM.logEvent(card.id, 'responsavel', u ? `Responsável: ${u.name}` : 'Sem responsável', req.user.id);
  res.flash(u ? `${card.name}: responsável ${u.name}.` : `${card.name}: sem responsável.`).redirect(backOf(req));
});
r.post('/:id/etiqueta', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  const add = str(req.body.tag, 40).replace(/,/g, ' ').trim();
  if (!add) return res.redirect(backOf(req));
  const tags = String(card.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
  if (!tags.some((t) => t.toLowerCase() === add.toLowerCase())) tags.push(add);
  await q('UPDATE crm_cards SET tags = ? WHERE id = ?', [tags.join(', ').slice(0, 255), card.id]);
  res.flash(`Etiqueta “${add}” adicionada.`).redirect(backOf(req));
});
r.post('/:id/proxima', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  await q('UPDATE crm_cards SET next_action = ?, next_action_at = ? WHERE id = ?', [str(req.body.next_action, 160) || null, isYmd(req.body.next_action_at) ? req.body.next_action_at : null, card.id]);
  res.flash('Próxima ação salva.').redirect(backOf(req));
});
r.post('/:id/atendente', async (req, res, next) => {
  const card = await loadCard(req, int(req.params.id));
  if (!card) return next();
  if (!card.phone_key) return res.flash('Contato sem WhatsApp.', 'err').redirect(backOf(req));
  const cv = await one('SELECT id, status FROM agent_conversations WHERE phone_key = ?', [card.phone_key]);
  if (cv?.status === 'humano') {
    await q("UPDATE agent_conversations SET status = 'ativo', human_reason = NULL, human_until = NULL WHERE id = ?", [cv.id]);
    await CRM.logEvent(card.id, 'atendente', 'Devolvido ao atendente virtual', req.user.id);
    return res.flash('Atendente virtual retomado neste contato.').redirect(backOf(req));
  }
  if (cv) await q("UPDATE agent_conversations SET status = 'humano', human_reason = ?, human_until = DATE_ADD(NOW(), INTERVAL 12 HOUR) WHERE id = ?", [`Assumido por ${req.user.name} (CRM)`, cv.id]);
  else await q("INSERT INTO agent_conversations (phone_key, phone, contact_name, patient_id, status, human_reason, human_until) VALUES (?,?,?,?, 'humano', ?, DATE_ADD(NOW(), INTERVAL 12 HOUR))", [card.phone_key, card.phone, card.name, card.patient_id, `Assumido por ${req.user.name} (CRM)`]);
  await CRM.logEvent(card.id, 'atendente', `Atendente virtual pausado por ${req.user.name}`, req.user.id);
  res.flash('Atendente virtual pausado neste contato (12 horas).').redirect(backOf(req));
});

export default r;
