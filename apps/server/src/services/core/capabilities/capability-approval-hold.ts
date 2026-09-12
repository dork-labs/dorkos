/**
 * In-session hold-and-await for agent-initiated destructive capability approvals
 * (DOR-939 / spec `approvals-resume-inline`).
 *
 * Today a destructive capability call an agent makes over the in-session `dorkos`
 * MCP server returns `approval_required` immediately and the turn ends; the person
 * approves on the dashboard, and then has to tell the agent to retry. This module
 * lets the tool call HOLD instead: it pushes the same approval card inline into
 * the session, waits for the operator's decision, and — on a grant — resumes the
 * held call and returns the REAL result in the same turn.
 *
 * ## The CAP: why ten minutes, and why that is a product choice
 *
 * The in-session `dorkos` server is an in-process `createSdkMcpServer`. When the
 * CLI executes one of its tools it sends an `mcp_message` control request and
 * awaits the response. Verified against the shipped stack (claude-agent-sdk
 * 0.3.177 → @modelcontextprotocol/sdk 1.29.0): the SDK-side dispatch
 * (`handleMcpControlRequest`) awaits a bare promise with NO timer, and the whole
 * control channel is timerless in the shipped JS — which is how the existing
 * 10-minute `can_use_tool` approval and MCP `elicitation` holds already ride it.
 *
 * This cap used to be 45s, justified as staying under the MCP SDK's
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` (60s). That justification was WRONG (DOR-987):
 * the 60s default applies only when a caller passes NO explicit timeout, and the
 * claude binary passes one on every MCP tool call — ~27.8h (`1e8` ms) unless
 * `MCP_TOOL_TIMEOUT` says otherwise, clamped to `[1000, 2^31-1]`. No 60s ceiling
 * governs this hold — and the 45s cap made the feature nearly useless, because
 * the approval window is two hours precisely so someone who stepped away can
 * still answer, and at 46s their "yes" resumed nothing.
 *
 * Ten minutes is therefore a UX and turn-budget decision, not an SDK limit. A
 * held call keeps the session locked and the turn open for as long as it waits,
 * which is a real cost to pay for one person's attention; ten minutes is the same
 * window the rest of the cockpit already gives a person to answer
 * (`SESSIONS.INTERACTION_TIMEOUT_MS`). Past the cap the hold is not an error: it
 * returns the exact payload today's poll flow returns, so the person can still
 * approve on the dashboard and the agent can still retry with its token — never
 * worse than the flow it replaces.
 *
 * Three consequences of the longer cap, all handled elsewhere and named here so
 * they are not rediscovered:
 *
 * - The cap now EQUALS `SESSIONS.TURN_STALL_TIMEOUT_MS`, and both clocks start on
 *   the inline card. The projector holds its stall-pause a little past the cap
 *   (`CAPABILITY_HOLD_PAUSE_GRACE_MS`) so the degrading resolution reaches the
 *   stream before the watchdog re-arms.
 * - `MCP_TOOL_TIMEOUT` is the one thing that CAN still cut a hold short, because
 *   the turn's subprocess inherits `process.env` and an operator may have lowered
 *   it for a flaky external server. The `dorkos` server declares its own per-call
 *   ceiling at cap + grace instead, so that variable no longer reaches this
 *   (`runtimes/claude-code/mcp-tools/tool-timeout.ts`; see the 0.3.268 note
 *   below, which is where the floor it used to apply went).
 * - `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` is NOT a risk, though the SDK's own d.ts
 *   comment ("if your SDK MCP calls will run longer than 60s, override
 *   CLAUDE_CODE_STREAM_CLOSE_TIMEOUT") reads like one. That variable does not
 *   exist anywhere in the shipped SDK or the claude binary — the comment is
 *   stale. The only stream-close kill is stdin EOF, and this turn's held prompt
 *   (`createHeldUserPrompt`, closed at the turn's `result`) keeps it disarmed all
 *   turn. Precedent in the same shape: `relay_send_and_wait` already blocks up to
 *   600s inside an SDK tool.
 *
 * The findings above are pinned to claude-agent-sdk 0.3.177 / claude 2.1.177.
 * Re-check them on a runtime upgrade rather than assuming they carried over.
 *
 * 2026-08-07, on the bump to 0.3.224 / claude 2.1.224 — PARTIALLY re-verified,
 * and the split matters:
 *
 * - **Re-verified** against the 0.3.224 binary: the MCP tool-call timeout is
 *   still `min(max(n, 1000), 2^31-1)` where `n` falls back to `1e8` ms (~27.8h)
 *   unless a per-server `timeout` or `MCP_TOOL_TIMEOUT` says otherwise. So no
 *   60s ceiling governs this hold, exactly as argued above. New at 0.3.224: a
 *   server's own config may carry `timeout`, and a value below 1000ms is ignored
 *   rather than honoured. `MCP_TOOL_TIMEOUT` remains the one thing that can cut a
 *   hold short, and at this bump DorkOS still floored it on the way in.
 * - **Re-verified**: `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` still does not exist
 *   anywhere in the shipped binary. The SDK d.ts comment naming it is still
 *   stale, and still not a risk.
 * - **NOT re-verified**: that `handleMcpControlRequest` awaits a bare promise
 *   with no timer, and that the control channel is timerless. That is the
 *   load-bearing claim for the ten-minute hold and it is still dated to 0.3.177.
 *   Treat it as unconfirmed at 0.3.224 until someone reads it again.
 *
 * 2026-09-11, on the bump to 0.3.268 — the per-server `timeout` the 0.3.224 note
 * spotted in the binary reached `createSdkMcpServer`'s own types at 0.3.248, and
 * DorkOS took it. The `dorkos` server now states cap + grace directly
 * (`runtimes/claude-code/mcp-tools/tool-timeout.ts`), and the environment floor
 * that used to stand in for it is gone: it could only be applied subprocess-wide,
 * so protecting this hold meant overriding whatever the operator had set for the
 * external server they were actually worried about. `MCP_TOOL_TIMEOUT` is
 * therefore no longer a way to cut a hold short, and no longer rewritten.
 *
 * @module services/core/capabilities/capability-approval-hold
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { ApprovalDecisionOutcome, ApprovalService } from '../approvals/index.js';
import type { ApprovalRequiredPayload } from './tier-enforcement.js';

/**
 * How long an in-session capability approval may HOLD before it degrades to
 * today's `approval_required` poll payload.
 *
 * Ten minutes — a UX/turn-budget choice, NOT an SDK ceiling. The module TSDoc
 * records what was once believed to bound this (60s) and why that was wrong.
 */
