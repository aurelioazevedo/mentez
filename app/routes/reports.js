// Relatórios gerenciais (BI): visão geral, agenda e presença, financeiro, pacientes, profissionais e captação.
import { q, audit } from '../lib/db.js';
import { page, html, raw, brDate } from '../lib/html.js';
import { router, send, int as toInt } from '../lib/router.js';
import { can, ownOnly, proName } from '../lib/perm.js';
import { monthName, todayLocal } from '../lib/time.js';
import * as R from '../lib/reports.js';
import * as BI from '../lib/bi.js';
import * as Engage from '../lib/engage.js';
import * as IR from '../lib/insreports.js';
import { one } from '../lib/db.js';

const r = router();
const TABS = { visao: 'Visão geral', agenda: 'Agenda e presença', financeiro: 'Financeiro', convenios: 'Convênios', pacientes: 'Pacientes', profissionais: 'Profissionais', captacao: 'Captação', satisfacao: 'Satisfação' };
const WD = ['Domingo', 'Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado'];
const STATUS = [
  { key: 'realizada', name: 'Realizadas', cls: 'st-ok' },
  { key: 'agendada', name: 'Agendadas', cls: 'bi-s2' },
  { key: 'falta', name: 'Faltas', cls: 'st-bad' },
  { key: 'cancelada', name: 'Canceladas', cls: 'st-off' },
];
const SERIES = ['bi-s1', 'bi-s2', 'bi-s3', 'bi-s4', 'bi-s5', 'bi-s6'];
const fmtRange = (x) => (x.from === x.to ? brDate(x.from) : `${brDate(x.from)} a ${brDate(x.to)}`);
const hours = (min) => `${BI.dec1(min / 60)} h`;
const days = (d) => (d == null ? '—' : d >= 60 ? `${BI.dec1(d / 30.4)} meses` : `${Math.round(d)} dias`);

// Filtros da página (psicólogo(a) colaborador(a) vê só os próprios números)
async function filtersOf(req) {
  const preset = R.PRESETS[req.query.p] ? req.query.p : 'mes';
  const rg = R.range(preset, req.query.de, req.query.ate);
  const mine = ownOnly(req.user) || !can(req.user, 'financeiro');
  const pros = mine ? [] : await q("SELECT id, name, title FROM users WHERE active = 1 AND (attends = 1 OR EXISTS (SELECT 1 FROM patients p WHERE p.owner_id = users.id)) ORDER BY name");
  const prof = mine ? req.user.id : (pros.some((u) => u.id === toInt(req.query.prof)) ? toInt(req.query.prof) : null);
  const mod = ['online', 'presencial'].includes(req.query.mod) ? req.query.mod : null;
  const cmp = req.query.cmp !== '0';
  const hasIns = !!(await one('SELECT 1 x FROM insurers WHERE active = 1 UNION SELECT 1 FROM tiss_batches LIMIT 1'));
  const tab = TABS[req.query.aba] && (req.query.aba !== 'convenios' || hasIns) ? req.query.aba : 'visao';
  return { hasIns, preset, rg, prev: R.previous(rg), prof, mod, cmp, tab, mine, pros, f: { prof, mod, clinic: !mine && !prof } };
}
const qs = (F, over = {}) => {
  const o = { aba: F.tab, p: F.preset, ...(F.preset === 'custom' ? { de: F.rg.from, ate: F.rg.to } : {}), ...(F.prof && !F.mine ? { prof: F.prof } : {}), ...(F.mod ? { mod: F.mod } : {}), ...(F.cmp ? {} : { cmp: '0' }), ...over };
  return `?${new URLSearchParams(Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')).toString()}`;
};
// Clique numa barra: abre aquele dia/semana/mês
const drill = (F, k, g) => { const b = R.bucketRange(k, g); return qs(F, { p: 'custom', de: b.from, ate: b.to }); };

function filterBar(F) {
  const sel = (a, b) => (String(a ?? '') === String(b ?? '') ? raw('selected') : '');
  return html`<form class="bi-filters" method="get" data-bi-filters>
    <input type="hidden" name="aba" value="${F.tab}">
    <label class="fld"><span>Período</span><select name="p" data-bi-preset>${Object.entries(R.PRESETS).map(([k, l]) => html`<option value="${k}" ${sel(F.preset, k)}>${l}</option>`)}</select></label>
    <label class="fld bi-custom" ${F.preset === 'custom' ? '' : raw('hidden')}><span>De</span><input type="date" name="de" value="${F.rg.from}"></label>
    <label class="fld bi-custom" ${F.preset === 'custom' ? '' : raw('hidden')}><span>Até</span><input type="date" name="ate" value="${F.rg.to}"></label>
    ${F.mine ? '' : html`<label class="fld"><span>Profissional</span><select name="prof"><option value="">Toda a clínica</option>${F.pros.map((u) => html`<option value="${u.id}" ${sel(F.prof, u.id)}>${proName(u)}</option>`)}</select></label>`}
    <label class="fld"><span>Modalidade</span><select name="mod"><option value="">Todas</option><option value="online" ${sel(F.mod, 'online')}>On-line</option><option value="presencial" ${sel(F.mod, 'presencial')}>Presencial</option></select></label>
    <label class="fld check bi-cmp"><input type="checkbox" name="cmp" value="1" ${F.cmp ? raw('checked') : ''}><span>Comparar com o período anterior</span></label>
    <input type="hidden" name="cmp" value="0" disabled data-bi-cmp-off>
    <button class="btn ghost bi-apply">Aplicar</button>
  </form>`;
}
const tabsNav = (F) => html`<nav class="bi-tabs" aria-label="Relatórios">${Object.entries(TABS).filter(([k]) => (k !== 'profissionais' || !F.mine) && (k !== 'convenios' || F.hasIns)).map(([k, l]) => html`<a href="${qs(F, { aba: k })}" class="${F.tab === k ? 'on' : ''}" ${F.tab === k ? raw('aria-current="page"') : ''}>${l}</a>`)}</nav>`;
const csvLink = (F, ds, label = 'CSV') => html`<a class="btn ghost btn-sm bi-csv" href="/relatorios/csv${qs(F, { ds })}" download>⭳ ${label}</a>`;
const cmpOf = (F, cur, prev, fmt) => ({ show: F.cmp, cur, prev, prevTxt: fmt(prev) });

