# Implementation Summary: Relay External Adapters

**Created:** 2026-02-24
**Last Updated:** 2026-02-24
**Spec:** specs/relay-external-adapters/02-specification.md

## Progress

**Status:** Complete
**Tasks Completed:** 25 / 25

## Tasks Completed

### Session 1 - 2026-02-24

- Task 1: Add RelayAdapter interface and adapter config types to `packages/relay/src/types.ts` and `packages/relay/src/index.ts`
- Task 2: Add adapter Zod schemas to `packages/shared/src/relay-schemas.ts`
- Task 3: Implement `AdapterRegistry` class in `packages/relay/src/adapter-registry.ts`
- Task 4: Integrate `AdapterRegistry` into `RelayCore` publish pipeline and shutdown
- Task 5: Write `AdapterRegistry` unit tests (16 tests, all passing); add `createMockAdapter` to `packages/test-utils`
- Task 6: Create domain folder structure — moved 24 service + 21 test files into core/, session/, pulse/, relay/
- Task 7: Update all import paths across apps/server (40 files modified, 473 server tests pass)
- Task 8: Add barrel index.ts exports for all 4 domain folders
- Task 9: Install grammy + @grammyjs/auto-retry in packages/relay
- Task 10: Implement TelegramAdapter (grammy, polling/webhook modes, inbound/outbound, typing signals)
- Task 11: Implement WebhookAdapter (HMAC-SHA256, timestamp window, nonce tracking, dual-secret rotation)
- Task 12: Verify adapter unit tests (32 Telegram + 35 Webhook + 16 Registry = 83 tests, all passing)
- Task 13: Implement AdapterManager service with chokidar hot-reload, error isolation, graceful shutdown
- Task 14: Add adapter HTTP routes (GET/POST /adapters, enable/disable/reload/status, webhook inbound routing)
- Task 15: Add adapter MCP tools (relay_list_adapters, relay_adapter_status, relay_toggle_adapter)
- Task 16: Wire AdapterManager into server startup with SIGTERM ordering and feature flag integration
- Task 17: Write server integration tests (19 AdapterManager tests + 14 adapter route tests, 519 server tests pass)
- Task 18: Add client adapter hooks (useRelayAdapters, useToggleAdapter) and extend Transport interface
- Task 19: Add Adapters tab to RelayPanel.tsx with loading/empty states
- Task 20: Create AdapterCard.tsx component with status dots, message counts, enable/disable switch
- Task 21: Enhance ActivityFeed.tsx with source badges (TG/WH/SYS), direction indicators, filter dropdown
- Task 22: Write client tests for AdapterCard (15 tests) and use-relay-adapters hook (11 tests)
- Task 23: Update ActivityFeedHero.tsx with Relay-shaped simulated data
- Task 24: Create contributing/relay-adapters.md developer guide (762 lines)
- Task 25: Update contributing/architecture.md with Relay section and adapter documentation

## Files Modified/Created

**Source files:**

