/**
 * Art kit: top view of a Pheidole megacephala MINOR worker (drawing only; majors are not drawn because the engine does
 * not record any worker's caste). Pure and DOM-free: returns draw lists (art-core) per animation frame.
 *
 * Local frame: body length = 100 units from mandible tip (+50) to gaster tip (−50); +x = forward, +y = the ant's right.
 * Proportions: head width ≈ 0.21 body length (minor head width 0.50–0.61 mm [R99] over ≈2.4–2.5 mm body [R93, R94]);
 * everything else (segment lengths, leg posture, colours) is 示意 / 遊戲假設 — see docs/game-art-style.md §4.
 *
 * Walk: alternating tripod gait, WALK_FRAMES frames per cycle. Set A = L1, R2, L3; set B = R1, L2, R3. A foot in stance
 * moves backward relative to the body by STRIDE units over half a cycle, so the body advances CYCLE_ADVANCE = 2·STRIDE
 * units per cycle. walkCycles() turns distance travelled on screen into cycles with that ratio, i.e. a planted foot
 * does not slide over the ground at the drawn scale (kinematic consistency rule, not a measured stride).
 */
import { P, ellipse, light, smoothClosed, smoothstep, type DrawList, type Shape } from './art-core.ts';

export const WALK_FRAMES = 12;
export const IDLE_FRAMES = 8;
/** foot travel during one stance, in body-length/100 units (遊戲假設) */
export const STRIDE = 10;
export const CYCLE_ADVANCE = 2 * STRIDE;
/** sprite bounds in local units (legs and antennae included) */
export const ANT_EXTENT = { x0: -56, x1: 74, y0: -38, y1: 38 } as const;
/** body height above the ground in local units (the renderer offsets the shadow in SCREEN space by light().shadow) */
export const ANT_BODY_HEIGHT = 5;

export type LegId = 'L1' | 'L2' | 'L3' | 'R1' | 'R2' | 'R3';
export const TRIPOD_A: LegId[] = ['L1', 'R2', 'L3'];
export const TRIPOD_B: LegId[] = ['R1', 'L2', 'R3'];
export const tripodSet = (leg: LegId): 'A' | 'B' => (TRIPOD_A.includes(leg) ? 'A' : 'B');

/** Base ant palette (a mid "light brown" worker). Colour: R99 (Sarnat et al. 2015, P. megacephala account) describes
 *  the species as "light brown to dark brown"; individual variants come from antPalette(). Exact tones are 示意. */
export const ANT_PALETTE = {
  outline: 'rgba(38,18,6,0.9)',
  head: ['#d29257', '#a95f2b', '#6d3514'], // highlight, base, rim
  meso: ['#dca062', '#b26a33', '#73391a'],
  waist: ['#cf9055', '#a2602d', '#6a3416'],
  gaster: ['#6a4027', '#3c2213', '#1c0f07'],
  limb: '#b97d45', limbDark: '#7c4a22', eye: '#1a0e08', mandible: '#8a4a1f',
} as const;
export type AntPalette = { outline: string; head: readonly string[]; meso: readonly string[]; waist: readonly string[]; gaster: readonly string[]; limb: string; limbDark: string; eye: string; mandible: string };
/** number of deterministic colour variants (one atlas each) */
export const PALETTE_VARIANTS = 5;
const hexShade = (hex: string, k: number, warm: number) => { const n = parseInt(hex.slice(1), 16), c = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; const o = [c[0] * k + warm * 6, c[1] * k, c[2] * k - warm * 4].map((v) => Math.max(0, Math.min(255, Math.round(v)))); return '#' + o.map((v) => v.toString(16).padStart(2, '0')).join(''); };
/** Colour variant v ∈ [0, PALETTE_VARIANTS): light brown (0) … dark brown (last), within the species' documented
 *  light-to-dark-brown range [R99]; the mapping of an individual to a variant is drawing only (示意). */
export function antPalette(v: number): AntPalette {
  const u = Math.max(0, Math.min(1, v / (PALETTE_VARIANTS - 1))), k = 1.12 - u * 0.5, kg = 1.08 - u * 0.3, warm = 1 - u;
  const m = (a: readonly string[], kk: number) => a.map((h) => hexShade(h, kk, warm));
  return { ...ANT_PALETTE, head: m(ANT_PALETTE.head, k), meso: m(ANT_PALETTE.meso, k), waist: m(ANT_PALETTE.waist, k), gaster: m(ANT_PALETTE.gaster, kg), limb: hexShade(ANT_PALETTE.limb, 0.9 + (k - 0.62) * 0.4, warm), limbDark: hexShade(ANT_PALETTE.limbDark, 0.9 + (k - 0.62) * 0.4, warm), mandible: hexShade(ANT_PALETTE.mandible, k, warm) };
}
let PAL: AntPalette = ANT_PALETTE;

