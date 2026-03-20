---
slug: agent-sdk-simulation-testing
number: 123
created: 2026-03-11
status: draft
---

# Agent SDK Simulation & Testing Infrastructure

**Status:** Draft
**Authors:** Claude Code — 2026-03-11
**Spec:** `specs/agent-sdk-simulation-testing/`

---

## Overview

Build a three-tier test simulation infrastructure that eliminates all real Claude API calls from DorkOS tests. Each tier targets a different layer of the stack: SDKMessage (unit), StreamEvent/Express (integration), and browser (Playwright). The result is zero-latency, fully deterministic tests that run in CI without any Anthropic API credentials.

---

## Background / Problem Statement

Three compounding problems motivate this spec:

1. **Test latency**: The `chat:self-test` command requires real Claude responses (15–40 seconds per message). There is no path to fast, automated CI-friendly testing of the full streaming pipeline.

2. **Duplicated mock infrastructure**: A ~35-line `mockRuntime` object (implementing `AgentRuntime`) is copy-pasted across `sessions.test.ts`, `sessions-interactive.test.ts`, `sessions-relay.test.ts`, and `sessions-boundary.test.ts`. When `AgentRuntime` gains new methods, every file must be updated manually — silently passing when the mock is stale.

3. **No browser test support**: Playwright tests cannot run against the real Claude API in CI (cost, latency, flakiness). There is no way to test the React client's rendering of streamed responses without involving the real SDK.

The existing `claude-code-runtime.test.ts` already proves the simulation pattern works — it mocks `query()` with an `async function*` generator and attaches the required `supportedModels`/`setPermissionMode` stub methods. This spec extracts, generalizes, and extends that pattern into shared infrastructure.

---

## Goals

- Zero real Claude API calls in any test — `@anthropic-ai/claude-agent-sdk` is always mocked
- Sub-millisecond test execution for unit and integration tiers
- `FakeAgentRuntime` implements `AgentRuntime` with TypeScript enforcement — compile error if the interface changes and the mock goes stale
- Playwright browser tests can assert on UI rendering of simulated Claude responses without any real API calls
- Eliminate the duplicated `mockRuntime` objects across the 4 session test files
- Shared scenario constants prevent string-coordination bugs between server and browser test layers

## Non-Goals

- Testing Claude model quality or output correctness
- Performance or load testing the Anthropic API
- Relay mode simulation (Relay path uses a different runtime; deferred)
- JSONL fixture replay for client-side regression testing (separate future spec)
- Automatic capture/replay of real SDK responses

---

## Technical Dependencies

| Dependency                       | Version             | Notes                                           |
| -------------------------------- | ------------------- | ----------------------------------------------- |
| `@anthropic-ai/claude-agent-sdk` | Current (workspace) | Mocked in all tests — not called directly       |
| `vitest`                         | Current             | `vi.fn()`, `vi.mock()`, async generator support |
| `supertest`                      | Current             | SSE `buffer(true).parse(...)` integration tests |
| `@playwright/test`               | Current             | Browser tests + `webServer` config              |
| `@dorkos/shared`                 | Workspace           | `AgentRuntime`, `StreamEvent` types             |
| `@dorkos/test-utils`             | Workspace           | Extended with new simulation utilities          |

---

## Detailed Design

### Architecture Overview

```
TIER 1: Vitest Unit (SDKMessage level)
  wrapSdkQuery() + scenario builders
  ↓ (mocks query())
  sdk-event-mapper.ts
  ↓
  StreamEvent assertions
  Tests: mapper correctness, runtime internals

TIER 2: Vitest Integration (StreamEvent level)
  FakeAgentRuntime + collectSseEvents()
  ↓ (implements AgentRuntime)
  Express /api/sessions/:id/messages route
  ↓ SSE
  supertest buffer+parse
  ↓
  StreamEvent[] assertions
  Tests: route logic, SSE delivery, session management, locking

TIER 3: Browser (StreamEvent level, live server)
  TestModeRuntime (live server process)
  ↓ (registered when DORKOS_TEST_RUNTIME=true)
  Express (real)
  ↓ SSE over HTTP (real)
  React client (real browser)
  ↓
  DOM / visual assertions
  Tests: UI rendering, streaming UX, React components
```

---

### Tier 1: SDK Scenario Builders (`sdk-scenarios.ts`)

**File:** `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts`

This file must live within the existing ESLint import boundary that restricts `@anthropic-ai/claude-agent-sdk` imports to `services/runtimes/claude-code/`. It extracts the `mockQueryResult` pattern already present in `claude-code-runtime.test.ts` (line 76-82).

#### `wrapSdkQuery`

The core helper. The real `query()` return value is not just an async iterable — it also has `supportedModels()` and `setPermissionMode()` methods attached. Every scenario must be wrapped:

```typescript
import { vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';

/**
 * Wraps an async generator with the stub methods that the real query() return
 * value exposes. Required because ClaudeCodeRuntime calls supportedModels() and
 * setPermissionMode() on the query result before iterating it.
 */
export function wrapSdkQuery(gen: AsyncGenerator<SDKMessage>) {
  return Object.assign(gen, {
    supportedModels: vi.fn().mockResolvedValue([]),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  });
}
```

#### Named Scenario Builders

Each builder returns an `AsyncGenerator<SDKMessage>` ready to be passed to `wrapSdkQuery`:

