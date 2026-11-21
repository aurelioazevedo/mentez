// Convênios: Configurações → Convênios (operadoras e tabela), aba Convênio na ficha do paciente
// (carteirinhas e autorizações), quadro do convênio na sessão e a folha de assinaturas da autorização.
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, money, brDate } from '../lib/html.js';
import { router, send, int } from '../lib/router.js';
import { can, canSeePatient, forbidden, proName } from '../lib/perm.js';
import { todayLocal } from '../lib/time.js';
import * as Ins from '../lib/insurance.js';
import * as T from '../lib/tiss.js';
import * as Ret from '../lib/tissret.js';
import * as WS from '../lib/tissws.js';
import { GLOSAS, glosaLabel } from '../lib/tissglosas.js';
import express from 'express';
import { isYm, addMonths, monthName } from '../lib/time.js';
import { tabs as finTabs } from './finance.js';

const ck = (v) => (v ? raw('checked') : '');
const sel = (a, b) => (String(a ?? '') === String(b ?? '') ? raw('selected') : '');
const brl = (v) => String(Number(v || 0).toFixed(2)).replace('.', ',');
// valor digitado em reais (1.234,56 ou 1234.56)
const parseBr = (v, def) => { const s = String(v ?? '').trim(); if (!s) return def; const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s); return Number.isFinite(n) ? n : def; };

