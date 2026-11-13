/**
 * #189 / #193 ruling 11 — A/B experiment: follower after a contact "slow to the leader's speed" vs "stop"
 * (prototypes/lane-flow/ab-follower.ts on engine/physics/lane-flow.ts). Blocking.
 *  - the experiment is reproducible: rerunning it gives exactly the committed prototypes/lane-flow/out/ab-follower.json,
 *    and the table in docs/physics-follower-ab.md is that output verbatim;
 *  - safety invariants hold for BOTH variants in every scenario and seed (0 penetration, 0 missed contacts,
 *    conservation, no teleport, bitwise rerun);
 *  - no winner is hard-coded: both variants are reported for every scenario × seed, both stay selectable, and the
 *    report carries no winner field;
 *  - mergeEpisodes (candidate-metrics.ts) merges numerical chatter of one contact but never a real separation.
 * The chunk (partition) invariance result is REPORTED (it currently fails; docs/physics-follower-ab.md §4), not asserted.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { runAb, abTable, AB_OUT, AB_DESIGN } from '../prototypes/lane-flow/ab-follower.ts';
import { mergeEpisodes, MetricsRefused, type Threshold } from '../engine/physics/candidate-metrics.ts';
import { BenchmarkRefused } from '../engine/physics/lane-flow-benchmarks.ts';
import { normalBenchmark } from '../prototypes/lane-flow/lib.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const T = (value: number): Threshold => ({ value, assumption: true, basis: '遊戲假設', note: 'test' });

// ---------------------------------------------------------------- mergeEpisodes
{
  const eps = [{ agents: ['a', 'b'] as [string, string], start_t_s: 1, end_t_s: 1.01 }, { agents: ['a', 'b'] as [string, string], start_t_s: 1.1, end_t_s: 1.2 }, { agents: ['a', 'b'] as [string, string], start_t_s: 2, end_t_s: null }];
  const gaps = [{ t: 1.05, a: 'a', b: 'b', gap_mm: 2e-7 }, { t: 1.5, a: 'b', b: 'a', gap_mm: 0.4 }];
  const m = mergeEpisodes(eps, gaps, { max_gap_mm: T(1e-3), max_pause_s: T(0.05) });
  ok(m.length === 2 && m[0].start_t_s === 1 && m[0].end_t_s === 1.2 && m[1].start_t_s === 2 && m[1].end_t_s === null, `chatter (gap 2e-7 mm between) merged, a real separation (0.4 mm) kept (${JSON.stringify(m)})`);
  ok(mergeEpisodes(eps, [], { max_gap_mm: T(1e-3), max_pause_s: T(0.05) }).length === 3, 'no sample between and pauses longer than max_pause → not merged');
  try { mergeEpisodes(eps, gaps, { max_gap_mm: { value: 1 } as Threshold, max_pause_s: T(0.05) }); ok(false, 'unlabelled threshold'); } catch (e) { ok(e instanceof MetricsRefused, 'unlabelled merge threshold refused'); }
}

// ---------------------------------------------------------------- speed variation provenance (game assumption)
{
  try { normalBenchmark(1, { speed_variation: { sd_mm_s: 2.5, provenance: { ...AB_DESIGN.speed_variation.provenance, basis: '文獻支持' as never } } }); ok(false, 'refuse'); } catch (e) { ok(e instanceof BenchmarkRefused, 'individual speed variation must be labelled 遊戲假設 (no species data)'); }
  const v = normalBenchmark(1, { speed_variation: AB_DESIGN.speed_variation }).agents.map((a) => a.free_speed_mm_s);
  ok(new Set(v).size > 10 && v.every((x) => x >= 8.5 && x <= 25.5), 'speeds vary per agent, clipped to [0.5, 1.5] × 17 mm/s');
}

// ---------------------------------------------------------------- the experiment
const t0 = Date.now();
const res = runAb();
const committed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, AB_OUT), 'utf8'));
ok(JSON.stringify(JSON.parse(JSON.stringify(res))) === JSON.stringify(committed), `A/B rerun reproduces ${AB_OUT} exactly (${Date.now() - t0} ms)`);
const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/physics-follower-ab.md'), 'utf8');
ok(doc.includes(abTable(res.rows)), 'docs/physics-follower-ab.md contains the regenerated table verbatim');
for (const r of res.rows) {
  const tag = `${r.scenario} ${r.variant} seed ${r.seed}`;
  ok(r.penetration === 0 && r.missed_contacts === 0 && r.conservation_ok && r.no_teleport_ok && r.rerun_bitwise, `${tag}: 0 penetration, 0 missed, conserved, no teleport, bitwise rerun`);
  ok(r.min_gap_mm === null || r.min_gap_mm > 0, `${tag}: min observed gap ${r.min_gap_mm} mm > 0`);
  ok(r.behavioural_conclusions_allowed === (r.family === 'timed_inflow_comparison'), `${tag}: conclusion scope follows the family`);
}
for (const sc of new Set(res.rows.map((r) => r.scenario))) for (const seed of new Set(res.rows.filter((r) => r.scenario === sc).map((r) => r.seed))) {
  const vs = res.rows.filter((r) => r.scenario === sc && r.seed === seed).map((r) => r.variant).sort();
  ok(vs.join() === [...AB_DESIGN.variants].sort().join(), `${sc} seed ${seed}: both variants measured`);
}
ok(!/winner|best|selected_variant/i.test(JSON.stringify(Object.keys(res))) && /no winner/.test(res.note), 'the report selects no winner');
const src = fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/lane-flow.ts'), 'utf8');
ok(/'stop' \| 'slow'/.test(src) && !/default.*contact_response|contact_response \?\?/.test(src), 'lane-flow keeps both responses and has no default response (the caller must choose)');
console.log(JSON.stringify({ k189_follower_ab: 'pass', checks, rows: res.rows.length, ms: Date.now() - t0 }, null, 2));
