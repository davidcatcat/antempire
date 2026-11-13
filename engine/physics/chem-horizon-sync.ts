/**
 * KIN ↔ CHEM HORIZON SYNCHRONISATION CONTRACT (Issue #189 / #193 ruling 14; docs/kin-chem-horizon-sync.md). DESIGN +
 * CONTRACT ONLY: types, a schedule rule, a reference driver and an independent trace checker. ISOLATED: not imported by
 * the official pipeline (tests/physics-isolation.test.ts). It changes no solver and removes nothing: the synthetic
 * field (local-sensing.ts SyntheticChemicalField) stays; CHEM (engine/chemistry/core.ts) is not modified.
 *
 * The contract (C1–C6), for any walking producer (KIN-2D, LANE-FLOW, model C) coupled to a chemical store:
 *  C1 committed slices only — an individual senses at s only when the store's LATEST commit is exactly s (CHEM-1b
 *     sampleLocal / local-sensing sampleLocal: FUTURE_SAMPLE before, STALE_SAMPLE after). No read between commits.
 *  C2 commit after physics — the store commits s only after the motion up to s has been executed, and every deposit
 *     with event time ≤ s produced by that motion has been submitted (deposit-before-sense, CHEM_PHASES 1 → 2–3).
 *  C3 causal order inside an instant s — physics(≤ s) and deposits(≤ s) → commit(s) → sense(s) → decide(s) → physics
 *     beyond s. The physics never runs past a decision instant whose decisions have not been taken (a decision can only
 *     affect motion after it); a deposit caused by motion after s carries its own event time > s.
 *  C4 event-time stamping — a deposit is stamped with the instant its source event happened (closed-form crossing
 *     time), never with the end of the physics step that produced it.
 *  C5 commit set independent of the physics step — commits happen exactly at the sensing / decision instants and at the
 *     horizon (syncSchedule). Extra physics cuts (step size, chunking) add no commit.
 *  C6 step-size consistency — with C4 + C5 and a producer whose positions are absolute-time closed forms from its
 *     decision anchors, every reading, decision, deposit and commit sequence number is bitwise identical for every
 *     partition of the physics horizon (tested). A producer that restarts its closed forms at each cut (LANE-FLOW today,
 *     docs/physics-follower-ab.md §4) does NOT satisfy C6 yet; that needs ruling 8 (absolute-time positions, a rules /
 *     candidate update), not a change here.
 * Times are SimTime { t_s, round } (= CHEM ChemTime without clock / unit); order is lexicographic (t_s, round).
 * Pure and deterministic; no platform APIs.
 */
import type { SimTime } from './local-sensing.ts';

export const SYNC_CONTRACT_VERSION = 'antempire.kin-chem-sync.v1';
export const cmpTime = (a: SimTime, b: SimTime): number => a.t_s - b.t_s || a.round - b.round;

export type SyncOp =
  | { op: 'physics_advance'; to: SimTime }
  | { op: 'deposit_submit'; deposit_id: string; event_time: SimTime }
  | { op: 'chem_commit'; at: SimTime }
  | { op: 'sense'; agent: string; at: SimTime; commit_at: SimTime }
  | { op: 'decide'; agent: string; at: SimTime; reading_at: SimTime | null };
export type SyncViolationCode =
  | 'TIME_BACKWARDS' | 'COMMIT_AHEAD_OF_PHYSICS' | 'DEPOSIT_FROM_FUTURE' | 'LATE_DEPOSIT' | 'DUPLICATE_DEPOSIT'
  | 'SENSE_UNCOMMITTED' | 'SENSE_STALE' | 'SENSE_COMMIT_MISMATCH' | 'DECIDE_WITHOUT_SENSE' | 'DECIDE_ON_OTHER_INSTANT'
  | 'PHYSICS_PAST_UNDECIDED' | 'UNDECLARED_DECISION';
