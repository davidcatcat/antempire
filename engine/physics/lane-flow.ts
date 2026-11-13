/**
 * LANE-FLOW (Issue #189 / #193 rulings 4, 5, 7, 11): an ISOLATED integration CANDIDATE that walks KIN-2D bodies
 * (real orientation, capsule collision shape, exact continuous contact: kinematics2d.ts / kinematics2d-contact.ts) on
 * one straight lane and hands every arrival to the #162 destination capacity ledger (destinations.ts). Not used by
 * simulate(), the daily loop, Day0, cli/ or web/ (tests/physics-isolation.test.ts). No solver is modified: this module
 * calls runKinematics / runKinematicsWithContactMode on successive epochs.
 *
 * Model (physical bookkeeping; every behavioural number is a scenario input, game assumption, never a species value):
 *  - lane: x ∈ [0, length_mm], walls at y = ±width_mm/2 (thin static segments). An agent of direction +1 enters at its
 *    own s = 0 end (x = 0, heading 0), −1 at x = length_mm (heading π); s = progress along its own direction.
 *  - motion: a present agent that has started is commanded its free speed straight ahead (constant twist v, no
 *    turning); the KIN-2D contact response decides what is executed:
 *      'stop'  — kinematics2d.ts freeze: a body whose own motion does not clearly open the gap stops; without a decision
 *                clock it holds until the horizon (the KIN-2D baseline);
 *      'slow'  — shared contact constraint (kinematics2d-contact.ts 'project'): the closing body executes the feasible
 *                velocity closest to its command (behind a slower leader: the leader's speed; PH-3b's follow rule).
 *  - epochs: the time line is cut at every start time, every arrival and the horizon; inside an epoch every command is
 *    constant and the KIN-2D run is exact. An arrival found inside an epoch ends the epoch there (re-run to that instant).
 *    Contact episodes and constraint intervals are stitched across epoch boundaries (contact-classification.ts records);
 *    the KIN-2D contact hysteresis restarts at a boundary (a pair whose gap is in (θ, θ + ρ] is closed there; counted).
 *  - arrival (ruling 4): the first instant at which s reaches goal_s_mm. With arrival 'leave_to_ledger' the body LEAVES
 *    the lane at that instant (it is no obstacle afterwards) and an 'arrive' request at that exact instant goes to the
 *    agent's site in the destination ledger (runSiteLedger: admit / queue / turn away, dwell, release). Queued agents
 *    wait OFF the lane (scenario assumption; where a queue stands in 2-D is undecided, docs/physics-destinations-traffic.md
 *    §8). A contact that ends because a body left the lane is end_is_physical false (not a separation, not a cause).
 *    arrival 'stay_as_obstacle' is the PH-3b / WP4 baseline kept ONLY as the comparison (the body stays where it arrived).
 *  - conservation: every agent's state log (candidate-metrics.ts AGENT_STATES) is produced from the lane and the ledger.
 * Determinism: agents sorted by id, ledger tie policy explicit, no randomness here. Units: mm, s, rad.
 */
import { PlanBuilder, runKinematics, advancePose, capsuleAt, capGap, dimsOf, Kin2DRefused, CONTACT_TOL_MM, type BodyDims, type Pose, type Static, type Track } from './kinematics2d.ts';
import { runKinematicsWithContactMode } from './kinematics2d-contact.ts';
import { gridTime, addTime } from './exact-time.ts';
import { runSiteLedger, validateSites, type SiteSpec, type TiePolicy, type LedgerRun, type SiteRequest } from './destinations.ts';
import { classifyKin, classifyKinProject, type ContactClassification, type ContactEpisode, type ConstraintActive } from './contact-classification.ts';
import type { AgentState, Transition } from './candidate-metrics.ts';

export class LaneFlowRefused extends Error { constructor(m: string) { super(`LANE_FLOW_REFUSED: ${m}`); this.name = 'LaneFlowRefused'; } }

