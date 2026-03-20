---
slug: sdk-error-observability
number: 148
created: 2026-03-18
status: ideation
---

# SDK Error Observability

**Slug:** sdk-error-observability
**Author:** Claude Code
**Date:** 2026-03-18
**Branch:** preflight/sdk-error-observability

---

## 1) Intent & Assumptions

- **Task brief:** Fix the 4 observability gaps that cause SDK errors (like HTTP 529 Overloaded) to be completely invisible to both server logs and end users. When the Claude Code CLI subprocess fails, the error is swallowed by overly broad pattern matching, retried infinitely via recursive calls with no depth guard, and never surfaced to Slack/Telegram users — who see their message go into the void with no response and no error.

- **Assumptions:**
  - The Claude Code SDK will continue to exit with code 1 for all subprocess failures (confirmed via GitHub issues — this is by design, not a bug)
  - The existing `handleError()` paths in Slack/Telegram outbound modules are correctly wired and will work once upstream `error` StreamEvents are actually emitted
  - The `rate_limit` StreamEvent from `sdk-event-mapper.ts` is a separate concern — mid-stream rate-limit events should NOT be surfaced to end users during auto-retry
  - Tool-approval flows (`approval_required`, `question_prompt`) legitimately produce zero text content and must not trigger empty-stream errors
  - The fix should be contained to `message-sender.ts` — no SDK modifications or adapter-level error routing changes needed for V1

