# Chat Adapter Tool Approval via Platform-Native Buttons

| Field     | Value                                           |
| --------- | ----------------------------------------------- |
| Status    | Draft                                           |
| Authors   | DorkOS Team                                     |
| Date      | 2026-03-18                                      |
| Spec Slug | slack-tool-approval                             |
| Depends   | relay-adapter-event-whitelist (must land first)  |

## Overview

When an agent runs in `permissionMode === 'default'`, the Claude Code SDK emits `approval_required` events for non-read-only tools. The web UI renders these as interactive cards with Approve/Deny buttons. Chat adapters (Slack and Telegram) currently drop these events via the whitelist model, causing agents to appear frozen until the 10-minute timeout auto-denies the tool call. This spec adds platform-native interactive buttons (Slack Block Kit, Telegram inline keyboard) so chat users can approve or deny tool calls without leaving their messaging platform.

## Background / Problem Statement

The current tool approval flow works end-to-end in the web UI:

1. SDK calls `canUseTool(toolName, input, context)` in `interactive-handlers.ts`
2. `handleToolApproval()` pushes an `approval_required` event to `session.eventQueue` with `{ toolCallId, toolName, input, timeoutMs }`
3. A deferred promise is stored in `session.pendingInteractions[toolUseId]`
4. The event streams via SSE to the client, which renders `ToolApproval.tsx` with Approve/Deny buttons
5. User clicks a button, which calls `POST /api/sessions/:id/approve` or `/deny`
6. The route calls `runtime.approveTool(sessionId, toolCallId, approved)`, resolving the deferred promise
7. The SDK resumes with `{ behavior: 'allow' | 'deny' }`

Chat adapters are completely cut out of this flow. After the relay-adapter-event-whitelist spec lands, `approval_required` events will be silently dropped by the implicit whitelist in `deliverMessage()`. Users messaging agents via Slack or Telegram have zero visibility into pending tool approvals and no way to respond, causing:

- Agents appearing frozen for up to 10 minutes before timeout auto-denial
- Users having to switch to the web UI to approve tools, breaking the value proposition of chat-based agent interaction
- No indication of what the agent is waiting for

## Goals

- Render tool approval requests as interactive cards in Slack (Block Kit) and Telegram (inline keyboard)
- Allow chat users to approve or deny tool calls by clicking platform-native buttons
- Route approval decisions back through the relay bus to the CCA adapter, which resolves the deferred promise in `interactive-handlers.ts`
- Update the approval message after the decision (buttons replaced with result text)
- Handle 10-minute timeout gracefully (update message to show auto-denial)
- Maintain adapter decoupling: Slack/Telegram adapters publish approval responses to a relay subject; CCA adapter subscribes and resolves interactions

## Non-Goals

- `question_prompt` events (AskUserQuestion) -- different interaction pattern, separate spec
- Approval history or audit logging
- Per-user approval permissions (v1: any user in the channel/chat can approve)
- Customizable approval timeout per adapter
- Approval delegation or escalation
- "Approve All" button for multiple pending approvals
- Mobile push notifications for pending approvals

## Technical Dependencies

| Dependency | Type | Notes |
|---|---|---|
| relay-adapter-event-whitelist spec | Prerequisite | Must land first so adapters explicitly handle `approval_required` instead of silently dropping it |
| `@slack/bolt` Socket Mode | Runtime | Provides `app.action()` handler for Block Kit button interactions |
| `grammy` Bot framework | Runtime | Provides `bot.on('callback_query:data')` handler for inline keyboard interactions |
| `interactive-handlers.ts` | Server | Source of truth for deferred promises and 10-minute timeout (`SESSIONS.INTERACTION_TIMEOUT_MS = 600000`) |
| `AgentRuntime.approveTool()` | Server | `approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean` -- resolves/rejects the pending interaction |

## Detailed Design

### Architecture

The approval flow for chat adapters mirrors the web UI flow but routes through the relay message bus instead of HTTP:

