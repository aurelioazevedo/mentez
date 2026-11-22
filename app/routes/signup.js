// Mentez — criar conta (app.mentez.com.br/criar-conta): a clínica se cadastra sozinha e começa o teste grátis.
// Cria a clínica (banco e chaves próprios), o acesso de administrador com a senha escolhida e a ficha de identidade,
// e entra automaticamente no endereço da clínica (token de uso único, válido por 2 minutos).
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as T from '../lib/tenancy.js';
import * as Evolution from '../lib/evolution.js';
import * as Billing from '../lib/billing.js';
import * as Referral from '../lib/referral.js';
import { parseCookies } from '../lib/auth.js';
import * as Brand from '../lib/brand.js';
import { q, one, migrate, audit } from '../lib/db.js';
import { html, raw, bare, VERSION } from '../lib/html.js';
import { send, str } from '../lib/router.js';
import { startSession } from '../lib/auth.js';
import * as RL from '../lib/ratelimit.js';

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const crpOk = (c) => /^\d{2}\/\d{3,7}$/.test(c);
const slugify = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/^(dra?|clinica|consultorio|psicologa?|psi)\.?\s+/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);

// ---------- entrada automática (token assinado com a chave mestra) ----------
const used = new Map(); // nonce → expira (uso único)
const mac = (b) => crypto.createHmac('sha256', crypto.createHash('sha256').update(`mentez-entrar|${process.env.MENTEZ_MASTER_KEY || ''}`).digest()).update(b).digest('base64url');
function loginToken(slug, uid) { const b = Buffer.from(JSON.stringify({ slug, uid, exp: Date.now() + 120e3, n: crypto.randomBytes(9).toString('base64url') })).toString('base64url'); return `${b}.${mac(b)}`; }
export async function autoLogin(req, res) {
  const t = T.current(); const tok = String(req.query.t || '');
  const [b, m] = tok.split('.');
  let ok = null;
  if (t && b && m && m.length === mac(b).length && crypto.timingSafeEqual(Buffer.from(m), Buffer.from(mac(b)))) {
    try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); if (o.slug === t.slug && o.exp > Date.now() && !used.has(o.n)) ok = o; } catch { /* inválido */ }
  }
  for (const [n, e] of used) if (e < Date.now()) used.delete(n);
  if (!ok) return res.redirect('/login');
  used.set(ok.n, ok.exp);
  const u = await one('SELECT * FROM users WHERE id = ? AND active = 1', [ok.uid]);
  if (!u) return res.redirect('/login');
  startSession(res, u);
  await q('UPDATE users SET last_login_at = NOW() WHERE id = ?', [u.id]);
  res.redirect('/?bemvindo=1');
}

