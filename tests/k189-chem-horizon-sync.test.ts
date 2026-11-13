/**
 * #189 / #193 ruling 14 — kinematics ↔ CHEM horizon synchronisation contract (engine/physics/chem-horizon-sync.ts;
 * docs/kin-chem-horizon-sync.md). DESIGN + CONTRACT tests; nothing is removed (the synthetic field stays). Blocking.
 *  - reference driver + a real CHEM-1 ChemStore + a toy walker whose positions are absolute-time closed forms from its
 *    decision anchors and whose deposits are stamped with their own event times: the trace satisfies C1–C3 (independent
 *    checker), the store never refuses, chemistry changes decisions (non-vacuous), and readings, decisions, deposits and
 *    commit sequence numbers are BITWISE identical for every partition of the physics horizon (C5, C6);
 *  - counterexamples, each caught by the checker and by the store: sensing before the commit (FUTURE), physics and
 *    commit past an undecided instant then sensing it (STALE), a late deposit (LATE), deposits stamped at the step end
 *    (C4 broken → readings depend on the step), commits at physics cuts (C5 broken → commit sequence depends on the step);
 *  - the same driver runs against the synthetic field (local-sensing SyntheticChemicalField) under the same contract.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { checkSyncTrace, syncSchedule, runSynced, cmpTime, SYNC_CONTRACT_VERSION, type SyncProducer, type SyncChem, type DepositOut, type SyncOp } from '../engine/physics/chem-horizon-sync.ts';
import { ChemStore, ChemRefused } from '../engine/chemistry/core.ts';
import { CLOCK, T as CT, PLANE, dep, synthChannel } from '../prototypes/chem1/scenarios.ts';
import { SyntheticChemicalField, sampleLocal, antennaSensors, type SimTime } from '../engine/physics/local-sensing.ts';
import { gridTime, addTime } from '../engine/physics/exact-time.ts';
import { rng, hash32 } from '../engine/rng.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const json = (x: unknown) => JSON.stringify(x);
const H = 3, DT = 0.1, V_FAST = 7.3, V_SLOW = 3.1, THRESH = 0.5;

// ---------------------------------------------------------------- toy walker (closed form from decision anchors)
interface W { id: string; y: number; x0: number; start: number; ax: number; at: number; v: number; k: number }
function walker(o: { stampAtStepEnd?: boolean } = {}): SyncProducer & { ws: W[]; decisions: string[]; instants: number[] } {
  const ws: W[] = [{ id: 'a0', y: 50, x0: 30.3, start: 0, ax: 30.3, at: 0, v: 0, k: 0 }, { id: 'a1', y: 50, x0: 20.7, start: 0.05, ax: 20.7, at: 0.05, v: 0, k: 0 }, { id: 'a2', y: 50, x0: 10.1, start: 0.13, ax: 10.1, at: 0.13, v: 0, k: 0 }];
  const ownInstants = (w: W) => { const out: number[] = []; for (let k = 0; ; k++) { const t = addTime(w.start, gridTime(k, DT)); if (t >= H) break; out.push(t); } return out; };
  const instants = [...new Set(ws.flatMap(ownInstants))].sort((a, b) => a - b);
  const xAt = (w: W, t: number) => (t <= w.at ? w.ax : w.ax + w.v * (t - w.at));
  const decisions: string[] = [];
  return {
    ws, decisions, instants,
    advance(t0, t1) {
      const out: DepositOut[] = [];
      for (const w of ws) {
        if (w.v === 0) continue;
        const xa = xAt(w, t0), xb = xAt(w, t1);
        for (let m = Math.floor(xa) + 1; m <= xb; m++) {
          const te = o.stampAtStepEnd ? t1 : w.at + (m - w.ax) / w.v;
          out.push({ deposit_id: `${w.id}:${m}`, event_time: { t_s: te, round: 0 }, payload: { x: m, y: w.y, agent: w.id } });
        }
      }
      return out;
    },
    dueAt(t) { return ws.filter((w) => ownInstants(w).includes(t)).map((w) => w.id); },
    decide(agent, t, reading) {
      const w = ws.find((x) => x.id === agent)!;
      w.ax = xAt(w, t); w.at = t; w.v = (reading as number) > THRESH ? V_SLOW : V_FAST; w.k++;
      decisions.push(`${agent}@${t}:${w.v === V_SLOW ? 'slow' : 'fast'}`);
    },
  };
}
const headOf = (p: ReturnType<typeof walker>, id: string, t: number) => { const w = p.ws.find((x) => x.id === id)!; return (t <= w.at ? w.ax : w.ax + w.v * (t - w.at)) + 1.25 + 2; };
/** CHEM-1 store adapter: point deposits; a disc of 3 mm, 2 mm ahead of the head */
function chem(p: ReturnType<typeof walker>, o: { commitsAlsoAt?: number[] } = {}): SyncChem & { store: ChemStore; seqs: number[]; refusals: string[] } {
  const store = new ChemStore({ clock: CLOCK, channels: [{ spec: synthChannel('trail', 'sparse_2d', { lambda_per_s: 0.5 }), domain: PLANE() }] });
  const seqs: number[] = [], refusals: string[] = [];
  return {
    store, seqs, refusals,
    submit(d) { const r = store.deposit(d.map((x) => { const q = x.payload as { x: number; y: number; agent: string }; return dep(x.deposit_id, 'trail', q.agent, CT(x.event_time.t_s), { kind: 'point2d', x_mm: q.x, y_mm: q.y }); })); for (const x of r) if (!x.accepted) refusals.push(`${x.deposit_id}:${x.reason}`); },
    commit(at) { store.advance(CT(at.t_s, at.round)); },
    sense(agent, at) {
      const w = p.ws.find((x) => x.id === agent)!;
      const r = store.sampleLocal({ signal_id: 'trail', agent_id: agent, layer: 'surface', time: CT(at.t_s, at.round), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: headOf(p, agent, at.t_s), y_mm: w.y, radius_mm: 3 } });
      seqs.push(r.state_commit.seq);
      return { reading: r.exposure, commit_at: { t_s: r.state_commit.time.t_s, round: r.state_commit.time.round } };
    },
  };
}
const dueOf = (p: ReturnType<typeof walker>) => p.instants.flatMap((t) => p.dueAt(t).map((agent) => ({ agent, at: { t_s: t, round: 0 } })));
function coupled(cuts: number[], o: { stampAtStepEnd?: boolean } = {}) {
  const p = walker(o), c = chem(p);
  const run = runSynced(p, c, p.instants, H, cuts);
  return { p, c, run, out: json({ readings: run.readings, /* the deposit SET (submission order follows the physics step; the store integrates canonically) */ deposits: run.deposits.map((d) => [d.deposit_id, d.event_time]).sort((x, y) => (x[0] < y[0] ? -1 : 1)), decisions: p.decisions, seqs: c.seqs, final: p.ws.map((w) => [w.ax, w.at, w.v]) }) };
}

