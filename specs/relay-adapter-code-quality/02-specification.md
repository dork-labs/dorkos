# Relay Adapter System Code Quality & DRY Remediation

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-03-18
**Spec Number:** 149
**Slug:** relay-adapter-code-quality

---

## Overview

Deep code review of the Relay adapter system identified 6 DRY violations, 2 files breaching the hard 500-line limit, module-level mutable state shared across multi-instance adapters, an incomplete Telegram markdown formatter, and fragile `as unknown` API casts. This specification addresses these structural and code quality gaps — no new features, only bringing the existing implementation up to the project's quality standard.

This specification covers:

1. **Split `slack/outbound.ts`** (975 lines → 3 files)
2. **Extract shared envelope helpers** to `payload-utils.ts`
3. **Migrate `WebhookAdapter` to `BaseRelayAdapter`**
4. **Move callback factories** to `BaseRelayAdapter`
5. **Instance-scope module-level mutable state**
6. **Type streaming API wrappers** (isolate `as unknown` casts)
7. **Implement Telegram markdown formatting** (close TODO)
8. **Split `adapter-manager.ts`** (590 lines → 2 files)
9. **Eliminate `PublishResultLike`** type alias

## Background / Problem Statement

The Relay architecture is sound — NATS-style subjects, Maildir+SQLite hybrid, adapter plugin system, `BaseRelayAdapter` pattern are well-designed. But the implementations accumulated technical debt as features were added quickly:

**DRY violations** — The same envelope extraction functions (`extractAgentIdFromEnvelope`, `extractSessionIdFromEnvelope`) are copy-pasted between Telegram and Slack outbound files. The same callback factory pattern (`makeInboundCallbacks`, `makeOutboundCallbacks`) is duplicated in both adapter facades. The WebhookAdapter reimplements ~80 lines of status tracking that `BaseRelayAdapter` already provides.

**File size breaches** — `slack/outbound.ts` at 975 lines is nearly 2x the hard 500-line limit. `adapter-manager.ts` at 590 lines exceeds 500. Per `.claude/rules/file-size.md`, files over 500 lines must be split.

**Multi-instance state corruption risk** — Both outbound modules use module-level `Map`s for mutable state (Telegram has 4, Slack has 1). Since `multiInstance: true` is enabled, multiple adapter instances share this global state. Approving a button on one bot's message could affect another instance. State also persists across adapter stop/start cycles.

**Incomplete implementation** — `formatForPlatform('telegram')` in `lib/payload-utils.ts:172` is a passthrough with a TODO comment. Telegram users see raw markdown markers instead of formatted text.

**Fragile API casts** — Both Telegram (`sendMessageDraft`) and Slack (`chat.startStream`/`appendStream`/`stopStream`) streaming APIs use `as unknown as Record<string, ...>` casts scattered across delivery code.

## Goals

- Bring all relay files under the 500-line hard limit and target <300 lines where possible
- Eliminate all identified DRY violations with shared utilities
- Scope mutable state to adapter instances — prevent cross-instance contamination
- Complete the Telegram markdown formatting implementation
- Isolate streaming API type casts to single-file wrappers
- Zero behavioral changes — all existing tests must continue to pass
- Zero breaking changes to the public `@dorkos/relay` API surface

## Non-Goals

- New adapter implementations (Discord, email, etc.)
- Changes to the relay publish pipeline or core message flow (`relay-publish.ts`, `relay-core.ts`)
- Relay Panel client-side UI changes
- Binding system changes (`BindingStore`, `BindingRouter` logic)
- Performance optimization of the Maildir or SQLite layers
- Changes to the compliance test suite or adapter template
- Refactoring `sqlite-index.ts` (466 lines) or `maildir-store.ts` (457 lines) — these are in the 300-500 range and can be addressed separately

## Technical Dependencies

- `slackify-markdown` — already a direct dependency, used for Slack formatting
- `@grammyjs/types` — already a transitive dependency via `grammy`
- No new external dependencies required for Telegram MarkdownV2 (inline implementation — see design section)

## Detailed Design

### Phase 1: Foundation (Shared Utilities)

#### 1a. Extract envelope helpers to `payload-utils.ts`

