---
slug: relay-adapter-event-whitelist
number: 147
created: 2026-03-17
status: ideation
---

# Relay Adapter Event Whitelist Overhaul

**Slug:** relay-adapter-event-whitelist
**Author:** Claude Code
**Date:** 2026-03-17
**Branch:** preflight/relay-adapter-event-whitelist

---

## 1) Intent & Assumptions

- **Task brief:** Fix relay adapters (Slack, Telegram) that leak raw JSON to users when unrecognized SDK event types arrive. Flip from blacklist (`SILENT_EVENT_TYPES`) to whitelist approach where adapters only forward events they explicitly handle. Additionally, upgrade both adapters to use native streaming APIs (Slack `chat.startStream`/`appendStream`/`stopStream`, Telegram `sendMessageDraft`) and fix the Telegram buffer memory leak.
- **Assumptions:**
  - Both adapters share event detection via `payload-utils.ts` (`detectStreamEventType`)
  - The whitelist fix is independent of and should ship before the streaming API upgrades
  - Slack's native streaming API requires streaming to happen in threads
  - Telegram's `sendMessageDraft` only works in DMs, not groups
  - Streaming upgrades should be optional (config flag, on by default)
  - `@slack/bolt` v4 supports the streaming API; grammY supports `sendMessageDraft` via Bot API 9.5
- **Out of scope:**
  - Webhook adapter changes
  - New adapter types
  - Relay core architecture changes
  - Inbound message handling changes

## 2) Pre-reading Log

- `packages/relay/src/lib/payload-utils.ts`: Contains `SILENT_EVENT_TYPES` (11 entries), `detectStreamEventType()`, `extractPayloadContent()` (JSON.stringify fallback is the root cause), `extractTextDelta()`, `extractErrorMessage()`, `formatForPlatform()`
- `packages/relay/src/adapters/slack/outbound.ts`: Slack delivery — handles text_delta/error/done explicitly, checks SILENT_EVENT_TYPES, falls through to `extractPayloadContent()` for unknown types. Uses `chat.update` for streaming with 1s throttle (`STREAM_UPDATE_INTERVAL_MS`). Has orphan stream reaping (`STREAM_TTL_MS = 5 min`)
- `packages/relay/src/adapters/telegram/outbound.ts`: Telegram delivery — same dispatch pattern as Slack. Uses buffer-and-flush (accumulates text_delta in `responseBuffers` Map, flushes on done). No TTL cleanup on buffers (memory leak)
- `packages/relay/src/adapters/slack/slack-adapter.ts`: Extends BaseRelayAdapter, manages Socket Mode via @slack/bolt, maintains `streamState` Map
- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: Extends BaseRelayAdapter, supports polling and webhook modes, maintains `responseBuffers` Map, has exponential backoff reconnection
- `packages/relay/src/adapter-delivery.ts`: Delivery orchestration with 120s timeout (documentation says 30s — discrepancy)
- `packages/shared/src/schemas.ts`: `StreamEventTypeSchema` defines 29 event types as a Zod enum
- `contributing/relay-adapters.md`: Adapter development guide with architecture docs
- `contributing/adapter-catalog.md`: Adapter manifest and catalog system
- `decisions/0109-optional-base-relay-adapter-class.md`: BaseRelayAdapter pattern ADR
- `research/20260317_relay_adapter_event_whitelist.md`: Fresh research on whitelist patterns, Slack streaming API, Telegram sendMessageDraft
- `research/20260314_relay_adapter_streaming_fixes.md`: Prior research on streaming bugs (mrkdwn paragraphs, stream key collisions, typing indicators)
- `research/20260313_slack_bot_adapter_best_practices.md`: Socket Mode, @slack/bolt, slackify-markdown best practices
- `research/20260314_slack_bolt_socket_mode_best_practices.md`: Bolt lifecycle, reconnection patterns

## 3) Codebase Map

**Primary components/modules:**
- `packages/relay/src/lib/payload-utils.ts` — Shared event detection and payload extraction utilities
- `packages/relay/src/adapters/slack/outbound.ts` — Slack message delivery (streaming via `chat.update`, throttled)
- `packages/relay/src/adapters/telegram/outbound.ts` — Telegram message delivery (buffer-and-flush)
- `packages/relay/src/adapters/slack/slack-adapter.ts` — Slack adapter lifecycle (Socket Mode, @slack/bolt)
- `packages/relay/src/adapters/telegram/telegram-adapter.ts` — Telegram adapter lifecycle (polling/webhook, grammY)
- `packages/shared/src/schemas.ts` — StreamEventType union (29 types)

**Shared dependencies:**
- `packages/relay/src/types.ts` — `AdapterOutboundCallbacks`, `DeliveryResult`, `RelayEnvelope` interfaces
- `packages/relay/src/adapter-delivery.ts` — Delivery orchestration with timeout wrapping
- `@slack/bolt` — Slack SDK (Socket Mode + Web API)
- `grammy` — Telegram Bot SDK

**Data flow:**
```
Claude Agent SDK → sdk-event-mapper.ts → SSE StreamEvents
  → relay publish → adapter-delivery.ts → adapter.deliver()
    → detectStreamEventType(payload)
      → text_delta: accumulate/stream
      → error: flush + error text
      → done: flush final message
      → SILENT_EVENT_TYPES: skip      ← BLACKLIST (broken for new types)
      → fallthrough: JSON.stringify   ← ROOT CAUSE of JSON leak
```

