/**
 * The id and kind vocabulary a blockage is named in — the one place that
 * decides, for every signal `deriveAttentionSignals` can raise, session-only
 * or not.
 *
 * {@link deriveAttentionSignals} (session-granular: one row per blocked
 * session, for the Heads Up zone and the arrival watch behind the knock and
 * the OS banner) and {@link deriveWaitingItems} (item-granular: one entry per
 * raw approval/ask/schedule, for the Inbox popover's cards and count) answer
 * a different QUESTION — how many rows does a burst of three asks from one
 * agent produce — but they must never answer a DIFFERENT question about the
 * same single item: whether one particular approval, ask or schedule counts
 * as a permission prompt, a question, or a scheduled run, and what id names
 * it. Before this, that decision was inlined twice — once in
 * `deriveAttentionSignals`'s session loop, and, had `deriveWaitingItems` been
 * written independently, a second time there — which is exactly the shape of
 * drift spec `schedule-approval-experience` §C4 calls out: a future
 * interaction type reclassified in one place and not the other would make
 * the pill and the knock disagree about the same event.
 *
 * Two of the five functions below — {@link blockedSessionSignalId} and
 * {@link errorSessionSignalId} — have only one caller: `deriveWaitingItems`
 * reads no session at all, so a session-only blockage (an unanswered `blocked`
 * with no interaction yet, or an `error`) never reaches it. They live here
 * anyway rather than staying inlined in `derive-attention-signals.ts`, so this
 * file is the complete, unambiguous answer to "what id does THIS blockage
 * carry" for all five shapes a blockage can take, not four of the five.
 *
 * @module entities/attention/model/signal-ids
 */
import type { PendingInteractionDTO } from '@dorkos/shared/types';

/** The id a capability approval's blockage carries, whichever derivation asks. */
export function approvalSignalId(approvalId: string): string {
  return `approval:${approvalId}`;
}

/** The id a parked schedule's blockage carries, whichever derivation asks. */
export function scheduleSignalId(taskId: string): string {
  return `schedule:${taskId}`;
}

/**
 * The id a captured prompt's blockage carries, whichever derivation asks.
 *
 * Namespaced `blocked:` rather than `ask:` because {@link deriveAttentionSignals}
 * minted this id first, for the session it interrupted — the id this function
 * now builds for one interaction is the same one that derivation lands on the
 * moment it has the interaction in hand ({@link blockedSessionSignalId} covers
 * its fallback, for the window before an interaction has arrived).
 *
 * @param interactionId - The prompt's own id, stable across polls.
 */
export function interactionSignalId(interactionId: string): string {
  return `blocked:${interactionId}`;
}

/**
 * The id a `blocked` session's blockage carries before its prompt has arrived.
 *
 * `deriveAttentionSignals`-only: a session with no captured interaction yet
 * has nothing for {@link deriveWaitingItems} to build an item from, so this
 * fallback never reaches the popover's per-item count. It exists here anyway,
 * beside {@link interactionSignalId}, so the `blocked:` namespace has exactly
 * one owner instead of two — this function for the id a session carries before
 * its prompt is known, that one for the id the same blockage carries once it
 * is.
 *
 * @param sessionId - The blocked session's own id.
 */
export function blockedSessionSignalId(sessionId: string): string {
  return `blocked:${sessionId}`;
}

/**
 * The id a session stopped with an error carries.
 *
 * `deriveAttentionSignals`-only, for the same reason as
 * {@link blockedSessionSignalId}: an errored session raises no approval, no
 * ask and no schedule, so {@link deriveWaitingItems} never needs to name one.
 *
 * @param sessionId - The errored session's own id.
 */
export function errorSessionSignalId(sessionId: string): string {
  return `error:${sessionId}`;
}

/**
 * Whether a captured prompt reads as a question or a permission prompt.
 *
 * An MCP elicitation is not its own kind — it is a prompt from a server
 * rather than the agent itself, but the operator answers it exactly like a
 * permission ask, so it reads as one.
 *
 * @param type - The prompt's own discriminant.
 */
export function interactionSignalKind(
  type: PendingInteractionDTO['type']
): 'question' | 'permission-prompt' {
  return type === 'question' ? 'question' : 'permission-prompt';
}
