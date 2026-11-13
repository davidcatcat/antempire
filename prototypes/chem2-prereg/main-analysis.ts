/**
 * CHEM-2 sensitivity MAIN ANALYSIS reporter (Owner ruling #213 Q3 a; docs/chem2-sensitivity-prereg.md). NON-OFFICIAL.
 *
 * Runs exactly the pre-registered grid of prototypes/chem2-prereg/preregistration.v1.json (frozen, SHA-256 locked by
 * tests/chem2-prereg.test.ts): half-life × Q10 × weather = 48 cells in the fixed order half-life → Q10 → weather (D1),
 * the main scenarios S1-laden / S1-explore / S3-ratio and the fixed secondary scenarios S2-crossing / S1-M2 /
 * S4-rain-off, the registered probes, the metrics M-read / M-residual / M-remain / M-ratio / M-zero and the decision
 * rules D1–D4. Every parameter is read from the pre-registration file and checked against the CHEM-2 bench constants
 * before anything runs (a mismatch throws); the science itself is NOT re-implemented here: every reading comes from
 * prototypes/chem2/bench.ts (singleTrail / singleTrailM2 / crossingRun) on engine/chemistry.
 *
 *  - every cell is computed, even the mathematically equivalent ones (λ = 0 rows, Q10 OFF cool/hot); equivalence is
 *    FLAGGED by actual bitwise comparison (Object.is on every reading and the residual), never assumed;
 *  - D2 failures are kept in place and listed with reasons; D3 is a descriptive label only; there is no ranking and no
 *    "best" / "calibrated" cell (D4); output is ranges and sensitivity directions;
 *  - temperature input = air-temperature proxy (air_temp_c_surrogate) as registered; SURF-0 is NOT connected.
 *  - deterministic: no timing, no wall clock, no randomness; the report regenerates byte-identically
 *    (tests/chem2-prereg-main.test.ts).
 *
 *   node prototypes/chem2-prereg/main-analysis.ts            -> print the Markdown report
 *   node prototypes/chem2-prereg/main-analysis.ts --write    -> write reports/chem2-prereg-main/main-analysis.{json,md}
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256Hex } from '../../engine/sha256.ts';
import {
  ANCHOR, CLOCK, COVER, EXPLORE, HALF_LIVES_MIN, LADEN, PROBES_S, Q10S, SHAPE, SITE, T_REF_C, WEATHER,
  clockCfg, crossingRun, envOf, kinetics, label, singleTrail, singleTrailM2, weatherInputs, type WeatherName,
} from '../chem2/bench.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PREREG_PATH = 'prototypes/chem2-prereg/preregistration.v1.json';
export const OUT_DIR = 'reports/chem2-prereg-main';
/** origin/main commit on which this reporter was built (CHEM-2 bench on main). The reporter and the additive ledger
 *  fields of the bench come with the PR that adds this file; the exact code is locked by `code.sources` (SHA-256). */
export const CODE_BASE_COMMIT = '688ca9e555877037e3d73d45583c55ee05203426';
/** D2 residual tolerance and M-zero threshold, as registered (decision_rules D2, metrics M-zero) */
const RESIDUAL_REL = 1e-9, ZERO_EPS = 1e-12;

type HL = { label: string; bench_value: number | null };
type QQ = { label: string; bench_value: number | null };
type WW = { label: string; t_min_c: number; t_max_c: number; synthetic: boolean };