export type ContactResponse = 'stop' | 'slow';
export type ArrivalRule = 'leave_to_ledger' | 'stay_as_obstacle';
export interface LaneSpec { length_mm: number; width_mm: number }
export interface FlowAgentSpec {
  id: string; dir: 1 | -1;
  /** start pose: progress along its own direction from its entry end, lateral offset (world y) */
  s_mm: number; u_mm: number;
  goal_s_mm: number; start_t_s: number; free_speed_mm_s: number; body: BodyDims;
  /** destination ledger site that receives its arrival */
  site: string;
}
export interface LaneFlowInput {
  lane: LaneSpec; agents: FlowAgentSpec[]; horizon_s: number;
  contact_response: ContactResponse; arrival: ArrivalRule;
  sites: SiteSpec[]; tie?: TiePolicy;
  /** entry control (ruling 5): absent from the lane until it enters at its start pose; enters at EXACTLY start_t_s if
   *  that pose is free (capsule gap > θ to every body on the lane), else waits off the lane and retries at
   *  start_t_s + k·retry_interval_s (exact decimals). Ties at one instant: scheduled time, then id. Omitted = every body
   *  is on the lane at its start pose from t = 0 (the PH-3b / KIN-2D convention). */
  entry?: { control: true; retry_interval_s: number };
  /** decision layer (ruling 7; opt-in; omitted = no decisions, output unchanged). Each agent has its OWN clock anchored
   *  at its ACTUAL start (no entry control: start_t_s) or ACTUAL entry instant (entry control): it decides there first
   *  and then at anchor + k·interval_s (exact decimals; #180 individual clock). A decision reads ONLY the state at that
   *  instant within sensing_radius_mm (LocalView): no history, no future, no global quantity. Rule 'go_unless_oncoming'
   *  (candidate, 遊戲假設): wait if a body moving the other way blocks the way ahead (its capsule overlaps the own capsule
   *  swept forward by the sensing radius), else go at the free speed (a same-direction body ahead is followed; the
   *  contact response decides the mechanics). With contact_response 'stop' a stopped body holds until its next own
   *  decision instant and then decides again. No decision at the horizon (zero duration). */
  decision?: { interval_s: number; sensing_radius_mm: number; rule: 'go_unless_oncoming' };
  /** DIAGNOSTIC only (ruling 6, chunk determinism): extra epoch cuts with no behavioural meaning. The model output
   *  should not depend on them; how far it does (float rounding of restarted closed forms) is measured, not hidden. */
  chunk_boundaries_s?: number[];
}
/** what a decision may read: bodies on the lane within the sensing radius at the decision instant (capsule and heading only) */
export interface LocalView { t_s: number; self: { id: string; pose: Pose; dims: { h: number; r: number } }; sensed: { id: string; pose: Pose; dims: { h: number; r: number }; gap_mm: number }[] }
export interface DecisionRecord { t_s: number; agent: string; kind: 'go' | 'wait'; first: boolean; sensed: string[]; blocking: string[] }
/** the candidate rule, a pure function of the LocalView only */
export function decideGoUnlessOncoming(v: LocalView, radius: number): { kind: 'go' | 'wait'; blocking: string[] } {
  const p = v.self.pose, c = Math.cos(p.th), s = Math.sin(p.th), h = v.self.dims.h;
  const probe = { a: { x: p.x - c * h, y: p.y - s * h }, b: { x: p.x + c * (h + radius), y: p.y + s * (h + radius) }, r: v.self.dims.r };
  const blocking = v.sensed.filter((o) => capGap(probe, capsuleAt(o.pose, o.dims)).g < 0).map((o) => o.id);
  const oncoming = v.sensed.filter((o) => blocking.includes(o.id) && Math.cos(o.pose.th - p.th) < 0);
  return { kind: oncoming.length ? 'wait' : 'go', blocking };
}
/** executed motion piece (closed form: pose(t) = advancePose(p0, tw, t − t0) for t ∈ [t0, t1]) */
export interface ExecPiece { t0: number; t1: number; p0: Pose; tw: { v: number; vl: number; w: number } }
export interface FlowAgentOut {
  dir: 1 | -1; site: string; scheduled_t_s: number;
  /** on the lane from / until (removed_t_s null = still on the lane at the horizon) */
  present_from_t_s: number | null; removed_t_s: number | null;
  arrival_t_s: number | null; final_state: AgentState; final_pose: Pose | null;
  pieces: ExecPiece[];
  /** pose samples [t, x, y, θ] at every epoch boundary and piece boundary while on the lane */
  samples: [number, number, number, number][];
}
export interface LaneFlowResult {
  agents: Record<string, FlowAgentOut>;
  classification: ContactClassification;
  ledger: LedgerRun;
  transitions: Transition[];
  initial_states: Record<string, AgentState>;
  statics: Static[];
  stats: { epochs: number; kin_runs: number; reruns_to_arrival: number; arrived: number; hysteresis_closes: number; boundary_contact_ends: number; entered: number; entry_blocked_attempts: number };
  /** decision layer only (absent without it: the output is then unchanged) */
  decisions?: DecisionRecord[];
}

