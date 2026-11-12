/**
 * P0-A2 PR 2 — non-official experiment Worker runtime (Owner decision #39). Blocking. Runs the SAME core and
 * dispatcher the browser Worker runs (prototypes/continuous-world/worker/), under Node:
 *  1. platform: SHA-256 port = node:crypto; protocol copies byte-identical; purity scan (no wall clock / randomness in
 *     the core; only entry.ts touches the timer); Worker tsconfig is WebWorker-only and limited to the allowlist.
 *  2. labels: every event, frame, snapshot and reply is non-official.
 *  3. time contract: seq contiguous, exact instants non-decreasing, one instant processed as one contiguous group, each
 *     ant's random stream consumed contiguously, ledgers conserved, light events at the solar-method instants.
 *  4. replay: same seed -> identical; different seed -> different.
 *  5. snapshot / restore: 48 h continuous == 24 h -> snapshot -> (structured-clone) -> new instance -> 24 h, for the full
 *     state, the event sequence and every random draw; also at an event instant, at midnight and at 23:59:59.5.
 *     Taking snapshots (and following an individual) changes nothing. Tampered or foreign snapshots are refused and the
 *     current world is kept.
 *  6. chunking and pacing: arbitrary step_until chunks, speeds, pauses, tick sizes and a tiny work budget -> identical
 *     results at the same world time; scheduler compaction is behaviour-neutral.
 *  7. formal data: saves/ and journal/ hashes unchanged.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../cli/lib/load.ts';
import { ExperimentWorld, ExperimentRefused, LABEL_ZH, RULES_FINGERPRINT, secondsOf, type ExperimentEvent, type ExperimentSnapshot } from '../prototypes/continuous-world/worker/core.ts';
import { Runtime } from '../prototypes/continuous-world/worker/runtime.ts';
import { sha256Hex, canonicalJson, hashJson } from '../prototypes/continuous-world/worker/sha256.ts';
import { DEFAULT_PARAMS } from '../prototypes/continuous-world/worker/params.ts';
import { detLog, unitVector } from '../prototypes/continuous-world/worker/detmath.ts';
import { lightTimes } from '../engine/clock/solar.ts';
import { dateOfDay } from '../engine/clock/time-frames.ts';
import { compareExact } from '../engine/scheduler/world-events.ts';

let checks = 0; const ok = (c: unknown, why: string) => { assert.ok(c, why); checks++; };
const H = 3600, DAY = 86400;
const W = 'prototypes/continuous-world/worker';
const dirHash = (d: string) => { const h = crypto.createHash('sha256'); const walk = (p: string) => { for (const e of fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else { h.update(path.relative(REPO_ROOT, f)); h.update(fs.readFileSync(f)); } } }; walk(path.join(REPO_ROOT, d)); return h.digest('hex'); };
const formalBefore = { saves: dirHash('saves'), journal: dirHash('journal') };
const clone = <T>(v: T): T => structuredClone(v);
const ser = (evs: ExperimentEvent[]) => evs.map((e) => JSON.stringify(e));
const run = (seed: number, t: number, id = 'exp-test') => { const c = ExperimentWorld.create(id, seed); const r = c.world.advanceTo(t); return { world: c.world, events: [...c.events, ...r.events] }; };
const refusedWith = (f: () => unknown, code: string) => { try { f(); return false; } catch (e) { return e instanceof ExperimentRefused && e.code === code; } };

// ---------------------------------------------------------------- 1. platform
for (const s of ['', 'abc', '螞蟻帝國 非正式', 'x'.repeat(1000), '\u{1F41C}']) ok(sha256Hex(s) === crypto.createHash('sha256').update(s, 'utf8').digest('hex'), `sha256 port = node:crypto (${s.length} chars)`);
ok(canonicalJson({ b: 1, a: [-0, 'x'] }) === '{"a":[0,"x"],"b":1}', 'canonical JSON: sorted keys, -0 -> 0');
ok(fs.readFileSync(path.join(REPO_ROOT, W, 'protocol.ts'), 'utf8') === fs.readFileSync(path.join(REPO_ROOT, 'web/src/experimental/worker-protocol.ts'), 'utf8'), 'protocol.ts and web/src/experimental/worker-protocol.ts are byte-identical');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
for (const f of fs.readdirSync(path.join(REPO_ROOT, W)).filter((x) => x.endsWith('.ts'))) {
  const code = strip(fs.readFileSync(path.join(REPO_ROOT, W, f), 'utf8'));
  ok(!/Math\.random|Date\.now|new Date\(|requestAnimationFrame|setInterval/.test(code), `${f}: no randomness, date or frame timer`);
  if (f !== 'entry.ts') ok(!/performance|setTimeout/.test(code), `${f}: no wall clock or timer (only entry.ts paces)`);
}
// cross-platform determinism: ant rules use only IEEE basic operations and Math.sqrt (detmath.ts)
for (const f of ['core.ts', 'detmath.ts', 'rng.ts', 'runtime.ts']) ok(!/Math\.(sin|cos|tan|asin|acos|atan|atan2|log|log2|log10|log1p|exp|expm1|pow|hypot|cbrt|sinh|cosh|tanh|PI)\b|\*\*/.test(strip(fs.readFileSync(path.join(REPO_ROOT, W, f), 'utf8'))), `${f}: no implementation-approximated Math function (cross-platform determinism)`);
{
  let maxRel = 0; for (let i = 1; i <= 20000; i++) { const x = i / 20001; maxRel = Math.max(maxRel, Math.abs(detLog(x) - Math.log(x)) / Math.max(1e-300, Math.abs(Math.log(x)))); }
  for (const x of [2 ** -32, 1e-9, 0.5, 1 - 2 ** -53]) maxRel = Math.max(maxRel, Math.abs(detLog(x) - Math.log(x)) / Math.abs(Math.log(x)));
  ok(detLog(1) === 0 && maxRel < 1e-14, `detLog matches Math.log within ${maxRel.toExponential(2)} relative`);
  let st = 12345; const u = () => { st = (st * 1103515245 + 12345) % 2147483648; return st / 2147483648; };
  let bad = 0, sx = 0, sy = 0; for (let i = 0; i < 20000; i++) { const v = unitVector(u); if (Math.abs(v.x * v.x + v.y * v.y - 1) > 1e-15) bad++; sx += v.x; sy += v.y; }
  ok(bad === 0 && Math.abs(sx / 20000) < 0.02 && Math.abs(sy / 20000) < 0.02, 'unitVector: unit length, no directional bias (mean within 0.02)');
}
const wts = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, W, 'tsconfig.json'), 'utf8'));
const boundary = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'prototypes/continuous-world/worker-boundary.json'), 'utf8'));
ok(JSON.stringify(wts.compilerOptions.lib) === '["ES2023","WebWorker"]' && JSON.stringify(wts.compilerOptions.types) === '[]', 'Worker tsconfig: WebWorker lib only, no Node or DOM types');
for (const inc of wts.include as string[]) { const rel = path.relative(REPO_ROOT, path.resolve(REPO_ROOT, W, inc)).split(path.sep).join('/'); ok(rel.startsWith(`${W}/`) || boundary.allowed_import_prefixes.some((p: string) => rel.startsWith(p)), `Worker tsconfig include ${inc} is inside the Worker dir or the allowlist`); }
ok(path.relative(REPO_ROOT, path.resolve(REPO_ROOT, W, wts.compilerOptions.outDir)) === path.join('web', 'worker-dist') && fs.readFileSync(path.join(REPO_ROOT, '.gitignore'), 'utf8').split('\n').includes('web/worker-dist/'), 'Worker build output web/worker-dist/ is gitignored');
const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
ok(pkg.scripts.typecheck.includes(`${W}/tsconfig.json`) && pkg.scripts['web:build'].includes(`${W}/tsconfig.json`), 'typecheck and web:build include the Worker tsconfig');
for (const k of Object.keys(DEFAULT_PARAMS.labels)) ok(DEFAULT_PARAMS.labels[k].assumption === true, `param ${k} is labelled assumption:true`);
for (const k of Object.keys(DEFAULT_PARAMS).filter((k) => !['schema', 'synthetic', 'labels'].includes(k))) ok(k in DEFAULT_PARAMS.labels, `param ${k} has a label`);

