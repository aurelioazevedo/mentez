// Clínica: Configurações → Plano e assinatura (Mentez), aviso de teste/atraso e bloqueio por plano ou por situação.
import { page, html, raw, money, brDate } from '../lib/html.js';
import { router, send, str } from '../lib/router.js';
import { audit, one } from '../lib/db.js';
import { can, isClinician } from '../lib/perm.js';
import * as T from '../lib/tenancy.js';
import * as Billing from '../lib/billing.js';

const PAY = { PENDING: ['agendada', 'Aguardando pagamento'], OVERDUE: ['falta', 'Vencida'], RECEIVED: ['realizada', 'Paga'], CONFIRMED: ['realizada', 'Paga'], RECEIVED_IN_CASH: ['realizada', 'Paga'], REFUNDED: ['cancelada', 'Estornada'] };

// Antes de tudo (com a clínica identificada): situação de acesso e aviso no topo das páginas
export function gate(req, res, next) {
  const t = T.current();
  if (!t) return next();
  const a = Billing.accessOf(t);
  req.access = a;
  if (a.state === 'teste' && a.daysLeft <= 5) req.billing = { tone: 'info', text: a.daysLeft === 0 ? 'Seu teste grátis termina hoje.' : `Seu teste grátis termina em ${a.daysLeft} dia(s).`, cta: 'Escolher um plano' };
  else if (a.state === 'atrasada') req.billing = { tone: 'warn', text: `A mensalidade da Mentez está em aberto. O acesso continua por mais ${a.graceLeft} dia(s).`, cta: 'Ver e pagar' };
  else if (a.state === 'bloqueada') {
    req.billing = { tone: 'err', text: a.reason === 'teste' ? 'O teste grátis terminou. Escolha um plano para continuar — seus dados estão guardados.' : a.reason === 'cancelada' ? 'A assinatura foi cancelada. Assine de novo para voltar a usar — seus dados estão guardados.' : 'A mensalidade está vencida. Regularize para voltar a usar — seus dados estão guardados.', cta: 'Assinar agora' };
    if (!Billing.OPEN_WHEN_BLOCKED.some((r) => r.test(req.path))) {
      if (req.method !== 'GET') return res.status(402).send('Acesso suspenso até a assinatura ser regularizada.');
      return res.redirect('/configuracoes/assinatura');
    }
  }
  next();
}
// Depois do login: recursos que o plano não inclui
export async function features(req, res, next) {
  const t = T.current(); if (!t) return next();
  const hit = Billing.FEATURE_PATHS.find(([r]) => r.test(req.path));
  if (!hit) return next();
  const feats = await Billing.featuresOf(t);
  if (Billing.has(feats, hit[1])) return next();
  const plans = (await Billing.plans()).filter((p) => p.public && Billing.has(p.features, hit[1]));
  res.status(402);
  send(res, page(req, { title: 'Recurso de outro plano', active: '', body: html`<section class="card center-card"><h1>${Billing.FEATURES[hit[1]] || 'Convênios'}</h1>
    <p>Este recurso não está no seu plano atual.${plans.length ? ` Está incluído no plano ${plans.map((p) => p.name).join(' e ')}.` : ''}</p>
    <p class="actions">${can(req.user, 'usuarios') ? html`<a class="btn" href="/configuracoes/assinatura">Ver planos</a>` : html`<span class="muted">Fale com a administração da clínica.</span>`}<a class="btn ghost" href="/">Voltar</a></p></section>` }));
}

