---
slug: chat-sdk-relay-adapter-refactor
number: 161
created: 2026-03-22
status: specified
---

# Chat SDK Relay Adapter Refactor — Specification

## Overview

This specification details the refactoring of the DorkOS relay adapter system to introduce three architectural improvements: a `PlatformClient` interface that abstracts platform communication from relay orchestration, an `AdapterStreamManager` that centralizes streaming lifecycle management across all adapters, and standardized thread ID encoding via `ThreadIdCodec`. These foundations are then validated by building a Chat SDK-backed Telegram adapter (`telegram-chatsdk`) alongside the existing grammy-based one.

Today, each adapter (Telegram, Slack) independently implements StreamEvent buffering, text_delta accumulation, done/error flushing, approval interruption, and thread ID encoding. This duplication creates maintenance burden and makes adding new platforms disproportionately expensive. The existing Telegram outbound module (`packages/relay/src/adapters/telegram/outbound.ts`) maintains per-chat `ResponseBuffer` maps with TTL reaping, throttled `sendMessageDraft` calls, and approval card rendering — all of which is largely repeated in the Slack adapter's `stream.ts` (500+ lines of native/legacy streaming, reaction-based typing, and per-channel `ActiveStream` state). By extracting the shared streaming orchestration into a relay-level `AdapterStreamManager` and standardizing platform communication behind `PlatformClient`, new adapters reduce to implementing a handful of platform-specific methods.

The Chat SDK Telegram adapter serves as proof-of-concept for this architecture. It wraps `@anthropic-ai/chat`'s `Chat` class with a `createTelegramAdapter()`, forwarding inbound events to relay subjects and implementing `deliverStream()` to send `AsyncIterable<string>` responses via Chat SDK's `thread.post()`. This validates that the new abstractions work for both hand-rolled (grammy, Bolt) and SDK-based implementations.

## Technical Design

### 1. PlatformClient Interface

The `PlatformClient` interface abstracts platform-specific communication (sending messages, editing, streaming) from relay-level orchestration (subject routing, envelope handling, status tracking). A `RelayAdapter` _owns_ a `PlatformClient` and delegates platform calls to it, while retaining responsibility for lifecycle, subject matching, and relay integration.

```typescript
/**
 * Low-level platform communication interface.
 *
 * Abstracts the mechanics of sending/editing/streaming messages on a
 * specific platform (Telegram, Slack, etc.) from the relay adapter's
 * orchestration concerns (subject routing, envelope handling, status).
 *
 * A RelayAdapter owns a PlatformClient and delegates platform API calls
 * to it. The PlatformClient never touches RelayEnvelopes or subjects —
 * it operates on thread IDs and content strings.
 */
export interface PlatformClient {
  /** Human-readable platform name for logging and diagnostics. */
  readonly platform: string;

  /**
   * Post a new message to a platform thread.
   *
   * @param threadId - Platform-native thread identifier (e.g., Telegram chatId, Slack channelId)
   * @param content - Message content (Markdown)
   * @param format - Optional format hint ('markdown' | 'html' | 'mrkdwn' | 'plain')
   * @returns Platform-native message identifier for later edits/deletes
   */
  postMessage(threadId: string, content: string, format?: string): Promise<{ messageId: string }>;

  /**
   * Edit an existing message in a platform thread.
   *
   * @param threadId - Platform-native thread identifier
   * @param messageId - Platform-native message identifier (from postMessage)
   * @param content - Updated content
   */
  editMessage(threadId: string, messageId: string, content: string): Promise<void>;

  /**
   * Delete a message from a platform thread.
   *
   * @param threadId - Platform-native thread identifier
   * @param messageId - Platform-native message identifier
   */
  deleteMessage(threadId: string, messageId: string): Promise<void>;

  /**
   * Set up inbound event forwarding from the platform to the relay.
   *
   * Called once during adapter start. The implementation registers platform-
   * specific event handlers (webhooks, polling, socket mode) and forwards
   * received messages to the relay via the provided publisher.
   *
   * @param relay - The RelayPublisher to forward inbound messages to
   */
  handleInbound(relay: RelayPublisher): void;

  /**
   * Stream content to a platform thread via AsyncIterable.
   *
   * Optional. When implemented, the AdapterStreamManager will call this
   * instead of postMessage for streaming responses. When absent, the
   * stream manager falls back to accumulating text and calling postMessage
   * on completion.
   *
   * @param threadId - Platform-native thread identifier
   * @param content - Async iterable of text chunks
   * @returns Platform-native message identifier for the streamed message
   */
  stream?(threadId: string, content: AsyncIterable<string>): Promise<{ messageId: string }>;

  /**
   * Post an interactive action card (e.g., tool approval buttons).
   *
   * Optional. Platforms that support inline buttons/actions implement this
   * to render approval_required events as interactive UI. When absent,
   * the adapter falls back to rendering a text description.
   *
   * @param threadId - Platform-native thread identifier
   * @param prompt - Human-readable description of the action
   * @param actions - Action buttons to render
   * @returns Platform-native message identifier for the action card
   */
  postAction?(
    threadId: string,
    prompt: string,
    actions: Array<{ label: string; value: string }>
  ): Promise<{ messageId: string }>;

  /**
   * Send a typing indicator to a platform thread.
   *
   * Optional. Platforms like Telegram have native typing indicators;
   * Slack uses emoji reactions. Implementations handle refresh intervals
   * and cleanup internally.
   *
   * @param threadId - Platform-native thread identifier
   */
  startTyping?(threadId: string): void;

  /** Stop the typing indicator for a platform thread. */
  stopTyping?(threadId: string): void;

  /**
   * Tear down platform connections (stop polling, close webhooks, etc.).
   *
   * Called during adapter stop. Must drain in-flight operations.
   */
  destroy(): Promise<void>;
}
```

