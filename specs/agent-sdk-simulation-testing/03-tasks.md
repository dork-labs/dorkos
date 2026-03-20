# Task Breakdown: Agent SDK Simulation & Testing Infrastructure

Generated: 2026-03-11
Source: specs/agent-sdk-simulation-testing/02-specification.md
Last Decompose: 2026-03-11

## Overview

Build a three-tier test simulation infrastructure that eliminates all real Claude API calls from DorkOS tests. The tiers are:

1. **Tier 1 (Vitest Unit)**: `sdk-scenarios.ts` — `wrapSdkQuery` + `SDKMessage` scenario builders for testing `sdk-event-mapper.ts` and `ClaudeCodeRuntime` internals at the SDK level.
2. **Tier 2 (Vitest Integration)**: `FakeAgentRuntime` + `collectSseEvents` — implements `AgentRuntime` with `vi.fn()` spies for Express route testing via supertest SSE. Replaces four duplicated `mockRuntime` objects.
3. **Tier 3 (Browser)**: `TestModeRuntime` + `ScenarioStore` + `/api/test/*` control endpoint — zero-latency `AgentRuntime` in a live server process, allowing Playwright tests to drive the real React client without any Anthropic API calls.

All new utilities live in `packages/test-utils` (Tiers 2–3 shared constants) or within their respective ESLint boundaries (Tier 1 in `services/runtimes/claude-code/`).

---

## Phase 1: Foundation

### Task 1.1: Create sdk-scenarios.ts with wrapSdkQuery and named scenario builders

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Tasks 1.2, 1.3, 1.4

**File**: `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts`

**Technical Requirements**:

- Must live within the `services/runtimes/claude-code/` ESLint import boundary
- Imports `SDKMessage` from `@anthropic-ai/claude-agent-sdk`
- Imports `vi` from `vitest` (only for `wrapSdkQuery`)
- All exported functions require TSDoc

**Implementation Steps**:

1. Implement `wrapSdkQuery(gen: AsyncGenerator<SDKMessage>)` — attaches `supportedModels: vi.fn().mockResolvedValue([])` and `setPermissionMode: vi.fn().mockResolvedValue(undefined)` to the generator via `Object.assign`.

2. Implement internal helpers `makeInit()` and `makeResult()` — these are fixture factories for the required first/last messages in every SDK sequence.

3. Implement `sdkSimpleText(text: string)` — yields `makeInit()` → `stream_event/content_block_delta/text_delta` → `makeResult()`.

4. Implement `sdkToolCall(toolName, input, responseText)` — yields init → `content_block_start/tool_use` → `content_block_delta/input_json_delta` → `content_block_stop` → text delta → result.

5. Implement `sdkTodoWrite(tasks)` — yields init → TodoWrite `content_block_start` → input delta → stop → `tool_use_summary` → result.

6. Implement `sdkError(message)` — yields init → result with `subtype: 'error'`, `is_error: true`.

**Acceptance Criteria**:

- [ ] File compiles with no TypeScript errors
- [ ] `wrapSdkQuery` output has both `supportedModels()` and `setPermissionMode()` attached
- [ ] All four scenario builders are exported
- [ ] TSDoc on all exported functions

---

### Task 1.2: Create TestScenario enum in packages/test-utils

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Tasks 1.1, 1.3, 1.4

**File**: `packages/test-utils/src/test-scenarios.ts`

**Technical Requirements**:

- No `vitest` import (used in both Vitest and live server contexts)
- `as const` so values narrow to string literal types
- Exports both the const object and the `TestScenarioKey` derived union type

**Acceptance Criteria**:

- [ ] `TestScenario.SimpleText` is typed as `'simple-text'` (not `string`)
- [ ] `TestScenarioKey` is a union of all five string literals
- [ ] No `vitest` imports
- [ ] Module-level TSDoc present

---

### Task 1.3: Create FakeAgentRuntime in packages/test-utils

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Tasks 1.1, 1.2, 1.4

**File**: `packages/test-utils/src/fake-agent-runtime.ts`

**Technical Requirements**:

- `implements AgentRuntime` — TypeScript compile error if the interface gains new methods
- All methods are `vi.fn()` spies
- `withScenarios(scenarios: ScenarioFn[]): this` — loads an ordered scenario queue; `sendMessage` dequeues from it
- Multi-turn support: `withScenarios([s1, s2])` — first `sendMessage` call uses `s1`, second uses `s2`
- Method signatures must exactly match the `AgentRuntime` interface in `packages/shared/src/agent-runtime.ts`, including: `acquireLock(sessionId, clientId, res: SseResponse)`, `updateSession(sessionId, opts: { permissionMode?, model? })`, `watchSession(sessionId, projectDir, callback, clientId?)`, `listSessions(projectDir)`, `getSession(projectDir, sessionId)`, etc.

