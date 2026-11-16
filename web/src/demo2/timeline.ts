/**
 * Demo 2 — D2E-3: the food source and the environment as the ENGINE has them, and a 24-hour activity timeline built from
 * engine events. Pure: no DOM, no Three.js, no engine / Worker / cli import, no clock. Read only.
 *
 *  - HOURLY BINS: every event the page receives is added to the bin of its world hour (floor(t / 3600 s)): exits,
 *    arrivals at the source with food / with none, trophallaxis transfers, larva feeds, honeydew drops. Exact counts
 *    (tests/web-demo2-timeline.test.ts reconciles them hour by hour with an independent Node replay).
 *    An hour the page did not see (it opened later) has NO bin: the chart shows «無資料», never a zero.
 *  - ENVIRONMENT per hour: the temperature of the engine's hourly weather record (env_sample; SYNTHETIC scenario) and the
 *    light state (env_light events, and the light state of the frames the page was shown).
 *  - SOURCE: honeydew drops (produce events: when, how much, stock after), arrivals with / without food.
 *
 * The chart is small multiples: one measure per row, each with its own scale and a shared hour axis (no second y-axis),
 * one hue for all counts, the light state as a labelled strip, the synthetic temperature as its own row. Hover / tap
 * shows the hour's values; the same numbers are in a table below. Everything shown is engine data; nothing is smoothed,
 * predicted or filled in.
 */
import type { EventMsg } from '../experimental/worker-protocol.ts';

export const HOUR_S = 3600;
export type Measure = 'exit' | 'empty' | 'take' | 'transfer' | 'larva_fed' | 'produce';
export const MEASURES: readonly { key: Measure; label_zh: string }[] = [
  { key: 'exit', label_zh: '出巢' },
  { key: 'empty', label_zh: '到食源：是空的' },
  { key: 'take', label_zh: '到食源：有取食' },
  { key: 'transfer', label_zh: '交哺（有轉移）' },
  { key: 'larva_fed', label_zh: '餵幼蟲' },
  { key: 'produce', label_zh: '蜜露滴出（合成）' },
];
export type Light = 'night' | 'civil_twilight' | 'day';
export const LIGHT_ZH: Record<Light, string> = { night: '夜', civil_twilight: '曙暮光', day: '日' };
export interface HourBin {
  /** absolute world hour index (floor(t_sim / 3600)) */
  h: number;
  counts: Record<Measure, number>;
  /** the engine's hourly weather record at the START of this hour (°C; synthetic scenario), null if the page did not get it */
  temp_c: number | null;
  rh_percent: number | null;
  /** first and last instant of this hour the page has events / frames for (s) */
  from: number; to: number;
}
const zero = (): Record<Measure, number> => ({ exit: 0, empty: 0, take: 0, transfer: 0, larva_fed: 0, produce: 0 });

export interface SourceState {
  drops: number; dropped_up: number; last_drop_t: number | null; last_drop_up: number | null; stock_after_last_drop_up: number | null;
  arrivals_take: number; arrivals_empty: number; taken_up: number;
  /** arrivals since the last drop: with food / with none */
  since_drop_take: number; since_drop_empty: number;
}

export class Timeline {
  private bins = new Map<number, HourBin>();
  /** light state changes in time order: from engine env_light events and from the frames shown ({t, to}) */
  readonly light: { t: number; to: Light }[] = [];
  first_t: number | null = null; last_t: number | null = null;
  readonly source: SourceState = { drops: 0, dropped_up: 0, last_drop_t: null, last_drop_up: null, stock_after_last_drop_up: null, arrivals_take: 0, arrivals_empty: 0, taken_up: 0, since_drop_take: 0, since_drop_empty: 0 };
  reset() { this.bins.clear(); this.light.length = 0; this.first_t = this.last_t = null; Object.assign(this.source, { drops: 0, dropped_up: 0, last_drop_t: null, last_drop_up: null, stock_after_last_drop_up: null, arrivals_take: 0, arrivals_empty: 0, taken_up: 0, since_drop_take: 0, since_drop_empty: 0 }); }
  private bin(t: number): HourBin {
    const h = Math.floor(t / HOUR_S); let b = this.bins.get(h);
    if (!b) { b = { h, counts: zero(), temp_c: null, rh_percent: null, from: t, to: t }; this.bins.set(h, b); }
    if (t < b.from) b.from = t; if (t > b.to) b.to = t;
    return b;
  }
  private noteLight(t: number, to: Light) { const L = this.light, last = L[L.length - 1]; if (!last || (last.to !== to && t >= last.t)) L.push({ t, to }); }

