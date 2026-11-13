/**
 * CQ-1 colony members (engine/colony/members.ts, docs/colony-members-cq1.md) — isolated module, NOT wired into a world.
 *
 *  1. parameter file: schema, caste switches with evidence classes and existing sources; negative fixtures
 *  2. multi-queen independence: adding / removing / killing queen B, or interleaving calls differently, never changes
 *     queen A's events, random stream, ledger or egg ids
 *  3. no single-queen shortcut: N queens → N independent ledgers, chains, streams and egg-id spaces
 *  4. provenance: every egg / eclosed worker names a mother queen that existed and was alive at laying; the egg's
 *     provisioning is debited from HER ledger (exact integers); audit balances
 *  5. candidates OFF (reference) → zero eggs, no fate, no metabolism; oviposition without an egg cost or with a zero cost
 *     is refused; an empty reserve lays nothing
 *  6. a dead queen lays nothing and cannot receive food; death records keep the body's ledger
 *  7. castes only via the parameter file: a monomorphic fixture (major disabled) works without code changes; no species
 *     name in engine/colony (static, with a negative fixture)
 *  8. snapshot / restore byte-identical; split + restore + continue == one run; metabolism booking split-invariant
 *  9. locality: static (no colony identifiers; candidates are called only with own-view builders that take one member)
 *     and runtime (views have exactly the own keys; a counterfactual crowd of other members does not change them)
 * 10. isolation: nothing official / Worker / P0-A2 imports engine/colony; engine/colony imports only ../rng.ts, ../sha256.ts;
 *     deterministic-math rule of the worker boundary; no platform API
 * 11. viewer data shape (caste, queen id, mother id, candidate ids, 尚未模擬 list)
 *
 * The test-only candidate ports below are NOT science: they exist to drive the accounting. Their ids say so.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import {
  type Amount, type MembersState, type MemberParams, type Ports, NULL_PORTS, canon, NOT_SIMULATED, addQueen, addWorker, audit, bookMetabolism,
  decideCasteFate, eclose, memberParams, newMembers, oviposit, receiveFood, recordDeath, restore, snapshot, viewerData, zero,
} from '../engine/colony/members.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const eq = (a: unknown, b: unknown, why: string) => { assert.deepEqual(a, b, why); checks++; };
const throws = (f: () => unknown, re: RegExp, why: string) => { assert.throws(f, re, why); checks++; };
const A = (s: number, p: number, e = 0): Amount => ({ sugar_ug: s, protein_ug: p, energy_uj: e });
const HOUR = 3_600_000, DAY = 24 * HOUR;

// ------------------------------------------------------------------ 1. parameter file
const RAW = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/colony-members/cq1-params.json'), 'utf8'));
const P = memberParams(RAW);
const refs = fs.readFileSync(path.join(REPO_ROOT, 'docs/references.md'), 'utf8');
ok(P.worker_castes.minor.enabled && P.worker_castes.major.enabled, 'candidate file enables minor and major');
for (const c of ['minor', 'major']) {
  const e = RAW.worker_castes[c];
  ok(['literature_this_species', 'literature_other_species', 'general_physiology', 'game_assumption'].includes(e.evidence), `${c} has an evidence class`);
  for (const r of e.sources) ok(new RegExp(`\\| ${r} \\|`).test(refs), `${c} source ${r} exists in docs/references.md`);
}
ok(RAW.queen_count.assumption === true && RAW.queen_count.evidence === 'game_assumption', 'queen count is labelled an assumption');
eq(RAW.queen_count.default_candidates, [2, 3], 'queen count default 2–3 (Owner #202)'); eq(RAW.queen_count.sensitivity, [1, 3], 'sensitivity 1–3');
for (const r of RAW.queen_count.sources) ok(new RegExp(`\\| ${r}(／| \\|)`).test(refs), `queen-count source ${r} exists`);
for (const k of ['oviposition', 'egg_cost', 'caste_fate']) ok(RAW.candidates[k] === null, `${k} candidate is null (尚未模擬)`);
ok(Object.values(RAW.candidates.metabolism).every((v) => v === null), 'metabolism candidates are null');
throws(() => memberParams({ ...RAW, schema: 'x' }), /schema/, 'bad schema refused');
throws(() => memberParams({ ...RAW, worker_castes: { minor: { enabled: false }, major: { enabled: false } } }), /at least one/, 'no caste refused');
throws(() => memberParams({ ...RAW, worker_castes: { minor: { enabled: 'yes' }, major: { enabled: true } } }), /booleans/, 'non-boolean switch refused');

// ------------------------------------------------------------------ test-only candidate ports (NOT science)
const additive = (rate: Amount) => (v: { from_t: number; to_t: number }): Amount => {
  const at = (t: number) => ({ sugar_ug: Math.floor(rate.sugar_ug * t / DAY), protein_ug: Math.floor(rate.protein_ug * t / DAY), energy_uj: Math.floor(rate.energy_uj * t / DAY) });
  const a = at(v.from_t), b = at(v.to_t); return { sugar_ug: b.sugar_ug - a.sugar_ug, protein_ug: b.protein_ug - a.protein_ug, energy_uj: b.energy_uj - a.energy_uj };
};
const TEST: Ports = {
  oviposition: { id: 'test_only_uniform_0_3', assumption: true, evidence: 'test_only', eggs: (_v, u) => Math.floor(u() * 4) },
  egg_cost: { id: 'test_only_cost', assumption: true, evidence: 'test_only', cost: () => A(7, 3, 11) },
  caste_fate: { id: 'test_only_coin', assumption: true, evidence: 'test_only', fate: (_v, u) => (u() < 0.3 ? 'major' : 'minor') },
  metabolism: {
    queen: { id: 'test_only_q', assumption: true, evidence: 'test_only', demand: additive(A(13, 5, 17)) },
    worker_minor: { id: 'test_only_mi', assumption: true, evidence: 'test_only', demand: additive(A(3, 1, 2)) },
    worker_major: { id: 'test_only_ma', assumption: true, evidence: 'test_only', demand: additive(A(9, 2, 6)) },
    worker_unknown: null,
  },
};

/** a per-queen schedule: food every 5 h, metabolism every 7 h, laying every 3 h — each queen's calls depend only on herself */
type Call = { t: number; q: string; what: 'food' | 'metab' | 'ovi' };
const schedule = (qs: string[], until: number): Call[] => {
  const out: Call[] = [];
  for (const q of qs) for (let t = HOUR; t <= until; t += HOUR) {
    if (t % (5 * HOUR) === 0) out.push({ t, q, what: 'food' });
    if (t % (7 * HOUR) === 0) out.push({ t, q, what: 'metab' });
    if (t % (3 * HOUR) === 0) out.push({ t, q, what: 'ovi' });
  }
  return out.sort((a, b) => a.t - b.t || (a.q < b.q ? -1 : a.q > b.q ? 1 : 0));
};
const apply = (s: MembersState, ports: Ports, c: Call) => {
  if (!s.queens[c.q].alive) { if (c.what === 'ovi') eq(oviposit(s, ports, c.q, c.t), null, 'dead queen: no oviposition event'); return; }
  if (c.what === 'food') receiveFood(s, c.q, c.t, A(40, 25, 60), `src:${c.q}:${c.t}`);
  else if (c.what === 'metab') bookMetabolism(s, ports, c.q, c.t);
  else oviposit(s, ports, c.q, c.t);
};
const world = (qs: string[], until: number, ports = TEST, seed = 7, extra?: (s: MembersState) => void, order: 'asc' | 'desc' = 'asc') => {
  const s = newMembers(seed);
  for (const q of qs) addQueen(s, q, 0, A(100, 60, 200));
  extra?.(s);
  let cs = schedule(qs, until);
  if (order === 'desc') cs = cs.sort((a, b) => a.t - b.t || (a.q < b.q ? 1 : a.q > b.q ? -1 : 0));
  for (const c of cs) apply(s, ports, c);
  return s;
};
const queenTrace = (s: MembersState, q: string) => ({ queen: s.queens[q], eggs: Object.values(s.brood).filter((b) => b.mother_queen_id === q).map((b) => [b.id, b.chain, b.ledger]) });