**How existing adapters use PlatformClient:**

The `TelegramAdapter` extracts a `GrammyPlatformClient` that wraps the grammy `Bot` instance. The adapter's `deliver()` method parses the envelope, extracts the chat ID via `ThreadIdCodec`, and delegates to the platform client's `postMessage()`, `stream()`, or `postAction()` methods. The existing `outbound.ts` logic for `sendAndTrack()`, `handleApprovalRequired()`, and typing intervals moves into the platform client implementation.

The `SlackAdapter` extracts a `SlackPlatformClient` wrapping the Bolt `WebClient`. The existing `stream.ts` native/legacy streaming logic becomes the platform client's `stream()` implementation. The `approval.ts` Block Kit rendering becomes `postAction()`.

**Relationship to RelayAdapter:**

`PlatformClient` is lower-level and platform-focused. `RelayAdapter` is relay-focused: it owns lifecycle (`start`/`stop`), subject matching (`subjectPrefix`), envelope handling (`deliver`), and status tracking (`getStatus`). A `RelayAdapter` creates and owns a `PlatformClient`, using it as a delegate for all platform API calls. The `PlatformClient` never sees `RelayEnvelope` or relay subjects.

### 2. AdapterStreamManager

The `AdapterStreamManager` sits between the `AdapterDelivery` pipeline and the `AdapterRegistry`, intercepting StreamEvent payloads before they reach individual adapters. It aggregates `text_delta` events into `AsyncIterable<string>` streams and delivers them via the adapter's optional `deliverStream()` method.

#### AsyncQueue

```typescript
/**
 * Push-pull async iterable queue.
 *
 * Producers push values; consumers await them via `for await...of`.
 * Completes when `complete()` is called; throws when `fail()` is called.
 * Zero dependencies, ~45 lines.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolve: ((value: IteratorResult<T>) => void) | null = null;
  private done = false;
  private error: Error | null = null;

  /** Push a value to the queue. Ignored if already completed or failed. */
  push(value: T): void {
    if (this.done) return;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value, done: false });
    } else {
      this.queue.push(value);
    }
  }

  /** Signal that no more values will be pushed. */
  complete(): void {
    this.done = true;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      r({ value: undefined as unknown as T, done: true });
    }
  }

  /** Signal an error — the consumer's `for await` will throw. */
  fail(err: Error): void {
    this.done = true;
    this.error = err;
    if (this.resolve) {
      const r = this.resolve;
      this.resolve = null;
      // Reject via a throw in the next iteration
      r({ value: undefined as unknown as T, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      // Wait for next push/complete/fail
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolve = resolve;
      });
      if (result.done) {
        if (this.error) throw this.error;
        return;
      }
      yield result.value;
    }
  }
}
```

#### ActiveStreamContext

```typescript
/** Tracked state for an in-flight stream being delivered to an adapter. */
interface ActiveStreamContext {
  /** The async queue that text_delta chunks are pushed into. */
  queue: AsyncQueue<string>;
  /** Timestamp (ms) when the stream started — used for TTL reaping. */
  startedAt: number;
  /** The background promise for the deliverStream() call. */
  deliveryPromise: Promise<DeliveryResult>;
}
```

#### AdapterStreamManager Class

```typescript
/**
 * Relay-level stream aggregation manager.
 *
 * Intercepts StreamEvent payloads (text_delta, done, error, approval_required)
 * before they reach adapters. For adapters that implement `deliverStream()`,
 * aggregates text_delta events into an AsyncQueue and delivers the stream
 * as a single AsyncIterable. Falls back to per-event `deliver()` for adapters
 * that don't implement streaming.
 *
 * Keyed by `{adapterId}:{threadId}` to support concurrent streams across
 * different conversations and adapters.
 */
export class AdapterStreamManager {
  /** TTL for abandoned streams — matches existing BUFFER_TTL_MS (5 min). */
  static readonly STREAM_TTL_MS = 5 * 60 * 1_000;

  /** Reaping interval for abandoned streams (60 seconds). */
  static readonly REAP_INTERVAL_MS = 60_000;

  private readonly streams = new Map<string, ActiveStreamContext>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly logger?: RelayLogger) {}

  /** Start the TTL reaper interval. Call on relay startup. */
  start(): void {
    this.reapTimer = setInterval(
      () => this.reapStaleStreams(),
      AdapterStreamManager.REAP_INTERVAL_MS
    );
  }

  /** Stop the reaper and complete all active streams. Call on relay shutdown. */
  async stop(): Promise<void> {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
    for (const [key, ctx] of this.streams) {
      ctx.queue.complete();
      this.streams.delete(key);
    }
  }

  /**
   * Route a StreamEvent to the appropriate handler.
   *
   * @param adapterId - The matched adapter's ID
   * @param threadId - Platform thread ID (extracted by the adapter's codec)
   * @param eventType - The StreamEvent type (text_delta, done, error, approval_required)
   * @param envelope - The relay envelope
   * @param adapter - The matched adapter (for deliverStream/deliver fallback)
   * @param subject - The relay subject
   * @param context - Optional adapter context
   * @returns DeliveryResult, or null if the stream manager did not handle this event
   */
  async handleStreamEvent(
    adapterId: string,
    threadId: string,
    eventType: string,
    envelope: RelayEnvelope,
    adapter: RelayAdapter,
    subject: string,
    context?: AdapterContext
  ): Promise<DeliveryResult | null> {
    // Only intercept if the adapter implements deliverStream
    if (
      !('deliverStream' in adapter) ||
      typeof (adapter as StreamableAdapter).deliverStream !== 'function'
    ) {
      return null; // Fall through to adapter.deliver()
    }

    const streamKey = `${adapterId}:${threadId}`;

    switch (eventType) {
      case 'text_delta':
        return this.handleTextDelta(
          streamKey,
          envelope,
          adapter as StreamableAdapter,
          threadId,
          subject,
          context
        );
      case 'done':
        return this.handleDone(streamKey);
      case 'error':
        return this.handleError(streamKey, envelope);
      case 'approval_required':
        return this.handleApprovalRequired(streamKey, envelope, adapter, subject, context);
      default:
        return { success: true }; // Silently drop unknown stream events
    }
  }

  // ... private methods for each event type (see below)
}
```