```
SDK canUseTool() --> handleToolApproval() --> approval_required event
                                                    |
                    +-------------------------------+
                    |                               |
              [Web UI path]                  [Chat adapter path]
              SSE -> client                  relay publish -> adapter deliver()
              ToolApproval.tsx               Block Kit / inline keyboard
              POST /approve                  button click
              runtime.approveTool()          relay.system.approval.{agentId}
                    |                               |
                    +-------------------------------+
                                                    |
                                        CCA adapter subscription
                                        runtime.approveTool()
                                        deferred promise resolves
                                        SDK resumes
```

### Relay Subject Schema

A new relay subject namespace carries approval responses from chat adapters to the CCA adapter:

```
relay.system.approval.{agentId}
```

This follows the existing `relay.system.pulse.{scheduleId}` pattern for system-level messages that target specific agent sessions.

**Approval response payload:**

```typescript
/** Published to relay.system.approval.{agentId} by chat adapters. */
interface ApprovalResponse {
  type: 'approval_response';
  toolCallId: string;
  /** DorkOS session key (ccaSessionKey used in ensureSession/sendMessage). */
  sessionId: string;
  approved: boolean;
  /** Platform user identifier (e.g., Slack user ID, Telegram user ID). */
  respondedBy?: string;
  platform: 'slack' | 'telegram';
}
```

### Implementation: Slack Adapter

#### Outbound (`packages/relay/src/adapters/slack/outbound.ts`)

Add an `approval_required` branch in `deliverMessage()` before the whitelist drop-through. This branch detects `approval_required` events and renders a Block Kit message with Approve/Deny action buttons.

**Intercept point** -- insert after the `done` handler and before the whitelist drop-through (currently line 688-691):

```typescript
// approval_required: render interactive card with Approve/Deny buttons
if (eventType === 'approval_required') {
  const data = extractApprovalData(envelope.payload);
  if (data) {
    logger.debug(`deliver: approval_required for tool '${data.toolName}' to ${channelId}`);
    return handleApprovalRequired(
      channelId, threadTs, data, envelope, client, callbacks, startTime,
    );
  }
}

// All other StreamEvent types: silently drop (whitelist model).
```

**Helper function -- `extractApprovalData()`:**

```typescript
interface ApprovalData {
  toolCallId: string;
  toolName: string;
  input: string;
  timeoutMs: number;
}

function extractApprovalData(payload: unknown): ApprovalData | null {
  if (payload === null || typeof payload !== 'object') return null;
  const obj = payload as Record<string, unknown>;
  if (obj.type !== 'approval_required') return null;
  const data = obj.data as Record<string, unknown> | undefined;
  if (!data?.toolCallId || !data?.toolName) return null;
  return {
    toolCallId: data.toolCallId as string,
    toolName: data.toolName as string,
    input: (data.input as string) ?? '',
    timeoutMs: (data.timeoutMs as number) ?? 600_000,
  };
}
```

**Handler function -- `handleApprovalRequired()`:**

```typescript
async function handleApprovalRequired(
  channelId: string,
  threadTs: string | undefined,
  data: ApprovalData,
  envelope: RelayEnvelope,
  client: WebClient,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
): Promise<DeliveryResult> {
  // Extract agentId and sessionId from envelope metadata
  const agentId = extractAgentIdFromEnvelope(envelope);
  const sessionId = extractSessionIdFromEnvelope(envelope);

  // Truncate tool input preview to ~500 chars for readability
  const inputPreview = truncateText(data.input, 500);

  // Describe the tool action in human terms
  const toolDescription = formatToolDescription(data.toolName, data.input);

  const buttonValue = JSON.stringify({
    toolCallId: data.toolCallId,
    sessionId,
    agentId,
  });

  return wrapSlackCall(
    () => client.chat.postMessage({
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
    }),
    callbacks,
    startTime,
    true,
  );
}
```

**Block Kit message structure:**

```json
{
  "channel": "D123",
  "thread_ts": "1234567890.123456",
  "text": "Tool approval required: Write (fallback for notifications)",
  "blocks": [
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "*Tool Approval Required*\n`Write` wants to write to `src/index.ts`"
      }
    },
    {
      "type": "section",
      "text": {
        "type": "mrkdwn",
        "text": "```\n{truncated tool input preview, max ~500 chars}\n```"
      }
    },
    {
      "type": "actions",
      "block_id": "tool_approval",
      "elements": [
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Approve" },
          "style": "primary",
          "action_id": "tool_approve",
          "value": "{\"toolCallId\":\"toolu_123\",\"sessionId\":\"sess-abc\",\"agentId\":\"agent-1\"}"
        },
        {
          "type": "button",
          "text": { "type": "plain_text", "text": "Deny" },
          "style": "danger",
          "action_id": "tool_deny",
          "value": "{\"toolCallId\":\"toolu_123\",\"sessionId\":\"sess-abc\",\"agentId\":\"agent-1\"}"
        }
      ]
    }
  ]
}
```

