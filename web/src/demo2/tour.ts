/**
 * Demo 2 — 自動導覽 (idle camera tour): which shot the camera takes next. Pure: no DOM, no Three.js, no Worker client,
 * no engine import, no clock, no unseeded randomness.
 *
 * CAMERA ONLY. The tour never sends anything to the Worker and never changes a world: it only decides where the
 * page's own camera looks. Whom it follows comes from ENGINE data the page already has — the workers' states and
 * state-start instants of the latest frame, and the trophallaxis / larva-feeding events the page has received — and
 * is a deterministic function of them (ties are broken by a hash of the world seed, the shot number and the id).
 * It does not make anything happen and it does not stage anything: a worker is followed because the engine says it
 * is leaving the nest, feeding, returning, caring for brood, or has just passed food.
 */
export type TourView = 'full' | 'surface' | 'under';
export interface TourWorker { id: string; state: string; since_s: number }
/** an engine event the page received: a worker that passed food to a nestmate, or fed a larva */
export interface TourCue { id: string; kind: 'troph' | 'larva_feed'; t_sim: number }
export type TourReason = 'troph' | 'larva_feed' | 'to_entrance' | 'feeding' | 'returning' | 'outbound' | 'brood_care' | 'searching' | 'from_entrance';
export type TourShot =
  | { kind: 'view'; view: TourView; hold_s: number }
  | { kind: 'follow'; id: string; reason: TourReason; hold_s: number };

/** how long a shot stays (seconds of wall clock: camera pacing only) */
export const TOUR_VIEW_HOLD_S = 8, TOUR_FOLLOW_HOLD_S = 16;
/** seconds without input before the tour starts (default; `?tour=<seconds>` changes it, `?tour=0` switches it off) */
export const TOUR_IDLE_S = 25;
/** an event cue counts as "just happened" for this long (simulation seconds) */
export const TOUR_CUE_WINDOW_S = 60;
export const TOUR_REASON_ZH: Record<TourReason, string> = {
  troph: '剛交哺（引擎事件）', larva_feed: '剛餵幼蟲（引擎事件）', to_entrance: '正走向巢口（引擎狀態）', feeding: '在食源取食（引擎狀態）',
  returning: '回巢途中（引擎狀態）', outbound: '前往食源（引擎狀態）', brood_care: '育幼（引擎狀態）', searching: '巢外搜尋（引擎狀態）', from_entrance: '從巢口回巢內（引擎狀態）',
};
/** the order reasons are tried in; each follow shot starts one step further along, so the tour shows different activities */
export const TOUR_REASONS: readonly TourReason[] = ['to_entrance', 'troph', 'feeding', 'larva_feed', 'returning', 'brood_care', 'outbound', 'searching', 'from_entrance'];
const OUTSIDE = new Set(['outbound', 'searching', 'feeding', 'returning']);

/** FNV-1a (32 bit): the seeded tie-break */
export function tourHash(s: string): number { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return h >>> 0; }

function candidates(reason: TourReason, workers: readonly TourWorker[], cues: readonly TourCue[], t_sim: number): { id: string; at: number }[] {
  if (reason === 'troph' || reason === 'larva_feed') {
    const live = new Set(workers.map((w) => w.id)), best = new Map<string, number>();
    for (const c of cues) if (c.kind === reason && live.has(c.id) && c.t_sim <= t_sim && t_sim - c.t_sim <= TOUR_CUE_WINDOW_S) best.set(c.id, Math.max(best.get(c.id) ?? -Infinity, c.t_sim));
    return [...best].map(([id, at]) => ({ id, at }));
  }
  return workers.filter((w) => w.state === reason).map((w) => ({ id: w.id, at: w.since_s }));
}

/**
 * Shot number k (0, 1, 2, …) of a tour. Even shots are overviews (完整剖面 → 地表 → 地下, 地表 only while a worker
 * is outside); odd shots follow one worker that is doing something, the most recent state change first. When no
 * worker is doing anything (all resting / idle) the odd shot is an overview too: nothing is invented.
 */
export function nextShot(k: number, seed: number, t_sim: number, workers: readonly TourWorker[], cues: readonly TourCue[], lastFollowed: string | null): TourShot {
  const view = (i: number): TourShot => {
    const cycle: TourView[] = ['full', 'surface', 'under'], anyOut = workers.some((w) => OUTSIDE.has(w.state));
    let v = cycle[((i % 3) + 3) % 3]; if (v === 'surface' && !anyOut) v = 'under';
    return { kind: 'view', view: v, hold_s: TOUR_VIEW_HOLD_S };
  };
  if (k % 2 === 0) return view(k / 2);
  const start = ((k - 1) / 2) % TOUR_REASONS.length;
  for (let pass = 0; pass < 2; pass++) { // first pass: someone other than the worker followed last time
    for (let i = 0; i < TOUR_REASONS.length; i++) {
      const reason = TOUR_REASONS[(start + i) % TOUR_REASONS.length];
      const c = candidates(reason, workers, cues, t_sim).filter((x) => pass === 1 || x.id !== lastFollowed);
      if (!c.length) continue;
      c.sort((a, b) => b.at - a.at || tourHash(`${seed}:${k}:${a.id}`) - tourHash(`${seed}:${k}:${b.id}`) || (a.id < b.id ? -1 : 1));
      return { kind: 'follow', id: c[0].id, reason, hold_s: TOUR_FOLLOW_HOLD_S };
    }
  }
  return view((k + 1) / 2);
}

/** may the tour start (or go on)? Only while the world runs and the user is neither following nor reading anything. */
export function tourMayRun(s: { on: boolean; idle_s: number; need_idle_s: number; running: boolean; userFollowing: boolean; userSelected: boolean; sheetOpen: boolean }): boolean {
  return s.on && s.running && !s.userFollowing && !s.userSelected && !s.sheetOpen && s.idle_s >= s.need_idle_s;
}
