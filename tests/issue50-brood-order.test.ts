/**
 * Issue #50 (Issue #49 N1) — the fate of a brood item must not depend on where it sits in the stored brood array.
 * v2-review.21 (switch brood_care.daily_care_snapshot_v21): care exposure from the workers present at the start of
 * the step; eclosions committed after every brood item is processed (worker ids in source-pupa id order); a nurse's
 * uniform larva draw maps to larvae in id order.
 *
 * Results are compared after NORMALISING BY INDIVIDUAL ID (state of each brood id, deaths by id, eclosion
 * source-id -> new-worker-id, worker ids, counts), never by comparing differently ordered arrays as strings.
 *   A  Issue #49 Appendix A (developBrood and the public simulateWorldDay): [P,L] and [L,P] give the same L.
 *      With the switch off (v2-review.20) the defect is still present (evidence that the fixture reaches it).
 *   B  property test: 400 random brood sets — mixed eggs / larvae / pupae, several pupae eclosing the same day, items
 *      at their unattended limit, protein-gap larval hazard draws, with no workers and with nurses — each under
 *      6 permutations: identical per-id results.
 *   C  new worker ids: assigned in source-pupa id order, replayable, unique; population / death / eclosion balance.
 *   D  public API over 40 days (A4 without workers, A1 with workers), brood arrays permuted at Day0: identical
 *      per-id populations every day.
 */
import assert from 'node:assert/strict';
import { loadBundle } from '../cli/lib/load.ts';
import { buildDay0 } from '../cli/lib/day0.ts';
import { resolveBundle, simulateWorldDay } from '../engine/index.ts';
import { developBrood } from '../engine/brood.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const ONLY = process.env.ISSUE50_ONLY; const want = (k: string) => !ONLY || ONLY.includes(k); // e.g. ISSUE50_ONLY=BD
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b = loadBundle();
const spOf = (snapshot: boolean) => { const sp: Any = structuredClone(resolveBundle(b).species['pheidole-megacephala']); sp.brood_care.daily_care_snapshot_v21 = snapshot; return sp; };
const SP = spOf(true), SP_OFF = spOf(false);
const bundleWith = (snapshot: boolean) => { const x: Any = structuredClone(b); x.species['pheidole-megacephala'].brood_care.daily_care_snapshot_v21 = snapshot; return x; };
const newSummary = (): Any => ({ brood_deaths: 0, eclosions: 0, hatchings: 0, pupations: 0 });

/** Per-id normal form of one developBrood result. */
const normal = (c: Any, events: Any[], summary: Any) => ({
  brood: Object.fromEntries([...c.population.brood].sort((x: Any, y: Any) => (x.id < y.id ? -1 : 1)).map((x: Any) => [x.id, { stage: x.stage, progress: x.progress, age_days: x.age_days, no_caretaker_days: x.no_caretaker_days ?? null }])),
  deaths: events.filter((e) => e.type === 'brood_death').map((e) => `${e.id}:${e.reason}`).sort(),
  eclosions: Object.fromEntries(events.filter((e) => e.type === 'eclosion').map((e) => [e.source_brood_id, e.new_worker_id]).sort()),
  hatch: events.filter((e) => e.type === 'hatch').map((e) => e.id).sort(),
  pupation: events.filter((e) => e.type === 'pupation').map((e) => e.id).sort(),
  workers: c.population.workers.map((w: Any) => w.id).sort(),
  next_worker_number: c.next_worker_number,
  counts: { ...summary },
});
const runBrood = (sp: Any, brood: Any[], workers: 'none' | 'nurses', gapDays = 0, temp = 25) => {
  const world = buildDay0('A4', 1, '2027-09-23', b).state, c = world.colonies[0];
  if (workers === 'none') c.population.workers = [];
  else c.population.workers = buildDay0('A1', 1, '2027-09-23', b).state.colonies[0].population.workers.slice(0, 3);
  c.population.brood = structuredClone(brood); c.stores.protein_gap_days = gapDays;
  const events: Any[] = [], summary = newSummary();
  developBrood(world, c, sp, { nest_temp_model_c: temp } as Any, { sFraction: 0.5, pFraction: 0.5 }, events, summary);
  return { c, events, summary, n: normal(c, events, summary), before: brood.length, workersBefore: workers === 'none' ? 0 : 3 };
};

