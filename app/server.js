import crypto from 'node:crypto';
import * as Tenancy from './lib/tenancy.js';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate } from './lib/db.js';
import * as Platform from './routes/platform.js';
import * as Brand from './lib/brand.js';
import * as Modules from './lib/modules.js';
import { FEATURES, HELPBOT } from './lib/html.js';
import * as Billing from './lib/billing.js';
import * as HelpBot from './lib/helpbot.js';
import { ROLES } from './lib/perm.js';
import { referralSettings } from './routes/referral.js';
import { support } from './routes/support.js';
import * as Tickets from './lib/tickets.js';
import * as PlatComm from './lib/platcomm.js';
import * as PlatCRM from './lib/platcrm.js';
import * as ErrorPages from './lib/errorpages.js';
import * as Briefing from './lib/briefing.js';
import { gate as billingGate, features as planFeatures, settings as subscriptionSettings } from './routes/subscription.js';
import { autoLogin } from './routes/signup.js';
import { settings as brandSettings, logoRoute } from './routes/brand.js';
import { domainSettings } from './routes/domain.js';
import * as Domains from './lib/domains.js';
import { loadUser, requireUser, checkOrigin } from './lib/auth.js';
import { bare, html } from './lib/html.js';
import { flash } from './lib/router.js';
import authRoutes from './routes/auth.js';
import dashRoutes from './routes/dashboard.js';
import patientRoutes from './routes/patients.js';
import agendaRoutes from './routes/agenda.js';
import financeRoutes from './routes/finance.js';
import exerciseRoutes, { portal } from './routes/exercises.js';
import accountRoutes from './routes/account.js';
import userRoutes, { acessos } from './routes/users.js';
import configRoutes from './routes/config.js';
import maintRoutes, { requireMaster } from './routes/maint.js';
import backupRoutes from './routes/backup.js';
import recepcaoRoutes, { settings as flowSettings } from './routes/recepcao.js';
import * as Flow from './lib/flow.js';
import { privacidade, termos } from './routes/legal.js';
import monitorRoutes, { health, watcher } from './routes/monitor.js';
import { publicView as consentView, publicDecide as consentDecide, internal as consentRoutes, settings as consentSettings } from './routes/consent.js';
import privacyRoutes from './routes/privacy.js';
import waitlistRoutes, { settings as waitlistSettings } from './routes/waitlist.js';
import * as Waitlist from './lib/waitlist.js';
import * as SessionAI from './lib/sessionai.js';
import sessionAiRoutes, { settings as sessionAiSettings } from './routes/sessionai.js';
import portalRoutes, { staff as portalStaff, settings as portalSettings } from './routes/portal.js';
import rentalRoutes, { settings as rentalSettings } from './routes/rental.js';
import * as Rental from './lib/rental.js';
import * as Gateway from './lib/gateway.js';
import * as Notify from './lib/notify.js';
import * as Engage from './lib/engage.js';
import * as Scales from './lib/scales.js';
import * as RL from './lib/ratelimit.js';
import * as Nfse from './lib/nfse.js';
import { settings as nfseSettings, notes as nfseNotes, mySettings as nfseMine } from './routes/nfse.js';
import { settings as teleSettings, account as teleAccount, staff as teleStaff, patient as telePatient } from './routes/tele.js';
import { staff as scaleStaff, publicScale } from './routes/scales.js';
import { birthdays as engageBirthdays, survey as engageSurvey, publicSurvey, followup as surveyFollowup } from './routes/engage.js';
import { settings as notifySettings, publicLink as notifyLink } from './routes/notify.js';
import { webhook as gatewayWebhook, webhookMercadoPago, actions as gatewayActions, settings as gatewaySettings } from './routes/gateway.js';
import { publicTv, settings as tvSettings, qrRedirect, publicReport } from './routes/tv.js';
import psyDocRoutes, { publicDoc, publicDocPdf, verifyPage, cloudReturn, settings as psyDocSettings } from './routes/psydocs.js';
import { settings as icpCloudSettings } from './routes/icpcloud.js';
import marketingRoutes, { publicOptOut } from './routes/marketing.js';
import { pub as cardsPublic, admin as cardsAdmin } from './routes/cards.js';
import { settings as insSettings, patients as insPatients, sheets as insSheets, billing as insBilling } from './routes/insurance.js';
import * as Reactivation from './lib/reactivation.js';
import { publicBooking, settings as bookingSettings } from './routes/booking.js';
import * as Privacy from './lib/privacy.js';
import * as Monitor from './lib/monitor.js';
import * as Backup from './lib/backup.js';
import escalaRoutes from './routes/escala.js';
import crmRoutes from './routes/crm.js';
import reportsRoutes from './routes/reports.js';
import { admin as agentAdmin, team as agentTeam } from './routes/agente.js';
import { account as googleAccount, admin as googleAdmin, icalFeed } from './routes/google.js';
import { admin as waAdmin, webhook as waWebhook, cron as waCron, siteLink } from './routes/whatsapp.js';
import { startScheduler as startWhatsApp } from './lib/whatsapp.js';
import { requirePerm } from './lib/perm.js';
import { middleware as notes } from './lib/notes.js';
import * as Live from './lib/live.js';
import * as Fin from './lib/fin.js';
import * as Sites from './lib/sites.js';
import * as Dir from './lib/directory.js';
import { router as bemRouter } from './routes/bem.js';
import { admin as bemAdmin } from './routes/bemadmin.js';
import * as SitePub from './routes/sitepub.js';
import { admin as siteAdmin } from './routes/siteadmin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);

