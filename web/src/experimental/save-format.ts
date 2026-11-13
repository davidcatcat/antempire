/**
 * Pure logic of the non-official experiment-world save system (SAVE-1; contract in docs/experimental-save-system.md).
 * No browser persistence here: only web/src/experimental/save-store.ts touches IndexedDB / Web Locks. This module
 * holds what can be tested in Node: canonical JSON + SHA-256, envelope validation, version compatibility, the explicit
 * migration registry, export / import validation, retention planning and the autosave policy state machine.
 * The snapshot payload is opaque: it is hashed, copied and handed back, never interpreted.
 */

export const SNAPSHOT_SCHEMA = 'antempire.experiment-world-snapshot.v1';
export const EXPORT_SCHEMA = 'antempire.experiment-world-export.v1';
export const LABEL = '非正式實驗世界／不屬於正式遊戲歷史';
/** Payload schema version this build of the viewer understands. */
export const CURRENT_SCHEMA_VERSION = 1;
/** Verified snapshots kept per world (product assumption, minimum 2; prototypes/continuous-world/save/save-db.v1.json). */
export const RETAIN_VERIFIED = 3;
/** Autosave check period in real seconds (product assumption, to be confirmed by measured write cost). */
export const AUTOSAVE_INTERVAL_S = 30;
export const LOCK_PREFIX = 'antempire-experiment-world:';
/** Manual saves kept per world, separate from the rotating autosave recovery points (Owner decision 55; product
 *  assumption: a cap so storage cannot grow without bound — the 21st manual save is refused, never rotated out). */
export const MANUAL_KEEP_MAX = 20;
/** Largest import file accepted (Owner decision 57: bounded resource use). Product assumption. */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
/** Same pattern as the Worker runtime (prototypes/continuous-world/worker/core.ts). */
const WORLD_ID = /^exp-[A-Za-z0-9._-]{1,60}$/;
const isSeed = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 0xffffffff;
const HEX64 = /^[0-9a-f]{64}$/;

export interface SnapshotEnvelope {
  schema: typeof SNAPSHOT_SCHEMA; label: typeof LABEL; official: false;
  world_id: string; seed: number; rules_fingerprint: string; engine_version: string; schema_version: number;
  t_sim: number; seq: number; payload: Record<string, unknown>; payload_sha256: string;
}
export type SnapshotHeader = Omit<SnapshotEnvelope, 'payload'>;
/** What the running Worker build expects; snapshots are compared against it on load. */
export interface RuntimeInfo { rules_fingerprint: string; engine_version: string; schema_version: number }

export type SaveErrorCode = 'quota_exceeded' | 'aborted' | 'verify_failed' | 'conflict' | 'not_writer' | 'write_failed' | 'world_exists'
  | 'unknown_world' | 'invalid_snapshot' | 'no_valid_snapshot' | 'unknown_schema' | 'newer_schema' | 'rules_mismatch' | 'migration_failed'
  | 'unsupported' | 'invalid_import' | 'confirmation_required' | 'manual_limit' | 'import_too_large' | 'worker_failed';
export type Result<T> = { ok: true; value: T } | { ok: false; code: SaveErrorCode; message: string };
export const okR = <T>(value: T): Result<T> => ({ ok: true, value });
export const errR = <T = never>(code: SaveErrorCode, message: string): Result<T> => ({ ok: false, code, message });

// ---------- canonical JSON and hashing ----------