// ---------------------------------------------------------------- A: Issue #49 Appendix A
if (want('A')) {
  const larvaMax = SP.brood_care.unattended_larva_max_days;
  const P = { id: 'P', stage: 'pupa', age_days: 0, progress: 0.999 }, L = { id: 'L', stage: 'larva', age_days: 0, progress: 0.2, no_caretaker_days: larvaMax - 1 };
  const pl = runBrood(SP, [P, L], 'none'), lp = runBrood(SP, [L, P], 'none');
  assert.deepEqual(pl.n, lp.n, 'A: [P,L] and [L,P] give identical per-id results'); checks++;
  ok(!pl.n.brood.L && pl.n.deaths.includes('L:unattended_brood_no_worker_care_game_assumption'), `A: L reaches its unattended limit in both orders (a worker that ecloses today gives no care today): ${JSON.stringify(pl.n.deaths)}`);
  ok(pl.n.eclosions.P && pl.summary.eclosions === 1, 'A: P ecloses in both orders');
  // switch off (v2-review.20): the defect is present — evidence that this fixture reaches it
  const offPL = runBrood(SP_OFF, [P, L], 'none'), offLP = runBrood(SP_OFF, [L, P], 'none');
  ok(!!offPL.n.brood.L !== !!offLP.n.brood.L, `A (switch off = v2-review.20): L's fate still depends on the array order (P first: ${offPL.n.brood.L ? 'alive' : 'dead'}, L first: ${offLP.n.brood.L ? 'alive' : 'dead'})`);
  // public API
  const publicRun = (bundle: Any, pupaFirst: boolean) => {
    const s = buildDay0('A4', 1, '2027-09-23', b).state, c = s.colonies[0];
    const p: Any = { id: 'P', stage: 'pupa', age_days: 0, progress: 0.999 }, l: Any = { id: 'L', stage: 'larva', age_days: 0, progress: 0.2, no_caretaker_days: larvaMax - 1 };
    c.population.brood = pupaFirst ? [p, l] : [l, p]; c.next_egg_number = 3;
    const o = simulateWorldDay(s, bundle), cc = o.state.colonies[0];
    return { larvaAlive: cc.population.brood.some((x: Any) => x.id === 'L'), deaths: o.result.colonies[0].summary.brood_deaths, eclosions: o.result.colonies[0].summary.eclosions, workers: cc.population.workers.map((w: Any) => w.id).sort() };
  };
  const on = bundleWith(true), off = bundleWith(false);
  assert.deepEqual(publicRun(on, true), publicRun(on, false), 'A public API: identical per-id outcome in both orders'); checks++;
  ok(JSON.stringify(publicRun(off, true)) !== JSON.stringify(publicRun(off, false)), 'A public API (switch off): the v2-review.20 defect is present');
}

