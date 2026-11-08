/**
 * Independent checker for ANTENNA-GEO antenna_contact records (docs/antenna-geometry.md §5).
 * It imports NOTHING from engine/: pose evaluation (direct integration of the rotated twist, series for small turns),
 * the head frame, the elbowed antenna, the scanning joints and the segment distances are written separately here.
 * Contract numbers are COPIED (tests assert they equal the module's).
 *
 * Checks on the record only (body segments, antenna numbers, statics, events):
 *  - every start event: gap ≤ θ + EPS at t_s, and gap > θ − EPS at bracket[0] when the bracket has width;
 *  - every end event: gap > θ − EPS at t_s;
 *  - no missed contact: outside recorded contact intervals the gap is certified ≥ λ − EPS by interval bounds
 *    g(t) ≥ (g(a) + g(b))/2 − M·(b − a)/2 (M = speed bound of the pair), bisecting where needed;
 *  - no missed separation: inside recorded contact intervals the gap is certified ≤ θ + 2ρ + EPS (upper interval bound);
 *  - at the horizon: an open interval iff the gap there is ≤ θ + 2ρ (open) / > λ (closed) consistently.
 * Intervals that cannot be certified within the depth cap are counted as `uncertified` (never silently passed).
 */
export const X_CONTACT_TOL_MM = 1e-7;  // θ (copied)
export const X_CA_LEVEL_MM = 5e-8;     // λ (copied)
export const X_SEP_RES_MM = 1e-9;      // ρ (copied)
export const X_EPS_MM = 1e-11;

export interface XP { x: number; y: number }
export interface XSeg { t0: number; t1: number; p0: { x: number; y: number; th: number }; tw: { v: number; vl: number; w: number } }
export interface XAntenna { hx: number; hyaw: number; half: number; Ls: number; Lf: number; r: number; scan: { ac: number; aa: number; bc: number; ba: number; f: number; phL: number; phR: number; phB: number } }
export interface XAgent { body: { length_mm: number; width_mm: number }; layer: string; segs: XSeg[]; antenna: XAntenna }
export type XStatic = { id: string; kind: 'segment'; a: XP; b: XP; r?: number; layer?: string } | { id: string; kind: 'disc'; c: XP; r: number; layer?: string } | { id: string; kind: 'polygon'; pts: XP[]; layer?: string };
export interface XEvent { t_s: number; phase: 'start' | 'end'; agent_id: string; side: 'left' | 'right'; target: { kind: 'static' | 'body' | 'antenna'; id: string; side?: 'left' | 'right' }; bracket_s: [number, number] }
export interface XRecord { t0_s: number; horizon_s: number; agents: Record<string, XAgent>; statics: XStatic[]; targets: { statics: boolean; bodies: boolean; antennae: boolean }; events: XEvent[] }

// ---- own geometry
function segAt(segs: XSeg[], t: number): XSeg { let k = 0; for (let i = 0; i < segs.length; i++) if (segs[i].t0 <= t) k = i; return segs[k]; }
export function xPose(segs: XSeg[], t: number): { x: number; y: number; th: number } {
  const s = segAt(segs, t), tau = Math.max(0, t - s.t0), { v, vl, w } = s.tw, th0 = s.p0.th, th = th0 + w * tau;
  if (Math.abs(w * tau) < 1e-6) {
    // second-order series of ∫R(θ0 + wτ')(v, vl)dτ'
    const c = Math.cos(th0), sn = Math.sin(th0), a = tau, b = (w * tau * tau) / 2;
    return { x: s.p0.x + a * (v * c - vl * sn) + b * (-v * sn - vl * c), y: s.p0.y + a * (v * sn + vl * c) + b * (v * c - vl * sn), th };
  }
  return { x: s.p0.x + (v * (Math.sin(th) - Math.sin(th0)) + vl * (Math.cos(th) - Math.cos(th0))) / w, y: s.p0.y + (-v * (Math.cos(th) - Math.cos(th0)) + vl * (Math.sin(th) - Math.sin(th0))) / w, th };
}
const rot = (o: { x: number; y: number; th: number }, p: XP): XP => ({ x: o.x + Math.cos(o.th) * p.x - Math.sin(o.th) * p.y, y: o.y + Math.sin(o.th) * p.x + Math.cos(o.th) * p.y });
export function xAntenna(ag: XAgent, side: 'left' | 'right', t: number): { base: XP; elbow: XP; tip: XP } {
  const A = ag.antenna, s = side === 'left' ? 1 : -1, P = xPose(ag.segs, t);
  const head = { ...rot(P, { x: A.hx, y: 0 }), th: P.th + A.hyaw };
  const W = 2 * Math.PI * A.scan.f, ph = side === 'left' ? A.scan.phL : A.scan.phR;
  const al = A.scan.ac + A.scan.aa * Math.sin(W * t + ph), be = A.scan.bc + A.scan.ba * Math.sin(W * t + ph + A.scan.phB);
  const b = { x: 0, y: s * A.half }, e = { x: b.x + A.Ls * Math.cos(s * al), y: b.y + A.Ls * Math.sin(s * al) };
  const tp = { x: e.x + A.Lf * Math.cos(s * (al + be)), y: e.y + A.Lf * Math.sin(s * (al + be)) };
  return { base: rot(head, b), elbow: rot(head, e), tip: rot(head, tp) };
}
function ptSeg(p: XP, a: XP, b: XP): number {
  const dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy; let u = L > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L : 0; u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(p.x - a.x - u * dx, p.y - a.y - u * dy);
}
/** signed core distance: endpoint distances when apart; minus the penetration depth when the cores cross, computed here
 *  as the smallest translation along each segment's normal or along each segment that separates them */
