# fix-relay-history-sse-gaps — Task Breakdown

**Generated:** 2026-03-06
**Spec:** `specs/fix-relay-history-sse-gaps/02-specification.md`
**Mode:** Full

---

## Phase 1: Core Fixes (Critical)

### 1.1 Extract `stripRelayContext` helper and fix user message parsing

**Size:** Medium | **Priority:** High | **Parallel with:** 1.2, 1.3

Fix the `continue` at transcript-parser.ts:231 that discards the entire string (including actual user content) when it starts with `<relay_context>`. Extract a `stripRelayContext()` helper that returns the user content after `</relay_context>` or `null` for pure metadata. Add unit tests for the helper and for end-to-end transcript parsing with relay-wrapped messages.

### 1.2 Suppress Skill tool_result text from user messages

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.3

Remove the `&& textParts.length === 0` condition from the `hasToolResult` check at transcript-parser.ts:187. When `tool_result` blocks are present, any `text` blocks are SDK-internal skill expansion content and should always be suppressed. Add tests verifying text suppression and tool call card preservation.

### 1.3 Fix Agent-ID to SDK-Session-ID translation in SSE registration

**Size:** Small | **Priority:** High | **Parallel with:** 1.1, 1.2

Apply `agentManager.getSdkSessionId()` translation at sessions.ts:351 before calling `registerClient()`, matching the pattern already used by the GET /messages endpoint. This ensures file watchers target the correct JSONL file.

---

## Phase 2: SSE Reliability + Code Quality

### 2.1 Add client-side staleness detector for missed `done` events

**Size:** Medium | **Priority:** High | **Depends on:** 1.1, 1.2, 1.3 | **Parallel with:** 2.2, 2.3

Add a 15-second staleness timeout in `use-chat-session.ts` that polls session status when no SSE events arrive during active streaming. If the backend reports completion, transition to idle and refresh messages. Only active when relay is enabled.

### 2.2 Add `done` event tracing logs in session-broadcaster

**Size:** Small | **Priority:** Medium | **Depends on:** 1.1, 1.2, 1.3 | **Parallel with:** 2.1, 2.3

Add debug-level logs when `done` events are queued, written, and when writes fail in the relay-to-SSE pipeline. Provides observability for debugging remaining delivery gaps.

### 2.3 Extract DRY helpers and define SDK tool name constants

**Size:** Medium | **Priority:** Medium | **Depends on:** 1.1, 1.2 | **Parallel with:** 2.1, 2.2

Extract `applyToolResult()` and `buildCommandMessage()` helpers to eliminate duplicated code in transcript-parser.ts. Define `SDK_TOOL_NAMES` constants in `@dorkos/shared` and replace all magic tool name strings.

---

## Phase 3: Verification

### 3.1 Run full test suite and verify all fixes

**Size:** Small | **Priority:** High | **Depends on:** 2.1, 2.2, 2.3

Run `pnpm test -- --run`, `pnpm typecheck`, and `pnpm lint` to verify all fixes and no regressions.

---

## Dependency Graph

```
Phase 1 (parallel):  1.1  1.2  1.3
                       \   |   /
Phase 2 (parallel):   2.1  2.2  2.3
                        \   |   /
Phase 3:                  3.1
```
