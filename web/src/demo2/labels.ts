/**
 * Demo 2 — screen placement of the in-scene text labels (display only). Pure: no DOM, no Three.js, no engine import.
 *
 * Each label has an anchor on screen (the projected point it names; the label's bottom-centre sits on it) and a size.
 * Labels are placed in priority order; a label that would overlap one already placed is moved up or down in small
 * steps (staying inside the allowed screen area), and dropped only if no free place is found near its anchor.
 * Result: no two placed labels overlap (tests/web-demo2.test.ts, tests/browser/demo2.check.cjs).
 */
export interface LabelBox { key: string; x: number; y: number; w: number; h: number; prio: number }
export interface Area { left: number; top: number; right: number; bottom: number }
export interface Placed { key: string; cx: number; bottom: number; left: number; top: number; w: number; h: number }
const hit = (a: Placed, b: Placed, gap: number) => a.left < b.left + b.w + gap && b.left < a.left + a.w + gap && a.top < b.top + b.h + gap && b.top < a.top + a.h + gap;
/** place labels (higher prio first; ties by key for determinism). Returns the placed ones only. */
export function placeLabels(items: readonly LabelBox[], area: Area, gap = 2, maxShift = 6): Placed[] {
  const out: Placed[] = [], order = [...items].sort((a, b) => b.prio - a.prio || (a.key < b.key ? -1 : 1));
  for (const it of order) {
    if (it.w > area.right - area.left || it.h > area.bottom - area.top) continue;
    const cx = Math.max(area.left + it.w / 2, Math.min(area.right - it.w / 2, it.x));
    let done: Placed | null = null;
    // candidates: at the anchor, then alternately above / below it in steps of the label height
    for (let k = 0; k <= maxShift * 2 && !done; k++) {
      const step = Math.ceil(k / 2) * (it.h + gap) * (k % 2 ? -1 : 1), bottom = Math.max(area.top + it.h, Math.min(area.bottom, it.y + step));
      const c: Placed = { key: it.key, cx, bottom, left: cx - it.w / 2, top: bottom - it.h, w: it.w, h: it.h };
      if (out.every((p) => !hit(c, p, gap))) done = c;
    }
    if (done) out.push(done);
  }
  return out;
}
/** do any two placed labels overlap (strictly)? */
export function anyOverlap(p: readonly { left: number; top: number; w: number; h: number }[]): boolean {
  for (let i = 0; i < p.length; i++) for (let j = i + 1; j < p.length; j++) if (p[i].left < p[j].left + p[j].w && p[j].left < p[i].left + p[i].w && p[i].top < p[j].top + p[j].h && p[j].top < p[i].top + p[i].h) return true;
  return false;
}
