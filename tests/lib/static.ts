/** Read engine source with comments and string literals removed, for static no-god-mode checks. */
import { readText } from '../../cli/lib/load.ts';

export function codeOnly(rel: string): string {
  return readText(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`/g, "''");
}
