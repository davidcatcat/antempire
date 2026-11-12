/**
 * Issue #189 / #193 ruling 6 — reusable metrics for the walking / contact / traffic CANDIDATES (isolated; solver-agnostic).
 *
 * Status: isolated physics experiment tooling. Not imported by the daily loop, Day0, cli/ or web/
 * (tests/physics-isolation.test.ts). It does not move bodies and does not call any solver: a producer (PH-3b solve2D,
 * WP4 steer2D, KIN-2D runKinematics / runKinematicsWithContactMode, or a later integration candidate) exports generic
 * records and this module measures them. It extends engine/physics/traffic-metrics.ts (#158), which it reuses (dist).
 *
 * Metrics (ruling 6 list), each with an explicit measurement definition:
 *  1. no-penetration / missed contact — from INDEPENDENT gap samples (an observer's own evaluation of the exact capsule
 *     gaps at chosen instants, not the producer's events): penetration = a sample with gap < −penetration_tol_mm;
 *     missed contact = a sample with gap ≤ contact_tol_mm that lies in no reported contact episode of that pair
 *     (± time_slack_s). Episodes with no sample inside are reported as `unsampled` (not an error: sampling is sparse).
 *  2. throughput — arrivals (or ledger admissions) per second over a stated window.
 *  3. waiting time — per agent: time below a stall speed (from position samples), queue waits (destination ledger
 *     queue → admit), entry waits (scheduled entry → actual entry).
 *  4. head-on collisions — reported contact episodes classified by the angle between the two body headings at the
 *     episode start: head_on (≥ head_on_min_deg), same_direction (≤ same_direction_max_deg), crossing (between).
 *  5. position conservation — a per-agent state log (scheduled / waiting_entry / in_lane / queued / at_destination /
 *     released / turned_away); after every transition every agent is in exactly one state, the census sums to the
 *     agent total, every transition is an allowed edge, and time never goes back; plus no teleport (displacement between
 *     consecutive samples ≤ v_max·Δt + tol).
 *  6. chunk determinism — two outputs compared value by value: bitwise equality and, if not equal, the first differing
 *     path and the largest absolute numeric difference (a tolerance is NEVER applied silently: the caller sees both).
 *  7. turning statistics — heading changes of the path resampled every resample_ds_mm along its arc length; rad/mm,
 *     total rad, and a turn count above turn_threshold_rad per 150 mm. This is a PROXY with its own definition; it is
 *     NOT the measurement of R133 (hand-scored on 5 mm graph paper; raw video unavailable; ruling 9).
 * Every threshold is an observer choice: it must be passed in with assumption: true (never defaulted).
 * Pure, deterministic, independent of input array order (records are sorted by (agent, t) / pair key). Units: mm, s, rad.
 */
import { dist, type Dist } from './traffic-metrics.ts';
import type { SiteEvent } from './destinations.ts';

export class MetricsRefused extends Error { constructor(m: string) { super(`METRICS_REFUSED: ${m}`); this.name = 'MetricsRefused'; } }

/** an observer threshold: always a labelled assumption */
export interface Threshold { value: number; assumption: true; basis: '遊戲假設'; note: string }
const thr = (t: Threshold | undefined, what: string): number => {
  if (!t || t.assumption !== true || t.basis !== '遊戲假設' || typeof t.note !== 'string') throw new MetricsRefused(`${what}: an observer threshold must be passed with assumption: true, basis 遊戲假設 and a note`);
  if (!Number.isFinite(t.value)) throw new MetricsRefused(`${what}: value must be finite`);
  return t.value;
};
const strCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

// ---------------------------------------------------------------- generic records
export interface PoseSample { agent: string; t: number; x_mm: number; y_mm: number; /** body heading if the producer has one */ th?: number }
/** a reported (producer) geometric contact episode; end null = still open at the horizon */
export interface EpisodeRec { agents: [string, string]; start_t_s: number; end_t_s: number | null }
/** an observer's independent gap evaluation */
export interface GapSample { t: number; a: string; b: string; gap_mm: number }

