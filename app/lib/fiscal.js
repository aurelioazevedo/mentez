// Dados fiscais do(a) profissional: quando o paciente paga direto para ele(a), o documento fiscal é dele(a).
// Pessoa física → recibo no Receita Saúde (Carnê-Leão); pessoa jurídica → NFS-e com o CNPJ próprio (pelo Asaas).
import { q, one } from './db.js';
import { encrypt, decrypt } from './crypto.js';

export const KINDS = {
  pf: ['Pessoa física', 'Recibo no Receita Saúde (app da Receita Federal) e Carnê-Leão, com o meu CPF'],
  pj: ['Pessoa jurídica', 'Nota fiscal de serviço (NFS-e) com o meu CNPJ, emitida pelo sistema'],
};
import { cpfValid, cpfFmt } from './br.js';
export { cpfValid, cpfFmt };

export async function profile(uid) {
  const u = uid ? await one('SELECT id, name, title, crp FROM users WHERE id = ?', [uid]) : null;
  const f = uid ? await one('SELECT * FROM user_fiscal WHERE user_id = ?', [uid]) : null;
  let cpf = ''; try { cpf = f?.cpf_enc ? decrypt(f.cpf_enc) : ''; } catch { /* ilegível */ }
  let nf = {}; try { nf = JSON.parse(f?.nfse_cfg || '{}'); } catch { /* vazio */ }
  return { user_id: uid, saved: !!f, kind: f?.kind || 'pf', fullName: f?.full_name || u?.name || '', cpf, crp: u?.crp || '', address: f?.address || '', city: f?.city || 'Goiânia',
    cnpj: nf.cnpj || '', razao: nf.razao || '', userName: u?.name || '' };
}
// O que falta para o(a) profissional emitir os próprios documentos
export function missing(p) {
  const m = [];
  if (!p.saved) return ['dados fiscais'];
  if (!String(p.fullName).trim()) m.push('nome completo');
  if (!cpfValid(p.cpf)) m.push('CPF');
  if (!String(p.crp).trim()) m.push('CRP');
  return m;
}
export async function saveProfile(uid, b) {
  const kind = b.kind === 'pj' ? 'pj' : 'pf';
  const cpf = String(b.cpf || '').replace(/\D/g, '').slice(0, 11);
  await q(`INSERT INTO user_fiscal (user_id, kind, full_name, cpf_enc, address, city) VALUES (?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE kind = VALUES(kind), full_name = VALUES(full_name), cpf_enc = VALUES(cpf_enc), address = VALUES(address), city = VALUES(city)`,
  [uid, kind, String(b.fullName || '').trim().slice(0, 160), cpf ? encrypt(cpf) : null, String(b.address || '').trim().slice(0, 200), String(b.city || '').trim().slice(0, 80) || 'Goiânia']);
  if (b.crp !== undefined) await q('UPDATE users SET crp = ? WHERE id = ?', [String(b.crp || '').trim().slice(0, 30) || null, uid]);
}
export const kindOf = async (uid) => (uid ? (await one('SELECT kind FROM user_fiscal WHERE user_id = ?', [uid]))?.kind || null : null);
export const pjUsers = async () => (await q("SELECT user_id FROM user_fiscal WHERE kind = 'pj'")).map((r) => r.user_id);
