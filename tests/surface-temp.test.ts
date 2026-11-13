/**
 * SURF-0 (Owner ruling #213 Q2 b): simple ground / substrate surface-temperature CANDIDATE model
 * (engine/clock/surface-temperature.ts; docs/surface-temperature-model.md). BLOCKING.
 *  1. provenance: every coefficient in prototypes/surface-temp/params.json carries value / assumption / basis / sources /
 *     note; only the physical constant is assumption:false; 文獻支持 coefficients cite R-IDs registered in references.md;
 *     unknown night sky cooling stays null (not invented).
 *  2. determinism: two runs are bit-identical (digest), and the module uses no implementation-approximated Math function
 *     (exp, log, pow, sin, cos, ...), only basic operations and ./solar.ts / ./detmath.ts.
 *  3. comparison proxy kept: every record carries the input air temperature unchanged; records are labelled model
 *     values (kind 'model', measured false, 模型值（非實測）).
 *  4. monotone sanity: daytime surface temperature decreases with shade (0 > 0.5 > 1); at night (sun below horizon) the
 *     target equals air and the surface relaxes toward air; GHI is 0 with the sun down.
 *  5. bounds: implicit Euler keeps T_s inside the hull of the targets seen so far; T_target ≥ air when no night offset.
 *  6. isolation: no colony / individual state; nothing official and nothing in the Worker graph imports it; outside the
 *     rules fingerprint (tests/clock-isolation.test.ts covers engine/clock as a whole too).
 *  7. refusals: bad shade / step / coefficient values are refused; an unknown air temperature gives null, then re-init.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, ruleFiles } from '../cli/lib/load.ts';
import { sha256Hex } from '../engine/sha256.ts';
import { checkParams, ghiModel, runSurface, targetC, type SurfaceParams } from '../engine/clock/surface-temperature.ts';
import { ANCHOR, SITE, at, loadParams, run, withCoef } from '../prototypes/surface-temp/bench.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const throws = (f: () => unknown, why: string) => { assert.throws(f, why); checks++; };
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// 1. provenance
const P = loadParams(), FILE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/surface-temp/params.json'), 'utf8'));
const REFS = fs.readFileSync(path.join(REPO_ROOT, 'docs/references.md'), 'utf8');
ok(FILE.label_zh === '模型值（非實測）' && /非正式/.test(FILE.status), 'params file is labelled model values / non-official');
const BASES = new Set(['文獻支持', '一般生理學', '遊戲假設', '物理常數']);
for (const [k, c] of Object.entries(P) as [string, SurfaceParams[keyof SurfaceParams]][]) {
  ok(typeof c.assumption === 'boolean' && BASES.has(c.basis) && Array.isArray(c.sources) && c.note.length > 10, `${k}: provenance complete (${c.basis})`);
  ok(c.assumption === true || (k === 'stefan_boltzmann' && c.basis === '物理常數'), `${k}: assumption:true unless a physical constant`);
  if (c.basis === '文獻支持') { ok(c.sources.length > 0, `${k}: 文獻支持 cites a source`); for (const s of c.sources) ok(new RegExp(`\\| ${s} \\|`).test(REFS), `${k}: ${s} is registered in docs/references.md`); }
  if (c.basis === '遊戲假設') ok(c.sources.length === 0, `${k}: 遊戲假設 cites no paper as if it supported the value`);
}
ok(P.night_offset_k.value === null, 'unknown night sky cooling stays null (not modelled, not invented)');
checkParams(P); checks++;

// 2. determinism
const digest = (rs: unknown) => sha256Hex(JSON.stringify(rs));
const a1 = run('hot', 0), a2 = run('hot', 0);
ok(digest(a1) === digest(a2), 'two runs are bit-identical');
const MOD = path.join(REPO_ROOT, 'engine/clock/surface-temperature.ts'), src = strip(fs.readFileSync(MOD, 'utf8'));
ok(!/Math\.(exp|expm1|log|log1p|log2|log10|pow|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|cbrt|hypot)\b|\*\*/.test(src), 'surface model uses no implementation-approximated Math function or **');
for (const m of src.matchAll(/from\s+'([^']+)'/g)) ok(['./solar.ts', './time-frames.ts', './detmath.ts'].includes(m[1]), `surface model imports only clock modules (${m[1]})`);

// 3. proxy kept, labels
const s = (await import('../prototypes/surface-temp/bench.ts')).series('hot');
ok(a1.every((r) => r.air_temp_proxy_c === s.temperature(r.day, r.minute).value), 'every record carries the input air temperature unchanged (comparison proxy)');
ok(a1.every((r) => r.kind === 'model' && r.measured === false && r.label === '模型值（非實測）'), 'every record is labelled a model value, not a measurement');
ok(a1.length === 2 * 1440 / 5 && a1.filter((r) => r.reinitialised).length === 1 && a1[0].reinitialised, 'one record per step; state initialised once (at 00:00 of the first day)');

