---
title: 'Agent SDK Simulation Testing: Zero-Latency Integration Test Infrastructure'
date: 2026-03-11
type: implementation
status: active
tags: [testing, agent-sdk, vitest, sse, streaming, async-generator, fixtures, integration]
feature_slug: agent-sdk-simulation-testing
searches_performed: 10
sources_count: 18
---

## Research Summary

DorkOS already has a sophisticated, partially-complete test infrastructure for simulating Agent SDK responses. The existing pattern — mocking the `@anthropic-ai/claude-agent-sdk` `query` function to return a crafted `async function*` generator — is correct, idiomatic, and already proven in `claude-code-runtime.test.ts`. The path forward is to extract the reusable scaffolding from that test file into `packages/test-utils/`, add a `FakeAgentRuntime` class that directly implements `AgentRuntime`, and design a small set of named scenario builders. JSONL fixture replay is worth considering but is secondary to the programmatic approach and should only be layered in later for regression coverage.

## Key Findings

**1. The Existing Pattern is Already the Right Answer**

The codebase already demonstrates the exact pattern needed. In `claude-code-runtime.test.ts`, lines 76-82 define `mockQueryResult()`:

```typescript
function mockQueryResult(gen: AsyncGenerator) {
  return Object.assign(gen, {
    supportedModels: vi.fn().mockResolvedValue([]),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
  });
}
```

And tests create inline async generators:

```typescript
mockReturnValue(mockQueryResult((async function* () {
  yield { type: 'system', subtype: 'init', session_id: 'sdk-session-123', ... };
  yield { type: 'stream_event', event: { type: 'content_block_delta', ... }, ... };
  yield { type: 'result', subtype: 'success', ... };
})()))
```

This pattern is correct, zero-latency, and fully in-process. The gap is that it is duplicated across every test file that needs it and there is no shared scenario library.

**2. SSE Integration Testing via Supertest Already Works**

`sessions.test.ts` proves the full-stack SSE test pattern works in-process with supertest:

```typescript
mockRuntime.sendMessage.mockImplementation(async function* () {
  yield { type: 'text_delta', data: { text: 'Hello world' } };
  yield { type: 'done', data: { sessionId: S1 } };
});
const res = await request(app)
  .post(`/api/sessions/${S1}/messages`)
  .send({ content: 'hi' })
  .buffer(true)
  .parse((res, callback) => {
    /* accumulate chunks */
  });
const parsed = parseSSEResponse(res.body);
```

The `.buffer(true).parse(...)` pattern is the critical piece — it accumulates SSE chunks into a string that `parseSSEResponse()` in `@dorkos/test-utils/sse-helpers` can parse. This test pattern is already working. The `parseSSEResponse` helper already exists in `packages/test-utils/src/sse-helpers.ts`.

**3. Two-Level Simulation Strategy**

Research confirms two distinct levels of simulation are needed:

- **Level 1 — Runtime-level mock** (`mockRuntime.sendMessage` as `async function*`): Used for route/SSE tests (`sessions.test.ts` style). Fast, tests the HTTP layer + SSE encoding. The runtime is a pure `vi.fn()` object.
- **Level 2 — SDK-level mock** (`vi.mock('@anthropic-ai/claude-agent-sdk')`): Used for `ClaudeCodeRuntime` unit tests. Tests the full mapping logic from SDK events → DorkOS `StreamEvent`s. This level verifies `sdk-event-mapper.ts` behavior.

For new "full integration" tests (where you want to exercise everything from `AgentRuntime` through `ClaudeCodeRuntime` through SSE), Level 2 is what's needed — mock the `query` function, instantiate a real `ClaudeCodeRuntime`, and wire it into a real Express app.

**4. FakeAgentRuntime as a Reusable Test Double**

The `mockRuntime` object defined identically in both `sessions.test.ts` and `sessions-interactive.test.ts` is the clearest duplication problem. These are hand-rolled partial stubs with `vi.fn()` for every method. A proper `FakeAgentRuntime` class that implements `AgentRuntime` and holds configurable scenario behavior would:

- Satisfy TypeScript structural typing fully
- Be importable from `@dorkos/test-utils`
- Allow `sendMessage` to be configured with named scenarios
- Eliminate the copy-paste mock object at the top of every test

**5. JSONL Fixture Replay: Valuable but Secondary**

Record-and-replay patterns (Polly.js, nock `nockBack`, VCR) intercept at the HTTP layer. The Claude Agent SDK does not use HTTP — it spawns a child process. JSONL fixture replay would mean parsing the `.jsonl` files from `~/.claude/projects/` and replaying them as async generator yields. This is valid for regression testing against real session shapes, but it adds file I/O dependency and fixture maintenance burden. The recommended sequencing: build programmatic simulation first, layer JSONL fixtures later for specific regression scenarios.

**6. SDK Event Type Map (What to Simulate)**

Based on SDK documentation and `sdk-event-mapper.ts`, the complete set of SDK message types that produce DorkOS events:

| SDK Message                                                                                             | DorkOS StreamEvent                   |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `{ type: 'system', subtype: 'init', model }`                                                            | `session_status`                     |
| `{ type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } }` | `tool_call_start`                    |
| `{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta' } } }`       | `text_delta`                         |
| `{ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta' } } }` | `tool_call_delta`                    |
| `{ type: 'stream_event', event: { type: 'content_block_stop' } }`                                       | `tool_call_end`                      |
| `{ type: 'result', subtype: 'success' }`                                                                | `done`                               |
| `{ type: 'result', subtype: 'error_*' }`                                                                | `error` then `done`                  |
| `{ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite' }] } }`                | `task_update` (via `buildTaskEvent`) |

## Detailed Analysis

### Approach 1: Programmatic Scenario Builders (Recommended)

Create a `createSdkScenario()` factory in `@dorkos/test-utils` that returns an `async function*` generator yielding a preset sequence of SDK messages. Scenarios are named constants:

```typescript
// packages/test-utils/src/sdk-scenarios.ts

export function sdkSimpleText(text: string, sessionId = 'sdk-sim-1') {
  return (async function* (): AsyncGenerator<SDKMessage> {
    yield sdkInitMessage(sessionId);
    yield sdkTextDelta(text, sessionId);
    yield sdkResultSuccess(sessionId);
  })();
}

export function sdkToolCall(
  toolName: string,
  toolInput: Record<string, unknown>,
  sessionId = 'sdk-sim-1'
) {
  return (async function* (): AsyncGenerator<SDKMessage> {
    yield sdkInitMessage(sessionId);
    yield sdkContentBlockStart(toolName, 'tc-1', sessionId);
    yield sdkInputJsonDelta(JSON.stringify(toolInput), sessionId);
    yield sdkContentBlockStop(sessionId);
    yield sdkResultSuccess(sessionId);
  })();
}

export function sdkError(message: string, sessionId = 'sdk-sim-1') {
  return (async function* (): AsyncGenerator<SDKMessage> {
    throw new Error(message);
  })();
}
```

Each primitive (e.g., `sdkInitMessage`, `sdkTextDelta`) is a pure builder function that produces the minimum required fields. This is the pattern `claude-code-runtime.test.ts` uses inline — extracting to a shared library makes it reusable.

**Pros:**

- Zero latency (synchronous generator, no I/O)
- Fully deterministic and CI-compatible
- Type-checked against actual `SDKMessage` union
- Follows the exact pattern already established in the codebase
- No new dependencies
- Composable: scenarios can call each other

**Cons:**

- Scenarios are hand-crafted and may diverge from real SDK shapes as the SDK evolves
- Does not catch "schema drift" unless tests are run against the real SDK periodically

**Complexity:** Low
**Maintenance:** Low-Medium

---

### Approach 2: FakeAgentRuntime Class (Recommended, complementary to Approach 1)

Instead of the copy-pasted `mockRuntime` object in every test file, create a `FakeAgentRuntime` class in `@dorkos/test-utils` that implements `AgentRuntime`:

