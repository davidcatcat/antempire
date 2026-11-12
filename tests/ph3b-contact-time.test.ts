/**
 * PH-3b contact times (docs/physics-ph3b-solver2d.md §2.6, docs/physics-time-contract.md). BLOCKING.
 *  1. minimal reproductions (fail on 6864974): a body sliding along another's rounded end, a body pressed against a body
 *     that stopped, a grazing pass, a head-on touch, and the time-boundary contract;
 *  2. every contact event of every PH-3b scenario / playback run / seeded random case cross-checked by the INDEPENDENT
 *     checker prototypes/physics-check/contact-check.ts (own geometry, imports nothing from engine/): inside its bracket,
 *     no missed contact, no open contact that separated, no penetration; motion records: no teleport, path = ∫ speed dt;
 *  3. invariance: broad-phase window / grid / method, reversed and permuted input order, relabelled ids, horizons (prefix);
 *  4. sensitivity to the contact tolerance (reported, checker clean at every value);
 *  5. positive controls: the checker catches a shifted, a deleted, an invented and a mislabelled contact event.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as S2 from '../engine/physics/solver2d.ts';
import type { Solver2DInput, Solver2DResult, SolverAgent } from '../engine/physics/solver2d.ts';
// namespace import: the same file also runs (PH3B_CT_ALL=1) against the unfixed solver, which lacks the new exports
const { solve2D, ACTIVE_TOL_MM } = S2;
const SEP_RES_MM: number = (S2 as Record<string, unknown>).SEP_RES_MM as number ?? 1e-9, GAP_EVAL_ERR_MM: number = (S2 as Record<string, unknown>).GAP_EVAL_ERR_MM as number ?? 1e-11;
import { loadScenario, type ScenarioFile } from '../prototypes/solver-compare/lib/spec.ts';
import { ph3bInput } from '../prototypes/solver-compare/lib/ph3b.ts';
import { checkContacts, checkMotion, motionFromSamples, CONTRACT, type CkMotion } from '../prototypes/physics-check/contact-check.ts';
import { checkTimeContract, type TimeCase } from './lib/physics-time-contract.ts';
import { rng } from '../engine/rng.ts';
import { REPO_ROOT } from '../cli/lib/load.ts';

// PH3B_CT_ALL=1: record every failing check and continue (used to log the failures of the unfixed solver)
const ALL = process.env.PH3B_CT_ALL === '1', failed: string[] = [];
let checks = 0; const ok = (c: unknown, why: string) => { checks++; if (ALL) { if (!c) failed.push(why); } else assert.ok(c, why); };
const evidence: Record<string, unknown> = {};
const BODY = { length_mm: 2.5, width_mm: 0.8 };     // the candidate-file sizes used by every PH-3b scenario (R94; candidate upper bound)
const hash = (r: Solver2DResult) => createHash('sha256').update(JSON.stringify({ a: r.agents, e: r.events })).digest('hex');
const motion = (r: Solver2DResult, H: number, body = BODY) => motionFromSamples(r.agents, r.events, body, H);
const kinds = (r: Solver2DResult, k: string) => r.events.filter((e) => e.kind === k);
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

// ---- 0. the contract numbers agree between solver and checker (copied, not imported)
ok(CONTRACT.tol_mm === ACTIVE_TOL_MM && CONTRACT.resolution_mm === SEP_RES_MM && CONTRACT.eval_err_mm === GAP_EVAL_ERR_MM, 'checker contract numbers = solver numbers (θ 1e-7, ρ 1e-9, ε 1e-11 mm)');
{
  const src = strip(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/physics-check/contact-check.ts'), 'utf8'));
  ok(!/from\s+['"][^'"]*(engine|solver|local-steer|physics-playback)[^'"]*['"]/.test(src) && !/import\s*\(/.test(src), 'the checker imports nothing from engine/ or any solver (independent code)');
  const sol = strip(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/solver2d.ts'), 'utf8'));
  ok(!/physics-check|contact-check/.test(sol), 'the solver does not use the checker');
}

/** cross-check one run: checker clean, motion invariants, every contact event carries its bracket and error bound */
function crossCheck(label: string, r: Solver2DResult, H: number, tol = ACTIVE_TOL_MM) {
  const m = motion(r, H), c = checkContacts(m, { tol_mm: tol }), mm = checkMotion(m);
  ok(c.violations === 0, `${label}: independent checker clean (${c.problems.slice(0, 3).join(' | ')})`);
  ok(c.missed === 0 && c.penetrations === 0, `${label}: no missed contact, no penetration`);
  ok(mm.teleports === 0 && mm.speed_mismatch === 0 && mm.problems.length === 0, `${label}: motion records continuous, displacement = speed × duration, path = ∫ speed dt (${mm.problems.slice(0, 2)})`);
  ok(r.stats.unresolved === 0 && r.stats.aborted === null && r.stats.constraint_outside_contact === 0, `${label}: solver status clean, constraint ⇒ contact`);
  for (const e of r.events) if (e.kind === 'contact_start' || e.kind === 'contact_end') {
    ok(e.exact === true && e.usable_as_cause === true && e.bracket_s && e.bracket_s[1] === e.t_s && e.bracket_s[0] <= e.t_s && e.t_s - e.bracket_s[0] <= 1e-12 * Math.max(1, e.t_s)
      && typeof e.err_s === 'number' && e.err_s >= 0 && Number.isFinite(e.err_s) && e.confirmed_t_s! >= e.t_s && e.t_s <= H, `${label}: ${e.kind} ${e.agents} at ${e.t_s} carries an exact root bracket, an error bound and its confirmation time`);
  }
  for (const e of kinds(r, 'contact_end_unconfirmed')) ok(e.usable_as_cause === false && e.exact === false && e.t_s === H, `${label}: an unconfirmed end is labelled (not exact, not usable as a cause)`);
  const errs = r.events.filter((e) => e.kind.startsWith('contact_') && e.err_s !== undefined).map((e) => e.err_s!);
  return { episodes: c.episodes, ends: c.exact, open: c.open, unconfirmed: c.unconfirmed, checker_max_err_s: c.max_err_s, checker_max_start_err_s: c.max_start_err_s, solver_max_err_s: errs.length ? Math.max(...errs) : null, pairs_scanned: c.pairs_scanned, events: r.events.length };
}