// ---------------------------------------------------------------- B: permutation property test
let rnd = 20261103; const r = () => { rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0; return rnd / 2 ** 32; };
const shuffle = <T>(a: T[]) => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };
let cases = 0, multiEclosion = 0, limitDeaths = 0, hazardDraws = 0, withNurses = 0;
for (let k = 0; k < (want('B') ? 400 : 0); k++) {
  const n = 2 + Math.floor(r() * 9), stages = ['egg', 'larva', 'pupa'] as const, brood: Any[] = [];
  const limit = { egg: SP.brood_care.unattended_egg_max_days, larva: SP.brood_care.unattended_larva_max_days, pupa: SP.brood_care.unattended_pupa_max_days };
  for (let i = 0; i < n; i++) {
    const stage = stages[Math.floor(r() * 3)];
    brood.push({ id: `B${String(Math.floor(r() * 900) + 100)}${i}`, stage, age_days: Math.floor(r() * 10), progress: Math.round((r() < 0.4 ? 0.95 + r() * 0.1 : r()) * 1e6) / 1e6, no_caretaker_days: r() < 0.5 ? limit[stage] - 1 : Math.floor(r() * limit[stage]), ...(stage === 'larva' ? { begging_signal: 0.5 } : {}) });
  }
  const workers = r() < 0.5 ? 'none' : 'nurses', gap = r() < 0.3 ? SP.starvation.larva_mortality_starts_days + 3 : 0;
  const temp = Math.round((20 + r() * 10) * 1000) / 1000;
  const ref = runBrood(SP, brood, workers, gap, temp);
  for (let p = 0; p < 6; p++) {
    const perm = p === 0 ? [...brood].reverse() : shuffle(brood), got = runBrood(SP, perm, workers, gap, temp);
    assert.deepEqual(got.n, ref.n, `B case ${k} perm ${p} (${workers}, gap ${gap}): per-id results differ`); checks++;
  }
  cases++;
  if (ref.summary.eclosions >= 2) multiEclosion++;
  if (ref.n.deaths.some((d) => d.includes('unattended'))) limitDeaths++;
  if (gap && brood.some((x) => x.stage === 'larva')) hazardDraws++;
  if (workers === 'nurses') withNurses++;
  // C: balance and ids
  assert.equal(ref.c.population.brood.length + ref.summary.brood_deaths + ref.summary.eclosions, ref.before, `C case ${k}: brood balance`); checks++;
  assert.equal(ref.c.population.workers.length, ref.workersBefore + ref.summary.eclosions, `C case ${k}: workers = before + eclosions`); checks++;
  const ecl = Object.entries(ref.n.eclosions) as [string, string][], ids = ecl.map(([, w]) => w);
  assert.equal(new Set(ids).size, ids.length, `C case ${k}: new worker ids unique`); checks++;
  assert.deepEqual(ecl.map(([src]) => src), [...ecl.map(([src]) => src)].sort(), `C case ${k}: ids assigned in source-pupa id order`); checks++;
  assert.deepEqual(ids, [...ids].sort(), `C case ${k}: new worker numbers increase with source-pupa id`); checks++;
}
if (want('B')) ok(cases === 400 && multiEclosion > 20 && limitDeaths > 20 && hazardDraws > 20 && withNurses > 100, `B: ${cases} brood sets × 6 permutations; ${multiEclosion} with ≥2 eclosions the same day, ${limitDeaths} with unattended deaths, ${hazardDraws} with larval hazard draws, ${withNurses} with nurses`);
// C: replay
if (want('C')) {
  const brood: Any[] = [{ id: 'X3', stage: 'pupa', progress: 0.99, age_days: 9 }, { id: 'X1', stage: 'pupa', progress: 0.99, age_days: 9 }, { id: 'X2', stage: 'larva', progress: 0.5, age_days: 3, no_caretaker_days: 1 }];
  const a = runBrood(SP, brood, 'none'), z = runBrood(SP, brood, 'none');
  assert.deepEqual(a.n, z.n, 'C: replay of the same input gives the same per-id result and the same new worker ids'); checks++;
  ok(a.n.eclosions.X1 < a.n.eclosions.X3, `C: X1 gets the lower worker number than X3 although X3 is first in the array (${JSON.stringify(a.n.eclosions)})`);
}

// ---------------------------------------------------------------- D: public API over 40 days with permuted brood
const popNormal = (s: Any) => { const c = s.colonies[0]; return { queen: c.population.queen_alive, workers: c.population.workers.map((w: Any) => w.id).sort(), brood: [...c.population.brood].map((x: Any) => `${x.id}:${x.stage}:${x.progress}:${x.no_caretaker_days ?? '-'}`).sort(), next: c.next_worker_number }; };
for (const [founding, season] of want('D') ? ([['A4', '2027-09-23'], ['A4', '2027-03-21'], ['A1', '2027-09-23'], ['A2', '2027-06-21']] as const) : []) {
  const runs = [0, 1, 2].map((p) => {
    let s: Any = buildDay0(founding, 3, season, b).state;
    s.colonies[0].population.brood = p === 0 ? s.colonies[0].population.brood : p === 1 ? [...s.colonies[0].population.brood].reverse() : shuffle(s.colonies[0].population.brood);
    const days: Any[] = [];
    for (let d = 0; d < 40; d++) { const o = simulateWorldDay(s, b); s = o.state; days.push(popNormal(s)); }
    return days;
  });
  for (let d = 0; d < 40; d++) { assert.deepEqual(runs[1][d], runs[0][d], `D ${founding} ${season} day ${d + 1}: reversed brood array changes the population`); assert.deepEqual(runs[2][d], runs[0][d], `D ${founding} ${season} day ${d + 1}: shuffled brood array changes the population`); checks += 2; }
}
console.log(`issue50-brood-order: ${checks} checks passed`);