// ---- segurança + bloqueio de indexação em TODAS as respostas ----
// A página de agendamento pode ser exibida dentro do site da clínica (seção “Agende”); o resto do sistema, nunca.
// Endereços da plataforma (criar conta, entrar na minha clínica) enviam o formulário e redirecionam para o endereço da clínica
function formAction(req) {
  if (!Tenancy.multi() || !Tenancy.platformHosts().has(String(req.hostname || '').toLowerCase())) return "'self'";
  const b = Tenancy.baseDomain();
  return `'self' https://*.${b}${process.env.NODE_ENV === 'production' ? '' : ` http://*.${b}:*`}`;
}
app.use((req, res, next) => {
  const EMBED_ORIGINS = String(Tenancy.env('EMBED_ORIGINS') || '').trim(); // sites da clínica que podem exibir o agendamento
  const embeddable = req.path === '/agendar' || req.path.startsWith('/agendar/');
  res.set({
    'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet, noimageindex',
    'X-Content-Type-Options': 'nosniff',
    ...(embeddable ? {} : { 'X-Frame-Options': 'DENY' }),
    'Referrer-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(self), microphone=(self), display-capture=(self), fullscreen=(self), geolocation=(), interest-cohort=()',
    'Content-Security-Policy': `default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; script-src 'self'; form-action ${formAction(req)}; frame-ancestors ${embeddable ? `'self' ${EMBED_ORIGINS}` : "'none'"}; base-uri 'none'`,
  });
  if (req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.get('/robots.txt', async (req, res, next) => {
  if (Tenancy.multi() && (Dir.isHost(req.hostname) || (await Sites.resolveHost(req.hostname).catch(() => undefined)) !== undefined)) return next(); // site da clínica e Bem-Estar Mental: robots próprio
  res.type('text/plain').send('User-agent: *\nDisallow: /\n');
});
app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '7d', index: false }));

