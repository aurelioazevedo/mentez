// Domínios próprios das clínicas (ex.: app.aurelioazevedo.com ou sistema.clinica.com.br).
//
// Como funciona:
// 1. A clínica cadastra o endereço em Configurações → Domínio próprio (ou a Mentez cadastra no Painel).
// 2. A clínica cria no DNS do domínio (Registro.br, Hostinger, Cloudflare…) um registro A apontando para o servidor da Mentez.
// 3. A Mentez consulta o DNS público (botão “Verificar agora” e a cada 10 minutos). Quando o registro aponta para cá,
//    o domínio é liberado, o Caddy emite o certificado HTTPS no primeiro acesso e o endereço passa a abrir a clínica.
// Enquanto o DNS não aponta para a Mentez, o domínio não abre nada e não recebe certificado.
// Cadastros que não forem confirmados em 15 dias são apagados (liberam o endereço para quem é dono de verdade).
import dns from 'node:dns';
import https from 'node:https';
import * as T from './tenancy.js';

export const MAX_PER_CLINIC = 3;
const PENDING_DAYS = 15;

export async function migrate() {
  for (const [col, def] of [['checked_at', 'DATETIME NULL'], ['https_at', 'DATETIME NULL'], ['last_check', 'VARCHAR(600) NULL']]) {
    try { await T.pq(`ALTER TABLE tenant_domains ADD COLUMN ${col} ${def}`); } catch (e) { if (!/Duplicate column/i.test(e.message)) throw e; }
  }
}

// ---------- DNS público (não usa o DNS interno do Docker, que pode ter cache) ----------
let resolver = null;
function R() {
  if (!resolver) {
    resolver = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers(String(process.env.MENTEZ_DNS_SERVERS || '1.1.1.1,8.8.8.8').split(/[\s,]+/).filter(Boolean));
  }
  return resolver;
}
// Testes trocam a consulta de DNS por uma tabela fixa
let fake = null;
export function _setFakeDns(table) { fake = table; }
async function q(type, name) {
  if (process.env.MENTEZ_DNS_FAKE_FILE) { const fs = await import('node:fs'); fake = JSON.parse(fs.readFileSync(process.env.MENTEZ_DNS_FAKE_FILE, 'utf8')); }
  if (fake) { const v = fake[`${type} ${name}`]; if (v instanceof Error) throw v; if (!v) { const e = new Error('ENODATA'); e.code = 'ENODATA'; throw e; } return v; }
  const r = R();
  return type === 'A' ? r.resolve4(name) : type === 'AAAA' ? r.resolve6(name) : type === 'CNAME' ? r.resolveCname(name) : r.resolveNs(name);
}
const safe = (p) => p.then((v) => v, () => []);

// Endereço do servidor da Mentez: MENTEZ_PUBLIC_IP, ou o IP de app.<domínio base> (que sempre aponta para cá)
let target = { at: 0, v4: [], v6: [] };
export async function serverIps() {
  if (Date.now() - target.at < 10 * 60e3 && (target.v4.length || process.env.MENTEZ_PUBLIC_IP)) return target;
  const envV4 = String(process.env.MENTEZ_PUBLIC_IP || '').split(/[\s,]+/).filter(Boolean);
  const envV6 = String(process.env.MENTEZ_PUBLIC_IPV6 || '').split(/[\s,]+/).filter(Boolean);
  const ref = `app.${T.baseDomain()}`;
  target = { at: Date.now(), v4: envV4.length ? envV4 : await safe(q('A', ref)), v6: envV6.length ? envV6 : await safe(q('AAAA', ref)) };
  return target;
}

