---
slug: agent-sdk-simulation-testing
number: 123
created: 2026-03-11
status: ideation
---

# Agent SDK Simulation & Testing Infrastructure

**Slug:** agent-sdk-simulation-testing
**Author:** Claude Code
**Date:** 2026-03-11
**Branch:** preflight/agent-sdk-simulation-testing

---

## 1) Intent & Assumptions

- **Task brief:** Build a robust test infrastructure that fully simulates Agent SDK responses — without any real Claude API calls. The primary goal is zero latency: tests should run in milliseconds, be fully deterministic, and be CI-compatible. The simulation must cover the entire workflow from `query()` invocation through SSE delivery to the React client.
- **Assumptions:**
  - The `AgentRuntime` interface is the correct abstraction boundary — simulation lives behind it
  - The `claude-code-runtime.test.ts` pattern (mocking `query()` with `async function*`) is proven and is the foundation
  - Zero real Claude API calls in any test — `@anthropic-ai/claude-agent-sdk` is always mocked
  - Real JSONL transcripts from `~/.claude/projects/` are **not** usable as streaming fixtures directly (the JSONL format is completed messages; `query()` yields incremental SDKMessage streaming chunks — these are structurally different)
  - JSONL → StreamEvent replay (for client-side regression testing) is a separate, future tool built on top of the existing `transcript-reader.ts` path
- **Out of scope:**
  - Performance/load testing the Claude API
  - Testing Claude model quality or outputs
  - Relay mode simulation (focus is direct SDK path first)
  - JSONL fixture capture and replay (deferred to a follow-up spec)

---

## 2) Pre-reading Log

- `contributing/architecture.md`: Hexagonal architecture with Transport interface (HttpTransport / DirectTransport), AgentRuntime as the backend abstraction, Runtime Registry for DI, service layer organization
- `packages/shared/src/agent-runtime.ts`: `AgentRuntime` interface — `sendMessage()` returns `AsyncGenerator<StreamEvent>`, `watchSession()` for file watching, full session lifecycle + locking + interactive flows
- `packages/shared/src/schemas.ts`: `StreamEvent` as discriminated union covering `text_delta`, `tool_call_start/delta/end`, `tool_result`, `task_update`, `session_status`, `approval`, `question_prompt`, `error`, `done`, relay events
- `packages/test-utils/src/mock-factories.ts`: Existing `createMockTransport`, `createMockSession`, `createMockStreamEvent` — all Promise-based. No async generator simulation exists.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`: Main runtime — session lifecycle, locking, delegates `sendMessage` to `executeSdkQuery`
- `apps/server/src/services/runtimes/claude-code/message-sender.ts`: Core pipeline — calls `query()` from `@anthropic-ai/claude-agent-sdk`, yields StreamEvents via `mapSdkMessages`
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: **Pure async generator** — maps `SDKMessage` stream to `StreamEvent` stream. This is the layer being tested by SDKMessage-level simulation.
- `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts`: **Key file** — already uses `vi.hoisted() + async function*` to mock `query()`. This is the pattern to extract.
- `apps/server/src/routes/__tests__/sessions.test.ts`: Supertest SSE tests with `.buffer(true).parse(...)` — another proven pattern to promote to shared infrastructure
- `apps/server/src/routes/__tests__/sessions-interactive.test.ts`: 50-line `mockRuntime` object that will be replaced by `FakeAgentRuntime`
- `apps/server/src/services/core/runtime-registry.ts`: Singleton registry — `register(type, runtime)` + `getDefault()`. This is where `TestModeRuntime` is registered instead of `ClaudeCodeRuntime` in test-mode startup.
- `apps/server/src/index.ts`: Server startup — checks `DORKOS_TEST_RUNTIME` env var, registers appropriate runtime
- JSONL format (real transcripts): `{type: 'user'|'assistant'|'tool_use_summary'|'progress', message: {...}, sessionId, uuid, timestamp}` — **completed messages**, not streaming chunks

---

## 3) Codebase Map

**AgentRuntime Interface:**

- `packages/shared/src/agent-runtime.ts`
- Core method: `sendMessage(id, content, opts?): AsyncGenerator<StreamEvent>` — yields stream events as SDK responds
- Other methods: `watchSession`, `listSessions`, `getSession`, `getMessageHistory`, `getSessionTasks`, `approveTool`, `submitAnswers`, `acquireLock/releaseLock/isLocked`, `getCapabilities`, `getInternalSessionId`, `getSupportedModels`, `getCommands`, `checkSessionHealth`

**Real SDK Pipeline (to simulate):**

- `apps/server/src/services/runtimes/claude-code/message-sender.ts` — calls `query()`, pipes through mapper
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — `SDKMessage` → `StreamEvent` (pure async generator)
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — orchestrates the above

**Existing Mock Infrastructure (to build on):**

- `packages/test-utils/src/mock-factories.ts` — `createMockTransport`, `createMockSession`, `createMockStreamEvent`
- `packages/test-utils/src/index.ts` — barrel to extend with new exports

**Test Files Using Duplicated `mockRuntime` (to consolidate):**

- `apps/server/src/routes/__tests__/sessions.test.ts`
- `apps/server/src/routes/__tests__/sessions-interactive.test.ts`
- `apps/server/src/routes/__tests__/sessions-relay.test.ts`
- `apps/server/src/routes/__tests__/sessions-boundary.test.ts`
- `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts` (has the `query()` mock pattern)

**Data Flow (what tests need to exercise):**

```
Test: FakeAgentRuntime.sendMessage()
      ↓
