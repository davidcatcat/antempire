/**
 * Owner decision 51 (docs/solar-cross-env-check.md): does the 1-ulp Node-vs-Chromium difference of engine/clock/solar.ts
 * light times change anything beyond displayed values? INVESTIGATION ONLY: changes no engine code, no parameter, no save.
 *
 * Part A (cross-environment sweep, needs Playwright Chromium): the SAME source of engine/clock/solar.ts (transpiled, types
 * stripped only) is evaluated in Node and in a real Chromium page on
 *   A1 the experiment-world site (24.18 N, 120.64 E, UTC+8), every day of 4 years;
 *   A2 latitudes −72…72 (1°) × 6 longitudes (local zone = round(lon/15) h) × every 5th day of a year;
 * and every differing value is classified: ulps; tick label (1e-6 min, 'tick' order) flip; displayed minute / ms flip;
 * refusal flip (a day that is refused in one environment only); light state (lightStateAt) flip at the instants
 * the clocks actually query (minute 0 of each day).
 * Part B (Node only, no browser): synthetic experiment world (prototypes/continuous-world) seeds 1–20 × 30 days: the
 * smallest distance between any ant / hour / day event instant and any light-transition instant, compared with the
 * cross-environment difference.
 * Part C (adversarial, Node only): constructed cases where an event lies within 1e-9 min of a light transition, using the
 * neighbouring double of the Node value as the stand-in for the other environment's value (what Part A measured).
 *   node prototypes/solar-xenv/sweep.ts [--no-browser] [--out file]
 * Writes prototypes/solar-xenv/out/sweep.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { lightTimes, lightStateAt, type LightTimes, type SolarSite } from '../../engine/clock/solar.ts';
import { type CalendarAnchor, dateOfDay, displayOf, ecoNative } from '../../engine/clock/time-frames.ts';
import { exactOf, labelOf, compareExact, WorldScheduler, type ExactTime, type EventSpec } from '../../engine/scheduler/world-events.ts';
import { ExperimentWorld } from '../continuous-world/worker/core.ts';
import { DEFAULT_PARAMS } from '../continuous-world/worker/params.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url)), ROOT = path.resolve(HERE, '..', '..');
const KEYS = ['civil_dawn', 'sunrise', 'solar_noon', 'sunset', 'civil_dusk'] as const;
type Case = { site: SolarSite; anchor: CalendarAnchor; date: string };
type Out = number[] | string;

export function cases(): { A1: Case[]; A2: Case[] } {
  const anchor = DEFAULT_PARAMS.calendar as CalendarAnchor, site = DEFAULT_PARAMS.site;
  const A1: Case[] = []; for (let d = 0; d < 4 * 365 + 1; d++) A1.push({ site, anchor, date: dateOfDay(anchor, d) });
  const A2: Case[] = [];
  for (let lat = -72; lat <= 72; lat++) for (const lon of [-179.5, -120, 0, 60, 120.64, 179.5]) {
    const a: CalendarAnchor = { day0_date: '2026-01-01', utc_offset_minutes: Math.round(lon / 15) * 60, zone: 'synthetic' } as CalendarAnchor;
    for (let d = 0; d < 365; d += 5) A2.push({ site: { latitude_deg: lat, longitude_deg: lon }, anchor: a, date: dateOfDay(a, d) });
  }
  return { A1, A2 };
}
const evalCase = (c: Case): Out => { try { const t = lightTimes(c.site, c.anchor, c.date); return KEYS.map((k) => t[k]); } catch (e) { return String((e as Error).message).slice(0, 80); } };

/** the browser side: the same modules, transpiled (type annotations removed; no arithmetic changes), served from memory */
async function browserEval(all: Case[]): Promise<{ version: string; out: Out[] }> {
  const require = createRequire(import.meta.url);
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('http://solar.test/**', async (route: { request(): { url(): string }; fulfill(o: object): Promise<void> }) => {
      const u = new URL(route.request().url()), f = path.join(ROOT, u.pathname);
      if (u.pathname === '/') return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>solar</title>' });
      if (!f.startsWith(path.join(ROOT, 'engine')) || !fs.existsSync(f)) return route.fulfill({ status: 404, body: '' });
      const js = ts.transpileModule(fs.readFileSync(f, 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, rewriteRelativeImportExtensions: false } }).outputText;
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: js });
    });
    await page.goto('http://solar.test/');
    const out = await page.evaluate(async (all: Case[]) => {
      const m = await import(/* browser: served by the route above */ '/engine/clock/solar.ts' as string);
      const keys = ['civil_dawn', 'sunrise', 'solar_noon', 'sunset', 'civil_dusk'];
      return all.map((c) => { try { const t = m.lightTimes(c.site, c.anchor, c.date); return keys.map((k: string) => t[k]); } catch (e) { return String((e as Error).message).slice(0, 80); } });
    }, all);
    return { version: browser.version(), out };
  } finally { await browser.close(); }
}

