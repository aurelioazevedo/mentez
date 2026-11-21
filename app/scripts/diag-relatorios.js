// Diagnóstico: roda as consultas da aba Agenda e presença numa clínica e mostra qual falha (uso: node scripts/diag-relatorios.js <endereco>)
import * as T from '../lib/tenancy.js';
import * as R from '../lib/reports.js';
const t = await T.bySlug(process.argv[2]);
await T.run(t, async () => {
  const rg = R.range('12m'); const f = { prof: null, mod: null, clinic: true };
  for (const [n, fn] of [['agendaTotals', () => R.agendaTotals(f, rg)], ['agendaSeries', () => R.agendaSeries(f, rg, R.grain(rg))], ['heat', () => R.heat(f, rg)], ['weekdayStats', () => R.weekdayStats(f, rg)], ['confirmations', () => R.confirmations(f, rg)], ['originOfBookings', () => R.originOfBookings(f, rg)], ['modalitySplit', () => R.modalitySplit(f, rg)], ['occupancy', () => R.occupancy(f, rg, [])]]) {
    try { await fn(); console.log(`DIAG ok ${n}`); } catch (e) { console.log(`DIAG ERRO ${n}: ${e.message}`); }
  }
});
process.exit(0);