interface Leg { id: LegId; side: -1 | 1; base: [number, number]; coxa: number; femur: number; tibia: number; tarsus: number; foot: [number, number]; tarsDir: [number, number]; w: number }
/** coxal insertions on the mesosoma (fore, mid, hind) and neutral foot placement (right side; left mirrors y) */
const LEG_DEF: Omit<Leg, 'id' | 'side'>[] = [
  { base: [15.5, 3.6], coxa: 3.8, femur: 11, tibia: 10, tarsus: 8, foot: [31, 22], tarsDir: [0.78, 0.62], w: 3.3 },
  { base: [6.5, 3.4], coxa: 3.0, femur: 11, tibia: 10.5, tarsus: 8.5, foot: [4, 27], tarsDir: [-0.05, 1], w: 3.1 },
  { base: [0.5, 3.0], coxa: 3.4, femur: 13.5, tibia: 12.5, tarsus: 10, foot: [-26, 23], tarsDir: [-0.82, 0.57], w: 3.1 },
];
export const LEGS: Leg[] = (['L', 'R'] as const).flatMap((s) => LEG_DEF.map((d, i) => {
  const side = s === 'L' ? -1 : 1 as -1 | 1;
  return { ...d, id: `${s}${i + 1}` as LegId, side, base: [d.base[0], d.base[1] * side], foot: [d.foot[0], d.foot[1] * side], tarsDir: [d.tarsDir[0], d.tarsDir[1] * side] } as Leg;
}));

/** Stance/swing state of one leg at cycle phase φ ∈ [0,1). s ∈ [-0.5, 0.5] = progress along the leg's stride vector
 *  (stance: −0.5 → +0.5; swing: back again, lifted). offset = the straight-walk foot x displacement (= −STRIDE·s). */
export function legState(leg: LegId, phi: number): { stance: boolean; offset: number; lift: number; s: number } {
  const p = (((phi + (tripodSet(leg) === 'A' ? 0 : 0.5)) % 1) + 1) % 1;
  if (p < 0.5) { const s = -0.5 + p / 0.5; return { stance: true, offset: -STRIDE * s, lift: 0, s }; }
  const u = (p - 0.5) / 0.5, s = 0.5 - smoothstep(u);
  return { stance: false, offset: -STRIDE * s, lift: Math.sin(Math.PI * u), s };
}

/**
 * Gaits (sprite rows). The sprite never chooses a turn by itself: selectGait() picks a turning row ONLY from an
 * angular velocity supplied by an authoritative source (physics heading / ω, V6-2). The replay records no ω — its
 * heading changes only at recorded edges — so replay mode uses 'walk' / 'idle' only.
 *  - curveL / curveR: curved walk; the inner legs take shorter strides (inner/outer stride ratio CURVE_INNER).
 *  - pivotL / pivotR: turn in place; stance feet sweep tangentially around the body (left and right sides opposite).
 * R = turning toward the ant's right = clockwise on screen (y down) = ω > 0.
 */
export type Gait = 'walk' | 'idle' | 'curveL' | 'curveR' | 'pivotL' | 'pivotR';
export const GAITS: Gait[] = ['walk', 'idle', 'curveL', 'curveR', 'pivotL', 'pivotR'];
export const framesOf = (g: Gait) => (g === 'idle' ? IDLE_FRAMES : WALK_FRAMES);
export const CURVE_INNER = 0.4;       // 遊戲假設 (kinematic drawing rule)
export const PIVOT_STRIDE = 10;       // units of foot sweep per stance (遊戲假設)
const PIVOT_X = 5;                    // pivot point on the body axis (units)
/** stride vector (stance motion of the foot relative to the body) for a leg in a gait */
export function strideVector(g: Gait, legId: LegId): [number, number] {
  const lg = LEGS.find((l) => l.id === legId) as Leg;
  if (g === 'idle') return [0, 0];
  if (g === 'walk') return [-STRIDE, 0];
  if (g === 'curveL' || g === 'curveR') { const inner = (g === 'curveR') === (lg.side === 1); return [-STRIDE * (inner ? CURVE_INNER : 1), 0]; }
  const dx = lg.foot[0] - PIVOT_X, dy = lg.foot[1], r = Math.hypot(dx, dy), k = (g === 'pivotR' ? 1 : -1) * PIVOT_STRIDE / r;
  return [dy * k, -dx * k]; // body turns clockwise (R) → planted feet sweep counter-clockwise relative to it
}
/** body rotation per pivot cycle (two stances, each rotating the body by stride / mean foot radius) */
export const PIVOT_RAD_PER_CYCLE = 2 * PIVOT_STRIDE / (LEG_DEF.reduce((a, d) => a + Math.hypot(d.foot[0] - PIVOT_X, d.foot[1]), 0) / LEG_DEF.length);
/** gait from an AUTHORITATIVE angular velocity (rad/s, screen frame, + = clockwise) and speed (body lengths/s).
 *  omega undefined/null (replay mode) → never a turning gait. */
export const OMEGA_MIN = 0.3, PIVOT_MAX_SPEED = 0.3;
export function selectGait(o: { moving: boolean; speedBL?: number | null; omega?: number | null }): Gait {
  if (o.omega === undefined || o.omega === null || Math.abs(o.omega) < OMEGA_MIN) return o.moving ? 'walk' : 'idle';
  const right = o.omega > 0;
  if (!o.moving || (o.speedBL ?? 0) < PIVOT_MAX_SPEED) return right ? 'pivotR' : 'pivotL';
  return right ? 'curveR' : 'curveL';
}
/** cycles of a pivot turn from the heading change it has made (radians, from the authoritative source) */
export const pivotCycles = (dTheta: number) => Math.abs(dTheta) / PIVOT_RAD_PER_CYCLE;

