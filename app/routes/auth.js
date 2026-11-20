import bcrypt from 'bcryptjs';
import { q, one, audit } from '../lib/db.js';
import { bare, html } from '../lib/html.js';
import { router, send, str } from '../lib/router.js';
import { startSession, startPending, pendingUser, endSession } from '../lib/auth.js';
import { safeEqual, verifyTotp, decrypt } from '../lib/crypto.js';
import { homeFor } from '../lib/perm.js';

const r = router();

const shell = (title, inner, msg) => bare(title, html`
<div class="auth">
  <div class="auth-card">
    <img class="auth-logo logo-light" src="/static/img/logo-terracota.png" alt="Lorrainy Mendes"><img class="auth-logo logo-dark" src="/static/img/logo-creme.png" alt="Lorrainy Mendes">
    <p class="eyebrow">Sistema do consultório</p>
    <h1>${title}</h1>
    ${msg ? html`<div class="flash ${msg.type || 'err'}">${msg.text}</div>` : ''}
    ${inner}
  </div>
  <p class="auth-foot">Acesso restrito · Dados protegidos pela LGPD</p>
</div>`, 'bare auth-bg');

async function hasUsers() {
  return !!(await one('SELECT id FROM users LIMIT 1'));
}

// ---------- primeiro acesso ----------
r.get('/setup', async (req, res) => {
  if (await hasUsers()) return res.redirect('/login');
  send(res, shell('Primeiro acesso', html`
    <form method="post" action="/setup" class="stack">
      <label class="fld"><span>Código de instalação</span><input name="token" required autocomplete="off"></label>
      <label class="fld"><span>Nome</span><input name="name" required value="Lorrainy Mendes"></label>
      <label class="fld"><span>E-mail de acesso</span><input type="email" name="email" required autocomplete="username"></label>
      <label class="fld"><span>Senha (mínimo 10 caracteres)</span><input type="password" name="password" minlength="10" required autocomplete="new-password"></label>
      <label class="fld"><span>Repita a senha</span><input type="password" name="password2" minlength="10" required autocomplete="new-password"></label>
      <button class="btn" type="submit">Criar acesso</button>
    </form>`, req.flash));
});

r.post('/setup', async (req, res) => {
  if (await hasUsers()) return res.redirect('/login');
  const { token, name, email, password, password2 } = req.body;
  const expected = process.env.SETUP_TOKEN;
  if (!expected || !safeEqual(str(token), expected)) return res.flash('Código de instalação inválido.', 'err').redirect('/setup');
  if (!password || password.length < 10 || password !== password2) return res.flash('As senhas precisam ser iguais e ter pelo menos 10 caracteres.', 'err').redirect('/setup');
  const hash = await bcrypt.hash(password, 12);
  await q("INSERT INTO users (name, crp, email, role, password_hash) VALUES (?, '09/23862', ?, 'admin', ?)", [str(name, 120), str(email, 190).toLowerCase(), hash]);
  res.flash('Acesso criado. Entre com seu e-mail e senha.').redirect('/login');
});

// ---------- login ----------
r.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  if (!(await hasUsers())) return res.redirect('/setup');
  send(res, shell('Entrar', html`
    ${req.query.trocar ? html`<p class="flash ok">Entre com o perfil que vai usar agora.</p>` : ''}
    <form method="post" action="/login" class="stack">
      <label class="fld"><span>E-mail</span><input type="email" name="email" required autocomplete="username" autofocus></label>
      <label class="fld"><span>Senha</span><input type="password" name="password" required autocomplete="current-password"></label>
      <button class="btn" type="submit">Entrar</button>
    </form>`, req.flash));
});

async function tooManyAttempts(ip) {
  const row = await one('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND attempted_at > (NOW() - INTERVAL 15 MINUTE)', [ip]);
  return row.n >= 8;
}

r.post('/login', async (req, res) => {
  if (await tooManyAttempts(req.ip)) return res.flash('Muitas tentativas. Aguarde 15 minutos.', 'err').redirect('/login');
  const user = await one('SELECT * FROM users WHERE email = ?', [str(req.body.email, 190).toLowerCase()]);
  const ok = user && (await bcrypt.compare(String(req.body.password || ''), user.password_hash));
  if (ok && !user.active) return res.flash('Este acesso está desativado. Fale com a administradora.', 'err').redirect('/login');
  if (!ok) {
    await q('INSERT INTO login_attempts (ip) VALUES (?)', [req.ip]);
    return res.flash('E-mail ou senha incorretos.', 'err').redirect('/login');
  }
  if (user.totp_enabled) {
    startPending(res, user);
    return res.redirect('/login/2fa');
  }
  await finishLogin(req, res, user, 'login');
});

r.get('/login/2fa', (req, res) => {
  if (!pendingUser(req)) return res.redirect('/login');
  send(res, shell('Verificação em duas etapas', html`
    <p class="muted">Digite o código de 6 dígitos do seu aplicativo autenticador.</p>
    <form method="post" action="/login/2fa" class="stack">
      <label class="fld"><span>Código</span><input name="code" inputmode="numeric" pattern="[0-9 ]{6,7}" autocomplete="one-time-code" required autofocus></label>
      <button class="btn" type="submit">Confirmar</button>
    </form>`, req.flash));
});

r.post('/login/2fa', async (req, res) => {
  const p = pendingUser(req);
  if (!p) return res.redirect('/login');
  if (await tooManyAttempts(req.ip)) return res.flash('Muitas tentativas. Aguarde 15 minutos.', 'err').redirect('/login');
  const user = await one('SELECT * FROM users WHERE id = ?', [p.uid]);
  if (!user || !user.active || !verifyTotp(decrypt(user.totp_secret), req.body.code)) {
    await q('INSERT INTO login_attempts (ip) VALUES (?)', [req.ip]);
    return res.flash('Código inválido.', 'err').redirect('/login/2fa');
  }
  await finishLogin(req, res, user, 'login-2fa');
});

async function finishLogin(req, res, user, action) {
  await q('DELETE FROM login_attempts WHERE ip = ?', [req.ip]);
  await q('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  startSession(res, user);
  req.user = user;
  await audit(req, action);
  res.redirect(user.must_change_password ? '/conta/trocar-senha' : homeFor(user));
}

r.post('/logout', async (req, res) => {
  if (req.user) await audit(req, 'logout');
  endSession(res);
  res.redirect(req.query.trocar ? '/login?trocar=1' : '/login');
});

export default r;
