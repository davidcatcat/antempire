/**
 * Issue #158 — traffic metrics over a generic trajectory / event format (isolated; solver-agnostic).
 *
 * Any 2D producer (WP4 local-steer, kinematics2d, PH-3b) can feed this by exporting:
 *   - samples: position records { agent, t, x_mm, y_mm } at whatever times it has (no fixed frame rate);
 *   - gaps (preferred): exact surface gaps between body pairs { t, a, b, gap_mm } (negative = penetration);
 *     if absent, gaps are approximated from disks (disk_radius_mm) at shared sample instants and flagged approximate;
 *   - site_events: the destinations ledger stream (engine/physics/destinations.ts);
 *   - cost: CPU / memory measured OUTSIDE the engine (the engine has no clock; passed through, never computed here).
 * Analysis thresholds (contact tolerance, stall speed) are observer choices, labelled assumption: true.
 * Arrival rate is reported but is NOT a selection criterion (Issue #158).
 */
import { FAMILY_SCOPE, type SiteEvent, type TrafficFamily } from './destinations.ts';

export interface TrajSample { agent: string; t: number; x_mm: number; y_mm: number }
export interface GapRecord { t: number; a: string; b: string; gap_mm: number }

export interface TrafficRun {
  family: TrafficFamily;
  candidate: string;                     // rule / solver label
  seed: number | null;
  dt_s: number | null;                   // producer's step / decision interval (time-step sensitivity)
  samples: TrajSample[];
  gaps?: GapRecord[];
  disk_radius_mm?: number;
  site_events?: SiteEvent[];
  agents_expected?: string[];            // all agents scheduled (for arrival rate denominators)
  cost?: { cpu_ms: number | null; heap_bytes: number | null };
}

export interface MetricOptions {
  contact_tol_mm: number;                // gap <= tol counts as contact
  stall_speed_mm_s: number;              // segment speed below this counts as waiting/stalled
  provenance: { assumption: true; basis: '遊戲假設'; note: string };
}

export interface Dist { n: number; mean: number | null; sd: number | null; min: number | null; p05: number | null; p50: number | null; p95: number | null; max: number | null }

export interface TrafficMetrics {
  family: TrafficFamily;
  candidate: string;
  seed: number | null;
  dt_s: number | null;
  behavioural_conclusions_allowed: boolean;
  scope_note: string;
  penetration: { count: number; max_depth_mm: number; approximate: boolean };
  min_spacing_mm: number | null;
  contact: { episodes: number; pair_time_s: number; per_agent_episodes: Dist };
  waiting: { stall_time_s: number; stall_fraction: Dist; queue_wait_s: Dist; turned_away: number };
  speed_mm_s: Dist;
  route_length_mm: Dist;
  straightness: Dist;                    // net displacement / path length per agent
  turning: { rad_per_mm: Dist; total_rad: Dist };
  individual_variation: { cv_mean_speed: number | null; cv_route_length: number | null; cv_stall_fraction: number | null };
  arrival: { arrived: number; expected: number | null; rate: number | null; not_a_selection_criterion: true };
  throughput: { admitted: number; window_s: number | null; per_s: number | null };
  cost: { cpu_ms: number | null; heap_bytes: number | null; measured_outside_engine: true };
  literature_support: typeof METRIC_EVIDENCE;
}