/** Canonical JSON: sorted keys, no whitespace, JSON.stringify numbers; rejects non-JSON values (contract §2). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new TypeError('non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => { if (o[k] === undefined) throw new TypeError(`undefined at ${k}`); return `${JSON.stringify(k)}:${canonicalJson(o[k])}`; }).join(',')}}`;
  }
  throw new TypeError(`not canonical-JSON compatible: ${Object.prototype.toString.call(v)}`);
}

export async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  let s = ''; for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

// ---------- envelope validation ----------

const FIELDS = ['schema', 'label', 'official', 'world_id', 'seed', 'rules_fingerprint', 'engine_version', 'schema_version', 't_sim', 'seq', 'payload', 'payload_sha256'] as const;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

/** Shape check mirroring experiment-world-snapshot.v1.schema.json (the test cross-checks both). Empty list = valid. */
export function envelopeErrors(x: unknown): string[] {
  if (!isObj(x)) return ['envelope is not an object'];
  const e: string[] = [];
  for (const k of FIELDS) if (!(k in x)) e.push(`${k}: required`);
  for (const k of Object.keys(x)) if (!(FIELDS as readonly string[]).includes(k)) e.push(`${k}: not allowed`);
  if ('schema' in x && x.schema !== SNAPSHOT_SCHEMA) e.push('schema: unknown');
  if ('label' in x && x.label !== LABEL) e.push('label: must be the non-official label');
  if ('official' in x && x.official !== false) e.push('official: must be false');
  if ('world_id' in x && !(typeof x.world_id === 'string' && WORLD_ID.test(x.world_id))) e.push('world_id: invalid');
  if ('seed' in x && !isSeed(x.seed)) e.push('seed: integer in [0, 2^32)');
  for (const k of ['rules_fingerprint', 'engine_version'] as const) if (k in x && !(typeof x[k] === 'string' && (x[k] as string).length > 0)) e.push(`${k}: non-empty string`);
  if ('schema_version' in x && !(Number.isInteger(x.schema_version) && (x.schema_version as number) >= 1)) e.push('schema_version: integer >= 1');
  if ('t_sim' in x && !(typeof x.t_sim === 'number' && Number.isFinite(x.t_sim) && x.t_sim >= 0)) e.push('t_sim: finite >= 0');
  if ('seq' in x && !(Number.isInteger(x.seq) && (x.seq as number) >= 0)) e.push('seq: integer >= 0');
  if ('payload' in x && !isObj(x.payload)) e.push('payload: object');
  if ('payload_sha256' in x && !(typeof x.payload_sha256 === 'string' && HEX64.test(x.payload_sha256))) e.push('payload_sha256: 64 lower-case hex');
  return e;
}

export const headerOf = (env: SnapshotEnvelope): SnapshotHeader => { const { payload: _p, ...h } = env; return h; };

/** Full check: shape + payload hash. Returns the canonical payload text the store will persist. */
export async function verifyEnvelope(x: unknown): Promise<Result<{ envelope: SnapshotEnvelope; payload_json: string }>> {
  const e = envelopeErrors(x);
  if (e.length) return errR('invalid_snapshot', e.join('; '));
  const env = x as SnapshotEnvelope;
  let payload_json: string;
  try { payload_json = canonicalJson(env.payload); } catch (err) { return errR('invalid_snapshot', `payload is not canonical JSON: ${(err as Error).message}`); }
  if (await sha256Hex(payload_json) !== env.payload_sha256) return errR('invalid_snapshot', 'payload_sha256 does not match the payload');
  return okR({ envelope: env, payload_json });
}

/** Build a sealed envelope from a header and payload (used by tests and by the Worker side of the contract). */
export async function sealEnvelope(h: Omit<SnapshotHeader, 'schema' | 'label' | 'official' | 'payload_sha256'>, payload: Record<string, unknown>): Promise<SnapshotEnvelope> {
  return { schema: SNAPSHOT_SCHEMA, label: LABEL, official: false, world_id: h.world_id, seed: h.seed, rules_fingerprint: h.rules_fingerprint, engine_version: h.engine_version, schema_version: h.schema_version, t_sim: h.t_sim, seq: h.seq, payload, payload_sha256: await sha256Hex(canonicalJson(payload)) };
}

// ---------- compatibility and migrations ----------

export type Compatibility = 'compatible' | 'migratable' | 'newer_schema' | 'unknown_schema' | 'rules_mismatch' | 'no_migration_path';

