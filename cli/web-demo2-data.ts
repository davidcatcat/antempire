/**
 * Copies the Demo 2 nest layout (data/demo2-nest-layout.json — a labelled 展示假設, scenario_assumption: true) into
 * web/vendor/demo2/ so the Demo 2 page (web/demo2.html) loads it from the same site with a plain GET.
 * The source of truth stays under data/ (read by the Node tests); web/vendor/ is generated (git-ignored), like
 * web/dist/. The file is validated first: an unlabelled layout is refused.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLayout } from '../web/src/demo2/nest-graph.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEMO2_LAYOUT_SRC = 'data/demo2-nest-layout.json', DEMO2_LAYOUT_OUT = 'web/vendor/demo2/nest-layout.json';
const text = fs.readFileSync(path.join(ROOT, DEMO2_LAYOUT_SRC), 'utf8');
const layout = parseLayout(JSON.parse(text));
fs.mkdirSync(path.dirname(path.join(ROOT, DEMO2_LAYOUT_OUT)), { recursive: true });
fs.writeFileSync(path.join(ROOT, DEMO2_LAYOUT_OUT), text);
console.log(`${DEMO2_LAYOUT_OUT}: ${layout.chambers.length} chambers, ${layout.tunnels.length} tunnels (${layout.label_zh})`);
