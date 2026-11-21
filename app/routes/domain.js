// Configurações → Domínio próprio: a clínica usa o próprio endereço (ex.: app.aurelioazevedo.com) no lugar de slug.mentez.com.br.
// Mostra o registro A que precisa ser criado e o passo a passo onde o DNS do domínio está (Registro.br, Hostinger, Cloudflare…).
import { audit } from '../lib/db.js';
import { page, html, raw } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import * as T from '../lib/tenancy.js';
import * as D from '../lib/domains.js';

export const domainSettings = router();
const brDT = (d) => (d ? new Date(d).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) : '');
const copy = (v) => html`<button type="button" class="chip dm-copy" data-copy-text="${v}" aria-label="Copiar ${v}">Copiar</button>`;

// Passo a passo de cada lugar onde o DNS pode estar
function guides(host, ip, cn) {
  const H = html`<code>${host}</code>`; const I = html`<code>${ip}</code>`;
  const alt = host !== '@' ? html`<p class="small muted">Ou, no lugar do registro A: Tipo <b>CNAME</b>, Nome ${H}, valor <code>${cn}</code>.</p>` : '';
  return [
    ['registrobr', 'Registro.br', html`<ol>
      <li>Entre em <b>registro.br</b> com seu CPF ou CNPJ e senha.</li>
      <li>Clique no domínio.</li>
      <li>Na parte <b>DNS</b>, clique em <b>Editar zona</b>. Se aparecer “Configurar endereçamento”, clique antes em <b>Modo avançado</b> e confirme (pode levar alguns minutos para liberar).</li>
      <li>Clique em <b>Nova entrada</b> e preencha: Tipo <b>A</b>, Nome ${H}, Dados ${I}.</li>
      <li>Clique em <b>Salvar alterações</b>.</li></ol>${alt}
      <p class="small muted">O Registro.br só cuida de domínios <b>.br</b>. Se o seu domínio usa os servidores de DNS da hospedagem (ex.: Hostinger), o registro é criado lá, não no Registro.br.</p>`],
    ['hostinger', 'Hostinger', html`<ol>
      <li>Entre no <b>hPanel</b> (hpanel.hostinger.com).</li>
      <li>Vá em <b>Domínios</b>, escolha o domínio e abra <b>DNS / Nameservers</b> (ou, em Sites, <b>Painel → Avançado → Editor de zona DNS</b>).</li>
      <li>Em <b>Gerenciar registros DNS</b>, preencha: Tipo <b>A</b>, Nome ${H}, Aponta para ${I}, TTL <b>3600</b>.</li>
      <li>Clique em <b>Adicionar registro</b>. Se já existir um registro A, AAAA ou CNAME com o nome ${H}, apague ou edite esse registro antes.</li></ol>${alt}
      <p class="small muted">Não mexa nos registros <b>@</b> e <b>www</b>: eles mantêm o site do domínio funcionando.</p>`],
    ['cloudflare', 'Cloudflare', html`<ol>
      <li>Entre no painel da Cloudflare e escolha o domínio.</li>
      <li>Abra <b>DNS → Registros</b> e clique em <b>Adicionar registro</b>.</li>
      <li>Tipo <b>A</b>, Nome ${H}, Endereço IPv4 ${I}.</li>
      <li>Em <b>Status do proxy</b>, deixe <b>Somente DNS</b> (nuvem cinza). Com a nuvem laranja, o endereço aparece com os IPs da Cloudflare e a Mentez não consegue confirmar o domínio nem emitir o HTTPS.</li>
      <li>Clique em <b>Salvar</b>.</li></ol>${alt}
      <p class="small muted">Já criou com a nuvem laranja? Clique em <b>Editar</b> no registro, troque para <b>Somente DNS</b> e salve. Não é preciso apagar.</p>`],
    ['godaddy', 'GoDaddy', html`<ol>
      <li>Em <b>Meus produtos</b>, ao lado do domínio, clique em <b>DNS</b>.</li>
      <li>Clique em <b>Adicionar novo registro</b>: Tipo <b>A</b>, Nome ${H}, Valor ${I}, TTL padrão.</li>
      <li>Clique em <b>Salvar</b>.</li></ol>${alt}`],
    ['outro', 'Outra hospedagem (Locaweb, HostGator, KingHost, UOL Host…)', html`<ol>
      <li>Entre no painel da empresa onde o DNS do domínio está (veja “Onde está o DNS” acima) e procure <b>DNS</b>, <b>Zona DNS</b> ou <b>Gerenciar DNS</b>.</li>
      <li>Crie um registro: Tipo <b>A</b>, Nome/Host ${H}, Valor/Aponta para ${I}, TTL 3600 (ou o padrão).</li>
      <li>Se já houver um registro A, AAAA ou CNAME com o mesmo nome, apague ou edite esse registro.</li></ol>${alt}
      <p class="small muted">Alguns painéis pedem o nome completo (${host === '@' ? 'o domínio' : html`<code>${host}.seudominio</code>`}) em vez de só ${H}; os dois funcionam do mesmo jeito.</p>`],
  ];
}