**Acceptance Criteria**:

- [ ] `FakeAgentRuntime implements AgentRuntime` compiles
- [ ] Removing any method causes a TypeScript compile error
- [ ] Scenario queue dequeues in order for multi-turn tests
- [ ] `sendMessage` spy call count is observable

---

### Task 1.4: Create collectSseEvents helper in packages/test-utils

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Tasks 1.1, 1.2, 1.3

**File**: `packages/test-utils/src/sse-test-helpers.ts`

**Technical Requirements**:

- Uses `supertest`'s `buffer(true).parse(...)` pattern
- Parses `data: {...}` SSE lines into `StreamEvent[]`
- Non-JSON SSE lines are silently ignored (no exception)
- Returns an ordered array of all events emitted before the connection closes

**Acceptance Criteria**:

- [ ] Returns complete `StreamEvent[]` in emission order
- [ ] Non-JSON lines do not cause exceptions
- [ ] TSDoc on the exported function

---

### Task 1.5: Update packages/test-utils barrel to export new simulation utilities

**Size**: Small
**Priority**: High
**Dependencies**: Tasks 1.2, 1.3, 1.4
**Can run parallel with**: (none — depends on all three new modules)

**File**: `packages/test-utils/src/index.ts`

**Change**:
Add to the existing exports:

```typescript
export * from './fake-agent-runtime.js';
export * from './sse-test-helpers.js';
export * from './test-scenarios.js';
```

**Technical Requirements**:

- No name collisions with existing exports from `db.js`, `mock-factories.js`, `react-helpers.js`, `sse-helpers.js`
- `import { FakeAgentRuntime, collectSseEvents, TestScenario } from '@dorkos/test-utils'` resolves

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes across the monorepo after this change
- [ ] All three new exports are accessible from the package root

---

### Task 1.6: Write unit tests for sdk-scenarios.ts

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.7

**File**: `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.test.ts`

**Test Cases**:

- `wrapSdkQuery` attaches `supportedModels` and `setPermissionMode`
- `wrapSdkQuery` — `setPermissionMode` resolves to `undefined`
- `sdkSimpleText` yields `system/init` first, `result/success` last, text delta in between
- `sdkSimpleText` includes the provided text in the `text_delta` event
- `sdkToolCall` yields init → `content_block_start/tool_use` → `content_block_delta/input_json_delta` → `content_block_stop`
- `sdkToolCall` includes tool name in `content_block_start`
- `sdkTodoWrite` includes `tool_use_summary` with correct task count
- `sdkError` yields `is_error: true` result with the provided message and `subtype: 'error'`

**Acceptance Criteria**:

- [ ] All tests pass
- [ ] No real SDK API calls

---

### Task 1.7: Write unit tests for FakeAgentRuntime

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 1.6

**File**: `packages/test-utils/src/__tests__/fake-agent-runtime.test.ts`

**Test Cases**:

- Instantiation without error
- `sendMessage` yields events from first queued scenario
- Multi-turn: second `sendMessage` call dequeues second scenario
- `sendMessage` is a spy with observable call count
- `withScenarios` resets the index when called again
- `sendMessage` yields nothing when no scenarios loaded
- `hasSession` defaults to `false`
- `acquireLock` defaults to `true`

**Acceptance Criteria**:

- [ ] All tests pass
- [ ] Multi-turn scenario dequeuing verified

---

## Phase 2: Migration

### Task 2.1: Migrate sessions.test.ts to use FakeAgentRuntime

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: Tasks 2.2, 2.3, 2.4

**File**: `apps/server/src/routes/__tests__/sessions.test.ts`

**Migration Pattern**:

1. Import `FakeAgentRuntime` from `@dorkos/test-utils`
2. Replace top-level `mockRuntime = { ... }` with `const fakeRuntime = vi.hoisted(() => new FakeAgentRuntime())`
3. Update `runtimeRegistry` mock to return `fakeRuntime`
4. Replace all `mockRuntime.*` references with `fakeRuntime.*` in `beforeEach` and test bodies
5. Replace inline `sendMessage.mockImplementation(async function* () { ... })` patterns with `fakeRuntime.withScenarios([...])`

