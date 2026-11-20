// Nota fiscal (NFS-e): Configurações → Nota fiscal, Financeiro → Notas fiscais e o quadro no lançamento.
import { q, one, audit } from '../lib/db.js';
import { can } from '../lib/perm.js';
import * as Fiscal from '../lib/fiscal.js';
import { page, html, raw, money, brDate, brDateTime } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { todayLocal, isYm, addMonths, monthName } from '../lib/time.js';
import * as N from '../lib/nfse.js';
import * as Gateway from '../lib/gateway.js';

const chk = (v) => (v ? raw('checked') : '');
const sel = (a, b) => (String(a) === String(b) ? raw('selected') : '');
const cnpjFmt = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : v || ''; };
const badge = (st) => html`<span class="badge nf-${st}">${N.STATUS[st] || st}</span>`;
const lastDay = (ym) => { const [y, m] = ym.split('-').map(Number); return `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`; };

// ---------- Configurações → Nota fiscal (clínica) e Conta → Dados fiscais → Nota fiscal (CNPJ do profissional) ----------
// scope.uid(req): null = clínica; id = o(a) próprio(a) profissional
function settingsRouter(scope) {
  const s = router();
  const B = scope.base;
  s.get('/', async (req, res) => {
    const uid = scope.uid(req);
    const c = await N.config(uid); const rd = await N.readiness(c); const g = uid ? {} : await Gateway.config();
    const prodOn = c.env === 'producao' || (!uid && c.keySource === 'cobranca' && g.env === 'producao');
    send(res, page(req, { title: 'Nota fiscal (NFS-e)', active: scope.active, body: html`<header class="ph"><div><p class="eyebrow">${uid ? 'Meus dados fiscais' : 'Configurações'}</p><h1>${uid ? 'Nota fiscal com o meu CNPJ' : 'Nota fiscal de serviço (NFS-e)'}</h1>
        <p class="muted">${uid ? 'Emissão da NFS-e em nome da sua empresa (CNPJ), pelo Asaas, para os pacientes que pagam direto para você. A conta do Asaas é a da sua empresa.'
          : 'Emissão da NFS-e em nome da clínica (CNPJ) pelo Asaas, para os recebimentos da clínica. Enquanto não houver CNPJ, fica tudo pronto e desligado — os atendimentos como pessoa física seguem no Receita Saúde.'}</p></div>
        <div class="ph-actions"><a class="btn ghost" href="/financeiro/notas${uid && can(req.user, 'financeiro') ? '?de=eu' : ''}">Notas fiscais</a><a class="btn ghost" href="${scope.back}">Voltar</a></div></header>
      ${!N.cnpjOk(c.cnpj) ? html`<div class="flash info"><b>Aguardando CNPJ.</b> Preencha os dados fiscais quando a empresa estiver aberta; depois conecte a conta do Asaas da empresa, emita uma nota de teste e ligue.</div>`
        : rd.ok ? (c.enabled ? html`<div class="flash ok">✓ Emissão ligada · ${N.MODES[c.mode]} · ${prodOn ? 'produção' : 'testes (sandbox)'}</div>` : html`<div class="flash warn">Tudo configurado. Ligue a emissão abaixo quando quiser começar.</div>`)
        : html`<div class="flash warn">Falta: ${rd.missing.join(', ')}.</div>`}
      <form method="post" class="card stack">
        <h2>${uid ? 'Dados fiscais da sua empresa' : 'Dados fiscais da clínica'}</h2>
        <div class="form-grid">
          <label class="fld"><span>CNPJ</span><input name="cnpj" value="${cnpjFmt(c.cnpj)}" inputmode="numeric" maxlength="18" placeholder="00.000.000/0000-00"></label>
          <label class="fld"><span>Razão social</span><input name="razao" value="${c.razao}" maxlength="160"></label>
          <label class="fld"><span>Inscrição municipal</span><input name="im" value="${c.im}" maxlength="30"></label>
          <label class="fld"><span>Município</span><input name="city" value="${c.city}" maxlength="60"></label>
          <label class="fld"><span>Regime tributário</span><select name="regime">${Object.entries(N.REGIMES).map(([k, l]) => html`<option value="${k}" ${sel(c.regime, k)}>${l}</option>`)}</select></label>
          <label class="fld"><span>CNAE</span><input name="cnae" value="${c.cnae}" maxlength="12"><small class="muted">8650-0/03 — Atividades de psicologia e psicanálise</small></label>
        </div>
        <h2>Serviço</h2>
        <div class="form-grid">
          <label class="fld"><span>Item da lista de serviços (LC 116)</span><input name="serviceCode" value="${c.serviceCode}" maxlength="20"><small class="muted">4.16 — Psicologia e psicanálise</small></label>
          <label class="fld"><span>Descrição do serviço municipal</span><input name="serviceName" value="${c.serviceName}" maxlength="160"></label>
          <label class="fld"><span>ID do serviço no Asaas <small class="muted">(opcional; use a busca abaixo)</small></span><input name="municipalServiceId" value="${c.municipalServiceId}" maxlength="40"></label>
          <label class="fld"><span>Alíquota do ISS (%)</span><input name="issRate" inputmode="decimal" value="${String(c.issRate).replace('.', ',')}"><small class="muted">confirme com a contadora</small></label>
        </div>
        <label class="fld check"><input type="checkbox" name="retainIss" value="1" ${chk(c.retainIss)}><span>ISS retido pelo tomador (raro para pacientes pessoa física)</span></label>
        <label class="fld"><span>Texto da nota</span><textarea name="description" rows="2" maxlength="500">${c.description}</textarea><small class="muted">Variáveis: {data} (pagamento), {mes}, {sessoes}. Evite conteúdo clínico: a nota é um documento fiscal.</small></label>
        <label class="fld"><span>Observações (opcional)</span><input name="observations" value="${c.observations}" maxlength="500"></label>
        <h2>Conta do Asaas</h2>
        ${uid ? html`<p class="muted small">Use a conta do Asaas aberta com o CNPJ da sua empresa (Asaas → Integrações → Chave de API).</p>` : html`<fieldset class="rt-units"><legend>Conta que emite as notas</legend>
          <label class="maint-g"><input type="radio" name="keySource" value="cobranca" ${chk(c.keySource !== 'propria')}><span><b>A mesma da Cobrança online</b><small>${g.key ? `conta já conectada (${g.env === 'producao' ? 'produção' : 'sandbox'})` : 'ainda não conectada'}</small></span></label>
          <label class="maint-g"><input type="radio" name="keySource" value="propria" ${chk(c.keySource === 'propria')}><span><b>Outra conta</b><small>a conta do Asaas aberta com o CNPJ</small></span></label>
        </fieldset>`}
        <div class="form-grid" data-nf-own>
          <label class="fld"><span>Chave da API do Asaas ${c.ownKey ? html`<small class="muted">(cadastrada — preencha só para trocar)</small>` : ''}</span><input name="ownKey" type="password" maxlength="300" autocomplete="off" placeholder="$aact_…"></label>
          <label class="fld"><span>Ambiente</span><select name="env"><option value="sandbox" ${sel(c.env, 'sandbox')}>Testes (sandbox)</option><option value="producao" ${sel(c.env, 'producao')}>Produção — notas reais</option></select></label>
        </div>
        <h2>Emissão</h2>
        <fieldset class="rt-units">${Object.entries(N.MODES).map(([k, l]) => html`<label class="maint-g"><input type="radio" name="mode" value="${k}" ${chk(c.mode === k)}><span><b>${l.split(':')[0]}</b><small>${l.split(':')[1] || ''}</small></span></label>`)}</fieldset>
        <label class="fld check"><input type="checkbox" name="sendToPatient" value="1" ${chk(c.sendToPatient)}><span>Enviar a nota ao paciente (WhatsApp ou e-mail) quando for emitida</span></label>
        <label class="fld check"><input type="checkbox" name="enabled" value="1" ${chk(c.enabled)} ${rd.ok ? '' : raw('disabled')}><span><b>Ligar a emissão de notas</b>${rd.ok ? '' : html` <small class="muted">(disponível quando os dados acima estiverem completos)</small>`}</span></label>
        <div class="actions"><button class="btn">Salvar</button></div>
      </form>
      <section class="card stack"><h2>Testar e buscar o serviço</h2>
        <div class="actions"><form method="post" action="${B}/testar" class="inline"><button class="btn ghost">Testar a conta do Asaas</button></form></div>
        <form method="get" action="${B}/servicos" class="inline-form"><input name="q" value="psicolog" aria-label="Buscar serviço"><button class="btn ghost">Buscar serviço municipal</button></form>
      </section>
      <details class="card tv-tips"><summary>Passo a passo quando o CNPJ sair</summary><ol>
        <li>Com a contadora: confirme o regime (geralmente Simples Nacional), a alíquota do ISS em ${c.city} e a inscrição municipal.</li>
        <li>No Asaas (conta da empresa): Configurações → Notas fiscais → informe os dados da prefeitura e envie o certificado digital, se a prefeitura pedir.</li>
        <li>Aqui: preencha os dados fiscais, ${uid ? 'informe a chave da API' : 'escolha a conta'}, busque o serviço “Psicologia” e salve.</li>
        <li>Emita uma nota de teste no ambiente de testes; confira o PDF. Depois mude para produção e ligue a emissão.</li>
        ${uid ? html`<li>Valem para as notas os recebimentos em que o paciente pagou direto para você (Financeiro → lançamento → “Quem recebeu: o(a) profissional”).</li>` : html`<li>Em Financeiro → Configurar, deixe “Recibo emitido por: Clínica” para os recebimentos que terão nota.</li>`}
      </ol></details>` }));
  });
  s.post('/', async (req, res) => {
    const uid = scope.uid(req); const b = req.body;
    if (b.cnpj && !N.cnpjOk(b.cnpj)) return res.flash('CNPJ inválido. Confira os números.', 'err').redirect(B);
    const cur = await N.config(uid);
    const next = await N.saveConfig(b, cur, uid);
    if (next.enabled && !(await N.readiness(await N.config(uid))).ok) await N.saveConfig({ ...b, enabled: false }, await N.config(uid), uid);
    await audit(req, uid ? 'nfse-config-profissional' : 'nfse-config', next.enabled ? 'ligada' : 'desligada');
    res.flash(next.enabled ? 'Nota fiscal salva e ligada.' : 'Dados da nota fiscal salvos.').redirect(B);
  });
  s.post('/testar', async (req, res) => {
    try {
      const c = await N.config(scope.uid(req)); const r = await N.testConnection(c);
      const same = !c.cnpj || !r.cnpj || r.cnpj === c.cnpj;
      res.flash(`Conta do Asaas conectada: ${r.name}${r.cnpj ? ` (${cnpjFmt(r.cnpj)})` : ''}.${same ? '' : ' Atenção: o CNPJ da conta é diferente do informado.'}`, same ? 'ok' : 'warn');
    } catch (e) { res.flash(`Não foi possível conectar: ${e.message}`, 'err'); }
    res.redirect(B);
  });
  s.get('/servicos', async (req, res) => {
    let list = []; let err = '';
    try { list = await N.searchServices(await N.config(scope.uid(req)), str(req.query.q, 60)); } catch (e) { err = e.message; }
    send(res, page(req, { title: 'Serviço municipal', active: scope.active, body: html`<header class="ph"><div><p class="eyebrow">Nota fiscal</p><h1>Serviço municipal</h1></div><div class="ph-actions"><a class="btn ghost" href="${B}">Voltar</a></div></header>
      ${err ? html`<div class="flash err">${err}</div>` : ''}
      <section class="card">${list.length ? html`<table class="tbl"><thead><tr><th>Código</th><th>Descrição</th><th class="num">ISS</th><th></th></tr></thead><tbody>${list.map((x) => html`<tr><td>${x.code}</td><td>${x.description}</td><td class="num">${x.iss == null ? '—' : `${String(x.iss).replace('.', ',')}%`}</td>
        <td><form method="post" action="${B}/servico" class="inline"><input type="hidden" name="id" value="${x.id}"><input type="hidden" name="code" value="${x.code}"><input type="hidden" name="name" value="${x.description}"><input type="hidden" name="iss" value="${x.iss ?? ''}"><button class="btn ghost btn-sm">Usar este</button></form></td></tr>`)}</tbody></table>`
        : html`<p class="muted">${err ? '' : 'Nenhum serviço encontrado. Tente “psicologia” ou “4.16”.'}</p>`}</section>` }));
  });
  s.post('/servico', async (req, res) => {
    const uid = scope.uid(req); const cur = await N.config(uid);
    await N.saveConfig({ ...cur, ownKey: '', municipalServiceId: str(req.body.id, 40), serviceCode: str(req.body.code, 20) || cur.serviceCode, serviceName: str(req.body.name, 160) || cur.serviceName, issRate: req.body.iss !== '' ? req.body.iss : cur.issRate }, cur, uid);
    res.flash('Serviço municipal escolhido.').redirect(B);
  });
  return s;
}
export const settings = settingsRouter({ uid: () => null, base: '/configuracoes/nfse', back: '/configuracoes', active: 'config' });
export const mySettings = settingsRouter({ uid: (req) => req.user.id, base: '/conta/fiscal/nfse', back: '/conta/fiscal', active: 'conta' });

