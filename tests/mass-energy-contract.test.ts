/**
 * MEC-0 shared mass / energy contract (engine/units/mass-energy.ts; Owner #219 Q1, #222). No behaviour change anywhere.
 *  T1 module purity: no imports, no platform API, no hidden randomness / clock, only IEEE-exact Math members
 *     (Worker deterministic-math rule), no species branch; not imported by the official engine (outside both rules
 *     fingerprints) and not in the Worker allowlist yet.
 *  T2 type-level separation: sugar, protein, energy, volume and legacy portions cannot be added / transferred into each
 *     other (@ts-expect-error lines: `npm run typecheck` fails if any of them stops being an error).
 *  T3 exact decimals and refusal of silent rounding / negative / non-integer / overflow.
 *  T4 conservation property test over random transfer sequences (Σ sources − Σ sinks = Σ pools, pools ≥ 0, refused
 *     operations change nothing).
 *  T5 split / replay invariance: the same operations chunked differently, and a JSON save / restore in the middle, give
 *     bit-identical state; rate accrual, conversions and the bridge with carried remainders are split-invariant.
 *  T6 rounding bounds of scaleWithCarry and resolution sanity (realistic per-event amounts do not round to zero).
 *  T7 conversion records: versioned, provenance on every result, same sugar energy density as the audit anchors.
 *  T8 legacy portion bridge: explicit factor with evidence, raw value kept, assumption:true, audit candidate range equal
 *     to the committed audit; and no other code defines a portion ↔ mass factor.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readJson, ruleFiles } from '../cli/lib/load.ts';
import { fingerprintV2 } from '../cli/lib/fingerprint-v2.ts';
import * as M from '../engine/units/mass-energy.ts';
import type { SugarMass, ProteinMass, Energy, Volume, MicroPortions } from '../engine/units/mass-energy.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const throwsCode = (f: () => unknown, code: string, why: string) => { let got = ''; try { f(); } catch (e) { got = (e as M.MassEnergyError).code ?? 'other'; } ok(got === code, `${why} (expected ${code}, got ${got || 'no error'})`); };
const REL = 'engine/units/mass-energy.ts';
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const noStrings = (s: string) => s.replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? (['node_modules', 'dist'].includes(e.name) ? [] : walk(path.join(dir, e.name))) : /\.(ts|tsx|js|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];

// ---------------------------------------------------------------- T1 purity and isolation
{
  const raw = fs.readFileSync(path.join(REPO_ROOT, REL), 'utf8'), code = noStrings(strip(raw));
  ok(!/\bimport\b|\brequire\s*\(/.test(code), 'T1: the contract imports nothing');
  ok(!/\b(process|window|document|localStorage|globalThis|Buffer|performance)\s*\./.test(code) && !/\bfetch\s*\(/.test(code), 'T1: no platform API');
  ok(!/Math\.random|Date\.now|new Date\(/.test(code), 'T1: no hidden randomness or wall clock');
  ok(!/pheidole|megacephala/i.test(code), 'T1: no species name in code');
  const allowed = new Set(readJson<{ deterministic_math_in_worker_graph: { allowed_math_members: string[] } }>('prototypes/continuous-world/worker-boundary.json').deterministic_math_in_worker_graph.allowed_math_members);
  const used = [...code.matchAll(/\bMath\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  ok(used.every((x) => allowed.has(x)), `T1: only IEEE-exact Math members (${[...new Set(used)].join(', ') || 'none'})`);
  ok(![...code.matchAll(/\*\*\s*([^\s;,)]+)/g)].some((m) => !/^\d+n?$/.test(m[1])), 'T1: ** only with a non-negative integer literal exponent');
  const importers = [...walk(path.join(REPO_ROOT, 'engine')), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src')), ...walk(path.join(REPO_ROOT, 'prototypes/continuous-world'))]
    .filter((f) => path.relative(REPO_ROOT, f) !== REL && /units\/mass-energy/.test(strip(fs.readFileSync(f, 'utf8'))));
  ok(importers.length === 0, `T1: MEC-0 wires nothing: no engine / cli / web / Worker module imports the contract yet (${importers.map((f) => path.relative(REPO_ROOT, f)).join(', ')})`);
  ok(!ruleFiles().engine.includes(REL), 'T1: outside the v1 rules fingerprint (top-level engine/*.ts only)');
  ok(!fingerprintV2().files.source.includes(REL), 'T1: outside the v2 rules fingerprint (not in the official import closure)');
  ok(!fs.readFileSync(path.join(REPO_ROOT, 'prototypes/continuous-world/worker-boundary.json'), 'utf8').includes('engine/units'), 'T1: not on the Worker allowlist (adding it is a separate rules change)');
}

// ---------------------------------------------------------------- T2 type-level separation (checked by tsc; never run)
export function typeSeparationSamples(s: SugarMass, p: ProteinMass, e: Energy, v: Volume, u: MicroPortions): void {
  const L = M.createLedger('sugar'), E = M.createLedger('energy');
  // @ts-expect-error sugar + protein
  M.add(s, p);
  // @ts-expect-error protein − sugar
  M.sub(p, s);
  // @ts-expect-error mass + energy
  M.add(s, e);
  // @ts-expect-error volume + mass (a liquid is not its solute)
  M.add(v, s);
  // @ts-expect-error legacy portions + mass (only the bridge converts)
  M.add(u, s);
  // @ts-expect-error a raw number is not a quantity
  M.add(s, 5);
  // @ts-expect-error protein into a sugar ledger
  M.transfer(L, 'a', 'b', p);
  // @ts-expect-error energy into a sugar ledger
  M.inflow(L, 'src', 'pool', e);
  // @ts-expect-error mass into an energy ledger
  M.inflow(E, 'src', 'pool', s);
  // @ts-expect-error converting protein with the sugar record
  M.massToEnergy(M.SUGAR_ENERGY_V1, p);
  // @ts-expect-error a number result of `+` cannot be stored as a quantity
  const bad: SugarMass = s + p;
  void bad;
  // allowed: same currency
  M.add(s, M.sugarNg(1)); M.add(e, e); M.add(v, v); M.transfer(L, 'a', 'b', s);
}
ok(true, 'T2: type-separation samples compile only as errors (see @ts-expect-error lines; npm run typecheck)');

// ---------------------------------------------------------------- T3 exact decimals and refusals
{
  ok(M.sugarFromMg('0.016') === 16_000 && M.sugarFromMg(0.016) === 16_000, 'T3: 0.016 mg = 16 000 ng (string and number)');
  ok(M.sugarFromMg('1e-6') === 1 && M.sugarFromMg(1e-6) === 1, 'T3: 1e-6 mg = 1 ng (exponent form)');
  ok(M.proteinFromUg('75') === 75_000 && M.energyFromJ('16.5') === 16_500_000 && M.volumeFromUL('0.08') === 80_000, 'T3: µg, J and µL (→ pL) parse exactly');
  ok(M.legacyPortions('0.025') === 25_000 && M.legacyPortions(0.1) === 100_000, 'T3: legacy 0.025 份 = 25 000 µP');
  throwsCode(() => M.sugarFromMg('0.0000001'), 'PRECISION', 'T3: sub-ng input is refused, not rounded');
  throwsCode(() => M.sugarFromMg('-1'), 'BAD_DECIMAL', 'T3: negative input refused');
  throwsCode(() => M.sugarNg(1.5), 'NOT_SAFE_INTEGER', 'T3: non-integer base units refused');
  throwsCode(() => M.sugarNg(-1), 'NEGATIVE', 'T3: negative base units refused');
  throwsCode(() => M.sub(M.sugarNg(1), M.sugarNg(2)), 'NEGATIVE', 'T3: a difference never goes below zero');
  throwsCode(() => M.add(M.energyUJ(M.MAX_QUANTITY), M.energyUJ(1)), 'OVERFLOW', 'T3: exceeding 2^53 − 1 throws (never wraps)');
  const r = M.legacyPortionsRounded(0.1234567);
  ok(r.value === 123_457 && Math.abs(r.residual_portions + 0.0000003) < 1e-12, 'T3: explicit legacy rounding returns the residual');
  ok(M.formatMg(M.sugarNg(16_000)) === '0.016 mg' && M.formatMass(M.sugarNg(16_000)) === '16 µg' && M.formatMass(M.sugarNg(2_500_000)) === '2.5 mg' && M.formatMass(M.proteinNg(405)) === '405 ng', 'T3: mass display');
  ok(M.formatJ(M.energyUJ(264_000)) === '0.264 J' && M.formatEnergy(M.energyUJ(264_000)) === '264 mJ' && M.formatEnergy(M.energyUJ(16_500_000)) === '16.5 J' && M.formatEnergy(M.energyUJ(7)) === '7 µJ', 'T3: energy display');
  ok(M.formatMg(M.sugarNg(1_234_567), 3) === '1.235 mg' && M.formatMg(M.sugarNg(1_234_500), 3) === '1.235 mg' && M.formatMg(M.sugarNg(0), 3) === '0 mg', 'T3: display rounding half away from zero');
  ok(M.formatPortions(M.microPortions(25_000)).startsWith('0.025 份'), 'T3: legacy portions display names the game unit');
}

// ---------------------------------------------------------------- deterministic test RNG (xorshift32)
function rngOf(seed: number) { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0; return x / 4294967296; }; }
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length)];

// ---------------------------------------------------------------- T4 conservation property test
type Op = { k: 'in'; src: string; pool: string; a: number } | { k: 'mv'; from: string; to: string; a: number } | { k: 'out'; pool: string; sink: string; a: number };
function genOps(seed: number, n: number): Op[] {
  const r = rngOf(seed), pools = ['crop:W1', 'crop:W2', 'gut:L1', 'store', 'source:F01'], srcs = ['honeydew:F01@d3', 'nectar:F08@d1'], sinks = ['respired', 'egested', 'decayed'];
  return Array.from({ length: n }, () => {
    const x = r(), a = Math.floor(r() * (r() < 0.1 ? 5e9 : 2e5)); // mostly realistic (≤ 0.2 mg), sometimes larger than any pool
    return x < 0.3 ? { k: 'in', src: pick(r, srcs), pool: pick(r, pools), a } : x < 0.8 ? { k: 'mv', from: pick(r, pools), to: pick(r, pools), a } : { k: 'out', pool: pick(r, pools), sink: pick(r, sinks), a };
  });
}
function apply(L: M.SugarLedger, op: Op): boolean {
  const before = JSON.stringify(L);
  try {
    if (op.k === 'in') M.inflow(L, op.src, op.pool, M.sugarNg(op.a));
    else if (op.k === 'mv') M.transfer(L, op.from, op.to, M.sugarNg(op.a));
    else M.outflow(L, op.pool, op.sink, M.sugarNg(op.a));
    return true;
  } catch (e) {
    assert.equal((e as M.MassEnergyError).code, 'INSUFFICIENT'); assert.equal(JSON.stringify(L), before, 'a refused operation changes nothing');
    return false;
  }
}
{
  let refused = 0, applied = 0;
  for (let seed = 1; seed <= 200; seed++) {
    const L = M.createLedger('sugar');
    for (const op of genOps(seed, 300)) { if (apply(L, op)) applied++; else refused++; M.assertConserved(L); assert.ok(Object.values(L.pools).every((v) => v >= 0)); }
    checks++;
  }
  ok(refused > 0 && applied > 0, `T4: 200 random sequences × 300 ops: books closed exactly after every op (${applied} applied, ${refused} refused because the pool held less)`);
  const L = M.createLedger('protein');
  throwsCode(() => M.inflow(L, '', 'p', M.proteinNg(1)), 'MISSING_ID', 'T4: creation needs a named source');
  throwsCode(() => M.outflow(L, 'p', '', M.proteinNg(0)), 'MISSING_ID', 'T4: destruction needs a named sink');
  L.pools.p = 5; // tampering outside the API is detected
  throwsCode(() => M.assertConserved(L), 'NOT_CONSERVED', 'T4: a pool changed outside the API breaks the books');
}

// ---------------------------------------------------------------- T5 split / replay invariance
{
  // whole op sequences: one run vs the same ops with a JSON save/restore every k ops
  for (const seed of [7, 8, 9, 10]) {
    const ops = genOps(seed, 400), A = M.createLedger('sugar'); for (const op of ops) apply(A, op);
    for (const k of [1, 3, 37, 199]) {
      let B: M.SugarLedger = M.createLedger('sugar');
      ops.forEach((op, i) => { apply(B, op); if ((i + 1) % k === 0) B = JSON.parse(JSON.stringify(B)); });
      ok(JSON.stringify(A) === JSON.stringify(B), `T5: seed ${seed}: save/restore every ${k} ops gives the identical ledger`);
    }
  }
  // rate accrual: any split of the interval gives the same amount
  const r = rngOf(42);
  for (let t = 0; t < 300; t++) {
    const rate = M.sugarNg(Math.floor(r() * 5e7)), dt = Math.floor(r() * 3 * M.MS_PER_DAY);
    const whole = M.accrue(rate, dt);
    let carry = 0, total = 0, left = dt;
    while (left > 0) { const step = Math.min(left, 1 + Math.floor(r() * 4e6)); const a = M.accrue(rate, step, carry); total += a.amount; carry = a.carry; left -= step; }
    assert.equal(total, whole.amount); assert.equal(carry, whole.carry);
  }
  ok(true, 'T5: rate accrual over 300 random intervals × random splits equals the unsplit accrual bit for bit'); checks++;
  // conversions and bridge: the same mass converted at once or in pieces (carry threaded)
  const br = M.makePortionBridge({ id: 'test-sugar', target: 'sugar', per_portion: '50000', evidence: 'test sample inside the audit range' });
  for (let t = 0; t < 200; t++) {
    const m = Math.floor(r() * 1e9), parts: number[] = []; let left = m; while (left > 0) { const p = Math.min(left, Math.floor(r() * 1e8) + 1); parts.push(p); left -= p; }
    const one = M.massToEnergy(M.SUGAR_ENERGY_V1, M.sugarNg(m)); let c = 0, e = 0; for (const p of parts) { const x = M.massToEnergy(M.SUGAR_ENERGY_V1, M.sugarNg(p), c); e += x.value; c = x.carry; }
    assert.equal(e, one.value); assert.equal(c, one.carry);
    const onP = M.bridgeFromPortions(br, M.microPortions(m)); let cp = 0, s = 0; for (const p of parts) { const x = M.bridgeFromPortions(br, M.microPortions(p), cp); s += x.value; cp = x.carry; }
    assert.equal(s, onP.value); assert.equal(cp, onP.carry);
  }
  ok(true, 'T5: mass→energy and portion→mass over 200 random splits equal the unsplit conversion bit for bit'); checks++;
  // oxidise: sugar leaves its ledger, energy enters its own; both books close, split-invariant
  const S1 = M.createLedger('sugar'), E1 = M.createLedger('energy'), S2 = M.createLedger('sugar'), E2 = M.createLedger('energy');
  M.inflow(S1, 'honeydew:F01@d1', 'gut:L1', M.sugarNg(1_000_003)); M.inflow(S2, 'honeydew:F01@d1', 'gut:L1', M.sugarNg(1_000_003));
  const c1 = M.oxidise(S1, 'gut:L1', M.sugarNg(1_000_003), E1, 'released:L1', M.SUGAR_ENERGY_V1);
  let cc = 0; for (const a of [1, 2, 333_333, 666_667]) cc = M.oxidise(S2, 'gut:L1', M.sugarNg(a), E2, 'released:L1', M.SUGAR_ENERGY_V1, cc).carry;
  M.assertConserved(S1); M.assertConserved(E1); M.assertConserved(S2); M.assertConserved(E2);
  ok(JSON.stringify([S1, E1]) === JSON.stringify([S2, E2]) && cc === c1.carry && E1.pools['released:L1'] === 16_500_049, 'T5: oxidising 1 000 003 ng sugar at once or in four pieces: same books, 16.500049 J');
  throwsCode(() => M.oxidise(S1, 'gut:L1', M.sugarNg(1), E1, 'x', M.SUGAR_ENERGY_V1), 'INSUFFICIENT', 'T5: oxidising more than the pool holds is refused');
  ok(JSON.stringify(S1) === JSON.stringify(S2), 'T5: …and changes nothing');
}

// ---------------------------------------------------------------- T6 rounding bounds and resolution
{
  const r = rngOf(99);
  for (let t = 0; t < 2000; t++) {
    const x = Math.floor(r() * 1e12), num = 1 + Math.floor(r() * 1e6), den = 1 + Math.floor(r() * 1e6);
    const { value, carry } = M.scaleWithCarry(x, M.rational(num, den));
    const exact = (BigInt(x) * BigInt(num)) ; // value·den + carry = x·num exactly, 0 ≤ carry < den
    assert.equal(BigInt(value) * BigInt(den) + BigInt(carry), exact); assert.ok(carry >= 0 && carry < den);
  }
  ok(true, 'T6: scaleWithCarry is exact (value·den + carry = x·num, 0 ≤ carry < den): the error of one call is < 1 base unit and is carried, not lost'); checks++;
  throwsCode(() => M.scaleWithCarry(M.MAX_QUANTITY, M.rational(3, 1)), 'OVERFLOW', 'T6: a conversion result above 2^53 − 1 throws');
  throwsCode(() => M.scaleWithCarry(5, M.rational(1, 3), 3), 'BAD_CARRY', 'T6: a carry outside [0, den) is refused');
  // resolution sanity (design numbers, docs/mass-energy-contract.md §2)
  const smallest = [
    ['P0-A2 larva bolus 0.025 份 at the audit lower candidate 0.0162 mg/份', M.bridgeFromPortions(M.makePortionBridge({ id: 'lo', target: 'sugar', per_portion: '16200', evidence: 'audit lower candidate' }), M.legacyPortions('0.025')).value],
    ['brood L1 hourly feed at the demand-low corner (≈1.4 µg/d ÷ 24)', M.sugarFromUg('0.058')],
  ] as const;
  for (const [what, ng] of smallest) ok(ng >= 50, `T6: ${what} is ${ng} ng in integer ng (does not round to zero)`);
  // a continuous rate smaller than 1 ng per step is not lost: minor resting metabolism at the audit lower bound
  // (0.00162 mg/d = 1 620 ng/d) is 0.019 ng per second; 86 400 one-second steps with the carry give exactly 1 620 ng
  const rate = M.sugarFromMg('0.00162'); let c = 0, tot = 0;
  for (let s = 0; s < 86_400; s++) { const a = M.accrue(rate, 1000, c); tot += a.amount; c = a.carry; }
  ok(M.accrue(rate, 1000).amount === 0 && tot === 1_620 && c === 0, 'T6: a sub-ng-per-step rate accrues exactly through the carry (86 400 × 1 s = 1 620 ng)');
  ok(M.MAX_QUANTITY / M.NG_PER_MG / 1e6 > 9, 'T6: one quantity can hold > 9 kg in ng (colony and individual pools are ≤ grams)');
  ok(M.MAX_QUANTITY / M.UJ_PER_J > 9e9, 'T6: one energy quantity can hold > 9 GJ in µJ');
}

// ---------------------------------------------------------------- T7 conversion records
{
  const ids = M.CONVERSION_RECORDS.map((x) => `${x.id}@${x.version}`);
  ok(new Set(ids).size === ids.length, 'T7: conversion record ids are unique');
  const refs = new Set(Array.from(fs.readFileSync(path.join(REPO_ROOT, 'docs/references.md'), 'utf8').matchAll(/^\| (R\d+) \|/gm), (m) => m[1]));
  for (const x of M.CONVERSION_RECORDS) {
    ok(x.assumption === true && ['文獻支持', '一般生理學', '遊戲假設'].includes(x.basis) && x.read_level.length > 0 && x.extrapolation_limit.length > 0, `T7: ${x.id} is assumption:true with basis, read level and extrapolation limit`);
    ok(Object.isFrozen(x), `T7: ${x.id} is frozen`);
    for (const s of x.sources) ok(refs.has(s), `T7: ${x.id} source ${s} is a row of docs/references.md`);
    if (x.basis === '文獻支持') ok(x.sources.length > 0, `T7: literature-supported ${x.id} names its source`);
  }
  const anchor = readJson<{ anchors: { sugar_energy_j_per_mg: { value: number; basis: string } } }>('data/garden-supply-demand-anchors.json').anchors.sugar_energy_j_per_mg;
  ok(M.SUGAR_ENERGY_V1.factor.num / M.SUGAR_ENERGY_V1.factor.den === anchor.value && M.SUGAR_ENERGY_V1.basis === anchor.basis, 'T7: one sugar energy density in the repo (equals the audit anchor, same basis)');
  const c = M.massToEnergy(M.SUGAR_ENERGY_V1, M.sugarFromMg('0.016'));
  ok(c.value === 264_000 && c.provenance.record_id === 'sugar_energy_density' && c.provenance.record_version === 'v1' && c.provenance.assumption === true && c.provenance.input.value === 16_000 && c.provenance.factor_display === '16.5 J/mg', 'T7: 0.016 mg sugar → 0.264 J with provenance');
  ok(M.massToEnergy(M.PROTEIN_ENERGY_V1, M.proteinFromUg('75')).value === 1_275_000, 'T7: 75 µg protein → 1.275 J (17 J/mg, general physiology)');
}

// ---------------------------------------------------------------- T8 legacy portion bridge
{
  const audit = readJson<{ anchored: { conversion_candidates_mg_sugar_per_gp: { union: number[] } } }>('reports/garden-supply-demand-audit/audit.json').anchored.conversion_candidates_mg_sugar_per_gp.union;
  ok(Number(M.AUDIT_SUGAR_MG_PER_PORTION_CANDIDATE.min) === audit[0] && Number(M.AUDIT_SUGAR_MG_PER_PORTION_CANDIDATE.max) === audit[1], 'T8: the bridge\'s candidate range equals the committed audit (reference metadata, not a factor)');
  throwsCode(() => M.makePortionBridge({ id: 'x', target: 'sugar', per_portion: '50000', evidence: ' ' }), 'NO_EVIDENCE', 'T8: a bridge must state its evidence');
  throwsCode(() => M.makePortionBridge({ id: 'x', target: 'sugar', per_portion: '0', evidence: 'e' }), 'BAD_RATIONAL', 'T8: a zero factor is refused');
  const b = M.makePortionBridge({ id: 'audit-load-R132', target: 'sugar', per_portion: '80000', evidence: 'R132 load 0.08 mg honey × 0.8 sugar ÷ crop_capacity 0.8 份 (audit §4.3)', sources: ['R132'] });
  const x = M.bridgeFromPortions(b, M.legacyPortions('0.28'));
  ok(x.value === 22_400 && x.provenance.raw.micro_portions === 280_000 && x.provenance.raw.portions === '0.28' && x.provenance.assumption === true && x.provenance.basis === '遊戲假設' && x.provenance.bridge_version === M.PORTION_BRIDGE_VERSION && x.provenance.within_audit_sugar_candidate_range === true, 'T8: 0.28 份 × 0.08 mg/份 = 22.4 µg, raw portion kept, assumption flagged, inside the audit range');
  const back = M.bridgeToPortions(b, x.value);
  ok(back.value === 280_000 && back.carry === 0, 'T8: the inverse direction returns the raw portions exactly');
  ok(M.bridgeFromPortions(M.makePortionBridge({ id: 'lo', target: 'sugar', per_portion: '16000', evidence: 'e' }), M.legacyPortions(1)).provenance.within_audit_sugar_candidate_range === false, 'T8: 0.016 mg/份 lies just below the audit union (0.0162) and is flagged');
  ok(M.bridgeFromPortions(M.makePortionBridge({ id: 'hi', target: 'sugar', per_portion: '88120', evidence: 'e' }), M.legacyPortions(1)).provenance.within_audit_sugar_candidate_range === true, 'T8: the upper end 0.08812 mg/份 is inside');
  // liquid route (how #222's candidate bridge enters): 100 µg liquid per 份 at an ASSUMED density 1 mg/µL = 0.1 µL = 100 000 pL per 份
  const vol = M.makePortionBridge({ id: 'brood-solution', target: 'volume', per_portion: '100000', evidence: '#222 candidate bridge_portion_solution_ug 100 µg liquid ÷ density 1 mg/µL (assumption)', sources: ['R132'] });
  const v = M.bridgeFromPortions(vol, M.legacyPortions('0.025'));
  const conc: M.Concentration<'sugar'> = { food: 'sugar', mg_per_ul: M.rationalFromDecimal('0.1'), assumption: true, basis: '遊戲假設', note: 'test sample: 10% w/v (R94 rearing diet, not nest fluid)' };
  const sol = M.soluteMass(conc, v.value);
  ok(v.value === 2_500 && v.carry === 0 && v.provenance.within_audit_sugar_candidate_range === null && M.formatUL(v.value) === '0.0025 µL', 'T8: liquid route: 0.025 份 × 100 000 pL/份 = 2 500 pL (0.0025 µL)');
  ok(sol.value === 250 && sol.carry === 0 && M.formatMass(sol.value) === '250 ng', 'T8: …at 0.1 mg/µL = 250 ng sugar (the 0.25 µg/d of docs/p0a2-brood-physiology-design.md §4.6)');
}

// no second portion ↔ mass factor in code anywhere (the bridge is the only place)
{
  const FACTOR = /\b[A-Za-z_]*(?:(?:mg|ug|ng|µg)_?per_?(?:portion|gp)|(?:portion|gp)_?(?:to|in)_?(?:mg|ug|ng|µg))[A-Za-z_]*\s*[:=]\s*[\d.]/i;
  ok(FACTOR.test('const mg_per_portion = 0.05') && FACTOR.test('PORTION_TO_UG: 100') && !FACTOR.test("unit: 'game_portions_NOT_mg'"), 'T8: detector catches a factor constant and ignores unit labels');
  const files = [...walk(path.join(REPO_ROOT, 'engine')), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'tools')), ...walk(path.join(REPO_ROOT, 'prototypes')), ...walk(path.join(REPO_ROOT, 'web/src'))]
    .filter((f) => path.relative(REPO_ROOT, f) !== REL);
  const hits = files.filter((f) => FACTOR.test(noStrings(strip(fs.readFileSync(f, 'utf8')))));
  ok(hits.length === 0, `T8: no other code defines a portion ↔ mass factor (${hits.map((f) => path.relative(REPO_ROOT, f)).join(', ')})`);
}

console.log(JSON.stringify({ test: 'mass-energy-contract', contract: M.MASS_ENERGY_CONTRACT_VERSION, checks }));
