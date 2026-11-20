// Assinatura digital ICP-Brasil (etapa 1):
//  • A1: o(a) profissional envia o próprio certificado (.pfx/.p12); o sistema guarda criptografado e assina o PDF (PAdES, adbe.pkcs7.detached, SHA-256).
//  • Fora do sistema (nuvem — VIDaaS, BirdID… —, token A3 ou assinador do ITI): o PDF assinado volta ao sistema, que confere
//    a integridade, a assinatura e a cadeia até a raiz da ICP-Brasil antes de guardar.
// As raízes da ICP-Brasil são baixadas do site oficial do ITI (acraiz.icpbrasil.gov.br) e guardadas no banco.
import crypto from 'node:crypto';
import forge from 'node-forge';
import { SignPdf } from '@signpdf/signpdf';
import { P12Signer } from '@signpdf/signer-p12';
import { pdflibAddPlaceholder } from '@signpdf/placeholder-pdf-lib';
import { PDFDocument } from 'pdf-lib';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';

const ICP_POLICY = '2.16.76.1.2.';            // políticas de certificado da ICP-Brasil
const OID_CPF = '2.16.76.1.3.1';              // otherName do e-CPF: nascimento (8) + CPF (11) + …
const ROOT_FILES = ['ICP-Brasilv5.crt', 'ICP-Brasilv10.crt', 'ICP-Brasilv11.crt', 'ICP-Brasilv12.crt', 'ICP-Brasilv13.crt'];
const ROOT_BASE = () => process.env.ICP_ROOTS_URL || 'https://acraiz.icpbrasil.gov.br/credenciadas/RAIZ';
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');
export const maskCpf = (c) => { const d = onlyDigits(c); return d.length === 11 ? `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**` : ''; };

// ---------- raízes confiáveis ----------
let roots = null; // [X509Certificate]
export async function trustedRoots(force = false) {
  if (roots && !force) return roots;
  let pems = [];
  try { pems = JSON.parse((await getSetting('icp_roots')) || '[]'); } catch { pems = []; }
  if (!pems.length || force) {
    const got = [];
    for (const f of ROOT_FILES) {
      try {
        const r = await fetch(`${ROOT_BASE()}/${f}`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        const x = new crypto.X509Certificate(buf);
        if (x.ca && x.checkIssued(x) && x.verify(x.publicKey)) got.push(x.toString()); // raiz autoassinada
      } catch { /* esta versão pode não existir */ }
    }
    if (got.length) { pems = got; await setSetting('icp_roots', JSON.stringify(pems)); }
  }
  const extra = String(process.env.ICP_EXTRA_ROOTS || '').split('|||').filter((s) => s.includes('BEGIN CERTIFICATE')); // só para testes
  roots = [...pems, ...extra].map((p) => new crypto.X509Certificate(p));
  return roots;
}

// ---------- leitura de certificados ----------
function certAsn1(der) { return forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(der).toString('binary'))); }
function extValue(der, oid) {
  // percorre tbsCertificate → [3] extensions procurando a extensão pelo OID
  const c = certAsn1(der); const tbs = c.value[0];
  const exts = tbs.value.find((v) => v.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && v.type === 3);
  if (!exts) return null;
  for (const e of exts.value[0].value) {
    if (forge.asn1.derToOid(e.value[0].value) === oid) return forge.asn1.fromDer(e.value[e.value.length - 1].value);
  }
  return null;
}
export function certInfo(der) {
  const x = new crypto.X509Certificate(der);
  const cn = (x.subject.match(/(?:^|\n)CN=([^\n]+)/) || [])[1] || '';
  const issuerCn = (x.issuer.match(/(?:^|\n)CN=([^\n]+)/) || [])[1] || '';
  let cpf = ''; let policies = [];
  try {
    const san = extValue(der, '2.5.29.17');
    for (const gn of san?.value || []) {
      if (gn.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && gn.type === 0) { // otherName
        const oid = forge.asn1.derToOid(gn.value[0].value);
        if (oid === OID_CPF) { let v = gn.value[1].value[0]; while (Array.isArray(v?.value)) v = v.value[0]; const raw = typeof v?.value === 'string' ? v.value : ''; cpf = onlyDigits(raw).slice(8, 19); }
      }
    }
  } catch { /* sem SAN */ }
  if (!cpf) { const m = cn.match(/:(\d{11})$/); if (m) cpf = m[1]; }
  try { const cp = extValue(der, '2.5.29.32'); policies = (cp?.value || []).map((p) => forge.asn1.derToOid(p.value[0].value)); } catch { /* sem políticas */ }
  return { name: cn.replace(/:\d{11}$/, ''), cn, cpf, issuer: issuerCn, serial: x.serialNumber, validFrom: new Date(x.validFrom), validTo: new Date(x.validTo), icpPolicy: policies.some((p) => p.startsWith(ICP_POLICY)), policies, x };
}

