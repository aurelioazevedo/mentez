// Configurações → Assinatura digital (certificados em nuvem) e o retorno da aprovação na certificadora.
import { audit } from '../lib/db.js';
import { page, html, raw } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import * as Cloud from '../lib/icpcloud.js';

const chk = (v) => (v ? raw('checked') : '');
export const baseOf = (req) => process.env.PUBLIC_URL || `${req.protocol}://${req.get('host')}`;
export const redirectUri = (req) => `${baseOf(req)}/assinatura/retorno`;

export const settings = router();
settings.get('/', async (req, res) => {
  const c = await Cloud.config();
  const on = Cloud.available(c);
  send(res, page(req, { title: 'Assinatura digital', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Assinatura digital (certificado em nuvem)</h1>
      <p class="muted">Integração com os certificados em nuvem da ICP-Brasil pela API padrão das certificadoras (ITI, DOC-ICP-17.01). O(a) profissional aprova cada assinatura no aplicativo do celular, sem sair do sistema. O certificado A1 (arquivo) e o envio do PDF assinado fora continuam valendo.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    ${on.length ? html`<div class="flash ok">✓ Liberado: ${on.map((k) => Cloud.PROVIDERS[k].label).join(', ')}.</div>` : html`<div class="flash info">Nenhuma certificadora ligada ainda. Peça as credenciais de integração (client_id e client_secret) à certificadora e informe o endereço de retorno abaixo.</div>`}
    <section class="card"><h2>Endereço de retorno (redirect URI)</h2><p class="muted small">Informe este endereço à certificadora ao cadastrar o sistema:</p>
      <p><code>${redirectUri(req)}</code> <button type="button" class="btn ghost btn-sm" data-copy-text="${redirectUri(req)}">Copiar</button></p></section>
    <form method="post" class="stack">
      ${Object.entries(Cloud.PROVIDERS).map(([k, p]) => { const x = c.providers[k]; const ready = Cloud.ready(c, k); return html`<fieldset class="card stack" id="psc-${k}"><legend><b>${p.label}</b> <small class="muted">${p.company}</small> ${ready ? html`<span class="badge b-realizada">ligado</span>` : x.enabled ? html`<span class="badge b-agendada">faltam as credenciais</span>` : ''}</legend>
        <label class="fld check"><input type="checkbox" name="${k}_enabled" value="1" ${chk(x.enabled)}><span>Liberar ${p.label} para os profissionais</span></label>
        ${k === 'cfm' ? html`<p class="muted small">O certificado gratuito do CFM para médicos é emitido pela Valid e usado no aplicativo VIDaaS: a integração é a mesma do VIDaaS.</p>
          <label class="fld check"><input type="checkbox" name="cfm_useVidaas" value="1" ${chk(x.useVidaas)}><span>Usar as mesmas credenciais do VIDaaS (cadastro do sistema na Valid)</span></label>` : ''}
        <div class="form-grid">
          <label class="fld"><span>Ambiente</span><select name="${k}_env"><option value="prod" ${x.env === 'prod' ? raw('selected') : ''}>Produção</option><option value="hom" ${x.env === 'hom' ? raw('selected') : ''}>Homologação (testes)</option></select></label>
          <label class="fld"><span>Endereço da API <small class="muted">(vazio = padrão; confirme com a certificadora)</small></span><input name="${k}_base" value="${x.base === p[x.env] ? '' : x.base}" placeholder="${p[x.env]}" maxlength="300"></label>
          <label class="fld"><span>client_id</span><input name="${k}_clientId" value="${x.clientId}" maxlength="200" autocomplete="off"></label>
          <label class="fld"><span>client_secret ${x.secret ? html`<small class="muted">(cadastrado — preencha só para trocar)</small>` : ''}</span><input name="${k}_secret" type="password" maxlength="300" autocomplete="new-password"></label>
        </div>
        ${x.secret ? html`<label class="fld check"><input type="checkbox" name="${k}_secret_remove" value="1"><span>Remover o client_secret</span></label>` : ''}
      </fieldset>`; })}
      <fieldset class="card stack"><legend><b>Sessão de assinatura</b></legend>
        <label class="fld check"><input type="checkbox" name="session" value="1" ${chk(c.session)}><span>Depois de aprovar no celular, permitir assinar outros documentos por um período sem aprovar de novo (se a certificadora permitir)</span></label>
        <label class="fld"><span>Período</span><select name="sessionHours">${[1, 2, 4, 8, 12].map((h) => html`<option value="${h}" ${c.sessionHours === h ? raw('selected') : ''}>${h} hora(s)</option>`)}</select></label>
      </fieldset>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>
    <details class="card tv-tips"><summary>Como ligar uma certificadora</summary><ol>
      <li>Peça à certificadora o cadastro do sistema para a API de assinatura em nuvem (PSC): <b>Valid</b> (VIDaaS e certificado do CFM), <b>Soluti</b> (BirdID) ou <b>Safeweb</b> (SafeID).</li>
      <li>Informe o endereço de retorno acima. Você recebe o <b>client_id</b> e o <b>client_secret</b> (primeiro em homologação, depois em produção).</li>
      <li>Cole aqui, marque “Liberar” e salve. Cada profissional escolhe o próprio certificado em <b>Conta → Certificado digital</b>.</li>
    </ol></details>` }));
});
settings.post('/', async (req, res) => {
  await Cloud.saveConfig(req.body, await Cloud.config());
  await audit(req, 'assinatura-nuvem-config');
  res.flash('Assinatura digital salva.').redirect('/configuracoes/assinatura');
});
