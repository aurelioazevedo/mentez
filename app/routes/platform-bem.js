// Painel → Bem-Estar Mental: perfis do diretório (conferir CRP, destaque, ocultar) e pedidos de destaque.
import * as T from '../lib/tenancy.js';
import * as Dir from '../lib/directory.js';
import { html, raw } from '../lib/html.js';
import { send, str } from '../lib/router.js';

const portal = () => `https://${[...Dir.hosts()][0] || 'bemestarmental.com.br'}`;
const ST = { pendente: ['Aguardando CRP', 'agendada'], ativo: ['No ar', 'realizada'], oculto: ['Oculto', 'cancelada'], suspenso: ['Suspenso', 'falta'] };
export function mount(handle, { need, layout, log }) {
  handle.use(/^\/diretorio(\/|$)/, (req, res, next) => { Dir.migrate().then(() => next(), next); });
  handle.get('/diretorio', need, async (req, res) => {
    const f = { st: str(req.query.st, 12), q: str(req.query.q, 80) };
    const where = ['1=1']; const args = [];
    if (f.st) { where.push('p.status = ?'); args.push(f.st); }
    if (f.q) { where.push('(p.name LIKE ? OR p.email LIKE ? OR p.crp LIKE ? OR p.city LIKE ?)'); args.push(...Array(4).fill(`%${f.q}%`)); }
    const rows = await T.pq(`SELECT p.*, t.name tenant_name FROM dir_profiles p LEFT JOIN tenants t ON t.id = p.tenant_id WHERE ${where.join(' AND ')} ORDER BY p.status = 'pendente' DESC, p.created_at DESC LIMIT 300`, args);
    for (const p of rows) p.tierEff = await Dir.tierOf(p);
    const reqs = await T.pq("SELECT r.*, p.name, p.slug FROM dir_requests r JOIN dir_profiles p ON p.id = r.profile_id WHERE r.status = 'novo' ORDER BY r.id DESC LIMIT 50");
    const count = (s) => rows.filter((x) => x.status === s).length;
    send(res, layout(req, 'Bem-Estar Mental', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Bem-Estar Mental</h1><p class="muted">Diretório de psicólogos em <a href="${portal()}" target="_blank" rel="noopener">${portal().replace('https://', '')}</a>. Confira o CRP no cadastro do Conselho (cadastro.cfp.org.br) antes de liberar os perfis grátis.</p></div></header>
      <section class="tk-kpis"><div class="card"><span>Aguardando CRP</span><b>${count('pendente')}</b></div><div class="card"><span>No ar</span><b>${count('ativo')}</b></div><div class="card"><span>Pedidos de destaque</span><b>${reqs.length}</b></div></section>
      ${reqs.length ? html`<section class="card"><h2>Pedidos de destaque</h2><ul class="list">${reqs.map((r) => html`<li class="site-dom"><span><a href="/diretorio/${r.profile_id}"><b>${r.name}</b></a> quer o <b>${Dir.TIERS[r.tier]?.name}</b> (R$ ${Dir.TIERS[r.tier]?.price}/mês)<br><small class="muted">${new Date(r.created_at).toLocaleString('pt-BR')}</small></span>
        <form method="post" action="/diretorio/pedido/${r.id}"><button class="btn btn-sm ghost">Marcar como tratado</button></form></li>`)}</ul><p class="muted small">Envie a cobrança pelo WhatsApp ou e-mail da Mentez e, depois do pagamento, ative o destaque no perfil com a data de validade.</p></section>` : ''}
      <form method="get" class="card tk-filters"><label class="fld"><span>Situação</span><select name="st"><option value="">Todas</option>${Object.entries(ST).map(([k, [l]]) => html`<option value="${k}" ${f.st === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label class="fld"><span>Buscar</span><input name="q" value="${f.q}" placeholder="nome, e-mail, CRP, cidade"></label><button class="btn btn-sm">Filtrar</button></form>
      <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Profissional</th><th>CRP</th><th>Cidade</th><th>Origem</th><th>Destaque</th><th>Situação</th></tr></thead><tbody>
        ${rows.map((p) => html`<tr data-href="/diretorio/${p.id}"><td><a href="/diretorio/${p.id}">${p.name}</a><br><small class="muted">${p.email || ''}</small></td><td>${p.crp || '—'}${p.crp_uf ? `/${p.crp_uf}` : ''} ${p.crp_ok ? html`<span class="badge b-realizada">conferido</span>` : ''}</td>
          <td>${p.city ? `${p.city} - ${p.uf}` : ''}${p.online ? ' · on-line' : ''}</td><td>${p.kind === 'mentez' ? html`Mentez · ${p.tenant_name || ''}` : 'Perfil grátis'}</td><td>${Dir.TIERS[p.tierEff].name}${p.tier !== 'gratis' && p.tier_until ? html`<br><small class="muted">pago até ${new Date(p.tier_until).toLocaleDateString('pt-BR')}</small>` : ''}</td>
          <td><span class="badge b-${ST[p.status]?.[1] || 'agendada'}">${ST[p.status]?.[0] || p.status}</span></td></tr>`)}</tbody></table></div>` : html`<p class="pad muted">Nenhum perfil ainda.</p>`}</section>`));
  });
  handle.get('/diretorio/:id', need, async (req, res, next) => {
    const p = await Dir.byId(Number(req.params.id)); if (!p) return next();
    const tier = await Dir.tierOf(p); const st = await Dir.statsOf(p.id);
    send(res, layout(req, p.name, html`<header class="ph"><div><p class="eyebrow"><a href="/diretorio">Bem-Estar Mental</a></p><h1>${p.name}</h1>
      <p class="muted">${p.kind === 'mentez' ? 'Profissional de clínica Mentez' : 'Perfil grátis'} · ${p.email || ''} ${p.phone ? `· ${p.phone}` : ''}</p></div>
      <div class="ph-actions">${p.status === 'ativo' ? html`<a class="btn ghost" href="${portal()}/p/${p.slug}" target="_blank" rel="noopener">Ver perfil</a>` : ''}</div></header>
      <div class="grid2">
        <section class="card"><h2>CRP</h2><p><b>${p.crp || '—'}</b>${p.crp_uf ? ` · ${p.crp_uf}` : ''} ${p.epsi ? '· diz ter cadastro e-Psi' : ''}</p>
          <p>${p.crp_ok ? html`<span class="badge b-realizada">Conferido em ${new Date(p.crp_ok).toLocaleDateString('pt-BR')}</span>` : html`<span class="badge b-agendada">Não conferido</span>`}</p>
          <p class="muted small">Confira em <a href="https://cadastro.cfp.org.br" target="_blank" rel="noopener">cadastro.cfp.org.br</a> se o nome e o número batem e se o registro está ativo.</p>
          <form method="post" action="/diretorio/${p.id}/crp" class="actions"><button class="btn" name="ok" value="1">CRP conferido · liberar perfil</button><button class="btn ghost" name="ok" value="0">Desfazer conferência</button></form></section>
        <section class="card"><h2>Situação e destaque</h2>
          <form method="post" action="/diretorio/${p.id}/ajustes" class="form-grid">
            <label class="fld"><span>Situação</span><select name="status">${Object.entries(ST).map(([k, [l]]) => html`<option value="${k}" ${p.status === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
            <label class="fld"><span>Destaque pago</span><select name="tier">${Object.entries(Dir.TIERS).map(([k, t]) => html`<option value="${k}" ${p.tier === k ? raw('selected') : ''}>${t.name}${t.price ? ` · R$ ${t.price}` : ''}</option>`)}</select></label>
            <label class="fld"><span>Pago até</span><input type="date" name="until" value="${p.tier_until ? new Date(p.tier_until).toISOString().slice(0, 10) : ''}"></label>
            <p class="fld muted small">Em uso agora: <b>${Dir.TIERS[tier].name}</b>${p.kind === 'mentez' ? ' (o maior entre o pago e o incluído no plano da clínica)' : ''}.</p>
            <label class="fld span2"><span>Cidades extras no destaque (Prata: 1, Ouro: 3) — ex.: goiania-go, anapolis-go</span><input name="extra_cities" value="${p.extra_cities || ''}" maxlength="300"></label>
            <label class="fld span2"><span>Temas extras no destaque (Prata: 3, Ouro: 10) — chaves separadas por vírgula</span><input name="extra_temas" value="${p.extra_temas || ''}" maxlength="600" placeholder="${Object.keys(Dir.TEMAS).slice(0, 4).join(', ')}"></label>
            <div class="span2 actions"><button class="btn">Salvar</button></div></form></section>
        <section class="card"><h2>Últimos 30 dias</h2><p>Visitas: <b>${st.view}</b> · WhatsApp: <b>${st.wa}</b> · Agendar: <b>${st.book}</b> · Site: <b>${st.site}</b></p></section>
        ${p.kind === 'gratis' ? html`<section class="card"><h2>Acesso</h2><p class="muted small">Se o link de acesso não chegou (e-mail ou WhatsApp), gere um link e envie você mesmo.</p>
          <form method="post" action="/diretorio/${p.id}/link"><button class="btn ghost">Gerar link de acesso (24 h)</button></form>${req.query.link ? html`<p><input class="bk-url" readonly value="${req.query.link}"> <button class="chip" type="button" data-copy-text="${req.query.link}">Copiar</button></p>` : ''}</section>` : ''}
      </div>`));
  });
  handle.post('/diretorio/:id/crp', need, async (req, res) => {
    const ok = req.body.ok === '1';
    await T.pq(`UPDATE dir_profiles SET crp_ok = ${ok ? 'NOW()' : 'NULL'}, status = IF(? AND status = 'pendente', 'ativo', status) WHERE id = ?`, [ok ? 1 : 0, Number(req.params.id)]);
    await log(req, 'bem-crp', null, `${req.params.id} ${ok ? 'conferido' : 'desfeito'}`); res.flash(ok ? 'CRP conferido. O perfil está no ar.' : 'Conferência desfeita.').redirect(`/diretorio/${req.params.id}`);
  });
  handle.post('/diretorio/:id/ajustes', need, async (req, res) => {
    const tier = Dir.TIERS[req.body.tier] ? req.body.tier : 'gratis'; const status = ST[req.body.status] ? req.body.status : 'pendente';
    const until = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.until || '')) ? req.body.until : null;
    const lim = (v, n, ok) => String(v || '').split(',').map((x) => x.trim().toLowerCase()).filter(ok).slice(0, n).join(',') || null;
    await T.pq('UPDATE dir_profiles SET status = ?, tier = ?, tier_until = ?, extra_cities = ?, extra_temas = ? WHERE id = ?', [status, tier, tier === 'gratis' ? null : until, lim(req.body.extra_cities, Dir.TIERS[tier].cities, (x) => /^[a-z0-9-]+-[a-z]{2}$/.test(x)), lim(req.body.extra_temas, Dir.TIERS[tier].temas, (x) => !!Dir.TEMAS[x]), Number(req.params.id)]);
    await log(req, 'bem-ajustes', null, `${req.params.id} ${status} ${tier} ${until || ''}`); res.flash('Perfil atualizado.').redirect(`/diretorio/${req.params.id}`);
  });
  handle.post('/diretorio/:id/link', need, async (req, res) => {
    const tok = await Dir.newToken(Number(req.params.id));
    await log(req, 'bem-link', null, req.params.id);
    res.redirect(`/diretorio/${req.params.id}?link=${encodeURIComponent(`${portal()}/acesso/${tok}`)}`);
  });
  handle.post('/diretorio/pedido/:id', need, async (req, res) => { await T.pq("UPDATE dir_requests SET status = 'feito' WHERE id = ?", [Number(req.params.id)]); res.redirect('/diretorio'); });
}