/** Knee in top view: the femora splay laterally and the tibiae turn toward the foot (legs bend mostly in the vertical
 *  plane, so the femur is drawn foreshortened). Pure geometry for drawing; not a measured posture. */
function knee(bx: number, by: number, tx: number, ty: number, femur: number, side: number): [number, number] {
  const dx = tx - bx, dy = ty - by, d = Math.hypot(dx, dy) || 1, ux = dx / d * 0.55, uy = dy / d * 0.55 + side * 0.45, n = Math.hypot(ux, uy) || 1;
  const L = Math.min(femur * 0.85, d * 0.62);
  return [bx + (ux / n) * L, by + (uy / n) * L];
}

export interface LegPose { id: LegId; set: 'A' | 'B'; stance: boolean; lift: number; pts: [number, number][] /* coxa base, coxa end, knee, tibia end, foot */ }
export interface AntPose { legs: LegPose[]; ant: { L: [number, number][]; R: [number, number][] }; headYaw: number; gasterYaw: number }

/** Antenna: scape from the torulus, elbow, then 11 funicular segments ending in a 3-segment club (12 segments). */
const FUNICULUS = [1.4, 1.05, 1.05, 1.05, 1.1, 1.15, 1.2, 1.3, 2.3, 2.6, 3.7]; // segment lengths, units (示意)
const FUN_W = [1.7, 1.5, 1.5, 1.5, 1.55, 1.6, 1.7, 1.85, 2.6, 2.95, 3.1];
/** the funiculus is angled down toward the substrate, so from above it reads shorter (foreshortening, 示意) */
const FUN_FORESHORTEN = 0.8;
export const ANTENNA_SEGMENTS = 1 + FUNICULUS.length; // scape + 11 = 12
export const ANTENNA_CLUB = 3;
function antenna(side: number, scapeAng: number, funAng: number, reach = 1): [number, number][] {
  const root: [number, number] = [40, 3.4 * side], scape = 25.5; // SL ≈ 1.06 × HL (R99 minor: SL 0.61–0.72 mm, HL 0.57–0.68 mm; scapes surpass the head margin)
  const elbow: [number, number] = [root[0] + Math.cos(scapeAng) * scape, root[1] + Math.sin(scapeAng) * scape * side];
  const pts: [number, number][] = [root, elbow]; let a = funAng, x = elbow[0], y = elbow[1];
  for (let i = 0; i < FUNICULUS.length; i++) { a += -0.075; const l = FUNICULUS[i] * FUN_FORESHORTEN * reach; x += Math.cos(a) * l; y += Math.sin(a) * l * side; pts.push([x, y]); }
  return pts;
}
/** neck pivot of the head (local units): head yaw rotates the head, mandibles and antenna roots about it */
export const NECK: readonly [number, number] = [21, 0];
/** Antenna polyline (13 points: torulus, elbow, 11 funicular joints) in the local frame at head yaw 0. side −1 = left. */
export const antennaPoints = (side: -1 | 1, scape: number, fun: number, reach = 1) => antenna(side, scape, fun, reach);

/** Pose for frame `frame` of a gait (walk/curve/pivot: WALK_FRAMES frames; idle: IDLE_FRAMES). */
export function antPose(kind: Gait, frame: number): AntPose {
  const stepping = kind !== 'idle', n = framesOf(kind), phi = (((frame % n) + n) % n) / n, w = Math.PI * 2 * phi;
  const legs: LegPose[] = LEGS.map((lg) => {
    const st = stepping ? legState(lg.id, phi) : { stance: true, offset: 0, lift: 0, s: 0 }, v = strideVector(kind, lg.id);
    const pull = st.lift * 3.2; // a lifted foot reads closer to the body from above
    const foot: [number, number] = [lg.foot[0] + v[0] * st.s, lg.foot[1] + v[1] * st.s - lg.side * pull];
    const tr = lg.tarsus * (1 - st.lift * 0.12), ta = -v[0] * st.s * 0.012 * lg.side;
    const td: [number, number] = [lg.tarsDir[0] * Math.cos(ta) - lg.tarsDir[1] * Math.sin(ta), lg.tarsDir[0] * Math.sin(ta) + lg.tarsDir[1] * Math.cos(ta)];
    const tib: [number, number] = [foot[0] - td[0] * tr, foot[1] - td[1] * tr];
    const cx = lg.base[0] + (lg.id.endsWith('1') ? 1.2 : lg.id.endsWith('3') ? -1.4 : 0), ce: [number, number] = [cx, lg.base[1] + lg.side * lg.coxa];
    const kn = knee(ce[0], ce[1], tib[0], tib[1], lg.femur, lg.side);
    return { id: lg.id, set: tripodSet(lg.id), stance: st.stance, lift: st.lift, pts: [lg.base, ce, kn, tib, foot] };
  });
  // antennae: stepping = steady forward sweep, the two sides out of phase (turning: both lean into the turn);
  // idle = slow twitching loop
  const turn = kind.endsWith('R') ? 1 : kind.endsWith('L') ? -1 : 0;
  const sw = (side: number) => stepping ? Math.sin(w + (side > 0 ? 0 : Math.PI)) : Math.sin(w + side) * 0.6 + Math.sin(2 * w + side * 2) * 0.5;
  // angles are measured from the body axis toward the OUTSIDE: the scape points antero-laterally, the funiculus forward
  const lean = (side: number) => turn * side * 0.18;
  const ant = { L: antenna(-1, 0.98 + sw(-1) * 0.08 + lean(-1), 0.3 + sw(-1) * 0.14 + lean(-1)), R: antenna(1, 0.98 + sw(1) * 0.08 + lean(1), 0.3 + sw(1) * 0.14 + lean(1)) };
  const sway = stepping && !kind.startsWith('pivot') ? 1 : 0.3;
  return { legs, ant, headYaw: stepping ? Math.sin(w) * 0.035 * sway + turn * 0.07 : 0, gasterYaw: stepping ? -Math.sin(w) * 0.05 * sway - turn * 0.06 : 0 };
}

