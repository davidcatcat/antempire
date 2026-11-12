/**
 * Issue #144 fallback (isolated prototype). A cause that comes from the observer (camera focus, zoom, follow, view
 * toggles) must never change the RESOLUTION of an organism in a representation whose outcomes depend on resolution
 * (OD-1 v1 ledger.ts, life-time cohort lifetime.ts): their random paths differ between an individual and a cohort
 * member, so a view-driven promote/demote changes fates (tests/wp5-camera-invariance.test.ts R1/R2). Those modules
 * refuse such causes with VIEW_CANNOT_CHANGE_RESOLUTION. The unified ledger (unified.ts) keeps the view outside the
 * authoritative state instead.
 */
const VIEW_KIND = /^(view|camera|zoom|follow|observer|player)([._:-]|$)/i;
const VIEW_DRIVER = /^(view|camera|zoom|follow|observer|player)[:.]/i;
/** true when the cause names the observer as its kind or as one of its driver events */
export function isViewCause(c: { kind: string; driver_event_ids: string[] } | undefined | null): boolean {
  if (!c) return false;
  return VIEW_KIND.test(c.kind) || c.driver_event_ids.some((d) => VIEW_DRIVER.test(d));
}
export const VIEW_REFUSAL = 'VIEW_CANNOT_CHANGE_RESOLUTION';
