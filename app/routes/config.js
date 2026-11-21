import * as Tenancy from '../lib/tenancy.js';
import * as Domains from '../lib/domains.js';
import * as Billing from '../lib/billing.js';
import * as Brand from '../lib/brand.js';
import { one } from '../lib/db.js';
import { page, html, raw, brDateTime } from '../lib/html.js';
import { router, send } from '../lib/router.js';
import * as WA from '../lib/whatsapp.js';
import * as G from '../lib/google.js';
import * as Agent from '../lib/agent.js';
import * as Maint from '../lib/maint.js';
import * as Backup from '../lib/backup.js';
import * as Flow from '../lib/flow.js';
import * as Monitor from '../lib/monitor.js';
import * as Waitlist from '../lib/waitlist.js';
import * as TV from '../lib/tv.js';
import * as BK from '../lib/booking.js';
import * as SessionAI from '../lib/sessionai.js';
import * as Portal from '../lib/portal.js';
import * as Rental from '../lib/rental.js';
import * as Gateway from '../lib/gateway.js';
import * as Notify from '../lib/notify.js';
import * as Engage from '../lib/engage.js';
import * as Tele from '../lib/tele.js';
import * as Nfse from '../lib/nfse.js';
import * as IcpCloud from '../lib/icpcloud.js';
import * as Ins from '../lib/insurance.js';

const r = router();

const ICONS = {
  whatsapp: '<path d="M4 20l1.3-3.9A8 8 0 1 1 8 19z"/><path d="M9 9.5c.3 2 1.8 3.7 4 4.5l1.2-1.2 2 1-.5 1.6c-3.6.2-7-3.2-6.9-6.9l1.6-.5 1 2z"/>',
  google: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M9 15h6"/>',
  agente: '<rect x="4" y="7" width="16" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6"/>',
  backup: '<path d="M7 18a5 5 0 1 1 .9-9.9A6 6 0 0 1 19 10a4 4 0 0 1-1 7.9"/><path d="M12 12v8M9 15l3-3 3 3"/>',
  dados: '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  atendimento: '<path d="M3 20h18"/><path d="M5 20v-6a7 7 0 0 1 14 0v6"/><path d="M12 4v3"/>',
  monitor: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  termos: '<path d="M6 3h9l4 4v14H6z"/><path d="M9 12l2 2 4-4"/>',
  privacidade: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><rect x="9" y="10" width="6" height="5" rx="1"/>',
  acessos: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  tv: '<rect x="3" y="5" width="18" height="12" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M8 11h3M14 9v4"/>',
  'lista-espera': '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="5" cy="6" r="1"/><circle cx="5" cy="12" r="1"/><path d="M4 17.5l1 1 2-2"/>',
  'agendamento-online': '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><path d="M9 15l2 2 4-4"/>',
  cobranca: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/>',
  locacao: '<path d="M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16"/><path d="M2 21h20M16 9h4v12"/><circle cx="12.5" cy="12" r=".9"/>',
  portal: '<rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/><path d="M10 7h4M10 10.5h4"/>',
  'sessao-ia': '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/>',
  documentos: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
};
const ic = (k) => raw(`<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[k] || ICONS.termos}</svg>`); // sem ícone próprio: usa um genérico