Move `extractAgentIdFromEnvelope` and `extractSessionIdFromEnvelope` from both outbound files to `lib/payload-utils.ts`.

**Current** (duplicated in `telegram/outbound.ts:341-356` and `slack/outbound.ts:844-859`):

```typescript
function extractAgentIdFromEnvelope(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as Record<string, unknown>).data;
    if (data && typeof data === 'object' && 'agentId' in data) {
      return (data as Record<string, unknown>).agentId as string | undefined;
    }
  }
  return undefined;
}
```

**After** (single implementation in `lib/payload-utils.ts`):

```typescript
/**
 * Extract the agent ID from a RelayEnvelope's nested payload data.
 *
 * Used by outbound delivery to correlate messages with agent sessions.
 *
 * @param envelope - The relay envelope to inspect
 * @returns The agent ID, or undefined if not present
 */
export function extractAgentIdFromEnvelope(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as Record<string, unknown>).data;
    if (data && typeof data === 'object' && 'agentId' in data) {
      return (data as Record<string, unknown>).agentId as string | undefined;
    }
  }
  return undefined;
}

/**
 * Extract the CCA session key from a RelayEnvelope's nested payload data.
 *
 * Used by outbound delivery to route approval responses to the correct session.
 *
 * @param envelope - The relay envelope to inspect
 * @returns The session key, or undefined if not present
 */
export function extractSessionIdFromEnvelope(envelope: RelayEnvelope): string | undefined {
  const payload = envelope.payload;
  if (payload && typeof payload === 'object' && 'data' in payload) {
    const data = (payload as Record<string, unknown>).data;
    if (data && typeof data === 'object' && 'ccaSessionKey' in data) {
      return (data as Record<string, unknown>).ccaSessionKey as string | undefined;
    }
  }
  return undefined;
}
```

Both outbound files import from `../../lib/payload-utils.js` and delete their local copies.

#### 1b. Move callback factories to `BaseRelayAdapter`

Add `makeInboundCallbacks()` and `makeOutboundCallbacks()` to `BaseRelayAdapter` as protected methods:

```typescript
// In base-adapter.ts

/** Callback types for inbound/outbound modules. */
export interface AdapterInboundCallbacks {
  trackInbound: () => void;
  recordError: (err: unknown) => void;
}

export interface AdapterOutboundCallbacks {
  trackOutbound: () => void;
  recordError: (err: unknown) => void;
}

export abstract class BaseRelayAdapter implements RelayAdapter {
  // ... existing members ...

  /** Build callbacks for inbound message handling modules. */
  protected makeInboundCallbacks(): AdapterInboundCallbacks {
    return {
      trackInbound: () => this.trackInbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }

  /** Build callbacks for outbound message delivery modules. */
  protected makeOutboundCallbacks(): AdapterOutboundCallbacks {
    return {
      trackOutbound: () => this.trackOutbound(),
      recordError: (err: unknown) => this.recordError(err),
    };
  }
}
```

Remove the duplicate `private makeInboundCallbacks()` and `private makeOutboundCallbacks()` methods from both `TelegramAdapter` and `SlackAdapter`. The inherited `protected` methods provide identical behavior.

**Note:** The callback interface types (`AdapterInboundCallbacks`, `AdapterOutboundCallbacks`) may already be defined in `types.ts`. If so, import them. If not, define them in `base-adapter.ts` and re-export from the barrel.

#### 1c. Implement Telegram MarkdownV2 formatting

Replace the passthrough in `formatForPlatform('telegram')` with a proper implementation using Telegram's HTML parse mode (simpler escaping than MarkdownV2):

```typescript
case 'telegram':
  return markdownToTelegramHtml(content);
```

The `markdownToTelegramHtml` helper converts standard markdown to Telegram's HTML subset. Telegram's supported HTML tags: `<b>`, `<i>`, `<u>`, `<s>`, `<code>`, `<pre>`, `<a href="">`. This is a simpler target than MarkdownV2 (no need to escape `.`, `!`, `-`, `(`, `)`, etc.).

