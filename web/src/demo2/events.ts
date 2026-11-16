/**
 * Demo 2 — D2E-1: every ENGINE event the page receives, classified, counted, listed and (rate-limited) cued.
 * Pure: no DOM, no Three.js, no engine / Worker / cli import, no clock of its own. It only READS the event copies the
 * Worker posts (observation); nothing here is sent anywhere, so it cannot change the world.
 *
 * Three outputs, with different guarantees:
 *  - COUNTS (by class and by raw event kind): exact. Every event of every batch is counted, whatever the speed, the
 *    panel state or the cue budget. tests/web-demo2-events.test.ts reconciles them with an independent Node replay.
 *  - TICKER: the last TICKER_MAX events as text lines (a bounded window of the same events; older lines fall out).
 *  - CUES: short in-scene labels on the individual an event belongs to. A cue is DISPLAY (how long it is held, where it
 *    floats); the event behind it is the engine's. Cues are budgeted: when too many arrive, lower-priority ones are NOT
 *    shown and are counted in `cues_dropped` — the counts above never lose anything.
 *
 * Nothing here invents an event: an unknown event kind is counted under its own kind and listed as such.
 * The engine's "contact" is a probability draw, not body contact (M14), and in-nest positions are 展示假設: the wording of
 * every line keeps to what the engine recorded.
 */
import type { EventMsg } from '../experimental/worker-protocol.ts';

/** what one counted thing is: `event` = one engine event; `part` = one entry inside an engine event (a nestmate touched,
 *  a larva touched); `flag` = a property of an engine event counted apart (a loaded arrival) */
export type ClassUnit = 'event' | 'part' | 'flag';
export type ClassGroup = 'outside' | 'contact' | 'brood' | 'nest' | 'env' | 'roster' | 'other';
export interface ClassDef { key: string; group: ClassGroup; unit: ClassUnit; label_zh: string }
export const GROUP_LABEL: Record<ClassGroup, string> = { outside: '巢外', contact: '接觸與交哺', brood: '育幼', nest: '巢內選擇', env: '環境與食源', roster: '名冊', other: '其他' };
export const GROUPS: readonly ClassGroup[] = ['outside', 'contact', 'brood', 'nest', 'env', 'roster', 'other'];

/** the event classes of the P0-A2 world and of the candidate roster; order = display order */
export const CLASSES: readonly ClassDef[] = [
  { key: 'exit', group: 'outside', unit: 'event', label_zh: '出巢' },
  { key: 'exit_refused', group: 'outside', unit: 'event', label_zh: '在巢口折返（未出巢）' },
  { key: 'back_in', group: 'outside', unit: 'event', label_zh: '折返後回到巢內' },
  { key: 'search_found', group: 'outside', unit: 'event', label_zh: '搜尋：找到食源' },
  { key: 'search_failed', group: 'outside', unit: 'event', label_zh: '搜尋：沒有找到' },
  { key: 'source_take', group: 'outside', unit: 'event', label_zh: '到食源：有取食' },
  { key: 'source_empty', group: 'outside', unit: 'event', label_zh: '到食源：是空的（空手折返）' },
  { key: 'source_heat', group: 'outside', unit: 'event', label_zh: '到食源：過熱折返' },
  { key: 'feed_end', group: 'outside', unit: 'event', label_zh: '取食結束、啟程回巢' },
  { key: 'arrive_nest', group: 'contact', unit: 'event', label_zh: '回到巢內' },
  { key: 'arrive_loaded', group: 'contact', unit: 'flag', label_zh: '　其中滿載（可招募）' },
  { key: 'contact_transfer', group: 'contact', unit: 'part', label_zh: '接觸同伴：有食物轉移（交哺）' },
  { key: 'contact_only', group: 'contact', unit: 'part', label_zh: '接觸同伴：沒有轉移' },
  { key: 'woke', group: 'contact', unit: 'part', label_zh: '接觸喚醒同伴（招募）' },
  { key: 'wake', group: 'contact', unit: 'event', label_zh: '被喚醒後重新選擇' },
  { key: 'brood_touch', group: 'brood', unit: 'part', label_zh: '育幼：碰到幼蟲' },
  { key: 'larva_fed', group: 'brood', unit: 'part', label_zh: '　其中有餵食' },
  { key: 'idle_larva_touch', group: 'brood', unit: 'part', label_zh: '巢內走動：碰到幼蟲（不餵）' },
  { key: 'choice_forage', group: 'nest', unit: 'event', label_zh: '巢內選擇：去覓食' },
  { key: 'choice_brood', group: 'nest', unit: 'event', label_zh: '巢內選擇：育幼' },
  { key: 'choice_idle', group: 'nest', unit: 'event', label_zh: '巢內選擇：走動' },
  { key: 'choice_rest', group: 'nest', unit: 'event', label_zh: '巢內選擇：休息' },
  { key: 'produce', group: 'env', unit: 'event', label_zh: '蜜露產出（合成情境）' },
  { key: 'env_light', group: 'env', unit: 'event', label_zh: '光照轉換' },
  { key: 'env_sample', group: 'env', unit: 'event', label_zh: '逐時天氣紀錄（合成）' },
  { key: 'env_day', group: 'env', unit: 'event', label_zh: '新的一天' },
  { key: 'queen_added', group: 'roster', unit: 'event', label_zh: '名冊：蟻后（初始情境）' },
  { key: 'worker_added', group: 'roster', unit: 'event', label_zh: '名冊：工蟻（初始情境）' },
  { key: 'brood_item_added', group: 'roster', unit: 'event', label_zh: '名冊：卵／蛹（初始情境）' },
];
const CLASS_BY_KEY = new Map(CLASSES.map((c) => [c.key, c] as const));
/** the class of a key; an event kind this page has no class for is listed under 其他 with its raw kind (never dropped) */
export function classOf(key: string): ClassDef { return CLASS_BY_KEY.get(key) ?? { key, group: 'other', unit: 'event', label_zh: `其他引擎事件 ${key.replace(/^kind:/, '')}` }; }

