/**
 * #202 candidate Day0 founding (候選／實驗，未經 Owner 啟用批准): a budding propagule of a polygynous population.
 * Reads scenarios/day0-budding-candidate.json, validates its labels, draws a reproducible composition per seed and
 * builds the ENGINE PROJECTION (antempire.day0-founding.v1 document) that the existing Day0 initializer accepts.
 *
 * The projection is NOT the candidate: the engine holds one queen and has no majors, so extra queens and all majors
 * are listed as "not simulated" — never converted into something else. Nothing here reads or writes saves/ or journal/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { hash32 } from '../../engine/index.ts';
import { REPO_ROOT, readJson } from './load.ts';

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- tagged scenario JSON
export const CANDIDATE_FILE = 'scenarios/day0-budding-candidate.json';
export const CANDIDATE_SCHEMA = 'antempire.day0-founding-candidate.v1';
export const CANDIDATE_STATUS = '候選／實驗，未經 Owner 啟用批准';
export const BASES = ['文獻支持', '一般生理學', '遊戲假設'] as const;
export const DISTRIBUTIONS = ['uniform_int', 'log_uniform_int', 'uniform', 'fixed'] as const;
export type Variant = 'default' | 'low' | 'high';
/** Sensitivity factors: a factor is one field, or a group of fields switched together (brood). */
export type Overrides = Record<string, Variant>;

export function loadCandidate(root = REPO_ROOT): Any { return readJson<Any>(CANDIDATE_FILE, root); }

/** Reference IDs defined in docs/references.md (table rows `| Rnnn |`). */
export function referenceIds(root = REPO_ROOT): Set<string> {
  const txt = fs.readFileSync(path.join(root, 'docs/references.md'), 'utf8');
  return new Set([...txt.matchAll(/^\|\s*(R\d+)\s*\|/gm)].map((m) => m[1]));
}

/** Throws on any unlabelled number, unknown basis/distribution, unresolved source or missing separation statement. */
export function validateCandidate(c: Any, refs: Set<string>): void {
  const fail = (m: string) => { throw Error('day0 candidate: ' + m); };
  if (c?.schema !== CANDIDATE_SCHEMA) fail('schema');
  if (c.status !== CANDIDATE_STATUS) fail('status must be ' + CANDIDATE_STATUS);
  for (const [k, f] of Object.entries(c.fields as Record<string, Any>)) {
    if (f.assumption !== true) fail(k + ': assumption must be true');
    if (!BASES.includes(f.basis)) fail(k + ': basis');
    if (!DISTRIBUTIONS.includes(f.distribution)) fail(k + ': distribution');
    if (!Array.isArray(f.sources)) fail(k + ': sources');
    for (const s of f.sources) if (!refs.has(s)) fail(`${k}: source ${s} not in docs/references.md`);
    const nums = f.distribution === 'fixed' ? [f.value] : [f.min, f.max];
    if (nums.some((x) => typeof x !== 'number' || !Number.isFinite(x))) fail(k + ': numbers');
    if (f.distribution !== 'fixed' && f.min > f.max) fail(k + ': min > max');
    if (f.distribution === 'log_uniform_int' && f.min <= 0) fail(k + ': log-uniform needs min > 0');
    if (typeof f.engine_representable !== 'boolean') fail(k + ': engine_representable');
  }
  for (const a of c.alternative_scenarios ?? []) for (const s of a.sources ?? []) if (!refs.has(s)) fail(`alternative ${a.id}: source ${s}`);
  const m = c.mother_nest;
  if (m?.location !== 'outside_scene' || m.fully_separated !== true || m.simulated_exchange !== 'none' || !m.mass_balance || !m.reason) fail('mother_nest must be outside the scene, fully separated, with reason and mass balance');
  if (c.entry_date?.assumption !== true || !BASES.includes(c.entry_date.basis) || c.entry_date.default_rule !== 'uniform_day_of_year' || !Number.isInteger(c.entry_date.year)) fail('entry_date');
}

const unit = (seed: number, key: string) => hash32(`${seed}|day0_budding_candidate|${key}`) / 4294967296;

/** Range used for a field under a variant (sensitivity ranges replace min/max or value). */
function range(f: Any, v: Variant): Any { return v === 'default' ? f : { ...f, ...(f.sensitivity?.[v] ?? {}) }; }

