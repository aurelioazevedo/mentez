// Clínica: Configurações → Indique e ganhe. Link de indicação, compartilhamento (WhatsApp e redes sociais),
// progresso nas faixas de desconto e a lista das clínicas indicadas.
import { page, html, raw, money, brDate } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import { can } from '../lib/perm.js';
import * as T from '../lib/tenancy.js';
import * as Billing from '../lib/billing.js';
import * as Referral from '../lib/referral.js';

const enc = encodeURIComponent;
const SVG = {
  whatsapp: '<path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2c-1.5 0-3-.4-4.3-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.2 2.2 2.2 0 0 0 .1-1.3c0-.1-.2-.2-.4-.3z" fill="currentColor" stroke="none"/>',
  facebook: '<path d="M14 8h3V4h-3a4 4 0 0 0-4 4v2H8v4h2v8h4v-8h3l1-4h-4V8.5a.5.5 0 0 1 .5-.5z" fill="currentColor" stroke="none"/>',
  linkedin: '<path d="M4 9h4v11H4zM6 3.5A2.2 2.2 0 1 1 6 8a2.2 2.2 0 0 1 0-4.5zM10 9h3.8v1.6A4.2 4.2 0 0 1 17.6 8.8C21 8.8 21 11.6 21 14v6h-4v-5.3c0-1.3 0-2.9-1.8-2.9s-2.1 1.4-2.1 2.8V20H10z" fill="currentColor" stroke="none"/>',
  x: '<path d="M17.5 3h3l-6.6 7.6L21.7 21h-6l-4.7-6.2L5.5 21h-3l7.1-8.1L2.3 3h6.1l4.3 5.7zm-1 16.2h1.7L7.6 4.7H5.8z" fill="currentColor" stroke="none"/>',
  telegram: '<path d="M21.5 3.6 2.9 10.8c-1.3.5-1.3 1.2-.2 1.6l4.8 1.5 1.8 5.6c.2.6.4.8.9.8s.6-.2.9-.5l2.3-2.2 4.8 3.5c.9.5 1.5.2 1.7-.8l3.1-14.7c.3-1.3-.5-1.9-1.5-1.5zM9.8 14.2l8.6-7.7c.4-.3-.1-.5-.6-.2L7.9 13z" fill="currentColor" stroke="none"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
  share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.4M8.2 13.2l7.6 4.4"/>',
};
const ico = (k) => raw(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SVG[k]}</svg>`);

export const referralSettings = router();
referralSettings.get('/', async (req, res) => {
  const t = T.current();
  if (!t || !T.multi()) return res.redirect('/configuracoes');
  if (!can(req.user, 'usuarios')) return send(res, page(req, { title: 'Indique e ganhe', body: html`<section class="card center-card"><h1>Indique e ganhe</h1><p>Só a administração da clínica acessa as indicações.</p></section>` }));
  const s = await Referral.summary(t);
  const c = s.config;
  if (!c.enabled) return send(res, page(req, { title: 'Indique e ganhe', active: 'config', body: html`<section class="card center-card"><h1>Indique e ganhe</h1><p>O programa de indicação da Mentez está pausado no momento.</p><p><a class="btn ghost" href="/configuracoes">Voltar</a></p></section>` }));
  const code = await Referral.codeOf(t);
  const link = Referral.shareUrl(code);
  const text = Referral.fill(c.message, { link, days: c.bonusDays });
  const textNoLink = Referral.fill(c.message, { link: '', days: c.bonusDays }).replace(/[\s:]+$/, '');
  const cur = await Billing.planOf(t); const row = await T.pone('SELECT * FROM tenants WHERE id = ?', [t.id]);
  const full = cur ? Billing.monthly(cur, row.extra_pros) : 0;
  // faixas em espaços iguais; a barra avança proporcionalmente entre uma faixa e a próxima
  const N = c.tiers.length; const pos = (i) => (N > 1 ? Math.round((i / (N - 1)) * 1000) / 10 : 50);
  let fill = 0;
  for (let i = 0; i < N; i++) {
    if (s.paying >= c.tiers[i][0]) fill = pos(i);
    else { if (i > 0) fill = pos(i - 1) + (pos(i) - pos(i - 1)) * ((s.paying - c.tiers[i - 1][0]) / (c.tiers[i][0] - c.tiers[i - 1][0])); break; }
  }
  const share = [
    ['whatsapp', 'WhatsApp', `https://wa.me/?text=${enc(text)}`],
    ['facebook', 'Facebook', `https://www.facebook.com/sharer/sharer.php?u=${enc(link)}`],
    ['linkedin', 'LinkedIn', `https://www.linkedin.com/sharing/share-offsite/?url=${enc(link)}`],
    ['x', 'X', `https://twitter.com/intent/tweet?text=${enc(textNoLink)}&url=${enc(link)}`],
    ['telegram', 'Telegram', `https://t.me/share/url?url=${enc(link)}&text=${enc(textNoLink)}`],
    ['mail', 'E-mail', `mailto:?subject=${enc('Conheça a Mentez')}&body=${enc(text)}`],
  ];
  send(res, page(req, { title: 'Indique e ganhe', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações · Mentez</p><h1>Indique e ganhe</h1>
      ${row.billing_status === 'cortesia' ? html`<p class="flash info">Sua clínica está no plano de cortesia, sem mensalidade: o desconto passa a valer se a clínica assinar um plano.</p>` : ''}
      <p class="muted">Indique a Mentez para colegas. Quem chega pelo seu link ganha ${c.bonusDays} dias a mais de teste grátis, e você ganha desconto na mensalidade enquanto as clínicas indicadas forem assinantes.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <section class="ref-hero card">
      <div class="ref-now"><span class="ref-pct">${s.pct}%</span><span>de desconto na mensalidade</span>
        <small class="muted">${s.paying === 0 ? 'Nenhuma clínica indicada assinou ainda.' : s.paying === 1 ? '1 clínica indicada é assinante.' : `${s.paying} clínicas indicadas são assinantes.`}
        ${cur && s.pct && full > 0 ? html` Mensalidade: <s>${money(full)}</s> <b>${money(Billing.charge(cur, { ...row, ref_discount: s.pct }))}</b>` : ''}</small>
        ${s.next ? html`<small>Falta${s.next[0] - s.paying > 1 ? 'm' : ''} <b>${s.next[0] - s.paying}</b> para chegar a <b>${s.next[1]}%</b>.</small>` : html`<small><b>Você chegou à maior faixa de desconto.</b> Obrigado!</small>`}</div>
      <ol class="ref-steps" style="--fill:${Math.round(fill * 10) / 10}">${c.tiers.map(([n, p]) => html`<li class="${s.paying >= n ? 'on' : ''}" style="--at:${pos(c.tiers.findIndex((x) => x[0] === n))}"><b>${p}%</b><span>${n} ${n === 1 ? 'assinante' : 'assinantes'}</span></li>`)}</ol>
    </section>
    <section class="card">
      <h2>Seu link de indicação</h2>
      <div class="ref-link"><input id="ref-link" value="${link}" readonly aria-label="Link de indicação"><button type="button" class="btn" data-copy="#ref-link">Copiar</button></div>
      <p class="muted small">Código: <b>${code}</b> · também funciona em app.${T.baseDomain()}/i/${code}</p>
      <h3>Compartilhar</h3>
      <div class="ref-share">${share.map(([k, l, u]) => html`<a class="ref-btn ref-${k}" href="${u}" target="_blank" rel="noopener">${ico(k)}<span>${l}</span></a>`)}
        <button type="button" class="ref-btn ref-share-native" data-share-url="${link}" data-share-text="${textNoLink}" hidden>${ico('share')}<span>Instagram e outros apps</span></button>
        <button type="button" class="ref-btn" data-copy-text="${text}">${ico('share')}<span>Copiar mensagem</span></button></div>
      <p class="muted small">No Instagram, copie a mensagem e cole nos Stories ou na bio, ou use “Instagram e outros apps” no celular.</p>
    </section>
    <form class="card form-grid" data-ref-wa data-template="${text}">
      <h2 class="span2">Indicar um colega pelo WhatsApp</h2>
      <label class="fld"><span>Nome do colega</span><input name="nome" maxlength="60" placeholder="Ana"></label>
      <label class="fld"><span>WhatsApp do colega</span><input name="fone" maxlength="20" inputmode="tel" placeholder="(62) 99999-9999" required></label>
      <p class="span2 muted small">Abre o seu WhatsApp com a mensagem pronta para este colega; é só enviar.</p>
      <div class="span2 actions"><button class="btn">${ico('whatsapp')} Abrir no WhatsApp</button></div>
    </form>
    <section class="card flush"><h2 class="pad">Clínicas indicadas</h2>
      ${s.rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Clínica</th><th>Desde</th><th>Situação</th></tr></thead><tbody>
        ${s.rows.map((r) => { const st = r.status !== 'ativa' ? ['cancelada', 'Inativa'] : Referral.REF_STATE[r.billing_status] || ['agendada', r.billing_status]; return html`<tr><td>${r.name}</td><td>${brDate(r.referred_at || r.created_at)}</td><td><span class="badge b-${st[0]}">${st[1]}</span></td></tr>`; })}</tbody></table></div>`
      : html`<p class="pad muted">Ninguém se cadastrou pelo seu link ainda. Que tal mandar para um colega agora?</p>`}
    </section>
    <section class="card"><h2>Como funciona</h2><ul class="ref-rules">
      <li>Quem se cadastra pelo seu link ganha <b>${c.bonusDays} dias a mais</b> de teste grátis (${Billing.TRIAL_DAYS() + c.bonusDays} no total).</li>
      <li>A clínica indicada conta para o seu desconto a partir do primeiro pagamento, e continua contando enquanto a assinatura estiver em dia.</li>
      <li>Faixas: ${c.tiers.map(([n, p]) => `${n} assinante${n > 1 ? 's' : ''} = ${p}%`).join(' · ')}.</li>
      <li>O desconto é aplicado automaticamente nas próximas mensalidades${row.asaas_subscription || row.mp_preapproval ? '' : ' (assim que você assinar um plano)'}. Se uma indicada cancelar, o desconto volta para a faixa correspondente.</li>
    </ul></section>` }));
});
