/**
 * INDEPENDENT contact-episode checker (docs/physics-time-contract.md §3, docs/physics-ph3b-solver2d.md §2.6).
 *
 * Separate code: it imports NOTHING from engine/ or from any solver — its own capsule distance, its own pose lookup, its
 * own bisection and its own copy of the contract numbers. It reads only exported piecewise motion (per agent: segments
 * [t0, t1] of straight constant-velocity translation between two exact poses, the form of the playback files) and the
 * event list, so any solver (PH-3b, WP4 local-steer, …) can be checked with it.
 *
 * Contract definitions (θ = contact tolerance, ρ = separation resolution; both are part of the contract, not tuned):
 *  - a pair is in contact while its capsule gap g ≤ θ;
 *  - contact_end  = the last up-crossing of θ before g first exceeds θ + ρ (an excursion above θ that returns to ≤ θ
 *    before reaching θ + ρ is below the resolution and is not a separation);
 *  - contact_start = the last down-crossing of θ before g first reaches θ − ρ.
 * The checker computes, for every recorded event, a verifiable bracket under a stated evaluation error ε of its own gap
 * (rounding of coordinates and of the exported vs. the solver's internal positions): on each common piece of the two
 * motions both bodies translate, so g is convex in time and every threshold crossing on a piece is unique and found by
 * bisection; a piece whose end values lie on one side of a threshold and whose minimum (golden section) does too never
 * crosses it. For an end: c = first time g > θ + ρ − ε (no confirmed separation can be earlier), lo = last time ≤ c with
 * g ≤ θ − ε, hi = the instant after the last time ≤ c with g ≤ θ + ε; the exact end lies in [lo, hi]. Starts symmetric.
 * It also searches for MISSED episodes (g ≤ θ − ρ − ε outside every recorded episode), for open contacts that did
 * separate (g > θ + ρ + ε) and for penetration (g < −occ), and checks the motion records themselves (no teleport, path
 * length = ∫ speed dt, chronological events).
 */

/** contract numbers (mm). Copied, not imported: the checker must not share code or constants with a solver. */
export const CONTRACT = { tol_mm: 1e-7, resolution_mm: 1e-9, eval_err_mm: 1e-11, occ_tol_mm: 1e-9 } as const;
/** evaluation tolerance of the gap (kept for the WP4 API) */
export const DELTA_G_MM = CONTRACT.eval_err_mm;

export interface CkSegment { t0: number; t1: number; x0: number; y0: number; x1: number; y1: number; heading: number; speed_mm_s?: number; s0?: number; s1?: number }
export interface CkAgent { id: string; segments: CkSegment[]; final: { x: number; y: number; heading: number } | null; present_from: number; present_until: number | null; layer?: string; body?: { length_mm: number; width_mm: number } }
export interface CkEvent { t: number; kind: string; agents: string[]; bracket_s?: [number, number]; err_s?: number; confirmed_t_s?: number; usable_as_cause?: boolean }
export interface CkMotion { horizon_s: number; body: { length_mm: number; width_mm: number }; agents: CkAgent[]; events: CkEvent[] }
export interface CkOptions { tol_mm?: number; resolution_mm?: number; eval_err_mm?: number; occ_tol_mm?: number; scan_missed?: boolean }

export interface CkEpisode {
  pair: [string, string]; t_start: number; end_kind: 'contact_end' | 'contact_end_estimated' | 'contact_end_unconfirmed' | 'open';
  t_end: number | null; start_lo: number | null; start_hi: number | null; lo: number | null; hi: number | null; err_s: number | null;
  inside: boolean | null; engine_bracket: [number, number] | null; engine_err_s: number | null; usable_as_cause: boolean; problem: string | null;
}
export interface CkReport {
  episodes: number; exact: number; estimated: number; unconfirmed: number; open: number; violations: number; problems: string[];
  max_err_s: number | null; median_err_s: number | null; max_start_err_s: number | null; max_dev_from_mid_s: number | null;
  missed: number; penetrations: number; pairs_scanned: number;
  tol_mm: number; resolution_mm: number; delta_g_mm: number; list: CkEpisode[];
}

