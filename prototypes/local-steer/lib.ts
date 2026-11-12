/**
 * WP4 local-steer runner library (docs/wp4-local-avoidance.md). ISOLATED: not imported by the day loop, cli/ or web/.
 * Builds the steering input from a solver-compare scenario (same loader and PH-3b input as the baseline), loads the
 * candidate parameters (steer-candidates.json; every value assumption: true), converts results to the common trajectory
 * format (so the SAME judge grades them) and provides an independent sample-based non-penetration verifier that is cheap
 * enough for 1000 agents.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { steer2D, type SteerInput, type SteerParams, type SteerPolicyId, type SteerResult } from '../../engine/physics/local-steer.ts';
import { capsuleGap, laneBoundary, OCC_TOL_MM, type Capsule } from '../../engine/physics/body2d.ts';
import { gridPairs2D, type AABB } from '../../engine/physics/broadphase.ts';
import { ph3bInput } from '../solver-compare/lib/ph3b.ts';
import type { Scenario } from '../solver-compare/lib/spec.ts';
import type { Trajectory } from '../solver-compare/lib/traj.ts';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CANDIDATE_LABEL = '隔離物理實驗・候選行為規則（非本種/假設）・非正式';
export const POLICY_LABEL: Record<SteerPolicyId, string> = {
  none: 'none：PH-3b 原樣（u 固定、沒有決策）',
  A_free_direction: 'A：選擇可通行方向（候選，假設）',
  B_contact_decision: 'B：接觸後等／退／繞（候選，假設）',
  C_sidestep: 'C：有空間就側移錯身（候選，假設）',
  N_no_yield: 'N：不讓路對照（永遠直走、碰到就停；對照，非候選）',
};

/** what the dense crossing benchmark (crossing-traffic-100 / -1000) is and is NOT valid for (docs §4.1); shown on the page */
export const DENSE_BENCHMARK_SCOPE = '適用範圍（密集基準，非生物情境）：格狀密集起點（橫向 1.2 mm、縱向 3.0 mm，四個方向同時湧向交叉口）、抵達者永久留在路上當障礙物、身體只平移不轉向。只適用於：CPU 成本、高密度下 0 穿透與事件時刻的驗證、找出結構性互卡。不適用於：推論交通流量、抵達率、清空時間或任何候選規則的生物合理性；1000 隻 0/1000 抵達是情境設計（沒有出口、密集起點）的結果，不是生物學結論。對照情境（有限容量出口、依時間流入、不讓路對照 N）見 docs/wp4-local-avoidance.md §5b。';
export const isDenseBenchmark = (scenarioId: string) => /^crossing-traffic-/.test(scenarioId);

interface CandEntry { value: unknown; assumption: boolean; basis: string; why: string; from_scenario?: string }
export interface Candidates { schema: string; status: string; params: Record<keyof SteerParams, CandEntry>; conventions: string[] }
export const loadCandidates = (): Candidates => JSON.parse(fs.readFileSync(path.join(HERE, 'steer-candidates.json'), 'utf8'));

/** parameters for a scenario: values from the candidate file; the sensing radius from the scenario's contact reach */
export function steerParams(sc: Scenario, over: Partial<SteerParams> = {}): { params: SteerParams; provenance: Record<string, string> } {
  const c = loadCandidates(), params = {} as Record<string, unknown>, provenance: Record<string, string> = {};
  for (const [k, e] of Object.entries(c.params)) {
    if (!e.assumption) throw Error(`steer-candidates: ${k} must be labelled assumption: true`);
    if (e.from_scenario === 'body.contact_reach_mm') { params[k] = sc.body.contact_reach_mm.value; provenance[k] = `${sc.body.contact_reach_mm.value} mm ← ${sc.body.contact_reach_mm.source} [${sc.body.contact_reach_mm.basis}]；${e.why}`; }
    else { params[k] = e.value; provenance[k] = `${JSON.stringify(e.value)} [${e.basis}] ${e.why}`; }
  }
  for (const [k, v] of Object.entries(over)) { params[k] = v; provenance[k] = `${JSON.stringify(v)} [敏感度覆寫，遊戲假設]`; }
  return { params: params as unknown as SteerParams, provenance };
}

