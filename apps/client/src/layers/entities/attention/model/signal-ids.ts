/**
 * The id and kind vocabulary a blockage is named in — the one place that
 * decides, and the reason two different-shaped derivations of "what needs
 * you" cannot quietly disagree.
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
 * moment it has the interaction in hand (its fallback, `blocked:<sessionId>`,
 * applies only when no interaction has arrived yet, which never lacks an
 * interaction to name here).
 *
 * @param interactionId - The prompt's own id, stable across polls.
 */
export function interactionSignalId(interactionId: string): string {
  return `blocked:${interactionId}`;
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