// ---------------------------------------------------------------- own geometry
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

/** one piece of an agent's motion: constant velocity on [t0, t1] (t0 = −∞ / t1 = +∞ for the held start / end) */
interface Piece { t0: number; t1: number; x0: number; y0: number; x1: number; y1: number; h: number; hw: number; r: number }
const posOf = (g: Piece, t: number): [number, number] => {
  if (!(g.t1 > g.t0) || !Number.isFinite(g.t0) || !Number.isFinite(g.t1)) return Number.isFinite(g.t0) ? [g.x0, g.y0] : [g.x1, g.y1];
  if (t >= g.t1) return [g.x1, g.y1];
  if (t <= g.t0) return [g.x0, g.y0];
  const f = (t - g.t0) / (g.t1 - g.t0);
  return [g.x0 + (g.x1 - g.x0) * f, g.y0 + (g.y1 - g.y0) * f];
};
function piecesOf(a: CkAgent, body: { length_mm: number; width_mm: number }): Piece[] {
  const B = a.body ?? body, hw = Math.max(0, B.length_mm - B.width_mm) / 2, r = B.width_mm / 2, S = a.segments, out: Piece[] = [];
  if (!S.length) { const f = a.final!; return [{ t0: -Infinity, t1: Infinity, x0: f.x, y0: f.y, x1: f.x, y1: f.y, h: f.heading, hw, r }]; }
  out.push({ t0: -Infinity, t1: S[0].t0, x0: S[0].x0, y0: S[0].y0, x1: S[0].x0, y1: S[0].y0, h: S[0].heading, hw, r });
  for (let k = 0; k < S.length; k++) {
    const g = S[k];
    if (k > 0 && S[k - 1].t1 < g.t0) { const p = S[k - 1]; out.push({ t0: p.t1, t1: g.t0, x0: p.x1, y0: p.y1, x1: p.x1, y1: p.y1, h: p.heading, hw, r }); }
    out.push({ t0: g.t0, t1: g.t1, x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1, h: g.heading, hw, r });
  }
  const last = S[S.length - 1], f = a.final ?? { x: last.x1, y: last.y1, heading: last.heading };
  out.push({ t0: last.t1, t1: Infinity, x0: f.x, y0: f.y, x1: f.x, y1: f.y, h: f.heading, hw, r });
  return out;
}

