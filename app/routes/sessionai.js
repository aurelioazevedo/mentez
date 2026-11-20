// IA na sessão: endpoints do gravador (prontuário do paciente) e a configuração.
import express from 'express';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDateTime } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { canSeePatient, forbidden, proName } from '../lib/perm.js';
import * as AP from '../lib/aiproviders.js';
import * as PsyDocs from '../lib/psydocs.js';
import * as S from '../lib/sessionai.js';
import * as Consent from '../lib/consent.js';

const r = router();
const json = express.json({ limit: '600kb' });

async function patientOf(req, id) {
  const p = await one('SELECT * FROM patients WHERE id = ?', [id]);
  if (!p) return null;
  if (!canSeePatient(req.user, p)) throw forbidden();
  return p;
}
async function recOf(req, id) {
  const rec = await S.get(id);
  if (!rec || rec.user_id !== req.user.id) return null; // só quem gravou acessa
  return rec;
}
const deny = (res, error, code = 400) => res.status(code).json({ ok: false, error });
async function gate(req, res, pid) {
  const c = await S.config();
  if (!S.allowed(c, req.user)) { deny(res, 'A IA na sessão não está liberada para você.', 403); return null; }
  const p = await patientOf(req, pid);
  if (!p) { deny(res, 'Paciente não encontrado.', 404); return null; }
  const ok = await S.consentOf(p);
  if (!ok.ok) { deny(res, 'O paciente não autorizou a gravação e o uso de IA (termo “Gravação e uso de IA”).', 403); return null; }
  return { c, p };
}
export const stateOf = (rec) => ({
  ok: true, id: rec.id, status: rec.status, step: rec.step, error: rec.error, source: rec.source, bytes: rec.bytes, duration: rec.duration_s, createdAt: rec.created_at,
  ...(rec.status === 'pronto' ? { draft: rec.draft, alerts: rec.alerts, transcript: rec.transcript } : {}),
});