// ---- 1. minimal reproductions (two bodies on two crossing lanes, or one lane)
const crossLanes = [{ id: 'EW', centerline_mm: [{ x: 0, y: 50 }, { x: 100, y: 50 }], width_mm: 2, layer: 'z' }, { id: 'NS', centerline_mm: [{ x: 50, y: 0 }, { x: 50, y: 100 }], width_mm: 2, layer: 'z' }];
const cross = (nGoal: number, eDelay: number, H = 3, extra: Partial<Solver2DInput> = {}): Solver2DInput => ({
  lanes: crossLanes, obstacles: [], horizon_s: H, ...extra, agents: [
    { id: 'E', lane: 'EW', s_mm: 45, u_mm: 0, dir: 1, start_t_s: eDelay, goal_s_mm: 60, free_speed_mm_s: 17, body: BODY },
    { id: 'N', lane: 'NS', s_mm: 45, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: nGoal, free_speed_mm_s: 17, body: BODY }],
});
const repro: Record<string, unknown> = {};
{
  // R1 slide: E's head meets N's flank, N moves on, E presses on N's receding rounded end (piecewise-constant sliding:
  // ~1,600 constraint re-solves). ONE physical contact; it ends once, when the gap opens past the resolution.
  const r = solve2D(cross(60, 0.1));
  ok(r.stats.contacts > 1000, `R1: the sliding approximation re-solves the contact many times (${r.stats.contacts} constraint activations)`);
  ok(kinds(r, 'contact_start').length === 1 && kinds(r, 'contact_end').length === 1, `R1: exactly one contact episode (start ${kinds(r, 'contact_start').length}, end ${kinds(r, 'contact_end').length}); 6864974 recorded 1,567 starts and 1,567 ends`);
  ok(r.stats.sub_resolution_excursions === r.stats.contacts, 'R1: every constraint release was a sub-resolution excursion merged into the episode');
  repro.R1_slide = crossCheck('R1 slide', r, 3);
}
{
  // R2 pressed: N stops (goal 51.3 mm) with its rounded end against E's head; E stays pressed. The pair never separates.
  const r = solve2D(cross(51.3, 0.1));
  ok(kinds(r, 'contact_end').length === 0 && kinds(r, 'contact_start').length === 1, `R2: no contact_end for a pair that never separates (6864974 recorded 1,194 contact_end, none bracketable)`);
  ok(r.agents.E.final_mode === 'stopped_by_contact', 'R2: E ends pressed against N');
  repro.R2_pressed = crossCheck('R2 pressed', r, 3);
}
{
  // R3 graze: two bodies pass side by side with offsets ±w/2 (gap exactly 0 at the pass); they touch → one episode
  const inp: Solver2DInput = { lanes: [{ id: 'P', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 2 * BODY.width_mm, layer: 'z' }], obstacles: [], horizon_s: 3, agents: [
    { id: 'A', lane: 'P', s_mm: 10, u_mm: BODY.width_mm / 2, dir: 1, start_t_s: 0, goal_s_mm: 40, free_speed_mm_s: 17, body: BODY },
    { id: 'B', lane: 'P', s_mm: 40, u_mm: -BODY.width_mm / 2, dir: -1, start_t_s: 0, goal_s_mm: 10, free_speed_mm_s: 17, body: BODY }] };
  const r = solve2D(inp);
  ok(r.agents.A.arrival_t_s !== null && r.agents.B.arrival_t_s !== null, 'R3: the grazing pass is not blocked (gap 0, no penetration)');
  ok(kinds(r, 'contact_start').length === 1 && kinds(r, 'contact_end').length === 1, 'R3: the touching pass is one contact episode (6864974: none — the graze was below HIT_TOL_MM and never became a constraint)');
  const s = kinds(r, 'contact_start')[0] ?? { t_s: NaN }, e = kinds(r, 'contact_end')[0] ?? { t_s: NaN };
  // side by side at gap 0 while the straight flanks overlap: |Δs| ≤ L − w, i.e. from (30 − (L − w))/34 to (30 + (L − w))/34 s
  // plus the reach of the rounded ends within θ: d = √((w + θ)² − w²)
  const lw = BODY.length_mm - BODY.width_mm + Math.sqrt((BODY.width_mm + ACTIVE_TOL_MM) ** 2 - BODY.width_mm ** 2);
  ok(Math.abs(s.t_s - (30 - lw) / 34) < 1e-9 && Math.abs(e.t_s - (30 + lw) / 34) < 1e-9, `R3: the episode spans the analytic interval [${(30 - lw) / 34}, ${(30 + lw) / 34}] s (${s.t_s}, ${e.t_s})`);
  repro.R3_graze = crossCheck('R3 graze', r, 3);
}
{
  // R4 head-on: the contact starts at the crossing of θ (gap 1e-7 mm), not at the touch (gap 0) of the constraint
  const inp: Solver2DInput = { lanes: [{ id: 'P', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 2, layer: 'z' }], obstacles: [], horizon_s: 2, agents: [
    { id: 'A', lane: 'P', s_mm: 10, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: 90, free_speed_mm_s: 10, body: BODY },
    { id: 'B', lane: 'P', s_mm: 20, u_mm: 0, dir: -1, start_t_s: 0, goal_s_mm: 5, free_speed_mm_s: 10, body: BODY }] };
  const r = solve2D(inp), s = kinds(r, 'contact_start')[0], touch = (10 - BODY.length_mm) / 20;
  ok(s && Math.abs(s.t_s - (touch - ACTIVE_TOL_MM / 20)) < 1e-12, `R4: contact_start at the θ crossing ${touch - ACTIVE_TOL_MM / 20} s (got ${s?.t_s}); 6864974 recorded the touch ${touch} s`);
  const stopT = r.events.find((e) => e.kind === 'stop' && e.agents[0] === 'A')!.t_s;
  ok(Math.abs(stopT - touch) < 1e-12 && stopT > s.t_s, `R4: the bodies still stop at the touch ${stopT} s (motion unchanged), after the contact started`);
  repro.R4_head_on = crossCheck('R4 head-on', r, 2);
}
// R5 time-boundary contract (shared helper; WP4 local-steer can adopt the same helper)
const ph3bTimeAdapter = (c: TimeCase) => {
  const dir: 1 | -1 = c.goal_mm >= c.s0_mm ? 1 : -1;
  const r = solve2D({ lanes: [{ id: 'P', centerline_mm: [{ x: 0, y: 0 }, { x: c.lane_len_mm, y: 0 }], width_mm: 2, layer: 'z' }], obstacles: [], horizon_s: c.horizon_s, agents: [{ id: 'A', lane: 'P', s_mm: c.s0_mm, u_mm: 0, dir, start_t_s: c.start_t_s, goal_s_mm: c.goal_mm, free_speed_mm_s: c.speed_mm_s, body: BODY }] });
  const a = r.agents.A, S = a.samples;
  return { start_events: kinds(r, 'start').map((e) => e.t_s), arrive_events: kinds(r, 'arrive').map((e) => e.t_s), arrival_t_s: a.arrival_t_s, final_mode: a.final_mode, displacement_mm: Math.abs(S[S.length - 1][4] - S[0][4]) };
};
{
  const tc = checkTimeContract(ph3bTimeAdapter, 'PH-3b');
  ok(tc.refused.length === 0, 'R5: PH-3b runs every time-contract case');
  ok(tc.failures.length === 0, `R5: PH-3b meets the time-boundary contract (${tc.failures.join(' | ')})`);
  checks += tc.checks;
  repro.R5_time_contract = { checks: tc.checks, rows: tc.rows };
  // joints never accumulate rounding into an event time: a zig-zag lane whose joints sit at 0.1-mm multiples
  const zig = [{ x: 0, y: 0 }]; for (let k = 1; k <= 6; k++) zig.push({ x: zig[k - 1].x + 0.1, y: k % 2 ? 0.1 : 0 });
  let len = 0; for (let k = 1; k < zig.length; k++) len += Math.hypot(zig[k].x - zig[k - 1].x, zig[k].y - zig[k - 1].y);
  for (const v of [0.1, 0.3, 1.7]) {
    const H = len / v, r = solve2D({ lanes: [{ id: 'Z', centerline_mm: zig, width_mm: 50, layer: 'z' }], obstacles: [], horizon_s: H, agents: [{ id: 'A', lane: 'Z', s_mm: 0, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: len, free_speed_mm_s: v, body: { length_mm: 0.05, width_mm: 0.02 } }] });
    ok(r.agents.A.arrival_t_s !== null && Math.abs(r.agents.A.arrival_t_s - H) <= 8 * Number.EPSILON * Math.max(1, H), `R5: through 5 joints at ${v} mm/s the arrival is computed from the inputs and lands at H = ${H} (got ${r.agents.A.arrival_t_s})`);
  }
}
evidence.repro = repro;