```typescript
// packages/test-utils/src/fake-agent-runtime.ts

export class FakeAgentRuntime implements AgentRuntime {
  readonly type = 'fake';
  private _sendMessageImpl: (sessionId: string, content: string) => AsyncGenerator<StreamEvent>;

  constructor(
    opts: {
      sendMessage?: (sessionId: string, content: string) => AsyncGenerator<StreamEvent>;
    } = {}
  ) {
    this._sendMessageImpl = opts.sendMessage ?? defaultEmptyResponse;
  }

  ensureSession = vi.fn();
  hasSession = vi.fn(() => false);
  updateSession = vi.fn(() => true);

  async *sendMessage(sessionId: string, content: string): AsyncGenerator<StreamEvent> {
    yield* this._sendMessageImpl(sessionId, content);
  }

  // ... all other methods as vi.fn() with sensible defaults ...
  acquireLock = vi.fn(() => true);
  releaseLock = vi.fn();
  isLocked = vi.fn(() => false);
  getLockInfo = vi.fn(() => null);
  getInternalSessionId = vi.fn(() => undefined);
  getCapabilities = vi.fn(() => defaultCapabilities);
  // etc.
}
```

Usage in route tests:

```typescript
const fakeRuntime = new FakeAgentRuntime({
  sendMessage: async function* () {
    yield { type: 'text_delta', data: { text: 'Hello' } };
    yield { type: 'done', data: { sessionId: S1 } };
  },
});
vi.mocked(runtimeRegistry.getDefault).mockReturnValue(fakeRuntime);
```

**Pros:**

- Eliminates the ~50-line `mockRuntime` object repeated across multiple test files
- TypeScript enforces full interface satisfaction — no drift from `AgentRuntime` contract
- Can be configured per-test with `sendMessage` scenarios
- Clean `vi.fn()` spies are still available for assertion

**Cons:**

- Slightly more overhead than a plain `vi.fn()` object
- Needs to be kept in sync when `AgentRuntime` interface changes (but TypeScript will catch this at compile time)

**Complexity:** Low
**Maintenance:** Low (TypeScript-enforced)

---

### Approach 3: JSONL Fixture Replay (Secondary / Later)

Read real JSONL files from `~/.claude/projects/` (or committed test fixtures), parse them as `SDKMessage` arrays, and replay them as async generators:

```typescript
// packages/test-utils/src/fixture-replay.ts

export async function* replayFixture(fixturePath: string): AsyncGenerator<SDKMessage> {
  const lines = (await readFile(fixturePath, 'utf-8')).split('\n').filter(Boolean);
  for (const line of lines) {
    const entry = JSON.parse(line);
    if (entry.type === 'assistant' || entry.type === 'user' || /* etc */) {
      yield entry as SDKMessage;
    }
  }
}
```

Real JSONL files have a different shape than raw `SDKMessage` objects — each line is a transcript entry (e.g., `{ type: 'assistant', message: { ... } }`) which maps roughly to `SDKAssistantMessage`. The translation layer needs care.

**Pros:**

- Tests against authentic real-world event sequences (captured from actual Claude sessions)
- Catches schema drift automatically if fixtures are regenerated from new SDK versions
- High confidence: if replay passes, the real SDK will too
- Enables regression testing for specific bug-inducing sequences

**Cons:**

- Fixtures require file I/O (slight overhead, but still sub-millisecond with small files)
- Fixtures need to be committed to the repo or generated at test time from `~/.claude/projects/`
- JSONL transcript format and raw `SDKMessage` format are not identical — needs a translation layer
- Fixtures go stale as SDK evolves; requires a "re-record" workflow
- The Claude Agent SDK spawns a subprocess; JSONL files are what that subprocess writes, not what `query()` yields directly

**Complexity:** Medium-High
**Maintenance:** Medium

---

### Approach 4: HTTP-layer mocking (nock / Polly.js) — NOT Applicable

