import * as Tenancy from '../lib/tenancy.js';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDateTime } from '../lib/html.js';
import { router, send, str } from '../lib/router.js';
import { encrypt, randomToken, sha256 } from '../lib/crypto.js';
import { isClinician, ROLES } from '../lib/perm.js';
import * as G from '../lib/google.js';

const base = (req) => Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`;

// =====================================================================
// Cartão “Google Agenda” na página Conta (perfis clínicos)
// =====================================================================
export async function accountCard(req) {
  if (!isClinician(req.user.role)) return '';
  const u = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const cfg = await G.config();
  const isConnected = !!u.google_refresh_enc;
  let calendars = [];
  if (isConnected && !u.google_error) { try { calendars = await G.listCalendars(u); } catch { /* mostra só a atual */ } }
  const stats = isConnected ? await one(`SELECT SUM(google_event_id IS NOT NULL) ok, SUM(google_error IS NOT NULL) err FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE p.owner_id = ? AND a.starts_at >= NOW() AND a.status <> 'cancelada'`, [u.id]) : null;

  return html`
  <section class="card gcal" id="google">
    <div class="gcal-h"><span class="gicon" aria-hidden="true">${raw(GICON)}</span><div><h2>Google Agenda</h2>
      <p class="muted small">As sessões dos seus pacientes aparecem automaticamente na sua agenda Google — inclusive as marcadas pela recepção.</p></div></div>
    ${!cfg ? html`<p class="flash warn">A integração ainda não foi configurada. ${req.user.role === 'admin' ? html`<a class="link" href="/configuracoes/google">Configurar agora →</a>` : 'Peça à administradora para configurar em Configurações → Google Agenda.'}</p>`
    : !isConnected ? html`
      <ul class="bullets small"><li>Cria, atualiza e remove os eventos quando a sessão muda no sistema.</li><li>Pode criar o link do Google Meet para sessões on-line.</li><li>Avisa quando um novo horário bate com um compromisso pessoal seu.</li><li>Título discreto (só iniciais, por padrão) e nenhum dado clínico vai para o Google.</li></ul>
      <a class="btn" href="/conta/google/conectar">Conectar minha Google Agenda</a>`
    : html`
      ${u.google_error ? html`<p class="flash err">${u.google_error}</p><a class="btn" href="/conta/google/conectar">Reconectar</a>` : html`
      <p><span class="badge b-realizada">Conectada</span> <b>${u.google_email || ''}</b> <small class="muted">desde ${brDateTime(u.google_connected_at)}</small></p>
      <p class="small muted">Próximas sessões sincronizadas: <b>${Number(stats?.ok || 0)}</b>${Number(stats?.err) ? html` · <span class="err-t">${stats.err} com erro</span>` : ''}</p>`}
      <form method="post" action="/conta/google/opcoes" class="form-grid">
        <label class="fld"><span>Agenda de destino</span><select name="calendar">
          ${(calendars.length ? calendars : [{ id: u.google_calendar_id || 'primary', name: u.google_calendar_id && u.google_calendar_id !== 'primary' ? u.google_calendar_id : 'Agenda principal', primary: true }])
            .map((c) => html`<option value="${c.primary ? 'primary' : c.id}" ${(c.primary ? 'primary' : c.id) === (u.google_calendar_id || 'primary') ? raw('selected') : ''}>${c.name}${c.primary ? ' (principal)' : ''}</option>`)}
        </select></label>
        <label class="fld"><span>Título dos eventos</span><select name="title">${Object.entries(G.TITLE_OPTIONS).map(([k, l]) => html`<option value="${k}" ${k === u.google_title ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label class="fld check span2"><input type="checkbox" name="meet" value="1" ${u.google_meet ? raw('checked') : ''}><span>Criar link do Google Meet automaticamente para sessões on-line sem link</span></label>
        <div class="span2 actions"><button class="btn">Salvar preferências</button></div>
      </form>
      <div class="actions" style="margin-top:14px">
        <form method="post" action="/conta/google/sincronizar"><button class="btn ghost">Sincronizar próximas sessões agora</button></form>
        <a class="btn ghost" href="/conta/google/conectar" title="Abre a tela do Google para escolher outra conta">Trocar conta Google</a>
        <form method="post" action="/conta/google/desconectar" data-confirm="Desconectar a Google Agenda? As sessões futuras serão removidas da sua agenda Google."><button class="btn danger">Desconectar</button></form>
      </div>`}
    <details class="ical"><summary>Alternativa: assinar por link (iCal)</summary>
      <p class="small">Para Apple Calendar, Outlook ou Google sem conectar a conta: um link privado, somente leitura, com as suas sessões. O Google atualiza agendas assinadas por link com atraso (até algumas horas).</p>
      <div class="actions">
        <form method="post" action="/conta/ical/gerar" ${u.ical_token_hash ? raw('data-confirm="Gerar um novo link? O link anterior para de funcionar."') : ''}><button class="btn ghost">${u.ical_token_hash ? 'Gerar novo link' : 'Gerar link da agenda'}</button></form>
        ${u.ical_token_hash ? html`<form method="post" action="/conta/ical/revogar"><button class="btn ghost">Desativar link</button></form>` : ''}
      </div>
    </details>
  </section>`;
}

const GICON = '<svg viewBox="0 0 48 48"><rect x="6" y="8" width="36" height="34" rx="5" fill="#fff" stroke="#d4bea2" stroke-width="2"/><rect x="6" y="8" width="36" height="9" rx="5" fill="#4285f4"/><path d="M6 14h36v3H6z" fill="#4285f4"/><text x="24" y="36" text-anchor="middle" font-family="Arial" font-weight="700" font-size="15" fill="#4285f4">31</text></svg>';

// =====================================================================
// Rotas da conta: /conta/google/* e /conta/ical/*
// =====================================================================
export const account = router();
const backupReturn = async (req, res) => (await import('./backup.js')).oauthReturn(req, res);
account.all(['/google/*', '/ical/*'], (req, res, next) => (isClinician(req.user.role) ? next() : res.redirect('/conta')));

account.get('/google/conectar', async (req, res) => {
  if (!(await G.config())) return res.flash('Integração Google ainda não configurada.', 'err').redirect('/conta');
  res.redirect(await G.authUrl(req, req.user.id));
});

account.get('/google/retorno', async (req, res) => {
  const st = G.readState(req.query.state);
  if (st && st.uid === `drive:${req.user.id}`) return backupReturn(req, res); // conexão do Google Drive (backup)
  if (!st || st.uid !== req.user.id) return res.flash('Não foi possível confirmar a conexão. Tente de novo.', 'err').redirect('/conta#google');
  if (req.query.error) return res.flash(req.query.error === 'access_denied' ? 'Conexão cancelada.' : `Google: ${str(req.query.error, 80)}`, 'warn').redirect('/conta#google');
  try {
    const t = await G.exchangeCode(req, str(req.query.code, 2000));
    if (!t.refreshToken) throw new Error('O Google não enviou a autorização permanente. Remova o acesso do app em myaccount.google.com/permissions e conecte de novo.');
    // Troca de conta Google: limpa a agenda da conta anterior antes de usar a nova.
    const prev = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    if (prev.google_refresh_enc && prev.google_email !== t.email) {
      await G.removeFutureEvents(prev).catch(() => 0);
      await G.revoke(prev);
      await q('UPDATE appointments SET google_event_id = NULL, google_cal = NULL, google_owner_id = NULL, google_error = NULL WHERE google_owner_id = ?', [req.user.id]);
      await q("UPDATE users SET google_calendar_id = 'primary' WHERE id = ?", [req.user.id]);
    }
    await q(`UPDATE users SET google_refresh_enc = ?, google_email = ?, google_connected_at = NOW(), google_error = NULL, google_calendar_id = COALESCE(google_calendar_id, 'primary') WHERE id = ?`,
      [encrypt(t.refreshToken), t.email, req.user.id]);
    await audit(req, 'google-conectar', t.email);
    G.syncLater(await G.futureIds('p.owner_id = ? AND a.status <> ?', [req.user.id, 'cancelada']));
    res.flash('Google Agenda conectada! Suas próximas sessões estão sendo enviadas.').redirect('/conta#google');
  } catch (e) {
    res.flash(`Falha ao conectar: ${e.message}`, 'err').redirect('/conta#google');
  }
});

account.post('/google/opcoes', async (req, res) => {
  const cal = str(req.body.calendar, 255) || 'primary';
  const title = Object.keys(G.TITLE_OPTIONS).includes(req.body.title) ? req.body.title : 'iniciais';
  const before = await one('SELECT google_calendar_id, google_title FROM users WHERE id = ?', [req.user.id]);
  await q('UPDATE users SET google_calendar_id = ?, google_title = ?, google_meet = ? WHERE id = ?', [cal, title, req.body.meet ? 1 : 0, req.user.id]);
  if (before.google_calendar_id !== cal) {
    // Agenda trocada: tira da antiga e recria na nova.
    const u = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
    await G.removeFutureEvents(u);
    await q('UPDATE appointments SET google_event_id = NULL, google_cal = NULL, google_owner_id = NULL WHERE google_owner_id = ? AND starts_at >= NOW()', [u.id]);
  }
  if (before.google_calendar_id !== cal || before.google_title !== title) G.syncLater(await G.futureIds('p.owner_id = ?', [req.user.id]));
  res.flash('Preferências salvas.').redirect('/conta#google');
});

account.post('/google/sincronizar', async (req, res) => {
  const ids = await G.futureIds('p.owner_id = ?', [req.user.id]);
  for (const id of ids.slice(0, 60)) await G.syncAppointment(id);
  if (ids.length > 60) G.syncLater(ids.slice(60));
  const err = await one(`SELECT COUNT(*) n FROM appointments WHERE id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'}) AND google_error IS NOT NULL`, ids);
  res.flash(err.n ? `${ids.length - err.n} sessão(ões) sincronizada(s); ${err.n} com erro.` : `${ids.length} sessão(ões) sincronizada(s).`, err.n ? 'warn' : 'ok').redirect('/conta#google');
});

account.post('/google/desconectar', async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const n = await G.removeFutureEvents(u).catch(() => 0);
  await G.revoke(u);
  await q('UPDATE appointments SET google_event_id = NULL, google_cal = NULL, google_owner_id = NULL, google_error = NULL WHERE google_owner_id = ?', [u.id]);
  await q('UPDATE users SET google_refresh_enc = NULL, google_email = NULL, google_connected_at = NULL, google_error = NULL WHERE id = ?', [u.id]);
  await audit(req, 'google-desconectar');
  res.flash(`Google Agenda desconectada${n ? ` e ${n} evento(s) futuro(s) removido(s)` : ''}.`).redirect('/conta#google');
});