// ---------------------------------------------------------------- 2-3. a 48 h reference run: labels and time-contract invariants
const A = run(7, 48 * H);
ok(A.events.length > 1000, `48 h reference run produced ${A.events.length} events`);
ok(A.events.every((e) => e.official === false && e.label === LABEL_ZH && e.world_id === 'exp-test' && e.seed === 7 && e.rules_fingerprint === RULES_FINGERPRINT && typeof e.engine_version === 'string' && e.schema_version === 1), 'every event carries official:false, the label, world id, seed, rules fingerprint and versions');
ok(A.events.every((e, i) => e.seq === i), 'seq is contiguous from 0');
ok(new Set(A.events.map((e) => e.event_id)).size === A.events.length, 'event ids are unique');
let mono = true, grouped = true; const seenInstant = new Set<string>();
for (let i = 0; i < A.events.length; i++) {
  const e = A.events[i], k = JSON.stringify(e.exact);
  if (i > 0) { const c = compareExact(A.events[i - 1].exact, e.exact); if (c > 0) mono = false; if (c !== 0 && seenInstant.has(k)) grouped = false; }
  seenInstant.add(k);
  if (e.t_sim !== secondsOf(e.exact)) mono = false;
}
ok(mono, 'exact instants are non-decreasing and t_sim follows the exact instant');
ok(grouped, 'all events of one exact instant are processed as one contiguous group');
const midnight = A.events.filter((e) => e.exact.day === 1 && e.exact.us === 0 && e.exact.us_lo === 0).map((e) => e.kind).sort();
ok(JSON.stringify(midnight) === '["env_day","env_hour"]', `day 1 00:00: env_day and env_hour are one same-instant batch (${midnight})`);
const draws = new Map<string, number>(); let contiguous = true;
for (const e of A.events) if (e.rng) { const prev = draws.get(e.rng.stream) ?? 1; if (e.rng.from_draw !== prev) contiguous = false; draws.set(e.rng.stream, e.rng.from_draw + e.rng.values.length); }
ok(contiguous && draws.size === DEFAULT_PARAMS.n_ants, 'each ant draws from its own named stream, contiguously (no draw skipped or reused)');
const snapA = A.world.snapshot();
ok(Object.entries(snapA.payload.rng).every(([k, s]) => s.draws === draws.get(k)), 'stream positions in the snapshot equal the draws seen in the events');
A.world.checkLedgers(); checks++;
ok(Object.values(snapA.payload.ledgers.events_by_kind).reduce((x, y) => x + y, 0) === A.events.length, 'ledger: events by kind sum to the event count');
for (const day of [0, 1]) {
  const lt = lightTimes(DEFAULT_PARAMS.site, DEFAULT_PARAMS.calendar, dateOfDay(DEFAULT_PARAMS.calendar, day));
  const got = A.events.filter((e) => e.kind === 'light_change' && e.exact.day === day).map((e) => e.data.minute_of_day);
  ok(JSON.stringify(got) === JSON.stringify([lt.civil_dawn, lt.sunrise, lt.sunset, lt.civil_dusk]), `day ${day}: light events at the solar-method instants, in order`);
}
const temps = A.events.filter((e) => e.kind === 'env_hour');
ok(temps.length === 49 && temps.every((e) => e.data.synthetic === true && e.data.assumption === true), 'hourly temperature events (00:00 day 0 to 00:00 day 2 inclusive: 49) are labelled synthetic / assumption');
const f0 = A.world.frame();
ok(f0.official === false && f0.label === LABEL_ZH && f0.ants.length === DEFAULT_PARAMS.n_ants, 'state frame is labelled and has every ant');
ok(snapA.label === LABEL_ZH && snapA.official === false && snapA.schema === 'antempire.experiment-world-snapshot.v1', 'snapshot is labelled non-official');
ok(Object.keys(snapA).sort().join() === 'engine_version,label,official,payload,payload_sha256,rules_fingerprint,schema,schema_version,seed,seq,t_sim,world_id', 'snapshot has exactly the SAVE-system fields');
ok(snapA.payload_sha256 === crypto.createHash('sha256').update(canonicalJson(snapA.payload)).digest('hex'), 'payload_sha256 = sha256(canonical JSON of payload) (node:crypto)');
ok(snapA.payload.ants.every((a) => a.id && a.activity && a.pos && Array.isArray(a.memory) && a.next_event) && snapA.payload.scheduler.events.length === DEFAULT_PARAMS.n_ants + 2 + snapA.payload.scheduler.events.filter((e) => e.kind === 'light_change').length, 'payload holds ids, activities, positions, memory and the pending queue');

