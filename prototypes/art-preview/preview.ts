/**
 * Art preview / contact sheet (PR A). Shows every asset of the art kit at DPR 1 and the device DPR, plus a 示範 mock
 * garden composed only of these assets. No simulation data is read; nothing here is an engine record.
 */
import { bakeAntAtlas, drawAntSprite, drawList, pixelsToCanvas, type AntAtlas } from '../../web/src/art-raster.ts';
import { WALK_FRAMES, IDLE_FRAMES, antPose, tripodSet, pivotCycles, selectGait, antFrameDrawList, antGlints, ANT_EXTENT, magnification, walkCycles, walkFrame, MINOR_LENGTH_CM } from '../../web/src/art-ant.ts';
import { soilTile, soilMacroTile, leaf, twig, pebble, grassTuft, moss, debris, LEAF_KINDS, type Decal } from '../../web/src/art-ground.ts';
import { nestEntrance, hostPlant, flower, insectCarcass, aphid, scaleInsect } from '../../web/src/art-props.ts';
import { lightGrade, vignette, sunWash, overcast, wetGlints, puddle, rainStreak, splash, wetDarken, WET_TINT } from '../../web/src/art-fx.ts';
import { rng, lightFromSun, withLight, SCHEMATIC_LIGHT, type DrawList } from '../../web/src/art-core.ts';

const main = document.getElementById('main') as HTMLElement;
const DPR = window.devicePixelRatio || 1;
const W = () => Math.min(1200, main.clientWidth - 56);
/** soil tile: 512 px texels cover 80 mm of ground (6.4 px/mm at authoring resolution) */
const SOIL_TILE_PX = 512, SOIL_TILE_MM = 80;

function section(id: string, title: string, note: string): HTMLElement {
  const s = document.createElement('section'); s.dataset.shot = id;
  s.innerHTML = `<h2>${title}</h2><p class="note">${note}</p>`; main.appendChild(s); return s;
}
function row(parent: HTMLElement) { const d = document.createElement('div'); d.className = 'row'; parent.appendChild(d); return d; }
function canvasIn(parent: HTMLElement, w: number, h: number, dpr = DPR, cap?: string): CanvasRenderingContext2D {
  const wrap = document.createElement('div'), c = document.createElement('canvas');
  c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.width = w + 'px'; c.style.height = h + 'px';
  wrap.appendChild(c); if (cap) wrap.insertAdjacentHTML('beforeend', `<div class="cap">${cap}</div>`); parent.appendChild(wrap);
  const g = c.getContext('2d') as CanvasRenderingContext2D; g.setTransform(dpr, 0, 0, dpr, 0, 0); return g;
}
const animations: ((t: number) => void)[] = [];
const soilCache = new Map<string, HTMLCanvasElement>();
const soil = (seed: number, wet = false) => { const k = `${seed}|${wet}`; let c = soilCache.get(k); if (!c) { c = pixelsToCanvas(soilTile({ size: SOIL_TILE_PX, seed, wet }), SOIL_TILE_PX, SOIL_TILE_PX); soilCache.set(k, c); } return c; };
/** fill a w×h area with the soil tile at `pxPerMm` (CSS px). The tile is pre-scaled to whole device pixels (a scaled
 *  pattern shows seams in some browsers), then a large low-frequency tint breaks up the repetition. */
