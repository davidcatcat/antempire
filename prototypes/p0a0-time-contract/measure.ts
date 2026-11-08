/**
 * P0-A0 time contract — numeric comparison of candidate world-time contracts on REAL PH-2 event sequences and on
 * synthetic near-coincident pairs (docs/p0a0-time-contract.md). Experimental, not official: no save, no journal, no
 * game day. The physics scenes are the synthetic scenes of tests/ph2-collision.test.ts (same candidate files); their
 * encounter rules are candidate rules, not validated ant behaviour. Only event TIMES are used here.
 *
 *   node prototypes/p0a0-time-contract/measure.ts      -> prints the tables of the doc (+ a timing table)
 *
 * The deterministic tables are rebuilt by tests/p0a0-time-contract.test.ts and must equal the doc verbatim.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PhysicsGeometry } from '../../engine/physics/geometry.ts';
import { simulate, type EncounterRules, type PhysEvent, type PhysObject, type SimAgentSpec, type SimConfig } from '../../engine/physics/collision.ts';
import { rng } from '../../engine/rng.ts';
import { type ExactTime, type NativeTime, type WorldTime, WorldScheduler, exactOf, US_PER_DAY } from '../../engine/scheduler/world-events.ts';
import { type TimedItem, type TimeContract, CANDIDATE_CONTRACTS, evaluateContract, tickContract } from '../../engine/scheduler/time-contract.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const geo = (n: string): PhysicsGeometry => read(`scenarios/physics/${n}.geometry.json`);
const bodyC = read('scenarios/physics/pheidole-megacephala.body-candidates.json');
const inter = read('scenarios/physics/pheidole-megacephala.interaction-candidates.json');
const motion = read('scenarios/physics/pheidole-megacephala.motion-candidates.json');
const L = bodyC.castes.minor.body_length_mm.value as number;
const wHi = (bodyC.castes.minor.effective_collision_width_mm.candidate_range as number[])[1];
const reach = (inter.contact_reach_mm.candidate_range as number[])[0] + 0.5;
const vOut = motion.trail_speed_mm_s.outbound.value as number, vRet = motion.trail_speed_mm_s.returning.value as number;
/** the pooled trail speed (R133, 文獻支持): used only to express a time gap as a distance */
export const V_POOLED_MM_S = motion.trail_speed_mm_s.pooled.value as number;
const E = inter.encounter;
const ENC: EncounterRules = { priority: E.priority.value, entry_yield_probability: E.entry_yield_probability.value, laden_yield_probability: E.laden_yield_probability.value, contact_pause_s: E.contact_pause_s.value, inside_turn_back_probability: E.inside_turn_back_probability.candidate_values[1] };
const ant = (id: string, passage: string, s: number, d: 1 | -1, goal: number, v: number, extra: Partial<SimAgentSpec> = {}): SimAgentSpec => ({ id, passage, s_mm: s, dir: d, start_t_s: 0, free_speed_mm_s: v, goal_s_mm: goal, body: { length_mm: L, width_mm: wHi, contact_reach_mm: reach }, load: null, ...extra });
const cfg = (g: PhysicsGeometry, agents: SimAgentSpec[], extra: Partial<SimConfig> = {}): SimConfig => ({ encounter: ENC, geometry: g, agents, horizon_s: 60, seed: 1, ...extra });