/** a common interval [p, q] of two motions with the piece of each that holds it (values at p and q are its limits) */
interface Iv { p: number; q: number; A: Piece; B: Piece }
function commonIntervals(PA: Piece[], PB: Piece[], from: number, to: number): Iv[] {
  const out: Iv[] = [];
  let i = 0, j = 0;
  while (i < PA.length && PA[i].t1 <= from && PA[i].t1 < Infinity) i++;
  while (j < PB.length && PB[j].t1 <= from && PB[j].t1 < Infinity) j++;
  let p = from;
  while (i < PA.length && j < PB.length && p < to) {
    const q = Math.min(PA[i].t1, PB[j].t1, to);
    if (q > p) out.push({ p, q, A: PA[i], B: PB[j] });
    else if (q === p && p === from && out.length === 0) out.push({ p, q: p, A: PA[i], B: PB[j] });
    p = Math.max(p, q);
    if (PA[i].t1 <= p) i++;
    if (PB[j].t1 <= p) j++;
  }
  if (!out.length && i < PA.length && j < PB.length) out.push({ p: from, q: from, A: PA[i], B: PB[j] });
  return out;
}
function gapIv(iv: Iv, t: number): number {
  const [ax, ay] = posOf(iv.A, t), [bx, by] = posOf(iv.B, t);
  const ca = Math.cos(iv.A.h) * iv.A.hw, sa = Math.sin(iv.A.h) * iv.A.hw, cb = Math.cos(iv.B.h) * iv.B.hw, sb = Math.sin(iv.B.h) * iv.B.hw;
  return segDist(ax - ca, ay - sa, ax + ca, ay + sa, bx - cb, by - sb, bx + cb, by + sb) - iv.A.r - iv.B.r;
}
/** lower bound of the gap on an interval (distance between the swept boxes of the two capsules) */
function gapLowerBound(iv: Iv): number {
  const box = (g: Piece) => { const [x0, y0] = posOf(g, iv.p), [x1, y1] = posOf(g, iv.q), e = g.hw + g.r; return [Math.min(x0, x1) - e, Math.min(y0, y1) - e, Math.max(x0, x1) + e, Math.max(y0, y1) + e]; };
  const a = box(iv.A), b = box(iv.B), dx = Math.max(0, a[0] - b[2], b[0] - a[2]), dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
  return Math.hypot(dx, dy);
}
function bisect(lo: number, hi: number, predHi: (t: number) => boolean): [number, number] {
  for (let n = 0; n < 2000; n++) { const m = lo + (hi - lo) / 2; if (m <= lo || m >= hi) break; if (predHi(m)) hi = m; else lo = m; }
  return [lo, hi];
}
function argmin(f: (t: number) => number, a: number, b: number): number {
  const r = (Math.sqrt(5) - 1) / 2;
  let x1 = b - r * (b - a), x2 = a + r * (b - a), f1 = f(x1), f2 = f(x2);
  for (let k = 0; k < 300 && b - a > 1e-16 * Math.max(1, Math.abs(b)); k++) {
    if (f1 <= f2) { b = x2; x2 = x1; f2 = f1; x1 = b - r * (b - a); f1 = f(x1); } else { a = x1; x1 = x2; f1 = f2; x2 = a + r * (b - a); f2 = f(x2); }
  }
  return f1 <= f2 ? x1 : x2;
}

/** threshold searches over the common intervals (each returns [old side, new side] or null) */
class PairGap {
  private ivs: Iv[];
  constructor(ivs: Iv[]) { this.ivs = ivs; }
  at(t: number): number { for (const iv of this.ivs) if (t >= iv.p && t <= iv.q) { return gapIv(iv, t); } return NaN; }
  /** first t ≥ from with g > th */
  firstAbove(th: number, from: number, to = Infinity): [number, number] | null {
    for (const iv of this.ivs) {
      if (iv.q < from || iv.p > to) continue;
      const p = Math.max(iv.p, from), q = Math.min(iv.q, to), g = (t: number) => gapIv(iv, t);
      if (gapLowerBound(iv) > th) return [p, p];
      if (g(p) > th) return [p, p];
      if (g(q) > th) return bisect(p, q, (t) => g(t) > th);
    }
    return null;
  }
  /** first t ≥ from with g ≤ th */
  firstAtOrBelow(th: number, from: number, to = Infinity): [number, number] | null {
    for (const iv of this.ivs) {
      if (iv.q < from || iv.p > to) continue;
      if (gapLowerBound(iv) > th) continue;
      const p = Math.max(iv.p, from), q = Math.min(iv.q, to), g = (t: number) => gapIv(iv, t);
      if (g(p) <= th) return [p, p];
      if (g(q) <= th) return bisect(p, q, (t) => g(t) <= th);
      if (q > p) { const m = argmin(g, p, q); if (g(m) <= th) return bisect(p, m, (t) => g(t) <= th); }
    }
    return null;
  }
  /** last t ≤ before (and ≥ from) with g ≤ th: returns [that t, the instant after it] */
  lastAtOrBelow(th: number, before: number, from = -Infinity): [number, number] | null {
    for (let k = this.ivs.length - 1; k >= 0; k--) {
      const iv = this.ivs[k];
      if (iv.p > before || iv.q < from) continue;
      if (gapLowerBound(iv) > th) continue;
      const p = Math.max(iv.p, from), q = Math.min(iv.q, before), g = (t: number) => gapIv(iv, t);
      if (g(q) <= th) return [q, q];
      if (g(p) <= th) { const [lo, hi] = bisect(p, q, (t) => g(t) > th); return [lo, hi]; }
      if (q > p) { const m = argmin(g, p, q); if (g(m) <= th) { const [lo, hi] = bisect(m, q, (t) => g(t) > th); return [lo, hi]; } }
    }
    return null;
  }
  /** last t ≤ before (and ≥ from) with g > th: returns [that t, the instant after it] */
  lastAbove(th: number, before: number, from = -Infinity): [number, number] | null {
    for (let k = this.ivs.length - 1; k >= 0; k--) {
      const iv = this.ivs[k];
      if (iv.p > before || iv.q < from) continue;
      const p = Math.max(iv.p, from), q = Math.min(iv.q, before), g = (t: number) => gapIv(iv, t);
      if (g(q) > th) return [q, q];
      if (g(p) > th) { const [lo, hi] = bisect(p, q, (t) => g(t) <= th); return [lo, hi]; }
    }
    return null;
  }
}

