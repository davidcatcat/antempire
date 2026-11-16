/**
 * Demo 2 — D2E-2: ONE individual's own engine record, as the card shows it ("why did this ant do that").
 * Pure: no DOM, no Three.js, no engine / Worker / cli import, no clock. Read only.
 *
 * Sources (all engine; nothing is computed that the engine did not record):
 *  - the worker's own record the Worker sends for the observed worker (`follow` → antView): its crop, its traits, its
 *    route memory, the contacts IT experienced, the begging signals of the larvae IT touched, its hunger diagnostics;
 *  - the worker's entry in the state frame (state, state start, crop fill);
 *  - the events in which THIS individual took part, as the page received them (OwnHistory below).
 *
 * LOCALITY (CLAUDE.md §2.1, §2.4): everything listed is what this individual itself has or experienced. The card says
 * so, and says what the ant does NOT know (colony stores, other individuals' state, whether the source holds food now):
 * those exist on screen only as the player's view. The explanation names the inputs the engine's decision reads; it
 * shows their CURRENT values and never reconstructs a probability the page cannot know (the constants are not in the frame).
 */
import type { EventMsg, P0a2FrameMsg } from '../experimental/worker-protocol.ts';

/** the worker's own record as the Worker reports it (P0a2 antView); every field is checked before use */
export interface WorkerRecord {
  kind: 'p0a2_worker'; id: string; state: string; loc: string; since: number;
  crop: number; consumed: number; debt: number;
  theta_forage: number; theta_brood: number; gain: number; thermal_offset_c: number; ctmax_c: number;
  route: string | null; trip_loaded: boolean; empty_streak: number;
  last_intake_t: number | null; forage_interval_ms: number | null;
  contacts: { t: number; from: string; loaded: boolean; route: string | null }[];
  begging: { t: number; larva: string; signal: number }[];
  empty_since: number | null; empty_ms: number; max_empty_ms: number;
  physiology_at_s: number; settled_s: number;
}
const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
/** the record if `v` is a P0-A2 worker record of `id`, else null (the page then says the record is not available) */
export function asWorkerRecord(v: unknown, id: string): WorkerRecord | null {
  const r = v as Partial<WorkerRecord> | null;
  if (!r || typeof r !== 'object' || r.kind !== 'p0a2_worker' || r.id !== id) return null;
  if (![r.crop, r.consumed, r.debt, r.theta_forage, r.theta_brood, r.gain, r.ctmax_c, r.empty_ms, r.max_empty_ms, r.empty_streak, r.physiology_at_s, r.settled_s, r.since].every(num)) return null;
  if (!Array.isArray(r.contacts) || !Array.isArray(r.begging)) return null;
  return r as WorkerRecord;
}

// ------------------------------------------------------------------ the individual's own events (page-received)
export type OwnKind = 'exit' | 'refused' | 'search_found' | 'search_failed' | 'take' | 'empty' | 'heat' | 'home' | 'gave' | 'got' | 'woken' | 'fed_larva' | 'choice';
export interface OwnEvent { t_sim: number; seq: number; kind: OwnKind; text: string; up?: number; other?: string }
export interface OwnTotals { exits: number; takes: number; empties: number; taken_up: number; gave: number; gave_up: number; got: number; got_up: number; fed_larvae: number; fed_up: number; woken: number; contacts_made: number; contacted_by: number }
export interface LarvaTotals { touched: number; touched_idle: number; fed: number; fed_up: number; last_signal: number | null; last_signal_t: number | null; last_fed_t: number | null; last_carer: string | null }
const zero = (): OwnTotals => ({ exits: 0, takes: 0, empties: 0, taken_up: 0, gave: 0, gave_up: 0, got: 0, got_up: 0, fed_larvae: 0, fed_up: 0, woken: 0, contacts_made: 0, contacted_by: 0 });
export const OWN_MAX = 14;
const portions = (up: number) => { const p = up / 1_000_000; return `${(up >= 10_000 || up === 0 ? p.toFixed(3) : p.toFixed(5)).replace(/0+$/, '').replace(/\.$/, '')} 份`; };
const CHOICE_ZH: Record<string, string> = { forage: '去覓食', brood: '育幼', idle: '巢內走動', rest: '休息' };

/** per-individual history of the events the page received: exact totals since the page opened, and the last OWN_MAX
 *  events of each worker. Fed with the same batches as the event ledger; never sent anywhere. */