domainSettings.get('/', async (req, res) => {
  const t = T.current();
  if (!t) return send(res, page(req, { title: 'Domínio próprio', active: 'config', body: html`<p class="muted">Disponível na Mentez.</p>` }));
  const rows = await D.list(t.id);
  const ips = await D.serverIps().catch(() => ({ v4: [] }));
  const ip = ips.v4[0] || '(IP do servidor da Mentez)';
  // diagnóstico do DNS de cada domínio (consulta rápida, sem gravar)
  const diag = await Promise.all(rows.map((r) => (D.stateOf(r).key === 'ativo' ? null : D.inspect(r.domain, t.slug).catch(() => null))));
  const mentezUrl = `${t.slug}.${T.baseDomain()}`;
  const primary = rows.find((r) => r.is_primary && r.verified_at);
  send(res, page(req, { title: 'Domínio próprio', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Domínio próprio</h1>
      <p class="muted">Use o endereço da sua clínica para entrar no sistema e nos links enviados aos pacientes, por exemplo <b>app.suaclinica.com.br</b> ou <b>sistema.suaclinica.com.br</b>.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>

    <section class="card">
      <h2>Endereço principal</h2>
      <p><b>${primary ? primary.domain : mentezUrl}</b> ${primary ? html`<span class="badge b-realizada">domínio próprio</span>` : html`<span class="badge">endereço da Mentez</span>`}</p>
      <p class="small muted">O endereço <b>${mentezUrl}</b> continua funcionando sempre, mesmo com domínio próprio.</p>
    </section>

    ${rows.map((r, i) => {
      const st = D.stateOf(r); const g = diag[i];
      const host = g?.host || r.domain.split('.')[0];
      const prov = g?.proxied ? 'cloudflare' : (g?.provider || 'outro');
      return html`<section class="card dm-card">
        <header class="dm-head"><h2>${r.domain}</h2><span class="badge b-${st.badge}">${st.label}</span>${r.is_primary ? html`<span class="badge b-realizada">principal</span>` : ''}</header>
        ${st.key === 'ativo' ? html`<p>Tudo certo: <a class="link" href="https://${r.domain}" target="_blank" rel="noopener">https://${r.domain}</a> já abre a sua clínica com HTTPS.${!r.is_primary ? ' Para os links enviados aos pacientes usarem este endereço, torne-o principal.' : ''}</p>` : ''}
        ${r.last_check && st.key !== 'ativo' ? html`<div class="flash ${st.key === 'https' ? 'info' : 'warn'}">${r.last_check}</div>` : ''}
        ${st.key !== 'ativo' ? html`
          <h3>1. Crie <u>um</u> destes registros no DNS do domínio</h3>
          <div class="tbl-wrap"><table class="tbl dm-rec"><thead><tr><th>Opção</th><th>Tipo</th><th>Nome (host)</th><th>Valor (aponta para)</th><th>TTL</th></tr></thead>
            <tbody>
              <tr><td data-label="Opção"><b>1</b> <small class="muted">recomendada</small></td><td data-label="Tipo"><b>A</b></td><td data-label="Nome (host)"><code>${host}</code> ${copy(host)}</td><td data-label="Valor"><code>${ip}</code> ${copy(ip)}</td><td data-label="TTL">3600 <small class="muted">(ou o padrão)</small></td></tr>
              ${host !== '@' ? html`<tr><td data-label="Opção"><b>2</b> <small class="muted">ou</small></td><td data-label="Tipo"><b>CNAME</b></td><td data-label="Nome (host)"><code>${host}</code> ${copy(host)}</td><td data-label="Valor"><code>${mentezUrl}</code> ${copy(mentezUrl)}</td><td data-label="TTL">3600 <small class="muted">(ou o padrão)</small></td></tr>` : ''}
            </tbody></table></div>
          <p class="small muted">Use só uma das opções: se já existir outro registro A, AAAA ou CNAME com o nome <code>${host}</code>, apague ou edite esse registro. ${prov === 'cloudflare' || g?.proxied ? html`<b>Na Cloudflare, deixe o “Status do proxy” em “Somente DNS” (nuvem cinza).</b>` : ''}</p>
          ${host === '@' ? html`<p class="flash warn small">Você cadastrou o domínio principal (sem “app.” ou “sistema.” na frente). Se ele já tem um site, apontar o domínio para a Mentez tira o site do ar. Prefira um subdomínio, como <b>app.${r.domain}</b>.</p>` : ''}
          <p class="small muted">Onde está o DNS: ${g?.ns?.length ? html`<b>${g.providerName || g.ns.map((n) => String(n).replace(/\.$/, '')).join(', ')}</b>${g.providerName ? html` <span class="muted">(${g.ns.map((n) => String(n).replace(/\.$/, '')).slice(0, 2).join(', ')})</span>` : ''}` : 'não identificado'}. O registro é criado onde o DNS está, que nem sempre é onde o domínio foi comprado.</p>
          <h3>2. Passo a passo</h3>
          <div class="dm-guides">${guides(host, ip, mentezUrl).map(([k, label, body]) => html`<details ${k === prov || (prov !== 'registrobr' && prov !== 'hostinger' && prov !== 'cloudflare' && prov !== 'godaddy' && k === 'outro') ? raw('open') : ''}><summary>${label}${k === prov ? html` <span class="badge b-confirmada">seu domínio</span>` : ''}</summary>${body}</details>`)}</div>
          <h3>3. Verifique</h3>
          <p class="small muted">A mudança costuma valer em poucos minutos, mas pode levar algumas horas. Verificamos sozinhos a cada 10 minutos; quando o DNS apontar para a Mentez, o HTTPS é ativado automaticamente.${r.checked_at ? ` Última verificação: ${brDT(r.checked_at)}.` : ''}</p>
          ${g && !g.ok && g.a.length ? html`<p class="small">Hoje o endereço aponta para: <code>${g.a.join(', ')}</code></p>` : ''}` : ''}
        <div class="actions">
          ${st.key !== 'ativo' ? html`<form method="post" action="/configuracoes/dominio/verificar"><input type="hidden" name="domain" value="${r.domain}"><button class="btn">Verificar agora</button></form>` : ''}
          ${st.key === 'ativo' && !r.is_primary ? html`<form method="post" action="/configuracoes/dominio/principal"><input type="hidden" name="domain" value="${r.domain}"><button class="btn" data-confirm="Usar ${r.domain} como endereço principal? Os links enviados aos pacientes (agendamento, portal, teleconsulta, documentos) passam a usar este domínio.">Tornar principal</button></form>` : ''}
          ${r.is_primary ? html`<form method="post" action="/configuracoes/dominio/principal"><input type="hidden" name="domain" value=""><button class="btn ghost">Voltar ao endereço da Mentez</button></form>` : ''}
          <form method="post" action="/configuracoes/dominio/remover"><input type="hidden" name="domain" value="${r.domain}"><button class="btn ghost danger-text" data-confirm="Remover ${r.domain}? O endereço deixa de abrir a clínica (o ${mentezUrl} continua funcionando).">Remover</button></form>
        </div>
      </section>`;
    })}

    ${rows.length < D.MAX_PER_CLINIC ? html`<section class="card">
      <h2>${rows.length ? 'Cadastrar outro domínio' : 'Cadastrar domínio'}</h2>
      <p class="small muted">Escreva o endereço que você quer usar. O mais comum é um subdomínio do site da clínica, como <b>app.</b> ou <b>sistema.</b>, para o site continuar no ar. Depois de cadastrar, mostramos o registro que deve ser criado no Registro.br ou na hospedagem.</p>
      <form method="post" action="/configuracoes/dominio" class="inline-form"><input name="domain" required maxlength="190" placeholder="app.suaclinica.com.br" autocapitalize="off" autocomplete="off" spellcheck="false" inputmode="url" aria-label="Domínio"><button class="btn">Cadastrar</button></form>
    </section>` : ''}

    <section class="card">
      <h2>Bom saber</h2>
      <ul class="small">
        <li>O certificado de segurança (HTTPS) é gratuito e renovado automaticamente pela Mentez.</li>
        <li>O site da clínica e os e-mails do domínio continuam como estão: só o endereço novo (ex.: app.) passa a apontar para a Mentez.</li>
        <li>Quem já usa o sistema entra de novo pelo endereço novo (o login é separado por endereço).</li>
        <li>Cadastros que não forem confirmados no DNS em 15 dias são removidos.</li>
      </ul>
    </section>` }));
});

const back = (res) => res.redirect('/configuracoes/dominio');
domainSettings.post('/', async (req, res) => {
  const t = T.current(); if (!t) return back(res);
  try {
    const d = await D.add(t.id, req.body.domain, `clinica:${req.user?.email || req.user?.id || ''}`);
    await audit(req, 'dominio-adicionar', d);
    res.flash(`Domínio ${d} cadastrado. Agora crie o registro abaixo no DNS do domínio.`);
  } catch (e) { res.flash(e.message, 'err'); }
  back(res);
});
domainSettings.post('/verificar', async (req, res) => {
  const t = T.current(); if (!t) return back(res);
  try {
    const d = D.normalize(req.body.domain);
    const r = await D.check(d, t.id);
    res.flash(r.ok && r.https ? `Pronto! ${d} já está funcionando com HTTPS.` : r.ok ? 'O DNS já aponta para a Mentez. O HTTPS está sendo ativado; verifique de novo em alguns minutos.' : r.problems[0], r.ok ? 'ok' : 'warn');
  } catch (e) { res.flash(e.message, 'err'); }
  back(res);
});
domainSettings.post('/principal', async (req, res) => {
  const t = T.current(); if (!t) return back(res);
  try {
    const d = req.body.domain ? D.normalize(req.body.domain) : '';
    await D.setPrimary(t.id, d, `clinica:${req.user?.email || req.user?.id || ''}`);
    await audit(req, 'dominio-principal', d || 'mentez');
    res.flash(d ? `${d} agora é o endereço principal.` : 'O endereço da Mentez voltou a ser o principal.');
  } catch (e) { res.flash(e.message, 'err'); }
  back(res);
});
domainSettings.post('/remover', async (req, res) => {
  const t = T.current(); if (!t) return back(res);
  try { const d = D.normalize(req.body.domain); await D.remove(t.id, d, `clinica:${req.user?.email || req.user?.id || ''}`); await audit(req, 'dominio-remover', d); res.flash('Domínio removido.'); } catch (e) { res.flash(e.message, 'err'); }
  back(res);
});
