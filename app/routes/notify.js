// Lembretes por e-mail e SMS: Configurações, link público de confirmação e envio manual na sessão.
import * as Brand from '../lib/brand.js';
import { q, one, audit } from '../lib/db.js';
import { page, bare, html, raw, brDate, brDateTime, weekday, logoTag } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import * as N from '../lib/notify.js';
import * as WA from '../lib/whatsapp.js';
import * as Fin from '../lib/fin.js';
import { notify as push } from '../lib/push.js';
import * as Live from '../lib/live.js';

// ---------- Configurações → Lembretes por e-mail e SMS ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const c = await N.config();
  const st = await N.stats();
  const rec = await N.recent(10);
  const chk = (v) => (v ? raw('checked') : '');
  const sel = (a, b) => (String(a) === String(b) ? raw('selected') : '');
  const t = c.templates;
  send(res, page(req, { title: 'Lembretes por e-mail e SMS', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Lembretes por e-mail e SMS</h1>
      <p class="muted">Além do WhatsApp, o paciente recebe o lembrete da sessão por e-mail e/ou SMS, com um link para confirmar a presença ou pedir para remarcar. A confirmação aparece na agenda como no WhatsApp.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <h2>Quando enviar</h2>
      <fieldset class="rt-units"><legend>Envio</legend>${Object.entries(N.MODES).map(([k, l]) => html`<label class="maint-g"><input type="radio" name="mode" value="${k}" ${chk(c.mode === k)}><span><b>${k === 'sempre' ? 'Sempre' : 'Só como reserva'}</b><small>${l}</small></span></label>`)}</fieldset>
      <p class="muted small">Os envios automáticos acontecem entre 7h e 21h. Cada paciente pode recusar e-mail ou SMS na ficha (Editar → lembretes).</p>

      <h2>E-mail</h2>
      <label class="fld check"><input type="checkbox" name="emailOn" value="1" ${chk(c.emailOn)}><span><b>Enviar lembretes por e-mail</b></span></label>
      <div class="form-grid">
        <label class="fld"><span>Antecedência</span><select name="emailHours">${[12, 24, 36, 48, 72].map((h) => html`<option value="${h}" ${sel(c.emailHours, h)}>${h} horas antes</option>`)}</select></label>
        <label class="fld"><span>E-mail remetente</span><input name="fromEmail" type="email" value="${c.fromEmail}" maxlength="190" placeholder="${Brand.get().email || 'contato@suaclinica.com.br'}"></label>
        <label class="fld"><span>Nome do remetente</span><input name="fromName" value="${c.fromName}" maxlength="80" placeholder="${Brand.get().name}"></label>
        <label class="fld"><span>Responder para <small class="muted">(opcional)</small></span><input name="replyTo" type="email" value="${c.replyTo}" maxlength="190"></label>
        <label class="fld"><span>Servidor SMTP</span><input name="smtpHost" value="${c.smtpHost}" maxlength="120" placeholder="smtp.hostinger.com"></label>
        <label class="fld"><span>Porta</span><input name="smtpPort" inputmode="numeric" value="${c.smtpPort}" maxlength="5"></label>
        <label class="fld"><span>Segurança</span><select name="smtpSecure">${Object.entries(N.SECURE).map(([k, l]) => html`<option value="${k}" ${sel(c.smtpSecure, k)}>${l}</option>`)}</select></label>
        <label class="fld"><span>Usuário <small class="muted">(normalmente o próprio e-mail)</small></span><input name="smtpUser" value="${c.smtpUser}" maxlength="190" autocomplete="off"></label>
        <label class="fld"><span>Senha do e-mail ${c.smtpPass ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : ''}</span><input name="smtpPass" type="password" maxlength="200" autocomplete="new-password"></label>
      </div>
      <label class="fld"><span>Assunto</span><input name="emailSubject" value="${t.emailSubject}" maxlength="160"></label>
      <label class="fld"><span>Texto do e-mail</span><textarea name="emailBody" rows="7" maxlength="3000">${t.emailBody}</textarea></label>

      <h2>SMS</h2>
      <label class="fld check"><input type="checkbox" name="smsOn" value="1" ${chk(c.smsOn)}><span><b>Enviar lembretes por SMS</b> <small class="muted">(cobrado por mensagem pelo serviço escolhido)</small></span></label>
      <fieldset class="rt-units" data-sms-provider><legend>Serviço de SMS</legend>
        <label class="maint-g"><input type="radio" name="smsProvider" value="zenvia" ${chk(c.smsProvider === 'zenvia')}><span><b>Zenvia</b><small>brasileira; cobrança em reais</small></span></label>
        <label class="maint-g"><input type="radio" name="smsProvider" value="twilio" ${chk(c.smsProvider === 'twilio')}><span><b>Twilio</b><small>internacional; cobrança em dólar</small></span></label>
      </fieldset>
      <div class="form-grid">
        <label class="fld"><span>Antecedência</span><select name="smsHours">${[1, 2, 3, 4, 6, 12, 24].map((h) => html`<option value="${h}" ${sel(c.smsHours, h)}>${h} hora(s) antes</option>`)}</select></label>
        <label class="fld" data-sms-only="zenvia"><span>Token da API Zenvia ${c.zenviaToken ? html`<small class="muted">(cadastrado — preencha só para trocar)</small>` : ''}</span><input name="zenviaToken" type="password" maxlength="300" autocomplete="off"></label>
        <label class="fld" data-sms-only="zenvia"><span>Remetente Zenvia <small class="muted">(identificador da conta SMS)</small></span><input name="zenviaFrom" value="${c.zenviaFrom}" maxlength="60" placeholder="ex.: suaclinica"></label>
        <label class="fld" data-sms-only="twilio"><span>Account SID</span><input name="twilioSid" value="${c.twilioSid}" maxlength="64" autocomplete="off" placeholder="AC…"></label>
        <label class="fld" data-sms-only="twilio"><span>Auth Token ${c.twilioToken ? html`<small class="muted">(cadastrado — preencha só para trocar)</small>` : ''}</span><input name="twilioToken" type="password" maxlength="200" autocomplete="off"></label>
        <label class="fld" data-sms-only="twilio"><span>Número remetente Twilio</span><input name="twilioFrom" value="${c.twilioFrom}" maxlength="30" placeholder="+1…"></label>
      </div>
      <label class="fld"><span>Texto do SMS <small class="muted">(sem acentos ao enviar, para caber em 1 mensagem de 160 caracteres)</small></span><textarea name="sms" rows="3" maxlength="300" data-sms-count>${t.sms}</textarea><small class="muted" data-sms-len></small></label>
      <p class="muted small">Variáveis: {nome}, {quando}, {data}, {data_curta} (dia/mês), {hora}, {dia_semana}, {modalidade}, {profissional}, {link} (link da chamada on-line), {confirmar} (link para confirmar ou remarcar), {clinica}.</p>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>
    <section class="card stack"><h2>Testar</h2>
      <form method="post" action="/configuracoes/lembretes/testar-email" class="inline-form"><input name="to" type="email" placeholder="seu@email.com" required aria-label="E-mail para teste"><button class="btn ghost">Enviar e-mail de teste</button></form>
      <form method="post" action="/configuracoes/lembretes/testar-sms" class="inline-form"><input name="to" inputmode="tel" placeholder="(62) 9 0000-0000" required aria-label="Celular para teste"><button class="btn ghost">Enviar SMS de teste</button></form>
      <p class="muted small">Últimos 30 dias: ${Number(st?.email || 0)} lembrete(s) por e-mail · ${Number(st?.sms || 0)} por SMS${Number(st?.erros || 0) ? html` · <b>${Number(st.erros)} com erro</b>` : ''}.</p>
      ${rec.length ? html`<table class="tbl small"><thead><tr><th>Quando</th><th>Canal</th><th>Para</th><th>Situação</th></tr></thead><tbody>${rec.map((r) => html`<tr><td>${brDateTime(r.created_at)}</td><td>${r.channel === 'email' ? 'E-mail' : 'SMS'}${r.kind === 'teste' ? ' (teste)' : ''}</td><td>${r.name ? (r.social_name || r.name) : r.dest}</td><td>${r.status === 'enviado' ? '✓ enviado' : html`<span class="err-txt">erro: ${r.error}</span>`}</td></tr>`)}</tbody></table>` : ''}
    </section>
    <details class="card tv-tips"><summary>Como configurar o e-mail da clínica (Hostinger)</summary><ul>
      <li>Use uma caixa de e-mail do domínio, por exemplo <b>contato@suaclinica.com.br</b> (hPanel → E-mails → Contas de e-mail).</li>
      <li>Servidor <b>smtp.hostinger.com</b>, porta <b>465</b>, segurança <b>SSL</b>. Usuário é o próprio e-mail e a senha é a da caixa.</li>
      <li>Salve e clique em <b>Enviar e-mail de teste</b>. Se cair no spam, marque como “não é spam” e confira no hPanel se o domínio tem SPF e DKIM ativos.</li>
    </ul></details>
    <details class="card tv-tips"><summary>Como contratar o SMS</summary><ul>
      <li><b>Zenvia</b> (zenvia.com): crie a conta, ative o canal SMS, gere um <b>token de API</b> (Console → Desenvolvedores → Tokens) e copie o identificador do remetente.</li>
      <li><b>Twilio</b> (twilio.com): copie o <b>Account SID</b> e o <b>Auth Token</b> do painel e compre um número com SMS.</li>
      <li>Cada SMS é cobrado pelo serviço. Para economizar, use o modo <b>Só como reserva</b>: o SMS sai só para quem o WhatsApp não alcança.</li>
    </ul></details>` }));
});
settings.post('/', async (req, res) => {
  const bad = N.checkInput(req.body);
  if (bad) return res.flash(bad, 'err').redirect('/configuracoes/lembretes');
  await N.saveConfig(req.body, await N.config());
  await audit(req, 'lembretes-email-sms-config');
  const c = await N.config();
  res.flash(`Lembretes salvos: e-mail ${N.emailReady(c) ? 'ligado' : 'desligado'} · SMS ${N.smsReady(c) ? 'ligado' : c.smsOn ? 'faltam as credenciais' : 'desligado'}.`).redirect('/configuracoes/lembretes');
});
settings.post('/testar-email', async (req, res) => {
  const r = await N.testEmail(str(req.body.to, 190));
  res.flash(r.ok ? 'E-mail de teste enviado. Confira a caixa de entrada (e o spam).' : `Não enviado: ${r.error}`, r.ok ? 'ok' : 'err').redirect('/configuracoes/lembretes');
});
settings.post('/testar-sms', async (req, res) => {
  const r = await N.testSms(str(req.body.to, 40));
  res.flash(r.ok ? 'SMS de teste enviado.' : `Não enviado: ${r.error}`, r.ok ? 'ok' : 'err').redirect('/configuracoes/lembretes');
});

// ---------- cartão na página da sessão (Agenda) ----------
// Cartão na página da sessão
export async function apptCard(a) {
  const c = await N.config();
  if (!N.emailReady(c) && !N.smsReady(c)) return '';
  const hist = await N.historyOf(a.id);
  const lastOf = (ch) => hist.find((h) => h.channel === ch && h.kind === 'lembrete');
  const line = (ch, label, at) => {
    const l = lastOf(ch);
    if (String(at || '').startsWith('1970')) return html`<li>${label}: não precisou (o WhatsApp entregou)</li>`;
    if (l?.status === 'erro') return html`<li>${label}: <span class="err-txt">não enviado — ${l.error}</span></li>`;
    if (at && l) return html`<li>${label}: ✓ enviado em ${brDateTime(l.created_at)} para ${l.dest}</li>`;
    return html`<li>${label}: ainda não enviado</li>`;
  };
  const open = ['agendada', 'confirmada'].includes(a.status);
  return html`<section class="card" id="lembretes-email-sms"><h2>E-mail e SMS</h2>
    <ul class="plain small">${N.emailReady(c) ? line('email', 'E-mail', a.email_reminder_at) : ''}${N.smsReady(c) ? line('sms', 'SMS', a.sms_reminder_at) : ''}</ul>
    ${a.reply_channel === 'link' && a.wa_reply ? html`<p class="small">${a.wa_reply === 'confirmou' ? '✓ Confirmou' : '↻ Pediu para remarcar'} pelo link do lembrete${a.wa_reply_at ? ` em ${brDateTime(a.wa_reply_at)}` : ''}.</p>` : ''}
    ${open ? html`<div class="actions">${N.emailReady(c) ? html`<form method="post" action="/agenda/${a.id}/lembrete-email"><button class="btn ghost">${a.email_reminder_at ? 'Reenviar por e-mail' : 'Enviar lembrete por e-mail'}</button></form>` : ''}
      ${N.smsReady(c) ? html`<form method="post" action="/agenda/${a.id}/lembrete-sms"><button class="btn ghost">${a.sms_reminder_at ? 'Reenviar por SMS' : 'Enviar lembrete por SMS'}</button></form>` : ''}</div>` : ''}
  </section>`;
}

// ---------- link público: confirmar ou remarcar ----------
export const publicLink = router();
const APPT = 'SELECT a.*, p.name, p.social_name, p.owner_id, p.phone FROM appointments a JOIN patients p ON p.id = a.patient_id WHERE a.id = ?';
async function view(req, res, a, msg = null) {
  const clinic = await Fin.clinic();
  const future = new Date(`${String(a.starts_at).replace(' ', 'T')}-03:00`) > new Date();
  const open = ['agendada', 'confirmada'].includes(a.status) && future;
  const v = await WA.apptVars(a);
  const wa = clinic.phone ? `https://wa.me/55${String(clinic.phone).replace(/\D/g, '').replace(/^55/, '')}` : null;
  const ask = req.query.remarcar === '1' && open && a.wa_reply !== 'remarcar';
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  send(res, bare('Sua sessão', html`<main class="legal remind-pub">
    ${logoTag('legal-logo-img', 150)}
    <h1>Olá, ${v.nome}!</h1>
    <section class="card remind-when"><p class="eyebrow">Sua sessão ${v.modalidade}</p><p class="remind-dt">${(([w]) => w.charAt(0).toUpperCase() + w.slice(1))([weekday(a.starts_at.slice(0, 10))])}, ${brDate(a.starts_at).slice(0, 5)} às ${v.hora}</p><p class="muted">com ${v.profissional}</p></section>
    ${msg ? html`<div class="flash ${msg.kind}">${msg.text}</div>` : ''}
    ${!open ? html`<div class="flash warn">${a.status === 'cancelada' ? 'Esta sessão foi cancelada.' : future ? 'Esta sessão não está mais agendada.' : 'Esta sessão já passou.'} Em caso de dúvida, fale com a equipe.</div>`
    : a.status === 'confirmada' && !ask && !msg ? html`<div class="flash ok">✓ Presença confirmada. Até lá!</div>`
    : a.wa_reply === 'remarcar' && !a.wa_reschedule_done && !msg ? html`<div class="flash warn">↻ Você pediu para remarcar. A equipe vai entrar em contato com novas opções de horário.</div>` : ''}
    ${open && !msg ? html`<form method="post" class="actions remind-actions">
      ${a.status !== 'confirmada' && !ask ? html`<button class="btn" name="acao" value="confirmar">Confirmar presença</button>` : ''}
      ${a.wa_reply !== 'remarcar' ? html`<button class="btn ${ask ? '' : 'ghost'}" name="acao" value="remarcar">Preciso remarcar</button>` : ''}
      ${ask && a.status !== 'confirmada' ? html`<button class="btn ghost" name="acao" value="confirmar">Na verdade, vou comparecer</button>` : ''}
    </form>` : ''}
    <p class="muted small">Dúvidas: ${wa ? html`<a href="${wa}" target="_blank" rel="noopener">WhatsApp ${clinic.phone}</a>` : ''} · <a href="/paciente">Portal do paciente</a></p>
  </main>`, 'bare legal-page', req));
}
publicLink.get('/:tok', async (req, res) => {
  const id = N.idOfToken(req.params.tok);
  const a = id ? await one(APPT, [id]) : null;
  if (!a) return res.status(404).send(String(bare('Link inválido', html`<main class="legal"><h1>Link inválido</h1><p>Este link de lembrete não existe. Fale com a equipe do consultório.</p></main>`, 'bare legal-page', req)));
  await view(req, res, a);
});
publicLink.post('/:tok', async (req, res) => {
  const id = N.idOfToken(req.params.tok);
  let a = id ? await one(APPT, [id]) : null;
  if (!a) return res.status(404).send('Link inválido');
  const future = new Date(`${String(a.starts_at).replace(' ', 'T')}-03:00`) > new Date();
  if (!['agendada', 'confirmada'].includes(a.status) || !future) return view(req, res, a);
  const when = `${weekday(a.starts_at.slice(0, 10))} ${brDate(a.starts_at).slice(0, 5)} às ${a.starts_at.slice(11, 16)}`;
  const nome = WA.firstName(a);
  let msg;
  if (req.body.acao === 'confirmar') {
    await q("UPDATE appointments SET status = 'confirmada', wa_reply = 'confirmou', wa_reply_at = NOW(), reply_channel = 'link' WHERE id = ?", [a.id]);
    push(a.owner_id, { title: '✓ Sessão confirmada pelo link do lembrete', body: `${nome} — ${when}`, url: `/agenda/${a.id}`, tag: `appt-${a.id}` });
    msg = { kind: 'ok', text: '✓ Presença confirmada. Obrigado e até lá!' };
  } else if (req.body.acao === 'remarcar') {
    await q("UPDATE appointments SET wa_reply = 'remarcar', wa_reply_at = NOW(), wa_reschedule_done = 0, reply_channel = 'link' WHERE id = ?", [a.id]);
    push(a.owner_id, { title: '↻ Pedido de remarcação (link do lembrete)', body: `${nome} pediu para remarcar a sessão de ${when}`, url: `/agenda/${a.id}`, tag: `appt-${a.id}` });
    msg = { kind: 'warn', text: 'Recebemos seu pedido. A equipe vai entrar em contato com novas opções de horário. Se preferir, chame no WhatsApp.' };
  } else return view(req, res, a);
  Live.emit('agenda');
  a = await one(APPT, [a.id]);
  await view(req, res, a, msg);
});
