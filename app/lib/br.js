// Documentos e telefones brasileiros: validação e formatação (CPF, CNPJ e telefone com DDD).
export const digits = (v) => String(v ?? '').replace(/\D/g, '');
export function cpfValid(v) {
  const d = digits(v);
  if (d.length !== 11 || /^(\d)\1+$/.test(d)) return false;
  const dv = (n) => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
}
export function cnpjValid(v) {
  const d = digits(v);
  if (d.length !== 14 || /^(\d)\1+$/.test(d)) return false;
  const dv = (n) => { const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]; const s = w.reduce((a, x, i) => a + x * Number(d[i]), 0); const r = s % 11; return r < 2 ? 0 : 11 - r; };
  return dv(12) === Number(d[12]) && dv(13) === Number(d[13]);
}
export const cpfFmt = (v) => { const d = digits(v); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : String(v ?? ''); };
export const cnpjFmt = (v) => { const d = digits(v); return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : String(v ?? ''); };
export const docFmt = (v) => (digits(v).length === 14 ? cnpjFmt(v) : cpfFmt(v));
export const docValid = (v) => (digits(v).length === 14 ? cnpjValid(v) : cpfValid(v));
// Telefone: (62) 98333-1111 / (62) 3333-1111; com +55 na frente também; outros formatos ficam como digitados
export function phoneFmt(v) {
  const raw = String(v ?? '').trim(); let d = digits(raw);
  if (!d) return raw;
  if (raw.startsWith('+') && !raw.startsWith('+55')) return raw; // número de outro país
  if ((d.length === 12 || d.length === 13) && d.startsWith('55')) d = d.slice(2);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return raw;
}
