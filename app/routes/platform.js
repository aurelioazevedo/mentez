// Painel da Mentez (app.mentez.com.br): só para a equipe da Mentez. Login próprio, separado do login das clínicas.
// Clínicas: criar, convite de primeiro acesso, suspender/reativar, domínios próprios, uso e histórico.
// Dados clínicos dos pacientes NÃO aparecem aqui — só contagens de uso.
import crypto from 'node:crypto';
import express from 'express';
import bcrypt from 'bcryptjs';
import * as T from '../lib/tenancy.js';
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

// ---------- layout ----------
const MARK = raw('<svg viewBox="0 0 128 128" width="34" height="34" aria-hidden="true"><rect width="128" height="128" rx="32" fill="#071936"/><defs><linearGradient id="mzg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#07C6BC"/><stop offset="1" stop-color="#8065E8"/></linearGradient></defs><g transform="translate(0 -2)"><path d="M30 92 V58 a17 17 0 0 1 34 0 V92" fill="none" stroke="#F5F7FC" stroke-width="13" stroke-linecap="round"/><path d="M64 58 a17 17 0 0 1 34 0 V92" fill="none" stroke="url(#mzg)" stroke-width="13" stroke-linecap="round"/></g></svg>');
function layout(req, title, body) {
  return bare(title, html`<div class="mzp">
    <header class="mzp-top"><a class="mzp-brand" href="/">${MARK}<span><b>mentez</b><small>${req.admin ? 'Painel' : 'Gestão para psicologia'}</small></span></a>
      ${req.admin ? html`<nav class="mzp-nav"><a href="/">Clínicas</a><a href="/clinicas/nova">Nova clínica</a><a href="/planos">Planos</a><a href="/cobranca">Cobrança</a><a href="/historico">Histórico</a></nav>
        <form method="post" action="/sair" class="mzp-out"><span class="muted small">${req.admin.name}</span><button class="btn ghost btn-sm">Sair</button></form>` : ''}</header>
    <main class="mzp-main">${req.flash ? html`<div class="flash ${req.flash.type || 'ok'}">${req.flash.text}</div>` : ''}${body}</main>
    <footer class="mzp-foot muted small">Mentez · Inteligência para cuidar de quem cuida · <a href="/termos-de-uso">Termos de Uso</a> · <a href="/privacidade">Privacidade</a></footer>
  </div>`, 'bare mzp-body', req, { suffix: 'Painel Mentez' });
}
const need = (req, res, next) => (req.admin ? next() : res.redirect('/inicio'));
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
handle.get('/', need, async (req, res) => {
  const list = await T.all();
  const use = await Promise.all(list.map(usage));
  send(res, layout(req, 'Clínicas', html`<header class="ph"><div><p class="eyebrow">Painel</p><h1>Clínicas</h1><p class="muted">${list.length} clínica(s) · ${list.filter((t) => t.status === 'ativa').length} ativa(s)</p></div>
      <div class="ph-actions"><a class="btn" href="/clinicas/nova">+ Nova clínica</a></div></header>
    <section class="card flush">${list.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Clínica</th><th>Endereço</th><th>Situação</th><th>Usuários</th><th>Pacientes ativos</th><th>Sessões (30 dias)</th><th>Último acesso</th></tr></thead><tbody>
      ${list.map((t, i) => html`<tr data-href="/clinicas/${t.id}"><td><a href="/clinicas/${t.id}"><b>${t.name}</b></a><small class="muted block">${t.plan}</small></td><td><a href="${t.env.PUBLIC_URL}" target="_blank" rel="noopener">${t.env.PUBLIC_URL.replace('https://', '')}</a></td>
        <td><span class="badge b-${STATUS[t.status][0]}">${STATUS[t.status][1]}</span></td><td>${use[i]?.users ?? '—'}</td><td>${use[i]?.patients ?? '—'}</td><td>${use[i]?.sessions30 ?? '—'}</td><td>${use[i]?.lastLogin ? brDateTime(use[i].lastLogin) : '—'}</td></tr>`)}
    </tbody></table></div>` : html`<p class="pad muted">Nenhuma clínica ainda.</p>`}</section>`));
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
      <div class="ph-actions"><a class="btn ghost" href="/">Voltar</a></div></header>
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
      <p class="muted small">O endereço <b>${t.slug}.${T.baseDomain()}</b> sempre funciona. Para usar um domínio da clínica (ex.: app.clinica.com.br), a clínica cria no DNS dela um registro <b>A</b> apontando para o servidor da Mentez (ou <b>CNAME</b> para ${t.slug}.${T.baseDomain()}) e você cadastra aqui. O HTTPS é emitido na primeira visita.</p>
      ${domains.length ? html`<ul class="list">${domains.map((d) => html`<li><div class="maint-bk"><span><b>${d.domain}</b> ${d.is_primary ? html`<span class="badge b-realizada">principal</span>` : ''}<small>cadastrado em ${brDate(d.created_at)}</small></span>
        <span class="actions">${!d.is_primary ? html`<form method="post" action="/clinicas/${t.id}/dominio/principal"><input type="hidden" name="domain" value="${d.domain}"><button class="chip" data-confirm="Usar ${d.domain} como endereço principal? Links enviados aos pacientes passam a usar este domínio — confirme antes que o DNS já aponta para a Mentez.">Tornar principal</button></form>` : html`<form method="post" action="/clinicas/${t.id}/dominio/principal"><input type="hidden" name="domain" value=""><button class="chip">Voltar ao endereço da Mentez</button></form>`}
          <form method="post" action="/clinicas/${t.id}/dominio/remover"><input type="hidden" name="domain" value="${d.domain}"><button class="chip" data-confirm="Remover ${d.domain}?">Remover</button></form></span></div></li>`)}</ul>` : ''}
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
  try { const d = await T.addDomain(t.id, req.body.domain); await log(req, 'dominio-adicionar', t.id, d); res.flash(`Domínio ${d} cadastrado.`); } catch (e) { res.flash(e.message, 'err'); }
  res.redirect(`/clinicas/${t.id}`);
});
handle.post('/clinicas/:id/dominio/principal', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  await T.pq('UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?', [t.id]);
  if (req.body.domain) await T.pq('UPDATE tenant_domains SET is_primary = 1, verified_at = COALESCE(verified_at, NOW()) WHERE tenant_id = ? AND domain = ?', [t.id, str(req.body.domain, 190)]);
  T.clearCache(); await log(req, 'dominio-principal', t.id, req.body.domain || `${t.slug}.${T.baseDomain()}`);
  res.flash('Endereço principal atualizado.').redirect(`/clinicas/${t.id}`);
});
handle.post('/clinicas/:id/dominio/remover', need, async (req, res, next) => {
  const t = await tenantOf(req); if (!t) return next();
  await T.pq('DELETE FROM tenant_domains WHERE tenant_id = ? AND domain = ?', [t.id, str(req.body.domain, 190)]); T.clearCache();
  await log(req, 'dominio-remover', t.id, req.body.domain);
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