Tools like nock, Polly.js, and MSW intercept at the HTTP layer. The Claude Agent SDK does not use HTTP — it spawns a `claude` CLI subprocess that communicates via stdin/stdout. These tools are irrelevant for this use case.

---

### Full-Stack SSE Test Pattern (How to Wire Level 2)

For a test that exercises `ClaudeCodeRuntime` → Express route → SSE encoding → parsed events:

```typescript
// routes/__tests__/sessions-streaming.test.ts

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
// ... other necessary mocks (context-builder, tool-filter, boundary, relay-state, etc.) ...

import { query } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeRuntime } from '../../services/runtimes/claude-code/claude-code-runtime.js';
import { createApp } from '../../app.js';
import request from 'supertest';
import { parseSSEResponse } from '@dorkos/test-utils/sse-helpers';
import { sdkSimpleText, mockQueryResult } from '@dorkos/test-utils/sdk-scenarios';

// Wire a real ClaudeCodeRuntime into a real Express app
vi.mock('../../services/core/runtime-registry.js', () => ({
  runtimeRegistry: {
    getDefault: vi.fn(() => new ClaudeCodeRuntime()),
    // ...
  },
}));

it('streams text_delta and done events for a simple text response', async () => {
  vi.mocked(query).mockReturnValue(mockQueryResult(sdkSimpleText('Hello from Claude', S1)));

  const res = await request(app)
    .post(`/api/sessions/${S1}/messages`)
    .send({ content: 'hi' })
    .buffer(true)
    .parse(accumulateChunks);

  const events = parseSSEResponse(res.body);
  expect(events.find((e) => e.type === 'text_delta')?.data).toEqual({ text: 'Hello from Claude' });
  expect(events.find((e) => e.type === 'done')).toBeDefined();
});
```

The key insight is that `ClaudeCodeRuntime` needs several mocks to be in place (`boundary`, `context-builder`, `tool-filter`, `relay-state`, `pulse-state`, `config-manager`, `manifest`) — all of which are already established in `claude-code-runtime.test.ts`. These should be extracted into a shared test setup module.

### Scenario Design: Key Scenarios to Cover

| Scenario          | SDK Events                                                                                                | Purpose                        |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `sdkSimpleText`   | init → text_delta(s) → result:success                                                                     | Basic text streaming           |
| `sdkToolCall`     | init → content_block_start(tool) → input_json_delta → content_block_stop → result:success                 | Tool use path                  |
| `sdkTodoWrite`    | init → content_block_start(TodoWrite) → input_json_delta(todo JSON) → content_block_stop → result:success | Task update UI                 |
| `sdkMultiTurn`    | init → text_delta → result → [next turn] → ...                                                            | Multi-turn conversation        |
| `sdkErrorRuntime` | throws immediately                                                                                        | SDK process failure            |
| `sdkErrorResult`  | init → result:error_during_execution                                                                      | SDK reports error in result    |
| `sdkStaleResume`  | throws 'Query closed before response received'                                                            | Resume retry path              |
| `sdkLongStream`   | init → 100x text_delta → result:success                                                                   | Backpressure / large responses |

### Fixture Organization

If JSONL fixtures are added later:

```
apps/server/src/services/runtimes/claude-code/__tests__/fixtures/
  simple-text-response.jsonl      # Single text response, no tools
  tool-call-read.jsonl            # Read tool call
  todo-write-sequence.jsonl       # TodoWrite + task update
  multi-turn-conversation.jsonl   # 3-turn conversation
  error-max-turns.jsonl           # error_max_turns result subtype
```

These should be committed fixtures, not generated at test time. A `scripts/capture-fixture.ts` helper can automate capture from real sessions. Version them alongside the SDK version that generated them.

## Sources & Evidence