/** the PH-2 scenes (as in tests/ph2-collision.test.ts §1, 6, 8, 9, 9b, 9c); a group holds independent runs */
export function ph2Configs(): { group: string; runs: { name: string; cfg: SimConfig }[] }[] {
  const cor = geo('narrow-corridor'), cr = geo('crossing'), ne = geo('nest-entrance');
  const tau = E.contact_pause_s.candidate_values[1] as number;
  const traffic = (seed: number): SimConfig => {
    const g = rng(seed), agents: SimAgentSpec[] = [];
    for (let k = 0; k < 8; k++) { const d = (k % 2 ? -1 : 1) as 1 | -1; agents.push(ant(`A${k}`, 'P-corridor', d > 0 ? 2 + Math.floor(k / 2) * 3 : 98 - Math.floor(k / 2) * 3, d, d > 0 ? 98 : 2, 15 + g() * 4, { start_t_s: g() * 8 })); }
    return { encounter: ENC, geometry: cor, agents, horizon_s: 120, seed };
  };
  const dense = (seed: number): SimConfig => {
    const r = rng(seed * 7717), na = 3 + Math.floor(r() * 8), agents: SimAgentSpec[] = [], objects: PhysObject[] = [], used: number[] = [];
    for (let k = 0; k < na; k++) {
      const d = (r() < 0.5 ? 1 : -1) as 1 | -1;
      let s = 0; for (let tries = 0; tries < 50; tries++) { s = 2 + r() * 96; if (used.every((u) => Math.abs(u - s) > 2.6)) break; }
      if (!used.every((u) => Math.abs(u - s) > 2.6)) continue; used.push(s);
      let load: string | null = null; if (r() < 0.3) { load = `o${k}`; objects.push({ id: load, width_mm: 0.5 + r() * 0.3, holder: `a${k}` }); }
      agents.push(ant(`a${k}`, 'P-corridor', s, d, d > 0 ? Math.max(s, 99) : Math.min(s, 1), 10 + r() * 10, { start_t_s: r() * 3, load, body: { length_mm: 2.5, width_mm: 0.55 + r() * 0.25, contact_reach_mm: r() } }));
    }
    return { encounter: { priority: seed % 2 ? 'entry_yield' : 'laden_priority', entry_yield_probability: [0.957, 0.5, 0.05][seed % 3], laden_yield_probability: 0.98, contact_pause_s: [null, 0.18, 0.43, 0.8][seed % 4], inside_turn_back_probability: [0.1, 0.5, 0.9, null][seed % 4 === 3 ? 3 : seed % 3] }, geometry: cor, agents, objects, horizon_s: 120, seed, window_s: [0.05, 1, 7][seed % 3] };
  };
  return [
    { group: 'head-on (corridor)', runs: [{ name: 'head-on', cfg: cfg(cor, [ant('W1', 'P-corridor', 2, 1, 98, vOut), ant('W2', 'P-corridor', 98, -1, 2, vRet)], { encounter: { ...ENC, contact_pause_s: tau } }) }] },
    { group: 'crossing', runs: [{ name: 'crossing', cfg: cfg(cr, [ant('E', 'P-east-west', 0, 1, 500, 10), ant('N', 'P-north-south', 0, 1, 500, 10)]) }] },
    { group: 'three in single file', runs: [{ name: 'three', cfg: cfg(cor, [ant('A', 'P-corridor', 30, 1, 98, vOut), ant('B', 'P-corridor', 70, -1, 2, vRet), ant('C', 'P-corridor', 73, -1, 2, vRet)]) }] },
    { group: 'entrance, 3 mm load', runs: [{ name: 'entrance', cfg: cfg(ne, [ant('W1', 'P-entry', 2, 1, 100, vRet, { load: 'prey-1' })], { objects: [{ id: 'prey-1', width_mm: 3.0, holder: 'W1' }] }) }] },
    { group: 'traffic 8 ants × 12 seeds', runs: Array.from({ length: 12 }, (_, i) => ({ name: `traffic-${i + 1}`, cfg: traffic(i + 1) })) },
    { group: 'dense corridor × 25 seeds', runs: Array.from({ length: 25 }, (_, i) => ({ name: `dense-${i + 1}`, cfg: dense(i + 1) })).filter((r) => { try { simulate(r.cfg); return true; } catch (e) { if (/same space|narrower than its width/.test(String(e))) return false; throw e; } }) },
  ];
}

/** a stable id from content: kind, agent, other and the occurrence number of that triple (never an array position) */
export function physIds(events: readonly PhysEvent[]): string[] {
  const n = new Map<string, number>();
  return events.map((e) => { const k = `${e.kind}.${e.agent}.${e.other ?? '-'}`; const c = (n.get(k) ?? 0) + 1; n.set(k, c); return `${k}.${c}`; });
}
export const ANCHOR: WorldTime = { day: 0, minute: 600 };   // 10:00 on day 0 (on the tick grid); the choice is arbitrary
export const nativeOfPhys = (clock: string, anchor: WorldTime, t_s: number): NativeTime => ({ clock, unit: 's', anchor, t: t_s });
/** exact + phase (µs), double-double: shifts a run against the tick grid (phase is not representable as an anchor) */
const twoSum = (a: number, b: number): [number, number] => { const s = a + b, bb = s - a; return [s, (a - (s - bb)) + (b - bb)]; };
export function shiftUs(x: ExactTime, us: number): ExactTime {
  let [hi, lo] = twoSum(x.us, us); [hi, lo] = twoSum(hi, lo + x.us_lo);
  let day = x.day; if (hi >= US_PER_DAY) { [hi, lo] = twoSum(hi - US_PER_DAY, lo); day++; }
  return { day, us: hi + 0, us_lo: lo + 0 };
}
export function itemsOf(clock: string, events: readonly PhysEvent[], anchor = ANCHOR, phase_us = 0): TimedItem[] {
  const ids = physIds(events);
  return events.map((e, i) => ({ id: ids[i], exact: shiftUs(exactOf(nativeOfPhys(clock, anchor, e.t_s)), phase_us), entities: e.other ? [e.agent, e.other] : [e.agent] }));
}

