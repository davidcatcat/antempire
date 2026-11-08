/**
 * PH-3b contact kinds (issue #146, Owner decision 6; docs/physics-time-contract.md §4). BLOCKING.
 *  1. the split is read-only bookkeeping: every motion record and every pre-existing event field is bit-identical to
 *     83397c5 (the commit before the split) on every PH-3b bench / playback scenario;
 *  2. geometric_contact = the contact events (contact_kind on every contact event);
 *  3. constraint_active intervals: INDEPENDENT checker (prototypes/physics-check/contact-check.ts) — gap ≤ θ at the
 *     start and throughout, ≥ θ at the release, and constraint_active ⊆ geometric_contact;
 *  4. the kinds are not derivable from each other: a geometric contact without any constraint (graze), constraints that
 *     never bind, many constraint intervals inside one geometric episode (sliding);
 *  5. antenna_contact is unsupported in PH-3b: never emitted, result field null;
 *  6. determinism of the intervals (reversed input order, broad-phase variants);
 *  7. positive controls: the constraint checker catches a shifted, an invented and an over-long interval.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { solve2D, CONTACT_KINDS_EMITTED, type Solver2DInput, type Solver2DResult } from '../engine/physics/solver2d.ts';
import { loadScenario, type ScenarioFile } from '../prototypes/solver-compare/lib/spec.ts';
import { ph3bInput } from '../prototypes/solver-compare/lib/ph3b.ts';
import { TRAJ_SHA256_83397C5 } from '../prototypes/solver-compare/lib/ph3b-ref.ts';
import { checkContacts, checkConstraints, motionFromSamples, type CkConstraint } from '../prototypes/physics-check/contact-check.ts';
import { rng } from '../engine/rng.ts';
import { REPO_ROOT } from '../cli/lib/load.ts';

let checks = 0; const ok = (c: unknown, why: string) => { checks++; assert.ok(c, why); };
const sha = (x: unknown) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
/** the event fields that existed at 83397c5 (contact_kind is new) */
const oldEvents = (r: Solver2DResult) => r.events.map((e) => ({ t_s: e.t_s, kind: e.kind, agents: e.agents, class: e.class, detail: e.detail, bracket_s: e.bracket_s, err_s: e.err_s, err_clamped: e.err_clamped, confirmed_t_s: e.confirmed_t_s, exact: e.exact, usable_as_cause: e.usable_as_cause }));
const oldStats = (r: Solver2DResult) => ({ ...r.stats, constraint_intervals: undefined, constraint_intervals_binding: undefined });

