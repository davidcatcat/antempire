/**
 * Three.js 3D prototype — the garden diorama (SCENERY, 示意). Display only: nothing here is read by the simulation.
 *
 * The P0-A2 candidate world models no garden geometry. Ground relief, soil layers, leaf litter, grass, herbs, stones,
 * pebbles, twigs and the excavated soil around the entrance are drawn so the ants stand in a believable place; their
 * sizes are ordinary garden sizes (centimetres), placed by a seeded PRNG (identical on every load). The nest chambers on
 * the cut face are the SCHEMATIC engine-state groups of nest3d.ts. Scenery keeps clear of the drawn route and the
 * entrance so it never hides an ant; it does not mean the ground there is different.
 */
import * as THREE from 'three';
import { DIORAMA, FACE_Z, fbm, groundHeight, isClear, prng, vnoise, type KeepOut, type Mound } from './terrain.ts';
import { CHAMBERS, GALLERIES, galleryEnds, shaftPath } from './nest3d.ts';

export interface GardenOptions { mounds: Mound[]; keepOut: KeepOut; quality: 'high' | 'low'; source: { x: number; z: number } }
export interface Garden { group: THREE.Group; clipPlane: THREE.Plane; dispose(): void; extraEntrance(x: number, z: number): void; routeLine(a: { x: number; z: number }, b: { x: number; z: number }): THREE.Object3D }

const W = DIORAMA.x1 - DIORAMA.x0, D = DIORAMA.z1 - DIORAMA.z0;
const col = (h: string) => new THREE.Color(h);

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d')!, w, h);
  const t = new THREE.CanvasTexture(c); if (srgb) t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}

