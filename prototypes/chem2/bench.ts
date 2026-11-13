/**
 * CHEM-2 (#133) M1/M2 KINETICS BENCH — non-official, synthetic, deterministic. Prints Markdown tables to the terminal
 * (`node prototypes/chem2/bench.ts`); writes nothing. Used (reduced) by tests/chem2-kinetics.test.ts.
 *
 * What it is: concentration profiles of candidate decay kinetics on standard synthetic deposit scenarios, under
 * synthetic weather from the P0-A1 clock's environment events. Every number here is a candidate on a PRE-DECLARED grid
 * (no selection, no tuning; every cell of the grid is printed). It is NOT a fit to Dussutour 2009 (O1–O5 need the
 * CHEM-3 decision operator) and says nothing about which model is right.
 *
 * Fields are linear in deposits, so M1 with any exploration/laden deposit ratio q_X/q_L is q_X·(exploration response) +
 * q_L·(laden response): the bench reports the two unit responses separately instead of choosing a ratio. M2 = two
 * channels (E, F) with their own λ; the local F->E deposit inhibition of M2 is a deposition RULE (behaviour, CHEM-3),
 * not kinetics, and is not modelled here.
 */
import { ChemStore, type ChannelConfig, type StoreConfig } from '../../engine/chemistry/core.ts';
import type { ChannelSpec, ChemClock, ChemTime, DepositEvent, Domain, ParamProvenance, Where } from '../../engine/chemistry/contract.ts';
import { CHEM_KINETICS_VERSION, kineticsOff, type EnvTrace, type KineticsSpec } from '../../engine/chemistry/kinetics.ts';
import type { ClockWorldConfig } from '../../engine/clock/environment.ts';
import { dateOfDay, type CalendarAnchor } from '../../engine/clock/time-frames.ts';
import type { DailyWeatherInput, TemperatureShape } from '../../engine/clock/weather-input.ts';
import { envTraceFromClock } from './env-trace.ts';

// ------------------------------------------------------------------ fixed bench setup (all 遊戲假設 D unless noted)
export const ANCHOR: CalendarAnchor = { day0_date: '2027-07-01', utc_offset_minutes: 480, zone: 'Asia/Taipei' };
/** Xitun, Taichung (representative point as in the P0-A1 tests; a site, not a measured garden position) */
export const SITE = { latitude_deg: 24.17, longitude_deg: 120.64 };
/** chemistry clock: t_s = 0 at 12:00 of world day 1 */
export const CLOCK: ChemClock = { name: 'chem2.bench', anchor: { day: 1, minute: 720 } };
export const T = (t_s: number, round = 0): ChemTime => ({ clock: CLOCK.name, unit: 's', t_s, round });
export const SHAPE: TemperatureShape = { peak_lag_after_noon_h: 2, night_decay_b: 2, min_lag_after_sunrise_h: 0 };
/** synthetic afternoons (NOT Taichung climatology; chosen only to bracket a cool and a hot day) */
export const WEATHER = { cool: { t_min_c: 18, t_max_c: 24 }, hot: { t_min_c: 26, t_max_c: 34 } } as const;
export type WeatherName = keyof typeof WEATHER;

const SYN = (date: string) => ({ kind: 'synthetic_climatology' as const, synthetic: true, assumption: true, source: 'CHEM-2 bench fixture (synthetic afternoon)', station_id: null, source_url: null, issued_at: null, valid_from: null, valid_to: null, generator: 'prototypes/chem2/bench.ts', rng_stream: `chem2|${date}` });
export function weatherInputs(w: WeatherName, rain_mm = 0): DailyWeatherInput[] {
  const { t_min_c, t_max_c } = WEATHER[w];
  return [0, 1, 2].map((d) => { const date = dateOfDay(ANCHOR, d); return { date, provenance: SYN(date), t_min_c, t_max_c, t_mean_c: (t_min_c + t_max_c) / 2, rh_mean_percent: 75, rain_mm: d === 1 ? rain_mm : 0, hourly: null }; });
}
export const clockCfg = (step_min = 10, rain = false): ClockWorldConfig => ({
  world: 'chem2-bench', official: false, anchor: ANCHOR, site: SITE, order: 'layered', sample_step_min: step_min, first_day: 0, last_day: 2, seed: 11,
  temperature_shape: SHAPE, rain_timing: rain ? { events_per_rain_day: 1, duration_min: [60, 60], assumption: true, basis: '遊戲假設', label: 'chem2 bench one-hour shower' } : null,
});
/** bench covers 12:00 day 1 .. 06:00 day 2 */
export const COVER = { t0_s: 0, t1_s: 18 * 3600 };
export const envOf = (w: WeatherName, step_min = 10, rain_mm = 0): EnvTrace => envTraceFromClock(clockCfg(step_min, rain_mm > 0), weatherInputs(w, rain_mm), CLOCK, COVER);

