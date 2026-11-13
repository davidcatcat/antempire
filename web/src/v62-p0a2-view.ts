/**
 * V6-2 experiment mode, P0-A2 world — drawing / text helpers for the page (canvas 2D + HTML strings). Reads only the
 * Worker's P0-A2 frame; never runs or changes the simulation. Candidate / experiment world, non-official (Owner #201).
 *  - the nest inset is SCHEMATIC (示意): the P0-A2 world has no positions inside the nest; workers are grouped by their
 *    ENGINE state, dot fill = the worker's own crop fill (engine), larva fill = its gut fill (engine). Both fills are
 *    the Worker's projection to the frame's t_sim by the core's own metabolic rule (issue #225), not the value of the
 *    individual's last settlement; the follow card names the last settlement instant separately.
 */
import type { P0a2FrameMsg } from './experimental/worker-protocol.ts';
import { INSET_ZONES, P0_LIGHT_LABEL, STATE_LABEL, insetSlots, stateCounts, type P0Pose } from './v62-p0a2-model.ts';
import { fmtWorldTime } from './v62-model.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
export interface InsetRect { x: number; y: number; w: number; h: number }
export interface InsetHit { id: string; sx: number; sy: number; r: number }

/** where the inset goes: above the bottom bar; full width on narrow screens, 400 px on the right otherwise */
export function insetRect(cw: number, ch: number, bottomPx: number): InsetRect {
  const w = cw < 640 ? cw - 16 : Math.min(420, cw * 0.42), h = cw < 640 ? 118 : 138;
  return { x: cw - w - 8, y: ch - bottomPx - h - 8, w, h };
}

/** draws the schematic nest inset; returns the dot positions (screen px) for picking */
export function drawInset(g: CanvasRenderingContext2D, f: P0a2FrameMsg, R: InsetRect, selected: string | null, following: string | null): InsetHit[] {
  const hits: InsetHit[] = [], counts = stateCounts(f);
  g.save();
  g.fillStyle = 'rgba(30,20,12,0.86)'; g.strokeStyle = 'rgba(243,234,214,0.35)'; g.lineWidth = 1;
  g.beginPath(); g.roundRect(R.x, R.y, R.w, R.h, 10); g.fill(); g.stroke();
  g.fillStyle = '#f3ead6'; g.font = '600 12px system-ui'; g.textBaseline = 'top';
  g.fillText('巢內（示意）', R.x + 8, R.y + 5);
  g.font = '10.5px system-ui'; g.fillStyle = '#cbbd9f';
  g.fillText('巢內位置未模擬；分組＝引擎狀態，點的填色＝嗉囊（引擎，推算至目前）', R.x + 82, R.y + 6);
  for (const z of INSET_ZONES) {
    const zx = R.x + z.x * R.w, zy = R.y + z.y * R.h, zw = z.w * R.w, zh = z.h * R.h - 4;
    g.fillStyle = 'rgba(255,255,255,0.05)'; g.beginPath(); g.roundRect(zx, zy, zw, zh, 6); g.fill();
    const n = z.states.reduce((s, k) => s + (counts[k] ?? 0), 0);
    g.fillStyle = '#e9dcc0'; g.font = '11px system-ui'; g.fillText(`${z.label} ${n}`, zx + 4, zy + 3);
  }
  // larvae (engine: 8 larvae, gut fill), inside the brood zone, bottom row
  const bz = INSET_ZONES.find((z) => z.key === 'brood')!, n = f.larvae.length;
  f.larvae.forEach((l, i) => {
    const cx = R.x + (bz.x + (i + 0.5) * (bz.w / n)) * R.w, cy = R.y + (bz.y + bz.h) * R.h - 12, rw = Math.min(6, (bz.w * R.w) / n / 2.4), rh = rw * 0.7;
    g.fillStyle = 'rgba(250,244,226,0.25)'; g.beginPath(); g.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.ellipse(cx, cy, rw, rh, 0, 0, Math.PI * 2); g.clip(); g.fillStyle = '#f6efd8'; g.fillRect(cx - rw, cy + rh - 2 * rh * Math.max(0, Math.min(1, l.gut_fill)), 2 * rw, 2 * rh); g.restore();
  });
  const rDot = Math.max(4, Math.min(6.5, R.w / 70));
  for (const s of insetSlots(f)) {
    const w = f.workers.find((x) => x.id === s.id)!, sx = R.x + s.x * R.w, sy = R.y + s.y * R.h;
    g.fillStyle = '#3a2412'; g.beginPath(); g.arc(sx, sy, rDot, 0, Math.PI * 2); g.fill();
    g.save(); g.beginPath(); g.arc(sx, sy, rDot, 0, Math.PI * 2); g.clip(); g.fillStyle = '#e8b04a'; g.fillRect(sx - rDot, sy + rDot - 2 * rDot * Math.max(0, Math.min(1, w.crop_fill)), 2 * rDot, 2 * rDot); g.restore();
    g.strokeStyle = s.id === selected ? (s.id === following ? '#9fe0ff' : '#ffe08a') : 'rgba(255,240,210,0.5)'; g.lineWidth = s.id === selected ? 2 : 1; g.beginPath(); g.arc(sx, sy, rDot + (s.id === selected ? 2 : 0), 0, Math.PI * 2); g.stroke();
    hits.push({ id: s.id, sx, sy, r: rDot + 4 });
  }
  g.restore();
  return hits;
}

