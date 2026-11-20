import * as Brand from '../lib/brand.js';
import express from 'express';
import bcrypt from 'bcryptjs';
import QRCode from 'qrcode';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDateTime, avatar, themeOf, logoTag } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import { can, ROLES, homeFor, isClinician } from '../lib/perm.js';
import { bare } from '../lib/html.js';
import { accountCard } from './google.js';
import * as PUSH from '../lib/push.js';
import { encrypt, decrypt, newTotpSecret, verifyTotp } from '../lib/crypto.js';
import * as Fin from '../lib/fin.js';
import { KEY_TYPES, normalizeKey } from '../lib/pix.js';
import { str } from '../lib/router.js';
import * as PsyDocs from '../lib/psydocs.js';
import * as AP from '../lib/aiproviders.js';
import * as Fiscal from '../lib/fiscal.js';
import * as Nfse from '../lib/nfse.js';
import * as ICP from '../lib/icp.js';
import * as Cloud from '../lib/icpcloud.js';

const hasPix = (u) => u.role === 'admin' || u.role === 'psicologo';

const r = router();

r.get('/', async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  let qr = '';
  let secret = '';
  if (!u.totp_enabled) {
    secret = u.totp_secret ? decrypt(u.totp_secret) : newTotpSecret();
    if (!u.totp_secret) await q('UPDATE users SET totp_secret = ? WHERE id = ?', [encrypt(secret), u.id]);
    const uri = `otpauth://totp/${encodeURIComponent(`${Brand.get().appName}:${u.email}`)}?secret=${secret}&issuer=${encodeURIComponent(Brand.get().appName)}`;
    qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, color: { dark: '#47291c', light: '#ffffff' } });
  }
  const gcard = await accountCard(req);
  const vapid = await PUSH.keys();
  const devs = await PUSH.devices(req.user.id);
  const myRule = hasPix(u) ? await Fin.rule(u.id) : null;
  const myFiscal = hasPix(u) ? await Fiscal.profile(u.id) : null;
  const myCert = can(req.user, 'prontuario') ? await ICP.certOf(u.id) : null;
  const cloudCfg = can(req.user, 'prontuario') ? await Cloud.config() : null; const cloudOn = cloudCfg ? Cloud.available(cloudCfg) : [];
  const aiCfg = await PsyDocs.aiConfig(); const aiMine = PsyDocs.aiAllowed(aiCfg, req.user) && aiCfg.keyMode !== 'clinica' ? await PsyDocs.myUsage(u.id) : null;
  send(res, page(req, {
    title: 'Conta', active: 'conta',
    body: html`
    <header class="ph"><div><p class="eyebrow">${u.email} · ${ROLES[u.role]?.label}</p><h1>Conta e segurança</h1></div></header>
    <section class="card photo-card" id="foto">
      <div class="photo-prev" data-photo-prev>${avatar(req.user, 'av-xl')}</div>
      <div class="photo-body"><h2>Foto do perfil</h2>
        <p class="muted small">Aparece no topo do sistema e no menu. Use uma foto de rosto. Ao escolher, você ajusta o enquadramento: arraste, aproxime e gire (JPG, PNG ou WebP até 10 MB).</p>
        <form method="post" action="/conta/foto" class="photo-actions" data-photo-form>
          <input type="hidden" name="photo">
          <label class="btn">${req.user.photo_v ? 'Trocar foto' : 'Escolher foto'}<input type="file" accept="image/jpeg,image/png,image/webp" data-photo-file hidden></label>
          ${req.user.photo_v ? html`<button class="btn ghost" type="button" data-photo-reframe="${u.photo_orig ? '/conta/foto/original' : `/conta/foto/${u.id}?v=${u.photo_v}`}">Reenquadrar foto atual</button>` : ''}
        </form>
        ${req.user.photo_v ? html`<form method="post" action="/conta/foto/remover" data-confirm="Remover sua foto?"><button class="btn ghost danger-text">Remover foto</button></form>` : ''}
      </div>
    </section>
    ${can(req.user, 'prontuario') ? html`<section class="card" id="assinatura"><h2>Assinatura para documentos</h2>
      <p class="muted small sub-h">Imagem da sua assinatura usada nos documentos psicológicos emitidos pelo sistema (declarações, atestados, relatórios, laudos e pareceres). Fundo branco ou transparente, PNG ou JPG até 500 KB.</p>
      ${u.signature_png ? html`<p><img class="sig-prev" src="${u.signature_png}" alt="Sua assinatura"></p>` : html`<p class="muted small">Nenhuma assinatura cadastrada: o documento sai com o nome e o CRP, sem a imagem.</p>`}
      <div class="actions"><label class="btn ghost">${u.signature_png ? 'Trocar imagem' : 'Enviar imagem da assinatura'}<input type="file" accept="image/png,image/jpeg" data-upload="/conta/assinatura" hidden></label>
        ${u.signature_png ? html`<form method="post" action="/conta/assinatura/remover" data-confirm="Remover a imagem da assinatura?"><button class="btn ghost danger-text">Remover</button></form>` : ''}</div>
      <p class="small" data-upload-msg aria-live="polite"></p>
    </section>` : ''}
    ${can(req.user, 'prontuario') ? html`<section class="card" id="certificado"><h2>Certificado digital (ICP-Brasil)</h2>
      <p class="muted small sub-h">Para assinar documentos psicológicos com validade jurídica plena. Com o certificado <b>A1</b> (arquivo .pfx/.p12) cadastrado aqui, você assina com um clique. Com certificado <b>em nuvem</b> (VIDaaS, BirdID…) ou <b>token A3</b>, você assina fora e envia o PDF assinado no próprio documento.</p>
      ${myCert ? html`<p><span class="badge ${myCert.expired ? 'b-falta' : 'b-realizada'}">${myCert.expired ? 'Vencido' : 'Cadastrado'}</span> <b>${myCert.name}</b>${myCert.cpf ? html` · CPF ${ICP.maskCpf(myCert.cpf)}` : ''}<br><small class="muted">${myCert.issuer} · válido até ${myCert.validTo ? myCert.validTo.toLocaleDateString('pt-BR') : '—'} · ${myCert.remembered ? 'senha guardada (assina com um clique)' : 'a senha é pedida a cada assinatura'}</small></p>` : ''}
      ${cloudOn.length ? html`<form method="post" action="/conta/certificado/nuvem" class="stack psy-cloud-pick"><h3 class="esc-sub">Certificado em nuvem (aprovação no celular)</h3>
        <fieldset class="rt-units"><legend class="sr-only">Certificado em nuvem</legend>
          <label class="maint-g"><input type="radio" name="provider" value="" ${u.cloud_provider ? '' : raw('checked')}><span><b>Não uso certificado em nuvem</b><small>assino com o A1 ou envio o PDF assinado</small></span></label>
          ${cloudOn.map((k) => html`<label class="maint-g"><input type="radio" name="provider" value="${k}" ${u.cloud_provider === k ? raw('checked') : ''}><span><b>${Cloud.PROVIDERS[k].label}</b><small>${Cloud.PROVIDERS[k].company} · aprovação no app ${Cloud.PROVIDERS[k].app}</small></span></label>`)}
        </fieldset>
        <p class="muted small">Ao assinar, o sistema abre a certificadora e você aprova no aplicativo do celular. O CPF dos seus dados fiscais é usado para localizar o seu certificado.</p>
        <div class="actions"><button class="btn ghost">Salvar escolha</button></div></form>
        <h3 class="esc-sub">Certificado A1 (arquivo)</h3>` : ''}
      <form method="post" action="/conta/certificado" class="form-grid" data-cert-form>
        <input type="hidden" name="pfx">
        <label class="fld"><span>Arquivo do certificado A1 (.pfx ou .p12)</span><input type="file" accept=".pfx,.p12,application/x-pkcs12" data-cert-file ${myCert ? '' : raw('required')}></label>
        <label class="fld"><span>Senha do certificado</span><input type="password" name="senha" autocomplete="off" required></label>
        <label class="fld check span2"><input type="checkbox" name="lembrar" value="1"><span>Guardar a senha (criptografada) para assinar com um clique. Sem marcar, o sistema pede a senha a cada assinatura.</span></label>
        <div class="span2 actions"><button class="btn">${myCert ? 'Trocar o certificado' : 'Cadastrar o certificado'}</button></div>
      </form>
      ${myCert ? html`<form method="post" action="/conta/certificado/remover" data-confirm="Remover o seu certificado digital do sistema?"><button class="btn ghost danger-text">Remover o certificado</button></form>` : ''}
      <p class="muted small">O arquivo e a senha ficam criptografados (AES-256) e só são usados quando você manda assinar. Ninguém da clínica consegue baixar o seu certificado.</p>
    </section>` : ''}
    ${aiMine ? html`<section class="card" id="ia"><h2>Escrita com IA (documentos)</h2>
      <p class="muted small sub-h">Sua chave de IA: o custo das gerações de documentos fica na sua conta do provedor, separado da clínica. ${aiCfg.keyMode === 'profissional' ? 'Obrigatória para usar a escrita com IA.' : 'Sem ela, o sistema usa a chave da clínica.'} Pode ser da Anthropic (Claude) ou de outra plataforma (OpenAI, Gemini, Groq, DeepSeek, OpenRouter…).</p>
      <form method="post" action="/conta/ia" class="form-grid">
        <label class="fld"><span>Provedor</span><select name="ai_provider">${Object.entries(PsyDocs.PROVIDERS).map(([k, l]) => html`<option value="${k}" ${(u.ai_provider || 'anthropic') === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label class="fld"><span>Modelo <small class="muted">(vazio = o da clínica; ex.: claude-opus-5-5, gpt-4.1-mini)</small></span><input name="ai_model" maxlength="120" value="${u.ai_model || ''}"></label>
        <label class="fld span2"><span>Chave da API ${u.ai_key_enc ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : ''}</span><input name="ai_key" type="password" autocomplete="off" placeholder="sk-ant-… / sk-… / AIza…" maxlength="300"></label>
        <label class="fld span2"><span>Endereço da API <small class="muted">(só para “Outro”)</small></span><input name="ai_base_url" maxlength="300" value="${u.ai_base_url || ''}" placeholder="https://…/v1"></label>
        <div class="span2 actions"><button class="btn">Salvar</button>${u.ai_key_enc ? html`<button class="btn ghost danger-text" name="remover" value="1" formnovalidate>Remover chave</button>` : ''}</div>
      </form>
      <p class="muted small">Neste mês: ${aiMine.n} geração(ões) · custo estimado US$ ${Number(aiMine.cost).toFixed(2)}${(u.ai_provider || 'anthropic') !== 'anthropic' ? ' (outros provedores: confira o custo no painel deles)' : ''}.</p>
    </section>` : ''}
    ${myFiscal ? html`<section class="card" id="fiscal"><h2>Meus dados fiscais</h2>
      <p class="muted small sub-h">Quando o paciente paga <b>direto para você</b>, o recibo do Receita Saúde (pessoa física) ou a nota fiscal (seu CNPJ) é emitido por você.</p>
      <p>${myFiscal.saved ? html`<span class="badge b-realizada">${Fiscal.KINDS[myFiscal.kind][0]}</span> ${Fiscal.KINDS[myFiscal.kind][1]}` : html`<span class="badge b-agendada">Não preenchidos</span>`}
        ${Fiscal.missing(myFiscal).length && myFiscal.saved ? html`<br><small class="err-txt">Falta: ${Fiscal.missing(myFiscal).join(', ')}</small>` : ''}</p>
      <a class="btn ghost" href="/conta/fiscal">${myFiscal.saved ? 'Ver e editar' : 'Preencher meus dados fiscais'}</a></section>` : ''}
    ${myRule ? html`<section class="card" id="pix"><h2>Minha chave Pix</h2>
      <p class="muted small sub-h">Usada nos códigos Pix e QR codes das cobranças dos pacientes que pagam <b>direto para você</b>. Quem paga na clínica recebe a chave da clínica.</p>
      <form method="post" action="/conta/pix" class="form-grid">
        <label class="fld"><span>Tipo de chave</span><select name="pix_type"><option value="">— sem chave —</option>${Object.entries(KEY_TYPES).map(([k, l]) => html`<option value="${k}" ${myRule.pix_type === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <label class="fld"><span>Chave Pix</span><input name="pix_key" value="${myRule.pix_key}" maxlength="140" autocomplete="off"></label>
        <div class="span2 actions"><button class="btn">Salvar chave Pix</button></div>
      </form></section>` : ''}
    <section class="card" id="aparencia"><h2>Aparência</h2>
      <form method="post" action="/conta/tema" class="stack">
        <div class="theme-pick">${[['claro', '☀️ Claro (padrão)'], ['escuro', '🌙 Escuro'], ['auto', '🖥️ Automático (segue o aparelho)']].map(([v, l]) => html`<label><input type="radio" name="tema" value="${v}" ${({ dark: 'escuro', light: 'claro', auto: 'auto' })[themeOf(req)] === v ? raw('checked') : ''} data-autosubmit-check><span>${l}</span></label>`)}</div>
        <noscript><button class="btn ghost">Salvar</button></noscript>
      </form>
      <p class="muted small">Também dá para alternar pelo ícone de lua/sol no topo. A escolha vale para este navegador.</p>
    </section>
    <div class="grid2">
      <section class="card"><h2>Verificação em duas etapas</h2>
        ${u.totp_enabled ? html`<p><span class="badge b-realizada">Ativada</span> Seu login pede o código do aplicativo autenticador.</p>
          <form method="post" action="/conta/2fa/desativar" class="stack"><label class="fld"><span>Código atual para desativar</span><input name="code" inputmode="numeric" required></label><button class="btn ghost">Desativar</button></form>`
        : html`<p>Recomendado: proteja o prontuário com um segundo fator. Escaneie o QR code no Google Authenticator, Microsoft Authenticator ou similar e digite o código gerado.</p>
          <div class="qr"><img src="${raw(qr)}" alt="QR code para o autenticador" width="200" height="200"><code>${secret.match(/.{1,4}/g).join(' ')}</code></div>
          <form method="post" action="/conta/2fa/ativar" class="stack"><label class="fld"><span>Código de 6 dígitos</span><input name="code" inputmode="numeric" required></label><button class="btn">Ativar</button></form>`}
      </section>
      <section class="card"><h2>Alterar senha</h2>
        <form method="post" action="/conta/senha" class="stack">
          <label class="fld"><span>Senha atual</span><input type="password" name="current" required autocomplete="current-password"></label>
          <label class="fld"><span>Nova senha (mínimo 10 caracteres)</span><input type="password" name="password" minlength="10" required autocomplete="new-password"></label>
          <label class="fld"><span>Repita a nova senha</span><input type="password" name="password2" minlength="10" required autocomplete="new-password"></label>
          <button class="btn">Salvar nova senha</button>
        </form>
      </section>
    </div>
    <section class="card" id="app">
      <h2>Aplicativo no celular e no computador</h2>
      <p class="small">Instale o sistema como aplicativo: abre direto pelo ícone “Consultório”, em tela cheia, e recebe notificações. Funciona no Android, iPhone, Windows e Mac.</p>
      <div class="actions"><button type="button" class="btn" data-install hidden>${raw('<svg viewBox="0 0 24 24" aria-hidden="true" style="width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2"><path d="M12 4v11M7 10l5 5 5-5"/><path d="M5 19h14"/></svg>')} Instalar aplicativo</button></div>
      <p class="small muted" data-install-ok>Se o botão não aparecer, o aplicativo já está instalado neste aparelho (ou você já está nele).</p>
    </section>
    <section class="card" id="push" data-vapid="${vapid.publicKey}">
      <h2>Notificações push neste aparelho</h2>
      <p class="small">Receba avisos de novas sessões, confirmações e pedidos de remarcação pelo WhatsApp e exercícios respondidos — mesmo com o sistema fechado.</p>
      <p class="push-status small muted" data-push-status>Verificando…</p>
      <div class="actions">
        <button type="button" class="btn" data-push-on hidden>Ativar notificações neste aparelho</button>
        <button type="button" class="btn ghost" data-push-test hidden>Enviar notificação de teste</button>
        <button type="button" class="btn ghost" data-push-off hidden>Desativar neste aparelho</button>
      </div>
      <details class="ical"><summary>No iPhone/iPad</summary><p class="small">A Apple só permite notificações para sites instalados: abra o sistema no Safari → botão Compartilhar → <b>Adicionar à Tela de Início</b>. Depois abra pelo ícone “Consultório” e toque em “Ativar notificações”.</p></details>
      ${devs.length ? html`<h3 class="esc-sub">Aparelhos com notificações (${devs.length})</h3><ul class="dev-list">${devs.map((d) => html`<li><span>${d.device || 'Aparelho'}</span><small class="muted">ativado em ${brDateTime(d.created_at)}${d.last_used_at ? ` · último aviso ${brDateTime(d.last_used_at)}` : ''}</small>
        <form method="post" action="/conta/push/remover"><input type="hidden" name="id" value="${d.id}"><button class="link small btnlink">remover</button></form></li>`)}</ul>` : ''}
    </section>
    ${gcard}${isClinician(req.user.role) ? html`<section class="card"><h2>Teleconsulta</h2><p class="muted">Escolha por onde você atende as sessões on-line: sala própria, Google Meet, Zoom ou outro link.</p><a class="btn ghost" href="/conta/teleconsulta">Escolher minha plataforma</a></section>` : ''}
    <section class="card"><h2>Privacidade e guarda de dados</h2>
      <ul class="bullets">
        <li>Prontuário, CPF, endereço, contato de emergência e respostas dos exercícios ficam <b>criptografados</b> (AES-256) no banco.</li>
        <li>O sistema não aparece no Google: todas as páginas enviam <code>noindex</code> e o <code>robots.txt</code> bloqueia buscadores.</li>
        <li>Links de exercícios são pessoais, expiram e podem ser trocados a qualquer momento.</li>
        <li>Guarde os registros por no mínimo 5 anos (Resolução CFP nº 01/2009). Use “Imprimir prontuário” para gerar cópia em PDF quando solicitado.</li>
      </ul>
    </section>
    ${can(req.user, 'usuarios') ? html`<p><a class="link" href="/configuracoes/acessos">Ver registro de acessos →</a></p>` : ''}`,
  }));
});

// ---------- meus dados fiscais (para quem recebe direto dos pacientes) ----------
r.get('/fiscal', async (req, res) => {
  if (!hasPix(req.user)) return res.status(403).send('Sem permissão');
  const fp = await Fiscal.profile(req.user.id);
  const miss = Fiscal.missing(fp);
  const nc = await Nfse.config(req.user.id); const nr = await Nfse.readiness(nc);
  const direct = await one("SELECT COUNT(*) n, COALESCE(SUM(amount),0) v FROM payments WHERE professional_id = ? AND receiver = 'profissional' AND paid_at >= DATE_SUB(CURDATE(), INTERVAL 90 DAY)", [req.user.id]);
  const ck = (v) => (v ? raw('checked') : '');
  send(res, page(req, {
    title: 'Meus dados fiscais', active: 'conta',
    body: html`<header class="ph"><div><p class="eyebrow">Conta</p><h1>Meus dados fiscais</h1>
      <p class="muted">Quando o paciente paga <b>direto para você</b>, quem emite o documento fiscal é você: o recibo no <b>Receita Saúde</b> (pessoa física, com o seu CPF) ou a <b>nota fiscal</b> com o seu CNPJ. Os recebimentos da clínica seguem com a clínica.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/conta">Voltar</a></div></header>
    ${!fp.saved ? html`<div class="flash info">Preencha e salve para o sistema saber como você emite os documentos.</div>` : miss.length ? html`<div class="flash warn">Falta: ${miss.join(', ')}.</div>` : html`<div class="flash ok">✓ Dados fiscais completos.</div>`}
    ${Number(direct?.n) ? html`<p class="muted small">Nos últimos 90 dias: ${direct.n} recebimento(s) direto para você.</p>` : ''}
    <form method="post" action="/conta/fiscal" class="card stack">
      <h2>Como você emite</h2>
      <fieldset class="rt-units"><legend class="sr-only">Tipo de emissão</legend>${Object.entries(Fiscal.KINDS).map(([k, [t, d]]) => html`<label class="maint-g"><input type="radio" name="kind" value="${k}" ${ck(fp.kind === k)}><span><b>${t}</b><small>${d}</small></span></label>`)}</fieldset>
      <h2>Seus dados</h2>
      <div class="form-grid">
        <label class="fld span2"><span>Nome completo (como no CPF)</span><input name="fullName" value="${fp.fullName}" maxlength="160" required></label>
        <label class="fld"><span>CPF</span><input name="cpf" value="${Fiscal.cpfFmt(fp.cpf)}" inputmode="numeric" maxlength="14" placeholder="000.000.000-00" autocomplete="off" required></label>
        <label class="fld"><span>CRP</span><input name="crp" value="${fp.crp}" maxlength="30" placeholder="09/00000" required></label>
        <label class="fld span2"><span>Endereço profissional <small class="muted">(aparece no recibo impresso)</small></span><input name="address" value="${fp.address}" maxlength="200"></label>
        <label class="fld"><span>Cidade</span><input name="city" value="${fp.city}" maxlength="80"></label>
      </div>
      <p class="muted small">O CPF fica criptografado. No Receita Saúde, o recibo é emitido no app da Receita Federal, com a <b>sua</b> conta gov.br: o sistema prepara os dados de cada recibo para você copiar.</p>
      <div class="actions"><button class="btn">Salvar meus dados fiscais</button></div>
    </form>
    ${fp.saved && fp.kind === 'pj' ? html`<section class="card"><h2>Nota fiscal com o meu CNPJ</h2>
      <p>${!Nfse.cnpjOk(nc.cnpj) ? html`<span class="badge b-agendada">Aguardando CNPJ</span>` : nc.enabled && nr.ok ? html`<span class="badge b-realizada">Ligada · ${Nfse.MODES[nc.mode].split(':')[0]}</span>` : html`<span class="badge b-cancelada">${nr.ok ? 'Pronta, desligada' : `Falta: ${nr.missing.join(', ')}`}</span>`}</p>
      <p class="muted small">CNPJ, inscrição municipal, serviço (4.16 — psicologia) e a conta do Asaas da sua empresa. As notas saem sozinhas, em lote ou uma a uma, só para os pacientes que pagam direto para você.</p>
      <div class="actions"><a class="btn" href="/conta/fiscal/nfse">Configurar a nota fiscal</a><a class="btn ghost" href="/financeiro/notas${can(req.user, 'financeiro') ? '?de=eu' : ''}">Minhas notas</a></div></section>`
      : fp.saved ? html`<section class="card"><h2>Recibos no Receita Saúde</h2><p class="muted small">Os recebimentos direto para você aparecem no assistente, um a um, com os dados prontos para copiar no app.</p>
      <div class="actions"><a class="btn" href="/financeiro/receita-saude">Abrir o assistente do Receita Saúde</a></div></section>` : ''}`,
  }));
});
r.post('/fiscal', async (req, res) => {
  if (!hasPix(req.user)) return res.status(403).send('Sem permissão');
  const b = req.body;
  if (b.cpf && !Fiscal.cpfValid(b.cpf)) return res.flash('CPF inválido. Confira os números.', 'err').redirect('/conta/fiscal');
  await Fiscal.saveProfile(req.user.id, { kind: b.kind, fullName: str(b.fullName, 160), cpf: b.cpf, crp: str(b.crp, 30), address: str(b.address, 200), city: str(b.city, 80) });
  await audit(req, 'conta-dados-fiscais', b.kind === 'pj' ? 'pj' : 'pf');
  res.flash(b.kind === 'pj' ? 'Dados fiscais salvos. Agora configure a nota fiscal com o seu CNPJ.' : 'Dados fiscais salvos.').redirect('/conta/fiscal');
});

// ---------- certificado digital A1 ----------
r.post('/certificado', async (req, res) => {
  if (!can(req.user, 'prontuario')) return res.status(403).send('Sem permissão');
  const b64 = String(req.body.pfx || '');
  if (!b64) return res.flash('Escolha o arquivo do certificado (.pfx ou .p12).', 'err').redirect('/conta#certificado');
  const buf = Buffer.from(b64, 'base64');
  if (buf.length < 500 || buf.length > 60 * 1024) return res.flash('Arquivo inválido. Envie o certificado A1 (.pfx ou .p12).', 'err').redirect('/conta#certificado');
  try {
    const info = await ICP.saveCertificate(req.user.id, buf, String(req.body.senha || ''), !!req.body.lembrar);
    await audit(req, 'conta-certificado', `${info.issuer} até ${info.validTo.toISOString().slice(0, 10)}`);
    res.flash(`Certificado cadastrado: ${info.name}, válido até ${info.validTo.toLocaleDateString('pt-BR')}.`);
  } catch (e) { res.flash(e.message, 'err'); }
  res.redirect('/conta#certificado');
});
r.post('/certificado/nuvem', async (req, res) => {
  if (!can(req.user, 'prontuario')) return res.status(403).send('Sem permissão');
  const k = String(req.body.provider || '');
  const ok = !k || Cloud.available(await Cloud.config()).includes(k);
  if (!ok) return res.flash('Certificadora não liberada pela clínica.', 'err').redirect('/conta#certificado');
  await Cloud.setUserChoice(req.user.id, k);
  await audit(req, 'conta-certificado-nuvem', k || 'nenhum');
  res.flash(k ? `Certificado em nuvem: ${Cloud.PROVIDERS[k].label}.` : 'Certificado em nuvem desligado.').redirect('/conta#certificado');
});
r.post('/certificado/remover', async (req, res) => {
  await ICP.removeCertificate(req.user.id);
  await audit(req, 'conta-certificado-remover');
  res.flash('Certificado removido.').redirect('/conta#certificado');
});

// ---------- tema (claro / escuro / automático) ----------
r.post('/pix', async (req, res) => {
  if (!hasPix(req.user)) return res.status(403).send('Sem permissão');
  const type = KEY_TYPES[req.body.pix_type] ? req.body.pix_type : null;
  if (type && !normalizeKey(type, req.body.pix_key)) return res.flash(`Chave Pix inválida para o tipo “${KEY_TYPES[type]}”.`, 'err').redirect('/conta#pix');
  await Fin.savePix(req.user.id, type, type ? str(req.body.pix_key, 140) : '');
  await audit(req, 'conta-pix', type || 'removida');
  res.flash(type ? 'Chave Pix salva.' : 'Chave Pix removida.').redirect('/conta#pix');
});

r.post('/tema', (req, res) => {
  const t = ['escuro', 'auto'].includes(req.body.tema) ? req.body.tema : 'claro';
  const secure = req.secure || req.get('x-forwarded-proto') === 'https' ? '; Secure' : '';
  // claro é o padrão: apaga a preferência; escuro/automático ficam salvos por 1 ano
  res.append('Set-Cookie', t === 'claro' ? `tema=; Path=/; Max-Age=0; SameSite=Lax${secure}` : `tema=${t}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`);
  res.flash(t === 'escuro' ? 'Tema escuro ativado.' : t === 'auto' ? 'Tema automático: segue o modo claro/escuro do aparelho.' : 'Tema claro ativado.').redirect('/conta#aparencia');
});

// ---------- foto do perfil ----------
r.get('/foto/original', async (req, res) => {
  const row = await one('SELECT photo_orig FROM users WHERE id = ?', [req.user.id]);
  if (!row?.photo_orig) return res.sendStatus(404);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(row.photo_orig);
});
r.get('/foto/:id', async (req, res) => {
  const row = await one('SELECT photo, photo_v FROM users WHERE id = ?', [Number(req.params.id) || 0]);
  if (!row?.photo) return res.sendStatus(404);
  res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
  res.send(row.photo);
});

r.post('/foto', async (req, res) => {
  const m = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.photo || ''));
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  // JPEG válido (FF D8 … FF D9), até 300 KB — o navegador já envia a foto reduzida.
  if (!buf || buf.length < 200 || buf.length > 300 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[buf.length - 2] !== 0xff || buf[buf.length - 1] !== 0xd9) {
    return res.flash('Não foi possível usar essa imagem. Escolha outra foto (JPG, PNG ou WebP).', 'err').redirect('/conta#foto');
  }
  await q('UPDATE users SET photo = ?, photo_v = photo_v + 1 WHERE id = ?', [buf, req.user.id]);
  await audit(req, 'conta-foto');
  res.flash('Foto atualizada.').redirect('/conta#foto');
});

