/**
 * Demo 2 — the nest as ONE fixed geometry (展示假設). Pure: no DOM, no Three.js, no engine import.
 *
 * Input: data/demo2-nest-layout.json (scenario_assumption: true). The P0-A2 experiment world has NO nest geometry;
 * this layout is a display assumption that the drawing, the routing, the tests and the cut-face mask all share:
 *  - a graph of WALK LINES: tunnels (polylines) and chamber floors, joined at nodes (entrance E, chamber floor ends);
 *  - the CAVITY (what is carved out of the soil) as a signed distance function over the cut plane (sdf < 0 = air);
 *  - positions are ONLY points of the graph (edge, arc length) plus a depth lane z inside the cavity depth, so an ant
 *    can never be drawn inside the soil; routes are shortest paths along the graph (walls block by construction).
 * Nothing here reaches the simulation.
 */
export interface LayoutChamber { id: string; role: 'entry' | 'rest' | 'brood' | 'queen' | 'exchange' | 'pupa'; label_zh: string; x0: number; x1: number; floor: number; height: number }
export interface LayoutTunnel { id: string; from: string; to: string; via: [number, number][]; width?: number }
export interface NestLayout {
  schema: 'antempire.demo2-nest-layout.v1'; scenario_assumption: true; assumption: true; basis: string; label_zh: string;
  provenance: Record<string, unknown>; units: string; depth: { face_z: number; back_z: number };
  tunnel_width_cm: number; entrance: { id: string; x: number; y: number; label_zh: string }; chambers: LayoutChamber[]; tunnels: LayoutTunnel[];
}
export const LAYOUT_SCHEMA = 'antempire.demo2-nest-layout.v1';
/** refuses a layout that is not labelled as a scenario assumption (the page must never show it as engine geometry) */
export function parseLayout(raw: unknown): NestLayout {
  const L = raw as NestLayout;
  if (!L || L.schema !== LAYOUT_SCHEMA) throw new Error('demo2 nest layout: unknown schema');
  if (L.scenario_assumption !== true || L.assumption !== true) throw new Error('demo2 nest layout: must be labelled scenario_assumption: true and assumption: true');
  if (typeof L.label_zh !== 'string' || !L.label_zh.includes('展示假設')) throw new Error('demo2 nest layout: label_zh must say 展示假設');
  if (!Array.isArray(L.chambers) || !Array.isArray(L.tunnels) || !L.entrance) throw new Error('demo2 nest layout: chambers / tunnels / entrance missing');
  return L;
}

export interface P2 { x: number; y: number }
export interface P3 { x: number; y: number; z: number }
/** a place on the graph: edge index, arc length along the edge (cm, from its a-node), depth lane z (cm) */
export interface Pos { edge: number; s: number; z: number }
export interface Edge { id: string; kind: 'tunnel' | 'floor'; chamber: string | null; a: string; b: string; pts: P2[]; cum: number[]; len: number; width: number }
export interface Path { pts: P3[]; cum: number[]; len: number; edge: number[]; es: number[] }
export interface Slot { id: string; chamber: string; pos: Pos; x: number }

/** clearance between the walk line and the tunnel wall below it (cm): the feet walk just above the lower wall */
export const FLOOR_CLEAR_CM = 0.45;
/** how far along a chamber floor a route takes to step over to its walking lane / to its end depth (cm; display) */
export const LANE_STEP_CM = 2.0;
/** how far the dome of a chamber overhangs its floor ends, and how far the cavity reaches below the floor line (cm) */
const DOME_OVERHANG = 0.6, FLOOR_UNDER = 0.35;
/** how far above the entrance node the entrance tunnel's cavity stays open (cm; it cuts through the surface) */
export const ENTRANCE_OPEN_CM = 3;
const hyp = Math.hypot;

function cumOf(pts: readonly P2[]): number[] { const c = [0]; for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + hyp(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)); return c; }
function distSeg(x: number, y: number, a: P2, b: P2): number {
  const vx = b.x - a.x, vy = b.y - a.y, L2 = vx * vx + vy * vy, k = L2 > 0 ? Math.max(0, Math.min(1, ((x - a.x) * vx + (y - a.y) * vy) / L2)) : 0;
  return hyp(x - (a.x + vx * k), y - (a.y + vy * k));
}
/** upward unit normal of a segment direction, scaled by how "floor-like" the segment is (0 = vertical shaft) */
function floorNormal(dx: number, dy: number): { nx: number; ny: number; k: number } {
  const l = hyp(dx, dy) || 1, k = Math.min(1, (2 * Math.abs(dx)) / l);
  let nx = -dy / l, ny = dx / l; if (ny < 0) { nx = -nx; ny = -ny; }
  return { nx, ny, k };
}