const ulps = (a: number, b: number) => { const f = new Float64Array([a, b]), i = new BigInt64Array(f.buffer); return Number(i[0] > i[1] ? i[0] - i[1] : i[1] - i[0]); };
const exactOfMin = (day: number, m: number): ExactTime => exactOf(ecoNative({ clock: 'eco.light', day, minute: m, resolution: 'exact' }));
const nextUp = (x: number) => { const f = new Float64Array([x]), i = new BigInt64Array(f.buffer); i[0] += x >= 0 ? 1n : -1n; return f[0]; };

/** classify one differing value: what could the difference change? */
function classify(anchor: CalendarAnchor, day: number, a: number, b: number) {
  const ea = exactOfMin(day, a), eb = exactOfMin(day, b);
  const la = labelOf(ea, 'layered'), lb = labelOf(eb, 'layered');
  const dmin = (x: ExactTime) => displayOf(anchor, x, 'minute').clock_text, dms = (x: ExactTime) => displayOf(anchor, x, 'exact').clock_text;
  const lo = Math.min(a, b), hi = Math.max(a, b);
  return {
    ulps: ulps(a, b), abs_min: Math.abs(a - b), exact_us: Math.abs((ea.us - eb.us) + (ea.us_lo - eb.us_lo)),
    tick_flip: la.minute !== lb.minute || la.day !== lb.day,
    display_minute_flip: dmin(ea) !== dmin(eb), display_ms_flip: dms(ea) !== dms(eb),
    // an integer minute (hourly / whole-minute events, minute-resolution inputs) strictly between or equal to one of them
    whole_minute_between: Math.floor(lo) !== Math.floor(hi) || Number.isInteger(lo) || Number.isInteger(hi),
  };
}

export function compare(all: Case[], node: Out[], chrome: Out[]) {
  const s = { cases: all.length, values: 0, equal_values: 0, differing_values: 0, refusal_flips: 0, refused_both: 0, max_ulps: 0, max_abs_min: 0, max_exact_us: 0, tick_flips: 0, display_minute_flips: 0, display_ms_flips: 0, whole_minute_between: 0, light_state_flips_at_midnight: 0, examples: [] as unknown[], max_ulps_example: null as unknown, ulps_histogram: {} as Record<string, number> };
  for (let i = 0; i < all.length; i++) {
    const n = node[i], c = chrome[i];
    if (typeof n === 'string' || typeof c === 'string') { if (typeof n === 'string' && typeof c === 'string') s.refused_both++; else s.refusal_flips++; continue; }
    const day = Math.round((Date.parse(all[i].date) - Date.parse(all[i].anchor.day0_date)) / 864e5);
    const ln = Object.fromEntries(KEYS.map((k, j) => [k, n[j]])) as unknown as LightTimes, lc = Object.fromEntries(KEYS.map((k, j) => [k, c[j]])) as unknown as LightTimes;
    if (lightStateAt(ln, 0) !== lightStateAt(lc, 0)) s.light_state_flips_at_midnight++;
    for (let j = 0; j < KEYS.length; j++) {
      s.values++;
      if (Object.is(n[j], c[j])) { s.equal_values++; continue; }
      s.differing_values++;
      const k = classify(all[i].anchor, day, n[j], c[j]);
      const bucket = k.ulps <= 2 ? String(k.ulps) : k.ulps <= 16 ? '3-16' : k.ulps <= 128 ? '17-128' : '>128'; s.ulps_histogram[bucket] = (s.ulps_histogram[bucket] ?? 0) + 1;
      if (k.ulps > s.max_ulps) s.max_ulps_example = { site: all[i].site, date: all[i].date, key: KEYS[j], node: n[j], chromium: c[j], ...k };
      s.max_ulps = Math.max(s.max_ulps, k.ulps); s.max_abs_min = Math.max(s.max_abs_min, k.abs_min); s.max_exact_us = Math.max(s.max_exact_us, k.exact_us);
      if (k.tick_flip) s.tick_flips++; if (k.display_minute_flip) s.display_minute_flips++; if (k.display_ms_flip) s.display_ms_flips++; if (k.whole_minute_between) s.whole_minute_between++;
      if (s.examples.length < 8) s.examples.push({ site: all[i].site, date: all[i].date, key: KEYS[j], node: n[j], chromium: c[j], ...k });
    }
  }
  return s;
}

/** Part B: synthetic experiment world, distance between light transitions and every other event instant */
export function partB(seeds: number[], days: number) {
  const rows = [];
  for (const seed of seeds) {
    const { world, events } = ExperimentWorld.create(`exp-solar-${seed}`, seed);
    const all = [...events, ...world.advanceTo(days * 86400).events];
    const us = (e: { exact: ExactTime }) => e.exact.day * 86400e6 + e.exact.us + e.exact.us_lo;
    const light = all.filter((e) => e.kind === 'light_change').map(us).sort((a, b) => a - b), other = all.filter((e) => e.kind !== 'light_change').map(us).sort((a, b) => a - b);
    let minGap = Infinity, j = 0;
    for (const t of light) { while (j + 1 < other.length && other[j + 1] <= t) j++; for (const o of [other[j], other[j + 1]]) if (o !== undefined) minGap = Math.min(minGap, Math.abs(o - t)); }
    rows.push({ seed, days, events: all.length, light_events: light.length, other_events: other.length, min_gap_us: minGap });
  }
  return { rows, min_gap_us: Math.min(...rows.map((r) => r.min_gap_us)) };
}

