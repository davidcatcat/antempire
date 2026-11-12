/**
 * O-R133 v1: R133-compatible turn observation operator (pre-registered in docs/kin2d-r133-observation-operator.md).
 * Reads ONLY a body-centroid trajectory {t, x_mm, y_mm} and a trail centreline polyline. Imports nothing (in particular
 * nothing from engine/ or cli/), so the observation cannot depend on model internals. The automatic turn count is a
 * PROXY for R133's human-scored "corrective actions"; it is not the same measurement.
 * All settings below are the pre-declared v1 values; changing them requires a v2 spec, never a post-hoc pick.
 */

export interface CentroidSample { t: number; x_mm: number; y_mm: number }
export interface XY { x: number; y: number }

/** pre-declared v1 settings (docs/kin2d-r133-observation-operator.md §4) */
export const V1 = {
  ds_mm: 0.5,
  dead_band_mm: 0.15,
  primary_h_mm: 1.0,
  thresholds_mm: [0.25, 0.5, 1.0, 2.5, 5.0] as const,
  merge_ds_mm: 1.0,
  fidelity_band_mm: 1.0,
  smooth_half_points: 2,
  grid_mm: 5,
  trail_mm: 150,
} as const;

export type Resolution = 'C05' | 'G5s' | 'G5q';
export type Smoothing = 'S0' | 'S1';
export type TurnClass = 'toward' | 'away' | 'on_line';
export interface TurnEvent { s_mm: number; d_mm: number; cls: TurnClass }
export interface TurnCount { toward: number; away: number; on_line: number; total: number; crossings: number; events: TurnEvent[] }
export interface Observation {
  finished: boolean; speed_mm_s: number | null; backtracks: number; undersampled: boolean; max_step_mm: number;
  mean_abs_d_mm: number; max_abs_d_mm: number; peak_amp_mm: number | null; fidelity_pct: number;
  /** turns[resolution][smoothing][h] */
  turns: Record<Resolution, Record<Smoothing, Record<string, TurnCount>>>;
}

/** local frame of a point w.r.t. a polyline: arc position s and signed lateral distance d (left of travel positive) */
export function localFrame(line: XY[], p: XY): { s: number; d: number } {
  let best = { dist: Infinity, s: 0, d: 0 }, acc = 0;
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1], dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy);
    if (L === 0) continue;
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (L * L)));
    const qx = a.x + u * dx, qy = a.y + u * dy, dist = Math.hypot(p.x - qx, p.y - qy);
    if (dist < best.dist) { const cr = dx * (p.y - a.y) - dy * (p.x - a.x); best = { dist, s: acc + u * L, d: cr >= 0 ? dist : -dist }; }
    acc += L;
  }
  return { s: best.s, d: best.d };
}

/** first-passage resampling of (s, d) at s_j = s0 + j·ds over [s0, s1]; returns d per grid point and the passage times */
export function firstPassage(pts: { t: number; s: number; d: number }[], ds: number, s0: number, s1: number): { s: number[]; d: number[]; t: number[] } {
  const S: number[] = [], D: number[] = [], T: number[] = [], n = Math.round((s1 - s0) / ds);
  let k = 0;
  for (let j = 0; j <= n; j++) {
    const target = s0 + j * ds;
    while (k < pts.length && pts[k].s < target) k++;
    if (k >= pts.length) break;
    if (k === 0) { if (pts[0].s > target + 1e-12) continue; S.push(target); D.push(pts[0].d); T.push(pts[0].t); continue; }
    const a = pts[k - 1], b = pts[k], f = b.s === a.s ? 0 : (target - a.s) / (b.s - a.s);
    S.push(target); D.push(a.d + f * (b.d - a.d)); T.push(a.t + f * (b.t - a.t));
  }
  return { s: S, d: D, t: T };
}

