// Locação de espaços: painel do dia (grade por espaço), reservas, planos mensais, locatários e espaços.
import { q, one, audit } from '../lib/db.js';
import { page, html, raw, brDate, brDateTime, money } from '../lib/html.js';
import { router, send, int, str } from '../lib/router.js';
import { proName } from '../lib/perm.js';
import { todayLocal, addDays } from '../lib/time.js';
import * as L from '../lib/rental.js';
import * as WA from '../lib/whatsapp.js';
import * as Fin from '../lib/fin.js';

const r = router();
const BASE = '/locacao';
const hm = (t) => String(t || '').slice(0, 5);
const mins = (t) => { const [h, m] = hm(t).split(':').map(Number); return h * 60 + m; };
const sel = (a, b) => (String(a) === String(b) ? raw('selected') : '');
const chk = (v) => (v ? raw('checked') : '');
const WD = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const wdOf = (ymd) => WD[new Date(`${ymd}T12:00:00Z`).getUTCDay()];
const when = (b) => (b.starts_at.slice(0, 10) === b.ends_at.slice(0, 10) ? `${brDate(b.starts_at)} · ${b.starts_at.slice(11, 16)}–${b.ends_at.slice(11, 16)}` : `${brDate(b.starts_at)} a ${brDate(b.ends_at)}`);
// Lista de locatário: locatários cadastrados + profissionais da clínica (sem duplicar cadastro)
const tenantSelect = (o, selected) => html`<select name="tenant_id" data-rt-tenant>
  <option value="">+ Novo locatário (de fora da clínica)</option>
  ${o.tenants.length ? html`<optgroup label="Locatários cadastrados">${o.tenants.map((t) => html`<option value="${t.id}" ${sel(t.id, selected)}>${t.name}${t.user_id ? ' · profissional da clínica' : t.profession ? ` · ${t.profession}` : ''}</option>`)}</optgroup>` : ''}
  ${o.pros.length ? html`<optgroup label="Profissionais da clínica">${o.pros.map((u) => html`<option value="u:${u.id}" ${sel(`u:${u.id}`, selected)}>${u.display}${u.crp ? ` · CRP ${u.crp}` : ''}</option>`)}</optgroup>` : ''}
</select>`;
const badgeOf = (s) => html`<span class="badge rt-st-${s}">${L.STATUS[s] || s}</span>`;

function shell(req, title, tab, body, actions = '') {
  const tabs = [['painel', 'Painel', ''], ['reservas', 'Reservas', '/reservas'], ['planos', 'Planos mensais', '/planos'], ['locatarios', 'Locatários', '/locatarios'], ['espacos', 'Espaços', '/espacos']];
  return page(req, { title, active: 'locacao', body: html`<header class="ph"><div><p class="eyebrow">Locação de espaços</p><h1>${title}</h1></div><div class="ph-actions">${actions}<a class="btn" href="${BASE}/nova">+ Nova reserva</a></div></header>
    <nav class="tabs">${tabs.map(([k, l, h]) => html`<a href="${BASE}${h}" class="${tab === k ? 'on' : ''}">${l}</a>`)}</nav>
    ${body}` });
}
r.use(async (req, res, next) => {
  req.rc = await L.config();
  if (!req.rc.enabled) return res.flash('Ligue o módulo de locação em Configurações → Locação de espaços.', 'err').redirect('/configuracoes/locacao');
  next();
});

// ---------- painel do dia ----------
r.get('/', async (req, res) => {
  const day = L.isoDay(req.query.data);
  const [sps, bks, st] = await Promise.all([L.spaces(), L.dayBookings(day), L.stats(day)]);
  if (!sps.length) return send(res, shell(req, 'Painel', 'painel', html`<section class="card"><h2>Comece cadastrando os espaços</h2><p class="muted">Consultórios, salas e auditórios, com preço por hora, período e diária.</p><a class="btn" href="${BASE}/espacos/novo">+ Cadastrar espaço</a></section>`));
  const open = Math.min(...sps.map((s) => mins(s.open_time))); const close = Math.max(...sps.map((s) => mins(s.close_time)));
  const h0 = Math.floor(open / 60); const h1 = Math.ceil(close / 60); const rows = (h1 - h0) * 2;
  const row = (t) => Math.max(0, Math.min(rows, Math.round((mins(t) - h0 * 60) / 30)));
  const wd = new Date(`${day}T12:00:00Z`).getUTCDay();
  const cells = []; const blocks = [];
  sps.forEach((s, i) => {
    const works = s.weekdays.split(',').map(Number).includes(wd);
    for (let h = h0; h < h1; h++) {
      const t = `${String(h).padStart(2, '0')}:00`;
      const inside = works && mins(t) >= mins(s.open_time) && mins(t) < mins(s.close_time);
      cells.push(html`<a class="rt-cell ${inside ? '' : 'off'}" style="grid-column:${i + 2};grid-row:${(h - h0) * 2 + 2} / span 2" ${inside ? raw(`href="${BASE}/nova?espaco=${s.id}&amp;data=${day}&amp;hora=${t}" title="Reservar ${s.name} às ${t}"`) : raw('aria-hidden="true" tabindex="-1"')}></a>`);
    }
    for (const b of bks.filter((x) => x.space_id === s.id)) {
      const a = b.starts_at.slice(0, 10) < day ? 0 : row(b.starts_at.slice(11, 16));
      const z = b.ends_at.slice(0, 10) > day ? rows : row(b.ends_at.slice(11, 16));
      if (z <= a) continue;
      blocks.push(html`<a class="rt-bk rt-u-${b.unit} rt-st-${b.status}" style="grid-column:${i + 2};grid-row:${a + 2} / ${z + 2}" href="${BASE}/reservas/${b.id}"><b>${b.tenant_name || '—'}</b><small>${b.starts_at.slice(0, 10) < day ? '…' : b.starts_at.slice(11, 16)}–${b.ends_at.slice(0, 10) > day ? '…' : b.ends_at.slice(11, 16)} · ${L.UNITS[b.unit]}</small></a>`);
    }
  });
  send(res, shell(req, 'Painel', 'painel', html`
    <section class="kpis rt-kpis">
      <div class="kpi"><span>Ocupação do dia</span><b>${st.occupancy}%</b><small>${st.spaces} espaço(s)</small></div>
      <div class="kpi"><span>Receita prevista no mês</span><b>${money(st.revenue)}</b><small>${st.avulsa.n} avulsa(s) + ${st.plans.n} plano(s)</small></div>
      <div class="kpi"><span>A receber</span><b>${money(st.open.t)}</b><small>${st.open.n} lançamento(s) em aberto</small></div>
      <div class="kpi"><span>Planos ativos</span><b>${st.plans.n}</b><small>${money(st.plans.t)}/mês em mensalidades</small></div>
    </section>
    <section class="card flush">
      <header class="rt-dayh"><a class="chip" href="?data=${addDays(day, -1)}" aria-label="Dia anterior">←</a><b>${wdOf(day)}, ${brDate(day)}</b><a class="chip" href="?data=${addDays(day, 1)}" aria-label="Próximo dia">→</a>${day !== todayLocal() ? html`<a class="chip" href="${BASE}">Hoje</a>` : ''}
        <form method="get" class="inline"><input type="date" name="data" value="${day}" aria-label="Ir para a data" data-autosubmit></form></header>
      <div class="rt-scroll"><div class="rt-grid" style="grid-template-columns:56px repeat(${sps.length}, minmax(150px, 1fr));grid-template-rows:38px repeat(${rows}, 24px)">
        <div class="rt-corner"></div>
        ${sps.map((s, i) => html`<div class="rt-head" style="grid-column:${i + 2}"><b>${s.name}</b><small>${L.KINDS[s.kind]}${s.capacity ? ` · ${s.capacity} pess.` : ''}</small></div>`)}
        ${Array.from({ length: h1 - h0 }, (_, k) => html`<div class="rt-time" style="grid-row:${k * 2 + 2} / span 2">${String(h0 + k).padStart(2, '0')}:00</div>`)}
        ${cells}${blocks}
      </div></div>
      <p class="muted small pad">Toque num horário livre para reservar. Cores: <span class="rt-leg rt-u-hora">hora</span> <span class="rt-leg rt-u-periodo">período</span> <span class="rt-leg rt-u-diaria">diária</span> <span class="rt-leg rt-u-plano">plano mensal</span></p>
    </section>`));
});

