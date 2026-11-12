/**
 * Issue #158 — destinations, capacity-limited sites and an occupancy ledger (isolated; solver-agnostic).
 *
 * Status: isolated physics experiment interface. NOT imported by the daily loop, Day0, cli/ or web/
 * (tests/physics-isolation.test.ts). It does not move bodies: a 2D producer (WP4 steer2D, kinematics2d, PH-3b)
 * decides WHEN an agent reaches a site; this module decides, from site geometry-derived capacity, occupancy and dwell,
 * what happens next (admitted / queued / turned away / released) and checks that any producer's event stream obeys
 * conservation. Every capacity, dwell and queue limit is a candidate boundary value (assumption: true); there is no
 * focal-species data for nest-mouth or food-site capacity (docs/physics-destinations-traffic.md).
 *
 * Time: continuous line. Inputs are finite numbers interpreted by their shortest decimal representation (the number
 * written in the JSON input). Sums such as admit + dwell are computed exactly on the decimals and rounded once, so
 * 0.1 + 0.2 releases at exactly 0.3 (same contract as the WP4 exact-time helper; to be unified on merge).
 *
 * Same-instant policy (producer rule, documented): at one exact instant t the ledger processes
 *   1. dwell expiries at t (releases; a release to another site is an arrival there at the same t),
 *   2. explicit departs at t,
 *   3. queue admissions (FIFO by queued time, then tie key),
 *   4. new arrivals at t (by tie key): admit if a slot is free and nobody is queued, else queue, else turn away.
 * Tie key never depends on array order: 'agent_id' (code-unit string order) or 'seeded_hash' (FNV-1a of
 * seed|site|t|agent, then agent id). Releases before admissions at the same t mirrors WP4 ("exit before entry").
 */

// ---------------------------------------------------------------- exact decimal time

/** m × 10^-e, e >= 0. */
export interface Dec { m: bigint; e: number }

export class DestinationRefused extends Error {}

const DEC_RE = /^(-?)(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/;

export const decParse = (txt: string): Dec => {
  const r = DEC_RE.exec(txt);
  if (!r) throw new DestinationRefused(`cannot read ${txt} as a decimal`);
  const frac = r[3] ?? '';
  let m = BigInt(r[2] + frac);
  let e = frac.length - Number(r[4] ?? 0);
  if (e < 0) { m *= 10n ** BigInt(-e); e = 0; }
  if (r[1] === '-') m = -m;
  return norm({ m, e });
};
export const dec = (n: number): Dec => {
  if (!Number.isFinite(n)) throw new DestinationRefused(`time must be finite, got ${n}`);
  return decParse(String(n));
};
const norm = (d: Dec): Dec => { let { m, e } = d; while (e > 0 && m % 10n === 0n) { m /= 10n; e--; } return { m, e }; };
const align = (a: Dec, b: Dec): [bigint, bigint, number] => {
  const e = Math.max(a.e, b.e);
  return [a.m * 10n ** BigInt(e - a.e), b.m * 10n ** BigInt(e - b.e), e];
};
export const decAdd = (a: Dec, b: Dec): Dec => { const [x, y, e] = align(a, b); return norm({ m: x + y, e }); };
export const decMul = (a: Dec, k: number): Dec => {
  if (!Number.isInteger(k)) throw new DestinationRefused('decMul: integer multiplier only');
  return norm({ m: a.m * BigInt(k), e: a.e });
};
export const decCmp = (a: Dec, b: Dec): number => { const [x, y] = align(a, b); return x < y ? -1 : x > y ? 1 : 0; };
export const decStr = (d: Dec): string => {
  const neg = d.m < 0n; let s = (neg ? -d.m : d.m).toString();
  if (d.e > 0) { s = s.padStart(d.e + 1, '0'); s = `${s.slice(0, s.length - d.e)}.${s.slice(s.length - d.e)}`; }
  return (neg ? '-' : '') + s;
};
/** One rounding: decimal string → nearest double. */
export const decNum = (d: Dec): number => Number(decStr(d));
/** Compare two input times on their decimals (exact equality = same instant). */
export const timeCmp = (a: number, b: number): number => decCmp(dec(a), dec(b));

// ---------------------------------------------------------------- deterministic tie key

export const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
};
const strCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export type TiePolicy = { kind: 'agent_id' } | { kind: 'seeded_hash'; seed: number };