export const settings = router();
settings.get('/', async (req, res) => {
  const t = T.current();
  if (!t || !T.multi()) return res.redirect('/configuracoes');
  if (!can(req.user, 'usuarios')) return send(res, page(req, { title: 'Plano e assinatura', body: html`<section class="card center-card"><h1>Plano e assinatura</h1><p>Só a administração da clínica gerencia a assinatura.</p></section>` }));
  const a = Billing.accessOf(t);
  const plans = (await Billing.plans()).filter((p) => p.public);
  const cur = await Billing.planOf(t);
  const row = await T.pone('SELECT * FROM tenants WHERE id = ?', [t.id]);
  const inv = await Billing.invoices(t).catch(() => []);
  const cfg = await Billing.config();
  // provedor desta clínica: o da assinatura existente ou o escolhido pela Mentez para novas assinaturas
  const prov = row.asaas_subscription ? 'asaas' : row.mp_preapproval ? 'mercadopago' : cfg.provider;
  const subscribed = !!(row.asaas_subscription || row.mp_preapproval);
  const pros = Number((await one("SELECT COUNT(*) n FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1")).n);
  const open = inv.find((i) => ['PENDING', 'OVERDUE'].includes(i.status));
  const stLabel = { cortesia: 'Cortesia (sem cobrança)', teste: `Teste grátis · ${a.daysLeft ?? 0} dia(s) restantes`, ativa: 'Assinatura em dia', atrasada: 'Mensalidade em aberto', bloqueada: 'Acesso suspenso' }[a.state];
  send(res, page(req, { title: 'Plano e assinatura', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações · Mentez</p><h1>Plano e assinatura</h1>
      <p class="muted">${stLabel} · plano atual: <b>${cur?.name || '—'}</b>${row.paid_until ? ` · pago até ${brDate(row.paid_until)}` : ''}</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    ${open ? html`<div class="flash ${open.status === 'OVERDUE' ? 'warn' : 'info'}">Mensalidade de ${money(open.value)} com vencimento em ${brDate(open.due)}. ${open.url ? html`<a class="btn btn-sm" href="${open.url}" target="_blank" rel="noopener">Pagar agora (Pix, boleto ou cartão)</a>` : prov === 'mercadopago' ? ' A cobrança é feita automaticamente no cartão cadastrado no Mercado Pago.' : ''}</div>` : ''}
    ${req.query.mp ? html`<div class="flash ok">Pronto! Assim que o Mercado Pago confirmar a autorização, a assinatura aparece aqui.</div>` : ''}
    ${a.state === 'cortesia' ? html`<section class="card"><p>Esta clínica está no plano de cortesia da Mentez, sem cobrança.</p></section>` : html`
    <form method="post" class="stack">
      <section class="plans">${plans.map((p) => html`<label class="plan ${p.key === cur?.key ? 'on' : ''}"><input type="radio" name="plan" value="${p.key}" ${p.key === (cur?.public ? cur.key : 'profissional') ? raw('checked') : ''}>
        <b class="plan-n">${p.name}</b><span class="plan-p">${money(p.price)}<small>/mês</small></span>
        <span class="plan-l">${p.maxPros === 1 ? '1 profissional' : `até ${p.maxPros} profissionais`}${p.extraPro ? ` · ${money(p.extraPro)} por profissional a mais` : ''}</span>
        <ul>${Object.entries(Billing.FEATURES).map(([k, l]) => html`<li class="${p.features.includes(k) ? 'y' : 'n'}">${l}</li>`)}</ul></label>`)}</section>
      <section class="card form-grid">
        <h2 class="span2">Dados para a cobrança</h2>
        <label class="fld"><span>Nome ou razão social</span><input name="payer_name" required maxlength="120" value="${row.owner_name || t.name}"></label>
        <label class="fld"><span>CPF ou CNPJ</span><input name="payer_doc" ${prov === 'asaas' ? raw('required') : ''} maxlength="18" inputmode="numeric" data-mask="doc" placeholder="000.000.000-00"></label>
        <label class="fld"><span>${prov === 'mercadopago' ? 'E-mail da conta do Mercado Pago' : 'E-mail para as faturas'}</span><input type="email" name="email" required maxlength="190" value="${row.owner_email || ''}"></label>
        <label class="fld"><span>Celular</span><input name="phone" maxlength="40" value="${row.owner_phone || ''}" inputmode="tel"></label>
        <p class="span2 muted small">Profissionais que atendem hoje: ${pros}. ${prov === 'mercadopago' ? `A cobrança é mensal e automática pelo Mercado Pago, no cartão de crédito (ou saldo do Mercado Pago). Ao assinar, você vai para o Mercado Pago para autorizar.` : 'A cobrança é mensal, pelo Asaas: você paga por Pix, boleto ou cartão.'} ${a.state === 'teste' ? `A primeira mensalidade ${prov === 'mercadopago' ? 'é cobrada' : 'vence'} quando o teste acabar (${brDate(a.ends)}).` : ''}</p>
        ${Billing.ready(cfg, prov) ? '' : html`<p class="span2 flash warn">A cobrança da Mentez está sendo configurada. Tente de novo mais tarde ou fale com a Mentez.</p>`}
        <div class="span2 actions"><button class="btn" ${Billing.ready(cfg, prov) ? '' : raw('disabled')}>${subscribed ? 'Mudar de plano' : prov === 'mercadopago' ? 'Assinar pelo Mercado Pago' : 'Assinar'}</button></div>
      </section>
    </form>
    ${inv.length ? html`<section class="card flush"><h2 class="pad">Faturas</h2><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Vencimento</th><th>Valor</th><th>Situação</th><th></th></tr></thead><tbody>
      ${inv.map((i) => html`<tr><td>${brDate(i.due)}</td><td>${money(i.value)}</td><td><span class="badge b-${(PAY[i.status] || ['agendada'])[0]}">${(PAY[i.status] || [0, i.status])[1]}</span></td><td>${i.url ? html`<a class="link small" href="${i.url}" target="_blank" rel="noopener">${['PENDING', 'OVERDUE'].includes(i.status) ? 'pagar' : 'ver'}</a>` : ''}</td></tr>`)}</tbody></table></div></section>` : ''}
    ${subscribed ? html`<form method="post" action="/configuracoes/assinatura/cancelar" class="card"><p class="muted small">Cancelar interrompe as próximas cobranças. Os dados ficam guardados e você pode voltar quando quiser; para levar os dados, use a exportação antes.</p><button class="btn ghost danger-text" data-confirm="Cancelar a assinatura da Mentez? O acesso fica suspenso depois do período pago.">Cancelar assinatura</button></form>` : ''}`}` }));
});
settings.post('/', async (req, res) => {
  const t = T.current(); if (!t || !can(req.user, 'usuarios')) return res.redirect('/configuracoes');
  const plan = (await Billing.plans()).find((p) => p.key === req.body.plan);
  if (plan) { // limite de profissionais do plano escolhido
    const pros = Number((await one("SELECT COUNT(*) n FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1")).n);
    if (pros > plan.maxPros + t.extraPros && !plan.extraPro) return res.flash(`O plano ${plan.name} é para ${plan.maxPros} profissional(is) e a clínica tem ${pros} atendendo. Escolha outro plano ou desative profissionais.`, 'err').redirect('/configuracoes/assinatura');
  }
  try {
    const out = await Billing.subscribe(t, { planKey: req.body.plan, payerName: str(req.body.payer_name, 120), payerDoc: req.body.payer_doc, email: str(req.body.email, 190), phone: str(req.body.phone, 40) });
    await audit(req, 'assinatura', `${req.body.plan} ${money(out.value)}`);
    // A política de segurança do sistema não deixa um formulário redirecionar para outro site:
    // mostra uma página com o botão (e o encaminhamento automático) para o checkout do provedor.
    const go = out.checkoutUrl || (out.invoiceUrl && Billing.accessOf(T.current()).state !== 'teste' ? out.invoiceUrl : null);
    if (go && /^https?:\/\//.test(go)) {
      const name = out.provider === 'mercadopago' ? 'Mercado Pago' : 'Asaas';
      return send(res, page(req, { title: `Continuar no ${name}`, active: 'config', body: html`<meta http-equiv="refresh" content="2;url=${go}">
        <section class="card center-card"><h1>Quase lá</h1><p>${out.provider === 'mercadopago' ? 'Autorize a assinatura no Mercado Pago com o cartão que vai pagar as mensalidades.' : 'Pague a primeira mensalidade no Asaas (Pix, boleto ou cartão).'} Vamos abrir a página em instantes.</p>
        <p class="actions"><a class="btn" href="${go}">Continuar no ${name}</a><a class="btn ghost" href="/configuracoes/assinatura">Voltar</a></p></section>` }));
    }
    if (out.provider === 'mercadopago') return res.flash(`Plano atualizado: ${money(out.value)}/mês, cobrado automaticamente pelo Mercado Pago.`).redirect('/configuracoes/assinatura');
    res.flash(`Assinatura registrada: ${money(out.value)}/mês, primeira cobrança em ${brDate(out.nextDue)}. A fatura também chega por e-mail.`).redirect('/configuracoes/assinatura');
  } catch (e) { res.flash(e.message, 'err').redirect('/configuracoes/assinatura'); }
});
settings.post('/cancelar', async (req, res) => {
  const t = T.current(); if (!t || !can(req.user, 'usuarios')) return res.redirect('/configuracoes');
  try { await Billing.cancel(t); await audit(req, 'assinatura-cancelar'); res.flash('Assinatura cancelada.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect('/configuracoes/assinatura');
});

// Limite de profissionais do plano (usado ao criar ou reativar usuários que atendem)
export async function canAddPro() {
  const t = T.current(); if (!t || !T.multi()) return { ok: true };
  const max = await Billing.maxPros(t);
  const n = Number((await one("SELECT COUNT(*) n FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1")).n);
  const plan = await Billing.planOf(t);
  return n < max || plan?.extraPro ? { ok: true, extra: n >= max } : { ok: false, max, n, plan: plan?.name };
}
export { isClinician };
