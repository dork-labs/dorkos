/**
 * Telling an agent how its approval ended, after it stopped waiting
 * (spec `approval-verdict-delivery`, DOR-1931).
 *
 * ## The gap this closes
 *
 * A destructive tool call HOLDS while a person decides (DOR-939/DOR-1930), and
 * on an answer it resumes in the same turn. But the hold caps at ten minutes
 * (`CAPABILITY_APPROVAL_HOLD_CAP_MS`) and the approval window is two hours, so an
 * answer given at minute twenty reaches nobody: the call returned its poll
 * payload long ago and the turn has ended. That is the reported bug — an operator
 * approved four `mesh_unregister` cards, the agent that asked was never told, and
 * they opened its session and relayed the decision by hand.
 *
 * ## Why waking a session is the answer, and not staging the words
 *
 * `takeStagedContext` is folded in exactly one place — inside a dispatch, in
 * `session/trigger-turn.ts` — so context parked for a session lands only when
 * somebody sends that session another message. If the session is idle, nothing
 * fires and the person still has to go poke the agent, which IS the original
 * complaint. So the answer has to start a turn.
 *
 * That costs tokens, and it is a deliberate trade rather than an oversight:
 * a verdict is a decision the agent ASKED for and is blocked on, which is a
 * different thing from the "your server connected" nudge `mcp-signin-resume`
 * sends. Two consequences follow from that difference:
 *
 * - **A denial wakes a session exactly as a grant does.** A refusal may need to
 *   reach an agent that is mid-work on the assumption it was allowed, which is
 *   the one case where arriving late matters most.
 * - **A busy session QUEUES rather than refusing.** `mcp-signin-resume` refuses,
 *   because its nudge stops being useful the moment the agent gets on with the
 *   work anyway. A verdict never stops being useful, and dropping it here would
 *   recreate the silence this module exists to end.
 *
 * ## Exactly one delivery, decided by a write
 *
 * The in-session hold and this module both wake on the SAME `approval_resolved`
 * broadcast, so a check-then-act between them lets both through. The claim
 * (`ApprovalService.claimVerdictDelivery`) is a conditional update — the same
 * shape that makes a token single-use — so "exactly one delivery" is true by
 * construction. The hold takes the claim when it STARTS waiting and hands it back
 * only if it gives up without a decision.
 *
 * A claim can also be stranded rather than released — a restart kills the process
 * a hold lived in, and its `finally` with it. `ApprovalService.releaseStaleVerdictClaims`
 * sweeps those at boot; without it a restart mid-decision reproduced this exact
 * bug one layer down.
 *
 * ## The claim and the wake are one write (spec `turns-survive-restarts` §6.3, T7)
 *
 * Delivery is a wake (`wake_chat`), keyed by the approval's own id and saved in
 * the transaction that takes the claim. So a restart after the claim never
 * strands an answer that was claimed and not yet sent, and the run the wake
 * makes is keyed the same way, so the agent is told once. Everything after the
 * write (is the chat still stored, is it busy, is its agent paused) is the
 * wake's to decide, with retries, and a chat that is gone drops the wake: the
 * claim stays, as a settled ending.
 *
 * ## Which surfaces a verdict can actually reach, and why that is not every one
 *
 * Delivery needs a server-bound ADDRESS. The in-session Claude Code server and
 * the private `/agent-mcp` endpoints injected into Codex and OpenCode turns
 * record one from the authenticated turn principal at injection time. The
 * public external `/mcp` server has no authenticated turn address, so approvals
 * requested through that surface retain the token-and-poll flow.
 *
 * An address must never be caller-asserted. A session id arriving in a header is
 * a session id an agent chose, and a delivery address an agent chooses is a way
 * to make DorkOS start a turn in somebody else's session. Runtime injection
 * derives the address from the authenticated principal instead; no header or
 * caller-selected session can choose the delivery target.
 *
 * The RENDERING is cross-runtime regardless, and deliberately so: the shared
 * writer is what stops a verdict reading as a formatted block on one runtime and
 * a JSON dump on the others the moment an address does exist.
 *
 * ## Why the fan-out listener only writes
 *
 * `eventFanOut` listeners run synchronously on the broadcast write path, ahead of
 * every connected client, and its own contract says work that is not cheap
 * belongs on a queue the listener owns. The listener does one read and one
 * write: the claim and the wake. The outbox is that queue; the runtime resolve,
 * a possible cold start and the turn are its worker's.
 *
 * @module services/core/approvals/approval-verdict-delivery
 */
