/**
 * V6 Game View — replay navigation helpers (Issue #148). Pure, DOM-free. Everything here only chooses WHERE TO LOOK
 * in the engine record (a viewing minute, a mark position, a summary list); nothing creates an event, changes a
 * recorded time or runs the simulation.
 *  - nextActivityJump: the explicit 「跳到下一段活動」 control. Lands just before the next recorded walk start (as the
 *    automatic idle skip does) and never jumps over the start of a recorded walk; when no walk starts later in the
 *    day's activity window it says so instead of inventing a target.
 *  - timelineMarks: one mark per recorded walk interval (exactly game-model.walkIntervals, i.e. the engine's
 *    worker_activity segments on an edge), as fractions of the activity window, for drawing under the time slider.
 *  - daySummary: the day-summary mode. Events with a recorded minute keep that minute; events WITHOUT a minute-level
 *    record are only listed as day-level (never placed at a time).
 */
import { describeEvent, isTimed, windowOf, type ExperimentDay, type SimEvent } from './model.ts';
import { nextWalkStart, settlementSummary } from './game-model.ts';

export type Walk = { start: number; end: number };

/** Simulated minutes the jump lands before a walk start (same 3 simulated seconds as the automatic idle skip). */
export const JUMP_LEAD_MIN = 3 / 60;

export type JumpResult =
  | { kind: 'jump'; target: number; walkStart: number; walksStarting: number }
  | { kind: 'none'; reason: string };

/**
 * The explicit next-activity jump from the current viewing minute t.
 * walkStart = the earliest recorded walk start strictly after t (found with game-model.nextWalkStart over the walks
 * that have not started yet, so it is a recorded start inside the activity window). The landing minute is
 * walkStart − lead, but never before t; if that would not move (the start is within the lead), it lands exactly on the
 * start so that repeated presses always progress. Invariant: no recorded walk starts strictly between t and target,
 * and target ≤ walkStart, so the start of every recorded walk is either already behind t or still ahead.
 */
export function nextActivityJump(walks: Walk[], d: ExperimentDay, t: number, lead = JUMP_LEAD_MIN): JumpResult {
  const ahead = walks.filter((w) => w.start > t);
  const s = nextWalkStart(ahead, d, t);
  if (s === null) return { kind: 'none', reason: `第 ${d.day} 日活動時段內，此刻之後引擎沒有記錄任何行走開始` };
  let target = Math.max(t, s - lead);
  if (target - t < 1e-9) target = s;
  return { kind: 'jump', target, walkStart: s, walksStarting: walks.filter((w) => w.start === s).length };
}

export interface TimelineMark { start: number; end: number; left: number; width: number }
/** One mark per recorded walk interval, same order and same start/end as walkIntervals; left/width are fractions of
 *  the activity window (clamped to [0, 1]). The renderer may widen a mark to a visible minimum (drawing only). */
export function timelineMarks(walks: Walk[], win: number): TimelineMark[] {
  const f = (x: number) => (win > 0 ? Math.min(1, Math.max(0, x / win)) : 0);
  return walks.map((w) => ({ start: w.start, end: w.end, left: f(w.start), width: f(w.end) - f(w.start) }));
}

/** Viewing minute for a pointer position on the timeline strip (fraction 0..1 of its width); display only. */
export function minuteAtFraction(frac: number, win: number): number { return Math.min(win, Math.max(0, frac * win)); }

export interface SummaryGroup { type: string; count: number; label: string }
export interface TimedGroup extends SummaryGroup { first: number; last: number }
export interface DayLevelGroup extends SummaryGroup { items: string[] }
export interface DaySummary {
  day: number; date: string; window: number; walks: number;
  /** event types with a recorded minute (minute or segment start), with the first/last recorded minute */
  timed: TimedGroup[];
  /** event types with NO minute-level record: listed for the day only, never placed at a time */
  dayLevel: DayLevelGroup[];
  settlement: { deaths: number; eclosions: number; eggs: number };
}
const minuteOf = (e: SimEvent) => (typeof e.minute === 'number' ? e.minute : (e.start as number));
const labelOf = (e: SimEvent) => describeEvent(e).split(' ')[0];

/** Day summary. Movement records (worker_activity, route_step) are counted as walks, not listed. */
export function daySummary(d: ExperimentDay, walks: Walk[]): DaySummary {
  const timed = new Map<string, TimedGroup>(), dayLevel = new Map<string, DayLevelGroup>();
  for (const e of d.events) {
    if (e.type === 'worker_activity' || e.type === 'route_step') continue;
    if (isTimed(e)) {
      const m = minuteOf(e), g = timed.get(e.type);
      if (g) { g.count++; g.first = Math.min(g.first, m); g.last = Math.max(g.last, m); }
      else timed.set(e.type, { type: e.type, label: labelOf(e), count: 1, first: m, last: m });
    } else {
      const g = dayLevel.get(e.type), text = describeEvent(e);
      if (g) { g.count++; g.items.push(text); } else dayLevel.set(e.type, { type: e.type, label: labelOf(e), count: 1, items: [text] });
    }
  }
  const byCount = <T extends SummaryGroup>(a: T, b: T) => b.count - a.count || a.type.localeCompare(b.type);
  return { day: d.day, date: d.date, window: windowOf(d), walks: walks.length, timed: [...timed.values()].sort(byCount), dayLevel: [...dayLevel.values()].sort(byCount), settlement: settlementSummary(d) };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const mm = (x: number) => { const m = Math.floor(x), s = Math.round((x - m) * 60); return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`; };

/** HTML for the summary panel (strings only; the page inserts it). Day-level items are capped per type for length. */
export function summaryHtml(s: DaySummary, cap = 30): string {
  const timed = s.timed.length ? `<table><thead><tr><th>事件</th><th>筆數</th><th>引擎紀錄的時刻（首～末，分:秒）</th></tr></thead><tbody>${s.timed.map((g) => `<tr><td>${esc(g.label)}</td><td>${g.count}</td><td>${mm(g.first)}～${mm(g.last)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">沒有帶分鐘紀錄的事件。</p>';
  const day = s.dayLevel.length ? s.dayLevel.map((g) => `<details><summary>${esc(g.label)}：${g.count} 筆</summary><ul>${g.items.slice(0, cap).map((x) => `<li>${esc(x)}</li>`).join('')}${g.count > cap ? `<li class="muted">另 ${g.count - cap} 筆</li>` : ''}</ul></details>`).join('') : '<p class="muted">沒有日層級事件。</p>';
  return `<div class="sum-label">日摘要，非連續播放</div>
<h2>第 ${s.day} 日（${esc(s.date)}）</h2>
<p>活動時段 ${s.window} 分鐘；引擎紀錄的行走 ${s.walks} 段。日終結算：工蟻死亡 ${s.settlement.deaths}、羽化 ${s.settlement.eclosions}、產卵 ${s.settlement.eggs}。</p>
<h3>有分鐘紀錄的事件</h3>${timed}
<h3>日層級事件（引擎沒有記錄時刻，不放在任何時間點）</h3>${day}`;
}
