/**
 * WP5b comparison (isolated; NOT biology, NOT the official world). The same small synthetic ecological experiment is run
 * in several representations and the outputs are compared across seeds (docs/od1b-cohort-life-time.md §6).
 *   individual     every member is an individual with an ID
 *   cohort-exact   anonymous bins keyed by (stage, sub-stage, daily age, exact reserve): an exact lumping
 *   cohort-pooled  daily age bins, reserve pooled per bin (equal-share assumption)
 *   cohort-coarse  7-day age bins (Lefkovitch-type class transition), reserve pooled
 *   mixed          one third individuals, the rest pooled bins; every 5 days some individuals are demoted and adults are
 *                  promoted (roster first, then sampled) - a synthetic switching schedule to stress representation changes
 *   mean-field     deterministic expectation of cohort-pooled (real-valued; no IDs, no ledger)
 * Every number in SYNTH below is a GAME ASSUMPTION for a synthetic, unnamed background insect (遊戲假設; not any species,
 * not Taichung data); the temperature series is synthetic (synthetic: true).
 */
import { draw } from './ledger.ts';
import { lifeDay, type LifeParams, type LifeState, type Unit, type Resolution, type LifeCommand, type LifeRecord } from './lifetime.ts';

export const SYNTH = {
  assumption: true, basis: '遊戲假設 (synthetic background insect; mechanism forms: degree-day = 一般生理學, Erlang delay = 數學方法)',
  params: {
    stages: [
      { name: 'egg', feeds: false, reproduces: false, senesces: false, substages: 4, dd_required: 70, hazard: 0.02 },
      { name: 'nymph', feeds: true, reproduces: false, senesces: false, substages: 4, dd_required: 150, hazard: 0.02 },
      { name: 'adult', feeds: true, reproduces: true, senesces: true, substages: 0, dd_required: null, hazard: 0.01 },
    ],
    t_lower: 10, meal: 3, burn: 1, crop_cap: 6, egg_cost: 2, p_lay: 0.3, h_starve: 0.15, dev_factor_hungry: 0.5,
    senescence_start: 30, senescence_slope: 0.004,
  } satisfies LifeParams,
  temp: { synthetic: true, mean_c: 24, amplitude_c: 4, period_d: 30 },
};
export const tempOf = (day: number) => SYNTH.temp.mean_c + SYNTH.temp.amplitude_c * Math.sin((2 * Math.PI * day) / SYNTH.temp.period_d);

export interface Scenario { name: string; days: number; inflow: number; init: { stage: number; count: number; age: number; reserve: number }[] }
export const SCENARIOS: Scenario[] = [
  { name: 'rich', days: 60, inflow: 240, init: [{ stage: 0, count: 30, age: 2, reserve: 2 }, { stage: 1, count: 20, age: 10, reserve: 3 }, { stage: 2, count: 30, age: 25, reserve: 4 }] },
  { name: 'scarce', days: 60, inflow: 60, init: [{ stage: 0, count: 30, age: 2, reserve: 2 }, { stage: 1, count: 20, age: 10, reserve: 3 }, { stage: 2, count: 30, age: 25, reserve: 4 }] },
  { name: 'tiny', days: 60, inflow: 60, init: [{ stage: 2, count: 4, age: 20, reserve: 4 }] },
];
export type Mode = 'individual' | 'cohort-exact' | 'cohort-pooled' | 'cohort-coarse' | 'mixed' | 'mean-field';
export const MODES: Mode[] = ['individual', 'cohort-exact', 'cohort-pooled', 'cohort-coarse', 'mixed', 'mean-field'];
const RES: Record<Mode, Resolution> = {
  'individual': { age_bin_days: 1, reserve: 'exact', deterministic: false, newborn: 'follow_parent' },
  'cohort-exact': { age_bin_days: 1, reserve: 'exact', deterministic: false, newborn: 'cohort' },
  'cohort-pooled': { age_bin_days: 1, reserve: 'pooled', deterministic: false, newborn: 'cohort' },
  'cohort-coarse': { age_bin_days: 7, reserve: 'pooled', deterministic: false, newborn: 'cohort' },
  'mixed': { age_bin_days: 1, reserve: 'pooled', deterministic: false, newborn: 'follow_parent' },
  'mean-field': { age_bin_days: 1, reserve: 'pooled', deterministic: true, newborn: 'cohort' },
};

