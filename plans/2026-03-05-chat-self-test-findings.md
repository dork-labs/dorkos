# Chat Self-Test Findings — 2026-03-05

## Test Config

- URL: `http://localhost:4241/?dir=/Users/doriancollier/Keep/temp/empty`
- Session ID (URL): `fd7dfe59-...` (client-facing relay UUID)
- Session ID (JSONL): `db97cafb-8e3c-4d18-b24b-24bcd524ad55` (SDK-assigned)
- Model: `claude-haiku-4-5`
- Permission mode: Accept Edits
- Messages sent: 8
- Server port: 4242

## Summary

The chat UI completes all 8 test messages but has **4 bugs**, two of which are critical. The most impactful is a server-side SSE backpressure bug that causes responses longer than ~100 tokens to freeze mid-stream — affecting messages 2, 3, 4, 5, and 6 of the test. The second critical bug is that hard page refresh renders a blank chat because the URL session ID diverges from the SDK-assigned JSONL filename after the first message. Two additional bugs affect Relay sessions specifically: relay metadata (`<relay_context>`) appears as visible user messages in the chat history, and the model/permission mode selectors reset each other when opened in sequence.

---

## Issues Found

### 1. SSE Streaming Freeze Mid-Response — **Bug (CRITICAL)**

**Observed:** Responses longer than ~100 tokens (approximately 16KB of SSE data) freeze mid-delivery. The Stop button remains visible; JSONL has the complete response. Shorter responses (≤50 tokens, such as message 8 "2+2=4") complete without issue. Messages 2, 3, 4, 5, 6 all froze in the test and required manual Stop.

**Expected:** All responses stream to completion regardless of length.

**Root cause:** `apps/server/src/services/core/stream-adapter.ts` lines 20-22

```typescript
export function sendSSEEvent(res: Response, event: StreamEvent): void {
  res.write(`event: ${event.type}\n`);
  res.write(`data: ${JSON.stringify(event.data)}\n\n`);
}
```

`res.write()` returns `false` when Node's internal socket write buffer fills (default highWaterMark ~16KB for HTTP/1.1 keep-alive). The return value is silently ignored. When backpressure triggers:

1. `res.write()` returns `false` but the code continues
2. The OS TCP buffer fills → subsequent `write()` calls block the event loop
3. The `for await` loop in `routes/sessions.ts:260` stalls waiting for the next SDK event
4. The async generator in `agent-manager.ts` is suspended
5. Client receives no further SSE events — appears frozen

**Code path:**

```
agentManager.sendMessage() → async generator yields StreamEvent
  → routes/sessions.ts:261 for await → sendSSEEvent(res, event)
       → res.write() returns false (buffer full) — IGNORED
            → loop stalls → no more events reach client
```

**Client-side impact:** `http-transport.ts` lines 167-185 has a correct `ReadableStream` reader loop — it correctly blocks on `reader.read()` awaiting data. The bug is entirely server-side.

**Fix:** Await a `drain` event when `res.write()` returns `false`:

```typescript
// stream-adapter.ts
export async function sendSSEEvent(res: Response, event: StreamEvent): Promise<void> {
  const canContinue = res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  if (!canContinue) {
    await new Promise<void>((resolve) => res.once('drain', resolve));
  }
}
```

Also update the call site in `routes/sessions.ts:261` to `await sendSSEEvent(res, event)`.

