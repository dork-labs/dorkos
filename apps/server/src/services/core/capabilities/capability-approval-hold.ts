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
 * claude binary passes one on every MCP tool call (its default is hours;
 * `MCP_TOOL_TIMEOUT` overrides it). No 60s ceiling governs this hold — and the
 * 45s cap made the feature nearly useless, because the approval window is two
 * hours precisely so someone who stepped away can still answer, and at 46s their
 * "yes" resumed nothing.
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
 * Two consequences of the longer cap, both handled elsewhere and named here so
 * they are not rediscovered:
 *
 * - The cap now EQUALS `SESSIONS.TURN_STALL_TIMEOUT_MS`, and both clocks start on
 *   the inline card. The projector holds its stall-pause a little past the cap
 *   (`CAPABILITY_HOLD_PAUSE_GRACE_MS`) so the degrading resolution reaches the
 *   stream before the watchdog re-arms.
 * - One contrary signal, unresolved: the SDK documents
 *   `CLAUDE_CODE_STREAM_CLOSE_TIMEOUT` (60s) as the thing to raise "if your SDK
 *   MCP calls will run longer than 60s". It is a stream-CLOSE timeout and the
 *   turn's prompt stream stays open until the turn's `result`, so it should not
 *   arm mid-turn — but if a long hold is ever seen dying at ~60s, that variable
 *   is the first suspect.
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
  /** The approval primitive — reads the card and waits for the decision. */
  approvals: Pick<ApprovalService, 'awaitDecision' | 'getPending'>;
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
 * Render the inline card, wait for the operator's decision (bounded by the hold
 * cap), then retire the card — whatever the outcome.
 *
 * The resolution event is pushed in a `finally`, so a throw or abort from the wait
 * can never strand the inline card or leave the projector's stall-pause latched —
 * but ONLY when a card was actually emitted. A resolution for a card nobody saw
 * retires nothing and untracks a hold nobody registered, so it is pure noise on
 * the transcript (DOR-987).
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

  let outcome: ApprovalDecisionOutcome = 'timeout';
  try {
    outcome = await hold.approvals.awaitDecision(payload.approvalId, {
      timeoutMs: capMs,
      ...(hold.signal ? { signal: hold.signal } : {}),
    });
    return outcome;
  } finally {
    if (emitted) pushHoldResolved(hold.session, payload.approvalId, outcome);
  }
}