**Feature flags/config:**
- Slack adapter: `streaming: boolean` config field (existing)
- Telegram adapter: no streaming config (will need one for sendMessageDraft)

**Potential blast radius:**
- Direct: `payload-utils.ts`, `slack/outbound.ts`, `telegram/outbound.ts`, `telegram-adapter.ts` (buffer cleanup)
- Indirect: `slack/slack-adapter.ts` (if streaming API changes thread model), `adapter-delivery.ts` (timeout discrepancy)
- Tests: `payload-utils.test.ts`, `slack/outbound.test.ts`, `telegram/outbound.test.ts`
- Config: Adapter config schemas for streaming flags

## 4) Root Cause Analysis

- **Repro steps:**
  1. Send a message to an agent via Slack/Telegram relay binding
  2. Agent uses extended thinking → SDK emits `thinking_delta` events
  3. SDK emits `system_status` for hooks, `tool_progress` for tool execution
  4. These arrive at the adapter's `deliverMessage()` function

- **Observed vs Expected:**
  - **Observed:** Raw JSON like `{"type":"thinking_delta","data":{"text":" wants"}}` posted as Slack messages — one per streaming token
  - **Expected:** These events should be silently dropped (they carry no user-visible content for relay platforms)

- **Evidence:** User-reported Slack conversation showing dozens of raw JSON messages interleaved with actual response text

- **Root-cause hypotheses:**
  1. **`SILENT_EVENT_TYPES` blacklist is incomplete** — 14 of 29 event types are not in the set, causing fallthrough to `extractPayloadContent()` which `JSON.stringify`s the payload (confidence: **certain**)
  2. The SDK added new event types without updating the relay adapter (confidence: **certain** — this is the proximate cause)

- **Decision:** The blacklist pattern itself is architecturally broken for open event systems. Fix by flipping to whitelist: adapters only act on events they explicitly handle, silently dropping everything else.

## 5) Research

- **Prior research:** `20260314_relay_adapter_streaming_fixes.md`, `20260313_slack_bot_adapter_best_practices.md`, `20260314_slack_bolt_socket_mode_best_practices.md`
- **New research:** `20260317_relay_adapter_event_whitelist.md`

### Potential solutions:

**1. Delete SILENT_EVENT_TYPES, silent drop in fallthrough**
- Description: Remove the SILENT_EVENT_TYPES set. After handling text_delta/error/done, return `{ success: true }` for all other event types.
- Pros: Minimal change (2 lines per adapter + delete export), forward-compatible, no maintenance burden
- Cons: Less self-documenting (whitelist is implicit in the handler chain)
- Complexity: Low
- Maintenance: None

**2. Replace with HANDLED_STREAM_EVENT_TYPES allowlist**
- Description: Rename to an explicit allowlist containing only `text_delta`, `done`, `error`. Check `!HANDLED.has(type)` to drop.
- Pros: Self-documenting, explicit about what's forwarded
- Cons: Still requires maintenance when adding new forwardable events (though this is rare)
- Complexity: Low
- Maintenance: Low

**3. Slack native streaming API (chat.startStream/appendStream/stopStream)**
- Description: Replace `chat.update` edit-in-place with native streaming. Released Oct 2025.
- Pros: Better rate limits (chat.update limited to ~50 edits/min), smoother UX (append-only vs full-replace), purpose-built for AI streaming
- Cons: Requires streaming in threads (not top-level channel messages), may need additional OAuth scope verification, newer API (less battle-tested)
- Complexity: Medium
- Maintenance: Low

**4. Telegram sendMessageDraft (Bot API 9.5)**
- Description: Use `sendMessageDraft` for DM streaming instead of buffer-and-flush. Available to all bots since March 1, 2026.
- Pros: Native ChatGPT-style streaming UX in DMs, real-time response visibility
- Cons: Only works in DMs (groups still need buffer-and-flush), needs throttling (4-5 calls/sec), grammY support needs verification
- Complexity: Medium
- Maintenance: Low

**5. Telegram buffer TTL reaping**
- Description: Add TTL cleanup to `responseBuffers` Map, matching Slack's orphan stream reaping pattern.
- Pros: Prevents unbounded memory growth from dead chats, follows established pattern
- Cons: None significant
- Complexity: Low
- Maintenance: None

### Recommendation:

All five. The whitelist fix (solution 1) is the critical bug fix that should be implemented first. Solutions 3-4 (native streaming APIs) are quality upgrades that should be configurable (on by default). Solution 5 (buffer cleanup) is a small defensive fix. Solution 2 is not needed if solution 1 is implemented — the implicit whitelist in the handler chain is sufficient.

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | How to handle unknown/future event types | Silent drop — delete SILENT_EVENT_TYPES, return success for all unrecognized types | Forward-compatible, fail-closed. No maintenance when SDK adds new events. |
| 2 | Scope of streaming upgrades | Full overhaul — event filtering + Slack streaming API + Telegram sendMessageDraft | Both platform APIs are now stable. Streaming is optional (on by default). Note: Slack streaming API requires threads. |
| 3 | Telegram buffer memory leak | Add TTL reaping matching Slack's pattern | Small change, prevents unbounded memory growth. Already proven in Slack adapter. |