```typescript
/**
 * Convert standard Markdown to Telegram's supported HTML subset.
 *
 * Telegram supports: <b>, <i>, <u>, <s>, <code>, <pre>, <a href="">.
 * HTML parse mode avoids MarkdownV2's painful escaping requirements.
 *
 * @param md - Standard Markdown text
 * @returns HTML suitable for Telegram's `parse_mode: 'HTML'`
 */
function markdownToTelegramHtml(md: string): string {
  let html = md;

  // Escape HTML entities first (before adding our own tags)
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks (```lang\n...\n```) → <pre><code class="language-lang">...</code></pre>
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang, code) => {
    const cls = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${cls}>${code.trimEnd()}</code></pre>`;
  });

  // Inline code (`...`) → <code>...</code>
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Bold (**...**) → <b>...</b>
  html = html.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

  // Italic (*...*) → <i>...</i>
  html = html.replace(/\*(.+?)\*/g, '<i>$1</i>');

  // Strikethrough (~~...~~) → <s>...</s>
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Links [text](url) → <a href="url">text</a>
  html = html.replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2">$1</a>');

  // Headings (# ...) → bold (Telegram has no heading tag)
  html = html.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  return html;
}
```

**Important**: Telegram adapter's `sendMessage` calls will need `parse_mode: 'HTML'` when the content has been formatted. This is passed through the existing outbound delivery options.

### Phase 2: File Splitting

#### 2a. Split `slack/outbound.ts` (975 → 3 files)

**`slack/outbound.ts`** (~300 lines) — Main delivery router:
- `deliverMessage()` — the main entry point
- `wrapSlackCall()` — error wrapping helper
- `addTypingReaction()` / `removeTypingReaction()` — typing indicators
- `streamKey()` — composite key builder
- `resolveThreadTs()` — thread resolution
- `handlePlainMessage()` — non-streaming message delivery
- Imports from `./stream.js` and `./approval.js`

**`slack/stream.ts`** (~350 lines) — Streaming delivery:
- `ActiveStream` interface
- `handleTextDelta()` — buffer text deltas and flush periodically
- `handleDone()` — finalize stream and post final message
- `handleError()` — stream error handling
- `flushStreamBuffer()` — rate-limited buffer flush
- Stream reaping logic (TTL-based orphan cleanup)

**`slack/approval.ts`** (~250 lines) — Tool approval handling:
- `handleApprovalRequired()` — post Block Kit approval card
- `buildApprovalBlocks()` — construct Slack blocks
- `handleApprovalTimeout()` — timeout handler
- Approval timeout management (pending map, clear, fire)
- Imports `extractAgentIdFromEnvelope` and `extractSessionIdFromEnvelope` from `../../lib/payload-utils.js`

The `slack/index.ts` barrel controls the public API. All imports from outside the slack adapter directory go through the barrel — no external import path changes needed.

#### 2b. Split `adapter-manager.ts` (590 → 2 files)

**`adapter-manager.ts`** (~350 lines) — Adapter lifecycle:
- `AdapterManager` class — adapter registration, start/stop, config updates
- Hot-reload support
- Config watcher integration

**`binding-subsystem.ts`** (~250 lines) — Binding initialization:
- `initBindingSubsystem()` — creates BindingStore, BindingRouter, SessionStore
- Binding store/router/session store getters
- Binding configuration loading and validation

Both files remain in `apps/server/src/services/relay/`. The `AdapterManager` imports from `./binding-subsystem.js` and delegates binding initialization.

### Phase 3: Instance-Scoped State

#### 3a. Telegram outbound state

Move the 4 module-level Maps into a `TelegramOutboundState` container passed through the existing delivery options:

```typescript
/** Mutable state for Telegram outbound delivery, scoped to a single adapter instance. */
export interface TelegramOutboundState {
  typingIntervals: Map<number, ReturnType<typeof setInterval>>;
  lastDraftUpdate: Map<number, number>;
  callbackIdMap: Map<string, { toolCallId: string; sessionId: string; agentId: string }>;
  pendingApprovalTimeouts: Map<string, ReturnType<typeof setTimeout>>;
}

