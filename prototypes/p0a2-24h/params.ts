/**
 * P0-A2 phase 2 — parameter validation and the derived model constants. The raw parameter object is the content of
 * prototypes/p0a2-24h/params.json (read by the caller; this module does no I/O). Every value must carry its evidence
 * class (this_species / other_species_extrapolated / game_assumption); non-measured values carry assumption: true;
 * other-species values name the species. No species name is used as a branch anywhere: the model sees numbers only.
 */
import { sha256Hex } from '../../engine/sha256.ts';
import { type CalendarAnchor, checkAnchor } from '../../engine/clock/time-frames.ts';
import { type SolarSite, checkSite } from '../../engine/clock/solar.ts';
import { canon } from './canon.ts';
import { type DecisionConsts, EVIDENCE_CLASSES } from './types.ts';

export const THIS_SPECIES = 'Pheidole megacephala';
const REF_RE = /^R\d+$/;
const fail = (m: string): never => { throw Error(`P0A2_PARAMS: ${m}`); };

/** the two variant maps: diagnostic sensitivity scenarios, and the isolated Q2 retention experiment (Owner #193) */
export const VARIANT_SECTIONS = ['sensitivity_variants', 'q2_retention_variants'] as const;
/** every variant name of a raw parameter file, per section */
export const variantNames = (raw: any, sec: (typeof VARIANT_SECTIONS)[number]): string[] => Object.keys(raw?.[sec] ?? {}).filter((k) => k !== '_note');

type Entry = { value: unknown; evidence_class: string; assumption: boolean; basis: string; sources: string[]; species?: string; extrapolation_limit?: string; note?: string };
/** every entry that holds a value (parameters, site values, scenario dates) with its path */
export function valueEntries(raw: any): [string, Entry][] {
  const out: [string, Entry][] = [];
  for (const [k, v] of Object.entries(raw.parameters ?? {})) out.push([`parameters.${k}`, v as Entry]);
  for (const [k, v] of Object.entries(raw.site ?? {})) if (k !== 'zone') out.push([`site.${k}`, v as Entry]);
  for (const [s, sc] of Object.entries(raw.weather_scenarios ?? {})) out.push([`weather_scenarios.${s}.day0_date`, (sc as any).day0_date]);
  for (const sec of VARIANT_SECTIONS) for (const [n, va] of Object.entries(raw[sec] ?? {})) if (n !== '_note') for (const [k, e] of Object.entries((va as any).overrides ?? {})) out.push([`${sec}.${n}.${k}`, e as Entry]);
  return out;
}

