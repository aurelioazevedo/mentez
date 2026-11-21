import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDateTime, label } from '../lib/html.js';
import { router, send, str, int } from '../lib/router.js';
import { safeEqual } from '../lib/crypto.js';
import * as W from '../lib/whatsapp.js';
import * as SiteWA from '../lib/sitewa.js';
import * as Evolution from '../lib/evolution.js';

const base = (req) => (Tenancy.env('PUBLIC_URL') || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
// Endereço do webhook de respostas: na Evolution da Mentez, pela rede interna; numa Evolution própria, pelo endereço público
const hookOf = (req, c) => (c?.managed && Tenancy.current() ? Evolution.webhookUrl(Tenancy.current().slug, c.webhookSecret) : `${base(req)}/webhooks/whatsapp/${c.webhookSecret}`);
const KIND = { aniversario: 'Aniversário', pesquisa: 'Pesquisa de satisfação', lembrete: 'Lembrete', aviso: 'Aviso (2h antes)', confirmacao: 'Confirmação', remarcacao: 'Remarcação', exercicio: 'Exercício', pagamento: 'Pagamento', cobranca: 'Cobrança', lista_espera: 'Lista de espera', teste: 'Teste', recebida: 'Recebida' };

// =====================================================================
// Administração: /configuracoes/whatsapp
// =====================================================================
export const admin = router();

admin.get('/', async (req, res) => {
  const c = await W.config();
  const state = c?.url && c?.apiKey && c?.instance ? await W.connectionState(c, true) : null;
  let instances = null; let instErr = null;
  if (c?.url && c?.apiKey) { try { instances = await W.listInstances(c); } catch (e) { instErr = e.message; } }
  const [logs, stats] = await Promise.all([
    q(`SELECT m.*, p.name, p.social_name FROM wa_messages m LEFT JOIN patients p ON p.id = m.patient_id ORDER BY m.id DESC LIMIT 40`),
    one(`SELECT SUM(direction='out' AND status='enviado') enviados, SUM(status='erro') erros, SUM(direction='in') recebidas FROM wa_messages WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`),
  ]);
  const t = c?.templates || W.DEFAULT_TEMPLATES;
  const [sw, swRoute, swStats, swNum] = await Promise.all([SiteWA.config(), SiteWA.route(), SiteWA.stats(30), SiteWA.assistantNumber()]);
  const fmtBR = (n) => { const d = String(n || '').replace(/\D/g, '').replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : n || '—'; };
  const siteLink = `${base(req)}/wa?o=site`;
  const siteCard = html`
    <section class="card" id="site"><h2>WhatsApp do site</h2>
      <p class="muted small">Os botões de WhatsApp do site, da página de links do Instagram, do cartão digital e das páginas dos e-books passam por este sistema, que encaminha a pessoa para o número escolhido aqui. A mudança vale na hora, sem mexer no site.</p>
      <form method="post" action="/configuracoes/whatsapp/site" class="stack">
        <div class="sw-modes">
          <label class="sw-mode"><input type="radio" name="mode" value="assistente" ${sw.mode === 'assistente' ? raw('checked') : ''}>
            <span><b>🤖 Automatizado — atendente virtual</b><small>Quem clica fala com o atendente virtual no número ${fmtBR(swNum)}${c?.instance ? ` (instância “${c.instance}”)` : ''}: ele tira dúvidas, agenda, remarca e transfere para a equipe quando precisa.</small></span></label>
          <label class="sw-mode"><input type="radio" name="mode" value="doutora" ${sw.mode !== 'assistente' ? raw('checked') : ''}>
            <span><b>👩‍⚕️ WhatsApp ${Brand.get().proName ? `da(o) ${Brand.get().proName}` : 'do profissional'}</b><small>Quem clica abre conversa direto com o(a) profissional, sem automação.</small></span></label>
        </div>
        <label class="fld"><span>WhatsApp do(a) profissional (com DDD)</span><input name="doctorPhone" required inputmode="tel" value="${fmtBR(sw.doctorPhone)}"></label>
        <label class="fld check"><input type="checkbox" name="fallback" value="1" ${sw.fallback ? raw('checked') : ''}><span>Se o atendente virtual estiver desligado, sem créditos ou com o WhatsApp desconectado, mandar para o WhatsApp do(a) profissional (recomendado)</span></label>
        <div class="actions"><button class="btn">Salvar</button></div>
      </form>
      <div class="sw-now ${swRoute.target}">Agora, quem clica no site vai para: <b>${swRoute.target === 'assistente' ? `atendente virtual · ${fmtBR(swRoute.phone)}` : `profissional · ${fmtBR(swRoute.phone)}`}</b>
        ${sw.mode === 'assistente' && swRoute.target === 'doutora' ? html`<br><small>Reserva ativada: ${SiteWA.REASONS[swRoute.reason] || swRoute.reason}.</small>` : ''}</div>
      <p class="small"><b>Link para usar em outros lugares</b> (bio, anúncios, QR code) — troque <code>o=site</code> pela origem para contar os cliques:</p>
      <div class="copy"><input readonly value="${siteLink}" id="sitelink"><button class="btn ghost" type="button" data-copy="#sitelink">Copiar</button><a class="btn ghost" href="/wa?o=teste" target="_blank" rel="noopener">Testar</a></div>
      ${swStats.length ? html`<h3 class="small">Cliques nos últimos 30 dias</h3><div class="tbl-wrap"><table class="tbl"><thead><tr><th>Origem</th><th>Atendente virtual</th><th>Profissional</th><th>Total</th></tr></thead>
        <tbody>${swStats.map((r) => html`<tr><td>${r.origin}</td><td>${Number(r.assistente)}</td><td>${Number(r.doutora)}</td><td><b>${Number(r.total)}</b></td></tr>`)}</tbody></table></div>`
      : html`<p class="muted small">Nenhum clique registrado ainda.</p>`}
    </section>`;
  const hookUrl = c ? hookOf(req, c) : '';
  const cronUrl = c ? `${base(req)}/tarefas/lembretes/${c.cronToken}` : '';
  const stBadge = !state ? html`<span class="badge b-cancelada">Não configurado</span>`
    : state === 'open' ? html`<span class="badge b-realizada">Conectado</span>`
      : html`<span class="badge b-falta">${state === 'close' ? 'Desconectado — leia o QR code abaixo' : state === 'connecting' ? 'Aguardando leitura do QR code' : state}</span>`;
  const cur = instances?.find((i) => i.name === c?.instance);
  const fmtNum = (n) => { const d = String(n || '').replace(/\D/g, '').replace(/^55/, ''); return d.length >= 10 ? `(${d.slice(0, 2)}) ${d.slice(2, -4)}-${d.slice(-4)}` : n || ''; };
  const stLabel = (st) => (st === 'open' ? 'conectado' : st === 'connecting' ? 'aguardando QR' : st === 'close' ? 'desconectado' : st);
  const device = !c?.url || !c?.apiKey ? '' : html`
    <section class="card wa-device" id="aparelho"><h2>Aparelho conectado</h2>
      ${instErr ? html`<p class="flash err">Não foi possível listar as instâncias da Evolution: ${instErr}</p>` : ''}
      <div class="wa-dev-grid">
        <div class="stack">
          ${instances && !c.managed ? html`<form method="post" action="/configuracoes/whatsapp/instancia" class="fld"><span>Instância usada pelo sistema</span>
            <span class="inline"><select name="instance" data-autosubmit>${!cur ? html`<option value="">— escolha —</option>` : ''}${instances.map((i) => html`<option value="${i.name}" ${i.name === c.instance ? raw('selected') : ''}>${i.name} — ${stLabel(i.status)}${i.number ? ` · ${fmtNum(i.number)}` : ''}</option>`)}</select>
            <noscript><button class="btn ghost">Usar</button></noscript></span></form>
          <details class="wa-new"><summary>+ Criar nova instância</summary>
            <form method="post" action="/configuracoes/whatsapp/instancia/nova" class="inline"><input name="name" required maxlength="60" pattern="[A-Za-z0-9][A-Za-z0-9 _.\-]*" placeholder="ex.: Consultorio"><button class="btn ghost">Criar</button></form>
          </details>` : ''}
          ${state === 'open' ? html`
            <div class="wa-ok"><b>✓ WhatsApp conectado</b>
              <span>${cur?.profileName || ''}${cur?.number ? html` · ${fmtNum(cur.number)}` : ''}</span>
              <small class="muted">${c.managed ? 'Servidor de WhatsApp da Mentez.' : `Instância “${c.instance}”.`} Mantenha o celular ligado e com internet.</small></div>
            <form method="post" action="/configuracoes/whatsapp/desconectar" data-confirm="Desconectar o WhatsApp “${c.instance}”? Os envios param até ler um novo QR code."><button class="btn ghost danger-text">Desconectar aparelho</button></form>`
          : c.instance && cur ? html`
            <ol class="wa-steps small"><li>Abra o WhatsApp no celular do consultório.</li><li>Toque em <b>⋮ Mais opções</b> (Android) ou <b>Configurações</b> (iPhone) → <b>Dispositivos conectados</b> → <b>Conectar dispositivo</b>.</li><li>Aponte a câmera para o QR code exibido aqui.</li></ol>
            <form class="inline wa-pair" data-wa-pair><input name="numero" inputmode="tel" placeholder="ou conecte pelo número: (62) 9 0000-0000"><button class="btn ghost" type="submit">Gerar código</button></form>`
          : c.instance ? html`<p class="muted small">A instância “${c.instance}” não existe na Evolution. Escolha outra ou crie uma nova.</p>` : ''}
        </div>
        ${state !== 'open' && cur ? html`<div class="wa-qr" data-wa-qr data-state="${state}">
          <div class="wa-qr-box"><img alt="QR code para conectar o WhatsApp" hidden><span class="wa-qr-msg muted small">Clique para gerar o QR code</span></div>
          <p class="wa-code" hidden></p>
          <button class="btn" type="button" data-wa-qr-btn>Gerar QR code</button>
          <small class="muted wa-qr-hint">O QR code se renova sozinho; a página atualiza quando conectar.</small>
        </div>` : ''}
      </div>
    </section>`;

  send(res, page(req, {
    title: 'WhatsApp', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>WhatsApp</h1></div><div class="ph-actions">${stBadge}<a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <section class="kpis small">
      <div class="kpi"><span>Enviadas (30 dias)</span><b>${Number(stats?.enviados || 0)}</b></div>
      <div class="kpi"><span>Respostas recebidas</span><b>${Number(stats?.recebidas || 0)}</b></div>
      <div class="kpi"><span>Falhas</span><b>${Number(stats?.erros || 0)}</b></div>
      <div class="kpi"><span>Lembretes automáticos</span><b>${c?.enabled && (c?.autoReminders || c?.secondReminder) ? [c.autoReminders ? `${c.hours}h` : '', c.secondReminder ? `${c.secondHours}h` : ''].filter(Boolean).join(' + ') + ' antes' : 'desligado'}</b></div>
    </section>
    ${!c && Evolution.enabled() ? html`<section class="card"><h2>Conectar o WhatsApp</h2><p class="muted small">A Mentez já tem um servidor de WhatsApp pronto para a clínica. Clique para preparar a conexão e depois leia o QR code com o celular da clínica.</p>
      <form method="post" action="/configuracoes/whatsapp/gerenciada"><button class="btn">Preparar conexão do WhatsApp</button></form></section>` : ''}
    ${device}
    ${siteCard}
    <form method="post" action="/configuracoes/whatsapp" class="card form-grid">
      ${c?.managed ? html`<h2 class="span2">Conexão</h2><p class="span2 muted small">O servidor do WhatsApp é da Mentez e já está configurado: basta ler o QR code em “Aparelho conectado”.</p>` : html`<h2 class="span2">Conexão com a Evolution API</h2>
      <label class="fld"><span>Endereço da Evolution</span><input name="url" type="url" required value="${c?.url || ''}" placeholder="https://evolution.suaclinica.com.br"></label>
      <label class="fld"><span>Nome da instância</span><input name="instance" required value="${c?.instance || ''}" placeholder="ex.: teste-consultorio"></label>
      <label class="fld span2"><span>Chave da API (AUTHENTICATION_API_KEY)</span><input type="password" name="apiKey" ${c?.apiKey ? '' : raw('required')} autocomplete="off" placeholder="${c?.apiKey ? 'deixe em branco para manter a atual' : 'cole a chave da Evolution'}"></label>`}
      <label class="fld check span2"><input type="checkbox" name="enabled" value="1" ${!c || c.enabled ? raw('checked') : ''}><span><b>Envios pelo WhatsApp ativados</b> (desmarque para pausar tudo)</span></label>

      <h2 class="span2">Lembrete automático</h2>
      <label class="fld check span2"><input type="checkbox" name="autoReminders" value="1" ${!c || c.autoReminders ? raw('checked') : ''}><span>Enviar lembrete automaticamente antes de cada sessão (para pacientes que autorizaram)</span></label>
      <label class="fld"><span>Antecedência</span><select name="hours">${[[2, '2 horas'], [6, '6 horas'], [12, '12 horas'], [24, '24 horas (véspera)'], [48, '48 horas']].map(([v, l]) => html`<option value="${v}" ${v === (c?.hours || 24) ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <label class="fld"><span>Enviar somente entre</span><span class="inline"><select name="windowStart">${[6, 7, 8, 9, 10].map((h) => html`<option value="${h}" ${h === (c?.windowStart ?? 8) ? raw('selected') : ''}>${h}h</option>`)}</select> e <select name="windowEnd">${[18, 19, 20, 21, 22].map((h) => html`<option value="${h}" ${h === (c?.windowEnd ?? 20) ? raw('selected') : ''}>${h}h</option>`)}</select></span></label>

      <h2 class="span2">Aviso pouco antes da sessão</h2>
      <label class="fld check span2"><input type="checkbox" name="secondReminder" value="1" ${c?.secondReminder ? raw('checked') : ''}><span>Enviar também um aviso curto pouco antes da sessão — <b>só informa o horário</b>, sem pedir confirmação nem oferecer remarcar</span></label>
      <label class="fld"><span>Enviar o aviso</span><select name="secondHours">${[[1, '1 hora antes'], [2, '2 horas antes'], [3, '3 horas antes']].map(([v, l]) => html`<option value="${v}" ${v === (c?.secondHours || 2) ? raw('selected') : ''}>${l}</option>`)}</select></label>
      <p class="fld muted small">O aviso pode sair entre 6h e 22h (para sessões cedo ou à noite). Não é enviado se o lembrete principal saiu há menos de 3 horas ou se o paciente pediu para remarcar.</p>

      <h2 class="span2">Textos das mensagens</h2>
      <p class="span2 muted small">Campos disponíveis: <code>${W.PLACEHOLDERS}</code>. Use *asteriscos* para negrito no WhatsApp. Não inclua informações clínicas.</p>
      ${Object.entries(W.TEMPLATE_LABELS).map(([k, l]) => html`<label class="fld span2"><span>${l}</span><textarea name="tpl_${k}" rows="${k === 'lembrete' ? 7 : k === 'aviso' ? 4 : 3}" maxlength="1500">${t[k]}</textarea></label>`)}
      <div class="span2 actions"><button class="btn">${c?.managed ? 'Salvar' : 'Salvar e conectar'}</button>${c?.managed ? '' : html`<span class="muted small">Ao salvar, o webhook de respostas é configurado automaticamente na Evolution.</span>`}</div>
    </form>

    ${c ? html`
    <div class="grid2">
      <section class="card"><h2>Mensagem de teste</h2>
        <form method="post" action="/configuracoes/whatsapp/teste" class="stack">
          <label class="fld"><span>WhatsApp (com DDD)</span><input name="phone" required inputmode="tel" placeholder="(62) 9 0000-0000"></label>
          <button class="btn ghost">Enviar teste</button>
        </form>
      </section>
      ${c.managed ? '' : html`<section class="card"><h2>Endereços técnicos</h2>
        <p class="small"><b>Webhook de respostas</b> (configurado automaticamente):</p>
        <div class="copy"><input readonly value="${hookUrl}" id="hook"><button class="btn ghost" type="button" data-copy="#hook">Copiar</button></div>
        <p class="small"><b>Tarefa agendada (opcional, reforço):</b> o sistema verifica os lembretes a cada 5 minutos. Para garantir mesmo quando ninguém acessa, crie em hPanel → Avançado → <b>Cron Jobs</b> um comando a cada 15 minutos:</p>
        <div class="copy"><input readonly value="${`curl -fsS ${cronUrl} > /dev/null`}" id="cron"><button class="btn ghost" type="button" data-copy="#cron">Copiar</button></div>
        <p class="muted small">Esses endereços contêm códigos secretos; não compartilhe.</p>
      </section>`}
    </div>` : ''}

    <section class="card flush"><h2 class="pad-h">Últimas mensagens</h2>
      ${logs.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Tipo</th><th>Paciente</th><th>Número</th><th>Situação</th></tr></thead>
      <tbody>${logs.map((m) => html`<tr><td>${brDateTime(m.created_at)}</td><td>${m.direction === 'in' ? '⬅ ' : '➡ '}${KIND[m.kind] || m.kind}</td>
        <td>${m.patient_id ? html`<a href="/pacientes/${m.patient_id}?aba=mensagens">${m.social_name || m.name}</a>` : '—'}</td><td>${m.phone || '—'}</td>
        <td>${m.status === 'erro' ? html`<span class="badge b-falta" title="${m.error || ''}">Erro</span> <small class="muted">${m.error || ''}</small>` : html`<span class="badge b-realizada">${m.status === 'recebido' ? 'Recebida' : 'Enviada'}</span>`}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhuma mensagem ainda.</p>`}
    </section>
    <section class="card"><h2>Boas práticas</h2><ul class="bullets small">
      <li>Use um número exclusivo do consultório e mantenha o celular dele ligado e com internet.</li>
      <li>Envie apenas para pacientes que autorizaram (campo na ficha do paciente) — o consentimento faz parte do termo LGPD.</li>
      <li>A Evolution usa o WhatsApp Web de forma não oficial: evite volume alto e mensagens em massa para reduzir o risco de bloqueio.</li>
    </ul></section>
    ${c && !c.managed ? html`<form method="post" action="/configuracoes/whatsapp/remover" class="danger-zone" data-confirm="Remover a configuração do WhatsApp? Os envios automáticos param."><button class="btn danger">Remover configuração</button></form>` : ''}`,
  }));
});

admin.post('/', async (req, res) => {
  const b = req.body;
  const cur = await W.config();
  const url = cur?.managed ? cur.url : str(b.url, 300).replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/.test(url)) return res.flash('Endereço da Evolution inválido.', 'err').redirect('/configuracoes/whatsapp');
  const apiKey = cur?.managed ? '' : str(b.apiKey, 300);
  if (cur?.managed) b.instance = cur.instance;
  if (!apiKey && !cur?.apiKey) return res.flash('Informe a chave da API.', 'err').redirect('/configuracoes/whatsapp');
  const templates = {};
  for (const k of Object.keys(W.TEMPLATE_LABELS)) templates[k] = str(b[`tpl_${k}`], 1500) || W.DEFAULT_TEMPLATES[k];
  const hours = [2, 6, 12, 24, 48].includes(int(b.hours)) ? int(b.hours) : 24;
  const windowStart = Math.min(10, Math.max(6, int(b.windowStart) ?? 8));
  const windowEnd = Math.min(22, Math.max(18, int(b.windowEnd) ?? 20));
  const secondHours = [1, 2, 3].includes(int(b.secondHours)) ? int(b.secondHours) : 2;
  const c = await W.saveConfig({ url, instance: str(b.instance, 100), ...(apiKey ? { apiKey } : {}), enabled: !!b.enabled, autoReminders: !!b.autoReminders, hours, windowStart, windowEnd, secondReminder: !!b.secondReminder, secondHours, templates });
  await audit(req, 'whatsapp-configurar');
  let msg = 'Configuração salva.'; let type = 'ok';
  try {
    const st = await W.connectionState(c, true);
    if (st.startsWith('erro')) throw new Error(st.replace(/^erro: /, ''));
    await W.setWebhook(c, hookOf(req, c));
    msg = st === 'open' ? 'Configuração salva, WhatsApp conectado e webhook de respostas ativado.' : `Configuração salva, mas o WhatsApp está “${st}”. Leia o QR code em “Aparelho conectado”.`;
    if (st !== 'open') type = 'warn';
  } catch (e) { msg = `Configuração salva, mas não foi possível falar com a Evolution: ${e.message}`; type = 'err'; }
  res.flash(msg, type).redirect('/configuracoes/whatsapp');
});

// ---------- instância e pareamento ----------
const back = (res) => res.redirect('/configuracoes/whatsapp#aparelho');

admin.post('/instancia', async (req, res) => {
  const c = await W.config();
  const name = str(req.body.instance, 60);
  if (!c?.apiKey || !name) return back(res);
  try {
    const list = await W.listInstances(c);
    if (!list.some((i) => i.name === name)) return res.flash('Instância não encontrada na Evolution.', 'err') && back(res);
    const n = await W.saveConfig({ instance: name });
    await W.setWebhook(n, hookOf(req, n)).catch(() => {});
    await audit(req, 'whatsapp-configurar', `instância ${name}`);
    res.flash(`Instância “${name}” selecionada.`);
  } catch (e) { res.flash(`Falha ao falar com a Evolution: ${e.message}`, 'err'); }
  back(res);
});

admin.post('/instancia/nova', async (req, res) => {
  const c = await W.config();
  const name = str(req.body.name, 60);
  if (!c?.apiKey) return back(res);
  if (!W.validInstanceName(name)) { res.flash('Nome inválido: use letras, números, espaço, ponto, hífen ou sublinhado.', 'err'); return back(res); }
  try {
    const list = await W.listInstances(c);
    if (list.some((i) => i.name.toLowerCase() === name.toLowerCase())) { res.flash('Já existe uma instância com esse nome.', 'err'); return back(res); }
    await W.createInstance(c, name);
    const n = await W.saveConfig({ instance: name });
    await W.setWebhook(n, hookOf(req, n)).catch(() => {});
    await audit(req, 'whatsapp-configurar', `nova instância ${name}`);
    res.flash(`Instância “${name}” criada. Agora leia o QR code com o celular.`);
  } catch (e) { res.flash(`Não foi possível criar a instância: ${e.message}`, 'err'); }
  back(res);
});

admin.post('/gerenciada', async (req, res) => {
  try { const r = await Evolution.provision(Tenancy.current()); if (!r.ok) throw new Error(r.reason); await audit(req, 'whatsapp-configurar', `instância Mentez ${r.instance}`); res.flash('Pronto! Agora leia o QR code com o celular da clínica.'); }
  catch (e) { res.flash(`Não foi possível preparar o WhatsApp: ${e.message}`, 'err'); }
  back(res);
});

admin.post('/qr', async (req, res) => {
  const c = await W.config();
  if (!c?.apiKey || !c?.instance) return res.status(400).json({ error: 'WhatsApp não configurado.' });
  try {
    const st = await W.connectionState(c, true);
    if (st === 'open') return res.json({ state: 'open' });
    const numero = req.body?.numero ? W.normalizePhone(String(req.body.numero)) : null;
    if (req.body?.numero && !numero) return res.status(400).json({ error: 'Número inválido.' });
    const r = await W.connectInstance(c, numero);
    res.set('Cache-Control', 'no-store').json({ state: r.state || st, qr: r.qr, pairingCode: r.pairingCode });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

admin.get('/estado', async (req, res) => {
  const c = await W.config();
  if (!c?.apiKey || !c?.instance) return res.json({ state: null });
  res.set('Cache-Control', 'no-store').json({ state: await W.connectionState(c, true) });
});

admin.post('/desconectar', async (req, res) => {
  const c = await W.config();
  try { await W.logoutInstance(c); await audit(req, 'whatsapp-configurar', `desconectou ${c.instance}`); res.flash('WhatsApp desconectado. Leia um novo QR code para reconectar.', 'warn'); } catch (e) { res.flash(`Falha ao desconectar: ${e.message}`, 'err'); }
  back(res);
});

admin.post('/site', async (req, res) => {
  const b = req.body;
  const phone = W.normalizePhone(str(b.doctorPhone, 40));
  if (!phone) { res.flash('WhatsApp do(a) profissional inválido.', 'err'); return res.redirect('/configuracoes/whatsapp#site'); }
  const mode = b.mode === 'assistente' ? 'assistente' : 'doutora';
  await SiteWA.saveConfig({ mode, doctorPhone: phone, fallback: !!b.fallback });
  if (mode === 'assistente') await SiteWA.assistantNumber(true);
  await audit(req, 'whatsapp-configurar', `site → ${mode}`);
  const r = await SiteWA.route();
  res.flash(mode === 'assistente' && r.target !== 'assistente'
    ? `Salvo. Atenção: por enquanto os cliques vão para o WhatsApp do(a) profissional (${SiteWA.REASONS[r.reason] || r.reason}).`
    : `Salvo. Os botões do site agora levam ${r.target === 'assistente' ? 'ao atendente virtual' : 'ao WhatsApp do(a) profissional'}.`, mode === 'assistente' && r.target !== 'assistente' ? 'warn' : 'ok');
  res.redirect('/configuracoes/whatsapp#site');
});

admin.post('/teste', async (req, res) => {
  const r = await W.send({ phone: str(req.body.phone, 40), text: `✅ Mensagem de teste do ${Brand.get().appName}. A integração com o WhatsApp está funcionando.`, kind: 'teste', user_id: req.user.id });
  res.flash(r.ok ? 'Mensagem de teste enviada.' : `Falhou: ${r.error}`, r.ok ? 'ok' : 'err').redirect('/configuracoes/whatsapp');
});

admin.post('/remover', async (req, res) => {
  await W.clearConfig();
  await audit(req, 'whatsapp-remover');
  res.flash('Configuração do WhatsApp removida.').redirect('/configuracoes/whatsapp');
});

// =====================================================================
// Rotas públicas protegidas por segredo (montadas antes do login)
// =====================================================================
export async function webhook(req, res) {
  try {
    const c = await W.config();
    if (!c?.webhookSecret || !safeEqual(String(req.params.secret || ''), c.webhookSecret)) return res.sendStatus(404);
    const out = await W.handleWebhook(req.body);
    res.json({ ok: true, ...out });
  } catch (e) {
    console.error('wa webhook', e.message);
    res.status(200).json({ ok: false }); // 200 para a Evolution não reenviar em loop
  }
}

// Link público do site: /wa?o=origem&text=mensagem → wa.me do número escolhido.
export async function siteLink(req, res) {
  const origin = SiteWA.cleanOrigin(req.query.o);
  const text = SiteWA.cleanText(req.query.text ?? req.query.t);
  let r;
  try { r = await SiteWA.route(); } catch { r = { target: 'doutora', phone: (await SiteWA.config().catch(() => ({})))?.doctorPhone || SiteWA.defaultDoctor(), reason: 'erro' }; }
  if (origin !== 'teste') SiteWA.logClick(origin, r);
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.redirect(302, `https://wa.me/${r.phone}${text ? `?text=${encodeURIComponent(text)}` : ''}`);
}

export async function cron(req, res) {
  const c = await W.config();
  if (!c?.cronToken || !safeEqual(String(req.params.token || ''), c.cronToken)) return res.sendStatus(404);
  res.json(await W.processDueReminders());
}

// =====================================================================
// Lista de mensagens de um paciente (aba “Mensagens” da ficha)
// =====================================================================
export async function patientMessages(patientId, showText) {
  const rows = await q('SELECT * FROM wa_messages WHERE patient_id = ? ORDER BY id DESC LIMIT 60', [patientId]);
  if (!rows.length) return html`<p class="muted pad">Nenhuma mensagem de WhatsApp com este paciente.</p>`;
  return html`<ul class="wa-list">${rows.map((m) => html`<li class="${m.direction}">
    <div class="wa-meta"><b>${m.direction === 'in' ? 'Paciente' : KIND[m.kind] || m.kind}</b> · ${brDateTime(m.created_at)} ${m.status === 'erro' ? html`<span class="badge b-falta">Erro: ${m.error || ''}</span>` : ''}</div>
    ${m.direction === 'in' && !showText ? html`<p class="muted small">Conteúdo visível apenas para perfis clínicos.</p>` : html`<p class="pre">${W.decryptBody(m.body_enc)}</p>`}
  </li>`)}</ul>`;
}
