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
import { html, raw } from '../lib/html.js';
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
    send(res, layout(req, 'Criar conta', html`<section class="mzs">
    <div class="mzs-intro">${ref ? html`<p class="mzs-ref">Indicação de <b>${ref.name}</b>: você ganha <b>${rc.bonusDays} dias a mais</b> de teste grátis.</p>` : ''}<p class="eyebrow">Teste grátis por ${days} dias · sem cartão</p><h1>Sua rotina mais leve, a partir de hoje.</h1>
      <p class="muted">Agenda, prontuário, financeiro, lembretes e teleconsulta num só lugar — para psicólogas, psicólogos e clínicas de psicologia.</p>
      <ul class="mzs-list"><li>Cada clínica no seu endereço, com dados separados e criptografados</li><li>Prontuário que só quem atendeu enxerga</li><li>Cancele quando quiser, sem multa</li></ul></div>
    <form method="post" class="card stack mzs-form" data-signup>
      ${RL.botFields()}
      ${code ? html`<input type="hidden" name="ref" value="${code}">` : ''}
      <label class="fld"><span>Seu nome completo</span><input name="name" required maxlength="120" autocomplete="name"></label>
      <div class="form-grid">
        <label class="fld"><span>Tratamento</span><select name="title"><option value="Dra.">Dra.</option><option value="Dr.">Dr.</option></select></label>
        <label class="fld"><span>CRP</span><input name="crp" required maxlength="10" placeholder="09/12345" pattern="\\d{2}/\\d{3,7}"></label>
      </div>
      <label class="fld"><span>Nome do consultório ou clínica</span><input name="clinic" required maxlength="120" placeholder="Consultório Ana Souza" data-signup-clinic></label>
      <label class="fld"><span>Seu endereço na Mentez</span><span class="mzp-slug"><input name="slug" required maxlength="40" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" data-signup-slug autocomplete="off"><small>.${T.baseDomain()}</small></span><small class="muted" data-signup-slug-msg>Letras minúsculas, números e hífen.</small></label>
      <div class="form-grid">
        <label class="fld"><span>E-mail</span><input type="email" name="email" required maxlength="190" autocomplete="email"></label>
        <label class="fld"><span>WhatsApp</span><input name="phone" required maxlength="40" inputmode="tel" autocomplete="tel" placeholder="(62) 99999-9999"></label>
        <label class="fld"><span>Cidade</span><input name="city" maxlength="80" autocomplete="address-level2"></label>
        <label class="fld"><span>UF</span><input name="uf" maxlength="2" autocomplete="address-level1"></label>
      </div>
      <label class="fld"><span>Crie uma senha (mínimo 10 caracteres)</span><input type="password" name="password" required minlength="10" autocomplete="new-password"></label>
      <label class="check small"><input type="checkbox" name="terms" value="1" required> <span>Li e aceito os <a href="/termos-de-uso" target="_blank">Termos de Uso</a> e a <a href="/privacidade" target="_blank">Política de Privacidade</a> da Mentez.</span></label>
      <button class="btn big">Criar minha conta grátis</button>
      <p class="muted small">Já tem conta? Entre pelo endereço da sua clínica (ex.: suaclinica.${T.baseDomain()}).</p>
    </form></section>`));
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
