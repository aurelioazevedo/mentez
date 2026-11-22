// Painel Mentez → Chamados: fila de atendimento das clínicas (suporte, financeiro, reclamações…),
// resposta para a clínica (com aviso por e-mail e, se quiser, WhatsApp), notas internas, responsável, prioridade e indicadores.
import { html, raw, brDateTime } from '../lib/html.js';
import { send, str, int } from '../lib/router.js';
import * as T from '../lib/tenancy.js';
import * as Tickets from '../lib/tickets.js';
import * as PlatCRM from '../lib/platcrm.js';
import * as Brand from '../lib/brand.js';
import { thread, filesField, ticketBadge } from './support.js';

const ago = (h) => (h < 1 ? 'agora há pouco' : h < 24 ? `há ${h} h` : `há ${Math.floor(h / 24)} dia(s)`);
const mins = (m) => (m == null ? '—' : m < 60 ? `${Math.round(m)} min` : m < 1440 ? `${(m / 60).toFixed(1).replace('.', ',')} h` : `${(m / 1440).toFixed(1).replace('.', ',')} dias`);

export function mount(handle, { need, layout, log }) {
  handle.use(/^\/chamados(\/|$)/, (req, res, next) => { Tickets.migrate().then(() => next(), next); });

  handle.get('/chamados', need, async (req, res) => {
    const f = { status: str(req.query.status, 12) || 'abertos', category: str(req.query.categoria, 20), tenant: str(req.query.clinica, 10), assignee: str(req.query.resp, 190), q: str(req.query.q, 80) };
    const [rows, k, team, clinics, cfg] = await Promise.all([Tickets.listForTeam(f), Tickets.teamCounts(), T.pq('SELECT name, email FROM platform_users WHERE active = 1 ORDER BY name'), T.pq('SELECT DISTINCT n.id, n.name FROM tickets t JOIN tenants n ON n.id = t.tenant_id ORDER BY n.name'), Tickets.config()]);
    const sel = (a, b) => (String(a) === String(b) ? raw('selected') : '');
    send(res, layout(req, 'Chamados', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Chamados</h1><p class="muted">Pedidos das clínicas: suporte, financeiro, reclamações e sugestões. A clínica abre em Suporte (no sistema dela) e recebe as respostas por lá e por e-mail.</p></div></header>
      <section class="tk-kpis"><div class="card"><span>Novos / respondidos</span><b>${k.novos}</b></div><div class="card"><span>Na fila da equipe</span><b>${k.fila}</b></div><div class="card"><span>Aguardando a clínica</span><b>${k.aguardando}</b></div><div class="card"><span>1ª resposta (média, 30 dias)</span><b>${mins(k.resp)}</b></div><div class="card"><span>Satisfação (30 dias)</span><b>${k.nota == null ? '—' : `${k.nota.toFixed(1).replace('.', ',')} ★`}</b>${k.notas ? html`<small class="muted"> ${k.notas} avaliação(ões)</small>` : ''}</div></section>
      ${k.urgentes ? html`<div class="flash err">${k.urgentes} chamado(s) urgente(s) na fila.</div>` : ''}
      <form method="get" class="card tk-filters">
        <label class="fld"><span>Situação</span><select name="status"><option value="abertos" ${sel(f.status, 'abertos')}>Em aberto</option>${Object.entries(Tickets.STATUS).map(([s, v]) => html`<option value="${s}" ${sel(f.status, s)}>${v[1]}</option>`)}<option value="todos" ${sel(f.status, 'todos')}>Todos</option></select></label>
        <label class="fld"><span>Categoria</span><select name="categoria"><option value="">Todas</option>${Object.entries(Tickets.CATEGORIES).map(([c, l]) => html`<option value="${c}" ${sel(f.category, c)}>${l}</option>`)}</select></label>
        <label class="fld"><span>Clínica</span><select name="clinica"><option value="">Todas</option>${clinics.map((c) => html`<option value="${c.id}" ${sel(f.tenant, c.id)}>${c.name}</option>`)}</select></label>
        <label class="fld"><span>Responsável</span><select name="resp"><option value="">Todos</option><option value="-" ${sel(f.assignee, '-')}>Sem responsável</option><option value="${req.admin.email}" ${sel(f.assignee, req.admin.email)}>Comigo</option>${team.filter((u) => u.email !== req.admin.email).map((u) => html`<option value="${u.email}" ${sel(f.assignee, u.email)}>${u.name}</option>`)}</select></label>
        <label class="fld"><span>Buscar</span><input name="q" value="${f.q}" placeholder="nº, assunto, clínica…"></label>
        <button class="btn btn-sm">Filtrar</button></form>
      <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Chamado</th><th>Clínica</th><th>Assunto</th><th>Categoria</th><th>Prioridade</th><th>Situação</th><th>Responsável</th><th>Atualizado</th></tr></thead><tbody>
        ${rows.map((r) => html`<tr data-href="/chamados/${r.id}" class="${r.unread_team ? 'tk-unread' : ''}"><td><a href="/chamados/${r.id}">${Tickets.code(r.id)}</a>${r.unread_team ? html` <span class="tk-dot" title="Novidade da clínica"></span>` : ''}</td><td>${r.tenant_name || '—'}</td><td>${r.subject}<br><small class="muted">${r.user_name || ''}</small></td><td>${Tickets.CATEGORIES[r.category]}</td><td class="tk-pri-${r.priority}">${Tickets.PRIORITY_SHORT[r.priority]}</td><td>${ticketBadge(r.status, 1)}</td><td>${team.find((u) => u.email === r.assignee)?.name || (r.assignee ? r.assignee : html`<span class="muted">—</span>`)}</td><td>${ago(r.idle_h)}</td></tr>`)}</tbody></table></div>`
        : html`<p class="pad muted">Nenhum chamado com esses filtros.</p>`}</section>
      <form method="post" action="/chamados/config" class="card form-grid"><h2 class="span2">Avisos e prazos</h2>
        <label class="fld"><span>E-mail que recebe os avisos de chamados</span><input type="email" name="notifyEmail" value="${cfg.notifyEmail}" maxlength="190" placeholder="suporte@mentez.com.br"></label>
        <label class="fld"><span>WhatsApp da equipe para avisos (novos e urgentes)</span><input name="notifyPhone" value="${cfg.notifyPhone}" maxlength="40" inputmode="tel" placeholder="opcional"></label>
        <label class="fld"><span>Resolver sozinho sem resposta da clínica após (dias)</span><input type="number" name="autoResolveDays" value="${cfg.autoResolveDays}" min="1" max="60"></label>
        <label class="fld"><span>Fechar os resolvidos após (dias)</span><input type="number" name="autoCloseDays" value="${cfg.autoCloseDays}" min="1" max="60"></label>
        <p class="span2 muted small">Os avisos saem pelo e-mail e pelo WhatsApp da Mentez (Painel → WhatsApp e e-mail).</p>
        <div class="span2 actions"><button class="btn btn-sm">Salvar</button></div></form>`));
  });
  handle.post('/chamados/config', need, async (req, res) => {
    const r = await Tickets.saveConfig(req.body);
    if (r.error) return res.flash(r.error, 'err').redirect('/chamados');
    await log(req, 'chamados-config'); res.flash('Configuração dos chamados salva.').redirect('/chamados');
  });

  const load = async (req, res, next) => { const tk = await Tickets.get(int(req.params.id)); if (!tk) { next(); return null; } return tk; };
  handle.get('/chamados/arquivo/:fid', need, async (req, res) => {
    const f = await Tickets.file(int(req.params.fid)); if (!f) return res.status(404).send('Arquivo não encontrado.');
    res.set({ 'Content-Type': f.mime, 'Content-Disposition': `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${f.name.replace(/"/g, '')}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox", 'Cache-Control': 'private, no-store' });
    res.send(f.buf);
  });
  handle.get('/chamados/:id', need, async (req, res, next) => {
    const tk = await load(req, res, next); if (!tk) return;
    if (tk.unread_team) await Tickets.markReadTeam(tk.id);
    // WhatsApp para avisar a clínica: o de quem abriu, os da clínica (Dados cadastrais) e o da identidade da clínica
    const t = tk.tenant_slug ? await T.bySlug(tk.tenant_slug) : null;
    const brandPhone = t ? await T.run(t, () => Brand.load()).then((b) => b.whatsapp || b.phone).catch(() => '') : '';
    const phones = [...new Set([tk.user_phone, ...(await PlatCRM.phonesOf(tk.tenant_id).catch(() => [])), brandPhone].map((x) => PlatCRM.digits(x)).filter((x) => x.length >= 10))];
    const [msgs, team, others] = await Promise.all([Tickets.messages(tk.id, { internal: true }), T.pq('SELECT name, email FROM platform_users WHERE active = 1 ORDER BY name'), T.pq("SELECT id, subject, status FROM tickets WHERE tenant_id = ? AND id <> ? ORDER BY id DESC LIMIT 6", [tk.tenant_id, tk.id])]);
    const sel = (a, b) => (String(a || '') === String(b || '') ? raw('selected') : '');
    send(res, layout(req, `Chamado ${Tickets.code(tk.id)}`, html`<header class="ph"><div><p class="eyebrow">Chamados · ${Tickets.code(tk.id)}</p><h1>${tk.subject}</h1>
        <p class="tk-meta">${ticketBadge(tk.status, 1)} <span class="chip">${Tickets.CATEGORIES[tk.category]}</span> <span class="chip tk-pri-${tk.priority}">Prioridade ${Tickets.PRIORITY_SHORT[tk.priority].toLowerCase()}</span> <small class="muted">aberto em ${brDateTime(tk.created_at)}</small></p></div>
        <div class="ph-actions"><a class="btn ghost" href="/chamados">Voltar</a></div></header>
      <div class="tk-wrap"><div class="stack">
        <section class="card">${thread(msgs, { team: true, fileUrl: (id) => `/chamados/arquivo/${id}` })}</section>
        <form method="post" action="/chamados/${tk.id}/responder" class="card form-grid" data-ticket-form>
          <label class="fld span2"><span>Responder para a clínica</span><textarea name="body" rows="5" maxlength="8000" required placeholder="A resposta vai para a clínica no sistema e por e-mail."></textarea></label>
          ${filesField()}
          <label class="fld"><span>Depois de enviar, a situação fica</span><select name="status"><option value="aguardando">Aguardando a clínica</option><option value="andamento">Em andamento</option><option value="resolvido">Resolvido</option></select></label>
          <div class="fld tk-wa"><label class="check"><input type="checkbox" name="whatsapp" value="1"> Avisar também pelo WhatsApp</label>
            <input name="whatsapp_phone" value="${phones[0] ? PlatCRM.fmtPhone(phones[0]) : ''}" list="tk-phones" inputmode="tel" maxlength="40" placeholder="(62) 99999-9999" aria-label="WhatsApp para o aviso">
            <datalist id="tk-phones">${phones.map((x) => html`<option value="${PlatCRM.fmtPhone(x)}">`)}</datalist>
            <small class="muted">${phones.length ? 'Número do chamado ou da clínica (Dados cadastrais). Pode trocar.' : 'Nenhum celular cadastrado: digite o número.'}</small></div>
          <div class="span2 actions"><button class="btn">Enviar resposta</button><button class="btn ghost" name="internal" value="1">Salvar como nota interna</button></div>
          <p class="span2 muted small">Nota interna: só a equipe Mentez vê; a clínica não é avisada.</p>
        </form></div>
        <aside class="tk-side">
          <section class="card"><h3>Clínica</h3><p><a href="/clinicas/${tk.tenant_id}"><b>${tk.tenant_name || '—'}</b></a></p>
            <p class="small">${tk.user_name || '—'}<br>${tk.user_email ? html`<a href="mailto:${tk.user_email}">${tk.user_email}</a><br>` : ''}${tk.user_phone || ''}</p>
            ${tk.page ? html`<p class="small muted">Aberto a partir de: ${tk.page}</p>` : ''}
            ${tk.rating ? html`<p class="small">Avaliação: ${'★'.repeat(tk.rating)}${'☆'.repeat(5 - tk.rating)}${tk.rating_comment ? html`<br><i>“${tk.rating_comment}”</i>` : ''}</p>` : ''}</section>
          <form method="post" action="/chamados/${tk.id}/atualizar" class="card stack"><h3>Atendimento</h3>
            <label class="fld"><span>Situação</span><select name="status">${Object.entries(Tickets.STATUS).map(([s, v]) => html`<option value="${s}" ${sel(tk.status, s)}>${v[1]}</option>`)}</select></label>
            <label class="fld"><span>Prioridade</span><select name="priority">${Object.entries(Tickets.PRIORITY_SHORT).map(([p, l]) => html`<option value="${p}" ${sel(tk.priority, p)}>${l}</option>`)}</select></label>
            <label class="fld"><span>Categoria</span><select name="category">${Object.entries(Tickets.CATEGORIES).map(([c, l]) => html`<option value="${c}" ${sel(tk.category, c)}>${l}</option>`)}</select></label>
            <label class="fld"><span>Responsável</span><select name="assignee"><option value="">— ninguém —</option>${team.map((u) => html`<option value="${u.email}" ${sel(tk.assignee, u.email)}>${u.name}</option>`)}</select></label>
            <button class="btn btn-sm">Salvar</button>
            <p class="small muted">1ª resposta: ${tk.first_response_at ? brDateTime(tk.first_response_at) : 'ainda não'}</p></form>
          ${others.length ? html`<section class="card"><h3>Outros chamados da clínica</h3><ul class="plain small">${others.map((o) => html`<li><a href="/chamados/${o.id}">${Tickets.code(o.id)}</a> ${o.subject} ${ticketBadge(o.status, 1)}</li>`)}</ul></section>` : ''}
        </aside></div>`));
  });
  handle.post('/chamados/:id/responder', need, async (req, res, next) => {
    const tk = await load(req, res, next); if (!tk) return;
    if (req.body.whatsapp && !req.body.internal && PlatCRM.digits(req.body.whatsapp_phone).length < 10) return res.flash('Informe o WhatsApp (com DDD) para o aviso, ou desmarque a opção.', 'err').redirect(`/chamados/${tk.id}`);
    try {
      const out = await Tickets.teamReply(tk, req.admin, { body: req.body.body, files: Tickets.parseFiles(req.body.files), internal: !!req.body.internal, status: req.body.status, whatsapp: !!req.body.whatsapp, phone: req.body.whatsapp_phone });
      await log(req, req.body.internal ? 'chamado-nota' : 'chamado-responder', tk.tenant_id, Tickets.code(tk.id));
      res.flash(req.body.internal ? 'Nota interna salva.' : `Resposta enviada.${out.notified.length ? ` Clínica avisada por ${out.notified.join(' e ')}.` : ' (Aviso por e-mail não enviado: confira o e-mail da Mentez em WhatsApp e e-mail.)'}`, req.body.internal || out.notified.length ? 'ok' : 'warn');
    } catch (e) { res.flash(e.message, 'err'); }
    res.redirect(`/chamados/${tk.id}`);
  });
  handle.post('/chamados/:id/atualizar', need, async (req, res, next) => {
    const tk = await load(req, res, next); if (!tk) return;
    const who = str(req.body.assignee, 190); const nm = who ? (await T.pone('SELECT name FROM platform_users WHERE email = ?', [who]))?.name : null;
    const ch = await Tickets.teamUpdate(tk, req.admin, { status: req.body.status, priority: req.body.priority, category: req.body.category, assignee: who, assigneeName: nm });
    if (ch) await log(req, 'chamado-atualizar', tk.tenant_id, `${Tickets.code(tk.id)} · ${ch.join(' · ')}`);
    res.flash(ch ? 'Chamado atualizado.' : 'Nada mudou.').redirect(`/chamados/${tk.id}`);
  });
}
