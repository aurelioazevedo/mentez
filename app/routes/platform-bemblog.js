// Painel → Bem-Estar Mental → Blog: chave e modelo da IA, pauta, escrita, revisão e agenda de publicação.
import * as Blog from '../lib/bemblog.js';
import * as Dir from '../lib/directory.js';
import * as Agent from '../lib/agent.js';
import { md } from '../lib/siteblog.js';
import { html, raw } from '../lib/html.js';
import { send } from '../lib/router.js';

const P = '/diretorio/blog';
const portal = () => `https://${[...Dir.hosts()][0] || 'bemestarmental.com.br'}`;
const usd = (n) => `US$ ${Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const num = (n) => Number(n || 0).toLocaleString('pt-BR');
const when = (d) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '');
const BADGE = { pauta: 'agendada', gerando: 'agendada', revisao: 'falta', fila: 'agendada', publicado: 'realizada', erro: 'cancelada' };
const sel = (name, dict, v) => html`<select name="${name}">${Object.entries(dict).map(([k, l]) => html`<option value="${k}" ${k === v ? raw('selected') : ''}>${l}</option>`)}</select>`;

export function mount(handle, { need, layout, log }) {
  handle.use(/^\/diretorio\/blog(\/|$)/, (req, res, next) => { Blog.migrate().then(() => next(), next); });

  handle.get(P, need, async (req, res) => {
    const c = await Blog.config(); const n = await Blog.counts(); const u = await Blog.usage();
    const f = Blog.ST[req.query.st] ? req.query.st : '';
    const rows = await Blog.listAdmin(f);
    const running = Blog.state.busy || Blog.state.pauta || (n.gerando || 0) > 0;
    const est = u.perPost.n ? u.perPost.cost : (Agent.MODELS[c.model].in * 1500 + Agent.MODELS[c.model].out * 3000) / 1e6;
    const tabs = [['', 'Todos'], ...Object.entries(Blog.ST)];
    send(res, layout(req, 'Blog · Bem-Estar Mental', html`${running ? raw('<meta http-equiv="refresh" content="20">') : ''}
      <header class="ph"><div><p class="eyebrow"><a href="/diretorio">Bem-Estar Mental</a></p><h1>Blog</h1>
        <p class="muted">Artigos em <a href="${portal()}/blog" target="_blank" rel="noopener">${portal().replace('https://', '')}/blog</a>, escritos com IA, revisados aqui e publicados ${c.perWeek} por semana (seg. a sex.). Cada artigo leva o leitor à busca de psicólogos do tema.</p></div></header>
      ${Blog.state.note ? html`<p class="flash err">${Blog.state.note}</p>` : ''}
      ${running ? html`<p class="flash">${Blog.state.pauta ? 'Criando a pauta…' : 'Escrevendo artigos, um de cada vez (cerca de 1 minuto cada)…'} Esta página se atualiza sozinha.</p>` : ''}
      <section class="tk-kpis">
        <div class="card"><span>Publicados</span><b>${n.publicado || 0}</b></div><div class="card"><span>Agendados</span><b>${n.fila || 0}</b></div>
        <div class="card"><span>Para revisar</span><b>${n.revisao || 0}</b></div><div class="card"><span>Na pauta</span><b>${n.pauta || 0}</b></div>
        <div class="card"><span>Gasto no mês</span><b>${usd(u.month.cost)}</b><br><small class="muted">${c.budget ? `limite ${usd(c.budget)}` : 'sem limite'}</small></div>
        <div class="card"><span>Tokens no mês</span><b>${num(u.month.inTok + u.month.outTok)}</b><br><small class="muted">${num(u.month.inTok)} enviados · ${num(u.month.outTok)} gerados</small></div>
      </section>
      <div class="grid2">
        <section class="card stack"><h2>Criar e escrever</h2>
          ${!c.key ? html`<p class="flash err">Cole a chave da Anthropic na configuração ao lado para começar.</p>` : ''}
          <form method="post" action="${P}/pauta" class="actions"><label class="fld"><span>Ideias novas para a pauta</span><input name="n" type="number" min="1" max="200" value="${(n.pauta || 0) + (n.revisao || 0) + (n.fila || 0) + (n.publicado || 0) ? 25 : 100}" style="max-width:110px"></label><button class="btn" ${!c.key || running ? raw('disabled') : ''}>Criar pauta com IA</button></form>
          <form method="post" action="${P}/gerar" class="actions"><label class="fld"><span>Escrever agora (da pauta)</span><input name="n" type="number" min="1" max="200" value="10" style="max-width:110px"></label><button class="btn" ${!c.key || running || !(n.pauta || n.erro) ? raw('disabled') : ''}>Escrever artigos</button></form>
          <p class="muted small">Estimativa com ${Agent.MODELS[c.model].label.split(' —')[0]}: <b>${usd(est)}</b> por artigo · 100 artigos ≈ <b>${usd(est * 100)}</b>${u.perPost.n ? ` (média real de ${u.perPost.n} artigos: ${num(Math.round(u.perPost.inTok))} + ${num(Math.round(u.perPost.outTok))} tokens)` : ''}. Total desde o início: ${usd(u.all.cost)}.</p>
          ${(n.revisao || 0) > 1 ? html`<form method="post" action="${P}/aprovar-todos" data-confirm="Agendar os ${n.revisao} artigos em revisão sem abrir um por um?"><button class="btn ghost">Aprovar todos os ${n.revisao} em revisão</button></form>` : ''}
          <details><summary>Adicionar um título à mão</summary>
            <form method="post" action="${P}/ideia" class="form-grid"><label class="fld span2"><span>Título</span><input name="title" required maxlength="160"></label>
              <label class="fld"><span>Tema</span>${sel('tema', Blog.TEMAS, 'geral')}</label><label class="fld"><span>Palavra-chave</span><input name="keyword" maxlength="120"></label>
              <label class="fld span2"><span>O que o artigo deve responder (opcional)</span><input name="angle" maxlength="400"></label><div class="span2 actions"><button class="btn ghost">Adicionar à pauta</button></div></form></details>
        </section>
        <section class="card"><h2>Configuração</h2>
          <form method="post" action="${P}/config" class="form-grid">
            <label class="fld span2"><span>Chave da API da Anthropic ${c.key ? html`<small class="muted">· salva (${c.keyHint})</small>` : ''}</span><input name="key" type="password" autocomplete="off" placeholder="${c.key ? 'Deixe em branco para manter' : 'sk-ant-…'}"></label>
            <label class="fld span2"><span>Modelo</span>${sel('model', Object.fromEntries(Object.entries(Agent.MODELS).map(([k, m]) => [k, `${m.label} · US$ ${m.in} / ${m.out} por milhão`])), c.model)}</label>
            <label class="fld"><span>Artigos por semana</span><input name="perWeek" type="number" min="1" max="35" value="${c.perWeek}"></label>
            <label class="fld"><span>Limite de gasto por mês (US$)</span><input name="budget" inputmode="decimal" value="${c.budget}"></label>
            <label class="fld"><span>Manter prontos à frente</span><input name="ahead" type="number" min="0" max="200" value="${c.ahead}"></label>
            <label class="fld check"><input type="checkbox" name="auto" value="1" ${c.auto ? raw('checked') : ''}><span>Escrever sozinho da pauta para manter os prontos</span></label>
            <label class="fld check span2"><input type="checkbox" name="review" value="1" ${c.review ? raw('checked') : ''}><span>Revisar cada artigo antes de agendar (recomendado)</span></label>
            ${c.key ? html`<label class="fld check span2"><input type="checkbox" name="clearKey" value="1"><span>Apagar a chave salva</span></label>` : ''}
            <div class="span2 actions"><button class="btn">Salvar</button></div></form>
          <p class="muted small">A chave fica cifrada no banco e não aparece de novo. Horários: ${c.perWeek} por semana, de segunda a sexta (9h, depois 15h, 12h, 18h…, horário de Brasília).</p></section>
      </div>
      <nav class="tabs">${tabs.map(([k, l]) => html`<a href="${P}${k ? `?st=${k}` : ''}" class="${f === k ? 'on' : ''}">${l}${k && n[k] ? ` (${n[k]})` : ''}</a>`)}</nav>
      <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Artigo</th><th>Tema</th><th>Situação</th><th>Publicação</th><th>Custo</th></tr></thead><tbody>
        ${rows.map((p) => html`<tr data-href="${P}/${p.id}"><td><a href="${P}/${p.id}">${p.title}</a>${p.error ? html`<br><small class="muted">${p.error}</small>` : ''}${p.risks ? html`<br><small class="muted">⚠ ${p.risks}</small>` : ''}</td>
          <td>${Blog.TEMAS[p.tema] || p.tema}</td><td><span class="badge b-${BADGE[p.status]}">${Blog.ST[p.status]}</span></td>
          <td>${p.status === 'publicado' ? when(p.published_at) : p.status === 'fila' ? when(p.publish_at) : ''}</td><td>${Number(p.cost) ? usd(p.cost) : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="pad muted">${f ? 'Nada aqui.' : 'Nenhum artigo ainda. Crie a pauta para começar.'}</p>`}</section>`));
  });

  handle.post(`${P}/config`, need, async (req, res) => {
    try {
      const before = (await Blog.config()).perWeek;
      await Blog.saveConfig(req.body);
      if ((await Blog.config()).perWeek !== before) await Blog.reschedule();
      await log(req, 'bem-blog-config', null, `${req.body.model} ${req.body.perWeek}/sem ${req.body.key ? 'chave nova' : ''}`);
      res.flash('Configuração salva.');
    } catch (e) { res.flash(e.message, 'err'); }
    res.redirect(P);
  });
  handle.post(`${P}/pauta`, need, async (req, res) => {
    const ok = Blog.generatePauta(Number(req.body.n) || 100);
    await log(req, 'bem-blog-pauta', null, String(req.body.n));
    res.flash(ok ? 'Criando a pauta. Leva alguns minutos; a lista aparece aqui.' : 'Já há uma pauta sendo criada.', ok ? 'ok' : 'err').redirect(P);
  });
  handle.post(`${P}/gerar`, need, async (req, res) => {
    const ok = await Blog.generateNext(Number(req.body.n) || 10);
    await log(req, 'bem-blog-gerar', null, String(req.body.n));
    res.flash(ok ? 'Escrevendo os artigos. Eles aparecem em “Para revisar”.' : 'Já há artigos sendo escritos (ou a pauta está vazia).', ok ? 'ok' : 'err').redirect(P);
  });
  handle.post(`${P}/aprovar-todos`, need, async (req, res) => {
    const ids = (await Blog.listAdmin('revisao')).map((p) => p.id);
    for (const id of ids) await Blog.approve(id);
    await log(req, 'bem-blog-aprovar', null, `${ids.length}`);
    res.flash(`${ids.length} artigos agendados.`).redirect(`${P}?st=fila`);
  });
  handle.post(`${P}/ideia`, need, async (req, res) => {
    try { await Blog.addIdea(req.body); res.flash('Título adicionado à pauta.'); } catch (e) { res.flash(e.message, 'err'); }
    res.redirect(`${P}?st=pauta`);
  });

  handle.get(`${P}/:id`, need, async (req, res, next) => {
    const p = await Blog.byId(Number(req.params.id)); if (!p) return next();
    const words = String(p.body || '').split(/\s+/).filter(Boolean).length;
    const live = p.status === 'publicado' || (p.status === 'fila' && new Date(p.publish_at) <= new Date());
    send(res, layout(req, p.title, html`${p.status === 'gerando' ? raw('<meta http-equiv="refresh" content="15">') : ''}
      <header class="ph"><div><p class="eyebrow"><a href="${P}">Blog</a></p><h1>${p.title}</h1>
        <p class="muted"><span class="badge b-${BADGE[p.status]}">${Blog.ST[p.status]}</span> ${p.status === 'fila' ? `· publica ${when(p.publish_at)}` : ''}${p.status === 'publicado' ? `· publicado ${when(p.published_at)}` : ''}
          ${words ? ` · ${num(words)} palavras` : ''}${Number(p.cost) ? ` · ${usd(p.cost)} (${num(p.in_tok)} + ${num(p.out_tok)} tokens${p.model ? `, ${p.model}` : ''})` : ''}</p></div>
        <div class="ph-actions">${live ? html`<a class="btn ghost" href="${portal()}/blog/${p.slug}" target="_blank" rel="noopener">Ver no site</a>` : ''}</div></header>
      ${p.error ? html`<p class="flash err">${p.error}</p>` : ''}${p.risks ? html`<p class="flash err">Atenção ao revisar: ${p.risks}</p>` : ''}
      <div class="actions">
        ${['revisao', 'erro'].includes(p.status) && p.body ? html`<form method="post" action="${P}/${p.id}/aprovar"><button class="btn">Aprovar e agendar</button></form>` : ''}
        ${p.status !== 'publicado' && p.body ? html`<form method="post" action="${P}/${p.id}/publicar" data-confirm="Publicar agora, fora da agenda?"><button class="btn ghost">Publicar agora</button></form>` : ''}
        ${['fila', 'publicado'].includes(p.status) ? html`<form method="post" action="${P}/${p.id}/despublicar"><button class="btn ghost">Tirar do ar / da agenda</button></form>` : ''}
        ${p.status !== 'gerando' ? html`<form method="post" action="${P}/${p.id}/escrever" ${p.body ? raw('data-confirm="Escrever de novo? O texto atual será substituído."') : ''}><button class="btn ghost">${p.body ? 'Escrever de novo com IA' : 'Escrever com IA'}</button></form>` : ''}
        <form method="post" action="${P}/${p.id}/apagar" data-confirm="Apagar este artigo?"><button class="btn ghost danger">Apagar</button></form>
      </div>
      <div class="grid2">
        <form method="post" action="${P}/${p.id}" class="card form-grid">
          <label class="fld span2"><span>Título</span><input name="title" value="${p.title}" required maxlength="160"></label>
          <label class="fld"><span>Tema</span>${sel('tema', Blog.TEMAS, p.tema)}</label><label class="fld"><span>Endereço</span><input name="slug" value="${p.slug}" maxlength="110"></label>
          <label class="fld"><span>Palavra-chave</span><input name="keyword" value="${p.keyword || ''}" maxlength="120"></label><label class="fld"><span>Ângulo</span><input name="angle" value="${p.angle || ''}" maxlength="400"></label>
          <label class="fld span2"><span>Resumo</span><textarea name="excerpt" rows="2" maxlength="320">${p.excerpt || ''}</textarea></label>
          <label class="fld span2"><span>Descrição no Google (até 155 caracteres)</span><input name="seo" value="${p.seo || ''}" maxlength="180"></label>
          <label class="fld span2"><span>Texto (## subtítulo, ### pergunta, - lista, **negrito**)</span><textarea name="body" rows="22">${p.body || ''}</textarea></label>
          <div class="span2 actions"><button class="btn">Salvar</button></div></form>
        <section class="card prose-preview"><h2>Prévia</h2>${p.body ? html`<p class="muted">${p.excerpt || ''}</p>${raw(md(p.body))}` : html`<p class="muted">Ainda sem texto.</p>`}</section>
      </div>`));
  });
  const act = (path, fn, msg) => handle.post(`${P}/:id/${path}`, need, async (req, res) => {
    const id = Number(req.params.id);
    try { const r = await fn(id); await log(req, `bem-blog-${path}`, null, String(id)); res.flash(typeof msg === 'function' ? msg(r) : msg); } catch (e) { res.flash(e.message, 'err'); }
    res.redirect(path === 'apagar' ? P : `${P}/${id}`);
  });
  act('aprovar', (id) => Blog.approve(id), (d) => `Agendado para ${when(d)}.`);
  act('publicar', (id) => Blog.publishNow(id), 'Publicado.');
  act('despublicar', (id) => Blog.unpublish(id), 'O artigo voltou para revisão.');
  act('escrever', (id) => Blog.generateMany([id]) || Promise.reject(new Error('Já há artigos sendo escritos. Tente em alguns minutos.')), 'Escrevendo… leva cerca de 1 minuto.');
  act('apagar', (id) => Blog.remove(id), 'Artigo apagado.');
  handle.post(`${P}/:id`, need, async (req, res) => {
    try { await Blog.save(Number(req.params.id), req.body); res.flash('Salvo.'); } catch (e) { res.flash(e.message, 'err'); }
    res.redirect(`${P}/${Number(req.params.id)}`);
  });
}
