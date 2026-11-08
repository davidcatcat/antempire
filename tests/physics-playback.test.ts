/**
 * Physics playback (docs/physics-playback.md), BLOCKING:
 *  1. the committed prototypes/physics-playback/data equals a fresh export (no stale or hand-edited data);
 *  2. every drawn PH-3b segment boundary is an engine event time of that agent (or the run start / horizon), and every
 *     native segment is one of the engine's MotionInterval records;
 *  3. replaying the exported motion with the PAGE's own code (motion.js) reproduces the solver's recorded poses at every
 *     record and its final poses, from a fresh solve;
 *  4. the page (index.html, app.js, motion.js) does not import engine/ or cli/, runs no solver, writes nothing; it only
 *     fetches ./data;
 *  5. the page carries the 非正式 / not-biology label; every scenario is synthetic;
 *  6. (Owner decision 9) the no-yield control N and the control scenarios K0–K3 (crossing-traffic-100, A/B/C/N, seed 1)
 *     are on the page, labelled as controls; presence intervals (entry / exit) are the solver's own; every boundary
 *     event (entry, exit, entry blocked, estimated contact end) is flagged, and estimated ends are not usable as a cause.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { buildAll, buildAllWithResults, SCENARIOS, STEER_SCENARIOS, STEER_RUN_POLICIES, CONTROL_BASE, CONTROL_VARIANTS, CONTROL_LABEL, CONTROL_SCOPE, HERE, DATA_DIR, scenarioFile, type PbRun } from '../prototypes/physics-playback/export.ts';
import type { Solver2DResult } from '../engine/physics/solver2d.ts';
import type { SteerResult } from '../engine/physics/local-steer.ts';
import { CANDIDATE_LABEL } from '../prototypes/local-steer/lib.ts';
import { loadScenario, type ScenarioFile } from '../prototypes/solver-compare/lib/spec.ts';
import { nativeConfig } from '../prototypes/solver-compare/lib/native.ts';
import { simulate } from '../engine/physics/collision.ts';
// @ts-expect-error plain JS module of the page (no type declarations)
import { poseAt, boundaryTimes } from '../prototypes/physics-playback/motion.js';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };

// 1. fresh export (the solver results of this same export are checked below)
const built = buildAllWithResults(), fresh = built.files;
const onDisk = fs.readdirSync(DATA_DIR).sort();
ok(JSON.stringify(onDisk) === JSON.stringify([...fresh.keys()].sort()), 'data/ holds exactly the exported files');
for (const [n, c] of fresh) ok(fs.readFileSync(path.join(DATA_DIR, n), 'utf8') === c, `data/${n} = fresh export`);
{ const again = buildAll(); ok(again.size === fresh.size && [...fresh].every(([n, c]) => again.get(n) === c), 'export is deterministic (every file)'); }

const index = JSON.parse(fresh.get('index.json')!);
ok(/非正式/.test(index.label) && /不是生物行為/.test(index.label), 'index label: 非正式, not biology');
let ph3bRuns = 0, nativeRuns = 0, steerRuns = 0, controlRuns = 0, segs = 0;
for (const meta of index.runs) {
  const run = JSON.parse(fresh.get(`${meta.run_id}.json`)!) as PbRun;
  ok(run.scenario.synthetic === true, `${meta.run_id}: synthetic`);
  const s = STEER_SCENARIOS.find((x) => x.id === (run.control?.base_scenario ?? run.scenario.id))!, file = s.from === 'playback' ? path.join(HERE, 'scenarios', `${s.id}.json`) : path.join(HERE, '..', 'solver-compare', 'scenarios', `${s.id}.json`);
  ok(file === scenarioFile(s), `${meta.run_id}: scenario file`);
  const sc = loadScenario(JSON.parse(fs.readFileSync(file, 'utf8')) as ScenarioFile);
  ok(run.body.length_mm === sc.body.length_mm.value && run.body.width_mm === sc.body.width_mm.value, `${meta.run_id}: body sizes come from the spec loader`);
  for (const a of run.agents) for (let i = 0; i < a.segments.length; i++) {
    const g = a.segments[i]; segs++;
    ok(g.t1 > g.t0, `${meta.run_id}/${a.id}: segment has positive duration`);
    if (i) ok(a.segments[i - 1].t1 === g.t0, `${meta.run_id}/${a.id}: segments are contiguous in time`);
  }
  if (run.solver === 'ph3b') {
    ph3bRuns++;
    // 2. boundaries are engine event times of the agent
    const res = built.results.get(run.run_id) as Solver2DResult, H = res.stats.t_end_s;
    for (const a of run.agents) {
      const own = new Set(res.events.filter((e) => e.agents.includes(a.id)).map((e) => e.t_s));
      for (const g of a.segments) for (const t of [g.t0, g.t1]) ok(t === 0 || t === H || own.has(t), `${meta.run_id}/${a.id}: boundary ${t} is an engine event time of this agent`);
      // 3. replay with the page's code reproduces every solver record and the final pose
      const S = res.agents[a.id].samples;
      for (const smp of S) {
        const later = S.filter((q) => q[0] === smp[0]).at(-1)!;      // at an instant turn the later record holds
        const p = poseAt(a, smp[0]);
        ok(Math.abs(p.x - later[1]) <= 1e-9 && Math.abs(p.y - later[2]) <= 1e-9, `${meta.run_id}/${a.id}: replay at ${smp[0]} = solver record`);
      }
      const last = S.at(-1)!, pf = poseAt(a, H);
      ok(pf.x === last[1] && pf.y === last[2] && pf.heading === last[3], `${meta.run_id}/${a.id}: final pose = solver final pose`);
      // between records, the page's pose is on the solver's straight constant-velocity motion
      for (const g of a.segments) { const tm = (g.t0 + g.t1) / 2, p = poseAt(a, tm); ok(Math.abs(p.x - (g.x0 + g.x1) / 2) <= 1e-9 && Math.abs(p.y - (g.y0 + g.y1) / 2) <= 1e-9, `${meta.run_id}/${a.id}: midpoint on the segment`); }
    }
    const evT = new Set(run.events.map((e) => e.t));
    for (const t of boundaryTimes(run)) ok(t === 0 || t === H || evT.has(t), `${meta.run_id}: drawn boundary ${t} is listed in the event list`);
  } else if (run.solver === 'steer') {
    // WP4 candidate runs: same exactness checks as PH-3b, against a fresh run of the isolated module
    steerRuns++;
    const isControl = run.policy === 'N_no_yield' || !!run.control;
    if (isControl) ok(run.label === CONTROL_LABEL && run.label.includes('控制組（非本種／假設）') && run.label.includes('非正式') && meta.label === CONTROL_LABEL, `${meta.run_id}: control label`);
    else ok(run.label === CANDIDATE_LABEL && run.label.includes('隔離物理實驗・候選行為規則（非本種/假設）') && meta.label === CANDIDATE_LABEL, `${meta.run_id}: candidate label`);
    ok(run.solver_notes.some((n) => /非本種|不是本種/.test(n)) && run.solver_notes.some((n) => /遊戲假設/.test(n)), `${meta.run_id}: notes say not this species / assumption`);
    if (run.policy === 'N_no_yield') ok(run.solver_notes.some((n) => /控制組 N/.test(n)) && /對照，非候選/.test(run.solver_label), `${meta.run_id}: N is labelled as the no-yield control`);
    const res = built.results.get(run.run_id) as SteerResult, H = res.stats.t_end_s;
    ok(res.policy === run.policy, `${meta.run_id}: result of this policy`);
    if (run.control) {
      controlRuns++;
      ok(run.scenario.id === `${CONTROL_BASE}~${run.control.variant}` && run.scope_note === CONTROL_SCOPE && /對照情境/.test(run.solver_notes.join(' ')), `${meta.run_id}: control scenario labelled`);
      for (const a of run.agents) {
        const o = res.agents[a.id];
        ok(a.present_from_t_s === (run.control.spawn ? o.present_from_t_s : undefined) && a.removed_t_s === (run.control.exit ? o.removed_t_s : undefined), `${meta.run_id}/${a.id}: presence interval = solver's`);
        if (a.segments.length) ok(a.segments[0].t0 === (a.present_from_t_s ?? 0) && (typeof a.removed_t_s !== 'number' || a.segments.at(-1)!.t1 <= a.removed_t_s), `${meta.run_id}/${a.id}: motion only while on the road`);
        else ok(a.present_from_t_s === null && a.final === null, `${meta.run_id}/${a.id}: no motion only when it never entered`);
      }
    }
    // boundary events: flagged exactly; an estimated contact end is never usable as a cause
    for (const e of run.events) {
      const want = e.kind === 'exit' || e.kind === 'entry_blocked' || e.kind === 'contact_end_estimated' || (e.kind === 'start' && /control scenario boundary/.test(e.detail ?? ''));
      ok((e.boundary === true) === want, `${meta.run_id}: boundary flag on ${e.kind} at ${e.t}`);
      if (e.kind === 'contact_end_estimated') ok(e.usable_as_cause === false, `${meta.run_id}: estimated contact end not usable as a cause`);
      if (want) ok(!!run.control, `${meta.run_id}: boundary events only in control runs`);
    }
    for (const a of run.agents) {
      if (!a.segments.length) continue;
      const own = new Set(res.events.filter((e) => e.agents.includes(a.id)).map((e) => e.t_s));
      for (const g of a.segments) for (const t of [g.t0, g.t1]) ok(t === 0 || t === H || own.has(t), `${meta.run_id}/${a.id}: boundary ${t} is an engine event time of this agent`);
      const S = res.agents[a.id].samples;
      for (const smp of S) { const later = S.filter((q) => q[0] === smp[0]).at(-1)!, p = poseAt(a, smp[0]); ok(Math.abs(p.x - later[1]) <= 1e-9 && Math.abs(p.y - later[2]) <= 1e-9, `${meta.run_id}/${a.id}: replay at ${smp[0]} = solver record`); }
      const last = S.at(-1)!, pf = poseAt(a, typeof a.removed_t_s === 'number' ? a.removed_t_s : H);
      ok(pf.x === last[1] && pf.y === last[2] && pf.heading === last[3], `${meta.run_id}/${a.id}: final pose = solver final pose`);
      for (const g of a.segments) { const tm = (g.t0 + g.t1) / 2, p = poseAt(a, tm); ok(Math.abs(p.x - (g.x0 + g.x1) / 2) <= 1e-9 && Math.abs(p.y - (g.y0 + g.y1) / 2) <= 1e-9 && Math.abs(p.u - ((g.u + (g.u1 ?? g.u)) / 2)) <= 1e-9, `${meta.run_id}/${a.id}: midpoint on the segment`); }
    }
    const evT = new Set(run.events.map((e) => e.t));
    for (const t of boundaryTimes(run)) ok(t === 0 || t === H || evT.has(t), `${meta.run_id}: drawn boundary ${t} is listed in the event list`);
    // R14: the dense benchmark says what it is (not) valid for; every contact_end carries the independent bracket
    ok(/^crossing-traffic-/.test(run.scenario.id) === Boolean(run.scope_note && /不適用於/.test(run.scope_note) && meta.scope_note === run.scope_note), `${meta.run_id}: applicability note exactly on the dense benchmark`);
    ok(run.contact_end_check?.violations === 0 && run.events.filter((e) => e.kind === 'contact_end').every((e) => e.check_s && e.check_s[0] <= e.t && e.t <= e.check_s[1] && e.err_s === e.check_s[1] - e.check_s[0] && e.bracket_s && e.bracket_s[1] === e.t), `${meta.run_id}: contact_end inside the independent bracket, error bound recorded`);
  } else {
    nativeRuns++;
    const res = simulate(nativeConfig(sc));
    for (const a of run.agents) {
      const recs = res.intervals[a.id].filter((iv) => iv.t_end_s > iv.t_start_s);
      for (const iv of recs) ok(a.segments.some((g) => g.t0 === iv.t_start_s && g.t1 === iv.t_end_s && g.s0 === iv.s_start_mm && g.s1 === iv.s_end_mm), `${meta.run_id}/${a.id}: native record ${iv.t_start_s}–${iv.t_end_s} drawn as is`);
      const recT = new Set(run.events.filter((e) => e.kind === 'record' && e.agents.includes(a.id)).map((e) => e.t));
      for (const g of a.segments) ok(recT.has(g.t0), `${meta.run_id}/${a.id}: segment start ${g.t0} is a listed native record`);
      const lastRec = recs.at(-1);
      if (lastRec) { const p = poseAt(a, run.horizon_s); ok(p.s === lastRec.s_end_mm, `${meta.run_id}/${a.id}: replay ends at the last native record`); }
    }
  }
}
ok(ph3bRuns === SCENARIOS.length && nativeRuns === SCENARIOS.filter((s) => s.native).length, 'one PH-3b run per scenario, native where asked');
ok(STEER_RUN_POLICIES.join() === 'A_free_direction,B_contact_decision,C_sidestep,N_no_yield', 'the page holds A, B, C and the no-yield control N');
ok(controlRuns === CONTROL_VARIANTS.length * STEER_RUN_POLICIES.length && CONTROL_VARIANTS.join() === 'K0_lattice_stay,K1_lattice_exit,K2_inflow_stay,K3_inflow_exit', 'control runs: K0–K3 × A/B/C/N');
ok(steerRuns === STEER_SCENARIOS.length * STEER_RUN_POLICIES.length + controlRuns, 'one run per policy (A, B, C, N) per steer scenario, plus the control runs');
// the control runs show what they are for: entries in K2/K3, exits in K1/K3, no boundary rule in K0
const ctl = (v: string, p: string) => JSON.parse(fresh.get(`${CONTROL_BASE}-${v}--steer-${p}.json`)!) as PbRun;
for (const p of ['A', 'B', 'C', 'N']) {
  ok(ctl('K2', p).events.some((e) => e.kind === 'start' && e.boundary) && !ctl('K2', p).events.some((e) => e.kind === 'exit'), `K2 ${p}: timed entries, no exits`);
  // an arrived agent leaves by the exit rule (N never arrives here, so it has no exit)
  const exits = (r: PbRun) => r.events.filter((e) => e.kind === 'exit').length, arrivals = (r: PbRun) => r.events.filter((e) => e.kind === 'arrive').length;
  ok(exits(ctl('K1', p)) <= arrivals(ctl('K1', p)) && (exits(ctl('K1', p)) > 0) === (arrivals(ctl('K1', p)) > 0) && !ctl('K1', p).events.some((e) => e.kind === 'start' && e.boundary), `K1 ${p}: exits after arrivals, no timed entries`);
  ok(exits(ctl('K3', p)) <= arrivals(ctl('K3', p)) && (exits(ctl('K3', p)) > 0) === (arrivals(ctl('K3', p)) > 0) && ctl('K3', p).events.some((e) => e.kind === 'start' && e.boundary), `K3 ${p}: entries, exits after arrivals`);
  ok(!ctl('K0', p).events.some((e) => e.boundary), `K0 ${p}: no boundary rules`);
}
// the scenario set shows a geometric pass and a forced stop
const kinds = (id: string) => new Set((JSON.parse(fresh.get(`${id}--ph3b.json`)!) as PbRun).events.map((e) => e.kind));
ok(kinds('pass-clear').has('pass') && !kinds('pass-clear').has('contact_start'), 'pass-clear: a pass without contact');
ok(kinds('head-on-2').has('stop') && !kinds('head-on-2').has('arrive'), 'head-on-2: the narrow gap forces a stop');
ok(kinds('crossing-flank').has('resume'), 'crossing-flank: a stopped body resumes once the other has moved on');

// 4. the page only reads the JSON
const pageFiles = ['index.html', 'app.js', 'motion.js'];
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
for (const f of pageFiles) {
  const src = strip(fs.readFileSync(path.join(HERE, f), 'utf8'));
  ok(!/(engine|cli|web)\//.test(src.replace(/data\//g, '')), `${f}: no reference to engine/, cli/ or web/`);
  ok(!/\bimport\s*\(/.test(src) && !/require\s*\(/.test(src), `${f}: no dynamic import / require`);
  for (const m of src.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g)) ok(m[1] === './motion.js', `${f}: imports only ./motion.js (${m[1]})`);
  ok(!/solve2D|simulate\(|localStorage|indexedDB|XMLHttpRequest|method:\s*['"](POST|PUT)/.test(src), `${f}: runs no solver and writes nothing`);
  ok(!/https?:\/\//.test(src), `${f}: no external resources`);
}
const appSrc = fs.readFileSync(path.join(HERE, 'app.js'), 'utf8');
ok(/fetch\(url\)/.test(appSrc) && /'data\/index\.json'/.test(appSrc), 'app.js fetches ./data only');
const html = fs.readFileSync(path.join(HERE, 'index.html'), 'utf8');
ok(html.includes('隔離物理實驗・非正式・不是生物行為（讓路／側移決策尚未建模）'), 'page label');
ok(/不是取樣點插值，沒有任何平滑/.test(html), 'legend: exact piecewise motion, no smoothing');
ok(/src="app\.js"/.test(html) && !/src="\//.test(html) && !/href="\//.test(html), 'relative paths only');
// the official pipeline never references the playback
const walk = (d: string): string[] => fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]) : [];
for (const f of [...walk(path.join(REPO_ROOT, 'engine')), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src'))].filter((f) => /\.(ts|js)$/.test(f))) ok(!fs.readFileSync(f, 'utf8').includes('physics-playback'), `${path.relative(REPO_ROOT, f)} does not reference the playback`);

ok(/候選行為規則（非本種\/假設）/.test(appSrc) === false && /st\.run\.label/.test(appSrc), 'app.js shows the run label (candidate runs carry their own badge)');
console.log(JSON.stringify({ physics_playback: 'pass', checks, runs: index.runs.length, steer_runs: steerRuns, control_runs: controlRuns, segments: segs }, null, 2));