```typescript
const SESSION_ID = 'test-session-id';
const BASE_UUID = '00000000-0000-4000-8000-000000000001';

/** System init message — always required as the first yielded message. */
function makeInit(sessionId = SESSION_ID): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model: 'claude-haiku-4-5-20251001',
    permissionMode: 'default',
    tools: [],
    mcp_servers: [],
    slash_commands: [],
    output_style: 'normal',
    skills: [],
    plugins: [],
    cwd: '/mock',
    apiKeySource: 'env',
    uuid: BASE_UUID,
  };
}

/** Result/success message — always required as the last yielded message. */
function makeResult(sessionId = SESSION_ID): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    duration_ms: 100,
    duration_api_ms: 80,
    is_error: false,
    num_turns: 1,
    result: '',
    stop_reason: 'end_turn',
    total_cost_usd: 0.0001,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: sessionId,
    uuid: BASE_UUID,
  };
}

/**
 * Produces a minimal streaming text response.
 *
 * @param text - The assistant response text to stream
 */
export async function* sdkSimpleText(text: string): AsyncGenerator<SDKMessage> {
  yield makeInit();
  yield {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
  yield makeResult();
}

/**
 * Produces a single tool call (start → json delta → stop) followed by text.
 *
 * @param toolName - Tool to simulate (e.g. 'Bash', 'Read')
 * @param input - Tool input object (yielded as partial JSON chunks)
 * @param responseText - Assistant text after the tool call
 */
export async function* sdkToolCall(
  toolName: string,
  input: object,
  responseText: string
): AsyncGenerator<SDKMessage> {
  const toolCallId = 'tool-call-1';
  yield makeInit();
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolCallId, name: toolName, input: {} },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
  yield {
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 1,
      delta: { type: 'text_delta', text: responseText },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
  yield makeResult();
}

/**
 * Produces a TodoWrite tool call followed by a tool_use_summary, simulating
 * task list creation via the task tracking system.
 *
 * @param tasks - Task items to create (id, content, status)
 */
export async function* sdkTodoWrite(
  tasks: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>
): AsyncGenerator<SDKMessage> {
  yield makeInit();
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'todo-write-1', name: 'TodoWrite', input: {} },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
  yield {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify({ todos: tasks }) },
    },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
  yield {
    type: 'stream_event',
    event: { type: 'content_block_stop', index: 0 },
    parent_tool_use_id: null,
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
  yield {
    type: 'tool_use_summary',
    summary: `Created ${tasks.length} task(s)`,
    preceding_tool_use_ids: ['todo-write-1'],
  };
  yield makeResult();
}

/**
 * Produces an error result (subtype: 'error') from the SDK.
 *
 * @param message - Error message text
 */
export async function* sdkError(message: string): AsyncGenerator<SDKMessage> {
  yield makeInit();
  yield {
    type: 'result',
    subtype: 'error',
    duration_ms: 50,
    duration_api_ms: 40,
    is_error: true,
    num_turns: 1,
    result: message,
    stop_reason: 'error',
    total_cost_usd: 0,
    usage: {
      input_tokens: 5,
      output_tokens: 0,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    session_id: SESSION_ID,
    uuid: BASE_UUID,
  };
}
```

**Usage in `claude-code-runtime.test.ts`:**

```typescript
import { wrapSdkQuery, sdkSimpleText } from './sdk-scenarios.js';

// Before (extracted from existing test):
mockedQuery.mockReturnValue(wrapSdkQuery(sdkSimpleText('Hello, world!')));
```

---

### Tier 2: `FakeAgentRuntime` (`packages/test-utils`)

#### `TestScenario` Enum

**File:** `packages/test-utils/src/test-scenarios.ts`

Named scenario keys shared between `TestModeRuntime` (server), Playwright tests (browser), and Vitest tests:

```typescript
/**
 * Named scenario keys for the DorkOS test simulation infrastructure.
 * Used by FakeAgentRuntime (Vitest) and TestModeRuntime (browser) to load
 * pre-defined StreamEvent sequences without string coordination.
 *
 * @module test-utils/test-scenarios
 */
export const TestScenario = {
  /** Simple text response: session_status → text_delta → done */
  SimpleText: 'simple-text',
  /** Response with a single Bash tool call */
  ToolCall: 'tool-call',
  /** TodoWrite tool call creating 3 tasks, then a text response */
  TodoWrite: 'todo-write',
  /** Error result from the SDK */
  Error: 'error',
  /** Multi-turn: first call returns text, second returns a tool call */
  MultiTurn: 'multi-turn',
} as const;

export type TestScenarioKey = (typeof TestScenario)[keyof typeof TestScenario];
```

#### `FakeAgentRuntime`

**File:** `packages/test-utils/src/fake-agent-runtime.ts`

A class that `implements AgentRuntime` with `vi.fn()` spies on all methods. Because it uses `implements`, TypeScript produces a compile error if `AgentRuntime` gains new methods without the fake being updated — this is the core value proposition over a hand-crafted object.

````typescript
import { vi } from 'vitest';
import type { AgentRuntime, StreamEvent } from '@dorkos/shared/agent-runtime';

type ScenarioFn = (content: string) => AsyncGenerator<StreamEvent>;