**handleTextDelta flow:**

1. Check if an `ActiveStreamContext` exists for `streamKey`.
2. If not: create a new `AsyncQueue<string>`, create the `ActiveStreamContext`, call `adapter.deliverStream(threadId, queue)` in the background (store the promise), push the first text chunk.
3. If yes: push the text chunk to the existing queue.
4. Return `{ success: true }`.

**handleDone flow:**

1. Look up the `ActiveStreamContext` for `streamKey`.
2. If found: call `queue.complete()`, await the `deliveryPromise`, remove from map, return the result.
3. If not found: return `{ success: true }` (stream may have been reaped or never started).

**handleError flow:**

1. Look up the `ActiveStreamContext` for `streamKey`.
2. If found: extract error message from envelope, call `queue.fail(new Error(errorMsg))`, await `deliveryPromise` (catch expected rejection), remove from map.
3. If not found: return `{ success: true }`.

**handleApprovalRequired flow:**

1. Look up the `ActiveStreamContext` for `streamKey`.
2. If found: call `queue.complete()` to flush the current stream, await `deliveryPromise`, remove from map.
3. Return `null` — this signals the caller to fall through to `adapter.deliver()` for the approval event, which renders the platform-specific approval UI.

**Integration point:**

The `AdapterStreamManager` is instantiated in the server's relay setup (alongside `AdapterRegistry` and `AdapterDelivery`). In `AdapterRegistry.deliver()`, before calling `adapter.deliver()`, the registry checks if the payload is a StreamEvent. If so, it extracts the thread ID using the adapter's codec and passes the event to `AdapterStreamManager.handleStreamEvent()`. If the stream manager returns a `DeliveryResult`, it is returned directly. If it returns `null`, the event falls through to `adapter.deliver()`.

**deliverStream method on RelayAdapter (optional):**

```typescript
/**
 * Optional streaming delivery method.
 *
 * When present, the AdapterStreamManager routes aggregated text_delta
 * streams here instead of calling deliver() per-event. The adapter
 * receives a complete AsyncIterable of text chunks and is responsible
 * for rendering them to the platform in real-time.
 *
 * @param subject - The target relay subject
 * @param threadId - Platform-native thread identifier
 * @param stream - Async iterable of text chunks
 * @param context - Optional adapter context
 */
deliverStream?(
  subject: string,
  threadId: string,
  stream: AsyncIterable<string>,
  context?: AdapterContext
): Promise<DeliveryResult>;
```

This is added as an optional method on the `RelayAdapter` interface. Adapters that don't implement it continue receiving per-event `deliver()` calls unchanged.

**StreamableAdapter type guard:**

```typescript
/** Type guard for adapters that implement optional deliverStream(). */
interface StreamableAdapter extends RelayAdapter {
  deliverStream(
    subject: string,
    threadId: string,
    stream: AsyncIterable<string>,
    context?: AdapterContext
  ): Promise<DeliveryResult>;
}
```

### 3. Thread ID Standardization

Thread ID encoding/decoding is currently duplicated between Telegram's `buildSubject()`/`extractChatId()` and Slack's `buildSubject()`/`extractChannelId()`. Each uses its own convention for embedding DM vs group distinction in the subject string. A `ThreadIdCodec` interface standardizes this.

```typescript
/**
 * Codec for encoding/decoding platform thread IDs to/from relay subjects.
 *
 * Each platform adapter provides a codec that handles its subject format.
 * This replaces the per-adapter buildSubject/extractChatId/extractChannelId
 * functions with a unified interface.
 */
export interface ThreadIdCodec {
  /** The subject prefix this codec handles (e.g., 'relay.human.telegram'). */
  readonly prefix: string;

  /**
   * Build a relay subject from a platform thread ID.
   *
   * @param platformId - Platform-native identifier (e.g., Telegram chatId, Slack channelId)
   * @param channelType - Whether the thread is a DM or group conversation
   */
  encode(platformId: string, channelType: 'dm' | 'group'): string;

  /**
   * Extract a platform thread ID and channel type from a relay subject.
   *
   * @param subject - A relay subject under this codec's prefix
   * @returns Decoded thread info, or null if the subject doesn't match
   */
  decode(subject: string): { platformId: string; channelType: 'dm' | 'group' } | null;
}
```

#### TelegramThreadIdCodec