const tieKey = (p: TiePolicy, site: string, t: string, agent: string): [number, string] =>
  p.kind === 'agent_id' ? [0, agent] : [fnv1a(`${p.seed}|${site}|${t}|${agent}`), agent];
const keyCmp = (a: [number, string], b: [number, string]): number => (a[0] - b[0]) || strCmp(a[1], b[1]);

// ---------------------------------------------------------------- taxonomy (Issue #158)

/** What an agent's arrival can turn into. */
export type ArrivalOutcome =
  | 'arrived_at_nest_mouth' | 'entered_nest' | 'arrived_at_food' | 'temporary_stay' | 'continue_moving' | 'left_road';
export type SiteKind = 'nest_mouth' | 'nest_interior' | 'food_site' | 'stay_spot' | 'road_exit';

export interface OutcomeRequirement {
  site_kind: SiteKind | null;          // null: no site ledger (pass-through)
  needs_geometry: boolean;             // site footprint / opening width in the 2D world
  needs_capacity: boolean;             // max bodies simultaneously at the site
  needs_occupancy: boolean;            // ledger of who is there now
  needs_dwell: boolean;                // how long an admitted agent stays (fixed or behaviour-driven)
  removes_from_plane: boolean;         // the body stops being an obstacle in the 2D plane
  note: string;
}

export const OUTCOME_REQUIREMENTS: Readonly<Record<ArrivalOutcome, OutcomeRequirement>> = Object.freeze({
  arrived_at_nest_mouth: { site_kind: 'nest_mouth', needs_geometry: true, needs_capacity: true, needs_occupancy: true, needs_dwell: true, removes_from_plane: false, note: 'body stays in the plane at the opening; capacity from opening width vs body width (geometry), dwell = time to pass the opening' },
  entered_nest: { site_kind: 'nest_interior', needs_geometry: false, needs_capacity: true, needs_occupancy: true, needs_dwell: false, removes_from_plane: true, note: 'transfer out of the 2D plane into the nest compartment; interior capacity is a nest-architecture question, not traffic' },
  arrived_at_food: { site_kind: 'food_site', needs_geometry: true, needs_capacity: true, needs_occupancy: true, needs_dwell: true, removes_from_plane: false, note: 'feeding positions around the item/droplet; dwell = feeding time (behaviour, crop fill) — fixed dwell is only a control' },
  temporary_stay: { site_kind: 'stay_spot', needs_geometry: true, needs_capacity: true, needs_occupancy: true, needs_dwell: true, removes_from_plane: false, note: 'pause in place (antennation, grooming, waiting); body is still an obstacle' },
  continue_moving: { site_kind: null, needs_geometry: false, needs_capacity: false, needs_occupancy: false, needs_dwell: false, removes_from_plane: false, note: 'waypoint only; no ledger, the producer keeps moving the body' },
  left_road: { site_kind: 'road_exit', needs_geometry: true, needs_capacity: true, needs_occupancy: true, needs_dwell: true, removes_from_plane: true, note: 'leave the modelled road segment (WP4 exit control); after dwell the body is off the plane' },
});

// ---------------------------------------------------------------- sites, requests, events

export interface Provenance {
  assumption: true;
  basis: '文獻支持' | '一般生理學' | '遊戲假設';
  candidate_boundary: true;            // Issue #158: isolated-experiment boundary value, not real ecology
  source_ids: string[];
  note: string;
}

export type ReleaseTarget = 'road' | 'off_plane' | { site: string };

