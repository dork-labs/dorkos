# Chat SDK Relay Adapter Refactor — Task Breakdown

Generated: 2026-03-22

Spec: `specs/chat-sdk-relay-adapter-refactor/02-specification.md`

## Overview

This task breakdown covers four phases:

1. **Foundation** — Define interfaces, implement codecs, AsyncQueue, bump API version, extend compliance suite
2. **AdapterStreamManager** — Implement stream aggregation manager and integrate into delivery pipeline
3. **Existing Adapter Refactoring** — Extract PlatformClients, add deliverStream() to Telegram and Slack
4. **Chat SDK Telegram Adapter** — Build the new adapter, tests, and documentation

**Total tasks: 15** (4 small, 6 medium, 5 large)

---

## Phase 1: Foundation

> No behavior changes. Lay the type-level and utility groundwork.

### 1.1 Define PlatformClient interface and add optional deliverStream to RelayAdapter

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.2, 1.3, 1.4
- Add `PlatformClient` interface to `packages/relay/src/types.ts`
- Add optional `deliverStream()` to `RelayAdapter` interface
- Add `StreamableAdapter` type guard interface
- Export new types from `packages/relay/src/index.ts`
- Existing adapters compile unchanged (new method is optional)

### 1.2 Implement ThreadIdCodec interface and platform codecs

- **Size:** Medium | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.1, 1.3, 1.4
- Create `packages/relay/src/lib/thread-id.ts` with `ThreadIdCodec` interface
- Implement `TelegramThreadIdCodec`, `SlackThreadIdCodec`, `ChatSdkTelegramThreadIdCodec`
- Write comprehensive round-trip unit tests in `packages/relay/src/lib/__tests__/thread-id.test.ts`
- Export all from `packages/relay/src/index.ts`

### 1.3 Implement AsyncQueue with push/complete/fail lifecycle

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 1.1, 1.2, 1.4
- Create `packages/relay/src/lib/async-queue.ts`
- Push-pull `AsyncIterable<T>` queue with `push()`, `complete()`, `fail()`
- Write unit tests covering ordering, completion, error propagation, interleaved push/consume
- Export from `packages/relay/src/index.ts`

### 1.4 Bump RELAY_ADAPTER_API_VERSION to 0.2.0

- **Size:** Small | **Priority:** Medium
- **Dependencies:** None | **Parallel with:** 1.1, 1.2, 1.3
- Update `packages/relay/src/version.ts` from `'0.1.0'` to `'0.2.0'`
- Update version test

### 1.5 Add ThreadIdCodec and deliverStream compliance checks to compliance suite

- **Size:** Small | **Priority:** Medium
- **Dependencies:** 1.1, 1.2
- Extend `ComplianceSuiteOptions` with optional `codec` and `samplePlatformId`
- Add `deliverStream()` shape check (when present)
- Add `ThreadIdCodec` round-trip tests (when codec provided)

---

## Phase 2: AdapterStreamManager

> Centralize streaming lifecycle management.

### 2.1 Implement AdapterStreamManager with stream lifecycle management

- **Size:** Large | **Priority:** High
- **Dependencies:** 1.1, 1.3
- Create `packages/relay/src/adapter-stream-manager.ts`
- Handle `text_delta` (create/push), `done` (complete), `error` (fail), `approval_required` (complete + fall through)
- TTL reaping of abandoned streams (5 min)
- Keyed by `{adapterId}:{threadId}` for concurrent stream support
- Export from `packages/relay/src/index.ts`

### 2.2 Write unit tests for AdapterStreamManager

- **Size:** Medium | **Priority:** High
- **Dependencies:** 2.1
- Test stream creation on first text_delta
- Test done/error lifecycle
- Test approval interruption (returns null for fall-through)
- Test concurrent streams for different thread IDs
- Test fallback for non-streaming adapters
- Test done/error without prior text_delta

### 2.3 Integrate AdapterStreamManager into AdapterRegistry.deliver()

- **Size:** Medium | **Priority:** High
- **Dependencies:** 2.1 | **Parallel with:** 2.2
- Add `setStreamManager()` to `AdapterRegistry`
- In `deliver()`, detect StreamEvents and route through stream manager
- Return stream manager result if handled; fall through to `adapter.deliver()` if null
- Update `shutdown()` to stop the stream manager

---

## Phase 3: Existing Adapter Refactoring

> Extract PlatformClients and add deliverStream() to existing adapters.

### 3.1 Extract GrammyPlatformClient from Telegram adapter

- **Size:** Large | **Priority:** High
- **Dependencies:** 1.1 | **Parallel with:** 3.3
- Create `packages/relay/src/adapters/telegram/grammy-platform-client.ts`
- Move `sendAndTrack`, `sendMessageDraft` streaming, typing intervals into platform client
- Implement `PlatformClient` interface methods: `postMessage`, `editMessage`, `deleteMessage`, `stream`, `startTyping`, `stopTyping`, `destroy`

