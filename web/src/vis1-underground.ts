/**
 * VIS-1 underground view — a CONCEPT diagram (概念圖：巢室幾何尚未模擬). The P0-A2 world has NO nest geometry: it knows
 * only three location classes (nest / entrance transit / outside), the activity state of each worker, the fixed
 * in-nest move time (to / from the entrance), each worker's crop fill and each larva's gut fill. This view shows only
 * those engine facts:
 *  - which workers rest, walk in the nest, care for brood, or move through the entrance passage (ENGINE state);
 *  - a worker in the passage moves between its recorded start and end instants (since_s → until_s, ENGINE times;
 *    the position on the drawn passage is display interpolation);
 *  - the 8 larvae and their gut fill (ENGINE, projected to the frame time by the core's own rule, issue #225).
 * The chambers, the passage, their shapes, sizes, depths and every position inside them are 示意; the soil strata,
 * roots and stones are decoration. Nothing here is fed back to the simulation.
 */
import type { P0a2FrameMsg } from './experimental/worker-protocol.ts';
import { drawAntDetail } from './art-raster.ts';
import { antPalette, PALETTE_VARIANTS, type MicroPose } from './art-ant.ts';
import { h01 } from './art-core.ts';
import { BRANCH, PASSAGE, ROOMS, U_ANT, U_H, U_W, larvaSpot, undergroundSpot, type UCam, type UHit } from './vis1-nest.ts';
export { U_H, U_W, undergroundSpot, type UCam, type UHit } from './vis1-nest.ts';
const TAU = Math.PI * 2;
import { hash32 } from './game-model.ts';
import { STATE_LABEL } from './v62-p0a2-model.ts';
import { ART_STRIDE_SCALE, STRIDE_BODY_LENGTHS } from './vis1-path.ts';

