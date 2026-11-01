/**
 * Rules fingerprint frozen into the save at Day15 activation: sha256 over the engine source files and
 * the parameter files. A daily advance refuses to run if either changed (rules updates need their own PR).
 */
import crypto from 'node:crypto';
import { readText, REPO_ROOT, ruleFiles } from './load.ts';

const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex');

/** sha256 of "path\0sha256(content)\n" lines, sorted by path, so the hash is order- and platform-stable. */
export function manifestHash(files: string[], root = REPO_ROOT): string {
  return sha([...files].sort().map((f) => `${f}\0${sha(readText(f, root))}\n`).join(''));
}

export function rulesFingerprint(root = REPO_ROOT): { engine: string; params: string; files: { engine: string[]; params: string[] } } {
  const files = ruleFiles(root);
  return { engine: manifestHash(files.engine, root), params: manifestHash(files.params, root), files };
}