// ------------------------------------------------------------------ candidate kinetics (pre-declared grid)
const cand = (value: number | null, note: string, level: 'A' | 'C' | 'D' = 'D', sources: string[] = []): ParamProvenance => ({ value, assumption: true, basis: level === 'D' ? '遊戲假設' : '文獻支持', evidence_level: level, sources, note });
/** half-lives at the reference temperature (min); null = λ = 0 baseline. 10 and 17 min are grid points because they are
 *  the model-dependent LAB estimates (R21, 25±1 °C, 60 mm bridge) — not outdoor Xitun values. */
export const HALF_LIVES_MIN: (number | null)[] = [null, 5, 10, 17, 30, 60];
/** Q10 grid (general-physiology form; no focal-species value): null = temperature term OFF */
export const Q10S: (number | null)[] = [null, 1.5, 2, 3];
/** reference temperature: the lab condition of the half-life estimates (R21: rearing room 25±1 °C) */
export const T_REF_C = 25;
export const lambdaOf = (h: number | null) => (h === null ? 0 : Math.LN2 / (h * 60));

export function kinetics(q10: number | null, washoff: number | null = null): KineticsSpec {
  const k = kineticsOff();
  return {
    ...k, version: CHEM_KINETICS_VERSION,
    temperature: q10 === null ? null : { form: 'q10', input: 'air_temp_c_surrogate', q10: cand(q10, 'Q10 grid point (一般生理學 form; value 遊戲假設, no focal-species measurement; R35/R36 direction only, 非本種)'), t_ref_c: cand(T_REF_C, 'R21 lab condition 25±1 °C (A, condition of the model-dependent estimate); its use as reference is an assumption', 'A', ['R21']) },
    rain_washoff_per_s: washoff === null ? k.rain_washoff_per_s : cand(washoff, 'wash-off grid point, no evidence for any value'),
  };
}
export function channel(signal_id: string, backend: 'surface_edge' | 'sparse_2d', half_min: number | null, variant: 'M1' | 'M2' = 'M1', role: 'E' | 'F' | null = null): ChannelSpec {
  return {
    signal_id, mechanism: 'trail_recruitment', model_variant: variant, variant_role: role, chemical_identity: null,
    units: { quantity: 'normalized_activity', length: 'mm', time: 's' }, backend,
    spatial_support: backend === 'surface_edge' ? { kind: 'surface_edge', bin_mm: 5 } : { kind: 'sparse_2d', cell_mm: 2, isotropic_diffusion: false },
    perception_rule: { mode: backend === 'surface_edge' ? 'on_support' : 'bounded_radius', max_radius_mm: 3, near_contact_mm: null, same_layer_only: true, threshold: cand(null, 'no dose-response data') },
    time_rule: { kind: 'analytic_exponential', unit: 's', same_instant: 'visible_if_round_not_later', lambda_per_s: half_min === null ? cand(0, 'λ = 0 baseline (no within-day decay)') : cand(lambdaOf(half_min), `half-life ${half_min} min at ${T_REF_C} °C: grid point (R21 lab estimates are model-dependent, not outdoor values)`, 'C', ['R21', 'R102']) },
    evidence_level: 'C', assumption: true, sources: ['R21', 'R102'], note: 'CHEM-2 bench channel (synthetic)',
  };
}
const U = { quantity: 'normalized_activity' as const, length: 'mm' as const, time: 's' as const };
const dep = (id: string, signal_id: string, t_s: number, where: Where, cause: string): DepositEvent =>
  ({ deposit_id: id, signal_id, origin_agent: `synthetic:${id}`, source_worker_id: null, origin_event_id: `ev:${id}`, time: T(t_s), layer: 'surface', substrate: null, where, amount: 1, cause, units: U });

