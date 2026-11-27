// Marketing → Site: textos com IA (seções do site, posts do blog e título/descrição para o Google).
// Usa a mesma chave de IA dos documentos (da clínica ou do profissional). Segue as normas de publicidade da psicologia.
import * as D from './psydocs.js';
import * as Brand from './brand.js';
import { risks } from './mktai.js';

export const TONES = { acolhedor: 'acolhedor e caloroso', claro: 'claro e didático', sobrio: 'sóbrio e profissional', leve: 'leve e próximo' };
const RULES = `Regras obrigatórias (publicidade em psicologia, Código de Ética do CFP):
- Sem promessas de cura ou de resultado, sem sensacionalismo, sem autopromoção exagerada ("o melhor", "único").
- Sem depoimentos de pacientes, sem preços ou promoções, sem diagnósticos à distância.
- Não invente formação, títulos, especializações, números, endereços ou datas: use só o que for informado.
- Português do Brasil, natural e humano, frases curtas, sem clichês de marketing e sem jargão técnico desnecessário.
- Não use emojis.`;
const ctxLine = () => { const b = Brand.get(); return [b.who || b.name ? `Profissional/clínica: ${b.who || b.name}` : '', b.signLine ? `Registro: ${b.signLine}` : '', b.city ? `Cidade: ${b.city}${b.uf ? `/${b.uf}` : ''}` : ''].filter(Boolean).join('. '); };

async function run(system, user, userId, tag, effort = 'low') {
  const key = await D.aiKeyFor(await D.aiConfig(), userId);
  if (key.error) return { ok: false, error: `${key.error} (a IA do site usa a mesma chave da escrita de documentos).` };
  const r = await D.aiWrite(key, system, user, { effort });
  if (!r.ok) return r;
  await D.logUse(userId, key, tag, r.model, r.inTok, r.outTok, r.cost).catch(() => {});
  return r;
}

// Texto de um campo de seção (título curto ou texto em parágrafos)
export async function sectionText({ section, label, kind, current, about, tone, userId }) {
  const short = kind === 'text';
  const system = `Você escreve textos de sites de psicólogos e clínicas de psicologia no Brasil.
${ctxLine()}
Tom: ${TONES[tone] || TONES.acolhedor}.
${RULES}
${short ? 'Responda só com o texto pedido: uma frase curta (até 70 caracteres), sem aspas e sem ponto final se for título.' : 'Responda só com o texto pedido, em 1 a 3 parágrafos curtos separados por linha em branco (até 600 caracteres no total).'}`;
  const user = `Seção do site: ${section}. Campo: ${label}.${about ? `\nInformações do profissional para usar: ${String(about).slice(0, 1200)}` : ''}${current ? `\nTexto atual (melhore mantendo as informações verdadeiras): ${String(current).slice(0, 1500)}` : ''}`;
  const r = await run(system, user, userId, 'site-secao');
  if (!r.ok) return r;
  const text = r.text.trim().replace(/^["“]|["”]$/g, '').slice(0, short ? 200 : 3000);
  return { ok: true, text, risks: risks(text).filter((x) => !/assunto de saúde/.test(x)) };
}

// Post completo do blog a partir de um tema
export async function blogPost({ topic, audience, tone, userId }) {
  const system = `Você escreve artigos para o blog de um consultório de psicologia no Brasil, para pessoas leigas que procuram informação confiável.
${ctxLine()}
Tom: ${TONES[tone] || TONES.claro}.
${RULES}
- Informação geral e educativa, sem substituir atendimento; quando fizer sentido, convide com delicadeza a buscar acompanhamento profissional.
- Em situação de crise, oriente o CVV (188) ou o SAMU (192).
Formato da resposta: só um JSON válido, sem nada antes ou depois, com as chaves:
{"titulo": "até 70 caracteres", "resumo": "1 a 2 frases, até 220 caracteres", "descricao_google": "até 155 caracteres", "texto": "artigo de 600 a 900 palavras em Markdown simples: parágrafos, subtítulos com ##, listas com - e negrito com **"}`;
  const user = `Tema do artigo: ${String(topic).slice(0, 300)}${audience ? `\nPúblico: ${String(audience).slice(0, 200)}` : ''}`;
  const r = await run(system, user, userId, 'site-blog', 'medium');
  if (!r.ok) return r;
  let j = null;
  try { j = JSON.parse(r.text.slice(r.text.indexOf('{'), r.text.lastIndexOf('}') + 1)); } catch { /* resposta fora do formato */ }
  if (!j?.texto) return { ok: false, error: 'A IA não devolveu o artigo no formato esperado. Tente de novo.' };
  const out = { title: String(j.titulo || topic).slice(0, 140), excerpt: String(j.resumo || '').slice(0, 300), seo: String(j.descricao_google || '').slice(0, 170), body: String(j.texto).slice(0, 30000) };
  return { ok: true, ...out, risks: risks(`${out.title} ${out.body}`).filter((x) => !/assunto de saúde/.test(x)) };
}
