/**
 * Issue #56 (PR #52 independent review F1): the order in which workers are STORED still changes individual outcomes.
 * This file is an ANALYSIS PROBE, not a fix. It shows each mechanism on its own, then measures the effect over whole
 * days, using the v2-review.22 food_transfer records to find the first food movement that differs. Every probe
 * compares states normalised by individual id, so only the storage order differs between the two runs.
 * Expected today: every probe reports the defect PRESENT. When #56 is fixed (choices from real local contacts, places
 * and times, not array positions; work packages C2–C5), flip the expectation to "absent" in the same PR. A sort by id
 * is NOT a fix (Issue #49 instruction: a fixed sort must not hide a causal problem).
 *  U1 settleCrops: which crops lose sugar in metabolism / eggs / overflow (engine/nutrition.ts settleCrops)
 *  U2 handoff: which nestmates receive trophallaxis (contacts filtered from the array, picked by index)
 *  U3 consume: the nest sugar rationing shuffle starts from the stored order (each worker's own feeding fraction)
 *  U4 nestContacts: which nestmate a worker meets (peers[floor(g() * n)])
 *  D  whole days: Day0 worlds whose worker array is reversed at the start; first day, fields and transfer that differ,
 *     and the first day on which the population counts differ. (settleCrops also writes 0 into an empty crop it passes
 *     over, so an empty crop is stored as undefined or 0 depending on order: a representation difference only,
 *     normalised here.)
 */
import assert from 'node:assert/strict';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { resolveBundle, settleCrops, handoff, consume, rng, simulateWorldDay } from '../engine/index.ts';
import { nestContacts } from '../engine/workers.ts';
import { engineTransfers } from '../cli/lib/engine-transfers.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b = loadBundle(), sp: Any = resolveBundle(b).species['pheidole-megacephala'];
const byId = (xs: Any[]) => [...xs].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
const world = buildDay0('A1' as Any, 1, '2027-09-23', b).state as Any;
const colonyWith = (crops: number[], reverse: boolean) => {
  const c: Any = structuredClone(world.colonies[0]);
  c.population.workers = crops.map((v, i) => ({ ...structuredClone(c.population.workers[0]), id: `W${String(i + 1).padStart(3, '0')}`, crop_cargo_sugar: v, last_location: c.nest_node }));
  c.stores.sugar = crops.reduce((a, v) => a + v, 0) + 1; c.stores.protein = 1;
  if (reverse) c.population.workers.reverse();
  return c;
};
const report: Record<string, Any> = {};

