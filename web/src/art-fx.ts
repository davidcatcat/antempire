/**
 * Art kit: lighting and weather ASSETS (drawing only; wiring them into the game view is a later step).
 * Weather rule: the engine records rain only as a daily total and a "wet" flag (no clock minute), so the game view may
 * show a DAY STATE (wet ground, overcast light) labelled as a daily value, never rain starting or falling at a minute.
 * The activity window is 360 minutes, not 24 h, so replay mode draws no day-night cycle: it uses art-core
 * SCHEMATIC_LIGHT (labelled). lightGrade / sunWash take any LightState so a real day-night look can be produced
 * once the engine supplies real time and sun position (P0-A1 solar module; not in the replay data). rainStreak / splash are kept for
 * a future engine that records rain timing; until then they are only shown on the preview page.
 */
import { P, ellipse, light, rng, smoothClosed, softShadow, type DrawList, type LightState, type Shape } from './art-core.ts';

const rect = (w: number, h: number) => new P().M(0, 0).L(w, 0).L(w, h).L(0, h).Z().toString();
/** Darkened edges, warm (multiply). */
export function vignette(w: number, h: number, strength = 0.42): Shape {
  const r = Math.hypot(w, h) / 2;
  return { d: rect(w, h), fill: { rad: [w * 0.45, h * 0.42, r * 0.35, w / 2, h / 2, r], stops: [[0, 'rgba(255,255,255,0)'], [0.6, `rgba(70,44,22,${(strength * 0.35).toFixed(3)})`], [1, `rgba(40,24,10,${strength.toFixed(3)})`]] }, blend: 'multiply' };
}
/** Key-light wash falling from the sun side of the screen (active light). Nothing when the sun is down. */
export function sunWash(w: number, h: number, strength = 0.16, L: LightState = light()): Shape {
  const cx = w / 2, cy = h / 2, r = Math.hypot(w, h) / 2, d = Math.hypot(L.dir.x, L.dir.y) || 1, ux = L.dir.x / d, uy = L.dir.y / d, a = (strength * L.intensity).toFixed(3);
  return { d: rect(w, h), fill: { lin: [cx - ux * r, cy - uy * r, cx + ux * r, cy + uy * r], stops: [[0, `rgba(255,214,150,${a})`], [0.55, 'rgba(255,214,150,0.02)'], [1, 'rgba(255,214,150,0)']] }, blend: 'screen' };
}
/** Whole-scene grade for a light state: darkening by (1 − direct light) and the colour grade (warm low sun, blue night). */
export function lightGrade(w: number, h: number, L: LightState = light()): DrawList {
  const dark = (1 - (0.42 + 0.58 * L.intensity)).toFixed(3), up = L.intensity > 0;
  return [{ d: rect(w, h), fill: `rgba(18,20,34,${dark})`, blend: 'multiply' }, { d: rect(w, h), fill: L.grade, blend: up ? 'screen' : 'multiply' }];
}
/** Overcast day state: cooler, flatter light (multiply). */
export function overcast(w: number, h: number): Shape {
  return { d: rect(w, h), fill: 'rgba(168,176,188,0.55)', blend: 'multiply' };
}
/** Wet-ground day state, applied over a dry soil tile when the engine day is wet (soilTile({wet:true}) is the baked variant). */
export const WET_TINT = { multiply: 'rgba(120,112,108,0.6)', label: '地面潮濕（日值）' } as const;
/** Small damp sheen glints scattered over `w`×`h` (screen). */
export function wetGlints(seed: number, w: number, h: number, n: number): Shape {
  const r = rng(seed); let d = '';
  for (let i = 0; i < n; i++) { const x = r() * w, y = r() * h, s = 0.6 + r() * 1.4; d += ellipse(x, y, s, s * 0.6, -0.6); }
  return { d, fill: 'rgba(235,240,245,0.28)', blend: 'screen' };
}
/** A shallow puddle (wet day state only): dark water with a sky reflection gradient. */
export function puddle(seed: number, x: number, y: number, rad: number): DrawList {
  const r = rng(seed), pts: [number, number][] = [];
  for (let i = 0; i < 12; i++) { const a = (i / 12) * 6.283, k = 1 + (r() - 0.5) * 0.35; pts.push([x + Math.cos(a) * rad * k, y + Math.sin(a) * rad * 0.62 * k]); }
  const d = smoothClosed(pts);
  return [
    { d, fill: 'rgba(40,30,22,0.35)', blend: 'multiply' },
    { d, fill: { lin: [x - rad, y - rad * 0.6, x + rad, y + rad * 0.6], stops: [[0, 'rgba(210,222,232,0.42)'], [0.45, 'rgba(150,164,176,0.18)'], [1, 'rgba(80,90,100,0.06)']] }, blend: 'screen', stroke: 'rgba(235,240,245,0.3)', lw: 0.25 },
  ];
}
/** Wet day state over everything on the ground (litter darkens when wet). */
export function wetDarken(w: number, h: number): Shape { return { d: rect(w, h), fill: WET_TINT.multiply, blend: 'multiply' }; }
/** Generic soft contact-shadow stamp (re-exported for renderers). */
export const shadowStamp = softShadow;
/** Rain streak sprite (NOT for the current replay: the engine has no rain minute). */
export function rainStreak(len: number): Shape { return { d: new P().M(0, 0).L(len * 0.18, len).toString(), stroke: { lin: [0, 0, len * 0.18, len], stops: [[0, 'rgba(220,230,240,0)'], [1, 'rgba(220,230,240,0.6)']] }, lw: Math.max(0.6, len * 0.03), cap: 'round' }; }
/** Splash crown at progress t ∈ [0,1] (NOT for the current replay). */
export function splash(x: number, y: number, rad: number, t: number): DrawList {
  const a = (1 - t).toFixed(3), rr = rad * (0.3 + t * 0.9), out: DrawList = [{ d: ellipse(x, y, rr, rr * 0.45), stroke: `rgba(225,235,245,${a})`, lw: rad * 0.08 }];
  for (let i = 0; i < 6; i++) { const ang = (i / 6) * 6.283, d = rr * 1.1; out.push({ d: ellipse(x + Math.cos(ang) * d, y + Math.sin(ang) * d * 0.45 - t * rad * 0.6 * Math.sin(Math.PI * t), rad * 0.06, rad * 0.06), fill: `rgba(225,235,245,${a})` }); }
  return out;
}