// Certificados intermediários pelo endereço “AC emissora” (AIA) gravado no próprio certificado — guardados em memória
const aiaCache = new Map();
async function aiaIssuer(x) {
  const m = String(x.infoAccess || '').match(/CA Issuers - URI:(\S+)/);
  if (!m || !/^https?:\/\//.test(m[1])) return null;
  if (aiaCache.has(m[1])) return aiaCache.get(m[1]);
  let out = null;
  try {
    const r = await fetch(m[1], { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      let buf = Buffer.from(await r.arrayBuffer());
      if (buf.toString('latin1').includes('BEGIN CERTIFICATE')) buf = Buffer.from(buf.toString('latin1').replace(/-----[^-]+-----|\s/g, ''), 'base64');
      try { out = new crypto.X509Certificate(buf); } catch {
        // .p7b com a cadeia: pega o certificado que emitiu este
        const p7 = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buf.toString('binary'))));
        out = (p7.certificates || []).map((c) => new crypto.X509Certificate(Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(c)).getBytes(), 'binary'))).find((c) => x.checkIssued(c)) || null;
      }
    }
  } catch { out = null; }
  aiaCache.set(m[1], out);
  return out;
}
// Intermediárias de um certificado (sem a raiz), para embutir na assinatura
export async function issuersFor(der) {
  const trust = await trustedRoots(); const out = [];
  let cur = new crypto.X509Certificate(der);
  for (let i = 0; i < 5; i++) {
    if (trust.some((r) => cur.checkIssued(r))) break;
    const up = await aiaIssuer(cur);
    if (!up || up.fingerprint256 === cur.fingerprint256) break;
    out.push(up.raw); cur = up;
  }
  return out;
}
// Cadeia: do certificado do signatário até uma raiz ICP-Brasil, usando os certificados que vieram junto
async function chainOk(leaf, pool) {
  const trust = await trustedRoots();
  let cur = leaf; const seen = new Set();
  for (let i = 0; i < 8; i++) {
    const root = trust.find((r) => cur.checkIssued(r) && cur.verify(r.publicKey));
    if (root) return { ok: true, root: (root.subject.match(/CN=([^\n]+)/) || [])[1] || 'Raiz ICP-Brasil' };
    let up = pool.find((c) => !seen.has(c.fingerprint256) && c.fingerprint256 !== cur.fingerprint256 && cur.checkIssued(c) && cur.verify(c.publicKey));
    if (!up) { const a2 = await aiaIssuer(cur); if (a2 && cur.checkIssued(a2) && cur.verify(a2.publicKey) && !seen.has(a2.fingerprint256)) up = a2; } // intermediária que não veio no arquivo
    if (!up) break;
    seen.add(up.fingerprint256); cur = up;
  }
  return { ok: false, rootsLoaded: trust.length > 0 };
}

