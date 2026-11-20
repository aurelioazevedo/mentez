// Assinatura com certificado em nuvem (BirdID, VIDaaS, SafeID e o certificado do CFM),
// pela API padrão dos PSCs da ICP-Brasil (ITI, DOC-ICP-17.01): OAuth 2 com PKCE → token → certificado → assinatura do resumo (RAW).
// O sistema monta o CMS (PKCS#7) com o certificado e a assinatura devolvidos e grava no PDF (mesmo formato do A1).
// Os endereços de cada certificadora ficam editáveis em Configurações → Assinatura digital: confirme com a certificadora
// ao receber as credenciais (client_id / client_secret).
import crypto from 'node:crypto';
import forge from 'node-forge';
import { SignPdf } from '@signpdf/signpdf';
import { Signer } from '@signpdf/utils';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { PDFDocument } from 'pdf-lib';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { certInfo, issuersFor } from './icp.js';

export const PROVIDERS = {
  birdid: { label: 'BirdID', company: 'Soluti', app: 'BirdID', prod: 'https://api.birdid.com.br/v0/oauth', hom: 'https://apihom.birdid.com.br/v0/oauth' },
  vidaas: { label: 'VIDaaS', company: 'Valid', app: 'VIDaaS', prod: 'https://certificado.vidaas.com.br/v0/oauth', hom: 'https://hml-certificado.vidaas.com.br/v0/oauth' },
  safeid: { label: 'SafeID', company: 'Safeweb', app: 'SafeID', prod: 'https://pscsafeweb.safewebpss.com.br/Service/Microservice/OAuth/v0/oauth', hom: 'https://pscsafeweb-hml.safewebpss.com.br/Service/Microservice/OAuth/v0/oauth' },
  cfm: { label: 'Certificado do CFM', company: 'CFM (emitido pela Valid, no app VIDaaS)', app: 'VIDaaS', prod: 'https://certificado.vidaas.com.br/v0/oauth', hom: 'https://hml-certificado.vidaas.com.br/v0/oauth', sameAs: 'vidaas' },
};
const OID = { data: '1.2.840.113549.1.7.1', signedData: '1.2.840.113549.1.7.2', contentType: '1.2.840.113549.1.9.3', messageDigest: '1.2.840.113549.1.9.4', signingTime: '1.2.840.113549.1.9.5', signingCertV2: '1.2.840.113549.1.9.16.2.47', sha256: '2.16.840.1.101.3.4.2.1', rsa: '1.2.840.113549.1.1.1' };

// ---------- configuração (clínica) ----------
export async function config() {
  let c = {}; try { c = JSON.parse((await getSetting('icp_cloud')) || '{}'); } catch { /* padrão */ }
  const out = { session: !!c.session, sessionHours: [1, 2, 4, 8, 12].includes(Number(c.sessionHours)) ? Number(c.sessionHours) : 4, providers: {} };
  for (const [k, p] of Object.entries(PROVIDERS)) {
    const x = c.providers?.[k] || {};
    let secret = ''; try { secret = x.secret_enc ? decrypt(x.secret_enc) : ''; } catch { /* ilegível */ }
    out.providers[k] = { enabled: !!x.enabled, env: x.env === 'hom' ? 'hom' : 'prod', clientId: x.clientId || '', secret, useVidaas: k === 'cfm' ? x.useVidaas !== false : false,
      base: (x.base || '').trim() || (x.env === 'hom' ? p.hom : p.prod) };
  }
  return out;
}
export async function saveConfig(b, cur) {
  const providers = {};
  for (const k of Object.keys(PROVIDERS)) {
    const old = cur.providers[k]; const s = String(b[`${k}_secret`] || '').trim();
    const env = b[`${k}_env`] === 'hom' ? 'hom' : 'prod';
    const base = String(b[`${k}_base`] || '').trim();
    providers[k] = { enabled: !!b[`${k}_enabled`], env, clientId: String(b[`${k}_clientId`] || '').trim().slice(0, 200),
      secret_enc: b[`${k}_secret_remove`] ? null : s ? encrypt(s) : old.secret ? encrypt(old.secret) : null,
      base: base && base !== PROVIDERS[k][env] ? base.slice(0, 300) : '', useVidaas: k === 'cfm' ? !!b.cfm_useVidaas : undefined };
  }
  await setSetting('icp_cloud', JSON.stringify({ session: !!b.session, sessionHours: Number(b.sessionHours) || 4, providers }));
}
// credenciais efetivas (o certificado do CFM usa o cadastro do sistema na Valid, o mesmo do VIDaaS)
export function creds(c, k) {
  const p = c.providers[k];
  if (k === 'cfm' && p.useVidaas) { const v = c.providers.vidaas; return { ...p, clientId: v.clientId, secret: v.secret, base: p.base }; }
  return p;
}
export const ready = (c, k) => { const p = c.providers[k]; if (!p?.enabled) return false; const cr = creds(c, k); return !!(cr.clientId && cr.secret && cr.base); };
export const available = (c) => Object.keys(PROVIDERS).filter((k) => ready(c, k));