export const CAPABILITY_APPROVAL_HOLD_CAP_MS = 10 * 60_000;

/** The live session an in-session hold pushes its inline card onto. */
export interface CapabilityHoldSession {
  /** The turn's outbound event queue, drained into the session's SSE stream. */
  eventQueue: StreamEvent[];
  /** Wake the drain loop after a push, when the session wired one. */
  eventQueueNotify?: () => void;
}

/**
 * Everything an in-session capability call needs to hold on an approval: the
 * approval primitive to wait on, the session to render the inline card into, and
 * the SDK tool-call abort signal.
 */
export interface CapabilityApprovalHold {
  /**
   * The approval primitive — reads the card, waits for the decision, and owns the
   * single-delivery claim while it waits (see {@link awaitCapabilityApproval}).
   */
  approvals: Pick<
    ApprovalService,
    'awaitDecision' | 'getPending' | 'claimVerdictDelivery' | 'releaseVerdictDelivery'
  >;
  /** The live session whose inline card and stall-pause the hold drives. */
  session: CapabilityHoldSession;
  /** The held tool call's abort signal — a mid-turn interrupt ends the hold. */
  signal?: AbortSignal;
  /** Override the hold cap (tests). Defaults to {@link CAPABILITY_APPROVAL_HOLD_CAP_MS}. */
  capMs?: number;
}

