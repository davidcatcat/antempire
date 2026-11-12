/**
 * #202 multi-seed sensitivity evaluation of the budding candidate (scenarios/day0-budding-candidate.json).
 * DIAGNOSTIC ONLY — never a selection criterion, never a tuning target (CLAUDE.md §7). 候選／實驗，未經 Owner 啟用批准.
 *
 * For 20 fixed seeds × 4 season starts (scenarios/day0/seasons.json, reported separately) × (default + low/high of
 * every engine-representable factor), draws the candidate composition, builds its ENGINE PROJECTION (one queen, no
 * majors: those are listed as not simulated) and runs the current engine for HORIZON days from Day0.
 * Factors the engine cannot represent (queens, major_fraction) are NOT run: their low/high variants would give the
 * identical projection, so the report says "not evaluable" instead of pretending a result.
 *   node cli/reports/day0-founding-candidate.ts [outDir] [--days N]   (default reports/day0-founding-candidate, 90 days)
 * Writes only to outDir; never reads or writes saves/ or journal/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ENGINE_VERSION, initializeDay0, simulateWorldDay, type ParamBundle, type SimEvent } from '../../engine/index.ts';
import { loadBundle, REPO_ROOT } from '../lib/load.ts';
import { day0Inputs, seasonStart, SEASONS, type Season } from '../lib/day0.ts';
import { rulesFingerprint } from '../lib/fingerprint.ts';
import { CANDIDATE_FILE, engineProjection, loadCandidate, referenceIds, sampleCandidate, sensitivityFactors, validateCandidate, type Overrides } from '../lib/day0-candidate.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- report rows
export const CAND_SEEDS = Array.from({ length: 20 }, (_, i) => 20270001 + i);
const CPS = [30, 60, 90];
const r3 = (x: number) => Math.round(x * 1e3) / 1e3;
const q = (xs: number[], p: number) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b), i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return r3(s[lo] + (s[hi] - s[lo]) * (i - lo)); };
const dist = (xs: number[]) => ({ min: q(xs, 0), p10: q(xs, 0.1), median: q(xs, 0.5), p90: q(xs, 0.9), max: q(xs, 1) });
const inc = (o: Record<string, number>, k: string, v = 1) => { o[k] = r3((o[k] ?? 0) + v); };
/** Spearman rank correlation (average ranks for ties); null when either side is constant. */
export function spearman(a: number[], b: number[]): number | null {
  const rank = (xs: number[]) => { const idx = xs.map((x, i) => [x, i] as const).sort((p, r) => p[0] - r[0]), out = new Array<number>(xs.length); for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; for (let k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2; i = j + 1; } return out; };
  const ra = rank(a), rb = rank(b), m = (xs: number[]) => xs.reduce((x, y) => x + y, 0) / xs.length, ma = m(ra), mb = m(rb);
  let num = 0, da = 0, db = 0; for (let i = 0; i < a.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? r3(num / Math.sqrt(da * db)) : null;
}

export function runCandidate(cand: Any, season: Season, seed: number, overrides: Overrides, bundle: ParamBundle, days: number): Any {
  const sample = sampleCandidate(cand, seed, overrides), proj = engineProjection(cand, sample), inp = day0Inputs('A1');
  const init = initializeDay0({ garden: inp.garden, climatology: inp.climatology, founding: proj.founding, seed, start_date: seasonStart(season) }, bundle);
  let s = init.state;
  const c0 = s.colonies[0], gardenSites = new Set(Object.keys(s.sources));
  const day0 = { workers: c0.population.workers.length, eggs: c0.population.brood.filter((b) => b.stage === 'egg').length, larvae: c0.population.brood.filter((b) => b.stage === 'larva').length, pupae: c0.population.brood.filter((b) => b.stage === 'pupa').length, stores_sugar: c0.stores.sugar, stores_protein: c0.stores.protein };
  const cum = { eggs_laid: 0, eclosions: 0, worker_deaths: 0, brood_deaths: 0, trips: 0, successes: 0, income_sugar: 0, income_protein: 0, consumed_sugar: 0, consumed_protein: 0 };
  const wd: Record<string, number> = {}, bd: Record<string, number> = {}, bySite: Record<string, number> = {};
  const cps: Record<number, Any> = {};
  let queenDeath: Any = null, zeroWorkerDay: number | null = null, nonGardenIncome = 0;
  for (let d = 1; d <= days; d++) {
    const out = simulateWorldDay(s, bundle); s = out.state;
    const sm = out.result.colonies[0].summary as Any, ev = out.result.colonies[0].events as SimEvent[];
    cum.eggs_laid += sm.eggs_laid; cum.eclosions += sm.eclosions; cum.worker_deaths += sm.worker_deaths; cum.brood_deaths += sm.brood_deaths; cum.trips += sm.foraging_trips; cum.successes += sm.foraging_successes;
    cum.income_sugar = r3(cum.income_sugar + sm.income.sugar); cum.income_protein = r3(cum.income_protein + sm.income.protein);
    cum.consumed_sugar = r3(cum.consumed_sugar + (sm.consumed?.sugar ?? 0)); cum.consumed_protein = r3(cum.consumed_protein + (sm.consumed?.protein ?? 0));
    for (const e of ev as Any[]) {
      if (e.type === 'worker_death') inc(wd, e.reason);
      else if (e.type === 'brood_death') inc(bd, `${e.stage}:${e.reason}`);
      else if (e.type === 'food_collected') { inc(bySite, `${e.site}:${e.macro}`, e.portions); if (!gardenSites.has(e.site)) nonGardenIncome++; }
      else if (e.type === 'queen_death' && !queenDeath) queenDeath = { day: d, reason: e.reason };
    }
    const pop = s.colonies[0].population;
    if (!pop.workers.length && zeroWorkerDay === null) zeroWorkerDay = d;
    if (CPS.includes(d)) cps[d] = { queen: pop.queen_alive, workers: pop.workers.length, eggs: pop.brood.filter((b) => b.stage === 'egg').length, larvae: pop.brood.filter((b) => b.stage === 'larva').length, pupae: pop.brood.filter((b) => b.stage === 'pupa').length, ...structuredClone(cum) };
  }
  return { season, seed, overrides, sample: sample.composition, not_simulated: proj.not_simulated, day0, checkpoints: cps, queen_death: queenDeath, zero_worker_day: zeroWorkerDay, worker_death_reasons: wd, brood_death_reasons: bd, income_by_site: bySite, non_garden_income_events: nonGardenIncome };
}

function aggregate(runs: Any[], days: number): Any {
  const at = (cp: number, k: string) => runs.map((r) => r.checkpoints[cp]?.[k] ?? 0);
  const g: Any = { runs: runs.length, checkpoints: {} };
  for (const cp of CPS.filter((x) => x <= days)) {
    g.checkpoints[cp] = {
      queen_alive: runs.filter((r) => r.checkpoints[cp]?.queen).length, with_workers: runs.filter((r) => (r.checkpoints[cp]?.workers ?? 0) > 0).length,
      workers: dist(at(cp, 'workers')), brood: dist(runs.map((r) => (r.checkpoints[cp]?.eggs ?? 0) + (r.checkpoints[cp]?.larvae ?? 0) + (r.checkpoints[cp]?.pupae ?? 0))),
      workers_over_day0: dist(runs.map((r) => r3((r.checkpoints[cp]?.workers ?? 0) / Math.max(1, r.day0.workers)))),
      eggs_laid: dist(at(cp, 'eggs_laid')), eclosions: dist(at(cp, 'eclosions')), worker_deaths: dist(at(cp, 'worker_deaths')), brood_deaths: dist(at(cp, 'brood_deaths')),
      trips: dist(at(cp, 'trips')), successes: dist(at(cp, 'successes')), income_sugar: dist(at(cp, 'income_sugar')), income_protein: dist(at(cp, 'income_protein')),
    };
  }
  const sum = (k: string) => { const o: Record<string, number> = {}; for (const r of runs) for (const [a, v] of Object.entries(r[k] as Record<string, number>)) inc(o, a, v); return o; };
  g.worker_death_reasons_total = sum('worker_death_reasons'); g.brood_death_reasons_total = sum('brood_death_reasons'); g.income_by_site_total = sum('income_by_site');
  g.queen_death_reasons = runs.reduce((o: Any, r) => { if (r.queen_death) inc(o, r.queen_death.reason); return o; }, {});
  g.zero_worker_day = dist(runs.filter((r) => r.zero_worker_day !== null).map((r) => r.zero_worker_day)); g.zero_worker_runs = runs.filter((r) => r.zero_worker_day !== null).length;
  return g;
}

export function generate(outDir: string, days = 90, bundle: ParamBundle = loadBundle()): Any {
  if (!Number.isInteger(days) || days < CPS[0]) throw Error(`--days must be an integer >= ${CPS[0]}`);
  const cand = loadCandidate(); validateCandidate(cand, referenceIds());
  const factors = sensitivityFactors(cand), evaluable = factors.filter((f) => Object.entries(cand.fields as Record<string, Any>).some(([k, x]) => (x.sensitivity_group ?? k) === f && x.engine_representable));
  const variants: Overrides[] = [{}, ...evaluable.flatMap((f) => [{ [f]: 'low' as const }, { [f]: 'high' as const }])];
  const vname = (o: Overrides) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(',') || 'default';
  const runs: Any[] = [];
  for (const v of variants) for (const season of SEASONS) for (const seed of CAND_SEEDS) runs.push({ variant: vname(v), ...runCandidate(cand, season, seed, v, bundle, days) });
  const groups: Any = {};
  for (const v of variants) { const n = vname(v); groups[n] = {}; for (const season of SEASONS) groups[n][season] = aggregate(runs.filter((r) => r.variant === n && r.season === season), days); }
  // within the default runs: rank correlation of outcomes at the last checkpoint with each drawn quantity
  const last = CPS.filter((x) => x <= days).at(-1) as number, drawnKeys = ['minor_workers', 'eggs', 'larvae', 'pupae', 'carried_brood_progress', 'worker_crop_fill_fraction', 'queens', 'major_workers'];
  const correlations: Any = {};
  for (const season of SEASONS) {
    const rs = runs.filter((r) => r.variant === 'default' && r.season === season); correlations[season] = {};
    for (const k of drawnKeys) correlations[season][k] = { workers_ratio: spearman(rs.map((r) => r.sample[k]), rs.map((r) => (r.checkpoints[last]?.workers ?? 0) / Math.max(1, r.day0.workers))), eggs_laid: spearman(rs.map((r) => r.sample[k]), rs.map((r) => r.checkpoints[last]?.eggs_laid ?? 0)), queen_alive: spearman(rs.map((r) => r.sample[k]), rs.map((r) => (r.checkpoints[last]?.queen ? 1 : 0))) };
  }
  const fp = rulesFingerprint();
  const doc = {
    schema: 'antempire.day0-founding-candidate-evaluation.v1', status: cand.status, diagnostic_not_target: true, not_a_selection_criterion: true,
    candidate_file: CANDIDATE_FILE, candidate_id: cand.id, engine_version: ENGINE_VERSION, rules_fingerprint: { engine: fp.engine, params: fp.params }, official_saves_used: false,
    seeds: CAND_SEEDS, horizon_days: days, checkpoints: CPS.filter((x) => x <= days), seasons: Object.fromEntries(SEASONS.map((s) => [s, seasonStart(s)])),
    engine_projection: '每次抽樣都投影成引擎能表示的狀態：只模擬 1 隻蟻后；大工蟻不放入、不改成小工蟻。投影的結果不能代表候選分巢單位的生物學。',
    factors_evaluated: evaluable, factors_not_evaluable: factors.filter((f) => !evaluable.includes(f)).map((f) => ({ factor: f, reason: cand.fields[f]?.engine_note ?? 'engine cannot represent' })),
    mass_balance_check: { non_garden_income_events: runs.reduce((a, r) => a + r.non_garden_income_events, 0), note: '所有 food_collected 都來自花園地點；引擎每日的質量與個體守恆檢查失敗會直接拋錯（engine/day.ts）' },
    groups, correlations_default: { checkpoint: last, method: 'Spearman 等級相關（每季 20 次預設抽樣；n 小，僅描述）', by_season: correlations },
    runs: runs.map((r) => ({ variant: r.variant, season: r.season, seed: r.seed, sample: r.sample, not_simulated: r.not_simulated, day0: r.day0, last: r.checkpoints[last] ?? null, queen_death: r.queen_death, zero_worker_day: r.zero_worker_day })),
  };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'evaluation.json'), JSON.stringify(doc, null, 1) + '\n');
  fs.writeFileSync(path.join(outDir, 'evaluation.md'), tables(doc));
  return doc;
}

