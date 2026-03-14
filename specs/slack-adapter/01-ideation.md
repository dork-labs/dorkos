---
slug: slack-adapter
number: 127
created: 2026-03-13
status: ideation
---

# Slack Adapter for Relay

**Slug:** slack-adapter
**Author:** Claude Code
**Date:** 2026-03-13
**Branch:** preflight/slack-adapter

---

## 1) Intent & Assumptions

- **Task brief:** Add a Slack adapter to the Relay system supporting group channels and DMs. Improve the overall adapter system as needed to make the Slack adapter excellent.
- **Assumptions:**
  - The adapter lives in `packages/relay/src/adapters/slack/` following the Telegram adapter's module structure
  - Uses `@slack/bolt` as the single SDK dependency (covers Socket Mode, Web API, events)
  - Uses Slack's native streaming API (`chat.startStream`/`appendStream`/`stopStream`) released Oct 2025 for real-time agent response streaming
  - Bot responses always go in threads (`thread_ts`) to keep channels clean
  - Socket Mode only (no HTTP Events API) — matches DorkOS's self-hosted, behind-firewall use case
  - `slackify-markdown` v5 for standard Markdown to Slack mrkdwn conversion
  - A shared `formatForPlatform()` helper in `payload-utils.ts` centralizes format conversion across all adapters
  - Multi-instance support (multiple Slack workspaces via separate bot tokens)
- **Out of scope:**
  - HTTP Events API / webhook mode (Socket Mode is sufficient for single-tenant)
  - Slack App Home / App Manifest auto-provisioning
  - Slash commands (future enhancement)
  - Interactive Block Kit actions beyond feedback buttons
  - Multi-workspace Enterprise Grid token management

## 2) Pre-reading Log

- `packages/relay/src/types.ts`: Core interfaces — `RelayAdapter`, `DeliveryResult`, `AdapterStatus`, `AdapterContext`. 6-method interface, optional `testConnection()`.
- `packages/relay/src/base-adapter.ts`: `BaseRelayAdapter` abstract class — handles status init, idempotency guards, error recording, relay ref lifecycle. Subclasses implement `_start()`, `_stop()`, `deliver()`.
- `packages/relay/src/adapters/telegram/telegram-adapter.ts`: Reference implementation — lifecycle, polling/webhook modes, exponential backoff reconnection, signal handling (typing).
- `packages/relay/src/adapters/telegram/inbound.ts`: Parses Telegram updates into `StandardPayload` with `responseContext` and `platformData`. Publishes to `relay.human.telegram.{chatId}`.
- `packages/relay/src/adapters/telegram/outbound.ts`: StreamEvent-aware buffering — accumulates `text_delta` chunks, flushes on `done`/`error`. Truncates to 4096 chars. Echo prevention.
- `packages/relay/src/adapters/telegram/webhook.ts`: HTTP server for webhook mode. Secret token verification. Graceful shutdown.
- `packages/relay/src/adapters/webhook/webhook-adapter.ts`: Simpler adapter — HMAC-SHA256 verification, nonce replay detection, secret rotation.
- `packages/relay/src/adapter-registry.ts`: Manages lifecycle, routes outbound by subject prefix matching.
- `packages/relay/src/lib/payload-utils.ts`: Shared helpers — `extractPayloadContent()`, `detectStreamEventType()`, `extractTextDelta()`, `SILENT_EVENT_TYPES`.
- `packages/shared/src/relay-adapter-schemas.ts`: Zod schemas for `AdapterManifest`, `AdapterConfig`, `ConfigField` with conditional visibility (`showWhen`).
- `apps/server/src/services/relay/adapter-factory.ts`: Built-in adapter instantiation — switch on `type`, pass config + dependencies.
- `apps/server/src/services/relay/adapter-manager.ts`: Lifecycle orchestration, manifest registration, hot-reload via chokidar.
- `research/20260227_slack_vs_telegram_relay_adapter.md`: Prior Slack research — SDK comparison, scopes, DM handling, rate limits.
- `research/20260313_slack_bot_adapter_best_practices.md`: Fresh research — native streaming API, threading, Socket Mode confirmation, `slackify-markdown`.
- `specs/relay-adapter-dx/`: Recently completed DX improvements — `BaseRelayAdapter`, API versioning, plugin loader fixes.
- `packages/relay/src/adapters/telegram/__tests__/telegram-adapter.test.ts`: Test patterns — mock grammy, mock relay publisher, test idempotency/error handling/stream buffering.

## 3) Codebase Map

**Primary components/modules:**

- `packages/relay/src/adapters/telegram/` — Reference adapter implementation (4 modules + tests)
- `packages/relay/src/types.ts` — `RelayAdapter` interface, `AdapterStatus`, `DeliveryResult`
- `packages/relay/src/base-adapter.ts` — `BaseRelayAdapter` abstract class
- `packages/relay/src/adapter-registry.ts` — Adapter lifecycle + subject-prefix routing
- `packages/relay/src/lib/payload-utils.ts` — Payload extraction helpers
- `packages/shared/src/relay-adapter-schemas.ts` — Manifest + config Zod schemas
- `apps/server/src/services/relay/adapter-factory.ts` — Built-in adapter instantiation
- `apps/server/src/services/relay/adapter-manager.ts` — Lifecycle orchestration + manifest registration

**Shared dependencies:**

- `packages/relay/src/index.ts` — Main barrel export (adapters, base class, registry)
- `packages/shared/src/relay-schemas.ts` — `RelayEnvelope`, `StandardPayload` schemas
- `packages/relay/src/lib/payload-utils.ts` — Content extraction, stream event detection