```typescript
/**
 * Thread ID codec for the Telegram adapter.
 *
 * Subject format:
 * - DM: `relay.human.telegram.{chatId}`
 * - Group: `relay.human.telegram.group.{chatId}`
 *
 * Replaces buildSubject() and extractChatId() from telegram/inbound.ts.
 */
export class TelegramThreadIdCodec implements ThreadIdCodec {
  readonly prefix = 'relay.human.telegram';

  encode(platformId: string, channelType: 'dm' | 'group'): string {
    if (channelType === 'group') {
      return `${this.prefix}.group.${platformId}`;
    }
    return `${this.prefix}.${platformId}`;
  }

  decode(subject: string): { platformId: string; channelType: 'dm' | 'group' } | null {
    if (!subject.startsWith(this.prefix)) return null;
    const remainder = subject.slice(this.prefix.length + 1);
    if (!remainder) return null;

    if (remainder.startsWith('group.')) {
      const id = remainder.slice('group.'.length);
      if (!id) return null;
      return { platformId: id, channelType: 'group' };
    }

    return { platformId: remainder, channelType: 'dm' };
  }
}
```

#### SlackThreadIdCodec

```typescript
/**
 * Thread ID codec for the Slack adapter.
 *
 * Subject format:
 * - DM: `relay.human.slack.{channelId}`
 * - Group: `relay.human.slack.group.{channelId}`
 *
 * Replaces buildSubject() and extractChannelId() from slack/inbound.ts.
 */
export class SlackThreadIdCodec implements ThreadIdCodec {
  readonly prefix = 'relay.human.slack';

  encode(platformId: string, channelType: 'dm' | 'group'): string {
    if (channelType === 'group') {
      return `${this.prefix}.group.${platformId}`;
    }
    return `${this.prefix}.${platformId}`;
  }

  decode(subject: string): { platformId: string; channelType: 'dm' | 'group' } | null {
    if (!subject.startsWith(this.prefix)) return null;
    const remainder = subject.slice(this.prefix.length + 1);
    if (!remainder) return null;

    if (remainder.startsWith('group.')) {
      const id = remainder.slice('group.'.length);
      return id ? { platformId: id, channelType: 'group' } : null;
    }

    return { platformId: remainder, channelType: 'dm' };
  }
}
```

#### ChatSdkThreadIdCodec

```typescript
/**
 * Thread ID codec for Chat SDK-backed adapters.
 *
 * Subject format:
 * - DM: `relay.human.telegram-chatsdk.{chatId}`
 * - Group: `relay.human.telegram-chatsdk.group.{chatId}`
 *
 * Same structural convention as existing adapters but with the
 * `telegram-chatsdk` prefix segment.
 */
export class ChatSdkTelegramThreadIdCodec implements ThreadIdCodec {
  readonly prefix = 'relay.human.telegram-chatsdk';

  encode(platformId: string, channelType: 'dm' | 'group'): string {
    if (channelType === 'group') {
      return `${this.prefix}.group.${platformId}`;
    }
    return `${this.prefix}.${platformId}`;
  }

  decode(subject: string): { platformId: string; channelType: 'dm' | 'group' } | null {
    if (!subject.startsWith(this.prefix)) return null;
    const remainder = subject.slice(this.prefix.length + 1);
    if (!remainder) return null;

    if (remainder.startsWith('group.')) {
      const id = remainder.slice('group.'.length);
      return id ? { platformId: id, channelType: 'group' } : null;
    }

    return { platformId: remainder, channelType: 'dm' };
  }
}
```

The codecs live in `packages/relay/src/lib/thread-id.ts`. Existing `buildSubject()` and `extractChatId()`/`extractChannelId()` functions in `inbound.ts` are refactored to delegate to the codec internally, preserving backward compatibility for any external callers.

### 4. Chat SDK Telegram Adapter

Full design for the new `telegram-chatsdk` adapter type.

**Class structure:**

