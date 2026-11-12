/**
 * PH-3b episode scheduler: the down-crossing bracket and the same-instant (Zeno) guard (docs/physics-ph3b-solver2d.md §2.6).
 * BLOCKING.
 *  1. downCrossingBracket on the DISAGREEING case: pairFirstHit (inflated capsules) says `overlapping` while the solver's
 *     own gap function is still above the threshold (≈ 1e-16 mm apart). The former code returned [from, from]: an episode
 *     event at `from` that crosses nothing and is re-scheduled at the same instant forever. Now the bracket is either a
 *     real crossing strictly after `from` (old side false, new side true) or null.
 *  2. the agreeing cases are unchanged ([from, from] when both agree; plain bisection when pairFirstHit gives τ > 0).
 *  3. episode-only batches count against the same-instant guard (source check: the branch is guarded).
 *  4. watchdog: the two-ant flank-contact scenario (≈ 1,600 sliding re-solves, the case that stresses episode scheduling)
 *     runs in a child process with a time limit and finishes clean (a same-instant loop would hit the limit, not hang CI).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { downCrossingBracket, ACTIVE_TOL_MM } from '../engine/physics/solver2d.ts';
import { REPO_ROOT } from '../cli/lib/load.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const th = ACTIVE_TOL_MM;
/** golden-section minimiser of a convex function (the solver passes its own argminG) */
const argminOf = (g: (t: number) => number) => (a: number, b: number) => {
  const r = (Math.sqrt(5) - 1) / 2; let x1 = b - r * (b - a), x2 = a + r * (b - a), f1 = g(x1), f2 = g(x2);
  for (let k = 0; k < 200 && b - a > 1e-15 * Math.max(1, Math.abs(b)); k++) { if (f1 <= f2) { b = x2; x2 = x1; f2 = f1; x1 = b - r * (b - a); f1 = g(x1); } else { a = x1; x1 = x2; f1 = f2; x2 = a + r * (b - a); f2 = g(x2); } }
  return f1 <= f2 ? x1 : x2;
};
/** the former branch, kept here only to show what it did on the disagreeing case */
const formerOverlapReturn = (from: number, h: { tau: number; overlapping: boolean }) => (h.overlapping ? [from, from] as [number, number] : null);
const evidence: Record<string, unknown> = {};

// ---- 1. disagreeing case, gap still closing: a real crossing strictly after `from`
for (const from of [0, 0.37, 2.5, 117.25]) {
  const g = (t: number) => th + 1e-16 - 1e-3 * (t - from);           // above th at `from` by 1e-16 mm, closing at 1e-3 mm/s
  const below = (t: number) => g(t) <= th, h = { tau: 0, overlapping: true };
  ok(!below(from), `from ${from}: the gap function is above th at from (the disagreeing case)`);
  const old = formerOverlapReturn(from, h)!;
  ok(old[1] === from && !below(old[1]), `from ${from}: the former code returned [from, from] although g(from) > th (an event that crosses nothing)`);
  const r = downCrossingBracket(from, h, below, argminOf(g));
  ok(r !== null && r[1] > from && !below(r[0]) && below(r[1]) && r[0] < r[1], `from ${from}: the bracket is a real down-crossing strictly after from (${r})`);
  evidence[`closing@${from}`] = r;
}
// ---- 1b. disagreeing case, tangent (gap constant just above th): no crossing at all, never an event at `from`
for (const from of [0, 2.5]) {
  const g = (_t: number) => th + 1e-16, below = (t: number) => g(t) <= th;
  ok(downCrossingBracket(from, { tau: 0, overlapping: true }, below, argminOf(g)) === null, `from ${from}: tangent disagreeing case → no down-crossing (former: [from, from] forever)`);
}
// ---- 2. agreeing cases unchanged
{
  const from = 1.5, g = (t: number) => th - 1e-12 - 1e-3 * (t - from), below = (t: number) => g(t) <= th;
  const r = downCrossingBracket(from, { tau: 0, overlapping: true }, below, argminOf(g));
  ok(r !== null && r[0] === from && r[1] === from, 'both computations agree on the overlap → [from, from] as before');
  ok(downCrossingBracket(from, null, below, argminOf(g)) === null, 'no first touch → null');
  // a regular approach: g(t) = th + 0.5 − 2 (t − from), crossing at from + 0.25
  const g2 = (t: number) => th + 0.5 - 2 * (t - from), below2 = (t: number) => g2(t) <= th;
  const r2 = downCrossingBracket(from, { tau: 0.25, overlapping: false }, below2, argminOf(g2))!;
  ok(r2 && !below2(r2[0]) && below2(r2[1]) && Math.abs(r2[1] - (from + 0.25)) < 1e-12, `regular approach: bracket at the root (${r2})`);
}
// ---- 3. episode-only batches are guarded
{
  const src = fs.readFileSync(path.join(REPO_ROOT, 'engine/physics/solver2d.ts'), 'utf8');
  const m = /if \(!batch\.length\) \{([\s\S]*?)continue;\s*\}/.exec(src);
  ok(m && /\+\+epSameCount > maxSame/.test(m[1]) && /Zeno guard/.test(m[1]) && /break;/.test(m[1]), 'episode-only batches count against the same-instant (Zeno) guard');
  ok(!/if \(h\.overlapping\) return \[from, from\]/.test(src), 'the unconditional [from, from] return is gone');
}
// ---- 4. watchdog run in a child process (a same-instant loop would be killed by the time limit, not hang the suite)
{
  const code = `import { solve2D } from ${JSON.stringify(path.join(REPO_ROOT, 'engine/physics/solver2d.ts'))};
    const B = { length_mm: 2.5, width_mm: 0.8 };
    const lanes = [{ id: 'EW', centerline_mm: [{ x: 0, y: 50 }, { x: 100, y: 50 }], width_mm: 2, layer: 'z' }, { id: 'NS', centerline_mm: [{ x: 50, y: 0 }, { x: 50, y: 100 }], width_mm: 2, layer: 'z' }];
    const r = solve2D({ lanes, obstacles: [], horizon_s: 3, agents: [
      { id: 'E', lane: 'EW', s_mm: 45, u_mm: 0, dir: 1, start_t_s: 0.1, goal_s_mm: 60, free_speed_mm_s: 17, body: B },
      { id: 'N', lane: 'NS', s_mm: 45, u_mm: 0, dir: 1, start_t_s: 0, goal_s_mm: 60, free_speed_mm_s: 17, body: B }] });
    console.log(JSON.stringify({ aborted: r.stats.aborted, episodes: r.stats.contact_episodes, starts: r.events.filter((e) => e.kind === 'contact_start').length, ends: r.events.filter((e) => e.kind === 'contact_end').length }));`;
  const c = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 120_000 });
  ok(c.error === undefined && c.status === 0, `watchdog child finished within the time limit (${c.error ?? c.stderr.slice(0, 300)})`);
  const out = JSON.parse(c.stdout.trim().split('\n').at(-1)!);
  ok(out.aborted === null && out.episodes === 1 && out.starts === 1 && out.ends === 1, `flank contact: one episode, not aborted (${JSON.stringify(out)})`);
  evidence.watchdog = out;
}
console.log(JSON.stringify({ ph3b_crossing_guard: 'pass', checks, evidence }, null, 2));
