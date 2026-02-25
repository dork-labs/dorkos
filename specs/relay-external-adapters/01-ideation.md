---
slug: relay-external-adapters
number: 53
created: 2026-02-24
status: ideation
---

# Relay External Adapters

**Slug:** relay-external-adapters
**Author:** Claude Code
**Date:** 2026-02-24
**Branch:** preflight/relay-external-adapters
**Related:** Relay Spec 4 (`docs/plans/relay-specs/04-relay-external-adapters.md`)

---

## 1) Intent & Assumptions

- **Task brief:** Build the external adapter system for Relay — a plugin interface that lets any external channel (Telegram, webhooks) become a set of endpoints on the Relay message bus. This is where Relay crosses the process boundary. Includes the RelayAdapter plugin interface, Telegram adapter (reference implementation), webhook adapter (generic HTTP), adapter lifecycle management with hot-reloadable config, HTTP routes for adapter management, client UI for adapter status, restructuring server services into domain folders, and updating the marketing site's ActivityFeedHero to use Relay-shaped data.
- **Assumptions:**
  - Relay core library (Spec 50) is implemented and provides `RelayCore` with publish, subscribe, registerEndpoint, signal emission, Maildir storage, SQLite indexing, budget enforcement, and rate limiting
  - Relay server/client integration (Spec 51) provides `/api/relay/*` routes, SSE streaming, client Relay panel with ActivityFeed, EndpointList, InboxView, and TanStack Query hooks
  - `packages/shared/src/relay-schemas.ts` already defines `RelayEnvelope`, `RelayBudget`, `Signal`, `Attachment`, `ResponseContext`, and HTTP request/response Zod schemas
  - Telegram Bot API token will be provided by the user via adapter config
  - grammY is available as an npm dependency for Telegram bot integration
- **Out of scope:**
  - Slack adapter (same interface, built later)
  - Email adapter (SMTP complexity, built later)
  - Voice/streaming adapter (OQ-7, needs separate design)
  - Pulse/Console migration to Relay endpoints (Spec 5)
  - `@grammyjs/runner` for high-load Telegram bots (simple polling sufficient for DorkOS use case)

## 2) Pre-reading Log