export class NestGraph {
  readonly layout: NestLayout;
  readonly nodes = new Map<string, P2>();
  readonly edges: Edge[] = [];
  readonly faceZ: number; readonly backZ: number;
  /** cavity axis of every tunnel (walk line lifted toward the middle of the tunnel) */
  private readonly axes: { pts: P2[]; r: number }[] = [];
  private readonly dist = new Map<string, Map<string, number>>();
  private readonly hop = new Map<string, Map<string, number>>(); // first edge on the shortest node path a → b
  readonly entranceEdge: number;
  /** entranceY: the ground height at the entrance (the E node sits exactly on the drawn ground) */
  constructor(layout: NestLayout, entranceY = 0) {
    this.layout = layout; this.faceZ = layout.depth.face_z; this.backZ = layout.depth.back_z;
    const E = layout.entrance; this.nodes.set(E.id, { x: E.x, y: E.y + entranceY });
    for (const c of layout.chambers) {
      this.nodes.set(`${c.id}.L`, { x: c.x0, y: c.floor }); this.nodes.set(`${c.id}.R`, { x: c.x1, y: c.floor });
      const pts: P2[] = []; const n = Math.max(2, Math.round((c.x1 - c.x0) / 1));
      for (let i = 0; i <= n; i++) pts.push({ x: c.x0 + ((c.x1 - c.x0) * i) / n, y: c.floor });
      const cum = cumOf(pts); this.edges.push({ id: `floor-${c.id}`, kind: 'floor', chamber: c.id, a: `${c.id}.L`, b: `${c.id}.R`, pts, cum, len: cum[cum.length - 1], width: c.height });
    }
    for (const t of layout.tunnels) {
      const a = this.nodes.get(t.from), b = this.nodes.get(t.to); if (!a || !b) throw new Error(`demo2 nest layout: tunnel ${t.id} names an unknown node`);
      const ctrl: P2[] = [a, ...t.via.map(([x, y]) => ({ x, y })), b], pts = smoothPolyline(ctrl), cum = cumOf(pts), width = t.width ?? layout.tunnel_width_cm;
      this.edges.push({ id: t.id, kind: 'tunnel', chamber: null, a: t.from, b: t.to, pts, cum, len: cum[cum.length - 1], width });
      // cavity axis: each vertex lifted along the (averaged) floor normal so the walk line runs near the lower wall
      const lift = width / 2 - FLOOR_CLEAR_CM, ax: P2[] = pts.map((p, i) => {
        let nx = 0, ny = 0, w = 0;
        for (const j of [i - 1, i]) { if (j < 0 || j >= pts.length - 1) continue; const f = floorNormal(pts[j + 1].x - pts[j].x, pts[j + 1].y - pts[j].y); nx += f.nx * f.k; ny += f.ny * f.k; w++; }
        return { x: p.x + (nx / w) * lift, y: p.y + (ny / w) * lift };
      });
      // the entrance tunnel is open to the sky: its cavity continues above the entrance node
      if (t.from === E.id) ax.unshift({ x: ax[0].x, y: ax[0].y + ENTRANCE_OPEN_CM }); else if (t.to === E.id) ax.push({ x: ax[ax.length - 1].x, y: ax[ax.length - 1].y + ENTRANCE_OPEN_CM });
      this.axes.push({ pts: ax, r: width / 2 });
    }
    this.entranceEdge = this.edges.findIndex((e) => e.a === E.id || e.b === E.id);
    if (this.entranceEdge < 0) throw new Error('demo2 nest layout: no tunnel reaches the entrance');
    // all-pairs shortest node distances (Floyd–Warshall; the graph is tiny)
    const ids = [...this.nodes.keys()];
    for (const i of ids) { this.dist.set(i, new Map(ids.map((j) => [j, i === j ? 0 : Infinity]))); this.hop.set(i, new Map()); }
    this.edges.forEach((e, k) => { for (const [p, q] of [[e.a, e.b], [e.b, e.a]] as const) if (e.len < this.dist.get(p)!.get(q)!) { this.dist.get(p)!.set(q, e.len); this.hop.get(p)!.set(q, k); } });
    for (const m of ids) for (const i of ids) for (const j of ids) {
      const d = this.dist.get(i)!.get(m)! + this.dist.get(m)!.get(j)!;
      if (d < this.dist.get(i)!.get(j)! - 1e-12) { this.dist.get(i)!.set(j, d); this.hop.get(i)!.set(j, this.hop.get(i)!.get(m)!); }
    }
    for (const i of ids) for (const j of ids) if (!Number.isFinite(this.dist.get(i)!.get(j)!)) throw new Error(`demo2 nest layout: node ${j} is not reachable from ${i}`);
  }