/** one in-scene cue an event may give: on whom, the text, and its priority (rarer / more telling events first) */
export interface CueSpec { on: string; text: string; prio: number }
/** what one engine event amounts to */
export interface Classified {
  /** class key → how many (an event may carry several parts: nestmates touched, larvae touched) */
  inc: [string, number][];
  /** the ticker line (without the time) */
  line: string;
  group: ClassGroup;
  cues: CueSpec[];
}
type Touched = { worker: string; amount: number; woke: string | null };
type LarvaRec = { larva: string; signal: number; fed: number };
const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
/** µP (integer micro-portions, the engine's unit) as game portions */
const portions = (up: number) => { const p = up / 1_000_000, s = (up >= 10_000 || up === 0 ? p.toFixed(3) : up >= 10 ? p.toFixed(5) : p.toFixed(6)).replace(/0+$/, '').replace(/\.$/, ''); return `${s} 份`; };
const NEST_CHOICES = new Set(['forage', 'brood', 'idle', 'rest']);
const CHOICE_ZH: Record<string, string> = { forage: '去覓食', brood: '育幼', idle: '巢內走動', rest: '休息' };
const REFUSE_ZH: Record<string, string> = { declined: '未出巢', heat: '過熱', temp_unavailable: '沒有溫度資料' };
const FROM_ZH: Record<string, string> = { resting: '休息', idle: '巢內走動', brood_care: '育幼' };
const LIGHT_ZH: Record<string, string> = { day: '白天', civil_twilight: '曙暮光', night: '夜晚' };
/** cue priorities (higher first) */
export const PRIO = { woke: 90, loaded: 80, take: 70, larva_fed: 65, search: 60, refused: 60, transfer: 50, empty: 40, produce: 35, contact: 20 } as const;

/** the id of the food source cue anchor (the page draws it at the source; the engine's source id is in the event) */
export const SOURCE_CUE = '@source';

/**
 * Classify ONE engine event. Pure and total: any event gives at least one count (its class, or its raw kind).
 * The in-nest decision that an arrival / bout end / wake carries (`choice`) is counted as its own class in addition.
 */
