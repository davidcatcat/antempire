/**
 * Issue #189 / #193 ruling 1 — one contact classification for every walking / contact solver (isolated).
 *
 * Status: isolated physics experiment. Not imported by the daily loop, Day0, cli/ or web/ (tests/physics-isolation.test.ts).
 * It does not change any solver: PH-3b (solver2d.ts), WP4 (local-steer.ts), KIN-2D (kinematics2d.ts, kinematics2d-contact.ts)
 * and ANTENNA-GEO (antenna-geometry.ts) are only READ, through adapters, into one record format.
 *
 * Two record kinds, never mixed (ruling 1; Owner decisions C6 / 36):
 *  - contact_episode: GEOMETRIC contact — an interval during which two shapes are within the contact tolerance θ
 *    (body capsule ↔ body capsule, antenna ↔ body / antenna / static object). It says nothing about forces.
 *    geometry: body_body | body_static | antenna_body | antenna_antenna | antenna_static.
 *  - constraint_active: MECHANICAL action — the solver's non-penetration constraint acted on a body (a stop, a velocity
 *    projection, a re-press). It says nothing about perception. A constraint can act without a contact (WP4's
 *    conservative stop against a planned path) and a contact can exist without a constraint (a graze).
 * Mechanics (stopping, slowing, sliding) uses constraint_active; biological signals may use ONLY contact_episode.
 *
 * Biological contact condition (defined here; candidate rule, 遊戲假設 for its use, mechanism from the antennal-contact
 * literature only as a direction — no Pheidole megacephala measurement of antennation exists):
 *  an antennal signal (antennation, or a CHC / CHEM contact read) for a RECEIVER r with a PARTNER p may start only at the
 *  start of a contact_episode whose geometry is antenna_body or antenna_antenna, whose antenna belongs to r (r's scape or
 *  funiculus capsule is within θ of p's body capsule or of p's antenna capsule; ANTENNA-GEO #175 detectAntennaContacts on
 *  the EXECUTED body motion), and whose partner is another agent (not a static object). Body–body contact alone is
 *  NOT antennal contact (the antenna is the sensing organ; the CHEM contract's CHC perception rule is 'antennal_contact'),
 *  and constraint_active never triggers anything. A trigger is only the permission for a signal to be considered: no
 *  recognition, transfer or decision is modelled here (recognition: null in ANTENNA-GEO).
 * Pure, deterministic, independent of input array order (records sorted by (start, kind, ids)). Units: s, mm.
 */
import type { Solver2DResult } from './solver2d.ts';
import type { SteerResult } from './local-steer.ts';
import type { KinResult } from './kinematics2d.ts';
import type { ContactRunResult } from './kinematics2d-contact.ts';
import type { AntennaContactResult } from './antenna-geometry.ts';

export class ClassificationRefused extends Error { constructor(m: string) { super(`CONTACT_CLASS_REFUSED: ${m}`); this.name = 'ClassificationRefused'; } }

export type ContactSource = 'PH-3b' | 'WP4' | 'KIN-2D freeze' | 'KIN-2D project' | 'ANTENNA-GEO' | 'LANE-FLOW';
export type ContactGeometry = 'body_body' | 'body_static' | 'antenna_body' | 'antenna_antenna' | 'antenna_static';
export interface ContactEpisode {
  kind: 'contact_episode';
  geometry: ContactGeometry;
  /** body_*: the two shapes' ids sorted; antenna_*: [antenna owner, target id] */
  ids: [string, string];
  /** antenna_*: the agent whose antenna touches and which side; null for body contacts */
  antenna: { owner: string; side: 'left' | 'right' } | null;
  start_t_s: number;
  /** null = still in contact at the horizon */
  end_t_s: number | null;
  /** false when the end is a boundary rule (a body left the plane), not a physical separation */
  end_is_physical: boolean;
  source: ContactSource;
}
export interface ConstraintActive {
  kind: 'constraint_active';
  /** constrained body (or both bodies of a PH-3b pair constraint) */
  bodies: string[];
  /** the other shape(s) of the constraint, if known (a body id, a static id, 'goal', …) */
  partners: string[];
  start_t_s: number;
  /** end of the mechanical action; equals start for an instantaneous response (KIN-2D freeze stop, re-press) */
  end_t_s: number | null;
  /** true iff the shapes touch when it acts (false: e.g. WP4 conservative stop against a planned path) */
  in_contact: boolean;
  cause: string;
  source: ContactSource;
}
export interface ContactClassification { source: ContactSource; horizon_s: number; contact_episodes: ContactEpisode[]; constraint_active: ConstraintActive[] }