const insHref = (F, h) => { if (!h) return '#'; const [t, hash] = h.replace('?aba=', '').split('#'); return qs(F, { aba: t }) + (hash ? `#${hash}` : ''); };
// ---------- seções ----------
async function overview(F) {
  const g = R.grain(F.rg);
  const [ag, agP, fin, finP, pat, patP, series, rev, revP, conf, heatRows, risk] = await Promise.all([
    R.agendaTotals(F.f, F.rg), R.agendaTotals(F.f, F.prev), R.financeTotals(F.f, F.rg), R.financeTotals(F.f, F.prev),
    R.patientStats(F.f, F.rg), R.patientStats(F.f, F.prev), R.agendaSeries(F.f, F.rg, g), R.revenueSeries(F.f, F.rg, g), F.cmp ? R.revenueSeries(F.f, F.prev, g) : null,
    R.confirmations(F.f, F.rg), R.heat(F.f, F.rg), R.atRiskCount(F.f),
  ]);
  const occ = await R.occupancy(F.f, F.rg, F.pros.map((u) => u.id).concat(F.mine ? [F.prof] : []));
  const ins = R.insights({ ag, agPrev: agP, fin, finPrev: finP, conf, heatRows, occ, risk, cmp: F.cmp });
  return html`
    ${ins.length ? html`<section class="bi-insights" aria-label="Destaques">${ins.map((i) => html`<a class="bi-ins ${i.tone}" href="${insHref(F, i.href)}"><b aria-hidden="true">${i.tone === 'good' ? '▲' : i.tone === 'bad' ? '!' : 'i'}</b><span>${i.text}</span></a>`)}</section>` : ''}
    <div class="bi-kpis">
      ${BI.kpi({ label: 'Sessões realizadas', value: BI.int(ag.realizada), prev: cmpOf(F, ag.realizada, agP.realizada, BI.int), spark: series.map((x) => x.realizada), href: qs(F, { aba: 'agenda' }) })}
      ${BI.kpi({ label: 'Faltas', value: BI.pc(ag.faltas), sub: `${BI.int(ag.falta)} de ${BI.int(ag.realizada + ag.falta)} sessões`, prev: cmpOf(F, ag.faltas, agP.faltas, BI.pc), fmtDelta: 'pp', good: 'down', href: qs(F, { aba: 'agenda' }) })}
      ${BI.kpi({ label: 'Receita recebida', value: BI.brl(fin.recebido), prev: cmpOf(F, fin.recebido, finP.recebido, BI.brl), spark: rev.map((x) => x.value), href: qs(F, { aba: 'financeiro' }) })}
      ${BI.kpi({ label: 'Ticket médio por sessão', value: fin.ticket == null ? '—' : BI.brl(fin.ticket), prev: cmpOf(F, fin.ticket, finP.ticket, (v) => (v == null ? '—' : BI.brl(v))), href: qs(F, { aba: 'financeiro' }) })}
      ${BI.kpi({ label: 'Pacientes atendidos', value: BI.int(pat.ativos), prev: cmpOf(F, pat.ativos, patP.ativos, BI.int), href: qs(F, { aba: 'pacientes' }) })}
      ${BI.kpi({ label: 'Novos pacientes', value: BI.int(pat.novos), sub: '1ª sessão no período', prev: cmpOf(F, pat.novos, patP.novos, BI.int), href: qs(F, { aba: 'pacientes' }) })}
      ${BI.kpi({ label: 'Ocupação da agenda', value: occ ? BI.pc(occ.rate) : '—', sub: occ ? `${hours(occ.used)} de ${hours(occ.cap)} da escala` : 'configure a escala de horários', href: qs(F, { aba: 'agenda' }) })}
      ${BI.kpi({ label: 'Em atraso', value: BI.brl(fin.atrasado), sub: fin.atrasadoN ? `${fin.atrasadoN} lançamento(s) · ${fin.atrasadoPac} paciente(s)` : 'nada em atraso', hint: 'situação de hoje', href: `${qs(F, { aba: 'financeiro' })}#inadimplencia` })}
    </div>
    <div class="bi-grid2">
      ${BI.panel('Sessões', BI.stacked(series.map((x) => ({ ...x, href: drill(F, x.k, g) })), STATUS, { title: 'Sessões por status' }), { sub: `Por ${g === 'dia' ? 'dia' : g === 'semana' ? 'semana' : 'mês'} · clique numa barra para detalhar`, actions: csvLink(F, 'sessoes') })}
      ${BI.panel('Receita recebida', BI.lineCompare(rev, revP, { fmt: BI.brl, fmtAxis: BI.moneyShort, title: 'Receita recebida' }), { sub: F.cmp ? `Comparada com ${fmtRange(F.prev)}` : '', actions: csvLink(F, 'receita') })}
    </div>`;
}

async function agendaTab(F) {
  const g = R.grain(F.rg);
  const [ag, agP, series, heatRows, wds, conf, via, mods] = await Promise.all([
    R.agendaTotals(F.f, F.rg), R.agendaTotals(F.f, F.prev), R.agendaSeries(F.f, F.rg, g), R.heat(F.f, F.rg), R.weekdayStats(F.f, F.rg), R.confirmations(F.f, F.rg), R.originOfBookings(F.f, F.rg), R.modalitySplit(F.f, F.rg),
  ]);
  const occ = await R.occupancy(F.f, F.rg, F.pros.map((u) => u.id).concat(F.mine ? [F.prof] : []));
  const c = conf.by; const n = (k) => (c[k]?.n || 0);
  const leadAll = via.reduce((a, x) => a + x.lead * x.n, 0) / (via.reduce((a, x) => a + x.n, 0) || 1);
  return html`<div class="bi-kpis">
      ${BI.kpi({ label: 'Realizadas', value: BI.int(ag.realizada), sub: hours(ag.realizadaMins) + ' atendidas', prev: cmpOf(F, ag.realizada, agP.realizada, BI.int) })}
      ${BI.kpi({ label: 'Presença', value: BI.pc(ag.presenca), sub: 'realizadas ÷ (realizadas + faltas)', prev: cmpOf(F, ag.presenca, agP.presenca, BI.pc), fmtDelta: 'pp' })}
      ${BI.kpi({ label: 'Faltas', value: BI.pc(ag.faltas), sub: `${BI.int(ag.falta)} falta(s)`, prev: cmpOf(F, ag.faltas, agP.faltas, BI.pc), fmtDelta: 'pp', good: 'down' })}
      ${BI.kpi({ label: 'Cancelamentos', value: BI.pc(ag.cancelamento), sub: `${BI.int(ag.cancelada)} de ${BI.int(ag.total)} marcadas`, prev: cmpOf(F, ag.cancelamento, agP.cancelamento, BI.pc), fmtDelta: 'pp', good: 'down' })}
      ${BI.kpi({ label: 'Ocupação da escala', value: occ ? BI.pc(occ.rate) : '—', sub: occ ? `${hours(occ.free)} livres` : 'sem escala configurada' })}
      ${BI.kpi({ label: 'Ainda agendadas', value: BI.int(ag.agendada), sub: 'sessões futuras do período', good: 'neutral' })}
      ${BI.kpi({ label: 'Sem registro de presença', value: BI.int(ag.pendente), sub: ag.pendente ? 'já passaram: marque realizada ou falta' : 'tudo registrado', href: ag.pendente ? '/agenda' : null })}
      ${BI.kpi({ label: 'Antecedência média', value: via.length ? `${BI.dec1(leadAll)} dias` : '—', sub: 'entre marcar e a sessão' })}
    </div>
    ${BI.panel('Sessões por status', BI.stacked(series.map((x) => ({ ...x, href: drill(F, x.k, g) })), STATUS, { title: 'Sessões por status' }), { wide: true, sub: 'Clique numa barra para ver só aquele período', actions: csvLink(F, 'sessoes') })}
    <div class="bi-grid2">
      ${BI.panel('Dias e horários mais procurados', BI.heatmap(heatRows.filter((x) => x.ok).map((x) => ({ wd: x.wd, h: x.h, v: x.ok, tip: `${x.ok} realizada(s), ${x.falta} falta(s)${x.ok + x.falta ? ` · faltas ${BI.pc(x.falta / (x.ok + x.falta))}` : ''}` })), { title: 'Sessões realizadas por dia e hora' }), { sub: 'Sessões realizadas por dia da semana e hora', actions: csvLink(F, 'horarios') })}
      ${BI.panel('Faltas por dia da semana', BI.hbars(wds.filter((x) => x.ok + x.falta).map((x) => ({ label: WD[x.wd], value: x.faltas || 0, sub: `${x.falta} de ${x.ok + x.falta}`, cls: 'st-bad' })), { fmt: BI.pc, share: false }), { sub: 'Taxa de faltas em cada dia' })}
      ${BI.panel('Confirmação e faltas', html`${BI.composition([
        { name: 'Confirmou pelo WhatsApp', value: n('whatsapp'), cls: 'st-ok' }, { name: 'Confirmou pelo link (e-mail/SMS)', value: n('link'), cls: 'bi-s4' },
        { name: 'Pediu para remarcar', value: n('remarcar'), cls: 'bi-s3' }, { name: 'Lembrete sem resposta', value: n('sem_resposta'), cls: 'bi-s2' }, { name: 'Sem lembrete', value: n('sem_lembrete'), cls: 'st-off' }])}
        <p class="bi-note">Faltas de quem confirmou: <b>${BI.pc(conf.confFaltas)}</b> · de quem não confirmou: <b>${BI.pc(conf.naoConfFaltas)}</b></p>`, { sub: 'Sessões já ocorridas no período' })}
      ${BI.panel('Como as sessões foram marcadas', html`${BI.hbars(via.map((x, i) => ({ label: x.label, value: x.n, sub: `antecedência ${BI.dec1(x.lead)} dias`, cls: SERIES[i % 6] })))}`, { sub: 'Sessões criadas no período, por canal' })}
      ${BI.panel('Modalidade', BI.composition([{ name: 'On-line', value: mods.online || 0, cls: 'bi-s2' }, { name: 'Presencial', value: mods.presencial || 0, cls: 'bi-s1' }]), { sub: 'Sessões realizadas' })}
    </div>`;
}

async function financeTab(F) {
  const g = R.grain(F.rg);
  const [fin, finP, rev, revP, byMethod, byOrigin, byPro, online, ag, deb, led] = await Promise.all([
    R.financeTotals(F.f, F.rg), R.financeTotals(F.f, F.prev), R.revenueSeries(F.f, F.rg, g), F.cmp ? R.revenueSeries(F.f, F.prev, g) : null,
    R.revenueBy(F.f, F.rg, 'method'), R.revenueBy(F.f, F.rg, 'origin'), F.prof ? [] : R.revenueBy(F.f, F.rg, 'pro'), R.onlineShare(F.f, F.rg), R.aging(F.f), R.debtors(F.f, 8), R.ledger(F.f, F.rg),
  ]);
  const proName2 = Object.fromEntries(F.pros.map((u) => [u.id, proName(u)]));
  const resultado = led ? fin.recebido + led.totalOutras - led.totalDesp : null;
  return html`<div class="bi-kpis">
      ${BI.kpi({ label: 'Recebido', value: BI.brl(fin.recebido), sub: `${BI.int(fin.recebidoN)} pagamento(s)`, prev: cmpOf(F, fin.recebido, finP.recebido, BI.brl), spark: rev.map((x) => x.value) })}
      ${BI.kpi({ label: 'Faturado (vencimento no período)', value: BI.brl(fin.faturado), sub: fin.conversao == null ? '' : `${BI.pc(fin.conversao)} já recebido`, prev: cmpOf(F, fin.faturado, finP.faturado, BI.brl) })}
      ${BI.kpi({ label: 'A receber (no prazo)', value: BI.brl(fin.aReceber), good: 'neutral' })}
      ${BI.kpi({ label: 'Em atraso', value: BI.brl(fin.atrasado), sub: `${fin.atrasadoPac} paciente(s)`, hint: 'situação de hoje', href: '#inadimplencia' })}
      ${BI.kpi({ label: 'Ticket médio por sessão', value: fin.ticket == null ? '—' : BI.brl(fin.ticket), prev: cmpOf(F, fin.ticket, finP.ticket, (v) => (v == null ? '—' : BI.brl(v))) })}
      ${BI.kpi({ label: 'Parte da clínica (repasse)', value: BI.brl(fin.repasseClinica), sub: `profissionais: ${BI.brl(fin.repasseProf)}`, good: 'neutral' })}
      ${BI.kpi({ label: 'Pago online', value: BI.brl(online.value), sub: online.value ? `${BI.int(online.n)} cobrança(s) · taxas ${BI.brl2(online.fees)}` : 'Asaas / Mercado Pago', good: 'neutral' })}
      ${led ? BI.kpi({ label: 'Resultado do período', value: BI.brl(resultado), sub: 'recebido + outras receitas − despesas', good: 'neutral' }) : ''}
    </div>
    ${BI.panel('Receita recebida', BI.lineCompare(rev, revP, { fmt: BI.brl, fmtAxis: BI.moneyShort, title: 'Receita recebida' }), { wide: true, sub: F.cmp ? `Linha tracejada: ${fmtRange(F.prev)}` : '', actions: csvLink(F, 'receita') })}
    <div class="bi-grid2">
      ${BI.panel('Por forma de pagamento', BI.hbars(byMethod.map((x, i) => ({ label: R.METHODS[x.key] || R.METHODS.null, value: x.value, sub: `${x.n}×`, cls: SERIES[i % 6] })), { fmt: BI.brl }))}
      ${BI.panel('Por origem', BI.hbars(byOrigin.map((x, i) => ({ label: R.ORIGINS[x.key] || x.key, value: x.value, sub: `${x.n}×`, cls: SERIES[i % 6] })), { fmt: BI.brl }))}
      ${F.prof ? '' : BI.panel('Por profissional', BI.hbars(byPro.map((x, i) => ({ label: proName2[x.key] || 'Sem profissional', value: x.value, cls: SERIES[i % 6], href: x.key ? qs(F, { prof: x.key }) : null })), { fmt: BI.brl }), { sub: 'Clique para filtrar' })}
      ${BI.panel('Inadimplência', html`${BI.hbars(ag.map((x) => ({ label: x.label, value: x.value, sub: `${x.n} lançamento(s)`, cls: 'st-bad' })), { fmt: BI.brl, empty: 'Nada em atraso. 🎉' })}
        ${deb.length ? html`<div class="bi-tblwrap"><table class="tbl small"><thead><tr><th>Paciente</th><th class="num">Em atraso</th><th class="num">Desde</th></tr></thead><tbody>${deb.map((d) => html`<tr><td><a href="/pacientes/${d.id}?aba=financeiro">${d.social_name || d.name}</a></td><td class="num">${BI.brl2(d.v)}</td><td class="num">${brDate(d.oldest)}</td></tr>`)}</tbody></table></div>${fin.atrasadoPac > deb.length ? html`<p class="muted small">Mostrando os ${deb.length} maiores de ${fin.atrasadoPac}. A lista completa está no CSV.</p>` : ''}` : ''}`, { id: 'inadimplencia', sub: 'Situação de hoje, por tempo de atraso', actions: csvLink(F, 'inadimplentes') })}
      ${led ? BI.panel('Despesas por categoria', BI.hbars(led.despesas.map((x, i) => ({ label: x.label, value: x.value, cls: SERIES[i % 6] })), { fmt: BI.brl, empty: 'Nenhuma despesa paga no período.' }), { sub: F.prof ? 'Despesas do profissional' : 'Despesas da clínica (Financeiro → lançamentos)' }) : ''}
      ${led ? BI.panel('Resultado (DRE simplificado)', html`<table class="tbl bi-dre"><tbody>
          <tr><td>Recebido de pacientes</td><td class="num">${BI.brl2(fin.recebido)}</td></tr>
          ${led.outras.map((x) => html`<tr><td>+ ${x.label}</td><td class="num">${BI.brl2(x.value)}</td></tr>`)}
          ${led.despesas.map((x) => html`<tr><td>− ${x.label}</td><td class="num neg">${BI.brl2(x.value)}</td></tr>`)}
          <tr class="tot"><td>Resultado</td><td class="num ${resultado < 0 ? 'neg' : ''}">${BI.brl2(resultado)}</td></tr>
          <tr><td class="muted">Margem</td><td class="num muted">${fin.recebido + led.totalOutras ? BI.pc(resultado / (fin.recebido + led.totalOutras)) : '—'}</td></tr></tbody></table>`, { sub: 'Pelo que foi efetivamente pago e recebido no período' }) : ''}
    </div>`;
}

const LOT_ST = { gerado: 'Gerado, falta enviar', enviado: 'Enviado, sem análise', analisado: 'Analisado, sem pagamento' };
async function insurersTab(F) {
  const g = R.grain(F.rg);
  const [t, tP, rows, ser, why, lots] = await Promise.all([IR.totals(F.f, F.rg), IR.totals(F.f, F.prev), IR.byInsurer(F.f, F.rg), IR.series(F.f, F.rg, g), IR.glosaReasons(F.f, F.rg), IR.pendingLots(F.f)]);
  const days = (d) => (d == null ? '—' : `${Math.round(d)} dias`);
  return html`<div class="bi-kpis">
      ${BI.kpi({ label: 'Sessões por convênio', value: BI.int(t.sessoes), sub: t.share == null ? '' : `${BI.pc(t.share)} das sessões realizadas`, prev: cmpOf(F, t.sessoes, tP.sessoes, BI.int) })}
      ${BI.kpi({ label: 'Faturado', value: BI.brl(t.faturado), sub: `${BI.int(t.faturadoN)} sessão(ões) em lote`, prev: cmpOf(F, t.faturado, tP.faturado, BI.brl) })}
      ${BI.kpi({ label: 'Glosado', value: BI.brl(t.glosado), sub: t.taxaGlosa == null ? 'sem análise da operadora ainda' : `${BI.pc(t.taxaGlosa)} do analisado · ${BI.int(t.glosadoN)} sessão(ões)`, prev: cmpOf(F, t.glosado, tP.glosado, BI.brl), good: 'down', href: '#glosas' })}
      ${BI.kpi({ label: 'Recebido das operadoras', value: BI.brl(t.recebido), prev: cmpOf(F, t.recebido, tP.recebido, BI.brl), spark: ser.map((x) => x.recebido) })}
      ${BI.kpi({ label: 'Recuperado em recurso', value: BI.brl(t.recuperado), sub: t.recorrido ? `de ${BI.brl(t.recorrido)} recorrido(s)` : 'recebido no período', good: 'neutral' })}
      ${BI.kpi({ label: 'A faturar', value: BI.brl(t.aFaturar), sub: `${BI.int(t.aFaturarN)} sessão(ões) fora de lote`, hint: 'situação de hoje', good: 'neutral', href: '/financeiro/convenios' })}
      ${BI.kpi({ label: 'Aguardando a operadora', value: BI.brl(t.aguardando), sub: `${BI.int(t.aguardandoLotes)} lote(s) sem pagamento`, hint: 'situação de hoje', good: 'neutral', href: '#lotes-parados' })}
      ${BI.kpi({ label: 'Prazo médio de recebimento', value: days(t.prazo), sub: t.prazoN ? `do envio ao pagamento · ${t.prazoN} lote(s)` : 'nenhum lote pago no período', prev: cmpOf(F, t.prazo, tP.prazo, days), good: 'down' })}
    </div>
    ${BI.panel('Faturado, glosado e recebido', BI.stacked(ser.map((x) => ({ label: x.label, full: x.full, 'st-ok': x.liberado, 'st-bad': x.glosa })), [{ key: 'st-ok', name: 'Faturado sem glosa', cls: 'st-ok' }, { key: 'st-bad', name: 'Glosado', cls: 'st-bad' }], { fmt: BI.brl, title: 'Faturado por data da sessão' }), { wide: true, sub: 'Pela data da sessão. O recebido está na linha abaixo (pela data do depósito).', actions: csvLink(F, 'convenios') })}
    ${BI.panel('Recebido das operadoras', BI.lineCompare(ser.map((x) => ({ label: x.label, full: x.full, value: x.recebido })), null, { fmt: BI.brl, fmtAxis: BI.moneyShort, title: 'Recebido das operadoras' }), { wide: true })}
    ${BI.panel('Por operadora', rows.length ? html`<div class="bi-tblwrap"><table class="tbl small" id="por-operadora"><thead><tr><th>Convênio</th><th class="num">Sessões</th><th class="num">Faturado</th><th class="num">Glosado</th><th class="num">% glosa</th><th class="num">Recebido</th><th class="num">A faturar</th><th class="num">Aguardando</th><th class="num">Prazo</th><th class="num">Recurso</th></tr></thead>
      <tbody>${rows.map((x) => html`<tr data-ins="${x.id}"><td>${x.name}</td><td class="num">${BI.int(x.sessoes)}</td><td class="num">${BI.brl(x.faturado)}</td><td class="num">${x.glosado ? html`<span class="err-txt">${BI.brl(x.glosado)}</span>` : '—'}</td><td class="num">${BI.pc(x.taxaGlosa)}</td><td class="num">${BI.brl(x.recebido)}</td>
        <td class="num">${x.aFaturar ? html`${BI.brl(x.aFaturar)} <small class="muted">(${x.aFaturarN})</small>` : '—'}</td><td class="num">${x.aguardando ? BI.brl(x.aguardando) : '—'}</td><td class="num">${days(x.prazo)}</td><td class="num">${x.recorrido ? html`${BI.brl(x.recuperado)} <small class="muted">de ${BI.brl(x.recorrido)}</small>` : '—'}</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">Nenhuma sessão por convênio no período.</p>`,
      { wide: true, id: 'operadoras', sub: 'Faturado e glosado pela data da sessão; recebido pela data do depósito; a faturar e aguardando são a situação de hoje', actions: csvLink(F, 'convenios') })}
    <div class="bi-grid2">
      ${BI.panel('Recebido por convênio', BI.hbars(rows.filter((x) => x.recebido).sort((a, b) => b.recebido - a.recebido).map((x, i) => ({ label: x.name, value: x.recebido, cls: SERIES[i % 6] })), { fmt: BI.brl, empty: 'Nada recebido das operadoras no período.' }))}
      ${BI.panel('Glosas por motivo', BI.hbars(why.map((x) => ({ label: x.label, value: x.value, sub: `${x.n}×`, cls: 'st-bad' })), { fmt: BI.brl, empty: 'Nenhuma glosa no período. 🎉' }), { id: 'glosas', sub: 'Códigos da tabela de glosas da ANS', actions: csvLink(F, 'glosas') })}
      ${BI.panel('Particular × convênio', BI.composition([{ name: 'Convênio', value: t.sessoes, cls: 'bi-s1' }, { name: 'Particular', value: Math.max(0, t.realizadas - t.sessoes), cls: 'bi-s3' }]), { sub: 'Sessões realizadas no período' })}
      ${BI.panel('Lotes parados', lots.length ? html`<div class="bi-tblwrap"><table class="tbl small"><thead><tr><th>Lote</th><th>Situação</th><th class="num">Valor</th><th class="num">Há</th></tr></thead><tbody>${lots.map((b) => html`<tr class="${b.dias > 45 ? 'warn' : ''}"><td><a href="/financeiro/convenios/lote/${b.id}">${b.insurer} nº ${b.lot_number}</a></td><td>${LOT_ST[b.status]}</td><td class="num">${BI.brl(b.status === 'analisado' ? b.released : b.total)}</td><td class="num ${b.dias > 45 ? 'err-txt' : ''}">${b.dias} dias</td></tr>`)}</tbody></table></div>` : html`<p class="muted small">Nenhum lote parado. 🎉</p>`, { id: 'lotes-parados', sub: 'Situação de hoje, do mais antigo para o mais novo' })}
    </div>`;
}

async function patientsTab(F) {
  const endYm = F.rg.to.slice(0, 7) > todayLocal().slice(0, 7) ? todayLocal().slice(0, 7) : F.rg.to.slice(0, 7);
  const [pat, patP, risk, riskN, coh] = await Promise.all([R.patientStats(F.f, F.rg), R.patientStats(F.f, F.prev), R.atRisk(F.f), R.atRiskCount(F.f), R.cohorts(F.f, endYm)]);
  const STAT = { ativo: 'Ativos', pausa: 'Em pausa', alta: 'Alta', inativo: 'Inativos' };
  const m1 = coh.filter((x) => x.size && x.cells[0] != null);
  const ret1 = m1.length ? m1.reduce((a, x) => a + x.cells[0] * x.size, 0) / m1.reduce((a, x) => a + x.size, 0) : null;
  const m3 = coh.filter((x) => x.size && x.cells[2] != null);
  const ret3 = m3.length ? m3.reduce((a, x) => a + x.cells[2] * x.size, 0) / m3.reduce((a, x) => a + x.size, 0) : null;
  return html`<div class="bi-kpis">
      ${BI.kpi({ label: 'Pacientes atendidos', value: BI.int(pat.ativos), sub: 'com sessão realizada no período', prev: cmpOf(F, pat.ativos, patP.ativos, BI.int) })}
      ${BI.kpi({ label: 'Novos pacientes', value: BI.int(pat.novos), sub: '1ª sessão no período', prev: cmpOf(F, pat.novos, patP.novos, BI.int) })}
      ${BI.kpi({ label: 'Continuam 1 mês depois', value: BI.pc(ret1), sub: 'média dos últimos 12 meses' })}
      ${BI.kpi({ label: 'Continuam 3 meses depois', value: BI.pc(ret3), sub: 'média dos últimos 12 meses' })}
      ${BI.kpi({ label: 'Em risco de abandono', value: BI.int(riskN), sub: '30+ dias sem sessão e nada agendado', href: '#em-risco' })}
      ${BI.kpi({ label: 'Sessões por paciente', value: pat.mediaSessoes == null ? '—' : BI.dec1(pat.mediaSessoes), sub: 'média histórica' })}
      ${BI.kpi({ label: 'Tempo de acompanhamento', value: days(pat.mediaDias), sub: 'da 1ª à última sessão (média)' })}
      ${BI.kpi({ label: 'Receita média por paciente', value: pat.ltv == null ? '—' : BI.brl(pat.ltv), sub: 'valor total recebido (LTV)' })}
    </div>
    ${BI.panel('Retenção por mês de início', BI.cohortTable(coh, (ym) => monthName(ym)), { wide: true, sub: 'De cada grupo que começou num mês, quantos ainda tiveram sessão N meses depois', actions: csvLink(F, 'coortes') })}
    <div class="bi-grid2">
      ${BI.panel('Como os novos pacientes chegaram', BI.hbars(Object.entries(pat.origem).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ label: R.VIA[k] || k, value: v, cls: SERIES[i % 6] })), { empty: 'Nenhum paciente novo no período.' }), { sub: 'Canal da 1ª sessão marcada' })}
      ${BI.panel('Sessões por paciente', BI.hbars(Object.entries(pat.dist).map(([k, v]) => ({ label: `${k} sessão${k === '1' ? '' : 'ões'}`, value: v, cls: 'bi-s1' }))), { sub: 'Total histórico de sessões realizadas' })}
      ${BI.panel('Faixa etária', BI.hbars(Object.entries(pat.faixas).filter(([, v]) => v).map(([k, v]) => ({ label: k === 'sem data' ? 'Sem data de nascimento' : `${k} anos`, value: v, cls: k === 'sem data' ? 'st-off' : 'bi-s2' }))), { sub: 'Pacientes atendidos no período' })}
      ${BI.panel('Situação dos cadastros', BI.composition(Object.entries(STAT).map(([k, l], i) => ({ name: l, value: pat.status[k] || 0, cls: ['st-ok', 'bi-s3', 'bi-s2', 'st-off'][i] }))), { sub: `${BI.int(pat.totalPacientes)} paciente(s) cadastrados` })}
    </div>
    ${BI.panel('Pacientes em risco de abandono', risk.length ? html`<div class="bi-tblwrap"><table class="tbl small"><thead><tr><th>Paciente</th><th class="num">Última sessão</th><th class="num">Sessões</th><th></th></tr></thead><tbody>${risk.map((p) => html`<tr><td><a href="/pacientes/${p.id}">${p.social_name || p.name}</a></td><td class="num">${brDate(p.last)}</td><td class="num">${p.n}</td><td class="num"><a class="link small" href="/agenda/nova?paciente=${p.id}">Agendar</a></td></tr>`)}</tbody></table></div>` : html`<p class="muted small">Nenhum paciente ativo está há mais de 30 dias sem sessão. 🎉</p>`, { id: 'em-risco', wide: true, sub: 'Situação de hoje · status “ativo”, mais de 30 dias sem sessão e nada agendado', actions: csvLink(F, 'em_risco') })}`;
}

async function prosTab(F) {
  const rows = await R.professionals(F.f, F.rg);
  const tot = rows.reduce((a, x) => ({ ok: a.ok + x.ok, falta: a.falta + x.falta, canc: a.canc + x.canc, total: a.total + x.total, pac: a.pac + x.pac, novos: a.novos + x.novos, receita: a.receita + x.receita, clinica: a.clinica + x.clinica }), { ok: 0, falta: 0, canc: 0, total: 0, pac: 0, novos: 0, receita: 0, clinica: 0 });
  return html`${BI.panel('Desempenho por profissional', rows.length ? html`<div class="bi-tblwrap"><table class="tbl small bi-pros"><thead><tr><th>Profissional</th><th class="num">Sessões</th><th class="num">Pacientes</th><th class="num">Novos</th><th class="num">Faltas</th><th class="num">Cancel.</th><th class="num">Ocupação</th><th class="num">Receita</th><th class="num">Ticket</th><th class="num">Parte da clínica</th></tr></thead>
      <tbody>${rows.map((x) => html`<tr><td><a href="${qs(F, { prof: x.id, aba: 'visao' })}">${proName(x)}</a></td><td class="num">${BI.int(x.ok)}</td><td class="num">${BI.int(x.pac)}</td><td class="num">${BI.int(x.novos)}</td><td class="num">${BI.pc(x.faltas)}</td><td class="num">${BI.pc(x.cancel)}</td><td class="num">${x.ocupacao == null ? '—' : BI.pc(x.ocupacao)}</td><td class="num">${BI.brl(x.receita)}</td><td class="num">${x.ticket == null ? '—' : BI.brl(x.ticket)}</td><td class="num">${BI.brl(x.clinica)}</td></tr>`)}</tbody>
      <tfoot><tr><td>Total</td><td class="num">${BI.int(tot.ok)}</td><td class="num">${BI.int(tot.pac)}</td><td class="num">${BI.int(tot.novos)}</td><td class="num">${BI.pc(tot.ok + tot.falta ? tot.falta / (tot.ok + tot.falta) : null)}</td><td class="num">${BI.pc(tot.total ? tot.canc / tot.total : null)}</td><td class="num"></td><td class="num">${BI.brl(tot.receita)}</td><td class="num">${tot.ok ? BI.brl(tot.receita / tot.ok) : '—'}</td><td class="num">${BI.brl(tot.clinica)}</td></tr></tfoot></table></div>` : html`<p class="muted small">Sem atendimentos no período.</p>`, { wide: true, sub: 'Clique no nome para ver os relatórios só daquele profissional', actions: csvLink(F, 'profissionais') })}
    <div class="bi-grid2">
      ${BI.panel('Sessões realizadas', BI.hbars(rows.map((x, i) => ({ label: proName(x), value: x.ok, cls: SERIES[i % 6] }))))}
      ${BI.panel('Receita recebida', BI.hbars(rows.map((x, i) => ({ label: proName(x), value: x.receita, cls: SERIES[i % 6] })), { fmt: BI.brl }))}
    </div>`;
}

async function captureTab(F) {
  const [fu, pat] = await Promise.all([R.funnel(F.f, F.rg), R.patientStats(F.f, F.rg)]);
  return html`<div class="bi-kpis">
      ${BI.kpi({ label: 'Novos contatos no CRM', value: BI.int(fu.crm.contatos), sub: 'cards criados no período' })}
      ${BI.kpi({ label: 'Conversas com o atendente virtual', value: BI.int(fu.agente.conversas), sub: `${BI.int(fu.agente.agendamentos)} sessão(ões) marcada(s) por ele` })}
      ${BI.kpi({ label: 'Agendamentos pelo site', value: BI.int(fu.online.agendados), sub: `de ${BI.int(fu.online.iniciados)} iniciado(s)` })}
      ${BI.kpi({ label: 'Cliques no WhatsApp do site', value: BI.int(fu.site.cliques), sub: `${BI.int(fu.site.assistente)} para o assistente` })}
      ${BI.kpi({ label: 'Lista de espera', value: BI.int(fu.lista.entradas), sub: `${BI.int(fu.lista.agendados)} conseguiram horário` })}
      ${BI.kpi({ label: 'Novos pacientes', value: BI.int(pat.novos), sub: '1ª sessão no período' })}
    </div>
    <div class="bi-grid2">
      ${BI.panel('Funil do CRM (WhatsApp)', BI.funnel([{ label: 'Novos contatos', value: fu.crm.contatos }, { label: 'Marcaram sessão', value: fu.crm.agendaram }, { label: 'Compareceram', value: fu.crm.compareceram }]), { sub: 'Contatos que chegaram no período e o que aconteceu depois' })}
      ${BI.panel('Agendamento online (site)', BI.funnel([{ label: 'Começaram a agendar', value: fu.online.iniciados }, { label: 'Confirmaram o código', value: fu.online.agendados }]))}
      ${BI.panel('Atendente virtual', BI.funnel([{ label: 'Conversas iniciadas', value: fu.agente.conversas }, { label: 'Sessões marcadas', value: fu.agente.agendamentos }]))}
      ${BI.panel('Lista de espera', BI.funnel([{ label: 'Entraram na lista', value: fu.lista.entradas }, { label: 'Conseguiram horário', value: fu.lista.agendados }]))}
      ${BI.panel('Sessões marcadas por canal', BI.hbars(fu.via.map((x, i) => ({ label: x.label, value: x.n, cls: SERIES[i % 6] }))), { sub: 'Todas as sessões criadas no período' })}
      ${BI.panel('Novos pacientes por canal', BI.hbars(Object.entries(pat.origem).sort((a, b) => b[1] - a[1]).map(([k, v], i) => ({ label: R.VIA[k] || k, value: v, cls: SERIES[i % 6] })), { empty: 'Nenhum paciente novo no período.' }))}
    </div>`;
}

async function satisfactionTab(F, req) {
  const [S, SP, cfg] = await Promise.all([Engage.results(F.f, F.rg), Engage.results(F.f, F.prev), Engage.config()]);
  const proName2 = Object.fromEntries(F.pros.map((u) => [u.id, proName(u)]));
  const npsTxt = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}`);
  const grp = (n) => (n >= 9 ? 'st-ok' : n >= 7 ? 'bi-s3' : 'st-bad');
  const distRows = [...Array(11).keys()].map((n) => ({ label: String(n), full: `Nota ${n}`, v: S.dist[n] || 0 }));
  const back = `/relatorios${qs(F, {})}#comentarios`;
  return html`${!cfg.surveyOn ? html`<div class="flash warn">A pesquisa de satisfação está desligada. <a href="/configuracoes/pesquisa">Ligar em Configurações</a>.</div>` : ''}
    <div class="bi-kpis">
      ${BI.kpi({ label: 'NPS', value: npsTxt(S.nps), sub: '% promotores − % detratores (−100 a +100)', prev: F.cmp && S.nps != null && SP.nps != null ? { show: true, cur: S.nps / 100, prev: SP.nps / 100, prevTxt: npsTxt(SP.nps) } : null, fmtDelta: 'pp' })}
      ${BI.kpi({ label: 'Nota média', value: S.avg == null ? '—' : BI.dec1(S.avg), sub: 'de 0 a 10', prev: cmpOf(F, S.avg, SP.avg, (v) => (v == null ? '—' : BI.dec1(v))) })}
      ${BI.kpi({ label: 'Respostas', value: BI.int(S.answered), sub: `de ${BI.int(S.sent)} pesquisa(s) enviada(s)`, prev: cmpOf(F, S.answered, SP.answered, BI.int) })}
      ${BI.kpi({ label: 'Taxa de resposta', value: BI.pc(S.rate), prev: cmpOf(F, S.rate, SP.rate, BI.pc), fmtDelta: 'pp' })}
      ${cfg.reviewOn ? BI.kpi({ label: 'Clicaram para avaliar no Google', value: BI.int(S.reviews), good: 'neutral' }) : ''}
    </div>
    <div class="bi-grid2">
      ${BI.panel('Promotores, neutros e detratores', BI.composition([{ name: 'Promotores (9–10)', value: S.promoters, cls: 'st-ok' }, { name: 'Neutros (7–8)', value: S.passives, cls: 'bi-s3' }, { name: 'Detratores (0–6)', value: S.detractors, cls: 'st-bad' }]), { sub: 'Respostas no período' })}
      ${BI.panel('Notas', S.answered ? BI.stacked(distRows.map((x) => ({ ...x, [grp(Number(x.label))]: x.v })), [{ key: 'st-bad', name: 'Detratores', cls: 'st-bad' }, { key: 'bi-s3', name: 'Neutros', cls: 'bi-s3' }, { key: 'st-ok', name: 'Promotores', cls: 'st-ok' }], { title: 'Distribuição das notas' }) : html`<p class="muted small">Nenhuma resposta no período.</p>`, { sub: 'Quantas respostas para cada nota' })}
      ${S.series.length > 1 ? BI.panel('NPS por mês', BI.hbars(S.series.map((x) => ({ label: monthName(x.k.slice(0, 7)), value: Math.max(0, x.nps ?? 0), sub: `${x.n} resposta(s) · NPS ${npsTxt(x.nps)}`, cls: (x.nps ?? 0) >= 50 ? 'st-ok' : (x.nps ?? 0) >= 0 ? 'bi-s3' : 'st-bad' })), { fmt: (v) => npsTxt(v), share: false })) : ''}
      ${!F.prof && S.byPro.length ? BI.panel('Por profissional', html`<div class="bi-tblwrap"><table class="tbl small"><thead><tr><th>Profissional</th><th class="num">Respostas</th><th class="num">Média</th><th class="num">NPS</th></tr></thead><tbody>${S.byPro.map((x) => html`<tr><td>${proName2[x.u] || '—'}</td><td class="num">${x.n}</td><td class="num">${BI.dec1(x.avg)}</td><td class="num">${npsTxt(x.nps)}</td></tr>`)}</tbody></table></div>`) : ''}
    </div>
    ${BI.panel('Comentários', S.recent.length ? html`<ul class="sv-list">${S.recent.map((x) => html`<li class="${x.score <= 6 ? 'lo' : x.score >= 9 ? 'hi' : 'mid'}">
        <span class="sv-score ${grp(x.score)}">${x.score}</span>
        <div><p><a href="/pacientes/${x.patient_id}">${x.social_name || x.name}</a> <small class="muted">· ${brDate(x.answered_at)}</small></p>${x.comment ? html`<p class="sv-c">“${x.comment}”</p>` : html`<p class="muted small">sem comentário</p>`}
          ${x.score <= cfg.alertMax ? (x.followup_at ? html`<p class="small muted">✓ Tratado${x.fname ? ` por ${x.fname}` : ''} em ${brDate(x.followup_at)}</p>` : html`<form method="post" action="/relatorios/satisfacao/${x.id}/tratado" class="inline"><input type="hidden" name="back" value="${back}"><button class="btn ghost btn-sm">Marcar como tratado</button></form>`) : ''}</div></li>`)}</ul>` : html`<p class="muted small">Nenhuma resposta no período.</p>`, { id: 'comentarios', wide: true, sub: 'Notas baixas ainda não tratadas aparecem primeiro' })}`;
}

