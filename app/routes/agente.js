import * as Brand from '../lib/brand.js';
import * as Tenancy from '../lib/tenancy.js';
import express from 'express';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDateTime, waLink } from '../lib/html.js';
import { router, send, int, str, dec } from '../lib/router.js';
import { decrypt } from '../lib/crypto.js';
import * as Agent from '../lib/agent.js';
import * as AP from '../lib/aiproviders.js';
import * as AISlot from '../lib/aislot.js';
import * as WA from '../lib/whatsapp.js';
import * as Relay from '../lib/relay.js';
import * as CRM from '../lib/crm.js';

const conversationText = (enc) => {
  // Transcrição legível: só as falas (sem contexto do sistema, ferramentas ou raciocínio).
  let h = []; try { h = JSON.parse(decrypt(enc)); } catch { return []; }
  const out = [];
  for (const m of h) {
    if (m.role === 'user' && typeof m.content === 'string') out.push({ who: 'in', text: m.content });
    if (m.role === 'assistant' && Array.isArray(m.content)) {
      const t = m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      const tools = m.content.filter((b) => b.type === 'tool_use').map((b) => b.name);
      if (tools.length) out.push({ who: 'tool', text: `⚙ ${tools.join(', ')}` });
      if (t) out.push({ who: 'out', text: t });
    }
  }
  return out;
};
const contactLabel = (cv) => cv.patient_name || cv.contact_name || cv.phone;

// =====================================================================
// Configuração e simulador: /configuracoes/agente  (administração)
// =====================================================================
export const admin = router();
const sims = new Tenancy.TMap(); // histórico do simulador por usuário (em memória) (separado por clínica)

