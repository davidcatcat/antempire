/**
 * Digest of the natural-walk outputs (models A/B/C, both directions, the §8 seeds, plus the Δc and start-offset sets):
 * executed segments, plan segments, controller events, clamps, arrival and the sensed values. Used to prove that a
 * refactor leaves model outputs bit-identical (the expected value was recorded BEFORE the local-sensing refactor).
 */
import crypto from 'node:crypto';
import { loadCandidates } from '../prototypes/kinematics2d/lib.ts';
import { trailAnt } from '../prototypes/natural-walk/lib.ts';

export function walkDigest(): { digest: string; runs: number } {
  const ts = loadCandidates().natural_walk.trail_scenario, h = crypto.createHash('sha256');
  let n = 0;
  const add = (m: 'A' | 'B' | 'C', seed: number, i: number, opts: { speed?: number; control_dt?: number; offset_mm?: number }) => {
    const { plan, res } = trailAnt(m, seed, i, opts);
    h.update(JSON.stringify({ segs: plan.track.segs, events: plan.events, clamps: plan.clamps, arrival: plan.arrival_t_s, sensed: plan.sensor_samples.map((s) => [s.t, s.left.x_mm, s.left.y_mm, s.left.c, s.right.x_mm, s.right.y_mm, s.right.c]), executed: res.executed[plan.track.id].segs }));
    n++;
  };
  for (const m of ['A', 'B', 'C'] as const) for (const dir of ['out', 'ret'] as const) for (const seed of ts.seeds as number[]) for (let i = 0; i < ts.ants_per_seed; i++)
    add(m, seed * 10 + (dir === 'out' ? 0 : 1), i, { speed: dir === 'out' ? ts.speed_outbound_mm_s.value : ts.speed_return_mm_s.value });
  for (const dt of [0.01, 0.05, 0.1]) for (const seed of ts.seeds as number[]) for (let i = 0; i < ts.ants_per_seed; i++) add('C', seed * 10, i, { speed: ts.speed_outbound_mm_s.value, control_dt: dt });
  for (const seed of ts.seeds as number[]) for (let i = 0; i < ts.ants_per_seed; i++) add('C', seed * 10, i, { speed: ts.speed_outbound_mm_s.value, offset_mm: 5 });
  return { digest: h.digest('hex'), runs: n };
}
if (import.meta.url === `file://${process.argv[1]}`) console.log(JSON.stringify(walkDigest()));
