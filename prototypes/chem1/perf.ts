/**
 * CHEM-1 quick performance table (#132): CPU time of deposit / advance / sampleLocal and heap growth for 14 / 100 /
 * 1000 synthetic agents, on both backends. Synthetic walks (10 mm/s, one deposit and one sample per agent per second,
 * 120 s); machine-dependent timings, printed only (no file written). Not a species experiment.
 *   node --expose-gc prototypes/chem1/perf.ts   (heap measured after a forced GC when --expose-gc is given)
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { ChemStore } from '../../engine/chemistry/core.ts';
import type { DepositEvent, Domain } from '../../engine/chemistry/contract.ts';
import { CLOCK, T, dep, rng, synthChannel } from './scenarios.ts';

export interface PerfRow { backend: string; agents: number; seconds: number; deposits: number; samples: number; cells: number; deposit_ms: number; advance_ms: number; sample_ms: number; us_per_deposit: number; us_per_sample: number; heap_mb: number; gc: boolean }

export function runPerf(backend: 'sparse_2d' | 'surface_edge', agents: number, seconds = 120, seed = 1): PerfRow {
  const g = rng(seed), speed = 10;
  const domain: Domain = backend === 'sparse_2d'
    ? { backend, bounds_mm: { x0: 0, y0: 0, x1: 2000, y1: 2000 }, layers: ['surface'] }
    : { backend, edges: Array.from({ length: 100 }, (_, i) => ({ id: `e${i}`, length_mm: 200, layer: 'surface' })) };
  const s = new ChemStore({ clock: CLOCK, channels: [{ spec: synthChannel('c', backend, { lambda_per_s: 0.001 }), domain }] });
  const st = Array.from({ length: agents }, () => ({ x: g() * 2000, y: g() * 2000, e: Math.floor(g() * 100), s: g() * 200, dir: g() < 0.5 ? 1 : -1 }));
  const gc = (globalThis as { gc?: () => void }).gc, heap = () => { gc?.(); return process.memoryUsage().heapUsed; };
  const heap0 = heap();
  let tDep = 0, tAdv = 0, tSam = 0, nDep = 0, nSam = 0;
  for (let t = 1; t <= seconds; t++) {
    const evs: DepositEvent[] = [];
    st.forEach((a, i) => {
      if (backend === 'sparse_2d') {
        const h = g() * 2 * Math.PI, x1 = Math.min(2000, Math.max(0, a.x + speed * Math.cos(h))), y1 = Math.min(2000, Math.max(0, a.y + speed * Math.sin(h)));
        if (x1 !== a.x || y1 !== a.y) evs.push(dep(`w${i}-${t}`, 'c', `w${i}`, T(t), { kind: 'segment2d', x0_mm: a.x, y0_mm: a.y, x1_mm: x1, y1_mm: y1 }));
        a.x = x1; a.y = y1;
      } else {
        let s1 = a.s + a.dir * speed;
        if (s1 < 0 || s1 > 200) { a.dir = -a.dir as 1 | -1; s1 = a.s + a.dir * speed; }
        evs.push(dep(`w${i}-${t}`, 'c', `w${i}`, T(t), { kind: 'edge_segment', edge_id: `e${a.e}`, s0_mm: a.s, s1_mm: s1 }));
        a.s = s1;
      }
    });
    let c0 = performance.now(); s.deposit(evs); tDep += performance.now() - c0; nDep += evs.length;
    c0 = performance.now(); s.advance(T(t)); tAdv += performance.now() - c0;
    c0 = performance.now();
    st.forEach((a, i) => {
      s.sampleLocal({ signal_id: 'c', agent_id: `w${i}`, layer: 'surface', time: T(t), phase: 'local_sensing', sensor: backend === 'sparse_2d' ? { kind: 'disc', x_mm: a.x, y_mm: a.y, radius_mm: 3 } : { kind: 'edge', edge_id: `e${a.e}`, s_mm: a.s, radius_mm: 3 } });
      nSam++;
    });
    tSam += performance.now() - c0;
  }
  const r2 = (x: number) => Math.round(x * 100) / 100;
  return { backend, agents, seconds, deposits: nDep, samples: nSam, cells: s.ledger('c').cells, deposit_ms: r2(tDep), advance_ms: r2(tAdv), sample_ms: r2(tSam), us_per_deposit: r2((1000 * (tDep + tAdv)) / nDep), us_per_sample: r2((1000 * tSam) / nSam), heap_mb: r2((heap() - heap0) / 1048576), gc: !!gc };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rows = (['surface_edge', 'sparse_2d'] as const).flatMap((b) => [14, 100, 1000].map((n) => runPerf(b, n)));
  console.log('| 後端 | 個體 | 秒 | 沉積 | 取樣 | 格數 | 沉積 ms | advance ms | 取樣 ms | µs／沉積（含 advance） | µs／取樣 | 堆積增量 MB |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.backend} | ${r.agents} | ${r.seconds} | ${r.deposits} | ${r.samples} | ${r.cells} | ${r.deposit_ms} | ${r.advance_ms} | ${r.sample_ms} | ${r.us_per_deposit} | ${r.us_per_sample} | ${r.heap_mb} |`);
}