r.post('/iniciar', json, async (req, res) => {
  const b = req.body || {};
  const g = await gate(req, res, int(b.pid));
  if (!g) return;
  const id = await S.start(g.p, req.user, { source: b.source, mime: str(b.mime, 80), apptId: int(b.appt) || null });
  await audit(req, 'sessao-ia-iniciar', `patient:${g.p.id} rec:${id} ${b.source === 'arquivo' ? 'arquivo' : 'gravacao'}`);
  res.json({ ok: true, id, maxBytes: S.MAX_BYTES, maxMin: g.c.maxMin, chunk: S.MAX_CHUNK });
});
r.post('/texto', json, async (req, res) => {
  const b = req.body || {};
  const g = await gate(req, res, int(b.pid));
  if (!g) return;
  const text = str(b.text, 200000);
  if (!text || text.length < 80) return deny(res, 'Cole a transcrição completa da sessão (texto muito curto).');
  const id = await S.fromText(g.p, req.user, text);
  await audit(req, 'sessao-ia-texto', `patient:${g.p.id} rec:${id}`);
  res.json({ ok: true, id });
});
r.post('/:id/parte', express.raw({ type: () => true, limit: S.MAX_CHUNK + 1024 }), async (req, res) => {
  const rec = await recOf(req, int(req.params.id));
  if (!rec) return deny(res, 'Gravação não encontrada.', 404);
  const seq = int(req.query.seq);
  if (seq === null || seq < 0 || seq > 100000) return deny(res, 'Parte inválida.');
  const out = await S.addChunk(rec, seq, Buffer.isBuffer(req.body) ? req.body : null);
  res.status(out.ok ? 200 : 400).json(out);
});
r.post('/:id/encerrar', json, async (req, res) => {
  const rec = await recOf(req, int(req.params.id));
  if (!rec) return deny(res, 'Gravação não encontrada.', 404);
  if (rec.status === 'gravando' && !rec.bytes) { await S.discard(rec); return deny(res, 'Nenhum áudio foi recebido. Verifique o microfone e tente de novo.'); }
  await S.finish(rec, Number(req.body?.duration) || 0);
  await audit(req, 'sessao-ia-encerrar', `rec:${rec.id}`);
  res.json({ ok: true });
});
r.get('/:id/estado', async (req, res) => {
  const rec = await recOf(req, int(req.params.id));
  if (!rec) return deny(res, 'Gravação não encontrada.', 404);
  res.json(stateOf(rec));
});
r.post('/:id/resumo', async (req, res) => {
  const rec = await recOf(req, int(req.params.id));
  if (!rec || rec.status !== 'pronto') return deny(res, 'O rascunho desta sessão não está pronto.', 404);
  const out = await S.summarize(await one('SELECT * FROM session_rec WHERE id = ?', [rec.id]));
  await audit(req, 'sessao-ia-resumo', `rec:${rec.id}`);
  res.status(out.ok ? 200 : 400).json(out);
});
r.post('/:id/tentar', async (req, res) => {
  const rec = await recOf(req, int(req.params.id));
  if (!rec) return deny(res, 'Gravação não encontrada.', 404);
  const out = await S.retry(rec);
  res.status(out.ok ? 200 : 400).json(out);
});
r.post('/:id/descartar', async (req, res) => {
  const rec = await recOf(req, int(req.params.id));
  if (!rec) return deny(res, 'Gravação não encontrada.', 404);
  await S.discard(rec);
  await audit(req, 'sessao-ia-descartar', `rec:${rec.id}`);
  if (req.get('accept')?.includes('json')) return res.json({ ok: true });
  res.flash('Gravação descartada: áudio, transcrição e rascunho apagados.').redirect(`/pacientes/${rec.patient_id}/sessao`);
});
// Autorização em papel, envio do termo (WhatsApp + e-mail) ou revogação (registrada no histórico).
// Responde em JSON quando chamada pela tela da sessão ou pela sala de teleconsulta.
r.post('/autorizacao/:pid', json, async (req, res, next) => {
  const p = await patientOf(req, int(req.params.pid));
  if (!p) return next();
  if (!['admin', 'psicologo'].includes(req.user.role)) throw forbidden();
  const wantsJson = (req.get('accept') || '').includes('json');
  const acao = req.body?.acao;
  let msg = ''; let ok = true;
  if (acao === 'papel') { await S.markPaper(p.id); await audit(req, 'sessao-ia-autorizacao-papel', `patient:${p.id}`); msg = 'Autorização em papel registrada.'; }
  else if (acao === 'enviar') {
    const base = (process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
    const out = await Consent.sendLink(p, ['gravacao_ia'], req.user.id, { base });
    await audit(req, 'termos-enviar', `patient:${p.id} gravacao_ia wa:${out.wa?.ok ? 1 : 0} email:${out.email?.ok ? 1 : 0}`);
    ok = !!(out.wa?.ok || out.email?.ok);
    msg = `${Consent.sentText(out)} A sessão continua sem gravação; quando o paciente aceitar, a gravação fica liberada.`;
    if (wantsJson) return res.json({ ok: true, sent: ok, message: msg, url: out.url });
  } else if (acao === 'revogar') {
    await S.revoke(p.id);
    for (const rec of await q("SELECT id FROM session_rec WHERE patient_id = ? AND status IN ('gravando','processando','pronto','erro')", [p.id])) await S.discard(rec);
    await audit(req, 'sessao-ia-revogar', `patient:${p.id}`);
    msg = 'Autorização revogada. Gravações pendentes deste paciente foram apagadas.';
  } else return wantsJson ? res.status(400).json({ ok: false, error: 'Ação inválida.' }) : res.redirect(`/pacientes/${p.id}/sessao`);
  if (wantsJson) return res.json({ ok, message: msg });
  res.flash(msg, ok ? 'ok' : 'warn').redirect(String(req.body.back || '').startsWith(`/pacientes/${p.id}`) ? req.body.back : `/pacientes/${p.id}/sessao#sessao-ia`);
});
// Preferência da profissional: começar a gravar sozinho ao iniciar uma sessão
r.post('/preferencia', json, async (req, res) => {
  const on = req.body?.auto_rec ? 1 : 0;
  await q('UPDATE users SET auto_rec = ? WHERE id = ?', [on, req.user.id]);
  await audit(req, 'sessao-ia-preferencia', on ? 'gravar-auto' : 'gravar-manual');
  res.json({ ok: true, auto_rec: !!on });
});
export default r;

// Pergunta exibida quando a gravação deveria começar mas o paciente ainda não autorizou:
// termo assinado em papel, enviar o termo (WhatsApp + e-mail) ou seguir sem gravar.
export function consentAsk(p, { modal = false, revoked = null } = {}) {
  const body = html`<h2>O paciente ainda não autorizou a gravação</h2>
    <p class="muted">Para gravar e transcrever a sessão é preciso a autorização do paciente (termo <b>“Gravação e uso de IA”</b>).${revoked ? html` A autorização anterior foi revogada em ${brDateTime(revoked)}.` : ''} Como prefere seguir?</p>
    <div class="ask-opts">
      <button type="button" class="ask-opt" data-sai-consent="papel"><b>Assinou em papel</b><small>Registro que o termo foi assinado agora e a gravação começa. Guarde o documento.</small></button>
      <button type="button" class="ask-opt" data-sai-consent="enviar"><b>Enviar o termo para assinatura</b><small>Vai pelo WhatsApp e por e-mail. A sessão começa sem gravar.</small></button>
      <button type="button" class="ask-opt ghost" data-sai-consent="sem"><b>Continuar sem gravar</b><small>Registre a sessão só pelo editor.</small></button>
    </div>
    <p class="sai-msg small" data-sai-consent-msg role="status"></p>`;
  return modal
    ? html`<dialog class="ask-dlg" data-sai-ask data-pid="${p.id}" aria-labelledby="ask-t"><div class="ask-box" id="ask-t">${body}</div></dialog>`
    : html`<div class="ask-inline" data-sai-ask-inline data-pid="${p.id}">${body}</div>`;
}

// Painel de gravação (tela da sessão). opts.auto: veio do botão “Iniciar” (começa sozinho se a preferência estiver ligada).
export async function panel(req, p, opts = {}) {
  const c = await S.config();
  if (!S.allowed(c, req.user)) return '';
  const pref = Number((await one('SELECT auto_rec FROM users WHERE id = ?', [req.user.id]))?.auto_rec || 0) === 1;
  const consent = await S.consentOf(p);
  const prefBox = html`<label class="fld check sai-pref"><input type="checkbox" data-sai-autopref ${pref ? raw('checked') : ''}><span>Começar a gravar automaticamente sempre que eu iniciar uma sessão <small class="muted">(presencial e on-line)</small></span></label>`;
  if (!consent.ok) {
    return html`<section class="card sai" id="sessao-ia" data-sai-noconsent="${p.id}">
      <header class="row-head"><h2>Gravação e transcrição</h2><span class="badge b-agendada">sem autorização</span></header>
      ${opts.auto && pref ? consentAsk(p, { modal: true, revoked: consent.revoked }) : ''}
      ${consentAsk(p, { revoked: consent.revoked })}
      ${prefBox}
    </section>`;
  }
  const k = await S.sttKeyFor(c, req.user.id);
  const w = await PsyDocs.aiKeyFor(await PsyDocs.aiConfig(), req.user.id);
  const open = await S.openFor(p.id, req.user.id);
  const problem = k.error || (w.error ? `Redação: ${w.error}` : '');
  const autostart = !!(opts.auto && pref && !problem && !open.some((x) => ['gravando', 'processando'].includes(x.status)));
  return html`<section class="card sai" id="sessao-ia" data-sai="${p.id}" data-appt="${opts.appt || ''}" data-max-min="${c.maxMin}" data-autostart="${autostart ? '1' : ''}" data-open="${JSON.stringify(open.map((x) => ({ id: x.id, status: x.status, created: x.created_at, source: x.source, bytes: x.bytes })))}">
    <header class="row-head"><h2>Gravação e transcrição</h2><small class="muted">autorizado (${consent.how}, ${brDateTime(consent.at)})</small></header>
    ${problem ? html`<p class="flash err">${problem}</p>` : html`
    <div class="sai-idle" data-sai-idle>
      <button type="button" class="btn sai-rec-btn" data-sai-start><span class="sai-dot"></span> Gravar sessão</button>
      <label class="fld check sai-tab"><input type="checkbox" data-sai-tab><span>Sessão on-line em outra plataforma (Meet, Zoom): gravar também o som da chamada <small class="muted">(Chrome ou Edge no computador; escolha a aba da chamada e marque “compartilhar áudio”)</small></span></label>
      <details class="sai-more"><summary>Outras formas</summary>
        <div class="sai-alt">
          <label class="btn ghost sai-file">Enviar arquivo de áudio<input type="file" accept="audio/*,video/mp4,.m4a,.mp3,.wav,.ogg,.webm" data-sai-file hidden></label>
          <small class="muted">Gravação feita no celular ou no gravador (até 24 MB, cerca de 2 h em qualidade de voz).</small>
          <label class="fld"><span>Ou cole a transcrição pronta (Meet, Zoom, Teams…)</span><textarea rows="4" data-sai-text maxlength="200000" placeholder="Cole aqui o texto da transcrição"></textarea></label>
          <button type="button" class="btn ghost" data-sai-text-go>Gerar rascunho da transcrição</button>
        </div>
      </details>
    </div>
    <div class="sai-live" data-sai-live hidden>
      <div class="sai-meter"><span class="sai-dot on"></span><b data-sai-time>00:00</b><i class="sai-level"><i data-sai-level></i></i><small class="muted" data-sai-net></small></div>
      <div class="actions"><button type="button" class="btn ghost" data-sai-pause>Pausar</button><button type="button" class="btn" data-sai-stop>Encerrar gravação e transcrever</button><button type="button" class="btn ghost danger-text" data-sai-cancel>Descartar</button></div>
      <p class="muted small">Mantenha esta página aberta durante a sessão. Ao finalizar a sessão, a gravação é encerrada e a transcrição começa sozinha.</p>
    </div>
    <div class="sai-busy" data-sai-busy hidden><span class="spin"></span><b data-sai-step>Processando…</b><small class="muted">Pode continuar escrevendo; o rascunho entra no editor quando ficar pronto.</small></div>
    <div class="sai-err" data-sai-err hidden><p class="flash err" data-sai-errmsg></p><div class="actions"><button type="button" class="btn ghost" data-sai-retry>Tentar de novo</button><button type="button" class="btn ghost danger-text" data-sai-drop>Descartar</button></div></div>
    <div class="sai-ready" data-sai-ready hidden>
      <div class="sai-alerts" data-sai-alerts hidden><b>⚠ Pontos de atenção apontados pela IA</b><p class="pre" data-sai-alerts-t></p></div>
      <p class="small"><b>Rascunho colocado no editor abaixo.</b> Revise, corrija o que estiver com [verificar] e salve. Ao salvar, a transcrição é apagada.</p>
      <details><summary>Ver a transcrição</summary><p class="pre sai-tr" data-sai-tr></p></details>
      <div class="actions"><button type="button" class="btn ghost" data-sai-summary>Gerar resumo da sessão</button><button type="button" class="btn ghost" data-sai-fill>Colocar o rascunho no editor de novo</button><button type="button" class="btn ghost" data-sai-fill-tr>Colocar a transcrição no editor</button><button type="button" class="btn ghost danger-text" data-sai-drop>Descartar rascunho e transcrição</button></div>
      <div class="sai-sum" data-sai-sum hidden><b>Resumo da sessão</b><p class="pre" data-sai-sum-t></p><div class="actions"><button type="button" class="btn ghost btn-sm" data-sai-sum-add>Acrescentar ao editor</button><button type="button" class="btn ghost btn-sm" data-sai-sum-copy>Copiar</button></div></div>
    </div>
    <p class="sai-msg small" data-sai-msg role="status"></p>`}
    ${prefBox}
    <details class="sai-auth"><summary class="small muted">Autorização do paciente</summary>
      <form method="post" action="/sessao-ia/autorizacao/${p.id}" class="inline"><input type="hidden" name="acao" value="revogar"><input type="hidden" name="back" value="/pacientes/${p.id}/sessao"><button class="btn ghost small danger-text" data-confirm="Registrar que o paciente revogou a autorização? Gravações e rascunhos pendentes deste paciente serão apagados.">Paciente revogou a autorização</button></form>
    </details>
  </section>`;
}

// ---------- Configurações → IA na sessão ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const c = await S.config();
  const users = await q("SELECT id, name, title FROM users WHERE active = 1 AND demo = 0 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");
  const doc = await PsyDocs.aiConfig();
  const k = await S.sttKeyFor(c, req.user.id);
  const u = await S.usage(30);
  send(res, page(req, { title: 'IA na sessão', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>IA na sessão</h1>
      <p class="muted">Grava a sessão (com autorização do paciente), transcreve e escreve o rascunho da evolução. A(o) psicóloga(o) revisa e salva no prontuário; a responsabilidade pelo registro continua sendo dela(e).</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <label class="fld check"><input type="checkbox" name="enabled" value="1" ${c.enabled ? raw('checked') : ''}><span><b>Liberar a IA na sessão</b></span></label>
      <fieldset class="fld wl-chips"><legend>Para quem <small class="muted">(nenhum marcado = todos os psicólogos)</small></legend>${users.map((x) => html`<label class="wl-chip"><input type="checkbox" name="users" value="${x.id}" ${c.users.includes(x.id) ? raw('checked') : ''}><span>${proName(x)}</span></label>`)}</fieldset>
      <h3>1. Transcrição do áudio</h3>
      <div class="form-grid">
        <label class="fld"><span>Serviço</span><select name="sttProvider">${Object.entries(AP.STT).map(([key, v]) => html`<option value="${key}" ${c.sttProvider === key ? raw('selected') : ''}>${v.label}</option>`)}</select></label>
        <label class="fld"><span>Modelo <small class="muted">Groq: whisper-large-v3-turbo · OpenAI: gpt-4o-mini-transcribe</small></span><input name="sttModel" maxlength="80" value="${c.sttModel}" list="stt-models" required>
          <datalist id="stt-models">${Object.values(AP.STT).flatMap((v) => v.models).map((m) => html`<option value="${m}">`)}</datalist></label>
        <label class="fld"><span>Endereço da API <small class="muted">(só para “Outro”)</small></span><input name="sttBaseUrl" maxlength="300" value="${c.sttBaseUrl}" placeholder="https://…/v1"></label>
        <label class="fld span2"><span>Chave do serviço de transcrição ${c.sttKey ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : html`<small class="muted">(vazio: usa a chave do mesmo serviço já cadastrada no atendente ou em documentos)</small>`}</span><input type="password" name="stt_key" autocomplete="off" maxlength="300"></label>
        ${c.sttKey ? html`<label class="fld check span2"><input type="checkbox" name="stt_key_remove" value="1"><span>Remover esta chave</span></label>` : ''}
      </div>
      <p class="small ${k.error ? 'sai-warn' : 'muted'}">${k.error ? `⚠ ${k.error}` : `Chave em uso para você: ${k.owner === 'profissional' ? 'a sua' : 'a da clínica'}.`} Custo aproximado: Groq US$ 0,04 por hora de áudio; OpenAI (mini) US$ 0,18 por hora.</p>
      <h3>2. Redação da evolução</h3>
      <p class="muted small">Usa a mesma IA e a mesma chave da <a class="link" href="/configuracoes/documentos#ia">Escrita com IA dos documentos</a> (hoje: ${PsyDocs.PROVIDERS[doc.provider]}${doc.provider === 'anthropic' ? '' : ` · ${doc.model}`}; quem paga: ${PsyDocs.KEY_MODES[doc.keyMode]}). O nome, o CPF e o telefone do paciente são retirados antes do envio.</p>
      <label class="fld"><span>Modelo da evolução (seções que a IA preenche)</span><textarea name="template" rows="7" class="psy-ta">${c.template}</textarea></label>
      <label class="fld check"><input type="checkbox" name="useHistory" value="1" ${c.useHistory ? raw('checked') : ''}><span>Enviar também as 3 últimas evoluções do paciente (sem identificação), para comparar com as sessões anteriores</span></label>
      <label class="fld"><span>Tempo máximo de gravação (min)</span><input type="number" name="maxMin" min="10" max="180" value="${c.maxMin}"></label>
      <div class="actions"><button class="btn">Salvar</button></div>
      <p class="muted small">Privacidade: o áudio fica criptografado só até a transcrição e é apagado logo em seguida. A transcrição e o rascunho ficam criptografados até salvar ou descartar (no máximo 7 dias). Só grava paciente com o termo “Gravação e uso de IA” aceito (ou registrado em papel). Nos últimos 30 dias: ${u.n} rascunho(s), custo estimado US$ ${Number(u.cost).toFixed(2)}.</p>
    </form>` }));
});
settings.post('/', async (req, res) => {
  const bad = S.checkInput(req.body);
  if (bad && req.body.enabled) return res.flash(bad, 'err').redirect('/configuracoes/sessao-ia');
  await S.saveConfig(req.body);
  await audit(req, 'sessao-ia-config');
  res.flash('IA na sessão salva.').redirect('/configuracoes/sessao-ia');
});
