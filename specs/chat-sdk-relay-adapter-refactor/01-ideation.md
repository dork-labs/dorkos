---
slug: chat-sdk-relay-adapter-refactor
number: 161
created: 2026-03-22
status: ideation
---

# Chat SDK Relay Adapter Refactor

**Slug:** chat-sdk-relay-adapter-refactor
**Author:** Claude Code
**Date:** 2026-03-22
**Branch:** preflight/chat-sdk-relay-adapter-refactor

---

## 1) Intent & Assumptions

- **Task brief:** Refactor the DorkOS relay adapter system to introduce three architectural improvements — a `PlatformClient` interface, an `AdapterStreamManager` for AsyncIterable-based streaming, and standardized thread ID encoding — then validate the new architecture by building a Chat SDK-backed Telegram adapter alongside the existing one. Existing adapters are also refactored to use the new abstractions.
- **Assumptions:**
  - Existing adapters (Telegram, Slack, Webhook, Claude Code) continue to work throughout the refactor — no functionality regression
  - The Chat SDK Telegram adapter is a new adapter type (e.g., `telegram-chatsdk`) registered alongside the existing `telegram` type
  - The relay adapter API version will bump to `0.2.0` (minor, additive changes to the interface)
  - Chat SDK is in public beta but stable enough for a proof-of-concept adapter
  - The `PlatformClient` refactor of existing adapters is an internal restructure — no external API changes
- **Out of scope:**
  - Adding new platforms beyond Telegram (Discord, Teams, etc.) — future work enabled by this refactor
  - Replacing the existing Telegram adapter with the Chat SDK version
  - Changes to the binding subsystem or session strategies
  - Contributing `sendMessageDraft` support upstream to Chat SDK
  - Changes to the client UI or adapter management APIs

## 2) Pre-reading Log