// Original da foto (até 1600 px), para reenquadrar depois sem perder qualidade. Só o próprio usuário vê.
r.post('/foto/original', express.raw({ type: 'image/jpeg', limit: '3mb' }), async (req, res) => {
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || buf.length < 200 || buf.length > 3 * 1024 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8) return res.status(400).json({ ok: false, error: 'Imagem inválida.' });
  await q('UPDATE users SET photo_orig = ? WHERE id = ?', [buf, req.user.id]);
  res.json({ ok: true });
});

r.post('/foto/remover', async (req, res) => {
  await q('UPDATE users SET photo = NULL, photo_orig = NULL, photo_v = 0 WHERE id = ?', [req.user.id]);
  res.flash('Foto removida.').redirect('/conta#foto');
});

r.post('/senha', async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  const { current, password, password2 } = req.body;
  if (!(await bcrypt.compare(String(current || ''), u.password_hash))) return res.flash('Senha atual incorreta.', 'err').redirect('/conta');
  if (!password || password.length < 10 || password !== password2) return res.flash('A nova senha precisa ter 10+ caracteres e ser repetida igual.', 'err').redirect('/conta');
  await q('UPDATE users SET password_hash = ? WHERE id = ?', [await bcrypt.hash(password, 12), u.id]);
  await audit(req, 'senha-alterar');
  res.flash('Senha alterada.').redirect('/conta');
});

