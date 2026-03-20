# Task Breakdown: Chat Streaming & Session Reliability Fixes

**Spec:** `specs/chat-streaming-session-reliability/02-specification.md`
**Generated:** 2026-03-05
**Mode:** Full

---

## Summary

Four targeted bug fixes discovered during automated self-test of the DorkOS chat UI:

| Fix | Bug                                                              | Priority | Phase |
| --- | ---------------------------------------------------------------- | -------- | ----- |
| 1.1 | SSE streaming freeze on responses >~100 tokens                   | P0       | 1     |
| 1.2 | Blank chat on hard refresh with DorkOS UUID in URL               | P0       | 1     |
| 2.1 | `<relay_context>` shown as user messages in chat history         | P1       | 2     |
| 2.2 | Session titles show relay metadata instead of first user message | P1       | 2     |
| 2.3 | Model/permission mode selectors reset each other on update       | P2       | 2     |
| 3.x | Tests and documentation                                          | —        | 3     |

No new libraries. No schema or database changes. All fixes are surgical.

---

## Phase 1 — P0 Core Fixes

### Task 1.1 — Make `sendSSEEvent` async with drain backpressure handling

**File:** `apps/server/src/services/core/stream-adapter.ts`
**Size:** Small | **Priority:** High

**Root cause:** `res.write()` returns `false` when Node's socket write buffer fills (~16KB). The current implementation ignores this return value and calls `write()` twice per event. When buffer fills, subsequent writes silently stall the `for await` loop in the route handler, freezing the stream mid-response.

**Change:** Convert `sendSSEEvent` from a synchronous void function to an async function that awaits the `drain` event when `write()` returns `false`. Combine the two separate `res.write()` calls into one to reduce trigger points.

```typescript
// apps/server/src/services/core/stream-adapter.ts

/** Write a single StreamEvent as an SSE message with backpressure handling. */
export async function sendSSEEvent(res: Response, event: StreamEvent): Promise<void> {
  const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
  const ok = res.write(payload);
  if (!ok) {
    await new Promise<void>((resolve) => res.once('drain', resolve));
  }
}
```

**Call sites to update** (`apps/server/src/routes/sessions.ts`): Add `await` to all three calls (main loop, done-redirect, error handler).

**Acceptance criteria:**

- `sendSSEEvent` is exported as `async` returning `Promise<void>`
- Single `res.write()` call per invocation (combined payload)
- `drain` listener registered only when `write()` returns `false`
- All three call sites in `routes/sessions.ts` use `await`

---

### Task 1.2 — Translate session ID before JSONL lookup in GET /messages

**File:** `apps/server/src/routes/sessions.ts`
**Size:** Small | **Priority:** High
**Parallel with:** 1.1

**Root cause:** `GET /api/sessions/:id/messages` uses the raw URL parameter as the JSONL filename. When Relay is enabled, the URL holds the client-facing DorkOS UUID but the JSONL file is named with the SDK-assigned UUID. File not found → empty message list.

**Change:** Resolve the SDK session ID before reading the transcript, with fallback to the URL parameter for sessions not in memory.

```typescript
// GET /:id/messages handler
const sdkSessionId = agentManager.getSdkSessionId(sessionId) ?? sessionId;
const etag = await transcriptReader.getTranscriptETag(cwd, sdkSessionId);
// ... ETag check ...
const messages = await transcriptReader.readTranscript(cwd, sdkSessionId);
```

Apply the same translation in `GET /:id` (metadata) and `GET /:id/tasks` handlers for consistency.

**Fallback behavior:** `getSdkSessionId()` returns `undefined` after server restart. The `?? sessionId` fallback preserves existing behavior for sidebar-navigated sessions (which already have the SDK UUID in the URL via the `done` event redirect).

**Acceptance criteria:**

- Hard refresh with DorkOS UUID in URL returns correct message history
- Server-restart sessions loaded via sidebar still work
- `getSdkSessionId` called before `readTranscript`, `getSession`, and `readTasks`
- ETag computation uses `sdkSessionId`

---

## Phase 2 — P1/P2 Relay and UX Fixes

All three tasks in Phase 2 are independent and can run in parallel.

### Task 2.1 — Filter `<relay_context>` blocks from transcript parser

**File:** `apps/server/src/services/session/transcript-parser.ts`
**Size:** Small | **Priority:** Medium

**Root cause:** `ClaudeCodeAdapter` prepends a `<relay_context>` XML block to every dispatched message. This block appears in the JSONL as a regular user message. `parseTranscript()` filters other internal message types but not `<relay_context>`, so relay metadata appears as visible chat messages.