// ---------------------------------------------------------------- the contract holds; results invariant to the step
const g = rng(hash32('k189-sync-cuts'));
const partitions: [string, number[]][] = [['no extra cut', []], ['every 0.037 s', Array.from({ length: 81 }, (_, i) => (i + 1) * 0.037)], ['every 0.01 s', Array.from({ length: 299 }, (_, i) => (i + 1) / 100)], ['random 40', Array.from({ length: 40 }, () => g() * H)]];
const ref = coupled([]);
ok(SYNC_CONTRACT_VERSION === 'antempire.kin-chem-sync.v1', 'contract version');
ok(checkSyncTrace(ref.run.trace, dueOf(ref.p)).length === 0 && ref.c.refusals.length === 0, `reference run: C1–C3 hold (${json(checkSyncTrace(ref.run.trace, dueOf(ref.p)).slice(0, 2))}); the store refuses nothing`);
ok(ref.p.decisions.some((d) => d.endsWith('slow')) && ref.p.decisions.some((d) => d.endsWith('fast')) && ref.run.deposits.length > 20, `non-vacuous: chemistry changes decisions (${ref.p.decisions.filter((d) => d.endsWith('slow')).length} slow of ${ref.p.decisions.length}), ${ref.run.deposits.length} deposits`);
for (const [name, cuts] of partitions) {
  const r = coupled(cuts);
  ok(checkSyncTrace(r.run.trace, dueOf(r.p)).length === 0 && r.c.refusals.length === 0, `${name}: contract holds`);
  ok(r.out === ref.out, `${name}: readings, decisions, deposits, commit seq and final state bitwise identical to the unpartitioned run (C6)`);
  ok(json(syncSchedule(r.p.instants, H, cuts).commits) === json(syncSchedule(r.p.instants, H).commits), `${name}: the commit set does not depend on the physics step (C5)`);
}
ok(ref.run.deposits.every((d) => ref.run.trace.findIndex((x) => x.op === 'deposit_submit' && x.deposit_id === d.deposit_id) > ref.run.trace.findIndex((x) => x.op === 'physics_advance' && cmpTime(x.to, d.event_time) >= 0)), 'every deposit is submitted after the physics reached its event time (C2)');

