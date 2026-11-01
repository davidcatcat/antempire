/** Port of sim/test_scaling.cjs: 14 / 100 / 1000 workers, conservation and every worker tasked. */
import { performance } from 'node:perf_hooks';
import { simulateDay } from '../engine/index.ts';
import { bundle, fixture } from './lib/harness.ts';

const original = fixture(), p = bundle(), rows = [];
for (const size of [14, 100, 1000]) {
  const s = structuredClone(original); s.population.workers = [];
  for (let i = 0; i < size; i++) {
    const w = structuredClone(original.population.workers[i % 14]); w.id = 'W' + String(i + 4).padStart(3, '0'); w.known_sources = i % 14 === 1 ? ['F01'] : i % 14 === 2 ? ['F11'] : i % 14 === 7 ? ['F07'] : []; s.population.workers.push(w);
  }
  s.next_worker_number = size + 4; for (const src of Object.values(s.sources)) { src.known_by = s.population.workers.filter((w) => w.known_sources.includes(src.id)).map((w) => w.id); }
  s.colony.sugar += Math.max(0, size - 14) * 0.5; s.colony.protein += Math.max(0, size - 14) * 0.05;
  const t = performance.now(); const out = simulateDay(s, p); const elapsed = performance.now() - t;
  const pop = out.summary.population;
  if (pop.workers + out.summary.worker_deaths !== size + out.summary.eclosions) throw Error('Conservation not met at ' + size);
  const allTasked = Object.values(out.summary.tasks).reduce((a, b) => a + b, 0) === size;
  if (!allTasked) throw Error('Not every worker received a task at ' + size);
  rows.push({ workers_before: size, workers_after: pop.workers, ms: Math.round(elapsed), all_workers_tasked: allTasked, events: out.events.length });
}
// v6 reference (reports/scaling-smoke.json, timings excluded): 14->14 (18 events), 100->100 (150), 1000->999 (1021).
const expected = [[14, 14, 18], [100, 100, 150], [1000, 999, 1021]];
const same = rows.every((r, i) => r.workers_before === expected[i][0] && r.workers_after === expected[i][1] && r.events === expected[i][2]);
console.log(JSON.stringify({ rows, matches_v6_reference: same }, null, 2));
if (!same) process.exitCode = 1;
