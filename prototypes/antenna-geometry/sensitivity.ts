/**
 * ANTENNA-GEO sensitivity analysis (Owner decision 37): antenna length, angle and number of sampling points.
 * Shows the effect on SENSOR POSITIONS and on CONTACT DETECTION only. It does not fit or score any trail-following
 * result (no R133), and no value is chosen from it. Prints the markdown tables of docs/antenna-geometry.md §6
 * (tests/antenna-geometry.test.ts checks that the document contains them verbatim).
 *   node prototypes/antenna-geometry/sensitivity.ts
 */
import { candidateModel, candidateBody, scenarios, type Scenario } from './lib.ts';
import { antennaInWorld, scanJoints, sensingRequests, detectAntennaContacts, antennaSamplePoints, contactKindOf, SIDES, type AntennaModel, type AntennaContactEvent } from '../../engine/physics/antenna-geometry.ts';
import { capsuleAt, dimsOf, staticCaps, capGap, poseAt, type Cap } from '../../engine/physics/kinematics2d.ts';

const f3 = (x: number) => x.toFixed(3);
const ft = (x: number | null) => (x === null ? '—' : x.toFixed(4));
const POSE = { x: 0, y: 0, th: 0 };

/** sensor geometry at the scan centre (t = 0 with phase 0 → joints at the centre for the left antenna) */
function sensorRow(m: AntennaModel): string[] {
  const j = { scape_rad: m.scan.ac, elbow_rad: m.scan.bc };
  const L = antennaInWorld(POSE, m, 'left', j).tip, R = antennaInWorld(POSE, m, 'right', j).tip;
  const body = candidateBody(), fr = (body.length_mm as number) / 2;
  const len = Math.hypot(L.x - fr, L.y), half = Math.atan2(L.y, L.x - fr);
  // lateral sweep of the left tip over one scanning period (scan model, body at rest)
  let lo = Infinity, hi = -Infinity;
  const T = m.scan.f > 0 ? 1 / m.scan.f : 0;
  for (let i = 0; i <= 400; i++) { const y = antennaInWorld(POSE, m, 'left', scanJoints(m, 'left', (T * i) / 400)).tip.y; lo = Math.min(lo, y); hi = Math.max(hi, y); }
  return [`(${f3(L.x)}, ${f3(L.y)})`, f3(L.y - R.y), `${f3(lo)}–${f3(hi)}`, f3(len), f3(half)];
}
interface ContactSummary { wall: number | null; post: number; head_on_antenna: number | null; head_on_body: number | null; pass_by: number | null }
const first = (ev: AntennaContactEvent[], pred: (e: AntennaContactEvent) => boolean) => { const e = ev.find((x) => x.phase === 'start' && pred(x)); return e ? e.t_s : null; };
function contactSummary(m: AntennaModel): ContactSummary {
  const sc = Object.fromEntries(scenarios(m).map((s) => [s.name, s])) as Record<string, Scenario>;
  const ev = (n: string) => detectAntennaContacts(sc[n].input).events;
  const h = sc.head_on, hev = ev('head_on');
  const geo = h.kin.events.find((e) => contactKindOf(e) === 'geometric_contact');
  return {
    wall: first(ev('wall_approach'), () => true),
    post: ev('post_pass').filter((e) => e.phase === 'start').length,
    head_on_antenna: first(hev, () => true),
    head_on_body: geo ? geo.t_s : null,
    pass_by: first(ev('pass_by'), () => true),
  };
}
function contactRow(m: AntennaModel): string[] {
  const c = contactSummary(m);
  return [ft(c.wall), String(c.post), ft(c.head_on_antenna), c.head_on_antenna !== null && c.head_on_body !== null ? f3(c.head_on_body - c.head_on_antenna) : '—', ft(c.pass_by)];
}
const table = (head: string[], rows: string[][]) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.join(' | ')} |`)].join('\n');
const HEAD_SENS = ['左尖端（擺動中心，身體座標，mm）', '兩尖端側向距離 (mm)', '左尖端擺動一週的側向範圍 y (mm)', '感測契約等效長度 (mm)', '等效半角 (rad)'];
const HEAD_CONT = ['撞牆：首次觸角接觸 (s)', '柱子：接觸次數', '對向：首次觸角接觸 (s)', '對向：早於身體接觸 (s)', '經過靜止個體：首次觸角接觸 (s)'];

// ---------------------------------------------------------------- point-sampled detection (diagnostic comparison only)
/** contact by n sample points (each a disc of the antenna radius) on a fixed time grid; first-contact time per pair */
function sampledFirst(s: Scenario, n: number, dt: number): Map<string, number> {
  const out = new Map<string, number>(), inp = s.input;
  for (const a of inp.agents) for (const side of SIDES) {
    const targets: { key: string; caps: (t: number) => Cap[] }[] = [];
    for (const st of inp.statics) targets.push({ key: `${a.id}:${side}|static:${st.id}`, caps: () => staticCaps(st) });
    for (const b of inp.agents) if (b.id !== a.id) {
      targets.push({ key: `${a.id}:${side}|body:${b.id}`, caps: (t) => [capsuleAt(poseAt(b.track, t), dimsOf(b.track.body, b.id))] });
      if (a.id < b.id) for (const s2 of SIDES) targets.push({ key: `${a.id}:${side}|antenna:${b.id}:${s2}`, caps: (t) => { const w = antennaInWorld(poseAt(b.track, t), b.model, s2, scanJoints(b.model, s2, t)); return [{ a: w.base, b: w.elbow, r: b.model.r }, { a: w.elbow, b: w.tip, r: b.model.r }]; } });
    }
    for (const tg of targets) {
      for (let k = 0; k * dt <= inp.horizon_s + 1e-12; k++) {
        const t = Math.min(k * dt, inp.horizon_s), pts = antennaSamplePoints(poseAt(a.track, t), a.model, side, scanJoints(a.model, side, t), n);
        const hit = pts.some((p) => tg.caps(t).some((c) => capGap({ a: p, b: p, r: a.model.r }, c).g <= 0));
        if (hit) { out.set(tg.key, t); break; }
      }
    }
  }
  return out;
}
function exactFirst(s: Scenario): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of detectAntennaContacts(s.input).events) {
    if (e.phase !== 'start') continue;
    const key = `${e.agent_id}:${e.side}|${e.target.kind}:${e.target.id}${e.target.side ? `:${e.target.side}` : ''}`;
    if (!out.has(key)) out.set(key, e.t_s);
  }
  return out;
}
/** largest distance from a point of the antenna to its nearest sample point, at the scan centre */
function coverageGap(m: AntennaModel, n: number): number {
  const j = { scape_rad: m.scan.ac, elbow_rad: m.scan.bc }, w = antennaInWorld(POSE, m, 'left', j), pts = antennaSamplePoints(POSE, m, 'left', j, n);
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const u = i / 2000, s = u * (m.Ls + m.Lf);
    const p = s <= m.Ls ? { x: w.base.x + ((w.elbow.x - w.base.x) * s) / m.Ls, y: w.base.y + ((w.elbow.y - w.base.y) * s) / m.Ls } : { x: w.elbow.x + ((w.tip.x - w.elbow.x) * (s - m.Ls)) / m.Lf, y: w.elbow.y + ((w.tip.y - w.elbow.y) * (s - m.Ls)) / m.Lf };
    worst = Math.max(worst, Math.min(...pts.map((q) => Math.hypot(q.x - p.x, q.y - p.y))));
  }
  return worst;
}

export function sensitivityTables(): string {
  const out: string[] = [];
  // 1. length
  const lenRows: string[][] = [], lenCont: string[][] = [];
  for (const SL of [0.61, 0.69, 0.73]) for (const FL of [0.5, 0.85, 1.2]) {
    const m = candidateModel({ scape_length_mm: SL, funiculus_length_mm: FL }), lab = [f3(SL), f3(FL)];
    lenRows.push([...lab, ...sensorRow(m)]); lenCont.push([...lab, ...contactRow(m)]);
  }
  out.push('### 6.1 長度（柄節 SL、鞭節 FL）：感測點位置', table(['SL (mm)', 'FL (mm)', ...HEAD_SENS], lenRows), '', '### 6.2 長度：接觸偵測', table(['SL (mm)', 'FL (mm)', ...HEAD_CONT], lenCont), '');
  // 2. angle
  const angRows: string[][] = [], angCont: string[][] = [];
  const angSets: [number, number, number][] = [[0.6, 0, -0.8], [0.6, 0.3, -0.8], [0.9, 0, -0.8], [0.9, 0.3, -0.8], [1.2, 0, -0.8], [1.2, 0.3, -0.8], [0.9, 0.3, -1.2], [0.9, 0.3, -0.4]];
  for (const [ac, aa, bc] of angSets) {
    const m = candidateModel({ scan_scape_centre_rad: ac, scan_scape_amplitude_rad: aa, scan_elbow_centre_rad: bc }), lab = [f3(ac), f3(aa), f3(bc)];
    angRows.push([...lab, ...sensorRow(m)]); angCont.push([...lab, ...contactRow(m)]);
  }
  out.push('### 6.3 角度（柄節中心角 αc、擺幅 Aα、肘角 βc）：感測點位置', table(['αc (rad)', 'Aα (rad)', 'βc (rad)', ...HEAD_SENS], angRows), '', '### 6.4 角度：接觸偵測', table(['αc (rad)', 'Aα (rad)', 'βc (rad)', ...HEAD_CONT], angCont), '');
  // 3. sampling points
  const m = candidateModel(), scs = scenarios(m), exact = scs.map(exactFirst);
  const nExact = exact.reduce((a, x) => a + x.size, 0);
  const sRows: string[][] = [];
  for (const n of [1, 2, 3, 4, 8, 16, 32]) {
    let found = 0, maxErr = 0, early = 0;
    scs.forEach((s, i) => {
      const smp = sampledFirst(s, n, 0.001);
      for (const [k, t] of exact[i]) { const u = smp.get(k); if (u !== undefined) { found++; maxErr = Math.max(maxErr, u - t); } }
      for (const [k] of smp) if (!exact[i].has(k)) early++;
    });
    const j = { scape_rad: m.scan.ac, elbow_rad: m.scan.bc }, pts = antennaSamplePoints(POSE, m, 'left', j, n), tip = antennaInWorld(POSE, m, 'left', j).tip;
    const cx = pts.reduce((a, p) => a + p.x, 0) / n, cy = pts.reduce((a, p) => a + p.y, 0) / n;
    sRows.push([String(n), f3(coverageGap(m, n)), f3(Math.hypot(cx - tip.x, cy - tip.y)), `${found}／${nExact}`, f3(maxErr), String(early)]);
  }
  out.push('### 6.5 取樣點數 n（沿觸角等弧長，含尖端；時間格點 1 ms）', table(['n', '覆蓋間隙 (mm)', '取樣點重心離尖端 (mm)', '偵測到的接觸對（精確解為分母）', '首次接觸最大延遲 (s)', '精確解沒有的接觸對'], sRows));
  // sensing adapter deviation (rounding only)
  const dev = sensingRequests({ agent_id: 'a', t_s: 0, round: 0, layer: 'L', channel: 'c', range_mm: 0, source: 'synthetic', tags: [{ name: 'x', assumption: true, basis: '遊戲假設', note: '' }] }, { x: 3, y: -1, th: 0.7 }, candidateBody().length_mm as number, m).deviation_mm;
  out.push('', `感測轉接：契約重算的尖端與精確尖端差 ${Math.max(dev.left, dev.right) < 1e-12 ? '< 10⁻¹² mm（只有捨入）' : `${Math.max(dev.left, dev.right)} mm`}。`);
  return out.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) console.log(sensitivityTables());
