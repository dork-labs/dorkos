/**
 * The two session-origin overlays, applied in the one order that is correct.
 *
 * Room first, Pulse second — see {@link applyRoomOriginOverlay}'s doc for why
 * that ordering is a product decision rather than an accident. It lived as a
 * hand-repeated pair at every call site until the global session-list stream
 * became a fourth one; a rule stated in four places is a rule three of them can
 * drift from, so it is stated here and nowhere else.
 *
 * @module services/session/origin/session-origin-overlays
 */
import type { Session } from '@dorkos/shared/types';
import { applyRoomOriginOverlay, type ResolveRoomOrigins } from './room-origin-overlay.js';
import { applyTaskOriginOverlay, type ResolveTaskOrigins } from './task-origin-overlay.js';

/**
 * The batched origin lookups, as the composition root wires them.
 *
 * Both are optional and an absent one is a no-op, because either subsystem can
 * be off: an install with Tasks disabled has no `resolveTaskOrigins` at all.
 */
export interface SessionOriginResolvers {
  /** Room bindings (`room_sessions`); absent when the rooms subsystem is off. */
  resolveRoomOrigins?: ResolveRoomOrigins | undefined;
  /** Pulse task runs; absent when the Tasks subsystem is off. */
  resolveTaskOrigins?: ResolveTaskOrigins | undefined;
}

/** One overlay in the ordered chain, named so a failure can say which failed. */
export interface SessionOriginOverlayStep {
  /** What to call it in a log line. */
  name: string;
  /** Apply it to these rows, in place. */
  apply: (sessions: Session[]) => void;
}

/**
 * The overlays, in order, as separable steps.
 *
 * Exposed beside {@link applySessionOriginOverlays} for the one caller that
 * needs to survive a step failing: the global session-list stream isolates each
 * one, so a Pulse lookup that throws still leaves a room turn marked as a room
 * turn rather than discarding the whole overlay and broadcasting a row with no
 * origin at all — which is the very defect DOR-1141 closed. The ORDER still
 * lives only here, so isolating the steps cannot become a way to reorder them.
 *
 * The session routes deliberately do not use this: on a request, a lookup that
 * throws should surface as a failed request rather than a quietly half-marked
 * list.
 *
 * @param resolvers - The batched lookups; each absent one makes its step a no-op.
 */
export function sessionOriginOverlaySteps(
  resolvers: SessionOriginResolvers
): readonly SessionOriginOverlayStep[] {
  return [
    {
      name: 'room origin',
      apply: (sessions) => applyRoomOriginOverlay(sessions, resolvers.resolveRoomOrigins),
    },
    {
      name: 'Pulse task origin',
      apply: (sessions) => applyTaskOriginOverlay(sessions, resolvers.resolveTaskOrigins),
    },
  ];
}

/**
 * Overlay every origin the server knows and the transcript does not, in place.
 *
 * @param sessions - The rows to mark, mutated in place.
 * @param resolvers - The batched lookups; each absent one is skipped.
 */
export function applySessionOriginOverlays(
  sessions: Session[],
  resolvers: SessionOriginResolvers
): void {
  for (const step of sessionOriginOverlaySteps(resolvers)) step.apply(sessions);
}

/**
 * The resolvers the composition root parks on `app.locals`, as a typed pair.
 *
 * Every session route reads the same two keys and cast them one at a time; the
 * cast is done once here so a route cannot pick up only one of the pair and
 * quietly apply half the rule.
 *
 * @param locals - `req.app.locals`.
 */
export function sessionOriginResolvers(locals: {
  resolveRoomOrigins?: unknown;
  resolveTaskOrigins?: unknown;
}): SessionOriginResolvers {
  return {
    resolveRoomOrigins: locals.resolveRoomOrigins as ResolveRoomOrigins | undefined,
    resolveTaskOrigins: locals.resolveTaskOrigins as ResolveTaskOrigins | undefined,
  };
}
