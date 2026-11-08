/**
 * V6 Game View — pure (DOM-free) layer. Everything a frame needs is derived from the exported engine replay through
 * model.poseAt (the same function the analysis view uses), so the game view cannot disagree with it:
 *  - an ant's position is the engine's recorded point, or a display interpolation between two recorded points;
 *  - an ant on an edge whose endpoint has no recorded garden position is NOT drawn (never an invented position);
 *  - nothing here creates an event: no foraging, trophallaxis, attack or death that the engine did not record.
 * The garden scenery is decorative and explicitly labelled as such (seeded, no unseeded randomness).
 */
import { poseAt, windowOf, NEST, type Experiment, type ExperimentDay, type SimEvent } from './model.ts';

export type Pos = Record<string, { x: number; y: number; known: boolean }>;
/** walking = on a recorded edge between two known places (position interpolated for display);
 *  at_site = at a known non-nest place (engine record); in_nest = inside the nest (not visible);
 *  unknown_place = at, or walking to/from, a place without a recorded garden position (not drawn). */
export type AntVisibility = 'walking' | 'at_site' | 'in_nest' | 'unknown_place';
export interface AntFrame {
  id: string; x: number; y: number; vis: AntVisibility;
  /** strictly between two recorded points of a walk (the drawn position is a display interpolation) */
  moving: boolean;
  /** direction of the current recorded edge (radians, world frame x east / y north); null when not on an edge */
  heading: number | null;
  action: string; place: string; interpolated: boolean; segStart: number | null; segEnd: number | null;
}

/** Per worker, only its own activity + route_step events (poseAt reads nothing else), so a frame is O(own events). */
export function buildDayIndex(d: ExperimentDay): Map<string, ExperimentDay> {
  const by = new Map<string, SimEvent[]>();
  for (const e of d.events) {
    if ((e.type !== 'worker_activity' && e.type !== 'route_step') || typeof e.worker !== 'string') continue;
    let a = by.get(e.worker); if (!a) by.set(e.worker, (a = [])); a.push(e);
  }
  const out = new Map<string, ExperimentDay>();
  for (const [w, ev] of by) out.set(w, { ...d, events: ev });
  return out;
}

const EMPTY_DAY = (d: ExperimentDay): ExperimentDay => ({ ...d, events: [] });

/** The frame of one worker at minute t, classified for drawing. Uses model.poseAt unchanged. */
export function antFrame(idx: Map<string, ExperimentDay>, d: ExperimentDay, id: string, t: number, pos: Pos): AntFrame {
  const light = idx.get(id) ?? EMPTY_DAY(d);
  const p = poseAt(light, id, t, pos);
  const seg = p.segment, base = { id, x: p.x, y: p.y, action: p.action, place: p.place, interpolated: p.interpolated, segStart: seg ? (seg.start as number) : null, segEnd: seg ? (seg.end as number) : null };
  if (p.place.includes('>')) {
    const [a, b] = p.place.split('>');
    if (!pos[a]?.known || !pos[b]?.known) return { ...base, vis: 'unknown_place', moving: false, heading: null };
    return { ...base, vis: 'walking', moving: p.interpolated, heading: Math.atan2(pos[b].y - pos[a].y, pos[b].x - pos[a].x) };
  }
  if (p.place === NEST) return { ...base, vis: 'in_nest', moving: false, heading: null };
  if (!pos[p.place]?.known) return { ...base, vis: 'unknown_place', moving: false, heading: null };
  return { ...base, vis: 'at_site', moving: false, heading: null };
}

/** The recorded walks of a day (activity segments on an edge), computed once per day. */
export function walkIntervals(d: ExperimentDay): { start: number; end: number }[] {
  return d.events.filter((e) => e.type === 'worker_activity' && typeof e.place === 'string' && e.place.includes('>')).map((e) => ({ start: e.start as number, end: e.end as number })).sort((a, b) => a.start - b.start || a.end - b.end);
}
/** True when some worker is on a recorded walk at minute t. */
export function anyWalking(walks: { start: number; end: number }[], t: number): boolean {
  for (const w of walks) { if (w.start > t) break; if (t < w.end) return true; }
  return false;
}
/** Earliest minute >= t at which some worker starts (or is on) a recorded walk this day; null when none before the
 *  end of the activity window. Used only by the optional "skip idle stretches" playback mode (the replay is unchanged). */
export function nextWalkStart(walks: { start: number; end: number }[], d: ExperimentDay, t: number): number | null {
  let best: number | null = null;
  for (const w of walks) { if (w.end <= t) continue; const c = Math.max(w.start, t); if (best === null || c < best) best = c; }
  return best !== null && best < windowOf(d) ? best : null;
}

