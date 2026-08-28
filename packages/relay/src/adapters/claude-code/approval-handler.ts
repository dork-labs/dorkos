/**
 * Approval response handler for the Claude Code adapter.
 *
 * Subscribes to `relay.system.approval.>` to receive tool approval decisions
 * published by chat adapters (Slack, Telegram) when users click Approve/Deny
 * on interactive approval cards.
 *
 * Extracted from ClaudeCodeAdapter to keep each sub-module focused on a single
 * responsibility.
 *
 * @module relay/adapters/claude-code-approval-handler
 */

import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, Unsubscribe } from '../../types.js';
import type { AgentRuntimeLike } from './types.js';

/** Subject pattern for approval responses from all chat adapters. */
export const APPROVAL_SUBJECT_PATTERN = 'relay.system.approval.>';

/**
 * Shape of the payload published by chat adapters when a user clicks
 * Approve or Deny on a tool approval card.
 */
interface ApprovalPayload {
  type: 'approval_response';
  /** The tool call ID to approve or deny. */
  toolCallId: string;
  /** The CCA session key (ccaSessionKey used in ensureSession/sendMessage). */
  sessionId: string;
  /** Whether the tool was approved (true) or denied (false). */
  approved: boolean;
  /** Platform user identifier (e.g., Slack user ID, Telegram user ID). */
  respondedBy?: string;
  /** The chat adapter platform that sent this response. */
  platform?: string;
}

/**
 * Parse and validate an approval response payload from a relay envelope.
 *
 * Returns null for non-approval payloads or payloads with missing required fields.
 *
 * @param payload - The unknown payload from a RelayEnvelope
 */
function parseApprovalPayload(payload: unknown): ApprovalPayload | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.type !== 'approval_response') return null;
  if (typeof obj.toolCallId !== 'string' || !obj.toolCallId) return null;
  if (typeof obj.sessionId !== 'string' || !obj.sessionId) return null;
  if (typeof obj.approved !== 'boolean') return null;
  return {
    type: 'approval_response',
    toolCallId: obj.toolCallId,
    sessionId: obj.sessionId,
    approved: obj.approved,
    respondedBy: typeof obj.respondedBy === 'string' ? obj.respondedBy : undefined,
    platform: typeof obj.platform === 'string' ? obj.platform : undefined,
  };
}

/**
 * Whether this platform user may authorize this session's tool call.
 *
 * A REQUIRED parameter of the two functions below, never optional and never
 * defaulted. The adapters' own `mayApprove` gate answers for the binding it
 * lives on, and a room-bound Ask reaches this bus by a path no adapter binding
 * covers (spec `ask-entitlement` §5.3), so this bus carries no authority of its
 * own. A default would be an allow for whatever publisher is added next.
 *
 * @param decision - What arrived on the bus: which session's tool call, which
 *   chat platform, and the platform user id that clicked — `undefined` when the
 *   platform gave none, which every implementation must refuse.
 * @returns Whether to touch the runtime at all.
 */
export type ApprovalAuthorizer = (decision: {
  readonly sessionId: string;
  readonly platform: string;
  readonly respondedBy: string | undefined;
}) => boolean;

