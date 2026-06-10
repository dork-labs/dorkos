import type { PendingInteractionDTO } from '@dorkos/shared/types';
import { SESSIONS } from '../../../../config/constants.js';
import type { InteractiveSession } from './interactive-handlers.js';

/**
 * Map a session's pending interactions to recovery DTOs.
 *
 * Computes the server-authoritative `remainingMs` from the injected `now` and
 * each interaction's `startedAt`, then excludes any entry that has already
 * expired (`remainingMs <= 0`) so the client never re-presents a stale prompt.
 * `now` is injected (rather than read from `Date.now()`) so callers — and
 * tests — control the clock deterministically. The boundary is exclusive: when
 * `now - startedAt === INTERACTION_TIMEOUT_MS`, `remainingMs` is `0` and the
 * entry is dropped.
 *
 * @param session - The session whose `pendingInteractions` map is mapped.
 * @param now - Server epoch ms to evaluate the countdown against.
 * @returns Discriminated DTOs for every still-live pending interaction.
 */
export function listPendingInteractions(
  session: InteractiveSession,
  now: number
): PendingInteractionDTO[] {
  const out: PendingInteractionDTO[] = [];
  for (const [id, pending] of session.pendingInteractions) {
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