export interface SyncViolation { code: SyncViolationCode; index: number; detail: string }

const k = (t: SimTime) => `${t.t_s}|${t.round}`;
/**
 * Independent checker of a trace against C1–C3 (C4–C6 are properties of runs, tested by comparing runs).
 * `due` = the declared decision instants (agent, time): the physics must not pass one before that decision is taken.
 */
export function checkSyncTrace(ops: readonly SyncOp[], due: readonly { agent: string; at: SimTime }[]): SyncViolation[] {
  const v: SyncViolation[] = [];
  let phys: SimTime | null = null, commit: SimTime | null = null;
  const seen = new Set<string>(), sensed = new Set<string>(), decided = new Set<string>();
  const dueSet = new Set(due.map((d) => `${d.agent}@${k(d.at)}`));
  const pending = [...due].sort((a, b) => cmpTime(a.at, b.at));
  ops.forEach((o, i) => {
    const bad = (code: SyncViolationCode, detail: string) => v.push({ code, index: i, detail });
    switch (o.op) {
      case 'physics_advance': {
        if (phys && cmpTime(o.to, phys) < 0) bad('TIME_BACKWARDS', `physics ${k(o.to)} after ${k(phys)}`);
        for (const d of pending) if (cmpTime(d.at, o.to) < 0 && !decided.has(`${d.agent}@${k(d.at)}`)) { bad('PHYSICS_PAST_UNDECIDED', `physics to ${k(o.to)} before ${d.agent} decided at ${k(d.at)}`); break; }
        phys = o.to; break;
      }
      case 'deposit_submit':
        if (seen.has(o.deposit_id)) bad('DUPLICATE_DEPOSIT', o.deposit_id); seen.add(o.deposit_id);
        if (!phys || cmpTime(o.event_time, phys) > 0) bad('DEPOSIT_FROM_FUTURE', `${o.deposit_id} at ${k(o.event_time)} beyond physics ${phys ? k(phys) : 'none'}`);
        if (commit && cmpTime(o.event_time, commit) <= 0) bad('LATE_DEPOSIT', `${o.deposit_id} at ${k(o.event_time)} ≤ commit ${k(commit)}`);
        break;
      case 'chem_commit':
        if (commit && cmpTime(o.at, commit) < 0) bad('TIME_BACKWARDS', `commit ${k(o.at)} after ${k(commit)}`);
        if (!phys || cmpTime(o.at, phys) > 0) bad('COMMIT_AHEAD_OF_PHYSICS', `commit ${k(o.at)} with physics at ${phys ? k(phys) : 'none'}`);
        commit = o.at; break;
      case 'sense':
        if (!commit || cmpTime(o.at, commit) > 0) bad('SENSE_UNCOMMITTED', `${o.agent} senses ${k(o.at)}, latest commit ${commit ? k(commit) : 'none'}`);
        else if (cmpTime(o.at, commit) < 0) bad('SENSE_STALE', `${o.agent} senses ${k(o.at)} after commit ${k(commit)}`);
        if (commit && cmpTime(o.commit_at, commit) !== 0) bad('SENSE_COMMIT_MISMATCH', `${o.agent} reports commit ${k(o.commit_at)}, latest ${k(commit)}`);
        sensed.add(`${o.agent}@${k(o.at)}`); break;
      case 'decide':
        if (!dueSet.has(`${o.agent}@${k(o.at)}`)) bad('UNDECLARED_DECISION', `${o.agent} at ${k(o.at)}`);
        if (o.reading_at === null || !sensed.has(`${o.agent}@${k(o.reading_at)}`)) bad('DECIDE_WITHOUT_SENSE', `${o.agent} at ${k(o.at)}`);
        else if (cmpTime(o.reading_at, o.at) !== 0) bad('DECIDE_ON_OTHER_INSTANT', `${o.agent} decides at ${k(o.at)} on a reading at ${k(o.reading_at)}`);
        decided.add(`${o.agent}@${k(o.at)}`); break;
    }
  });
  return v;
}