/** fine soil grain (tiling): crumbs, grit and tiny organic flecks */
function soilGrain(rnd: () => number): THREE.CanvasTexture {
  const t = canvasTex(512, 512, (g, w, h) => {
    g.fillStyle = '#9b7d60'; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 9000; i++) {
      const x = rnd() * w, y = rnd() * h, r = 0.6 + rnd() * rnd() * 3.2, l = rnd();
      g.fillStyle = l < 0.45 ? `rgba(58,40,26,${0.25 + rnd() * 0.4})` : l < 0.8 ? `rgba(150,118,86,${0.2 + rnd() * 0.35})` : l < 0.93 ? `rgba(196,176,150,${0.3 + rnd() * 0.4})` : `rgba(40,30,22,${0.5})`;
      g.beginPath(); g.ellipse(x, y, r, r * (0.6 + rnd() * 0.5), rnd() * 3, 0, Math.PI * 2); g.fill();
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(W / 18, D / 18); return t;
}

/** soil cross-section (the four cut faces): layered profile, stones, roots; the front face has the nest cut into it */
function profileTex(rnd: () => number, widthCm: number, front: boolean): THREE.CanvasTexture {
  const pxPerCm = front ? 6 : 3, w = Math.min(4096, Math.round(widthCm * pxPerCm)), topCm = 14, h = Math.round((topCm - DIORAMA.bottom) * pxPerCm);
  return canvasTex(w, h, (g) => {
    const yOf = (cm: number) => (topCm - cm) * pxPerCm, xOf = (xcm: number) => (xcm - DIORAMA.x0) * (w / widthCm);
    const layers: [number, string][] = [[14, '#4a3324'], [-3, '#5c3f2a'], [-14, '#7a5636'], [-28, '#94704a'], [-46, '#9a7a56']];
    for (let i = 0; i < layers.length - 1; i++) {
      const gr = g.createLinearGradient(0, yOf(layers[i][0]), 0, yOf(layers[i + 1][0])); gr.addColorStop(0, layers[i][1]); gr.addColorStop(1, layers[i + 1][1]);
      g.fillStyle = gr; g.fillRect(0, yOf(layers[i][0]), w, yOf(layers[i + 1][0]) - yOf(layers[i][0]) + 1);
    }
    for (let i = 0; i < w * h * 0.02; i++) { const x = rnd() * w, y = rnd() * h, r = 0.5 + rnd() * 1.6; g.fillStyle = rnd() < 0.5 ? 'rgba(30,20,12,0.35)' : 'rgba(200,170,130,0.25)'; g.fillRect(x, y, r, r); }
    for (let i = 0; i < widthCm * 0.9; i++) { // stones in the profile
      const x = rnd() * w, y = yOf(-4 - rnd() * 40), r = (0.4 + rnd() * rnd() * 2.6) * pxPerCm;
      g.fillStyle = ['#8d8478', '#a59a8a', '#6f675e', '#b3a58e'][Math.floor(rnd() * 4)]; g.beginPath(); g.ellipse(x, y, r, r * (0.55 + rnd() * 0.4), rnd() * 3, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.12)'; g.beginPath(); g.ellipse(x - r * 0.25, y - r * 0.25, r * 0.4, r * 0.25, 0, 0, Math.PI * 2); g.fill();
    }
    g.lineCap = 'round';
    for (let i = 0; i < widthCm * 0.12; i++) { // roots
      let x = rnd() * w, y = yOf(10); g.strokeStyle = `rgba(${170 + rnd() * 40},${130 + rnd() * 30},${90 + rnd() * 20},0.75)`;
      g.lineWidth = (0.25 + rnd() * 0.5) * pxPerCm; g.beginPath(); g.moveTo(x, y);
      const n = 6 + Math.floor(rnd() * 10); for (let k = 0; k < n; k++) { x += (rnd() - 0.5) * 4 * pxPerCm; y += (1 + rnd() * 3) * pxPerCm; g.lineTo(x, y); g.lineWidth *= 0.85; }
      g.stroke();
    }
    if (!front) return;
    // nest: carve (alpha 0) the chambers, galleries and shaft where the 3-D cavities sit behind the face
    g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; g.strokeStyle = '#000';
    for (const c of CHAMBERS) { g.beginPath(); g.ellipse(xOf(c.x), yOf(c.y), c.rx * pxPerCm, c.ry * pxPerCm, 0, 0, Math.PI * 2); g.fill(); }
    const ch = (k: string) => CHAMBERS.find((c) => c.key === k)!;
    g.lineWidth = 2.2 * pxPerCm;
    for (const [a, b] of GALLERIES) { const [p, q] = galleryEnds(ch(a), ch(b)); g.beginPath(); g.moveTo(xOf(p.x), yOf(p.y)); g.lineTo(xOf(q.x), yOf(q.y)); g.stroke(); }
    const sp = shaftPath(0).slice(2, 4); g.beginPath(); g.moveTo(xOf(sp[0].x), yOf(sp[0].y)); for (const p of sp.slice(1)) g.lineTo(xOf(p.x), yOf(p.y)); g.stroke();
    g.globalCompositeOperation = 'source-over';
    // darker rim around the carved openings
    g.strokeStyle = 'rgba(30,18,10,0.55)'; g.lineWidth = 0.5 * pxPerCm;
    for (const c of CHAMBERS) { g.beginPath(); g.ellipse(xOf(c.x), yOf(c.y), c.rx * pxPerCm + 2, c.ry * pxPerCm + 2, 0, 0, Math.PI * 2); g.stroke(); }
  });
}

/** strip geometry for a vertical cut face along the diorama edge (top follows the ground height) */
function faceGeometry(points: { x: number; z: number }[], mounds: readonly Mound[], uvX: (p: { x: number; z: number }, i: number) => number, topCm = 14): THREE.BufferGeometry {
  const pos: number[] = [], uv: number[] = [], idx: number[] = [], vMax = topCm - DIORAMA.bottom;
  points.forEach((p, i) => {
    const top = groundHeight(p.x, p.z, mounds);
    pos.push(p.x, top, p.z, p.x, DIORAMA.bottom, p.z);
    const u = uvX(p, i); uv.push(u, (top - DIORAMA.bottom) / vMax, u, 0);
    if (i > 0) { const a = (i - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx); g.computeVertexNormals();
  return g;
}

/** a leaf: tapered blade with a slight curl and a raised midrib (shared by litter and herbs) */
function leafGeometry(): THREE.BufferGeometry {
  const NU = 9, NV = 4, pos: number[] = [], uv: number[] = [], idx: number[] = [], colr: number[] = [];
  for (let i = 0; i <= NU; i++) {
    const u = i / NU, half = Math.pow(Math.sin(Math.PI * Math.min(1, u * 1.02)), 0.75) * 0.5;
    for (let j = 0; j <= NV; j++) {
      const v = (j / NV) * 2 - 1, y = 0.1 * v * v + 0.06 * (u - 0.5) ** 2 * 4 - (Math.abs(v) < 0.3 ? 0.02 : 0);
      pos.push(u - 0.5, y, v * half); uv.push(u, j / NV);
      const vein = Math.abs(v) < 0.26 ? 1.18 : 1; colr.push(vein, vein, vein);
    }
  }
  for (let i = 0; i < NU; i++) for (let j = 0; j < NV; j++) { const a = i * (NV + 1) + j, b = a + NV + 1; idx.push(a, b, a + 1, b, b + 1, a + 1); }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3));
  g.setIndex(idx); g.computeVertexNormals(); return g;
}

/** a grass blade: tapered strip, bent forward */
function bladeGeometry(): THREE.BufferGeometry {
  const N = 5, pos: number[] = [], idx: number[] = [], colr: number[] = [];
  for (let i = 0; i <= N; i++) {
    const u = i / N, w = 0.5 * (1 - u) ** 0.9, bend = 0.28 * u * u;
    pos.push(-w, u, bend, w, u, bend); const c = 0.55 + 0.45 * u; colr.push(c, c, c, c, c, c);
    if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(colr, 3)); g.setIndex(idx); g.computeVertexNormals(); return g;
}

function stoneGeometry(rnd: () => number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(1, 3), p = g.attributes.position as THREE.BufferAttribute, s = rnd() * 100;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i), n = 1 + 0.32 * fbm(x * 1.4 + s, z * 1.4 + y * 0.7, 3, 7) + 0.06 * (vnoise(x * 6 + s, y * 6 + z * 6, 3) - 0.5);
    p.setXYZ(i, x * n, y * n * 0.62, z * n);
  }
  g.computeVertexNormals(); return g;
}

export function buildGarden(o: GardenOptions): Garden {
  const rnd = prng(20261114), group = new THREE.Group(), disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => { disposables.push(x); return x; };
  const hi = o.quality === 'high', h = (x: number, z: number) => groundHeight(x, z, o.mounds);
  const clipPlane = new THREE.Plane(new THREE.Vector3(0, 0, -1), FACE_Z - 0.02); // keeps z < FACE_Z

  // ground top
  const seg = hi ? 1.6 : 3;
  const gg = keep(new THREE.PlaneGeometry(W, D, Math.round(W / seg), Math.round(D / seg)));
  gg.rotateX(-Math.PI / 2); gg.translate((DIORAMA.x0 + DIORAMA.x1) / 2, 0, (DIORAMA.z0 + DIORAMA.z1) / 2);
  { const p = gg.attributes.position as THREE.BufferAttribute, c = new Float32Array(p.count * 3), base = col('#ffffff');
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), y = h(x, z); p.setY(i, y);
      const damp = vnoise(x * 0.02, z * 0.02, 41), dry = vnoise(x * 0.06, z * 0.06, 43), near = Math.hypot(x, z);
      const k = 0.82 + 0.25 * dry - 0.22 * damp + (near < 6 ? 0.12 * (1 - near / 6) : 0);
      base.setRGB(k * 1.0, k * 0.96, k * 0.9); c.set([base.r, base.g, base.b], i * 3);
    }
    gg.setAttribute('color', new THREE.BufferAttribute(c, 3)); gg.computeVertexNormals(); }
  const grain = keep(soilGrain(rnd));
  const groundMat = keep(new THREE.MeshStandardMaterial({ map: grain, bumpMap: grain, bumpScale: 0.35, roughness: 0.97, vertexColors: true, color: col('#cdb293'), side: THREE.DoubleSide }));
  const ground = new THREE.Mesh(gg, groundMat); ground.receiveShadow = true; ground.castShadow = hi; group.add(ground);

  // cut faces (front carries the nest)
  const n = (a: number, b: number, step: number) => { const r: number[] = []; for (let v = a; v <= b + 1e-6; v += step) r.push(Math.min(b, v)); return r; };
  const fx = n(DIORAMA.x0, DIORAMA.x1, 2), fz = n(DIORAMA.z0, DIORAMA.z1, 2);
  const frontTex = keep(profileTex(rnd, W, true)), sideTex = keep(profileTex(rnd, Math.max(W, D), false));
  const faceMat = (t: THREE.Texture, alpha: boolean) => keep(new THREE.MeshStandardMaterial({ map: t, roughness: 1, alphaTest: alpha ? 0.5 : 0, side: THREE.DoubleSide }));
  const front = new THREE.Mesh(keep(faceGeometry(fx.map((x) => ({ x, z: FACE_Z })), o.mounds, (p) => (p.x - DIORAMA.x0) / W)), faceMat(frontTex, true));
  const back = new THREE.Mesh(keep(faceGeometry(fx.map((x) => ({ x, z: DIORAMA.z0 })), o.mounds, (p) => (p.x - DIORAMA.x0) / Math.max(W, D))), faceMat(sideTex, false));
  const left = new THREE.Mesh(keep(faceGeometry(fz.map((z) => ({ x: DIORAMA.x0, z })), o.mounds, (p) => (p.z - DIORAMA.z0) / Math.max(W, D))), faceMat(sideTex, false));
  const right = new THREE.Mesh(keep(faceGeometry(fz.map((z) => ({ x: DIORAMA.x1, z })), o.mounds, (p) => (p.z - DIORAMA.z0) / Math.max(W, D))), faceMat(sideTex, false));
  for (const m of [front, back, left, right]) { m.receiveShadow = true; group.add(m); }
  const bottom = new THREE.Mesh(keep(new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2).translate((DIORAMA.x0 + DIORAMA.x1) / 2, DIORAMA.bottom, (DIORAMA.z0 + DIORAMA.z1) / 2)), keep(new THREE.MeshStandardMaterial({ color: col('#3b2a1c') })));
  group.add(bottom);
  // dark backing inside the block behind the nest, so a gap in the carved face never shows the sky
  const backing = new THREE.Mesh(keep(new THREE.PlaneGeometry(W, -4 - DIORAMA.bottom).translate((DIORAMA.x0 + DIORAMA.x1) / 2, (DIORAMA.bottom - 4) / 2, FACE_Z - 11)), keep(new THREE.MeshBasicMaterial({ color: col('#24170e'), side: THREE.DoubleSide })));
  group.add(backing);

  // nest cavities behind the front face (BackSide, clipped at the face): schematic chambers by engine-state group
  const cavMat = keep(new THREE.MeshStandardMaterial({ color: col('#b08a66'), emissive: col('#2a1a0e'), roughness: 1, side: THREE.BackSide, clippingPlanes: [clipPlane], map: grain }));
  for (const c of CHAMBERS) { const m = new THREE.Mesh(keep(new THREE.SphereGeometry(1, 32, 16).scale(c.rx, c.ry, c.rz).translate(c.x, c.y, FACE_Z)), cavMat); m.receiveShadow = false; group.add(m); }
  // galleries read as carved grooves: darker and unlit-looking (a lit tube interior reads as a pipe)
  const galMat = keep(new THREE.MeshStandardMaterial({ color: col('#3a271a'), roughness: 1, side: THREE.BackSide, clippingPlanes: [clipPlane] }));
  const tube = (a: THREE.Vector3, b: THREE.Vector3, r: number, mat: THREE.Material) => {
    const d = b.clone().sub(a), len = d.length(), g = keep(new THREE.CylinderGeometry(r, r, len, 12, 1, true).translate(0, len / 2, 0));
    g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize())); g.translate(a.x, a.y, a.z);
    group.add(new THREE.Mesh(g, mat));
  };
  const ck = (k: string) => CHAMBERS.find((c) => c.key === k)!;
  for (const [a, b] of GALLERIES) { const [p, q] = galleryEnds(ck(a), ck(b)); tube(new THREE.Vector3(p.x, p.y, FACE_Z - 0.1), new THREE.Vector3(q.x, q.y, FACE_Z - 0.1), 1.1, galMat); }
  const sp = shaftPath(h(0, 0)).slice(0, 4); for (let i = 1; i < sp.length; i++) tube(new THREE.Vector3(sp[i - 1].x, sp[i - 1].y, sp[i - 1].z), new THREE.Vector3(sp[i].x, sp[i].y, sp[i].z), 0.75, galMat);

  // entrance: dark hole + excavated granules (lighter subsoil brought up)
  const holeMat = keep(new THREE.MeshBasicMaterial({ color: col('#140c07') }));
  const addEntrance = (x: number, z: number, granules: number) => {
    const y = h(x, z), hole = new THREE.Mesh(keep(new THREE.CircleGeometry(0.62, 20).rotateX(-Math.PI / 2)), holeMat); hole.position.set(x, y + 0.04, z); group.add(hole);
    const gm = new THREE.InstancedMesh(keep(new THREE.IcosahedronGeometry(1, 1)), keep(new THREE.MeshStandardMaterial({ roughness: 1, color: col('#ffffff') })), granules);
    const M = new THREE.Matrix4(), c = new THREE.Color();
    for (let i = 0; i < granules; i++) {
      const a = rnd() * Math.PI * 2, r = 0.8 + Math.pow(rnd(), 0.7) * 4.2, gx = x + Math.cos(a) * r, gz = z + Math.sin(a) * r, s = 0.07 + rnd() * 0.17;
      M.compose(new THREE.Vector3(gx, h(gx, gz) + s * 0.4, gz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 3, rnd() * 3, 0)), new THREE.Vector3(s, s * 0.8, s));
      gm.setMatrixAt(i, M); c.setHSL(0.07 + rnd() * 0.03, 0.28 + rnd() * 0.12, 0.2 + rnd() * 0.12); gm.setColorAt(i, c);
    }
    gm.castShadow = hi; gm.receiveShadow = true; group.add(gm);
  };
  addEntrance(0, 0, hi ? 700 : 300);

  // scenery placement helper: inside the diorama, clear of the route / entrance
  const spot = (margin: number): { x: number; z: number } | null => {
    for (let k = 0; k < 40; k++) { const x = DIORAMA.x0 + margin + rnd() * (W - 2 * margin), z = DIORAMA.z0 + margin + rnd() * (D - 2 * margin); if (isClear(x, z, o.keepOut)) return { x, z }; }
    return null;
  };

  // leaf litter
  const leafG = keep(leafGeometry()), litterMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, side: THREE.DoubleSide }));
  const NL = hi ? 900 : 380, litter = new THREE.InstancedMesh(leafG, litterMat, NL), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), E = new THREE.Euler(), C = new THREE.Color();
  let nl = 0;
  for (let i = 0; i < NL * 2 && nl < NL; i++) {
    const p = spot(3); if (!p) continue;
    if (vnoise(p.x * 0.025, p.z * 0.025, 51) < 0.42 && rnd() < 0.7) continue; // patchy drifts
    const L = 2.2 + rnd() * rnd() * 7.5, y = h(p.x, p.z) + 0.08 + rnd() * 0.25;
    E.set((rnd() - 0.5) * 0.35, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.35); Q.setFromEuler(E);
    M.compose(new THREE.Vector3(p.x, y, p.z), Q, new THREE.Vector3(L, L * (0.5 + rnd() * 0.6), L * (0.35 + rnd() * 0.3)));
    litter.setMatrixAt(nl, M);
    const r = rnd(); if (r < 0.55) C.setHSL(0.06 + rnd() * 0.04, 0.42 + rnd() * 0.2, 0.18 + rnd() * 0.12); else if (r < 0.85) C.setHSL(0.09 + rnd() * 0.03, 0.45, 0.3 + rnd() * 0.1); else C.setHSL(0.18 + rnd() * 0.08, 0.32, 0.22 + rnd() * 0.08);
    litter.setColorAt(nl, C); nl++;
  }
  litter.count = nl; litter.castShadow = hi; litter.receiveShadow = true; group.add(litter);

  // grass clumps
  const bladeG = keep(bladeGeometry()), grassMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, side: THREE.DoubleSide }));
  const NG = hi ? 5200 : 1800, grass = new THREE.InstancedMesh(bladeG, grassMat, NG); let ng = 0;
  const clumps = hi ? 170 : 80;
  for (let k = 0; k < clumps && ng < NG; k++) {
    const p = spot(4); if (!p) continue;
    const per = Math.min(NG - ng, 14 + Math.floor(rnd() * 34)), rad = 1.5 + rnd() * 5, tall = 5 + rnd() * 13;
    for (let i = 0; i < per; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * rad, x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
      if (!isClear(x, z, o.keepOut)) continue;
      E.set((rnd() - 0.5) * 0.5, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.5); Q.setFromEuler(E);
      const hh = tall * (0.5 + rnd() * 0.6); M.compose(new THREE.Vector3(x, h(x, z) - 0.2, z), Q, new THREE.Vector3(0.25 + rnd() * 0.2, hh, hh * 0.9));
      grass.setMatrixAt(ng, M); C.setHSL(0.22 + rnd() * 0.07, 0.42 + rnd() * 0.2, 0.26 + rnd() * 0.14); grass.setColorAt(ng, C); ng++;
    }
  }
  grass.count = ng; grass.castShadow = hi; grass.receiveShadow = true; group.add(grass);

  // stones and pebbles
  const stoneMat = keep(new THREE.MeshStandardMaterial({ roughness: 0.85, color: col('#ffffff'), vertexColors: false }));
  const stoneGeos = Array.from({ length: 6 }, () => keep(stoneGeometry(rnd)));
  for (let i = 0; i < (hi ? 46 : 24); i++) {
    const p = spot(8); if (!p) continue;
    const s = 1.6 + rnd() * rnd() * 11, m = new THREE.Mesh(stoneGeos[i % stoneGeos.length], stoneMat.clone()); keep(m.material as THREE.Material);
    (m.material as THREE.MeshStandardMaterial).color.setHSL(0.07 + rnd() * 0.06, 0.06 + rnd() * 0.1, 0.24 + rnd() * 0.2);
    m.scale.set(s * (0.8 + rnd() * 0.5), s, s * (0.7 + rnd() * 0.5)); m.rotation.y = rnd() * Math.PI * 2;
    m.position.set(p.x, h(p.x, p.z) + s * 0.15, p.z); m.castShadow = true; m.receiveShadow = true; group.add(m);
  }
  const NP = hi ? 1600 : 600, pebbles = new THREE.InstancedMesh(keep(new THREE.IcosahedronGeometry(1, 1)), keep(new THREE.MeshStandardMaterial({ roughness: 0.9 })), NP); let np = 0;
  for (let i = 0; i < NP; i++) {
    const p = spot(1); if (!p) continue;
    const s = 0.12 + rnd() * rnd() * 0.75; E.set(rnd() * 3, rnd() * 3, rnd() * 3); Q.setFromEuler(E);
    M.compose(new THREE.Vector3(p.x, h(p.x, p.z) + s * 0.3, p.z), Q, new THREE.Vector3(s, s * 0.7, s * (0.8 + rnd() * 0.4)));
    pebbles.setMatrixAt(np, M); C.setHSL(0.07 + rnd() * 0.06, 0.08 + rnd() * 0.14, 0.22 + rnd() * 0.24); pebbles.setColorAt(np, C); np++;
  }
  pebbles.count = np; pebbles.castShadow = hi; pebbles.receiveShadow = true; group.add(pebbles);

  // twigs
  const twigMat = keep(new THREE.MeshStandardMaterial({ color: col('#5b4030'), roughness: 0.95 }));
  for (let i = 0; i < (hi ? 46 : 20); i++) {
    const p = spot(10); if (!p) continue;
    const L = 5 + rnd() * 22, r = 0.12 + rnd() * 0.3, t = new THREE.Mesh(keep(new THREE.CylinderGeometry(r * 0.7, r, L, 6).rotateZ(Math.PI / 2)), twigMat);
    t.position.set(p.x, h(p.x, p.z) + r * 0.8, p.z); t.rotation.y = rnd() * Math.PI * 2; t.rotation.z = (rnd() - 0.5) * 0.1; t.castShadow = true; t.receiveShadow = true; group.add(t);
  }

  // herbs (stem + leaves); the plant at the honeydew source carries a schematic aphid colony
  const stemMat = keep(new THREE.MeshStandardMaterial({ color: col('#5d7a34'), roughness: 0.7 })), herbLeafMat = keep(new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: THREE.DoubleSide }));
  const herb = (x: number, z: number, height: number, leaves: number, lean: number) => {
    const y0 = h(x, z), curve = new THREE.CatmullRomCurve3([new THREE.Vector3(x, y0 - 0.5, z), new THREE.Vector3(x + lean * 0.3, y0 + height * 0.45, z + lean * 0.1), new THREE.Vector3(x + lean, y0 + height, z + lean * 0.3)]);
    group.add(Object.assign(new THREE.Mesh(keep(new THREE.TubeGeometry(curve, 16, Math.max(0.18, height * 0.012), 6, false)), stemMat), { castShadow: true }));
    const lm = new THREE.InstancedMesh(leafG, herbLeafMat, leaves);
    for (let i = 0; i < leaves; i++) {
      const u = 0.25 + (i / leaves) * 0.75, p = curve.getPoint(u), L = height * (0.22 + rnd() * 0.18) * (1.1 - u * 0.5), a = rnd() * Math.PI * 2;
      E.set(0, a, -0.35 - rnd() * 0.5); Q.setFromEuler(E);
      const off = new THREE.Vector3(L * 0.5, 0, 0).applyQuaternion(Q);
      M.compose(p.clone().add(off), Q, new THREE.Vector3(L, L * 0.6, L * 0.45)); lm.setMatrixAt(i, M); C.setHSL(0.24 + rnd() * 0.06, 0.45 + rnd() * 0.15, 0.3 + rnd() * 0.12); lm.setColorAt(i, C);
    }
    lm.castShadow = true; lm.receiveShadow = true; group.add(lm);
    return curve;
  };
  for (let i = 0; i < (hi ? 14 : 7); i++) { const p = spot(15); if (p) herb(p.x, p.z, 10 + rnd() * 26, 6 + Math.floor(rnd() * 9), (rnd() - 0.5) * 6); }
  const sc = herb(o.source.x + 9, o.source.z - 6, 34, 14, -3);
  const aphidMat = keep(new THREE.MeshStandardMaterial({ color: col('#9fbf5a'), roughness: 0.5 })), aphids = new THREE.InstancedMesh(keep(new THREE.SphereGeometry(1, 10, 8)), aphidMat, 26);
  for (let i = 0; i < 26; i++) { const p = sc.getPoint(0.04 + rnd() * 0.22), a = rnd() * Math.PI * 2; M.compose(p.add(new THREE.Vector3(Math.cos(a) * 0.45, 0, Math.sin(a) * 0.45)), new THREE.Quaternion(), new THREE.Vector3(0.11, 0.08, 0.07)); aphids.setMatrixAt(i, M); }
  group.add(aphids);

  return {
    group, clipPlane,
    dispose: () => { for (const d of disposables) d.dispose(); },
    extraEntrance: (x, z) => addEntrance(x, z, 120),
    routeLine: (a, b) => {
      const pts: THREE.Vector3[] = []; for (let i = 0; i <= 80; i++) { const k = i / 80, x = a.x + (b.x - a.x) * k, z = a.z + (b.z - a.z) * k; pts.push(new THREE.Vector3(x, h(x, z) + 0.15, z)); }
      const line = new THREE.Line(keep(new THREE.BufferGeometry().setFromPoints(pts)), keep(new THREE.LineDashedMaterial({ color: 0xf6e3a0, dashSize: 2, gapSize: 2.5, transparent: true, opacity: 0.75 })));
      line.computeLineDistances(); return line;
    },
  };
}
