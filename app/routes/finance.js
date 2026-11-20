import { q, one, audit } from '../lib/db.js';
import { docFmt } from '../lib/br.js';
import { page, bare, html, raw, money, brDate, brDateTime, label } from '../lib/html.js';
import { paymentCard as gatewayCard } from './gateway.js';
import { paymentCard as nfseCard } from './nfse.js';
import * as Fiscal from '../lib/fiscal.js';
const cnpjFmt = (v) => { const d = String(v || '').replace(/\D/g, ''); return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : v || ''; };
const fiscalLine = (fp) => {
  const miss = Fiscal.missing(fp);
  if (!fp.saved) return html`<small class="err-txt">Ainda não preenchidos (Conta → Meus dados fiscais).</small>`;
  return html`<small>${fp.kind === 'pj' ? html`Pessoa jurídica · nota fiscal${fp.cnpj ? ` · CNPJ ${cnpjFmt(fp.cnpj)}` : ' · CNPJ pendente'}` : html`Pessoa física · Receita Saúde${fp.cpf ? ` · CPF ${Fiscal.cpfFmt(fp.cpf)}` : ''}`}</small>${miss.length ? html`<br><small class="err-txt">Falta: ${miss.join(', ')}</small>` : ''}`;
};
import { router, send, int, str, dec } from '../lib/router.js';
import { decrypt } from '../lib/crypto.js';
import { can, proName, forbidden } from '../lib/perm.js';
import * as WA from '../lib/whatsapp.js';
import * as Fin from '../lib/fin.js';
import * as Bank from '../lib/bank.js';
import { barChart, fmtMoney, fmtMoneyShort } from '../lib/charts.js';
import { KEY_TYPES, normalizeKey } from '../lib/pix.js';
import express from 'express';
import QRCode from 'qrcode';
import { todayLocal, isYmd, isYm, addMonths, addDays, monthName, longDate, extenso } from '../lib/time.js';

const r = router();
const nm = (p) => p.social_name || p.name;
const METHODS = Fin.METHODS;
const safeBack = (b, d) => (typeof b === 'string' && b.startsWith('/') && !b.startsWith('//') ? b : d);
const isAll = (req) => can(req.user, 'financeiro');                  // financeiro da clínica
const isClin = (u) => u.role === 'admin' || u.role === 'psicologo';  // tem finanças próprias e acerto
const RECV = { clinica: 'Clínica', profissional: 'Profissional' };
const KIND = { pagar: 'A pagar', receber: 'A receber' };
const dt = (d) => (d ? String(d).slice(0, 10) : '');

// Escopo da tela: finanças da clínica (owner null) ou do(a) próprio(a) usuário(a) (owner = id).
// Despesas pessoais de um(a) profissional só são vistas por ele(a).
function scopeOf(req) {
  if (!isAll(req)) return { owner: req.user.id, key: 'eu', label: 'Minhas finanças' };
  if (req.query.de === 'eu' && isClin(req.user)) return { owner: req.user.id, key: 'eu', label: 'Minhas finanças' };
  return { owner: null, key: 'clinica', label: 'Clínica' };
}
const qsDe = (sc) => (sc.key === 'eu' ? 'de=eu&' : '');
const payVisible = (req, x) => isAll(req) || x.professional_id === req.user.id;