// ---- 2. every PH-3b scenario and playback run, cross-checked
const scenarioFile = (id: string) => { const p = path.join(REPO_ROOT, 'prototypes/physics-playback/scenarios', `${id}.json`); return fs.existsSync(p) ? p : path.join(REPO_ROOT, 'prototypes/solver-compare/scenarios', `${id}.json`); };
const scen = (id: string) => loadScenario(JSON.parse(fs.readFileSync(scenarioFile(id), 'utf8')) as ScenarioFile);
const SCEN = ['head-on-2', 'offset-block', 'pass-clear', 'pass-graze', 'crossing', 'crossing-flank', 'stone', 'corridor-8', 'crossing-traffic-100'];
const perScenario: Record<string, unknown> = {};
const base = new Map<string, { inp: Solver2DInput; r: Solver2DResult }>();
for (const id of SCEN) {
  const sc = scen(id), inp = ph3bInput(sc), r = solve2D(inp);
  base.set(id, { inp, r });
  perScenario[id] = { ...crossCheck(id, r, sc.horizon_s), constraint_activations: r.stats.contacts, sub_resolution_excursions: r.stats.sub_resolution_excursions, arrived: r.stats.arrived, stalled: r.stats.stalled };
  // playback export form (the page's files): the same checker on the exported segments
}
{
  // the committed playback files (what the page shows) pass the same checker
  const dir = path.join(REPO_ROOT, 'prototypes/physics-playback/data');
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('--ph3b.json'))) {
    const run = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const m: CkMotion = { horizon_s: run.horizon_s, body: { length_mm: run.body.length_mm, width_mm: run.body.width_mm }, agents: run.agents.map((a: { id: string; segments: CkMotion['agents'][number]['segments']; final: { x: number; y: number; heading: number }; layer: string }) => ({ id: a.id, segments: a.segments, final: a.final, present_from: 0, present_until: null, layer: a.layer })), events: run.events };
    const c = checkContacts(m), mm = checkMotion(m);
    ok(c.violations === 0 && mm.problems.length === 0, `playback ${f}: exported motion and contact events pass the independent checker (${c.problems.slice(0, 2)} ${mm.problems.slice(0, 2)})`);
    for (const e of run.events.filter((x: { kind: string }) => x.kind === 'contact_end')) ok(Array.isArray(e.bracket_s) && typeof e.err_s === 'number' && Array.isArray(e.check_s) && typeof e.check_err_s === 'number' && e.t >= e.check_s[0] && e.t <= e.check_s[1], `playback ${f}: contact_end at ${e.t} carries the solver bracket/error and the independent check interval`);
  }
}
evidence.scenarios = perScenario;

