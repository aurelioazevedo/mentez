// Configurações → Monitoramento e alertas  +  /saude (verificação pública de que o sistema está no ar)
import crypto from 'node:crypto';
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDateTime } from '../lib/html.js';
import { router, send, str } from '../lib/router.js';
import * as M from '../lib/monitor.js';
import * as WA from '../lib/whatsapp.js';

// ---------- verificação pública ----------
export async function health(req, res) {
  res.set('Cache-Control', 'no-store');
  try { await one('SELECT 1 ok'); res.json({ ok: true }); } catch { res.status(503).json({ ok: false }); }
}
// Dados para o vigia do servidor do WhatsApp: só com a chave da Evolution (a mesma já usada pelo sistema)
export async function watcher(req, res) {
  const w = await WA.config();
  const got = Buffer.from(String(req.get('apikey') || ''));
  const want = Buffer.from(String(w?.apiKey || ''));
  if (!want.length || got.length !== want.length || !crypto.timingSafeEqual(got, want)) return res.status(401).json({ ok: false });
  res.set('Cache-Control', 'no-store').json({ ok: true, ...(await M.watcherInfo()) });
}

const r = router();
const BACK = '/configuracoes/monitoramento';
const fmtPh = (d) => { const x = String(d).replace(/^55/, ''); return x.length === 11 ? `(${x.slice(0, 2)}) ${x.slice(2, 7)}-${x.slice(7)}` : x; };

