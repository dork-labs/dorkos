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

/** Instance-scoped container for Slack outbound state. */
export interface SlackOutboundState {
  pendingApprovalTimeouts: Map<string, PendingApprovalEntry>;
  /**
   * Stream keys this adapter has posted something for, and when.
   *
   * Read at `done` to tell an answer from a silence. A turn that ends having
   * posted nothing at all leaves the person looking at their own question with
   * no sign anything happened; one that posted a card, a partial answer, or an
   * **error** has already spoken and must not be contradicted.
   *
   * The timestamp exists so a turn whose terminal never arrives cannot hold a
   * key forever — see {@link markSpoken}.
   */
  spokenStreams: Map<string, number>;
}

/** Create a fresh outbound state container for a single adapter instance. */
export function createSlackOutboundState(): SlackOutboundState {
  return { pendingApprovalTimeouts: new Map(), spokenStreams: new Map() };
}

/**
 * How long a "this turn has spoken" mark is kept when no terminal arrives (ms).
 *
 * A terminal is not guaranteed — the `done` publish upstream is best-effort —
 * and without a bound a long-lived adapter accumulates one key per turn
 * forever. Comfortably longer than any turn, because dropping a mark early
 * risks the one thing this must never do: telling somebody the agent said
 * nothing when it did.
 */
export const SPOKEN_TTL_MS = 60 * 60 * 1_000;

/** Most spoken-turn marks kept, for the pathological case the TTL is too slow for. */
const MAX_SPOKEN_ENTRIES = 2_000;

/**
 * Record that a turn has already put something on screen, and sweep the marks
 * that no terminal ever came for.
 *
 * @param spoken - The adapter's spoken-turn marks.
 * @param key - The stream key of the turn that spoke.
 */
export function markSpoken(spoken: Map<string, number>, key: string): void {
  const now = Date.now();
  for (const [k, at] of spoken) {
    if (now - at > SPOKEN_TTL_MS) spoken.delete(k);
  }
  spoken.delete(key); // refresh insertion order for the size cap below
  spoken.set(key, now);
  while (spoken.size > MAX_SPOKEN_ENTRIES) {
    const oldest = spoken.keys().next().value;
    if (oldest === undefined) break;
    spoken.delete(oldest);
  }
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
  state.spokenStreams.clear();
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