SDKMessage async generator (provided by scenario builder)
      ↓
sdk-event-mapper.ts (converts SDKMessage → StreamEvent)
      ↓
Express /api/sessions/:id/messages route (SSE emission)
      ↓
supertest SSE collection (buffer + parse)
      ↓
Assertion on StreamEvent sequence
```

**Data Flow — Three Tiers:**

```
TIER 1: Unit (Vitest only)
  wrapSdkQuery → mocks query() → SDKMessage async generator
                                  ↓
                          sdk-event-mapper.ts
                                  ↓
                           StreamEvent assertions
  Tests: mapper correctness, runtime internals

TIER 2: Integration (Vitest + supertest)
  FakeAgentRuntime → StreamEvent async generator → Express route
                                                       ↓
                                               SSE emission
                                                       ↓
                                         supertest buffer+parse
                                                       ↓
                                       StreamEvent[] assertions
  Tests: route logic, SSE delivery, session management, locking

TIER 3: Browser (Playwright)
  TestModeRuntime (live server process) → StreamEvent async generator
                                              ↓
                                       Express route (real)
                                              ↓
                                        SSE over HTTP (real)
                                              ↓
                                       React client (real browser)
                                              ↓
                               DOM / visual assertions
  Tests: UI rendering, streaming UX, client state, React components