/** all evidence-labelling problems of a raw parameter object (empty = complete) */
export function evidenceProblems(raw: any): string[] {
  const p: string[] = [];
  if (raw?.official !== false) p.push('official must be false');
  if (typeof raw?.reference_variant !== 'string' || !variantNames(raw, 'sensitivity_variants').includes(raw.reference_variant)) p.push('reference_variant must name a sensitivity variant');
  const seen = new Set<string>();
  for (const sec of VARIANT_SECTIONS) for (const n of variantNames(raw, sec)) {
    if (seen.has(n)) p.push(`variant ${n} is defined twice`); seen.add(n);
    const va = raw[sec][n];
    if (typeof va?.label !== 'string' || !va.label) p.push(`${sec}.${n}: label required`);
    if (typeof va?.status !== 'string' || !va.status) p.push(`${sec}.${n}: status required (reference or sensitivity, and what it is not)`);
  }
  for (const [path, e] of valueEntries(raw)) {
    if (!e || typeof e !== 'object' || !('value' in e)) { p.push(`${path}: not a labelled value`); continue; }
    if (!EVIDENCE_CLASSES.includes(e.evidence_class as never)) p.push(`${path}: evidence_class ${e.evidence_class} not in ${EVIDENCE_CLASSES.join('/')}`);
    if (typeof e.assumption !== 'boolean') p.push(`${path}: assumption must be true/false`);
    if (typeof e.basis !== 'string' || !e.basis) p.push(`${path}: basis required`);
    if (!Array.isArray(e.sources) || !e.sources.every((s) => typeof s === 'string' && REF_RE.test(s))) p.push(`${path}: sources must be reference ids (R…)`);
    // only a definition may be non-assumption; nothing in this prototype is a direct field measurement
    if (e.assumption !== true && e.basis !== '定義') p.push(`${path}: a non-measured value must carry assumption: true`);
    if (e.evidence_class === 'this_species') {
      if (e.species !== THIS_SPECIES) p.push(`${path}: this_species needs species "${THIS_SPECIES}"`);
      if (!e.sources?.length) p.push(`${path}: this_species needs a source id`);
      if (!e.extrapolation_limit) p.push(`${path}: this_species value needs its extrapolation_limit`);
    }
    if (e.evidence_class === 'other_species_extrapolated') {
      if (typeof e.species !== 'string' || !e.species || e.species === THIS_SPECIES) p.push(`${path}: other_species_extrapolated must name the other species`);
      if (!e.sources?.length) p.push(`${path}: other_species_extrapolated needs a source id`);
      if (!e.extrapolation_limit) p.push(`${path}: other_species_extrapolated needs its extrapolation_limit`);
    }
  }
  for (const [s, sc] of Object.entries(raw?.weather_scenarios ?? {}) as [string, any][]) {
    if (sc.synthetic !== true || sc.assumption !== true || sc.evidence_class !== 'game_assumption') p.push(`weather_scenarios.${s}: synthetic weather must carry synthetic: true, assumption: true, evidence_class game_assumption`);
    if (!sc.generator || !sc.source_data) p.push(`weather_scenarios.${s}: generator and source_data required`);
    if (!Array.isArray(sc.hourly_temp_c) || sc.hourly_temp_c.length !== 24 || !sc.hourly_temp_c.every((x: unknown) => typeof x === 'number' && Number.isFinite(x))) p.push(`weather_scenarios.${s}: 24 finite hourly temperatures required (null days are not supported: refuse, do not fill)`);
  }
  return p;
}

export interface Model {
  params_sha: string; scenario: string;
  anchor: CalendarAnchor; site: SolarSite; hourly_temp_c: number[]; rh_mean_percent: number | null; synthetic: true; weather_generator: string;
  workers: number; larvae: number; init_crop_max: number; init_gut_max: number;
  crop_cap: number; worker_rate: number; larva_rate: number; gut_cap: number;
  travel_ms: number; move_ms: number; fill_ms_full: number; recruit_min_fill: number; max_trophallaxis: number;
  theta_forage: [number, number]; theta_brood: [number, number]; gain: [number, number];
  window_ms: number; nest_contact_p: number; larva_contact_p: number; contact_wakes: boolean;
  rest_ms: number; idle_ms: number; brood_ms: number; search_ms: number; find_p: number;
  /** null = give-up / route forgetting off (reference); K = forget the route after K consecutive empty arrivals */
  give_up_empty_trips: number | null; variant: string;
  /** the variant's label and status text (Q1: the reference ft-flat is provisional and uncalibrated) — for outputs */
  variant_label: string; variant_status: string; reference_variant: string;
  honeydew_ms: number; honeydew_amount: number; thermal_sd: number; ctmax_c: number; surface_offset_c: number;
  consts: DecisionConsts;
}
export const UP_PER_PORTION = 1_000_000;

const MECHANISMS_IMPLEMENTED: Record<string, boolean> = { M1_temperature_gate: true, M2_light_cue: false, M3_crop_satiety: true, M4_local_recruitment: true, M5_rest_debt: false, M6_food_time_memory: false, M7_nutrition_ctmax: false, M8_desiccation: false };

/** validate and derive; refuses (never repairs) a parameter file the prototype cannot honour */
/** deep freeze (the constants handed to decisions can never be changed by a decision or a caller) */
export function deepFreeze<T>(v: T): T { if (v && typeof v === 'object') { for (const x of Object.values(v as object)) deepFreeze(x); Object.freeze(v); } return v; }

