/**
 * Minimal JSON Schema (2020-12 subset) validator for the SAVE contract schemas: type, const, required, properties,
 * additionalProperties:false, pattern, minLength, maxLength, minimum, maximum, $ref by $id. Returns a list of error paths.
 * Deliberately small: it only needs to cover the keywords the SAVE schemas use (the test fails on any other keyword).
 */
export type Schema = Record<string, unknown>;
const KNOWN = new Set(['$schema', '$id', 'title', 'description', 'type', 'const', 'required', 'properties', 'additionalProperties', 'pattern', 'minLength', 'maxLength', 'minimum', 'maximum', '$ref']);

const typeOk = (t: string, v: unknown) => t === 'integer' ? Number.isInteger(v) : t === 'number' ? typeof v === 'number' && Number.isFinite(v)
  : t === 'object' ? typeof v === 'object' && v !== null && !Array.isArray(v) : t === 'array' ? Array.isArray(v) : t === 'null' ? v === null : typeof v === t;

export function unknownKeywords(s: Schema, at = '#'): string[] {
  const out = Object.keys(s).filter((k) => !KNOWN.has(k)).map((k) => `${at}/${k}`);
  for (const [k, sub] of Object.entries((s.properties ?? {}) as Record<string, Schema>)) out.push(...unknownKeywords(sub, `${at}/properties/${k}`));
  return out;
}

export function validate(s: Schema, v: unknown, refs: Record<string, Schema> = {}, at = '$'): string[] {
  if (typeof s.$ref === 'string') { const r = refs[s.$ref]; return r ? validate(r, v, refs, at) : [`${at}: unresolved $ref ${s.$ref}`]; }
  const e: string[] = [];
  if ('const' in s && v !== s.const) e.push(`${at}: must equal ${JSON.stringify(s.const)}`);
  if (s.type !== undefined) { const ts = Array.isArray(s.type) ? s.type as string[] : [s.type as string]; if (!ts.some((t) => typeOk(t, v))) { e.push(`${at}: type ${ts.join('|')}`); return e; } }
  if (typeof v === 'string') {
    if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(v)) e.push(`${at}: pattern`);
    if (typeof s.minLength === 'number' && [...v].length < s.minLength) e.push(`${at}: minLength`);
    if (typeof s.maxLength === 'number' && [...v].length > s.maxLength) e.push(`${at}: maxLength`);
  }
  if (typeof v === 'number' && typeof s.minimum === 'number' && v < s.minimum) e.push(`${at}: minimum`);
  if (typeof v === 'number' && typeof s.maximum === 'number' && v > s.maximum) e.push(`${at}: maximum`);
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
    const o = v as Record<string, unknown>, props = (s.properties ?? {}) as Record<string, Schema>;
    for (const k of (s.required ?? []) as string[]) if (!(k in o)) e.push(`${at}.${k}: required`);
    if (s.additionalProperties === false) for (const k of Object.keys(o)) if (!(k in props)) e.push(`${at}.${k}: not allowed`);
    for (const [k, sub] of Object.entries(props)) if (k in o) e.push(...validate(sub, o[k], refs, `${at}.${k}`));
  }
  return e;
}