r.get('/', async (req, res) => {
  const c = await M.config(); const w = await WA.config();
  // A tela não espera mais que 5 s pelo servidor do WhatsApp
  const fast = (p) => Promise.race([p, new Promise((ok) => setTimeout(() => ok('sem resposta do servidor do WhatsApp'), 5000))]);
  const [st, mainSt] = await Promise.all([c.instance && w?.url ? fast(WA.instanceState(w, c.instance)) : null, WA.ready(w) ? fast(WA.connectionState(w, true)) : null]);
  const hist = await M.history();
  send(res, page(req, {
    title: 'Monitoramento e alertas', active: 'config',
    body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Monitoramento e alertas</h1>
      <p class="muted">Avisos no celular do suporte quando algo importante parar de funcionar.</p></div>
      <div class="ph-actions"><a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    ${!c.enabled ? html`<div class="flash warn">Os alertas estão desligados. Cadastre o celular do suporte, conecte a instância de alerta e ligue abaixo.</div>` : ''}
    <div class="grid2">
      <section class="card"><h2>Instância de alerta (2º WhatsApp)</h2>
        <p class="muted small sub-h">Um segundo número de WhatsApp, só para enviar alertas. Assim o aviso chega mesmo quando o WhatsApp principal do consultório cai. Use um chip/número diferente do principal e diferente do celular do suporte.</p>
        <p>WhatsApp principal (${w?.instance || '—'}): ${mainSt === 'open' ? html`<span class="badge b-realizada">Conectado</span>` : html`<span class="badge b-falta">${mainSt || 'não configurado'}</span>`}</p>
        <p>Instância de alerta${c.instance ? ` (${c.instance})` : ''}: ${!c.instance ? html`<span class="badge b-cancelada">Não criada</span>` : st === 'open' ? html`<span class="badge b-realizada">Conectada</span>` : html`<span class="badge b-falta">${st}</span>`}</p>
        ${WA.ready(w) ? html`<form method="post" action="${BACK}/conectar" class="form-grid">
          <label class="fld"><span>Nome da instância</span><input name="instance" value="${c.instance || 'alertas-consultorio'}" pattern="[A-Za-z0-9_-]{3,40}" required></label>
          <label class="fld"><span>Ou código de pareamento para o número (opcional)</span><input name="number" inputmode="tel" placeholder="(62) 9 0000-0000"></label>
          <div class="span2 actions"><button class="btn">${st === 'open' ? 'Reconectar' : 'Conectar (QR code)'}</button></div></form>`
        : html`<p class="muted">Configure primeiro o WhatsApp principal em <a class="link" href="/configuracoes/whatsapp">Configurações → WhatsApp</a>.</p>`}
        ${c.instance && st === 'open' ? html`<form method="post" action="${BACK}/desconectar" data-confirm="Desconectar a instância de alerta? Os alertas passam a sair pela instância principal."><button class="btn ghost danger-text">Desconectar instância de alerta</button></form>` : ''}
      </section>
      <form method="post" action="${BACK}" class="card stack"><h2>Quem recebe e o que avisar</h2>
        <label class="fld check"><input type="checkbox" name="enabled" value="1" ${c.enabled ? raw('checked') : ''}><span><b>Alertas ligados</b></span></label>
        <label class="fld"><span>Celular(es) do suporte — um por linha (até 5)</span><textarea name="phones" rows="3" placeholder="(62) 9 9999-9999">${c.phones.map(fmtPh).join('\n')}</textarea></label>
        <div class="stack">${Object.entries(M.CHECKS).map(([k, l]) => html`<label class="fld check"><input type="checkbox" name="c_${k}" value="1" ${c.checks[k] ? raw('checked') : ''}><span>${l}</span></label>`)}</div>
        <div class="form-grid">
          <label class="fld"><span>Erro repetido: quantas vezes</span><input type="number" name="errThreshold" min="2" max="100" value="${c.errThreshold}"></label>
          <label class="fld"><span>…em quantos minutos</span><input type="number" name="errWindowMin" min="2" max="120" value="${c.errWindowMin}"></label>
          <label class="fld"><span>Avisar saldo da IA abaixo de (US$)</span><input name="iaMinUsd" inputmode="decimal" value="${String(c.iaMinUsd).replace('.', ',')}"></label>
        </div>
        <div class="actions"><button class="btn">Salvar</button></div>
      </form>
    </div>
    <section class="card"><h2>Testar</h2>
      <p class="muted small sub-h">Envia uma mensagem de teste para o(s) celular(es) do suporte pela instância de alerta (e notificação para os usuários master).</p>
      <form method="post" action="${BACK}/teste"><button class="btn ghost" ${c.phones.length ? '' : raw('disabled')}>Enviar alerta de teste</button></form>
      <p class="muted small">Sistema fora do ar: quem vigia é o servidor do WhatsApp, que consulta o sistema a cada minuto e avisa após cerca de 3 minutos sem resposta (e de novo quando voltar). Ele usa uma cópia destes contatos, atualizada a cada 10 minutos.</p>
    </section>
    <section class="card"><h2>Últimos alertas</h2>
      ${hist.length ? html`<ul class="list">${hist.map((a) => html`<li><div class="maint-bk"><span><b>${a.kind === 'normalizado' ? '✅ Normalizado' : a.kind === 'teste' ? '🧪 Teste' : '🚨 Alerta'}</b> · ${brDateTime(a.created_at)}<small>${a.message}</small><small class="muted">Enviado por: ${a.channel || '—'}</small></span></div></li>`)}</ul>` : html`<p class="muted">Nenhum alerta ainda.</p>`}
    </section>`,
  }));
});

r.post('/', async (req, res) => {
  const b = req.body; const num = (v, d, lo, hi) => Math.max(lo, Math.min(hi, Number(String(v || '').replace(',', '.')) || d));
  const phones = M.normalizePhones(b.phones);
  await M.saveConfig({
    enabled: !!b.enabled && phones.length > 0, phones,
    checks: Object.fromEntries(Object.keys(M.CHECKS).map((k) => [k, !!b[`c_${k}`]])),
    errThreshold: num(b.errThreshold, 5, 2, 100), errWindowMin: num(b.errWindowMin, 10, 2, 120), iaMinUsd: num(b.iaMinUsd, 2, 0, 1000),
  });
  await audit(req, 'monitor-config');
  res.flash(b.enabled && !phones.length ? 'Informe pelo menos um celular válido para ligar os alertas.' : 'Monitoramento salvo.', b.enabled && !phones.length ? 'warn' : 'ok').redirect(BACK);
});

r.post('/conectar', async (req, res) => {
  const w = await WA.config();
  if (!WA.ready(w)) return res.flash('Configure o WhatsApp principal primeiro.', 'err').redirect(BACK);
  const name = str(req.body.instance, 40).replace(/[^A-Za-z0-9_-]/g, '');
  if (name.length < 3) return res.flash('Nome da instância inválido.', 'err').redirect(BACK);
  if (name === w.instance) return res.flash('Use um nome diferente da instância principal.', 'err').redirect(BACK);
  try {
    const list = await WA.listInstances(w).catch(() => []);
    if (!list.some((i) => (i.name || i.instanceName) === name)) await WA.createInstance(w, name);
    await M.saveConfig({ instance: name });
    const number = WA.normalizePhone(req.body.number);
    const out = await WA.connectInstance({ ...w, instance: name }, number);
    await audit(req, 'monitor-conectar', name);
    send(res, page(req, {
      title: 'Conectar instância de alerta', active: 'config',
      body: html`<header class="ph"><div><p class="eyebrow">Monitoramento e alertas</p><h1>Conectar o 2º WhatsApp</h1></div><div class="ph-actions"><a class="btn ghost" href="${BACK}">Concluir</a></div></header>
      <section class="card mon-qr">${out.pairingCode ? html`<p>No celular do número de alerta: WhatsApp → Aparelhos conectados → Conectar com número de telefone, e digite:</p><p class="pair">${out.pairingCode}</p>`
        : out.qr ? html`<p>No celular do número de alerta: WhatsApp → Aparelhos conectados → Conectar um aparelho, e leia o QR code:</p><img src="${out.qr}" alt="QR code do WhatsApp" width="280" height="280">`
        : html`<p>A instância já está conectada ou o QR ainda não ficou pronto. <a class="link" href="${BACK}">Voltar</a> e confira a situação.</p>`}
        <p class="muted small">Depois de conectar, clique em Concluir. O QR code expira em cerca de 40 segundos — se expirar, conecte de novo.</p></section>`,
    }));
  } catch (e) { res.flash(`Não foi possível conectar: ${e.message}`, 'err').redirect(BACK); }
});
r.post('/desconectar', async (req, res) => {
  const c = await M.config(); const w = await WA.config();
  if (c.instance && w) await WA.logoutInstance({ ...w, instance: c.instance }).catch(() => {});
  await audit(req, 'monitor-desconectar', c.instance);
  res.flash('Instância de alerta desconectada.').redirect(BACK);
});
r.post('/teste', async (req, res) => {
  const ch = await M.sendTest(req.user.name);
  await audit(req, 'monitor-teste');
  res.flash(ch.length ? `Alerta de teste enviado (${ch.join(', ')}).` : 'Não foi possível enviar: confira o celular do suporte e as instâncias do WhatsApp.', ch.length ? 'ok' : 'err').redirect(BACK);
});

export default r;
