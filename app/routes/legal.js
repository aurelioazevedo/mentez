// Páginas públicas exigidas pelo Google (tela de consentimento OAuth): Política de Privacidade e Termos de Uso.
import * as Brand from '../lib/brand.js';
import { bare, html } from '../lib/html.js';
import { send } from '../lib/router.js';
import * as Tenancy from '../lib/tenancy.js';

// Dados da clínica para os textos (endereço do sistema, responsável, CRP, cidade, contatos)
function who() {
  const b = Brand.get();
  const host = (() => { try { return new URL(Tenancy.env('PUBLIC_URL') || 'https://sistema.lorrainymendes.com.br').hostname; } catch { return ''; } })();
  const resp = b.proName ? `${b.proName.replace(/^Dra?\.\s*/, '')}${b.proRole ? `, ${b.proRole.toLowerCase()}` : ''}${b.crp ? `, CRP ${b.crp}` : ''}` : b.name;
  return { b, host, resp };
}

const wrap = (req, title, body) => { const { b } = who(); return bare(title, html`<main class="legal">${b.logoUrl ? html`<a class="legal-logo" href="${b.siteUrl || '/'}"><img src="${b.logoUrl}" alt="${b.short}"></a>` : html`<p class="legal-logo brand-word">${b.short}</p>`}${body}
  <p class="muted small">Última atualização: novembro de 2026${b.email ? html` · Dúvidas: <a href="mailto:${b.email}">${b.email}</a>` : ''}${b.phone ? ` · WhatsApp ${b.phone}` : ''}</p></main>`, 'bare legal-page', req); };

export function privacidade(req, res) {
  const { b, host, resp } = who();
  send(res, wrap(req, 'Política de Privacidade', html`
  <h1>Política de Privacidade</h1>
  <p>Esta política explica como o <b>${b.appName}</b> (${host}), usado por ${b.name} e pelos profissionais autorizados, trata dados pessoais, em conformidade com a Lei Geral de Proteção de Dados (Lei 13.709/2018 — LGPD) e o Código de Ética Profissional do Psicólogo.</p>
  <h2>1. Quem é o responsável</h2>
  <p>A controladora dos dados é ${resp}${b.placeSlash ? `, ${b.placeSlash}` : ''}.${b.email ? ` Contato do encarregado: ${b.email}.` : ''}</p>
  ${b.legacy ? '' : html`<p>O sistema é fornecido pela <b>Mentez</b> (mentez.com.br), que atua como <b>operadora</b>: trata os dados apenas para prestar o serviço, conforme as instruções da clínica e o contrato, com os dados de cada clínica separados e criptografados.</p>`}
  <h2>2. Quais dados tratamos</h2>
  <ul><li><b>Pacientes:</b> nome, contato (telefone, e-mail), data de nascimento, CPF quando necessário para recibos, agenda de sessões, registros de prontuário, pagamentos e mensagens trocadas pelo WhatsApp do consultório.</li>
  <li><b>Profissionais e equipe:</b> nome, e-mail, registro profissional, foto de perfil opcional e registros de acesso ao sistema.</li>
  <li><b>Contatos que procuram o consultório:</b> nome, telefone e mensagens enviadas ao WhatsApp do consultório.</li></ul>
  <h2>3. Para que usamos</h2>
  <p>Agendamento e lembretes de sessões, registro em prontuário (obrigação profissional), emissão de recibos, controle financeiro, atendimento pelo WhatsApp e cópias de segurança. As bases legais são a tutela da saúde, o cumprimento de obrigação legal e regulatória, a execução de contrato e, quando aplicável, o consentimento do titular.</p>
  <h2>4. Dados do Google</h2>
  <p>Com autorização do próprio usuário, o sistema acessa: <b>Google Agenda</b> — para criar, atualizar e remover os eventos das sessões na agenda do profissional; e <b>Google Drive</b> — apenas para salvar e ler as cópias de segurança do sistema numa pasta criada por ele (permissão restrita aos arquivos criados pelo próprio sistema). O uso de informações recebidas das APIs do Google segue a <a href="https://developers.google.com/terms/api-services-user-data-policy" rel="noopener">Política de Dados do Usuário dos Serviços de API do Google</a>, incluindo os requisitos de Uso Limitado. Esses dados não são vendidos, não são usados para publicidade e não são usados para treinar modelos de inteligência artificial. O acesso pode ser revogado a qualquer momento no sistema ou em myaccount.google.com/permissions.</p>
  <h2>5. Com quem compartilhamos</h2>
  <p>Somente com prestadores necessários ao funcionamento, sob dever de confidencialidade: hospedagem (Hostinger), Google (Agenda e Drive), provedor de envio de mensagens do WhatsApp e serviços de inteligência artificial usados no atendimento automático pelo WhatsApp (Anthropic e, como reserva, Groq), que recebem apenas o necessário para responder às mensagens. Não vendemos dados pessoais.</p>
  <h2>6. Segurança</h2>
  <p>Acesso com senha e verificação em duas etapas opcional, permissões por função, registro de acessos, conexão criptografada (HTTPS) e criptografia dos dados mais sensíveis (prontuário, CPF, mensagens). Cópias de segurança são guardadas no Google Drive do consultório.</p>
  <h2>7. Por quanto tempo</h2>
  <p>Prontuários são mantidos pelo prazo mínimo exigido pelo Conselho Federal de Psicologia (5 anos). Demais dados, enquanto forem necessários às finalidades acima ou por obrigação legal.</p>
  <h2>8. Seus direitos</h2>
  <p>Você pode pedir confirmação, acesso, correção, anonimização, portabilidade ou eliminação dos seus dados, e revogar consentimentos, ${b.email ? `pelo e-mail ${b.email}` : 'diretamente com o consultório'}. Respondemos no prazo legal.</p>`));
}

export function termos(req, res) {
  const { b, host, resp } = who();
  send(res, wrap(req, 'Termos de Uso', html`
  <h1>Termos de Uso</h1>
  <p>O <b>${b.appName}</b> (${host}) é uma ferramenta de uso interno e restrito de ${b.name} (${resp}) e dos profissionais e colaboradores autorizados.${b.legacy ? '' : ' O sistema é fornecido pela Mentez (mentez.com.br).'}</p>
  <h2>1. Acesso</h2>
  <p>O acesso é pessoal e intransferível, feito com usuário e senha fornecidos pelo consultório. Cada pessoa vê apenas o que sua função permite, e todos os acessos ficam registrados.</p>
  <h2>2. Responsabilidades de quem usa</h2>
  <ul><li>Manter a senha em sigilo e ativar a verificação em duas etapas.</li><li>Usar os dados apenas para o atendimento e a gestão do consultório, respeitando o sigilo profissional, o Código de Ética do Psicólogo e a LGPD.</li><li>Não copiar, exportar ou compartilhar dados de pacientes fora das finalidades do consultório.</li></ul>
  <h2>3. Integrações com o Google</h2>
  <p>Ao conectar a Google Agenda ou o Google Drive, o usuário autoriza o sistema a criar e atualizar os eventos das sessões e a salvar as cópias de segurança numa pasta própria do Drive. A autorização pode ser desfeita a qualquer momento. Detalhes na <a href="/privacidade">Política de Privacidade</a>.</p>
  <h2>4. Disponibilidade</h2>
  <p>O consultório se empenha em manter o sistema disponível e com cópias de segurança, mas podem ocorrer interrupções para manutenção ou por falhas de terceiros.</p>
  <h2>5. Alterações</h2>
  <p>Estes termos podem ser atualizados; a versão vigente fica sempre nesta página.</p>`));
}