**Data flow:**

```
Slack message → @slack/bolt event handler → inbound.ts (parse to StandardPayload)
  → relay.publish('relay.human.slack.{channelId}', payload)
  → BindingRouter resolves → republish to relay.agent.{sessionId}
  → ClaudeCodeAdapter creates agent session → agent streams response
  → relay.publish('relay.human.slack.{channelId}', streamEvents)
  → SlackAdapter.deliver() → outbound.ts (chatStream() or chat.postMessage)
  → Slack channel/DM
```

**Feature flags/config:**

- Adapter config in `~/.dork/relay/adapters.json`
- Required credentials: `SLACK_BOT_TOKEN` (xoxb-), `SLACK_APP_TOKEN` (xapp-), `SLACK_SIGNING_SECRET`

**Potential blast radius:**

- Direct: New files in `packages/relay/src/adapters/slack/` (5 files)
- Modified: `adapter-factory.ts` (add slack case), `adapter-manager.ts` (register manifest), `payload-utils.ts` (add format conversion layer), `packages/relay/src/index.ts` (export)
- Tests: New test files + update to `payload-utils` tests
- Dependencies: `@slack/bolt`, `slackify-markdown` added to `packages/relay/package.json`

## 5) Research

### Potential Solutions

**1. Socket Mode with @slack/bolt + Native Streaming API**

- Description: Use `@slack/bolt` in Socket Mode for receiving events. Use Slack's native `chatStream()` API for streaming agent responses token-by-token. Use `slackify-markdown` for format conversion.
- Pros:
  - No public URL required — perfect for self-hosted
  - Native streaming gives ChatGPT-like UX in Slack
  - `@slack/bolt` is the official SDK, one package covers everything
  - Socket Mode is Slack's explicit recommendation for single-tenant apps
  - Threading keeps channels clean, naturally scopes agent sessions
- Cons:
  - Socket Mode connections can drop (need reconnection logic, but Bolt handles this)
  - Missed events during reconnection window (Slack doesn't replay Socket Mode events)
  - Streaming API is relatively new (Oct 2025) — may have edge cases
- Complexity: Medium
- Maintenance: Low (official SDK, active maintenance)

**2. HTTP Events API with @slack/bolt + edit-in-place (chat.update)**

- Description: Use HTTP mode with signing secret verification. Stream responses via repeated `chat.update` calls to edit a placeholder message in-place.
- Pros:
  - HTTP is more reliable (retries, no dropped connections)
  - Edit-in-place is a proven pattern used by many bots
- Cons:
  - Requires public URL (complicates self-hosted setup)
  - `chat.update` subject to Tier 3 rate limits (~50 req/min per channel)
  - More initial setup (SSL, challenge verification, 3-second response deadline)
  - Not the recommended approach for AI streaming responses
- Complexity: Medium-High
- Maintenance: Medium

**3. Custom WebSocket client (low-level)**

- Description: Bypass `@slack/bolt` entirely, connect directly to Slack's Socket Mode WebSocket endpoint using raw `ws` library. Build event parsing and API calls manually.
- Pros:
  - Maximum control over connection lifecycle
  - Smaller dependency footprint
- Cons:
  - Reimplements everything Bolt already does
  - No official support or type safety
  - Higher maintenance burden
  - Against Slack's recommendation
- Complexity: High
- Maintenance: High

### Security Considerations

- Bot tokens (`xoxb-`) and app tokens (`xapp-`) stored in `adapters.json` — already masked by `AdapterManager.maskSensitiveFields()`
- Signing secret used for webhook verification (not needed in Socket Mode, but stored for potential future HTTP mode)
- `testConnection()` validates token by calling `auth.test` — lightweight, no side effects

### Performance Considerations

- Slack rate limits: 1 message/sec/channel (Tier 2), `chat.update` at ~50/min (Tier 3)
- Native streaming API avoids `chat.update` rate limits entirely
- DM channel IDs should be cached per-user to avoid redundant `conversations.open` calls
- `slackify-markdown` is lightweight — `unified`/`remark` based, negligible overhead per message

### Recommendation

**Recommended Approach:** Socket Mode with @slack/bolt + Native Streaming API (Option 1)

**Rationale:** This is the approach Slack explicitly designed for AI agent bots. Socket Mode eliminates the public URL requirement that would otherwise complicate DorkOS's self-hosted deployment story. The native streaming API (`chatStream()`) provides a first-class streaming experience without rate limit concerns. `@slack/bolt` is the official, actively maintained SDK with excellent TypeScript support. This mirrors the Telegram adapter's architecture (polling-first, streaming-aware) while leveraging Slack-specific capabilities.

**Caveats:**

- The `chatStream()` API was released Oct 2025 — verify exact TypeScript types from installed package `.d.ts` files during implementation
- Socket Mode has a 10-connection limit per app, but this is irrelevant for single-tenant DorkOS

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Streaming approach | Native Streaming API (`chat.startStream`/`appendStream`/`stopStream`) | First-class Slack support for AI agents, avoids `chat.update` rate limits, ChatGPT-like UX |
| 2 | Threading behavior | Always thread replies | Keeps channels clean, naturally scopes agent sessions per-thread. No config surface needed. |
| 3 | Connection mode | Socket Mode only | No public URL required — perfect for self-hosted. Slack's recommendation for single-tenant. Simpler setup. |
| 4 | Format conversion | Shared `formatForPlatform()` in `payload-utils.ts` | Centralizes Markdown-to-platform conversion. Benefits Telegram (HTML), Slack (mrkdwn), webhooks (plain text), and future adapters. |
