// Cobrança online (Asaas): webhook público, ações no lançamento e Configurações → Cobrança online.
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDate, brDateTime, money } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { can } from '../lib/perm.js';
import * as G from '../lib/gateway.js';
import * as Fin from '../lib/fin.js';

// Mercado Pago: o aviso traz o número do pagamento; o sistema confere direto no Mercado Pago antes de dar baixa.
export async function webhookMercadoPago(req, res) {
  const c = await G.config();
  if (!G.validToken(c, req.query.t)) return res.status(401).json({ error: 'token' });
  const b = req.body || {};
  const type = b.type || b.topic || req.query.type || req.query.topic;
  const id = b?.data?.id || req.query['data.id'] || req.query.id;
  if (!G.validMpSignature(c, { signature: req.get('x-signature'), requestId: req.get('x-request-id'), dataId: id })) return res.status(401).json({ error: 'assinatura' });
  if (type !== 'payment' || !id) return res.json({ ignored: true });
  try { await G.handleMercadoPago(String(id)); } catch (e) {
    if (e.status === 404) return res.json({ ignored: 'pagamento inexistente' }); // não adianta o Mercado Pago reenviar
    console.error('webhook Mercado Pago:', e.message); return res.status(500).json({ error: 'erro' });
  }
  res.json({ received: true });
}
// O Asaas chama este endereço a cada evento (pagamento, vencimento, estorno…). Responde rápido e processa.
export async function webhook(req, res) {
  const c = await G.config();
  if (!G.validToken(c, req.get('asaas-access-token'))) return res.status(401).json({ error: 'token' });
  try { await G.handleEvent(req.body || {}); } catch (e) { console.error('webhook Asaas:', e.message); return res.status(500).json({ error: 'erro' }); }
  res.json({ received: true });
}

