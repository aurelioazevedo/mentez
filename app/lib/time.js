// Datas no fuso de Goiânia (America/Sao_Paulo). O banco guarda o horário local "de parede".
const TZ = 'America/Sao_Paulo';
function parts(d = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return p;
}
export function nowLocal() {
  const p = parts();
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}
export const todayLocal = () => nowLocal().slice(0, 10);

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}
export function startOfWeek(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(ymd, dow === 0 ? -6 : 1 - dow);
}
export function addMinutes(dt, min) {
  const [date, time] = dt.split(' ');
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const x = new Date(Date.UTC(y, m - 1, d, hh, mm + min));
  return x.toISOString().slice(0, 19).replace('T', ' ');
}
export const isYmd = (s) => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
export const isYm = (s) => /^\d{4}-\d{2}$/.test(String(s || ''));
export const isHm = (s) => /^\d{2}:\d{2}$/.test(String(s || ''));
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const monthName = (ym) => `${MESES[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;
export function addMonths(ym, n) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export function longDate(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${d} de ${MESES[m - 1]} de ${y}`;
}

// Valor por extenso (recibos)
const U = ['', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const D = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const C = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];
function ate999(n) {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100), r = n % 100, out = [];
  if (c) out.push(C[c]);
  if (r < 20) { if (r) out.push(U[r]); } else { out.push(D[Math.floor(r / 10)] + (r % 10 ? ' e ' + U[r % 10] : '')); }
  return out.join(' e ');
}
function inteiro(n) {
  if (n === 0) return 'zero';
  const mil = Math.floor(n / 1000), resto = n % 1000, out = [];
  if (mil) out.push(mil === 1 ? 'mil' : `${ate999(mil)} mil`);
  if (resto) out.push((mil && (resto < 100 || resto % 100 === 0) ? 'e ' : '') + ate999(resto));
  return out.join(' ');
}
export function extenso(valor) {
  const v = Math.round(Number(valor) * 100);
  const reais = Math.floor(v / 100), cent = v % 100;
  const parts = [];
  if (reais) parts.push(`${inteiro(reais)} ${reais === 1 ? 'real' : 'reais'}`);
  if (cent) parts.push(`${inteiro(cent)} ${cent === 1 ? 'centavo' : 'centavos'}`);
  return parts.join(' e ') || 'zero reais';
}