/** Deterministic 32-bit hash and PRNG (the viewer uses no unseeded randomness). */
export function hash32(s: string): number { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
export function mulberry32(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** DISPLAY arrangement only: a fixed lateral offset (screen px, perpendicular to the edge) so that ants recorded on the
 *  same edge at the same times do not draw on top of each other, and a fixed slot around a site. Never moves an ant
 *  along its path and never changes a time. */
/** lateral lane index in {-2,…,2}; the renderer multiplies it by a fraction of the drawn ant length */
export function laneOffset(id: string): number { return (hash32(id + '|lane') % 5) - 2; }
export function siteSlot(id: string): { dx: number; dy: number; heading: number } {
  const r = mulberry32(hash32(id + '|site')), a = r() * Math.PI * 2, d = 10 + r() * 12;
  return { dx: Math.cos(a) * d, dy: Math.sin(a) * d, heading: r() * Math.PI * 2 };
}

/** Bounds (cm) of all KNOWN places plus a margin, for framing the camera and laying out the decorative scenery. */
export function gardenBounds(pos: Pos, margin = 22): { x0: number; y0: number; x1: number; y1: number } {
  const k = Object.values(pos).filter((p) => p.known);
  return { x0: Math.min(...k.map((p) => p.x)) - margin, y0: Math.min(...k.map((p) => p.y)) - margin, x1: Math.max(...k.map((p) => p.x)) + margin, y1: Math.max(...k.map((p) => p.y)) + margin };
}

export interface Decor { pebbles: { x: number; y: number; r: number; tone: number }[]; leaves: { x: number; y: number; len: number; rot: number; hue: number }[]; tufts: { x: number; y: number; h: number; n: number; lean: number }[]; speckles: { x: number; y: number; r: number; dark: boolean }[] }
/** DECORATIVE garden scenery (示意場景): seeded, deterministic, kept away from recorded places so food sources and the
 *  nest stay visible. It is not a survey of any real garden and has no effect on anything the engine computed. */
export function sceneDecor(seed: number, b: { x0: number; y0: number; x1: number; y1: number }, keepClear: { x: number; y: number }[]): Decor {
  const r = mulberry32(seed), W = b.x1 - b.x0, H = b.y1 - b.y0, area = W * H;
  const clear = (x: number, y: number, rad: number) => keepClear.every((p) => (p.x - x) ** 2 + (p.y - y) ** 2 > rad * rad);
  const pick = (n: number, rad: number) => { const out: { x: number; y: number }[] = []; for (let i = 0; i < n * 4 && out.length < n; i++) { const x = b.x0 + r() * W, y = b.y0 + r() * H; if (clear(x, y, rad)) out.push({ x, y }); } return out; };
  return {
    speckles: pick(Math.round(area / 6), 0).map((p) => ({ ...p, r: 0.06 + r() * 0.18, dark: r() < 0.55 })),
    pebbles: pick(Math.round(area / 260), 5).map((p) => ({ ...p, r: 0.25 + r() * 1.1, tone: r() })),
    leaves: pick(Math.round(area / 340), 6).map((p) => ({ ...p, len: 1.6 + r() * 2.8, rot: r() * Math.PI * 2, hue: r() })),
    tufts: pick(Math.round(area / 420), 7).map((p) => ({ ...p, h: 2 + r() * 3.5, n: 5 + Math.floor(r() * 6), lean: (r() - 0.5) * 0.8 })),
  };
}

/** Real-time playback multiples (simulated seconds per real second). The walking speed the engine used is
 *  17 mm/s on trail, so a 48 cm walk lasts ≈28 s of simulated time: 20× shows it in ≈1.4 s. */
export const SPEEDS = [1, 5, 20, 60, 300] as const;
export const simMinutesPerRealSecond = (mult: number) => mult / 60;

/** End-of-day settlement summary (the engine gives these no clock time; shown as a banner, never at a minute). */
export function settlementSummary(d: ExperimentDay): { deaths: number; eclosions: number; eggs: number } {
  return { deaths: d.worker_deaths, eclosions: d.eclosions, eggs: d.eggs_laid };
}

/** Workers to draw on a day: those alive at the start of the day (the engine's start-of-day roster). */
export function rosterAtStart(exp: Experiment, day: number): string[] {
  const s = day === 1 ? exp.day0.state : exp.days[day - 2].end_state;
  return s.workers.map((w) => w.id).sort();
}

/** Opening moment of a day, computed from the engine record only: the start of the window (default 3 simulated
 *  minutes) in which the most recorded walks are under way (earliest on ties), and the food site those walks go to
 *  most. Used to open the game where ants are actually walking; null when the day has no walk between known places. */
export function openingMoment(d: ExperimentDay, pos: Pos, windowMin = 3): { t: number; walkStart: number; focus: string } | null {
  const walks = d.events.filter((e) => e.type === 'worker_activity' && typeof e.place === 'string' && e.place.includes('>') && (e.place as string).split('>').every((p) => pos[p]?.known))
    .map((e) => ({ start: e.start as number, end: e.end as number, place: e.place as string })).sort((a, b) => a.start - b.start);
  if (!walks.length) return null;
  let best = walks[0].start, bestN = -1;
  for (const w of walks) { const n = walks.filter((v) => v.start < w.start + windowMin && v.end > w.start).length; if (n > bestN) { bestN = n; best = w.start; } }
  const far = new Map<string, number>();
  for (const v of walks) if (v.start < best + windowMin && v.end > best) for (const p of v.place.split('>')) if (p !== NEST) far.set(p, (far.get(p) ?? 0) + 1);
  const focus = [...far].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? NEST;
  return { t: Math.max(0, best - 3 / 60), walkStart: best, focus };
}
