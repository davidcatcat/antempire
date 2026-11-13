/**
 * Owner decision 51 (docs/solar-cross-env-check.md) and Owner decision #190 (ruled in #193, 2026-11-12, scheme A),
 * BLOCKING, Node only (the Chromium side is the RECORDED output of a real Chromium run, prototypes/solar-xenv/out/
 * sweep.json; re-run `node prototypes/solar-xenv/sweep.ts` whenever solar.ts / detmath.ts change):
 *  1. CROSS-ENVIRONMENT BIT-IDENTITY: the recorded sweep (A1 experiment site 4 years, A2 latitude × longitude × date,
 *     A3 high-latitude transition boundaries) has 0 differing values between Node, a Chromium page and a Chromium module
 *     Worker; the light times computed NOW in Node hash to the recorded Chromium digests (so a change of solar.ts /
 *     detmath.ts that alters any bit fails here until a new Chromium run is recorded). No tolerance anywhere.
 *     x86-64 only: ARM64 is NOT verified (no ARM64 runner).
 *  2. engine/clock/solar.ts and detmath.ts use no implementation-approximated Math function (sin, cos, tan, asin, acos,
 *     atan, exp, log, pow, **, ...): only IEEE basic operations and Math.sqrt.
 *  3. HISTORY (kept): with Math.* trigonometry the first run found 1–320 ulp differences (out/sweep-v1-math-builtin.json),
 *     and the COUNTEREXAMPLES below (the other environment's value stood in by the neighbouring double) show such a
 *     difference changes batching (C1), the 'tick' label (C3) and the light state at a boundary (C4) — so it is NOT
 *     display-only and no tolerance is defined; synthetic-world distances (Part B) are recorded as before.
 *  4. formal history: engine/clock is not imported by the official pipeline (tests/clock-isolation.test.ts covers it; here
 *     only the light-time consumers are listed so a new consumer is noticed).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { cases, evalAll, outputDigest, partB, partC, SPOTLIGHT } from '../prototypes/solar-xenv/sweep.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// 1. bit-identity, from the recorded real-Chromium run
const REC = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/solar-xenv/out/sweep.json'), 'utf8'));
const A = REC.A;
ok(REC.schema === 'antempire.solar-xenv.v2' && typeof A === 'object' && /^\d+\./.test(A.chromium), `recorded sweep comes from a real Chromium run (Chromium ${A?.chromium}, Node ${A?.node}, ${A?.platform})`);
ok(A.bit_identical === true && A.differing_values_total === 0, `recorded sweep: 0 differing values in ${A.cases} cases (Node vs Chromium page and Worker)`);
const sets = cases();
let compared = 0;
for (const k of ['A1', 'A2', 'A3'] as const) {
  const r = A[k], set = sets[k];
  for (const side of ['node_vs_chromium_page', 'node_vs_chromium_worker']) {
    const s = r[side];
    ok(s.cases === set.length && s.differing_values === 0 && s.refusal_flips === 0 && s.equal_values === s.values && s.values > 0, `${k} ${side}: ${s.equal_values}/${s.values} values bit-identical, 0 refusal flips (${s.refused_both} cases refused in both)`);
    compared += s.values;
  }
  const now = outputDigest(evalAll(set));
  ok(r.digest.chromium_page === r.digest.node && r.digest.chromium_worker === r.digest.node, `${k}: recorded Node, Chromium page and Chromium Worker digests equal`);
  ok(now === r.digest.chromium_page, `${k}: light times computed now in Node (${process.version}, ${process.platform}-${process.arch}) are bit-identical to the recorded Chromium output (${now.slice(0, 12)}…)`);
}
ok(A.spotlight.length === SPOTLIGHT.length && A.spotlight.every((s: { found: boolean; bit_identical: boolean }) => s.found && s.bit_identical), 'the inputs of the earlier differences and of the C1/C3/C4 counterexamples are bit-identical in all three environments');
ok(/未驗證/.test(A.arm64), 'ARM64 is recorded as NOT verified');

// 2. source: only basic operations and Math.sqrt
for (const f of ['engine/clock/solar.ts', 'engine/clock/detmath.ts']) ok(!/Math\.(sin|cos|tan|asin|acos|atan|atan2|log|log2|log10|log1p|exp|expm1|pow|hypot|cbrt|sinh|cosh|tanh|fround)\b|\*\*/.test(strip(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'))), `${f}: no implementation-approximated Math function`);

// 3. history: earlier measurement and counterexamples
const V1 = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/solar-xenv/out/sweep-v1-math-builtin.json'), 'utf8'));
ok(V1.A.A2.differing_values === 12738 && V1.A.A2.max_ulps === 320 && V1.A.A1.differing_values === 168, 'history kept: the Math.* version differed in 168 (A1) and 12 738 (A2) values, up to 320 ulp');
const B = partB([1, 2, 3], 10);
for (const r of B.rows) ok(r.light_events === 40 && r.other_events > 1000, `seed ${r.seed}: ${r.light_events} light events, ${r.other_events} other events`);
ok(B.min_gap_us > 1e6 * V1.A.A2.max_exact_us, `smallest distance light transition ↔ other event ${B.min_gap_us} µs ≫ the earlier Math.* difference ${V1.A.A2.max_exact_us} µs`);
const C = partC() as Record<string, any>;
ok(C.diff_min > 0 && C.diff_min < 1e-13, `neighbouring double of the sunrise differs by ${C.diff_min} min (one ulp)`);
ok(C.C1_same_instant.changes_batching === true && C.C1_same_instant.node === 'light+other' && C.C1_same_instant.other_env === 'other | light', 'COUNTEREXAMPLE C1: an event at exactly the sunrise instant: one batch vs two ordered batches');
ok(C.C2_between.strictly_between_exists === false && C.C2_1e12.changes_order === false, 'C2: no double lies strictly between neighbours; an event 1e-12 min later keeps its order');
ok(typeof C.C3_tick_flip === 'object' && C.C3_tick_flip.tick_label_a !== C.C3_tick_flip.tick_label_b, `COUNTEREXAMPLE C3: neighbouring values ${C.C3_tick_flip.value} / ${C.C3_tick_flip.neighbour} get different 'tick' labels`);
ok(C.C4_state_at_own_value.node !== C.C4_state_at_own_value.with_neighbour_times_at_node_value, 'COUNTEREXAMPLE C4: the light state at the transition value differs between the two value sets');

// 4. consumers of the light times (a new consumer must be reviewed against docs/solar-cross-env-check.md)
//    surface-temperature.ts (SURF-0, #213 Q2 b; reviewed): reads solarAltitude() as a continuous input of a model value; it
//    creates no event, batch or light-state boundary, uses only detmath / basic operations, and is imported by nothing.
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|js|cjs|mjs)$/.test(e.name) ? [path.join(d, e.name)] : []));
const users = ['engine', 'cli', 'web/src', 'prototypes'].flatMap((d) => walk(path.join(REPO_ROOT, d))).filter((f) => /\b(lightTimes|lightStateAt|crossingMinute|solarAltitude)\b/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(REPO_ROOT, f)).sort();
ok(JSON.stringify(users) === JSON.stringify(['engine/clock/environment.ts', 'engine/clock/solar.ts', 'engine/clock/surface-temperature.ts', 'engine/clock/weather-input.ts', 'prototypes/continuous-world/worker/core.ts', 'prototypes/p0a2-24h/environment.ts', 'prototypes/p0a2-24h/world.ts', 'prototypes/solar-xenv/sweep.ts']), `light-time consumers unchanged (${users.join(', ')})`);
ok(!fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).some((f) => /clock\//.test(fs.readFileSync(path.join(REPO_ROOT, 'engine', f), 'utf8'))), 'no top-level engine/*.ts (official day loop) references engine/clock');
console.log(JSON.stringify({ test: 'solar-xenv', checks, bit_identical_values_recorded: compared, chromium: A.chromium, arm64: 'not verified', min_gap_us: B.min_gap_us }));