/** numerical: reaching the goal within this progress (mm) at an epoch end counts as arrived there (float rounding) */
export const GOAL_TOL_MM = 1e-9;
const ZERO = { v: 0, vl: 0, w: 0 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Ag {
  sp: FlowAgentSpec; d: { L: number }; pose: Pose; present: boolean; started: boolean; frozen: boolean;
  arrived: number | null; removed: number | null; presentFrom: number | null; pieces: ExecPiece[]; samples: [number, number, number, number][];
  /** entry control: attempts made, next attempt instant (null = none left before the horizon or entered) */
  tries: number; nextTry: number | null;
  /** decision layer: command in effect, own clock anchor, own index, next own instant (null = none), first decision pending */
  cmd: 'go' | 'wait'; anchor: number | null; dk: number; nextDec: number | null; firstDue: boolean;
}

export function laneFlow(input: LaneFlowInput): LaneFlowResult {
  const { lane, horizon_s: H } = input;
  if (!(lane.length_mm > 0 && lane.width_mm > 0)) throw new LaneFlowRefused('lane length and width must be positive (never defaulted)');
  if (!(H > 0) || !Number.isFinite(H)) throw new LaneFlowRefused('horizon must be positive and finite');
  if (input.contact_response !== 'stop' && input.contact_response !== 'slow') throw new LaneFlowRefused(`unknown contact response ${String(input.contact_response)}`);
  if (input.arrival !== 'leave_to_ledger' && input.arrival !== 'stay_as_obstacle') throw new LaneFlowRefused(`unknown arrival rule ${String(input.arrival)}`);
  validateSites(input.sites);
  const CTL = input.entry ?? null, DEC = input.decision ?? null;
  if (DEC && (!(DEC.interval_s > 0) || !Number.isFinite(DEC.interval_s) || !(DEC.sensing_radius_mm > 0) || DEC.rule !== 'go_unless_oncoming')) throw new LaneFlowRefused('decision layer needs a positive interval_s, a positive sensing_radius_mm and rule go_unless_oncoming (candidates, never defaulted)');
  const decisions: DecisionRecord[] = [];
  if (CTL && (CTL.control !== true || !(CTL.retry_interval_s > 0) || !Number.isFinite(CTL.retry_interval_s))) throw new LaneFlowRefused('entry control needs control: true and a positive retry_interval_s (scenario assumption, never defaulted)');
  const siteIds = new Set(input.sites.map((s) => s.id));
  const specs = [...input.agents].sort((a, b) => cmp(a.id, b.id));
  for (let i = 1; i < specs.length; i++) if (specs[i].id === specs[i - 1].id) throw new LaneFlowRefused(`duplicate agent ${specs[i].id}`);
  const W2 = lane.width_mm / 2;
  const statics: Static[] = [{ id: 'wall:left', kind: 'segment', a: { x: 0, y: W2 }, b: { x: lane.length_mm, y: W2 } }, { id: 'wall:right', kind: 'segment', a: { x: 0, y: -W2 }, b: { x: lane.length_mm, y: -W2 } }];
  const staticIds = statics.map((s) => s.id);
  const poseOf = (sp: FlowAgentSpec, s: number): Pose => ({ x: sp.dir > 0 ? s : lane.length_mm - s, y: sp.u_mm, th: sp.dir > 0 ? 0 : Math.PI });
  const progress = (sp: FlowAgentSpec, p: Pose) => (sp.dir > 0 ? p.x : lane.length_mm - p.x);
  const A: Ag[] = specs.map((sp) => {
    if (sp.dir !== 1 && sp.dir !== -1) throw new LaneFlowRefused(`${sp.id}: dir must be ±1`);
    if (!siteIds.has(sp.site)) throw new LaneFlowRefused(`${sp.id}: unknown site ${sp.site}`);
    const L = sp.body.length_mm, w = sp.body.width_mm;
    if (typeof L !== 'number' || typeof w !== 'number' || !(L > 0 && w > 0)) throw new LaneFlowRefused(`${sp.id}: body size unknown (never defaulted)`);
    if (!(sp.free_speed_mm_s > 0) || !Number.isFinite(sp.free_speed_mm_s)) throw new LaneFlowRefused(`${sp.id}: free speed must be positive`);
    if (!(sp.s_mm >= 0 && sp.goal_s_mm >= sp.s_mm && sp.goal_s_mm <= lane.length_mm)) throw new LaneFlowRefused(`${sp.id}: start / goal must satisfy 0 ≤ s ≤ goal ≤ lane length`);
    if (Math.abs(sp.u_mm) + w / 2 > W2) throw new LaneFlowRefused(`${sp.id}: body outside the lane walls`);
    if (!(sp.start_t_s >= 0) || !Number.isFinite(sp.start_t_s)) throw new LaneFlowRefused(`${sp.id}: start time`);
    return { sp, d: { L }, pose: poseOf(sp, sp.s_mm), present: !CTL, started: false, frozen: false, arrived: null, removed: null, presentFrom: CTL ? null : 0, pieces: [], samples: [], tries: 0, nextTry: CTL && sp.start_t_s <= H ? sp.start_t_s : null, cmd: 'go', anchor: null, dk: 0, nextDec: null, firstDue: false };
  });
  const byId = new Map(A.map((a) => [a.sp.id, a]));
  const transitions: Transition[] = [];
  const initial_states: Record<string, AgentState> = Object.fromEntries(A.map((a) => [a.sp.id, (CTL ? 'scheduled' : 'in_lane') as AgentState]));
  const requests: SiteRequest[] = [];
  const stats = { epochs: 0, kin_runs: 0, reruns_to_arrival: 0, arrived: 0, hysteresis_closes: 0, boundary_contact_ends: 0, entered: 0, entry_blocked_attempts: 0 };
  // stitched records
  const episodes: ContactEpisode[] = [], constraints: ConstraintActive[] = [];
  const openEp = new Map<string, ContactEpisode>(), openCa = new Map<string, ConstraintActive>();
  const epKey = (e: ContactEpisode) => `${e.geometry}|${e.ids.join('|')}`;
  const sample = (a: Ag, t: number) => { const s = a.samples.at(-1); if (!s || s[0] !== t) a.samples.push([t, a.pose.x, a.pose.y, a.pose.th]); };

  const removeAgent = (a: Ag, t: number) => {
    a.present = false; a.removed = t;
    for (const [k, e] of [...openEp]) if (e.ids.includes(a.sp.id)) { e.end_t_s = t; e.end_is_physical = false; openEp.delete(k); stats.boundary_contact_ends++; }
    for (const [k, c] of [...openCa]) if (c.bodies.includes(a.sp.id)) { c.end_t_s = t; openCa.delete(k); }
  };
  const arrive = (a: Ag, t: number) => {
    a.arrived = t; stats.arrived++;
    if (input.arrival === 'leave_to_ledger') { removeAgent(a, t); requests.push({ t, agent: a.sp.id, site: a.sp.site, kind: 'arrive' }); }
  };
  const moving = (a: Ag) => a.present && a.started && a.arrived === null && !a.frozen && a.cmd === 'go';
  /** the agent starts its own decision clock at its actual start / entry instant */
  const anchorAt = (a: Ag, now: number) => { if (DEC && a.arrived === null) { a.anchor = now; a.dk = 0; a.firstDue = true; a.cmd = 'wait'; } };
  /** decisions due at `now` (first decisions and own-clock instants), as ONE batch reading the same state */
  const decideDue = (now: number) => {
    if (!DEC || now >= H) return;
    const due = A.filter((a) => a.present && a.arrived === null && (a.firstDue || a.nextDec === now));
    if (!due.length) return;
    const views = due.map((a) => {
      const dims = dimsOf(a.sp.body, a.sp.id), own = capsuleAt(a.pose, dims);
      const sensed = A.filter((b) => b !== a && b.present).map((b) => { const bd = dimsOf(b.sp.body, b.sp.id); return { id: b.sp.id, pose: { ...b.pose }, dims: bd, gap_mm: capGap(own, capsuleAt(b.pose, bd)).g }; }).filter((o) => o.gap_mm <= DEC.sensing_radius_mm);
      return { a, view: { t_s: now, self: { id: a.sp.id, pose: { ...a.pose }, dims }, sensed } as LocalView };
    });
    for (const { a, view } of views) {
      const d = decideGoUnlessOncoming(view, DEC.sensing_radius_mm);
      decisions.push({ t_s: now, agent: a.sp.id, kind: d.kind, first: a.firstDue, sensed: view.sensed.map((o) => o.id), blocking: d.blocking });
      a.cmd = d.kind; a.frozen = false; a.firstDue = false; a.dk++;
      const nt = addTime(a.anchor as number, gridTime(a.dk, DEC.interval_s));
      a.nextDec = nt <= H ? nt : null;
    }
  };

  // initial legality: no overlap among bodies present at the start (with entry control nobody is on the lane before entering)
  if (!CTL) {
    const tracks = A.map((a) => new PlanBuilder(a.sp.id, a.sp.body, a.pose, 0).build());
    try { runKinematics({ tracks, statics, horizon_s: 0 }); } catch (e) { if (e instanceof Kin2DRefused) throw new LaneFlowRefused(`start poses: ${e.message}`); throw e; }
  }
  const starts = CTL ? [] : [...new Set(A.map((a) => a.sp.start_t_s).filter((t) => t <= H))].sort((x, y) => x - y);
  let t = 0;
  const startDue = (now: number) => { for (const a of A) if (!a.started && a.present && a.sp.start_t_s <= now) { a.started = true; if (progress(a.sp, a.pose) >= a.sp.goal_s_mm) arrive(a, now); else anchorAt(a, now); } };
  /** entry control at instant `now`: attempts due now, in (scheduled time, id) order; each checks the bodies on the lane (incl. those that just entered) */
  const entriesDue = (now: number) => {
    if (!CTL) return;
    for (const a of A.filter((x) => x.nextTry === now).sort((x, y) => x.sp.start_t_s - y.sp.start_t_s || cmp(x.sp.id, y.sp.id))) {
      const cap = capsuleAt(a.pose, dimsOf(a.sp.body, a.sp.id));
      const free = A.every((b) => !b.present || capGap(cap, capsuleAt(b.pose, dimsOf(b.sp.body, b.sp.id))).g > CONTACT_TOL_MM);
      if (free) {
        a.present = true; a.presentFrom = now; a.started = true; a.nextTry = null; stats.entered++;
        transitions.push({ t: now, agent: a.sp.id, to: 'in_lane' }); sample(a, now);
        if (progress(a.sp, a.pose) >= a.sp.goal_s_mm) arrive(a, now); else anchorAt(a, now);
      } else {
        stats.entry_blocked_attempts++;
        if (a.tries === 0) transitions.push({ t: now, agent: a.sp.id, to: 'waiting_entry' });
        a.tries++;
        const nt = addTime(a.sp.start_t_s, gridTime(a.tries, CTL.retry_interval_s));
        a.nextTry = nt <= H ? nt : null;
      }
    }
  };
  if (!CTL) for (const a of A) sample(a, 0);
  startDue(0);
  entriesDue(0);
  decideDue(0);
  for (;;) {
    const tries = A.map((a) => a.nextTry).filter((x): x is number => x !== null && x > t);
    const decs = DEC ? A.map((a) => (a.present && a.arrived === null ? a.nextDec : null)).filter((x): x is number => x !== null && x > t) : [];
    const next = Math.min(H, ...starts.filter((s) => s > t), ...tries, ...decs, ...(input.chunk_boundaries_s ?? []).filter((c) => c > t));
    const live = A.filter((a) => a.present);
    let tEnd = next;
    if (live.some(moving) && next > t) {
      const run = (until: number) => {
        stats.kin_runs++;
        const tracks: Track[] = live.map((a) => { const b = new PlanBuilder(a.sp.id, a.sp.body, a.pose, t); if (moving(a)) b.twist({ v: a.sp.free_speed_mm_s, vl: 0, w: 0 }, until - t, 'cmd'); return b.build(); });
        const kin = { tracks, statics, horizon_s: until };
        if (input.contact_response === 'stop') { const r = runKinematics(kin); return { executed: r.executed, final: r.final, cls: classifyKin(r, until, staticIds) }; }
        const r = runKinematicsWithContactMode(kin, 'project'); return { executed: r.executed, final: r.final, cls: classifyKinProject(r, until, staticIds) };
      };
      let r = run(next);
      // earliest arrival inside (t, next]
      let ta = Infinity;
      for (const a of live) if (moving(a)) for (const s of r.executed[a.sp.id].segs) {
        const s0 = progress(a.sp, s.p0), rate = a.sp.dir * (Math.cos(s.p0.th) * s.tw.v - Math.sin(s.p0.th) * s.tw.vl);
        const t1 = Math.min(s.t1, next);
        if (s0 >= a.sp.goal_s_mm - GOAL_TOL_MM) { ta = Math.min(ta, Math.max(t, s.t0)); break; }
        if (rate > 0 && s.tw.w === 0 && s0 + rate * (t1 - s.t0) >= a.sp.goal_s_mm - GOAL_TOL_MM) { ta = Math.min(ta, s.t0 + Math.max(0, a.sp.goal_s_mm - s0) / rate); break; }
      }
      if (ta < next && ta > t) { stats.reruns_to_arrival++; r = run(ta); tEnd = ta; }
      // apply the epoch
      for (const a of live) {
        const ex = r.executed[a.sp.id];
        for (const s of ex.segs) if (s.t1 > s.t0) a.pieces.push({ t0: s.t0, t1: Math.min(s.t1, tEnd), p0: s.p0, tw: s.tw });
        for (const s of ex.segs) if (s.t0 > t && s.t0 < tEnd) a.samples.push([s.t0, s.p0.x, s.p0.y, s.p0.th]);
        a.pose = r.final[a.sp.id];
        if (input.contact_response === 'stop' && ex.stopped_at_s !== null) a.frozen = true;
      }
      stitch(r.cls, t);
    } else if (next > t) {
      for (const a of live) a.pieces.push({ t0: t, t1: next, p0: a.pose, tw: ZERO });
    }
    stats.epochs++;
    t = tEnd;
    for (const a of A) if (a.present) sample(a, t);
    for (const a of live) if (moving(a) && progress(a.sp, a.pose) >= a.sp.goal_s_mm - GOAL_TOL_MM) arrive(a, t);
    if (t >= H) { entriesDue(t); break; }
    startDue(t);
    entriesDue(t);
    decideDue(t);
  }

  // ledger: arrivals → admit / queue / turn away → release
  const ledger = runSiteLedger(input.sites, requests, input.tie ?? { kind: 'agent_id' });
  for (const e of ledger.events) {
    const to: AgentState | null = e.kind === 'admit' ? 'at_destination' : e.kind === 'queue' ? 'queued' : e.kind === 'turn_away' ? 'turned_away' : e.kind === 'release' ? 'released' : null;
    if (to) transitions.push({ t: e.t, agent: e.agent, to });
  }
  const stateOf = new Map<string, AgentState>(Object.entries(initial_states));
  for (const x of [...transitions].map((x, i) => ({ ...x, i })).sort((p, q) => p.t - q.t || p.i - q.i)) stateOf.set(x.agent, x.to);
  const agents: Record<string, FlowAgentOut> = {};
  for (const a of A) agents[a.sp.id] = { dir: a.sp.dir, site: a.sp.site, scheduled_t_s: a.sp.start_t_s, present_from_t_s: a.presentFrom, removed_t_s: a.removed, arrival_t_s: a.arrived, final_state: stateOf.get(a.sp.id)!, final_pose: a.present ? { ...a.pose } : null, pieces: a.pieces, samples: a.samples };
  const classification: ContactClassification = { source: 'LANE-FLOW', horizon_s: H, contact_episodes: sortEp(episodes), constraint_active: sortCa(constraints) };
  return { agents, classification, ledger, transitions, initial_states, statics, stats, ...(DEC ? { decisions } : {}) };

  function stitch(c: ContactClassification, t0: number) {
    const seenEp = new Set<string>();
    for (const e of c.contact_episodes) {
      const k = epKey(e), o = openEp.get(k);
      if (o && e.start_t_s === t0) { seenEp.add(k); if (e.end_t_s !== null) { o.end_t_s = e.end_t_s; openEp.delete(k); } continue; }
      const n: ContactEpisode = { ...e, ids: [...e.ids] as [string, string], source: 'LANE-FLOW' };
      episodes.push(n); seenEp.add(k);
      if (n.end_t_s === null) openEp.set(k, n);
    }
    // an episode open at t0 that the new epoch does not continue: its gap is in (θ, θ + ρ] at the boundary (hysteresis restart)
    for (const [k, o] of [...openEp]) if (!seenEp.has(k) && o.start_t_s < t0) { o.end_t_s = t0; openEp.delete(k); stats.hysteresis_closes++; }
    const seenCa = new Set<string>();
    for (const x of c.constraint_active) {
      const k = x.bodies.join('|'), o = openCa.get(k);
      if (o && x.start_t_s === t0 && x.end_t_s !== x.start_t_s) { // the same interval continues across the boundary
        seenCa.add(k); o.partners = [...new Set([...o.partners, ...x.partners])].sort();
        if (x.end_t_s !== null) { o.end_t_s = x.end_t_s; openCa.delete(k); }
        continue;
      }
      const n: ConstraintActive = { ...x, bodies: [...x.bodies], partners: [...x.partners], source: 'LANE-FLOW' };
      constraints.push(n);
      if (n.end_t_s === null) { openCa.set(k, n); seenCa.add(k); }
    }
    for (const [k, o] of [...openCa]) if (!seenCa.has(k) && o.start_t_s < t0) { o.end_t_s = t0; openCa.delete(k); }
  }
}
const sortEp = (xs: ContactEpisode[]) => xs.sort((x, y) => x.start_t_s - y.start_t_s || cmp(x.geometry, y.geometry) || cmp(x.ids.join('|'), y.ids.join('|')));
const sortCa = (xs: ConstraintActive[]) => xs.sort((x, y) => x.start_t_s - y.start_t_s || cmp(x.bodies.join('|'), y.bodies.join('|')) || cmp(x.cause, y.cause));

/** closed-form pose of an agent at t from its executed pieces (null when it is not on the lane at t) */
export function poseAtFlow(a: FlowAgentOut, t: number): Pose | null {
  if (a.present_from_t_s === null || t < a.present_from_t_s || (a.removed_t_s !== null && t > a.removed_t_s)) return null;
  let best: ExecPiece | null = null;
  for (const p of a.pieces) if (p.t0 <= t && t <= p.t1) best = p;
  if (!best) { const last = a.pieces.filter((p) => p.t1 <= t).at(-1); return last ? advancePose(last.p0, last.tw, last.t1 - last.t0) : a.final_pose; }
  return advancePose(best.p0, best.tw, t - best.t0);
}