export interface SiteSpec {
  id: string;
  kind: SiteKind;
  /** Max agents present at once. null = unknown → the scheduler refuses (never invents a value). */
  capacity: number | null;
  /** Fixed occupancy time. null = released only by an explicit 'depart' request (behaviour-driven dwell). */
  dwell_s: number | null;
  /** Max agents waiting. null = unknown → refuse. 0 = nobody waits (arrivals beyond capacity are turned away). */
  queue_max: number | null;
  on_release: ReleaseTarget;
  provenance: Provenance;
}

export interface SiteRequest { t: number; agent: string; site: string; kind: 'arrive' | 'depart' }

export type SiteEventKind = 'arrive' | 'admit' | 'queue' | 'turn_away' | 'release' | 'abandon';

export interface SiteEvent {
  t: number;              // double (one rounding of t_exact)
  t_exact: string;        // shortest exact decimal
  agent: string;
  site: string;
  kind: SiteEventKind;
  to?: string;            // release target: 'road' | 'off_plane' | site id
  occupancy_after: number;
  queue_after: number;
}

export interface LedgerRun { events: SiteEvent[]; summary: Record<string, SiteSummary> }
export interface SiteSummary { arrived: number; entered: number; exited: number; present: number; queued: number; turned_away: number; abandoned: number }

const targetStr = (r: ReleaseTarget): string => (typeof r === 'string' ? r : r.site);

export const validateSites = (sites: SiteSpec[]): void => {
  const ids = new Set<string>();
  for (const s of sites) {
    if (ids.has(s.id)) throw new DestinationRefused(`duplicate site id ${s.id}`);
    ids.add(s.id);
    if (s.capacity === null) throw new DestinationRefused(`site ${s.id}: capacity is unknown (null); supply an explicit candidate boundary value`);
    if (s.queue_max === null) throw new DestinationRefused(`site ${s.id}: queue_max is unknown (null); supply an explicit candidate boundary value`);
    if (!Number.isInteger(s.capacity) || s.capacity < 1) throw new DestinationRefused(`site ${s.id}: capacity must be an integer >= 1`);
    if (!Number.isInteger(s.queue_max) || s.queue_max < 0) throw new DestinationRefused(`site ${s.id}: queue_max must be an integer >= 0`);
    if (s.dwell_s !== null && !(Number.isFinite(s.dwell_s) && s.dwell_s > 0)) throw new DestinationRefused(`site ${s.id}: dwell_s must be positive finite or null`);
    if (s.provenance?.assumption !== true || s.provenance.candidate_boundary !== true) throw new DestinationRefused(`site ${s.id}: provenance must be assumption: true, candidate_boundary: true`);
  }
  for (const s of sites) if (typeof s.on_release !== 'string' && !ids.has(s.on_release.site)) throw new DestinationRefused(`site ${s.id}: release target ${s.on_release.site} is not a site`);
};

export const outcomeOf = (k: SiteKind): ArrivalOutcome =>
  ({ nest_mouth: 'arrived_at_nest_mouth', nest_interior: 'entered_nest', food_site: 'arrived_at_food', stay_spot: 'temporary_stay', road_exit: 'left_road' } as const)[k];

type Where = { at: 'free' } | { at: 'queued'; site: string } | { at: 'present'; site: string };

/**
 * Reference ledger scheduler: pure, deterministic, independent of request array order.
 * Refuses inputs that would put one agent in two places (arrive while present/queued) or depart while absent.
 */
