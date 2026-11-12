/**
 * V6-2 experiment mode — pure (DOM-free) display model, shared by v62.ts and the Node tests.
 * Input is ONLY what the non-official experiment Worker sends (FrameMsg / EventMsg); nothing here runs, steps or
 * changes the simulation, and nothing is written back.
 *  - poseAt: an ant's on-screen world point at a display time. At or outside the two engine records of its current
 *    straight segment (since_s / until_s) it is EXACTLY the recorded point; strictly between them it is display
 *    interpolation (flagged `interpolated: true`). In-nest ants have no drawn position.
 *  - eventDigest: an order-sensitive digest of the received event stream (FNV-1a 64 over each event's JSON), used by
 *    the tests to compare event streams across UI operations. It is not a security hash.
 *  - world time: t_sim seconds since 00:00 of experiment day 0 → 第 ⌊t/86400⌋ 天 HH:MM:SS.
 */
import type { EventMsg, FrameMsg } from './experimental/worker-protocol.ts';
import type { AntInput } from './render-scene.ts';
import type { Place } from './model.ts';

export const MODE_LABEL = '非正式實驗世界／不屬於正式遊戲歷史';
/** observation speeds offered (world seconds per real second; Owner decision 47: default 1×). Scheduling only. */
export const V62_SPEEDS = [1, 5, 10, 60, 600, 3600] as const;
export const DEFAULT_SPEED = 1;
/** display frame-rate caps offered (drawing only) */
export const FPS_CAPS = [60, 30, 15] as const;
/** how far (real seconds) the display clock may run ahead of the latest Worker frame while running (display only) */
export const DISPLAY_LEAD_S = 0.05;

type FrameAnt = FrameMsg['ants'][number];
export interface Pose { id: string; x: number; y: number; heading: number | null; vis: 'walking' | 'at_site' | 'in_nest'; moving: boolean; interpolated: boolean }

/** Display pose of one ant at display time t (seconds). Exact recorded points at k ≤ 0 and k ≥ 1. */
export function poseAt(a: FrameAnt, t: number): Pose {
  if (a.in_nest) return { id: a.id, x: a.from.x, y: a.from.y, heading: null, vis: 'in_nest', moving: false, interpolated: false };
  if (a.activity === 'walking' && a.to) {
    const heading = Math.atan2(a.to.y - a.from.y, a.to.x - a.from.x), span = a.until_s - a.since_s;
    const k = span > 0 ? (t - a.since_s) / span : 1;
    if (k <= 0) return { id: a.id, x: a.from.x, y: a.from.y, heading, vis: 'walking', moving: true, interpolated: false };
    if (k >= 1) return { id: a.id, x: a.to.x, y: a.to.y, heading, vis: 'walking', moving: false, interpolated: false };
    return { id: a.id, x: a.from.x + (a.to.x - a.from.x) * k, y: a.from.y + (a.to.y - a.from.y) * k, heading, vis: 'walking', moving: true, interpolated: true };
  }
  return { id: a.id, x: a.from.x, y: a.from.y, heading: null, vis: 'at_site', moving: false, interpolated: false };
}
export const posesAt = (f: FrameMsg, t: number): Pose[] => f.ants.map((a) => poseAt(a, t));
/** renderer inputs (no display offsets: the drawn point is the exact affine image of the pose) */
export const antInputs = (poses: readonly Pose[]): AntInput[] => poses.map((p) => ({ id: p.id, x: p.x, y: p.y, vis: p.vis, moving: p.moving, heading: p.heading }));

/** Display clock: the latest frame's t_sim; while running it may lead by at most DISPLAY_LEAD_S real seconds of
 *  pacing and never steps back within that lead. Paused → exactly the frame's t_sim (an engine boundary). */
export function displayTime(frameT: number, running: boolean, speed: number, sinceFrameMs: number, prev: number | null): number {
  if (!running) return frameT;
  const cap = frameT + speed * DISPLAY_LEAD_S, ahead = frameT + Math.min(Math.max(0, sinceFrameMs) / 1000 * speed, speed * DISPLAY_LEAD_S);
  return Math.max(ahead, prev === null ? frameT : Math.min(prev, cap));
}

const pad = (n: number) => String(n).padStart(2, '0');
export const worldDay = (t: number) => Math.floor(t / 86_400);
export function clockOf(t: number): string { const s = t - worldDay(t) * 86_400, h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60); return `${pad(h)}:${pad(m)}:${pad(ss)}`; }
export const fmtWorldTime = (t: number) => `實驗第 ${worldDay(t)} 天 ${clockOf(t)}`;

/** FNV-1a 64 (two 32-bit halves) over each event's JSON, in arrival order. Test digest only, not a security hash. */
export class EventDigest {
  private h1 = 0x811c9dc5; private h2 = 0x01000193 ^ 0x9e3779b9; count = 0; lastSeq = -1; gaps = 0;
  add(e: EventMsg): void {
    if (e.seq !== this.lastSeq + 1) this.gaps++;
    this.lastSeq = e.seq; this.count++;
    const s = JSON.stringify(e);
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); this.h1 = Math.imul(this.h1 ^ c, 0x01000193) >>> 0; this.h2 = Math.imul(this.h2 ^ c, 0x01000193 ^ (i & 0xff)) >>> 0; }
  }
  value(): string { return this.h1.toString(16).padStart(8, '0') + this.h2.toString(16).padStart(8, '0'); }
}

/** The experiment world's one engine place for the layered renderer: the synthetic nest at the arena centre. */
export const NEST_PLACE: Place = { id: 'N00', name: '實驗巢（合成）', bearing: null, distance_cm: null, kind: 'nest', layout: { x: 0, y: 0, basis: '合成世界的巢位於場地中心' } };
export const scenePositions = () => ({ N00: { x: 0, y: 0, known: true } });

export const LIGHT_LABEL: Record<string, string> = { night: '夜', civil_twilight: '曙暮光', day: '日' };
export const ACTIVITY_LABEL: Record<string, string> = { resting: '巢內休息', walking: '行走', pausing: '巢外停頓' };