/** Create a fresh outbound state container. */
export function createTelegramOutboundState(): TelegramOutboundState {
  return {
    typingIntervals: new Map(),
    lastDraftUpdate: new Map(),
    callbackIdMap: new Map(),
    pendingApprovalTimeouts: new Map(),
  };
}
```

`TelegramAdapter` creates this in its constructor and passes it to `deliverMessage()` via the existing options bag:

```typescript
class TelegramAdapter extends BaseRelayAdapter {
  private readonly outboundState = createTelegramOutboundState();

  // In deliver():
  return deliverMessage(subject, envelope, {
    bot: this.bot!,
    relay: this.relay!,
    state: this.outboundState,   // ← new field
    callbacks: this.makeOutboundCallbacks(),
    // ...
  });
}
```

On `_stop()`, the adapter clears all state:

```typescript
protected async _stop(): Promise<void> {
  // Clear all pending intervals and timeouts
  for (const interval of this.outboundState.typingIntervals.values()) clearInterval(interval);
  for (const timeout of this.outboundState.pendingApprovalTimeouts.values()) clearTimeout(timeout);
  this.outboundState.typingIntervals.clear();
  this.outboundState.lastDraftUpdate.clear();
  this.outboundState.callbackIdMap.clear();
  this.outboundState.pendingApprovalTimeouts.clear();
  // ... existing stop logic
}
```

#### 3b. Slack outbound state

Same pattern for the single Slack module-level Map:

```typescript
/** Mutable state for Slack outbound delivery, scoped to a single adapter instance. */
export interface SlackOutboundState {
  pendingApprovalTimeouts: Map<string, {
    timer: ReturnType<typeof setTimeout>;
    channelId: string;
    messageTs: string;
    client: WebClient;
  }>;
}

export function createSlackOutboundState(): SlackOutboundState {
  return { pendingApprovalTimeouts: new Map() };
}
```

`SlackAdapter` creates this in its constructor and passes to `deliverMessage()`. On `_stop()`, clears all pending timeouts.

### Phase 4: Typed Streaming Wrappers

#### 4a. Telegram streaming wrapper

Create `telegram/stream-api.ts`:

```typescript
/**
 * Typed wrappers for Telegram's unofficial sendMessageDraft API.
 *
 * Encapsulates the `as unknown` cast in a single file. When grammy
 * adds official typing for draft messages, update only this file.
 *
 * @module relay/adapters/telegram/stream-api
 */
import type { Bot } from 'grammy';

interface SendMessageDraftParams {
  chat_id: number;
  text: string;
  draft_message_id?: number;
}

interface SendMessageDraftResponse {
  draft_message_id: number;
}

/**
 * Send a draft message (real-time streaming preview) to a Telegram chat.
 *
 * @param bot - The grammy Bot instance
 * @param chatId - Target chat ID
 * @param text - Message text to display as a draft
 * @param draftId - Existing draft ID to update (omit for new draft)
 * @returns The draft message ID for subsequent updates
 */
export async function sendMessageDraft(
  bot: Bot,
  chatId: number,
  text: string,
  draftId?: number,
): Promise<number> {
  const api = bot.api as unknown as {
    sendMessageDraft: (params: SendMessageDraftParams) => Promise<SendMessageDraftResponse>;
  };
  const result = await api.sendMessageDraft({
    chat_id: chatId,
    text,
    ...(draftId !== undefined && { draft_message_id: draftId }),
  });
  return result.draft_message_id;
}
```

#### 4b. Slack streaming wrapper

Create `slack/stream-api.ts`:

```typescript
/**
 * Typed wrappers for Slack's native streaming API (chat.startStream, etc.).
 *
 * Encapsulates the `as unknown` cast in a single file. When @slack/web-api
 * adds official types for streaming, update only this file.
 *
 * @module relay/adapters/slack/stream-api
 */
import type { WebClient } from '@slack/web-api';

interface StreamStartResult {
  ok: boolean;
  stream_id: string;
  channel: string;
  ts: string;
}

interface StreamAppendResult {
  ok: boolean;
}

interface StreamStopResult {
  ok: boolean;
}

/**
 * Start a native Slack stream in a channel or thread.
 *
 * @param client - The Slack WebClient instance
 * @param channel - Target channel ID
 * @param threadTs - Optional thread timestamp for threaded replies
 * @returns Stream metadata including the stream_id for subsequent updates
 */