export const runSiteLedger = (sites: SiteSpec[], requests: SiteRequest[], tie: TiePolicy = { kind: 'agent_id' }): LedgerRun => {
  validateSites(sites);
  const site = new Map(sites.map((s) => [s.id, s] as const));
  for (const r of requests) {
    if (!site.has(r.site)) throw new DestinationRefused(`request for unknown site ${r.site}`);
    if (r.kind !== 'arrive' && r.kind !== 'depart') throw new DestinationRefused(`unknown request kind ${String(r.kind)}`);
    dec(r.t);
  }
  // pending requests grouped by exact instant (string key); order inside the group is decided by the tie key only
  const pending = new Map<string, SiteRequest[]>();
  for (const r of requests) { const k = decStr(dec(r.t)); (pending.get(k) ?? pending.set(k, []).get(k)!).push(r); }
  const where = new Map<string, Where>();
  const present = new Map<string, Map<string, Dec | null>>(sites.map((s) => [s.id, new Map()]));   // agent → due release (null: waits for depart)
  const queue = new Map<string, { agent: string; tq: Dec }[]>(sites.map((s) => [s.id, []]));   // push order = FIFO (t, tie key)
  const events: SiteEvent[] = [];
  const sum: Record<string, SiteSummary> = Object.fromEntries(sites.map((s) => [s.id, { arrived: 0, entered: 0, exited: 0, present: 0, queued: 0, turned_away: 0, abandoned: 0 }]));
  const emit = (t: Dec, agent: string, sid: string, kind: SiteEventKind, to?: string) => {
    const e: SiteEvent = { t: decNum(t), t_exact: decStr(t), agent, site: sid, kind, occupancy_after: present.get(sid)!.size, queue_after: queue.get(sid)!.length };
    if (to !== undefined) e.to = to;
    events.push(e);
  };
  const timesPending = () => [...pending.keys()].map(decParse);
  const nextTime = (): Dec | null => {
    let best: Dec | null = null;
    for (const d of timesPending()) if (!best || decCmp(d, best) < 0) best = d;
    for (const [, m] of present) for (const [, rt] of m) if (rt && (!best || decCmp(rt, best) < 0)) best = rt;
    return best;
  };
  const admit = (t: Dec, sid: string, agent: string) => {
    const s = site.get(sid)!;
    const rt = s.dwell_s === null ? null : decAdd(t, dec(s.dwell_s));
    present.get(sid)!.set(agent, rt);
    where.set(agent, { at: 'present', site: sid });
    sum[sid].entered++;
    emit(t, agent, sid, 'admit');
  };
  const release = (t: Dec, sid: string, agent: string, arrivals: { agent: string; site: string }[]) => {
    const s = site.get(sid)!;
    present.get(sid)!.delete(agent);
    sum[sid].exited++;
    where.set(agent, { at: 'free' });
    emit(t, agent, sid, 'release', targetStr(s.on_release));
    if (typeof s.on_release !== 'string') arrivals.push({ agent, site: s.on_release.site });
  };
  const fillQueues = (t: Dec) => {
    for (const s of [...sites].sort((a, b) => strCmp(a.id, b.id))) {
      const q = queue.get(s.id)!;
      while (q.length && present.get(s.id)!.size < s.capacity!) { const h = q.shift()!; admit(t, s.id, h.agent); }
    }
  };
  for (let guard = 0; ; guard++) {
    if (guard > 1e7) throw new DestinationRefused('ledger did not terminate');
    const t = nextTime(); if (!t) break;
    const tk = decStr(t);
    const transfers: { agent: string; site: string }[] = [];
    // 1. dwell expiries
    const due: { agent: string; site: string }[] = [];
    for (const [sid, m] of present) for (const [a, rt] of m) if (rt && decCmp(rt, t) === 0) due.push({ agent: a, site: sid });
    due.sort((x, y) => strCmp(x.site, y.site) || keyCmp(tieKey(tie, x.site, tk, x.agent), tieKey(tie, y.site, tk, y.agent)));
    for (const d of due) release(t, d.site, d.agent, transfers);
    const reqs = pending.get(tk) ?? []; pending.delete(tk);
    const byKey = (x: { agent: string; site: string }, y: { agent: string; site: string }) => keyCmp(tieKey(tie, x.site, tk, x.agent), tieKey(tie, y.site, tk, y.agent)) || strCmp(x.site, y.site);
    // 2. explicit departs
    for (const r of reqs.filter((q) => q.kind === 'depart').sort(byKey)) {
      const w = where.get(r.agent);
      if (w?.at === 'present' && w.site === r.site) {
        if (site.get(r.site)!.dwell_s !== null) throw new DestinationRefused(`agent ${r.agent}: depart from fixed-dwell site ${r.site}`);
        release(t, r.site, r.agent, transfers);
      } else if (w?.at === 'queued' && w.site === r.site) {
        const q = queue.get(r.site)!; q.splice(q.findIndex((h) => h.agent === r.agent), 1);
        where.set(r.agent, { at: 'free' }); sum[r.site].abandoned++;
        emit(t, r.agent, r.site, 'abandon');
      } else throw new DestinationRefused(`agent ${r.agent}: depart from ${r.site} at ${tk} but it is not there (release before admission)`);
    }
    // 3. queues move up
    fillQueues(t);
    // 4. arrivals (input arrivals and same-instant transfers)
    const arr = [...reqs.filter((q) => q.kind === 'arrive').map((q) => ({ agent: q.agent, site: q.site })), ...transfers].sort(byKey);
    const seen = new Set<string>();
    for (const a of arr) {
      if (seen.has(a.agent)) throw new DestinationRefused(`agent ${a.agent} arrives at two sites at ${tk} (double occupancy)`);
      seen.add(a.agent);
      const w = where.get(a.agent);
      if (w && w.at !== 'free') throw new DestinationRefused(`agent ${a.agent} arrives at ${a.site} at ${tk} while ${w.at} at ${w.site} (double occupancy)`);
      const s = site.get(a.site)!; const q = queue.get(a.site)!;
      sum[a.site].arrived++;
      emit(t, a.agent, a.site, 'arrive');
      if (q.length === 0 && present.get(a.site)!.size < s.capacity!) admit(t, a.site, a.agent);
      else if (q.length < s.queue_max!) {
        q.push({ agent: a.agent, tq: t });
        where.set(a.agent, { at: 'queued', site: a.site }); sum[a.site].queued++;
        emit(t, a.agent, a.site, 'queue');
      } else { sum[a.site].turned_away++; emit(t, a.agent, a.site, 'turn_away'); }
    }
  }
  for (const s of sites) sum[s.id].present = present.get(s.id)!.size;
  return { events, summary: sum };
};

