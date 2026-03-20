---
title: 'SDK Error Observability — Child Process Errors, Circuit Breakers, Empty Stream Detection, Adapter Surfacing'
date: 2026-03-18
type: implementation
status: active
tags:
  [
    error-handling,
    observability,
    circuit-breaker,
    retry,
    child-process,
    streaming,
    slack,
    telegram,
    sdk,
    529,
    overloaded,
  ]
feature_slug: sdk-error-observability
searches_performed: 10
sources_count: 18
---

# SDK Error Observability

## Research Summary

Four distinct observability gaps allow SDK errors (including HTTP 529 Overloaded) to silently disappear
between the Claude Code CLI subprocess and end users on Slack/Telegram. Source reading of the actual
codebase reveals the precise failure points: (1) `message-sender.ts` has a recursive retry that can loop
infinitely on "process exited with code 1" because `isResumeFailure()` matches that pattern; (2) the
event loop in `executeSdkQuery` emits no log or error event when zero content events are yielded before
`done`; (3) the Slack/Telegram adapters in `outbound.ts` only surface errors if an `error` StreamEvent
arrives — they have no fallback for empty streams; (4) the existing `mapErrorCategory()` in
`sdk-event-mapper.ts` handles SDK `result` subtypes correctly but does not classify the catch-block
errors in `message-sender.ts`. The recommended solution is a layered approach: add a retry depth guard
to break the recursion, classify errors before retrying vs surfacing, add an empty-stream sentinel to
`executeSdkQuery`, and thread `error` StreamEvents through the adapter path when zero content was
produced.

---

## Codebase State (Source-Verified, 2026-03-18)

### What Is Already Working

**`sdk-event-mapper.ts` — SDK result error mapping is correct and complete.**

Lines 14-28: `mapErrorCategory()` maps all four SDK `result` subtypes to `ErrorCategory`:

- `error_max_turns` → `max_turns`
- `error_during_execution` → `execution_error`
- `error_max_budget_usd` → `budget_exceeded`
- `error_max_structured_output_retries` → `output_format_error`

Lines 350-392: The `result` handler correctly emits `session_status`, then conditionally emits
`error` with `category` and `details`, then always emits `done`. This path is fully wired.

**`packages/relay/src/adapters/slack/outbound.ts` — `error` StreamEvent delivery is wired.**

Lines 681-696: `handleError()` is called when `extractErrorMessage(envelope.payload)` returns a value.
It correctly appends an `[Error: ...]` suffix to any accumulated text and finalizes the stream. The
Telegram adapter has a parallel implementation in `telegram/outbound.ts`.

**`message-sender.ts` — Resume failure detection is wired.**

Lines 56-69: `isResumeFailure()` detects stale session errors and retries as a new session. The
self-heal from `session not found` / `enoent` / `query closed before response` works correctly.

### What Is NOT Working

**Gap 1: Recursive retry has no depth guard — can loop infinitely.**

`message-sender.ts` lines 327-336:

```typescript
if (session.hasStarted && isResumeFailure(err)) {
  session.hasStarted = false;
  yield * executeSdkQuery(sessionId, content, session, opts, messageOpts);
  return;
}
```

`RESUME_FAILURE_PATTERNS` (lines 56-62) includes `'process exited with code 1'`. When HTTP 529
causes the Claude CLI subprocess to exhaust its internal retries and exit with code 1, this pattern
matches. The code resets `hasStarted = false` and recurses. On the next call, the new session also
exits with code 1 (the API is still overloaded), matches again, and loops. There is no recursion
depth counter, no exponential backoff, and no max-retry limit. The loop continues until the SSE
connection times out or the caller aborts, generating no log entries that would identify the 529 as
the root cause.

**Gap 2: Server logs show "stream error" but never the HTTP 529 root cause.**

Lines 337-343 emit a `logger.warn('[sendMessage] stream error', ...)` but only with
`err.message` which is "Claude Code process exited with code 1" — not the underlying HTTP error.
The 529 happens inside the CLI subprocess and is written to the subprocess's stderr, which the SDK
does not pipe back to the parent process error object. The parent only receives the generic exit code.

**Gap 3: Empty stream produces silent success.**

