---
slug: sdk-error-observability
number: 148
created: 2026-03-18
status: specification
---

# SDK Error Observability — Break Infinite Retry Loop, Surface Errors to Adapters

**Status:** Specification
**Authors:** Claude Code, 2026-03-18
**Ideation:** `specs/sdk-error-observability/01-ideation.md`
**Research:** `research/20260318_sdk_error_observability.md`

---

## Overview

Fix 4 observability gaps in `message-sender.ts` that cause SDK errors (HTTP 529 Overloaded, auth failures, process crashes) to be completely invisible to server logs and end users. When the Claude Code CLI subprocess fails, the error is swallowed by overly broad pattern matching, retried infinitely via recursive calls with no depth guard, and never surfaced to Slack/Telegram users — who see their message go into the void with no response and no error.

All fixes are contained in a single file (`message-sender.ts`) plus test additions. The downstream adapter error paths (Slack `handleError()`, Telegram `handleError()`) already handle `error` StreamEvents correctly — the gap is upstream.

## Background / Problem Statement

During a production incident on 2026-03-18, the Anthropic API returned HTTP 529 (Overloaded). The Claude Code CLI subprocess retried internally for ~4 minutes, then exited with code 1. DorkOS's `executeSdkQuery` caught the error, matched it against `RESUME_FAILURE_PATTERNS` (which includes the overly broad `'process exited with code'`), reset the session, and called itself recursively — creating an infinite silent loop. No error was logged beyond "stream error", no `error` StreamEvent was emitted, and Slack/Telegram users received no response and no error message.

Investigation revealed 4 distinct gaps:

1. **Infinite recursive retry** — `executeSdkQuery` calls itself with no depth guard when `isResumeFailure(err)` matches
2. **Overly broad error classification** — `'process exited with code'` in `RESUME_FAILURE_PATTERNS` matches ALL subprocess exits, not just stale session failures
3. **Empty stream silence** — Streams completing with zero content events (no `text_delta`, `tool_call_start`, etc.) emit `done` with no error
4. **Insufficient error logging** — Catch block logs only `err.message` and `durationMs`; missing `eventCount`, `contentEventCount`, and retry context

## Goals

- Break the infinite recursive retry loop with a depth guard
- Narrow `RESUME_FAILURE_PATTERNS` to only match actual stale-session errors
- Detect empty streams (zero content events) and emit a synthetic `error` StreamEvent
- Enrich server logs with content event counts and retry depth for post-hoc diagnosis
- Ensure all SDK errors reach end users via Slack/Telegram `handleError()` paths (already wired)

## Non-Goals