const scaled = new Map<string, HTMLCanvasElement>();
function tileAt(src: HTMLCanvasElement, key: string, px: number): HTMLCanvasElement {
  let c = scaled.get(key); if (c) return c;
  c = document.createElement('canvas'); c.width = c.height = Math.max(8, Math.round(px)); const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.imageSmoothingQuality = 'high'; g.drawImage(src, 0, 0, c.width, c.height); scaled.set(key, c); return c;
}
const macro = pixelsToCanvas(soilMacroTile(5), 128, 128);
function paintSoil(g: CanvasRenderingContext2D, w: number, h: number, pxPerMm: number, seed: number, wet = false, dpr = DPR) {
  const t = tileAt(soil(seed, wet), `${seed}|${wet}|${pxPerMm}|${dpr}`, SOIL_TILE_MM * pxPerMm * dpr), pat = g.createPattern(t, 'repeat') as CanvasPattern;
  pat.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0])); g.fillStyle = pat; g.fillRect(0, 0, w, h);
  const m = g.createPattern(tileAt(macro, `macro|${pxPerMm}|${dpr}`, 360 * pxPerMm * dpr), 'repeat') as CanvasPattern; m.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, 0, 0]));
  g.save(); g.globalCompositeOperation = 'multiply'; g.globalAlpha = 0.75; g.fillStyle = m; g.fillRect(0, 0, w, h); g.restore();
}
/** draw decal layers in mm units at pxPerMm (CSS) */
function drawMm(g: CanvasRenderingContext2D, list: DrawList, pxPerMm: number, dpr = DPR) { g.save(); g.scale(pxPerMm, pxPerMm); drawList(g, list, pxPerMm * dpr); g.restore(); }
function drawDecal(g: CanvasRenderingContext2D, d: Decal, pxPerMm: number, dpr = DPR) { drawMm(g, d.shadow, pxPerMm, dpr); drawMm(g, d.body, pxPerMm, dpr); if (d.highShadow) drawMm(g, d.highShadow, pxPerMm, dpr); if (d.high) drawMm(g, d.high, pxPerMm, dpr); }

