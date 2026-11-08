/**
 * WP5b comparison report (NOT a test, NOT engine): prints the individual vs cohort vs mixed table used in
 * docs/od1b-cohort-life-time.md §6. Usage: node prototypes/mixed-precision/lifetime-report.ts (20 fixed seeds)
 * Every input is a synthetic game assumption (lifetime-compare.ts SYNTH); the table is model output, not biology.
 */
import { compare, SCENARIOS, MODES } from './lifetime-compare.ts';

const n = 20;
const seeds = Array.from({ length: n }, (_, i) => `wp5b-seed-${i + 1}`);
const rows = compare(SCENARIOS, seeds);
const f = (x: number | null, d = 1) => (x === null ? '—' : x.toFixed(d));
console.log(`seeds: ${n} (${seeds[0]} … ${seeds[n - 1]}); cell = mean [relative error vs individual; z = diff / SE]`);
for (const sc of SCENARIOS) {
  console.log(`\n### ${sc.name} (${sc.days} d, inflow ${sc.inflow}/d)\n`);
  console.log(`| metric | ${MODES.join(' | ')} |`);
  console.log(`|---|${MODES.map(() => '---').join('|')}|`);
  const metrics = [...new Set(rows.filter((r) => r.scenario === sc.name).map((r) => r.metric))];
  for (const m of metrics) {
    const cells = MODES.map((mode) => {
      const r = rows.find((x) => x.scenario === sc.name && x.metric === m && x.mode === mode)!;
      if (mode === 'individual') return `${f(r.mean, 2)} ± ${f(r.sd, 2)}`;
      return `${f(r.mean, 2)} [${r.rel_err === null ? '—' : (r.rel_err * 100).toFixed(0) + '%'}; ${f(r.z, 1)}]`;
    });
    console.log(`| ${m} | ${cells.join(' | ')} |`);
  }
}