```

**Blast Radius:**

| Area   | Files                                                              | Change                                                  |
| ------ | ------------------------------------------------------------------ | ------------------------------------------------------- |
| New    | `packages/test-utils/src/sdk-scenarios.ts`                         | SDKMessage scenario builders + `wrapSdkQuery`           |
| New    | `packages/test-utils/src/fake-agent-runtime.ts`                    | `FakeAgentRuntime` class (Vitest, uses `vi.fn()`)       |
| New    | `packages/test-utils/src/sse-test-helpers.ts`                      | `collectSseEvents` supertest helper                     |
| Update | `packages/test-utils/src/index.ts`                                 | Export new utilities                                    |
| Update | `packages/test-utils/src/__tests__/`                               | Tests for new utilities                                 |
| New    | `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts` | `TestModeRuntime` (no `vi.fn()`, for live server)       |
| New    | `apps/server/src/services/runtimes/test-mode/scenario-store.ts`    | In-memory scenario store, control API                   |
| Update | `apps/server/src/index.ts`                                         | Check `DORKOS_TEST_RUNTIME`, register `TestModeRuntime` |
| Update | `apps/server/src/routes/__tests__/sessions*.test.ts`               | Replace duplicated `mockRuntime`                        |
| Update | `apps/server/src/services/runtimes/claude-code/__tests__/`         | Use shared scenario builders                            |
| New    | `apps/server/src/routes/__tests__/sessions-streaming.test.ts`      | SSE integration tests                                   |

---

## 4) Root Cause Analysis

N/A — This is new infrastructure, not a bug fix.

---

## 5) Research

Research saved to: `research/20260311_agent_sdk_simulation_testing.md`

### Why JSONL Replay Doesn't Work Directly

Real JSONL files at `~/.claude/projects/` contain **completed** messages in the SDK's storage format. The `query()` async generator yields **incremental streaming chunks** (`SDKMessage` objects — `content_block_delta`, `message_start`, etc.) — a structurally different format. To replay JSONL as streaming simulation, you'd need to:

1. Parse the completed `message.content[]` blocks
2. Synthetically re-chunk them into streaming `SDKMessage` events
3. Feed those through `sdk-event-mapper.ts`

This reconstruction isn't authentic (you're simulating chunks from complete data), adds file I/O, and requires a completely new translation layer that nothing in the codebase currently provides. `transcript-reader.ts` converts JSONL → parsed messages for the API; it does not produce SDKMessage streaming format.

**Conclusion:** JSONL replay is a valuable future layer for regression testing client rendering, but programmatic scenarios are the right foundation.

### Potential Solutions

**1. Programmatic SDKMessage Scenario Builders (Primary)**

Extract the `async function*` pattern from `claude-code-runtime.test.ts` into `@dorkos/test-utils`. Build named scenario factories from typed primitive builders:

```typescript
// packages/test-utils/src/sdk-scenarios.ts
export function sdkSimpleText(text: string): () => AsyncIterable<SDKMessage>;
export function sdkToolCall(
  toolName: string,
  input: object,
  result: string
): () => AsyncIterable<SDKMessage>;
export function sdkTodoWrite(tasks: TaskInput[]): () => AsyncIterable<SDKMessage>;
export function sdkError(message: string): () => AsyncIterable<SDKMessage>;
export function wrapSdkQuery(scenario: () => AsyncIterable<SDKMessage>): MockedFunction;
```

- **Pros:** Zero latency (< 1ms), zero new dependencies, TypeScript-typed against `SDKMessage` union, composable, tests `sdk-event-mapper.ts` in the pipeline
- **Cons:** Hand-crafted scenarios can drift from real SDK behavior (TypeScript catches structural drift; semantic drift requires vigilance)
- **Complexity:** Low
- **Maintenance:** Low — TypeScript enforces correctness on SDK upgrades

**2. FakeAgentRuntime Class (Complementary)**

A single `FakeAgentRuntime` class that `implements AgentRuntime` with `vi.fn()` spies on all methods and a proper `async function*` `sendMessage` accepting scenario generators:

```typescript
// packages/test-utils/src/fake-agent-runtime.ts
export class FakeAgentRuntime implements AgentRuntime {
  sendMessage = vi.fn(async function*(id, content, opts) {
    yield* this._scenario();
  });
  ensureSession = vi.fn();
  // ... all 15+ methods with vi.fn() defaults