/**
 * A full implementation of AgentRuntime for use in Vitest tests.
 *
 * All methods are vi.fn() spies. sendMessage() yields StreamEvents from a
 * scenario queue loaded via withScenarios(). watchSession() is a no-op
 * vi.fn() — tests configure message history via getMessageHistory() directly.
 *
 * @example
 * ```typescript
 * const runtime = new FakeAgentRuntime();
 * runtime.withScenarios([simpleTextScenario]);
 * vi.mocked(runtimeRegistry.getDefault).mockReturnValue(runtime);
 * ```
 */
export class FakeAgentRuntime implements AgentRuntime {
  readonly type = 'fake' as const;

  private _scenarios: ScenarioFn[] = [];
  private _scenarioIndex = 0;

  /**
   * Load an ordered list of scenarios. Each sendMessage() call dequeues
   * the next scenario. Supports single-turn (one scenario) and multi-turn
   * (array of scenarios) with the same API.
   */
  withScenarios(scenarios: ScenarioFn[]): this {
    this._scenarios = scenarios;
    this._scenarioIndex = 0;
    return this;
  }

  // Core send — yields from the next queued scenario
  sendMessage = vi.fn(async function* (
    this: FakeAgentRuntime,
    _sessionId: string,
    content: string
  ): AsyncGenerator<StreamEvent> {
    const scenario = this._scenarios[this._scenarioIndex];
    if (scenario) {
      this._scenarioIndex++;
      yield* scenario(content);
    }
  });

  // Session lifecycle
  ensureSession = vi.fn();
  hasSession = vi.fn<() => boolean>(() => false);
  updateSession = vi.fn<() => boolean>(() => true);
  listSessions = vi.fn().mockResolvedValue([]);
  getSession = vi.fn().mockResolvedValue(null);
  getMessageHistory = vi.fn().mockResolvedValue([]);
  getSessionTasks = vi.fn().mockResolvedValue([]);
  getSessionETag = vi.fn().mockResolvedValue(null);
  readFromOffset = vi.fn().mockResolvedValue({ content: '', newOffset: 0 });

  // Session watching — no-op; tests configure getMessageHistory() directly
  watchSession = vi.fn<() => () => void>(() => () => {});

  // Locking
  acquireLock = vi.fn<() => boolean>(() => true);
  releaseLock = vi.fn();
  isLocked = vi.fn<() => boolean>(() => false);
  getLockInfo = vi.fn();

  // Capabilities and metadata
  getCapabilities = vi.fn(() => ({
    type: 'fake' as const,
    supportsPermissionModes: true,
    supportsToolApproval: true,
    supportsCostTracking: false,
    supportsResume: false,
    supportsMcp: false,
    supportsQuestionPrompt: true,
  }));
  getSupportedModels = vi.fn().mockResolvedValue([]);
  getInternalSessionId = vi.fn();
  getCommands = vi.fn().mockResolvedValue({ commands: [], lastScanned: '' });
  checkSessionHealth = vi.fn();

  // Tool approval
  approveTool = vi.fn();
  submitAnswers = vi.fn().mockReturnValue(true);
}
````

**Usage in migrated session tests:**

```typescript
// BEFORE (sessions-interactive.test.ts) — duplicated 35-line object:
const mockRuntime = vi.hoisted(() => ({
  type: 'claude-code',
  ensureSession: vi.fn(),
  hasSession: vi.fn(() => false),
  // ... 30+ more lines
}));

// AFTER — single import, TypeScript-enforced:
import { FakeAgentRuntime } from '@dorkos/test-utils';

const fakeRuntime = vi.hoisted(() => new FakeAgentRuntime());

vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => fakeRuntime),
    get: vi.fn(() => fakeRuntime),
    getAllCapabilities: vi.fn(() => ({})),
    getDefaultType: vi.fn(() => 'fake'),
  },
}));
```

#### `collectSseEvents` Helper

**File:** `packages/test-utils/src/sse-test-helpers.ts`

Promotes the supertest SSE buffer/parse pattern already present in `sessions.test.ts` into shared infrastructure:

```typescript
import request from 'supertest';
import type { Express } from 'express';
import type { StreamEvent } from '@dorkos/shared/agent-runtime';

/**
 * Sends a message to a session and collects all SSE StreamEvents emitted
 * before the connection closes. Uses supertest's buffer(true) + parse()
 * pattern for synchronous SSE collection in tests.
 *
 * @param app - Express app instance (from createApp())
 * @param sessionId - Target session UUID
 * @param content - User message text to send
 * @returns Ordered array of StreamEvents emitted during the response
 */
export async function collectSseEvents(
  app: Express,
  sessionId: string,
  content: string
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];

  await request(app)
    .post(`/api/sessions/${sessionId}/messages`)
    .set('Accept', 'text/event-stream')
    .send({ content })
    .buffer(true)
    .parse((res, callback) => {
      let buffer = '';
      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              events.push(JSON.parse(line.slice(6)) as StreamEvent);
            } catch {
              // Non-JSON SSE lines (e.g., comments) are silently ignored
            }
          }
        }
      });
      res.on('end', () => callback(null, events));
    });

  return events;
}
```

**Usage in integration tests:**