account.post('/ical/gerar', async (req, res) => {
  const token = randomToken(24);
  await q('UPDATE users SET ical_token_hash = ? WHERE id = ?', [sha256(token), req.user.id]);
  await audit(req, 'ical-gerar');
  const link = `${base(req)}/ical/${token}.ics`;
  send(res, page(req, {
    title: 'Link da agenda', active: 'conta',
    body: html`<header class="ph"><div><p class="eyebrow">Conta</p><h1>Link privado da sua agenda</h1></div></header>
    <section class="card">
      <div class="copy"><input readonly value="${link}" id="lnk"><button class="btn ghost" data-copy="#lnk">Copiar</button></div>
      <ol class="bullets small">
        <li><b>Google Agenda (computador):</b> “Outras agendas” → <b>+</b> → <b>Do URL</b> → cole o link → “Adicionar agenda”.</li>
        <li><b>iPhone:</b> Ajustes → Calendário → Contas → Adicionar conta → Outra → <b>Adicionar Calendário Assinado</b>.</li>
        <li><b>Outlook:</b> Adicionar calendário → <b>Assinar da Web</b>.</li>
      </ol>
      <p class="muted small">Quem tiver este link vê os horários e as iniciais dos pacientes. Não compartilhe. O link só aparece agora; se perder, gere outro.</p>
      <a class="btn" href="/conta#google">Voltar</a>
    </section>`,
  }));
});