/** the parameter set of a sensitivity variant: the raw file with the variant's labelled overrides applied */
export function applyVariant(raw: any, variant: string): any {
  const sec = VARIANT_SECTIONS.find((x) => variant !== '_note' && raw[x] && Object.prototype.hasOwnProperty.call(raw[x], variant));
  const va = sec ? raw[sec][variant] : undefined;
  if (!va) fail(`unknown sensitivity variant ${variant}`);
  const out = JSON.parse(JSON.stringify(raw));
  for (const [k, e] of Object.entries(va.overrides ?? {})) { if (!(k in out.parameters)) fail(`variant ${variant} overrides unknown parameter ${k}`); out.parameters[k] = JSON.parse(JSON.stringify(e)); }
  return out;
}

/** the Q2 retention candidate (default OFF = null); refuses anything it cannot honour, never repairs */
function retentionOf(x: any): DecisionConsts['retention'] {
  if (x === null) return null;
  if (x && x.kind === 'horizon' && typeof x.hours === 'number' && Number.isFinite(x.hours) && x.hours > 0 && Object.keys(x).length === 2) return { kind: 'horizon', need_ms: Math.round(x.hours * 3_600_000) };
  if (x && x.kind === 'own_interval' && typeof x.factor === 'number' && Number.isFinite(x.factor) && x.factor > 0 && Object.keys(x).length === 2) return { kind: 'own_interval', factor: x.factor };
  return fail('forager_retention must be null (off) or {kind: "horizon", hours > 0} or {kind: "own_interval", factor > 0}');
}