const byAgent = (samples: PoseSample[]): Map<string, PoseSample[]> => {
  const m = new Map<string, PoseSample[]>();
  for (const s of samples) {
    if (![s.t, s.x_mm, s.y_mm].every(Number.isFinite)) throw new MetricsRefused(`non-finite sample for ${s.agent}`);
    (m.get(s.agent) ?? m.set(s.agent, []).get(s.agent)!).push(s);
  }
  for (const [a, xs] of m) {
    xs.sort((p, q) => p.t - q.t);
    for (let i = 1; i < xs.length; i++) if (xs[i].t === xs[i - 1].t && (xs[i].x_mm !== xs[i - 1].x_mm || xs[i].y_mm !== xs[i - 1].y_mm)) throw new MetricsRefused(`agent ${a} at two places at t=${xs[i].t}`);
  }
  return new Map([...m].sort((x, y) => strCmp(x[0], y[0])));
};

// ---------------------------------------------------------------- 1. no penetration / missed contact
export interface ContactAudit {
  samples: number;
  penetration: { count: number; max_depth_mm: number };
  missed_contacts: { count: number; pairs: string[]; first: GapSample | null };
  /** reported episodes that no gap sample fell into (sparse sampling, informational) */
  unsampled_episodes: number;
  /** reported episodes inside which some sample had gap > contact_tol_mm + episode_gap_slack (an episode that is not a contact) */
  phantom_samples: number;
}
export function auditContacts(gaps: GapSample[], episodes: EpisodeRec[], opt: { contact_tol_mm: Threshold; penetration_tol_mm: Threshold; time_slack_s: Threshold; episode_gap_slack_mm: Threshold }): ContactAudit {
  const tol = thr(opt.contact_tol_mm, 'contact_tol_mm'), pen = thr(opt.penetration_tol_mm, 'penetration_tol_mm'), slack = thr(opt.time_slack_s, 'time_slack_s'), gs = thr(opt.episode_gap_slack_mm, 'episode_gap_slack_mm');
  const ep = new Map<string, EpisodeRec[]>();
  for (const e of episodes) { const k = pairKey(e.agents[0], e.agents[1]); (ep.get(k) ?? ep.set(k, []).get(k)!).push(e); }
  const inside = (e: EpisodeRec, t: number, s: number) => t >= e.start_t_s - s && (e.end_t_s === null || t <= e.end_t_s + s);
  const sampled = new Set<EpisodeRec>();
  let pc = 0, depth = 0, mc = 0, phantom = 0; const missedPairs = new Set<string>(); let first: GapSample | null = null;
  const sorted = [...gaps].sort((x, y) => x.t - y.t || strCmp(pairKey(x.a, x.b), pairKey(y.a, y.b)));
  for (const g of sorted) {
    if (!Number.isFinite(g.gap_mm) || !Number.isFinite(g.t)) throw new MetricsRefused('non-finite gap sample');
    if (g.gap_mm < -pen) { pc++; depth = Math.max(depth, -g.gap_mm); }
    const list = ep.get(pairKey(g.a, g.b)) ?? [];
    for (const e of list) if (inside(e, g.t, 0)) { sampled.add(e); if (g.gap_mm > tol + gs) phantom++; }
    if (g.gap_mm <= tol && !list.some((e) => inside(e, g.t, slack))) { mc++; missedPairs.add(pairKey(g.a, g.b)); if (!first) first = g; }
  }
  return { samples: gaps.length, penetration: { count: pc, max_depth_mm: depth }, missed_contacts: { count: mc, pairs: [...missedPairs].sort(), first }, unsampled_episodes: episodes.length - sampled.size, phantom_samples: phantom };
}

/**
 * Merges consecutive episodes of one pair that are numerical chatter of ONE contact: every observer gap sample strictly
 * between them is ≤ max_gap_mm, or (no sample between them) the pause is ≤ max_pause_s. Reported next to the raw count,
 * never instead of it.
 */
export function mergeEpisodes(episodes: EpisodeRec[], gaps: GapSample[], opt: { max_gap_mm: Threshold; max_pause_s: Threshold }): EpisodeRec[] {
  const mg = thr(opt.max_gap_mm, 'max_gap_mm'), mp = thr(opt.max_pause_s, 'max_pause_s');
  const byPair = new Map<string, EpisodeRec[]>(), gp = new Map<string, GapSample[]>();
  for (const e of episodes) { const k = pairKey(e.agents[0], e.agents[1]); (byPair.get(k) ?? byPair.set(k, []).get(k)!).push(e); }
  for (const g of gaps) { const k = pairKey(g.a, g.b); (gp.get(k) ?? gp.set(k, []).get(k)!).push(g); }
  const out: EpisodeRec[] = [];
  for (const [k, list] of [...byPair].sort((x, y) => strCmp(x[0], y[0]))) {
    const xs = [...list].sort((a, b) => a.start_t_s - b.start_t_s), g = gp.get(k) ?? [];
    let cur: EpisodeRec = { agents: xs[0].agents, start_t_s: xs[0].start_t_s, end_t_s: xs[0].end_t_s };
    for (const e of xs.slice(1)) {
      const between = cur.end_t_s === null ? [] : g.filter((q) => q.t > (cur.end_t_s as number) && q.t < e.start_t_s);
      const chatter = cur.end_t_s !== null && (between.length ? between.every((q) => q.gap_mm <= mg) : e.start_t_s - cur.end_t_s <= mp);
      if (chatter) cur = { ...cur, end_t_s: e.end_t_s }; else { out.push(cur); cur = { agents: e.agents, start_t_s: e.start_t_s, end_t_s: e.end_t_s }; }
    }
    out.push(cur);
  }
  return out.sort((x, y) => x.start_t_s - y.start_t_s || strCmp(pairKey(...x.agents), pairKey(...y.agents)));
}

