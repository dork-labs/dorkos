---
slug: slack-adapter
number: 127
created: 2026-03-13
status: specified
---

# Slack Adapter for Relay — Specification

## Overview

Add a built-in Slack adapter to the Relay message bus. The adapter uses `@slack/bolt` in Socket Mode to receive messages from Slack channels and DMs, and uses Slack's native streaming API (`chat.startStream`/`appendStream`/`stopStream`) to stream agent responses token-by-token. Bot responses always thread under the original message.

Additionally, introduce a shared `formatForPlatform()` helper in `payload-utils.ts` to centralize Markdown-to-platform format conversion across all adapters.

## Technical Design

### Architecture

The Slack adapter follows the same module decomposition as the Telegram adapter:

```
packages/relay/src/adapters/slack/
├── slack-adapter.ts     # Facade: lifecycle, Socket Mode, signal handling
├── inbound.ts           # Parse Slack events → StandardPayload → relay.publish()
├── outbound.ts          # Deliver relay messages → Slack via chatStream() or postMessage
├── index.ts             # Barrel exports
└── __tests__/
    ├── slack-adapter.test.ts
    ├── inbound.test.ts
    └── outbound.test.ts
```

### Subject Hierarchy

```
relay.human.slack.{channelId}             # DMs (Slack DM channel IDs start with 'D')
relay.human.slack.group.{channelId}       # Group channels (IDs start with 'C', 'G')
```

Parallel to Telegram's `relay.human.telegram.{chatId}` / `relay.human.telegram.group.{chatId}`.

### Dependencies

- `@slack/bolt` — Official Slack SDK (Socket Mode, Web API, events). Single dependency.
- `slackify-markdown` — Convert standard Markdown to Slack mrkdwn (179K weekly downloads, v5.0.0, actively maintained).

Both added to `packages/relay/package.json`.

---

## Module Specifications

### 1. `slack-adapter.ts` — Facade

Extends `BaseRelayAdapter` (unlike Telegram which implements `RelayAdapter` directly — the Slack adapter benefits from BaseRelayAdapter's boilerplate reduction since it doesn't need Telegram's complex reconnection logic).

```typescript
export class SlackAdapter extends BaseRelayAdapter {
  constructor(id: string, config: SlackAdapterConfig, displayName?: string)

  // BaseRelayAdapter hooks
  protected async _start(relay: RelayPublisher): Promise<void>
  protected async _stop(): Promise<void>
  async deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<DeliveryResult>
  async testConnection(): Promise<{ ok: boolean; error?: string; botUsername?: string }>
}
```

**`_start(relay)`:**
1. Create `@slack/bolt` `App` instance with `socketMode: true`, `token` (xoxb-), `appToken` (xapp-)
2. Register event listeners: `message` (channels + DMs), `app_mention` (when bot is @-mentioned in channels)
3. Start the Bolt app (`app.start()` — Socket Mode connects automatically)
4. Subscribe to Relay signals on `relay.human.slack.>` for typing indicators
5. Cache bot's own user ID (from `auth.test`) for echo prevention

**`_stop()`:**
1. Unsubscribe from Relay signals
2. Call `app.stop()` — Bolt handles Socket Mode WebSocket cleanup
3. Clear DM channel cache and response stream state

**`testConnection()`:**
1. Create a temporary `WebClient` with the bot token
2. Call `auth.test()` — returns bot user ID and workspace name
3. Return `{ ok: true, botUsername }` or `{ ok: false, error }`
4. No side effects (no Socket Mode connection, no event listeners)

**Signal handling:**
- Subscribe to `relay.human.slack.>` signals
- On `typing` signal with `state: 'active'`: call Bolt's `client.chat.postMessage` with a typing indicator (Slack doesn't have a native typing action for bots — skip this, unlike Telegram)

### 2. `inbound.ts` — Parse Slack Events

