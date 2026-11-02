/**
 * Reproduction measures for the Day0 evaluations (diagnostic, NOT a target; Owner 2026-11-02, PR #34 review).
 *
 * 1. any_own_worker_eclosion — 「年度內曾有自產工蟻羽化」: an EVENT measure over the whole observation period
 *    (Day1–365, cumulative): at least one worker eclosed from an egg the queen laid during the run (brood carried at
 *    founding does not count). It is NOT a state on Day365: the colony may be extinct by then. It was called "effective reproduction" until
 *    2026-11-02; the old name implied more than the measure says. It says nothing about whether reproduction lasts.
 * 2. sustained_reproduction_candidate — MIXED: two STATES on Day365 (queen alive, workers present) and two EVENT
 *    windows (own eclosion in Day181–365, eggs in Day271–365). A CANDIDATE evaluation definition of continued reproduction, built from
 *    components that are reported on their own as well, so the Owner can judge or replace the definition.
 *    assumption: true — 遊戲假設 (an evaluation definition, not a biological threshold; no literature gives a
 *    "sustained reproduction" criterion for this species). It is never used to choose parameters.
 *
 * Bins: 30-day windows counted from Day1 (Day1–30, …, Day331–360, and the PARTIAL bin Day361–365). The engine has workers only
 * (no sexual brood), so every eclosion is a worker eclosion.
 */
export const BIN_DAYS = 30;
export const binOf = (day: number) => Math.floor((day - 1) / BIN_DAYS);

export const SUSTAINED_REPRODUCTION = {
  id: 'sustained_reproduction_candidate_v1',
  label: '持續繁殖候選定義 v1',
  assumption: true,
  basis: '遊戲假設：評估定義，不是生物學門檻；不作為調參或挑選參數的目標',
  rule: '【Day365 狀態】蟻后存活 且 有工蟻；【期間事件】後半年（Day181～365）至少 1 隻自產工蟻羽化 且 最後 95 日（Day271～365）蟻后有產卵',
  caveat: '「最後 95 日有產卵」受開始季節影響：春季開始的最後 95 日落在冬季（12 月中～3 月），夏季開始落在春季，秋季開始落在夏季，冬季開始落在秋季。冬季停產在野外可能正常，所以各季分開看，也同時列出各組成項目。',
  second_half_from_day: 181,
  last_eggs_from_day: 271,
} as const;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Run = any;

/** Components and the candidate flag for one 365-day run (needs checkpoints[365] and the 30-day bins). */
export function reproductionMeasures(run: Run) {
  const c = run.checkpoints?.[365] ?? { extinct: true };
  const own: number[] = run.own_eclosions_by_30d, eggs: number[] = run.eggs_laid_by_30d;
  const from = (xs: number[], day: number) => xs.slice(binOf(day)).reduce((a, b) => a + b, 0);
  const queen = !c.extinct && !!c.queen, workers = c.extinct ? 0 : c.workers;
  const ownSecondHalf = from(own, SUSTAINED_REPRODUCTION.second_half_from_day), eggsLast = from(eggs, SUSTAINED_REPRODUCTION.last_eggs_from_day);
  return {
    any_own_worker_eclosion: run.own_eclosions > 0,
    // Issue #43 F07 (2026-11-03): every bin with data counts, including the partial Day361–365 bin. The v1 value
    // (first 12 bins = Day1–360 only) is kept under an explicit name for traceability.
    own_eclosion_windows: own.filter((x) => x > 0).length,
    own_eclosion_windows_first_360: own.slice(0, 12).filter((x) => x > 0).length,
    own_eclosions_second_half: ownSecondHalf,
    eggs_last_95_days: eggsLast,
    sustained_reproduction_candidate: queen && workers > 0 && ownSecondHalf > 0 && eggsLast > 0,
  };
}