// ---------- nova reserva avulsa ----------
async function bookForm(req, b = {}, error = '') {
  const [sps, to] = await Promise.all([L.spaces(), L.tenantOptions()]);
  const c = req.rc;
  const prices = Object.fromEntries(sps.map((s) => [s.id, { h: Number(s.price_hour), p: Number(s.price_period), d: Number(s.price_day), min: Number(s.min_hours), open: hm(s.open_time), close: hm(s.close_time) }]));
  const unit = b.unit || (b.hora ? 'hora' : 'hora');
  const start = b.start || b.hora || '';
  const end = b.end || (start ? `${String(Math.min(23, Number(start.slice(0, 2)) + 1)).padStart(2, '0')}:${start.slice(3, 5)}` : '');
  return shell(req, 'Nova reserva', 'reservas', html`
    ${error ? html`<div class="flash err">${error}</div>` : ''}
    <form method="post" action="${BASE}/nova" class="card form-grid rt-form" data-rental data-prices="${JSON.stringify(prices)}" data-periods="${c.periods.length}">
      <label class="fld"><span>Espaço *</span><select name="space_id" required>${sps.map((s) => html`<option value="${s.id}" ${sel(s.id, b.space_id || b.espaco)}>${s.name} · ${L.KINDS[s.kind]}</option>`)}</select></label>
      <label class="fld"><span>Locatário *</span>${tenantSelect(to, b.tenant_id)}</label>
      <fieldset class="span2 rt-newt" data-rt-newt><legend>Novo locatário</legend><p class="muted small">Profissional da clínica? Escolha na lista acima. Se o nome, WhatsApp ou CPF/CNPJ já estiver cadastrado, o sistema usa o cadastro existente.</p><div class="form-grid">
        <label class="fld"><span>Nome completo</span><input name="t_name" maxlength="160" value="${b.t_name || ''}"></label>
        <label class="fld"><span>WhatsApp</span><input name="t_phone" type="tel" maxlength="40" value="${b.t_phone || ''}" placeholder="(62) 90000-0000"></label>
        <label class="fld"><span>Profissão</span><input name="t_profession" maxlength="80" value="${b.t_profession || ''}" placeholder="Psicóloga, nutricionista…"></label>
        <label class="fld"><span>CPF ou CNPJ (opcional)</span><input name="t_doc" inputmode="numeric" maxlength="18" value="${b.t_doc || ''}"></label></div></fieldset>
      <fieldset class="span2 rt-units"><legend>Tipo de locação</legend>
        ${[['hora', 'Por hora', 'escolha início e fim'], ['periodo', 'Por período', c.periods.map((p) => `${p.label} ${p.start}–${p.end}`).join(' · ')], ['diaria', 'Diária', 'dia inteiro, um ou mais dias']].map(([k, l, d]) => html`<label class="maint-g"><input type="radio" name="unit" value="${k}" ${chk(unit === k)}><span><b>${l}</b><small>${d}</small></span></label>`)}
      </fieldset>
      <label class="fld"><span>Data *</span><input type="date" name="date" required value="${b.date || b.data || todayLocal()}" min="${todayLocal()}"></label>
      <div class="fld" data-rt-show="hora"><span class="rt-lbl">Horário</span><div class="rt-hours"><input type="time" name="start" step="1800" value="${start}" aria-label="Início"><span>até</span><input type="time" name="end" step="1800" value="${end}" aria-label="Fim"></div></div>
      <fieldset class="fld rt-pers" data-rt-show="periodo"><legend>Períodos</legend>${c.periods.map((p) => html`<label class="wl-chip"><input type="checkbox" name="periods" value="${p.key}" ${chk([].concat(b.periods || []).includes(p.key))}><span>${p.label} <small>${p.start}–${p.end}</small></span></label>`)}</fieldset>
      <label class="fld" data-rt-show="diaria"><span>Até (data final)</span><input type="date" name="date_end" value="${b.date_end || ''}" min="${todayLocal()}"></label>
      <label class="fld"><span>Desconto (R$)</span><input name="discount" inputmode="decimal" value="${b.discount || ''}" placeholder="0,00"></label>
      <div class="fld rt-total"><span class="rt-lbl">Total</span><b data-rt-total>—</b><small class="muted" data-rt-calc></small></div>
      <label class="fld"><span>Vencimento</span><input type="date" name="due_date" value="${b.due_date || ''}"><small class="muted">vazio = dia da locação</small></label>
      <div class="fld"><label class="check"><input type="checkbox" name="paid" value="1" ${chk(b.paid)}> <span>Já foi pago</span></label><select name="method" aria-label="Forma de pagamento">${['pix', 'dinheiro', 'cartao', 'transferencia', 'boleto'].map((m) => html`<option value="${m}" ${sel(m, b.method)}>${{ pix: 'Pix', dinheiro: 'Dinheiro', cartao: 'Cartão', transferencia: 'Transferência', boleto: 'Boleto' }[m]}</option>`)}</select></div>
      <label class="fld span2"><span>Observações</span><input name="notes" maxlength="500" value="${b.notes || ''}"></label>
      <label class="fld check span2"><input type="checkbox" name="confirm" value="1" ${chk(b.confirm ?? true)}><span>Reserva confirmada</span></label>
      <label class="fld check span2"><input type="checkbox" name="wa" value="1" ${chk(b.wa ?? c.notifyWhatsApp)}><span>Enviar a confirmação (com Pix, se houver valor em aberto) pelo WhatsApp do locatário</span></label>
      <div class="span2 actions"><button class="btn">Reservar</button><a class="btn ghost" href="${BASE}">Cancelar</a></div>
    </form>`);
}
r.get('/nova', async (req, res) => send(res, await bookForm(req, req.query)));
async function waConfirm(bk, t, sp, total, paid) {
  if (!t.phone) return { ok: false, error: 'sem WhatsApp' };
  let pix = '';
  if (total > 0 && !paid) { const k = await Fin.pixFor({ receiver: 'clinica', amount: total, id: `L${bk.id}` }); if (k) pix = `\n\nPix (copia e cola):\n${k.code}`; }
  return WA.send({ phone: t.phone, kind: 'manual', text: `Olá, ${t.name.split(' ')[0]}! Sua reserva está confirmada:\n\n📍 ${sp.name}\n🗓️ ${when(bk)}${total > 0 ? `\n💰 ${money(total)}${paid ? ' (pago)' : ''}` : ''}${pix}\n\nQualquer dúvida, é só responder esta mensagem.` });
}
r.post('/nova', async (req, res) => {
  const out = await L.book(req.rc, req.body, req.user.id);
  if (out.error) return send(res.status(400), await bookForm(req, { ...req.body, tenant_id: out.tenantId || req.body.tenant_id }, out.error));
  await audit(req, 'locacao-reservar', `booking:${out.id} space:${out.space.id} ${out.total}`);
  let note = '';
  if (req.body.wa) { const bk = await L.booking(out.id); const w = await waConfirm({ ...bk, ends_at: out.quote.slots[out.quote.slots.length - 1].end }, out.tenant, out.space, out.total, !!req.body.paid); note = w.ok ? ' Confirmação enviada pelo WhatsApp.' : ` (WhatsApp não enviado: ${w.error || 'erro'})`; }
  res.flash(`Reserva feita: ${out.space.name}, ${out.quote.label}${out.total ? ` = ${money(out.total)}` : ''}.${out.reused ? ` Usado o cadastro existente de ${out.reused} (sem duplicar).` : ''}${note}`).redirect(`${BASE}/reservas/${out.id}`);
});

