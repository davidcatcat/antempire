/**
 * Minimal demo page of the non-official experiment Worker (web/experimental-worker.html). Talks to the Worker only
 * through ExperimentWorkerClient; runs no simulation. requestAnimationFrame here only DRAWS: an ant's on-screen point
 * between the two engine records of its current straight segment is display interpolation, never fed back.
 */
import { ExperimentWorkerClient } from './worker-client.ts';
import { isP0a2Frame, type EventMsg, type FrameMsg, type PacingMsg } from './worker-protocol.ts';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('view'), ctx = canvas.getContext('2d')!;
const client = new ExperimentWorkerClient();
let frame: FrameMsg | null = null, pacing: PacingMsg | null = null, frameAt = 0, followed: unknown = null, eventCount = 0;
const recent: EventMsg[] = [];
const errors: string[] = [];

const fmtTime = (t: number) => { const d = Math.floor(t / 86400), s = t - d * 86400, h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = Math.floor(s % 60); return `第 ${d} 天 ${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`; };
const LIGHT: Record<string, string> = { night: '夜', civil_twilight: '曙暮光', day: '日' };

client.onEvents = (evs) => { eventCount += evs.length; for (const e of evs) recent.push(e); if (recent.length > 40) recent.splice(0, recent.length - 40); renderLog(); };
client.onState = (f, p, fol) => { if (isP0a2Frame(f)) return; /* this demo shows the synthetic world only */ frame = f; pacing = p; followed = fol; frameAt = performance.now(); renderPanel(); };
client.onProtocolError = (w) => { errors.push(w); };

function renderLog(): void {
  $('log').textContent = recent.slice().reverse().map((e) => `#${e.seq} ${fmtTime(e.t_sim)} ${e.kind} ${e.entity ?? ''} ${e.kind === 'ant_bout_end' ? `${String(e.data.from)}→${String(e.data.to)}` : e.kind === 'env_hour' ? `${String(e.data.temperature_c)}°C（合成）` : e.kind === 'light_change' ? String(e.data.light) : ''}`).join('\n');
}
function renderPanel(): void {
  if (!frame) return;
  $('time').textContent = fmtTime(frame.t_sim);
  $('env').textContent = `日期 ${frame.env.date ?? '—'}｜光照 ${frame.env.light ? LIGHT[frame.env.light] : '—'}｜氣溫 ${frame.env.temperature_c ?? '—'}°C（合成剖面，遊戲假設）`;
  const inNest = frame.ants.filter((a) => a.in_nest).length;
  $('counts').textContent = `個體 ${frame.ants.length}（巢內 ${inNest}）｜已收到事件 ${eventCount}｜速度 ${pacing ? pacing.speed : '—'}×${pacing?.lagging ? '（Worker 落後，事件照常逐一處理）' : ''}`;
  $('ids').textContent = `world ${frame.world_id}｜seed ${frame.seed}｜規則指紋 ${frame.rules_fingerprint.slice(0, 12)}…｜seq ${frame.seq}`;
  $('followed').textContent = followed ? JSON.stringify(followed) : '—';
  const sel = $<HTMLSelectElement>('follow');
  if (sel.options.length === 1) for (const a of frame.ants) sel.add(new Option(a.id, a.id));
  $<HTMLButtonElement>('pause').disabled = !pacing?.running;
  $<HTMLButtonElement>('resume').disabled = !pacing || !pacing.started || pacing.running;
  $<HTMLButtonElement>('start').disabled = !!pacing?.started;
}
/** display time: the latest engine frame, advanced by at most a few frames' worth of pacing (display only) */
function displayT(): number {
  if (!frame) return 0;
  if (!pacing?.running) return frame.t_sim;
  return frame.t_sim + Math.min(((performance.now() - frameAt) / 1000) * pacing.speed, pacing.speed * 0.05);
}
function draw(): void {
  const W = canvas.width, H = canvas.height, css = getComputedStyle(document.documentElement);
  ctx.clearRect(0, 0, W, H);
  if (frame) {
    const R = frame.arena_radius_cm, s = (W / 2 - 16) / R, cx = W / 2, cy = H / 2, t = displayT();
    ctx.fillStyle = css.getPropertyValue('--arena'); ctx.beginPath(); ctx.arc(cx, cy, R * s, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = css.getPropertyValue('--nest'); ctx.beginPath(); ctx.arc(cx, cy, 10, 0, Math.PI * 2); ctx.fill();
    for (const a of frame.ants) {
      let x = a.from.x, y = a.from.y;
      if (a.activity === 'walking' && a.to) { const k = Math.min(1, Math.max(0, (t - a.since_s) / (a.until_s - a.since_s))); x += (a.to.x - a.from.x) * k; y += (a.to.y - a.from.y) * k; }
      if (a.in_nest) continue; // in the nest: no position is drawn (counted in the panel)
      const fol = followed && (followed as { id?: string }).id === a.id;
      ctx.fillStyle = a.activity === 'walking' ? css.getPropertyValue('--walk') : css.getPropertyValue('--ant');
      ctx.beginPath(); ctx.arc(cx + x * s, cy + y * s, fol ? 7 : 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = css.getPropertyValue('--ink'); ctx.font = '11px system-ui'; ctx.fillText(a.id, cx + x * s + 7, cy + y * s - 6);
    }
    ctx.fillStyle = css.getPropertyValue('--muted'); ctx.font = '12px system-ui';
    ctx.fillText('非正式實驗世界／不屬於正式遊戲歷史｜位置＝引擎線段的顯示插值', 10, H - 10);
  }
  requestAnimationFrame(draw);
}

$('start').onclick = () => { void client.start(); };
$('pause').onclick = () => { void client.pause(); };
$('resume').onclick = () => { void client.resume(); };
$<HTMLSelectElement>('speed').onchange = (e) => { void client.setSpeed(Number((e.target as HTMLSelectElement).value)); };
$<HTMLSelectElement>('follow').onchange = (e) => { const v = (e.target as HTMLSelectElement).value; void client.follow(v === '' ? null : v); };

const params = new URLSearchParams(location.search);
const seed = Number(params.get('seed') ?? '1');
void client.init(`exp-demo-${seed}`, seed).then(() => client.setSpeed(60));
(window as unknown as { __experiment: unknown }).__experiment = { client, errors, frame: () => frame, pacing: () => pacing, events: () => eventCount, displayT };
requestAnimationFrame(draw);
