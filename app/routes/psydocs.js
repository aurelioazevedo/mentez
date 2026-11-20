// Documentos psicológicos: criação a partir da ficha, emissão com assinatura eletrônica e código de verificação,
// impressão/PDF, envio ao paciente por link e página pública de verificação de autenticidade.
import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import express from 'express';
import QRCode from 'qrcode';
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, brDate, brDateTime, logoTag } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { canSeePatient, forbidden, isClinician, proName } from '../lib/perm.js';
import * as Agent from '../lib/agent.js';
import * as D from '../lib/psydocs.js';
import * as WA from '../lib/whatsapp.js';
import { nowLocal } from '../lib/time.js';
import * as ICP from '../lib/icp.js';
import * as Fiscal from '../lib/fiscal.js';
import * as Cloud from '../lib/icpcloud.js';
import { redirectUri } from './icpcloud.js';
import { PDFDocument } from 'pdf-lib';

const r = router();
const nm = (p) => p.social_name || p.name;
const baseOf = (req) => Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`;
async function patientOf(req, id) {
  const p = await one('SELECT * FROM patients WHERE id = ?', [id]);
  if (!p) return null;
  if (!canSeePatient(req.user, p)) throw forbidden();
  return p;
}
async function docOf(req, id) {
  const d = await D.get(id);
  if (!d) return null;
  if (!canSeePatient(req.user, { owner_id: d.p_owner })) throw forbidden();
  return d;
}
const STATUS = { rascunho: ['agendada', 'Rascunho'], emitido: ['realizada', 'Emitido'], cancelado: ['cancelada', 'Cancelado'] };

// O documento como sai no papel (usado na equipe, no link do paciente e na impressão)
export async function letter(d, base, { signature } = {}) {
  const url = d.verify_code ? `${base}/v/${d.verify_code}` : null;
  const qr = url ? await QRCode.toDataURL(url, { width: 220, margin: 1, errorCorrectionLevel: 'M' }) : null;
  return html`<article class="psy-doc ${d.status === 'cancelado' ? 'is-cancelled' : ''}">
    <header class="psy-doc-h">${logoTag('psy-logo')}</header>
    ${d.status === 'cancelado' ? html`<p class="psy-cancel">DOCUMENTO CANCELADO${d.cancel_reason ? ` — ${d.cancel_reason}` : ''}</p>` : d.status === 'rascunho' ? html`<p class="psy-draft">RASCUNHO — ainda não emitido</p>` : ''}
    <h1 class="psy-title">${d.title}</h1>
    <div class="psy-body">${d.body}</div>
    <p class="psy-place">${Brand.get().city ? `${Brand.get().city}, ` : ''}${d.signed_at ? brDate(d.signed_at) : brDate(nowLocal())}.</p>
    <div class="psy-sign">
      ${signature ? html`<img src="${signature}" alt="Assinatura" class="psy-sig-img">` : html`<span class="psy-sig-line"></span>`}
      <b>${d.signer_name || d.author_name || ''}</b><span>Psicóloga(o) · CRP ${d.signer_crp || '—'}</span>
    </div>
    ${d.verify_code ? html`<footer class="psy-verify">${qr ? html`<img src="${qr}" alt="QR code de verificação">` : ''}
      <p>Documento assinado eletronicamente por <b>${d.signer_name}</b> (CRP ${d.signer_crp || '—'}) em ${brDateTime(d.signed_at)}, no sistema do consultório.<br>
      Código de verificação: <b>${d.verify_code}</b> · confira em ${url}<br>
      <small>Documento sigiloso, elaborado conforme a Resolução CFP nº 06/2019. Destina-se exclusivamente à finalidade indicada e não deve ser utilizado para outros fins.</small></p></footer>` : ''}
  </article>`;
}

// ---------- novo / editar ----------
function docForm(req, { p, kind, body, title, purpose, requester, apptId, appts, action, isNew, facts = null, ai = null, opts }) {
  const kindOf = kind;
  return html`${facts ? html`<section class="card psy-facts"><h2>Dados da ficha usados no documento</h2>
      <ul>${facts.map(([l, v, ok]) => html`<li class="${ok ? 'ok' : 'miss'}"><span>${ok ? '✓' : '!'}</span><b>${l}</b> ${ok ? v : html`<em>não cadastrado</em>`}</li>`)}</ul>
      ${facts.some((f) => !f[2]) ? html`<p class="small"><a class="link" href="/pacientes/${p.id}/editar">Completar a ficha do paciente</a> e depois <a class="link" href="">recarregar esta página</a>. Ou preencha direto no texto, no lugar dos [colchetes].</p>` : ''}
    </section>` : ''}
    ${ai ? html`<section class="card psy-ai" data-psy-ai data-pid="${p.id}" data-kind="${kind}"><h2>Escrever com IA</h2>
      <p class="muted small">Descreva o que o documento deve dizer (motivo, período, observações, conclusão). A IA escreve o texto no modelo do CFP; você revisa antes de emitir. O nome do paciente e o CPF não são enviados: a IA recebe marcadores no lugar. Custo na ${ai.owner === 'profissional' ? 'sua chave' : ai.owner === 'clinica' ? 'chave da clínica' : 'chave configurada'}.</p>
      <label class="fld"><span>O que o documento deve conter</span><textarea rows="4" data-ai-notes placeholder="Ex.: acompanhamento semanal desde março, demanda de ansiedade no trabalho, boa adesão, recomendo manter a frequência…"></textarea></label>
      ${ai.allowRecords ? html`<label class="fld check"><input type="checkbox" data-ai-records><span>Usar também as últimas evoluções do prontuário (enviadas sem identificação)</span></label>` : ''}
      ${ai.error ? html`<p class="flash warn">${ai.error}</p>` : html`<div class="actions"><button class="btn ghost" type="button" data-ai-go>✨ Gerar texto com IA</button><span class="small" data-ai-msg aria-live="polite"></span></div>`}
    </section>` : ''}
    <form method="post" action="${action}" class="card stack psy-form">
    ${isNew ? html`<input type="hidden" name="kind" value="${kind}">` : ''}
    <div class="form-grid">
      <label class="fld"><span>Título</span><input name="title" maxlength="120" value="${title}"></label>
      <div class="fld"><label for="psy-purpose"><span>Finalidade</span></label><input id="psy-purpose" name="purpose" maxlength="200" value="${purpose || ''}" placeholder="Escolha abaixo ou escreva" data-psy-field="[finalidade]" list="psy-purposes" autocomplete="off">
        <datalist id="psy-purposes">${(opts.purposes[kindOf] || []).map((x) => html`<option value="${x}">`)}</datalist>
        ${(opts.purposes[kindOf] || []).length ? html`<div class="psy-chips" role="group" aria-label="Finalidades sugeridas">${opts.purposes[kindOf].map((x) => html`<button type="button" class="chip ${x === purpose ? 'on' : ''}" data-fill="#psy-purpose" data-value="${x}">${x}</button>`)}</div>` : ''}</div>
      <div class="fld"><label for="psy-requester"><span>Solicitante</span></label><input id="psy-requester" name="requester" maxlength="160" value="${requester || ''}" placeholder="Escolha abaixo ou escreva" data-psy-field="o(a) próprio(a) interessado(a)" list="psy-requesters" autocomplete="off">
        <datalist id="psy-requesters">${opts.requesters.map((x) => html`<option value="${x}">`)}</datalist>
        ${opts.requesters.length ? html`<div class="psy-chips" role="group" aria-label="Solicitantes sugeridos">${opts.requesters.map((x) => html`<button type="button" class="chip ${x === requester ? 'on' : ''}" data-fill="#psy-requester" data-value="${x}">${x}</button>`)}</div>` : ''}</div>
      ${isNew && appts.length ? html`<label class="fld"><span>Sessão de referência</span><select name="appt" data-autosubmit-new>${appts.map((a) => html`<option value="${a.id}" ${a.id === apptId ? raw('selected') : ''}>${brDateTime(a.starts_at)}</option>`)}</select></label>` : ''}
    </div>
    <label class="fld"><span>Texto do documento <small class="muted">(trechos entre [colchetes] precisam ser preenchidos antes de emitir)</small></span><textarea name="body" rows="18" class="psy-ta">${body}</textarea></label>
    <p class="muted small">Linguagem técnica, objetiva e restrita ao necessário para a finalidade (Res. CFP 06/2019). Depois de emitido, o documento não pode mais ser alterado: só cancelado e substituído.</p>
    <div class="actions"><button class="btn ghost" name="acao" value="rascunho">Salvar rascunho</button><button class="btn" name="acao" value="emitir" data-confirm="Emitir e assinar eletronicamente? Depois de emitido o texto não pode mais ser alterado.">Emitir e assinar</button><a class="btn ghost" href="/pacientes/${p.id}?aba=documentos">Cancelar</a></div>
  </form>`;
}
// Painel de IA: só aparece se o administrador liberou para este profissional
async function aiPanel(req) {
  const c = await D.aiConfig();
  if (!D.aiAllowed(c, req.user)) return null;
  const k = await D.aiKeyFor(c, req.user.id);
  return { owner: k.owner, error: k.error, allowRecords: c.allowRecords };
}
r.post('/ia', express.json({ limit: '64kb' }), async (req, res) => {
  const b = req.body || {};
  const p = await patientOf(req, int(b.pid));
  if (!p) return res.status(404).json({ ok: false, error: 'Paciente não encontrado.' });
  const author = await one('SELECT id, name, title, crp FROM users WHERE id = ?', [req.user.id]);
  const out = await D.aiDraft({ kind: b.kind, patient: p, author, user: req.user, notes: str(b.notes, 8000), useRecords: !!b.records, apptId: int(b.appt), purpose: str(b.purpose, 200), requester: str(b.requester, 160) });
  await audit(req, 'documento-ia', `patient:${p.id} ${b.kind}${b.records ? ' +prontuario' : ''}`);
  res.status(out.ok ? 200 : 400).json(out);
});
r.get('/novo/:pid', async (req, res, next) => {
  const p = await patientOf(req, int(req.params.pid));
  if (!p) return next();
  const kind = D.KINDS[req.query.tipo] ? req.query.tipo : 'declaracao';
  const appts = await q("SELECT id, starts_at FROM appointments WHERE patient_id = ? AND status IN ('realizada','em_atendimento','aguardando') ORDER BY starts_at DESC LIMIT 30", [p.id]);
  const apptId = int(req.query.sessao) || appts[0]?.id || null;
  const author = await one('SELECT name, title, crp FROM users WHERE id = ?', [req.user.id]);
  const body = await D.draftBody(kind, p, author, { apptId, purpose: str(req.query.finalidade, 200), requester: str(req.query.solicitante, 160) });
  const v = await D.docVars(p, author, { apptId });
  const facts = [['Nome', v.paciente, true], ['CPF', v.cpf, !v.cpf.startsWith('[')], ['Nascimento', v.nascimento, !v.nascimento.startsWith('[')], ['Profissional', `${v.profissional} · CRP ${v.crp}`, !v.crp.startsWith('[')]];
  if (kind === 'declaracao') facts.push(['Sessão', appts.length ? `${v.data_sessao}, ${v.inicio}–${v.fim}` : '', !!appts.length]);
  const ai = await aiPanel(req);
  send(res, page(req, { title: 'Novo documento', active: 'pacientes', body: html`<header class="ph"><div><p class="eyebrow"><a href="/pacientes/${p.id}?aba=documentos">${nm(p)}</a></p><h1>${D.KINDS[kind].label}</h1><p class="muted">${D.KINDS[kind].desc}</p></div></header>
    <nav class="tabs psy-kinds">${Object.entries(D.KINDS).map(([k, v]) => html`<a href="/documentos/novo/${p.id}?tipo=${k}" class="${k === kind ? 'on' : ''}">${v.label}</a>`)}</nav>
    ${!author?.crp ? html`<p class="flash warn">Seu CRP não está cadastrado (Usuários): ele é obrigatório para emitir documentos.</p>` : ''}
    ${docForm(req, { p, kind, body, title: D.KINDS[kind].title, apptId, appts: kind === 'declaracao' ? appts : [], action: `/documentos/novo/${p.id}`, isNew: true, facts, ai, opts: await D.options() })}` }));
});
r.post('/novo/:pid', async (req, res, next) => {
  const p = await patientOf(req, int(req.params.pid));
  if (!p) return next();
  const b = req.body;
  const out = await D.create(p.id, b.kind, { title: str(b.title, 120), body: String(b.body || ''), purpose: str(b.purpose, 200), requester: str(b.requester, 160), apptId: int(b.appt) }, req.user.id);
  if (!out.ok) return res.flash(out.error, 'err').redirect(`/pacientes/${p.id}?aba=documentos`);
  await audit(req, 'documento-criar', `patient:${p.id} doc:${out.id}`);
  if (b.acao === 'emitir') return emitAndGo(req, res, out.id);
  res.flash('Rascunho salvo.').redirect(`/documentos/${out.id}`);
});
async function emitAndGo(req, res, id) {
  if (!isClinician(req.user.role)) { res.flash('Somente psicólogas(os) podem emitir documentos.', 'err'); return res.redirect(`/documentos/${id}`); }
  const u = await one('SELECT name, title, crp FROM users WHERE id = ?', [req.user.id]);
  if (!u.crp) { res.flash('Cadastre seu CRP (Usuários) antes de emitir.', 'err'); return res.redirect(`/documentos/${id}`); }
  const out = await D.issue(id, u);
  if (!out.ok) { res.flash(out.error, 'err'); return res.redirect(`/documentos/${id}/editar`); }
  await audit(req, 'documento-emitir', `doc:${id} ${out.code}`);
  res.flash(`Documento emitido e assinado. Código de verificação: ${out.code}.`).redirect(`/documentos/${id}`);
}
r.get('/:id', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  await audit(req, 'documento-ver', `doc:${d.id}`);
  const author = d.author_id ? await one('SELECT signature_png FROM users WHERE id = ?', [d.author_id]) : null;
  const ok = d.status === 'rascunho' || D.intact(d);
  send(res, page(req, { title: d.title, active: 'pacientes', body: html`<header class="ph no-print"><div><p class="eyebrow"><a href="/pacientes/${d.patient_id}?aba=documentos">${d.p_social || d.p_name}</a> · ${D.KINDS[d.kind]?.label}</p>
      <h1>${d.title} <span class="badge b-${STATUS[d.status][0]}">${STATUS[d.status][1]}</span></h1>
      <p class="muted">Criado em ${brDateTime(d.created_at)}${d.signed_at ? ` · emitido em ${brDateTime(d.signed_at)}` : ''}${d.purpose ? ` · finalidade: ${d.purpose}` : ''}</p></div>
      <div class="ph-actions">
        ${d.status === 'rascunho' ? html`<a class="btn ghost" href="/documentos/${d.id}/editar">Editar</a><form method="post" action="/documentos/${d.id}/emitir" data-confirm="Emitir e assinar eletronicamente? Depois de emitido o texto não pode mais ser alterado."><button class="btn">Emitir e assinar</button></form>` : ''}
        ${d.status === 'emitido' ? html`<button class="btn" type="button" data-print>Imprimir / salvar PDF</button><form method="post" action="/documentos/${d.id}/whatsapp" data-confirm="Enviar ao paciente, pelo WhatsApp, um link para baixar este documento (válido por 30 dias)?"><button class="btn ghost">Enviar ao paciente</button></form>` : ''}
      </div></header>
    ${!ok ? html`<p class="flash err no-print">Atenção: o conteúdo não confere com o resumo registrado na emissão.</p>` : ''}
    ${await letter(d, baseOf(req), { signature: author?.signature_png })}
    <div class="no-print psy-after">
      ${d.status === 'emitido' ? html`<form method="post" action="/documentos/${d.id}/cancelar" class="psy-cancel-form" data-confirm="Cancelar este documento? O código de verificação passa a mostrar “cancelado”."><input name="reason" maxlength="200" placeholder="Motivo do cancelamento (ex.: substituído por outro)" aria-label="Motivo"><button class="btn ghost danger-text">Cancelar documento</button></form>
        ${await icpCard(req, d)}` : ''}
      ${d.status === 'rascunho' ? html`<form method="post" action="/documentos/${d.id}/excluir" data-confirm="Excluir este rascunho?"><button class="btn ghost danger-text">Excluir rascunho</button></form>` : ''}
    </div>` }));
});
// ---------- assinatura digital ICP-Brasil ----------
const fileName = (d, signed) => `${(D.KINDS[d.kind]?.label || 'documento').normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').toLowerCase()}-${d.verify_code || d.id}${signed ? '-assinado' : ''}.pdf`;
// CPF esperado de quem assina: dados fiscais do(a) profissional ou o CPF do certificado A1 cadastrado
async function expectedCpf(userId) {
  const fp = await Fiscal.profile(userId); if (Fiscal.cpfValid(fp.cpf)) return String(fp.cpf).replace(/\D/g, '');
  return (await ICP.certOf(userId))?.cpf || '';
}
async function icpCard(req, d) {
  const mine = d.author_id === req.user.id;
  const cert = mine ? await ICP.certOf(req.user.id) : null;
  const cc = mine ? await Cloud.config() : null; const cloud = mine ? await Cloud.userChoice(req.user.id) : null;
  const cloudOk = cloud && Cloud.ready(cc, cloud);
  const cloudSession = cloudOk ? !!(await Cloud.sessionToken(req.user.id, cloud)) : false;
  if (d.icp_signed_at) {
    return html`<section class="card psy-icp ok" id="icp"><h2>✓ Assinado com certificado digital ICP-Brasil</h2>
      <p>${d.icp_name}${D.icpCpf(d) ? html` · CPF ${ICP.maskCpf(D.icpCpf(d))}` : ''} · ${d.icp_issuer || ''}<br><small class="muted">em ${brDateTime(d.icp_signed_at)} · ${d.icp_via === 'a1' ? 'certificado A1, pelo sistema' : d.icp_via === 'nuvem' ? `certificado em nuvem (${Cloud.PROVIDERS[d.icp_provider]?.label || 'nuvem'}), aprovado no celular` : 'assinado fora do sistema e conferido aqui'}</small></p>
      <div class="actions"><a class="btn" href="/documentos/${d.id}/pdf">Baixar o PDF assinado</a></div>
      <p class="muted small">O paciente recebe este PDF pelo link do documento. Qualquer pessoa pode conferir a assinatura em <b>validar.iti.gov.br</b>.</p></section>`;
  }
  return html`<section class="card psy-icp" id="icp"><h2>Assinatura digital ICP-Brasil</h2>
    <p class="muted small">Dá validade jurídica plena ao documento digital (MP 2.200-2/2001). ${mine ? '' : `Só ${d.signer_name || 'quem emitiu'} pode assinar, com o próprio certificado.`}</p>
    ${mine && cloudOk ? (cloudSession
      ? html`<form method="post" action="/documentos/${d.id}/nuvem" class="inline-form psy-icp-a1">
        <span><b>Com o meu certificado em nuvem · ${Cloud.PROVIDERS[cloud].label}</b><small class="muted"> · sessão de assinatura já aprovada no celular</small></span>
        <button class="btn">Assinar com ${Cloud.PROVIDERS[cloud].label}</button></form>`
      : html`<div class="inline-form psy-icp-a1">
        <span><b>Com o meu certificado em nuvem · ${Cloud.PROVIDERS[cloud].label}</b><small class="muted"> · você aprova no aplicativo ${Cloud.PROVIDERS[cloud].app} do celular</small></span>
        <a class="btn" href="/documentos/${d.id}/nuvem">Assinar com ${Cloud.PROVIDERS[cloud].label}</a></div>`) : ''}
    ${mine ? html`${cert && !cert.expired ? html`<form method="post" action="/documentos/${d.id}/assinar" class="inline-form psy-icp-a1">
        <span><b>Com o meu certificado A1</b><small class="muted"> · ${cert.name} · válido até ${cert.validTo ? cert.validTo.toLocaleDateString('pt-BR') : '—'}</small></span>
        ${cert.remembered ? '' : html`<input type="password" name="senha" placeholder="Senha do certificado" autocomplete="off" required aria-label="Senha do certificado">`}
        <button class="btn">Assinar com certificado digital</button></form>`
      : cloudOk ? '' : html`<p class="small">${cert?.expired ? 'O seu certificado A1 venceu. ' : ''}<a class="link" href="/conta#certificado">${cert?.expired ? 'Enviar o certificado novo' : Cloud.available(cc).length ? 'Escolher o meu certificado (em nuvem ou A1)' : 'Cadastrar o meu certificado A1'}</a> para assinar sem sair do sistema.</p>`}
      <details class="psy-icp-ext"${cert && !cert.expired ? '' : raw(' open')}><summary><b>Com certificado em nuvem (VIDaaS, BirdID…) ou token A3</b></summary><ol class="small">
        <li><a class="link" href="/documentos/${d.id}/pdf?base=1">Baixe o PDF do documento</a>.</li>
        <li>Assine no aplicativo da sua certificadora ou no assinador do ITI (<b>assinador.iti.br</b>), escolhendo o seu certificado ICP-Brasil.</li>
        <li>Envie aqui o PDF assinado: o sistema confere a assinatura, a cadeia ICP-Brasil e se é o mesmo documento.</li></ol>
        <label class="btn ghost file-btn"><input type="file" accept="application/pdf" data-upload="/documentos/${d.id}/assinado" hidden>Enviar o PDF assinado</label>
        <span class="muted small" data-upload-msg></span></details>` : ''}
    <div class="actions"><a class="btn ghost" href="/documentos/${d.id}/pdf?base=1">Baixar PDF (sem assinatura digital)</a></div></section>`;
}
r.get('/:id/pdf', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d || d.status === 'rascunho') return next();
  const signed = req.query.base ? null : await D.signedPdf(d.id);
  const pdf = signed || await D.basePdf(d, baseOf(req));
  await audit(req, 'documento-pdf', `doc:${d.id}${signed ? ' assinado' : ''}`);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileName(d, !!signed)}"`, 'Cache-Control': 'no-store' });
  res.send(pdf);
});
// Certificado em nuvem: vai à certificadora para a aprovação no celular (ou assina direto, se a sessão de assinatura ainda vale)
async function cloudSign(req, d, provider, token) {
  const { pdf, info } = await Cloud.signPdf({ provider, token, pdf: await D.basePdf(d, baseOf(req)), reason: `${D.KINDS[d.kind]?.label || 'Documento'} · código ${d.verify_code}`, location: Brand.get().place || 'Brasil' });
  const v = await ICP.verifyPdf(pdf);
  if (!v.ok) throw new Error(`a conferência falhou: ${v.problems.join('; ')}`);
  const want = await expectedCpf(req.user.id);
  if (want && info.cpf && info.cpf !== want) throw new Error(`o certificado aprovado é de outra pessoa (${info.name}).`);
  await D.saveSigned(d.id, pdf, { name: info.name, cpf: info.cpf, issuer: info.issuer, provider }, 'nuvem');
  await audit(req, 'documento-assinar-icp', `doc:${d.id} nuvem ${provider}`);
}
r.get('/:id/nuvem', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  if (d.status !== 'emitido' || d.author_id !== req.user.id) return res.flash('Só quem emitiu o documento pode assiná-lo, depois de emitido.', 'err').redirect(`/documentos/${d.id}`);
  const provider = await Cloud.userChoice(req.user.id);
  if (!provider || !Cloud.ready(await Cloud.config(), provider)) return res.flash('Escolha o seu certificado em nuvem em Conta → Certificado digital.', 'err').redirect(`/documentos/${d.id}#icp`);
  try { res.redirect(await Cloud.start({ userId: req.user.id, docId: d.id, provider, cpf: await expectedCpf(req.user.id), redirectUri: redirectUri(req) })); }
  catch (e) { res.flash(e.message, 'err').redirect(`/documentos/${d.id}#icp`); }
});
r.post('/:id/nuvem', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  if (d.status !== 'emitido' || d.author_id !== req.user.id) return res.flash('Só quem emitiu o documento pode assiná-lo, depois de emitido.', 'err').redirect(`/documentos/${d.id}`);
  const provider = await Cloud.userChoice(req.user.id);
  if (!provider || !Cloud.ready(await Cloud.config(), provider)) return res.flash('Escolha o seu certificado em nuvem em Conta → Certificado digital.', 'err').redirect(`/documentos/${d.id}#icp`);
  const token = await Cloud.sessionToken(req.user.id, provider);
  if (token) {
    try { await cloudSign(req, d, provider, token); return res.flash(`Documento assinado com ${Cloud.PROVIDERS[provider].label}.`).redirect(`/documentos/${d.id}#icp`); }
    catch (e) { await Cloud.dropToken(req.user.id, provider); if (!(e.status === 401 || e.status === 403)) return res.flash(`Não foi possível assinar: ${e.message}`, 'err').redirect(`/documentos/${d.id}#icp`); }
  }
  // sessão vencida: o botão vira o link que leva à certificadora para aprovar de novo
  res.flash('A sessão de assinatura terminou: aprove de novo no aplicativo.', 'warn').redirect(`/documentos/${d.id}#icp`);
});
r.post('/:id/assinar', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  if (d.status !== 'emitido' || d.author_id !== req.user.id) return res.flash('Só quem emitiu o documento pode assiná-lo, depois de emitido.', 'err').redirect(`/documentos/${d.id}`);
  try {
    const { pdf, info } = await ICP.signWithA1(req.user.id, await D.basePdf(d, baseOf(req)), { pass: String(req.body.senha || ''), reason: `${D.KINDS[d.kind]?.label || 'Documento'} · código ${d.verify_code}`, location: Brand.get().place || 'Brasil' });
    const v = await ICP.verifyPdf(pdf);
    if (!v.ok) throw new Error(`a conferência falhou: ${v.problems.join('; ')}`);
    await D.saveSigned(d.id, pdf, { name: info.name, cpf: info.cpf, issuer: info.issuer }, 'a1');
    await audit(req, 'documento-assinar-icp', `doc:${d.id} a1`);
    res.flash('Documento assinado com o seu certificado digital ICP-Brasil.');
  } catch (e) { res.flash(`Não foi possível assinar: ${e.message}`, 'err'); }
  res.redirect(`/documentos/${d.id}#icp`);
});
r.post('/:id/assinado', express.raw({ type: () => true, limit: '8mb' }), async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  const back = `/documentos/${d.id}?enviado=${Date.now()}#icp`; // recarrega a página (só o # não recarregaria)
  const fail = (m) => { res.flash(`PDF não aceito: ${m}`, 'err'); return res.json({ ok: true, redirect: back }); };
  if (d.status !== 'emitido' || d.author_id !== req.user.id) return fail('só quem emitiu o documento pode enviar a versão assinada.');
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.subarray(0, 5).toString() !== '%PDF-') return fail('envie o arquivo PDF.');
  // é o mesmo documento? (o assinador acrescenta a assinatura ao PDF baixado daqui)
  const base = await D.basePdf(d, baseOf(req));
  let same = buf.length > base.length && buf.subarray(0, base.length).equals(base);
  if (!same) { try { const pd = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false }); same = String(pd.getSubject() || '') === `psydoc:${d.id}:${d.hash || ''}`; } catch { same = false; } }
  if (!same) return fail('este PDF não é o documento baixado aqui. Baixe o PDF desta página, assine e envie o arquivo assinado.');
  const v = await ICP.verifyPdf(buf);
  if (!v.signatures?.length) return fail('o arquivo não tem assinatura digital.');
  if (!v.ok) return fail(`${v.problems.join('; ') || (v.modifiedAfter ? 'o arquivo foi alterado depois da assinatura' : 'assinatura inválida')}.`);
  const want = await expectedCpf(req.user.id);
  if (want && v.last.cpf && v.last.cpf !== want) return fail(`o certificado usado é de outra pessoa (${v.last.name}). Assine com o seu certificado.`);
  await D.saveSigned(d.id, buf, { name: v.last.name, cpf: v.last.cpf, issuer: v.last.issuer }, 'externo');
  await audit(req, 'documento-assinar-icp', `doc:${d.id} externo`);
  res.flash(`Assinatura conferida e guardada: ${v.last.name} · ${v.last.issuer}.`);
  res.json({ ok: true, redirect: back });
});
r.get('/:id/editar', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  if (d.status !== 'rascunho') return res.redirect(`/documentos/${d.id}`);
  const p = await one('SELECT * FROM patients WHERE id = ?', [d.patient_id]);
  send(res, page(req, { title: 'Editar documento', active: 'pacientes', body: html`<header class="ph"><div><p class="eyebrow"><a href="/pacientes/${p.id}?aba=documentos">${nm(p)}</a></p><h1>${D.KINDS[d.kind]?.label}</h1></div></header>
    ${docForm(req, { p, kind: d.kind, body: d.body, title: d.title, purpose: d.purpose, requester: d.requester, appts: [], action: `/documentos/${d.id}`, isNew: false, ai: await aiPanel(req), opts: await D.options() })}` }));
});
r.post('/:id', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  const out = await D.update(d.id, { title: str(req.body.title, 120), body: String(req.body.body || ''), purpose: str(req.body.purpose, 200), requester: str(req.body.requester, 160) });
  if (!out.ok) return res.flash(out.error, 'err').redirect(`/documentos/${d.id}`);
  if (req.body.acao === 'emitir') return emitAndGo(req, res, d.id);
  res.flash('Rascunho salvo.').redirect(`/documentos/${d.id}`);
});
r.post('/:id/emitir', async (req, res, next) => { const d = await docOf(req, int(req.params.id)); if (!d) return next(); return emitAndGo(req, res, d.id); });
r.post('/:id/cancelar', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  await D.cancel(d.id, str(req.body.reason, 200));
  await audit(req, 'documento-cancelar', `doc:${d.id}`);
  res.flash('Documento cancelado.').redirect(`/documentos/${d.id}`);
});
r.post('/:id/excluir', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  await D.removeDraft(d.id);
  res.flash('Rascunho excluído.').redirect(`/pacientes/${d.patient_id}?aba=documentos`);
});
r.post('/:id/whatsapp', async (req, res, next) => {
  const d = await docOf(req, int(req.params.id));
  if (!d) return next();
  if (d.status !== 'emitido') return res.redirect(`/documentos/${d.id}`);
  const p = await one('SELECT name, social_name, phone, whatsapp_optin FROM patients WHERE id = ?', [d.patient_id]);
  if (!p.whatsapp_optin) return res.flash('O paciente não autorizou mensagens pelo WhatsApp.', 'err').redirect(`/documentos/${d.id}`);
  const t = await D.share(d.id);
  const out = await WA.send({ phone: p.phone, text: `Olá, ${nm(p).split(' ')[0]}! Seu documento (${D.KINDS[d.kind].label.toLowerCase()}) está disponível neste link pessoal, válido por 30 dias:\n${baseOf(req)}/d/${t}\n\nNão compartilhe o link.`, kind: 'manual', patient_id: d.patient_id });
  await audit(req, 'documento-enviar', `doc:${d.id}`);
  res.flash(out.ok ? 'Link enviado ao paciente pelo WhatsApp.' : `Não enviado: ${out.error}`, out.ok ? 'ok' : 'err').redirect(`/documentos/${d.id}`);
});
export default r;

