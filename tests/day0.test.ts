/**
 * v2-review.15 Day0 initialization (engine/initialization.ts, scenarios/day0/*.json). Nothing here reads or
 * writes the official saves; the real saves/ and journal/ must stay byte-identical.
 *  1. legal Day0 state: only v3 keys, validateWorld passes, sim_day 0 on the season's start date;
 *  2. provenance: every scenario number is a tagged assumption (untagged -> refused); the colony has no
 *     route memory, no known sources, no injuries, no trails, no Day14 data; crop sugar is in the ledger;
 *  3. warm-up: the garden runs alone (identical for every founding at the same seed), every warm-up event is
 *     a registered natural event, every Day0 carcass batch comes from a recorded warm-up insect death;
 *  4. Day0 -> Day1 for A1–A3 × 4 seasons × 20 seeds: the engine's own ledger/conservation checks pass, worker
 *     and brood counts close, every route edge known on Day1 was walked by THAT worker on Day1 (no free routes);
 *  5. 90-day audits (A1–A3 × 4 seasons × 2 seeds): brood advances at most one stage per day, eclosion only
 *     from pupae, route memory grows only along edges the worker walked that day, ages +1 per day;
 *  6. replay determinism; different seeds differ;
 *  7. unsupported foundings (B independent queen, C polygyne, >1 queen) are refused, never faked;
 *  8. Day14 route evidence is never given to a worker that eclosed in the simulation (ID collision guard).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { simulateWorldDay, initializeDay0, FoundingNotSupported, NATURAL_EVENT_TYPES, validateWorld, type WorldState } from '../engine/index.ts';
import { ensureRouteMemory } from '../engine/navigation.ts';
import { resolveBundle } from '../engine/params.ts';
import { loadBundle, REPO_ROOT } from '../cli/lib/load.ts';
import { buildDay0, day0Inputs, seasonStart, SEASONS, SUPPORTED_FOUNDINGS } from '../cli/lib/day0.ts';
import { DAY0_SEEDS } from '../cli/reports/day0-evaluation.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const sha = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const realSaves = ['saves/main.json', 'saves/world-state.json', 'saves/commit-log.json'].filter((f) => fs.existsSync(path.join(REPO_ROOT, f))).map((f) => [f, sha(path.join(REPO_ROOT, f))]);
const listDir = (d: string) => fs.readdirSync(d).sort().join(',');
const journalBefore = listDir(path.join(REPO_ROOT, 'journal'));
const bundle = loadBundle(), wp = resolveBundle(bundle).world;
const V3 = ['schema', 'sim_day', 'calendar_date', 'seed', 'climate', 'sources', 'ecology', 'colonies', 'migration_log', 'rules_fingerprint', 'active_signals', 'last_world_events'];
const edges = (w: Any) => Object.keys(w.route_memory?.edges ?? {});

try {
  // 1–3. Day0 state
  for (const season of SEASONS) {
    const worlds: Record<string, WorldState> = {};
    for (const f of SUPPORTED_FOUNDINGS) {
      const o = buildDay0(f, DAY0_SEEDS[0], seasonStart(season), bundle), s = o.state, c = s.colonies[0], inp = day0Inputs(f);
      worlds[f] = s;
      ok(Object.keys(s).every((k) => V3.includes(k)) && s.schema === 'antempire.world-state.v3', `${f}/${season}: only v3 keys`);
      validateWorld(s); checks++;
      ok(s.sim_day === 0 && s.calendar_date === seasonStart(season), `${f}/${season}: Day0 on the season start date`);
      const log = s.migration_log?.[0] as Any;
      ok(s.migration_log?.length === 1 && log.type === 'day0_initialization' && log.day14_history_used === false && log.warmup_days === 30, `${f}/${season}: initialization logged, no Day14 history`);
      ok(!/day14|day15_migration|Day1～14/i.test(JSON.stringify(c)), `${f}/${season}: colony state carries no Day14 data`);
      ok(c.population.queen_alive && c.population.workers.length === inp.founding.workers.value && c.population.brood.length === inp.founding.eggs.value + inp.founding.larvae.value + inp.founding.pupae.value, `${f}/${season}: queen, workers and brood as the scenario says`);
      ok(c.population.workers.every((w) => edges(w).length === 0 && (w.route_memory as Any).origin === 'founded_day0' && !w.known_sources.length && !w.injured && w.last_location === c.nest_node && w.age_days >= inp.founding.worker_age_days_min.value && w.age_days <= inp.founding.worker_age_days_max.value), `${f}/${season}: founders know no routes or sources, are uninjured, ages in range`);
      ok(Object.values(c.source_knowledge).every((k) => k.presence === 'potential' && k.known_by.length === 0) && Object.keys(c.trail_by_edge).length === 0, `${f}/${season}: no colony knowledge of any source, no trails`);
      const crops = c.population.workers.reduce((a, w) => a + ((w.crop_cargo_sugar as number) || 0), 0);
      ok(Math.abs(c.stores.sugar - crops) < 1e-9 && c.stores.protein === inp.founding.stores_protein.value, `${f}/${season}: nest sugar = founders' crop load (${crops}), protein as scenario`);
      ok(c.population.workers.every((w) => w.local_sensory?.own_crop_sugar_fill === inp.founding.worker_crop_fill_fraction.value), `${f}/${season}: each founder senses its own crop load`);
      const deaths = new Set(o.warmup.events.filter((e) => e.type === 'insect_natural_death').map((e) => `${e.site}:${e.event_id}`));
      ok(o.warmup.events.every((e) => NATURAL_EVENT_TYPES.has(e.type)), `${f}/${season}: every warm-up event is a registered natural event`);
      ok(Object.values(s.sources).filter((x) => x.type === 'carcass').every((x) => x.batches.every((b) => deaths.has(`${x.id}:${b.event_id}`))), `${f}/${season}: every Day0 carcass batch comes from a recorded warm-up insect death`);
    }
    const world = (s: WorldState) => JSON.stringify([s.sources, s.ecology, s.climate]);
    ok(SUPPORTED_FOUNDINGS.every((f) => world(worlds[f]) === world(worlds.A1)), `${season}: the Day0 garden is identical whatever founding follows (ecology never reads the colony)`);
  }
  // refused inputs
  const base = day0Inputs('A1'), clim = base.climatology;
  const untagged = structuredClone(base); delete untagged.founding.workers.assumption;
  assert.throws(() => initializeDay0({ ...untagged, seed: 1, start_date: '2027-03-20' }, bundle), /tagged assumption/); checks++;
  const carcass = structuredClone(base); carcass.garden.carcass_sites.F07.initial_carcass_protein.value = 3;
  assert.throws(() => initializeDay0({ ...carcass, seed: 1, start_date: '2027-03-20' }, bundle), /recorded deaths/); checks++;
  const twoQueens = structuredClone(base); twoQueens.founding.queens.value = 2;
  assert.throws(() => initializeDay0({ ...twoQueens, seed: 1, start_date: '2027-03-20' }, bundle), FoundingNotSupported); checks++;
  for (const f of ['B', 'C'] as const) {
    let err: unknown; try { buildDay0(f, 1, '2027-03-20', bundle); } catch (e) { err = e; }
    ok(err instanceof FoundingNotSupported && (err as FoundingNotSupported).missing.length >= 2, `${f}: refused with its missing mechanisms (not run as a fake single-queen colony)`);
  }
  ok(clim && base.garden.schema === 'antempire.day0-garden.v1', 'scenario files load');

  // 4. Day0 -> Day1, all supported foundings × seasons × 20 seeds
  let day1 = 0, walkedEdges = 0;
  for (const f of SUPPORTED_FOUNDINGS) for (const season of SEASONS) for (const seed of DAY0_SEEDS) {
    const s0 = buildDay0(f, seed, seasonStart(season), bundle).state, c0 = s0.colonies[0];
    const o = simulateWorldDay(s0, bundle), c1 = o.state.colonies[0], cr = o.result.colonies[0], sm = cr.summary as Any;
    ok(o.state.sim_day === 1 && sm.workers_before - sm.worker_deaths + sm.eclosions === c1.population.workers.length && c0.population.brood.length + sm.eggs_laid - sm.brood_deaths - sm.eclosions === c1.population.brood.length, `${f}/${season}/${seed}: worker and brood counts close`);
    for (const w of c1.population.workers) {
      const walked = new Set(cr.events.filter((e: Any) => (e.type === 'route_step' || e.type === 'exploration_step') && e.worker === w.id).map((e: Any) => [e.from, e.to].sort().join(':')));
      for (const k of edges(w)) { const m = (w.route_memory as Any).edges[k]; assert.ok(walked.has(k) && m.first_day === 1 && m.acquired !== 'day14_history', `${f}/${season}/${seed}: ${w.id} knows ${k} without walking it on Day1`); walkedEdges++; }
    }
    day1++;
  }
  ok(day1 === 240 && walkedEdges > 0, `Day0 -> Day1 in ${day1} runs; ${walkedEdges} remembered edges, each walked by that worker on Day1`);

  // 5. 90-day audits
  const ORDER: Record<string, number> = { egg: 0, larva: 1, pupa: 2 };
  let audited = 0;
  for (const f of SUPPORTED_FOUNDINGS) for (const season of SEASONS) for (const seed of DAY0_SEEDS.slice(0, 2)) {
    let s = buildDay0(f, seed, seasonStart(season), bundle).state;
    for (let d = 1; d <= 90; d++) {
      const before = s.colonies[0], stage = new Map(before.population.brood.map((b) => [b.id, b.stage])), mem = new Map(before.population.workers.map((w) => [w.id, new Set(edges(w))])), age = new Map(before.population.workers.map((w) => [w.id, w.age_days]));
      const o = simulateWorldDay(s, bundle), after = o.state.colonies[0], ev = o.result.colonies[0].events as Any[];
      for (const b of after.population.brood) if (stage.has(b.id)) assert.ok(ORDER[b.stage] - ORDER[stage.get(b.id) as string] <= 1 && ORDER[b.stage] >= ORDER[stage.get(b.id) as string], `${f}/${season}/${seed} day ${d}: ${b.id} skipped a stage`);
      for (const e of ev.filter((x) => x.type === 'eclosion')) assert.equal(stage.get(e.source_brood_id), 'pupa', `${f}/${season}/${seed} day ${d}: eclosion not from a pupa`);
      for (const w of after.population.workers) {
        if (!mem.has(w.id)) { assert.ok(w.age_origin === 'born_after_v2_migration' && (w.route_memory === undefined || edges(w).every((k) => (w.route_memory as Any).edges[k].first_day === d)), `${f}/${season}/${seed} day ${d}: newborn ${w.id} starts without routes`); continue; }
        assert.equal(w.age_days, (age.get(w.id) as number) + 1, `${w.id} ages one day per day`);
        const walked = new Set(ev.filter((e) => (e.type === 'route_step' || e.type === 'exploration_step') && e.worker === w.id).map((e) => [e.from, e.to].sort().join(':')));
        for (const k of edges(w)) if (!(mem.get(w.id) as Set<string>).has(k)) assert.ok(walked.has(k), `${f}/${season}/${seed} day ${d}: ${w.id} learned ${k} without walking it`);
      }
      s = o.state;
      if (!after.population.queen_alive && !after.population.workers.length) break;
    }
    audited++;
  }
  ok(audited === 24, `90-day stage / route / age audits in ${audited} runs`);

  // 6. determinism
  const run = (seed: number) => { let s = buildDay0('A2', seed, seasonStart('autumn'), bundle).state; const out: string[] = []; for (let d = 0; d < 30; d++) { const o = simulateWorldDay(s, bundle); out.push(JSON.stringify([o.result, o.state])); s = o.state; } return out.join('\n'); };
  ok(run(DAY0_SEEDS[3]) === run(DAY0_SEEDS[3]), 'same Day0 inputs replay byte-identically (30 days)');
  ok(run(DAY0_SEEDS[3]) !== run(DAY0_SEEDS[4]), 'a different world seed gives a different history');

  // 8. newborn ID collision guard (Day0 worlds number workers from W001; Day14 evidence names W005, W011, ...)
  const evidenceIds = Object.keys(wp.route_evidence);
  ok(evidenceIds.length > 0, 'world file still holds Day14 route evidence');
  const colony: Any = { population: { workers: evidenceIds.map((id) => ({ id, age_days: 0, age_origin: 'born_after_v2_migration', injured: false, task: 'rest', known_sources: [], last_location: 'N00' })) } }, evs: Any[] = [];
  ensureRouteMemory(colony, wp, 20, evs);
  ok(colony.population.workers.every((w: Any) => w.route_memory.origin === 'eclosed_in_simulation' && edges(w).length === 0), `workers eclosed in the simulation never receive Day14 route evidence (IDs ${evidenceIds.join(', ')})`);
  console.log(JSON.stringify({ passed: true, checks, day0_to_day1_runs: day1, audited_90_day_runs: audited, remembered_edges_on_day1: walkedEdges, real_saves_unchanged: true }, null, 2));
} finally {
  for (const [f, h] of realSaves) assert.equal(sha(path.join(REPO_ROOT, f)), h, 'REAL SAVE CHANGED: ' + f);
  assert.equal(listDir(path.join(REPO_ROOT, 'journal')), journalBefore, 'REAL journal/ changed');
}