```typescript
/**
 * Chat SDK-backed Telegram adapter for the Relay message bus.
 *
 * Wraps the Chat SDK's Telegram adapter to provide bidirectional
 * message handling. Uses Chat SDK for inbound event handling and
 * outbound streaming, while integrating with the relay subject
 * hierarchy via ThreadIdCodec.
 *
 * Streaming quality note: Chat SDK's Telegram adapter uses post+edit
 * at ~500ms intervals (no sendMessageDraft support). The existing
 * grammy-based TelegramAdapter has superior streaming via sendMessageDraft
 * at 200ms. This adapter prioritizes architectural validation over
 * streaming performance.
 */
export class ChatSdkTelegramAdapter extends BaseRelayAdapter {
  private readonly config: ChatSdkTelegramAdapterConfig;
  private readonly codec = new ChatSdkTelegramThreadIdCodec();
  private chat: Chat | null = null;

  constructor(
    id: string,
    config: ChatSdkTelegramAdapterConfig,
    displayName = 'Telegram (Chat SDK)'
  ) {
    super(id, 'relay.human.telegram-chatsdk', displayName);
    this.config = config;
  }

  protected async _start(relay: RelayPublisher): Promise<void> {
    this.chat = new Chat({
      adapters: {
        telegram: createTelegramAdapter({
          token: this.config.token,
          mode: this.config.mode ?? 'polling',
        }),
      },
      state: createMemoryState(),
    });

    // Forward Chat SDK inbound events to relay subjects
    this.chat.on('message', (event) => {
      const chatId = String(event.chat.id);
      const isGroup = event.chat.type === 'group' || event.chat.type === 'supergroup';
      const subject = this.codec.encode(chatId, isGroup ? 'group' : 'dm');

      const payload: StandardPayload = {
        content: event.text ?? '',
        senderName: event.from?.firstName ?? 'unknown',
        channelType: isGroup ? 'group' : 'dm',
        responseContext: {
          platform: 'telegram',
          maxLength: 4096,
          supportedFormats: ['text', 'markdown'],
          instructions: `Reply to subject ${subject} to respond.`,
        },
        platformData: {
          chatId: event.chat.id,
          messageId: event.messageId,
        },
      };

      relay
        .publish(subject, payload, {
          from: `${this.codec.prefix}.bot`,
          replyTo: subject,
        })
        .then(() => this.trackInbound())
        .catch((err) => this.recordError(err));
    });

    await this.chat.start();
  }

  protected async _stop(): Promise<void> {
    if (this.chat) {
      await this.chat.stop();
      this.chat = null;
    }
  }

  /**
   * Deliver a standard (non-streaming) relay message to Telegram via Chat SDK.
   *
   * Handles approval_required events by rendering text descriptions
   * (Chat SDK does not yet support inline keyboards for approval cards).
   */
  async deliver(
    subject: string,
    envelope: RelayEnvelope,
    _context?: AdapterContext
  ): Promise<DeliveryResult> {
    const startTime = Date.now();

    if (envelope.from.startsWith(this.codec.prefix)) {
      return { success: true, durationMs: Date.now() - startTime };
    }

    const decoded = this.codec.decode(subject);
    if (!decoded || !this.chat) {
      return {
        success: false,
        error: 'Cannot decode subject or chat not started',
        durationMs: Date.now() - startTime,
      };
    }

    const content = extractPayloadContent(envelope.payload);
    const eventType = detectStreamEventType(envelope.payload);

    if (eventType === 'approval_required') {
      const data = extractApprovalData(envelope.payload);
      if (data) {
        const text = `Tool Approval Required: ${data.toolName}\n\n${truncateText(data.input, 400)}`;
        const thread = this.chat.getThread(decoded.platformId);
        await thread.post(text);
        this.trackOutbound();
        return { success: true, durationMs: Date.now() - startTime };
      }
    }

    // For non-streaming events, post directly
    if (!eventType || eventType === 'done') {
      if (content) {
        const thread = this.chat.getThread(decoded.platformId);
        await thread.post(truncateText(content, 4096));
        this.trackOutbound();
      }
      return { success: true, durationMs: Date.now() - startTime };
    }

    return { success: true, durationMs: Date.now() - startTime };
  }

  /**
   * Stream an aggregated response to Telegram via Chat SDK.
   *
   * Called by AdapterStreamManager with an AsyncIterable of text chunks.
   * Delegates to Chat SDK's thread.post(asyncIterable) which handles
   * post+edit streaming internally.
   */
  async deliverStream(
    _subject: string,
    threadId: string,
    stream: AsyncIterable<string>,
    _context?: AdapterContext
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    if (!this.chat) {
      return { success: false, error: 'Chat SDK not started', durationMs: Date.now() - startTime };
    }

    try {
      const thread = this.chat.getThread(threadId);
      await thread.post(stream);
      this.trackOutbound();
      return { success: true, durationMs: Date.now() - startTime };
    } catch (err) {
      this.recordError(err);
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - startTime,
      };
    }
  }
}
```

**Config type:**

```typescript
/** Configuration for the Chat SDK Telegram adapter. */
export interface ChatSdkTelegramAdapterConfig {
  /** Telegram bot token from @BotFather. */
  token: string;
  /** Connection mode. Default: 'polling'. */
  mode?: 'polling' | 'webhook';
}
```

**Manifest:**

```typescript
export const TELEGRAM_CHATSDK_MANIFEST: AdapterManifest = {
  type: 'telegram-chatsdk',
  displayName: 'Telegram (Chat SDK)',
  description: 'Send and receive messages via Telegram using the Chat SDK. Experimental.',
  iconEmoji: '\u2708\uFE0F',
  category: 'messaging',
  docsUrl: 'https://github.com/anthropics/chat',
  builtin: true,
  multiInstance: true,
  actionButton: {
    label: 'Open @BotFather in Telegram',
    url: 'tg://resolve?domain=botfather',
  },
  setupSteps: [
    {
      stepId: 'get-token',
      title: 'Get your Bot Token',
      description: 'Create a bot with @BotFather on Telegram.',
      fields: ['token'],
    },
    {
      stepId: 'configure-mode',
      title: 'Choose connection mode',
      fields: ['mode'],
    },
  ],
  configFields: [
    {
      key: 'token',
      label: 'Bot Token',
      type: 'password',
      required: true,
      placeholder: '123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      description: 'Paste the token from @BotFather.',
      pattern: '^\\d+:[\\w-]{35,}$',
      patternMessage: 'Expected format: 123456789:ABCDefGHijklMNOpqrSTUvwxYZ',
      visibleByDefault: true,
    },
    {
      key: 'mode',
      label: 'Receiving Mode',
      type: 'select',
      required: true,
      default: 'polling',
      options: [
        { label: 'Long Polling', value: 'polling', description: 'Works everywhere.' },
        { label: 'Webhook', value: 'webhook', description: 'Requires public HTTPS URL.' },
      ],
    },
  ],
  setupInstructions:
    'Open Telegram and search for @BotFather. Send /newbot, choose a name and username. Copy the token provided.',
};
```

**File structure:**

```
packages/relay/src/adapters/telegram-chatsdk/
  ├── adapter.ts          # ChatSdkTelegramAdapter class
  ├── inbound.ts          # Chat SDK event → StandardPayload mapping
  ├── outbound.ts         # deliverStream() implementation + deliver() for approvals
  ├── index.ts            # Re-exports ChatSdkTelegramAdapter, TELEGRAM_CHATSDK_MANIFEST
```