- `packages/relay/src/types.ts` — Added `RelayPublisher`, `RelayAdapter`, `AdapterStatus`, `AdapterConfig`, `TelegramAdapterConfig`, `WebhookAdapterConfig`, `AdapterRegistryLike`, `PublishResultLike` interfaces; `adapterRegistry` field added to `RelayOptions`
- `packages/relay/src/adapter-registry.ts` — New `AdapterRegistry` class implementing `AdapterRegistryLike`
- `packages/relay/src/relay-core.ts` — Integrated `adapterRegistry` into constructor, publish pipeline, and `close()`
- `packages/relay/src/index.ts` — Exported new adapter types and `AdapterRegistry`
- `packages/relay/src/adapters/telegram-adapter.ts` — TelegramAdapter class (grammy, polling/webhook modes, typing signals)
- `packages/relay/src/adapters/webhook-adapter.ts` — WebhookAdapter class (HMAC-SHA256, nonce tracking, dual-secret rotation)
- `packages/shared/src/relay-schemas.ts` — Added adapter Zod schemas (AdapterConfig, AdapterStatus, AdaptersConfigFile)
- `packages/shared/src/transport.ts` — Added `AdapterListItem` interface, `listRelayAdapters()`, `toggleRelayAdapter()` methods
- `packages/test-utils/src/mock-factories.ts` — Added `createMockAdapter()`, `signPayload()`, adapter Transport mocks
- `apps/server/src/services/relay/adapter-manager.ts` — AdapterManager service with hot-reload and lifecycle management
- `apps/server/src/services/relay/index.ts` — Barrel exports for relay services
- `apps/server/src/services/core/index.ts` — Barrel exports for 14 core services
- `apps/server/src/services/session/index.ts` — Barrel exports for 6 session services
- `apps/server/src/services/pulse/index.ts` — Barrel exports for 3 pulse services
- `apps/server/src/routes/relay.ts` — Added adapter HTTP endpoints and webhook inbound routing
- `apps/server/src/services/core/mcp-tool-server.ts` — Added adapter MCP tools
- `apps/server/src/index.ts` — Wired AdapterManager into startup with SIGTERM ordering
- `apps/client/src/layers/shared/lib/http-transport.ts` — Added adapter HTTP methods
- `apps/client/src/layers/shared/lib/direct-transport.ts` — Added adapter stub methods
- `apps/client/src/layers/entities/relay/model/use-relay-adapters.ts` — New TanStack Query hooks
- `apps/client/src/layers/entities/relay/index.ts` — Re-exported adapter hooks
- `apps/client/src/layers/features/relay/ui/AdapterCard.tsx` — New adapter card component
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx` — Added Adapters tab
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx` — Source badges, direction indicators, filters
- `apps/client/src/layers/features/relay/index.ts` — Re-exported AdapterCard
- `apps/web/src/layers/features/marketing/ui/ActivityFeedHero.tsx` — Relay-shaped simulated data
- `contributing/relay-adapters.md` — Developer guide (762 lines)
- `contributing/architecture.md` — Added Relay and adapter documentation
- 40+ files with updated import paths after domain restructure

**Test files:**

- `packages/relay/src/__tests__/adapter-registry.test.ts` — 16 unit tests
- `packages/relay/src/__tests__/adapters/telegram-adapter.test.ts` — 32 unit tests
- `packages/relay/src/adapters/__tests__/webhook-adapter.test.ts` — 35 unit tests
- `apps/server/src/services/relay/__tests__/adapter-manager.test.ts` — 19 unit tests
- `apps/server/src/routes/__tests__/relay.test.ts` — 33 tests (19 existing + 14 new adapter tests)
- `apps/client/src/layers/features/relay/__tests__/AdapterCard.test.tsx` — 15 component tests
- `apps/client/src/layers/entities/relay/__tests__/use-relay-adapters.test.ts` — 11 hook tests

## Test Results

- **Total tests:** 1855 passing across 130 test files
- **New tests added:** 128 tests (16 registry + 32 telegram + 35 webhook + 19 adapter-manager + 14 route + 15 component + 11 hook - 14 existing relay route tests)
- **Pre-existing failures:** 9 tests in 2 files (DirectoryPicker: 2, PulsePanel: 7) — unrelated to this implementation

## Known Issues

_(None)_

## Implementation Notes

### Session 1

- Used `AdapterRegistryLike` interface in `types.ts` to avoid circular dependency between `types.ts` and `adapter-registry.ts`
- Used `PublishResultLike` interface in `types.ts` to mirror `PublishResult` from `relay-core.ts` without circular import
- `RelayAdapter.start()` takes `RelayPublisher` (not `RelayCore`) to avoid circular dependency — RelayCore satisfies RelayPublisher
- In Zod v4, `z.record()` requires two arguments (key schema + value schema); fixed `headers` field accordingly
- Server services restructured into domain folders: core/ (14), session/ (6), pulse/ (3), relay/ (2)
- Hot-reload uses "start new → register → stop old" sequence for zero message gap
- Webhook inbound routes are dynamically mounted based on adapter config
- AdapterCard test uses vitest-native matchers (not @testing-library/jest-dom) for compatibility