/**
 * Handle a single approval response envelope.
 *
 * Validates the payload, asks `authorize`, calls `approveTool()`, and logs the
 * outcome. Returns quietly if the interaction was not found (e.g., already
 * timed out) — the deferred promise has already been settled.
 *
 * ## Why this ASKS every runtime rather than resolving one
 *
 * An approval card carries a session id and nothing else. The card was built by
 * a chat adapter from an `approval_required` event, and neither the event nor
 * the click that answers it has ever carried a runtime — so unlike an agent
 * subject or a task dispatch, there is nothing here to name one.
 *
 * `approveTool` is a lookup that answers `false` when the runtime holds no such
 * pending interaction, and only one runtime can hold a given one, so asking
 * each in turn is exact rather than a guess. It is also side-effect free on a
 * miss in all three shipped runtimes: Claude Code and OpenCode look the
 * interaction up and return, and Codex has no approval channel at all and
 * always answers `false` (its `supportsToolApproval` is false, so no card for a
 * Codex session is ever built in the first place). The default runtime is asked
 * first, so the single-runtime case is unchanged down to the call order.
 *
 * @param envelope - The relay envelope containing the approval response
 * @param agentRuntimes - The runtimes to offer the decision to, default first
 * @param log - Logger instance for diagnostics
 * @param authorize - Whether this platform user may authorize this session's
 *   tool call. Runs BEFORE any runtime is touched; a refusal logs one line and
 *   has no other effect.
 */
export function handleApprovalResponse(
  envelope: RelayEnvelope,
  agentRuntimes: readonly AgentRuntimeLike[],
  log: Pick<Console, 'warn' | 'debug'>,
  authorize: ApprovalAuthorizer
): void {
  const approval = parseApprovalPayload(envelope.payload);
  if (!approval) {
    log.warn(
      `[CCA] approval-handler: received malformed payload on ${envelope.subject} — ` +
        `expected type='approval_response' with toolCallId, sessionId, approved`
    );
    return;
  }

  const { toolCallId, sessionId, approved, platform = 'unknown' } = approval;

  if (!authorize({ sessionId, platform, respondedBy: approval.respondedBy })) {
    // The second of two independent gates: the adapter's own `mayApprove` ran
    // in process on the click, and this one runs before the runtime is touched.
    // Neither is trusted to be the only one.
    log.warn(
      `[CCA] approval-handler: refused an approval this caller may not give — ` +
        `platform=${platform} sessionId=${sessionId} toolCallId=${toolCallId}`
    );
    return;
  }

  log.debug?.(
    `[CCA] approval-handler: ${approved ? 'approve' : 'deny'} ` +
      `toolCallId=${toolCallId} sessionId=${sessionId} platform=${platform}`
  );

  const resolved = agentRuntimes.some((runtime) =>
    runtime.approveTool(sessionId, toolCallId, approved)
  );
  if (!resolved) {
    // No runtime held the interaction: it settled already (a timeout
    // auto-denied it before the click landed), or it belongs to a runtime this
    // server did not start. Both are named, because the second one is a wiring
    // problem and the first is not.
    log.warn(
      `[CCA] approval-handler: no runtime held this tool call — it has already been ` +
        `answered (a timeout, perhaps), or the session belongs to a runtime this server did ` +
        `not start. toolCallId=${toolCallId} sessionId=${sessionId} ` +
        `asked=${agentRuntimes.map((runtime) => runtime.type ?? 'unknown').join(', ')}`
    );
  }
}

/**
 * Subscribe to tool approval responses on behalf of the CCA adapter.
 *
 * Registers a handler on `relay.system.approval.>` that routes incoming
 * `approval_response` payloads to `agentManager.approveTool()`. Returns an
 * unsubscribe function that must be called on adapter stop.
 *
 * @param relay - The RelayPublisher to subscribe through
 * @param agentRuntimes - The runtimes to offer approval decisions to, default
 *   first. See {@link handleApprovalResponse} for why every one is asked.
 * @param log - Logger instance for diagnostics
 * @param authorize - Whether the clicking platform user may authorize the
 *   session's tool call. Required; see {@link ApprovalAuthorizer}.
 */
export function subscribeApprovalHandler(
  relay: RelayPublisher,
  agentRuntimes: readonly AgentRuntimeLike[],
  log: Pick<Console, 'warn' | 'debug'>,
  authorize: ApprovalAuthorizer
): Unsubscribe {
  return relay.subscribe(APPROVAL_SUBJECT_PATTERN, (envelope) => {
    handleApprovalResponse(envelope, agentRuntimes, log, authorize);
  });
}