// ---- 2b. seeded random crossings / passes / followers (2–6 bodies), every contact event cross-checked
{
  const g = rng(20261108);
  let runs = 0, episodes = 0, ends = 0, maxErr = 0;
  for (let k = 0; k < 60; k++) {
    const n = 2 + Math.floor(g() * 5), agents: SolverAgent[] = [];
    const lanes = [{ id: 'EW', centerline_mm: [{ x: 0, y: 50 }, { x: 100, y: 50 }], width_mm: 3, layer: 'z' }, { id: 'NS', centerline_mm: [{ x: 50, y: 0 }, { x: 50, y: 100 }], width_mm: 3, layer: 'z' }];
    for (let i = 0; i < n; i++) {
      const lane = g() < 0.5 ? 'EW' : 'NS', dir: 1 | -1 = g() < 0.5 ? 1 : -1, s = dir > 0 ? 30 + g() * 15 : 55 + g() * 15;
      const u = Math.round((g() * 2 - 1) * 1.1 * 100) / 100;
      agents.push({ id: `R${i}`, lane, s_mm: s, u_mm: u, dir, start_t_s: Math.round(g() * 40) / 100, goal_s_mm: dir > 0 ? 80 : 20, free_speed_mm_s: 8 + g() * 12, body: BODY });
    }
    let r: Solver2DResult;
    try { r = solve2D({ lanes, obstacles: [], horizon_s: 4, agents }); } catch { continue; }   // overlapping random starts are refused (not a contact case)
    runs++;
    const x = crossCheck(`random #${k}`, r, 4);
    episodes += x.episodes; ends += x.ends; maxErr = Math.max(maxErr, x.checker_max_err_s ?? 0, x.checker_max_start_err_s ?? 0);
  }
  ok(runs >= 30 && episodes > 20 && ends > 5, `random cases are not vacuous (${runs} runs, ${episodes} episodes, ${ends} ends)`);
  evidence.random = { seed: 20261108, runs, episodes, ends, checker_max_err_s: maxErr };
}

