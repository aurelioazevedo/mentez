import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, badge, brDate, brDateTime, waLink, logoTag } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { encrypt, decrypt, randomToken, sha256 } from '../lib/crypto.js';
import { nowLocal, todayLocal, addDays } from '../lib/time.js';
import { BOOKS } from '../lib/exercises.js';
import * as Lib from '../lib/exlib.js';
import { byKey, formOf } from '../lib/exlib.js';
import { sheet } from '../lib/exsheet.js';
import { renderForm, parseForm, renderResponse } from '../lib/forms.js';
import { patientScope, canSeePatient, forbidden } from '../lib/perm.js';
import * as WA from '../lib/whatsapp.js';
import { notify } from '../lib/push.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRIVATE = path.join(__dirname, '..', 'private');
const r = router();
r.use(async (req, res, next) => { await Lib.warm(); next(); });
r.param('id', async (req, res, next, id) => {
  try {
    const s = await one('SELECT p.owner_id FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [int(id)]);
    if (s && !canSeePatient(req.user, s)) return next(forbidden());
    next();
  } catch (e) { next(e); }
});
const nm = (p) => p.social_name || p.name;
const baseUrl = (req) => Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`;

// ---------- catálogo ----------
r.get('/', async (req, res) => {
  const sc = patientScope(req.user);
  const counts = await q(`SELECT s.exercise_key, COUNT(*) n FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE 1=1 ${sc.sql} GROUP BY s.exercise_key`, sc.params);
  const used = Object.fromEntries(counts.map((c) => [c.exercise_key, c.n]));
  const models = await Lib.list();
  const pending = await q(`SELECT s.*, p.name, p.social_name FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.status IN ('enviado','aberto','respondido') ${sc.sql} ORDER BY s.created_at DESC LIMIT 30`, sc.params);
  send(res, page(req, {
    title: 'Exercícios', active: 'exercicios',
    body: html`
    <header class="ph"><div><p class="eyebrow">Tarefas entre as sessões</p><h1>Exercícios</h1></div></header>
    <p class="lead">Monte a sua biblioteca de exercícios: comece pela <a class="link" href="/exercicios/biblioteca">Biblioteca Mentez</a>, crie do zero ou peça um rascunho à IA. Cada exercício vira um formulário que o paciente preenche no celular e uma folha para imprimir com a sua marca. Só exercícios <b>revisados e aprovados</b> por um profissional podem ser enviados.</p>
    <div class="actions"><a class="btn" href="/exercicios/modelos/novo">+ Novo exercício</a><a class="btn ghost" href="/exercicios/biblioteca">Biblioteca Mentez</a><a class="btn ghost" href="/exercicios/ia">✨ Criar com IA</a></div>
    ${pending.length ? html`<section class="card flush"><h2 class="pad-h">Em andamento</h2><div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Paciente</th><th>Folha</th><th>Enviado</th><th>Situação</th></tr></thead>
      <tbody>${pending.map((s) => html`<tr data-href="/exercicios/envio/${s.id}"><td><a href="/exercicios/envio/${s.id}">${nm(s)}</a></td><td>${byKey(s.exercise_key)?.title || s.exercise_key}</td><td>${brDate(s.created_at)}</td><td>${badge(s.status)}</td></tr>`)}</tbody></table></div></section>` : ''}
    <section class="card"><h2>Exercícios da clínica</h2>
      ${models.length ? html`<div class="ex-grid">${models.map((m) => html`
        <article class="ex ${m.active ? '' : 'off'}"><span class="ex-n">${m.source === 'ia' ? '✨' : m.source === 'base' ? 'M' : '✎'}</span><div><b>${m.title}</b>
          <small>${!m.active ? html`<span class="badge b-cancelada">arquivado</span>` : m.reviewed ? html`<span class="badge b-confirmada">aprovado</span>` : html`<span class="badge b-agendada">aguardando revisão</span>`} · ${m.category}${used[m.key] ? ` · enviado ${used[m.key]}×` : ''}</small></div>
          <div class="ex-actions"><a class="link small" href="/exercicios/modelos/${m.id}">${m.reviewed ? 'abrir' : 'revisar'}</a><a class="link small" href="/exercicios/modelos/${m.id}/folha" target="_blank">folha</a></div>
        </article>`)}</div>` : html`<p class="muted">Nenhum exercício ainda. Que tal começar pela <a class="link" href="/exercicios/biblioteca">Biblioteca Mentez</a>?</p>`}
    </section>
    ${Lib.cadernos().length ? Object.entries(BOOKS).map(([k, b]) => html`
      <section class="card"><h2>${b.title}</h2>
      <div class="ex-grid">${Lib.cadernos().filter((e) => e.book === k).map((e) => html`
        <article class="ex"><span class="ex-n">${e.num}</span><div><b>${e.title}</b>
          <small>${e.form ? html`<span class="badge b-confirmada">interativa</span>` : html`<span class="badge b-agendada">PDF</span>`}${used[e.key] ? ` · enviada ${used[e.key]}×` : ''}</small></div>
          <div class="ex-actions">${e.form ? html`<a class="link small" href="/exercicios/ver/${e.key}">prévia</a>` : ''}<a class="link small" href="/folhas/${e.pdf}" target="_blank">PDF</a></div>
        </article>`)}</div></section>`) : ''}`,
  }));
});

r.get('/ver/:book/:slug', (req, res, next) => {
  const ex = byKey(`${req.params.book}/${req.params.slug}`);
  if (!ex || !ex.form) return next();
  send(res, page(req, {
    title: ex.title, active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow">${ex.bookTitle} · prévia</p><h1>${ex.title}</h1></div><div class="ph-actions"><a class="btn ghost" href="/folhas/${ex.pdf}" target="_blank">PDF</a></div></header>
    <section class="card portal-form preview">${renderForm(ex.form)}</section>`,
  }));
});