// ------------------------------------------------------------------ 2. multi-queen independence
{
  const DAYS = 6 * DAY;
  const solo = world(['QA'], DAYS), duo = world(['QA', 'QB'], DAYS), trio = world(['QA', 'QB', 'QC'], DAYS);
  ok(solo.queens.QA.eggs_laid > 0, 'queen A lays under the test candidate');
  eq(queenTrace(duo, 'QA'), queenTrace(solo, 'QA'), 'adding queen B does not change queen A');
  eq(queenTrace(trio, 'QA'), queenTrace(solo, 'QA'), 'adding queens B and C does not change queen A');
  eq(queenTrace(world(['QA', 'QB'], DAYS, TEST, 7, undefined, 'desc'), 'QA'), queenTrace(duo, 'QA'), 'call interleaving order of other queens does not change queen A');
  // queen B dies mid-run (cause from an outside death model; hazards are 尚未模擬)
  const s = newMembers(7); addQueen(s, 'QA', 0, A(100, 60, 200)); addQueen(s, 'QB', 0, A(100, 60, 200));
  for (const c of schedule(['QA', 'QB'], DAYS)) { if (c.q === 'QB' && c.t === 2 * DAY && s.queens.QB.alive) recordDeath(s, 'QB', c.t, 'test_only_external'); apply(s, TEST, c); }
  eq(queenTrace(s, 'QA'), queenTrace(solo, 'QA'), 'queen B dying does not change queen A');
  ok(Object.values(s.brood).filter((b) => b.mother_queen_id === 'QB').every((b) => b.added_t <= 2 * DAY), 'dead queen B laid nothing after her death');
  ok(s.queens.QB.eggs_laid < duo.queens.QB.eggs_laid, 'queen B lays less when she dies early (sanity)');

  // ------------------------------------------------------------------ 3. no single-queen shortcut
  const qs = ['QA', 'QB', 'QC'];
  const chains = new Set(qs.map((q) => trio.queens[q].chain)); eq(chains.size, 3, 'three queens → three own hash chains');
  const layings = qs.map((q) => canon(trio.queens[q].ledger)); eq(new Set(layings).size, 3, 'three queens → three different own ledgers');
  for (const q of qs) ok(Object.keys(trio.brood).filter((id) => id.startsWith(`${q}.egg`)).every((id) => trio.brood[id].mother_queen_id === q), `${q} egg ids are in her own id space`);
  for (const q of qs) eq(queenTrace(trio, q), queenTrace(world([q], DAYS), q), `${q} in a 3-queen colony == ${q} alone (no shared stream or ledger)`);
  // the same queen id in another world seed draws another stream
  ok(world(['QA'], DAYS, TEST, 8).queens.QA.chain !== solo.queens.QA.chain, 'other seed → other stream');

  // ------------------------------------------------------------------ 4. provenance and debit
  for (const w of [solo, duo, trio, s]) {
    ok(audit(w).balanced, 'exact integer audit balances (initial + received = held + metabolised; eggs = moved from mothers)');
    for (const b of Object.values(w.brood)) {
      const m = w.queens[b.mother_queen_id];
      ok(m !== undefined, `${b.id}: mother exists`);
      ok(b.laid_event_id.startsWith(`${m.id}#`), `${b.id}: laid by an event of its mother`);
      const death = w.deaths.find((d) => d.id === m.id);
      ok(!death || death.t >= b.added_t, `${b.id}: mother was alive when it was laid`);
      ok(canon(b.ledger.initial) !== canon(zero()), `${b.id}: egg carries provisioning (not from nothing)`);
    }
    for (const q of Object.values(w.queens)) {
      const kids = Object.values(w.brood).filter((b) => b.mother_queen_id === q.id);
      eq(kids.length, q.eggs_laid, `${q.id}: egg count matches her own counter`);
      eq(q.ledger.to_eggs, kids.reduce((a, b) => A(a.sugar_ug + b.ledger.initial.sugar_ug, a.protein_ug + b.ledger.initial.protein_ug, a.energy_uj + b.ledger.initial.energy_uj), zero()), `${q.id}: debited exactly what her eggs carry`);
    }
  }

  // ------------------------------------------------------------------ 8. snapshot / restore, split invariance
  const full = world(['QA', 'QB'], DAYS);
  const half = newMembers(7); addQueen(half, 'QA', 0, A(100, 60, 200)); addQueen(half, 'QB', 0, A(100, 60, 200));
  const cs = schedule(['QA', 'QB'], DAYS), cut = cs.findIndex((c) => c.t > 3 * DAY);
  for (const c of cs.slice(0, cut)) apply(half, TEST, c);
  const text = snapshot(half), back = restore(text);
  eq(snapshot(back), text, 'snapshot → restore → snapshot is byte-identical');
  for (const c of cs.slice(cut)) apply(back, TEST, c);
  eq(snapshot(back), snapshot(full), 'run to day 3 + save + restore + run on == one run (byte-identical)');
  throws(() => restore(text.replace('"official":false', '"official":true')), /non-official/, 'an official-flagged snapshot is refused');
  throws(() => restore(JSON.stringify(JSON.parse(text), null, 1)), /canonical/, 'a non-canonical snapshot is refused');
}

