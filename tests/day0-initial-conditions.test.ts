/**
 * #202 item 7 (Owner 2026-11-13): fixed PRNG, sampling order and scenario checksum for the Day0 budding candidate
 * (scenarios/day0-budding-candidate.json v2; engine/day0/founding-sampler.ts). 候選／實驗，未經 Owner 啟用批准 —
 * not the #201 GO. No result of any simulation is read here: the checks are about reproducibility and about the
 * sampler honouring the declared ranges and shapes, never about colony outcomes (CLAUDE.md §7).
 *  1. scenario checksum: pinned, independent of key order / whitespace, sensitive to any value change;
 *  2. same (scenario, seed, variant) → byte-identical initial conditions (pinned hash for the baseline seed 20261113);
 *  3. every sampled value lies inside its declared range, for the default and every named variant;
 *  4. distribution shape sanity (log-uniform minors, uniform-integer queens), no tuning;
 *  5. common random numbers: a variant changes only its own factor; the order list is fixed and recorded;
 *  6. brood zero / low / mid / high, fixed entry date, mother-nest boundary, 尚未模擬 labels, #202 two-column record;
 *  7. Worker readiness: deterministic maths only (the module would pass the Worker boundary if allowlisted), but it is
 *     NOT allowlisted or imported by the Worker yet — the save wiring is a separate step;
 *  8. purity and no rules change (outside the rules fingerprint; no wall clock / Math.random).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, ruleFiles } from '../cli/lib/load.ts';
import { loadCandidate } from '../cli/lib/day0-candidate.ts';
import { addDaysIso, canonicalJson, DAY0_PRNG_ID, factorVariants, initialConditionsHash, sampleInitialConditions, scenarioChecksum, unitDraw } from '../engine/day0/founding-sampler.ts';
import { checkBoundary, type Boundary } from './lib/worker-boundary.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const refuses = (fn: () => void, re: RegExp, why: string) => { let msg = ''; try { fn(); } catch (e) { msg = (e as Error).message; } ok(re.test(msg), `${why} (got: ${msg || 'no error'})`); };
const cand = loadCandidate();
const SAMPLER = 'engine/day0/founding-sampler.ts';

// Pinned values. Any change to the candidate file or to the sampler changes them: update them only in a PR that says
// why (a changed checksum is a changed candidate; a changed initial state for an unchanged checksum is a rules change).
const PINNED_SCENARIO_CHECKSUM = 'sha256:2a7e7d0f297461e8e7c66e1b65fceb7495b42decfe34f558352f1d78a1e7d4c6';
const PINNED_BASELINE_IC_HASH = 'sha256:cd715c4781e29f9ddc7d995dfbbf9a1f69d38fe3807854859774700433902bbb';
const BASELINE_SEED = 20261113;

// 1. scenario checksum
const sum = scenarioChecksum(cand);
ok(sum === PINNED_SCENARIO_CHECKSUM, `1: scenario checksum is pinned (${sum})`);
const shuffle = (v: Any): Any => Array.isArray(v) ? v.map(shuffle) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, shuffle(v[k])])) : v;
ok(scenarioChecksum(shuffle(cand)) === sum, '1: checksum is independent of key order');
const rawFile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'scenarios/day0-budding-candidate.json'), 'utf8'));
ok(scenarioChecksum(rawFile) === sum && Object.isFrozen(cand) && Object.isFrozen(cand.fields.queens) && sampleInitialConditions(rawFile, 1).scenario.checksum === sum, '1: the prepared (deeply frozen) candidate carries the checksum of the file as written');
ok(scenarioChecksum(JSON.parse(JSON.stringify(cand, null, 7))) === sum, '1: checksum is independent of file whitespace');
const mutated = structuredClone(cand); mutated.fields.minor_workers.max = 501;
ok(scenarioChecksum(mutated) !== sum, '1: a changed range changes the checksum');
const reordered = structuredClone(cand); reordered.sampling.order = [...cand.sampling.order].reverse();
ok(scenarioChecksum(reordered) !== sum, '1: a changed sampling order changes the checksum (order is part of the scenario)');
refuses(() => canonicalJson({ x: NaN }), /non-finite/, '1: canonical JSON refuses non-finite numbers');
refuses(() => canonicalJson({ x: () => 1 }), /not JSON/, '1: canonical JSON refuses non-JSON values');
ok(canonicalJson({ b: 1, a: [true, null, 'x'] }) === '{"a":[true,null,"x"],"b":1}', '1: canonical JSON form');

// 2. byte-identical initial conditions
const ic0 = sampleInitialConditions(cand, BASELINE_SEED);
ok(canonicalJson(ic0) === canonicalJson(sampleInitialConditions(cand, BASELINE_SEED)), '2: same seed → byte-identical initial conditions');
ok(canonicalJson(ic0) === canonicalJson(sampleInitialConditions(shuffle(cand), BASELINE_SEED)), '2: same scenario with shuffled keys → byte-identical initial conditions');
ok(initialConditionsHash(ic0) === PINNED_BASELINE_IC_HASH, `2: baseline seed ${BASELINE_SEED} initial conditions are pinned (${initialConditionsHash(ic0)})`);
ok(canonicalJson(sampleInitialConditions(reordered, BASELINE_SEED).draws) === canonicalJson(ic0.draws), '2: named streams: values do not depend on the order list (only the recorded order and checksum change)');
ok(ic0.seed === BASELINE_SEED && ic0.seed_is_candidate_baseline && ic0.seed_role === 'reproducibility_identifier' && cand.seed.not_picked === true, '2: baseline seed is recorded as a reproducibility identifier, not a picked seed');
ok(ic0.prng.id === DAY0_PRNG_ID && ic0.scenario.checksum === sum && canonicalJson(ic0.sampling_order) === canonicalJson(cand.sampling.order), '2: the record carries PRNG id, scenario checksum and sampling order');
ok(ic0.activated === false && /#201/.test(ic0.not_go), '2: the record says it is not activated / not the #201 GO');
ok(unitDraw(BASELINE_SEED, 'day0_budding_candidate', 'queens') === unitDraw(BASELINE_SEED, 'day0_budding_candidate', 'queens'), '2: unit draw is a pure function');
ok(new Set([1, 2, 3, 20261113, 20270001].map((s) => canonicalJson(sampleInitialConditions(cand, s).draws))).size === 5, '2: different seeds give different draws');
refuses(() => sampleInitialConditions(cand, 1.5), /seed/, '2: a non-integer seed is refused');

// 3. ranges, for the default and every named variant
const fv = factorVariants(cand);
ok(canonicalJson(fv.queens) === '["range_1_3"]' && canonicalJson([...fv.brood].sort()) === '["high","low","zero"]', '3: declared variants (queens range_1_3; brood zero/low/high around the mid default)');
const configs: Record<string, string>[] = [{}, ...Object.entries(fv).flatMap(([fac, vs]) => vs.map((v) => ({ [fac]: v })))];
const N = 3000, seeds = Array.from({ length: N }, (_, i) => 1000003 + i * 7919);
const spec = (k: string, conf: Record<string, string>) => { const f = cand.fields[k], fac = f.sensitivity_group ?? k, v = conf[fac]; return v && f.sensitivity?.[v] ? { ...f, ...f.sensitivity[v] } : f; };
for (const conf of configs) {
  let bad = 0, nonInt = 0;
  for (const s of seeds) {
    const ic = sampleInitialConditions(cand, s, conf);
    for (const k of Object.keys(cand.fields)) {
      const f = spec(k, conf), v = ic.draws[k];
      if (f.distribution === 'fixed' ? v !== f.value : !(v >= f.min && v <= f.max)) bad++;
      if (f.distribution.endsWith('_int') && !Number.isInteger(v)) nonInt++;
    }
    const c = ic.composition;
    if (![c.queens, c.minor_workers, c.major_workers, c.eggs, c.larvae, c.pupae].every((x) => Number.isInteger(x) && x >= 0)) bad++;
  }
  ok(bad === 0 && nonInt === 0, `3: ${JSON.stringify(conf)}: all ${N} seeds inside the declared ranges, integers where declared (bad ${bad}, non-integer ${nonInt})`);
}

// 4. distribution shape sanity (descriptive bounds from sampling theory, not tuned to any outcome)
const def = seeds.map((s) => sampleInitialConditions(cand, s));
const mw = def.map((x) => x.composition.minor_workers), lnA = Math.log(50), lnB = Math.log(500);
const belowGeo = mw.filter((n) => n <= Math.sqrt(50 * 500)).length / N;
// log-uniform: P(n ≤ √(50·500)) = 0.5 (a linear-uniform 50–500 would give ≈ 0.24); 5σ of a binomial at N=3000 ≈ 0.046
ok(Math.abs(belowGeo - 0.5) < 0.046, `4: minors log-uniform: P(n ≤ geometric mean) = ${belowGeo.toFixed(3)} ≈ 0.5`);
const bins = [0, 0, 0, 0, 0]; for (const n of mw) bins[Math.min(4, Math.floor(((Math.log(n) - lnA) / (lnB - lnA)) * 5))]++;
ok(bins.every((b) => Math.abs(b / N - 0.2) < 0.04), `4: minors flat on the log scale (5 bins: ${bins.map((b) => (b / N).toFixed(3)).join(', ')})`);
ok(Math.min(...mw) >= 50 && Math.max(...mw) <= 500 && Math.min(...mw) <= 52 && Math.max(...mw) >= 490, `4: minors span the declared range (${Math.min(...mw)}–${Math.max(...mw)})`);
const q = def.map((x) => x.composition.queens), q2 = q.filter((x) => x === 2).length / N;
ok(q.every((x) => x === 2 || x === 3) && Math.abs(q2 - 0.5) < 0.046, `4: queens default uniform on {2, 3} (P(2) = ${q2.toFixed(3)})`);
const qs = seeds.map((s) => sampleInitialConditions(cand, s, { queens: 'range_1_3' }).composition.queens);
ok([1, 2, 3].every((k) => Math.abs(qs.filter((x) => x === k).length / N - 1 / 3) < 0.043), '4: queens sensitivity uniform on {1, 2, 3}');
const mf = def.map((x) => x.draws.major_fraction);
ok(Math.abs(mf.reduce((a, b) => a + b, 0) / N - (0.06 + 0.25) / 2) < 0.006, '4: major fraction candidate uniform on 0.06–0.25 (mean)');

// 5. common random numbers
for (const conf of configs.slice(1)) {
  const [fac] = Object.keys(conf);
  for (const s of seeds.slice(0, 200)) {
    const a = sampleInitialConditions(cand, s), b = sampleInitialConditions(cand, s, conf);
    for (const k of Object.keys(cand.fields)) if ((cand.fields[k].sensitivity_group ?? k) !== fac && a.draws[k] !== b.draws[k]) assert.fail(`5: variant ${JSON.stringify(conf)} changed ${k}`);
    assert.equal(a.entry.full_year_sensitivity_date, b.entry.full_year_sensitivity_date);
  }
  checks++;
}
ok(canonicalJson(sampleInitialConditions(cand, 7, { brood: 'mid' })) === canonicalJson(sampleInitialConditions(cand, 7)), '5: brood "mid" is the pre-registered default');
refuses(() => sampleInitialConditions(cand, 7, { brood: 'huge' }), /no variant/, '5: an unknown variant is refused');
refuses(() => sampleInitialConditions(cand, 7, { colony_size: 'high' }), /unknown sensitivity factor/, '5: an unknown factor is refused');
const noOrder = structuredClone(cand); noOrder.sampling.order = cand.sampling.order.filter((k: string) => k !== 'queens');
refuses(() => sampleInitialConditions(noOrder, 7), /sampling\.order/, '5: an order list that misses a field is refused');
const dupOrder = structuredClone(cand); dupOrder.sampling.order = [...cand.sampling.order.slice(1), cand.sampling.order[1]];
refuses(() => sampleInitialConditions(dupOrder, 7), /sampling\.order/, '5: an order list with a duplicate is refused');
const otherPrng = structuredClone(cand); otherPrng.sampling.prng.id = 'mulberry32';
refuses(() => sampleInitialConditions(otherPrng, 7), /PRNG/, '5: another PRNG id is refused');

// 6. #202 items
const lv = (level: string, k: string) => (level === 'mid' ? cand.fields[k].value : cand.fields[k].sensitivity[level].value);
for (const k of ['eggs_per_minor', 'larvae_per_minor', 'pupae_per_minor']) ok(lv('zero', k) === 0 && lv('zero', k) < lv('low', k) && lv('low', k) < lv('mid', k) && lv('mid', k) < lv('high', k), `6: ${k} zero < low < mid < high (pre-registered levels)`);
for (const s of seeds.slice(0, 100)) { const c = sampleInitialConditions(cand, s, { brood: 'zero' }).composition; if (c.eggs + c.larvae + c.pupae !== 0) assert.fail('6: brood zero carries brood'); }
checks++;
ok(cand.scenario_variants.brood.assumption === true && cand.scenario_variants.brood.default_level === 'mid', '6: brood scenarios labelled assumption:true; mid is the pre-registered default');
const fy = seeds.map((s) => sampleInitialConditions(cand, s).entry);
ok(fy.every((e) => e.date === '2026-11-13' && e.timezone === 'Asia/Taipei' && e.rule === 'fixed'), '6: entry date fixed at 2026-11-13 Asia/Taipei for every seed');
ok(fy.every((e) => e.full_year_sensitivity_date >= '2026-11-13' && e.full_year_sensitivity_date <= '2027-11-12'), '6: full-year sensitivity dates within one year from the baseline');
ok(/不是/.test(cand.entry_date.not_optimal_season) && cand.entry_date.assumption === true, '6: entry date is labelled as a test baseline, not the optimal season');
for (const d of [0, 1, 17, 48, 49, 78, 109, 364, 365, 366, 1000, -1, -320]) {
  const ref = new Date(Date.UTC(2026, 10, 13) + d * 86400000).toISOString().slice(0, 10); // test-side reference only
  if (addDaysIso('2026-11-13', d) !== ref) assert.fail(`6: addDaysIso(2026-11-13, ${d}) = ${addDaysIso('2026-11-13', d)} ≠ ${ref}`);
}
ok(addDaysIso('2028-02-28', 1) === '2028-02-29' && addDaysIso('2100-02-28', 1) === '2100-03-01' && addDaysIso('2000-02-28', 1) === '2000-02-29', '6: civil-date arithmetic handles leap years');
ok(ic0.mother_nest.location === 'outside_scene' && ic0.mother_nest.fully_separated && ic0.mother_nest.simulated_exchange === 'none' && /邊界流入/.test(ic0.mother_nest.boundary_inflow) && cand.mother_nest.model_boundary === true, '6: mother nest outside the scene, fully separated, one boundary inflow');
ok(ic0.not_simulated.status === '尚未模擬' && ic0.not_simulated.queens === ic0.composition.queens && ic0.not_simulated.major_workers === ic0.composition.major_workers, '6: queens and majors are recorded as 尚未模擬 (not converted)');
ok(cand.fields.queens.simulation_status === '尚未模擬' && cand.fields.major_fraction.simulation_status === '尚未模擬' && cand.fields.major_fraction.isolated === true, '6: multi-queen and majors labelled 尚未模擬; majors isolated');
ok(cand.simulation_status.not_simulated.some((x: string) => /Worker/.test(x) && /save_meta/.test(x)), '6: the not-simulated list says the candidate is not wired into the Worker save');
const items = cand.owner_ruling_202.items as Any[];
ok(items.length === 8 && items.every((i) => i.provisional && i.before_activation && i.met === false && i.progress), '6: #202 two-column record (provisional / before_activation) for all eight items, none claimed met');
ok(cand.owner_ruling_202.columns.provisional === '暫准開發的假設' && cand.owner_ruling_202.columns.before_activation === '正式啟用前必須滿足', '6: column names match the Owner ruling table');
ok(cand.activation.activated === false && cand.activation.go_issue === '#201', '6: not activated (#201 pending)');

// 7. Worker readiness (deterministic maths) — but not allowlisted / not wired
const B: Boundary & Record<string, Any> = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/continuous-world/worker-boundary.json'), 'utf8'));
const walk = (dir: string): string[] => fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(ts|js|mjs|json)$/.test(e.name) ? [path.join(dir, e.name)] : []) : [];
const files = new Map<string, string>();
for (const d of ['engine', B.worker_entry_dir, 'prototypes/p0a2-24h']) for (const f of walk(path.join(REPO_ROOT, d))) files.set(path.relative(REPO_ROOT, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8'));
ok(!B.allowed_import_prefixes.some((p: string) => SAMPLER.startsWith(p)), '7: the sampler is NOT on the Worker allowlist yet (separate rules PR with the save wiring)');
ok(![...files].some(([f, src]) => f.startsWith(B.worker_entry_dir) && /day0\/founding-sampler/.test(src)), '7: the Worker does not import the sampler yet');
const probe = new Map(files), hypothetical = { ...B, allowed_import_prefixes: [...B.allowed_import_prefixes, 'engine/day0/'] };
probe.set(`${B.worker_entry_dir}/__day0_sampler_probe__.ts`, `import { sampleInitialConditions } from '${path.posix.relative(B.worker_entry_dir, SAMPLER)}';\nexport const p = sampleInitialConditions;`);
const r = checkBoundary(probe, hypothetical);
ok(r.violations.length === 0 && r.reached.includes(SAMPLER), `7: if allowlisted, the sampler passes the Worker boundary incl. deterministic_math_in_worker_graph (${JSON.stringify(r.violations.slice(0, 3))})`);
ok(checkBoundary(probe, B).violations.length > 0, '7: with the current allowlist the same probe is refused (the boundary is not widened here)');
checks += r.checks;

// 8. purity, no rules change
const src = fs.readFileSync(path.join(REPO_ROOT, SAMPLER), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
ok(!/Math\.random|Date\.now|new Date\(|performance\.|Math\.(log|exp|pow|sin|cos)\b/.test(src), '8: no wall clock, no Math.random, no approximated transcendental functions');
ok([...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]).sort().join() === '../clock/detmath.ts,../rng.ts,../sha256.ts', '8: imports only rng, sha256 and detmath');
ok(!ruleFiles().engine.includes(SAMPLER), '8: the sampler is outside the old engine rules fingerprint (no rules change to the daily engine)');
console.log(JSON.stringify({ test: 'day0-initial-conditions', checks }));