export function classify(e: EventMsg): Classified {
  const d = e.data as Record<string, unknown>, who = e.entity ?? '', inc: [string, number][] = [], cues: CueSpec[] = [], parts: string[] = [];
  const add = (k: string, n = 1) => { if (n > 0) inc.push([k, n]); };
  let group: ClassGroup = 'other';
  /** arriving at the source (arrive_source, or a successful search that ends at the source) */
  const atSource = () => {
    if (d.heat === true) { add('source_heat'); parts.push('到食源：過熱折返'); cues.push({ on: who, text: '過熱折返', prio: PRIO.refused }); }
    else if (typeof d.take === 'number' && d.take > 0) { add('source_take'); parts.push(`到食源：取食 ${portions(d.take)}`); cues.push({ on: who, text: `取食 ${portions(d.take)}`, prio: PRIO.take }); }
    else { add('source_empty'); parts.push('到食源：是空的，空手折返'); cues.push({ on: who, text: '食源是空的', prio: PRIO.empty }); }
  };
  /** the in-nest choice some worker events end with */
  const choice = () => { if (typeof d.choice === 'string' && NEST_CHOICES.has(d.choice)) { add(`choice_${d.choice}`); parts.push(`選擇：${CHOICE_ZH[d.choice]}`); } };
  const larvae = (key: 'larvae' | 'idle_larvae') => {
    const L = arr<LarvaRec>(d[key]); if (!L.length) return;
    if (key === 'idle_larvae') { add('idle_larva_touch', L.length); parts.push(`走動時碰到幼蟲 ${L.length} 隻`); return; }
    const fed = L.filter((x) => x.fed > 0); add('brood_touch', L.length); add('larva_fed', fed.length);
    parts.push(`碰到幼蟲 ${L.length} 隻${fed.length ? `，餵 ${fed.map((x) => x.larva).join('、')}` : '，沒有餵'}`);
    for (const x of fed) cues.push({ on: who, text: `餵 ${x.larva} ${portions(x.fed)}`, prio: PRIO.larva_fed });
  };
  switch (e.kind) {
    case 'at_entrance':
      group = 'outside';
      if (d.choice === 'exit') { add('exit'); parts.push(d.route ? '出巢：沿記得的路線' : '出巢：沒有路線記憶，開始搜尋'); }
      else { add('exit_refused'); const why = REFUSE_ZH[String(d.choice)] ?? String(d.choice); parts.push(`在巢口折返（${why}）`); cues.push({ on: who, text: `巢口折返：${why}`, prio: PRIO.refused }); }
      break;
    case 'back_in': group = 'outside'; add('back_in'); parts.push('折返後回到巢內，休息'); break;
    case 'search_end':
      group = 'outside';
      if (d.found) { add('search_found'); parts.push('搜尋：找到食源'); cues.push({ on: who, text: '找到食源', prio: PRIO.search }); atSource(); }
      else { add('search_failed'); parts.push('搜尋：沒有找到，回巢'); cues.push({ on: who, text: '沒找到食物', prio: PRIO.search }); }
      break;
    case 'arrive_source': group = 'outside'; atSource(); break;
    case 'feed_end': group = 'outside'; add('feed_end'); parts.push(`取食結束，回巢${d.loaded === true ? '（滿載）' : ''}`); break;
    case 'arrive_nest': {
      group = 'contact'; add('arrive_nest');
      const T = arr<Touched>(d.touched), gave = T.filter((x) => x.amount > 0), only = T.length - gave.length, woke = T.filter((x) => x.woke);
      if (d.loaded === true) { add('arrive_loaded'); cues.push({ on: who, text: '滿載回巢', prio: PRIO.loaded }); }
      add('contact_transfer', gave.length); add('contact_only', only); add('woke', woke.length);
      parts.push(`回巢${d.loaded === true ? '（滿載）' : ''}：接觸 ${T.length} 隻${gave.length ? `，交哺 ${gave.map((x) => `${x.worker} ${portions(x.amount)}`).join('、')}` : T.length ? '，沒有轉移' : ''}${woke.length ? `；喚醒 ${woke.map((x) => x.worker).join('、')}` : ''}`);
      for (const x of gave) cues.push({ on: x.worker, text: `收到 ${portions(x.amount)}`, prio: PRIO.transfer });
      for (const x of woke) cues.push({ on: x.worker, text: '被喚醒', prio: PRIO.woke });
      if (only > 0) cues.push({ on: who, text: `接觸 ${only} 隻・沒有轉移`, prio: PRIO.contact });
      larvae('larvae'); choice(); break;
    }
    case 'wake': group = 'contact'; add('wake'); parts.push('被喚醒'); larvae('larvae'); choice(); break;
    case 'bout_end': group = 'nest'; parts.push(typeof d.from === 'string' ? `結束「${FROM_ZH[d.from] ?? d.from}」` : '一段結束'); larvae('idle_larvae'); larvae('larvae'); choice(); if (inc.some(([k]) => k === 'brood_touch' || k === 'idle_larva_touch')) group = 'brood'; break;
    case 'produce': group = 'env'; add('produce'); parts.push(`蜜露產出 ${typeof d.amount === 'number' ? portions(d.amount) : ''}（合成情境），食源存量 ${typeof d.stock === 'number' ? portions(d.stock) : '—'}`); if (typeof d.amount === 'number') cues.push({ on: SOURCE_CUE, text: `滴出 ${portions(d.amount)}（合成）`, prio: PRIO.produce }); break;
    case 'env_light': group = 'env'; add('env_light'); parts.push(`光照轉為${LIGHT_ZH[String(d.to)] ?? String(d.to)}`); break;
    case 'env_sample': group = 'env'; add('env_sample'); parts.push(`天氣紀錄（合成）：氣溫 ${typeof d.temp_c === 'number' ? d.temp_c.toFixed(1) : '—'}°C、相對濕度 ${typeof d.rh_percent === 'number' ? d.rh_percent.toFixed(0) : '—'}%、雨：無資料`); break;
    case 'env_day': group = 'env'; add('env_day'); parts.push(`新的一天 ${typeof d.date === 'string' ? d.date : ''}`); break;
    case 'queen_added': case 'worker_added': case 'brood_item_added': group = 'roster'; add(e.kind); parts.push(`${classOf(e.kind).label_zh}`); break;
    default: break;
  }
  if (!inc.length) { add(`kind:${e.kind}`); if (!parts.length) parts.push(`引擎事件 ${e.kind}`); }
  return { inc, line: `${who ? `${who}　` : ''}${parts.join('；')}`, group, cues };
}