- `packages/relay/src/relay-core.ts`: Main orchestrator — `RelayCore` class with publish, subscribe, registerEndpoint, unregisterEndpoint. Composes all sub-modules via constructor injection. No adapter interface exists yet.
- `packages/relay/src/types.ts`: Core types — `EndpointInfo`, `MessageHandler`, `SignalHandler`, `RateLimitConfig`, `CircuitBreakerConfig`, `BackpressureConfig`. No adapter types.
- `packages/relay/src/endpoint-registry.ts`: `EndpointRegistry` class manages endpoint lifecycle. `hashSubject()` utility for Maildir paths.
- `packages/relay/src/subscription-registry.ts`: In-memory subscriptions with NATS-style subject pattern matching and handler dispatch.
- `packages/relay/src/maildir-store.ts`: POSIX atomic Maildir (tmp/new/cur/failed/) file delivery.
- `packages/relay/src/sqlite-index.ts`: Message indexing, metrics queries, budget tracking, rate limit counting.
- `packages/relay/src/signal-emitter.ts`: Ephemeral in-memory pub/sub for signals (typing, presence).
- `packages/relay/src/rate-limiter.ts`, `circuit-breaker.ts`, `backpressure.ts`: Reliability modules — per-sender, per-endpoint checks.
- `packages/relay/src/index.ts`: Barrel re-exports all classes/types.
- `apps/server/src/routes/relay.ts`: `createRelayRouter(relayCore)` — POST/GET messages, endpoints, inbox, dead letters, metrics, SSE stream.
- `apps/server/src/services/relay-state.ts`: Feature flag pattern — `setRelayEnabled(bool)`, `isRelayEnabled()`.
- `apps/server/src/services/mcp-tool-server.ts`: Plugin registration pattern — `createDorkOsToolServer(deps)` with `McpToolDeps` interface, dynamic tool registration via `tool()` SDK API. Relay tools guarded by `if (!deps.relayCore)`.
- `apps/server/src/services/session-broadcaster.ts`: Chokidar file watching pattern with debouncing (100ms), incremental byte-offset reading, SSE broadcasting to connected clients.
- `apps/server/src/services/stream-adapter.ts`: SSE helpers — `initSSEStream()`, `sendSSEEvent()`, `endSSEStream()`.
- `apps/server/src/index.ts`: Server startup — RelayCore instantiated, `relay.system.console` endpoint registered, routes mounted, relay-state flag set.
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`: Main panel container with tabs for Activity/Endpoints, conditional rendering on enabled state.
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`: Message list rendering `MessageRow` components with loading/empty states.
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`: SSE subscription triggering TanStack Query refetch on events.
- `apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx`: Simulated `ACTIVITY_POOL` constant with mock activity data. Target for format update to match Relay envelope shape.
- `packages/shared/src/relay-schemas.ts`: Zod schemas for `RelayEnvelope`, `RelayBudget`, `Signal`, `Attachment`, `ResponseContext`, and HTTP shapes.
- `packages/shared/src/config-schema.ts`: `UserConfigSchema` for `~/.dork/config.json` with relay.enabled flag.
- `meta/modules/relay-litepaper.md` (lines 100-108): Vision for adapter model — adapters listen for external messages, publish to Relay subject hierarchy, normalize to shared envelope schema.
- `docs/plans/2026-02-24-relay-design.md` (lines 239-262): `RelayAdapter` interface spec — `{ id, subjectPrefix, start(relay), stop(), deliver(subject, envelope) }`. Adapters translate bidirectionally.
- `docs/plans/2026-02-24-relay-design.md` (lines 389-405): Group message mapping — external groups to single Relay subjects (e.g., `relay.human.telegram.group.birthday-planning`).
- `docs/plans/2026-02-24-relay-design.md` (lines 409-423): File attachments and message editing as payload conventions. Adapters translate to platform APIs.
- `docs/plans/2026-02-24-relay-design.md` (lines 458-476): Console activity feed via Relay SSE — subscribe to `/api/relay/events`, display live events with module, text, timestamp.
- `contributing/architecture.md`: Hexagonal architecture with Transport interface, dependency injection patterns, module layout.
- `.claude/rules/server-structure.md`: Service count threshold — < 15 flat OK, 15-20 suggest grouping, 20+ restructure required. Currently at 24 services.

## 3) Codebase Map

- **Primary components/modules:**
  - `packages/relay/src/relay-core.ts` — Main RelayCore class, needs adapter registry integration
  - `packages/relay/src/types.ts` — Core types, needs RelayAdapter interface definition
  - `packages/relay/src/index.ts` — Barrel exports, needs adapter exports
  - `apps/server/src/routes/relay.ts` — Existing relay routes, needs adapter management endpoints
  - `apps/server/src/index.ts` — Server startup, needs adapter manager initialization
  - `apps/server/src/services/mcp-tool-server.ts` — MCP tools, needs adapter management tools
  - `apps/client/src/layers/features/relay/ui/RelayPanel.tsx` — Client panel, needs adapter status tab
  - `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx` — Feed display, needs adapter event integration
  - `apps/client/src/layers/entities/relay/` — Entity hooks, needs adapter status/config hooks
  - `apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx` — Marketing feed, needs format update
  - `packages/shared/src/relay-schemas.ts` — Shared schemas, needs adapter config/status schemas

- **Shared dependencies:**
  - `packages/shared/src/relay-schemas.ts` — Zod schemas shared between server and client
  - `packages/shared/src/config-schema.ts` — User config schema with relay section
  - `apps/client/src/layers/shared/model/` — Zustand store, hooks
  - `apps/client/src/layers/shared/ui/` — shadcn primitives (Badge, Tabs, etc.)
  - TanStack Query for server state management in client
  - chokidar for file watching (config hot-reload)
  - grammy for Telegram bot integration (new dependency)

- **Data flow:**
  - **Outbound:** Agent publishes to `relay.human.telegram.{userId}` → RelayCore routes to adapter's subscription → adapter calls Telegram API / HTTP POST
  - **Inbound:** Telegram long poll / webhook POST → adapter calls `relay.publish('relay.human.telegram.{userId}', envelope)` → RelayCore delivers to subscribed agents
  - **Client view:** `useRelayEventStream()` SSE → TanStack Query refetch → ActivityFeed re-renders

- **Feature flags/config:**
  - `relay.enabled` in `~/.dork/config.json` — existing flag
  - `~/.dork/relay/adapters.json` — new config file for adapter definitions (token, enabled, settings per adapter)
  - Environment variables: `DORKOS_RELAY_ENABLED`, `DORK_HOME`

- **Potential blast radius:**
  - **New files (~18):** adapter interface + registry in packages/relay, Telegram adapter, webhook adapter, adapter manager service, adapter routes, adapter Zod schemas, client adapter hooks, client adapter UI components, adapter tests
  - **Modified files (~12):** relay-core.ts (adapter registry hooks), relay index.ts (exports), server index.ts (adapter init), relay routes (adapter endpoints), mcp-tool-server.ts (adapter tools), config-schema.ts (adapter config), RelayPanel.tsx (adapter tab), ActivityFeed.tsx (adapter events), ActivityFeedHero.tsx (data format), plus server service restructuring into domain folders
  - **Test files (~11):** adapter interface, registry, telegram, webhook, manager, routes, client hooks, client UI

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

### Telegram Bot Library

**grammY** is the clear winner:
- TypeScript-first with inline Bot API type hints
- Built-in `@grammyjs/auto-retry` plugin handles 429 flood limits, 500 errors, and network failures automatically
- Middleware error boundaries isolate handler failures
- Active maintenance tracking latest Telegram Bot API versions
- 1.2M weekly npm downloads (vs 160K for Telegraf, 156K for node-telegram-bot-api)
- Cloudflare Workers compatible (ESM web bundle)

### Long Polling vs Webhooks

**Long polling as default**, webhook as opt-in config flag:
- Long polling requires no public URL, no SSL cert, no ngrok dependency for Telegram specifically
- grammY's `bot.stop()` drains updates before shutdown — no message loss on restart
- `@grammyjs/auto-retry` handles network failures automatically
- Webhooks only valuable in autoscaling cloud environments
- DorkOS ngrok tunnel uses port 4242 which isn't in Telegram's webhook port whitelist (443/80/88/8443)
- Switching from polling to webhook is a few lines of code change — middleware is identical

### Webhook Adapter Security (Inbound)

Four-layer defense:
1. **HMAC-SHA256 signature verification** — `HMAC-SHA256(secret, "${timestamp}.${rawBody}")`, compare with `crypto.timingSafeEqual()` (timing-safe, not `===`)
2. **Timestamp window** — Reject requests where `|now - timestamp| > 300s` (Stripe's standard 5-minute tolerance)
3. **Nonce tracking** — `Map<string, expiresAt>` with 24h TTL, pruned every 5 minutes
4. **Idempotency key** — Stable UUID per event, track `(adapterId, eventId)` pairs

Raw body must be captured before `bodyParser.json()` — use Express `verify` callback.

### Adapter Plugin Architecture

- **Registry pattern:** `Map<id, RelayAdapter>` with `Promise.allSettled()` for multi-adapter operations (one crash never stops others)
- **Hot-reload sequence (no message gap):** start new → register new → stop old (drain in-flight). If new start() throws, abort — old stays active.
- **Error isolation:** Individual `try/catch` per adapter in all lifecycle methods
- **Graceful shutdown:** `bot.stop()` is async — adapter `stop()` must await it. SIGTERM ordering: stop adapters → stop RelayCore → stop Express

### Testing Strategies

- **Telegram unit tests:** `vi.mock('grammy')` to mock `Bot` class
- **Telegram integration tests:** MSW 2.x (`msw/node`) intercepts `api.telegram.org` at network layer
- **Webhook tests:** `signPayload()` helper for valid HMAC headers; test valid, expired, tampered, replayed with supertest
- **Lifecycle tests:** Verify start() rejection leaves other adapters unaffected; verify Promise.allSettled behavior

### Activity Feed

- Auto-scroll with position preservation when user scrolls up
- Variable-height rows without manual measurement
- Ring buffer cap (~1000 items) prevents DOM bloat
- 50ms debounce on incoming events to batch React renders
- Timestamp display: "just now" / "5s ago" for < 60s, "3m ago" for 1m-1hr, HH:MM:SS for > 1hr, full ISO 8601 on hover
- Filter by adapter / direction (inbound/outbound) / severity via dropdown

### Security Considerations

- Never log adapter secrets (tokens, webhook secrets) — log HMAC of secret as stable identifier
- File permissions on `~/.dork/relay/adapters.json` should be 0600
- Support dual-secret rotation: verify against both old and new secret during 24h transition window
- Budget envelopes still apply to external messages — prevent agents from spamming external channels
- Telegram bot privacy mode: bot doesn't receive all group messages by default (only commands/replies) — must document

### Performance Considerations

- grammY simple polling: sufficient up to ~5K msgs/hour
- Per-chat Telegram rate limit: 1 msg/s enforced with per-chat `lastSentAt` Map + backoff on 429
- `awaitWriteFinish: { stabilityThreshold: 150 }` in chokidar prevents config reload on partial writes
- Nonce Map pruning: `setInterval` every 5 minutes to prevent unbounded growth

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Where do adapter implementations live? | `packages/relay/src/adapters/` | Keeps adapters alongside the RelayAdapter interface they implement. Reusable by any consumer (server, CLI, Obsidian plugin). Follows the monorepo pattern where domain logic lives in packages/. Adapters import grammy/fetch as peer deps. |
| 2 | How should ActivityFeedHero.tsx on the marketing site be updated? | Update simulated data to match Relay event format | Replace `ACTIVITY_POOL` with data shaped like real `RelayEnvelope` events (subjects, timestamps, payload types). Marketing site stays static/deployable on Vercel but the format matches what the real Console shows. Lowest risk. |
| 3 | Which Telegram bot library? | grammY (`npm install grammy @grammyjs/auto-retry`) | Best TypeScript support, built-in auto-retry for 429/500/network errors, middleware error boundaries, inline Bot API docs. Active maintenance tracking latest Telegram API. 1.2M weekly downloads. |
| 4 | Should server services be restructured into domain folders? | Yes — restructure as part of this spec | Currently at 24 services (exceeds 20+ threshold). Group into domain folders: `services/relay/`, `services/pulse/`, `services/session/`, `services/core/`. Prevents tech debt accumulation. Widens blast radius but creates cleaner structure for the 6+ new adapter-related service files. |
