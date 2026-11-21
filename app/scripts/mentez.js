#!/usr/bin/env node
// Utilitário da plataforma Mentez (rodar dentro do contêiner do app):
//   node scripts/mentez.js clinicas
//   node scripts/mentez.js criar <endereco> "<Nome da clínica>" [--email dono@x.com] [--nome "Dono"]
//   node scripts/mentez.js convite <endereco>                       → link de primeiro acesso (a pessoa cria a própria senha)
//   node scripts/mentez.js admin <endereco> "<Nome>" <email>        → cria o primeiro acesso (admin) e mostra a senha provisória
//   node scripts/mentez.js dominio <endereco> <dominio> [--principal] → domínio próprio (ex.: app.clinica.com.br)
//   node scripts/mentez.js situacao <endereco> ativa|suspensa|cancelada
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as T from '../lib/tenancy.js';
import * as Evolution from '../lib/evolution.js';
import * as Mig from '../lib/migration.js';
import { migrate, q, one } from '../lib/db.js';

const [cmd, ...rest] = process.argv.slice(2);
const VALUED = new Set(['--email', '--nome', '--dominio']);
const flag = (n) => { const i = rest.indexOf(`--${n}`); return i < 0 ? null : VALUED.has(`--${n}`) ? rest[i + 1] || null : true; };
const args = rest.filter((x, i) => !x.startsWith('--') && !VALUED.has(rest[i - 1]));
const die = (m) => { console.error(m); process.exit(1); };