// ---------- envio para o paciente ----------
r.post('/enviar', async (req, res) => {
  const p = await one('SELECT id, name, social_name, phone, owner_id FROM patients WHERE id = ?', [int(req.body.patient_id)]);
  if (p && !canSeePatient(req.user, p)) throw forbidden();
  const ex = byKey(req.body.exercise_key);
  if (!p || !ex) return res.flash('Selecione o paciente e a folha.', 'err').redirect('/exercicios');
  if (ex.model && !(ex.active && ex.reviewed)) return res.flash('Este exercício ainda precisa ser revisado e aprovado antes do envio.', 'err').redirect(`/exercicios/modelos/${ex.id}`);
  const days = [7, 14, 30].includes(int(req.body.days)) ? int(req.body.days) : 14;
  const token = randomToken();
  const out = await q('INSERT INTO assignments (patient_id, exercise_key, token_hash, instructions, expires_at, form_json) VALUES (?,?,?,?,?,?)',
    [p.id, ex.key, sha256(token), str(req.body.instructions, 1000) || null, `${addDays(todayLocal(), days)} 23:59:59`, ex.model ? JSON.stringify(ex.fields) : null]);
  await audit(req, 'exercicio-enviar', `assignment:${out.insertId}`);
  let sent = null;
  if (req.body.wa) sent = await WA.sendExercise(p.id, ex.title, `${baseUrl(req)}/p/${token}`, req.user.id);
  showLink(req, res, out.insertId, token, sent);
});

// Gera um novo link e envia automaticamente pelo WhatsApp.
r.post('/envio/:id/whatsapp', async (req, res, next) => {
  const s = await one('SELECT id, patient_id, exercise_key FROM assignments WHERE id = ?', [int(req.params.id)]);
  if (!s) return next();
  const token = randomToken();
  await q('UPDATE assignments SET token_hash = ?, expires_at = GREATEST(expires_at, ?) WHERE id = ?', [sha256(token), `${addDays(todayLocal(), 7)} 23:59:59`, s.id]);
  const r2 = await WA.sendExercise(s.patient_id, byKey(s.exercise_key)?.title || 'exercício', `${baseUrl(req)}/p/${token}`, req.user.id);
  await audit(req, 'exercicio-whatsapp', `assignment:${s.id}`);
  res.flash(r2.ok ? 'Link enviado pelo WhatsApp.' : `Não enviado: ${r2.error}`, r2.ok ? 'ok' : 'err').redirect(`/exercicios/envio/${s.id}`);
});