// sha256 at 83397c5 of [motion records, old event fields, old stats] (computed on 83397c5 before the change)
const REF: Record<string, [string, string, string]> = {
  'head-on-2': [TRAJ_SHA256_83397C5['head-on-2'], '5b989ed4f9051f087424001378b2db817a39db072c2e444a7c699051b7424a3b', '89cc9c595c54fb10fa4290134a74ff401319d5f425d8e6476467bfd926b15a6a'],
  'corridor-8': [TRAJ_SHA256_83397C5['corridor-8'], 'a67142d52a858325a80325e32ced35e9ef8207297421cc11dac3c94ff02ffc44', '2e9b60f856fdaf925d6cbd7ebc56a5252ff254783629b2a0358af84e59289197'],
  stone: [TRAJ_SHA256_83397C5.stone, '3b3f15eaece6bd502fb7edc6c7651906d5d08a8b3bfe8af726fd5f6d71055749', 'e9ff1b0c946cd023ad35b44b22ec79a0c91b772ed61ae65cbadef63443213889'],
  crossing: [TRAJ_SHA256_83397C5.crossing, 'de125f438ec650dd931b5d5a4ed771c5a505f8458ebc81ecb48be5024cc2dba9', '44ad486eba5f19a619cca755c365de82401b6495f5e6284c5de04689c14832fe'],
  'crossing-traffic-100': [TRAJ_SHA256_83397C5['crossing-traffic-100'], '3580452d35828bc6d6b9e8bb3e00c08798c410104b3b0c3ca123926f1150e64a', '28bc49ea1bffe2d529778b450c7f6b4a3320d2a820260a10eb0364642fa48270'],
  'offset-block': ['fbf6b9f26d8c6d4d38d80cdb18d9d2224125e9864546baaa701d07c429963270', 'abe15fa2dd778b6b96f41fb949456c85597d6e8229ed0bf0ce26fd63b8d8a5d3', '8e8eda8f77be75b837349e875f6bc01ad668de2078c27baaadd33b525a9ec832'],
  'pass-clear': ['1e3600537a82b2068c0f302b2f29060007e88e3f29bf201cd623575bbd99fe03', '8a88144e03b5efda29cd40ac8befa6a3e16bb8d00c195dd053e26b8e6d479718', 'ff50034ecbfc9f0672b634fe12e56d4b746f3aa372892631f7e561b1dd931cb5'],
  'pass-graze': ['59639ec8ab197769dc6c89b696c991144d37497f95646737b4c847087c733543', '2522b0dbc1dd7cfb6b1b934351e73cb91873f0ee67e58007d57073d6d63c3e1d', '72aa69cb9c5af0e52f81c8b632f1bf299881375576b73bef20ec4fcff970b964'],
  'crossing-flank': ['3e4250083c781a1d8c39c2199ed9f4be109675c59dff3eb4c72a4b08e559e319', 'f7ba1190f5f439772b3c083dfe4745ea1b36c08463e0bfbfea8b05e2c9418d72', '8dbe8a8050e3fbb97e2f62271f2bb9a39b6a28272fcfb593e06bfd0a570b9c94'],
};
const scen = (id: string) => {
  const pb = path.join(REPO_ROOT, 'prototypes/physics-playback/scenarios', `${id}.json`);
  return fs.existsSync(pb) ? loadScenario(JSON.parse(fs.readFileSync(pb, 'utf8')) as ScenarioFile) : loadScenario(id);
};

/** the independent checks of one run; returns the constraint report */
function kinds(label: string, r: Solver2DResult, H: number, body: { length_mm: number; width_mm: number }) {
  // 5. antenna contact: never emitted, the field is null
  ok(r.antenna_contact === null && !r.events.some((e) => e.contact_kind === 'antenna_contact' || /antenna/i.test(e.kind)) && !r.constraint_active.some((c) => (c.contact_kind as string) === 'antenna_contact'), `${label}: no antenna contact (PH-3b has no antenna geometry)`);
  // 2. geometric contact = the contact events
  for (const e of r.events) if (e.kind.startsWith('contact_')) ok(e.contact_kind === 'geometric_contact' && (e.class === 'physical_contact' || e.kind === 'contact_end_unconfirmed'), `${label}: ${e.kind} at ${e.t_s} is a geometric_contact event`);
  for (const e of r.events) if (!e.kind.startsWith('contact_')) ok(e.contact_kind === undefined, `${label}: ${e.kind} carries no contact kind`);
  // 3. constraint intervals vs the independent checker
  const m = motionFromSamples(r.agents, r.events, body, H), ck = checkContacts(m), cc = checkConstraints(m, r.constraint_active, ck);
  ok(ck.violations === 0, `${label}: geometric episodes clean (${ck.problems.slice(0, 2)})`);
  ok(cc.violations === 0, `${label}: constraint_active intervals clean (${cc.problems.slice(0, 2)})`);
  ok(cc.inside_episode + cc.below_resolution === cc.intervals, `${label}: constraint_active ⊆ geometric_contact (${cc.inside_episode} inside, ${cc.below_resolution} below the resolution of ${cc.intervals})`);
  for (const c of r.constraint_active) {
    ok(c.contact_kind === 'constraint_active' && c.agents[0] < c.agents[1] && (c.end_t_s === null ? c.end_trigger === null : c.end_t_s >= c.start_t_s && c.end_trigger !== null) && (c.binding_t_s === null ? c.binding_solves === 0 : c.binding_solves > 0 && c.binding_t_s >= c.start_t_s && (c.end_t_s === null || c.binding_t_s <= c.end_t_s)), `${label}: interval ${c.agents} [${c.start_t_s}, ${c.end_t_s}] well formed`);
    if (c.end_bracket_s) ok(c.end_trigger === 'release_event' && c.end_bracket_s[1] === c.end_t_s && c.end_bracket_s[0] <= c.end_t_s! && c.end_t_s! - c.end_bracket_s[0] <= 1e-12 * Math.max(1, c.end_t_s!), `${label}: release bracket holds the end`);
  }
  ok(r.stats.constraint_intervals === r.constraint_active.length && r.stats.constraint_intervals_binding === r.constraint_active.filter((c) => c.binding_t_s !== null).length, `${label}: stats count the intervals`);
  ok(r.stats.contacts === r.constraint_active.length && r.stats.releases === r.constraint_active.filter((c) => c.end_t_s !== null).length, `${label}: one interval per constraint activation, one end per release`);
  for (let k = 1; k < r.constraint_active.length; k++) ok(r.constraint_active[k].start_t_s >= r.constraint_active[k - 1].start_t_s, `${label}: intervals ordered by start`);
  return { m, ck, cc };
}

