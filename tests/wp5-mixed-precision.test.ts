/**
 * WP5 (OD-1 mixed precision, open ecology; docs/od1-mixed-precision-open-ecology.md). Counterexample tests for the ISOLATED
 * prototype prototypes/mixed-precision/ (ledger + promotion/demotion + patch transfer + decay). Not engine behaviour.
 *   A. a mixed day closes: counts (B/D/I/E), food (integer micro-portions) and identity, checked by an independent audit;
 *   B. determinism and permutation invariance (command order, state array order, roster order);
 *   C. promote -> demote cycles conserve count, mass and identity; a single-member cohort round-trips exactly;
 *   D. Owner Q2: a focal worker that leaves the garden keeps ID, colony, physiology and compartments, is not dead and
 *      cannot be pooled; it can come back;
 *   E. Owner Q1: a human transport without a registered scenario source is refused; a sourced one moves only existing organisms;
 *   F. Issue #80 candidate: decay conserves mass (source - sinks = delta stock), no silent expiry;
 *   G. deliberately BROKEN variants (fraction-dropping demote, vanishing/zeroing/killing emigration, promotion from nothing,
 *      unsourced transport, order-dependent runner, expiry deletion, independent rounding) -> every one is caught;
 *   H. isolation: the official pipeline (engine/, cli/, web/src) does not reference the prototype; the prototype is pure.
 *   R. the audit REPLAYS records (Codex R13-03, R13-04): balance identities are necessary, not sufficient. Region swaps
 *      without a crossing record, crossings whose record names the wrong region or the wrong organism, physiology changed
 *      at a representation change, and production by an unknown / retired / earlier-dead producer are all caught although
 *      every total closes.
 *   S. allocations are re-derived, not just summed (Codex, on 692ba7d: a legitimate 50/50 split forged into 1/99 passed):
 *      for every rule-determined split site (promotion share, cohort death share, cohort_move / transport share, individual
 *      death body -> corpse compartments, demotion pooling, decay stock vs sink) the forged 1/99 is caught while every total
 *      still closes; legitimate controls pass; free-input amounts (produce, food_transfer, birth endowment) are reported as
 *      unverifiable rather than claimed checked; runDay refuses invalid split inputs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import {
  runDay, indexState, exportState, applyCommand, canonicalJson, cohortId, draw, LedgerRefusal,
  type WorldState, type Command, type LedgerRecord,
} from '../prototypes/mixed-precision/ledger.ts';
import { auditDay, auditDayDetailed, totalCount, totalMass, placesOf } from '../prototypes/mixed-precision/audit.ts';
import { decayStep, decayClosure, type DecayInput } from '../prototypes/mixed-precision/decay.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const closed = (a: WorldState, r: LedgerRecord[], b: WorldState, why: string) => { const v = auditDay(a, r, b); assert.deepEqual(v, [], `${why}: ${v.slice(0, 5).join(' | ')}`); checks++; };
const caught = (a: WorldState, r: LedgerRecord[], b: WorldState, why: string) => { const v = auditDay(a, r, b); ok(v.length > 0, `BROKEN variant must be caught: ${why}`); return v; };
const refused = (f: () => unknown, code: string, why: string) => {
  try { f(); } catch (e) { ok(e instanceof LedgerRefusal && e.code === code, `${why}: expected ${code}, got ${(e as Error).message}`); return; }
  assert.fail(`${why}: expected refusal ${code}`);
};
const trig = (kind: string, ...ids: string[]) => ({ kind, driver_event_ids: ids.length ? ids : [`contact.${kind}`] });
const FOCAL = 'FOCAL';

// ---------------------------------------------------------------- fixture (synthetic; every amount is a test value, not biology)
function world(): WorldState {
  const w = (id: string, region: string, sugar: number, protein: number) => ({ id, taxon: 'ant', stage: 'worker', colony_id: FOCAL, region, physio: { age_d: 30 + sugar % 7, hunger_days: 0 }, comp: { crop_sugar: sugar, body_protein: protein } });
  return {
    schema: 'antempire.wp5-mixed-precision.v1', seed: 'wp5-test', day: 1,
    regions: [
      { id: 'G1', resolution: 'fine', in_garden: true }, { id: 'G2', resolution: 'fine', in_garden: true },
      { id: 'Pwall', resolution: 'coarse', in_garden: false }, { id: 'Pnbr', resolution: 'coarse', in_garden: false }, { id: 'R0', resolution: 'coarse', in_garden: false },
    ],
    individuals: [
      { id: 'Q1', taxon: 'ant', stage: 'queen', colony_id: FOCAL, region: 'G1', physio: { age_d: 400 }, comp: { body_protein: 90001, body_sugar: 50003 } },
      w('W1', 'G1', 1203, 401), w('W2', 'G1', 999, 333), w('W3', 'G2', 17, 5), w('W4', 'G2', 0, 250), w('W5', 'Pwall', 640, 64), w('W6', 'G1', 1, 4001),
    ],
    cohorts: [
      { cohort_id: cohortId('G2', 'aphid', 'adult', null), taxon: 'aphid', stage: 'adult', colony_id: null, region: 'G2', count: 40, comp: { body: 40013 }, roster: [], next_serial: 0 },
      { cohort_id: cohortId('Pnbr', 'moth', 'adult', null), taxon: 'moth', stage: 'adult', colony_id: null, region: 'Pnbr', count: 10, comp: { body: 1003 }, roster: [{ id: 'X-moth-7', physio: { age_d: 3 } }, { id: 'X-moth-2', physio: { age_d: 9 } }], next_serial: 0 },
      { cohort_id: cohortId('Pwall', 'ant', 'worker', 'EXT1'), taxon: 'ant', stage: 'worker', colony_id: 'EXT1', region: 'Pwall', count: 50, comp: { crop_sugar: 12345 }, roster: [{ id: 'EXT1-w3', physio: {} }], next_serial: 0 },
      { cohort_id: cohortId('R0', 'aphid', 'adult', null), taxon: 'aphid', stage: 'adult', colony_id: null, region: 'R0', count: 7, comp: { body: 7001 }, roster: [], next_serial: 0 },
      { cohort_id: cohortId('Pnbr', 'beetle', 'adult', null), taxon: 'beetle', stage: 'adult', colony_id: null, region: 'Pnbr', count: 1, comp: { body: 777, gut: 5 }, roster: [{ id: 'X-beetle-1', physio: { age_d: 11 } }], next_serial: 0 },
    ],
    stocks: [{ stock_id: 'honeydew.G2', region: 'G2', amount: 50000, origin_event_id: null }],
    sinks: {}, producers: {}, retired: [],
    scenario_records: [{ record_id: 'TR1', scenario_id: 'OE-demo-potted-plant', source_ref: 'test scenario record (synthetic, 非正式): one potted plant moved R0 -> G2', day: 1, from_region: 'R0', to_region: 'G2', subject: { kind: 'cohort', taxon: 'aphid', stage: 'adult', colony_id: null, count: 3 } }],
    used_scenario_records: [], policy: { non_demotable_colonies: [FOCAL] },
  };
}
const t = (key: string, minute: number | null = 600) => ({ day: 1, minute, key });
function mixedDay(): Command[] {
  const aph = cohortId('G2', 'aphid', 'adult', null), moth = cohortId('Pnbr', 'moth', 'adult', null), ext = cohortId('Pwall', 'ant', 'worker', 'EXT1');
  return [
    { ...t('prod1', null), kind: 'produce', producer: aph, stock: 'honeydew.G2', region: 'G2', amount: 4321 },
    { ...t('col1', 500), kind: 'food_transfer', from: 'stock:honeydew.G2', to: 'org:W3:crop_sugar', amount: 800, cause: 'collect' },
    { ...t('tro1', 520), kind: 'food_transfer', from: 'org:W3:crop_sugar', to: 'org:W2:crop_sugar', amount: 300, cause: 'trophallaxis' },
    { ...t('egg1', 300), kind: 'birth', parent: { individual: 'Q1' }, taxon: 'ant', stage: 'egg', colony_id: FOCAL, as: 'individual', endowment: [{ from: 'org:Q1:body_protein', comp: 'body_protein', amount: 37 }] },
    { ...t('aphb1', null), kind: 'birth', parent: { cohort: aph }, taxon: 'aphid', stage: 'adult', colony_id: null, as: 'cohort', endowment: [{ from: `cohort:${aph}:body`, comp: 'body', amount: 11 }] },
    { ...t('exit1', 610), kind: 'move', individual: 'W1', to: 'Pwall', cause: trig('foraging_trip') },
    { ...t('ret5', 640), kind: 'move', individual: 'W5', to: 'G1', cause: trig('foraging_trip') },
    { ...t('mothin', 700), kind: 'cohort_move', cohort: moth, n: 2, to: 'G2', cause: trig('dispersal_stage_reached', 'weather.1.night') },
    { ...t('extin', 705), kind: 'cohort_move', cohort: ext, n: 3, to: 'G2', cause: trig('foraging_trip', 'ext.trail.1') },
    { ...t('promA', 710), kind: 'promote', cohort: cohortId('G2', 'ant', 'worker', 'EXT1'), trigger: trig('contact_with_focal', 'contact.W3.710') },
    { ...t('promM', 720), kind: 'promote', cohort: cohortId('G2', 'moth', 'adult', null), trigger: trig('predation_contact', 'contact.W4.720') },
    { ...t('tr1', 800), kind: 'transport', record_id: 'TR1' },
    { ...t('dW6', 900), kind: 'death', subject: { individual: 'W6' }, cause: 'senescence' },
    { ...t('dAph', null), kind: 'death', subject: { cohort: aph }, cause: 'cohort_hazard' },
    { ...t('dMoth', null), kind: 'death', subject: { cohort: moth }, cause: 'cohort_hazard' },
    { ...t('decK', 1439), kind: 'decay', stock: 'corpse.1.dW6.body_protein', decomposition: { num: 7, den: 50 }, clear_below: 0 },
  ];
}
// deterministic shuffle (named stream, no Math.random)
function shuffle<T>(xs: T[], salt: string): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(draw('shuffle', salt, String(i)) * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function scrambleState(s: WorldState, salt: string): WorldState {
  const c = structuredClone(s);
  c.individuals = shuffle(c.individuals, salt + 'i'); c.cohorts = shuffle(c.cohorts, salt + 'c').map((x) => ({ ...x, roster: shuffle(x.roster, salt + x.cohort_id) }));
  c.stocks = shuffle(c.stocks, salt + 's'); c.regions = shuffle(c.regions, salt + 'r');
  return c;
}

// ---------------------------------------------------------------- A. a mixed day closes
const s0 = world();
const day = runDay(s0, mixedDay());
closed(s0, day.records, day.state, 'mixed day');
ok(totalMass(s0) === totalMass(day.state), 'global food mass constant (production is booked against the modeled producer)');
ok(totalCount(day.state) === totalCount(s0) + 2 - 3, 'count = initial + births(2) - deaths(3) (immigration/emigration/transport/promotion/demotion are internal)');
const born = day.records.find((r) => r.kind === 'birth' && r.identity.ids.length === 1)!;
ok(born.food_moves[0].from === 'org:Q1:body_protein', 'an egg is paid from the queen\'s own compartment (no colony-wide pool)');
const dW6 = day.records.find((r) => r.event_id === '1.dW6')!;
ok(dW6.food_moves.every((m) => m.to.startsWith('stock:corpse.1.dW6.')) && day.state.stocks.some((s) => s.stock_id === 'corpse.1.dW6.crop_sugar' && s.region === 'G1' && s.origin_event_id === '1.dW6'), 'a death leaves its food in a corpse stock in the same region with the death event as origin (I7)');
ok(day.state.retired.includes('W6') && !placesOf(day.state).has('W6'), 'the dead worker is retired and nowhere alive');
const tr = day.records.find((r) => r.kind === 'transport')!;
ok(tr.scenario_source?.record_id === 'TR1' && tr.cause.kind === 'human_transport' && tr.ledger_effects.length === 2, 'transport carries its scenario source and E/I effects');
ok(s0.individuals.find((i) => i.id === 'W1')!.region === 'G1', 'runDay does not mutate its input');

// ---------------------------------------------------------------- B. determinism and permutation invariance
const ref = canonicalJson(day);
ok(canonicalJson(runDay(world(), mixedDay())) === ref, 'same input + seed -> byte-identical output');
for (let k = 0; k < 24; k++) {
  const out = runDay(scrambleState(world(), 'p' + k), shuffle(mixedDay(), 'c' + k));
  ok(canonicalJson(out) === ref, `permutation ${k}: command order and state array/roster order do not change the outcome`);
}
const other = runDay({ ...world(), seed: 'wp5-test-other' }, mixedDay());
closed({ ...world(), seed: 'wp5-test-other' }, other.records, other.state, 'other seed closes');
ok(canonicalJson(other) !== ref, 'a different seed is a different world (draws are really used)');
ok(draw('s', 'promote', 'k1') === draw('s', 'promote', 'k1') && draw('s', 'promote', 'k1') !== draw('s', 'promote', 'k2'), 'named draws depend only on (seed, stream, key)');

// ---------------------------------------------------------------- C. promote -> demote cycles
{
  // C1: single-member cohort round-trips EXACTLY (ID, physiology, every compartment)
  let s = world(); const bee = cohortId('Pnbr', 'beetle', 'adult', null);
  for (let d = 0; d < 5; d++) {
    const a = runDay(s, [{ day: s.day, minute: 10, key: `pb${d}`, kind: 'promote', cohort: bee, trigger: trig('contact_with_focal') }]);
    closed(s, a.records, a.state, `beetle promote ${d}`);
    const ind = a.state.individuals.find((i) => i.taxon === 'beetle')!;
    ok(ind.id === 'X-beetle-1' && ind.comp.body === 777 && ind.comp.gut === 5 && ind.physio.age_d === 11, `cycle ${d}: promoted with its own ID, physiology and exact compartments`);
    const b = runDay(a.state, [{ day: a.state.day, minute: 20, key: `db${d}`, kind: 'demote', individual: ind.id, trigger: trig('no_contact_left_fine_grid') }]);
    closed(a.state, b.records, b.state, `beetle demote ${d}`);
    const c = b.state.cohorts.find((x) => x.cohort_id === bee)!;
    ok(c.count === 1 && c.comp.body === 777 && c.comp.gut === 5 && c.roster.length === 1 && c.roster[0].id === 'X-beetle-1', `cycle ${d}: demoted back exactly`);
    s = b.state;
  }
  // C2: many random cycles on a multi-member cohort with an indivisible pool: count, mass, identity conserved
  s = world(); const moth = cohortId('Pnbr', 'moth', 'adult', null);
  const n0 = totalCount(s), m0 = totalMass(s), ids0 = new Set(placesOf(s).keys());
  const mintedAll = new Set<string>();
  for (let d = 0; d < 60; d++) {
    const live = s.individuals.filter((i) => i.taxon === 'moth');
    const cmds: Command[] = [];
    if (draw('cyc', 'p', String(d)) < 0.6 && s.cohorts.find((c) => c.cohort_id === moth)!.count > 0) cmds.push({ day: s.day, minute: 5, key: `p${d}`, kind: 'promote', cohort: moth, trigger: trig('contact_with_focal') });
    for (const i of live) if (draw('cyc', 'd', i.id + d) < 0.5) cmds.push({ day: s.day, minute: 30, key: `d${d}${i.id.replace(/\./g, '_')}`, kind: 'demote', individual: i.id, trigger: trig('no_contact_left_fine_grid') });
    const r = runDay(s, cmds);
    closed(s, r.records, r.state, `cycle day ${d}`);
    for (const x of r.records) if (x.identity.action === 'minted') mintedAll.add(x.identity.ids[0]);
    s = r.state;
  }
  ok(totalCount(s) === n0 && totalMass(s) === m0, '60 random promote/demote days: total count and total mass unchanged');
  const ids1 = new Set(placesOf(s).keys());
  ok([...ids0].every((id) => ids1.has(id)) && [...ids1].every((id) => ids0.has(id) || mintedAll.has(id)), 'no ID lost; every new ID is a recorded minting of an organism that already existed in the count');
  ok(mintedAll.size > 0, 'anonymous members were promoted (minting exercised)');
  // C3: honest limit — pooling averages compartments: a known member does NOT get its own old amount back
  const a = runDay(world(), [{ ...t('pm1', 5), kind: 'promote', cohort: moth, trigger: trig('contact_with_focal') }]);
  const one = a.state.individuals.find((i) => i.taxon === 'moth')!;
  ok(one.comp.body === Math.floor(1003 / 10), 'a promoted member receives floor(pool/count); individual variation inside a cohort is not represented (documented B11 limit)');
}

// ---------------------------------------------------------------- D. Owner Q2: leaving the garden is not death
{
  const s = world(); const w1 = s.individuals.find((i) => i.id === 'W1')!;
  const out = runDay(s, [{ ...t('x1', 100), kind: 'move', individual: 'W1', to: 'Pwall', cause: trig('foraging_trip') }]);
  closed(s, out.records, out.state, 'focal exit');
  const o = out.state.individuals.find((i) => i.id === 'W1')!;
  ok(o && o.region === 'Pwall' && o.colony_id === FOCAL && canonicalJson(o.comp) === canonicalJson(w1.comp) && canonicalJson(o.physio) === canonicalJson(w1.physio), 'outside the garden: same ID, colony, physiology and compartments');
  ok(out.records[0].resolution_change?.from === 'fine' && out.records[0].resolution_change?.to === 'coarse', 'only the spatial resolution changes (fine grid -> coarse patch)');
  ok(!out.records.some((r) => r.kind === 'death') && !out.state.retired.includes('W1'), 'no death record, not retired');
  // outside: still an individual that can exchange food by contact (trophallaxis with W5 in the same patch)
  const tro = runDay(out.state, [{ day: 2, minute: 200, key: 'tro', kind: 'food_transfer', from: 'org:W1:crop_sugar', to: 'org:W5:crop_sugar', amount: 3, cause: 'trophallaxis' }]);
  closed(out.state, tro.records, tro.state, 'trophallaxis outside the garden');
  refused(() => runDay(out.state, [{ day: 2, minute: 300, key: 'dm', kind: 'demote', individual: 'W1', trigger: trig('no_contact_left_fine_grid') }]), 'NON_DEMOTABLE', 'a focal worker cannot be pooled into a cohort (Q2)');
  const back = runDay(tro.state, [{ day: 3, minute: 100, key: 'r1', kind: 'move', individual: 'W1', to: 'G1', cause: trig('return_to_nest') }]);
  closed(tro.state, back.records, back.state, 'focal return');
  const b = back.state.individuals.find((i) => i.id === 'W1')!;
  ok(b.region === 'G1' && b.comp.crop_sugar === w1.comp.crop_sugar - 3 && b.comp.body_protein === w1.comp.body_protein, 'returns with the same ID and exactly its own compartments (minus what it gave by recorded trophallaxis)');
  refused(() => runDay(s, [{ ...t('nc', 1), kind: 'move', individual: 'W1', to: 'Pwall', cause: { kind: '', driver_event_ids: [] } }]), 'NO_CAUSE', 'a crossing without a cause is refused (I8)');
}

// ---------------------------------------------------------------- E. Owner Q1: human transport
{
  const s = world();
  refused(() => runDay(s, [{ ...t('tx', 1), kind: 'transport', record_id: 'NOPE' }]), 'NO_SCENARIO_SOURCE', 'transport without a scenario record');
  const noRef = { ...world(), scenario_records: [{ ...world().scenario_records[0], source_ref: '' }] };
  refused(() => runDay(noRef, [{ ...t('tx', 1), kind: 'transport', record_id: 'TR1' }]), 'NO_SCENARIO_SOURCE', 'transport whose record names no source');
  refused(() => runDay(s, [{ ...t('tx', 1), kind: 'transport', record_id: 'TR1' }, { ...t('ty', 2), kind: 'transport', record_id: 'TR1' }]), 'SCENARIO_RECORD_USED', 'a record executes once');
  const big = { ...world(), scenario_records: [{ ...world().scenario_records[0], subject: { kind: 'cohort' as const, taxon: 'aphid', stage: 'adult', colony_id: null, count: 8 } }] };
  refused(() => runDay(big, [{ ...t('tx', 1), kind: 'transport', record_id: 'TR1' }]), 'INSUFFICIENT_COUNT', 'a transport cannot carry more organisms than the source holds (no creation)');
  refused(() => runDay(s, [{ ...t('pz', 1), kind: 'produce', producer: 'ghost-plant', stock: 'honeydew.G2', region: 'G2', amount: 5 }]), 'NO_PRODUCER', 'food is produced only by a living modeled producer');
  refused(() => runDay(s, [{ ...t('bz', 1), kind: 'birth', parent: { cohort: cohortId('G1', 'aphid', 'adult', null) }, taxon: 'aphid', stage: 'adult', colony_id: null, as: 'cohort', endowment: [] }]), 'NO_PARENT', 'a birth needs a living parent (I6)');
  ok(JSON.stringify(s).indexOf('frequency') < 0 && JSON.stringify(s).indexOf('rate') < 0, 'the transport input has no frequency or rate field: only explicit records');
}

// ---------------------------------------------------------------- F. Issue #80 candidate: decay conserves mass
{
  let worst = 0;
  for (let k = 0; k < 2000; k++) {
    const u = (n: string) => draw('decay', n, String(k));
    const inp: DecayInput = {
      stock: Math.floor(u('s') * 1e7), inflows: u('i') < 0.5 ? [{ source: `stock:corpse.${k}`, amount: 1 + Math.floor(u('a') * 1e5), cause: 'new_corpse' }] : [],
      decomposition: { num: Math.floor(u('n') * 50), den: 100 }, other_sinks: u('o') < 0.5 ? [{ to: 'sink:rain_washoff', rate: { num: Math.floor(u('w') * 30), den: 70 }, cause: 'rain_washoff' }] : [],
      clear_below: u('c') < 0.3 ? 1000 : 0,
    };
    const { flows, next } = decayStep('stock:X', inp);
    const v = decayClosure('stock:X', inp.stock, next, flows); worst = Math.max(worst, v.length);
    assert.deepEqual(v, [], `decay case ${k}`);
  }
  ok(worst === 0, '2000 random decay steps: next - prev = sum(sources) - sum(sinks) exactly');
  const rev = decayStep('stock:X', { stock: 123457, inflows: [], decomposition: { num: 1, den: 7 }, other_sinks: [{ to: 'sink:b', rate: { num: 1, den: 9 }, cause: 'b' }, { to: 'sink:a', rate: { num: 2, den: 11 }, cause: 'a' }], clear_below: 0 });
  const rev2 = decayStep('stock:X', { stock: 123457, inflows: [], decomposition: { num: 1, den: 7 }, other_sinks: [{ to: 'sink:a', rate: { num: 2, den: 11 }, cause: 'a' }, { to: 'sink:b', rate: { num: 1, den: 9 }, cause: 'b' }], clear_below: 0 });
  ok(canonicalJson(rev) === canonicalJson(rev2), 'simultaneous sinks: their order does not matter');
  const small = decayStep('stock:X', { stock: 900, inflows: [], decomposition: { num: 1, den: 10 }, other_sinks: [], clear_below: 1000 });
  ok(small.next === 0 && small.flows.some((f) => f.cause === 'remainder_cleared' && f.amount === 810), 'a remainder below threshold leaves by an explicit recorded flow, never a silent delete');
  assert.throws(() => decayStep('stock:X', { stock: 10, inflows: [], decomposition: { num: 3, den: 4 }, other_sinks: [{ to: 'sink:w', rate: { num: 1, den: 2 }, cause: 'w' }], clear_below: 0 })); checks++;
  // in the ledger: the decayed protein is exactly what the decomposition sink received
  const d = day.state, c = d.stocks.find((x) => x.stock_id === 'corpse.1.dW6.body_protein')!;
  ok(d.sinks.decomposition === Math.floor(4001 * 7 / 50) && c.amount + d.sinks.decomposition === 4001, 'ledger decay: corpse protein 4001 = remaining + decomposed (floor(4001*7/50) to sink:decomposition)');
}

// ---------------------------------------------------------------- G. deliberately broken variants are caught
const ix0 = () => indexState(world());
const rec0 = (over: Partial<LedgerRecord>): LedgerRecord => ({
  event_id: '1.broken', kind: 'demote', t: { day: 1, minute: 1, time_resolution: 'minute' }, source_region: null, destination_region: null,
  identity: { action: 'none', ids: [], anonymous: 0 }, ledger_effects: [], food_moves: [], cause: { kind: 'x', driver_event_ids: ['y'], rule_id: 'broken', rng_stream: null, roll: null },
  resolution_change: null, scenario_source: null, ...over,
});
{
  // G1: a demote that drops the fractional part of each compartment (rounds to whole portions of 1000 micro-portions)
  const ix = ix0(); const i = ix.ind.get('W2')!; const c = { cohort_id: cohortId('G1', 'ant', 'worker', 'EXT1'), taxon: 'ant', stage: 'worker', colony_id: 'EXT1', region: 'G1', count: 0, comp: {} as Record<string, number>, roster: [], next_serial: 0 };
  ix.coh.set(c.cohort_id, c); i.colony_id = 'EXT1'; // a non-focal individual, so demotion itself is legal
  const before = exportState(indexState(exportState(ix)));
  const moves = Object.entries(i.comp).map(([k, a]) => ({ from: `org:W2:${k}`, to: `cohort:${c.cohort_id}:${k}`, amount: Math.floor(a / 1000) * 1000, cause: 'demotion_pool' })).filter((m) => m.amount > 0);
  for (const m of moves) c.comp[m.to.split(':').pop()!] = (c.comp[m.to.split(':').pop()!] ?? 0) + m.amount;
  c.count += 1; (c.roster as { id: string; physio: object }[]).push({ id: 'W2', physio: {} }); ix.ind.delete('W2');
  const v = caught(before, [rec0({ identity: { action: 'demoted', ids: ['W2'], anonymous: 0 }, food_moves: moves })], exportState(ix), 'demote dropping fractional food');
  ok(v.some((x) => x.startsWith('food org:W2')) && v.some((x) => x.startsWith('global mass')), 'caught as lost food (per compartment and global)');
}
{
  // G2: emigration that deletes the worker ("leaving view = death" without a record) but books E/I
  const ix = ix0(); const before = exportState(indexState(exportState(ix))); const w = ix.ind.get('W1')!; ix.ind.delete('W1');
  const r = rec0({ kind: 'migration', source_region: 'G1', destination_region: 'Pwall', identity: { action: 'kept', ids: ['W1'], anonymous: 0 }, ledger_effects: [{ region: 'G1', taxon: 'ant', stage: 'worker', colony_id: FOCAL, ledger: 'E', delta: 1 }, { region: 'Pwall', taxon: 'ant', stage: 'worker', colony_id: FOCAL, ledger: 'I', delta: 1 }] });
  const v = caught(before, [r], exportState(ix), 'emigration that vanishes');
  ok(v.some((x) => x.includes('vanished')) && v.some((x) => x.startsWith('count Pwall')), 'caught as vanished ID and missing count'); void w;
  // G3: emigration that keeps the worker but zeroes its compartments
  const iy = ix0(); const b2 = exportState(indexState(exportState(iy))); const w1 = iy.ind.get('W1')!; w1.region = 'Pwall'; w1.comp = { crop_sugar: 0, body_protein: 0 };
  const v3 = caught(b2, [r], exportState(iy), 'emigration that zeroes compartments');
  ok(v3.some((x) => x.startsWith('food org:W1')), 'caught as lost food');
  // G4: emigration booked as a death record ("off-screen = dead")
  const iz = ix0(); const b3 = exportState(indexState(exportState(iz)));
  const dead = applyCommand(iz, { ...t('offscreen', 5), kind: 'death', subject: { individual: 'W1' }, cause: 'left_garden' });
  const v4 = auditDay(b3, [dead], exportState(iz));
  ok(v4.length === 0 && dead.cause.kind === 'left_garden', 'a death record itself closes the books — so the audit alone cannot tell exit from death...');
  const exitAsDeath = (recs: LedgerRecord[]) => recs.filter((x) => x.kind === 'death' && !['senescence', 'predation', 'starvation', 'injury', 'desiccation', 'drowning', 'cohort_hazard'].includes(x.cause.kind));
  ok(exitAsDeath([dead]).length === 1 && exitAsDeath(day.records).length === 0, '...which is why every death must name a biological cause from a declared list; an exit booked as death is caught by that rule');
}
{
  // G5: promotion from nothing (individual created, cohort count untouched, default energy invented)
  const ix = ix0(); const before = exportState(indexState(exportState(ix)));
  ix.ind.set('M.fake', { id: 'M.fake', taxon: 'moth', stage: 'adult', colony_id: null, region: 'Pnbr', physio: {}, comp: { body: 100 } });
  const v = caught(before, [rec0({ kind: 'promote', identity: { action: 'minted', ids: ['M.fake'], anonymous: 0 } })], exportState(ix), 'promotion from nothing');
  ok(v.some((x) => x.startsWith('count Pnbr|moth')) && v.some((x) => x.startsWith('food org:M.fake')), 'caught as extra count and invented food');
}
{
  // G6: a transport booked without a scenario source (bypassing the refusal)
  const ix = ix0(); const before = exportState(indexState(exportState(ix)));
  const c = ix.coh.get(cohortId('R0', 'aphid', 'adult', null))!; c.count -= 1;
  const d = { cohort_id: cohortId('G2', 'aphid', 'adult', null) }; ix.coh.get(d.cohort_id)!.count += 1;
  const moves = [{ from: `cohort:${c.cohort_id}:body`, to: `cohort:${d.cohort_id}:body`, amount: 1000, cause: 'transport' }];
  c.comp.body -= 1000; ix.coh.get(d.cohort_id)!.comp.body += 1000;
  const v = caught(before, [rec0({ kind: 'transport', source_region: 'R0', destination_region: 'G2', ledger_effects: [{ region: 'R0', taxon: 'aphid', stage: 'adult', colony_id: null, ledger: 'E', delta: 1 }, { region: 'G2', taxon: 'aphid', stage: 'adult', colony_id: null, ledger: 'I', delta: 1 }], food_moves: moves, scenario_source: null })], exportState(ix), 'unsourced transport');
  ok(v.some((x) => x.includes('scenario source')), 'caught: transport without a registered scenario source');
}
{
  // G7: an order-dependent runner (applies commands in input order) gives different worlds for the same day
  const moth = cohortId('Pnbr', 'moth', 'adult', null);
  const cmds: Command[] = [
    { ...t('a1', 100), kind: 'death', subject: { cohort: moth }, cause: 'cohort_hazard' },
    { ...t('a2', 100), kind: 'cohort_move', cohort: moth, n: 3, to: 'G2', cause: trig('dispersal_stage_reached') },
    { ...t('a3', 100), kind: 'promote', cohort: moth, trigger: trig('contact_with_focal') },
    { ...t('a4', 100), kind: 'death', subject: { cohort: moth }, cause: 'cohort_hazard' },
  ];
  const naive = (cs: Command[]) => { const ix = indexState(world()); const r = cs.map((c) => applyCommand(ix, c)); return canonicalJson({ s: exportState(ix), r }); };
  const outs = new Set<string>(), canon = new Set<string>();
  for (let k = 0; k < 24; k++) { const p = shuffle(cmds, 'o' + k); outs.add(naive(p)); canon.add(canonicalJson(runDay(world(), p))); }
  ok(outs.size > 1, `BROKEN order-dependent runner caught by the permutation check (${outs.size} different worlds)`);
  ok(canon.size === 1, 'the canonical runner gives one world for every order');
}
{
  // G8: decay variants
  const inp: DecayInput = { stock: 10007, inflows: [{ source: 'stock:corpse.9', amount: 333, cause: 'new_corpse' }], decomposition: { num: 14, den: 100 }, other_sinks: [], clear_below: 0 };
  const good = decayStep('stock:X', inp);
  const expiry = { flows: good.flows, next: 0 }; // silently deletes an "expired" batch
  ok(decayClosure('stock:X', inp.stock, expiry.next, expiry.flows).length > 0, 'BROKEN expiry deletion caught');
  const s1 = inp.stock + 333, roundNext = Math.round(s1 * (1 - 0.14)); // independent rounding of the stock, flows floored
  ok(roundNext !== good.next && decayClosure('stock:X', inp.stock, roundNext, good.flows).length > 0, 'BROKEN independent rounding caught');
  const frac = { flows: good.flows.map((f) => ({ ...f, amount: f.amount + 0.5 })), next: good.next };
  ok(decayClosure('stock:X', inp.stock, frac.next, frac.flows).length > 0, 'BROKEN fractional flow caught');
}

// ---------------------------------------------------------------- R. replay audit: location, representation, physiology, sources
{
  const noCount = (v: string[]) => v.every((x) => !x.startsWith('count ') && !x.startsWith('food ') && !x.startsWith('global mass'));
  // R1 (Codex R13-03 probe): two focal workers swap regions in the final state; no record; every total closes
  const p0: WorldState = { schema: 'antempire.wp5-mixed-precision.v1', seed: 'fixture', day: 0, regions: [{ id: 'G', resolution: 'fine', in_garden: true }, { id: 'P', resolution: 'coarse', in_garden: false }], individuals: [{ id: 'W1', taxon: 'ant', stage: 'worker', colony_id: 'C', region: 'G', physio: { age: 1 }, comp: { sugar: 100 } }, { id: 'W2', taxon: 'ant', stage: 'worker', colony_id: 'C', region: 'P', physio: { age: 2 }, comp: { sugar: 200 } }], cohorts: [], stocks: [], sinks: {}, producers: {}, retired: [], scenario_records: [], used_scenario_records: [], policy: { non_demotable_colonies: ['C'] } };
  const legit = runDay(p0, []);
  closed(p0, legit.records, legit.state, 'R13 probe: legitimate day');
  const swapped = structuredClone(legit.state); swapped.individuals[0].region = 'P'; swapped.individuals[1].region = 'G';
  const vs = caught(p0, [], swapped, 'R13-03: region swap without migration records');
  ok(noCount(vs) && vs.some((x) => x.startsWith('id W1: replay puts it in G, state has P')) && vs.some((x) => x.startsWith('id W2: replay puts it in P, state has G')), 'R13-03: only the per-ID replay sees the swap (counts and food still close)');
  // R2 (Codex R13-04 probe): a well-formed produce record from a producer that does not exist, balanced by a negative account
  const ghost = structuredClone(legit.state); ghost.producers.ghost = -100; ghost.stocks.push({ stock_id: 'S', region: 'G', amount: 100, origin_event_id: '0.fake' });
  const fake: LedgerRecord = { event_id: '0.fake', kind: 'produce', t: { day: 0, minute: 1, time_resolution: 'minute' }, source_region: null, destination_region: 'G', identity: { action: 'none', ids: [], anonymous: 0 }, ledger_effects: [], food_moves: [{ from: 'producer:ghost', to: 'stock:S', amount: 100, cause: 'production' }], cause: { kind: 'produce', driver_event_ids: [], rule_id: 'wp5.produce', rng_stream: null, roll: null }, resolution_change: null, scenario_source: null };
  const vg = caught(p0, [fake], ghost, 'R13-04: ghost producer');
  ok(noCount(vg) && vg.some((x) => x.includes('producer ghost is not a modeled organism')), 'R13-04: the audit independently refuses an unknown producer (balances alone close)');
  refused(() => runDay(p0, [{ day: 0, minute: 1, key: 'fake', kind: 'produce', producer: 'ghost', stock: 'S', region: 'G', amount: 100 }]), 'NO_PRODUCER', 'runDay refuses the same ghost production');
  const live = runDay(p0, [{ day: 0, minute: 1, key: 'live', kind: 'produce', producer: 'W1', stock: 'liveS', region: 'G', amount: 100 }]);
  closed(p0, live.records, live.state, 'R13-04 control: production by a living modeled producer still closes');
  // R3: an individual crossing whose record names the wrong source region; a second unrecorded move rebalances the counts
  {
    const s = world(), f = structuredClone(s);
    f.individuals.find((i) => i.id === 'W1')!.region = 'Pwall'; f.individuals.find((i) => i.id === 'W3')!.region = 'G1';
    const r: LedgerRecord = { ...rec0({ event_id: '1.wrongreg', kind: 'migration', source_region: 'G2', destination_region: 'Pwall', identity: { action: 'kept', ids: ['W1'], anonymous: 0 }, resolution_change: { from: 'fine', to: 'coarse' } }), ledger_effects: [{ region: 'G2', taxon: 'ant', stage: 'worker', colony_id: FOCAL, ledger: 'E', delta: 1 }, { region: 'Pwall', taxon: 'ant', stage: 'worker', colony_id: FOCAL, ledger: 'I', delta: 1 }], cause: { kind: 'foraging_trip', driver_event_ids: ['x'], rule_id: 'wp5.move', rng_stream: null, roll: null } };
    const v = caught(s, [r], f, 'individual moved with a wrong-region migration record');
    ok(noCount(v) && v.some((x) => x.includes("W1 is in G1, not in the record's source G2")) && v.some((x) => x.startsWith('id W3: replay puts it in G2, state has G1')), 'wrong source region and the unrecorded compensating move are both caught per ID');
  }
  // R4: a migration record whose identity is a different (same-kind, same-region) worker than the one that actually moved
  {
    const s = world(), f = structuredClone(s);
    f.individuals.find((i) => i.id === 'W4')!.region = 'Pwall';
    const r: LedgerRecord = { ...rec0({ event_id: '1.wrongid', kind: 'migration', source_region: 'G2', destination_region: 'Pwall', identity: { action: 'kept', ids: ['W3'], anonymous: 0 }, resolution_change: { from: 'fine', to: 'coarse' } }), ledger_effects: [{ region: 'G2', taxon: 'ant', stage: 'worker', colony_id: FOCAL, ledger: 'E', delta: 1 }, { region: 'Pwall', taxon: 'ant', stage: 'worker', colony_id: FOCAL, ledger: 'I', delta: 1 }], cause: { kind: 'foraging_trip', driver_event_ids: ['x'], rule_id: 'wp5.move', rng_stream: null, roll: null } };
    const v = caught(s, [r], f, 'migration with mismatched identity');
    ok(noCount(v) && v.some((x) => x.startsWith('id W3: replay puts it in Pwall, state has G2')) && v.some((x) => x.startsWith('id W4: replay puts it in G2, state has Pwall')), 'the recorded identity, not just the count, must be the organism that moved');
    // a cohort crossing that claims a roster ID the source cohort does not hold
    const moth = cohortId('Pnbr', 'moth', 'adult', null), ok1 = runDay(s, [{ ...t('mm', 700), kind: 'cohort_move', cohort: moth, n: 2, to: 'G2', cause: trig('dispersal_stage_reached') }]);
    closed(s, ok1.records, ok1.state, 'cohort crossing control');
    const forged = structuredClone(ok1.records); forged[0].identity = { action: 'kept', ids: ['X-beetle-1'], anonymous: 1 };
    ok(caught(s, forged, ok1.state, 'cohort crossing with a foreign roster ID').some((x) => x.includes('X-beetle-1 crossed from')), 'a cohort crossing may only carry IDs on the source roster');
  }
  // R5: producer that died earlier the same day (individual) / whose cohort was emptied earlier the same day
  {
    const s = world();
    const a = runDay(s, [{ ...t('pW6', 1), kind: 'produce', producer: 'W6', stock: 'synthW6', region: 'G1', amount: 3 }, { ...t('dW6', 100), kind: 'death', subject: { individual: 'W6' }, cause: 'senescence' }]);
    closed(s, a.records, a.state, 'producer alive at production time (control)');
    const late = structuredClone(a.records); late.find((x) => x.event_id === '1.pW6')!.t.minute = 200;
    ok(caught(s, late, a.state, 'producer that died earlier the same day').some((x) => x.includes('producer W6 is retired (dead) at day 1 minute 200')), 'production after the producer\'s death the same day is caught');
    refused(() => runDay(s, [{ ...t('pW6', 200), kind: 'produce', producer: 'W6', stock: 'synthW6', region: 'G1', amount: 3 }, { ...t('dW6', 100), kind: 'death', subject: { individual: 'W6' }, cause: 'senescence' }]), 'NO_PRODUCER', 'runDay refuses the same order');
    const bee = cohortId('Pnbr', 'beetle', 'adult', null);
    const b = runDay(s, [{ ...t('pB', 1), kind: 'produce', producer: bee, stock: 'synthB', region: 'Pnbr', amount: 3 }, { ...t('dB', 100), kind: 'death', subject: { cohort: bee }, cause: 'cohort_hazard' }]);
    closed(s, b.records, b.state, 'cohort producer alive at production time (control)');
    const lateB = structuredClone(b.records); lateB.find((x) => x.event_id === '1.pB')!.t.minute = 200;
    ok(caught(s, lateB, b.state, 'cohort producer emptied earlier the same day').some((x) => x.includes('has no living member at day 1 minute 200')), 'production by an emptied cohort is caught');
  }
  // R6: retired producer (died on an earlier day)
  {
    const s = { ...world(), retired: ['OLD1'] }, f = structuredClone(s);
    f.producers.OLD1 = -5; f.stocks[0].amount += 5;
    const r: LedgerRecord = { ...rec0({ event_id: '1.old', kind: 'produce', destination_region: 'G2', food_moves: [{ from: 'producer:OLD1', to: 'stock:honeydew.G2', amount: 5, cause: 'production' }] }), cause: { kind: 'produce', driver_event_ids: [], rule_id: 'wp5.produce', rng_stream: null, roll: null } };
    const v = caught(s, [r], f, 'retired producer');
    ok(noCount(v) && v.some((x) => x.includes('producer OLD1 is retired (dead)')), 'a retired producer cannot produce');
    // production is local: a producer in G2 cannot fill a stock in G1
    const aph = cohortId('G2', 'aphid', 'adult', null);
    refused(() => runDay(world(), [{ ...t('far', 1), kind: 'produce', producer: aph, stock: 'far.G1', region: 'G1', amount: 5 }]), 'PRODUCER_REGION_MISMATCH', 'runDay refuses remote production');
    const g = structuredClone(world()); g.producers[aph] = -5; g.stocks.push({ stock_id: 'far.G1', region: 'G1', amount: 5, origin_event_id: '1.far' });
    const rf: LedgerRecord = { ...r, event_id: '1.far', destination_region: 'G1', food_moves: [{ from: `producer:${aph}`, to: 'stock:far.G1', amount: 5, cause: 'production' }] };
    ok(caught(world(), [rf], g, 'remote production').some((x) => x.includes('but the produce record puts the food in G1')), 'the audit catches remote production');
  }
  // R7: a birth needs a parent that is alive at the event time
  {
    const s = world();
    const a = runDay(s, [{ ...t('egg', 300), kind: 'birth', parent: { individual: 'Q1' }, taxon: 'ant', stage: 'egg', colony_id: FOCAL, as: 'individual', endowment: [{ from: 'org:Q1:body_protein', comp: 'body_protein', amount: 1 }] }, { ...t('dQ', 900), kind: 'death', subject: { individual: 'Q1' }, cause: 'senescence' }]);
    closed(s, a.records, a.state, 'birth by a living parent (control)');
    const late = structuredClone(a.records); late.find((x) => x.event_id === '1.egg')!.t.minute = 1000;
    ok(caught(s, late, a.state, 'birth after the parent died').some((x) => x.includes('parent Q1 is not a living modeled organism at day 1 minute 1000 (retired)')), 'a birth from a dead parent is caught');
    const orphan = structuredClone(a.records); orphan.find((x) => x.event_id === '1.egg')!.parent = null;
    ok(caught(s, orphan, a.state, 'birth without a parent').some((x) => x.includes('birth without a recorded parent')), 'a birth record must name its parent');
  }
  // R8: physiology at a representation change: a roster member keeps its snapshot; altering it is caught
  {
    const s = world(), bee = cohortId('Pnbr', 'beetle', 'adult', null);
    const a = runDay(s, [{ ...t('pb', 10), kind: 'promote', cohort: bee, trigger: trig('contact_with_focal') }]);
    const f = structuredClone(a.state); f.individuals.find((i) => i.id === 'X-beetle-1')!.physio = { age_d: 0 };
    ok(caught(s, a.records, f, 'promotion that resets physiology').some((x) => x.startsWith('id X-beetle-1: physiology')), 'promotion must restore the roster snapshot, not a fresh physiology');
    const d = runDay(a.state, [{ day: a.state.day, minute: 20, key: 'db', kind: 'demote', individual: 'X-beetle-1', trigger: trig('no_contact_left_fine_grid') }]);
    const g = structuredClone(d.state); g.cohorts.find((c) => c.cohort_id === bee)!.roster[0].physio = {};
    ok(caught(a.state, d.records, g, 'demotion that drops physiology').some((x) => x.includes('roster physiology of X-beetle-1')), 'demotion must write the individual\'s physiology into the roster');
    const m = runDay(s, [{ ...t('mm', 700), kind: 'cohort_move', cohort: cohortId('Pnbr', 'moth', 'adult', null), n: 10, to: 'G2', cause: trig('dispersal_stage_reached') }]);
    const h = structuredClone(m.state); const r7 = h.cohorts.find((c) => c.roster.some((x) => x.id === 'X-moth-7'))!.roster.find((x) => x.id === 'X-moth-7')!; r7.physio = { age_d: 9 };
    ok(caught(s, m.records, h, 'cohort crossing that swaps roster physiology').some((x) => x.includes('roster physiology of X-moth-7')), 'roster snapshots travel unchanged with a cohort crossing');
  }
}

// ---------------------------------------------------------------- S. allocations re-derived (forged 1/99 of a legitimate 50/50)
{
  const noTotals = (v: string[]) => v.every((x) => !x.startsWith('count ') && !x.startsWith('food ') && !x.startsWith('global mass'));
  const aph2 = cohortId('G2', 'aphid', 'adult', null), bee = cohortId('Pnbr', 'beetle', 'adult', null);
  // a 50/50 world: a 2-member cohort holding 100, a non-focal individual with 100+100, a stock of 100
  const w50 = (): WorldState => {
    const s = world();
    const a = s.cohorts.find((c) => c.cohort_id === aph2)!; a.count = 2; a.comp = { body: 100 };
    s.individuals.push({ id: 'X1', taxon: 'beetle', stage: 'adult', colony_id: null, region: 'Pnbr', physio: {}, comp: { body: 100, gut: 100 } });
    s.individuals.find((i) => i.id === 'W4')!.comp = { crop_sugar: 100, body_protein: 100 };
    s.stocks[0].amount = 100;
    s.scenario_records = [{ ...s.scenario_records[0], from_region: 'G2', to_region: 'R0', subject: { kind: 'cohort', taxon: 'aphid', stage: 'adult', colony_id: null, count: 1 } }];
    return s;
  };
  const bump = (st: WorldState, a: string, d: number) => {
    const p = a.indexOf(':'), k = a.slice(0, p), rest = a.slice(p + 1);
    if (k === 'stock') { st.stocks.find((x) => x.stock_id === rest)!.amount += d; return; }
    if (k === 'sink') { st.sinks[rest] = (st.sinks[rest] ?? 0) + d; return; }
    const q = rest.lastIndexOf(':'), id = rest.slice(0, q), c = rest.slice(q + 1);
    const o = k === 'org' ? st.individuals.find((x) => x.id === id)! : st.cohorts.find((x) => x.cohort_id === id)!;
    o.comp[c] = (o.comp[c] ?? 0) + d;
  };
  // the recipient of move i gets `amt` instead; the source keeps the difference (every total still closes)
  const reamount = (r: LedgerRecord[], f: WorldState, ev: string, i: number, amt: number) => { const m = r.find((x) => x.event_id === ev)!.food_moves[i], d = amt - m.amount; m.amount = amt; bump(f, m.to, d); bump(f, m.from, -d); };
  // move i keeps `amt` for its recipient, the rest goes to another existing recipient
  const redirect = (r: LedgerRecord[], f: WorldState, ev: string, i: number, amt: number, other: string) => { const x = r.find((y) => y.event_id === ev)!, m = x.food_moves[i], rest = m.amount - amt; m.amount = amt; x.food_moves.push({ ...m, to: other, amount: rest }); bump(f, m.to, -rest); bump(f, other, rest); };
  const sites: [string, Command, (r: LedgerRecord[], f: WorldState) => void, number][] = [
    ['promotion share', { ...t('sp', 1), kind: 'promote', cohort: aph2, trigger: trig('contact_with_focal') }, (r, f) => reamount(r, f, '1.sp', 0, 1), 50],
    ['cohort death share', { ...t('sd', 1), kind: 'death', subject: { cohort: aph2 }, cause: 'cohort_hazard' }, (r, f) => reamount(r, f, '1.sd', 0, 1), 50],
    ['cohort_move share', { ...t('sm', 1), kind: 'cohort_move', cohort: aph2, n: 1, to: 'G1', cause: trig('dispersal_stage_reached') }, (r, f) => reamount(r, f, '1.sm', 0, 1), 50],
    ['transport share', { ...t('st', 1), kind: 'transport', record_id: 'TR1' }, (r, f) => reamount(r, f, '1.st', 0, 1), 50],
    ['individual death body -> corpse compartments', { ...t('sdi', 1), kind: 'death', subject: { individual: 'W4' }, cause: 'senescence' }, (r, f) => redirect(r, f, '1.sdi', 0, 1, 'stock:corpse.1.sdi.crop_sugar'), 100],
    ['demotion pooling', { ...t('sdm', 1), kind: 'demote', individual: 'X1', trigger: trig('no_contact_left_fine_grid') }, (r, f) => redirect(r, f, '1.sdm', 0, 1, `cohort:${bee}:gut`), 100],
    ['decay stock vs sink', { ...t('sk', 1), kind: 'decay', stock: 'honeydew.G2', decomposition: { num: 1, den: 2 }, clear_below: 0 }, (r, f) => reamount(r, f, '1.sk', 0, 99), 50],
  ];
  for (const [name, cmd, forge, legit] of sites) {
    const s = w50(), d = runDay(s, [cmd]);
    closed(s, d.records, d.state, `${name}: legitimate control`);
    ok(d.records[0].food_moves[0].amount === legit, `${name}: the legitimate split gives ${legit}`);
    const r = structuredClone(d.records), f = structuredClone(d.state); forge(r, f);
    const v = auditDay(s, r, f);
    ok(v.length > 0 && noTotals(v) && v.some((x) => x.includes(': allocation ') && x.includes('on the replayed balances gives')), `${name}: forged 1/99 caught by the re-derived allocation although every total closes (${v[0] ?? 'ACCEPTED'})`);
  }
  // multi-member crossing: 3 members leave a 40-member pool; the group carries too little (rest stays behind) -> caught
  {
    const s = world(), d = runDay(s, [{ ...t('m3', 1), kind: 'cohort_move', cohort: aph2, n: 3, to: 'G1', cause: trig('dispersal_stage_reached') }]);
    closed(s, d.records, d.state, 'multi-member crossing control');
    const r = structuredClone(d.records), f = structuredClone(d.state); reamount(r, f, '1.m3', 2, 1);
    ok(auditDay(s, r, f).some((x) => x.includes('allocation cohort:C|G2|aphid|adult|-:body -> cohort:C|G1|aphid|adult|-:body')), 'multi-member crossing: a shifted share is caught');
  }
  // a rule-determined record that drops or changes its allocation declaration is caught
  {
    const s = w50(), d = runDay(s, [{ ...t('sp', 1), kind: 'promote', cohort: aph2, trigger: trig('contact_with_focal') }]);
    const r = structuredClone(d.records); r[0].allocation = null;
    ok(auditDay(s, r, d.state).some((x) => x.includes('allocation rule (none)')), 'a promotion without its allocation rule is caught');
    const r2 = structuredClone(d.records); r2[0].allocation = { rule: 'free_input', basis: 'forged' };
    ok(auditDay(s, r2, d.state).some((x) => x.includes('allocation rule free_input')), 'a rule-determined split cannot be relabelled as a free input');
    const k = runDay(s, [{ ...t('sk', 1), kind: 'decay', stock: 'honeydew.G2', decomposition: { num: 1, den: 2 }, clear_below: 0 }]);
    const r3 = structuredClone(k.records); r3[0].allocation = null;
    ok(auditDay(s, r3, k.state).some((x) => x.includes('a decay record must carry')), 'a decay record without its rate inputs is caught (amounts unverifiable without them)');
    const c = runDay(s, [{ ...t('sc', 1), kind: 'decay', stock: 'honeydew.G2', decomposition: { num: 1, den: 10 }, clear_below: 1000 }]);
    closed(s, c.records, c.state, 'decay with remainder clearing (control)');
    ok(c.state.sinks.decomposition === 100 && c.records[0].food_moves.length === 2, 'decay control: floor(100/10)=10 decomposed, remainder 90 < 1000 cleared by an explicit flow (no deletion: all 100 in sink:decomposition)');
  }
  // free-input amounts: reported as unverifiable, never claimed checked; the legitimate mixed day lists exactly them
  {
    const det = auditDayDetailed(s0, day.records, day.state);
    assert.deepEqual(det.violations, [], 'mixed day still closes'); checks++;
    const freeIds = day.records.filter((r) => r.allocation?.rule === 'free_input' && r.food_moves.length > 0).map((r) => r.event_id).sort();
    ok(freeIds.join() === ['1.aphb1', '1.col1', '1.egg1', '1.prod1', '1.tro1'].join() && det.unverified_shares.map((x) => x.split(':')[0]).sort().join() === freeIds.join(), `free-input records (${freeIds.join(', ')}) are listed as unverifiable shares, and only they`);
    const f = structuredClone(day.state), r = structuredClone(day.records); reamount(r, f, '1.tro1', 0, 1);
    const fv = auditDayDetailed(s0, r, f);
    ok(fv.violations.length === 0 && fv.unverified_shares.some((x) => x.startsWith('1.tro1:') && x.includes(' 1')), 'honest limit: a re-amounted food_transfer (a command input, no rule) is NOT caught; the audit says so in unverified_shares');
  }
  // runDay refuses invalid split inputs instead of booking them
  refused(() => runDay(world(), [{ ...t('bk', 1), kind: 'decay', stock: 'honeydew.G2', decomposition: { num: 3, den: 2 }, clear_below: 0 }]), 'BAD_RATE', 'decomposition > 1 refused');
  refused(() => runDay(world(), [{ ...t('bk', 1), kind: 'decay', stock: 'honeydew.G2', decomposition: { num: 1, den: 0 }, clear_below: 0 }]), 'BAD_RATE', 'zero denominator refused');
  refused(() => runDay(world(), [{ ...t('bk', 1), kind: 'decay', stock: 'honeydew.G2', decomposition: { num: 1, den: 2 }, clear_below: -1 }]), 'BAD_RATE', 'negative clear_below refused');
  refused(() => runDay(world(), [{ ...t('be', 1), kind: 'birth', parent: { individual: 'Q1' }, taxon: 'ant', stage: 'egg', colony_id: FOCAL, as: 'individual', endowment: [{ from: 'org:Q1:body_protein', comp: 'body_protein', amount: 1.5 }] }]), 'BAD_AMOUNT', 'a fractional endowment is refused');
}

// ---------------------------------------------------------------- H. isolation
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (e.name === 'node_modules' || e.name === 'data' ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
  const official = [...walk(path.join(REPO_ROOT, 'engine')), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src'))];
  const refers = (src: string) => /['"`][^'"`\n]*mixed-precision[^'"`\n]*['"`]/.test(strip(src));
  for (const form of ["import { a } from '../prototypes/mixed-precision/ledger.ts';", "await import('../../prototypes/mixed-precision/audit.ts')", "export * from '../prototypes/mixed-precision/decay.ts';"]) ok(refers(form), `detector catches: ${form}`);
  ok(official.length > 30, `scanned ${official.length} official files`);
  const offenders = official.filter((f) => refers(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, [], 'engine/, cli/ and web/src must not reference the WP5 prototype'); checks++;
  const dir = path.join(REPO_ROOT, 'prototypes/mixed-precision');
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
    const src = strip(fs.readFileSync(path.join(dir, f), 'utf8'));
    const imports = [...src.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    if (f === 'bench.ts') { ok(imports.every((x) => x.startsWith('./') || x === 'node:perf_hooks'), `${f}: imports only the prototype (bench may use the clock)`); continue; }
    ok(imports.every((x) => /^\.\/[a-z-]+\.ts$/.test(x)), `${f}: imports only sibling prototype files (no engine/, cli/, node:)`);
    ok(!/Math\.random|Date\.now|new Date\(|performance\./.test(src), `${f}: no unseeded randomness or wall clock`);
    ok(!/pheidole|megacephala|species_id\s*===/i.test(src), `${f}: no species-specific branch`);
    ok(!/\b(process|window|document|globalThis)\s*\./.test(src), `${f}: no platform API`);
  }
  const fp = fs.readFileSync(path.join(REPO_ROOT, 'cli/lib/fingerprint.ts'), 'utf8');
  ok(!/prototypes/.test(strip(fp)), 'the rules fingerprint does not cover prototypes/ (the prototype is not a rule)');
}

console.log(JSON.stringify({ wp5_mixed_precision: 'pass', checks }, null, 2));