admin.get('/', async (req, res) => {
  const c = await Agent.config();
  const wa = WA.ready(await WA.config());
  const pros = await q("SELECT id, name FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");
  const stats = await one(`SELECT COUNT(*) conversas, COALESCE(SUM(turns),0) turnos, COALESCE(SUM(tokens_in),0) tin, COALESCE(SUM(tokens_out),0) tout,
    SUM(status = 'humano') humano FROM agent_conversations WHERE last_inbound_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)`);
  const booked = await one("SELECT COUNT(*) n FROM appointments WHERE created_via = 'agente' AND created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)");
  const chk = (n, v) => (v ? raw(`name="${n}" value="1" checked`) : raw(`name="${n}" value="1"`));
  const sel = (n, opts, v) => html`<select name="${n}">${opts.map(([val, l]) => html`<option value="${val}" ${String(val) === String(v) ? raw('selected') : ''}>${l}</option>`)}</select>`;
  const bal = await Agent.balance();
  // modelos disponíveis na conta de cada vaga (provedores compatíveis com OpenAI)
  const modelsOf = async (x) => { if (!x?.key || x.provider === 'anthropic') return { list: [], err: '' }; try { return { list: await Agent.groqModels(x.key, false, x.provider, x.baseUrl), err: '' }; } catch (e) { return { list: [], err: e.message }; } };
  const [m1, m2] = await Promise.all([modelsOf(c.ai1), modelsOf(c.ai2)]);
  const days = await q("SELECT DATE(created_at) d, SUM(cost_usd) s, COUNT(*) n FROM agent_usage WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL 6 DAY) GROUP BY DATE(created_at) ORDER BY d");
  const usd = (v) => `US$ ${Number(v || 0).toFixed(2)}`;
  const low = bal.known && bal.estimated <= bal.alertUsd;

  send(res, page(req, {
    title: 'Atendente virtual', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Atendente virtual (IA) no WhatsApp</h1>
      <p class="muted">Atende, tira dúvidas, oferece os e-books e agenda, remarca e cancela sessões pelo WhatsApp do consultório — dentro da escala e das regras definidas aqui.</p></div>
      <div class="ph-actions">${!c.enabled ? html`<span class="badge b-cancelada">Desligado</span>` : Agent.primaryReady(c) ? html`<span class="badge b-realizada">Ligado · ${AISlot.labelOf(c.ai1.provider)}</span>` : Agent.secondaryReady(c) ? html`<span class="badge b-agendada">Ligado · secundário ${AISlot.labelOf(c.ai2.provider)}</span>` : html`<span class="badge b-falta">Suspenso</span>`}<a class="btn ghost" href="/atendimento">Conversas</a><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    ${c.suspended ? html`<div class="flash ${Agent.order(c).length ? 'warn' : 'err'}"><b>${Agent.order(c).length ? 'Claude suspenso' : 'Atendente suspenso'} desde ${brDateTime(c.suspended.at)}:</b> ${c.suspended.reason}.
      ${/créditos/.test(c.suspended.reason) ? html` Adicione créditos em <b>console.anthropic.com → Settings → Billing</b> (botão “Buy credits”); se quiser, ative a recarga automática.` : /Chave/.test(c.suspended.reason) ? ' Gere uma nova chave em console.anthropic.com → API Keys e salve abaixo.' : ''}
      ${Agent.order(c).length ? html`<b>Enquanto isso, o atendente está respondendo por ${AISlot.describe(Agent.order(c)[0])}.</b>` : 'Enquanto isso, as mensagens chegam normalmente no CRM, mas ninguém responde automaticamente — ative um provedor secundário abaixo para não ficar sem resposta.'}
      <form method="post" action="/configuracoes/agente/reativar" style="display:inline"><button class="btn" style="margin-left:8px">Reativar agora</button></form></div>` : ''}
    ${!wa ? html`<div class="flash warn">Configure primeiro o WhatsApp em <a class="link" href="/configuracoes/whatsapp">Configurações → WhatsApp</a>.</div>` : ''}
    <section class="kpis small">
      <div class="kpi"><span>Conversas (30 dias)</span><b>${Number(stats?.conversas || 0)}</b></div>
      <div class="kpi"><span>Sessões agendadas pelo agente</span><b>${Number(booked?.n || 0)}</b></div>
      <div class="kpi"><span>Aguardando humano</span><b>${Number(stats?.humano || 0)}</b></div>
      <div class="kpi ${low ? 'kpi-low' : ''}"><span>Saldo estimado na Anthropic</span><b>${bal.known ? usd(bal.estimated) : '—'}</b><small>${bal.known ? `gasto este mês: ${usd(bal.spentMonth)}` : 'informe o saldo abaixo'}</small></div>
    </section>

    <section class="card saldo ${low ? 'low' : ''}" id="saldo">
      <div class="saldo-h">
        <div><h2>Saldo da IA (Anthropic)</h2>
          ${bal.known ? html`<p class="saldo-v">${usd(bal.estimated)} <small>estimado</small></p>
            <p class="muted small">Saldo informado: ${usd(bal.informed)} em ${brDateTime(bal.informedAt)}${bal.informedBy ? ` (${bal.informedBy})` : ''} · gasto medido desde então: ${usd(bal.spentSince)}</p>`
          : html`<p class="muted">Ainda não informado. Veja o saldo em console.anthropic.com → Settings → Billing e informe abaixo — o sistema passa a descontar cada resposta automaticamente.</p>`}
          ${bal.exhausted ? html`<p class="flash err small">A Anthropic informou que os créditos acabaram. Adicione saldo e informe o novo valor.</p>` : low ? html`<p class="flash warn small">Saldo abaixo de ${usd(bal.alertUsd)} — adicione saldo para o atendente não parar.</p>` : ''}
        </div>
        <div class="saldo-actions">
          <a class="btn" href="https://console.anthropic.com/settings/billing" target="_blank" rel="noopener">+ Adicionar saldo</a>
          <small class="muted">Abre a página de pagamento da Anthropic (cartão). Depois de comprar, informe o novo saldo ao lado.</small>
        </div>
      </div>
      <div class="grid2 saldo-grid">
        <form method="post" action="/configuracoes/agente/saldo" class="form-grid">
          <label class="fld"><span>Saldo atual no console (US$)</span><input name="usd" inputmode="decimal" required placeholder="Ex.: 10,00"></label>
          <label class="fld"><span>Avisar quando ficar abaixo de (US$)</span><input name="alert" inputmode="decimal" value="${String(bal.alertUsd).replace('.', ',')}"></label>
          <div class="span2 actions"><button class="btn ghost">Informar saldo</button>${c.suspended && /créditos/.test(c.suspended.reason) ? html`<span class="muted small">Informar o saldo também reativa o atendente.</span>` : ''}</div>
        </form>
        <div>
          <p class="small"><b>Gasto medido</b> · últimos 30 dias: ${usd(bal.spent30)} em ${bal.calls30} chamadas</p>
          ${days.length ? html`<div class="bars small-bars">${days.map((d) => { const mx = Math.max(...days.map((x) => Number(x.s)), 0.0001); return html`<div class="bar"><span style="height:${Math.max(3, Math.round((Number(d.s) / mx) * 100))}%" title="${usd(d.s)} · ${d.n} chamadas"></span><small>${String(d.d).slice(8, 10)}/${String(d.d).slice(5, 7)}</small><em>${Number(d.s).toFixed(2)}</em></div>`; })}</div>` : html`<p class="muted small">Sem uso nos últimos 7 dias.</p>`}
          <p class="muted small">Custo calculado com os tokens que a Anthropic informa em cada resposta e o preço do modelo usado em cada resposta (Haiku 5.5: US$ 0,10 entrada · US$ 0,50 saída por milhão de tokens; Opus 5.5: US$ 4 · US$ 20). Inclui o simulador. A fatura oficial fica no console da Anthropic.</p>
        </div>
      </div>
    </section>

    <div class="grid2">
      <form method="post" action="/configuracoes/agente" class="card form-grid">
        <h2 class="span2">Funcionamento</h2>
        <label class="fld check span2"><input type="checkbox" ${chk('enabled', c.enabled)}><span><b>Atendente virtual ligado</b></span></label>
        <div class="span2">${AISlot.fields('p1', c.ai1, { title: 'Provedor de IA principal', hint: 'Responde todas as conversas. Escolha qualquer provedor; o modelo precisa aceitar chamada de ferramentas (function calling). Com Claude, o Haiku custa cerca de US$ 0,01 por conversa típica.', models: m1.list, error: m1.err, scope: 'agente' })}</div>
        <div class="span2">${AISlot.fields('p2', c.ai2, { title: 'Provedor de IA secundário (reserva)', hint: 'Assume sozinho quando o principal falhar: conta sem créditos, chave recusada, limite de uso ou serviço fora do ar. Pode ser outro provedor ou outra conta.', toggle: true, models: m2.list, error: m2.err, scope: 'agente' })}</div>
        <label class="fld span2"><span>Nome do atendente</span><input name="assistantName" maxlength="80" value="${c.assistantName}"></label>
        <label class="fld check span2"><input type="checkbox" ${chk('answerNew', c.answerNew)}><span>Atender também quem ainda não é paciente (novos contatos)</span></label>
        <p class="span2 small">Para os botões de WhatsApp do <b>site</b> levarem ao atendente (ou ao WhatsApp do profissional): <a class="link" href="/configuracoes/whatsapp#site">Configurações → WhatsApp → WhatsApp do site</a>.</p>
        <label class="fld check"><input type="checkbox" ${chk('canBook', c.canBook)}><span>Pode agendar</span></label>
        <label class="fld check"><input type="checkbox" ${chk('canReschedule', c.canReschedule)}><span>Pode remarcar</span></label>
        <label class="fld check"><input type="checkbox" ${chk('canCancel', c.canCancel)}><span>Pode cancelar</span></label>
        <label class="fld check"><input type="checkbox" ${chk('notifyProWhatsApp', c.notifyProWhatsApp)}><span>Avisar o profissional no WhatsApp</span></label>
        <h2 class="span2">Regras de agenda</h2>
        <label class="fld"><span>Profissional para novos contatos</span>${sel('defaultProfessional', pros.map((p) => [p.id, p.name]), c.defaultProfessional || pros[0]?.id)}</label>
        <label class="fld"><span>Duração da sessão</span>${sel('duration', [[40, '40 min'], [50, '50 min'], [60, '60 min']], c.duration)}</label>
        <label class="fld"><span>Intervalo entre horários oferecidos</span>${sel('slotStep', [[40, '40 min'], [50, '50 min'], [60, '1 hora']], c.slotStep)}</label>
        <label class="fld"><span>Antecedência mínima para agendar</span>${sel('minLeadHours', [[1, '1 hora'], [3, '3 horas'], [12, '12 horas'], [24, '24 horas']], c.minLeadHours)}</label>
        <label class="fld"><span>Remarcar/cancelar só até</span>${sel('cancelMinHours', [[2, '2 h antes'], [12, '12 h antes'], [24, '24 h antes'], [48, '48 h antes']], c.cancelMinHours)}</label>
        <label class="fld"><span>Agendar até</span>${sel('horizonDays', [[14, '14 dias à frente'], [30, '30 dias'], [60, '60 dias']], c.horizonDays)}</label>
        <label class="fld"><span>Pausa após atendimento humano</span>${sel('pauseHours', [[2, '2 horas'], [12, '12 horas'], [24, '24 horas'], [72, '3 dias']], c.pauseHours)}</label>
        <label class="fld span2"><span>Informações do consultório para o atendente (valores, formas de pagamento, endereço, política de faltas, convênios…)</span>
          <textarea name="clinicInfo" rows="7" maxlength="4000" placeholder="Ex.: Valor da sessão: R$ ___ (Pix ou cartão). Endereço do atendimento presencial: ___. Faltas sem aviso com 24h são cobradas. Não atendemos convênios; emitimos recibo para reembolso.">${c.clinicInfo}</textarea></label>
        <div class="span2 actions"><button class="btn">Salvar</button></div>
        <p class="span2 muted small">Principal: ${AISlot.describe(c.ai1)}${c.ai2?.on ? ` · secundário: ${AISlot.describe(c.ai2)}` : ''}. As mensagens das conversas são enviadas ao provedor de IA para gerar as respostas (operador de dados — informe na política de privacidade). O agente nunca faz orientação clínica, segue a escala e os bloqueios, e transfere para humano em caso de risco (CVV 188 / SAMU 192).</p>
      </form>

      <form method="post" action="/configuracoes/agente/atendimento-humano" class="card stack" id="atendimento-humano">
        <h2>Atendimento humano pelo WhatsApp da equipe</h2>
        <p class="muted small">Quando o atendente virtual passa a conversa para um humano, as mensagens do contato vão para o WhatsApp de quem atende — com o nome de quem é, o motivo e as últimas mensagens. A resposta (texto, áudio, foto ou arquivo) volta ao contato pelo número da clínica, identificada como <b>atendimento humano</b>. Para devolver ao assistente, quem atende envia <b>reativar</b>.</p>
        <label class="fld check"><input type="checkbox" name="relayOn" value="1" ${c.relayOn ? raw('checked') : ''}><span><b>Encaminhar o atendimento humano para o WhatsApp da equipe</b></span></label>
        <div class="rl-ops">
          <div class="rl-h"><span>Nome que aparece para o contato</span><span>WhatsApp de quem atende</span><span>Recebe</span></div>
          ${[...Relay.operators(c, true), {}, {}].slice(0, Math.max(3, Relay.operators(c, true).length + 1)).map((o, i) => html`<div class="rl-row">
            <input name="op_name_${i}" maxlength="60" value="${o.name || ''}" placeholder="Ex.: Ana (recepção)" aria-label="Nome ${i + 1}">
            <input name="op_phone_${i}" maxlength="30" value="${o.phone || ''}" placeholder="(62) 90000-0000" inputmode="tel" pattern="[0-9 ()+.\-]{10,}" title="WhatsApp com DDD" aria-label="WhatsApp ${i + 1}">
            <label class="check"><input type="checkbox" name="op_active_${i}" value="1" ${o.active ? raw('checked') : ''}> <span>ativo</span></label></div>`)}
        </div>
        <details class="tv-tips"><summary>Como a equipe usa</summary><ul>
          <li>Para responder, <b>arraste para o lado</b> a mensagem do contato (Responder) e escreva — ou comece com o código da conversa, ex.: <b>#12 Olá!</b>. Com uma conversa aberta só, nem precisa.</li>
          <li>Áudios, fotos, vídeos e arquivos vão e voltam.</li>
          <li><b>reativar</b> devolve a conversa ao assistente; <b>conversas</b> lista as abertas; <b>ajuda</b> mostra os comandos.</li>
          <li>O contato nunca vê o número de quem atende: tudo sai pelo número da clínica. Tudo fica no histórico da conversa (Atendimento).</li>
          <li>O WhatsApp de quem atende precisa ser diferente do número da clínica conectado ao sistema.</li>
        </ul></details>
        <div class="actions"><button class="btn">Salvar</button></div>
      </form>

      <section class="card sim" id="simulador">
        <h2>Simulador</h2>
        <p class="muted small">Converse como se fosse um contato. <b>Nada é enviado no WhatsApp e nada é gravado na agenda</b> (agendamentos são simulados; horários livres são reais).</p>
        <div class="sim-chat" data-sim-chat><p class="muted small">Ex.: “Oi, queria marcar uma consulta” · “Tem algum material sobre ansiedade?”</p></div>
        <form class="sim-form" data-sim-form><input name="text" autocomplete="off" placeholder="Escreva uma mensagem…" required><button class="btn">Enviar</button></form>
        <div class="actions"><button type="button" class="link small btnlink" data-sim-reset>Recomeçar conversa</button>
          ${AISlot.ready(c.ai2) ? html`<label class="small"><input type="checkbox" data-sim-groq> testar com o secundário (${AISlot.labelOf(c.ai2.provider)})</label>` : ''}</div>
      </section>
    </div>`,
  }));
});

admin.post('/', async (req, res) => {
  const b = req.body;
  const n = (v, allowed, d) => (allowed.includes(int(v)) ? int(v) : d);
  const cur = await Agent.config();
  const r1 = AISlot.fromBody(b, 'p1', cur.ai1, [cur.ai2]);
  const r2 = AISlot.fromBody(b, 'p2', cur.ai2, [cur.ai1]);
  for (const [r, nm] of [[r1, 'Principal'], [r2, 'Secundário']]) if (r.error) return res.flash(`${nm}: ${r.error}`, 'err').redirect('/configuracoes/agente');
  // Modelo dos provedores compatíveis com OpenAI: o escolhido, ou o recomendado entre os disponíveis na conta.
  let groqMsg = '';
  for (const r of [r1, r2]) {
    const x = r.slot;
    if (x.provider === 'anthropic' || !x.key || !x.on) continue;
    try {
      const list = await Agent.groqModels(x.key, true, x.provider, x.baseUrl);
      if (list.length && !list.includes(x.model)) x.model = Agent.preferredGroqModel(list, x.provider);
    } catch (e) { groqMsg += ` Atenção: não foi possível validar a chave de ${AISlot.labelOf(x.provider)} (${e.message}).`; }
  }
  if (b.enabled && !AISlot.ready(r1.slot) && !(r2.slot.on && AISlot.ready(r2.slot))) return res.flash('Informe provedor, modelo e chave do provedor principal para ligar o atendente.', 'err').redirect('/configuracoes/agente');
  const newAnthropicKey = [r1, r2].some((r) => r.typed && r.slot.provider === 'anthropic');
  await Agent.saveConfig({
    ai1: r1.slot, ai2: r2.slot,
    ...(newAnthropicKey ? { suspended: null } : {}), // chave nova da Anthropic reativa o Claude
    enabled: !!b.enabled, answerNew: !!b.answerNew, canBook: !!b.canBook, canReschedule: !!b.canReschedule, canCancel: !!b.canCancel,
    notifyProWhatsApp: !!b.notifyProWhatsApp, assistantName: str(b.assistantName, 80) || 'Assistente virtual do consultório',
    defaultProfessional: int(b.defaultProfessional), duration: n(b.duration, [40, 50, 60], 40), slotStep: n(b.slotStep, [40, 50, 60], 60),
    minLeadHours: n(b.minLeadHours, [1, 3, 12, 24], 3), cancelMinHours: n(b.cancelMinHours, [2, 12, 24, 48], 24), horizonDays: n(b.horizonDays, [14, 30, 60], 30),
    pauseHours: n(b.pauseHours, [2, 12, 24, 72], 12), clinicInfo: str(b.clinicInfo, 4000),
  });
  await audit(req, 'agente-configurar', b.enabled ? 'ligado' : 'desligado');
  res.flash(`${b.enabled ? 'Atendente virtual ligado.' : 'Configuração salva (atendente desligado).'}${groqMsg}`, groqMsg ? 'warn' : 'ok').redirect('/configuracoes/agente');
});

admin.post('/atendimento-humano', async (req, res) => {
  const b = req.body; const ops = [];
  for (let i = 0; i < 10; i++) {
    const name = str(b[`op_name_${i}`], 60); const phone = str(b[`op_phone_${i}`], 30);
    if (!name && !phone) continue;
    if (!name || !WA.phoneKey(phone)) return res.flash(`Confira o nome e o WhatsApp da linha ${i + 1}.`, 'err').redirect('/configuracoes/agente#atendimento-humano');
    ops.push({ name, phone, active: !!b[`op_active_${i}`] });
  }
  if (b.relayOn && !ops.some((o) => o.active)) return res.flash('Marque pelo menos uma pessoa como “ativo” para receber os encaminhamentos.', 'err').redirect('/configuracoes/agente#atendimento-humano');
  // o número conectado ao sistema não pode receber encaminhamentos de si mesmo
  let own = null;
  try { const wc = await WA.config(); own = (await WA.listInstances(wc)).find((x) => x.name === wc.instance)?.number || null; } catch { /* sem conexão agora */ }
  const clash = own && ops.find((o) => o.active && WA.phoneKey(o.phone) === WA.phoneKey(own));
  if (clash) clash.active = false; // salva tudo (nada do que foi digitado se perde), mas esse número não recebe
  const on = !!b.relayOn && ops.some((o) => o.active);
  await Agent.saveConfig({ relayOn: on, relayOps: ops });
  await CRM.syncTeam().catch((e) => console.error('crm equipe', e.message));
  if (clash) return res.flash(`O WhatsApp de ${clash.name} é o mesmo número da clínica conectado ao sistema: ele não pode receber os encaminhamentos e ficou desativado. ${on ? `Os demais continuam recebendo.` : 'Cadastre outro número para ligar o encaminhamento.'}`, 'warn').redirect('/configuracoes/agente#atendimento-humano');
  await audit(req, 'agente-atendimento-humano', `${b.relayOn ? 'ligado' : 'desligado'} · ${ops.filter((o) => o.active).map((o) => o.name).join(', ')}`);
  res.flash(b.relayOn ? `Atendimento humano pelo WhatsApp ligado: encaminhando para ${ops.filter((o) => o.active).map((o) => o.name).join(' e ')}.` : 'Configuração salva (encaminhamento desligado).').redirect('/configuracoes/agente#atendimento-humano');
});

admin.post('/saldo', async (req, res) => {
  const v = dec(req.body.usd);
  if (v === null) return res.flash('Informe o saldo em dólares (ex.: 10,00).', 'err').redirect('/configuracoes/agente#saldo');
  const alert = dec(req.body.alert);
  await Agent.setBalance(v, req.user.name, alert === null ? undefined : alert);
  const c = await Agent.config();
  if (v > 0 && c.suspended && /créditos/.test(c.suspended.reason)) {
    await Agent.saveConfig({ suspended: null });
    await q("UPDATE agent_conversations SET status = 'ativo', human_reason = NULL, human_until = NULL WHERE status = 'humano' AND human_reason LIKE 'Sem créditos%'");
  }
  await audit(req, 'agente-saldo', `US$ ${v}`);
  res.flash(`Saldo informado: US$ ${v.toFixed(2)}.${v > 0 && c.suspended ? ' Atendente reativado.' : ''}`).redirect('/configuracoes/agente#saldo');
});

admin.post('/reativar', async (req, res) => {
  await Agent.saveConfig({ suspended: null });
  // Libera os contatos que ficaram pausados pela falha
  await q("UPDATE agent_conversations SET status = 'ativo', human_reason = NULL, human_until = NULL WHERE status = 'humano' AND (human_reason LIKE 'Sem créditos%' OR human_reason LIKE 'Chave da API%' OR human_reason LIKE 'Falha do atendente%' OR human_reason LIKE '%credit balance%')");
  await audit(req, 'agente-reativar');
  res.flash('Atendente virtual reativado. Se o problema continuar, ele será suspenso de novo automaticamente.').redirect('/configuracoes/agente');
});

admin.post('/simular', express.json({ limit: '20kb' }), async (req, res) => {
  try {
    if (req.body?.reset) { sims.delete(req.user.id); return res.json({ ok: true }); }
    const text = str(req.body?.text, 1500);
    if (!text) return res.status(400).json({ ok: false, error: 'Mensagem vazia.' });
    const r = await Agent.simulate(sims.get(req.user.id) || [], text, null, !!req.body?.groq);
    sims.set(req.user.id, r.history);
    res.json({ ok: true, reply: r.reply, handoff: r.handoff, provider: r.provider });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.status ? Agent.classifyError(e).reason : e.message });
  }
});

// =====================================================================
// Conversas do atendente: /atendimento  (equipe com acesso à agenda)
// =====================================================================
export const team = router();

team.get('/', async (req, res) => {
  const rows = await q(`SELECT cv.*, p.name patient_name FROM agent_conversations cv LEFT JOIN patients p ON p.id = cv.patient_id
    WHERE cv.last_inbound_at IS NOT NULL ORDER BY cv.status = 'humano' DESC, cv.last_inbound_at DESC LIMIT 100`);
  send(res, page(req, {
    title: 'Atendimento', active: 'agenda',
    body: html`<header class="ph"><div><p class="eyebrow">WhatsApp</p><h1>Conversas do atendente virtual</h1></div><div class="ph-actions"><a class="btn ghost" href="/agenda">Agenda</a></div></header>
    <section class="card flush" id="conversas">${rows.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Contato</th><th>Situação</th><th>Última mensagem</th><th>Respostas</th></tr></thead>
      <tbody>${rows.map((cv) => html`<tr data-href="/atendimento/${cv.id}"><td><a href="/atendimento/${cv.id}"><b>${contactLabel(cv)}</b></a><small class="muted block">${cv.patient_id ? 'paciente' : 'novo contato'} · ${cv.phone}</small></td>
        <td>${cv.status === 'humano' ? html`<span class="badge b-falta">Aguardando humano</span><small class="muted block">${cv.human_reason || ''}</small>` : html`<span class="badge b-realizada">Atendente virtual</span>`}</td>
        <td>${brDateTime(cv.last_inbound_at)}</td><td>${cv.turns}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhuma conversa ainda.</p>`}</section>`,
  }));
});

team.get('/:id', async (req, res, next) => {
  const cv = await one('SELECT cv.*, p.name patient_name FROM agent_conversations cv LEFT JOIN patients p ON p.id = cv.patient_id WHERE cv.id = ?', [int(req.params.id)]);
  if (!cv) return next();
  const lines = cv.messages_enc ? conversationText(cv.messages_enc) : [];
  // Histórico do atendimento humano (mensagens do contato e respostas da equipe pelo WhatsApp)
  const human = (await q("SELECT direction, body_enc, created_at FROM wa_messages WHERE phone = ? AND (kind = 'manual' OR (direction = 'in' AND created_at >= COALESCE((SELECT MIN(r.created_at) FROM relay_msgs r WHERE r.conv_id = ?), NOW()))) ORDER BY id DESC LIMIT 60", [WA.normalizePhone(cv.phone), cv.id])).reverse();
  await audit(req, 'agente-ver-conversa', `conv:${cv.id}`);
  const wa = waLink(cv.phone, '');
  send(res, page(req, {
    title: contactLabel(cv), active: 'agenda',
    body: html`<header class="ph"><div><p class="eyebrow">Atendimento · ${cv.phone}</p><h1>${contactLabel(cv)}</h1></div>
      <div class="ph-actions">${cv.status === 'humano' ? html`<span class="badge b-falta">Aguardando humano</span>` : html`<span class="badge b-realizada">Atendente virtual</span>`}
        ${wa ? html`<a class="btn" href="${wa}" target="_blank" rel="noopener">Responder no WhatsApp</a>` : ''}
        ${cv.patient_id ? html`<a class="btn ghost" href="/pacientes/${cv.patient_id}?aba=mensagens">Ficha do paciente</a>` : ''}</div></header>
    ${cv.status === 'humano' ? html`<div class="flash warn">${cv.human_reason || 'Transferido para atendimento humano'}. O atendente virtual está pausado neste contato${cv.human_until ? ` até ${brDateTime(cv.human_until)}` : ''}.
      <form method="post" action="/atendimento/${cv.id}/retomar" style="display:inline"><button class="link btnlink">Devolver ao atendente virtual agora</button></form></div>`
      : html`<form method="post" action="/atendimento/${cv.id}/pausar" class="actions" style="margin-bottom:14px"><button class="btn ghost">Assumir conversa (pausar atendente)</button></form>`}
    <section class="card">${lines.length ? html`<ul class="wa-list">${lines.map((l) => html`<li class="${l.who === 'in' ? 'in' : l.who === 'out' ? 'out' : 'tool'}"><p class="pre">${l.text}</p></li>`)}</ul>`
      : html`<p class="muted">Sem mensagens na conversa atual (o histórico recomeça após 12 horas sem conversa).</p>`}</section>
    ${human.length ? html`<section class="card"><h2>Atendimento humano pelo WhatsApp</h2><ul class="wa-list">${human.map((m) => html`<li class="${m.direction === 'in' ? 'in' : 'out'}"><div class="wa-meta"><b>${m.direction === 'in' ? 'Contato' : 'Equipe'}</b> · ${brDateTime(m.created_at)}</div><p class="pre">${WA.decryptBody(m.body_enc)}</p></li>`)}</ul></section>` : ''}`,
  }));
});

team.post('/:id/retomar', async (req, res) => {
  await Relay.notifyResumed(int(req.params.id), req.user.name).catch(() => {});
  await Agent.resume(int(req.params.id));
  await audit(req, 'agente-retomar', `conv:${req.params.id}`);
  res.flash('Atendente virtual reativado nesta conversa.').redirect(`/atendimento/${int(req.params.id)}`);
});
team.post('/:id/pausar', async (req, res) => {
  await q("UPDATE agent_conversations SET status = 'humano', human_reason = ?, human_until = DATE_ADD(NOW(), INTERVAL 24 HOUR) WHERE id = ?", [`Assumida por ${req.user.name}`, int(req.params.id)]);
  await audit(req, 'agente-pausar', `conv:${req.params.id}`);
  res.flash('Você assumiu a conversa: o atendente virtual fica pausado por 24 horas.').redirect(`/atendimento/${int(req.params.id)}`);
});
