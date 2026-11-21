// Mentez: trazer para a plataforma uma clínica que roda no sistema próprio (ex.: Dra. Lorrainy, na hospedagem compartilhada).
//
// Como funciona (sem nenhum segredo passar por fora dos dois servidores):
// 1. Na VPS existe um par de chaves (/opt/mentez/keys/migracao.pem). A chave pública fica no código do sistema antigo.
// 2. A Mentez pede a exportação (pedido assinado com a chave privada). O sistema antigo congela (tela “em atualização”,
//    tarefas automáticas paradas) e devolve banco + chaves (SESSION_SECRET, ENCRYPTION_KEY…) cifrados para a chave pública.
// 3. A Mentez decifra, cria um banco novo para a clínica, copia tudo, grava as chaves dela (sessões continuam valendo e as
//    chaves de API guardadas no banco continuam legíveis) e aponta a clínica para o banco novo.
// 4. A Mentez avisa o sistema antigo (“concluir”): a partir daí ele só encaminha as visitas para a Mentez, até o DNS mudar.
//    Se algo falhar antes do passo 4, “cancelar” devolve o sistema antigo ao normal, sem perda.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import readline from 'node:readline';
import mysql from 'mysql2/promise';
import * as T from './tenancy.js';

const keyFile = () => process.env.MENTEZ_MIGRATION_KEY || '/opt/mentez/migracao/migracao.pem';
const privateKey = () => crypto.createPrivateKey(fs.readFileSync(keyFile()));

// Pedido assinado: “ação:hora:host” com a chave privada
export function signed(action, host) {
  const ts = String(Date.now());
  const sig = crypto.sign('sha256', Buffer.from(`${action}:${ts}:${host}`), privateKey()).toString('base64url');
  return { 'x-mz-ts': ts, 'x-mz-sig': sig };
}
async function call(src, action, { method = 'POST', headers = {} } = {}) {
  const u = new URL(`/_migracao/${action}`, src);
  const r = await fetch(u, { method, headers: { ...signed(action, u.host), ...headers }, signal: AbortSignal.timeout(30 * 60e3) });
  return r;
}
export async function state(src) { const r = await call(src, 'estado', { method: 'GET' }); return r.json(); }
export async function finish(src, target) { const r = await call(src, 'concluir', { headers: { 'x-mz-target': target } }); if (!r.ok) throw new Error(`concluir: ${r.status} ${await r.text()}`); return r.json(); }
export async function cancel(src) { const r = await call(src, 'cancelar'); if (!r.ok) throw new Error(`cancelar: ${r.status} ${await r.text()}`); return r.json(); }

// Baixa o pacote cifrado para um arquivo
export async function download(src, file, log = console.log) {
  const r = await call(src, 'exportar', { method: 'GET' });
  if (!r.ok) throw new Error(`exportar: ${r.status} ${(await r.text()).slice(0, 300)}`);
  const out = fs.createWriteStream(file);
  let n = 0; let last = 0;
  for await (const chunk of r.body) { n += chunk.length; if (n - last > 10 * 1048576) { last = n; log(`  baixado ${(n / 1048576).toFixed(0)} MB`); } if (!out.write(chunk)) await new Promise((ok) => out.once('drain', ok)); }
  await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
  return n;
}

// Lê o pacote: [4 bytes tamanho][cabeçalho JSON][dados cifrados AES-256-GCM (gzip de NDJSON)][16 bytes tag]
export async function* readPackage(file) {
  const fd = fs.openSync(file, 'r'); const size = fs.fstatSync(fd).size;
  const lenB = Buffer.alloc(4); fs.readSync(fd, lenB, 0, 4, 0); const hl = lenB.readUInt32BE(0);
  const hb = Buffer.alloc(hl); fs.readSync(fd, hb, 0, hl, 4); const head = JSON.parse(hb.toString('utf8'));
  const tag = Buffer.alloc(16); fs.readSync(fd, tag, 0, 16, size - 16); fs.closeSync(fd);
  const key = crypto.privateDecrypt({ key: privateKey(), padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(head.key, 'base64'));
  const dec = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(head.iv, 'base64')); dec.setAuthTag(tag);
  const body = fs.createReadStream(file, { start: 4 + hl, end: size - 17 });
  const lines = readline.createInterface({ input: body.pipe(dec).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}
const decode = (v) => (v && typeof v === 'object' ? (v.$b !== undefined ? Buffer.from(v.$b, 'base64') : v.$j !== undefined ? v.$j : v) : v);

// Importa o pacote num banco novo e devolve { db, meta, counts }
export async function importInto(file, dbName, log = console.log, filesRoot = null) {
  if (!/^[a-z0-9_]{3,64}$/.test(dbName)) throw new Error('Nome de banco inválido.');
  const cfg = T.connConfigFor(undefined);
  const root = await mysql.createConnection({ ...cfg, charset: 'utf8mb4' });
  await root.query(`CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await root.end();
  const c = await mysql.createConnection({ ...cfg, database: dbName, charset: 'utf8mb4', multipleStatements: false });
  await c.query("SET time_zone = '+00:00'"); await c.query('SET FOREIGN_KEY_CHECKS = 0'); await c.query("SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO'");
  let meta = null; let end = null; const counts = {}; let cols = {};
  for await (const m of readPackage(file)) {
    if (m.t === 'meta') meta = m;
    else if (m.t === 'table') { await c.query(m.create); counts[m.name] = 0; cols[m.name] = null; }
    else if (m.t === 'rows' && m.rows.length) {
      const keys = cols[m.name] || (cols[m.name] = Object.keys(m.rows[0]));
      const sql = `INSERT INTO \`${m.name}\` (${keys.map((k) => `\`${k}\``).join(',')}) VALUES ${m.rows.map(() => `(${keys.map(() => '?').join(',')})`).join(',')}`;
      await c.query(sql, m.rows.flatMap((r) => keys.map((k) => decode(r[k]))));
      counts[m.name] += m.rows.length;
      if (counts[m.name] % 5000 < m.rows.length) log(`  ${m.name}: ${counts[m.name]}`);
    } else if (m.t === 'file' && filesRoot) {
      // arquivos fora do banco (PDFs dos cadernos): só caminhos simples, dentro da pasta da clínica
      if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*\.pdf$/.test(m.path)) { log(`  arquivo ignorado: ${m.path}`); continue; }
      const dest = path.join(filesRoot, m.path);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from(m.data, 'base64'));
      counts['(arquivos)'] = (counts['(arquivos)'] || 0) + 1;
    } else if (m.t === 'end') end = m;
  }
  await c.query('SET FOREIGN_KEY_CHECKS = 1');
  await c.end();
  if (!meta || !end) throw new Error('Pacote incompleto (sem início ou fim).');
  const diff = Object.entries(end.counts).filter(([k, n]) => (k !== '(arquivos)' || filesRoot) && counts[k] !== n);
  if (diff.length) throw new Error(`Quantidade de linhas não confere: ${diff.map(([k, n]) => `${k} ${counts[k]}/${n}`).join(', ')}`);
  return { db: dbName, meta, counts };
}