// ---------------------------------------------------------------- 4. replay
const A2 = run(7, 48 * H);
ok(JSON.stringify(ser(A2.events)) === JSON.stringify(ser(A.events)) && A2.world.snapshot().payload_sha256 === snapA.payload_sha256, 'same seed and rules -> identical events and state');
const B = run(8, 48 * H);
ok(B.world.snapshot().payload_sha256 !== snapA.payload_sha256, 'a different seed gives a different world');

// ---------------------------------------------------------------- 5. snapshot / restore
const splitCheck = (tSplit: number, label: string) => {
  const c = ExperimentWorld.create('exp-test', 7), first = [...c.events, ...c.world.advanceTo(tSplit).events];
  const s = clone(c.world.snapshot());
  const w2 = ExperimentWorld.restore(s), second = w2.advanceTo(48 * H).events;
  const all = [...first, ...second];
  ok(JSON.stringify(ser(all)) === JSON.stringify(ser(A.events)), `${label}: event sequence (incl. every random draw) identical to the continuous 48 h run`);
  ok(canonicalJson(w2.payload()) === canonicalJson(A.world.payload()), `${label}: full state at 48 h identical (ants, memory, queue, streams, environment, ledgers)`);
};
splitCheck(24 * H, '24 h split');
splitCheck(A.events[Math.floor(A.events.length / 3)].t_sim, 'split at an event instant');
splitCheck(DAY, 'split exactly at midnight (same-instant batch)');
splitCheck(DAY - 0.5, 'split at 23:59:59.5');
// snapshot purity: snapshots at many points change nothing
{
  const c = ExperimentWorld.create('exp-test', 7); const evs = [...c.events];
  for (let t = 997; t < 48 * H; t += 997) { evs.push(...c.world.advanceTo(t).events); const s1 = c.world.snapshot(), s2 = c.world.snapshot(); if (s1.payload_sha256 !== s2.payload_sha256 || s1.seq !== c.world.seqNo()) throw Error('snapshot changed the world'); }
  evs.push(...c.world.advanceTo(48 * H).events);
  ok(JSON.stringify(ser(evs)) === JSON.stringify(ser(A.events)) && c.world.snapshot().payload_sha256 === snapA.payload_sha256, 'taking ~170 snapshots consumes no random draw and changes no event or state');
}
// refusals
const s24 = (() => { const c = ExperimentWorld.create('exp-test', 7); c.world.advanceTo(24 * H); return c.world.snapshot(); })();
const tamper = (f: (s: ExperimentSnapshot) => void, rehash = false) => { const s = clone(s24); f(s); if (rehash) s.payload_sha256 = hashJson(s.payload); return s; };
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.ants[0].pos.x += 1; })), 'HASH_MISMATCH'), 'refused: payload changed without its hash');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload_sha256 = '0'.repeat(64); })), 'HASH_MISMATCH'), 'refused: wrong hash');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.schema = 'antempire.experiment-world-snapshot.v0'; })), 'SCHEMA_MISMATCH'), 'refused: other schema');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { (s as { official: boolean }).official = true; })), 'NOT_EXPERIMENT'), 'refused: official:true');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.label = '正式'; })), 'NOT_EXPERIMENT'), 'refused: label removed');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.engine_version = 'x'; })), 'ENGINE_MISMATCH'), 'refused: other engine version');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.seed = 8; })), 'HEADER_MISMATCH'), 'refused: header and payload disagree');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.params.walk_speed_cm_s = 2; }, true)), 'FINGERPRINT_MISMATCH'), 'refused: parameters changed (even with a recomputed hash)');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.rules_fingerprint = s.payload.rules_fingerprint = 'f'.repeat(64); }, true)), 'FINGERPRINT_MISMATCH'), 'refused: foreign rules fingerprint');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.scheduler.events = s.payload.scheduler.events.filter((e) => e.kind !== 'env_hour'); }, true)), 'BAD_STATE'), 'refused: queue missing a pending event');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.scheduler.events[0].exact.us += 1; }, true)), 'BAD_QUEUE'), 'refused: queue time not following its native time');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.ants[0].until_s += 1; }, true)), 'BAD_STATE'), 'refused: ant and its pending event disagree');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { s.payload.ledgers.events_by_kind.env_hour += 1; }, true)), 'LEDGER_MISMATCH'), 'refused: ledger does not conserve');
ok(refusedWith(() => ExperimentWorld.restore(tamper((s) => { delete s.payload.rng['ant/w01']; }, true)), 'BAD_STATE'), 'refused: random stream missing');
ok(refusedWith(() => ExperimentWorld.restore(null as unknown as ExperimentSnapshot), 'BAD_SNAPSHOT'), 'refused: not a snapshot');