function segSeg(a: XP, b: XP, c: XP, d: XP): number {
  const cr = (p: XP, q: XP, r: XP) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = cr(a, b, c), d2 = cr(a, b, d), d3 = cr(c, d, a), d4 = cr(c, d, b);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    const lab = Math.hypot(b.x - a.x, b.y - a.y), lcd = Math.hypot(d.x - c.x, d.y - c.y);
    return -Math.min(Math.abs(d1) / lab, Math.abs(d2) / lab, Math.abs(d3) / lcd, Math.abs(d4) / lcd);
  }
  return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
}
type XCap = { a: XP; b: XP; r: number };
function bodyCap(ag: XAgent, t: number): XCap {
  const P = xPose(ag.segs, t), h = Math.max(0, ag.body.length_mm - ag.body.width_mm) / 2;
  return { a: { x: P.x - Math.cos(P.th) * h, y: P.y - Math.sin(P.th) * h }, b: { x: P.x + Math.cos(P.th) * h, y: P.y + Math.sin(P.th) * h }, r: ag.body.width_mm / 2 };
}
function staticCapsX(s: XStatic): XCap[] {
  if (s.kind === 'segment') return [{ a: s.a, b: s.b, r: s.r ?? 0 }];
  if (s.kind === 'disc') return [{ a: s.c, b: s.c, r: s.r }];
  return s.pts.map((p, i) => ({ a: p, b: s.pts[(i + 1) % s.pts.length], r: 0 }));
}
const antCapsX = (ag: XAgent, side: 'left' | 'right', t: number): XCap[] => { const w = xAntenna(ag, side, t); return [{ a: w.base, b: w.elbow, r: ag.antenna.r }, { a: w.elbow, b: w.tip, r: ag.antenna.r }]; };
const capsGap = (A: XCap[], B: XCap[]) => { let g = Infinity; for (const x of A) for (const y of B) g = Math.min(g, segSeg(x.a, x.b, y.a, y.b) - x.r - y.r); return g; };

// ---- speed bounds (own derivation): body twist + rotation about the body centre + scanning joints
const twAt = (ag: XAgent, t: number) => segAt(ag.segs, t).tw;
const reach = (A: XAntenna) => Math.abs(A.hx) + A.half + A.Ls + A.Lf;
const jointV = (A: XAntenna) => { const wa = 2 * Math.PI * A.scan.f * A.scan.aa, wb = 2 * Math.PI * A.scan.f * A.scan.ba; return wa * A.Ls + (wa + wb) * A.Lf; };
const antV = (ag: XAgent, t: number) => { const tw = twAt(ag, t); return Math.hypot(tw.v, tw.vl) + Math.abs(tw.w) * reach(ag.antenna) + jointV(ag.antenna); };
const bodyV = (ag: XAgent, t: number) => { const tw = twAt(ag, t); return Math.hypot(tw.v, tw.vl) + Math.abs(tw.w) * Math.max(0, ag.body.length_mm - ag.body.width_mm) / 2; };

export interface XPair { key: string; gap: (t: number) => number; M: (t: number) => number; breaks: number[] }
export function pairsOf(rec: XRecord): XPair[] {
  const out: XPair[] = [], ids = Object.keys(rec.agents).sort();
  for (const id of ids) for (const side of ['left', 'right'] as const) {
    const A = rec.agents[id], bA = A.segs.map((s) => s.t0);
    if (rec.targets.statics) for (const s of rec.statics) if ((s.layer ?? '') === A.layer) { const caps = staticCapsX(s); out.push({ key: `${id}:${side}|static:${s.id}:`, gap: (t) => capsGap(antCapsX(A, side, t), caps), M: (t) => antV(A, t), breaks: bA }); }
    for (const jd of ids) {
      if (jd === id || rec.agents[jd].layer !== A.layer) continue;
      const B = rec.agents[jd], br = [...bA, ...B.segs.map((s) => s.t0)];
      if (rec.targets.bodies) out.push({ key: `${id}:${side}|body:${jd}:`, gap: (t) => capsGap(antCapsX(A, side, t), [bodyCap(B, t)]), M: (t) => antV(A, t) + bodyV(B, t), breaks: br });
      if (rec.targets.antennae && id < jd) for (const s2 of ['left', 'right'] as const) out.push({ key: `${id}:${side}|antenna:${jd}:${s2}`, gap: (t) => capsGap(antCapsX(A, side, t), antCapsX(B, s2, t)), M: (t) => antV(A, t) + antV(B, t), breaks: br });
    }
  }
  return out;
}
const evKey = (e: XEvent) => `${e.agent_id}:${e.side}|${e.target.kind}:${e.target.id}:${e.target.side ?? ''}`;