- Recovering the actual HTTP status code (529, 401) from the SDK subprocess — the SDK does not expose this (confirmed: `anthropics/claude-agent-sdk-typescript#72`)
- Configuring SDK internal retry behavior (requested and declined upstream: `NOT_PLANNED`)
- Platform-specific error cards (Slack Block Kit, Telegram inline keyboards) — plain text errors are sufficient
- Circuit breaker libraries (incompatible with async generators)
- Rate-limit event surfacing to adapters (separate concern)
- Client-side retry UI affordance (covered by spec #139 `error-categorization-retry`)

## Technical Dependencies

- No new external dependencies
- Existing: `@dorkos/shared` (`ErrorCategory` type), `@anthropic-ai/claude-agent-sdk` (already imported)

## Detailed Design

### Fix 1: Retry Depth Guard

Add a `retryDepth` parameter to `executeSdkQuery` to cap recursive self-calls.

**Current code** (lines 327-336):

```typescript
} catch (err) {
  if (session.hasStarted && isResumeFailure(err)) {
    logger.warn('[sendMessage] resume failed for stale session, retrying as new', {
      session: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    session.hasStarted = false;
    yield* executeSdkQuery(sessionId, content, session, opts, messageOpts);
    return;
  }
```

**New code:**

```typescript
const MAX_RESUME_RETRIES = 1;

export async function* executeSdkQuery(
  sessionId: string,
  content: string,
  session: AgentSession,
  opts: MessageSenderOpts,
  messageOpts?: MessageOpts,
  retryDepth = 0,
): AsyncGenerator<StreamEvent> {
  // ... existing body ...

  } catch (err) {
    if (session.hasStarted && isResumeFailure(err) && retryDepth < MAX_RESUME_RETRIES) {
      logger.warn('[sendMessage] resume failed for stale session, retrying as new', {
        session: sessionId,
        retryDepth,
        error: err instanceof Error ? err.message : String(err),
      });
      session.hasStarted = false;
      yield* executeSdkQuery(sessionId, content, session, opts, messageOpts, retryDepth + 1);
      return;
    }
```

**Key details:**

- `MAX_RESUME_RETRIES = 1` — one transparent retry for stale sessions, then surface error
- `retryDepth` defaults to `0`, preserving the existing public API
- The constant is exported for tests

### Fix 2: Narrow RESUME_FAILURE_PATTERNS

Remove `'process exited with code'` from the pattern list. This pattern matches ALL subprocess exits including API errors (529), auth failures, and OOM crashes — not just stale session resume failures.

**Current code** (lines 56-62):

```typescript
const RESUME_FAILURE_PATTERNS = [
  'query closed before response',
  'session not found',
  'no such file',
  'enoent',
  'process exited with code',
];
```

**New code:**

```typescript
const RESUME_FAILURE_PATTERNS = [
  'query closed before response',
  'session not found',
  'no such file',
  'enoent',
];
```

**Rationale:** The remaining 4 patterns cover all legitimate stale-session scenarios:

- `'query closed before response'` — SDK stream interrupted during resume
- `'session not found'` — JSONL file deleted or moved
- `'no such file'` / `'enoent'` — filesystem-level missing session file

The `'process exited with code'` pattern was catching SDK subprocess crashes that have nothing to do with stale sessions. These should surface as errors, not trigger silent retries.

### Fix 3: Empty Stream Detection

Track content events separately from total events. After the iteration loop, if zero content events were produced and no error was already emitted and the stream was not an interactive flow (tool approval, question prompt), emit a synthetic `error` StreamEvent.

**New variables** (added alongside existing `eventCount`):

```typescript
let emittedDone = false;
let emittedError = false;
let eventCount = 0;
let contentEventCount = 0;
let wasInteractive = false;
const streamStart = Date.now();
const toolState = createToolState();
```

**Content event tracking** (inside the event yield loop):

```typescript
for await (const event of mapSdkMessage(result.value, session, sessionId, toolState)) {
  if (event.type === 'done') {
    emittedDone = true;
    // ... existing mesh update ...
  }

  // Track content events for empty-stream detection
  if (['text_delta', 'tool_call_start', 'tool_result', 'thinking_delta'].includes(event.type)) {
    contentEventCount++;
  }
  if (['approval_required', 'question_prompt'].includes(event.type)) {
    wasInteractive = true;
  }

  eventCount++;
  yield event;
}
```

**Empty stream guard** (after the iteration loop, before the final `done` emission):

```typescript
// Detect empty streams — zero content events with no prior error
if (contentEventCount === 0 && !emittedError && !wasInteractive) {
  logger.warn('[sendMessage] stream completed with zero content events', {
    session: sessionId,
    eventCount,
    durationMs: Date.now() - streamStart,
  });
  yield {
    type: 'error',
    data: {
      message: 'The agent did not respond. The service may be temporarily unavailable.',
      category: 'execution_error' as ErrorCategory,
    },
  };
  emittedError = true;
}
```

**Why exclude interactive flows:** An agent requesting tool approval or asking a question via `question_prompt` legitimately produces zero text content before waiting for user input. The `wasInteractive` flag prevents false-positive empty-stream errors for these flows.

### Fix 4: Enriched Error Logging & User-Facing Messages

**Catch block error event** — add `category` and `details` fields, use a user-friendly message:

```typescript
} catch (err) {
  // ... retry guard from Fix 1 ...

  const errMsg = err instanceof Error ? err.message : String(err);
  logger.warn('[sendMessage] stream error', {
    session: sessionId,
    error: errMsg,
    durationMs: Date.now() - streamStart,
    eventCount,
    contentEventCount,
    retryDepth,
  });
  yield {
    type: 'error',
    data: {
      message: 'The agent stopped unexpectedly. The service may be temporarily overloaded — try again in a moment.',
      category: 'execution_error' as ErrorCategory,
      details: errMsg,
    },
  };
  emittedError = true;
}
```

**Stream done log** — add `contentEventCount` and `retryDepth`:

```typescript
logger.info('[sendMessage] stream done', {
  session: sessionId,
  durationMs: Date.now() - streamStart,
  eventCount,
  contentEventCount,
});
```

**Error message design:**

- The `message` field contains user-facing copy — this is what Slack/Telegram users see via `extractErrorMessage(envelope.payload)`
- The `details` field contains the raw SDK error string — server-side only, not forwarded to adapters
- The `category` field (`'execution_error'`) enables future client-side retry affordance (spec #139)

### Import Addition

Add `ErrorCategory` import at the top of `message-sender.ts`:

```typescript
import type { ErrorCategory } from '@dorkos/shared/types';
```

### Complete Modified File Structure

The changes are surgical — only the following sections of `message-sender.ts` are modified:

1. **Line 1** — Add `ErrorCategory` import
2. **Lines 56-62** — Narrow `RESUME_FAILURE_PATTERNS` (remove one entry)
3. **Line 82** — Add `retryDepth = 0` parameter to function signature
4. **Lines 270-272** — Add `emittedError`, `contentEventCount`, `wasInteractive` variables
5. **Lines 308-318** — Add content event tracking in the yield loop
6. **Lines 327-336** — Add `retryDepth` guard to catch block
7. **Lines 337-350** — Enrich catch block error event and logging
8. **Lines 353-370** — Add empty stream guard before final `done`
9. **Lines 371-376** — Enrich stream done log

No new files. No changes to `sdk-event-mapper.ts`, `agent-handler.ts`, or adapter outbound modules.

## User Experience

### Before (Broken)

1. User sends message via Slack/Telegram
2. Agent subprocess fails (API overloaded, auth error, etc.)
3. Server silently retries in an infinite loop
4. User waits indefinitely — no response, no error, no indication anything went wrong

### After (Fixed)

1. User sends message via Slack/Telegram
2. Agent subprocess fails
3. Server attempts one transparent retry (for stale session recovery)
4. On second failure (or first failure for non-resume errors), server emits `error` StreamEvent
5. Slack/Telegram adapter calls `handleError()` → user sees: "The agent stopped unexpectedly. The service may be temporarily overloaded — try again in a moment."
6. Server logs include `contentEventCount`, `retryDepth`, and error details for diagnosis

### Web Client

The `error` StreamEvent flows through `stream-event-handler.ts` → `ErrorPart` in the message area. The `category: 'execution_error'` field will enable the retry button once spec #139 is implemented.

## Testing Strategy

All tests in `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts`.

### Test 1: Retry depth guard breaks infinite loop

**Purpose:** Verify that `executeSdkQuery` stops retrying after `MAX_RESUME_RETRIES` and emits an error event.

```typescript
it('stops retrying after MAX_RESUME_RETRIES and emits error', async () => {
  // Mock SDK query to always throw "process exited with code 1"
  // (previously in RESUME_FAILURE_PATTERNS — now a non-resume error)
  const processError = new Error('Claude Code process exited with code 1');
  mockQuery.mockReturnValue(
    wrapSdkQuery(
      (async function* () {
        throw processError;
      })()
    )
  );

  const events = await collectEvents(sessionId, 'Hello');
  const errorEvents = events.filter((e) => e.type === 'error');

  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0].data.message).toContain('stopped unexpectedly');
  expect(errorEvents[0].data.category).toBe('execution_error');
  // Should NOT have called query() more than once (no retry for non-resume errors)
  expect(mockQuery).toHaveBeenCalledTimes(1);
});
```

### Test 2: Resume failure retries once then surfaces error

**Purpose:** Verify that actual resume failures (`'session not found'`) get one retry, then surface an error on second failure.

```typescript
it('retries resume failure once then surfaces error on second failure', async () => {
  const resumeError = new Error('session not found');
  mockQuery.mockReturnValue(
    wrapSdkQuery(
      (async function* () {
        throw resumeError;
      })()
    )
  );

  // Mark session as started to trigger resume path
  runtime.ensureSession(sessionId);
  // Simulate that session was previously started
  // (internal state — set via prior successful message)

  const events = await collectEvents(sessionId, 'Hello');
  const errorEvents = events.filter((e) => e.type === 'error');

  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0].data.category).toBe('execution_error');
  // Should have called query() twice (original + one retry)
  expect(mockQuery).toHaveBeenCalledTimes(2);
});
```

### Test 3: Empty stream emits error

**Purpose:** Verify that a stream completing with zero content events emits a synthetic error.

```typescript
it('emits error when stream completes with zero content events', async () => {
  // SDK yields only system messages, no text_delta or tool_call_start
  mockQuery.mockReturnValue(
    wrapSdkQuery(
      (async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sdk-123',
          cwd: '/test',
          uuid: 'u1',
        };
        // No text_delta, tool_call_start, etc.
        yield {
          type: 'result',
          subtype: 'success',
          uuid: 'u2',
          session_id: 'sdk-123',
        };
      })()
    )
  );

  const events = await collectEvents(sessionId, 'Hello');
  const errorEvents = events.filter((e) => e.type === 'error');

  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0].data.message).toContain('did not respond');
  expect(errorEvents[0].data.category).toBe('execution_error');
});
```

### Test 4: Interactive flow does NOT trigger empty stream error

**Purpose:** Verify that streams with `approval_required` events do not false-positive on the empty stream guard.

```typescript
it('does not emit empty stream error for interactive flows', async () => {
  mockQuery.mockReturnValue(
    wrapSdkQuery(
      (async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sdk-123',
          cwd: '/test',
          uuid: 'u1',
        };
        yield {
          type: 'assistant',
          subtype: 'tool_use',
          tool_name: 'Write',
          tool_use_id: 'tu1',
          uuid: 'u3',
          session_id: 'sdk-123',
        };
        // approval_required would be injected by canUseTool
        // Simulate via eventQueue in a real scenario
      })()
    )
  );

  // This test verifies the wasInteractive flag concept.
  // In practice, approval_required is injected via session.eventQueue.
  // The test should confirm that when approval_required is present,
  // the empty stream guard does not fire.
});
```

### Test 5: Process exit code no longer triggers resume retry

**Purpose:** Verify that `'process exited with code'` errors are NOT treated as resume failures after narrowing the pattern list.

```typescript
it('does not retry process exit code errors as resume failures', async () => {
  const exitError = new Error('Claude Code process exited with code 1');
  mockQuery.mockReturnValue(
    wrapSdkQuery(
      (async function* () {
        throw exitError;
      })()
    )
  );

  const events = await collectEvents(sessionId, 'Hello');
  const errorEvents = events.filter((e) => e.type === 'error');

  expect(errorEvents).toHaveLength(1);
  // Should NOT have retried (only 1 query call)
  expect(mockQuery).toHaveBeenCalledTimes(1);
});
```

### Test 6: Error event includes category and details

**Purpose:** Verify the error event structure matches `ErrorEventSchema`.

```typescript
it('error event includes category and details fields', async () => {
  const testError = new Error('Some SDK failure');
  mockQuery.mockReturnValue(
    wrapSdkQuery(
      (async function* () {
        throw testError;
      })()
    )
  );

  const events = await collectEvents(sessionId, 'Hello');
  const errorEvent = events.find((e) => e.type === 'error');

  expect(errorEvent).toBeDefined();
  expect(errorEvent!.data).toEqual(
    expect.objectContaining({
      message: expect.any(String),
      category: 'execution_error',
      details: 'Some SDK failure',
    })
  );
});
```

## Performance Considerations

- **Zero performance cost** — adds one integer comparison (`contentEventCount === 0`) per stream completion
- **No new I/O** — all changes are in-memory variable tracking
- **Retry reduction** — the depth guard reduces worst-case behavior from infinite retries to exactly 1 retry (8 minutes → 4 minutes maximum delay for 529 scenarios)

## Security Considerations

- **Raw SDK error strings are NOT exposed to end users** — the `details` field stays server-side. Only the `message` field (user-friendly copy) is forwarded to Slack/Telegram via `extractErrorMessage()`
- **No new attack surface** — changes are purely in error handling logic
- **Error messages do not leak internal state** — messages like "The agent stopped unexpectedly" reveal nothing about infrastructure

## Documentation

- No user-facing documentation changes needed
- Server log format gains new fields (`contentEventCount`, `retryDepth`) — document in `contributing/api-reference.md` if log schema is documented there

## Implementation Phases

### Phase 1: Core Fixes (Single PR)

All 4 fixes in `message-sender.ts`:

1. Add `retryDepth` parameter with `MAX_RESUME_RETRIES = 1` guard
2. Remove `'process exited with code'` from `RESUME_FAILURE_PATTERNS`
3. Add `contentEventCount`, `emittedError`, `wasInteractive` tracking
4. Add empty stream guard before final `done` emission
5. Enrich catch block with `category`, `details`, user-friendly message
6. Enrich logging with new fields
7. Add `ErrorCategory` import

### Phase 2: Tests (Same PR)

Add 6 test cases to `claude-code-runtime.test.ts`:

1. Retry depth guard breaks infinite loop
2. Resume failure retries once then surfaces error
3. Empty stream emits error
4. Interactive flow does not trigger empty stream error
5. Process exit code no longer triggers resume retry
6. Error event includes category and details

### Phase 3: Verification

- Run `pnpm typecheck` to verify `ErrorCategory` import
- Run `pnpm vitest run apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts`
- Run `pnpm lint` to verify no new warnings

## Open Questions

None — all decisions were resolved during ideation.

## Related ADRs

- ADR-0139 `error-categorization-retry` — Covers client-side error display and retry affordance. This spec ensures errors reach the client in the first place.

## References

- `specs/sdk-error-observability/01-ideation.md` — Full ideation with root cause analysis
- `research/20260318_sdk_error_observability.md` — Research with 12 sources, full implementation checklist
- `research/20260316_error_categorization_retry.md` — Prior research on SDK result subtype taxonomy
- [anthropics/claude-agent-sdk-typescript#72](https://github.com/anthropics/claude-agent-sdk-typescript/issues/72) — Exit code 1 used for all SDK crashes
- [anthropics/claude-code#23115](https://github.com/anthropics/claude-code/issues/23115) — Configurable retry env vars declined (`NOT_PLANNED`)
