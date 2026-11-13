/**
 * Ant display size under camera zoom (drawing only; no engine data, no event, nothing written back).
 *
 * Ants are far too small to see at true size (小工蟻約 2.5 mm), so the views draw them magnified (labelled 放大顯示 ×N).
 * The magnification is FIXED for a view: it is set at the view's home camera (homeS px/cm, ant homePx long) and kept
 * while the player zooms, so the ants, their spacing, the ground and the places grow and shrink together (Owner
 * 2026-11-13: 「地圖放大縮小的時候，螞蟻等等，也要跟著一起放大縮小」). Before this, the ants had a fixed minimum
 * on-screen length, so zooming out left giant ants on a small map and zooming in moved the ground but not the ants.
 *
 * - The drawn length is homePx · s / homeS (constant ×N), quantised to 1/12-octave steps so sprite atlases are re-baked
 *   only a bounded number of times during a pinch; never below FLOOR_PX, so an ant stays a visible dot far out.
 * - Zooming in is limited to the scale at which the ant reaches `capPx` (a close-up), so a constant magnification
 *   never draws an ant larger than the screen. True-scale views are not possible with a fixed ×N > 1; the ×N label
 *   keeps saying how much the ants are enlarged.
 */
export const FLOOR_PX = 3;
const STEP = 12; // quantisation steps per doubling of the drawn length
export interface AntScale { homeS: number; homePx: number }

/** drawn ant length (CSS px) at camera scale `s` (px per cm) for a view anchored at `a` */
export function antPxAt(a: AntScale, s: number): number {
  const raw = (a.homePx * s) / a.homeS;
  if (!(raw > FLOOR_PX)) return FLOOR_PX;
  return Math.max(FLOOR_PX, 2 ** (Math.round(Math.log2(raw) * STEP) / STEP));
}

/** largest camera scale (px per cm) at which the ant is still at most `capPx` long */
export const maxScaleFor = (a: AntScale, capPx: number) => (a.homeS * capPx) / a.homePx;

/** close-up ant length cap for a screen: half its short side (at least 2× the home size) */
export const closeUpCapPx = (w: number, h: number, homePx: number) => Math.max(homePx * 2, Math.min(w, h) * 0.5);