// ---------- Configurações → Convênios ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const list = await Ins.list();
  const simple = (await Ins.mode()) === 'simples';
  send(res, page(req, { title: 'Convênios', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Convênios</h1>
      <p class="muted">Ligue os convênios em que a clínica ou os profissionais são credenciados e cadastre a tabela de valores. Depois, a carteirinha e a autorização ficam na ficha do paciente, e cada sessão marca se é particular ou convênio.</p></div>
      <div class="ph-actions"><a class="btn" href="/configuracoes/convenios/novo">+ Outro convênio</a><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <section class="card flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Convênio</th><th>Situação</th><th>Autorização</th><th>Coparticipação</th><th class="num">Pacientes</th><th></th></tr></thead>
      <tbody>${list.map((i) => html`<tr data-id="${i.id}"><td><b>${i.name}</b>${i.ans_code ? html`<small class="muted block">ANS ${i.ans_code}</small>` : ''}</td>
        <td>${i.active ? html`<span class="badge b-realizada">Credenciado</span>` : html`<span class="badge b-cancelada">Não usa</span>`}</td>
        <td>${i.requires_auth ? `${i.sessions_per_auth} sessões / ${i.auth_days} dias` : 'não exige'}</td>
        <td>${i.copay_mode === 'nenhuma' ? '—' : i.copay_mode === 'percentual' ? `${brl(i.copay_value)}%` : money(i.copay_value)}</td>
        <td class="num">${i.plans}</td><td><a class="btn ghost btn-sm" href="/configuracoes/convenios/${i.id}">${i.active ? 'Editar' : 'Configurar'}</a></td></tr>`)}</tbody></table></div></section>
    ${simple ? '' : await tissCard()}
    <p class="muted small">Valores, regras de autorização e prazos estão no contrato com cada operadora. ${simple ? 'O que cada convênio deve à clínica, mês a mês, fica em Financeiro → Convênios.' : 'O faturamento em lote (XML TISS) fica em Financeiro → Convênios.'}</p>` }));
});
function insForm(i, ps, simple = false) {
  return html`<form method="post" class="card stack" id="ins-form">
    <div class="form-grid">
      <label class="fld"><span>Nome</span><input name="name" value="${i.name || ''}" maxlength="80" required></label>
      <label class="fld check"><input type="checkbox" name="active" value="1" ${ck(i.active)}><span><b>Credenciado</b> (aparece na ficha e na agenda)</span></label>
      ${simple ? html`<input type="hidden" name="ans_code" value="${i.ans_code || ''}"><input type="hidden" name="provider_code" value="${i.provider_code || ''}"><input type="hidden" name="send_via" value="${i.send_via || 'portal'}">` : html`<label class="fld"><span>Registro ANS da operadora</span><input name="ans_code" value="${i.ans_code || ''}" maxlength="20" inputmode="numeric"></label>
      <label class="fld"><span>Código do prestador (na operadora)</span><input name="provider_code" value="${i.provider_code || ''}" maxlength="40"></label>`}
      <label class="fld"><span>Quem é credenciado</span><select name="credential"><option value="clinica" ${sel(i.credential, 'clinica')}>A clínica (recebe da operadora)</option><option value="profissional" ${sel(i.credential, 'profissional')}>Cada profissional (recebe direto)</option></select></label>
      ${simple ? '' : html`<label class="fld"><span>Envio das guias</span><select name="send_via">${Object.entries(Ins.VIA).map(([k, l]) => html`<option value="${k}" ${sel(i.send_via, k)}>${l}</option>`)}</select></label>`}
      <label class="fld"><span>Portal da operadora</span><input name="portal_url" value="${i.portal_url || ''}" maxlength="300" placeholder="https://…"></label>
      <label class="fld"><span>Telefone de autorização</span><input name="phone" value="${i.phone || ''}" maxlength="40"></label>
    </div>
    <h2>Autorização e atendimento</h2>
    <label class="fld check"><input type="checkbox" name="requires_auth" value="1" ${ck(i.requires_auth ?? 1)}><span>Exige autorização (senha) antes das sessões</span></label>
    <div class="form-grid">
      <label class="fld"><span>Sessões por autorização</span><input type="number" name="sessions_per_auth" min="1" max="200" value="${i.sessions_per_auth || 10}"></label>
      <label class="fld"><span>Validade da autorização (dias)</span><input type="number" name="auth_days" min="1" max="730" value="${i.auth_days || 60}"></label>
    </div>
    <label class="fld check"><input type="checkbox" name="requires_signature" value="1" ${ck(i.requires_signature ?? 1)}><span>Paciente assina a guia a cada sessão</span></label>
    <label class="fld check"><input type="checkbox" name="requires_token" value="1" ${ck(i.requires_token)}><span>Exige token do paciente a cada sessão (código do app ou SMS da operadora)</span></label>
    <h2>Valores e pagamento</h2>
    <div class="form-grid">
      <label class="fld"><span>Coparticipação do paciente</span><select name="copay_mode">${Object.entries(Ins.COPAY).map(([k, l]) => html`<option value="${k}" ${sel(i.copay_mode, k)}>${l}</option>`)}</select></label>
      <label class="fld"><span>Quem cobra a coparticipação</span><select name="copay_where"><option value="operadora" ${sel(i.copay_where, 'operadora')}>A operadora (na mensalidade do paciente)</option><option value="prestador" ${sel(i.copay_where, 'prestador')}>A clínica, no atendimento</option></select></label>
      <label class="fld"><span>Percentual ou valor</span><input name="copay_value" inputmode="decimal" value="${i.copay_value ? brl(i.copay_value) : ''}"></label>
      <label class="fld"><span>Dia de fechamento do mês</span><input type="number" name="close_day" min="1" max="31" value="${i.close_day || ''}"></label>
      <label class="fld"><span>Prazo de pagamento (dias)</span><input type="number" name="pay_days" min="0" max="180" value="${i.pay_days ?? 30}"></label>
      ${simple ? html`<input type="hidden" name="appeal_days" value="${i.appeal_days ?? 30}">` : html`<label class="fld"><span>Prazo para recurso de glosa (dias)</span><input type="number" name="appeal_days" min="1" max="365" value="${i.appeal_days ?? 30}"></label>`}
    </div>
    ${simple ? html`<input type="hidden" name="tiss_version" value="${i.tiss_version || '4.03.00'}"><input type="hidden" name="guide_mode" value="${i.guide_mode || 'sessao'}">` : html`<h2>Faturamento (TISS)</h2>
    <div class="form-grid">
      <label class="fld"><span>Versão do padrão TISS</span><select name="tiss_version">${Ins.TISS_VERSIONS.map((v) => html`<option value="${v}" ${sel(i.tiss_version || '4.03.00', v)}>${v}</option>`)}</select></label>
      <label class="fld"><span>Guias no lote</span><select name="guide_mode"><option value="sessao" ${sel(i.guide_mode, 'sessao')}>Uma guia por sessão</option><option value="autorizacao" ${sel(i.guide_mode, 'autorizacao')}>Uma guia por autorização (sessões como itens)</option></select></label>
    </div>`}
    <label class="fld"><span>Observações</span><textarea name="notes" rows="2" maxlength="1000">${i.notes || ''}</textarea></label>
    <div class="actions"><button class="btn">Salvar</button><a class="btn ghost" href="/configuracoes/convenios">Voltar</a></div>
  </form>
  ${i.id ? html`<section class="card" id="tabela"><h2>Tabela de procedimentos</h2>
    <p class="muted small sub-h">Os valores do contrato. O procedimento padrão é usado nas sessões (a autorização pode indicar outro).</p>
    ${ps.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Código TUSS</th><th>Procedimento</th><th class="num">Valor</th><th></th></tr></thead><tbody>
      ${ps.map((x) => html`<tr><td>${x.tuss_code || '—'}</td><td>${x.description}${x.is_default ? html` <span class="badge b-realizada">padrão</span>` : ''}</td><td class="num">${money(x.value)}</td>
        <td class="nf-acts">${x.is_default ? '' : html`<form method="post" action="/configuracoes/convenios/${i.id}/procedimento/${x.id}/padrao" class="inline"><button class="btn ghost btn-sm">Tornar padrão</button></form>`}
          <form method="post" action="/configuracoes/convenios/${i.id}/procedimento/${x.id}/remover" class="inline" data-confirm="Remover este procedimento da tabela?"><button class="btn ghost btn-sm">Remover</button></form></td></tr>`)}</tbody></table></div>`
      : html`<p class="flash warn">Sem tabela: as sessões deste convênio ainda não geram valor a receber.</p>`}
    <form method="post" action="/configuracoes/convenios/${i.id}/procedimento" class="form-grid">
      <label class="fld"><span>Código TUSS <small class="muted">(${simple ? 'opcional' : 'do contrato'})</small></span><input name="tuss_code" maxlength="20" inputmode="numeric"></label>
      <label class="fld"><span>Procedimento</span><input name="description" maxlength="160" value="${ps.length ? '' : 'Sessão de psicoterapia individual'}" required></label>
      <label class="fld"><span>Valor (R$)</span><input name="value" inputmode="decimal" required></label>
      <label class="fld check"><input type="checkbox" name="is_default" value="1" ${ps.length ? '' : raw('checked')}><span>Procedimento padrão</span></label>
      <div class="span2 actions"><button class="btn ghost">Adicionar à tabela</button></div>
    </form></section>` : ''}`;
}
settings.get('/novo', async (req, res) => send(res, page(req, { title: 'Novo convênio', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Convênios</p><h1>Novo convênio</h1></div></header>${insForm({ active: 1 }, [], (await Ins.mode()) === 'simples')}` })));
settings.post('/novo', async (req, res) => {
  const r = await Ins.save(null, req.body);
  if (!r.ok) return res.flash(r.error, 'err').redirect('/configuracoes/convenios/novo');
  await audit(req, 'convenio-criar', `insurer:${r.id}`);
  res.flash('Convênio criado. Cadastre a tabela de valores.').redirect(`/configuracoes/convenios/${r.id}#tabela`);
});
settings.get('/:id', async (req, res, next) => {
  const i = await Ins.get(int(req.params.id)); if (!i) return next();
  send(res, page(req, { title: i.name, active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Convênios</p><h1>${i.name}</h1></div></header>${await (async () => { const simple = (await Ins.mode()) === 'simples'; return html`${insForm(i, await Ins.procs(i.id), simple)}${simple ? '' : await wsCard(i)}`; })()}` }));
});
settings.post('/:id', async (req, res, next) => {
  const i = await Ins.get(int(req.params.id)); if (!i) return next();
  const r = await Ins.save(i.id, req.body);
  if (!r.ok) return res.flash(r.error, 'err').redirect(`/configuracoes/convenios/${i.id}`);
  await audit(req, 'convenio-editar', `insurer:${i.id}`);
  res.flash('Convênio salvo.').redirect(`/configuracoes/convenios/${i.id}`);
});
settings.post('/:id/procedimento', async (req, res) => {
  const id = int(req.params.id); const r = await Ins.addProc(id, req.body);
  res.flash(r.ok ? 'Procedimento adicionado.' : r.error, r.ok ? 'ok' : 'err').redirect(`/configuracoes/convenios/${id}#tabela`);
});
settings.post('/:id/procedimento/:pid/padrao', async (req, res) => { const id = int(req.params.id); await Ins.setDefaultProc(id, int(req.params.pid)); res.redirect(`/configuracoes/convenios/${id}#tabela`); });
settings.post('/:id/procedimento/:pid/remover', async (req, res) => { const id = int(req.params.id); await Ins.removeProc(id, int(req.params.pid)); res.flash('Procedimento removido.').redirect(`/configuracoes/convenios/${id}#tabela`); });

// ---------- Ficha do paciente → aba Convênio ----------
export async function patientTab(req, p) {
  const [plans, auths, active, alerts] = await Promise.all([Ins.plansOf(p.id), Ins.authsOf(p.id), Ins.list(true), Ins.alertsFor(p.id)]);
  const B = `/convenios/paciente/${p.id}`;
  const procsBy = {}; for (const i of active) procsBy[i.id] = await Ins.procs(i.id);
  const current = plans.filter((x) => x.active);
  const wb = (await Ins.mode()) === 'simples' ? { elig: {}, reqs: [], auth: {} } : await wsPatientBits(p, plans);
  return html`${alerts.map((t) => html`<div class="flash warn">${t}</div>`)}
    ${!active.length ? html`<div class="flash info">Nenhum convênio credenciado ainda. ${can(req.user, 'usuarios') ? html`<a href="/configuracoes/convenios">Ligar os convênios em Configurações → Convênios</a>.` : 'Peça à administração para ligar em Configurações → Convênios.'}</div>` : ''}
    <section class="card" id="carteirinhas"><h2>Carteirinhas</h2>
      ${plans.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Convênio</th><th>Carteirinha</th><th>Plano / titular</th><th>Validade</th><th>Nas sessões</th></tr></thead><tbody>
        ${plans.map((x) => html`<tr data-plan="${x.id}" class="${x.active ? '' : 'muted'}"><td><b>${x.insurer}</b>${x.active ? '' : html` <small>(inativa)</small>`}</td><td class="mono">${Ins.maskCard(x.card)}</td>
          <td>${x.plan_name || '—'}${x.holder_name ? html`<small class="muted block">titular: ${x.holder_name}</small>` : ''}</td>
          <td>${x.valid_until ? html`<span class="${x.expired ? 'err-txt' : ''}">${brDate(x.valid_until)}${x.expired ? ' (vencida)' : ''}</span>` : '—'}</td>
          <td>${p.default_plan_id === x.id ? html`<span class="badge b-realizada">padrão</span>` : x.active ? html`<form method="post" action="${B}/padrao" class="inline"><input type="hidden" name="plan_id" value="${x.id}"><button class="btn ghost btn-sm">Usar por padrão</button></form>` : ''}
            ${x.active && wb.elig[x.id] ? html`<form method="post" action="${B}/elegibilidade" class="inline"><input type="hidden" name="plan_id" value="${x.id}"><button class="btn ghost btn-sm">Verificar na operadora</button></form>` : ''}
            ${x.elig_at ? html`<small class="block ${x.elig_ok === 1 ? 'ok-txt' : 'err-txt'}" data-elig>${x.elig_ok === 1 ? '✓ ativa' : x.elig_ok === 0 ? '✗ negada' : '! sem resposta'} em ${brDate(x.elig_at)}${x.elig_ok === 1 ? '' : html`: ${x.elig_msg}`}</small>` : ''}</td></tr>`)}
      </tbody></table></div>
      ${p.default_plan_id ? html`<form method="post" action="${B}/padrao" class="inline"><input type="hidden" name="plan_id" value=""><button class="btn ghost btn-sm">Novas sessões como particular</button></form>` : ''}` : html`<p class="muted">Nenhuma carteirinha cadastrada: as sessões são particulares.</p>`}
      ${active.length ? html`<details class="ins-add"><summary class="btn ghost btn-sm">+ Adicionar carteirinha</summary>
        <form method="post" action="${B}/carteirinha" class="form-grid">
          <label class="fld"><span>Convênio</span><select name="insurer_id" required>${active.map((i) => html`<option value="${i.id}">${i.name}</option>`)}</select></label>
          <label class="fld"><span>Número da carteirinha</span><input name="card" maxlength="40" required autocomplete="off"></label>
          <label class="fld"><span>Plano</span><input name="plan_name" maxlength="80" placeholder="Ex.: Nacional, Enfermaria"></label>
          <label class="fld"><span>Titular <small class="muted">(se não for o paciente)</small></span><input name="holder_name" maxlength="160"></label>
          <label class="fld"><span>Validade</span><input type="date" name="valid_until"></label>
          <label class="fld check"><input type="checkbox" name="default" value="1" checked><span>Usar nas novas sessões</span></label>
          <div class="span2 actions"><button class="btn">Salvar carteirinha</button></div>
        </form></details>` : ''}
    </section>
    <section class="card" id="autorizacoes"><h2>Autorizações</h2>
      ${auths.length ? html`<div class="ins-auths">${auths.map((a) => html`<article class="ins-auth ${a.current ? 'on' : ''}" data-auth="${a.id}">
        <header><b>${a.insurer}</b>${a.password ? html` · senha <span class="mono">${a.password}</span>` : ''}<span class="badge ${a.status === 'cancelada' ? 'b-cancelada' : a.current ? 'b-realizada' : 'b-falta'}">${a.status === 'cancelada' ? 'Cancelada' : a.current ? 'Válida' : a.expired ? 'Vencida' : 'Esgotada'}</span></header>
        <div class="ins-bar" role="progressbar" aria-valuemin="0" aria-valuemax="${a.sessions_total}" aria-valuenow="${a.used}" aria-label="Sessões usadas"><i style="width:${Math.min(100, (a.used / a.sessions_total) * 100)}%"></i></div>
        <p class="small"><b>${a.used} de ${a.sessions_total}</b> sessões usadas · restam <b>${a.left}</b> · de ${brDate(a.valid_from)} a ${brDate(a.valid_until)}${a.proc ? ` · ${a.proc}` : ''}</p>
        <div class="actions"><a class="btn ghost btn-sm" href="/convenios/autorizacao/${a.id}/folha">Folha de assinaturas (PDF)</a>
          ${a.status === 'ativa' ? html`<form method="post" action="${B}/autorizacao/${a.id}/cancelar" class="inline" data-confirm="Cancelar esta autorização? As sessões ligadas a ela passam para outra autorização válida, se houver."><button class="btn ghost btn-sm">Cancelar</button></form>` : ''}</div>
      </article>`)}</div>` : html`<p class="muted">Nenhuma autorização registrada.</p>`}
      ${wb.reqs.length ? html`<h3 class="small">Pedidos à operadora</h3><ul class="list" id="pedidos">${wb.reqs.map((r) => html`<li data-req="${r.id}"><b>${r.insurer}</b> · ${r.sessions} sessão(ões) · guia ${r.guide_number} · <span class="badge ${r.status === 'autorizado' ? 'b-realizada' : r.status === 'negado' || r.status === 'erro' ? 'b-cancelada' : 'b-aguardando'}">${{ enviado: 'Enviado', analise: 'Em análise', autorizado: 'Autorizado', negado: 'Negado', erro: 'Erro no envio' }[r.status]}</span> <small class="muted">${brDate(r.created_at)}</small>${r.message ? html`<small class="muted block">${r.message}</small>` : ''}
        ${['enviado', 'analise'].includes(r.status) ? html`<form method="post" action="${B}/pedido/${r.id}/situacao" class="inline"><button class="btn ghost btn-sm">Consultar situação</button></form>` : ''}</li>`)}</ul>` : ''}
      ${current.some((x) => wb.auth[x.id]) ? html`<details class="ins-add" id="pedir"><summary class="btn btn-sm">Pedir autorização à operadora</summary>
        <form method="post" action="${B}/pedir-autorizacao" class="form-grid">
          <label class="fld"><span>Carteirinha</span><select name="plan_id" required>${current.filter((x) => wb.auth[x.id]).map((x) => html`<option value="${x.id}">${x.insurer} · ${Ins.maskCard(x.card)}</option>`)}</select></label>
          <label class="fld"><span>Sessões</span><input type="number" name="sessions" min="1" max="999" value="${active.find((i) => i.id === current.find((x) => wb.auth[x.id])?.insurer_id)?.sessions_per_auth || 10}"></label>
          <label class="fld"><span>Procedimento</span><select name="proc_id"><option value="">Padrão do convênio</option>${current.filter((x) => wb.auth[x.id]).flatMap((x) => (procsBy[x.insurer_id] || []).map((pr) => html`<option value="${pr.id}">${x.insurer} · ${pr.description}</option>`))}</select></label>
          <label class="fld span2"><span>Indicação clínica <small class="muted">(opcional; só o necessário para a operadora)</small></span><input name="indication" maxlength="500"></label>
          <div class="span2 actions"><button class="btn">Enviar pedido</button></div>
        </form></details>` : ''}
      ${current.length ? html`<details class="ins-add" ${auths.some((a) => a.current) ? '' : raw('open')}><summary class="btn ghost btn-sm">+ Registrar autorização</summary>
        <form method="post" action="${B}/autorizacao" class="form-grid" data-ins-auth>
          <label class="fld"><span>Carteirinha</span><select name="plan_id" required>${current.map((x) => html`<option value="${x.id}" data-ins="${x.insurer_id}">${x.insurer} · ${Ins.maskCard(x.card)}</option>`)}</select></label>
          <label class="fld"><span>Senha da autorização</span><input name="password" maxlength="40" autocomplete="off"></label>
          <label class="fld"><span>Sessões autorizadas</span><input type="number" name="sessions_total" min="1" max="500" value="${active.find((i) => i.id === current[0].insurer_id)?.sessions_per_auth || 10}"></label>
          <label class="fld"><span>Procedimento</span><select name="proc_id"><option value="">Padrão do convênio</option>${current.flatMap((x) => (procsBy[x.insurer_id] || []).map((pr) => html`<option value="${pr.id}">${x.insurer} · ${pr.description} (${money(pr.value)})</option>`))}</select></label>
          <label class="fld"><span>Válida de</span><input type="date" name="valid_from" value="${todayLocal()}"></label>
          <label class="fld"><span>Até <small class="muted">(vazio: prazo do convênio)</small></span><input type="date" name="valid_until"></label>
          <label class="fld span2"><span>Observações</span><input name="notes" maxlength="300"></label>
          <div class="span2 actions"><button class="btn">Salvar autorização</button></div>
        </form></details>` : ''}
    </section>`;
}
export const patients = router();
async function patientOf(req) { const p = await one('SELECT id, owner_id FROM patients WHERE id = ?', [int(req.params.pid)]); if (!p) return null; if (!canSeePatient(req.user, p)) throw forbidden(); return p; }
const back = (p) => `/pacientes/${p.id}?aba=convenio`;
patients.post('/paciente/:pid/carteirinha', async (req, res, next) => {
  const p = await patientOf(req); if (!p) return next();
  const r = await Ins.savePlan(p.id, null, req.body);
  await audit(req, 'convenio-carteirinha', `patient:${p.id}`);
  res.flash(r.ok ? 'Carteirinha salva.' : r.error, r.ok ? 'ok' : 'err').redirect(`${back(p)}#carteirinhas`);
});
patients.post('/paciente/:pid/padrao', async (req, res, next) => {
  const p = await patientOf(req); if (!p) return next();
  const pl = int(req.body.plan_id) ? await one('SELECT id FROM patient_plans WHERE id = ? AND patient_id = ? AND active = 1', [int(req.body.plan_id), p.id]) : null;
  await Ins.setDefault(p.id, pl?.id || null);
  res.flash(pl ? 'Novas sessões pelo convênio.' : 'Novas sessões como particular.').redirect(`${back(p)}#carteirinhas`);
});
patients.post('/paciente/:pid/autorizacao', async (req, res, next) => {
  const p = await patientOf(req); if (!p) return next();
  const r = await Ins.saveAuth(p.id, req.body, req.user.id);
  await audit(req, 'convenio-autorizacao', `patient:${p.id}`);
  res.flash(r.ok ? 'Autorização registrada.' : r.error, r.ok ? 'ok' : 'err').redirect(`${back(p)}#autorizacoes`);
});
patients.post('/paciente/:pid/autorizacao/:id/cancelar', async (req, res, next) => {
  const p = await patientOf(req); if (!p) return next();
  await Ins.cancelAuth(p.id, int(req.params.id));
  await audit(req, 'convenio-autorizacao-cancelar', `auth:${req.params.id}`);
  res.flash('Autorização cancelada.').redirect(`${back(p)}#autorizacoes`);
});
// Assinatura / token da guia na sessão
patients.post('/sessao/:id/guia', async (req, res, next) => {
  const a = await one('SELECT a.id, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?', [int(req.params.id)]);
  if (!a) return next(); if (!canSeePatient(req.user, a)) throw forbidden();
  const tok = String(req.body.token || '').trim().slice(0, 40) || null;
  await q('UPDATE appointments SET guide_signed_at = IF(?, COALESCE(guide_signed_at, NOW()), NULL), guide_token = COALESCE(?, guide_token) WHERE id = ?', [req.body.signed ? 1 : 0, tok, a.id]);
  await audit(req, 'convenio-guia', `appointment:${a.id}`);
  res.flash('Guia da sessão atualizada.').redirect(`/agenda/${a.id}#convenio`);
});

// Quadro do convênio na página da sessão
export async function apptCard(req, a) {
  if (!a.plan_id) return '';
  const st = await Ins.statusFor(a); if (!st) return '';
  return html`<section class="card ins-card" id="convenio"><h2>Convênio · ${st.plan.insurer}</h2>
    <p>Carteirinha <span class="mono">${Ins.maskCard(st.plan.card)}</span>${st.auth ? html` · autorização ${st.auth.password ? html`<span class="mono">${st.auth.password}</span>` : ''} · <b>${st.auth.used} de ${st.auth.sessions_total}</b> sessões usadas (válida até ${brDate(st.auth.valid_until)})` : ''}</p>
    ${st.warn.length ? html`<div class="flash warn small">${st.warn.join(' · ')}.</div>` : ''}
    ${st.needSignature || st.needToken ? html`<form method="post" action="/convenios/sessao/${a.id}/guia" class="inline-form">
      ${st.needSignature ? html`<label class="fld check"><input type="checkbox" name="signed" value="1" ${ck(a.guide_signed_at)}><span>Paciente assinou a guia${a.guide_signed_at ? ` (${brDate(a.guide_signed_at)})` : ''}</span></label>` : html`<input type="hidden" name="signed" value="${a.guide_signed_at ? 1 : ''}">`}
      ${st.needToken ? html`<label class="fld"><span>Token do paciente</span><input name="token" maxlength="40" value="${a.guide_token || ''}" autocomplete="off"></label>` : ''}
      <button class="btn ghost btn-sm">Salvar</button></form>` : ''}
    <p class="small"><a class="link" href="/pacientes/${a.patient_id}?aba=convenio">Carteirinhas e autorizações do paciente</a></p></section>`;
}

// ---------- Folha de assinaturas da autorização (PDF) ----------
export const sheets = router();
sheets.get('/autorizacao/:id/folha', async (req, res, next) => {
  const s = await Ins.sheet(int(req.params.id)); if (!s) return next();
  if (!canSeePatient(req.user, { owner_id: (await one('SELECT owner_id FROM patients WHERE id = ?', [s.patient_id]))?.owner_id })) throw forbidden();
  const pdf = await PDFDocument.create(); const reg = await pdf.embedFont(StandardFonts.Helvetica); const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const clean = (t) => { let o = ''; for (const ch of String(t || '')) { try { reg.encodeText(ch); o += ch; } catch { o += '?'; } } return o; };
  const W = 595.28; const H = 841.89; const M = 48; const ink = rgb(0.15, 0.12, 0.1);
  let pg = pdf.addPage([W, H]); let y = H - M;
  const text = (t, x, yy, size = 10, f = reg) => pg.drawText(clean(t), { x, y: yy, size, font: f, color: ink });
  text(`${s.insurer} · Folha de assinaturas das sessões`, M, y, 14, bold); y -= 22;
  const rows = [[`Paciente: ${s.social_name || s.patient}`, `Carteirinha: ${s.card}`], [`Titular: ${s.holder_name || s.social_name || s.patient}`, `Plano: ${s.plan_name || '-'}`],
    [`Autorização (senha): ${s.password || '-'}`, `Validade: ${brDate(s.valid_from)} a ${brDate(s.valid_until)}`], [`Procedimento: ${s.tuss_code ? `${s.tuss_code} - ` : ''}${s.proc || 'Sessão de psicoterapia'}`, `Sessões autorizadas: ${s.sessions_total}`],
    [`Profissional: ${s.pro ? proName({ name: s.pro, title: s.pro_title }) : '-'}${s.crp ? ` · CRP ${s.crp}` : ''}`, `${s.provider_code ? `Código do prestador: ${s.provider_code}` : ''}`]];
  for (const [l, r] of rows) { text(l, M, y); text(r, W / 2 + 10, y); y -= 15; }
  y -= 10;
  const cols = [M, M + 40, M + 140, W - M - 200];
  text('Nº', cols[0], y, 9, bold); text('Data', cols[1], y, 9, bold); text('Token', cols[2], y, 9, bold); text('Assinatura do paciente ou responsável', cols[3], y, 9, bold); y -= 8;
  pg.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.6, color: ink });
  for (let n = 1; n <= s.sessions_total; n++) {
    if (y < M + 60) { pg = pdf.addPage([W, H]); y = H - M; }
    const ses = s.sessions[n - 1];
    y -= 26;
    text(String(n), cols[0], y); text(ses ? brDate(ses.starts_at) : '____/____/______', cols[1], y); text(ses?.guide_token || '', cols[2], y);
    pg.drawLine({ start: { x: cols[3], y: y - 2 }, end: { x: W - M, y: y - 2 }, thickness: 0.4, color: rgb(0.5, 0.5, 0.5) });
  }
  y -= 40; if (y < M + 40) { pg = pdf.addPage([W, H]); y = H - M; }
  text('Declaro que compareci às sessões acima, nas datas indicadas.', M, y, 9);
  const bytes = Buffer.from(await pdf.save());
  await audit(req, 'convenio-folha', `auth:${s.id}`);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="folha-sessoes-${s.id}.pdf"`, 'Cache-Control': 'no-store' });
  res.send(bytes);
});

// ---------- Financeiro → Convênios: faturamento em lote (TISS) ----------
export const billing = router();
const badgeOf = (s) => ({ enviado: 'b-confirmada', analisado: 'b-aguardando', pago: 'b-realizada', cancelado: 'b-cancelada' }[s] || 'b-agendada');
const APPEAL = { rascunho: 'Pronto para enviar', enviado: 'Enviado (aguardando resposta)', respondido: 'Respondido' };
const glosaOpts = () => html`<datalist id="glosa-codes">${Object.entries(GLOSAS).map(([k, v]) => html`<option value="${k}">${k} · ${v}</option>`)}</datalist>`;
const convNav = (cur) => html`<nav class="chips conv-nav" aria-label="Convênios">${[['', 'Faturamento'], ['glosas', 'Glosas'], ['demonstrativos', 'Demonstrativos']].map(([k, l]) => html`<a href="/financeiro/convenios${k ? `/${k}` : ''}" class="chip ${cur === k ? 'on' : ''}" ${cur === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
const demoUpload = () => html`<section class="card"><h2>Retorno da operadora</h2>
  <p class="muted small">Se o portal oferece o <b>demonstrativo de análise de conta</b> ou o <b>demonstrativo de pagamento</b> em XML (padrão TISS), envie aqui: o sistema lança o que foi liberado e glosado em cada sessão e, no de pagamento, dá baixa nos recebimentos. Sem o XML, lance a análise à mão na página do lote.</p>
  <label class="btn ghost file-btn"><input type="file" accept=".xml,text/xml,application/xml" data-upload="/financeiro/convenios/demonstrativo" hidden>⬆ Enviar demonstrativo (XML)</label>
  <p class="muted small" data-upload-msg></p></section>`;

// ---------- Convênio simples: o que cada convênio deve no mês e a baixa do recebimento (sem TISS) ----------
async function simpleMonth(insurerId, ym) {
  return q(`SELECT x.id, x.amount, x.paid_at, a.id appt_id, a.starts_at, a.status, p.name, p.social_name, au.password
    FROM payments x JOIN appointments a ON a.id = x.appointment_id JOIN patients p ON p.id = x.patient_id LEFT JOIN insurer_auths au ON au.id = a.auth_id
    WHERE x.origin = 'convenio' AND x.insurer_id = ? AND DATE_FORMAT(a.starts_at, '%Y-%m') = ? AND a.status <> 'cancelada' ORDER BY a.starts_at`, [insurerId, ym]);
}
async function simpleBilling(req, res, ym) {
  const ins = await Ins.list(true);
  const cards = [];
  for (const i of ins) cards.push({ i, rows: await simpleMonth(i.id, ym) });
  const tot = (xs) => xs.reduce((a, x) => a + Number(x.amount || 0), 0);
  const nm = (x) => x.social_name || x.name;
  send(res, page(req, { title: 'Financeiro · Convênios', active: 'financeiro', body: html`<header class="ph"><div><p class="eyebrow">Financeiro · ${monthName(ym)}</p><h1>Convênios</h1>
      <p class="muted">As sessões por convênio no mês e quanto cada operadora deve à clínica. Envie a relação de atendimentos no portal ou no formato que a operadora pedir e, quando o pagamento cair, dê baixa aqui.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="?mes=${addMonths(ym, -1)}">←</a><a class="btn ghost" href="?mes=${addMonths(ym, 1)}">→</a><button class="btn ghost" data-print>Imprimir</button><a class="btn ghost" href="/configuracoes/convenios">Configurar</a></div></header>
    ${finTabs(req, 'convenios', { key: 'clinica' })}
    ${!ins.length ? html`<div class="flash info">Nenhum convênio credenciado. Ligue em <a href="/configuracoes/convenios">Configurações → Convênios</a>.</div>` : ''}
    ${cards.map(({ i, rows }) => { const open = rows.filter((x) => !x.paid_at); const paid = rows.filter((x) => x.paid_at); return html`<section class="card ins-simple" data-ins="${i.id}">
      <header class="row-head"><h2>${i.name}</h2><span class="muted small">${rows.length} sessão(ões) · ${money(tot(rows))}</span></header>
      <div class="tiss-nums"><div><b>${money(tot(open))}</b><small>a receber · ${open.length} sessão(ões)</small></div><div><b>${money(tot(paid))}</b><small>recebido · ${paid.length}</small></div></div>
      ${rows.length ? html`<form method="post" action="/financeiro/convenios/receber">
        <input type="hidden" name="mes" value="${ym}">
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th class="no-print"></th><th>Data</th><th>Paciente</th><th>Senha</th><th class="num">Valor</th><th>Situação</th></tr></thead><tbody>
          ${rows.map((x) => html`<tr><td class="no-print">${x.paid_at ? '' : html`<input type="checkbox" name="ids" value="${x.id}" checked aria-label="Selecionar">`}</td><td><a href="/agenda/${x.appt_id}">${brDate(x.starts_at)} ${String(x.starts_at).slice(11, 16)}</a></td><td>${nm(x)}</td><td class="mono">${x.password || '—'}</td><td class="num">${money(x.amount)}</td>
            <td>${x.paid_at ? html`<span class="badge b-realizada">recebido em ${brDate(x.paid_at)}</span>` : x.status === 'realizada' ? html`<span class="badge b-aguardando">a receber</span>` : html`<span class="badge b-agendada">${x.status}</span>`}</td></tr>`)}
        </tbody><tfoot><tr><th class="no-print"></th><th colspan="3">Total</th><th class="num">${money(tot(rows))}</th><th></th></tr></tfoot></table></div>
        ${open.length ? html`<div class="actions no-print"><label class="fld inline"><span>Recebido em</span><input type="date" name="data" value="${todayLocal()}" required></label><button class="btn">Dar baixa nas selecionadas</button></div>` : ''}
      </form>` : html`<p class="muted small">Nenhuma sessão por este convênio no mês.</p>`}
      ${paid.length ? html`<form method="post" action="/financeiro/convenios/desfazer-recebimento" class="no-print" data-confirm="Desfazer a baixa de ${paid.length} sessão(ões) de ${i.name} neste mês?"><input type="hidden" name="mes" value="${ym}"><input type="hidden" name="insurer_id" value="${i.id}"><button class="btn ghost btn-sm">Desfazer baixas do mês</button></form>` : ''}
    </section>`; })}` }));
}
billing.post('/receber', async (req, res) => {
  const ym = isYm(req.body.mes) ? req.body.mes : todayLocal().slice(0, 7);
  const ids = [].concat(req.body.ids || []).map(int).filter((n) => n > 0);
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.data || '')) ? req.body.data : todayLocal();
  if (!ids.length) return res.flash('Selecione as sessões recebidas.', 'err').redirect(`/financeiro/convenios?mes=${ym}`);
  const r = await q(`UPDATE payments SET paid_at = ?, method = COALESCE(method, 'transferencia') WHERE id IN (${ids.map(() => '?').join(',')}) AND origin = 'convenio' AND paid_at IS NULL`, [`${day} 12:00:00`, ...ids]);
  await audit(req, 'convenio-simples-receber', ids.join(','));
  res.flash(`Baixa feita em ${r.affectedRows} sessão(ões).`).redirect(`/financeiro/convenios?mes=${ym}`);
});
billing.post('/desfazer-recebimento', async (req, res) => {
  const ym = isYm(req.body.mes) ? req.body.mes : todayLocal().slice(0, 7);
  const r = await q(`UPDATE payments x JOIN appointments a ON a.id = x.appointment_id SET x.paid_at = NULL WHERE x.origin = 'convenio' AND x.insurer_id = ? AND DATE_FORMAT(a.starts_at, '%Y-%m') = ? AND x.paid_at IS NOT NULL`, [int(req.body.insurer_id), ym]);
  await audit(req, 'convenio-simples-desfazer', `insurer:${int(req.body.insurer_id)}:${ym}`);
  res.flash(`Baixa desfeita em ${r.affectedRows} sessão(ões).`).redirect(`/financeiro/convenios?mes=${ym}`);
});

billing.get('/', async (req, res) => {
  const ym = isYm(req.query.mes) ? req.query.mes : addMonths(todayLocal().slice(0, 7), -1);
  if ((await Ins.mode()) === 'simples') return simpleBilling(req, res, ym);
  const ins = await Ins.list(true);
  const cards = [];
  for (const i of ins) {
    const ss = await T.sessions(i.id, ym);
    if (!ss.length && !req.query.todos) { cards.push({ i, ss, ready: [], pend: [], billed: [] }); continue; }
    cards.push({ i, ss, ready: ss.filter((s) => s.ok), pend: ss.filter((s) => !s.ok && !s.batch_id), billed: ss.filter((s) => s.batch_id) });
  }
  const list = await T.batches({ competence: ym });
  const sum = (xs) => xs.reduce((a, s) => a + Number(s.proc?.value || 0), 0);
  send(res, page(req, { title: 'Financeiro · Convênios', active: 'financeiro', body: html`<header class="ph"><div><p class="eyebrow">Financeiro · competência ${monthName(ym)}</p><h1>Faturamento dos convênios</h1>
      <p class="muted">As sessões realizadas no mês, por convênio. As que estão completas entram no lote (XML no padrão TISS) para enviar no portal da operadora; as pendentes mostram o que falta.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="?mes=${addMonths(ym, -1)}">←</a><a class="btn ghost" href="?mes=${addMonths(ym, 1)}">→</a><a class="btn ghost" href="/relatorios?aba=convenios">Relatórios</a><a class="btn ghost" href="/configuracoes/convenios">Configurar</a></div></header>
    ${finTabs(req, 'convenios', { key: 'clinica' })}${convNav('')}
    ${!ins.length ? html`<div class="flash info">Nenhum convênio credenciado. Ligue em <a href="/configuracoes/convenios">Configurações → Convênios</a>.</div>` : ''}
    <div class="tiss-cards">${cards.map(({ i, ss, ready, pend, billed }) => { const dl = T.deadline(i, ym); return html`<section class="card tiss-card" data-ins="${i.id}"><header><h2>${i.name}</h2>${dl ? html`<small class="muted">envio até ${brDate(dl)}</small>` : ''}</header>
      <div class="tiss-nums"><div><b>${ready.length}</b><small>prontas · ${money(sum(ready))}</small></div><div><b class="${pend.length ? 'err-txt' : ''}">${pend.length}</b><small>com pendência</small></div><div><b>${billed.length}</b><small>já em lote</small></div></div>
      ${ready.length ? html`<form method="post" action="/financeiro/convenios/lote" data-confirm="Gerar o lote de ${i.name} com ${ready.length} sessão(ões)?"><input type="hidden" name="insurer_id" value="${i.id}"><input type="hidden" name="mes" value="${ym}"><button class="btn">Gerar lote (XML TISS)</button></form>` : ss.length ? '' : html`<p class="muted small">Nenhuma sessão realizada por este convênio no mês.</p>`}
      ${pend.length ? html`<details class="tiss-pend" open><summary class="small"><b>O que falta</b></summary><ul class="plain small">${pend.map((s) => html`<li><a href="/agenda/${s.id}">${brDate(s.date)} · ${s.social_name || s.name}</a>: <span class="err-txt">${s.miss.join(', ')}</span></li>`)}</ul></details>` : ''}
    </section>`; })}</div>
    <section class="card flush" id="lotes"><h2 class="pad">Lotes de ${monthName(ym)}</h2>
      ${list.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Lote</th><th>Convênio</th><th class="num">Guias</th><th class="num">Valor</th><th class="num">Glosa</th><th>Situação</th><th></th></tr></thead><tbody>
        ${list.map((b) => html`<tr data-lote="${b.id}"><td><a href="/financeiro/convenios/lote/${b.id}">nº ${b.lot_number}</a><small class="muted block">${brDate(b.created_at)}${b.pro ? ` · ${b.pro}` : ''}</small></td><td>${b.insurer}</td><td class="num">${b.guides}</td><td class="num">${money(b.total)}</td><td class="num">${Number(b.glosa) > 0 ? html`<span class="err-txt">${money(b.glosa)}</span>` : b.glosa !== null ? '—' : ''}</td>
          <td><span class="badge ${badgeOf(b.status)}">${T.STATUS[b.status]}</span>${b.paid_at ? html`<small class="muted block">pago em ${brDate(b.paid_at)} · ${money(b.paid_net)}</small>` : ''}${b.protocol ? html`<small class="muted block">protocolo ${b.protocol}</small>` : ''}</td>
          <td class="nf-acts">${b.status !== 'cancelado' ? html`<a class="btn ghost btn-sm" href="/financeiro/convenios/lote/${b.id}/xml">Baixar XML</a>` : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted pad">Nenhum lote neste mês.</p>`}
    </section>
    ${demoUpload()}` }));
});
billing.post('/lote', async (req, res) => {
  const ym = isYm(req.body.mes) ? req.body.mes : todayLocal().slice(0, 7);
  const r = await T.generate(int(req.body.insurer_id), ym, req.user.id);
  await audit(req, 'convenio-lote-gerar', r.ok ? r.batches.map((b) => b.id).join(',') : 'erro');
  res.flash(r.ok ? `${r.batches.length > 1 ? `${r.batches.length} lotes gerados` : `Lote nº ${r.batches[0].lotNumber} gerado`}: ${r.batches.reduce((a, b) => a + b.guides, 0)} guia(s), ${money(r.batches.reduce((a, b) => a + b.total, 0))}. Baixe o XML e envie no portal da operadora.` : r.error, r.ok ? 'ok' : 'err')
    .redirect(r.ok && r.batches.length === 1 ? `/financeiro/convenios/lote/${r.batches[0].id}` : `/financeiro/convenios?mes=${ym}#lotes`);
});
billing.get('/lote/:id', async (req, res, next) => {
  const b = await T.batch(int(req.params.id)); if (!b) return next();
  const items = await Ret.items(b.id);
  const ins = await one('SELECT appeal_days FROM insurers WHERE id = ?', [b.insurer_id]);
  const aps = await Ret.appealsOf(b.id);
  const dl = Ret.appealDeadline(b, ins);
  const editable = ['enviado', 'analisado'].includes(b.status);
  const glosed = items.filter((x) => Number(x.glosa) > 0);
  const canAppeal = ['analisado', 'pago'].includes(b.status) && glosed.some((x) => !x.appeal_id);
  const sumExp = items.reduce((a, x) => a + Number(x.expected), 0);
  const wc = await WS.config(b.insurer_id); const we = (k) => WS.enabled(wc, k);
  const wsBox = b.status !== 'cancelado' && (we('lote') || we('statusProtocolo') || we('demonstrativo')) ? html`<section class="card" id="ws"><h2>Webservice da operadora</h2>
      ${b.op_status ? html`<p>Situação na operadora: <b>${WS.PROTOCOL_STATUS[b.op_status] || b.op_status}</b> <small class="muted">(consultado em ${brDate(b.op_status_at)})</small></p>` : ''}
      <div class="actions">${b.status === 'gerado' && we('lote') ? html`<form method="post" action="/financeiro/convenios/lote/${b.id}/ws/enviar" data-confirm="Enviar este lote para a operadora agora?"><button class="btn">Enviar pelo webservice</button></form>` : ''}
        ${b.protocol && b.status !== 'gerado' && we('statusProtocolo') ? html`<form method="post" action="/financeiro/convenios/lote/${b.id}/ws/situacao"><button class="btn ghost">Consultar situação</button></form>` : ''}
        ${b.protocol && ['enviado', 'analisado'].includes(b.status) && we('demonstrativo') ? html`<form method="post" action="/financeiro/convenios/lote/${b.id}/ws/demonstrativo"><button class="btn ghost">Buscar demonstrativo de análise</button></form>` : ''}</div></section>` : '';
  send(res, page(req, { title: `Lote ${b.lot_number}`, active: 'financeiro', body: html`<header class="ph"><div><p class="eyebrow">Faturamento · ${b.insurer} · competência ${monthName(b.competence)}</p><h1>Lote nº ${b.lot_number} <span class="badge ${badgeOf(b.status)}">${T.STATUS[b.status]}</span></h1>
      <p class="muted">${b.guides} guia(s) · ${money(b.total)} · gerado em ${brDate(b.created_at)}${b.sent_at ? ` · enviado em ${brDate(b.sent_at)}` : ''}${b.protocol ? ` · protocolo ${b.protocol}` : ''}</p></div>
      <div class="ph-actions">${b.status !== 'cancelado' ? html`<a class="btn ghost" href="/financeiro/convenios/lote/${b.id}/xml">Baixar XML (TISS)</a>` : ''}${b.portal_url ? html`<a class="btn ghost" href="${b.portal_url}" target="_blank" rel="noopener">Portal da operadora</a>` : ''}<a class="btn ghost" href="/financeiro/convenios?mes=${b.competence}">Voltar</a></div></header>
    ${['analisado', 'pago'].includes(b.status) ? html`<section class="kpis">
      <div class="kpi"><span>Cobrado</span><b>${money(sumExp)}</b></div>
      <div class="kpi"><span>Liberado</span><b>${money(b.released)}</b>${b.analyzed_at ? html`<small>análise de ${brDate(b.analyzed_at)}</small>` : ''}</div>
      <div class="kpi"><span>Glosado</span><b class="${Number(b.glosa) > 0 ? 'err-txt' : ''}">${money(b.glosa)}</b>${Number(b.glosa) > 0 && dl ? html`<small>recurso até ${brDate(dl)}</small>` : ''}</div>
      <div class="kpi"><span>Recebido</span><b>${b.status === 'pago' ? money(b.paid_net) : '—'}</b>${b.status === 'pago' ? html`<small>em ${brDate(b.paid_at)}${Number(b.released) - Number(b.paid_net) > 0.005 ? ` · descontos ${money(Number(b.released) - Number(b.paid_net))}` : ''}</small>` : html`<small>aguardando</small>`}</div>
    </section>` : ''}
    ${wsBox}
    ${['gerado', 'enviado'].includes(b.status) ? html`<section class="card"><h2>Envio</h2>
      <ol class="small"><li>Baixe o XML do lote.</li><li>Envie no portal da operadora (área de faturamento / envio de lote XML).</li><li>Anote aqui o número do protocolo que o portal devolver.</li></ol>
      <form method="post" action="/financeiro/convenios/lote/${b.id}/enviado" class="inline-form"><input name="protocol" maxlength="30" value="${b.protocol || ''}" placeholder="Número do protocolo" aria-label="Protocolo"><button class="btn ghost">${b.status === 'enviado' ? 'Atualizar protocolo' : 'Marcar como enviado'}</button></form>
      ${b.status === 'gerado' ? html`<form method="post" action="/financeiro/convenios/lote/${b.id}/cancelar" data-confirm="Cancelar este lote? As sessões voltam para “prontas” e podem entrar num novo lote."><button class="btn ghost danger-text">Cancelar lote</button></form>` : ''}
      <p class="muted small">Hash do epílogo (MD5): <code>${b.hash}</code></p></section>` : ''}
    ${b.status === 'analisado' ? html`<form method="post" action="/financeiro/convenios/lote/${b.id}/pagamento" class="card stack" id="pagamento"><h2>Registrar o pagamento</h2>
      <p class="muted small">Quando o depósito da operadora cair na conta. As cobranças das sessões ficam pagas nesta data, com o valor que entrou (descontos e impostos retidos pela operadora são divididos entre as sessões), e o repasse é calculado sobre esse valor. Se você importa o extrato do banco, a conciliação sugere este lote sozinha.</p>
      <div class="form-grid"><label class="fld"><span>Data do depósito</span><input type="date" name="date" value="${todayLocal()}" required></label>
      <label class="fld"><span>Valor que entrou na conta</span><input name="net" inputmode="decimal" value="${brl(b.released)}" required></label></div>
      <div class="actions"><button class="btn">Registrar pagamento</button></div></form>` : ''}
    ${b.status === 'pago' ? html`<section class="card"><h2>Pagamento</h2><p>Recebido em <b>${brDate(b.paid_at)}</b>: ${money(b.paid_net)}.</p>
      <form method="post" action="/financeiro/convenios/lote/${b.id}/desfazer-pagamento" data-confirm="Desfazer o pagamento deste lote? As cobranças das sessões voltam a ficar em aberto."><button class="btn ghost danger-text">Desfazer pagamento</button></form></section>` : ''}
    ${editable ? html`<form method="post" action="/financeiro/convenios/lote/${b.id}/analise" class="card flush" id="analise"><div class="pad"><h2>Análise da operadora</h2>
      <p class="muted small">Lance o que a operadora liberou em cada sessão (está no demonstrativo de análise de conta, no portal). O que faltar é glosa: informe o código e o motivo. ${b.status === 'enviado' ? 'Se a operadora pagou tudo, pode ir direto para o pagamento: basta salvar sem mudar os valores.' : ''}</p></div>
      ${glosaOpts()}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Guia</th><th>Data</th><th>Paciente</th><th class="num">Cobrado</th><th class="num">Liberado</th><th>Glosa (código)</th><th>Motivo / observação</th></tr></thead><tbody>
      ${items.map((x) => html`<tr data-item="${x.id}"><td>${x.guide_number}</td><td>${brDate(x.starts_at)}</td><td>${x.social_name || x.name}</td><td class="num">${money(x.expected)}</td>
        <td class="num"><input name="rel_${x.id}" inputmode="decimal" value="${brl(x.released ?? x.expected)}" size="8" aria-label="Liberado"></td>
        <td><input name="code_${x.id}" list="glosa-codes" value="${x.glosa_code || ''}" maxlength="4" size="5" inputmode="numeric" aria-label="Código da glosa"></td>
        <td><input name="note_${x.id}" value="${x.glosa_note || ''}" maxlength="500" aria-label="Motivo"></td></tr>`)}</tbody></table></div>
      <div class="actions pad"><button class="btn">${b.status === 'enviado' ? 'Salvar análise' : 'Atualizar análise'}</button></div></form>` : ''}
    ${!editable ? html`<section class="card flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Guia</th><th>Data</th><th>Paciente</th><th class="num">Valor</th>${['analisado', 'pago'].includes(b.status) ? html`<th class="num">Liberado</th><th class="num">Glosa</th><th class="num">Recebido</th>` : ''}</tr></thead><tbody>
      ${items.map((x) => html`<tr><td>${x.guide_number}</td><td>${brDate(x.starts_at)}</td><td><a href="/agenda/${x.appointment_id}">${x.social_name || x.name}</a></td><td class="num">${money(x.expected)}</td>
        ${['analisado', 'pago'].includes(b.status) ? html`<td class="num">${money(x.released)}</td><td class="num">${Number(x.glosa) > 0 ? html`<span class="err-txt">${money(x.glosa)}</span><small class="muted block">${glosaLabel(x.glosa_code)}</small>` : '—'}</td><td class="num">${x.paid !== null ? money(Number(x.paid) + Number(x.recovered || 0) * (x.appeal_id ? 1 : 0)) : '—'}</td>` : ''}</tr>`)}</tbody></table></div></section>` : ''}
    ${glosed.length || aps.length ? html`<section class="card"><h2>Glosas e recursos</h2>
      ${canAppeal ? html`<p><a class="btn" href="/financeiro/convenios/lote/${b.id}/recurso">Recorrer das glosas</a> ${dl ? html`<small class="muted">prazo até ${brDate(dl)} (${ins.appeal_days} dias da análise; ajuste em Configurações → Convênios)</small>` : ''}</p>` : ''}
      ${aps.length ? html`<ul class="list">${aps.map((a) => html`<li><a href="/financeiro/convenios/recurso/${a.id}">Recurso nº ${a.number}</a> · ${money(a.total)} · <span class="badge ${a.status === 'respondido' ? 'b-realizada' : a.status === 'enviado' ? 'b-confirmada' : 'b-agendada'}">${APPEAL[a.status]}</span>${a.recovered !== null ? html` · recuperado ${money(a.recovered)}` : ''}${a.received_at ? html` · recebido em ${brDate(a.received_at)}` : ''}</li>`)}</ul>` : ''}
    </section>` : ''}` }));
});
billing.post('/lote/:id/analise', async (req, res) => {
  const id = int(req.params.id); const items = await Ret.items(id);
  const rows = items.map((x) => ({ itemId: x.id, released: parseBr(req.body[`rel_${x.id}`], x.expected), code: req.body[`code_${x.id}`], note: req.body[`note_${x.id}`] }));
  const out = await Ret.saveAnalysis(id, rows);
  await audit(req, 'convenio-lote-analise', `batch:${id}`);
  const bad = out.ok ? (await Ret.items(id)).filter((x) => Number(x.glosa) > 0 && !Ret.validCode(x.glosa_code)).length : 0;
  res.flash(out.ok ? `Análise salva: liberado ${money(out.released)}${out.glosa > 0 ? `, glosado ${money(out.glosa)}` : ''}.${bad ? ` ${bad} glosa(s) sem código válido da tabela TISS: o código é necessário para o recurso.` : ''}` : out.error, out.ok ? (bad ? 'warn' : 'ok') : 'err').redirect(`/financeiro/convenios/lote/${id}${out.ok ? '#pagamento' : ''}`);
});
billing.post('/lote/:id/pagamento', async (req, res) => {
  const id = int(req.params.id);
  const out = await Ret.registerPayment(id, { date: req.body.date, net: parseBr(req.body.net, null), userId: req.user.id });
  await audit(req, 'convenio-lote-pago', `batch:${id}`);
  res.flash(out.ok ? `Pagamento registrado: ${money(out.net)}. As cobranças das sessões foram baixadas.` : out.error, out.ok ? 'ok' : 'err').redirect(`/financeiro/convenios/lote/${id}`);
});
billing.post('/lote/:id/desfazer-pagamento', async (req, res) => {
  const id = int(req.params.id); const out = await Ret.undoPayment(id, req.user.id);
  await audit(req, 'convenio-lote-pago-desfeito', `batch:${id}`);
  res.flash(out.ok ? 'Pagamento desfeito: as cobranças voltaram a ficar em aberto.' : out.error, out.ok ? 'ok' : 'err').redirect(`/financeiro/convenios/lote/${id}`);
});
// ---------- recurso de glosa ----------
billing.get('/lote/:id/recurso', async (req, res, next) => {
  const b = await T.batch(int(req.params.id)); if (!b) return next();
  const its = (await Ret.items(b.id)).filter((x) => Number(x.glosa) > 0 && !x.appeal_id);
  send(res, page(req, { title: `Recurso de glosa · lote ${b.lot_number}`, active: 'financeiro', body: html`<header class="ph"><div><p class="eyebrow">${b.insurer} · lote nº ${b.lot_number}${b.protocol ? ` · protocolo ${b.protocol}` : ''}</p><h1>Recurso de glosa</h1>
      <p class="muted">Marque as glosas que vai contestar, o valor e a justificativa (até 500 caracteres; o que a operadora vai ler). O sistema gera o XML de recurso no padrão TISS para enviar no portal.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/financeiro/convenios/lote/${b.id}">Voltar</a></div></header>
    ${!/^\d{1,12}$/.test(String(b.protocol || '').replace(/\D/g, '')) ? html`<div class="flash warn">Anote no lote o número do protocolo do envio (só números): o recurso precisa dele.</div>` : ''}
    ${its.length ? html`<form method="post" action="/financeiro/convenios/lote/${b.id}/recurso" class="stack">${its.map((x) => html`<section class="card stack" data-item="${x.id}">
      <label class="fld check"><input type="checkbox" name="pick_${x.id}" value="1" checked><span><b>${brDate(x.starts_at)} · ${x.social_name || x.name}</b> · guia ${x.guide_number} · glosa de <b class="err-txt">${money(x.glosa)}</b> · ${x.glosa_code ? glosaLabel(x.glosa_code) : html`<span class="err-txt">sem código (lance na análise do lote)</span>`}${x.glosa_note ? html`<small class="muted block">${x.glosa_note}</small>` : ''}</span></label>
      <div class="form-grid"><label class="fld"><span>Valor do recurso</span><input name="val_${x.id}" inputmode="decimal" value="${brl(x.glosa)}"></label></div>
      <label class="fld"><span>Justificativa</span><textarea name="txt_${x.id}" maxlength="500" rows="3" placeholder="Ex.: sessão autorizada pela senha nº ..., realizada dentro da validade; guia assinada pelo paciente (cópia anexa no portal)."></textarea></label></section>`)}
      <div class="actions"><button class="btn">Gerar recurso (XML TISS)</button></div></form>` : html`<div class="flash info">Nenhuma glosa a recorrer neste lote.</div>`}` }));
});
billing.post('/lote/:id/recurso', async (req, res) => {
  const id = int(req.params.id);
  const its = (await Ret.items(id)).filter((x) => req.body[`pick_${x.id}`]);
  const out = await Ret.createAppeal(id, its.map((x) => ({ itemId: x.id, value: parseBr(req.body[`val_${x.id}`], x.glosa), text: req.body[`txt_${x.id}`] })), req.user.id);
  await audit(req, 'convenio-recurso-gerar', out.ok ? `appeal:${out.id}` : 'erro');
  if (!out.ok) return res.flash(out.error, 'err').redirect(`/financeiro/convenios/lote/${id}/recurso`);
  res.flash(`Recurso nº ${out.number} gerado: ${money(out.total)}. Baixe o XML e envie no portal da operadora.`).redirect(`/financeiro/convenios/recurso/${out.id}`);
});
billing.get('/recurso/:id', async (req, res, next) => {
  const a = await Ret.appeal(int(req.params.id)); if (!a) return next();
  const its = await Ret.appealItems(a.id);
  const wc = await WS.config(a.insurer_id);
  const wsBox = (a.status === 'rascunho' && WS.enabled(wc, 'recurso')) || (a.status === 'enviado' && a.protocol && WS.enabled(wc, 'statusRecurso')) ? html`<section class="card" id="ws"><h2>Webservice da operadora</h2><div class="actions">
      ${a.status === 'rascunho' && WS.enabled(wc, 'recurso') ? html`<form method="post" action="/financeiro/convenios/recurso/${a.id}/ws/enviar" data-confirm="Enviar este recurso para a operadora agora?"><button class="btn">Enviar pelo webservice</button></form>` : ''}
      ${a.status === 'enviado' && a.protocol && WS.enabled(wc, 'statusRecurso') ? html`<form method="post" action="/financeiro/convenios/recurso/${a.id}/ws/situacao"><button class="btn ghost">Consultar resposta na operadora</button></form>` : ''}</div></section>` : '';
  send(res, page(req, { title: `Recurso nº ${a.number}`, active: 'financeiro', body: html`<header class="ph"><div><p class="eyebrow">${a.insurer} · lote nº ${a.lot_number}${a.batch_protocol ? ` · protocolo ${a.batch_protocol}` : ''}</p><h1>Recurso de glosa nº ${a.number} <span class="badge ${a.status === 'respondido' ? 'b-realizada' : a.status === 'enviado' ? 'b-confirmada' : 'b-agendada'}">${APPEAL[a.status]}</span></h1>
      <p class="muted">${money(a.total)} em recurso · gerado em ${brDate(a.created_at)}${a.sent_at ? ` · enviado em ${brDate(a.sent_at)}` : ''}${a.protocol ? ` · protocolo ${a.protocol}` : ''}</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/financeiro/convenios/recurso/${a.id}/xml">Baixar XML (TISS)</a>${a.portal_url ? html`<a class="btn ghost" href="${a.portal_url}" target="_blank" rel="noopener">Portal da operadora</a>` : ''}<a class="btn ghost" href="/financeiro/convenios/lote/${a.batch_id}">Lote</a></div></header>
    ${wsBox}
    ${a.status !== 'respondido' ? html`<section class="card"><h2>Envio</h2>
      <form method="post" action="/financeiro/convenios/recurso/${a.id}/enviado" class="inline-form"><input name="protocol" maxlength="30" value="${a.protocol || ''}" placeholder="Protocolo do recurso" aria-label="Protocolo"><button class="btn ghost">${a.status === 'enviado' ? 'Atualizar protocolo' : 'Marcar como enviado'}</button></form>
      ${a.status === 'rascunho' ? html`<form method="post" action="/financeiro/convenios/recurso/${a.id}/excluir" data-confirm="Excluir este recurso? As glosas voltam a ficar disponíveis para recorrer."><button class="btn ghost danger-text">Excluir recurso</button></form>` : ''}</section>` : ''}
    ${a.status !== 'rascunho' && !a.received_at ? html`<form method="post" action="/financeiro/convenios/recurso/${a.id}/resposta" class="card flush"><div class="pad"><h2>Resposta da operadora</h2><p class="muted small">Lance quanto foi recuperado em cada sessão (zero se o recurso foi negado). Com a data do depósito, o valor entra na cobrança da sessão e no repasse.</p></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Data</th><th>Paciente</th><th>Glosa</th><th class="num">Recorrido</th><th class="num">Recuperado</th></tr></thead><tbody>
      ${its.map((x) => html`<tr data-item="${x.id}"><td>${brDate(x.starts_at)}</td><td>${x.social_name || x.name}</td><td><small>${glosaLabel(x.glosa_code)}</small></td><td class="num">${money(x.appeal_value)}</td><td class="num"><input name="rec_${x.id}" inputmode="decimal" value="${brl(x.recovered ?? 0)}" size="8" aria-label="Recuperado"></td></tr>`)}</tbody></table></div>
      <div class="form-grid pad"><label class="fld"><span>Recebido em <small class="muted">(deixe vazio se ainda não caiu)</small></span><input type="date" name="received_at"></label></div>
      <div class="actions pad"><button class="btn">Salvar resposta</button></div></form>` : ''}
    ${a.received_at ? html`<div class="flash ok">Recuperado ${money(a.recovered)}, recebido em ${brDate(a.received_at)}.</div>` : ''}
    <section class="card"><h2>Glosas no recurso</h2><ul class="list">${its.map((x) => html`<li><b>${brDate(x.starts_at)} · ${x.social_name || x.name}</b> · ${glosaLabel(x.glosa_code)} · recorrido ${money(x.appeal_value)}${x.recovered !== null ? html` · recuperado <b>${money(x.recovered)}</b>` : ''}<small class="muted block">${x.appeal_text}</small></li>`)}</ul></section>` }));
});
billing.get('/recurso/:id/xml', async (req, res, next) => {
  const a = await Ret.appeal(int(req.params.id)); if (!a || !a.xml) return next();
  await audit(req, 'convenio-recurso-xml', `appeal:${a.id}`);
  res.set({ 'Content-Type': 'application/xml; charset=ISO-8859-1', 'Content-Disposition': `attachment; filename="recurso-${a.number}-lote-${a.lot_number}-${a.insurer.normalize('NFD').replace(/[^\w]+/g, '-').toLowerCase()}.xml"`, 'Cache-Control': 'no-store' });
  res.send(Buffer.from(a.xml, 'latin1'));
});
billing.post('/recurso/:id/enviado', async (req, res) => { const id = int(req.params.id); await Ret.markAppealSent(id, req.body.protocol); await audit(req, 'convenio-recurso-enviado', `appeal:${id}`); res.flash('Recurso marcado como enviado.').redirect(`/financeiro/convenios/recurso/${id}`); });
billing.post('/recurso/:id/excluir', async (req, res) => {
  const id = int(req.params.id); const a = await Ret.appeal(id); const out = await Ret.deleteAppeal(id);
  await audit(req, 'convenio-recurso-excluir', `appeal:${id}`);
  res.flash(out.ok ? 'Recurso excluído.' : out.error, out.ok ? 'ok' : 'err').redirect(out.ok ? `/financeiro/convenios/lote/${a?.batch_id}` : `/financeiro/convenios/recurso/${id}`);
});
billing.post('/recurso/:id/resposta', async (req, res) => {
  const id = int(req.params.id); const its = await Ret.appealItems(id);
  const values = Object.fromEntries(its.map((x) => [x.id, parseBr(req.body[`rec_${x.id}`], 0)]));
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body.received_at || '')) ? req.body.received_at : null;
  const out = await Ret.answerAppeal(id, values, { receivedAt: date, userId: req.user.id });
  await audit(req, 'convenio-recurso-resposta', `appeal:${id}`);
  res.flash(out.ok ? `Resposta registrada: recuperado ${money(out.recovered)}${date ? ', já somado às cobranças das sessões' : '. Quando o valor cair na conta, informe a data aqui'}.` : out.error, out.ok ? 'ok' : 'err').redirect(`/financeiro/convenios/recurso/${id}`);
});
// ---------- demonstrativos (XML de retorno) ----------
billing.post('/demonstrativo', express.raw({ type: () => true, limit: '15mb' }), async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return res.status(400).json({ ok: false, error: 'Arquivo vazio.' });
  let name = 'demonstrativo.xml'; try { name = decodeURIComponent(String(req.get('x-filename') || name)); } catch { /* nome padrão */ }
  const out = await Ret.importDemo(buf, { fileName: name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 160), userId: req.user.id });
  if (!out.ok) return res.status(400).json(out);
  await audit(req, 'convenio-demonstrativo', `demo:${out.demoId}`);
  const n = out.lots.filter((l) => !l.skipped && !l.error).length;
  res.flash(`${out.kind === 'analise' ? 'Demonstrativo de análise' : 'Demonstrativo de pagamento'} importado: ${n} lote(s) atualizado(s).${out.missing.length ? ` Não encontrados: ${out.missing.slice(0, 5).join(', ')}${out.missing.length > 5 ? '…' : ''}.` : ''}`, out.missing.length ? 'warn' : 'ok');
  res.json({ ok: true, redirect: out.lots.length === 1 ? `/financeiro/convenios/lote/${out.lots[0].id}` : '/financeiro/convenios/demonstrativos' });
});
billing.get('/demonstrativos', async (req, res) => {
  const list = await Ret.demos(50);
  const wsIns = []; for (const i of await Ins.list(true)) if (await wsEnabledFor(i.id, 'demonstrativo')) wsIns.push(i);
  const wsFetch = wsIns.length ? html`<form method="post" action="/financeiro/convenios/demonstrativos/buscar" class="card stack" id="ws-buscar"><h2>Buscar na operadora (webservice)</h2>
      <div class="form-grid"><label class="fld"><span>Convênio</span><select name="insurer_id">${wsIns.map((i) => html`<option value="${i.id}">${i.name}</option>`)}</select></label>
      <label class="fld"><span>Competência do pagamento</span><input type="month" name="mes" value="${addMonths(todayLocal().slice(0, 7), -1)}"></label></div>
      <div class="actions"><button class="btn ghost">Buscar demonstrativo de pagamento</button></div></form>` : '';
  send(res, page(req, { title: 'Convênios · Demonstrativos', active: 'financeiro', body: html`<header class="ph"><div><p class="eyebrow">Financeiro · Convênios</p><h1>Demonstrativos da operadora</h1></div></header>
    ${finTabs(req, 'convenios', { key: 'clinica' })}${convNav('demonstrativos')}
    ${demoUpload()}${wsFetch}
    <section class="card flush">${list.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Importado</th><th>Convênio</th><th>Tipo</th><th>Nº</th><th>Lotes</th></tr></thead><tbody>
      ${list.map((d) => { let s = {}; try { s = JSON.parse(d.summary || '{}'); } catch { /* sem resumo */ } return html`<tr><td>${brDate(d.created_at)}<small class="muted block">${d.file_name || ''}</small></td><td>${d.insurer || '—'}</td><td>${d.kind === 'analise' ? 'Análise de conta' : `Pagamento${d.pay_date ? ` (${brDate(d.pay_date)})` : ''}`}</td><td>${d.number || '—'}</td>
        <td>${(s.lots || []).map((l) => html`<a class="chip" href="/financeiro/convenios/lote/${l.id}">nº ${l.lot}${l.skipped ? ` · ${l.skipped}` : l.error ? ` · ${l.error}` : ''}</a> `)}${(s.missing || []).length ? html`<small class="err-txt block">Não encontrados: ${s.missing.join(', ')}</small>` : ''}</td></tr>`; })}</tbody></table></div>` : html`<p class="muted pad">Nenhum demonstrativo importado ainda.</p>`}</section>` }));
});
// ---------- glosas (todas as operadoras) ----------
billing.get('/glosas', async (req, res) => {
  const f = ['abertas', 'recurso', 'encerradas'].includes(req.query.f) ? req.query.f : 'abertas';
  const list = await Ret.glosas(f);
  const tot = list.reduce((a, x) => a + Number(x.glosa), 0);
  send(res, page(req, { title: 'Convênios · Glosas', active: 'financeiro', body: html`<header class="ph"><div><p class="eyebrow">Financeiro · Convênios</p><h1>Glosas</h1>
      <p class="muted">O que as operadoras deixaram de pagar, com o prazo para recorrer.</p></div></header>
    ${finTabs(req, 'convenios', { key: 'clinica' })}${convNav('glosas')}
    <nav class="chips" aria-label="Filtro">${[['abertas', 'Para recorrer'], ['recurso', 'Em recurso'], ['encerradas', 'Encerradas']].map(([k, l]) => html`<a class="chip ${f === k ? 'on' : ''}" href="?f=${k}">${l}</a>`)}</nav>
    <section class="card flush">${list.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Sessão</th><th>Convênio · lote</th><th>Motivo</th><th class="num">Glosa</th><th>${f === 'abertas' ? 'Prazo do recurso' : 'Situação'}</th></tr></thead><tbody>
      ${list.map((x) => html`<tr data-item="${x.id}"><td>${brDate(x.starts_at)}<small class="muted block">${x.social_name || x.name}</small></td><td>${x.insurer}<small class="muted block"><a href="/financeiro/convenios/lote/${x.batch_id}">lote nº ${x.lot_number}</a></small></td>
        <td><small>${x.glosa_code ? glosaLabel(x.glosa_code) : 'sem código'}${x.glosa_note ? html`<span class="muted block">${x.glosa_note}</span>` : ''}</small></td><td class="num err-txt">${money(x.glosa)}</td>
        <td>${f === 'abertas' ? html`${brDate(x.deadline)} <a class="btn ghost btn-sm" href="/financeiro/convenios/lote/${x.batch_id}/recurso">Recorrer</a>` : x.appeal_id ? html`<a href="/financeiro/convenios/recurso/${x.appeal_id}">Recurso nº ${x.appeal_number}</a> · ${APPEAL[x.appeal_status]}${x.recovered !== null ? html`<small class="block">recuperado ${money(x.recovered)}</small>` : ''}` : html`<span class="muted">prazo vencido em ${brDate(x.deadline)}</span>`}</td></tr>`)}
      </tbody><tfoot><tr><td colspan="3"><b>Total</b></td><td class="num"><b>${money(tot)}</b></td><td></td></tr></tfoot></table></div>` : html`<p class="muted pad">Nenhuma glosa ${f === 'abertas' ? 'para recorrer' : f === 'recurso' ? 'em recurso' : 'encerrada'}.</p>`}</section>` }));
});
billing.get('/lote/:id/xml', async (req, res, next) => {
  const b = await T.batch(int(req.params.id)); if (!b || !b.xml || b.status === 'cancelado') return next();
  await audit(req, 'convenio-lote-xml', `batch:${b.id}`);
  res.set({ 'Content-Type': 'application/xml; charset=ISO-8859-1', 'Content-Disposition': `attachment; filename="lote-${b.lot_number}-${b.insurer.normalize('NFD').replace(/[^\w]+/g, '-').toLowerCase()}-${b.competence}.xml"`, 'Cache-Control': 'no-store' });
  res.send(Buffer.from(b.xml, 'latin1'));
});
billing.post('/lote/:id/enviado', async (req, res) => {
  const id = int(req.params.id); await T.markSent(id, req.body.protocol);
  await audit(req, 'convenio-lote-enviado', `batch:${id}`);
  res.flash('Lote marcado como enviado.').redirect(`/financeiro/convenios/lote/${id}`);
});
billing.post('/lote/:id/cancelar', async (req, res) => {
  const id = int(req.params.id); const b = await T.batch(id);
  await T.cancel(id); await audit(req, 'convenio-lote-cancelar', `batch:${id}`);
  res.flash('Lote cancelado: as sessões voltaram para “prontas”.').redirect(`/financeiro/convenios?mes=${b?.competence || ''}`);
});
// Dados do prestador no TISS (Configurações → Convênios)
settings.post('/tiss', async (req, res) => { await T.saveConfig(req.body); await audit(req, 'convenio-tiss-config'); res.flash('Dados do faturamento salvos.').redirect('/configuracoes/convenios#tiss'); });
export async function tissCard() {
  const c = await T.config();
  return html`<form method="post" action="/configuracoes/convenios/tiss" class="card stack" id="tiss"><h2>Dados do prestador no faturamento (TISS)</h2>
    <div class="form-grid">
      <label class="fld"><span>Identificação do prestador nas guias</span><select name="contratado"><option value="codigo" ${sel(c.contratado, 'codigo')}>Código do prestador em cada convênio</option><option value="cnpj" ${sel(c.contratado, 'cnpj')}>CNPJ da clínica (Configurações → Nota fiscal)</option><option value="cpf" ${sel(c.contratado, 'cpf')}>CPF do profissional (Meus dados fiscais)</option></select></label>
      <label class="fld"><span>CNES <small class="muted">(sem cadastro: 9999999)</small></span><input name="cnes" value="${c.cnes}" maxlength="7" inputmode="numeric"></label>
      <label class="fld"><span>UF do conselho (CRP)</span><select name="uf">${Object.entries(T.UFS).map(([k, l]) => html`<option value="${k}" ${sel(c.uf, k)}>${l}</option>`)}</select></label>
      <label class="fld"><span>CBO do profissional</span><select name="cbos">${[['251510', '251510 · Psicólogo clínico'], ['251505', '251505 · Psicólogo educacional'], ['251545', '251545 · Neuropsicólogo'], ['251550', '251550 · Psicanalista'], ['251555', '251555 · Psicólogo acupunturista']].map(([k, l]) => html`<option value="${k}" ${sel(c.cbos, k)}>${l}</option>`)}</select></label>
    </div>
    <div class="actions"><button class="btn ghost">Salvar</button></div></form>`;
}

// ---------- Fase 4: webservice TISS da operadora ----------
async function wsCard(i) {
  const c = await WS.config(i.id); const logs = await WS.log(i.id, 10);
  return html`<form method="post" action="/configuracoes/convenios/${i.id}/webservice" class="card stack" id="webservice"><h2>Webservice TISS (integração direta)</h2>
    <p class="muted small sub-h">Com os endereços e o acesso que a operadora fornece ao prestador (no portal ou no credenciamento), o sistema confere a carteirinha, pede autorização, envia os lotes e recursos e busca os demonstrativos sem passar pelo portal. Deixe em branco os serviços que a operadora não oferece.</p>
    <div class="form-grid">${Object.entries(WS.SERVICES).map(([k, s]) => html`<label class="fld"><span>${s.label}</span><input name="url_${k}" value="${c.urls[k] || ''}" maxlength="300" placeholder="https://…" inputmode="url"></label>`)}</div>
    <div class="form-grid">
      <label class="fld"><span>Login do prestador</span><input name="ws_login" value="${c.ws_login || ''}" maxlength="20" autocomplete="off"></label>
      <label class="fld"><span>Senha ${c.hasPass ? html`<small class="muted">(guardada; deixe vazio para manter)</small>` : ''}</span><input type="password" name="ws_pass" maxlength="64" autocomplete="new-password"></label>
      <label class="fld"><span>Como a senha vai na mensagem</span><select name="ws_pass_mode"><option value="md5" ${sel(c.ws_pass_mode, 'md5')}>Criptografada em MD5 (padrão TISS)</option><option value="texto" ${sel(c.ws_pass_mode, 'texto')}>Como digitada (algumas operadoras)</option></select></label>
      ${c.hasPass ? html`<label class="fld check"><input type="checkbox" name="clear_pass" value="1"><span>Apagar a senha guardada</span></label>` : ''}
    </div>
    <div class="actions"><button class="btn">Salvar webservice</button></div></form>
  <form method="post" action="/configuracoes/convenios/${i.id}/certificado" class="card stack" data-cert-form id="ws-cert"><h2>Certificado digital na conexão <small class="muted">(se a operadora exigir)</small></h2>
    ${c.hasCert ? html`<p>✓ ${c.ws_cert_name}</p>` : html`<p class="muted small">Algumas operadoras só aceitam a conexão com o certificado A1 (e-CNPJ ou e-CPF) do prestador.</p>`}
    <input type="hidden" name="pfx"><div class="form-grid"><label class="fld"><span>Arquivo .pfx / .p12</span><input type="file" accept=".pfx,.p12,application/x-pkcs12" data-cert-file></label>
    <label class="fld"><span>Senha do certificado</span><input type="password" name="password" autocomplete="off"></label></div>
    <div class="actions"><button class="btn ghost">Enviar certificado</button>${c.hasCert ? html`<button class="btn ghost danger-text" name="clear" value="1" formnovalidate>Remover certificado</button>` : ''}</div></form>
  <section class="card" id="ws-log"><h2>Conexão</h2>
    <form method="post" action="/configuracoes/convenios/${i.id}/webservice/testar" class="inline-form"><button class="btn ghost">Testar conexão com a operadora</button></form>
    ${logs.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Serviço</th><th>Resultado</th><th></th></tr></thead><tbody>${logs.map((l) => html`<tr><td>${brDate(l.created_at)} ${String(l.created_at instanceof Date ? l.created_at.toISOString() : l.created_at).slice(11, 16)}</td><td>${WS.SERVICES[l.service]?.label || l.service}</td><td>${l.ok ? html`<span class="badge b-realizada">ok</span>` : html`<span class="err-txt small">${l.error || 'sem resposta'}</span>`}</td><td><a class="btn ghost btn-sm" href="/configuracoes/convenios/${i.id}/webservice/log/${l.id}">Ver mensagens</a></td></tr>`)}</tbody></table></div>` : html`<p class="muted small">Nenhuma chamada ainda.</p>`}
  </section>`;
}
settings.post('/:id/webservice', async (req, res, next) => {
  const i = await Ins.get(int(req.params.id)); if (!i) return next();
  const r = await WS.saveConfig(i.id, req.body); await audit(req, 'convenio-webservice', `insurer:${i.id}`);
  res.flash(r.ok ? 'Webservice salvo. Use “Testar conexão” para conferir.' : r.error, r.ok ? 'ok' : 'err').redirect(`/configuracoes/convenios/${i.id}#webservice`);
});
settings.post('/:id/certificado', async (req, res, next) => {
  const i = await Ins.get(int(req.params.id)); if (!i) return next();
  if (req.body.clear) { await q('UPDATE insurers SET ws_cert_enc = NULL, ws_cert_pass_enc = NULL, ws_cert_name = NULL WHERE id = ?', [i.id]); await audit(req, 'convenio-webservice-cert-remover', `insurer:${i.id}`); return res.flash('Certificado removido.').redirect(`/configuracoes/convenios/${i.id}#ws-cert`); }
  const pfx = req.body.pfx ? Buffer.from(String(req.body.pfx), 'base64') : null;
  if (!pfx?.length) return res.flash('Escolha o arquivo do certificado.', 'err').redirect(`/configuracoes/convenios/${i.id}#ws-cert`);
  const r = await WS.saveCert(i.id, pfx, String(req.body.password || ''));
  await audit(req, 'convenio-webservice-cert', `insurer:${i.id}`);
  res.flash(r.ok ? `Certificado guardado: ${r.name}.` : r.error, r.ok ? 'ok' : 'err').redirect(`/configuracoes/convenios/${i.id}#ws-cert`);
});
settings.post('/:id/webservice/testar', async (req, res, next) => {
  const i = await Ins.get(int(req.params.id)); if (!i) return next();
  const r = await WS.test(i.id, req.user.id);
  res.flash(r.ok ? r.info : r.error, r.ok ? 'ok' : 'err').redirect(`/configuracoes/convenios/${i.id}#ws-log`);
});
settings.get('/:id/webservice/log/:lid', async (req, res, next) => {
  const l = await WS.logEntry(int(req.params.lid)); if (!l || l.insurer_id !== int(req.params.id)) return next();
  send(res, page(req, { title: 'Mensagens do webservice', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Webservice TISS · ${WS.SERVICES[l.service]?.label || l.service}</p><h1>Chamada nº ${l.id}</h1>
      <p class="muted">${brDate(l.created_at)} · ${l.ok ? 'concluída' : `erro: ${l.error || ''}`}${l.http_status ? ` · HTTP ${l.http_status}` : ''}</p></div><div class="ph-actions"><a class="btn ghost" href="/configuracoes/convenios/${req.params.id}#ws-log">Voltar</a></div></header>
    <section class="card"><h2>Enviado</h2><pre class="ws-xml">${l.request || ''}</pre></section>
    <section class="card"><h2>Resposta da operadora</h2><pre class="ws-xml">${l.response || '(sem resposta)'}</pre></section>` }));
});
// ficha do paciente: elegibilidade e pedido de autorização
patients.post('/paciente/:pid/elegibilidade', async (req, res, next) => {
  const p = await patientOf(req); if (!p) return next();
  const pl = await one('SELECT id FROM patient_plans WHERE id = ? AND patient_id = ?', [int(req.body.plan_id), p.id]); if (!pl) return next();
  const r = await WS.eligibility(pl.id, req.user.id); await audit(req, 'convenio-elegibilidade', `plan:${pl.id}`);
  res.flash(r.message || r.error, r.ok ? (r.eligible ? 'ok' : 'warn') : 'err').redirect(`${back(p)}#carteirinhas`);
});
patients.post('/paciente/:pid/pedir-autorizacao', async (req, res, next) => {
  const p = await patientOf(req); if (!p) return next();
  const pl = await one('SELECT id FROM patient_plans WHERE id = ? AND patient_id = ?', [int(req.body.plan_id), p.id]); if (!pl) return next();
  const r = await WS.requestAuth(pl.id, { sessions: req.body.sessions, procId: int(req.body.proc_id), indication: req.body.indication }, req.user.id);
  await audit(req, 'convenio-autorizacao-pedir', `plan:${pl.id}`);
  res.flash(r.ok ? (r.status === 'autorizado' ? `Autorizado pela operadora: ${r.message}. A autorização já está registrada.` : r.status === 'negado' ? `Negado pela operadora: ${r.message}` : `Pedido em análise na operadora. Consulte a situação mais tarde.`) : r.error, r.ok ? (r.status === 'negado' ? 'warn' : 'ok') : 'err').redirect(`${back(p)}#autorizacoes`);
});
patients.post('/paciente/:pid/pedido/:id/situacao', async (req, res, next) => {
  const p = await patientOf(req); if (!p) return next();
  const ar = await one('SELECT id FROM tiss_auth_requests WHERE id = ? AND patient_id = ?', [int(req.params.id), p.id]); if (!ar) return next();
  const r = await WS.authStatus(ar.id, req.user.id);
  res.flash(r.ok ? `Situação na operadora: ${r.message}` : r.error, r.ok ? 'ok' : 'err').redirect(`${back(p)}#autorizacoes`);
});
export async function wsPatientBits(p, plans) {
  const bits = { elig: {}, auth: {}, reqs: await WS.authRequests(p.id) };
  for (const x of plans) { const c = await WS.config(x.insurer_id); bits.elig[x.id] = WS.enabled(c, 'elegibilidade'); bits.auth[x.id] = WS.enabled(c, 'autorizacao'); }
  return bits;
}
// lote e recurso pelo webservice
const wsDo = (fn, okMsg, kind = 'lote') => async (req, res) => {
  const id = int(req.params.id); const r = await fn(id, req.user.id);
  await audit(req, `convenio-ws-${req.path.split('/').pop()}`, `${kind}:${id}`);
  res.flash(r.ok ? okMsg(r) : r.error, r.ok ? (r.missing?.length ? 'warn' : 'ok') : 'err').redirect(`/financeiro/convenios/${kind}/${id}`);
};
billing.post('/lote/:id/ws/enviar', wsDo(WS.sendBatch, (r) => `Lote enviado pelo webservice. Protocolo ${r.protocol}.`));
billing.post('/lote/:id/ws/situacao', wsDo(WS.batchStatus, (r) => `Situação na operadora: ${r.label}.`));
billing.post('/lote/:id/ws/demonstrativo', wsDo(WS.fetchAnalysis, (r) => `Demonstrativo de análise recebido: ${r.lots.filter((l) => !l.skipped).length} lote(s) atualizado(s).${r.missing.length ? ` Não encontrados: ${r.missing.join(', ')}.` : ''}`));
billing.post('/recurso/:id/ws/enviar', wsDo(WS.sendAppeal, (r) => `Recurso enviado pelo webservice. Protocolo ${r.protocol}.`, 'recurso'));
billing.post('/recurso/:id/ws/situacao', wsDo(WS.appealStatus, (r) => r.message, 'recurso'));
billing.post('/demonstrativos/buscar', async (req, res) => {
  const ym = isYm(req.body.mes) ? req.body.mes : addMonths(todayLocal().slice(0, 7), -1);
  const r = await WS.fetchPayments(int(req.body.insurer_id), ym, req.user.id);
  await audit(req, 'convenio-ws-pagamentos', `insurer:${req.body.insurer_id}`);
  res.flash(r.ok ? `Demonstrativo de pagamento recebido: ${r.lots.filter((l) => !l.skipped && !l.error).length} lote(s) pago(s).${r.missing.length ? ` Não encontrados: ${r.missing.join(', ')}.` : ''}` : r.error, r.ok ? 'ok' : 'err').redirect('/financeiro/convenios/demonstrativos');
});
export async function wsEnabledFor(insurerId, svc) { return WS.enabled(await WS.config(insurerId), svc); }
