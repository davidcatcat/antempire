/**
 * C4a A0 (docs/design-c4-larval-nutrition.md §1, §5; Issue #81): the defect, reproduced on the current engine BEFORE any
 * C4a change. This test passes while the defect exists; the C4a rules update must add the switch-on counterpart (A1) and
 * leave this switch-off evidence in place.
 *
 * Counterfactual (Issue #81 acceptance): on the same day with the same seed, add only larvae that NO nurse touches and that
 * lie at another place (`location: 'brood_far'`, a field the current engine ignores). Each original larva's own feeding
 * did not change — the engine gives larvae no individual feeding at all (no larva compartment, no feed_larva transfer) —
 * yet its begging signal and its development change, because both read colony-wide quantities:
 *   L1 engine/nutrition.ts consume(): begging_signal from the colony protein fraction pFraction
 *   L2 engine/brood.ts developBrood(): growth factor min(pFraction, sFraction) of the colony
 *   L3 engine/brood.ts developBrood(): starvation hazard from colony.stores.protein_gap_days
 *   L4 engine/nutrition.ts consume(): larval metabolism taken from the colony pool (attribution unknown)
 * Engineering evidence of a locality defect (CLAUDE.md §2.1b), not a biological result.
 */
import assert from 'node:assert/strict';
import { buildDay0 } from '../cli/lib/day0.ts';
import { loadBundle } from '../cli/lib/load.ts';
import { simulateWorldDay, legacyToWorldState, legacyColonyMeta } from '../engine/index.ts';
import { fixture } from './lib/harness.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const b: Any = loadBundle();
const larvae = (s: Any) => s.colonies[0].population.brood.filter((x: Any) => x.stage === 'larva');
const addFar = (s0: Any, n: number) => {
  const s = structuredClone(s0), br = s.colonies[0].population.brood;
  for (let i = 0; i < n; i++) br.push({ id: `ZZFAR${String(i).padStart(3, '0')}`, stage: 'larva', laid_on_day: null, age_days: null, progress: 0.1, begging_signal: 0.3, location: 'brood_far', origin: 'test: an untouched larva at another place' });
  return s;
};
const evidence: Record<string, unknown>[] = [];
// a small protein store, so the colony fraction is neither 0 nor 1 (with no protein both runs read 0 and nothing shows)
const withProtein = (s: Any, p: number) => { s.colonies[0].stores.protein = p; return s; };
const probe = (label: string, s0: Any) => {
  const ids = larvae(s0).map((x: Any) => x.id);
  assert.ok(ids.length > 0, `${label}: no larvae`);
  const base: Any = simulateWorldDay(structuredClone(s0), b), far: Any = simulateWorldDay(addFar(s0, 20), b);
  const byId = (s: Any) => new Map(s.colonies[0].population.brood.map((x: Any) => [x.id, x]));
  const A = byId(base.state), B = byId(far.state);
  const fedEvents = (o: Any) => o.result.colonies[0].events.filter((e: Any) => e.type === 'food_transfer' && (e.recipient?.kind === 'larva_body' || e.cause === 'feed_larva')).length;
  ok(fedEvents(base) === 0 && fedEvents(far) === 0, `${label}: the current engine has no individual larval feeding at all (no larva_body / feed_larva), so no larva's own intake can differ between the runs`);
  const begging = ids.filter((id: string) => A.has(id) && B.has(id) && (A.get(id) as Any).begging_signal !== (B.get(id) as Any).begging_signal);
  const growth = ids.filter((id: string) => A.has(id) && B.has(id) && (A.get(id) as Any).progress !== (B.get(id) as Any).progress);
  const pf = [base.result.colonies[0].summary.ratios?.protein, far.result.colonies[0].summary.ratios?.protein];
  evidence.push({ label, larvae: ids.length, colony_protein_fraction: pf, begging_changed: begging.length, growth_changed: growth.length });
  return { begging, growth, pf };
};
// Day0 A2 (a budding propagule with larvae) and the Day14 fixture
const day0 = probe('Day0 A2 autumn seed 1 (protein store 0.15)', withProtein(buildDay0('A2' as Any, 1, '2027-09-23', b).state, 0.15));
const day14 = probe('Day14 fixture (protein store 0.15)', withProtein(legacyToWorldState(fixture() as Any, legacyColonyMeta(b.world.scenario_colonies as Any)), 0.15));
for (const [label, r] of [['Day0 A2', day0], ['Day14', day14]] as const) {
  ok(r.pf[0] !== r.pf[1], `${label}: adding untouched far larvae changes the COLONY protein fraction (${r.pf[0]} -> ${r.pf[1]})`);
  ok(r.begging.length > 0, `${label}: L1 DEFECT — ${r.begging.length} original larvae change their begging signal although nothing about their own feeding changed`);
}
ok(day0.growth.length + day14.growth.length > 0, `L2 DEFECT — original larvae develop differently (${day0.growth.length} + ${day14.growth.length}) because growth reads the colony fractions`);
// L3: the same larva, the same day, only the colony's protein_gap_days differs -> a different starvation hazard (risk read from the colony)
{
  const s0: Any = buildDay0('A2' as Any, 1, '2027-09-23', b).state, hi: Any = structuredClone(s0);
  hi.colonies[0].stores.protein_gap_days = 40; hi.colonies[0].stores.protein = 0;
  const lo: Any = simulateWorldDay(structuredClone(s0), b), h: Any = simulateWorldDay(hi, b);
  const deaths = (o: Any) => o.result.colonies[0].events.filter((e: Any) => e.type === 'brood_death' && e.reason === 'chronic_protein_shortage_game_scenario').length;
  ok(deaths(h) > deaths(lo), `L3 DEFECT — with the colony's protein_gap_days set high (a colony statistic), larvae die of 'chronic protein shortage' (${deaths(lo)} -> ${deaths(h)}) without any record of their own feeding`);
}
console.log(JSON.stringify({ test: 'c4a-a0-defect', checks, evidence, note: 'switch-off evidence of the C4 locality defects L1-L3 (Issue #81); not a biological result' }, null, 2));