### 5. Existing Adapter Refactoring

#### Telegram

**Extract `GrammyPlatformClient`:**

The existing `outbound.ts` functions (`sendAndTrack`, `handleApprovalRequired`, `handleTypingSignal`, `clearAllTypingIntervals`) become methods on `GrammyPlatformClient`. The platform client owns the grammy `Bot` instance reference, `ResponseBuffer` map, and `TelegramOutboundState`.

```
packages/relay/src/adapters/telegram/grammy-platform-client.ts
```

`GrammyPlatformClient.postMessage()` wraps the existing `sendAndTrack()` logic: format content via `formatForPlatform(text, 'telegram')`, call `bot.api.sendMessage()`, return the message ID.

`GrammyPlatformClient.stream()` wraps the existing `sendMessageDraft` streaming: iterates the `AsyncIterable<string>`, accumulates text, calls `sendMessageDraft()` at 200ms throttle intervals, then sends the final message via `bot.api.sendMessage()` on completion.

`GrammyPlatformClient.postAction()` wraps the existing inline keyboard rendering for approval cards.

`GrammyPlatformClient.startTyping()` / `stopTyping()` wraps the existing `sendChatAction` + interval refresh logic.

**Refactored TelegramAdapter.deliver():**

After refactoring, `TelegramAdapter.deliver()` becomes simpler: it extracts the chat ID via the `TelegramThreadIdCodec`, checks for echo prevention, and delegates to the platform client. StreamEvent handling for `text_delta`/`done`/`error` is removed from the adapter — the `AdapterStreamManager` handles aggregation and calls `deliverStream()` instead.

**TelegramAdapter.deliverStream():**

```typescript
async deliverStream(
  subject: string,
  threadId: string,
  stream: AsyncIterable<string>,
  _context?: AdapterContext
): Promise<DeliveryResult> {
  if (!this.platformClient) {
    return { success: false, error: 'Adapter not started' };
  }
  const result = await this.platformClient.stream(threadId, stream);
  this.trackOutbound();
  return { success: true, ...result };
}
```

#### Slack

**Extract `SlackPlatformClient`:**

```
packages/relay/src/adapters/slack/slack-platform-client.ts
```

`SlackPlatformClient.postMessage()` wraps `client.chat.postMessage()` with Slack mrkdwn formatting.

`SlackPlatformClient.stream()` wraps the existing native/legacy streaming logic from `stream.ts`: on first chunk, calls `chat.startStream()` or `chat.postMessage()` depending on `nativeStreaming` config; on subsequent chunks, `chat.appendStream()` or `chat.update()`; on completion, `chat.stopStream()` or final `chat.update()`.

`SlackPlatformClient.postAction()` wraps the existing Block Kit approval card rendering from `approval.ts`.

`SlackPlatformClient.startTyping()` / `stopTyping()` wraps the hourglass reaction add/remove logic.

**SlackAdapter.deliverStream():**

```typescript
async deliverStream(
  subject: string,
  threadId: string,
  stream: AsyncIterable<string>,
  _context?: AdapterContext
): Promise<DeliveryResult> {
  if (!this.platformClient) {
    return { success: false, error: 'Adapter not started' };
  }
  const result = await this.platformClient.stream(threadId, stream);
  this.trackOutbound();
  return { success: true, ...result };
}
```

#### Webhook & Claude Code

These adapters do **not** get `PlatformClient` extraction. They have fundamentally different delivery semantics:

- `WebhookAdapter` sends HTTP POST requests with HMAC signing — not a "platform" in the messaging sense.
- `ClaudeCodeAdapter` routes to SDK sessions via a concurrency semaphore and agent queue — it's an agent interface, not a human messaging platform.

Both continue using `deliver()` directly. The `AdapterStreamManager` checks for `deliverStream` before intercepting, so these adapters receive unmodified per-event `deliver()` calls as they do today.

## Implementation Phases

### Phase 1: Foundation (no behavior change)

1. Define `PlatformClient` interface in `packages/relay/src/types.ts`
2. Define `ThreadIdCodec` interface in `packages/relay/src/lib/thread-id.ts`
3. Implement `TelegramThreadIdCodec` and `SlackThreadIdCodec` in `packages/relay/src/lib/thread-id.ts`
4. Implement `AsyncQueue<T>` in `packages/relay/src/lib/async-queue.ts`
5. Add optional `deliverStream()` to `RelayAdapter` interface in `packages/relay/src/types.ts`
6. Bump `RELAY_ADAPTER_API_VERSION` to `'0.2.0'` in `packages/relay/src/version.ts`
7. Export new types from `packages/relay/src/index.ts`
8. Add unit tests for `AsyncQueue` (push/complete/fail/timeout lifecycle)
9. Add unit tests for `ThreadIdCodec` implementations (encode/decode round-trips, edge cases)
10. Add `ThreadIdCodec` and `deliverStream` compliance checks to `packages/relay/src/testing/compliance-suite.ts`

### Phase 2: AdapterStreamManager

1. Implement `AdapterStreamManager` in `packages/relay/src/adapter-stream-manager.ts`
2. Integrate into `AdapterRegistry.deliver()` — intercept StreamEvents, delegate to stream manager when adapter implements `deliverStream()`
3. Add TTL reaping, error handling, concurrent stream support
4. Unit tests for stream lifecycle:
   - Start stream on first text_delta, push subsequent deltas, complete on done
   - Error propagation via queue.fail()
   - TTL reaping of abandoned streams
   - Approval interruption: complete current stream, fall through to deliver()
   - Concurrent streams for different thread IDs
   - Fallback to deliver() for adapters without deliverStream()

