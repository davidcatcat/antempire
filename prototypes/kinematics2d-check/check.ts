/**
 * Independent checker for KIN-2D executed motion records (docs/physics-kinematics2d.md §5).
 * It imports NOTHING from engine/ or from the KIN-2D module: pose evaluation (rotation about the instantaneous centre,
 * or a power series for small turning angles), capsule distance and the certification are written separately here.
 * Contract numbers are COPIED (tests assert they equal the module's).
 *
 * Checks, on the record only (segments with t0, t1, start pose, twist; events; statics):
 *  - continuity: each segment starts where the previous one ended (no teleport), times contiguous, t1 ≤ H;
 *  - no penetration: for every pair the gap is certified ≥ −PEN_TOL on the whole time line by interval bounds
 *    g(t) ≥ (g(a) + g(b))/2 − M·(b − a)/2 (M = sum of the two bodies' point-speed bounds), bisecting where needed;
 *  - no missed contact: outside recorded contact intervals the gap is certified ≥ θ/4 − EPS_MM (before a first contact
 *    the module guarantees λ = θ/2; right after a contact ends only the in-contact level θ/4);
 *  - at the horizon: a touching pair (g ≤ θ) must have an open recorded contact, and an open contact must not be separated;
 *  - every contact_start has g(t) ≤ θ + EPS_MM; every contact_end has g ≥ θ − EPS_MM at its time.
 * Intervals that cannot be certified within the depth cap are counted as `uncertified` (never silently passed).
 */
export const CHECK_CONTACT_TOL_MM = 1e-7;   // θ (copied)
export const CHECK_CA_LEVEL_MM = 5e-8;      // λ (copied)
/** outside recorded contacts the gap must stay ≥ this (the in-contact level θ/4 bounds the gap right after a contact ends) */
export const CHECK_MISS_LEVEL_MM = 2.5e-8;  // (copied: CA_CONTACT_LEVEL_MM)
export const PEN_TOL_MM = 1e-9;
export const CHECK_SEP_RES_MM = 1e-9;      // ρ (copied)
export const EPS_MM = 1e-11;

export interface XP { x: number; y: number }
export interface XSeg { t0: number; t1: number; p0: { x: number; y: number; th: number }; tw: { v: number; vl: number; w: number } }
export interface XBody { body: { length_mm: number | null; width_mm: number | null }; segs: XSeg[] }
export type XStatic = { id: string; kind: 'segment'; a: XP; b: XP; r?: number } | { id: string; kind: 'disc'; c: XP; r: number } | { id: string; kind: 'polygon'; pts: XP[] };
export interface XEvent { t_s: number; kind: string; ids: string[] }
export interface XRecord { horizon_s: number; bodies: Record<string, XBody>; statics: XStatic[]; events: XEvent[]; layers?: Record<string, string> }