r.get('/', async (req, res) => {
  const F = await filtersOf(req);
  const body = F.tab === 'agenda' ? await agendaTab(F) : F.tab === 'financeiro' ? await financeTab(F) : F.tab === 'convenios' ? await insurersTab(F) : F.tab === 'pacientes' ? await patientsTab(F)
    : F.tab === 'profissionais' && !F.mine ? await prosTab(F) : F.tab === 'captacao' ? await captureTab(F) : F.tab === 'satisfacao' ? await satisfactionTab(F, req) : await overview(F);
  const proLbl = F.prof ? proName(F.pros.find((u) => u.id === F.prof) || req.user) : 'Toda a clínica';
  send(res, page(req, {
    title: 'Relatórios', active: 'relatorios',
    body: html`<header class="ph"><div><p class="eyebrow">Relatórios gerenciais · BI</p><h1>${TABS[F.tab]}</h1>
      <p class="muted bi-period">${fmtRange(F.rg)}${F.cmp ? html` <span>· comparado com ${fmtRange(F.prev)}</span>` : ''} · ${proLbl}${F.mod ? ` · ${F.mod === 'online' ? 'on-line' : 'presencial'}` : ''}</p></div>
      <div class="ph-actions"><button type="button" class="btn ghost" data-print>Imprimir / PDF</button></div></header>
    ${filterBar(F)}${tabsNav(F)}
    <div class="bi" data-bi>${body}</div>
    <p class="muted small bi-foot">Números calculados com os dados do sistema na hora da consulta. “Situação de hoje” não depende do período escolhido.</p>`,
  }));
});