The `value` field (max 2000 chars in Slack) encodes only IDs -- never sensitive tool input. The `text` field at the top level serves as a fallback for notifications and accessibility.

#### Inbound (`packages/relay/src/adapters/slack/slack-adapter.ts`)

Register `app.action()` handlers during `start()` to listen for button clicks:

```typescript
// In start() method, after app.message() registration:

app.action('tool_approve', async ({ ack, body, client }) => {
  await ack();
  await handleApprovalAction(body, client, true, relay, logger);
});

app.action('tool_deny', async ({ ack, body, client }) => {
  await ack();
  await handleApprovalAction(body, client, false, relay, logger);
});
```

**Handler function -- `handleApprovalAction()`:**

```typescript
async function handleApprovalAction(
  body: BlockAction,
  client: WebClient,
  approved: boolean,
  relay: RelayPublisher | null,
  logger: RelayLogger,
): Promise<void> {
  const action = body.actions[0];
  if (!action || action.type !== 'button') return;

  let parsed: { toolCallId: string; sessionId: string; agentId: string };
  try {
    parsed = JSON.parse(action.value);
  } catch {
    logger.error('Failed to parse approval button value');
    return;
  }

  const respondedBy = body.user?.id;

  // Publish approval response to relay bus
  if (relay) {
    await relay.publish(
      `relay.system.approval.${parsed.agentId}`,
      {
        type: 'approval_response',
        toolCallId: parsed.toolCallId,
        sessionId: parsed.sessionId,
        approved,
        respondedBy,
        platform: 'slack',
      } satisfies ApprovalResponse,
      { from: `relay.human.slack.${body.channel?.id ?? 'unknown'}` },
    );
  }

  // Update the original message to show the decision result
  const resultText = approved
    ? `*Approved* -- \`${extractToolNameFromBlocks(body.message)}\` (by <@${respondedBy}>)`
    : `*Denied* -- \`${extractToolNameFromBlocks(body.message)}\` (by <@${respondedBy}>)`;

  try {
    await client.chat.update({
      channel: body.channel!.id,
      ts: body.message!.ts,
      text: resultText,
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: resultText },
        },
      ],
    });
  } catch (err) {
    logger.error('Failed to update approval message:', err);
  }
}
```

**Slack App Manifest update** -- add the `interactivity` permission. Socket Mode handles interactivity natively without a request URL, so no additional OAuth scope is required. The existing bot scopes (`chat:write`) cover `chat.update()`.

### Implementation: Telegram Adapter

#### Outbound (`packages/relay/src/adapters/telegram/outbound.ts`)

Add an `approval_required` branch in `deliverMessage()` before the whitelist drop-through. The branch sends a message with an inline keyboard containing Approve/Deny buttons.

```typescript
// approval_required: render inline keyboard with Approve/Deny buttons
if (eventType === 'approval_required') {
  const data = extractApprovalData(envelope.payload);
  if (data) {
    logger.debug(`deliver: approval_required for tool '${data.toolName}' to chat ${chatId}`);
    return handleApprovalRequired(
      bot, chatId, data, envelope, callbacks, startTime,
    );
  }
}
```

**Handler function -- `handleApprovalRequired()`:**

```typescript
/** In-memory map from truncated ID to full ID for Telegram callback_data recovery. */
const callbackIdMap = new Map<string, { toolCallId: string; sessionId: string; agentId: string }>();

/** Maximum age (ms) for callback ID map entries before eviction. */
const CALLBACK_ID_TTL_MS = 15 * 60 * 1_000;