/** Display micro-pose input (display-motion.ts MicroState shape): head yaw + per-side antenna joint angles. */
export interface MicroPose { headYaw: number; L: { scape: number; fun: number; reach: number }; R: { scape: number; fun: number; reach: number } }
export const NEUTRAL_POSE: MicroPose = { headYaw: 0, L: { scape: 0.98, fun: 0.3, reach: 0.85 }, R: { scape: 0.98, fun: 0.3, reach: 0.85 } };
/**
 * Continuous pose (detail drawing, not baked): gait phase φ (cycles, continuous, driven by distance travelled), walk
 * weight w ∈ [0,1] (display blend walk ↔ stand: stride and foot lift scale with w, so starting and stopping ease
 * instead of popping; w = 0 → all six feet planted at the neutral posture), and an optional micro-pose (head yaw and
 * independent antennae). The gaster follows the stance phase slightly (gait-coupled, scaled by w); no free-running
 * periodic sway. A turning gait only comes from the caller (authoritative ω or the display ease toward a recorded
 * heading), never chosen here.
 */
export function antPoseAt(kind: Gait, phi: number, o: { walkW?: number; micro?: MicroPose; /** stance sweep multiplier (display stride; default 1 = STRIDE) */ stride?: number } = {}): AntPose {
  const w = Math.max(0, Math.min(1, o.walkW ?? (kind === 'idle' ? 0 : 1))), p = ((phi % 1) + 1) % 1, stepKind: Gait = kind === 'idle' ? 'walk' : kind, sk = o.stride ?? 1;
  const legs: LegPose[] = LEGS.map((lg) => {
    const st0 = legState(lg.id, p), st = { stance: w < 0.02 ? true : st0.stance, lift: st0.lift * w, s: st0.s * w }, v0 = strideVector(stepKind, lg.id), v: [number, number] = sk === 1 ? v0 : [v0[0] * sk, v0[1] * sk];
    const pull = st.lift * 3.2;
    const foot: [number, number] = [lg.foot[0] + v[0] * st.s, lg.foot[1] + v[1] * st.s - lg.side * pull];
    const tr = lg.tarsus * (1 - st.lift * 0.12), ta = -v[0] * st.s * 0.012 * lg.side;
    const td: [number, number] = [lg.tarsDir[0] * Math.cos(ta) - lg.tarsDir[1] * Math.sin(ta), lg.tarsDir[0] * Math.sin(ta) + lg.tarsDir[1] * Math.cos(ta)];
    const tib: [number, number] = [foot[0] - td[0] * tr, foot[1] - td[1] * tr];
    const cx = lg.base[0] + (lg.id.endsWith('1') ? 1.2 : lg.id.endsWith('3') ? -1.4 : 0), ce: [number, number] = [cx, lg.base[1] + lg.side * lg.coxa];
    const kn = knee(ce[0], ce[1], tib[0], tib[1], lg.femur, lg.side);
    return { id: lg.id, set: tripodSet(lg.id), stance: st.stance, lift: st.lift, pts: [lg.base, ce, kn, tib, foot] };
  });
  const m = o.micro ?? NEUTRAL_POSE;
  return { legs, ant: { L: antenna(-1, m.L.scape, m.L.fun, m.L.reach), R: antenna(1, m.R.scape, m.R.fun, m.R.reach) }, headYaw: m.headYaw, gasterYaw: -Math.sin(Math.PI * 2 * p) * 0.035 * w };
}
/** Which pieces to draw: everything, the trunk (legs + body without head and antennae; the shadow keeps the head
 *  silhouette at yaw 0), or the head alone (yaw 0; rotated about NECK at draw time). */
export type AntParts = 'all' | 'trunk' | 'head';