// ---------------------------------------------------------------- 2. throughput
export interface Throughput { count: number; window_s: [number, number]; per_s: number | null; definition: string }
/** events (arrivals or ledger admissions) with t in [w0, w1] per second of the window */
export function throughput(events: { agent: string; t: number }[], window_s: [number, number]): Throughput {
  const [w0, w1] = window_s;
  if (!(Number.isFinite(w0) && Number.isFinite(w1) && w1 >= w0)) throw new MetricsRefused('throughput window must be [w0, w1] with w1 ≥ w0');
  const n = events.filter((e) => e.t >= w0 && e.t <= w1).length;
  return { count: n, window_s: [w0, w1], per_s: w1 > w0 ? n / (w1 - w0) : null, definition: 'events with t in the closed window per second of window length (arrival rate is not a selection criterion, #158)' };
}
/** ledger admissions as throughput events */
export const admissionsOf = (ev: SiteEvent[], site?: string): { agent: string; t: number }[] => ev.filter((e) => e.kind === 'admit' && (site === undefined || e.site === site)).map((e) => ({ agent: e.agent, t: e.t }));

// ---------------------------------------------------------------- 3. waiting time
export interface Waiting { stall_s: Dist; stall_fraction: Dist; queue_wait_s: Dist; entry_wait_s: Dist; definition: string }
export function waitingTimes(samples: PoseSample[], opt: { stall_speed_mm_s: Threshold }, siteEvents: SiteEvent[] = [], entries: { agent: string; scheduled_t: number; entered_t: number | null }[] = []): Waiting {
  const vs = thr(opt.stall_speed_mm_s, 'stall_speed_mm_s');
  const stall: number[] = [], frac: number[] = [];
  for (const [, xs] of byAgent(samples)) {
    let s = 0, T = 0;
    for (let i = 1; i < xs.length; i++) { const dt = xs[i].t - xs[i - 1].t; if (!(dt > 0)) continue; const v = Math.hypot(xs[i].x_mm - xs[i - 1].x_mm, xs[i].y_mm - xs[i - 1].y_mm) / dt; T += dt; if (v < vs) s += dt; }
    if (T > 0) { stall.push(s); frac.push(s / T); }
  }
  const q = new Map<string, number>(), waits: number[] = [];
  for (const e of siteEvents) {
    const k = `${e.agent}|${e.site}`;
    if (e.kind === 'queue') q.set(k, e.t);
    else if (e.kind === 'admit') { waits.push(q.has(k) ? e.t - q.get(k)! : 0); q.delete(k); }
  }
  const ent = entries.filter((e) => e.entered_t !== null).map((e) => (e.entered_t as number) - e.scheduled_t);
  return { stall_s: dist(stall), stall_fraction: dist(frac), queue_wait_s: dist(waits), entry_wait_s: dist(ent), definition: 'stall = sample-to-sample speed below stall_speed (left rectangle); queue wait = ledger queue → admit; entry wait = scheduled → actual entry' };
}