  chamber(id: string): LayoutChamber { const c = this.layout.chambers.find((x) => x.id === id); if (!c) throw new Error(`no chamber ${id}`); return c; }
  chambersOf(role: LayoutChamber['role']): LayoutChamber[] { return this.layout.chambers.filter((c) => c.role === role); }
  floorEdge(chamberId: string): number { return this.edges.findIndex((e) => e.chamber === chamberId); }
  /** the entrance as a position (the top end of the entrance tunnel) */
  entrancePos(z = 0): Pos { const e = this.edges[this.entranceEdge]; return { edge: this.entranceEdge, s: e.a === this.layout.entrance.id ? 0 : e.len, z }; }
  nodeDistance(a: string, b: string): number { return this.dist.get(a)!.get(b)!; }

  /** signed distance (cm, approximate outside; exact sign) to the cavity in the cut plane: < 0 inside the air space */
  sdf(x: number, y: number): number {
    let d = Infinity;
    for (const c of this.layout.chambers) {
      const cx = (c.x0 + c.x1) / 2, rx = (c.x1 - c.x0) / 2 + DOME_OVERHANG, ex = (x - cx) / rx, ey = (y - c.floor) / c.height;
      const dome = (hyp(ex, ey) - 1) * Math.min(rx, c.height), fl = c.floor - FLOOR_UNDER - y;
      d = Math.min(d, Math.max(dome, fl));
    }
    for (const a of this.axes) { let m = Infinity; for (let i = 1; i < a.pts.length; i++) m = Math.min(m, distSeg(x, y, a.pts[i - 1], a.pts[i])); d = Math.min(d, m - a.r); }
    return d;
  }
  /** the cavity as drawing primitives (the same shapes sdf() measures): domes over the chamber floors and round-capped
   *  tubes along the tunnel axes — the cut-face mask is painted from exactly these */
  cavityShapes(): { domes: { cx: number; floor: number; rx: number; h: number; under: number }[]; tubes: { pts: P2[]; r: number }[] } {
    return { domes: this.layout.chambers.map((c) => ({ cx: (c.x0 + c.x1) / 2, floor: c.floor, rx: (c.x1 - c.x0) / 2 + DOME_OVERHANG, h: c.height, under: FLOOR_UNDER })), tubes: this.axes.map((a) => ({ pts: a.pts.map((p) => ({ ...p })), r: a.r })) };
  }
  /** bounding box of the cavity (cm), padded */
  bounds(pad = 2): { x0: number; x1: number; y0: number; y1: number } {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const e of this.edges) for (const p of e.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y + (e.kind === 'floor' ? e.width : e.width / 2)); }
    return { x0: x0 - pad - 2, x1: x1 + pad + 2, y0: y0 - pad - 2, y1: y1 + pad };
  }

  /** the 2-D point of a position (clamped to its edge) */
  point(p: Pos): P3 {
    const e = this.edges[p.edge], s = Math.max(0, Math.min(e.len, p.s));
    let i = 1; while (i < e.cum.length - 1 && e.cum[i] < s) i++;
    const seg = e.cum[i] - e.cum[i - 1] || 1, k = (s - e.cum[i - 1]) / seg, a = e.pts[i - 1], b = e.pts[i];
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: p.z };
  }
  private nodeS(e: Edge, node: string): number { return node === e.a ? 0 : e.len; }
  /** vertices of edge k from arc s0 to s1 (either direction), inclusive of both ends */
  private run(k: number, s0: number, s1: number): { p: P2; s: number }[] {
    const e = this.edges[k], out: { p: P2; s: number }[] = [], fwd = s1 >= s0, pt = (s: number) => { const q = this.point({ edge: k, s, z: 0 }); return { p: { x: q.x, y: q.y }, s }; };
    out.push(pt(s0));
    const idx = e.cum.map((c, i) => ({ c, i })).filter(({ c }) => (fwd ? c > s0 + 1e-9 && c < s1 - 1e-9 : c < s0 - 1e-9 && c > s1 + 1e-9));
    for (const { c, i } of fwd ? idx : idx.reverse()) out.push({ p: e.pts[i], s: c });
    out.push(pt(s1));
    return out;
  }
  /**
   * Shortest route along the graph from a to b. lane = the depth lane used inside tunnels and at joints (cm); the
   * path leaves a.z and arrives at b.z; floorLane = the lane kept along chamber floors. Every vertex is a graph point
   * (edge, arc length).
   */
  route(a: Pos, b: Pos, lane = 0, floorLane = lane): Path {
    const runs: { k: number; v: { p: P2; s: number }[] }[] = [];
    if (a.edge === b.edge) runs.push({ k: a.edge, v: this.run(a.edge, a.s, b.s) });
    else {
      const ea = this.edges[a.edge], eb = this.edges[b.edge]; let best = Infinity, na = ea.a, nb = eb.a;
      for (const p of [ea.a, ea.b]) for (const q of [eb.a, eb.b]) { const c = Math.abs(a.s - this.nodeS(ea, p)) + this.dist.get(p)!.get(q)! + Math.abs(b.s - this.nodeS(eb, q)); if (c < best - 1e-12) { best = c; na = p; nb = q; } }
      runs.push({ k: a.edge, v: this.run(a.edge, a.s, this.nodeS(ea, na)) });
      let at = na; let guard = 0;
      while (at !== nb) { const k = this.hop.get(at)!.get(nb)!, e = this.edges[k], to = e.a === at ? e.b : e.a; runs.push({ k, v: this.run(k, this.nodeS(e, at), this.nodeS(e, to)) }); at = to; if (++guard > 64) throw new Error('route: no path'); }
      runs.push({ k: b.edge, v: this.run(b.edge, this.nodeS(eb, nb), b.s) });
    }
    const pts: P3[] = [], edge: number[] = [], es: number[] = [];
    runs.forEach((r, ri) => {
      const first = ri === 0, last = ri === runs.length - 1, z0 = first ? a.z : lane, z1 = last ? b.z : lane, s0 = r.v[0].s, s1 = r.v[r.v.length - 1].s, total = Math.abs(s1 - s0), floor = this.edges[r.k].kind === 'floor' && total > 1e-9;
      // On a chamber floor the route steps over to the walking lane (floorLane) within LANE_STEP_CM of where it starts,
      // keeps that lane, and steps to its end depth within the last LANE_STEP_CM (a short run stays near the straight line):
      // a walker does not travel along the back of a chamber through the places where others stand or rest.
      const d = Math.min(LANE_STEP_CM, total / 2), k = Math.max(0, Math.min(1, (total - 1.5) / 4)), fl = (z0 + z1) / 2 + (floorLane - (z0 + z1) / 2) * k;
      let vs = r.v;
      if (floor) { const sg = s1 >= s0 ? 1 : -1, pt = (q: number) => { const g = this.point({ edge: r.k, s: q, z: 0 }); return { p: { x: g.x, y: g.y }, s: q }; }; vs = [...r.v, pt(s0 + sg * d), ...(d < total / 2 - 1e-9 ? [pt(s1 - sg * d)] : [])].sort((x, y) => Math.abs(x.s - s0) - Math.abs(y.s - s0)); }
      vs.forEach((v, vi) => { // a run of zero length (the route starts or ends exactly on a node) still changes lane from its first vertex to its last
        const dist = Math.abs(v.s - s0), u = total > 0 ? dist / total : first && last ? 0 : vs.length > 1 ? vi / (vs.length - 1) : first ? 0 : 1;
        const z = floor ? (dist < d - 1e-9 ? z0 + (fl - z0) * (dist / d) : total - dist < d - 1e-9 ? z1 + (fl - z1) * ((total - dist) / d) : fl) : z0 + (z1 - z0) * u;
        pts.push({ x: v.p.x, y: v.p.y, z }); edge.push(r.k); es.push(v.s); });
    });
    const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + hyp(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
    return { pts, cum, len: cum[cum.length - 1], edge, es };
  }
  /** route length without building the path */
  routeLength(a: Pos, b: Pos): number { return this.route(a, b).len; }

  /**
   * Standing places on the floor of a chamber: columns along the floor, rows in depth. antLen = the DRAWN body length
   * (cm) so magnified ants do not overlap more than necessary (display arrangement).
   */
  slots(chamberId: string, antLen: number): Slot[] {
    const c = this.chamber(chamberId), k = this.floorEdge(chamberId), margin = 1.1, usable = c.x1 - c.x0 - 2 * margin;
    const pitchX = Math.max(antLen * 0.95, 1.1), cols = Math.max(1, Math.floor(usable / pitchX) + 1), zLo = this.backZ + 0.7, zHi = this.faceZ - 0.9;
    const pitchZ = Math.max(antLen * 0.62, 0.8), rows = Math.max(1, Math.floor((zHi - zLo) / pitchZ) + 1), out: Slot[] = [];
    for (let r = 0; r < rows; r++) for (let i = 0; i < cols; i++) {
      const x = c.x0 + margin + (cols > 1 ? (usable * i) / (cols - 1) : usable / 2) + (r % 2 ? pitchX * 0.4 : 0);
      if (x > c.x1 - margin * 0.6) continue;
      out.push({ id: `${chamberId}:${r}:${i}`, chamber: chamberId, x, pos: { edge: k, s: x - c.x0, z: rows > 1 ? zHi - ((zHi - zLo) * r) / (rows - 1) : (zLo + zHi) / 2 } });
    }
    return out;
  }
}