import type { ApprovalOutcome } from '@dorkos/shared/approval-schemas';
import type { ApprovalVerdictData } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';
import type { WakeRequest } from '@dorkos/shared/turn-port';

import { logger } from '../../../lib/logger.js';
import { eventFanOut } from '../event-fan-out.js';
import { peekProjector } from '../../session/index.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import type { ApprovalService } from './approval-service.js';
import { ceilingForContinuation } from '../turn-power/continuation-hold.js';

/** The approval primitive this module needs — no more of it than that. */
type VerdictSource = Pick<ApprovalService, 'verdictDelivery' | 'claimVerdictDelivery'>;

/**
 * Saves a wake, and the claim with it, in one write: the run record's
 * `wakeChat`, handed in at startup (this domain never imports the record).
 */
export type VerdictWake = (request: WakeRequest, claim: () => boolean) => boolean;

/**
 * The turn's own `content`, wrapped in the registered `approval_verdict` tag.
 *
 * The SUBSTANCE rides `additionalContext`, where each adapter renders it through
 * the shared formatter — that is the whole reason the kind exists. This string is
 * only the turn's reason for being, and it is tagged rather than bare for two
 * properties a registered `CONTEXT_TAG` gives for free: `stripInjectedTagBlocks`
 * removes it from the rendered transcript, so it never appears as a message the
 * person typed, and the block formatters defuse the tag wherever untrusted text
 * could carry it.
 *
 * (`mcp-signin-resume` dispatches a `<ui_action>` envelope, and `ui_action` is
 * NOT in `CONTEXT_TAG` — so it gets neither. That is a precedent to understand,
 * not to copy.)
 */
const DECIDED_TRIGGER = [
  `<${CONTEXT_TAG.approval_verdict}>`,
  'A person answered an approval you asked for, after you had stopped waiting for it.',
  'The decision is in this turn’s approval_verdict context. Act on it.',
  `</${CONTEXT_TAG.approval_verdict}>`,
].join('\n');

/**
 * The same envelope for the ending nobody chose (spec `approval-expiry-notice`).
 *
 * Separate prose rather than a parameter, because {@link DECIDED_TRIGGER} states
 * as fact that a person answered — and an expiry is precisely the case where
 * nobody did. The turn's reason for being has to be true.
 */
const EXPIRED_TRIGGER = [
  `<${CONTEXT_TAG.approval_verdict}>`,
  'An approval you asked for ran out of time. Nobody answered it, and it can no longer be',
  'answered. The details are in this turn’s approval_verdict context. Act on it.',
  `</${CONTEXT_TAG.approval_verdict}>`,
].join('\n');

/** The turn content for one outcome. */
const TRIGGER_CONTENT: Record<ApprovalVerdictData['outcome'], string> = {
  granted: DECIDED_TRIGGER,
  denied: DECIDED_TRIGGER,
  expired: EXPIRED_TRIGGER,
};

/**
 * Deliver one approval's verdict to the session that asked for it: take the
 * delivery claim and save the wake that carries the answer, in one write.
 *
 * Never throws: it runs on a broadcast nothing is awaiting, so a failure here
 * must not escape into whoever wrote the decision. Every way it can decline is
 * a log line or a `false`.
 *
 * @param approvals - The approval store, for the row and the delivery claim.
 * @param approvalId - The approval a person has just answered.
 * @param wake - Saves the wake with the claim.
 * @returns Whether this call took the claim and saved the wake.
 */