export function checkContacts(m: CkMotion, opt: CkOptions | number = {}): CkReport {
  const o: CkOptions = typeof opt === 'number' ? { eval_err_mm: opt } : opt;
  const TH = o.tol_mm ?? CONTRACT.tol_mm, RHO = o.resolution_mm ?? CONTRACT.resolution_mm, EPS = o.eval_err_mm ?? CONTRACT.eval_err_mm, OCC = o.occ_tol_mm ?? CONTRACT.occ_tol_mm;
  const H = m.horizon_s, byId = new Map(m.agents.map((a) => [a.id, a])), pieces = new Map(m.agents.map((a) => [a.id, piecesOf(a, m.body)]));
  const problems: string[] = [], list: CkEpisode[] = [];
  for (let k = 1; k < m.events.length; k++) if (m.events[k].t < m.events[k - 1].t) { problems.push(`events not in time order at index ${k}`); break; }
  // recorded episodes per pair
  const keyOf = (ids: string[]) => [...ids].sort().join('|');
  const eps = new Map<string, { ts: number; e: CkEvent | null }[]>(), open = new Map<string, number>();
  for (const e of m.events) {
    if (e.kind === 'contact_start') { const k = keyOf(e.agents); if (open.has(k)) problems.push(`${k}: nested contact_start at ${e.t}`); open.set(k, e.t); }
    else if (e.kind === 'contact_end' || e.kind === 'contact_end_estimated' || e.kind === 'contact_end_unconfirmed') {
      const k = keyOf(e.agents), ts = open.get(k);
      if (ts === undefined) { problems.push(`${k}: ${e.kind} at ${e.t} without a start`); continue; }
      if (e.kind === 'contact_end_unconfirmed') { if (!eps.has(k)) eps.set(k, []); eps.get(k)!.push({ ts, e }); open.delete(k); continue; }
      open.delete(k); if (!eps.has(k)) eps.set(k, []); eps.get(k)!.push({ ts, e });
    }
  }
  for (const [k, ts] of open) { if (!eps.has(k)) eps.set(k, []); eps.get(k)!.push({ ts, e: null }); }
  for (const L of eps.values()) L.sort((x, y) => x.ts - y.ts);
  // pairs to examine: every recorded pair, plus (scan) every same-layer pair whose whole-run boxes come within θ + ρ
  const keys = new Set(eps.keys());
  let missed = 0, penetrations = 0;
  if (o.scan_missed !== false) {
    const ids = m.agents.map((a) => a.id).sort();
    const bb = new Map(ids.map((id) => { const P = pieces.get(id)!; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, e = 0; for (const g of P) { x0 = Math.min(x0, g.x0, g.x1); y0 = Math.min(y0, g.y0, g.y1); x1 = Math.max(x1, g.x0, g.x1); y1 = Math.max(y1, g.y0, g.y1); e = g.hw + g.r; } return [id, [x0 - e, y0 - e, x1 + e, y1 + e]]; }));
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
      const A = byId.get(ids[i])!, B = byId.get(ids[j])!;
      if ((A.layer ?? '') !== (B.layer ?? '')) continue;
      const a = bb.get(ids[i])!, b = bb.get(ids[j])!;
      if (Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]) > TH + RHO) continue;
      keys.add(`${ids[i]}|${ids[j]}`);
    }
  }
  const pg = new Map<string, PairGap>();
  for (const k of [...keys].sort()) {
    const [i, j] = k.split('|'), A = byId.get(i), B = byId.get(j);
    if (!A || !B) { problems.push(`${k}: unknown agent`); continue; }
    const from = Math.max(A.present_from, B.present_from), endShared = Math.min(A.present_until ?? H, B.present_until ?? H, H);
    const G = new PairGap(commonIntervals(pieces.get(i)!, pieces.get(j)!, from, endShared)); pg.set(k, G);
    // non-penetration over the whole shared presence
    const pen = G.firstAtOrBelow(-OCC, from, endShared);
    if (pen) { penetrations++; problems.push(`${k}: penetration (gap < −${OCC} mm) at ${pen[1]} s`); }
    const L = eps.get(k) ?? [];
    let prevEnd = from;
    for (const { ts, e } of L) {
      // missed contact between the previous episode and this one
      const miss = G.firstAtOrBelow(TH - RHO - EPS, prevEnd, endShared);
      if (miss && miss[1] < ts) { missed++; problems.push(`${k}: contact (gap ≤ θ − ρ) at ${miss[1]} s not recorded (next recorded start ${ts} s)`); }
      const ep: CkEpisode = { pair: [i, j], t_start: ts, end_kind: e ? (e.kind as CkEpisode['end_kind']) : 'open', t_end: e && e.kind !== 'contact_end_unconfirmed' ? e.t : null, start_lo: null, start_hi: null, lo: null, hi: null, err_s: null, inside: null, engine_bracket: e?.bracket_s ?? null, engine_err_s: e?.err_s ?? null, usable_as_cause: e ? e.usable_as_cause !== false : true, problem: null };
      const fail = (why: string) => { ep.problem = ep.problem ?? why; };
      // start bracket
      const c = G.firstAtOrBelow(TH - RHO + EPS, prevEnd, endShared);
      if (!c) fail(`contact_start at ${ts} s, but the gap never reaches θ − ρ`);
      else {
        const lo = G.lastAbove(TH + EPS, c[1], prevEnd), hi = G.lastAbove(TH - EPS, c[1], prevEnd);
        ep.start_lo = lo ? lo[0] : prevEnd; ep.start_hi = hi ? hi[1] : prevEnd;
        if (!(ts >= ep.start_lo && ts <= ep.start_hi)) fail(`contact_start ${ts} s outside the bracket [${ep.start_lo}, ${ep.start_hi}]`);
      }
      if (!e || e.kind === 'contact_end_unconfirmed') {
        const up = G.firstAbove(TH + RHO + EPS, ts, endShared);
        if (up) fail(`${e ? 'unconfirmed end' : 'open contact'}, but the motion separates (g > θ + ρ) at ${up[1]} s`);
        if (e && e.usable_as_cause !== false) fail('contact_end_unconfirmed without usable_as_cause = false');
      } else if (e.kind === 'contact_end') {
        const cc = G.firstAbove(TH + RHO - EPS, ts, endShared);
        if (!cc) fail(`contact_end at ${e.t} s, but the motion never separates (no bracket)`);
        else {
          const lo = G.lastAtOrBelow(TH - EPS, cc[1], ts), hi = G.lastAtOrBelow(TH + EPS, cc[1], ts);
          ep.lo = lo ? lo[0] : ts; ep.hi = hi ? hi[1] : ts; ep.err_s = ep.hi - ep.lo; ep.inside = e.t >= ep.lo && e.t <= ep.hi;
          if (!ep.inside) fail(`contact_end ${e.t} s outside the bracket [${ep.lo}, ${ep.hi}]`);
          if (e.bracket_s && !(e.bracket_s[1] === e.t && e.bracket_s[0] <= e.t && e.bracket_s[0] >= ep.lo && e.bracket_s[1] <= ep.hi)) fail(`engine bracket [${e.bracket_s}] not inside [${ep.lo}, ${ep.hi}]`);
          if (e.err_s !== undefined && !(e.err_s >= 0 && Number.isFinite(e.err_s))) fail(`engine err_s ${e.err_s} invalid`);
        }
        prevEnd = e.t;
      } else {
        ep.usable_as_cause = false;
        if (e.usable_as_cause !== false) fail('contact_end_estimated without usable_as_cause = false');
        if (!(A.present_until === e.t || B.present_until === e.t)) fail(`contact_end_estimated at ${e.t} s is not the end of a body's presence`);
        const up = G.firstAbove(TH + RHO + EPS, ts, e.t);
        if (up && up[1] < e.t) fail(`estimated end at ${e.t} s, but the motion had separated by ${up[1]} s (should be an exact contact_end)`);
        prevEnd = e.t;
      }
      if (ep.problem) problems.push(`${i}-${j}@${ts}: ${ep.problem}`);
      list.push(ep);
      if (!e || e.kind === 'contact_end_unconfirmed') { prevEnd = Infinity; break; }
    }
    if (prevEnd < endShared) {
      const miss = G.firstAtOrBelow(TH - RHO - EPS, prevEnd, endShared);
      if (miss) { missed++; problems.push(`${k}: contact (gap ≤ θ − ρ) at ${miss[1]} s not recorded`); }
    }
  }
  const errs = list.map((x) => x.err_s).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const serrs = list.filter((x) => x.start_lo !== null).map((x) => x.start_hi! - x.start_lo!);
  const devs = list.filter((x) => x.lo !== null && x.t_end !== null).map((x) => Math.abs(x.t_end! - (x.lo! + x.hi!) / 2));
  return {
    episodes: list.length, exact: list.filter((x) => x.end_kind === 'contact_end').length, estimated: list.filter((x) => x.end_kind === 'contact_end_estimated').length,
    unconfirmed: list.filter((x) => x.end_kind === 'contact_end_unconfirmed').length, open: list.filter((x) => x.end_kind === 'open').length,
    violations: problems.length, problems: problems.slice(0, 20),
    max_err_s: errs.length ? errs[errs.length - 1] : null, median_err_s: errs.length ? errs[(errs.length - 1) >> 1] : null,
    max_start_err_s: serrs.length ? Math.max(...serrs) : null, max_dev_from_mid_s: devs.length ? Math.max(...devs) : null,
    missed, penetrations, pairs_scanned: keys.size, tol_mm: TH, resolution_mm: RHO, delta_g_mm: EPS, list,
  };
}

