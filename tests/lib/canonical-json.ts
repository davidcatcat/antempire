/**
 * Reference canonical JSON for the SAVE snapshot contract (docs/experimental-save-system.md §2): object keys sorted by
 * UTF-16 code units, no whitespace, numbers as JSON.stringify prints them; NaN / ±Infinity / undefined / functions /
 * bigint / typed arrays are rejected. Used by the contract test to pin the test vectors that both the Worker runtime
 * and web/src/experimental/save-store.ts must reproduce.
 */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error('non-finite number'); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => { if (o[k] === undefined) throw new Error(`undefined at ${k}`); return `${JSON.stringify(k)}:${canonicalJson(o[k])}`; }).join(',')}}`;
  }
  throw new Error(`not canonical-JSON compatible: ${Object.prototype.toString.call(v)}`);
}