const rotAbout = (pts: [number, number][], px: number, py: number, a: number): [number, number][] => pts.map(([x, y]) => [px + (x - px) * Math.cos(a) - (y - py) * Math.sin(a), py + (x - px) * Math.sin(a) + (y - py) * Math.cos(a)]);
/** tapered capsule between two points */
function taper(x0: number, y0: number, x1: number, y1: number, w0: number, w1: number): string {
  const dx = x1 - x0, dy = y1 - y0, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L, ux = dx / L, uy = dy / L, a = w0 / 2, b = w1 / 2;
  return new P().M(x0 + nx * a, y0 + ny * a).L(x1 + nx * b, y1 + ny * b).Q(x1 + nx * b + ux * b * 1.3, y1 + ny * b + uy * b * 1.3, x1 + ux * b, y1 + uy * b)
    .Q(x1 - nx * b + ux * b * 1.3, y1 - ny * b + uy * b * 1.3, x1 - nx * b, y1 - ny * b).L(x0 - nx * a, y0 - ny * a)
    .Q(x0 - nx * a - ux * a * 1.3, y0 - ny * a - uy * a * 1.3, x0 - ux * a, y0 - uy * a).Q(x0 + nx * a - ux * a * 1.3, y0 + ny * a - uy * a * 1.3, x0 + nx * a, y0 + ny * a).Z().toString();
}
const OUT = (d: string, fill: Shape['fill'], lw = 0.55): Shape => ({ d, fill, stroke: ANT_PALETTE.outline, lw, minPx: 0.45 });
/** symmetric dorsal shading (no baked light direction: the sprite rotates, the key light does not) */
const dorsal = (cx: number, cy: number, rx: number, ry: number, c: readonly string[]) => ({ rad: [cx + rx * 0.1, cy, Math.min(rx, ry) * 0.05, cx, cy, Math.max(rx, ry) * 1.05] as [number, number, number, number, number, number], stops: [[0, c[0]], [0.55, c[1]], [1, c[2]]] as [number, string][] });

/** cylinder shading across a limb segment: dark rims, light core (symmetric, rotation-safe) */
function cyl(x0: number, y0: number, x1: number, y1: number, w: number, base: string, core: string): Shape['fill'] {
  const L = Math.hypot(x1 - x0, y1 - y0) || 1, nx = -(y1 - y0) / L, ny = (x1 - x0) / L, mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
  return { lin: [mx - nx * w / 2, my - ny * w / 2, mx + nx * w / 2, my + ny * w / 2], stops: [[0, PAL.limbDark], [0.4, core], [0.62, base], [1, PAL.limbDark]] };
}
function legShapes(lp: LegPose): DrawList {
  const lg = LEGS.find((l) => l.id === lp.id) as Leg, [b, ce, k, t, f] = lp.pts, out: DrawList = [];
  const base = lp.lift > 0.05 ? hexShade(PAL.limb, 1.08, 0) : PAL.limb, core = hexShade(PAL.limb, 1.22, 0); // a raised leg catches a little more light
  const seg = (p: [number, number], q: [number, number], w0: number, w1: number, lw = 0.5) => out.push(OUT(taper(p[0], p[1], q[0], q[1], w0, w1), cyl(p[0], p[1], q[0], q[1], Math.max(w0, w1), base, core), lw));
  out.push(OUT(taper(b[0], b[1], ce[0], ce[1], lg.w + 1.4, lg.w + 0.8), cyl(b[0], b[1], ce[0], ce[1], lg.w + 1.4, hexShade(PAL.limb, 0.9, 0), hexShade(PAL.limb, 1.08, 0))));
  // femur: clubbed in its distal half
  const fm: [number, number] = [ce[0] + (k[0] - ce[0]) * 0.55, ce[1] + (k[1] - ce[1]) * 0.55];
  seg(ce, fm, lg.w * 0.85, lg.w * 1.3); seg(fm, k, lg.w * 1.3, lg.w * 0.8);
  seg(k, t, lg.w * 0.6, lg.w * 0.48);                                                    // tibia
  // tarsus: basitarsus + distal tarsomeres, then the pretarsal claw
  const mx = t[0] + (f[0] - t[0]) * 0.52, my = t[1] + (f[1] - t[1]) * 0.52;
  seg(t, [mx, my], lg.w * 0.42, lg.w * 0.34, 0.42); seg([mx, my], f, lg.w * 0.34, lg.w * 0.26, 0.42);
  const dl = Math.hypot(f[0] - t[0], f[1] - t[1]) || 1, ux = (f[0] - t[0]) / dl, uy = (f[1] - t[1]) / dl;
  for (let i = 1; i <= 3; i++) { const q = 0.52 + i * 0.12, bx = t[0] + (f[0] - t[0]) * q, by = t[1] + (f[1] - t[1]) * q; out.push({ d: ellipse(bx, by, 0.32, 0.32), fill: 'rgba(60,30,10,0.55)' }); } // tarsomere joints
  out.push({ d: new P().M(f[0] - uy * 0.45, f[1] + ux * 0.45).L(f[0] + ux * 0.7, f[1] + uy * 0.7).L(f[0] + uy * 0.45, f[1] - ux * 0.45).toString(), stroke: 'rgba(38,18,6,0.7)', lw: 0.22, cap: 'round' });
  return out;
}

function antennaShapes(pts: [number, number][]): DrawList {
  const out: DrawList = [], [r, e] = pts;
  out.push(OUT(taper(r[0], r[1], e[0], e[1], 1.1, 2.0), cyl(r[0], r[1], e[0], e[1], 2, PAL.limb, hexShade(PAL.limb, 1.2, 0)), 0.45)); // scape, thickening toward the elbow
  for (let i = 0; i < FUNICULUS.length; i++) {
    const a = pts[i + 1], b = pts[i + 2], club = i >= FUNICULUS.length - ANTENNA_CLUB;
    const cx = (a[0] + b[0]) / 2, cy = (a[1] + b[1]) / 2, ang = Math.atan2(b[1] - a[1], b[0] - a[0]);
    out.push(OUT(ellipse(cx, cy, FUNICULUS[i] * FUN_FORESHORTEN * 0.6, FUN_W[i] / 2, ang), { rad: [cx, cy, 0, cx, cy, FUN_W[i]], stops: [[0, hexShade(PAL.limb, club ? 1.06 : 1.16, 0)], [1, hexShade(PAL.limbDark, club ? 1.0 : 1.12, 0)]] }, 0.32));
  }
  return out;
}