// Situação de cada integração/recurso da clínica atual (tela de Configurações e monitoramento no Painel Mentez)
export async function statusItems({ master = false } = {}) {
  const wac = await WA.config();
  const waState = WA.ready(wac) ? await WA.connectionState(wac).catch(() => 'erro') : null;
  const gcfg = await G.config();
  const gConnected = await one("SELECT COUNT(*) n FROM users WHERE active = 1 AND google_refresh_enc IS NOT NULL AND google_error IS NULL");
  const ag = await Agent.config();
  const bal = ag.enabled ? await Agent.balance() : { known: false };
  const lastAccess = await one('SELECT l.created_at, u.name FROM audit_log l LEFT JOIN users u ON u.id = l.user_id ORDER BY l.id DESC LIMIT 1');
  const today = await one('SELECT COUNT(*) n FROM audit_log WHERE created_at >= CURDATE()');
  const fc = await Flow.config();
  const wlc = await Waitlist.config(); const wlStats = await Waitlist.stats();
  const tvc = await TV.config(); const tvScreens = await TV.screens(); const bkc = await BK.config(); const sai = await SessionAI.config(); const ptl = await Portal.config(); const rtc = await Rental.config(); const gwc = await Gateway.config(); const ntc = await Notify.config(); const egc = await Engage.config(); const tlc = await Tele.config(); const nfc = await Nfse.config(); const nfr = await Nfse.readiness(nfc); const icc = IcpCloud.available(await IcpCloud.config()); const insOn = await Ins.list(true);
  const mc = await Monitor.config();

  const br = await Brand.load();
  const items = [
    {
      key: 'identidade', href: '/configuracoes/identidade', title: 'Identidade da clínica',
      desc: 'Nome, profissional responsável e CRP, contatos, cidade, site, logo e cor. Aparecem nas telas, documentos, recibos, mensagens e no portal do paciente.',
      status: br.logo && br.phone && br.city ? ['realizada', br.short] : ['falta', br.legacy ? br.short : 'Complete a ficha'],
    },
    ...(Tenancy.multi() ? [{
      key: 'assinatura', href: '/configuracoes/assinatura', title: 'Plano e assinatura',
      desc: 'Plano da Mentez, faturas e forma de pagamento (Pix, boleto ou cartão).',
      status: (() => { const a = Billing.accessOf(Tenancy.current()); return a.state === 'ativa' || a.state === 'cortesia' ? ['realizada', a.state === 'ativa' ? 'Em dia' : 'Cortesia'] : a.state === 'teste' ? ['confirmada', `Teste · ${a.daysLeft} dia(s)`] : ['falta', a.state === 'atrasada' ? 'Em aberto' : 'Suspenso']; })(),
    }, {
      key: 'dominio', href: '/configuracoes/dominio', title: 'Domínio próprio',
      desc: 'Use o endereço da clínica (ex.: app.suaclinica.com.br) no lugar do endereço da Mentez, com o passo a passo do registro A no Registro.br ou na hospedagem.',
      status: await (async () => { const ds = await Domains.list(Tenancy.current().id).catch(() => []); const on = ds.find((d) => d.verified_at && d.https_at); return on ? ['realizada', on.domain] : ds.length ? ['confirmada', 'Aguardando DNS'] : ['cancelada', `${Tenancy.current().slug}.${Tenancy.baseDomain()}`]; })(),
    }] : []),
    {
      key: 'whatsapp', href: '/configuracoes/whatsapp', title: 'WhatsApp',
      desc: 'Conexão do aparelho (QR code), WhatsApp do site (atendente ou profissional), lembretes e textos das mensagens.',
      status: !wac ? ['cancelada', 'Não configurado'] : !wac.enabled ? ['cancelada', 'Pausado'] : waState === 'open' ? ['realizada', `Conectado · ${wac.instance}`] : ['falta', waState === 'connecting' ? 'Conectando… (leia o QR Code)' : 'Desconectado'],
    },
    {
      key: 'google', href: '/configuracoes/google', title: 'Google Agenda',
      desc: 'Credenciais do Google e conexão da agenda de cada profissional.',
      status: !gcfg ? ['cancelada', 'Não configurado'] : ['realizada', `Configurado · ${gConnected.n} ${gConnected.n === 1 ? 'agenda conectada' : 'agendas conectadas'}`],
    },
    {
      key: 'agente', href: '/configuracoes/agente', title: 'Atendente virtual (IA)',
      desc: 'Atendimento automático no WhatsApp, regras de agenda, saldo da IA, outros provedores (OpenAI, Gemini, Groq…) e simulador.',
      status: !ag.enabled ? ['cancelada', 'Desligado'] : Agent.altPrimary(ag) ? ['realizada', `Ligado · ${Agent.altLabel(ag)}`] : Agent.claudeReady(ag) ? ['realizada', `Ligado · Claude${bal.known ? ` · saldo ~US$ ${bal.estimated.toFixed(2)}` : ''}`] : Agent.groqReady(ag) ? ['agendada', `Ligado · reserva ${Agent.altLabel(ag)}`] : ['falta', 'Suspenso'],
    },
    {
      key: 'atendimento', href: '/configuracoes/atendimento', title: 'Recepção e atendimento',
      desc: 'Quando perguntar sobre o pagamento, lembrete de pagamento pelo WhatsApp e alerta de tempo de espera.',
      status: ['confirmada', `Pagamento ${fc.payMoment === 'final' ? 'ao finalizar' : fc.payMoment === 'ambos' ? 'na chegada e ao finalizar' : 'na chegada'} · lembrete ${fc.reminder === 'auto' ? `automático (${Flow.reminderText(fc)})` : fc.reminder === 'botao' ? 'pelo botão' : 'desligado'} · espera ${fc.waitAlertMin} min`],
    },
    {
      key: 'monitor', href: '/configuracoes/monitoramento', title: 'Monitoramento e alertas',
      desc: 'Avisa no celular do suporte (por um 2º WhatsApp) quando o sistema cai, o WhatsApp desconecta, a IA fica sem saldo ou um erro se repete.',
      status: !mc.enabled ? ['cancelada', 'Desligado'] : ['realizada', `Ligado · ${mc.phones.length} celular(es)${mc.instance ? ` · instância ${mc.instance}` : ''}`],
    },
    { key: 'tv', href: '/configuracoes/tv', title: 'Painel de chamadas (TV)', desc: 'Senha na chegada e chamada na TV da recepção com sinal e voz; salas ou consultórios, TVs conectadas e mensagens.', status: !tvc.enabled ? ['cancelada', 'Desligado'] : ['realizada', `${tvScreens.length} TV(s) conectada(s) · ${tvc.display === 'senha' ? 'só a senha' : tvc.display === 'iniciais' ? 'iniciais' : 'nome'} · ${tvc.roomWord === 'Sala' ? 'salas' : 'consultórios'}`] },
    { key: 'lista-espera', href: '/configuracoes/lista-espera', title: 'Lista de espera', desc: 'Oferta automática pelo WhatsApp dos horários que abrem com cancelamentos: uma pessoa por vez ou várias, tempo para responder e texto da mensagem.', status: !wlc.enabled ? ['cancelada', 'Desligada'] : ['realizada', `${wlc.auto ? 'Automática' : 'Manual'} · ${wlc.mode === 'todos' ? 'várias pessoas' : 'uma por vez'} · ${wlc.replyMinutes} min para responder · ${wlStats.waiting} aguardando`] },
    { key: 'agendamento-online', href: '/configuracoes/agendamento-online', title: 'Agendamento online', desc: 'Página pública onde o paciente escolhe um horário livre e confirma com um código no WhatsApp.', status: bkc.enabled ? ['realizada', `Ligado · ${bkc.allowNew ? 'aceita novos pacientes' : 'só pacientes'}`] : ['cancelada', 'Desligado'] },
    { key: 'cobranca', href: '/configuracoes/cobranca', title: 'Cobrança online', desc: 'Boleto, Pix e cartão pelo Asaas ou Mercado Pago, com baixa automática no Financeiro quando o paciente paga.', status: Gateway.ready(gwc) ? ['realizada', `Ligada · ${Gateway.providerLabel(gwc.provider)} · ${gwc.env === 'producao' ? 'produção' : 'testes (sandbox)'}${gwc.webhookAt ? '' : ' · falta registrar o aviso'}`] : ['cancelada', 'Desligada'] },
    { key: 'lembretes', href: '/configuracoes/lembretes', title: 'Lembretes por e-mail e SMS', desc: 'Lembrete da sessão também por e-mail (com o evento para a agenda do celular) e SMS, com link para confirmar ou remarcar.', status: Notify.emailReady(ntc) || Notify.smsReady(ntc) ? ['realizada', `Ligado · ${[Notify.emailReady(ntc) ? `e-mail ${ntc.emailHours}h antes` : '', Notify.smsReady(ntc) ? `SMS ${ntc.smsHours}h antes (${Notify.PROVIDERS[ntc.smsProvider]})` : ''].filter(Boolean).join(' · ')}${ntc.mode === 'reserva' ? ' · só como reserva' : ''}`] : ['cancelada', 'Desligado'] },
    { key: 'convenios', href: '/configuracoes/convenios', title: 'Convênios', desc: 'Operadoras credenciadas e tabela de valores; carteirinha e autorização na ficha do paciente; sessão por convênio na agenda e no financeiro.', status: insOn.length ? ['realizada', `${insOn.length} credenciado(s)`] : ['cancelada', 'Nenhum convênio ligado'] },
    { key: 'assinatura', href: '/configuracoes/assinatura', title: 'Assinatura digital', desc: 'Certificados em nuvem (BirdID, VIDaaS, SafeID e o certificado do CFM): o profissional aprova a assinatura no celular, sem sair do sistema.', status: icc.length ? ['realizada', icc.map((k) => IcpCloud.PROVIDERS[k].label).join(', ')] : ['cancelada', 'Nenhuma certificadora ligada'] },
    { key: 'nfse', href: '/configuracoes/nfse', title: 'Nota fiscal (NFS-e)', desc: 'Emissão da nota fiscal de serviço da clínica pelo Asaas: automática ao receber, em lote ou uma a uma, com envio ao paciente.', status: !Nfse.cnpjOk(nfc.cnpj) ? ['agendada', 'Aguardando CNPJ'] : nfc.enabled && nfr.ok ? ['realizada', `Ligada · ${Nfse.MODES[nfc.mode].split(':')[0]}`] : ['cancelada', nfr.ok ? 'Pronta, desligada' : 'Configuração incompleta'] },
    { key: 'teleconsulta', href: '/configuracoes/teleconsulta', title: 'Teleconsulta', desc: 'Sala de vídeo própria (com sala de espera), Google Meet ou Zoom. A clínica define o permitido e o padrão; cada profissional escolhe a sua.', status: ['realizada', `Padrão: ${Tele.SHORT[tlc.clinicDefault]} · ${Tele.allowed(tlc).filter((k) => k !== 'manual').map((k) => Tele.SHORT[k]).join(', ') || 'só link manual'}`] },
    { key: 'aniversarios', href: '/marketing/aniversarios', title: 'Mensagem de aniversário', desc: 'No dia do aniversário, o paciente recebe uma mensagem carinhosa da equipe pelo WhatsApp (ou e-mail).', status: egc.bdayOn ? ['realizada', `Ligada · a partir das ${egc.bdayHour}h`] : ['cancelada', 'Desligada'] },
    { key: 'pesquisa', href: '/configuracoes/pesquisa', title: 'Pesquisa de satisfação', desc: 'Nota de 0 a 10 depois da sessão, com comentário; NPS em Relatórios e aviso imediato quando a nota é baixa.', status: egc.surveyOn ? ['realizada', `Ligada · ${egc.surveyDelayH}h depois da sessão · a cada ${egc.surveyEveryDays} dias`] : ['cancelada', 'Desligada'] },
    { key: 'locacao', href: '/configuracoes/locacao', title: 'Locação de espaços', desc: 'Aluguel de consultórios, salas e auditórios por hora, período, diária ou plano mensal com mensalidade; integrado ao financeiro.', status: rtc.enabled ? ['realizada', 'Ligado · menu Locação'] : ['cancelada', 'Desligado'] },
    { key: 'portal', href: '/configuracoes/portal', title: 'Portal do paciente', desc: 'Área do paciente instalável no celular: sessões (confirmar, remarcar, cancelar), Pix, recibos, termos e exercícios. Entrada pelo WhatsApp.', status: ptl.enabled ? ['realizada', 'Ligado · /paciente'] : ['cancelada', 'Desligado'] },
    { key: 'sessao-ia', href: '/configuracoes/sessao-ia', title: 'IA na sessão', desc: 'Grava a sessão com autorização do paciente, transcreve e escreve o rascunho da evolução para revisar antes de salvar no prontuário.', status: sai.enabled ? ['realizada', `Liberada · transcrição: ${sai.sttProvider === 'groq' ? 'Groq' : sai.sttProvider === 'openai' ? 'OpenAI' : 'outro serviço'}`] : ['cancelada', 'Desligada'] },
    { key: 'documentos', href: '/configuracoes/documentos', title: 'Documentos psicológicos', desc: 'Modelos de declaração, atestado, relatório, laudo e parecer (Res. CFP 06/2019), emitidos com assinatura eletrônica e código de verificação.', status: ['confirmada', '5 modelos editáveis'] },
    { key: 'termos', href: '/configuracoes/termos', title: 'Termos e documentos', desc: 'Termo de consentimento, contrato terapêutico e autorização de gravação/IA que o paciente aceita por link.', status: ['confirmada', 'Modelos editáveis · aceite com data, hora e IP'] },
    { key: 'privacidade', href: '/configuracoes/privacidade', title: 'Privacidade e LGPD', desc: 'Prazo de guarda do prontuário, limpeza automática de contatos antigos do CRM e anonimização.', status: ['confirmada', 'Prontuário: mínimo 5 anos (CFP)'] },
    {
      key: 'acessos', href: '/configuracoes/acessos', title: 'Registro de acessos',
      desc: 'Quem acessou o quê e quando: logins, prontuários, alterações e integrações.',
      status: ['confirmada', `${today.n} registro(s) hoje${lastAccess ? ` · último: ${lastAccess.name || 'sistema'} ${brDateTime(lastAccess.created_at)}` : ''}`],
    },
  ];
  if (master) {
    const bc = await Backup.config(); const lastB = await one("SELECT status, started_at FROM backup_runs WHERE dest = 'drive' ORDER BY id DESC LIMIT 1");
    items.push({ key: 'backup', href: '/configuracoes/backup', title: 'Backup', desc: 'Cópias de segurança no Google Drive: manual e automático (diário, semanal, mensal), juntos ou separados, e restauração.',
      status: !Backup.connected(bc) ? ['cancelada', 'Google Drive não conectado'] : bc.error || lastB?.status === 'erro' ? ['falta', 'Último backup falhou'] : ['realizada', lastB ? `Último: ${brDateTime(lastB.started_at)}` : 'Conectado · nenhum backup ainda'] });
  }
  return items;
}

