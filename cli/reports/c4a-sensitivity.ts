/**
 * C4a (v2-review.28) diagnostic: one-factor-at-a-time sensitivity of the two game-assumption parameters (feed threshold,
 * bolus size) and the comparison with C3a alone (larvae fed from the colony pool, begging from the colony fraction).
 * Day0 experiment worlds (NOT the official world): foundings A1–A5 × spring / autumn × seeds 1–5 × 180 days, every variant
 * on the same seeds (no seed selection). Every number is a model output under game assumptions; none is a target, none is
 * compared with field data here, and no parameter is chosen from these results (CLAUDE.md §7).
 * Usage: node cli/reports/c4a-sensitivity.ts [outDir]   (default reports/c4a-v28-sensitivity)
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildDay0 } from '../lib/day0.ts';
import { loadBundle, REPO_ROOT } from '../lib/load.ts';
import { ENGINE_VERSION, simulateWorldDay } from '../../engine/index.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const FOUNDINGS = ['A1', 'A2', 'A3', 'A4', 'A5'], SEASONS = { spring: '2027-03-21', autumn: '2027-09-23' } as Record<string, string>, SEEDS = [1, 2, 3, 4, 5], DAYS = 180;
const VARIANTS: { id: string; c4a: boolean; threshold?: number; bolusScale?: number; note: string }[] = [
  { id: 'c3a_only', c4a: false, note: 'C3a on, C4a off: larvae fed from the colony pool; begging from the colony protein fraction (L1, L4 defects present)' },
  { id: 'c4a_default', c4a: true, threshold: 0.3, bolusScale: 1, note: 'C4a defaults (threshold 0.3, bolus = one larval daily need)' },
  { id: 'c4a_threshold_0', c4a: true, threshold: 0, bolusScale: 1, note: 'every contacted larva is fed' },
  { id: 'c4a_threshold_0.6', c4a: true, threshold: 0.6, bolusScale: 1, note: 'only strongly begging larvae are fed' },
  { id: 'c4a_bolus_x0.5', c4a: true, threshold: 0.3, bolusScale: 0.5, note: 'half bolus' },
  { id: 'c4a_bolus_x2', c4a: true, threshold: 0.3, bolusScale: 2, note: 'double bolus' },
];

export function generateC4aSensitivity(outDir: string): Any {
  const base: Any = loadBundle(), sid = Object.keys(base.species)[0], rows: Any[] = [];
  for (const v of VARIANTS) {
    const b: Any = structuredClone(base), sp = b.species[sid];
    sp.queen_feeding.individual_queen_body_c3a = true; sp.larval_feeding.individual_larva_body_c4a = v.c4a;
    if (v.c4a) { sp.larval_feeding.feed_begging_threshold.value = v.threshold; sp.larval_feeding.feed_bolus_sugar_portions.value *= v.bolusScale as number; sp.larval_feeding.feed_bolus_protein_portions.value *= v.bolusScale as number; }
    for (const f of FOUNDINGS) for (const [season, date] of Object.entries(SEASONS)) {
      const acc = { runs: 0, larva_days: 0, larva_days_no_protein: 0, begging_sum: 0, protein_intake_over_need_sum: 0, contacts: 0, feeds: 0, hatch: 0, pupations: 0, eclosions: 0, larva_deaths: 0, workers_end: 0, queen_alive_end: 0, colony_protein_gap_days_ge1: 0 };
      for (const seed of SEEDS) {
        let s: Any = buildDay0(f as Any, seed, date, b).state;
        for (let d = 0; d < DAYS; d++) {
          const o: Any = simulateWorldDay(s, b), ev = o.result.colonies[0].events, c = o.state.colonies[0];
          for (const e of ev) {
            if (e.type === 'larva_nutrition') { acc.larva_days++; acc.begging_sum += e.begging_signal; acc.protein_intake_over_need_sum += e.need_portions.protein > 0 ? e.intake_portions.protein / e.need_portions.protein : 0; if (e.intake_portions.protein === 0) acc.larva_days_no_protein++; }
            if (e.type === 'larva_contact') acc.contacts++;
            if (e.cause === 'feed_larva') acc.feeds++;
            if (e.type === 'hatch') acc.hatch++;
            if (e.type === 'pupation') acc.pupations++;
            if (e.type === 'eclosion') acc.eclosions++;
            if (e.type === 'brood_death' && e.stage === 'larva') acc.larva_deaths++;
          }
          if (!v.c4a) { const L = c.population.brood.filter((x: Any) => x.stage === 'larva'); acc.larva_days += L.length; acc.begging_sum += L.reduce((a: number, x: Any) => a + (x.begging_signal ?? 0), 0); }
          if (c.stores.protein_gap_days >= 1) acc.colony_protein_gap_days_ge1++;
          s = o.state;
        }
        acc.runs++; acc.workers_end += s.colonies[0].population.workers.length; acc.queen_alive_end += s.colonies[0].population.queen_alive ? 1 : 0;
      }
      const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
      rows.push({ variant: v.id, founding: f, season, runs: acc.runs, larva_days: acc.larva_days,
        mean_begging: acc.larva_days ? r6(acc.begging_sum / acc.larva_days) : null,
        share_larva_days_without_protein: v.c4a && acc.larva_days ? r6(acc.larva_days_no_protein / acc.larva_days) : null,
        mean_own_protein_intake_over_need: v.c4a && acc.larva_days ? r6(acc.protein_intake_over_need_sum / acc.larva_days) : null,
        contacts_per_larva_day: v.c4a && acc.larva_days ? r6(acc.contacts / acc.larva_days) : null, feedings: acc.feeds,
        hatch: acc.hatch, pupations: acc.pupations, eclosions: acc.eclosions, larva_deaths: acc.larva_deaths,
        mean_workers_day180: r6(acc.workers_end / acc.runs), queens_alive_day180: acc.queen_alive_end, colony_days_with_protein_gap: acc.colony_protein_gap_days_ge1 });
    }
  }
  const out = { schema: 'antempire.c4a-sensitivity.v1', engine_version: ENGINE_VERSION, official: false, kind: 'experiment_day0_diagnostic', design: { foundings: FOUNDINGS, seasons: SEASONS, seeds: SEEDS, days: DAYS, variants: VARIANTS },
    note: 'Day0 experiment worlds, not the official game. Model outputs under game assumptions; not targets, not field comparisons, not used to choose parameters. Under C3a only, the larval columns that need individual records are null (the larvae have none). Development and starvation still use the old colony-wide rules in every variant (C4b/C4c).', rows };
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'sensitivity.json'), JSON.stringify(out, null, 2) + '\n');
  const cols = ['variant', 'founding', 'season', 'larva_days', 'mean_begging', 'share_larva_days_without_protein', 'mean_own_protein_intake_over_need', 'contacts_per_larva_day', 'pupations', 'eclosions', 'larva_deaths', 'mean_workers_day180', 'queens_alive_day180', 'colony_days_with_protein_gap'];
  const md = ['# C4a 敏感度診斷（v2-review.28，Day0 實驗世界，非正式）', '', '一次改一個遊戲假設參數；所有變體用同一組種子（1～5），A1～A5 × 春／秋 × 180 日。數字是模型輸出，不是目標，不與野外資料比較，也不用來挑參數。發育與飢餓在所有變體中仍是舊的全巢公式（C4b、C4c）。', '',
    '| ' + cols.join(' | ') + ' |', '|' + cols.map(() => '---').join('|') + '|', ...rows.map((r) => '| ' + cols.map((c) => (r[c] === null ? '—' : String(r[c]))).join(' | ') + ' |')].join('\n') + '\n';
  fs.writeFileSync(path.join(outDir, 'sensitivity.md'), md);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) { generateC4aSensitivity(process.argv[2] ?? path.join(REPO_ROOT, 'reports', 'c4a-v28-sensitivity')); console.log('done'); }
