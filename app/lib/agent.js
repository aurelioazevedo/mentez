// Atendente virtual do consultório no WhatsApp (Claude via API oficial da Anthropic).
// O agente conversa, informa, vende os e-books e — somente pelas ferramentas abaixo,
// validadas no banco — consulta horários, agenda, remarca e cancela sessões, ou
// transfere para atendimento humano. Nunca faz orientação clínica.
import * as Brand from './brand.js';
import * as Tenancy from './tenancy.js';
import Anthropic from '@anthropic-ai/sdk';
import { q, one, getSetting, setSetting } from './db.js';
import { encrypt, decrypt } from './crypto.js';
import { nowLocal, todayLocal, addDays, addMinutes, isYmd, isHm } from './time.js';
import { brDate, weekday } from './html.js';
import * as SC from './schedule.js';
import * as WA from './whatsapp.js';
import { notify } from './push.js';
import { syncLater } from './google.js';
import * as G from './google.js';
import * as CRM from './crm.js';
import { proName } from './perm.js';
import * as Live from './live.js';
import * as Waitlist from './waitlist.js';
import * as AP from './aiproviders.js';
import * as Slot from './aislot.js';

// Modelos do Claude oferecidos na configuração (preço por milhão de tokens, US$).
// O Haiku é o padrão: ~40× mais barato que o Opus e suficiente para atendimento e agenda.
// O Haiku 5.5 não tem a reserva automática da Anthropic para recusas (“fallbacks”); recusa → transfere para humano.
export const MODELS = {
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5 — mais barato (recomendado)', in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125, fallbacks: false },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5 — intermediário', in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5, fallbacks: true },
  'claude-opus-5-5': { label: 'Claude Opus 5.5 — mais capaz e mais caro', in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5, fallbacks: true },
};
export const MODEL = 'claude-haiku-5-5';
export const modelOf = (c) => (MODELS[c?.model] ? c.model : MODEL);

// ---------- configuração ----------
const DEFAULTS = {
  enabled: false, answerNew: true, canBook: true, canReschedule: true, canCancel: true,
  assistantName: 'Assistente virtual do consultório', defaultProfessional: null,
  duration: 40, slotStep: 60, minLeadHours: 3, cancelMinHours: 24, horizonDays: 30, pauseHours: 12,
  notifyProWhatsApp: true, clinicInfo: '', primary: 'claude', altProvider: 'groq', altBaseUrl: '',
  relayOn: false, relayOps: [],
};
const S = Tenancy.scoped({ cache: null }); // caches com um valor por clínica
export async function config() {
  if (S.cache && S.cache.at > Date.now() - 30e3) return S.cache.v;
  const raw = await getSetting('agent_config');
  let c = { ...DEFAULTS };
  let o = {};
  if (raw) { try { o = JSON.parse(raw); c = { ...c, ...o, apiKey: o.key_enc ? decrypt(o.key_enc) : '', groqKey: o.groq_key_enc ? decrypt(o.groq_key_enc) : '' }; } catch { /* usa padrão */ } }
  // Provedor principal (ai1) e secundário (ai2), cada um com qualquer provedor. Configurações antigas
  // (Claude + “outro provedor” como reserva ou principal) viram as duas vagas automaticamente.
  let ai1 = Slot.read(o.ai1); let ai2 = Slot.read(o.ai2);
  if (!ai1) {
    const claude = { provider: 'anthropic', model: modelOf(c), baseUrl: '', key: c.apiKey || '', on: true };
    const alt = { provider: c.altProvider || 'groq', model: c.groqModel || '', baseUrl: c.altBaseUrl || '', key: c.groqKey || '', on: !!c.groqEnabled };
    if (c.primary === 'alt' && alt.key) { ai1 = { ...alt, on: true }; ai2 = { ...claude, on: !!claude.key }; } else { ai1 = claude; ai2 = alt; }
  }
  c.ai1 = ai1; c.ai2 = ai2;
  // visões antigas, usadas por outras partes (chave da clínica na escrita com IA, transcrição)
  const anth = [ai1, ai2].find((x) => x?.provider === 'anthropic' && x.key);
  const alt = [ai1, ai2].find((x) => x && x.provider !== 'anthropic' && x.key);
  c.apiKey = anth?.key || ''; if (anth) c.model = anth.model;
  c.groqKey = alt?.key || ''; c.altProvider = alt?.provider || 'groq'; c.groqModel = alt?.model || ''; c.altBaseUrl = alt?.baseUrl || ''; c.groqEnabled = !!alt?.on;
  S.cache = { at: Date.now(), v: c };
  return c;
}
export async function saveConfig(patch) {
  const cur = await config();
  const next = { ...cur, ...patch };
  next.ai1 = Slot.store(next.ai1); next.ai2 = Slot.store(next.ai2);
  // as chaves passam a ficar só nas vagas
  for (const k of ['apiKey', 'groqKey', 'key_enc', 'groq_key_enc', 'groqEnabled', 'groqModel', 'altProvider', 'altBaseUrl', 'primary']) delete next[k];
  await setSetting('agent_config', JSON.stringify(next));
  S.cache = null;
  return config();
}
// Chave da clínica para um provedor (de qualquer uma das vagas)
export const keyForProvider = (c, provider) => [c?.ai1, c?.ai2].find((x) => x?.provider === provider && x.key) || null;
// A vaga pode responder agora? (Claude suspenso por créditos/chave fica de fora até reativar)
export const slotOk = (c, x) => Slot.ready(x) && !(x.provider === 'anthropic' && c?.suspended);
// Ordem de tentativa: principal e, se ativado, o secundário
export const order = (c) => [c?.ai1, c?.ai2?.on ? c.ai2 : null].filter((x) => x && slotOk(c, x));
export const primaryReady = (c) => !!c && slotOk(c, c.ai1);
export const secondaryReady = (c) => !!(c && c.ai2?.on && slotOk(c, c.ai2));
// nomes antigos (telas e alertas): “Claude” = principal; “reserva” = secundário
export const claudeReady = primaryReady;
export const groqReady = secondaryReady;
export const altLabel = (c) => Slot.labelOf(c?.ai2?.provider);
export const altPrimary = () => false;
export const ready = (c) => !!(c && c.enabled && order(c).length);

// Traduz erros da API da Anthropic. “account” = problema da conta (créditos, chave): suspende o atendente.
export function classifyError(e) {
  const msg = String(e?.message || '');
  if (e instanceof Anthropic.AuthenticationError) return { account: true, reason: 'Chave da API da Anthropic inválida ou revogada' };
  if (e instanceof Anthropic.PermissionDeniedError) return { account: true, reason: 'A chave da API da Anthropic não tem permissão para este modelo' };
  if (/credit balance|billing|purchase credits/i.test(msg)) return { account: true, reason: 'Sem créditos na conta da Anthropic' };
  if (e instanceof Anthropic.RateLimitError) return { account: false, reason: 'Limite de uso da Anthropic atingido no momento' };
  if (e instanceof Anthropic.APIConnectionError || (e?.status >= 500)) return { account: false, reason: 'Serviço da Anthropic indisponível no momento' };
  return { account: false, reason: `Falha do atendente virtual (${e?.status || 'erro'})` };
}

// Suspende o Claude por problema na conta (créditos/chave) e avisa a administradora uma vez.
async function suspendClaude(reason) {
  const c = await config();
  if (c.suspended) return;
  await saveConfig({ suspended: { reason, at: nowLocal() } });
  if (/créditos/.test(reason)) await markExhausted();
  const admins = (await q("SELECT id FROM users WHERE active = 1 AND role = 'admin'")).map((u) => u.id);
  const other = [c.ai1, c.ai2?.on ? c.ai2 : null].find((x) => x && x.provider !== 'anthropic' && Slot.ready(x));
  notify(admins, { title: other ? `🔁 Atendente usando ${Slot.labelOf(other.provider)}` : '⛔ Atendente virtual suspenso', body: `${reason}. ${other ? `As respostas seguem por ${Slot.labelOf(other.provider)} até você reativar o Claude.` : 'Resolva e clique em “Reativar” em Configurações → Atendente virtual.'}`, url: '/configuracoes/agente', tag: 'agent-suspended' });
}

// ---------- custo e saldo da conta da Anthropic ----------
// Preços por milhão de tokens (US$). Escrita de cache de 5 min = 1,25 × entrada.
export function costOf(model, u) {
  const p = MODELS[String(model || '').replace(/^anthropic\./, '')] || MODELS['claude-opus-5-5']; // desconhecido: estima pelo mais caro
  return ((u?.input_tokens || 0) * p.in + (u?.cache_read_input_tokens || 0) * p.cacheRead + (u?.cache_creation_input_tokens || 0) * p.cacheWrite + (u?.output_tokens || 0) * p.out) / 1e6;
}
async function recordUsage(convId, res) {
  try {
    const u = res.usage || {};
    await q('INSERT INTO agent_usage (conversation_id, model, input_tokens, cache_read_tokens, cache_write_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,?,?,?)',
      [convId, String(res.model || MODEL).slice(0, 60), u.input_tokens || 0, u.cache_read_input_tokens || 0, u.cache_creation_input_tokens || 0, u.output_tokens || 0, costOf(res.model || MODEL, u)]);
    await checkLowBalance();
  } catch (e) { console.error('agent usage', e.message); }
}