/** Body outline pieces (head, mesosoma etc.) for a pose; `yaw` rotations sway head and gaster. */
function bodyShapes(pose: AntPose, silhouette = false, parts: AntParts = 'all'): DrawList {
  const P_ = PAL, out: DrawList = [];
  if (parts === 'head') return headShapes(pose, silhouette);
  const S = (d: string, fill: Shape['fill'], lw?: number) => out.push(silhouette ? { d, fill: '#000' } : OUT(d, fill, lw));
  // gaster (pivot at the postpetiole), smooth and shiny
  const gpts = rotAbout(Array.from({ length: 18 }, (_, i) => { const a = (i / 18) * Math.PI * 2, rx = 13.4, ry = 9.2; const k = Math.cos(a) > 0 ? 1 - 0.16 * Math.cos(a) ** 3 : 1; return [-34 + Math.cos(a) * rx, Math.sin(a) * ry * k] as [number, number]; }), -21, 0, pose.gasterYaw);
  S(smoothClosed(gpts), dorsal(-34, 0, 13.4, 9.2, P_.gaster), 0.6);
  // postpetiole (broader than the petiole) and petiole node with its anterior peduncle
  const pp = rotAbout([[-17.4, 0]], -21, 0, pose.gasterYaw * 0.5)[0];
  S(ellipse(pp[0], pp[1], 2.7, 2.9), dorsal(pp[0], pp[1], 2.7, 2.9, P_.waist), 0.45);
  S(taper(-7.6, 0, -11, 0, 1.6, 1.8), P_.waist[1], 0.4);
  S(ellipse(-12.4, 0, 1.9, 2.0), dorsal(-12.4, 0, 1.9, 2.0, P_.waist), 0.45);
  // mesosoma: domed pronotum, narrower mesonotum, metanotal groove, propodeum with two short spines
  const half: [number, number][] = [[21.4, 0], [20.6, 4.9], [18.0, 7.3], [14.4, 7.1], [11.2, 5.0], [8.2, 3.3], [5.6, 2.9], [3.0, 2.0], [1.6, 2.3], [-1.4, 3.1], [-4.4, 3.2], [-7.0, 2.1]];
  const mpts: [number, number][] = [...half, [-8.0, 0], ...half.slice(1).reverse().map(([x, y]) => [x, -y] as [number, number])];
  for (const sd of [-1, 1]) S(new P().M(-3.4, 2.9 * sd).Q(-7.2, 4.4 * sd, -9.6, 5.6 * sd).Q(-7.6, 3.4 * sd, -6.4, 1.8 * sd).Z().toString(), P_.meso[1], 0.35); // propodeal spines
  S(smoothClosed(mpts, 0.85), dorsal(11, 0, 12, 6.5, P_.meso), 0.55);
  if (!silhouette) out.push({ d: ellipse(15.8, 0, 5, 4.8), fill: { rad: [15.8, 0, 0, 15.8, 0, 5.4], stops: [[0, 'rgba(255,225,180,0.35)'], [1, 'rgba(255,225,180,0)']] }, blend: 'screen' }); // pronotal dome
  if (!silhouette) {
    out.push({ d: new P().M(9.6, -4.6).Q(8.4, 0, 9.6, 4.6).toString(), stroke: 'rgba(60,28,10,0.4)', lw: 0.4 }); // promesonotal suture
    out.push({ d: new P().M(2.4, -2.4).Q(1.6, 0, 2.4, 2.4).toString(), stroke: 'rgba(60,28,10,0.65)', lw: 0.55 });   // metanotal groove
  }
  if (parts === 'trunk' && !silhouette) { trunkSetae(out, pose); return out; }
  out.push(...headShapes(pose, silhouette, true));
  return out;
}
/** pale erect setae (示意) on mesosoma and gaster (the head's are drawn with the head) */
function trunkSetae(out: DrawList, pose: AntPose) {
  { const g = rotAbout([[-42.4, -7.3], [-45.4, 0], [-42.4, 7.3]], -21, 0, pose.gasterYaw); out.push({ d: new P().M(g[0][0], g[0][1]).Q(g[1][0], g[1][1], g[2][0], g[2][1]).toString(), stroke: 'rgba(10,4,0,0.45)', lw: 0.45 }); }
  for (const [x, y] of SETAE) if (x <= 21) {
    const [sx, sy] = x < 0 ? rotAbout([[x, y]], -21, 0, pose.gasterYaw)[0] : [x, y];
    out.push({ d: new P().M(sx, sy).L(sx - 0.6, sy + (y > 0 ? 0.45 : -0.45)).toString(), stroke: 'rgba(255,236,200,0.45)', lw: 0.2, cap: 'round' });
  }
}
const SETAE: [number, number][] = [[30, -3], [30, 3], [26, -5.5], [26, 5.5], [-30, -4], [-34, 3], [-40, -2], [14, -2], [14, 2]];
/** Head, mandibles, eyes and head setae, rotated by pose.headYaw about NECK; `withTrunkSetae` also draws the trunk
 *  setae (the 'all' drawing keeps its original order). */