const sid = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);
const cmpStr = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortEp = (xs: ContactEpisode[]) => xs.sort((x, y) => x.start_t_s - y.start_t_s || cmpStr(x.geometry, y.geometry) || cmpStr(x.ids.join('|'), y.ids.join('|')) || cmpStr(x.antenna?.side ?? '', y.antenna?.side ?? ''));
const sortCa = (xs: ConstraintActive[]) => xs.sort((x, y) => x.start_t_s - y.start_t_s || cmpStr(x.bodies.join('|'), y.bodies.join('|')) || cmpStr(x.cause, y.cause));

/** pairs contact_start / contact_end events of one pair into episodes (FIFO per pair) */
function episodesFrom(events: { t_s: number; kind: string; ids: string[] }[], startKinds: string[], endKinds: Record<string, boolean>, geometryOf: (ids: string[]) => ContactGeometry, source: ContactSource): ContactEpisode[] {
  const open = new Map<string, ContactEpisode>(), out: ContactEpisode[] = [];
  for (const e of events) {
    if (e.ids.length !== 2) continue;
    const ids = sid(e.ids[0], e.ids[1]), k = ids.join('|');
    if (startKinds.includes(e.kind)) {
      if (open.has(k)) throw new ClassificationRefused(`${source}: second contact_start of ${k} at ${e.t_s} before its end`);
      const ep: ContactEpisode = { kind: 'contact_episode', geometry: geometryOf(ids), ids, antenna: null, start_t_s: e.t_s, end_t_s: null, end_is_physical: true, source };
      open.set(k, ep); out.push(ep);
    } else if (e.kind in endKinds) {
      const ep = open.get(k);
      if (!ep) throw new ClassificationRefused(`${source}: ${e.kind} of ${k} at ${e.t_s} without a start`);
      ep.end_t_s = e.t_s; ep.end_is_physical = endKinds[e.kind]; open.delete(k);
    }
  }
  return out;
}

// ---------------------------------------------------------------- adapters
/** PH-3b: geometric episodes from contact_start / contact_end (contact_end_unconfirmed = still open); pair constraints from Solver2DResult.constraint_active */
export function classifyPh3b(res: Solver2DResult, horizon_s: number, source: ContactSource = 'PH-3b'): ContactClassification {
  const contact_episodes = episodesFrom(res.events.map((e) => ({ t_s: e.t_s, kind: e.kind, ids: e.agents })), ['contact_start'], { contact_end: true }, () => 'body_body', source);
  const constraint_active: ConstraintActive[] = res.constraint_active.map((c) => ({ kind: 'constraint_active', bodies: [...c.agents].sort(), partners: [...c.agents].sort(), start_t_s: c.start_t_s, end_t_s: c.end_t_s, in_contact: true, cause: `pair constraint in the velocity solve (${c.start_trigger})`, source }));
  return { source, horizon_s, contact_episodes: sortEp(contact_episodes), constraint_active: sortCa(constraint_active) };
}

/** WP4: policy 'none' is PH-3b; A–C / N: episodes from contact_start / contact_end / contact_end_estimated (boundary
 *  rule, not physical); constraint_active from each 'stop' (physical_constraint) until the body's next resume, decision,
 *  arrival or exit event (null if none before the horizon). A conservative stop has in_contact false. */
export function classifySteer(res: SteerResult, horizon_s: number): ContactClassification {
  if (res.policy === 'none') { if (!res.ph3b) throw new ClassificationRefused('WP4 none without the PH-3b result'); return classifyPh3b(res.ph3b, horizon_s, 'WP4'); }
  const ev = res.events.map((e) => ({ t_s: e.t_s, kind: e.kind, ids: e.agents }));
  const contact_episodes = episodesFrom(ev, ['contact_start'], { contact_end: true, contact_end_estimated: false }, () => 'body_body', 'WP4');
  const constraint_active: ConstraintActive[] = [];
  const open = new Map<string, ConstraintActive>();
  for (const e of res.events) {
    const id = e.agents[0];
    if (e.kind === 'stop' && e.class === 'physical_constraint') {
      if (open.has(id)) continue; // still stopped: the same mechanical hold
      const d = e.detail ?? '', m = /contact with (\S+)/.exec(d) ?? /planned path of (\S+)/.exec(d);
      const c: ConstraintActive = { kind: 'constraint_active', bodies: [id], partners: m ? [m[1]] : /static|lane-|geometry/.test(d) ? ['static'] : [], start_t_s: e.t_s, end_t_s: null, in_contact: !/^conservative stop/.test(d), cause: d || 'no motion', source: 'WP4' };
      open.set(id, c); constraint_active.push(c);
    } else if (open.has(id) && e.agents.length === 1) {
      const c = open.get(id)!;
      // the hold ends when the body moves again (resume), leaves (arrive / exit) or takes a new decision at a later instant
      if (e.kind === 'resume' || e.kind === 'arrive' || e.kind === 'exit' || (e.class === 'behavioural_response' && e.t_s > c.start_t_s)) { c.end_t_s = e.t_s; open.delete(id); }
    }
  }
  return { source: 'WP4', horizon_s, contact_episodes: sortEp(contact_episodes), constraint_active: sortCa(constraint_active) };
}