/** pose by rotation about the instantaneous centre of rotation (large angles) or a series (small angles) */
export function xPose(s: XSeg, t: number): { x: number; y: number; th: number } {
  const tau = t - s.t0, { v, vl, w } = s.tw, phi = w * tau, c0 = Math.cos(s.p0.th), s0 = Math.sin(s.p0.th);
  let bx: number, by: number;
  if (Math.abs(phi) >= 1e-2) {
    // centre of rotation in body frame: (−vl/w, v/w)
    const cx = -vl / w, cy = v / w, cp = Math.cos(phi), sp = Math.sin(phi);
    bx = cx + cp * -cx - sp * -cy; by = cy + sp * -cx + cp * -cy;
  } else {
    // ∫0^τ (cos wu, sin wu) du as series in φ
    let a = 0, b = 0, term = tau; // term = τ φ^k / (k+1)!
    for (let k = 0; k < 14; k++) {
      const m = k % 4; // cos-series picks even k, sin-series odd k
      if (m === 0) a += term; else if (m === 1) b += term; else if (m === 2) a -= term; else b -= term;
      term = (term * phi) / (k + 2);
    }
    bx = v * a - vl * b; by = v * b + vl * a;
  }
  return { x: s.p0.x + c0 * bx - s0 * by, y: s.p0.y + s0 * bx + c0 * by, th: s.p0.th + phi };
}
function segOf(b: XBody, t: number): XSeg { let k = 0; while (k + 1 < b.segs.length && b.segs[k + 1].t0 <= t) k++; return b.segs[k]; }
function capOf(b: XBody, t: number): { a: XP; b: XP; r: number } {
  const L = b.body.length_mm as number, w = b.body.width_mm as number, h = Math.max(0, L - w) / 2, p = xPose(segOf(b, t), t);
  return { a: { x: p.x - Math.cos(p.th) * h, y: p.y - Math.sin(p.th) * h }, b: { x: p.x + Math.cos(p.th) * h, y: p.y + Math.sin(p.th) * h }, r: w / 2 };
}
function bound(b: XBody, t: number): number { const s = segOf(b, t), L = b.body.length_mm as number, w = b.body.width_mm as number; return Math.hypot(s.tw.v, s.tw.vl) + Math.abs(s.tw.w) * Math.max(0, L - w) / 2; }
function ptSeg(p: XP, a: XP, b: XP): number {
  const dx = b.x - a.x, dy = b.y - a.y, L2 = dx * dx + dy * dy;
  let u = L2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2; u = Math.max(0, Math.min(1, u));
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
}
function segDist(a: XP, b: XP, c: XP, d: XP): number {
  const o = (p: XP, q: XP, r: XP) => Math.sign((q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x));
  if (o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0) return 0;
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}
function staticCapsX(s: XStatic): { a: XP; b: XP; r: number }[] {
  if (s.kind === 'segment') return [{ a: s.a, b: s.b, r: s.r ?? 0 }];
  if (s.kind === 'disc') return [{ a: s.c, b: s.c, r: s.r }];
  return s.pts.map((p, i) => ({ a: p, b: s.pts[(i + 1) % s.pts.length], r: 0 }));
}