// U1 settleCrops
{
  const a = colonyWith([0.3, 0.3, 0.3], false), z = colonyWith([0.3, 0.3, 0.3], true);
  settleCrops(a, 0.4); settleCrops(z, 0.4);
  const ca = byId(a.population.workers).map((w: Any) => w.crop_cargo_sugar), cz = byId(z.population.workers).map((w: Any) => w.crop_cargo_sugar);
  report.U1_settleCrops = { stored_order: ca, reversed_order: cz };
  ok(JSON.stringify(ca) !== JSON.stringify(cz), `U1 PRESENT: the same 0.4 portions of metabolism leave different workers' crops depending on storage order (${ca} vs ${cz})`);
}
// U2 handoff: same returning forager, same random stream, nestmates stored in reverse
{
  const run = (reverse: boolean) => { const c = colonyWith([0, 0, 0, 0, 0, 0], reverse), w = c.population.workers.find((x: Any) => x.id === 'W001'), ev: Any[] = []; handoff(c, sp, w, 'sugar', 1, ev, rng(42), 'F01'); return ev.filter((e) => e.type === 'trophallaxis').map((e) => e.to); };
  const ra = run(false), rz = run(true);
  report.U2_handoff = { recipients_stored_order: ra, recipients_reversed_order: rz };
  ok(JSON.stringify(ra) !== JSON.stringify(rz), `U2 PRESENT: the same forager and random draws feed different nestmates (${ra} vs ${rz})`);
}
// U3 consume: rationing when sugar is short
{
  const run = (reverse: boolean) => { const c = colonyWith([0, 0, 0, 0, 0, 0], reverse), n = sp.nutrition, mf = Math.pow(sp.metabolism.q10, (25 - sp.metabolism.reference_c) / 10); c.population.brood = []; c.stores.sugar = Math.round(mf * (n.queen_sugar_daily + 2.5 * n.worker_sugar_daily) * 1e6) / 1e6; /* enough for the queen and 2.5 of 6 workers */ const summary: Any = { extra_sugar_cost: 0 }; consume(world, c, sp, summary, { nest_temp_model_c: 25 } as Any); return byId(c.population.workers).map((w: Any) => w.local_sensory?.own_feeding_fraction); };
  const fa = run(false), fz = run(true);
  report.U3_consume = { own_feeding_fraction_stored: fa, own_feeding_fraction_reversed: fz };
  ok(JSON.stringify(fa) !== JSON.stringify(fz), `U3 PRESENT: which workers eat in a shortage depends on storage order (${fa} vs ${fz})`);
}
// U4 nestContacts
{
  const run = (reverse: boolean) => { const c = colonyWith([0, 0.1, 0.2, 0.3, 0.4, 0.5], reverse), ev: Any[] = []; for (let k = 0; k < 20; k++) nestContacts({ ...world, sim_day: k }, c, sp, ev); return ev.filter((e) => e.type === 'local_contact_cue').map((e) => `${e.worker}>${e.peer}`).sort(); };
  const pa = run(false), pz = run(true);
  report.U4_nestContacts = { contacts_differ: JSON.stringify(pa) !== JSON.stringify(pz), contacts: pa.length };
  ok(JSON.stringify(pa) !== JSON.stringify(pz), 'U4 PRESENT: which nestmate a worker meets depends on storage order');
}
// D whole days: reverse the worker array of a Day0 world; compare per-id states day by day
{
  // an empty crop is stored as undefined or 0 depending on whether settleCrops passed over it (representation only)
  const W = (w: Any) => ({ ...w, crop_cargo_sugar: w.crop_cargo_sugar || 0 });
  const norm = (c: Any) => JSON.stringify({ workers: byId(c.population.workers).map(W), brood: byId(c.population.brood), stores: c.stores, queen: c.population.queen_alive });
  const rows: Any[] = [];
  for (const [sc, seed, season] of [['A1', 1, '2027-09-23'], ['A2', 2, '2027-03-21'], ['A3', 3, '2027-06-21'], ['A1', 4, '2027-12-22']] as const) {
    let a: Any = buildDay0(sc as Any, seed, season, b).state, z: Any = structuredClone(a);
    z.colonies[0].population.workers.reverse();
    assert.equal(norm(a.colonies[0]), norm(z.colonies[0]), 'same individuals at the start'); checks++;
    let first: Any = null;
    for (let d = 0; d < 90 && !first; d++) {
      const oa: Any = simulateWorldDay(a, b), oz: Any = simulateWorldDay(z, b);
      if (norm(oa.state.colonies[0]) !== norm(oz.state.colonies[0])) {
        const ta = engineTransfers(oa.result.colonies[0].events), tz = engineTransfers(oz.result.colonies[0].events);
        const key = (x: Any) => `${x.cause} ${x.source.kind}:${x.source.id} -> ${x.recipient.kind}:${x.recipient.id} ${x.portions}`;
        const sa = new Set(ta.map(key)), diff = tz.map(key).find((k) => !sa.has(k)) ?? ta.map(key).find((k) => !new Set(tz.map(key)).has(k));
        const wa = byId(oa.state.colonies[0].population.workers).map(W), wz = new Map(byId(oz.state.colonies[0].population.workers).map(W).map((w: Any) => [w.id, w]));
        const fields = new Set<string>();
        for (const w of wa) { const v: Any = wz.get(w.id); if (!v) { fields.add('worker missing'); continue; } for (const k of new Set([...Object.keys(w), ...Object.keys(v)])) if (JSON.stringify(w[k]) !== JSON.stringify(v[k])) { if (k === 'local_sensory') for (const j of new Set([...Object.keys(w[k] ?? {}), ...Object.keys(v[k] ?? {})])) { if (JSON.stringify(w[k]?.[j]) !== JSON.stringify(v[k]?.[j])) fields.add(`local_sensory.${j}`); } else fields.add(k); } }
        first = { scenario: `${sc}/${season}/${seed}`, first_divergent_day: oa.day, first_differing_fields: [...fields].sort(), first_differing_transfer: diff ?? 'none that day (the difference starts outside food movements)' };
      }
      a = oa.state; z = oz.state;
    }
    // then: when do the population trajectories (workers, brood) themselves differ?
    let popDay: number | null = null;
    for (let d = 0; d < 120 && popDay === null; d++) {
      const oa: Any = simulateWorldDay(a, b), oz: Any = simulateWorldDay(z, b), pa = oa.result.colonies[0].summary.population, pz = oz.result.colonies[0].summary.population;
      if (JSON.stringify(pa) !== JSON.stringify(pz)) popDay = oa.day;
      a = oa.state; z = oz.state;
      if (!a.colonies[0].population.workers.length && !z.colonies[0].population.workers.length) break;
    }
    rows.push({ ...(first ?? { scenario: `${sc}/${season}/${seed}`, first_divergent_day: null }), first_population_count_divergence_day: popDay });
  }
  report.D_whole_days = rows;
  ok(rows.some((r) => r.first_divergent_day !== null), `D PRESENT: reversing only the stored worker order changes individual states within 90 days in ${rows.filter((r) => r.first_divergent_day !== null).length}/4 worlds`);
}
console.log(JSON.stringify({ checks, issue: 56, status: 'defect PRESENT (analysis probe; fix belongs to C2–C5, not a sort)', report }, null, 2));
