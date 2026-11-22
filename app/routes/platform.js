// Painel da Mentez (app.mentez.com.br): só para a equipe da Mentez. Login próprio, separado do login das clínicas.
// Clínicas: criar, convite de primeiro acesso, suspender/reativar, domínios próprios, uso e histórico.
// Dados clínicos dos pacientes NÃO aparecem aqui — só contagens de uso.
import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import * as T from '../lib/tenancy.js';
import * as Domains from '../lib/domains.js';
import * as Evolution from '../lib/evolution.js';
import * as Brand from '../lib/brand.js';
import { statusItems } from './config.js';
import * as W from '../lib/whatsapp.js';
import { q, one, migrate } from '../lib/db.js';
import { bare, html, raw, brDate, brDateTime } from '../lib/html.js';
import { router, send, str, int, flash } from '../lib/router.js';
import { parseCookies, checkOrigin } from '../lib/auth.js';
import * as RL from '../lib/ratelimit.js';
import * as Billing from '../lib/billing.js';
import * as HelpBot from '../lib/helpbot.js';
import * as PlatComm from '../lib/platcomm.js';
import * as AISlot from '../lib/aislot.js';
import { mount as mountSignup } from './signup.js';
import { money } from '../lib/html.js';

export const handle = router();
// Avisos do Asaas sobre as mensalidades das clínicas (autenticados pelo token cadastrado no webhook)
handle.post('/webhooks/asaas', express.json({ limit: '200kb' }), async (req, res) => {
  if (!(await Billing.webhookAuth(req.get('asaas-access-token')))) return res.sendStatus(401);
  try { await Billing.handleEvent(req.body || {}); } catch (e) { console.error('webhook Mentez:', e.message); return res.sendStatus(500); }
  res.json({ ok: true });
});
// Avisos do Mercado Pago sobre as assinaturas (URL com o token da plataforma; assinatura secreta, se cadastrada)
handle.post('/webhooks/mercadopago', express.json({ limit: '200kb' }), async (req, res) => {
  if (!(await Billing.webhookAuth(String(req.query.t || '')))) return res.sendStatus(401);
  const type = String(req.body?.type || req.query.type || ''); const id = String(req.body?.data?.id || req.query['data.id'] || '');
  const c = await Billing.config();
  if (!Billing.mpSignatureOk(c, { signature: req.get('x-signature'), requestId: req.get('x-request-id'), dataId: id })) return res.sendStatus(401);
  try { await Billing.handleMercadoPago(type, id); } catch (e) { console.error('webhook Mentez (Mercado Pago):', e.message); return res.sendStatus(500); }
  res.json({ ok: true });
});
// Site mentez.com.br: planos, forma de pagamento e contato vindos do painel (lidos pelo navegador de quem visita o site)
const SITE_ORIGINS = ['https://mentez.com.br', 'https://www.mentez.com.br'];
handle.get('/api/site', async (req, res) => {
  const o = req.get('origin');
  res.set({ 'Access-Control-Allow-Origin': SITE_ORIGINS.includes(o) ? o : SITE_ORIGINS[0], Vary: 'Origin', 'Cache-Control': 'public, max-age=300' });
  res.json(await Billing.publicInfo());
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
  // equipe: papel, situação e convite por link (só o hash do código fica guardado)
  for (const [c, d] of [['role', "VARCHAR(20) NOT NULL DEFAULT 'admin'"], ['active', 'TINYINT(1) NOT NULL DEFAULT 1'], ['invite_hash', 'CHAR(64) NULL'], ['invite_expires', 'DATETIME NULL'], ['invited_by', 'VARCHAR(190) NULL'], ['phone', 'VARCHAR(40) NULL']]) {
    try { await T.pq(`ALTER TABLE platform_users ADD COLUMN ${c} ${d}`); } catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
  }
}
let ready = null;
handle.use((req, res, next) => { (ready ||= ensureTables().then(() => Billing.migrate())).then(() => next(), next); });
handle.use((req, res, next) => {
  const s = unsign(parseCookies(req)[COOKIE]);
  if (!s) return next();
  T.pone('SELECT id, name, email, phone, role, active, session_version FROM platform_users WHERE id = ?', [s.uid]).then((u) => { if (u && u.active && u.session_version === s.sv) req.admin = u; next(); }, next);
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
  recursos: SV('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
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
  equipe: SV('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><circle cx="17" cy="9" r="2.5"/><path d="M15.5 14.2c2.4.2 4.2 1.9 5 4.8"/>'),
};
const MENU = [
  ['PRINCIPAL', [['/', 'Visão geral', 'geral'], ['/clinicas', 'Clínicas', 'clinicas', 'clinicas'], ['/faturas', 'Assinaturas e faturas', 'faturas'], ['/testes', 'Testes grátis', 'testes', 'testes'], ['/recursos', 'Recursos ativos', 'recursos', 'alertasRec']]],
  ['CONFIGURAÇÃO', [['/planos', 'Planos e preços', 'planos'], ['/cobranca', 'Cobrança', 'cobranca'], ['/assistente', 'Assistente de ajuda', 'ajuda'], ['/comunicacao', 'WhatsApp e e-mail', 'sino'], ['/equipe', 'Equipe e usuários', 'equipe'], ['/historico', 'Histórico', 'historico']]],
];
// Papéis da equipe e o que cada um acessa (o administrador acessa tudo)
const ROLES = {
  admin: { label: 'Administrador', desc: 'Acesso a tudo, inclusive equipe, planos e cobrança.' },
  financeiro: { label: 'Financeiro', desc: 'Visão geral, clínicas (consulta), assinaturas e faturas, planos e cobrança.' },
  suporte: { label: 'Suporte', desc: 'Visão geral, clínicas (convites, domínios, WhatsApp), testes grátis e recursos ativos. Sem valores de cobrança.' },
};
// [método ou *, caminho, papéis]: a primeira regra que casa decide; sem regra, todos os papéis
const RULES = [
  ['*', /^\/equipe(\/|$)/, ['admin']],
  ['*', /^\/(faturas|planos|cobranca)(\/|$|\.)/, ['admin', 'financeiro']],
  ['*', /^\/assistente(\/|$)/, ['admin']],
  ['*', /^\/comunicacao(\/|$)/, ['admin', 'financeiro']],
  ['POST', /^\/clinicas\/\d+\/assinatura$/, ['admin', 'financeiro']],
  ['POST', /^\/clinicas(\/|$)/, ['admin', 'suporte']],
  ['GET', /^\/clinicas\/nova$/, ['admin', 'suporte']],
  ['*', /^\/(testes|recursos)(\/|$)/, ['admin', 'suporte']],
];
const allowed = (role, method, path) => { const r = RULES.find(([m, re]) => (m === '*' || m === method) && re.test(path)); return !r || r[2].includes(role || 'admin'); };
const LOGO = (dark = false) => raw(`<img class="mz2-logo" src="/static/img/mentez/${dark ? 'logo-dark' : 'logo'}.png" alt="Mentez" width="150" height="31">`);
const initialsOf = (n) => String(n || '').trim().split(/\s+/).filter(Boolean).map((x, i, a) => (i === 0 || i === a.length - 1 ? x[0] : '')).join('').toUpperCase().slice(0, 2);
let counts = { at: 0, v: {} };
async function menuCounts() {
  if (Date.now() - counts.at < 30e3) return counts.v;
  const all = await T.all();
  const v = { clinicas: all.length, testes: all.filter((t) => Billing.accessOf(t).state === 'teste').length, alertasRec: [...resCache.values()].filter((e) => Object.values(e.v || {}).some((x) => x?.tone === 'err')).length };
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
      ${MENU.map(([g, items]) => [g, items.filter(([href]) => allowed(req.admin.role, 'GET', href))]).filter(([, items]) => items.length).map(([g, items]) => html`<p class="mz2-grp">${g}</p><nav class="mz2-nav">${items.map(([href, label, ic, cnt]) => html`<a href="${href}" class="${act === href ? 'on' : ''}">${ICON[ic]}<span>${label}</span>${cnt && c[cnt] ? html`<b>${c[cnt]}</b>` : ''}</a>`)}</nav>`)}
      <p class="mz2-grp">GERAL</p>
      <nav class="mz2-nav"><a href="https://mentez.com.br" target="_blank" rel="noopener">${ICON.site}<span>Site da Mentez</span></a>
        <form method="post" action="/sair"><button type="submit">${ICON.sair}<span>Sair</span></button></form></nav>
      ${allowed(req.admin.role, 'GET', '/clinicas/nova') ? html`<div class="mz2-promo"><b>Nova clínica</b><span>Crie uma clínica e envie o convite de primeiro acesso.</span><a href="/clinicas/nova">Criar clínica</a></div>` : ''}
    </aside>
    <div class="mz2-col">
      <header class="mz2-top">
        <label for="mz2-menu" class="mz2-burger" role="button" aria-label="Abrir menu" aria-controls="mz2-side"><span></span><span></span><span></span></label>
        <a class="mz2-toplogo" href="/">${LOGO()}</a>
        <form class="mz2-search" action="/clinicas" method="get" role="search">${ICON.busca}<input type="search" name="q" placeholder="Buscar clínica, endereço ou e-mail" aria-label="Buscar clínica" value="${req.path === '/clinicas' ? str(req.query.q, 80) : ''}"><kbd>⌘ K</kbd></form>
        <div class="mz2-tools"><a class="mz2-ic" href="/historico" title="Histórico">${ICON.sino}</a><a class="mz2-ic" href="/termos-de-uso" title="Termos de uso">${ICON.ajuda}</a>
          <a class="mz2-me" href="/minha-conta" title="Minha conta · ${req.admin.email}"><i>${initialsOf(req.admin.name)}</i><span><b>${req.admin.name}</b><small>${ROLES[req.admin.role]?.label || 'Equipe Mentez'}</small></span></a></div>
      </header>
      <main class="mz2-main">${flash}${body}</main>
      <nav class="mz2-tabbar" aria-label="Atalhos">${[['/', 'Visão geral', 'geral'], ['/clinicas', 'Clínicas', 'clinicas'], ['/faturas', 'Faturas', 'faturas'], ['/testes', 'Testes', 'testes']].filter(([h]) => allowed(req.admin.role, 'GET', h)).map(([h, l, ic]) => html`<a href="${h}" class="${act === h ? 'on' : ''}">${ICON[ic]}<span>${l}</span></a>`)}<label for="mz2-menu">${SV('<path d="M4 7h16M4 12h16M4 17h16"/>')}<span>Menu</span></label></nav>
    </div>
  </div></div>`, 'bare mz2-body', req, { suffix: 'Painel Mentez' });
}
const need = (req, res, next) => {
  if (!req.admin) return res.redirect('/inicio');
  menuCounts().then((v) => { req.menuCounts = v; }, () => {}).then(() => {
    if (allowed(req.admin.role, req.method, req.path)) return next();
    res.status(403); send(res, layout(req, 'Sem acesso', html`<section class="card center-card"><h1>Sem acesso</h1><p>O seu papel (${ROLES[req.admin.role]?.label || req.admin.role}) não inclui esta área. Fale com um administrador da Mentez.</p><p><a class="btn" href="/">Voltar</a></p></section>`));
  });
};
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
  const good = u && u.active && u.password_hash && u.password_hash.startsWith('$2') && await bcrypt.compare(String(req.body.password || ''), u.password_hash);
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
    const row = await T.pone('SELECT asaas_subscription, mp_preapproval FROM tenants WHERE id = ?', [t.id]); if (row?.asaas_subscription || row?.mp_preapproval) subscribed++;
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
  const fin = allowed(req.admin.role, 'GET', '/faturas'); // valores de receita só para quem vê as faturas
  send(res, layout(req, 'Visão geral', html`<div class="mz2-hello"><div><h1>${hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite'}, ${first}</h1><p>Receita, clínicas e alertas da Mentez hoje.</p></div>
      <div class="mz2-hello-act"><span class="mz2-pill">${ICON.cal}${brDate(today)}</span><a class="mz2-btn dark" href="/clinicas.csv">${ICON.baixar}Exportar</a></div></div>
    <div class="mz2-grid">
      ${fin ? html`      <section class="mz2-card mz2-hero"><header><span class="mz2-cardic">${ICON.cobranca}</span><h2>Receita recorrente</h2><span class="mz2-pill sm">mensal</span></header>
        <strong class="mz2-big">${money(mrr)}</strong>
        <p class="mz2-trend"><span class="mz2-delta-l">${paying.length} clínica(s) pagante(s)${newPaying ? ` · ${newPaying} nova(s) no mês` : ''}</span></p>
        <div class="mz2-hero-act"><a class="mz2-btn pri" href="/clinicas/nova">${ICON.nova}Nova clínica</a><a class="mz2-btn soft" href="/faturas">${ICON.faturas}Ver faturas</a></div>
        <p class="mz2-sub">Por plano</p>
        <div class="mz2-mini">${plans.filter((p) => p.public).map((p) => { const n = paying.filter((x) => x.t.plan === p.key).length; return html`<div class="mz2-minicard"><span>${p.name}</span><b>${n}</b><small>${money(n * p.price)}/mês</small></div>`; })}
          <div class="mz2-minicard"><span>Cortesia</span><b>${acc.filter((x) => x.a.state === 'cortesia').length}</b><small>sem cobrança</small></div></div>
      </section>
      <section class="mz2-card mz2-kpi"><header><span class="mz2-cardic">${ICON.faturas}</span><h2>Recebido no mês</h2></header><strong class="mz2-big sm">${money(gotNow)}</strong><p class="mz2-trend">${trend(pct(gotNow, gotPrev))}</p></section>` : ''}
      <section class="mz2-card mz2-kpi"><header><span class="mz2-cardic">${ICON.testes}</span><h2>Testes em andamento</h2></header><strong class="mz2-big sm">${trials.length}</strong><p class="mz2-trend"><span class="mz2-delta ${trials.some((x) => x.a.daysLeft <= 5) ? 'warn' : ''}">${trials.filter((x) => x.a.daysLeft <= 5).length} terminam em até 5 dias</span></p></section>
      ${fin ? html`      <section class="mz2-card mz2-chart"><header><span class="mz2-cardic">${ICON.geral}</span><h2>Receita recebida por mês</h2><span class="mz2-legend"><i></i>Recebido</span><span class="mz2-pill sm">${year}</span></header>
        <div class="mz2-bars" role="img" aria-label="Receita recebida por mês em ${year}">
          <div class="mz2-yaxis">${[1, 0.75, 0.5, 0.25, 0].map((f) => html`<span>${money(top * f).replace(',00', '')}</span>`)}</div>
          <div class="mz2-cols">${byMonth.map((v, i) => html`<div class="mz2-colw ${i === curM ? 'on' : ''}" title="${MONTHS[i]}: ${money(v)}">${i === curM ? html`<span class="mz2-tip ${i >= 8 ? 'left' : ''}" style="bottom:calc(${Math.max(3, Math.round((v / top) * 82))}% + 30px)"><small>Recebido</small><b>${money(v)}</b></span>` : ''}<i style="height:${Math.max(3, Math.round((v / top) * 82))}%"></i><span>${MONTHS[i]}</span></div>`)}</div>
        </div>
        ${byMonth.every((v) => !v) ? html`<p class="mz2-empty">Ainda não há pagamentos confirmados pelo Asaas neste ano.</p>` : ''}
      </section>
      <section class="mz2-card mz2-kpi"><header><span class="mz2-cardic">${ICON.cobranca}</span><h2>Em atraso</h2></header><strong class="mz2-big sm">${money(lateValue)}</strong><p class="mz2-trend"><span class="mz2-delta ${late.length ? 'down' : 'up'}">${late.length} clínica(s)</span></p></section>` : ''}
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
  const subs = await T.pq('SELECT id, plan, billing_status, asaas_subscription, paid_until, overdue_since, extra_pros FROM tenants WHERE asaas_subscription IS NOT NULL OR mp_preapproval IS NOT NULL OR billing_status IN (\'ativa\',\'atrasada\',\'pendente\',\'cancelada\') ORDER BY name');
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
// ---------- Recursos ativos: o que cada clínica tem ligado (WhatsApp, domínio, integrações…) ----------
// Lê a mesma situação da tela de Configurações de cada clínica (rodando no banco dela). Guardado por 5 minutos.
const RES_COLS = [
  ['evolution', 'Instância Evolution', 'Evolution'], ['dominio', 'Domínio próprio', 'Domínio'], ['google', 'Google Agenda', 'Google'], ['whatsapp', 'WhatsApp', 'WhatsApp'],
  ['agente', 'Atendente virtual (IA)', 'Atendente IA'], ['monitor', 'Monitoramento de alertas', 'Alertas'], ['tv', 'Painel de chamada (TV)', 'TV'],
  ['agendamento-online', 'Agendamento online', 'Agendamento'], ['cobranca', 'Cobrança online', 'Cobrança'], ['lembretes', 'Lembretes por e-mail e SMS', 'E-mail/SMS'],
  ['assinatura-digital', 'Assinatura digital', 'Assinatura'], ['convenios', 'Convênios', 'Convênio'], ['nfse', 'Nota fiscal (NFS-e)', 'NFS-e'], ['teleconsulta', 'Teleconsulta', 'Teleconsulta'],
  ['aniversarios', 'Mensagem de aniversário', 'Aniversário'], ['locacao', 'Locação de espaço', 'Locação'], ['portal', 'Portal do paciente', 'Portal'], ['sessao-ia', 'IA na sessão', 'IA sessão'], ['backup', 'Backup', 'Backup'],
];
// situação → tom: on (ligado e funcionando), warn (ligado com pendência), err (com problema), off (desligado)
const TONE = { realizada: 'on', confirmada: 'warn', agendada: 'warn', falta: 'err', cancelada: 'off' };
const resCache = new Map();
let evoCache = { at: 0, v: null, err: null };
async function evoAll(fresh = false) {
  if (!Evolution.enabled()) return { v: null, err: 'não configurada neste servidor' };
  if (!fresh && Date.now() - evoCache.at < 60e3) return evoCache;
  try { evoCache = { at: Date.now(), v: await Evolution.listAll(), err: null }; } catch (e) { evoCache = { at: Date.now(), v: null, err: e.message }; }
  return evoCache;
}
async function resourcesOf(t, fresh = false) {
  const hit = resCache.get(t.id);
  if (!fresh && hit && Date.now() - hit.at < 5 * 60e3) return hit.v;
  const evo = await evoAll(fresh);
  const v = await T.run(t, async () => {
    await Brand.load(true);
    const items = await statusItems({ master: true });
    const by = {};
    for (const it of items) by[it.key === 'assinatura' && it.title === 'Assinatura digital' ? 'assinatura-digital' : it.key] = { tone: TONE[it.status[0]] || 'off', label: it.status[1] };
    // “ligado” só quando está em uso de verdade
    if (by.tv && /^0 TV/.test(by.tv.label)) by.tv = { tone: 'off', label: 'Nenhuma TV conectada' };
    if (by.nfse && /Aguardando CNPJ/.test(by.nfse.label)) by.nfse.tone = 'off';
    // instância Evolution
    const wc = await W.config().catch(() => null);
    if (wc?.url && !wc.managed) by.evolution = { tone: 'on', label: 'Evolution própria da clínica' };
    else if (!wc?.managed) by.evolution = { tone: Evolution.enabled() ? 'err' : 'off', label: Evolution.enabled() ? 'Sem instância' : 'Evolution da Mentez desligada' };
    else { const i = evo.v?.get(wc.instance); by.evolution = !evo.v ? { tone: 'warn', label: `${wc.instance} · Evolution sem resposta` } : !i ? { tone: 'err', label: `${wc.instance} não existe na Evolution` } : i.status === 'open' ? { tone: 'on', label: `${wc.instance} · conectada${i.number ? ` · ${i.number.replace(/^55/, '')}` : ''}` } : { tone: 'warn', label: `${wc.instance} · ${i.status === 'connecting' ? 'aguardando QR code' : 'desconectada'}` }; }
    const ds = await Domains.list(t.id).catch(() => []);
    const on = ds.find((d) => d.verified_at && d.https_at);
    by.dominio = on ? { tone: 'on', label: on.domain + (on.is_primary ? ' · principal' : '') } : ds.length ? { tone: 'warn', label: `${ds[0].domain} · ${Domains.stateOf(ds[0]).label}` } : { tone: 'off', label: 'Não usa' };
    return by;
  }).catch((e) => ({ _err: e.message }));
  resCache.set(t.id, { at: Date.now(), v });
  return v;
}
// até 4 clínicas ao mesmo tempo
async function mapLimit(list, n, fn) { const out = []; let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } })); return out; }

handle.get('/recursos', need, async (req, res) => {
  const fresh = req.query.atualizar === '1';
  const list = (await T.all()).filter((t) => t.status !== 'cancelada');
  const evo = await evoAll(fresh);
  const rows = await mapLimit(list, 4, (t) => resourcesOf(t, fresh));
  const f = String(req.query.r || '');
  const counts = RES_COLS.map(([k]) => rows.reduce((n, r) => n + (['on', 'warn'].includes(r?.[k]?.tone) ? 1 : 0), 0));
  const errs = RES_COLS.map(([k]) => rows.reduce((n, r) => n + (r?.[k]?.tone === 'err' ? 1 : 0), 0));
  const show = list.map((t, i) => ({ t, r: rows[i] })).filter((x) => !f || (x.r?.[f] && x.r[f].tone !== 'off'));
  const dot = (x, label) => (x ? html`<span class="mz2-dot ${x.tone}" title="${label}: ${x.label}" aria-label="${label}: ${x.label}"></span>` : html`<span class="mz2-dot off" title="${label}: sem dados"></span>`);
  send(res, layout(req, 'Recursos ativos', html`<div class="mz2-hello"><div><h1>Recursos ativos</h1><p>O que cada clínica tem ligado e funcionando. Passe o mouse (ou toque) em um ponto para ver o detalhe.</p></div>
      <div class="mz2-hello-act"><a class="mz2-btn soft" href="/recursos?atualizar=1${f ? `&r=${f}` : ''}">Atualizar agora</a></div></div>
    <section class="mz2-card"><header><span class="mz2-cardic">${ICON.recursos}</span><h2>Resumo</h2><span class="mz2-pill sm">${list.length} clínica(s)</span>
      ${Evolution.enabled() ? html`<span class="mz2-pill sm ${evo.err ? 'err' : ''}">Evolution: ${evo.err ? `sem resposta (${evo.err})` : `${evo.v?.size || 0} instância(s)`}</span>` : html`<span class="mz2-pill sm">Evolution da Mentez desligada</span>`}</header>
      <div class="mz2-res-sum">${RES_COLS.map(([k, label], i) => html`<a class="mz2-res-it ${f === k ? 'on' : ''}" href="/recursos${f === k ? '' : `?r=${k}`}"><span>${label}</span><b>${counts[i]}<small>/${list.length}</small></b>${errs[i] ? html`<em>${errs[i]} com problema</em>` : ''}</a>`)}</div>
      <p class="mz2-legend-row"><span class="mz2-dot on"></span> ligado <span class="mz2-dot warn"></span> pendente <span class="mz2-dot err"></span> com problema <span class="mz2-dot off"></span> desligado</p></section>
    <section class="mz2-card mz2-table mz2-res">${show.length ? html`<div class="mz2-tw"><table><thead><tr><th>Clínica</th>${RES_COLS.map(([, , short]) => html`<th class="mz2-rot"><span>${short}</span></th>`)}</tr></thead><tbody>
      ${show.map(({ t, r }) => html`<tr><td><a href="/clinicas/${t.id}#recursos"><span class="mz2-av">${initialsOf(t.name)}</span>${t.name}</a>${r?._err ? html`<br><small class="mz2-err">${r._err}</small>` : ''}</td>${RES_COLS.map(([k, label]) => html`<td class="mz2-c">${dot(r?.[k], label)}</td>`)}</tr>`)}
    </tbody></table></div>` : html`<p class="mz2-empty">Nenhuma clínica com este recurso ligado.</p>`}</section>`));
});
handle.post('/clinicas/:id/whatsapp', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  try {
    const r = await T.run(t, () => Evolution.provision(t, { force: req.body.forcar === '1' }));
    if (!r.ok) throw new Error(r.reason);
    await log(req, 'whatsapp-instancia', t.id, `${r.instance}${r.created ? ' criada' : ' reaproveitada'}`);
    resCache.delete(t.id); evoCache.at = 0;
    res.flash(`Instância ${r.instance} ${r.created ? 'criada' : 'pronta'}. A clínica lê o QR code no painel dela.`);
  } catch (e) { res.flash(`WhatsApp: ${e.message}`, 'err'); }
  res.redirect(`/clinicas/${t.id}#recursos`);
});

