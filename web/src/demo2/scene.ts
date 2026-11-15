/**
 * Demo 2 — the one world's scenery: an ordinary home-garden corner (Xitun, Taichung — a 情境假設, not a surveyed
 * place) on top of a soil block whose front is cut open through the nest (展示假設 geometry, nest-graph.ts).
 * Display only: nothing here is read by the simulation; scenery is not an obstacle and no ant senses it.
 *
 *  - ground relief, soil grain, lawn patches, leaf litter, stones, pebbles, twigs, weeds, a brick edging, stepping
 *    stones and a terracotta pot: DECORATION (裝飾), placed by a seeded PRNG (identical on every load);
 *  - the host plant with hemipterans at the end of the route: the place of the engine's honeydew source (the source
 *    and its distance are engine; the plant's look and the route direction are 示意);
 *  - the cut face: soil profile with the cavity carved from the SAME shapes the routing uses; cavity walls from a
 *    marching-squares contour of the same signed distance function; a back wall behind the cavity;
 *  - 展示情境 props (nectar flower, dead insect): INERT, shown only in demo mode, labelled 示範道具.
 * Scene budget (documented in docs/demo2.md): Lambert materials, instanced scenery, no real-time shadows below the
 * "high" quality level.
 */
import * as THREE from 'three';
import { fbm, isClear, prng, vnoise, distToSegment, type KeepOut } from '../three/terrain.ts';
import { BLOCK, ground } from './surface.ts';
import type { NestGraph, P3 } from './nest-graph.ts';

export type Quality = 'high' | 'medium' | 'low';
export interface SceneOptions { graph: NestGraph; corridor: P3[]; source: P3; searchRadius: number }
export interface Scene2 {
  group: THREE.Group; demoProps: THREE.Group; route: THREE.Object3D; shadowCasters: THREE.Object3D[];
  /** label anchors (cm) for the HTML overlay */
  anchors: { hostPlant: P3; nectar: P3; insect: P3 };
  setQuality(q: Quality): void; triangles(): number;
  /** HD-2D picture style (畫面效果): denser grass, leaf litter and ground-cover leaves, floating dust and light shafts.
   *  Scenery only — no organism, no food source, nothing an ant senses. Built on first use, hidden in the standard style. */
  setStyle(hd: boolean): void;
  /** light shafts and dust follow the ENGINE's light state and the drawn sun direction (never a time of day of their own) */
  setAtmosphere(light: 'day' | 'civil_twilight' | 'night', sunDir: THREE.Vector3, sunColor: THREE.Color, clock: number): void;
  /** what the HD-2D extras currently show (tests / the 效能 tab) */
  styleState(): { built: boolean; on: boolean; shafts: boolean; dust: number; extra_instances: number };
}
const W = BLOCK.x1 - BLOCK.x0, D = BLOCK.z1 - BLOCK.z0, FACE_TOP = 8;
const col = (h: string) => new THREE.Color(h);
function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
function soilGrain(rnd: () => number, base: string, n: number): THREE.CanvasTexture {
  const t = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    for (let i = 0; i < n; i++) {
      const x = rnd() * w, y = rnd() * h, r = 0.5 + rnd() * rnd() * 2.6, l = rnd();
      g.fillStyle = l < 0.45 ? `rgba(52,36,24,${0.2 + rnd() * 0.35})` : l < 0.82 ? `rgba(150,118,86,${0.18 + rnd() * 0.3})` : `rgba(205,186,160,${0.25 + rnd() * 0.35})`;
      g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rnd() * 0.5), rnd() * 3, 0, Math.PI * 2); g.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; return t;
}
/** the soil profile of the front cut face, with the nest cavity punched out (alpha 0) */
function faceTex(rnd: () => number, graph: NestGraph, wide: number): THREE.CanvasTexture {
  const ppc = wide / W, h = Math.round((FACE_TOP - BLOCK.bottom) * ppc);
  return canvasTex(wide, h, (g) => {
    const X = (x: number) => (x - BLOCK.x0) * ppc, Y = (y: number) => (FACE_TOP - y) * ppc;
    const layers: [number, string][] = [[FACE_TOP, '#4b3525'], [-2, '#5e422c'], [-12, '#7b5839'], [-26, '#93714c'], [BLOCK.bottom, '#9c7d59']];
    for (let i = 0; i < layers.length - 1; i++) { const gr = g.createLinearGradient(0, Y(layers[i][0]), 0, Y(layers[i + 1][0])); gr.addColorStop(0, layers[i][1]); gr.addColorStop(1, layers[i + 1][1]); g.fillStyle = gr; g.fillRect(0, Y(layers[i][0]), wide, Y(layers[i + 1][0]) - Y(layers[i][0]) + 1); }
    for (let i = 0; i < wide * h * 0.018; i++) { const x = rnd() * wide, y = rnd() * h, r = 0.6 + rnd() * 1.8; g.fillStyle = rnd() < 0.5 ? 'rgba(30,20,12,0.32)' : 'rgba(205,176,136,0.22)'; g.fillRect(x, y, r, r); }
    for (let i = 0; i < W * 0.75; i++) { // stones in the profile
      const x = rnd() * wide, y = Y(-3 - rnd() * 39), r = (0.3 + rnd() * rnd() * 2.2) * ppc;
      g.fillStyle = ['#8d8478', '#a59a8a', '#6f675e', '#b3a58e'][Math.floor(rnd() * 4)]; g.beginPath(); g.ellipse(x, y, r, r * (0.55 + rnd() * 0.4), rnd() * 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.ellipse(x - r * 0.25, y - r * 0.25, r * 0.4, r * 0.25, 0, 0, Math.PI * 2); g.fill();
    }
    g.lineCap = 'round'; g.lineJoin = 'round';
    for (let i = 0; i < W * 0.16; i++) { // roots from the surface
      let x = rnd() * wide, y = Y(6); g.strokeStyle = `rgba(${176 + rnd() * 40},${138 + rnd() * 30},${96 + rnd() * 20},0.7)`; g.lineWidth = (0.18 + rnd() * 0.4) * ppc; g.beginPath(); g.moveTo(x, y);
      const n = 5 + Math.floor(rnd() * 9); for (let k = 0; k < n; k++) { x += (rnd() - 0.5) * 3.4 * ppc; y += (0.8 + rnd() * 2.4) * ppc; g.lineTo(x, y); }
      g.stroke();
    }
    // the cavity: exactly the shapes of NestGraph.sdf (domes over the chamber floors, round tubes along the tunnels)
    const S = graph.cavityShapes(), carve = (grow: number) => {
      for (const d of S.domes) { g.save(); g.beginPath(); g.rect(X(d.cx - d.rx) - grow - 2, Y(d.floor + d.h) - grow - 2, 2 * d.rx * ppc + 2 * grow + 4, (d.h + d.under) * ppc + 2 * grow + 2); g.clip(); g.beginPath(); g.ellipse(X(d.cx), Y(d.floor), d.rx * ppc + grow, d.h * ppc + grow, 0, 0, Math.PI * 2); g.fill(); g.restore(); }
      for (const t of S.tubes) { g.lineWidth = 2 * t.r * ppc + 2 * grow; g.beginPath(); t.pts.forEach((p, i) => (i ? g.lineTo(X(p.x), Y(p.y)) : g.moveTo(X(p.x), Y(p.y)))); g.stroke(); }
    };
    g.fillStyle = g.strokeStyle = 'rgba(38,24,14,0.42)'; carve(0.3 * ppc); // compacted, darker rim around the cavity
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = g.strokeStyle = '#000'; carve(0);
    g.globalCompositeOperation = 'source-over';
  });
}
function leafGeometry(): THREE.BufferGeometry {
  const NU = 5, NV = 2, pos: number[] = [], idx: number[] = [], colr: number[] = [];
  for (let i = 0; i <= NU; i++) { const u = i / NU, half = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.02)), 0.75) * 0.5; for (let j = 0; j <= NV; j++) { const v = (j / NV) * 2 - 1; pos.push(u - 0.5, 0.1 * v * v + 0.24 * (u - 0.5) ** 2 - (j === 1 ? 0.03 : 0), v * half); const vein = j === 1 ? 1.2 : 1; colr.push(vein, vein, vein); } }
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) { const a = i * (NV + 1) + j, b = a + NV + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
function bladeGeometry(): THREE.BufferGeometry {
  const N = 3, pos: number[] = [], idx: number[] = [], colr: number[] = [];
  for (let i = 0; i <= N; i++) { const u = i / N, w = 0.5 * (1 - u) ** 0.9, bend = 0.3 * u * u; pos.push(-w, u, bend, w, u, bend); const c = 0.5 + 0.5 * u; colr.push(c, c, c, c, c, c); if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}
function stoneGeometry(rnd: () => number, detail: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, detail), p = g.attributes.position as THREE.BufferAttribute, s = rnd() * 100;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i), n = 1 + 0.3 * fbm(x * 1.4 + s, z * 1.4 + y * 0.7, 3, 7); p.setXYZ(i, x * n, y * n * 0.6, z * n); }
  g.computeVertexNormals(); return g;
}