/**
 * Push the inline capability-approval card onto the session's event queue.
 *
 * This is BOTH the inline card AND the registration the projector tracks as a
 * pending hold (so the stall watchdog pauses and the session lock is not stolen
 * while the person decides). It carries the same `PendingApproval` the dashboard
 * renders, so the person answers the identical card wherever they are standing.
 *
 * @returns Whether the card was emitted — false when the pending row is missing,
 *   which is what tells the caller not to emit a resolution for it either.
 */
function pushHoldCard(
  session: CapabilityHoldSession,
  payload: ApprovalRequiredPayload,
  approvals: Pick<ApprovalService, 'getPending'>,
  startedAt: number,
  capMs: number
): boolean {
  const approval = approvals.getPending(payload.approvalId);
  // The card cannot be rendered without the pending row (a store that vanished
  // between request and hold), so skip the inline card rather than push a
  // half-card the schema would reject — the poll payload still covers the caller.
  if (!approval) return false;
  session.eventQueue.push({
    type: 'capability_approval_required',
    data: { approval, startedAt, capMs },
  } as StreamEvent);
  session.eventQueueNotify?.();
  return true;
}

/** Push the resolution event that retires the inline card and drops the pending hold. */
function pushHoldResolved(
  session: CapabilityHoldSession,
  approvalId: string,
  outcome: ApprovalDecisionOutcome
): void {
  session.eventQueue.push({
    type: 'capability_approval_resolved',
    data: { approvalId, outcome },
  } as StreamEvent);
  session.eventQueueNotify?.();
}

/**
 * What a held call returns when its approval stopped being answerable while it
 * waited (spec `approval-expiry-notice`, DOR-1932).
 *
 * Deliberately NOT an `approval_required` payload with a different sentence: it
 * carries no `approvalToken` and no `retry` block, because there is nothing left
 * to retry with. Handing back the original payload — which is what a held call
 * did for this ending until DOR-1932 — told the agent to call again with a token
 * the sweep had just written off, and pointed it at a card that had already
 * disappeared from the person's list. Every one of those three claims was false
 * at the moment it was made.
 */
export interface ApprovalNoLongerValidPayload {
  /** Discriminator. Always `approval_no_longer_valid`. */
  status: 'approval_no_longer_valid';
  /** The capability that did NOT run. */
  capabilityId: string;
  /** Its human-facing title, as the operator's card showed it. */
  capabilityTitle: string;
  /** The approval that is now past answering. Safe to show or log. */
  approvalId: string;
  /** When the decision window closed. ISO 8601 UTC. */
  expiresAt: string;
  /** One plain sentence the model can act on. */
  message: string;
}

/**
 * Turn a held call's fresh ask into the answer for an approval that can no
 * longer be answered.
 *
 * **The wording covers two endings on purpose.** `awaitDecision` reports
 * `expired` both for a window that genuinely closed and for a token somebody
 * spent elsewhere while this hold waited (`toDecisionOutcome` folds `consumed`
 * into `expired`, because neither leaves the caller anything to resume on).
 * Naming only expiry would be a guess that is wrong half the time; what is true
 * in both cases, and is the only part the agent has to act on, is that this
 * request is finished and its token is dead.
 *
 * @param payload - The gate's fresh `approval_required` payload for this call.
 * @returns The payload to hand the model instead.
 */
export function approvalNoLongerValid(
  payload: ApprovalRequiredPayload
): ApprovalNoLongerValidPayload {
  return {
    status: 'approval_no_longer_valid',
    capabilityId: payload.capabilityId,
    capabilityTitle: payload.capabilityTitle,
    approvalId: payload.approvalId,
    expiresAt: payload.expiresAt,
    message:
      `The approval for "${payload.capabilityTitle}" is no longer open: nobody answered it in ` +
      'time, or it was already used. The token you were given will not work now, and there is ' +
      'no card left for anyone to answer. Do not retry with it and do not look for another way ' +
      'around it. If this still needs doing, say so plainly and ask for approval again; ' +
      'otherwise tell the person what you could not finish.',
  };
}

