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
 * Handle a single approval response envelope.
 *
 * Validates the payload, calls `agentManager.approveTool()`, and logs
 * the outcome. Returns false if the interaction was not found (e.g., already
 * timed out) without throwing — the deferred promise has already been settled.
 *
 * @param envelope - The relay envelope containing the approval response
 * @param agentManager - The agent runtime to forward the approval decision to
 * @param log - Logger instance for diagnostics
 */
export function handleApprovalResponse(
  envelope: RelayEnvelope,
  agentManager: AgentRuntimeLike,
  log: Pick<Console, 'warn' | 'debug'>,
): void {
  const approval = parseApprovalPayload(envelope.payload);
  if (!approval) {
    log.warn(
      `[CCA] approval-handler: received malformed payload on ${envelope.subject} — ` +
        `expected type='approval_response' with toolCallId, sessionId, approved`,
    );
    return;
  }

  const { toolCallId, sessionId, approved, platform = 'unknown' } = approval;
  log.debug?.(
    `[CCA] approval-handler: ${approved ? 'approve' : 'deny'} ` +
      `toolCallId=${toolCallId} sessionId=${sessionId} platform=${platform}`,
  );

  const resolved = agentManager.approveTool(sessionId, toolCallId, approved);
  if (!resolved) {
    // Interaction already settled (e.g., timeout auto-denied before user clicked)
    log.warn(
      `[CCA] approval-handler: approveTool returned false — ` +
        `interaction not found (already timed out?) toolCallId=${toolCallId} sessionId=${sessionId}`,
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
 * @param agentManager - The agent runtime to forward approval decisions to
 * @param log - Logger instance for diagnostics
 */
export function subscribeApprovalHandler(
  relay: RelayPublisher,
  agentManager: AgentRuntimeLike,
  log: Pick<Console, 'warn' | 'debug'>,
): Unsubscribe {
  return relay.subscribe(APPROVAL_SUBJECT_PATTERN, (envelope) => {
    handleApprovalResponse(envelope, agentManager, log);
  });
}