// ---------- reservas ----------
r.get('/reservas', async (req, res) => {
  const from = L.isoDay(req.query.de || addDays(todayLocal(), -7)); const to = L.isoDay(req.query.ate || addDays(todayLocal(), 30));
  const status = L.STATUS[req.query.status] ? req.query.status : '';
  const rows = await q(`SELECT b.*, s.name space_name, t.name tenant_name, e.paid_at FROM rental_bookings b JOIN rental_spaces s ON s.id = b.space_id LEFT JOIN rental_tenants t ON t.id = b.tenant_id LEFT JOIN fin_entries e ON e.id = b.entry_id
    WHERE b.starts_at < ? AND b.ends_at >= ? ${status ? 'AND b.status = ?' : ''} ${req.query.espaco ? 'AND b.space_id = ?' : ''} ORDER BY b.starts_at LIMIT 500`,
  [`${addDays(to, 1)} 00:00:00`, `${from} 00:00:00`, ...(status ? [status] : []), ...(req.query.espaco ? [int(req.query.espaco)] : [])]);
  const sps = await L.spaces(true);
  send(res, shell(req, 'Reservas', 'reservas', html`
    <form method="get" class="card filters rt-filters"><label class="fld"><span>De</span><input type="date" name="de" value="${from}"></label><label class="fld"><span>Até</span><input type="date" name="ate" value="${to}"></label>
      <label class="fld"><span>Espaço</span><select name="espaco"><option value="">Todos</option>${sps.map((s) => html`<option value="${s.id}" ${sel(s.id, req.query.espaco)}>${s.name}</option>`)}</select></label>
      <label class="fld"><span>Situação</span><select name="status"><option value="">Todas</option>${Object.entries(L.STATUS).map(([k, l]) => html`<option value="${k}" ${sel(k, status)}>${l}</option>`)}</select></label><button class="btn ghost">Filtrar</button></form>
    <section class="card flush">${rows.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Quando</th><th>Espaço</th><th>Locatário</th><th>Tipo</th><th>Valor</th><th>Situação</th></tr></thead>
      <tbody>${rows.map((b) => html`<tr data-href="${BASE}/reservas/${b.id}"><td><a href="${BASE}/reservas/${b.id}">${when(b)}</a></td><td>${b.space_name}</td><td>${b.tenant_name || '—'}</td><td>${L.UNITS[b.unit]}</td><td>${b.unit === 'plano' ? html`<small class="muted">mensalidade</small>` : b.total > 0 ? html`${money(b.total)} ${b.paid_at ? html`<span class="badge b-realizada">pago</span>` : html`<span class="badge b-agendada">a receber</span>`}` : '—'}</td><td>${badgeOf(b.status)}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted pad">Nenhuma reserva no período.</p>`}</section>`));
});
r.get('/reservas/:id', async (req, res, next) => {
  const b = await L.booking(int(req.params.id));
  if (!b) return next();
  const parts = await L.groupOf(b);
  const active = !['cancelada', 'concluida'].includes(b.status);
  send(res, shell(req, `Reserva #${b.id}`, 'reservas', html`
    <section class="card"><div class="rt-detail">
      <div><span class="muted small">Espaço</span><b>${b.space_name}</b></div>
      <div><span class="muted small">Locatário</span><b><a class="link" href="${BASE}/locatarios/${b.tenant_id}">${b.tenant_name || '—'}</a></b></div>
      <div><span class="muted small">Quando</span><b>${parts.map((x) => when(x)).join(' · ')}</b></div>
      <div><span class="muted small">Tipo</span><b>${L.UNITS[b.unit]}${b.plan_id ? html` · <a class="link" href="${BASE}/planos/${b.plan_id}">ver plano</a>` : ''}</b></div>
      <div><span class="muted small">Valor</span><b>${b.unit === 'plano' ? `mensalidade ${money(b.plan_monthly)}` : b.total > 0 ? html`${money(b.total)}${Number(b.discount) ? html` <small class="muted">(desconto ${money(b.discount)})</small>` : ''}` : '—'}</b></div>
      <div><span class="muted small">Pagamento</span><b>${b.entry_id ? (b.paid_at ? `Pago em ${brDate(b.paid_at)}` : `A receber · vence ${brDate(b.due_date)}`) : '—'}</b></div>
      <div><span class="muted small">Situação</span><b>${badgeOf(b.status)}</b></div>
      ${b.notes ? html`<div class="span2"><span class="muted small">Observações</span><b>${b.notes}</b></div>` : ''}
      ${b.cancel_reason ? html`<div class="span2"><span class="muted small">Motivo do cancelamento</span><b>${b.cancel_reason}</b></div>` : ''}
    </div>
    <div class="actions">
      ${active && b.status === 'reservada' ? html`<form method="post" action="${BASE}/reservas/${b.id}/confirmar" class="inline"><button class="btn">Confirmar</button></form>` : ''}
      ${b.entry_id && !b.paid_at && b.status !== 'cancelada' ? html`<form method="post" action="${BASE}/reservas/${b.id}/pago" class="inline rt-pay"><select name="method" aria-label="Forma de pagamento"><option value="pix">Pix</option><option value="dinheiro">Dinheiro</option><option value="cartao">Cartão</option><option value="transferencia">Transferência</option></select><button class="btn ghost">Marcar como pago</button></form>` : ''}
      ${active && b.tenant_phone ? html`<form method="post" action="${BASE}/reservas/${b.id}/whatsapp" class="inline"><button class="btn ghost">Enviar confirmação no WhatsApp</button></form>` : ''}
    </div>
    ${active ? html`<details class="rt-cancel"><summary class="small">Cancelar reserva</summary><form method="post" action="${BASE}/reservas/${b.id}/cancelar" class="stack"><label class="fld"><span>Motivo</span><input name="reason" maxlength="200"></label><button class="btn danger" data-confirm="Cancelar esta reserva? O horário fica livre${b.entry_id && !b.paid_at ? ' e o valor a receber sai do financeiro' : ''}.">Cancelar reserva</button></form></details>` : ''}
    </section>`));
});
const bookOf = async (req) => L.booking(int(req.params.id));
r.post('/reservas/:id/confirmar', async (req, res, next) => { const b = await bookOf(req); if (!b) return next(); await L.setStatus(b, 'confirmada'); await audit(req, 'locacao-confirmar', `booking:${b.id}`); res.flash('Reserva confirmada.').redirect(`${BASE}/reservas/${b.id}`); });
r.post('/reservas/:id/pago', async (req, res, next) => { const b = await bookOf(req); if (!b) return next(); await L.markPaid(b, req.body.method); await audit(req, 'locacao-pago', `booking:${b.id}`); res.flash('Pagamento registrado (também aparece no Financeiro).').redirect(`${BASE}/reservas/${b.id}`); });
r.post('/reservas/:id/cancelar', async (req, res, next) => {
  const b = await bookOf(req); if (!b) return next();
  const out = await L.cancelBooking(b, str(req.body.reason, 200));
  await audit(req, 'locacao-cancelar', `booking:${b.id}`);
  res.flash(`Reserva cancelada.${out.refund ? ' Ela já estava paga: combine a devolução e lance no Financeiro, se for o caso.' : ''}`, out.refund ? 'warn' : 'ok').redirect(`${BASE}/reservas/${b.id}`);
});
r.post('/reservas/:id/whatsapp', async (req, res, next) => {
  const b = await bookOf(req); if (!b) return next();
  const parts = await L.groupOf(b);
  const w = await waConfirm({ ...b, ends_at: parts[parts.length - 1].ends_at }, { name: b.tenant_name, phone: b.tenant_phone }, { name: b.space_name }, Number(b.total), !!b.paid_at);
  res.flash(w.ok ? 'Confirmação enviada pelo WhatsApp.' : `Não foi possível enviar: ${w.error || 'erro'}.`, w.ok ? 'ok' : 'err').redirect(`${BASE}/reservas/${b.id}`);
});

// ---------- planos mensais ----------
r.get('/planos', async (req, res) => {
  const list = await L.plans(req.query.encerrados ? 'encerrado' : 'ativo');
  send(res, shell(req, 'Planos mensais', 'planos', html`
    <p class="muted">Horários fixos toda semana com mensalidade: as reservas são criadas automaticamente nas próximas ${req.rc.horizonWeeks} semanas e a mensalidade entra em Financeiro → Contas a receber todo mês.</p>
    <div class="actions"><a class="btn" href="${BASE}/planos/novo">+ Novo plano</a><a class="btn ghost" href="?${req.query.encerrados ? '' : 'encerrados=1'}">${req.query.encerrados ? 'Ver ativos' : 'Ver encerrados'}</a></div>
    <section class="card flush">${list.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Locatário</th><th>Espaço</th><th>Horário</th><th>Mensalidade</th><th>Vigência</th></tr></thead>
      <tbody>${list.map((p) => html`<tr data-href="${BASE}/planos/${p.id}"><td><a href="${BASE}/planos/${p.id}">${p.tenant_name}</a></td><td>${p.space_name}</td><td>${p.weekdays.split(',').map((d) => L.WEEK[d]).join(', ')} · ${hm(p.start_time)}–${hm(p.end_time)}</td><td>${money(p.monthly)} <small class="muted">dia ${p.due_day}</small></td><td>${brDate(p.start_date)}${p.end_date ? ` a ${brDate(p.end_date)}` : ' · sem término'}</td></tr>`)}</tbody></table></div>`
    : html`<p class="muted pad">Nenhum plano ${req.query.encerrados ? 'encerrado' : 'ativo'}.</p>`}</section>`));
});
async function planForm(req, b = {}, error = '') {
  const [sps, to] = await Promise.all([L.spaces(), L.tenantOptions()]);
  return shell(req, 'Novo plano mensal', 'planos', html`
    ${error ? html`<div class="flash err">${error}</div>` : ''}
    <form method="post" action="${BASE}/planos/novo" class="card form-grid" data-rental>
      <label class="fld"><span>Espaço *</span><select name="space_id" required>${sps.map((s) => html`<option value="${s.id}" ${sel(s.id, b.space_id)}>${s.name} · ${hm(s.open_time)}–${hm(s.close_time)}</option>`)}</select></label>
      <label class="fld"><span>Locatário *</span>${tenantSelect(to, b.tenant_id)}</label>
      <fieldset class="span2 rt-newt" data-rt-newt><legend>Novo locatário</legend><p class="muted small">Profissional da clínica? Escolha na lista acima. Se o nome, WhatsApp ou CPF/CNPJ já estiver cadastrado, o sistema usa o cadastro existente.</p><div class="form-grid">
        <label class="fld"><span>Nome completo</span><input name="t_name" maxlength="160" value="${b.t_name || ''}"></label>
        <label class="fld"><span>WhatsApp</span><input name="t_phone" type="tel" maxlength="40" value="${b.t_phone || ''}"></label>
        <label class="fld"><span>Profissão</span><input name="t_profession" maxlength="80" value="${b.t_profession || ''}"></label>
        <label class="fld"><span>CPF ou CNPJ (opcional)</span><input name="t_doc" inputmode="numeric" maxlength="18" value="${b.t_doc || ''}"></label></div></fieldset>
      <fieldset class="fld span2 wl-chips"><legend>Dias da semana *</legend>${L.WEEK.map((d, i) => html`<label class="wl-chip"><input type="checkbox" name="weekdays" value="${i}" ${chk([].concat(b.weekdays || []).map(String).includes(String(i)))}><span>${d}</span></label>`)}</fieldset>
      <div class="fld"><span class="rt-lbl">Horário *</span><div class="rt-hours"><input type="time" name="start" step="1800" value="${b.start || ''}" required aria-label="Início"><span>até</span><input type="time" name="end" step="1800" value="${b.end || ''}" required aria-label="Fim"></div></div>
      <label class="fld"><span>Mensalidade (R$) *</span><input name="monthly" inputmode="decimal" required value="${b.monthly || ''}" placeholder="0,00"></label>
      <label class="fld"><span>Vencimento (dia do mês)</span><input type="number" name="due_day" min="1" max="28" value="${b.due_day || 10}"></label>
      <label class="fld"><span>Início do contrato *</span><input type="date" name="start_date" required value="${b.start_date || todayLocal()}"></label>
      <label class="fld"><span>Término <small class="muted">(vazio = sem prazo)</small></span><input type="date" name="end_date" value="${b.end_date || ''}"></label>
      <label class="fld span2"><span>Observações</span><input name="notes" maxlength="500" value="${b.notes || ''}"></label>
      <div class="span2 actions"><button class="btn">Criar plano</button><a class="btn ghost" href="${BASE}/planos">Cancelar</a></div>
    </form>`);
}
r.get('/planos/novo', async (req, res) => send(res, await planForm(req, req.query)));
r.post('/planos/novo', async (req, res) => {
  const out = await L.createPlan(req.rc, req.body, req.user.id);
  if (out.error) return send(res.status(400), await planForm(req, { ...req.body, tenant_id: out.tenantId || req.body.tenant_id }, out.error));
  await audit(req, 'locacao-plano', `plan:${out.id}`);
  res.flash('Plano criado: reservas das próximas semanas feitas e mensalidade lançada no Financeiro.').redirect(`${BASE}/planos/${out.id}`);
});
r.get('/planos/:id', async (req, res, next) => {
  const p = await L.plan(int(req.params.id));
  if (!p) return next();
  const next10 = await q("SELECT * FROM rental_bookings WHERE plan_id = ? AND starts_at >= NOW() AND status <> 'cancelada' ORDER BY starts_at LIMIT 12", [p.id]);
  const fees = p.recurring_id ? await q('SELECT * FROM fin_entries WHERE recurring_id = ? ORDER BY rec_ym DESC LIMIT 12', [p.recurring_id]) : [];
  const skipped = p.status === 'ativo' ? L.occurrences(p, req.rc.horizonWeeks).filter((o) => !next10.some((b) => b.starts_at === o.start)).length : 0;
  send(res, shell(req, `Plano · ${p.tenant_name}`, 'planos', html`
    <section class="card"><div class="rt-detail">
      <div><span class="muted small">Espaço</span><b>${p.space_name}</b></div>
      <div><span class="muted small">Horário</span><b>${p.weekdays.split(',').map((d) => L.WEEK[d]).join(', ')} · ${hm(p.start_time)}–${hm(p.end_time)}</b></div>
      <div><span class="muted small">Mensalidade</span><b>${money(p.monthly)} · vence dia ${p.due_day}</b></div>
      <div><span class="muted small">Vigência</span><b>${brDate(p.start_date)}${p.end_date ? ` a ${brDate(p.end_date)}` : ' · sem término'}</b></div>
      <div><span class="muted small">Situação</span><b>${p.status === 'ativo' ? 'Ativo' : 'Encerrado'}</b></div>
    </div>
    ${skipped > next10.length ? '' : ''}
    ${p.status === 'ativo' ? html`<details class="rt-cancel"><summary class="small">Encerrar plano</summary><form method="post" action="${BASE}/planos/${p.id}/encerrar" class="stack"><label class="fld"><span>Último dia</span><input type="date" name="end_date" value="${todayLocal()}"></label>
      <button class="btn danger" data-confirm="Encerrar o plano? As reservas depois dessa data são canceladas e as mensalidades futuras não pagas saem do financeiro.">Encerrar plano</button></form></details>` : ''}
    </section>
    <div class="grid2">
      <section class="card"><h2>Próximos horários</h2>${next10.length ? html`<ul class="list">${next10.map((b) => html`<li><a href="${BASE}/reservas/${b.id}"><b class="time">${brDate(b.starts_at).slice(0, 5)}</b><span>${wdOf(b.starts_at.slice(0, 10))} · ${b.starts_at.slice(11, 16)}–${b.ends_at.slice(11, 16)}</span></a></li>`)}</ul>` : html`<p class="muted">Nenhum horário futuro.</p>`}</section>
      <section class="card"><h2>Mensalidades</h2>${fees.length ? html`<ul class="list">${fees.map((e) => html`<li><a href="/financeiro/contas/${e.id}"><b class="time">${e.rec_ym.slice(5)}/${e.rec_ym.slice(0, 4)}</b><span>${money(e.amount)}<small>vence ${brDate(e.due_date)}</small></span>${e.paid_at ? html`<span class="badge b-realizada">paga</span>` : html`<span class="badge b-agendada">em aberto</span>`}</a></li>`)}</ul>` : html`<p class="muted">Nenhuma mensalidade lançada ainda.</p>`}</section>
    </div>`));
});
r.post('/planos/:id/encerrar', async (req, res, next) => {
  const out = await L.endPlan(req.rc, int(req.params.id), str(req.body.end_date, 10), req.user.id);
  if (out.error) return next();
  await audit(req, 'locacao-plano-encerrar', `plan:${req.params.id}`);
  res.flash('Plano encerrado.').redirect(`${BASE}/planos/${int(req.params.id)}`);
});

// ---------- locatários ----------
r.get('/locatarios', async (req, res) => {
  const list = await q(`SELECT t.*, (SELECT COUNT(*) FROM rental_bookings b WHERE b.tenant_id = t.id AND b.status <> 'cancelada') n, (SELECT COUNT(*) FROM rental_plans p WHERE p.tenant_id = t.id AND p.status = 'ativo') plans,
    (SELECT COALESCE(SUM(e.amount),0) FROM fin_entries e JOIN rental_bookings b ON b.entry_id = e.id WHERE b.tenant_id = t.id AND e.paid_at IS NULL) owed FROM rental_tenants t WHERE t.active = 1 ORDER BY t.name`);
  send(res, shell(req, 'Locatários', 'locatarios', html`
    <section class="card flush">${list.length ? html`<div class="tbl-wrap"><table class="tbl hover"><thead><tr><th>Nome</th><th>Profissão</th><th>WhatsApp</th><th>Reservas</th><th>Planos</th><th>Em aberto</th></tr></thead>
      <tbody>${list.map((t) => html`<tr data-href="${BASE}/locatarios/${t.id}"><td><a href="${BASE}/locatarios/${t.id}">${t.name}</a>${t.user_id ? html` <span class="badge b-confirmada">profissional da clínica</span>` : ''}</td><td>${t.profession || '—'}${t.reg ? html` <small class="muted">${t.reg}</small>` : ''}</td><td>${t.phone || '—'}</td><td>${t.n}</td><td>${t.plans}</td><td>${Number(t.owed) ? money(t.owed) : '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted pad">Nenhum locatário ainda.</p>`}</section>
    <form method="post" action="${BASE}/locatarios" class="card form-grid"><h2 class="span2">Novo locatário</h2>${tenantFields({})}<div class="span2 actions"><button class="btn">Cadastrar</button></div></form>`));
});
const tenantFields = (t) => html`
  <label class="fld"><span>Nome completo *</span><input name="name" required maxlength="160" value="${t.name || ''}"></label>
  <label class="fld"><span>WhatsApp</span><input name="phone" type="tel" maxlength="40" value="${t.phone || ''}"></label>
  <label class="fld"><span>E-mail</span><input name="email" type="email" maxlength="160" value="${t.email || ''}"></label>
  <label class="fld"><span>CPF ou CNPJ</span><input name="doc" inputmode="numeric" maxlength="18" value="${t.doc || ''}"></label>
  <label class="fld"><span>Profissão</span><input name="profession" maxlength="80" value="${t.profession || ''}"></label>
  <label class="fld"><span>Registro profissional</span><input name="reg" maxlength="40" value="${t.reg || ''}" placeholder="CRP, CRM, CRN…"></label>
  <label class="fld span2"><span>Observações</span><input name="notes" maxlength="500" value="${t.notes || ''}"></label>`;
r.post('/locatarios', async (req, res) => {
  const ex = await L.findExisting(req.body);
  if (ex?.tenantId) return res.flash(`${ex.name} já está cadastrado(a) como locatário (mesmo nome, WhatsApp ou CPF/CNPJ).`, 'warn').redirect(`${BASE}/locatarios/${ex.tenantId}`);
  if (ex?.userId) { const t = await L.tenantForUser(ex.userId); return res.flash(`${ex.name} é profissional da clínica: o locatário foi ligado ao cadastro dele(a), sem duplicar.`, 'warn').redirect(`${BASE}/locatarios/${t.id}`); }
  const out = await L.saveTenant(0, req.body);
  if (out.error) return res.flash(out.error, 'err').redirect(`${BASE}/locatarios`);
  await audit(req, 'locacao-locatario', `tenant:${out.id}`);
  res.flash('Locatário cadastrado.').redirect(`${BASE}/locatarios/${out.id}`);
});
r.get('/locatarios/:id', async (req, res, next) => {
  const t = await L.tenant(int(req.params.id));
  if (!t) return next();
  const pros = await L.clinicPros();
  const [bks, pls] = await Promise.all([
    q('SELECT b.*, s.name space_name, e.paid_at FROM rental_bookings b JOIN rental_spaces s ON s.id = b.space_id LEFT JOIN fin_entries e ON e.id = b.entry_id WHERE b.tenant_id = ? AND b.plan_id IS NULL ORDER BY b.starts_at DESC LIMIT 30', [t.id]),
    q('SELECT p.*, s.name space_name FROM rental_plans p JOIN rental_spaces s ON s.id = p.space_id WHERE p.tenant_id = ? ORDER BY p.status, p.start_date DESC', [t.id]),
  ]);
  send(res, shell(req, t.name, 'locatarios', html`
    <div class="actions"><a class="btn ghost" href="${BASE}/nova?tenant_id=${t.id}">+ Reserva para ${t.name.split(' ')[0]}</a><a class="btn ghost" href="${BASE}/planos/novo?tenant_id=${t.id}">+ Plano mensal</a></div>
    <div class="grid2">
      <section class="card"><h2>Planos</h2>${pls.length ? html`<ul class="list">${pls.map((p) => html`<li><a href="${BASE}/planos/${p.id}"><span>${p.space_name} · ${p.weekdays.split(',').map((d) => L.WEEK[d]).join(', ')} ${hm(p.start_time)}–${hm(p.end_time)}<small>${money(p.monthly)}/mês</small></span><span class="badge ${p.status === 'ativo' ? 'b-realizada' : ''}">${p.status}</span></a></li>`)}</ul>` : html`<p class="muted">Nenhum plano.</p>`}</section>
      <section class="card"><h2>Reservas avulsas</h2>${bks.length ? html`<ul class="list">${bks.map((b) => html`<li><a href="${BASE}/reservas/${b.id}"><span>${b.space_name} · ${when(b)}<small>${L.UNITS[b.unit]}${b.total > 0 ? ` · ${money(b.total)}${b.paid_at ? ' · pago' : ' · a receber'}` : ''}</small></span>${badgeOf(b.status)}</a></li>`)}</ul>` : html`<p class="muted">Nenhuma reserva.</p>`}</section>
    </div>
    <form method="post" action="${BASE}/locatarios/${t.id}" class="card form-grid"><h2 class="span2">Dados</h2>${tenantFields(t)}
      <label class="fld span2"><span>Profissional da clínica vinculado</span><select name="user_id"><option value="">— nenhum (locatário de fora) —</option>${pros.map((u) => html`<option value="${u.id}" ${sel(u.id, t.user_id)}>${proName(u)}${u.crp ? ` · CRP ${u.crp}` : ''}</option>`)}</select><small class="muted">Ligue ao cadastro do profissional para não ter dois cadastros da mesma pessoa.</small></label>
      <div class="span2 actions"><button class="btn">Salvar</button></div></form>`));
});
r.post('/locatarios/:id', async (req, res, next) => {
  const t = await L.tenant(int(req.params.id)); if (!t) return next();
  const out = await L.saveTenant(t.id, req.body);
  if (out.error) return res.flash(out.error, 'err').redirect(`${BASE}/locatarios/${t.id}`);
  const bad = await L.linkUser(t.id, int(req.body.user_id));
  if (bad) return res.flash(bad, 'err').redirect(`${BASE}/locatarios/${t.id}`);
  await audit(req, 'locacao-locatario', `tenant:${t.id}`);
  res.flash('Dados salvos.').redirect(`${BASE}/locatarios/${t.id}`);
});

// ---------- espaços ----------
const spaceForm = (s, action, label) => html`<form method="post" action="${action}" class="card form-grid">
  <label class="fld"><span>Nome *</span><input name="name" required maxlength="80" value="${s.name || ''}" placeholder="Consultório 1, Sala de grupo, Auditório…"></label>
  <label class="fld"><span>Tipo</span><select name="kind">${Object.entries(L.KINDS).map(([k, l]) => html`<option value="${k}" ${sel(k, s.kind || 'consultorio')}>${l}</option>`)}</select></label>
  <label class="fld"><span>Capacidade (pessoas)</span><input type="number" name="capacity" min="0" value="${s.capacity || ''}"></label>
  <label class="fld"><span>Locação mínima por hora</span><input name="min_hours" inputmode="decimal" value="${String(Number(s.min_hours || 1)).replace('.', ',')}"></label>
  <label class="fld"><span>Preço por hora (R$)</span><input name="price_hour" inputmode="decimal" value="${s.price_hour ? String(Number(s.price_hour).toFixed(2)).replace('.', ',') : ''}" placeholder="vazio = não aluga por hora"></label>
  <label class="fld"><span>Preço por período (R$)</span><input name="price_period" inputmode="decimal" value="${s.price_period ? String(Number(s.price_period).toFixed(2)).replace('.', ',') : ''}" placeholder="manhã, tarde ou noite"></label>
  <label class="fld"><span>Preço da diária (R$)</span><input name="price_day" inputmode="decimal" value="${s.price_day ? String(Number(s.price_day).toFixed(2)).replace('.', ',') : ''}"></label>
  <div class="fld"><span class="rt-lbl">Funcionamento</span><div class="rt-hours"><input type="time" name="open_time" value="${hm(s.open_time) || '07:00'}" required aria-label="Abre"><span>às</span><input type="time" name="close_time" value="${hm(s.close_time) || '22:00'}" required aria-label="Fecha"></div></div>
  <fieldset class="fld span2 wl-chips"><legend>Dias de funcionamento</legend>${L.WEEK.map((d, i) => html`<label class="wl-chip"><input type="checkbox" name="weekdays" value="${i}" ${chk(String(s.weekdays ?? '1,2,3,4,5,6').split(',').includes(String(i)))}><span>${d}</span></label>`)}</fieldset>
  <label class="fld span2"><span>Itens e comodidades</span><input name="amenities" maxlength="300" value="${s.amenities || ''}" placeholder="Ar-condicionado, poltronas, divã, projetor, Wi-Fi…"></label>
  <label class="fld span2"><span>Descrição</span><input name="description" maxlength="500" value="${s.description || ''}"></label>
  ${s.id ? html`<label class="fld check span2"><input type="checkbox" name="active" value="1" ${chk(s.active)}><span>Disponível para locação</span></label>` : html`<input type="hidden" name="active" value="1">`}
  <div class="span2 actions"><button class="btn">${label}</button><a class="btn ghost" href="${BASE}/espacos">Voltar</a></div></form>`;
r.get('/espacos', async (req, res) => {
  const list = await L.spaces(true);
  send(res, shell(req, 'Espaços', 'espacos', html`
    <div class="actions"><a class="btn" href="${BASE}/espacos/novo">+ Cadastrar espaço</a><a class="btn ghost" href="/configuracoes/locacao">Períodos e configurações</a></div>
    <div class="rt-spaces">${list.map((s) => html`<a class="card rt-space ${s.active ? '' : 'off'}" href="${BASE}/espacos/${s.id}"><b>${s.name}</b><small>${L.KINDS[s.kind]}${s.capacity ? ` · até ${s.capacity} pessoas` : ''}${s.active ? '' : ' · indisponível'}</small>
      <span class="rt-prices">${Number(s.price_hour) ? html`<i>${money(s.price_hour)}/h</i>` : ''}${Number(s.price_period) ? html`<i>${money(s.price_period)}/período</i>` : ''}${Number(s.price_day) ? html`<i>${money(s.price_day)}/dia</i>` : ''}</span>
      <small class="muted">${s.weekdays.split(',').map((d) => L.WEEK[d]).join(', ')} · ${hm(s.open_time)}–${hm(s.close_time)}</small></a>`)}</div>
    ${list.length ? '' : html`<p class="muted">Nenhum espaço cadastrado.</p>`}`));
});
r.get('/espacos/novo', (req, res) => send(res, shell(req, 'Novo espaço', 'espacos', spaceForm({}, `${BASE}/espacos/novo`, 'Cadastrar'))));
r.post('/espacos/novo', async (req, res) => {
  const bad = L.checkSpace(req.body);
  if (bad) return send(res.status(400), shell(req, 'Novo espaço', 'espacos', html`<div class="flash err">${bad}</div>${spaceForm({ ...req.body, weekdays: [].concat(req.body.weekdays || []).join(',') }, `${BASE}/espacos/novo`, 'Cadastrar')}`));
  const id = await L.saveSpace(0, req.body);
  await audit(req, 'locacao-espaco', `space:${id}`);
  res.flash('Espaço cadastrado.').redirect(`${BASE}/espacos`);
});
r.get('/espacos/:id', async (req, res, next) => {
  const s = await L.space(int(req.params.id)); if (!s) return next();
  send(res, shell(req, s.name, 'espacos', spaceForm(s, `${BASE}/espacos/${s.id}`, 'Salvar')));
});
r.post('/espacos/:id', async (req, res, next) => {
  const s = await L.space(int(req.params.id)); if (!s) return next();
  const bad = L.checkSpace(req.body);
  if (bad) return send(res.status(400), shell(req, s.name, 'espacos', html`<div class="flash err">${bad}</div>${spaceForm({ ...s, ...req.body, weekdays: [].concat(req.body.weekdays || []).join(',') }, `${BASE}/espacos/${s.id}`, 'Salvar')}`));
  await L.saveSpace(s.id, { ...req.body, active: req.body.active ? 1 : 0 });
  await audit(req, 'locacao-espaco', `space:${s.id}`);
  res.flash('Espaço salvo.').redirect(`${BASE}/espacos`);
});
export default r;

// ---------- Configurações → Locação de espaços ----------
export const settings = router();
settings.get('/', async (req, res) => {
  const c = await L.config();
  send(res, page(req, { title: 'Locação de espaços', active: 'config', body: html`<header class="ph"><div><p class="eyebrow">Configurações</p><h1>Locação de espaços</h1>
      <p class="muted">Aluguel de consultórios, salas e auditórios para outros profissionais: por hora, por período, diária ou plano mensal (horários fixos com mensalidade). Os valores entram no Financeiro como contas a receber.</p></div>
      <div class="ph-actions">${c.enabled ? html`<a class="btn ghost" href="/locacao">Abrir o módulo</a>` : ''}<a class="btn ghost" href="/configuracoes">Voltar</a></div></header>
    <form method="post" class="card stack">
      <label class="fld check"><input type="checkbox" name="enabled" value="1" ${chk(c.enabled)}><span><b>Ligar o módulo de locação</b> <small class="muted">(aparece “Locação” no menu para quem acessa a agenda)</small></span></label>
      <h3>Períodos</h3>
      <div class="rt-percfg">${c.periods.map((p) => html`<div class="rt-per"><label class="fld"><span>Nome</span><input name="pl_${p.key}" maxlength="30" value="${p.label}"></label><label class="fld"><span>Início</span><input type="time" name="ps_${p.key}" value="${p.start}"></label><label class="fld"><span>Fim</span><input type="time" name="pe_${p.key}" value="${p.end}"></label></div>`)}</div>
      <div class="form-grid">
        <label class="fld"><span>Categoria no financeiro</span><input name="category" maxlength="80" value="${c.category}"></label>
        <label class="fld"><span>Planos: criar reservas para as próximas (semanas)</span><input type="number" name="horizonWeeks" min="2" max="26" value="${c.horizonWeeks}"></label>
      </div>
      <label class="fld check"><input type="checkbox" name="notifyWhatsApp" value="1" ${chk(c.notifyWhatsApp)}><span>Por padrão, enviar a confirmação da reserva pelo WhatsApp do locatário (com Pix da clínica quando houver valor em aberto)</span></label>
      <div class="actions"><button class="btn">Salvar</button></div>
    </form>` }));
});
settings.post('/', async (req, res) => {
  const bad = await L.saveConfig(req.body);
  if (bad) return res.flash(bad, 'err').redirect('/configuracoes/locacao');
  await audit(req, 'locacao-config');
  res.flash('Locação salva.').redirect('/configuracoes/locacao');
});