// ---------- certificado A1 do(a) profissional ----------
function readP12(buf, pass) {
  let p12;
  try { p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(forge.util.createBuffer(buf.toString('binary')), false), false, String(pass || '')); } catch (e) {
    throw new Error(/password|MAC|Invalid/i.test(e.message) ? 'Senha do certificado incorreta.' : 'Arquivo não reconhecido. Envie o certificado A1 (.pfx ou .p12).');
  }
  const keys = [...(p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag] || []), ...(p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag] || [])];
  const certs = (p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] || []).map((b) => Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(b.cert)).getBytes(), 'binary'));
  if (!keys.length || !certs.length) throw new Error('O arquivo não traz a chave privada. Exporte o certificado A1 com a chave (arquivo .pfx).');
  // certificado do titular = o que corresponde à chave privada
  const pub = forge.pki.setRsaPublicKey(keys[0].key.n, keys[0].key.e);
  const leafDer = certs.find((d) => { try { const c = forge.pki.certificateFromAsn1(certAsn1(d)); return c.publicKey.n?.equals(pub.n); } catch { return false; } }) || certs[0];
  return { leafDer, certs };
}
export async function saveCertificate(userId, pfxBuf, pass, remember) {
  const { leafDer } = readP12(pfxBuf, pass);
  const info = certInfo(leafDer);
  if (!info.icpPolicy) throw new Error('Este certificado não é da ICP-Brasil.');
  if (info.validTo < new Date()) throw new Error(`Este certificado venceu em ${info.validTo.toLocaleDateString('pt-BR')}.`);
  if (info.validFrom > new Date()) throw new Error('Este certificado ainda não está válido.');
  await q(`UPDATE users SET cert_pfx_enc = ?, cert_pass_enc = ?, cert_name = ?, cert_cpf_enc = ?, cert_issuer = ?, cert_serial = ?, cert_valid_to = ? WHERE id = ?`,
    [encrypt(pfxBuf.toString('base64')), remember ? encrypt(String(pass)) : null, info.name.slice(0, 160), info.cpf ? encrypt(info.cpf) : null, info.issuer.slice(0, 160), info.serial.slice(0, 64), info.validTo, userId]);
  return info;
}
export async function removeCertificate(userId) { await q('UPDATE users SET cert_pfx_enc = NULL, cert_pass_enc = NULL, cert_name = NULL, cert_cpf_enc = NULL, cert_issuer = NULL, cert_serial = NULL, cert_valid_to = NULL WHERE id = ?', [userId]); }
export async function certOf(userId) {
  const u = await one('SELECT cert_pfx_enc, cert_pass_enc, cert_name, cert_cpf_enc, cert_issuer, cert_valid_to FROM users WHERE id = ?', [userId]);
  if (!u?.cert_pfx_enc) return null;
  let cpf = ''; try { cpf = u.cert_cpf_enc ? decrypt(u.cert_cpf_enc) : ''; } catch { /* ilegível */ }
  return { name: u.cert_name, cpf, issuer: u.cert_issuer, validTo: u.cert_valid_to ? new Date(u.cert_valid_to) : null, remembered: !!u.cert_pass_enc, expired: u.cert_valid_to ? new Date(u.cert_valid_to) < new Date() : false };
}

// ---------- assinar com o A1 ----------
export async function signWithA1(userId, pdfBuf, { pass, reason, location, contact } = {}) {
  const u = await one('SELECT cert_pfx_enc, cert_pass_enc FROM users WHERE id = ?', [userId]);
  if (!u?.cert_pfx_enc) throw new Error('Cadastre o seu certificado A1 em Conta → Certificado digital.');
  const pfx = Buffer.from(decrypt(u.cert_pfx_enc), 'base64');
  const pw = pass || (u.cert_pass_enc ? decrypt(u.cert_pass_enc) : '');
  const { leafDer } = readP12(pfx, pw); // confere a senha
  const info = certInfo(leafDer);
  if (info.validTo < new Date()) throw new Error(`O certificado venceu em ${info.validTo.toLocaleDateString('pt-BR')}. Envie o novo em Conta → Certificado digital.`);
  const doc = await PDFDocument.load(pdfBuf);
  pdflibAddPlaceholder({ pdfDoc: doc, reason: reason || 'Documento psicológico', contactInfo: contact || '', name: info.name, location: location || 'Goiânia - GO', signatureLength: 16384 });
  const withPh = Buffer.from(await doc.save({ useObjectStreams: false }));
  const signed = await new SignPdf().sign(withPh, new P12Signer(pfx, { passphrase: pw }));
  return { pdf: Buffer.from(signed), info };
}

