/**
 * INDEPENDENT contact_end checker (docs/wp4-local-avoidance.md §6). Separate code: it imports nothing from engine/ —
 * its own capsule distance, its own pose lookup, its own bisection — and reads only the exported piecewise motion
 * (segments [t0, t1] of straight constant-velocity translation between two exact poses, as the playback files hold them)
 * plus the event list. For every contact episode (contact_start … contact_end / contact_end_estimated / open at the end)
 * it computes the physical separation instant t* = first time the capsule gap exceeds the contact tolerance, with an
 * explicit, verifiable bracket:
 *  - on every common piece of the two motions both bodies translate at constant velocity, so the gap (distance between two
 *    translating convex sets) is convex in time: a piece whose two end gaps are ≤ θ is ≤ θ throughout, and on the first
 *    piece whose end gap is > θ the crossing is unique and is bracketed by bisection down to floating-point resolution;
 *  - evaluation error: the computed gap may differ from the exact one by at most DELTA_G_MM (floating rounding of
 *    coordinates and of the exported vs. the solver's internal positions). The checker therefore brackets the crossing
 *    of θ− = tol − δ (lower end `lo`: exact gap ≤ tol on [t_start, lo]) and of θ+ = tol + δ (upper end `hi`: exact gap
 *    > tol at hi). The physical instant lies in [lo, hi]; err_s = hi − lo is the error bound in seconds.
 * A recorded `contact_end` must lie in [lo, hi]. A `contact_end_estimated` (a body left the road) must coincide with the
 * end of one body's presence, with no bracketed separation before it, and is reported as NOT usable as a biological cause.
 * A contact still open at the end must show no separation up to the end of the shared presence.
 */

export interface CkSegment { t0: number; t1: number; x0: number; y0: number; x1: number; y1: number; heading: number }
export interface CkAgent { id: string; segments: CkSegment[]; final: { x: number; y: number; heading: number } | null; present_from: number; present_until: number | null }
export interface CkEvent { t: number; kind: string; agents: string[]; bracket_s?: [number, number]; usable_as_cause?: boolean }
export interface CkMotion { horizon_s: number; body: { length_mm: number; width_mm: number }; agents: CkAgent[]; events: CkEvent[] }

/** evaluation tolerance of the gap (mm): 1 % of the contact tolerance; a numerical choice, documented, not tuned to a result.
 *  Measured sensitivity (docs §6): 1e-12 mm already brackets every candidate contact_end; 1e-14 mm does not (the solver's
 *  accumulated internal positions differ from the exported records by ~1e-13 mm). err_s scales with it. */
export const DELTA_G_MM = 1e-9;

export interface CkEpisode {
  pair: [string, string]; t_start: number; end_kind: 'contact_end' | 'contact_end_estimated' | 'open';
  t_end: number | null; lo: number | null; hi: number | null; err_s: number | null; inside: boolean | null;
  engine_bracket: [number, number] | null; usable_as_cause: boolean; problem: string | null;
}
export interface CkReport {
  episodes: number; exact: number; estimated: number; open: number; violations: number; problems: string[];
  max_err_s: number | null; median_err_s: number | null; max_dev_from_mid_s: number | null; tol_mm: number; delta_g_mm: number; list: CkEpisode[];
}

// ---------------------------------------------------------------- own geometry (no engine code)
function segDist(px: number, py: number, qx: number, qy: number, rx: number, ry: number, sx: number, sy: number): number {
  const ux = qx - px, uy = qy - py, vx = sx - rx, vy = sy - ry, wx = px - rx, wy = py - ry;
  const a = ux * ux + uy * uy, b = ux * vx + uy * vy, c = vx * vx + vy * vy, d = ux * wx + uy * wy, e = vx * wx + vy * wy;
  const clamp = (z: number) => (z < 0 ? 0 : z > 1 ? 1 : z);
  let s = 0, t = 0;
  if (a <= 0 && c <= 0) return Math.hypot(wx, wy);
  if (a <= 0) t = clamp(e / c);
  else if (c <= 0) s = clamp(-d / a);
  else {
    const den = a * c - b * b;
    s = den > 0 ? clamp((b * e - c * d) / den) : 0;
    t = (b * s + e) / c;
    if (t < 0) { t = 0; s = clamp(-d / a); } else if (t > 1) { t = 1; s = clamp((b - d) / a); }
  }
  return Math.hypot(wx + ux * s - vx * t, wy + uy * s - vy * t);
}

