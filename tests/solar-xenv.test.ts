/**
 * Owner decision 51 (docs/solar-cross-env-check.md), BLOCKING, Node only: evidence for the Node-vs-Chromium 1-ulp
 * difference of engine/clock/solar.ts light times. Changes nothing; it pins what the investigation found.
 *  1. the synthetic experiment world (seeds 1–3, 10 days): no ant / hour / day event lies anywhere near a light transition —
 *     the smallest distance is many orders of magnitude above the measured cross-environment difference (so in these runs
 *     the difference cannot change any order or batch). Measured, not proven for all seeds.
 *  2. COUNTEREXAMPLES (adversarial, the other environment's value stood in by the neighbouring double, as measured):
 *     an event at exactly the sunrise instant changes batching / order; a value next to a half-tick changes the 'tick'
 *     label; the light state evaluated at the transition value differs. So the difference is NOT display-only: no display
 *     tolerance is defined (a tolerance on event times would hide these flips); the fix is a rules PR (proposal in the doc).
 *  3. formal history: engine/clock is not imported by the official pipeline (tests/clock-isolation.test.ts covers it; here
 *     only the light-time consumers are listed so a new consumer is noticed).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { partB, partC } from '../prototypes/solar-xenv/sweep.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
/** measured maximum Node-vs-Chromium difference of a light-time instant (prototypes/solar-xenv/out/sweep.json, A2), µs */
const MEASURED_MAX_DIFF_US = 6.9e-5;

const B = partB([1, 2, 3], 10);
for (const r of B.rows) ok(r.light_events === 40 && r.other_events > 1000, `seed ${r.seed}: ${r.light_events} light events, ${r.other_events} other events`);
ok(B.min_gap_us > 1e6 * MEASURED_MAX_DIFF_US, `smallest distance light transition ↔ other event ${B.min_gap_us} µs ≫ measured difference ${MEASURED_MAX_DIFF_US} µs`);

const C = partC() as Record<string, any>;
ok(C.diff_min > 0 && C.diff_min < 1e-13, `neighbouring double of the sunrise differs by ${C.diff_min} min (one ulp, as measured in Chromium)`);
ok(C.C1_same_instant.changes_batching === true && C.C1_same_instant.node === 'light+other' && C.C1_same_instant.other_env === 'other | light', 'COUNTEREXAMPLE C1: an event at exactly the sunrise instant: one batch vs two ordered batches');
ok(C.C2_between.strictly_between_exists === false && C.C2_1e12.changes_order === false, 'C2: no double lies strictly between neighbours; an event 1e-12 min later keeps its order');
ok(typeof C.C3_tick_flip === 'object' && C.C3_tick_flip.tick_label_a !== C.C3_tick_flip.tick_label_b, `COUNTEREXAMPLE C3: neighbouring values ${C.C3_tick_flip.value} / ${C.C3_tick_flip.neighbour} get different 'tick' labels`);
ok(C.C4_state_at_own_value.node !== C.C4_state_at_own_value.with_neighbour_times_at_node_value, 'COUNTEREXAMPLE C4: the light state at the transition value differs between the two value sets');

// consumers of the light times (a new consumer must be reviewed against docs/solar-cross-env-check.md)
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.name === 'node_modules' || e.name.startsWith('.') ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : /\.(ts|js|cjs|mjs)$/.test(e.name) ? [path.join(d, e.name)] : []));
const users = ['engine', 'cli', 'web/src', 'prototypes'].flatMap((d) => walk(path.join(REPO_ROOT, d))).filter((f) => /\b(lightTimes|lightStateAt|crossingMinute|solarAltitude)\b/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(REPO_ROOT, f)).sort();
ok(JSON.stringify(users) === JSON.stringify(['engine/clock/environment.ts', 'engine/clock/solar.ts', 'engine/clock/weather-input.ts', 'prototypes/continuous-world/worker/core.ts', 'prototypes/p0a2-24h/environment.ts', 'prototypes/p0a2-24h/world.ts', 'prototypes/solar-xenv/sweep.ts']), `light-time consumers unchanged (${users.join(', ')})`);
ok(!fs.readdirSync(path.join(REPO_ROOT, 'engine')).filter((f) => f.endsWith('.ts')).some((f) => /clock\//.test(fs.readFileSync(path.join(REPO_ROOT, 'engine', f), 'utf8'))), 'no top-level engine/*.ts (official day loop) references engine/clock');
console.log(JSON.stringify({ test: 'solar-xenv', checks, min_gap_us: B.min_gap_us }));