async function showLink(req, res, id, token, sent = null) {
  const waOn = WA.ready(await WA.config());
  const s = await one('SELECT s.*, p.name, p.social_name, p.phone FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [id]);
  const ex = byKey(s.exercise_key);
  const link = `${baseUrl(req)}/p/${token}`;
  const wa = waLink(s.phone, `Olá, ${nm(s).split(' ')[0]}! Conforme combinamos na sessão, segue o exercício “${ex.title}”. É só abrir o link: ${link}\n\nO link é pessoal, não compartilhe. — ${Brand.get().proName || Brand.get().short}${Brand.get().proRole ? `, ${Brand.get().proRole}` : ''}`);
  send(res, page(req, {
    title: 'Link gerado', active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow">${nm(s)}</p><h1>Link do exercício</h1></div></header>
    <section class="card">
      <p><b>${ex.title}</b> · válido até ${brDate(s.expires_at)}</p>
      <div class="copy"><input readonly value="${link}" id="lnk"><button class="btn ghost" data-copy="#lnk">Copiar</button></div>
      ${sent ? html`<div class="flash ${sent.ok ? 'ok' : 'err'}">${sent.ok ? 'Link enviado automaticamente pelo WhatsApp.' : `WhatsApp não enviado: ${sent.error}`}</div>` : ''}
      <div class="actions">${waOn && !sent?.ok ? html`<form method="post" action="/exercicios/envio/${id}/whatsapp"><button class="btn">Enviar pelo WhatsApp (automático)</button></form>` : ''}${!waOn && wa ? html`<a class="btn" href="${wa}" target="_blank" rel="noopener">Enviar pelo WhatsApp</a>` : ''}<a class="btn ghost" href="/pacientes/${s.patient_id}?aba=exercicios">Voltar ao paciente</a></div>
      <p class="muted small">Por segurança, o link só é exibido agora. Se perder, use “Gerar novo link” na página do envio.</p>
    </section>`,
  }));
}

r.get('/envio/:id', async (req, res, next) => {
  const s = await one('SELECT s.*, p.name, p.social_name FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [int(req.params.id)]);
  if (!s) return next();
  const ex = byKey(s.exercise_key);
  const resp = s.response_enc ? JSON.parse(decrypt(s.response_enc)) : null;
  await audit(req, 'exercicio-ver', `assignment:${s.id}`);
  send(res, page(req, {
    title: ex?.title || 'Exercício', active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow"><a href="/pacientes/${s.patient_id}?aba=exercicios">${nm(s)}</a> · ${ex?.bookTitle || ''}</p><h1>${ex?.title || s.exercise_key}</h1></div>
      <div class="ph-actions">${badge(s.status)}
        ${s.status === 'respondido' ? html`<form method="post" action="/exercicios/envio/${s.id}/revisado"><button class="btn">Marcar como revisado</button></form>` : ''}
        <form method="post" action="/exercicios/envio/${s.id}/novo-link"><button class="btn ghost">Gerar novo link</button></form>
        ${WA.ready(await WA.config()) && s.status !== 'revisado' ? html`<form method="post" action="/exercicios/envio/${s.id}/whatsapp"><button class="btn ghost">Reenviar pelo WhatsApp</button></form>` : ''}
        ${resp ? html`<button class="btn ghost" data-print>Imprimir</button>` : ''}
      </div></header>
    <section class="card"><dl class="dl compact"><dt>Enviado</dt><dd>${brDateTime(s.created_at)}</dd><dt>Aberto</dt><dd>${brDateTime(s.opened_at)}</dd><dt>Respondido</dt><dd>${brDateTime(s.responded_at)}</dd><dt>Validade</dt><dd>${brDate(s.expires_at)}</dd>
      ${s.instructions ? html`<dt>Orientação</dt><dd>${s.instructions}</dd>` : ''}</dl></section>
    <section class="card answers">${formOf(s, ex) ? renderResponse(formOf(s, ex), resp) : html`<p>Folha entregue em PDF. <a class="link" href="/folhas/${ex?.pdf}" target="_blank">Abrir folha</a></p>`}${ex?.sheet ? html`<p><a class="link" href="/exercicios/envio/${s.id}/folha" target="_blank">Folha para imprimir</a></p>` : ''}</section>
    <form method="post" action="/exercicios/envio/${s.id}/excluir" class="danger-zone" data-confirm="Excluir este envio e a resposta?"><button class="btn danger">Excluir envio</button></form>`,
  }));
});

r.post('/envio/:id/revisado', async (req, res) => {
  await q(`UPDATE assignments SET status = 'revisado' WHERE id = ?`, [int(req.params.id)]);
  res.flash('Marcado como revisado.').redirect(`/exercicios/envio/${int(req.params.id)}`);
});