export function buildScene(o: SceneOptions): Scene2 {
  const rnd = prng(20261115), group = new THREE.Group(), demoProps = new THREE.Group(), g = o.graph, faceZ = g.faceZ, backZ = g.backZ, casters: THREE.Object3D[] = [];
  const keepOut: KeepOut = { routes: o.corridor.slice(1).map((b, i) => ({ a: o.corridor[i], b })), nests: [{ x: 0, z: 0 }], routeHalfWidth: 5.5, nestRadius: o.searchRadius + 2 };
  const scalable: { mesh: THREE.InstancedMesh; full: number }[] = [];
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), C = new THREE.Color(), V = new THREE.Vector3(), S = new THREE.Vector3();
  const lam = (p: THREE.MeshLambertMaterialParameters) => new THREE.MeshLambertMaterial(p);
  const cast = <T extends THREE.Object3D>(m: T) => { casters.push(m); return m; };

  // ---- ground top (with the entrance hole cut out) ----
  const seg = 2.2, nx = Math.round(W / seg), nz = Math.round(D / seg), gg = new THREE.PlaneGeometry(W, D, nx, nz);
  gg.rotateX(-Math.PI / 2); gg.translate((BLOCK.x0 + BLOCK.x1) / 2, 0, (BLOCK.z0 + BLOCK.z1) / 2);
  { const p = gg.attributes.position as THREE.BufferAttribute, c = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i); p.setY(i, ground(x, z));
      const damp = vnoise(x * 0.02, z * 0.02, 41), dry = vnoise(x * 0.06, z * 0.06, 43), lawn = lawnAt(x, z), near = Math.hypot(x, z), k = 0.84 + 0.22 * dry - 0.2 * damp + (near < 6 ? 0.1 * (1 - near / 6) : 0);
      c.set([k * (1 - 0.22 * lawn), k * (0.96 + 0.02 * lawn), k * (0.9 - 0.25 * lawn)], i * 3);
    }
    gg.setAttribute('color', new THREE.BufferAttribute(c, 3));
    const ix = gg.index!, keep: number[] = [];
    for (let i = 0; i < ix.count; i += 3) { const a = ix.getX(i), b = ix.getX(i + 1), d = ix.getX(i + 2), cx = (p.getX(a) + p.getX(b) + p.getX(d)) / 3, cz = (p.getZ(a) + p.getZ(b) + p.getZ(d)) / 3; if (Math.hypot(cx, cz) > 1.7 && !(Math.abs(cx) < 1.8 && cz > 0)) keep.push(a, b, d); } // the hole, open toward the cut face
    gg.setIndex(keep); gg.computeVertexNormals(); }
  const grain = soilGrain(rnd, '#9b7d60', 2600); grain.repeat.set(W / 16, D / 16);
  const groundMesh = new THREE.Mesh(gg, lam({ map: grain, vertexColors: true, color: col('#f2dcc0') })); groundMesh.receiveShadow = true; group.add(groundMesh);
  // entrance rim: the funnel of excavated soil around the hole (follows the ground; clipped at the cut face)
  { const pos: number[] = [], idx: number[] = [], colr: number[] = [], rings = [1.0, 1.25, 1.7, 2.4, 3.3, 4.6], NA = 40;
    rings.forEach((r, ri) => { for (let a = 0; a <= NA; a++) { const th = (a / NA) * Math.PI * 2, x = Math.cos(th) * r, z = Math.min(faceZ - 0.01, Math.sin(th) * r), y = ri === 0 ? ground(0, 0) - 1.4 : ground(x, z) + 0.1 + 0.12 * Math.sin(ri * 1.3 + a * 0.9) * (ri < 5 ? 1 : 0); pos.push(x, y, z); const k = ri === 0 ? 0.35 : 0.8 + 0.2 * vnoise(x * 3, z * 3, 5); colr.push(k, k * 0.94, k * 0.86); } });
    for (let ri = 0; ri < rings.length - 1; ri++) for (let a = 0; a < NA; a++) { const p0 = ri * (NA + 1) + a, p1 = p0 + NA + 1, mx = (pos[p0 * 3] + pos[p1 * 3 + 3]) / 2, mz = (pos[p0 * 3 + 2] + pos[p1 * 3 + 5]) / 2; if (Math.abs(mx) < 1.8 && mz > 0.6) continue; idx.push(p0, p1, p0 + 1, p1, p1 + 1, p0 + 1); }
    const rg = new THREE.BufferGeometry(); rg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); rg.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3)); rg.setIndex(idx); rg.computeVertexNormals();
    const rim = new THREE.Mesh(rg, lam({ vertexColors: true, color: col('#c9a67c'), side: THREE.DoubleSide })); rim.receiveShadow = true; group.add(rim); }

  // ---- cut faces ----
  const xs: number[] = []; for (let x = BLOCK.x0; x <= BLOCK.x1 + 1e-6; x += 1) xs.push(Math.min(BLOCK.x1, x));
  const zs: number[] = []; for (let z = BLOCK.z0; z <= BLOCK.z1 + 1e-6; z += 2.4) zs.push(Math.min(BLOCK.z1, z));
  const strip = (pts: { x: number; z: number }[], u: (p: { x: number; z: number }) => number) => {
    const pos: number[] = [], uv: number[] = [], idx: number[] = [], vMax = FACE_TOP - BLOCK.bottom;
    pts.forEach((p, i) => { const top = ground(p.x, p.z); pos.push(p.x, top, p.z, p.x, BLOCK.bottom, p.z); uv.push(u(p), (top - BLOCK.bottom) / vMax, u(p), 0); if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } });
    const b = new THREE.BufferGeometry(); b.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); b.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); b.setIndex(idx); b.computeVertexNormals(); return b;
  };
  const maxTex = 4096, frontTex = faceTex(rnd, g, maxTex), sideTex = soilGrain(rnd, '#6b4c32', 1800); sideTex.repeat.set(10, 3);
  const front = new THREE.Mesh(strip(xs.map((x) => ({ x, z: faceZ })), (p) => (p.x - BLOCK.x0) / W), lam({ map: frontTex, alphaTest: 0.5, side: THREE.DoubleSide })); group.add(front);
  const sideMat = lam({ map: sideTex, color: col('#b89878'), side: THREE.DoubleSide });
  group.add(new THREE.Mesh(strip(xs.map((x) => ({ x, z: BLOCK.z0 })), (p) => (p.x - BLOCK.x0) / W), sideMat));
  group.add(new THREE.Mesh(strip(zs.map((z) => ({ x: BLOCK.x0, z })), (p) => (p.z - BLOCK.z0) / W), sideMat));
  group.add(new THREE.Mesh(strip(zs.map((z) => ({ x: BLOCK.x1, z })), (p) => (p.z - BLOCK.z0) / W), sideMat));
  // the soil wall continues below and beside the block (decoration): a tall or wide view never shows an empty void
  { const pos: number[] = [], colr: number[] = [], idx: number[] = [], X0 = BLOCK.x0 - 900, X1 = BLOCK.x1 + 900, Y0 = BLOCK.bottom - 700, stops: [number, string][] = [[FACE_TOP, '#4b3525'], [-2, '#5e422c'], [-12, '#7b5839'], [-26, '#93714c'], [BLOCK.bottom, '#9c7d59'], [Y0, '#6f5539']];
    const cAt = (y: number) => { for (let i = 0; i < stops.length - 1; i++) if (y <= stops[i][0] && y >= stops[i + 1][0]) return col(stops[i][1]).lerp(col(stops[i + 1][1]), (stops[i][0] - y) / (stops[i][0] - stops[i + 1][0])); return col(stops[0][1]); };
    const rect = (xa: number, xb: number, ys: number[], topA: number, topB: number) => { ys.forEach((y, i) => { const b0 = pos.length / 3, ya = i === 0 ? topA : y, yb = i === 0 ? topB : y, c = cAt(y); pos.push(xa, ya, faceZ - 0.03, xb, yb, faceZ - 0.03); colr.push(c.r, c.g, c.b, c.r, c.g, c.b); if (i > 0) idx.push(b0 - 2, b0, b0 - 1, b0 - 1, b0, b0 + 1); }); };
    const side = [0, -2, -12, -26, BLOCK.bottom];
    rect(X0, BLOCK.x0, side, ground(BLOCK.x0, faceZ), ground(BLOCK.x0, faceZ)); rect(BLOCK.x1, X1, side, ground(BLOCK.x1, faceZ), ground(BLOCK.x1, faceZ)); rect(X0, X1, [BLOCK.bottom, BLOCK.bottom - 60, Y0], BLOCK.bottom, BLOCK.bottom);
    const uv: number[] = []; for (let i = 0; i < pos.length; i += 3) uv.push(pos[i] / 36, pos[i + 1] / 36);
    const eg = new THREE.BufferGeometry(); eg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); eg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); eg.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3)); eg.setIndex(idx); eg.computeVertexNormals();
    const wallTex = soilGrain(rnd, '#e9dccb', 1800); wallTex.repeat.set(1, 1);
    const em = new THREE.Mesh(eg, lam({ map: wallTex, vertexColors: true, side: THREE.DoubleSide })); group.add(em); }
  // display stand (decoration): a table under and behind the block (never in front of the soil wall)
  group.add(new THREE.Mesh(new THREE.PlaneGeometry(2400, 1400).rotateX(-Math.PI / 2).translate((BLOCK.x0 + BLOCK.x1) / 2, BLOCK.bottom - 0.4, faceZ - 0.1 - 700), new THREE.MeshLambertMaterial({ color: col('#8a8460') })));

  // ---- cavity: back wall + walls (marching squares over the same sdf the routing and the mask use) ----
  const B = g.bounds(1);
  // back wall: pale excavated soil, darker toward the cavity walls (painted occlusion from the same sdf; decoration)
  // (its top stays below the ground surface behind the cut, so it never shows above the garden)
  { let top = Infinity; for (let x = B.x0; x <= B.x1; x += 1) top = Math.min(top, ground(x, backZ)); B.y1 = Math.min(B.y1, top - 0.25); }
  const backTex = canvasTex(Math.round((B.x1 - B.x0) * 8), Math.round((B.y1 - B.y0) * 8), (c2, cw, chh) => {
    const step = 0.5, gw = Math.ceil((B.x1 - B.x0) / step), gh = Math.ceil((B.y1 - B.y0) / step), small = document.createElement('canvas'); small.width = gw; small.height = gh;
    const sg = small.getContext('2d')!, img = sg.createImageData(gw, gh);
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) { const d = -g.sdf(B.x0 + (i + 0.5) * step, B.y1 - (j + 0.5) * step), k = Math.max(0, Math.min(1, d / 2.4)), s2 = 0.5 + 0.5 * k * k * (3 - 2 * k), o2 = (j * gw + i) * 4; img.data[o2] = 214 * s2; img.data[o2 + 1] = 186 * s2; img.data[o2 + 2] = 150 * s2; img.data[o2 + 3] = 255; }
    sg.putImageData(img, 0, 0); c2.imageSmoothingEnabled = true; c2.drawImage(small, 0, 0, cw, chh);
    for (let i = 0; i < cw * chh * 0.012; i++) { const x = rnd() * cw, y = rnd() * chh, r = 0.6 + rnd() * 1.6; c2.fillStyle = rnd() < 0.5 ? 'rgba(70,48,30,0.22)' : 'rgba(245,228,200,0.2)'; c2.fillRect(x, y, r, r); }
  });
  const backWall = new THREE.Mesh(new THREE.PlaneGeometry(B.x1 - B.x0, B.y1 - B.y0).translate((B.x0 + B.x1) / 2, (B.y0 + B.y1) / 2, backZ), new THREE.MeshBasicMaterial({ map: backTex })); group.add(backWall);
  { const cell = 0.3, top = g.nodes.get(g.layout.entrance.id)!.y + 1.2, cols = Math.ceil((B.x1 - B.x0) / cell), rows = Math.ceil((top - B.y0) / cell), val = new Float32Array((cols + 1) * (rows + 1));
    for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) val[j * (cols + 1) + i] = g.sdf(B.x0 + i * cell, B.y0 + j * cell);
    const pos: number[] = [], nor: number[] = [], colr: number[] = [], idx: number[] = [];
    const quad = (ax: number, ay: number, bx: number, by: number, nxn: number, nyn: number) => {
      const b0 = pos.length / 3, sh = 0.55 + 0.45 * Math.max(0, nyn); // floors catch more light than ceilings
      pos.push(ax, ay, faceZ, bx, by, faceZ, bx, by, backZ, ax, ay, backZ); for (let k = 0; k < 4; k++) nor.push(nxn, nyn, 0.25);
      colr.push(sh, sh, sh, sh, sh, sh, sh * 0.62, sh * 0.62, sh * 0.62, sh * 0.62, sh * 0.62, sh * 0.62);
      // winding so the geometric front face looks into the cavity (a double-sided Lambert material flips the normal of back faces)
      if ((bx - ax) * nyn - (by - ay) * nxn > 0) idx.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3); else idx.push(b0, b0 + 2, b0 + 1, b0, b0 + 3, b0 + 2);
    };
    for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
      const v0 = val[j * (cols + 1) + i], v1 = val[j * (cols + 1) + i + 1], v2 = val[(j + 1) * (cols + 1) + i + 1], v3 = val[(j + 1) * (cols + 1) + i];
      const code = (v0 < 0 ? 1 : 0) | (v1 < 0 ? 2 : 0) | (v2 < 0 ? 4 : 0) | (v3 < 0 ? 8 : 0); if (code === 0 || code === 15) continue;
      const x0 = B.x0 + i * cell, y0 = B.y0 + j * cell, lerp = (a: number, b: number) => a / (a - b);
      const e: [number, number][] = [[x0 + cell * lerp(v0, v1), y0], [x0 + cell, y0 + cell * lerp(v1, v2)], [x0 + cell * lerp(v3, v2), y0 + cell], [x0, y0 + cell * lerp(v0, v3)]];
      const segs: [number, number][] = ({ 1: [[3, 0]], 2: [[0, 1]], 3: [[3, 1]], 4: [[1, 2]], 5: [[3, 2], [0, 1]], 6: [[0, 2]], 7: [[3, 2]], 8: [[2, 3]], 9: [[0, 2]], 10: [[0, 3], [1, 2]], 11: [[1, 2]], 12: [[1, 3]], 13: [[0, 1]], 14: [[3, 0]] } as Record<number, [number, number][]>)[code];
      const gx = (v1 + v2 - v0 - v3) / 2, gy = (v2 + v3 - v0 - v1) / 2, gl = Math.hypot(gx, gy) || 1;
      for (const [a, b] of segs) quad(e[a][0], e[a][1], e[b][0], e[b][1], -gx / gl, -gy / gl);
    }
    const wg = new THREE.BufferGeometry(); wg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); wg.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); wg.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3)); wg.setIndex(idx);
    group.add(new THREE.Mesh(wg, lam({ vertexColors: true, color: col('#b08a64'), side: THREE.DoubleSide }))); }

  // ---- scenery helpers ----
  function lawnAt(x: number, z: number): number { // lawn patches away from the nest / route (decoration)
    const n = vnoise(x * 0.018, z * 0.018, 77); return n > 0.52 && isFar(x, z, 14) ? Math.min(1, (n - 0.52) * 6) : 0;
  }
  function isFar(x: number, z: number, d: number): boolean { return Math.hypot(x, z) > o.searchRadius + d * 0.4 && o.corridor.slice(1).every((b, i) => distToSegment(x, z, o.corridor[i], b) > d); }
  const spot = (margin: number): { x: number; z: number } | null => {
    for (let k = 0; k < 40; k++) { const x = BLOCK.x0 + margin + rnd() * (W - 2 * margin), z = BLOCK.z0 + margin + rnd() * (D - 2 * margin - 1); if (isClear(x, z, keepOut)) return { x, z }; }
    return null;
  };
  const inst = (geo: THREE.BufferGeometry, mat: THREE.Material, n: number, shadow: boolean) => { const m = new THREE.InstancedMesh(geo, mat, n); m.receiveShadow = true; if (shadow) cast(m); group.add(m); scalable.push({ mesh: m, full: 0 }); return m; };
  const done = (m: THREE.InstancedMesh, n: number) => { m.count = n; scalable.find((s) => s.mesh === m)!.full = n; m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; };

  // entrance granules (excavated soil)
  { const N = 260, gm = inst(new THREE.IcosahedronGeometry(1, 0), lam({ color: col('#ffffff') }), N, false);
    for (let i = 0; i < N; i++) { const a = rnd() * Math.PI * 2, r = 1.3 + Math.pow(rnd(), 0.7) * 3.6, x = Math.cos(a) * r, z = Math.min(faceZ - 0.15, Math.sin(a) * r), s = 0.07 + rnd() * 0.16; M.compose(V.set(x, ground(x, z) + 0.12 + s * 0.4, z), Q.setFromEuler(E.set(rnd() * 3, rnd() * 3, 0)), S.set(s, s * 0.8, s)); gm.setMatrixAt(i, M); gm.setColorAt(i, C.setHSL(0.07 + rnd() * 0.03, 0.3 + rnd() * 0.12, 0.24 + rnd() * 0.14)); }
    done(gm, N); }
  // leaf litter
  const leafG = leafGeometry();
  { const N = 460, m = inst(leafG, lam({ vertexColors: true, side: THREE.DoubleSide }), N, true); let n = 0;
    for (let i = 0; i < N * 3 && n < N; i++) {
      const p = spot(3); if (!p) continue; if (vnoise(p.x * 0.025, p.z * 0.025, 51) < 0.44 && rnd() < 0.7) continue;
      const L = 2.4 + rnd() * rnd() * 7; M.compose(V.set(p.x, ground(p.x, p.z) + 0.1 + rnd() * 0.25, p.z), Q.setFromEuler(E.set((rnd() - 0.5) * 0.35, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.35)), S.set(L, L * (0.5 + rnd() * 0.6), L * (0.38 + rnd() * 0.3))); m.setMatrixAt(n, M);
      const r = rnd(); if (r < 0.5) C.setHSL(0.06 + rnd() * 0.04, 0.45 + rnd() * 0.2, 0.2 + rnd() * 0.12); else if (r < 0.82) C.setHSL(0.1 + rnd() * 0.03, 0.5, 0.32 + rnd() * 0.1); else C.setHSL(0.2 + rnd() * 0.08, 0.36, 0.26 + rnd() * 0.08);
      m.setColorAt(n++, C);
    }
    done(m, n); }
  // grass: lawn patches (short, dense) + scattered clumps (taller)
  { const N = 3400, m = inst(bladeGeometry(), lam({ vertexColors: true, side: THREE.DoubleSide }), N, false); let n = 0;
    const blade = (x: number, z: number, hh: number) => { if (n >= N || !isClear(x, z, keepOut) || z > faceZ - 1 || x < BLOCK.x0 + 1 || x > BLOCK.x1 - 1 || z < BLOCK.z0 + 1) return; M.compose(V.set(x, ground(x, z) - 0.15, z), Q.setFromEuler(E.set((rnd() - 0.5) * 0.5, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.5)), S.set(0.22 + rnd() * 0.2, hh, hh * 0.9)); m.setMatrixAt(n, M); m.setColorAt(n++, C.setHSL(0.23 + rnd() * 0.07, 0.38 + rnd() * 0.18, 0.2 + rnd() * 0.1)); };
    for (let i = 0; i < 9000 && n < N * 0.62; i++) { const x = BLOCK.x0 + rnd() * W, z = BLOCK.z0 + rnd() * D, l = lawnAt(x, z); if (rnd() < l) blade(x, z, 2.2 + rnd() * 3.2); }
    for (let k = 0; k < 70 && n < N; k++) { const p = spot(4); if (!p) continue; const per = 10 + Math.floor(rnd() * 22), rad = 1.5 + rnd() * 4, tall = 5 + rnd() * 11; for (let i = 0; i < per; i++) { const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * rad; blade(p.x + Math.cos(a) * r, p.z + Math.sin(a) * r, tall * (0.5 + rnd() * 0.6)); } }
    done(m, n); }
  // stones and pebbles
  { const geos = [0, 1, 2, 3].map(() => stoneGeometry(rnd, 2));
    for (let i = 0; i < 22; i++) { const p = spot(8); if (!p) continue; const s = 1.6 + rnd() * rnd() * 9, mat = lam({ color: new THREE.Color().setHSL(0.08 + rnd() * 0.05, 0.07 + rnd() * 0.1, 0.3 + rnd() * 0.16) }), m = new THREE.Mesh(geos[i % geos.length], mat); m.scale.set(s * (0.8 + rnd() * 0.5), s, s * (0.7 + rnd() * 0.5)); m.rotation.y = rnd() * Math.PI * 2; m.position.set(p.x, ground(p.x, p.z) + s * 0.15, p.z); m.receiveShadow = true; cast(m); group.add(m); }
    const N = 560, pm = inst(new THREE.IcosahedronGeometry(1, 0), lam({ color: col('#ffffff') }), N, false); let n = 0;
    for (let i = 0; i < N; i++) { const p = spot(1); if (!p) continue; const s = 0.12 + rnd() * rnd() * 0.7; M.compose(V.set(p.x, ground(p.x, p.z) + s * 0.3, p.z), Q.setFromEuler(E.set(rnd() * 3, rnd() * 3, rnd() * 3)), S.set(s, s * 0.7, s * (0.8 + rnd() * 0.4))); pm.setMatrixAt(n, M); pm.setColorAt(n++, C.setHSL(0.07 + rnd() * 0.06, 0.08 + rnd() * 0.14, 0.3 + rnd() * 0.2)); }
    done(pm, n); }
  // twigs
  { const twigMat = lam({ color: col('#6b4c38') });
    for (let i = 0; i < 16; i++) { const p = spot(10); if (!p) continue; const L = 5 + rnd() * 20, r = 0.12 + rnd() * 0.28, t = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.7, r, L, 5).rotateZ(Math.PI / 2), twigMat); t.position.set(p.x, ground(p.x, p.z) + r * 0.8, p.z); t.rotation.y = rnd() * Math.PI * 2; cast(t); group.add(t); } }
  // herbs (stem + leaves)
  const stemMat = lam({ color: col('#62803a') }), herbLeafMat = lam({ vertexColors: true, side: THREE.DoubleSide });
  const herb = (parent: THREE.Object3D, x: number, z: number, height: number, leaves: number, lean: number, hue = 0.25) => {
    const y0 = ground(x, z), curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, y0 - 0.5, z), new THREE.Vector3(x + lean * 0.3, y0 + height * 0.45, z + lean * 0.1), new THREE.Vector3(x + lean, y0 + height, z + lean * 0.3)]);
    parent.add(cast(new THREE.Mesh(new THREE.TubeGeometry(curve, 10, Math.max(0.18, height * 0.013), 5, false), stemMat)));
    const lm = new THREE.InstancedMesh(leafG, herbLeafMat, leaves);
    for (let i = 0; i < leaves; i++) { const u = 0.22 + (i / leaves) * 0.78, p = curve.getPoint(u), L = height * (0.24 + rnd() * 0.18) * (1.1 - u * 0.5); Q.setFromEuler(E.set(0, rnd() * Math.PI * 2, -0.35 - rnd() * 0.5)); M.compose(p.clone().add(V.set(L * 0.5, 0, 0).applyQuaternion(Q)), Q, S.set(L, L * 0.6, L * 0.5)); lm.setMatrixAt(i, M); lm.setColorAt(i, C.setHSL(hue + rnd() * 0.06, 0.48 + rnd() * 0.15, 0.32 + rnd() * 0.12)); }
    lm.receiveShadow = true; parent.add(cast(lm)); return curve;
  };
  for (let i = 0; i < 8; i++) { const p = spot(15); if (p) herb(group, p.x, p.z, 9 + rnd() * 22, 6 + Math.floor(rnd() * 8), (rnd() - 0.5) * 6); }
  // host plant at the honeydew source, with hemipterans on its lower stem (the engine's honeydew source; look 示意)
  const hx = o.source.x + 7, hz = o.source.z - 5, sc = herb(group, hx, hz, 36, 16, -3, 0.27);
  { const aph = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 7, 5), lam({ color: col('#a9c860') }), 30);
    for (let i = 0; i < 30; i++) { const p = sc.getPoint(0.04 + rnd() * 0.24), a = rnd() * Math.PI * 2; M.compose(p.add(V.set(Math.cos(a) * 0.5, 0, Math.sin(a) * 0.5)), Q.identity(), S.set(0.13, 0.09, 0.08)); aph.setMatrixAt(i, M); }
    group.add(aph); }
  // home-garden decoration: brick edging along the back, stepping stones, a terracotta pot
  { const N = Math.floor((W - 16) / 21), bricks = new THREE.InstancedMesh(new THREE.BoxGeometry(20, 5.5, 9.5), lam({ color: col('#ffffff') }), N);
    for (let i = 0; i < N; i++) { const x = BLOCK.x0 + 18 + i * 21 + (rnd() - 0.5) * 0.8, z = BLOCK.z0 + 9 + (rnd() - 0.5) * 0.8; M.compose(V.set(x, ground(x, z) + 1.6, z), Q.setFromEuler(E.set((rnd() - 0.5) * 0.04, (rnd() - 0.5) * 0.05, (rnd() - 0.5) * 0.04)), S.set(1, 1, 1)); bricks.setMatrixAt(i, M); bricks.setColorAt(i, C.setHSL(0.035 + rnd() * 0.02, 0.5 + rnd() * 0.12, 0.34 + rnd() * 0.08)); }
    bricks.receiveShadow = true; group.add(cast(bricks));
    const slabMat = lam({ color: col('#a9a59b') });
    for (const [x, z, r] of [[-48, -52, 13], [-30, -84, 12], [-52, -116, 13]] as const) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.03, 2.2, 9), slabMat); m.scale.z = 0.8; m.rotation.y = rnd() * 3; m.position.set(x, ground(x, z) + 0.5, z); m.receiveShadow = true; group.add(cast(m)); }
    const px = 96, pz = -122, pot = new THREE.Mesh(new THREE.LatheGeometry([[7.5, 0], [10, 14], [11, 15.5], [11.2, 17], [9.6, 17], [9.2, 15]].map(([r, y]) => new THREE.Vector2(r, y)), 14), lam({ color: col('#b5633c'), side: THREE.DoubleSide }));
    pot.position.set(px, ground(px, pz) - 0.3, pz); group.add(cast(pot));
    const soil = new THREE.Mesh(new THREE.CircleGeometry(9.4, 14).rotateX(-Math.PI / 2), lam({ color: col('#4a3526') })); soil.position.set(px, ground(px, pz) + 14.8, pz); group.add(soil);
    const pg = new THREE.Group(); pg.position.y = 15; group.add(pg); for (let i = 0; i < 3; i++) herb(pg, px + (i - 1) * 3, pz + (i % 2) * 2, 20 + rnd() * 10, 9, (i - 1) * 4, 0.3); }

  // ---- 展示情境 props: inert, labelled, hidden in natural mode ----
  const nectar = { x: 52, z: -46 }, insect = { x: 74, z: -14 };
  { const cv = herb(demoProps, nectar.x, nectar.z, 15, 7, 2, 0.29), top = cv.getPoint(1), petalMat = lam({ color: col('#f2c231'), side: THREE.DoubleSide });
    for (let i = 0; i < 7; i++) { const a = (i / 7) * Math.PI * 2, p = new THREE.Mesh(new THREE.CircleGeometry(1.5, 8), petalMat); p.position.set(top.x + Math.cos(a) * 1.6, top.y + 0.2, top.z + Math.sin(a) * 1.6); p.rotation.set(-Math.PI / 2 + 0.3, 0, a); p.scale.set(1, 0.55, 1); demoProps.add(p); }
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.9, 8, 6), lam({ color: col('#8a5a14') })); core.position.set(top.x, top.y + 0.3, top.z); demoProps.add(core);
    const iy = ground(insect.x, insect.z), dark = lam({ color: col('#2c2622') }), body = new THREE.Mesh(new THREE.SphereGeometry(1, 10, 8).scale(1.5, 0.6, 0.85), dark); body.position.set(insect.x, iy + 0.55, insect.z); body.rotation.z = 0.25; demoProps.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.5, 8, 6), dark); head.position.set(insect.x + 1.6, iy + 0.5, insect.z); demoProps.add(head);
    for (let i = 0; i < 6; i++) { const l = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.04, 1.6, 4), dark); l.position.set(insect.x - 0.8 + (i % 3) * 0.8, iy + 0.9, insect.z + (i < 3 ? 0.9 : -0.9)); l.rotation.x = i < 3 ? 0.9 : -0.9; demoProps.add(l); } }
  demoProps.visible = false; group.add(demoProps);

  // ---- the drawn foraging route (display corridor; length = engine route length) ----
  const routeGeo = new THREE.BufferGeometry().setFromPoints(o.corridor.map((p) => new THREE.Vector3(p.x, p.y + 0.18, p.z)));
  const route = new THREE.Line(routeGeo, new THREE.LineDashedMaterial({ color: 0xf6e3a0, dashSize: 2, gapSize: 2.4, transparent: true, opacity: 0.8 })); route.computeLineDistances(); group.add(route);

  // ---- HD-2D style extras (畫面效果): built on first use with their own seed, so the standard scenery never changes ----
  const UP = new THREE.Vector3(0, 1, 0), WHITE = new THREE.Color(0xffffff);
  let hd: { group: THREE.Group; dust: THREE.Points; dustMat: THREE.PointsMaterial; shafts: THREE.Group; shaftMat: THREE.MeshBasicMaterial } | null = null;
  const buildHd = () => {
    const r2 = prng(20261116), gph = new THREE.Group(), inBlock = (x: number, z: number) => x > BLOCK.x0 + 1 && x < BLOCK.x1 - 1 && z > BLOCK.z0 + 1 && z < faceZ - 1;
    // denser grass (same blade geometry), everywhere the route and the entrance area are not
    { const N = 5600, m = new THREE.InstancedMesh(bladeGeometry(), lam({ vertexColors: true, side: THREE.DoubleSide }), N); let n = 0;
      for (let i = 0; i < N * 4 && n < N; i++) { const x = BLOCK.x0 + r2() * W, z = BLOCK.z0 + r2() * D; if (!inBlock(x, z) || !isClear(x, z, keepOut)) continue; const dense = 0.35 + 0.65 * vnoise(x * 0.03, z * 0.03, 91); if (r2() > dense) continue; const hh = 2 + r2() * r2() * 9; M.compose(V.set(x, ground(x, z) - 0.15, z), Q.setFromEuler(E.set((r2() - 0.5) * 0.5, r2() * Math.PI * 2, (r2() - 0.5) * 0.5)), S.set(0.22 + r2() * 0.2, hh, hh * 0.9)); m.setMatrixAt(n, M); m.setColorAt(n++, C.setHSL(0.22 + r2() * 0.08, 0.42 + r2() * 0.2, 0.2 + r2() * 0.12)); }
      m.count = n; m.receiveShadow = true; gph.add(m); }
    // ground-cover leaves (small, low, green: foliage only — no flowers, nothing presented as food) and more leaf litter
    { const N = 1500, m = new THREE.InstancedMesh(leafG, lam({ vertexColors: true, side: THREE.DoubleSide }), N); let n = 0;
      for (let i = 0; i < N * 4 && n < N; i++) { const x = BLOCK.x0 + r2() * W, z = BLOCK.z0 + r2() * D; if (!inBlock(x, z) || !isClear(x, z, keepOut)) continue; const litter = r2() < 0.3, L = litter ? 2 + r2() * 5 : 0.9 + r2() * 1.6; M.compose(V.set(x, ground(x, z) + (litter ? 0.12 : 0.25) + r2() * 0.2, z), Q.setFromEuler(E.set((r2() - 0.5) * 0.5, r2() * Math.PI * 2, (r2() - 0.5) * 0.5)), S.set(L, L * 0.6, L * (0.5 + r2() * 0.4))); m.setMatrixAt(n, M);
        if (litter) C.setHSL(0.07 + r2() * 0.05, 0.45 + r2() * 0.2, 0.22 + r2() * 0.14); else C.setHSL(0.26 + r2() * 0.08, 0.5 + r2() * 0.15, 0.26 + r2() * 0.1); m.setColorAt(n++, C); }
      m.count = n; m.receiveShadow = true; gph.add(m); }
    // floating dust: tiny pale motes in the air above the garden (not organisms: no shape, no flight path, slow drift)
    const dn = 260, dp = new Float32Array(dn * 3); for (let i = 0; i < dn; i++) { dp[i * 3] = BLOCK.x0 + 20 + r2() * (W - 40); dp[i * 3 + 1] = 1.5 + r2() * r2() * 38; dp[i * 3 + 2] = BLOCK.z0 + 10 + r2() * (D - 12); }
    const dg = new THREE.BufferGeometry(); dg.setAttribute('position', new THREE.Float32BufferAttribute(dp, 3));
    const dustMat = new THREE.PointsMaterial({ size: 0.42, sizeAttenuation: true, transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending, color: 0xfff2d8 }), dust = new THREE.Points(dg, dustMat); dust.frustumCulled = false; gph.add(dust);
    // light shafts: a few soft additive sheets along the drawn sun direction (decoration; hidden at night)
    const shaftTex = canvasTex(32, 128, (g2, w, h) => { const gr = g2.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, 'rgba(255,255,255,0)'); gr.addColorStop(0.5, 'rgba(255,255,255,1)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g2.fillStyle = gr; g2.fillRect(0, 0, w, h); const gv = g2.createLinearGradient(0, 0, 0, h); gv.addColorStop(0, 'rgba(0,0,0,0.75)'); gv.addColorStop(0.35, 'rgba(0,0,0,0)'); gv.addColorStop(1, 'rgba(0,0,0,0.9)'); g2.globalCompositeOperation = 'destination-out'; g2.fillStyle = gv; g2.fillRect(0, 0, w, h); });
    const shaftMat = new THREE.MeshBasicMaterial({ map: shaftTex, transparent: true, opacity: 0.085, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }), shafts = new THREE.Group();
    for (const [x, z, wd] of [[-30, -40, 22], [25, -70, 30], [70, -30, 20], [120, -90, 34], [165, -50, 24]] as const) { const m = new THREE.Mesh(new THREE.PlaneGeometry(wd, 150).translate(0, 70, 0), shaftMat); m.position.set(x, ground(x, z) - 2, z); m.renderOrder = 4; shafts.add(m); }
    gph.add(shafts);
    return { group: gph, dust, dustMat, shafts, shaftMat };
  };

  let tris = 0; group.traverse((x) => { const m = x as THREE.Mesh; if (m.isMesh && m.geometry) { const gI = m.geometry.index, n = (gI ? gI.count : m.geometry.attributes.position.count) / 3; tris += n * ((m as unknown as THREE.InstancedMesh).isInstancedMesh ? (m as unknown as THREE.InstancedMesh).count : 1); } });
  return {
    group, demoProps, route, shadowCasters: casters,
    anchors: { hostPlant: { x: hx - 2, y: ground(hx, hz) + 30, z: hz }, nectar: { x: nectar.x, y: ground(nectar.x, nectar.z) + 18, z: nectar.z }, insect: { x: insect.x, y: ground(insect.x, insect.z) + 3, z: insect.z } },
    styleState: () => ({ built: !!hd, on: !!hd && hd.group.visible, shafts: !!hd && hd.group.visible && hd.shafts.visible, dust: hd ? hd.dust.geometry.attributes.position.count : 0, extra_instances: hd ? hd.group.children.reduce((a, c) => a + ((c as THREE.InstancedMesh).isInstancedMesh ? (c as THREE.InstancedMesh).count : 0), 0) : 0 }),
    setStyle: (on) => { if (on && !hd) { hd = buildHd(); group.add(hd.group); } if (hd) hd.group.visible = on; },
    setAtmosphere: (light, sunDir, sunColor, clock) => {
      if (!hd || !hd.group.visible) return;
      const k = light === 'day' ? 1 : light === 'civil_twilight' ? 0.7 : 0;
      hd.shafts.visible = k > 0; hd.shaftMat.opacity = 0.085 * k; hd.shaftMat.color.copy(sunColor);
      for (const m of hd.shafts.children) m.quaternion.setFromUnitVectors(UP, sunDir);
      hd.dustMat.opacity = light === 'night' ? 0.12 : 0.42; hd.dustMat.color.copy(sunColor).lerp(WHITE, 0.5);
      hd.dust.position.set(Math.sin(clock * 0.07) * 3, Math.sin(clock * 0.11) * 1.2, Math.cos(clock * 0.05) * 3); // slow drift (display clock; frozen while paused)
    },
    setQuality: (q) => { const k = q === 'high' ? 1 : q === 'medium' ? 0.6 : 0.3; for (const s of scalable) s.mesh.count = Math.max(1, Math.floor(s.full * k)); for (const c of casters) c.castShadow = q === 'high'; },
    triangles: () => tris,
  };
}