**Research:** Standard Node.js backpressure pattern per the [Node.js backpressuring guide](https://nodejs.org/en/docs/guides/backpressuring-in-streams/). The `write()` return value is documented to signal when the buffer is full.

---

### 2. Hard Page Refresh Renders Blank Chat — **Bug (CRITICAL)**

**Observed:** Hard page refresh (`Cmd+R` with `?session=fd7dfe59` in URL) shows a blank message list. Navigating away and back via the sidebar works correctly because the sidebar scans real JSONL filenames (`db97cafb.jsonl`) and loads the session with the correct ID.

**Expected:** Hard page refresh should re-render the full message history.

**Root cause:** `apps/server/src/routes/sessions.ts` line 126

```typescript
const { messages } = await transcriptReader.readTranscript(cwd, sessionId);
```

`sessionId` here is the raw URL parameter (`fd7dfe59`). The JSONL file on disk is named `db97cafb.jsonl` — the SDK-assigned session ID. So `readTranscript()` looks for `~/.claude/projects/.../{fd7dfe59}.jsonl`, which does not exist, and returns an empty array.

**Why IDs differ:** On first `query()` call, the Claude Agent SDK generates its own session ID independently. DorkOS creates a session with UUID `fd7dfe59`; the SDK assigns `db97cafb` and writes `db97cafb.jsonl`. DorkOS tracks the mapping in `agentManager.sdkSessionIndex`. The server emits a `done` event redirect at `routes/sessions.ts:264-272` with `{ sessionId: actualSdkId }` so the client can update its URL. However:

1. A second `done` event is emitted immediately after (from the end of the generator) with the original session ID, potentially racing with the first
2. If the client misses the redirect (e.g., before first message completes), any hard refresh uses the stale URL ID
3. Even on a clean load, `GET /messages` never translates the URL session ID to the SDK session ID

**Fix (two parts):**

Part A — `routes/sessions.ts` GET `/messages` handler: Translate the URL session ID to the SDK session ID before reading the transcript.

```typescript
// Translate to SDK session ID if available
const sdkSessionId = agentManager.getSdkSessionId(sessionId) ?? sessionId;
const { messages } = await transcriptReader.readTranscript(cwd, sdkSessionId);
```

Part B — Ensure the redirect `done` event is reliable. Remove the second `done` event emission from the generator if the first one with `actualSdkId` is already sent, or ensure the client handler merges rather than overwrites on the second `done`.

**ADR context:** Session ID handling is covered by the session architecture section of CLAUDE.md. The `sdkSessionIndex` mapping exists precisely for this translation but is only used in a few places.

---

### 3. `<relay_context>` Metadata Appears as User Messages — **Bug**

**Observed:** In chat history (history view after reload), every relay-dispatched message renders a visible user message block containing raw relay metadata:

```
<relay_context>
Agent-ID: fd7dfe59-...
Session-ID: db97cafb-...
From: relay.system.pulse.schedule-x
Message-ID: msg-...
Budget remaining:
- Hops: 0 of 5 used
...
</relay_context>
```

All session titles also show `Agent-ID: fd7dfe59...` instead of the actual user prompt content.

**Expected:** Relay metadata should be stripped from rendered history. Session titles should show the first actual user-authored message.

**Root cause (two files):**

**A.** `apps/server/src/services/session/transcript-parser.ts` — `parseTranscript()` function, around line 226.

The parser already skips several internal message types:

```typescript
if (text.startsWith('<task-notification>')) continue;
if (text.startsWith('<command-name>')) continue;
if (text.startsWith('<local-command')) continue;
```

But `<relay_context>` is not in this list. When relay is enabled, the `ClaudeCodeAdapter` (`packages/relay/src/adapters/claude-code-adapter.ts:782`) prepends `<relay_context>...</relay_context>\n\ncontent` to every dispatched message. This appears verbatim in the JSONL and is parsed as a regular user message.

**Fix for A:**

```typescript
// In transcript-parser.ts, alongside other special-message filters:
if (text.startsWith('<relay_context>')) continue;
```

**B.** `apps/server/src/services/session/transcript-reader.ts` — `extractSessionMeta()`, around line 247.

Title extraction also checks for special message types but is missing `<relay_context>`:

```typescript
if (
  text.startsWith('<local-command') ||
  text.startsWith('<command-name>') ||
  text.startsWith('<command-message>') ||
  text.startsWith('<task-notification>')
) {
  continue;
}
```

**Fix for B:**

```typescript
if (
  text.startsWith('<local-command') ||
  text.startsWith('<command-name>') ||
  text.startsWith('<command-message>') ||
  text.startsWith('<task-notification>') ||
  text.startsWith('<relay_context>') // ← add this
) {
  continue;
}
```

**Scope:** Only affects Relay-enabled sessions. The `<relay_context>` block is only injected when `DORKOS_RELAY_ENABLED=true`. Non-relay sessions are unaffected.

---

### 4. Model / Permission Mode Selectors Reset Each Other — **Bug**

**Observed:** In Phase 3 (test configuration), opening the model selector and choosing a model caused the permission mode display to reset to "Default". Opening the permission mode selector and choosing a value caused the model to reset to `claude-sonnet-4-6`. Setting permission mode _last_ (after model) preserved both values.

**Expected:** Selecting one field should not affect the other. Both should persist independently.

**Root cause:** Two compounding issues:

**A. Server PATCH response may return incomplete data** (`apps/server/src/routes/sessions.ts` lines 130-151):

```typescript
// The PATCH reads session from disk (may lack one field)
const session = await transcriptReader.getSession(cwd, sessionId);
if (session) {
  session.permissionMode = permissionMode ?? session.permissionMode;
  session.model = model ?? session.model;
}
res.json(session ?? { id: sessionId, permissionMode, model });
```

If `session.model` or `session.permissionMode` is not yet persisted to JSONL (i.e., it was only set in-memory), the response may omit the field entirely.

**B. Client sets TanStack Query cache with full replacement** (`apps/client/src/layers/entities/session/model/use-session-status.ts`):

```typescript
queryClient.setQueryData(['session', sessionId, selectedCwd], updated);
```

`updated` comes from the server response. If the response is missing `permissionMode`, the cache loses the previously-displayed value. The priority chain `permissionMode = localPermissionMode ?? session?.permissionMode ?? 'default'` falls through to `'default'` because `localPermissionMode` was cleared after the model mutation resolved.

**Fix (client-side, targeted):** Merge the PATCH response with the existing cache instead of replacing:

```typescript
queryClient.setQueryData(['session', sessionId, selectedCwd], (old) => ({
  ...old,
  ...updated,
}));
```

This ensures a model update doesn't clobber a recently-set permission mode (and vice versa). The server-side fix (always returning both fields) would also be beneficial but the client-side merge is the safer minimal fix.

**Files:**

- `apps/client/src/layers/entities/session/model/use-session-status.ts` — `setQueryData` call (primary fix)
- `apps/server/src/routes/sessions.ts` lines 130-151 (secondary fix: always return complete session)

---

## Observations (No Issues)

**What worked correctly:**

- **Tool call cards**: All tool calls (Task, Bash, TodoWrite) rendered with correct icons, collapsible cards, and ✓ completion badges.
- **Background agent flow**: Message 4 (Task tool with `run_in_background: true`) correctly showed a task-notification block in history and a tool_result after polling resolved.
- **Code block rendering**: Syntax-highlighted code blocks rendered correctly in both live streaming and history reload (markdown via `streamdown`).
- **TodoWrite integration**: TaskListPanel updated correctly after messages 6 and 7 (TodoWrite and status update).
- **Short responses**: Message 8 ("2+2=4", 9 tokens) completed immediately without any streaming freeze — confirming the SSE freeze is a threshold issue.
- **History via sidebar navigation**: Clicking a different session then clicking back correctly re-renders message history from the JSONL SDK ID.
- **Model and permission displayed in history**: After sidebar navigation, the status bar correctly shows `claude-haiku-4-5` and permission mode from the JSONL `init` event.
- **No console errors during streaming**: No JavaScript errors or uncaught rejections in the browser console during any of the 8 messages.
- **Session lock/unlock**: No 409 conflicts during the test — session locking worked correctly.

---

## Priority Summary

| #   | Issue                                       | Severity      | Files to Change                                |
| --- | ------------------------------------------- | ------------- | ---------------------------------------------- |
| 1   | SSE streaming freeze (backpressure ignored) | P0 — CRITICAL | `stream-adapter.ts`, `routes/sessions.ts`      |
| 2   | Hard refresh → blank chat (ID mismatch)     | P0 — CRITICAL | `routes/sessions.ts`                           |
| 3   | `<relay_context>` shown as chat messages    | P1 — High     | `transcript-parser.ts`, `transcript-reader.ts` |
| 4   | Model/permission mode selectors reset       | P2 — Medium   | `use-session-status.ts`                        |
