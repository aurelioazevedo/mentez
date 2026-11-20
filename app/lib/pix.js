// Pix “copia e cola” estático (BR Code, padrão EMV do Banco Central) — sem integração com banco.
// O pagador cola o código no app do banco; o valor e o recebedor já vêm preenchidos.

export const KEY_TYPES = { cpf: 'CPF', cnpj: 'CNPJ', telefone: 'Celular', email: 'E-mail', aleatoria: 'Chave aleatória' };

// Normaliza a chave conforme o tipo; devolve null se for inválida.
export function normalizeKey(type, key) {
  const k = String(key || '').trim();
  const d = k.replace(/\D/g, '');
  switch (type) {
    case 'cpf': return d.length === 11 ? d : null;
    case 'cnpj': return d.length === 14 ? d : null;
    case 'telefone': { const n = d.replace(/^55(?=\d{10,11}$)/, ''); return n.length === 10 || n.length === 11 ? `+55${n}` : null; }
    case 'email': return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k) && k.length <= 77 ? k.toLowerCase() : null;
    case 'aleatoria': return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k) ? k.toLowerCase() : null;
    default: return null;
  }
}

// Texto só com letras/números ASCII (o padrão não aceita acentos), cortado no tamanho máximo.
const ascii = (s, max) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 .\-]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const field = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

function crc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

// key já normalizada; amount em reais; txid até 25 caracteres alfanuméricos.
export function brcode({ key, name, city, amount, txid, description }) {
  const mai = field('00', 'br.gov.bcb.pix') + field('01', key) + (description ? field('02', ascii(description, 40)) : '');
  let p = field('00', '01')
    + field('26', mai)
    + field('52', '0000')
    + field('53', '986')
    + (amount ? field('54', Number(amount).toFixed(2)) : '')
    + field('58', 'BR')
    + field('59', ascii(name, 25) || 'RECEBEDOR')
    + field('60', ascii(city, 15) || 'GOIANIA')
    + field('62', field('05', (String(txid || '***').replace(/[^A-Za-z0-9]/g, '').slice(0, 25)) || '***'));
  p += '6304';
  return p + crc16(p);
}
export const _crc16 = crc16; // para testes