async function handleApprovalRequired(
  bot: Bot,
  chatId: number,
  data: ApprovalData,
  envelope: RelayEnvelope,
  callbacks: AdapterOutboundCallbacks,
  startTime: number,
): Promise<DeliveryResult> {
  const agentId = extractAgentIdFromEnvelope(envelope);
  const sessionId = extractSessionIdFromEnvelope(envelope);

  // Telegram callback_data is limited to 64 bytes.
  // Generate a short lookup key and store full IDs in memory.
  const shortKey = randomBytes(6).toString('hex'); // 12 chars
  callbackIdMap.set(shortKey, {
    toolCallId: data.toolCallId,
    sessionId,
    agentId,
  });

  // Evict stale entries
  setTimeout(() => callbackIdMap.delete(shortKey), CALLBACK_ID_TTL_MS);

  const toolDescription = formatToolDescription(data.toolName, data.input);
  const inputPreview = truncateText(data.input, 400);
  const messageText =
    `*Tool Approval Required*\n` +
    `\`${data.toolName}\` ${toolDescription}\n\n` +
    `\`\`\`\n${inputPreview}\n\`\`\``;

  try {
    await bot.api.sendMessage(chatId, messageText, {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: 'Approve', callback_data: JSON.stringify({ k: shortKey, a: 1 }) },
          { text: 'Deny', callback_data: JSON.stringify({ k: shortKey, a: 0 }) },
        ]],
      },
    });
    callbacks.trackOutbound();
    return { success: true, durationMs: Date.now() - startTime };
  } catch (err) {
    callbacks.recordError(err);
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
    };
  }
}
```

**Telegram callback_data constraint:** Telegram limits `callback_data` to 64 bytes. The full `toolCallId` alone can be 40+ characters. The solution uses a 12-character random lookup key stored in an in-memory map (`callbackIdMap`) with a 15-minute TTL. The callback_data payload is `{"k":"<12chars>","a":1}` (approve) or `{"k":"<12chars>","a":0}` (deny) -- well within the 64-byte limit.

#### Inbound (`packages/relay/src/adapters/telegram/telegram-adapter.ts`)

Register a `callback_query:data` handler during `start()`:

```typescript
// In start() method, after bot.on('message:text') registration:

bot.on('callback_query:data', async (ctx) => {
  let parsed: { k: string; a: number };
  try {
    parsed = JSON.parse(ctx.callbackQuery.data);
  } catch {
    await ctx.answerCallbackQuery({ text: 'Invalid action' });
    return;
  }

  const ids = callbackIdMap.get(parsed.k);
  if (!ids) {
    await ctx.answerCallbackQuery({ text: 'Approval expired' });
    return;
  }

  const approved = parsed.a === 1;
  callbackIdMap.delete(parsed.k);

  // Publish approval response to relay bus
  if (relay) {
    await relay.publish(
      `relay.system.approval.${ids.agentId}`,
      {
        type: 'approval_response',
        toolCallId: ids.toolCallId,
        sessionId: ids.sessionId,
        approved,
        respondedBy: String(ctx.from.id),
        platform: 'telegram',
      } satisfies ApprovalResponse,
      { from: `relay.human.telegram.${ctx.chat?.id ?? 'unknown'}` },
    );
  }

  // Update message: remove keyboard, show result
  const resultText = approved
    ? `*Approved* -- \`${extractToolNameFromMessage(ctx.callbackQuery.message)}\``
    : `*Denied* -- \`${extractToolNameFromMessage(ctx.callbackQuery.message)}\``;

  await ctx.answerCallbackQuery({ text: approved ? 'Approved' : 'Denied' });
  await ctx.editMessageText(resultText, { parse_mode: 'Markdown' });
});
```

### Implementation: CCA Adapter (Approval Subscription)

#### Type Extension (`packages/relay/src/adapters/claude-code/types.ts`)

Add `approveTool` to the `AgentRuntimeLike` interface:

```typescript
export interface AgentRuntimeLike {
  ensureSession(
    sessionId: string,
    opts: { permissionMode: string; cwd?: string; hasStarted?: boolean },
  ): void;
  sendMessage(
    sessionId: string,
    content: string,
    opts?: { permissionMode?: string; cwd?: string },
  ): AsyncGenerator<StreamEvent>;
  getSdkSessionId(sessionId: string): string | undefined;

