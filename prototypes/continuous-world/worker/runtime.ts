/**
 * Command dispatcher and pacer of the experiment Worker (pure: the wall clock is injected and used ONLY to choose how
 * far the world is advanced on each tick; it never reaches the simulation core). Runs unchanged in Node (tests, with a
 * fake clock) and in the browser Worker (entry.ts, with performance.now()).
 *
 * Pacing contract: while running, a tick advances the world to target = anchor_sim + speed * (wall - anchor_wall).
 * Every event up to the target is processed (core.advanceTo); a per-tick work budget can only make the world reach the
 * target LATER (the pacer then re-anchors and reports lagging), never skip an event. Pause, resume and set_speed only
 * move the anchors. Results at a given world time are therefore independent of speed, pauses and tick sizes.
 */
import { ExperimentRefused, ExperimentWorld, type ExperimentSnapshot } from './core.ts';
import { COMMAND_TYPES, EXPERIMENT_LABEL, MAX_SPEED, MIN_SPEED, PROTOCOL_VERSION, type Command, type CommandType, type EventMsg, type FrameMsg, type PacingMsg, type Reply } from './protocol.ts';

const env = { protocol: PROTOCOL_VERSION, label: EXPERIMENT_LABEL, official: false as const };

export class Runtime {
  private world: ExperimentWorld | null = null;
  private started = false; private running = false; private lagging = false;
  private speed = 60; private anchorWall = 0; private anchorSim = 0;
  private follow: string | null = null;
  /** batches per tick before the pacer yields (engineering bound; never drops events) */
  static BUDGET = 20_000;
  private readonly wallMs: () => number;
  constructor(wallMs: () => number) { this.wallMs = wallMs; }

  isRunning(): boolean { return this.running; }
  pacing(): PacingMsg { return { running: this.running, started: this.started, speed: this.speed, lagging: this.lagging }; }
  /** the current world (tests); null before init */
  current(): ExperimentWorld | null { return this.world; }

  private reanchor(): void { this.anchorWall = this.wallMs(); this.anchorSim = this.world ? this.world.tSim() : 0; }
  private frame(): FrameMsg | null { return this.world ? (this.world.frame() as FrameMsg) : null; }
  private followed(): unknown { return this.world && this.follow ? this.world.antView(this.follow) : null; }
  private ack(req: number, cmd: CommandType): Reply { return { ...env, type: 'ack', req, cmd, frame: this.frame(), pacing: this.pacing(), followed: this.followed() }; }
  private eventsMsg(events: EventMsg[]): Reply[] { return events.length ? [{ ...env, type: 'events', events }] : []; }
  private need(): ExperimentWorld { if (!this.world) throw new ExperimentRefused('NO_WORLD', 'init first'); return this.world; }

  handle(raw: unknown): Reply[] {
    const m = raw as Partial<Command> & Record<string, unknown>;
    const req = m && typeof m === 'object' && Number.isSafeInteger(m.req) ? (m.req as number) : null;
    const cmd = m && typeof m === 'object' && typeof m.type === 'string' ? m.type : null;
    const err = (code: string, message: string): Reply[] => [{ ...env, type: 'error', req, cmd, code, message }];
    if (req === null || cmd === null || !COMMAND_TYPES.includes(cmd as CommandType)) return err('UNKNOWN_COMMAND', 'not a command of this protocol (rejected, nothing changed)');
    try {
      const c = m as Command;
      switch (c.type) {
        case 'init': {
          const r = ExperimentWorld.create(c.world_id, c.seed);
          this.world = r.world; this.started = false; this.running = false; this.lagging = false; this.follow = null;
          return [...this.eventsMsg(r.events as EventMsg[]), this.ack(c.req, 'init')];
        }
        case 'start':
          this.need(); if (this.started) return err('ALREADY_STARTED', 'use resume');
          this.started = true; this.running = true; this.lagging = false; this.reanchor(); return [this.ack(c.req, 'start')];
        case 'pause':
          this.need(); if (!this.running) return err('NOT_RUNNING', 'not running');
          { const ev = this.catchUp(); this.running = false; return [...this.eventsMsg(ev), this.ack(c.req, 'pause')]; }
        case 'resume':
          this.need(); if (!this.started) return err('NOT_STARTED', 'use start'); if (this.running) return err('ALREADY_RUNNING', 'already running');
          this.running = true; this.lagging = false; this.reanchor(); return [this.ack(c.req, 'resume')];
        case 'set_speed':
          if (typeof c.speed !== 'number' || !Number.isFinite(c.speed) || c.speed < MIN_SPEED || c.speed > MAX_SPEED) return err('BAD_SPEED', `speed must be in [${MIN_SPEED}, ${MAX_SPEED}] world seconds per real second`);
          { const ev = this.catchUp(); this.speed = c.speed; this.reanchor(); return [...this.eventsMsg(ev), this.ack(c.req, 'set_speed')]; }
        case 'step_until': {
          const w = this.need(); if (this.running) return err('RUNNING', 'pause before step_until');
          const r = w.advanceTo(c.t_sim);
          this.reanchor(); return [...this.eventsMsg(r.events as EventMsg[]), this.ack(c.req, 'step_until')];
        }
        case 'snapshot': {
          const s = this.need().snapshot();
          return [{ ...env, type: 'snapshot', req: c.req, snapshot: s }];
        }
        case 'restore': {
          const w = ExperimentWorld.restore(c.snapshot as ExperimentSnapshot); // throws (and changes nothing) on mismatch
          this.world = w; this.started = false; this.running = false; this.lagging = false; this.follow = null; this.reanchor();
          return [this.ack(c.req, 'restore')];
        }
        case 'follow': {
          const w = this.need();
          if (c.id !== null && !(typeof c.id === 'string' && w.antIds().includes(c.id))) return err('UNKNOWN_INDIVIDUAL', 'follow needs an existing id or null');
          this.follow = c.id; return [this.ack(c.req, 'follow')];
        }
      }
    } catch (e) {
      if (e instanceof ExperimentRefused) return err(e.code, e.message);
      return err('INTERNAL', (e as Error).message);
    }
    return err('UNKNOWN_COMMAND', 'unreachable');
  }

  /** advance to the current pacing target (used before a speed change so the old speed applies up to now) */
  private catchUp(): EventMsg[] {
    const w = this.world; if (!w || !this.running) return [];
    const target = this.anchorSim + (this.speed * (this.wallMs() - this.anchorWall)) / 1000;
    if (!(target > w.tSim())) return [];
    try {
      const r = w.advanceTo(target, Runtime.BUDGET);
      this.lagging = !r.done; if (!r.done) this.reanchor();
      return r.events as EventMsg[];
    } catch (e) { if (e instanceof ExperimentRefused && e.code === 'TIME_BACKWARDS') return []; throw e; }
  }

  /** one pacing tick: events since the last tick and the current state (empty when paused) */
  tick(): Reply[] {
    if (!this.running || !this.world) return [];
    const ev = this.catchUp();
    return [...this.eventsMsg(ev), { ...env, type: 'state', frame: this.frame()!, pacing: this.pacing(), followed: this.followed() }];
  }
}