const fmtG = (x: number) => (x === 0 ? '0' : x.toExponential(1).replace('e', '×10^').replace('+', ''));
export interface GroupRow { group: string; runs: number; events: number; distinct: number; min_gap_s: number | null; byContract: Record<string, { pairs: number; shared: number; flips: number; batches: number }> }
export function ph2Rows(phase_us = 0, contracts: readonly TimeContract[] = CANDIDATE_CONTRACTS): GroupRow[] {
  return ph2Configs().map(({ group, runs }) => {
    const row: GroupRow = { group, runs: runs.length, events: 0, distinct: 0, min_gap_s: null, byContract: {} };
    for (const c of contracts) row.byContract[c.name] = { pairs: 0, shared: 0, flips: 0, batches: 0 };
    for (const r of runs) {
      const ev = simulate(r.cfg).events, items = itemsOf(`ph2.${r.name}`, ev, ANCHOR, phase_us);
      const ts = [...new Set(ev.map((e) => e.t_s))].sort((a, b) => a - b);
      for (let i = 1; i < ts.length; i++) { const g = ts[i] - ts[i - 1]; if (row.min_gap_s === null || g < row.min_gap_s) row.min_gap_s = g; }
      row.events += ev.length; row.distinct += ts.length;
      for (const c of contracts) { const m = evaluateContract(items, c), b = row.byContract[c.name]; b.pairs += m.merged_pairs; b.shared += m.merged_pairs_shared_entity; b.flips += m.id_order_flips; b.batches += m.batches; }
    }
    return row;
  });
}
export function ph2Table(rows = ph2Rows()): string {
  const names = CANDIDATE_CONTRACTS.map((c) => c.name);
  const head = `| 情境 | 次數 | 事件 | 不同時刻 | 最小間隔 (s) | ${names.map((n) => `${n}：合併對／同個體／id 反序`).join(' | ')} |`;
  const sep = `|${'---|'.repeat(5 + names.length)}`;
  const body = rows.map((r) => `| ${r.group} | ${r.runs} | ${r.events} | ${r.distinct} | ${r.min_gap_s === null ? '—' : fmtG(r.min_gap_s)} | ${names.map((n) => { const b = r.byContract[n]; return `${b.pairs}／${b.shared}／${b.flips}`; }).join(' | ')} |`);
  const tot = (n: string, k: 'pairs' | 'shared' | 'flips') => rows.reduce((s, r) => s + r.byContract[n][k], 0);
  body.push(`| **合計** | ${rows.reduce((s, r) => s + r.runs, 0)} | ${rows.reduce((s, r) => s + r.events, 0)} | ${rows.reduce((s, r) => s + r.distinct, 0)} | ${fmtG(Math.min(...rows.filter((r) => r.min_gap_s !== null).map((r) => r.min_gap_s!)))} | ${names.map((n) => `**${tot(n, 'pairs')}／${tot(n, 'shared')}／${tot(n, 'flips')}**`).join(' | ')} |`);
  return [head, sep, ...body].join('\n');
}

/** sensitivity: merged pairs on all PH-2 runs for tick sizes from 1 ms to 0.1 ns, at 8 phases of the run against the grid */
export const SWEEP: readonly TimeContract[] = [tickContract('1 ms', 1, 1000), tickContract('60 µs', 1, 60), tickContract('10 µs', 1, 10), tickContract('1 µs', 1, 1), tickContract('100 ns', 10, 1), tickContract('10 ns', 100, 1), tickContract('1 ns', 1000, 1), tickContract('0.1 ns', 10000, 1), { name: 'layered', kind: 'layered', ticks_per_us: null }];
export function sweepTable(): string {
  const phases = Array.from({ length: 8 }, (_, k) => k * 7.5);   // 0 … 52.5 µs: the run's zero against the 60 µs grid
  const per = phases.map((p) => ph2Rows(p, SWEEP));
  const sum = (rows: GroupRow[], n: string, k: 'pairs' | 'shared') => rows.reduce((s, r) => s + r.byContract[n][k], 0);
  const lines = ['| 時間格 | 合併對（8 個相位：最少–最多） | 其中同個體 | 相位 0 的批次數 |', '|---|---|---|---|'];
  for (const c of SWEEP) {
    const pr = per.map((rows) => sum(rows, c.name, 'pairs')), sh = per.map((rows) => sum(rows, c.name, 'shared'));
    lines.push(`| ${c.name} | ${Math.min(...pr)}–${Math.max(...pr)} | ${Math.min(...sh)}–${Math.max(...sh)} | ${per[0].reduce((s, r) => s + r.byContract[c.name].batches, 0)} |`);
  }
  return lines.join('\n');
}