// ---------- troca obrigatória da senha provisória ----------
r.get('/trocar-senha', (req, res) => {
  if (!req.user.must_change_password) return res.redirect('/conta');
  send(res, bare('Crie sua senha', html`
  <div class="auth"><div class="auth-card">
    ${logoTag('auth-logo')}
    <p class="eyebrow">Primeiro acesso</p><h1>Crie sua senha</h1>
    ${req.flash ? html`<div class="flash ${req.flash.type || 'ok'}">${req.flash.text}</div>` : ''}
    <p class="muted">Olá, ${req.user.name.split(' ')[0]}! Troque a senha provisória por uma senha só sua (mínimo 10 caracteres).</p>
    <form method="post" action="/conta/trocar-senha" class="stack">
      <label class="fld"><span>Nova senha</span><input type="password" name="password" minlength="10" required autocomplete="new-password" autofocus></label>
      <label class="fld"><span>Repita a nova senha</span><input type="password" name="password2" minlength="10" required autocomplete="new-password"></label>
      <button class="btn">Salvar e entrar</button>
    </form>
    <form method="post" action="/logout" class="stack" style="margin-top:12px"><button class="btn ghost">Sair</button></form>
  </div></div>`, 'bare auth-bg'));
});

r.post('/trocar-senha', async (req, res) => {
  const { password, password2 } = req.body;
  if (!password || password.length < 10 || password !== password2) return res.flash('A senha precisa ter 10+ caracteres e ser repetida igual.', 'err').redirect('/conta/trocar-senha');
  const u = await one('SELECT password_hash FROM users WHERE id = ?', [req.user.id]);
  if (await bcrypt.compare(password, u.password_hash)) return res.flash('Escolha uma senha diferente da provisória.', 'err').redirect('/conta/trocar-senha');
  await q('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [await bcrypt.hash(password, 12), req.user.id]);
  await audit(req, 'senha-definir');
  res.flash('Senha criada. Bem-vindo(a)! Recomendamos ativar a verificação em duas etapas abaixo.').redirect(can(req.user, 'cadastro') || can(req.user, 'agenda') ? '/conta' : homeFor(req.user));
});

r.post('/2fa/ativar', async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!u.totp_secret || !verifyTotp(decrypt(u.totp_secret), req.body.code)) return res.flash('Código inválido. Confira o horário do celular e tente de novo.', 'err').redirect('/conta');
  await q('UPDATE users SET totp_enabled = 1 WHERE id = ?', [u.id]);
  await audit(req, '2fa-ativar');
  res.flash('Verificação em duas etapas ativada.').redirect('/conta');
});