  withScenario(scenario: () => AsyncIterable<StreamEvent>): this { ... }
}
```

- **Pros:** Eliminates 50-line duplication across 4+ test files, TypeScript-enforced interface contract, single source of truth
- **Complexity:** Low
- **Maintenance:** Low (TypeScript error on AgentRuntime changes)

**Note:** `FakeAgentRuntime.sendMessage` operates at the **StreamEvent level** (after the mapper), because the runtime's public interface is `AsyncGenerator<StreamEvent>`. The `wrapSdkQuery` function operates at the **SDKMessage level** (inside the runtime, mocking `query()` directly). Both are needed:

- `wrapSdkQuery` → for testing `sdk-event-mapper.ts` + runtime internals
- `FakeAgentRuntime` → for testing Express routes + session management + SSE delivery

**3. SSE Integration Test Pattern (Complementary)**

Promote the `supertest` SSE buffer/parse pattern from `sessions.test.ts` into a shared test helper:

```typescript
// packages/test-utils/src/sse-test-helpers.ts
export async function collectSseEvents(
  app: Express,
  sessionId: string,
  content: string
): Promise<StreamEvent[]>;
```

- **Complexity:** Low
- **Value:** High — enables full route-level integration tests with zero browser or network overhead

**4. TestModeRuntime — Live Server Simulation for Browser Tests**

A separate runtime implementation (not using any Vitest APIs) that runs inside the real Express server process, registered when `DORKOS_TEST_RUNTIME=true`. Playwright browser tests start the server in this mode and interact with a fully real HTTP+SSE stack — only the Claude API call is replaced.

```typescript
// apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts
export class TestModeRuntime implements AgentRuntime {
  // sendMessage() yields StreamEvents from the currently-loaded scenario
  async *sendMessage(id, content, opts): AsyncGenerator<StreamEvent> {
    const scenario = scenarioStore.getScenario(id) ?? scenarioStore.getDefault();
    yield* scenario(content);
  }
  // All other methods return sensible no-op defaults (no vi.fn())
}
```

```typescript
// apps/server/src/services/runtimes/test-mode/scenario-store.ts
// In-memory store that maps session IDs to scenario functions.
// Optionally: a control endpoint (POST /api/test/scenario) lets Playwright
// tests configure which scenario fires next without restarting the server.
export const scenarioStore = {
  setDefault(scenario: ScenarioFn): void,
  setForSession(sessionId: string, scenario: ScenarioFn): void,
  getScenario(sessionId: string): ScenarioFn | undefined,
  getDefault(): ScenarioFn,
};
```

**Key difference from `FakeAgentRuntime`:** `TestModeRuntime` operates at the **StreamEvent level** (it implements `AgentRuntime` directly) rather than the SDKMessage level. This is correct for browser tests — the mapper is already covered by Tier 1 Vitest tests; browser tests care about what the client renders, not about SDK internals.

**Scenario format for browser tests:**

```typescript
// Scenarios are simple async generators of StreamEvent — no SDK types needed
const simpleTextScenario: ScenarioFn = async function* (content: string) {
  yield { type: 'session_status', data: { sessionId: '...', model: 'claude-haiku-4-5' } };
  yield { type: 'text_delta', data: { text: 'Hello! ' } };
  yield { type: 'text_delta', data: { text: 'This is a simulated response.' } };
  yield { type: 'done', data: { sessionId: '...' } };
};
```

**Playwright test integration:**

```typescript
// In Playwright test setup (apps/e2e/src/fixtures/mock-runtime.ts)
import { test as base } from '@playwright/test';

export const test = base.extend({
  mockRuntime: async ({ request }, use) => {
    // Configure the TestModeRuntime scenario before navigating
    await request.post('http://localhost:4242/api/test/scenario', {
      data: { name: 'simpleText', text: 'Hello from mock!' },
    });
    await use(undefined);
  },
});