const evidence: Record<string, unknown> = {};
const base = new Map<string, { inp: Solver2DInput; r: Solver2DResult }>();
// ---- 1. bit-identical to 83397c5, and the checks of 2, 3, 5 on every scenario
for (const id of Object.keys(REF)) {
  const sc = scen(id), inp = ph3bInput(sc), r = solve2D(inp);
  base.set(id, { inp, r });
  ok(sha(r.agents) === REF[id][0], `${id}: motion records bit-identical to 83397c5`);
  ok(sha(oldEvents(r)) === REF[id][1], `${id}: pre-existing event fields bit-identical to 83397c5`);
  ok(sha(oldStats(r)) === REF[id][2], `${id}: pre-existing solver stats bit-identical to 83397c5`);
  const { ck, cc } = kinds(id, r, sc.horizon_s, { length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value });
  evidence[id] = { geometric_episodes: ck.episodes, constraint_intervals: cc.intervals, binding: r.stats.constraint_intervals_binding, open_constraints: cc.open_at_horizon, below_resolution: cc.below_resolution };
}

// ---- 4. not derivable from each other
{
  const g = base.get('pass-graze')!.r;
  ok(g.events.filter((e) => e.kind === 'contact_start').length === 1 && g.constraint_active.length === 0, 'pass-graze: a geometric contact (gap within θ) with NO active constraint — geometric ⇏ constraint');
  const f = base.get('crossing-flank')!.r;
  ok(f.events.filter((e) => e.kind === 'contact_start').length === 1 && f.constraint_active.length > 1000, `crossing-flank: one geometric episode holds ${f.constraint_active.length} constraint intervals (sliding re-solves) — constraint intervals are not contact episodes`);
  const all = [...base.values()].flatMap(({ r }) => r.constraint_active);
  evidence.never_binding = all.filter((c) => c.binding_t_s === null).length;
  ok(all.some((c) => c.start_trigger === 'contact_event') && all.some((c) => c.end_trigger === 'release_event'), 'constraint intervals start at contact events and end at release events');
}
// a constraint that does not bind: a follower at the leader's speed touching it only because both move at the same free
// speed (dg/dt = 0 without any velocity limited)
{
  const BODY = { length_mm: 2.5, width_mm: 0.8 };
  const inp: Solver2DInput = { lanes: [{ id: 'P', centerline_mm: [{ x: 0, y: 0 }, { x: 100, y: 0 }], width_mm: 2, layer: 'z' }], obstacles: [], horizon_s: 2, agents: [
    { id: 'A', lane: 'P', s_mm: 10, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: 90, free_speed_mm_s: 10, body: BODY },
    { id: 'B', lane: 'P', s_mm: 20, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: 95, free_speed_mm_s: 5, body: BODY }] };
  const r = solve2D(inp), c = r.constraint_active;
  kinds('follow', r, 2, BODY);
  ok(c.length >= 1 && c[0].binding_t_s !== null, `follow: A catches the slower B; the constraint binds (A follows at 5 mm/s) at ${c[0]?.binding_t_s} s`);
  const inp2: Solver2DInput = { ...inp, agents: [{ ...inp.agents[0], s_mm: 10 + BODY.length_mm, free_speed_mm_s: 5 }, { ...inp.agents[1], s_mm: 10, free_speed_mm_s: 5 }] };
  const r2 = solve2D(inp2);
  kinds('touching-equal-speed', r2, 2, BODY);
  ok(r2.constraint_active.length === 1 && r2.constraint_active[0].binding_t_s === null && r2.constraint_active[0].start_trigger === 'membership_check', `touching at equal speed: the constraint is active from t = 0 but never binds (${JSON.stringify(r2.constraint_active[0])})`);
  evidence.follow = { binding_t_s: c[0]?.binding_t_s, intervals: c.length };
}