export interface RunOpts { order?: 'canonical' | 'reversed' | 'shuffled'; seed?: number; over?: Partial<SteerParams> }
export function steerInput(sc: Scenario, policy: SteerPolicyId, o: RunOpts = {}): SteerInput {
  const base = ph3bInput(sc);
  let agents = base.agents;
  if (o.order === 'reversed') agents = [...agents].reverse();
  if (o.order === 'shuffled') { agents = [...agents]; let x = 0x9e3779b9; for (let i = agents.length - 1; i > 0; i--) { x = (Math.imul(x ^ (x >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; const j = x % (i + 1); [agents[i], agents[j]] = [agents[j], agents[i]]; } }
  return { ...base, agents, policy, params: steerParams(sc, o.over).params, seed: o.seed ?? sc.seed };
}
export function runSteer(sc: Scenario, policy: SteerPolicyId, o: RunOpts = {}) {
  const input = steerInput(sc, policy, o);
  const c0 = process.cpuUsage(), w0 = performance.now();
  const res = steer2D(input);
  const wall_ms = performance.now() - w0, cpu = process.cpuUsage(c0);
  return { res, cost: { wall_ms, cpu_ms: (cpu.user + cpu.system) / 1000 } };
}

export function toTrajectory(sc: Scenario, res: SteerResult): Trajectory {
  const agents: Trajectory['agents'] = {};
  for (const id of Object.keys(res.agents).sort()) { const a = res.agents[id]; agents[id] = { lane: a.lane, layer: a.layer, samples: a.samples, arrival_t_s: a.arrival_t_s, final_mode: a.final_mode }; }
  return {
    solver: 'ph3b', scenario: sc.id, lateral_dof: true,
    notes: [`WP4 local-steer policy ${res.policy} (engine/physics/local-steer.ts); ${res.policy === 'none' ? 'PH-3b unchanged' : 'candidate behaviour rules, assumption'}`],
    agents, events: res.events.map((e) => ({ t_s: e.t_s, kind: e.kind, agents: e.agents, class: e.class, source: `local-steer ${res.policy}`, detail: e.detail })),
  };
}
export const runHash = (res: SteerResult) => createHash('sha256').update(JSON.stringify({ a: Object.keys(res.agents).sort().map((id) => [id, res.agents[id]]), e: res.events })).digest('hex').slice(0, 16);

/**
 * Independent verifier from the OUTPUT samples only (not the solver's internals): between two consecutive sample times
 * of an agent its centre translates at constant velocity and its heading is constant, so on every common sub-piece of
 * two agents (or an agent and a static piece) the gap is convex in time; its minimum is located by ternary search,
 * skipped when the Lipschitz lower bound (g0 + g1 − relative displacement)/2 cannot beat the running minimum and cannot
 * cross −OCC_TOL_MM. Statics: the lane's SIDE edges (end edges are not walls in PH-3b) and the obstacles on the layer.
 * Pairs by a uniform grid over per-window motion boxes (numerical; complete because each box covers the window's motion).
 * Control runs: an agent is checked only while it is on the road ([present_from_t_s, removed_t_s]; never entered = absent).
 */
export function verify(sc: Scenario, res: SteerResult, window_s = 0.25) {
  const L = sc.body.length_mm.value, w = sc.body.width_mm.value, r = w / 2, hw = Math.max(0, L - w) / 2, H = sc.horizon_s;
  const ids = Object.keys(res.agents).sort(), S = ids.map((id) => res.agents[id].samples);
  const PF = ids.map((id) => { const a = res.agents[id]; return a.present_from_t_s === undefined ? 0 : a.present_from_t_s === null || !a.samples.length ? Infinity : a.present_from_t_s; });
  const PU = ids.map((id) => res.agents[id].removed_t_s ?? H);
  const cap = (x: number, y: number, h: number): Capsule => ({ a: { x: x - Math.cos(h) * hw, y: y - Math.sin(h) * hw }, b: { x: x + Math.cos(h) * hw, y: y + Math.sin(h) * hw }, r });
  const at = (k: number, t: number) => {                      // pose at t (the later record at a shared time)
    const s = S[k]; let lo = 0, hi = s.length - 1;
    if (t <= s[0][0]) return s[0]; if (t >= s[hi][0]) return s[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (s[m][0] <= t) lo = m; else hi = m; }
    const p = s[lo], q = s[hi], f = (t - p[0]) / (q[0] - p[0]);
    return [t, p[1] + (q[1] - p[1]) * f, p[2] + (q[2] - p[2]) * f, p[3], 0, 0] as const;
  };
  const statics = new Map<string, Capsule[]>();
  for (const l of sc.lanes) {
    const lane2 = { id: l.passage.id, centerline_mm: l.passage.centerline_mm.map(([x, y]) => ({ x, y })), width_mm: l.passage.width_mm };
    const list: Capsule[] = laneBoundary(lane2).filter((b) => b.kind === 'seg' && !b.end).map((b) => { const g = b as { p: { x: number; y: number }; q: { x: number; y: number } }; return { a: g.p, b: g.q, r: 0 }; });
    for (const o of sc.obstacles) if (o.shape.type === 'circle') list.push({ a: { x: o.shape.center_mm[0], y: o.shape.center_mm[1] }, b: { x: o.shape.center_mm[0], y: o.shape.center_mm[1] }, r: o.shape.radius_mm }); else { const P = o.shape.points_mm; for (let i = 0; i < P.length; i++) list.push({ a: { x: P[i][0], y: P[i][1] }, b: { x: P[(i + 1) % P.length][0], y: P[(i + 1) % P.length][1] }, r: 0 }); }
    statics.set(l.passage.id, list);
  }
  const out = { min_pair_gap_mm: Infinity, pair_penetrations: 0, max_pair_penetration_mm: 0, min_static_gap_mm: Infinity, static_penetrations: 0, max_static_penetration_mm: 0, pieces: 0, ternary_searches: 0, tol_mm: OCC_TOL_MM };
  const minOver = (g: (t: number) => number, t0: number, t1: number, g0: number, g1: number, rel: number, thr: number) => {
    let m = Math.min(g0, g1);
    if (t1 > t0 && (g0 + g1 - rel) / 2 < Math.min(thr, m)) {
      out.ternary_searches++;
      let lo = t0, hi = t1; for (let i = 0; i < 100 && hi - lo > 1e-15 * Math.max(1, hi); i++) { const a = lo + (hi - lo) / 3, b = hi - (hi - lo) / 3; if (g(a) <= g(b)) hi = b; else lo = a; }
      m = Math.min(m, g((lo + hi) / 2));
    }
    return m;
  };
  for (let wk = 0; wk * window_s < H; wk++) {
    const ws = wk * window_s, we = Math.min(H, (wk + 1) * window_s);
    const times = ids.map((_, k) => { const a = Math.max(ws, PF[k]), b = Math.min(we, PU[k]); if (!(a <= b)) return [] as number[]; const T = new Set([a, b]); for (const s of S[k]) if (s[0] > a && s[0] < b) T.add(s[0]); return [...T].sort((p, q) => p - q); });
    const boxes: AABB[] = ids.map((_, k) => { if (!times[k].length) return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const t of times[k]) { const p = at(k, t); x0 = Math.min(x0, p[1]); y0 = Math.min(y0, p[2]); x1 = Math.max(x1, p[1]); y1 = Math.max(y1, p[2]); } const m = L / 2 + 1e-6; return { minX: x0 - m, minY: y0 - m, maxX: x1 + m, maxY: y1 + m }; });
    // statics, per agent
    for (let k = 0; k < ids.length; k++) {
      const st = statics.get(res.agents[ids[k]].lane) ?? [], T = times[k];
      for (let q = 0; q + 1 < T.length; q++) {
        const p0 = at(k, T[q]), p1 = at(k, T[q + 1]), c0 = cap(p0[1], p0[2], p0[3]), c1 = cap(p1[1], p1[2], p0[3]), dx = p1[1] - p0[1], dy = p1[2] - p0[2], d = Math.hypot(dx, dy), span = T[q + 1] - T[q];
        for (const c of st) {
          out.pieces++;
          const g = (t: number) => { const f = (t - T[q]) / span; return capsuleGap({ a: { x: c0.a.x + dx * f, y: c0.a.y + dy * f }, b: { x: c0.b.x + dx * f, y: c0.b.y + dy * f }, r }, c); };
          const m = minOver(g, T[q], T[q + 1], capsuleGap(c0, c), capsuleGap(c1, c), d, out.min_static_gap_mm);
          if (m < out.min_static_gap_mm) out.min_static_gap_mm = m;
          if (m < -OCC_TOL_MM) { out.static_penetrations++; out.max_static_penetration_mm = Math.max(out.max_static_penetration_mm, -m); }
        }
      }
    }
    // pairs (same layer)
    const keys = ids.map((id) => sc.lanes.findIndex((l) => l.layer === res.agents[id].layer));
    for (const key of gridPairs2D(boxes, keys, 8)) {
      const i = Math.floor(key / ids.length), j = key % ids.length;
      if (!times[i].length || !times[j].length) continue;
      const lo = Math.max(times[i][0], times[j][0]), hi = Math.min(times[i].at(-1)!, times[j].at(-1)!);
      if (!(lo <= hi)) continue;
      const T = [...new Set([lo, hi, ...times[i], ...times[j]])].filter((t) => t >= lo && t <= hi).sort((a, b) => a - b);
      for (let q = 0; q + 1 < T.length; q++) {
        out.pieces++;
        const ta = T[q], tb = T[q + 1], span = tb - ta;
        const pi0 = at(i, ta), pi1 = at(i, tb), pj0 = at(j, ta), pj1 = at(j, tb);
        const ci = cap(pi0[1], pi0[2], pi0[3]), cj = cap(pj0[1], pj0[2], pj0[3]);
        const vi = { x: pi1[1] - pi0[1], y: pi1[2] - pi0[2] }, vj = { x: pj1[1] - pj0[1], y: pj1[2] - pj0[2] };
        const sh = (c: Capsule, v: { x: number; y: number }, f: number): Capsule => ({ a: { x: c.a.x + v.x * f, y: c.a.y + v.y * f }, b: { x: c.b.x + v.x * f, y: c.b.y + v.y * f }, r: c.r });
        const g = (t: number) => { const f = (t - ta) / span; return capsuleGap(sh(ci, vi, f), sh(cj, vj, f)); };
        const m = minOver(g, ta, tb, capsuleGap(ci, cj), capsuleGap(sh(ci, vi, 1), sh(cj, vj, 1)), Math.hypot(vj.x - vi.x, vj.y - vi.y), out.min_pair_gap_mm);
        if (m < out.min_pair_gap_mm) out.min_pair_gap_mm = m;
        if (m < -OCC_TOL_MM) { out.pair_penetrations++; out.max_pair_penetration_mm = Math.max(out.max_pair_penetration_mm, -m); }
      }
    }
  }
  return out;
}

/** stalled agents that perceive (gap ≤ radius) another stalled agent at the horizon form deadlock clusters */
export function deadlockClusters(sc: Scenario, res: SteerResult, radius: number) {
  const L = sc.body.length_mm.value, w = sc.body.width_mm.value, hw = Math.max(0, L - w) / 2;
  const ids = Object.keys(res.agents).sort().filter((id) => /stalled|stopped|halted|waiting_at_joint/.test(res.agents[id].final_mode));
  const caps = ids.map((id) => { const s = res.agents[id].samples.at(-1)!; return { a: { x: s[1] - Math.cos(s[3]) * hw, y: s[2] - Math.sin(s[3]) * hw }, b: { x: s[1] + Math.cos(s[3]) * hw, y: s[2] + Math.sin(s[3]) * hw }, r: w / 2 }; });
  const par = ids.map((_, i) => i), find = (x: number): number => (par[x] === x ? x : (par[x] = find(par[x])));
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) if (Math.abs(caps[i].a.x - caps[j].a.x) < L + radius + 1 && Math.abs(caps[i].a.y - caps[j].a.y) < L + radius + 1 && capsuleGap(caps[i], caps[j]) <= radius) par[find(i)] = find(j);
  const sizes = new Map<number, number>(); for (let i = 0; i < ids.length; i++) sizes.set(find(i), (sizes.get(find(i)) ?? 0) + 1);
  const cl = [...sizes.values()].filter((n) => n >= 2).sort((a, b) => b - a);
  return { stalled: ids.length, clusters: cl.length, agents_in_clusters: cl.reduce((a, b) => a + b, 0), largest: cl[0] ?? 0 };
}