// ---------- exportação CSV (abre no Excel) ----------
const csvCell = (v) => { const s = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v); return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
r.get('/csv', async (req, res) => {
  const F = await filtersOf(req);
  const g = R.grain(F.rg); let head; let rows;
  switch (req.query.ds) {
    case 'sessoes': head = ['Período', 'Início', 'Realizadas', 'Agendadas', 'Faltas', 'Canceladas'];
      rows = (await R.agendaSeries(F.f, F.rg, g)).map((x) => [x.full, x.k, x.realizada, x.agendada, x.falta, x.cancelada]); break;
    case 'receita': head = ['Período', 'Início', 'Recebido (R$)'];
      rows = (await R.revenueSeries(F.f, F.rg, g)).map((x) => [x.full, x.k, x.value]); break;
    case 'horarios': head = ['Dia da semana', 'Hora', 'Realizadas', 'Faltas', 'Marcadas (sem canceladas)'];
      rows = (await R.heat(F.f, F.rg)).sort((a, b) => a.wd - b.wd || a.h - b.h).map((x) => [WD[x.wd], `${x.h}h`, x.ok, x.falta, x.n]); break;
    case 'profissionais': head = ['Profissional', 'Sessões realizadas', 'Pacientes', 'Novos', 'Faltas (%)', 'Cancelamentos (%)', 'Ocupação (%)', 'Receita (R$)', 'Ticket (R$)', 'Parte da clínica (R$)'];
      rows = F.mine ? [] : (await R.professionals(F.f, F.rg)).map((x) => [proName(x), x.ok, x.pac, x.novos, x.faltas == null ? '' : +(x.faltas * 100).toFixed(1), x.cancel == null ? '' : +(x.cancel * 100).toFixed(1), x.ocupacao == null ? '' : +(x.ocupacao * 100).toFixed(1), x.receita, x.ticket == null ? '' : +x.ticket.toFixed(2), x.clinica]); break;
    case 'inadimplentes': head = ['Paciente', 'Em atraso (R$)', 'Lançamentos', 'Vencimento mais antigo'];
      rows = (await R.debtors(F.f, 1000)).map((d) => [d.social_name || d.name, Number(d.v), d.n, String(d.oldest).slice(0, 10)]); break;
    case 'em_risco': head = ['Paciente', 'Última sessão', 'Sessões realizadas'];
      rows = (await R.atRisk(F.f, 30, 1000)).map((p) => [p.social_name || p.name, String(p.last).slice(0, 10), p.n]); break;
    case 'coortes': { const coh = await R.cohorts(F.f, todayLocal().slice(0, 7)); head = ['Mês de início', 'Pacientes', ...coh[0].cells.map((_, k) => `${k + 1}º mês (%)`)];
      rows = coh.map((c) => [c.ym, c.size, ...c.cells.map((v) => (v == null ? '' : +(v * 100).toFixed(1)))]); break; }
    case 'convenios': head = ['Convênio', 'Sessões', 'Faturado (R$)', 'Liberado (R$)', 'Glosado (R$)', 'Glosa (%)', 'Recebido (R$)', 'A faturar (R$)', 'Sessões a faturar', 'Aguardando (R$)', 'Prazo médio (dias)', 'Recorrido (R$)', 'Recuperado (R$)'];
      rows = (await IR.byInsurer(F.f, F.rg)).map((x) => [x.name, x.sessoes, x.faturado, x.liberado, x.glosado, x.taxaGlosa == null ? '' : +(x.taxaGlosa * 100).toFixed(1), x.recebido, x.aFaturar, x.aFaturarN, x.aguardando, x.prazo == null ? '' : Math.round(x.prazo), x.recorrido, x.recuperado]); break;
    case 'glosas': head = ['Data da sessão', 'Paciente', 'Convênio', 'Lote', 'Guia', 'Cobrado (R$)', 'Liberado (R$)', 'Glosa (R$)', 'Código', 'Motivo', 'Recurso', 'Recorrido (R$)', 'Recuperado (R$)'];
      rows = (await IR.glosaList(F.f, F.rg)).map((x) => [String(x.starts_at instanceof Date ? x.starts_at.toISOString() : x.starts_at).slice(0, 10), x.social_name || x.name, x.insurer, x.lot_number, x.guide_number, Number(x.cobrado), Number(x.released), Number(x.glosa), x.glosa_code || '', x.glosa_note || '', x.appeal_number ? `nº ${x.appeal_number} (${x.appeal_status})` : '', x.appeal_value == null ? '' : Number(x.appeal_value), x.recovered == null ? '' : Number(x.recovered)]); break;
    default: return res.status(404).send('Relatório não encontrado.');
  }
  await audit(req, 'relatorio-csv', `${req.query.ds} ${F.rg.from}..${F.rg.to}${F.prof ? ` prof:${F.prof}` : ''}`);
  const name = `relatorio-${req.query.ds}-${F.rg.from}-a-${F.rg.to}.csv`;
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${name}"` });
  res.send(`﻿${[head, ...rows].map((row) => row.map(csvCell).join(';')).join('\r\n')}\r\n`);
});

export default r;