if (!T.multi()) die('Defina MENTEZ_PLATFORM_DB (modo plataforma).');
await T.migratePlatform();
try {
  if (cmd === 'clinicas') {
    for (const t of await T.all()) console.log(`${t.id}\t${t.slug}\t${t.status}\t${t.env.PUBLIC_URL}\t${t.name}`);
  } else if (cmd === 'criar') {
    const [slug, name] = args; if (!slug || !name) die('Uso: criar <endereco> "<Nome>"');
    const t = await T.createTenant({ slug, name, ownerEmail: flag('email') || null, ownerName: flag('nome') || null });
    await T.run(t, () => migrate());
    console.log(`Clínica criada: ${t.name} → ${t.env.PUBLIC_URL} (banco ${t.db_name})`);
    if (Evolution.enabled()) { const r = await T.run(t, () => Evolution.provision(t)).catch((e) => ({ ok: false, reason: e.message })); console.log(r.ok ? `WhatsApp: instância ${r.instance}` : `WhatsApp: ${r.reason}`); }
  } else if (cmd === 'importar') {
    // Traz uma clínica de um sistema próprio (ex.: importar lorrainy https://sistema.lorrainymendes.com.br --dominio=sistema.lorrainymendes.com.br --legado)
    const [slug, src] = args; if (!slug || !/^https?:\/\//.test(src || '')) die('Uso: importar <endereco> <https://origem> [--dominio=...] [--legado] [--sem-concluir]');
    let t = await T.bySlug(slug);
    if (!t) { t = await T.createTenant({ slug, name: flag('nome') || slug, plan: 'piloto', actor: 'cli:importar' }); console.log(`Clínica criada na Mentez: ${slug} (o banco definitivo vem da importação)`); }
    const file = `/tmp/mz-import-${slug}.bin`;
    const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 12);
    const dbName = `mz_${slug.replace(/-/g, '_')}_${stamp}`.slice(0, 64);
    try {
      console.log(`Origem: ${JSON.stringify(await Mig.state(src))}`);
      console.log('Exportando (o sistema de origem fica em “atualização” até o fim)…');
      const n = await Mig.download(src, file); console.log(`Pacote: ${(n / 1048576).toFixed(1)} MB`);
      const filesRoot = (await import('node:path')).join(process.env.MENTEZ_FILES_DIR || '/data/files', slug, 'private');
      const r = await Mig.importInto(file, dbName, console.log, filesRoot);
      console.log(`Banco ${dbName}: ${Object.entries(r.counts).length} tabelas, ${Object.values(r.counts).reduce((a, b) => a + b, 0)} linhas (conferido)`);
      if (flag('ensaio')) {
        // ensaio: confere que tudo entra no MySQL da Mentez, apaga o banco de teste e devolve a origem ao normal
        const c2 = await (await import('mysql2/promise')).default.createConnection(T.connConfigFor(undefined));
        await c2.query(`DROP DATABASE \`${dbName}\``); await c2.end();
        await Mig.cancel(src);
        throw Object.assign(new Error('ensaio'), { ensaio: true });
      }
      const env = {}; if (r.meta.env.SETUP_TOKEN) env.SETUP_TOKEN = r.meta.env.SETUP_TOKEN; if (flag('legado')) env.MENTEZ_BRAND = 'legacy';
      await T.setCoreSecrets(t.id, { SESSION_SECRET: r.meta.env.SESSION_SECRET, ENCRYPTION_KEY: r.meta.env.ENCRYPTION_KEY, env });
      await T.pq("UPDATE tenants SET db_name = ?, plan = 'piloto', billing_status = 'cortesia', status = 'ativa' WHERE id = ?", [dbName, t.id]);
      T.clearCache();
      const t2 = await T.bySlug(slug);
      await T.run(t2, () => migrate());
      const dom = flag('dominio');
      if (dom) {
        await T.pq('UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?', [t.id]);
        await T.pq('INSERT INTO tenant_domains (domain, tenant_id, is_primary, verified_at) VALUES (?,?,1,NOW()) ON DUPLICATE KEY UPDATE tenant_id = VALUES(tenant_id), is_primary = 1, verified_at = COALESCE(verified_at, NOW())', [dom, t.id]);
      }
      await T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', ['cli', 'clinica-importar', t.id, `${src} → ${dbName}`]);
      const check = await T.run(t2, async () => (await one('SELECT (SELECT COUNT(*) FROM users) u, (SELECT COUNT(*) FROM patients) p, (SELECT COUNT(*) FROM appointments) a')));
      console.log(`Na Mentez: ${check.u} usuários, ${check.p} pacientes, ${check.a} agendamentos`);
      if (!flag('sem-concluir')) { const f = await Mig.finish(src, process.env.MENTEZ_IMPORT_TARGET || `https://${slug}.${T.baseDomain()}`); console.log(`Origem agora encaminha para a Mentez: ${JSON.stringify(f)}`); }
      console.log(`IMPORTAR: ok ${dbName}`);
    } catch (e) {
      if (e.ensaio) console.log('ENSAIO: ok — banco de teste apagado e origem de volta ao normal');
      else {
        console.error(`IMPORTAR: erro ${e.message}`);
        try { await Mig.cancel(src); console.error('Origem voltou ao normal (cancelado).'); } catch (e2) { console.error(`Não foi possível cancelar na origem: ${e2.message}`); }
        process.exitCode = 1;
      }
    } finally { try { (await import('node:fs')).unlinkSync(file); } catch { /* sem arquivo */ } }
  } else if (cmd === 'migracao') {
    // migracao <estado|cancelar|concluir> <https://origem> [<endereco>]
    const [acao, src, slug] = args;
    if (acao === 'estado') console.log(JSON.stringify(await Mig.state(src)));
    else if (acao === 'cancelar') console.log(JSON.stringify(await Mig.cancel(src)));
    else if (acao === 'concluir') console.log(JSON.stringify(await Mig.finish(src, `https://${slug}.${T.baseDomain()}`)));
    else die('Uso: migracao <estado|cancelar|concluir> <https://origem> [<endereco>]');
  } else if (cmd === 'whatsapp') {
    // Cria a instância do WhatsApp na Evolution da Mentez para clínicas que ainda não têm (ou só para uma)
    const list = args[0] ? [await T.bySlug(args[0])].filter(Boolean) : await T.active();
    for (const t of list) { const r = await T.run(t, () => Evolution.provision(t, { force: !!flag('forcar') })).catch((e) => ({ ok: false, reason: e.message })); console.log(`${t.slug}\t${r.ok ? `${r.instance}${r.created ? ' (criada)' : ''}` : r.reason}`); }
  } else if (cmd === 'admin') {
    const [slug, name, email] = args; if (!slug || !name || !email) die('Uso: admin <endereco> "<Nome>" <email>');
    const t = await T.bySlug(slug); if (!t) die('Clínica não encontrada.');
    await T.run(t, async () => {
      if (await one('SELECT id FROM users WHERE email = ?', [email])) die('Já existe um usuário com este e-mail nesta clínica.');
      const pass = `${crypto.randomBytes(9).toString('base64url')}#9a`;
      await q("INSERT INTO users (name, email, password_hash, role, must_change_password, is_master) VALUES (?,?,?,'admin',1,1)", [name, email, bcrypt.hashSync(pass, 10)]);
      console.log(`Acesso criado em ${t.env.PUBLIC_URL}\n  e-mail: ${email}\n  senha provisória: ${pass}\n  (trocar no primeiro acesso)`);
    });
  } else if (cmd === 'convite') {
    // Link de primeiro acesso: a própria pessoa cria e-mail e senha. Vale até ser usado (a tela fecha depois do 1º acesso).
    const [slug] = args; const t = await T.bySlug(slug); if (!t) die('Clínica não encontrada.');
    const has = await T.run(t, () => one('SELECT id FROM users LIMIT 1'));
    if (has) die('Esta clínica já tem acesso criado. Use "admin" para criar outro usuário.');
    const code = crypto.randomBytes(18).toString('base64url');
    await T.setSecretEnv(t.id, 'SETUP_TOKEN', code);
    console.log(`Convite de primeiro acesso: ${t.env.PUBLIC_URL}/setup?codigo=${code}`);
  } else if (cmd === 'painel-convite') {
    // Convite de primeiro acesso ao Painel da Mentez (app.mentez.com.br) — só funciona enquanto o painel não tem nenhum usuário
    await T.pq('CREATE TABLE IF NOT EXISTS platform_users (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(190) NOT NULL UNIQUE, password_hash VARCHAR(100) NOT NULL, session_version INT NOT NULL DEFAULT 1, last_login_at DATETIME NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    await T.pq('CREATE TABLE IF NOT EXISTS platform_settings (k VARCHAR(60) PRIMARY KEY, v TEXT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4');
    if (await T.pone('SELECT id FROM platform_users LIMIT 1')) die('O painel já tem usuário. Entre em /entrar.');
    const code = crypto.randomBytes(18).toString('base64url');
    await T.pq("INSERT INTO platform_settings (k, v) VALUES ('convite_painel', ?) ON DUPLICATE KEY UPDATE v = VALUES(v)", [code]);
    const host = [...T.platformHosts()].find((h) => h.startsWith('app.')) || `app.${T.baseDomain()}`;
    console.log(`Convite do painel: https://${host}/primeiro-acesso?codigo=${code}`);
  } else if (cmd === 'dominio') {
    const [slug, domain] = args; const t = await T.bySlug(slug); if (!t) die('Clínica não encontrada.');
    const d = await T.addDomain(t.id, domain, { primary: !!flag('principal'), verified: !!flag('principal') });
    console.log(`Domínio ${d} ligado a ${t.name}. Crie no DNS do domínio um registro A (ou CNAME) apontando para o servidor da Mentez.`);
  } else if (cmd === 'situacao') {
    const [slug, st] = args; if (!['ativa', 'suspensa', 'cancelada'].includes(st)) die('Situação: ativa, suspensa ou cancelada.');
    await T.pq('UPDATE tenants SET status = ? WHERE slug = ?', [st, slug]); T.clearCache(); console.log('ok');
  } else die('Comandos: clinicas | criar | convite | painel-convite | admin | dominio | situacao');
} finally { process.exit(0); }
