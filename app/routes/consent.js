// Termos digitais: página pública de leitura/aceite (/t/:token), envio, comprovante e modelos editáveis.
import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, brDate, brDateTime, logoTag } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { decrypt } from '../lib/crypto.js';
import { canSeePatient, forbidden } from '../lib/perm.js';
import * as C from '../lib/consent.js';

const baseUrl = (req) => (Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
const ipOf = (req) => String(req.get('cf-connecting-ip') || req.get('x-forwarded-for') || req.ip || '').split(',')[0].trim();
const cpfOk = (v) => { const d = String(v || '').replace(/\D/g, ''); return !d || d.length === 11; };

// ---------- público (sem login) ----------
export async function publicView(req, res) {
  const l = await C.byToken(req.params.token);
  if (!l || l.status === 'cancelado') return res.status(404).send(String(bare('Link inválido', html`<main class="legal"><h1>Link inválido</h1><p>Este link não existe ou foi cancelado. Peça um novo link ao consultório.</p></main>`, 'bare legal-page', req)));
  if (!l.opened_at) await q('UPDATE consent_links SET opened_at = NOW() WHERE id = ?', [l.id]);
  const p = await one('SELECT name, social_name FROM patients WHERE id = ?', [l.patient_id]);
  const done = l.status !== 'pendente';
  res.set('Cache-Control', 'no-store');
  send(res, bare('Termos para leitura e aceite', html`<main class="legal consent-pub">
    ${logoTag('legal-logo-img', 150)}
    <h1>Documentos para leitura</h1>
    <p class="muted">Para: <b>${p ? (p.social_name || p.name) : 'paciente'}</b></p>
    ${l.expired ? html`<div class="flash err">Este link expirou. Peça um novo link ao consultório.</div>` : ''}
    ${done ? html`<div class="flash ${l.status === 'aceito' ? 'ok' : 'warn'}">${l.status === 'aceito' ? `Documento(s) aceito(s) em ${brDateTime(l.decided_at)} por ${l.signer_name}. Obrigado!` : `Você informou que não concorda (${brDateTime(l.decided_at)}). O consultório entrará em contato.`}</div>` : ''}
    ${l.docs.map((d, i) => html`<section class="consent-doc"><h2>${i + 1}. ${d.title}</h2><div class="consent-text">${d.body}</div></section>`)}
    ${!done && !l.expired ? html`<form method="post" class="card stack consent-form">
      <h2>Aceite</h2>
      ${l.docs.map((d, i) => html`<label class="cf-check"><input type="checkbox" name="doc_${i}" value="1" required> <span>Li e concordo com o documento ${i + 1}: ${d.title}</span></label>`)}
      <div class="bk-mode"><label class="maint-g"><input type="radio" name="role" value="paciente" checked><span><b>Sou o(a) paciente</b></span></label><label class="maint-g"><input type="radio" name="role" value="responsavel"><span><b>Sou o responsável legal</b><small>pais ou responsável por menor de idade ou pessoa sob curatela</small></span></label></div>
      <label class="fld"><span>Seu nome completo</span><input name="signer_name" required minlength="5" maxlength="160" autocomplete="name"></label>
      <label class="fld"><span>CPF (opcional)</span><input name="signer_cpf" inputmode="numeric" maxlength="14" placeholder="000.000.000-00"></label>
      <label class="fld"><span>Parentesco (se responsável)</span><input name="relation" maxlength="60" placeholder="mãe, pai, curador…"></label>
      <p class="muted small">Ao confirmar, registramos data, hora, endereço IP e o texto exato aceito, como comprovante.</p>
      <div class="actions"><button class="btn" name="decisao" value="aceito">Confirmar aceite</button><button class="btn ghost" name="decisao" value="recusado" formnovalidate>Não concordo</button></div>
    </form>` : ''}
    <p class="muted small">Dúvidas: ${[Brand.get().phone && `WhatsApp ${Brand.get().phone}`, Brand.get().email].filter(Boolean).join(' · ')} · <a href="/privacidade">Política de Privacidade</a></p>
  </main>`, 'bare legal-page', req));
}
export async function publicDecide(req, res) {
  const l = await C.byToken(req.params.token);
  if (!l || l.status !== 'pendente' || l.expired) return res.redirect(`/t/${encodeURIComponent(req.params.token)}`);
  const b = req.body; const accept = b.decisao === 'aceito';
  if (accept) {
    const all = l.docs.every((_, i) => b[`doc_${i}`]);
    if (!all || str(b.signer_name, 160).length < 5 || !cpfOk(b.signer_cpf)) return res.redirect(`/t/${encodeURIComponent(req.params.token)}`);
  }
  await C.decide(l, { accept, signerName: str(b.signer_name, 160) || '(não informado)', signerCpf: String(b.signer_cpf || '').replace(/\D/g, '') || null, role: b.role, relation: str(b.relation, 60), ip: ipOf(req), ua: req.get('user-agent') });
  res.redirect(`/t/${encodeURIComponent(req.params.token)}`);
}

// ---------- interno ----------
export const internal = router();
async function patientOf(req, id) {
  const p = await one('SELECT * FROM patients WHERE id = ?', [id]);
  if (!p) return null;
  if (!canSeePatient(req.user, p)) throw forbidden();
  return p;
}
internal.post('/enviar/:pid', async (req, res, next) => {
  const p = await patientOf(req, int(req.params.pid));
  if (!p) return next();
  const kinds = Object.keys(C.KINDS).filter((k) => req.body[`k_${k}`]);
  if (!kinds.length) return res.flash('Escolha pelo menos um documento.', 'err').redirect(`/pacientes/${p.id}?aba=termos`);
  if (req.body.via === 'link') {
    const l = await C.createLink(p, kinds, req.user.id);
    await audit(req, 'termos-enviar', `patient:${p.id} ${kinds.join('+')} link`);
    return res.flash('Link criado. Copie e envie ao paciente.').redirect(`/pacientes/${p.id}?aba=termos&link=${l.id}&t=${encodeURIComponent(l.token)}`);
  }
  // Envio: WhatsApp e e-mail juntos (o que estiver disponível para o paciente)
  const out = await C.sendLink(p, kinds, req.user.id, { base: baseUrl(req) });
  await audit(req, 'termos-enviar', `patient:${p.id} ${kinds.join('+')} wa:${out.wa?.ok ? 1 : 0} email:${out.email?.ok ? 1 : 0}`);
  const ok = out.wa?.ok || out.email?.ok;
  return res.flash(C.sentText(out), ok ? 'ok' : 'warn').redirect(`/pacientes/${p.id}?aba=termos&link=${out.link.id}&t=${encodeURIComponent(out.link.token)}`);
});
internal.post('/:id/cancelar', async (req, res, next) => {
  const l = await one('SELECT * FROM consent_links WHERE id = ?', [int(req.params.id)]);
  if (!l) return next();
  await patientOf(req, l.patient_id);
  await q("UPDATE consent_links SET status = 'cancelado' WHERE id = ? AND status = 'pendente'", [l.id]);
  await audit(req, 'termos-cancelar', `link:${l.id}`);
  res.flash('Link cancelado.').redirect(`/pacientes/${l.patient_id}?aba=termos`);
});
internal.get('/:id/comprovante', async (req, res, next) => {
  const l = await one('SELECT * FROM consent_links WHERE id = ?', [int(req.params.id)]);
  if (!l) return next();
  const p = await patientOf(req, l.patient_id);
  const docs = JSON.parse(l.docs);
  await audit(req, 'termos-comprovante', `link:${l.id}`);
  send(res, bare('Comprovante de aceite', html`<main class="legal letter">
    <h1>Comprovante de aceite eletrônico</h1>
    <table class="tbl"><tbody>
      <tr><th>Paciente</th><td>${p.social_name || p.name}</td></tr>
      <tr><th>Situação</th><td>${{ pendente: 'Aguardando aceite', aceito: 'Aceito', recusado: 'Recusado', cancelado: 'Cancelado' }[l.status]}</td></tr>
      ${l.decided_at ? html`<tr><th>Data e hora</th><td>${brDateTime(l.decided_at)} (horário de Brasília)</td></tr>
      <tr><th>Assinado por</th><td>${l.signer_name} ${l.signer_role === 'responsavel' ? `— responsável legal${l.signer_relation ? ` (${l.signer_relation})` : ''}` : '— o(a) próprio(a) paciente'}${l.signer_cpf_enc ? ` · CPF ${decrypt(l.signer_cpf_enc)}` : ''}</td></tr>
      <tr><th>Endereço IP</th><td>${l.ip || '—'}</td></tr><tr><th>Navegador</th><td class="small">${l.user_agent || '—'}</td></tr>` : ''}
      <tr><th>Link enviado em</th><td>${brDateTime(l.created_at)}${l.opened_at ? ` · aberto em ${brDateTime(l.opened_at)}` : ''}</td></tr>
    </tbody></table>
    ${docs.map((d, i) => html`<section class="consent-doc"><h2>${i + 1}. ${d.title} <small class="muted">(versão ${d.version})</small></h2><div class="consent-text">${d.body}</div><p class="muted small">Resumo criptográfico do texto (SHA-256): <code>${d.hash}</code>${C.hashOf(d.body) === d.hash ? ' — íntegro' : ' — ATENÇÃO: texto alterado'}</p></section>`)}
    <p class="no-print"><button class="btn" data-print>Imprimir / salvar PDF</button></p>
  </main>`, 'bare legal-page', req));
});

// ---------- Configurações → Termos e documentos ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const t = await C.templates();
  send(res, page(req, {
    title: 'Termos e documentos', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Termos e documentos</h1><p class="muted">Textos que o paciente lê e aceita pelo link. Ao salvar uma alteração, a versão aumenta; os aceites antigos guardam o texto da época.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <div class="flash warn">Os modelos abaixo são um ponto de partida. Revise o texto com o(a) profissional responsável (e, se possível, com assessoria jurídica) antes de enviar aos pacientes.</div>
    <p class="muted small">Campos automáticos: ${Object.entries(C.VARS).map(([k, l]) => html`<code>{${k}}</code> ${l} · `)}</p>
    ${Object.entries(t).map(([k, d]) => html`<form method="post" action="/configuracoes/termos/${k}" class="card stack">
      <h2>${C.KINDS[k]} <small class="muted">versão ${d.version}${d.isDefault ? ' · modelo padrão' : ` · atualizado ${brDate(d.updated_at)}`}</small></h2>
      <label class="fld"><span>Título</span><input name="title" value="${d.title}" maxlength="160" required></label>
      <label class="fld"><span>Texto</span><textarea name="body" rows="14" required>${d.body}</textarea></label>
      <label class="fld check"><input type="checkbox" name="active" value="1" ${d.active ? raw('checked') : ''}><span>Disponível para envio</span></label>
      <div class="actions"><button class="btn">Salvar</button>${!d.isDefault ? html`<button class="btn ghost" name="restore" value="1" formnovalidate>Restaurar texto padrão</button>` : ''}</div>
    </form>`)}`,
  }));
});
settings.post('/:kind', async (req, res, next) => {
  const k = req.params.kind;
  if (!C.KINDS[k]) return next();
  const body = req.body.restore ? C.defaultBody(k) : String(req.body.body || '').replace(/\r\n/g, '\n').slice(0, 30000);
  await C.saveTemplate(k, { title: str(req.body.title, 160) || C.KINDS[k], body, active: req.body.restore ? true : !!req.body.active }, req.user.id);
  await audit(req, 'termos-modelo', k);
  res.flash('Documento salvo.').redirect('/configuracoes/termos');
});