// ------------------------------------------------------------------ scenarios
export const TRAIL: Domain = { backend: 'surface_edge', edges: [{ id: 'trail', length_mm: 600, layer: 'surface' }] };
export const PLANE: Domain = { backend: 'sparse_2d', bounds_mm: { x0: 0, y0: 0, x1: 400, y1: 400 }, layers: ['surface'] };
/** 13:00–13:15 exploration passes, 13:15–14:00 laden passes, one per minute (synthetic schedule) */
export const EXPLORE = { from_s: 3600, to_s: 4500 }, LADEN = { from_s: 4500, to_s: 7200 };
const minutes = (a: { from_s: number; to_s: number }) => { const out: number[] = []; for (let t = a.from_s; t < a.to_s; t += 60) out.push(t + 60); return out; };
/** probe times (s after 12:00) */
export const PROBES_S = [7200, 9000, 10800, 14400, 21600, 64800];
export const label = (t: number) => { const m = 720 + t / 60, d = Math.floor(m / 1440); return `${d ? 'D+1 ' : ''}${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`; };

/** residual = integrated − present − decayed; deposited = integrated amount (both from the channel ledger at the last probe) */
export interface Profile { values: number[]; residual: number; deposited: number }
export interface LedgerTotals { residual: number; deposited: number }
const totals = (s: ChemStore, id: string): LedgerTotals => { const l = s.ledger(id); return { residual: l.residual, deposited: l.integrated_amount }; };
function readEdge(s: ChemStore, signal_id: string, t: number) { return s.sampleLocal({ signal_id, agent_id: 'probe', layer: 'surface', time: T(t), phase: 'local_sensing', sensor: { kind: 'edge', edge_id: 'trail', s_mm: 300, radius_mm: 3 } }).exposure; }

/** S1 single trail (M1 unit responses): whole-edge passes; probe at s = 300 mm */
export function singleTrail(half: number | null, q10: number | null, w: WeatherName, part: 'explore' | 'laden', env?: EnvTrace, washoff: number | null = null): Profile {
  const cfg: StoreConfig = { clock: CLOCK, environment: env ?? envOf(w), channels: [{ spec: channel('m1', 'surface_edge', half), domain: TRAIL, kinetics: kinetics(q10, washoff) }] };
  const s = new ChemStore(cfg), ts = minutes(part === 'explore' ? EXPLORE : LADEN);
  s.deposit(ts.map((t, i) => dep(`${part}${i}`, 'm1', t, { kind: 'edge_segment', edge_id: 'trail', s0_mm: 0, s1_mm: 600 }, part === 'explore' ? 'exploration_pass' : 'laden_return')));
  const values = PROBES_S.map((t) => { s.advance(T(t)); return readEdge(s, 'm1', t); });
  const { residual, deposited } = totals(s, 'm1');
  return { values, residual, deposited };
}

/** S1 under M2: E from exploration passes, F from laden passes; λ_E = ratio·λ_F (λ_F at the half-life grid point) */
export function singleTrailM2(halfF: number | null, ratio: number, q10: number | null, w: WeatherName): { E: number[]; F: number[]; ledgers: { E: LedgerTotals; F: LedgerTotals } } {
  const hE = halfF === null ? null : halfF / ratio;
  const cfgs: ChannelConfig[] = [{ spec: channel('E', 'surface_edge', hE, 'M2', 'E'), domain: TRAIL, kinetics: kinetics(q10) }, { spec: channel('F', 'surface_edge', halfF, 'M2', 'F'), domain: TRAIL, kinetics: kinetics(q10) }];
  const s = new ChemStore({ clock: CLOCK, environment: envOf(w), channels: cfgs });
  s.deposit([...minutes(EXPLORE).map((t, i) => dep(`e${i}`, 'E', t, { kind: 'edge_segment', edge_id: 'trail', s0_mm: 0, s1_mm: 600 }, 'exploration_pass')), ...minutes(LADEN).map((t, i) => dep(`f${i}`, 'F', t, { kind: 'edge_segment', edge_id: 'trail', s0_mm: 0, s1_mm: 600 }, 'laden_return'))]);
  const E: number[] = [], F: number[] = [];
  for (const t of PROBES_S) { s.advance(T(t)); E.push(readEdge(s, 'E', t)); F.push(readEdge(s, 'F', t)); }
  return { E, F, ledgers: { E: totals(s, 'E'), F: totals(s, 'F') } };
}

