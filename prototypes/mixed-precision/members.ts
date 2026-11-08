/**
 * Stable member-ID sets (isolated prototype; issue #145). A member ID is either a bare string (a known ID such as
 * 'X-moth-1') or `<prefix>#<ordinal>` (a latent ID: a deterministic ordinal inside the cohort that created it). A set is
 * stored compressed: bare strings plus inclusive ranges [prefix, lo, hi]; the canonical form is sorted by (prefix,
 * ordinal) and maximally merged, so the same set always has the same bytes, whatever produced it.
 */
export type MemberRun = string | [string, number, number];
export type MemberSet = MemberRun[];

/** split an ID into (prefix, ordinal); a bare ID has ordinal -1 */
export function parseId(id: string): [string, number] {
  const h = id.lastIndexOf('#');
  if (h < 0) return [id, -1];
  const n = Number(id.slice(h + 1));
  return Number.isSafeInteger(n) && n >= 0 && String(n) === id.slice(h + 1) ? [id.slice(0, h), n] : [id, -1];
}
const byStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** canonical member order: prefix (code-unit order), then ordinal; a bare ID before the latent IDs of the same prefix */
export function cmpId(a: string, b: string): number {
  const [pa, na] = parseId(a), [pb, nb] = parseId(b);
  return byStr(pa, pb) || na - nb;
}
export const latentId = (prefix: string, ordinal: number) => `${prefix}#${ordinal}`;
export function expand(ms: MemberSet): string[] {
  const out: string[] = [];
  for (const r of ms) {
    if (typeof r === 'string') { out.push(r); continue; }
    for (let k = r[1]; k <= r[2]; k++) out.push(`${r[0]}#${k}`);
  }
  return out;
}
export function compress(ids: Iterable<string>): MemberSet {
  const xs = [...ids].sort(cmpId), out: MemberSet = [];
  for (let i = 0; i < xs.length; i++) {
    if (i > 0 && xs[i] === xs[i - 1]) throw new Error(`DUPLICATE_ID: ${xs[i]}`);
    const [p, n] = parseId(xs[i]);
    if (n < 0) { out.push(xs[i]); continue; }
    const last = out[out.length - 1];
    if (Array.isArray(last) && last[0] === p && last[2] === n - 1) last[2] = n; else out.push([p, n, n]);
  }
  return out;
}
export const sizeOf = (ms: MemberSet) => ms.reduce((a, r) => a + (typeof r === 'string' ? 1 : r[2] - r[1] + 1), 0);
export const union = (...sets: MemberSet[]) => compress(sets.flatMap(expand));