export interface XReport { pairs: number; events: number; event_violations: string[]; missed: string[]; uncertified: string[]; intervals_checked: number }
export function checkRecord(rec: XRecord, maxDepth = 70): XReport {
  const θ = X_CONTACT_TOL_MM, λ = X_CA_LEVEL_MM, ρ = X_SEP_RES_MM, E = X_EPS_MM, H = rec.horizon_s;
  const rep: XReport = { pairs: 0, events: rec.events.length, event_violations: [], missed: [], uncertified: [], intervals_checked: 0 };
  const pairs = pairsOf(rec); rep.pairs = pairs.length;
  const known = new Set(pairs.map((p) => p.key));
  for (const e of rec.events) if (!known.has(evKey(e))) rep.event_violations.push(`unknown pair ${evKey(e)}`);
  for (const p of pairs) {
    const evs = rec.events.filter((e) => evKey(e) === p.key).sort((a, b) => a.t_s - b.t_s);
    // events alternate start/end
    for (let i = 0; i < evs.length; i++) if (evs[i].phase !== (i % 2 === 0 ? 'start' : 'end')) rep.event_violations.push(`${p.key}: events do not alternate at ${evs[i].t_s}`);
    for (const e of evs) {
      if (!(e.t_s >= rec.t0_s && e.t_s <= H)) rep.event_violations.push(`${p.key}: event outside [t0, H] at ${e.t_s}`);
      if (e.t_s !== e.bracket_s[1] || e.bracket_s[0] > e.bracket_s[1]) rep.event_violations.push(`${p.key}: bad bracket at ${e.t_s}`);
      const g = p.gap(e.t_s);
      if (e.phase === 'start') { if (!(g <= θ + E)) rep.event_violations.push(`${p.key}: start at ${e.t_s} has gap ${g}`); if (e.bracket_s[0] < e.bracket_s[1] && !(p.gap(e.bracket_s[0]) > θ - E)) rep.event_violations.push(`${p.key}: start bracket lo not above θ`); }
      else if (!(g > θ - E)) rep.event_violations.push(`${p.key}: end at ${e.t_s} has gap ${g}`);
    }
    // intervals: [t0, s1) outside, [s1, e1) inside, ...
    const cuts = [rec.t0_s, ...evs.map((e) => e.t_s), H];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const a = cuts[k], b = cuts[k + 1], inside = k % 2 === 1;
      if (!(b >= a)) continue;
      const bk = [a, ...p.breaks.filter((x) => x > a && x < b), b];
      for (let i = 0; i + 1 < bk.length; i++) certify(p, bk[i], bk[i + 1], inside, 0);
    }
    const open = evs.length % 2 === 1, gH = p.gap(H);
    if (open && !(gH <= θ + 2 * ρ + E)) rep.missed.push(`${p.key}: open contact at H but gap ${gH}`);
    if (!open && !(gH > λ - E)) rep.missed.push(`${p.key}: no open contact at H but gap ${gH}`);
  }
  return rep;
  function certify(p: XPair, a: number, b: number, inside: boolean, depth: number): void {
    rep.intervals_checked++;
    const ga = p.gap(a), gb = p.gap(b), M = Math.max(p.M(a), p.M(a + (b - a) / 2)), half = (M * (b - a)) / 2, avg = (ga + gb) / 2;
    if (inside) {
      const lvl = θ + 2 * ρ + E;
      if (ga > lvl || gb > lvl) { rep.missed.push(`${p.key}: inside contact but gap ${Math.max(ga, gb)} near ${ga > lvl ? a : b}`); return; }
      if (avg + half <= lvl) return;
    } else {
      const lvl = λ - E;
      // interval endpoints that are event times may touch θ; the open interval must stay above λ
      if (ga < lvl || gb < lvl) { rep.missed.push(`${p.key}: outside contact but gap ${Math.min(ga, gb)} near ${ga < lvl ? a : b}`); return; }
      if (avg - half >= lvl) return;
    }
    const mid = a + (b - a) / 2;
    if (depth >= maxDepth || !(mid > a && mid < b)) { rep.uncertified.push(`${p.key}: [${a}, ${b}] ${inside ? 'inside' : 'outside'}`); return; }
    certify(p, a, mid, inside, depth + 1); certify(p, mid, b, inside, depth + 1);
  }
}