/** S2 crossing trails on a plane: A along y = 200 (13:00–13:30), B along x = 200 (13:30–14:00), 10 mm steps per pass */
export const CROSS_PROBES = { crossing: [200, 200], on_A: [100, 200], on_B: [200, 100] } as const;
export function crossing(half: number | null, q10: number | null, w: WeatherName): Record<keyof typeof CROSS_PROBES, number[]> { return crossingRun(half, q10, w).probes; }
/** S2 with the channel ledger totals (same run as crossing()) */
export function crossingRun(half: number | null, q10: number | null, w: WeatherName): { probes: Record<keyof typeof CROSS_PROBES, number[]>; ledger: LedgerTotals } {
  const s = new ChemStore({ clock: CLOCK, environment: envOf(w), channels: [{ spec: channel('x', 'sparse_2d', half), domain: PLANE, kinetics: kinetics(q10) }] });
  const evs: DepositEvent[] = [];
  minutes({ from_s: 3600, to_s: 5400 }).forEach((t, i) => evs.push(dep(`A${i}`, 'x', t, { kind: 'segment2d', x0_mm: 0, y0_mm: 200, x1_mm: 400, y1_mm: 200 }, 'laden_return')));
  minutes({ from_s: 5400, to_s: 7200 }).forEach((t, i) => evs.push(dep(`B${i}`, 'x', t, { kind: 'segment2d', x0_mm: 200, y0_mm: 0, x1_mm: 200, y1_mm: 400 }, 'laden_return')));
  s.deposit(evs);
  const out = { crossing: [] as number[], on_A: [] as number[], on_B: [] as number[] };
  for (const t of PROBES_S) {
    s.advance(T(t));
    for (const [k, [x, y]] of Object.entries(CROSS_PROBES) as [keyof typeof CROSS_PROBES, readonly [number, number]][]) out[k].push(s.sampleLocal({ signal_id: 'x', agent_id: 'probe', layer: 'surface', time: T(t), phase: 'local_sensing', sensor: { kind: 'disc', x_mm: x, y_mm: y, radius_mm: 3 } }).mean_density_per_mm2!);
  }
  return { probes: out, ledger: totals(s, 'x') };
}

// ------------------------------------------------------------------ printing (terminal only)
const f = (x: number) => (x === 0 ? '0' : Math.abs(x) >= 0.01 ? x.toFixed(3) : x.toExponential(2));
const hl = (h: number | null) => (h === null ? 'λ=0' : `${h} min`);
const q = (x: number | null) => (x === null ? 'OFF' : String(x));