```typescript
import { FakeAgentRuntime, collectSseEvents } from '@dorkos/test-utils';

it('emits text_delta events for a simple text response', async () => {
  fakeRuntime.withScenarios([simpleTextScenario]);
  fakeRuntime.ensureSession.mockImplementation(() => {});
  fakeRuntime.acquireLock.mockReturnValue(true);

  const events = await collectSseEvents(app, SESSION_ID, 'Hello');

  const textEvents = events.filter((e) => e.type === 'text_delta');
  expect(textEvents.length).toBeGreaterThan(0);
  expect(events.at(-1)?.type).toBe('done');
});
```

#### Barrel Export Update

**File:** `packages/test-utils/src/index.ts` — add to existing exports:

```typescript
export * from './fake-agent-runtime.js';
export * from './sse-test-helpers.js';
export * from './test-scenarios.js';
```

---

### Tier 3: `TestModeRuntime` (Browser Tests)

#### `scenario-store.ts`

**File:** `apps/server/src/services/runtimes/test-mode/scenario-store.ts`

In-memory store for browser test scenarios. No `vi.fn()` — this runs in a real server process:

```typescript
import type { StreamEvent } from '@dorkos/shared/agent-runtime';

export type ScenarioFn = (content: string) => AsyncGenerator<StreamEvent>;

/** Built-in scenarios available without explicit configuration. */
const BUILT_IN_SCENARIOS: Record<string, ScenarioFn> = {
  'simple-text': async function* (content) {
    yield { type: 'session_status', data: { status: 'running', model: 'claude-haiku-4-5' } };
    yield { type: 'text_delta', data: { text: `Echo: ${content}` } };
    yield { type: 'done', data: {} };
  },
  'tool-call': async function* (_content) {
    yield { type: 'session_status', data: { status: 'running', model: 'claude-haiku-4-5' } };
    yield { type: 'tool_call_start', data: { toolCallId: 'tc-1', toolName: 'Bash', input: {} } };
    yield {
      type: 'tool_call_delta',
      data: { toolCallId: 'tc-1', partialJson: '{"command":"echo hi"}' },
    };
    yield { type: 'tool_call_end', data: { toolCallId: 'tc-1' } };
    yield { type: 'text_delta', data: { text: 'Done.' } };
    yield { type: 'done', data: {} };
  },
  'todo-write': async function* (_content) {
    yield { type: 'session_status', data: { status: 'running', model: 'claude-haiku-4-5' } };
    yield {
      type: 'task_update',
      data: {
        tasks: [
          { id: '1', content: 'Task one', status: 'pending' },
          { id: '2', content: 'Task two', status: 'pending' },
          { id: '3', content: 'Task three', status: 'pending' },
        ],
      },
    };
    yield { type: 'text_delta', data: { text: 'Created 3 tasks.' } };
    yield { type: 'done', data: {} };
  },
  error: async function* (_content) {
    yield { type: 'session_status', data: { status: 'running', model: 'claude-haiku-4-5' } };
    yield { type: 'error', data: { message: 'Simulated error from TestModeRuntime' } };
    yield { type: 'done', data: {} };
  },
};

class ScenarioStore {
  private _sessionScenarios = new Map<string, ScenarioFn>();
  private _defaultScenario: ScenarioFn = BUILT_IN_SCENARIOS['simple-text']!;

  setDefault(name: string): void {
    const scenario = BUILT_IN_SCENARIOS[name];
    if (!scenario)
      throw new Error(
        `Unknown scenario: "${name}". Known: ${Object.keys(BUILT_IN_SCENARIOS).join(', ')}`
      );
    this._defaultScenario = scenario;
  }

  setForSession(sessionId: string, name: string): void {
    const scenario = BUILT_IN_SCENARIOS[name];
    if (!scenario) throw new Error(`Unknown scenario: "${name}"`);
    this._sessionScenarios.set(sessionId, scenario);
  }

  getScenario(sessionId: string): ScenarioFn {
    return this._sessionScenarios.get(sessionId) ?? this._defaultScenario;
  }

  clearSession(sessionId: string): void {
    this._sessionScenarios.delete(sessionId);
  }

  reset(): void {
    this._sessionScenarios.clear();
    this._defaultScenario = BUILT_IN_SCENARIOS['simple-text']!;
  }
}

export const scenarioStore = new ScenarioStore();
```

#### `TestModeRuntime`

**File:** `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`

Plain (no `vi.fn()`) `AgentRuntime` implementation for live server use:

```typescript
import type {
  AgentRuntime,
  RuntimeCapabilities,
  SessionOptions,
  StreamEvent,
} from '@dorkos/shared/agent-runtime';
import { scenarioStore } from './scenario-store.js';

/**
 * A zero-latency AgentRuntime that yields StreamEvents from the scenario store.
 * Registered instead of ClaudeCodeRuntime when DORKOS_TEST_RUNTIME=true.
 *
 * Never imported in production — index.ts only imports this module when the
 * env var is set. There is no tree-shaking concern because the condition is
 * evaluated at server startup, not at build time.
 */
export class TestModeRuntime implements AgentRuntime {
  readonly type = 'test-mode' as const;

  private _sessions = new Map<string, SessionOptions>();

  ensureSession(sessionId: string, opts: SessionOptions): void {
    this._sessions.set(sessionId, opts);
  }

  hasSession(sessionId: string): boolean {
    return this._sessions.has(sessionId);
  }

  updateSession(sessionId: string, opts: Partial<SessionOptions>): boolean {
    const existing = this._sessions.get(sessionId);
    if (!existing) return false;
    this._sessions.set(sessionId, { ...existing, ...opts });
    return true;
  }

  async *sendMessage(sessionId: string, content: string): AsyncGenerator<StreamEvent> {
    const scenario = scenarioStore.getScenario(sessionId);
    yield* scenario(content);
  }

  watchSession(_sessionId: string, _callback: () => void): () => void {
    return () => {};
  }

  async listSessions() {
    return [];
  }
  async getSession(_id: string) {
    return null;
  }
  async getMessageHistory(_id: string) {
    return [];
  }
  async getSessionTasks(_id: string) {
    return [];
  }
  async getSessionETag(_id: string) {
    return null;
  }
  async readFromOffset(_id: string, _offset: number) {
    return { content: '', newOffset: 0 };
  }

  acquireLock(_id: string): boolean {
    return true;
  }
  releaseLock(_id: string): void {}
  isLocked(_id: string): boolean {
    return false;
  }
  getLockInfo(_id: string): undefined {
    return undefined;
  }

  getCapabilities(): RuntimeCapabilities {
    return {
      type: 'test-mode',
      supportsPermissionModes: true,
      supportsToolApproval: false,
      supportsCostTracking: false,
      supportsResume: false,
      supportsMcp: false,
      supportsQuestionPrompt: false,
    };
  }

  async getSupportedModels() {
    return [];
  }
  getInternalSessionId(_id: string): undefined {
    return undefined;
  }
  async getCommands() {
    return { commands: [], lastScanned: '' };
  }
  checkSessionHealth(_id: string): void {}
  approveTool(_id: string, _toolCallId: string, _approved: boolean): void {}
  submitAnswers(_id: string, _toolCallId: string, _answers: Record<string, string>): boolean {
    return false;
  }
}
```

#### Control Endpoint

**File:** `apps/server/src/routes/test-control.ts`

```typescript
import { Router } from 'express';
import { z } from 'zod';
import { scenarioStore } from '../services/runtimes/test-mode/scenario-store.js';

/**
 * Control routes for TestModeRuntime. Only mounted when DORKOS_TEST_RUNTIME=true.
 * Returns 404 for any /api/test/* path in production (route not registered).
 */
export const testControlRouter = Router();

const scenarioSchema = z.object({
  name: z.string().min(1),
  sessionId: z.string().uuid().optional(),
});

testControlRouter.post('/scenario', (req, res) => {
  const result = scenarioSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
  }
  const { name, sessionId } = result.data;
  if (sessionId) {
    scenarioStore.setForSession(sessionId, name);
  } else {
    scenarioStore.setDefault(name);
  }
  res.json({ ok: true, scenario: name });
});

testControlRouter.post('/reset', (_req, res) => {
  scenarioStore.reset();
  res.json({ ok: true });
});
```

#### Server Registration

**File:** `apps/server/src/index.ts` — add conditional registration:

```typescript
// Existing (line ~84):
claudeRuntime = new ClaudeCodeRuntime(env.DORKOS_DEFAULT_CWD);
runtimeRegistry.register(claudeRuntime);

// Replace with:
if (env.DORKOS_TEST_RUNTIME) {
  const { TestModeRuntime } = await import('./services/runtimes/test-mode/test-mode-runtime.js');
  runtimeRegistry.register(new TestModeRuntime());
  logger.info('[TestMode] TestModeRuntime registered — no real Claude API calls will be made');
} else {
  claudeRuntime = new ClaudeCodeRuntime(env.DORKOS_DEFAULT_CWD);
  runtimeRegistry.register(claudeRuntime);
}
```

**File:** `apps/server/src/app.ts` — mount test control routes:

```typescript
// In createApp(), after existing route registrations:
if (process.env['DORKOS_TEST_RUNTIME'] === 'true') {
  const { testControlRouter } = await import('./routes/test-control.js');
  app.use('/api/test', testControlRouter);
}
```

**Note:** `env.ts` must also declare `DORKOS_TEST_RUNTIME`:

```typescript
// apps/server/src/env.ts — add:
DORKOS_TEST_RUNTIME: z.string().optional().transform(v => v === 'true'),
```

#### Playwright Configuration

**File:** `apps/e2e/playwright.config.ts` — add `webServer`:

```typescript
export default defineConfig({
  // ... existing config ...
  webServer: {
    command: 'DORKOS_TEST_RUNTIME=true node dist/index.js',
    url: 'http://localhost:4242/api/health',
    reuseExistingServer: !process.env['CI'],
    timeout: 30_000,
  },
});
```

#### Playwright Test Pattern

```typescript
// apps/e2e/src/tests/chat-mock.spec.ts
import { test, expect } from '@playwright/test';
import { TestScenario } from '@dorkos/test-utils';

test.beforeEach(async ({ request }) => {
  // Reset to default scenario before each test
  await request.post('http://localhost:4242/api/test/reset');
});

test('renders streamed text response', async ({ page, request }) => {
  await request.post('http://localhost:4242/api/test/scenario', {
    data: { name: TestScenario.SimpleText },
  });

  await page.goto('http://localhost:4241/');
  await page.getByRole('textbox', { name: 'Message' }).fill('Hello');
  await page.keyboard.press('Meta+Enter');

  await expect(page.getByText(/Echo:/)).toBeVisible({ timeout: 5000 });
});

test('renders tool call card', async ({ page, request }) => {
  await request.post('http://localhost:4242/api/test/scenario', {
    data: { name: TestScenario.ToolCall },
  });

  await page.goto('http://localhost:4241/');
  await page.getByRole('textbox', { name: 'Message' }).fill('Run bash');
  await page.keyboard.press('Meta+Enter');

  await expect(page.getByText('Bash')).toBeVisible({ timeout: 5000 });
});
```