r.post('/2fa/desativar', async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = ?', [req.user.id]);
  if (!verifyTotp(decrypt(u.totp_secret), req.body.code)) return res.flash('Código inválido.', 'err').redirect('/conta');
  await q('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [u.id]);
  await audit(req, '2fa-desativar');
  res.flash('Verificação em duas etapas desativada.').redirect('/conta');
});

// ---------- push ----------
r.post('/push/inscrever', express.json({ limit: '10kb' }), async (req, res) => {
  try {
    await PUSH.subscribe(req.user.id, req.body?.subscription, req.body?.device);
    await audit(req, 'push-ativar', String(req.body?.device || '').slice(0, 60));
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
r.post('/push/cancelar', express.json({ limit: '10kb' }), async (req, res) => {
  if (req.body?.endpoint) await PUSH.unsubscribe(req.user.id, String(req.body.endpoint));
  res.json({ ok: true });
});
r.post('/push/teste', async (req, res) => {
  const n = await PUSH.sendToUser(req.user.id, { title: '🔔 Teste do sistema do consultório', body: 'As notificações estão funcionando neste aparelho.', url: '/conta#push', tag: 'teste' });
  res.json({ ok: n > 0, sent: n });
});
r.post('/push/remover', async (req, res) => {
  await PUSH.unsubscribe(req.user.id, Number(req.body.id));
  res.flash('Aparelho removido das notificações.').redirect('/conta#push');
});

export default r;

// Imagem da assinatura (documentos psicológicos)
r.post('/assinatura', express.raw({ type: () => true, limit: '600kb' }), async (req, res) => {
  if (!can(req.user, 'prontuario')) return res.status(403).json({ ok: false, error: 'Sem permissão.' });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const mime = String(req.get('content-type') || '').split(';')[0];
  const ok = buf && ((mime === 'image/png' && buf.slice(1, 4).toString() === 'PNG') || (mime === 'image/jpeg' && buf[0] === 0xff && buf[1] === 0xd8));
  if (!ok) return res.status(400).json({ ok: false, error: 'Envie uma imagem PNG ou JPG.' });
  if (buf.length > 500 * 1024) return res.status(400).json({ ok: false, error: 'A imagem passa de 500 KB.' });
  await q('UPDATE users SET signature_png = ? WHERE id = ?', [`data:${mime};base64,${buf.toString('base64')}`, req.user.id]);
  await audit(req, 'conta-assinatura');
  res.json({ ok: true, redirect: '/conta#assinatura' });
});
r.post('/assinatura/remover', async (req, res) => {
  await q('UPDATE users SET signature_png = NULL WHERE id = ?', [req.user.id]);
  res.flash('Assinatura removida.').redirect('/conta#assinatura');
});

// Chave própria da API para a escrita de documentos com IA
r.post('/ia', async (req, res) => {
  if (req.body.remover) { await q('UPDATE users SET ai_key_enc = NULL WHERE id = ?', [req.user.id]); await audit(req, 'conta-ia-chave-remover'); return res.flash('Chave removida.').redirect('/conta#ia'); }
  const provider = PsyDocs.PROVIDERS[req.body.ai_provider] ? req.body.ai_provider : 'anthropic';
  const k = str(req.body.ai_key, 300); const base = str(req.body.ai_base_url, 300); const model = str(req.body.ai_model, 120);
  const cur = await one('SELECT ai_key_enc, ai_provider FROM users WHERE id = ?', [req.user.id]);
  if (!k && (!cur.ai_key_enc || (cur.ai_provider || 'anthropic') !== provider)) return res.flash('Informe a chave da API deste provedor.', 'err').redirect('/conta#ia');
  if (k) {
    const bad = provider === 'anthropic' ? (/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k) ? null : 'Chave inválida: a da Anthropic começa com sk-ant-.') : AP.checkKey(provider, k);
    if (bad) return res.flash(bad, 'err').redirect('/conta#ia');
  }
  if (provider === 'custom' && AP.checkUrl(base)) return res.flash(AP.checkUrl(base), 'err').redirect('/conta#ia');
  if (provider !== 'anthropic' && !model) return res.flash('Informe o modelo do provedor (ex.: o nome que aparece no painel dele).', 'err').redirect('/conta#ia');
  await q(`UPDATE users SET ${k ? 'ai_key_enc = ?, ' : ''}ai_provider = ?, ai_model = ?, ai_base_url = ? WHERE id = ?`, [...(k ? [encrypt(k)] : []), provider, model || null, base || null, req.user.id]);
  await audit(req, 'conta-ia-chave');
  res.flash('Configuração de IA salva (a chave fica guardada criptografada).').redirect('/conta#ia');
});
