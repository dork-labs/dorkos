# Task Breakdown: Unified Adapter System & Claude Code Runtime Adapter

**Spec:** `specs/relay-runtime-adapters/02-specification.md`
**Generated:** 2026-02-25
**Mode:** Full decomposition

---

## Summary

| Phase     | Name                                   | Tasks        | Size Estimate     |
| --------- | -------------------------------------- | ------------ | ----------------- |
| 1         | Interface Extension & Adapter Refactor | 4 tasks      | 2 medium, 2 small |
| 2         | Plugin Loader                          | 1 task       | 1 large           |
| 3         | Claude Code Adapter                    | 2 tasks      | 2 large           |
| 4         | Server Integration                     | 3 tasks      | 1 large, 2 medium |
| **Total** |                                        | **10 tasks** |                   |

---

## Phase 1: Interface Extension & Adapter Refactor

### 1.1 Add AdapterContext and DeliveryResult types to relay types [medium]

**Dependencies:** none | **Parallel with:** 1.2

Add `AdapterContext` and `DeliveryResult` interfaces to `packages/relay/src/types.ts`. Update the `RelayAdapter.deliver()` signature to accept optional `AdapterContext` and return `Promise<DeliveryResult>`. Update `AdapterRegistryLike.deliver()` and `AdapterRegistry.deliver()` to pass context through. Extend `AdapterConfig.type` to include `'claude-code'` and `'plugin'`.

**Key files:**

- `packages/relay/src/types.ts` — new interfaces, updated signatures
- `packages/relay/src/adapter-registry.ts` — pass context through deliver()

---

### 1.2 Extend Zod adapter config schemas in relay-schemas [small]

**Dependencies:** none | **Parallel with:** 1.1

Extend `AdapterTypeSchema` to include `'claude-code'` and `'plugin'`. Add `PluginSourceSchema` with refinement requiring either `package` or `path`. Update `AdapterConfigSchema` with optional `builtin` and `plugin` fields, and accept `Record<string, unknown>` config in addition to existing typed configs.

**Key files:**

- `packages/shared/src/relay-schemas.ts` — schema updates

---

### 1.3 Refactor Telegram and webhook adapters for new deliver() signature [medium]

**Dependencies:** 1.1 | **Parallel with:** 1.4

Update `TelegramAdapter.deliver()` and `WebhookAdapter.deliver()` to accept optional `AdapterContext` (unused, prefixed with `_`) and return `DeliveryResult`. Convert throw-on-error to return `{ success: false, error }`. Add timing with `durationMs`. Update existing adapter tests for new return type.

**Key files:**

- `packages/relay/src/adapters/telegram-adapter.ts`
- `packages/relay/src/adapters/webhook-adapter.ts`

---

### 1.4 Export new types from relay package index [small]

**Dependencies:** 1.1 | **Parallel with:** 1.3

Add `AdapterContext` and `DeliveryResult` to the type exports in `packages/relay/src/index.ts`.

**Key files:**

- `packages/relay/src/index.ts`

---

## Phase 2: Plugin Loader

### 2.1 Implement adapter plugin loader [large]

**Dependencies:** 1.1, 1.4

Create `packages/relay/src/adapter-plugin-loader.ts` with `loadAdapters()` function that handles three adapter sources: built-in (from factory map), npm packages (dynamic import), and local files (pathToFileURL import). Includes `validateAdapterShape()` for duck-type validation. Loading errors are non-fatal. Export from package index. Write comprehensive tests with mocked dynamic imports covering all 9 test cases (built-in, npm, local path, relative path resolution, validation, missing export, disabled entries, failure resilience, shape validation).

**Key files:**

- `packages/relay/src/adapter-plugin-loader.ts` — new file
- `packages/relay/src/__tests__/adapter-plugin-loader.test.ts` — new test file
- `packages/relay/src/index.ts` — exports

---

## Phase 3: Claude Code Adapter

### 3.1 Implement ClaudeCodeAdapter [large]

**Dependencies:** 1.1, 1.4

Create `packages/relay/src/adapters/claude-code-adapter.ts` — the built-in adapter replacing `MessageReceiver`. Handles `relay.agent.>` (agent messages) and `relay.system.pulse.>` (Pulse dispatch). Features: semaphore concurrency control (`maxConcurrent`), budget-aware timeout via AbortController, `<relay_context>` XML prompt formatting, trace span recording, Pulse run lifecycle management, response event publishing to `replyTo`. Defines `AgentManagerLike`, `TraceStoreLike`, `PulseStoreLike` dependency interfaces. Port logic from `message-receiver.ts`.

**Key files:**

- `packages/relay/src/adapters/claude-code-adapter.ts` — new file
- `packages/relay/src/index.ts` — exports

---

### 3.2 Write ClaudeCodeAdapter tests [large]

**Dependencies:** 3.1

Create `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` with 15+ test cases: agent message delivery, XML context formatting, concurrency semaphore, TTL timeout, response publishing, trace span lifecycle, error handling, Mesh context usage, default cwd fallback, Pulse dispatch handling, invalid payload rejection, Pulse timeout/cancellation, output summary collection, adapter lifecycle (start/stop).

**Key files:**

- `packages/relay/src/adapters/__tests__/claude-code-adapter.test.ts` — new test file

---

## Phase 4: Server Integration

### 4.1 Update AdapterManager for claude-code and plugin types [large]

**Dependencies:** 2.1, 3.1 | **Parallel with:** 4.2

Update `apps/server/src/services/relay/adapter-manager.ts`: add `AdapterManagerDeps` interface (agentManager, traceStore, pulseStore, optional meshCore), make `createAdapter()` async, handle `'claude-code'` and `'plugin'` types, add `loadPlugin()` method, add `buildContext()` for Mesh enrichment, add `ensureDefaultConfig()` to generate default `adapters.json` with claude-code adapter. Update all callers for async `createAdapter()`.

**Key files:**

- `apps/server/src/services/relay/adapter-manager.ts`
- `apps/server/src/services/relay/__tests__/adapter-manager.test.ts`

---

### 4.2 Remove MessageReceiver and update server startup [medium]

**Dependencies:** 4.1

Delete `message-receiver.ts` and its test file. Remove all imports and references from `apps/server/src/index.ts` (import, variable, instantiation, start/stop calls). Update relay services barrel export. Update `AdapterManager` construction in server startup to pass new `deps` parameter. Verify no broken imports remain.

**Key files:**

- `apps/server/src/services/relay/message-receiver.ts` — DELETE
- `apps/server/src/services/relay/__tests__/message-receiver.test.ts` — DELETE
- `apps/server/src/services/relay/index.ts` — remove exports
- `apps/server/src/index.ts` — update startup

---

### 4.3 End-to-end verification and CLAUDE.md updates [medium]

**Dependencies:** 4.2

Run `npm run typecheck`, `npm test -- --run`, `npm run lint`. Verify the complete adapter flow (publish -> AdapterRegistry -> ClaudeCodeAdapter -> AgentManager -> response). Update CLAUDE.md service descriptions to remove MessageReceiver references and document ClaudeCodeAdapter, plugin loader, and updated AdapterManager capabilities.

**Key files:**

- `CLAUDE.md` — documentation updates

---

## Dependency Graph

```
1.1 ──┬──→ 1.3 ──→ (done)
      ├──→ 1.4 ──→ 2.1 ──→ 4.1 ──→ 4.2 ──→ 4.3
      └──→ 1.4 ──→ 3.1 ──→ 3.2
1.2 ──→ (done, parallel with 1.1)
```

**Critical path:** 1.1 → 1.4 → 3.1 → 4.1 → 4.2 → 4.3