// ---------- Mentez: qual clínica é esta requisição ----------
// O Caddy (rede interna do Docker) pergunta se pode emitir o certificado HTTPS de um endereço.
app.get('/_mentez/tls', (req, res, next) => {
  if (!Tenancy.multi() || req.get('x-forwarded-for')) return next(); // só chamadas internas, sem passar pelo proxy
  // Ambiente de testes (dev.mentez.com.br e *.dev.mentez.com.br): quem decide é o app de testes, na rede interna
  const dom = String(req.query.domain || '').toLowerCase(); const devBase = `dev.${Tenancy.baseDomain()}`;
  if (process.env.MENTEZ_ENV !== 'dev' && (dom === devBase || dom.endsWith(`.${devBase}`))) {
    return fetch(`${process.env.MENTEZ_DEV_INTERNAL || 'http://app-dev:3000'}/_mentez/tls?domain=${encodeURIComponent(dom)}`, { signal: AbortSignal.timeout(5000) })
      .then((r) => res.sendStatus(r.ok ? 200 : 404), () => res.sendStatus(404));
  }
  Tenancy.allowCertificate(req.query.domain).then(async (ok) => res.sendStatus(ok || Dir.isHost(req.query.domain) || await Sites.allowCertificate(req.query.domain) ? 200 : 404), () => res.sendStatus(404));
});
app.get('/_mentez/saude', (_req, res) => res.json({ ok: true })); // verificação do contêiner
// WhatsApp da Mentez (instância da plataforma): mensagens recebidas → conversas no Painel. Só pela rede interna.
app.post('/_mentez/plataforma/whatsapp/:secret', express.json({ limit: '5mb' }), async (req, res) => {
  if (!Tenancy.multi() || req.get('x-forwarded-for')) return res.sendStatus(404);
  const want = await PlatComm.hookSecret().catch(() => '');
  const got = String(req.params.secret || '');
  if (!want || got.length !== want.length || !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want))) return res.sendStatus(404);
  try { res.json(await PlatCRM.handleWebhook(req.body, PlatComm.INSTANCE)); } catch (e) { console.error('whatsapp mentez (recebida):', e.message); res.status(500).json({ ok: false }); }
});
// Chamadas internas da Evolution (rede do Docker): /_mentez/t/<clínica>/webhooks/... → a clínica pelo caminho,
// porque o Host interno (app:3000) não identifica a clínica. Só sem passar pelo proxy (sem X-Forwarded-For).
app.use((req, res, next) => {
  const m = /^\/_mentez\/t\/([a-z0-9-]{3,40})(\/webhooks\/.*)$/.exec(req.url);
  if (!m) return next();
  if (!Tenancy.multi() || req.get('x-forwarded-for')) return res.sendStatus(404);
  req.mzSlug = m[1]; req.url = m[2];
  next();
});
// Bem-Estar Mental (bemestarmental.com.br): diretório de psicólogos
app.use((req, res, next) => (Tenancy.multi() && Dir.isHost(req.hostname) ? bemRouter(req, res, next) : next()));
// Sites das clínicas (Marketing → Site): <nome>.bemestarmental.com.br ou domínio próprio do site
app.use(async (req, res, next) => {
  if (!Tenancy.multi()) return next();
  const host = String(req.hostname || '').toLowerCase();
  if (Tenancy.platformHosts().has(host) || req.mzSlug) return next();
  let v;
  try { v = await Sites.resolveHost(host); } catch (e) { return next(e); }
  if (v === undefined) return next();
  if (v?.redirect) return res.redirect(301, `https://${v.redirect}${req.originalUrl}`);
  if (!v?.t || v.t.status !== 'ativa') return res.status(404).set('Cache-Control', 'no-store').send(ErrorPages.mentez404(req, { title: 'Este site não existe (ou saiu do ar).', text: 'Confira o endereço digitado. Se você é o profissional responsável, acesse Marketing → Site no seu sistema.' }));
  Tenancy.run(v.t, () => SitePub.handle(req, res, next));
});
app.use(async (req, res, next) => {
  if (!Tenancy.multi()) return next();
  const host = String(req.hostname || '').toLowerCase();
  if (Tenancy.platformHosts().has(host)) return Platform.handle(req, res, next);
  let t = null;
  try { t = req.mzSlug ? await Tenancy.bySlug(req.mzSlug) : await Tenancy.byHost(host); } catch (e) { return next(e); }
  // endereço antigo de uma clínica que trocou de endereço: leva ao novo (avisos internos da Evolution seguem atendidos)
  if (!t) {
    const old = req.mzSlug || Tenancy.slugOfHost(host);
    const now = old ? await Tenancy.slugAlias(old).catch(() => null) : null;
    if (now && req.mzSlug) { t = await Tenancy.bySlug(now); }
    else if (now) return res.redirect(301, `https://${now}.${Tenancy.baseDomain()}${req.originalUrl}`);
  }
  if (!t) return res.status(404).send(ErrorPages.mentez404(req, { title: 'Não encontramos esta clínica.', text: 'Nenhuma clínica usa este endereço. Confira o link recebido; se a clínica trocou de endereço, peça o link novo a ela.' }));
  if (t.status !== 'ativa') return res.status(403).send(String(bare('Acesso suspenso', html`<div class="center-card"><h1>Acesso temporariamente suspenso</h1><p>O acesso a esta clínica está suspenso. Fale com a administração da clínica.</p></div>`)));
  // domínio próprio só nos planos com personalização; fora deles, volta ao endereço da Mentez
  if (!req.mzSlug && !Tenancy.slugOfHost(host) && !(await Brand.canCustomize(t).catch(() => true))) return res.redirect(302, `https://${t.slug}.${Tenancy.baseDomain()}${req.originalUrl}`);
  Tenancy.run(t, next); // tudo o que vem depois (banco, chaves, caches) é desta clínica
});
app.use(Brand.middleware); // identidade da clínica (nome, logo, cores) disponível para todas as páginas
// Agendamento on-line dentro do site da clínica (iframe): libera o site cadastrado na Identidade (com e sem www)
// e os endereços extras de EMBED_ORIGINS. Calculado aqui, já com a clínica identificada.
app.use(async (req, res, next) => {
  if (!(req.path === '/agendar' || req.path.startsWith('/agendar/'))) return next();
  const site = String(Brand.get()?.site || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
  const list = [...String(Tenancy.env('EMBED_ORIGINS') || '').split(/[\s,]+/).filter((o) => /^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(o)),
    ...(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(site) ? [`https://${site}`, `https://www.${site}`] : [])];
  list.push(...await Sites.siteOrigins().catch(() => [])); // site da clínica feito na Mentez (Marketing → Site)
  const csp = String(res.get('Content-Security-Policy') || '');
  if (csp) res.set('Content-Security-Policy', csp.replace(/frame-ancestors [^;]*/, `frame-ancestors 'self'${list.length ? ` ${[...new Set(list)].join(' ')}` : ''}`));
  next();
});
// Página “sem internet” da clínica (guardada pelo aplicativo para quando a conexão cair)
app.get('/offline', (req, res, next) => ErrorPages.offlinePage().then((h) => res.set('Cache-Control', 'no-cache').type('html').send(h), next));
app.get('/_mentez/entrar', (req, res, next) => autoLogin(req, res).catch(next)); // entrada automática logo depois de criar a conta
app.use(billingGate); // Mentez: teste grátis, mensalidade em dia ou acesso restrito à tela de assinatura
app.get(/^\/marca\/(logo|logo-escuro|simbolo|simbolo-escuro|favicon|foto)$/, (req, res, next) => { req.params.tipo = req.params[0]; logoRoute(req, res).catch(next); });
// App instalável (PWA) e notificações push
app.get('/sw.js', (_req, res) => res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }).type('application/javascript').sendFile(path.join(__dirname, 'public', 'sw.js')));
app.get('/manifest.webmanifest', (_req, res) => res.set('Cache-Control', 'no-cache').type('application/manifest+json').send(JSON.stringify(Brand.manifest()))); // nome e ícones da clínica
app.get('/favicon.ico', (_req, res) => res.redirect(302, Brand.icon('favicon.png')));

