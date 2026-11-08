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
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import {
  runDay, indexState, exportState, applyCommand, canonicalJson, cohortId, draw, LedgerRefusal,
  type WorldState, type Command, type LedgerRecord,
} from '../prototypes/mixed-precision/ledger.ts';
import { auditDay, totalCount, totalMass, placesOf } from '../prototypes/mixed-precision/audit.ts';
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
