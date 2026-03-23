/**
 * Slack tool approval handling.
 *
 * Renders Block Kit approval cards for `approval_required` StreamEvents,
 * manages pending approval timeouts, and provides the clearApprovalTimeout
 * helper used by the adapter facade when a button click resolves an approval.
 *
 * @module relay/adapters/slack/approval
 */
import type { WebClient } from '@slack/web-api';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { AdapterOutboundCallbacks, DeliveryResult } from '../../types.js';
import {
  extractAgentIdFromEnvelope,
  extractSessionIdFromEnvelope,
  formatToolDescription,
  truncateText,
} from '../../lib/payload-utils.js';
import type { ApprovalData } from '../../lib/payload-utils.js';
import { wrapSlackCall } from './stream.js';
import type { ThreadParticipationTracker } from './thread-tracker.js';

// === Approval timeout state ===

/** Entry tracking a pending approval timeout for a single tool call. */
interface PendingApprovalEntry {
  timer: ReturnType<typeof setTimeout>;
  channelId: string;
  messageTs: string;
  client: WebClient;
}

/** Instance-scoped container for Slack outbound approval state. */
export interface SlackOutboundState {
  pendingApprovalTimeouts: Map<string, PendingApprovalEntry>;
}

/** Create a fresh outbound state container for a single adapter instance. */
export function createSlackOutboundState(): SlackOutboundState {
  return { pendingApprovalTimeouts: new Map() };
}

/**
 * Clear all pending approval timeouts and dispose of timers.
 *
 * Called during adapter shutdown to prevent leaked timers.
 *
 * @param state - The outbound state container to clear
 */
export function clearAllApprovalTimeouts(state: SlackOutboundState): void {
  for (const entry of state.pendingApprovalTimeouts.values()) {
    clearTimeout(entry.timer);
  }
  state.pendingApprovalTimeouts.clear();
}

/**
 * Clear an approval timeout after a button click.
 *
 * @param state - The outbound state container
 * @param toolCallId - The tool call ID whose timeout should be cleared
 */
export function clearApprovalTimeout(state: SlackOutboundState, toolCallId: string): void {
  const entry = state.pendingApprovalTimeouts.get(toolCallId);
  if (entry) {
    clearTimeout(entry.timer);
    state.pendingApprovalTimeouts.delete(toolCallId);
  }
}

// === Approval handler ===

/**
 * Render a Block Kit approval card and post it to Slack.
 *
 * Posts an interactive message with Approve and Deny buttons. The button
 * value field encodes only the IDs needed for the round-trip — not the
 * full tool input — to keep payloads small and avoid sensitive data leakage.
 *
 * @param channelId - Slack channel ID to post to
 * @param threadTs - Optional thread timestamp for threading
 * @param data - Parsed approval data (toolCallId, toolName, input, timeoutMs)
 * @param envelope - The original relay envelope
 * @param client - Slack WebClient
 * @param callbacks - Outbound tracking callbacks
 * @param startTime - Delivery start timestamp for duration tracking
 */
export async function handleApprovalRequired(
  channelId: string,
  threadTs: string | undefined,
  data: ApprovalData,
  envelope: RelayEnvelope,
  client: WebClient,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
  state: SlackOutboundState,
  threadTracker?: ThreadParticipationTracker
): Promise<DeliveryResult> {
  const agentId = extractAgentIdFromEnvelope(envelope) ?? 'unknown';
  const sessionId = extractSessionIdFromEnvelope(envelope) ?? 'unknown';
  const inputPreview = truncateText(data.input, 500);
  const toolDescription = formatToolDescription(data.toolName, data.input);

  const buttonValue = JSON.stringify({
    toolCallId: data.toolCallId,
    sessionId,
    agentId,
  });

  let postedTs: string | undefined;
  const result = await wrapSlackCall(
    async () => {
      const res = await client.chat.postMessage({
        channel: channelId,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text: `Tool approval required: ${data.toolName} (fallback)`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Tool Approval Required*\n\`${data.toolName}\` ${toolDescription}`,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `\`\`\`\n${inputPreview}\n\`\`\``,
            },
          },
          {
            type: 'actions',
            block_id: 'tool_approval',
            elements: [
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Approve' },
                style: 'primary',
                action_id: 'tool_approve',
                value: buttonValue,
              },
              {
                type: 'button',
                text: { type: 'plain_text', text: 'Deny' },
                style: 'danger',
                action_id: 'tool_deny',
                value: buttonValue,
              },
            ],
          },
        ],
      });
      postedTs = res.ts;
    },
    callbacks,
    startTime,
    true
  );

  // Mark thread participation after successful approval card post
  if (result.success && threadTracker && threadTs) {
    threadTracker.markParticipating(channelId, threadTs);
  }

  // Register timeout to update message when approval expires
  if (result.success && postedTs && data.timeoutMs > 0) {
    const msgTs = postedTs;
    const timer = setTimeout(async () => {
      state.pendingApprovalTimeouts.delete(data.toolCallId);
      try {
        await client.chat.update({
          channel: channelId,
          ts: msgTs,
          text: ':hourglass: Tool approval timed out',
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: ':hourglass: *Tool Approval Timed Out*\n~`' + data.toolName + '`~',
              },
            },
          ],
        });
      } catch {
        /* best-effort — message may have been deleted */
      }
    }, data.timeoutMs);
    state.pendingApprovalTimeouts.set(data.toolCallId, {
      timer,
      channelId,
      messageTs: msgTs,
      client,
    });
  }

  return result;
}