export type Migration = (env: SnapshotEnvelope) => SnapshotEnvelope;
/** Explicit, step-by-step migrations of the payload schema (n -> n+1). Original snapshots are never modified. */
export class MigrationRegistry {
  private steps = new Map<number, Migration>();
  readonly current: number;
  constructor(current = CURRENT_SCHEMA_VERSION) { this.current = current; }
  register(from: number, fn: Migration): this { if (this.steps.has(from)) throw new Error(`migration from v${from} already registered`); this.steps.set(from, fn); return this; }
  hasPath(from: number): boolean { for (let v = from; v < this.current; v++) if (!this.steps.has(v)) return false; return from <= this.current; }
  /** Migrate a deep copy; every step must raise schema_version by exactly one; the hash is recomputed. */
  async migrate(env: SnapshotEnvelope): Promise<Result<{ envelope: SnapshotEnvelope; from: number }>> {
    const from = env.schema_version;
    if (from > this.current) return errR('newer_schema', `snapshot schema v${from} is newer than this viewer (v${this.current})`);
    if (!this.hasPath(from)) return errR('migration_failed', `no migration path from v${from} to v${this.current}`);
    let cur: SnapshotEnvelope;
    try {
      cur = JSON.parse(canonicalJson(env)) as SnapshotEnvelope; // v1 -> v1 is the identity on this copy
      for (let v = from; v < this.current; v++) {
        const next = this.steps.get(v)!(JSON.parse(canonicalJson(cur)) as SnapshotEnvelope);
        if (!next || next.schema_version !== v + 1) throw new Error(`step v${v} did not produce v${v + 1}`);
        cur = { ...next, payload_sha256: await sha256Hex(canonicalJson(next.payload)) };
        const e = envelopeErrors(cur); if (e.length) throw new Error(`step v${v} produced an invalid envelope: ${e.join('; ')}`);
      }
    } catch (err) { return errR('migration_failed', (err as Error).message); }
    return okR({ envelope: cur, from });
  }
}
export const defaultMigrations = () => new MigrationRegistry(CURRENT_SCHEMA_VERSION);

export function compatibility(h: Pick<SnapshotHeader, 'schema' | 'rules_fingerprint' | 'schema_version'>, rt: RuntimeInfo, reg: MigrationRegistry): Compatibility {
  if (h.schema !== SNAPSHOT_SCHEMA) return 'unknown_schema';
  if (h.schema_version > rt.schema_version) return 'newer_schema';
  // an older payload schema with no registered path to the runtime's is reported as such (clearer than rules_mismatch:
  // e.g. payload schema 1 has no event-chain commitment and cannot be migrated, docs/save-format-v2.md §6)
  if (h.schema_version < rt.schema_version && !(reg.current >= rt.schema_version && reg.hasPath(h.schema_version))) return 'no_migration_path';
  if (h.rules_fingerprint !== rt.rules_fingerprint) return 'rules_mismatch';
  if (h.schema_version === rt.schema_version) return 'compatible';
  return reg.hasPath(h.schema_version) ? 'migratable' : 'no_migration_path';
}

// ---------- verification status (Owner ruling #200; docs/save-format-v2.md §8) ----------

/**
 * The three statuses of a save. The browser can reach only the first two: 'integrity_ok' means hashes, envelope,
 * versions and the Worker's structural restore checks passed on THIS device; it is not a scientific verification.
 * 'node_verified' is set only from a report of the Node verifier (cli/verify-save.ts) that recomputed exactly this
 * save; this viewer has no trusted way to receive such a report yet, so it never shows it (a report or hash supplied
 * by a user is a claim, not a verification).
 */
export type VerificationLevel = 'local_playable' | 'integrity_ok' | 'node_verified';
export const VERIFICATION_TEXT: Record<VerificationLevel, string> = { local_playable: '本機可玩', integrity_ok: '完整性檢查通過', node_verified: 'Node 已重算驗證' };
/** Owner #212 Q3 a wording (2026-11-13): shown with every status the browser can reach */
export const NOT_NODE_VERIFIED = '未經 Node 重算驗證';
/** What the viewer may claim for a save: never node_verified (no verifier report is accepted in the browser yet). */
export function verificationOf(s: { loadable: boolean; integrity_checked: boolean }): { level: VerificationLevel | null; text: string } {
  if (!s.loadable) return { level: null, text: NOT_NODE_VERIFIED };
  const level: VerificationLevel = s.integrity_checked ? 'integrity_ok' : 'local_playable';
  return { level, text: `${VERIFICATION_TEXT[level]}｜${NOT_NODE_VERIFIED}` };
}

// ---------- world records, retention, load order ----------

