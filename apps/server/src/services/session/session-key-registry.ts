/**
 * Which id a session's state is filed under, and which id its durable rows are.
 *
 * A live session answers to every id it has ever held: the request UUID a client
 * first used, and the canonical id the runtime assigns mid-first-turn. The two
 * halves of the dispatcher's world resolve that differently, on purpose, and
 * this module is the one place that knows how.
 *
 * - **In-memory state stays under the id the session was born with.** An open
 *   turn, the messages queued behind it, and the dispatch mutex keep their keys
 *   across the rename, so nothing in flight loses its slot to a rename it never
 *   saw ({@link primaryOf}).
 * - **Durable rows move to the canonical id**, carried there by the store's
 *   `rekeySession` on the same beat the projector is re-keyed
 *   ({@link queueKeyOf}).
 *
 * Reading one through the other is the bug this module exists to make
 * impossible: a queue read by the filing id after a rename finds nothing, and a
 * message written under it lands in a second queue nothing lists and nothing
 * drains.
 *
 * @module services/session/session-key-registry
 */
import type { SessionStateProjector } from './session-state-projector.js';
import { peekProjector } from './session-state-projector.js';

/** Later-learned session id → the id its dispatcher state is filed under. */
const sessionAliases = new Map<string, string>();
/**
 * Filing id → the id the PROJECTOR is registered under today.
 *
 * The two diverge for one session's first turn: dispatcher state stays filed
 * under the id the session was born with, while the projector registry moves to
 * the canonical id. Without this the pending-interaction gate would look up a
 * projector that is no longer there and read "no interactions" from its
 * absence — a gate that cannot fail is worse than no gate.
 */
const projectorIds = new Map<string, string>();
/** The id `sessionId`'s dispatcher state is filed under (itself, unless aliased). */
export function primaryOf(sessionId: string): string {
  return sessionAliases.get(sessionId) ?? sessionId;
}

/**
 * The id a session's queue ROWS are stored under.
 *
 * Deliberately NOT {@link primaryOf}, and the difference is load-bearing. The
 * dispatcher's in-memory state stays filed under the id a session was born with
 * so an in-flight turn keeps its slot across the rename; the durable rows go the
 * other way, moved onto the canonical id by the store's `rekeySession` on the
 * same beat the projector is re-keyed. Reading them back through the filing id
 * therefore finds nothing, and — worse — a message enqueued after the rename
 * would be written under the filing id and land in a SECOND queue nothing lists
 * and nothing drains. Every store call resolves its key here so there is only
 * ever one queue per session.
 *
 * It is also the key the snapshot reads by, because it resolves to exactly the
 * id the projector is registered under.
 *
 * @param sessionId - Either id a caller might hold (request uuid or canonical)
 */
export function queueKeyOf(sessionId: string): string {
  const primary = primaryOf(sessionId);
  return projectorIds.get(primary) ?? primary;
}

/**
 * Record that a session has gained its canonical id, so state filed under the
 * id it was born with stays reachable.
 *
 * A brand-new session is dispatched to under the request UUID and gains its
 * real SDK id mid-first-turn. The queue ROWS move with it (the store's
 * `rekeySession`, called from the projector's rekey choke point); this moves the
 * in-memory half — the open turn and anything queued behind it — so the second
 * message a person types does not queue against a session key nothing will ever
 * pump.
 *
 * @param oldId - The id the state is filed under today
 * @param newId - The canonical id the session is now known by
 */
export function linkSessionId(oldId: string, newId: string): void {
  const primary = primaryOf(oldId);
  if (newId === primary) return;
  sessionAliases.set(newId, primary);
  projectorIds.set(primary, newId);
}

/** The projector for a filing id, following the canonical-id rename. */
export function projectorFor(sessionKey: string): SessionStateProjector | undefined {
  return peekProjector(projectorIds.get(sessionKey) ?? sessionKey);
}

/**
 * Drop the canonical-id bookkeeping for a session that is gone for good, in both
 * directions: the filing id's forward pointer, and every later id that resolved
 * back to it.
 *
 * @param primary - The id the session's dispatcher state was filed under
 */
export function forgetSessionAliases(primary: string): void {
  projectorIds.delete(primary);
  for (const [alias, target] of sessionAliases) {
    if (target === primary) sessionAliases.delete(alias);
  }
}

/**
 * Forget every rename this process has recorded.
 *
 * @internal Exported for testing only — the registry outlives one test file.
 */
export function resetSessionKeys(): void {
  sessionAliases.clear();
  projectorIds.clear();
}