// ---------- ações no lançamento (Financeiro) ----------
export const actions = router();
async function payOf(req) {
  const x = await one('SELECT * FROM payments WHERE id = ?', [int(req.params.id)]);
  if (!x) return null;
  if (!(can(req.user, 'financeiro') || (can(req.user, 'meufin') && x.professional_id === req.user.id))) return null;
  return x;
}
actions.post('/:id/gerar', async (req, res, next) => {
  const x = await payOf(req); if (!x) return next();
  const out = await G.ensureCharge(x.id, { userId: req.user.id });
  await audit(req, 'cobranca-online-gerar', `payment:${x.id}`);
  res.flash(out.ok ? (out.reused ? 'A cobrança online já existia.' : 'Cobrança online criada: envie o link ao paciente (ou use “Cobrar pelo WhatsApp”).') : out.error, out.ok ? 'ok' : 'err').redirect(`/financeiro/${x.id}#cobranca-online`);
});
actions.post('/:id/cancelar', async (req, res, next) => {
  const x = await payOf(req); if (!x) return next();
  const ch = await G.chargeOf(x.id);
  if (ch) await G.cancelCharge(ch, 'cancelada pela equipe');
  await audit(req, 'cobranca-online-cancelar', `payment:${x.id}`);
  res.flash('Cobrança online cancelada.').redirect(`/financeiro/${x.id}#cobranca-online`);
});
// Cartão no lançamento (renderizado pela página do Financeiro)
export async function paymentCard(x) {
  const c = await G.config();
  if (!G.ready(c)) return '';
  const hist = await G.historyOf(x.id);
  const cur = hist.find((h) => ['PENDING', 'OVERDUE', 'AWAITING_RISK_ANALYSIS'].includes(h.status));
  const paid = hist.find((h) => ['RECEIVED', 'CONFIRMED'].includes(h.status));
  const svc = G.providerLabel(cur?.provider || hist[0]?.provider || c.provider);
  return html`<section class="card" id="cobranca-online"><h2>Cobrança online (${svc})</h2>
    ${paid ? html`<p class="flash ok">Pago pelo ${G.providerLabel(paid.provider)} em ${brDate(paid.paid_date)}${paid.billing_type ? ` · ${paid.billing_type.toLowerCase().replace('credit_card', 'cartão')}` : ''}${paid.net_value ? ` · líquido ${money(paid.net_value)}` : ''}.</p>` : ''}
    ${cur ? html`<p><span class="badge b-agendada">${G.STATUS_LABEL[cur.status] || cur.status}</span> ${money(cur.amount)} · vence ${brDate(cur.due_date)}</p>
      <div class="gw-link"><input id="gw-url" readonly value="${cur.invoice_url || ''}" aria-label="Link de pagamento"><button type="button" class="btn ghost" data-copy="#gw-url">Copiar link</button><a class="btn ghost" href="${cur.invoice_url}" target="_blank" rel="noopener">Abrir</a></div>
      <p class="muted small">O paciente paga por Pix, boleto ou cartão nesse link; a baixa aqui é automática. “Cobrar pelo WhatsApp” já envia o link e o Pix desta cobrança.</p>
      <form method="post" action="/financeiro/cobranca-online/${x.id}/cancelar" class="inline"><button class="btn ghost danger-text" data-confirm="Cancelar a cobrança no ${svc}? O link deixa de funcionar.">Cancelar cobrança online</button></form>`
    : !x.paid_at && G.eligible(x) ? html`<p class="muted small">Gera um link de pagamento (Pix, boleto ou cartão) com baixa automática quando o paciente pagar.</p><form method="post" action="/financeiro/cobranca-online/${x.id}/gerar" class="inline"><button class="btn">Gerar cobrança online</button></form>`
      : x.receiver === 'profissional' && !x.paid_at ? html`<p class="muted small">Recebimento direto do profissional: a cobrança online é só para valores da clínica.</p>` : ''}
    ${hist.length ? html`<details><summary class="small muted">Histórico da cobrança online</summary><ul class="list">${hist.map((h) => html`<li><span>${brDateTime(h.created_at)} · ${money(h.amount)} · ${G.STATUS_LABEL[h.status] || h.status}${h.error ? html` <small class="muted">(${h.error})</small>` : ''}</span></li>`)}</ul></details>` : ''}
  </section>`;
}