  /**
   * Resolve a pending tool approval interaction.
   *
   * @param sessionId - The session key (ccaSessionKey)
   * @param toolCallId - The tool call to approve/deny
   * @param approved - Whether to approve (true) or deny (false)
   * @returns false if the session or pending interaction was not found
   */
  approveTool(sessionId: string, toolCallId: string, approved: boolean): boolean;
}
```

This mirrors the `AgentRuntime.approveTool()` signature from `packages/shared/src/agent-runtime.ts` (line 140). Since `AgentRuntimeLike` is a structural subset, any `AgentRuntime` implementation automatically satisfies it without explicit casting.

#### Approval Handler (`packages/relay/src/adapters/claude-code/approval-handler.ts`)

New file -- handles subscription to `relay.system.approval.>` and routes approval responses to the runtime:

```typescript
/**
 * Approval response handler for the Claude Code adapter.
 *
 * Subscribes to relay.system.approval.> to receive tool approval
 * decisions from chat adapters (Slack, Telegram) and resolves the
 * corresponding pending interaction via AgentRuntimeLike.approveTool().
 *
 * @module relay/adapters/claude-code-approval-handler
 */

import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher } from '../../types.js';
import type { AgentRuntimeLike } from './types.js';

/** Subject pattern for approval response subscriptions. */
export const APPROVAL_SUBJECT_PATTERN = 'relay.system.approval.>';

/** Parsed approval response from a chat adapter. */
interface ApprovalPayload {
  type: 'approval_response';
  toolCallId: string;
  sessionId: string;
  approved: boolean;
  respondedBy?: string;
  platform: 'slack' | 'telegram';
}

/**
 * Subscribe to approval responses from chat adapters.
 *
 * Called during CCA adapter start(). Returns an unsubscribe function.
 *
 * @param relay - The relay publisher (provides subscribe)
 * @param agentManager - The runtime to call approveTool() on
 * @param logger - Optional logger
 */