export async function startStream(
  client: WebClient,
  channel: string,
  threadTs?: string,
): Promise<StreamStartResult> {
  const api = client as unknown as {
    chat: {
      startStream: (params: Record<string, unknown>) => Promise<StreamStartResult>;
    };
  };
  return api.chat.startStream({
    channel,
    ...(threadTs && { thread_ts: threadTs }),
  });
}

/**
 * Append text to an active Slack stream.
 *
 * @param client - The Slack WebClient instance
 * @param streamId - The stream ID from startStream
 * @param text - Text to append
 */
export async function appendStream(
  client: WebClient,
  streamId: string,
  text: string,
): Promise<StreamAppendResult> {
  const api = client as unknown as {
    chat: {
      appendStream: (params: Record<string, unknown>) => Promise<StreamAppendResult>;
    };
  };
  return api.chat.appendStream({ stream_id: streamId, text });
}

/**
 * Stop an active Slack stream and finalize the message.
 *
 * @param client - The Slack WebClient instance
 * @param streamId - The stream ID from startStream
 */
export async function stopStream(
  client: WebClient,
  streamId: string,
): Promise<StreamStopResult> {
  const api = client as unknown as {
    chat: {
      stopStream: (params: Record<string, unknown>) => Promise<StreamStopResult>;
    };
  };
  return api.chat.stopStream({ stream_id: streamId });
}
```

### Phase 5: Type Cleanup

#### 5a. Eliminate `PublishResultLike`

Move the `PublishResult` interface from `relay-publish.ts` to `types.ts`. Update `relay-publish.ts` to import `PublishResult` from `./types.js`. Delete `PublishResultLike` and update all references.

The dependency graph is unidirectional: `relay-publish.ts` imports from `types.ts`, not vice versa. No circular import risk.

### Phase 6: WebhookAdapter Migration

Migrate `WebhookAdapter` from manual status tracking to extending `BaseRelayAdapter`:

```typescript
export class WebhookAdapter extends BaseRelayAdapter {
  private readonly config: WebhookAdapterConfig;
  private readonly nonceMap = new Map<string, number>();
  private nonceInterval: ReturnType<typeof setInterval> | null = null;

  constructor(id: string, config: WebhookAdapterConfig, displayName?: string) {
    super(id, config.inbound.subject, displayName ?? `Webhook (${id})`);
    this.config = config;
  }

  protected async _start(relay: RelayPublisher): Promise<void> {
    // Nonce pruning interval (relay ref already stored by BaseRelayAdapter.start())
    this.nonceInterval = setInterval(() => {
      this.pruneExpiredNonces();
    }, NONCE_PRUNE_INTERVAL_MS);
  }

  protected async _stop(): Promise<void> {
    if (this.nonceInterval !== null) {
      clearInterval(this.nonceInterval);
      this.nonceInterval = null;
    }
    this.nonceMap.clear();
  }