// ---------- públicos ----------
// Link pessoal do paciente para ver/baixar o documento emitido
export async function publicDoc(req, res) {
  const d = await D.byShare(req.params.token);
  const expired = d && d.share_expires && String(d.share_expires) < nowLocal();
  if (!d || d.status !== 'emitido' || expired) return res.status(404).send(String(bare('Documento', html`<main class="legal"><h1>Link inválido ou vencido</h1><p>Peça um novo link ao consultório.</p></main>`, 'bare legal-page', req)));
  const author = d.author_id ? await one('SELECT signature_png FROM users WHERE id = ?', [d.author_id]) : null;
  res.set('Cache-Control', 'no-store');
  res.send(String(bare(d.title, html`<main class="psy-public">${await letter(d, baseOf(req), { signature: author?.signature_png })}<p class="no-print psy-pub-act">${d.icp_signed_at ? html`<a class="btn" href="/d/${req.params.token}/pdf">Baixar o PDF com assinatura digital</a> ` : ''}<button class="btn ${d.icp_signed_at ? 'ghost' : ''}" data-print>Imprimir / salvar PDF</button></p>
    ${d.icp_signed_at ? html`<p class="no-print muted small psy-pub-act">Documento assinado digitalmente com certificado ICP-Brasil por ${d.icp_name}. Confira em validar.iti.gov.br.</p>` : ''}</main>`, 'bare psy-page', req)));
}
// Retorno da certificadora (depois da aprovação no celular)
export async function cloudReturn(req, res) {
  const st = String(req.query.state || '');
  if (req.query.error) {
    const s = await (await import('../lib/db.js')).one('SELECT doc_id FROM icp_cloud_sessions WHERE state = ? AND user_id = ?', [st, req.user.id]);
    res.flash(req.query.error === 'access_denied' ? 'Assinatura não autorizada no aplicativo.' : `A certificadora recusou: ${String(req.query.error_description || req.query.error).slice(0, 160)}`, 'err');
    return res.redirect(s ? `/documentos/${s.doc_id}#icp` : '/');
  }
  let docId = null;
  try {
    const f = await Cloud.finish({ state: st, code: req.query.code, userId: req.user.id, redirectUri: redirectUri(req) });
    docId = f.docId;
    const d = await D.get(docId);
    if (!d || d.author_id !== req.user.id || d.status !== 'emitido') throw new Error('documento não encontrado.');
    await cloudSign(req, d, f.provider, f.token);
    res.flash(`Documento assinado com ${Cloud.PROVIDERS[f.provider].label}.`);
  } catch (e) { res.flash(`Não foi possível assinar: ${e.message}`, 'err'); }
  res.redirect(docId ? `/documentos/${docId}#icp` : '/');
}
// PDF assinado (link pessoal do paciente)
export async function publicDocPdf(req, res) {
  const d = await D.byShare(req.params.token);
  const expired = d && d.share_expires && String(d.share_expires) < nowLocal();
  const pdf = d && d.status === 'emitido' && !expired ? await D.signedPdf(d.id) : null;
  if (!pdf) return res.status(404).send('Documento não encontrado.');
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${fileName(d, true)}"`, 'Cache-Control': 'no-store' });
  res.send(pdf);
}
// Verificação de autenticidade (não mostra o conteúdo)
export async function verifyPage(req, res) {
  const d = await D.byCode(String(req.params.code || '').toUpperCase());
  const n = d ? String(d.p_social || d.p_name).trim().split(/\s+/).filter((w) => /\p{L}/u.test(w) && !/^(d[aeo]s?|e)$/i.test(w)) : [];
  const initials = n.length ? `${n[0][0]}.${n.length > 1 ? ` ${n[n.length - 1][0]}.` : ''}` : '';
  res.set('Cache-Control', 'no-store');
  res.send(String(bare('Verificação de documento', html`<main class="legal psy-verify-page">
    ${logoTag('legal-logo-img', 150)}
    <h1>Verificação de documento</h1>
    ${!d ? html`<div class="flash err">Código não encontrado. Confira se foi digitado corretamente.</div>`
    : html`<div class="flash ${d.status === 'emitido' ? 'ok' : 'err'}">${d.status === 'emitido' ? 'Documento autêntico, emitido por este consultório.' : `Este documento foi CANCELADO${d.cancel_reason ? ` (${d.cancel_reason})` : ''}.`}</div>
      <table class="tbl"><tbody>
        <tr><th>Documento</th><td>${D.KINDS[d.kind]?.label || d.title}</td></tr>
        <tr><th>Interessado(a)</th><td>${initials}</td></tr>
        <tr><th>Emitido por</th><td>${d.signer_name} — CRP ${d.signer_crp || '—'}</td></tr>
        <tr><th>Data da emissão</th><td>${brDateTime(d.signed_at)}</td></tr>
        <tr><th>Código</th><td>${d.verify_code}</td></tr>
        ${d.icp_signed_at ? html`<tr><th>Assinatura digital</th><td>ICP-Brasil · ${d.icp_name} · ${d.icp_issuer || ''} · ${brDateTime(d.icp_signed_at)}</td></tr>` : ''}
        <tr><th>Resumo SHA-256</th><td><code class="small">${d.hash}</code></td></tr>
      </tbody></table>
      <p class="muted small">Por sigilo profissional, o conteúdo não é exibido aqui. Compare os dados acima com o documento recebido.</p>`}
  </main>`, 'bare legal-page', req)));
}