export function draw(f: Any, u: number): number {
  switch (f.distribution) {
    case 'fixed': return f.value;
    case 'uniform_int': return f.min + Math.floor(u * (f.max - f.min + 1));
    case 'log_uniform_int': return Math.round(Math.exp(Math.log(f.min) + u * (Math.log(f.max) - Math.log(f.min))));
    case 'uniform': return f.min + u * (f.max - f.min);
    default: throw Error('unknown distribution ' + f.distribution);
  }
}

/** Factor name of a field for sensitivity (group if present, else the field itself). */
export const factorOf = (c: Any, k: string): string => c.fields[k].sensitivity_group ?? k;
export function sensitivityFactors(c: Any): string[] {
  return [...new Set(Object.keys(c.fields).filter((k) => c.fields[k].sensitivity).map((k) => factorOf(c, k)))];
}

export interface CandidateSample {
  seed: number; variant: Overrides;
  draws: Record<string, number>;
  composition: { queens: number; minor_workers: number; major_workers: number; eggs: number; larvae: number; pupae: number; carried_brood_progress: number; worker_age_days_min: number; worker_age_days_max: number; worker_crop_fill_fraction: number; stores_protein: number };
  entry_date_default_rule: string;
}

/** Reproducible composition for one seed. Overrides switch a factor to its low/high range; other draws are unchanged. */
export function sampleCandidate(c: Any, seed: number, overrides: Overrides = {}): CandidateSample {
  if (!Number.isInteger(seed)) throw Error('seed must be an integer');
  const d: Record<string, number> = {};
  for (const [k, f] of Object.entries(c.fields as Record<string, Any>)) d[k] = draw(range(f, overrides[factorOf(c, k)] ?? 'default'), unit(seed, k));
  const minors = d.minor_workers, fr = d.major_fraction;
  const majors = fr >= 1 ? Infinity : Math.round((fr * minors) / (1 - fr));
  const dayOfYear = Math.floor(unit(seed, 'entry_day') * 365), y = c.entry_date.year;
  return {
    seed, variant: overrides, draws: d,
    composition: { queens: d.queens, minor_workers: minors, major_workers: majors, eggs: Math.round(d.eggs_per_minor * minors), larvae: Math.round(d.larvae_per_minor * minors), pupae: Math.round(d.pupae_per_minor * minors), carried_brood_progress: d.carried_brood_progress, worker_age_days_min: d.worker_age_days_min, worker_age_days_max: d.worker_age_days_max, worker_crop_fill_fraction: d.worker_crop_fill_fraction, stores_protein: d.stores_protein },
    entry_date_default_rule: new Date(Date.UTC(y, 0, 1) + dayOfYear * 86400000).toISOString().slice(0, 10),
  };
}

const tag = (value: number, description: string) => ({ value, assumption: true, basis: '遊戲假設', description, origin: CANDIDATE_FILE + '（抽樣值；候選／實驗，未經 Owner 啟用批准）' });

/**
 * Engine projection of a sample: the antempire.day0-founding.v1 document the existing initializer accepts.
 * Extra queens and all majors are NOT simulated (returned in `not_simulated`), never converted to minors.
 */
export function engineProjection(c: Any, s: CandidateSample): { founding: Any; not_simulated: { queens: number; major_workers: number; reason: string } } {
  const x = s.composition;
  return {
    founding: {
      schema: 'antempire.day0-founding.v1', id: 'BUDCAND', title: '候選分巢單位的引擎投影（候選／實驗，未經 Owner 啟用批准）', species_id: c.species_id, mode: 'budding', engine_supported: true,
      nest_node: c.nest_node, colony_identity: c.colony_identity,
      queens: tag(1, '引擎只能表示一隻蟻后'), workers: tag(x.minor_workers, '遷入小工蟻'),
      worker_age_days_min: tag(x.worker_age_days_min, '遷入工蟻年齡下限'), worker_age_days_max: tag(x.worker_age_days_max, '遷入工蟻年齡上限'),
      worker_caste: 'minor', eggs: tag(x.eggs, '隨行卵'), larvae: tag(x.larvae, '隨行幼蟲'), pupae: tag(x.pupae, '隨行蛹'),
      carried_brood_progress: tag(x.carried_brood_progress, '隨行幼體的階段進度'), worker_crop_fill_fraction: tag(x.worker_crop_fill_fraction, '工蟻嗉囊糖填滿比例'), stores_protein: tag(x.stores_protein, '巢內蛋白存量'),
      injuries: 'none', route_memory: 'empty', known_sources: 'none',
    },
    not_simulated: { queens: x.queens - 1, major_workers: x.major_workers, reason: '引擎狀態只有一隻蟻后、沒有大工蟻（#25）；不換算、不改成小工蟻' },
  };
}