r.post('/envio/:id/novo-link', async (req, res, next) => {
  const s = await one('SELECT id FROM assignments WHERE id = ?', [int(req.params.id)]);
  if (!s) return next();
  const token = randomToken();
  await q(`UPDATE assignments SET token_hash = ?, expires_at = ?, status = IF(status='revisado','revisado',status) WHERE id = ?`, [sha256(token), `${addDays(todayLocal(), 14)} 23:59:59`, s.id]);
  await audit(req, 'exercicio-novo-link', `assignment:${s.id}`);
  showLink(req, res, s.id, token);
});

r.post('/envio/:id/excluir', async (req, res, next) => {
  const s = await one('SELECT id, patient_id FROM assignments WHERE id = ?', [int(req.params.id)]);
  if (!s) return next();
  await q('DELETE FROM assignments WHERE id = ?', [s.id]);
  await audit(req, 'exercicio-excluir', `assignment:${s.id}`);
  res.flash('Envio excluído.').redirect(`/pacientes/${s.patient_id}?aba=exercicios`);
});

// ---------- biblioteca da clínica: modelos ----------
const SRC = { base: 'Biblioteca Mentez', ia: 'Rascunho da IA', proprio: 'Criado na clínica' };
const colLine = (c) => `${c.label}${c.type === 'number' ? ' [número]' : c.type === 'date' ? ' [data]' : ''}`;
const parseCols = (txt) => String(txt || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
  const m = l.match(/\s*\[(n[uú]mero|data)\]\s*$/i);
  return { label: m ? l.slice(0, m.index).trim() : l, type: m ? (/^d/i.test(m[1]) ? 'date' : 'number') : 'text' };
});
// Campos vindos do editor (fields[i][…]) → formato do lib/exlib
function fieldsFromBody(b) {
  const raw0 = b.fields || [];
  const list = Array.isArray(raw0) ? raw0 : Object.keys(raw0).sort((a, z) => a - z).map((k) => raw0[k]);
  return list.filter(Boolean).map((f) => ({
    type: f.type, label: f.label, text: f.text, left: f.left, right: f.right, rows: f.rows, chart: !!f.chart,
    options: String(f.options || '').split('\n').map((x) => x.trim()).filter(Boolean), columns: parseCols(f.columns),
  }));
}
function fieldRow(f = { type: 'textarea' }, i = '__i__') {
  const n = (k) => `fields[${i}][${k}]`;
  return html`<div class="fe" data-type="${f.type}">
    <div class="fe-h"><select name="${n('type')}" class="fe-type">${Object.entries(Lib.FIELD_TYPES).map(([k, l]) => html`<option value="${k}" ${f.type === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <span class="fe-tools"><button type="button" class="btn ghost sm" data-fe="up" title="Subir">↑</button><button type="button" class="btn ghost sm" data-fe="down" title="Descer">↓</button><button type="button" class="btn ghost sm" data-fe="del" title="Remover">✕</button></span></div>
    <label class="fld fe-label"><span>Pergunta / título do campo</span><input name="${n('label')}" value="${f.label || ''}" maxlength="200"></label>
    <label class="fld fe-text"><span>Texto de orientação</span><textarea name="${n('text')}" rows="2" maxlength="1200">${f.text || ''}</textarea></label>
    <div class="fe-scale form-grid"><label class="fld"><span>Rótulo do 0</span><input name="${n('left')}" value="${f.left || ''}" maxlength="30" placeholder="0"></label><label class="fld"><span>Rótulo do 10</span><input name="${n('right')}" value="${f.right || ''}" maxlength="30" placeholder="10"></label></div>
    <label class="fld fe-checks"><span>Opções (uma por linha)</span><textarea name="${n('options')}" rows="4">${(f.options || []).join('\n')}</textarea></label>
    <div class="fe-table"><label class="fld"><span>Colunas (uma por linha; termine com [número] para gráfico ou [data])</span><textarea name="${n('columns')}" rows="4">${(f.columns || []).map(colLine).join('\n')}</textarea></label>
      <div class="form-grid"><label class="fld"><span>Linhas</span><input type="number" min="1" max="10" name="${n('rows')}" value="${f.rows || 3}"></label>
      <label class="fld check"><input type="checkbox" name="${n('chart')}" value="1" ${f.chart ? raw('checked') : ''}><span>Mostrar gráfico das colunas numéricas</span></label></div></div>
  </div>`;
}
function editor(req, res, m, { error = '', action }) {
  const isNew = !m.id;
  send(res, page(req, {
    title: isNew ? 'Novo exercício' : m.title, active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow"><a href="/exercicios">Exercícios</a>${m.source ? ` · ${SRC[m.source] || ''}` : ''}</p><h1>${isNew ? 'Novo exercício' : 'Editar exercício'}</h1></div>
      ${!isNew ? html`<div class="ph-actions"><a class="btn ghost" href="/exercicios/modelos/${m.id}">Cancelar</a></div>` : ''}</header>
    ${error ? html`<div class="flash err">${error}</div>` : ''}
    <form method="post" action="${action}" class="ex-editor" id="ex-editor">
      <section class="card form-grid">
        <label class="fld span2"><span>Título</span><input name="title" value="${m.title || ''}" maxlength="160" required></label>
        <label class="fld"><span>Categoria</span><select name="category">${Lib.CATEGORIES.map((c) => html`<option ${m.category === c ? raw('selected') : ''}>${c}</option>`)}</select></label>
        <label class="fld"><span>Resumo (só para a equipe)</span><input name="summary" value="${m.summary || ''}" maxlength="300"></label>
        <label class="fld span2"><span>Orientação ao paciente (aparece no topo)</span><textarea name="intro" rows="3" maxlength="3000">${m.intro || ''}</textarea></label>
      </section>
      <section class="card"><h2>Campos</h2>
        <div class="fe-list">${(m.fields?.length ? m.fields : [{ type: 'textarea' }]).map((f, i) => fieldRow(f, i))}</div>
        <template id="fe-tpl">${fieldRow()}</template>
        <button type="button" class="btn ghost" data-fe="add">+ Adicionar campo</button>
      </section>
      <div class="actions"><button class="btn">Salvar</button><span class="muted small">Ao salvar, o exercício fica aguardando a revisão de um profissional.</span></div>
    </form>`,
  }));
}
const canReview = (u) => ['admin', 'psicologo'].includes(u.role);
const statusBadge = (m) => (!m.active ? html`<span class="badge b-cancelada">arquivado</span>` : m.reviewed ? html`<span class="badge b-confirmada">aprovado</span>` : html`<span class="badge b-agendada">aguardando revisão</span>`);