function headShapes(pose: AntPose, silhouette: boolean, withTrunkSetae = false): DrawList {
  const P_ = PAL, out: DrawList = [];
  const S = (d: string, fill: Shape['fill'], lw?: number) => out.push(silhouette ? { d, fill: '#000' } : OUT(d, fill, lw));
  // head (pivot at the neck), mandibles first so the head edge overlaps their bases
  const hp = (pts: [number, number][]) => rotAbout(pts, 21, 0, pose.headYaw);
  for (const sd of [-1, 1]) {
    // closed triangular mandibles, apical teeth meeting just past the midline
    const m = hp([[41.6, 5.8 * sd], [46.4, 4.8 * sd], [49.8, 1.9 * sd], [50.6, -0.7 * sd], [49.2, -0.5 * sd], [46.8, 1.3 * sd], [43.4, 2.2 * sd]]);
    S(new P().M(m[0][0], m[0][1]).Q(m[1][0], m[1][1], m[2][0], m[2][1]).L(m[3][0], m[3][1]).L(m[4][0], m[4][1]).L(m[5][0], m[5][1]).L(m[6][0], m[6][1]).Z().toString(), { rad: [45, 2.6 * sd, 0, 45, 2.6 * sd, 5], stops: [[0, hexShade(PAL.mandible, 1.3, 0)], [1, hexShade(PAL.mandible, 0.8, 0)]] }, 0.4);
    if (!silhouette) for (let i = 0; i < 3; i++) { const q = hp([[46.6 + i * 0.95, (1.0 - i * 0.55) * sd]])[0]; out.push({ d: ellipse(q[0], q[1], 0.32, 0.28), fill: 'rgba(40,18,6,0.85)' }); } // teeth
  }
  // Pheidole minor head: about as long as broad, sides convex, posterior margin rounded, clypeus narrowing to the front
  const hpts = hp(Array.from({ length: 22 }, (_, i) => { const a = (i / 22) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a); const rx = 12, ry = 10.6 * (c > 0 ? 1 - 0.22 * c * c : 1 - 0.06 * c * c); return [32.5 + c * rx, s * ry] as [number, number]; }));
  const hc = hp([[32.5, 0]])[0];
  S(smoothClosed(hpts), dorsal(hc[0], hc[1], 12, 10.6, P_.head), 0.6); // HL 24, HW 21.2 units: CI ≈ 88 (R99 minor CI 86–92)
  if (silhouette) return out;
  // frontal carinae, clypeal margin, eyes (moderately small, set at the sides forward of mid-length)
  for (const sd of [-1, 1]) { const c = hp([[37.5, 2.3 * sd], [41.5, 3.5 * sd]]); out.push({ d: new P().M(c[0][0], c[0][1]).L(c[1][0], c[1][1]).toString(), stroke: 'rgba(70,32,10,0.55)', lw: 0.4 }); }
  { const c = hp([[42.3, -4], [44.6, 0], [42.3, 4]]); out.push({ d: new P().M(c[0][0], c[0][1]).Q(c[1][0], c[1][1], c[2][0], c[2][1]).toString(), stroke: 'rgba(70,32,10,0.5)', lw: 0.4 }); }
  for (const sd of [-1, 1]) { const e = hp([[35.0, 8.6 * sd]])[0]; out.push({ d: ellipse(e[0], e[1], 1.75, 1.25, 0.2 * sd), fill: { rad: [e[0] - 0.3, e[1] - 0.2, 0.1, e[0], e[1], 1.9], stops: [[0, '#6b5747'], [0.45, '#2c1d13'], [1, '#120a05']] }, stroke: 'rgba(20,8,2,0.8)', lw: 0.25 }); }
  if (withTrunkSetae) { const g = rotAbout([[-42.4, -7.3], [-45.4, 0], [-42.4, 7.3]], -21, 0, pose.gasterYaw); out.push({ d: new P().M(g[0][0], g[0][1]).Q(g[1][0], g[1][1], g[2][0], g[2][1]).toString(), stroke: 'rgba(10,4,0,0.45)', lw: 0.45 }); }
  // a few pale erect setae (示意)
  for (const [x, y] of SETAE) {
    if (!withTrunkSetae && x <= 21) continue;
    const q = hp([[x, y]])[0], [sx, sy] = x < 0 ? rotAbout([[x, y]], -21, 0, pose.gasterYaw)[0] : x > 21 ? q : [x, y];
    out.push({ d: new P().M(sx, sy).L(sx - 0.6, sy + (y > 0 ? 0.45 : -0.45)).toString(), stroke: 'rgba(255,236,200,0.45)', lw: 0.2, cap: 'round' });
  }
  return out;
}