// ---------- Configurações → Documentos psicológicos (modelos) ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const t = await D.templates();
  send(res, page(req, { title: 'Documentos psicológicos', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Documentos psicológicos</h1>
      <p class="muted">Modelos usados ao criar declarações, atestados, relatórios, laudos e pareceres (Resolução CFP nº 06/2019). O texto é preenchido com os dados da ficha e revisado antes de emitir.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    ${await aiSettingsCard()}
    ${await optionsCard()}
    <p class="muted small">Campos disponíveis: ${Object.entries(D.VARS).map(([k, v]) => html`<code>{${k}}</code> ${v} · `)}Trechos entre [colchetes] são lembretes: o sistema não deixa emitir enquanto houver colchetes.</p>
    ${Object.entries(D.KINDS).map(([k, v]) => html`<form method="post" action="/configuracoes/documentos/${k}" class="card stack"><h2>${v.label} ${t[k].isDefault ? html`<small class="muted">(modelo padrão)</small>` : html`<small class="muted">(personalizado)</small>`}</h2>
      <p class="muted small">${v.desc}</p>
      <textarea name="body" rows="12" class="psy-ta">${t[k].body}</textarea>
      <div class="actions"><button class="btn">Salvar</button><button class="btn ghost" name="padrao" value="1" formnovalidate>Restaurar o padrão</button></div></form>`)}` }));
});
settings.post('/:kind', async (req, res, next) => {
  if (!D.KINDS[req.params.kind]) return next(); // ex.: /ia (definida abaixo)
  await D.saveTemplate(req.params.kind, req.body.padrao ? '' : String(req.body.body || ''));
  await audit(req, 'documentos-modelo', req.params.kind);
  res.flash('Modelo salvo.').redirect('/configuracoes/documentos');
});

async function optionsCard() {
  const o = await D.options();
  return html`<form method="post" action="/configuracoes/documentos/opcoes" class="card stack" id="opcoes"><h2>Finalidades e solicitantes sugeridos</h2>
    <p class="muted small">Aparecem como botões no documento: um toque preenche o campo (e o texto). Um por linha; o campo continua aceitando texto livre.</p>
    <div class="form-grid">${Object.entries(D.KINDS).map(([k, v]) => html`<label class="fld"><span>Finalidades · ${v.label}</span><textarea name="p_${k}" rows="6">${o.purposes[k].join('\n')}</textarea></label>`)}
      <label class="fld"><span>Solicitantes (todos os documentos)</span><textarea name="requesters" rows="6">${o.requesters.join('\n')}</textarea></label></div>
    <div class="actions"><button class="btn">Salvar</button>${o.custom ? html`<button class="btn ghost" name="padrao" value="1" formnovalidate>Restaurar as sugestões padrão</button>` : ''}</div>
  </form>`;
}
settings.post('/opcoes', async (req, res) => {
  await D.saveOptions(req.body);
  await audit(req, 'documentos-opcoes');
  res.flash('Sugestões salvas.').redirect('/configuracoes/documentos#opcoes');
});
async function aiSettingsCard() {
  const c = await D.aiConfig();
  const users = await q("SELECT id, name, title, ai_key_enc IS NOT NULL has_key FROM users WHERE active = 1 AND demo = 0 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");
  const usage = await D.aiUsage(30);
  const ag = await Agent.config();
  return html`<form method="post" action="/configuracoes/documentos/ia" class="card stack" id="ia"><h2>Escrita com IA</h2>
    <p class="muted small">Permite gerar o texto do documento a partir das anotações do profissional. O texto sempre é revisado antes de emitir; nome e CPF do paciente não são enviados à IA.</p>
    <label class="fld check"><input type="checkbox" name="enabled" value="1" ${c.enabled ? raw('checked') : ''}><span><b>Liberar a escrita com IA</b></span></label>
    <fieldset class="fld wl-chips"><legend>Para quem <small class="muted">(nenhum marcado = todos os psicólogos)</small></legend>${users.map((u) => html`<label class="wl-chip"><input type="checkbox" name="users" value="${u.id}" ${c.users.includes(u.id) ? raw('checked') : ''}><span>${proName(u)}${u.has_key ? ' · tem chave própria' : ''}</span></label>`)}</fieldset>
    <div class="form-grid">
      <label class="fld"><span>Quem paga o uso</span><select name="keyMode">${Object.entries(D.KEY_MODES).map(([k, l]) => html`<option value="${k}" ${c.keyMode === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <label class="fld"><span>Provedor da clínica</span><select name="provider">${Object.entries(D.PROVIDERS).map(([k, l]) => html`<option value="${k}" ${c.provider === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <label class="fld"><span>Modelo (Claude)</span><select name="model">${Object.entries(Agent.MODELS).map(([k, m]) => html`<option value="${k}" ${c.model === k ? raw('selected') : ''}>${m.label}</option>`)}</select></label>
      <label class="fld"><span>Modelo (outros provedores) <small class="muted">ex.: gpt-4.1-mini, gemini-2.5-flash</small></span><input name="model_alt" maxlength="120" value="${c.provider !== 'anthropic' ? c.model : ''}"></label>
      <label class="fld"><span>Endereço da API <small class="muted">(só para “Outro”)</small></span><input name="baseUrl" maxlength="300" value="${c.baseUrl || ''}" placeholder="https://…/v1"></label>
      <label class="fld span2"><span>Chave da clínica para este provedor ${c.clinicKey ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : html`<small class="muted">(vazio: usa a chave do atendente virtual, se for o mesmo provedor)</small>`}</span><input type="password" name="clinic_key" autocomplete="off" maxlength="300"></label>
      ${c.clinicKey ? html`<label class="fld check span2"><input type="checkbox" name="clinic_key_remove" value="1"><span>Remover a chave da clínica</span></label>` : ''}
    </div>
    <p class="muted small">${ag.apiKey ? 'A chave da clínica está configurada (Configurações → Atendente virtual).' : 'A clínica ainda não tem chave configurada: use a chave de cada profissional (Conta → Escrita com IA).'} Cada profissional cadastra a própria chave em <b>Conta</b>, e o custo fica separado na conta dele na Anthropic.</p>
    <label class="fld check"><input type="checkbox" name="allowRecords" value="1" ${c.allowRecords ? raw('checked') : ''}><span>Permitir usar as últimas evoluções do prontuário como base (o profissional marca a cada uso; enviadas sem nome nem CPF)</span></label>
    <div class="actions"><button class="btn">Salvar</button></div>
    ${usage.length ? html`<h3>Uso nos últimos 30 dias</h3><table class="tbl"><thead><tr><th>Profissional</th><th>Chave</th><th>Gerações</th><th>Tokens</th><th>Custo estimado</th></tr></thead><tbody>${usage.map((x) => html`<tr><td>${proName(x)}</td><td>${x.key_owner === 'profissional' ? 'própria' : 'da clínica'}</td><td>${x.n}</td><td>${Number(x.tokens || 0).toLocaleString('pt-BR')}</td><td>US$ ${Number(x.cost).toFixed(2)}${Number(x.other) ? '*' : ''}</td></tr>`)}</tbody></table><p class="muted small">* Para provedores que não são a Anthropic, o custo exato aparece no painel do provedor; aqui contam só os tokens.</p>` : ''}
  </form>`;
}
settings.post('/ia', async (req, res) => {
  const bad = D.checkAiInput(req.body);
  if (bad && req.body.enabled) return res.flash(bad, 'err').redirect('/configuracoes/documentos#ia');
  await D.saveAiConfig(req.body);
  await audit(req, 'documentos-ia-config');
  res.flash('Escrita com IA salva.').redirect('/configuracoes/documentos#ia');
});
