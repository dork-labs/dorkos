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
 * ## Why the fan-out listener does nothing but hand off
 *
 * `eventFanOut` listeners run synchronously on the broadcast write path, ahead of
 * every connected client, and its own contract says work that is not cheap
 * belongs on a queue the listener owns. A delivery is a database read, a runtime
 * resolve, a possible session cold-start and a dispatch — so the listener returns
 * immediately and the delivery runs detached, with its own error handling.
 *
 * @module services/core/approvals/approval-verdict-delivery
 */
import type { ApprovalOutcome } from '@dorkos/shared/approval-schemas';
import type { ApprovalVerdictData } from '@dorkos/shared/additional-context';
import { CONTEXT_TAG } from '@dorkos/shared/additional-context';

import { logger } from '../../../lib/logger.js';
import { eventFanOut } from '../event-fan-out.js';
import { runtimeRegistry } from '../runtime-registry.js';
import {
  dispatchMessage,
  getOrCreateProjector,
  peekProjector,
  persistenceModeFor,
} from '../../session/index.js';
import { DEFAULT_CWD } from '../../../lib/resolve-root.js';
import type { ApprovalService } from './approval-service.js';

/** The approval primitive this module needs — no more of it than that. */
type VerdictSource = Pick<
  ApprovalService,
  'verdictDelivery' | 'claimVerdictDelivery' | 'releaseVerdictDelivery'
>;

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
 * Deliver one approval's verdict to the session that asked for it.
 *
 * Never throws and never rejects: it runs detached from a broadcast nothing is
 * awaiting, so a failure here must not escape into whoever wrote the decision.
 * Every way it can decline is a log line.
 *
 * @param approvals - The approval store, for the row and the delivery claim.
 * @param approvalId - The approval a person has just answered.
 */
export async function deliverApprovalVerdict(
  approvals: VerdictSource,
  approvalId: string
): Promise<void> {
  // Tracked so a failure can hand the claim BACK. `notified_at` means
  // "delivered", not "attempted": every throw below happens before a turn is
  // accepted, so keeping the claim on one would mark an answer delivered that
  // nobody received and lock out every later attempt at it. Found live, on a
  // session whose recorded directory sat outside the DorkOS boundary — the
  // resolve threw, the row said `notified_at`, and the agent was never told.
  let claimed = false;
  try {
    // Read first, because it is cheap and it answers "is there anywhere to
    // deliver to at all" — the sessionless surfaces and the still-pending rows
    // never reach the claim.
    const delivery = approvals.verdictDelivery(approvalId);
    if (!delivery) return;

    // The claim decides the race with the in-session hold. Losing it means the
    // hold is waiting on this same approval and will report the answer itself,
    // in the turn the agent is still running.
    if (!approvals.claimVerdictDelivery(approvalId)) return;
    claimed = true;

    const { sessionId, cwd, verdict } = delivery;
    const runtime = await runtimeRegistry.resolveForSession(sessionId);
    // WHERE the turn runs, resolved once and threaded through every hop that
    // takes one. The ROW's directory wins: the projector registry empties on
    // restart and an approval outlives one easily inside two hours, which is the
    // DOR-981 lesson and the reason the column exists.
    //
    // The two fallbacks behind it are not decoration. A session can reach the
    // gate with no directory of its own (`UiToolSession.cwd` is optional), and an
    // earlier version of this line read `cwd ?? ''` — which then STAMPED `''`
    // onto the live session's own projector two calls down, moving a running
    // session to nowhere. `mcp-signin-resume.ts:154` has carried this exact
    // three-step ladder since DOR-981; this is the same ladder, not a new one.
    const workingDir = cwd ?? peekProjector(sessionId)?.cwd ?? DEFAULT_CWD;
    // The live session map empties on restart and on eviction, while an approval
    // outlives both. A stored session cold-starts through the dispatcher; one
    // that exists nowhere is gone for good and there is nothing to tell.
    if (!runtime.hasSession(sessionId)) {
      if (!(await runtime.getSession(workingDir, sessionId))) {
        // The claim is KEPT here, unlike on the error path below, and the
        // difference is the whole distinction: a session that is gone will not
        // come back, so this is a settled ending rather than a failed attempt.
        // Releasing would leave the row inviting attempts that can only ever
        // reach the same conclusion.
        logger.info('[approval-verdict] session is gone — nobody left to tell', {
          sessionId,
          approvalId,
        });
        return;
      }
    }

    const projector = getOrCreateProjector(sessionId, workingDir, {
      persist: persistenceModeFor(runtime.getCapabilities()),
    });
    projector.cwd = workingDir;

    await dispatchMessage({
      sessionId,
      clientId: `approval-verdict-${approvalId}`,
      content: TRIGGER_CONTENT[verdict.outcome],
      cwd: workingDir,
      projector,
      runtime,
      // The structured verdict, rendered per adapter through the shared writer.
      approvalVerdict: verdict,
      // Queued rather than refused — see the module doc. An answer that arrives
      // after the current turn is still the answer; one that is dropped is the
      // bug this module exists to fix.
      whenBusy: 'queue',
      onError: (err) => {
        logger.warn('[approval-verdict] detached turn error', {
          sessionId,
          approvalId,
          error: err instanceof Error ? err.message : String(err),
        });
      },
    });
  } catch (err) {
    // Nothing reached the agent, so the answer is still owed: hand the claim
    // back rather than leaving the row saying somebody was told. Releasing here
    // cannot buy a double delivery, on any outcome — a decided approval is never
    // re-decided (`decide` refuses a non-pending row), and an expired one is
    // spent by the sweep that settled it (`sweepExpired` skips rows with a
    // `consumedAt`), so in neither case is there a second broadcast for a second
    // claimant to win.
    if (claimed) approvals.releaseVerdictDelivery(approvalId);
    logger.warn('[approval-verdict] could not deliver the verdict', {
      approvalId,
      error: err instanceof Error ? err.message : String(err),
    });
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
 * @returns An unsubscribe function. Idempotent.
 */
export function startApprovalVerdictDelivery(approvals: VerdictSource): () => void {
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
    // Detached on purpose: everything below this line is a database read, a
    // runtime resolve and a dispatch, and this listener is on the broadcast's
    // synchronous write path ahead of every connected client.
    void deliverApprovalVerdict(approvals, approvalId);
  });
}