/** KIN-2D freeze (runKinematics): episodes from contact_start / contact_end; each stop_on_contact and repress is an
 *  INSTANTANEOUS constraint response (start = end); the frozen hold after a stop is the freeze rule, not a constraint. */
export function classifyKin(res: KinResult, horizon_s: number, statics: string[] = []): ContactClassification {
  const isStatic = (x: string) => statics.includes(x);
  const ev = res.events.map((e) => ({ t_s: e.t_s, kind: e.kind, ids: e.ids }));
  const contact_episodes = episodesFrom(ev, ['contact_start'], { contact_end: true }, (ids) => (ids.some(isStatic) ? 'body_static' : 'body_body'), 'KIN-2D freeze');
  const constraint_active: ConstraintActive[] = [];
  for (const e of res.events) {
    if (e.kind === 'stop_on_contact') {
      const partners = (e.detail ?? '').split(',').filter(Boolean).flatMap((k) => k.replace(/^limit:/, '').split('|')).filter((x) => x !== e.ids[0]);
      constraint_active.push({ kind: 'constraint_active', bodies: [e.ids[0]], partners: [...new Set(partners)].sort(), start_t_s: e.t_s, end_t_s: e.t_s, in_contact: !/^limit:/.test(e.detail ?? ''), cause: 'stop_on_contact (freeze response; the body then holds until the horizon)', source: 'KIN-2D freeze' });
    } else if (e.kind === 'repress') constraint_active.push({ kind: 'constraint_active', bodies: sid(e.ids[0], e.ids[1]), partners: sid(e.ids[0], e.ids[1]), start_t_s: e.t_s, end_t_s: e.t_s, in_contact: true, cause: 'repress', source: 'KIN-2D freeze' });
  }
  return { source: 'KIN-2D freeze', horizon_s, contact_episodes: sortEp(contact_episodes), constraint_active: sortCa(constraint_active) };
}

/** KIN-2D project (shared contact constraint): episodes from contact_start / contact_end; per body, an interval from
 *  'constrained' or 'stop_on_contact' to the next 'constraint_free' (one interval while it stays constrained or stopped). */