// ---------------------------------------------------------------- 4. head-on collisions
export type EncounterClass = 'head_on' | 'same_direction' | 'crossing' | 'unknown_heading';
export interface HeadOn { head_on: number; same_direction: number; crossing: number; unknown_heading: number; episodes: { agents: [string, string]; t: number; angle_rad: number | null; class: EncounterClass }[]; definition: string }
/** heading of an agent at t: the sample's th if given, else the direction of the displacement over the sample interval containing t */
export function headingAt(samples: PoseSample[], agent: string, t: number): number | null {
  const xs = samples.filter((s) => s.agent === agent).sort((p, q) => p.t - q.t);
  if (!xs.length) return null;
  let i = xs.findIndex((s) => s.t > t); if (i < 0) i = xs.length; // first sample after t
  const at = xs.find((s) => s.t === t) ?? xs[Math.max(0, i - 1)];
  if (at.th !== undefined && Number.isFinite(at.th)) return at.th;
  for (let k = Math.max(1, i); k < xs.length; k++) { const a = xs[k - 1], b = xs[k], dx = b.x_mm - a.x_mm, dy = b.y_mm - a.y_mm; if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx); }
  for (let k = Math.min(i, xs.length - 1); k >= 1; k--) { const a = xs[k - 1], b = xs[k], dx = b.x_mm - a.x_mm, dy = b.y_mm - a.y_mm; if (dx !== 0 || dy !== 0) return Math.atan2(dy, dx); }
  return null;
}
export function classifyEncounters(episodes: EpisodeRec[], samples: PoseSample[], opt: { head_on_min_deg: Threshold; same_direction_max_deg: Threshold }): HeadOn {
  const hmin = thr(opt.head_on_min_deg, 'head_on_min_deg') * Math.PI / 180, smax = thr(opt.same_direction_max_deg, 'same_direction_max_deg') * Math.PI / 180;
  if (!(smax < hmin)) throw new MetricsRefused('same_direction_max_deg must be below head_on_min_deg');
  const out: HeadOn = { head_on: 0, same_direction: 0, crossing: 0, unknown_heading: 0, episodes: [], definition: 'angle between the two body headings at the episode start (heading = body θ, else displacement direction)' };
  const eps = [...episodes].sort((x, y) => x.start_t_s - y.start_t_s || strCmp(pairKey(...x.agents), pairKey(...y.agents)));
  for (const e of eps) {
    const ha = headingAt(samples, e.agents[0], e.start_t_s), hb = headingAt(samples, e.agents[1], e.start_t_s);
    let cls: EncounterClass, ang: number | null = null;
    if (ha === null || hb === null) cls = 'unknown_heading';
    else { ang = Math.abs(Math.atan2(Math.sin(ha - hb), Math.cos(ha - hb))); cls = ang >= hmin ? 'head_on' : ang <= smax ? 'same_direction' : 'crossing'; }
    out[cls]++; out.episodes.push({ agents: e.agents, t: e.start_t_s, angle_rad: ang, class: cls });
  }
  return out;
}

// ---------------------------------------------------------------- 5. position conservation
export const AGENT_STATES = ['scheduled', 'waiting_entry', 'in_lane', 'queued', 'at_destination', 'released', 'turned_away'] as const;
export type AgentState = typeof AGENT_STATES[number];
/** allowed state edges (a producer that needs another edge must say so; nothing is added silently) */
export const ALLOWED_EDGES: Readonly<Record<AgentState, readonly AgentState[]>> = Object.freeze({
  scheduled: ['waiting_entry', 'in_lane'],
  waiting_entry: ['in_lane'],
  in_lane: ['queued', 'at_destination', 'turned_away'],
  queued: ['at_destination'],
  at_destination: ['released'],
  released: [],
  turned_away: [],
});
export interface Transition { t: number; agent: string; to: AgentState }
export interface Conservation { ok: boolean; violations: string[]; final_census: Record<AgentState, number>; max_in_lane: number; transitions: number }
/**
 * Every agent starts in `initial[agent]` (default 'scheduled'). Transitions are applied in (t, agent) order; after each
 * one the census over AGENT_STATES must equal the agent total and each agent is in exactly one state.
 */
