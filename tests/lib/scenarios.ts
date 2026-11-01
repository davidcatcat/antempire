/**
 * Diagnostic scenarios shared by the v6-trace generator (old engine) and the golden test (new engine).
 * Parameter edits are written with LEGACY paths (sim/params.json) and mapped to the split files through
 * each entry's `legacy_path`, so both engines receive exactly the same numeric change.
 */
import type { LegacyV2State, ParamBundle } from '../../engine/index.ts';

export interface Scenario { name: string; seed?: number; days: number; state: (s: LegacyV2State) => void; params: [string, number][] }

const emptyGarden = (s: LegacyV2State) => {
  s.colony.sugar = 0; s.colony.protein = 0;
  for (const site of Object.values(s.sources)) { site.sugar = 0; site.protein = 0; if (site.batches) site.batches = []; if (site.type === 'honeydew') { site.host_plants = 0; site.hemipteran_colonies = 0; site.host_alive = false; } if (site.type === 'nectar') { site.host_alive = false; site.bloom_days_left = 0; site.production_per_day = 0; } }
  s.ecology.adjacent_garden_living_insects = 0; for (const pop of Object.values(s.ecology.insects_by_site)) pop.living = 0;
};

const seeds = Array.from({ length: 20 }, (_, i) => 15032026 + i);
export const SCENARIOS: Scenario[] = [
  ...seeds.map((seed) => ({ name: `baseline-seed-${seed}`, seed, days: 120, state: () => {}, params: [] as [string, number][] })),
  { name: 'no-food-60', days: 60, state: emptyGarden, params: [['sources.insect_background_immigration_probability', 0]] },
  { name: 'sugar-only-1.5x-60', days: 60, state: () => {}, params: [['sources.honeydew_productivity_multiplier', 1.5]] },
  { name: 'abundant-30', days: 30, state: (s) => { s.colony.sugar = 16; s.colony.protein = 8; for (const src of Object.values(s.sources)) if (src.type === 'honeydew' && src.host_alive) (src.production_per_day as number) *= 1.65; s.sources.F08.production_per_day = 0.85; s.sources.F08.bloom_days_left = 30; }, params: [['sources.insect_local_daily_mortality_probability', 0.5], ['sources.honeydew_daily_replenish', 1.2], ['sources.nectar_daily_replenish', 0.85]] },
  { name: 'orphan-larvae-10', days: 10, state: (s) => { s.population.workers = []; s.population.queen_alive = false; s.population.brood = s.population.brood.filter((b) => b.stage === 'larva'); s.colony.sugar = 8; s.colony.protein = 6; }, params: [] },
  { name: 'workerless-queen-starved-20', days: 20, state: (s) => { emptyGarden(s); s.population.workers = []; s.population.brood = []; s.colony.sugar_gap_days = 7; s.colony.protein_gap_days = 7; s.colony.stress_days = 7; }, params: [] },
  { name: 'high-search-scout-5', days: 5, state: (s) => { for (const w of s.population.workers) { w.known_sources = []; w.age_days = 20; } s.population.workers[0].known_sources = ['U01']; }, params: [['workers.scout_discovery_probability', 1], ['workers.forage_baseline_probability', 1000]] },
  { name: 'workers-100-30', days: 30, state: (s) => scale(s, 100), params: [] },
  { name: 'workers-1000-3', days: 3, state: (s) => scale(s, 1000), params: [] },
];

function scale(s: LegacyV2State, size: number) {
  const original = structuredClone(s.population.workers); s.population.workers = [];
  for (let i = 0; i < size; i++) { const w = structuredClone(original[i % 14]); w.id = 'W' + String(i + 4).padStart(3, '0'); w.known_sources = i % 14 === 1 ? ['F01'] : i % 14 === 2 ? ['F11'] : i % 14 === 7 ? ['F07'] : []; s.population.workers.push(w); }
  s.next_worker_number = size + 4; for (const src of Object.values(s.sources)) src.known_by = s.population.workers.filter((w) => w.known_sources.includes(src.id)).map((w) => w.id);
  s.colony.sugar += Math.max(0, size - 14) * 0.5; s.colony.protein += Math.max(0, size - 14) * 0.05;
}

/** Index of split-file parameters by their legacy sim/params.json path. */
export function legacyIndex(bundle: ParamBundle): Map<string, { value: number }> {
  const index = new Map<string, { value: number }>();
  const walk = (node: any) => { if (!node || typeof node !== 'object') return; if ('value' in node && typeof node.legacy_path === 'string') { index.set(node.legacy_path.replace('sim/params.json#', ''), node); return; } for (const v of Object.values(node)) walk(v); }; // eslint-disable-line @typescript-eslint/no-explicit-any
  walk(bundle.world); for (const f of Object.values(bundle.species)) walk(f);
  return index;
}

export function applyNew(bundle: ParamBundle, edits: [string, number][]): void {
  const index = legacyIndex(bundle);
  for (const [path, value] of edits) { const entry = index.get(path); if (!entry) throw Error('no split parameter for legacy path ' + path); entry.value = value; }
}

export function applyOld(params: any, edits: [string, number][]): void { // eslint-disable-line @typescript-eslint/no-explicit-any
  for (const [path, value] of edits) { const [sec, key] = path.split('.'); if (!params[sec]?.[key]) throw Error('no legacy parameter ' + path); params[sec][key].value = value; }
}
