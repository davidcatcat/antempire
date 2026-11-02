/**
 * Phase 2 (Owner 2026-11-02): sensitivity of the v17 individual-decision game assumptions — DIAGNOSTIC, NOT A
 * SEARCH FOR A "BEST" VALUE. Every variant is reported on its own; the official parameter files are not changed
 * (the baseline stays continue_after_failure_probability = 0.5, recruit_min_crop_fill_fraction = 0.5).
 *
 *   one-at-a-time: continue_after_failure_probability ∈ {0.25, 0.5, 0.75, 1.0}
 *                  recruit_min_crop_fill_fraction     ∈ {0.25, 0.5, 0.75, 1.0}
 *                  × A1–A5 × 4 seasons × the 20 fixed seeds × 365 days
 *   grid (A1):     both parameters 4 × 4 × 4 seasons × 20 seeds × 365 days
 *
 * Every seed of every cell is kept (compact per-seed rows). Run in shards, then merge:
 *   node cli/reports/phase2-sensitivity.ts --shard 0/4   (… 1/4, 2/4, 3/4)
 *   node cli/reports/phase2-sensitivity.ts --merge
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadBundle, REPO_ROOT } from '../lib/load.ts';
import { DAY0_SEEDS, runDay0 } from './day0-evaluation.ts';
import { SEASONS, SUPPORTED_FOUNDINGS, type FoundingId } from '../lib/day0.ts';
import { RULES_TAG } from './winter-multiseed.ts';
import { ENGINE_VERSION } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const SP = 'pheidole-megacephala', OUT = path.join(REPO_ROOT, 'reports/phase2-sensitivity');
const LEVELS = [0.25, 0.5, 0.75, 1.0];
interface Job { id: string; caf: number; rmin: number; founding: FoundingId; kind: 'one-at-a-time' | 'grid' }
function jobs(): Job[] {
  const out: Job[] = [], seen = new Set<string>();
  const add = (caf: number, rmin: number, founding: FoundingId, kind: Job['kind']) => { const id = `caf${caf}_rmin${rmin}_${founding}`; if (!seen.has(id)) { seen.add(id); out.push({ id, caf, rmin, founding, kind }); } };
  for (const f of SUPPORTED_FOUNDINGS) { for (const v of LEVELS) add(v, 0.5, f, 'one-at-a-time'); for (const v of LEVELS) add(0.5, v, f, 'one-at-a-time'); }
  for (const caf of LEVELS) for (const rmin of LEVELS) add(caf, rmin, 'A1', 'grid');
  return out;
}
const med = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return +(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2).toFixed(3); };

function runJob(j: Job): Any {
  const b = loadBundle(), act = (b.species[SP] as Any).activity;
  act.continue_after_failure_probability.value = j.caf; act.recruit_min_crop_fill_fraction.value = j.rmin;
  const rows: Any[] = [];
  for (const season of SEASONS) for (const seed of DAY0_SEEDS) {
    const r = runDay0(j.founding, season, seed, b), c365 = r.checkpoints[365] ?? { extinct: true };
    rows.push({
      season, seed, queen_alive_365: !c365.extinct && !!c365.queen, workers_365: c365.extinct ? 0 : c365.workers,
      effective_reproduction: r.own_eclosions > 0, own_eclosions: r.own_eclosions, eggs_laid: r.totals.eggs_laid,
      growth_365: c365.extinct ? 'extinct' : c365.growth, max_workers: r.max_workers, colony_end_day: r.colony_end_day,
      queen_death: r.queen_death ? { day: r.queen_death.day, reason: r.queen_death.reason } : null,
      trips: r.totals.trips, active_forager_days: r.activity?.active_worker_days ?? 0, explorations: r.totals.explorations, recruitment: r.totals.recruitment,
      sugar_income: r.totals.income.sugar, protein_income: r.totals.income.protein, sugar_demand: r.totals.demand.sugar, protein_demand: r.totals.demand.protein,
      stop_reasons: r.activity?.stop_reasons ?? {},
    });
  }
  return { ...j, rows };
}

function summarise(j: Any, season?: string): Any {
  const R = season ? j.rows.filter((r: Any) => r.season === season) : j.rows;
  const g = R.reduce((o: Any, r: Any) => { o[r.growth_365] = (o[r.growth_365] ?? 0) + 1; return o; }, {});
  const trips = R.reduce((a: number, r: Any) => a + r.trips, 0), afd = R.reduce((a: number, r: Any) => a + r.active_forager_days, 0);
  return {
    n: R.length, queen_alive_365: R.filter((r: Any) => r.queen_alive_365).length, colonies_with_workers_365: R.filter((r: Any) => r.workers_365 > 0).length,
    effective_reproduction: R.filter((r: Any) => r.effective_reproduction).length, growth_365: g,
    workers_365_median: med(R.map((r: Any) => r.workers_365)), own_eclosions_median: med(R.map((r: Any) => r.own_eclosions)),
    trips_per_active_forager_day: afd ? +(trips / afd).toFixed(3) : null,
    sugar_income_median: med(R.map((r: Any) => r.sugar_income)), protein_income_median: med(R.map((r: Any) => r.protein_income)),
  };
}

const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : undefined; };
if (import.meta.main) {
  fs.mkdirSync(OUT, { recursive: true });
  if (process.argv.includes('--merge')) {
    const all: Any[] = [];
    for (const f of fs.readdirSync(OUT).filter((x) => /^shard-\d+\.json$/.test(x)).sort()) all.push(...JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')).jobs);
    const expected = jobs().map((j) => j.id).sort(), got = all.map((j) => j.id).sort();
    if (JSON.stringify(expected) !== JSON.stringify(got)) throw Error('missing shards: ' + expected.filter((x) => !got.includes(x)).join(','));
    all.sort((a, b) => a.id.localeCompare(b.id));
    const doc = { schema: 'antempire.phase2-sensitivity.v1', diagnostic_not_target: true, no_best_value_selected: true, rules_tag: RULES_TAG, engine_version: ENGINE_VERSION, baseline: { continue_after_failure_probability: 0.5, recruit_min_crop_fill_fraction: 0.5 }, seeds: DAY0_SEEDS, seasons: SEASONS, horizon_days: 365, jobs: all.map((j) => ({ ...j, summary: summarise(j), by_season: Object.fromEntries(SEASONS.map((s) => [s, summarise(j, s)])) })) };
    fs.writeFileSync(path.join(OUT, 'sensitivity.json'), JSON.stringify(doc, null, 1) + '\n');
    const L = [`# 第二階段：個體決策參數的敏感度（${RULES_TAG}；診斷，**不挑選最佳值**）`, '',
      '> 每格＝20 種子 × 4 季＝80 次；Day365 的四項指標分開：蟻后存活／有工蟻／有效繁殖（自產卵羽化 ≥1）／成長·持平·衰退·只剩蟻后·全滅。基準（正式參數）＝ 兩者皆 0.5。', ''];
    const cell = (s: Any) => `${s.queen_alive_365}／${s.colonies_with_workers_365}／${s.effective_reproduction}／${s.growth_365.grew ?? 0}·${s.growth_365.held ?? 0}·${s.growth_365.declined ?? 0}·${s.growth_365.no_workers_queen_alive ?? 0}·${s.growth_365.extinct ?? 0}`;
    for (const [param, key, fixed] of [['continue_after_failure_probability（空手而回後繼續）', 'caf', 'rmin'], ['recruit_min_crop_fill_fraction（招募門檻）', 'rmin', 'caf']] as const) {
      L.push(`## ${param}（另一參數固定 0.5）`, '', `| 情境 | ${LEVELS.join(' | ')} |`, `|---|${LEVELS.map(() => '---').join('|')}|`);
      for (const f of SUPPORTED_FOUNDINGS) L.push(`| ${f} | ${LEVELS.map((v) => { const j = doc.jobs.find((x) => x.founding === f && x[key] === v && x[fixed] === 0.5); return j ? cell(j.summary) : '—'; }).join(' | ')} |`);
      L.push('', `| 情境 | 每隻出巢工蟻每日趟數：${LEVELS.join(' / ')} | 糖收入中位：${LEVELS.join(' / ')} |`, '|---|---|---|');
      for (const f of SUPPORTED_FOUNDINGS) { const js = LEVELS.map((v) => doc.jobs.find((x) => x.founding === f && x[key] === v && x[fixed] === 0.5)); L.push(`| ${f} | ${js.map((j) => j?.summary.trips_per_active_forager_day ?? '—').join(' / ')} | ${js.map((j) => j?.summary.sugar_income_median ?? '—').join(' / ')} |`); }
      L.push('');
    }
    L.push('## 交互作用（A1，80 次；Day365 蟻后存活／有效繁殖）', '', `| continue_after_failure ＼ recruit_min | ${LEVELS.join(' | ')} |`, `|---|${LEVELS.map(() => '---').join('|')}|`);
    for (const caf of LEVELS) L.push(`| ${caf} | ${LEVELS.map((rm) => { const j = doc.jobs.find((x) => x.founding === 'A1' && x.caf === caf && x.rmin === rm); return j ? `${j.summary.queen_alive_365}／${j.summary.effective_reproduction}` : '—'; }).join(' | ')} |`);
    L.push('', '## 各季節（A1，continue_after_failure；Day365 蟻后存活／有效繁殖，各 20 次）', '', `| 季節 | ${LEVELS.join(' | ')} |`, `|---|${LEVELS.map(() => '---').join('|')}|`);
    for (const s of SEASONS) L.push(`| ${s} | ${LEVELS.map((v) => { const j = doc.jobs.find((x) => x.founding === 'A1' && x.caf === v && x.rmin === 0.5); return j ? `${j.by_season[s].queen_alive_365}／${j.by_season[s].effective_reproduction}` : '—'; }).join(' | ')} |`);
    fs.writeFileSync(path.join(OUT, 'sensitivity-tables.md'), L.join('\n') + '\n');
    for (const f of fs.readdirSync(OUT).filter((x) => /^shard-\d+\.json$/.test(x))) fs.rmSync(path.join(OUT, f));
    console.log(JSON.stringify({ merged_jobs: all.length, wrote: OUT }, null, 2));
  } else {
    const [i, n] = (arg('--shard') ?? '0/1').split('/').map(Number), list = jobs().filter((_, k) => k % n === i), t = Date.now(), done: Any[] = [];
    for (const j of list) { done.push(runJob(j)); console.error(`shard ${i}/${n}: ${j.id} ${((Date.now() - t) / 1000).toFixed(0)}s`); }
    fs.writeFileSync(path.join(OUT, `shard-${i}.json`), JSON.stringify({ jobs: done }) + '\n');
  }
}