export interface WorldSummary {
  queens?: number | null; workers?: number | null; larvae?: number | null; individuals?: number | null; note?: string | null;
  /** sizes of the snapshot's save_meta.not_simulated list (null: the save carries none; absent: a record written before
   *  the list existed). Display only. */
  not_simulated?: { unwired: number; proxies: number } | null;
}
/** Where an imported copy came from (Owner decision 54). The copy's stored snapshots are the source's verified bytes. */
export interface Provenance {
  kind: 'import_copy'; source_world_id: string; source_name: string; source_exported_at: string; source_export_sha256: string;
  source_payload_sha256: string; source_t_sim: number; source_seq: number; imported_at: string;
  /** what was checked at import (SHA-256 detects accidental corruption only; it is not an authenticity proof — decision 57) */
  verification: string;
}
export type SaveKind = 'auto' | 'manual';
export interface ManualSave { gen: number; saved_at: string; t_sim: number; seq: number }
export interface LastSave { kind: SaveKind; bytes: number; ms: number; saved_at: string }
export interface WorldRecord {
  world_id: string; name: string; seed: number; created_at: string; official: false; label: typeof LABEL;
  next_gen: number; slots: number[]; quarantined: { gen: number; reason: string }[];
  last_saved_at: string | null; t_sim: number | null; seq: number | null;
  rules_fingerprint: string; engine_version: string; schema_version: number; summary: WorldSummary;
  /** world id INSIDE the snapshots when it differs from the record key (an imported copy keeps the source's id) */
  sim_world_id?: string; provenance?: Provenance | null; manual?: ManualSave[]; last_save?: LastSave | null;
}
/** The world id the stored snapshots carry (the record key unless the record is an imported copy). */
export const simIdOf = (w: Pick<WorldRecord, 'world_id' | 'sim_world_id'>) => w.sim_world_id ?? w.world_id;
export interface SnapshotRecord { world_id: string; gen: number; status: 'pending' | 'verified'; written_at: string; header: SnapshotHeader; payload_json: string; payload_sha256: string }

/** Slots after promoting `gen`: newest first, quarantined generations excluded, at most `retain`. */
export function planPromote(slots: number[], quarantined: number[], gen: number, retain = RETAIN_VERIFIED): { slots: number[] } {
  if (retain < 2) throw new RangeError('at least two verified snapshots must be kept');
  return { slots: [gen, ...slots.filter((g) => g !== gen && !quarantined.includes(g))].slice(0, retain) };
}
/** Snapshot generations to delete after a promote: older than `gen`, not kept, not quarantined (kept for diagnosis). */
export const sweepable = (allGens: number[], keep: number[], quarantined: number[], gen: number) => allGens.filter((g) => g < gen && !keep.includes(g) && !quarantined.includes(g));

/** Check a stored record (re-read hash, header fields, identity). Returns the reason it is unusable, or null. */
export async function recordProblem(rec: SnapshotRecord | undefined, world_id: string, gen: number, sim_world_id = world_id): Promise<string | null> {
  if (!rec) return 'missing';
  if (rec.world_id !== world_id || rec.gen !== gen) return 'identity mismatch';
  if (typeof rec.payload_json !== 'string') return 'payload missing';
  if (await sha256Hex(rec.payload_json) !== rec.payload_sha256 || rec.header?.payload_sha256 !== rec.payload_sha256) return 'checksum mismatch';
  let payload: unknown; try { payload = JSON.parse(rec.payload_json); } catch { return 'payload is not JSON'; }
  const e = envelopeErrors({ ...rec.header, payload });
  if (e.length) return `envelope invalid: ${e.join('; ')}`;
  if (rec.header.world_id !== sim_world_id) return 'world_id mismatch';
  return null;
}

// ---------- export / import ----------

export interface ExportFile { schema: typeof EXPORT_SCHEMA; label: typeof LABEL; official: false; exported_at: string; world: { world_id: string; name: string; seed: number; created_at: string; summary?: WorldSummary }; snapshot: SnapshotEnvelope; export_sha256: string }