r.get('/', async (req, res) => {
  const master = await Maint.ensureMaster(req.user.id);
  const items = await statusItems({ master });
  if (master) {
    const d = await one('SELECT (SELECT COUNT(*) FROM patients WHERE demo = 1) demo, (SELECT COUNT(*) FROM maint_backups) bk');
    items.push({ key: 'dados', href: '/configuracoes/dados', title: 'Dados e demonstração', desc: 'Limpar pacientes, agenda, financeiro e CRM, excluir usuários, cópias de segurança e dados de exemplo para apresentar.',
      status: d.demo ? ['agendada', `Demonstração carregada · ${d.demo} pacientes de exemplo`] : ['confirmada', `Somente master · ${d.bk} cópia(s) de segurança`] });
  }

  send(res, page(req, {
    title: 'Configurações', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Administração</p><h1>Configurações</h1><p class="muted">Integrações do sistema e auditoria.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/usuarios">Usuários</a></div></header>
    <div class="cfg-grid">${items.map((it) => html`<a class="card cfg-item" href="${it.href}">
      <span class="cfg-ic">${ic(it.key)}</span>
      <div><h2>${it.title}</h2><p class="muted small">${it.desc}</p><span class="badge b-${it.status[0]}">${it.status[1]}</span></div>
      <span class="cfg-go" aria-hidden="true">›</span></a>`)}</div>`,
  }));
});

export default r;