/** hysteresis extrema of d over s, merge rule, classification; crossings with the dead band */
export function detectTurns(s: number[], d: number[], h: number, opts: { dead_band_mm?: number; merge_ds_mm?: number } = {}): TurnCount {
  const b = opts.dead_band_mm ?? V1.dead_band_mm, mg = opts.merge_ds_mm ?? V1.merge_ds_mm;
  const ext: { s: number; d: number; kind: 'max' | 'min' }[] = [];
  if (d.length) {
    let dir = 0, hiI = 0, loI = 0;
    for (let i = 1; i < d.length; i++) {
      if (dir === 0) {
        if (d[i] > d[hiI]) hiI = i;
        if (d[i] < d[loI]) loI = i;
        // start phase: an extreme becomes an event only if the move INTO it from the start was also ≥ h (hysteresis on
        // both sides); the start point itself is never an event
        if (d[i] <= d[hiI] - h) { if (d[hiI] - d[0] >= h) ext.push({ s: s[hiI], d: d[hiI], kind: 'max' }); dir = -1; loI = i; }
        else if (d[i] >= d[loI] + h) { if (d[0] - d[loI] >= h) ext.push({ s: s[loI], d: d[loI], kind: 'min' }); dir = 1; hiI = i; }
      } else if (dir > 0) {
        if (d[i] > d[hiI]) hiI = i;
        else if (d[i] <= d[hiI] - h) { ext.push({ s: s[hiI], d: d[hiI], kind: 'max' }); dir = -1; loI = i; }
      } else {
        if (d[i] < d[loI]) loI = i;
        else if (d[i] >= d[loI] + h) { ext.push({ s: s[loI], d: d[loI], kind: 'min' }); dir = 1; hiI = i; }
      }
    }
  }
  // merge rule: two consecutive confirmed extrema closer than merge_ds along s are removed together (greedy, left to right)
  const kept: typeof ext = [];
  for (const e of ext) {
    const last = kept[kept.length - 1];
    if (last && e.s - last.s < mg) kept.pop(); else kept.push(e);
  }
  const events: TurnEvent[] = kept.map((e) => {
    let cls: TurnClass;
    if (Math.abs(e.d) <= b) cls = 'on_line';
    else if ((e.d > 0 && e.kind === 'max') || (e.d < 0 && e.kind === 'min')) cls = 'toward';
    else cls = 'away';
    return { s_mm: e.s, d_mm: e.d, cls };
  });
  let crossings = 0, side = 0;
  for (const x of d) { const sd = x > b ? 1 : x < -b ? -1 : 0; if (sd !== 0) { if (side !== 0 && sd !== side) crossings++; side = sd; } }
  const c = (k: TurnClass) => events.filter((e) => e.cls === k).length;
  return { toward: c('toward'), away: c('away'), on_line: c('on_line'), total: events.length, crossings, events };
}

export function smooth(d: number[], half: number): number[] {
  return d.map((_, i) => { let a = 0, n = 0; for (let j = Math.max(0, i - half); j <= Math.min(d.length - 1, i + half); j++) { a += d[j]; n++; } return a / n; });
}

/** observe one trajectory with every pre-declared variant */
export function observe(samples: CentroidSample[], centreline: XY[] = [{ x: 0, y: 0 }, { x: V1.trail_mm, y: 0 }]): Observation {
  const pts = samples.map((q) => ({ t: q.t, ...localFrame(centreline, { x: q.x_mm, y: q.y_mm }) }));
  let maxStep = 0, backtracks = 0, runMax = -Infinity, inBack = false;
  for (let i = 0; i < samples.length; i++) {
    if (i) maxStep = Math.max(maxStep, Math.hypot(samples[i].x_mm - samples[i - 1].x_mm, samples[i].y_mm - samples[i - 1].y_mm));
    const s = pts[i].s;
    if (s > runMax) { runMax = s; inBack = false; } else if (!inBack && runMax - s > V1.ds_mm) { backtracks++; inBack = true; }
  }
  const L = V1.trail_mm, fp = firstPassage(pts, V1.ds_mm, 0, L);
  const finished = fp.s.length === Math.round(L / V1.ds_mm) + 1;
  const speed = finished && fp.t[fp.t.length - 1] > fp.t[0] ? L / (fp.t[fp.t.length - 1] - fp.t[0]) : null;
  const absd = fp.d.map(Math.abs);
  const meanAbs = absd.length ? absd.reduce((a, x) => a + x, 0) / absd.length : 0;
  const fidelity = absd.length ? (100 * absd.filter((x) => x <= V1.fidelity_band_mm).length) / absd.length : 0;
  // grid variants: positions read at every 5 mm row (first passage), lateral continuous (G5s) or rounded to 5 mm (G5q)
  const step = Math.round(V1.grid_mm / V1.ds_mm), gi = fp.s.map((_, i) => i).filter((i) => i % step === 0);
  const series: Record<Resolution, { s: number[]; d: number[] }> = {
    C05: { s: fp.s, d: fp.d },
    G5s: { s: gi.map((i) => fp.s[i]), d: gi.map((i) => fp.d[i]) },
    G5q: { s: gi.map((i) => fp.s[i]), d: gi.map((i) => Math.sign(fp.d[i]) * V1.grid_mm * Math.round(Math.abs(fp.d[i]) / V1.grid_mm) + 0) }, // symmetric rounding
  };
  const turns = {} as Observation['turns'];
  for (const r of ['C05', 'G5s', 'G5q'] as const) {
    turns[r] = { S0: {}, S1: {} };
    for (const sm of ['S0', 'S1'] as const) {
      const dd = sm === 'S0' ? series[r].d : smooth(series[r].d, V1.smooth_half_points);
      for (const h of V1.thresholds_mm) turns[r][sm][String(h)] = detectTurns(series[r].s, dd, h);
    }
  }
  const prim = turns.C05.S0[String(V1.primary_h_mm)].events.filter((e) => e.cls === 'toward');
  return {
    finished, speed_mm_s: speed, backtracks, undersampled: maxStep > V1.ds_mm, max_step_mm: maxStep,
    mean_abs_d_mm: meanAbs, max_abs_d_mm: absd.length ? Math.max(...absd) : 0,
    peak_amp_mm: prim.length ? prim.reduce((a, e) => a + Math.abs(e.d_mm), 0) / prim.length : null,
    fidelity_pct: fidelity, turns,
  };
}