/**
 * constraint_active intervals (issue #146): the solver's own record of when a pair's non-penetration constraint was in its
 * velocity solve. Checked against THIS checker's gap: (1) at the start g ≤ θ + ε (a constraint is added only for touching
 * bodies); (2) during the interval g never exceeds θ + ε before its end (it is released when g leaves θ); (3) at a
 * recorded end g ≥ θ − ε, and an end bracket, if given, holds the end; (4) constraint_active ⊆ geometric_contact: the
 * interval lies inside a recorded geometric episode of the same pair ([start_lo, end hi], open episodes to the horizon,
 * tolerance tol_s), or — when no episode holds it — the gap stays above θ − ρ − ε over the whole interval (a constraint
 * at θ − ρ < g ≤ θ that never became a confirmed episode: below the resolution, counted, not a violation). Needs the
 * report of checkContacts on the same motion (its episodes and brackets).
 */
export interface CkConstraint { agents: [string, string] | string[]; start_t_s: number; end_t_s: number | null; end_bracket_s?: [number, number] | null }
export interface ConstraintReport { intervals: number; inside_episode: number; below_resolution: number; open_at_horizon: number; violations: number; problems: string[]; max_outside_s: number }
export function checkConstraints(m: CkMotion, ivs: CkConstraint[], rep: CkReport, opt: CkOptions & { tol_s?: number } = {}): ConstraintReport {
  const TH = opt.tol_mm ?? CONTRACT.tol_mm, RHO = opt.resolution_mm ?? CONTRACT.resolution_mm, EPS = opt.eval_err_mm ?? CONTRACT.eval_err_mm, TOLS = opt.tol_s ?? 1e-12;
  const H = m.horizon_s, byId = new Map(m.agents.map((a) => [a.id, a])), problems: string[] = [];
  const keyOf = (ids: string[]) => [...ids].sort().join('|');
  const epsOf = new Map<string, CkEpisode[]>();
  for (const e of rep.list) { const k = keyOf(e.pair); if (!epsOf.has(k)) epsOf.set(k, []); epsOf.get(k)!.push(e); }
  const gaps = new Map<string, PairGap>();
  let inside = 0, below = 0, open = 0, maxOut = 0;
  for (const c of ivs) {
    const k = keyOf(c.agents), [i, j] = k.split('|'), A = byId.get(i), B = byId.get(j);
    if (!A || !B) { problems.push(`${k}: constraint for an unknown agent`); continue; }
    let G = gaps.get(k);
    if (!G) { G = new PairGap(commonIntervals(piecesOf(A, m.body), piecesOf(B, m.body), Math.max(A.present_from, B.present_from), Math.min(A.present_until ?? H, B.present_until ?? H, H))); gaps.set(k, G); }
    const s = c.start_t_s, e = c.end_t_s ?? H;
    if (c.end_t_s === null) open++;
    const fail = (why: string) => problems.push(`${k}@${s}: ${why}`);
    if (!(e >= s)) { fail(`end ${e} before start`); continue; }
    const gs = G.at(s); if (!(gs <= TH + EPS)) fail(`constraint active at gap ${gs} mm > θ + ε`);
    const up = G.firstAbove(TH + EPS, s, e); if (up && up[1] < e) fail(`gap above θ + ε at ${up[1]} s while the constraint is active (until ${e} s)`);
    if (c.end_t_s !== null) {
      const ge = G.at(e); if (!(ge >= TH - EPS)) fail(`constraint released at gap ${ge} mm < θ − ε`);
      if (c.end_bracket_s && !(c.end_bracket_s[0] <= e && c.end_bracket_s[1] === e && G.at(c.end_bracket_s[0]) <= TH + EPS)) fail(`end bracket [${c.end_bracket_s}] does not hold the release`);
    }
    const ep = (epsOf.get(k) ?? []).find((x) => {
      const lo = Math.min(x.start_lo ?? x.t_start, x.t_start), hi = x.end_kind === 'contact_end' ? Math.max(x.hi ?? x.t_end!, x.t_end!) : H;
      return s >= lo - TOLS && e <= hi + TOLS;
    });
    if (ep) { inside++; continue; }
    const deep = G.firstAtOrBelow(TH - RHO - EPS, s, e);
    if (deep) { fail(`constraint interval [${s}, ${e}] not inside any geometric episode, and the gap reaches θ − ρ at ${deep[1]} s`); continue; }
    below++;
    const near = (epsOf.get(k) ?? []).map((x) => Math.max(0, (x.start_lo ?? x.t_start) - s, e - (x.end_kind === 'contact_end' ? x.hi ?? x.t_end! : H)));
    if (near.length) maxOut = Math.max(maxOut, Math.min(...near));
  }
  return { intervals: ivs.length, inside_episode: inside, below_resolution: below, open_at_horizon: open, violations: problems.length, problems: problems.slice(0, 20), max_outside_s: maxOut };
}