/** Draw list for one frame: { shadow, body }. The shadow is the silhouette; draw it offset in screen space. */
export function antFrameDrawList(kind: Gait, frame: number, palette: AntPalette = ANT_PALETTE, parts: AntParts = 'all'): { shadow: DrawList; body: DrawList } {
  const prev = PAL; PAL = palette; try { return poseList(antPose(kind, frame), parts); } finally { PAL = prev; }
}
/** Draw list of a continuous pose (antPoseAt): the detail path, drawn live instead of from a baked atlas. */
export function antDrawListAt(pose: AntPose, palette: AntPalette = ANT_PALETTE, parts: AntParts = 'all'): { shadow: DrawList; body: DrawList } {
  const prev = PAL; PAL = palette; try { return poseList(pose, parts); } finally { PAL = prev; }
}
function poseList(pose: AntPose, parts: AntParts): { shadow: DrawList; body: DrawList } {
  const body: DrawList = [], shadow: DrawList = [];
  if (parts === 'head') return { body: bodyShapes(pose, false, 'head'), shadow: [] };
  // legs under the body; far tripod first (draw order is fixed so frames do not flicker)
  for (const lp of pose.legs) body.push(...legShapes(lp));
  body.push(...bodyShapes(pose, false, parts));
  if (parts === 'all') for (const sd of ['L', 'R'] as const) body.push(...antennaShapes(pose.ant[sd]));
  // shadow silhouette: body pieces + thin limbs (feet in stance touch their shadow; lifted feet do not)
  shadow.push(...bodyShapes(pose, true, parts).map((s) => ({ ...s, fill: 'rgba(24,14,6,0.42)', blend: 'multiply' as const })));
  for (const lp of pose.legs) { const [b, , k, t, f] = lp.pts; shadow.push({ d: new P().M(b[0], b[1]).L(k[0], k[1]).L(t[0], t[1]).L(f[0], f[1]).toString(), stroke: 'rgba(24,14,6,0.3)', lw: 1.6, cap: 'round', blend: 'multiply' }); }
  return { shadow, body };
}

/** Light-dependent glints (drawn at runtime, AFTER rotating into the ant frame): a specular spot on the gaster and the
 *  head, shifted toward the key light. `heading` = ant heading on screen (radians, 0 = facing +x). */
export function antGlints(heading: number): DrawList {
  // direction toward the active key light, rotated into the ant's local frame (no glint when the sun is down)
  const L = light(); if (L.intensity <= 0) return []; const lx = -L.dir.x, ly = -L.dir.y, c = Math.cos(-heading), s = Math.sin(-heading), x = lx * c - ly * s, y = lx * s + ly * c;
  return [
    { d: ellipse(-34 + x * 5, y * 4, 4.2, 2.4, Math.atan2(y, x) + Math.PI / 2), fill: { rad: [-34 + x * 5.5, y * 4.4, 0, -34 + x * 5.5, y * 4.4, 4.4], stops: [[0, 'rgba(255,246,232,0.75)'], [0.35, 'rgba(255,236,210,0.28)'], [1, 'rgba(255,236,210,0)']] }, blend: 'screen' },
    { d: ellipse(-34 - x * 6.4, -y * 5.2, 5.4, 2.7, Math.atan2(y, x) + Math.PI / 2), fill: 'rgba(0,0,0,0.12)', blend: 'multiply' },
    { d: ellipse(32 + x * 4, y * 3.8, 3.2, 1.9, Math.atan2(y, x) + Math.PI / 2), fill: { rad: [32 + x * 4, y * 3.8, 0, 32 + x * 4, y * 3.8, 3.4], stops: [[0, 'rgba(255,240,215,0.5)'], [1, 'rgba(255,240,215,0)']] }, blend: 'screen' },
    { d: ellipse(14 + x * 2.5, y * 2.4, 3.2, 1.6, Math.atan2(y, x) + Math.PI / 2), fill: { rad: [14 + x * 2.5, y * 2.4, 0, 14 + x * 2.5, y * 2.4, 3.4], stops: [[0, 'rgba(255,240,215,0.38)'], [1, 'rgba(255,240,215,0)']] }, blend: 'screen' },
  ];
}

/** The bright glint spots of antGlints as plain circles (local units) for batched stamp drawing in renderers. */
export function antGlintSpots(heading: number): { x: number; y: number; r: number; a: number }[] {
  const L = light(); if (L.intensity <= 0) return [];
  const lx = -L.dir.x, ly = -L.dir.y, c = Math.cos(-heading), s = Math.sin(-heading), x = lx * c - ly * s, y = lx * s + ly * c;
  return [{ x: -34 + x * 5.5, y: y * 4.4, r: 4.4, a: 0.75 }, { x: 32 + x * 4, y: y * 3.8, r: 3.4, a: 0.5 }, { x: 14 + x * 2.5, y: y * 2.4, r: 3.4, a: 0.38 }];
}

/** Walk-cycle phase driven by distance travelled on screen (px) for an ant drawn bodyLenPx long. Returns cycles. */
export const walkCycles = (distPx: number, bodyLenPx: number) => distPx / ((CYCLE_ADVANCE / 100) * bodyLenPx);
/** Frame index from accumulated cycles. */
export const walkFrame = (cycles: number) => ((Math.floor(cycles * WALK_FRAMES) % WALK_FRAMES) + WALK_FRAMES) % WALK_FRAMES;
/** Magnification label: drawn body length vs the reference minor worker length (2.5 mm [R93, R94]). */
export const MINOR_LENGTH_CM = 0.25;
export const magnification = (bodyLenPx: number, pxPerCm: number) => bodyLenPx / (MINOR_LENGTH_CM * pxPerCm);