/** synthetic near-coincident pairs: N pairs at random bases in [0, 1000) s, second event δ later (native seconds) */
export const GAPS_S: readonly number[] = [1e-4, 6e-5, 3e-5, 1e-5, 1e-6, 1e-7, 1e-9, 1e-12];
export function syntheticPairs(gap_s: number, n = 1000, seed = 20261107): { items: TimedItem[]; unrepresentable: number } {
  const g = rng(seed), items: TimedItem[] = []; let unrepresentable = 0;
  for (let i = 0; i < n; i++) {
    const b = g() * 1000, b2 = b + gap_s;
    if (b2 === b) { unrepresentable++; continue; }
    // which of the two gets the smaller id is drawn (ids carry no time information)
    const id = `p${String(i).padStart(4, '0')}`, [first, second] = g() < 0.5 ? ['x', 'y'] : ['y', 'x'];
    items.push({ id: `${id}.${first}`, exact: exactOf(nativeOfPhys('syn', { day: 0, minute: 0 }, b)), entities: [id] }, { id: `${id}.${second}`, exact: exactOf(nativeOfPhys('syn', { day: 0, minute: 0 }, b2)), entities: [id] });
  }
  return { items, unrepresentable };
}
export function syntheticTable(): string {
  const names = CANDIDATE_CONTRACTS.map((c) => c.name);
  const lines = [`| 間隔 δ | 以 ${V_POOLED_MM_S} mm/s 換算距離 (mm) | 可表示的對數 | ${names.map((n) => `${n}：合併／id 反序`).join(' | ')} |`, `|${'---|'.repeat(3 + names.length)}`];
  for (const gap of GAPS_S) {
    const { items, unrepresentable } = syntheticPairs(gap);
    const cells = names.map((n) => { const m = evaluateContract(items, CANDIDATE_CONTRACTS.find((c) => c.name === n)!); return `${m.merged_pairs}／${m.id_order_flips}`; });
    lines.push(`| ${fmtG(gap)} s | ${fmtG(gap * V_POOLED_MM_S)} | ${1000 - unrepresentable} | ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

/**
 * Cost (machine-dependent, NOT asserted against the doc): (a) the ordering kernel of each contract on the PH-2 items,
 * (b) the full WorldScheduler, schedule + run of n events, 'tick' vs 'layered'.
 */
export function timingTable(n = 20000, reps = 5): string {
  const items = ph2Configs().flatMap(({ runs }) => runs.flatMap((r) => itemsOf(`ph2.${r.name}`, simulate(r.cfg).events)));
  const lines = ['| 項目 | 契約 | 每事件時間 (µs，中位數) |', '|---|---|---|'];
  const med = (xs: number[]) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  for (const c of CANDIDATE_CONTRACTS) {
    const ts: number[] = []; for (let k = 0; k < reps; k++) { const t0 = performance.now(); evaluateContract(items, c); ts.push(((performance.now() - t0) * 1000) / items.length); }
    lines.push(`| 排序核心（PH-2 ${items.length} 事件，含合併統計） | ${c.name} | ${med(ts).toFixed(2)} |`);
  }
  const g = rng(99), times = Array.from({ length: n }, () => g() * 86000);
  for (const order of ['tick', 'layered'] as const) {
    const ts: number[] = [];
    for (let k = 0; k < reps; k++) {
      const t0 = performance.now(), s = new WorldScheduler('W', { day: 0, minute: 0 }, { order });
      times.forEach((t, i) => s.schedule({ kind: 'syn', key: `e${i}`, native: nativeOfPhys('syn', { day: 0, minute: 0 }, t), scope: { world: 'W', colony: null, individual: null }, source: null, target: null }));
      s.runUntil({ day: 1, minute: 0 }, () => {}); ts.push(((performance.now() - t0) * 1000) / n);
    }
    lines.push(`| 完整排程器（${n} 事件：排入＋執行） | ${order} | ${med(ts).toFixed(2)} |`);
  }
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log('## PH-2\n' + ph2Table() + '\n\n## sweep\n' + sweepTable() + '\n\n## synthetic\n' + syntheticTable() + '\n\n## timing (this machine)\n' + timingTable());
}