  onEvents(events: readonly EventMsg[]) {
    for (const e of events) {
      const t = e.t_sim, d = e.data as Record<string, unknown>, b = this.bin(t), S = this.source;
      if (this.first_t === null) this.first_t = t; this.last_t = t;
      const atSource = () => {
        if (d.heat === true) return;
        if (typeof d.take === 'number' && d.take > 0) { b.counts.take++; S.arrivals_take++; S.since_drop_take++; S.taken_up += d.take; }
        else { b.counts.empty++; S.arrivals_empty++; S.since_drop_empty++; }
      };
      switch (e.kind) {
        case 'at_entrance': if (d.choice === 'exit') b.counts.exit++; break;
        case 'arrive_source': atSource(); break;
        case 'search_end': if (d.found) atSource(); break;
        case 'arrive_nest': if (Array.isArray(d.touched)) for (const x of d.touched as { amount: number }[]) if (x.amount > 0) b.counts.transfer++; break;
        case 'produce': {
          b.counts.produce++; S.drops++; S.last_drop_t = t; S.since_drop_take = 0; S.since_drop_empty = 0;
          if (typeof d.amount === 'number') { S.dropped_up += d.amount; S.last_drop_up = d.amount; }
          S.stock_after_last_drop_up = typeof d.stock === 'number' ? d.stock : null; break;
        }
        case 'env_sample': if (t === b.h * HOUR_S) { b.temp_c = typeof d.temp_c === 'number' ? d.temp_c : null; b.rh_percent = typeof d.rh_percent === 'number' ? d.rh_percent : null; } break;
        case 'env_light': if (d.to === 'night' || d.to === 'civil_twilight' || d.to === 'day') this.noteLight(t, d.to); break;
        default: break;
      }
      for (const key of ['larvae'] as const) if (Array.isArray(d[key])) for (const x of d[key] as { fed: number }[]) if (x.fed > 0) b.counts.larva_fed++;
    }
  }
  /** the light state of a frame the page was shown (engine state): fills the strip before the first env_light event seen */
  noteFrame(t: number, light: Light) { if (this.first_t === null) this.first_t = t; if (this.last_t === null || t > this.last_t) this.last_t = t; this.bin(t); this.noteLight(t, light); }

  /** the bins of the `n` world hours ending with the hour of `now` (oldest first); null = the page has nothing for that hour */
  window(now: number, n = 24): (HourBin | null)[] {
    const h1 = Math.floor(now / HOUR_S), out: (HourBin | null)[] = [];
    for (let h = h1 - n + 1; h <= h1; h++) { const b = h >= 0 ? this.bins.get(h) : undefined; out.push(b ? { ...b, counts: { ...b.counts } } : null); }
    return out;
  }
  /** all bins, oldest first (tests) */
  all(): HourBin[] { return [...this.bins.values()].sort((a, b) => a.h - b.h).map((b) => ({ ...b, counts: { ...b.counts } })); }
  /** the light state at instant t as far as the page knows it (null = before anything was seen) */
  lightAt(t: number): Light | null { let cur: Light | null = null; for (const x of this.light) { if (x.t <= t) cur = x.to; else break; } return cur; }
}

// ------------------------------------------------------------------ the chart (SVG string; small multiples)
/** chart colours (dark panel surface #1a140e). One hue for every count row (validated: dataviz validator, dark mode,
 *  contrast ≥ 3:1 on the panel surface); light-state strip and ink are neutral, never the data colour. */
export const CHART = { bar: '#3987e5', line: '#3987e5', ink: '#f0efec', ink2: '#c3c2b7', muted: '#a09c90', grid: '#3a332b', strip: { night: '#24222b', civil_twilight: '#4a4338', day: '#6b6250' } as Record<Light, string>, nodata: '#2a231b' } as const;
const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const hh = (h: number) => `${String(((h % 24) + 24) % 24).padStart(2, '0')}`;
const dayOf = (h: number) => Math.floor(h / 24);

export interface ChartOpts { width: number; now: number; hours?: number }
export interface ChartOut { svg: string; table: string; rows: { key: string; max: number }[]; hours: number[] }

/**
 * The 24-hour chart. `now` = the display instant (the last column is the running hour and is marked so). Returns the SVG,
 * the same numbers as an HTML table, and what was drawn (for tests).
 */