- **Out of scope:**
  - Recovering the actual HTTP status code (529, 401, etc.) from the SDK subprocess — the SDK does not expose this
  - Configuring SDK internal retry behavior (requested and declined upstream: `NOT_PLANNED`)
  - Platform-specific error cards (Slack Block Kit error cards, Telegram inline keyboards) — plain text errors are sufficient for V1
  - Circuit breaker libraries (incompatible with async generators)
  - Rate-limit event surfacing to adapters (separate design decision)
  - Retry UI affordance in the web client (covered by spec #139 error-categorization-retry)

## 2) Pre-reading Log

- `apps/server/src/services/runtimes/claude-code/message-sender.ts`: Core file — contains `executeSdkQuery`, `isResumeFailure()`, `RESUME_FAILURE_PATTERNS`, the recursive retry without depth guard, and the empty-stream gap. Lines 56-69 define the overly broad pattern list; lines 327-336 show the infinite recursion; lines 353-364 show the silent `done` emission with no content check.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts`: `mapErrorCategory()` (lines 14-28) correctly maps SDK result subtypes. `rate_limit_event` handler exists (lines 339-347) but SDK doesn't emit it for 529. `session.hasStarted = true` set during init (line 43-45), compounding the misclassification bug.
- `packages/relay/src/adapters/slack/outbound.ts`: `handleError()` (lines 681-696) correctly renders errors to Slack when called. `handleDone()` (lines 408-476) silently succeeds on empty streams. `rate_limit` is in the drop whitelist (line 733).
- `packages/relay/src/adapters/telegram/outbound.ts`: Parallel implementation to Slack — same `handleDone` empty-stream gap, same error rendering path.
- `packages/relay/src/adapters/claude-code/agent-handler.ts`: Stream consumption loop (lines 120-151) — publishes events to relay but has no empty-stream detection or fallback error emission.
- `research/20260316_error_categorization_retry.md`: Prior research on SDK result subtype taxonomy and user-facing copy. Covers a different layer (SDK `result` messages) — not the catch-block errors identified here.
- `research/20260316_sdk_result_error_ux_patterns.md`: UX patterns for error display, retry affordance taxonomy, `ErrorMessageBlock` component spec.
- `contributing/relay-adapters.md`: Adapter development guide — confirms whitelist model for event routing.
- `specs/error-categorization-retry/02-specification.md`: Spec #139 — covers client-side error categorization and retry UI. Complementary to this fix (this fix ensures errors reach the client in the first place).
- GitHub issue `anthropics/claude-agent-sdk-typescript#72`: Confirms "exit code 1 is used for ALL SDK crashes; there's no way to distinguish reasons."
- GitHub issue `anthropics/claude-code#23115`: Confirms configurable retry env vars were requested and declined (`NOT_PLANNED`).

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/runtimes/claude-code/message-sender.ts` — Error classification, retry logic, stream event emission. This is the single file where all 4 bugs live.
  - `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — Maps SDK messages to StreamEvents. Already correct for `result` subtypes; no changes needed.
  - `packages/relay/src/adapters/claude-code/agent-handler.ts` — Consumes stream from `message-sender.ts`, publishes to relay. No changes needed (errors will flow through once emitted).

- **Shared dependencies:**
  - `packages/shared/src/schemas.ts` — `StreamEventSchema`, `ErrorCategory` enum
  - `packages/shared/src/types.ts` — `StreamEvent` type re-exports

- **Data flow:**
  User message → `sendMessage()` → `executeSdkQuery()` → SDK `query()` → async iteration → `sdk-event-mapper.ts` → StreamEvents → `agent-handler.ts` → RelayPublisher → Slack/Telegram outbound

  Error path (current, broken):
  SDK exit code 1 → catch block → `isResumeFailure()` matches → recursive `executeSdkQuery()` → infinite loop → no error event emitted → adapters see empty stream → silent success

  Error path (fixed):
  SDK exit code 1 → catch block → `isResumeFailure()` with narrow patterns OR retry depth exhausted → yield `error` StreamEvent → `agent-handler.ts` publishes → adapters call `handleError()` → user sees error message

- **Feature flags/config:** None. `MAX_RESUME_RETRIES` will be a new constant.

- **Potential blast radius:**
  - Direct: 1 file (`message-sender.ts`) — all 4 fixes are contained here
  - Indirect: 0 files — the downstream adapter path already handles `error` StreamEvents correctly
  - Tests: `apps/server/src/services/runtimes/claude-code/__tests__/claude-code-runtime.test.ts` needs new test cases

## 4) Root Cause Analysis

- **Repro steps:**
  1. Anthropic API returns HTTP 529 Overloaded
  2. Claude Code CLI retries internally for ~4 minutes, then exits with code 1
  3. `executeSdkQuery` catch block fires with error message "Claude Code process exited with code 1"
  4. `isResumeFailure()` matches the pattern `'process exited with code'`
  5. `session.hasStarted` is `true` (set during init handshake even for new sessions)
  6. Code resets `hasStarted = false` and calls `executeSdkQuery` recursively
  7. New session also fails → matches again → infinite loop with no depth guard
  8. No `error` StreamEvent is ever emitted
  9. Slack/Telegram adapters see `done` with zero content → silent success

- **Observed vs Expected:**
  - Observed: User sends message via Slack/Telegram, waits indefinitely, receives no response and no error
  - Expected: User receives an error message within ~4 minutes (one SDK retry cycle) explaining the service is temporarily unavailable

- **Evidence:**
  - Server logs show "Claude Code process exited with code 1" but no error event emission
  - Direct CLI test confirmed: `API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`
  - Log analysis showed 4+ minute gaps between stream start and exit code, consistent with SDK internal retry exhaustion

- **Root-cause hypotheses:**
  1. `RESUME_FAILURE_PATTERNS` is too broad — includes `'process exited with code'` which matches ALL exits, not just stale sessions (HIGH confidence)
  2. Recursive `executeSdkQuery` has no depth guard — creates infinite loop (CONFIRMED)
  3. No content event counting — empty streams pass silently (CONFIRMED)
  4. Adapter error path requires explicit `error` StreamEvent — never fires when error manifests as exit code (CONFIRMED)

- **Decision:** All 4 hypotheses are confirmed root causes operating at different layers. Fix all 4 as defense-in-depth.

## 5) Research

_Full research: `research/20260318_sdk_error_observability.md`_

- **Potential solutions:**
  1. **Narrow `RESUME_FAILURE_PATTERNS` + retry depth guard** — Remove `'process exited with code'` from the resume pattern list. Add `retryDepth` parameter to `executeSdkQuery` with `MAX_RESUME_RETRIES = 1`. On exhaustion, yield `error` StreamEvent.
     - Pros: Minimal change (one constant reorganization + one parameter + one guard). Breaks the infinite loop unconditionally. Preserves stale-session self-healing for the remaining patterns.
     - Cons: `process exited with code 1` errors that ARE stale sessions (rare edge case) will no longer auto-heal — but `session not found`, `enoent`, and `query closed before response` still cover the majority.
     - Complexity: Very low. ~10 lines changed.

  2. **Content event counter + empty stream sentinel** — Track `contentEventCount` alongside `eventCount`. After iteration, if zero content events and no prior error, yield synthetic `error` event.
     - Pros: Turns silent failures into observable errors. Works for any cause of empty streams (not just 529).
     - Cons: Must exclude tool-approval flows from the "empty" definition.
     - Complexity: Low. ~15 lines added.

  3. **Read subprocess stderr / JSONL transcript** — After catching exit code 1, read the Claude JSONL transcript file for error markers.
     - Pros: Could recover the actual HTTP error code.
     - Cons: Race condition (JSONL may not be written), adds I/O in error path, brittle.
     - **Not recommended** as primary approach.

  4. **Circuit breaker library (opossum)** — Wrap SDK `query()` with circuit breaker.
     - Pros: Industry-standard pattern.
     - Cons: Fundamentally incompatible with async generators. SDK returns AsyncIterable, not Promise.
     - **Not recommended.**

- **Recommendation:** Solutions 1 + 2 together. They create two independent failure boundaries — the retry depth guard breaks the infinite loop, and the content counter catches any remaining silent-stream scenarios. No new dependencies, minimal code changes, all contained in `message-sender.ts`.

## 6) Decisions

| #   | Decision                                         | Choice                                                                                         | Rationale                                                                                                                                                                                                                                                |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | How to fix `isResumeFailure()` misclassification | Narrow the pattern list — remove `'process exited with code'` from `RESUME_FAILURE_PATTERNS`   | The remaining patterns (`session not found`, `enoent`, `query closed before response`) cover legitimate stale-session scenarios. `process exited with code 1` is too broad and matches API errors, auth failures, and OOM crashes.                       |
| 2   | Error UX for Slack/Telegram users                | Specific, actionable error messages set in the `error` StreamEvent `message` field             | Single source of truth for user-facing copy. Both web UI and adapter platforms receive the same message. No adapter-specific logic needed. Example: "The agent stopped unexpectedly. The service may be temporarily overloaded — try again in a moment." |
| 3   | Retry limit for recursive `executeSdkQuery`      | Max 1 retry, then surface error                                                                | One retry preserves stale-session self-healing. On second failure, yield `error` StreamEvent immediately. `MAX_RESUME_RETRIES = 1` constant.                                                                                                             |
| 4   | How to handle empty streams                      | Warn log + synthetic `error` StreamEvent when `contentEventCount === 0` after stream completes | Track content events (`text_delta`, `tool_call_start`, `tool_result`, `thinking_delta`). Exclude interactive flows (`approval_required`, `question_prompt`) via `wasInteractive` flag. The `emittedError` flag prevents double-emitting.                 |
