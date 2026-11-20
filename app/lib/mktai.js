// Marketing: textos de mensagens de relacionamento (aniversário, convite de retorno) gerados por IA,
// com as variáveis do sistema preservadas e um aviso do que as normas da psicologia não permitem.
import * as D from './psydocs.js';

export const KINDS = {
  aniversario: { label: 'mensagem de aniversário', need: ['{nome}'], vars: '{nome} (primeiro nome do paciente) e {clinica} (nome do consultório)',
    goal: 'parabenizar o paciente pelo aniversário, com carinho e sem exageros' },
  reativacao: { label: 'convite para retomar o acompanhamento', need: ['{nome}', '{link}'], vars: '{nome} (primeiro nome), {clinica} (nome do consultório) e {link} (endereço para escolher um horário)',
    goal: 'convidar com delicadeza quem está há algum tempo sem sessões a retomar o acompanhamento, deixando claro que a escolha é da pessoa e sem pressão' },
};
export const TONES = { acolhedor: 'acolhedor e caloroso', leve: 'leve e descontraído', sobrio: 'sóbrio e profissional', breve: 'bem curto e direto' };

// Avisos do que a publicidade em psicologia não permite (e do que não deve ir numa mensagem que outras pessoas podem ler)
const RISKS = [
  [/\bcur(a|ar|ado)\b|garant|resultado(s)? (certo|garantido)/i, 'promessa de cura ou de resultado'],
  [/desconto|promo[cç]|gr[aá]tis|R\$\s?\d|pre[cç]o/i, 'preço ou promoção'],
  [/depoimento|avalia[cç]/i, 'pedido de depoimento ou avaliação'],
  [/ansiedade|depress|diagn[oó]st|transtorno|terapia de casal|luto|crise/i, 'assunto de saúde (a mensagem pode ser lida por outras pessoas)'],
];
export function risks(text) { return RISKS.filter(([re]) => re.test(text)).map(([, label]) => label); }

const SYSTEM = (k, tone) => `Você escreve mensagens de relacionamento de um consultório de psicologia no Brasil, enviadas pelo WhatsApp ou por e-mail aos pacientes.
Objetivo: ${k.goal}.
Tom: ${TONES[tone] || TONES.acolhedor}. Português do Brasil, natural, humano, sem clichês de marketing.
Regras obrigatórias:
- Use exatamente as variáveis ${k.vars}, escritas entre chaves como estão. ${k.need.map((v) => `A variável ${v} é obrigatória.`).join(' ')}
- No máximo 320 caracteres por mensagem (sem contar as variáveis). No máximo 1 emoji.
- Não mencione saúde, diagnóstico, sintomas, sofrimento nem o motivo do atendimento: outras pessoas podem ler a mensagem no celular do paciente.
- Siga as normas de publicidade da psicologia: sem promessas de resultado ou de cura, sem preços, descontos ou promoções, sem pedir depoimentos ou avaliações, sem sensacionalismo.
- Não assine com nome de pessoa e não invente informações (endereço, telefone, datas).
Escreva 3 versões diferentes entre si. Responda só com as 3 mensagens, separadas por uma linha contendo apenas ---.`;

export async function generate({ kind, tone, current, userId }) {
  const k = KINDS[kind];
  if (!k) return { ok: false, error: 'Tipo de mensagem inválido.' };
  const key = await D.aiKeyFor(await D.aiConfig(), userId);
  if (key.error) return { ok: false, error: key.error };
  const user = `Escreva a ${k.label}.${current ? `\nMensagem atual, para referência (pode melhorar ou variar): ${String(current).slice(0, 900)}` : ''}`;
  const r = await D.aiWrite(key, SYSTEM(k, tone), user, { effort: 'low' });
  if (!r.ok) return r;
  await D.logUse(userId, key, `mkt-${kind}`, r.model, r.inTok, r.outTok, r.cost).catch(() => {});
  const options = r.text.split(/\n\s*-{3,}\s*\n/).map((t) => t.replace(/^\s*(vers[aã]o\s*\d+[:.)-]?|\d+[.)-])\s*/i, '').trim()).filter(Boolean).slice(0, 3)
    .map((t) => {
      let text = t;
      if (k.need.includes('{nome}') && !text.includes('{nome}')) text = `Olá, {nome}! ${text}`; // a IA esqueceu uma variável obrigatória
      if (k.need.includes('{link}') && !text.includes('{link}')) text = `${text} {link}`;
      return { text: text.slice(0, 900), risks: risks(text) };
    });
  if (!options.length) return { ok: false, error: 'A IA não devolveu mensagens. Tente de novo.' };
  return { ok: true, options };
}
