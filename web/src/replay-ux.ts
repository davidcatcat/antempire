/**
 * V6 Game View — replay navigation helpers (Issue #148). Pure, DOM-free. Everything here only chooses WHERE TO LOOK
 * in the engine record (a viewing minute, a mark position, a summary list); nothing creates an event, changes a
 * recorded time or runs the simulation.
 *  - nextActivityJump: the explicit 「跳到下一段活動」 control. Lands just before the next recorded walk start (as the
 *    automatic idle skip does) and never jumps over the start of a recorded walk; when no walk starts later in the
 *    day's activity window it says so instead of inventing a target.
 *  - timelineMarks: one mark per recorded walk interval (exactly game-model.walkIntervals, i.e. the engine's
 *    worker_activity segments on an edge), as fractions of the activity window, for drawing under the time slider.
 *  - jumpNote (Issue #191 Q1/Q2): what an explicit jump skipped (viewing minutes, walks in progress that are not played
 *    to their end) and which of the three landing steps it reached, so the page can label it 「跳轉」.
 *  - dayRecordSummary (Issue #191 Q4): population, births / deaths, foraging, stock changes and per-ant tasks, each
 *    figure copied (or summed / differenced) from named fields of the exported record, with those fields as its
 *    source; a quantity the record does not hold is null (shown 「引擎未記錄」), never estimated.
 *  - daySummary: the day-summary mode. Events with a recorded minute keep that minute; events WITHOUT a minute-level
 *    record are only listed as day-level (never placed at a time).
 */
import { describeEvent, isTimed, windowOf, TASK_LABEL, type ColonySnap, type Experiment, type ExperimentDay, type SimEvent } from './model.ts';
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

/**
 * The three landing steps of repeated presses (Issue #191 Q1, kept by the Owner): 1) about 3 simulated seconds before
 * the next recorded walk start, 2) exactly on that start, 3) before the following start. Text for the inline hint.
 */
export const JUMP_HINT = '「下一段活動」是跳轉，不是連續播放：第 1 次按停在下一段引擎紀錄的行走開始前約 3 秒；再按一次到行走開始的那一刻；再按就到下一段行走前約 3 秒。只改變觀看時刻，不跳過任何行走的開始。';