export function checkConservation(agents: string[], transitions: Transition[], initial: Record<string, AgentState> = {}): Conservation {
  const v: string[] = [];
  const st = new Map<string, AgentState>([...new Set(agents)].sort().map((a) => [a, initial[a] ?? 'scheduled']));
  if (st.size !== agents.length) v.push('duplicate agent ids');
  const census = (): Record<AgentState, number> => { const c = Object.fromEntries(AGENT_STATES.map((s) => [s, 0])) as Record<AgentState, number>; for (const s of st.values()) c[s]++; return c; };
  let maxLane = census().in_lane, prevT = -Infinity;
  const tr = [...transitions].map((x, i) => ({ ...x, i })).sort((a, b) => a.t - b.t || a.i - b.i);
  for (const x of tr) {
    if (!Number.isFinite(x.t)) { v.push(`non-finite time for ${x.agent}`); continue; }
    if (x.t < prevT) v.push(`time goes back at ${x.agent}`); prevT = x.t;
    const from = st.get(x.agent);
    if (from === undefined) { v.push(`unknown agent ${x.agent}`); continue; }
    if (!(AGENT_STATES as readonly string[]).includes(x.to)) { v.push(`unknown state ${x.to}`); continue; }
    if (!ALLOWED_EDGES[from].includes(x.to)) v.push(`${x.agent}@${x.t}: ${from} → ${x.to} is not an allowed edge`);
    st.set(x.agent, x.to);
    const c = census(), tot = AGENT_STATES.reduce((s, k) => s + c[k], 0);
    if (tot !== st.size) v.push(`census ${tot} != ${st.size} at ${x.t}`);
    maxLane = Math.max(maxLane, c.in_lane);
  }
  return { ok: v.length === 0, violations: v, final_census: census(), max_in_lane: maxLane, transitions: tr.length };
}
/** no teleport: |Δx| ≤ v_max·Δt + tol for consecutive samples of one agent */
export function checkNoTeleport(samples: PoseSample[], opt: { v_max_mm_s: number; tol_mm: Threshold }): { ok: boolean; worst_excess_mm: number; violations: number } {
  const tol = thr(opt.tol_mm, 'tol_mm'); let worst = -Infinity, bad = 0;
  if (!(opt.v_max_mm_s >= 0)) throw new MetricsRefused('v_max_mm_s must be ≥ 0');
  for (const [, xs] of byAgent(samples)) for (let i = 1; i < xs.length; i++) {
    const d = Math.hypot(xs[i].x_mm - xs[i - 1].x_mm, xs[i].y_mm - xs[i - 1].y_mm), ex = d - opt.v_max_mm_s * (xs[i].t - xs[i - 1].t);
    worst = Math.max(worst, ex); if (ex > tol) bad++;
  }
  return { ok: bad === 0, worst_excess_mm: worst === -Infinity ? 0 : worst, violations: bad };
}

// ---------------------------------------------------------------- 6. chunk determinism
export interface Determinism { bitwise_equal: boolean; first_difference: string | null; max_abs_numeric_diff: number; differing_values: number; structural_difference: boolean }
/** value-by-value comparison of two outputs (e.g. one horizon vs the same horizon reached in chunks) */
export function compareOutputs(a: unknown, b: unknown): Determinism {
  const out: Determinism = { bitwise_equal: true, first_difference: null, max_abs_numeric_diff: 0, differing_values: 0, structural_difference: false };
  const diff = (p: string, structural: boolean, d = 0) => { out.bitwise_equal = false; out.differing_values++; if (structural) out.structural_difference = true; out.max_abs_numeric_diff = Math.max(out.max_abs_numeric_diff, d); if (out.first_difference === null) out.first_difference = p; };
  const walk = (x: unknown, y: unknown, p: string): void => {
    if (typeof x === 'number' && typeof y === 'number') { if (!Object.is(x, y)) diff(p, !(Number.isFinite(x) && Number.isFinite(y)), Number.isFinite(x) && Number.isFinite(y) ? Math.abs(x - y) : Infinity); return; }
    if (Array.isArray(x) && Array.isArray(y)) { if (x.length !== y.length) diff(`${p}.length`, true); for (let i = 0; i < Math.min(x.length, y.length); i++) walk(x[i], y[i], `${p}[${i}]`); return; }
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x) && !Array.isArray(y)) {
      const kx = Object.keys(x).sort(), ky = Object.keys(y).sort();
      if (kx.join('\u0000') !== ky.join('\u0000')) diff(`${p}{keys}`, true);
      for (const k of kx) if (k in (y as object)) walk((x as Record<string, unknown>)[k], (y as Record<string, unknown>)[k], `${p}.${k}`);
      return;
    }
    if (x !== y) diff(p, true);
  };
  walk(a, b, '$');
  return out;
}