// ---------- páginas (montadas no Painel/plataforma) ----------
export function mount(r, layout) {
  // link curto de indicação: app.mentez.com.br/i/CODIGO
  r.get('/i/:code', (req, res) => res.redirect(`/criar-conta?ref=${encodeURIComponent(Referral.cleanCode(req.params.code))}`));
  r.get('/criar-conta', async (req, res) => {
    // indicação: ?ref= (vinda do site ou do link) fica guardada por 30 dias neste navegador
    let code = Referral.cleanCode(req.query.ref || parseCookies(req).mz_ref);
    const rc = await Referral.config();
    const ref = code && rc.enabled ? await Referral.byCode(code) : null;
    if (!ref) code = '';
    else if (req.query.ref) res.append('Set-Cookie', `mz_ref=${code}; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`);
    const days = Billing.TRIAL_DAYS() + (ref ? rc.bonusDays : 0);
    const info = await Billing.publicInfo().catch(() => ({ plans: [] }));
    const from = info.plans.length ? Math.min(...info.plans.map((p) => Number(p.price))) : null;
    const brl = (v) => Number(v).toLocaleString('pt-BR', { minimumFractionDigits: Number(v) % 1 ? 2 : 0, maximumFractionDigits: 2 });
    const flash = req.flash ? html`<div class="lp-flash ${req.flash.type || 'ok'}" role="alert">${req.flash.text}</div>` : '';
    const ck = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>');
    const arrow = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>');
    const I = (d) => raw(`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`);
    const benefits = [
      [I('<path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3z"/><path d="M8.5 11.5h7M8.5 14.5h4"/>'), 'Atendente virtual no WhatsApp', 'Responde, marca, remarca e confirma sessões enquanto você atende. Você assume a conversa quando quiser.'],
      [I('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M8.5 15l2 2 4-4"/>'), 'Agenda e lembretes automáticos', 'Lembrete com confirmação pelo WhatsApp e lista de espera que oferece o horário vago sozinha.'],
      [I('<path d="M7 3h7l4 4v14H7z"/><path d="M14 3v4h4M10 12h5M10 16h5"/><rect x="2.5" y="10" width="4" height="5" rx="1"/>'), 'Prontuário que só você lê', 'Criptografado, com acesso só de quem atendeu, e documentos no padrão do CFP com assinatura eletrônica.'],
      [I('<rect x="2.5" y="6" width="19" height="13" rx="2"/><circle cx="12" cy="12.5" r="2.6"/><path d="M6 9.5v.01M18 15.5v.01"/>'), 'Financeiro sem planilha', 'Cobrança por Pix, recibos, repasses e o que cada paciente deve — num painel só.'],
      [I('<rect x="3" y="5" width="13" height="12" rx="2"/><path d="M16 9.5l5-3v11l-5-3"/>'), 'Teleconsulta própria', 'Sala on-line segura, sem instalar nada, com link enviado ao paciente automaticamente.'],
      [I('<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>'), 'App do paciente', 'Agendamentos, exercícios, escalas e check-in de humor no celular do paciente.'],
    ];
    const faq = [
      ['Preciso cadastrar cartão de crédito?', `Não. O teste de ${days} dias é completo e não pede cartão. Você só escolhe um plano se quiser continuar.`],
      ['O que acontece quando o teste acaba?', 'Você escolhe um plano e segue usando, com tudo o que já cadastrou. Se não assinar, o acesso fica pausado e seus dados continuam guardados.'],
      ['Meus dados e os dos pacientes ficam seguros?', 'Cada clínica tem um banco de dados separado, os dados sensíveis são criptografados e o prontuário só é lido por quem atendeu. Tudo em conformidade com a LGPD.'],
      ['Funciona no celular?', 'Sim. A Mentez funciona no navegador do computador, do tablet e do celular, e pode ser instalada como aplicativo na tela inicial.'],
      ['Serve para clínica com vários profissionais?', 'Sim. Há planos para quem atende sozinho e para clínicas com equipe, salas, recepção e repasses.'],
      ['E se eu tiver dúvidas para configurar?', 'O assistente da Mentez responde na hora dentro do sistema, e a equipe atende pelos chamados de suporte.'],
    ];
    send(res, bare('Teste grátis', html`<div class="lp">
      <header class="lp-top"><div class="lp-wrap"><a class="lp-brand" href="https://mentez.com.br" aria-label="Mentez — site"><img src="/static/img/site/simbolo-claro.png" alt="" width="32" height="32">mentez</a>
        <nav><span class="lp-hide-s">Já tem conta?</span> <a href="/inicio">Entrar</a></nav></div></header>

      <section class="lp-hero">
        <div class="lp-bg" aria-hidden="true"><span class="lp-orb o1"></span><span class="lp-orb o2"></span><span class="lp-orb o3"></span><span class="lp-grid"></span></div>
        <div class="lp-wrap lp-hero-in">
          <div class="lp-pitch">
            ${ref ? html`<p class="lp-ref">🎁 Indicação de <b>${ref.name}</b>: você ganha <b>${rc.bonusDays} dias a mais</b> de teste.</p>` : ''}
            <span class="lp-kick">Teste grátis · ${days} dias</span>
            <h1>Seu consultório organizado <em>hoje.</em> Pague só se fizer sentido.</h1>
            <p class="lp-lede">Agenda, prontuário, financeiro e WhatsApp num só lugar — com um atendente de IA que confirma e remarca sessões enquanto você está atendendo.</p>
            <ul class="lp-checks"><li>${ck}<span><b>${days} dias grátis</b>, com tudo liberado</span></li><li>${ck}<span><b>Sem cartão de crédito</b> para começar</span></li><li>${ck}<span><b>Pronto em 2 minutos</b>, no seu endereço próprio</span></li><li>${ck}<span><b>Cancele quando quiser</b>, sem multa</span></li></ul>
            <div class="lp-shot lp-hide-m"><div class="lp-bar"><i></i><i></i><i></i><span>suaclinica.mentez.com.br/agenda</span></div><img src="/static/img/site/agenda.webp" alt="Agenda semanal da Mentez" width="1920" height="1200">
              <div class="lp-float f1">${ck}<div><b>Sessão confirmada</b><small>Carla respondeu “1” ao lembrete</small></div></div>
              <div class="lp-float f2">${ck}<div><b>Pix recebido · R$ 180,00</b><small>baixa automática no financeiro</small></div></div></div>
          </div>

          <form method="post" action="/criar-conta" class="lp-form" id="cadastro" data-signup>
            <div class="lp-form-h"><b>Crie sua conta grátis</b><small>Leva menos de 2 minutos</small></div>
            ${flash}
            ${RL.botFields()}
            ${code ? html`<input type="hidden" name="ref" value="${code}">` : ''}
            <label class="lp-fld"><span>Seu nome completo</span><input name="name" required maxlength="120" autocomplete="name" placeholder="Ana Souza"></label>
            <div class="lp-row lp-l"><label class="lp-fld"><span>Tratamento</span><select name="title"><option value="Dra.">Dra.</option><option value="Dr.">Dr.</option></select></label>
              <label class="lp-fld"><span>CRP</span><input name="crp" required maxlength="10" placeholder="09/12345" pattern="\\d{2}/\\d{3,7}" inputmode="numeric"></label></div>
            <label class="lp-fld"><span>Nome do consultório ou clínica</span><input name="clinic" required maxlength="120" placeholder="Consultório Ana Souza" data-signup-clinic></label>
            <label class="lp-fld"><span>Seu endereço na Mentez</span><span class="lp-slug"><input name="slug" required maxlength="40" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" data-signup-slug autocomplete="off" placeholder="anasouza"><small>.${T.baseDomain()}</small></span><small class="lp-help" data-signup-slug-msg>Letras minúsculas, números e hífen.</small></label>
            <div class="lp-row"><label class="lp-fld"><span>E-mail</span><input type="email" name="email" required maxlength="190" autocomplete="email" placeholder="voce@email.com"></label>
              <label class="lp-fld"><span>WhatsApp</span><input name="phone" required maxlength="40" inputmode="tel" autocomplete="tel" placeholder="(62) 99999-9999"></label></div>
            <div class="lp-row lp-r"><label class="lp-fld"><span>Cidade</span><input name="city" maxlength="80" autocomplete="address-level2"></label>
              <label class="lp-fld"><span>UF</span><input name="uf" maxlength="2" autocomplete="address-level1" placeholder="GO"></label></div>
            <label class="lp-fld"><span>Crie uma senha <small>(mínimo 10 caracteres)</small></span><input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
            <label class="lp-terms"><input type="checkbox" name="terms" value="1" required> <span>Li e aceito os <a href="/termos-de-uso" target="_blank">Termos de Uso</a> e a <a href="/privacidade" target="_blank">Política de Privacidade</a>.</span></label>
            <button class="lp-btn lp-btn-big">Começar meu teste grátis ${arrow}</button>
            <p class="lp-secure">🔒 Seus dados ficam protegidos e criptografados · LGPD</p>
          </form>
        </div>
      </section>

      <section class="lp-strip"><div class="lp-wrap"><span>Feito para psicólogas, psicólogos e clínicas de psicologia</span><span>Prontuário no padrão do CFP</span><span>Cada clínica com banco de dados próprio</span><span>Suporte humano por chamados</span></div></section>

      <section class="lp-sec"><div class="lp-wrap">
        <span class="lp-kick dark">Como funciona</span><h2>Em minutos você já está <em>atendendo</em> com a Mentez.</h2>
        <ol class="lp-steps"><li><b>1</b><h3>Crie a conta</h3><p>Preencha o formulário e entre na hora no endereço da sua clínica.</p></li>
          <li><b>2</b><h3>Conecte o WhatsApp</h3><p>Leia o QR code e ligue os lembretes automáticos e o atendente virtual.</p></li>
          <li><b>3</b><h3>Cadastre pacientes e agende</h3><p>Monte sua agenda e deixe confirmações e cobranças no automático.</p></li></ol>
      </div></section>

      <section class="lp-sec lp-alt"><div class="lp-wrap">
        <span class="lp-kick dark">Tudo incluído no teste</span><h2>O consultório inteiro num só lugar.</h2>
        <div class="lp-cards">${benefits.map(([ic, t, d]) => html`<article class="lp-card"><span class="lp-ic">${ic}</span><h3>${t}</h3><p>${d}</p></article>`)}</div>
      </div></section>

      <section class="lp-sec"><div class="lp-wrap lp-split">
        <figure class="lp-photo"><img src="/static/img/site/sessao-escuta.webp" alt="Psicóloga em atendimento, ouvindo a paciente" width="900" height="1100" loading="lazy"></figure>
        <div><span class="lp-kick dark">Sem risco</span><h2>Experimente com <em>calma.</em></h2>
          <ul class="lp-guar"><li><b>Nada de cartão.</b> O teste é completo e não pede dados de pagamento.</li><li><b>Seus dados são seus.</b> Exporte tudo quando quiser; nada fica preso.</li>
            <li><b>Sem fidelidade.</b> Assine por mês e cancele quando quiser, sem multa.</li><li><b>Gente de verdade.</b> Assistente na hora e equipe pelos chamados de suporte.</li></ul>
          ${from != null ? html`<p class="lp-price">Depois do teste, planos <b>a partir de R$ ${brl(from)}/mês</b>. <a href="https://mentez.com.br/precos/">Ver planos</a></p>` : ''}
          <a class="lp-btn" href="#cadastro">Quero testar grátis ${arrow}</a></div>
      </div></section>

      <section class="lp-sec lp-alt"><div class="lp-wrap lp-faq-w">
        <div><span class="lp-kick dark">Perguntas frequentes</span><h2>Ficou alguma dúvida?</h2><p class="lp-muted">Se não encontrar aqui, escreva para <a href="mailto:${info.contact || 'contato@mentez.com.br'}">${info.contact || 'contato@mentez.com.br'}</a>.</p></div>
        <div class="lp-faq">${faq.map(([q, a], i) => html`<details ${i === 0 ? raw('open') : ''}><summary>${q}</summary><p>${a}</p></details>`)}</div>
      </div></section>

      <section class="lp-final"><div class="lp-bg" aria-hidden="true"><span class="lp-orb o1"></span><span class="lp-orb o2"></span></div><div class="lp-wrap">
        <h2>Comece agora. <em>Leva 2 minutos.</em></h2><p>${days} dias grátis, sem cartão, com tudo liberado.</p><a class="lp-btn lp-btn-big" href="#cadastro">Criar minha conta grátis ${arrow}</a></div></section>

      <footer class="lp-foot"><div class="lp-wrap"><span>© Mentez · Inteligência para cuidar de quem cuida</span><nav><a href="https://mentez.com.br">Site</a><a href="/termos-de-uso">Termos de Uso</a><a href="/privacidade">Privacidade</a></nav></div></footer>
    </div>`, 'lp-body', req, { suffix: 'Mentez', css: ['https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@500;600&display=swap', `/static/signup.css?v=${VERSION}`], desc: `Teste a Mentez grátis por ${days} dias, sem cartão: agenda, prontuário, financeiro e WhatsApp para psicólogos e clínicas.` }));
  });

  r.get('/criar-conta/endereco', async (req, res) => {
    const s = str(req.query.s, 40).toLowerCase();
    const sug = slugify(req.query.n);
    if (!s) return res.json({ ok: false, suggestion: sug });
    if (!T.SLUG_RE.test(s) || T.RESERVED.has(s)) return res.json({ ok: false, reason: 'Use de 3 a 40 letras minúsculas, números ou hífen.' });
    const taken = await T.pone('SELECT id FROM tenants WHERE slug = ?', [s]);
    res.json(taken ? { ok: false, reason: 'Este endereço já está em uso.' } : { ok: true });
  });

  r.post('/criar-conta', RL.limit({ name: 'mentez-cadastro', windowMs: 3600e3, max: 5 }), RL.botGuard, async (req, res) => {
    const b = req.body;
    const d = { name: str(b.name, 120), title: b.title === 'Dr.' ? 'Dr.' : 'Dra.', crp: str(b.crp, 10), clinic: str(b.clinic, 120), slug: str(b.slug, 40).toLowerCase(), email: str(b.email, 190).toLowerCase(), phone: str(b.phone, 40), city: str(b.city, 80), uf: str(b.uf, 2).toUpperCase() };
    const err = !d.name || d.name.split(/\s+/).length < 2 ? 'Informe seu nome completo.' : !crpOk(d.crp) ? 'Informe o CRP no formato 00/00000.' : !d.clinic ? 'Informe o nome do consultório.'
      : !emailOk(d.email) ? 'Informe um e-mail válido.' : d.phone.replace(/\D/g, '').length < 10 ? 'Informe o WhatsApp com DDD.' : String(b.password || '').length < 10 ? 'A senha precisa ter pelo menos 10 caracteres.' : !b.terms ? 'É preciso aceitar os Termos de Uso.' : null;
    if (err) return res.flash(err, 'err').redirect('/criar-conta');
    let t;
    try { t = await T.createTenant({ slug: d.slug, name: d.clinic, ownerName: d.name, ownerEmail: d.email, plan: 'profissional', actor: `cadastro:${d.email}` }); }
    catch (e) { return res.flash(e.message, 'err').redirect('/criar-conta'); }
    await T.pq("UPDATE tenants SET billing_status = 'teste', trial_ends_at = DATE_ADD(NOW(), INTERVAL ? DAY), owner_phone = ?, owner_crp = ?, signup_ip = ? WHERE id = ?", [Billing.TRIAL_DAYS(), d.phone, d.crp, String(req.ip || '').slice(0, 64), t.id]);
    T.clearCache();
    if (b.ref) await Referral.attach(t, b.ref, { email: d.email }).catch((e) => console.error('indicação:', e.message));
    t = await T.bySlug(d.slug);
    const uid = await T.run(t, async () => {
      await migrate();
      const r2 = await q("INSERT INTO users (name, email, crp, title, phone, role, attends, modalities, password_hash, is_master) VALUES (?,?,?,?,?,'admin',1,'online,presencial',?,1)", [d.name, d.email, d.crp, d.title, d.phone, await bcrypt.hash(String(b.password), 12)]);
      await Brand.save({ name: d.clinic, short: d.name, proName: `${d.title} ${d.name}`, proFirst: `${d.title} ${d.name.split(/\s+/)[0]}`, proRole: d.title === 'Dr.' ? 'Psicólogo' : 'Psicóloga', crp: d.crp, phone: d.phone, email: d.email, city: d.city, uf: d.uf });
      await audit({ ip: req.ip, user: { id: r2.insertId } }, 'conta-criada', `cadastro Mentez ${d.slug}`);
      return r2.insertId;
    });
    await T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', [d.email, 'cadastro-teste', t.id, `${d.slug} · CRP ${d.crp}`]);
    Evolution.provisionLater(t, `cadastro:${d.email}`); // instância do WhatsApp: a clínica lê o QR code no primeiro acesso
    const scheme = req.protocol === 'http' && process.env.NODE_ENV !== 'production' ? 'http' : 'https';
    const host = new URL(t.env.PUBLIC_URL).host + (scheme === 'http' && req.get('host')?.includes(':') ? `:${req.get('host').split(':')[1]}` : '');
    res.redirect(`${scheme}://${host}/_mentez/entrar?t=${encodeURIComponent(loginToken(t.slug, uid))}`);
  });

  // Termos e privacidade da Mentez (o contrato com as clínicas). Texto-base: revisar com assessoria jurídica.
  r.get('/termos-de-uso', (req, res) => send(res, layout(req, 'Termos de Uso', html`<article class="card legal-mz"><h1>Termos de Uso da Mentez</h1>
    <p class="muted small">Versão preliminar · novembro de 2026</p>
    <h2>1. O serviço</h2><p>A Mentez é um software de gestão para profissionais e clínicas de psicologia, oferecido por assinatura mensal. Cada clínica tem endereço, banco de dados e chaves de criptografia próprios.</p>
    <h2>2. Conta e acesso</h2><p>Quem cria a conta declara ser profissional de psicologia com registro ativo no CRP, ou representante autorizado da clínica, e responde pelos usuários que cadastrar. Senhas são pessoais.</p>
    <h2>3. Teste grátis e pagamento</h2><p>O teste grátis dura ${Billing.TRIAL_DAYS()} dias, sem cartão. Depois, o uso depende da assinatura de um plano, cobrada mensalmente. Com mensalidade em aberto há mais de ${Billing.GRACE_DAYS()} dias, o acesso fica restrito à tela de pagamento até a regularização; os dados continuam guardados.</p>
    <h2>4. Dados e LGPD</h2><p>A clínica é a <b>controladora</b> dos dados dos seus pacientes; a Mentez é a <b>operadora</b> e trata esses dados apenas para prestar o serviço, conforme as instruções da clínica. A Mentez não acessa o conteúdo clínico, não vende dados e mantém medidas de segurança como criptografia, separação por clínica, registro de acessos e cópias de segurança.</p>
    <h2>5. Responsabilidades da clínica</h2><p>Registrar os atendimentos conforme as normas do Conselho Federal de Psicologia, obter as autorizações necessárias dos pacientes (por exemplo, para gravação) e usar o sistema de acordo com a lei e o Código de Ética Profissional do Psicólogo.</p>
    <h2>6. Cancelamento</h2><p>A clínica pode cancelar a qualquer momento, sem multa. Antes do cancelamento, pode exportar os dados. Após o cancelamento, os dados são mantidos pelo prazo combinado e depois excluídos, salvo obrigação legal de guarda.</p>
    <h2>7. Disponibilidade</h2><p>A Mentez se empenha em manter o serviço disponível, com monitoramento e cópias de segurança, mas podem ocorrer interrupções para manutenção ou por falhas de terceiros.</p>
    <h2>8. Alterações</h2><p>Estes termos podem ser atualizados, com aviso prévio às clínicas.</p></article>`)));
  r.get('/privacidade', (req, res) => send(res, layout(req, 'Política de Privacidade', html`<article class="card legal-mz"><h1>Política de Privacidade da Mentez</h1>
    <p class="muted small">Versão preliminar · novembro de 2026</p>
    <p>Esta política trata dos dados de quem contrata e usa a Mentez (profissionais e equipes das clínicas). Os dados dos pacientes são tratados conforme a política de privacidade de cada clínica, que é a controladora; a Mentez atua como operadora.</p>
    <h2>Dados que coletamos</h2><p>Nome, e-mail, telefone, CRP, dados da clínica e de cobrança (CPF ou CNPJ), registros de acesso e uso do sistema.</p>
    <h2>Para que usamos</h2><p>Criar e manter a conta, prestar o serviço, cobrar a assinatura, dar suporte, garantir a segurança e cumprir obrigações legais.</p>
    <h2>Com quem compartilhamos</h2><p>Com prestadores necessários ao serviço: hospedagem (Hostinger, servidores no Brasil), processamento de pagamentos (Asaas) e envio de mensagens. Não vendemos dados.</p>
    <h2>Seus direitos</h2><p>Você pode pedir acesso, correção, portabilidade ou exclusão dos seus dados pelo e-mail contato@mentez.com.br.</p></article>`)));
}
