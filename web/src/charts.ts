/**
 * V4 daily ecology charts: small multiples (one measure per chart, one y-axis each — never two scales), drawn as SVG from
 * model.dailySeries (engine end-of-day states and day summaries, copied, never smoothed). Each chart has a legend row and
 * direct end labels for identity (not colour alone), a marker for the day shown on the map, a hover readout, and a click
 * that moves the map to that day. A table view lists the same numbers. No engine import, no writes.
 */
import type { DayPoint } from './model.ts';

export interface ChartSpec { id: string; title: string; unit: string; series: { key: keyof DayPoint; label: string }[]; zeroBased: boolean; note?: string }
export const CHARTS: ChartSpec[] = [
  { id: 'workers', title: '工蟻數（日終）', unit: '隻', series: [{ key: 'workers', label: '工蟻' }], zeroBased: true },
  { id: 'brood', title: '幼體（日終）', unit: '個', series: [{ key: 'eggs', label: '卵' }, { key: 'larvae', label: '幼蟲' }, { key: 'pupae', label: '蛹' }], zeroBased: true },
  { id: 'stores', title: '巢內存糧（日終）', unit: '份', series: [{ key: 'store_sugar', label: '糖' }, { key: 'store_protein', label: '蛋白' }], zeroBased: true },
  { id: 'garden', title: '花園食源存量（日終，觀察者視角）', unit: '份', series: [{ key: 'garden_sugar', label: '糖' }, { key: 'garden_protein', label: '蛋白' }], zeroBased: true, note: '螞蟻不知道這個總量；只供玩家觀察' },
  { id: 'temp', title: '氣溫與巢溫（當日）', unit: '°C', series: [{ key: 'air_c', label: '氣溫' }, { key: 'nest_c', label: '巢溫' }], zeroBased: false, note: '天氣為模型輸入（合成或歷年統計），不是量測' },
];

const W = 340, H = 118, PL = 34, PR = 44, PT = 10, PB = 20;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const fmt = (v: number | null, unit: string) => (v === null ? '—' : `${Number.isInteger(v) ? v : v.toFixed(2)} ${unit}`);
function niceMax(v: number) { if (v <= 0) return 1; const p = Math.pow(10, Math.floor(Math.log10(v))), m = v / p; return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p; }

/** SVG markup of one chart. `day` = the day shown on the map (marker). */
export function chartSvg(spec: ChartSpec, pts: DayPoint[], day: number): string {
  const vals = pts.flatMap((p) => spec.series.map((s) => p[s.key] as number | null)).filter((v): v is number => v !== null && Number.isFinite(v));
  if (!vals.length) return `<p class="note">${esc(spec.title)}：沒有紀錄</p>`;
  let lo = spec.zeroBased ? 0 : Math.floor(Math.min(...vals) - 1), hi = spec.zeroBased ? niceMax(Math.max(...vals)) : Math.ceil(Math.max(...vals) + 1);
  if (hi <= lo) hi = lo + 1;
  const d0 = pts[0].day, d1 = pts[pts.length - 1].day, x = (d: number) => PL + ((d - d0) / Math.max(1, d1 - d0)) * (W - PL - PR), y = (v: number) => PT + (1 - (v - lo) / (hi - lo)) * (H - PT - PB);
  const grid = [lo, (lo + hi) / 2, hi].map((g) => `<line class="grid" x1="${PL}" x2="${W - PR}" y1="${y(g)}" y2="${y(g)}"/><text class="tick" x="${PL - 4}" y="${y(g) + 3}" text-anchor="end">${Number.isInteger(g) ? g : g.toFixed(1)}</text>`).join('');
  const xt = [d0, Math.round((d0 + d1) / 2), d1].map((d) => `<text class="tick" x="${x(d)}" y="${H - 5}" text-anchor="middle">D${d}</text>`).join('');
  const lines = spec.series.map((s, i) => `<polyline class="s${i + 1}" points="${pts.filter((q) => q[s.key] !== null).map((q) => `${x(q.day).toFixed(1)},${y(q[s.key] as number).toFixed(1)}`).join(' ')}"/>`).join('');
  // direct end labels, pushed apart vertically (at least 10 units) so series ending at the same value stay readable
  const ends = spec.series.map((s) => { const last = [...pts].reverse().find((q) => q[s.key] !== null); return last ? { label: s.label, x: x(last.day) + 4, y: y(last[s.key] as number) + 3 } : null; }).filter((e): e is { label: string; x: number; y: number } => !!e).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 10) ends[i].y = ends[i - 1].y + 10;
  const over = ends.length ? Math.max(0, ends[ends.length - 1].y - (H - PB + 3)) : 0;
  const labels = ends.map((e) => `<text class="dlabel" x="${e.x}" y="${(e.y - over).toFixed(1)}">${esc(e.label)}</text>`).join('');
  const marker = day >= d0 && day <= d1 ? `<line class="now" x1="${x(day)}" x2="${x(day)}" y1="${PT}" y2="${H - PB}"/>` : '';
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(spec.title)}" data-chart="${spec.id}" data-d0="${d0}" data-d1="${d1}" data-pl="${PL}" data-pr="${PR}">${grid}${xt}${marker}${lines}${labels}<rect class="hit" x="${PL}" y="${PT}" width="${W - PL - PR}" height="${H - PT - PB}"/></svg>`;
}