// ---------------------------------------------------------------- mock garden (示範 mock: assets only, not engine data)
function mockGarden() {
  const s = section('mock-garden', '示範 mock 花園：只用本 PR 的資產組成（不是引擎資料、不是遊戲畫面）', '螞蟻沿一條示範路線往返、在植物旁靜止；位置、數量與路線全是示範，引擎重播的接線在 PR C。<b>螞蟻放大顯示</b>（見左下角標示）。');
  const w = W(), h = Math.round(Math.min(560, Math.max(420, w * 0.5))), ppm = w < 600 ? 3.2 : 4.4; // CSS px per mm
  const wrap = document.createElement('div'); wrap.style.position = 'relative'; s.appendChild(wrap);
  const g = canvasIn(wrap, w, h, DPR);
  const label = document.createElement('div');
  label.style.cssText = 'position:absolute;left:10px;bottom:10px;padding:3px 8px;border-radius:6px;background:rgba(20,12,6,.72);color:#f6e7cf;font-size:12px';
  wrap.appendChild(label);
  const tag = document.createElement('div'); tag.textContent = '示範 mock・非引擎資料';
  tag.style.cssText = 'position:absolute;right:10px;top:10px;padding:3px 8px;border-radius:6px;background:rgba(90,59,27,.85);color:#ffe6bf;font-size:12px'; wrap.appendChild(tag);
  const Wmm = w / ppm, Hmm = h / ppm, r = rng(20261108);
  // static layers baked once: base (soil + low decals + nest + plant low) and high (overhanging blades, upper leaves, flower)
  const mk = () => { const c = document.createElement('canvas'); c.width = Math.round(w * DPR); c.height = Math.round(h * DPR); const x = c.getContext('2d') as CanvasRenderingContext2D; x.setTransform(DPR, 0, 0, DPR, 0, 0); return [c, x] as const; };
  const [baseC, bg] = mk(), [highC, hg] = mk();
  paintSoil(bg, w, h, ppm, 7);
  const nest = { x: Wmm * 0.24, y: Hmm * 0.62 }, plant = { x: Wmm * 0.74, y: Hmm * 0.36 };
  const keep = (x: number, y: number, rad: number) => Math.hypot(x - nest.x, y - nest.y) > rad + 24 && Math.hypot(x - plant.x, y - plant.y) > rad + 30;
  const decals: Decal[] = [];
  for (let i = 0; i < 26; i++) { const x = r() * Wmm, y = r() * Hmm, len = 18 + r() * 34; if (keep(x, y, len * 0.3)) decals.push(leaf(1000 + i, LEAF_KINDS[Math.floor(r() * LEAF_KINDS.length)], x, y, r() * 6.283, len)); }
  for (let i = 0; i < 4; i++) { const x = r() * Wmm, y = r() * Hmm; if (keep(x, y, 10)) decals.push(twig(2000 + i, x, y, r() * 6.283, 30 + r() * 40)); }
  for (let i = 0; i < 40; i++) { const x = r() * Wmm, y = r() * Hmm, rad = 1.2 + Math.pow(r(), 2.2) * 9; if (keep(x, y, rad)) decals.push(pebble(3000 + i, x, y, rad)); }
  for (let i = 0; i < 5; i++) { const x = r() * Wmm, y = r() * Hmm; if (keep(x, y, 8)) decals.push(moss(4000 + i, x, y, 4 + r() * 6)); }
  for (let i = 0; i < 10; i++) decals.push(debris(5000 + i, r() * Wmm, r() * Hmm, 10 + r() * 14, 10 + Math.floor(r() * 14)));
  const tufts: Decal[] = []; for (let i = 0; i < 9; i++) { const x = r() * Wmm, y = r() * Hmm; if (keep(x, y, 6)) tufts.push(grassTuft(6000 + i, x, y, 22 + r() * 22, 0.3)); }
  const nestD = nestEntrance(77, nest.x, nest.y, 20), plantD = hostPlant(88, plant.x, plant.y, { alive: true, colonies: 3, insect: 'aphid', size: 36 });
  const flowerD = flower(99, Wmm * 0.9, Hmm * 0.82, 15), carcass = insectCarcass(111, Wmm * 0.5, Hmm * 0.84, 0.7, 8);
  for (const d of decals) drawMm(bg, d.shadow, ppm); for (const d of decals) drawMm(bg, d.body, ppm);
  for (const d of [nestD, plantD, flowerD, carcass, ...tufts]) { drawMm(bg, d.shadow, ppm); drawMm(bg, d.body, ppm); }
  for (const d of [plantD, flowerD, ...tufts]) { if (d.highShadow) drawMm(hg, d.highShadow, ppm); if (d.high) drawMm(hg, d.high, ppm); }
  drawList(hg, [sunWash(w, h), vignette(w, h)], DPR);
  // ants: a curved demo route nest → plant and back; a few idling beside the plant
  const L = 30, atlas = bakeAntAtlas(L, DPR), mag = magnification(L, ppm * 10);
  label.textContent = `螞蟻放大顯示 ×${mag.toFixed(1)}（小工蟻約 ${MINOR_LENGTH_CM * 10} mm；本圖 ${ppm} px/mm）・示範`;
  const route = (u: number): [number, number] => { const ax = nest.x * ppm, ay = nest.y * ppm, bx = plant.x * ppm - 40, by = plant.y * ppm + 30, cx = (ax + bx) / 2, cy = Math.min(ay, by) + h * 0.32; const v = 1 - u; return [v * v * ax + 2 * v * u * cx + u * u * bx, v * v * ay + 2 * v * u * cy + u * u * by]; };
  const routeLen = (() => { let d = 0, p = route(0); for (let i = 1; i <= 200; i++) { const q = route(i / 200); d += Math.hypot(q[0] - p[0], q[1] - p[1]); p = q; } return d; })();
  const ants = Array.from({ length: 9 }, (_, i) => ({ off: i / 9, dir: i % 2 ? -1 : 1, lane: ((i * 7) % 5 - 2) * 4 }));
  const idle = Array.from({ length: 4 }, (_, i) => ({ x: plant.x * ppm + Math.cos(i * 1.9) * 60, y: plant.y * ppm + Math.sin(i * 1.9) * 46 + 14, h: i * 1.7 + 0.4 }));
  const speed = 46; // CSS px per second (demo only)
  animations.push((t) => {
    g.drawImage(baseC, 0, 0, w, h);
    for (const a of ants) {
      const dist = (t / 1000) * speed + a.off * routeLen, lap = Math.floor(dist / routeLen), uu = (dist % routeLen) / routeLen, u = (lap + (a.dir > 0 ? 0 : 1)) % 2 === 0 ? uu : 1 - uu;
      const [x, y] = route(u), [x2, y2] = route(Math.min(1, Math.max(0, u + (((lap + (a.dir > 0 ? 0 : 1)) % 2 === 0) ? 0.002 : -0.002))));
      const hd = Math.atan2(y2 - y, x2 - x), nx = -Math.sin(hd) * a.lane, ny = Math.cos(hd) * a.lane;
      drawAntSprite(g, atlas, DPR, x + nx, y + ny, hd, 'walk', walkFrame(walkCycles(dist, L)));
    }
    for (const [i, a] of idle.entries()) drawAntSprite(g, atlas, DPR, a.x, a.y, a.h, 'idle', Math.floor(t / 160 + i * 3) % IDLE_FRAMES);
    g.drawImage(highC, 0, 0, w, h);
  });
}