**Note**: The existing `sessions.test.ts` does not use `vi.hoisted()` for `mockRuntime` — it is a top-level `const`. The migration to `vi.hoisted()` is required so the mock is available when `vi.mock()` factory functions execute.

**Acceptance Criteria**:

- [ ] `pnpm vitest run apps/server/src/routes/__tests__/sessions.test.ts` passes
- [ ] No `mockRuntime` variable remains
- [ ] `vi.hoisted(() => new FakeAgentRuntime())` is used

---

### Task 2.2: Migrate sessions-interactive.test.ts to use FakeAgentRuntime

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: Tasks 2.1, 2.3, 2.4

**File**: `apps/server/src/routes/__tests__/sessions-interactive.test.ts`

**Migration Pattern**: Same as Task 2.1. The existing file already uses `vi.hoisted()` for `mockRuntime`, so step 2 is a direct replacement of the object literal with `new FakeAgentRuntime()`.

**Acceptance Criteria**:

- [ ] `pnpm vitest run apps/server/src/routes/__tests__/sessions-interactive.test.ts` passes
- [ ] No `mockRuntime` variable remains

---

### Task 2.3: Migrate sessions-relay.test.ts to use FakeAgentRuntime

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: Tasks 2.1, 2.2, 2.4

**File**: `apps/server/src/routes/__tests__/sessions-relay.test.ts`

**Migration Pattern**: Same as Task 2.1. Check `sessions-relay-correlation.test.ts` for the same pattern and apply migration there too if applicable.

**Acceptance Criteria**:

- [ ] `pnpm vitest run apps/server/src/routes/__tests__/sessions-relay.test.ts` passes
- [ ] No `mockRuntime` variable remains

---

### Task 2.4: Migrate sessions-boundary.test.ts to use FakeAgentRuntime

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.5
**Can run parallel with**: Tasks 2.1, 2.2, 2.3

**File**: `apps/server/src/routes/__tests__/sessions-boundary.test.ts`

**Migration Pattern**: Same as Task 2.1. Assertions on `ensureSession` call arguments must continue to work via `expect(fakeRuntime.ensureSession).toHaveBeenCalledWith(...)`.

**Acceptance Criteria**:

- [ ] `pnpm vitest run apps/server/src/routes/__tests__/sessions-boundary.test.ts` passes
- [ ] No `mockRuntime` variable remains

---

### Task 2.5: Update claude-code-runtime.test.ts to use wrapSdkQuery and shared scenario builders

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.1
**Can run parallel with**: Task 2.6

**File**: `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts`

**Migration Pattern**:

1. Import `wrapSdkQuery, sdkSimpleText, sdkToolCall, sdkError` from `./sdk-scenarios.js`
2. Remove the local `mockQueryResult` function (lines 76-82)
3. Replace `mockQueryResult(async function* () { ... })` calls with `wrapSdkQuery(sdkSimpleText(...))`, `wrapSdkQuery(sdkToolCall(...))`, or `wrapSdkQuery(sdkError(...))` as appropriate
4. For highly specific inline generators not covered by shared builders, keep as `wrapSdkQuery(async function* () { ... })` with an explanatory comment

**Acceptance Criteria**:

- [ ] All existing tests pass
- [ ] Local `mockQueryResult` function is removed
- [ ] At least 3 tests use named scenario builders

---

### Task 2.6: Create sessions-streaming.test.ts with SSE integration tests

**Size**: Medium
**Priority**: High
**Dependencies**: Tasks 1.5, 2.1
**Can run parallel with**: Task 2.5

**File**: `apps/server/src/routes/__tests__/sessions-streaming.test.ts`

**Test Cases**:

1. `emits session_status → text_delta events → done in order` — verifies the full SSE event sequence via `collectSseEvents`
2. `emits tool_call_start and tool_call_end for tool use scenarios` — verifies tool call SSE events
3. `returns 423 when session is locked by another client` — uses `request(app)` directly for HTTP status assertion
4. `sendMessage is called with the correct session ID and content` — spy call argument assertion

**Technical Requirements**:

- Same mock setup pattern as other session test files (boundary mock, runtime-registry mock, tunnel-manager mock)
- Uses `FakeAgentRuntime` from `@dorkos/test-utils` with `vi.hoisted()`
- Uses `collectSseEvents` from `@dorkos/test-utils`
- `beforeEach` sets up `ensureSession`, `acquireLock`, `isLocked`, `getLockInfo` defaults

