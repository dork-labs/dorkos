---
slug: relay-adapter-streaming-fixes
number: 129
created: 2026-03-14
status: draft
authors: Claude Code
ideation: specs/relay-adapter-streaming-fixes/01-ideation.md
---

# Relay Adapter Streaming Fixes & Enhancements

## Status

Draft

## Overview

Fix three bugs in the Slack adapter's streaming pipeline and add two features across the Slack and Telegram adapters. The bugs cause garbled streaming output, agent CWD misrouting, and stale message edits. The features add a streaming on/off toggle and typing indicators.

## Background / Problem Statement

The Slack adapter streams agent responses by posting an initial message (`chat.postMessage`) then editing it with accumulated text (`chat.update`) as new tokens arrive. Three bugs undermine this:

1. **Newline garbling** -- `slackify-markdown` (v5.0.0, Issue #40) inserts `\n\n` paragraph separators during intermediate updates, causing each streaming chunk to appear on a new line instead of flowing continuously.

2. **CWD misrouting** -- `BindingRouter` creates agent sessions with the binding's `projectPath` but does not attach it to the republished envelope payload. The agent handler's CWD resolution chain (`payloadCwd ?? context.agent.directory`) receives neither value, so the agent operates in the server's default directory instead of the bound project.

3. **Stream key collision** -- `streamKey(channelId, threadTs?)` returns just `channelId` when `threadTs` is undefined. Two concurrent responses in the same channel share a key, causing the second to edit the first's message.

Additionally, users need the ability to disable streaming (for workspaces where live-edited messages are distracting) and to see typing indicators when agents are processing.

## Goals

- Fix all three Slack streaming bugs so messages render correctly, route to the right CWD, and never collide
- Add per-adapter `streaming` toggle so users can choose buffer-flush mode (like Telegram)
- Add emoji-reaction typing indicator for Slack (`:hourglass_flowing_sand:` on stream start, removed on done)
- Fix Telegram typing indicator to persist beyond 5 seconds via interval refresh
- Maintain backward compatibility — no breaking changes to existing configs or behavior

## Non-Goals

- Migration to Slack's native `chatStream` API (future work, separate spec)
- Changes to Telegram's streaming behavior (already buffers correctly)
- UI changes to the relay panel or binding configuration screens
- Per-binding streaming toggle (per-adapter is sufficient)
- New adapter types

## Technical Dependencies

| Dependency          | Version    | Purpose                                                   |
| ------------------- | ---------- | --------------------------------------------------------- |
| `slackify-markdown` | ^5.0.0     | Markdown-to-mrkdwn conversion (source of Bug 1)           |
| `@slack/bolt`       | ^4.x       | Socket Mode, WebClient for Slack API                      |
| `@slack/web-api`    | (via bolt) | `chat.postMessage`, `chat.update`, `reactions.add/remove` |
| `grammy`            | ^1.x       | Telegram Bot API (`sendChatAction`)                       |
| `zod`               | ^3.x       | Schema validation for adapter configs                     |

## Detailed Design

### Bug 1: Collapse Intermediate Paragraph Breaks

**Root cause:** `slackify-markdown` converts accumulated Markdown text and inserts `\n\n` between block-level elements (paragraphs, headings). During streaming, each intermediate update shows these separators, making chunks appear on new lines.

**Fix:** In `handleTextDelta`, after `formatForPlatform()`, collapse consecutive newlines for intermediate updates only. The final `handleDone` update preserves full paragraph formatting.

**File:** `packages/relay/src/adapters/slack/outbound.ts`

```typescript
// In handleTextDelta, when calling chat.update (line ~176):
const formatted = formatForPlatform(existing.accumulatedText, 'slack');
// Collapse paragraph breaks for intermediate streaming updates only
const streamText = formatted.replace(/\n{2,}/g, '\n');
text: truncateText(streamText, MAX_MESSAGE_LENGTH),
```

The `handleDone` finalizer continues to use `formatForPlatform()` without collapsing, preserving paragraph structure in the final message.

### Bug 2: Propagate Binding CWD in Envelope Payload

**Root cause:** `BindingRouter.handleInbound()` republishes to `relay.agent.{sessionId}` with the original payload but never injects `cwd: binding.projectPath`. The agent handler already reads `payloadCwd` from the payload (line 74-76 of `agent-handler.ts`), so the fix is upstream only.

**File:** `apps/server/src/services/relay/binding-router.ts`

```typescript
// In handleInbound, before the relay.publish call (line ~131):
// Enrich payload with binding's project path for CWD resolution
const enrichedPayload =
  typeof envelope.payload === 'object' && envelope.payload !== null
    ? { ...(envelope.payload as Record<string, unknown>), cwd: binding.projectPath }
    : { content: envelope.payload, cwd: binding.projectPath };

await this.deps.relayCore.publish(`relay.agent.${sessionId}`, enrichedPayload, {
  from: envelope.from,
  replyTo: envelope.replyTo,
  budget: envelope.budget,
});
```

**Relationship to spec 108 (fix-relay-cwd-passthrough):** That spec fixes the _downstream_ extraction of `payloadCwd` in `agent-handler.ts`. This fix addresses the _upstream_ injection of `cwd` by `BindingRouter`. They are complementary -- spec 108 ensures the handler reads `cwd` from the payload; this fix ensures the router puts it there.

### Bug 3: Fix Stream Key Collision

Three-part fix:

#### 3a. Always resolve threadTs from platformData

**File:** `packages/relay/src/adapters/slack/outbound.ts` (resolveThreadTs)

`resolveThreadTs` currently returns `undefined` when neither `platformData.threadTs` nor `platformData.ts` is a string. For inbound Slack messages, `platformData.ts` is always present. The fix ensures it's always returned:

```typescript
function resolveThreadTs(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload === null || typeof payload !== 'object') return undefined;
  const obj = payload as Record<string, unknown>;
  const pd = obj.platformData as Record<string, unknown> | undefined;
  if (!pd) return undefined;
  // threadTs takes precedence (already in a thread)
  if (typeof pd.threadTs === 'string' && pd.threadTs) return pd.threadTs;
  // ts of the original message (always present for inbound Slack messages)
  if (typeof pd.ts === 'string' && pd.ts) return pd.ts;
  return undefined;
}
```

#### 3b. Synthetic fallback for programmatic messages

When `resolveThreadTs` returns `undefined` (programmatic messages without `platformData`), generate a synthetic stream key to prevent collision:

```typescript
// In deliverMessage, after resolveThreadTs:
const threadTs = resolveThreadTs(envelope);
// Synthetic fallback: use envelope ID to prevent collisions for programmatic messages
const effectiveThreadTs = threadTs ?? envelope.id;
```

Use `effectiveThreadTs` in all subsequent calls to `handleTextDelta`, `handleDone`, and `handleError`.

#### 3c. Add streamId to ActiveStream for race detection

```typescript
export interface ActiveStream {
  streamId: string; // Unique per stream, for race detection
  channelId: string;
  threadTs: string;
  messageTs: string;
  accumulatedText: string;
  lastUpdateAt: number;
  startedAt: number;
}
```

In `handleTextDelta` (new stream branch), generate a stream ID:

```typescript
streamState.set(key, {
  streamId: crypto.randomUUID(),
  channelId,
  // ... rest of fields
});
```

In `handleDone`, capture the stream ID before deleting and log a warning if a concurrent stream was detected:

```typescript
async function handleDone(...): Promise<DeliveryResult> {
  const key = streamKey(channelId, threadTs);
  const existing = streamState.get(key);
  streamState.delete(key);
  if (!existing) return { success: true, durationMs: Date.now() - startTime };
  // Finalize with existing.messageTs (safe even if key was re-populated concurrently)
  return wrapSlackCall(
    () => client.chat.update({ ... }),
    callbacks, startTime, true,
  );
}
```

### Feature 1: Streaming Toggle

#### Schema change

**File:** `packages/shared/src/relay-adapter-schemas.ts`

```typescript
export const SlackAdapterConfigSchema = z
  .object({
    botToken: z.string().min(1),
    appToken: z.string().min(1),
    signingSecret: z.string().min(1),
    streaming: z.boolean().default(true),
    typingIndicator: z.enum(['none', 'reaction']).default('none'),
  })
  .openapi('SlackAdapterConfig');
```

#### Config threading

**File:** `packages/relay/src/adapters/slack/outbound.ts`

Add `streaming` to `SlackDeliverOptions`:

```typescript
export interface SlackDeliverOptions {
  adapterId: string;
  subject: string;
  envelope: RelayEnvelope;
  client: WebClient | null;
  streamState: Map<string, ActiveStream>;
  botUserId: string;
  callbacks: AdapterOutboundCallbacks;
  streaming: boolean;
  typingIndicator: 'none' | 'reaction';
}
```

#### Buffered mode logic

In `deliverMessage`, when `streaming === false`:

- **`text_delta`**: Accumulate text in `streamState` without calling `chat.postMessage` or `chat.update`. Set `messageTs: ''` to indicate no message has been posted yet.
- **`done`**: Send accumulated text via `chat.postMessage` (not `chat.update`).
- **`error`**: Send accumulated text + error suffix via `chat.postMessage`.

```typescript
// In the text_delta handler:
if (!opts.streaming) {
  const key = streamKey(channelId, effectiveThreadTs);
  const existing = streamState.get(key);
  if (existing) {
    existing.accumulatedText += textChunk;
  } else {
    streamState.set(key, {
      streamId: crypto.randomUUID(),
      channelId,
      threadTs: effectiveThreadTs ?? '',
      messageTs: '', // No message posted yet
      accumulatedText: textChunk,
      lastUpdateAt: 0,
      startedAt: Date.now(),
    });
  }
  return { success: true, durationMs: Date.now() - startTime };
}
```

In `handleDone`, check if `existing.messageTs` is empty (buffered mode):

```typescript
if (!existing.messageTs) {
  // Buffered mode: post accumulated text as new message
  return wrapSlackCall(
    () => client.chat.postMessage({
      channel: channelId,
      text: truncateText(formatForPlatform(existing.accumulatedText, 'slack'), MAX_MESSAGE_LENGTH),
      ...(threadTs ? { thread_ts: threadTs } : {}),
    }),
    callbacks, startTime, true,
  );
}
// Streaming mode: update existing message
return wrapSlackCall(
  () => client.chat.update({ ... }),
  callbacks, startTime, true,
);
```

#### Manifest configField

**File:** `packages/relay/src/adapters/slack/slack-adapter.ts`

Add to `SLACK_MANIFEST.configFields`:

```typescript
{
  key: 'streaming',
  label: 'Stream Responses',
  type: 'boolean',
  required: false,
  description: 'Show responses as they arrive (live editing). Disable to send a single message when complete.',
  visibleByDefault: true,
  helpMarkdown: 'When enabled, agent responses appear token-by-token in Slack via message editing. When disabled, the full response is sent as a single message after the agent finishes.',
},
```

### Feature 2: Typing Indicators

#### Slack: Emoji Reaction

**Mechanism:** On stream start, add `:hourglass_flowing_sand:` reaction to the user's original message. On stream completion, remove it. Both are fire-and-forget to avoid blocking the streaming pipeline.

**Scope change:** Add `reactions:write` to `SLACK_APP_MANIFEST_YAML`:

```yaml
oauth_config:
  scopes:
    bot:
      - channels:history
      - channels:read
      - chat:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - im:write
      - mpim:history
      - app_mentions:read
      - users:read
      - reactions:write
```

**Implementation in outbound.ts:**

In `handleTextDelta`, when starting a new stream (the `!existing` branch) and `typingIndicator === 'reaction'`:

```typescript
if (opts.typingIndicator === 'reaction' && threadTs) {
  void client.reactions
    .add({
      channel: channelId,
      name: 'hourglass_flowing_sand',
      timestamp: threadTs,
    })
    .catch(() => {}); // fire-and-forget
}
```

In `handleDone`, remove the reaction:

```typescript
if (opts.typingIndicator === 'reaction' && existing.threadTs) {
  void client.reactions
    .remove({
      channel: channelId,
      name: 'hourglass_flowing_sand',
      timestamp: existing.threadTs,
    })
    .catch(() => {}); // fire-and-forget
}
```

Also remove in `handleError` (same pattern).

**Config field in manifest:**

```typescript
{
  key: 'typingIndicator',
  label: 'Typing Indicator',
  type: 'select',
  required: false,
  description: 'Show a visual indicator while the agent is working.',
  options: [
    { label: 'None', value: 'none' },
    { label: 'Emoji reaction', value: 'reaction' },
  ],
  visibleByDefault: true,
  helpMarkdown: 'When set to "Emoji reaction", adds an :hourglass_flowing_sand: reaction to your message while the agent is processing. Requires the `reactions:write` scope.',
},
```

#### Telegram: Interval Refresh

**Problem:** `handleTypingSignal` calls `sendChatAction(chatId, 'typing')` once, but Telegram's typing indicator expires after 5 seconds.

**Fix:** Add a `setInterval` that refreshes the typing indicator every 4 seconds. Clear it when the typing signal state changes to non-active or on adapter stop.

**File:** `packages/relay/src/adapters/telegram/outbound.ts`

```typescript
/** Active typing intervals keyed by chatId. */
const typingIntervals = new Map<number, ReturnType<typeof setInterval>>();

/** Refresh interval for Telegram typing indicator (expires after 5s). */
const TYPING_REFRESH_MS = 4_000;

export async function handleTypingSignal(
  bot: Bot | null,
  subject: string,
  state: string
): Promise<void> {
  if (!bot) return;
  const chatId = extractChatId(subject);
  if (chatId === null) return;

  if (state === 'active') {
    // Clear any existing interval (idempotent)
    clearTypingInterval(chatId);
    // Send immediately
    try {
      await bot.api.sendChatAction(chatId, 'typing');
    } catch {
      /* best-effort */
    }
    // Refresh every 4 seconds
    const intervalId = setInterval(async () => {
      try {
        await bot.api.sendChatAction(chatId, 'typing');
      } catch {
        clearTypingInterval(chatId);
      }
    }, TYPING_REFRESH_MS);
    typingIntervals.set(chatId, intervalId);
  } else {
    clearTypingInterval(chatId);
  }
}

function clearTypingInterval(chatId: number): void {
  const existing = typingIntervals.get(chatId);
  if (existing !== undefined) {
    clearInterval(existing);
    typingIntervals.delete(chatId);
  }
}

/** Clear all active typing intervals. Call on adapter stop. */
export function clearAllTypingIntervals(): void {
  for (const interval of typingIntervals.values()) clearInterval(interval);
  typingIntervals.clear();
}
```

**File:** `packages/relay/src/adapters/telegram/telegram-adapter.ts`

In `_stop()`, call `clearAllTypingIntervals()`:

```typescript
import { clearAllTypingIntervals } from './outbound.js';

protected async _stop(): Promise<void> {
  // ... existing cleanup ...
  clearAllTypingIntervals();
}
```

## User Experience

| Scenario             | Before                              | After                                               |
| -------------------- | ----------------------------------- | --------------------------------------------------- |
| Streaming in Slack   | Text appears on new lines, garbled  | Smooth continuous text flow                         |
| Agent CWD            | Agent works in server directory     | Agent works in binding's project directory          |
| Concurrent responses | Second response edits first message | Each response gets its own message                  |
| Streaming toggle     | Always streams                      | Configurable: stream (default) or single message    |
| Slack typing         | No feedback until first text        | :hourglass_flowing_sand: reaction on user's message |
| Telegram typing      | Indicator disappears after 5s       | Indicator persists until agent finishes             |

## Testing Strategy

### Unit Tests

#### Bug 1: Intermediate newline collapsing

**File:** `packages/relay/src/adapters/slack/__tests__/outbound.test.ts`

```typescript
describe('streaming — intermediate newline collapsing', () => {
  it('collapses consecutive newlines in intermediate chat.update calls', async () => {
    // Accumulate text with paragraph breaks
    // Verify intermediate chat.update text has single newlines
  });

  it('preserves paragraph formatting in final handleDone update', async () => {
    // Stream text_delta chunks, then done
    // Verify final chat.update has original paragraph breaks
  });
});
```

#### Bug 2: CWD propagation

**File:** `apps/server/src/services/relay/__tests__/binding-router.test.ts`

```typescript
describe('CWD propagation', () => {
  it('enriches republished payload with binding projectPath as cwd', async () => {
    // Create binding with projectPath = '/home/user/my-project'
    // Publish inbound message
    // Verify republished payload includes cwd: '/home/user/my-project'
  });

  it('preserves original payload fields when enriching with cwd', async () => {
    // Publish inbound with payload { content: 'hello', platformData: {...} }
    // Verify republished payload has all original fields plus cwd
  });
});
```

#### Bug 3: Stream key collision

**File:** `packages/relay/src/adapters/slack/__tests__/outbound.test.ts`

```typescript
describe('streaming — stream key isolation', () => {
  it('uses platformData.ts as thread anchor when threadTs is undefined', async () => {
    // Create envelope with platformData.ts but no threadTs
    // Verify streamKey includes ts value
  });

  it('uses envelope.id as fallback when no platformData exists', async () => {
    // Create envelope without platformData
    // Verify stream key is unique per envelope
  });

  it('concurrent responses in same channel use separate stream state', async () => {
    // Send two text_delta events with different threadTs values
    // Verify each gets its own stream entry
    // Verify chat.postMessage called twice (not chat.update on first)
  });
});
```

#### Feature 1: Streaming toggle

```typescript
describe('streaming toggle — buffered mode', () => {
  it('accumulates text without posting when streaming is false', async () => {
    // Send text_delta with streaming: false
    // Verify chat.postMessage NOT called
    // Verify streamState has accumulated text
  });

  it('sends single message on done when streaming is false', async () => {
    // Send text_delta + done with streaming: false
    // Verify chat.postMessage called once (on done)
    // Verify text is complete accumulated content
  });

  it('handles error in buffered mode', async () => {
    // Send text_delta + error with streaming: false
    // Verify message includes accumulated text + error suffix
  });
});
```

#### Feature 2: Typing indicators

**Slack reactions:**

```typescript
describe('typing indicator — emoji reaction', () => {
  it('adds reaction on stream start when typingIndicator is reaction', async () => {
    // Send first text_delta with typingIndicator: 'reaction'
    // Verify reactions.add called with hourglass_flowing_sand
  });

  it('removes reaction on done', async () => {
    // Send text_delta + done with typingIndicator: 'reaction'
    // Verify reactions.remove called
  });

  it('does not add reaction when typingIndicator is none', async () => {
    // Send text_delta with typingIndicator: 'none'
    // Verify reactions.add NOT called
  });

  it('swallows reaction errors silently', async () => {
    // Mock reactions.add to reject
    // Verify delivery still succeeds
  });
});
```

**Telegram interval refresh:**

```typescript
describe('typing indicator — interval refresh', () => {
  it('calls sendChatAction immediately on active signal', async () => {
    // Emit active typing signal
    // Verify sendChatAction called once immediately
  });

  it('refreshes sendChatAction every 4 seconds', async () => {
    vi.useFakeTimers();
    // Emit active typing signal
    // Advance timer by 8 seconds
    // Verify sendChatAction called 3 times (1 immediate + 2 intervals)
    vi.useRealTimers();
  });

  it('clears interval on non-active signal', async () => {
    vi.useFakeTimers();
    // Emit active signal, then stopped signal
    // Advance timer
    // Verify no further sendChatAction calls after stop
    vi.useRealTimers();
  });

  it('clears all intervals on adapter stop', async () => {
    // Start adapter, emit active signal
    // Stop adapter
    // Verify clearAllTypingIntervals called
  });
});
```

### Integration Tests

No new browser/E2E tests required — these changes are in the relay package layer, validated by unit tests with mocked Slack/Telegram APIs.

## Performance Considerations

- **Newline collapsing**: Single `String.replace()` per intermediate update — negligible cost
- **CWD enrichment**: One object spread per inbound message — negligible
- **Stream ID generation**: `crypto.randomUUID()` per stream start — negligible
- **Buffered mode**: Accumulates full response in memory before sending. Bounded by `MAX_MESSAGE_LENGTH` (4000 chars) — negligible memory
- **Emoji reactions**: 2 API calls per stream (add + remove). Fire-and-forget, does not block streaming. Slack rate limit: Tier 3 (50 req/min) — safe for typical usage
- **Telegram typing intervals**: 1 `sendChatAction` call per 4 seconds per active stream. Lightweight API call. Even with 10 concurrent streams, 150 calls/min is within workspace burst budget

## Security Considerations

- **`reactions:write` scope**: Bot-level scope only. Does not grant message read access or user enumeration. Safe to add. Users must re-install the Slack app to grant this scope.
- **CWD enrichment**: `binding.projectPath` is user-configured, not from external input. No injection risk.
- **Typing interval map**: Holds `setInterval` handles keyed by numeric Telegram chat IDs. No sensitive data. Bounded by active stream count.

## Documentation

- Update `contributing/relay-adapters.md` to document the `streaming` and `typingIndicator` config fields
- Update `SLACK_MANIFEST` setup steps to mention `reactions:write` scope (for emoji typing indicator)
- No external user-facing doc changes needed (relay config is managed via the DorkOS UI)

## Implementation Phases

### Phase 1: Bug Fixes

- Fix Bug 2 (CWD propagation in BindingRouter) — highest priority, data correctness
- Fix Bug 3 (stream key collision) — high priority, prevents message corruption
- Fix Bug 1 (newline collapsing) — medium priority, UX improvement

### Phase 2: Telegram Typing Refresh

- Add interval refresh to `handleTypingSignal`
- Add `clearAllTypingIntervals` cleanup
- Quick win (~30 lines), independent of other changes

### Phase 3: Streaming Toggle

- Add `streaming` field to `SlackAdapterConfigSchema`
- Thread config through `SlackDeliverOptions`
- Implement buffered mode logic in `handleTextDelta` and `handleDone`
- Add manifest configField

### Phase 4: Slack Typing Indicator

- Add `typingIndicator` field to `SlackAdapterConfigSchema`
- Add `reactions:write` to SLACK_APP_MANIFEST_YAML
- Implement emoji reaction add/remove in outbound handlers
- Add manifest configField

## Related ADRs

- **ADR-046**: Central BindingRouter for Adapter-Agent Routing — defines the routing architecture that Bug 2 fixes
- **ADR-047**: Most-Specific-First Binding Resolution — context for binding resolution scoring
- **ADR-094**: Per-Message Correlation ID for Relay Event Filtering — relevant to Bug 3's stream key collision fix approach
- **ADR-118**: Slack Native Streaming API (draft) — future `chatStream` migration would supersede the streaming toggle
- **ADR-119**: Slack Socket Mode Only (draft) — confirms Socket Mode is the only transport
- **ADR-120**: Shared Format Conversion Layer (draft) — context for `formatForPlatform()` and `slackify-markdown` usage

## References

- [slackify-markdown Issue #40: Don't create new sections between line breaks](https://github.com/jsarafajr/slackify-markdown/issues/40)
- [Slack bolt-js Issue #885: No bot typing indicator in Events API](https://github.com/slackapi/bolt-js/issues/885)
- [Telegram sendChatAction: 5-second expiry, refresh pattern](https://telegram-bot-sdk.readme.io/reference/sendchataction)
- [Slack Formatting Reference: mrkdwn syntax](https://docs.slack.dev/messaging/formatting-message-text/)
- [Spec 108: Fix Relay CWD Passthrough in handleAgentMessage](specs/fix-relay-cwd-passthrough/02-specification.md) — complementary downstream fix
- [Spec 90: Fix Relay Agent-to-Agent Routing CWD Bug](specs/fix-relay-agent-routing-cwd/02-specification.md) — related Mesh integration fix
- [Research: Relay Adapter Streaming Fixes](research/20260314_relay_adapter_streaming_fixes.md)