app.use(/^\/suporte(\/|$)/, express.urlencoded({ extended: true, limit: '9mb', parameterLimit: 200 })); // chamados com anexos
app.use(express.urlencoded({ extended: true, limit: '400kb', parameterLimit: 3000 }));
app.use(checkOrigin);
app.use(flash);
app.use(Live.middleware); // alterações → aviso ao vivo para todas as páginas abertas
app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// Proteções das páginas públicas: limite geral por IP, limites mais apertados nos envios que disparam
// mensagens (código no WhatsApp) e armadilha para robôs nos formulários públicos.
app.use(['/tc', '/s', '/e', '/l', '/t', '/agendar', '/cartao', '/links', '/paciente', '/r', '/d', '/v', '/q', '/p', '/wa', '/sair'], RL.limit({ name: 'publico', windowMs: 60e3, max: 240 }));
app.post(/^\/tc\/[^/]+\/sinal$/, RL.limit({ name: 'sinal', windowMs: 60e3, max: 900 }));
app.post('/agendar/dados', RL.limit({ name: 'agendar', windowMs: 10 * 60e3, max: 20 }), RL.botGuard);
app.post('/paciente/entrar', RL.limit({ name: 'portal-codigo', windowMs: 10 * 60e3, max: 15 }), RL.botGuard);
app.post('/paciente/entrar/codigo', RL.limit({ name: 'portal-confere', windowMs: 10 * 60e3, max: 30 }));
app.post(/^\/s\/[\w.-]+$/, RL.botGuard);
app.post(/^\/e\/[\w.-]+$/, RL.botGuard);
// Portal do paciente (acesso por link seguro, sem login)
app.use('/p', portal);
app.get('/ical/:file', icalFeed);
app.post('/webhooks/whatsapp/:secret', express.json({ limit: '2mb' }), waWebhook);
app.post('/webhooks/cobranca/asaas', express.json({ limit: '1mb' }), (req, res, next) => gatewayWebhook(req, res).catch(next));
app.post('/webhooks/cobranca/mercadopago', express.json({ limit: '1mb' }), (req, res, next) => webhookMercadoPago(req, res).catch(next));
app.get('/wa', (req, res, next) => siteLink(req, res).catch(next));
app.get('/saude', (req, res, next) => health(req, res).catch(next));
app.get('/saude/vigia', (req, res, next) => watcher(req, res).catch(next));
app.get('/t/:token', (req, res, next) => consentView(req, res).catch(next));
app.post('/t/:token', (req, res, next) => consentDecide(req, res).catch(next));
app.get('/privacidade', privacidade);
app.get('/termos', termos);
app.use('/tv', publicTv); // TV da recepção (sem login; conectada por código)
app.get('/q/:id', (req, res, next) => qrRedirect(req, res).catch(next)); // QR code das campanhas da TV
app.get('/r/:token', (req, res, next) => publicReport(req, res).catch(next)); // relatório do parceiro (link com código)
app.all('/sair/:tok', (req, res, next) => (['GET', 'POST'].includes(req.method) ? publicOptOut(req, res).catch(next) : next())); // não receber mais convites de retorno
app.get('/d/:token', (req, res, next) => publicDoc(req, res).catch(next));
app.get('/d/:token/pdf', (req, res, next) => publicDocPdf(req, res).catch(next)); // documento psicológico (link pessoal do paciente)
app.get('/v/:code', (req, res, next) => verifyPage(req, res).catch(next)); // verificação de documento
app.use('/paciente', portalRoutes); // portal do paciente (login próprio, pelo WhatsApp)
app.use('/tc', telePatient); // teleconsulta própria: sala do paciente (link da sessão)
app.use('/e', publicScale); // escalas (PHQ-9, GAD-7): link do paciente
app.use('/s', publicSurvey); // pesquisa de satisfação (link do paciente)
app.use('/l', notifyLink); // lembrete por e-mail/SMS: confirmar ou remarcar
app.use('/agendar', publicBooking); // agendamento online pelo paciente
app.use(cardsPublic); // Marketing: cartão digital (/cartao) e link na bio (/links)
app.get('/tarefas/lembretes/:token', (req, res, next) => waCron(req, res).catch(next));

