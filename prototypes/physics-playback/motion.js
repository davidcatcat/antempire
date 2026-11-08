// Physics playback: pose of an agent at time t from the exported piecewise motion (no DOM; also used by the node test).
// A segment [t0, t1] is the solver's own straight constant-velocity translation between two exact recorded poses, so
// evaluating it at t is the solver's motion, not an interpolation of output samples. No smoothing of any kind.

/** index of the segment that holds t (the later one at a shared boundary); -1 before the first, n at/after the end */
export function segmentIndex(agent, t) {
  const S = agent.segments;
  if (!S.length || t < S[0].t0) return -1;
  let lo = 0, hi = S.length - 1;
  if (t >= S[hi].t1) return S.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (S[m].t0 <= t) lo = m; else hi = m - 1; }
  return lo;
}

/** exact pose {x, y, heading, speed, s, u, moving} of an agent at time t (held at the end pose after the last segment) */
export function poseAt(agent, t) {
  const S = agent.segments, i = segmentIndex(agent, t);
  if (i < 0) { const g = S[0]; return { x: g.x0, y: g.y0, heading: g.heading, speed: 0, s: g.s0, u: g.u, moving: false }; }
  if (i >= S.length) { const f = agent.final, g = S[S.length - 1]; return { x: f.x, y: f.y, heading: f.heading, speed: 0, s: g.s1, u: g.u1 === undefined ? g.u : g.u1, moving: false }; }
  const g = S[i], f = (t - g.t0) / (g.t1 - g.t0);
  // the end pose at t = t1 exactly is taken from the record itself (no rounding from the fraction)
  if (t === g.t1) return { x: g.x1, y: g.y1, heading: g.heading, speed: g.speed_mm_s, s: g.s1, u: g.u1 === undefined ? g.u : g.u1, moving: g.speed_mm_s > 0 };
  return { x: g.x0 + (g.x1 - g.x0) * f, y: g.y0 + (g.y1 - g.y0) * f, heading: g.heading, speed: g.speed_mm_s, s: g.s0 + (g.s1 - g.s0) * f, u: g.u1 === undefined ? g.u : g.u + (g.u1 - g.u) * f, moving: g.speed_mm_s > 0 };
}

/** sorted distinct event times of a run */
export function eventTimes(run) {
  const ts = [...new Set(run.events.map((e) => e.t))];
  ts.sort((a, b) => a - b);
  return ts;
}

/** every segment boundary time of a run (what the page can draw as a change of motion) */
export function boundaryTimes(run) {
  const ts = new Set();
  for (const a of run.agents) for (const g of a.segments) { ts.add(g.t0); ts.add(g.t1); }
  return [...ts].sort((a, b) => a - b);
}

/** index of the last event with time ≤ t (−1 if none) */
export function lastEventAt(run, t) {
  const E = run.events;
  let lo = 0, hi = E.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (E[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