// ---- 3. invariance: broad phase, input order, relabelling, horizon
{
  const rows: Record<string, unknown> = {};
  for (const id of ['crossing-flank', 'corridor-8', 'crossing-traffic-100']) {
    const { inp, r } = base.get(id)!, h0 = hash(r);
    const variants: [string, Solver2DInput][] = [['window 0.01 s', { ...inp, window_s: 0.01 }], ['window 25 s', { ...inp, window_s: 25 }], ['grid 2 mm', { ...inp, grid_cell_mm: 2 }], ['sweep-and-prune', { ...inp, broadphase: 'sap' }], ['reversed input', { ...inp, agents: [...inp.agents].reverse() }]];
    const g = rng(99); const perm = [...inp.agents]; for (let i = perm.length - 1; i > 0; i--) { const j = Math.floor(g() * (i + 1)); [perm[i], perm[j]] = [perm[j], perm[i]]; }
    variants.push(['permuted input', { ...inp, agents: perm }]);
    const use = id === 'crossing-traffic-100' ? variants.filter(([n]) => n === 'window 25 s' || n === 'permuted input') : variants;
    for (const [n, v] of use) ok(hash(solve2D(v)) === h0, `${id}: ${n} → bit-identical trajectories and events (incl. every contact time)`);
    rows[id] = use.map(([n]) => n);
  }
  evidence.invariance = rows;
  // relabelling: the same physics under ids in the opposite order (same-instant processing must not depend on id order)
  for (const id of ['crossing-flank', 'corridor-8']) {
    const { inp, r } = base.get(id)!, ids = inp.agents.map((a) => a.id).sort(), map = new Map(ids.map((x, i) => [x, `Z${String(ids.length - i).padStart(3, '0')}`]));
    const r2 = solve2D({ ...inp, agents: inp.agents.map((a) => ({ ...a, id: map.get(a.id)! })) });
    let same = true; for (const x of ids) if (JSON.stringify(r.agents[x].samples) !== JSON.stringify(r2.agents[map.get(x)!].samples)) same = false;
    const ct = (q: Solver2DResult, m: (s: string) => string) => q.events.filter((e) => e.kind.startsWith('contact_')).map((e) => `${e.t_s}|${e.kind}|${e.agents.map(m).sort().join(',')}`).sort().join(';');
    ok(same && ct(r, (s) => map.get(s)!) === ct(r2, (s) => s), `${id}: relabelled ids (reversed id order) → identical motion and contact times`);
  }
  // horizons: the run to H1 is a prefix of the run to H2 > H1 (a contact_end is known once confirmed: compared when
  // its confirmation is ≤ H1; horizon-only events excluded)
  const hz: Record<string, unknown> = {};
  for (const [id, mk] of [['R1 slide', (H: number) => cross(60, 0.1, H)], ['R2 pressed', (H: number) => cross(51.3, 0.1, H)], ['crossing-flank', (H: number) => ({ ...base.get('crossing-flank')!.inp, horizon_s: H })]] as [string, (H: number) => Solver2DInput][]) {
    // 0.3773988 s lies between R1's last up-crossing of θ and its confirmation (θ + ρ): the end is unconfirmed there
    const Hs = [0.3, 0.33, 0.3773988, 0.5, 1.2, 3], runs = Hs.map((H) => solve2D(mk(H)));
    const pre = (q: Solver2DResult, H: number) => JSON.stringify({ e: q.events.filter((e) => e.t_s < H && (e.confirmed_t_s === undefined || e.confirmed_t_s < H) && e.kind !== 'stalled' && e.kind !== 'contact_end_unconfirmed'), s: Object.fromEntries(Object.entries(q.agents).map(([k, a]) => [k, a.samples.filter((x) => x[0] < H)])) });
    for (let i = 0; i < Hs.length; i++) for (let j = i + 1; j < Hs.length; j++) ok(pre(runs[i], Hs[i]) === pre(runs[j], Hs[i]), `${id}: run to ${Hs[i]} s is a prefix of the run to ${Hs[j]} s`);
    for (let i = 0; i < Hs.length; i++) crossCheck(`${id} H=${Hs[i]}`, runs[i], Hs[i]);
    if (id === 'R1 slide') ok(kinds(runs[2], 'contact_end_unconfirmed').length === 1 && kinds(runs[2], 'contact_end').length === 0 && kinds(runs[3], 'contact_end').length === 1, 'R1: a horizon between the up-crossing and its confirmation reports contact_end_unconfirmed (not usable as a cause); a later horizon reports the exact end');
    hz[id] = Hs.map((H, i) => ({ H, episodes: kinds(runs[i], 'contact_start').length, ends: kinds(runs[i], 'contact_end').length, unconfirmed: kinds(runs[i], 'contact_end_unconfirmed').length }));
  }
  evidence.horizons = hz;
}