// metabolism booking: many small bookings == one booking (additive port), deficit when empty
{
  const many = newMembers(1), one = newMembers(1);
  for (const s of [many, one]) addQueen(s, 'Q1', 0, A(5000, 5000, 5000));
  for (let t = 37_000; t < 3 * DAY; t += 37_000) bookMetabolism(many, TEST, 'Q1', t);
  bookMetabolism(many, TEST, 'Q1', 3 * DAY); bookMetabolism(one, TEST, 'Q1', 3 * DAY);
  eq(many.queens.Q1.ledger.have, one.queens.Q1.ledger.have, 'metabolism booking is split-invariant');
  eq(one.queens.Q1.ledger.metabolised, A(39, 15, 51), 'additive test port: 3 days of the test rate');
  const st = newMembers(1); addQueen(st, 'Q1', 0, A(1, 0, 0)); bookMetabolism(st, TEST, 'Q1', DAY);
  eq(st.queens.Q1.ledger.have, zero(), 'an empty reserve pays what it has'); eq(st.queens.Q1.ledger.deficit, A(12, 5, 17), 'the rest is her own deficit');
  ok(audit(st).balanced, 'deficit is not food: audit still balances');
  eq(bookMetabolism(st, NULL_PORTS, 'Q1', 2 * DAY), null, 'null metabolism port: nothing booked (尚未模擬)');
}

