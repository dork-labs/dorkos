# Fix Relay History Rendering & Remaining SSE Delivery Gaps

**Status:** Draft
**Authors:** Claude (spec:create), 2026-03-06
**Origin:** Chat self-test run 2 findings (`plans/2026-03-06-chat-self-test-findings.md`)

---

## Overview

Fix three critical bugs affecting DorkOS chat when Relay is enabled: (1) user messages missing from history reload, (2) Skill tool_result content leaking as user messages, and (3) SSE `done` event delivery failures (~20% regression). Additionally, fix the 503 flood caused by Agent-ID/SDK-Session-ID mismatch in SSE registration, and clean up code quality issues in the affected files.

## Background / Problem Statement

The `fix-relay-sse-delivery-pipeline` spec (d62daa1) reduced SSE freezes from ~60% to ~20%, but three critical issues remain:

### Bug 1: User Messages Missing from History

When Relay is enabled, `ClaudeCodeAdapter.formatPromptWithContext()` wraps user messages as:

```
<relay_context>
Agent-ID: 9c99edf1-...
...
</relay_context>

Write a JavaScript bubble sort function with comments
```

`transcript-parser.ts:231` checks `text.startsWith('<relay_context>')` and calls `continue`, discarding the **entire** string including the actual user content after `</relay_context>`. On history reload, all user messages vanish.

### Bug 2: Skill Tool Result Leaks as User Message

When the agent calls a Skill, the SDK generates a user message with both `tool_result` and `text` content blocks. `transcript-parser.ts:211-220` renders the text parts as a user message when `textParts.length > 0`, even though the text is the skill's expansion prompt (internal SDK content, not user-authored).

### Bug 3: SSE `done` Event Not Delivered (~20%)

Message 2 in the self-test completed on the backend (JSONL confirmed) but the client's stop button persisted for 25+ seconds. The four-layer fix (stable EventSource, subscribe-first handshake, pending buffer, terminal `done` in finally) did not fully eliminate the issue.

### Bug 4: 503 Flood from Session ID Mismatch

`sessions.ts:351` passes the raw Agent-ID to `registerClient()` without translating to the SDK-Session-ID. The broadcaster creates a file watcher for `{agentId}.jsonl` which doesn't exist on disk (the actual file is `{sdkSessionId}.jsonl`). This causes watcher failures and potentially counts against SSE limits.

## Goals

- Fix user messages appearing in history when Relay is enabled
- Fix Skill tool_result not leaking as user messages
- Eliminate remaining SSE `done` event delivery failures
- Fix Agent-ID → SDK-Session-ID translation in SSE registration
- Refactor `transcript-parser.ts` to reduce complexity and eliminate DRY violations
- Replace magic strings with typed constants
- Add comprehensive test coverage for relay-mode history rendering

## Non-Goals

- Redesigning the relay architecture or message format
- Changing the ClaudeCodeAdapter's `formatPromptWithContext()` wrapping (it serves a valid purpose for relay routing)
- Fixing the session title extraction (separate, lower-priority issue)
- Redesigning the SSE connection limit system
- Moving `publishViaRelay()` to services layer (separate refactor)

## Technical Dependencies

- No new external libraries required
- Existing: `@dorkos/shared/types`, `@dorkos/relay`, `better-sqlite3`

## Related ADRs

- `decisions/0003-sdk-jsonl-as-single-source-of-truth.md` — JSONL is the canonical data source; parser correctness is critical
- `decisions/0076-mesh-ulid-vs-sdk-uuid-dual-id-traceability.md` — documents the Agent-ID vs SDK-Session-ID duality

---

## Detailed Design

### Fix 1: Strip Relay Context from User Messages (transcript-parser.ts)

**Current code (line 231):**

```typescript
if (text.startsWith('<relay_context>')) {
  continue;
}
```

**Fix:** Extract the actual user content after `</relay_context>`:

```typescript
if (text.startsWith('<relay_context>')) {
  const closingTag = '</relay_context>';
  const closingIdx = text.indexOf(closingTag);
  if (closingIdx === -1) continue; // Malformed, skip
  const userContent = text.slice(closingIdx + closingTag.length).trim();
  if (!userContent) continue; // Pure relay metadata, skip
  text = userContent; // Fall through to process as normal user message
}
```

This also fixes session title extraction — `extractTitle()` in `transcript-reader.ts` calls `parseTranscript()` which now properly extracts the user content.

**Extract to helper:** Create `stripRelayContext(text: string): string | null` that returns the user content or `null` if pure metadata. This makes the intent clear and is testable in isolation.

### Fix 2: Suppress Skill Expansion Text from User Messages (transcript-parser.ts)

**Current code (lines 187-220):**

```typescript
if (hasToolResult && textParts.length === 0) {
  // ... handle pending command ...
  continue;
}
// Falls through to render textParts as user message
```

**Fix:** When a user message contains `tool_result` blocks, the `text` blocks are internal SDK expansion content (skill prompts, system messages), not user-authored. Suppress them:

```typescript
if (hasToolResult) {
  // tool_result messages are SDK-internal. text blocks are skill expansions,
  // not user-authored content. Process tool results but don't render text.
  if (parsed.toolUseResult?.commandName) {
    const cmdName = '/' + parsed.toolUseResult.commandName.replace(/^\//, '');
    pendingCommand = { commandName: cmdName, commandArgs: pendingSkillArgs || '' };
    pendingSkillArgs = null;
  }
  continue;
}
```

The key insight: if `hasToolResult` is true, any `textParts` in the same message are SDK-injected (skill expansion, system context), never user-typed content. User content is always in a separate JSONL line.

### Fix 3: Translate Session ID in SSE Registration (sessions.ts)

**Current code (line 351):**

```typescript
sessionBroadcaster.registerClient(sessionId, cwd, res, clientId);
```

**Fix:** Apply the same SDK-Session-ID translation used by GET /messages:

```typescript
const sdkSessionId = agentManager.getSdkSessionId(sessionId) ?? sessionId;
sessionBroadcaster.registerClient(sdkSessionId, cwd, res, clientId);
```

This ensures the file watcher targets the correct JSONL file and prevents duplicate watcher registrations under different IDs for the same session.

### Fix 4: SSE `done` Event Delivery — Client-Side Safety Net

The four-layer server-side fix is architecturally sound but the `done` event still occasionally fails to reach the client. Rather than adding more complexity to the server pipeline, add a **client-side staleness detector** as a defense-in-depth mechanism:

**In `use-chat-session.ts`, add a staleness timeout when relay is enabled:**

```typescript
// After receiving a text_delta or tool event, start a staleness timer.
// If no events arrive for DONE_STALENESS_MS, poll the session status.
const DONE_STALENESS_MS = 15_000;
let stalenessTimer: ReturnType<typeof setTimeout> | null = null;

const resetStalenessTimer = () => {
  if (stalenessTimer) clearTimeout(stalenessTimer);
  stalenessTimer = setTimeout(async () => {
    // Check if session has completed on the backend
    const session = await transport.getSession(sessionId, cwd);
    if (session && !session.isStreaming) {
      // Backend completed but we missed the done event
      setStatus('idle');
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId] });
    }
  }, DONE_STALENESS_MS);
};
```

This ensures the client never hangs indefinitely. The timer is reset on every received event and only fires if the stream goes completely silent.

**Also add server-side tracing:** In `session-broadcaster.ts:subscribeToRelay()`, log when a `done` event is queued and when it's written to the SSE stream. This provides observability for debugging any remaining gaps.

### Fix 5: Refactor transcript-parser.ts — Code Quality

The parser has accumulated complexity. Refactor to address the code quality issues found in review:

#### 5a: Extract `stripRelayContext()` helper

```typescript
/** Strip relay context wrapper, returning the user content or null if pure metadata. */
export function stripRelayContext(text: string): string | null {
  if (!text.startsWith('<relay_context>')) return text;
  const closingTag = '</relay_context>';
  const idx = text.indexOf(closingTag);
  if (idx === -1) return null;
  const content = text.slice(idx + closingTag.length).trim();
  return content || null;
}
```

#### 5b: Extract `applyToolResult()` helper

Deduplicate lines 164-181 (tool_result handling for `toolCallMap` and `toolCallPartMap`):

```typescript
function applyToolResult(
  tc: HistoryToolCall | ToolCallPart | undefined,
  resultText: string,
  sdkAnswers?: Record<string, string>
): void {
  if (!tc) return;
  tc.result = resultText;
  if (tc.toolName === TOOL_NAMES.ASK_USER_QUESTION && tc.questions && !tc.answers) {
    tc.answers = sdkAnswers
      ? mapSdkAnswersToIndices(sdkAnswers, tc.questions)
      : parseQuestionAnswers(resultText, tc.questions);
  }
}
```

Call it twice: `applyToolResult(toolCallMap.get(id), resultText, sdkAnswers)` and `applyToolResult(toolCallPartMap.get(id), resultText, sdkAnswers)`.

#### 5c: Extract `emitPendingCommand()` helper

Deduplicate lines 196-209 and 248-261:

```typescript
function emitPendingCommand(
  cmd: { commandName: string; commandArgs: string },
  messages: HistoryMessage[]
): void {
  const displayContent = cmd.commandArgs
    ? `${cmd.commandName} ${cmd.commandArgs}`
    : cmd.commandName;
  messages.push({
    role: 'user',
    content: displayContent,
    messageType: 'command',
    commandName: cmd.commandName,
    commandArgs: cmd.commandArgs,
  });
}
```

#### 5d: Define tool name constants

Replace magic strings with constants in `@dorkos/shared`:

```typescript
// packages/shared/src/constants.ts
export const SDK_TOOL_NAMES = {
  SKILL: 'Skill',
  ASK_USER_QUESTION: 'AskUserQuestion',
  TODO_WRITE: 'TodoWrite',
  TASK_CREATE: 'TaskCreate',
  TASK_UPDATE: 'TaskUpdate',
} as const;
```