// ---- 4. sensitivity to the contact tolerance θ (the resolution of the sliding approximation); reported, not a target
{
  const tab: Record<string, unknown>[] = [];
  for (const id of ['crossing-flank', 'crossing-traffic-100']) {
    const { inp } = base.get(id)!, ref = solve2D({ ...inp, active_tol_mm: 1e-8 });
    for (const tol of [1e-8, 1e-7, 1e-6]) {
      const r = tol === 1e-8 ? ref : solve2D({ ...inp, active_tol_mm: tol }), H = inp.horizon_s;
      const x = crossCheck(`${id} θ=${tol}`, r, H, tol);
      let dmax = 0; for (const k of Object.keys(r.agents)) { const a = r.agents[k].samples.at(-1)!, b = ref.agents[k].samples.at(-1)!; dmax = Math.max(dmax, Math.hypot(a[1] - b[1], a[2] - b[2])); }
      tab.push({ scenario: id, tol_mm: tol, episodes: x.episodes, ends: x.ends, constraint_activations: r.stats.contacts, sub_resolution_excursions: r.stats.sub_resolution_excursions, events: r.events.length, arrived: r.stats.arrived, final_pos_diff_vs_1e8_mm: dmax, checker_max_err_s: x.checker_max_err_s });
    }
  }
  const eps = (id: string) => tab.filter((x) => x.scenario === id).map((x) => `${x.episodes}/${x.ends}`);
  ok(new Set(eps('crossing-flank')).size === 1, `crossing-flank: episodes/ends independent of θ (${eps('crossing-flank')})`);
  evidence.tolerance_sensitivity = tab;
}