export class UndergroundView {
  private bg: { key: string; c: HTMLCanvasElement; s: number } | null = null;
  private phase = new Map<string, number>();
  private last = new Map<string, { x: number; y: number }>();
  private sprites = new Map<string, HTMLCanvasElement>();
  private bake(s: number): { c: HTMLCanvasElement; s: number } {
    const bs = Math.min(4096 / (U_W + 120), Math.pow(2, Math.ceil(Math.log2(Math.max(4, s))))), key = String(bs);
    if (this.bg?.key === key) return this.bg;
    const W = Math.ceil((U_W + 120) * bs), H = Math.ceil((U_H + 40) * bs), c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d') as CanvasRenderingContext2D; g.setTransform(bs, 0, 0, bs, 60 * bs, 12 * bs);
    let seed = 1234567; const r = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
    // sky / surface strip (decoration)
    const sky = g.createLinearGradient(0, -12, 0, 0); sky.addColorStop(0, '#2b3328'); sky.addColorStop(1, '#4a5a36'); g.fillStyle = sky; g.fillRect(-60, -12, U_W + 120, 12);
    // soil strata (decoration): topsoil, subsoil, deeper clay
    const soil = g.createLinearGradient(0, 0, 0, U_H + 4); soil.addColorStop(0, '#4a3324'); soil.addColorStop(0.18, '#5c4130'); soil.addColorStop(0.55, '#6f5139'); soil.addColorStop(1, '#5a4434');
    g.fillStyle = soil; g.fillRect(-60, 0, U_W + 120, U_H + 28);
    for (let q = 0; q < 5000; q++) { const x = -60 + r() * (U_W + 120), y = r() * (U_H + 28), s2 = 0.05 + r() * 0.18; g.fillStyle = r() < 0.5 ? 'rgba(20,12,6,0.35)' : 'rgba(210,180,140,0.18)'; g.beginPath(); g.arc(x, y, s2, 0, TAU); g.fill(); }
    for (let q = 0; q < 90; q++) { const x = -58 + r() * (U_W + 116), y = 3 + r() * (U_H + 22), rr = 0.4 + r() * 1.6; const gr = g.createRadialGradient(x - rr * 0.3, y - rr * 0.3, 0, x, y, rr); gr.addColorStop(0, '#9b8f80'); gr.addColorStop(1, '#4a4038'); g.fillStyle = gr; g.beginPath(); g.ellipse(x, y, rr, rr * (0.6 + r() * 0.3), r() * 3, 0, TAU); g.fill(); }
    // roots (decoration)
    g.lineCap = 'round';
    for (let q = 0; q < 9; q++) { let x = r() * U_W, y = 0, a = Math.PI / 2 + (r() - 0.5) * 0.6, w = 0.5 + r() * 0.5; g.strokeStyle = 'rgba(150,118,80,0.55)'; g.beginPath(); g.moveTo(x, y); for (let k = 0; k < 18; k++) { a += (r() - 0.5) * 0.5; x += Math.cos(a) * 1.4; y += Math.sin(a) * 1.4; g.lineWidth = w * (1 - k / 20); g.lineTo(x, y); } g.stroke(); }
    // surface grass silhouettes (decoration)
    for (let q = 0; q < 260; q++) { const x = -60 + r() * (U_W + 120), hgt = 1.5 + r() * 4.5, lean = (r() - 0.5) * 2; g.strokeStyle = `rgba(${70 + r() * 50},${100 + r() * 50},${40 + r() * 20},0.9)`; g.lineWidth = 0.25 + r() * 0.2; g.beginPath(); g.moveTo(x, 0.2); g.quadraticCurveTo(x + lean * 0.3, -hgt * 0.6, x + lean, -hgt); g.stroke(); }
    // entrance mound (示意)
    g.fillStyle = '#8d6c4b'; g.beginPath(); g.ellipse(50, 0.2, 5.5, 1.3, 0, Math.PI, TAU); g.fill();
    // chambers and passages (示意): carved cavities with a lighter floor
    const cavity = (draw: () => void, lw: number) => { g.strokeStyle = '#1d130c'; g.lineWidth = lw + 0.9; draw(); g.stroke(); g.strokeStyle = '#2c1d13'; g.lineWidth = lw; draw(); g.stroke(); };
    const poly = (P: [number, number][]) => () => { g.beginPath(); g.moveTo(P[0][0], P[0][1]); for (const p of P.slice(1)) g.lineTo(p[0], p[1]); };
    cavity(poly(PASSAGE), 3.2); for (const k of Object.keys(BRANCH)) cavity(poly(BRANCH[k]), 2.8);
    for (const R of ROOMS) {
      g.fillStyle = 'rgba(15,9,5,0.6)'; g.beginPath(); g.ellipse(R.cx, R.cy + 0.4, R.rx + 0.8, R.ry + 0.8, 0, 0, TAU); g.fill();
      const gr = g.createRadialGradient(R.cx, R.cy - R.ry * 0.4, 0.5, R.cx, R.cy, Math.max(R.rx, R.ry)); gr.addColorStop(0, '#3a281a'); gr.addColorStop(1, '#22160d');
      g.fillStyle = gr; g.beginPath(); g.ellipse(R.cx, R.cy, R.rx, R.ry, 0, 0, TAU); g.fill();
      g.save(); g.beginPath(); g.ellipse(R.cx, R.cy, R.rx, R.ry, 0, 0, TAU); g.clip(); const fl = g.createLinearGradient(0, R.cy + R.ry * 0.2, 0, R.cy + R.ry); fl.addColorStop(0, 'rgba(120,92,62,0)'); fl.addColorStop(1, 'rgba(140,108,74,0.55)'); g.fillStyle = fl; g.fillRect(R.cx - R.rx, R.cy, R.rx * 2, R.ry); g.restore();
    }
    this.bg = { key, c, s: bs }; return this.bg;
  }
  /** draw the concept view; returns pick targets (screen px) */
  draw(g: CanvasRenderingContext2D, cam: UCam, f: P0a2FrameMsg, t: number, tau: number, dt: number, sel: string | null, fol: string | null, minAntPx: number, night: number): UHit[] {
    const B = this.bake(cam.s), S = (x: number, y: number): [number, number] => [cam.w / 2 + (x - cam.x) * cam.s, cam.h / 2 + (y - cam.y) * cam.s];
    g.fillStyle = '#20160e'; g.fillRect(0, 0, cam.w, cam.h);
    const [ox, oy] = S(-60, -12); g.imageSmoothingEnabled = true; g.drawImage(B.c, ox, oy, B.c.width / B.s * cam.s, B.c.height / B.s * cam.s);
    // larvae (ENGINE: 8 larvae; fill = gut fill)
    const lr = Math.max(0.9 * cam.s, 7);
    f.larvae.forEach((l, i) => {
      const p = larvaSpot(i, f.larvae.length), [x, y] = S(p.x, p.y), rx = lr, ry = lr * 0.62;
      g.save(); g.translate(x, y); g.rotate(-0.25 + (i % 3) * 0.2);
      const gr = g.createRadialGradient(-rx * 0.3, -ry * 0.4, 0, 0, 0, rx); gr.addColorStop(0, '#fffaf0'); gr.addColorStop(1, '#d9cdb0'); g.fillStyle = gr; g.beginPath(); g.ellipse(0, 0, rx, ry, 0, 0, TAU); g.fill();
      g.strokeStyle = 'rgba(150,130,100,0.6)'; g.lineWidth = Math.max(0.6, rx * 0.05); for (let k = -3; k <= 3; k++) { g.beginPath(); g.ellipse(k * rx * 0.24, 0, rx * 0.06, ry * 0.92, 0, -1.2, 1.2); g.stroke(); }
      const fill = Math.max(0, Math.min(1, l.gut_fill)); if (fill > 0) { g.fillStyle = 'rgba(214,150,48,0.85)'; g.beginPath(); g.ellipse(-rx * 0.1, 0, rx * 0.62 * Math.sqrt(fill), ry * 0.45 * Math.sqrt(fill), 0, 0, TAU); g.fill(); }
      g.restore();
    });
    // workers in the nest by ENGINE state
    const hits: UHit[] = [], len = Math.max(minAntPx * 0.9, U_ANT * cam.s);
    for (const w of f.workers) {
      const p = undergroundSpot(w, t, tau); if (!p) continue;
      const [x, y] = S(p.x, p.y), prev = this.last.get(w.id), moved = prev ? Math.hypot(x - prev.x, y - prev.y) : 0;
      this.last.set(w.id, { x, y });
      const ph = (this.phase.get(w.id) ?? h01(hash32(w.id), 1, 1, 1)) + (p.walking ? Math.min(0.42, moved / (STRIDE_BODY_LENGTHS * len)) : 0); this.phase.set(w.id, ph);
      // standing ants: the antenna animation is quantised to 12 poses per cycle and the drawn ant cached (drawing cost only)
      const feeding = w.state === 'brood_care', hh = hash32(w.id) >>> 0, rate = feeding ? 3 : 1.2, tq = p.walking ? tau : Math.round((tau * rate) / (TAU / 12)) * (TAU / 12) / rate, tt = tq * rate + h01(hh, 3, 3, 3) * TAU;
      const m: MicroPose = { headYaw: 0.05 * Math.sin(tt * 0.6), L: { scape: 0.95 + 0.1 * Math.sin(tt), fun: 0.3 + 0.15 * Math.sin(tt * 1.3), reach: feeding ? 0.7 : 0.85 }, R: { scape: 0.95 + 0.1 * Math.sin(tt + 1), fun: 0.3 + 0.15 * Math.sin(tt * 1.3 + 2), reach: feeding ? 0.7 : 0.85 } };
      if (p.walking) drawAntDetail(g, len, x, y, p.a, 'walk', ph % 1, 1, m, antPalette(hash32(w.id) % PALETTE_VARIANTS), { part: 'body', stride: ART_STRIDE_SCALE });
      else {
        const dpr = g.getTransform().a, key = `${w.id}|${len.toFixed(1)}|${p.a.toFixed(3)}|${Math.round(((tq * rate) % TAU) / (TAU / 12))}|${dpr}`;
        let spr = this.sprites.get(key);
        if (!spr) {
          const side = Math.ceil(len * 1.7 * dpr), c = document.createElement('canvas'); c.width = c.height = side; const sg = c.getContext('2d') as CanvasRenderingContext2D;
          sg.setTransform(dpr, 0, 0, dpr, 0, 0); drawAntDetail(sg, len, side / dpr / 2, side / dpr / 2, p.a, 'idle', ph % 1, 0, m, antPalette(hash32(w.id) % PALETTE_VARIANTS), { part: 'body', stride: ART_STRIDE_SCALE });
          spr = c; if (this.sprites.size > 600) this.sprites.clear(); this.sprites.set(key, spr);
        }
        g.drawImage(spr, x - spr.width / dpr / 2, y - spr.height / dpr / 2, spr.width / dpr, spr.height / dpr);
      }
      // crop fill (ENGINE) as a small amber bar under the ant
      const cf = Math.max(0, Math.min(1, w.crop_fill)), bw = len * 0.7; g.fillStyle = 'rgba(0,0,0,0.45)'; g.fillRect(x - bw / 2, y + len * 0.4, bw, 2); g.fillStyle = '#e8b04a'; g.fillRect(x - bw / 2, y + len * 0.4, bw * cf, 2);
      if (w.id === sel) { g.strokeStyle = w.id === fol ? '#9fe0ff' : '#ffe08a'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, len * 0.62, 0, TAU); g.stroke(); }
      hits.push({ id: w.id, sx: x, sy: y, r: Math.max(14, len * 0.55) });
    }
    void dt;
    if (night > 0) { g.fillStyle = `rgba(18,28,58,${(0.25 * night).toFixed(3)})`; g.fillRect(0, 0, cam.w, cam.h); }
    // labels: room names with ENGINE counts; the concept banner
    g.save(); g.font = '600 13px system-ui'; g.textAlign = 'center'; g.lineWidth = 3; g.strokeStyle = 'rgba(15,9,5,0.85)'; g.fillStyle = '#f3ead6';
    const count = (st: string[]) => f.workers.filter((w) => st.includes(w.state)).length;
    for (const R of ROOMS) { const [x, y] = S(R.cx, R.cy - R.ry - 1.2), s = `${R.label} ${count(R.states)}`; g.strokeText(s, x, y); g.fillText(s, x, y); }
    { const [x, y] = S(57, 10), s = `巢口通道 ${count(['to_entrance', 'from_entrance'])}`; g.textAlign = 'left'; g.strokeText(s, x, y); g.fillText(s, x, y); }
    { const [x, y] = S(50, -3.2), s = '巢口（地表）'; g.textAlign = 'center'; g.strokeText(s, x, y); g.fillText(s, x, y); }
    g.restore();
    return hits;
  }
  stateLabel(s: string) { return STATE_LABEL[s] ?? s; }
}
