/**
 * P0-A2 phase 2 — OBSERVATION operators (player / research view; design §4.6). Pure functions of the event log and of
 * the statistics copy; they never feed anything back into the world (no decision receives their output).
 *  - virtual trap at the nest entrance: counts exits and returns per 3-hour bin from 00:00 (the bins of R145); a real
 *    bait trap recruits ants, this one does not — compare SHAPES only, never absolute numbers (design §7.2).
 *  - activity by hour: share of worker-time outside the nest per local hour, and exits per hour.
 * Everything here is a DIAGNOSTIC, not a target (CLAUDE.md §7).
 */
import { WORKER_STATES, type Stats } from './types.ts';
import { MS_PER_DAY, MS_PER_HOUR } from './environment.ts';

const OUTSIDE = new Set(['outbound', 'searching', 'feeding', 'returning']);

export interface ActivityReport {
  label: string;
  days: number;
  /** per local hour 0..23: fraction of all worker-time spent outside the nest (pooled over days) */
  outside_share_by_hour: number[];
  /** per local hour: fraction of worker-time per state */
  state_share_by_hour: Record<string, number[]>;
  exits_by_hour: number[]; declines_by_hour: number[];
  /** virtual entrance trap, 3-hour bins from 00:00: exits + returns */
  trap_3h: number[];
  /** exits while the sun was up (sunrise..sunset) vs not, from the light events in the log */
  exits_day: number; exits_twilight_or_night: number;
}

export function activityReport(stats: Stats, lines: readonly string[], label: string): ActivityReport {
  const total = new Array(24).fill(0), outside = new Array(24).fill(0);
  for (const s of WORKER_STATES) for (let h = 0; h < 24; h++) { total[h] += stats.occ[s][h]; if (OUTSIDE.has(s)) outside[h] += stats.occ[s][h]; }
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
  const share: Record<string, number[]> = {};
  for (const s of WORKER_STATES) share[s] = stats.occ[s].map((v, h) => (total[h] ? r6(v / total[h]) : 0));
  const trap = new Array(8).fill(0);
  let light = 'night', exitsDay = 0, exitsOther = 0, last = 0;
  for (const line of lines) {
    const e = JSON.parse(line) as { t: number; k: string; p: { to?: string; choice?: string } };
    last = Math.max(last, e.t);
    if (e.k === 'env_light') light = e.p.to!;
    const bin = Math.floor((e.t % MS_PER_DAY) / (3 * MS_PER_HOUR));
    if (e.k === 'at_entrance' && e.p.choice === 'exit') { trap[bin]++; if (light === 'day') exitsDay++; else exitsOther++; }
    if (e.k === 'arrive_nest') trap[bin]++;
  }
  return {
    label, days: r6(last / MS_PER_DAY),
    outside_share_by_hour: outside.map((v, h) => (total[h] ? r6(v / total[h]) : 0)), state_share_by_hour: share,
    exits_by_hour: [...stats.exits_by_hour], declines_by_hour: [...stats.declines_by_hour], trap_3h: trap,
    exits_day: exitsDay, exits_twilight_or_night: exitsOther,
  };
}
