/**
 * BP-1 multi-seed runs of every variant in bp1-variants.json inside the P0-A2 world (Node tool; not imported by
 * anything; not in the blocking tests — tests/bp1-brood.test.ts covers the mechanisms). Writes only reports/bp1-brood/.
 *
 *   node prototypes/brood-physiology/bp1-report.ts run <variant> [--seeds 20] [--days 40]   → reports/bp1-brood/runs/<variant>.json
 *   node prototypes/brood-physiology/bp1-report.ts summarize                                → reports/bp1-brood/results.json + tables.md
 *
 * Every seed of every variant is written and summarised (no selection). Seeds are 1..N, fixed before any run.
 * The zero_supply group runs the same world with the honeydew amount, the initial crop fill and the initial larval gut
 * fill set to 0 in an in-memory copy of the parameter file (an edge case, not a stored variant; the larvae never receive
 * food). Horizons (fixed before any run): p0a2_food 30 d, zero_supply 35 d, counterfactual_protein 40 d.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import raw from '../p0a2-24h/params.json' with { type: 'json' };
import cand from './brood-physiology.candidates.json' with { type: 'json' };
import variants from '../p0a2-24h/brood/bp1-variants.json' with { type: 'json' };
import { World } from '../p0a2-24h/world.ts';
import { bp1Hook } from '../p0a2-24h/brood/bp1.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(ROOT, 'reports', 'bp1-brood');
const D = 86_400_000, SC = 'taichung-march-ref';
const arg = (k: string, d: number) => { const i = process.argv.indexOf(k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const r2 = (x: number) => Math.round(x * 100) / 100;
const STG = ['egg', 'L1', 'L2', 'L3', 'prepupa', 'pupa', 'adult', 'dead'];

function runOne(name: string, seed: number, days: number) {
  const hook = bp1Hook(cand, variants, name), group = (variants as any).variants[name].group as string;
  const params = JSON.parse(JSON.stringify(raw));
  // zero supply: no honeydew and nothing stored at Day0 (empty crops, empty larval guts) — the larvae never receive food
  if (group === 'zero_supply') for (const k of ['honeydew_amount_portions', 'initial_crop_fill_max', 'initial_larva_gut_fill_max']) params.parameters[k].value = 0;
  const w = World.create(params, SC, seed, { brood: hook });
  let consOk = true;
  for (let d = 1; d <= days; d++) { w.advanceTo(d * D); if (!w.conservation().ok) consOk = false; }
  const v = w.projectedView(), c = w.conservation();
  const larvae = Object.values(v.larvae).map((l: any) => {
    const b = l.bp;
    return {
      id: l.id, stage: b.stage, stage_entry_d: Object.fromEntries(Object.entries(b.stage_entry).map(([k, x]) => [k, r2((x as number) / D)])),
      fed_sugar_ng: b.fed_sugar_ng, fed_protein_ng: b.fed_protein_ng, structure_ng: b.protein_ng.structure ?? 0, reserve_sugar_ng: b.sugar_ng.reserve ?? 0, reserve_protein_ng: b.protein_ng.reserve ?? 0,
      maintenance_uj: b.energy_uj.maintenance ?? 0, growth_uj: b.energy_uj.growth_cost ?? 0, unmet_ng: b.unmet_ng, deficit_d: r2(b.deficit_ms / D), max_bout_d: r2(b.max_bout_ms / D),
      limit_d: Object.fromEntries(Object.entries(b.limit_ms).map(([k, x]) => [k, r2((x as number) / D)])), feeds: b.feeds, bridged_up: b.bridged_up, death: b.death,
    };
  });
  return { seed, conservation_every_day: consOk, conservation_end: c, larva_feeds: w.stats().larva_feeds, log_sha256: w.logHash, state_sha256: w.stateHash(), larvae };
}

if (process.argv[2] === 'run') {
  const name = process.argv[3]; if (!(variants as any).variants[name]) throw Error(`unknown variant ${name}`);
  const HORIZON: Record<string, number> = { p0a2_food: 30, zero_supply: 35, counterfactual_protein: 40 };
  const seeds = arg('--seeds', 20), days = arg('--days', HORIZON[(variants as any).variants[name].group]);
  const t0 = Date.now(), runs = [];
  for (let s = 1; s <= seeds; s++) runs.push(runOne(name, s, days));
  const hook = bp1Hook(cand, variants, name);
  fs.mkdirSync(path.join(OUT, 'runs'), { recursive: true });
  fs.writeFileSync(path.join(OUT, 'runs', `${name}.json`), JSON.stringify({ variant: name, group: (variants as any).variants[name].group, label: (variants as any).variants[name].label, config_sha256: hook.config_sha, config: hook.config, seeds: Array.from({ length: seeds }, (_, i) => i + 1), days, scenario: SC, official: false, label_zh: '研究候選（隔離、預設關閉；非正式實驗世界）', runs, seconds: (Date.now() - t0) / 1000 }, null, 1) + '\n');
  console.log(`${name}: ${seeds} seeds × ${days} d in ${(Date.now() - t0) / 1000} s`);
} else if (process.argv[2] === 'summarize') {
  const files = fs.readdirSync(path.join(OUT, 'runs')).filter((f) => f.endsWith('.json')).sort();
  const order = Object.keys((variants as any).variants);
  const rows: any[] = [];
  for (const f of files.sort((a, b) => order.indexOf(a.replace('.json', '')) - order.indexOf(b.replace('.json', '')))) {
    const R = JSON.parse(fs.readFileSync(path.join(OUT, 'runs', f), 'utf8'));
    const L = R.runs.flatMap((r: any) => r.larvae), n = L.length;
    const stages = Object.fromEntries(STG.map((s) => [s, L.filter((x: any) => x.stage === s).length]).filter(([, k]) => (k as number) > 0));
    const q = (xs: number[]) => { const a = xs.filter((x) => Number.isFinite(x)).sort((p, r) => p - r); return a.length ? [r2(a[0]), r2(a[Math.floor((a.length - 1) / 2)]), r2(a[a.length - 1])] : null; };
    const adult = q(L.map((x: any) => x.stage_entry_d.adult ?? NaN)), pupa = q(L.map((x: any) => x.stage_entry_d.pupa ?? NaN)), l2 = q(L.map((x: any) => x.stage_entry_d.L2 ?? NaN));
    const dead = q(L.map((x: any) => x.stage_entry_d.dead ?? NaN));
    const mean = (k: (x: any) => number) => r2(L.reduce((a: number, x: any) => a + k(x), 0) / n);
    rows.push({
      variant: R.variant, group: R.group, label: R.label, seeds: R.seeds.length, larvae: n, days: R.days, config_sha256: R.config_sha256,
      all_conserved: R.runs.every((r: any) => r.conservation_every_day && r.conservation_end.ok), stages_at_end: stages,
      L2_entry_d_min_med_max: l2, pupa_entry_d_min_med_max: pupa, adult_d_min_med_max: adult, death_d_min_med_max: dead,
      mean_limit_d: { P: mean((x) => x.limit_d.P), E_growth: mean((x) => x.limit_d.E_growth), E_deficit: mean((x) => x.limit_d.E_deficit), none: mean((x) => x.limit_d.none) },
      mean_fed_sugar_ug: r2(mean((x) => x.fed_sugar_ng) / 1000), mean_fed_protein_ug: r2(mean((x) => x.fed_protein_ng) / 1000), mean_unmet_ug: r2(mean((x) => x.unmet_ng) / 1000),
      mean_reserve_sugar_ug: r2(mean((x) => x.reserve_sugar_ng) / 1000), mean_max_bout_d: mean((x) => x.max_bout_d), mean_feeds: mean((x) => x.feeds),
      per_seed: R.runs.map((r: any) => ({ seed: r.seed, conserved: r.conservation_every_day && r.conservation_end.ok, larva_feeds: r.larva_feeds, stages: r.larvae.map((x: any) => x.stage).join(','), adult_d: r.larvae.map((x: any) => x.stage_entry_d.adult ?? null), dead_d: r.larvae.map((x: any) => x.stage_entry_d.dead ?? null), log_sha256: r.log_sha256 })),
    });
  }
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ schema: 'antempire.bp1-results.v1', official: false, note: '每個變體的每個種子全部列出（per_seed），沒有挑選；數字是模型在假設下的行為，不是目標或驗證。', rows }, null, 1) + '\n');
  const fmt = (x: any) => (x === null ? '—' : Array.isArray(x) ? x.join(' / ') : String(x));
  let md = '| 變體 | 群組 | 種子×幼蟲 | 期末齡期（隻數） | 全守恆 | 進 L2（日，最小／中位／最大） | 化蛹（日） | 羽化（日） | 死亡（日） | 平均蛋白限制（日） | 平均能量成長限制（日） | 平均維持未付（日） | 平均餵入糖（µg） | 平均餵入蛋白（µg） | 平均未付維持（µg） |\n|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|\n';
  for (const r of rows) md += `| ${r.variant} | ${r.group} | ${r.seeds}×${r.larvae / r.seeds} | ${Object.entries(r.stages_at_end).map(([k, x]) => `${k} ${x}`).join('、')} | ${r.all_conserved ? '是' : '**否**'} | ${fmt(r.L2_entry_d_min_med_max)} | ${fmt(r.pupa_entry_d_min_med_max)} | ${fmt(r.adult_d_min_med_max)} | ${fmt(r.death_d_min_med_max)} | ${r.mean_limit_d.P} | ${r.mean_limit_d.E_growth} | ${r.mean_limit_d.E_deficit} | ${r.mean_fed_sugar_ug} | ${r.mean_fed_protein_ug} | ${r.mean_unmet_ug} |\n`;
  let seedMd = '| 變體 | 種子 | 守恆 | 照護餵食次數 | 8 隻幼蟲期末齡期 | 羽化日（每隻） | 死亡日（每隻） |\n|---|---|---|---|---|---|---|\n';
  for (const r of rows) for (const s of r.per_seed) seedMd += `| ${r.variant} | ${s.seed} | ${s.conserved ? '是' : '**否**'} | ${s.larva_feeds} | ${s.stages} | ${s.adult_d.map((x: any) => x ?? '—').join(' ')} | ${s.dead_d.map((x: any) => x ?? '—').join(' ')} |\n`;
  fs.writeFileSync(path.join(OUT, 'tables.md'), `<!-- 由 prototypes/brood-physiology/bp1-report.ts summarize 產生；不要手改 -->\n\n## 變體彙總\n\n${md}\n## 每個種子（全部列出）\n\n${seedMd}`);
  console.log(`summarised ${rows.length} variants`);
} else console.log('usage: report.ts run <variant> [--seeds N] [--days D] | summarize');
