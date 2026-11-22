// Clínica: Suporte Mentez — abrir chamados (suporte, financeiro, reclamação, sugestão…) e conversar com a equipe.
// A administração da clínica vê todos os chamados da clínica; os demais usuários, só os que abriram.
import { page, html, raw, brDateTime } from '../lib/html.js';
import { router, send, str, int } from '../lib/router.js';
import { can } from '../lib/perm.js';
import { audit } from '../lib/db.js';
import * as T from '../lib/tenancy.js';
import * as Tickets from '../lib/tickets.js';

const badge = (st, who = 2) => html`<span class="badge b-${(Tickets.STATUS[st] || ['agendada'])[0]}">${(Tickets.STATUS[st] || [0, st, st])[who]}</span>`;
export { badge as ticketBadge };

// Conversa (usada também no Painel): mensagens com autor, hora e anexos
export function thread(msgs, { team = false, fileUrl }) {
  return html`<ol class="tk-thread">${msgs.map((m) => {
    if (m.author_type === 'sistema') return html`<li class="tk-sys${m.internal ? ' tk-int' : ''}"><span>${m.body}</span><time>${brDateTime(m.created_at)}</time></li>`;
    const mine = team ? m.author_type === 'equipe' : m.author_type === 'cliente';
    return html`<li class="tk-msg ${mine ? 'me' : 'other'} ${m.author_type === 'equipe' ? 'team' : 'client'}${m.internal ? ' tk-int' : ''}">
      <header><b>${m.author_type === 'equipe' ? (team ? m.author_name : html`${m.author_name || 'Equipe'} · <span class="tk-mz">Mentez</span>`) : m.author_name || 'Clínica'}</b>${m.internal ? html`<span class="tk-note">nota interna</span>` : ''}<time>${brDateTime(m.created_at)}</time></header>
      <div class="tk-body">${m.body}</div>
      ${m.files.length ? html`<div class="tk-files">${m.files.map((f) => html`<a href="${fileUrl(f.id)}" target="_blank" rel="noopener" class="tk-file">${f.mime.startsWith('image/') ? html`<img src="${fileUrl(f.id)}" alt="${f.name}" loading="lazy">` : html`<span class="tk-pdf">PDF</span>`}<small>${f.name}</small></a>`)}</div>` : ''}
    </li>`;
  })}</ol>`;
}
export const filesField = () => html`<div class="fld span2 tk-attach"><span>Anexos <small class="muted">(até 3: prints da tela em imagem ou PDF)</small></span>
  <label class="btn ghost btn-sm tk-pick"><input type="file" accept="image/png,image/jpeg,image/webp,application/pdf" multiple data-ticket-files hidden> Anexar arquivo</label>
  <ul class="tk-picked" data-ticket-picked></ul><div data-ticket-out hidden></div></div>`;

export const support = router();
const isAdm = (u) => can(u, 'usuarios');
const ctx = () => T.current();

support.use(async (req, res, next) => { if (!ctx() || !T.multi()) return res.redirect('/'); try { await Tickets.migrate(); next(); } catch (e) { next(e); } });