// O saldo real só aparece no console da Anthropic (não há API de saldo). A administradora informa o saldo
// atual; o sistema desconta o gasto medido em cada resposta a partir daí.
export async function balance() {
  const raw = await getSetting('agent_balance');
  const b = raw ? JSON.parse(raw) : {};
  const since = b.at || '1970-01-01 00:00:00';
  const [spent, month, d30] = await Promise.all([
    one('SELECT COALESCE(SUM(cost_usd),0) s FROM agent_usage WHERE created_at >= ?', [since]),
    one("SELECT COALESCE(SUM(cost_usd),0) s FROM agent_usage WHERE created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')"),
    one('SELECT COALESCE(SUM(cost_usd),0) s, COUNT(*) n FROM agent_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)'),
  ]);
  const known = b.usd !== undefined && b.usd !== null;
  return {
    known, informed: known ? Number(b.usd) : null, informedAt: b.at || null, informedBy: b.by || null,
    spentSince: Number(spent.s), estimated: known ? Math.max(0, Number(b.usd) - Number(spent.s)) : null,
    spentMonth: Number(month.s), spent30: Number(d30.s), calls30: Number(d30.n),
    alertUsd: b.alertUsd !== undefined ? Number(b.alertUsd) : 2, exhausted: !!b.exhausted,
  };
}
export async function setBalance(usd, byName, alertUsd) {
  const raw = await getSetting('agent_balance');
  const cur = raw ? JSON.parse(raw) : {};
  await setSetting('agent_balance', JSON.stringify({ ...cur, usd: Math.round(Number(usd) * 100) / 100, at: nowLocal(), by: byName, exhausted: false, alerted: false, ...(alertUsd !== undefined ? { alertUsd } : {}) }));
}
async function markExhausted() {
  const raw = await getSetting('agent_balance');
  const cur = raw ? JSON.parse(raw) : {};
  await setSetting('agent_balance', JSON.stringify({ ...cur, usd: 0, at: nowLocal(), by: 'sistema (Anthropic informou falta de créditos)', exhausted: true, alerted: true }));
}
async function checkLowBalance() {
  const b = await balance();
  if (!b.known || b.estimated > b.alertUsd) return;
  const raw = JSON.parse((await getSetting('agent_balance')) || '{}');
  if (raw.alerted) return;
  await setSetting('agent_balance', JSON.stringify({ ...raw, alerted: true }));
  const admins = (await q("SELECT id FROM users WHERE active = 1 AND role = 'admin'")).map((u) => u.id);
  notify(admins, { title: '💳 Saldo da IA acabando', body: `Restam cerca de US$ ${b.estimated.toFixed(2)} na conta da Anthropic. Adicione saldo para o atendente não parar.`, url: '/configuracoes/agente#saldo', tag: 'agent-balance' });
}

// ---------- conhecimento fixo (entra no prompt; fica em cache) ----------
const EBOOKS = [
  ['Respire, você não está sozinho(a) — guia prático da TCC para a ansiedade', 'R$ 27,90', 'https://pay.hotmart.com/S108396449T', 'https://lorrainymendes.com.br/ebook-ansiedade/'],
  ['Florescer, um passo de cada vez — guia prático da TCC para a depressão', 'R$ 27,90', 'https://pay.hotmart.com/A108409954O', 'https://lorrainymendes.com.br/ebook-depressao/'],
  ['Recomeçar, voltando para você — superar o fim de um relacionamento e a dependência emocional', 'R$ 27,90', 'https://pay.hotmart.com/Y108410263M', 'https://lorrainymendes.com.br/ebook-relacionamento/'],
  ['Organizar, no ritmo da sua mente — guia prático da TCC para adultos com TDAH', 'R$ 27,90', 'https://pay.hotmart.com/V108410356N', 'https://lorrainymendes.com.br/ebook-tdah/'],
  ['Equilibrar, entre altos e baixos — guia prático da TCC para o transtorno bipolar', 'R$ 27,90', 'https://pay.hotmart.com/P108410449V', 'https://lorrainymendes.com.br/ebook-bipolar/'],
  ['Pack com os 5 e-books', 'R$ 97,00 (em vez de R$ 139,50 — economia de R$ 42,50)', 'https://pay.hotmart.com/F108410945Q', 'https://lorrainymendes.com.br/ebooks/'],
];

