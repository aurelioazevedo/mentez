#!/usr/bin/env node
// Utilitário da plataforma Mentez (rodar dentro do contêiner do app):
//   node scripts/mentez.js clinicas
//   node scripts/mentez.js criar <endereco> "<Nome da clínica>" [--email dono@x.com] [--nome "Dono"]
//   node scripts/mentez.js admin <endereco> "<Nome>" <email>        → cria o primeiro acesso (admin) e mostra a senha provisória
//   node scripts/mentez.js dominio <endereco> <dominio> [--principal] → domínio próprio (ex.: app.clinica.com.br)
//   node scripts/mentez.js situacao <endereco> ativa|suspensa|cancelada
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import * as T from '../lib/tenancy.js';
import { migrate, q, one } from '../lib/db.js';

const [cmd, ...rest] = process.argv.slice(2);
const VALUED = new Set(['--email', '--nome']);
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
  } else if (cmd === 'admin') {
    const [slug, name, email] = args; if (!slug || !name || !email) die('Uso: admin <endereco> "<Nome>" <email>');
    const t = await T.bySlug(slug); if (!t) die('Clínica não encontrada.');
    await T.run(t, async () => {
      if (await one('SELECT id FROM users WHERE email = ?', [email])) die('Já existe um usuário com este e-mail nesta clínica.');
      const pass = `${crypto.randomBytes(9).toString('base64url')}#9a`;
      await q("INSERT INTO users (name, email, password_hash, role, must_change_password, is_master) VALUES (?,?,?,'admin',1,1)", [name, email, bcrypt.hashSync(pass, 10)]);
      console.log(`Acesso criado em ${t.env.PUBLIC_URL}\n  e-mail: ${email}\n  senha provisória: ${pass}\n  (trocar no primeiro acesso)`);
    });
  } else if (cmd === 'dominio') {
    const [slug, domain] = args; const t = await T.bySlug(slug); if (!t) die('Clínica não encontrada.');
    const d = await T.addDomain(t.id, domain, { primary: !!flag('principal'), verified: !!flag('principal') });
    console.log(`Domínio ${d} ligado a ${t.name}. Crie no DNS do domínio um registro A (ou CNAME) apontando para o servidor da Mentez.`);
  } else if (cmd === 'situacao') {
    const [slug, st] = args; if (!['ativa', 'suspensa', 'cancelada'].includes(st)) die('Situação: ativa, suspensa ou cancelada.');
    await T.pq('UPDATE tenants SET status = ? WHERE slug = ?', [st, slug]); T.clearCache(); console.log('ok');
  } else die('Comandos: clinicas | criar | admin | dominio | situacao');
} finally { process.exit(0); }
