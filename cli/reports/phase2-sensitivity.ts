/**
 * Phase 2 (Owner 2026-11-02): sensitivity of the v17 individual-decision game assumptions — DIAGNOSTIC, NOT A
 * SEARCH FOR A "BEST" VALUE. Every variant is reported on its own; the official parameter files are not changed.
 * Owner decision (PR #34 review): the baseline stays continue_after_failure_probability = 0.5 and
 * recruit_min_crop_fill_fraction = 0.5, kept only as the reference for comparison (both remain 遊戲假設).
 *
 *   one-at-a-time: continue_after_failure_probability ∈ {0.25, 0.5, 0.75, 1.0}
 *                  recruit_min_crop_fill_fraction     ∈ {0.25, 0.5, 0.75, 1.0}
 *                  × A1–A5 × 4 seasons × the 20 fixed seeds × 365 days
 *   grid (A1):     both parameters 4 × 4 × 4 seasons × 20 seeds × 365 days
 *   → 44 distinct jobs × 80 seed rows. Every seed row is kept.
 *
 *   node cli/reports/phase2-sensitivity.ts --run 4      run one new batch in 4 parallel shards, merge, validate
 *   node cli/reports/phase2-sensitivity.ts --validate   validate the committed results (CI runs this through tests)
 *
 * Batches (PR #34 review fix 6): --run creates a fresh batch id and a private work directory; each shard writes
 * its file atomically with the batch id, the configuration hash (rules fingerprint + job list + seeds) and its own
 * job ids. The merge reads ONLY that batch's directory and refuses a missing, failed, extra, foreign-batch or
 * stale-configuration shard, so results of different batches can never be mixed. Any shard exiting non-zero
 * stops the run before merging (exit code 1); the work directory is kept for inspection.
 *
 * Layout (fix 7): sensitivity.json keeps every raw seed row as a positional array (row_columns names them); one
 * row per line, no indentation. Summaries are derived data and are recomputed by --validate.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadBundle, readJson, REPO_ROOT } from '../lib/load.ts';
import { rulesFingerprint } from '../lib/fingerprint.ts';
import { DAY0_SEEDS, runDay0 } from './day0-evaluation.ts';
import { SEASONS, SUPPORTED_FOUNDINGS, type FoundingId } from '../lib/day0.ts';
import { RULES_TAG } from './winter-multiseed.ts';
import { SUSTAINED_REPRODUCTION } from './reproduction-measures.ts';
import { ENGINE_VERSION, type ParamBundle } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SP = 'pheidole-megacephala';
export const OUT = path.join(REPO_ROOT, 'reports/phase2-sensitivity');
export const WORK = path.join(OUT, '.work');
export const SCHEMA = 'antempire.phase2-sensitivity.v2';
export const LEVELS = [0.25, 0.5, 0.75, 1.0];
export const BASELINE = { continue_after_failure_probability: 0.5, recruit_min_crop_fill_fraction: 0.5 } as const;
export const ROWS_PER_JOB = SEASONS.length * DAY0_SEEDS.length;
const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');

export interface Job { id: string; caf: number; rmin: number; founding: FoundingId; kind: 'one-at-a-time' | 'grid' }
export function jobs(): Job[] {
  const out: Job[] = [], seen = new Set<string>();
  const add = (caf: number, rmin: number, founding: FoundingId, kind: Job['kind']) => { const id = `caf${caf}_rmin${rmin}_${founding}`; if (!seen.has(id)) { seen.add(id); out.push({ id, caf, rmin, founding, kind }); } };
  for (const f of SUPPORTED_FOUNDINGS) { for (const v of LEVELS) add(v, 0.5, f, 'one-at-a-time'); for (const v of LEVELS) add(0.5, v, f, 'one-at-a-time'); }
  for (const caf of LEVELS) for (const rmin of LEVELS) add(caf, rmin, 'A1', 'grid');
  return out;
}
export const shardJobs = (i: number, n: number, list = jobs()) => list.filter((_, k) => k % n === i);

/** Raw seed-row columns (positional arrays in the file). Nothing is aggregated away. */
export const ROW_COLUMNS = [
  'season', 'seed', 'queen_alive_365', 'workers_365', 'growth_365', 'max_workers', 'colony_end_day', 'queen_death_day', 'queen_death_reason',
  'any_own_worker_eclosion_365', 'own_eclosions', 'own_eclosion_windows', 'own_eclosions_second_half', 'eggs_last_95_days', 'sustained_reproduction_candidate',
  'eggs_laid', 'own_eclosions_by_30d', 'eggs_laid_by_30d', 'last_own_eclosion_day', 'last_egg_day',
  'trips', 'active_forager_days', 'explorations', 'recruitment', 'sugar_income', 'protein_income', 'sugar_demand', 'protein_demand', 'stop_reasons',
] as const;
type Row = Record<(typeof ROW_COLUMNS)[number], Any>;
export const toArray = (r: Row) => ROW_COLUMNS.map((c) => r[c]);
export const toObject = (a: Any[]): Row => Object.fromEntries(ROW_COLUMNS.map((c, i) => [c, a[i]])) as Row;