### Phase 3: Existing Adapter Refactoring

1. Extract `GrammyPlatformClient` from Telegram adapter
   - Move `sendAndTrack`, approval rendering, typing intervals into platform client
   - `outbound.ts` becomes the platform client implementation
2. Refactor `TelegramAdapter` to own a `GrammyPlatformClient` and implement `deliverStream()`
   - `deliver()` handles non-streaming payloads and approval_required
   - `deliverStream()` delegates to `platformClient.stream()`
3. Refactor `inbound.ts` to use `TelegramThreadIdCodec` internally (preserving exported `buildSubject`/`extractChatId` signatures)
4. Extract `SlackPlatformClient` from Slack adapter
   - Move native/legacy streaming, Block Kit approval, reaction typing into platform client
5. Refactor `SlackAdapter` to own a `SlackPlatformClient` and implement `deliverStream()`
6. Refactor `slack/inbound.ts` to use `SlackThreadIdCodec` internally
7. Verify all existing tests pass with refactored internals
8. Run compliance suite on refactored adapters

### Phase 4: Chat SDK Telegram Adapter

1. Add npm dependencies to `packages/relay/package.json`:
   - `chat` (Chat SDK core)
   - `@chat-adapter/telegram` (Chat SDK Telegram adapter)
   - `@chat-sdk/state-memory` (in-memory state backend)
2. Implement `ChatSdkTelegramAdapter` extending `BaseRelayAdapter` in `packages/relay/src/adapters/telegram-chatsdk/adapter.ts`
3. Implement inbound event forwarding in `packages/relay/src/adapters/telegram-chatsdk/inbound.ts`
4. Implement `deliverStream()` and approval fallback in `packages/relay/src/adapters/telegram-chatsdk/outbound.ts`
5. Implement `ChatSdkTelegramThreadIdCodec` in `packages/relay/src/lib/thread-id.ts`
6. Register `TELEGRAM_CHATSDK_MANIFEST` in the adapter catalog
7. Add `telegram-chatsdk` to `AdapterTypeSchema` in `packages/shared/src/relay-adapter-schemas.ts`
8. Export from `packages/relay/src/index.ts`
9. Run compliance suite on new adapter
10. Add integration tests (inbound message forwarding, outbound streaming, approval handling)
11. Update `contributing/relay-adapters.md` with Chat SDK adapter architecture documentation

## File Changes

### New files

| File                                                                     | Purpose                                                                                                   |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| `packages/relay/src/lib/async-queue.ts`                                  | `AsyncQueue<T>` implementing `AsyncIterable<T>` with push/complete/fail                                   |
| `packages/relay/src/lib/thread-id.ts`                                    | `ThreadIdCodec` interface + `TelegramThreadIdCodec`, `SlackThreadIdCodec`, `ChatSdkTelegramThreadIdCodec` |
| `packages/relay/src/adapter-stream-manager.ts`                           | `AdapterStreamManager` — relay-level stream aggregation                                                   |
| `packages/relay/src/adapters/telegram/grammy-platform-client.ts`         | `GrammyPlatformClient` implementing `PlatformClient` via grammy Bot                                       |
| `packages/relay/src/adapters/slack/slack-platform-client.ts`             | `SlackPlatformClient` implementing `PlatformClient` via Bolt WebClient                                    |
| `packages/relay/src/adapters/telegram-chatsdk/adapter.ts`                | `ChatSdkTelegramAdapter` extending `BaseRelayAdapter`                                                     |
| `packages/relay/src/adapters/telegram-chatsdk/inbound.ts`                | Chat SDK event to `StandardPayload` mapping                                                               |
| `packages/relay/src/adapters/telegram-chatsdk/outbound.ts`               | `deliverStream()` implementation + approval text fallback                                                 |
| `packages/relay/src/adapters/telegram-chatsdk/index.ts`                  | Barrel exports for `ChatSdkTelegramAdapter` and `TELEGRAM_CHATSDK_MANIFEST`                               |
| `packages/relay/src/lib/__tests__/async-queue.test.ts`                   | Unit tests for `AsyncQueue` lifecycle                                                                     |
| `packages/relay/src/lib/__tests__/thread-id.test.ts`                     | Unit tests for `ThreadIdCodec` implementations                                                            |
| `packages/relay/src/__tests__/adapter-stream-manager.test.ts`            | Unit tests for `AdapterStreamManager`                                                                     |
| `packages/relay/src/adapters/telegram-chatsdk/__tests__/adapter.test.ts` | Tests for Chat SDK Telegram adapter                                                                       |

### Modified files