// 4. monotone sanity
for (const w of ['cool', 'hot'] as const) {
  const r0 = run(w, 0), r5 = run(w, 0.5), r1 = run(w, 1);
  for (const m of [600, 720, 780, 900]) {
    const v = [r0, r5, r1].map((r) => at(r, 2, m).surface_temp_model_c!);
    ok(v[0] > v[1] && v[1] > v[2], `${w} ${m} min: shade lowers daytime surface temperature (${v.map((x) => x.toFixed(2)).join(' > ')})`);
    ok(v[2] >= at(r1, 2, m).air_temp_proxy_c! - 1e-9, `${w} ${m} min: full shade still ≥ air by day (diffuse part kept)`);
  }
  for (const r of r0) if (r.solar_altitude_deg <= 0) { ok(r.ghi_model_wm2 === 0 && r.target_c === r.air_temp_proxy_c, 'sun down: GHI 0 and target = air'); }
  // night relaxation: after sunset the gap to air shrinks toward 0
  const g = (m: number, d = 2) => Math.abs(at(r0, d, m).surface_temp_model_c! - at(r0, d, m).air_temp_proxy_c!);
  ok(g(1140) > g(1260) && g(1260) > g(1435) * 0.999 && g(1435) < 1, `${w}: after sunset |T_s − air| shrinks (19:00 ${g(1140).toFixed(2)} → 21:00 ${g(1260).toFixed(2)} → 23:55 ${g(1435).toFixed(2)})`);
  ok(g(240) < 0.5, `${w}: before dawn the surface is within 0.5 K of air (${g(240).toFixed(3)})`);
}
// shade monotone over a finer grid and the clearness factor
let prev = Infinity; for (const sh of [0, 0.25, 0.5, 0.75, 1]) { const v = targetC(P, 30, 70, sh).target_c; ok(v < prev, `target strictly decreasing in shade (${sh})`); prev = v; }
ok(targetC(withCoef(P, 'sky_clearness', 0), 30, 70, 0).target_c === 30, 'sky clearness 0: target = air');
ok(ghiModel(P, -5) === 0 && ghiModel(P, 1) === 0 && ghiModel(P, 90) === 880, 'GHI form: 0 with the sun down or very low (form negative); 910 − 30 at zenith');

// 5. bounds
for (const r of [run('hot', 0), run('cool', 0.5), run('hot', 1, withCoef(P, 'tau_min', 90))]) {
  let lo = Infinity, hi = -Infinity;
  for (const x of r) { lo = Math.min(lo, x.target_c!, x.air_temp_proxy_c!); hi = Math.max(hi, x.target_c!); ok(x.surface_temp_model_c! >= lo - 1e-9 && x.surface_temp_model_c! <= hi + 1e-9, 'T_s stays inside the hull of air and targets so far'); ok(x.target_c! >= x.air_temp_proxy_c!, 'no night offset: target ≥ air'); }
}
const off = withCoef(P, 'night_offset_k', 1.5);
ok(targetC(off, 20, -3, 0).target_c === 18.5 && targetC(off, 20, 30, 0).target_c > 20, 'an explicit night offset acts only with the sun down');

// 6. isolation
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
const users = [...walk(path.join(REPO_ROOT, 'engine')), ...walk(path.join(REPO_ROOT, 'cli')), ...walk(path.join(REPO_ROOT, 'web/src')), ...walk(path.join(REPO_ROOT, 'prototypes/continuous-world'))]
  .filter((f) => f !== MOD && /surface-temperature/.test(strip(fs.readFileSync(f, 'utf8'))));
ok(users.length === 0, `nothing official, no engine module and nothing in the Worker graph imports the surface model (${users.map((f) => path.relative(REPO_ROOT, f)).join(', ') || 'none'})`);
ok(ruleFiles().engine.every((f) => !f.includes('surface')), 'outside the rules fingerprint');
ok(!/colon(y|ies)|worker|brood|queen|larva|\bcrop\b|forag|nestmate|sugar|protein|need|hunger|species/i.test(src.replace(/'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''")), 'surface model names no colony-side state, need or species');

// 7. refusals and gaps
throws(() => run('hot', 1.2), 'shade > 1 refused');
throws(() => runSurface(P, { anchor: ANCHOR, site: SITE, shade: 0, step_min: 7, first_day: 1, last_day: 1 }, () => 25), 'step must divide 1440');
throws(() => checkParams(withCoef(P, 'albedo', 1.5)), 'albedo > 1 refused');
throws(() => checkParams(withCoef(P, 'tau_min', null)), 'null time constant refused');
throws(() => checkParams({ ...P, h_conv_wm2k: { ...P.h_conv_wm2k, basis: '' } }), 'missing provenance refused');
const gap = runSurface(P, { anchor: ANCHOR, site: SITE, shade: 0, step_min: 60, first_day: 1, last_day: 1 }, (_d, m) => (m === 600 ? null : 25));
ok(gap[10].surface_temp_model_c === null && gap[11].reinitialised && gap[11].surface_temp_model_c === 25, 'unknown air temperature → null record, next known value re-initialises (no value invented across the gap)');

console.log(JSON.stringify({ test: 'surface-temp', checks, digest_hot_sun: digest(a1).slice(0, 16) }));