// ---------- escolha do(a) profissional ----------
export async function userChoice(userId) { const u = await one('SELECT cloud_provider FROM users WHERE id = ?', [userId]); return u?.cloud_provider || null; }
export async function setUserChoice(userId, k) { await q('UPDATE users SET cloud_provider = ? WHERE id = ?', [PROVIDERS[k] ? k : null, userId]); await q('DELETE FROM icp_cloud_tokens WHERE user_id = ?', [userId]); }

// ---------- HTTP com a certificadora ----------
async function call(cr, method, path, { form, json, token } = {}) {
  const headers = { Accept: 'application/json', 'User-Agent': 'SistemaConsultorio/1.0' };
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${cr.base.replace(/\/+$/, '')}/${path}`, { method, headers, body, signal: AbortSignal.timeout(30000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(d.error_description || d.message || d.error || `a certificadora respondeu ${r.status}`); e.status = r.status; throw e; }
  return d;
}
const b64url = (b) => Buffer.from(b).toString('base64url');

// 1) Início: guarda a sessão (PKCE) e devolve o endereço de autorização da certificadora
export async function start({ userId, docId, provider, cpf, redirectUri }) {
  const c = await config();
  if (!ready(c, provider)) throw new Error(`${PROVIDERS[provider]?.label || 'Certificadora'} ainda não está configurada pela clínica.`);
  const cr = creds(c, provider);
  const state = b64url(crypto.randomBytes(24)); const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  await q('DELETE FROM icp_cloud_sessions WHERE created < ?', [Date.now() - 3600e3]);
  await q('INSERT INTO icp_cloud_sessions (state, user_id, doc_id, provider, verifier, created) VALUES (?,?,?,?,?,?)', [state, userId, docId, provider, encrypt(verifier), Date.now()]);
  const scope = c.session ? 'signature_session' : 'single_signature';
  const qs = new URLSearchParams({ response_type: 'code', client_id: cr.clientId, redirect_uri: redirectUri, scope, state, code_challenge: challenge, code_challenge_method: 'S256' });
  if (cpf) qs.set('login_hint', String(cpf).replace(/\D/g, ''));
  if (c.session) qs.set('lifetime', String(c.sessionHours * 3600));
  return `${cr.base.replace(/\/+$/, '')}/authorize?${qs}`;
}
// 2) Retorno: troca o código pelo token (e guarda o token, se a clínica liberou a sessão de assinatura)
export async function finish({ state, code, userId, redirectUri }) {
  const s = await one('SELECT * FROM icp_cloud_sessions WHERE state = ?', [String(state || '')]);
  await q('DELETE FROM icp_cloud_sessions WHERE state = ?', [String(state || '')]);
  if (!s || s.user_id !== userId || Date.now() - Number(s.created) > 15 * 60e3) throw new Error('Pedido de assinatura expirado. Tente de novo.');
  const c = await config(); const cr = creds(c, s.provider);
  const t = await call(cr, 'POST', 'token', { form: { grant_type: 'authorization_code', client_id: cr.clientId, client_secret: cr.secret, code: String(code || ''), redirect_uri: redirectUri, code_verifier: decrypt(s.verifier) } });
  if (!t.access_token) throw new Error('A certificadora não liberou a assinatura.');
  if (c.session && t.expires_in) await q('REPLACE INTO icp_cloud_tokens (user_id, provider, token_enc, expires) VALUES (?,?,?,?)', [userId, s.provider, encrypt(t.access_token), Date.now() + Math.max(0, Number(t.expires_in) - 60) * 1000]);
  return { docId: s.doc_id, provider: s.provider, token: t.access_token };
}
// token ainda válido (sessão de assinatura): assina sem nova aprovação no celular
export async function sessionToken(userId, provider) {
  const r = await one('SELECT token_enc, expires FROM icp_cloud_tokens WHERE user_id = ? AND provider = ?', [userId, provider]);
  if (!r || Number(r.expires) < Date.now()) return null;
  try { return decrypt(r.token_enc); } catch { return null; }
}
export async function dropToken(userId, provider) { await q('DELETE FROM icp_cloud_tokens WHERE user_id = ? AND provider = ?', [userId, provider]); }

// 3) Certificado do titular
function toDer(v) {
  const s = String(v || '').trim();
  if (s.includes('BEGIN CERTIFICATE')) return Buffer.from(s.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  return Buffer.from(s.replace(/\s/g, ''), 'base64');
}
export async function certificate(provider, token) {
  const c = await config(); const cr = creds(c, provider);
  const d = await call(cr, 'GET', 'certificate-discovery', { token });
  const list = [].concat(d.certificates || d.certificate || []);
  const it = list.find((x) => x && (x.certificate || x.certificate_base64)) || null;
  if (!it) throw new Error('A certificadora não devolveu o certificado.');
  return { alias: it.alias || it.certificate_alias || '', der: toDer(it.certificate || it.certificate_base64) };
}
// 4) Assinatura RAW (PKCS#1 v1.5) do resumo SHA-256
async function rawSign(provider, token, alias, digest) {
  const c = await config(); const cr = creds(c, provider);
  const d = await call(cr, 'POST', 'signature', { token, json: { certificate_alias: alias || undefined, hashes: [{ id: '1', alias: 'documento', hash: digest.toString('base64'), hash_algorithm: OID.sha256, signature_format: 'RAW' }] } });
  const s = [].concat(d.signatures || [])[0];
  const raw = s?.raw_signature || s?.signature;
  if (!raw) throw new Error('A certificadora não devolveu a assinatura.');
  return Buffer.from(raw, 'base64');
}

// ---------- montagem do CMS (PKCS#7 destacado) ----------
const A = forge.asn1; const U = A.Class.UNIVERSAL;
const node = (type, cons, val) => A.create(U, type, cons, val);
const oidN = (o) => node(A.Type.OID, false, A.oidToDer(o).getBytes());
const bin = (b) => Buffer.from(b).toString('binary');
const fromDer = (b) => A.fromDer(forge.util.createBuffer(bin(b)));
const derOf = (n) => Buffer.from(A.toDer(n).getBytes(), 'binary');
const algId = (o) => node(A.Type.SEQUENCE, true, [oidN(o), node(A.Type.NULL, false, '')]);
const attr = (o, v) => node(A.Type.SEQUENCE, true, [oidN(o), node(A.Type.SET, true, [v])]);
function signedAttrs(contentDigest, certDer, when) {
  const essCertIdV2 = node(A.Type.SEQUENCE, true, [node(A.Type.OCTETSTRING, false, bin(crypto.createHash('sha256').update(certDer).digest()))]); // SHA-256 é o padrão: sem algoritmo explícito
  return [
    attr(OID.contentType, oidN(OID.data)),
    attr(OID.signingTime, node(A.Type.UTCTIME, false, A.dateToUtcTime(when))),
    attr(OID.messageDigest, node(A.Type.OCTETSTRING, false, bin(contentDigest))),
    attr(OID.signingCertV2, node(A.Type.SEQUENCE, true, [node(A.Type.SEQUENCE, true, [essCertIdV2])])),
  ];
}
function buildCms({ certs, leafDer, attrs, signature }) {
  const leaf = fromDer(leafDer); const tbs = leaf.value[0];
  const hasVersion = tbs.value[0].tagClass === A.Class.CONTEXT_SPECIFIC;
  const serial = tbs.value[hasVersion ? 1 : 0]; const issuer = tbs.value[hasVersion ? 3 : 2];
  const signerInfo = node(A.Type.SEQUENCE, true, [
    node(A.Type.INTEGER, false, A.integerToDer(1).getBytes()),
    node(A.Type.SEQUENCE, true, [issuer, serial]),
    algId(OID.sha256),
    A.create(A.Class.CONTEXT_SPECIFIC, 0, true, attrs),
    algId(OID.rsa),
    node(A.Type.OCTETSTRING, false, bin(signature)),
  ]);
  const signedData = node(A.Type.SEQUENCE, true, [
    node(A.Type.INTEGER, false, A.integerToDer(1).getBytes()),
    node(A.Type.SET, true, [algId(OID.sha256)]),
    node(A.Type.SEQUENCE, true, [oidN(OID.data)]),
    A.create(A.Class.CONTEXT_SPECIFIC, 0, true, certs.map(fromDer)),
    node(A.Type.SET, true, [signerInfo]),
  ]);
  return derOf(node(A.Type.SEQUENCE, true, [oidN(OID.signedData), A.create(A.Class.CONTEXT_SPECIFIC, 0, true, [signedData])]));
}
class CloudSigner extends Signer {
  constructor(fn) { super(); this.fn = fn; }
  async sign(content) { return this.fn(content); }
}
// Assina o PDF base com o certificado em nuvem (token já liberado)
export async function signPdf({ provider, token, pdf, reason, location }) {
  const cert = await certificate(provider, token);
  const info = certInfo(cert.der);
  if (!info.icpPolicy) throw new Error('O certificado devolvido não é da ICP-Brasil.');
  if (info.validTo < new Date()) throw new Error(`O certificado venceu em ${info.validTo.toLocaleDateString('pt-BR')}.`);
  const chain = await issuersFor(cert.der); // intermediárias (vindas da certificadora ou baixadas do endereço do próprio certificado)
  const doc = await PDFDocument.load(pdf);
  pdflibAddPlaceholder({ pdfDoc: doc, reason: reason || 'Documento', contactInfo: '', name: info.name, location: location || 'Brasil', signatureLength: 16384 });
  const withPh = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signer = new CloudSigner(async (content) => {
    const attrs = signedAttrs(crypto.createHash('sha256').update(content).digest(), cert.der, new Date());
    const attrsDer = derOf(node(A.Type.SET, true, attrs));
    const sig = await rawSign(provider, token, cert.alias, crypto.createHash('sha256').update(attrsDer).digest());
    return buildCms({ certs: [cert.der, ...chain], leafDer: cert.der, attrs, signature: sig });
  });
  const signed = Buffer.from(await new SignPdf().sign(withPh, signer));
  return { pdf: signed, info };
}
