/**
 * PROTOTYPE (#9, work package C) — not used by the engine, not part of any rules version (engine/ fingerprint
 * untouched). It demonstrates the world-timeline resolution proposed in docs/multi-colony-timeline.md:
 *
 *   every worker of every colony that reaches a site is an arrival with a minute; arrivals are resolved in time
 *   order; all arrivals at the same site in the same minute form one window, whatever colony they belong to and
 *   wherever that colony sits in the colonies[] array.
 *
 * What it deliberately does NOT model (no evidence-based rule yet): fighting, displacement, death, territory. When
 * workers of different colonies meet, it records an `encounter` and resolves food by the neutral rule below;
 * that neutral rule is a placeholder, not a claim about real ants (see the design doc).
 */

export interface Arrival { colony: string; worker: string; site: string; minute: number; capacity: number }
export interface Take { colony: string; worker: string; site: string; minute: number; taken: number }
export interface Encounter { site: string; minute: number; colonies: string[]; workers: string[] }
export interface MarkSensed { colony: string; worker: string; site: string; minute: number; foreign_colony: string; intensity: number }
export interface Mark { colony: string; intensity: number }
export interface Result { takes: Take[]; encounters: Encounter[]; marks_sensed: MarkSensed[]; stock_after: Record<string, number> }

const UNIT = 1e6; // work in integer micro-portions so sharing is exact
const key = (a: { colony: string; worker: string }) => a.colony + '/' + a.worker;

/**
 * Neutral placeholder for simultaneous arrivals: if the food present is less than what the workers present can
 * carry, it is shared in proportion to carrying capacity (largest remainder, ties by colony/worker id). Nobody
 * is favoured by input order or colony order.
 */
function share(window: Arrival[], stock: number): Map<string, number> {
  const ws = [...window].sort((a, b) => key(a).localeCompare(key(b)));
  const want = ws.map((a) => Math.round(a.capacity * UNIT)), total = want.reduce((x, y) => x + y, 0), avail = Math.round(stock * UNIT);
  const out = new Map<string, number>();
  if (total <= avail) { ws.forEach((a, i) => out.set(key(a), want[i])); return out; }
  const exact = want.map((w) => (w * avail) / total), base = exact.map(Math.floor);
  let left = avail - base.reduce((x, y) => x + y, 0);
  const order = exact.map((e, i) => ({ i, r: e - base[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) { if (left <= 0) break; base[i]++; left--; }
  ws.forEach((a, i) => out.set(key(a), base[i]));
  return out;
}

/**
 * Resolve arrivals on ONE world clock. `marks` are colony-specific chemical marks lying at sites; a worker senses
 * a foreign mark only at the site it actually reached (local perception, no broadcast). Input order is irrelevant.
 */
export function resolveTimeline(arrivals: Arrival[], stock: Record<string, number>, marks: Record<string, Mark[]> = {}): Result {
  const left: Record<string, number> = Object.fromEntries(Object.entries(stock).map(([s, v]) => [s, Math.round(v * UNIT)]));
  const windows = new Map<string, Arrival[]>();
  for (const a of arrivals) {
    if (!Number.isFinite(a.minute) || a.minute < 0 || a.capacity < 0) throw Error('invalid arrival ' + JSON.stringify(a));
    const k = a.minute + '@' + a.site; if (!windows.has(k)) windows.set(k, []); (windows.get(k) as Arrival[]).push(a);
  }
  const order = [...windows.values()].sort((x, y) => x[0].minute - y[0].minute || x[0].site.localeCompare(y[0].site));
  const takes: Take[] = [], encounters: Encounter[] = [], marks_sensed: MarkSensed[] = [];
  for (const w of order) {
    const { site, minute } = w[0], colonies = [...new Set(w.map((a) => a.colony))].sort();
    if (colonies.length > 1) encounters.push({ site, minute, colonies, workers: w.map(key).sort() });
    for (const a of [...w].sort((x, y) => key(x).localeCompare(key(y)))) for (const m of marks[site] ?? []) if (m.colony !== a.colony) marks_sensed.push({ colony: a.colony, worker: a.worker, site, minute, foreign_colony: m.colony, intensity: m.intensity });
    const got = share(w, (left[site] ?? 0) / UNIT);
    for (const a of [...w].sort((x, y) => key(x).localeCompare(key(y)))) {
      const t = got.get(key(a)) ?? 0; left[site] = (left[site] ?? 0) - t;
      takes.push({ colony: a.colony, worker: a.worker, site, minute, taken: t / UNIT });
    }
  }
  return { takes, encounters, marks_sensed, stock_after: Object.fromEntries(Object.entries(left).map(([s, v]) => [s, v / UNIT])) };
}

/** What the current engine effectively does (#9): each colony's whole day in colonies[] order, then the next. */
export function sequentialByColony(arrivals: Arrival[], colonyOrder: string[], stock: Record<string, number>): { takes: Take[] } {
  const left = { ...stock }, takes: Take[] = [];
  for (const c of colonyOrder) for (const a of arrivals.filter((x) => x.colony === c).sort((x, y) => x.minute - y.minute)) {
    const t = Math.min(a.capacity, left[a.site] ?? 0); left[a.site] = (left[a.site] ?? 0) - t;
    takes.push({ colony: a.colony, worker: a.worker, site: a.site, minute: a.minute, taken: t });
  }
  return { takes };
}

/** Species differences enter only through parameters, e.g. walking time per edge (no species names in code). */
export const arrivalMinute = (edges: number, edgeMinutes: number, speedFactor: number, departMinute = 0): number => departMinute + (edges * edgeMinutes) / speedFactor;