// ---------------------------------------------------------------- ant
function antSection() {
  const s = section('ant', '螞蟻：熱帶大頭家蟻小工蟻（俯視，示意外形）', '頭（大顎、複眼、12 節膝狀觸角含 3 節棍棒）、胸（並胸腹節小刺）、腹柄＋後腹柄兩節、有光澤的腹部、六足（基節／腿節／脛節／跗節）。<b>不畫大工蟻</b>：引擎沒有記錄任何個體的階級。腳的擺動由移動距離驅動（支撐腳不在地面滑動），不是自訂速度。');
  const rw = row(s);
  const big = Math.min(300, W() - 40), cw = big * 1.45, ch = big * 0.9, g = canvasIn(rw, cw, ch, DPR, `向量繪製（體長 ${big} px，步態第 0 幀）`);
  g.fillStyle = '#7d6146'; g.fillRect(0, 0, cw, ch); paintSoil(g, cw, ch, big / 2.5 / 2.5, 3);
  const u = big / 100; g.save(); g.translate(-ANT_EXTENT.x0 * u * 0.95 + 4, ch / 2); g.scale(u * 0.95, u * 0.95);
  const fr = antFrameDrawList('walk', 0); g.save(); g.translate(2.8, 3.8); drawList(g, fr.shadow, u * DPR); g.restore(); drawList(g, fr.body, u * DPR); drawList(g, antGlints(0), u * DPR); g.restore();
  for (const L of [120, 60, 26]) {
    const w = Math.max(150, L * 2.2), h = Math.max(96, L * 1.4), ctx = canvasIn(rw, w, h, DPR, `行走動畫・體長 ${L} px`), atlas = bakeAntAtlas(L, DPR);
    animations.push((t) => { paintSoil(ctx, w, h, 6, 5); const dist = (t / 1000) * L * 0.9; drawAntSprite(ctx, atlas, DPR, w / 2, h / 2, -0.5 + Math.sin(t / 1500) * 0.4, 'walk', walkFrame(walkCycles(dist, L))); });
  }
  const sw = W(), strip = canvasIn(s, sw, 150, DPR, `步態 ${WALK_FRAMES} 幀（上列；紅點＝三腳架 A：左前、右中、左後；藍點＝B；實心＝支撐相、淡色＝擺動相）與靜止觸角抽動 ${IDLE_FRAMES} 幀（下列）`);
  const at = bakeAntAtlas(52, DPR), cwid = sw / WALK_FRAMES;
  strip.fillStyle = '#7d6146'; strip.fillRect(0, 0, sw, 150); paintSoil(strip, sw, 150, 5, 9);
  for (let i = 0; i < WALK_FRAMES; i++) {
    const cx = cwid * i + cwid / 2, cy = 40; drawAntSprite(strip, at, DPR, cx, cy, -Math.PI / 2, 'walk', i);
    // feet markers: rotate the local frame by -90° (ant facing up) and scale 52 px / 100 units
    for (const lp of antPose('walk', i).legs) { const [fx, fy] = lp.pts[4], k = 52 / 100, sx = cx + fy * k, sy = cy - fx * k; strip.beginPath(); strip.arc(sx, sy, 2.6, 0, 7); strip.fillStyle = tripodSet(lp.id) === 'A' ? (lp.stance ? '#ff5a4a' : 'rgba(255,90,74,0.25)') : (lp.stance ? '#5aa8ff' : 'rgba(90,168,255,0.25)'); strip.fill(); }
  }
  for (let i = 0; i < IDLE_FRAMES; i++) drawAntSprite(strip, at, DPR, cwid * i + cwid / 2, 112, -Math.PI / 2, 'idle', i);
  // DPR 1 vs device DPR
  const r2 = row(s);
  for (const d of [1, 2]) { const ctx = canvasIn(r2, 200, 110, d, `DPR ${d}：體長 40 px`), a = bakeAntAtlas(40, d); paintSoil(ctx, 200, 110, 5, 11, false, d); drawAntSprite(ctx, a, d, 60, 55, -0.3, 'walk', 2); drawAntSprite(ctx, a, d, 140, 55, 2.6, 'idle', 0); }
}