// ---------------------------------------------------------------- counterexamples
const refusedBy = (f: () => unknown, code: string) => { try { f(); return false; } catch (e) { return (e instanceof ChemRefused && e.codes.some((c) => c.includes(code))); } };
{
  // (a) sensing at s before the store committed s
  const p = walker(), c = chem(p);
  c.commit({ t_s: 0, round: 0 }); p.decide('a0', 0, c.sense('a0', { t_s: 0, round: 0 }).reading); c.submit(p.advance(0, 0.1));
  ok(refusedBy(() => c.sense('a0', { t_s: 0.1, round: 0 }), 'FUTURE_SAMPLE'), '(a) store: sensing 0.1 before committing 0.1 → FUTURE_SAMPLE');
  const tr: SyncOp[] = [{ op: 'physics_advance', to: { t_s: 0, round: 0 } }, { op: 'chem_commit', at: { t_s: 0, round: 0 } }, { op: 'physics_advance', to: { t_s: 0.1, round: 0 } }, { op: 'sense', agent: 'a0', at: { t_s: 0.1, round: 0 }, commit_at: { t_s: 0, round: 0 } }];
  ok(checkSyncTrace(tr, []).some((v) => v.code === 'SENSE_UNCOMMITTED'), '(a) checker: SENSE_UNCOMMITTED');
}
{
  // (b) physics and commit run past the decision instant 0.1, then the agent senses 0.1
  const p = walker(), c = chem(p);
  c.commit({ t_s: 0, round: 0 }); p.decide('a0', 0, c.sense('a0', { t_s: 0, round: 0 }).reading);
  c.submit(p.advance(0, 0.12)); c.commit({ t_s: 0.12, round: 0 });
  ok(refusedBy(() => c.sense('a0', { t_s: 0.1, round: 0 }), 'STALE_SAMPLE'), '(b) store: sensing 0.1 after a later commit → STALE_SAMPLE');
  const tr: SyncOp[] = [{ op: 'physics_advance', to: { t_s: 0, round: 0 } }, { op: 'chem_commit', at: { t_s: 0, round: 0 } }, { op: 'sense', agent: 'a0', at: { t_s: 0, round: 0 }, commit_at: { t_s: 0, round: 0 } }, { op: 'decide', agent: 'a0', at: { t_s: 0, round: 0 }, reading_at: { t_s: 0, round: 0 } }, { op: 'physics_advance', to: { t_s: 0.12, round: 0 } }, { op: 'chem_commit', at: { t_s: 0.12, round: 0 } }, { op: 'sense', agent: 'a0', at: { t_s: 0.1, round: 0 }, commit_at: { t_s: 0.12, round: 0 } }];
  const v = checkSyncTrace(tr, [{ agent: 'a0', at: { t_s: 0, round: 0 } }, { agent: 'a0', at: { t_s: 0.1, round: 0 } }]).map((x) => x.code);
  ok(v.includes('PHYSICS_PAST_UNDECIDED') && v.includes('SENSE_STALE'), `(b) checker: PHYSICS_PAST_UNDECIDED and SENSE_STALE (${v.join(',')})`);
}
{
  // (c) a deposit whose event time is at or before the committed horizon
  const p = walker(), c = chem(p);
  c.commit({ t_s: 0.5, round: 0 });
  c.submit([{ deposit_id: 'late', event_time: { t_s: 0.4, round: 0 }, payload: { x: 40, y: 50, agent: 'a0' } }]);
  ok(c.refusals.join() === 'late:LATE_DEPOSIT', '(c) store: LATE_DEPOSIT (not added)');
  const v = checkSyncTrace([{ op: 'physics_advance', to: { t_s: 0.5, round: 0 } }, { op: 'chem_commit', at: { t_s: 0.5, round: 0 } }, { op: 'deposit_submit', deposit_id: 'late', event_time: { t_s: 0.4, round: 0 } }, { op: 'deposit_submit', deposit_id: 'fut', event_time: { t_s: 0.6, round: 0 } }], []).map((x) => x.code);
  ok(v.join() === 'LATE_DEPOSIT,DEPOSIT_FROM_FUTURE', `(c) checker: LATE_DEPOSIT, and a deposit beyond the executed physics is DEPOSIT_FROM_FUTURE (${v.join(',')})`);
  ok(checkSyncTrace([{ op: 'chem_commit', at: { t_s: 0.2, round: 0 } }], []).some((x) => x.code === 'COMMIT_AHEAD_OF_PHYSICS'), '(c) checker: a commit ahead of the executed physics');
  ok(checkSyncTrace([{ op: 'decide', agent: 'a0', at: { t_s: 0, round: 0 }, reading_at: null }], [{ agent: 'a0', at: { t_s: 0, round: 0 } }]).some((x) => x.code === 'DECIDE_WITHOUT_SENSE'), '(c) checker: a decision without a reading at its instant');
}
{
  // (d) C4 broken: deposits stamped at the step end → the readings depend on the physics step
  const a = coupled([], { stampAtStepEnd: true }), b = coupled(partitions[1][1], { stampAtStepEnd: true });
  ok(a.out !== b.out && checkSyncTrace(a.run.trace, dueOf(a.p)).length === 0, '(d) step-end stamping obeys C1–C3 but makes the results depend on the physics step (C4 is necessary)');
  // (e) C5 broken: committing also at every physics cut → the commit sequence seen by the agents depends on the step
  const p1 = walker(), c1 = chem(p1), p2 = walker(), c2 = chem(p2), cuts = partitions[1][1];
  runSynced(p1, c1, p1.instants, H, []);
  runSynced(p2, c2, [...p2.instants, ...cuts], H, cuts); // a driver that (wrongly) treats physics cuts as commit instants
  ok(json(c1.seqs) !== json(c2.seqs), '(e) extra commits at physics cuts change the commit sequence numbers the agents record (C5 is necessary)');
}