// ---------------------------------------------------------------- 6. dispatcher, pacing, chunking, follow
let wall = 0; const rt = new Runtime(() => wall);
const send = (m: unknown) => rt.handle(m);
const last = (rs: ReturnType<Runtime['handle']>) => rs[rs.length - 1];
ok(last(send({ type: 'hack', req: 1 })).type === 'error', 'unknown command rejected');
ok(last(send({ type: 'start', req: 2 })).type === 'error', 'start before init rejected');
ok((last(send({ type: 'init', req: 3, world_id: 'official', seed: 1 })) as { code: string }).code === 'BAD_WORLD_ID', 'init refuses a world id without the exp- prefix');
const initR = send({ type: 'init', req: 4, world_id: 'exp-test', seed: 7 });
ok(initR.every((r) => r.official === false && r.label === LABEL_ZH), 'every reply carries the non-official label');
ok((last(send({ type: 'set_speed', req: 5, speed: 0 })) as { code: string }).code === 'BAD_SPEED' && (last(send({ type: 'set_speed', req: 6, speed: Infinity })) as { code: string }).code === 'BAD_SPEED', 'bad speeds rejected');
ok((last(send({ type: 'follow', req: 7, id: 'w99' })) as { code: string }).code === 'UNKNOWN_INDIVIDUAL', 'follow of an unknown id rejected');
send({ type: 'step_until', req: 8, t_sim: 100 });
ok((last(send({ type: 'step_until', req: 9, t_sim: 50 })) as { code: string }).code === 'TIME_BACKWARDS', 'step_until backwards refused');
const before = rt.current()!.snapshot().payload_sha256;
ok((last(send({ type: 'restore', req: 10, snapshot: tamper((s) => { s.payload.ants[0].pos.x += 1; }) })) as { code: string }).code === 'HASH_MISMATCH' && rt.current()!.snapshot().payload_sha256 === before, 'a refused restore keeps the current world (no re-init)');
// pacing scenario: speeds, pauses, irregular ticks and a tiny budget, then step to 48 h
const paced = (plan: { speed: number; ticks: number[]; pauseAfter?: number }[], budget: number, follow: string | null) => {
  wall = 0; Runtime.BUDGET = budget; const r = new Runtime(() => wall); const evs: ExperimentEvent[] = []; let lagged = false;
  const take = (rs: ReturnType<Runtime['handle']>) => { for (const x of rs) { if (x.type === 'events') evs.push(...(x.events as unknown as ExperimentEvent[])); if ((x.type === 'state' || x.type === 'ack') && x.pacing.lagging) lagged = true; } };
  take(r.handle({ type: 'init', req: 1, world_id: 'exp-test', seed: 7 }));
  if (follow) take(r.handle({ type: 'follow', req: 2, id: follow }));
  take(r.handle({ type: 'start', req: 3 }));
  for (const p of plan) {
    take(r.handle({ type: 'set_speed', req: 4, speed: p.speed }));
    for (const dt of p.ticks) { wall += dt; take(r.tick()); }
    if (p.pauseAfter !== undefined) { take(r.handle({ type: 'pause', req: 5 })); wall += p.pauseAfter; take(r.tick()); take(r.handle({ type: 'resume', req: 6 })); }
  }
  take(r.handle({ type: 'pause', req: 7 }));
  const t = r.current()!.tSim();
  take(r.handle({ type: 'step_until', req: 8, t_sim: 48 * H }));
  Runtime.BUDGET = 20_000;
  return { evs, snap: r.current()!.snapshot(), t, lagged };
};
const P1 = paced([{ speed: 60, ticks: Array(300).fill(16) }, { speed: 3600, ticks: Array(200).fill(16), pauseAfter: 5000 }, { speed: 1, ticks: [5, 40, 3, 250] }], 20_000, null);
const P2 = paced([{ speed: 86_400, ticks: [7, 33, 120, 1, 1, 500, 64], pauseAfter: 99 }, { speed: 0.1, ticks: Array(50).fill(16) }, { speed: 600, ticks: [1000, 2000] }], 3, 'w03');
ok(P1.t > 0 && P2.t > 0 && P1.t !== P2.t, `pacing scenarios reached different world times before the final step (${P1.t.toFixed(1)} s vs ${P2.t.toFixed(1)} s)`);
ok(P2.lagged, 'the tiny-budget scenario lagged (reported), so the budget path is exercised');
ok(JSON.stringify(ser(P1.evs)) === JSON.stringify(ser(A.events)) && JSON.stringify(ser(P2.evs)) === JSON.stringify(ser(A.events)), 'different speeds, pauses, tick sizes, work budgets and follow -> the identical event sequence (none skipped)');
ok(P1.snap.payload_sha256 === snapA.payload_sha256 && P2.snap.payload_sha256 === snapA.payload_sha256, 'and the identical full state at 48 h');
// chunked step_until
{
  const c = ExperimentWorld.create('exp-test', 7); const evs = [...c.events]; let t = 0, k = 1;
  while (t < 48 * H) { t = Math.min(48 * H, t + ((k * 7919) % 5000) + 0.25); k++; evs.push(...c.world.advanceTo(t).events); }
  ok(JSON.stringify(ser(evs)) === JSON.stringify(ser(A.events)) && c.world.snapshot().payload_sha256 === snapA.payload_sha256, `${k - 1} irregular step_until chunks -> identical events and state`);
}
// compaction neutrality
{
  const old = ExperimentWorld.COMPACT_AFTER;
  ExperimentWorld.COMPACT_AFTER = 7; const c1 = run(7, 48 * H);
  ExperimentWorld.COMPACT_AFTER = 1e12; const c2 = run(7, 48 * H);
  ExperimentWorld.COMPACT_AFTER = old;
  ok(JSON.stringify(ser(c1.events)) === JSON.stringify(ser(A.events)) && JSON.stringify(ser(c2.events)) === JSON.stringify(ser(A.events)) && c1.world.snapshot().payload_sha256 === snapA.payload_sha256 && c2.world.snapshot().payload_sha256 === snapA.payload_sha256, 'scheduler compaction every 7 events vs never -> identical (behaviour-neutral)');
}
// synthetic ants do not read the environment: no ant event carries environment data
ok(A.events.filter((e) => e.kind === 'ant_bout_end').every((e) => !('temperature_c' in e.data) && !('light' in e.data)), 'ant events carry no environment input (synthetic ants do not read the environment)');

// ---------------------------------------------------------------- 7. formal data untouched
ok(dirHash('saves') === formalBefore.saves && dirHash('journal') === formalBefore.journal, 'saves/ and journal/ unchanged by the experiment runtime');
console.log(JSON.stringify({ test: 'worker-runtime', checks, events_48h: A.events.length, payload_sha256_48h: snapA.payload_sha256, snapshot_bytes: JSON.stringify(snapA).length, rules_fingerprint: RULES_FINGERPRINT }));