export interface JumpNote {
  /** viewing minutes skipped by the jump (target − t) */
  skippedMin: number;
  /** recorded walks under way at t (start ≤ t < end) whose rest is not played continuously because of the jump */
  inProgress: number;
  /** 'lead' = landed before the walk start; 'start' = landed exactly on it */
  stage: 'lead' | 'start';
}
/** Describes a jump from t (Issue #191 Q2: jumping while a walk is in progress is allowed but labelled 「跳轉」). */
export function jumpNote(walks: Walk[], t: number, r: { target: number; walkStart: number }): JumpNote {
  return { skippedMin: r.target - t, inProgress: walks.filter((w) => w.start <= t && w.end > t).length, stage: r.walkStart - r.target > 1e-9 ? 'lead' : 'start' };
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

// ------------------------------------------------------------------ day record summary (Issue #191 Q4)
/** One shown figure. value = the record value (or a sum / difference of record values, said in src); null = the
 *  record does not hold this quantity (shown 「引擎未記錄」). src names the exported field(s) it comes from. */
export interface Fig { key: string; label: string; value: number | string | null; src: string }
export interface FigSection { id: 'population' | 'life' | 'forage' | 'stock'; title: string; figs: Fig[]; note: string }
export interface TaskRow { id: string; task: string; label: string; trips: number; successes: number; stop_reason: string | null }
export interface DayRecordSummary { day: number; file: string; sections: FigSection[]; tasks: TaskRow[] | null; tasksSrc: string }

const STAGE_LABEL: Record<string, string> = { egg: '卵', larva: '幼蟲', pupa: '蛹' };
const STAGE_ORDER = ['egg', 'larva', 'pupa'];
const MACRO_LABEL: Record<string, string> = { sugar: '糖', protein: '蛋白質' };
/** the record is written with 6 decimals: sums / differences of record values are rounded to that (said in src) */
export const round6 = (x: number) => Number(x.toFixed(6));
const NO_TASKS = (dp: string) => `${dp}.tasks 為 null（引擎未記錄）`;

/** Start-of-day snapshot = the previous day's end_state (day0.state for day 1): the engine's own record. */
function startSnap(exp: Experiment, day: number): { snap: ColonySnap; path: string } {
  return day === 1 ? { snap: exp.day0.state, path: 'day0.state' } : { snap: exp.days[day - 2].end_state, path: `days[${day - 2}].end_state` };
}
function countBy<T>(xs: T[], k: (x: T) => string): [string, number][] {
  const m = new Map<string, number>(); for (const x of xs) m.set(k(x), (m.get(k(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** Day record summary for day `day` (1-based) of the exported replay `file`. Pure; reads only the record. */
export function dayRecordSummary(exp: Experiment, day: number, file: string): DayRecordSummary {
  const d = exp.days[day - 1], dp = `days[${day - 1}]`, S = startSnap(exp, day), E = { snap: d.end_state, path: `${dp}.end_state` };
  const ev = (type: string) => d.events.filter((e) => e.type === type);
  const evFig = (key: string, label: string, type: string): Fig => ({ key, label, value: ev(type).length, src: `${dp}.events 中 type="${type}" 的筆數` });
  const ends = [['開始', S], ['結束', E]] as const;
  // population
  const pop: Fig[] = [];
  for (const [w, s] of ends) {
    pop.push({ key: `workers_${w === '開始' ? 'start' : 'end'}`, label: `工蟻（日${w}）`, value: s.snap.workers.length, src: `${s.path}.workers 的筆數` });
    pop.push({ key: `queen_${w === '開始' ? 'start' : 'end'}`, label: `蟻后（日${w}）`, value: s.snap.queen_alive ? '存活' : '未存活', src: `${s.path}.queen_alive` });
  }
  const rank = (x: string) => { const i = STAGE_ORDER.indexOf(x); return i < 0 ? 99 : i; };
  const stages = [...new Set([...S.snap.brood, ...E.snap.brood].map((b) => b.stage))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const st of stages) for (const [w, s] of ends)
    pop.push({ key: `brood_${st}_${w === '開始' ? 'start' : 'end'}`, label: `${STAGE_LABEL[st] ?? st}（日${w}）`, value: s.snap.brood.filter((b) => b.stage === st).length, src: `${s.path}.brood 中 stage="${st}" 的筆數` });
  const casteOf = (w: unknown) => (w as Record<string, unknown>).caste;
  if (E.snap.workers.length > 0 && E.snap.workers.every((w) => typeof casteOf(w) === 'string')) {
    for (const [c, n] of countBy(E.snap.workers, (w) => String(casteOf(w)))) pop.push({ key: `caste_${c}`, label: `工蟻階級 ${c}（日結束）`, value: n, src: `${E.path}.workers 中 caste="${c}" 的筆數` });
  } else pop.push({ key: 'caste', label: '工蟻階級（大工蟻／小工蟻）', value: null, src: `${E.path}.workers 沒有階級欄位` });
  // births and deaths (end-of-day settlement: no clock time in the record)
  const life: Fig[] = [
    { key: 'worker_deaths', label: '工蟻死亡（日欄位）', value: d.worker_deaths, src: `${dp}.worker_deaths` },
    evFig('worker_death_events', '工蟻死亡事件', 'worker_death'),
    evFig('brood_death_events', '幼體死亡事件', 'brood_death'),
    evFig('queen_death_events', '蟻后死亡事件', 'queen_death'),
    { key: 'eclosions', label: '羽化（日欄位）', value: d.eclosions, src: `${dp}.eclosions` },
    evFig('eclosion_events', '羽化事件', 'eclosion'),
  ];
  for (const [c, n] of countBy(ev('eclosion').filter((e) => typeof e.caste === 'string'), (e) => String(e.caste))) life.push({ key: `eclosion_caste_${c}`, label: `羽化事件記錄的階級 ${c}`, value: n, src: `${dp}.events 中 type="eclosion" 且 caste="${c}" 的筆數` });
  life.push({ key: 'eggs_laid', label: '產卵（日欄位）', value: d.eggs_laid, src: `${dp}.eggs_laid` }, evFig('egg_laid_events', '產卵事件', 'egg_laid'), evFig('hatch_events', '孵化事件（卵→幼蟲）', 'hatch'), evFig('pupation_events', '化蛹事件', 'pupation'));
  // foraging
  const T = d.tasks, tl = T ? Object.values(T) : null;
  const forage: Fig[] = [
    { key: 'foragers', label: '當日任務為覓食的工蟻', value: tl ? tl.filter((x) => x.task === 'forage').length : null, src: T ? `${dp}.tasks 中 task="forage" 的筆數` : NO_TASKS(dp) },
    { key: 'trips', label: '出巢趟數（全部工蟻合計）', value: tl ? tl.reduce((a, x) => a + x.trips, 0) : null, src: T ? `${dp}.tasks.*.trips 的合計` : NO_TASKS(dp) },
    { key: 'successes', label: '成功趟數（全部工蟻合計）', value: tl ? tl.reduce((a, x) => a + x.successes, 0) : null, src: T ? `${dp}.tasks.*.successes 的合計` : NO_TASKS(dp) },
    evFig('food_collected', '採集事件', 'food_collected'),
    evFig('food_delivered', '卸貨（帶回巢）事件', 'food_delivered'),
  ];
  for (const [type, lab] of [['food_collected', '採集的份量'], ['food_delivered', '帶回巢的份量']] as const) {
    const xs = ev(type).filter((e) => typeof e.macro === 'string' && typeof e.portions === 'number');
    for (const m of [...new Set(xs.map((e) => e.macro as string))].sort()) forage.push({ key: `${type}_${m}`, label: `${lab}：${MACRO_LABEL[m] ?? m}`, value: round6(xs.filter((e) => e.macro === m).reduce((a, e) => a + (e.portions as number), 0)), src: `${dp}.events 中 type="${type}" 且 macro="${m}" 的 portions 合計（取到小數 6 位，與紀錄精度相同）` });
  }
  forage.push(evFig('discovery', '發現食源事件', 'discovery'), evFig('local_recruitment', '局部招募事件', 'local_recruitment'), evFig('trophallaxis', '交哺事件', 'trophallaxis'));
  forage.push({ key: 'income_sugar', label: '當日收入：糖', value: d.income.sugar, src: `${dp}.income.sugar` }, { key: 'income_protein', label: '當日收入：蛋白質', value: d.income.protein, src: `${dp}.income.protein` });
  // stock changes (colony totals: observer statistics, never an input of any ant)
  const stock: Fig[] = [];
  for (const m of ['sugar', 'protein'] as const) {
    const a = S.snap.stores[m], b = E.snap.stores[m];
    stock.push({ key: `store_${m}_start`, label: `巢內存量 ${MACRO_LABEL[m]}（日開始）`, value: a, src: `${S.path}.stores.${m}` });
    stock.push({ key: `store_${m}_end`, label: `巢內存量 ${MACRO_LABEL[m]}（日結束）`, value: b, src: `${E.path}.stores.${m}` });
    stock.push({ key: `store_${m}_delta`, label: `存量變化 ${MACRO_LABEL[m]}（結束−開始）`, value: round6(b - a), src: `${E.path}.stores.${m} − ${S.path}.stores.${m}（取到小數 6 位）` });
    stock.push({ key: `consumed_${m}`, label: `當日消耗 ${MACRO_LABEL[m]}`, value: d.consumed[m], src: `${dp}.consumed.${m}` });
  }
  const tasks = T ? Object.keys(T).sort().map((id) => ({ id, task: T[id].task, label: TASK_LABEL[T[id].task] ?? T[id].task, trips: T[id].trips, successes: T[id].successes, stop_reason: T[id].stop_reason })) : null;
  return {
    day, file, tasks, tasksSrc: T ? `${dp}.tasks（每隻工蟻當日的任務、出巢與成功趟數、停止原因）` : NO_TASKS(dp),
    sections: [
      { id: 'population', title: '蟻群人口', figs: pop, note: '日開始＝前一日的日終快照（第 1 日為 day0）。' },
      { id: 'life', title: '死亡與出生', figs: life, note: '日終結算：引擎沒有記錄這些事件的時刻，不放在任何時間點。日欄位與事件筆數分開列出，不互相修正。' },
      { id: 'forage', title: '覓食', figs: forage, note: '份量是模型單位（遊戲假設），不是實測重量。' },
      { id: 'stock', title: '存量變化', figs: stock, note: '全巢存量是玩家視角的統計，螞蟻不知道；存量變化不一定等於收入減消耗（產卵等也取用存量），這裡不互相修正。份量是模型單位。' },
    ],
  };
}

/** How a figure value is printed: strings as recorded; numbers with at most 6 decimals (the record precision). */
export const figText = (v: Fig['value']) => (v === null ? '引擎未記錄' : typeof v === 'number' ? String(round6(v)) : v);

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const mm = (x: number) => { const m = Math.floor(x), s = Math.round((x - m) * 60); return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`; };

/** HTML for the record sections (Issue #191 Q4). Every figure carries its source in title and data-src and its raw
 *  value in data-value; a 「資料來源」 list repeats the sources for touch screens (no hover there). */
export function recordHtml(r: DayRecordSummary): string {
  const fig = (f: Fig) => `<tr data-fig="${esc(f.key)}" data-value="${f.value === null ? '' : esc(String(f.value))}" data-src="${esc(f.src)}" title="來源：${esc(r.file)} → ${esc(f.src)}"><td>${esc(f.label)}</td><td class="${f.value === null ? 'muted' : 'num'}">${esc(figText(f.value))}</td></tr>`;
  const sec = (s: FigSection) => `<section class="rec" data-section="${s.id}"><h3>${esc(s.title)}</h3><table><tbody>${s.figs.map(fig).join('')}</tbody></table><p class="muted">${esc(s.note)}</p><details class="srcs"><summary>資料來源</summary>${s.figs.map((f) => `<p class="src">${esc(f.label)}：<code>${esc(f.src)}</code></p>`).join('')}</details></section>`;
  const tasks = r.tasks
    ? `<table class="tasks" title="來源：${esc(r.file)} → ${esc(r.tasksSrc)}"><thead><tr><th>工蟻</th><th>任務</th><th>出巢</th><th>成功</th><th>停止原因（引擎代碼）</th></tr></thead><tbody>${r.tasks.map((x) => `<tr data-task="${esc(x.id)}" data-trips="${x.trips}" data-successes="${x.successes}" data-task-code="${esc(x.task)}" title="來源：${esc(r.file)} → days[${r.day - 1}].tasks.${esc(x.id)}"><td>${esc(x.id)}</td><td>${esc(x.label)}</td><td class="num">${x.trips}</td><td class="num">${x.successes}</td><td><code>${esc(x.stop_reason ?? '—')}</code></td></tr>`).join('')}</tbody></table>`
    : '<p class="muted" data-task-none>個體任務：引擎未記錄</p>';
  return `<p class="muted">以下每個數字都取自匯出的引擎紀錄 <code>${esc(r.file)}</code>（游標停在數字上，或展開「資料來源」可看到欄位）；紀錄中沒有的量顯示「引擎未記錄」，不估計。</p>${r.sections.map(sec).join('')}<section class="rec" data-section="tasks"><h3>個體任務（引擎紀錄的當日任務摘要）</h3>${tasks}<p class="muted">來源：<code>${esc(r.tasksSrc)}</code></p></section>`;
}

/** HTML for the summary panel (strings only; the page inserts it). Day-level items are capped per type for length. */
export function summaryHtml(s: DaySummary, cap = 30, rec?: DayRecordSummary): string {
  const timed = s.timed.length ? `<table><thead><tr><th>事件</th><th>筆數</th><th>引擎紀錄的時刻（首～末，分:秒）</th></tr></thead><tbody>${s.timed.map((g) => `<tr><td>${esc(g.label)}</td><td>${g.count}</td><td>${mm(g.first)}～${mm(g.last)}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">沒有帶分鐘紀錄的事件。</p>';
  const day = s.dayLevel.length ? s.dayLevel.map((g) => `<details><summary>${esc(g.label)}：${g.count} 筆</summary><ul>${g.items.slice(0, cap).map((x) => `<li>${esc(x)}</li>`).join('')}${g.count > cap ? `<li class="muted">另 ${g.count - cap} 筆</li>` : ''}</ul></details>`).join('') : '<p class="muted">沒有日層級事件。</p>';
  return `<div class="sum-label">日摘要，非連續播放</div>
<h2>第 ${s.day} 日（${esc(s.date)}）</h2>
<p>活動時段 ${s.window} 分鐘；引擎紀錄的行走 ${s.walks} 段。日終結算：工蟻死亡 ${s.settlement.deaths}、羽化 ${s.settlement.eclosions}、產卵 ${s.settlement.eggs}。</p>
${rec ? recordHtml(rec) : ''}
<h3>有分鐘紀錄的事件</h3>${timed}
<h3>日層級事件（引擎沒有記錄時刻，不放在任何時間點）</h3>${day}`;
}