/** C5: commits at the decision instants and the horizon; physics epochs cut there plus at any extra physics cuts */
export function syncSchedule(decisionInstants: readonly number[], horizon_s: number, physicsCuts: readonly number[] = []): { commits: number[]; epochs: [number, number][] } {
  if (!(horizon_s >= 0) || !Number.isFinite(horizon_s)) throw new Error('SYNC: bad horizon');
  const commits = [...new Set([...decisionInstants.filter((t) => t >= 0 && t <= horizon_s), horizon_s])].sort((a, b) => a - b);
  const cuts = [...new Set([0, ...commits, ...physicsCuts.filter((t) => t > 0 && t < horizon_s)])].sort((a, b) => a - b);
  const epochs: [number, number][] = [];
  for (let i = 1; i < cuts.length; i++) epochs.push([cuts[i - 1], cuts[i]]);
  return { commits, epochs };
}

// ---------------------------------------------------------------- reference driver (the order C1–C5 prescribe)
export interface DepositOut { deposit_id: string; event_time: SimTime; payload: unknown }
/** a walking producer: executes motion on (t0, t1] with the decisions in effect, returning the deposits whose source
 *  events happened in (t0, t1] stamped with their own event times (C4); declares and takes decisions */
export interface SyncProducer {
  advance(t0: number, t1: number): DepositOut[];
  dueAt(t: number): string[];
  decide(agent: string, t: number, reading: unknown): void;
}
/** the chemical side: submit (phase 1), commit (phases 2–3), sense (phase 4) — e.g. a CHEM-1 ChemStore adapter */
export interface SyncChem {
  submit(d: DepositOut[]): void;
  commit(at: SimTime): void;
  sense(agent: string, at: SimTime): { reading: unknown; commit_at: SimTime };
}
export interface DriverRun { trace: SyncOp[]; readings: { agent: string; at: SimTime; reading: unknown }[]; deposits: DepositOut[] }
/** Runs a producer and a chemical store in the contract order: per epoch (t0, t1]: physics → deposits; at a commit
 *  instant: commit → sense (every due agent) → decide. Round 0 throughout. */
export function runSynced(p: SyncProducer, c: SyncChem, decisionInstants: readonly number[], horizon_s: number, physicsCuts: readonly number[] = []): DriverRun {
  const { commits, epochs } = syncSchedule(decisionInstants, horizon_s, physicsCuts);
  const trace: SyncOp[] = [], readings: DriverRun['readings'] = [], deposits: DepositOut[] = [];
  const T = (t: number): SimTime => ({ t_s: t, round: 0 });
  const instant = (t: number) => {
    c.commit(T(t)); trace.push({ op: 'chem_commit', at: T(t) });
    if (t >= horizon_s) return; // the horizon: zero duration, no decision
    const due = [...p.dueAt(t)].sort();
    const got = due.map((a) => ({ a, r: c.sense(a, T(t)) }));
    for (const { a, r } of got) { trace.push({ op: 'sense', agent: a, at: T(t), commit_at: r.commit_at }); readings.push({ agent: a, at: T(t), reading: r.reading }); }
    for (const { a, r } of got) { p.decide(a, t, r.reading); trace.push({ op: 'decide', agent: a, at: T(t), reading_at: T(t) }); }
  };
  trace.push({ op: 'physics_advance', to: T(0) });
  if (commits[0] === 0) instant(0);
  for (const [t0, t1] of epochs) {
    const d = p.advance(t0, t1);
    trace.push({ op: 'physics_advance', to: T(t1) });
    for (const x of d) trace.push({ op: 'deposit_submit', deposit_id: x.deposit_id, event_time: x.event_time });
    c.submit(d); deposits.push(...d);
    if (commits.includes(t1)) instant(t1);
  }
  return { trace, readings, deposits };
}