export interface TickerLine { seq: number; t_sim: number; event_id: string; kind: string; entity: string | null; group: ClassGroup; text: string }
export interface Cue { id: number; on: string; text: string; prio: number; t0: number; t1: number; event_id: string; t_sim: number }
export const TICKER_MAX = 240;
/** how long a cue stays (wall seconds — NOT simulated time, so it is readable at 60× as at 1×; display) */
export const CUE_HOLD_S = 2.2;
/** events older than this (simulated seconds) than the newest event of their batch get no cue (display rule) */
export const CUE_FRESH_S = 20;
/** how many cues may show at once (narrow screens fewer) */
export const CUE_MAX = { wide: 6, narrow: 3 } as const;

/**
 * The page's event ledger. onEvents() is called with every batch the Worker posts, in order. `wall` is the caller's
 * wall clock in seconds (the ledger has none); it is used ONLY for how long cues stay.
 */
export class EventLedger {
  /** exact counts by class key (and `kind:<raw>` for unclassified kinds) */
  readonly counts = new Map<string, number>();
  /** exact counts by raw engine event kind */
  readonly kinds = new Map<string, number>();
  readonly ticker: TickerLine[] = [];
  total = 0; first_seq: number | null = null; last_seq: number | null = null; first_t: number | null = null; last_t: number | null = null;
  /** events that arrived out of sequence (should stay 0: the Worker posts them in order) */
  gaps = 0;
  cues_shown = 0; cues_dropped = 0;
  private cues: Cue[] = []; private nextCue = 1;
  /** how many cues may show at once (0 = none: the counts are unaffected) */
  cueMax: number;
  constructor(cueMax: number = CUE_MAX.wide) { this.cueMax = cueMax; }

  reset() { this.counts.clear(); this.kinds.clear(); this.ticker.length = 0; this.total = 0; this.first_seq = this.last_seq = this.first_t = this.last_t = null; this.gaps = 0; this.cues_shown = this.cues_dropped = 0; this.cues = []; }