// ------------------------------------------------------------------ 5. candidates OFF → nothing
{
  const s = world(['QA', 'QB', 'QC'], 10 * DAY, NULL_PORTS);
  eq(Object.keys(s.brood).length, 0, 'oviposition candidate OFF → zero eggs');
  ok(Object.values(s.queens).every((q) => q.eggs_laid === 0 && canon(q.ledger.metabolised) === canon(zero())), 'no eggs, no metabolism with every candidate OFF');
  const t = newMembers(1); addQueen(t, 'Q', 0, A(100, 100, 100));
  throws(() => oviposit(t, { ...TEST, egg_cost: null }, 'Q', HOUR), /egg-cost/, 'oviposition without an egg cost is refused');
  throws(() => oviposit(t, { ...TEST, egg_cost: { ...TEST.egg_cost!, cost: () => zero() } }, 'Q', HOUR), /cost something/, 'zero-cost egg is refused');
  throws(() => oviposit(t, { ...TEST, oviposition: { ...TEST.oviposition!, eggs: () => 1.5 } }, 'Q', HOUR), /returned/, 'non-integer egg request is refused');
  const e = newMembers(1); addQueen(e, 'Q', 0, zero());
  const always3: Ports = { ...TEST, oviposition: { ...TEST.oviposition!, eggs: () => 3 } };
  const ev = oviposit(e, always3, 'Q', HOUR)!;
  eq([ev.p.requested, ev.p.laid, ev.p.limited_by_own_reserve], [3, 0, true], 'empty own reserve → requested 3, laid 0');
  receiveFood(e, 'Q', 2 * HOUR, A(15, 100, 100), 'src');
  eq(oviposit(e, always3, 'Q', 3 * HOUR)!.p.laid, 2, 'reserve for 2 eggs (sugar 15 / 7) → 2 laid');
  ok(audit(e).balanced, 'audit balances after limited laying');
}