// ---- 6. determinism of the intervals
for (const id of ['corridor-8', 'crossing-traffic-100', 'crossing-flank']) {
  const { inp, r } = base.get(id)!, h0 = sha(r.constraint_active);
  ok(sha(solve2D({ ...inp, agents: [...inp.agents].reverse() }).constraint_active) === h0, `${id}: reversed input order → identical constraint intervals`);
  for (const bp of ['sap', 'brute'] as const) if (inp.agents.length <= 100) ok(sha(solve2D({ ...inp, broadphase: bp }).constraint_active) === h0, `${id}: broad-phase ${bp} → identical constraint intervals`);
  ok(sha(solve2D({ ...inp, window_s: 0.05 }).constraint_active) === h0, `${id}: broad-phase window 0.05 s → identical constraint intervals`);
}
// seeded random crossings / passes / followers (the generator of tests/ph3b-contact-time.test.ts §2b, own seed)
{
  const g = rng(146);
  const BODY = { length_mm: 2.5, width_mm: 0.8 };
  let runs = 0, ivs = 0, geo = 0;
  for (let k = 0; k < 40; k++) {
    const n = 2 + Math.floor(g() * 5), agents: Solver2DInput['agents'] = [];
    const lanes = [{ id: 'EW', centerline_mm: [{ x: 0, y: 50 }, { x: 100, y: 50 }], width_mm: 3, layer: 'z' }, { id: 'NS', centerline_mm: [{ x: 50, y: 0 }, { x: 50, y: 100 }], width_mm: 3, layer: 'z' }];
    for (let i = 0; i < n; i++) {
      const lane = g() < 0.5 ? 'EW' : 'NS', dir: 1 | -1 = g() < 0.5 ? 1 : -1, s = dir > 0 ? 30 + g() * 15 : 55 + g() * 15;
      const u = Math.round((g() * 2 - 1) * 1.1 * 100) / 100;
      agents.push({ id: `R${i}`, lane, s_mm: s, u_mm: u, dir, start_t_s: Math.round(g() * 40) / 100, goal_s_mm: dir > 0 ? 80 : 20, free_speed_mm_s: 8 + g() * 12, body: BODY });
    }
    let r: Solver2DResult;
    try { r = solve2D({ lanes, obstacles: [], horizon_s: 4, agents }); } catch { continue; }   // overlapping random starts are refused
    runs++;
    const x = kinds(`random #${k}`, r, 4, BODY); ivs += x.cc.intervals; geo += x.ck.episodes;
  }
  ok(runs >= 20 && ivs > 10 && geo > 10, `random cases are not vacuous (${runs} runs, ${geo} geometric episodes, ${ivs} constraint intervals)`);
  evidence.random = { seed: 146, runs, geometric_episodes: geo, constraint_intervals: ivs };
}