// ---------------------------------------------------------------- validator for ANY producer's event stream

export type ViolationKind =
  | 'time_not_monotone' | 'unknown_site' | 'double_occupancy' | 'release_before_admission' | 'admit_without_arrival'
  | 'over_capacity' | 'queue_overflow' | 'queue_jump' | 'dwell_mismatch' | 'ledger_mismatch' | 'conservation' | 'release_target';

export interface Violation { kind: ViolationKind; index: number; agent: string; site: string; detail: string }

/**
 * Check an event stream against the site specs. Works for streams produced by any solver (not only runSiteLedger).
 * Conservation per site after every event: entered = present + exited; arrived = entered_from_arrival + queued_now
 * + turned_away + abandoned + (admitted later from queue counted in entered). No agent in two places.
 */
export const validateSiteEvents = (sites: SiteSpec[], events: SiteEvent[]): Violation[] => {
  const out: Violation[] = [];
  const spec = new Map(sites.map((s) => [s.id, s] as const));
  const where = new Map<string, Where>();
  const pendingArrival = new Map<string, string>();   // agent → site, between 'arrive' and its decision
  const present = new Map<string, Map<string, Dec | null>>(sites.map((s) => [s.id, new Map()]));
  const queue = new Map<string, { agent: string; tq: Dec }[]>(sites.map((s) => [s.id, []]));
  const cnt = new Map<string, { entered: number; exited: number }>(sites.map((s) => [s.id, { entered: 0, exited: 0 }]));
  let prev: Dec | null = null;
  events.forEach((e, i) => {
    const bad = (kind: ViolationKind, detail: string) => out.push({ kind, index: i, agent: e.agent, site: e.site, detail });
    const s = spec.get(e.site);
    if (!s) { bad('unknown_site', e.site); return; }
    let t: Dec;
    try { t = decParse(e.t_exact); } catch { bad('ledger_mismatch', `t_exact ${e.t_exact} is not a decimal`); return; }
    if (decNum(t) !== e.t) bad('ledger_mismatch', `t ${e.t} != t_exact ${e.t_exact}`);
    if (prev && decCmp(t, prev) < 0) bad('time_not_monotone', `${e.t_exact} after ${decStr(prev)}`);
    prev = t;
    const w = where.get(e.agent) ?? { at: 'free' };
    const pres = present.get(e.site)!; const q = queue.get(e.site)!; const c = cnt.get(e.site)!;
    switch (e.kind) {
      case 'arrive':
        if (w.at !== 'free') bad('double_occupancy', `arrives at ${e.site} while ${w.at} at ${w.site}`);
        if (pendingArrival.has(e.agent)) bad('double_occupancy', `second arrival before the first was decided`);
        pendingArrival.set(e.agent, e.site);
        break;
      case 'admit': {
        const fromQueue = w.at === 'queued' && w.site === e.site;
        const fromArrival = pendingArrival.get(e.agent) === e.site;
        if (w.at === 'present') bad('double_occupancy', `admitted to ${e.site} while present at ${w.site}`);
        else if (!fromQueue && !fromArrival) bad('admit_without_arrival', 'no arrival or queue entry');
        if (fromQueue) {
          const idx = q.findIndex((h) => h.agent === e.agent);
          if (q.slice(0, idx).some((h) => decCmp(h.tq, q[idx].tq) < 0)) bad('queue_jump', 'an agent queued earlier is still waiting');
          q.splice(idx, 1);
        } else if (fromArrival && q.length > 0) bad('queue_jump', 'admitted on arrival while others wait');
        pendingArrival.delete(e.agent);
        pres.set(e.agent, s.dwell_s === null ? null : decAdd(t, dec(s.dwell_s)));
        where.set(e.agent, { at: 'present', site: e.site });
        c.entered++;
        if (pres.size > (s.capacity ?? Infinity)) bad('over_capacity', `occupancy ${pres.size} > capacity ${s.capacity}`);
        break;
      }
      case 'queue':
        if (pendingArrival.get(e.agent) !== e.site) bad('admit_without_arrival', 'queued without arriving');
        pendingArrival.delete(e.agent);
        q.push({ agent: e.agent, tq: t }); where.set(e.agent, { at: 'queued', site: e.site });
        if (q.length > (s.queue_max ?? Infinity)) bad('queue_overflow', `queue ${q.length} > queue_max ${s.queue_max}`);
        break;
      case 'turn_away':
        if (pendingArrival.get(e.agent) !== e.site) bad('admit_without_arrival', 'turned away without arriving');
        pendingArrival.delete(e.agent);
        break;
      case 'abandon': {
        const idx = q.findIndex((h) => h.agent === e.agent);
        if (idx < 0) bad('release_before_admission', 'abandons a queue it is not in'); else { q.splice(idx, 1); where.set(e.agent, { at: 'free' }); }
        break;
      }
      case 'release': {
        if (!(w.at === 'present' && w.site === e.site)) { bad('release_before_admission', `released from ${e.site} but ${w.at}${'site' in w ? ' at ' + w.site : ''}`); break; }
        const due = pres.get(e.agent);
        if (s.dwell_s !== null && due && decCmp(due, t) !== 0) bad('dwell_mismatch', `released at ${e.t_exact}, due ${decStr(due)}`);
        if (e.to !== undefined && e.to !== targetStr(s.on_release)) bad('release_target', `to ${e.to}, spec ${targetStr(s.on_release)}`);
        pres.delete(e.agent); where.set(e.agent, { at: 'free' }); c.exited++;
        break;
      }
      default: bad('ledger_mismatch', `unknown event kind ${String((e as SiteEvent).kind)}`);
    }
    if (e.occupancy_after !== pres.size || e.queue_after !== q.length) bad('ledger_mismatch', `declared occ/queue ${e.occupancy_after}/${e.queue_after}, recomputed ${pres.size}/${q.length}`);
    if (c.entered !== pres.size + c.exited) bad('conservation', `entered ${c.entered} != present ${pres.size} + exited ${c.exited}`);
    // no agent in two places: every present/queued agent appears exactly once across all sites
    const seen = new Map<string, number>();
    for (const m of present.values()) for (const a of m.keys()) seen.set(a, (seen.get(a) ?? 0) + 1);
    for (const qq of queue.values()) for (const h of qq) seen.set(h.agent, (seen.get(h.agent) ?? 0) + 1);
    if ((seen.get(e.agent) ?? 0) > 1) bad('double_occupancy', 'agent is listed at two places');
  });
  return out;
};