// ---------- Configurações → Cobrança online ----------
export const settings = router();
const pubUrl = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
settings.get('/', async (req, res) => {
  const c = await G.config();
  const st = await G.stats();
  const chk = (v) => (v ? raw('checked') : '');
  const sel = (a, b) => (String(a) === String(b) ? raw('selected') : '');
  send(res, page(req, { title: 'Cobrança online', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Cobrança online</h1>
      <p class="muted">Boleto, Pix e cartão pelo Asaas ou pelo Mercado Pago, com baixa automática no Financeiro quando o paciente paga. Vale para os recebimentos da clínica.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <label class="fld check"><input type="checkbox" name="enabled" value="1" ${chk(c.enabled)}><span><b>Ligar a cobrança online</b></span></label>
      <fieldset class="rt-units" data-gw-provider><legend>Serviço de pagamento</legend>
        <label class="maint-g"><input type="radio" name="provider" value="asaas" ${chk(c.provider === 'asaas')}><span><b>Asaas</b><small>boleto, Pix e cartão; multa e juros; também emite NFS-e</small></span></label>
        <label class="maint-g"><input type="radio" name="provider" value="mercadopago" ${chk(c.provider === 'mercadopago')}><span><b>Mercado Pago</b><small>Pix, cartão (parcelado) e boleto; checkout conhecido pelos pacientes</small></span></label>
      </fieldset>
      <div class="form-grid">
        <label class="fld"><span>Ambiente</span><select name="env"><option value="sandbox" ${sel(c.env, 'sandbox')}>Testes (sandbox) — nada é cobrado</option><option value="producao" ${sel(c.env, 'producao')}>Produção — cobranças reais</option></select></label>
        <label class="fld" data-gw-only="asaas"><span>Chave de API do Asaas ${c.key ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : ''}</span><input type="password" name="key" autocomplete="off" maxlength="300" placeholder="$aact_…"></label>
        <label class="fld" data-gw-only="mercadopago"><span>Access Token do Mercado Pago ${c.mpKey ? html`<small class="muted">(cadastrado — preencha só para trocar)</small>` : ''}</span><input type="password" name="mpKey" autocomplete="off" maxlength="300" placeholder="APP_USR-…"></label>
        <label class="fld" data-gw-only="mercadopago"><span>Assinatura secreta dos avisos <small class="muted">(opcional, recomendada)</small> ${c.mpSecret ? html`<small class="muted">· cadastrada</small>` : ''}</span><input type="password" name="mpSecret" autocomplete="off" maxlength="200" placeholder="Suas integrações → Webhooks → Assinatura secreta"></label>
        <label class="fld"><span>Formas de pagamento</span><select name="billing">${Object.entries(G.BILLING).map(([k, l]) => html`<option value="${k}" ${sel(c.billing, k)}>${l}</option>`)}</select></label>
        <label class="fld"><span>Gerar a cobrança automaticamente</span><select name="autoDays"><option value="0" ${sel(c.autoDays, 0)}>Não — só quando eu gerar, cobrar pelo WhatsApp ou o paciente pagar pelo portal</option>${[1, 3, 5, 7, 10].map((d) => html`<option value="${d}" ${sel(c.autoDays, d)}>${d} dia(s) antes do vencimento</option>`)}</select></label>
        <label class="fld" data-gw-only="asaas"><span>Multa por atraso (%)</span><input name="fine" inputmode="decimal" value="${String(c.fine).replace('.', ',')}" placeholder="0"><small class="muted">máximo 2%</small></label>
        <label class="fld" data-gw-only="asaas"><span>Juros ao mês (%)</span><input name="interest" inputmode="decimal" value="${String(c.interest).replace('.', ',')}" placeholder="0"><small class="muted">máximo 1% ao mês</small></label>
      </div>
      <label class="fld check"><input type="checkbox" name="confirmWhatsApp" value="1" ${chk(c.confirmWhatsApp)}><span>Ao receber, enviar ao paciente a confirmação de pagamento pelo WhatsApp</span></label>
      <label class="fld check" data-gw-only="asaas"><input type="checkbox" name="gatewayEmails" value="1" ${chk(c.gatewayEmails)}><span>Deixar o Asaas também enviar e-mails de cobrança ao paciente</span></label>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>
    ${c.provider === 'mercadopago' && c.mpKey ? html`<section class="card stack"><h2>Conexão e aviso de pagamentos</h2>
      <p class="small">✓ O aviso de pagamentos é automático: cada cobrança informa ao Mercado Pago o endereço <code>${pubUrl(req)}/webhooks/cobranca/mercadopago</code>. Ao receber o aviso, o sistema confere o pagamento direto no Mercado Pago antes de dar baixa.</p>
      <div class="actions"><form method="post" action="/configuracoes/cobranca/testar" class="inline"><button class="btn ghost">Testar conexão</button></form></div>
      <p class="muted small">Neste mês: ${Number(st?.paid_month || 0)} cobrança(s) paga(s) online (${money(st?.paid_value || 0)}) · ${Number(st?.open || 0)} aguardando pagamento.</p>
    </section>` : ''}
    ${c.provider === 'asaas' && c.key ? html`<section class="card stack"><h2>Conexão e aviso de pagamentos</h2>
      <p class="small">Endereço que o Asaas chama a cada pagamento (webhook): <code>${pubUrl(req)}/webhooks/cobranca/asaas</code> · token de autenticação: <code>${c.token}</code></p>
      <p class="small">${c.webhookAt ? html`✓ Aviso de pagamentos registrado no Asaas em ${brDateTime(c.webhookAt.slice(0, 19).replace('T', ' '))}.` : html`<b>Falta registrar o aviso de pagamentos</b> — sem ele a baixa não é automática.`}</p>
      <div class="actions"><form method="post" action="/configuracoes/cobranca/testar" class="inline"><button class="btn ghost">Testar conexão</button></form>
        <form method="post" action="/configuracoes/cobranca/webhook" class="inline"><button class="btn ghost">${c.webhookAt ? 'Registrar de novo' : 'Registrar o aviso de pagamentos no Asaas'}</button></form></div>
      <p class="muted small">Se o registro automático falhar, cadastre no painel do Asaas (Integrações → Webhooks) o endereço e o token acima, com os eventos de cobrança.</p>
      <p class="muted small">Neste mês: ${Number(st?.paid_month || 0)} cobrança(s) paga(s) online (${money(st?.paid_value || 0)}) · ${Number(st?.open || 0)} aguardando pagamento.</p>
    </section>` : ''}
    <details class="card tv-tips"><summary>Como criar a conta e o Access Token no Mercado Pago</summary><ul>
      <li>Entre na conta Mercado Pago da clínica e abra <b>Suas integrações</b> (mercadopago.com.br/developers) → <b>Criar aplicação</b> (pagamentos on-line, Checkout Pro).</li>
      <li>Em <b>Credenciais de produção</b>, copie o <b>Access Token</b> (começa com <code>APP_USR-</code>) e cole acima. Para testar, use as credenciais de teste.</li>
      <li>Opcional e recomendado: em <b>Webhooks</b>, gere a <b>assinatura secreta</b> e cole no campo acima.</li>
      <li>Para receber Pix pelo Mercado Pago, a conta precisa ter uma chave Pix cadastrada no próprio Mercado Pago.</li>
      <li>CPF não é obrigatório. As taxas são as do seu plano no Mercado Pago; o valor líquido aparece no lançamento.</li>
    </ul></details>
    <details class="card tv-tips"><summary>Como criar a conta e a chave no Asaas</summary><ul>
      <li>Crie a conta da clínica em asaas.com (para testar sem cobrar ninguém, use sandbox.asaas.com).</li>
      <li>No Asaas: <b>Integrações → Chaves de API → Gerar chave</b>. Copie a chave (começa com <code>$aact_</code>) e cole acima.</li>
      <li>Salve, clique em <b>Testar conexão</b> e depois em <b>Registrar o aviso de pagamentos</b>.</li>
      <li>O paciente precisa ter CPF na ficha (ou o responsável financeiro). No portal, quem não tiver CPF informa na hora de pagar.</li>
      <li>As taxas são as do seu plano no Asaas; o valor líquido aparece no lançamento depois do pagamento.</li>
    </ul></details>` }));
});
settings.post('/', async (req, res) => {
  const cur = await G.config();
  const bad = G.checkInput(req.body, cur);
  if (bad) return res.flash(bad, 'err').redirect('/configuracoes/cobranca');
  await G.saveConfig(req.body, cur, pubUrl(req));
  await audit(req, 'cobranca-online-config');
  res.flash('Cobrança online salva.').redirect('/configuracoes/cobranca');
});
settings.post('/testar', async (req, res) => {
  try { const r = await G.testConnection(await G.config()); res.flash(`Conexão com o Asaas funcionando (${r.name}).`); } catch (e) { res.flash(`Não foi possível conectar: ${e.message}`, 'err'); }
  res.redirect('/configuracoes/cobranca');
});
settings.post('/webhook', async (req, res) => {
  try {
    const c = await G.config(); const clinic = await Fin.clinic();
    await G.registerWebhook(c, pubUrl(req), clinic.email);
    await audit(req, 'cobranca-online-webhook');
    res.flash('Aviso de pagamentos registrado no Asaas: a baixa passa a ser automática.');
  } catch (e) { res.flash(`Não foi possível registrar: ${e.message}. Cadastre manualmente no painel do Asaas.`, 'err'); }
  res.redirect('/configuracoes/cobranca');
});