app.use(loadUser);
app.use(authRoutes);
app.use(requireUser);
app.use((req, res, next) => planFeatures(req, res, next).catch(next)); // recursos que o plano da clínica não inclui
// Canal ao vivo (SSE) e reserva por consulta periódica
app.get('/live', (req, res, next) => Live.stream(req, res).catch(next));
app.get('/live/since', (req, res, next) => Live.since(req, res).catch(next));
app.use(notes);
// Módulos ligáveis (menu): relê a configuração no máximo a cada 30 s
const featuresAt = Tenancy.scoped({ at: 0 }); // por clínica
app.use((req, res, next) => { if (Date.now() - featuresAt.at > 30e3) { featuresAt.at = Date.now(); Promise.all([Rental.config(), Modules.exercisesOn()]).then(() => next(), () => next()); } else next(); });
app.use('/conta/teleconsulta', teleAccount);
app.use('/conta/fiscal/nfse', (req, res, next) => (['admin', 'psicologo'].includes(req.user?.role) ? next() : res.status(403).send('Sem permissão')), nfseMine);
app.use('/teleconsulta', teleStaff);
app.use('/conta', googleAccount);
app.use('/conta', accountRoutes);
// O botão do assistente só aparece quando ele está ligado e configurado no Painel
const hbAt = { at: 0 };
app.use((req, res, next) => { if (Tenancy.multi() && Date.now() - hbAt.at > 60e3) { hbAt.at = Date.now(); HelpBot.config().then((c) => { HELPBOT.on = HelpBot.ready(c); }, () => {}).finally(next); } else next(); });
// Assistente de ajuda (chat): só a dúvida, a tela atual, o perfil e os recursos do plano vão para a IA da Mentez
app.post('/ajuda/chat', express.json({ limit: '40kb' }), async (req, res) => {
  try {
    const t = Tenancy.current();
    const feats = t ? await Billing.featuresOf(t) : [];
    const ctx = { slug: t?.slug, userId: req.user.id, role: ROLES[req.user.role]?.label || req.user.role, clinic: Brand.get().name, page: String(req.body?.page || '/').slice(0, 120),
      features: feats.map((k) => Billing.FEATURES[k]).filter(Boolean).join('; '), contact: await Billing.siteContact().catch(() => 'contato@mentez.com.br') };
    res.json(await HelpBot.reply({ messages: req.body?.messages, ctx, who: `${t?.slug || '-'}:${req.user.id}` }));
  } catch (e) { console.error('ajuda/chat:', e.message); res.status(500).json({ ok: false, error: 'O assistente não respondeu agora. Tente de novo.' }); }
});
// Endereços antigos (antes de Configurações) → novos
app.get(/^\/usuarios\/(google|whatsapp|agente|acessos)(\/.*)?$/, (req, res) => res.redirect(301, req.originalUrl.replace(/^\/usuarios\//, '/configuracoes/')));
app.use('/configuracoes/identidade', requirePerm('usuarios'), brandSettings);
app.use('/configuracoes/assinatura', subscriptionSettings);
app.use('/configuracoes/indicacao', referralSettings);
app.use('/suporte', support);
app.use('/configuracoes/dominio', requirePerm('usuarios'), domainSettings);
app.use('/configuracoes/google', requirePerm('usuarios'), googleAdmin);
app.use('/configuracoes/whatsapp', requirePerm('usuarios'), waAdmin);
app.use('/configuracoes/agente', requirePerm('usuarios'), agentAdmin);
app.get('/configuracoes/acessos', requirePerm('usuarios'), (req, res, next) => acessos(req, res).catch(next));
app.use('/configuracoes/dados', requirePerm('usuarios'), requireMaster, maintRoutes);
app.use('/configuracoes/backup', requirePerm('usuarios'), requireMaster, backupRoutes);
app.use('/configuracoes/atendimento', requirePerm('usuarios'), flowSettings);
app.use('/configuracoes/monitoramento', requirePerm('usuarios'), monitorRoutes);
app.use('/configuracoes/termos', requirePerm('usuarios'), consentSettings);
app.use('/configuracoes/privacidade', requirePerm('usuarios'), privacyRoutes);
app.use('/configuracoes/lista-espera', requirePerm('usuarios'), waitlistSettings);
app.use('/configuracoes/tv', requirePerm('usuarios'), tvSettings);
app.use('/configuracoes/documentos', requirePerm('usuarios'), psyDocSettings);
app.use('/configuracoes/agendamento-online', requirePerm('usuarios'), bookingSettings);
app.use('/configuracoes/sessao-ia', requirePerm('usuarios'), sessionAiSettings);
app.use('/configuracoes/portal', requirePerm('usuarios'), portalSettings);
app.use('/configuracoes/locacao', requirePerm('usuarios'), rentalSettings);
app.use('/configuracoes/cobranca', requirePerm('usuarios'), gatewaySettings);
app.use('/configuracoes/lembretes', requirePerm('usuarios'), notifySettings);
app.use('/configuracoes/teleconsulta', requirePerm('usuarios'), teleSettings);
app.use('/configuracoes/nfse', requirePerm('usuarios'), nfseSettings);
app.use('/configuracoes/assinatura', requirePerm('usuarios'), icpCloudSettings);
app.use('/configuracoes/convenios', requirePerm('usuarios'), insSettings);
app.use('/configuracoes/aniversarios', requirePerm('usuarios'), engageBirthdays);
app.use('/configuracoes/pesquisa', requirePerm('usuarios'), engageSurvey);
app.use('/termos', requirePerm('cadastro', 'prontuario'), consentRoutes);
app.use('/configuracoes', requirePerm('usuarios'), configRoutes);
app.use('/usuarios', requirePerm('usuarios'), userRoutes);
app.use('/pacientes', requirePerm('cadastro'), patientRoutes);
app.use('/documentos', requirePerm('prontuario'), psyDocRoutes);
app.get('/assinatura/retorno', requirePerm('prontuario'), (req, res, next) => cloudReturn(req, res).catch(next)); // volta da certificadora (certificado em nuvem)
app.use('/escalas', requirePerm('prontuario'), scaleStaff);
app.use('/sessao-ia', requirePerm('prontuario'), sessionAiRoutes);
app.use('/portal-paciente', requirePerm('cadastro'), portalStaff);
app.use('/locacao', requirePerm('agenda'), rentalRoutes);
app.use('/financeiro/cobranca-online', requirePerm('financeiro', 'meufin'), gatewayActions);
app.use('/financeiro/notas', requirePerm('financeiro', 'meufin'), nfseNotes);
app.use('/financeiro/convenios', requirePerm('financeiro'), insBilling);
app.use('/recepcao', requirePerm('agenda'), recepcaoRoutes);
app.use('/relatorios/satisfacao', requirePerm('financeiro', 'meufin'), surveyFollowup);
app.use('/relatorios', requirePerm('financeiro', 'meufin'), reportsRoutes);
app.use('/agenda/lista-espera', requirePerm('agenda'), waitlistRoutes);
app.use('/agenda', requirePerm('agenda'), agendaRoutes);
app.use('/marketing/site', requirePerm('usuarios'), siteAdmin); // site da clínica (Marketing → Site)
app.use('/marketing/bem-estar', requirePerm('agenda'), bemAdmin); // perfil no Bem-Estar Mental
app.use('/marketing', requirePerm('agenda'), cardsAdmin, marketingRoutes);
app.use('/convenios', requirePerm('cadastro', 'agenda'), insPatients, insSheets);
app.use('/escala', requirePerm('agenda'), escalaRoutes);
app.use('/atendimento', requirePerm('agenda'), agentTeam);
app.use('/crm', requirePerm('agenda'), crmRoutes);
app.use('/financeiro', requirePerm('financeiro', 'meufin'), financeRoutes);
app.use('/exercicios', requirePerm('prontuario'), (req, res, next) => (FEATURES.exercicios ? next() : res.redirect('/configuracoes/exercicios')), exerciseRoutes);
app.use(dashRoutes);

// Folhas em PDF dos cadernos (somente usuárias logadas)
const FOLHAS = path.join(__dirname, 'private');
app.get('/folhas/:dir/:file', requirePerm('prontuario'), (req, res) => {
  const { dir, file } = req.params;
  if (!/^folhas(-ilustradas|-tematicas)?$/.test(dir) || !/^[a-z0-9-]+\.pdf$/.test(file)) return res.sendStatus(404);
  const p = path.join(Tenancy.filesDir(FOLHAS), dir, file);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.sendFile(p);
});

app.use((req, res) => res.status(404).send(ErrorPages.clinic404(req)));
app.use((err, req, res, _next) => {
  if (err.status === 403) {
    return res.status(403).send(String(bare('Acesso restrito', html`<div class="center-card"><h1>Acesso restrito</h1><p>Seu perfil de acesso não permite abrir esta página.</p><p><a href="/">Voltar ao início</a></p></div>`)));
  }
  console.error(err);
  Monitor.recordError(err, req.path);
  res.status(500).send(String(bare('Erro', html`<div class="center-card"><h1>Algo deu errado</h1><p>Tente novamente em instantes.</p><p><a href="/">Voltar ao início</a></p></div>`)));
});

const port = Number(process.env.PORT || 3000);
// Repete uma tarefa automática para cada clínica ativa (ou para a clínica única, sem a plataforma)
const every = (ms, fn, label, first = null) => {
  const go = () => Tenancy.forEachTenant(() => Brand.load().then(() => fn()).catch((e) => console.error(`${label}:`, e.message)), label);
  if (first !== null) setTimeout(go, first).unref();
  setInterval(go, ms).unref();
};
async function boot() {
  if (Tenancy.multi()) {
    await Tenancy.migratePlatform();
    await Billing.migrate();
    await Domains.migrate();
    await Sites.migratePlatform();
    await Dir.migrate();
    await Tenancy.forEachTenant(() => migrate(), 'migração'); // cada clínica no seu banco, sempre no esquema atual
  } else await migrate();
}
// Atualização sem erro para quem está usando: ao receber o pedido de desligamento (nova versão subindo),
// para de aceitar conexões novas, deixa terminar as que estão em andamento e sai em poucos segundos
// (sem isso o Docker esperava 10 s e derrubava à força). O Caddy segura e repete os acessos enquanto a nova versão liga.
let httpServer = null; let stopping = false;
function shutdown(sig) {
  if (stopping) return; stopping = true;
  console.log(`${sig}: encerrando com calma (nova versão subindo)`);
  if (!httpServer) process.exit(0);
  httpServer.close(() => process.exit(0));
  httpServer.closeIdleConnections?.();
  setTimeout(() => httpServer.closeAllConnections?.(), 3000).unref(); // conexões longas (atualização ao vivo) reconectam sozinhas
  setTimeout(() => process.exit(0), 6000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
boot()
  .then(() => console.log(Tenancy.multi() ? 'Mentez: plataforma e clínicas prontas.' : 'Banco de dados pronto.'))
  .catch((e) => console.error('Falha ao preparar o banco:', e.message))
  .finally(() => (httpServer = app.listen(port, () => {
    console.log(`Sistema rodando na porta ${port}`);
    startWhatsApp();
    if (Tenancy.multi()) { const dt = () => Domains.tick().catch((e) => console.error('domínios:', e.message)); setTimeout(dt, 60e3).unref(); setInterval(dt, Number(process.env.DOMAIN_TICK_MS) || 10 * 60e3).unref(); }
    every(3600e3, () => Live.cleanup(), 'live', 5e3);
    every(6 * 3600e3, () => Fin.ensureRecurring(), 'recorrentes', 10e3);
    every(Number(process.env.BACKUP_TICK_MS) || 10 * 60e3, () => Backup.tick(), 'backup', Number(process.env.BACKUP_TICK_MS) || 90e3);
    every(Number(process.env.FLOW_TICK_MS) || 10 * 60e3, () => Flow.autoReminders(), 'lembrete de pagamento');
    every(Number(process.env.MONITOR_TICK_MS) || 2 * 60e3, () => Monitor.tick(), 'monitor');
    every(12 * 3600e3, () => Privacy.tick(), 'privacidade', 5 * 60e3);
    every(Number(process.env.WAITLIST_TICK_MS) || 60e3, () => Waitlist.tick(), 'lista de espera');
    every(10 * 60e3, () => SessionAI.tick(), 'IA na sessão');
    every(5 * 60e3, () => Tenancy.forEachTenant(() => Briefing.tick(), 'seu dia'), 'seu dia', 3 * 60e3); // resumo da manhã de cada profissional
    every(6 * 3600e3, () => Rental.config().then(() => Rental.tick()), 'locação', 15e3);
    every(Number(process.env.NFSE_TICK_MS) || 5 * 60e3, () => Nfse.tick(), 'NFS-e');
    every(Number(process.env.SCALES_TICK_MS) || 10 * 60e3, () => Scales.tick(), 'escalas');
    every(Number(process.env.REACT_TICK_MS) || 10 * 60e3, () => Reactivation.tick(), 'reativação');
    every(Number(process.env.ENGAGE_TICK_MS) || 5 * 60e3, () => Engage.tick(), 'aniversário/pesquisa');
    every(Number(process.env.NOTIFY_TICK_MS) || 5 * 60e3, () => Notify.tick(), 'lembretes e-mail/SMS');
    every(Number(process.env.GATEWAY_TICK_MS) || 10 * 60e3, () => Gateway.tick(), 'cobrança online');
    if (Tenancy.multi()) every(3600e3, () => Tickets.tick(), 'chamados', 120e3);
    if (Tenancy.multi()) setInterval(() => Billing.tick().catch((e) => console.error('cobrança Mentez:', e.message)), Number(process.env.MENTEZ_BILLING_TICK_MS) || 3600e3).unref(); // conferência das mensalidades
  })));
process.on('unhandledRejection', (e) => { console.error('unhandledRejection', e); Monitor.recordError(e, 'processo'); });

export default app;