// ---------------------------------------------------------------- soil
function soilSection() {
  const s = section('soil', '地面：程序土壤紋理（可無縫拼接）', `每張 ${SOIL_TILE_PX}×${SOIL_TILE_PX} px＝約 ${SOIL_TILE_MM} mm 見方（示意）。週期性多層值雜訊高度場＋固定左上光源、土團、砂粒、較暗的潮濕凹處；右為潮濕日的變體（引擎日值 wet）。各以 3×3 拼接顯示接縫。`);
  const rw = row(s), tw = Math.min(380, (W() - 20) / 2);
  for (const wet of [false, true]) {
    const ctx = canvasIn(rw, tw, tw, DPR, wet ? '潮濕（wet）3×3' : '乾燥 3×3'), k = tw / 3;
    for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) ctx.drawImage(soil(21, wet), i * k, j * k, k, k);
    ctx.strokeStyle = 'rgba(255,230,160,0.35)'; ctx.setLineDash([3, 4]); ctx.strokeRect(k, k, k, k);
  }
}

// ---------------------------------------------------------------- decals
function decalSection() {
  const s = section('decals', '地面裝飾（示意場景）：落葉、樹枝、石子、草、苔、種子碎屑', '落葉五型：披針形、卵形、腐朽（有洞與壞死斑）、捲曲、只剩葉脈；石子有接觸陰影與環境遮蔽；草叢分成「低層」（在螞蟻下方）與「高層」（葉尖蓋在螞蟻上方）。全部以種子決定，與引擎無關。');
  const w = W(), h = 360, ppm = 4, g = canvasIn(s, w, h, DPR); paintSoil(g, w, h, ppm, 13);
  const cols = LEAF_KINDS.length, colW = w / ppm / cols;
  LEAF_KINDS.forEach((k, i) => { drawDecal(g, leaf(500 + i, k, colW * (i + 0.5), 14, -0.4 + i * 0.25, 34), ppm); drawDecal(g, leaf(600 + i, k, colW * (i + 0.5), 34, 0.6 + i * 0.3, 22), ppm); });
  const y2 = 56, n2 = 8;
  for (let i = 0; i < n2; i++) drawDecal(g, pebble(700 + i, (w / ppm) * (i + 0.5) / n2, y2, 1.5 + i * 0.9), ppm);
  drawDecal(g, twig(801, (w / ppm) * 0.15, 78, 0.2, 44), ppm);
  drawDecal(g, moss(802, (w / ppm) * 0.36, 78, 8), ppm);
  drawDecal(g, debris(803, (w / ppm) * 0.52, 78, 10, 26), ppm);
  const tuft = grassTuft(804, (w / ppm) * 0.74, 80, 30, 0.25); drawMm(g, tuft.shadow, ppm); drawMm(g, tuft.body, ppm);
  const tuft2 = grassTuft(804, (w / ppm) * 0.9, 80, 30, 0.25); drawDecal(g, tuft2, ppm);
  g.fillStyle = '#f6e7cf'; g.font = '12px system-ui'; g.fillText('草叢：只有低層', w * 0.74 - 40, h - 8); g.fillText('低層＋高層', w * 0.9 - 30, h - 8);
}

