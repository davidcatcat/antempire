/**
 * Demo 2 performance tests — Node checks (Owner directive 2026-11-15, items 5 and 6). BLOCKING. Nothing here runs or
 * changes a world.
 *  1. GPU classification: the written rule on real strings — software names (SwiftShader, llvmpipe, Mesa softpipe,
 *     lavapipe, WARP, Basic Render, "Software"), a WebGPU fallback adapter, masked strings → unknown, real GPUs.
 *  2. results carry measurement_class and the label; tables REFUSE to mix classes or APIs, and refuse a record whose
 *     class does not match its own GPU strings (a software result relabelled by hand).
 *  3. the self-stop rule of a full-simulation case; world counts; the synthetic generator is deterministic and stays
 *     in its area; frame statistics.
 *  4. source scans: the bench page never saves, never shows engine statistics, sends only scheduling commands, has
 *     the full-screen watermark; the synthetic generator touches nothing; the committed headless results are software.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { BENCH_SCHEMA, BENCH_SIZES, CLASS_LABEL_ZH, CLASS_RULE_ZH, MixedMeasurementError, SOFTWARE_PATTERNS, WATCH_LIMITS, WORKERS_PER_WORLD, adapterRecord, assertComparable, benchTable, caseRow, classifyGpu, frameStats, gpuLine, validateResult, watchdog, webglStrings, worldsFor, TABLE_HEAD, type BenchCase, type BenchResult, type GpuIdentity } from '../web/src/demo2/bench-report.ts';
import { synthPoint, synthUnit, SYNTH_AREA, SYNTH_LABEL_ZH, SYNTH_SPEED_CM_S } from '../web/src/demo2/bench-synth.ts';
import { readBenchFile } from '../cli/demo2-bench-table.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const read = (f: string) => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
const gl = (renderer: string | null, vendor: string | null = 'Google Inc. (X)', plain = 'WebKit WebGL'): GpuIdentity => ({ api: 'webgl2', webgl_unmasked_vendor: renderer === null ? null : vendor, webgl_unmasked_renderer: renderer, webgl_vendor: 'WebKit', webgl_renderer: plain, webgpu_adapter: null });
const wgpu = (a: Partial<NonNullable<GpuIdentity['webgpu_adapter']>> | null, glr: string | null = null): GpuIdentity => ({ api: 'webgpu', webgl_unmasked_vendor: null, webgl_unmasked_renderer: glr, webgl_vendor: null, webgl_renderer: null, webgpu_adapter: a === null ? null : { vendor: '', architecture: '', device: '', description: '', isFallbackAdapter: null, ...a } });

// 1. classification
{
  const software = [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'Google SwiftShader', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Mesa/X.org softpipe', 'softpipe',
    'ANGLE (Microsoft, Microsoft Basic Render Driver Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Microsoft Basic Render Driver', 'ANGLE (Mesa, llvmpipe (LLVM 17.0.6 256 bits), OpenGL 4.5)', 'Software Rasterizer', 'Apple Software Renderer', 'lavapipe', 'D3D11 WARP', 'ANGLE (Microsoft, WARP, D3D11)',
  ];
  for (const r of software) ok(classifyGpu(gl(r)).class === 'software', `software: ${r}`);
  ok(classifyGpu(gl(null, null, 'Mesa llvmpipe')).class === 'software', 'a software name in the plain RENDERER string is decisive even without the debug extension');
  const real = ['ANGLE (Qualcomm, Adreno (TM) 730, OpenGL ES 3.2)', 'Adreno (TM) 660', 'Mali-G78', 'ANGLE (ARM, Mali-G715, OpenGL ES 3.2)', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)', 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)', 'PowerVR Rogue GE8320', 'Samsung Xclipse 920'];
  for (const r of real) ok(classifyGpu(gl(r)).class === 'real_gpu', `real GPU: ${r}`);
  for (const r of [null, '', 'WebKit WebGL', 'Apple GPU', 'Mozilla', 'Generic Renderer']) ok(classifyGpu(gl(r)).class === 'unknown', `masked → unknown: ${JSON.stringify(r)}`);
  ok(classifyGpu(gl('ANGLE (Intel, Warpdrive X)')).class === 'real_gpu', 'WARP is matched as a word only');
  // WebGPU: the adapter decides; the WebGL probe strings do not
  ok(classifyGpu(wgpu({ isFallbackAdapter: true, vendor: 'nvidia' })).class === 'software', 'WebGPU fallback adapter → software, whatever its strings say');
  ok(classifyGpu(wgpu({ vendor: 'google', architecture: 'swiftshader', isFallbackAdapter: false })).class === 'software', 'WebGPU adapter naming SwiftShader → software');
  ok(classifyGpu(wgpu({ description: 'llvmpipe (LLVM 15)' })).class === 'software' && classifyGpu(wgpu({ device: 'Microsoft Basic Render Driver' })).class === 'software', 'WebGPU adapter description / device naming a software renderer → software');
  ok(classifyGpu(wgpu({ vendor: 'qualcomm', architecture: 'adreno-7xx', isFallbackAdapter: false })).class === 'real_gpu' && classifyGpu(wgpu({ vendor: 'apple', architecture: 'common-3' })).class === 'real_gpu', 'WebGPU adapter of a GPU → real_gpu');
  ok(classifyGpu(wgpu({})).class === 'unknown' && classifyGpu(wgpu(null)).class === 'unknown', 'WebGPU with empty / missing adapter info → unknown');
  ok(classifyGpu(wgpu({}, 'Adreno (TM) 730')).class === 'unknown', 'under WebGPU a real-GPU WebGL probe string does NOT make the result real_gpu');
  ok(classifyGpu(wgpu({ isFallbackAdapter: false })).class === 'real_gpu', 'WebGPU: an explicit non-fallback adapter with no software name → real_gpu');
  ok(classifyGpu({ ...gl('Adreno (TM) 730'), webgpu_adapter: { vendor: 'google', architecture: 'swiftshader', device: '', description: '', isFallbackAdapter: true } }).class === 'real_gpu', 'under WebGL 2 the (unused) WebGPU adapter does not change the class: the API in use decides');
  for (const v of [gl(software[0]), gl(real[0]), gl(null), wgpu({ isFallbackAdapter: true })]) ok(classifyGpu(v).rule.length > 10 && gpuLine(v).includes(v.api === 'webgpu' ? 'API：WebGPU' : 'API：WebGL 2'), 'every verdict states its rule; the line names the API in use');
  ok(SOFTWARE_PATTERNS.length === 7 && CLASS_RULE_ZH.length === 5 && ['SwiftShader', 'llvmpipe', 'softpipe', 'WARP', 'Basic Render', 'Software', 'isFallbackAdapter', 'unknown'].every((s) => CLASS_RULE_ZH.join('').includes(s)), 'the written rule names every pattern');
  ok(CLASS_LABEL_ZH.software === '軟體算繪，不是裝置結果', 'the software label');
  // reading the strings
  const fake = { VENDOR: 1, RENDERER: 2, getExtension: (n: string) => (n === 'WEBGL_debug_renderer_info' ? { UNMASKED_VENDOR_WEBGL: 3, UNMASKED_RENDERER_WEBGL: 4 } : null), getParameter: (p: number) => ['', 'WebKit', 'WebKit WebGL', 'Qualcomm', 'Adreno (TM) 730'][p] };
  ok(JSON.stringify(webglStrings(fake)) === JSON.stringify({ webgl_unmasked_vendor: 'Qualcomm', webgl_unmasked_renderer: 'Adreno (TM) 730', webgl_vendor: 'WebKit', webgl_renderer: 'WebKit WebGL' }) && webglStrings({ ...fake, getExtension: () => null }).webgl_unmasked_renderer === null && webglStrings(null).webgl_renderer === null, 'WebGL strings: unmasked when the extension exists, null otherwise');
  ok(adapterRecord({ info: { vendor: 'x', isFallbackAdapter: true } })!.isFallbackAdapter === true && adapterRecord({ info: { vendor: 'x' }, isFallbackAdapter: false })!.isFallbackAdapter === false && adapterRecord({ info: {} })!.isFallbackAdapter === null && adapterRecord(null) === null, 'isFallbackAdapter is read from adapter.info, else from the adapter, else recorded as not reported');
}

// 2. records and tables
const mkCase = (mode: 'render' | 'sim', n: number): BenchCase => ({ mode, n, status: 'ok', reason: null, warm_s: 3, dur_s: 10, frames: 600, fps_mean: 60, fps_p5_low: 55, frame_ms: { p50: 16.7, p95: 18, p99: 22, max: 30 }, cpu_ms: { p50: 3, p95: 5 }, draw_calls: 65, triangles: 112000, heap_mb: { start: 20, end: 22, max: 23 }, heap_series_mb: [20, 21, 22], quality: 'medium', dpr: 1.5, canvas: [618, 1258],
  sim: mode === 'sim' ? { worlds: worldsFor(n), drawn: n, seeds: [1], start_s: 3, msgs_per_s: 60, bytes_per_s_est: 800000, frame_bytes_est: 14000, sim_events_per_s: 12, ratio_requested: 5, ratio_achieved_mean: 5, ratio_achieved_min: 4.98, lag_s_max: 0.1 } : null });
const mkResult = (gpu: GpuIdentity, when = '2026-11-15T00:00:00.000Z'): BenchResult => { const v = classifyGpu(gpu); return { schema: BENCH_SCHEMA, when_utc: when, page: 'web/demo2-bench.html', three: '187', gpu, gpu_class: v.class, gpu_rule: v.rule, measurement_class: v.class, label_zh: CLASS_LABEL_ZH[v.class], renderer_requested: gpu.api, renderer_api: gpu.api, renderer_note: '', frame_pacing: gpu.api === 'webgpu' ? 'raf_after_gpu_queue_done' : 'raf', automated: false, user_agent: 'test', viewport: { w: 412, h: 839, dpr: 2.6 }, hardware_concurrency: 8, device_memory_gb: 8, cases: [mkCase('render', 30), mkCase('sim', 30)], notes_zh: [] }; };
{
  const sw = mkResult(gl('Google SwiftShader')), real = mkResult(gl('Adreno (TM) 730')), real2 = mkResult(gl('Mali-G78'), '2026-11-16T00:00:00.000Z'), unk = mkResult(gl(null)), realGpu = mkResult(wgpu({ vendor: 'qualcomm', architecture: 'adreno-7xx', isFallbackAdapter: false }));
  ok(sw.measurement_class === 'software' && real.measurement_class === 'real_gpu' && unk.measurement_class === 'unknown', 'records carry measurement_class');
  const t = benchTable([real, real2]);
  ok(t.includes('量測類別：real_gpu') && t.includes('Adreno (TM) 730') && t.includes('Mali-G78') && t.split('\n').filter((l) => l.startsWith('| ')).length === 1 + 4, 'two real-GPU results share one table');
  ok(benchTable([sw]).includes('軟體算繪，不是裝置結果') && benchTable([sw]).includes('量測類別：software'), 'a software table is headed 「軟體算繪，不是裝置結果」');
  for (const [a, b, why] of [[sw, real, 'software + real GPU'], [real, unk, 'real GPU + unknown'], [sw, unk, 'software + unknown'], [real, realGpu, 'WebGL 2 + WebGPU (both real GPU)']] as const) {
    assert.throws(() => benchTable([a, b]), MixedMeasurementError, `refuses ${why}`); assert.throws(() => assertComparable([b, a]), MixedMeasurementError); checks += 2;
  }
  // a software result relabelled by hand is refused, alone or with others
  const forged: BenchResult = { ...sw, gpu_class: 'real_gpu', measurement_class: 'real_gpu', label_zh: CLASS_LABEL_ZH.real_gpu };
  assert.throws(() => validateResult(forged), /不一致/); assert.throws(() => benchTable([forged]), /不一致/); assert.throws(() => benchTable([real, forged]), /不一致/); checks += 3;
  assert.throws(() => validateResult({ ...sw, label_zh: '真實 GPU' }), /label_zh/); assert.throws(() => validateResult({ ...real, renderer_api: 'webgpu' }), /renderer_api/); assert.throws(() => validateResult({ ...real, schema: 'x' as typeof BENCH_SCHEMA })); checks += 3;
  ok(benchTable([]) === '' && caseRow(mkCase('sim', 100)).length === TABLE_HEAD.length && caseRow(mkCase('sim', 100))[0].includes('4 個獨立蟻群') && caseRow(mkCase('render', 100))[0].includes('合成資料，非模擬'), 'rows: one cell per column; the mode cell says what the data are');
  const failed: BenchCase = { ...mkCase('sim', 1000), status: 'failed', reason: '狀態框落後 7.0 秒' };
  ok(caseRow(failed)[2].includes('失敗：狀態框落後') && caseRow(failed)[3] === '—', 'a failed case shows its reason and no frame numbers');
  // the Node tool: reads page records and runner files; exit 2 on a mixed table
  ok(readBenchFile(JSON.stringify(real)).gpu_class === 'real_gpu' && readBenchFile(JSON.stringify({ schema: 'antempire.demo2-bench-run.v1', result: sw })).gpu_class === 'software', 'the table tool reads a page record or a runner file');
  assert.throws(() => readBenchFile(JSON.stringify({ schema: 'antempire.demo2-bench-run.v1', result: null, crashed: 'oom' })), /oom/); checks++;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'demo2-bench-')), fa = path.join(tmp, 'sw.json'), fb = path.join(tmp, 'real.json');
  fs.writeFileSync(fa, JSON.stringify(sw)); fs.writeFileSync(fb, JSON.stringify(real));
  const mixed = spawnSync(process.execPath, [path.join(REPO_ROOT, 'cli/demo2-bench-table.ts'), fa, fb], { encoding: 'utf8' });
  ok(mixed.status === 2 && mixed.stdout === '' && mixed.stderr.includes('拒絕合併／比較'), 'cli/demo2-bench-table.ts exits 2 and prints no table for software + real GPU');
  ok(execFileSync(process.execPath, [path.join(REPO_ROOT, 'cli/demo2-bench-table.ts'), fb], { encoding: 'utf8' }).includes('量測類別：real_gpu'), '… and prints the table for one class');
  fs.rmSync(tmp, { recursive: true, force: true });
}

// 3. self-stop rule, world counts, synthetic generator, statistics
{
  const calm = { elapsed_s: 5, heap_mb: 100, heap_limit_mb: 4096, lag_s: 0.2, frame_gap_s: 0.1, worker_error: null };
  ok(watchdog(calm) === null && watchdog({ ...calm, heap_mb: null, heap_limit_mb: null }) === null, 'a healthy case runs on (with or without a heap figure)');
  ok(/落後/.test(watchdog({ ...calm, lag_s: WATCH_LIMITS.lag_s + 0.1 })!) && /沒有更新/.test(watchdog({ ...calm, frame_gap_s: WATCH_LIMITS.frame_gap_s + 0.1 })!) && /heap/.test(watchdog({ ...calm, heap_mb: 4096 * WATCH_LIMITS.heap_fraction + 1 })!) && /Worker/.test(watchdog({ ...calm, worker_error: 'boom' })!), 'late frames, a stalled page, a near-full heap or a Worker failure stop the case with a reason');
  ok(JSON.stringify(BENCH_SIZES) === '[30,100,300,1000]' && WORKERS_PER_WORLD === 30 && BENCH_SIZES.map(worldsFor).join() === '1,4,10,34', 'sizes 30 / 100 / 300 / 1,000 = 1 / 4 / 10 / 34 independent 30-worker worlds');
  let inside = true, moved = 0, maxStep = 0;
  for (let i = 0; i < 1000; i++) {
    let prev = synthPoint(i, 0, 1);
    for (let t = 0.1; t < 40; t += 0.1) {
      const p = synthPoint(i, t, 1); if (p.x < SYNTH_AREA.x0 || p.x > SYNTH_AREA.x1 || p.z < SYNTH_AREA.z0 || p.z > SYNTH_AREA.z1) inside = false;
      const d = Math.hypot(p.x - prev.x, p.z - prev.z); maxStep = Math.max(maxStep, d); if (d > 1e-9) moved++; if (Math.abs(Math.hypot(p.fx, p.fz) - 1) > 1e-9) inside = false; prev = p;
    }
  }
  ok(inside && moved > 200000 && maxStep <= SYNTH_SPEED_CM_S * 0.1 * 1.9, `1,000 synthetic instances stay in their area, move continuously (max step ${maxStep.toFixed(3)} cm per 0.1 s) and have unit headings`);
  ok(JSON.stringify(synthPoint(7, 12.5, 1)) === JSON.stringify(synthPoint(7, 12.5, 1)) && JSON.stringify(synthPoint(7, 12.5, 1)) !== JSON.stringify(synthPoint(7, 12.5, 2)) && synthUnit(1, 2, 3) >= 0 && synthUnit(1, 2, 3) < 1, 'the generator is a pure function of (index, time, seed)');
  ok(Array.from({ length: 400 }, (_, k) => synthPoint(3, k * 0.1, 1).moving).some((m) => !m), 'instances also stand still part of the time');
  const st = frameStats([16, 16, 16, 16, 100], [1, 2, 3, 4, 5]);
  ok(st.frames === 5 && Math.abs(st.fps_mean - 30.49) < 0.01 && st.frame_ms.p50 === 16 && st.frame_ms.max === 100 && st.cpu_ms.p50 === 3 && st.fps_p5_low < st.fps_mean, 'frame statistics: mean fps, p5-low fps, frame-time quantiles');
}

// 4. source scans and the committed results
{
  const bench = read('web/src/demo2/bench.ts'), synth = read('web/src/demo2/bench-synth.ts'), report = read('web/src/demo2/bench-report.ts'), html = read('web/demo2-bench.html'), main = read('web/src/demo2/main.ts');
  const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ok(!/from '/.test(code(synth)) && !/from '/.test(code(report)) && !/Math\.random|Date\.now|performance\.|document\.|window\.|postMessage|worker-client/.test(code(synth)) && !/Math\.random|document\.|window\.|postMessage|worker-client/.test(code(report)), 'the synthetic generator and the report module import nothing and touch no DOM, clock, randomness or Worker');
  ok(SYNTH_LABEL_ZH === '效能測試・合成資料，非模擬' && /mode === 'render' \? SYNTH_LABEL_ZH/.test(bench) && /#mark \{ position: fixed; inset: -20%;/.test(html) && /個互不相干的獨立蟻群（不是一個 \$\{n\} 隻的蟻群）・非正式實驗世界/.test(bench), 'the watermark covers the whole screen: 「效能測試・合成資料，非模擬」 for render-only, independent colonies for full simulation');
  ok(!/session\.ts|save-store|save-format|ExperimentSession|ExperimentSaveStore|indexedDB|localStorage/.test(bench) && !/renderStats|STATE_LABEL|stock_portions|troph_events|colonyOf|roster\(/.test(bench), 'the bench page has no save path and shows no engine statistics');
  const cmds = new Set([...bench.matchAll(/client\.(\w+)\(/g)].map((m) => m[1]));
  ok([...cmds].sort().join() === 'init,setSpeed,start,stepUntil,terminate' && !/sendRaw|postMessage|\.restore\(|\.follow\(|\.snapshot\(/.test(bench), `the bench sends only scheduling commands and terminates its Workers (${[...cmds].join(', ')})`);
  // the render-only source never reaches a Worker: its class has no client, and Workers are created only by SimSource
  const a = bench.indexOf('class SynthSource'), b = bench.indexOf('/** full simulation: ceil(N / 30)');
  ok(a > 0 && b > a && !/client|Worker|frame\b/.test(code(bench.slice(a, b))) && (bench.match(/new ExperimentWorkerClient\(/g) ?? []).length === 1 && bench.indexOf('new ExperimentWorkerClient(') > b, 'render-only instances come from the generator alone; only the full-simulation source starts Workers');
  ok(/isWebGPUBackend === true\) \{ \/\/ the API in use comes from the backend object/.test(bench) && /結果記為 WebGL 2/.test(bench) && /renderer_requested: wantWebGPU \? 'webgpu' : 'webgl2', renderer_api: api/.test(bench), 'the recorded API is the backend that really ran; a WebGPU request that fell back is recorded as WebGL 2');
  ok(/if \(gpuDone && !gpuLost\) void gpuDone\(\)\.then\(\(\) => requestAnimationFrame\(tick\)/.test(bench) && /onSubmittedWorkDone/.test(bench), 'under WebGPU a frame counts only after the GPU queue finished it (no rAF-callback rate passed off as a frame rate)');
  ok(/const why = watchdog\(/.test(bench) && /finally \{[^}]*sim\?\.stop\(\)/.test(bench) && /START_TIMEOUT_S/.test(bench), 'a full-simulation case is watched (start-up included) and its Workers are always terminated');
  ok(!/p0a2-colony-params|params\.json|scenario/.test(bench), 'the bench changes no world parameter or scenario');
  for (const s of ['效能測試', '非正式・不是遊戲世界・不存檔', '一鍵跑完整矩陣', '複製結果 JSON', '純渲染', '完整模擬', '不是一個 N 隻的蟻群', '"three": "./vendor/three/three.module.js"']) ok(html.includes(s), `demo2-bench.html shows 「${s}」`);
  ok(!/https?:\/\/(?!localhost)/.test(html.replace(/<!--[\s\S]*?-->/g, '')), 'no CDN');
  ok(/id="benchLink" href="demo2-bench\.html\?auto=1/.test(main) && /gpuLine\(gpuId\)/.test(main) && /CLASS_LABEL_ZH\[gpuV\(\)\.class\]/.test(main) && /api: rendererKind === 'webgpu' \? 'webgpu' : 'webgl2'/.test(main), 'the 效能 tab shows the GPU identification, its class, and links to the bench page');
  // committed headless results: software, labelled, never presented as a device
  const dir = path.join(REPO_ROOT, 'reports/demo2-bench'), files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')), readme = read('reports/demo2-bench/README.md');
  ok(files.length >= 1 && files.every((f) => f.includes('software')), `committed results are named software (${files.join(', ')})`);
  const byApi = new Map<string, BenchResult[]>();
  for (const f of files) {
    const r = readBenchFile(fs.readFileSync(path.join(dir, f), 'utf8'), f); validateResult(r); byApi.set(r.renderer_api, [...(byApi.get(r.renderer_api) ?? []), r]);
    ok(r.measurement_class === 'software' && r.label_zh === '軟體算繪，不是裝置結果' && r.automated && r.cases.length >= 2 && r.cases.every((c) => c.status === 'ok' || (c.status === 'failed' && !!c.reason)), `${f}: software, labelled, every case completed or failed with a stated reason`);
    ok(readme.includes(f), `README lists ${f}`);
  }
  for (const [k, rs] of byApi) ok(benchTable(rs).includes('量測類別：software'), `the committed ${k} results form one software table`);
  ok(readme.includes('軟體算繪，不是裝置結果') && readme.includes('不能代表') && readme.includes('demo2-bench.html'), 'the README says what the numbers do and do not show');
  ok(read('.github/workflows/ci.yml').includes('tests/browser/demo2-bench.run.cjs') && read('.github/workflows/ci.yml').includes('--smoke') && read('tests/browser/demo2-bench.run.cjs').includes("result.measurement_class === 'software'"), 'CI runs the 30-ant smoke in the optional job and checks the software label');
}

console.log(JSON.stringify({ test: 'demo2-bench', checks }));
