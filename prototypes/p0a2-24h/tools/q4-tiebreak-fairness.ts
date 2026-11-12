/**
 * P0-A2 Q4 (Owner #188, ruled in #193 on 2026-11-12) — multi-seed FAIRNESS check of the same-instant tie-break
 * hash32(seed|t|id), a transitional ENGINEERING arbitration (not a claimed natural competition rule). Collects every
 * same-instant, same-round batch of worker events with more than one actor in many seeds and tests whether the
 * first-served position depends on the worker id: binomial test of "lowest id served first" (|z| < 3.291, p = 0.001)
 * and chi-square of the first-served rank per batch size (p = 0.001 critical values). Deterministic; not a blocking
 * test (the light version is tests/p0a2-24h-proto.test.ts §8b). Changes nothing.
 *
 *   node prototypes/p0a2-24h/tools/q4-tiebreak-fairness.ts [--seeds 60] [--days 2]
 * Writes prototypes/p0a2-24h/out/q4-tiebreak-fairness.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World, WORKER_KINDS } from '../world.ts';
import { applyVariant } from '../params.ts';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RAW = JSON.parse(fs.readFileSync(path.join(DIR, 'params.json'), 'utf8'));
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const SEEDS = arg('--seeds', 60), DAYS = arg('--days', 2), DAY = 86_400_000;
const CRIT: Record<number, number> = { 1: 10.828, 2: 13.816, 3: 16.266, 4: 18.467, 5: 20.515 };
const chi2 = (obs: number[]) => { const n = obs.reduce((a, b) => a + b, 0), e = n / obs.length; return obs.reduce((a, o) => a + (o - e) ** 2 / e, 0); };
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

const raws: Record<string, any> = { 'ft-flat': RAW, 'ft-r190': (() => { const r = applyVariant(RAW, 'ft-r190'); r.reference_variant = 'ft-r190'; return r; })() };
const out: Record<string, unknown> = {};
for (const [base, raw] of Object.entries(raws)) {
  const batches: string[][] = [];
  for (let seed = 1; seed <= SEEDS; seed++) {
    const w = World.create(raw, 'taichung-march-ref', seed, { captureLog: true }); w.advanceTo(DAYS * DAY);
    let cur: { t: number; r: number; a: string[] } | null = null;
    const flush = () => { if (cur && new Set(cur.a).size > 1) batches.push(cur.a); };
    for (const l of w.lines!) {
      const e = JSON.parse(l); if (!(WORKER_KINDS as readonly string[]).includes(e.k)) continue;
      if (cur && cur.t === e.t && cur.r === e.r) cur.a.push(e.a); else { flush(); cur = { t: e.t, r: e.r, a: [e.a] }; }
    }
    flush();
  }
  let L = 0, E = 0, V = 0; const byK: Record<number, number[]> = {};
  for (const b of batches) {
    const k = b.length, sorted = [...b].sort(), rank = sorted.indexOf(b[0]);
    (byK[k] ??= new Array(k).fill(0))[rank]++;
    E += 1 / k; V += (1 / k) * (1 - 1 / k); if (rank === 0) L++;
  }
  const z = (L - E) / Math.sqrt(V);
  const perK = Object.fromEntries(Object.entries(byK).map(([k, obs]) => { const n = obs.reduce((a, b) => a + b, 0), ok = n >= 5 * obs.length; return [k, { batches: n, first_served_rank_counts: obs, chi2: r4(chi2(obs)), critical_p001: CRIT[obs.length - 1] ?? null, tested: ok, passes: ok ? chi2(obs) < (CRIT[obs.length - 1] ?? Infinity) : null }]; }));
  out[base] = { batches: batches.length, lowest_id_first: L, expected: r4(E), z: r4(z), binomial_passes: Math.abs(z) < 3.291, per_batch_size: perK };
}
const report = {
  schema: 'antempire.p0a2-q4-tiebreak-fairness.v1', official: false,
  status: '非正式：Owner #193 Q4。平手順序 hash32(種子|t|ID) 是過渡性的工程仲裁，不是宣稱的自然競爭規則；本檢查只問首位處理是否偏向某個 ID。',
  command: `node prototypes/p0a2-24h/tools/q4-tiebreak-fairness.ts --seeds ${SEEDS} --days ${DAYS}`,
  scenario: 'taichung-march-ref (synthetic)', seeds: SEEDS, days: DAYS, threshold: 'binomial |z| < 3.291 and chi-square < critical value, both p = 0.001; per-size chi-square only when every expected count >= 5',
  results: out,
};
fs.mkdirSync(path.join(DIR, 'out'), { recursive: true });
fs.writeFileSync(path.join(DIR, 'out', 'q4-tiebreak-fairness.json'), JSON.stringify(report, null, 1) + '\n');
console.log(JSON.stringify(report.results));
