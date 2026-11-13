/**
 * Rules update detmath-exp (Owner ruling #190 scheme A extended to exp / log / **): LIVE cross-environment sweep of the
 * deterministic math of engine/clock/detmath.ts — detExp, detLog, detPow, detPowInt and detSin / detCos (the weather
 * reconstruction uses detSin) — in Node (the TypeScript source the verifier runs) vs a real Chromium page vs a Chromium
 * module Worker (the BUILT file web/worker-dist/engine/clock/detmath.js that the experiment Worker imports).
 * FAILS (exit 1) unless every output bit pattern is identical in all three environments. No tolerance.
 *   npm run web:build && node cli/web-serve.ts 8781 &  node tests/browser/detmath-xenv.check.cjs <outDir> http://localhost:8781/
 * For contrast (recorded, not asserted as a failure): how many of the same inputs give different bits for the engine's
 * own Math.exp / Math.log / Math.pow / Math.sin between Node and Chromium (the reason for this rules update).
 * Verified environments are whatever this run reports (CI: x86-64 Linux); ARM64 / Firefox / Safari are NOT verified.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');

/** deterministic inputs: uniform ranges, random bit patterns over every exponent (incl. subnormals), edge values */
function inputs() {
  let s = 0x9e3779b9;
  const u32 = () => { s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return (t ^ (t >>> 14)) >>> 0; };
  const u = () => u32() / 4294967296;
  const dv = new DataView(new ArrayBuffer(8));
  const bits = (hiMask = 0x7fffffff) => { dv.setUint32(0, u32() & hiMask); dv.setUint32(4, u32()); return dv.getFloat64(0); };
  const edge = [NaN, Infinity, -Infinity, 0, -0, 1, -1, 2, 0.5, 5e-324, -5e-324, 2.2250738585072014e-308, 2.225073858507201e-308, 1.7976931348623157e308, -1.7976931348623157e308,
    709.782712893384, 709.7827128933841, -745.1332191019411, -745.1332191019412, -708.3964185322641, -708.4, 1e-300, -1e-300, 3.725290298461914e-9, 1.4901161193847656e-8,
    0.34657359027997264, 0.3465735902799727, 1.0397207708399179, -0.34657359027997264, 1 + 2 ** -52, 1 - 2 ** -53, Math.SQRT2, Math.SQRT1_2, Math.E, Math.PI];
  const exp = [...edge], log = [...edge], pow = [], trig = [];
  for (let i = 0; i < 100000; i++) exp.push((u() - 0.5) * 1500);             // whole finite range and beyond
  for (let i = 0; i < 40000; i++) exp.push((u() - 0.5) * 2);                // |x| < 1 (reduction boundaries)
  for (let i = 0; i < 20000; i++) exp.push((u() - 0.5) * 60);               // the P0-A2 range: -b·n/Z, 17.27·T/(T+237.3)
  for (let i = 0; i < 20000; i++) exp.push((u() < 0.5 ? -1 : 1) * bits(0x3fffffff)); // tiny magnitudes, all exponents < 0
  for (let i = 0; i < 100000; i++) log.push(bits());                          // every positive exponent incl. subnormals
  for (let i = 0; i < 40000; i++) log.push(1 - u());                          // (0, 1]: the P0-A2 bout-length draw 1 − g()
  for (let i = 0; i < 20000; i++) log.push(1 + (u() - 0.5) * 1e-5);           // near 1 (|f| < 2^-20 branch)
  for (let i = 0; i < 5000; i++) log.push(-u() * 10);                         // negatives → NaN
  for (let i = 0; i < 40000; i++) pow.push([u() * 2, u() < 0.5 ? 2 : 1 + Math.floor(u() * 6)]); // hill: s^n, integer n
  for (let i = 0; i < 40000; i++) pow.push([u() * 100, (u() - 0.5) * 8]);   // non-integer exponents
  for (let i = 0; i < 40000; i++) trig.push(u() * Math.PI);                   // weather day branch: sin(π·x), x ∈ [0, 1]
  for (let i = 0; i < 20000; i++) trig.push((u() - 0.5) * 2000);
  return { exp, log, pow, trig };
}