```typescript
export const SUBJECT_PREFIX = 'relay.human.slack';

export function buildSubject(channelId: string, isGroup: boolean): string
export function extractChannelId(subject: string): string | null
export async function handleInboundMessage(
  event: SlackMessageEvent,
  client: WebClient,
  relay: RelayPublisher,
  botUserId: string,
  callbacks: InboundCallbacks,
): Promise<void>
```

**`handleInboundMessage`:**
1. Skip bot's own messages (compare `event.user` against cached bot user ID) — echo prevention
2. Skip message subtypes that aren't user-generated text (`channel_join`, `channel_leave`, `bot_message`, etc.)
3. Determine channel type:
   - Channel ID starts with `D` → DM (`channelType: 'dm'`)
   - Channel ID starts with `C` or `G` → group (`channelType: 'group'`)
4. Build subject: `relay.human.slack.{channelId}` (DM) or `relay.human.slack.group.{channelId}` (group)
5. Resolve channel name for groups via `conversations.info` (cached — Slack channel names don't change often)
6. Build `StandardPayload`:

```typescript
const payload: StandardPayload = {
  content: event.text.slice(0, MAX_CONTENT_LENGTH),  // 32KB cap
  senderName: await resolveUserName(client, event.user),  // cached
  channelName: isGroup ? channelName : undefined,
  channelType: isGroup ? 'group' : 'dm',
  responseContext: {
    platform: 'slack',
    maxLength: MAX_MESSAGE_LENGTH,  // 4000 chars (Slack's limit)
    supportedFormats: ['text', 'mrkdwn'],
    instructions: `Reply to subject ${subject} to respond to this Slack message.`,
  },
  platformData: {
    channelId: event.channel,
    userId: event.user,
    ts: event.ts,
    threadTs: event.thread_ts,
    teamId: event.team,
  },
};
```

7. Publish to relay with `from: 'relay.human.slack.bot'`, `replyTo: subject`

**User name resolution:**
- Call `users.info` API → cache result by user ID (Map<string, string>)
- Fallback to `event.user` (the user ID) if API call fails
- Cache is per-adapter-lifetime (cleared on stop)

**Channel name resolution:**
- Call `conversations.info` API → cache by channel ID
- Fallback to channel ID if API call fails

### 3. `outbound.ts` — Deliver to Slack

```typescript
export async function deliverMessage(
  adapterId: string,
  subject: string,
  envelope: RelayEnvelope,
  context: AdapterContext | undefined,
  client: WebClient | null,
  streamState: Map<string, ActiveStream>,
  botUserId: string,
  callbacks: OutboundCallbacks,
): Promise<DeliveryResult>
```

**Key difference from Telegram:** Instead of buffering `text_delta` chunks and sending one message at the end, the Slack adapter uses native streaming:

**StreamEvent handling:**

1. **`text_delta`**:
   - If no active stream for this channel: start one via `client.chatStream()` with `channel`, `thread_ts` (from original message's `platformData.ts` or `platformData.threadTs`)
   - Convert the text chunk from Markdown to mrkdwn using `formatForPlatform(text, 'slack')`
   - Call `streamer.append({ markdown_text: chunk })`
   - Store the active `ChatStreamer` in `streamState` map keyed by channel ID

2. **`done`**:
   - If active stream exists: call `streamer.stop()` — optionally with feedback buttons block
   - Remove from `streamState` map
   - Track outbound message count

3. **`error`**:
   - If active stream exists: append error text, then stop the stream
   - If no active stream: post a standalone error message via `chat.postMessage`

4. **Silent events** (`SILENT_EVENT_TYPES`): skip silently, return success

**Standard payload (non-StreamEvent):**
- Extract content via `extractPayloadContent()`
- Convert to mrkdwn via `formatForPlatform(content, 'slack')`
- Truncate to `MAX_MESSAGE_LENGTH` (4000 chars)
- Send via `client.chat.postMessage({ channel, text, thread_ts })`
- Always include `thread_ts` from the original inbound message's `platformData.ts`

**Thread tracking:**
- The `streamState` map stores `{ streamer: ChatStreamer, threadTs: string }` per channel
- `threadTs` comes from the inbound message's `platformData.ts` (the original message timestamp serves as thread parent)
- For DMs: `thread_ts` is still set (Slack threads work in DMs too, keeping context grouped)

**DM channel resolution:**
- For subjects like `relay.human.slack.D12345`, the channel ID is the DM channel — send directly
- For subjects routed through bindings, the channel ID is already in the subject
- Cache `conversations.open` results for programmatic DM initiation (not needed for reply-based flow, but available for agent-initiated outbound)

**Echo prevention:**
- Skip envelopes where `envelope.from` starts with `relay.human.slack` (same pattern as Telegram)

### 4. `SLACK_MANIFEST` — Static Manifest

```typescript
export const SLACK_MANIFEST: AdapterManifest = {
  type: 'slack',
  displayName: 'Slack',
  description: 'Send and receive messages in Slack channels and DMs.',
  iconEmoji: '#',  // Slack's hash symbol
  category: 'messaging',
  docsUrl: 'https://api.slack.com/start',
  builtin: true,
  multiInstance: true,
  actionButton: {
    label: 'Create Slack App',
    url: 'https://api.slack.com/apps',
  },
  setupSteps: [
    {
      stepId: 'create-app',
      title: 'Create a Slack App',
      description: 'Go to api.slack.com/apps → Create New App → From Scratch. Enable Socket Mode in the app settings.',
      fields: ['botToken', 'appToken', 'signingSecret'],
    },
  ],
  configFields: [
    {
      key: 'botToken',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: 'xoxb-...',
      description: 'Bot User OAuth Token from OAuth & Permissions page.',
      pattern: '^xoxb-',
      patternMessage: 'Bot tokens start with xoxb-',
      visibleByDefault: true,
    },
    {
      key: 'appToken',
      label: 'App-Level Token',
      type: 'password',
      required: true,
      placeholder: 'xapp-...',
      description: 'App-Level Token with connections:write scope. Generate in Basic Information → App-Level Tokens.',
      pattern: '^xapp-',
      patternMessage: 'App tokens start with xapp-',
      visibleByDefault: true,
    },
    {
      key: 'signingSecret',
      label: 'Signing Secret',
      type: 'password',
      required: true,
      placeholder: 'abc123...',
      description: 'Signing Secret from Basic Information page. Used to verify requests.',
    },
  ],
  setupInstructions:
    'Create a Slack app at api.slack.com/apps. Enable Socket Mode. Add bot token scopes: channels:history, channels:read, chat:write, groups:history, groups:read, im:history, im:read, im:write, mpim:history, app_mentions:read, users:read. Subscribe to events: message.channels, message.groups, message.im, app_mention. Generate an App-Level Token with connections:write scope.',
};
```

---

## Shared Format Conversion Layer

### `payload-utils.ts` Enhancement

Add a `formatForPlatform()` function to `packages/relay/src/lib/payload-utils.ts`:

```typescript
/**
 * Convert standard Markdown to a platform-specific format.
 *
 * @param content - Standard Markdown text (as produced by agents)
 * @param platform - Target platform identifier
 * @returns Content formatted for the target platform
 */
export function formatForPlatform(
  content: string,
  platform: 'slack' | 'telegram' | 'plain',
): string
```

**Implementation:**
- `'slack'`: Use `slackify-markdown` to convert standard Markdown → Slack mrkdwn
- `'telegram'`: Pass through (Telegram accepts standard Markdown via `parse_mode: 'MarkdownV2'`, but our current implementation sends plain text — this is a future enhancement, not in scope for this spec)
- `'plain'`: Strip Markdown formatting (for webhook adapter and similar)

**Import note:** `slackify-markdown` is added to `packages/relay/package.json`. The function is a thin wrapper — the platform switch is minimal and doesn't warrant a separate module.

---

## Integration Points

### 1. Shared Schemas (`packages/shared/src/relay-adapter-schemas.ts`)

**Add `'slack'` to `AdapterTypeSchema`:**

```typescript
export const AdapterTypeSchema = z
  .enum(['telegram', 'webhook', 'claude-code', 'slack', 'plugin'])
  .openapi('AdapterType');
```

**Add `SlackAdapterConfigSchema`:**

```typescript
export const SlackAdapterConfigSchema = z
  .object({
    botToken: z.string().min(1),
    appToken: z.string().min(1),
    signingSecret: z.string().min(1),
  })
  .openapi('SlackAdapterConfig');

export type SlackAdapterConfig = z.infer<typeof SlackAdapterConfigSchema>;
```

**Add to `AdapterConfigSchema.config` union:**

```typescript
config: z.union([
  TelegramAdapterConfigSchema,
  WebhookAdapterConfigSchema,
  SlackAdapterConfigSchema,
  z.record(z.string(), z.unknown()),
]),
```

### 2. Adapter Factory (`apps/server/src/services/relay/adapter-factory.ts`)

**Add `slack` case:**

```typescript
case 'slack':
  return new SlackAdapter(
    config.id,
    config.config as SlackAdapterConfig,
  );
```

**Add import:**

```typescript
import { SlackAdapter } from '@dorkos/relay';
import type { SlackAdapterConfig } from '@dorkos/relay';
```

### 3. Adapter Manager (`apps/server/src/services/relay/adapter-manager.ts`)

**Register SLACK_MANIFEST in `populateBuiltinManifests()`:**

```typescript
import { SLACK_MANIFEST } from '@dorkos/relay';

// In populateBuiltinManifests():
this.manifests.set('slack', SLACK_MANIFEST);
```

### 4. Package Exports (`packages/relay/src/index.ts`)

**Add exports:**

```typescript
export { SlackAdapter, SLACK_MANIFEST } from './adapters/slack/index.js';
export type { SlackAdapterConfig } from './adapters/slack/index.js';

// Re-export format utility
export { formatForPlatform } from './lib/payload-utils.js';
```

### 5. Type Re-exports (`packages/relay/src/types.ts`)

**Add SlackAdapterConfig re-export:**

```typescript
export type { SlackAdapterConfig } from '@dorkos/shared/relay-schemas';
```

---

## Implementation Phases

### Phase 1: Shared Infrastructure
1. Add `slackify-markdown` to `packages/relay/package.json`
2. Add `formatForPlatform()` to `payload-utils.ts` with tests
3. Add `'slack'` to `AdapterTypeSchema` and `SlackAdapterConfigSchema` in shared schemas
4. Add `SlackAdapterConfig` type re-export in `packages/relay/src/types.ts`

### Phase 2: Slack Adapter Core
5. Create `packages/relay/src/adapters/slack/inbound.ts` — subject builders, event parsing, StandardPayload construction
6. Create `packages/relay/src/adapters/slack/outbound.ts` — deliver via chatStream() / postMessage, stream state management, echo prevention
7. Create `packages/relay/src/adapters/slack/slack-adapter.ts` — facade extending BaseRelayAdapter, Bolt app lifecycle, testConnection()
8. Create `packages/relay/src/adapters/slack/index.ts` — barrel exports
9. Add `@slack/bolt` to `packages/relay/package.json`

### Phase 3: Integration
10. Export `SlackAdapter`, `SLACK_MANIFEST` from `packages/relay/src/index.ts`
11. Add `slack` case to `adapter-factory.ts`
12. Register `SLACK_MANIFEST` in `adapter-manager.ts`

### Phase 4: Tests
13. Write `inbound.test.ts` — subject building, event parsing, echo prevention, user name caching
14. Write `outbound.test.ts` — stream lifecycle (start → append → stop), standard payload delivery, echo prevention, error handling
15. Write `slack-adapter.test.ts` — lifecycle idempotency, testConnection, signal handling
16. Write `payload-utils.test.ts` additions — `formatForPlatform()` coverage

---

## Testing Strategy

### Unit Tests

**`inbound.test.ts`:**
- `buildSubject()` returns correct subjects for DMs vs groups
- `extractChannelId()` parses subjects correctly, returns null for invalid
- `handleInboundMessage()` skips bot's own messages (echo prevention)
- `handleInboundMessage()` skips non-user message subtypes
- `handleInboundMessage()` correctly categorizes DMs (D-prefix) vs groups (C/G-prefix)
- `handleInboundMessage()` builds StandardPayload with correct `platformData`
- `handleInboundMessage()` caps content at `MAX_CONTENT_LENGTH`
- `handleInboundMessage()` records error on relay.publish failure without throwing

**`outbound.test.ts`:**
- `deliverMessage()` skips envelopes from `relay.human.slack.*` (echo prevention)
- `deliverMessage()` returns error when client is null
- `deliverMessage()` starts stream on first `text_delta`, appends on subsequent
- `deliverMessage()` stops stream on `done` event
- `deliverMessage()` handles `error` event with buffered content
- `deliverMessage()` skips silent event types
- `deliverMessage()` sends standard payloads via `chat.postMessage` with `thread_ts`
- `deliverMessage()` converts Markdown to mrkdwn via `formatForPlatform()`
- `deliverMessage()` truncates messages to `MAX_MESSAGE_LENGTH`

**`slack-adapter.test.ts`:**
- Constructor sets correct `id`, `subjectPrefix`, `displayName`
- `start()` is idempotent (second call returns without error)
- `stop()` is idempotent
- `testConnection()` validates token via `auth.test`
- `testConnection()` returns `{ ok: false, error }` on invalid token
- `deliver()` delegates to `deliverMessage()`

**`payload-utils.test.ts` additions:**
- `formatForPlatform('**bold**', 'slack')` returns `*bold*`
- `formatForPlatform('**bold**', 'plain')` returns `bold`
- `formatForPlatform('**bold**', 'telegram')` passes through unchanged (for now)

### Mock Strategy

- Mock `@slack/bolt` `App` class — don't connect to real Slack
- Mock `WebClient` methods (`auth.test`, `chat.postMessage`, `conversations.info`, `users.info`)
- Mock `chatStream()` helper — verify `append()` and `stop()` are called correctly
- Use the same callback pattern as Telegram tests for status mutations

---

## Constants

| Constant | Value | Rationale |
|----------|-------|-----------|
| `SUBJECT_PREFIX` | `'relay.human.slack'` | Parallel to Telegram's `relay.human.telegram` |
| `MAX_MESSAGE_LENGTH` | `4000` | Slack's hard limit is 4000 chars for text content |
| `MAX_CONTENT_LENGTH` | `32_768` | Same 32KB inbound cap as Telegram |
| `GROUP_SEGMENT` | `'group'` | Same segment name as Telegram for consistency |

---

## Acceptance Criteria

1. A user can configure a Slack adapter instance via the adapter catalog UI (bot token, app token, signing secret)
2. The adapter connects to Slack via Socket Mode — no public URL required
3. Messages sent in Slack channels (where bot is invited) and DMs are received and published to Relay
4. Agent responses stream to Slack using native `chatStream()` API — users see tokens appear in real-time
5. All bot responses are threaded under the original message
6. Standard Markdown from agents is converted to Slack's mrkdwn format
7. `testConnection()` validates credentials without starting Socket Mode
8. The adapter is idempotent (start/stop safe to call multiple times)
9. Echo prevention: bot doesn't respond to its own messages
10. `formatForPlatform()` is available as a shared utility for all adapters

---

## Non-Goals (Deferred)

- HTTP Events API mode (Socket Mode is sufficient for DorkOS's self-hosted use case)
- Slash commands integration
- Interactive Block Kit actions (beyond feedback buttons in `stopStream`)
- Slack App Home tab
- Multi-workspace Enterprise Grid support
- Telegram adapter migration to use `formatForPlatform()` (future cleanup)
