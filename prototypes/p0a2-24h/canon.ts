/**
 * Canonical JSON (sorted keys, finite numbers only) — the byte form used for the event log, snapshots and hashes.
 * Pure; no platform API.
 */
export function canon(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw Error(`P0A2: non-finite number in canonical JSON`); return JSON.stringify(v + 0); }
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
  }
  throw Error(`P0A2: ${typeof v} is not JSON data`);
}