/** motion-record invariants: chronological segments, no teleport (each segment starts where the previous one ended),
 *  path length = ∫ speed dt (when speeds are exported), displacement = speed × duration per segment */
export interface MotionReport { agents: number; segments: number; teleports: number; speed_mismatch: number; max_teleport_mm: number; max_speed_rel_err: number; path_mm: Record<string, number>; problems: string[] }
export function checkMotion(m: CkMotion, tolMm = 1e-9): MotionReport {
  const problems: string[] = [], path: Record<string, number> = {};
  let segs = 0, tele = 0, sm = 0, maxTele = 0, maxRel = 0;
  for (const a of m.agents) {
    let len = 0, integ = 0;
    a.segments.forEach((g, k) => {
      segs++;
      if (!(g.t1 > g.t0)) problems.push(`${a.id}: segment ${k} has no duration`);
      if (k > 0) {
        const p = a.segments[k - 1];
        if (g.t0 < p.t1) problems.push(`${a.id}: segment ${k} starts before the previous one ends`);
        const d = Math.hypot(g.x0 - p.x1, g.y0 - p.y1); maxTele = Math.max(maxTele, d);
        if (d > tolMm) { tele++; problems.push(`${a.id}: teleport ${d} mm at ${g.t0} s`); }
      }
      const disp = Math.hypot(g.x1 - g.x0, g.y1 - g.y0); len += disp;
      if (g.speed_mm_s !== undefined) {
        integ += g.speed_mm_s * (g.t1 - g.t0);
        const want = g.speed_mm_s * (g.t1 - g.t0), err = Math.abs(disp - want);
        if (want > 0) maxRel = Math.max(maxRel, err / want);
        if (err > tolMm + 1e-12 * want) { sm++; problems.push(`${a.id}: displacement ${disp} ≠ speed × duration ${want} at ${g.t0} s`); }
      }
    });
    if (a.final && a.segments.length) { const l = a.segments[a.segments.length - 1], d = Math.hypot(a.final.x - l.x1, a.final.y - l.y1); if (d > tolMm) { tele++; problems.push(`${a.id}: final pose ${d} mm from the last segment end`); } }
    path[a.id] = len;
    if (a.segments.some((g) => g.speed_mm_s !== undefined) && Math.abs(len - integ) > tolMm * Math.max(1, a.segments.length)) problems.push(`${a.id}: path length ${len} ≠ ∫ speed dt ${integ}`);
  }
  return { agents: m.agents.length, segments: segs, teleports: tele, speed_mismatch: sm, max_teleport_mm: maxTele, max_speed_rel_err: maxRel, path_mm: path, problems: problems.slice(0, 20) };
}