account.post('/ical/revogar', async (req, res) => {
  await q('UPDATE users SET ical_token_hash = NULL WHERE id = ?', [req.user.id]);
  await audit(req, 'ical-revogar');
  res.flash('Link da agenda desativado.').redirect('/conta#google');
});

// Feed público (protegido pelo token secreto)
export async function icalFeed(req, res, next) {
  try {
  const m = String(req.params.file || '').match(/^([A-Za-z0-9_-]{20,60})\.ics$/);
  const u = m && (await one("SELECT id, name, google_title FROM users WHERE ical_token_hash = ? AND active = 1 AND role IN ('admin','psicologo')", [sha256(m[1])]));
  if (!u) return res.sendStatus(404);
  res.set('Cache-Control', 'private, max-age=900').type('text/calendar; charset=utf-8').send(await G.icsFeed(u));
  } catch (e) { next(e); }
}

// =====================================================================
// Administração: /configuracoes/google
// =====================================================================
export const admin = router();

admin.get('/', async (req, res) => {
  const cfg = await G.config();
  const pros = await q(`SELECT u.id, u.name, u.role, u.active, u.google_email, u.google_connected_at, u.google_error, u.google_refresh_enc IS NOT NULL conectado, u.ical_token_hash IS NOT NULL ical,
    (SELECT COUNT(*) FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE p.owner_id = u.id AND a.starts_at >= NOW() AND a.google_error IS NOT NULL) erros
    FROM users u WHERE u.role IN ('admin','psicologo') AND u.attends = 1 ORDER BY u.active DESC, u.name`);
  const redirect = G.redirectUri(req);
  send(res, page(req, {
    title: 'Google Agenda', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Google Agenda</h1></div><div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <div class="grid2">
      <section class="card"><h2>Credenciais do Google</h2>
        ${cfg ? html`<p><span class="badge b-realizada">Configurada</span> <small class="muted">ID do cliente: ${cfg.clientId.slice(0, 18)}…</small></p>` : html`<p><span class="badge b-agendada">Não configurada</span></p>`}
        <form method="post" action="/configuracoes/google" class="stack">
          <label class="fld"><span>ID do cliente OAuth (Client ID)</span><input name="client_id" required value="${cfg?.clientId || ''}" placeholder="000000000000-xxxx.apps.googleusercontent.com" autocomplete="off"></label>
          <label class="fld"><span>Chave secreta do cliente (Client secret)</span><input type="password" name="client_secret" ${cfg ? '' : raw('required')} placeholder="${cfg ? 'deixe em branco para manter a atual' : 'GOCSPX-…'}" autocomplete="off"></label>
          <div class="actions"><button class="btn">Salvar credenciais</button></div>
        </form>
        <p class="muted small">A chave secreta é guardada criptografada e nunca é exibida novamente.</p>
      </section>
      <section class="card"><h2>Como obter (uma vez, ~10 min)</h2>
        <ol class="bullets small">
          <li>Acesse <b>console.cloud.google.com</b> com a conta Google do consultório e crie um projeto (ex.: “Sistema Lorrainy Mendes”).</li>
          <li>Em <b>APIs e serviços → Biblioteca</b>, ative a <b>Google Calendar API</b>.</li>
          <li>Em <b>Tela de consentimento OAuth</b>: tipo <b>Externo</b>, nome do app “Sistema Lorrainy Mendes”, seu e-mail de suporte. Em escopos, adicione <code>calendar.events</code> e <code>calendar.calendarlist.readonly</code>. Depois clique em <b>Publicar app</b> (status “Em produção”) — no modo teste o acesso expira a cada 7 dias.</li>
          <li>Em <b>Credenciais → Criar credenciais → ID do cliente OAuth</b>: tipo <b>Aplicativo da Web</b>; em “URIs de redirecionamento autorizados” cole exatamente:
            <div class="copy"><input readonly value="${redirect}" id="redir"><button class="btn ghost" type="button" data-copy="#redir">Copiar</button></div></li>
          <li>Copie o <b>ID do cliente</b> e a <b>chave secreta</b> para o formulário ao lado.</li>
        </ol>
        <div class="flash warn small"><b>Apareceu “Erro 400: redirect_uri_mismatch”?</b> O endereço acima não está cadastrado no cliente OAuth. Confira:
          <ul class="bullets small" style="margin-top:6px">
            <li>Foi colado em <b>URIs de redirecionamento autorizados</b> (não em “Origens JavaScript autorizadas”).</li>
            <li>Exatamente igual: com <b>https://</b>, com “sistema.”, sem barra no final e sem espaços.</li>
            <li>É o mesmo cliente cujo ID está salvo aqui (${cfg ? cfg.clientId.slice(0, 18) + '…' : '—'}) e do tipo <b>Aplicativo da Web</b>.</li>
            <li>Depois de salvar no Google, aguarde de 5 a 10 minutos antes de tentar de novo.</li>
          </ul></div>
        <p class="muted small">Ao conectar, o Google pode mostrar “O Google não verificou este app”: clique em <b>Avançado → Acessar Sistema Lorrainy Mendes</b>. Isso é esperado para apps de uso interno (até 100 usuários).</p>
      </section>
    </div>
    <section class="card flush"><h2 class="pad-h">Profissionais</h2>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Profissional</th><th>Google Agenda</th><th>Conta Google</th><th>Link iCal</th><th>Erros</th></tr></thead>
      <tbody>${pros.map((p) => html`<tr class="${p.active ? '' : 'off'}"><td><a href="/usuarios/${p.id}"><b>${p.name}</b></a><small class="muted block">${ROLES[p.role].label}</small></td>
        <td>${p.google_error ? html`<span class="badge b-falta">Reconectar</span>` : p.conectado ? html`<span class="badge b-realizada">Conectada</span>` : html`<span class="badge b-cancelada">Não conectada</span>`}</td>
        <td>${p.google_email || '—'}${p.google_connected_at ? html`<small class="muted block">desde ${brDateTime(p.google_connected_at)}</small>` : ''}</td>
        <td>${p.ical ? 'Ativo' : '—'}</td><td>${p.erros ? html`<span class="err-t">${p.erros}</span>` : '—'}</td></tr>`)}</tbody></table></div>
      <p class="muted small pad-h" style="padding-bottom:18px">Cada profissional conecta a própria conta em <b>Conta → Google Agenda</b>. A administradora não tem acesso às agendas pessoais.</p>
    </section>
    <section class="card"><h2>Privacidade (LGPD)</h2><p class="small">O Google passa a ser operador dos dados enviados: data, horário, duração, modalidade e o identificador escolhido (iniciais por padrão). Nenhuma informação clínica, telefone ou CPF é enviada. Os eventos são marcados como privados.</p></section>
    ${cfg ? html`<form method="post" action="/configuracoes/google/remover" class="danger-zone" data-confirm="Remover as credenciais? Todas as conexões deixam de sincronizar."><button class="btn danger">Remover credenciais</button></form>` : ''}`,
  }));
});

admin.post('/', async (req, res) => {
  const id = str(req.body.client_id, 200);
  const secret = str(req.body.client_secret, 200);
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(id)) return res.flash('O ID do cliente deve terminar em “.apps.googleusercontent.com”.', 'err').redirect('/configuracoes/google');
  if (!secret && !(await G.config())) return res.flash('Informe a chave secreta.', 'err').redirect('/configuracoes/google');
  await G.saveConfig(id, secret || null);
  await audit(req, 'google-credenciais');
  res.flash('Credenciais salvas. Agora cada profissional pode conectar a agenda em Conta.').redirect('/configuracoes/google');
});

admin.post('/remover', async (req, res) => {
  await G.clearConfig();
  await audit(req, 'google-credenciais-remover');
  res.flash('Credenciais removidas.').redirect('/configuracoes/google');
});
