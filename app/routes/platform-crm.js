// Painel → ficha da clínica: abas Dados cadastrais, Anotações e WhatsApp (conversa pelo WhatsApp da Mentez, no estilo do CRM da clínica);
// e Painel → Conversas: caixa de entrada de tudo o que chega no WhatsApp da Mentez (clínicas e contatos novos).
import { html, raw, brDate, brDateTime } from '../lib/html.js';
import { send, str, int } from '../lib/router.js';
import * as T from '../lib/tenancy.js';
import * as Brand from '../lib/brand.js';
import * as PlatComm from '../lib/platcomm.js';
import * as PlatCRM from '../lib/platcrm.js';

const UF = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
const KIND = { manual: 'Equipe', cobranca: 'Cobrança', chamado: 'Chamado', indicacao: 'Indicação', teste: 'Teste', aviso: 'Aviso', celular: 'Pelo celular', equipe: 'Aviso à equipe' };
const fmtDoc = (d) => (d.length === 11 ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4') : d.length === 14 ? d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : d);

// Abas da ficha da clínica (usadas também na página principal da clínica)
export async function clinicTabs(id, active) {
  const c = await PlatCRM.counts(id).catch(() => ({ notes: 0, unread: 0 }));
  const tabs = [['', 'Visão geral'], ['/cadastro', 'Dados cadastrais'], ['/anotacoes', `Anotações${c.notes ? ` (${c.notes})` : ''}`], ['/conversa', 'WhatsApp', c.unread]];
  return html`<nav class="pc-tabs" aria-label="Seções da clínica">${tabs.map(([p, l, n]) => html`<a href="/clinicas/${id}${p}" class="${active === p ? 'on' : ''}" ${active === p ? raw('aria-current="page"') : ''}>${l}${n ? html` <i class="pc-badge">${n}</i>` : ''}</a>`)}</nav>`;
}
export async function pinnedBox(id) {
  const ps = await PlatCRM.pinnedNotes(id).catch(() => []);
  return ps.length ? html`<section class="pc-pinned">${ps.map((n) => html`<div><b>📌 ${n.author || 'Equipe'}</b> · <small>${brDate(n.created_at)}</small><p>${n.body}</p></div>`)}<a href="/clinicas/${id}/anotacoes" class="small">Todas as anotações</a></section>` : '';
}

// Conversa (bolhas no estilo do WhatsApp/CRM), com anotações internas no meio
function chat(msgs, notes = []) {
  const items = [...msgs.map((m) => ({ at: m.created_at, kind: 'msg', m })), ...notes.map((n) => ({ at: n.created_at, kind: 'nota', n }))].sort((a, b) => (String(a.at) < String(b.at) ? -1 : 1));
  let last = '';
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  return items.length ? items.map((it) => {
    const d = String(it.at).slice(0, 10); const sep = d !== last ? html`<div class="chat-day"><span>${d === today ? 'Hoje' : brDate(d)}</span></div>` : ''; last = d;
    const hm = String(it.at).slice(11, 16);
    if (it.kind === 'nota') return html`${sep}<div class="bub note"><small class="bub-who">📝 Anotação interna · ${it.n.author || 'Equipe'}</small><p>${it.n.body}</p><span class="bub-time">${hm}</span></div>`;
    const m = it.m; const err = m.status === 'erro';
    const who = m.direction === 'in' ? (m.author || '') : `${KIND[m.kind] || m.kind}${m.author && m.kind !== 'celular' ? ` · ${m.author}` : ''}`;
    return html`${sep}<div class="bub ${m.direction === 'in' ? 'in' : 'out'} ${err ? 'err' : ''}">${who ? html`<small class="bub-who">${who}</small>` : ''}<p>${m.body}</p><span class="bub-time">${hm}${m.direction === 'out' ? (err ? ' ⚠' : ' ✓') : ''}</span>${err ? html`<small class="bub-err">Não enviada: ${m.error}</small>` : ''}</div>`;
  }) : html`<p class="chat-empty">Nenhuma mensagem ainda.</p>`;
}

export function mount(handle, { need, layout, log, tenantOf }) {
  handle.use(/^\/(clinicas\/\d+\/(cadastro|anotacoes|conversa)|conversas)/, (req, res, next) => { PlatCRM.migrate().then(() => next(), next); });

  // ---------- dados cadastrais ----------
  handle.get('/clinicas/:id/cadastro', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    const p = await PlatCRM.profile(t.id);
    const v = (k) => p[k] ?? '';
    send(res, layout(req, `${t.name} · Dados cadastrais`, html`<header class="ph"><div><p class="eyebrow">Clínica</p><h1>${t.name}</h1></div><div class="ph-actions"><a class="btn ghost" href="/clinicas">Clínicas</a></div></header>
      ${await clinicTabs(t.id, '/cadastro')}
      <form method="post" class="card form-grid pc-form">
        <h2 class="span2">Identificação</h2>
        <label class="fld"><span>Nome da clínica (como aparece no sistema)</span><input value="${t.name}" disabled></label>
        <label class="fld"><span>Razão social ou nome completo (para nota e contrato)</span><input name="legal_name" value="${v('legal_name')}" maxlength="160"></label>
        <label class="fld"><span>CPF ou CNPJ</span><input name="doc" value="${p.doc ? fmtDoc(p.doc) : ''}" maxlength="18" inputmode="numeric" data-mask="doc" autocomplete="off"></label>
        <label class="fld"><span>Profissionais que atendem (informado)</span><input type="number" name="pros_count" value="${v('pros_count')}" min="1" max="999"></label>
        <h2 class="span2">Responsável e contatos</h2>
        <label class="fld"><span>Responsável</span><input name="owner_name" value="${v('owner_name')}" maxlength="120"></label>
        <label class="fld"><span>CRP</span><input name="owner_crp" value="${v('owner_crp')}" maxlength="30" placeholder="00/00000"></label>
        <label class="fld"><span>E-mail do responsável</span><input type="email" name="owner_email" value="${v('owner_email')}" maxlength="190"></label>
        <label class="fld"><span>WhatsApp do responsável</span><input name="owner_phone" value="${v('owner_phone')}" maxlength="40" inputmode="tel"></label>
        <label class="fld"><span>E-mail financeiro (faturas)</span><input type="email" name="billing_email" value="${v('billing_email')}" maxlength="190"></label>
        <label class="fld"><span>Outros WhatsApps da clínica <small class="muted">(separados por vírgula)</small></span><input name="extra_phones" value="${String(p.extra_phones || '').split(',').filter(Boolean).map(PlatCRM.fmtPhone).join(', ')}" maxlength="200"></label>
        <h2 class="span2">Endereço</h2>
        <label class="fld"><span>CEP</span><input name="cep" value="${String(p.cep || '').replace(/^(\d{5})(\d{3})$/, '$1-$2')}" maxlength="9" inputmode="numeric"></label>
        <label class="fld"><span>Rua</span><input name="street" value="${v('street')}" maxlength="160"></label>
        <label class="fld"><span>Número</span><input name="addr_number" value="${v('addr_number')}" maxlength="20"></label>
        <label class="fld"><span>Complemento</span><input name="complement" value="${v('complement')}" maxlength="80"></label>
        <label class="fld"><span>Bairro</span><input name="district" value="${v('district')}" maxlength="80"></label>
        <label class="fld"><span>Cidade</span><input name="city" value="${v('city')}" maxlength="80"></label>
        <label class="fld"><span>UF</span><select name="uf"><option value="">—</option>${UF.map((u) => html`<option ${u === p.uf ? raw('selected') : ''}>${u}</option>`)}</select></label>
        <h2 class="span2">Presença e origem</h2>
        <label class="fld"><span>Site</span><input name="site" value="${v('site')}" maxlength="190" placeholder="https://"></label>
        <label class="fld"><span>Instagram</span><input name="instagram" value="${p.instagram ? `@${p.instagram}` : ''}" maxlength="80" placeholder="@perfil"></label>
        <label class="fld"><span>Como conheceu a Mentez</span><select name="source"><option value="">—</option>${PlatCRM.SOURCES.map((s) => html`<option ${s === p.source ? raw('selected') : ''}>${s}</option>`)}</select></label>
        <p class="span2 muted small">CPF/CNPJ fica guardado criptografado. Os WhatsApps cadastrados aqui ligam as mensagens recebidas no WhatsApp da Mentez a esta clínica.</p>
        <div class="span2 actions"><button class="btn">Salvar</button><button class="btn ghost" formaction="/clinicas/${t.id}/cadastro/importar" formnovalidate>Completar com a identidade da clínica</button></div>
      </form>`));
  });
  handle.post('/clinicas/:id/cadastro', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    const r = await PlatCRM.saveProfile(t.id, req.body);
    if (r.error) return res.flash(r.error, 'err').redirect(`/clinicas/${t.id}/cadastro`);
    await log(req, 'clinica-cadastro', t.id); res.flash('Dados cadastrais salvos.').redirect(`/clinicas/${t.id}/cadastro`);
  });
  // Preenche os campos vazios com o que a clínica cadastrou na Identidade (telefone, e-mail, endereço, site, CRP)
  handle.post('/clinicas/:id/cadastro/importar', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    try {
      const br = await T.run(t, () => Brand.load());
      const p = await PlatCRM.profile(t.id);
      const pick = (cur, val) => (cur ? cur : val || '');
      await PlatCRM.saveProfile(t.id, { ...p, doc: p.doc, extra_phones: p.extra_phones, owner_name: pick(p.owner_name, br.proName?.replace(/^(Dra?\.)\s*/, '')), owner_crp: pick(p.owner_crp, br.crp), owner_email: pick(p.owner_email, br.email), owner_phone: pick(p.owner_phone, br.phone),
        street: pick(p.street, br.address), city: pick(p.city, br.city), uf: pick(p.uf, br.uf), site: pick(p.site, br.site), instagram: pick(p.instagram, br.instagram) });
      await log(req, 'clinica-cadastro-importar', t.id); res.flash('Campos vazios completados com a identidade da clínica. Confira e ajuste se precisar.');
    } catch (e) { res.flash(`Não foi possível ler a identidade da clínica: ${e.message}`, 'err'); }
    res.redirect(`/clinicas/${t.id}/cadastro`);
  });

  // ---------- anotações ----------
  handle.get('/clinicas/:id/anotacoes', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    const ns = await PlatCRM.notes(t.id);
    send(res, layout(req, `${t.name} · Anotações`, html`<header class="ph"><div><p class="eyebrow">Clínica</p><h1>${t.name}</h1></div><div class="ph-actions"><a class="btn ghost" href="/clinicas">Clínicas</a></div></header>
      ${await clinicTabs(t.id, '/anotacoes')}
      <form method="post" class="card stack"><label class="fld"><span>Nova anotação <small class="muted">(só a equipe Mentez vê)</small></span><textarea name="body" rows="3" maxlength="6000" required placeholder="Ex.: Ligação com a Dra. Ana: quer migrar para o plano Clínica em janeiro."></textarea></label>
        <div class="actions"><label class="check"><input type="checkbox" name="pinned" value="1"> Fixar no topo da ficha da clínica</label><button class="btn">Salvar anotação</button></div></form>
      <section class="pc-notes">${ns.length ? ns.map((n) => html`<article class="card pc-note ${n.pinned ? 'pin' : ''}"><header><b>${n.pinned ? '📌 ' : ''}${n.author || 'Equipe'}</b><time>${brDateTime(n.created_at)}</time></header><p>${n.body}</p>
        <footer><form method="post" action="/clinicas/${t.id}/anotacoes/${n.id}/fixar"><button class="link small">${n.pinned ? 'Desafixar' : 'Fixar'}</button></form>
        ${req.admin.role === 'admin' || n.author_email === req.admin.email ? html`<form method="post" action="/clinicas/${t.id}/anotacoes/${n.id}/excluir" data-confirm="Excluir esta anotação?"><button class="link small danger-text">Excluir</button></form>` : ''}</footer></article>`)
        : html`<p class="muted">Nenhuma anotação ainda. Registre ligações, combinados, preferências e histórico da clínica.</p>`}</section>`));
  });
  handle.post('/clinicas/:id/anotacoes', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    try { await PlatCRM.addNote(t.id, req.admin, req.body.body, req.body.pinned); await log(req, 'clinica-anotacao', t.id); res.flash('Anotação salva.'); } catch (e) { res.flash(e.message, 'err'); }
    res.redirect(req.body.back === 'conversa' ? `/clinicas/${t.id}/conversa` : `/clinicas/${t.id}/anotacoes`);
  });
  handle.post('/clinicas/:id/anotacoes/:nid/fixar', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    await PlatCRM.togglePin(t.id, int(req.params.nid)); res.redirect(`/clinicas/${t.id}/anotacoes`);
  });
  handle.post('/clinicas/:id/anotacoes/:nid/excluir', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    try { if (await PlatCRM.deleteNote(t.id, int(req.params.nid), req.admin)) { await log(req, 'clinica-anotacao-excluir', t.id); res.flash('Anotação excluída.'); } } catch (e) { res.flash(e.message, 'err'); }
    res.redirect(`/clinicas/${t.id}/anotacoes`);
  });

  // ---------- conversa no WhatsApp da Mentez ----------
  const waOn = async () => { const s = await PlatComm.waStatus().catch(() => ({ state: 'erro' })); if (s.state === 'open') PlatComm.ensureWebhook().catch(() => {}); return s.state === 'open'; };
  handle.get('/clinicas/:id/conversa', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    const [msgs, notes, phones, on] = await Promise.all([PlatCRM.threadOf({ tenantId: t.id }), PlatCRM.notes(t.id), PlatCRM.phonesOf(t.id), waOn()]);
    await PlatCRM.markRead({ tenantId: t.id });
    const p = await PlatCRM.profile(t.id);
    send(res, layout(req, `${t.name} · WhatsApp`, html`<header class="ph"><div><p class="eyebrow">Clínica</p><h1>${t.name}</h1></div><div class="ph-actions"><a class="btn ghost" href="/conversas">Todas as conversas</a></div></header>
      ${await clinicTabs(t.id, '/conversa')}
      ${!on ? html`<div class="flash warn">O WhatsApp da Mentez não está conectado. <a href="/comunicacao">Conectar</a> — enquanto isso, dá para registrar anotações.</div>` : ''}
      ${!phones.length ? html`<div class="flash info">Esta clínica não tem WhatsApp cadastrado. <a href="/clinicas/${t.id}/cadastro">Cadastre em Dados cadastrais</a>.</div>` : ''}
      <section class="card chat pc-chat">
        <header class="chat-h"><div class="chat-who"><span class="mz2-av">${String(t.name).replace(/^(Dra?\.?\s+)/i, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase()}</span><span><b>${p.owner_name || t.name}</b><small class="muted">${phones.map(PlatCRM.fmtPhone).join(' · ') || 'sem WhatsApp'}</small></span></div><small class="muted">WhatsApp da Mentez</small></header>
        <div class="chat-body" data-chat-body>${chat(msgs, notes)}</div>
        <form method="post" action="/clinicas/${t.id}/conversa" class="chat-compose" data-chat-compose>
          ${phones.length > 1 ? html`<select name="phone" class="pc-to" aria-label="Enviar para">${phones.map((x) => html`<option value="${x}">${PlatCRM.fmtPhone(x)}</option>`)}</select>` : html`<input type="hidden" name="phone" value="${phones[0] || ''}">`}
          <textarea name="text" rows="1" maxlength="3000" required placeholder="${on && phones.length ? 'Digite uma mensagem' : 'Escreva uma anotação interna'}" data-autogrow></textarea>
          <input type="hidden" name="back" value="conversa">
          <button class="btn ghost chat-note" formaction="/clinicas/${t.id}/conversa/nota" title="Salvar como anotação interna (não envia)">📝 Anotar</button>
          ${on && phones.length ? html`<button class="btn chat-send" title="Enviar pelo WhatsApp da Mentez (Enter)">Enviar ➤</button>` : ''}
        </form>
        ${on && phones.length ? html`<p class="chat-hint muted">Enter envia · Shift+Enter quebra a linha · a mensagem sai pelo WhatsApp da Mentez.</p>` : ''}
      </section>`));
  });
  handle.post('/clinicas/:id/conversa', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    const phones = await PlatCRM.phonesOf(t.id); const to = PlatCRM.digits(req.body.phone);
    if (!phones.includes(to)) return res.flash('Escolha um WhatsApp cadastrado da clínica.', 'err').redirect(`/clinicas/${t.id}/conversa`);
    try { await PlatComm.waSend(to, str(req.body.text, 3000), { kind: 'manual', author: req.admin.name, tenantId: t.id }); await log(req, 'clinica-whatsapp', t.id); } catch (e) { res.flash(`Não enviada: ${e.message}`, 'err'); }
    res.redirect(`/clinicas/${t.id}/conversa`);
  });
  handle.post('/clinicas/:id/conversa/nota', need, async (req, res, next) => {
    const t = await tenantOf(req); if (!t) return next();
    try { await PlatCRM.addNote(t.id, req.admin, req.body.text, false); } catch (e) { res.flash(e.message, 'err'); }
    res.redirect(`/clinicas/${t.id}/conversa`);
  });

  // ---------- caixa de entrada ----------
  handle.get('/conversas', need, async (req, res) => {
    const [rows, on] = await Promise.all([PlatCRM.inbox(), waOn()]);
    send(res, layout(req, 'Conversas', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Conversas</h1><p class="muted">Tudo o que passa pelo WhatsApp da Mentez: clínicas e contatos novos. Mensagens de números cadastrados nas clínicas aparecem na ficha de cada uma.</p></div></header>
      ${!on ? html`<div class="flash warn">O WhatsApp da Mentez não está conectado: novas mensagens não chegam. <a href="/comunicacao">Conectar</a></div>` : ''}
      <section class="card flush">${rows.length ? html`<ul class="pc-inbox">${rows.map((c) => html`<li class="${c.unread ? 'unread' : ''}"><a href="${c.tenant_id ? `/clinicas/${c.tenant_id}/conversa` : `/conversas/${c.phone}`}">
          <span class="mz2-av">${(c.tenant_name || c.name || '?').replace(/^(Dra?\.?\s+)/i, '').split(/\s+/).slice(0, 2).map((w) => w[0] || '').join('').toUpperCase()}</span>
          <span class="pc-in-main"><b>${c.tenant_name || c.name || PlatCRM.fmtPhone(c.phone)}</b><small>${c.last_dir === 'out' ? '✓ ' : ''}${c.last}</small></span>
          <span class="pc-in-side"><time>${c.last_at ? brDateTime(c.last_at) : ''}</time>${c.unread ? html`<i class="pc-badge">${c.unread}</i>` : !c.tenant_id ? html`<small class="chip">contato novo</small>` : ''}</span></a></li>`)}</ul>`
        : html`<p class="pad muted">Nenhuma conversa ainda. Quando alguém escrever para o WhatsApp da Mentez, aparece aqui.</p>`}</section>`));
  });
  handle.get('/conversas/:phone', need, async (req, res, next) => {
    const phone = PlatCRM.digits(req.params.phone); if (phone.length < 10) return next();
    const c = await PlatCRM.contact(phone); if (c?.tenant_id) return res.redirect(`/clinicas/${c.tenant_id}/conversa`);
    const [msgs, on, clinics] = await Promise.all([PlatCRM.threadOf({ phone }), waOn(), T.pq('SELECT id, name FROM tenants ORDER BY name')]);
    await PlatCRM.markRead({ phone });
    send(res, layout(req, 'Conversa', html`<header class="ph"><div><p class="eyebrow">Conversas · contato novo</p><h1>${c?.name || PlatCRM.fmtPhone(phone)}</h1><p class="muted">${PlatCRM.fmtPhone(phone)}</p></div><div class="ph-actions"><a class="btn ghost" href="/conversas">Voltar</a></div></header>
      <form method="post" action="/conversas/${phone}/vincular" class="card actions"><span>Este número é de uma clínica?</span><select name="tenant" required><option value="">Escolha a clínica…</option>${clinics.map((x) => html`<option value="${x.id}">${x.name}</option>`)}</select><button class="btn btn-sm">Vincular à clínica</button></form>
      <section class="card chat pc-chat"><div class="chat-body" data-chat-body>${chat(msgs)}</div>
        ${on ? html`<form method="post" action="/conversas/${phone}" class="chat-compose" data-chat-compose><textarea name="text" rows="1" maxlength="3000" required placeholder="Digite uma mensagem" data-autogrow></textarea><button class="btn chat-send">Enviar ➤</button></form>` : ''}</section>`));
  });
  handle.post('/conversas/:phone', need, async (req, res, next) => {
    const phone = PlatCRM.digits(req.params.phone); if (phone.length < 10) return next();
    try { await PlatComm.waSend(phone, str(req.body.text, 3000), { kind: 'manual', author: req.admin.name }); } catch (e) { res.flash(`Não enviada: ${e.message}`, 'err'); }
    res.redirect(`/conversas/${phone}`);
  });
  handle.post('/conversas/:phone/vincular', need, async (req, res, next) => {
    const phone = PlatCRM.digits(req.params.phone); const tid = int(req.body.tenant); if (phone.length < 10 || !tid) return next();
    await PlatCRM.linkPhone(phone, tid); await log(req, 'conversa-vincular', tid, PlatCRM.fmtPhone(phone));
    res.flash('Número vinculado à clínica: a conversa agora aparece na ficha dela.').redirect(`/clinicas/${tid}/conversa`);
  });
}