// ---------------------------------------------------------------- nest + food sources
function placesSection() {
  const s = section('places', '代表引擎地點的物件：巢口、蜜露（寄主＋半翅目群）、花蜜（花）、屍體', '蚜蟲／介殼蟲「群數」＝引擎 hemipteran_colonies（下圖示範 0、1、2、4 群）；每群內畫幾隻是示意（引擎沒有個體數）。寄主死亡（host_alive=false）時植物枯褐。巢口是示意：本種常在土中、石下或縫隙築巢，不常堆大型土丘。');
  const w = W(), ppm = w < 600 ? 2.6 : 3.4, h = Math.round(118 * ppm * 1.2), g = canvasIn(s, w, h, DPR); paintSoil(g, w, h, ppm, 17);
  const Wm = w / ppm, cap = (txt: string, x: number, y: number) => { g.fillStyle = 'rgba(20,12,6,.7)'; const tw = g.measureText(txt).width + 10; g.fillRect(x * ppm - tw / 2, y * ppm - 13, tw, 18); g.fillStyle = '#f6e7cf'; g.fillText(txt, x * ppm - tw / 2 + 5, y * ppm); };
  g.font = '12px system-ui';
  drawDecal(g, nestEntrance(31, Wm * 0.12, 30, 20), ppm); cap('巢口（示意）', Wm * 0.12, 58);
  [0, 1, 2, 4].forEach((c, i) => { drawDecal(g, hostPlant(40 + i, Wm * (0.34 + i * 0.2), 28, { alive: true, colonies: c, insect: 'aphid' }), ppm); cap(`寄主＋蚜蟲 ${c} 群`, Wm * (0.34 + i * 0.2), 58); });
  drawDecal(g, hostPlant(50, Wm * 0.12, 90, { alive: false, colonies: 0, insect: 'aphid' }), ppm); cap('寄主死亡（枯褐）', Wm * 0.12, 116);
  drawDecal(g, hostPlant(51, Wm * 0.34, 90, { alive: true, colonies: 2, insect: 'scale' }), ppm); cap('寄主＋介殼蟲 2 群', Wm * 0.34, 116);
  drawDecal(g, flower(52, Wm * 0.54, 88, 15), ppm); cap('花（花蜜）', Wm * 0.54, 116);
  drawDecal(g, insectCarcass(53, Wm * 0.72, 88, 0.5, 11), ppm); cap('昆蟲屍體（示意）', Wm * 0.72, 116);
  drawDecal(g, insectCarcass(54, Wm * 0.9, 88, 0.5, 11, false), ppm); cap('屍體碎片', Wm * 0.9, 116);
  // close-up of the hemipteran sprites
  const g2 = canvasIn(s, Math.min(w, 420), 110, DPR, '放大：蚜蟲（若蟲／成蟲大小不同，示意）與介殼蟲'); paintSoil(g2, Math.min(w, 420), 110, 14, 19);
  for (let i = 0; i < 5; i++) drawMm(g2, aphid(4 + i * 3.4, 3.6, -0.4 + i * 0.3, 1.4 + i * 0.25, i / 5), 18);
  for (let i = 0; i < 4; i++) drawMm(g2, scaleInsect(4 + i * 3.4, 8.3, i * 0.6, 1.8 + i * 0.3, i / 4), 18);
}