// ---- 5. positive controls: the checker is not vacuous
{
  const r = solve2D(cross(60, 0.1)), m = motion(r, 3);
  const mutate = (f: (ev: CkMotion['events']) => CkMotion['events']) => checkContacts({ ...m, events: f(m.events.map((e) => ({ ...e }))) });
  const end = (ev: CkMotion['events']) => ev.find((e) => e.kind === 'contact_end')!;
  ok(mutate((ev) => { end(ev).t += 1e-3; end(ev).bracket_s = undefined; return ev; }).violations > 0, 'control: an end shifted by 1 ms is caught');
  ok(mutate((ev) => { end(ev).t -= 1e-6; end(ev).bracket_s = undefined; return ev; }).violations > 0, 'control: an end 1 µs early is caught');
  ok(mutate((ev) => ev.filter((e) => e.kind !== 'contact_end')).violations > 0, 'control: a deleted end (open contact that separated) is caught');
  ok(mutate((ev) => ev.filter((e) => !e.kind.startsWith('contact_'))).missed > 0, 'control: a deleted episode (missed contact) is caught');
  ok(mutate((ev) => { const x = end(ev); x.kind = 'contact_end_estimated'; x.usable_as_cause = false; return ev; }).violations > 0, 'control: an exact end relabelled as estimated (no body left) is caught');
  // the 6864974 behaviour: a contact_end at the first constraint release of the slide (gap above θ by < 1e-15 mm)
  const old = solve2D({ ...cross(60, 0.1), active_tol_mm: ACTIVE_TOL_MM });
  const firstRelease = old.events.find((e) => e.kind === 'follow')!.t_s;
  ok(mutate((ev) => { const s = ev.find((e) => e.kind === 'contact_start')!; return [s, { t: firstRelease, kind: 'contact_end', agents: s.agents }, { t: firstRelease + 1e-6, kind: 'contact_start', agents: s.agents }, ...ev.filter((e) => e !== s)].sort((a, b) => a.t - b.t); }).violations > 0, 'control: an end at a constraint re-solve of the slide (6864974) is caught');
  const pen = JSON.parse(JSON.stringify(m)) as CkMotion; pen.agents[0].segments = pen.agents[0].segments.map((g) => ({ ...g, x0: g.x0 + 0.3, x1: g.x1 + 0.3 }));
  ok(checkContacts(pen).violations > 0, 'control: a body moved 0.3 mm into the other is caught');
  const tele = JSON.parse(JSON.stringify(m)) as CkMotion; tele.agents[0].segments[1].x0 += 1e-6;
  ok(checkMotion(tele).teleports > 0, 'control: a 1e-6 mm jump between motion records is caught');
}

if (ALL) { console.log(JSON.stringify({ ph3b_contact_time: failed.length ? 'FAIL' : 'pass', checks, failed: failed.length, failures: failed }, null, 1)); if (failed.length) process.exitCode = 1; }
else console.log(JSON.stringify({ ph3b_contact_time: 'pass', checks, evidence }, null, 1));