export function normalize(input) {
  const d = String(input || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/\.$/, '');
  if (!/^(?=.{4,190}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(d)) throw new Error('Endereço inválido. Escreva só o endereço, por exemplo: app.suaclinica.com.br');
  const base = T.baseDomain();
  if (d === base || d.endsWith(`.${base}`)) throw new Error(`Endereços ${base} já funcionam sem cadastro.`);
  if (T.platformHosts().has(d)) throw new Error('Este endereço é da Mentez.');
  return d;
}

// Onde fica o DNS do domínio (pelos servidores NS da zona) e qual “nome” do registro criar
const PROVIDERS = [
  [/dns-parking\.com$|hostinger/i, 'hostinger', 'Hostinger'],
  [/(^|\.)dns\.br$/i, 'registrobr', 'Registro.br'],
  [/cloudflare\.com$/i, 'cloudflare', 'Cloudflare'],
  [/domaincontrol\.com$/i, 'godaddy', 'GoDaddy'],
  [/locaweb\.com\.br$/i, 'locaweb', 'Locaweb'],
  [/hostgator/i, 'hostgator', 'HostGator'],
  [/kinghost/i, 'kinghost', 'KingHost'],
  [/uolhost|uol\.com\.br$/i, 'uolhost', 'UOL Host'],
  [/awsdns/i, 'aws', 'Amazon Route 53'],
  [/googledomains\.com$|google\.com$/i, 'google', 'Google Cloud DNS'],
  [/wixdns\.net$/i, 'wix', 'Wix'],
  [/squarespacedns|squarespace/i, 'squarespace', 'Squarespace'],
  [/registrar-servers\.com$/i, 'namecheap', 'Namecheap'],
];
export async function zoneOf(domain) {
  const parts = domain.split('.');
  for (let i = 0; i < parts.length - 1; i++) {
    const zone = parts.slice(i).join('.');
    const ns = await safe(q('NS', zone));
    if (ns.length) {
      const hit = PROVIDERS.find(([re]) => ns.some((n) => re.test(String(n).replace(/\.$/, ''))));
      return { zone, ns, host: i === 0 ? '@' : parts.slice(0, i).join('.'), provider: hit ? hit[1] : 'outro', providerName: hit ? hit[2] : '' };
    }
  }
  // sem resposta de NS: supõe o domínio registrável (2 últimos rótulos, 3 em .com.br etc.)
  const n = /\.(com|net|org|gov|edu|art|blog|eco|ind|inf|med|odo|psc|adv|eng|arq)\.br$/.test(domain) ? 3 : 2;
  const zone = parts.slice(-n).join('.');
  return { zone, ns: [], host: parts.length > n ? parts.slice(0, -n).join('.') : '@', provider: 'outro', providerName: '' };
}

// Confere o DNS de um domínio: { ok, a, aaaa, cname, problems[], zone, host, provider, providerName, expected }
export async function inspect(domain) {
  const [ips, z, a, aaaa, cname] = await Promise.all([serverIps(), zoneOf(domain), safe(q('A', domain)), safe(q('AAAA', domain)), safe(q('CNAME', domain))]);
  const problems = [];
  const v4 = ips.v4[0] || '';
  if (!a.length) problems.push(cname.length ? `O endereço tem um registro CNAME (${cname[0]}) que não leva ao servidor da Mentez. Apague o CNAME e crie o registro A.` : 'Ainda não encontramos o registro A. Se acabou de criar, aguarde alguns minutos (pode levar até algumas horas).');
  else {
    const wrong = a.filter((x) => !ips.v4.includes(x));
    if (wrong.length === a.length) problems.push(`O registro A aponta para ${wrong.join(', ')}. Troque o valor para ${v4}.`);
    else if (wrong.length) problems.push(`Há mais de um registro A para este endereço (${wrong.join(', ')}). Apague os outros e deixe só ${v4}.`);
  }
  const wrong6 = aaaa.filter((x) => !ips.v6.includes(x));
  if (wrong6.length) problems.push(`Existe um registro AAAA (IPv6) apontando para outro servidor (${wrong6.join(', ')}). Apague esse registro AAAA.`);
  return { ok: !!a.length && !problems.length, a, aaaa, cname, problems, expected: { v4, v6: ips.v6[0] || '' }, ...z };
}

// HTTPS respondendo pela Mentez (o primeiro acesso também faz o Caddy emitir o certificado)
function viaCaddy(domain) {
  // pergunta direto ao Caddy na rede interna do Docker (não depende de o servidor alcançar o próprio IP público);
  // o certificado é conferido para o domínio (servername), então só dá certo com o HTTPS de verdade emitido
  const host = process.env.MENTEZ_CADDY_HOST || 'caddy';
  return new Promise((resolve) => {
    const req = https.get({ host, port: 443, servername: domain, path: '/_mentez/saude', headers: { host: domain }, timeout: 20e3 }, (r) => {
      let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { resolve(r.statusCode === 200 && JSON.parse(b).ok === true); } catch { resolve(false); } });
    });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve(false));
  });
}
async function httpsOk(domain) {
  if (await viaCaddy(domain)) return true;
  try {
    const r = await fetch(`https://${domain}/_mentez/saude`, { signal: AbortSignal.timeout(20e3), redirect: 'manual' });
    return r.ok && (await r.json().catch(() => ({}))).ok === true;
  } catch { return false; }
}
let httpsProbe = (d) => (fake && `HTTPS ${d}` in fake ? Promise.resolve(!!fake[`HTTPS ${d}`]) : httpsOk(d));
export function _setHttpsProbe(fn) { httpsProbe = fn; }