Lines 269-364 of `message-sender.ts`: `eventCount` is tracked but there is no guard. When a stream
ends with zero `text_delta` events (e.g. because the API rejected the session before any content was
generated), the code reaches line 353 (`logger.info('[sendMessage] stream done')`), logs the empty
run, and emits a synthetic `done` at line 360. From the adapter's perspective, the agent "responded"
with nothing. Slack/Telegram users see no message. The stream is silently discarded.

**Gap 4: Adapter error path requires an `error` StreamEvent — never fires on empty stream.**

`agent-handler.ts` (the Claude Code Adapter) iterates over `eventStream` and publishes each event
to the relay. If no `error` StreamEvent is ever emitted (because the error manifested as an exit
code rather than an SDK result subtype), the adapter publishes zero events, the `done` event is
published, and the outbound Slack/Telegram adapter calls `handleDone()` which finds no accumulated
text and returns success without posting anything. The user receives no response — not even an error
message.

---

## Problem 1: Child Process Error Propagation

### The Root Cause

The Claude Code CLI is a Node.js subprocess managed by the Claude Agent SDK. When it encounters
HTTP 529 (Overloaded), it retries internally for approximately 4 minutes using its own built-in
retry logic. After exhausting retries, it exits with code 1. The SDK converts this into:

```
Error: Claude Code process exited with code 1
```