// ---------------------------------------------------------------- the synthetic field obeys the same contract (not removed)
{
  const f = new SyntheticChemicalField({ id: 'syn', channel: 'trail', layer: 'L', field: { synthetic: true, kind: 'gaussian_ridge', polyline: [{ x: 0, y: 50 }, { x: 200, y: 50 }], sigma_mm: 1, peak: 1 }, max_range_mm: 0 });
  const rd = f.realtimeReader(), geometry = { body_length_mm: 2.5, antenna_len_mm: 1, antenna_half_angle_rad: 0.5 };
  const mk = (p: ReturnType<typeof walker>): SyncChem => ({
    submit() { /* static synthetic field: deposits are not integrated (explicitly a control source) */ },
    commit(at) { f.advance(at); },
    sense(agent, at) {
      const w = p.ws.find((x) => x.id === agent)!, pose = { x: headOf(p, agent, at.t_s) - 3.25, y: w.y + 0.4, th: 0 };
      const r = sampleLocal(rd, { agent_id: agent, t_s: at.t_s, round: at.round, pose, geometry, sensors: antennaSensors(pose, geometry), layer: 'L', channel: 'trail', range_mm: 0, source: 'synthetic', tags: [{ name: 'k189.sync', assumption: true, basis: '遊戲假設', note: 'synthetic control field' }] });
      return { reading: r.values[0].value, commit_at: r.state_commit.time as SimTime };
    },
  });
  const p = walker(), run = runSynced(p, mk(p), p.instants, H, partitions[1][1]);
  ok(checkSyncTrace(run.trace, dueOf(p)).length === 0 && run.readings.length === dueOf(p).length, 'synthetic field: same driver, contract holds, one reading per decision');
}
const doc = fs.readFileSync(path.join(REPO_ROOT, 'docs/kin-chem-horizon-sync.md'), 'utf8');
ok(['C1', 'C2', 'C3', 'C4', 'C5', 'C6'].every((c) => doc.includes(`**${c}`)) && /合成場.*保留/.test(doc), 'the design document states C1–C6 and keeps the synthetic field');
console.log(JSON.stringify({ k189_chem_horizon_sync: 'pass', checks, decisions: ref.p.decisions.length, deposits: ref.run.deposits.length }, null, 2));