// Verifica e grava o resultado. Retorna a linha atualizada e o diagnóstico.
export async function check(domain, tenantId = null) {
  const row = await T.pone(`SELECT * FROM tenant_domains WHERE domain = ?${tenantId ? ' AND tenant_id = ?' : ''}`, tenantId ? [domain, tenantId] : [domain]);
  if (!row) throw new Error('Domínio não encontrado.');
  const r = await inspect(domain);
  let note = r.ok ? '' : r.problems.join(' ');
  if (r.ok && !row.verified_at) { await T.pq('UPDATE tenant_domains SET verified_at = NOW() WHERE domain = ?', [domain]); T.clearCache(); }
  let https = !!row.https_at;
  if (r.ok && !https) {
    https = await httpsProbe(domain);
    if (https) await T.pq('UPDATE tenant_domains SET https_at = NOW() WHERE domain = ?', [domain]);
    else note = 'O DNS já aponta para a Mentez. O certificado HTTPS está sendo emitido; tente abrir o endereço em alguns minutos.';
  }
  if (!r.ok && row.verified_at) note = `O DNS parou de apontar para a Mentez. ${note}`;
  await T.pq('UPDATE tenant_domains SET checked_at = NOW(), last_check = ? WHERE domain = ?', [note.slice(0, 600) || null, domain]);
  return { row: await T.pone('SELECT * FROM tenant_domains WHERE domain = ?', [domain]), ...r, https };
}

export function stateOf(row) {
  if (row.verified_at && row.https_at) return { key: 'ativo', label: 'Ativo', badge: 'realizada' };
  if (row.verified_at) return { key: 'https', label: 'Ativando HTTPS', badge: 'confirmada' };
  return { key: 'pendente', label: 'Aguardando DNS', badge: 'agendada' };
}

export const list = (tenantId) => T.pq('SELECT * FROM tenant_domains WHERE tenant_id = ? ORDER BY is_primary DESC, created_at', [tenantId]);

export async function add(tenantId, input, actor = 'clinica') {
  const d = normalize(input);
  const other = await T.pone('SELECT tenant_id FROM tenant_domains WHERE domain = ?', [d]);
  if (other && other.tenant_id !== tenantId) throw new Error('Este endereço já está cadastrado em outra clínica. Se ele é seu, fale com o suporte da Mentez.');
  if (other) return d;
  const n = (await T.pone('SELECT COUNT(*) n FROM tenant_domains WHERE tenant_id = ?', [tenantId])).n;
  if (n >= MAX_PER_CLINIC) throw new Error(`Cada clínica pode ter até ${MAX_PER_CLINIC} domínios próprios. Remova um para cadastrar outro.`);
  await T.pq('INSERT INTO tenant_domains (domain, tenant_id) VALUES (?,?)', [d, tenantId]);
  await T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', [actor, 'dominio-adicionar', tenantId, d]);
  T.clearCache();
  try { await check(d, tenantId); } catch { /* o DNS pode ainda não existir */ }
  return d;
}
export async function setPrimary(tenantId, domain, actor = 'clinica') {
  await T.pq('UPDATE tenant_domains SET is_primary = 0 WHERE tenant_id = ?', [tenantId]);
  if (domain) {
    const row = await T.pone('SELECT * FROM tenant_domains WHERE tenant_id = ? AND domain = ?', [tenantId, domain]);
    if (!row?.verified_at || !row?.https_at) throw new Error('Só dá para usar como principal um domínio já ativo (DNS e HTTPS funcionando).');
    await T.pq('UPDATE tenant_domains SET is_primary = 1 WHERE tenant_id = ? AND domain = ?', [tenantId, domain]);
  }
  await T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', [actor, 'dominio-principal', tenantId, domain || '(endereço da Mentez)']);
  T.clearCache();
}
export async function remove(tenantId, domain, actor = 'clinica') {
  await T.pq('DELETE FROM tenant_domains WHERE tenant_id = ? AND domain = ?', [tenantId, domain]);
  await T.pq('INSERT INTO platform_audit (actor, action, tenant_id, detail) VALUES (?,?,?,?)', [actor, 'dominio-remover', tenantId, domain]);
  T.clearCache();
}

// A cada 10 minutos: confere os pendentes (e os ativos uma vez por dia); apaga cadastros não confirmados há 15 dias
export async function tick() {
  await T.pq(`DELETE FROM tenant_domains WHERE verified_at IS NULL AND created_at < NOW() - INTERVAL ${PENDING_DAYS} DAY`);
  const rows = await T.pq(`SELECT domain FROM tenant_domains WHERE (verified_at IS NULL OR https_at IS NULL) OR checked_at IS NULL OR checked_at < NOW() - INTERVAL 1 DAY ORDER BY checked_at LIMIT 30`);
  for (const r of rows) { try { await check(r.domain); } catch (e) { console.error('domínio', r.domain, e.message); } }
}
