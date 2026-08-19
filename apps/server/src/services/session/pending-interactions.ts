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
 * **This module decides the budget twice over**, and the second consumer is
 * easy to miss: {@link listPendingInteractions} is what ships to the WIRE, and
 * it is also what `SessionStateProjector.hasPendingInteractions` delegates to.
 * So raising the budget here raises the window the stall watchdog and the
 * session write-lock tolerate a silent turn for. Parking a prompt does exactly
 * that (spec `ask-parks-on-timeout` §3). It is intended, it is bounded by
 * {@link SESSIONS.INTERACTION_PARK_CEILING_MS}, and it is not a side effect to
 * be discovered later.
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
 * each interaction's `startedAt`, then excludes any entry that has already run
 * out of both its budget and its park (`remainingMs <= 0`) so the client never
 * re-presents a dead prompt. `now` is injected (rather than read from
 * `Date.now()`) so callers — and tests — control the clock deterministically.
 * Each boundary is exclusive: when the elapsed time equals a budget, that
 * budget's remainder is `0`.
 *
 * The budget is the interaction's OWN `timeoutMs` when it declared one, and the
 * server-wide countdown only as a fallback. Measuring every interaction against
 * the global constant made a DTO argue with itself — a 120-second ask shipped
 * `timeoutMs: 120000` beside `remainingMs: 562000`, so the card drew a bar past
 * its own maximum and announced nine minutes left on an ask with eighty-five
 * seconds to live (DOR-810).
 *
 * Past that budget the entry is **parked**, not dropped: it ships `parked: true`
 * with no `timeoutMs` and a remainder counting down to
 * {@link SESSIONS.INTERACTION_PARK_CEILING_MS} from `startedAt`. Nobody
 * announces the park — it is a function of `startedAt` and the declared budget,
 * both of which are already carried, so a second copy would be a second answer
 * free to disagree (spec `ask-parks-on-timeout` §1).
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
    // Parked is DERIVED, never stored: a prompt that has outlived the budget it
    // declared is one nobody answered in time, which is exactly the condition
    // the runtime's own park timer fires on. Computing it here rather than
    // folding a broadcast event means every runtime that can raise a prompt
    // parks, and there is no second copy of the rule to drift (spec
    // `ask-parks-on-timeout` §1).
    const declaredMs = dto.timeoutMs ?? SESSIONS.INTERACTION_TIMEOUT_MS;
    const elapsedMs = now - pending.startedAt;
    const parked = elapsedMs >= declaredMs;
    const budgetMs = parked ? SESSIONS.INTERACTION_PARK_CEILING_MS : declaredMs;
    const remainingMs = Math.max(0, budgetMs - elapsedMs);
    if (remainingMs <= 0) continue;
    if (parked) {
      // `timeoutMs` is deliberately DROPPED rather than set to the ceiling. It
      // is what the card draws its draining bar against, and a four-hour bar is
      // a siren for a non-event. The ceiling is real and `remainingMs` still
      // carries it, which is what the stall watchdog and the write-lock read;
      // it is simply not a countdown anybody should be made to watch.
      const { timeoutMs: _budgetNotShown, ...rest } = dto;
      out.push({ ...rest, parked: true, remainingMs });
      continue;
    }
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
