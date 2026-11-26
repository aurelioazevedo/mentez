// Teleconsulta: Configurações (clínica), escolha da plataforma (profissional) e salas de vídeo (profissional e paciente).
import * as Tenancy from '../lib/tenancy.js';
import express from 'express';
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, brDate, weekday, VERSION, appLogo } from '../lib/html.js';
import * as Brand from '../lib/brand.js';
import { router, send, int, str } from '../lib/router.js';
import { canSeePatient, forbidden, isClinician } from '../lib/perm.js';
import * as T from '../lib/tele.js';
import { syncLater, futureIds } from '../lib/google.js';

const chk = (v) => (v ? raw('checked') : '');
const sel = (a, b) => (String(a) === String(b) ? raw('selected') : '');
const firstName = (p) => String(p.social_name || p.name || '').trim().split(/\s+/)[0];

// ---------- Configurações → Teleconsulta (clínica) ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const c = await T.config();
  const pub = (Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  send(res, page(req, { title: 'Teleconsulta', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Teleconsulta</h1>
      <p class="muted">Escolha quais plataformas a clínica permite e qual é o padrão. Cada profissional escolhe a sua em Minha conta → Teleconsulta, e em cada sessão dá para trocar.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/tc/teste" target="_blank" rel="noopener">Testar câmera e microfone</a><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <h2>Plataformas permitidas</h2>
      <label class="fld check"><input type="checkbox" name="ownAllowed" value="1" ${chk(c.ownAllowed)}><span><b>Teleconsulta própria</b> — vídeo pelo navegador, dentro do sistema, com sala de espera. Sem instalar nada e sem conta do paciente. A conversa vai direto entre os dois aparelhos (criptografada) e não é gravada.</span></label>
      <label class="fld check"><input type="checkbox" name="meetAllowed" value="1" ${chk(c.meetAllowed)}><span><b>Google Meet</b> — o link é criado junto com o evento na Google Agenda do profissional (precisa ter a Google Agenda conectada).</span></label>
      <label class="fld check"><input type="checkbox" name="zoomAllowed" value="1" ${chk(c.zoomAllowed)}><span><b>Zoom</b> — sala pessoal de cada profissional ou uma reunião nova por sessão (com a integração abaixo).</span></label>
      <div class="form-grid">
        <label class="fld"><span>Padrão da clínica</span><select name="clinicDefault">${Object.entries(T.PROVIDERS).map(([k, l]) => html`<option value="${k}" ${sel(c.clinicDefault, k)}>${l}</option>`)}</select><small class="muted">Usado por quem não escolheu uma plataforma.</small></label>
        <label class="fld"><span>Sala própria abre</span><select name="openBefore">${[5, 10, 15, 30].map((m) => html`<option value="${m}" ${sel(c.openBefore, m)}>${m} minutos antes</option>`)}</select></label>
      </div>
      <fieldset class="card soft stack"><legend><b>Zoom</b></legend>
        <div class="rt-units"><label class="maint-g"><input type="radio" name="zoomMode" value="link" ${chk(c.zoomMode !== 'api')}><span><b>Sala pessoal</b><small>cada profissional informa o link da sua sala do Zoom</small></span></label>
          <label class="maint-g"><input type="radio" name="zoomMode" value="api" ${chk(c.zoomMode === 'api')}><span><b>Reunião por sessão</b><small>o sistema cria uma reunião com sala de espera para cada sessão (conta Zoom paga)</small></span></label></div>
        <div class="form-grid">
          <label class="fld"><span>Account ID</span><input name="zoomAccountId" value="${c.zoomAccountId}" maxlength="80" autocomplete="off"></label>
          <label class="fld"><span>Client ID</span><input name="zoomClientId" value="${c.zoomClientId}" maxlength="80" autocomplete="off"></label>
          <label class="fld"><span>Client Secret ${c.zoomSecret ? html`<small class="muted">(cadastrado — preencha só para trocar)</small>` : ''}</span><input name="zoomSecret" type="password" maxlength="200" autocomplete="new-password"></label>
        </div>
        <p class="muted small">Zoom Marketplace → Develop → Build App → <b>Server-to-Server OAuth</b>, com os escopos de reuniões (meeting:write). Cada profissional informa o e-mail da conta Zoom em Minha conta → Teleconsulta.</p>
      </fieldset>
      <fieldset class="card soft stack" id="turn"><legend><b>Servidor de retransmissão (TURN)</b> ${T.relayReady(c) ? html`<span class="badge b-realizada">ligado</span>` : html`<span class="badge b-agendada">recomendado</span>`}</legend>
        <p class="muted small">A chamada tenta ir direto entre os aparelhos. Quando a rede de um dos dois bloqueia isso (comum em operadoras de celular e roteadores no Brasil), cada um vê só a própria câmera e aparece “A conexão falhou”. Com o servidor de retransmissão, o vídeo passa por ele, continua criptografado e não é gravado.</p>
        <h3 class="esc-sub">Cloudflare (recomendado: 1.000 GB por mês sem custo)</h3>
        <div class="form-grid">
          <label class="fld"><span>TURN Key ID</span><input name="cfTurnKeyId" value="${c.cfTurnKeyId}" maxlength="80" autocomplete="off"></label>
          <label class="fld"><span>API Token ${c.cfTurnToken ? html`<small class="muted">(cadastrado — preencha só para trocar)</small>` : ''}</span><input name="cfTurnToken" type="password" maxlength="200" autocomplete="new-password"></label>
        </div>
        ${c.cfTurnToken ? html`<label class="fld check"><input type="checkbox" name="cfTurnRemove" value="1"><span>Remover a chave da Cloudflare</span></label>` : ''}
        <details><summary class="small">Como criar (5 minutos)</summary><ol class="small">
          <li>Crie uma conta grátis em <b>dash.cloudflare.com</b> (não precisa ter site lá).</li>
          <li>No menu, abra <b>Realtime → TURN Server</b> e clique em <b>Create</b>.</li>
          <li>Copie o <b>Turn Token ID</b> e o <b>API Token</b> e cole aqui. Salve e use “Testar a retransmissão”.</li></ol></details>
        <h3 class="esc-sub">Ou outro serviço (Metered, Twilio…)</h3>
        <div class="form-grid">
          <label class="fld"><span>Servidor TURN</span><input name="turnUrl" value="${c.turnUrl}" maxlength="200" placeholder="turns:turn.exemplo.com:443"></label>
          <label class="fld"><span>Usuário</span><input name="turnUser" value="${c.turnUser}" maxlength="120" autocomplete="off"></label>
          <label class="fld"><span>Senha ${c.turnPass ? html`<small class="muted">(cadastrada)</small>` : ''}</span><input name="turnPass" type="password" maxlength="200" autocomplete="new-password"></label>
        </div>
      </fieldset>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>
    ${T.zoomApiReady(c) ? html`<form method="post" action="/configuracoes/teleconsulta/testar-zoom" class="card"><button class="btn ghost">Testar a integração com o Zoom</button></form>` : ''}
    ${T.cfReady(c) ? html`<form method="post" action="/configuracoes/teleconsulta/testar-turn" class="card"><button class="btn ghost">Testar a retransmissão (Cloudflare)</button></form>` : ''}
    <details class="card tv-tips"><summary>Como funciona para o paciente</summary><ul>
      <li>Sala própria: o paciente recebe nos lembretes um link como <code>${pub}/tc/…</code>. Ao abrir, testa câmera e microfone e entra na <b>sala de espera</b>; a profissional é avisada no celular e entra quando estiver pronta.</li>
      <li>Funciona no navegador do celular (Chrome, Safari) e do computador, sem instalar nada.</li>
      <li>Google Meet e Zoom: o link da plataforma vai nos lembretes, como hoje.</li>
    </ul></details>` }));
});
settings.post('/', async (req, res) => {
  const bad = T.checkInput(req.body);
  if (bad) return res.flash(bad, 'err').redirect('/configuracoes/teleconsulta');
  const cur = await T.config();
  const next = await T.saveConfig(req.body, cur);
  await audit(req, 'teleconsulta-config');
  syncLater(await futureIds("a.status IN ('agendada','confirmada') AND a.modality = ?", ['online'])); // aplica nas próximas sessões
  res.flash(`Teleconsulta salva. Padrão da clínica: ${T.SHORT[next.clinicDefault]}.`).redirect('/configuracoes/teleconsulta');
});
settings.post('/testar-turn', async (req, res) => {
  try { const n = await T.testRelay(await T.config()); res.flash(`Retransmissão funcionando: ${n} servidor(es) TURN da Cloudflare liberados para as salas.`); } catch (e) { res.flash(`TURN: ${e.message}`, 'err'); }
  res.redirect('/configuracoes/teleconsulta#turn');
});
settings.post('/testar-zoom', async (req, res) => {
  try { await T.testZoom(await T.config()); res.flash('Integração com o Zoom funcionando.'); } catch (e) { res.flash(`Zoom: ${e.message}`, 'err'); }
  res.redirect('/configuracoes/teleconsulta');
});

// ---------- Minha conta → Teleconsulta (profissional) ----------
export const account = router();
account.get('/', async (req, res) => {
  const c = await T.config();
  const u = await one('SELECT id, tele_provider, zoom_link, zoom_email, google_refresh_enc, google_error, google_meet FROM users WHERE id = ?', [req.user.id]);
  const ok = T.allowed(c);
  const gOk = !!(u.google_refresh_enc && !u.google_error);
  const { p } = await T.resolve({ owner_id: u.id }, c, u);
  send(res, page(req, { title: 'Teleconsulta', active: 'conta', body: html`<header class="ph"><div><p class="eyebrow">Minha conta</p><h1>Teleconsulta</h1>
      <p class="muted">Escolha por onde você atende as sessões on-line. Vale para as próximas sessões; em cada sessão também dá para trocar.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/tc/teste" target="_blank" rel="noopener">Testar câmera e microfone</a><a class="btn ghost" href="/conta">Voltar</a></div></header>
    <form method="post" class="card stack">
      <fieldset class="rt-units"><legend>Minha plataforma</legend>
        <label class="maint-g"><input type="radio" name="tele_provider" value="" ${chk(!u.tele_provider)}><span><b>Padrão da clínica</b><small>${T.PROVIDERS[c.clinicDefault]}</small></span></label>
        ${ok.map((k) => html`<label class="maint-g"><input type="radio" name="tele_provider" value="${k}" ${chk(u.tele_provider === k)}><span><b>${T.PROVIDERS[k]}</b><small>${k === 'propria' ? 'sala de espera, vídeo direto no navegador' : k === 'meet' ? (gOk ? 'Google Agenda conectada ✓' : 'precisa conectar a Google Agenda em Minha conta → Google Agenda') : k === 'zoom' ? (T.zoomApiReady(c) ? 'uma reunião por sessão, criada pelo sistema' : 'sua sala pessoal do Zoom (informe o link abaixo)') : 'você informa o link em cada sessão'}</small></span></label>`)}
      </fieldset>
      ${!c.ownAllowed ? html`<p class="muted small">A teleconsulta própria aparece aqui quando a clínica permitir (Configurações → Teleconsulta).</p>` : ''}
      ${c.zoomAllowed ? html`<div class="form-grid">
        ${T.zoomApiReady(c) ? html`<label class="fld"><span>E-mail da sua conta Zoom</span><input name="zoom_email" type="email" value="${u.zoom_email || ''}" maxlength="190" placeholder="voce@exemplo.com"><small class="muted">As reuniões são criadas nessa conta.</small></label>`
          : html`<label class="fld span2"><span>Link da sua sala pessoal do Zoom</span><input name="zoom_link" type="url" value="${u.zoom_link || ''}" maxlength="500" placeholder="https://us02web.zoom.us/j/…"></label>`}
      </div>` : ''}
      <p class="small">Em uso agora: <b>${T.PROVIDERS[p]}</b>${p !== (u.tele_provider || c.clinicDefault) ? html` <span class="muted">(a escolhida ainda não está pronta — ${!gOk && (u.tele_provider || c.clinicDefault) === 'meet' ? 'conecte a Google Agenda' : 'informe o link do Zoom'})</span>` : ''}.</p>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>` }));
});
account.post('/', async (req, res) => {
  const c = await T.config();
  const prov = req.body.tele_provider && T.allowed(c).includes(req.body.tele_provider) ? req.body.tele_provider : null;
  const zl = str(req.body.zoom_link, 500); const ze = str(req.body.zoom_email, 190);
  if (zl && !/^https:\/\/[\w.-]*zoom\.us\//.test(zl)) return res.flash('O link do Zoom deve começar com https:// e ser do zoom.us.', 'err').redirect('/conta/teleconsulta');
  await q(`UPDATE users SET tele_provider = ?${req.body.zoom_link !== undefined ? ', zoom_link = ?' : ''}${req.body.zoom_email !== undefined ? ', zoom_email = ?' : ''}${prov === 'meet' ? ', google_meet = 1' : ''} WHERE id = ?`,
    [prov, ...(req.body.zoom_link !== undefined ? [zl || null] : []), ...(req.body.zoom_email !== undefined ? [ze || null] : []), req.user.id]);
  await audit(req, 'teleconsulta-minha', prov || 'padrao');
  syncLater(await futureIds("p.owner_id = ? AND a.status IN ('agendada','confirmada') AND a.modality = 'online' AND a.tele_provider IS NULL", [req.user.id]));
  res.flash(`Plataforma salva: ${prov ? T.SHORT[prov] : 'padrão da clínica'}. As próximas sessões on-line já usam essa escolha.`).redirect('/conta/teleconsulta');
});

// ---------- sala de vídeo ----------
const SV = (d) => raw(`<svg class="ti" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`);
const IC = {
  mic: SV('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7"/>'),
  micOff: SV('<path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.6 2.5"/><path d="M5.5 11a6.5 6.5 0 0 0 10.4 5.2M18.5 11a6.4 6.4 0 0 1-.6 2.7M12 17.5V21M8.5 21h7M3 3l18 18"/>'),
  cam: SV('<rect x="2.5" y="6" width="13" height="12" rx="2.5"/><path d="M15.5 10.5 21 7.5v9l-5.5-3"/>'),
  camOff: SV('<path d="M15.5 12.5V8.5A2.5 2.5 0 0 0 13 6H8M4.3 6.4A2.5 2.5 0 0 0 2.5 8.5v7A2.5 2.5 0 0 0 5 18h8a2.5 2.5 0 0 0 2.2-1.3M15.5 10.5 21 7.5v9l-3.2-1.7M3 3l18 18"/>'),
  screen: SV('<rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4M12 13.5V8M9.5 10.5 12 8l2.5 2.5"/>'),
  chat: SV('<path d="M20 15a2 2 0 0 1-2 2H8l-4.5 3.5V6a2 2 0 0 1 2-2H18a2 2 0 0 1 2 2z"/><path d="M8 9h8M8 12.5h5"/>'),
  bell: SV('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>'),
  full: SV('<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>'),
  layout: SV('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/>'),
  ai: SV('<path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/>'),
  end: SV('<path d="M3.5 14.5c4.7-4.2 12.3-4.2 17 0l-2.2 2.6a1.2 1.2 0 0 1-1.5.3l-2.3-1.2a1.2 1.2 0 0 1-.6-1.1V13a11 11 0 0 0-3.8 0v2.1a1.2 1.2 0 0 1-.6 1.1L7.2 17.4a1.2 1.2 0 0 1-1.5-.3z"/>'),
};

// Emojis de emoções para o chat (com nome, para leitores de tela)
const EMOJIS = [['😊', 'Feliz'], ['🙂', 'Tranquilo(a)'], ['😌', 'Aliviado(a)'], ['😄', 'Animado(a)'], ['😂', 'Rindo'], ['🥰', 'Carinho'], ['😢', 'Triste'], ['😭', 'Chorando'], ['😔', 'Desanimado(a)'], ['😟', 'Preocupado(a)'], ['😰', 'Ansioso(a)'], ['😨', 'Com medo'], ['😠', 'Bravo(a)'], ['😤', 'Frustrado(a)'], ['😳', 'Envergonhado(a)'], ['😴', 'Cansado(a)'], ['🤔', 'Pensativo(a)'], ['😮', 'Surpreso(a)'], ['❤️', 'Coração'], ['🤗', 'Abraço'], ['🙏', 'Obrigado(a)'], ['👍', 'Ok'], ['👋', 'Olá / tchau'], ['💪', 'Força']];
function roomPage(req, { role, title, who, when, sigUrl, ice, relay = false, backHref, patientLink, closed, ai = null, timer = null, after = null, pro = null }) {
  const cfg = { role, sigUrl, ice, relay, patientLink, ai, timer, after };
  return bare(title, html`<main class="tele tele-${role}" data-tele data-role="${role}">
    <script type="application/json" id="tele-cfg">${raw(JSON.stringify(cfg).replace(/</g, '\\u003c'))}</script>
    <header class="tele-top"><span class="tele-brand">${appLogo('tele-logo')}</span><div class="tele-who"><b>${who}</b><small>${role === 'pac' ? (pro ? `com ${pro}` : 'Teleconsulta') : when}</small></div><span class="tele-recbadge" data-recbadge hidden><i></i>${role === 'pro' ? 'Transcrevendo' : 'Sessão sendo transcrita'}</span>${role === 'pro' && timer ? html`<div class="tele-clock" data-clock aria-label="Relógio e tempo de sessão"><span class="tc-now" data-clock-now title="Horário atual">--:--</span>
      <span class="tc-timer"><button type="button" data-clock-timer title="Tempo de sessão — clique para pausar ou continuar" aria-label="Tempo de sessão">00:00</button><button type="button" class="tc-reset" data-clock-reset title="Zerar o cronômetro" aria-label="Zerar o cronômetro">↺</button></span>
      <span class="tc-left" data-clock-left title="Pelo horário marcado na agenda"></span></div>` : ''}<span class="tele-status" data-status>${closed || (role === 'pac' ? 'Teste sua câmera e entre na sala de espera' : 'Pronta para entrar')}</span>
      ${backHref ? html`<a class="tele-back" href="${backHref}">Sair da sala</a>` : ''}</header>
    ${role === 'pro' && timer ? html`<div class="tele-prog" data-prog aria-hidden="true"><i></i></div><div class="tele-warn" data-clock-warn hidden role="status"></div>` : ''}
    <section class="tele-stage">
      <video class="tele-remote" data-remote playsinline autoplay></video>
      <div class="tele-wait" data-wait><div><p class="tele-wait-t" data-wait-t>${closed || (role === 'pac' ? 'Antes de entrar, confira se a sua câmera e o microfone estão funcionando.' : 'Entre na sala. Assim que o paciente chegar, a chamada começa.')}</p>
        ${closed ? '' : html`<div class="tele-meter" aria-hidden="true"><i data-meter></i></div><button class="btn big" data-join>${role === 'pac' ? 'Entrar na sala de espera' : 'Entrar na sala'}</button>`}
        <p class="tele-hint muted small">${role === 'pac' ? 'Use fones de ouvido e um lugar reservado. A sessão não é gravada.' : 'A chamada vai direto entre os aparelhos e não é gravada.'}</p></div></div>
      ${role === 'pro' ? html`<div class="tele-admit" data-admit hidden role="alertdialog" aria-live="assertive"><span class="tele-admit-ic" aria-hidden="true">${IC.bell}</span>
        <div><b data-admit-name>Paciente</b><small>está na sala de espera aguardando autorização</small></div>
        ${ai ? html`<label class="tele-admit-ai ${ai.state === 'ok' ? '' : 'na'}" title="${ai.state === 'ok' ? 'A transcrição começa assim que o paciente entrar; o rascunho vai para o prontuário' : ai.reason}"><input type="checkbox" data-admit-ai ${ai.state === 'ok' ? (ai.pref ? raw('checked') : '') : raw('disabled')}><span>Já iniciar com a transcrição${ai.state === 'ok' ? '' : html` <small>(${ai.state === 'sem-autorizacao' ? 'sem autorização do paciente' : 'indisponível'})</small>`}</span></label>` : ''}
        <button type="button" class="btn" data-admit-ok>Autorizar entrada</button><button type="button" class="tele-mute" data-admit-mute title="Silenciar o alerta" aria-pressed="false">${IC.bell}</button></div>` : ''}
      <video class="tele-local" data-local playsinline autoplay muted title="Clique para trocar os vídeos de lugar"></video>
      <button type="button" class="tele-pipsize" data-pipsize title="Tamanho do vídeo pequeno" aria-label="Tamanho do vídeo pequeno">P</button>
      <aside class="tele-chat" data-chat hidden><div class="tele-msgs" data-msgs></div>
        <div class="tele-emojis" data-emojis hidden role="group" aria-label="Emojis">${EMOJIS.map(([e, t]) => html`<button type="button" data-emoji="${e}" title="${t}" aria-label="${t}">${e}</button>`)}</div>
        <form data-chat-form><button type="button" class="tele-emoji-btn" data-emoji-toggle title="Emojis de emoções" aria-label="Emojis" aria-expanded="false">😊</button><input name="m" maxlength="500" placeholder="Mensagem" autocomplete="off" aria-label="Mensagem"><button class="btn">Enviar</button></form></aside>
    </section>
    <nav class="tele-bar" data-bar hidden>
      <button type="button" data-mic aria-pressed="true" title="Microfone">${IC.mic}${IC.micOff}<span>Microfone</span></button>
      <button type="button" data-cam aria-pressed="true" title="Câmera">${IC.cam}${IC.camOff}<span>Câmera</span></button>
      ${role === 'pro' ? html`<button type="button" data-screen title="Compartilhar tela">${IC.screen}<span>Tela</span></button>` : ''}
      ${ai ? html`<button type="button" data-ai class="${ai.state === 'ok' ? '' : 'na'}" title="Transcrever com IA: o rascunho da evolução vai para o prontuário">${IC.ai}<span data-ai-label>Transcrever</span></button>` : ''}
      <button type="button" data-chat-toggle title="Mensagens">${IC.chat}<span>Mensagens</span></button>
      <button type="button" data-layout title="Layout dos vídeos">${IC.layout}<span data-layout-label>Destaque</span></button>
      <button type="button" data-full title="Tela cheia">${IC.full}<span>Tela cheia</span></button>
      <span class="tele-q" data-quality title="Qualidade da conexão"></span>
      <button type="button" class="tele-end" data-end title="Encerrar">${IC.end}<span>${role === 'pro' ? 'Encerrar' : 'Sair'}</span></button>
    </nav>
    ${ai ? html`<p class="tele-aimsg" data-ai-msg hidden></p>` : ''}
    ${ai && ai.state === 'sem-autorizacao' ? html`<div class="tele-ask" data-ai-ask ${ai.auto ? '' : raw('hidden')} role="dialog" aria-labelledby="tele-ask-t"><b id="tele-ask-t">O paciente ainda não autorizou a gravação</b>
      <small>Para transcrever a sessão é preciso o termo “Gravação e uso de IA”.</small>
      <div class="tele-ask-opts"><button type="button" class="btn sm" data-ai-consent="papel">Assinou em papel</button><button type="button" class="btn ghost sm" data-ai-consent="enviar">Enviar o termo (WhatsApp e e-mail)</button><button type="button" class="btn ghost sm" data-ai-consent="sem">Seguir sem gravar</button></div></div>` : ''}
    ${patientLink ? html`<p class="tele-share">Link do paciente: <button type="button" class="btn ghost btn-sm" data-copy-text="${patientLink}">Copiar link</button></p>` : ''}
  </main>
  <script src="/static/tele.js?v=${VERSION}" defer></script>`, 'tele-body', req);
}
const whenOf = (a) => `${weekday(String(a.starts_at).slice(0, 10))}, ${brDate(a.starts_at).slice(0, 5)} às ${String(a.starts_at).slice(11, 16)} · ${a.duration_min} min`;
const APPT = 'SELECT a.*, p.name, p.social_name, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?';

// IA na sessão dentro da sala: liberada para a profissional? paciente autorizou? chaves configuradas?
async function aiFor(req, a) {
  const S = await import('../lib/sessionai.js'); const PD = await import('../lib/psydocs.js');
  const c = await S.config();
  if (!S.allowed(c, req.user)) return null;
  const p = await one('SELECT * FROM patients WHERE id = ?', [a.patient_id]);
  const consent = await S.consentOf(p);
  // auto: veio do “Iniciar” e a profissional escolheu começar a gravar sozinho
  const pref = Number((await one('SELECT auto_rec FROM users WHERE id = ?', [req.user.id]))?.auto_rec || 0) === 1;
  const base = { pid: p.id, appt: a.id, prontuario: `/pacientes/${p.id}/sessao?a=${a.id}`, termos: `/pacientes/${p.id}?aba=termos`, maxMin: c.maxMin, pref, auto: pref && req.query.auto === '1' };
  if (!consent.ok) return { ...base, state: 'sem-autorizacao', reason: 'O paciente ainda não autorizou a gravação e o uso de IA (termo “Gravação e uso de IA”).' };
  const k = await S.sttKeyFor(c, req.user.id); const w = await PD.aiKeyFor(await PD.aiConfig(), req.user.id);
  if (k.error || w.error) return { ...base, state: 'erro', reason: k.error || `Redação: ${w.error}` };
  return { ...base, state: 'ok' };
}
// Profissional (com login)
export const staff = router();
async function staffAppt(req) {
  const a = await one(APPT, [int(req.params.id)]);
  if (!a) return null;
  if (!canSeePatient(req.user, a) || !isClinician(req.user.role)) throw forbidden();
  return a;
}
// Pacientes aguardando autorização (para o aviso sonoro em qualquer tela do sistema)
staff.get('/espera', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ rooms: isClinician(req.user.role) ? await T.waitingFor(req.user.id) : [] });
});
staff.get('/:id', async (req, res, next) => {
  const a = await staffAppt(req); if (!a) return next();
  const c = await T.config();
  if (a.modality !== 'online' || !(a.tele_used === 'propria' || /\/tc\//.test(a.meeting_link || ''))) return res.flash('Esta sessão não usa a teleconsulta própria.', 'warn').redirect(`/agenda/${a.id}`);
  await audit(req, 'teleconsulta-entrar', `appointment:${a.id}`);
  res.set('Cache-Control', 'no-store');
  const ai = await aiFor(req, a);
  send(res, roomPage(req, { ai, role: 'pro', title: `Teleconsulta · ${firstName(a)}`, who: a.social_name || a.name, when: whenOf(a), sigUrl: `/teleconsulta/${a.id}/sinal`, ice: await T.iceServers(c), relay: T.relayReady(c), backHref: `/agenda/${a.id}`, patientLink: T.patientUrl(a.id), closed: a.status === 'cancelada' ? 'Esta sessão foi cancelada.' : null, timer: { appt: a.id, start: String(a.starts_at).slice(0, 19).replace(' ', 'T'), min: Number(a.duration_min) || 50 }, after: `/pacientes/${a.patient_id}/sessao?a=${a.id}&fim=1` }));
});
staff.get('/:id/sinal', async (req, res, next) => {
  const a = await staffAppt(req); if (!a) return next();
  await T.join(a.id, 'pro', res);
});
staff.post('/:id/sinal', express.json({ limit: '120kb' }), async (req, res, next) => {
  const a = await staffAppt(req); if (!a) return next();
  res.json({ ok: await T.signal(a.id, 'pro', req.body) });
});

// Paciente (link da sessão, sem login)
export const patient = router();
patient.get('/teste', (req, res) => {
  res.set('Cache-Control', 'no-store');
  send(res, roomPage(req, { role: 'test', title: 'Teste de câmera e microfone', who: 'Teste de câmera e microfone', when: 'Nada é gravado nem enviado', sigUrl: '', ice: [], backHref: null }));
});
async function patientAppt(req) {
  const id = T.idOfToken(req.params.tok);
  return id ? one(APPT, [id]) : null;
}
patient.get('/:tok', async (req, res) => {
  const a = await patientAppt(req);
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  if (!a) return res.status(404).send(String(bare('Link inválido', html`<main class="legal"><h1>Link inválido</h1><p>Este link de teleconsulta não existe. Confira o link recebido ou fale com o consultório.</p></main>`, 'bare legal-page', req)));
  const c = await T.config(); const w = T.windowOf(a, c); const now = Date.now();
  const closed = a.status === 'cancelada' ? 'Esta sessão foi cancelada.' : a.modality !== 'online' ? 'Esta sessão é presencial.' : now > w.closesAt ? 'O horário desta sessão já passou.'
    : now < w.opensAt ? `A sala abre ${c.openBefore} minutos antes da sessão (${whenOf(a)}). Volte um pouco antes do horário.` : null;
  const proU = await one('SELECT name, title FROM users WHERE id = ?', [a.owner_id]).catch(() => null);
  const pro = proU ? `${proU.title ? `${proU.title} ` : ''}${proU.name}`.trim() : (Brand.get().proName || '');
  // paciente: sem horários da sessão nem cronômetro na tela (só o nome do profissional)
  send(res, roomPage(req, { role: 'pac', title: 'Teleconsulta', who: `Olá, ${firstName(a)}!`, when: '', sigUrl: `/tc/${req.params.tok}/sinal`, ice: closed ? [] : await T.iceServers(c), relay: T.relayReady(c), backHref: null, closed, pro }));
});
async function patientOpen(req) {
  const a = await patientAppt(req);
  if (!a || a.status === 'cancelada' || a.modality !== 'online') return null;
  const c = await T.config(); const w = T.windowOf(a, c);
  return Date.now() >= w.opensAt && Date.now() <= w.closesAt ? a : null;
}
patient.get('/:tok/sinal', async (req, res) => {
  const a = await patientOpen(req);
  if (!a) return res.status(403).end();
  await T.join(a.id, 'pac', res, { ownerId: a.owner_id, name: firstName(a) });
});
patient.post('/:tok/sinal', express.json({ limit: '120kb' }), async (req, res) => {
  const a = await patientOpen(req);
  if (!a) return res.status(403).json({ ok: false });
  res.json({ ok: await T.signal(a.id, 'pac', req.body) });
});