/** Parameter bundle of one variant: the official files with the two activity values replaced, nothing else. */
export function variantBundle(j: Pick<Job, 'caf' | 'rmin'>): ParamBundle {
  const b = loadBundle(), act = (b.species[SP] as Any).activity;
  act.continue_after_failure_probability.value = j.caf; act.recruit_min_crop_fill_fraction.value = j.rmin;
  return b;
}
export const variantParamsSha = (b: ParamBundle) => sha(JSON.stringify(b));

export function seedRow(j: Pick<Job, 'founding'>, season: (typeof SEASONS)[number], seed: number, b: ParamBundle): Row {
  const r = runDay0(j.founding, season, seed, b), c = r.checkpoints[365] ?? { extinct: true }, m = r.reproduction;
  return {
    season, seed, queen_alive_365: !c.extinct && !!c.queen, workers_365: c.extinct ? 0 : c.workers, growth_365: c.extinct ? 'extinct' : c.growth,
    max_workers: r.max_workers, colony_end_day: r.colony_end_day, queen_death_day: r.queen_death?.day ?? null, queen_death_reason: r.queen_death?.reason ?? null,
    any_own_worker_eclosion_365: m.any_own_worker_eclosion, own_eclosions: r.own_eclosions, own_eclosion_windows: m.own_eclosion_windows,
    own_eclosions_second_half: m.own_eclosions_second_half, eggs_last_95_days: m.eggs_last_95_days, sustained_reproduction_candidate: m.sustained_reproduction_candidate,
    eggs_laid: r.totals.eggs_laid, own_eclosions_by_30d: r.own_eclosions_by_30d, eggs_laid_by_30d: r.eggs_laid_by_30d, last_own_eclosion_day: r.last_own_eclosion_day, last_egg_day: r.last_egg_day,
    trips: r.totals.trips, active_forager_days: r.activity?.active_worker_days ?? 0, explorations: r.totals.explorations, recruitment: r.totals.recruitment,
    sugar_income: r.totals.income.sugar, protein_income: r.totals.income.protein, sugar_demand: r.totals.demand.sugar, protein_demand: r.totals.demand.protein,
    stop_reasons: r.activity?.stop_reasons ?? {},
  };
}

export function runJob(j: Job): Any {
  const b = variantBundle(j), rows: Any[][] = [];
  for (const season of SEASONS) for (const seed of DAY0_SEEDS) rows.push(toArray(seedRow(j, season, seed, b)));
  return { ...j, variant_params_sha: variantParamsSha(b), rows };
}

/** Everything a batch depends on; a shard made under a different configuration is refused at merge. */
export function configHash(list = jobs()): string {
  const fp = rulesFingerprint(), self = fs.readFileSync(new URL(import.meta.url), 'utf8');
  return sha(JSON.stringify({ schema: SCHEMA, engine: fp.engine, params: fp.params, engine_version: ENGINE_VERSION, jobs: list, seeds: DAY0_SEEDS, seasons: SEASONS, columns: ROW_COLUMNS, script: sha(self), measures: SUSTAINED_REPRODUCTION.id }));
}