// ---------- conferir assinaturas de um PDF ----------
const DIGESTS = { '2.16.840.1.101.3.4.2.1': 'sha256', '2.16.840.1.101.3.4.2.2': 'sha384', '2.16.840.1.101.3.4.2.3': 'sha512', '1.3.14.3.2.26': 'sha1' };
function sigEntries(buf) {
  const s = buf.toString('latin1'); const out = [];
  const re = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/g; let m;
  while ((m = re.exec(s))) {
    const br = m.slice(1, 5).map(Number);
    if (br[1] <= 0 || br[2] <= br[1] || br[2] + br[3] > buf.length) continue;
    const hex = s.slice(br[1] + 1, br[2] - 1).replace(/[^0-9a-fA-F]/g, '');
    if (!hex) continue;
    out.push({ br, der: Buffer.from(hex.replace(/(00)+$/, ''), 'hex') });
  }
  return out;
}
function parseCms(der) {
  const A = forge.asn1; const C = A.Class.CONTEXT_SPECIFIC;
  const ci = A.fromDer(forge.util.createBuffer(der.toString('binary')), { strict: false, parseAllBytes: false });
  const sd = ci.value[1].value[0];
  const certSet = sd.value.find((v) => v.tagClass === C && v.type === 0);
  const certs = (certSet?.value || []).map((c) => Buffer.from(A.toDer(c).getBytes(), 'binary'));
  const si = sd.value[sd.value.length - 1].value[0];
  const digestOid = A.derToOid(si.value[2].value[0].value);
  const attrsNode = si.value.find((v) => v.tagClass === C && v.type === 0);
  let md = null; let signingTime = null; let attrsDer = null;
  if (attrsNode) {
    for (const at of attrsNode.value) {
      const oid = A.derToOid(at.value[0].value); const val = at.value[1].value[0];
      if (oid === '1.2.840.113549.1.9.4') md = Buffer.from(val.value, 'binary');
      if (oid === '1.2.840.113549.1.9.5') { try { signingTime = val.type === A.Type.UTCTIME ? A.utcTimeToDate(val.value) : A.generalizedTimeToDate(val.value); } catch { /* ok */ } }
    }
    const set = A.create(A.Class.UNIVERSAL, A.Type.SET, true, attrsNode.value);
    attrsDer = Buffer.from(A.toDer(set).getBytes(), 'binary');
  }
  const sigIdx = si.value.findIndex((v) => v.tagClass === A.Class.UNIVERSAL && v.type === A.Type.OCTETSTRING);
  const signature = Buffer.from(si.value[sigIdx].value, 'binary');
  const sidSerial = (() => { try { return forge.util.bytesToHex(si.value[1].value[1].value).replace(/^0+/, '').toUpperCase(); } catch { return ''; } })();
  return { certs, digest: DIGESTS[digestOid] || 'sha256', md, signingTime, attrsDer, signature, sidSerial };
}
export async function verifyPdf(buf) {
  const entries = sigEntries(buf);
  if (!entries.length) return { ok: false, error: 'O arquivo não tem assinatura digital.' };
  const sigs = [];
  for (const e of entries) {
    const r = { ok: false };
    try {
      const cms = parseCms(e.der);
      const xs = cms.certs.map((d) => new crypto.X509Certificate(d));
      const leafIdx = Math.max(0, xs.findIndex((x) => x.serialNumber.replace(/^0+/, '').toUpperCase() === cms.sidSerial));
      const leaf = xs[leafIdx]; const info = certInfo(cms.certs[leafIdx]);
      const content = Buffer.concat([buf.subarray(e.br[0], e.br[0] + e.br[1]), buf.subarray(e.br[2], e.br[2] + e.br[3])]);
      const hash = crypto.createHash(cms.digest).update(content).digest();
      const intact = cms.md ? cms.md.equals(hash) : false;
      const sigOk = cms.attrsDer ? crypto.verify(cms.digest, cms.attrsDer, leaf.publicKey, cms.signature) : false;
      const chain = await chainOk(leaf, xs);
      const when = cms.signingTime || new Date();
      const inTime = when >= info.validFrom && when <= info.validTo;
      Object.assign(r, { intact, sigOk, chain: chain.ok, root: chain.root, rootsLoaded: chain.rootsLoaded !== false, icpPolicy: info.icpPolicy, inTime,
        name: info.name, cpf: info.cpf, issuer: info.issuer, serial: info.serial, validTo: info.validTo, signingTime: cms.signingTime, coversEnd: e.br[2] + e.br[3] === buf.length });
      r.ok = intact && sigOk && chain.ok && info.icpPolicy && inTime;
    } catch (err) { r.error = `Assinatura ilegível (${err.message})`; }
    sigs.push(r);
  }
  const last = sigs[sigs.length - 1];
  const problems = [];
  for (const s of sigs) {
    if (s.error) problems.push(s.error);
    else {
      if (!s.intact) problems.push('o documento foi alterado depois de assinado');
      if (!s.sigOk) problems.push('a assinatura não confere com o certificado');
      if (!s.icpPolicy) problems.push(`o certificado de ${s.name || 'quem assinou'} não é da ICP-Brasil`);
      else if (!s.chain) problems.push(s.rootsLoaded ? 'a cadeia do certificado não chega à raiz da ICP-Brasil' : 'não foi possível baixar as raízes da ICP-Brasil para conferir a cadeia (tente de novo)');
      if (!s.inTime) problems.push('o certificado estava fora da validade na hora da assinatura');
    }
  }
  return { ok: sigs.every((s) => s.ok) && !!last?.coversEnd, signatures: sigs, last, problems: [...new Set(problems)], modifiedAfter: !last?.coversEnd };
}