// ---------------------------------------------------------------- 7. turning statistics
export interface TurnDefinition { resample_ds_mm: Threshold; turn_threshold_rad: Threshold }
export interface Turning { rad_per_mm: Dist; total_rad: Dist; turns_per_150mm: Dist; path_mm: Dist; definition: string; same_measure_as_R133: false }
/** resample one path at fixed arc-length spacing ds (linear interpolation of the samples) */
export function resampleByArc(xs: PoseSample[], ds: number): { x: number; y: number }[] {
  if (!(ds > 0)) throw new MetricsRefused('resample_ds_mm must be > 0');
  const pts = xs.map((s) => ({ x: s.x_mm, y: s.y_mm })).filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y);
  if (pts.length < 2) return pts;
  const out = [pts[0]]; let need = ds, k = 1, cur = pts[0];
  while (k < pts.length) {
    const nx = pts[k], seg = Math.hypot(nx.x - cur.x, nx.y - cur.y);
    if (seg >= need) { const f = need / seg; cur = { x: cur.x + (nx.x - cur.x) * f, y: cur.y + (nx.y - cur.y) * f }; out.push(cur); need = ds; }
    else { need -= seg; cur = nx; k++; }
  }
  return out;
}
export function turningStatistics(samples: PoseSample[], def: TurnDefinition): Turning {
  const ds = thr(def.resample_ds_mm, 'resample_ds_mm'), th = thr(def.turn_threshold_rad, 'turn_threshold_rad');
  const rpm: number[] = [], tot: number[] = [], tpm: number[] = [], len: number[] = [];
  for (const [, xs] of byAgent(samples)) {
    const r = resampleByArc(xs, ds);
    if (r.length < 3) continue;
    let T = 0, n = 0;
    for (let i = 2; i < r.length; i++) {
      const h1 = Math.atan2(r[i - 1].y - r[i - 2].y, r[i - 1].x - r[i - 2].x), h2 = Math.atan2(r[i].y - r[i - 1].y, r[i].x - r[i - 1].x);
      const d = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1))); T += d; if (d > th) n++;
    }
    const L = ds * (r.length - 1);
    rpm.push(T / L); tot.push(T); tpm.push((n * 150) / L); len.push(L);
  }
  return { rad_per_mm: dist(rpm), total_rad: dist(tot), turns_per_150mm: dist(tpm), path_mm: dist(len), definition: `path resampled every ${ds} mm of arc length; heading change between consecutive chords; a turn = a change > ${th} rad; per 150 mm of resampled path`, same_measure_as_R133: false };
}

// ---------------------------------------------------------------- report bundle
export interface CandidateRunRecords {
  candidate: string; seed: number | null; family: 'simultaneous_entry_stress' | 'timed_inflow_comparison';
  agents: string[]; samples: PoseSample[]; episodes: EpisodeRec[]; gaps: GapSample[];
  arrivals: { agent: string; t: number }[]; site_events?: SiteEvent[];
  entries?: { agent: string; scheduled_t: number; entered_t: number | null }[];
  transitions?: Transition[]; initial_states?: Record<string, AgentState>;
  v_max_mm_s: number; window_s: [number, number];
}
export interface MetricOptions {
  contact_tol_mm: Threshold; penetration_tol_mm: Threshold; time_slack_s: Threshold; episode_gap_slack_mm: Threshold;
  stall_speed_mm_s: Threshold; head_on_min_deg: Threshold; same_direction_max_deg: Threshold; teleport_tol_mm: Threshold; turning: TurnDefinition;
}
export interface CandidateReport {
  candidate: string; seed: number | null; family: CandidateRunRecords['family'];
  /** #158: only timed-inflow comparisons may support (candidate-level) behavioural comparisons */
  behavioural_conclusions_allowed: boolean;
  contacts: ContactAudit; throughput: Throughput; waiting: Waiting; encounters: Omit<HeadOn, 'episodes'>;
  conservation: Conservation | null; no_teleport: ReturnType<typeof checkNoTeleport>; turning: Turning;
}
export function evaluateCandidate(r: CandidateRunRecords, o: MetricOptions): CandidateReport {
  const enc = classifyEncounters(r.episodes, r.samples, o);
  const encounters = { head_on: enc.head_on, same_direction: enc.same_direction, crossing: enc.crossing, unknown_heading: enc.unknown_heading, definition: enc.definition };
  return {
    candidate: r.candidate, seed: r.seed, family: r.family, behavioural_conclusions_allowed: r.family === 'timed_inflow_comparison',
    contacts: auditContacts(r.gaps, r.episodes, o),
    throughput: throughput(r.arrivals, r.window_s),
    waiting: waitingTimes(r.samples, o, r.site_events ?? [], r.entries ?? []),
    encounters,
    conservation: r.transitions ? checkConservation(r.agents, r.transitions, r.initial_states) : null,
    no_teleport: checkNoTeleport(r.samples, { v_max_mm_s: r.v_max_mm_s, tol_mm: o.teleport_tol_mm }),
    turning: turningStatistics(r.samples, o.turning),
  };
}