  // deliver() and handleInbound() remain unchanged
}
```

This eliminates: manual `status` field, manual `start()`/`stop()` idempotency, manual `getStatus()`, and the `setLogger()` method — all provided by `BaseRelayAdapter`.

**`handleInbound()`** remains a public method — it's called by Express routes, not part of the `RelayAdapter` interface. `BaseRelayAdapter` doesn't interfere with it.

## User Experience

No user-facing changes except:

- **Telegram users** will see properly formatted messages (bold, italic, code blocks, links) instead of raw markdown markers
- **Multi-instance users** will no longer risk cross-instance state contamination (approval buttons, typing indicators)

## Testing Strategy

### Unit Tests

- **`payload-utils.test.ts`**: Add tests for `extractAgentIdFromEnvelope`, `extractSessionIdFromEnvelope`, and `markdownToTelegramHtml`
- **`base-adapter.test.ts`**: Add tests for `makeInboundCallbacks()` and `makeOutboundCallbacks()`
- **`stream-api.test.ts`** (both Slack and Telegram): Test typed wrappers call the underlying API correctly

### Integration Tests

- **Slack outbound split**: Run existing Slack adapter tests against the refactored code to verify no behavioral changes
- **WebhookAdapter migration**: Run existing webhook tests to verify identical behavior with `BaseRelayAdapter`

### Regression Testing

All existing tests must continue to pass. The refactoring is purely structural — no behavioral changes. Run the full test suite after each phase.

### Telegram Formatting Tests

Test `markdownToTelegramHtml` with:
- Bold, italic, strikethrough, inline code
- Code blocks with and without language hints
- Links with special characters in URLs
- Headings (converted to bold)
- Mixed formatting in a single string
- HTML entities in source (must be escaped before tag insertion)
- Empty strings and strings with no markdown

## Performance Considerations

No performance impact expected. All changes are structural reorganization:
- Import resolution is identical (same package, different file paths)
- Instance-scoped state uses the same `Map` data structures
- Streaming wrappers add one function call layer (negligible)

## Security Considerations

- **WebhookAdapter migration**: HMAC signature verification and nonce replay protection remain unchanged
- **No new external dependencies**: No new attack surface
- **Instance-scoped state**: Prevents cross-instance information leakage in multi-tenant scenarios

## Documentation

### Files to Update

- `contributing/relay-adapters.md` — Update to reference `BaseRelayAdapter.makeInboundCallbacks()` / `makeOutboundCallbacks()` and the callback interface types
- `packages/relay/src/index.ts` — Verify exports include new utilities (`extractAgentIdFromEnvelope`, `extractSessionIdFromEnvelope`, stream API wrappers if public)

### No New Docs Needed

This is a code quality remediation — no new features to document beyond the updated adapter development guide.

## Implementation Phases

### P1: Foundation (shared utilities + base class)
1. Extract envelope helpers to `payload-utils.ts`
2. Move callback factories to `BaseRelayAdapter`
3. Implement Telegram markdown formatting (`markdownToTelegramHtml`)

### P2: File Splitting (size compliance)
4. Split `slack/outbound.ts` → `outbound.ts` + `stream.ts` + `approval.ts`
5. Split `adapter-manager.ts` → `adapter-manager.ts` + `binding-subsystem.ts`

### P3: State & Type Safety
6. Instance-scope Telegram outbound state
7. Instance-scope Slack outbound state
8. Create typed streaming API wrappers (`telegram/stream-api.ts`, `slack/stream-api.ts`)
9. Migrate `WebhookAdapter` to extend `BaseRelayAdapter`

### P4: Cleanup
10. Eliminate `PublishResultLike` type alias
11. Update `contributing/relay-adapters.md`
12. Run full test suite, fix any regressions

## Open Questions

1. ~~**Telegram markdown format**~~ (RESOLVED)
   **Answer:** Use `parse_mode: 'HTML'` — simpler escaping, no need for MarkdownV2's painful character escaping rules. HTML covers all formatting we need (`<b>`, `<i>`, `<code>`, `<pre>`, `<a>`).

2. **TTL cache in `slack/inbound.ts`**: The hand-rolled bounded TTL cache (~30 lines) works correctly with proper eviction. Is it worth replacing with `lru-cache` (transitive dep) or leaving as-is?
   - Recommendation: Leave as-is. It works, it's tested by usage, and replacing it adds dependency coupling for minimal benefit.

3. ~~**`PublishResultLike` circular import risk**~~ (RESOLVED)
   **Answer:** No circular import risk exists. The import graph is unidirectional: `relay-publish.ts` → `types.ts`. Safe to consolidate.

## Related ADRs

- ADR-0043: Agent storage (file-first write-through) — establishes the pattern for data directory conventions referenced in adapter configuration
- Spec 119 (`relay-adapter-dx`): Introduced `BaseRelayAdapter` — this spec extends its adoption

## References

- Ideation document: `specs/relay-adapter-code-quality/01-ideation.md`
- Spec 119 (relay-adapter-dx): `specs/relay-adapter-dx/02-specification.md`
- File size rules: `.claude/rules/file-size.md`
- Code quality rules: `.claude/rules/code-quality.md`
- Telegram Bot API HTML formatting: https://core.telegram.org/bots/api#html-style
- `slackify-markdown` (existing dep for Slack formatting pattern reference)