/** rounds the corners of a control polyline (Chaikin, two passes; both ends stay exactly on their nodes) */
export function smoothPolyline(ctrl: readonly P2[]): P2[] {
  let pts = ctrl.map((p) => ({ x: p.x, y: p.y }));
  for (let pass = 0; pass < 2; pass++) {
    const out: P2[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1];
      if (i > 0) out.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      if (i < pts.length - 2) out.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    out.push(pts[pts.length - 1]); pts = out;
  }
  return pts;
}

/** point of a path at arc length s, with the smoothed unit tangent and the graph place there */
export function pathAt(P: Path, s: number): { x: number; y: number; z: number; tx: number; ty: number; tz: number; edge: number; es: number } {
  const n = P.pts.length - 1, at = (q: number): P3 & { i: number; k: number } => {
    const c = Math.max(0, Math.min(P.len, q)); let i = 1; while (i < n && P.cum[i] < c) i++;
    const seg = P.cum[i] - P.cum[i - 1], k = seg > 0 ? (c - P.cum[i - 1]) / seg : 0, a = P.pts[i - 1], b = P.pts[Math.min(n, i)];
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, i, k };
  };
  if (n < 1 || P.len <= 0) { const p = P.pts[0]; return { ...p, tx: 1, ty: 0, tz: 0, edge: P.edge[0], es: P.es[0] }; }
  const p = at(s), h = Math.min(0.7, P.len / 2), a = at(s - h), b = at(s + h);
  let tx = b.x - a.x, ty = b.y - a.y, tz = b.z - a.z; const l = hyp(tx, ty, tz) || 1; tx /= l; ty /= l; tz /= l;
  // the graph place: the two vertices of a path segment always lie on the same edge (joints repeat the node vertex)
  const i0 = p.i - 1, i1 = Math.min(n, p.i), same = P.edge[i0] === P.edge[i1];
  return { x: p.x, y: p.y, z: p.z, tx, ty, tz, edge: same ? P.edge[i0] : P.edge[i1], es: same ? P.es[i0] + (P.es[i1] - P.es[i0]) * p.k : P.es[i1] };
}

/** the "up" of an ant walking with tangent (tx, ty) in the cut plane: the floor normal on a floor-like slope; on a
 *  steep shaft it turns toward the viewer (the ant climbs the back wall and is seen from above). Display. */
export function upFor(tx: number, ty: number): P3 {
  const f = floorNormal(tx, ty), ux = f.nx * f.k, uy = f.ny * f.k, uz = 1 - f.k, l = hyp(ux, uy, uz) || 1;
  return { x: ux / l, y: uy / l, z: uz / l };
}