/** The whole panel: legend row + chart per spec. */
export function panelHtml(pts: DayPoint[], day: number): string {
  return CHARTS.map((c) => `<figure class="chart" data-chart="${c.id}"><figcaption><b>${esc(c.title)}</b>${c.series.length > 1 ? ` <span class="legend-row">${c.series.map((s, i) => `<span><i class="sw s${i + 1}"></i>${esc(s.label)}</span>`).join('')}</span>` : ''}${c.note ? `<span class="note"> ${esc(c.note)}</span>` : ''}</figcaption>${chartSvg(c, pts, day)}<div class="readout" aria-live="polite"></div></figure>`).join('');
}

/** Values of every chart at one day, for the hover readout and tests. */
export function readout(spec: ChartSpec, p: DayPoint): string {
  return `D${p.day}（${p.date}）` + spec.series.map((s) => `　${s.label} ${fmt(p[s.key] as number | null, spec.unit)}`).join('');
}

/** Table view of the same numbers (accessibility; the light-theme series colours are below 3:1 contrast). */
export function tableHtml(pts: DayPoint[]): string {
  const cols: [keyof DayPoint, string][] = [['day', '日'], ['workers', '工蟻'], ['eggs', '卵'], ['larvae', '幼蟲'], ['pupae', '蛹'], ['store_sugar', '巢內糖'], ['store_protein', '巢內蛋白'], ['income_sugar', '收入糖'], ['income_protein', '收入蛋白'], ['garden_sugar', '花園糖'], ['garden_protein', '花園蛋白'], ['eggs_laid', '產卵'], ['eclosions', '羽化'], ['deaths', '工蟻死亡'], ['air_c', '氣溫°C'], ['nest_c', '巢溫°C'], ['rain_mm', '雨 mm']];
  const cell = (v: unknown) => (v === null ? '—' : typeof v === 'number' && !Number.isInteger(v) ? v.toFixed(2) : String(v));
  return `<div class="tablewrap"><table><thead><tr>${cols.map(([, h]) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${pts.map((p) => `<tr>${cols.map(([k]) => `<td>${cell(p[k])}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/** Day under a pointer x (CSS px) on a chart svg. */
/** The few members of an SVG element this needs (structural, so Node tests type-check without the DOM library). */
export interface ChartSvgLike { getBoundingClientRect(): { left: number; width: number }; viewBox: { baseVal: { width: number } }; dataset: Record<string, string | undefined> }
export function dayAtX(svg: ChartSvgLike, clientX: number): number {
  const r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, sx = ((clientX - r.left) / r.width) * vb.width;
  const d0 = Number(svg.dataset.d0), d1 = Number(svg.dataset.d1), pl = Number(svg.dataset.pl), pr = Number(svg.dataset.pr);
  const f = (sx - pl) / (vb.width - pl - pr);
  return Math.max(d0, Math.min(d1, Math.round(d0 + f * (d1 - d0))));
}