- `packages/relay/src/types.ts`: Core interfaces — `RelayAdapter`, `RelayPublisher`, `DeliveryResult`, `AdapterContext`, `AdapterStatus`. The `deliver()` contract is the central integration point. Payload is untyped (`z.unknown()`), adapters must detect StreamEvents via duck typing.
- `packages/relay/src/base-adapter.ts`: Optional base class with status state machine, idempotency guards, error tracking, message counters, callback builders. 267 lines. Subclasses implement `_start()`, `_stop()`, `deliver()`.
- `packages/relay/src/adapter-registry.ts`: Lifecycle management and subject-prefix routing. Hot-reload swaps new adapter in before stopping old. 30s start timeout.
- `packages/relay/src/adapter-delivery.ts`: 120s timeout wrapper around `adapterRegistry.deliver()`. Indexes successful deliveries in SQLite.
- `packages/relay/src/relay-publish.ts`: Full publish pipeline — adapter delivery happens at step 6 (after Maildir, before subscriptions). Calls `adapterDelivery.deliver(subject, envelope, contextBuilder)`.
- `packages/relay/src/lib/payload-utils.ts`: StreamEvent detection, text extraction, platform formatting (slack/telegram/plain), approval data parsing, agent/session ID extraction from envelopes. ~300 lines of shared utilities.
- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: Facade class extending `BaseRelayAdapter`. Creates grammy `Bot`, registers handlers, manages polling/webhook lifecycle. Subscribes to typing signals. ~400 lines.
- `packages/relay/src/adapters/telegram/inbound.ts`: Builds `StandardPayload` from Telegram messages. Subject encoding: `relay.human.telegram.{chatId}` (DM) / `relay.human.telegram.group.{chatId}` (group). `extractChatId()` and `buildSubject()` handle encoding/decoding.
- `packages/relay/src/adapters/telegram/outbound.ts`: StreamEvent-aware delivery with per-chat `ResponseBuffer`. Handles text_delta buffering, sendMessageDraft streaming (200ms throttle), done/error flushing, approval_required with inline keyboards. Instance-scoped `TelegramOutboundState`. ~480 lines.
- `packages/relay/src/adapters/telegram/stream-api.ts`: Typed wrapper around unofficial `sendMessageDraft` API.
- `packages/relay/src/adapters/telegram/webhook.ts`: HTTP server for grammy webhookCallback. Auto-generates secret, hardened timeouts.
- `packages/relay/src/adapters/slack/slack-adapter.ts`: Facade using `@slack/bolt` Socket Mode. Caches bot user ID via `auth.test()`. Registers message, app_mention, and action handlers.
- `packages/relay/src/adapters/slack/inbound.ts`: Similar to Telegram — builds `StandardPayload`, subject encoding with `relay.human.slack.{channelId}` / `relay.human.slack.group.{channelId}`. User/channel name caching (1h TTL, 500-entry bounded cache).
- `packages/relay/src/adapters/slack/outbound.ts`: Routes StreamEvents to stream.ts handlers. Resolves thread context from `platformData.threadTs`.
- `packages/relay/src/adapters/slack/stream.ts`: 500 lines. Native streaming (`chat.startStream/appendStream/stopStream`), legacy streaming (`chat.update` with 1s throttle), buffered mode. Typing indicators via hourglass reaction. `ActiveStream` state per channel+thread.
- `packages/relay/src/adapters/slack/approval.ts`: Block Kit approval cards with Approve/Deny buttons. `SlackOutboundState` for pending timeouts.
- `packages/relay/src/adapters/webhook/webhook-adapter.ts`: HMAC-SHA256 signing, timestamp window, nonce replay protection, dual-secret rotation.
- `packages/relay/src/adapters/claude-code/claude-code-adapter.ts`: Routes to SDK sessions. Subject prefixes `relay.agent.` and `relay.system.pulse.`. Concurrency semaphore. Agent queue for FIFO serialization.
- `packages/relay/src/version.ts`: `RELAY_ADAPTER_API_VERSION = '0.1.0'`. Pre-1.0, no stability guarantees.
- `packages/relay/src/testing/`: Compliance suite (`runAdapterComplianceSuite`), mock publisher, mock envelope.
- `packages/relay/package.json`: Dependencies — grammy ^1.40.0, @slack/bolt ^4.6.0, @slack/web-api ^7.15.0, slackify-markdown ^5.0.0.
- `contributing/relay-adapters.md`: 1579-line comprehensive adapter authoring guide.
- `contributing/adapter-catalog.md`: 441-line manifest/catalog reference.

## 3) Codebase Map

**Primary Components/Modules:**

- `packages/relay/src/types.ts` — Core interfaces (RelayAdapter, RelayPublisher, DeliveryResult)
- `packages/relay/src/base-adapter.ts` — Optional base class with status machine
- `packages/relay/src/adapter-registry.ts` — Adapter lifecycle and subject-prefix routing
- `packages/relay/src/adapter-delivery.ts` — Timeout-protected delivery pipeline
- `packages/relay/src/relay-publish.ts` — Full publish pipeline (where adapter delivery is called)
- `packages/relay/src/lib/payload-utils.ts` — StreamEvent detection, text extraction, formatting
- `packages/relay/src/adapters/telegram/` — 6 files: adapter, inbound, outbound, stream-api, webhook, index
- `packages/relay/src/adapters/slack/` — 7 files: adapter, inbound, outbound, stream, stream-api, approval, index
- `packages/relay/src/adapters/webhook/` — 1 file: webhook-adapter.ts
- `packages/relay/src/adapters/claude-code/` — 1 file: claude-code-adapter.ts
- `packages/relay/src/testing/` — Compliance suite, mock publisher, mock envelope
- `packages/relay/src/version.ts` — API version constant

**Shared Dependencies:**