// ---------------------------------------------------------------- light & weather
function fxSection() {
  const s = section('fx', '光線與天氣資產（接線在 PR B）', `乾燥＋暖光／${WET_TINT.label}＋陰天光線＋水漬。引擎的降雨只有日值、沒有分鐘，所以遊戲畫面只能顯示「當日狀態」並標示為日值；雨滴與水花資產<b>目前不得用於重播</b>，只在此預覽。活動時段是 360 分鐘，不畫日夜循環。`);
  const rw = row(s), tw = Math.min(380, (W() - 30) / 3), th = 200, ppm = 4;
  const scene = (g: CanvasRenderingContext2D, wet: boolean) => {
    paintSoil(g, tw, th, ppm, 23, wet);
    for (const d of [leaf(901, 'ovate', 18, 16, 0.4, 26), pebble(902, 60, 30, 6), pebble(903, 40, 40, 3), grassTuft(904, 78, 22, 24, 0.2)]) drawDecal(g, d, ppm);
  };
  const g1 = canvasIn(rw, tw, th, DPR, '乾燥日：暖光＋暗角'); scene(g1, false); drawList(g1, [sunWash(tw, th, 0.2), vignette(tw, th)], DPR);
  const g2 = canvasIn(rw, tw, th, DPR, '潮濕日（日值）：濕土＋陰天＋水漬'); scene(g2, true); drawList(g2, [wetDarken(tw, th)], DPR); drawMm(g2, puddle(905, 30, 38, 9), ppm); drawList(g2, [wetGlints(906, tw, th, 70), overcast(tw, th), vignette(tw, th, 0.35)], DPR);
  const g3 = canvasIn(rw, tw, th, DPR, '雨滴／水花（未接線：引擎沒有降雨時刻）'); g3.fillStyle = '#3b3a3a'; g3.fillRect(0, 0, tw, th);
  const r = rng(907); for (let i = 0; i < 26; i++) { g3.save(); g3.translate(r() * tw, r() * th * 0.7); drawList(g3, [rainStreak(18 + r() * 14)], DPR); g3.restore(); }
  for (let i = 0; i < 5; i++) drawList(g3, splash(30 + i * (tw - 60) / 4, th - 30, 10, i / 5), DPR);
}


// ---------------------------------------------------------------- turning
function turnSection() {
  const s = section('turning', '轉向動畫：弧線轉彎（內側腳步幅較短）與原地轉身（兩側腳反向掃動）', `這些列<b>只在有權威角速度 ω 時使用</b>（物理解算器的朝向／ω，V6-2）；sprite 不會自己發明轉向。重播資料沒有 ω、朝向只在紀錄的路段轉折處改變，所以重播只用直行／靜止列。下方的 ω 是示範值。selectGait(ω 未提供) = ${selectGait({ moving: true })}。`);
  const rw = row(s), L = 70, atlas = bakeAntAtlas(L, DPR);
  const demos: [string, number, number][] = [['弧線左轉 curveL（ω=−0.8 rad/s 示範）', -0.8, 1.2], ['弧線右轉 curveR（ω=+0.8 rad/s 示範）', 0.8, 1.2], ['原地右轉 pivotR（ω=+1.2 rad/s 示範）', 1.2, 0]];
  for (const [cap, omega, speedBL] of demos) {
    const w = 260, h = 220, ctx = canvasIn(rw, w, h, DPR, cap), gait = selectGait({ moving: speedBL > 0, speedBL, omega });
    animations.push((t) => {
      paintSoil(ctx, w, h, 6, 29); const th = omega * t / 1000;
      if (speedBL > 0) { // circle of radius R (capped for the panel) with the centre on the inner side of the turn
        const R = Math.min((speedBL * L) / Math.abs(omega), 70), a = th - Math.sign(omega) * Math.PI / 2;
        drawAntSprite(ctx, atlas, DPR, w / 2 + Math.cos(a) * R, h / 2 + Math.sin(a) * R, th, gait, walkFrame(walkCycles(Math.abs(th) * R, L)));
      }
      else drawAntSprite(ctx, atlas, DPR, w / 2, h / 2, th, gait, walkFrame(pivotCycles(th)));
    });
  }
  const sw = W(), strip = canvasIn(s, sw, 120, DPR, '靜態幀：curveR（上列，右側＝內側步幅短）與 pivotR（下列）；紅＝三腳架 A、藍＝B，實心＝支撐相'), at = bakeAntAtlas(44, DPR), cw = sw / WALK_FRAMES;
  paintSoil(strip, sw, 120, 5, 31);
  for (const [gi, gait] of (['curveR', 'pivotR'] as const).entries()) for (let i = 0; i < WALK_FRAMES; i++) {
    const cx = cw * i + cw / 2, cy = 32 + gi * 58; drawAntSprite(strip, at, DPR, cx, cy, -Math.PI / 2, gait, i);
    for (const lp of antPose(gait, i).legs) { const [fx, fy] = lp.pts[4], k = 44 / 100; strip.beginPath(); strip.arc(cx + fy * k, cy - fx * k, 2.2, 0, 7); strip.fillStyle = tripodSet(lp.id) === 'A' ? (lp.stance ? '#ff5a4a' : 'rgba(255,90,74,0.25)') : (lp.stance ? '#5aa8ff' : 'rgba(90,168,255,0.25)'); strip.fill(); }
  }
}