// ---------------------------------------------------------------- order-independence harness

/** Deterministic permutations of an input array (reverse, rotations, seeded shuffles) — never Math.random. */
export const permutationsOf = <T>(xs: T[], seeds: number[] = [1, 2, 3]): T[][] => {
  const out: T[][] = [[...xs].reverse()];
  if (xs.length > 1) out.push([...xs.slice(1), xs[0]]);
  for (const sd of seeds) {
    const a = [...xs]; let h = fnv1a(`perm|${sd}`);
    for (let i = a.length - 1; i > 0; i--) { h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0; const j = h % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
    out.push(a);
  }
  return out;
};

/** True if a producer gives byte-identical output for every permutation of its input array. */
export const isOrderIndependent = <I, O>(produce: (xs: I[]) => O, xs: I[]): { ok: boolean; differing: number } => {
  const ref = JSON.stringify(produce(xs));
  const diff = permutationsOf(xs).filter((p) => JSON.stringify(produce(p)) !== ref).length;
  return { ok: diff === 0, differing: diff };
};

// ---------------------------------------------------------------- traffic test families (Issue #158)

export type TrafficFamily = 'simultaneous_entry_stress' | 'timed_inflow_comparison';

export const FAMILY_SCOPE: Readonly<Record<TrafficFamily, { purpose: string; behavioural_conclusions_allowed: boolean; why: string }>> = Object.freeze({
  simultaneous_entry_stress: { purpose: 'stress: non-penetration, solver robustness, CPU/memory, worst-case jams', behavioural_conclusions_allowed: false, why: 'all agents start at once in a packed layout no colony produces; jams and arrival rates reflect the setup, not a behaviour rule' },
  timed_inflow_comparison: { purpose: 'compare candidate traffic rules at controlled inflow', behavioural_conclusions_allowed: true, why: 'inflow schedule is controlled and equal across candidates; still only candidate mechanisms (no focal-species traffic data)' },
});

/** Simultaneous entry: every agent scheduled at the same exact instant t0. */
export const simultaneousEntry = (agents: string[], t0: number): { agent: string; t: number }[] =>
  [...agents].sort(strCmp).map((agent) => ({ agent, t: decNum(dec(t0)) }));

/** Timed inflow: per arm, agent k at t0 + k·interval_s (exact decimals; interval 0.5 s = 2 agents/s). */
export const timedInflow = (arms: string[], count_per_arm: number, interval_s: number, t0: number): { agent: string; arm: string; t: number }[] => {
  if (!Number.isInteger(count_per_arm) || count_per_arm < 0) throw new DestinationRefused('count_per_arm must be a non-negative integer');
  if (!(interval_s > 0)) throw new DestinationRefused('interval_s must be positive');
  const d0 = dec(t0), di = dec(interval_s);
  return [...arms].sort(strCmp).flatMap((arm) => Array.from({ length: count_per_arm }, (_, k) => ({ agent: `${arm}#${k}`, arm, t: decNum(decAdd(d0, decMul(di, k))) })));
};