export function classifyKinProject(res: ContactRunResult, horizon_s: number, statics: string[] = []): ContactClassification {
  const isStatic = (x: string) => statics.includes(x);
  const ev = res.events.map((e) => ({ t_s: e.t_s, kind: e.kind, ids: e.ids }));
  const contact_episodes = episodesFrom(ev, ['contact_start'], { contact_end: true }, (ids) => (ids.some(isStatic) ? 'body_static' : 'body_body'), 'KIN-2D project');
  const constraint_active: ConstraintActive[] = [], open = new Map<string, ConstraintActive>();
  for (const e of res.events) {
    const id = e.ids[0];
    if (e.kind === 'constrained' || e.kind === 'stop_on_contact') {
      const partners = (e.detail ?? '').split(';')[0].split(',').filter((k) => k.includes('|')).flatMap((k) => k.split('|')).map((x) => x.replace(/#\d+$/, '')).filter((x) => x !== id);
      const c = open.get(id);
      if (c) { c.partners = [...new Set([...c.partners, ...partners])].sort(); continue; }
      const n: ConstraintActive = { kind: 'constraint_active', bodies: [id], partners: [...new Set(partners)].sort(), start_t_s: e.t_s, end_t_s: null, in_contact: true, cause: `${e.kind} (velocity projection)`, source: 'KIN-2D project' };
      open.set(id, n); constraint_active.push(n);
    } else if (e.kind === 'constraint_free' && open.has(id)) { open.get(id)!.end_t_s = e.t_s; open.delete(id); }
    else if (e.kind === 'repress') constraint_active.push({ kind: 'constraint_active', bodies: [...e.ids].sort(), partners: [...e.ids].sort(), start_t_s: e.t_s, end_t_s: e.t_s, in_contact: true, cause: 'repress', source: 'KIN-2D project' });
  }
  return { source: 'KIN-2D project', horizon_s, contact_episodes: sortEp(contact_episodes), constraint_active: sortCa(constraint_active) };
}

/** ANTENNA-GEO: antenna episodes (start / end phases); geometry by target kind; no constraint (antennae are kinematic) */
export function classifyAntenna(res: AntennaContactResult, horizon_s: number): ContactClassification {
  const open = new Map<string, ContactEpisode>(), out: ContactEpisode[] = [];
  for (const e of res.events) {
    const tgt = e.target.kind === 'antenna' ? `${e.target.id}:${e.target.side}` : e.target.id, k = `${e.agent_id}:${e.side}|${e.target.kind}:${tgt}`;
    if (e.phase === 'start') {
      if (open.has(k)) throw new ClassificationRefused(`ANTENNA-GEO: second start of ${k}`);
      const ep: ContactEpisode = { kind: 'contact_episode', geometry: e.target.kind === 'body' ? 'antenna_body' : e.target.kind === 'antenna' ? 'antenna_antenna' : 'antenna_static', ids: [e.agent_id, e.target.id], antenna: { owner: e.agent_id, side: e.side }, start_t_s: e.t_s, end_t_s: null, end_is_physical: true, source: 'ANTENNA-GEO' };
      open.set(k, ep); out.push(ep);
    } else { const ep = open.get(k); if (!ep) throw new ClassificationRefused(`ANTENNA-GEO: end of ${k} without a start`); ep.end_t_s = e.t_s; open.delete(k); }
  }
  return { source: 'ANTENNA-GEO', horizon_s, contact_episodes: sortEp(out), constraint_active: [] };
}

// ---------------------------------------------------------------- consistency checks
/** constraint_active records that claim contact must start inside a body contact episode of the same bodies (± slack) */
export function constraintsOutsideContact(c: ContactClassification, slack_s: number): ConstraintActive[] {
  return c.constraint_active.filter((k) => k.in_contact && k.partners.length > 0 && !k.partners.every((p) => p === 'static') && !c.contact_episodes.some((e) => (e.geometry === 'body_body' || e.geometry === 'body_static') && k.bodies.every((b) => e.ids.includes(b)) && k.partners.some((p) => p === 'static' || e.ids.includes(p)) && k.start_t_s >= e.start_t_s - slack_s && (e.end_t_s === null || k.start_t_s <= e.end_t_s + slack_s)));
}

// ---------------------------------------------------------------- biological gate (ruling 1)
export type BioSignal = 'antennation' | 'chc_contact';
export interface BioContactRule {
  signal: BioSignal;
  /** the only geometries that can start this signal (antenna of the receiver touching another agent) */
  geometries: readonly ContactGeometry[];
  assumption: true; basis: '遊戲假設'; note: string;
}
export const BIO_CONTACT_RULES: Readonly<Record<BioSignal, BioContactRule>> = Object.freeze({
  antennation: { signal: 'antennation', geometries: ['antenna_body', 'antenna_antenna'], assumption: true, basis: '遊戲假設', note: 'the receiver\'s own antenna (scape or funiculus capsule) within θ of another agent\'s body or antenna; body–body contact alone is not antennation; no species measurement of antennation' },
  chc_contact: { signal: 'chc_contact', geometries: ['antenna_body', 'antenna_antenna'], assumption: true, basis: '遊戲假設', note: 'CHEM contract CHC perception rule is antennal_contact (contact only, near_contact null); cuticle of the partner\'s body or antenna; no recognition is modelled here' },
});
export interface BioTrigger { signal: BioSignal; t_s: number; receiver: string; partner: string; side: 'left' | 'right'; from: 'contact_episode'; episode_source: ContactSource; tags: { assumption: true; basis: '遊戲假設'; note: string }[] }
/**
 * Triggers of one antennal signal: one per qualifying contact_episode START. Only ContactEpisode records are accepted —
 * passing a constraint_active record is refused (mechanics never triggers biology).
 */
export function biologicalTriggers(episodes: readonly (ContactEpisode | ConstraintActive)[], signal: BioSignal, agents: readonly string[]): BioTrigger[] {
  const rule = BIO_CONTACT_RULES[signal];
  if (!rule) throw new ClassificationRefused(`unknown signal ${String(signal)}`);
  const isAgent = new Set(agents);
  const out: BioTrigger[] = [];
  for (const e of episodes) {
    if ((e as { kind: string }).kind !== 'contact_episode') throw new ClassificationRefused(`a ${(e as { kind: string }).kind} record cannot trigger a biological signal (only contact_episode can)`);
    const ep = e as ContactEpisode;
    if (!rule.geometries.includes(ep.geometry) || !ep.antenna) continue;
    const receiver = ep.antenna.owner, partner = ep.ids[1];
    if (!isAgent.has(receiver) || !isAgent.has(partner) || receiver === partner) continue;
    out.push({ signal, t_s: ep.start_t_s, receiver, partner, side: ep.antenna.side, from: 'contact_episode', episode_source: ep.source, tags: [{ assumption: true, basis: rule.basis, note: rule.note }] });
  }
  return out.sort((x, y) => x.t_s - y.t_s || cmpStr(x.receiver, y.receiver) || cmpStr(x.partner, y.partner) || cmpStr(x.side, y.side));
}