// ------------------------------------------------------------------ 6. death
{
  const s = newMembers(3); addQueen(s, 'Q', 0, A(50, 50, 50));
  const ev = recordDeath(s, 'Q', HOUR, 'test_only_external');
  eq(s.deaths, [{ id: 'Q', kind: 'queen', t: HOUR, cause: 'test_only_external', event_id: ev.id, ledger_at_death: A(50, 50, 50) }], 'death record keeps the body ledger');
  eq(oviposit(s, TEST, 'Q', 2 * HOUR), null, 'dead queen lays nothing');
  throws(() => receiveFood(s, 'Q', 2 * HOUR, A(1, 1, 1), 'src'), /dead/, 'dead queen cannot receive food');
  throws(() => recordDeath(s, 'Q', 3 * HOUR, 'x'), /already dead/, 'no double death');
  eq(bookMetabolism(s, TEST, 'Q', DAY), null, 'dead queen books no metabolism');
  ok(audit(s).balanced, 'audit balances with a dead queen');
  throws(() => receiveFood(s, 'nobody', HOUR, A(1, 1, 1), 'src'), /unknown/, 'unknown member refused');
  throws(() => recordDeath(newMembers(1), 'x', 0, 'c'), /unknown/, 'unknown death refused');
}

// ------------------------------------------------------------------ 7. castes only via parameters
{
  const mono: MemberParams = memberParams({ ...RAW, worker_castes: { minor: { enabled: true }, major: { enabled: false } } });
  const s = newMembers(5); addQueen(s, 'Q', 0, A(1000, 1000, 1000));
  throws(() => addWorker(s, mono, 'W1', 0, 'major', zero()), /not enabled/, 'monomorphic params: no major worker');
  addWorker(s, mono, 'W1', 0, 'minor', A(4, 4, 4)); addWorker(s, mono, 'W2', 0, null, zero());
  oviposit(s, { ...TEST, oviposition: { ...TEST.oviposition!, eggs: () => 3 } }, 'Q', HOUR);
  const always: Ports = { ...TEST, caste_fate: { ...TEST.caste_fate!, fate: () => 'major' } };
  throws(() => decideCasteFate(s, mono, always, 'Q.egg0', 2 * HOUR), /not enabled/, 'monomorphic params: a major fate is refused');
  eq(decideCasteFate(s, mono, NULL_PORTS, 'Q.egg0', 2 * HOUR), null, 'null caste candidate: stays undetermined');
  eclose(s, mono, 'Q.egg0', DAY);
  eq([s.workers['Q.egg0'].caste, s.workers['Q.egg0'].caste_source, s.workers['Q.egg0'].mother_queen_id], ['minor', 'single_caste_params', 'Q'], 'monomorphic species: worker caste from params, mother kept');
  // dimorphic: undetermined at eclosion → caste null (NOT minor by default); decided fate → that caste
  const d = newMembers(5); addQueen(d, 'Q', 0, A(1000, 1000, 1000));
  oviposit(d, { ...TEST, oviposition: { ...TEST.oviposition!, eggs: () => 2 } }, 'Q', HOUR);
  decideCasteFate(d, P, always, 'Q.egg1', 2 * HOUR);
  eq(d.brood['Q.egg1'].caste_fate, 'major', 'fate set by the candidate'); ok(d.brood['Q.egg1'].caste_fate_event_id?.startsWith('Q.egg1#'), 'fate event is the brood item\'s own');
  eq(decideCasteFate(d, P, { ...TEST, caste_fate: { ...TEST.caste_fate!, fate: () => 'minor' } }, 'Q.egg1', 3 * HOUR), null, 'a decided fate is not re-decided');
  eclose(d, P, 'Q.egg0', DAY); eclose(d, P, 'Q.egg1', DAY);
  eq([d.workers['Q.egg0'].caste, d.workers['Q.egg0'].caste_source], [null, 'fate_not_modelled'], 'dimorphic, undetermined → caste null, not a silent minor');
  eq([d.workers['Q.egg1'].caste, d.workers['Q.egg1'].caste_source], ['major', 'developed_in_model'], 'decided major → major developed in model');
  ok(audit(d).balanced, 'audit balances across eclosion');
  // metabolism port by caste
  receiveFood(d, 'Q.egg1', DAY, A(100, 100, 100), 'test_src'); bookMetabolism(d, TEST, 'Q.egg1', 2 * DAY); eq(d.workers['Q.egg1'].ledger.metabolised, A(9, 2, 6), 'major books the major port');
  eq(bookMetabolism(d, TEST, 'Q.egg0', 2 * DAY), null, 'unknown caste uses its own (null) port, not the minor one');
  // static: no species names in engine/colony; detector bites on a fixture
  const speciesRe = /pheidole|megacephala|solenopsis|linepithema|anoplolepis|species_id|speciesId/i;
  ok(speciesRe.test("if (sp.id === 'pheidole-megacephala') caste = 'major';"), 'species-name detector bites');
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'engine/colony'))) ok(!speciesRe.test(code(`engine/colony/${f}`)), `engine/colony/${f}: no species name in code`);
}