---

### Migration: Replace Duplicated `mockRuntime`

The 4 session test files each contain a ~35-line `mockRuntime` object. Migration pattern (same for all 4):

1. Remove the `mockRuntime` `vi.hoisted()` block
2. Import `FakeAgentRuntime` from `@dorkos/test-utils`
3. Create `fakeRuntime` via `vi.hoisted(() => new FakeAgentRuntime())`
4. Update the `runtimeRegistry` mock to return `fakeRuntime`
5. Where tests customized `mockRuntime.sendMessage`, use `fakeRuntime.withScenarios([...])`

For `claude-code-runtime.test.ts`, the `mockQueryResult()` function (lines 76-82) is replaced by importing `wrapSdkQuery` from `./sdk-scenarios.js`, and the inline `async function*` generators are replaced by calls to `sdkSimpleText`, `sdkToolCall`, etc.

---

## File Manifest

### Files to Create

| File                                                                       | Purpose                                                         |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.ts` | `wrapSdkQuery` + SDKMessage scenario builders                   |
| `packages/test-utils/src/fake-agent-runtime.ts`                            | `FakeAgentRuntime` class (Vitest, uses `vi.fn()`)               |
| `packages/test-utils/src/sse-test-helpers.ts`                              | `collectSseEvents` supertest helper                             |
| `packages/test-utils/src/test-scenarios.ts`                                | `TestScenario` const enum (shared constants)                    |
| `apps/server/src/services/runtimes/test-mode/test-mode-runtime.ts`         | `TestModeRuntime` (live server, no `vi.fn()`)                   |
| `apps/server/src/services/runtimes/test-mode/scenario-store.ts`            | In-memory scenario store                                        |
| `apps/server/src/routes/test-control.ts`                                   | Control endpoint (only mounted when `DORKOS_TEST_RUNTIME=true`) |
| `apps/server/src/routes/__tests__/sessions-streaming.test.ts`              | New SSE integration tests using `collectSseEvents`              |

### Files to Modify

| File                                                                                  | Change                                                        |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/test-utils/src/index.ts`                                                    | Export `FakeAgentRuntime`, `collectSseEvents`, `TestScenario` |
| `apps/server/src/env.ts`                                                              | Add `DORKOS_TEST_RUNTIME` env var declaration                 |
| `apps/server/src/index.ts`                                                            | Conditional `TestModeRuntime` registration                    |
| `apps/server/src/app.ts`                                                              | Mount `/api/test/*` routes when `DORKOS_TEST_RUNTIME=true`    |
| `apps/server/src/routes/__tests__/sessions.test.ts`                                   | Replace `mockRuntime` with `FakeAgentRuntime`                 |
| `apps/server/src/routes/__tests__/sessions-interactive.test.ts`                       | Replace `mockRuntime` with `FakeAgentRuntime`                 |
| `apps/server/src/routes/__tests__/sessions-relay.test.ts`                             | Replace `mockRuntime` with `FakeAgentRuntime`                 |
| `apps/server/src/routes/__tests__/sessions-boundary.test.ts`                          | Replace `mockRuntime` with `FakeAgentRuntime`                 |
| `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts` | Use `wrapSdkQuery` + shared scenario builders                 |
| `apps/e2e/playwright.config.ts`                                                       | Add `webServer` config with `DORKOS_TEST_RUNTIME=true`        |

---

## Testing Strategy

### Unit Tests — SDK Scenario Builders

**File:** `apps/server/src/services/runtimes/claude-code/__tests__/sdk-scenarios.test.ts`

```typescript
describe('sdk-scenarios.ts', () => {
  it('wrapSdkQuery attaches supportedModels and setPermissionMode stubs', async () => {
    // Purpose: verify the query() shape contract — if the stubs are missing,
    // ClaudeCodeRuntime will throw when it calls these methods on the mock.
    const gen = sdkSimpleText('hello');
    const wrapped = wrapSdkQuery(gen);
    expect(typeof wrapped.supportedModels).toBe('function');
    expect(typeof wrapped.setPermissionMode).toBe('function');
    await expect(wrapped.supportedModels()).resolves.toEqual([]);
  });

  it('sdkSimpleText yields init → text_delta → result in order', async () => {
    // Purpose: confirm the mapper receives messages in the required order.
    // init must come first (mapper emits session_status); result must come last (emits done).
    const messages = [];
    for await (const msg of sdkSimpleText('hi')) messages.push(msg);
    expect(messages[0].type).toBe('system');
    expect(messages[0].subtype).toBe('init');
    const delta = messages.find(
      (m) => m.type === 'stream_event' && m.event?.delta?.type === 'text_delta'
    );
    expect(delta).toBeDefined();
    expect(messages.at(-1)?.type).toBe('result');
  });

  it('sdkToolCall yields init → tool_use start/delta/stop → text → result', async () => {
    // Purpose: verify the tool call sequence matches sdk-event-mapper.ts expectations.
    const messages = [];
    for await (const msg of sdkToolCall('Bash', { command: 'echo hi' }, 'done')) messages.push(msg);
    const types = messages.map((m) =>
      m.type === 'stream_event'
        ? `${m.event?.type}/${m.event?.delta?.type ?? m.event?.content_block?.type ?? ''}`
        : m.type
    );
    expect(types).toContain('content_block_start/tool_use');
    expect(types).toContain('content_block_delta/input_json_delta');
    expect(types).toContain('content_block_stop/');
  });

  it('sdkError yields is_error=true result', async () => {
    // Purpose: verify error scenarios produce valid SDKMessage that the mapper
    // processes into an error StreamEvent, not an exception.
    const messages = [];
    for await (const msg of sdkError('oops')) messages.push(msg);
    const result = messages.find((m) => m.type === 'result');
    expect(result?.is_error).toBe(true);
    expect(result?.result).toBe('oops');
  });
});
```