| File                                                       | Changes                                                                                                                                              |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/relay/src/types.ts`                              | Add `PlatformClient` interface, optional `deliverStream()` on `RelayAdapter`                                                                         |
| `packages/relay/src/base-adapter.ts`                       | No structural changes; `deliverStream()` is on the interface, not the base class                                                                     |
| `packages/relay/src/adapter-registry.ts`                   | Integrate `AdapterStreamManager` into `deliver()` — detect StreamEvents, extract thread ID, delegate to stream manager                               |
| `packages/relay/src/adapter-delivery.ts`                   | Pass `AdapterStreamManager` reference through to `AdapterRegistry`                                                                                   |
| `packages/relay/src/version.ts`                            | Bump `RELAY_ADAPTER_API_VERSION` from `'0.1.0'` to `'0.2.0'`                                                                                         |
| `packages/relay/src/adapters/telegram/telegram-adapter.ts` | Own `GrammyPlatformClient`, implement `deliverStream()`, simplify `deliver()`                                                                        |
| `packages/relay/src/adapters/telegram/outbound.ts`         | Extract platform-specific logic to `GrammyPlatformClient`; retain as thin wrapper or remove                                                          |
| `packages/relay/src/adapters/telegram/inbound.ts`          | Delegate `buildSubject`/`extractChatId` to `TelegramThreadIdCodec` internally                                                                        |
| `packages/relay/src/adapters/slack/slack-adapter.ts`       | Own `SlackPlatformClient`, implement `deliverStream()`, simplify `deliver()`                                                                         |
| `packages/relay/src/adapters/slack/outbound.ts`            | Extract platform-specific logic to `SlackPlatformClient`                                                                                             |
| `packages/relay/src/adapters/slack/stream.ts`              | Move streaming logic into `SlackPlatformClient.stream()`                                                                                             |
| `packages/relay/src/adapters/slack/inbound.ts`             | Delegate `buildSubject`/`extractChannelId` to `SlackThreadIdCodec` internally                                                                        |
| `packages/relay/src/testing/compliance-suite.ts`           | Add compliance checks for `deliverStream()` shape (when present), `ThreadIdCodec` round-trip                                                         |
| `packages/relay/src/index.ts`                              | Export `PlatformClient`, `ThreadIdCodec`, `AsyncQueue`, `AdapterStreamManager`, `ChatSdkTelegramAdapter`, `TELEGRAM_CHATSDK_MANIFEST`, codec classes |
| `packages/relay/package.json`                              | Add `chat`, `@chat-adapter/telegram`, `@chat-sdk/state-memory` dependencies                                                                          |
| `packages/shared/src/relay-adapter-schemas.ts`             | Add `'telegram-chatsdk'` to `AdapterTypeSchema` enum                                                                                                 |
| `contributing/relay-adapters.md`                           | Document `PlatformClient` architecture, `AdapterStreamManager` usage, Chat SDK adapter pattern                                                       |

## Acceptance Criteria

1. All existing adapter tests pass without modification (Telegram, Slack, Webhook, Claude Code)
2. `PlatformClient` interface is defined and implemented by Telegram (`GrammyPlatformClient`) and Slack (`SlackPlatformClient`) adapters
3. `AdapterStreamManager` correctly aggregates `text_delta` events into `AsyncIterable<string>` streams
4. `AsyncQueue` handles push/complete/fail/timeout lifecycle correctly, with tests covering all paths
5. `ThreadIdCodec` implementations correctly encode/decode for Telegram, Slack, and Chat SDK Telegram — with round-trip tests
6. Chat SDK Telegram adapter can receive messages from Telegram and forward them to relay subjects as `StandardPayload`
7. Chat SDK Telegram adapter can stream agent responses back to Telegram via `deliverStream()` and Chat SDK's `thread.post(asyncIterable)`
8. Chat SDK Telegram adapter passes the adapter compliance suite (`runAdapterComplianceSuite`)
9. `approval_required` events correctly interrupt active streams (complete the queue, flush buffered text) and fall through to `adapter.deliver()` for platform-specific rendering
10. `RELAY_ADAPTER_API_VERSION` bumped to `'0.2.0'`
11. Adapters that don't implement `deliverStream()` (Webhook, Claude Code) continue to work via `deliver()` fallback — no changes to their behavior or tests
12. `telegram-chatsdk` is added to `AdapterTypeSchema` and has a registered manifest in the adapter catalog

## Non-Regression Requirements

- Existing Telegram adapter (grammy-based) must work identically after refactoring — same `sendMessageDraft` streaming at 200ms intervals, same inline keyboard approval cards, same typing indicator refresh
- Existing Slack adapter must work identically after refactoring — same native/legacy streaming, same Block Kit approval cards, same hourglass reaction typing
- Webhook and Claude Code adapters must work without any changes to their source files
- Hot-reload (adapter replacement via `AdapterRegistry.register()`) must continue to work for all adapter types
- Adapter compliance suite must pass for all adapters (existing and new)
- No breaking changes to `RelayAdapter` interface — `deliverStream()` is optional/additive
- No changes to the relay subject hierarchy — existing subjects continue to work
- No changes to `StandardPayload`, `RelayEnvelope`, or `Signal` schemas

## Open Questions

1. ~~**Chat SDK package naming**~~ (RESOLVED)
   **Answer:** Package names confirmed as `chat`, `@chat-adapter/telegram`, `@chat-sdk/state-memory`. Pin exact versions at install time.
   **Rationale:** Verified via npm registry and Chat SDK documentation during research phase.

2. ~~**Chat SDK `thread.post(asyncIterable)` API shape**~~ (RESOLVED)
   **Answer:** `thread.post()` accepts `AsyncIterable<string>` directly via `Symbol.asyncIterator` detection. No adapter shim needed.
   **Rationale:** Confirmed in Chat SDK source code and documentation. For Telegram (no native `stream()` method), it falls back to post+edit at 500ms intervals.

3. ~~**Concurrent stream limits**~~ (RESOLVED)
   **Answer:** TTL reaping only (5 min). No explicit concurrent stream limit for initial implementation.
   **Rationale:** Matches existing adapter behavior (no limits today). TTL reaper prevents unbounded growth. Simpler implementation. Can add configurable limits later if needed.
