/**
 * Day0 golden traces (v2-review.15): Day0 world build + daily output hash chains for fixed founding ×
 * season × seed cases. Pure refactors must keep these byte-identical (tests/golden.test.ts).
 *   h_0 = sha256(JSON.stringify([day0 state, warm-up events])); h_d = sha256(h_{d-1} + JSON.stringify([result, state]))
 */
import crypto from 'node:crypto';
import { simulateWorldDay } from '../../engine/index.ts';
import { loadBundle } from '../../cli/lib/load.ts';
import { buildDay0, seasonStart, SEASONS, SUPPORTED_FOUNDINGS, type FoundingId, type Season } from '../../cli/lib/day0.ts';

export interface Day0Case { name: string; founding: FoundingId; season: Season; seed: number; days: number }
export const DAY0_GOLDEN_CASES: Day0Case[] = SUPPORTED_FOUNDINGS.flatMap((founding) => SEASONS.flatMap((season) => [20270001, 20270002].map((seed) => ({ name: `${founding}-${season}-${seed}`, founding, season, seed, days: 90 }))));

export function traceDay0(c: Day0Case): { days: number; day0_sha256: string; sha256: string } {
  const bundle = loadBundle(), init = buildDay0(c.founding, c.seed, seasonStart(c.season), bundle);
  const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
  const day0 = sha(JSON.stringify([init.state, init.warmup.events]));
  let chain = day0, s = init.state;
  for (let d = 0; d < c.days; d++) { const o = simulateWorldDay(s, bundle); chain = sha(chain + JSON.stringify([o.result, o.state])); s = o.state; }
  return { days: c.days, day0_sha256: day0, sha256: chain };
}