/** Literature support per metric (Issue #158 "文獻支持程度"). Levels: species = focal-species data (本種); other = non-species; none. */
export const METRIC_EVIDENCE = Object.freeze({
  penetration: { level: 'none', refs: [], note: 'physical constraint (bodies are impenetrable); a correctness invariant, not a biological comparison' },
  min_spacing_mm: { level: 'none', refs: [], note: 'no focal-species spacing data' },
  contact: { level: 'other', refs: ['R108', 'R380', 'R381'], note: '非本種: L. humile contact 0.18 s; L. niger / Atta time lost per contact 0.43 / 0.80 s' },
  waiting: { level: 'other', refs: ['R380', 'R381', 'R744'], note: '非本種: give-way waiting at bottlenecks; dwell in tunnels (abstract only)' },
  speed_mm_s: { level: 'species', refs: ['R133', 'R384', 'R108'], note: '本種: 17.0 mm/s on an artificial lab trail without encounters (R133); speed-density only 非本種' },
  route_length_mm: { level: 'none', refs: [], note: 'scenario geometry; no species data' },
  straightness: { level: 'species', refs: ['R133'], note: '本種: lateral deviation 1.1 / 1.7 mm on a lab trail (proxy only)' },
  turning: { level: 'species', refs: ['R133'], note: '本種: 12.8 corrective turns per 150 mm (5 mm grid resolution); no angle distribution' },
  individual_variation: { level: 'none', refs: [], note: 'no per-individual traffic data for the species' },
  arrival: { level: 'none', refs: [], note: 'outcome of the scenario; not a selection criterion' },
  throughput: { level: 'other', refs: ['R108', 'R382', 'R384', 'R386'], note: '非本種: flow plateaus without jamming (L. humile ~10 ants/cm/s); flow-density (Atta, Leptogenys)' },
  timestep_sensitivity: { level: 'none', refs: [], note: 'numerical property of the producer' },
  cost: { level: 'none', refs: [], note: 'computational, measured outside the engine' },
} as const);

const strCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export const dist = (xs: number[]): Dist => {
  const v = xs.filter(Number.isFinite).sort((a, b) => a - b);
  const n = v.length;
  if (n === 0) return { n, mean: null, sd: null, min: null, p05: null, p50: null, p95: null, max: null };
  // fixed-order summation (sorted ascending) so the result does not depend on input order
  const mean = v.reduce((s, x) => s + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(v.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const q = (p: number) => v[Math.min(n - 1, Math.max(0, Math.ceil(p * n) - 1))];   // nearest rank
  return { n, mean, sd, min: v[0], p05: q(0.05), p50: q(0.5), p95: q(0.95), max: v[n - 1] };
};
const cv = (xs: number[]): number | null => { const d = dist(xs); return d.n > 1 && d.mean ? d.sd! / Math.abs(d.mean) : null; };
const sum = (xs: number[]): number => [...xs].sort((a, b) => a - b).reduce((s, x) => s + x, 0);

const byAgent = (samples: TrajSample[]): Map<string, TrajSample[]> => {
  const m = new Map<string, TrajSample[]>();
  for (const s of samples) {
    if (![s.t, s.x_mm, s.y_mm].every(Number.isFinite)) throw new Error(`non-finite sample for ${s.agent}`);
    (m.get(s.agent) ?? m.set(s.agent, []).get(s.agent)!).push(s);
  }
  for (const [a, xs] of m) {
    xs.sort((p, q) => p.t - q.t);
    for (let i = 1; i < xs.length; i++) if (xs[i].t === xs[i - 1].t) throw new Error(`agent ${a} has two samples at t=${xs[i].t} (an agent cannot be in two places)`);
  }
  return new Map([...m].sort((x, y) => strCmp(x[0], y[0])));
};

/** Disk-approximation gaps at shared sample instants (only when the producer gives no exact gaps). */
export const diskGaps = (samples: TrajSample[], r_mm: number): GapRecord[] => {
  const atT = new Map<number, TrajSample[]>();
  for (const s of samples) (atT.get(s.t) ?? atT.set(s.t, []).get(s.t)!).push(s);
  const out: GapRecord[] = [];
  for (const t of [...atT.keys()].sort((a, b) => a - b)) {
    const xs = atT.get(t)!.sort((p, q) => strCmp(p.agent, q.agent));
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++)
      out.push({ t, a: xs[i].agent, b: xs[j].agent, gap_mm: Math.hypot(xs[i].x_mm - xs[j].x_mm, xs[i].y_mm - xs[j].y_mm) - 2 * r_mm });
  }
  return out;
};

const wrap = (a: number): number => { let x = a; while (x > Math.PI) x -= 2 * Math.PI; while (x <= -Math.PI) x += 2 * Math.PI; return x; };

export const computeTrafficMetrics = (run: TrafficRun, opt: MetricOptions): TrafficMetrics => {
  if (opt.provenance?.assumption !== true) throw new Error('metric thresholds must be labelled assumption: true');
  const agents = byAgent(run.samples);
  // ---- gaps: penetration, spacing, contact
  const approximate = !run.gaps;
  const gaps = run.gaps ?? (run.disk_radius_mm !== undefined ? diskGaps(run.samples, run.disk_radius_mm) : []);
  const pairKey = (g: GapRecord) => (g.a < g.b ? `${g.a}\u0000${g.b}` : `${g.b}\u0000${g.a}`);
  let pen = 0, depth = 0, minGap: number | null = null;
  const pairs = new Map<string, GapRecord[]>();
  for (const g of gaps) {
    if (!Number.isFinite(g.gap_mm)) throw new Error('non-finite gap');
    if (g.gap_mm < 0) { pen++; depth = Math.max(depth, -g.gap_mm); }
    minGap = minGap === null ? g.gap_mm : Math.min(minGap, g.gap_mm);
    const k = pairKey(g); (pairs.get(k) ?? pairs.set(k, []).get(k)!).push(g);
  }
  let episodes = 0; const pairTimes: number[] = [];
  const agentEpisodes = new Map<string, number>([...agents.keys()].map((a) => [a, 0]));
  for (const [k, gs] of [...pairs].sort((x, y) => strCmp(x[0], y[0]))) {
    gs.sort((p, q) => p.t - q.t);
    let inC = false;
    for (let i = 0; i < gs.length; i++) {
      const c = gs[i].gap_mm <= opt.contact_tol_mm;
      if (c && !inC) { episodes++; for (const a of k.split('\u0000')) agentEpisodes.set(a, (agentEpisodes.get(a) ?? 0) + 1); }
      if (c && i + 1 < gs.length) pairTimes.push(gs[i + 1].t - gs[i].t);   // left-rectangle contact time
      inC = c;
    }
  }
  // ---- per-agent kinematics
  const speeds: number[] = [], lengths: number[] = [], straight: number[] = [], radPerMm: number[] = [], totRad: number[] = [];
  const meanSpeed: number[] = [], stallFrac: number[] = []; const stallTimes: number[] = [];
  for (const [, xs] of agents) {
    let L = 0, T = 0, stall = 0, turn = 0, prevH: number | null = null;
    for (let i = 1; i < xs.length; i++) {
      const dt = xs[i].t - xs[i - 1].t, dx = xs[i].x_mm - xs[i - 1].x_mm, dy = xs[i].y_mm - xs[i - 1].y_mm, d = Math.hypot(dx, dy);
      const v = d / dt; speeds.push(v); L += d; T += dt;
      if (v < opt.stall_speed_mm_s) stall += dt;
      if (d > 0) { const h = Math.atan2(dy, dx); if (prevH !== null) turn += Math.abs(wrap(h - prevH)); prevH = h; }
    }
    if (xs.length < 2) continue;
    lengths.push(L);
    const net = Math.hypot(xs[xs.length - 1].x_mm - xs[0].x_mm, xs[xs.length - 1].y_mm - xs[0].y_mm);
    if (L > 0) { straight.push(net / L); radPerMm.push(turn / L); }
    totRad.push(turn);
    if (T > 0) { meanSpeed.push(L / T); stallFrac.push(stall / T); }
    stallTimes.push(stall);
  }
  // ---- site events: queue wait, turned away, arrivals, throughput
  const ev = run.site_events ?? [];
  const queuedAt = new Map<string, number>(); const waits: number[] = [];
  const arrived = new Set<string>(); let admitted = 0, turned = 0;
  let tMin: number | null = null, tMax: number | null = null;
  for (const e of ev) {
    if (e.kind === 'arrive') arrived.add(e.agent);
    if (e.kind === 'queue') queuedAt.set(`${e.agent}|${e.site}`, e.t);
    if (e.kind === 'admit') {
      admitted++; const k = `${e.agent}|${e.site}`;
      waits.push(queuedAt.has(k) ? e.t - queuedAt.get(k)! : 0); queuedAt.delete(k);
      tMin = tMin === null ? e.t : Math.min(tMin, e.t); tMax = tMax === null ? e.t : Math.max(tMax, e.t);
    }
    if (e.kind === 'turn_away') turned++;
  }
  const expected = run.agents_expected ? new Set(run.agents_expected).size : null;
  const span = tMin !== null && tMax !== null && tMax > tMin ? tMax - tMin : null;
  const scope = FAMILY_SCOPE[run.family];
  return {
    family: run.family, candidate: run.candidate, seed: run.seed, dt_s: run.dt_s,
    behavioural_conclusions_allowed: scope.behavioural_conclusions_allowed, scope_note: scope.why,
    penetration: { count: pen, max_depth_mm: depth, approximate },
    min_spacing_mm: minGap,
    contact: { episodes, pair_time_s: sum(pairTimes), per_agent_episodes: dist([...agentEpisodes.values()]) },
    waiting: { stall_time_s: sum(stallTimes), stall_fraction: dist(stallFrac), queue_wait_s: dist(waits), turned_away: turned },
    speed_mm_s: dist(speeds),
    route_length_mm: dist(lengths),
    straightness: dist(straight),
    turning: { rad_per_mm: dist(radPerMm), total_rad: dist(totRad) },
    individual_variation: { cv_mean_speed: cv(meanSpeed), cv_route_length: cv(lengths), cv_stall_fraction: cv(stallFrac) },
    arrival: { arrived: arrived.size, expected, rate: expected ? arrived.size / expected : null, not_a_selection_criterion: true },
    throughput: { admitted, window_s: span, per_s: span ? admitted / span : null },
    cost: { cpu_ms: run.cost?.cpu_ms ?? null, heap_bytes: run.cost?.heap_bytes ?? null, measured_outside_engine: true },
    literature_support: METRIC_EVIDENCE,
  };
};

/** Scalar metrics compared across time steps. */
export const SENSITIVITY_KEYS = ['penetration.count', 'min_spacing_mm', 'contact.episodes', 'waiting.stall_time_s', 'speed_mm_s.mean', 'route_length_mm.mean', 'turning.rad_per_mm.mean', 'arrival.arrived'] as const;

const pick = (m: TrafficMetrics, key: string): number | null => {
  let o: unknown = m; for (const k of key.split('.')) o = (o as Record<string, unknown> | null)?.[k];
  return typeof o === 'number' && Number.isFinite(o) ? o : null;
};

/**
 * Time-step sensitivity: same scenario, candidate and seed at several dt_s. For each key: values by dt and the
 * relative spread (max − min) / max(|values|) (null when undefined). Refuses mixed scenarios.
 */
export const timeStepSensitivity = (runs: TrafficMetrics[]): { dts: number[]; keys: Record<string, { values: (number | null)[]; rel_spread: number | null }> } => {
  if (runs.length < 2) throw new Error('time-step sensitivity needs at least two runs');
  const sig = (m: TrafficMetrics) => `${m.family}|${m.candidate}|${m.seed}`;
  if (new Set(runs.map(sig)).size !== 1) throw new Error('time-step sensitivity: runs must share family, candidate and seed');
  if (runs.some((m) => m.dt_s === null) || new Set(runs.map((m) => m.dt_s)).size !== runs.length) throw new Error('time-step sensitivity: each run needs a distinct dt_s');
  const sorted = [...runs].sort((a, b) => a.dt_s! - b.dt_s!);
  const keys: Record<string, { values: (number | null)[]; rel_spread: number | null }> = {};
  for (const k of SENSITIVITY_KEYS) {
    const values = sorted.map((m) => pick(m, k));
    const v = values.filter((x): x is number => x !== null);
    const scale = Math.max(...v.map(Math.abs));
    keys[k] = { values, rel_spread: v.length === values.length && v.length > 0 ? (scale === 0 ? 0 : (Math.max(...v) - Math.min(...v)) / scale) : null };
  }
  return { dts: sorted.map((m) => m.dt_s!), keys };
};