r.get('/biblioteca', async (req, res) => {
  const mine = new Set((await Lib.list()).map((m) => m.base_slug).filter(Boolean));
  send(res, page(req, {
    title: 'Biblioteca Mentez', active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow"><a href="/exercicios">Exercícios</a></p><h1>Biblioteca Mentez</h1></div></header>
    <p class="lead">Modelos de técnicas clássicas, em linguagem simples, para você adaptar à sua prática. Ao usar um modelo, ele é copiado para a sua clínica: você pode editar tudo e precisa revisar e aprovar antes do primeiro envio.</p>
    ${Lib.CATEGORIES.filter((c) => Lib.BASE.some((b) => b.category === c)).map((c) => html`<section class="card"><h2>${c}</h2><div class="ex-grid">
      ${Lib.BASE.filter((b) => b.category === c).map((b) => html`<article class="ex"><div><b>${b.title}</b><small>${b.summary}</small></div>
        <div class="ex-actions"><a class="link small" href="/exercicios/biblioteca/${b.slug}">prévia</a>
        <form method="post" action="/exercicios/biblioteca/${b.slug}/usar"><button class="btn sm ${mine.has(b.slug) ? 'ghost' : ''}">${mine.has(b.slug) ? 'Usar de novo' : 'Usar na clínica'}</button></form></div></article>`)}
    </div></section>`)}`,
  }));
});
r.get('/biblioteca/:slug', (req, res, next) => {
  const b = Lib.baseBySlug(req.params.slug); if (!b) return next();
  send(res, page(req, {
    title: b.title, active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow"><a href="/exercicios/biblioteca">Biblioteca Mentez</a> · prévia</p><h1>${b.title}</h1></div>
      <div class="ph-actions"><form method="post" action="/exercicios/biblioteca/${b.slug}/usar"><button class="btn">Usar na clínica</button></form></div></header>
    ${b.intro ? html`<p class="note">${b.intro}</p>` : ''}
    <section class="card portal-form preview">${renderForm(b.fields)}</section>`,
  }));
});
r.post('/biblioteca/:slug/usar', async (req, res) => {
  const out = await Lib.copyBase(req.params.slug, req.user.id);
  if (out.error) return res.flash(out.error, 'err').redirect('/exercicios/biblioteca');
  await audit(req, 'exercicio-modelo-copiar', `ex_model:${out.id}`);
  res.flash('Copiado para a clínica. Revise o conteúdo, ajuste o que quiser e aprove para poder enviar.').redirect(`/exercicios/modelos/${out.id}`);
});