/**
 * Render the inline card, wait for the operator's decision (bounded by the hold
 * cap), then retire the card — whatever the outcome.
 *
 * The resolution event is pushed in a `finally`, so a throw or abort from the wait
 * can never strand the inline card or leave the projector's stall-pause latched —
 * but ONLY when a card was actually emitted. A resolution for a card nobody saw
 * retires nothing and untracks a hold nobody registered, so it is pure noise on
 * the transcript (DOR-987).
 *
 * ## The delivery claim, and why it is taken HERE (spec `approval-verdict-delivery`)
 *
 * A hold is not the only thing that can tell an agent how its approval ended. Past
 * the cap the call returns the poll payload and the turn ends, so an answer given
 * at minute twenty reaches nobody — which is what the out-of-band deliverer
 * (`approvals/approval-verdict-delivery.ts`) exists to fix. Both wake on the SAME
 * `approval_resolved` broadcast, so exactly one of them may speak.
 *
 * **The claim is taken when the wait STARTS, not when the decision lands.** A hold
 * that is waiting WILL deliver — through its own return value, in the same turn —
 * so the other path has to be locked out for the whole wait. Claiming at the
 * decision instead is a race a person can lose in either direction: two turns for
 * one answer, or none at all.
 *
 * **And a hold that gives up without a decision hands the claim back**, in the
 * same `finally`, or a person answering an hour later would find the delivery
 * spoken for by something long gone. `awaitDecision` never rejects — an abort
 * resolves `'timeout'` — so that release is reached on every non-decision ending.
 * Only a claim this call actually WON is released; one the other path already
 * held is left exactly where it is.
 *
 * @param hold - The approval primitive, session, abort signal, and cap.
 * @param payload - The gate's fresh `approval_required` payload for this call.
 * @returns How the wait ended; the caller resumes on `granted`/`denied` and
 *   degrades to the poll payload on `expired`/`timeout`.
 */
export async function awaitCapabilityApproval(
  hold: CapabilityApprovalHold,
  payload: ApprovalRequiredPayload
): Promise<ApprovalDecisionOutcome> {
  const capMs = hold.capMs ?? CAPABILITY_APPROVAL_HOLD_CAP_MS;
  const startedAt = Date.now();
  const emitted = pushHoldCard(hold.session, payload, hold.approvals, startedAt, capMs);
  // Before the await, never after it — see the module's "delivery claim" note.
  // `false` here means the other path already owns the delivery (or this approval
  // names no session to deliver to); the hold waits and resumes either way.
  const claimed = hold.approvals.claimVerdictDelivery(payload.approvalId);

  let outcome: ApprovalDecisionOutcome = 'timeout';
  try {
    outcome = await hold.approvals.awaitDecision(payload.approvalId, {
      timeoutMs: capMs,
      ...(hold.signal ? { signal: hold.signal } : {}),
    });
    return outcome;
  } finally {
    // An ending this call REPORTS is delivered by its own return value, so the
    // claim stays spent. Only `timeout` leaves the answer still owed: the window
    // is still open, the card is still on the dashboard, and whoever answers
    // later must reach the agent through the out-of-band deliverer.
    //
    // `expired` moved out of that set with DOR-1932. It used to be released
    // here, which was pointless AND wrong: the sweep that settled the row had
    // already broadcast, the deliverer had already lost the claim to this hold
    // and dropped the notice, and no second broadcast was ever coming — so
    // releasing invited a delivery nothing would trigger, while the caller went
    // on to report the ending itself.
    if (claimed && outcome === 'timeout') {
      hold.approvals.releaseVerdictDelivery(payload.approvalId);
    }
    if (emitted) pushHoldResolved(hold.session, payload.approvalId, outcome);
  }
}