export async function buildExport(w: Pick<WorldRecord, 'world_id' | 'name' | 'seed' | 'created_at' | 'summary'>, snapshot: SnapshotEnvelope, exported_at: string): Promise<ExportFile> {
  const body: Omit<ExportFile, 'export_sha256'> = { schema: EXPORT_SCHEMA, label: LABEL, official: false, exported_at, world: { world_id: w.world_id, name: w.name, seed: w.seed, created_at: w.created_at, summary: { ...w.summary } }, snapshot };
  return { ...body, export_sha256: await sha256Hex(canonicalJson(body)) };
}

/** Validate an import file: format, non-official, integrity (file and payload hashes), and report rules compatibility. */
export async function parseImport(text: string, rt: RuntimeInfo, reg: MigrationRegistry): Promise<Result<{ file: ExportFile; compat: Compatibility }>> {
  // Bounded resource use: refuse oversized text before parsing. Data is only JSON-parsed and validated, never executed.
  if (typeof text !== 'string') return errR('invalid_import', 'not text');
  if (text.length > MAX_IMPORT_BYTES) return errR('import_too_large', `file larger than ${MAX_IMPORT_BYTES} characters`);
  let f: unknown; try { f = JSON.parse(text); } catch { return errR('invalid_import', 'not JSON'); }
  if (!isObj(f)) return errR('invalid_import', 'not an object');
  if (f.schema !== EXPORT_SCHEMA) return errR('invalid_import', 'not an experiment-world export');
  if (f.official !== false || f.label !== LABEL) return errR('invalid_import', 'export is not marked non-official');
  const keys = ['schema', 'label', 'official', 'exported_at', 'world', 'snapshot', 'export_sha256'];
  if (Object.keys(f).some((k) => !keys.includes(k)) || keys.some((k) => !(k in f))) return errR('invalid_import', 'unexpected or missing fields');
  const w = f.world;
  if (!isObj(w) || typeof w.world_id !== 'string' || !WORLD_ID.test(w.world_id) || typeof w.name !== 'string' || typeof w.created_at !== 'string') return errR('invalid_import', 'world metadata invalid');
  const v = await verifyEnvelope(f.snapshot);
  if (!v.ok) return errR('invalid_import', `snapshot: ${v.message}`);
  if (v.value.envelope.world_id !== w.world_id || v.value.envelope.seed !== w.seed) return errR('invalid_import', 'snapshot does not belong to the exported world');
  const { export_sha256, ...body } = f;
  let sum: string; try { sum = await sha256Hex(canonicalJson(body)); } catch { return errR('invalid_import', 'file is not canonical JSON'); }
  if (sum !== export_sha256) return errR('invalid_import', 'export_sha256 does not match (file altered or truncated)');
  return okR({ file: f as unknown as ExportFile, compat: compatibility(v.value.envelope, rt, reg) });
}

// ---------- new game helpers, display ----------

export const newWorldId = () => `exp-${crypto.randomUUID()}`;
/** Record key of an imported copy (a new local world; the snapshots inside keep the source world id). */
export const newCopyId = () => `exp-copy-${crypto.randomUUID()}`;
/**
 * Seed of a new world from the player's input (SAVE-0 §2): empty → a fresh random seed; a decimal integer in
 * [0, 2^32) → that integer; any other text → the first 4 bytes (big-endian) of SHA-256(UTF-8(text)). The page shows
 * the resulting integer. Returns null for an integer outside the range.
 */
export async function seedFromInput(input: string): Promise<{ seed: number; how: 'random' | 'integer' | 'text' } | null> {
  const t = input.trim();
  if (t === '') return { seed: newSeed(), how: 'random' };
  if (/^\d+$/.test(t)) { const n = Number(t); return Number.isSafeInteger(n) && n <= 0xffffffff ? { seed: n, how: 'integer' } : null; }
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)));
  return { seed: ((d[0] << 24) | (d[1] << 16) | (d[2] << 8) | d[3]) >>> 0, how: 'text' };
}
/** A fresh 32-bit seed for a new experiment world (not used by the simulation itself; the Worker receives it). */
export const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
/** t_sim is SECONDS since experiment Day0 00:00 (contract §2, same as the Worker runtime). Display only. */
export function simDayTime(t_sim: number | null): { day: number; clock: string } | null {
  if (t_sim === null || !Number.isFinite(t_sim) || t_sim < 0) return null;
  const day = Math.floor(t_sim / 86400), sec = Math.floor(t_sim - day * 86400), p2 = (n: number) => String(n).padStart(2, '0');
  return { day, clock: `${p2(Math.floor(sec / 3600))}:${p2(Math.floor(sec / 60) % 60)}:${p2(sec % 60)}` };
}