export function timelineChart(tl: Timeline, o: ChartOpts): ChartOut {
  const n = o.hours ?? 24, W = Math.max(280, Math.round(o.width)), bins = tl.window(o.now, n), h1 = Math.floor(o.now / HOUR_S), h0 = h1 - n + 1;
  const left = 4, right = 4, plotW = W - left - right, colW = plotW / n, barW = Math.max(3, Math.min(24, colW - 2));
  const ROW_H = 34, LABEL_H = 15, STRIP_H = 14, AXIS_H = 16, TEMP_H = 40;
  const x = (i: number) => left + i * colW;
  let y = 0; const parts: string[] = [], rowsOut: { key: string; max: number }[] = [];
  // light strip (engine light state; a labelled strip, not a data colour)
  parts.push(`<text x="${left}" y="${y + 11}" class="tl-t">光照（引擎）</text>`); y += LABEL_H;
  for (let i = 0; i < n; i++) {
    const h = h0 + i, mid = (h + 0.5) * HOUR_S, L = bins[i] ? tl.lightAt(Math.min(mid, tl.last_t ?? mid)) : null;
    parts.push(`<rect x="${x(i).toFixed(1)}" y="${y}" width="${Math.max(1, colW - 1).toFixed(1)}" height="${STRIP_H}" fill="${L ? CHART.strip[L] : CHART.nodata}" data-light="${L ?? 'none'}"/>`);
  }
  { // one text label per run of the same light state
    let i = 0; while (i < n) { const mid = (h0 + i + 0.5) * HOUR_S, L = bins[i] ? tl.lightAt(Math.min(mid, tl.last_t ?? mid)) : null; let j = i; while (j + 1 < n && (bins[j + 1] ? tl.lightAt(Math.min((h0 + j + 1.5) * HOUR_S, tl.last_t ?? 0)) : null) === L) j++; if ((j - i + 1) * colW >= 22) parts.push(`<text x="${(x(i) + ((j - i + 1) * colW) / 2).toFixed(1)}" y="${y + 11}" class="tl-s" text-anchor="middle">${L ? LIGHT_ZH[L] : h0 + j < 0 ? '世界開始之前' : '無資料'}</text>`); i = j + 1; }
  }
  y += STRIP_H + 6;
  // count rows: each its own scale (stated in the row title), bars from a common baseline
  for (const m of MEASURES) {
    const vals = bins.map((b) => (b ? b.counts[m.key] : null)), max = Math.max(1, ...vals.map((v) => v ?? 0)), total = vals.reduce((a: number, v) => a + (v ?? 0), 0);
    rowsOut.push({ key: m.key, max });
    parts.push(`<text x="${left}" y="${y + 11}" class="tl-t">${esc(m.label_zh)}</text><text x="${W - right}" y="${y + 11}" class="tl-n" text-anchor="end">每小時最多 ${max}｜合計 ${total}</text>`); y += LABEL_H;
    const base = y + ROW_H - 4;
    parts.push(`<line x1="${left}" x2="${W - right}" y1="${base}" y2="${base}" stroke="${CHART.grid}" stroke-width="1"/>`);
    vals.forEach((v, i) => {
      const cx = x(i) + (colW - barW) / 2;
      if (v === null) { parts.push(`<rect x="${x(i).toFixed(1)}" y="${y}" width="${Math.max(1, colW - 1).toFixed(1)}" height="${ROW_H - 4}" fill="${CHART.nodata}" data-nodata="1"/>`); return; }
      const bh = v === 0 ? 0 : Math.max(2, ((ROW_H - 6) * v) / max), r = Math.min(4, barW / 2, bh);
      if (bh > 0) parts.push(`<path d="M${cx.toFixed(1)},${base} v${(-(bh - r)).toFixed(1)} q0,${-r} ${r},${-r} h${(barW - 2 * r).toFixed(1)} q${r},0 ${r},${r} v${(bh - r).toFixed(1)} z" fill="${CHART.bar}" data-m="${m.key}" data-h="${h0 + i}" data-v="${v}"/>`);
    });
    y += ROW_H;
  }
  // temperature row (synthetic scenario): its own row and scale, a 2 px line through the hourly records
  const temps = bins.map((b) => (b ? b.temp_c : null)), known = temps.filter((v): v is number => v !== null);
  parts.push(`<text x="${left}" y="${y + 11}" class="tl-t">氣溫（引擎的逐時紀錄；合成情境，不是觀測）</text>`);
  if (known.length) {
    const lo = Math.min(...known), hi = Math.max(...known), span = Math.max(0.5, hi - lo), ty = (v: number) => y + LABEL_H + 4 + (TEMP_H - 12) * (1 - (v - lo) / span);
    parts.push(`<text x="${W - right}" y="${y + 11}" class="tl-n" text-anchor="end">${lo.toFixed(1)}～${hi.toFixed(1)}°C</text>`);
    let dAttr = '', pen = false;
    temps.forEach((v, i) => { if (v === null) { pen = false; return; } const px = x(i) + colW / 2; dAttr += `${pen ? 'L' : 'M'}${px.toFixed(1)},${ty(v).toFixed(1)} `; pen = true; });
    parts.push(`<path d="${dAttr.trim()}" fill="none" stroke="${CHART.line}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" data-temp-line="1"/>`);
    temps.forEach((v, i) => { if (v !== null) parts.push(`<circle cx="${(x(i) + colW / 2).toFixed(1)}" cy="${ty(v).toFixed(1)}" r="2.5" fill="${CHART.line}" data-temp="${v}" data-h="${h0 + i}"/>`); });
  } else parts.push(`<text x="${W - right}" y="${y + 11}" class="tl-n" text-anchor="end">尚未收到逐時紀錄</text>`);
  y += LABEL_H + TEMP_H;
  // shared hour axis
  for (let i = 0; i < n; i++) { const h = h0 + i; if (h >= 0 && ((h % 24) % 3 === 0 || i === n - 1)) parts.push(`<text x="${(x(i) + colW / 2).toFixed(1)}" y="${y + 12}" class="tl-s" text-anchor="middle">${hh(h)}${i === n - 1 ? '▸' : ''}</text>`); }
  y += AXIS_H;
  // hit columns (wider than the marks): one per hour, the tooltip text in data-tip
  const tip = (i: number) => { const b = bins[i], h = h0 + i; if (h < 0) return '世界開始之前（沒有這個小時）'; if (!b) return `第 ${dayOf(h)} 天 ${hh(h)}:00｜無資料（本頁當時尚未開啟）`; const L = tl.lightAt(Math.min((h + 0.5) * HOUR_S, tl.last_t ?? 0)); return `第 ${dayOf(h)} 天 ${hh(h)}:00～${hh(h + 1)}:00${h === h1 ? '（進行中）' : ''}｜${MEASURES.map((m) => `${m.label_zh} ${b.counts[m.key]}`).join('｜')}｜光照 ${L ? LIGHT_ZH[L] : '—'}｜氣溫 ${b.temp_c === null ? '—' : `${b.temp_c.toFixed(1)}°C（合成）`}`; };
  for (let i = 0; i < n; i++) parts.push(`<rect class="tl-hit" x="${x(i).toFixed(1)}" y="0" width="${colW.toFixed(1)}" height="${y}" fill="transparent" data-i="${i}" data-tip="${esc(tip(i))}"/>`);
  const svg = `<svg class="tl" viewBox="0 0 ${W} ${y}" width="${W}" height="${y}" role="img" aria-label="最近 ${n} 小時的引擎事件與環境（每列一個量，各自的刻度）"><style>.tl-t{font-size:11.5px;fill:${CHART.ink}}.tl-n{font-size:10.5px;fill:${CHART.ink2};font-variant-numeric:tabular-nums}.tl-s{font-size:10px;fill:${CHART.ink}}</style>${parts.join('')}</svg>`;
  const table = `<table class="tl-table"><tr><th>小時</th>${MEASURES.map((m) => `<th class="n">${esc(m.label_zh)}</th>`).join('')}<th>光照</th><th class="n">氣溫（合成）</th></tr>${bins.map((b, i) => { const h = h0 + i; if (h < 0) return ''; if (!b) return `<tr><td>第 ${dayOf(h)} 天 ${hh(h)}</td><td colspan="${MEASURES.length + 2}" class="muted">無資料</td></tr>`; const L = tl.lightAt(Math.min((h + 0.5) * HOUR_S, tl.last_t ?? 0)); return `<tr><td>第 ${dayOf(h)} 天 ${hh(h)}${h === h1 ? '（進行中）' : ''}</td>${MEASURES.map((m) => `<td class="n">${b.counts[m.key]}</td>`).join('')}<td>${L ? LIGHT_ZH[L] : '—'}</td><td class="n">${b.temp_c === null ? '—' : b.temp_c.toFixed(1)}</td></tr>`; }).join('')}</table>`;
  return { svg, table, rows: rowsOut, hours: bins.map((_, i) => h0 + i) };
}
