// Painel da Mentez (app.mentez.com.br): só para a equipe da Mentez. Login próprio, separado do login das clínicas.
// Clínicas: criar, convite de primeiro acesso, suspender/reativar, domínios próprios, uso e histórico.
// Dados clínicos dos pacientes NÃO aparecem aqui — só contagens de uso.
import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import * as T from '../lib/tenancy.js';
import * as Domains from '../lib/domains.js';
import { q, one, migrate } from '../lib/db.js';
import { bare, html, raw, brDate, brDateTime } from '../lib/html.js';
import { router, send, str, int, flash } from '../lib/router.js';
import { parseCookies, checkOrigin } from '../lib/auth.js';
import * as RL from '../lib/ratelimit.js';
import * as Billing from '../lib/billing.js';
import { mount as mountSignup } from './signup.js';
import { money } from '../lib/html.js';

export const handle = router();
// Avisos do Asaas sobre as mensalidades das clínicas (autenticados pelo token cadastrado no webhook)
handle.post('/webhooks/asaas', express.json({ limit: '200kb' }), async (req, res) => {
  if (!(await Billing.webhookAuth(req.get('asaas-access-token')))) return res.sendStatus(401);
  try { await Billing.handleEvent(req.body || {}); } catch (e) { console.error('webhook Mentez:', e.message); return res.sendStatus(500); }
  res.json({ ok: true });
});
handle.use(express.urlencoded({ extended: false, limit: '50kb' }), checkOrigin, flash);
handle.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }); next(); });