export function initialState(sc: Scenario, mode: Mode, seed: string): LifeState {
  const res = RES[mode], units: Unit[] = [];
  for (const g of sc.init) {
    const nInd = mode === 'individual' ? g.count : mode === 'mixed' ? Math.floor(g.count / 3) : 0;
    for (let j = 0; j < nInd; j++) units.push({ region: 'G', stage: g.stage, sub: 0, age: g.age, id: `I.${g.stage}.${j}`, n: 1, reserve: g.reserve, rkey: null, age_sum: g.age, roster: [] });
    const m = g.count - nInd;
    if (m > 0) units.push({ region: 'G', stage: g.stage, sub: 0, age: res.age_bin_days === 1 ? g.age : Math.floor(g.age / res.age_bin_days), id: null, n: m, reserve: m * g.reserve, rkey: res.reserve === 'exact' ? g.reserve : null, age_sum: m * g.age, roster: [] });
  }
  return { schema: 'antempire.wp5b-lifetime.v1', seed, day: 1, res, units, stocks: { G: 0 }, sinks: {}, corpses: {}, producers: {}, retired: [] };
}
/** synthetic switching schedule for 'mixed' (a stress test of representation changes, not a tracking policy) */
function switching(st: LifeState): LifeCommand[] {
  if (st.day % 5 !== 0) return [];
  const cmds: LifeCommand[] = [];
  for (const u of st.units) if (u.id !== null && draw(st.seed, 'switch-demote', `${st.day}|${u.id}`) < 0.3) cmds.push({ kind: 'demote', key: `d.${u.id}`, id: u.id, cause: { kind: 'no_interaction', driver_event_ids: [`synthetic-schedule.${st.day}`] } });
  const pooledAdults = st.units.filter((u) => u.id === null && u.stage === 2).reduce((a, u) => a + u.n, 0);
  if (pooledAdults >= 4) cmds.push({ kind: 'promote', key: 'p', region: 'G', stage: 2, n: 4, cause: { kind: 'interaction_need', driver_event_ids: [`synthetic-schedule.${st.day}`] } });
  return cmds;
}

export interface Metrics {
  final_n: number; final_by_stage: number[]; mean_n: number; births: number; deaths_by_stage: number[]; deaths_hungry: number;
  food_eaten: number; respired: number; adult_entries: number; mean_age_at_adult: number | null; mean_age_at_death_adult: number | null;
  extinct: boolean; series: number[];
}
export function runOnce(sc: Scenario, mode: Mode, seed: string, onDay?: (before: LifeState, recs: LifeRecord[], after: LifeState) => void): Metrics {
  let st = initialState(sc, mode, seed);
  const m: Metrics = { final_n: 0, final_by_stage: [0, 0, 0], mean_n: 0, births: 0, deaths_by_stage: [0, 0, 0], deaths_hungry: 0, food_eaten: 0, respired: 0, adult_entries: 0, mean_age_at_adult: null, mean_age_at_death_adult: null, extinct: false, series: [] };
  let adultAge = 0, deadAdultAge = 0;
  for (let d = 0; d < sc.days; d++) {
    const out = lifeDay(st, SYNTH.params, { temp_c: tempOf(st.day), inflow: { G: sc.inflow }, commands: mode === 'mixed' ? switching(st) : [] });
    onDay?.(st, out.records, out.state);
    for (const r of out.records) {
      if (r.kind === 'birth') m.births += r.count;
      if (r.kind === 'feed') m.food_eaten += r.mass[0].amount;
      if (r.kind === 'burn') m.respired += r.mass[0].amount;
      if (r.kind === 'death') { m.deaths_by_stage[r.stage!] += r.count; if (r.hungry) m.deaths_hungry += r.count; if (r.stage === 2) deadAdultAge += r.age_sum!; }
      if (r.kind === 'transition' && r.stage === 2) { m.adult_entries += r.count; adultAge += r.age_sum!; }
    }
    st = out.state;
    const n = st.units.reduce((a, u) => a + u.n, 0);
    m.series.push(n);
  }
  for (const u of st.units) m.final_by_stage[u.stage] += u.n;
  m.final_n = m.final_by_stage.reduce((a, b) => a + b, 0);
  m.mean_n = m.series.reduce((a, b) => a + b, 0) / m.series.length;
  m.mean_age_at_adult = m.adult_entries > 0 ? adultAge / m.adult_entries : null;
  m.mean_age_at_death_adult = m.deaths_by_stage[2] > 0 ? deadAdultAge / m.deaths_by_stage[2] : null;
  m.extinct = m.final_n < 0.5;
  return m;
}

