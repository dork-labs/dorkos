/**
 * Runtime-neutral pending-interaction recovery selector (DOR-73 / ADR-0262).
 *
 * Maps tracked pending interactions to the discriminated
 * {@link PendingInteractionDTO}s the recovery paths re-present, computing the
 * server-authoritative countdown and excluding expired entries. Both trackers
 * call it — the Claude adapter's live `InteractiveSession.pendingInteractions`
 * (holding resolve/reject closures) and the {@link SessionStateProjector |
 * projector}'s recovery records — so the expiry semantics are defined exactly
 * once. The structural {@link PendingInteractionEntry} is the slice the
 * selector actually reads; both trackers' richer entry types satisfy it
 * without adapters or casts.
 *
 * @module services/session/pending-interactions
 */
import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { SESSIONS } from '../../config/constants.js';

/**
 * The recovery-relevant slice of a tracked pending interaction: its DTO
 * discriminant, when it began, and the serializable re-emit payload. The
 * `snapshot` carries the type-specific DTO fields (tool name/input for
 * approvals, questions for prompts, …) captured when the interaction was
 * announced; the selector flattens it into the DTO verbatim.
 */
export interface PendingInteractionEntry {
  type: PendingInteractionDTO['type'];
  /** Server epoch ms when this interaction began (for the countdown math). */
  startedAt: number;
  /** Serializable re-emit payload for the recovery path. */
  snapshot: object;
}

/**
 * Map tracked pending interactions to recovery DTOs.
 *
 * Computes the server-authoritative `remainingMs` from the injected `now` and
 * each interaction's `startedAt`, then excludes any entry that has already
 * expired (`remainingMs <= 0`) so the client never re-presents a stale prompt.
 * `now` is injected (rather than read from `Date.now()`) so callers — and
 * tests — control the clock deterministically. The boundary is exclusive: when
 * `now - startedAt === INTERACTION_TIMEOUT_MS`, `remainingMs` is `0` and the
 * entry is dropped.
 *
 * @param interactions - Pending interactions keyed by interaction id.
 * @param now - Server epoch ms to evaluate the countdown against.
 * @returns Discriminated DTOs for every still-live pending interaction.
 */
export function listPendingInteractions(
  interactions: ReadonlyMap<string, PendingInteractionEntry>,
  now: number
): PendingInteractionDTO[] {
  const out: PendingInteractionDTO[] = [];
  for (const [id, pending] of interactions) {
    const remainingMs = Math.max(0, SESSIONS.INTERACTION_TIMEOUT_MS - (now - pending.startedAt));
    if (remainingMs <= 0) continue;
    out.push({
      id,
      type: pending.type,
      startedAt: pending.startedAt,
      remainingMs,
      ...pending.snapshot,
    } as PendingInteractionDTO);
  }
  return out;
}