export function subscribeToApprovals(
  relay: RelayPublisher,
  agentManager: AgentRuntimeLike,
  logger?: { debug?: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): () => void {
  return relay.subscribe(APPROVAL_SUBJECT_PATTERN, (subject, envelope) => {
    handleApprovalResponse(subject, envelope, agentManager, logger);
  });
}

function handleApprovalResponse(
  subject: string,
  envelope: RelayEnvelope,
  agentManager: AgentRuntimeLike,
  logger?: { debug?: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
): void {
  const payload = envelope.payload as ApprovalPayload | null;
  if (!payload || payload.type !== 'approval_response') {
    logger?.warn(`[CCA] approval handler: unexpected payload on ${subject}`);
    return;
  }

  const { toolCallId, sessionId, approved, respondedBy, platform } = payload;
  logger?.debug?.(
    `[CCA] approval response: tool=${toolCallId} session=${sessionId} ` +
    `approved=${approved} by=${respondedBy ?? 'unknown'} platform=${platform}`,
  );

  const resolved = agentManager.approveTool(sessionId, toolCallId, approved);
  if (!resolved) {
    logger?.warn(
      `[CCA] approval handler: no pending interaction found for ` +
      `session=${sessionId} toolCallId=${toolCallId} — may have timed out`,
    );
  }
}
```

#### CCA Adapter Wiring (`packages/relay/src/adapters/claude-code/claude-code-adapter.ts`)

In the `start()` method, subscribe to approval responses:

```typescript
import { subscribeToApprovals } from './approval-handler.js';

// In start() method, after existing subscriptions:
if (this.relay) {
  this.approvalUnsubscribe = subscribeToApprovals(
    this.relay,
    this.deps.agentManager,
    this.deps.logger,
  );
}

// In stop() method:
this.approvalUnsubscribe?.();
```

#### Server Wiring (`apps/server/src/services/relay/adapter-manager.ts`)

No changes required. The `agentManager` dependency already passes through to the CCA adapter via `ClaudeCodeAdapterDeps`, and the existing `AgentRuntime` implementation (`ClaudeCodeRuntime`) already implements `approveTool()`. The structural typing of `AgentRuntimeLike` means adding `approveTool` to the interface is automatically satisfied by `ClaudeCodeRuntime`.

### Envelope Metadata for Agent/Session ID Propagation

The `approval_required` event needs to carry the `agentId` and `sessionId` so the outbound adapter can encode them in button values. These are available in the relay envelope:

- `agentId`: extracted from the envelope's `from` field (e.g., `agent:01JN4M2X5S...` or `agent:session-key`)
- `sessionId`: the ccaSessionKey used by the CCA adapter, available from the `from` field

The `publishResponseWithCorrelation()` function in `packages/relay/src/adapters/claude-code/publish.ts` already sets `from: agent:${ccaSessionKey}`. The outbound adapter can parse this to recover the session key.

If the agent ID is needed separately (for the relay subject), it must be threaded through the envelope payload or a new envelope metadata field. The recommended approach is to add `agentId` and `ccaSessionKey` to the payload of `approval_required` events published by the CCA adapter's response stream. This is a minor change in `publishResponseWithCorrelation()`:

```typescript
// In publishResponseWithCorrelation(), when forwarding approval_required events:
if (event.type === 'approval_required') {
  const enrichedPayload = {
    ...event,
    data: {
      ...(event.data as Record<string, unknown>),
      agentId,        // from handleAgentMessage scope
      ccaSessionKey,  // from handleAgentMessage scope
    },
  };
  await relay.publish(replyTo, enrichedPayload, opts);
  return;
}
```

### Data Model

No persistent storage changes. All state is ephemeral:

| State | Storage | Lifetime |
|---|---|---|
| Pending approval promise | `session.pendingInteractions` (in-memory Map) | Until resolved, rejected, or 10-min timeout |
| Slack approval message ts | Not stored (update uses `body.message.ts` from the action callback) | N/A |
| Telegram callback ID map | `callbackIdMap` (in-memory Map) | 15-minute TTL per entry |
| CCA approval subscription | Relay subscription registry (in-memory) | Adapter lifetime |

### API Changes

No new HTTP endpoints. The existing `POST /api/sessions/:id/approve` and `/deny` routes remain unchanged for web UI use. Chat adapters bypass HTTP entirely, using the relay bus for approval routing.

## User Experience

### Slack

When an agent requests tool approval, the user sees a threaded message:

```
+-----------------------------------------------+
| Tool Approval Required                        |
| `Write` wants to write to `src/index.ts`      |
|                                               |
| ```                                           |
| {"path":"src/index.ts","content":"..."}       |
| ```                                           |
|                                               |
| [Approve]  [Deny]                             |
+-----------------------------------------------+
```

After clicking Approve:

```
+-----------------------------------------------+
| *Approved* -- `Write` to `src/index.ts`       |
| (by @username)                                |
+-----------------------------------------------+
```

After timeout (10 minutes with no response):

```
+-----------------------------------------------+
| *Timed out* -- `Write` to `src/index.ts`      |
| (auto-denied after 10 min)                    |
+-----------------------------------------------+
```

### Telegram

Similar experience with inline keyboard buttons. After the decision, the keyboard is removed and the message text is updated with the result.

### Multi-Approval Sequences

When multiple tool approvals are pending (e.g., agent wants to write several files), each approval arrives as a separate message in the thread. Users approve or deny each independently. This matches the web UI behavior where each tool call gets its own interactive card.

## Testing Strategy

### Unit Tests

**`packages/relay/src/adapters/slack/__tests__/outbound.test.ts`:**
- `approval_required` payload produces correct Block Kit structure
- Button `value` field contains only IDs (no sensitive input)
- Tool input preview is truncated to 500 chars
- Missing `toolCallId` or `toolName` falls through to whitelist drop

**`packages/relay/src/adapters/slack/__tests__/slack-adapter.test.ts`:**
- Simulated `block_actions` with `tool_approve` action publishes correct relay message
- Simulated `block_actions` with `tool_deny` action publishes correct relay message
- Original message is updated via `chat.update()` with result text
- Malformed button value is handled gracefully

**`packages/relay/src/adapters/telegram/__tests__/outbound.test.ts`:**
- `approval_required` payload produces correct inline keyboard structure
- `callbackIdMap` stores full IDs and callback_data is under 64 bytes
- Stale callback map entries are evicted after TTL

**`packages/relay/src/adapters/telegram/__tests__/telegram-adapter.test.ts`:**
- Simulated `callback_query:data` with approve publishes correct relay message
- Simulated `callback_query:data` with deny publishes correct relay message
- Expired callback key returns "Approval expired" answer
- Message is edited to remove keyboard and show result

**`packages/relay/src/adapters/claude-code/__tests__/approval-handler.test.ts`:**
- Valid approval response calls `agentManager.approveTool()` with correct params
- `approved: true` passes `true`, `approved: false` passes `false`
- Unknown session/toolCallId logs warning but does not throw
- Malformed payload is rejected gracefully

### Integration Tests

- Full round-trip: `approval_required` event emitted by CCA adapter response stream, delivered to Slack adapter, Block Kit rendered, button click simulated, approval published to relay, CCA adapter subscription fires, `approveTool()` called, deferred promise resolves

### Existing Test Preservation

- All existing `outbound.test.ts` tests for `text_delta`, `error`, and `done` continue to pass unchanged
- The whitelist drop-through for unknown event types is unaffected

## Performance Considerations

- **Latency**: Approval routing adds one relay publish hop (sub-millisecond in-process). No measurable impact on the approval flow.
- **Memory**: Each pending approval in the Telegram adapter stores ~200 bytes in `callbackIdMap`. With the 15-minute TTL and typical usage (< 10 concurrent approvals), memory impact is negligible.
- **Concurrency**: The `subscribeToApprovals()` subscription handler runs synchronously (calls `approveTool()` which is sync). No concurrency concerns with the existing `pendingInteractions` Map.

## Security Considerations

- **No sensitive data in button values**: Button `value` (Slack) and `callback_data` (Telegram) contain only opaque IDs (`toolCallId`, `sessionId`, `agentId`). Tool input is displayed in the message text but never encoded in interactive element payloads.
- **Socket Mode eliminates replay surface**: Slack Socket Mode uses WebSocket connections authenticated by the app token. There is no HTTP endpoint to intercept or replay. Bolt SDK handles all signature verification automatically.
- **Telegram polling mode**: No webhook URL required. The bot polls Telegram servers over HTTPS. Callback queries are authenticated by Telegram's bot token.
- **V1: any user can approve**: Any user who can see the approval message in the Slack channel or Telegram chat can click Approve or Deny. This is acceptable for v1 (the same user likely triggered the agent). Per-user approval restrictions are deferred.
- **Callback ID map is ephemeral**: The Telegram `callbackIdMap` lives in-process memory only. Server restart clears all entries, but this is acceptable since pending approvals also clear on restart (the deferred promises in `interactive-handlers.ts` are in-memory).

## Documentation

- Update `contributing/relay-adapters.md` with the approval event handling pattern
- Add `approval_required` to the list of handled event types in adapter documentation
- Document the `relay.system.approval.{agentId}` subject namespace in relay subject documentation

## Implementation Phases

### Phase 1: Slack Block Kit Approval

1. Add `extractApprovalData()` helper to `packages/relay/src/adapters/slack/outbound.ts`
2. Add `handleApprovalRequired()` function to render Block Kit card
3. Insert `approval_required` branch in `deliverMessage()` before whitelist drop
4. Register `app.action('tool_approve')` and `app.action('tool_deny')` in `slack-adapter.ts` `start()`
5. Implement `handleApprovalAction()` -- publish to relay, update message
6. Add unit tests for outbound rendering and action handling

### Phase 2: Telegram Inline Keyboard Approval

1. Add `extractApprovalData()` helper to `packages/relay/src/adapters/telegram/outbound.ts`
2. Add `handleApprovalRequired()` with `callbackIdMap` for Telegram's 64-byte limit
3. Insert `approval_required` branch in `deliverMessage()` before whitelist drop
4. Register `bot.on('callback_query:data')` handler in `telegram-adapter.ts` `start()`
5. Implement callback handler -- lookup IDs, publish to relay, edit message
6. Add unit tests for outbound rendering and callback handling

### Phase 3: CCA Adapter Approval Subscription

1. Add `approveTool()` to `AgentRuntimeLike` interface in `types.ts`
2. Create `approval-handler.ts` with `subscribeToApprovals()`
3. Wire subscription in `claude-code-adapter.ts` `start()`/`stop()`
4. Enrich `approval_required` events in `publishResponseWithCorrelation()` with `agentId` and `ccaSessionKey`
5. Add unit tests for approval handler

### Phase 4: Timeout UX

1. In Slack adapter: register a local `setTimeout` matching `timeoutMs` from the `approval_required` payload. On fire, call `chat.update()` to show "Timed out" state. Store `{ channelId, messageTs }` keyed by `toolCallId` for the update.
2. In Telegram adapter: register a local `setTimeout`. On fire, call `editMessageText()` to show "Timed out" and remove keyboard. Store `{ chatId, messageId }` keyed by `toolCallId`.
3. Clear the timeout when a button click resolves the approval (prevent double-update).

## Open Questions

1. ~~**Shared `extractApprovalData()` helper**~~ (RESOLVED)
   **Answer:** Shared in `packages/relay/src/lib/payload-utils.ts`
   **Rationale:** DRY approach — all event extraction helpers already live here (`extractTextDelta`, `extractErrorMessage`, `detectStreamEventType`). One function, one test, consistent pattern.

2. ~~**Agent ID propagation**~~ (RESOLVED)
   **Answer:** Enrich `approval_required` event payload with `agentId` and `ccaSessionKey` in `publishResponseWithCorrelation()`
   **Rationale:** All needed data travels with the event. The adapter extracts both from the payload. No envelope schema changes needed.

3. ~~**Timeout message update reliability**~~ (RESOLVED)
   **Answer:** Local `setTimeout` using `timeoutMs` from the `approval_required` payload
   **Rationale:** Simple, low-complexity. May fire slightly before/after server timeout but the visual effect is identical. Server remains the source of truth for the actual deny decision. No new relay subjects or server-side changes required.

## Related ADRs

| ADR | Relevance |
|---|---|
| [ADR-0138: Whitelist Relay Adapter Event Filtering](../decisions/0138-whitelist-relay-adapter-event-filtering.md) | Prerequisite -- establishes the whitelist model that this spec extends with an `approval_required` handler |
| [ADR-0137: Unified Input Zone for Interactive Cards](../decisions/0137-unified-input-zone-for-interactive-cards.md) | Web UI counterpart -- describes how approval cards render in the chat input zone |
| [ADR-0094: Per-Message Correlation ID for Relay Event Filtering](../decisions/0094-per-message-correlation-id-for-relay-event-filtering.md) | Correlation IDs threaded through the relay pipeline, used for stream key resolution in outbound delivery |
| [ADR-0135: Binding-Level Permission Mode](../decisions/0135-binding-level-permission-mode.md) | `permissionMode` configuration that determines whether `approval_required` events are emitted |
| [ADR-0046: Central Binding Router for Adapter-Agent Routing](../decisions/0046-central-binding-router-for-adapter-agent-routing.md) | Binding router that routes messages between adapters and agents |
| [ADR-0029: Replace Message Receiver with Claude Code Adapter](../decisions/0029-replace-message-receiver-with-claude-code-adapter.md) | Establishes the CCA adapter pattern used for approval subscription |

## References

- Ideation: `specs/slack-tool-approval/01-ideation.md`
- Prerequisite spec: `specs/relay-adapter-event-whitelist/`
- Research: `research/20260317_relay_adapter_event_whitelist.md`
- Interactive handlers source: `apps/server/src/services/runtimes/claude-code/interactive-handlers.ts`
- AgentRuntime interface: `packages/shared/src/agent-runtime.ts` (line 140: `approveTool`)
- Slack outbound: `packages/relay/src/adapters/slack/outbound.ts` (line 580: `deliverMessage`)
- Telegram outbound: `packages/relay/src/adapters/telegram/outbound.ts` (line 106: `deliverMessage`)
- CCA adapter types: `packages/relay/src/adapters/claude-code/types.ts` (`AgentRuntimeLike`)
- CCA agent handler: `packages/relay/src/adapters/claude-code/agent-handler.ts` (`publishResponseWithCorrelation`)
- Slack Block Kit: https://docs.slack.dev/block-kit/
- Slack `app.action()`: https://docs.slack.dev/tools/bolt-js/concepts/actions/
- Telegram inline keyboards: https://core.telegram.org/bots/api#inlinekeyboardbutton
- Telegram `callback_data` limit: 64 bytes (https://core.telegram.org/bots/api#inlinekeyboardbutton)
