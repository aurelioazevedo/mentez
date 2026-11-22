// Assistente de ajuda (chat) dentro do sistema: tira dúvidas e ensina a usar a Mentez, como um suporte de primeiro nível.
// A IA é da Mentez (configurada no Painel → Assistente de ajuda, com provedor principal e reserva); a clínica não paga nada.
// Não recebe nem guarda dados de pacientes: só a pergunta, a tela em que a pessoa está, o perfil e os recursos da clínica.
import Anthropic from '@anthropic-ai/sdk';
import * as T from './tenancy.js';
import * as AP from './aiproviders.js';
import * as AISlot from './aislot.js';

// ---------- configuração (banco da plataforma; chaves seladas com a chave mestra) ----------
async function getS(k) { return (await T.pone('SELECT v FROM platform_settings WHERE k = ?', [k]))?.v || null; }
async function setS(k, v) { await T.pq('INSERT INTO platform_settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, v]); }
const openSlot = (o) => { if (!o) return null; let key = ''; try { key = o.key_sealed ? T.unseal(o.key_sealed).key : ''; } catch { key = ''; } return { provider: o.provider, model: o.model || '', baseUrl: o.baseUrl || '', key, on: o.on !== false }; };
const sealSlot = (s) => (s?.provider ? { provider: s.provider, model: s.model, baseUrl: s.baseUrl || '', on: s.on !== false, key_sealed: s.key ? T.seal({ key: s.key }) : null } : null);
export async function config() {
  let c = {}; try { c = JSON.parse((await getS('helpbot')) || '{}'); } catch { /* padrão */ }
  return { enabled: c.enabled !== false, extra: c.extra || '', p1: openSlot(c.p1) || { provider: 'anthropic', model: 'claude-haiku-5-5', baseUrl: '', key: '', on: true }, p2: openSlot(c.p2) };
}
export async function saveConfig(b, cur) {
  const r1 = AISlot.fromBody(b, 'p1', cur.p1, [cur.p2]); const r2 = AISlot.fromBody(b, 'p2', cur.p2, [cur.p1]);
  for (const [r, nm] of [[r1, 'Principal'], [r2, 'Reserva']]) {
    if (r.error) return { error: `${nm}: ${r.error}` };
    if (r.slot.on && r.slot.key && r.slot.provider !== 'anthropic') await AISlot.fillModel(r.slot);
  }
  await setS('helpbot', JSON.stringify({ enabled: !!b.enabled, extra: String(b.extra || '').slice(0, 4000), p1: sealSlot(r1.slot), p2: r2.slot.provider ? sealSlot(r2.slot) : null }));
  return { ok: true };
}
export const ready = (c) => !!c.enabled && (AISlot.ready(c.p1) || (c.p2?.on && AISlot.ready(c.p2)));

let tbl = false;
async function ensure() {
  if (tbl) return;
  await T.pq(`CREATE TABLE IF NOT EXISTS helpbot_usage (id BIGINT AUTO_INCREMENT PRIMARY KEY, tenant VARCHAR(40) NULL, user_id INT NULL, provider VARCHAR(60) NULL,
    in_tok INT NOT NULL DEFAULT 0, out_tok INT NOT NULL DEFAULT 0, ok TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  tbl = true;
}
export async function usage(days = 30) {
  await ensure();
  return T.pone('SELECT COUNT(*) n, COUNT(DISTINCT tenant) clinics, COALESCE(SUM(in_tok),0) tin, COALESCE(SUM(out_tok),0) tout, SUM(ok = 0) fails FROM helpbot_usage WHERE created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)', [days]);
}

// ---------- manual da Mentez (base de conhecimento do assistente) ----------
export const MANUAL = `
# Mentez — manual de uso (sistema de gestão para psicólogos e clínicas de psicologia)

## Menu lateral
- Início (/): painel do dia — indicadores do mês, gráficos de receita e sessões, calendário, sessões de hoje e alertas.
- Agenda (/agenda): dia, semana ou mês. Abas: Agenda, Lista de espera, Escala e bloqueios.
- Recepção (/recepcao): chegada dos pacientes, fila do dia e chamada na TV.
- CRM (/crm): funil de contatos novos (interessados) até a primeira sessão.
- Marketing (/marketing): reativação de pacientes, aniversários, cartão digital (/marketing/cartao) e link na bio (/marketing/links).
- Pacientes (/pacientes): lista e ficha de cada paciente.
- Exercícios (/exercicios): biblioteca de exercícios para enviar aos pacientes (módulo que pode estar desligado).
- Financeiro (/financeiro): contas a receber, pacotes, conciliação bancária, acertos/repasses, notas fiscais e convênios.
- Relatórios (/relatorios): agenda e presença, financeiro, convênios, NPS e outros.
- Locação (/locacao): aluguel de salas (se ligado).
- Usuários (/usuarios): equipe, perfis de acesso e convites.
- Engrenagem no topo → Configurações (/configuracoes): todas as configurações da clínica.
- Ícone da lua: modo escuro. Sino: notificações. Iniciais no canto: Conta (/conta) — seus dados, senha, foto, login em duas etapas, sua chave de IA, certificado digital.

## Primeiros passos de uma clínica nova
1. Configurações → Identidade da clínica (/configuracoes/identidade): nome, logo, cores, estilo visual, dados do profissional (CRP), contatos.
2. Agenda → Escala e bloqueios: dias, horários de atendimento, duração da sessão e intervalos de cada profissional.
3. Pacientes → + Novo paciente (ou cadastrar direto pela agenda).
4. Configurações → WhatsApp (/configuracoes/whatsapp): ler o QR code com o celular do consultório para ligar lembretes e o atendente.
5. Usuários: convidar a equipe (perfis: administração, psicólogo, recepção, financeiro).

## Agenda
- Agendar: botão "+ Agendar sessão" ou clicar num horário vazio da grade. Também dá para arrastar um paciente da lista lateral até o horário.
- Sessão recorrente: ao agendar, escolha a repetição (semanal, quinzenal, mensal). Remarcar pergunta se é só esta ou todas as seguintes.
- Situações da sessão: agendada, confirmada, aguardando (chegou), em atendimento, realizada, falta, cancelada.
- Bloquear horário e registrar férias: botões no topo da agenda; aparecem como indisponíveis para agendamento.
- Lista de espera: aba da agenda; quando um horário abre, a oferta pode ser enviada automaticamente pelo WhatsApp (Configurações → Lista de espera).
- Cores: por tipo de atendimento, por paciente ou por profissional. Layout novo ou clássico.
- Google Agenda: Configurações → Google Agenda (/configuracoes/google) — sincroniza e respeita compromissos pessoais.
- Agendamento online: Configurações → Agendamento online (/configuracoes/agendamento-online). Página pública /agendar; o paciente confirma com código no WhatsApp. Opção de mostrar só 2 a 4 horários.

## Ficha do paciente (Pacientes → nome)
- Abas: Prontuário, Sessões, Exercícios, Escalas, Humor, Financeiro, Convênio, WhatsApp, Termos, Documentos, Dados.
- Botão "Sessão / registro": abre o registro da sessão (evolução) com rascunho automático.
- Prontuário: linha do tempo; cada evolução é visível só para quem escreveu (sigilo).
- Humor: check-ins que o paciente faz pelo app; sinal de risco gera alerta.
- Termos: enviar termo de consentimento/contrato por link (WhatsApp ou e-mail).
- Documentos: declaração, atestado, relatório, laudo e parecer (Res. CFP 06/2019), com assinatura digital e código de verificação.
- Dados → Portal do paciente: "Enviar acesso pelo WhatsApp".

## Teleconsulta
- Configurações → Teleconsulta: sala própria da Mentez (com sala de espera), Google Meet ou Zoom. Cada profissional escolhe a sua em Conta.
- A sessão on-line abre pela agenda; ao encerrar, já abre o registro da sessão.

## IA na sessão e escrita com IA
- IA na sessão (Configurações → IA na sessão): grava com autorização do paciente, transcreve e escreve um rascunho da evolução para revisar.
- Escrita com IA de documentos: Configurações → Documentos → Escrita com IA (chave da clínica) ou Conta → Escrita com IA (chave do profissional). Provedor principal e reserva.
- Nome e CPF do paciente são trocados antes de enviar texto para a IA. Tudo gerado por IA precisa ser revisado.

## Atendente virtual (IA) no WhatsApp
- Configurações → Atendente virtual (/configuracoes/agente): liga o atendente que conversa com pacientes, consulta a escala, agenda, remarca e cancela dentro das regras.
- Escolha o provedor principal e a reserva (Claude, OpenAI, Gemini, Groq, DeepSeek, OpenRouter, Mistral). Precisa da chave da API do provedor.
- Simulador na mesma tela para testar antes de ligar. Assuntos clínicos ou de risco são transferidos para a equipe.
- Conversas em /atendimento. Se alguém responde manualmente pelo celular, o atendente pausa naquela conversa.

## WhatsApp
- Configurações → WhatsApp: ler o QR code (WhatsApp → Aparelhos conectados → Conectar aparelho). Se cair, o painel mostra o alerta e basta ler de novo.
- Lembretes de sessão, confirmações, links de termos, exercícios e cobranças usam este WhatsApp.

## Financeiro
- Lançamentos por sessão, pacote ou avulso; baixa manual (Pix, dinheiro, cartão, transferência) ou automática pela cobrança online.
- Cobrança online: Configurações → Cobrança online (Asaas ou Mercado Pago) — Pix, boleto e cartão, com baixa automática.
- Pacotes: Financeiro → Pacotes (venda de pacotes de sessões e saldo).
- Conciliação: importar o extrato do banco e conferir.
- Acertos/repasses: percentual ou valor por profissional.
- Recibos para a Receita Saúde e Nota fiscal (NFS-e): Configurações → Nota fiscal.
- Convênios: Configurações → Convênios (operadoras e tabela), carteirinha e autorização na ficha do paciente, a receber em Financeiro → Convênios.

## Portal / app do paciente
- Configurações → Portal do paciente: ligar e escolher o que aparece (confirmar/remarcar/cancelar, pagamentos, recibos, termos, exercícios, check-in de humor).
- O paciente entra em <endereço da clínica>/paciente com o WhatsApp do cadastro (recebe um código) ou pelo link enviado pela equipe. Pode instalar como aplicativo ("Adicionar à tela inicial").

## Exercícios
- Configurações → Exercícios liga o módulo. Exercícios → Biblioteca Mentez: copiar um modelo; editar; "Criar com IA". Todo exercício precisa ser revisado e aprovado antes do envio.
- Enviar: ficha do paciente → aba Exercícios → escolher e gerar o link (WhatsApp automático, se ligado). Respostas chegam na ficha, com gráficos. Folha para imprimir com a marca da clínica.

## Marketing
- Cartão digital (/marketing/cartao) e Link na bio (/marketing/links): páginas públicas da clínica, com foto (ajuste de enquadramento), QR code e estatística de cliques.
- Aniversários e reativação: mensagens automáticas, com texto sugerido pela IA dentro das normas de publicidade da psicologia.

## Identidade, domínio e plano
- Identidade da clínica: logo (claro/escuro), símbolo, favicon, até 4 cores, estilo visual (inclui Aurora e outros).
- Domínio próprio: Configurações → Domínio próprio — cadastrar e criar no DNS um registro A (ou CNAME para <clínica>.mentez.com.br). Proxy da Cloudflare precisa ficar desligado (nuvem cinza).
- Plano e assinatura: Configurações → Plano e assinatura (/configuracoes/assinatura) — trocar de plano, pagar, faturas, cancelar.

## Segurança e LGPD
- Login em duas etapas: Conta. Registro de acessos: Configurações → Registro de acessos.
- Backup: Configurações → Backup (Google Drive da clínica).
- Privacidade e LGPD: prazo de guarda do prontuário (mínimo 5 anos, CFP), anonimização e exportação dos dados do paciente.

## Problemas comuns
- Paciente não recebe lembrete: conferir se o WhatsApp está conectado (alerta no Início) e se o paciente autorizou receber mensagens no cadastro.
- Não consigo ver a evolução de outro profissional: é proposital — o prontuário é visível só para o autor.
- Recurso aparece como "de outro plano": o plano atual não inclui; ver Plano e assinatura.
- Esqueci a senha: peça ao administrador da clínica para redefinir em Usuários. Para trocar a sua: Conta.
- Tela desatualizada depois de uma atualização: recarregar com Ctrl+F5.
`;

// ---------- conversa ----------
const SYSTEM = (ctx, extra) => `Você é o "Assistente Mentez", o suporte dentro do sistema Mentez (gestão para psicólogos e clínicas de psicologia no Brasil).
Seu papel: tirar dúvidas sobre o uso do sistema e ensinar o passo a passo, de forma curta, clara e simpática, em português do Brasil.
Regras:
- Baseie-se SOMENTE no manual abaixo e no contexto. Se não souber ou o recurso não existir, diga com honestidade e sugira falar com o suporte (${ctx.contact}).
- Responda em no máximo ~8 linhas. Para tarefas, use passos numerados curtos. Use **negrito** para nomes de botões e menus.
- Sempre que citar uma tela, inclua o link no formato [Nome da tela](/caminho) — só caminhos internos começando com "/".
- Não peça nem aceite dados de pacientes (nomes, CPF, prontuário). Se a pessoa enviar, não repita e lembre que não é preciso.
- Não dê orientação clínica, jurídica ou contábil; você ensina a usar o sistema.
- Se o recurso não estiver disponível no plano da clínica (veja o contexto), explique e indique [Plano e assinatura](/configuracoes/assinatura).
Contexto da pessoa: perfil "${ctx.role}"; está na tela ${ctx.page || '/'}; clínica "${ctx.clinic}"; recursos do plano: ${ctx.features || 'base'}.
${extra ? `\nInformações adicionais da Mentez:\n${extra}\n` : ''}
${MANUAL}`;

function clean(messages) {
  return [].concat(messages || []).slice(-12).map((m) => ({ role: m?.role === 'assistant' ? 'assistant' : 'user', content: String(m?.content || '').slice(0, 1500) })).filter((m) => m.content.trim());
}
async function callSlot(s, system, msgs) {
  if (s.provider === 'anthropic') {
    const client = new Anthropic({ apiKey: s.key, maxRetries: 1, timeout: 60e3 });
    const res = await client.messages.create({ model: AISlot.CLAUDE_MODELS[s.model] ? s.model : 'claude-haiku-5-5', max_tokens: 1200, system, messages: msgs });
    if (res.stop_reason === 'refusal') return { text: 'Não consigo ajudar com isso por aqui. Posso explicar como usar alguma parte do sistema?', inTok: 0, outTok: 0 };
    return { text: res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim(), inTok: res.usage?.input_tokens || 0, outTok: res.usage?.output_tokens || 0 };
  }
  const d = await AP.chat(s.provider, s.key, s.baseUrl, { model: s.model, temperature: 0.2, max_tokens: 1200, messages: [{ role: 'system', content: system }, ...msgs] });
  return { text: String(d.choices?.[0]?.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim(), inTok: d.usage?.prompt_tokens || 0, outTok: d.usage?.completion_tokens || 0 };
}
// Limite simples por pessoa (40 mensagens por hora)
const hits = new Map();
function limited(id) {
  const now = Date.now(); const arr = (hits.get(id) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= 40) return true; arr.push(now); hits.set(id, arr); return false;
}
export async function reply({ messages, ctx, who }) {
  const c = await config();
  if (!ready(c)) return { ok: false, error: 'O assistente ainda não está disponível. Fale com o suporte da Mentez.' };
  if (limited(who)) return { ok: false, error: 'Muitas perguntas seguidas. Tente de novo em alguns minutos.' };
  const msgs = clean(messages);
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { ok: false, error: 'Escreva sua dúvida.' };
  const system = SYSTEM(ctx, c.extra);
  await ensure();
  let lastErr = null;
  for (const s of [c.p1, c.p2?.on ? c.p2 : null].filter((x) => AISlot.ready(x))) {
    try {
      const r = await callSlot(s, system, msgs);
      await T.pq('INSERT INTO helpbot_usage (tenant, user_id, provider, in_tok, out_tok, ok) VALUES (?,?,?,?,?,1)', [ctx.slug || null, ctx.userId || null, `${s.provider}:${s.model}`.slice(0, 60), r.inTok, r.outTok]).catch(() => {});
      if (r.text) return { ok: true, reply: r.text };
    } catch (e) { lastErr = e; console.error('assistente de ajuda:', e.message); }
  }
  await T.pq('INSERT INTO helpbot_usage (tenant, user_id, provider, ok) VALUES (?,?,?,0)', [ctx.slug || null, ctx.userId || null, 'erro']).catch(() => {});
  return { ok: false, error: `O assistente não respondeu agora${lastErr ? '' : ''}. Tente de novo em instantes.` };
}