function pose(a: CkAgent, t: number): { x: number; y: number; h: number } | null {
  if (t < a.present_from || (a.present_until !== null && t > a.present_until)) return null;
  const S = a.segments;
  if (!S.length || t >= S[S.length - 1].t1) return a.final ? { x: a.final.x, y: a.final.y, h: a.final.heading } : null;
  if (t <= S[0].t0) return { x: S[0].x0, y: S[0].y0, h: S[0].heading };
  let lo = 0, hi = S.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].t0 <= t) lo = m; else hi = m - 1; }
  const g = S[lo];
  if (t >= g.t1) return { x: g.x1, y: g.y1, h: g.heading };
  const f = (t - g.t0) / (g.t1 - g.t0);
  return { x: g.x0 + (g.x1 - g.x0) * f, y: g.y0 + (g.y1 - g.y0) * f, h: g.heading };
}

export function checkContacts(m: CkMotion, dg = DELTA_G_MM): CkReport {
  const L = m.body.length_mm, w = m.body.width_mm, hw = Math.max(0, L - w) / 2, tol = 1e-7;
  const byId = new Map(m.agents.map((a) => [a.id, a]));
  const gapAt = (A: CkAgent, B: CkAgent, t: number) => {
    const p = pose(A, t), q = pose(B, t);
    if (!p || !q) return NaN;
    const ca = Math.cos(p.h) * hw, sa = Math.sin(p.h) * hw, cb = Math.cos(q.h) * hw, sb = Math.sin(q.h) * hw;
    return segDist(p.x - ca, p.y - sa, p.x + ca, p.y + sa, q.x - cb, q.y - sb, q.x + cb, q.y + sb) - w;
  };
  /** first crossing of threshold th in [from, to] on the convex pieces: {lo, hi} or null */
  const cross = (A: CkAgent, B: CkAgent, from: number, to: number, th: number): { lo: number; hi: number } | null => {
    const T = new Set([from, to]);
    for (const a of [A, B]) for (const g of a.segments) for (const t of [g.t0, g.t1]) if (t > from && t < to) T.add(t);
    const pts = [...T].sort((p, q) => p - q);
    if (gapAt(A, B, pts[0]) > th) return { lo: pts[0], hi: pts[0] };
    for (let k = 0; k + 1 < pts.length; k++) {
      const p = pts[k], q = pts[k + 1];
      if (!(gapAt(A, B, q) > th)) continue;
      let lo = p, hi = q;
      for (let n = 0; n < 2000; n++) { const mid = (lo + hi) / 2; if (mid <= lo || mid >= hi) break; if (gapAt(A, B, mid) > th) hi = mid; else lo = mid; }
      return { lo, hi };
    }
    return null;
  };
  const list: CkEpisode[] = [], problems: string[] = [];
  const open = new Map<string, number>();
  const keyOf = (ids: string[]) => [...ids].sort().join('|');
  const episode = (ids: string[], ts: number, e: CkEvent | null) => {
    const [i, j] = [...ids].sort(), A = byId.get(i)!, B = byId.get(j)!;
    const endShared = Math.min(A.present_until ?? m.horizon_s, B.present_until ?? m.horizon_s, m.horizon_s);
    const ep: CkEpisode = { pair: [i, j], t_start: ts, end_kind: e ? (e.kind as CkEpisode['end_kind']) : 'open', t_end: e ? e.t : null, lo: null, hi: null, err_s: null, inside: null, engine_bracket: e?.bracket_s ?? null, usable_as_cause: e ? e.usable_as_cause !== false : true, problem: null };
    const g0 = gapAt(A, B, ts);
    if (!(g0 <= tol + dg)) ep.problem = `gap ${g0} mm at contact_start ${ts} exceeds the tolerance`;
    if (!e) {
      const up = cross(A, B, ts, endShared, tol + dg);
      if (up) ep.problem = ep.problem ?? `open contact, but the motion separates at ≤ ${up.hi} s (bracket [${up.lo}, ${up.hi}])`;
    } else if (e.kind === 'contact_end') {
      const low = cross(A, B, ts, endShared, tol - dg), up = cross(A, B, ts, endShared, tol + dg);
      if (!low || !up) ep.problem = ep.problem ?? `contact_end at ${e.t} s, but the motion never separates (no bracket)`;
      else {
        ep.lo = low.lo; ep.hi = up.hi; ep.err_s = up.hi - low.lo; ep.inside = e.t >= low.lo && e.t <= up.hi;
        if (!ep.inside) ep.problem = ep.problem ?? `contact_end ${e.t} s outside the bracket [${low.lo}, ${up.hi}]`;
        if (e.bracket_s && !(e.bracket_s[1] === e.t && e.bracket_s[0] <= e.t && e.bracket_s[1] >= low.lo && e.bracket_s[0] <= up.hi)) ep.problem = ep.problem ?? `engine bracket [${e.bracket_s}] inconsistent with [${low.lo}, ${up.hi}]`;
      }
    } else if (e.kind === 'contact_end_estimated') {
      ep.usable_as_cause = false;
      if (e.usable_as_cause !== false) ep.problem = 'contact_end_estimated without usable_as_cause = false';
      if (!(A.present_until === e.t || B.present_until === e.t)) ep.problem = ep.problem ?? `contact_end_estimated at ${e.t} s is not the end of a body's presence`;
      const up = cross(A, B, ts, e.t, tol + dg);
      if (up && up.hi < e.t) ep.problem = ep.problem ?? `estimated end at ${e.t} s, but the motion had separated by ${up.hi} s (should be an exact contact_end)`;
    }
    if (ep.problem) problems.push(`${i}-${j}@${ts}: ${ep.problem}`);
    list.push(ep);
  };
  for (const e of m.events) {
    if (e.kind === 'contact_start') { const k = keyOf(e.agents); if (open.has(k)) problems.push(`${k}: nested contact_start at ${e.t}`); open.set(k, e.t); }
    else if (e.kind === 'contact_end' || e.kind === 'contact_end_estimated') {
      const k = keyOf(e.agents), ts = open.get(k);
      if (ts === undefined) { problems.push(`${k}: ${e.kind} at ${e.t} without a start`); continue; }
      open.delete(k); episode(e.agents, ts, e);
    }
  }
  for (const [k, ts] of open) episode(k.split('|'), ts, null);
  const errs = list.map((x) => x.err_s).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const devs = list.filter((x) => x.lo !== null && x.t_end !== null).map((x) => Math.abs(x.t_end! - (x.lo! + x.hi!) / 2));
  return {
    episodes: list.length, exact: list.filter((x) => x.end_kind === 'contact_end').length, estimated: list.filter((x) => x.end_kind === 'contact_end_estimated').length,
    open: list.filter((x) => x.end_kind === 'open').length, violations: problems.length, problems: problems.slice(0, 20),
    max_err_s: errs.length ? errs[errs.length - 1] : null, median_err_s: errs.length ? errs[(errs.length - 1) >> 1] : null,
    max_dev_from_mid_s: devs.length ? Math.max(...devs) : null, tol_mm: tol, delta_g_mm: dg, list,
  };
}