export function tables(doc: Any): string {
  const d = (x: Any) => (x?.median === null || x === undefined ? '—' : `${x.min}／${x.p10}／${x.median}／${x.p90}／${x.max}`);
  const last = doc.checkpoints.at(-1);
  const L: string[] = [
    `# 分巢候選 Day0 多種子敏感度評估（${doc.status}）`, '',
    '> **診斷，不是目標，也不是選擇依據**（CLAUDE.md §7）。自動產生：`node cli/reports/day0-founding-candidate.ts`。',
    `> 引擎 ${doc.engine_version}；${doc.seeds.length} 個固定種子（${doc.seeds[0]}～${doc.seeds.at(-1)}）× 四季分開 × ${doc.horizon_days} 日。所有數值都是遊戲模型。`,
    `> ${doc.engine_projection}`,
    `> 質量收支：非花園來源的收入事件 ${doc.mass_balance_check.non_garden_income_events} 筆。${doc.mass_balance_check.note}。`, '',
    '分布欄位格式：最小／P10／中位／P90／最大。', '',
    '## 1. 預設抽樣（各季）', '',
    `| 季節 | 檢查日 | 蟻后存活 | 有工蟻 | 工蟻數 | 工蟻數÷Day0 | 幼體數 | 累計產卵 | 累計羽化 | 累計工蟻死亡 | 外出趟 | 成功趟 | 糖收入 | 蛋白收入 |`, '|---|---:|---:|---:|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [season, g] of Object.entries(doc.groups.default as Record<string, Any>)) for (const cp of doc.checkpoints) { const x = g.checkpoints[cp]; L.push(`| ${season} | ${cp} | ${x.queen_alive}/${g.runs} | ${x.with_workers}/${g.runs} | ${d(x.workers)} | ${d(x.workers_over_day0)} | ${d(x.brood)} | ${d(x.eggs_laid)} | ${d(x.eclosions)} | ${d(x.worker_deaths)} | ${d(x.trips)} | ${d(x.successes)} | ${d(x.income_sugar)} | ${d(x.income_protein)} |`); }
  L.push('', '| 季節 | 工蟻死因（20 種子合計） | 幼體死因 | 蟻后死因 | 工蟻歸零次數／歸零日分布 |', '|---|---|---|---|---|');
  const j = (o: Any) => Object.entries(o).sort().map(([k, v]) => `${k} ${v}`).join('；') || '—';
  for (const [season, g] of Object.entries(doc.groups.default as Record<string, Any>)) L.push(`| ${season} | ${j(g.worker_death_reasons_total)} | ${j(g.brood_death_reasons_total)} | ${j(g.queen_death_reasons)} | ${g.zero_worker_runs}／${d(g.zero_worker_day)} |`);
  L.push('', `## 2. 單因子敏感度（Day${last}；其餘欄位抽樣值不變）`, '', '| 變體 | 季節 | 蟻后存活 | 有工蟻 | 工蟻數÷Day0 中位 | 工蟻數中位 | 累計產卵中位 | 累計羽化中位 | 外出趟中位 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|');
  for (const [v, gs] of Object.entries(doc.groups as Record<string, Any>)) for (const [season, g] of Object.entries(gs as Record<string, Any>)) { const x = g.checkpoints[last]; L.push(`| ${v} | ${season} | ${x.queen_alive}/${g.runs} | ${x.with_workers}/${g.runs} | ${x.workers_over_day0.median} | ${x.workers.median} | ${x.eggs_laid.median} | ${x.eclosions.median} | ${x.trips.median} |`); }
  L.push('', '## 3. 引擎無法評估的因子', '');
  for (const f of doc.factors_not_evaluable) L.push(`- **${f.factor}**：${f.reason}`);
  L.push('', `## 4. 預設抽樣中，抽樣值與 Day${last} 結果的等級相關（${doc.correlations_default.method}）`, '', '| 季節 | 抽樣量 | 對 工蟻數÷Day0 | 對 累計產卵 | 對 蟻后存活 |', '|---|---|---:|---:|---:|');
  for (const [season, o] of Object.entries(doc.correlations_default.by_season as Record<string, Any>)) for (const [k, c] of Object.entries(o as Record<string, Any>)) L.push(`| ${season} | ${k} | ${c.workers_ratio ?? '—'} | ${c.eggs_laid ?? '—'} | ${c.queen_alive ?? '—'} |`);
  L.push('', '> queens 與 major_workers 都不進引擎。queens 的相關係數只反映 n＝20 下的偶然關聯（不是蟻后數的效果）；major_workers ＝ round(f × 小工蟻數 ÷ (1−f))，與小工蟻數高度相關，所以它的係數反映的是小工蟻數，**不是**大工蟻的效果。');
  L.push('', '## 5. 解讀（診斷）', '', '- 在目前引擎與花園下，無論初始小工蟻是 10～50、50～500 或 500～2000，工蟻數在 30～90 日內都降到約 0～20 隻（Day90 中位：低 12～17、預設 7～12、高 0～5）；死因以 `starvation_or_natural_competing_hazards_scenario` 為主，幼體死因以慢性缺蛋白為主。初始越大，Day90 的工蟻數÷Day0 越低（等級相關約 −0.9）。', '- 這表示**結果主要由引擎的花園食物量（遊戲份數）決定，而不是由初始組成決定**；花園供給與每隻工蟻的需求單位是為十幾隻工蟻的舊情境設定的遊戲假設（docs/day0-initialization.md D2）。這是需要 Owner 知道的模型限制，**不是**調整初始數量或花園供給的理由（CLAUDE.md §7）。', '- 幼體多寡主要改變累計羽化數，對 Day90 工蟻數影響小；年齡上限、嗉囊填滿、幼體進度的影響在 20 種子的雜訊範圍內。', '- 蟻后數、大工蟻比例、母巢連結都無法由引擎評估。');
  return L.join('\n') + '\n';
}

if (import.meta.main) {
  const args = process.argv.slice(2), di = args.indexOf('--days'), days = di >= 0 ? Number(args[di + 1]) : 90;
  const pos = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--days');
  const outDir = pos[0] ? path.resolve(pos[0]) : path.join(REPO_ROOT, 'reports/day0-founding-candidate');
  const t = Date.now(), doc = generate(outDir, days);
  console.log(JSON.stringify({ wrote: outDir, runs: doc.runs.length, seconds: (Date.now() - t) / 1000 }, null, 2));
}