- `packages/shared/src/relay-schemas.ts` — AdapterManifest, ConfigField, RelayEnvelope schemas
- `packages/shared/src/relay-envelope-schemas.ts` — StandardPayload, Signal schemas
- `packages/relay/src/lib/payload-utils.ts` — Used by all adapters for StreamEvent handling
- `packages/relay/src/base-adapter.ts` — Extended by Telegram, Slack, Webhook, Claude Code

**Data Flow:**

```
Inbound: Platform message → Adapter inbound handler → StandardPayload → relay.publish(subject, payload)
         → BindingRouter → relay.agent.{sessionId} → ClaudeCodeAdapter → Agent SDK

Outbound: Agent StreamEvent → relay.publish(relay.human.{platform}.{id}, { type, data })
          → AdapterDelivery → AdapterRegistry.getBySubject() → adapter.deliver(subject, envelope)
          → Adapter outbound handler → Platform API (sendMessage, chat.update, sendMessageDraft)
```

**Feature Flags/Config:**

- Adapter configs stored in `~/.dork/relay/adapters.json` (hot-reload via chokidar)
- `streaming` boolean per adapter (default: true for Telegram/Slack)
- `nativeStreaming` boolean for Slack (default: true)
- `typingIndicator` for Slack ('none' | 'reaction')

**Potential Blast Radius:**

- Direct: `packages/relay/src/types.ts` (new interface), `base-adapter.ts` (new optional method), `adapter-delivery.ts` (stream manager integration), all 4 adapter directories (PlatformClient extraction + stream refactor)
- Indirect: `adapter-registry.ts` (may need to support `deliverStream`), `relay-publish.ts` (stream manager hook point), `testing/` (new compliance checks)
- Tests: All adapter test files, compliance suite, new tests for PlatformClient implementations and AdapterStreamManager
- Config: New adapter type `telegram-chatsdk` in manifest system, new npm dependencies (`chat`, `@chat-adapter/telegram`, `@chat-sdk/state-memory`)

## 4) Root Cause Analysis

_Not applicable — this is a feature/refactor, not a bug fix._

## 5) Research

### Potential Solutions

**1. Extract PlatformClient, Refactor All Adapters**

- Description: Define a `PlatformClient` interface for platform communication (postMessage, editMessage, stream, handleWebhook). Refactor existing Telegram and Slack adapters to delegate to a `PlatformClient`. New Chat SDK adapter implements the same interface using `@chat-adapter/telegram`.
- Pros:
  - Proves the abstraction works for both hand-rolled and SDK-based implementations
  - Centralizes platform-specific concerns below a clean interface
  - Makes existing adapters more testable (mock the PlatformClient)
  - Enables future platform swaps without touching relay logic
- Cons:
  - Higher risk — touching working Telegram and Slack adapter internals
  - More work upfront
  - Existing adapters have battle-tested code; refactoring may introduce regressions
- Complexity: High
- Maintenance: Lower long-term (unified abstraction)

**2. Shared AdapterStreamManager (Relay-Level)**

- Description: A new module in `packages/relay/` that intercepts StreamEvents before they reach adapters. Maintains per-conversation `AsyncQueue` instances. Adapters that opt in implement `deliverStream(threadId, asyncIterable)` instead of handling individual text_delta events. Falls back to `deliver()` for adapters that don't implement it.
- Pros:
  - Eliminates duplicated buffering/throttle/flush logic across adapters
  - Maps directly to Chat SDK's `thread.post(asyncIterable)` model
  - Centralizes stream lifecycle management (TTL reaping, error handling)
  - Opt-in design preserves backward compatibility
- Cons:
  - Adds a new layer between publish pipeline and adapters
  - StreamEvents that aren't text_delta/done/error (like approval_required) need special routing
  - Must handle edge cases: concurrent streams per chat, stream abandonment, adapter restarts mid-stream
- Complexity: Medium
- Maintenance: Lower (centralized vs per-adapter)

**3. AsyncQueue Bridge Pattern**