// ---------- anexos (boletos, comprovantes) ----------
const FILE_TYPES = { 'application/pdf': [0x25, 0x50, 0x44, 0x46], 'image/jpeg': [0xff, 0xd8, 0xff], 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/webp': [0x52, 0x49, 0x46, 0x46] };
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
async function attachments(kind, id) {
  const files = await q(`SELECT id, name, mime, size, created_at FROM fin_files WHERE ${kind === 'entry' ? 'entry_id' : 'payment_id'} = ? ORDER BY id`, [id]);
  return html`<section class="card fin-files"><h2>Anexos</h2><p class="muted small sub-h">Boleto, nota, comprovante de pagamento… (PDF, JPG, PNG ou WebP até 5 MB).</p>
    ${files.length ? html`<ul class="list">${files.map((f) => html`<li><a href="/financeiro/arquivos/${f.id}" target="_blank" rel="noopener"><span>📎 ${f.name}<small>${kb(f.size)} · ${brDate(f.created_at)}</small></span></a>
      <form method="post" action="/financeiro/arquivos/${f.id}/excluir" data-confirm="Excluir o anexo “${f.name}”?"><button class="chip">Excluir</button></form></li>`)}</ul>` : ''}
    <label class="btn ghost file-btn"><input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" data-upload="/financeiro/arquivos?tipo=${kind}&id=${id}" hidden>+ Anexar arquivo</label>
    <span class="muted small" data-upload-msg></span></section>`;
}

const SCOPED = ['', 'contas', 'extrato'];
export function tabs(req, active, sc) {
  const t = [['', 'Visão geral'], ['receber', 'Pacientes'], ['contas', 'Contas'], ['extrato', 'Conciliação'], ['pacotes', 'Pacotes'], ['acertos', 'Acertos'], ['relatorios', 'Relatórios']];
  if (isAll(req) || isClin(req.user)) t.push(['notas', 'Notas fiscais']);
  if (isAll(req)) t.push(['convenios', 'Convênios'], ['config', 'Configurar']);
  const deSel = isAll(req) && isClin(req.user) && SCOPED.includes(active)
    ? html`<nav class="seg fin-scope" aria-label="Finanças de">${[['clinica', 'Clínica'], ['eu', 'Minhas finanças']].map(([k, l]) => html`<a href="/financeiro${active ? `/${active}` : ''}${k === 'eu' ? '?de=eu' : ''}" class="${sc.key === k ? 'on' : ''}">${l}</a>`)}</nav>` : '';
  return html`<div class="fin-bar"><nav class="tabs fin-tabs">${t.map(([k, l]) => html`<a href="/financeiro${k ? `/${k}` : ''}${sc.key === 'eu' && isAll(req) && SCOPED.includes(k) ? '?de=eu' : ''}" class="${active === k ? 'on' : ''}">${l}</a>`)}</nav>${deSel}</div>`;
}
const monthNav = (base, ym, extra = '') => html`<a class="btn ghost" href="${base}?${extra}mes=${addMonths(ym, -1)}" aria-label="Mês anterior">←</a><a class="btn ghost" href="${base}?${extra}">Mês atual</a><a class="btn ghost" href="${base}?${extra}mes=${addMonths(ym, 1)}" aria-label="Próximo mês">→</a>`;
const statusBadge = (paid, due, today) => (paid ? html`<span class="badge b-realizada">Pago ${brDate(paid)}</span>` : html`<span class="badge b-${due < today ? 'falta' : 'agendada'}">${due < today ? 'Atrasado' : 'Em aberto'}</span>`);
const professionals = () => q("SELECT id, name, title FROM users WHERE active = 1 AND role IN ('admin','psicologo') AND attends = 1 ORDER BY role = 'admin' DESC, name");

// =====================================================================
// Visão geral
// =====================================================================
r.get('/', async (req, res) => {
  await Fin.ensureRecurring();
  const sc = scopeOf(req);
  const ym = isYm(req.query.mes) ? req.query.mes : todayLocal().slice(0, 7);
  const today = todayLocal();
  const o = await Fin.overview(sc, ym);
  const myPix = sc.owner ? (await Fin.rule(sc.owner)).pix_type : null;
  // quem recebe direto dos pacientes precisa dos próprios dados fiscais (Receita Saúde ou nota com o CNPJ)
  const myFiscalMiss = sc.owner && isClin(req.user) && (await one("SELECT (EXISTS (SELECT 1 FROM payments WHERE professional_id = ? AND receiver = 'profissional') OR EXISTS (SELECT 1 FROM patients WHERE owner_id = ? AND pay_to = 'profissional')) v", [sc.owner, sc.owner]))?.v
    ? Fiscal.missing(await Fiscal.profile(sc.owner)) : [];
  const proj = await Promise.all([30, 60, 90].map((d) => Fin.projection(sc, d)));
  const hist = [];
  for (let i = 5; i >= 0; i--) { const m = addMonths(ym, -i); const x = await Fin.overview(sc, m); hist.push({ label: monthName(m).slice(0, 3), full: monthName(m), value: x.result }); }
  const ownerSql = sc.owner ? 'owner_id = ?' : 'owner_id IS NULL'; const ownerArg = sc.owner ? [sc.owner] : [];
  const dueBills = await q(`SELECT e.*, c.name cat FROM fin_entries e LEFT JOIN fin_categories c ON c.id = e.category_id WHERE ${ownerSql} AND e.paid_at IS NULL AND e.due_date <= ? ORDER BY e.due_date LIMIT 8`, [...ownerArg, addDays(today, 7)]);
  const lateRecv = await q(`SELECT x.*, p.name, p.social_name FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.paid_at IS NULL AND x.due_date < ? ${sc.owner ? 'AND x.professional_id = ?' : "AND x.receiver = 'clinica'"} ORDER BY x.due_date LIMIT 8`, [today, ...(sc.owner ? [sc.owner] : [])]);
  const k = sc.owner
    ? [['Recebido dos meus pacientes', fmtMoney(o.recv.total), 'clínica + direto comigo'], ['Minha parte', fmtMoney(o.income), 'depois do repasse à clínica'], ['Minhas despesas', fmtMoney(o.expense), o.rents ? `inclui aluguel de sala ${fmtMoney(o.rents)}` : 'contas pagas no mês'], ['Resultado do mês', fmtMoney(o.result), o.other ? `+ ${fmtMoney(o.other)} de outras receitas` : '']]
    : [['Recebido na clínica', fmtMoney(o.recv.at_clinic), `${fmtMoney(o.recv.at_prof)} recebidos direto pelos profissionais`], ['Receita da clínica', fmtMoney(o.income), `participação nas sessões${o.rents ? ` + aluguéis ${fmtMoney(o.rents)}` : ''}`], ['Despesas pagas', fmtMoney(o.expense), 'contas pagas no mês'], ['Resultado do mês', fmtMoney(o.result), o.other ? `+ ${fmtMoney(o.other)} de outras receitas` : '']];
  send(res, page(req, {
    title: 'Financeiro', active: 'financeiro',
    body: html`
    <header class="ph"><div><p class="eyebrow">${sc.label} · ${monthName(ym)}</p><h1>Financeiro</h1></div>
      <div class="ph-actions">${monthNav('/financeiro', ym, qsDe(sc))}</div></header>
    ${tabs(req, '', sc)}
    ${myFiscalMiss.length ? html`<div class="flash warn">Pacientes pagam direto para você: o recibo (Receita Saúde) ou a nota fiscal deles é emitido por você. Complete seus dados fiscais (falta: ${myFiscalMiss.join(', ')}). <a class="link" href="/conta/fiscal">Meus dados fiscais →</a></div>` : ''}
    ${sc.owner && isClin(req.user) && !myPix ? html`<div class="flash warn">Você ainda não cadastrou sua chave Pix — sem ela, a cobrança de quem paga direto para você vai sem código Pix. <a class="link" href="/conta#pix">Cadastrar minha chave Pix →</a></div>` : ''}
    <section class="kpis">${k.map(([l, v, s]) => html`<div class="kpi"><span>${l}</span><b class="${l.startsWith('Resultado') && String(v).includes('-') ? 'neg' : ''}">${v}</b>${s ? html`<small>${s}</small>` : ''}</div>`)}</section>
    <div class="grid2">
      <section class="card"><h2>Resultado — últimos 6 meses</h2>${barChart(hist, { fmt: fmtMoney, fmtY: fmtMoneyShort, title: 'Resultado mensal' })}</section>
      <section class="card"><h2>Fluxo de caixa previsto</h2><p class="muted small sub-h">Contas em aberto até a data (${sc.owner ? 'recebimentos diretos com você e suas contas' : 'recebimentos na clínica e contas da clínica'}).</p>
        <div class="fin-proj">${proj.map((p) => html`<div><b>${p.days} dias</b><span class="in">+ ${fmtMoney(p.in)}</span><span class="out">− ${fmtMoney(p.out)}</span><strong class="${p.net < 0 ? 'neg' : ''}">${fmtMoney(p.net)}</strong></div>`)}</div>
      </section>
    </div>
    <div class="grid2">
      <section class="card"><h2>Contas vencendo (7 dias) e vencidas</h2>
        ${dueBills.length ? html`<ul class="list">${dueBills.map((e) => html`<li><a href="/financeiro/contas/${e.id}"><b class="time">${brDate(e.due_date).slice(0, 5)}</b><span>${e.description}<small>${KIND[e.kind]} · ${e.cat || 'sem categoria'}</small></span><b>${money(e.amount)}</b>${statusBadge(null, dt(e.due_date), today)}</a></li>`)}</ul>`
        : html`<p class="muted">Nada vencendo nos próximos 7 dias.</p>`}
        <p><a class="link" href="/financeiro/contas${sc.key === 'eu' ? '?de=eu' : ''}">Ver todas as contas →</a></p></section>
      <section class="card"><h2>Pacientes em atraso</h2>
        ${lateRecv.length ? html`<ul class="list">${lateRecv.map((x) => html`<li><a href="/financeiro/${x.id}"><b class="time">${brDate(x.due_date).slice(0, 5)}</b><span>${nm(x)}<small>${x.description}</small></span><b>${money(x.amount)}</b></a></li>`)}</ul>`
        : html`<p class="muted">Nenhum paciente em atraso. 🎉</p>`}
        <p><a class="link" href="/financeiro/receber?status=atrasado">Ver recebimentos →</a></p></section>
    </div>`,
  }));
});

// =====================================================================
// Pacientes (contas a receber de sessões e pacotes)
// =====================================================================
r.get('/receber', async (req, res) => {
  const all = isAll(req);
  const ym = isYm(req.query.mes) ? req.query.mes : todayLocal().slice(0, 7);
  const status = ['todos', 'pago', 'aberto', 'atrasado'].includes(req.query.status) ? req.query.status : 'todos';
  const prof = all ? int(req.query.prof) : req.user.id;
  const today = todayLocal();
  let where = "DATE_FORMAT(x.due_date,'%Y-%m') = ?"; const params = [ym];
  if (status === 'pago') where += ' AND x.paid_at IS NOT NULL';
  if (status === 'aberto') where += ' AND x.paid_at IS NULL';
  if (status === 'atrasado') { where = 'x.paid_at IS NULL AND x.due_date < ?'; params[0] = today; }
  if (prof) { where += ' AND x.professional_id = ?'; params.push(prof); }
  const rows = await q(`SELECT x.*, p.name, p.social_name, u.name pro FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN users u ON u.id = x.professional_id WHERE ${where} ORDER BY x.due_date, x.id`, params);
  const sum = (f) => rows.filter(f).reduce((s, x) => s + Number(x.amount), 0);
  const patients = await q(`SELECT id, name, social_name, session_fee FROM patients WHERE status <> 'inativo' ${all ? '' : 'AND owner_id = ?'} ORDER BY name`, all ? [] : [req.user.id]);
  const pros = all ? await professionals() : [];
  const qs = (o) => new URLSearchParams({ mes: ym, status, ...(prof && all ? { prof } : {}), ...o }).toString();
  const waOn = WA.ready(await WA.config());
  const lateN = rows.filter((x) => !x.paid_at && dt(x.due_date) < today).length;
  send(res, page(req, {
    title: 'Financeiro · Pacientes', active: 'financeiro',
    body: html`
    <header class="ph"><div><p class="eyebrow">${status === 'atrasado' ? 'Todos os meses' : monthName(ym)}</p><h1>Recebimentos de pacientes</h1></div>
      <div class="ph-actions"><a class="btn ghost" href="/financeiro/movimentacoes">Movimentações</a><a class="btn ghost" href="?${qs({ mes: addMonths(ym, -1) })}">←</a><a class="btn ghost" href="?${qs({ mes: todayLocal().slice(0, 7) })}">Mês atual</a><a class="btn ghost" href="?${qs({ mes: addMonths(ym, 1) })}">→</a></div></header>
    ${tabs(req, 'receber', scopeOf(req))}
    <section class="kpis">
      <div class="kpi"><span>Recebido</span><b>${money(sum((x) => x.paid_at))}</b><small>${money(sum((x) => x.paid_at && x.receiver === 'clinica'))} na clínica · ${money(sum((x) => x.paid_at && x.receiver === 'profissional'))} direto</small></div>
      <div class="kpi"><span>Em aberto</span><b>${money(sum((x) => !x.paid_at && dt(x.due_date) >= today))}</b></div>
      <div class="kpi"><span>Atrasado</span><b>${money(sum((x) => !x.paid_at && dt(x.due_date) < today))}</b></div>
      <div class="kpi"><span>Lançamentos</span><b>${rows.length}</b></div>
    </section>
    <details class="card fin-new"><summary><b>+ Novo lançamento avulso</b> <span class="muted small">(sessões realizadas já geram a cobrança sozinhas; pacotes ficam na aba Pacotes)</span></summary>
      <form method="post" action="/financeiro/novo" class="form-grid">
        <label class="fld span2"><span>Paciente</span><select name="patient_id" required><option value="">Selecione…</option>${patients.map((p) => html`<option value="${p.id}">${nm(p)}</option>`)}</select></label>
        <label class="fld span2"><span>Descrição</span><input name="description" value="Sessão de psicoterapia" required maxlength="255"></label>
        <label class="fld"><span>Valor (R$)</span><input name="amount" inputmode="decimal" required placeholder="0,00"></label>
        <label class="fld"><span>Vencimento</span><input type="date" name="due_date" value="${today}" required></label>
        <div class="span2 actions"><button class="btn">Lançar</button></div>
      </form></details>
    <form class="filters" method="get"><input type="hidden" name="mes" value="${ym}">
      ${['todos', 'pago', 'aberto', 'atrasado'].map((s) => html`<a class="chip ${s === status ? 'on' : ''}" href="?${qs({ status: s })}">${{ todos: 'Todos', pago: 'Pagos', aberto: 'Em aberto', atrasado: 'Atrasados' }[s]}</a>`)}
      ${all ? html`<select name="prof" data-autosubmit><option value="">Todos os profissionais</option>${pros.map((u) => html`<option value="${u.id}" ${prof === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select><input type="hidden" name="status" value="${status}">` : ''}
    </form>
    ${status === 'atrasado' && waOn && lateN ? html`<form method="post" action="/financeiro/receber/cobrar-atrasados" class="bulk-charge" data-confirm="Enviar cobrança pelo WhatsApp para os pacientes em atraso que autorizaram mensagens? (no máximo 30, um a cada ~5 segundos; quem já foi cobrado nos últimos 3 dias fica de fora)">${prof && all ? html`<input type="hidden" name="prof" value="${prof}">` : ''}<button class="btn">💬 Cobrar atrasados pelo WhatsApp (${lateN})</button></form>` : ''}
    <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Vencimento</th><th>Paciente</th><th>Descrição</th>${all ? html`<th>Profissional</th>` : ''}<th>Valor</th><th>Recebe</th><th>Situação</th><th></th></tr></thead>
      <tbody>${rows.map((x) => html`<tr data-href="/financeiro/${x.id}"><td>${brDate(x.due_date)}</td><td><a href="/pacientes/${x.patient_id}?aba=financeiro">${nm(x)}</a></td><td>${x.description}${x.package_id ? html` <span class="badge b-confirmada">pacote</span>` : ''}${x.origin === 'falta' ? html` <span class="badge b-falta">falta</span>` : ''}${x.charged_at && !x.paid_at ? html` <span class="badge b-agendada" title="Cobrança enviada em ${brDate(x.charged_at)}">💬 cobrado</span>` : ''}${x.informed_at && !x.paid_at ? html` <span class="badge b-confirmada" title="O paciente avisou pelo portal em ${brDateTime(x.informed_at)}">✓ paciente informou</span>` : ''}</td>${all ? html`<td>${x.pro ? x.pro.split(' ')[0] : '—'}</td>` : ''}<td>${money(x.amount)}</td>
        <td><span class="badge ${x.receiver === 'clinica' ? 'b-confirmada' : 'b-agendada'}">${RECV[x.receiver]}</span></td>
        <td>${x.paid_at ? html`<span class="badge b-realizada">Pago ${brDate(x.paid_at)} · ${label(x.method)}</span>` : statusBadge(null, dt(x.due_date), today)}${x.settlement_id ? html` <span class="badge b-cancelada" title="Já incluído num acerto fechado">acertado</span>` : ''}</td>
        <td>${x.paid_at ? html`<a class="link small" href="/financeiro/${x.id}/recibo" target="_blank">recibo</a>` : html`<a class="link small" href="/financeiro/${x.id}">receber</a>`}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhum lançamento.</p>`}</section>`,
  }));
});

// Cobrança em lote dos atrasados (em segundo plano, devagar, para não arriscar o número do WhatsApp)
r.post('/receber/cobrar-atrasados', async (req, res) => {
  const all = isAll(req);
  const prof = all ? int(req.body.prof) : req.user.id;
  const rows = await q(`SELECT x.id FROM payments x JOIN patients p ON p.id = x.patient_id
    WHERE x.paid_at IS NULL AND x.due_date < ? AND p.whatsapp_optin = 1 AND p.phone IS NOT NULL AND p.phone <> ''
      AND (x.charged_at IS NULL OR x.charged_at < DATE_SUB(NOW(), INTERVAL 3 DAY)) ${prof ? 'AND x.professional_id = ?' : ''}
    ORDER BY x.due_date LIMIT 30`, [todayLocal(), ...(prof ? [prof] : [])]);
  await audit(req, 'whatsapp-cobranca-lote', `${rows.length} cobrança(s)`);
  const uid = req.user.id; const gap = Number(process.env.WA_BULK_GAP_MS || 5000);
  (async () => { for (const [i, x] of rows.entries()) { if (i) await new Promise((ok) => setTimeout(ok, gap)); try { await WA.sendCharge(x.id, uid); } catch (e) { console.error('cobrança', e.message); } } })();
  res.flash(rows.length ? `Enviando ${rows.length} cobrança(s) pelo WhatsApp, uma a cada ~${Math.round(gap / 1000)} s. A coluna “cobrado” atualiza sozinha.` : 'Nenhum paciente em atraso para cobrar agora (sem autorização de WhatsApp, sem telefone ou já cobrado nos últimos 3 dias).', rows.length ? 'ok' : 'warn').redirect('/financeiro/receber?status=atrasado');
});

r.post('/novo', async (req, res) => {
  const b = req.body;
  const p = await one('SELECT id, owner_id, pay_to FROM patients WHERE id = ?', [int(b.patient_id)]);
  const amount = dec(b.amount);
  const back = safeBack(b.back, '/financeiro/receber');
  if (!p || !amount || !isYmd(b.due_date)) return res.flash('Preencha paciente, valor e vencimento.', 'err').redirect(back);
  if (!isAll(req) && p.owner_id !== req.user.id) return res.status(403).send('Sem permissão');
  const rule = await Fin.rule(p.owner_id);
  await q('INSERT INTO payments (patient_id, description, amount, due_date, professional_id, receiver, issuer) VALUES (?,?,?,?,?,?,?)',
    [p.id, str(b.description) || 'Sessão de psicoterapia', amount, b.due_date, p.owner_id, p.pay_to, rule.receipt_by]);
  await audit(req, 'financeiro-lancar', `patient:${p.id}`);
  res.flash('Lançamento criado.').redirect(back);
});

// =====================================================================
// Contas a pagar e a receber (clínica ou finanças próprias)
// =====================================================================
async function entriesPage(req, res) {
  await Fin.ensureRecurring();
  const sc = scopeOf(req);
  const ym = isYm(req.query.mes) ? req.query.mes : todayLocal().slice(0, 7);
  const kind = ['pagar', 'receber'].includes(req.query.tipo) ? req.query.tipo : 'todos';
  const status = ['todos', 'aberto', 'pago', 'atrasado'].includes(req.query.status) ? req.query.status : 'todos';
  const today = todayLocal();
  const ow = sc.owner ? 'e.owner_id = ?' : 'e.owner_id IS NULL'; const oa = sc.owner ? [sc.owner] : [];
  let where = `${ow} AND DATE_FORMAT(e.due_date,'%Y-%m') = ?`; let params = [...oa, ym];
  if (status === 'atrasado') { where = `${ow} AND e.paid_at IS NULL AND e.due_date < ?`; params = [...oa, today]; }
  if (status === 'aberto') where += ' AND e.paid_at IS NULL';
  if (status === 'pago') where += ' AND e.paid_at IS NOT NULL';
  if (kind !== 'todos') { where += ' AND e.kind = ?'; params.push(kind); }
  const rows = await q(`SELECT e.*, c.name cat FROM fin_entries e LEFT JOIN fin_categories c ON c.id = e.category_id WHERE ${where} ORDER BY e.due_date, e.id`, params);
  const cats = await q('SELECT * FROM fin_categories WHERE active = 1 ORDER BY kind, name');
  const recs = await q(`SELECT r.*, c.name cat FROM fin_recurring r LEFT JOIN fin_categories c ON c.id = r.category_id WHERE ${sc.owner ? 'r.owner_id = ?' : 'r.owner_id IS NULL'} AND r.active = 1 ORDER BY r.day`, oa);
  const tot = (k, f) => rows.filter((e) => e.kind === k && f(e)).reduce((s, e) => s + Number(e.amount), 0);
  const qs = (o) => new URLSearchParams({ ...(sc.key === 'eu' && isAll(req) ? { de: 'eu' } : {}), mes: ym, tipo: kind, status, ...o }).toString();
  send(res, page(req, {
    title: 'Financeiro · Contas', active: 'financeiro',
    body: html`
    <header class="ph"><div><p class="eyebrow">${sc.label} · ${status === 'atrasado' ? 'todos os meses' : monthName(ym)}</p><h1>Contas a pagar e a receber</h1></div>
      <div class="ph-actions"><a class="btn ghost" href="?${qs({ mes: addMonths(ym, -1) })}">←</a><a class="btn ghost" href="?${qs({ mes: today.slice(0, 7) })}">Mês atual</a><a class="btn ghost" href="?${qs({ mes: addMonths(ym, 1) })}">→</a></div></header>
    ${tabs(req, 'contas', sc)}
    <section class="kpis">
      <div class="kpi"><span>A pagar (em aberto)</span><b>${money(tot('pagar', (e) => !e.paid_at))}</b><small>${money(tot('pagar', (e) => !e.paid_at && dt(e.due_date) < today))} vencido</small></div>
      <div class="kpi"><span>Pago</span><b>${money(tot('pagar', (e) => e.paid_at))}</b></div>
      <div class="kpi"><span>A receber (em aberto)</span><b>${money(tot('receber', (e) => !e.paid_at))}</b></div>
      <div class="kpi"><span>Recebido</span><b>${money(tot('receber', (e) => e.paid_at))}</b></div>
    </section>
    <details class="card fin-new" ${rows.length ? '' : raw('open')}><summary><b>+ Nova conta</b> <span class="muted small">${sc.owner ? '(suas finanças: só você vê)' : '(da clínica)'}</span></summary>
      <form method="post" action="/financeiro/contas/nova" class="form-grid">
        <input type="hidden" name="de" value="${sc.key}">
        <label class="fld"><span>Tipo</span><select name="kind"><option value="pagar">A pagar (despesa)</option><option value="receber">A receber</option></select></label>
        <label class="fld"><span>Categoria</span><select name="category_id"><option value="">—</option>${cats.map((c) => html`<option value="${c.id}">${c.kind === 'receita' ? '↑ ' : ''}${c.name}</option>`)}</select></label>
        <label class="fld span2"><span>Descrição</span><input name="description" required maxlength="255" placeholder="Ex.: Aluguel da sala, Internet, Supervisão"></label>
        <label class="fld"><span>Fornecedor / quem paga</span><input name="counterpart" maxlength="160"></label>
        <label class="fld"><span>Valor (R$)</span><input name="amount" inputmode="decimal" required placeholder="0,00"></label>
        <label class="fld"><span>Vencimento</span><input type="date" name="due_date" value="${today}" required></label>
        <label class="fld check"><input type="checkbox" name="recurring" value="1"><span>Repetir todo mês (conta fixa)</span></label>
        <label class="fld"><span>Repetir até (opcional)</span><input type="month" name="end_ym"></label>
        <label class="fld check"><input type="checkbox" name="paid" value="1"><span>Já está paga/recebida</span></label>
        <div class="span2 actions"><button class="btn">Salvar conta</button></div>
      </form></details>
    <div class="filters">
      ${['todos', 'pagar', 'receber'].map((s) => html`<a class="chip ${s === kind ? 'on' : ''}" href="?${qs({ tipo: s })}">${{ todos: 'Todas', pagar: 'A pagar', receber: 'A receber' }[s]}</a>`)}
      <span class="sep"></span>
      ${['todos', 'aberto', 'pago', 'atrasado'].map((s) => html`<a class="chip ${s === status ? 'on' : ''}" href="?${qs({ status: s })}">${{ todos: 'Todas', aberto: 'Em aberto', pago: 'Pagas', atrasado: 'Vencidas' }[s]}</a>`)}
    </div>
    <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Vencimento</th><th>Descrição</th><th>Categoria</th><th>Tipo</th><th>Valor</th><th>Situação</th><th></th></tr></thead>
      <tbody>${rows.map((e) => html`<tr data-href="/financeiro/contas/${e.id}"><td>${brDate(e.due_date)}</td><td>${e.description}${e.counterpart ? html`<small class="muted block">${e.counterpart}</small>` : ''}${e.recurring_id ? html` <span class="badge b-confirmada" title="Conta fixa mensal">fixa</span>` : ''}${e.settlement_id ? html` <span class="badge b-agendada">acerto</span>` : ''}</td>
        <td>${e.cat || '—'}</td><td>${KIND[e.kind]}</td><td class="${e.kind === 'pagar' ? 'neg' : 'pos'}">${e.kind === 'pagar' ? '−' : '+'} ${money(e.amount)}</td><td>${statusBadge(e.paid_at, dt(e.due_date), today)}</td>
        <td>${e.paid_at ? '' : html`<form method="post" action="/financeiro/contas/${e.id}/pagar" class="inline-pay"><input type="hidden" name="back" value="${req.originalUrl}"><button class="chip" title="Marcar como ${e.kind === 'pagar' ? 'paga' : 'recebida'} hoje">✓ ${e.kind === 'pagar' ? 'Paga' : 'Recebida'}</button></form>`}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhuma conta neste filtro.</p>`}</section>
    ${recs.length ? html`<section class="card"><h2>Contas fixas mensais</h2><ul class="list">${recs.map((rc) => html`<li><span>${rc.description}<small>${KIND[rc.kind]} · ${rc.cat || 'sem categoria'} · todo dia ${rc.day}${rc.end_ym ? ` até ${rc.end_ym.split('-').reverse().join('/')}` : ''}</small></span><b>${money(rc.amount)}</b>
      <form method="post" action="/financeiro/recorrencias/${rc.id}/encerrar" data-confirm="Parar de gerar esta conta todo mês? As contas já geradas continuam."><button class="chip">Encerrar</button></form></li>`)}</ul></section>` : ''}`,
  }));
}
r.get('/contas', (req, res, next) => entriesPage(req, res).catch(next));

const entryAllowed = (req, e) => (e.owner_id === null ? isAll(req) : e.owner_id === req.user.id);

r.post('/contas/nova', async (req, res) => {
  const b = req.body;
  const owner = b.de === 'eu' || !isAll(req) ? req.user.id : null;
  if (owner && !isClin(req.user) && !isAll(req)) return res.status(403).send('Sem permissão');
  const back = `/financeiro/contas${owner && isAll(req) ? '?de=eu' : ''}`;
  const amount = dec(b.amount);
  const kind = b.kind === 'receber' ? 'receber' : 'pagar';
  if (!str(b.description) || !amount || !isYmd(b.due_date)) return res.flash('Preencha descrição, valor e vencimento.', 'err').redirect(back);
  const cat = int(b.category_id) && (await one('SELECT id FROM fin_categories WHERE id = ?', [int(b.category_id)])) ? int(b.category_id) : null;
  if (b.recurring) {
    const rc = await q('INSERT INTO fin_recurring (owner_id, kind, category_id, description, counterpart, amount, day, start_ym, end_ym, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
      [owner, kind, cat, str(b.description), str(b.counterpart, 160) || null, amount, Number(b.due_date.slice(8)), b.due_date.slice(0, 7), isYm(b.end_ym) ? b.end_ym : null, req.user.id]);
    await Fin.ensureRecurring();
    if (b.paid) await q('UPDATE fin_entries SET paid_at = ? WHERE recurring_id = ? AND rec_ym = ?', [todayLocal(), rc.insertId, b.due_date.slice(0, 7)]);
  } else {
    await q('INSERT INTO fin_entries (owner_id, kind, category_id, description, counterpart, amount, due_date, paid_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)',
      [owner, kind, cat, str(b.description), str(b.counterpart, 160) || null, amount, b.due_date, b.paid ? todayLocal() : null, req.user.id]);
  }
  await audit(req, 'financeiro-conta', `${owner ? 'pessoal' : 'clinica'} ${kind}`);
  res.flash(b.recurring ? 'Conta fixa criada — ela será gerada todo mês.' : 'Conta salva.').redirect(back);
});

r.get('/contas/:id', async (req, res, next) => {
  const e = await one('SELECT e.*, c.name cat FROM fin_entries e LEFT JOIN fin_categories c ON c.id = e.category_id WHERE e.id = ?', [int(req.params.id)]);
  if (!e) return next();
  if (!entryAllowed(req, e)) return next(forbidden());
  const cats = await q('SELECT * FROM fin_categories WHERE active = 1 ORDER BY kind, name');
  const back = `/financeiro/contas${e.owner_id && isAll(req) ? '?de=eu' : ''}`;
  const files = await attachments('entry', e.id);
  send(res, page(req, {
    title: 'Conta', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">${KIND[e.kind]} · ${e.owner_id ? 'Minhas finanças' : 'Clínica'}</p><h1>${money(e.amount)}</h1></div><div class="ph-actions"><a class="btn ghost" href="${back}">Voltar</a></div></header>
    ${e.settlement_id ? html`<div class="flash warn">Esta conta foi gerada por um <a class="link" href="/financeiro/acertos">acerto</a>: valor e vencimento vêm do acerto. Pagar aqui quita os dois lados.</div>` : ''}
    <form method="post" action="/financeiro/contas/${e.id}" class="card form-grid">
      <label class="fld span2"><span>Descrição</span><input name="description" value="${e.description}" required maxlength="255" ${e.settlement_id ? raw('readonly') : ''}></label>
      <label class="fld"><span>Categoria</span><select name="category_id"><option value="">—</option>${cats.map((c) => html`<option value="${c.id}" ${c.id === e.category_id ? raw('selected') : ''}>${c.kind === 'receita' ? '↑ ' : ''}${c.name}</option>`)}</select></label>
      <label class="fld"><span>Fornecedor / quem paga</span><input name="counterpart" value="${e.counterpart || ''}" maxlength="160"></label>
      <label class="fld"><span>Valor (R$)</span><input name="amount" inputmode="decimal" value="${String(e.amount).replace('.', ',')}" required ${e.settlement_id ? raw('readonly') : ''}></label>
      <label class="fld"><span>Vencimento</span><input type="date" name="due_date" value="${dt(e.due_date)}" required></label>
      <label class="fld"><span>${e.kind === 'pagar' ? 'Pago' : 'Recebido'} em</span><input type="date" name="paid_at" value="${dt(e.paid_at) || todayLocal()}"></label>
      <label class="fld"><span>Forma</span><select name="method">${METHODS.map((m) => html`<option value="${m}" ${m === (e.method || 'pix') ? raw('selected') : ''}>${label(m)}</option>`)}</select></label>
      <label class="fld check span2"><input type="checkbox" name="paid" value="1" ${e.paid_at ? raw('checked') : ''}><span>${e.kind === 'pagar' ? 'Conta paga' : 'Valor recebido'}</span></label>
      <label class="fld span2"><span>Observações</span><input name="notes" value="${e.notes || ''}" maxlength="500"></label>
      <div class="span2 actions"><button class="btn">Salvar</button></div>
    </form>
    ${files}
    ${e.settlement_id ? '' : html`<form method="post" action="/financeiro/contas/${e.id}/excluir" class="danger-zone" data-confirm="Excluir esta conta?"><button class="btn danger">Excluir conta</button></form>`}`,
  }));
});

r.post('/contas/:id', async (req, res, next) => {
  const e = await one('SELECT * FROM fin_entries WHERE id = ?', [int(req.params.id)]);
  if (!e) return next();
  if (!entryAllowed(req, e)) return next(forbidden());
  const b = req.body; const amount = e.settlement_id ? Number(e.amount) : dec(b.amount);
  if (!amount || !isYmd(b.due_date)) return res.flash('Valor ou vencimento inválido.', 'err').redirect(`/financeiro/contas/${e.id}`);
  const paid = b.paid && isYmd(b.paid_at) ? b.paid_at : null;
  const cat = int(b.category_id) || null;
  await q('UPDATE fin_entries SET description = ?, category_id = ?, counterpart = ?, amount = ?, due_date = ?, notes = ? WHERE id = ?',
    [e.settlement_id ? e.description : str(b.description) || e.description, cat, str(b.counterpart, 160) || null, amount, b.due_date, str(b.notes, 500) || null, e.id]);
  if (paid) await Fin.markEntryPaid(e.id, paid, METHODS.includes(b.method) ? b.method : null);
  else if (e.paid_at) await (e.settlement_id ? q('UPDATE fin_entries SET paid_at = NULL, method = NULL WHERE settlement_id = ?', [e.settlement_id]) : q('UPDATE fin_entries SET paid_at = NULL, method = NULL WHERE id = ?', [e.id]));
  await audit(req, 'financeiro-conta-editar', `entry:${e.id}`);
  res.flash('Conta atualizada.').redirect(`/financeiro/contas/${e.id}`);
});

r.post('/contas/:id/pagar', async (req, res, next) => {
  const e = await one('SELECT * FROM fin_entries WHERE id = ?', [int(req.params.id)]);
  if (!e) return next();
  if (!entryAllowed(req, e)) return next(forbidden());
  await Fin.markEntryPaid(e.id, todayLocal(), e.method || 'pix');
  await audit(req, 'financeiro-conta-pagar', `entry:${e.id}`);
  res.flash(`${e.description}: ${e.kind === 'pagar' ? 'paga' : 'recebida'} hoje.`).redirect(safeBack(req.body.back, '/financeiro/contas'));
});

r.post('/contas/:id/excluir', async (req, res, next) => {
  const e = await one('SELECT * FROM fin_entries WHERE id = ?', [int(req.params.id)]);
  if (!e) return next();
  if (!entryAllowed(req, e) || e.settlement_id) return next(forbidden());
  await q('DELETE FROM fin_entries WHERE id = ?', [e.id]);
  await Bank.unlink('entry', e.id);
  await audit(req, 'financeiro-conta-excluir', `entry:${e.id}`);
  res.flash('Conta excluída.').redirect(`/financeiro/contas${e.owner_id && isAll(req) ? '?de=eu' : ''}`);
});

r.post('/recorrencias/:id/encerrar', async (req, res, next) => {
  const rc = await one('SELECT * FROM fin_recurring WHERE id = ?', [int(req.params.id)]);
  if (!rc) return next();
  if (!entryAllowed(req, rc)) return next(forbidden());
  await q('UPDATE fin_recurring SET active = 0 WHERE id = ?', [rc.id]);
  // remove as contas futuras ainda não pagas desta recorrência
  await q('DELETE FROM fin_entries WHERE recurring_id = ? AND paid_at IS NULL AND due_date > ?', [rc.id, todayLocal()]);
  await audit(req, 'financeiro-recorrencia-encerrar', `recurring:${rc.id}`);
  res.flash('Conta fixa encerrada.').redirect(`/financeiro/contas${rc.owner_id && isAll(req) ? '?de=eu' : ''}`);
});

// =====================================================================
// Pacotes
// =====================================================================
r.get('/pacotes', async (req, res) => {
  const all = isAll(req);
  const rows = await q(`SELECT k.*, p.name, p.social_name, x.paid_at, x.due_date, u.name pro FROM fin_packages k JOIN patients p ON p.id = k.patient_id LEFT JOIN payments x ON x.id = k.payment_id LEFT JOIN users u ON u.id = k.professional_id
    ${all ? '' : 'WHERE k.professional_id = ?'} ORDER BY k.status = 'ativo' DESC, k.id DESC LIMIT 200`, all ? [] : [req.user.id]);
  const patients = await q(`SELECT id, name, social_name, session_fee FROM patients WHERE status IN ('ativo','pausa') ${all ? '' : 'AND owner_id = ?'} ORDER BY name`, all ? [] : [req.user.id]);
  const pre = int(req.query.paciente);
  send(res, page(req, {
    title: 'Financeiro · Pacotes', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">Financeiro</p><h1>Pacotes de sessões</h1></div></header>
    ${tabs(req, 'pacotes', scopeOf(req))}
    <section class="card"><h2>Novo pacote</h2><p class="muted small sub-h">Gera a cobrança do pacote. Cada sessão realizada consome 1 sessão do pacote (sem gerar nova cobrança) até acabar.</p>
      <form method="post" action="/financeiro/pacotes/novo" class="form-grid">
        <label class="fld span2"><span>Paciente</span><select name="patient_id" required><option value="">Selecione…</option>${patients.map((p) => html`<option value="${p.id}" data-fee="${p.session_fee || ''}" ${pre === p.id ? raw('selected') : ''}>${nm(p)}${p.session_fee ? ` · sessão ${money(p.session_fee)}` : ''}</option>`)}</select></label>
        <label class="fld"><span>Quantidade de sessões</span><input name="sessions" type="number" min="2" max="60" value="4" required></label>
        <label class="fld"><span>Valor total do pacote (R$)</span><input name="amount" inputmode="decimal" required placeholder="0,00"></label>
        <label class="fld"><span>Vencimento</span><input type="date" name="due_date" value="${todayLocal()}" required></label>
        <div class="span2 actions"><button class="btn">Criar pacote</button></div>
      </form></section>
    <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Paciente</th>${all ? html`<th>Profissional</th>` : ''}<th>Sessões</th><th>Valor</th><th>Pagamento</th><th>Situação</th><th></th></tr></thead>
      <tbody>${rows.map((k) => html`<tr ${k.payment_id ? raw(`data-href="/financeiro/${k.payment_id}"`) : ''}><td>${nm(k)}</td>${all ? html`<td>${k.pro ? k.pro.split(' ')[0] : '—'}</td>` : ''}
        <td><div class="pk-bar" title="${k.sessions_used} de ${k.sessions_total} usadas"><i style="width:${Math.round((k.sessions_used / k.sessions_total) * 100)}%"></i></div><small>${k.sessions_used} de ${k.sessions_total} · restam ${k.sessions_total - k.sessions_used}</small></td>
        <td>${money(k.amount)}<small class="muted block">${money(k.amount / k.sessions_total)}/sessão</small></td>
        <td>${k.paid_at ? html`<span class="badge b-realizada">Pago ${brDate(k.paid_at)}</span>` : statusBadge(null, dt(k.due_date), todayLocal())}</td>
        <td><span class="badge ${k.status === 'ativo' ? 'b-confirmada' : 'b-cancelada'}">${k.status === 'ativo' ? 'Ativo' : 'Encerrado'}</span></td>
        <td>${k.status === 'ativo' ? html`<form method="post" action="/financeiro/pacotes/${k.id}/encerrar" data-confirm="Encerrar este pacote? As sessões restantes não serão mais consumidas."><button class="chip">Encerrar</button></form>` : ''}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhum pacote ainda.</p>`}</section>`,
  }));
});

r.post('/pacotes/novo', async (req, res) => {
  const b = req.body;
  const p = await one('SELECT id, owner_id FROM patients WHERE id = ?', [int(b.patient_id)]);
  const sessions = int(b.sessions); const amount = dec(b.amount);
  if (!p || !sessions || sessions < 2 || sessions > 60 || !amount || !isYmd(b.due_date)) return res.flash('Preencha paciente, sessões (2 a 60), valor e vencimento.', 'err').redirect('/financeiro/pacotes');
  if (!isAll(req) && p.owner_id !== req.user.id) return res.status(403).send('Sem permissão');
  if (await Fin.activePackage(p.id)) return res.flash('Este paciente já tem um pacote ativo. Encerre-o antes de criar outro.', 'err').redirect('/financeiro/pacotes');
  const out = await Fin.createPackage({ patientId: p.id, sessions, amount, dueDate: b.due_date, userId: req.user.id });
  await audit(req, 'financeiro-pacote', `patient:${p.id} package:${out.packageId}`);
  res.flash(`Pacote de ${sessions} sessões criado. Registre o pagamento quando receber.`).redirect(`/financeiro/${out.paymentId}`);
});

r.post('/pacotes/:id/encerrar', async (req, res, next) => {
  const k = await one('SELECT * FROM fin_packages WHERE id = ?', [int(req.params.id)]);
  if (!k) return next();
  if (!isAll(req) && k.professional_id !== req.user.id) return next(forbidden());
  await q("UPDATE fin_packages SET status = 'encerrado' WHERE id = ?", [k.id]);
  await audit(req, 'financeiro-pacote-encerrar', `package:${k.id}`);
  res.flash('Pacote encerrado.').redirect('/financeiro/pacotes');
});

// =====================================================================
// Acertos clínica ↔ profissional
// =====================================================================
r.get('/acertos', async (req, res) => {
  const all = isAll(req);
  const ym = isYm(req.query.mes) ? req.query.mes : addMonths(todayLocal().slice(0, 7), -1);
  const pros = all ? await professionals() : [{ id: req.user.id, name: req.user.name, title: req.user.title }];
  const list = [];
  for (const u of pros) list.push({ u, s: await Fin.settlement(u.id, ym) });
  const who = (n, name) => (n > 0 ? `Clínica paga a ${name.split(' ')[0]}` : n < 0 ? `${name.split(' ')[0]} paga à clínica` : 'Nada a acertar');
  send(res, page(req, {
    title: 'Financeiro · Acertos', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">${monthName(ym)}</p><h1>Acertos com profissionais</h1></div>
      <div class="ph-actions">${monthNav('/financeiro/acertos', ym)}</div></header>
    ${tabs(req, 'acertos', scopeOf(req))}
    <p class="muted small">Quem recebeu do paciente fica devendo a parte do outro, conforme a regra de repasse de cada profissional; o aluguel de sala entra como valor devido à clínica. Pagamentos recebidos no mês entram no acerto daquele mês.</p>
    <section class="card flush"><div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Profissional</th><th>Regra</th><th>Recebido na clínica</th><th>Recebido direto</th><th>Parte da clínica</th><th>Parte do profissional</th><th>Aluguel</th><th>Saldo</th><th>Situação</th></tr></thead>
      <tbody>${list.map(({ u, s }) => html`<tr data-href="/financeiro/acertos/${u.id}/${ym}"><td><b>${proName(u)}</b></td><td class="small">${Fin.ruleText(s.rule || { mode: 'none', value: 0, rent: 0 })}</td>
        <td>${money(s.tot?.received_clinic || 0)}</td><td>${money(s.tot?.received_prof || 0)}</td><td>${money(s.tot?.clinic_part || 0)}</td><td>${money(s.tot?.prof_part || 0)}</td><td>${money(s.tot?.rent || 0)}</td>
        <td><b class="${s.net < 0 ? 'neg' : s.net > 0 ? 'pos' : ''}">${money(Math.abs(s.net))}</b><small class="muted block">${who(s.net, u.name)}</small></td>
        <td>${s.closed ? html`<span class="badge b-realizada">Fechado</span>` : html`<span class="badge b-agendada">Aberto</span>`}</td></tr>`)}</tbody></table></div></section>`,
  }));
});

async function settlementView(req, res, next) {
  const pid = int(req.params.pid); const ym = req.params.ym;
  if (!pid || !isYm(ym)) return next();
  if (!isAll(req) && pid !== req.user.id) return next(forbidden());
  const u = await one('SELECT id, name, title, crp FROM users WHERE id = ?', [pid]);
  if (!u) return next();
  const s = await Fin.settlement(pid, ym);
  const entries = s.closed ? await q('SELECT * FROM fin_entries WHERE settlement_id = ? AND owner_id IS NULL', [s.closed.id]) : [];
  const paid = entries.some((e) => e.paid_at);
  const net = Number(s.net);
  const verdict = net > 0 ? `A clínica paga ${money(net)} a ${proName(u)}` : net < 0 ? `${proName(u)} paga ${money(-net)} à clínica` : 'Nada a acertar neste mês';
  const table = html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pago em</th><th>Paciente</th><th>Descrição</th><th>Valor</th><th>Recebido por</th><th>Clínica</th><th>Profissional</th></tr></thead>
    <tbody>${(s.lines || []).map((l) => html`<tr><td>${brDate(l.date)}</td><td>${l.patient}</td><td>${l.description}</td><td>${money(l.amount)}</td><td>${RECV[l.receiver]}</td><td>${money(l.clinic)}</td><td>${money(l.prof)}</td></tr>`)}
    ${s.tot?.rent ? html`<tr><td>—</td><td colspan="2">Aluguel de sala do mês</td><td>—</td><td>—</td><td>${money(s.tot.rent)}</td><td>− ${money(s.tot.rent)}</td></tr>` : ''}</tbody></table></div>`;
  if (req.query.imprimir) {
    return send(res, bare(`Acerto ${ym}`, html`<div class="print-bar"><button class="btn" data-print>Imprimir / salvar em PDF</button></div>
    <article class="letter"><header class="lh"><img src="/static/img/logo-terracota.png" alt="Lorrainy Mendes"><div><b>Extrato de acerto</b><span>${monthName(ym)}</span></div></header>
      <h1>${proName(u)}</h1><p class="muted">${Fin.ruleText(s.rule || {})}${s.closed ? ` · fechado em ${brDate(s.closed.closed_at)}` : ' · prévia (acerto ainda aberto)'}</p>
      ${table}<p class="settle-verdict">${verdict}</p></article>`, 'bare print', req));
  }
  send(res, page(req, {
    title: 'Acerto', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">Acerto · ${monthName(ym)}</p><h1>${proName(u)}</h1></div>
      <div class="ph-actions"><a class="btn ghost" href="/financeiro/acertos/${pid}/${ym}?imprimir=1" target="_blank">Extrato (PDF)</a><a class="btn ghost" href="/financeiro/acertos?mes=${ym}">Voltar</a></div></header>
    <section class="kpis">
      <div class="kpi"><span>Recebido na clínica</span><b>${money(s.tot?.received_clinic || 0)}</b></div>
      <div class="kpi"><span>Recebido direto pelo profissional</span><b>${money(s.tot?.received_prof || 0)}</b></div>
      <div class="kpi"><span>Parte da clínica</span><b>${money(s.tot?.clinic_part || 0)}</b><small>${s.tot?.rent ? `+ aluguel ${money(s.tot.rent)}` : Fin.ruleText(s.rule || {})}</small></div>
      <div class="kpi"><span>Parte do profissional</span><b>${money(s.tot?.prof_part || 0)}</b></div>
    </section>
    <section class="card settle ${net < 0 ? 'owes' : ''}"><h2>${verdict}</h2>
      ${s.closed ? html`<p>Acerto fechado em ${brDate(s.closed.closed_at)}. ${entries.length ? html`Conta gerada: <a class="link" href="/financeiro/contas/${entries[0].id}">${entries[0].description}</a> — ${paid ? 'paga ✓' : `vence em ${brDate(entries[0].due_date)}`}.` : ''}</p>
        ${isAll(req) && !paid ? html`<form method="post" action="/financeiro/acertos/${s.closed.id}/reabrir" data-confirm="Reabrir este acerto? A conta gerada será removida."><button class="btn ghost">Reabrir acerto</button></form>` : ''}`
      : html`<p class="muted">Prévia: recebimentos do mês ainda não acertados. Ao fechar, o sistema gera a conta ${net > 0 ? 'a pagar da clínica (e a receber nas finanças do profissional)' : net < 0 ? 'a receber da clínica (e a pagar nas finanças do profissional)' : ''} com vencimento em 5 dias.</p>
        ${isAll(req) ? html`<form method="post" action="/financeiro/acertos/${pid}/${ym}/fechar" data-confirm="Fechar o acerto de ${monthName(ym)} com ${u.name}?"><button class="btn">Fechar acerto</button></form>` : ''}`}
    </section>
    <section class="card flush"><h2 class="pad-h">Recebimentos considerados</h2>${(s.lines || []).length || s.tot?.rent ? table : html`<p class="muted pad">Nenhum recebimento neste mês.</p>`}</section>`,
  }));
}
r.get('/acertos/:pid/:ym', (req, res, next) => settlementView(req, res, next).catch(next));

r.post('/acertos/:pid/:ym/fechar', async (req, res, next) => {
  if (!isAll(req)) return next(forbidden());
  const pid = int(req.params.pid); const ym = req.params.ym;
  if (!pid || !isYm(ym)) return next();
  if (ym >= todayLocal().slice(0, 7)) return res.flash('Só é possível fechar o acerto de meses que já terminaram.', 'err').redirect(`/financeiro/acertos/${pid}/${ym}`);
  await Fin.closeSettlement(pid, ym, req.user.id);
  await audit(req, 'financeiro-acerto-fechar', `user:${pid} ${ym}`);
  res.flash('Acerto fechado e conta gerada.').redirect(`/financeiro/acertos/${pid}/${ym}`);
});

r.post('/acertos/:id/reabrir', async (req, res, next) => {
  if (!isAll(req)) return next(forbidden());
  const s = await one('SELECT * FROM fin_settlements WHERE id = ?', [int(req.params.id)]);
  if (!s) return next();
  const out = await Fin.reopenSettlement(s.id);
  if (!out.ok) return res.flash(out.error, 'err').redirect(`/financeiro/acertos/${s.professional_id}/${s.ym}`);
  await audit(req, 'financeiro-acerto-reabrir', `user:${s.professional_id} ${s.ym}`);
  res.flash('Acerto reaberto.').redirect(`/financeiro/acertos/${s.professional_id}/${s.ym}`);
});

// =====================================================================
// Relatórios: Receita Saúde / Carnê-Leão (recibos de pessoa física) e lista para nota fiscal (clínica)
// =====================================================================
const cpfFmt = (c) => { const d = String(c || '').replace(/\D/g, ''); return d.length === 11 ? `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}` : c || ''; };
r.get('/relatorios', async (req, res) => {
  const all = isAll(req);
  const ym = isYm(req.query.mes) ? req.query.mes : addMonths(todayLocal().slice(0, 7), -1);
  const issuer = ['profissional', 'clinica'].includes(req.query.emissor) ? req.query.emissor : 'profissional';
  const prof = all ? int(req.query.prof) : req.user.id;
  const rows = await Fin.report(ym, { profId: prof || null, issuer });
  if (req.query.formato === 'csv') {
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const head = ['Data do pagamento', 'Profissional', 'CRP', 'Beneficiário (paciente)', 'CPF do beneficiário', 'Pagador', 'CPF do pagador', 'Valor', 'Forma', 'Descrição', 'Emissor do recibo'];
    const lines = rows.map((x) => [x.date.split('-').reverse().join('/'), x.pro, x.crp, x.beneficiary, cpfFmt(x.beneficiary_cpf), x.payer, cpfFmt(x.payer_cpf), x.amount.toFixed(2).replace('.', ','), label(x.method || 'outro'), x.description, x.issuer === 'profissional' ? 'Profissional (PF)' : 'Clínica']);
    await audit(req, 'financeiro-relatorio-csv', `${ym} ${issuer}`);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="recebimentos-${issuer}-${ym}.csv"` });
    return res.send('\ufeff' + [head, ...lines].map((l) => l.map(esc).join(';')).join('\r\n'));
  }
  const byPro = {}; for (const x of rows) { const k = x.pro || '—'; (byPro[k] ||= { total: 0, n: 0, crp: x.crp }); byPro[k].total += x.amount; byPro[k].n += 1; }
  const missing = rows.filter((x) => !x.payer_cpf || !x.beneficiary_cpf);
  const pros = all ? await professionals() : [];
  const qs = (o) => new URLSearchParams({ mes: ym, emissor: issuer, ...(prof && all ? { prof } : {}), ...o }).toString();
  send(res, page(req, {
    title: 'Financeiro · Relatórios', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">${monthName(ym)}</p><h1>Relatórios</h1></div>
      <div class="ph-actions"><a class="btn ghost" href="?${qs({ mes: addMonths(ym, -1) })}">←</a><a class="btn ghost" href="?${qs({ mes: addMonths(ym, 1) })}">→</a><a class="btn" href="?${qs({ formato: 'csv' })}">⬇ Baixar planilha (CSV)</a></div></header>
    ${tabs(req, 'relatorios', scopeOf(req))}
    <div class="filters">
      <a class="chip ${issuer === 'profissional' ? 'on' : ''}" href="?${qs({ emissor: 'profissional' })}">Recibos de pessoa física (Receita Saúde / Carnê-Leão)</a>
      <a class="chip ${issuer === 'clinica' ? 'on' : ''}" href="?${qs({ emissor: 'clinica' })}">Recebimentos da clínica (nota fiscal)</a>
      <a class="chip rs-chip" href="/financeiro/receita-saude?mes=${ym}${prof && all ? `&prof=${prof}` : ''}">✨ Assistente do Receita Saúde</a>
      ${all ? html`<form method="get" class="inline"><input type="hidden" name="mes" value="${ym}"><input type="hidden" name="emissor" value="${issuer}"><select name="prof" data-autosubmit><option value="">Todos os profissionais</option>${pros.map((u) => html`<option value="${u.id}" ${prof === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select></form>` : ''}
    </div>
    <p class="muted small">${issuer === 'profissional'
      ? 'Recebimentos com recibo emitido pelo(a) profissional como pessoa física: cada um precisa ser lançado no app Receita Saúde (com CPF de quem pagou e de quem foi atendido) e o total do mês entra no Carnê-Leão. Confirme os procedimentos com a contadora.'
      : 'Recebimentos com recibo emitido pela clínica: lista para a emissão das notas fiscais de serviço.'}</p>
    ${missing.length ? html`<div class="flash warn">⚠ ${missing.length} recebimento(s) sem CPF do paciente ou do pagador. Complete na ficha do paciente (Dados → CPF / Responsável financeiro).</div>` : ''}
    <section class="kpis">${Object.entries(byPro).map(([k, v]) => html`<div class="kpi"><span>${k}${v.crp ? ` · CRP ${v.crp}` : ''}</span><b>${money(v.total)}</b><small>${v.n} recebimento(s)${issuer === 'profissional' ? ' · total para o Carnê-Leão' : ''}</small></div>`)}
      ${rows.length ? '' : html`<div class="kpi"><span>Total</span><b>${money(0)}</b><small>nenhum recebimento</small></div>`}</section>
    <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Pago em</th><th>Profissional</th><th>Beneficiário</th><th>CPF</th><th>Pagador</th><th>CPF do pagador</th><th>Valor</th><th>Forma</th></tr></thead>
      <tbody>${rows.map((x) => html`<tr><td>${brDate(x.date)}</td><td>${x.pro ? x.pro.split(' ')[0] : '—'}</td><td><a href="/financeiro/${x.id}">${x.beneficiary}</a></td><td class="${x.beneficiary_cpf ? '' : 'neg'}">${cpfFmt(x.beneficiary_cpf) || 'sem CPF'}</td><td>${x.payer}</td><td class="${x.payer_cpf ? '' : 'neg'}">${cpfFmt(x.payer_cpf) || 'sem CPF'}</td><td>${money(x.amount)}</td><td>${label(x.method || 'outro')}</td></tr>`)}</tbody></table></div>`
      : html`<p class="muted pad">Nenhum recebimento neste mês.</p>`}</section>`,
  }));
});

// =====================================================================
// Assistente do Receita Saúde: recibo por recibo, com os dados prontos para copiar
// =====================================================================
const brVal = (v) => Number(v).toFixed(2).replace('.', ',');
const copyBtn = (v, lbl = 'Copiar') => (v ? html`<button type="button" class="btn ghost btn-sm rs-copy" data-copy-text="${v}">${lbl}</button>` : '');
r.get('/receita-saude', async (req, res) => {
  const all = isAll(req);
  const ym = isYm(req.query.mes) ? req.query.mes : todayLocal().slice(0, 7);
  const prof = all ? (int(req.query.prof) || null) : req.user.id;
  const incClinic = req.query.todos === '1';
  // quem tem CNPJ próprio emite nota fiscal (Financeiro → Notas fiscais), não recibo do Receita Saúde
  const pjSet = new Set(await Fiscal.pjUsers());
  const all0 = (await Fin.report(ym, { profId: prof })).filter((x) => incClinic || x.issuer === 'profissional');
  const pjN = all0.filter((x) => x.issuer === 'profissional' && pjSet.has(x.professional_id)).length;
  const rows = all0.filter((x) => !(x.issuer === 'profissional' && pjSet.has(x.professional_id)));
  const clinicN = incClinic ? 0 : (await Fin.report(ym, { profId: prof, issuer: 'clinica' })).length;
  // emitente: o(a) próprio(a) profissional (a conta gov.br é dele(a)); os de outros profissionais ficam só para acompanhar
  const me = isClin(req.user) ? await Fiscal.profile(req.user.id) : null;
  const meMiss = me ? Fiscal.missing(me) : [];
  const othersPending = {}; for (const x of rows) if (x.issuer === 'profissional' && x.professional_id !== req.user.id) { const fp = othersPending[x.professional_id] ||= { name: x.pro, n: 0, miss: Fiscal.missing(await Fiscal.profile(x.professional_id)) }; if (!x.rs_issued_at) fp.n++; }
  const pending = rows.filter((x) => !x.rs_issued_at); const done = rows.filter((x) => x.rs_issued_at);
  const total = rows.reduce((a, x) => a + x.amount, 0); const doneTot = done.reduce((a, x) => a + x.amount, 0);
  const byPro = {}; for (const x of rows) { const k = x.pro || '—'; (byPro[k] ||= { total: 0, n: 0, crp: x.crp }); byPro[k].total += x.amount; byPro[k].n += 1; }
  const pros = all ? await professionals() : [];
  const qs = (o = {}) => `?${new URLSearchParams({ mes: ym, ...(prof && all ? { prof } : {}), ...(incClinic ? { todos: '1' } : {}), ...o }).toString()}`;
  const card = (x, i) => {
    const miss = !x.beneficiary_cpf || !x.payer_cpf;
    const other = x.issuer === 'profissional' && x.professional_id !== req.user.id; // só o(a) próprio(a) profissional lança
    const same = x.payer_cpf && x.payer_cpf === x.beneficiary_cpf;
    const desc = `Sessão de psicoterapia${x.description && /\d{2}\/\d{2}/.test(x.description) ? ` (${x.description.match(/\d{2}\/\d{2}(\/\d{4})?/)[0]})` : ''}`;
    return html`<article class="rs-card ${x.rs_issued_at ? 'done' : ''} ${i === 0 && !x.rs_issued_at ? 'next' : ''}" id="r-${x.id}">
      <header><b>${brDate(x.date)}</b> · ${x.beneficiary}${x.pro ? html` <small class="muted">· ${x.pro.split(' ')[0]}</small>` : ''}<span class="rs-st">${x.rs_issued_at ? html`✓ lançado em ${brDate(x.rs_issued_at)}` : 'a lançar'}</span></header>
      ${miss ? html`<p class="flash warn small">Falta o CPF ${!x.payer_cpf && !x.beneficiary_cpf ? 'do paciente' : !x.payer_cpf ? 'de quem pagou' : 'do paciente'}. <a href="/pacientes/${x.patient_id}/editar">Completar na ficha</a></p>` : ''}
      <dl class="rs-fields">
        <div><dt>CPF de quem pagou${x.payer !== x.beneficiary ? html` <small>(${x.payer})</small>` : ''}</dt><dd><span class="mono">${cpfFmt(x.payer_cpf) || '—'}</span>${copyBtn(String(x.payer_cpf || '').replace(/\D/g, ''))}</dd></div>
        <div><dt>CPF de quem foi atendido(a)${same ? html` <small>(o mesmo)</small>` : ''}</dt><dd><span class="mono">${cpfFmt(x.beneficiary_cpf) || '—'}</span>${copyBtn(String(x.beneficiary_cpf || '').replace(/\D/g, ''))}</dd></div>
        <div><dt>Valor</dt><dd><span class="mono">R$ ${brVal(x.amount)}</span>${copyBtn(brVal(x.amount))}</dd></div>
        <div><dt>Data do pagamento</dt><dd><span class="mono">${brDate(x.date)}</span>${copyBtn(brDate(x.date))}</dd></div>
        <div class="wide"><dt>Descrição do serviço</dt><dd><span>${desc}</span>${copyBtn(desc)}</dd></div>
      </dl>
      <footer>${other ? html`<span class="muted small">${x.rs_issued_at ? 'Lançado' : 'A lançar'} por ${x.pro ? x.pro.split(' ')[0] : 'o(a) profissional'}, no Receita Saúde dele(a)${x.receiver === 'profissional' ? ' (o paciente pagou direto)' : ''}.</span>`
        : x.rs_issued_at ? html`<form method="post" action="/financeiro/receita-saude/${x.id}/desfazer${qs()}" class="inline"><button class="btn ghost btn-sm">Desfazer</button></form>`
        : html`<form method="post" action="/financeiro/receita-saude/${x.id}/lancado${qs()}" class="inline"><button class="btn" ${miss ? raw('title="Complete o CPF antes de lançar"') : ''}>✓ Lancei no Receita Saúde</button></form>`}
        <a class="link small" href="/financeiro/${x.id}">ver recebimento</a></footer>
    </article>`;
  };
  send(res, page(req, {
    title: 'Financeiro · Receita Saúde', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">${monthName(ym)}</p><h1>Assistente do Receita Saúde</h1>
      <p class="muted">Recibo por recibo, com os dados prontos para copiar no app. Marque cada um ao lançar — o sistema avisa o que ainda falta.</p></div>
      <div class="ph-actions">${monthNav('/financeiro/receita-saude', ym, `${prof && all ? `prof=${prof}&` : ''}${incClinic ? 'todos=1&' : ''}`)}</div></header>
    ${tabs(req, 'relatorios', scopeOf(req))}
    <div class="filters">
      ${all ? html`<form method="get" class="inline"><input type="hidden" name="mes" value="${ym}">${incClinic ? html`<input type="hidden" name="todos" value="1">` : ''}<select name="prof" data-autosubmit><option value="">Todos os profissionais</option>${pros.map((u) => html`<option value="${u.id}" ${prof === u.id ? raw('selected') : ''}>${u.name}</option>`)}</select></form>` : ''}
      <a class="chip ${incClinic ? 'on' : ''}" href="${qs({ todos: incClinic ? '0' : '1' })}">${incClinic ? '✓ ' : ''}Incluir recebimentos marcados como “recibo da clínica”</a>
      <a class="chip" href="/financeiro/relatorios?mes=${ym}&emissor=profissional">Relatório do mês (planilha)</a>
    </div>
    ${me ? html`<section class="card rs-me"><h2>Emitente: você</h2>
      ${meMiss.length ? html`<div class="flash warn">Para emitir os recibos dos pacientes que pagam direto para você, complete <a href="/conta/fiscal">Meus dados fiscais</a> (falta: ${meMiss.join(', ')}).</div>` : ''}
      ${me.kind === 'pj' ? html`<p class="small">Você emite <b>nota fiscal com o seu CNPJ</b>: os recebimentos direto para você estão em <a href="/financeiro/notas${isAll(req) ? '?de=eu' : ''}">Notas fiscais</a>.</p>`
        : html`<dl class="rs-fields"><div><dt>Nome</dt><dd><span>${me.fullName || '—'}</span></dd></div><div><dt>Seu CPF (entre no gov.br com ele)</dt><dd><span class="mono">${Fiscal.cpfFmt(me.cpf) || '—'}</span></dd></div><div><dt>CRP</dt><dd><span class="mono">${me.crp || '—'}</span>${copyBtn(me.crp)}</dd></div></dl>
          <p class="muted small">Os recibos são emitidos no app da Receita Federal com a <b>sua</b> conta gov.br. <a href="/conta/fiscal">Editar meus dados fiscais</a></p>`}
    </section>` : ''}
    ${Object.values(othersPending).filter((o) => o.n || o.miss.length).map((o) => html`<div class="flash info small">${o.name}: ${o.n} recibo(s) a lançar por ele(a) no Receita Saúde${o.miss.length ? html` · <b>dados fiscais incompletos</b> (falta: ${o.miss.join(', ')})` : ''}.</div>`)}
    ${pjN ? html`<div class="flash info small">${pjN} recebimento(s) de profissional com CNPJ próprio não aparecem aqui: são emitidos como nota fiscal, em <a href="/financeiro/notas${isAll(req) ? '?de=eu' : ''}">Notas fiscais</a>.</div>` : ''}
    ${clinicN ? html`<div class="flash info">${clinicN} recebimento(s) deste mês estão com “recibo emitido pela clínica”. Se a clínica não tem CNPJ, os recibos são da profissional (pessoa física): marque “Incluir recebimentos…” acima ou ajuste em Financeiro → Configurar → Recibo emitido por.</div>` : ''}
    <section class="kpis rs-kpis">
      <div class="kpi"><span>Lançados</span><b>${done.length} de ${rows.length}</b><small>${rows.length ? `${Math.round((done.length / rows.length) * 100)}% do mês` : 'nenhum recebimento'}</small></div>
      <div class="kpi"><span>Falta lançar</span><b>${pending.length}</b><small>${money(total - doneTot)}</small></div>
      ${Object.entries(byPro).map(([k, v]) => html`<div class="kpi"><span>${k}${v.crp ? ` · CRP ${v.crp}` : ''}</span><b>${money(v.total)}</b><small>total do mês para o Carnê-Leão</small></div>`)}
    </section>
    ${rows.length ? html`<div class="rs-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${rows.length}" aria-valuenow="${done.length}"><i style="width:${rows.length ? (done.length / rows.length) * 100 : 0}%"></i></div>` : ''}
    <details class="card tv-tips" ${done.length ? '' : raw('open')}><summary>Como lançar (passo a passo)</summary><ol>
      <li>No celular, abra o <b>app da Receita Federal</b> (entre com a conta gov.br da profissional) e escolha <b>Receita Saúde → Emitir recibo</b>.</li>
      <li>Copie daqui e cole no app: <b>CPF de quem pagou</b>, <b>CPF de quem foi atendido</b>, <b>valor</b>, <b>data do pagamento</b> e a <b>descrição</b>.</li>
      <li>Confirme no app e volte aqui: toque em <b>“✓ Lancei no Receita Saúde”</b>. O próximo recibo já aparece em destaque.</li>
      <li>No fim do mês, confira no <b>Carnê-Leão</b> o total mostrado acima. O DARF do Carnê-Leão vence no último dia útil do mês seguinte. Confirme os procedimentos com a contadora.</li>
    </ol></details>
    ${pending.length ? html`<h2 class="rs-h">A lançar (${pending.length})</h2><div class="rs-list">${pending.map((x, i) => card(x, i))}</div>` : rows.length ? html`<div class="flash ok">🎉 Todos os recibos de ${monthName(ym)} foram lançados no Receita Saúde.</div>` : html`<p class="muted">Nenhum recebimento de pessoa física pago em ${monthName(ym)}.</p>`}
    ${done.length ? html`<details class="rs-done"><summary>Já lançados (${done.length})</summary><div class="rs-list">${done.map((x, i) => card(x, i))}</div></details>` : ''}`,
  }));
});
r.post('/receita-saude/:id/:acao', async (req, res, next) => {
  const x = await one('SELECT x.id, x.professional_id FROM payments x WHERE x.id = ? AND x.paid_at IS NOT NULL', [int(req.params.id)]);
  if (!x || !['lancado', 'desfazer'].includes(req.params.acao)) return next();
  if (!isAll(req) && x.professional_id !== req.user.id) throw forbidden();
  // recibo do(a) profissional: só ele(a) marca (é emitido na conta gov.br dele(a))
  const iss = await one(`SELECT ${Fin.ISSUER_SQL} v FROM payments x LEFT JOIN fin_rules r ON r.user_id = x.professional_id WHERE x.id = ?`, [x.id]);
  if (iss?.v === 'profissional' && x.professional_id !== req.user.id) throw forbidden();
  if (req.params.acao === 'lancado') await q('UPDATE payments SET rs_issued_at = NOW(), rs_issued_by = ? WHERE id = ? AND rs_issued_at IS NULL', [req.user.id, x.id]);
  else await q('UPDATE payments SET rs_issued_at = NULL, rs_issued_by = NULL WHERE id = ?', [x.id]);
  await audit(req, `receita-saude-${req.params.acao}`, `payment:${x.id}`);
  const qs = new URLSearchParams(Object.fromEntries(Object.entries(req.query).filter(([k]) => ['mes', 'prof', 'todos'].includes(k)))).toString();
  res.redirect(`/financeiro/receita-saude${qs ? `?${qs}` : ''}`);
});

// =====================================================================
// Configurar: regras de repasse, dados para recibo, categorias
// =====================================================================
r.get('/config', async (req, res, next) => {
  if (!isAll(req)) return next(forbidden());
  const pros = await professionals();
  const rules = {}; const fiscal = {}; for (const u of pros) { rules[u.id] = await Fin.rule(u.id); fiscal[u.id] = await Fiscal.profile(u.id); }
  const c = await Fin.clinic();
  const cats = await q('SELECT * FROM fin_categories ORDER BY kind, name');
  const pol = await Fin.policy();
  send(res, page(req, {
    title: 'Financeiro · Configurar', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">Financeiro</p><h1>Configurar</h1></div></header>
    ${tabs(req, 'config', scopeOf(req))}
    <section class="card"><h2>Repasse por profissional</h2><p class="muted small sub-h">Quanto fica com a clínica em cada recebimento de paciente do(a) profissional, aluguel de sala mensal e quem emite o recibo. Mudanças valem para os próximos recebimentos.</p>
      <div class="rules">${pros.map((u) => { const rl = rules[u.id]; return html`<form method="post" action="/financeiro/config/regra/${u.id}" class="rule-card">
        <h3>${proName(u)}</h3>
        <label class="fld"><span>A clínica fica com</span><select name="mode"><option value="none" ${rl.mode === 'none' ? raw('selected') : ''}>Nada por sessão</option><option value="percent" ${rl.mode === 'percent' ? raw('selected') : ''}>Porcentagem (%)</option><option value="fixed" ${rl.mode === 'fixed' ? raw('selected') : ''}>Valor fixo por sessão (R$)</option></select></label>
        <label class="fld"><span>Porcentagem ou valor</span><input name="value" inputmode="decimal" value="${rl.value ? String(rl.value).replace('.', ',') : ''}" placeholder="Ex.: 30 ou 50,00"></label>
        <label class="fld"><span>Aluguel de sala por mês (R$)</span><input name="rent" inputmode="decimal" value="${rl.rent ? String(rl.rent).replace('.', ',') : ''}" placeholder="0,00"></label>
        <label class="fld"><span>Recibo emitido por</span><select name="receipt_by"><option value="clinica" ${rl.receipt_by === 'clinica' ? raw('selected') : ''}>Clínica</option><option value="profissional" ${rl.receipt_by === 'profissional' ? raw('selected') : ''}>Profissional</option></select></label>
        <div class="fld"><span>Dados fiscais (preenchidos pelo(a) profissional)</span>${fiscalLine(fiscal[u.id])}</div>
        <label class="fld"><span>Chave Pix do profissional</span><span class="inline"><select name="pix_type"><option value="">—</option>${Object.entries(KEY_TYPES).map(([k, l]) => html`<option value="${k}" ${rl.pix_type === k ? raw('selected') : ''}>${l}</option>`)}</select><input name="pix_key" value="${rl.pix_key}" maxlength="140" placeholder="para quem paga direto"></span></label>
        <button class="btn ghost">Salvar regra</button></form>`; })}</div></section>
    <section class="card"><h2>Política de faltas</h2><p class="muted small sub-h">Aplicada quando a sessão é marcada como “Falta” na agenda. Se a marcação for desfeita, a cobrança é removida (enquanto não for paga). Atual: ${Fin.policyText(pol)}.</p>
      <form method="post" action="/financeiro/config/politica" class="form-grid">
        <label class="fld check span2"><input type="checkbox" name="noShow" value="1" ${pol.noShow ? raw('checked') : ''}><span>Cobrar faltas sem aviso prévio</span></label>
        <label class="fld"><span>Valor da falta</span><select name="noShowMode"><option value="integral" ${pol.noShowMode === 'integral' ? raw('selected') : ''}>Sessão inteira</option><option value="percent" ${pol.noShowMode === 'percent' ? raw('selected') : ''}>Porcentagem da sessão</option><option value="fixed" ${pol.noShowMode === 'fixed' ? raw('selected') : ''}>Valor fixo</option></select></label>
        <label class="fld"><span>Porcentagem ou valor</span><input name="noShowValue" inputmode="decimal" value="${String(pol.noShowValue).replace('.', ',')}"></label>
        <label class="fld check span2"><input type="checkbox" name="noShowPackage" value="1" ${pol.noShowPackage ? raw('checked') : ''}><span>Se o paciente tem pacote, a falta consome 1 sessão do pacote (em vez de gerar cobrança)</span></label>
        <div class="span2 actions"><button class="btn">Salvar política</button></div>
      </form></section>
    <section class="card"><h2>Dados da clínica para recibos</h2>
      <form method="post" action="/financeiro/config/clinica" class="form-grid">
        <label class="fld span2"><span>Nome / razão social</span><input name="name" value="${c.name}" maxlength="160" required></label>
        <label class="fld"><span>CNPJ ou CPF</span><input name="doc" value="${c.doc}" maxlength="20"></label>
        <label class="fld"><span>Cidade</span><input name="city" value="${c.city}" maxlength="80"></label>
        <label class="fld span2"><span>Endereço</span><input name="address" value="${c.address}" maxlength="200"></label>
        <label class="fld"><span>Telefone</span><input name="phone" value="${c.phone}" maxlength="40"></label>
        <label class="fld"><span>E-mail</span><input name="email" value="${c.email}" maxlength="120"></label>
        <label class="fld span2"><span>Chave Pix da clínica (para o Pix copia e cola das cobranças)</span><span class="inline"><select name="pix_type"><option value="">—</option>${Object.entries(KEY_TYPES).map(([k, l]) => html`<option value="${k}" ${c.pix_type === k ? raw('selected') : ''}>${l}</option>`)}</select><input name="pix_key" value="${c.pix_key}" maxlength="140"></span></label>
        <div class="span2 actions"><button class="btn">Salvar dados</button></div>
      </form></section>
    <section class="card"><h2>Categorias</h2>
      <div class="cat-list">${cats.map((ct) => html`<form method="post" action="/financeiro/config/categoria/${ct.id}" class="chip ${ct.active ? '' : 'off'}">${ct.kind === 'receita' ? '↑ ' : ''}${ct.name} <button title="${ct.active ? 'Desativar' : 'Reativar'}">${ct.active ? '×' : '↺'}</button></form>`)}</div>
      <form method="post" action="/financeiro/config/categoria" class="inline cat-new"><input name="name" maxlength="80" placeholder="Nova categoria" required><select name="kind"><option value="despesa">Despesa</option><option value="receita">Receita</option></select><button class="btn ghost">Adicionar</button></form>
    </section>`,
  }));
});

r.post('/config/regra/:uid', async (req, res, next) => {
  if (!isAll(req)) return next(forbidden());
  const u = await one("SELECT id FROM users WHERE id = ? AND role IN ('admin','psicologo')", [int(req.params.uid)]);
  if (!u) return next();
  const b = req.body;
  const mode = ['percent', 'fixed', 'none'].includes(b.mode) ? b.mode : 'none';
  const value = dec(b.value) || 0;
  if (mode === 'percent' && (value <= 0 || value > 100)) return res.flash('Porcentagem deve ficar entre 0 e 100.', 'err').redirect('/financeiro/config');
  if (mode === 'fixed' && value <= 0) return res.flash('Informe o valor fixo por sessão.', 'err').redirect('/financeiro/config');
  const pixType = KEY_TYPES[b.pix_type] ? b.pix_type : null;
  if (pixType && !normalizeKey(pixType, b.pix_key)) return res.flash(`Chave Pix inválida para o tipo “${KEY_TYPES[pixType]}”.`, 'err').redirect('/financeiro/config');
  await Fin.saveRule(u.id, { mode, value: mode === 'none' ? 0 : value, rent: dec(b.rent) || 0, receipt_by: b.receipt_by === 'profissional' ? 'profissional' : 'clinica', doc: (await Fin.rule(u.id)).doc, pix_type: pixType, pix_key: pixType ? str(b.pix_key, 140) : '' });
  await audit(req, 'financeiro-regra', `user:${u.id}`);
  res.flash('Regra de repasse salva.').redirect('/financeiro/config');
});
r.post('/config/clinica', async (req, res, next) => {
  if (!isAll(req)) return next(forbidden());
  const b = req.body;
  const pixType = KEY_TYPES[b.pix_type] ? b.pix_type : null;
  if (pixType && !normalizeKey(pixType, b.pix_key)) return res.flash(`Chave Pix inválida para o tipo “${KEY_TYPES[pixType]}”.`, 'err').redirect('/financeiro/config');
  await Fin.saveClinic({ name: str(b.name, 160), doc: str(b.doc, 20), address: str(b.address, 200), city: str(b.city, 80) || 'Goiânia', phone: str(b.phone, 40), email: str(b.email, 120), pix_type: pixType, pix_key: pixType ? str(b.pix_key, 140) : '' });
  await audit(req, 'financeiro-clinica');
  res.flash('Dados da clínica salvos.').redirect('/financeiro/config');
});
r.post('/config/politica', async (req, res, next) => {
  if (!isAll(req)) return next(forbidden());
  const b = req.body;
  const mode = ['integral', 'percent', 'fixed'].includes(b.noShowMode) ? b.noShowMode : 'integral';
  const value = dec(b.noShowValue) || 0;
  if (b.noShow && mode === 'percent' && (value <= 0 || value > 100)) return res.flash('Porcentagem da falta deve ficar entre 0 e 100.', 'err').redirect('/financeiro/config');
  if (b.noShow && mode === 'fixed' && value <= 0) return res.flash('Informe o valor fixo da falta.', 'err').redirect('/financeiro/config');
  await Fin.savePolicy({ noShow: !!b.noShow, noShowMode: mode, noShowValue: value || 100, noShowPackage: !!b.noShowPackage });
  await audit(req, 'financeiro-politica-faltas', b.noShow ? mode : 'desligada');
  res.flash('Política de faltas salva.').redirect('/financeiro/config');
});

r.post('/config/categoria', async (req, res, next) => {
  if (!isAll(req)) return next(forbidden());
  const name = str(req.body.name, 80);
  if (name) await q('INSERT IGNORE INTO fin_categories (name, kind) VALUES (?,?)', [name, req.body.kind === 'receita' ? 'receita' : 'despesa']);
  res.flash('Categoria adicionada.').redirect('/financeiro/config');
});
r.post('/config/categoria/:id', async (req, res, next) => {
  if (!isAll(req)) return next(forbidden());
  await q('UPDATE fin_categories SET active = 1 - active WHERE id = ?', [int(req.params.id)]);
  res.redirect('/financeiro/config');
});

// =====================================================================
// Conciliação bancária (extrato OFX/CSV)
// =====================================================================
const impAllowed = (req, im) => (im.owner_id === null ? isAll(req) : im.owner_id === req.user.id);
const scopeFromOwner = (ownerId) => ({ owner: ownerId || null });
const deQs = (ownerId, req) => (ownerId && isAll(req) ? '?de=eu' : '');
const TRN = { CREDIT: 'Crédito', DEBIT: 'Débito', XFER: 'Transferência', PAYMENT: 'Pagamento', CHECK: 'Cheque', DEP: 'Depósito', ATM: 'Saque', FEE: 'Tarifa', SRVCHG: 'Tarifa', INT: 'Juros', DIV: 'Rendimento', POS: 'Cartão', DIRECTDEBIT: 'Débito automático', DIRECTDEP: 'Depósito', CASH: 'Dinheiro', OTHER: 'Outro' };
const sign = (v) => html`<b class="${Number(v) < 0 ? 'neg' : 'pos'}">${Number(v) < 0 ? '− ' : '+ '}${money(Math.abs(Number(v)))}</b>`;

r.get('/extrato', async (req, res) => {
  const sc = scopeOf(req);
  if (sc.owner && !isClin(req.user) && !isAll(req)) return res.status(403).send('Sem permissão');
  const ownerSql = sc.owner ? 'i.owner_id = ?' : 'i.owner_id IS NULL'; const ownerArg = sc.owner ? [sc.owner] : [];
  const imps = await q(`SELECT i.*, u.name who,
      (SELECT COUNT(*) FROM fin_bank_tx t WHERE t.import_id = i.id AND t.status = 'pendente') pend,
      (SELECT COUNT(*) FROM fin_bank_tx t WHERE t.import_id = i.id AND t.status = 'conciliado') done
    FROM fin_imports i LEFT JOIN users u ON u.id = i.created_by WHERE ${ownerSql} ORDER BY i.id DESC LIMIT 40`, ownerArg);
  const pend = imps.reduce((s, i) => s + Number(i.pend), 0);
  send(res, page(req, {
    title: 'Conciliação bancária', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">${sc.label}</p><h1>Conciliação bancária</h1></div></header>
    ${tabs(req, 'extrato', sc)}
    <section class="card recon-up">
      <h2>Importar extrato</h2>
      <p class="muted small sub-h">Baixe o extrato no internet banking em <b>OFX</b> (Money/Quicken) — ou CSV com as colunas Data, Descrição e Valor — e envie aqui. O sistema encontra os Pix e transferências de pacientes e as contas pagas, e você só confere. Movimentações já importadas antes não se repetem.</p>
      <label class="btn file-btn"><input type="file" accept=".ofx,.csv,.txt,application/x-ofx,text/csv,text/plain" data-upload="/financeiro/extrato/importar${sc.key === 'eu' ? '?de=eu' : ''}" hidden>⬆ Enviar extrato (OFX ou CSV)</label>
      <span class="muted small" data-upload-msg></span>
      <p class="muted small">Dica: no código Pix gerado pelo sistema vai o identificador do lançamento (ex.: PAG123). Quando o banco mostra esse identificador no extrato, a conciliação é automática e certeira.</p>
    </section>
    <section class="card"><h2>Extratos importados${pend ? html` <span class="badge b-agendada">${pend} para conferir</span>` : ''}</h2>
      ${imps.length ? html`<ul class="list">${imps.map((i) => html`<li><a href="/financeiro/extrato/${i.id}"><span>${i.file_name}<small>${i.bank ? `${i.bank} · ` : ''}${i.account ? `conta ${i.account} · ` : ''}${i.period_start ? `${brDate(i.period_start)} a ${brDate(i.period_end)} · ` : ''}enviado ${brDate(i.created_at)}${i.who ? ` por ${i.who}` : ''}</small></span>
        <span class="muted small">${i.total} movimentações</span>${Number(i.pend) ? html`<span class="badge b-agendada">${i.pend} pendentes</span>` : html`<span class="badge b-realizada">Conciliado</span>`}</a></li>`)}</ul>`
      : html`<p class="muted">Nenhum extrato importado ainda.</p>`}
    </section>`,
  }));
});

r.post('/extrato/importar', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  const owner = req.query.de === 'eu' || !isAll(req) ? req.user.id : null;
  if (owner && !isClin(req.user)) return res.status(403).json({ ok: false, error: 'Sem permissão.' });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return res.status(400).json({ ok: false, error: 'Arquivo vazio.' });
  let name = 'extrato'; try { name = decodeURIComponent(String(req.get('x-filename') || 'extrato')); } catch { /* nome padrão */ }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 160) || 'extrato';
  const out = await Bank.importStatement({ ownerId: owner, fileName: name, data: buf, userId: req.user.id });
  if (!out.ok) return res.status(400).json(out);
  await audit(req, 'financeiro-extrato', `import:${out.importId} ${out.added}tx`);
  res.flash(`${out.added} movimentações importadas${out.skipped ? ` (${out.skipped} já estavam no sistema)` : ''}. Confira as sugestões abaixo.`);
  res.json({ ok: true, redirect: `/financeiro/extrato/${out.importId}` });
});

async function loadImport(req) {
  const im = await one('SELECT * FROM fin_imports WHERE id = ?', [int(req.params.iid)]);
  if (!im) return { im: null };
  return { im, ok: impAllowed(req, im) };
}

r.get('/extrato/:iid', async (req, res, next) => {
  const { im, ok } = await loadImport(req);
  if (!im) return next();
  if (!ok) return next(forbidden());
  const sc = scopeFromOwner(im.owner_id);
  const txs = await q("SELECT * FROM fin_bank_tx WHERE import_id = ? ORDER BY status = 'pendente' DESC, posted, id", [im.id]);
  const pend = txs.filter((t) => t.status === 'pendente');
  const sug = await Bank.suggestions(sc, pend);
  const cats = await q('SELECT * FROM fin_categories WHERE active = 1 ORDER BY name');
  const catOpts = (kind) => cats.filter((c) => c.kind === kind).map((c) => html`<option value="${c.id}">${c.name}</option>`);
  // descrição do que está vinculado
  const desc = {};
  for (const t of txs.filter((x) => x.status === 'conciliado')) {
    if (t.match_type === 'payment') { const x = await one('SELECT x.id, x.description, p.name, p.social_name FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ?', [t.match_id]); desc[t.id] = x ? { url: `/financeiro/${x.id}`, text: `${x.social_name || x.name} — ${x.description}` } : null; }
    else if (t.match_type === 'tiss') { const b = await one('SELECT b.id, b.lot_number, i.name FROM tiss_batches b JOIN insurers i ON i.id = b.insurer_id WHERE b.id = ?', [t.match_id]); desc[t.id] = b ? { url: `/financeiro/convenios/lote/${b.id}`, text: `Convênio ${b.name} — lote nº ${b.lot_number}` } : null; }
    else { const e = await one('SELECT id, description FROM fin_entries WHERE id = ?', [t.match_id]); desc[t.id] = e ? { url: `/financeiro/contas/${e.id}`, text: `${t.match_type === 'created' ? 'Nova conta: ' : ''}${e.description}` } : null; }
  }
  const inSum = txs.filter((t) => t.amount > 0).reduce((s, t) => s + Number(t.amount), 0);
  const outSum = txs.filter((t) => t.amount < 0).reduce((s, t) => s + Number(t.amount), 0);
  const optLabel = (c) => (c.type === 'tiss' ? `${c.label} · ${money(c.amount)}` : `${c.type === 'payment' ? 'Paciente: ' : 'Conta: '}${c.label} · ${money(c.amount)} · ${c.already ? `já marcado como pago em ${brDate(c.paid)} (só vincular)` : `vence ${brDate(c.due)}`}`);
  const back = `/financeiro/extrato${deQs(im.owner_id, req)}`;
  send(res, page(req, {
    title: 'Conferir extrato', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">Conciliação · ${im.owner_id ? 'Minhas finanças' : 'Clínica'}</p><h1>${im.file_name}</h1></div>
      <div class="ph-actions"><a class="btn ghost" href="${back}">Voltar</a></div></header>
    <section class="kpis">
      <div class="kpi"><span>Entradas</span><b>${money(inSum)}</b></div>
      <div class="kpi"><span>Saídas</span><b>${money(Math.abs(outSum))}</b></div>
      <div class="kpi"><span>Para conferir</span><b>${pend.length}</b><small>${txs.length - pend.length} já resolvidas</small></div>
      <div class="kpi"><span>Saldo no extrato</span><b>${im.balance !== null ? money(im.balance) : '—'}</b>${im.period_start ? html`<small>${brDate(im.period_start)} a ${brDate(im.period_end)}</small>` : ''}</div>
    </section>
    ${pend.length ? html`<form method="post" action="/financeiro/extrato/${im.id}/conciliar" class="card recon">
      <h2>Conferir movimentações</h2>
      <p class="muted small sub-h">As sugestões marcadas foram encontradas pelo valor, pela data e pelo nome no extrato. Desmarque o que não estiver certo ou escolha outra opção. Ao confirmar, o recebimento/conta fica pago na data do extrato.</p>
      <div class="recon-head"><label class="check"><input type="checkbox" data-check-all="recon"> Marcar todas</label></div>
      <ul class="recon-list">${pend.map((t) => {
        const s = sug[t.id]; const pick = s.pick;
        const others = s.list.filter((c) => !pick || c.type !== pick.type || c.id !== pick.id);
        const def = pick ? `${pick.type}:${pick.id}` : '';
        return html`<li class="recon-row">
          <label class="recon-ok"><input type="checkbox" name="ok_${t.id}" value="1" data-recon-item="recon" ${pick && s.sure ? raw('checked') : ''} aria-label="Confirmar"></label>
          <div class="recon-tx"><b class="time">${brDate(t.posted).slice(0, 5)}</b><span>${t.memo || '(sem descrição)'}<small>${TRN[t.trn_type] || (t.amount < 0 ? 'Débito' : 'Crédito')}</small></span>${sign(t.amount)}</div>
          <div class="recon-act">
            ${pick ? html`<span class="recon-hint ${s.sure ? 'sure' : 'maybe'}">${pick.exact ? '✓ identificador do Pix' : s.sure ? '✓ sugestão' : '? confira'}</span>` : html`<span class="recon-hint none">sem correspondência</span>`}
            <select name="a_${t.id}" data-recon-sel>
              ${pick ? html`<option value="${def}" selected>${optLabel(pick)}</option>` : ''}
              ${others.map((c) => html`<option value="${c.type}:${c.id}">${optLabel(c)}</option>`)}
              <option value="create" ${!pick ? raw('selected') : ''}>${t.amount < 0 ? 'Lançar como nova despesa paga' : 'Lançar como outra receita recebida'}</option>
              <option value="ignore">Ignorar (não entra no financeiro)</option>
            </select>
            <div class="recon-create" ${pick ? raw('hidden') : ''}>
              <input name="d_${t.id}" value="${t.memo || ''}" maxlength="255" aria-label="Descrição">
              <select name="c_${t.id}" aria-label="Categoria"><option value="">Sem categoria</option>${catOpts(t.amount < 0 ? 'despesa' : 'receita')}</select>
            </div>
          </div></li>`;
      })}</ul>
      <div class="actions"><button class="btn">Confirmar marcadas</button></div>
    </form>` : html`<div class="flash ok">Tudo conferido neste extrato. 🎉</div>`}
    ${txs.length > pend.length ? html`<section class="card"><h2>Já resolvidas</h2><ul class="list">${txs.filter((t) => t.status !== 'pendente').map((t) => html`<li><div class="recon-done"><b class="time">${brDate(t.posted).slice(0, 5)}</b><span>${t.memo || '(sem descrição)'}<small>${t.status === 'ignorado' ? 'Ignorada' : desc[t.id] ? html`→ <a class="link" href="${desc[t.id].url}">${desc[t.id].text}</a>` : '→ lançamento excluído'}</small></span>${sign(t.amount)}
        <form method="post" action="/financeiro/extrato/tx/${t.id}/desfazer" data-confirm="Desfazer? ${t.set_paid ? 'O lançamento volta a ficar em aberto.' : ''}"><button class="chip">Desfazer</button></form></div></li>`)}</ul></section>` : ''}
    ${txs.some((t) => t.status === 'conciliado') ? '' : html`<form method="post" action="/financeiro/extrato/${im.id}/excluir" class="danger-zone" data-confirm="Excluir este extrato importado?"><button class="btn danger">Excluir extrato</button></form>`}`,
  }));
});

r.post('/extrato/:iid/conciliar', async (req, res, next) => {
  const { im, ok } = await loadImport(req);
  if (!im) return next();
  if (!ok) return next(forbidden());
  const sc = scopeFromOwner(im.owner_id);
  const txs = await q("SELECT * FROM fin_bank_tx WHERE import_id = ? AND status = 'pendente'", [im.id]);
  const b = req.body;
  let done = 0; const errs = [];
  for (const t of txs) {
    if (!b[`ok_${t.id}`]) continue;
    const a = String(b[`a_${t.id}`] || '');
    let action = null;
    const m = a.match(/^(payment|entry|tiss):(\d+)$/);
    if (m) action = { type: m[1], id: int(m[2]) };
    else if (a === 'create') action = { type: 'create', category_id: int(b[`c_${t.id}`]), description: str(b[`d_${t.id}`]) };
    else if (a === 'ignore') action = { type: 'ignore' };
    if (!action) continue;
    const out = await Bank.apply(sc, t, action, req.user.id);
    if (out.ok) done++; else errs.push(`${brDate(t.posted).slice(0, 5)} ${money(Math.abs(t.amount))}: ${out.error}`);
  }
  await audit(req, 'financeiro-conciliar', `import:${im.id} ${done}tx`);
  if (errs.length) return res.flash(`${done} conciliadas. Não foi possível: ${errs.slice(0, 3).join('; ')}`, 'warn').redirect(`/financeiro/extrato/${im.id}`);
  res.flash(done ? `${done} movimentações conciliadas.` : 'Nada marcado para confirmar.', done ? 'ok' : 'warn').redirect(`/financeiro/extrato/${im.id}`);
});

r.post('/extrato/tx/:tid/desfazer', async (req, res, next) => {
  const t = await one('SELECT t.*, i.owner_id FROM fin_bank_tx t JOIN fin_imports i ON i.id = t.import_id WHERE t.id = ?', [int(req.params.tid)]);
  if (!t) return next();
  if (!impAllowed(req, t)) return next(forbidden());
  const out = await Bank.undo(t);
  await audit(req, 'financeiro-conciliar-desfazer', `tx:${t.id}`);
  res.flash(out.ok ? 'Conciliação desfeita.' : out.error, out.ok ? 'ok' : 'err').redirect(`/financeiro/extrato/${t.import_id}`);
});

r.post('/extrato/:iid/excluir', async (req, res, next) => {
  const { im, ok } = await loadImport(req);
  if (!im) return next();
  if (!ok) return next(forbidden());
  if (await one("SELECT id FROM fin_bank_tx WHERE import_id = ? AND status = 'conciliado' LIMIT 1", [im.id])) return res.flash('Desfaça as conciliações antes de excluir o extrato.', 'err').redirect(`/financeiro/extrato/${im.id}`);
  await q('DELETE FROM fin_bank_tx WHERE import_id = ?', [im.id]);
  await q('DELETE FROM fin_imports WHERE id = ?', [im.id]);
  await audit(req, 'financeiro-extrato-excluir', `import:${im.id}`);
  res.flash('Extrato excluído.').redirect(`/financeiro/extrato${deQs(im.owner_id, req)}`);
});

// =====================================================================
// Movimentações (histórico de todos os lançamentos de pacientes: criados, recebidos, cancelados…)
// =====================================================================
r.get('/movimentacoes', async (req, res) => {
  const all = isAll(req);
  const tipo = Object.keys(Fin.PAY_ACTIONS).includes(req.query.tipo) ? req.query.tipo : '';
  const ym = isYm(req.query.mes) ? req.query.mes : todayLocal().slice(0, 7);
  const where = ["DATE_FORMAT(e.created_at,'%Y-%m') = ?"]; const params = [ym];
  if (tipo) { where.push('e.action = ?'); params.push(tipo); }
  if (!all) { where.push('e.professional_id = ?'); params.push(req.user.id); }
  const rows = await q(`SELECT e.*, u.name who, p.name pname, p.social_name FROM payment_events e LEFT JOIN users u ON u.id = e.user_id LEFT JOIN patients p ON p.id = e.patient_id WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT 500`, params);
  const sc = scopeOf(req);
  send(res, page(req, {
    title: 'Movimentações', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">Financeiro · ${monthName(ym)}</p><h1>Movimentações</h1><p class="muted">Tudo o que aconteceu com os lançamentos de pacientes: quem fez e quando.</p></div>
      <div class="ph-actions">${monthNav('/financeiro/movimentacoes', ym, tipo ? `tipo=${tipo}&` : '')}</div></header>
    ${tabs(req, 'receber', sc)}
    <nav class="seg fin-scope" aria-label="Tipo">${[['', 'Todas'], ['recebido', 'Recebidos'], ['confirmado', 'Confirmados'], ['direto', 'Direto ao profissional'], ['lembrete', 'Lembretes'], ['cancelado', 'Cancelados']].map(([k, l]) => html`<a href="/financeiro/movimentacoes?mes=${ym}${k ? `&tipo=${k}` : ''}" class="${tipo === k ? 'on' : ''}">${l}</a>`)}</nav>
    <section class="card">${rows.length ? html`<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Quando</th><th>Paciente</th><th>Movimentação</th><th>Valor</th><th>Por</th></tr></thead><tbody>
      ${rows.map((e) => html`<tr><td>${brDate(e.created_at)} ${String(e.created_at).slice(11, 16)}</td><td>${e.pname ? (e.social_name || e.pname) : '—'}</td>
        <td>${e.payment_id && e.action !== 'cancelado' ? html`<a class="link" href="/financeiro/${e.payment_id}">${Fin.PAY_ACTIONS[e.action] || e.action}</a>` : (Fin.PAY_ACTIONS[e.action] || e.action)}${e.detail ? html`<small class="muted block">${e.detail}</small>` : ''}</td>
        <td>${e.amount !== null ? money(e.amount) : ''}</td><td>${e.who || 'sistema'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted">Nenhuma movimentação neste mês.</p>`}</section>`,
  }));
});

// =====================================================================
// Anexos
// =====================================================================
async function fileParent(req, kind, id) {
  if (kind === 'entry') { const e = await one('SELECT * FROM fin_entries WHERE id = ?', [id]); return e && entryAllowed(req, e) ? { url: `/financeiro/contas/${e.id}` } : null; }
  const x = await one('SELECT id, professional_id FROM payments WHERE id = ?', [id]);
  return x && payVisible(req, x) ? { url: `/financeiro/${x.id}` } : null;
}
r.post('/arquivos', express.raw({ type: () => true, limit: '5mb' }), async (req, res) => {
  const kind = req.query.tipo === 'entry' ? 'entry' : 'payment';
  const parent = await fileParent(req, kind, int(req.query.id));
  if (!parent) return res.status(403).json({ ok: false, error: 'Sem permissão.' });
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  const mime = String(req.get('content-type') || '').split(';')[0];
  const sig = FILE_TYPES[mime];
  const okSig = buf && sig && sig.every((b, i) => buf[i] === b) && (mime !== 'image/webp' || buf.slice(8, 12).toString() === 'WEBP');
  if (!buf || !buf.length) return res.status(400).json({ ok: false, error: 'Arquivo vazio.' });
  if (!okSig) return res.status(400).json({ ok: false, error: 'Envie um PDF, JPG, PNG ou WebP.' });
  let name = 'arquivo'; try { name = decodeURIComponent(String(req.get('x-filename') || 'arquivo')); } catch { /* nome padrão */ }
  name = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 160) || 'arquivo';
  await q(`INSERT INTO fin_files (${kind === 'entry' ? 'entry_id' : 'payment_id'}, name, mime, size, data, uploaded_by) VALUES (?,?,?,?,?,?)`, [int(req.query.id), name, mime, buf.length, buf, req.user.id]);
  await audit(req, 'financeiro-anexo', `${kind}:${int(req.query.id)} ${name.slice(0, 40)}`);
  res.json({ ok: true });
});
r.get('/arquivos/:fid', async (req, res, next) => {
  const f = await one('SELECT * FROM fin_files WHERE id = ?', [int(req.params.fid)]);
  if (!f) return next();
  if (!(await fileParent(req, f.entry_id ? 'entry' : 'payment', f.entry_id || f.payment_id))) return next(forbidden());
  res.set({ 'Content-Type': f.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store' });
  res.send(f.data);
});
r.post('/arquivos/:fid/excluir', async (req, res, next) => {
  const f = await one('SELECT id, entry_id, payment_id, name FROM fin_files WHERE id = ?', [int(req.params.fid)]);
  if (!f) return next();
  const parent = await fileParent(req, f.entry_id ? 'entry' : 'payment', f.entry_id || f.payment_id);
  if (!parent) return next(forbidden());
  await q('DELETE FROM fin_files WHERE id = ?', [f.id]);
  await audit(req, 'financeiro-anexo-excluir', `file:${f.id}`);
  res.flash('Anexo excluído.').redirect(parent.url);
});

// =====================================================================
// Recebimento de paciente (lançamento)
// =====================================================================
r.get('/:id', async (req, res, next) => {
  const x = await one('SELECT x.*, p.name, p.social_name, p.phone, p.whatsapp_optin, u.name pro, u.title pro_title FROM payments x JOIN patients p ON p.id = x.patient_id LEFT JOIN users u ON u.id = x.professional_id WHERE x.id = ?', [int(req.params.id)]);
  if (!x) return next();
  if (!payVisible(req, x)) return next(forbidden());
  const waOn = WA.ready(await WA.config());
  const rl = await Fin.rule(x.professional_id);
  const share = x.clinic_share !== null ? Number(x.clinic_share) : Fin.clinicShare(x.amount, x.sessions, rl);
  const pk = x.package_id ? await one('SELECT * FROM fin_packages WHERE id = ?', [x.package_id]) : null;
  const locked = !!x.settlement_id;
  const conv = x.origin === 'convenio' ? await one('SELECT name FROM insurers WHERE id = ?', [x.insurer_id]) : null; // a receber da operadora
  const pix = !x.paid_at && !conv ? await Fin.pixFor(x) : null;
  const qr = pix ? await QRCode.toDataURL(pix.code, { margin: 1, width: 220, color: { dark: '#47291c', light: '#ffffff' } }) : '';
  const files = await attachments('payment', x.id);
  const hist = await Fin.paymentHistory(x.id);
  const state = Fin.payState(x);
  send(res, page(req, {
    title: 'Lançamento', active: 'financeiro',
    body: html`<header class="ph"><div><p class="eyebrow">Recebimento · ${nm(x)}${x.pro ? ` · ${proName({ name: x.pro, title: x.pro_title })}` : ''}</p><h1>${money(x.amount)}</h1></div>
      <div class="ph-actions">${x.paid_at && !conv ? html`<a class="btn" href="/financeiro/${x.id}/recibo" target="_blank">Emitir recibo</a>` : ''}
        ${x.paid_at && !conv && waOn && x.whatsapp_optin ? html`<form method="post" action="/financeiro/${x.id}/whatsapp"><button class="btn ghost">Enviar confirmação pelo WhatsApp</button></form>` : ''}
        ${!x.paid_at && !conv && waOn && x.whatsapp_optin && x.phone ? html`<form method="post" action="/financeiro/${x.id}/cobrar" data-confirm="Enviar a cobrança de ${money(x.amount)} para ${nm(x)} pelo WhatsApp?"><button class="btn">💬 Cobrar pelo WhatsApp</button></form>` : ''}</div></header>
    ${conv ? html`<div class="flash info">A receber do convênio <b>${conv.name}</b> (pagamento da operadora, previsto para ${brDate(x.due_date)}). Não é cobrado do paciente. Quando a operadora pagar, registre o recebimento abaixo.</div>` : ''}
    ${x.origin === 'falta' ? html`<div class="flash warn">Cobrança de falta gerada pela política do consultório. Se a falta for desmarcada na agenda, esta cobrança é removida automaticamente (enquanto não for paga).</div>` : ''}
    ${x.charged_at ? html`<p class="muted small">Cobrança enviada pelo WhatsApp em ${brDate(x.charged_at)} às ${String(x.charged_at).slice(11, 16)}.</p>` : ''}
    ${pix ? html`<section class="card pix-card"><img src="${raw(qr)}" alt="QR code Pix" width="180" height="180">
      <div><h2>Pix para ${x.receiver === 'clinica' ? 'a clínica' : 'o(a) profissional'}</h2><p class="muted small">Recebedor: ${pix.name} · chave ${pix.keyType}. Valor de ${money(x.amount)} já incluído.</p>
        <div class="copy"><input readonly value="${pix.code}" id="pix${x.id}"><button class="btn ghost" type="button" data-copy="#pix${x.id}">Copiar</button></div>
        <p class="muted small">O paciente escaneia o QR code ou cola o código no app do banco (“Pix copia e cola”). Confira o recebimento no seu banco e registre abaixo.</p></div></section>`
    : !x.paid_at && !conv ? html`<p class="muted small">Para gerar o Pix copia e cola, cadastre a chave Pix ${x.receiver === 'clinica' ? 'da clínica' : 'do(a) profissional'} em Financeiro → Configurar.</p>` : ''}
    ${conv ? '' : await gatewayCard(x)}
    ${await nfseCard(x, req)}
    ${pk ? html`<div class="flash">Pacote de ${pk.sessions_total} sessões · ${pk.sessions_used} usada(s) · ${pk.status === 'ativo' ? 'ativo' : 'encerrado'}.</div>` : ''}
    ${locked ? html`<div class="flash warn">Este recebimento já entrou num <a class="link" href="/financeiro/acertos">acerto fechado</a>. Para mudar valor, quem recebeu ou o pagamento, reabra o acerto.</div>` : ''}
    <form method="post" class="card form-grid">
      <label class="fld span2"><span>Descrição</span><input name="description" value="${x.description}" required maxlength="255"></label>
      <label class="fld"><span>Valor (R$)</span><input name="amount" inputmode="decimal" value="${String(x.amount).replace('.', ',')}" required ${locked ? raw('readonly') : ''}></label>
      <label class="fld"><span>Vencimento</span><input type="date" name="due_date" value="${dt(x.due_date)}" required></label>
      <label class="fld"><span>Quem recebeu</span><select name="receiver" ${locked ? raw('disabled') : ''}><option value="clinica" ${x.receiver === 'clinica' ? raw('selected') : ''}>A clínica</option><option value="profissional" ${x.receiver === 'profissional' ? raw('selected') : ''}>O(a) profissional, direto</option></select></label>
      <label class="fld"><span>Recibo / nota emitido por</span><select name="issuer"><option value="clinica" ${Fin.issuerOf(x, rl) === 'clinica' ? raw('selected') : ''}>Clínica</option><option value="profissional" ${Fin.issuerOf(x, rl) === 'profissional' ? raw('selected') : ''}>Profissional</option></select>
        <small class="muted">Se o paciente pagou direto ao(à) profissional, o documento é sempre dele(a) (Receita Saúde ou nota com o CNPJ dele(a)).</small></label>
      <label class="fld"><span>Pago em</span><input type="date" name="paid_at" value="${dt(x.paid_at) || todayLocal()}" ${locked ? raw('readonly') : ''}></label>
      <label class="fld"><span>Forma de pagamento</span><select name="method">${METHODS.map((m) => html`<option value="${m}" ${m === (x.method || 'pix') ? raw('selected') : ''}>${label(m)}</option>`)}</select></label>
      <label class="fld check span2"><input type="checkbox" name="paid" value="1" checked ${locked ? raw('disabled') : ''}><span>Pagamento recebido</span></label>
      ${waOn && !x.paid_at ? html`<label class="fld check span2"><input type="checkbox" name="wa" value="1" ${x.whatsapp_optin && x.phone ? raw('checked') : raw('disabled')}><span>Enviar confirmação de pagamento pelo WhatsApp${!x.whatsapp_optin ? ' (paciente não autorizou)' : !x.phone ? ' (sem telefone)' : ''}</span></label>` : ''}
      <p class="span2 muted small">Repasse: ${Fin.ruleText(rl)} → clínica ${money(share)} · profissional ${money(Number(x.amount) - share)}${x.clinic_share !== null ? ' (gravado no recebimento)' : ''}.</p>
      <div class="span2 actions"><button class="btn">Salvar</button><a class="btn ghost" href="/financeiro/receber">Voltar</a></div>
    </form>
    ${files}
    <section class="card pay-hist"><h2>Histórico <span class="badge ${state === 'pago' ? 'b-realizada' : state === 'aguardando' ? 'b-confirmada' : 'b-agendada'}">${Fin.PAY_STATE_LABEL[state]}</span></h2>
      ${hist.length ? html`<ul class="pay-ev">${hist.map((e) => html`<li><b>${brDate(e.created_at)} ${String(e.created_at).slice(11, 16)}</b> · ${Fin.PAY_ACTIONS[e.action] || e.action}${e.detail ? html` <small>(${e.detail})</small>` : ''} <small class="muted">— ${e.who || 'sistema'}</small></li>`)}</ul>` : html`<p class="muted small">Sem movimentações registradas (lançamento anterior ao histórico).</p>`}
    </section>
    ${locked || pk ? '' : html`<form method="post" action="/financeiro/${x.id}/excluir" class="danger-zone" data-confirm="Excluir este lançamento?"><button class="btn danger">Excluir lançamento</button></form>`}`,
  }));
});

r.post('/:id', async (req, res, next) => {
  const x = await one('SELECT * FROM payments WHERE id = ?', [int(req.params.id)]);
  if (!x) return next();
  if (!payVisible(req, x)) return next(forbidden());
  const b = req.body;
  const recv = x.settlement_id ? x.receiver : b.receiver === 'profissional' ? 'profissional' : 'clinica';
  const issuer = recv === 'profissional' || b.issuer === 'profissional' ? 'profissional' : 'clinica'; // pagou direto ao profissional: o documento é dele(a)
  if (x.settlement_id) {
    await q('UPDATE payments SET description = ?, due_date = ?, issuer = ?, method = COALESCE(?, method) WHERE id = ?', [str(b.description) || x.description, isYmd(b.due_date) ? b.due_date : x.due_date, issuer, METHODS.includes(b.method) ? b.method : null, x.id]);
    return res.flash('Lançamento atualizado (valores travados pelo acerto).').redirect(`/financeiro/${x.id}`);
  }
  const amount = dec(b.amount);
  if (!amount || !isYmd(b.due_date)) return res.flash('Valor ou vencimento inválido.', 'err').redirect(`/financeiro/${x.id}`);
  const paid = b.paid && isYmd(b.paid_at);
  await q('UPDATE payments SET description = ?, amount = ?, due_date = ?, paid_at = ?, method = ?, receiver = ?, issuer = ? WHERE id = ?',
    [str(b.description) || 'Sessão de psicoterapia', amount, b.due_date, paid ? b.paid_at : null, paid && METHODS.includes(b.method) ? b.method : null, b.receiver === 'profissional' ? 'profissional' : 'clinica', issuer, x.id]);
  if (paid && !x.paid_at) { await q('UPDATE payments SET received_by = ?, received_at = NOW() WHERE id = ?', [req.user.id, x.id]); await Fin.logPay(x.id, x.receiver === 'profissional' && b.receiver === 'profissional' && x.professional_id === req.user.id ? 'confirmado' : 'recebido', req.user.id, `Forma: ${b.method}`); }
  else if (!paid && x.paid_at) { await q('UPDATE payments SET received_by = NULL, received_at = NULL WHERE id = ?', [x.id]); await Fin.logPay(x.id, 'reaberto', req.user.id); }
  else if (Number(x.amount) !== amount || x.description !== (str(b.description) || 'Sessão de psicoterapia')) await Fin.logPay(x.id, 'editado', req.user.id, Number(x.amount) !== amount ? `Valor ${x.amount} → ${amount}` : 'Descrição');
  if (paid && (!x.paid_at || Number(x.amount) !== amount)) await Fin.stampShare(x.id); // parte da clínica fixada no recebimento
  if (!paid) await Fin.stampShare(x.id);
  await audit(req, 'financeiro-editar', `payment:${x.id}`);
  if (paid && !x.paid_at && b.wa) {
    const w = await WA.sendPayment(x.id, req.user.id);
    return res.flash(w.ok ? 'Pagamento registrado e confirmação enviada pelo WhatsApp.' : `Pagamento registrado. WhatsApp não enviado: ${w.error}`, w.ok ? 'ok' : 'warn').redirect(`/financeiro/${x.id}`);
  }
  res.flash(paid ? 'Pagamento registrado.' : 'Lançamento atualizado.').redirect(`/financeiro/${x.id}`);
});

r.post('/:id/cobrar', async (req, res, next) => {
  const x = await one('SELECT id, professional_id FROM payments WHERE id = ?', [int(req.params.id)]);
  if (!x) return next();
  if (!payVisible(req, x)) return next(forbidden());
  const w = await WA.sendCharge(x.id, req.user.id);
  await audit(req, 'whatsapp-cobranca', `payment:${x.id}`);
  res.flash(w.ok ? 'Cobrança enviada pelo WhatsApp.' : `Não enviada: ${w.error}`, w.ok ? 'ok' : 'err').redirect(`/financeiro/${x.id}`);
});

r.post('/:id/whatsapp', async (req, res, next) => {
  const x = await one('SELECT id, professional_id FROM payments WHERE id = ?', [int(req.params.id)]);
  if (!x) return next();
  if (!payVisible(req, x)) return next(forbidden());
  const w = await WA.sendPayment(x.id, req.user.id);
  await audit(req, 'whatsapp-pagamento', `payment:${x.id}`);
  res.flash(w.ok ? 'Confirmação enviada pelo WhatsApp.' : `Não enviado: ${w.error}`, w.ok ? 'ok' : 'err').redirect(`/financeiro/${x.id}`);
});

r.post('/:id/excluir', async (req, res, next) => {
  const x = await one('SELECT id, professional_id, settlement_id, package_id FROM payments WHERE id = ?', [int(req.params.id)]);
  if (!x) return next();
  if (!payVisible(req, x) || x.settlement_id || x.package_id) return next(forbidden());
  await Fin.logPay(x.id, 'cancelado', req.user.id, 'Lançamento excluído');
  await q('DELETE FROM payments WHERE id = ?', [x.id]);
  await Bank.unlink('payment', x.id);
  await audit(req, 'financeiro-excluir', `payment:${x.id}`);
  res.flash('Lançamento excluído.').redirect('/financeiro/receber');
});

// ---------- recibo em papel timbrado (emitido pela clínica ou pelo profissional) ----------
r.get('/:id/recibo', async (req, res, next) => {
  const x = await one('SELECT x.*, p.name, p.cpf_enc FROM payments x JOIN patients p ON p.id = x.patient_id WHERE x.id = ?', [int(req.params.id)]);
  if (!x || !x.paid_at || x.origin === 'convenio') return next(); // convênio: não há recibo ao paciente
  if (!payVisible(req, x)) return next(forbidden());
  await audit(req, 'recibo-emitir', `payment:${x.id}`);
  send(res, await receiptPage(x, req));
});
// Recibo (também usado pelo portal do paciente). x = pagamento com name e cpf_enc do paciente.
export async function receiptPage(x, req) {
  const cpf = decrypt(x.cpf_enc);
  const rl = await Fin.rule(x.professional_id);
  const issuer = Fin.issuerOf(x, rl);
  const pro = x.professional_id ? await one('SELECT name, title, crp FROM users WHERE id = ?', [x.professional_id]) : null;
  const c = await Fin.clinic();
  const byPro = issuer === 'profissional' && pro;
  const fp = byPro ? await Fiscal.profile(x.professional_id) : null;
  const proDoc = !fp ? '' : fp.kind === 'pj' && fp.cnpj ? `CNPJ ${cnpjFmt(fp.cnpj)}${fp.razao ? ` · ${fp.razao}` : ''}` : fp.cpf ? `CPF ${Fiscal.cpfFmt(fp.cpf)}` : rl.doc ? `CPF/CNPJ ${docFmt(rl.doc)}` : '';
  const signer = byPro
    ? { name: fp.saved && fp.fullName && fp.fullName !== pro.name ? fp.fullName : proName(pro), line: `Psicólogo(a)${pro.crp ? ` · CRP ${pro.crp}` : ''}`, doc: proDoc || 'CPF: _______________________' }
    : { name: c.name, line: pro ? `Atendimento: ${proName(pro)}${pro.crp ? ` · CRP ${pro.crp}` : ''}` : '', doc: c.doc ? `CNPJ/CPF ${docFmt(c.doc)}` : (process.env.PRO_CPF ? `CPF ${process.env.PRO_CPF}` : 'CNPJ/CPF: _______________________') };
  return bare('Recibo', html`
  <div class="print-bar"><button class="btn" data-print>Imprimir / salvar em PDF</button></div>
  <article class="letter receipt">
    <header class="lh"><img src="/static/img/logo-terracota.png" alt="Lorrainy Mendes"><div><b>${signer.name}</b><span>${signer.line}</span></div></header>
    <h1>Recibo <span class="amount">${money(x.amount)}</span></h1>
    <p class="receipt-text">Recebi de <b>${x.name}</b>${cpf ? html`, CPF ${Fiscal.cpfFmt(cpf)},` : ''} a importância de <b>${money(x.amount)}</b> (${extenso(x.amount)}), referente a <b>${x.description}</b>, paga em ${brDate(x.paid_at)} via ${label(x.method || 'outro').toLowerCase()}.</p>
    <p class="receipt-text">Para clareza, firmo o presente.</p>
    <footer class="lf"><p>${(byPro && fp?.saved && fp.city) || c.city || 'Goiânia'}, ${longDate(dt(x.paid_at))}.</p>
      <div class="sign">${signer.name}<br>${signer.line}${signer.line ? html`<br>` : ''}<small>${signer.doc}</small></div>
      <p class="lf-contact">${[(byPro && fp?.saved && fp.address) || c.address, c.phone, c.email, 'lorrainymendes.com.br'].filter(Boolean).join(' · ')}</p></footer>
  </article>`, 'bare print', req);
}

export default r;
