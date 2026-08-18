/**
 * Runtime-neutral pending-interaction recovery selector (DOR-73 / ADR-0264).
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
  /**
   * Serializable re-emit payload for the recovery path.
   *
   * When it carries a `timeoutMs` it is also the budget this entry's remainder
   * is measured against — see {@link listPendingInteractions}.
   */
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
 * the elapsed time equals the budget, `remainingMs` is `0` and the entry is
 * dropped.
 *
 * The budget is the interaction's OWN `timeoutMs` when it declared one, and the
 * server-wide auto-deny only as a fallback. Measuring every interaction against
 * the global constant made a DTO argue with itself — a 120-second ask shipped
 * `timeoutMs: 120000` beside `remainingMs: 562000`, so the card drew a bar past
 * its own maximum and announced nine minutes left on an ask with eighty-five
 * seconds to live (DOR-810).
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
    // The budget is read off the DTO being assembled rather than passed
    // alongside it, so the number the countdown is measured against is
    // literally the number that ships — the two cannot drift apart.
    const dto = {
      id,
      type: pending.type,
      startedAt: pending.startedAt,
      ...pending.snapshot,
    } as PendingInteractionDTO & { timeoutMs?: number };
    const budgetMs = dto.timeoutMs ?? SESSIONS.INTERACTION_TIMEOUT_MS;
    const remainingMs = Math.max(0, budgetMs - (now - pending.startedAt));
    if (remainingMs <= 0) continue;
    // The budget ships WITH the remainder, for every kind. A client that has
    // only `remainingMs` cannot anchor a countdown: it is the budget minus the
    // time already spent, so a prompt listed six minutes into its ten reads as
    // a four-minute ask and runs out early (DOR-1330). Only the approval member
    // declared one before, so a question and an elicitation now inherit the
    // server-wide default here — the same number this line measured against, so
    // the two can never disagree.
    out.push({ ...dto, timeoutMs: budgetMs, remainingMs });
  }
  return out;
}