**Acceptance Criteria**:

- [ ] All four test cases pass
- [ ] No real Claude API calls
- [ ] 423 locking test verifies HTTP status directly (not via `collectSseEvents`)

---

## Phase 3: Browser Tier

### Task 3.1: Create scenario-store.ts for TestModeRuntime

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: Tasks 3.2, 3.3

**File**: `apps/server/src/services/runtimes/test-mode/scenario-store.ts`

**Technical Requirements**:

- No `vitest` import — runs in a real server process
- Four built-in scenarios: `simple-text`, `tool-call`, `todo-write`, `error`
- `ScenarioStore` class (singleton exported as `scenarioStore`) with:
  - `setDefault(name)` — throws on unknown names with a message listing known scenarios
  - `setForSession(sessionId, name)` — throws on unknown names
  - `getScenario(sessionId)` — falls back to default when no session-specific scenario is set
  - `clearSession(sessionId)` — removes session-specific override
  - `reset()` — clears all session overrides and resets default to `'simple-text'`

**Acceptance Criteria**:

- [ ] No `vitest` import
- [ ] Unknown scenario name throws with descriptive error message
- [ ] `getScenario` falls back to default correctly
- [ ] `reset()` restores both session map and default

---

### Task 3.2: Create TestModeRuntime implementing AgentRuntime

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.1
**Can run parallel with**: Task 3.3

**File**: `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`

**Technical Requirements**:

- No `vitest` import
- `implements AgentRuntime` (TypeScript-enforced)
- `sendMessage` delegates to `scenarioStore.getScenario(sessionId)` and yields from the returned generator
- All storage methods return empty/null — no file I/O, no database access
- `acquireLock` always returns `true`; `isLocked` always returns `false`
- `getCapabilities()` returns `type: 'test-mode'` with `supportsToolApproval: false`

**Technical Note**: Method signatures must exactly match `AgentRuntime` — note that storage methods take `projectDir` as the first parameter (`listSessions(projectDir)`, `getSession(projectDir, sessionId)`, etc.), `acquireLock` takes `(sessionId, clientId, res: SseResponse)`, and `watchSession` takes `(sessionId, projectDir, callback, clientId?)`.

**Acceptance Criteria**:

- [ ] `TestModeRuntime implements AgentRuntime` compiles
- [ ] No `vitest` import
- [ ] `sendMessage` yields from scenario store
- [ ] All method signatures match interface (verified by TypeScript)

---

### Task 3.3: Create test-control.ts router for scenario configuration

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.1
**Can run parallel with**: Task 3.2

**File**: `apps/server/src/routes/test-control.ts`

**Endpoints**:

- `POST /scenario` — body: `{ name: string, sessionId?: string (UUID) }` — calls `scenarioStore.setDefault(name)` or `scenarioStore.setForSession(sessionId, name)`; returns `{ ok: true, scenario: name }` on success, 400 on validation failure or unknown scenario name
- `POST /reset` — calls `scenarioStore.reset()`; returns `{ ok: true }`

**Technical Requirements**:

- Zod validation on request body
- Try/catch around `scenarioStore` calls (methods throw on unknown scenarios) — returns 400 with the error message
- Follows API route conventions: no business logic in handler, delegates to service layer (`scenarioStore`)

**Acceptance Criteria**:

- [ ] `POST /api/test/scenario` with valid known scenario returns `{ ok: true }`
- [ ] `POST /api/test/scenario` with unknown scenario name returns HTTP 400
- [ ] `POST /api/test/scenario` with invalid body returns HTTP 400 with Zod details
- [ ] `POST /api/test/reset` returns `{ ok: true }`

---

### Task 3.4: Add DORKOS_TEST_RUNTIME env var and wire TestModeRuntime into server

**Size**: Medium
**Priority**: Medium
**Dependencies**: Tasks 3.2, 3.3
**Can run parallel with**: (none — integrates all Phase 3 pieces)

**Files Modified**:

- `apps/server/src/env.ts` — add `DORKOS_TEST_RUNTIME: z.string().optional().transform(v => v === 'true')`
- `apps/server/src/index.ts` — conditional runtime registration: `if (env.DORKOS_TEST_RUNTIME) { dynamic import TestModeRuntime } else { ClaudeCodeRuntime }`
- `apps/server/src/app.ts` — conditionally mount `/api/test` router when `DORKOS_TEST_RUNTIME=true`

**Technical Requirements**:

- `env.DORKOS_TEST_RUNTIME` is typed as `boolean` after the Zod transform
- `TestModeRuntime` is dynamically imported in `index.ts` to keep it out of the production module graph
- The `/api/test/*` routes return 404 in production (route not mounted)
- The `app.ts` change must be compatible with the existing `createApp()` signature (sync vs async)

**Acceptance Criteria**:

- [ ] `pnpm typecheck` passes
- [ ] `DORKOS_TEST_RUNTIME=true` server logs `[TestMode] TestModeRuntime registered`
- [ ] `GET /api/test/reset` returns 404 without the env var set
- [ ] Production build includes no reference to `TestModeRuntime` module path (or if imported statically, is never called)

---

### Task 3.5: Update Playwright config and create initial browser tests

**Size**: Medium
**Priority**: Medium
**Dependencies**: Tasks 3.4, 1.2
**Can run parallel with**: (none — requires all Tier 3 infrastructure)

**Files**:

- `apps/e2e/playwright.config.ts` — configure test-mode server access for mock tests
- `apps/e2e/tests/chat-mock.spec.ts` — three initial browser test cases

**Test Cases**:

1. `renders streamed text response from simple-text scenario` — sets `SimpleText` scenario, sends a message, asserts `Echo:` text appears in DOM
2. `renders tool call card for tool-call scenario` — sets `ToolCall` scenario, sends a message, asserts `Bash` tool name appears in DOM
3. `scenario endpoint rejects unknown scenario names` — asserts HTTP 400 from `POST /api/test/scenario` with an invalid name

**Technical Requirements**:

- `test.beforeEach` resets scenario store via `POST /api/test/reset`
- `TestScenario` constants from `@dorkos/test-utils` — no string literals for scenario names in tests
- UI selectors must match the actual React client's input element (verify against the client source)
- Playwright config change must not break existing tests

**Acceptance Criteria**:

- [ ] `apps/e2e/tests/chat-mock.spec.ts` is created
- [ ] At least one browser test passes (text visible in DOM from simulated response)
- [ ] Scenario rejection test passes (HTTP 400)
- [ ] Existing Playwright tests are not broken

---

## Dependency Graph

```
1.1 ──────────────────────────────────────> 1.6
1.2 ─┐
1.3 ─┤──> 1.5 ──> 2.1 ─┐
1.4 ─┘          2.2 ─┤──> 2.6
                2.3 ─┤
                2.4 ─┘
1.1 ────────────────────> 2.5
1.3 ──> 1.7

3.1 ─┬──> 3.2 ─┐
     └──> 3.3 ─┴──> 3.4 ──> 3.5
1.2 ──────────────────────────> 3.5
```

## Test Command Reference

```bash
# Run all tests (Turborepo)
pnpm test -- --run

# Tier 1 unit tests
pnpm vitest run apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.test.ts
pnpm vitest run packages/test-utils/src/__tests__/fake-agent-runtime.test.ts

# Tier 2 integration tests
pnpm vitest run apps/server/src/routes/__tests__/sessions.test.ts
pnpm vitest run apps/server/src/routes/__tests__/sessions-interactive.test.ts
pnpm vitest run apps/server/src/routes/__tests__/sessions-relay.test.ts
pnpm vitest run apps/server/src/routes/__tests__/sessions-boundary.test.ts
pnpm vitest run apps/server/src/routes/__tests__/sessions-streaming.test.ts

# Tier 3 browser tests (requires DORKOS_TEST_RUNTIME=true server)
pnpm playwright test apps/e2e/tests/chat-mock.spec.ts
```

## Acceptance Criteria Summary

- [ ] All Vitest tests pass with zero network requests to `api.anthropic.com`
- [ ] `FakeAgentRuntime` produces a TypeScript compile error when `AgentRuntime` adds a method it doesn't implement
- [ ] `wrapSdkQuery` output has `supportedModels` and `setPermissionMode` methods attached (unit tested)
- [ ] All 4 migrated session test files pass after replacing `mockRuntime` with `FakeAgentRuntime`
- [ ] `TestModeRuntime` module does not appear in the production server bundle (or is gated by env check)
- [ ] `GET /api/test/scenario` returns 404 in production (route not mounted)
- [ ] `POST /api/test/reset` returns 404 in production
- [ ] A Playwright test can send a message and assert the UI renders a simulated response without any real Claude API call
- [ ] `pnpm test -- --run` completes significantly faster than before (real SDK calls eliminated)