// Apresentação e dados fixos do consultório: os da Dra. Lorrainy no sistema dela; na Mentez, os da ficha de identidade
// (o restante vem de “Informações definidas pelo consultório”, editável em Configurações → Atendente virtual).
function aboutClinic(b) {
  if (b.legacy) return `- Psicoterapia com a Terapia Cognitivo-Comportamental (TCC), para adultos.
- Sessões de 40 minutos, on-line (por videochamada) ou presenciais em Goiânia (GO).
- Formação: Psicologia pelo IPOG; especialização em TCC pelo IPOG em andamento.
- Site: https://lorrainymendes.com.br · Instagram: @psilorrainymendes`;
  return [b.place ? `- Atendimento on-line (por videochamada) e presencial em ${b.place}.` : '- Atendimento on-line (por videochamada) e presencial.',
    b.siteUrl || b.instagram ? `- ${[b.siteUrl && `Site: ${b.siteUrl}`, b.instagram && `Instagram: ${b.instagram}`].filter(Boolean).join(' · ')}` : ''].filter(Boolean).join('\n');
}
function systemPrompt(c) {
  const b = Brand.get();
  const who = b.legacy ? 'do consultório da Dra. Lorrainy Mendes, psicóloga (CRP 09/23862)' : `de ${b.name}${b.proName ? ` (${b.proName}${b.crp ? `, CRP ${b.crp}` : ''})` : ''}`;
  return `Você é ${c.assistantName}, atendente virtual no WhatsApp ${who}. Você conversa com pacientes e com pessoas interessadas em atendimento${b.legacy ? ' ou nos e-books' : ''}.

## Sobre o consultório
${aboutClinic(b)}
- Todas as dúvidas são tiradas aqui mesmo, pelo WhatsApp. Nunca peça para a pessoa mandar e-mail nem procurar outro canal; se você não souber responder, use transferir_para_humano para a equipe continuar por aqui.
${c.clinicInfo ? `\n## Informações definidas pelo consultório (use-as como fonte oficial)\n${c.clinicInfo}\n` : ''}
${b.legacy ? `## E-books (vendidos pela Hotmart, acesso imediato após a compra)
${EBOOKS.map(([t, p, pay, page]) => `- ${t}: ${p}. Compra: ${pay} · Página: ${page}`).join('\n')}
Os e-books são materiais psicoeducativos de apoio; não substituem psicoterapia.
` : ''}
## O que você faz
1. Responde dúvidas sobre o atendimento, modalidades e horários${b.legacy ? ', a TCC e os e-books' : ''}.
2. Agenda, remarca e cancela sessões — sempre usando as ferramentas. Nunca diga que agendou, remarcou ou cancelou sem a ferramenta ter confirmado o sucesso.
3. ${b.legacy ? '' : 'Para quem busca atendimento, conduza com naturalidade ao agendamento da primeira sessão. '}${b.legacy ? 'Vende quando fizer sentido: se a pessoa demonstra interesse em comprar, em um tema (ansiedade, depressão, término de relacionamento, TDAH, bipolaridade) ou pede material, apresente o e-book adequado com o preço e o link de compra; mencione o pack quando houver interesse em mais de um. Para quem busca atendimento, conduza com naturalidade ao agendamento da primeira sessão. Seja acolhedor(a), nunca insistente: uma oferta clara por vez, sem pressão, sem urgência falsa.' : 'Seja acolhedor(a), nunca insistente: uma oferta clara por vez, sem pressão, sem urgência falsa.'}

## Como agendar
- Use consultar_horarios para obter horários livres e ofereça de 2 a 4 opções concretas (dia da semana, data e hora). Nunca invente horários.
- Antes de agendar, confirme com a pessoa: data, hora e modalidade (on-line ou presencial). Para quem ainda não é paciente, peça também o nome completo.
- Agendar para outra pessoa (cônjuge, familiar, amigo) é permitido: use agendar_para_outra_pessoa. Peça o nome completo de quem será atendido(a), a relação com o contato e, se possível, o WhatsApp da pessoa (para os lembretes; se ela não tiver ou o contato preferir, os lembretes vão para o contato). Confirme data, hora e modalidade antes de agendar. O atendimento é para adultos: se a sessão for para alguém com menos de 18 anos, use transferir_para_humano.
- Para remarcar ou cancelar, use listar_minhas_sessoes para identificar a sessão certa e confirme com a pessoa antes de executar.
- Se uma ferramenta recusar (prazo, horário ocupado, fora da escala), explique de forma simples e ofereça alternativas.
${c.waitlistOn ? `- Lista de espera: se nenhum horário livre servir para a pessoa (ou ela quiser um horário mais cedo do que o já marcado), ofereça entrar na lista de espera com entrar_lista_espera. Pergunte antes os dias da semana e os períodos que servem (manhã, tarde, noite) e, se ela já tem sessão marcada, se quer antecipá-la. Explique que, quando abrir uma vaga compatível, ela recebe a oferta aqui pelo WhatsApp e confirma respondendo SIM.
- Se o "Contexto atual" trouxer uma OFERTA DA LISTA DE ESPERA, a mensagem da pessoa provavelmente responde a essa oferta: use responder_oferta_vaga (aceitar ou recusar) conforme o que ela disser; na dúvida, pergunte se ela quer ficar com o horário.
` : ''}- Valores de sessão e formas de pagamento: informe apenas o que estiver em "Informações definidas pelo consultório". Se não houver, diga que a psicóloga informa diretamente e transfira para humano se a pessoa quiser saber agora.

## Limites (obrigatórios)
- Você não é psicóloga e não faz atendimento psicológico: não dê orientação clínica, diagnóstico, opinião sobre medicação nem "dicas terapêuticas" para o caso da pessoa. Acolha em uma frase e ofereça o agendamento com a psicóloga.
- Não prometa resultados nem cura. Não use depoimentos. Não fale de outros pacientes nem confirme se alguém é paciente.
- Trate só das sessões do próprio contato e das que ele agendou para outras pessoas (listar_minhas_sessoes mostra as duas). Nunca revele dados de outros pacientes.
- Se perceberem que é um atendente virtual, confirme com tranquilidade; se a pessoa pedir para falar com uma pessoa, use transferir_para_humano.
- RISCO: se houver qualquer sinal de risco à vida (ideação suicida, autolesão, violência, crise grave), responda com acolhimento, oriente a ligar agora para o CVV 188 (24h, gratuito) ou SAMU 192, ou ir ao pronto-socorro mais próximo; em situação de violência contra a mulher, Ligue 180. Em seguida use transferir_para_humano com urgente = true.
- Transfira também para humano: reclamações, questões financeiras específicas, pedidos de documentos/relatórios/laudos, assuntos fora do seu escopo, ou quando você não tiver certeza.
- Mensagens de áudio, imagem ou arquivo: diga que por aqui você só consegue ler texto e peça para escrever.

## Estilo
- Português do Brasil, caloroso, respeitoso e objetivo, como numa conversa de WhatsApp: mensagens curtas (até ~5 linhas), sem listas longas, no máximo um emoji quando combinar.
- Use *asteriscos* para negrito (formato do WhatsApp). Não use títulos nem Markdown de links: escreva o link puro.
- Trate a pessoa pelo primeiro nome quando souber.
- Ao falar de qualquer psicólogo(a) do consultório, use sempre o tratamento Dr. ou Dra. antes do nome, exatamente como aparece nas ferramentas e no contexto (ex.: “${b.proName || 'Dra. Ana Souza'}”). Nunca chame um(a) psicólogo(a) só pelo nome.
- O bloco "Contexto atual" enviado pelo sistema traz data, hora, quem é o contato e as sessões dele: use-o, mas nunca o copie para a pessoa.`;
}

const STR = { type: 'string' };
const TOOLS = [
  {
    name: 'consultar_horarios',
    description: 'Lista horários livres para sessão de acordo com a escala do(a) profissional, bloqueios e agenda. Use antes de oferecer horários.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        data_inicial: { type: 'string', description: 'Data inicial no formato AAAA-MM-DD.' },
        dias: { type: 'integer', description: 'Quantos dias a partir da data inicial (1 a 14).' },
        periodo: { type: 'string', enum: ['manha', 'tarde', 'noite', 'qualquer'] },
        profissional_id: { type: ['integer', 'null'], description: 'ID do profissional; null para o responsável pelo contato.' },
      },
      required: ['data_inicial', 'dias', 'periodo', 'profissional_id'],
    },
  },
  {
    name: 'listar_minhas_sessoes',
    description: 'Lista as próximas sessões do contato atual e das pessoas para quem ele agendou (com o ID de cada uma e o nome do paciente).',
    strict: true,
    input_schema: { type: 'object', additionalProperties: false, properties: {}, required: [] },
  },
  {
    name: 'agendar_sessao',
    description: 'Agenda uma sessão para o próprio contato (quem está conversando) em um horário livre. Só use depois de a pessoa confirmar data, hora e modalidade. Para outra pessoa, use agendar_para_outra_pessoa.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        data: { type: 'string', description: 'AAAA-MM-DD' },
        hora: { type: 'string', description: 'HH:MM (24h)' },
        modalidade: { type: 'string', enum: ['online', 'presencial'] },
        nome_completo: { type: ['string', 'null'], description: 'Obrigatório se o contato ainda não for paciente; senão null.' },
        profissional_id: { type: ['integer', 'null'] },
      },
      required: ['data', 'hora', 'modalidade', 'nome_completo', 'profissional_id'],
    },
  },
  {
    name: 'agendar_para_outra_pessoa',
    description: 'Agenda uma sessão para outra pessoa (ex.: cônjuge, familiar), a pedido do contato atual. Só use depois de o contato confirmar data, hora, modalidade e o nome completo de quem será atendido(a).',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        data: { type: 'string', description: 'AAAA-MM-DD' },
        hora: { type: 'string', description: 'HH:MM (24h)' },
        modalidade: { type: 'string', enum: ['online', 'presencial'] },
        nome_completo_paciente: { type: 'string', description: 'Nome e sobrenome de quem será atendido(a).' },
        whatsapp_paciente: { type: ['string', 'null'], description: 'WhatsApp de quem será atendido(a), com DDD; null se não informado (os lembretes vão para o contato).' },
        relacao: { type: 'string', description: 'Relação com o contato, ex.: esposa, marido, mãe, filho, amiga.' },
        profissional_id: { type: ['integer', 'null'] },
      },
      required: ['data', 'hora', 'modalidade', 'nome_completo_paciente', 'whatsapp_paciente', 'relacao', 'profissional_id'],
    },
  },
  {
    name: 'remarcar_sessao',
    description: 'Muda a data/hora de uma sessão do contato atual (ou que ele agendou para outra pessoa). Só use depois de a pessoa confirmar o novo horário.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { sessao_id: { type: 'integer' }, nova_data: STR, nova_hora: STR },
      required: ['sessao_id', 'nova_data', 'nova_hora'],
    },
  },
  {
    name: 'cancelar_sessao',
    description: 'Cancela uma sessão do contato atual (ou que ele agendou para outra pessoa). Só use depois de a pessoa confirmar o cancelamento.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { sessao_id: { type: 'integer' }, motivo: STR },
      required: ['sessao_id', 'motivo'],
    },
  },
  {
    name: 'entrar_lista_espera',
    description: 'Coloca o contato (ou a sessão dele que ele quer antecipar) na lista de espera. Quando abrir um horário compatível, o sistema oferece a vaga pelo WhatsApp. Use depois de combinar os dias e períodos que servem.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: {
        dias_semana: { type: 'array', items: { type: 'integer', enum: [0, 1, 2, 3, 4, 5, 6] }, description: 'Dias que servem (0 = domingo, 1 = segunda … 6 = sábado). Lista vazia = qualquer dia.' },
        periodos: { type: 'array', items: { type: 'string', enum: ['manha', 'tarde', 'noite'] }, description: 'Períodos que servem. Lista vazia = qualquer horário.' },
        modalidade: { type: 'string', enum: ['qualquer', 'online', 'presencial'] },
        profissional_id: { type: ['integer', 'null'], description: 'Profissional desejado; null para o responsável pelo contato (ou qualquer um, se ainda não for paciente).' },
        antecipar_sessao_id: { type: ['integer', 'null'], description: 'ID da sessão já marcada que a pessoa quer antecipar (de listar_minhas_sessoes); null se for uma sessão nova.' },
        nome_completo: { type: ['string', 'null'], description: 'Obrigatório se o contato ainda não for paciente; senão null.' },
        observacao: { type: ['string', 'null'], description: 'Algo útil para a equipe, ex.: “prefere depois das 17h”.' },
      },
      required: ['dias_semana', 'periodos', 'modalidade', 'profissional_id', 'antecipar_sessao_id', 'nome_completo', 'observacao'],
    },
  },
  {
    name: 'responder_oferta_vaga',
    description: 'Registra a resposta do contato à oferta de horário da lista de espera (o oferta_id vem do Contexto atual). Aceitar agenda a sessão na hora.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { oferta_id: { type: 'integer' }, aceitar: { type: 'boolean' }, sair_da_lista: { type: 'boolean', description: 'true se a pessoa não quer mais esperar por vaga.' } },
      required: ['oferta_id', 'aceitar', 'sair_da_lista'],
    },
  },
  {
    name: 'transferir_para_humano',
    description: 'Encaminha a conversa para a equipe humana (a psicóloga ou a recepção) e pausa o atendimento virtual neste contato.',
    strict: true,
    input_schema: {
      type: 'object', additionalProperties: false,
      properties: { motivo: STR, urgente: { type: 'boolean' } },
      required: ['motivo', 'urgente'],
    },
  },
];

const WL_TOOLS = ['entrar_lista_espera', 'responder_oferta_vaga'];
const toolsFor = (c) => (c.waitlistOn ? TOOLS : TOOLS.filter((t) => !WL_TOOLS.includes(t.name)));

// ---------- utilidades de agenda ----------
const firstName = (s) => String(s || '').trim().split(/\s+/)[0];
// “maria da silva” → “Maria da Silva” (só quando veio tudo em minúsculas ou maiúsculas)
const LOWER = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
function properName(s) {
  const t = String(s || '').trim().replace(/\s+/g, ' ');
  if (t !== t.toLowerCase() && t !== t.toUpperCase()) return t;
  return t.toLowerCase().split(' ').map((w, i) => (i > 0 && LOWER.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
// Telefone do WhatsApp (ex.: 556281234567) → “(62) 98123-4567” (repõe o 9 dos celulares).
function fmtBR(phone) {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.startsWith('55') && d.length >= 12) d = d.slice(2);
  if (d.length === 10 && /[6-9]/.test(d[2])) d = `${d.slice(0, 2)}9${d.slice(2)}`;
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : phone;
}
const modsText = (m) => String(m || 'online,presencial').split(',').filter(Boolean).map((x) => (x === 'online' ? 'on-line' : 'presencial')).join(' e ');
async function professionals() {
  return (await q("SELECT id, name, title, phone, modalities FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, id")).map((u) => ({ ...u, display: proName(u) }));
}
// O profissional atende nesta modalidade? (null = sim; senão a orientação para o atendente)
async function modalityError(ownerId, mod) {
  const u = await one('SELECT name, title, modalities FROM users WHERE id = ?', [ownerId]);
  if (!u || String(u.modalities || 'online,presencial').split(',').includes(mod)) return null;
  return `${proName(u)} atende apenas ${modsText(u.modalities)}. Ofereça essa modalidade à pessoa.`;
}
async function resolvePro(c, conv, requested) {
  const pros = await professionals();
  if (requested && pros.some((p) => p.id === requested)) return requested;
  if (conv.patient_id) {
    const p = await one('SELECT owner_id FROM patients WHERE id = ?', [conv.patient_id]);
    if (p?.owner_id) return p.owner_id;
  }
  if (c.defaultProfessional && pros.some((p) => p.id === Number(c.defaultProfessional))) return Number(c.defaultProfessional);
  return pros[0]?.id || null;
}
async function conflict(ownerId, start, dur, ignoreId = 0) {
  const end = addMinutes(start, dur);
  return one(`SELECT a.id FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.status <> 'cancelada' AND a.id <> ? AND p.owner_id <=> ? AND a.starts_at < ? AND DATE_ADD(a.starts_at, INTERVAL a.duration_min MINUTE) > ?`, [ignoreId, ownerId, end, start]);
}
const hoursUntil = (dt) => (new Date(`${dt.replace(' ', 'T')}-03:00`) - Date.now()) / 3600e3;
async function validSlot(c, ownerId, start, dur, ignoreId = 0, busy = null) {
  if (hoursUntil(start) < c.minLeadHours) return `Precisa ser com pelo menos ${c.minLeadHours} horas de antecedência.`;
  if (start.slice(0, 10) > addDays(todayLocal(), c.horizonDays)) return `Só é possível agendar até ${c.horizonDays} dias à frente.`;
  const sched = await SC.getSchedule(ownerId);
  if (!sched.configured) return 'A escala de atendimento ainda não foi configurada; transfira para humano.';
  const chk = await SC.checkSlot(ownerId, start, dur, sched);
  if (!chk.ok) return chk.reason;
  if (await conflict(ownerId, start, dur, ignoreId)) return 'Esse horário já está ocupado.';
  // Compromissos pessoais na Google Agenda do(a) profissional também ocupam o horário.
  const blocks = busy || await G.busyBlocks(ownerId, `${start.slice(0, 10)} 00:00:00`, `${addDays(start.slice(0, 10), 1)} 00:00:00`);
  if (G.overlaps(blocks, start, dur)) return 'Esse horário já está ocupado na agenda do(a) profissional.';
  return null;
}

// Duração da sessão do profissional (grade da escala) ou a padrão do atendente
async function durOf(c, ownerId) { return SC.gridOf(await SC.getSchedule(ownerId), c.duration, c.slotStep).duration; }

// ---------- ferramentas ----------
async function runTool(name, input, ctx) {
  const { c, conv } = ctx;
  switch (name) {
    case 'consultar_horarios': {
      const owner = await resolvePro(c, conv, input.profissional_id);
      if (!owner) return { erro: 'Nenhum profissional disponível.' };
      const sched = await SC.getSchedule(owner);
      if (!sched.configured) return { erro: 'Escala não configurada para este profissional. Transfira para humano para agendar.' };
      const from = isYmd(input.data_inicial) && input.data_inicial > todayLocal() ? input.data_inicial : todayLocal();
      const days = Math.min(14, Math.max(1, Number(input.dias) || 7));
      const range = { manha: ['00:00', '12:00'], tarde: ['12:00', '18:00'], noite: ['18:00', '24:00'] }[input.periodo];
      const slots = [];
      const busy = await G.busyBlocks(owner, `${from} 00:00:00`, `${addDays(from, days)} 00:00:00`); // uma consulta ao Google para o período todo
      const g = SC.gridOf(sched, c.duration, c.slotStep); // grade do profissional (duração + intervalo) ou a padrão
      for (let i = 0; i < days && slots.length < 16; i++) {
        const d = addDays(from, i);
        if (d > addDays(todayLocal(), c.horizonDays)) break;
        const st = await SC.dayStatus(owner, d, sched);
        if (!st.works || st.unrestricted) continue;
        for (const t of SC.startsIn(st, d, g.duration, g.step)) {
          const hm = t.slice(11, 16);
          if (range && (hm < range[0] || hm >= range[1])) continue;
          if (await validSlot(c, owner, t, g.duration, 0, busy)) continue;
          slots.push(`${weekday(d)} ${brDate(d)} às ${hm} (data=${d}, hora=${hm})`);
          if (slots.length >= 16) break;
        }
      }
      const pro = await one('SELECT name, title FROM users WHERE id = ?', [owner]);
      pro.name = proName(pro);
      // Guarda os horários oferecidos: o contexto da próxima mensagem os traz de volta (para o Claude ou a Groq).
      if (slots.length && conv.id && !ctx.dryRun) await q('UPDATE agent_conversations SET last_slots = ? WHERE id = ?', [JSON.stringify(slots.slice(0, 8)), conv.id]);
      if (slots.length && ctx.dryRun) conv.last_slots = JSON.stringify(slots.slice(0, 8));
      return slots.length ? { profissional: pro.name, profissional_id: owner, duracao_min: g.duration, horarios_livres: slots }
        : { profissional: pro.name, horarios_livres: [], observacao: 'Nenhum horário livre no período. Tente outras datas ou outro período.' };
    }
    case 'listar_minhas_sessoes': {
      const ids = await managedPatients(conv);
      if (!ids.length) return { sessoes: [], observacao: 'Este contato ainda não é paciente nem agendou para outra pessoa.' };
      const rows = await q(`SELECT a.id, a.starts_at, a.modality, a.status, a.patient_id, p.name, p.social_name, u.name prof, u.title prof_title FROM appointments a JOIN patients p ON p.id = a.patient_id LEFT JOIN users u ON u.id = p.owner_id
        WHERE a.patient_id IN (?) AND a.starts_at >= NOW() AND a.status IN ('agendada','confirmada') ORDER BY a.starts_at LIMIT 15`, [ids]);
      return { sessoes: rows.map((a) => ({ sessao_id: a.id, paciente: a.patient_id === conv.patient_id ? 'o próprio contato' : a.social_name || a.name, quando: `${weekday(a.starts_at.slice(0, 10))} ${brDate(a.starts_at)} às ${a.starts_at.slice(11, 16)}`, modalidade: a.modality, situacao: a.status, profissional: a.prof ? proName({ name: a.prof, title: a.prof_title }) : null })) };
    }
    case 'agendar_para_outra_pessoa': {
      if (!c.canBook) return { ok: false, erro: 'Agendamento pelo atendente virtual está desativado. Transfira para humano.' };
      if (!c.answerNew) return { ok: false, erro: 'Novos pacientes não podem ser agendados por aqui. Transfira para humano.' };
      if (!isYmd(input.data) || !isHm(input.hora)) return { ok: false, erro: 'Data ou hora em formato inválido.' };
      const nome = properName(input.nome_completo_paciente);
      if (nome.split(' ').length < 2) return { ok: false, erro: 'Preciso do nome completo (nome e sobrenome) de quem será atendido(a).' };
      let whats = null;
      if (input.whatsapp_paciente) {
        whats = WA.normalizePhone(input.whatsapp_paciente);
        if (!whats) return { ok: false, erro: 'O WhatsApp informado parece incompleto. Peça o número com DDD (ou siga sem ele: os lembretes vão para o contato).' };
      }
      const ownKey = WA.phoneKey(conv.phone);
      if (whats && WA.phoneKey(whats) === ownKey) whats = null; // mesmo número do contato
      const relacao = String(input.relacao || '').trim().slice(0, 40);
      const requester = conv.patient_id ? await one('SELECT name, social_name FROM patients WHERE id = ?', [conv.patient_id]) : null;
      const requesterName = (requester?.social_name || requester?.name || conv.contact_name || '').slice(0, 160) || null;
      // Já cadastrado? (mesmo WhatsApp, ou mesmo nome entre as pessoas que este contato já agendou)
      const ids = await managedPatients(conv);
      let p = null;
      if (whats) {
        const all = await q("SELECT id, name, social_name, phone, owner_id FROM patients WHERE phone IS NOT NULL AND phone <> '' AND status <> 'inativo'");
        p = all.find((x) => WA.phoneKey(x.phone) === WA.phoneKey(whats) && x.name.toLowerCase() === nome.toLowerCase()) || null;
      }
      if (!p && ids.length) p = await one('SELECT id, name, social_name, phone, owner_id FROM patients WHERE id IN (?) AND id <> ? AND LOWER(name) = LOWER(?) LIMIT 1', [ids, conv.patient_id || 0, nome]);
      const owner = p?.owner_id || (await resolvePro(c, { ...conv, patient_id: null }, input.profissional_id));
      const modBad = await modalityError(owner, input.modalidade);
      if (modBad) return { ok: false, erro: modBad };
      const start = `${input.data} ${input.hora}:00`;
      const dur = await durOf(c, owner);
      const bad = await validSlot(c, owner, start, dur);
      if (bad) return { ok: false, erro: bad };
      const quando = `${weekday(input.data)} ${brDate(input.data)} às ${input.hora}`;
      const lembretes = whats ? 'no WhatsApp da pessoa atendida' : 'neste WhatsApp (do contato)';
      if (ctx.dryRun) return { ok: true, simulacao: true, sessao_id: 0, paciente: nome, quando, modalidade: input.modalidade, duracao_min: dur, lembretes };
      if (!p) {
        const ins = await q('INSERT INTO patients (owner_id, name, phone, modality, status, whatsapp_optin, responsible_name, responsible_phone, notes_enc) VALUES (?,?,?,?,?,1,?,?,?)',
          [owner, nome.slice(0, 160), fmtBR(whats || conv.phone), input.modalidade, 'ativo', requesterName, fmtBR(conv.phone),
            encrypt(`Cadastro criado pelo atendente virtual (WhatsApp) em ${brDate(todayLocal())}, a pedido de ${requesterName || 'contato'} — ${fmtBR(conv.phone)}${relacao ? ` (${relacao})` : ''}. ${whats ? '' : 'Telefone do cadastro é o de quem agendou. '}Completar dados e termo de consentimento com a própria pessoa atendida.`)]);
        p = { id: ins.insertId, name: nome, social_name: null, owner_id: owner };
      } else if (!ids.includes(p.id)) {
        await q('UPDATE patients SET responsible_name = COALESCE(responsible_name, ?), responsible_phone = COALESCE(responsible_phone, ?) WHERE id = ?', [requesterName, fmtBR(conv.phone), p.id]);
      }
      const ins = await q("INSERT INTO appointments (patient_id, starts_at, duration_min, modality, created_via) VALUES (?,?,?,?, 'agente')", [p.id, start, dur, input.modalidade]);
      afterChange(c, ins.insertId, owner, `📅 Atendente virtual agendou (a pedido de ${requesterName || fmtBR(conv.phone)}${relacao ? `, ${relacao}` : ''})`, p, start, true);
      // Quem será atendido(a) tem WhatsApp próprio: recebe a confirmação do agendamento.
      if (whats) WA.sendBookingToPatient([ins.insertId], null).catch(() => {});
      // CRM: o card é de quem está conversando; avança para “Agendado”.
      try { const card = await CRM.cardFor({ phone: conv.phone, name: conv.contact_name, patientId: conv.patient_id || null }); await CRM.autoMove(card, 'agendado', { reason: `agendou para ${relacao || 'outra pessoa'}` }); } catch (e) { console.error('crm', e.message); }
      return { ok: true, sessao_id: ins.insertId, paciente: p.social_name || p.name, quando, modalidade: input.modalidade, duracao_min: dur, lembretes };
    }
    case 'agendar_sessao': {
      if (ctx.dryRun) {
        const owner = await resolvePro(c, conv, input.profissional_id);
        const dur0 = await durOf(c, owner);
        const bad = (await modalityError(owner, input.modalidade)) || (isYmd(input.data) && isHm(input.hora) ? await validSlot(c, owner, `${input.data} ${input.hora}:00`, dur0) : 'Data ou hora em formato inválido.');
        return bad ? { ok: false, erro: bad } : { ok: true, simulacao: true, sessao_id: 0, quando: `${weekday(input.data)} ${brDate(input.data)} às ${input.hora}`, modalidade: input.modalidade, duracao_min: dur0 };
      }
      if (!c.canBook) return { ok: false, erro: 'Agendamento pelo atendente virtual está desativado. Transfira para humano.' };
      if (!isYmd(input.data) || !isHm(input.hora)) return { ok: false, erro: 'Data ou hora em formato inválido.' };
      let patientId = conv.patient_id;
      if (!patientId) {
        if (!c.answerNew) return { ok: false, erro: 'Novos contatos não podem agendar por aqui. Transfira para humano.' };
        const nome = properName(input.nome_completo);
        if (nome.split(/\s+/).length < 2) return { ok: false, erro: 'Preciso do nome completo da pessoa (nome e sobrenome) antes de agendar.' };
        const owner = await resolvePro(c, conv, input.profissional_id);
        const ins = await q('INSERT INTO patients (owner_id, name, phone, modality, status, whatsapp_optin, notes_enc) VALUES (?,?,?,?,?,1,?)',
          [owner, nome.slice(0, 160), fmtBR(conv.phone), input.modalidade, 'ativo', encrypt(`Cadastro criado pelo atendente virtual (WhatsApp) em ${brDate(todayLocal())}. Completar dados e termo de consentimento.`)]);
        patientId = ins.insertId;
        await q('UPDATE agent_conversations SET patient_id = ? WHERE id = ?', [patientId, conv.id]);
        conv.patient_id = patientId;
      }
      const p = await one('SELECT id, name, social_name, owner_id FROM patients WHERE id = ?', [patientId]);
      const owner = p.owner_id || (await resolvePro(c, conv, input.profissional_id));
      const modBad = await modalityError(owner, input.modalidade);
      if (modBad) return { ok: false, erro: modBad };
      const start = `${input.data} ${input.hora}:00`;
      const dur = await durOf(c, owner);
      const bad = await validSlot(c, owner, start, dur);
      if (bad) return { ok: false, erro: bad };
      const ins = await q("INSERT INTO appointments (patient_id, starts_at, duration_min, modality, created_via) VALUES (?,?,?,?, 'agente')", [p.id, start, dur, input.modalidade]);
      afterChange(c, ins.insertId, owner, '📅 Atendente virtual agendou', p, start, true);
      // Liga o card do CRM ao paciente (pode ter acabado de ser cadastrado) antes de mover a etapa.
      try { await CRM.cardFor({ phone: conv.phone, patientId: p.id }); } catch (e) { console.error('crm', e.message); }
      CRM.onAppointment(p.id);
      return { ok: true, sessao_id: ins.insertId, quando: `${weekday(input.data)} ${brDate(input.data)} às ${input.hora}`, modalidade: input.modalidade, duracao_min: dur };
    }
    case 'remarcar_sessao': {
      if (ctx.dryRun) return { ok: true, simulacao: true, sessao_id: input.sessao_id, novo_horario: `${input.nova_data} ${input.nova_hora}` };
      if (!c.canReschedule) return { ok: false, erro: 'Remarcação pelo atendente virtual está desativada. Transfira para humano.' };
      const a = await ownAppt(conv, input.sessao_id);
      if (!a) return { ok: false, erro: 'Sessão não encontrada entre as sessões deste contato.' };
      if (!isYmd(input.nova_data) || !isHm(input.nova_hora)) return { ok: false, erro: 'Data ou hora em formato inválido.' };
      if (hoursUntil(a.starts_at) < c.cancelMinHours) return { ok: false, erro: `A sessão é em menos de ${c.cancelMinHours} horas; remarcações em cima da hora são tratadas pela equipe. Transfira para humano.` };
      const start = `${input.nova_data} ${input.nova_hora}:00`;
      const bad = await validSlot(c, a.owner_id, start, a.duration_min, a.id);
      if (bad) return { ok: false, erro: bad };
      await q("UPDATE appointments SET starts_at = ?, status = 'agendada', wa_reminder_at = NULL, wa_reminder2_at = NULL, wa_reply = NULL, wa_reply_at = NULL, wa_reschedule_done = 1 WHERE id = ?", [start, a.id]);
      afterChange(c, a.id, a.owner_id, `↻ Atendente virtual remarcou (era ${brDate(a.starts_at).slice(0, 5)} ${a.starts_at.slice(11, 16)})`, a, start, true);
      Waitlist.slotFreed(a); // o horário antigo ficou livre: oferece à lista de espera
      return { ok: true, sessao_id: a.id, novo_horario: `${weekday(input.nova_data)} ${brDate(input.nova_data)} às ${input.nova_hora}` };
    }
    case 'cancelar_sessao': {
      if (ctx.dryRun) return { ok: true, simulacao: true, sessao_id: input.sessao_id, cancelada: true };
      if (!c.canCancel) return { ok: false, erro: 'Cancelamento pelo atendente virtual está desativado. Transfira para humano.' };
      const a = await ownAppt(conv, input.sessao_id);
      if (!a) return { ok: false, erro: 'Sessão não encontrada entre as sessões deste contato.' };
      if (hoursUntil(a.starts_at) < c.cancelMinHours) return { ok: false, erro: `A sessão é em menos de ${c.cancelMinHours} horas; cancelamentos em cima da hora são tratados pela equipe. Transfira para humano.` };
      await q("UPDATE appointments SET status = 'cancelada', wa_reschedule_done = 1 WHERE id = ?", [a.id]);
      await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['agente-cancelar', `appointment:${a.id} ${String(input.motivo || '').slice(0, 60)}`]);
      afterChange(c, a.id, a.owner_id, '✕ Atendente virtual cancelou', a, a.starts_at, false);
      Waitlist.slotFreed(a);
      return { ok: true, sessao_id: a.id, cancelada: true };
    }
    case 'entrar_lista_espera': {
      if (!c.waitlistOn) return { ok: false, erro: 'A lista de espera está desativada. Transfira para humano se a pessoa quiser aguardar uma vaga.' };
      const prefs = { weekdays: input.dias_semana || [], periods: input.periodos || [], modality: input.modalidade };
      let move = null;
      if (input.antecipar_sessao_id) {
        move = await ownAppt(conv, input.antecipar_sessao_id);
        if (!move) return { ok: false, erro: 'Sessão para antecipar não encontrada entre as sessões deste contato.' };
      }
      let nome = null;
      if (!conv.patient_id) {
        if (!c.answerNew) return { ok: false, erro: 'Novos contatos não entram na lista por aqui. Transfira para humano.' };
        nome = properName(input.nome_completo);
        if (nome.split(/\s+/).length < 2) return { ok: false, erro: 'Preciso do nome completo (nome e sobrenome) antes de colocar na lista.' };
      }
      const pros = await professionals();
      let owner = input.profissional_id && pros.some((p) => p.id === input.profissional_id) ? input.profissional_id : null;
      if (!owner && move) owner = move.owner_id;
      if (!owner && conv.patient_id) owner = (await one('SELECT owner_id FROM patients WHERE id = ?', [conv.patient_id]))?.owner_id || null;
      const resumo = Waitlist.prefsText({ weekdays: (prefs.weekdays.length === 7 ? [] : prefs.weekdays).join(','), periods: (prefs.periods.length === 3 ? [] : prefs.periods).join(','), modality: prefs.modality });
      if (ctx.dryRun) return { ok: true, simulacao: true, preferencias: resumo, antecipar: move ? true : false };
      const r = await Waitlist.add({ ...prefs, patient_id: conv.patient_id || null, name: nome, phone: fmtBR(conv.phone), owner_id: owner, move_appt_id: move?.id || null, notes: input.observacao ? `${input.observacao} (anotado pelo atendente virtual)` : 'Entrou pelo atendente virtual', via: 'agente' });
      try { await q('INSERT INTO audit_log (user_id, action, target) VALUES (NULL, ?, ?)', ['agente-lista-espera', `waitlist:${r.id}`]); } catch { /* registro opcional */ }
      Live.emit(['agenda']);
      return { ok: true, preferencias: resumo, ja_estava_na_lista: !!r.existed, observacao: 'Diga que a pessoa está na lista de espera e que, quando abrir um horário compatível, ela recebe a oferta aqui e confirma respondendo SIM.' };
    }
    case 'responder_oferta_vaga': {
      if (ctx.dryRun) return { ok: true, simulacao: true, aceita: input.aceitar };
      const o = await Waitlist.activeOfferFor(conv.phone);
      if (!o) return { ok: false, erro: 'Não há oferta da lista de espera em aberto para este contato.' };
      if (input.aceitar) {
        const r = await Waitlist.accept(o.id, 'agente');
        if (!r.ok) return { ok: false, erro: `${r.error} A pessoa continua na lista de espera; ofereça outros horários com consultar_horarios.` };
        return { ok: true, sessao_id: r.appointmentId, quando: r.when, antecipada: r.moved, observacao: 'Sessão agendada. A confirmação com os detalhes já foi enviada automaticamente em outra mensagem: responda de forma curta e acolhedora.' };
      }
      await Waitlist.decline(o.id, { leave: !!input.sair_da_lista });
      return { ok: true, recusada: true, saiu_da_lista: !!input.sair_da_lista };
    }
    case 'transferir_para_humano': {
      if (ctx.dryRun) { ctx.handoff = input; return { ok: true, simulacao: true, observacao: 'Conversa encaminhada (simulação).' }; }
      await q("UPDATE agent_conversations SET status = 'humano', human_reason = ?, human_until = DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE id = ?",
        [String(input.motivo || '').slice(0, 250), Number(c.pauseHours) || 12, conv.id]);
      const targets = new Set((await q("SELECT id FROM users WHERE active = 1 AND role IN ('admin','secretaria')")).map((u) => u.id));
      if (conv.patient_id) { const p = await one('SELECT owner_id FROM patients WHERE id = ?', [conv.patient_id]); if (p?.owner_id) targets.add(p.owner_id); }
      notify([...targets], { title: input.urgente ? '🚨 URGENTE — atendimento humano no WhatsApp' : '🙋 Atendimento humano solicitado', body: `${conv.contact_name || conv.phone}: ${String(input.motivo || '').slice(0, 120)}`, url: '/configuracoes/agente#conversas', tag: `conv-${conv.id}` });
      conv.status = 'humano';
      CRM.onHuman({ phone: conv.phone, reason: String(input.motivo || '').slice(0, 80) });
      import('./relay.js').then((R) => R.startHandoff(conv.id, input.motivo, !!input.urgente)).catch((e) => console.error('encaminhar ao atendimento:', e.message));
      return { ok: true, observacao: 'Conversa encaminhada. Diga à pessoa que a equipe vai responder por aqui assim que possível.' };
    }
    default:
      return { erro: `Ferramenta desconhecida: ${name}` };
  }
}

// Pacientes cujas sessões o contato pode ver e gerenciar: ele mesmo e quem ele agendou (mesmo WhatsApp ou responsável).
async function managedPatients(conv) {
  const key = WA.phoneKey(conv.phone);
  const ids = new Set(conv.patient_id ? [conv.patient_id] : []);
  if (key) {
    const rows = await q("SELECT id, phone, responsible_phone FROM patients WHERE status <> 'inativo' AND ((phone IS NOT NULL AND phone <> '') OR responsible_phone IS NOT NULL)");
    for (const r of rows) if (WA.phoneKey(r.phone) === key || WA.phoneKey(r.responsible_phone) === key) ids.add(r.id);
  }
  return [...ids];
}

async function ownAppt(conv, id) {
  const ids = await managedPatients(conv);
  if (!ids.length) return null;
  return one(`SELECT a.*, p.name, p.social_name, p.owner_id FROM appointments a JOIN patients p ON p.id = a.patient_id
    WHERE a.id = ? AND a.patient_id IN (?) AND a.status IN ('agendada','confirmada') AND a.starts_at > NOW()`, [Number(id), ids]);
}

// Depois de agendar/remarcar/cancelar: Google Agenda, push e aviso ao profissional.
export function afterChange(c, apptId, ownerId, title, p, start, sendPro) {
  Live.emit(['agenda', 'crm', 'pacientes']);
  syncLater(apptId);
  const n = String(p.social_name || p.name).trim().split(/\s+/);
  notify(ownerId, { title, body: `${n[0]}${n.length > 1 ? ` ${n[n.length - 1][0]}.` : ''} — ${weekday(start.slice(0, 10))} ${brDate(start).slice(0, 5)} às ${start.slice(11, 16)}`, url: `/agenda/${apptId}`, tag: `appt-${apptId}` });
  if (sendPro && c.notifyProWhatsApp) WA.sendBookingToProfessional([apptId], null).catch(() => {});
}

// ---------- contexto por turno (vai como mensagem de sistema, não no prompt fixo) ----------
async function contextMessage(c, conv, extra) {
  const now = nowLocal();
  const lines = [`Contexto atual (sistema): agora é ${weekday(now.slice(0, 10))}, ${brDate(now)} ${now.slice(11, 16)} (horário de Brasília).`];
  if (conv.patient_id) {
    const p = await one('SELECT name, social_name FROM patients WHERE id = ?', [conv.patient_id]);
    const next = await q("SELECT id, starts_at, modality, status FROM appointments WHERE patient_id = ? AND starts_at >= NOW() AND status IN ('agendada','confirmada') ORDER BY starts_at LIMIT 3", [conv.patient_id]);
    lines.push(`Contato: paciente cadastrado(a) — ${p.social_name || p.name} (primeiro nome: ${firstName(p.social_name || p.name)}).`);
    lines.push(next.length ? `Próximas sessões: ${next.map((a) => `#${a.id} ${weekday(a.starts_at.slice(0, 10))} ${brDate(a.starts_at)} ${a.starts_at.slice(11, 16)} (${a.modality}, ${a.status})`).join('; ')}.` : 'Sem sessões futuras agendadas.');
  } else {
    lines.push(`Contato: ainda não é paciente${conv.contact_name ? ` (nome no WhatsApp: ${conv.contact_name})` : ''}. ${c.answerNew && c.canBook ? 'Pode agendar a primeira sessão (peça o nome completo).' : 'Não agende; encaminhe para humano se quiser agendar.'}`);
  }
  const others = (await managedPatients(conv)).filter((id) => id !== conv.patient_id);
  if (others.length) {
    const rows = await q(`SELECT a.id, a.starts_at, a.modality, p.name, p.social_name FROM appointments a JOIN patients p ON p.id = a.patient_id
      WHERE a.patient_id IN (?) AND a.starts_at >= NOW() AND a.status IN ('agendada','confirmada') ORDER BY a.starts_at LIMIT 5`, [others]);
    if (rows.length) lines.push(`Sessões que este contato agendou para outras pessoas: ${rows.map((a) => `#${a.id} ${a.social_name || a.name} — ${weekday(a.starts_at.slice(0, 10))} ${brDate(a.starts_at)} ${a.starts_at.slice(11, 16)} (${a.modality})`).join('; ')}.`);
  }
  const pros = await professionals();
  if (pros.length > 1) lines.push(`Profissionais: ${pros.map((u) => `${u.display} (id ${u.id}; atende ${modsText(u.modalities)})`).join('; ')}.`);
  else if (pros.length === 1 && String(pros[0].modalities || '').split(',').filter(Boolean).length === 1) lines.push(`${pros[0].display} atende apenas ${modsText(pros[0].modalities)}.`);
  if (conv.last_slots) { try { const sl = JSON.parse(conv.last_slots); if (sl.length) lines.push(`Horários livres oferecidos na última consulta (confira com consultar_horarios se passou muito tempo): ${sl.join('; ')}.`); } catch { /* ignora */ } }
  if (conv.phone && !String(conv.phone).startsWith('55000')) { const wl = await Waitlist.contextFor(conv.phone); if (wl) lines.push(wl); }
  // O que foi conversado com a equipe enquanto o atendente estava pausado (vale uma vez, ao retomar)
  if (conv.human_note) {
    lines.push(`Enquanto você estava pausado(a), a equipe atendeu este contato pelo WhatsApp. Continue a partir daí, sem repetir o que já foi resolvido:\n${conv.human_note}`);
    q('UPDATE agent_conversations SET human_note = NULL WHERE id = ?', [conv.id]).catch(() => {});
  }
  if (extra) lines.push(extra);
  return lines.join('\n');
}

// ---------- ciclo da conversa ----------
const conversationsInFlight = new Tenancy.TMap();  // separado por clínica
let clientCache = null;
function client(c) {
  if (!clientCache || clientCache.key !== c.apiKey) clientCache = { key: c.apiKey, v: new Anthropic({ apiKey: c.apiKey, maxRetries: 2, timeout: 120e3 }) };
  return clientCache.v;
}

async function loadConversation(phone, contactName, patientId) {
  const key = WA.phoneKey(phone);
  let conv = await one('SELECT * FROM agent_conversations WHERE phone_key = ?', [key]);
  if (!conv) {
    await q('INSERT IGNORE INTO agent_conversations (phone_key, phone, contact_name, patient_id, started_at) VALUES (?,?,?,?,NOW())', [key, phone, contactName || null, patientId || null]);
    conv = await one('SELECT * FROM agent_conversations WHERE phone_key = ?', [key]);
  }
  if (patientId && conv.patient_id !== patientId) { await q('UPDATE agent_conversations SET patient_id = ? WHERE id = ?', [patientId, conv.id]); conv.patient_id = patientId; }
  if (contactName && !conv.contact_name) await q('UPDATE agent_conversations SET contact_name = ? WHERE id = ?', [String(contactName).slice(0, 120), conv.id]);
  return conv;
}

// Recebe uma mensagem do webhook. Agrupa mensagens enviadas em sequência (espera alguns segundos).
export async function enqueue({ phone, text, contactName, patientId, extra = null, debounceMs = Number(process.env.AGENT_DEBOUNCE_MS || 6000) }) {
  const c = await config();
  if (!ready(c)) return { skipped: 'agent-off' };
  const conv = await loadConversation(phone, contactName, patientId);
  if (conv.status === 'humano') {
    if (conv.human_until && conv.human_until > nowLocal()) return { skipped: 'humano' };
    await q("UPDATE agent_conversations SET status = 'ativo', human_reason = NULL, human_until = NULL WHERE id = ?", [conv.id]);
  }
  await q('INSERT INTO agent_inbox (conversation_id, text_enc) VALUES (?, ?)', [conv.id, encrypt(text)]);
  await q('UPDATE agent_conversations SET last_inbound_at = NOW() WHERE id = ?', [conv.id]);
  if (extra) conversationsInFlight.set(`extra-${conv.id}`, extra);
  clearTimeout(conversationsInFlight.get(conv.id));
  const t = setTimeout(() => { conversationsInFlight.delete(conv.id); process_(conv.id).catch((e) => console.error('agent', e.message)); }, debounceMs);
  conversationsInFlight.set(conv.id, t);
  return { queued: conv.id };
}

export async function process_(convId) {
  // Trava a conversa (evita respostas duplicadas entre processos do servidor).
  const lock = await q('UPDATE agent_conversations SET lock_until = DATE_ADD(NOW(), INTERVAL 3 MINUTE) WHERE id = ? AND (lock_until IS NULL OR lock_until < NOW())', [convId]);
  if (!lock.affectedRows) { setTimeout(() => process_(convId).catch(() => {}), 8000); return { skipped: 'locked' }; }
  try {
    const c = await config();
    const conv = await one('SELECT * FROM agent_conversations WHERE id = ?', [convId]);
    const inbox = await q('SELECT id, text_enc FROM agent_inbox WHERE conversation_id = ? AND processed = 0 ORDER BY id', [convId]);
    if (!inbox.length || !ready(c) || conv.status === 'humano') return { skipped: 'nothing' };
    await q(`UPDATE agent_inbox SET processed = 1 WHERE id IN (${inbox.map(() => '?').join(',')})`, inbox.map((m) => m.id));

    // Conversa nova após 12h sem mensagens (começa um histórico limpo — nunca editamos o histórico).
    let history = [];
    const idle = !conv.last_reply_at || (Date.now() - new Date(`${conv.last_reply_at.replace(' ', 'T')}-03:00`)) > 12 * 3600e3;
    if (!idle && conv.messages_enc) { try { history = JSON.parse(decrypt(conv.messages_enc)); } catch { history = []; } }
    if (history.length > 120) history = [];

    const extra = conversationsInFlight.get(`extra-${convId}`); conversationsInFlight.delete(`extra-${convId}`);
    history.push({ role: 'user', content: inbox.map((m) => decrypt(m.text_enc)).join('\n') });
    history.push({ role: 'system', content: await contextMessage(c, conv, extra) });

    const { final: out, usageIn, usageOut } = await smartConverse(c, conv, history, false);
    let final = out;
    if (!final) final = 'Desculpe, tive um problema para concluir agora. Vou pedir para a equipe te responder por aqui. 🙏';

    const r = await WA.send({ phone: conv.phone, text: final, kind: 'agente', patient_id: conv.patient_id });
    await q('UPDATE agent_conversations SET messages_enc = ?, last_reply_at = NOW(), turns = turns + 1, tokens_in = tokens_in + ?, tokens_out = tokens_out + ? WHERE id = ?',
      [encrypt(JSON.stringify(history)), usageIn, usageOut, convId]);
    return { ok: r.ok, reply: final };
  } catch (e) {
    console.error('agent turn', e.status || '', e.message);
    // Falhou: avisa a pessoa, pausa o atendente neste contato e chama a equipe.
    const { account, reason } = classifyError(e);
    try {
      if (account) await suspendClaude(reason); // problema da conta: suspende o Claude para todos os contatos
      const conv = await one('SELECT * FROM agent_conversations WHERE id = ?', [convId]);
      await q("UPDATE agent_conversations SET status = 'humano', human_reason = ?, human_until = DATE_ADD(NOW(), INTERVAL 2 HOUR) WHERE id = ?", [reason, convId]);
      import('./relay.js').then((R) => R.startHandoff(convId, `Falha do atendente virtual: ${reason}`)).catch(() => {});
      await WA.send({ phone: conv.phone, text: 'Recebi sua mensagem! Alguém da equipe vai te responder por aqui em breve. 🙏', kind: 'agente', patient_id: conv.patient_id });
      const admins = (await q("SELECT id FROM users WHERE active = 1 AND role IN ('admin','secretaria')")).map((u) => u.id);
      if (!account) notify(admins, { title: '⚠ Atendente virtual com falha', body: `${conv.contact_name || conv.phone}: ${reason}`, url: '/configuracoes/agente#conversas', tag: `conv-${convId}` });
    } catch { /* sem mais o que fazer */ }
    return { ok: false, error: e.message };
  } finally {
    await q('UPDATE agent_conversations SET lock_until = NULL WHERE id = ?', [convId]);
  }
}


// Ciclo de ferramentas com o Claude. Devolve o texto final para enviar ao contato.
async function converse(c, conv, history, dryRun) {
  const ctx = { c, conv, dryRun };
  let final = null; let usageIn = 0; let usageOut = 0;
  for (let i = 0; i < 8; i++) {
    const model = modelOf(c);
    const res = await client(c).beta.messages.create({
      model,
      max_tokens: 16000,
      ...(MODELS[model].fallbacks ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
      output_config: { effort: 'medium' },
      cache_control: { type: 'ephemeral' },
      system: systemPrompt(c),
      tools: toolsFor(c),
      messages: history,
    });
    await recordUsage(conv.id || null, res);
    usageIn += (res.usage?.input_tokens || 0) + (res.usage?.cache_read_input_tokens || 0) + (res.usage?.cache_creation_input_tokens || 0);
    usageOut += res.usage?.output_tokens || 0;
    history.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'refusal') {
      await runTool('transferir_para_humano', { motivo: 'Mensagem fora do escopo do atendente virtual.', urgente: false }, ctx);
      final = 'Vou pedir para alguém da equipe continuar com você por aqui, tudo bem? 🙏';
      break;
    }
    if (res.stop_reason === 'pause_turn') continue;
    const calls = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !calls.length) {
      final = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      break;
    }
    const results = [];
    for (const call of calls) {
      let out;
      try { out = await runTool(call.name, call.input || {}, ctx); } catch (e) { out = { erro: `Falha interna: ${e.message}` }; }
      results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out), ...(out?.erro ? { is_error: true } : {}) });
    }
    history.push({ role: 'user', content: results });
  }
  return { final, usageIn, usageOut, handoff: ctx.handoff || null };
}

// Simulador (tela de configuração): conversa de teste sem enviar WhatsApp e sem alterar a agenda.
export async function simulate(historyIn, text, asPatientId = null, forceSecondary = false) {
  const c = await config();
  if (!order(c).length && !(forceSecondary && Slot.ready(c.ai2))) throw new Error('Configure o provedor de IA principal (provedor, modelo e chave).');
  const conv = { id: 0, phone: '5500000000000', patient_id: asPatientId, contact_name: null, status: 'ativo' };
  // Trabalha numa cópia: se a chamada falhar, o histórico do simulador não fica com um turno pela metade.
  const history = Array.isArray(historyIn) ? [...historyIn] : [];
  history.push({ role: 'user', content: text });
  history.push({ role: 'system', content: await contextMessage(c, conv, 'Esta é uma conversa de TESTE da equipe (simulação): nada será gravado.') });
  const r = await smartConverse(c, conv, history, true, forceSecondary);
  return { reply: r.final || '(sem resposta)', history, handoff: r.handoff, provider: r.provider, usage: { in: r.usageIn, out: r.usageOut } };
}


// =====================================================================
// Reserva: Groq (API compatível com OpenAI) quando o Claude não puder responder
// =====================================================================
const groqTools = (c) => toolsFor(c).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));
async function groqFetch(c, path, body) {
  try { return path === '/chat/completions' ? await AP.chat(c.altProvider || 'groq', c.groqKey, c.altBaseUrl, body) : null; }
  catch (e) { e.provider = 'groq'; throw e; }
}
// Modelos disponíveis na conta do outro provedor (para a administradora escolher)
export async function groqModels(key, fresh = false, provider = 'groq', base = '') { return AP.listModels(provider, key, base, fresh); }
export const preferredGroqModel = (list, provider = 'groq') => AP.preferredModel(provider, list);

// Converte o histórico (formato Claude) para o formato de chat da Groq.
function toOpenAI(c, history) {
  const out = [{ role: 'system', content: systemPrompt(c) }];
  for (const m of history) {
    if (m.role === 'system') out.push({ role: 'system', content: typeof m.content === 'string' ? m.content : '' });
    else if (m.role === 'user') {
      if (typeof m.content === 'string') { out.push({ role: 'user', content: m.content }); continue; }
      for (const b of m.content || []) {
        if (b.type === 'tool_result') out.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
        else if (b.type === 'text') out.push({ role: 'user', content: b.text });
      }
    } else if (m.role === 'assistant') {
      const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
      const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const calls = blocks.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      if (text || calls.length) out.push({ role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) });
    }
  }
  return out;
}

async function converseGroq(c, conv, history, dryRun) {
  const ctx = { c, conv, dryRun };
  const messages = toOpenAI(c, history);
  let final = null; let usageIn = 0; let usageOut = 0;
  for (let i = 0; i < 8; i++) {
    const data = await groqFetch(c, '/chat/completions', { model: c.groqModel, messages, tools: groqTools(c), tool_choice: 'auto', temperature: 0.3, max_completion_tokens: 2048 });
    const u = data.usage || {};
    usageIn += u.prompt_tokens || 0; usageOut += u.completion_tokens || 0;
    try { await q('INSERT INTO agent_usage (conversation_id, model, input_tokens, output_tokens, cost_usd) VALUES (?,?,?,?,0)', [conv.id || null, `${c.altProvider || 'groq'}:${c.groqModel}`.slice(0, 60), u.prompt_tokens || 0, u.completion_tokens || 0]); } catch { /* medição não bloqueia */ }
    const msg = data.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) { final = String(msg.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(); break; }
    messages.push({ role: 'assistant', content: msg.content || null, tool_calls: calls });
    for (const tc of calls) {
      let input = {}; try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { /* argumentos inválidos */ }
      let out;
      try { out = await runTool(tc.function?.name, input, ctx); } catch (e) { out = { erro: `Falha interna: ${e.message}` }; }
      messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
    }
  }
  // No histórico (formato Claude) a resposta da Groq entra só como texto: o histórico continua válido para o Claude.
  if (final) history.push({ role: 'assistant', content: [{ type: 'text', text: final }] });
  return { final, usageIn, usageOut, handoff: ctx.handoff || null, provider: 'groq' };
}

// Escolhe o provedor: o principal primeiro; o secundário assume se o principal falhar
// (conta sem créditos, chave inválida, limite de uso ou serviço fora do ar).
const transient = (e) => { const st = e?.status; return !st || [401, 402, 403, 404, 408, 409, 429].includes(st) || st >= 500; };
async function smartConverse(c, conv, history, dryRun, forceSecondary = false) {
  c = { ...c, waitlistOn: (await Waitlist.config()).enabled };
  const slots = forceSecondary ? [c.ai2].filter((x) => Slot.ready(x)) : order(c);
  if (!slots.length) throw new Error(`${c.suspended?.reason ? `${c.suspended.reason} — ` : ''}nenhum provedor de IA disponível: configure o principal ou ative o secundário.`);
  let lastErr = null;
  for (let i = 0; i < slots.length; i++) {
    const x = slots[i];
    try {
      const r = x.provider === 'anthropic'
        ? await converse({ ...c, apiKey: x.key, model: x.model }, conv, history, dryRun)
        : await converseGroq({ ...c, altProvider: x.provider, groqKey: x.key, altBaseUrl: x.baseUrl, groqModel: x.model }, conv, history, dryRun);
      return { ...r, provider: Slot.describe(x), slot: x === c.ai1 ? 1 : 2 };
    } catch (e) {
      lastErr = e;
      if (x.provider === 'anthropic') {
        const { account, reason } = classifyError(e);
        if (account && !dryRun) await suspendClaude(reason);
        const outage = e instanceof Anthropic.APIConnectionError || e instanceof Anthropic.RateLimitError || e?.status >= 500;
        if (!(account || outage)) throw e;
      } else if (!transient(e)) throw e;
      if (i < slots.length - 1) console.error(`agent: ${Slot.describe(x)} indisponível, usando ${Slot.describe(slots[i + 1])} —`, e.message);
    }
  }
  throw lastErr;
}

// Alguém respondeu manualmente pelo celular: pausa o atendente virtual neste contato.
export async function humanTookOver(phone) {
  const c = await config();
  const key = WA.phoneKey(phone);
  await q("UPDATE agent_conversations SET status = 'humano', human_reason = 'Respondido manualmente pelo WhatsApp', human_until = DATE_ADD(NOW(), INTERVAL ? HOUR) WHERE phone_key = ?", [Number(c.pauseHours) || 12, key]);
}

export async function resume(convId) {
  const cv = await one('SELECT phone FROM agent_conversations WHERE id = ?', [convId]);
  if (cv) CRM.onResume({ phone: cv.phone });
  await q("UPDATE agent_conversations SET status = 'ativo', human_reason = NULL, human_until = NULL WHERE id = ?", [convId]);
}