function main() {
  const lines: string[] = [];
  const P = (s = '') => lines.push(s);
  const t0 = performance.now();
  P('### S1 單一路徑（M1 單位反應；探索段 13:00–13:15、帶食段 13:15–14:00，每分鐘一次全長通過；探針 s＝300 mm）');
  P(`欄位：探針時刻的讀值（normalized activity，edge 整格讀取）。λ_ref 為 ${T_REF_C} °C 的值。`);
  for (const part of ['laden', 'explore'] as const) {
    P(); P(`**${part === 'laden' ? '帶食段（laden，45 次）' : '探索段（exploration，15 次）'}**`); P();
    P(`| 半衰期@${T_REF_C}°C | Q10 | 天氣 | ${PROBES_S.map(label).join(' | ')} | 殘差 |`); P(`|${'---|'.repeat(PROBES_S.length + 4)}`);
    for (const h of HALF_LIVES_MIN) for (const qq of Q10S) for (const w of ['cool', 'hot'] as const) {
      if (h === null && qq !== null) continue; // λ = 0: temperature cannot act (λ_ref·f_T = 0)
      if (qq === null && w === 'hot') { /* temperature OFF: weather irrelevant, print once */ continue; }
      const p = singleTrail(h, qq, w, part);
      P(`| ${hl(h)} | ${q(qq)} | ${qq === null ? '—' : w} | ${p.values.map(f).join(' | ')} | ${p.residual.toExponential(1)} |`);
    }
  }
  P(); P('### S3 熱天 vs 涼天（帶食段；16:00 讀值的熱／涼比；Q10 OFF 時恆為 1）'); P();
  P(`| 半衰期@${T_REF_C}°C | ${Q10S.map((x) => `Q10 ${q(x)}`).join(' | ')} |`); P(`|${'---|'.repeat(Q10S.length + 1)}`);
  for (const h of HALF_LIVES_MIN.filter((x) => x !== null)) P(`| ${hl(h)} | ${Q10S.map((qq) => { const a = singleTrail(h, qq, 'hot', 'laden').values[3], b = singleTrail(h, qq, 'cool', 'laden').values[3]; return f(a / b); }).join(' | ')} |`);
  P(); P('### S1 M2（E 來自探索段、F 來自帶食段；λ_E＝比值·λ_F；Q10 2；16:00 讀值）'); P();
  P('| 半衰期 F | λ_E/λ_F | 天氣 | E@16:00 | F@16:00 | E@14:00 | F@14:00 |'); P('|---|---|---|---|---|---|---|');
  for (const h of [10, 17, 30]) for (const r of [0.3, 0.6, 1]) for (const w of ['cool', 'hot'] as const) { const m = singleTrailM2(h, r, 2, w); P(`| ${h} min | ${r} | ${w} | ${f(m.E[3])} | ${f(m.F[3])} | ${f(m.E[0])} | ${f(m.F[0])} |`); }
  P(); P('### S2 交叉路徑（平面 2 mm 格，r＝3 mm 平均密度 /mm²；A 13:00–13:30，B 13:30–14:00）'); P();
  P(`| 半衰期 | Q10 | 天氣 | 探針 | ${PROBES_S.map(label).join(' | ')} |`); P(`|${'---|'.repeat(PROBES_S.length + 4)}`);
  for (const [h, qq, w] of [[null, null, 'cool'], [17, null, 'cool'], [17, 2, 'cool'], [17, 2, 'hot']] as const) {
    const c = crossing(h, qq, w);
    for (const k of Object.keys(CROSS_PROBES) as (keyof typeof CROSS_PROBES)[]) P(`| ${hl(h)} | ${q(qq)} | ${qq === null ? '—' : w} | ${k} | ${c[k].map(f).join(' | ')} |`);
  }
  P(); P('### S4 無雨（全部情境 rain_mm＝0）與「有雨但沖刷 OFF」對照'); P();
  const dry = singleTrail(17, 2, 'hot', 'laden'), wetOff = singleTrail(17, 2, 'hot', 'laden', envOf('hot', 10, 5));
  P(`- 17 min、Q10 2、熱天：無雨與「當日 5 mm 一小時雨、沖刷 null」逐位元相同：${dry.values.every((v, i) => Object.is(v, wetOff.values[i]))}`);
  const wetOn = singleTrail(17, 2, 'hot', 'laden', envOf('hot', 10, 5), 1e-3);
  P(`- 只為顯示開關有效（沖刷 1e-3/s 是無證據的網格點）：16:00 讀值 ${f(dry.values[3])} → ${f(wetOn.values[3])}（雨的時段由 P0-A1 合成雨時段情境決定）`);
  P(); P('### 環境取樣步長收斂（熱天、Q10 3、半衰期 10 min、帶食段，16:00 讀值；解析積分對所給軌跡是精確的，誤差只來自 weather_sample 的線性內插）'); P();
  P('| sample_step_min | 16:00 讀值 | 對 1 min 的相對差 |'); P('|---|---|---|');
  const ref = singleTrail(10, 3, 'hot', 'laden', envOf('hot', 1)).values[3];
  for (const st of [60, 30, 10, 5, 1]) { const v = singleTrail(10, 3, 'hot', 'laden', envOf('hot', st)).values[3]; P(`| ${st} | ${f(v)} | ${((v - ref) / ref).toExponential(2)} |`); }
  P(); P('### 成本（單機，只供量級；S1 單一路徑，於 16:00 讀 20000 次（先暖機 20000 次））'); P();
  P('| 設定 | µs／讀取 |'); P('|---|---|');
  for (const [name, qq] of [['CHEM-1 公式（無 kinetics）', null], ['CHEM-2 溫度項 ON（Q10 2）', 2]] as const) {
    const s = new ChemStore({ clock: CLOCK, environment: envOf('hot'), channels: [{ spec: channel('m1', 'surface_edge', 17), domain: TRAIL, ...(qq === null ? {} : { kinetics: kinetics(qq) }) }] });
    s.deposit(minutes(LADEN).map((t, i) => dep(`c${i}`, 'm1', t, { kind: 'edge_segment', edge_id: 'trail', s0_mm: 0, s1_mm: 600 }, 'laden_return'))); s.advance(T(14400));
    for (let i = 0; i < 20000; i++) readEdge(s, 'm1', 14400); // warm-up (JIT)
    const a = performance.now(); for (let i = 0; i < 20000; i++) readEdge(s, 'm1', 14400);
    P(`| ${name} | ${((performance.now() - a) * 1000 / 20000).toFixed(2)} |`);
  }
  P(); P(`（整個基準：${(performance.now() - t0).toFixed(0)} ms，單機，只供量級參考）`);
  console.log(lines.join('\n'));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