// ---- 7. positive controls for the constraint checker
{
  const { r } = base.get('corridor-8')!, sc = scen('corridor-8'), body = { length_mm: sc.body.length_mm.value, width_mm: sc.body.width_mm.value };
  const m = motionFromSamples(r.agents, r.events, body, sc.horizon_s), ck = checkContacts(m);
  const iv = r.constraint_active[0] as CkConstraint;
  const shifted = checkConstraints(m, [{ ...iv, start_t_s: iv.start_t_s - 0.05 }], ck);
  ok(shifted.violations > 0, `control: a constraint interval shifted 0.05 s before the touch is caught (${shifted.problems[0]})`);
  const pairs = new Set(r.constraint_active.map((c) => c.agents.join('|')));
  const ids = Object.keys(r.agents).sort(); let fake: [string, string] | null = null;
  for (let i = 0; i < ids.length && !fake; i++) for (let j = i + 1; j < ids.length && !fake; j++) if (!pairs.has(`${ids[i]}|${ids[j]}`)) fake = [ids[i], ids[j]];
  const invented = checkConstraints(m, [{ agents: fake!, start_t_s: 1, end_t_s: 2 }], ck);
  ok(invented.violations > 0, `control: an invented constraint between ${fake} is caught (${invented.problems[0]})`);
  const f = base.get('crossing-flank')!, fsc = scen('crossing-flank'), fm = motionFromSamples(f.r.agents, f.r.events, body, fsc.horizon_s), fck = checkContacts(fm);
  const last = f.r.constraint_active[f.r.constraint_active.length - 1];
  const longer = checkConstraints(fm, [{ ...last, end_t_s: last.end_t_s! + 0.1, end_bracket_s: null }], fck);
  ok(longer.violations > 0, `control: a constraint kept 0.1 s past its release is caught (${longer.problems[0]})`);
}

// ---- 5b. the schema: antenna contact is a declared, unsupported kind
ok(!CONTACT_KINDS_EMITTED.includes('antenna_contact') && CONTACT_KINDS_EMITTED.includes('geometric_contact') && CONTACT_KINDS_EMITTED.includes('constraint_active'), 'PH-3b emits geometric_contact and constraint_active, never antenna_contact');
{
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const src = strip(fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/solver2d.ts'), 'utf8'));
  ok(!/'antenna_contact'/.test(src.replace(/export type ContactKind[^;]*;/, '')), 'the solver code never produces an antenna_contact value (only the type declares it)');
  ok(!/trophallax|recruit|attack|aggress/i.test(src), 'the solver code has no behaviour (trophallaxis / recruitment / attack) attached to any contact');
}
// playback files: the three kinds are labelled, antenna unsupported
for (const f of fs.readdirSync(path.join(REPO_ROOT, 'prototypes/physics-playback/data')).filter((n) => n.endsWith('--ph3b.json'))) {
  const d = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/physics-playback/data', f), 'utf8'));
  ok(d.contact_kinds && d.contact_kinds.antenna_contact.supported === false && d.contact_kinds.antenna_contact.value === null && Array.isArray(d.contact_kinds.constraint_active.rows), `${f}: contact kinds exported, antenna contact unsupported`);
  ok(d.events.every((e: { kind: string; contact_kind?: string }) => !e.kind.startsWith('contact_') || e.contact_kind === 'geometric_contact'), `${f}: every contact event is labelled geometric_contact`);
}

console.log(JSON.stringify(evidence));
console.log(`ph3b-contact-kinds: ${checks} checks passed`);
