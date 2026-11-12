/**
 * Device bench (Owner decisions 49 / 50; BLOCKING). Pure parts of prototypes/render-compare/src/bench-stats.ts:
 *  1. nearest-rank percentiles; frame summary (mean fps, p1 / p5 low fps, frame-time percentiles, busy / long-task ratio)
 *  2. least-squares slope and long-run drift (fps / min, heap MB / min; heap 'unavailable' when not exposed)
 *  3. dynamic-DPR controller: bounded, steps down when slow, up when fast, holds in the hysteresis band
 *  4. software-renderer detection (SwiftShader / llvmpipe / no WebGL / headless are never a device result)
 *  5. the matrix (A / B / C × 100 / 1000 / 5000 × DPR device / 1 × 1× / fast) and the mitigation set
 *  6. report schema: a valid report passes; a software run labelled 'device', missing fields, p1 > p5 fail; the
 *     committed headless sample is valid and labelled NOT a device result
 *  7. page guards: relative paths only, no engine / cli import, clipboard inside the click handler with a select
 *     fallback, the fragment has no document wrapper, the new renderer options are off in the game view
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import * as S from '../prototypes/render-compare/src/bench-stats.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const eq = (a: unknown, b: unknown, why: string) => { assert.deepEqual(a, b, why); checks++; };

// 1. percentiles and frame summary
eq(S.percentile([], 0.5), null, 'empty → null');
const ten = [10, 1, 9, 2, 8, 3, 7, 4, 6, 5];
eq(S.percentile(ten, 0), 1, 'p0 = min'); eq(S.percentile(ten, 1), 10, 'p100 = max'); eq(S.percentile(ten, 0.5), 5, 'nearest rank p50 of 1..10 = 5');
eq(S.percentile(ten, 0.95), 10, 'p95 of 10 samples = rank 10'); eq(S.percentile(ten, 0.91), 10, 'ceil rank'); eq(S.percentile(ten, 0.9), 9, 'p90 = rank 9');
ok(ten.join() === '10,1,9,2,8,3,7,4,6,5', 'input not mutated');
{ let prev = -Infinity; for (let p = 0; p <= 1.0001; p += 0.01) { const v = S.percentile(ten, p) as number; ok(v >= prev, `monotone in p (${p.toFixed(2)})`); prev = v; } }
{
  const iv = Array(600).fill(1000 / 60), s = S.summarizeFrames(iv, Array(600).fill(4), 10000, []);
  eq([s.fps_mean, s.fps_p1_low, s.fps_p5_low], [60, 60, 60], 'steady 60 fps'); eq(s.cpu.busy_ratio, 0.24, 'busy = 2400 ms JS / 10 s'); eq(s.cpu.longtask_ratio, 0, 'no long tasks'); ok(s.cpu.longtask_supported, 'supported flag');
  const spiky = [...Array(97).fill(16), 50, 100, 200], t = S.summarizeFrames(spiky, [], 1918, null);
  ok((t.fps_p1_low as number) <= (t.fps_p5_low as number), 'p1 low ≤ p5 low');
  eq([t.fps_p1_low, t.fps_p5_low, t.fps_mean], [10, 62.5, 52.58], 'p1 low = 1000 / p99, p5 low = 1000 / p95 (can exceed the mean when a few long frames drag the mean)');
  eq(t.frame_ms.p99, 100, 'p99 of 100 = rank 99'); eq(t.frame_ms.max, 200, 'max'); eq(t.cpu.longtask_supported, false, 'no API → unsupported'); eq(t.cpu.longtask_ratio, null, 'no API → null ratio');
  eq(S.summarizeFrames([], [], 0, null).fps_mean, null, 'no frames → null fps');
  eq(S.summarizeFrames([20], [5], 1000, [60, 120]).cpu.longtask_ratio, 0.18, 'long-task ratio = 180 / 1000');
}

// 2. slope and drift
eq(S.slope([0, 1, 2, 3], [5, 7, 9, 11]), 2, 'exact slope'); eq(S.slope([1], [1]), null, 'one point'); eq(S.slope([2, 2], [1, 5]), null, 'no x spread');
{
  const ws = Array.from({ length: 30 }, (_, i) => ({ t_s: (i + 1) * 10, fps: 60 - i * 0.1, p95_ms: 17, heap_mb: 40 + i * 0.5 }));
  const d = S.drift(ws); // fps −0.1 per 10 s = −0.6 / min; heap +0.5 per 10 s = +3 MB / min
  eq(d.fps_drift_per_min, -0.6, 'fps drift / min'); eq(d.heap_growth_mb_per_min, 3, 'heap growth / min'); eq(d.heap_status, 'measured', 'heap measured');
  eq(d.fps_first, 60, 'first'); ok(Math.abs((d.fps_change_pct as number) - ((60 - 2.9 - 60) / 60 * 100)) < 0.01, 'change %');
  const nh = S.drift(ws.map((w) => ({ ...w, heap_mb: null }))); eq(nh.heap_status, 'unavailable', 'no heap API → unavailable'); eq(nh.heap_growth_mb_per_min, null, 'no growth number invented');
  eq(S.drift([]).fps_drift_per_min, null, 'empty drift');
}

// 3. dynamic DPR
{
  const o = { min: 1, max: 2.625 };
  eq(S.nextDynamicDpr(2, Array(10).fill(40), o), 2, 'short window → unchanged');
  eq(S.nextDynamicDpr(2, Array(30).fill(40), o), 1.75, 'slow → step down');
  eq(S.nextDynamicDpr(1, Array(30).fill(40), o), 1, 'floor at min');
  eq(S.nextDynamicDpr(2, Array(30).fill(8), o), 2.25, 'fast → step up');
  eq(S.nextDynamicDpr(2.5, Array(30).fill(8), o), 2.625, 'cap at device DPR');
  eq(S.nextDynamicDpr(2, Array(30).fill(15), o), 2, 'hysteresis band holds');
  for (let i = 0; i < 200; i++) { const cur = 1 + (i % 7) * 0.25, v = S.nextDynamicDpr(cur, Array(30).fill((i * 7) % 50), o); ok(v >= 1 && v <= 2.625 && Math.abs(v - cur) <= 0.25 + 1e-9, `bounded single step (${cur} → ${v})`); }
}

// 4. software detection
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
for (const r of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'Google SwiftShader', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver', 'ANGLE (Mesa, softpipe)']) { const c = S.classifyGpu(r, UA, false); ok(c.software && c.environment === 'software-rendering', `software: ${r}`); }
for (const r of ['Adreno (TM) 730', 'Mali-G710', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Apple GPU']) { const c = S.classifyGpu(r, UA, false); ok(!c.software && c.environment === 'device-gpu', `device GPU: ${r}`); }
ok(S.classifyGpu(null, UA, false).environment === 'no-webgl' && S.classifyGpu(null, UA, false).software, 'no WebGL is flagged');
ok(S.classifyGpu('Mali-G710', UA.replace('Chrome/', 'HeadlessChrome/'), false).automation, 'headless UA → automation');
ok(S.classifyGpu('Mali-G710', UA, true).environment === 'automation', 'webdriver → automation');

// 5. matrix and mitigations
{
  const m = S.buildMatrix(), keys = new Set(m.map((c) => `${c.renderer}|${c.n}|${c.dpr}|${c.speed}`));
  eq(m.length, 36, '3 × 3 × 2 × 2 cells'); eq(keys.size, 36, 'unique');
  for (const r of S.RENDERERS) for (const n of S.COUNTS) for (const d of S.DPRS) for (const s of S.SPEEDS) ok(keys.has(`${r}|${n}|${d}|${s}`), `cell ${r} ${n} ${d} ${s}`);
  for (let i = 0; i < m.length; i += 3) eq(m.slice(i, i + 3).map((c) => c.renderer), ['A', 'B', 'C'], 'renderers interleaved innermost');
  eq(JSON.stringify(S.buildMatrix()), JSON.stringify(m), 'deterministic order');
  const ids = S.BREAKDOWN_CONFIGS.map((c) => c.id);
  eq(ids, ['baseline', 'cacheStatic', 'cull', 'decorLod1', 'dynamicDpr', 'atlas', 'all'], 'baseline, five single mitigations, all');
  ok(Object.values(S.BREAKDOWN_CONFIGS[0].toggles).every((v) => v === false) && Object.values(S.BREAKDOWN_CONFIGS[6].toggles).every((v) => v === true), 'baseline off / all on');
  for (const c of S.BREAKDOWN_CONFIGS.slice(1, 6)) eq(Object.values(c.toggles).filter(Boolean).length, 1, `${c.id}: exactly one toggle`);
  ok(S.TIMING.full.stabilityS >= 300 && S.TIMING.quick.measureS * 36 + S.TIMING.quick.breakdownS * 14 + S.TIMING.quick.stabilityS <= 150, 'full has a 5-minute run; quick stays near 2 minutes of measuring');
}

// 6. report schema
const summary = (fps: number) => ({ ...S.summarizeFrames(Array(120).fill(1000 / fps), Array(120).fill(3), 2000, []), gpu: { status: 'unavailable: x', ms_mean: null }, memory: { status: 'unavailable' } });
const valid = () => ({
  schema: S.REPORT_SCHEMA, mode: 'quick', measurement_class: 'device',
  device: { userAgent: UA, dpr: 2.625, screen: {}, hardwareConcurrency: 8, deviceMemory: 8, webgl: {}, software_rendering: false, environment: 'device-gpu' },
  matrix: S.buildMatrix().map((c) => ({ ...c, ...summary(55) })),
  breakdown: S.BREAKDOWN_CONFIGS.map((c) => ({ scene: 'replay', config: c.id, ...summary(50), layers_ms: { ground_chunks: 1 } })),
  stability: { windows: [], drift: S.drift([]) },
});
eq(S.validateReport(valid()), [], 'valid report');
{ const r = valid(); r.device.software_rendering = true; ok(S.validateReport(r).some((e) => /software rendering reported as a device/.test(e)), 'software run labelled device is rejected'); }
{ const r = valid() as Record<string, unknown>; delete r.matrix; ok(S.validateReport(r).includes('matrix'), 'missing matrix'); }
{ const r = valid(); (r.device as Record<string, unknown>).deviceMemory = undefined; delete (r.device as Record<string, unknown>).deviceMemory; ok(S.validateReport(r).includes('device.deviceMemory'), 'deviceMemory key required (null when unavailable)'); }
{ const r = valid(); (r.matrix[0] as Record<string, unknown>).fps_p1_low = 70; ok(S.validateReport(r).some((e) => /p1 low > p5 low/.test(e)), 'p1 > p5 rejected'); }
{ const r = valid(); (r.matrix[0] as Record<string, unknown>).renderer = 'D'; ok(S.validateReport(r).includes('matrix[0].renderer'), 'unknown renderer'); }
{ const r = valid(); (r.matrix[0] as Record<string, unknown>).error = 'webgl failed'; (r.matrix[0] as Record<string, unknown>).fps_mean = undefined; eq(S.validateReport(r), [], 'an errored cell needs no numbers'); }
eq(S.validateReport(null), ['report is not an object'], 'null');
const RC = path.join(REPO_ROOT, 'prototypes', 'render-compare');
{
  const sample = JSON.parse(fs.readFileSync(path.join(RC, 'device-bench-headless.json'), 'utf8'));
  for (const [tag, r] of Object.entries(sample.reports) as [string, Record<string, unknown> & { device: { software_rendering: boolean; automation: boolean } }][]) {
    eq(S.validateReport(r), [], `committed headless sample ${tag} is schema-valid`);
    ok(r.measurement_class !== 'device' && (r.device.software_rendering || r.device.automation), `${tag}: labelled NOT a device result`);
  }
  ok(/headless/i.test(sample.label) && /not a device result/i.test(sample.label), 'sample file label says headless / not a device result');
}

// 7. page guards
{
  const src = fs.readFileSync(path.join(RC, 'src', 'device-bench.ts'), 'utf8'), html = fs.readFileSync(path.join(RC, 'device-bench.html'), 'utf8');
  ok(!/from '\.\.\/\.\.\/\.\.\/(engine|cli)\//.test(src), 'no engine / cli import');
  ok(!/fetch\(['"`](\/|https?:)/.test(src) && /fetch\('data\//.test(src), 'relative fetches only');
  ok(!/<!doctype|<html[\s>]|<head[\s>]|<body[\s>]/i.test(html) && /<title>/.test(html) && /<script type="module" src="device-bench\.js"><\/script>/.test(html), 'fragment: title, style, markup, relative module script');
  ok(!/https?:\/\//.test(html), 'no external URL in the page');
  const copy = src.slice(src.indexOf("$('copy').addEventListener('click'"), src.indexOf('// automation hook'));
  ok(/navigator\.clipboard\.writeText\(text\)/.test(copy) && /\.select\(\)/.test(copy) && !/download/i.test(src), 'clipboard in the click handler, select-text fallback, no download');
  ok(/示範/.test(src) && !/示意合成|示意 positions/.test(src) && /非正式/.test(src), 'synthetic positions labelled 示範 (CLAUDE.md §8 demo data); replay labelled 非正式');
  const game = fs.readFileSync(path.join(REPO_ROOT, 'web', 'src', 'game.ts'), 'utf8'), rc = fs.readFileSync(path.join(REPO_ROOT, 'web', 'src', 'render-canvas.ts'), 'utf8');
  ok(/new LayeredRenderer\(canvas\)/.test(game) && !/cacheStatic|cullOffscreen|maxDpr|decorLod:|setDprCap/.test(game), 'game view keeps every new option off');
  ok(/this\.opts\.cacheStatic/.test(rc) && /this\.opts\.cullOffscreen/.test(rc) && !/Math\.random|Date\.now/.test(rc), 'options are explicit; no unseeded randomness or clock');
}

console.log(JSON.stringify({ test: 'device-bench', passed: true, checks }));