---

## User Experience

- **History reload:** Users will see their messages in the conversation after refreshing, matching the live-streaming view
- **Skill calls:** The internal skill expansion content will no longer appear as user messages; users will see the tool call card and the response
- **SSE reliability:** If the `done` event is lost, the client auto-recovers within 15 seconds instead of hanging indefinitely
- **503 reduction:** SSE connections will target the correct JSONL file, reducing spurious 503 errors

## Testing Strategy

### Unit Tests

#### transcript-parser.test.ts — New/Updated Cases:

1. **`strips relay_context wrapper and preserves user content`** — verify that `<relay_context>...</relay_context>\n\nUser message` produces a user message with "User message"
2. **`handles relay_context with no trailing content`** — pure relay metadata is still skipped
3. **`handles malformed relay_context (no closing tag)`** — skipped gracefully
4. **`suppresses Skill tool_result text from user messages`** — when `tool_result + text` blocks exist, no user message is emitted for the text
5. **`Skill tool call card preserved after tool_result suppression`** — the tool call itself still appears in the tool call list
6. **`stripRelayContext returns user content after closing tag`** — unit test for the helper
7. **`stripRelayContext returns null for pure metadata`** — unit test for the helper
8. **`applyToolResult sets result on HistoryToolCall`** — unit test for the helper
9. **`emitPendingCommand creates correct message shape`** — unit test for the helper

#### session-broadcaster.test.ts — New Cases:

10. **`registerClient translates session ID before creating watcher`** — mock agentManager.getSdkSessionId, verify watcher path uses translated ID
11. **`done event logged when queued to relay write queue`** — verify trace log output

#### use-chat-session.test.ts — New Cases:

12. **`staleness timer fires and transitions to idle when backend completed`** — mock transport.getSession returning completed session, verify status transitions to idle
13. **`staleness timer resets on each received event`** — verify timer doesn't fire during active streaming

### Edge Case Tests:

14. **`relay_context with multiple paragraphs of user content`** — content with newlines after `</relay_context>`
15. **`relay_context followed by command-like text`** — e.g., `/help` after relay context should still process as command
16. **`multiple tool_result blocks in single user message`** — all results applied, no text leak

### Mocking Strategies:

- `transcript-parser` tests: construct JSONL lines as plain objects, no mocking needed
- `session-broadcaster` tests: mock `agentManager` dependency for `getSdkSessionId()`
- `use-chat-session` tests: mock `Transport` via `createMockTransport()`, mock `EventSource` via jsdom

## Performance Considerations

- `stripRelayContext()` does a single `indexOf` scan — O(n) where n is message length, negligible
- The staleness timer adds one `setTimeout` per streaming session — negligible overhead
- Session ID translation is an O(1) map lookup (existing `sdkSessionIndex`)

## Security Considerations

- No new security surface. The relay context stripping only affects display parsing, not message routing.
- The `stripRelayContext()` function should NOT be used for security-sensitive parsing — it's for display purposes only.

## Documentation

- Update `contributing/architecture.md` Session Architecture section to document the relay context wrapping and parser stripping
- Add TSDoc to all new helper functions (`stripRelayContext`, `applyToolResult`, `emitPendingCommand`)

## Implementation Phases

### Phase 1: Core Fixes (Critical)

1. Fix `stripRelayContext()` — extract helper, fix parser line 231
2. Fix `hasToolResult` text suppression — parser lines 187-220
3. Fix session ID translation in SSE registration — sessions.ts:351
4. Add all unit tests for Phase 1 fixes

### Phase 2: SSE Reliability + Code Quality

5. Add client-side staleness detector in `use-chat-session.ts`
6. Add `done` event tracing logs in `session-broadcaster.ts`
7. Extract `applyToolResult()` helper (DRY fix)
8. Extract `emitPendingCommand()` helper (DRY fix)
9. Define `SDK_TOOL_NAMES` constants in shared package
10. Add remaining tests

### Phase 3: Verification

11. Run full test suite
12. Run `/chat:self-test` to verify all issues are fixed

## Open Questions

1. **Should the staleness timeout be configurable?** Currently hardcoded to 15s. Could be a constant in `QUERY_TIMING`.
2. **Should we add a session status endpoint?** The staleness detector needs to check if the backend completed. Currently it would use `getSession()` which returns metadata — does this include streaming status? If not, we may need to add a lightweight status check.
3. **Should we log malformed JSONL lines?** The parser silently skips them (line 147-150). Adding a warning log would help debug data issues but could be noisy.

## References

- Self-test findings: `plans/2026-03-06-chat-self-test-findings.md`
- Previous SSE fix spec: `specs/fix-relay-sse-delivery-pipeline/02-specification.md`
- SSE backpressure fix: `specs/fix-relay-sse-backpressure/02-specification.md`
- ADR-0003: SDK JSONL as single source of truth
- ADR-0076: ULID vs SDK UUID dual-ID traceability
- Code quality review: embedded in self-test findings
