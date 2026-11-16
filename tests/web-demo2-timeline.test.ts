/**
 * Demo 2 — D2E-3 (docs/demo2-engine-gap.md): the food source, the environment and the 24-hour activity timeline, all
 * from engine events and engine state. BLOCKING. NON-OFFICIAL experiment world; nothing here changes one.
 *  1. reconciliation: the page's hourly bins (web/src/demo2/timeline.ts) equal an independent replay of the core's log
 *     (tests/lib/demo2-replay.ts replayHourly), hour by hour, for 3 seeds × 30 h and any chunking; the source record
 *     (drops, amounts, arrivals with / without food) equals the replay; the hourly temperature is the engine's hourly
 *     weather record (env_sample), the light changes are the engine's env_light events;
 *  2. a page opened later has NO bin for the hours before it (the chart says 無資料, not 0), and its bins equal the
 *     replay over the same event span;
 *  3. the chart: one row per measure, each with its own stated scale (no second axis), bar height proportional to the
 *     count on that row's scale, one bar per non-zero hour, the running hour marked, a hit column with the hour's values
 *     per hour, the same numbers as a table; one hue for the counts; the temperature is labelled synthetic; futile
 *     trips («是空的») are their own row and are larger than the intakes;
 *  4. frame light states fill the strip before the first env_light event the page saw;
 *  5. observation only (#144): the module imports protocol types only, has no clock / storage / Worker command, does
 *     not mutate events; the observed world is identical to the unobserved one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { P0a2ExperimentWorld } from '../prototypes/continuous-world/worker/p0a2-world.ts';
import type { EventMsg, P0a2FrameMsg } from '../web/src/experimental/worker-protocol.ts';
import { CHART, HOUR_S, MEASURES, Timeline, timelineChart, type Light } from '../web/src/demo2/timeline.ts';
import { replayHourly, replayLines } from './lib/demo2-replay.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const read = (p: string) => fs.readFileSync(path.join(REPO_ROOT, p), 'utf8');
const run = (seed: number, T: number, chunk: number, fromT = 0) => {
  const { world, events } = P0a2ExperimentWorld.create('exp-demo2-timeline', seed), tl = new Timeline();
  if (fromT > 0) world.advanceTo(fromT); else tl.onEvents(events as unknown as EventMsg[]);
  let firstSeq: number | null = fromT > 0 ? world.seqNo() : 0;
  for (let t = fromT; t < T;) { t = Math.min(T, t + chunk); tl.onEvents(world.advanceTo(t).events as unknown as EventMsg[]); }
  return { world, tl, firstSeq: firstSeq! };
};
const summary: Record<string, unknown> = {};

// 1. hour-by-hour reconciliation
for (const seed of [20261113, 1, 7]) {
  const T = 30 * HOUR_S, a = run(seed, T, 53), b = run(seed, T, T), lines = replayLines(seed, T * 1000), rep = replayHourly(lines);
  const bins = a.tl.all();
  assert.deepEqual(bins.map((x) => x.h), Object.keys(rep.hours).map(Number).sort((x, y) => x - y), `seed ${seed}: the same hours`); checks++;
  for (const bin of bins) {
    const r = rep.hours[bin.h];
    assert.deepEqual(bin.counts, { exit: r.exit, empty: r.empty, take: r.take, transfer: r.transfer, larva_fed: r.larva_fed, produce: r.produce }, `seed ${seed} hour ${bin.h}: counts == replay`);
    assert.equal(bin.temp_c, r.temp_c, `seed ${seed} hour ${bin.h}: the hourly temperature is the engine's weather record`); checks += 2;
  }
  assert.deepEqual(b.tl.all().map((x) => x.counts), bins.map((x) => x.counts), 'chunking does not change a bin'); checks++;
  const S = a.tl.source;
  ok(S.drops === rep.source.drops && S.dropped_up === rep.source.dropped_up && S.taken_up === rep.source.taken_up && S.arrivals_take === rep.source.arrivals_take && S.arrivals_empty === rep.source.arrivals_empty && S.last_drop_t === rep.source.last_drop_ms! / 1000, `seed ${seed}: the source record == replay (${S.drops} drops, ${S.arrivals_take} arrivals with food, ${S.arrivals_empty} with none)`);
  ok(S.arrivals_empty > 5 * S.arrivals_take && S.dropped_up >= S.taken_up, `seed ${seed}: most arrivals find the source empty — shown as it is (${S.arrivals_empty} vs ${S.arrivals_take})`);
  assert.deepEqual(a.tl.light.map((x) => [x.t * 1000, x.to]), rep.light.map((x) => [x.t_ms, x.to]), 'light changes are the engine\'s env_light events'); checks++;
  ok(bins.slice(0, 30).every((x) => x.temp_c !== null) && bins.length === 31, `seed ${seed}: every started hour has the engine's hourly weather record (30 h run → hours 0..30)`);
  const day0 = bins.filter((x) => x.h < 24), sum = (k: 'exit' | 'empty' | 'take' | 'transfer' | 'larva_fed' | 'produce') => day0.reduce((s, x) => s + x.counts[k], 0);
  summary[`seed_${seed}_day0`] = { exit: sum('exit'), empty: sum('empty'), take: sum('take'), transfer: sum('transfer'), larva_fed: sum('larva_fed'), produce: sum('produce'), exit_by_hour_min_max: [Math.min(...day0.map((x) => x.counts.exit)), Math.max(...day0.map((x) => x.counts.exit))] };
}

// 2. a page opened at 09:00 on a running world
{
  const seed = 1, from = 9 * HOUR_S, T = 14 * HOUR_S, a = run(seed, T, 60, from), rep = replayHourly(replayLines(seed, T * 1000), a.firstSeq);
  const bins = a.tl.all();
  ok(bins[0].h === 9 && bins.every((x) => x.h >= 9) && a.tl.first_t! > from, 'no bin before the hour the page opened in');
  for (const bin of bins) { const r = rep.hours[bin.h]; assert.deepEqual(bin.counts, { exit: r.exit, empty: r.empty, take: r.take, transfer: r.transfer, larva_fed: r.larva_fed, produce: r.produce }); checks++; }
  const w = a.tl.window(T - 1, 24);
  ok(w.length === 24 && w.slice(0, 24 - 5).every((x) => x === null) && w.slice(24 - 5).every((x) => x !== null), 'the 24-hour window has null (no data) for the 19 hours before the page opened');
  const c = timelineChart(a.tl, { width: 360, now: T - 1 });
  ok((c.svg.match(/data-nodata="1"/g) ?? []).length === 19 * MEASURES.length && c.svg.includes('無資料') && c.table.includes('無資料') && (c.svg.match(/data-tip="[^"]*無資料（本頁當時尚未開啟）/g) ?? []).length === 9 && (c.svg.match(/data-tip="世界開始之前/g) ?? []).length === 10, 'hours without data are drawn and worded as 無資料 (rows, strip, tooltip, table) — or 世界開始之前 for hours before t = 0 — never as 0');
  // 4. the light strip: unknown from events alone (no env_light between 09:00 and 14:00), known once a frame was shown
  ok(a.tl.light.length === 0 && c.svg.includes('data-light="none"'), 'no env_light event seen yet: the strip does not guess');
  const f = a.world.frame() as unknown as P0a2FrameMsg; a.tl.noteFrame(from + 1, f.env.light as Light);
  const c2 = timelineChart(a.tl, { width: 360, now: T - 1 });
  ok(a.tl.lightAt(T - 1) === 'day' && (c2.svg.match(/data-light="day"/g) ?? []).length === 5 && (c2.svg.match(/data-light="none"/g) ?? []).length === 19, 'the light state of a frame the page was shown (engine state) fills the strip for the hours it has');
}

// 3. the chart
{
  const seed = 20261113, T = 26 * HOUR_S + 1200, { tl } = run(seed, T, 300), c = timelineChart(tl, { width: 400, now: T });
  const bins = tl.window(T, 24);
  ok(c.hours.length === 24 && c.hours[23] === 26 && c.rows.length === MEASURES.length, 'the chart covers the 24 hours ending with the running hour, one row per measure');
  for (const m of MEASURES) {
    const vals = bins.map((b) => b!.counts[m.key]), max = Math.max(1, ...vals), row = c.rows.find((r) => r.key === m.key)!;
    const bars = [...c.svg.matchAll(new RegExp(`<path d="M[^"]*? v(-?[\\d.]+) [^"]*" fill="${CHART.bar}" data-m="${m.key}" data-h="(\\d+)" data-v="(\\d+)"`, 'g'))].map((x) => ({ rise: -Number(x[1]), h: Number(x[2]), v: Number(x[3]) }));
    ok(row.max === max && bars.length === vals.filter((v) => v > 0).length && bars.every((b) => b.v === bins[b.h - c.hours[0]]!.counts[m.key]), `${m.key}: one bar per non-zero hour carrying that hour's count (own scale: max ${max})`);
    const top = bars.filter((b) => b.v === max), low = bars.filter((b) => b.v < max);
    ok(top.length > 0 && low.every((b) => b.rise <= top[0].rise + 1e-9) && bars.every((b) => bars.every((q) => (b.v > q.v ? b.rise >= q.rise - 1e-9 : true))), `${m.key}: bar height is monotone in the count`);
    ok(c.svg.includes(`每小時最多 ${max}｜合計 ${vals.reduce((a, b) => a + b, 0)}`), `${m.key}: the row states its own scale and its total`);
  }
  const fills = new Set([...c.svg.matchAll(/data-m="[a-z_]+"/g)].length ? [...c.svg.matchAll(/fill="(#[0-9a-f]{6})" data-m=/g)].map((x) => x[1]) : []);
  ok(fills.size === 1 && fills.has(CHART.bar), 'all count rows use one hue');
  ok(!/axis-right|yAxisRight|secondary/.test(c.svg) && (c.svg.match(/class="tl-hit"/g) ?? []).length === 24, 'no second axis; one hit column per hour');
  const tips = [...c.svg.matchAll(/data-tip="([^"]*)"/g)].map((x) => x[1]);
  ok(tips.length === 24 && tips[23].includes('（進行中）') && tips.every((t, i) => MEASURES.every((m) => t.includes(`${m.label_zh} ${bins[i]!.counts[m.key]}`))) && tips.every((t) => t.includes('（合成）') || t.includes('氣溫 —')), 'each hour\'s tooltip repeats that hour\'s counts; the running hour is marked; temperature is labelled synthetic');
  ok(c.svg.includes('合成情境，不是觀測') && c.svg.includes('data-temp-line="1"') && (c.svg.match(/data-temp="/g) ?? []).length === 24, 'the temperature row is the engine\'s hourly record, labelled synthetic, on its own row');
  ok((c.table.match(/<tr>/g) ?? []).length === 25 && MEASURES.every((m) => c.table.includes(m.label_zh)), 'the same numbers are available as a table');
  const emptyRow = c.rows.find((r) => r.key === 'empty')!, takeRow = c.rows.find((r) => r.key === 'take')!;
  ok(emptyRow.max > 10 * takeRow.max, `futile trips have their own row and dwarf the intakes (per-hour max ${emptyRow.max} vs ${takeRow.max})`);
  const night = (c.svg.match(/data-light="night"/g) ?? []).length, day = (c.svg.match(/data-light="day"/g) ?? []).length;
  ok(night >= 8 && day >= 10 && night + day <= 24, `the light strip shows the engine's day and night (${day} h day, ${night} h night)`);
  ok(!/<script|onclick|onload/i.test(c.svg + c.table), 'the chart is inert markup');
  const narrow = timelineChart(tl, { width: 300, now: T });
  ok(narrow.svg.includes('viewBox="0 0 300 ') && (narrow.svg.match(/class="tl-hit"/g) ?? []).length === 24, 'the chart fits a phone sheet (300 px) with all 24 hours');
  summary.chart = { rows: c.rows };
}

// 5. observation only
{
  const a = P0a2ExperimentWorld.create('exp-demo2-timeline', 7), b = P0a2ExperimentWorld.create('exp-demo2-timeline', 7), tl = new Timeline();
  const deepFreeze = (o: unknown): unknown => { if (o && typeof o === 'object') { for (const v of Object.values(o as object)) deepFreeze(v); Object.freeze(o); } return o; };
  for (let s = 900; s <= 3 * HOUR_S; s += 900) { const ev = a.world.advanceTo(s).events; tl.onEvents(deepFreeze(ev) as EventMsg[]); tl.noteFrame(s, (a.world.frame() as unknown as P0a2FrameMsg).env.light as Light); timelineChart(tl, { width: 360, now: s }); b.world.advanceTo(s); }
  ok(a.world.snapshot().payload_sha256 === b.world.snapshot().payload_sha256 && JSON.stringify(a.world.chainState()) === JSON.stringify(b.world.chainState()), 'the observed world is identical to the unobserved one (payload hash, event chain)');
  const src = read('web/src/demo2/timeline.ts'), imports = [...src.matchAll(/^import .* from '([^']+)';$/gm)].map((m) => m[1]);
  ok(imports.length === 1 && imports[0] === '../experimental/worker-protocol.ts' && !/^import \{/m.test(src), 'timeline.ts imports only the protocol TYPES');
  ok(!/Math\.random|Date\.now|performance\.|postMessage|\bclient\b|localStorage|indexedDB|fetch\(|p0a2-24h/.test(src), 'timeline.ts has no clock, no randomness, no storage, no Worker command');
  const main = read('web/src/demo2/main.ts');
  ok(/timeline\.onEvents\(evs\)/.test(main) && /timeline\.reset\(\)/.test(main) && /timeline\.noteFrame\(frame\.t_sim, frame\.env\.light/.test(main), 'main.ts feeds every event batch and the shown frames\' light state to the timeline and resets it with the world');
  ok(/現在是空的/.test(main) && /空的<\/b>（0 份）/.test(main) && /占到場的/.test(main), 'the page says in words when the source is empty and what share of arrivals found it empty');
}

console.log(JSON.stringify({ test: 'web-demo2-timeline', checks, ...summary }));
