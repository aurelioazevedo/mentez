// Diagnóstico: roda as consultas da aba Agenda e presença numa clínica e mostra qual falha (uso: node scripts/diag-relatorios.js <endereco>)
import * as T from '../lib/tenancy.js';
import * as R from '../lib/reports.js';
import * as IR from '../lib/insreports.js';
const t = await T.bySlug(process.argv[2]);
await T.run(t, async () => {
  const rg = R.range('12m'); const f = { prof: null, mod: null, clinic: true };
  for (const [n, fn] of [['agendaTotals', () => R.agendaTotals(f, rg)], ['agendaSeries', () => R.agendaSeries(f, rg, R.grain(rg))], ['heat', () => R.heat(f, rg)], ['weekdayStats', () => R.weekdayStats(f, rg)], ['confirmations', () => R.confirmations(f, rg)], ['originOfBookings', () => R.originOfBookings(f, rg)], ['modalitySplit', () => R.modalitySplit(f, rg)], ['occupancy', () => R.occupancy(f, rg, [])], ['financeTotals', () => R.financeTotals(f, rg)], ['revenueSeries', () => R.revenueSeries(f, rg, R.grain(rg))], ['revenueBy method', () => R.revenueBy(f, rg, 'method')], ['revenueBy origin', () => R.revenueBy(f, rg, 'origin')], ['revenueBy pro', () => R.revenueBy(f, rg, 'pro')], ['onlineShare', () => R.onlineShare(f, rg)], ['aging', () => R.aging(f)], ['debtors', () => R.debtors(f, 8)], ['ledger', () => R.ledger(f, rg)], ['expenseSeries', () => R.expenseSeries(f, rg, R.grain(rg))], ['patientStats', () => R.patientStats(f, rg)], ['atRisk', () => R.atRisk(f)], ['atRiskCount', () => R.atRiskCount(f)], ['cohorts', () => R.cohorts(f, rg.to.slice(0, 7))], ['professionals', () => R.professionals(f, rg)], ['funnel', () => R.funnel(f, rg)], ['ins totals', () => IR.totals(f, rg)], ['ins byInsurer', () => IR.byInsurer(f, rg)], ['ins series', () => IR.series(f, rg, R.grain(rg))], ['ins glosaReasons', () => IR.glosaReasons(f, rg)], ['ins pendingLots', () => IR.pendingLots(f)], ['ins glosaList', () => IR.glosaList(f, rg)]]) {
    try { await fn(); console.log(`DIAG ok ${n}`); } catch (e) { console.log(`DIAG ERRO ${n}: ${e.message}`); }
  }
});
process.exit(0);