support.get('/', async (req, res) => {
  const t = ctx(); const rows = await Tickets.listForClinic(t.id, req.user, isAdm(req.user));
  const open = rows.filter((r) => Tickets.OPEN_STATES.includes(r.status));
  send(res, page(req, { title: 'Suporte Mentez', active: '', body: html`<header class="ph"><div><p class="eyebrow">Mentez</p><h1>Suporte</h1>
      <p class="muted">Abra um chamado para a equipe Mentez: dúvidas, problemas no sistema, financeiro, reclamações ou sugestões. Você acompanha tudo por aqui e recebe a resposta por e-mail.</p></div>
      <div class="ph-actions"><a class="btn" href="/suporte/novo">Abrir chamado</a></div></header>
    <section class="tk-tip card"><p>Dúvida rápida de como usar? O <button type="button" class="link" data-hb-open>assistente da Mentez</button> responde na hora. Para problemas, cobranças ou pedidos, abra um chamado.</p></section>
    <section class="card flush"><h2 class="pad">${isAdm(req.user) ? 'Chamados da clínica' : 'Meus chamados'} ${open.length ? html`<small class="muted">· ${open.length} em aberto</small>` : ''}</h2>
      ${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Chamado</th><th>Assunto</th><th>Categoria</th><th>Situação</th><th>Atualizado</th></tr></thead><tbody>
        ${rows.map((r) => html`<tr data-href="/suporte/${r.id}" class="${r.unread_client ? 'tk-unread' : ''}"><td><a href="/suporte/${r.id}">${Tickets.code(r.id)}</a>${r.unread_client ? html` <span class="tk-dot" title="Resposta nova"></span>` : ''}</td><td>${r.subject}${isAdm(req.user) && r.user_name ? html`<br><small class="muted">${r.user_name}</small>` : ''}</td><td>${Tickets.CATEGORIES[r.category]}</td><td>${badge(r.status)}</td><td>${brDateTime(r.updated_at)}</td></tr>`)}</tbody></table></div>`
      : html`<p class="pad muted">Nenhum chamado ainda. Quando precisar da equipe Mentez, clique em “Abrir chamado”.</p>`}
    </section>` }));
});

support.get('/novo', (req, res) => {
  const cat = Tickets.CATEGORIES[req.query.categoria] ? req.query.categoria : 'suporte';
  const from = str(req.query.de, 200);
  send(res, page(req, { title: 'Abrir chamado', active: '', body: html`<header class="ph"><div><p class="eyebrow">Suporte Mentez</p><h1>Abrir chamado</h1><p class="muted">Conte o que aconteceu. Quanto mais detalhes (tela, horário, o que você esperava), mais rápido a equipe resolve.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/suporte">Voltar</a></div></header>
    <form method="post" action="/suporte" class="card form-grid" data-ticket-form>
      <label class="fld"><span>Categoria</span><select name="category">${Object.entries(Tickets.CATEGORIES).map(([k, l]) => html`<option value="${k}" ${k === cat ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <label class="fld"><span>Urgência</span><select name="priority">${Object.entries(Tickets.PRIORITIES).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select></label>
      <label class="fld span2"><span>Assunto</span><input name="subject" required minlength="4" maxlength="160" value="${str(req.query.assunto, 160)}" placeholder="Ex.: Lembrete do WhatsApp não chegou ao paciente"></label>
      <label class="fld span2"><span>Descrição</span><textarea name="body" required minlength="10" maxlength="8000" rows="7" placeholder="O que aconteceu, em qual tela, desde quando… Se for cobrança, informe o mês da fatura."></textarea></label>
      ${filesField()}
      <input type="hidden" name="page" value="${from}">
      <p class="span2 muted small">🔒 Não coloque dados de pacientes (nomes, prontuários, documentos) no chamado. Se a equipe precisar, ela pede de forma segura.</p>
      <div class="span2 actions"><button class="btn">Enviar chamado</button></div>
    </form>` }));
});

support.post('/', async (req, res) => {
  try {
    const files = Tickets.parseFiles(req.body.files);
    const id = await Tickets.create(ctx(), req.user, { category: req.body.category, priority: req.body.priority, subject: req.body.subject, body: req.body.body, page: req.body.page, files });
    await audit(req, 'chamado-abrir', Tickets.code(id));
    res.flash(`Chamado ${Tickets.code(id)} aberto. A equipe Mentez vai responder por aqui e por e-mail.`).redirect(`/suporte/${id}`);
  } catch (e) { res.flash(e.message, 'err').redirect('/suporte/novo'); }
});

async function load(req, res) {
  const tk = await Tickets.get(int(req.params.id));
  if (!Tickets.canSee(tk, ctx().id, req.user, isAdm(req.user))) { res.status(404); send(res, page(req, { title: 'Chamado', body: html`<section class="card center-card"><h1>Chamado não encontrado</h1><p><a class="btn" href="/suporte">Voltar</a></p></section>` })); return null; }
  return tk;
}

support.get('/arquivo/:fid', async (req, res) => {
  const f = await Tickets.file(int(req.params.fid));
  const tk = f ? await Tickets.get(f.ticketId) : null;
  if (!f || !Tickets.canSee(tk, ctx().id, req.user, isAdm(req.user))) return res.status(404).send('Arquivo não encontrado.');
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': `${f.mime === 'application/pdf' ? 'attachment' : 'inline'}; filename="${f.name.replace(/"/g, '')}"`, 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox", 'Cache-Control': 'private, no-store' });
  res.send(f.buf);
});

support.get('/:id(\\d+)', async (req, res) => {
  const tk = await load(req, res); if (!tk) return;
  if (tk.unread_client) await Tickets.markReadClient(tk.id);
  const msgs = await Tickets.messages(tk.id);
  const open = Tickets.OPEN_STATES.includes(tk.status);
  send(res, page(req, { title: `Chamado ${Tickets.code(tk.id)}`, active: '', body: html`<header class="ph"><div><p class="eyebrow">Suporte Mentez · Chamado ${Tickets.code(tk.id)}</p><h1>${tk.subject}</h1>
      <p class="tk-meta">${badge(tk.status)} <span class="chip">${Tickets.CATEGORIES[tk.category]}</span> ${tk.priority !== 'normal' ? html`<span class="chip">Urgência ${Tickets.PRIORITY_SHORT[tk.priority].toLowerCase()}</span>` : ''} <small class="muted">aberto por ${tk.user_name || '—'} em ${brDateTime(tk.created_at)}</small></p></div>
      <div class="ph-actions"><a class="btn ghost" href="/suporte">Voltar</a></div></header>
    ${tk.status === 'aguardando' ? html`<div class="flash info">A equipe Mentez respondeu e aguarda o seu retorno.</div>` : ''}
    <section class="card">${thread(msgs, { fileUrl: (id) => `/suporte/arquivo/${id}` })}</section>
    ${tk.status !== 'fechado' ? html`<form method="post" action="/suporte/${tk.id}/responder" class="card form-grid" data-ticket-form>
      <label class="fld span2"><span>${tk.status === 'resolvido' ? 'Ainda precisa de ajuda? Responda para reabrir' : 'Responder'}</span><textarea name="body" rows="4" maxlength="8000" required></textarea></label>
      ${filesField()}
      <div class="span2 actions"><button class="btn">Enviar resposta</button>
        ${open ? html`<button class="btn ghost" formaction="/suporte/${tk.id}/situacao" formnovalidate name="status" value="resolvido">Problema resolvido</button>` : ''}</div>
    </form>` : html`<section class="card"><p class="muted">Este chamado está fechado. Se precisar, <a href="/suporte/novo?assunto=${encodeURIComponent(`Sobre o chamado ${Tickets.code(tk.id)}`)}">abra um novo chamado</a>.</p></section>`}
    ${['resolvido', 'fechado'].includes(tk.status) && !tk.rating ? html`<form method="post" action="/suporte/${tk.id}/avaliar" class="card tk-rate">
      <h2>Como foi o atendimento?</h2><div class="tk-stars">${[5, 4, 3, 2, 1].map((n) => html`<input type="radio" name="rating" value="${n}" id="tk-r${n}" required><label for="tk-r${n}" title="${n} de 5">★</label>`)}</div>
      <label class="fld"><span>Comentário (opcional)</span><input name="comment" maxlength="500"></label><div class="actions"><button class="btn btn-sm">Enviar avaliação</button></div></form>`
      : tk.rating ? html`<p class="muted small">Sua avaliação: ${'★'.repeat(tk.rating)}${'☆'.repeat(5 - tk.rating)} — obrigado!</p>` : ''}` }));
});

support.post('/:id(\\d+)/responder', async (req, res) => {
  const tk = await load(req, res); if (!tk) return;
  try { await Tickets.clientReply(tk, req.user, { body: req.body.body, files: Tickets.parseFiles(req.body.files) }); res.flash('Resposta enviada para a equipe Mentez.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`/suporte/${tk.id}`);
});
support.post('/:id(\\d+)/situacao', async (req, res) => {
  const tk = await load(req, res); if (!tk) return;
  await Tickets.clientSetStatus(tk, req.body.status);
  res.flash(req.body.status === 'resolvido' ? 'Que bom! Chamado marcado como resolvido.' : 'Chamado reaberto.').redirect(`/suporte/${tk.id}`);
});
support.post('/:id(\\d+)/avaliar', async (req, res) => {
  const tk = await load(req, res); if (!tk) return;
  await Tickets.rate(tk, req.body.rating, req.body.comment);
  res.flash('Obrigado pela avaliação!').redirect(`/suporte/${tk.id}`);
});
