/**
 * ANTENNA-GEO (Issue #172; engine/physics/antenna-geometry.ts; docs/antenna-geometry.md). Blocking.
 *  - parameters: species mode refuses nulls / assumptions; candidate mode is explicit and labelled; sourced morphology
 *    constraints are enforced; biological-geometry, scanning-model and display parameters are separate;
 *  - frames: round trips, composition, rotation with the body heading, left/right mirror symmetry;
 *  - reach envelope (closed form) and the scanning model's range and speed bound;
 *  - antenna_contact vs analytic cases and an independent checker that imports nothing from engine/;
 *  - decision 36: antenna_contact / geometric_contact / constraint_active are distinct; body contact is never antenna contact;
 *  - no future reads (prefix property, plan changes after H), determinism and input-order independence;
 *  - local-sensing adapter: requests accepted by sampleLocal, sensors equal to the exact tips up to rounding;
 *  - the sensitivity tables in the document are reproduced verbatim.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import * as AG from '../engine/physics/antenna-geometry.ts';
import { resolveModel, AntennaRefused, toParent, fromParent, compose, headInWorld, antennaInWorld, antennaInHead, scanJoints, reachEnvelope, jointsInRange, scanPointSpeedBound, detectAntennaContacts, contactKindOf, sensingRequests, antennaSamplePoints, MORPH_KEYS, SCAN_KEYS, type AntennaModel, type AntennaContactInput, type AntennaContactResult } from '../engine/physics/antenna-geometry.ts';
import { PlanBuilder, CONTACT_TOL_MM, CA_LEVEL_MM, SEP_RES_MM, type Track, type Static } from '../engine/physics/kinematics2d.ts';
import { sampleLocal, antennaSensors, SyntheticChemicalField } from '../engine/physics/local-sensing.ts';
import { rng } from '../engine/rng.ts';
import { candidateInput, speciesInput, candidateModel, candidateBody, scenarios, executed, loadAntennaCandidates } from '../prototypes/antenna-geometry/lib.ts';
import { sensitivityTables } from '../prototypes/antenna-geometry/sensitivity.ts';
import { checkRecord, X_CONTACT_TOL_MM, X_CA_LEVEL_MM, X_SEP_RES_MM, type XRecord } from '../prototypes/antenna-geometry-check/check.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; if (process.env.VERBOSE) console.log(`ok  ${why}`); };
const refuses = (f: () => unknown, code: string, why: string) => { try { f(); } catch (e) { ok(e instanceof AntennaRefused && e.codes.some((c) => c.startsWith(code)), `${why} (${(e as Error).message.slice(0, 300)})`); return; } ok(false, `${why}: no refusal`); };
const json = (x: unknown) => JSON.stringify(x);
const body = candidateBody();

// ---------------------------------------------------------------- parameters (decision 37)
{
  refuses(() => resolveModel(speciesInput()), 'NULL_PARAMETER', 'species mode refuses to run with null species values');
  try { resolveModel(speciesInput()); } catch (e) { ok((e as AntennaRefused).codes.filter((c) => c.startsWith('NULL_PARAMETER')).length === MORPH_KEYS.length + SCAN_KEYS.length, 'every unknown species value is reported (none defaulted)'); }
  const spAssume = { ...candidateInput(), mode: 'species' as const };
  refuses(() => resolveModel(spAssume), 'ASSUMPTION_IN_SPECIES_MODE', 'candidate values cannot be run as species values');
  refuses(() => resolveModel({ ...candidateInput(), mode: undefined as unknown as 'candidate' }), 'MISSING:mode', 'the mode must be explicit');
  const unl = candidateInput(); unl.params.funiculus_length_mm.assumption = false;
  refuses(() => resolveModel(unl), 'CANDIDATE_NOT_LABELLED:funiculus_length_mm', 'a candidate value must be labelled assumption:true');
  const nob = candidateInput(); nob.scan.scan_frequency_hz.basis = null;
  refuses(() => resolveModel(nob), 'MISSING_BASIS:scan_frequency_hz', 'a candidate value must name its basis');
  const nul = candidateInput(); nul.params.funiculus_length_mm.value = null;
  refuses(() => resolveModel(nul), 'NULL_PARAMETER:funiculus_length_mm', 'candidate mode also refuses null (no default)');
  refuses(() => resolveModel(candidateInput({ scape_length_mm: 0.9 })), 'MORPHOLOGY_CONFLICT:SL_range', 'a scape length outside the published range is refused');
  refuses(() => resolveModel(candidateInput({ torulus_halfspan_mm: 0.3 })), 'MORPHOLOGY_CONFLICT:torulus_within_head', 'antenna bases outside the head width are refused');
  refuses(() => resolveModel(candidateInput({ scan_scape_amplitude_rad: 0.9 })), 'SCAN_OUTSIDE_RANGE:scape', 'a scan outside the range of motion is refused');
  const m = candidateModel();
  ok(m.mode === 'candidate' && m.constraint_report.length === 3 && m.constraint_report.every((c) => c.ok), 'candidate model passes the sourced morphology constraints');
  ok(m.tags.length === MORPH_KEYS.length + SCAN_KEYS.length && m.tags.every((t) => t.assumption === true), 'every candidate value carries assumption:true');
  const c = loadAntennaCandidates();
  ok(Object.values(c.species_params).every((p: any) => p.value === null), 'species_params: every value is null (no antenna measurement found beyond scape-length ranges)');
  ok(c.candidate_minor.params.scape_length_mm.basis === '文獻支持' && Object.entries(c.candidate_minor.params).filter(([k]) => k !== 'scape_length_mm').every(([, p]: any) => p.basis === '遊戲假設'), 'only the scape length is literature-constrained; every other candidate is a game assumption');
  ok(c.candidate_minor.params.funiculus_length_mm.source === null && !/Camponotus|Atta|Lasius|Formica/.test(json(c.candidate_minor)), 'no other species\' value is used as a candidate');
  // separation: biological geometry, kinematic scan model and display animation are disjoint parameter sets
  ok(MORPH_KEYS.every((k) => !(SCAN_KEYS as readonly string[]).includes(k)) && Object.keys(c.candidate_minor.params).sort().join() === [...MORPH_KEYS].sort().join() && Object.keys(c.candidate_minor.scan).sort().join() === [...SCAN_KEYS].sort().join(), 'morphology and scanning-model parameters are separate sets');
  ok(![...MORPH_KEYS, ...SCAN_KEYS].some((k) => /display|anim|render|sprite|frame_rate/.test(k)), 'no display-animation parameter in the antenna model');
  const src = fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/antenna-geometry.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok(!/from\s+['"][^'"]*(web|display-motion|natural-walk|day|nutrition|queen|brood|foraging)/.test(src), 'antenna module imports no display, decision or colony module');
  ok(!/decide|recogni[sz]e\(|nestmate|task/.test(src), 'antenna module contains no recognition or decision logic');
}

// ---------------------------------------------------------------- frames
const m = candidateModel();
{
  const g = rng(1729);
  let maxRt = 0, maxRot = 0, maxMirror = 0, maxComp = 0;
  for (let i = 0; i < 500; i++) {
    const f = { x: (g() - 0.5) * 100, y: (g() - 0.5) * 100, th: (g() - 0.5) * 20 }, p = { x: (g() - 0.5) * 10, y: (g() - 0.5) * 10 };
    const q = fromParent(f, toParent(f, p)); maxRt = Math.max(maxRt, Math.hypot(q.x - p.x, q.y - p.y));
    const f2 = { x: g() * 3, y: g() * 3, th: g() * 6 }, c = compose(f, f2), a1 = toParent(c, p), a2 = toParent(f, toParent(f2, p)); maxComp = Math.max(maxComp, Math.hypot(a1.x - a2.x, a1.y - a2.y));
    // rotation with the body heading: tip relative to the body centre rotates by Δθ
    const j = { scape_rad: m.aMin + g() * (m.aMax - m.aMin), elbow_rad: m.bMin + g() * (m.bMax - m.bMin) };
    const pose0 = { x: f.x, y: f.y, th: 0 }, pose1 = { x: f.x, y: f.y, th: f.th };
    for (const side of AG.SIDES) {
      const t0 = antennaInWorld(pose0, m, side, j).tip, t1 = antennaInWorld(pose1, m, side, j).tip;
      const r0 = { x: t0.x - f.x, y: t0.y - f.y }, rr = { x: Math.cos(f.th) * r0.x - Math.sin(f.th) * r0.y, y: Math.sin(f.th) * r0.x + Math.cos(f.th) * r0.y };
      maxRot = Math.max(maxRot, Math.hypot(t1.x - f.x - rr.x, t1.y - f.y - rr.y));
    }
    const L = antennaInHead(m, 'left', j), R = antennaInHead(m, 'right', j);
    maxMirror = Math.max(maxMirror, Math.abs(L.tip.x - R.tip.x) + Math.abs(L.tip.y + R.tip.y) + Math.abs(L.elbow.y + R.elbow.y) + Math.abs(L.base.y + R.base.y));
  }
  ok(maxRt < 1e-12, `frame round trip exact to rounding (max ${maxRt})`);
  ok(maxComp < 1e-12, `frame composition equals nested transforms (max ${maxComp})`);
  ok(maxRot < 1e-12, `antenna geometry rotates rigidly with the body heading (max ${maxRot})`);
  ok(maxMirror < 1e-15, 'left and right antennae are mirror images about the body axis');
  const h = headInWorld({ x: 1, y: 2, th: Math.PI / 2 }, m);
  ok(Math.abs(h.x - 1) < 1e-15 && Math.abs(h.y - (2 + m.hx)) < 1e-15 && h.th === Math.PI / 2 + m.hyaw, 'head frame sits on the body axis at head_origin_x');
}

// ---------------------------------------------------------------- reach envelope and scanning model
{
  const env = reachEnvelope(m), g = rng(99);
  ok(Math.abs(env.tip_r_max_mm - (m.Ls + m.Lf)) < 1e-15 && env.beta_at_max === 0, 'max reach = Ls + Lf when the elbow range contains a straight antenna');
  ok(Math.abs(env.tip_r_min_mm - Math.sqrt(m.Ls ** 2 + m.Lf ** 2 + 2 * m.Ls * m.Lf * Math.cos(m.bMin))) < 1e-15, 'min reach at the most bent elbow (closed form)');
  let lo = Infinity, hi = 0, outside = 0;
  for (let i = 0; i < 20000; i++) {
    const j = { scape_rad: m.aMin + g() * (m.aMax - m.aMin), elbow_rad: m.bMin + g() * (m.bMax - m.bMin) }, p = antennaInHead(m, 'left', j);
    const r = Math.hypot(p.tip.x - p.base.x, p.tip.y - p.base.y); lo = Math.min(lo, r); hi = Math.max(hi, r);
    if (r < env.tip_r_min_mm - 1e-12 || r > env.tip_r_max_mm + 1e-12 || Math.hypot(p.elbow.x - p.base.x, p.elbow.y - p.base.y) > env.any_point_r_max_mm + 1e-12) outside++;
  }
  ok(outside === 0 && hi > env.tip_r_max_mm - 1e-3 && lo < env.tip_r_min_mm + 1e-2, `random joints stay inside the envelope [${env.tip_r_min_mm.toFixed(4)}, ${env.tip_r_max_mm.toFixed(4)}] and fill it (${lo.toFixed(4)}–${hi.toFixed(4)})`);
  const bent = resolveModel(candidateInput({ elbow_angle_min_rad: -2.5, elbow_angle_max_rad: -0.5, scan_elbow_centre_rad: -1.5, scan_elbow_amplitude_rad: 0.2 })), eb = reachEnvelope(bent);
  ok(eb.beta_at_max === -0.5 && eb.beta_at_min === -2.5, 'elbow range without a straight position: max reach at the least-bent end');
  // scan stays in range; speed bound holds (finite differences in the head frame)
  const V = scanPointSpeedBound(m); let vmax = 0, inRange = true;
  for (let i = 0; i < 4000; i++) {
    const t = i * 0.00025;
    for (const side of AG.SIDES) {
      const j0 = scanJoints(m, side, t), j1 = scanJoints(m, side, t + 1e-6); inRange &&= jointsInRange(m, j0);
      const a = antennaInHead(m, side, j0), b = antennaInHead(m, side, j1);
      vmax = Math.max(vmax, Math.hypot(b.tip.x - a.tip.x, b.tip.y - a.tip.y) / 1e-6, Math.hypot(b.elbow.x - a.elbow.x, b.elbow.y - a.elbow.y) / 1e-6);
    }
  }
  ok(inRange, 'scanning joints stay inside the range of motion');
  ok(vmax <= V * (1 + 1e-6) && vmax > 0.3 * V, `antenna point speed relative to the head ≤ bound (${vmax.toFixed(3)} ≤ ${V.toFixed(3)} mm/s)`);
  const pts = antennaSamplePoints({ x: 0, y: 0, th: 0 }, m, 'left', { scape_rad: 0.9, elbow_rad: -0.8 }, 5), tip = antennaInWorld({ x: 0, y: 0, th: 0 }, m, 'left', { scape_rad: 0.9, elbow_rad: -0.8 }).tip;
  ok(pts.length === 5 && json(pts[4]) === json(tip), 'sample points end at the tip');
  refuses(() => antennaSamplePoints({ x: 0, y: 0, th: 0 }, m, 'left', { scape_rad: 0.9, elbow_rad: 0 }, 0), 'BAD:sample count', 'zero sample points refused');
}

// ---------------------------------------------------------------- analytic contact cases
const θ = CONTACT_TOL_MM;
const run = (agents: { id: string; track: Track; model: AntennaModel }[], statics: Static[], H: number, targets = { statics: true, bodies: true, antennae: true }): AntennaContactResult => detectAntennaContacts({ agents, statics, t0_s: 0, horizon_s: H, targets });
{
  // (a) stationary ant, straight antenna (β = 0, r = 0), scape sweeping α(t) = αc + A sin(2πft); point obstacle at polar angle φ from the left base
  const ma = resolveModel(candidateInput({ scan_elbow_centre_rad: 0, scan_elbow_amplitude_rad: 0, antenna_radius_mm: 0 }));
  const phi = 1.05, dist = 1.2, s = ma.scan, tStar = Math.asin((phi - s.ac) / s.aa) / (2 * Math.PI * s.f);
  const obs: Static = { id: 'pin', kind: 'disc', c: { x: ma.hx + dist * Math.cos(phi), y: ma.half + dist * Math.sin(phi) }, r: 0 };
  const r = run([{ id: 'a', track: new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).stop(1).build(), model: ma }], [obs], 0.2, { statics: true, bodies: false, antennae: false });
  const st = r.events.find((e) => e.phase === 'start' && e.side === 'left');
  const rate = 2 * Math.PI * s.f * s.aa * Math.cos(2 * Math.PI * s.f * tStar);
  ok(st && st.t_s <= tStar && tStar - st.t_s <= (2 * θ) / (dist * rate) + 1e-12, `(a) scanning straight antenna touches a pin at t* = asin((φ−αc)/A)/(2πf) = ${tStar.toFixed(9)} (got ${st?.t_s.toFixed(12)})`);
  ok(st?.part === 'funiculus' && st.recognition === null && st.kind === 'antenna_contact', '(a) contact is on the funiculus, kind antenna_contact, recognition null');
  ok(!r.events.some((e) => e.side === 'right'), '(a) the right antenna (mirror side) never touches the pin');
  // (b) translation toward a wall with fixed antennae: t* = (X − r − tip_x0)/v
  const mb = resolveModel(candidateInput({ scan_scape_amplitude_rad: 0, scan_elbow_amplitude_rad: 0 }));
  const tipx0 = mb.hx + mb.Ls * Math.cos(mb.scan.ac) + mb.Lf * Math.cos(mb.scan.ac + mb.scan.bc), X = 5, v = 3, tb = (X - mb.r - tipx0) / v;
  const rb = run([{ id: 'a', track: new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(6, v).build(), model: mb }], [{ id: 'w', kind: 'segment', a: { x: X, y: -5 }, b: { x: X, y: 5 } }], 2);
  const sb = rb.events.filter((e) => e.phase === 'start');
  ok(sb.length === 2 && sb.every((e) => e.t_s <= tb && tb - e.t_s <= θ / v + 1e-12) && sb[0].t_s === sb[1].t_s, `(b) both tips touch the wall at t* = (X − r − x_tip)/v = ${tb.toFixed(9)} (got ${sb.map((e) => e.t_s.toFixed(12)).join(', ')})`);
  // (c) pivot in place with fixed antennae: obstacle on the tip's circle, Δ ahead → t* = Δ/ω
  const tipL = antennaInWorld({ x: 0, y: 0, th: 0 }, mb, 'left', { scape_rad: mb.scan.ac, elbow_rad: mb.scan.bc }).tip;
  const R = Math.hypot(tipL.x, tipL.y), psi = Math.atan2(tipL.y, tipL.x), D = 0.4, w = 2;
  const rc = run([{ id: 'a', track: new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).pivot(1, w).build(), model: { ...mb, r: 0 } }], [{ id: 'pin', kind: 'disc', c: { x: R * Math.cos(psi + D), y: R * Math.sin(psi + D) }, r: 0 }], 1);
  const sc = rc.events.find((e) => e.phase === 'start' && e.side === 'left');
  ok(sc && sc.t_s <= D / w && D / w - sc.t_s <= (2 * θ) / (R * w) + 1e-12, `(c) pivoting ant: left tip reaches a pin on its circle at t* = Δ/ω = ${(D / w).toFixed(9)} (got ${sc?.t_s.toFixed(12)})`);
  // (d) antenna passes through a thin wall: start then end; end time when the whole antenna is past (analytic for straight antenna)
  const re = run([{ id: 'a', track: new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(6, v).build(), model: { ...mb, r: 0 } }], [{ id: 'w', kind: 'segment', a: { x: X, y: 0.2 }, b: { x: X, y: 0.6 } }], 2, { statics: true, bodies: false, antennae: false });
  ok(re.events.filter((e) => e.side === 'left').map((e) => e.phase).join() === 'start,end' && re.min_gap_at_iterates_mm < 0, '(d) a kinematic antenna passes through a short wall: start then end (no deflection modelled; negative gap reported)');
}

// ---------------------------------------------------------------- independent checker
const toRecord = (inp: AntennaContactInput, res: AntennaContactResult): XRecord => ({
  t0_s: inp.t0_s, horizon_s: inp.horizon_s, targets: inp.targets, statics: JSON.parse(json(inp.statics)),
  agents: Object.fromEntries(inp.agents.map((a) => [a.id, { body: a.track.body as { length_mm: number; width_mm: number }, layer: a.track.layer ?? '', segs: a.track.segs.map((s) => ({ t0: s.t0, t1: s.t1, p0: s.p0, tw: s.tw })), antenna: { hx: a.model.hx, hyaw: a.model.hyaw, half: a.model.half, Ls: a.model.Ls, Lf: a.model.Lf, r: a.model.r, scan: a.model.scan } }])),
  events: res.events.map((e) => ({ t_s: e.t_s, phase: e.phase, agent_id: e.agent_id, side: e.side, target: { kind: e.target.kind, id: e.target.id, side: e.target.side }, bracket_s: e.bracket_s })),
});
{
  ok(X_CONTACT_TOL_MM === CONTACT_TOL_MM && X_CA_LEVEL_MM === CA_LEVEL_MM && X_SEP_RES_MM === SEP_RES_MM, 'checker contract numbers equal the module\'s');
  const chk = fs.readFileSync(path.join(REPO_ROOT, 'prototypes/antenna-geometry-check/check.ts'), 'utf8');
  ok(!/from\s+['"][^'"]*engine\//.test(chk) && !/import\(/.test(chk), 'the independent checker imports nothing from engine/');
  const cases: { name: string; inp: AntennaContactInput }[] = scenarios(m).map((s) => ({ name: s.name, inp: s.input }));
  // random scenarios: walks with arcs, pivots and sidesteps among discs, walls and a polygon, 3 ants, scanning antennae
  for (let seed = 1; seed <= 6; seed++) {
    const g = rng(seed * 7919), tracks: Track[] = [];
    for (let k = 0; k < 3; k++) {
      const b = new PlanBuilder(`r${k}`, body, { x: k * 4.5, y: (g() - 0.5) * 3, th: (g() - 0.5) * 2 });
      for (let q = 0; q < 4; q++) { const u = g(); if (u < 0.35) b.straight(0.5 + g() * 2, 2 + g() * 8); else if (u < 0.6) b.arc(0.5 + g() * 2, (g() - 0.5) * 1.5, 2 + g() * 6); else if (u < 0.8) b.pivot((g() - 0.5) * 3, 1 + g() * 3); else b.sidestep((g() - 0.5) * 1, 1 + g()); }
      tracks.push(b.build());
    }
    const statics: Static[] = [{ id: 's_disc', kind: 'disc', c: { x: 3 + g() * 4, y: 2 + g() }, r: 0.3 + g() * 0.4 }, { id: 's_wall', kind: 'segment', a: { x: -3, y: -3.5 }, b: { x: 14, y: -3.2 } }, { id: 's_poly', kind: 'polygon', pts: [{ x: 6, y: 3.5 }, { x: 8, y: 3.5 }, { x: 7, y: 5 }] }];
    const mod = resolveModel(candidateInput({ scan_frequency_hz: 1 + g() * 3, scan_phase_right_rad: g() * 6 }));
    let ex: ReturnType<typeof executed>;
    try { ex = executed(tracks, statics, 2); } catch { continue; } // kinematics2d refuses overlapping starts: skip that seed
    cases.push({ name: `random_${seed}`, inp: { agents: ex.tracks.map((t) => ({ id: t.id, track: t, model: mod })), statics, t0_s: 0, horizon_s: 2, targets: { statics: true, bodies: true, antennae: true } } });
  }
  let evs = 0, nr = 0;
  for (const c of cases) {
    const res = detectAntennaContacts(c.inp), rep = checkRecord(toRecord(c.inp, res));
    evs += res.events.length; nr++;
    ok(res.status.length === 0, `${c.name}: no solver_status (iteration limit not reached)`);
    ok(rep.event_violations.length === 0, `${c.name}: event checks pass (${rep.event_violations.slice(0, 3).join('; ')})`);
    ok(rep.missed.length === 0, `${c.name}: no missed contact or separation (${rep.missed.slice(0, 3).join('; ')})`);
    ok(rep.uncertified.length === 0, `${c.name}: every interval certified (${rep.uncertified.length} uncertified)`);
  }
  console.log(`checker: ${nr} scenarios, ${evs} events`); ok(nr >= 8 && evs >= 20, `independent checker covered ${nr} scenarios and ${evs} antenna_contact events`);
}

// ---------------------------------------------------------------- decision 36: three contact kinds
{
  const sc = scenarios(m).find((s) => s.name === 'head_on')!;
  const ae = detectAntennaContacts(sc.input).events;
  const kinds = new Set(sc.kin.events.map(contactKindOf));
  ok(kinds.has('geometric_contact') && kinds.has('constraint_active') && !kinds.has('antenna_contact'), 'kinematics2d events map to geometric_contact / constraint_active only, never antenna_contact');
  ok(ae.every((e) => contactKindOf(e) === 'antenna_contact' && e.recognition === null), 'antenna events are antenna_contact with recognition null');
  const firstGeo = sc.kin.events.find((e) => contactKindOf(e) === 'geometric_contact')!.t_s;
  ok(ae.length > 0 && ae[0].t_s < firstGeo, `head-on: antennae touch (${ae[0].t_s.toFixed(4)} s) before the bodies collide (${firstGeo.toFixed(4)} s)`);
  // a body collision with no antenna involvement: ant a backs into the side of ant b
  const a = new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).twist({ v: -2, vl: 0, w: 0 }, 1).build();
  const b = new PlanBuilder('b', body, { x: -2.2, y: 0, th: -Math.PI / 2 }).stop(2).build();
  const ex = executed([a, b], [], 1.5);
  const ar = detectAntennaContacts({ agents: ex.tracks.map((t) => ({ id: t.id, track: t, model: m })), statics: [], t0_s: 0, horizon_s: 1.5, targets: { statics: true, bodies: true, antennae: true } });
  ok(ex.kin.events.some((e) => contactKindOf(e) === 'geometric_contact') && ar.events.length === 0, 'a body collision (geometric_contact) produces no antenna_contact: body contact never stands in for antenna contact');
}

// ---------------------------------------------------------------- no future reads, determinism, order independence
{
  const mk = (tail: boolean) => { const b = new PlanBuilder('a', body, { x: 0, y: 0, th: 0 }).straight(2, 4).arc(1, 0.8, 4); if (tail) b.pivot(2, 3).straight(3, 9); else b.sidestep(-1, 2); return b.build(); };
  const stat: Static[] = [{ id: 'w', kind: 'segment', a: { x: 3.6, y: -5 }, b: { x: 3.6, y: 0.4 } }, { id: 'p', kind: 'disc', c: { x: 3.2, y: 1.6 }, r: 0.3 }];
  const H = mk(true).segs[2].t0 - 0.01;
  const r1 = run([{ id: 'a', track: mk(true), model: m }], stat, H), r2 = run([{ id: 'a', track: mk(false), model: m }], stat, H);
  ok(r1.max_time_read_s <= H && r1.events.length > 0, `no track is read after the horizon (max read ${r1.max_time_read_s} ≤ H ${H})`);
  ok(json(r1.events) === json(r2.events), 'changing the plan after H does not change any result up to H');
  const H2 = H + 1, rl = run([{ id: 'a', track: mk(true), model: m }], stat, H2);
  // per pair, the events found up to H₁ are the first events found up to H₂ (an event bisected back before H₁ but detected
  // at a solver iterate after H₁ may be added by the longer run: detection needs the later iterate)
  const pk = (e: AG.AntennaContactEvent) => `${e.agent_id}:${e.side}|${e.target.kind}:${e.target.id}:${e.target.side ?? ''}`;
  const keys = [...new Set(r1.events.map(pk))];
  ok(keys.length > 0 && keys.every((k) => { const a = r1.events.filter((e) => pk(e) === k), b = rl.events.filter((e) => pk(e) === k); return json(a) === json(b.slice(0, a.length)); }) && rl.events.length > r1.events.length, 'results to H₁ are a per-pair prefix of results to H₂ > H₁');
  for (const s of scenarios(m)) {
    const base = json(detectAntennaContacts(s.input));
    const rev: AntennaContactInput = { ...s.input, agents: [...s.input.agents].reverse(), statics: [...s.input.statics].reverse() };
    ok(base === json(detectAntennaContacts(rev)) && base === json(detectAntennaContacts(s.input)), `${s.name}: identical result on repeat and with reversed input arrays`);
  }
  refuses(() => detectAntennaContacts({ agents: [{ id: 'a', track: mk(true), model: null as unknown as AntennaModel }], statics: [], t0_s: 0, horizon_s: 1, targets: { statics: true, bodies: true, antennae: true } }), 'MISSING:model', 'an agent without a resolved antenna model is refused');
  refuses(() => detectAntennaContacts({ agents: [{ id: 'a', track: mk(true), model: m }], statics: [{ id: 'box', kind: 'polygon', pts: [{ x: -1, y: -3 }, { x: 5, y: -3 }, { x: 5, y: 3 }, { x: -1, y: 3 }] }], t0_s: 0, horizon_s: 1, targets: { statics: true, bodies: true, antennae: true } }), 'ANTENNA_INSIDE_POLYGON_AT_START', 'an antenna starting wholly inside a polygon is refused');
}

// ---------------------------------------------------------------- local-sensing adapter
{
  const field = new SyntheticChemicalField({ id: 'syn', channel: 'ch', layer: 'L', field: { synthetic: true, kind: 'gaussian_ridge', polyline: [{ x: -10, y: 0 }, { x: 20, y: 0 }], sigma_mm: 1, peak: 1 }, committed_through_s: 10, max_range_mm: 0 });
  const g = rng(4242); let maxDev = 0, n = 0;
  for (let i = 0; i < 200; i++) {
    const pose = { x: (g() - 0.5) * 20, y: (g() - 0.5) * 4, th: (g() - 0.5) * 7 }, t = g() * 10;
    const out = sensingRequests({ agent_id: 'a', t_s: t, round: 0, layer: 'L', channel: 'ch', range_mm: 0, source: 'synthetic', tags: [{ name: 'scenario', assumption: true, basis: '遊戲假設', note: '' }] }, pose, body.length_mm as number, m);
    for (const q of out.requests) {
      const res = sampleLocal(field, q); n++;
      ok(res.values.length === 1 && json(q.sensors) === json(antennaSensors(q.pose, q.geometry).filter((s) => s.id === q.sensors[0].id)), 'adapter request accepted by sampleLocal; its sensor is the contract\'s own recomputation');
    }
    const exact = { left: antennaInWorld(pose, m, 'left', scanJoints(m, 'left', t)).tip, right: antennaInWorld(pose, m, 'right', scanJoints(m, 'right', t)).tip };
    ok(json(out.exact) === json(exact), 'adapter uses the scan joints at the request time t_s (no other time)');
    maxDev = Math.max(maxDev, out.deviation_mm.left, out.deviation_mm.right);
  }
  ok(maxDev < 1e-12 && n === 400, `contract sensor points equal the exact antenna tips up to rounding (max ${maxDev} mm over ${n} requests)`);
  const q0 = sensingRequests({ agent_id: 'a', t_s: 0, round: 0, layer: 'L', channel: 'ch', range_mm: 0, source: 'synthetic', tags: [{ name: 's', assumption: true, basis: '遊戲假設', note: '' }] }, { x: 0, y: 0, th: 0 }, body.length_mm as number, m).requests[0];
  ok(q0.tags.some((t) => t.name === 'antenna.funiculus_length_mm' && t.assumption) && q0.tags.some((t) => t.name === 'antenna.sensing_adapter'), 'sensing requests carry the antenna assumption tags');
  const cross = resolveModel(candidateInput({ scan_scape_centre_rad: 0.4, scan_scape_amplitude_rad: 0.2, scan_elbow_centre_rad: -1.4, scan_elbow_amplitude_rad: 0.2 }));
  refuses(() => sensingRequests({ agent_id: 'a', t_s: 0, round: 0, layer: 'L', channel: 'ch', range_mm: 0, source: 'synthetic', tags: [{ name: 's', assumption: true, basis: '遊戲假設', note: '' }] }, { x: 0, y: 0, th: 0 }, body.length_mm as number, cross), 'TIP_NOT_REPRESENTABLE', 'a tip across the body axis cannot be expressed in the contract and is refused (not silently mirrored)');
}

// ---------------------------------------------------------------- document tables reproduced verbatim
{
  const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/antenna-geometry.md'), 'utf8'), tables = sensitivityTables();
  ok(doc.includes(tables), 'docs/antenna-geometry.md §6 contains the sensitivity tables verbatim (node prototypes/antenna-geometry/sensitivity.ts)');
}
console.log(JSON.stringify({ antenna_geometry: 'pass', checks }, null, 2));