This has been confirmed by direct examination of the SDK source and by a GitHub issue
(anthropics/claude-agent-sdk-typescript#72) where a commenter noted: "Claude Code exits with code 1
no matter what. That's the only exception it throws... There are like, one million more reasons."

### Approaches

**Approach A: Pattern-match the error message to distinguish restart vs API failure (Current Partial Approach)**

Extend `RESUME_FAILURE_PATTERNS` to be split into two lists: `RESUME_PATTERNS` (errors that should
trigger a new-session retry) and `TRANSIENT_PATTERNS` (errors that should surface to the user with
a retry suggestion). Keep "process exited with code 1" only in `TRANSIENT_PATTERNS`.

Pros:

- Minimal code change — reorganize existing constants
- Immediately breaks the infinite loop

Cons:

- "process exited with code 1" currently means BOTH stale session AND HTTP 529. By removing it from
  `RESUME_PATTERNS`, stale sessions that happen to exit with code 1 (rather than "session not found")
  would no longer self-heal. The remaining patterns (`query closed before response`, `enoent`,
  `session not found`) still cover the majority of stale session cases.
- Does not recover the root cause (529 vs OOM vs other)

**Recommendation for Gap 2 (partial):** Move `'process exited with code 1'` out of `RESUME_FAILURE_PATTERNS`
and into a new `TRANSIENT_API_FAILURE_PATTERNS` list. Errors matching `TRANSIENT_API_FAILURE_PATTERNS`
yield an `error` StreamEvent with `category: 'execution_error'` and a user-facing message: "The AI
service stopped unexpectedly. This may be due to high load — try again in a moment."

**Approach B: Log the subprocess stderr before the error is thrown**

The SDK does not expose subprocess stderr in the thrown Error object. However, a workaround is to
read the Claude JSONL transcript file (which the SDK writes before crashing) and look for error
markers. The JSONL may contain an `SDKResultMessage` with `subtype: 'error_during_execution'` and
`errors: ['529 Overloaded']` if the SDK managed to write it before the process crashed.

Pros:

- Could recover the actual HTTP error code
- Already have the transcript reader (`TranscriptReader`)

Cons:

- Race condition: the JSONL may not be written if the process crashed before completing the result
  message
- Adds I/O in the error handling path
- Brittle: depends on internal SDK JSONL format

**Not recommended** as the primary approach. Could serve as an optional diagnostic enhancement.

**Approach C: Intercept stderr from the Claude CLI process (SDK customization)**

The Claude Agent SDK accepts `pathToClaudeCodeExecutable`, which is used in `sdkOptions`. If
DorkOS wrapped the Claude CLI in a shell script that captures stderr and appends it to a known
log location, the parent could read that log on error.

Pros:

- Recovers the actual error reason

Cons:

- Complex platform-specific shell scripting
- Fragile: SDK may change how it invokes the CLI
- Not worth the maintenance burden for this diagnostic enhancement

**Not recommended.**

---

## Problem 2: Recursive Retry / Circuit Breaker

### The Root Cause

`executeSdkQuery` calls itself recursively with no depth limit when `isResumeFailure(err)` is true.
The pattern `'process exited with code 1'` matches all generic SDK crashes, including API overload.

### Approaches

**Approach A: Retry Depth Parameter (Recommended)**

Add an optional `retryDepth: number` parameter to `executeSdkQuery`. Default to 0. Only allow
the recursive self-call when `retryDepth < MAX_RESUME_RETRIES` (e.g. 1 or 2). On exhaustion,
fall through to the existing warn + error-event path.

```typescript
const MAX_RESUME_RETRIES = 2;

export async function* executeSdkQuery(
  sessionId: string,
  content: string,
  session: AgentSession,
  opts: MessageSenderOpts,
  messageOpts?: MessageOpts,
  retryDepth = 0,  // NEW
): AsyncGenerator<StreamEvent> {
  // ...

  if (session.hasStarted && isResumeFailure(err) && retryDepth < MAX_RESUME_RETRIES) {
    logger.warn('[sendMessage] resume failed, retrying as new session', {
      session: sessionId,
      retryDepth,
      error: err instanceof Error ? err.message : String(err),
    });
    session.hasStarted = false;
    yield* executeSdkQuery(sessionId, content, session, opts, messageOpts, retryDepth + 1);
    return;
  }
  // Fall through to error event
```

Pros:

- Minimal change — one parameter, one guard condition
- Preserves the self-healing stale-session behavior for `retryDepth < MAX_RESUME_RETRIES`
- Breaks the infinite loop unconditionally on exhaustion
- Logs the retry depth for observability
- No external dependency

Cons:

- Still retries a 529 up to `MAX_RESUME_RETRIES` times before surfacing (acceptable — 2 retries
  is better than infinity)
- Does not add backoff delay between retries

Complexity: Very low. 4-line change.

**Approach B: Session-Level Retry State (Prevents retry storm across multiple calls)**

Track a `retryCount` in the `AgentSession` struct. Reset on success. Block retry if count exceeds
threshold. This prevents rapid user re-submits from each triggering their own retry chains.

Pros:

- Covers concurrent-call scenario
- State persists across multiple sends to the same session

Cons:

- Adds mutable state to `AgentSession`
- Session-level counter may prevent legitimate retries in a later healthy request
- More complex than the parameter approach

**Not recommended** for the initial fix. Approach A is sufficient.

**Approach C: Circuit Breaker Library (Opossum)**

Use `opossum` npm package to wrap the SDK `query()` call with a full circuit breaker: closed → open
→ half-open states with configurable `errorThresholdPercentage` and `resetTimeout`.

Pros:

- Industry-standard pattern
- Half-open state probes service health automatically
- Emits events (open, close, halfOpen) that can be logged

Cons:

- Opossum wraps a Promise-returning function, not an async generator. The SDK `query()` returns
  an async iterable, not a Promise. Adapting requires collecting all events into a Promise, losing
  streaming. This is a fundamental incompatibility.
- Additional dependency
- Overkill for a single-process embedded SDK where the "circuit" is the entire Claude API

**Not recommended** due to the async-generator incompatibility.

**Recommendation for Problem 2:**

Approach A: Add `retryDepth` parameter. Set `MAX_RESUME_RETRIES = 1` (one retry for stale session,
immediate error on the second failure). On retry-limit exhaustion, yield:

```typescript
yield {
  type: 'error',
  data: {
    message: 'The agent process stopped unexpectedly. The API may be temporarily overloaded.',
    category: 'execution_error' as ErrorCategory,
    details: err instanceof Error ? err.message : String(err),
  },
};
```

This reaches the client, the Slack/Telegram adapter (via `handleError()`), and the server log.

---

## Problem 3: Empty / Silent Stream Detection

### The Root Cause

`executeSdkQuery` tracks `eventCount` (total events including `session_status`, `done`, etc.) but
not `contentEventCount` (events that represent actual agent output: `text_delta`, `tool_call_start`,
`tool_result`). When the SDK yields only `session_status` + `done` with no content, the agent
appeared to have responded but produced nothing visible.

### Approaches

**Approach A: Content Event Counter + Empty Stream Error (Recommended)**

Add a `contentEventCount` counter alongside `eventCount`. Increment on `text_delta`,
`tool_call_start`, `tool_result`, `thinking_delta`, `system_status`. After the iteration loop,
if `contentEventCount === 0` and no error was already emitted (check `emittedError` flag), yield
an error event:

```typescript
let contentEventCount = 0;
// In the event yield loop:
if (['text_delta', 'tool_call_start', 'tool_result', 'thinking_delta'].includes(event.type)) {
  contentEventCount++;
}

// After loop, before final done:
if (contentEventCount === 0 && !emittedError) {
  logger.warn('[sendMessage] stream completed with zero content events', {
    session: sessionId,
    eventCount,
    durationMs: Date.now() - streamStart,
  });
  yield {
    type: 'error',
    data: {
      message: 'The agent did not respond. The API may be temporarily unavailable.',
      category: 'execution_error' as ErrorCategory,
    },
  };
}
```

Pros:

- Turns a silent failure into an observable error
- The error reaches the client inline (via `ErrorPart` path from existing `stream-event-handler.ts`)
- The error reaches Slack/Telegram adapters via `handleError()` in their outbound modules
- Minimal code change
- The `logger.warn` gives server-side observability even before the client path is wired

Cons:

- Does not explain WHY the stream was empty (still opaque at the root cause level)
- Tool-approval sessions legitimately yield zero text content before waiting for approval — need
  to exclude `approval_required` and `question_prompt` from the "empty" definition, OR only check
  for emptiness after a `done` event (not after `approval_required`)

**Implementation note:** Add `emittedError` boolean flag, set to `true` whenever an `error` event
is yielded (both in the catch block and in the empty-stream guard). This prevents double-emitting
an error if the catch also fires.

**Approach B: Minimum Latency Guard**

Only flag empty streams if the session completed within an unreasonably short time (< 500ms),
treating it as a sign the SDK process crashed immediately. Longer durations suggest the SDK ran
the full 4-minute retry cycle (529 scenario).

Pros:

- Potentially distinguishes "crashed immediately" from "ran out of options after retries"

Cons:

- Arbitrary threshold — the SDK's internal retry duration varies
- Tool-use sessions can legitimately complete quickly (< 500ms)
- Wrong axis: time is not the right signal; content is

**Not recommended.**

**Approach C: Subscribe to SDK Process Events**

Since the SDK uses a subprocess, you could potentially intercept the subprocess's `exit` event
before the SDK wraps it, and check whether any `SDKMessage` has been emitted. This is not possible
without modifying the SDK internals.

**Not feasible.**

**Recommendation for Problem 3:**

Approach A: Count content events. Add `emittedError` flag. After `done`, if `contentEventCount === 0`
and `!emittedError` and the stream was not a tool-approval flow (check: no `approval_required` or
`question_prompt` event was yielded), yield the empty-stream `error` event with `category: 'execution_error'`.

---

## Problem 4: Error Surfacing to Slack / Telegram Adapters

### Current State

The Slack adapter's `outbound.ts` `handleError()` function IS correctly wired to render error
messages to users. The gap is upstream: `error` StreamEvents only reach the adapter path when the
SDK explicitly emits them. When the error manifests as a silent exit code or an empty stream,
no `error` StreamEvent is published, so `handleError()` is never called.

Fixes for Problems 2 and 3 (yielding `error` StreamEvents from `executeSdkQuery`) will
automatically fix this problem — the events will flow through `agent-handler.ts` and be published
via `publishResponseWithCorrelation()` which the Slack/Telegram outbound modules consume.

### Current Error Message Format

`handleError()` in Slack posts: `[Error: {errorMsg}]` appended to any accumulated text, or as a
standalone message if the stream had no content. This is technically correct but not user-friendly.

The `errorMsg` comes from `extractErrorMessage(envelope.payload)` which reads the `data.message`
field from the StreamEvent. Once Problem 2 and 3 fixes produce well-formed error events, the
`message` field will contain the user-facing string.

### Approaches for Error Message Quality

**Approach A: Category-Aware Message in the Error StreamEvent (Recommended)**

When yielding error events from `executeSdkQuery` (catch block and empty-stream guard), set the
`message` field to a user-friendly string rather than the raw SDK error string:

| Scenario                                             | `message` for Slack/Telegram                                                                         |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `process exited with code 1` (after retry exhausted) | "The agent stopped unexpectedly. The service may be temporarily overloaded — try again in a minute." |
| Empty stream (zero content)                          | "The agent didn't respond. The service may be temporarily unavailable."                              |
| `boundary violation`                                 | "The request was rejected — the agent's working directory is outside allowed bounds."                |
| Auth / billing error (detected via keyword)          | "Authentication failed. Check your API key configuration."                                           |

These messages are set in `executeSdkQuery` before yielding the error event, not in the adapter.
This keeps the message logic close to the source of the error.

Pros:

- Single source of truth for user-facing copy
- Both the web UI (via `ErrorMessageBlock`) and adapter platforms (Slack/Telegram) receive the
  same message
- No adapter-specific logic needed

Cons:

- The message must be general enough to work in plain text (Slack/Telegram don't render React)
- Cannot show a "Retry" button in Slack/Telegram — the error must be actionable through text alone

**Approach B: Error Category Routing in the Slack/Telegram Outbound Modules**

Have `handleError()` in the outbound modules read the `category` field from the envelope payload
and render category-specific messages (matching the copy table in `20260316_error_categorization_retry.md`).

Pros:

- Adapters can use platform-native formatting (Slack Block Kit, Telegram inline keyboards)
- Categories could trigger different Slack message structures (a Block Kit error card vs. plain text)

Cons:

- Duplicates copy logic in multiple adapters (Slack, Telegram, future adapters)
- The `category` field is only available for SDK result subtypes — not for catch-block errors
  unless the error event explicitly carries it (which Approach A does)
- Over-engineering: plain text error messages are sufficient for Slack/Telegram in V1

**Not recommended** for V1. Consider for a later enhancement when platform-specific error cards
are prioritized.

**Approach C: Rate-Limit Specific Messaging ("Try Again in X Seconds")**

If the SDK emits a `rate_limit` StreamEvent (documented in `sdk-event-mapper.ts` lines 339-347),
the `retryAfter` field contains the seconds to wait. This could be forwarded to Slack/Telegram as
"Rate limit reached — try again in 30 seconds."

The `rate_limit` StreamEvent IS already mapped from `SDKRateLimitEvent` in `sdk-event-mapper.ts`.
However, the Slack/Telegram adapter whitelist in `outbound.ts` does not include `rate_limit` in
the event types that warrant a user-facing message. The Slack adapter silently drops `rate_limit`
(line 733 of `outbound.ts`: "All other StreamEvent types: silently drop (whitelist model)").

For HTTP 529 (different from rate limiting), no `retryAfter` is available since 529 is a capacity
signal from the API, not a structured rate-limit response.

**Partial recommendation:** For `rate_limit` events that reach the Slack/Telegram adapter
(which requires the adapter to be set up as a subscriber), add a case to the whitelist in
`outbound.ts` that posts: "The AI service is rate-limited — try again shortly."

However, `rate_limit` events are emitted mid-stream (before `result`), meaning the session
continues and the SDK will retry automatically. Posting a "rate-limited" message mid-stream would
be confusing — the user might re-send, creating a double request. The correct behavior is to NOT
surface `rate_limit` events to end users during auto-retry. Only surface them if the session
terminates WITHOUT producing a response (which the empty-stream guard in Problem 3 catches).

---

## Problem 5: SDK Error Classification Taxonomy

The following taxonomy integrates `20260316_error_categorization_retry.md` and the new catch-block
errors identified in this investigation:

### Complete Classification

| Error Source                                     | Detection                                                     | Category                        | Retry Strategy    | User Message                                                |
| ------------------------------------------------ | ------------------------------------------------------------- | ------------------------------- | ----------------- | ----------------------------------------------------------- |
| SDK result `error_max_turns`                     | `result.subtype === 'error_max_turns'`                        | `max_turns`                     | None              | "The agent reached its turn limit."                         |
| SDK result `error_during_execution`              | `result.subtype === 'error_during_execution'`                 | `execution_error`               | Manual            | "The agent stopped due to an error."                        |
| SDK result `error_max_budget_usd`                | `result.subtype === 'error_max_budget_usd'`                   | `budget_exceeded`               | None              | "The agent hit its cost limit."                             |
| SDK result `error_max_structured_output_retries` | `result.subtype === 'error_max_structured_output_retries'`    | `output_format_error`           | None              | "The agent couldn't produce the required format."           |
| Stale session resume                             | `isResumeFailure(err)` AND `retryDepth < MAX_RESUME_RETRIES`  | (internal)                      | Auto, transparent | (no user message — retried silently)                        |
| Generic process crash (after retry exhaustion)   | `isResumeFailure(err)` AND `retryDepth >= MAX_RESUME_RETRIES` | `execution_error`               | Manual            | "The agent stopped unexpectedly. Try again."                |
| Auth / billing (keyword heuristic)               | `message.includes('authentication')` etc.                     | `execution_error`               | None              | "Authentication failed. Check your API key."                |
| Empty stream (zero content)                      | `contentEventCount === 0 && !emittedError`                    | `execution_error`               | Manual            | "The agent didn't respond. The service may be unavailable." |
| Boundary violation                               | `validateBoundary()` throws                                   | (no category — transport error) | None              | "Directory boundary violation: {path}"                      |
| TTL timeout (adapter path)                       | `controller.signal.aborted`                                   | (no category — adapter-level)   | Manual            | (not surfaced to user — already logged in agent-handler.ts) |

### Retryability Rules

| Category              | Auto-retry in server             | Manual retry UI affordance           |
| --------------------- | -------------------------------- | ------------------------------------ |
| `max_turns`           | No                               | No (retrying hits same limit)        |
| `execution_error`     | Stale session only (transparent) | Yes (user sees error + retry button) |
| `budget_exceeded`     | No                               | No                                   |
| `output_format_error` | No                               | No                                   |
| Boundary violation    | No                               | No                                   |

### Classification Priority for Catch-Block Errors

When the catch block fires in `executeSdkQuery`, the error classification must happen in this order:

1. Is `session.hasStarted` false? → Not a resume failure; surface immediately as `execution_error`
2. Is `isResumeFailure(err)` true AND `retryDepth < MAX_RESUME_RETRIES`? → Retry transparently
3. Is `isResumeFailure(err)` true AND `retryDepth >= MAX_RESUME_RETRIES`? → Surface as `execution_error`
4. Does `err.message` contain auth keywords? → Surface as `execution_error` with auth copy
5. Otherwise → Surface as generic `execution_error`

---

## Key Findings

### 1. The Infinite Loop Is the Most Critical Fix

The recursive call in `executeSdkQuery` without a depth guard is the most dangerous defect. It
produces no user-visible error (the loop just runs silently), consumes server resources, and
prevents the SSE connection from closing cleanly. The fix is 4 lines.

### 2. Empty Stream Is the Symptom; the Retry Loop Is the Cause

In the 529 scenario: CLI retries internally for ~4 minutes, exits with code 1, matches
`isResumeFailure`, the server creates a new SDK session, that also fails after 4 minutes, and so on.
The user sees nothing during this entire time. The retry depth guard + empty stream sentinel together
create two independent failure boundaries.

### 3. The Adapter Error Path Is Already Correct — The Gap Is Upstream

The Slack and Telegram `handleError()` functions correctly handle `error` StreamEvents. Once
`executeSdkQuery` yields them (which it currently does NOT for catch-block errors with the
`process exited with code 1` message that loops), the adapters will automatically deliver user
messages. No adapter code changes are needed for basic error surfacing.

### 4. The SDK's Exit Code 1 Is an Irreducible Opacity Barrier

Based on the SDK source and GitHub issues (anthropics/claude-agent-sdk-typescript#72), exit code 1
is used for ALL subprocess failures. There is no way to recover the HTTP 529 status code from the
thrown Error object in the parent process. The practical response is:

- Log the error as "agent process stopped unexpectedly (exit code 1)"
- Show a user-friendly "try again" message without speculating about 529
- Let the server logs capture the event count and duration for post-hoc diagnosis

### 5. Server-Side Logging Needs Structural Enrichment

`logger.warn('[sendMessage] stream error', ...)` currently logs only `err.message` and `durationMs`.
Adding `eventCount`, `contentEventCount`, and `retryDepth` to this log entry would give production
observability for diagnosing overload events after the fact.

---

## Full Implementation Checklist

### Priority 1 — Break the Infinite Loop

**`apps/server/src/services/runtimes/claude-code/message-sender.ts`**

1. Add `retryDepth = 0` parameter to `executeSdkQuery` signature
2. Change resume-failure check to `isResumeFailure(err) && retryDepth < MAX_RESUME_RETRIES`
3. Pass `retryDepth + 1` in the recursive call
4. On exhaustion (`retryDepth >= MAX_RESUME_RETRIES`), skip the recursive retry, fall through to
   the catch-block error yield
5. Add `retryDepth` to the `logger.warn` call in the catch block

### Priority 2 — Classify Catch-Block Errors

**`apps/server/src/services/runtimes/claude-code/message-sender.ts`**

6. Move `'process exited with code 1'` out of `RESUME_FAILURE_PATTERNS` (which triggers retry) into
   a new exported constant `PROCESS_CRASH_PATTERNS` (which surfaces error immediately unless already
   in a resume-retry cycle — handled by Priority 1 guard)
7. In the catch block fallthrough, yield:
   ```typescript
   yield {
     type: 'error',
     data: {
       message: 'The agent stopped unexpectedly. The service may be temporarily overloaded.',
       category: 'execution_error' as ErrorCategory,
       details: err instanceof Error ? err.message : String(err),
     },
   };
   ```

### Priority 3 — Detect Empty Streams

**`apps/server/src/services/runtimes/claude-code/message-sender.ts`**

8. Add `contentEventCount` counter alongside `eventCount`
9. Add `emittedError` flag, set to `true` when any `error` event is yielded
10. Track whether any `approval_required` or `question_prompt` event was yielded (`wasInteractive`)
11. After the SDK iteration loop, before the final `done` emission:
    ```typescript
    if (contentEventCount === 0 && !emittedError && !wasInteractive) {
      logger.warn('[sendMessage] zero content events', { session: sessionId, eventCount, durationMs: ... });
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

### Priority 4 — Enrich Server Logs

**`apps/server/src/services/runtimes/claude-code/message-sender.ts`**

12. Add `contentEventCount`, `retryDepth`, and `wasInteractive` to the `logger.info('[sendMessage] stream done', ...)` call
13. Add `retryDepth` to `logger.warn('[sendMessage] resume failed ...')` call

### Priority 5 — Tests

**`apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts`**

14. Test: `executeSdkQuery` with a mock that throws "process exited with code 1" every time
    yields one `error` event after `MAX_RESUME_RETRIES + 1` attempts (not infinite)
15. Test: Zero-event stream (SDK iterator yields only `session_status` + `done`) yields
    an `error` event with `category: 'execution_error'`
16. Test: Zero-event stream where `approval_required` was yielded does NOT yield an empty-stream error
17. Test: Retry depth is incremented correctly and capped at `MAX_RESUME_RETRIES`

---

## Security and Performance Considerations

**Do not expose raw SDK error strings to end users.** The `details` field in the error event may
contain internal endpoint information, rate-limit identifiers, or API key fragments. In the adapter
path, only the `message` field is sent to Slack/Telegram (via `extractErrorMessage()` which reads
`data.message`). The `details` field stays server-side.

**The retry depth guard prevents resource exhaustion.** Without it, a 529 event can hold a session
in retry for hours. With `MAX_RESUME_RETRIES = 1`, the maximum delay before surfacing is one full
SDK internal retry cycle (~4 minutes) plus one more (~4 minutes) = ~8 minutes worst case. This is
still a long time. Consider documenting that DorkOS cannot break through the SDK's internal retry
timer.

**The empty stream guard adds one integer comparison per stream.** Zero performance cost.

**Retry backoff is NOT implemented** in this fix — both retries happen immediately. Adding delay
between the stale-session retries is reasonable (`setTimeout` before the recursive call), but the
primary failure scenario (529) does not benefit from delay at the DorkOS level because the SDK
already waited ~4 minutes internally.

---

## Research Gaps and Limitations

- **SDK internal retry duration is not configurable from the outside.** The GitHub issue
  anthropics/claude-code#23115 requested environment variables for retry configuration
  (`CLAUDE_CODE_API_RETRIES`, `CLAUDE_CODE_RETRY_DELAY_MS`) but was closed as NOT_PLANNED. The
  SDK handles 529 internally; DorkOS cannot intercept or shorten that retry cycle.

- **The exact stderr content from a 529-crashed process is unknown.** We know the exit code is 1
  and the error message is "Claude Code process exited with code 1", but whether the SDK ever
  writes the HTTP 529 status to its process stderr (before it's swallowed by the SDK's subprocess
  wrapper) is undocumented. Direct empirical testing would be needed to confirm.

- **Rate-limit (`SDKRateLimitEvent`) behavior during a 529 scenario is unclear.** Does the SDK
  emit `rate_limit` events during its internal retry cycle, or only on explicit 429 responses?
  If it emits them, they flow through `sdk-event-mapper.ts` and reach the client as `rate_limit`
  StreamEvents. Whether Slack/Telegram users should see these mid-stream events is a design
  decision not resolved by this research.

- **Tool-approval flows with zero text content.** An agent that asks for tool approval before
  producing any text would trigger the empty-stream guard with `wasInteractive = false` if
  `approval_required` is not included in the "content event" set. The implementation must treat
  `approval_required` and `question_prompt` as content events (or set `wasInteractive = true`)
  to avoid false-positive empty-stream errors.

---

## Contradictions and Disputes

The prior research in `20260316_error_categorization_retry.md` states: "No auto-retry for any
category — these are all result-level terminations." This is correct for SDK `result` subtypes
(handled by `sdk-event-mapper.ts`). The current investigation covers a DIFFERENT category of errors:
**catch-block errors in `executeSdkQuery`** (before the SDK even reaches a `result` message).
There is no contradiction — the two documents cover different layers. The stale-session auto-retry
IS appropriate because it is transparent to the user (the session self-heals with no visible
interruption). Only the recursive-without-limit behavior is the problem.

---

## Sources and Evidence

- Source read: `apps/server/src/services/runtimes/claude-code/message-sender.ts` — confirmed
  recursive retry with no depth guard; `RESUME_FAILURE_PATTERNS` includes `'process exited with code 1'`
- Source read: `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — confirmed
  `mapErrorCategory()` and result handler are correct; catch-block errors are not categorized
- Source read: `packages/relay/src/adapters/claude-code/agent-handler.ts` — confirmed adapter
  only publishes events it receives; no fallback for empty stream
- Source read: `packages/relay/src/adapters/slack/outbound.ts` — confirmed `handleError()` is
  wired correctly; `rate_limit` is in the drop-whitelist
- [anthropics/claude-agent-sdk-typescript#72](https://github.com/anthropics/claude-agent-sdk-typescript/issues/72) —
  confirmed "exit code 1 is used for ALL SDK crashes; there's no way to distinguish reasons"
- [anthropics/claude-agent-sdk-python#515](https://github.com/anthropics/claude-agent-sdk-python/issues/515) —
  confirmed Python SDK also hard-codes "Check stderr output for details" — no actual stderr available
- [anthropics/claude-code#23115](https://github.com/anthropics/claude-code/issues/23115) —
  confirmed configurable retry env vars were requested and declined (NOT_PLANNED)
- [anomalyco/opencode#12234](https://github.com/anomalyco/opencode/issues/12234) —
  real-world infinite retry loop from `StreamIdleTimeoutError`; recommendation: max retry limit + non-retryable classification
- Prior research: `research/20260316_error_categorization_retry.md` — SDK result subtype taxonomy
  and user-facing copy (this investigation extends it to cover catch-block errors)
- Prior research: `research/20260316_sdk_result_error_ux_patterns.md` — UX patterns, retry affordance
  taxonomy, `ErrorMessageBlock` component spec
- [nodeshift/opossum circuit breaker](https://github.com/nodeshift/opossum) — async-generator incompatibility confirmed (wraps Promise, not AsyncIterator)
- [grammY — Flood Limits (Telegram)](https://grammy.dev/advanced/flood) — "only correct way: wait retry_after seconds then retry"
- [Slack Rate Limits Documentation](https://docs.slack.dev/apis/web-api/rate-limits/) — 429 with Retry-After header

## Search Methodology

- Searches performed: 10
- Most productive search terms: "claude-agent-sdk-typescript process exited code 1", "recursive retry
  infinite loop infinite prevention TypeScript", "empty stream zero events async generator", "opossum
  circuit breaker async iterator compatibility", "Slack Telegram bot error UX rate limit 2025"
- Primary information sources: Direct codebase reads (6 files), GitHub SDK issues (authoritative
  first-party), prior DorkOS research files, web search for patterns
