/**
 * Parameters of the SMALL SYNTHETIC experiment world (P0-A2 PR 2, Owner decision #39).
 *
 * THIS IS NOT A SCIENTIFIC MODEL. Every value below is a game assumption chosen only so the runtime has something to
 * move; none comes from Pheidole megacephala data and none may be cited as ant biology. The ants walk straight legs at
 * a constant speed, pause, and rest in the nest with exponentially distributed bout lengths; nothing reads the
 * environment. The environment is: (a) light transitions computed with the general solar method of engine/clock/solar.ts
 * for a representative point, and (b) an hourly air temperature taken from a hand-written 24-value profile
 * (synthetic: true). Neither feeds back into the ants.
 */
/** /2 (Owner decision #190, ruled in #193, 2026-11-12): light times now from engine/clock/detmath.ts (bit-identical across
 *  environments; last digits differ from /1, which used Math.* trigonometry). Snapshots of /1 are refused (ENGINE_MISMATCH). */
export const ENGINE_VERSION = 'experiment-world-runtime/2';
export const SNAPSHOT_SCHEMA = 'antempire.experiment-world-snapshot.v1';
/** payload schema 2 (Owner ruling #200): payload.save_meta + payload.chain (event-chain commitment). Snapshots of
 *  schema 1 are refused (no chain; kept unchanged). docs/save-format-v2.md. */
export const SCHEMA_VERSION = 2;
export const LABEL_ZH = '非正式實驗世界／不屬於正式遊戲歷史';

export interface Labelled { assumption: true; basis: '遊戲假設' | '一般方法'; note: string }
export interface WorldParams {
  schema: 'antempire.experiment-world-params.v1';
  synthetic: true;
  n_ants: number;
  arena_radius_cm: number;
  walk_speed_cm_s: number;
  leg_min_cm: number;
  leg_max_cm: number;
  rest_mean_s: number;
  pause_mean_s: number;
  return_probability: number;
  min_bout_s: number;
  memory_size: number;
  calendar: { day0_date: string; utc_offset_minutes: number; zone: string };
  site: { latitude_deg: number; longitude_deg: number };
  temperature_profile_c: number[];
  labels: Record<string, Labelled>;
}

const G = (note: string): Labelled => ({ assumption: true, basis: '遊戲假設', note });
export const DEFAULT_PARAMS: WorldParams = {
  schema: 'antempire.experiment-world-params.v1',
  synthetic: true,
  n_ants: 6,
  arena_radius_cm: 60,
  walk_speed_cm_s: 1,
  leg_min_cm: 5,
  leg_max_cm: 40,
  rest_mean_s: 900,
  pause_mean_s: 120,
  return_probability: 0.35,
  min_bout_s: 1,
  memory_size: 4,
  calendar: { day0_date: '2026-03-26', utc_offset_minutes: 480, zone: 'Asia/Taipei' },
  site: { latitude_deg: 24.18, longitude_deg: 120.64 },
  temperature_profile_c: [19, 18.6, 18.3, 18, 17.8, 17.8, 18.2, 19.2, 20.6, 22.1, 23.5, 24.6, 25.4, 25.9, 26, 25.7, 25, 23.9, 22.7, 21.7, 20.9, 20.3, 19.8, 19.4],
  labels: {
    n_ants: G('合成實驗世界的個體數；只為了畫面上有東西可看。'),
    arena_radius_cm: G('合成圓形場地；不是花園量測。'),
    walk_speed_cm_s: G('固定步行速度；不是本種實測，不得引用。'),
    leg_min_cm: G('直線段長度下限；純合成。'),
    leg_max_cm: G('直線段長度上限；純合成。'),
    rest_mean_s: G('巢內休息段平均長度（指數分布）；純合成，不是本種休息時間。'),
    pause_mean_s: G('巢外停頓段平均長度（指數分布）；純合成。'),
    return_probability: G('停頓後回巢的機率；純合成，沒有任何決策機制。'),
    min_bout_s: G('最短段長；工程下限，避免零長度事件。'),
    memory_size: G('個體保留的最近途經點數；只為了驗證快照包含個體記憶。'),
    calendar: G('實驗世界的日曆錨點（只用於計算光照）；不是正式 Day0。'),
    site: { assumption: true, basis: '一般方法', note: '代表點（臺中市西屯區附近）供 engine/clock/solar.ts 計算曙暮光；花園是虛構情境。' },
    temperature_profile_c: G('synthetic: true 的手寫 24 值逐時氣溫剖面；不是觀測、不是平年值重建；本世界中沒有任何個體讀取它。'),
  },
};
