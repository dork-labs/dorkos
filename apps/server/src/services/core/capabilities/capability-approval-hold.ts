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
 * ## The GATE: why the hold is capped well below 60s
 *
 * The in-session `dorkos` server is an in-process `createSdkMcpServer`. When the
 * CLI executes one of its tools it sends an `mcp_message` control request and
 * awaits the response. Verified against the shipped stack (claude-agent-sdk
 * 0.3.177 → @modelcontextprotocol/sdk 1.29.0): the SDK-side dispatch
 * (`handleMcpControlRequest`) awaits a bare promise with NO timer, and the whole
 * control channel is timerless in the shipped JS — which is how the existing
 * 10-minute `can_use_tool` approval and MCP `elicitation` holds already ride it.
 * The MCP client's own request timeout is
 * {@link MCP_SDK_REQUEST_TIMEOUT_MS} (`DEFAULT_REQUEST_TIMEOUT_MSEC = 60000`), but
 * whether the native CLI applies it to the `mcp_message` round trip cannot be read
 * from the shipped binary. So the hold is capped CONSERVATIVELY at
 * {@link CAPABILITY_APPROVAL_HOLD_CAP_MS}, well below that 60s, leaving headroom
 * for the post-grant re-invoke — and if the person does not answer inside the cap
 * the held call degrades to today's `approval_required` payload, which is never
 * worse than the poll flow it replaces.
 *
 * @module services/core/capabilities/capability-approval-hold
 */
import type { StreamEvent } from '@dorkos/shared/types';
import type { ApprovalDecisionOutcome, ApprovalService } from '../approvals/index.js';
import type { ApprovalRequiredPayload } from './tier-enforcement.js';

/**
 * The MCP client request timeout the shipped SDK stack applies by default —
 * `DEFAULT_REQUEST_TIMEOUT_MSEC` in `@modelcontextprotocol/sdk` 1.29.0. The hold
 * cap is asserted to stay below this so a held call can never outlive the request
 * that carries it (see the module TSDoc for why this number is the ceiling).
 */
export const MCP_SDK_REQUEST_TIMEOUT_MS = 60_000;

/**
 * How long an in-session capability approval may HOLD before it degrades to
 * today's `approval_required` poll payload.
 *
 * Conservatively below {@link MCP_SDK_REQUEST_TIMEOUT_MS}, leaving ~15s of
 * headroom for the post-grant re-invoke (consume + the real capability call) to
 * also complete inside the request window. Past this cap the hold is not an
 * error — it returns the exact payload today's poll flow returns, so the person
 * can still approve on the dashboard and the agent can still retry with its token.
 */
export const CAPABILITY_APPROVAL_HOLD_CAP_MS = 45_000;

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
 */
function pushHoldCard(
  session: CapabilityHoldSession,
  payload: ApprovalRequiredPayload,
  approvals: Pick<ApprovalService, 'getPending'>,
  startedAt: number,
  capMs: number
): void {
  const approval = approvals.getPending(payload.approvalId);
  // The card cannot be rendered without the pending row (a store that vanished
  // between request and hold), so skip the inline card rather than push a
  // half-card the schema would reject — the poll payload still covers the caller.
  if (!approval) return;
  session.eventQueue.push({
    type: 'capability_approval_required',
    data: { approval, startedAt, capMs },
  } as StreamEvent);
  session.eventQueueNotify?.();
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
 * can never strand the inline card or leave the projector's stall-pause latched.
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
  pushHoldCard(hold.session, payload, hold.approvals, startedAt, capMs);

  let outcome: ApprovalDecisionOutcome = 'timeout';
  try {
    outcome = await hold.approvals.awaitDecision(payload.approvalId, {
      timeoutMs: capMs,
      ...(hold.signal ? { signal: hold.signal } : {}),
    });
    return outcome;
  } finally {
    pushHoldResolved(hold.session, payload.approvalId, outcome);
  }
}