/** evaluated identically in Node and in the browser (page and Worker); returns hex bit patterns */
const RUN_SRC = `(m, I, withMath) => {
  const dv = new DataView(new ArrayBuffer(8));
  // ECMAScript has ONE NaN value; its bit pattern is implementation-defined and is not preserved when inputs cross
  // into the browser (structured clone canonicalises it), so every NaN is recorded as 'NaN' (a NaN is still a NaN)
  const hex = (v) => { if (v !== v) return 'NaN'; dv.setFloat64(0, v); return dv.getUint32(0).toString(16).padStart(8, '0') + dv.getUint32(4).toString(16).padStart(8, '0'); };
  const safe = (f) => { try { return hex(f()); } catch (e) { return 'throw:' + String(e && e.message).slice(0, 40); } };
  const out = {
    detExp: I.exp.map((x) => safe(() => m.detExp(x))),
    detLog: I.log.map((x) => safe(() => m.detLog(x))),
    detPow: I.pow.map(([x, y]) => safe(() => m.detPow(x, y))),
    detPowInt: I.pow.filter(([, y]) => Number.isInteger(y)).map(([x, y]) => safe(() => m.detPowInt(x, y))),
    detSin: I.trig.map((x) => safe(() => m.detSin(x))),
    detCos: I.trig.map((x) => safe(() => m.detCos(x))),
  };
  if (withMath) out.math = { exp: I.exp.map((x) => hex(Math.exp(x))), log: I.log.map((x) => hex(Math.log(x))), pow: I.pow.map(([x, y]) => hex(Math.pow(x, y))), sin: I.trig.map((x) => hex(Math.sin(x))) };
  return out;
}`;

(async () => {
  const out = process.argv[2] || 'detmath-shots', base = process.argv[3] || 'http://localhost:8781/';
  fs.mkdirSync(out, { recursive: true });
  const failures = [], passed = [], errors = [], info = {};
  const check = (c, m) => { process.stderr.write(`${c ? 'ok  ' : 'FAIL'} ${m}\n`); if (c) passed.push(m); else failures.push(m); };
  const I = inputs();
  const run = eval(RUN_SRC);
  const nodeMod = await import(pathToFileURL(path.join(ROOT, 'engine/clock/detmath.ts')).href);
  const node = run(nodeMod, I, true);
  // the built file the experiment Worker imports must be the compiled source (types stripped only)
  const builtUrl = new URL('worker-dist/engine/clock/detmath.js', base).href;

  const browser = await chromium.launch();
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(new URL('experiment.html', base).href);
  const br = await page.evaluate(async ({ RUN_SRC, I, builtUrl }) => {
    const run = (0, eval)(RUN_SRC);
    const m = await import(builtUrl);
    const pageOut = run(m, I, true);
    const src = `import * as m from ${JSON.stringify(builtUrl)};\nconst run = ${RUN_SRC};\nonmessage = (e) => postMessage(run(m, e.data, true));`;
    const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })), { type: 'module' });
    const workerOut = await new Promise((res, rej) => { w.onmessage = (e) => res(e.data); w.onerror = (e) => rej(new Error(String(e.message))); w.postMessage(I); });
    w.terminate();
    return { pageOut, workerOut, ua: navigator.userAgent };
  }, { RUN_SRC, I, builtUrl });
  info.chromium = browser.version(); info.node = process.version; info.platform = `${process.platform}-${process.arch}`;
  await browser.close();

  const digest = (arr) => crypto.createHash('sha256').update(arr.join('\n')).digest('hex');
  info.functions = {};
  for (const f of ['detExp', 'detLog', 'detPow', 'detPowInt', 'detSin', 'detCos']) {
    const n = node[f], p = br.pageOut[f], w = br.workerOut[f];
    let dp = 0, dw = 0; for (let i = 0; i < n.length; i++) { if (n[i] !== p[i]) dp++; if (n[i] !== w[i]) dw++; }
    const ex = []; for (let i = 0; i < n.length && ex.length < 5; i++) if (n[i] !== p[i] || n[i] !== w[i]) ex.push({ i, node: n[i], page: p[i], worker: w[i] });
    info.functions[f] = { examples: ex, inputs: n.length, differing_node_vs_page: dp, differing_node_vs_worker: dw, digest: digest(n).slice(0, 16) };
    check(n.length > 1000 && p.length === n.length && w.length === n.length && dp === 0 && dw === 0, `${f}: ${n.length} inputs, Node = Chromium page = Chromium module Worker bit for bit (0 / 0 differing; digest ${digest(n).slice(0, 12)}…)`);
  }
  // contrast: the engines' own implementation-approximated functions on the same inputs (recorded, not required)
  info.math_builtin_node_vs_chromium = {};
  for (const f of ['exp', 'log', 'pow', 'sin']) {
    const n = node.math[f], p = br.pageOut.math[f], w = br.workerOut.math[f];
    let dp = 0, dw = 0; for (let i = 0; i < n.length; i++) { if (n[i] !== p[i]) dp++; if (n[i] !== w[i]) dw++; }
    info.math_builtin_node_vs_chromium[`Math.${f}`] = { inputs: n.length, differing_node_vs_page: dp, differing_node_vs_worker: dw };
  }
  info.arm64 = '未驗證（沒有 ARM64 執行環境）'; info.firefox_safari = '未驗證';
  check(errors.length === 0, `no page or console errors (${errors.slice(0, 3).join(' | ')})`);
  fs.writeFileSync(path.join(out, 'detmath-xenv-results.json'), JSON.stringify({ info, passed: passed.length, failed: failures }, null, 1));
  console.log(JSON.stringify({ test: 'detmath-xenv-browser', passed: passed.length, failed: failures, info }, null, 1));
  if (failures.length) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