export function hudStatus(f: P0a2FrameMsg, poses: readonly P0Pose[]): string {
  const c = stateCounts(f), out = c.outbound + c.searching + c.feeding + c.returning, nest = f.workers.length - out;
  const interp = poses.filter((p) => p.interpolated).length;
  const t = f.env.temperature_c === null ? '—' : f.env.temperature_c.toFixed(1);
  return `工蟻 ${f.workers.length}：巢內 ${nest}（休息 ${c.resting}、走動 ${c.idle}、育幼 ${c.brood_care}、往返巢口 ${c.to_entrance + c.from_entrance}）｜巢外 ${out}（去程 ${c.outbound}、搜尋 ${c.searching}、取食 ${c.feeding}、回程 ${c.returning}；${interp} 隻在路線上為顯示插值）｜幼蟲 ${f.larvae.length}｜光照 ${P0_LIGHT_LABEL[f.env.light]}（引擎）｜氣溫 ${t}°C（合成）｜蜜露存量 ${f.source.stock_portions.toFixed(2)} 份（玩家視角）｜事件 ${f.log.count}`;
}

export function cardHtml(f: P0a2FrameMsg, id: string, pose: P0Pose | undefined, following: boolean, followed: unknown): string {
  const w = f.workers.find((x) => x.id === id); if (!w) return '';
  const where = pose?.where === 'nest' ? '巢內（巢內位置未模擬；下方巢內圖為示意分組）'
    : pose?.where === 'search' ? '巢外搜尋：搜尋沒有空間模型，畫面位置為<b>示意</b>'
      : pose?.where === 'source' ? `在食源 ${esc(f.layout.source_id)}（引擎狀態；在食源周圍的排列只是畫面）`
        : pose?.interpolated ? `路線上：畫面位置＝兩個引擎紀錄點（${fmtWorldTime(w.since_s)} 出發、${fmtWorldTime(w.until_s ?? w.since_s)} 抵達）之間的<b>顯示插值</b>` : '路線端點（引擎紀錄點）';
  const fv = following && followed && typeof followed === 'object' ? followed as { contacts?: unknown[]; begging?: unknown[]; consumed?: number; debt?: number; settled_s?: number; theta_forage?: number; theta_brood?: number; gain?: number } : null;
  return `<b>${esc(id)}</b>　<span class="muted">P0-A2 小工蟻（${esc(f.status_zh)}）</span><br>活動：${esc(STATE_LABEL[w.state] ?? w.state)}（自 ${fmtWorldTime(w.since_s)}，引擎狀態）<br>位置：${where}<br>嗉囊：${(w.crop_fill * 100).toFixed(0)}%（自身生理，引擎；依核心代謝規則推算至 ${fmtWorldTime(f.t_sim)}）｜路線記憶：${w.route ? esc(w.route) : '無'}${fv ? `<br><span class="muted">追蹤中（Worker 唯讀副本）：已代謝 ${fv.consumed ?? '—'} µP、未滿足需求 ${fv.debt ?? '—'} µP（推算至 ${fmtWorldTime(f.t_sim)}；上次結帳 ${fv.settled_s === undefined ? '—' : fmtWorldTime(fv.settled_s)}）；接觸紀錄 ${fv.contacts?.length ?? 0}、幼蟲求食紀錄 ${fv.begging?.length ?? 0}（只在自身決策事件時依接觸窗修剪，非目前時刻計數）；個體門檻 覓食 ${fv.theta_forage?.toFixed(2) ?? '—'}、育幼 ${fv.theta_brood?.toFixed(2) ?? '—'}</span>` : ''}<div class="row"><button id="followBtn" type="button">${following ? '取消追蹤' : '鏡頭追蹤'}</button><button id="closeCard" type="button" aria-label="關閉">✕</button></div>`;
}