// ---------------------------------------------------------------- sun states
function sunSection() {
  const s = section('sun', '光源狀態（示意）：同一組資產在不同太陽位置下', `光線由明確的光源狀態（方位角、高度角）驅動，陰影方向與長度、反光、地面立體感與整體色調都跟著變。<b>重播模式只用固定示意光源</b>（「${SCHEMATIC_LIGHT.label}」）：重播資料只有 360 分鐘活動時段、沒有時刻。真正的日夜只在引擎提供真實時間與太陽位置時接線（P0-A1 太陽模組，尚未進入重播資料；V6-2）。以下太陽位置都是示範用的假設值。`);
  const rw = row(s), tw = Math.min(228, (W() - 40) / 5), th = 190, ppm = 4;
  const states = [lightFromSun(90, 8, '清晨・東・8°（示範）'), lightFromSun(125, 42, '上午・東南・42°（示範）'), lightFromSun(180, 78, '近正午・78°（示範）'), lightFromSun(262, 14, '傍晚・西・14°（示範）'), lightFromSun(300, -12, '夜間・太陽在地平線下（示範）'), SCHEMATIC_LIGHT];
  for (const st of states) {
    const g = canvasIn(rw, tw, th, DPR, st.label);
    withLight(st, () => {
      const tile = tileAt(pixelsToCanvas(soilTile({ size: 256, seed: 41, light: st }), 256, 256), `sun|${st.label}`, 40 * ppm * DPR), pat = g.createPattern(tile, 'repeat') as CanvasPattern;
      pat.setTransform(new DOMMatrix([1 / DPR, 0, 0, 1 / DPR, 0, 0])); g.fillStyle = pat; g.fillRect(0, 0, tw, th);
      for (const d of [leaf(951, 'ovate', 14, 14, 0.5, 24), pebble(952, 40, 30, 6), grassTuft(953, 20, 38, 22, 0.2), twig(954, 36, 12, 2.2, 22)]) drawDecal(g, d, ppm);
      const a = bakeAntAtlas(34, DPR); drawAntSprite(g, a, DPR, tw * 0.62, th * 0.62, -0.4, 'walk', 3);
      drawList(g, [sunWash(tw, th, 0.25), ...lightGrade(tw, th)], DPR);
    });
  }
}

function loop(t: number) { for (const a of animations) a(t); requestAnimationFrame(loop); }
mockGarden(); antSection(); turnSection(); soilSection(); decalSection(); placesSection(); sunSection(); fxSection();
(window as unknown as { __artReady: boolean }).__artReady = true;
requestAnimationFrame(loop);
