/**
 * Three.js 3D prototype — the SCHEMATIC nest cross-section (示意). Pure: no DOM, no Three.js, no engine import.
 *
 * The P0-A2 candidate world records each worker's ENGINE STATE (resting, idle, brood_care, to_entrance,
 * from_entrance, …) but no position inside the nest. The 3-D view therefore shows the nest as chambers on the soil cut
 * face, one chamber per engine-state group — the same grouping as the 2-D inset (INSET_ZONES in v62-p0a2-model.ts).
 * Chamber shapes, depths and the slot of each worker in its chamber are DISPLAY ARRANGEMENT; only the group (= the
 * worker's state) and, for the moves to / from the entrance, the timing (since_s → until_s, the engine's fixed move
 * duration) come from the engine.
 */
import { FACE_Z } from './terrain.ts';

export interface Chamber { key: 'transit' | 'rest' | 'idle' | 'brood'; label: string; states: readonly string[]; x: number; y: number; rx: number; ry: number; rz: number }
export const CHAMBERS: readonly Chamber[] = [
  { key: 'transit', label: '巢口通道', states: ['to_entrance', 'from_entrance'], x: 7, y: -8.5, rx: 5, ry: 2.7, rz: 5 },
  { key: 'rest', label: '休息', states: ['resting'], x: -22, y: -15, rx: 15, ry: 3.8, rz: 9 },
  { key: 'idle', label: '巢內走動', states: ['idle'], x: 8, y: -21, rx: 10, ry: 3.4, rz: 8 },
  { key: 'brood', label: '育幼（幼蟲）', states: ['brood_care'], x: 31, y: -14, rx: 13, ry: 3.8, rz: 9 },
];
export const chamberOf = (state: string) => CHAMBERS.find((c) => c.states.includes(state)) ?? null;
/** carved connections between chambers on the cut face (drawn only) */
export const GALLERIES: readonly [Chamber['key'], Chamber['key']][] = [['transit', 'rest'], ['transit', 'idle'], ['idle', 'brood'], ['transit', 'brood']];

/** point on the rim of chamber c in the direction of (tx, ty) (so a gallery opens INTO the chamber, not across it) */
export function rimToward(c: Chamber, tx: number, ty: number, inset = 0.5): { x: number; y: number } {
  const dx = tx - c.x, dy = ty - c.y, k = 1 / Math.sqrt((dx / c.rx) ** 2 + (dy / c.ry) ** 2 || 1);
  const r = Math.max(0, 1 - inset / Math.max(1e-6, Math.hypot(dx * k, dy * k)));
  return { x: c.x + dx * k * r, y: c.y + dy * k * r };
}
/** carved gallery between two chambers: rim to rim */
export function galleryEnds(a: Chamber, b: Chamber): [{ x: number; y: number }, { x: number; y: number }] {
  return [rimToward(a, b.x, b.y), rimToward(b, a.x, a.y)];
}

/** the entrance shaft from the surface hole (origin) down to the transit chamber; it surfaces on the cut face */
export function shaftPath(groundY: number): { x: number; y: number; z: number }[] {
  const c = CHAMBERS[0];
  const rim = rimToward(c, 2.5, -4.5, -0.8);
  return [{ x: 0, y: groundY, z: 0 }, { x: 0.6, y: groundY - 2.5, z: FACE_Z * 0.45 }, { x: 2.5, y: -4.5, z: FACE_Z - 1.6 }, { x: rim.x, y: rim.y, z: FACE_Z - 1.6 }, { x: c.x - c.rx * 0.4, y: c.y - c.ry * 0.5, z: FACE_Z - 1.6 }];
}

/** point at fraction k ∈ [0, 1] of a polyline by length, with the direction of that segment */
export function alongPath(pts: readonly { x: number; y: number; z: number }[], k: number): { x: number; y: number; z: number; dx: number; dy: number; dz: number } {
  const seg: number[] = []; let total = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z); seg.push(d); total += d; }
  let rem = Math.max(0, Math.min(1, k)) * total;
  for (let i = 0; i < seg.length; i++) {
    const a = pts[i], b = pts[i + 1];
    if (rem <= seg[i] || i === seg.length - 1) {
      const u = seg[i] > 0 ? Math.min(1, rem / seg[i]) : 1;
      return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, z: a.z + (b.z - a.z) * u, dx: b.x - a.x, dy: b.y - a.y, dz: b.z - a.z };
    }
    rem -= seg[i];
  }
  const p = pts[pts.length - 1]; return { ...p, dx: 1, dy: 0, dz: 0 };
}

/** floor height of a chamber at horizontal offset dx from its centre (the ellipse's lower arc) */
export const chamberFloor = (c: Chamber, dx: number) => c.y - c.ry * 0.82 * Math.sqrt(Math.max(0, 1 - (dx / c.rx) ** 2));

/**
 * Slot of the i-th of n workers in a chamber: rows along the face, further rows deeper into the soil.
 * antLen = the DRAWN body length (cm) so magnified ants do not overlap more than necessary. Display arrangement only.
 */
export function chamberSlot(c: Chamber, i: number, n: number, antLen: number, h: number): { x: number; y: number; z: number; yaw: number } {
  const usable = c.rx * 1.6, pitch = Math.max(antLen * 1.15, 0.6), cols = Math.max(1, Math.floor(usable / pitch));
  const rows = Math.max(1, Math.ceil(n / cols)), row = Math.floor(i / cols), col = i % cols, inRow = Math.min(cols, n - row * cols);
  const x = c.x + (col - (inRow - 1) / 2) * pitch + (((h >>> 3) % 100) / 100 - 0.5) * pitch * 0.25;
  const depth = Math.min(c.rz - antLen * 0.5, 0.9 + row * Math.max(antLen * 0.9, 0.5) * (rows > 1 ? Math.min(1, (c.rz - 1.5) / ((rows - 1) * Math.max(antLen * 0.9, 0.5) + 1e-9)) : 1));
  const yaw = (h % 2 === 0 ? 0 : Math.PI) + (((h >>> 9) % 100) / 100 - 0.5) * 0.9;
  return { x, y: chamberFloor(c, x - c.x), z: FACE_Z - Math.max(0.6, depth), yaw };
}

/** larva slot in the brood chamber (engine: the larvae exist and have a gut fill; their placement is display only) */
export function larvaSlot(i: number, n: number): { x: number; y: number; z: number } {
  const c = CHAMBERS.find((k) => k.key === 'brood')!, x = c.x + c.rx * 0.15 + ((i + 0.5) / Math.max(1, n) - 0.5) * c.rx * 1.1;
  return { x, y: chamberFloor(c, x - c.x) + 0.15, z: FACE_Z - c.rz * 0.6 };
}