  onEvents(events: readonly EventMsg[], wall: number) {
    // a batch may span a long stretch of simulated time (a fast-forward, a step_until): only its LAST CUE_FRESH_S seconds
    // are cued — an older event's individual is somewhere else by now. The older events are counted and listed all the same.
    const tLast = events.length ? events[events.length - 1].t_sim : 0;
    for (const e of events) {
      if (this.last_seq !== null && e.seq !== this.last_seq + 1) this.gaps++;
      if (this.first_seq === null) { this.first_seq = e.seq; this.first_t = e.t_sim; }
      this.last_seq = e.seq; this.last_t = e.t_sim; this.total++;
      this.kinds.set(e.kind, (this.kinds.get(e.kind) ?? 0) + 1);
      const c = classify(e);
      for (const [k, n] of c.inc) this.counts.set(k, (this.counts.get(k) ?? 0) + n);
      this.ticker.push({ seq: e.seq, t_sim: e.t_sim, event_id: e.event_id, kind: e.kind, entity: e.entity, group: c.group, text: c.line });
      for (const q of c.cues) { if (tLast - e.t_sim > CUE_FRESH_S) this.cues_dropped++; else this.offer(q, e.event_id, wall, e.t_sim); }
    }
    if (this.ticker.length > TICKER_MAX) this.ticker.splice(0, this.ticker.length - TICKER_MAX);
  }

  /** a cue asks for a place: shown if there is room, or if it outranks the lowest-priority cue showing (which is then
   *  dropped); one individual carries one cue at a time (the higher priority, then the newer). Dropped cues are counted. */
  private offer(q: CueSpec, event_id: string, wall: number, t_sim: number) {
    this.cues = this.cues.filter((c) => c.t1 > wall);
    if (this.cueMax <= 0) { this.cues_dropped++; return; }
    const same = this.cues.findIndex((c) => c.on === q.on);
    if (same >= 0) { if (this.cues[same].prio > q.prio) { this.cues_dropped++; return; } this.cues.splice(same, 1); this.cues_dropped++; this.cues_shown--; }
    else if (this.cues.length >= this.cueMax) {
      let lo = 0; for (let i = 1; i < this.cues.length; i++) if (this.cues[i].prio < this.cues[lo].prio || (this.cues[i].prio === this.cues[lo].prio && this.cues[i].t0 < this.cues[lo].t0)) lo = i;
      if (this.cues[lo].prio >= q.prio) { this.cues_dropped++; return; }
      this.cues.splice(lo, 1); this.cues_dropped++; this.cues_shown--;
    }
    this.cues.push({ id: this.nextCue++, on: q.on, text: q.text, prio: q.prio, t0: wall, t1: wall + CUE_HOLD_S, event_id, t_sim }); this.cues_shown++;
  }
  /** the cues showing at wall time `wall`. With `simNow` and `maxSimAge` (simulated seconds) a cue whose event lies
   *  further back than that in SIMULATED time is gone too (e.g. the world was stepped on while the cue clock stood still) */
  activeCues(wall: number, simNow?: number, maxSimAge?: number): Cue[] {
    this.cues = this.cues.filter((c) => c.t1 > wall && (simNow === undefined || maxSimAge === undefined || simNow - c.t_sim <= maxSimAge));
    return this.cues;
  }

  count(key: string): number { return this.counts.get(key) ?? 0; }
  /** counts as a plain object, keys sorted (for tests and the debug hook) */
  countsObject(): Record<string, number> { return Object.fromEntries([...this.counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))); }
  kindsObject(): Record<string, number> { return Object.fromEntries([...this.kinds].sort((a, b) => (a[0] < b[0] ? -1 : 1))); }
  /** rows for the panel: every defined class (0 included, so "never happened" is visible) and every other key seen */
  rows(): { def: ClassDef; n: number }[] {
    const out = CLASSES.map((def) => ({ def, n: this.count(def.key) }));
    for (const [k, n] of [...this.counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (!CLASS_BY_KEY.has(k)) out.push({ def: classOf(k), n });
    return out;
  }
}