**Change:** Add `<relay_context>` to the existing skip filter block in `parseTranscript()` (around line 226):

```typescript
if (text.startsWith('<task-notification>')) {
  continue;
}

// Filter relay metadata injected by ClaudeCodeAdapter — never user-authored content
if (text.startsWith('<relay_context>')) {
  continue;
}
```

**Note:** Check `claude-code-adapter.ts:782` to confirm whether `<relay_context>` content and actual user message are on separate JSONL lines (correct assumption for `continue`) or combined on one line (would need different handling).

**Acceptance criteria:**

- Messages starting with `<relay_context>` are excluded from `HistoryMessage[]`
- Non-relay user messages are unaffected
- No-op for sessions where `DORKOS_RELAY_ENABLED=false`

---

### Task 2.2 — Skip `<relay_context>` in session title extraction

**File:** `apps/server/src/services/session/transcript-reader.ts`
**Size:** Small | **Priority:** Medium
**Parallel with:** 2.1

**Root cause:** `extractSessionMeta()` derives session title from the first user message, which in relay sessions is the `<relay_context>` block. All relay session titles show relay metadata instead of the user's actual question.

**Change:** Add `<relay_context>` to the existing skip condition in `extractSessionMeta()` (around line 247-254):

```typescript
if (
  text.startsWith('<local-command') ||
  text.startsWith('<command-name>') ||
  text.startsWith('<command-message>') ||
  text.startsWith('<task-notification>') ||
  text.startsWith('<relay_context>') // Filter relay metadata injected by ClaudeCodeAdapter
) {
  continue;
}
```

**Acceptance criteria:**

- Relay sessions derive title from the first non-relay user message
- When only relay messages exist in head buffer, fallback to `Session <uuid-prefix>`
- Non-relay sessions are completely unaffected
- Added condition is in the same `if` block (not a separate one)

---

### Task 2.3 — Merge PATCH response into TanStack Query cache

**File:** `apps/client/src/layers/entities/session/model/use-session-status.ts`
**Size:** Small | **Priority:** Medium
**Parallel with:** 2.1, 2.2

**Root cause:** `queryClient.setQueryData(key, updated)` replaces the entire cache entry with the server response. PATCH `/api/sessions/:id` may not include both `model` and `permissionMode` in the response (returns whatever is on disk, which may not reflect the other field set only in memory). Result: updating model resets permission mode and vice versa.

**Change:** Use the updater-function form of `setQueryData` to merge rather than replace:

```typescript
// Before (use-session-status.ts line ~84):
queryClient.setQueryData(['session', sessionId, selectedCwd], updated);

// After:
queryClient.setQueryData(['session', sessionId, selectedCwd], (old: Session | undefined) => ({
  ...old,
  ...updated,
}));
```

Add `Session` to the `@dorkos/shared/types` imports if not already present.

**Acceptance criteria:**

- Updating `model` preserves the cached `permissionMode`
- Updating `permissionMode` preserves the cached `model`
- Status bar does not visually reset either field when the other is updated
- Error path (catch block) still correctly reverts optimistic state

---

## Phase 3 — Tests and Documentation

All Phase 3 tasks are independent and can run in parallel (each depends only on its corresponding fix task).

### Task 3.1 — Update stream-adapter tests for async `sendSSEEvent`

**File:** `apps/server/src/services/core/__tests__/stream-adapter.test.ts`
**Size:** Small | **Priority:** Medium
**Depends on:** 1.1

Update the mock to include `once: vi.fn()`, add `await` to all `sendSSEEvent` calls, fix the write-count assertions (now 1 per event instead of 2), and add two new backpressure tests:

```typescript
it('waits for drain before resolving when write returns false', async () => {
  const mockRes = {
    write: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
    once: vi.fn((event, cb) => {
      if (event === 'drain') cb();
    }),
  };
  await sendSSEEvent(mockRes as unknown as Response, { type: 'text_delta', data: { text: 'hi' } });
  expect(mockRes.once).toHaveBeenCalledWith('drain', expect.any(Function));
  expect(mockRes.write).toHaveBeenCalledTimes(1);
});

it('does not wait when write returns true', async () => {
  const mockRes = { write: vi.fn().mockReturnValue(true), once: vi.fn() };
  await sendSSEEvent(mockRes as unknown as Response, { type: 'done', data: {} });
  expect(mockRes.once).not.toHaveBeenCalled();
});
```

---

