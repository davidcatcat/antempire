// Issue #102 step 1 — standalone draw benchmark. NOT wired into web/, imports nothing from engine/, cli/ or web/.
// Draws N synthetic "drawing sprites" shaped like the viewer's ant marks (web/src/main.ts draw()): ellipse body,
// optional muted ring (like the interpolation ring), one selected mark with label + dashed ring, over a static
// background of ~15 places and links. The sprites are NOT ants and NOT simulation data: their paths are a
// deterministic seeded function of the frame number only (no Math.random, no engine, no saves).
import { Application, Container, Graphics, Sprite, Text } from 'pixi.js';

const q = new URLSearchParams(location.search);
const RENDERER = q.get('renderer') === 'pixi' ? 'pixi' : 'canvas'; // Canvas 2D stays the default / fallback
const N = Math.max(1, Math.min(100000, Number(q.get('n')) || 100));
const SEED = Number(q.get('seed')) || 102;

// colours = the viewer's token fallbacks
const C = { ground: '#e9e2cf', ink: '#2f2a22', link: '#b9ad8f', muted: '#8c8270', ant: '#1d1d1d', sel: '#d62828', place: '#9a917d', nest: '#a0522d' };

// tiny seeded PRNG (mulberry32)
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(SEED);

// --- static synthetic background: 15 places (unit square), 15 links (spanning tree + extras) — layout only, not the garden ---
const nodes = [];
for (let i = 0; i < 15; i++) nodes.push({ id: i === 0 ? 'N0' : `P${i}`, x: i === 0 ? 0.5 : 0.08 + 0.84 * rnd(), y: i === 0 ? 0.5 : 0.08 + 0.84 * rnd() });
const links = [];
for (let i = 1; i < 15; i++) links.push([Math.floor(rnd() * i), i]);
links.push([3, 11]);
// --- sprite paths: each sprite ping-pongs along one link with a fixed perpendicular offset ---
const sp = new Float32Array(N * 4); // link, phase, speed (per frame), offset
for (let i = 0; i < N; i++) { sp[i * 4] = Math.floor(rnd() * links.length); sp[i * 4 + 1] = rnd() * 2; sp[i * 4 + 2] = 0.002 + 0.006 * rnd(); sp[i * 4 + 3] = (rnd() - 0.5) * 0.03; }
const RING_EVERY = 8; // every 8th sprite carries a ring (like the viewer's interpolation ring)
const pos = new Float32Array(N * 2);
function update(frame, W, H, ox, oy) {
  for (let i = 0; i < N; i++) {
    const [a, b] = links[sp[i * 4]], A = nodes[a], B = nodes[b];
    let t = (sp[i * 4 + 1] + sp[i * 4 + 2] * frame) % 2; if (t > 1) t = 2 - t;
    const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, o = sp[i * 4 + 3];
    pos[i * 2] = ox + (A.x + dx * t - (dy / len) * o) * W;
    pos[i * 2 + 1] = oy + (A.y + dy * t + (dx / len) * o) * H;
  }
}

// --- measurement hooks read by bench.cjs (observation of this page only) ---
const bench = (window.__bench = { renderer: RENDERER, n: N, ready: false, rec: false, frames: [], cpu: [], gl: probeGL(), pixiRenderer: null, error: null });
function probeGL() {
  try {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl');
    if (!gl) return { available: false };
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return { available: true, version: gl.getParameter(gl.VERSION), vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR), renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
  } catch (e) { return { available: false, error: String(e) }; }
}

const stage = document.getElementById('stage');
for (const [id, v] of [['renderer', RENDERER], ['n', String(N)]]) {
  const el = document.getElementById(id); el.value = v;
  el.onchange = () => { const p = new URLSearchParams(location.search); p.set(id, el.value); location.search = p.toString(); };
}
const hud = document.getElementById('hud');
let frame = 0, last = 0, hudAcc = [];
function tick(ts, renderFn) {
  const t0 = performance.now();
  renderFn();
  const t1 = performance.now();
  if (bench.rec) { bench.frames.push(ts); bench.cpu.push(t1 - t0); }
  if (last) { hudAcc.push(ts - last); if (hudAcc.length >= 30) { const m = hudAcc.reduce((s, x) => s + x, 0) / hudAcc.length; hud.textContent = `${RENDERER} · N=${N} · ${(1000 / m).toFixed(1)} FPS（平均 ${m.toFixed(1)} ms）`; hudAcc = []; } }
  last = ts; frame++;
}