r.get('/ia', async (req, res) => {
  send(res, page(req, {
    title: 'Criar com IA', active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow"><a href="/exercicios">Exercícios</a></p><h1>✨ Criar com IA</h1></div></header>
    <section class="card"><p>Descreva o exercício que você quer. A IA monta um <b>rascunho</b> na sua biblioteca; ele só pode ser enviado depois que você revisar e aprovar. Não coloque nome nem dados do paciente.</p>
      <form method="post" action="/exercicios/ia" class="form-grid">
        <label class="fld span2"><span>Tema e objetivo</span><textarea name="theme" rows="3" maxlength="600" required placeholder="Ex.: identificar gatilhos de procrastinação nos estudos e planejar pequenos passos"></textarea></label>
        <label class="fld"><span>Público (opcional)</span><input name="audience" maxlength="120" placeholder="Ex.: adolescentes, adultos, casais"></label>
        <label class="fld"><span>Abordagem (opcional)</span><select name="approach"><option value="">Indiferente</option><option>TCC</option><option>ACT</option><option>DBT</option><option>Terapia focada na compaixão</option><option>Esquemas</option><option>Psicoeducação</option></select></label>
        <div class="actions span2"><button class="btn">Gerar rascunho</button><span class="muted small">Leva alguns segundos. Usa a chave de IA configurada em Documentos psicológicos ou na sua conta.</span></div>
      </form></section>`,
  }));
});
r.post('/ia', async (req, res) => {
  const out = await Lib.draftWithAI({ theme: req.body.theme, audience: req.body.audience, approach: req.body.approach, userId: req.user.id });
  if (out.error) return res.flash(out.error, 'err').redirect('/exercicios/ia');
  await audit(req, 'exercicio-modelo-ia', `ex_model:${out.id}`);
  res.flash('Rascunho criado. Leia com atenção, ajuste o que precisar e aprove para poder enviar.').redirect(`/exercicios/modelos/${out.id}`);
});

r.get('/modelos/novo', (req, res) => editor(req, res, { category: 'Outros', fields: [] }, { action: '/exercicios/modelos/novo' }));
r.post('/modelos/novo', async (req, res) => {
  const b = { ...req.body, fields: fieldsFromBody(req.body) };
  const out = await Lib.create(b, req.user.id);
  if (out.error) return editor(req, res, { ...b, fields: Lib.cleanFields(b.fields) }, { error: out.error, action: '/exercicios/modelos/novo' });
  await audit(req, 'exercicio-modelo-criar', `ex_model:${out.id}`);
  res.flash('Exercício salvo. Revise e aprove para poder enviar.').redirect(`/exercicios/modelos/${out.id}`);
});
r.get('/modelos/:mid', async (req, res, next) => {
  const m = await Lib.get(req.params.mid); if (!m) return next();
  const by = m.reviewed_by ? await one('SELECT name FROM users WHERE id = ?', [m.reviewed_by]) : null;
  send(res, page(req, {
    title: m.title, active: 'exercicios',
    body: html`<header class="ph"><div><p class="eyebrow"><a href="/exercicios">Exercícios</a> · ${m.category} · ${SRC[m.source] || ''}</p><h1>${m.title}</h1></div>
      <div class="ph-actions">${statusBadge(m)}
        <a class="btn ghost" href="/exercicios/modelos/${m.id}/editar">Editar</a>
        <a class="btn ghost" href="/exercicios/modelos/${m.id}/folha" target="_blank">Folha para imprimir</a>
      </div></header>
    ${!m.reviewed ? html`<section class="card ex-review"><h2>Revisão profissional</h2>
      <p>${m.source === 'ia' ? 'Este conteúdo foi gerado por IA e pode conter erros ou orientações inadequadas.' : m.source === 'base' ? 'Este modelo veio da Biblioteca Mentez. Confira se a linguagem e a técnica servem para os seus pacientes.' : 'Confira o conteúdo antes de liberar.'} Leia todos os campos abaixo e a folha para imprimir.</p>
      ${canReview(req.user) ? html`<form method="post" action="/exercicios/modelos/${m.id}/aprovar" class="actions"><label class="fld check"><input type="checkbox" name="ok" value="1" required><span>Revisei o conteúdo e assumo a responsabilidade técnica pelo seu uso.</span></label><button class="btn">Aprovar para envio</button></form>`
        : html`<p class="muted">Peça a um(a) psicólogo(a) ou ao administrador para aprovar.</p>`}</section>`
      : html`<p class="muted small">Aprovado${by ? ` por ${by.name}` : ''} em ${brDateTime(m.reviewed_at)}. Envie pela ficha do paciente, na aba Exercícios. Qualquer edição volta o exercício para revisão.</p>`}
    ${m.summary ? html`<p class="muted">${m.summary}</p>` : ''}
    ${m.intro ? html`<p class="note">${m.intro}</p>` : ''}
    <section class="card portal-form preview">${renderForm(m.fields)}</section>
    <div class="actions">
      ${m.active ? html`<form method="post" action="/exercicios/modelos/${m.id}/arquivar"><button class="btn ghost">Arquivar</button></form>` : html`<form method="post" action="/exercicios/modelos/${m.id}/reativar"><button class="btn ghost">Reativar</button></form>`}
      <form method="post" action="/exercicios/modelos/${m.id}/excluir" data-confirm="Excluir este exercício? Se já foi enviado a algum paciente, ele será só arquivado."><button class="btn danger">Excluir</button></form>
    </div>`,
  }));
});
r.get('/modelos/:mid/editar', async (req, res, next) => {
  const m = await Lib.get(req.params.mid); if (!m) return next();
  editor(req, res, m, { action: `/exercicios/modelos/${m.id}/editar` });
});
r.post('/modelos/:mid/editar', async (req, res, next) => {
  const m = await Lib.get(req.params.mid); if (!m) return next();
  const b = { ...req.body, fields: fieldsFromBody(req.body) };
  const out = await Lib.update(m.id, b);
  if (out.error) return editor(req, res, { ...m, ...b, fields: Lib.cleanFields(b.fields) }, { error: out.error, action: `/exercicios/modelos/${m.id}/editar` });
  await audit(req, 'exercicio-modelo-editar', `ex_model:${m.id}`);
  res.flash('Alterações salvas. O exercício voltou para revisão.').redirect(`/exercicios/modelos/${m.id}`);
});
r.post('/modelos/:mid/aprovar', async (req, res, next) => {
  const m = await Lib.get(req.params.mid); if (!m) return next();
  if (!canReview(req.user)) throw forbidden();
  if (!req.body.ok) return res.flash('Marque a confirmação de revisão.', 'err').redirect(`/exercicios/modelos/${m.id}`);
  await Lib.approve(m.id, req.user.id);
  await audit(req, 'exercicio-modelo-aprovar', `ex_model:${m.id}`);
  res.flash('Aprovado. Já pode ser enviado pela ficha do paciente.').redirect(`/exercicios/modelos/${m.id}`);
});
r.post('/modelos/:mid/arquivar', async (req, res) => { await Lib.setActive(int(req.params.mid), false); res.flash('Arquivado.').redirect(`/exercicios/modelos/${int(req.params.mid)}`); });
r.post('/modelos/:mid/reativar', async (req, res) => { await Lib.setActive(int(req.params.mid), true); res.flash('Reativado.').redirect(`/exercicios/modelos/${int(req.params.mid)}`); });
r.post('/modelos/:mid/excluir', async (req, res, next) => {
  const m = await Lib.get(req.params.mid); if (!m) return next();
  const out = await Lib.remove(m.id);
  await audit(req, 'exercicio-modelo-excluir', `ex_model:${m.id}`);
  if (out.archived) return res.flash('Este exercício já foi enviado a pacientes, então foi arquivado (as respostas continuam guardadas).').redirect(`/exercicios/modelos/${m.id}`);
  res.flash('Exercício excluído.').redirect('/exercicios');
});
r.get('/modelos/:mid/folha', async (req, res, next) => {
  const m = await Lib.get(req.params.mid); if (!m) return next();
  send(res, sheet(m));
});
// Folha de um envio (com o nome do paciente)
r.get('/envio/:id/folha', async (req, res, next) => {
  const s = await one('SELECT s.*, p.name, p.social_name FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.id = ?', [int(req.params.id)]);
  const ex = s && byKey(s.exercise_key);
  if (!ex?.sheet) return next();
  send(res, sheet({ ...ex, fields: formOf(s, ex) || ex.fields }, { patient: nm(s) }));
});

export default r;

// =====================================================================
// Portal do paciente: /p/:token  (sem login; link pessoal com validade)
// =====================================================================
export const portal = router();
portal.use(async (req, res, next) => { await Lib.warm(); next(); });

async function byToken(token) {
  if (!/^[A-Za-z0-9_-]{30,60}$/.test(String(token))) return null;
  const s = await one('SELECT s.*, p.name, p.social_name FROM assignments s JOIN patients p ON p.id = s.patient_id WHERE s.token_hash = ?', [sha256(token)]);
  if (!s || s.expires_at < nowLocal()) return null;
  return s;
}

const portalShell = (title, inner) => bare(title, html`
  <div class="portal">
    <header class="portal-h">${logoTag('')}<span>${Brand.get().signLine}</span></header>
    ${inner}
    <footer class="portal-f">Este link é pessoal e sigiloso. Suas respostas são vistas apenas pelo seu profissional.<br>Em caso de crise: CVV 188 · SAMU 192</footer>
  </div>`, 'bare portal-bg');

const expired = () => portalShell('Link indisponível', html`<section class="portal-card"><h1>Link indisponível</h1><p>Este link expirou ou não é válido. Peça um novo link ao seu profissional.</p></section>`);

portal.get('/:token', async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) return res.status(404).type('html').send(String(expired()));
  const ex = byKey(s.exercise_key);
  if (!ex) return res.status(404).type('html').send(String(expired()));
  const form = formOf(s, ex);
  if (!s.opened_at) await q(`UPDATE assignments SET opened_at = ?, status = IF(status='enviado','aberto',status) WHERE id = ?`, [nowLocal(), s.id]);
  const resp = s.response_enc ? JSON.parse(decrypt(s.response_enc)) : {};
  const locked = s.status === 'revisado';
  const done = req.query.ok === '1';
  send(res, portalShell(ex.title, html`
    <section class="portal-card">
      <p class="eyebrow">Olá, ${nm(s).split(' ')[0]}</p>
      <h1>${ex.title}</h1>
      ${s.instructions ? html`<p class="note">${s.instructions}</p>` : ''}
      ${done ? html`<div class="flash ok">Pronto! Suas respostas foram enviadas. Você pode voltar a este link para completar até ${brDate(s.expires_at)}.</div>` : ''}
      <p>${ex.sheet ? html`<a class="btn ghost" href="/p/${req.params.token}/folha" target="_blank">Abrir a folha para imprimir</a>` : html`<a class="btn ghost" href="/p/${req.params.token}/folha.pdf">Baixar a folha em PDF</a>`}</p>
      ${form ? (locked ? html`<div class="answers">${renderResponse(form, resp)}</div><p class="muted">Este exercício já foi revisado pelo seu profissional.</p>` : html`
        <form method="post" class="portal-form">${renderForm(form, resp)}
          <button class="btn big" type="submit">Enviar respostas</button>
          <p class="muted small">Não existe resposta certa ou errada. Escreva do seu jeito.</p>
        </form>`) : html`<p>Imprima a folha (ou preencha à mão) e leve para a próxima sessão.</p>`}
    </section>`));
});

portal.post('/:token', async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) return res.status(404).type('html').send(String(expired()));
  const ex = byKey(s.exercise_key);
  const form = formOf(s, ex);
  if (!ex || !form || s.status === 'revisado') return res.redirect(`/p/${req.params.token}`);
  const data = parseForm(form, req.body);
  await q(`UPDATE assignments SET response_enc = ?, responded_at = ?, status = 'respondido' WHERE id = ?`, [encrypt(JSON.stringify(data)), nowLocal(), s.id]);
  const owner = await one('SELECT owner_id FROM patients WHERE id = ?', [s.patient_id]);
  notify(owner?.owner_id, { title: '📝 Exercício respondido', body: `${nm(s).split(' ')[0]} respondeu “${ex.title}”`, url: `/exercicios/envio/${s.id}`, tag: `ex-${s.id}` });
  res.redirect(`/p/${req.params.token}?ok=1`);
});

portal.get('/:token/folha.pdf', async (req, res) => {
  const s = await byToken(req.params.token);
  if (!s) return res.sendStatus(404);
  const ex = byKey(s.exercise_key);
  if (!ex?.pdf) return res.sendStatus(404);
  const file = path.join(Tenancy.filesDir(PRIVATE), ex.pdf);
  if (!fs.existsSync(file)) return res.sendStatus(404);
  res.sendFile(file);
});
portal.get('/:token/folha', async (req, res) => {
  const s = await byToken(req.params.token);
  const ex = s && byKey(s.exercise_key);
  if (!ex?.sheet) return res.sendStatus(404);
  send(res, sheet({ ...ex, fields: formOf(s, ex) || ex.fields }, { patient: nm(s) }));
});