### Task 3.2 — Add session ID translation tests to routes/sessions test suite

**File:** `apps/server/src/routes/__tests__/sessions.test.ts`
**Size:** Small | **Priority:** Medium
**Depends on:** 1.2

Add two tests to verify the `getSdkSessionId()` translation in GET /messages:

- `uses SDK session ID when fetching message history` — mock `getSdkSessionId` to return `'sdk-uuid-123'`, verify `readTranscript` is called with that value when the URL uses `'client-uuid-456'`.
- `falls back to URL session ID when not in agentManager` — mock `getSdkSessionId` to return `undefined`, verify `readTranscript` is called with the URL parameter unchanged.

Ensure `getTranscriptETag` is mocked in the `transcriptReader` mock setup (returns `null` for these tests).

---

### Task 3.3 — Add `<relay_context>` filter tests to transcript-parser and transcript-reader

**Files:** `apps/server/src/services/__tests__/transcript-parser.test.ts` and `apps/server/src/services/__tests__/transcript-reader.test.ts`
**Size:** Small | **Priority:** Medium
**Depends on:** 2.1, 2.2

**Transcript-parser tests:**

- `filters relay_context blocks from parsed messages` — JSONL with only a `<relay_context>` user line returns 0 user messages, assistant messages are still returned.
- `does not filter regular user messages` — sanity check that normal messages still pass through.

**Transcript-reader tests:**

- `skips relay_context when extracting session title` — session with `<relay_context>` first, then `'Analyze logs'` gets title `'Analyze logs'`.
- `uses fallback title when all user messages are relay_context` — session with only relay context messages gets `'Session <uuid-prefix>'` fallback.

Follow existing fs mock patterns in the transcript-reader test file for mocking `fs.open` / `fileHandle.read`.

---

### Task 3.4 — Add `use-session-status` merge test and update architecture docs

**Files:** `apps/client/src/layers/entities/session/model/__tests__/use-session-status.test.ts` and `contributing/architecture.md`
**Size:** Small | **Priority:** Low
**Depends on:** 2.3

**Client test:** Two tests using `renderHook` with `QueryClientProvider` + `TransportProvider`:

- `preserves existing permissionMode when updating model` — prime cache with both fields, mock `transport.updateSession` to return only `model`, verify `permissionMode` is preserved in cache after `updateSession({ model })`.
- `preserves existing model when updating permissionMode` — mirror of above in the other direction.

**Architecture docs:** Update `contributing/architecture.md` with:

1. Note that `sendSSEEvent` is async and must be awaited (with explanation of why).
2. Note that `GET /api/sessions/:id/messages` calls `getSdkSessionId()` before JSONL lookup for session ID translation.

---

## Dependency Graph

```
1.1 ──────────────────────────────────────────────── 3.1
1.2 ──────────────────────────────────────────────── 3.2
2.1 ──┐
2.2 ──┼─────────────────────────────────────────── 3.3
2.3 ──────────────────────────────────────────────── 3.4
```

Tasks 1.1 and 1.2 are parallel.
Tasks 2.1, 2.2, and 2.3 are parallel.
Tasks 3.1, 3.2, 3.3, and 3.4 are parallel (each depends on its own fix).

---

## Files Changed

| File                                                                                 | Change                                                          |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `apps/server/src/services/core/stream-adapter.ts`                                    | `sendSSEEvent` → async, single write, drain await               |
| `apps/server/src/routes/sessions.ts`                                                 | Await `sendSSEEvent` calls; add `getSdkSessionId()` translation |
| `apps/server/src/services/session/transcript-parser.ts`                              | Add `<relay_context>` filter                                    |
| `apps/server/src/services/session/transcript-reader.ts`                              | Add `<relay_context>` to title skip list                        |
| `apps/client/src/layers/entities/session/model/use-session-status.ts`                | Merge `setQueryData` instead of replace                         |
| `apps/server/src/services/core/__tests__/stream-adapter.test.ts`                     | Update + add backpressure tests                                 |
| `apps/server/src/routes/__tests__/sessions.test.ts`                                  | Add ID translation tests                                        |
| `apps/server/src/services/__tests__/transcript-parser.test.ts`                       | Add relay_context filter tests                                  |
| `apps/server/src/services/__tests__/transcript-reader.test.ts`                       | Add relay_context title tests                                   |
| `apps/client/src/layers/entities/session/model/__tests__/use-session-status.test.ts` | Add cache merge tests                                           |
| `contributing/architecture.md`                                                       | Document async sendSSEEvent and ID translation                  |