function runCanvas() {
  const canvas = document.createElement('canvas'); stage.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  const size = () => { const dpr = devicePixelRatio || 1; canvas.width = Math.round(stage.clientWidth * dpr); canvas.height = Math.round(stage.clientHeight * dpr); };
  size(); addEventListener('resize', size);
  function render() {
    const W = canvas.width, H = canvas.height, dpr = devicePixelRatio || 1;
    ctx.fillStyle = C.ground; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = C.link; ctx.lineWidth = 1.5 * dpr;
    for (const [a, b] of links) { ctx.beginPath(); ctx.moveTo(nodes[a].x * W, nodes[a].y * H); ctx.lineTo(nodes[b].x * W, nodes[b].y * H); ctx.stroke(); }
    for (const p of nodes) {
      const r = (p.id === 'N0' ? 9 : 7) * dpr; ctx.fillStyle = p.id === 'N0' ? C.nest : C.place;
      ctx.beginPath(); ctx.arc(p.x * W, p.y * H, r, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = C.ink; ctx.font = `${12 * dpr}px system-ui`; ctx.fillText(p.id, p.x * W + r + 3 * dpr, p.y * H - 6 * dpr);
    }
    update(frame, W, H, 0, 0);
    for (let i = 0; i < N; i++) {
      const x = pos[i * 2], y = pos[i * 2 + 1], sel = i === 0;
      ctx.fillStyle = sel ? C.sel : C.ant;
      ctx.beginPath(); ctx.ellipse(x, y, (sel ? 5 : 3.5) * dpr, (sel ? 3.2 : 2.3) * dpr, 0, 0, Math.PI * 2); ctx.fill();
      if (i % RING_EVERY === 1) { ctx.strokeStyle = C.muted; ctx.lineWidth = 1 * dpr; ctx.beginPath(); ctx.arc(x, y, 6 * dpr, 0, Math.PI * 2); ctx.stroke(); }
      if (sel) {
        ctx.fillStyle = C.sel; ctx.font = `bold ${12 * dpr}px system-ui`; ctx.fillText('S0（精靈）', x + 7 * dpr, y + 4 * dpr);
        ctx.strokeStyle = C.sel; ctx.lineWidth = 1.5 * dpr; ctx.setLineDash([4 * dpr, 3 * dpr]); ctx.beginPath(); ctx.arc(x, y, 11 * dpr, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
      }
    }
  }
  const loop = (ts) => { tick(ts, render); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  bench.ready = true;
}

// PixiJS: Sprites sharing two textures generated once from Graphics (body ellipse, ring); one Container; static
// background drawn once into a Graphics + Text labels; the selected mark is a live Graphics + Text.
async function runPixi() {
  const app = new Application();
  await app.init({ resizeTo: stage, background: C.ground, antialias: true, resolution: devicePixelRatio || 1, autoDensity: true, preference: 'webgl' });
  stage.appendChild(app.canvas);
  bench.pixiRenderer = { name: app.renderer.name, type: app.renderer.type };
  if (app.renderer.gl) { const gl = app.renderer.gl, ext = gl.getExtension('WEBGL_debug_renderer_info'); bench.pixiRenderer.gl = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); }
  app.ticker.stop(); // we drive rendering from our own rAF loop so both renderers are timed the same way
  const res = devicePixelRatio || 1;
  const bodyTex = app.renderer.generateTexture({ target: new Graphics().ellipse(0, 0, 3.5, 2.3).fill(C.ant), resolution: res });
  const ringTex = app.renderer.generateTexture({ target: new Graphics().circle(0, 0, 6).stroke({ width: 1, color: C.muted }), resolution: res });
  const bg = new Graphics(); app.stage.addChild(bg);
  const labels = new Container(); app.stage.addChild(labels);
  const layer = new Container(); app.stage.addChild(layer);
  const bodies = [], rings = [];
  for (let i = 0; i < N; i++) {
    if (i % RING_EVERY === 1) { const r = new Sprite(ringTex); r.anchor.set(0.5); layer.addChild(r); rings[i] = r; }
    if (i === 0) continue;
    const s = new Sprite(bodyTex); s.anchor.set(0.5); layer.addChild(s); bodies[i] = s;
  }
  const selG = new Graphics(), selT = new Text({ text: 'S0（精靈）', style: { fontFamily: 'system-ui', fontSize: 12, fontWeight: 'bold', fill: C.sel } });
  app.stage.addChild(selG, selT);
  let bgW = -1, bgH = -1;
  function drawBg(W, H) {
    bg.clear();
    for (const [a, b] of links) bg.moveTo(nodes[a].x * W, nodes[a].y * H).lineTo(nodes[b].x * W, nodes[b].y * H);
    bg.stroke({ width: 1.5, color: C.link });
    for (const p of nodes) bg.circle(p.x * W, p.y * H, p.id === 'N0' ? 9 : 7).fill(p.id === 'N0' ? C.nest : C.place);
    labels.removeChildren().forEach((c) => c.destroy());
    for (const p of nodes) { const t = new Text({ text: p.id, style: { fontFamily: 'system-ui', fontSize: 12, fill: C.ink } }); t.position.set(p.x * W + (p.id === 'N0' ? 9 : 7) + 3, p.y * H - 6 - 12); labels.addChild(t); }
    bgW = W; bgH = H;
  }
  function render() {
    const W = app.screen.width, H = app.screen.height;
    if (W !== bgW || H !== bgH) drawBg(W, H);
    update(frame, W, H, 0, 0);
    for (let i = 1; i < N; i++) bodies[i].position.set(pos[i * 2], pos[i * 2 + 1]);
    for (let i = 1; i < N; i += RING_EVERY) rings[i].position.set(pos[i * 2], pos[i * 2 + 1]);
    const x = pos[0], y = pos[1];
    selG.clear().ellipse(x, y, 5, 3.2).fill(C.sel);
    // dashed ring approximated with 16 arc segments (Pixi v8 Graphics has no setLineDash)
    for (let k = 0; k < 16; k++) { const a0 = (k / 16) * Math.PI * 2; selG.moveTo(x + 11 * Math.cos(a0), y + 11 * Math.sin(a0)).arc(x, y, 11, a0, a0 + (Math.PI * 2) / 16 * 0.57); }
    selG.stroke({ width: 1.5, color: C.sel });
    selT.position.set(x + 7, y + 4 - 12);
    app.renderer.render(app.stage);
  }
  const loop = (ts) => { tick(ts, render); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  bench.ready = true;
}

(RENDERER === 'pixi' ? runPixi() : Promise.resolve(runCanvas())).catch((e) => { bench.error = String(e && e.stack || e); hud.textContent = `PixiJS 初始化失敗：${e}；請改用 Canvas 2D（預設）`; });