// QR code da instância da clínica (Evolution da Mentez), para a equipe da Mentez conectar junto com a clínica
handle.get('/clinicas/:id/whatsapp/qr', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  const wc = await T.run(t, () => W.config()).catch(() => null);
  if (!wc?.managed) return res.flash('A clínica não usa a Evolution da Mentez.', 'err').redirect(`/clinicas/${t.id}#recursos`);
  send(res, layout(req, `WhatsApp · ${t.name}`, await qrPage({ title: `WhatsApp de ${t.name}`, instance: wc.instance, back: `/clinicas/${t.id}#recursos`, hint: 'No celular da clínica: WhatsApp → Aparelhos conectados → Conectar um aparelho, e aponte para o QR code.' })));
});
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
    Evolution.provisionLater(t, req.admin.email); // instância do WhatsApp da clínica
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
      ${(() => { const a = Billing.accessOf(t); return html`<p><b>${{ cortesia: 'Cortesia (sem cobrança)', teste: `Teste grátis · ${a.daysLeft} dia(s) restantes (até ${brDate(a.ends)})`, ativa: 'Em dia', atrasada: `Em aberto há ${a.late} dia(s)`, bloqueada: `Acesso suspenso (${a.reason})` }[a.state]}</b> · plano ${t.plan}${row.paid_until ? ` · pago até ${brDate(row.paid_until)}` : ''}${row.asaas_subscription ? ` · assinatura Asaas ${row.asaas_subscription}` : ''}${row.mp_preapproval ? ` · assinatura Mercado Pago ${row.mp_preapproval}` : ''}${row.extra_pros ? ` · ${row.extra_pros} profissional(is) extra` : ''}</p>`; })()}
      ${row.owner_crp ? html`<p class="small muted">Cadastro: ${row.owner_name || ''} · CRP ${row.owner_crp} · ${row.owner_phone || ''} · ${row.owner_email || ''} — confira o CRP no Cadastro Nacional do CFP.</p>` : ''}
      <form method="post" action="/clinicas/${t.id}/assinatura" class="actions">
        <select name="plan" aria-label="Plano">${(await Billing.plans()).map((p) => html`<option value="${p.key}" ${p.key === t.plan ? raw('selected') : ''}>${p.name}</option>`)}</select>
        <button class="btn ghost btn-sm" name="acao" value="plano">Trocar plano</button>
        <button class="btn ghost btn-sm" name="acao" value="cortesia" data-confirm="Marcar como cortesia? A clínica deixa de ser cobrada pela Mentez.">Cortesia</button>
        <button class="btn ghost btn-sm" name="acao" value="teste7">Teste + 7 dias</button>
      </form>
      ${await billingBlock(t, row)}
      <form method="post" action="/clinicas/${t.id}/convenio" class="actions" id="convenio">
        <label class="fld inline"><span>Módulo de convênio</span><select name="ins_mode">${Object.entries(Billing.INS_MODES).map(([k, l]) => html`<option value="${k}" ${(t.insMode || '') === k ? raw('selected') : ''}>${l}</option>`)}</select></label>
        <button class="btn ghost btn-sm">Salvar</button>
        <small class="muted">Agora: ${await (async () => { const m = await Billing.insModeOf(t); return m === 'integrado' ? 'integrado' : m === 'simples' ? 'simples' : 'sem convênio'; })()}. O simples tem cadastro dos convênios, carteirinhas, autorizações, sessão por convênio e o controle do que cada operadora deve; o integrado acrescenta TISS, lotes XML, glosas, recursos e webservice.</small>
      </form>
    </section>
    ${await (async () => { const r = await resourcesOf(t, req.query.atualizar === '1'); const wc = await T.run(t, () => W.config()).catch(() => null); return html`<section class="card" id="recursos"><h2>Recursos e integrações</h2>
      ${r?._err ? html`<p class="flash err">Não foi possível ler: ${r._err}</p>` : html`<ul class="mz2-res-list">${RES_COLS.map(([k, label]) => html`<li><span class="mz2-dot ${r?.[k]?.tone || 'off'}"></span><b>${label}</b><span class="muted small">${r?.[k]?.label || '—'}</span></li>`)}</ul>`}
      <p class="actions"><a class="btn ghost btn-sm" href="/clinicas/${t.id}?atualizar=1#recursos">Atualizar</a>
        ${Evolution.enabled() ? (wc?.url && !wc.managed ? html`<form method="post" action="/clinicas/${t.id}/whatsapp"><input type="hidden" name="forcar" value="1"><button class="btn ghost btn-sm" data-confirm="A clínica usa uma Evolution própria. Trocar pela Evolution da Mentez? Ela terá de ler um novo QR code.">Usar a Evolution da Mentez</button></form>`
          : html`<form method="post" action="/clinicas/${t.id}/whatsapp"><button class="btn ghost btn-sm">${wc?.managed ? 'Refazer a instância do WhatsApp' : 'Criar instância do WhatsApp'}</button></form>`) : ''}
        ${Evolution.enabled() && wc?.managed ? html`<a class="btn ghost btn-sm" href="/clinicas/${t.id}/whatsapp/qr">Conectar o WhatsApp (QR code)</a>` : ''}</p>
    </section>`; })()}
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
handle.post('/clinicas/:id/convenio', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  const m = Object.keys(Billing.INS_MODES).includes(req.body.ins_mode) ? req.body.ins_mode : '';
  await T.pq('UPDATE tenants SET ins_mode = ? WHERE id = ?', [m || null, t.id]); T.clearCache();
  await log(req, 'clinica-convenio', t.id, Billing.INS_MODES[m]);
  res.flash(`Módulo de convênio: ${Billing.INS_MODES[m]}.`).redirect(`/clinicas/${t.id}#convenio`);
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
// ---------- cobrança de uma clínica: ativar (cortesia → cobrança) e enviar o link por WhatsApp/e-mail ----------
async function billingBlock(t, row) {
  const a = Billing.accessOf(t); const c = await Billing.config(); const plans = (await Billing.plans()).filter((p) => p.public);
  const subscribed = !!(row.asaas_subscription || row.mp_preapproval);
  const sendForm = (link) => html`<form method="post" action="/clinicas/${t.id}/enviar-cobranca" class="form-grid" style="margin-top:12px">
      <h3 class="span2" style="margin:0">Enviar cobrança</h3>
      ${link?.auto ? html`<p class="span2 muted small">Assinatura autorizada no Mercado Pago: a mensalidade é cobrada no cartão automaticamente.</p>` : link?.url ? html`<p class="span2 small">Link: <a href="${link.url}" target="_blank" rel="noopener">${link.kind === 'autorizar' ? 'autorizar a assinatura no Mercado Pago' : 'fatura em aberto (Asaas)'}</a></p>` : html`<p class="span2 muted small">Nenhuma fatura em aberto agora.</p>`}
      <label class="fld"><span>WhatsApp</span><input name="phone" value="${row.owner_phone || ''}" maxlength="40" inputmode="tel"></label>
      <label class="fld"><span>E-mail</span><input type="email" name="email" value="${row.owner_email || ''}" maxlength="190"></label>
      <div class="span2 actions"><button class="btn btn-sm" name="via" value="whatsapp" ${link?.url ? '' : raw('disabled')}>Enviar pelo WhatsApp</button><button class="btn ghost btn-sm" name="via" value="email" ${link?.url ? '' : raw('disabled')}>Enviar por e-mail</button><button class="btn ghost btn-sm" name="via" value="ambos" ${link?.url ? '' : raw('disabled')}>Os dois</button></div></form>`;
  if (a.state === 'cortesia' && !subscribed) {
    return html`<details class="card-sub" style="margin:14px 0 18px"><summary class="btn ghost btn-sm">Ativar cobrança desta clínica</summary>
      <form method="post" action="/clinicas/${t.id}/ativar-cobranca" class="form-grid" style="margin-top:12px">
        <p class="span2 muted small">A clínica sai da cortesia e passa a ser cobrada pelo ${Billing.PROVIDERS[c.provider].label} (${Billing.PROVIDERS[c.provider].methods.join(', ')}). ${Billing.ready(c) ? '' : html`<b>Configure a cobrança em <a href="/cobranca">Cobrança</a> antes.</b>`}</p>
        <label class="fld"><span>Plano</span><select name="plan" required>${plans.map((p) => html`<option value="${p.key}" ${p.key === t.plan ? raw('selected') : ''}>${p.name} — R$ ${String(p.price).replace('.', ',')}/mês</option>`)}</select></label>
        <label class="fld"><span>Primeira cobrança</span><select name="dias"><option value="0">Agora</option><option value="7">Daqui a 7 dias</option><option value="15">Daqui a 15 dias</option><option value="30">Daqui a 30 dias</option></select></label>
        <label class="fld"><span>Nome ou razão social de quem paga</span><input name="payer_name" value="${row.owner_name || t.name}" maxlength="120" required></label>
        <label class="fld"><span>CPF ou CNPJ ${c.provider === 'asaas' ? '' : html`<small class="muted">(opcional no Mercado Pago)</small>`}</span><input name="payer_doc" maxlength="18" inputmode="numeric" ${c.provider === 'asaas' ? raw('required') : ''}></label>
        <label class="fld"><span>E-mail ${c.provider === 'mercadopago' ? html`<small class="muted">(da conta do Mercado Pago)</small>` : ''}</span><input type="email" name="email" value="${row.owner_email || ''}" maxlength="190" required></label>
        <label class="fld"><span>WhatsApp</span><input name="phone" value="${row.owner_phone || ''}" maxlength="40" inputmode="tel"></label>
        <fieldset class="fld span2"><legend>Avisar a clínica agora</legend><label class="check"><input type="checkbox" name="send_wa" value="1" checked> pelo WhatsApp da Mentez</label> <label class="check"><input type="checkbox" name="send_mail" value="1" checked> por e-mail</label></fieldset>
        <div class="span2 actions"><button class="btn" ${Billing.ready(c) ? '' : raw('disabled')} data-confirm="Ativar a cobrança de ${t.name}? A clínica deixa de ser cortesia.">Ativar cobrança</button></div>
      </form></details>`;
  }
  if (!subscribed) return '';
  const link = await Billing.paymentLink(t).catch(() => null);
  return sendForm(link);
}
async function sendBilling(t, link, { phone, email, via }) {
  const row = await T.pone('SELECT owner_name, plan, extra_pros FROM tenants WHERE id = ?', [t.id]);
  const plan = (await Billing.plans()).find((p) => p.key === row.plan);
  const first = String(row.owner_name || '').split(' ')[0] || 'tudo bem';
  const value = plan ? `R$ ${Billing.monthly(plan, row.extra_pros).toFixed(2).replace('.', ',')}/mês` : '';
  const contact = await Billing.siteContact();
  const action = link.kind === 'autorizar' ? 'Para ativar, autorize o pagamento mensal no Mercado Pago (cartão de crédito):' : 'Para pagar (Pix, boleto ou cartão):';
  const body = `Olá, ${first}! Aqui é da Mentez.\n\nA assinatura da clínica ${t.name}${plan ? ` — plano ${plan.name}, ${value}` : ''} — está disponível.`;
  const out = [];
  if (via === 'whatsapp' || via === 'ambos') {
    try { await PlatComm.waSend(phone, `${body}\n\n${action}\n${link.url}\n\nQualquer dúvida, é só responder aqui ou escrever para ${contact}.`); out.push('WhatsApp enviado'); } catch (e) { out.push(`WhatsApp não enviado: ${e.message}`); }
  }
  if (via === 'email' || via === 'ambos') {
    try { await PlatComm.mailSend(email, `Mentez — assinatura da clínica ${t.name}`, `${body}\n\n${action}\n\nQualquer dúvida, responda este e-mail ou escreva para ${contact}.`, { label: link.kind === 'autorizar' ? 'Autorizar no Mercado Pago' : 'Pagar a mensalidade', url: link.url }); out.push('e-mail enviado'); } catch (e) { out.push(`e-mail não enviado: ${e.message}`); }
  }
  return out;
}
handle.post('/clinicas/:id/ativar-cobranca', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  const b = req.body; const dias = [0, 7, 15, 30].includes(int(b.dias)) ? int(b.dias) : 0;
  const plan = (await Billing.plans()).find((p) => p.key === b.plan && p.public);
  if (!plan) return res.flash('Escolha um plano.', 'err').redirect(`/clinicas/${t.id}`);
  const prev = await T.pone('SELECT billing_status, trial_ends_at, plan FROM tenants WHERE id = ?', [t.id]);
  // a assinatura calcula a situação: com prazo, fica em “teste” até a 1ª cobrança; sem prazo, a 1ª cobrança vence hoje
  await T.pq(`UPDATE tenants SET trial_ends_at = ${dias ? 'DATE_ADD(CURDATE(), INTERVAL ? DAY)' : 'NULL'}, owner_phone = COALESCE(NULLIF(?, ''), owner_phone), owner_email = COALESCE(NULLIF(?, ''), owner_email) WHERE id = ?`,
    [...(dias ? [dias] : []), str(b.phone, 40) || '', str(b.email, 190) || '', t.id]);
  T.clearCache();
  const fresh = await T.bySlug(t.slug);
  try {
    const out = await Billing.subscribe(fresh, { planKey: plan.key, payerName: str(b.payer_name, 120), payerDoc: b.payer_doc, email: str(b.email, 190), phone: str(b.phone, 40) });
    await log(req, 'cobranca-ativar', t.id, `${plan.key} · ${out.provider || 'asaas'} · ${dias ? `${dias} dias` : 'agora'}`);
    let msg = `Cobrança ativada: plano ${plan.name}, ${dias ? `primeira cobrança em ${dias} dias` : 'primeira cobrança hoje'}.`;
    const via = b.send_wa && b.send_mail ? 'ambos' : b.send_wa ? 'whatsapp' : b.send_mail ? 'email' : null;
    if (via) {
      const link = await Billing.paymentLink(fresh).catch(() => null);
      if (link?.url) msg += ` ${(await sendBilling(fresh, link, { phone: b.phone, email: b.email, via })).join(' · ')}.`;
      else msg += ' O link de pagamento ainda não está disponível; use “Enviar cobrança” em instantes.';
    }
    res.flash(msg);
  } catch (e) {
    await T.pq('UPDATE tenants SET billing_status = ?, trial_ends_at = ?, plan = ? WHERE id = ?', [prev.billing_status, prev.trial_ends_at, prev.plan, t.id]); T.clearCache(); // volta para a situação anterior (cortesia)
    res.flash(`Não foi possível ativar a cobrança: ${e.message}`, 'err');
  }
  res.redirect(`/clinicas/${t.id}`);
});
handle.post('/clinicas/:id/enviar-cobranca', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  const link = await Billing.paymentLink(t).catch((e) => ({ error: e.message }));
  if (!link?.url) return res.flash(link?.error ? `Cobrança: ${link.error}` : 'Não há link de pagamento em aberto para enviar.', 'err').redirect(`/clinicas/${t.id}`);
  const via = ['whatsapp', 'email', 'ambos'].includes(req.body.via) ? req.body.via : 'whatsapp';
  const out = await sendBilling(t, link, { phone: req.body.phone, email: req.body.email, via });
  await log(req, 'cobranca-enviar', t.id, out.join(' · '));
  res.flash(out.join(' · '), out.some((x) => /não/.test(x)) ? 'warn' : 'ok').redirect(`/clinicas/${t.id}`);
});
// ---------- WhatsApp e e-mail da Mentez ----------
async function qrPage({ title, instance, back, hint }) {
  let st = await PlatComm.stateOf(instance); let qr = null; let err = '';
  if (st !== 'open') { try { const r = await PlatComm.qrOf(instance); qr = r.qr; st = r.state || st; } catch (e) { err = e.message; } }
  return html`${st !== 'open' ? html`<meta http-equiv="refresh" content="20">` : ''}<header class="ph"><div><p class="eyebrow">WhatsApp</p><h1>${title}</h1></div><div class="ph-actions"><a class="btn ghost" href="${back}">Voltar</a></div></header>
    <section class="card mz-qr">${st === 'open' ? html`<p><span class="badge b-realizada">Conectado</span> Tudo certo: o WhatsApp está conectado.</p>`
      : html`<p class="muted">${hint} O QR code se renova sozinho a cada 20 segundos.</p>${qr ? html`<img src="${qr}" alt="QR code para conectar o WhatsApp" width="280" height="280" style="image-rendering:pixelated;background:#fff;padding:10px;border-radius:12px">` : html`<p class="flash warn">${err || 'O QR code ainda não está pronto. Aguarde alguns segundos.'}</p>`}<p class="small muted">Situação: ${st}</p>`}</section>`;
}
handle.get('/comunicacao', need, async (req, res) => {
  const wa = await PlatComm.waStatus().catch((e) => ({ state: `erro: ${e.message}` }));
  const m = await PlatComm.mailConfig();
  const sel = (a2, b2) => (a2 === b2 ? raw('selected') : '');
  send(res, layout(req, 'WhatsApp e e-mail', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>WhatsApp e e-mail da Mentez</h1><p class="muted">Canais da própria Mentez para falar com as clínicas: cobrança, avisos e relacionamento. Independentes do WhatsApp de cada clínica.</p></div></header>
    <section class="card"><h2>WhatsApp da Mentez</h2>
      ${wa.state === 'indisponivel' ? html`<p class="flash warn">A Evolution da Mentez não está configurada neste servidor.</p>`
        : wa.state === 'sem-instancia' ? html`<p class="muted">Ainda não existe a instância da plataforma na Evolution.</p><form method="post" action="/comunicacao/whatsapp/criar"><button class="btn">Criar a instância da Mentez</button></form>`
        : html`<p>${wa.state === 'open' ? html`<span class="badge b-realizada">Conectado</span> ${wa.profileName || ''} ${wa.number ? `· +${wa.number}` : ''}` : html`<span class="badge b-falta">Desconectado</span>`} <small class="muted">instância ${PlatComm.INSTANCE}</small></p>
          <div class="actions">${wa.state !== 'open' ? html`<a class="btn" href="/comunicacao/whatsapp/qr">Conectar (QR code)</a>` : html`<form method="post" action="/comunicacao/whatsapp/sair" data-confirm="Desconectar o WhatsApp da Mentez?"><button class="btn ghost danger-text">Desconectar</button></form>`}</div>
          ${wa.state === 'open' ? html`<form method="post" action="/comunicacao/whatsapp/teste" class="actions"><input name="phone" placeholder="Celular com DDD" maxlength="40" inputmode="tel" required><button class="btn ghost">Enviar mensagem de teste</button></form>` : ''}`}
    </section>
    <form method="post" action="/comunicacao/email" class="card form-grid"><h2 class="span2">E-mail da Mentez (SMTP)</h2>
      <label class="fld"><span>Servidor SMTP</span><input name="host" value="${m.host}" maxlength="190" placeholder="smtp.hostinger.com"></label>
      <label class="fld"><span>Porta</span><input type="number" name="port" value="${m.port}" min="1" max="65535"></label>
      <label class="fld"><span>Segurança</span><select name="secure">${Object.entries(PlatComm.SECURE).map(([k, l]) => html`<option value="${k}" ${sel(m.secure, k)}>${l}</option>`)}</select></label>
      <label class="fld"><span>Usuário</span><input name="user" value="${m.user}" maxlength="190" autocomplete="off" placeholder="contato@mentez.com.br"></label>
      <label class="fld"><span>Senha ${m.pass ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : ''}</span><input type="password" name="pass" autocomplete="new-password" maxlength="200"></label>
      <label class="fld"><span>Nome do remetente</span><input name="fromName" value="${m.fromName}" maxlength="80"></label>
      <label class="fld"><span>E-mail do remetente</span><input type="email" name="fromEmail" value="${m.fromEmail}" maxlength="190" placeholder="contato@mentez.com.br"></label>
      ${m.pass ? html`<label class="check span2"><input type="checkbox" name="pass_clear" value="1"> Apagar a senha</label>` : ''}
      <p class="span2 muted small">Na Hostinger: E-mails → contato@mentez.com.br → Configurações de conexão (SMTP smtp.hostinger.com, porta 465, SSL).</p>
      <div class="span2 actions"><button class="btn">Salvar</button></div></form>
    ${PlatComm.mailReady(m) ? html`<form method="post" action="/comunicacao/email/teste" class="card actions"><input type="email" name="to" placeholder="E-mail para o teste" required maxlength="190"><button class="btn ghost">Enviar e-mail de teste</button></form>` : ''}`));
});
handle.post('/comunicacao/whatsapp/criar', need, async (req, res) => {
  try { await PlatComm.waCreate(); await log(req, 'plataforma-whatsapp-criar'); res.redirect('/comunicacao/whatsapp/qr'); } catch (e) { res.flash(`WhatsApp: ${e.message}`, 'err').redirect('/comunicacao'); }
});
handle.get('/comunicacao/whatsapp/qr', need, async (req, res) => {
  send(res, layout(req, 'WhatsApp da Mentez', await qrPage({ title: 'WhatsApp da Mentez', instance: PlatComm.INSTANCE, back: '/comunicacao', hint: 'No celular da Mentez: WhatsApp → Aparelhos conectados → Conectar um aparelho, e aponte para o QR code.' })));
});
handle.post('/comunicacao/whatsapp/sair', need, async (req, res) => {
  try { await PlatComm.waLogout(); await log(req, 'plataforma-whatsapp-sair'); res.flash('WhatsApp da Mentez desconectado.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect('/comunicacao');
});
handle.post('/comunicacao/whatsapp/teste', need, async (req, res) => {
  try { await PlatComm.waSend(req.body.phone, 'Teste do WhatsApp da Mentez ✅'); res.flash('Mensagem de teste enviada.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect('/comunicacao');
});
handle.post('/comunicacao/email', need, async (req, res) => {
  const r = await PlatComm.saveMail(req.body, await PlatComm.mailConfig());
  if (r.error) return res.flash(r.error, 'err').redirect('/comunicacao');
  await log(req, 'plataforma-email-config'); res.flash('E-mail da Mentez salvo.').redirect('/comunicacao');
});
handle.post('/comunicacao/email/teste', need, async (req, res) => {
  try { await PlatComm.mailSend(str(req.body.to, 190), 'Teste do e-mail da Mentez', 'Se você recebeu esta mensagem, o envio de e-mails da Mentez está funcionando.'); res.flash('E-mail de teste enviado.'); } catch (e) { res.flash(`E-mail: ${e.message}`, 'err'); }
  res.redirect('/comunicacao');
});
// ---------- planos ----------
handle.get('/planos', need, async (req, res) => {
  const list = await Billing.plans(true);
  const uses = Object.fromEntries((await T.pq('SELECT plan, COUNT(*) n FROM tenants GROUP BY plan')).map((r) => [r.plan, Number(r.n)]));
  send(res, layout(req, 'Planos', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Planos</h1><p class="muted">Preços e limites valem para novas assinaturas e mudanças de plano. Assinaturas existentes mantêm o valor até a clínica mudar de plano. O site <a href="https://mentez.com.br/precos/" target="_blank" rel="noopener">mentez.com.br</a> mostra os planos marcados como visíveis, com estes nomes, preços e recursos (atualiza em até 5 minutos).</p></div></header>
    <form method="post" action="/planos/site" class="card form-grid"><h2 class="span2">Site</h2>
      <label class="fld"><span>E-mail de contato no site</span><input type="email" name="contact" value="${await Billing.siteContact()}" maxlength="120" required></label>
      <p class="fld muted small">A forma de pagamento mostrada no site acompanha o provedor escolhido em <a href="/cobranca">Cobrança</a>.</p>
      <div class="span2 actions"><button class="btn ghost">Salvar</button></div></form>
    <details class="card" ${req.query.novo ? raw('open') : ''}><summary class="btn">+ Novo plano</summary>
      <form method="post" action="/planos/novo" class="form-grid" style="margin-top:16px">
        <label class="fld"><span>Nome</span><input name="name" maxlength="60" required placeholder="Ex.: Clínica Plus"></label>
        <label class="fld"><span>Código <small class="muted">(letras minúsculas, números e hífen; não muda depois)</small></span><input name="key" maxlength="30" pattern="[a-z0-9][a-z0-9-]{1,29}" placeholder="clinica-plus"></label>
        <label class="fld"><span>Preço mensal (R$)</span><input name="price" inputmode="decimal" required></label>
        <label class="fld"><span>Profissionais incluídos</span><input type="number" name="max_pros" min="1" max="500" value="1"></label>
        <label class="fld"><span>Profissional a mais (R$/mês, 0 = não permite)</span><input name="extra" inputmode="decimal" value="0"></label>
        <label class="fld"><span>Copiar os recursos de</span><select name="copy"><option value="">Nenhum (escolho depois)</option>${list.map((p) => html`<option value="${p.key}">${p.name}</option>`)}</select></label>
        <p class="span2 muted small">O plano novo começa <b>interno</b> (fora do site e da tela de assinatura das clínicas). Revise os recursos e marque “Aparece para as clínicas escolherem” quando estiver pronto.</p>
        <div class="span2 actions"><button class="btn">Criar plano</button></div>
      </form></details>
    ${list.map((p) => html`<section class="card" id="plano-${p.key}"><form method="post" action="/planos/${p.key}" class="form-grid">
      <h2 class="span2">${p.name} <small class="muted">${p.key}${p.public ? '' : ' · interno'} · ${uses[p.key] ? `${uses[p.key]} clínica(s)` : 'nenhuma clínica'}</small></h2>
      <label class="fld"><span>Nome</span><input name="name" value="${p.name}" maxlength="60" required></label>
      <label class="fld"><span>Preço mensal (R$)</span><input name="price" value="${String(p.price).replace('.', ',')}" inputmode="decimal" required></label>
      <label class="fld"><span>Profissionais incluídos</span><input type="number" name="max_pros" min="1" max="500" value="${p.maxPros}"></label>
      <label class="fld"><span>Profissional a mais (R$/mês, 0 = não permite)</span><input name="extra" value="${String(p.extraPro).replace('.', ',')}" inputmode="decimal"></label>
      <label class="fld"><span>Frase no site</span><input name="tagline" value="${p.tagline}" maxlength="160" placeholder="Ex.: Tudo para quem atende sozinho."></label>
      <label class="fld"><span>Ordem de exibição</span><input type="number" name="position" min="0" max="99" value="${p.position ?? 0}"></label>
      <label class="fld"><span>Aparece no site para</span><select name="audience"><option value="individual" ${p.audience === 'individual' ? raw('selected') : ''}>Quem atende sozinho</option><option value="clinica" ${p.audience === 'clinica' ? raw('selected') : ''}>Clínicas</option></select></label>
      <fieldset class="fld span2"><legend>Recursos</legend><div class="wl-chips">${Object.entries(Billing.FEATURES).map(([k, l]) => html`<label class="wl-chip"><input type="checkbox" name="f_${k}" value="1" ${p.features.includes(k) ? raw('checked') : ''}><span>${l}</span></label>`)}</div></fieldset>
      <label class="check"><input type="checkbox" name="public" value="1" ${p.public ? raw('checked') : ''}> Aparece para as clínicas escolherem e no site</label>
      <label class="check"><input type="checkbox" name="highlight" value="1" ${p.highlight ? raw('checked') : ''}> Destacar no site como “Mais escolhido”</label>
      <div class="span2 actions"><button class="btn">Salvar ${p.name}</button></div></form>
      ${uses[p.key] ? html`<p class="muted small">Não dá para excluir: ${uses[p.key]} clínica(s) neste plano. Para tirar do ar, desmarque “Aparece para as clínicas escolherem”.</p>`
        : html`<form method="post" action="/planos/${p.key}/excluir" data-confirm="Excluir o plano ${p.name}? Esta ação não pode ser desfeita."><button class="btn ghost btn-sm danger-text">Excluir plano</button></form>`}</section>`)}`));
});
handle.post('/planos/site', need, async (req, res) => {
  await Billing.setSiteContact(str(req.body.contact, 120)); await log(req, 'site-contato');
  res.flash('Contato do site salvo.').redirect('/planos');
});
const numBr = (v) => Math.max(0, Number(String(v || '0').replace(/\./g, '').replace(',', '.')) || 0);
handle.post('/planos/novo', need, async (req, res) => {
  const b = req.body;
  const name = str(b.name, 60);
  const key = (str(b.key, 30) || name.normalize('NFD').replace(/[\u0300-\u036f]/g, '')).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
  if (!name || !/^[a-z0-9][a-z0-9-]{1,29}$/.test(key)) return res.flash('Informe o nome e um código válido.', 'err').redirect('/planos?novo=1');
  if (await T.pone('SELECT 1 x FROM plans WHERE plan_key = ?', [key])) return res.flash(`Já existe um plano com o código “${key}”.`, 'err').redirect('/planos?novo=1');
  const src = b.copy ? (await Billing.plans(true)).find((p) => p.key === b.copy) : null;
  const pos = Number((await T.pone('SELECT COALESCE(MAX(position), 0) m FROM plans WHERE plan_key <> \'piloto\'')).m) + 1;
  await T.pq('INSERT INTO plans (plan_key, name, price, max_pros, extra_pro_price, features, public, position, tagline, audience, highlight) VALUES (?,?,?,?,?,?,0,?,?,?,0)',
    [key, name, numBr(b.price), Math.max(1, int(b.max_pros) || 1), numBr(b.extra), JSON.stringify(src?.features || []), pos, src?.tagline || null, src?.audience || 'individual']);
  Billing.clearPlans(); await log(req, 'plano-criar', null, key);
  res.flash(`Plano ${name} criado (interno). Revise os recursos e marque “Aparece para as clínicas escolherem” quando estiver pronto.`).redirect(`/planos#plano-${key}`);
});
handle.post('/planos/:k/excluir', need, async (req, res) => {
  const k = str(req.params.k, 30);
  const p = await T.pone('SELECT plan_key, name, public FROM plans WHERE plan_key = ?', [k]);
  if (!p) return res.redirect('/planos');
  const n = Number((await T.pone('SELECT COUNT(*) n FROM tenants WHERE plan = ?', [k])).n);
  if (n) return res.flash(`Não dá para excluir: ${n} clínica(s) estão no plano ${p.name}.`, 'err').redirect('/planos');
  if (p.public && Number((await T.pone('SELECT COUNT(*) n FROM plans WHERE public = 1')).n) <= 1) return res.flash('É o único plano visível; crie ou publique outro antes de excluir este.', 'err').redirect('/planos');
  await T.pq('DELETE FROM plans WHERE plan_key = ?', [k]);
  Billing.clearPlans(); await log(req, 'plano-excluir', null, k);
  res.flash(`Plano ${p.name} excluído.`).redirect('/planos');
});
handle.post('/planos/:k', need, async (req, res) => {
  const b = req.body; const num = (v) => Math.max(0, Number(String(v || '0').replace(/\./g, '').replace(',', '.')) || 0);
  await T.pq('UPDATE plans SET name = ?, price = ?, max_pros = ?, extra_pro_price = ?, features = ?, public = ?, tagline = ?, audience = ?, highlight = ?, position = ? WHERE plan_key = ?',
    [str(b.name, 60), num(b.price), Math.max(1, int(b.max_pros) || 1), num(b.extra), JSON.stringify(Object.keys(Billing.FEATURES).filter((k) => b[`f_${k}`])), b.public ? 1 : 0,
      str(b.tagline, 160) || null, b.audience === 'clinica' ? 'clinica' : 'individual', b.highlight ? 1 : 0, Math.min(99, Math.max(0, int(b.position) || 0)), req.params.k]);
  Billing.clearPlans(); await log(req, 'plano-editar', null, req.params.k);
  res.flash('Plano salvo.').redirect('/planos');
});
// ---------- cobrança (Asaas da Mentez) ----------
handle.get('/cobranca', need, async (req, res) => {
  const c = await Billing.config();
  const host = `https://${req.get('host')}`;
  const ev = await T.pq('SELECT e.*, t.name tname FROM billing_events e LEFT JOIN tenants t ON t.id = e.tenant_id ORDER BY e.id DESC LIMIT 30');
  const counts = await T.pq("SELECT SUM(asaas_subscription IS NOT NULL) asaas, SUM(mp_preapproval IS NOT NULL) mp FROM tenants");
  const sel = (a2, b2) => (a2 === b2 ? raw('selected') : '');
  send(res, layout(req, 'Cobrança', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Cobrança das clínicas</h1><p class="muted">Quem cobra as mensalidades das clínicas. O provedor escolhido vale para as novas assinaturas e aparece no site; as assinaturas que já existem continuam no provedor em que foram feitas (Asaas: ${counts[0]?.asaas || 0} · Mercado Pago: ${counts[0]?.mp || 0}).</p></div></header>
    <form method="post" class="card form-grid">
      <label class="fld span2"><span>Provedor das novas assinaturas</span><select name="provider">${Object.entries(Billing.PROVIDERS).map(([k, p]) => html`<option value="${k}" ${sel(c.provider, k)}>${p.label} — ${p.methods.join(', ')}</option>`)}</select></label>
      <h2 class="span2">Asaas</h2>
      <label class="fld"><span>Ambiente</span><select name="env"><option value="sandbox" ${sel(c.env, 'sandbox')}>Testes (sandbox)</option><option value="producao" ${sel(c.env, 'producao')}>Produção</option></select></label>
      <label class="fld"><span>Chave de API ${c.key ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : ''}</span><input type="password" name="key" autocomplete="new-password" maxlength="300" placeholder="$aact_…"></label>
      <p class="span2 muted small">No Asaas: Integrações → Chave de API. Para testar sem cobrar ninguém, use uma conta em sandbox.asaas.com com o ambiente “Testes”.</p>
      <h2 class="span2">Mercado Pago</h2>
      <label class="fld"><span>Access Token ${c.mpToken ? html`<small class="muted">(cadastrado — preencha só para trocar)</small>` : ''}</span><input type="password" name="mp_token" autocomplete="new-password" maxlength="300" placeholder="APP_USR-… (ou TEST-… para testes)"></label>
      <label class="fld"><span>Assinatura secreta do webhook ${c.mpSecret ? html`<small class="muted">(cadastrada)</small>` : html`<small class="muted">(opcional, recomendado)</small>`}</span><input type="password" name="mp_secret" autocomplete="new-password" maxlength="200"></label>
      ${c.mpSecret ? html`<label class="check span2"><input type="checkbox" name="mp_secret_clear" value="1"> Apagar a assinatura secreta</label>` : ''}
      <p class="span2 muted small">No Mercado Pago: Suas integrações → sua aplicação → Credenciais de produção (Access Token). Em <b>Webhooks</b>, cadastre a URL abaixo e marque os eventos <b>Planos e assinaturas</b>; copie a “assinatura secreta” para o campo acima. As assinaturas do Mercado Pago são cobradas no cartão de crédito (ou saldo do Mercado Pago), todo mês, de forma automática.</p>
      <div class="span2 actions"><button class="btn">Salvar</button></div></form>
    ${c.key || c.mpToken ? html`<section class="card"><h2>Conexão e avisos automáticos</h2>
      ${c.key ? html`<p class="small"><b>Asaas</b> · webhook <code>${host}/webhooks/asaas</code> · ${c.webhookAt ? html`registrado em ${brDateTime(c.webhookAt)}` : html`<b>ainda não registrado</b>`}</p>` : ''}
      ${c.mpToken ? html`<p class="small"><b>Mercado Pago</b> · webhook <code>${host}/webhooks/mercadopago?t=${c.token}</code> (cadastre no painel do Mercado Pago)</p>` : ''}
      <div class="actions">${c.key ? html`<form method="post" action="/cobranca/testar"><input type="hidden" name="p" value="asaas"><button class="btn ghost">Testar Asaas</button></form><form method="post" action="/cobranca/webhook"><button class="btn ghost">Registrar o webhook no Asaas</button></form>` : ''}
        ${c.mpToken ? html`<form method="post" action="/cobranca/testar"><input type="hidden" name="p" value="mercadopago"><button class="btn ghost">Testar Mercado Pago</button></form>` : ''}</div></section>` : ''}
    <section class="card flush"><h2 class="pad">Últimos avisos dos provedores</h2>${ev.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Clínica</th><th>Evento</th><th>Situação</th><th>Valor</th><th>Vencimento</th></tr></thead><tbody>
      ${ev.map((e) => html`<tr><td>${brDateTime(e.created_at)}</td><td>${e.tname || '—'}</td><td>${e.event}</td><td>${e.status || ''}</td><td>${e.value ? money(e.value) : ''}</td><td>${e.due_date ? brDate(e.due_date) : ''}</td></tr>`)}</tbody></table></div>` : html`<p class="pad muted">Nenhum aviso ainda.</p>`}</section>`));
});
handle.post('/cobranca', need, async (req, res) => {
  const k = String(req.body.key || '').trim();
  if (k && (k.length < 20 || /\s/.test(k))) return res.flash('Chave de API do Asaas inválida (ela começa com $aact_).', 'err').redirect('/cobranca');
  const m = String(req.body.mp_token || '').trim();
  if (m && !/^(APP_USR|TEST)-[\w-]{20,}$/.test(m)) return res.flash('Access Token do Mercado Pago inválido (começa com APP_USR- ou TEST-).', 'err').redirect('/cobranca');
  const c = await Billing.saveConfig(req.body); await log(req, 'cobranca-config', null, `${c.provider} · ${req.body.env}`);
  res.flash(Billing.ready(c) ? `Configuração salva. Novas assinaturas: ${Billing.PROVIDERS[c.provider].label}.` : `Salvo, mas falta a credencial de ${Billing.PROVIDERS[c.provider].label} para as clínicas conseguirem assinar.`, Billing.ready(c) ? 'ok' : 'warn').redirect('/cobranca');
});
handle.post('/cobranca/testar', need, async (req, res) => {
  const p = req.body.p === 'mercadopago' ? 'mercadopago' : 'asaas';
  try { res.flash(`Conexão com o ${Billing.PROVIDERS[p].label} funcionando: ${await Billing.testConnection(await Billing.config(), p)}.`); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect('/cobranca');
});
handle.post('/cobranca/webhook', need, async (req, res) => {
  try { await Billing.registerWebhook(await Billing.config(), `https://${req.get('host')}/webhooks/asaas`, req.admin.email); await log(req, 'cobranca-webhook'); res.flash('Webhook registrado no Asaas.'); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect('/cobranca');
});
// ---------- assistente de ajuda (chat dentro do sistema das clínicas) ----------
handle.get('/assistente', need, async (req, res) => {
  const c = await HelpBot.config(); const u = await HelpBot.usage(30);
  const [m1, m2] = await Promise.all([AISlot.modelsSafe(c.p1), AISlot.modelsSafe(c.p2)]);
  send(res, layout(req, 'Assistente de ajuda', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Assistente de ajuda</h1>
      <p class="muted">Chat que aparece no canto de todas as telas do sistema das clínicas para tirar dúvidas e ensinar a usar a Mentez (como o assistente da Hostinger). Usa a IA da Mentez — as clínicas não pagam nada. Não recebe dados de pacientes.</p></div>
      <div class="ph-actions">${HelpBot.ready(c) ? html`<span class="badge b-realizada">Ligado</span>` : html`<span class="badge b-cancelada">Desligado</span>`}</div></header>
    <section class="kpis small"><div class="kpi"><span>Perguntas (30 dias)</span><b>${u.n}</b></div><div class="kpi"><span>Clínicas que usaram</span><b>${u.clinics}</b></div><div class="kpi"><span>Tokens (entrada/saída)</span><b>${Number(u.tin).toLocaleString('pt-BR')} / ${Number(u.tout).toLocaleString('pt-BR')}</b></div><div class="kpi"><span>Falhas</span><b>${u.fails || 0}</b></div></section>
    <form method="post" class="card stack">
      <label class="check"><input type="checkbox" name="enabled" value="1" ${c.enabled ? raw('checked') : ''}> <b>Mostrar o assistente nas clínicas</b></label>
      ${AISlot.fields('p1', c.p1, { title: 'Provedor de IA principal', hint: 'Recomendado: um modelo rápido e barato (ex.: Claude Haiku, GPT-4o mini, Gemini Flash). Cada resposta custa frações de centavo.', models: m1.list, error: m1.err })}
      ${AISlot.fields('p2', c.p2, { title: 'Provedor de reserva', hint: 'Entra sozinho se o principal falhar.', toggle: true, models: m2.list, error: m2.err })}
      <label class="fld"><span>Informações adicionais para o assistente <small class="muted">(novidades, horário do suporte, avisos — o manual do sistema já vem embutido)</small></span><textarea name="extra" rows="5" maxlength="4000">${c.extra}</textarea></label>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>`));
});
handle.post('/assistente', need, async (req, res) => {
  const r = await HelpBot.saveConfig(req.body, await HelpBot.config());
  if (r.error) return res.flash(r.error, 'err').redirect('/assistente');
  await log(req, 'assistente-config', null, req.body.enabled ? 'ligado' : 'desligado');
  res.flash('Assistente de ajuda salvo.').redirect('/assistente');
});
// ---------- equipe (usuários do painel) ----------
const inviteHash = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');
async function newInvite(id, by) {
  const code = crypto.randomBytes(24).toString('base64url');
  await T.pq('UPDATE platform_users SET invite_hash = ?, invite_expires = DATE_ADD(NOW(), INTERVAL 7 DAY), invited_by = ? WHERE id = ?', [inviteHash(code), by, id]);
  return code;
}
const inviteUrl = (req, code) => `https://${req.get('host')}/convite-equipe/${code}`;
const adminsLeft = async (exceptId) => Number((await T.pone("SELECT COUNT(*) n FROM platform_users WHERE role = 'admin' AND active = 1 AND id <> ?", [exceptId])).n);
handle.get('/equipe', need, async (req, res) => {
  const list = await T.pq('SELECT id, name, email, phone, role, active, last_login_at, created_at, invite_expires, password_hash FROM platform_users ORDER BY active DESC, name');
  const link = str(req.query.link, 300);
  const pending = (u) => !String(u.password_hash || '').startsWith('$2');
  send(res, layout(req, 'Equipe e usuários', html`<div class="mz2-hello"><div><h1>Equipe e usuários</h1><p>Quem acessa o Painel da Mentez e o que cada pessoa pode fazer. Os usuários das clínicas são cadastrados por cada clínica, no sistema dela.</p></div></div>
    ${link ? html`<section class="mz2-card mz2-invite"><header><span class="mz2-cardic">${ICON.equipe}</span><h2>Link de acesso</h2></header>
      <p>Envie este link à pessoa por um canal privado (WhatsApp ou e-mail). Ela cria a própria senha. O link vale 7 dias e funciona uma vez só; não fica guardado aqui.</p>
      <div class="copy"><input readonly value="${link}" id="invlink"><button class="btn" type="button" data-copy="#invlink">Copiar</button></div></section>` : ''}
    <section class="mz2-card mz2-table"><header><span class="mz2-cardic">${ICON.equipe}</span><h2>Usuários do painel</h2><span class="mz2-pill sm">${list.filter((u) => u.active).length} ativo(s)</span></header>
      <div class="mz2-tw"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Último acesso</th><th>Situação</th><th>Ações</th></tr></thead><tbody>
      ${list.map((u) => { const me = u.id === req.admin.id; return html`<tr><td><span class="mz2-av">${initialsOf(u.name)}</span>${u.name}${me ? html` <small class="muted">(você)</small>` : ''}</td><td class="mz2-mono">${u.email}</td>
        <td>${me ? (ROLES[u.role]?.label || u.role) : html`<form method="post" action="/equipe/${u.id}/papel" class="inline"><select name="role" data-autosubmit aria-label="Papel de ${u.name}">${Object.entries(ROLES).map(([k, r]) => html`<option value="${k}" ${k === u.role ? raw('selected') : ''}>${r.label}</option>`)}</select><noscript><button class="chip">Salvar</button></noscript></form>`}</td>
        <td>${u.last_login_at ? brDateTime(u.last_login_at) : '—'}</td>
        <td>${!u.active ? html`<span class="mz2-chip err">Desativado</span>` : pending(u) ? html`<span class="mz2-chip warn">Convite enviado${u.invite_expires ? ` · até ${brDate(u.invite_expires)}` : ''}</span>` : html`<span class="mz2-chip ok">Ativo</span>`}</td>
        <td class="mz2-actions">${me ? html`<a class="mz2-link" href="/minha-conta">Minha conta</a>` : html`
          <form method="post" action="/equipe/${u.id}/convite"><button class="chip" data-confirm="${pending(u) ? 'Gerar um novo link de acesso? O anterior deixa de valer.' : `Gerar um link para ${u.name} criar uma nova senha? A senha atual continua valendo até o link ser usado.`}">${pending(u) ? 'Novo link' : 'Redefinir senha'}</button></form>
          <form method="post" action="/equipe/${u.id}/situacao"><button class="chip" data-confirm="${u.active ? `Desativar ${u.name}? A pessoa sai do painel na hora.` : `Reativar ${u.name}?`}">${u.active ? 'Desativar' : 'Reativar'}</button></form>`}</td></tr>`; })}
      </tbody></table></div></section>
    <div class="mz2-grid2">
      <section class="mz2-card"><header><span class="mz2-cardic">${ICON.nova}</span><h2>Adicionar usuário</h2></header>
        <form method="post" action="/equipe" class="stack">
          <label class="fld"><span>Nome</span><input name="name" required maxlength="120" autocomplete="off"></label>
          <label class="fld"><span>E-mail</span><input type="email" name="email" required maxlength="190" autocomplete="off"></label>
          <label class="fld"><span>WhatsApp (opcional)</span><input name="phone" maxlength="40" inputmode="tel" autocomplete="off"></label>
          <label class="fld"><span>Papel</span><select name="role">${Object.entries(ROLES).map(([k, r]) => html`<option value="${k}" ${k === 'suporte' ? raw('selected') : ''}>${r.label}</option>`)}</select></label>
          <button class="btn">Adicionar e gerar link de acesso</button></form></section>
      <section class="mz2-card"><header><span class="mz2-cardic">${ICON.ajuda}</span><h2>Papéis</h2></header>
        <ul class="mz2-roles">${Object.values(ROLES).map((r) => html`<li><b>${r.label}</b><span>${r.desc}</span></li>`)}</ul>
        <p class="muted small">Toda ação fica no Histórico com o nome de quem fez. Desativar tira a pessoa do painel na hora, em todos os aparelhos.</p></section>
    </div>`));
});
handle.post('/equipe', need, async (req, res) => {
  const name = str(req.body.name, 120).trim(); const email = str(req.body.email, 190).trim().toLowerCase(); const role = ROLES[req.body.role] ? req.body.role : 'suporte';
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.flash('Informe nome e e-mail válidos.', 'err').redirect('/equipe');
  if (await T.pone('SELECT id FROM platform_users WHERE email = ?', [email])) return res.flash('Já existe um usuário com este e-mail.', 'err').redirect('/equipe');
  const r = await T.pq("INSERT INTO platform_users (name, email, phone, password_hash, role, active) VALUES (?,?,?,'',?,1)", [name, email, str(req.body.phone, 40) || null, role]);
  const code = await newInvite(r.insertId, req.admin.email);
  await log(req, 'equipe-adicionar', null, `${email} · ${role}`);
  res.flash(`${name} adicionado(a) como ${ROLES[role].label}.`).redirect(`/equipe?link=${encodeURIComponent(inviteUrl(req, code))}`);
});
async function teamTarget(req) { const u = await T.pone('SELECT * FROM platform_users WHERE id = ?', [int(req.params.id)]); return u && u.id !== req.admin.id ? u : null; }
handle.post('/equipe/:id/papel', need, async (req, res) => {
  const u = await teamTarget(req); const role = req.body.role;
  if (!u || !ROLES[role]) return res.redirect('/equipe');
  if (u.role === 'admin' && role !== 'admin' && u.active && !(await adminsLeft(u.id))) return res.flash('É preciso manter pelo menos um administrador ativo.', 'err').redirect('/equipe');
  await T.pq('UPDATE platform_users SET role = ? WHERE id = ?', [role, u.id]);
  await log(req, 'equipe-papel', null, `${u.email} → ${role}`);
  res.flash(`${u.name} agora é ${ROLES[role].label}.`).redirect('/equipe');
});
handle.post('/equipe/:id/situacao', need, async (req, res) => {
  const u = await teamTarget(req); if (!u) return res.redirect('/equipe');
  if (u.active && u.role === 'admin' && !(await adminsLeft(u.id))) return res.flash('É preciso manter pelo menos um administrador ativo.', 'err').redirect('/equipe');
  await T.pq('UPDATE platform_users SET active = ?, session_version = session_version + 1, invite_hash = IF(? = 0, NULL, invite_hash) WHERE id = ?', [u.active ? 0 : 1, u.active ? 0 : 1, u.id]);
  await log(req, u.active ? 'equipe-desativar' : 'equipe-reativar', null, u.email);
  res.flash(u.active ? `${u.name} foi desativado(a) e saiu do painel.` : `${u.name} foi reativado(a).`).redirect('/equipe');
});
handle.post('/equipe/:id/convite', need, async (req, res) => {
  const u = await teamTarget(req); if (!u || !u.active) return res.redirect('/equipe');
  const code = await newInvite(u.id, req.admin.email);
  await log(req, 'equipe-link', null, u.email);
  res.redirect(`/equipe?link=${encodeURIComponent(inviteUrl(req, code))}`);
});
// link de acesso (público): a pessoa cria a própria senha
async function byInvite(code) { return T.pone('SELECT * FROM platform_users WHERE invite_hash = ? AND invite_expires > NOW() AND active = 1', [inviteHash(code)]); }
handle.get('/convite-equipe/:code', async (req, res) => {
  const u = await byInvite(req.params.code);
  if (!u) return send(res, layout(req, 'Link inválido', html`<section class="card mzp-auth"><h1>Link inválido ou vencido</h1><p>Peça um novo link a um administrador da Mentez.</p></section>`));
  send(res, layout(req, 'Criar senha', html`<section class="card mzp-auth"><h1>Olá, ${u.name.split(' ')[0]}!</h1><p class="muted small">Crie sua senha para entrar no Painel da Mentez com o e-mail <b>${u.email}</b>.</p>
    <form method="post" class="stack"><label class="fld"><span>Nova senha (mínimo 12 caracteres)</span><input type="password" name="password" minlength="12" required autocomplete="new-password"></label>
      <label class="fld"><span>Repita a senha</span><input type="password" name="password2" minlength="12" required autocomplete="new-password"></label><button class="btn">Criar senha e entrar</button></form></section>`));
});
handle.post('/convite-equipe/:code', RL.limit({ name: 'painel-convite', windowMs: 10 * 60e3, max: 10 }), async (req, res) => {
  const u = await byInvite(req.params.code); const back = `/convite-equipe/${encodeURIComponent(req.params.code)}`;
  if (!u) return res.redirect(back);
  const pw = String(req.body.password || '');
  if (pw.length < 12) return res.flash('A senha precisa ter pelo menos 12 caracteres.', 'err').redirect(back);
  if (pw !== String(req.body.password2 || '')) return res.flash('As senhas não conferem.', 'err').redirect(back);
  await T.pq('UPDATE platform_users SET password_hash = ?, invite_hash = NULL, invite_expires = NULL, session_version = session_version + 1, last_login_at = NOW() WHERE id = ?', [await bcrypt.hash(pw, 12), u.id]);
  const fresh = await T.pone('SELECT * FROM platform_users WHERE id = ?', [u.id]);
  setCookie(res, sign({ uid: u.id, sv: fresh.session_version, exp: Date.now() + HOURS * 3600e3 }), HOURS * 3600);
  req.admin = fresh; await log(req, 'equipe-senha-criada', null, u.email);
  res.flash('Senha criada. Bem-vindo(a) ao Painel da Mentez!').redirect('/');
});
// minha conta
handle.get('/minha-conta', need, (req, res) => {
  const u = req.admin;
  send(res, layout(req, 'Minha conta', html`<div class="mz2-hello"><div><h1>Minha conta</h1><p>${u.email} · ${ROLES[u.role]?.label || u.role}</p></div></div>
    <div class="mz2-grid2">
      <section class="mz2-card"><header><span class="mz2-cardic">${ICON.equipe}</span><h2>Dados</h2></header>
        <form method="post" action="/minha-conta" class="stack"><label class="fld"><span>Nome</span><input name="name" required maxlength="120" value="${u.name}"></label>
          <label class="fld"><span>WhatsApp</span><input name="phone" maxlength="40" inputmode="tel" value="${u.phone || ''}"></label><button class="btn">Salvar</button></form></section>
      <section class="mz2-card"><header><span class="mz2-cardic">${ICON.ajuda}</span><h2>Senha</h2></header>
        <form method="post" action="/minha-conta/senha" class="stack"><label class="fld"><span>Senha atual</span><input type="password" name="current" required autocomplete="current-password"></label>
          <label class="fld"><span>Nova senha (mínimo 12 caracteres)</span><input type="password" name="password" minlength="12" required autocomplete="new-password"></label>
          <label class="fld"><span>Repita a nova senha</span><input type="password" name="password2" minlength="12" required autocomplete="new-password"></label><button class="btn">Trocar senha</button></form>
        <form method="post" action="/minha-conta/sair-todos"><button class="btn ghost" data-confirm="Sair do painel em todos os aparelhos, inclusive este?">Sair de todos os aparelhos</button></form></section>
    </div>`));
});
handle.post('/minha-conta', need, async (req, res) => {
  const name = str(req.body.name, 120).trim(); if (!name) return res.redirect('/minha-conta');
  await T.pq('UPDATE platform_users SET name = ?, phone = ? WHERE id = ?', [name, str(req.body.phone, 40) || null, req.admin.id]);
  res.flash('Dados salvos.').redirect('/minha-conta');
});
handle.post('/minha-conta/senha', need, RL.limit({ name: 'painel-senha', windowMs: 15 * 60e3, max: 10 }), async (req, res) => {
  const u = await T.pone('SELECT * FROM platform_users WHERE id = ?', [req.admin.id]);
  if (!(await bcrypt.compare(String(req.body.current || ''), u.password_hash || ''))) return res.flash('Senha atual incorreta.', 'err').redirect('/minha-conta');
  const pw = String(req.body.password || '');
  if (pw.length < 12) return res.flash('A nova senha precisa ter pelo menos 12 caracteres.', 'err').redirect('/minha-conta');
  if (pw !== String(req.body.password2 || '')) return res.flash('As senhas não conferem.', 'err').redirect('/minha-conta');
  await T.pq('UPDATE platform_users SET password_hash = ?, session_version = session_version + 1 WHERE id = ?', [await bcrypt.hash(pw, 12), u.id]);
  setCookie(res, sign({ uid: u.id, sv: u.session_version + 1, exp: Date.now() + HOURS * 3600e3 }), HOURS * 3600); // continua logado aqui; outros aparelhos saem
  await log(req, 'equipe-senha-trocada', null, u.email);
  res.flash('Senha trocada. Os outros aparelhos saíram do painel.').redirect('/minha-conta');
});
handle.post('/minha-conta/sair-todos', need, async (req, res) => {
  await T.pq('UPDATE platform_users SET session_version = session_version + 1 WHERE id = ?', [req.admin.id]);
  setCookie(res, '', 0); res.redirect('/entrar');
});

handle.get('/historico', need, async (req, res) => {
  const rows = await T.pq('SELECT a.*, t.name tname FROM platform_audit a LEFT JOIN tenants t ON t.id = a.tenant_id ORDER BY a.id DESC LIMIT 200');
  send(res, layout(req, 'Histórico', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Histórico</h1></div></header>
    <section class="card flush"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Quem</th><th>Ação</th><th>Clínica</th><th>Detalhe</th></tr></thead><tbody>
    ${rows.map((r) => html`<tr><td>${brDateTime(r.created_at)}</td><td>${r.actor || '—'}</td><td>${r.action}</td><td>${r.tname || '—'}</td><td class="small">${r.detail || ''}</td></tr>`)}</tbody></table></div></section>`));
});
handle.use((req, res) => res.status(404).send(String(layout(req, 'Não encontrado', html`<div class="center-card"><h1>Página não encontrada</h1><p><a href="/">Voltar</a></p></div>`))));