### Unit Tests — `FakeAgentRuntime`

**File:** `packages/test-utils/src/__tests__/fake-agent-runtime.test.ts`

```typescript
describe('FakeAgentRuntime', () => {
  it('implements AgentRuntime — TypeScript enforces this at compile time', () => {
    // Purpose: runtime check that the class can be instantiated without error.
    // The real enforcement is TypeScript: a compile error fires if AgentRuntime
    // adds a new method that FakeAgentRuntime doesn't implement.
    expect(() => new FakeAgentRuntime()).not.toThrow();
  });

  it('sendMessage yields events from the first queued scenario', async () => {
    // Purpose: verify the scenario queue dequeues in order.
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      },
    ]);
    const events: StreamEvent[] = [];
    for await (const e of runtime.sendMessage('s1', 'hello')) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('done');
  });

  it('multi-turn: dequeues next scenario on second sendMessage call', async () => {
    // Purpose: verify withScenarios([s1, s2]) supports multi-turn test flows.
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([
      async function* () {
        yield { type: 'text_delta', data: { text: 'first' } } as StreamEvent;
      },
      async function* () {
        yield { type: 'text_delta', data: { text: 'second' } } as StreamEvent;
      },
    ]);
    const first: StreamEvent[] = [];
    for await (const e of runtime.sendMessage('s1', 'q1')) first.push(e);
    const second: StreamEvent[] = [];
    for await (const e of runtime.sendMessage('s1', 'q2')) second.push(e);
    expect((first[0] as any).data.text).toBe('first');
    expect((second[0] as any).data.text).toBe('second');
  });

  it('sendMessage is a vi.fn() spy — call count is observable', async () => {
    // Purpose: verify test assertions like expect(runtime.sendMessage).toHaveBeenCalledOnce()
    // work correctly — important for route tests that verify message dispatch.
    const runtime = new FakeAgentRuntime();
    runtime.withScenarios([async function* () {}]);
    for await (const _ of runtime.sendMessage('s1', 'x')) {
      /* noop */
    }
    expect(runtime.sendMessage).toHaveBeenCalledOnce();
  });
});
```

### Integration Tests — SSE Streaming

**File:** `apps/server/src/routes/__tests__/sessions-streaming.test.ts`

```typescript
describe('POST /api/sessions/:id/messages (SSE streaming)', () => {
  it('emits session_status → text_delta events → done in order', async () => {
    // Purpose: verify the Express route emits StreamEvents in the correct sequence.
    // This is the key integration test for the SSE pipeline end-to-end.
    fakeRuntime.withScenarios([simpleTextScenario]);
    fakeRuntime.acquireLock.mockReturnValue(true);
    fakeRuntime.ensureSession.mockImplementation(() => {});

    const events = await collectSseEvents(app, SESSION_ID, 'Hello');

    const types = events.map((e) => e.type);
    expect(types).toContain('text_delta');
    expect(types.at(-1)).toBe('done');
  });

  it('emits tool_call_start + tool_call_end for tool use scenarios', async () => {
    // Purpose: verify tool call SSE events are emitted in the correct order,
    // matching what the React client expects to render ToolCallCard components.
    fakeRuntime.withScenarios([toolCallScenario]);
    fakeRuntime.acquireLock.mockReturnValue(true);
    fakeRuntime.ensureSession.mockImplementation(() => {});

    const events = await collectSseEvents(app, SESSION_ID, 'Run a tool');

    const toolStart = events.find((e) => e.type === 'tool_call_start');
    const toolEnd = events.find((e) => e.type === 'tool_call_end');
    expect(toolStart).toBeDefined();
    expect(toolEnd).toBeDefined();
  });

  it('returns 423 when session is locked by another client', async () => {
    // Purpose: regression test for session locking — verifies the 423 status
    // is returned instead of attempting to send a message on a locked session.
    fakeRuntime.acquireLock.mockReturnValue(false);
    fakeRuntime.isLocked.mockReturnValue(true);
    fakeRuntime.ensureSession.mockImplementation(() => {});

    const res = await request(app)
      .post(`/api/sessions/${SESSION_ID}/messages`)
      .set('Accept', 'text/event-stream')
      .send({ content: 'Hello' });

    expect(res.status).toBe(423);
  });
});
```

---

## User Experience