export class OwnHistory {
  readonly totals = new Map<string, OwnTotals>();
  readonly last = new Map<string, OwnEvent[]>();
  readonly larvae = new Map<string, LarvaTotals>();
  first_t: number | null = null;
  reset() { this.totals.clear(); this.last.clear(); this.larvae.clear(); this.first_t = null; }
  private tot(id: string): OwnTotals { let x = this.totals.get(id); if (!x) { x = zero(); this.totals.set(id, x); } return x; }
  private larva(id: string): LarvaTotals { let x = this.larvae.get(id); if (!x) { x = { touched: 0, touched_idle: 0, fed: 0, fed_up: 0, last_signal: null, last_signal_t: null, last_fed_t: null, last_carer: null }; this.larvae.set(id, x); } return x; }
  private push(id: string, e: EventMsg, kind: OwnKind, text: string, up?: number, other?: string) {
    let a = this.last.get(id); if (!a) { a = []; this.last.set(id, a); }
    a.push({ t_sim: e.t_sim, seq: e.seq, kind, text, up, other }); if (a.length > OWN_MAX) a.splice(0, a.length - OWN_MAX);
  }
  onEvents(events: readonly EventMsg[]) {
    for (const e of events) {
      if (this.first_t === null) this.first_t = e.t_sim;
      const who = e.entity; if (!who) continue;
      const d = e.data as Record<string, unknown>, T = this.tot(who);
      const atSource = () => {
        if (d.heat === true) this.push(who, e, 'heat', '到食源：過熱折返');
        else if (typeof d.take === 'number' && d.take > 0) { T.takes++; T.taken_up += d.take; this.push(who, e, 'take', `到食源：取食 ${portions(d.take)}`, d.take); }
        else { T.empties++; this.push(who, e, 'empty', '到食源：是空的，空手折返'); }
      };
      if (e.kind === 'at_entrance') { if (d.choice === 'exit') { T.exits++; this.push(who, e, 'exit', d.route ? '出巢：沿自己記得的路線' : '出巢：沒有路線記憶，開始搜尋'); } else this.push(who, e, 'refused', `在巢口折返（${String(d.choice)}）`); }
      else if (e.kind === 'search_end') { if (d.found) { this.push(who, e, 'search_found', '搜尋：找到食源（記住路線）'); atSource(); } else this.push(who, e, 'search_failed', '搜尋：沒有找到，回巢'); }
      else if (e.kind === 'arrive_source') atSource();
      else if (e.kind === 'arrive_nest') {
        const touched = Array.isArray(d.touched) ? (d.touched as { worker: string; amount: number; woke: string | null }[]) : [];
        T.contacts_made += touched.length;
        this.push(who, e, 'home', `回到巢內${d.loaded === true ? '（滿載）' : ''}：接觸 ${touched.length} 隻`);
        for (const x of touched) {
          const P = this.tot(x.worker); P.contacted_by++;
          if (x.amount > 0) { T.gave++; T.gave_up += x.amount; this.push(who, e, 'gave', `交哺給 ${x.worker}：${portions(x.amount)}`, x.amount, x.worker); P.got++; P.got_up += x.amount; this.push(x.worker, e, 'got', `從 ${who} 收到 ${portions(x.amount)}`, x.amount, who); }
          if (x.woke) { P.woken++; this.push(x.worker, e, 'woken', `被 ${who} 接觸喚醒（滿載回巢者）`, undefined, who); }
        }
      }
      for (const key of ['idle_larvae', 'larvae'] as const) {
        const L = Array.isArray(d[key]) ? (d[key] as { larva: string; signal: number; fed: number }[]) : [];
        for (const x of L) {
          const lv = this.larva(x.larva); if (key === 'larvae') lv.touched++; else lv.touched_idle++;
          lv.last_signal = x.signal; lv.last_signal_t = e.t_sim;
          if (x.fed > 0) { lv.fed++; lv.fed_up += x.fed; lv.last_fed_t = e.t_sim; lv.last_carer = who; T.fed_larvae++; T.fed_up += x.fed; this.push(who, e, 'fed_larva', `餵幼蟲 ${x.larva}：${portions(x.fed)}（牠感知到的求食訊號 ${x.signal.toFixed(2)}）`, x.fed, x.larva); }
        }
      }
      if (typeof d.choice === 'string' && d.choice in CHOICE_ZH && e.kind !== 'at_entrance') this.push(who, e, 'choice', `巢內選擇：${CHOICE_ZH[d.choice]}`);
    }
  }
  totalsOf(id: string): OwnTotals { return this.totals.get(id) ?? zero(); }
  lastOf(id: string): OwnEvent[] { return this.last.get(id) ?? []; }
  larvaOf(id: string): LarvaTotals | null { return this.larvae.get(id) ?? null; }
}