const fail = (why: string): never => { throw new Error(`chem2 main analysis: pre-registration / bench mismatch: ${why}`); };
const same = (a: unknown, b: unknown, why: string) => { if (JSON.stringify(a) !== JSON.stringify(b)) fail(`${why}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

/** load the frozen pre-registration and check that every registered setting equals the bench (throws otherwise) */
export function loadPrereg() {
  const raw = fs.readFileSync(path.join(ROOT, PREREG_PATH), 'utf8');
  const R = JSON.parse(raw);
  const G = R.grid, FX = R.fixed_setup;
  same(G.half_life_min.map((x: HL) => x.bench_value), HALF_LIVES_MIN, 'half-life grid');
  same(G.q10.map((x: QQ) => x.bench_value), Q10S, 'Q10 grid');
  same(G.half_life_reference_temperature_c, T_REF_C, 'reference temperature');
  same(G.weather.map((w: WW) => [w.label, w.t_min_c, w.t_max_c]), Object.entries(WEATHER).map(([k, w]) => [k, w.t_min_c, w.t_max_c]), 'weather');
  if (G.cells_total !== G.half_life_min.length * G.q10.length * G.weather.length) fail('cells_total');
  same(R.probes_s_after_noon, PROBES_S, 'probes');
  same([...R.deposit_schedule_s_after_noon.explore, ...R.deposit_schedule_s_after_noon.laden], [EXPLORE.from_s, EXPLORE.to_s, LADEN.from_s, LADEN.to_s], 'deposit schedule');
  same(FX.anchor, ANCHOR, 'anchor'); same(FX.site, SITE, 'site'); same(FX.temperature_shape, SHAPE, 'temperature shape');
  same(FX.cover_s, [COVER.t0_s, COVER.t1_s], 'cover');
  const cfg = clockCfg();
  if (!R.seeds.clock_seed.includes(cfg.seed) || R.seeds.clock_seed.length !== 1) fail('clock seed');
  same(FX.sample_step_min, cfg.sample_step_min, 'sample step');
  same(weatherInputs('cool').map((d) => d.rh_mean_percent), [FX.rh_mean_percent, FX.rh_mean_percent, FX.rh_mean_percent], 'RH');
  same(weatherInputs('cool').map((d) => d.rain_mm), [FX.rain_mm, FX.rain_mm, FX.rain_mm], 'main scenarios are rain-free');
  same(kinetics(2).temperature?.input, FX.temperature_input, 'temperature input (air-temperature proxy)');
  if (FX.chem_clock_origin !== 'world day 1 12:00' || CLOCK.anchor.day !== 1 || CLOCK.anchor.minute !== 720) fail('chemistry clock origin');
  const every = R.deposit_schedule_s_after_noon.every_s;
  if (every !== 60) fail('deposit every_s (the bench deposits once per minute)');
  same(R.scenarios.main.map((s: { id: string }) => s.id), ['S1-laden', 'S1-explore', 'S3-ratio'], 'main scenarios');
  same(R.scenarios.secondary_fixed.map((s: { id: string }) => s.id), ['S2-crossing', 'S1-M2', 'S4-rain-off'], 'secondary scenarios');
  same(R.metrics.map((m: { id: string }) => m.id), ['M-read', 'M-residual', 'M-remain', 'M-ratio', 'M-zero'], 'metrics');
  return { raw, sha256: sha256Hex(raw), R };
}

const hlValue = (G: { half_life_min: HL[] }, lab: string) => { const h = G.half_life_min.find((x) => x.label === lab); if (!h) fail(`half-life ${lab} not in grid`); return h!.bench_value; };
const qValue = (G: { q10: QQ[] }, lab: string) => { const q = G.q10.find((x) => x.label === lab); if (!q) fail(`Q10 ${lab} not in grid`); return q!.bench_value; };
const asWeather = (w: string): WeatherName => { if (!(w in WEATHER)) fail(`weather ${w}`); return w as WeatherName; };

/** secondary scenario cells, parsed from the registered text (not re-typed) */
export function secondaryCells(R: ReturnType<typeof loadPrereg>['R']) {
  const sec = (id: string) => R.scenarios.secondary_fixed.find((s: { id: string }) => s.id === id).zh as string;
  const s2 = [...sec('S2-crossing').matchAll(/\(([^()]+)\)/g)].map((m) => m[1].split(',').map((x) => x.trim()))
    .filter((t) => t.length === 3).map(([h, q, w]) => ({ h, q, w: asWeather(w) }));
  if (s2.length !== 4) fail(`S2 cells parsed: ${s2.length}`);
  const m2t = sec('S1-M2');
  const sets = [...m2t.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1].split(',').map((x) => x.trim()));
  const q2 = /Q10 = ([0-9.]+)/.exec(m2t);
  if (sets.length !== 3 || !q2) fail('S1-M2 text');
  const m2 = { halfF: sets[0].map(Number), ratio: sets[1].map(Number), weather: sets[2].map(asWeather), q10: Number(q2![1]) };
  const s4t = sec('S4-rain-off');
  const s4m = /^(\d+) min、Q10 ([0-9.]+)、(熱|涼)天：.*?(\d+) mm/.exec(s4t);
  if (!s4m) fail('S4 text');
  const s4 = { h: s4m![1], q: s4m![2], w: (s4m![3] === '熱' ? 'hot' : 'cool') as WeatherName, rain_mm: Number(s4m![4]) };
  return { s2, m2, s4 };
}

// ------------------------------------------------------------------ checks
type Check = { id: string; applies: boolean; pass: boolean; detail: string };
const bitEq = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const zeroCount = (v: readonly number[]) => v.filter((x) => x === 0 || Math.abs(x) < ZERO_EPS).length;
const remain = (v: readonly number[], i16: number, i14: number) => (v[i14] === 0 ? null : v[i16] / v[i14]);

/** D2 checks that depend only on one run (NaN/negative, residual, increase after the last deposit, λ = 0 constancy) */
export function d2Single(values: readonly number[], probes: readonly number[], lastDeposit_s: number, residual: number, deposited: number, lambdaZero: boolean, rainFree: boolean): Check[] {
  const after = probes.map((t, i) => [t, values[i]] as const).filter(([t]) => t >= lastDeposit_s).map(([, v]) => v);
  const rises = after.slice(1).map((v, i) => v > after[i]).filter(Boolean).length;
  const bad = values.filter((v) => Number.isNaN(v) || v < 0).length;
  const tol = RESIDUAL_REL * deposited;
  return [
    { id: 'nan_or_negative', applies: true, pass: bad === 0, detail: bad === 0 ? 'no NaN / negative reading' : `${bad} NaN or negative reading(s)` },
    { id: 'ledger_residual', applies: true, pass: Number.isFinite(residual) && Math.abs(residual) <= tol, detail: `abs(residual) ${Math.abs(residual).toExponential(3)} vs ${RESIDUAL_REL} × deposited ${deposited} = ${tol.toExponential(3)}` },
    { id: 'no_increase_after_last_deposit', applies: rainFree, pass: !rainFree || rises === 0, detail: `${after.length} probes at/after last deposit (${lastDeposit_s} s); ${rises} increase(s)` },
    { id: 'lambda0_constant_after_last_deposit', applies: lambdaZero, pass: !lambdaZero || after.every((v) => Object.is(v, after[0])), detail: lambdaZero ? (after.every((v) => Object.is(v, after[0])) ? 'all readings after the last deposit identical' : 'reading changed after the last deposit') : 'n/a (λ ≠ 0)' },
  ];
}

// ------------------------------------------------------------------ main analysis
export interface MainCell {
  index: number; cell_id: string; half_life_min: string; q10: string; weather: string;
  M_read: number[]; M_residual: number; deposited: number; M_remain: number | null; M_zero: number;
  math_equivalent_class: string | null; bitwise_identical_to: string | null;
  d2: { pass: boolean; reasons: string[]; checks: Check[] };
}

export function runAnalysis() {
  const { sha256, R } = loadPrereg();
  const G = R.grid, probes: number[] = R.probes_s_after_noon;
  const i14 = probes.indexOf(7200), i16 = probes.indexOf(14400);
  if (i14 < 0 || i16 < 0) fail('14:00 / 16:00 probes');
  const sched = R.deposit_schedule_s_after_noon, every = sched.every_s;
  const parts = { 'S1-laden': { part: 'laden' as const, from: sched.laden[0], to: sched.laden[1] }, 'S1-explore': { part: 'explore' as const, from: sched.explore[0], to: sched.explore[1] } };

  const main: Record<string, MainCell[]> = {};
  for (const [sid, p] of Object.entries(parts)) {
    const cells: MainCell[] = [];
    const expectedDeposits = (p.to - p.from) / every; // amount 1 per pass
    for (const h of G.half_life_min as HL[]) for (const q of G.q10 as QQ[]) for (const w of G.weather as WW[]) {
      const r = singleTrail(h.bench_value, q.bench_value, asWeather(w.label), p.part);
      if (r.deposited !== expectedDeposits) fail(`${sid} deposited ${r.deposited} != registered schedule ${expectedDeposits}`);
      const lambdaZero = h.bench_value === null;
      cells.push({
        index: cells.length, cell_id: `hl=${h.label};q10=${q.label};${w.label}`, half_life_min: h.label, q10: q.label, weather: w.label,
        M_read: r.values, M_residual: r.residual, deposited: r.deposited, M_remain: remain(r.values, i16, i14), M_zero: zeroCount(r.values),
        // which cells the registered rule calls mathematically identical (λ = 0 rows; Q10 OFF cool/hot pairs)
        math_equivalent_class: lambdaZero ? 'λ=0' : q.bench_value === null ? `hl=${h.label};q10=off` : null,
        bitwise_identical_to: null,
        d2: { pass: true, reasons: [], checks: d2Single(r.values, probes, p.to, r.residual, r.deposited, lambdaZero, true) },
      });
    }
    // equivalence: actual bitwise comparison with every earlier cell (readings and residual)
    for (const c of cells) {
      const prev = cells.slice(0, c.index).find((e) => bitEq(e.M_read, c.M_read) && Object.is(e.M_residual, c.M_residual));
      c.bitwise_identical_to = prev ? prev.cell_id : null;
    }
    // D2: Q10 OFF cool / hot must be bitwise identical
    for (const c of cells) {
      if (c.q10 === 'off') {
        const pair = cells.filter((e) => e.half_life_min === c.half_life_min && e.q10 === 'off');
        const okPair = pair.every((e) => bitEq(e.M_read, pair[0].M_read) && Object.is(e.M_residual, pair[0].M_residual));
        c.d2.checks.push({ id: 'q10_off_weather_bitwise', applies: true, pass: okPair, detail: `${pair.map((e) => e.cell_id).join(' vs ')}: ${okPair ? 'bitwise identical' : 'NOT bitwise identical'}` });
      } else c.d2.checks.push({ id: 'q10_off_weather_bitwise', applies: false, pass: true, detail: 'n/a (Q10 on)' });
      const failed = c.d2.checks.filter((k) => k.applies && !k.pass);
      c.d2.pass = failed.length === 0; c.d2.reasons = failed.map((k) => `${k.id}: ${k.detail}`);
    }
    main[sid] = cells;
  }

  // S3: 16:00 hot / cool ratio, half-life ≠ 0 × all Q10 (from S1-laden)
  const L = main['S1-laden'];
  const s3 = (G.half_life_min as HL[]).filter((h) => h.bench_value !== null).flatMap((h) => (G.q10 as QQ[]).map((q) => {
    const hot = L.find((c) => c.half_life_min === h.label && c.q10 === q.label && c.weather === 'hot')!;
    const cool = L.find((c) => c.half_life_min === h.label && c.q10 === q.label && c.weather === 'cool')!;
    const ratio = hot.M_read[i16] / cool.M_read[i16];
    return { cell_id: `hl=${h.label};q10=${q.label}`, half_life_min: h.label, q10: q.label, hot_16: hot.M_read[i16], cool_16: cool.M_read[i16], M_ratio: ratio, deviation_from_1: Math.abs(ratio - 1), D3: Math.abs(ratio - 1) > 0.1 ? '溫度敏感' : '溫度不敏感' };
  }));

  // secondary (fixed)
  const sc = secondaryCells(R);
  const s2 = sc.s2.map(({ h, q, w }) => {
    const hv = hlValue(G, h), qv = qValue(G, q), r = crossingRun(hv, qv, w);
    const checks = Object.entries(r.probes).flatMap(([k, v]) => d2Single(v, probes, LADEN.to_s, r.ledger.residual, r.ledger.deposited, hv === null, true).filter((c) => c.id !== 'ledger_residual').map((c) => ({ ...c, id: `${k}:${c.id}` })));
    checks.push(d2Single([], probes, LADEN.to_s, r.ledger.residual, r.ledger.deposited, false, false).find((c) => c.id === 'ledger_residual')!);
    const failed = checks.filter((k) => k.applies && !k.pass);
    return { cell_id: `hl=${h};q10=${q};${w}`, half_life_min: h, q10: q, weather: w, M_read: r.probes, M_residual: r.ledger.residual, deposited: r.ledger.deposited, M_zero: Object.values(r.probes).reduce((a, v) => a + zeroCount(v), 0), d2: { pass: failed.length === 0, reasons: failed.map((k) => `${k.id}: ${k.detail}`), checks } };
  });
  const m2 = sc.m2.halfF.flatMap((hF) => sc.m2.ratio.flatMap((ratio) => sc.m2.weather.map((w) => {
    const r = singleTrailM2(hF, ratio, sc.m2.q10, w);
    const checks = [
      ...d2Single(r.E, probes, EXPLORE.to_s, r.ledgers.E.residual, r.ledgers.E.deposited, false, true).map((c) => ({ ...c, id: `E:${c.id}` })),
      ...d2Single(r.F, probes, LADEN.to_s, r.ledgers.F.residual, r.ledgers.F.deposited, false, true).map((c) => ({ ...c, id: `F:${c.id}` })),
    ];
    const failed = checks.filter((k) => k.applies && !k.pass);
    return { cell_id: `hlF=${hF};ratio=${ratio};q10=${sc.m2.q10};${w}`, half_life_F_min: hF, lambdaE_over_lambdaF: ratio, half_life_E_min: hF / ratio, q10: sc.m2.q10, weather: w, E: r.E, F: r.F, residual: { E: r.ledgers.E.residual, F: r.ledgers.F.residual }, M_remain: { E: remain(r.E, i16, i14), F: remain(r.F, i16, i14) }, M_zero: zeroCount(r.E) + zeroCount(r.F), d2: { pass: failed.length === 0, reasons: failed.map((k) => `${k.id}: ${k.detail}`), checks } };
  })));
  const hv4 = hlValue(G, sc.s4.h), qv4 = qValue(G, sc.s4.q), wetEnv = envOf(sc.s4.w, R.fixed_setup.sample_step_min, sc.s4.rain_mm);
  const dry = singleTrail(hv4, qv4, sc.s4.w, 'laden'), wet = singleTrail(hv4, qv4, sc.s4.w, 'laden', wetEnv);
  const s4 = {
    cell_id: `hl=${sc.s4.h};q10=${sc.s4.q};${sc.s4.w};laden`, rain_mm: sc.s4.rain_mm, washoff: null,
    rain_intervals_s: wetEnv.zones[0].rain!.intervals.map((x) => [x.t0_s, x.t1_s]), rain_timing_known: wetEnv.zones[0].rain!.timing_known,
    dry: dry.values, wet_washoff_null: wet.values, residual: { dry: dry.residual, wet: wet.residual },
    bitwise_identical: bitEq(dry.values, wet.values) && Object.is(dry.residual, wet.residual),
  };

  return { sha256, R, probes, main, s3, s2, m2, s4, i14, i16 };
}

// ------------------------------------------------------------------ summary (ranges and directions only, D4)
const range = (xs: readonly (number | null)[]) => { const v = xs.filter((x): x is number => x !== null && Number.isFinite(x)); return v.length ? { min: Math.min(...v), max: Math.max(...v), n: v.length, excluded: xs.length - v.length } : { min: null, max: null, n: 0, excluded: xs.length }; };

function summarize(A: ReturnType<typeof runAnalysis>) {
  const out: Record<string, unknown> = {};
  for (const [sid, cells] of Object.entries(A.main)) {
    const decaying = cells.filter((c) => c.half_life_min !== '0');
    // directions (descriptive counts, every comparison reported): hot vs cool at each Q10 ≠ off; longer half-life vs shorter at fixed (Q10, weather)
    const hotCool = { hot_lower_at_every_probe: 0, hot_not_lower: 0 };
    for (const c of decaying.filter((x) => x.q10 !== 'off' && x.weather === 'hot')) {
      const cool = cells.find((e) => e.half_life_min === c.half_life_min && e.q10 === c.q10 && e.weather === 'cool')!;
      if (c.M_read.every((v, i) => v < cool.M_read[i])) hotCool.hot_lower_at_every_probe++; else hotCool.hot_not_lower++;
    }
    const hls = (A.R.grid.half_life_min as HL[]).filter((h) => h.bench_value !== null).map((h) => h.label);
    const hlDir = { longer_half_life_higher_at_16: 0, not_higher: 0 };
    for (const q of A.R.grid.q10 as QQ[]) for (const w of A.R.grid.weather as WW[]) for (let i = 1; i < hls.length; i++) {
      const a = cells.find((e) => e.half_life_min === hls[i - 1] && e.q10 === q.label && e.weather === w.label)!, b = cells.find((e) => e.half_life_min === hls[i] && e.q10 === q.label && e.weather === w.label)!;
      if (b.M_read[A.i16] > a.M_read[A.i16]) hlDir.longer_half_life_higher_at_16++; else hlDir.not_higher++;
    }
    out[sid] = {
      cells: cells.length,
      M_read_range_by_probe_all_cells: A.probes.map((t, i) => ({ probe_s: t, label: label(t), ...range(cells.map((c) => c.M_read[i])) })),
      M_read_range_by_probe_half_life_ne_0: A.probes.map((t, i) => ({ probe_s: t, label: label(t), ...range(decaying.map((c) => c.M_read[i])) })),
      M_remain_range_half_life_ne_0: range(decaying.map((c) => c.M_remain)),
      M_residual_abs_max: Math.max(...cells.map((c) => Math.abs(c.M_residual))),
      M_zero_total: cells.reduce((a, c) => a + c.M_zero, 0), M_zero_cells: cells.filter((c) => c.M_zero > 0).map((c) => c.cell_id),
      bitwise_identical_cells: cells.filter((c) => c.bitwise_identical_to !== null).length,
      unexpected_bitwise_identical: cells.filter((c) => c.bitwise_identical_to !== null && c.math_equivalent_class === null).map((c) => c.cell_id),
      d2_failures: cells.filter((c) => !c.d2.pass).map((c) => ({ cell_id: c.cell_id, reasons: c.d2.reasons })),
      direction_hot_vs_cool_q10_on: hotCool, direction_half_life_at_16: hlDir,
    };
  }
  const byQ = (A.R.grid.q10 as QQ[]).map((q) => ({ q10: q.label, ...range(A.s3.filter((x) => x.q10 === q.label).map((x) => x.M_ratio)) }));
  out['S3-ratio'] = { cells: A.s3.length, M_ratio_range: range(A.s3.map((x) => x.M_ratio)), M_ratio_range_by_q10: byQ, D3_counts: { 溫度敏感: A.s3.filter((x) => x.D3 === '溫度敏感').length, 溫度不敏感: A.s3.filter((x) => x.D3 === '溫度不敏感').length } };
  out['S2-crossing'] = { cells: A.s2.length, d2_failures: A.s2.filter((c) => !c.d2.pass).map((c) => ({ cell_id: c.cell_id, reasons: c.d2.reasons })) };
  out['S1-M2'] = { cells: A.m2.length, E_16_range: range(A.m2.map((c) => c.E[A.i16])), F_16_range: range(A.m2.map((c) => c.F[A.i16])), d2_failures: A.m2.filter((c) => !c.d2.pass).map((c) => ({ cell_id: c.cell_id, reasons: c.d2.reasons })) };
  out['S4-rain-off'] = { bitwise_identical: A.s4.bitwise_identical };
  return out;
}

// ------------------------------------------------------------------ code lock (static relative-import closure)
export function sourceClosure(entry = 'prototypes/chem2-prereg/main-analysis.ts'): { path: string; sha256: string }[] {
  const seen = new Set<string>(), stack = [entry];
  while (stack.length) {
    const rel = stack.pop()!; if (seen.has(rel)) continue; seen.add(rel);
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)[^'";]*?from\s+'(\.{1,2}\/[^']+)'/g)) stack.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), m[1])));
  }
  return [...seen].sort().map((p) => ({ path: p, sha256: sha256Hex(fs.readFileSync(path.join(ROOT, p), 'utf8')) }));
}

// ------------------------------------------------------------------ report
export function buildReport(): { json: string; md: string; data: Record<string, unknown> } {
  const A = runAnalysis();
  const summary = summarize(A);
  const header = {
    schema: 'antempire.chem2-prereg-main.v1', official: false,
    status: 'exploratory_sensitivity_range',
    status_zh: '非正式／探索性敏感度範圍；不是校準；不代表本種（Pheidole megacephala）參數；所有天氣為合成午後，不是臺中氣候值',
    d4_zh: '依 D4，本報告不從網格挑出任何一組作為最佳、已校準或本種數值；結論只寫範圍與敏感方向。',
    prereg: { id: A.R.id, path: PREREG_PATH, sha256: A.sha256 },
    code: { base_commit: CODE_BASE_COMMIT, base_commit_note: 'origin/main 上 CHEM-2 基準所在的提交；本報告器與基準帳本欄位（additive）由新增本檔的 PR 加入，確切程式以 sources 逐檔 SHA-256 鎖定', sources: sourceClosure() },
    temperature_input: A.R.fixed_setup.temperature_input,
    temperature_input_zh: '氣溫代理（air_temp_c_surrogate）；SURF-0 地表溫度候選依預註冊只作對照、未接入主分析，本報告不含 SURF-0 對照',
    clock_seed: A.R.seeds.clock_seed[0], probes_s_after_noon: A.probes, probe_labels: A.probes.map(label),
    quantity: 'normalized_activity (edge cell reading at s = 300 mm; not a chemical concentration)',
  };
  const data = {
    ...header, summary,
    main: A.main, 'S3-ratio': A.s3, secondary: { 'S2-crossing': A.s2, 'S1-M2': A.m2, 'S4-rain-off': A.s4 },
  };
  const json = JSON.stringify(data, null, 1) + '\n';
  return { json, md: markdown(A, header, summary), data };
}

const fmt = (x: number | null) => (x === null ? '—' : Number.isNaN(x) ? 'NaN' : x === 0 ? '0' : Math.abs(x) >= 1e-3 && Math.abs(x) < 1e4 ? x.toPrecision(6) : x.toExponential(4));
const WZ: Record<string, string> = { cool: '涼', hot: '熱' };

function markdown(A: ReturnType<typeof runAnalysis>, H: Record<string, unknown> & { prereg: { sha256: string }; code: { sources: { path: string; sha256: string }[] } }, S: Record<string, any>): string {
  const L: string[] = []; const P = (s = '') => L.push(s);
  const probeHead = A.probes.map(label).join(' | ');
  P('# CHEM-2 敏感度主分析（預註冊 v1）');
  P();
  P('> **非正式／探索性敏感度範圍；不是校準；不代表本種（*Pheidole megacephala*）參數。** 天氣為合成午後（涼 18～24 °C、熱 26～34 °C），不是臺中氣候值。讀值是 normalized activity，不是化學濃度。依 D4，本報告不從網格挑出任何一組作為「最佳」「已校準」或本種數值；結論只寫範圍與敏感方向。');
  P();
  P(`- 預註冊：\`${A.R.id}\`（[\`${PREREG_PATH}\`](../../${PREREG_PATH})），SHA-256 \`${H.prereg.sha256}\``);
  P(`- 程式：基準提交 \`${CODE_BASE_COMMIT}\`（main 上 CHEM-2 基準）；報告器 \`prototypes/chem2-prereg/main-analysis.ts\` 與基準的帳本欄位（只新增、不改行為）由新增本報告的 PR 加入；確切程式以下列逐檔 SHA-256 鎖定。`);
  P(`- 溫度輸入：氣溫代理（\`${A.R.fixed_setup.temperature_input}\`）。SURF-0 地表溫度候選依預註冊只作對照、**未接入**；本報告不含 SURF-0 對照。`);
  P(`- 種子：P0-A1 時鐘種子 ${A.R.seeds.clock_seed[0]}（主情境沒有隨機抽樣）。取樣步長 ${A.R.fixed_setup.sample_step_min} 分；RH ${A.R.fixed_setup.rh_mean_percent} %；主情境無雨。`);
  P(`- 重現：\`node prototypes/chem2-prereg/main-analysis.ts --write\`；\`tests/chem2-prereg-main.test.ts\` 檢查本檔與 JSON 逐位元組可由程式重生。`);
  P();
  P('<details><summary>程式逐檔 SHA-256</summary>'); P();
  for (const s of H.code.sources) P(`- \`${s.path}\` \`${s.sha256}\``);
  P(); P('</details>'); P();

  P('## 摘要（範圍與敏感方向；不是選參）'); P();
  for (const sid of ['S1-laden', 'S1-explore']) {
    const s = S[sid];
    P(`### ${sid}`); P();
    P(`- 格數 ${s.cells}；D2 失敗 ${s.d2_failures.length} 格；與較前格逐位元相同 ${s.bitwise_identical_cells} 格（非預期的逐位元相同：${s.unexpected_bitwise_identical.length ? s.unexpected_bitwise_identical.join('、') : '無'}）；|帳本殘差| 最大 ${fmt(s.M_residual_abs_max)}；M-zero 合計 ${s.M_zero_total}${s.M_zero_cells.length ? `（${s.M_zero_cells.join('、')}）` : ''}。`);
    P(`- 半衰期 ≠ 0 的 40 格，各探針讀值範圍：${s.M_read_range_by_probe_half_life_ne_0.map((r: any) => `${r.label} ${fmt(r.min)}～${fmt(r.max)}`).join('；')}。`);
    P(`- 半衰期 = 0（λ = 0 基準）各探針讀值：${s.M_read_range_by_probe_all_cells.map((_: unknown, i: number) => fmt(A.main[sid][0].M_read[i])).join('、')}（8 格逐位元相同）。`);
    P(`- M-remain（16:00／14:00，半衰期 ≠ 0）：${fmt(s.M_remain_range_half_life_ne_0.min)}～${fmt(s.M_remain_range_half_life_ne_0.max)}。`);
    P(`- 方向（描述計數）：Q10 開啟時熱天在每個探針都低於涼天 ${s.direction_hot_vs_cool_q10_on.hot_lower_at_every_probe}／${s.direction_hot_vs_cool_q10_on.hot_lower_at_every_probe + s.direction_hot_vs_cool_q10_on.hot_not_lower} 對；固定 Q10、天氣時，半衰期較長者 16:00 讀值較高 ${s.direction_half_life_at_16.longer_half_life_higher_at_16}／${s.direction_half_life_at_16.longer_half_life_higher_at_16 + s.direction_half_life_at_16.not_higher} 對。`);
    P();
  }
  const s3 = S['S3-ratio'];
  P('### S3-ratio'); P();
  P(`- 20 格 16:00 熱／涼比範圍 ${fmt(s3.M_ratio_range.min)}～${fmt(s3.M_ratio_range.max)}；依 Q10：${s3.M_ratio_range_by_q10.map((r: any) => `${r.q10} ${fmt(r.min)}～${fmt(r.max)}`).join('；')}。`);
  P(`- D3 描述性分類：溫度敏感 ${s3.D3_counts['溫度敏感']} 格、溫度不敏感 ${s3.D3_counts['溫度不敏感']} 格（只描述範圍，不是選參）。`);
  P();
  P(`### 次要（固定）`); P();
  P(`- S2-crossing：${S['S2-crossing'].cells} 格，D2 失敗 ${S['S2-crossing'].d2_failures.length}。S1-M2：${S['S1-M2'].cells} 格，16:00 E 範圍 ${fmt(S['S1-M2'].E_16_range.min)}～${fmt(S['S1-M2'].E_16_range.max)}、F 範圍 ${fmt(S['S1-M2'].F_16_range.min)}～${fmt(S['S1-M2'].F_16_range.max)}，D2 失敗 ${S['S1-M2'].d2_failures.length}。S4-rain-off 逐位元相同：${A.s4.bitwise_identical}。`);
  P();
  P('## D2 失敗清單'); P();
  const allFail = [
    ...['S1-laden', 'S1-explore'].flatMap((sid) => S[sid].d2_failures.map((f: any) => ({ sid, ...f }))),
    ...S['S2-crossing'].d2_failures.map((f: any) => ({ sid: 'S2-crossing', ...f })), ...S['S1-M2'].d2_failures.map((f: any) => ({ sid: 'S1-M2', ...f })),
    ...(A.s4.bitwise_identical ? [] : [{ sid: 'S4-rain-off', cell_id: A.s4.cell_id, reasons: ['rain with wash-off null is not bitwise identical to rain-free'] }]),
  ];
  if (!allFail.length) P('無（所有格的 D2 檢查都已實際計算，見各表 D2 欄與 JSON 的 `d2.checks`）。');
  for (const f of allFail) P(`- ${f.sid} \`${f.cell_id}\`：${f.reasons.join('；')}`);
  P();

  for (const sid of ['S1-laden', 'S1-explore']) {
    P(`## ${sid}（全部 48 格，順序：半衰期 → Q10 → 天氣）`); P();
    P(`| # | 半衰期@${A.R.grid.half_life_reference_temperature_c}°C（分） | Q10 | 天氣 | ${probeHead} | 殘差 | M-remain | M-zero | 等價 | D2 |`);
    P(`|${'---|'.repeat(A.probes.length + 9)}`);
    for (const c of A.main[sid]) P(`| ${c.index + 1} | ${c.half_life_min === '0' ? '0（λ=0）' : c.half_life_min} | ${c.q10} | ${WZ[c.weather]} | ${c.M_read.map(fmt).join(' | ')} | ${c.M_residual.toExponential(2)} | ${fmt(c.M_remain)} | ${c.M_zero} | ${c.bitwise_identical_to ? `與 \`${c.bitwise_identical_to}\` 逐位元相同` : '—'} | ${c.d2.pass ? '通過' : `**失敗**：${c.d2.reasons.join('；')}`} |`);
    P();
  }
  P('## S3-ratio（16:00 熱／涼比；半衰期 ≠ 0 × 全部 Q10，20 格）'); P();
  P('| 半衰期（分） | Q10 | 熱 16:00 | 涼 16:00 | M-ratio | D3（描述） |'); P('|---|---|---|---|---|---|');
  for (const x of A.s3) P(`| ${x.half_life_min} | ${x.q10} | ${fmt(x.hot_16)} | ${fmt(x.cool_16)} | ${fmt(x.M_ratio)} | ${x.D3} |`);
  P();
  P('## S2-crossing（平面交叉，固定 4 格；r = 3 mm 平均密度 /mm²）'); P();
  P(`| 半衰期 | Q10 | 天氣 | 探針 | ${probeHead} | D2 |`); P(`|${'---|'.repeat(A.probes.length + 5)}`);
  for (const c of A.s2) for (const [k, v] of Object.entries(c.M_read)) P(`| ${c.half_life_min === '0' ? '0（λ=0）' : c.half_life_min} | ${c.q10} | ${WZ[c.weather]} | ${k} | ${v.map(fmt).join(' | ')} | ${c.d2.pass ? '通過' : `**失敗**：${c.d2.reasons.join('；')}`} |`);
  P();
  P('## S1-M2（雙通道；E 來自探索段、F 來自帶食段；λ_E = 比值 × λ_F；Q10 2）'); P();
  P('| 半衰期 F | λ_E/λ_F | 天氣 | E@14:00 | F@14:00 | E@16:00 | F@16:00 | M-remain E | M-remain F | D2 |'); P('|---|---|---|---|---|---|---|---|---|---|');
  for (const c of A.m2) P(`| ${c.half_life_F_min} | ${c.lambdaE_over_lambdaF} | ${WZ[c.weather]} | ${fmt(c.E[A.i14])} | ${fmt(c.F[A.i14])} | ${fmt(c.E[A.i16])} | ${fmt(c.F[A.i16])} | ${fmt(c.M_remain.E)} | ${fmt(c.M_remain.F)} | ${c.d2.pass ? '通過' : `**失敗**：${c.d2.reasons.join('；')}`} |`);
  P();
  P('## S4-rain-off'); P();
  P(`- \`${A.s4.cell_id}\`：無雨 vs 當日 ${A.s4.rain_mm} mm（合成雨時段 ${A.s4.rain_intervals_s.map(([a, b]) => `${label(a)}–${label(b)}`).join('、')}）且沖刷 null：逐位元相同 **${A.s4.bitwise_identical}**。`);
  P(`- 無雨讀值：${A.s4.dry.map(fmt).join('、')}；有雨（沖刷 null）讀值：${A.s4.wet_washoff_null.map(fmt).join('、')}。`);
  P();
  return L.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = buildReport();
  if (process.argv.includes('--write')) {
    const dir = path.join(ROOT, OUT_DIR); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'main-analysis.json'), r.json);
    fs.writeFileSync(path.join(dir, 'main-analysis.md'), r.md);
    console.log(`wrote ${OUT_DIR}/main-analysis.{json,md}`);
  } else console.log(r.md);
}