/** adapter: a local-steer result's motion records → the exported segment form (the same construction as the playback export) */
export function motionFromSamples(
  agents: Record<string, { samples: [number, number, number, number, number, number][]; present_from_t_s?: number | null; removed_t_s?: number | null }>,
  events: { t_s: number; kind: string; agents: string[]; bracket_s?: [number, number]; usable_as_cause?: boolean }[],
  body: { length_mm: number; width_mm: number }, horizon_s: number,
): CkMotion {
  const out: CkAgent[] = [];
  for (const id of Object.keys(agents).sort()) {
    const a = agents[id], S = a.samples, segs: CkSegment[] = [];
    for (let i = 0; i + 1 < S.length; i++) { const p = S[i], q = S[i + 1]; if (q[0] > p[0]) segs.push({ t0: p[0], t1: q[0], x0: p[1], y0: p[2], x1: q[1], y1: q[2], heading: p[3] }); }
    const last = S[S.length - 1];
    const from = a.present_from_t_s === undefined ? 0 : a.present_from_t_s === null ? Infinity : a.present_from_t_s;
    out.push({ id, segments: segs, final: last ? { x: last[1], y: last[2], heading: last[3] } : null, present_from: from, present_until: a.removed_t_s ?? null });
  }
  return { horizon_s, body, agents: out, events: events.map((e) => ({ t: e.t_s, kind: e.kind, agents: e.agents, bracket_s: e.bracket_s, usable_as_cause: e.usable_as_cause })) };
}