// ------------------------------------------------------------------ 9. locality
{
  // runtime: the views carry exactly the own keys, and a crowd of other members never changes them
  const seen: string[] = [];
  const spy: Ports = {
    ...TEST,
    oviposition: { ...TEST.oviposition!, eggs: (v, u) => { seen.push(`ovi:${Object.keys(v).sort().join(',')}:${canon(v)}`); return TEST.oviposition!.eggs(v, u); } },
    caste_fate: { ...TEST.caste_fate!, fate: (v, u) => { seen.push(`caste:${Object.keys(v).sort().join(',')}`); return TEST.caste_fate!.fate(v, u); } },
  };
  const run = (crowd: boolean) => {
    seen.length = 0;
    const s = world(['QA'], 2 * DAY, spy, 9, crowd ? (w) => { addQueen(w, 'QZ', 0, A(9e6, 9e6, 9e6)); for (let i = 0; i < 100; i++) addWorker(w, P, `W${i}`, 0, i % 7 === 0 ? 'major' : 'minor', A(9, 9, 9)); } : undefined);
    for (const b of Object.keys(s.brood).filter((id) => id.startsWith('QA.'))) decideCasteFate(s, P, spy, b, 3 * DAY);
    return [...seen];
  };
  const alone = run(false), crowded = run(true);
  ok(alone.length > 5, 'the spy saw candidate calls');
  eq(crowded, alone, 'a crowd of other queens and 100 workers does not change anything queen A or her brood perceive');
  ok(alone.filter((x) => x.startsWith('ovi:')).every((x) => x.startsWith('ovi:age_ms,deficit,have,received,since_last_oviposition_ms:')), 'queen view = her own keys only');
  ok(alone.filter((x) => x.startsWith('caste:')).every((x) => x === 'caste:age_ms,have,received'), 'brood view = its own keys only');
  // static
  const src = code('engine/colony/members.ts'), raw = fs.readFileSync(path.join(REPO_ROOT, 'engine/colony/members.ts'), 'utf8');
  ok(!/\bcolon(y|ies)\b|\bnest_?total|days_short|\bpopulation\b/i.test(src), 'members.ts names no colony-level state');
  ok(/export function queenOwnView\(q: Queen, t: number\)/.test(raw) && /export function broodOwnView\(b: Brood, t: number\)/.test(raw), 'own-view builders take ONE member and the instant (no state)');
  const body = (name: string) => raw.slice(raw.indexOf(`export function ${name}(`), raw.indexOf('\n}\n', raw.indexOf(`export function ${name}(`)));
  for (const n of ['queenOwnView', 'broodOwnView']) ok(!/\bs\.|state|queens|workers|brood\b/.test(body(n).replace(/^[^{]*\{/, '')), `${n} body reads only its own member`);
  const calls = [...src.matchAll(/\.(eggs|cost|fate)\(([^,)]*)/g)];
  ok(calls.length >= 3, 'candidate call sites found');
  for (const m of calls) ok(/^(queenOwnView|broodOwnView)$/.test(m[2].trim().replace(/\(.*$/, '')) || m[2].trim() === 'view', `candidate .${m[1]}( is called with an own view (${m[2]})`);
  ok(/const view = queenOwnView\(q, t\)/.test(src), 'the `view` variable is the queen\'s own view');
  // negative fixture for the colony-state detector
  ok(/\bcolon(y|ies)\b/i.test('const v = { have: q.ledger.have, colony_sugar: colony.sugar };'), 'colony-state detector bites');
}

// ------------------------------------------------------------------ 10. isolation and purity
{
  const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [path.join(d, e.name)] : []) : [];
  const refersTo = (s: string) => /['"`][^'"`\n]*colony\/members[^'"`\n]*['"`]/.test(s);
  ok(refersTo("import { x } from '../engine/colony/members.ts';"), 'import detector bites');
  const scanned = [...fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).map((f) => path.join(REPO_ROOT, 'engine', f)),
    ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src')), ...walk(path.join(REPO_ROOT, 'prototypes/continuous-world')), ...walk(path.join(REPO_ROOT, 'prototypes/p0a2-24h'))];
  ok(scanned.length > 50, 'isolation scan covers the official engine, cli, web, Worker and P0-A2');
  for (const f of scanned) ok(!refersTo(fs.readFileSync(f, 'utf8')), `${path.relative(REPO_ROOT, f)} does not import engine/colony (not wired yet)`);
  const boundary = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/continuous-world/worker-boundary.json'), 'utf8'));
  const allowedMath = new Set<string>(boundary.deterministic_math_in_worker_graph.allowed_math_members);
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'engine/colony'))) {
    const rel = `engine/colony/${f}`, raw = fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'), c = code(rel);
    for (const m of raw.matchAll(/from\s+'([^']+)'/g)) ok(['../rng.ts', '../sha256.ts'].includes(m[1]) || /^\.\/[a-z0-9-]+\.ts$/.test(m[1]), `${rel} imports only ../rng.ts, ../sha256.ts or its own dir (${m[1]})`);
    for (const m of c.matchAll(/\bMath\.([A-Za-z0-9_]+)/g)) ok(allowedMath.has(m[1]), `${rel}: Math.${m[1]} is IEEE-exact (worker-boundary rule)`);
    ok(!/\*\*/.test(c), `${rel}: no ** operator`);
    for (const bad of boundary.forbidden_in_engine_modules as string[]) ok(!c.includes(bad), `${rel}: no ${bad}`);
    ok(!/\b(process|window|document|localStorage|indexedDB|globalThis|Buffer|navigator)\b|\brequire\s*\(|\bfetch\s*\(/.test(c), `${rel}: no platform API`);
    ok(!/saves\/|journal\//.test(raw), `${rel}: no official save / journal path`);
  }
}

// ------------------------------------------------------------------ 11. viewer data shape
{
  const s = newMembers(2); addQueen(s, 'QA', 0, A(500, 500, 500)); addQueen(s, 'QB', 0, A(500, 500, 500)); addWorker(s, P, 'W1', 0, 'major', zero());
  oviposit(s, { ...TEST, oviposition: { ...TEST.oviposition!, eggs: () => 1 } }, 'QB', HOUR);
  const v = viewerData(s, NULL_PORTS);
  eq(v.members.map((m) => [m.id, m.kind, m.caste, m.queen_id, m.mother_queen_id, m.caste_fate]), [['QA', 'queen', null, 'QA', null, null], ['QB', 'queen', null, 'QB', null, null], ['QB.egg0', 'brood', null, null, 'QB', 'undetermined'], ['W1', 'worker', 'major', null, null, null]], 'viewer rows: kind, caste, queen id, mother id, fate');
  eq(v.candidates.oviposition, null, 'viewer shows the oviposition candidate is OFF'); eq(v.not_simulated.length, NOT_SIMULATED.length, 'viewer carries the 尚未模擬 list');
  ok(v.label_zh.includes('非正式'), 'viewer label says non-official');
  eq(viewerData(s, TEST).candidates.metabolism.worker_unknown, null, 'per-type metabolism candidate ids are shown');
}


function code(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
}

console.log(JSON.stringify({ test: 'colony-members', checks }));