- Description: A zero-dependency `AsyncQueue<T>` class that implements `AsyncIterable<T>` with push/complete/fail methods. Each active stream gets its own queue. The AdapterStreamManager maps conversation IDs to queues and pushes text_delta chunks in, completing on done or failing on error.
- Pros:
  - Under 50 lines, zero dependencies
  - Maps perfectly to DorkOS's per-event delivery model
  - Well-understood pattern (push-pull async iterable)
- Cons:
  - Need to handle backpressure if consumer is slow
  - Queue must be garbage-collected when streams complete or timeout
- Complexity: Low
- Maintenance: Minimal

**4. Chat SDK Full Bidirectional Integration**

- Description: Use `new Chat({ adapters: { telegram: createTelegramAdapter() }, state: createMemoryState() })` for complete inbound + outbound handling. Chat SDK handles webhook/polling, event routing, thread subscriptions, and state management. Our `RelayAdapter` wraps the `Chat` instance.
- Pros:
  - Most complete test of Chat SDK's architecture
  - Gets thread subscriptions and distributed locking for free
  - Validates whether Chat SDK can be a full platform abstraction layer
- Cons:
  - Chat SDK Telegram adapter does NOT implement `sendMessageDraft` — streaming falls back to post+edit (500ms intervals), inferior to existing adapter
  - Requires `@chat-sdk/state-memory` dependency
  - Chat class wants to be the orchestrator — may fight with relay's own routing
  - Inbound events need to be forwarded from Chat SDK handlers to relay subjects
- Complexity: Medium-High
- Maintenance: Depends on Chat SDK stability (public beta)

### Security Considerations

- Chat SDK handles webhook signature verification internally — need to verify it meets DorkOS security standards
- Bot tokens will be stored in the same `adapters.json` config (existing password masking applies)
- No new attack surface beyond what existing Telegram adapter already exposes

### Performance Considerations

- Chat SDK's post+edit streaming (500ms intervals) is slower than `sendMessageDraft` (200ms intervals)
- AsyncQueue adds minimal overhead (one promise resolution per chunk)
- AdapterStreamManager adds one Map lookup per deliver() call to check for active streams
- Memory: AsyncQueue buffers are bounded by stream TTL (5 minutes, matching existing behavior)

### Recommendation

**Recommended Approach:** All four solutions combined — they're complementary, not alternatives.

**Rationale:**
The PlatformClient interface (#1) creates the architectural seam. The AdapterStreamManager (#2) with AsyncQueue (#3) eliminates the per-adapter streaming complexity. The Chat SDK integration (#4) validates the whole architecture end-to-end. Each builds on the previous.

**Caveats:**

- The Chat SDK Telegram adapter's streaming is measurably inferior to the existing adapter. This is accepted as a known trade-off for the proof-of-concept.
- Chat SDK is in public beta — API surface may change. Pin versions carefully.
- The refactor of existing adapters carries regression risk. Comprehensive test coverage before and after is critical.

## 6) Decisions

| #   | Decision                                | Choice                         | Rationale                                                                                                                                                                                            |
| --- | --------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Chat SDK streaming inferior to existing | Proceed anyway                 | This is a proof-of-concept to validate PlatformClient architecture and multi-platform portability. Streaming quality is secondary. Can contribute sendMessageDraft support to Chat SDK later.        |
| 2   | PlatformClient refactor scope           | Refactor existing adapters too | Proves the abstraction works for both hand-rolled and Chat SDK implementations. Higher risk but validates the interface comprehensively.                                                             |
| 3   | AdapterStreamManager placement          | Shared relay-level component   | Lives in packages/relay as a new module. Intercepts StreamEvents before adapters. Adapters opt in via deliverStream(). Falls back to deliver() for adapters that don't. Centralizes buffering logic. |
| 4   | Chat SDK integration mode               | Full Chat class, bidirectional | Use `new Chat()` with adapters and state. More complete test of Chat SDK's value — gets thread subscriptions, state management, and validates the full platform abstraction.                         |