export interface CheckReport { violations: string[]; uncertified: number; pairs: number; intervals_certified: number; min_gap_mm: number }
export function checkRecord(rec: XRecord, maxDepth = 60): CheckReport {
  const violations: string[] = []; let uncertified = 0, certified = 0, minGap = Infinity;
  const H = rec.horizon_s, ids = Object.keys(rec.bodies).sort();
  for (const id of ids) {
    const b = rec.bodies[id];
    for (let k = 0; k < b.segs.length; k++) {
      const s = b.segs[k];
      if (!(s.t1 >= s.t0) || s.t1 > H + 1e-12) violations.push(`${id}: bad segment times ${s.t0}..${s.t1}`);
      if (k > 0) {
        const p = b.segs[k - 1], e = xPose(p, p.t1);
        if (p.t1 !== s.t0) violations.push(`${id}: segments not contiguous at ${s.t0}`);
        const jump = Math.hypot(e.x - s.p0.x, e.y - s.p0.y), dth = Math.abs(e.th - s.p0.th);
        if (jump > 1e-9 || dth > 1e-9) violations.push(`${id}: teleport at ${s.t0} (${jump} mm, ${dth} rad)`);
      }
    }
  }
  type G = (t: number) => number;
  const pairs: { key: string; gap: G; M: G; cuts: number[] }[] = [];
  const layer = (x: string) => rec.layers?.[x] ?? '';
  for (let i = 0; i < ids.length; i++) {
    const A = rec.bodies[ids[i]];
    for (let j = i + 1; j < ids.length; j++) {
      if (layer(ids[i]) !== layer(ids[j])) continue;
      const B = rec.bodies[ids[j]];
      pairs.push({ key: `${ids[i]}|${ids[j]}`, gap: (t) => { const p = capOf(A, t), q = capOf(B, t); return segDist(p.a, p.b, q.a, q.b) - p.r - q.r; }, M: (t) => bound(A, t) + bound(B, t), cuts: [...A.segs.map((s) => s.t0), ...B.segs.map((s) => s.t0)] });
    }
    for (const s of rec.statics) {
      if (layer(ids[i]) !== layer(s.id)) continue;
      const caps = staticCapsX(s), key = ids[i] < s.id ? `${ids[i]}|${s.id}` : `${s.id}|${ids[i]}`;
      pairs.push({ key, gap: (t) => { const p = capOf(A, t); let g = Infinity; for (const c of caps) g = Math.min(g, segDist(p.a, p.b, c.a, c.b) - p.r - c.r); return g; }, M: (t) => bound(A, t), cuts: A.segs.map((s) => s.t0) });
    }
  }
  const t0 = Math.min(...ids.map((id) => rec.bodies[id].segs[0]?.t0 ?? 0));
  for (const p of pairs) {
    // recorded contact intervals of this pair
    const evs = rec.events.filter((e) => (e.kind === 'contact_start' || e.kind === 'contact_end') && [...e.ids].sort().join('|') === p.key).sort((a, b) => a.t_s - b.t_s);
    const iv: [number, number][] = []; let open: number | null = null;
    for (const e of evs) { if (e.kind === 'contact_start') open = e.t_s; else if (open !== null) { iv.push([open, e.t_s]); open = null; } }
    if (open !== null) iv.push([open, H]);
    for (const e of evs) {
      const g = p.gap(e.t_s);
      if (e.kind === 'contact_start' && g > CHECK_CONTACT_TOL_MM + EPS_MM) violations.push(`${p.key}: contact_start at ${e.t_s} with gap ${g}`);
      if (e.kind === 'contact_end' && g < CHECK_CONTACT_TOL_MM - EPS_MM) violations.push(`${p.key}: contact_end at ${e.t_s} with gap ${g}`);
    }
    // at the horizon: touching ⇒ an open recorded contact; an open recorded contact ⇒ not clearly separated
    const gH = p.gap(H), openAtH = iv.some(([s0, e0]) => e0 === H && s0 <= H);
    if (gH <= CHECK_CONTACT_TOL_MM - EPS_MM && !openAtH) violations.push(`${p.key}: touching at the horizon (gap ${gH}) without a recorded open contact (missed contact)`);
    if (openAtH && gH > CHECK_CONTACT_TOL_MM + CHECK_SEP_RES_MM + EPS_MM) violations.push(`${p.key}: contact open at the horizon but separated (gap ${gH})`);
    const inContact = (a: number, b: number) => iv.some(([s, e]) => a >= s - 1e-12 && b <= e + 1e-12);
    // cut the time line at every breakpoint and every contact boundary
    const cuts = [...new Set([t0, H, ...p.cuts.filter((t) => t > t0 && t < H), ...iv.flat().filter((t) => t > t0 && t < H)])].sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k], b = cuts[k + 1];
      const thr = inContact(a, b) ? -PEN_TOL_MM : CHECK_MISS_LEVEL_MM - EPS_MM;
      const M = p.M(a + (b - a) / 2);
      const rec2 = (lo: number, hi: number, glo: number, ghi: number, depth: number): void => {
        minGap = Math.min(minGap, glo, ghi);
        if (glo < thr || ghi < thr) { violations.push(`${p.key}: gap ${Math.min(glo, ghi)} < ${thr} near ${glo < thr ? lo : hi}${thr < 0 ? ' (penetration)' : ' (missed contact)'}`); return; }
        if ((glo + ghi) / 2 - (M * (hi - lo)) / 2 >= thr) { certified++; return; }
        const mid = lo + (hi - lo) / 2;
        if (depth >= maxDepth || !(mid > lo && mid < hi)) { uncertified++; return; }
        const gm = p.gap(mid);
        rec2(lo, mid, glo, gm, depth + 1); rec2(mid, hi, gm, ghi, depth + 1);
      };
      if (b > a) rec2(a, b, p.gap(a), p.gap(b), 0); else { const g = p.gap(a); minGap = Math.min(minGap, g); if (g < thr) violations.push(`${p.key}: gap ${g} at ${a}`); }
      if (violations.length > 50) return { violations, uncertified, pairs: pairs.length, intervals_certified: certified, min_gap_mm: minGap };
    }
  }
  return { violations, uncertified, pairs: pairs.length, intervals_certified: certified, min_gap_mm: minGap };
}