// ------------------------------------------------------------------ the card
export type RowClass = 'engine' | 'diag' | 'page';
export interface Row { label: string; value: string; cls: RowClass }
export interface Section { title: string; note?: string; rows: Row[]; list?: string[] }
export interface RecordView {
  available: boolean;
  /** why the worker is in its current state, from ITS OWN information only (plain sentences) */
  why: string[];
  /** what this individual does not know (shown with every record) */
  not_known: string;
  sections: Section[];
}
export const NOT_KNOWN = '工蟻不知道：全巢有多少食物、其他個體的嗉囊或狀態（除非牠實際接觸到）、食源現在有沒有食物（要親自走到才知道）、全巢有幾隻幼蟲在餓。畫面上這些數字是玩家視角，從不進入牠的決定。';
export const RECORD_CLASS_LABEL: Record<RowClass, string> = { engine: '引擎狀態（牠自己的）', diag: '統計診斷（只供觀察；不進入任何決定，也不是死亡）', page: '引擎事件（本頁開啟後收到、與牠有關的）' };
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const dur = (ms: number) => { const s = Math.round(ms / 1000); return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小時 ${Math.floor((s % 3600) / 60)} 分`; };
type PW = P0a2FrameMsg['workers'][number];

/** the sentences that say why the worker is doing what it does, from the inputs the engine's decision reads */
function whyOf(w: PW, r: WorkerRecord | null, own: OwnEvent[], clock: (t: number) => string): string[] {
  const out: string[] = [], lastOf = (k: OwnKind[]) => [...own].reverse().find((e) => k.includes(e.kind));
  const loaded = r ? r.contacts.filter((c) => c.loaded).length : null;
  const ingredients = r ? `牠自己的嗉囊 ${pct(w.crop_fill)}（空缺 ${pct(1 - w.crop_fill)}）、牠在接觸視窗內經歷的滿載回巢者接觸 ${loaded} 次、牠自己的覓食門檻 ${r.theta_forage.toFixed(2)} 與反應強度 ${r.gain.toFixed(2)}` : `牠自己的嗉囊 ${pct(w.crop_fill)}（空缺 ${pct(1 - w.crop_fill)}）`;
  switch (w.state) {
    case 'to_entrance': case 'outbound': case 'searching':
      out.push(`牠在巢內選擇了去覓食。引擎的這個選擇只讀牠自己的東西：${ingredients}（以上是目前值，不是選擇當下的值）。空缺越大、經歷的滿載接觸越多，越可能出門；結果仍是機率。`);
      if (w.state === 'outbound') out.push(w.route ? '牠沿著自己記得的路線走向食源；牠不知道食源現在有沒有食物，要走到才知道。' : '牠沒有路線記憶。');
      if (w.state === 'searching') out.push('牠沒有路線記憶，所以在巢外搜尋（引擎的搜尋沒有空間路徑：畫面位置是示意）。');
      if (w.state === 'to_entrance') out.push('到巢口後，牠依巢口當下的溫度與光照（牠自己感受到的）決定是否出巢。');
      break;
    case 'feeding': { const e = lastOf(['take']); out.push(`牠走到食源、現場有食物，取了${e?.up ? ` ${portions(e.up)}` : '食物'}（最多裝到自己的嗉囊空間）。`); break; }
    case 'returning': {
      const e = lastOf(['take', 'empty', 'heat', 'search_failed']);
      out.push(e?.kind === 'take' ? `牠取食後回巢（${clock(e.t_sim)} 取了 ${portions(e.up ?? 0)}）。` : e?.kind === 'empty' ? `牠 ${clock(e.t_sim)} 走到食源時現場沒有食物，空手回巢。這是牠親身的經歷；出發時牠無從知道。${r && r.empty_streak > 0 ? `牠自己連續 ${r.empty_streak} 次到場都是空的。` : ''}` : e?.kind === 'search_failed' ? `牠 ${clock(e.t_sim)} 結束搜尋，沒有找到食物，回巢。` : e?.kind === 'heat' ? '牠在食源感到過熱，折返。' : '牠正在回巢（本頁開啟前出發，沒有收到這一趟的事件）。');
      break;
    }
    case 'brood_care': out.push(`牠在育幼。引擎的這個選擇只讀：牠自己在接觸視窗內碰過、而且求食訊號夠強的幼蟲次數（目前紀錄 ${r ? r.begging.length : '—'} 筆接觸），以及牠自己的嗉囊裡有沒有可以給的食物（${pct(w.crop_fill)}）。牠只餵自己碰到、而且當下在求食的幼蟲。`); break;
    case 'idle': case 'resting': {
      const woke = lastOf(['woken']), e = lastOf(['choice', 'home']);
      out.push(`牠${w.state === 'idle' ? '在巢內走動' : '在休息'}。上一次選擇時，覓食與育幼的刺激都沒有讓牠開始工作（機率結果），於是${w.state === 'idle' ? '走動' : '休息'}。牠讀的仍只有：${ingredients}。`);
      if (woke && e && woke.seq >= e.seq) out.push(`牠在 ${clock(woke.t_sim)} ${woke.text}，重新做了一次選擇。`);
      break;
    }
    case 'from_entrance': out.push('牠在巢口決定不出巢（依巢口當下的溫度與光照），正走回巢內。'); break;
    default: out.push('（沒有這個狀態的說明）');
  }
  return out;
}

/**
 * The card content of one worker. `rec` = its own record from the Worker (null = not observed: e.g. the idle camera tour
 * selected it, and the tour sends nothing to the Worker). `clock` formats a world instant (s).
 */
export function workerRecordView(w: PW, rec: WorkerRecord | null, hist: OwnHistory, clock: (t: number) => string): RecordView {
  const own = hist.lastOf(w.id), tot = hist.totalsOf(w.id), sections: Section[] = [];
  if (rec) {
    sections.push({ title: '牠經歷的接觸（牠自己的紀錄）', note: '回巢的同伴接觸到牠時留下的紀錄；引擎的「接觸」是機率抽樣，不是身體接觸。紀錄只在牠自己做決定時修剪到接觸視窗，所以筆數不是「此刻」的計數。', rows: [
      { label: '紀錄中的接觸', value: `${rec.contacts.length} 筆（其中來自滿載回巢者 ${rec.contacts.filter((c) => c.loaded).length} 筆）`, cls: 'engine' },
    ], list: [...rec.contacts].reverse().slice(0, 8).map((c) => `${clock(c.t / 1000)}　${c.from}${c.loaded ? '（滿載；傳給牠路線）' : '（未滿載）'}`) });
    sections.push({ title: '牠碰過的幼蟲與感知到的求食訊號', note: '只有牠親自碰到的幼蟲；訊號是那一次接觸時牠感知到的值（0～1）。', rows: [
      { label: '紀錄中的幼蟲接觸', value: `${rec.begging.length} 筆`, cls: 'engine' },
    ], list: [...rec.begging].reverse().slice(0, 8).map((b) => `${clock(b.t / 1000)}　${b.larva}　訊號 ${b.signal.toFixed(2)}`) });
    sections.push({ title: '嗉囊與路線記憶', rows: [
      { label: '嗉囊', value: `${pct(w.crop_fill)}（${portions(rec.crop)}）`, cls: 'engine' },
      { label: '路線記憶', value: rec.route ? `有（${rec.route}；親身走過或被接觸傳遞）` : '沒有', cls: 'engine' },
      { label: '上次在食源取到食物', value: rec.last_intake_t === null ? '從未' : clock(rec.last_intake_t / 1000), cls: 'engine' },
      { label: '牠自己最近兩次取食的間隔', value: rec.forage_interval_ms === null ? '還沒有兩次' : dur(rec.forage_interval_ms), cls: 'engine' },
      { label: '連續到場是空的', value: `${rec.empty_streak} 次`, cls: 'engine' },
      { label: '累計自身代謝消耗', value: portions(rec.consumed), cls: 'engine' },
    ] });
    sections.push({ title: '飢餓診斷', note: RECORD_CLASS_LABEL.diag + '。引擎沒有死亡模型：沒有個體會因此死亡。', rows: [
      { label: '嗉囊空的累計時間', value: dur(rec.empty_ms), cls: 'diag' },
      { label: '最長連續空嗉囊', value: dur(rec.max_empty_ms), cls: 'diag' },
      { label: '目前', value: rec.empty_since === null ? '嗉囊不是空的' : `自 ${clock(rec.empty_since / 1000)} 起是空的`, cls: 'diag' },
      { label: '未滿足的代謝需求（累計）', value: portions(rec.debt), cls: 'diag' },
    ] });
    sections.push({ title: '個體特質（建立時抽定；數值是遊戲假設）', rows: [
      { label: '覓食門檻', value: rec.theta_forage.toFixed(2), cls: 'engine' }, { label: '育幼門檻', value: rec.theta_brood.toFixed(2), cls: 'engine' },
      { label: '反應強度', value: rec.gain.toFixed(2), cls: 'engine' }, { label: '熱耐受上限', value: `${rec.ctmax_c.toFixed(0)}°C`, cls: 'engine' },
    ] });
  }
  sections.push({ title: '牠的嗉囊進出與行動（本頁開啟後收到的引擎事件）', note: `${RECORD_CLASS_LABEL.page}。嗉囊的變化只來自：在食源取食、從回巢者收到、交哺給同伴、餵幼蟲、牠自己的代謝。`, rows: [
    { label: '出巢', value: `${tot.exits} 次`, cls: 'page' },
    { label: '到食源：有取食／是空的', value: `${tot.takes}／${tot.empties} 次（共取 ${portions(tot.taken_up)}）`, cls: 'page' },
    { label: '回巢時交哺給同伴', value: `${tot.gave} 次（${portions(tot.gave_up)}）`, cls: 'page' },
    { label: '從回巢者收到', value: `${tot.got} 次（${portions(tot.got_up)}）`, cls: 'page' },
    { label: '餵幼蟲', value: `${tot.fed_larvae} 次（${portions(tot.fed_up)}）`, cls: 'page' },
    { label: '被喚醒', value: `${tot.woken} 次`, cls: 'page' },
  ], list: [...own].reverse().map((e) => `${clock(e.t_sim)}　${e.text}`) });
  return { available: rec !== null, why: whyOf(w, rec, own, clock), not_known: NOT_KNOWN, sections };
}

/** the card content of one larva: its gut (frame) and the carers' contacts with it (events the page received) */
export function larvaRecordView(id: string, gut_fill: number, hist: OwnHistory, clock: (t: number) => string): RecordView {
  const L = hist.larvaOf(id);
  return { available: true, why: ['幼蟲只有自己的腸道與代謝。牠的求食訊號＝1 − 腸道量比例，只有碰到牠的工蟻感知得到；沒有任何全巢廣播。'], not_known: '', sections: [
    { title: '牠自己的狀態', rows: [{ label: '腸道量', value: pct(gut_fill), cls: 'engine' }, { label: '此刻的求食訊號（＝1 − 腸道量）', value: (1 - gut_fill).toFixed(2), cls: 'engine' }] },
    { title: '工蟻與牠的接觸（本頁開啟後）', note: RECORD_CLASS_LABEL.page, rows: [
      { label: '育幼時被碰到／巢內走動時被碰到', value: `${L?.touched ?? 0}／${L?.touched_idle ?? 0} 次`, cls: 'page' },
      { label: '被餵食', value: `${L?.fed ?? 0} 次（${portions(L?.fed_up ?? 0)}）`, cls: 'page' },
      { label: '上次被餵', value: L?.last_fed_t != null ? `${clock(L.last_fed_t)}（${L.last_carer}）` : '本頁開啟後沒有', cls: 'page' },
      { label: '上次被碰到時工蟻感知的訊號', value: L?.last_signal != null ? `${L.last_signal.toFixed(2)}（${clock(L.last_signal_t!)}）` : '—', cls: 'page' },
    ] },
  ] };
}

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const TAG: Record<RowClass, string> = { engine: '<span class="tag engine">引擎</span>', diag: '<span class="tag assume">診斷</span>', page: '<span class="tag engine">事件</span>' };
/** the record as HTML (escaped). `missing` = the sentence shown when the worker's own record is not being observed */
export function recordHtml(v: RecordView, missing: string): string {
  const sec = (s: Section) => `<h2>${esc(s.title)}</h2>${s.note ? `<div class="muted">${esc(s.note)}</div>` : ''}<table>${s.rows.map((r) => `<tr><td>${TAG[r.cls]}${esc(r.label)}</td><td class="n">${esc(r.value)}</td></tr>`).join('')}</table>${s.list ? (s.list.length ? `<ul class="reclist">${s.list.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<div class="muted">（目前沒有）</div>') : ''}`;
  return `<h2>為什麼牠這樣做（只用牠自己的資訊）</h2><div class="why">${v.why.map((x) => `<p>${esc(x)}</p>`).join('')}</div>${v.not_known ? `<div class="muted notknown">${esc(v.not_known)}</div>` : ''}${v.available ? '' : `<div class="muted recmissing">${esc(missing)}</div>`}${v.sections.map(sec).join('')}`;
}