/** adapter: a solver result's motion records (samples [t, x, y, heading, s, u]) → the exported segment form */
export function motionFromSamples(
  agents: Record<string, { samples: [number, number, number, number, number, number][]; present_from_t_s?: number | null; removed_t_s?: number | null; layer?: string }>,
  events: { t_s: number; kind: string; agents: string[]; bracket_s?: [number, number]; err_s?: number; confirmed_t_s?: number; usable_as_cause?: boolean }[],
  body: { length_mm: number; width_mm: number }, horizon_s: number,
): CkMotion {
  const out: CkAgent[] = [];
  for (const id of Object.keys(agents).sort()) {
    const a = agents[id], S = a.samples, segs: CkSegment[] = [];
    for (let i = 0; i + 1 < S.length; i++) { const p = S[i], q = S[i + 1]; if (q[0] > p[0]) segs.push({ t0: p[0], t1: q[0], x0: p[1], y0: p[2], x1: q[1], y1: q[2], heading: p[3], speed_mm_s: Math.abs(q[4] - p[4]) / (q[0] - p[0]), s0: p[4], s1: q[4] }); }
    const last = S[S.length - 1];
    const from = a.present_from_t_s === undefined ? 0 : a.present_from_t_s === null ? Infinity : a.present_from_t_s;
    out.push({ id, segments: segs, final: last ? { x: last[1], y: last[2], heading: last[3] } : null, present_from: from, present_until: a.removed_t_s ?? null, layer: a.layer });
  }
  return { horizon_s, body, agents: out, events: events.map((e) => ({ t: e.t_s, kind: e.kind, agents: e.agents, bracket_s: e.bracket_s, err_s: e.err_s, confirmed_t_s: e.confirmed_t_s, usable_as_cause: e.usable_as_cause })) };
}