export const METRICS: [string, (m: Metrics) => number | null][] = [
  ['final N', (m) => m.final_n], ['mean N', (m) => m.mean_n], ['final eggs', (m) => m.final_by_stage[0]], ['final nymphs', (m) => m.final_by_stage[1]],
  ['final adults', (m) => m.final_by_stage[2]], ['births', (m) => m.births], ['food eaten', (m) => m.food_eaten], ['respired', (m) => m.respired],
  ['deaths egg', (m) => m.deaths_by_stage[0]], ['deaths nymph', (m) => m.deaths_by_stage[1]], ['deaths adult', (m) => m.deaths_by_stage[2]],
  ['deaths while hungry', (m) => m.deaths_hungry], ['mean age at adulthood', (m) => m.mean_age_at_adult], ['mean adult age at death', (m) => m.mean_age_at_death_adult],
  ['extinct (share)', (m) => (m.extinct ? 1 : 0)],
];
export interface Row { scenario: string; metric: string; mode: Mode; mean: number | null; sd: number | null; ref_mean: number | null; rel_err: number | null; z: number | null }
const meanSd = (xs: number[]) => {
  if (xs.length === 0) return { mean: null, sd: null };
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { mean: mu, sd: xs.length > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1)) : 0 };
};
/** compare every mode against 'individual' over the given seeds; z = difference / combined standard error */
export function compare(scenarios: Scenario[], seeds: string[], modes: Mode[] = MODES): Row[] {
  const rows: Row[] = [];
  for (const sc of scenarios) {
    const runs = new Map<Mode, Metrics[]>();
    for (const mode of modes) runs.set(mode, mode === 'mean-field' ? [runOnce(sc, mode, 'mean-field')] : seeds.map((s) => runOnce(sc, mode, s)));
    for (const [name, f] of METRICS) {
      const vals = (mode: Mode) => runs.get(mode)!.map(f).filter((x): x is number => x !== null);
      const ref = meanSd(vals('individual')), nRef = vals('individual').length;
      for (const mode of modes) {
        const xs = vals(mode), s = meanSd(xs);
        const se = Math.sqrt((ref.sd ?? 0) ** 2 / Math.max(1, nRef) + (mode === 'mean-field' ? 0 : (s.sd ?? 0) ** 2 / Math.max(1, xs.length)));
        const diff = s.mean !== null && ref.mean !== null ? s.mean - ref.mean : null;
        rows.push({ scenario: sc.name, metric: name, mode, mean: s.mean, sd: s.sd, ref_mean: ref.mean,
          rel_err: diff !== null && ref.mean !== null && Math.abs(ref.mean) > 1e-9 ? diff / ref.mean : null, z: diff !== null && se > 0 ? diff / se : diff === 0 ? 0 : null });
      }
    }
  }
  return rows;
}