/** Individuals in a Worker snapshot payload, for the save list. Neither world has a queen (null, not 0). */
export function summaryOf(snapshot: unknown): WorldSummary {
  const ns = notSimulatedOf(snapshot), not_simulated = ns.ok ? { unwired: ns.unwired.length, proxies: ns.proxies.length } : null;
  const p0 = (snapshot as { payload?: { world_kind?: unknown; state?: { workers?: object; larvae?: object } } })?.payload;
  if (p0?.world_kind === 'p0a2') {
    const nw = p0.state?.workers ? Object.keys(p0.state.workers).length : null, nl = p0.state?.larvae ? Object.keys(p0.state.larvae).length : null;
    return { queens: null, workers: nw, larvae: nl, individuals: nw === null || nl === null ? null : nw + nl, note: 'P0-A2 候選／實驗世界（非正式）：小工蟻與幼蟲，沒有蟻后（尚未模擬）', not_simulated };
  }
  const ants = (snapshot as { payload?: { ants?: unknown[] } })?.payload?.ants;
  const n = Array.isArray(ants) ? ants.length : null;
  return { queens: null, workers: null, individuals: n, note: '合成世界：沒有蟻后，個體不分階級', not_simulated };
}

// ---------- the 「尚未模擬／簡化代理」 list (Owner #212 Q2 a; docs/r2-acceptance-matrix.json row M43) ----------

/** the list format the Worker writes into payload.save_meta.not_simulated (generated from the R2 matrix) */
export const NOT_SIMULATED_FORMAT = 'antempire.not-simulated.v1';
export interface NotSimulatedItem { row: string; status: '未接入' | '簡化代理'; label_zh: string }
export type NotSimulatedView =
  | { ok: true; format: string; note_zh: string; source: string; unwired: NotSimulatedItem[]; proxies: NotSimulatedItem[] }
  | { ok: false; reason: string };
/**
 * The list a Worker snapshot carries in payload.save_meta.not_simulated, for display. The viewer has NO list of its own:
 * a save without one (the synthetic test world, or a record of an older format) is reported as such, never filled in.
 */
export function notSimulatedOf(snapshot: unknown): NotSimulatedView {
  const p = (snapshot as { payload?: { world_kind?: unknown; save_meta?: { not_simulated?: unknown } } } | null)?.payload;
  const x = p?.save_meta?.not_simulated;
  if (x === undefined || x === null) {
    return { ok: false, reason: p?.world_kind === 'p0a2'
      ? '此存檔的中繼資料沒有「尚未模擬」清單（舊格式）：不得把畫面當成已模擬任何機制'
      : '合成測試世界不是螞蟻模型：存檔中繼資料沒有「尚未模擬」清單，螞蟻的生理、發育、繁殖、死亡與生態都不在這個世界中' };
  }
  if (!isObj(x) || x.format !== NOT_SIMULATED_FORMAT || !Array.isArray(x.items) || typeof x.note_zh !== 'string' || typeof x.source !== 'string') return { ok: false, reason: '存檔中繼資料的「尚未模擬」清單格式不符，未顯示' };
  const items: NotSimulatedItem[] = [];
  for (const i of x.items) {
    if (!isObj(i) || typeof i.row !== 'string' || !/^M\d{2}$/.test(i.row) || (i.status !== '未接入' && i.status !== '簡化代理') || typeof i.label_zh !== 'string' || i.label_zh === '') return { ok: false, reason: '存檔中繼資料的「尚未模擬」清單格式不符，未顯示' };
    items.push({ row: i.row, status: i.status, label_zh: i.label_zh });
  }
  return { ok: true, format: x.format, note_zh: x.note_zh, source: x.source, unwired: items.filter((i) => i.status === '未接入'), proxies: items.filter((i) => i.status === '簡化代理') };
}

// ---------- autosave policy ----------