// ---------------------------------------------------------------------------------------------- batches
const shardFile = (dir: string, i: number, n: number) => path.join(dir, `shard-${i}-of-${n}.json`);

export function writeShard(dir: string, batch: string, i: number, n: number, list = jobs(), run: (j: Job) => Any = runJob, cfg = configHash(list)): void {
  const mine = shardJobs(i, n, list), done: Any[] = [], t = Date.now();
  for (const j of mine) { done.push(run(j)); console.error(`batch ${batch} shard ${i}/${n}: ${j.id} ${((Date.now() - t) / 1000).toFixed(0)}s`); }
  const f = shardFile(dir, i, n), tmp = `${f}.partial-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ schema: SCHEMA, batch_id: batch, config_hash: cfg, shard: i, of: n, job_ids: mine.map((j) => j.id), complete: true, jobs: done }) + '\n');
  fs.renameSync(tmp, f); // atomic: a crashed shard never leaves a file that looks complete
}

/** Reads one batch directory; throws on anything that is not exactly the n complete shards of `batch`. */
export function mergeShards(dir: string, batch: string, n: number, list = jobs(), cfg = configHash(list)): Any[] {
  const files = fs.readdirSync(dir), errors: string[] = [];
  const partial = files.filter((f) => f.includes('.partial-'));
  if (partial.length) errors.push(`unfinished shard files: ${partial.join(', ')}`);
  const shardNames = files.filter((f) => /^shard-\d+-of-\d+\.json$/.test(f)), want = Array.from({ length: n }, (_, i) => path.basename(shardFile(dir, i, n)));
  const extra = shardNames.filter((f) => !want.includes(f)), missing = want.filter((f) => !shardNames.includes(f));
  if (extra.length) errors.push(`files not belonging to this ${n}-shard batch: ${extra.join(', ')}`);
  if (missing.length) errors.push(`missing shards: ${missing.join(', ')}`);
  const all: Any[] = [];
  for (let i = 0; i < n; i++) {
    if (missing.includes(want[i])) continue;
    const s = JSON.parse(fs.readFileSync(shardFile(dir, i, n), 'utf8')), expect = shardJobs(i, n, list).map((j) => j.id);
    if (s.schema !== SCHEMA) errors.push(`shard ${i}: schema ${s.schema}`);
    if (s.batch_id !== batch) errors.push(`shard ${i}: batch ${s.batch_id} ≠ ${batch} (different batches are never mixed)`);
    if (s.config_hash !== cfg) errors.push(`shard ${i}: configuration hash differs (engine, parameters, job list, seeds or this script changed)`);
    if (s.shard !== i || s.of !== n || s.complete !== true) errors.push(`shard ${i}: header ${s.shard}/${s.of} complete=${s.complete}`);
    const got = (s.jobs as Any[]).map((j) => j.id);
    if (JSON.stringify(got) !== JSON.stringify(expect) || JSON.stringify(s.job_ids) !== JSON.stringify(expect)) errors.push(`shard ${i}: jobs ${got.join(',')} ≠ expected ${expect.join(',')}`);
    all.push(...s.jobs);
  }
  const ids = all.map((j) => j.id), dup = ids.filter((x, k) => ids.indexOf(x) !== k);
  if (dup.length) errors.push(`duplicate jobs: ${dup.join(',')}`);
  if (errors.length) throw Error(`MERGE REFUSED (batch ${batch}):\n - ${errors.join('\n - ')}`);
  return all.sort((a, b) => a.id.localeCompare(b.id));
}

/** Spawns the shard processes; resolves with every exit status. Used by --run and by the tests. */
export function spawnShards(argvFor: (i: number) => string[], n: number): Promise<{ shard: number; code: number | null; signal: string | null }[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => new Promise<{ shard: number; code: number | null; signal: string | null }>((res) => {
    const p = spawn(process.execPath, argvFor(i), { stdio: ['ignore', 'inherit', 'inherit'] });
    p.on('error', () => res({ shard: i, code: null, signal: 'spawn-error' }));
    p.on('exit', (code, signal) => res({ shard: i, code, signal }));
  })));
}
export function assertShardsOk(st: { shard: number; code: number | null; signal: string | null }[]): void {
  const bad = st.filter((s) => s.code !== 0);
  if (bad.length) throw Error(`SHARD FAILURE — not merging: ${bad.map((s) => `shard ${s.shard} exit ${s.code ?? 'none'}${s.signal ? ' signal ' + s.signal : ''}`).join('; ')}`);
}

// ---------------------------------------------------------------------------------------------- summaries
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(3); };
export function summarise(rows: Any[][], season?: string): Any {
  const R = rows.map(toObject).filter((r) => !season || r.season === season);
  const g = R.reduce((o: Any, r) => { o[r.growth_365] = (o[r.growth_365] ?? 0) + 1; return o; }, {});
  const trips = R.reduce((a, r) => a + r.trips, 0), afd = R.reduce((a, r) => a + r.active_forager_days, 0);
  return {
    n: R.length, queen_alive_365: R.filter((r) => r.queen_alive_365).length, colonies_with_workers_365: R.filter((r) => r.workers_365 > 0).length,
    any_own_worker_eclosion_365: R.filter((r) => r.any_own_worker_eclosion_365).length, sustained_reproduction_candidate: R.filter((r) => r.sustained_reproduction_candidate).length,
    growth_365: Object.fromEntries(Object.entries(g).sort()), workers_365_median: med(R.map((r) => r.workers_365)), own_eclosions_median: med(R.map((r) => r.own_eclosions)),
    own_eclosion_windows_median: med(R.map((r) => r.own_eclosion_windows)),
    trips_per_active_forager_day: afd ? +(trips / afd).toFixed(3) : null,
    sugar_income_median: med(R.map((r) => r.sugar_income)), protein_income_median: med(R.map((r) => r.protein_income)),
  };
}
const summaries = (all: Any[]) => Object.fromEntries(all.map((j) => [j.id, { all: summarise(j.rows), by_season: Object.fromEntries(SEASONS.map((s) => [s, summarise(j.rows, s)])) }]));

// ---------------------------------------------------------------------------------------------- file layout
/** Compact but complete: header fields one per line, then one job header per line and one seed row per line. */
export function serialise(doc: Any): string {
  const { jobs: js, summaries: sums, ...head } = doc, L: string[] = ['{'];
  for (const [k, v] of Object.entries(head)) L.push(`${JSON.stringify(k)}:${JSON.stringify(v)},`);
  L.push('"jobs":[');
  js.forEach((j: Any, k: number) => {
    const { rows, ...jh } = j;
    L.push(`${JSON.stringify(jh).slice(0, -1)},"rows":[`);
    rows.forEach((r: Any[], i: number) => L.push(JSON.stringify(r) + (i < rows.length - 1 ? ',' : '')));
    L.push(']}' + (k < js.length - 1 ? ',' : ''));
  });
  L.push('],', '"summaries":{');
  const se = Object.entries(sums);
  se.forEach(([id, s], k) => L.push(`${JSON.stringify(id)}:${JSON.stringify(s)}${k < se.length - 1 ? ',' : ''}`));
  L.push('}', '}');
  return L.join('\n') + '\n';
}

export function buildDoc(all: Any[], batch: string, cfg: string): Any {
  const fp = rulesFingerprint();
  return {
    schema: SCHEMA, diagnostic_not_target: true, no_best_value_selected: true, rules_tag: RULES_TAG, engine_version: ENGINE_VERSION,
    rules_fingerprint: { engine: fp.engine, params: fp.params }, batch_id: batch, config_hash: cfg,
    baseline: BASELINE, baseline_note: 'Owner 2026-11-02：兩者維持 0.5，只作為既有對照基準（遊戲假設），不是已知值，也不是最佳值。',
    seeds: DAY0_SEEDS, seasons: SEASONS, horizon_days: 365, rows_per_job: ROWS_PER_JOB, row_columns: ROW_COLUMNS,
    measures: { any_own_worker_eclosion_365: '年度內曾有自產工蟻羽化（原稱「有效繁殖」）：整個觀察期間 Day1～365 累積的事件，不是 Day365 當天的狀態', queen_alive_365: 'Day365 當天的狀態', workers_365: 'Day365 當天的狀態', growth_365: 'Day365 當天的狀態（相對於 Day0）', sustained_reproduction_candidate: SUSTAINED_REPRODUCTION },
    jobs: all, summaries: summaries(all),
  };
}

// ---------------------------------------------------------------------------------------------- validation
export interface Validation { ok: boolean; errors: string[]; checks: Record<string, Any> }
/**
 * Fix 4: 44 jobs × 80 rows; every (season, seed) present exactly once; no duplicate job or row; row shape;
 * summaries recomputed from the rows; baseline rows identical to the independent v19 Day0 evaluation; engine and
 * parameter fingerprints equal to the current repository; every job's parameter hash = official parameters with
 * only its two values replaced; tables regenerated from the data equal the committed tables.
 */
export function validate(doc: Any, opts: { day0Eval?: Any; tables?: string; current?: { engine: string; params: string } } = {}): Validation {
  const errors: string[] = [], checks: Record<string, Any> = {}, err = (m: string) => errors.push(m);
  const expect = jobs();
  if (doc.schema !== SCHEMA) err(`schema ${doc.schema}`);
  if (JSON.stringify(doc.row_columns) !== JSON.stringify(ROW_COLUMNS)) err('row_columns differ from the script');
  const ids = doc.jobs.map((j: Any) => j.id);
  checks.jobs = ids.length;
  if (ids.length !== expect.length) err(`jobs ${ids.length} ≠ ${expect.length}`);
  if (new Set(ids).size !== ids.length) err('duplicate job ids');
  for (const e of expect) { const j = doc.jobs.find((x: Any) => x.id === e.id); if (!j) { err(`missing job ${e.id}`); continue; } if (j.caf !== e.caf || j.rmin !== e.rmin || j.founding !== e.founding || j.kind !== e.kind) err(`job ${e.id} header differs`); }
  const pairs = new Set(SEASONS.flatMap((s) => DAY0_SEEDS.map((seed) => `${s}:${seed}`)));
  let rowCount = 0, badRows = 0;
  for (const j of doc.jobs) {
    rowCount += j.rows.length;
    if (j.rows.length !== ROWS_PER_JOB) err(`job ${j.id}: ${j.rows.length} rows ≠ ${ROWS_PER_JOB}`);
    const seen = new Set<string>();
    for (const a of j.rows) {
      if (!Array.isArray(a) || a.length !== ROW_COLUMNS.length) { badRows++; continue; }
      const r = toObject(a), k = `${r.season}:${r.seed}`;
      if (!pairs.has(k)) err(`job ${j.id}: unexpected season/seed ${k}`);
      if (seen.has(k)) err(`job ${j.id}: duplicate season/seed ${k}`);
      seen.add(k);
      // internal consistency of each raw row
      if (r.any_own_worker_eclosion_365 !== r.own_eclosions > 0) err(`job ${j.id} ${k}: eclosion flag inconsistent`);
      if (r.own_eclosions_by_30d.reduce((x: number, y: number) => x + y, 0) !== r.own_eclosions) err(`job ${j.id} ${k}: own eclosion bins ≠ total`);
      if (r.eggs_laid_by_30d.reduce((x: number, y: number) => x + y, 0) !== r.eggs_laid) err(`job ${j.id} ${k}: egg bins ≠ total`);
      if (r.sustained_reproduction_candidate !== (r.queen_alive_365 && r.workers_365 > 0 && r.own_eclosions_second_half > 0 && r.eggs_last_95_days > 0)) err(`job ${j.id} ${k}: sustained flag inconsistent`);
    }
    if (seen.size !== pairs.size) err(`job ${j.id}: ${seen.size} distinct season/seed pairs ≠ ${pairs.size}`);
  }
  if (badRows) err(`${badRows} rows with the wrong shape`);
  checks.rows = rowCount; checks.season_seed_pairs_per_job = pairs.size;
  // summaries recomputed
  const re = summaries(doc.jobs), diff = Object.keys(re).filter((id) => JSON.stringify(re[id]) !== JSON.stringify(doc.summaries?.[id]));
  if (diff.length || Object.keys(doc.summaries ?? {}).length !== Object.keys(re).length) err(`stored summaries differ from recomputation: ${diff.join(',') || 'job set'}`);
  checks.summaries_recomputed = Object.keys(re).length - diff.length;
  // fingerprints
  const cur = opts.current ?? (() => { const f = rulesFingerprint(); return { engine: f.engine, params: f.params }; })();
  if (doc.rules_fingerprint?.engine !== cur.engine) err('engine fingerprint ≠ current engine (results are stale: rerun or archive them)');
  if (doc.rules_fingerprint?.params !== cur.params) err('parameter fingerprint ≠ current parameter files (results are stale: rerun or archive them)');
  if (doc.engine_version !== ENGINE_VERSION) err(`engine_version ${doc.engine_version} ≠ ${ENGINE_VERSION}`);
  let shaOk = 0;
  for (const j of doc.jobs) { if (j.variant_params_sha === variantParamsSha(variantBundle(j))) shaOk++; else err(`job ${j.id}: parameter hash differs from official parameters + its two values`); }
  checks.variant_param_hashes_ok = shaOk;
  // baseline = independent Day0 evaluation of the same rules
  if (opts.day0Eval) {
    const E = opts.day0Eval, byKey = new Map(E.runs.map((r: Any) => [`${r.founding}:${r.season}:${r.seed}`, r]));
    if (E.rules_fingerprint?.engine !== doc.rules_fingerprint?.engine || E.rules_fingerprint?.params !== doc.rules_fingerprint?.params) err('Day0 evaluation was made under other rules than the sensitivity data');
    let compared = 0, mismatched = 0;
    for (const j of doc.jobs.filter((x: Any) => x.caf === BASELINE.continue_after_failure_probability && x.rmin === BASELINE.recruit_min_crop_fill_fraction)) {
      for (const a of j.rows) {
        const r = toObject(a), e: Any = byKey.get(`${j.founding}:${r.season}:${r.seed}`);
        if (!e) { err(`baseline ${j.id} ${r.season}:${r.seed} absent from the Day0 evaluation`); continue; }
        const c = e.checkpoints[365] ?? { extinct: true };
        const pairs2: [string, Any, Any][] = [
          ['queen_alive_365', r.queen_alive_365, !c.extinct && !!c.queen], ['workers_365', r.workers_365, c.extinct ? 0 : c.workers], ['own_eclosions', r.own_eclosions, e.own_eclosions],
          ['eggs_laid', r.eggs_laid, e.totals.eggs_laid], ['max_workers', r.max_workers, e.max_workers], ['colony_end_day', r.colony_end_day, e.colony_end_day],
          ['queen_death_day', r.queen_death_day, e.queen_death_day], ['trips', r.trips, e.totals.trips], ['sugar_income', r.sugar_income, e.totals.income.sugar], ['protein_income', r.protein_income, e.totals.income.protein],
          ...(e.own_eclosions_by_30d ? [['own_eclosions_by_30d', JSON.stringify(r.own_eclosions_by_30d), JSON.stringify(e.own_eclosions_by_30d)] as [string, Any, Any]] : []),
        ];
        compared++;
        const bad = pairs2.filter(([, x, y]) => x !== y);
        if (bad.length) { mismatched++; if (mismatched <= 5) err(`baseline ${j.id} ${r.season}:${r.seed} differs from the Day0 evaluation in ${bad.map((b) => b[0]).join(',')}`); }
      }
    }
    if (compared !== SUPPORTED_FOUNDINGS.length * ROWS_PER_JOB) err(`baseline rows compared ${compared} ≠ ${SUPPORTED_FOUNDINGS.length * ROWS_PER_JOB}`);
    checks.baseline_rows_equal_day0_evaluation = `${compared - mismatched}/${compared}`;
  }
  if (opts.tables !== undefined) { const ok = tables(doc) === opts.tables; if (!ok) err('sensitivity-tables.md differs from the tables regenerated from sensitivity.json'); checks.tables_regenerated_equal = ok; }
  return { ok: errors.length === 0, errors, checks };
}

// ---------------------------------------------------------------------------------------------- tables
export function tables(doc: Any): string {
  const S = doc.summaries, J = (f: string, caf: number, rmin: number) => doc.jobs.find((x: Any) => x.founding === f && x.caf === caf && x.rmin === rmin);
  const L = [`# 第二階段：個體決策參數的敏感度（${doc.rules_tag}；診斷，**不挑選最佳值**）`, '',
    `> 每格＝20 種子 × 4 季＝80 次；批次 \`${doc.batch_id}\`；引擎指紋 \`${doc.rules_fingerprint.engine.slice(0, 12)}\`、參數指紋 \`${doc.rules_fingerprint.params.slice(0, 12)}\`。`,
    '> 指標分開列，並註明是**狀態**還是**事件**：蟻后存活、有工蟻、成長分類＝**Day365 當天的狀態**；**年度內曾有自產工蟻羽化**（原稱「有效繁殖」）＝**整個觀察期間（Day1～365）累積的事件**，只要曾發生一次就算，Day365 時蟻群可能已滅亡；**持續繁殖候選**＝Day365 狀態加上後半年的事件。',
    `> 持續繁殖候選定義（遊戲假設，評估用，不是生物學門檻）：${SUSTAINED_REPRODUCTION.rule}。`,
    '> 基準＝兩參數皆 0.5（Owner 2026-11-02 決定只作為既有對照基準）。其他數值並列，不選最佳存活率。', ''];
  const cell = (s: Any) => `${s.queen_alive_365}／${s.colonies_with_workers_365}／${s.any_own_worker_eclosion_365}／${s.sustained_reproduction_candidate}／${s.growth_365.grew ?? 0}·${s.growth_365.held ?? 0}·${s.growth_365.declined ?? 0}·${s.growth_365.no_workers_queen_alive ?? 0}·${s.growth_365.extinct ?? 0}`;
  for (const [param, key] of [['continue_after_failure_probability（空手而回後繼續）', 'caf'], ['recruit_min_crop_fill_fraction（招募門檻）', 'rmin']] as const) {
    const pick = (f: string, v: number) => (key === 'caf' ? J(f, v, 0.5) : J(f, 0.5, v));
    L.push(`## ${param}（另一參數固定 0.5）`, '', '格內：蟻后存活〔Day365 狀態〕／有工蟻〔Day365 狀態〕／曾有自產工蟻羽化〔Day1～365 累積事件〕／持續繁殖候選〔狀態＋事件〕／成長·持平·衰退·只剩蟻后·全滅〔Day365 狀態〕', '', `| 情境 | ${LEVELS.join(' | ')} |`, `|---|${LEVELS.map(() => '---').join('|')}|`);
    for (const f of SUPPORTED_FOUNDINGS) L.push(`| ${f} | ${LEVELS.map((v) => { const j = pick(f, v); return j ? cell(S[j.id].all) : '—'; }).join(' | ')} |`);
    L.push('', `| 情境 | 每隻出巢工蟻每日趟數：${LEVELS.join(' / ')} | 糖收入中位：${LEVELS.join(' / ')} | 有自產羽化的 30 日區間數中位：${LEVELS.join(' / ')} |`, '|---|---|---|---|');
    for (const f of SUPPORTED_FOUNDINGS) { const js = LEVELS.map((v) => pick(f, v)); L.push(`| ${f} | ${js.map((j) => (j ? S[j.id].all.trips_per_active_forager_day ?? '—' : '—')).join(' / ')} | ${js.map((j) => (j ? S[j.id].all.sugar_income_median ?? '—' : '—')).join(' / ')} | ${js.map((j) => (j ? S[j.id].all.own_eclosion_windows_median ?? '—' : '—')).join(' / ')} |`); }
    L.push('');
  }
  L.push('## 交互作用（A1，80 次；Day365 蟻后存活／曾有自產工蟻羽化／持續繁殖候選）', '', `| continue_after_failure ＼ recruit_min | ${LEVELS.join(' | ')} |`, `|---|${LEVELS.map(() => '---').join('|')}|`);
  for (const caf of LEVELS) L.push(`| ${caf} | ${LEVELS.map((rm) => { const j = J('A1', caf, rm); return j ? `${S[j.id].all.queen_alive_365}／${S[j.id].all.any_own_worker_eclosion_365}／${S[j.id].all.sustained_reproduction_candidate}` : '—'; }).join(' | ')} |`);
  L.push('', '## 各季節（A1，continue_after_failure；Day365 蟻后存活／曾有自產工蟻羽化／持續繁殖候選，各 20 次）', '', `| 季節 | ${LEVELS.join(' | ')} |`, `|---|${LEVELS.map(() => '---').join('|')}|`);
  for (const s of SEASONS) L.push(`| ${s} | ${LEVELS.map((v) => { const j = J('A1', v, 0.5); return j ? `${S[j.id].by_season[s].queen_alive_365}／${S[j.id].by_season[s].any_own_worker_eclosion_365}／${S[j.id].by_season[s].sustained_reproduction_candidate}` : '—'; }).join(' | ')} |`);
  L.push('', '## 資料與驗證', '', `- 原始資料：\`sensitivity.json\`，${doc.jobs.length} 組 × ${doc.rows_per_job} 筆種子結果全部保留（每筆一行；欄位見 \`row_columns\`）。`,
    '- 驗證：`node cli/reports/phase2-sensitivity.ts --validate`（CI 由 `tests/phase2-sensitivity.test.ts` 執行，並重跑少量固定種子比對）。');
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------- CLI
const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
export function validateCommitted(): Validation {
  const doc = JSON.parse(fs.readFileSync(path.join(OUT, 'sensitivity.json'), 'utf8'));
  return validate(doc, { day0Eval: readJson(`reports/day0-${doc.rules_tag}/evaluation.json`), tables: fs.readFileSync(path.join(OUT, 'sensitivity-tables.md'), 'utf8') });
}

if (import.meta.main) {
  if (process.argv.includes('--validate')) {
    const v = validateCommitted();
    console.log(JSON.stringify(v, null, 2));
    if (!v.ok) process.exit(1);
  } else if (arg('--shard')) {
    const [i, n] = arg('--shard')!.split('/').map(Number), batch = arg('--batch'), dir = arg('--dir');
    if (!batch || !dir) throw Error('--shard needs --batch and --dir (use --run to start a batch)');
    writeShard(dir, batch, i, n);
  } else if (arg('--run')) {
    const n = Number(arg('--run'));
    if (!(n >= 1)) throw Error('--run N');
    const batch = `${new Date().toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(4).toString('hex')}`, dir = path.join(WORK, batch), cfg = configHash();
    fs.mkdirSync(dir, { recursive: true });
    const others = fs.readdirSync(WORK).filter((d) => d !== batch);
    if (others.length) console.error(`note: ${others.length} other batch directories in ${WORK} are ignored (never merged): ${others.join(', ')}`);
    const self = new URL(import.meta.url).pathname;
    const st = await spawnShards((i) => [self, '--shard', `${i}/${n}`, '--batch', batch, '--dir', dir], n);
    try { assertShardsOk(st); } catch (e) { console.error(String(e), `\nwork directory kept: ${dir}`); process.exit(1); }
    const all = mergeShards(dir, batch, n, jobs(), cfg), doc = buildDoc(all, batch, cfg), text = serialise(doc);
    const v = validate(JSON.parse(text), { day0Eval: readJson(`reports/day0-${RULES_TAG}/evaluation.json`) });
    if (!v.ok) { console.error(JSON.stringify(v, null, 2), `\nVALIDATION FAILED — nothing written; work directory kept: ${dir}`); process.exit(1); }
    fs.writeFileSync(path.join(OUT, 'sensitivity.json'), text);
    fs.writeFileSync(path.join(OUT, 'sensitivity-tables.md'), tables(doc));
    fs.rmSync(dir, { recursive: true });
    console.log(JSON.stringify({ batch, merged_jobs: all.length, validation: v.checks, wrote: OUT }, null, 2));
  } else {
    console.error('usage: --run N | --validate');
    process.exit(2);
  }
}