// ---------- Financeiro → Notas fiscais ----------
export const notes = router();
const isAllF = (req) => can(req.user, 'financeiro');
const isClinU = (u) => u.role === 'admin' || u.role === 'psicologo';
// De quem são as notas da tela: clínica (null) ou do(a) próprio(a) profissional
const notesUid = (req) => (!isAllF(req) || req.query.de === 'eu' || req.body?.de === 'eu' ? req.user.id : null);
// Só a clínica (financeiro) mexe nas notas da clínica; só o(a) profissional mexe nas notas do próprio CNPJ
const mayAct = (req, uid) => (uid ? uid === req.user.id : isAllF(req));
notes.get('/', async (req, res) => {
  const uid = notesUid(req);
  const c = await N.config(uid); const rd = await N.readiness(c);
  const prof = uid ? await Fiscal.profile(uid) : null;
  const ym = isYm(req.query.mes) ? req.query.mes : todayLocal().slice(0, 7);
  const from = `${ym}-01`; const to = lastDay(ym);
  const isPj = !uid || prof.kind === 'pj';
  const [list, without, st] = await Promise.all([N.list(from, to, uid), isPj ? N.withoutNote(from, to, uid) : [], N.stats(from, to, uid)]);
  const on = isPj && c.enabled && rd.ok;
  const de = uid && isAllF(req) ? 'de=eu&' : '';
  const B = `/financeiro/notas?${de}mes=${ym}`;
  const cfgHref = uid ? '/conta/fiscal/nfse' : '/configuracoes/nfse';
  const seg = isAllF(req) && isClinU(req.user) ? html`<nav class="seg fin-scope" aria-label="Notas de">${[['', 'Clínica'], ['eu', 'Meu CNPJ']].map(([k, l]) => html`<a href="/financeiro/notas?${k ? 'de=eu&' : ''}mes=${ym}" class="${(k === 'eu') === !!uid ? 'on' : ''}">${l}</a>`)}</nav>` : '';
  send(res, page(req, { title: 'Notas fiscais', active: 'financeiro', body: html`<header class="ph"><div><p class="eyebrow">Financeiro · ${monthName(ym)}</p><h1>Notas fiscais (NFS-e)${uid ? html` <small class="muted">· meu CNPJ</small>` : ''}</h1></div>
      <div class="ph-actions"><a class="btn ghost" href="?${de}mes=${addMonths(ym, -1)}">←</a><a class="btn ghost" href="?${de}mes=${addMonths(ym, 1)}">→</a><a class="btn ghost" href="${uid ? '/conta/fiscal' : cfgHref}">${uid ? 'Meus dados fiscais' : 'Configurar'}</a></div></header>
    ${seg}
    ${uid && !isPj ? html`<div class="flash info">Você emite como <b>pessoa física</b>: os pacientes que pagam direto para você recebem o recibo do <b>Receita Saúde</b>, lançado por você. <a href="/financeiro/receita-saude${isAllF(req) ? `?prof=${uid}` : ''}">Abrir o assistente do Receita Saúde</a>. Se você tiver CNPJ, mude em <a href="/conta/fiscal">Meus dados fiscais</a>.</div>`
      : !on ? html`<div class="flash info">${!N.cnpjOk(c.cnpj) ? html`<b>Aguardando CNPJ.</b> A emissão de notas fica disponível quando ${uid ? 'o seu CNPJ estiver cadastrado' : 'a clínica tiver CNPJ'}. ` : 'A emissão de notas está desligada. '}<a href="${cfgHref}">Ver configuração</a>. Atendimentos como pessoa física: <a href="/financeiro/receita-saude">Assistente do Receita Saúde</a>.</div>` : ''}
    <section class="kpis"><div class="kpi"><span>Emitidas</span><b>${Number(st?.emitidas || 0)}</b><small>${money(st?.valor || 0)}</small></div>
      <div class="kpi"><span>Em andamento</span><b>${Number(st?.andamento || 0)}</b></div>
      <div class="kpi"><span>Com erro</span><b>${Number(st?.erros || 0)}</b></div>
      ${isPj ? html`<div class="kpi"><span>Recebimentos sem nota</span><b>${without.length}</b><small>${money(without.reduce((a, x) => a + Number(x.amount), 0))}</small></div>` : ''}</section>
    ${without.length ? html`<section class="card"><h2>${uid ? 'Recebimentos direto para você sem nota' : 'Recebimentos da clínica sem nota'}</h2>${without.some((x) => !N.hasCpf(x)) ? html`<p class="muted small">Quem está sem CPF na ficha fica desmarcado: a nota precisa do CPF de quem pagou.</p>` : ''}
      <form method="post" action="/financeiro/notas/lote">
        <input type="hidden" name="back" value="${B}">${uid ? html`<input type="hidden" name="de" value="eu">` : ''}
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th><input type="checkbox" data-check-all aria-label="Selecionar todos" checked></th><th>Pago em</th><th>Paciente</th><th class="num">Valor</th></tr></thead>
        <tbody>${without.map((x) => { const ok = N.hasCpf(x); return html`<tr><td><input type="checkbox" name="ids" value="${x.id}" ${ok ? raw('checked') : ''} aria-label="Selecionar"></td><td>${brDate(x.paid_at)}</td><td><a href="/financeiro/${x.id}">${x.social_name || x.name}</a>${ok ? '' : html` <small class="err-txt">· falta CPF — <a href="/pacientes/${x.patient_id}/editar">completar a ficha</a></small>`}</td><td class="num">${money(x.amount)}</td></tr>`; })}</tbody></table></div>
        <div class="actions"><button class="btn" ${on ? '' : raw(`disabled title="Ligue a emissão em ${uid ? 'Meus dados fiscais' : 'Configurações'} → Nota fiscal"`)}>Emitir as notas selecionadas</button></div>
      </form></section>` : ''}
    <section class="card flush">${list.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pago em</th><th>Paciente</th><th class="num">Valor</th><th>Situação</th><th>Número</th><th></th></tr></thead>
      <tbody>${list.map((n) => html`<tr><td>${brDate(n.paid_at)}</td><td><a href="/financeiro/${n.payment_id}">${n.social_name || n.name}</a></td><td class="num">${money(n.value)}</td>
        <td>${badge(n.status)}${n.error ? html`<br><small class="err-txt">${n.error}</small>` : ''}</td><td>${n.number || '—'}</td>
        <td class="nf-acts">${n.pdf_url ? html`<a class="btn ghost btn-sm" href="${n.pdf_url}" target="_blank" rel="noopener">PDF</a>` : ''}${n.xml_url ? html`<a class="btn ghost btn-sm" href="${n.xml_url}" target="_blank" rel="noopener">XML</a>` : ''}
          ${actionForms(n, B, on)}</td></tr>`)}</tbody></table></div>` : html`<p class="muted pad">Nenhuma nota neste mês.</p>`}</section>` }));
});
function actionForms(n, back, on) {
  const f = (act, label, confirm = '') => html`<form method="post" action="/financeiro/notas/${n.id}/${act}" class="inline" ${confirm ? raw(`data-confirm="${confirm}"`) : ''}><input type="hidden" name="back" value="${back}"><button class="btn ghost btn-sm">${label}</button></form>`;
  return html`${n.status === 'erro' && on ? f('emitir', 'Tentar de novo') : ''}${['agendada', 'cancelando'].includes(n.status) ? f('atualizar', 'Atualizar') : ''}
    ${n.status === 'emitida' ? f('enviar', 'Enviar ao paciente') : ''}${['emitida', 'agendada', 'pendente', 'erro'].includes(n.status) ? f('cancelar', 'Cancelar', 'Cancelar esta nota fiscal? O cancelamento é enviado à prefeitura.') : ''}`;
}
const backOf = (req, d) => { const b = String(req.body.back || ''); return b.startsWith('/') && !b.startsWith('//') ? b : d; };
notes.post('/lote', async (req, res) => {
  const uid = notesUid(req);
  const ids = [].concat(req.body.ids || []).map(Number).filter(Boolean).slice(0, 300);
  let ok = 0; let fail = 0;
  for (const id of ids) { const r = await N.queue(id, req.user.id, uid); if (r.ok) ok++; else fail++; }
  await audit(req, 'nfse-lote', `${ok} na fila${uid ? ' (CNPJ do profissional)' : ''}`);
  N.tick().catch(() => {});
  res.flash(`${ok} nota(s) enviada(s) para emissão.${fail ? ` ${fail} não puderam entrar na fila.` : ''}`, fail ? 'warn' : 'ok').redirect(backOf(req, '/financeiro/notas'));
});
notes.post('/pagamento/:pid', async (req, res) => {
  const pid = int(req.params.pid);
  const uid = await N.issuerUserOf(pid);
  const pay = await one('SELECT professional_id FROM payments WHERE id = ?', [pid]);
  let r;
  if (uid === undefined) r = await N.queue(pid, req.user.id); // devolve o motivo
  else if (!mayAct(req, uid) || (!isAllF(req) && pay?.professional_id !== req.user.id)) r = { ok: false, error: uid ? 'A nota deste recebimento é emitida pelo(a) profissional, com o CNPJ dele(a).' : 'A nota da clínica é emitida pelo financeiro da clínica.' };
  else { r = await N.queue(pid, req.user.id, uid); if (r.ok) await N.emit(r.id); }
  await audit(req, 'nfse-emitir', `payment:${pid}`);
  res.flash(r.ok ? 'Nota fiscal enviada para emissão.' : r.error, r.ok ? 'ok' : 'err').redirect(backOf(req, `/financeiro/${pid}`));
});
notes.post('/:id/:act', async (req, res, next) => {
  const id = int(req.params.id); const act = req.params.act;
  const n = await one('SELECT id, issuer_user_id FROM nfse WHERE id = ?', [id]);
  if (!n) return next();
  if (!mayAct(req, n.issuer_user_id)) return res.status(403).send('Sem permissão');
  let r;
  if (act === 'emitir') { await q("UPDATE nfse SET status = 'pendente' WHERE id = ? AND status = 'erro'", [id]); r = await N.emit(id); }
  else if (act === 'atualizar') r = await N.refresh(id);
  else if (act === 'enviar') r = await N.sendToPatient(id);
  else if (act === 'cancelar') r = await N.cancel(id, req.user.id);
  else return next();
  await audit(req, `nfse-${act}`, `nfse:${id}`);
  const msg = { emitir: 'Nota enviada de novo para emissão.', atualizar: 'Situação atualizada.', enviar: 'Nota enviada ao paciente.', cancelar: 'Cancelamento enviado.' }[act];
  res.flash(r?.ok ? msg : `Não foi possível: ${r?.error || 'erro'}`, r?.ok ? 'ok' : 'err').redirect(backOf(req, '/financeiro/notas'));
});

// Quadro “Documento fiscal” no lançamento do Financeiro: nota da clínica, nota do CNPJ do profissional ou recibo do Receita Saúde
export async function paymentCard(x, req) {
  const rl = await one('SELECT receipt_by FROM fin_rules WHERE user_id = ?', [x.professional_id || 0]);
  const issuer = x.receiver === 'profissional' ? 'profissional' : x.issuer || rl?.receipt_by || 'clinica';
  const hist = await N.historyOf(x.id);
  const back = `/financeiro/${x.id}`;
  const mine = x.professional_id === req.user.id;
  if (issuer === 'profissional') {
    const pf = await Fiscal.profile(x.professional_id);
    const first = (pf.userName || 'o(a) profissional').split(' ')[0];
    const why = x.receiver === 'profissional' ? 'O paciente pagou direto para o(a) profissional' : 'O recibo deste recebimento é do(a) profissional';
    if (pf.kind !== 'pj' || !pf.saved) {
      const miss = Fiscal.missing(pf);
      return html`<section class="card" id="nota-fiscal"><h2>Documento fiscal</h2>
        <p class="muted small">${why}: o documento é emitido por ${mine ? 'você' : first}, como pessoa física, no <b>Receita Saúde</b>.</p>
        ${x.paid_at ? (x.rs_issued_at ? html`<p><span class="badge b-realizada">✓ Lançado no Receita Saúde</span> em ${brDate(x.rs_issued_at)}</p>` : html`<p><span class="badge b-agendada">A lançar no Receita Saúde</span></p>`) : html`<p class="muted">O recibo é lançado depois do pagamento.</p>`}
        ${miss.length ? html`<div class="flash warn small">${mine ? html`Complete seus dados fiscais (${miss.join(', ')}) em <a href="/conta/fiscal">Meus dados fiscais</a>.` : `${first} ainda não completou os dados fiscais (${miss.join(', ')}).`}</div>` : ''}
        ${mine && x.paid_at && !x.rs_issued_at ? html`<div class="actions"><a class="btn ghost" href="/financeiro/receita-saude?mes=${String(x.paid_at).slice(0, 7)}#r-${x.id}">Abrir no assistente do Receita Saúde</a></div>` : ''}
        ${hist.length ? histList(hist) : ''}</section>`;
    }
    const c = await N.config(x.professional_id);
    const cur = hist.find((n) => n.status !== 'cancelada');
    const on = c.enabled && (await N.readiness(c)).ok;
    return html`<section class="card" id="nota-fiscal"><h2>Nota fiscal <small class="muted">· CNPJ de ${mine ? 'você' : first}</small></h2>
      <p class="muted small">${why}: a nota sai com o CNPJ ${pf.razao ? html`de <b>${pf.razao}</b>` : `de ${mine ? 'você' : first}`}${mine ? '' : `, emitida por ${first}`}.</p>
      ${cur ? html`<p>${badge(cur.status)} ${cur.number ? html`· nº <b>${cur.number}</b>` : ''} ${cur.issued_at ? html`· emitida em ${brDateTime(cur.issued_at)}` : ''}${cur.error ? html`<br><small class="err-txt">${cur.error}</small>` : ''}</p>
        <div class="actions">${cur.pdf_url ? html`<a class="btn ghost" href="${cur.pdf_url}" target="_blank" rel="noopener">Ver PDF</a>` : ''}${mine ? actionForms(cur, back, on) : ''}</div>`
        : x.paid_at && on && mine ? html`<p class="muted">Sem nota para este recebimento.</p><form method="post" action="/financeiro/notas/pagamento/${x.id}"><input type="hidden" name="back" value="${back}"><button class="btn ghost">Emitir nota fiscal</button></form>`
        : html`<p class="muted">${!x.paid_at ? 'A nota é emitida depois do pagamento.' : on ? `Sem nota ainda: ${first} emite pelo sistema.` : mine ? html`Emissão desligada. <a href="/conta/fiscal/nfse">Configurar a nota com o meu CNPJ</a>.` : `A emissão de notas de ${first} ainda não está ligada.`}</p>`}
      ${hist.filter((n) => n !== cur).length ? histList(hist.filter((n) => n !== cur)) : ''}</section>`;
  }
  if (!isAllF(req)) return '';
  const c = await N.config();
  if (!c.enabled && !hist.length) return '';
  const cur = hist.find((n) => n.status !== 'cancelada');
  const on = c.enabled && (await N.readiness(c)).ok;
  return html`<section class="card" id="nota-fiscal"><h2>Nota fiscal</h2>
    ${cur ? html`<p>${badge(cur.status)} ${cur.number ? html`· nº <b>${cur.number}</b>` : ''} ${cur.issued_at ? html`· emitida em ${brDateTime(cur.issued_at)}` : ''}${cur.error ? html`<br><small class="err-txt">${cur.error}</small>` : ''}</p>
      <div class="actions">${cur.pdf_url ? html`<a class="btn ghost" href="${cur.pdf_url}" target="_blank" rel="noopener">Ver PDF</a>` : ''}${actionForms(cur, back, on)}</div>`
      : x.paid_at && on ? html`<p class="muted">Sem nota para este recebimento.</p><form method="post" action="/financeiro/notas/pagamento/${x.id}"><input type="hidden" name="back" value="${back}"><button class="btn ghost">Emitir nota fiscal</button></form>`
      : html`<p class="muted">${x.paid_at ? 'Emissão de notas desligada.' : 'A nota é emitida depois do pagamento.'}</p>`}
    ${hist.filter((n) => n !== cur).length ? histList(hist.filter((n) => n !== cur)) : ''}
  </section>`;
}
const histList = (hs) => html`<details><summary class="small muted">Notas anteriores</summary><ul class="plain small">${hs.map((n) => html`<li>${badge(n.status)} ${n.number || ''} ${brDate(n.created_at)}</li>`)}</ul></details>`;