export function deliverApprovalVerdict(
  approvals: VerdictSource,
  approvalId: string,
  wake: VerdictWake
): boolean {
  try {
    // Read first, because it is cheap and it answers "is there anywhere to
    // deliver to at all" — the sessionless surfaces and the still-pending rows
    // never reach the claim.
    const delivery = approvals.verdictDelivery(approvalId);
    if (!delivery) return false;
    const { sessionId, cwd, verdict } = delivery;
    // WHERE the turn runs. The ROW's directory wins: the projector registry
    // empties on restart and an approval outlives one easily inside two hours,
    // which is the DOR-981 lesson and the reason the column exists. The two
    // fallbacks behind it are not decoration: a session can reach the gate with
    // no directory of its own (`UiToolSession.cwd` is optional), and an empty
    // one once moved a running session to nowhere. `mcp-signin-resume.ts` carries
    // the same three-step ladder.
    const workingDir = cwd ?? peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;
    // Losing the claim means the in-session hold is waiting on this same
    // approval and will report the answer itself, in the turn the agent is
    // still running: then nothing is saved.
    return wake(
      {
        sourceKind: 'approval',
        eventId: approvalId,
        start: {
          sessionId,
          cwd: workingDir,
          content: TRIGGER_CONTENT[verdict.outcome],
          // DorkOS carries the bound chat on with the verdict: it adds no power to it.
          origin: { kind: 'resume' },
          tier: 'owner',
          // The structured verdict, rendered per adapter through the shared writer.
          approvalVerdict: verdict,
          // Held when the chat's latest turn was, as every turn nobody asked for is (DOR-3037).
          ...ceilingForContinuation(sessionId),
          // No deadline: a busy chat waits rather than refusing. An answer that
          // arrives after the current turn is still the answer; one that is
          // dropped is the bug this module exists to fix.
        },
        // The live session map empties on restart and on eviction, while an
        // approval outlives both. A stored session cold-starts; one that exists
        // nowhere is gone for good, and the wake is dropped with the claim kept.
        onlyIfChatExists: { cwd: workingDir },
      },
      () => approvals.claimVerdictDelivery(approvalId)
    );
  } catch (err) {
    // The claim rolled back with the wake, so the answer is still owed.
    logger.warn('[approval-verdict] could not save the verdict’s wake', {
      approvalId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Start listening for answered approvals, and deliver each one to the session
 * that asked.
 *
 * The listener itself does nothing but hand off — see the module doc for why
 * that is a contract of `eventFanOut.subscribe` rather than a style choice.
 *
 * Three of the four outcomes are delivered: the two decisions, and `expired` —
 * an approval whose window closed with nobody answering, which is an ending the
 * agent is just as blocked on (spec `approval-expiry-notice`, DOR-1932).
 *
 * `consumed` is the one that is deliberately dropped, and it is not an oversight:
 * the ordinary grant flow settles TWICE for one subject — once when the operator
 * decides and again when the agent spends the token — so honoring `consumed`
 * would wake a session about a decision it had already been told about, or had
 * just acted on itself.
 *
 * @param approvals - The approval store to read verdicts and claims from.
 * @param wake - Saves each verdict's wake with its claim.
 * @returns An unsubscribe function. Idempotent.
 */
export function startApprovalVerdictDelivery(
  approvals: VerdictSource,
  wake: VerdictWake
): () => void {
  return eventFanOut.subscribe((eventName, data) => {
    if (eventName !== 'approval_resolved') return;
    const payload = data as { approvalId?: string; outcome?: ApprovalOutcome };
    if (
      payload.outcome !== 'granted' &&
      payload.outcome !== 'denied' &&
      payload.outcome !== 'expired'
    ) {
      return;
    }
    const approvalId = payload.approvalId;
    if (!approvalId) return;
    // One read and one write on the broadcast's path; the turn is the outbox's.
    deliverApprovalVerdict(approvals, approvalId, wake);
  });
}