export function buildModel(rawFile: any, scenario: string, variantIn?: string): Model {
  const probs = evidenceProblems(rawFile); if (probs.length) fail(probs.join('; '));
  const variant = variantIn ?? rawFile.reference_variant, raw = applyVariant(rawFile, variant);
  const vSec = VARIANT_SECTIONS.find((x) => Object.prototype.hasOwnProperty.call(rawFile[x] ?? {}, variant))!, vDef = rawFile[vSec][variant];
  for (const [m, on] of Object.entries(MECHANISMS_IMPLEMENTED)) if (raw.mechanisms?.[m]?.enabled !== on) fail(`mechanism ${m} must be ${on ? 'enabled' : 'disabled'}: the prototype implements only the reference combination (design §5)`);
  const P = raw.parameters, v = (k: string): any => { if (!(k in P)) fail(`missing parameter ${k}`); return P[k].value; };
  const num = (k: string, lo = 0): number => { const x = v(k); if (typeof x !== 'number' || !Number.isFinite(x) || x < lo) fail(`${k} must be a number >= ${lo}`); return x; };
  const range = (k: string): [number, number] => { const x = v(k); if (!Array.isArray(x) || x.length !== 2 || !(x[0] >= 0 && x[0] <= x[1])) fail(`${k} must be [lo, hi]`); return [x[0], x[1]]; };
  const prob = (k: string) => { const x = num(k); if (x > 1) fail(`${k} must be a probability`); return x; };
  const up = (k: string) => Math.round(num(k) * UP_PER_PORTION);
  const sc = raw.weather_scenarios?.[scenario]; if (!sc) fail(`unknown weather scenario ${scenario}`);
  if (sc.rain !== null) fail('rain timing input is not supported by the prototype (rain effects are 尚未模擬)');
  const lightNight = num('light_factor_night'); if (lightNight !== 1) fail('M2 is off: light_factor_night must be 1 (Owner 2026-11-02 reference)');
  const ftKeys = ['forage_temp_zero_low_c', 'forage_temp_peak_c', 'forage_temp_zero_high_c'], ftNull = ftKeys.map((k) => v(k) === null);
  if (ftNull.some((x) => x) && !ftNull.every((x) => x)) fail('f_T anchors must be all numbers or all null');
  const f_t = ftNull[0] ? null : { zero_low: num('forage_temp_zero_low_c', -50), peak: num('forage_temp_peak_c', -50), zero_high: num('forage_temp_zero_high_c', -50) };
  if (f_t && !(f_t.zero_low < f_t.peak && f_t.peak < f_t.zero_high)) fail('need forage_temp_zero_low_c < forage_temp_peak_c < forage_temp_zero_high_c');
  const retention = retentionOf(v('forager_retention'));
  const gu = v('give_up_empty_trips'); if (!(gu === null || (Number.isInteger(gu) && gu >= 1))) fail('give_up_empty_trips must be null or an integer >= 1');
  const workers = num('colony_workers', 1), larvae = num('colony_larvae');
  if (!Number.isInteger(workers) || !Number.isInteger(larvae) || workers > 999 || larvae > 99) fail('colony sizes must be integers (workers <= 999, larvae <= 99)');
  if (num('individual_thermal_offset_sd_c') !== 0) fail('individual thermal offsets are not drawn in this prototype (sd must be 0)');
  const speed = num('trail_walking_speed_mm_s'); if (!(speed > 0)) fail('speed must be > 0');
  const ms = (k: string) => { const x = Math.round(num(k) * 1000); if (!(x >= 1)) fail(`${k} must be >= 1 ms`); return x; };
  const S = raw.site;
  const consts: DecisionConsts = deepFreeze({ hill_n: num('hill_n'), recruit_contact_weight: num('recruit_contact_weight'), idle_probability: prob('idle_probability'), f_t, light_factor_night: lightNight, transfer_max: up('transfer_max_portions'), feed_bolus: up('feed_bolus_portions'), begging_threshold: prob('larva_begging_threshold'), retention, metabolic_rate_per_day: up('worker_sugar_daily_portions'), day_ms: 86_400_000 });
  return {
    params_sha: sha256Hex(canon(rawFile)), scenario, variant, give_up_empty_trips: gu, variant_label: vDef.label, variant_status: vDef.status, reference_variant: rawFile.reference_variant,
    anchor: checkAnchor({ day0_date: sc.day0_date.value, utc_offset_minutes: S.utc_offset_minutes.value, zone: S.zone }),
    site: checkSite({ latitude_deg: S.latitude_deg.value, longitude_deg: S.longitude_deg.value }),
    hourly_temp_c: [...sc.hourly_temp_c], rh_mean_percent: typeof sc.rh_mean_percent === 'number' ? sc.rh_mean_percent : null, synthetic: true, weather_generator: sc.generator,
    workers, larvae, init_crop_max: prob('initial_crop_fill_max'), init_gut_max: prob('initial_larva_gut_fill_max'),
    crop_cap: up('crop_capacity_portions'), worker_rate: up('worker_sugar_daily_portions'), larva_rate: up('larva_sugar_daily_portions'), gut_cap: up('larva_gut_capacity_portions'),
    travel_ms: Math.max(1, Math.round((num('source_distance_mm') / speed) * 1000)), move_ms: ms('in_nest_move_s'), fill_ms_full: Math.round(num('liquid_fill_minutes_full_crop') * 60_000),
    recruit_min_fill: prob('recruit_min_crop_fill'), max_trophallaxis: num('max_trophallaxis_contacts'),
    theta_forage: range('threshold_forage_range'), theta_brood: range('threshold_brood_range'), gain: range('response_gain_range'),
    window_ms: ms('contact_window_s'), nest_contact_p: prob('nest_contact_probability'), larva_contact_p: prob('larva_contact_probability'), contact_wakes: v('contact_wakes_rester') === true,
    rest_ms: ms('rest_bout_mean_s'), idle_ms: ms('idle_bout_mean_s'), brood_ms: ms('brood_bout_mean_s'), search_ms: ms('search_bout_mean_s'), find_p: prob('search_find_probability'),
    honeydew_ms: ms('honeydew_interval_s'), honeydew_amount: up('honeydew_amount_portions'), thermal_sd: 0, ctmax_c: num('ctmax_c', -50), surface_offset_c: num('surface_offset_c', -50),
    consts,
  };
}