/** Part C: adversarial cases (Node only; the other environment's value is stood in by the neighbouring double) */
export function partC() {
  const anchor = DEFAULT_PARAMS.calendar as CalendarAnchor, site = DEFAULT_PARAMS.site, day = 1, date = dateOfDay(anchor, day);
  const L = lightTimes(site, anchor, date), a = L.sunrise, b = nextUp(a);
  const out: Record<string, unknown> = { date, sunrise_node: a, sunrise_neighbour: b, diff_min: b - a };
  // C1 an event scheduled at exactly the Node sunrise instant: one batch in Node; with the neighbouring value it is a separate,
  //    earlier batch — the batch composition and the event order differ (layered order)
  const run = (sunrise: number, otherMinute: number) => {
    const s = new WorldScheduler('exp-adv', { day: 0, minute: 0 }, { order: 'layered' });
    const spec = (kind: string, key: string, m: number): EventSpec => ({ kind, key, native: { clock: kind === 'light' ? 'eco.light' : 'ant.Z', unit: 'min', anchor: { day, minute: 0 }, t: m }, scope: { world: 'exp-adv', colony: null, individual: null }, source: null, target: null, payload: null });
    s.schedule(spec('light', 'sunrise', sunrise)); s.schedule(spec('other', 'x', otherMinute));
    const batches: string[][] = []; s.runUntil({ day: day + 1, minute: 0 }, (batch) => { batches.push(batch.map((e) => e.kind).sort()); });
    return batches.map((x) => x.join('+')).join(' | ');
  };
  out.C1_same_instant = { node: run(a, a), other_env: run(b, a), changes_batching: run(a, a) !== run(b, a) };
  // C2 an event 1e-12 min after the Node sunrise (inside the 1-ulp window? report) and one between the two values
  const mid = a + (b - a) / 2;   // may round to a or b: there is no double strictly between neighbours
  out.C2_between = { strictly_between_exists: mid !== a && mid !== b, note: 'neighbouring doubles: no other minute value lies strictly between; an event at exactly a or b is the only way to be inside the window' };
  const near = a + 1e-12; out.C2_1e12 = { node: run(a, near), other_env: run(b, near), changes_order: run(a, near) !== run(b, near) };
  // C3 tick label flip ('tick' order): two neighbouring doubles next to a half-tick point round to different ticks
  const half = (Math.floor(a * 1e6) + 0.5) / 1e6; let found: unknown = null;
  for (let x = (() => { let y = half; for (let i = 0; i < 64; i++) y = -nextUp(-y); return y; })(), i = 0; i < 128 && !found; i++, x = nextUp(x)) {
    const lx = labelOf(exactOfMin(day, x), 'tick'), ly = labelOf(exactOfMin(day, nextUp(x)), 'tick');
    if (lx.minute !== ly.minute) found = { value: x, neighbour: nextUp(x), tick_label_a: lx.minute, tick_label_b: ly.minute };
  }
  out.C3_tick_flip = found ?? 'none found within 64 ulps of the half-tick point';
  // C4 light state queried at a light transition minute (the clocks query only their own transition values, and minute 0)
  out.C4_state_at_own_value = { node: lightStateAt(L, a), with_neighbour_times_at_node_value: lightStateAt({ ...L, sunrise: b }, a) };
  // C5 refusal at the edge of the solver's domain: crossingMinute null (|cosH| > 1) or light times outside [0, 1440)
  return out;
}

const me = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === me) {
  const arg = (k: string) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  const { A1, A2 } = cases(), all = [...A1, ...A2];
  const t0 = performance.now(), node = all.map(evalCase), nodeMs = performance.now() - t0;
  let A: unknown = 'not run (--no-browser)';
  if (!process.argv.includes('--no-browser')) {
    const br = await browserEval(all);
    A = { chromium: br.version, node: process.version, node_ms: Math.round(nodeMs), A1: compare(A1, node.slice(0, A1.length), br.out.slice(0, A1.length)), A2: compare(A2, node.slice(A1.length), br.out.slice(A1.length)) };
  }
  const B = partB(Array.from({ length: 20 }, (_, i) => i + 1), 30), C = partC();
  const res = { schema: 'antempire.solar-xenv.v1', label: '調查用：跨環境浮點比較；非正式；不改引擎', A, B, C };
  const out = arg('--out') ?? path.join(HERE, 'out', 'sweep.json');
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(res, null, 1) + '\n');
  console.log(JSON.stringify(res, (k, v) => (k === 'rows' ? undefined : v), 1));
}