This spec has no direct user-facing impact. The benefits are entirely internal:

- **Developers** can run `pnpm test` in under 30 seconds with full simulation coverage
- **CI** can run all tests (including browser tests) without any Anthropic API key
- **Browser tests** can assert on real React UI behavior: streaming text, tool call cards, task lists — all driven by deterministic mock responses

---

## Performance Considerations

- All tiers produce zero network calls to anthropic.com — no latency beyond async generator iteration
- `FakeAgentRuntime.sendMessage()` yields events synchronously (async generator with no awaits) — complete in microseconds
- `TestModeRuntime` operates identically — no file I/O, no network, only in-memory scenario store
- `collectSseEvents` adds supertest HTTP overhead (~10ms) — acceptable for integration tests

---

## Security Considerations

- The `/api/test/scenario` and `/api/test/reset` endpoints are **not registered** in production. The routes object is only imported and mounted inside the `DORKOS_TEST_RUNTIME=true` branch of `createApp()`. Any request to `/api/test/*` in production returns 404 from the catch-all handler.
- The `TestModeRuntime` module is only imported via a dynamic `import()` inside the env-gated branch of `index.ts`. It does not appear in the production module graph.
- Input validation via Zod on the control endpoint prevents malformed scenario names from reaching the store.

---

## Implementation Phases

### Phase 1: Foundation (Tier 1 + Tier 2 utilities)

1. Create `sdk-scenarios.ts` with `wrapSdkQuery` + all named builders
2. Create `fake-agent-runtime.ts` with `FakeAgentRuntime`
3. Create `sse-test-helpers.ts` with `collectSseEvents`
4. Create `test-scenarios.ts` with `TestScenario` enum
5. Update `packages/test-utils/src/index.ts` barrel
6. Write unit tests for all new utilities

### Phase 2: Migration (Tier 2 integration)

7. Migrate `sessions.test.ts` — replace `mockRuntime` with `FakeAgentRuntime`
8. Migrate `sessions-interactive.test.ts` — replace `mockRuntime`
9. Migrate `sessions-relay.test.ts` — replace `mockRuntime`
10. Migrate `sessions-boundary.test.ts` — replace `mockRuntime`
11. Update `claude-code-runtime.test.ts` — use `wrapSdkQuery` + shared builders
12. Create `sessions-streaming.test.ts` — new SSE integration tests

### Phase 3: Browser Tier

13. Create `scenario-store.ts`
14. Create `test-mode-runtime.ts`
15. Create `test-control.ts` router
16. Update `apps/server/src/env.ts` — add `DORKOS_TEST_RUNTIME`
17. Update `apps/server/src/index.ts` — conditional runtime registration
18. Update `apps/server/src/app.ts` — conditional route mounting
19. Update `apps/e2e/playwright.config.ts` — add `webServer`
20. Create initial Playwright browser tests

---

## Open Questions

None. All decisions resolved during ideation (see `specs/agent-sdk-simulation-testing/01-ideation.md`, Section 6).

---

## Related ADRs

- **ADR-0011** (agent-runtime-abstraction): Established `AgentRuntime` as the abstraction boundary. This spec builds simulation infrastructure at that boundary.
- **ADR-0043** (agent-storage): File-first write-through pattern. `TestModeRuntime` bypasses file I/O entirely — compatible because it only runs in test mode.

---

## Acceptance Criteria

- [ ] All Vitest tests pass with zero network requests to `api.anthropic.com`
- [ ] `FakeAgentRuntime` produces a TypeScript compile error when `AgentRuntime` adds a method it doesn't implement
- [ ] `wrapSdkQuery` output has `supportedModels` and `setPermissionMode` methods attached (unit tested)
- [ ] `sdk-scenarios.ts` builders produce valid `SDKMessage` sequences that `sdk-event-mapper.ts` processes without errors
- [ ] All 4 migrated session test files pass after replacing `mockRuntime` with `FakeAgentRuntime`
- [ ] `TestModeRuntime` module does not appear in the production server bundle (verified by checking that no import exists outside the env-gated branch)
- [ ] `GET /api/test/scenario` returns 404 in production (route not mounted)
- [ ] `POST /api/test/reset` returns 404 in production
- [ ] A Playwright test can send a message and assert the UI renders a simulated response (text visible in DOM) without any real Claude API call
- [ ] `pnpm test -- --run` completes in under 60 seconds (from current ~2+ minutes with real SDK calls skipped)

---

## References

- [`specs/agent-sdk-simulation-testing/01-ideation.md`](./01-ideation.md) — Full ideation with decisions and SDK type reference
- [`contributing/architecture.md`](../../contributing/architecture.md) — Hexagonal architecture, AgentRuntime pattern
- [`packages/shared/src/agent-runtime.ts`](../../packages/shared/src/agent-runtime.ts) — `AgentRuntime` interface (source of truth for `FakeAgentRuntime`)
- [`apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts`](../../apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts) — Existing `mockQueryResult` pattern (lines 76-82)
- [`apps/server/src/routes/__tests__/sessions.test.ts`](../../apps/server/src/routes/__tests__/sessions.test.ts) — Existing supertest SSE pattern
- [Playwright `webServer` docs](https://playwright.dev/docs/test-webserver)
- [Vitest async generators](https://vitest.dev/guide/mocking#mocking-async-generators)