// In a browser test:
test('chat renders streamed response', async ({ page, mockRuntime }) => {
  await page.goto('http://localhost:4241/');
  // type and send a message → TestModeRuntime fires scenario → SSE → React renders
  await page.getByRole('textbox').fill('Say hello');
  await page.keyboard.press('Meta+Enter');
  await expect(page.getByText('Hello from mock!')).toBeVisible();
});
```

- **Pros:** Full-stack browser testing with zero Claude API cost, zero latency. The real Express routes, SSE transport, and React client all run. Deterministic — same scenario fires every time.
- **Cons:** Requires a control API endpoint (`/api/test/scenario`) that must be protected or disabled in production. `TestModeRuntime` is a second implementation to maintain alongside `FakeAgentRuntime`.
- **Complexity:** Medium
- **Maintenance:** Low-Medium

**5. JSONL Fixture Replay (Future)**

A separate tool that reads JSONL transcripts and emits StreamEvents for client rendering regression tests. Requires a new translation layer. Not part of this spec — deferred.

### Recommendation

**Complete approach:** All four tiers together form a coherent testing pyramid:

| Tier        | Tool                                    | Tests                                    |
| ----------- | --------------------------------------- | ---------------------------------------- |
| Unit        | `wrapSdkQuery` + SDKMessage scenarios   | `sdk-event-mapper.ts`, runtime internals |
| Integration | `FakeAgentRuntime` + `collectSseEvents` | Express routes, SSE delivery, locking    |
| Browser     | `TestModeRuntime` + Playwright          | UI rendering, streaming UX, React client |

**Test coverage unlocked:**

1. **Unit**: `sdk-event-mapper.ts` in isolation — does the mapper produce the right StreamEvents?
2. **Service**: `claude-code-runtime.ts` full flow — does the runtime handle tool approvals, session locking?
3. **Route/Integration**: Express routes + SSE — does the route emit the right events in the right order?
4. **Browser**: React client rendering — does the UI render code blocks, tool call cards, task lists correctly?

---

## 6) Decisions

| #   | Decision                    | Choice                                                                                    | Rationale                                                                                                                                                                                                                                                                  |
| --- | --------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | JSONL fixture replay        | Defer to phase 2                                                                          | No existing translation layer from JSONL → SDKMessage format. The two formats are structurally incompatible without a new conversion layer. Programmatic scenarios deliver zero latency and type safety immediately.                                                       |
| 2   | FakeAgentRuntime scope      | Full AgentRuntime implementation                                                          | Eliminates 50-line duplicated mockRuntime across 4+ test files. TypeScript enforces the contract — if AgentRuntime grows new methods, tests fail to compile rather than silently pass.                                                                                     |
| 3   | Simulation level            | Both: SDKMessage (`wrapSdkQuery`) for Vitest, StreamEvent (`TestModeRuntime`) for browser | `wrapSdkQuery` tests the full pipeline including `sdk-event-mapper.ts`. `TestModeRuntime` operates at StreamEvent level — correct for browser tests which care about UI rendering, not SDK internals.                                                                      |
| 4   | Browser test support        | TestModeRuntime + Playwright (Option A)                                                   | Enables zero-latency browser tests of the full React client against a live server. No Claude API calls, no flakiness from real streaming latency. Requires a test-only control endpoint gated by `DORKOS_TEST_RUNTIME`.                                                    |
| 5   | SDK type location           | Co-locate with claude-code service                                                        | `wrapSdkQuery` + SDKMessage scenario builders live in `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` — within the existing ESLint import boundary. `packages/test-utils/` gets only `FakeAgentRuntime` (StreamEvent level, no SDK dependency). |
| 6   | JSONL in FakeAgentRuntime   | No — `watchSession()` is a no-op `vi.fn()`                                                | Tests configure `getMessageHistory()` directly. No file I/O in tests — fully in-memory, zero latency. The session broadcaster is bypassed entirely.                                                                                                                        |
| 7   | Multi-turn support          | Scenario queue — `withScenarios([s1, s2, s3])`                                            | FakeAgentRuntime keeps an internal queue and dequeues the next scenario on each `sendMessage()` call. Covers single-turn (one scenario) and multi-turn (array) with the same API.                                                                                          |
| 8   | Test file migration         | Include in this spec                                                                      | If `FakeAgentRuntime` ships but existing tests don't use it, it's dead infrastructure. Migration is mechanical and immediately validates the new pattern at scale.                                                                                                         |
| 9   | Control endpoint security   | Gate at route registration                                                                | `createApp()` only mounts `/api/test/*` routes when `DORKOS_TEST_RUNTIME=true`. Routes don't exist in production — no handler, no code path.                                                                                                                               |
| 10  | Browser test server startup | Playwright `webServer` config                                                             | `apps/e2e/playwright.config.ts` starts the server with `DORKOS_TEST_RUNTIME=true` before tests and stops it after. Standard Playwright pattern — automatic, config in one place.                                                                                           |
| 11  | Scenario naming             | Shared constants in `packages/test-utils`                                                 | `TestScenario` enum in `packages/test-utils/src/test-scenarios.ts` imported by both `TestModeRuntime` and Playwright test files. TypeScript errors on rename — no string-coordination bugs.                                                                                |

---

## 7) SDK Type Reference

> **Source:** Inspected from `node_modules/@anthropic-ai/claude-agent-sdk` type definitions and existing mock patterns in `claude-code-runtime.test.ts`. This section is the authoritative reference for writing typed scenario builders.

### The `query()` Call

```typescript
import { query, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';

// Returns an async iterable WITH stub methods attached (not a plain AsyncGenerator)
const agentQuery = query({ prompt: string, options: Options });

// CRITICAL: query() result has these additional methods beyond [Symbol.asyncIterator]:
agentQuery.supportedModels(); // called by claude-code-runtime to populate model list
agentQuery.setPermissionMode(); // called by claude-code-runtime to set permission mode
```

**Implication for simulation:** `mockQueryResult()` must wrap every async generator with `vi.fn()` stubs for `supportedModels` and `setPermissionMode`. This is already done in `claude-code-runtime.test.ts` — the pattern must be extracted into the shared helper.

### `SDKMessage` Discriminated Union

The full union of types that `query()` yields:

```typescript
// 1. system/init — REQUIRED FIRST — emits session_status StreamEvent
{
  type: 'system';
  subtype: 'init';
  session_id: string;
  model: string;
  permissionMode: 'default' | 'bypassPermissions' | 'plan' | 'acceptEdits';
  tools: [];
  mcp_servers: [];
  slash_commands: [];
  output_style: string;
  skills: [];
  plugins: [];
  cwd: string;
  apiKeySource: string;
  uuid: string;
}

// 2. stream_event/content_block_delta (text) — emits text_delta StreamEvent
{
  type: 'stream_event';
  event: {
    type: 'content_block_delta';
    index: number;
    delta: { type: 'text_delta'; text: string };
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

// 3. stream_event/content_block_start (tool_use) — emits tool_call_start StreamEvent
{
  type: 'stream_event';
  event: {
    type: 'content_block_start';
    index: number;
    content_block: {
      type: 'tool_use';
      id: string;   // toolCallId
      name: string; // toolName
      input: object;
    };
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

// 4. stream_event/content_block_delta (input_json) — emits tool_call_delta StreamEvent
{
  type: 'stream_event';
  event: {
    type: 'content_block_delta';
    index: number;
    delta: { type: 'input_json_delta'; partial_json: string };
  };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

// 5. stream_event/content_block_stop — emits tool_call_end StreamEvent
{
  type: 'stream_event';
  event: { type: 'content_block_stop'; index: number };
  parent_tool_use_id: string | null;
  session_id: string;
  uuid: string;
}

// 6. tool_use_summary — emits task_update StreamEvent (via TodoWrite)
{
  type: 'tool_use_summary';
  summary: string;
  preceding_tool_use_ids: string[];
}

// 7. result/success — REQUIRED LAST — emits session_status + done StreamEvents
{
  type: 'result';
  subtype: 'success' | 'error';
  duration_ms: number;
  duration_api_ms: number;
  is_error: boolean;
  num_turns: number;
  result: string;
  stop_reason: string;
  total_cost_usd: number;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
  };
  modelUsage: Record<string, Record<string, unknown>>;
  permission_denials: unknown[];
  session_id: string;
  uuid: string;
}
```

### The `mockQueryResult()` Pattern (from `claude-code-runtime.test.ts`)

This is the **exact pattern** to extract into `packages/test-utils/src/sdk-scenarios.ts`:

```typescript
// EXISTING pattern in claude-code-runtime.test.ts — to be promoted to test-utils:

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ query: vi.fn() }));

function mockQueryResult(gen: AsyncGenerator<SDKMessage>) {
  return Object.assign(gen, {
    supportedModels: vi.fn().mockResolvedValue([]),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  });
}

// Usage:
mockedQuery.mockReturnValue(
  mockQueryResult((async function* () {
    yield { type: 'system', subtype: 'init', session_id: 'test-id', model: 'claude-haiku', ... };
    yield { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } }, session_id: 'test-id', ... };
    yield { type: 'result', subtype: 'success', total_cost_usd: 0.001, usage: {...}, ... };
  })())
);
```

### Mapper Behavior (what the SDK type reference implies)

`sdk-event-mapper.ts` is **type-agnostic** — it pattern-matches on `message.type`, `event.type`, and `delta.type` fields. As long as scenario builder objects have the correct discriminant fields, the mapper processes them identically to real SDK output. No minimum field count is enforced beyond what the mapper's conditional logic accesses.

### Options Interface (for reference)

```typescript
interface Options {
  cwd: string;
  includePartialMessages: boolean;
  settingSources: string[];
  systemPrompt: { type: 'preset'; preset: 'claude_code'; append: string };
  pathToClaudeCodeExecutable?: string;
  resume?: string; // SDK session ID for multi-turn
  permissionMode: 'default' | 'bypassPermissions' | 'plan' | 'acceptEdits';
  allowDangerouslySkipPermissions?: boolean;
  model?: string;
  mcpServers?: Record<string, McpServerConfig>;
  allowedTools?: string[];
  canUseTool?: (toolName: string) => Promise<boolean | PermissionResult>;
}
```

---

## 8) Final Architecture Summary

All questions resolved. The complete design is captured in section 6.

**File manifest for the spec:**

```
New files:
  packages/test-utils/src/fake-agent-runtime.ts     — FakeAgentRuntime (Vitest, vi.fn())
  packages/test-utils/src/sse-test-helpers.ts        — collectSseEvents() supertest helper
  packages/test-utils/src/test-scenarios.ts          — TestScenario enum (shared constants)
  apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts
                                                     — wrapSdkQuery + SDKMessage builders
  apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts
                                                     — TestModeRuntime (live server, no vi.fn())
  apps/server/src/services/runtimes/test-mode/scenario-store.ts
                                                     — in-memory scenario store
  apps/server/src/routes/__tests__/sessions-streaming.test.ts
                                                     — new SSE integration tests

Modified files:
  packages/test-utils/src/index.ts                  — export FakeAgentRuntime, helpers, enum
  apps/server/src/index.ts                           — register TestModeRuntime when env=true
  apps/server/src/app.ts (or routes/index.ts)        — mount /api/test/* when env=true
  apps/server/src/routes/__tests__/sessions.test.ts         — replace mockRuntime
  apps/server/src/routes/__tests__/sessions-interactive.test.ts — replace mockRuntime
  apps/server/src/routes/__tests__/sessions-relay.test.ts   — replace mockRuntime
  apps/server/src/routes/__tests__/sessions-boundary.test.ts — replace mockRuntime
  apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts
                                                     — use shared sdk-scenarios.ts
  apps/e2e/playwright.config.ts                      — add webServer with DORKOS_TEST_RUNTIME=true
```