- DorkOS codebase: `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts` — proves the `async function*` + `mockQueryResult` pattern
- DorkOS codebase: `apps/server/src/routes/__tests__/sessions.test.ts` — proves the supertest SSE streaming test pattern with `.buffer(true).parse()`
- DorkOS codebase: `packages/test-utils/src/sse-helpers.ts` — `parseSSEResponse` and `mockStreamGenerator` already exist
- DorkOS codebase: `packages/shared/src/agent-runtime.ts` — full `AgentRuntime` interface
- DorkOS codebase: `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — shows which SDK message types produce which `StreamEvent` types
- [Claude Agent SDK TypeScript Reference](https://platform.claude.com/docs/en/agent-sdk/typescript) — complete `SDKMessage` union type with all subtypes
- [Netflix/pollyjs](https://github.com/Netflix/pollyjs) — HTTP record/replay (not applicable to subprocess-based SDK)
- [nock/nock](https://github.com/nock/nock) — HTTP mocking (not applicable)
- [SSE Testing Tips — dipsy.me](https://dipsy.me/posts/sse-tips-and-tricks/) — confirms supertest doesn't natively support SSE streaming; recommends the buffer/parse approach
- [Mocking OpenAI — bakkenbaeck.com](https://bakkenbaeck.com/tech/mocking-openai) — confirms queue-based async mock pattern for AI streaming APIs

## Research Gaps & Limitations

- The exact structure of `~/.claude/projects/` JSONL entries vs. raw `SDKMessage` types was not fully mapped. This translation layer would need careful implementation if JSONL fixture replay is pursued.
- The `mockQueryResult` function in tests attaches `supportedModels` and `setPermissionMode` — but the real `Query` interface (as documented) has many more methods (`interrupt`, `rewindFiles`, `initializationResult`, etc.). A complete `mockQueryResult` should stub all of them.
- Test coverage for `watchSession` (the SSE long-poll path at `GET /api/sessions/:id/stream`) is not addressed in this research.

## Contradictions & Disputes

- Some external resources (dipsy.me) say "supertest doesn't support SSE." The DorkOS codebase proves this wrong for the in-process use case: `supertest` works fine with `.buffer(true).parse(accumulate)` when the server and test run in the same process. The limitation only applies to long-lived persistent SSE connections where the server never closes the stream.

## Recommendation

### Recommended Approach: Programmatic Scenarios + FakeAgentRuntime

**Step 1:** Extract `mockQueryResult` from `claude-code-runtime.test.ts` into `packages/test-utils/src/sdk-scenarios.ts`. Rename to `wrapSdkQuery` and make it return a properly typed `Query` stub.

**Step 2:** Add primitive builders (`sdkInitMessage`, `sdkTextDelta`, `sdkResultSuccess`, etc.) to the same file. These are the building blocks for named scenarios.

**Step 3:** Add named scenario functions (`sdkSimpleText`, `sdkToolCall`, `sdkTodoWrite`, `sdkError`) that compose the primitives.

**Step 4:** Add `FakeAgentRuntime` class to `packages/test-utils/src/fake-agent-runtime.ts`. This replaces the copy-pasted `mockRuntime` objects in route tests.

**Step 5 (later):** Add JSONL fixture replay support as an optional layer for regression coverage.

**Rationale:** This approach has essentially zero new infrastructure cost — it formalizes patterns already proven in the test suite. The `async function*` pattern for mocking the SDK `query()` call is the canonical approach in TypeScript for testing AsyncGenerator-based streaming. The only work is extraction and naming.

**Caveats:** SDK schema drift is a real risk. When `@anthropic-ai/claude-agent-sdk` releases updates, the `SDKMessage` union type may change. All scenario builders should be typed against `SDKMessage` from the SDK package, so TypeScript will catch mismatches at compile time. A CI step that runs the test suite against the latest SDK version on a weekly cadence would close the gap.

## Search Methodology

- Searches performed: 10
- Most productive search terms: "supertest SSE streaming express vitest", "async generator fake iterator testing TypeScript vitest", "claude-agent-sdk TypeScript query function", platform.claude.com SDK docs
- Primary information sources: DorkOS codebase (most authoritative), official Anthropic SDK docs, targeted blog posts on SSE testing patterns