// ---------- sessão do painel (cookie assinado com chave derivada da chave mestra) ----------
const COOKIE = 'mz_adm';
const HOURS = 8;
const key = () => crypto.createHash('sha256').update(`mentez-painel|${process.env.MENTEZ_MASTER_KEY || ''}`).digest();
const sign = (o) => { const b = Buffer.from(JSON.stringify(o)).toString('base64url'); return `${b}.${crypto.createHmac('sha256', key()).update(b).digest('base64url')}`; };
function unsign(v) {
  if (!v || !v.includes('.')) return null;
  const [b, mac] = v.split('.');
  const good = crypto.createHmac('sha256', key()).update(b).digest('base64url');
  if (mac.length !== good.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(good))) return null;
  try { const o = JSON.parse(Buffer.from(b, 'base64url').toString()); return o.exp > Date.now() ? o : null; } catch { return null; }
}
const setCookie = (res, v, age) => res.append('Set-Cookie', `${COOKIE}=${v}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
async function ensureTables() {
  await T.pq(`CREATE TABLE IF NOT EXISTS platform_users (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE, password_hash VARCHAR(100) NOT NULL,
    session_version INT NOT NULL DEFAULT 1, last_login_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await T.pq(`CREATE TABLE IF NOT EXISTS platform_settings (k VARCHAR(60) PRIMARY KEY, v TEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}
let ready = null;
handle.use((req, res, next) => { (ready ||= ensureTables().then(() => Billing.migrate())).then(() => next(), next); });
handle.use((req, res, next) => {
  const s = unsign(parseCookies(req)[COOKIE]);
  if (!s) return next();
  T.pone('SELECT id, name, email, session_version FROM platform_users WHERE id = ?', [s.uid]).then((u) => { if (u && u.session_version === s.sv) req.admin = u; next(); }, next);
});
const log = (req, action, tenantId = null, detail = null) => T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', [req.admin?.email || 'anônimo', action, tenantId, detail ? String(detail).slice(0, 500) : null]).catch(() => {});

// ---------- layout (estilo da referência: barra lateral, barra superior e cartões brancos; cores e logos da Mentez) ----------
const SV = (d) => raw(`<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`);
const ICON = {
  geral: SV('<rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><rect x="14" y="14" width="7" height="7" rx="2"/>'),
  clinicas: SV('<path d="M3 21h18M5 21V8l7-5 7 5v13"/><path d="M10 21v-5h4v5M9 11h.01M15 11h.01"/>'),
  nova: SV('<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>'),
  faturas: SV('<path d="M7 3h10a1 1 0 0 1 1 1v17l-3-2-3 2-3-2-3 2V4a1 1 0 0 1 1-1z"/><path d="M9 8h6M9 12h6"/>'),
  testes: SV('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9 2h6"/>'),
  planos: SV('<path d="M12 3l8 4-8 4-8-4 8-4z"/><path d="M4 12l8 4 8-4M4 17l8 4 8-4"/>'),
  cobranca: SV('<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19M6.5 15h4"/>'),
  historico: SV('<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>'),
  sair: SV('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3"/>'),
  busca: SV('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  ajuda: SV('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17h.01"/>'),
  sino: SV('<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>'),
  site: SV('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 3 2.5 15 0 18M12 3c-2.5 3-2.5 15 0 18"/>'),
  baixar: SV('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  cal: SV('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
};
const MENU = [
  ['PRINCIPAL', [['/', 'Visão geral', 'geral'], ['/clinicas', 'Clínicas', 'clinicas', 'clinicas'], ['/faturas', 'Assinaturas e faturas', 'faturas'], ['/testes', 'Testes grátis', 'testes', 'testes']]],
  ['CONFIGURAÇÃO', [['/planos', 'Planos e preços', 'planos'], ['/cobranca', 'Cobrança (Asaas)', 'cobranca'], ['/historico', 'Histórico', 'historico']]],
];
const LOGO = (dark = false) => raw(`<img class="mz2-logo" src="/static/img/mentez/${dark ? 'logo-dark' : 'logo'}.png" alt="Mentez" width="150" height="31">`);
const initialsOf = (n) => String(n || '').trim().split(/\s+/).filter(Boolean).map((x, i, a) => (i === 0 || i === a.length - 1 ? x[0] : '')).join('').toUpperCase().slice(0, 2);
let counts = { at: 0, v: {} };
async function menuCounts() {
  if (Date.now() - counts.at < 30e3) return counts.v;
  const all = await T.all();
  const v = { clinicas: all.length, testes: all.filter((t) => Billing.accessOf(t).state === 'teste').length };
  counts = { at: Date.now(), v }; return v;
}
function activeOf(path) {
  if (path === '/') return '/';
  const hit = MENU.flatMap(([, items]) => items).map((x) => x[0]).filter((h) => h !== '/' && path.startsWith(h)).sort((x, y) => y.length - x.length)[0];
  return hit || '';
}
function layout(req, title, body) {
  const flash = req.flash ? html`<div class="flash ${req.flash.type || 'ok'}">${req.flash.text}</div>` : '';
  if (!req.admin) {
    return bare(title, html`<div class="mz2 mz2-pub">
      <header class="mz2-pubtop"><a href="/inicio">${LOGO()}</a><nav><a href="/criar-conta">Criar conta</a><a href="/inicio">Entrar na minha clínica</a></nav></header>
      <main class="mz2-pubmain">${flash}${body}</main>
      <footer class="mz2-pubfoot">Mentez · Inteligência para cuidar de quem cuida · <a href="/termos-de-uso">Termos de Uso</a> · <a href="/privacidade">Privacidade</a></footer>
    </div>`, 'bare mz2-body', req, { suffix: 'Mentez' });
  }
  const act = activeOf(req.path); const c = req.menuCounts || {};
  return bare(title, html`<div class="mz2"><input type="checkbox" id="mz2-menu" class="mz2-menu-ck" aria-hidden="true" tabindex="-1"><label for="mz2-menu" class="mz2-scrim" aria-hidden="true"></label><div class="mz2-app">
    <aside class="mz2-side" id="mz2-side">
      <label for="mz2-menu" class="mz2-close" aria-label="Fechar menu">×</label>
      <a class="mz2-brand" href="/">${LOGO()}</a>
      ${MENU.map(([g, items]) => html`<p class="mz2-grp">${g}</p><nav class="mz2-nav">${items.map(([href, label, ic, cnt]) => html`<a href="${href}" class="${act === href ? 'on' : ''}">${ICON[ic]}<span>${label}</span>${cnt && c[cnt] ? html`<b>${c[cnt]}</b>` : ''}</a>`)}</nav>`)}
      <p class="mz2-grp">GERAL</p>
      <nav class="mz2-nav"><a href="https://mentez.com.br" target="_blank" rel="noopener">${ICON.site}<span>Site da Mentez</span></a>
        <form method="post" action="/sair"><button type="submit">${ICON.sair}<span>Sair</span></button></form></nav>
      <div class="mz2-promo"><b>Nova clínica</b><span>Crie uma clínica e envie o convite de primeiro acesso.</span><a href="/clinicas/nova">Criar clínica</a></div>
    </aside>
    <div class="mz2-col">
      <header class="mz2-top">
        <label for="mz2-menu" class="mz2-burger" role="button" aria-label="Abrir menu" aria-controls="mz2-side"><span></span><span></span><span></span></label>
        <a class="mz2-toplogo" href="/">${LOGO()}</a>
        <form class="mz2-search" action="/clinicas" method="get" role="search">${ICON.busca}<input type="search" name="q" placeholder="Buscar clínica, endereço ou e-mail" aria-label="Buscar clínica" value="${req.path === '/clinicas' ? str(req.query.q, 80) : ''}"><kbd>⌘ K</kbd></form>
        <div class="mz2-tools"><a class="mz2-ic" href="/historico" title="Histórico">${ICON.sino}</a><a class="mz2-ic" href="/termos-de-uso" title="Termos de uso">${ICON.ajuda}</a>
          <span class="mz2-me" title="${req.admin.email}"><i>${initialsOf(req.admin.name)}</i><span><b>${req.admin.name}</b><small>Equipe Mentez</small></span></span></div>
      </header>
      <main class="mz2-main">${flash}${body}</main>
      <nav class="mz2-tabbar" aria-label="Atalhos">${[['/', 'Visão geral', 'geral'], ['/clinicas', 'Clínicas', 'clinicas'], ['/faturas', 'Faturas', 'faturas'], ['/testes', 'Testes', 'testes']].map(([h, l, ic]) => html`<a href="${h}" class="${act === h ? 'on' : ''}">${ICON[ic]}<span>${l}</span></a>`)}<label for="mz2-menu">${SV('<path d="M4 7h16M4 12h16M4 17h16"/>')}<span>Menu</span></label></nav>
    </div>
  </div></div>`, 'bare mz2-body', req, { suffix: 'Painel Mentez' });
}
const need = (req, res, next) => { if (!req.admin) return res.redirect('/inicio'); menuCounts().then((v) => { req.menuCounts = v; next(); }, () => next()); };
mountSignup(handle, layout);
handle.get('/inicio', (req, res) => (req.admin ? res.redirect('/') : send(res, layout(req, 'Mentez', html`<section class="card mzp-auth mzp-choose"><h1>Bem-vindo à Mentez</h1>
  <form method="get" action="/ir" class="stack"><label class="fld"><span>Entrar na minha clínica</span><span class="mzp-slug"><input name="c" required placeholder="suaclinica" pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" autocomplete="off"><small>.${T.baseDomain()}</small></span></label><button class="btn">Ir para a minha clínica</button></form>
  <p class="mzp-or">ou</p><a class="btn ghost" href="/criar-conta">Criar conta grátis</a>
  <p class="muted small"><a href="/entrar">Equipe Mentez</a></p></section>`))));
handle.get('/ir', (req, res) => { const c = str(req.query.c, 40).toLowerCase(); return T.SLUG_RE.test(c) ? res.redirect(`https://${c}.${T.baseDomain()}/login`) : res.redirect('/inicio'); });

// ---------- primeiro acesso (convite gerado pela linha de comando) e login ----------
handle.get('/primeiro-acesso', async (req, res) => {
  if (await T.pone('SELECT id FROM platform_users LIMIT 1')) return res.redirect('/entrar');
  send(res, layout(req, 'Primeiro acesso', html`<section class="card mzp-auth"><h1>Primeiro acesso ao painel</h1>
    <form method="post" class="stack">
      <label class="fld"><span>Código de convite</span><input name="codigo" required value="${str(req.query.codigo, 80)}" autocomplete="off"></label>
      <label class="fld"><span>Nome</span><input name="name" required maxlength="120" autocomplete="name"></label>
      <label class="fld"><span>E-mail</span><input type="email" name="email" required maxlength="190" autocomplete="username"></label>
      <label class="fld"><span>Senha (mínimo 12 caracteres)</span><input type="password" name="password" minlength="12" required autocomplete="new-password"></label>
      <button class="btn">Criar acesso</button></form></section>`));
});
handle.post('/primeiro-acesso', RL.limit({ name: 'painel-setup', windowMs: 10 * 60e3, max: 10 }), async (req, res) => {
  if (await T.pone('SELECT id FROM platform_users LIMIT 1')) return res.redirect('/entrar');
  const inv = await T.pone("SELECT v FROM platform_settings WHERE k = 'convite_painel'");
  const ok = inv?.v && str(req.body.codigo, 80).length === inv.v.length && crypto.timingSafeEqual(Buffer.from(str(req.body.codigo, 80)), Buffer.from(inv.v));
  if (!ok) return res.flash('Código de convite inválido.', 'err').redirect('/primeiro-acesso');
  if (String(req.body.password || '').length < 12) return res.flash('A senha precisa ter pelo menos 12 caracteres.', 'err').redirect(`/primeiro-acesso?codigo=${encodeURIComponent(req.body.codigo)}`);
  await T.pq('INSERT INTO platform_users (name, email, password_hash) VALUES (?,?,?)', [str(req.body.name, 120), str(req.body.email, 190).toLowerCase(), await bcrypt.hash(req.body.password, 12)]);
  await T.pq("DELETE FROM platform_settings WHERE k = 'convite_painel'");
  await log(req, 'painel-primeiro-acesso', null, req.body.email);
  res.flash('Acesso criado. Entre com seu e-mail e senha.').redirect('/entrar');
});
handle.get('/entrar', (req, res) => {
  if (req.admin) return res.redirect('/');
  send(res, layout(req, 'Entrar', html`<section class="card mzp-auth"><h1>Painel da Mentez</h1><p class="muted small">Acesso restrito à equipe da Mentez. As clínicas entram pelo próprio endereço.</p>
    <form method="post" class="stack"><label class="fld"><span>E-mail</span><input type="email" name="email" required autocomplete="username"></label>
      <label class="fld"><span>Senha</span><input type="password" name="password" required autocomplete="current-password"></label><button class="btn">Entrar</button></form></section>`));
});
handle.post('/entrar', RL.limit({ name: 'painel-login', windowMs: 15 * 60e3, max: 10 }), async (req, res) => {
  const u = await T.pone('SELECT * FROM platform_users WHERE email = ?', [str(req.body.email, 190).toLowerCase()]);
  const good = u && await bcrypt.compare(String(req.body.password || ''), u.password_hash);
  if (!good) { await log(req, 'painel-login-falhou', null, req.body.email); return res.flash('E-mail ou senha incorretos.', 'err').redirect('/entrar'); }
  await T.pq('UPDATE platform_users SET last_login_at = NOW() WHERE id = ?', [u.id]);
  setCookie(res, sign({ uid: u.id, sv: u.session_version, exp: Date.now() + HOURS * 3600e3 }), HOURS * 3600);
  req.admin = u; await log(req, 'painel-login');
  res.redirect('/');
});
handle.post('/sair', (req, res) => { setCookie(res, '', 0); res.redirect('/entrar'); });

// ---------- clínicas ----------
async function usage(t) {
  try {
    return await T.run(t, async () => ({
      users: Number((await one('SELECT COUNT(*) n FROM users WHERE active = 1')).n),
      patients: Number((await one("SELECT COUNT(*) n FROM patients WHERE status = 'ativo'")).n),
      sessions30: Number((await one("SELECT COUNT(*) n FROM appointments WHERE status = 'realizada' AND starts_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)")).n),
      lastLogin: (await one('SELECT MAX(last_login_at) m FROM users')).m,
    }));
  } catch { return null; }
}
const STATUS = { ativa: ['realizada', 'Ativa'], suspensa: ['falta', 'Suspensa'], cancelada: ['cancelada', 'Cancelada'] };
// Situação de cobrança em palavras e cor (chip)
const ST = { cortesia: ['muted', 'Cortesia'], teste: ['warn', 'Teste'], ativa: ['ok', 'Em dia'], atrasada: ['err', 'Em atraso'], bloqueada: ['err', 'Suspensa'] };
const chipOf = (t) => { const a = Billing.accessOf(t); const [tone, l] = t.status !== 'ativa' ? ['err', 'Suspensa (manual)'] : ST[a.state]; return html`<span class="mz2-chip ${tone}">${l}${a.state === 'teste' ? ` · ${a.daysLeft} dia(s)` : a.state === 'atrasada' ? ` · ${a.late} dia(s)` : ''}</span>`; };
const MONTHS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const pct = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const trend = (v, inverse = false) => (v === null ? html`<span class="mz2-delta">sem base no mês anterior</span>` : html`<span class="mz2-delta ${(v >= 0) !== inverse ? 'up' : 'down'}">${v >= 0 ? '+' : ''}${String(v).replace('.', ',')}% ${v >= 0 ? '↑' : '↓'}</span><span class="mz2-delta-l">vs. mês anterior</span>`);

handle.get('/', need, async (req, res) => {
  const all = await T.all(); const plans = await Billing.plans();
  const planOf = (t) => plans.find((p) => p.key === t.plan);
  const acc = all.map((t) => ({ t, a: Billing.accessOf(t) }));
  const paying = acc.filter((x) => x.t.status === 'ativa' && ['ativa', 'atrasada'].includes(x.a.state));
  const mrr = paying.reduce((s2, x) => s2 + (planOf(x.t) ? Billing.monthly(planOf(x.t), x.t.extraPros) : 0), 0);
  const trials = acc.filter((x) => x.a.state === 'teste');
  const late = acc.filter((x) => x.a.state === 'atrasada' || (x.a.state === 'bloqueada' && x.a.reason === 'atraso'));
  const lateValue = late.reduce((s2, x) => s2 + (planOf(x.t) ? Billing.monthly(planOf(x.t), x.t.extraPros) : 0), 0);
  // Receita recebida por mês (ano atual), uma vez por pagamento
  const year = new Date().getFullYear();
  const paid = await T.pq(`SELECT MONTH(d) m, SUM(v) total FROM (SELECT payment_id, MAX(due_date) d, MAX(value) v FROM billing_events WHERE event IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED') AND payment_id IS NOT NULL GROUP BY payment_id) x WHERE YEAR(d) = ? GROUP BY MONTH(d)`, [year]);
  const byMonth = Array.from({ length: 12 }, (_, i) => Number(paid.find((r) => Number(r.m) === i + 1)?.total || 0));
  const curM = new Date().getMonth(); const top = Math.max(...byMonth, 1);
  const gotNow = byMonth[curM]; const gotPrev = curM ? byMonth[curM - 1] : 0;
  const newPaying = (await T.pq("SELECT COUNT(DISTINCT tenant_id) n FROM billing_events e WHERE event IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED') AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01') AND NOT EXISTS (SELECT 1 FROM billing_events o WHERE o.tenant_id = e.tenant_id AND o.event IN ('PAYMENT_RECEIVED','PAYMENT_CONFIRMED') AND o.created_at < DATE_FORMAT(NOW(), '%Y-%m-01'))"))[0]?.n || 0;
  // Funil do teste (cadastros dos últimos 30 dias)
  const signups = await T.pq("SELECT DISTINCT tenant_id FROM platform_audit WHERE action = 'cadastro-teste' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)");
  let activated = 0; let subscribed = 0;
  for (const r of signups) {
    const t = all.find((x) => x.id === r.tenant_id); if (!t) continue;
    const row = await T.pone('SELECT asaas_subscription FROM tenants WHERE id = ?', [t.id]); if (row?.asaas_subscription) subscribed++;
    const ok = await T.run(t, async () => Number((await one('SELECT COUNT(*) n FROM patients')).n) > 0 && Number((await one("SELECT COUNT(*) n FROM appointments WHERE status = 'realizada'")).n) > 0).catch(() => false);
    if (ok) activated++;
  }
  const fun = [['Contas criadas', signups.length], ['Ativadas (1º paciente e 1ª sessão)', activated], ['Assinaram', subscribed]];
  // Alertas e clínicas recentes
  const alerts = [
    ...trials.filter((x) => x.a.daysLeft <= 3).map((x) => ({ tone: 'warn', t: x.t, text: x.a.daysLeft === 0 ? 'Teste termina hoje' : `Teste termina em ${x.a.daysLeft} dia(s)` })),
    ...late.map((x) => ({ tone: 'err', t: x.t, text: x.a.state === 'bloqueada' ? 'Acesso suspenso por atraso' : `Mensalidade em atraso há ${x.a.late} dia(s)` })),
    ...acc.filter((x) => x.a.state === 'bloqueada' && x.a.reason === 'teste').map((x) => ({ tone: 'muted', t: x.t, text: 'Teste terminou sem assinatura' })),
  ].slice(0, 6);
  const recent = await T.pq('SELECT id FROM tenants ORDER BY created_at DESC LIMIT 6');
  const rec = recent.map((r) => all.find((t) => t.id === r.id)).filter(Boolean);
  const use = await Promise.all(rec.map(usage));
  const first = String(req.admin.name || '').split(' ')[0];
  const hour = Number(new Date(Date.now() - 3 * 3600e3).toISOString().slice(11, 13));
  const today = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
  send(res, layout(req, 'Visão geral', html`<div class="mz2-hello"><div><h1>${hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'}, ${first}</h1><p>Receita, clínicas e alertas da Mentez hoje.</p></div>
      <div class="mz2-hello-act"><span class="mz2-pill">${ICON.cal}${brDate(today)}</span><a class="mz2-btn dark" href="/clinicas.csv">${ICON.baixar}Exportar</a></div></div>
    <div class="mz2-grid">
      <section class="mz2-card mz2-hero"><header><span class="mz2-cardic">${ICON.cobranca}</span><h2>Receita recorrente</h2><span class="mz2-pill sm">mensal</span></header>
        <strong class="mz2-big">${money(mrr)}</strong>
        <p class="mz2-trend"><span class="mz2-delta-l">${paying.length} clínica(s) pagante(s)${newPaying ? ` · ${newPaying} nova(s) no mês` : ''}</span></p>
        <div class="mz2-hero-act"><a class="mz2-btn pri" href="/clinicas/nova">${ICON.nova}Nova clínica</a><a class="mz2-btn soft" href="/faturas">${ICON.faturas}Ver faturas</a></div>
        <p class="mz2-sub">Por plano</p>
        <div class="mz2-mini">${plans.filter((p) => p.public).map((p) => { const n = paying.filter((x) => x.t.plan === p.key).length; return html`<div class="mz2-minicard"><span>${p.name}</span><b>${n}</b><small>${money(n * p.price)}/mês</small></div>`; })}
          <div class="mz2-minicard"><span>Cortesia</span><b>${acc.filter((x) => x.a.state === 'cortesia').length}</b><small>sem cobrança</small></div></div>
      </section>
      <section class="mz2-card mz2-kpi"><header><span class="mz2-cardic">${ICON.faturas}</span><h2>Recebido no mês</h2></header><strong class="mz2-big sm">${money(gotNow)}</strong><p class="mz2-trend">${trend(pct(gotNow, gotPrev))}</p></section>
      <section class="mz2-card mz2-kpi"><header><span class="mz2-cardic">${ICON.testes}</span><h2>Testes em andamento</h2></header><strong class="mz2-big sm">${trials.length}</strong><p class="mz2-trend"><span class="mz2-delta ${trials.some((x) => x.a.daysLeft <= 5) ? 'warn' : ''}">${trials.filter((x) => x.a.daysLeft <= 5).length} terminam em até 5 dias</span></p></section>
      <section class="mz2-card mz2-chart"><header><span class="mz2-cardic">${ICON.geral}</span><h2>Receita recebida por mês</h2><span class="mz2-legend"><i></i>Recebido</span><span class="mz2-pill sm">${year}</span></header>
        <div class="mz2-bars" role="img" aria-label="Receita recebida por mês em ${year}">
          <div class="mz2-yaxis">${[1, 0.75, 0.5, 0.25, 0].map((f) => html`<span>${money(top * f).replace(',00', '')}</span>`)}</div>
          <div class="mz2-cols">${byMonth.map((v, i) => html`<div class="mz2-colw ${i === curM ? 'on' : ''}" title="${MONTHS[i]}: ${money(v)}">${i === curM ? html`<span class="mz2-tip ${i >= 8 ? 'left' : ''}" style="bottom:calc(${Math.max(3, Math.round((v / top) * 82))}% + 30px)"><small>Recebido</small><b>${money(v)}</b></span>` : ''}<i style="height:${Math.max(3, Math.round((v / top) * 82))}%"></i><span>${MONTHS[i]}</span></div>`)}</div>
        </div>
        ${byMonth.every((v) => !v) ? html`<p class="mz2-empty">Ainda não há pagamentos confirmados pelo Asaas neste ano.</p>` : ''}
      </section>
      <section class="mz2-card mz2-kpi"><header><span class="mz2-cardic">${ICON.cobranca}</span><h2>Em atraso</h2></header><strong class="mz2-big sm">${money(lateValue)}</strong><p class="mz2-trend"><span class="mz2-delta ${late.length ? 'down' : 'up'}">${late.length} clínica(s)</span></p></section>
      <section class="mz2-card mz2-funnel"><header><span class="mz2-cardic">${ICON.nova}</span><h2>Funil do teste grátis</h2><span class="mz2-pill sm">30 dias</span></header>
        ${fun.map(([l, n]) => html`<div class="mz2-fstep"><div><span>${l}</span><b>${n}</b></div><span class="mz2-track"><i style="width:${fun[0][1] ? Math.round((n / fun[0][1]) * 100) : 0}%"></i></span></div>`)}
        ${!signups.length ? html`<p class="mz2-empty">Nenhum cadastro pelo site nos últimos 30 dias.</p>` : ''}
      </section>
      <section class="mz2-card mz2-alerts"><header><span class="mz2-cardic">${ICON.sino}</span><h2>Alertas</h2></header>
        ${alerts.length ? html`<ul>${alerts.map((x) => html`<li><span class="mz2-dot ${x.tone}"></span><a href="/clinicas/${x.t.id}">${x.t.name}</a><small>${x.text}</small></li>`)}</ul>` : html`<p class="mz2-empty">Nada pedindo atenção agora.</p>`}
      </section>
      <section class="mz2-card mz2-table"><header><span class="mz2-cardic">${ICON.clinicas}</span><h2>Clínicas recentes</h2><a class="mz2-btn soft sm" href="/clinicas">Ver todas</a></header>
        <div class="mz2-tw"><table><thead><tr><th>Clínica</th><th>Plano</th><th>Desde</th><th>Sessões (30 dias)</th><th>Situação</th></tr></thead><tbody>
        ${rec.map((t, i) => html`<tr><td><a href="/clinicas/${t.id}"><span class="mz2-av">${initialsOf(t.name)}</span>${t.name}</a></td><td>${planOf(t)?.name || t.plan}</td><td>${brDate(t.createdAt || '')}</td><td>${use[i]?.sessions30 ?? '—'}</td><td>${chipOf(t)}</td></tr>`)}
        </tbody></table></div>
      </section>
    </div>`));
});

// ---------- clínicas: lista com busca e filtros, exportação ----------
handle.get('/clinicas', need, async (req, res) => {
  const q = str(req.query.q, 80).toLowerCase(); const f = ['teste', 'ativa', 'atrasada', 'cortesia', 'bloqueada'].includes(req.query.f) ? req.query.f : '';
  const plans = await Billing.plans();
  let list = await T.all();
  if (q) list = list.filter((t) => [t.name, t.slug, t.ownerEmail, t.ownerName, t.primaryDomain].filter(Boolean).some((v) => String(v).toLowerCase().includes(q)));
  if (f) list = list.filter((t) => Billing.accessOf(t).state === f);
  const use = await Promise.all(list.map(usage));
  send(res, layout(req, 'Clínicas', html`<div class="mz2-hello"><div><h1>Clínicas</h1><p>${list.length} clínica(s)${q ? ` para “${q}”` : ''}.</p></div>
      <div class="mz2-hello-act"><a class="mz2-btn soft" href="/clinicas.csv">${ICON.baixar}Exportar CSV</a><a class="mz2-btn pri" href="/clinicas/nova">${ICON.nova}Nova clínica</a></div></div>
    <nav class="mz2-tabs">${[['', 'Todas'], ['ativa', 'Em dia'], ['teste', 'Em teste'], ['atrasada', 'Em atraso'], ['bloqueada', 'Suspensas'], ['cortesia', 'Cortesia']].map(([k, l]) => html`<a class="${f === k ? 'on' : ''}" href="/clinicas?f=${k}${q ? `&q=${encodeURIComponent(q)}` : ''}">${l}</a>`)}</nav>
    <section class="mz2-card mz2-table">${list.length ? html`<div class="mz2-tw"><table><thead><tr><th>Clínica</th><th>Endereço</th><th>Plano</th><th>Usuários</th><th>Pacientes ativos</th><th>Sessões (30 dias)</th><th>Último acesso</th><th>Situação</th></tr></thead><tbody>
      ${list.map((t, i) => html`<tr><td><a href="/clinicas/${t.id}"><span class="mz2-av">${initialsOf(t.name)}</span>${t.name}</a></td><td><a class="mz2-link" href="${t.env.PUBLIC_URL}" target="_blank" rel="noopener">${t.env.PUBLIC_URL.replace('https://', '')}</a></td>
        <td>${plans.find((p) => p.key === t.plan)?.name || t.plan}</td><td>${use[i]?.users ?? '—'}</td><td>${use[i]?.patients ?? '—'}</td><td>${use[i]?.sessions30 ?? '—'}</td><td>${use[i]?.lastLogin ? brDateTime(use[i].lastLogin) : '—'}</td><td>${chipOf(t)}</td></tr>`)}
    </tbody></table></div>` : html`<p class="mz2-empty">Nenhuma clínica encontrada.</p>`}</section>`));
});
handle.get('/clinicas.csv', need, async (req, res) => {
  const all = await T.all(); const use = await Promise.all(all.map(usage)); const plans = await Billing.plans();
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Clínica', 'Endereço', 'Plano', 'Situação', 'Usuários', 'Pacientes ativos', 'Sessões 30 dias', 'Último acesso', 'Responsável', 'E-mail'], ...all.map((t, i) => [t.name, t.env.PUBLIC_URL, plans.find((p) => p.key === t.plan)?.name || t.plan, Billing.accessOf(t).state, use[i]?.users, use[i]?.patients, use[i]?.sessions30, use[i]?.lastLogin, t.ownerName, t.ownerEmail])];
  await log(req, 'clinicas-exportar');
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="clinicas-mentez.csv"' }).send('﻿' + rows.map((r) => r.map(esc).join(';')).join('\n'));
});
// ---------- assinaturas e faturas ----------
handle.get('/faturas', need, async (req, res) => {
  const all = await T.all(); const plans = await Billing.plans();
  const subs = await T.pq('SELECT id, plan, billing_status, asaas_subscription, paid_until, overdue_since, extra_pros FROM tenants WHERE asaas_subscription IS NOT NULL OR billing_status IN (\'ativa\',\'atrasada\',\'pendente\',\'cancelada\') ORDER BY name');
  const ev = await T.pq("SELECT e.*, t.name tname, t.id tid FROM billing_events e LEFT JOIN tenants t ON t.id = e.tenant_id WHERE e.event LIKE 'PAYMENT_%' ORDER BY e.id DESC LIMIT 60");
  const EV = { PAYMENT_RECEIVED: ['ok', 'Paga'], PAYMENT_CONFIRMED: ['ok', 'Paga'], PAYMENT_OVERDUE: ['err', 'Vencida'], PAYMENT_CREATED: ['muted', 'Gerada'], PAYMENT_REFUNDED: ['warn', 'Estornada'], PAYMENT_DELETED: ['muted', 'Removida'] };
  send(res, layout(req, 'Assinaturas e faturas', html`<div class="mz2-hello"><div><h1>Assinaturas e faturas</h1><p>Assinaturas das clínicas e os últimos avisos de pagamento do Asaas.</p></div></div>
    <section class="mz2-card mz2-table"><header><span class="mz2-cardic">${ICON.planos}</span><h2>Assinaturas</h2></header>${subs.length ? html`<div class="mz2-tw"><table><thead><tr><th>Clínica</th><th>Plano</th><th>Mensalidade</th><th>Pago até</th><th>Situação</th></tr></thead><tbody>
      ${subs.map((r) => { const t = all.find((x) => x.id === r.id); const p = plans.find((x) => x.key === r.plan); return t ? html`<tr><td><a href="/clinicas/${t.id}"><span class="mz2-av">${initialsOf(t.name)}</span>${t.name}</a></td><td>${p?.name || r.plan}</td><td>${p ? money(Billing.monthly(p, r.extra_pros)) : '—'}</td><td>${r.paid_until ? brDate(r.paid_until) : '—'}</td><td>${chipOf(t)}</td></tr>` : ''; })}
    </tbody></table></div>` : html`<p class="mz2-empty">Nenhuma assinatura ainda.</p>`}</section>
    <section class="mz2-card mz2-table"><header><span class="mz2-cardic">${ICON.faturas}</span><h2>Movimento das faturas</h2></header>${ev.length ? html`<div class="mz2-tw"><table><thead><tr><th>Quando</th><th>Clínica</th><th>Fatura</th><th>Valor</th><th>Vencimento</th><th>Situação</th></tr></thead><tbody>
      ${ev.map((e) => html`<tr><td>${brDateTime(e.created_at)}</td><td>${e.tid ? html`<a href="/clinicas/${e.tid}">${e.tname}</a>` : '—'}</td><td class="mz2-mono">${e.payment_id || '—'}</td><td>${e.value ? money(e.value) : '—'}</td><td>${e.due_date ? brDate(e.due_date) : '—'}</td><td><span class="mz2-chip ${(EV[e.event] || ['muted'])[0]}">${(EV[e.event] || [0, e.event])[1]}</span></td></tr>`)}
    </tbody></table></div>` : html`<p class="mz2-empty">Nenhum aviso de pagamento ainda. Configure o Asaas em Cobrança.</p>`}</section>`));
});
// ---------- testes grátis ----------
handle.get('/testes', need, async (req, res) => {
  const all = await T.all();
  const rows = await T.pq("SELECT id, owner_crp, owner_phone, owner_email, owner_name, trial_ends_at, created_at FROM tenants WHERE billing_status = 'teste' OR (trial_ends_at IS NOT NULL AND trial_ends_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)) ORDER BY trial_ends_at");
  const list = rows.map((r) => ({ r, t: all.find((x) => x.id === r.id) })).filter((x) => x.t);
  const use = await Promise.all(list.map((x) => usage(x.t)));
  send(res, layout(req, 'Testes grátis', html`<div class="mz2-hello"><div><h1>Testes grátis</h1><p>Quem está testando, se já começou a usar e quando o teste termina. Confira o CRP no Cadastro Nacional do CFP.</p></div></div>
    <section class="mz2-card mz2-table">${list.length ? html`<div class="mz2-tw"><table><thead><tr><th>Clínica</th><th>Responsável</th><th>CRP</th><th>Contato</th><th>Pacientes</th><th>Sessões</th><th>Termina</th><th>Situação</th></tr></thead><tbody>
      ${list.map(({ r, t }, i) => { const wa = String(r.owner_phone || '').replace(/\D/g, ''); return html`<tr><td><a href="/clinicas/${t.id}"><span class="mz2-av">${initialsOf(t.name)}</span>${t.name}</a></td><td>${r.owner_name || '—'}</td><td class="mz2-mono">${r.owner_crp || '—'}</td>
        <td>${wa ? html`<a class="mz2-link" href="https://wa.me/${wa.length <= 11 ? `55${wa}` : wa}" target="_blank" rel="noopener">WhatsApp</a>` : ''}${r.owner_email ? html` · <span class="mz2-mono">${r.owner_email}</span>` : ''}</td>
        <td>${use[i]?.patients ?? '—'}</td><td>${use[i]?.sessions30 ?? '—'}</td><td>${r.trial_ends_at ? brDate(r.trial_ends_at) : '—'}</td><td>${chipOf(t)}</td></tr>`; })}
    </tbody></table></div>` : html`<p class="mz2-empty">Nenhuma clínica em teste.</p>`}</section>`));
});
handle.get('/clinicas/nova', need, (req, res) => send(res, layout(req, 'Nova clínica', html`<header class="ph"><div><p class="eyebrow">Clínicas</p><h1>Nova clínica</h1></div></header>
  <form method="post" class="card form-grid">
    <label class="fld"><span>Nome da clínica *</span><input name="name" required maxlength="160" placeholder="Consultório Ana Souza"></label>
    <label class="fld"><span>Endereço *</span><span class="mzp-slug"><input name="slug" required pattern="[a-z0-9][a-z0-9-]{1,38}[a-z0-9]" maxlength="40" placeholder="anasouza"><small>.${T.baseDomain()}</small></span><small class="muted">Letras minúsculas, números e hífen. Não dá para mudar depois.</small></label>
    <label class="fld"><span>Responsável</span><input name="owner_name" maxlength="160"></label>
    <label class="fld"><span>E-mail do responsável</span><input type="email" name="owner_email" maxlength="190"></label>
    <label class="fld"><span>Plano</span><select name="plan"><option value="piloto">Piloto</option><option value="essencial">Essencial</option><option value="profissional">Profissional</option><option value="clinica">Clínica</option></select></label>
    <div class="span2 actions"><button class="btn">Criar clínica</button></div>
  </form>`)));
handle.post('/clinicas/nova', need, async (req, res) => {
  try {
    const t = await T.createTenant({ slug: req.body.slug, name: str(req.body.name, 160), ownerName: str(req.body.owner_name, 160) || null, ownerEmail: str(req.body.owner_email, 190) || null, plan: str(req.body.plan, 30) || 'piloto', actor: req.admin.email });
    await T.run(t, () => migrate()); // createTenant já registra no histórico
    res.flash(`Clínica criada: ${t.name}. Gere o convite de primeiro acesso abaixo e envie ao responsável.`).redirect(`/clinicas/${t.id}`);
  } catch (e) { res.flash(e.message, 'err').redirect('/clinicas/nova'); }
});
async function tenantOf(req) { const row = await T.pone('SELECT slug FROM tenants WHERE id = ?', [int(req.params.id)]); return row ? T.bySlug(row.slug) : null; }
handle.get('/clinicas/:id', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  const row = await T.pone('SELECT * FROM tenants WHERE id = ?', [t.id]);
  const domains = await T.pq('SELECT * FROM tenant_domains WHERE tenant_id = ? ORDER BY is_primary DESC, domain', [t.id]);
  const u = await usage(t);
  const hasUsers = u ? u.users > 0 : true;
  const hist = await T.pq('SELECT * FROM platform_audit WHERE tenant_id = ? ORDER BY id DESC LIMIT 15', [t.id]);
  const invite = str(req.query.convite, 300);
  send(res, layout(req, t.name, html`<header class="ph"><div><p class="eyebrow">Clínica · <span class="badge b-${STATUS[t.status][0]}">${STATUS[t.status][1]}</span></p><h1>${t.name}</h1>
      <p class="muted"><a href="${t.env.PUBLIC_URL}" target="_blank" rel="noopener">${t.env.PUBLIC_URL}</a> · plano ${t.plan} · criada em ${brDate(row.created_at)}</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/clinicas">Voltar</a></div></header>
    <section class="kpis small"><div class="kpi"><span>Usuários ativos</span><b>${u?.users ?? '—'}</b></div><div class="kpi"><span>Pacientes ativos</span><b>${u?.patients ?? '—'}</b></div><div class="kpi"><span>Sessões (30 dias)</span><b>${u?.sessions30 ?? '—'}</b></div><div class="kpi"><span>Último acesso</span><b>${u?.lastLogin ? brDateTime(u.lastLogin) : '—'}</b></div></section>
    ${invite ? html`<div class="flash ok">Convite de primeiro acesso (uso único — envie ao responsável por um canal privado): <input readonly value="${invite}" id="inv" class="mono"> <button type="button" class="chip" data-copy="#inv">Copiar</button></div>` : ''}
    <div class="grid2">
      <section class="card"><h2>Primeiro acesso</h2>
        ${hasUsers ? html`<p class="muted">A clínica já tem acesso criado. Novos usuários são criados pela própria clínica em Usuários.</p>`
          : html`<p class="muted">Gera um link de uso único: o responsável cria o próprio e-mail e senha. A senha não passa pela Mentez.</p><form method="post" action="/clinicas/${t.id}/convite"><button class="btn">Gerar convite</button></form>`}
      </section>
      <section class="card"><h2>Situação</h2>
        <p class="muted small">Suspensa: ninguém entra e as tarefas automáticas param, mas os dados ficam guardados.</p>
        <form method="post" action="/clinicas/${t.id}/situacao" class="actions">
          ${t.status !== 'ativa' ? html`<button class="btn" name="status" value="ativa">Reativar</button>` : html`<button class="btn ghost danger-text" name="status" value="suspensa" data-confirm="Suspender ${t.name}? Ninguém da clínica conseguirá entrar até reativar.">Suspender</button>`}
        </form>
      </section>
    </div>
    <section class="card"><h2>Assinatura</h2>
      ${(() => { const a = Billing.accessOf(t); return html`<p><b>${{ cortesia: 'Cortesia (sem cobrança)', teste: `Teste grátis · ${a.daysLeft} dia(s) restantes (até ${brDate(a.ends)})`, ativa: 'Em dia', atrasada: `Em aberto há ${a.late} dia(s)`, bloqueada: `Acesso suspenso (${a.reason})` }[a.state]}</b> · plano ${t.plan}${row.paid_until ? ` · pago até ${brDate(row.paid_until)}` : ''}${row.asaas_subscription ? ` · assinatura Asaas ${row.asaas_subscription}` : ''}${row.extra_pros ? ` · ${row.extra_pros} profissional(is) extra` : ''}</p>`; })()}
      ${row.owner_crp ? html`<p class="small muted">Cadastro: ${row.owner_name || ''} · CRP ${row.owner_crp} · ${row.owner_phone || ''} · ${row.owner_email || ''} — confira o CRP no Cadastro Nacional do CFP.</p>` : ''}
      <form method="post" action="/clinicas/${t.id}/assinatura" class="actions">
        <select name="plan" aria-label="Plano">${(await Billing.plans()).map((p) => html`<option value="${p.key}" ${p.key === t.plan ? raw('selected') : ''}>${p.name}</option>`)}</select>
        <button class="btn ghost btn-sm" name="acao" value="plano">Trocar plano</button>
        <button class="btn ghost btn-sm" name="acao" value="cortesia" data-confirm="Marcar como cortesia? A clínica deixa de ser cobrada pela Mentez.">Cortesia</button>
        <button class="btn ghost btn-sm" name="acao" value="teste7">Teste + 7 dias</button>
      </form>
    </section>
    <section class="card"><h2>Domínios próprios</h2>
      <p class="muted small">O endereço <b>${t.slug}.${T.baseDomain()}</b> sempre funciona. A própria clínica cadastra o domínio em Configurações → Domínio próprio e cria no DNS um registro <b>A</b> (ou <b>CNAME</b> para ${t.slug}.${T.baseDomain()}) apontando para <b>${(await Domains.serverIps().catch(() => ({ v4: [] }))).v4[0] || 'o IP do servidor'}</b>. O domínio só abre a clínica depois que o DNS aponta para cá; o HTTPS é emitido sozinho.</p>
      ${domains.length ? html`<ul class="list">${domains.map((d) => { const st = Domains.stateOf(d); return html`<li><div class="maint-bk"><span><b>${d.domain}</b> <span class="badge b-${st.badge}">${st.label}</span> ${d.is_primary ? html`<span class="badge b-realizada">principal</span>` : ''}<small>cadastrado em ${brDate(d.created_at)}${d.checked_at ? ` · verificado em ${brDateTime(d.checked_at)}` : ''}${d.last_check ? ` · ${d.last_check}` : ''}</small></span>
        <span class="actions"><form method="post" action="/clinicas/${t.id}/dominio/verificar"><input type="hidden" name="domain" value="${d.domain}"><button class="chip">Verificar</button></form>
          ${!d.is_primary ? (st.key === 'ativo' ? html`<form method="post" action="/clinicas/${t.id}/dominio/principal"><input type="hidden" name="domain" value="${d.domain}"><button class="chip" data-confirm="Usar ${d.domain} como endereço principal? Links enviados aos pacientes passam a usar este domínio.">Tornar principal</button></form>` : '') : html`<form method="post" action="/clinicas/${t.id}/dominio/principal"><input type="hidden" name="domain" value=""><button class="chip">Voltar ao endereço da Mentez</button></form>`}
          <form method="post" action="/clinicas/${t.id}/dominio/remover"><input type="hidden" name="domain" value="${d.domain}"><button class="chip" data-confirm="Remover ${d.domain}?">Remover</button></form></span></div></li>`; })}</ul>` : ''}
      <form method="post" action="/clinicas/${t.id}/dominio" class="inline-form"><input name="domain" required placeholder="app.clinica.com.br" maxlength="190"><button class="btn ghost">Adicionar domínio</button></form>
    </section>
    <section class="card flush"><h2 class="pad">Histórico</h2>${hist.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Ação</th><th>Quem</th><th>Detalhe</th></tr></thead><tbody>${hist.map((h) => html`<tr><td>${brDateTime(h.created_at)}</td><td>${h.action}</td><td>${h.actor || '—'}</td><td class="small">${h.detail || ''}</td></tr>`)}</tbody></table></div>` : html`<p class="muted pad">Sem registros.</p>`}</section>`));
});
handle.post('/clinicas/:id/convite', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  const has = await T.run(t, () => one('SELECT id FROM users LIMIT 1'));
  if (has) return res.flash('Esta clínica já tem acesso criado.', 'warn').redirect(`/clinicas/${t.id}`);
  const code = crypto.randomBytes(18).toString('base64url');
  await T.setSecretEnv(t.id, 'SETUP_TOKEN', code);
  await log(req, 'clinica-convite', t.id);
  res.redirect(`/clinicas/${t.id}?convite=${encodeURIComponent(`${t.env.PUBLIC_URL}/setup?codigo=${code}`)}`);
});
handle.post('/clinicas/:id/situacao', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  const st = ['ativa', 'suspensa'].includes(req.body.status) ? req.body.status : null;
  if (!st) return res.redirect(`/clinicas/${t.id}`);
  await T.pq('UPDATE tenants SET status = ? WHERE id = ?', [st, t.id]); T.clearCache();
  await log(req, st === 'ativa' ? 'clinica-reativar' : 'clinica-suspender', t.id);
  res.flash(st === 'ativa' ? 'Clínica reativada.' : 'Clínica suspensa.').redirect(`/clinicas/${t.id}`);
});
handle.post('/clinicas/:id/dominio', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  try { const d = await Domains.add(t.id, req.body.domain, req.admin?.email || 'painel'); res.flash(`Domínio ${d} cadastrado. A clínica precisa criar o registro A no DNS.`); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`/clinicas/${t.id}`);
});
handle.post('/clinicas/:id/dominio/verificar', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  try { const r = await Domains.check(Domains.normalize(req.body.domain), t.id); res.flash(r.ok && r.https ? 'Domínio ativo (DNS e HTTPS).' : r.ok ? 'DNS certo; HTTPS ainda sendo emitido.' : r.problems.join(' '), r.ok ? 'ok' : 'warn'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`/clinicas/${t.id}`);
});
handle.post('/clinicas/:id/dominio/principal', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  try { await Domains.setPrimary(t.id, req.body.domain ? Domains.normalize(req.body.domain) : '', req.admin?.email || 'painel'); res.flash('Endereço principal atualizado.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`/clinicas/${t.id}`);
});
handle.post('/clinicas/:id/dominio/remover', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  await Domains.remove(t.id, str(req.body.domain, 190), req.admin?.email || 'painel');
  res.flash('Domínio removido.').redirect(`/clinicas/${t.id}`);
});
handle.post('/clinicas/:id/assinatura', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  const a = req.body.acao;
  if (a === 'plano' && (await Billing.plans()).some((p) => p.key === req.body.plan)) await T.pq('UPDATE tenants SET plan = ? WHERE id = ?', [req.body.plan, t.id]);
  else if (a === 'cortesia') await T.pq("UPDATE tenants SET billing_status = 'cortesia', overdue_since = NULL WHERE id = ?", [t.id]);
  else if (a === 'teste7') await T.pq("UPDATE tenants SET billing_status = 'teste', trial_ends_at = DATE_ADD(GREATEST(COALESCE(trial_ends_at, NOW()), NOW()), INTERVAL 7 DAY) WHERE id = ?", [t.id]);
  T.clearCache(); await log(req, `assinatura-${a}`, t.id, req.body.plan || null);
  res.flash('Assinatura atualizada.').redirect(`/clinicas/${t.id}`);
});
// ---------- planos ----------
handle.get('/planos', need, async (req, res) => {
  const list = await Billing.plans(true);
  send(res, layout(req, 'Planos', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Planos</h1><p class="muted">Preços e limites valem para novas assinaturas e mudanças de plano. Assinaturas existentes mantêm o valor até a clínica mudar de plano.</p></div></header>
    ${list.map((p) => html`<form method="post" action="/planos/${p.key}" class="card form-grid">
      <h2 class="span2">${p.name} <small class="muted">${p.key}${p.public ? '' : ' · interno'}</small></h2>
      <label class="fld"><span>Nome</span><input name="name" value="${p.name}" maxlength="60" required></label>
      <label class="fld"><span>Preço mensal (R$)</span><input name="price" value="${String(p.price).replace('.', ',')}" inputmode="decimal" required></label>
      <label class="fld"><span>Profissionais incluídos</span><input type="number" name="max_pros" min="1" max="500" value="${p.maxPros}"></label>
      <label class="fld"><span>Profissional a mais (R$/mês, 0 = não permite)</span><input name="extra" value="${String(p.extraPro).replace('.', ',')}" inputmode="decimal"></label>
      <fieldset class="fld span2"><legend>Recursos</legend><div class="wl-chips">${Object.entries(Billing.FEATURES).map(([k, l]) => html`<label class="wl-chip"><input type="checkbox" name="f_${k}" value="1" ${p.features.includes(k) ? raw('checked') : ''}><span>${l}</span></label>`)}</div></fieldset>
      <label class="check"><input type="checkbox" name="public" value="1" ${p.public ? raw('checked') : ''}> Aparece para as clínicas escolherem</label>
      <div class="span2 actions"><button class="btn">Salvar ${p.name}</button></div></form>`)}`));
});
handle.post('/planos/:k', need, async (req, res) => {
  const b = req.body; const num = (v) => Math.max(0, Number(String(v || '0').replace(/\./g, '').replace(',', '.')) || 0);
  await T.pq('UPDATE plans SET name = ?, price = ?, max_pros = ?, extra_pro_price = ?, features = ?, public = ? WHERE plan_key = ?',
    [str(b.name, 60), num(b.price), Math.max(1, int(b.max_pros) || 1), num(b.extra), JSON.stringify(Object.keys(Billing.FEATURES).filter((k) => b[`f_${k}`])), b.public ? 1 : 0, req.params.k]);
  Billing.clearPlans(); await log(req, 'plano-editar', null, req.params.k);
  res.flash('Plano salvo.').redirect('/planos');
});
// ---------- cobrança (Asaas da Mentez) ----------
handle.get('/cobranca', need, async (req, res) => {
  const c = await Billing.config();
  const url = `https://${req.get('host')}/webhooks/asaas`;
  const ev = await T.pq('SELECT e.*, t.name tname FROM billing_events e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY e.id DESC LIMIT 30');
  send(res, layout(req, 'Cobrança', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Cobrança das clínicas</h1><p class="muted">Conta Asaas da Mentez, que cobra as mensalidades das clínicas (Pix, boleto ou cartão).</p></div></header>
    <form method="post" class="card form-grid">
      <label class="fld"><span>Ambiente</span><select name="env"><option value="sandbox" ${c.env === 'sandbox' ? raw('selected') : ''}>Testes (sandbox)</option><option value="producao" ${c.env === 'producao' ? raw('selected') : ''}>Produção</option></select></label>
      <label class="fld"><span>Chave de API ${c.key ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : ''}</span><input type="password" name="key" autocomplete="off" maxlength="300" placeholder="$aact_…"></label>
      <p class="span2 muted small">No Asaas: Integrações → Chave de API. Para testar sem cobrar ninguém, crie uma conta em sandbox.asaas.com e use a chave de lá com o ambiente “Testes”.</p>
      <div class="span2 actions"><button class="btn">Salvar</button></div></form>
    ${c.key ? html`<section class="card"><h2>Conexão e avisos automáticos</h2>
      <p class="small">Webhook: <code>${url}</code> · ${c.webhookAt ? html`registrado em ${brDateTime(c.webhookAt)}` : html`<b>ainda não registrado</b>`}</p>
      <div class="actions"><form method="post" action="/cobranca/testar"><button class="btn ghost">Testar conexão</button></form><form method="post" action="/cobranca/webhook"><button class="btn ghost">Registrar o webhook no Asaas</button></form></div></section>` : ''}
    <section class="card flush"><h2 class="pad">Últimos avisos do Asaas</h2>${ev.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Clínica</th><th>Evento</th><th>Situação</th><th>Valor</th><th>Vencimento</th></tr></thead><tbody>
      ${ev.map((e) => html`<tr><td>${brDateTime(e.created_at)}</td><td>${e.tname || '—'}</td><td>${e.event}</td><td>${e.status || ''}</td><td>${e.value ? money(e.value) : ''}</td><td>${e.due_date ? brDate(e.due_date) : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="pad muted">Nenhum aviso ainda.</p>`}</section>`));
});
handle.post('/cobranca', need, async (req, res) => {
  const k = String(req.body.key || '').trim();
  if (k && (k.length < 20 || /\s/.test(k))) return res.flash('Chave de API inválida (no Asaas ela começa com $aact_).', 'err').redirect('/cobranca');
  await Billing.saveConfig(req.body); await log(req, 'cobranca-config', null, req.body.env);
  res.flash('Configuração de cobrança salva.').redirect('/cobranca');
});
handle.post('/cobranca/testar', need, async (req, res) => {
  try { res.flash(`Conexão com o Asaas funcionando: ${await Billing.testConnection(await Billing.config())}.`); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect('/cobranca');
});
handle.post('/cobranca/webhook', need, async (req, res) => {
  try { await Billing.registerWebhook(await Billing.config(), `https://${req.get('host')}/webhooks/asaas`, req.admin.email); await log(req, 'cobranca-webhook'); res.flash('Webhook registrado no Asaas.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect('/cobranca');
});
handle.get('/historico', need, async (req, res) => {
  const rows = await T.pq('SELECT a.*, t.name tname FROM platform_audit a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.id DESC LIMIT 200');
  send(res, layout(req, 'Histórico', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Histórico</h1></div></header>
    <section class="card flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Clínica</th><th>Detalhe</th></tr></thead><tbody>
    ${rows.map((r) => html`<tr><td>${brDateTime(r.created_at)}</td><td>${r.actor || '—'}</td><td>${r.action}</td><td>${r.tname || '—'}</td><td class="small">${r.detail || ''}</td></tr>`)}</tbody></table></div></section>`));
});
handle.use((req, res) => res.status(404).send(String(layout(req, 'Não encontrado', html`<div class="center-card"><h1>Página não encontrada</h1><p><a href="/">Voltar</a></p></div>`))));