### 3.2 Refactor TelegramAdapter to use GrammyPlatformClient and implement deliverStream

- **Size:** Large | **Priority:** High
- **Dependencies:** 2.3, 3.1 | **Parallel with:** 3.4
- `TelegramAdapter` owns a `GrammyPlatformClient` instance
- Add `deliverStream()` method delegating to `platformClient.stream()`
- Refactor `inbound.ts` to delegate to `TelegramThreadIdCodec` (preserve exported signatures)
- All existing tests must pass without modification

### 3.3 Extract SlackPlatformClient from Slack adapter

- **Size:** Large | **Priority:** High
- **Dependencies:** 1.1 | **Parallel with:** 3.1
- Create `packages/relay/src/adapters/slack/slack-platform-client.ts`
- Move streaming (native/legacy), Block Kit approval, hourglass reaction into platform client
- Implement `PlatformClient` interface methods

### 3.4 Refactor SlackAdapter to use SlackPlatformClient and implement deliverStream

- **Size:** Large | **Priority:** High
- **Dependencies:** 2.3, 3.3 | **Parallel with:** 3.2
- `SlackAdapter` owns a `SlackPlatformClient` instance
- Add `deliverStream()` method delegating to `platformClient.stream()`
- Refactor `inbound.ts` to delegate to `SlackThreadIdCodec`
- All existing tests must pass without modification

### 3.5 Run compliance suite on refactored adapters and verify non-regression

- **Size:** Medium | **Priority:** High
- **Dependencies:** 3.2, 3.4, 1.5
- Run compliance suite on refactored Telegram and Slack adapters
- Verify Webhook and Claude Code adapters pass with NO source changes
- Run full relay test suite
- Run `pnpm typecheck` across monorepo

---

## Phase 4: Chat SDK Telegram Adapter

> Build the new adapter as proof-of-concept for the architecture.

### 4.1 Add Chat SDK npm dependencies to relay package

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 4.2
- Add `chat`, `@chat-adapter/telegram`, `@chat-sdk/state-memory` to `packages/relay/package.json`
- Run `pnpm install`

### 4.2 Add telegram-chatsdk to AdapterTypeSchema and register manifest

- **Size:** Small | **Priority:** High
- **Dependencies:** None | **Parallel with:** 4.1
- Add `'telegram-chatsdk'` to `AdapterTypeSchema` enum in `packages/shared/src/relay-adapter-schemas.ts`
- Define `TELEGRAM_CHATSDK_MANIFEST` following `AdapterManifest` interface

### 4.3 Implement ChatSdkTelegramAdapter with inbound, outbound, and deliverStream

- **Size:** Large | **Priority:** High
- **Dependencies:** 4.1, 4.2, 1.2, 1.1
- Create adapter file structure under `packages/relay/src/adapters/telegram-chatsdk/`
- `ChatSdkTelegramAdapter` extends `BaseRelayAdapter`
- Inbound: forward Chat SDK events to relay subjects via `ChatSdkTelegramThreadIdCodec`
- Outbound: `deliver()` for standard payloads and approvals, `deliverStream()` via `thread.post(stream)`
- Export from `packages/relay/src/index.ts`

### 4.4 Write tests for ChatSdkTelegramAdapter and run compliance suite

- **Size:** Medium | **Priority:** High
- **Dependencies:** 4.3, 1.5
- Mock Chat SDK modules (no real network calls)
- Test start/stop, echo prevention, standard delivery, approval rendering, deliverStream
- Run compliance suite with `ChatSdkTelegramThreadIdCodec`
- Verify `deliverStream()` shape in compliance suite

### 4.5 Update relay-adapters.md with PlatformClient architecture and Chat SDK adapter pattern

- **Size:** Medium | **Priority:** Medium
- **Dependencies:** 4.3, 2.1, 1.2 | **Parallel with:** 4.4
- Document PlatformClient architecture and relationship to RelayAdapter
- Document AdapterStreamManager pipeline
- Document ThreadIdCodec convention
- Document Chat SDK adapter pattern

---

## Dependency Graph

```
Phase 1 (parallel):
  1.1 ──┐
  1.2 ──┤── 1.5
  1.3 ──┤
  1.4   │

Phase 2:
  1.1 + 1.3 → 2.1 → 2.2
                  └→ 2.3

Phase 3:
  1.1 → 3.1 ──┐
  1.1 → 3.3 ──┤
  2.3 + 3.1 → 3.2 ──┐
  2.3 + 3.3 → 3.4 ──┤── 3.5
  1.5 ───────────────┘

Phase 4:
  4.1 ──┐
  4.2 ──┤── 4.3 → 4.4
  1.1 ──┤       └→ 4.5
  1.2 ──┘
```