export type SaveReason = 'interval' | 'pause' | 'menu' | 'hidden' | 'pagehide' | 'manual' | 'new_game';
export type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
export interface SaveUiState { status: SaveStatus; text: string; last_success_ms: number | null; last_error: string | null; reason: SaveReason | null }
const STATUS_TEXT: Record<SaveStatus, string> = { idle: '尚未儲存', saving: '正在儲存', saved: '已儲存', failed: '儲存失敗' };

/**
 * Autosave state machine. `save` must resolve only after the IndexedDB promote transaction completed (or failed), so
 * "已儲存" is shown only after a committed save. One save at a time; triggers during a save coalesce into one follow-up.
 * The interval check and the hidden/pagehide attempts save only when the world changed since the last success; pause,
 * menu, manual and new-game always save. The controller never touches the world: it only asks for a snapshot.
 */
export class AutosaveController {
  private dirty = false; private inFlight: Promise<Result<unknown>> | null = null; private pending: SaveReason | null = null;
  private waiters: ((r: Result<unknown>) => void)[] = [];
  private lastAttemptMs: number; state: SaveUiState = { status: 'idle', text: STATUS_TEXT.idle, last_success_ms: null, last_error: null, reason: null };
  readonly intervalMs: number; private readonly now: () => number; private readonly save: (r: SaveReason) => Promise<Result<unknown>>; private readonly onState: (s: SaveUiState) => void;
  constructor(o: { intervalMs?: number; now: () => number; save: (r: SaveReason) => Promise<Result<unknown>>; onState?: (s: SaveUiState) => void }) {
    this.intervalMs = o.intervalMs ?? AUTOSAVE_INTERVAL_S * 1000; this.now = o.now; this.save = o.save; this.onState = o.onState ?? (() => {}); this.lastAttemptMs = o.now();
  }
  /** The world advanced (new events committed) since the last successful save. */
  markDirty() { this.dirty = true; }
  get isDirty() { return this.dirty; }
  /** Called from a real-time timer; saves when the interval elapsed and the world changed. */
  tick(): Promise<Result<unknown>> | null { return this.dirty && this.now() - this.lastAttemptMs >= this.intervalMs ? this.request('interval') : null; }
  request(reason: SaveReason): Promise<Result<unknown>> | null {
    const optional = reason === 'interval' || reason === 'hidden' || reason === 'pagehide';
    if (optional && !this.dirty) return null;
    if (this.inFlight) {
      if (!this.pending || !optional) this.pending = reason;
      if (optional) return this.inFlight;
      // A non-optional request (menu, manual, pause, ...) made while another save is in flight must resolve with the
      // result of the follow-up save that covers it, not the older in-flight save: otherwise a caller such as
      // session.leave() would report the world as saved and release the lock before the covering save ran.
      return new Promise((res) => { this.waiters.push(res); });
    }
    return this.run(reason);
  }
  /** Resolves once no save is in flight and none is queued (the last result, or null when nothing ran). */
  async settled(): Promise<Result<unknown> | null> {
    let last: Result<unknown> | null = null;
    while (this.inFlight) {
      last = await this.inFlight;
      // the follow-up save (if any) starts inside the resolved promise's handler; give it a turn to register
      await Promise.resolve();
    }
    return last;
  }
  private run(reason: SaveReason): Promise<Result<unknown>> {
    this.lastAttemptMs = this.now(); const wasDirty = this.dirty; this.dirty = false;
    this.set({ status: 'saving', reason, last_error: null });
    const p = this.save(reason).catch((err): Result<unknown> => errR('write_failed', String(err))).then((r) => {
      this.inFlight = null;
      if (r.ok) this.set({ status: 'saved', last_success_ms: this.now(), last_error: null });
      else { this.dirty = this.dirty || wasDirty; this.set({ status: 'failed', last_error: `${r.code}: ${r.message}` }); }
      const next = this.pending, waiters = this.waiters; this.pending = null; this.waiters = [];
      const follow = next ? this.request(next) : null;
      if (follow) void follow.then((fr) => { for (const w of waiters) w(fr); });
      else for (const w of waiters) w(r);
      return r;
    });
    this.inFlight = p; return p;
  }
  private set(s: Partial<SaveUiState>) { const status = s.status ?? this.state.status; this.state = { ...this.state, ...s, status, text: STATUS_TEXT[status] }; this.onState(this.state); }
}
