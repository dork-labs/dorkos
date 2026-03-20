# Chat Streaming & Session Reliability Fixes

**Status:** Draft
**Authors:** Claude (chat:self-test), 2026-03-05
**Spec number:** 093
**Slug:** `chat-streaming-session-reliability`

---

## Overview

Fix four bugs discovered during automated self-test of the DorkOS chat UI. Two are P0 (data loss / blank UI), one is P1 (relay metadata leaking into chat history), one is P2 (status bar selectors resetting each other). All fixes are surgical — no architecture changes required.

---

## Background / Problem Statement

A live browser self-test (`/chat:self-test`) sent 8 messages through the full stack and compared DOM state against the API and JSONL transcripts. Four bugs were reproduced:

1. **SSE streaming freeze (P0):** Responses longer than ~100 tokens stall mid-delivery. The Stop button stays visible; the JSONL transcript has the complete response. The server-side SSE writer ignores Node's backpressure signal, causing the OS socket buffer to fill and the async generator to stall.

2. **Blank chat on hard refresh (P0):** The URL `?session=` parameter holds a client-facing relay UUID (e.g. `fd7dfe59`). The JSONL file on disk is named with the SDK-assigned UUID (`db97cafb`). `GET /api/sessions/:id/messages` looks up the JSONL by the raw URL parameter, finds no file, and returns an empty message list.

3. **`<relay_context>` shown as user messages (P1):** When Relay is enabled, `ClaudeCodeAdapter` prepends a `<relay_context>` XML block to every dispatched message. The transcript parser and title extractor already filter other internal message types (`<task-notification>`, `<command-name>`, `<local-command`) but not `<relay_context>`. Raw relay metadata appears in the chat history and all session titles show `Agent-ID: ...`.

4. **Model/permission mode selectors reset each other (P2):** PATCH `/api/sessions/:id` may return a session object that is missing one field (the field not being changed). The client replaces the full TanStack Query cache entry with this partial object, losing the previously-set value.

---

## Goals

- Responses of any length stream to completion without manual Stop
- Hard page refresh with a `?session=` URL parameter renders the correct message history
- `<relay_context>` metadata is invisible in chat history and session titles
- Selecting a model does not reset the permission mode (and vice versa)
- All fixes are covered by targeted unit/integration tests

## Non-Goals

- Refactoring the session ID architecture (dual-ID system is retained as-is)
- Relay context format changes or removal
- Changing how the SDK assigns session IDs
- Client-side buffering or chunked rendering optimizations

---

## Technical Dependencies

| Dependency                       | Notes                                                |
| -------------------------------- | ---------------------------------------------------- |
| Node.js `http.ServerResponse`    | `write()` returns `boolean`; `drain` event on socket |
| Express `Response`               | Thin wrapper over Node's `http.ServerResponse`       |
| TanStack Query v5                | `setQueryData` updater function pattern              |
| `agentManager.getSdkSessionId()` | Already exists in `agent-manager.ts:415`             |

No new libraries. No schema or database changes.

---

## Detailed Design

### Fix 1: SSE Backpressure (`stream-adapter.ts`)

**Root cause:** `res.write()` returns `false` when Node's socket write buffer is full (default ~16KB for HTTP/1.1 keep-alive). The current implementation ignores this signal. When backpressure triggers, subsequent writes block the event loop, causing the `for await` loop in the route handler to stall.

**Change:** Convert `sendSSEEvent` to an async function that awaits the `drain` event when `write()` returns `false`.

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

Combining the two `res.write()` calls into one reduces the number of times backpressure can trigger per event.

**Call site update (`routes/sessions.ts`):** The `for await` loop must `await` each call:

```typescript
// routes/sessions.ts (legacy SSE path)
for await (const event of agentManager.sendMessage(sessionId, content, { cwd })) {
  await sendSSEEvent(res, event);   // was: sendSSEEvent(res, event)
  ...
}
```

Any other call sites of `sendSSEEvent` (relay route, sync broadcaster) must also be updated to `await`.

**Why this is safe:**

- `drain` fires once the buffer drains below the highWaterMark — it does not wait for the client to consume all buffered data
- The generator in `agent-manager.ts` naturally pauses while we await drain, providing end-to-end flow control
- Client disconnect causes `res.destroy()` → `drain` never fires → generator is garbage-collected with the request

**Performance:** No measurable overhead for responses under the highWaterMark (~99% of chat responses). For long responses (code generation, analysis), drain is typically sub-millisecond.

---

### Fix 2: Session ID Translation for GET /messages (`routes/sessions.ts`)

**Root cause:** `GET /api/sessions/:id/messages` calls `transcriptReader.readTranscript(cwd, sessionId)` where `sessionId` is the raw URL parameter (client-facing relay UUID). The JSONL file on disk uses the SDK-assigned UUID. After the first message, these diverge; the file is not found; an empty message list is returned.

**Background:** The server maintains a `sdkSessionIndex` Map in `agentManager` that maps SDK UUIDs ↔ DorkOS UUIDs. `getSdkSessionId(id)` translates a DorkOS session ID to its SDK session ID.

**Change:** Resolve the SDK session ID before reading the transcript. Apply the same translation to `getSession()` (used for session metadata) and `readTranscript()` (used for message history).

```typescript
// routes/sessions.ts — GET /:id/messages handler

router.get('/:id/messages', async (req, res) => {
  const sessionId = req.params.id;
  const cwd = (req.query.cwd as string | undefined) ?? defaultCwd;

  // Translate client-facing session ID to SDK-assigned JSONL filename
  const sdkSessionId = agentManager.getSdkSessionId(sessionId) ?? sessionId;

  const { messages } = await transcriptReader.readTranscript(cwd, sdkSessionId);
  res.json({ messages });
});
```

Similarly, the `GET /:id` (single session metadata) handler should use the same translation:

```typescript
const sdkSessionId = agentManager.getSdkSessionId(sessionId) ?? sessionId;
const session = await transcriptReader.getSession(cwd, sdkSessionId);
```

**Fallback:** `getSdkSessionId()` returns `undefined` if the session is not in memory (e.g., server restart). The `?? sessionId` fallback preserves the existing behavior for sessions loaded from disk via the sidebar (which already use the correct SDK UUID as the session ID).

**Related:** The `done` event redirect in the streaming handler (`routes/sessions.ts:264-272`) correctly sends the SDK session ID to the client. That mechanism stays; this fix handles the case where the client still has the old URL ID (hard refresh before update propagates).

---

### Fix 3: Filter `<relay_context>` from History & Titles

**Root cause:** `ClaudeCodeAdapter` prepends a `<relay_context>` XML block to every dispatched message. The block is written to the JSONL transcript as a regular user message. Both `transcript-parser.ts` and `transcript-reader.ts` filter other internal message types but not `<relay_context>`.

**Change A — `transcript-parser.ts`:** Add a filter alongside the existing ones (around line 226):

```typescript
if (text.startsWith('<task-notification>')) {
  continue;
}

// Add after task-notification filter:
if (text.startsWith('<relay_context>')) {
  continue;
}
```

This prevents `<relay_context>` blocks from appearing as user messages in the rendered chat history.

**Change B — `transcript-reader.ts`:** Add `<relay_context>` to the skip condition in `extractSessionMeta()` (around line 247):

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

This ensures the session title is derived from the first genuine user-authored message, not the relay metadata header.

**Scope:** Only affects sessions where `DORKOS_RELAY_ENABLED=true`. Non-relay sessions never contain `<relay_context>` blocks in their JSONL, so this filter is a no-op for them.

**Why not strip on write?** The JSONL is the source of truth (ADR-0003). We do not modify what the SDK writes. Filtering at parse time is the established pattern for all other internal message types.

---

### Fix 4: Merge PATCH Response into TanStack Query Cache (`use-session-status.ts`)

**Root cause:** The PATCH `/api/sessions/:id` response may not include both `model` and `permissionMode`. When the client updates only `model`, the server reads the session from disk — which may not yet reflect a previously-set `permissionMode` (stored only in memory) — and returns a partial object. `queryClient.setQueryData(key, updated)` replaces the entire cache entry, discarding the cached `permissionMode`.

**Change:** Use the updater-function form of `setQueryData` to merge rather than replace:

```typescript
// use-session-status.ts, updateSession callback (line 84)

// Before:
queryClient.setQueryData(['session', sessionId, selectedCwd], updated);

// After:
queryClient.setQueryData(['session', sessionId, selectedCwd], (old: Session | undefined) => ({
  ...old,
  ...updated,
}));
```

This ensures a model update preserves the cached permission mode and vice versa.

**Secondary fix (server-side, defense-in-depth):** The PATCH handler in `routes/sessions.ts` should ensure both fields are always returned, even when only one was changed:

```typescript
// routes/sessions.ts — PATCH handler
const session = await transcriptReader.getSession(cwd, sdkSessionId);
const inMemory = agentManager.getSession(sessionId); // in-memory state

const result = {
  ...session,
  model: model ?? inMemory?.model ?? session?.model,
  permissionMode:
    permissionMode ?? inMemory?.permissionMode ?? session?.permissionMode ?? 'default',
};
res.json(result);
```

The client-side merge fix alone is sufficient to fix the bug; the server-side fix ensures the response data is more complete for any future consumers.

---

## Data Flow (Fixes 1 & 2 Combined)

```
User sends message
  → POST /api/sessions/{dorkos-uuid}/messages
       → agentManager.sendMessage()
            → SDK query() → yields StreamEvents
                 → await sendSSEEvent(res, event)   [Fix 1: respects backpressure]
                      → drain if needed
  ← SSE events arrive at client (no freeze)
  ← done event: { sessionId: sdk-uuid }
       → client updates URL: ?session=sdk-uuid      [existing redirect mechanism]

User presses Cmd+R (hard refresh with old URL)
  → GET /api/sessions/{dorkos-uuid}/messages
       → getSdkSessionId(dorkos-uuid) → sdk-uuid   [Fix 2: ID translation]
       → readTranscript(cwd, sdk-uuid)
            → reads ~/.claude/projects/.../{sdk-uuid}.jsonl
  ← messages returned → chat history renders
```

---

## User Experience

After these fixes, the user experiences:

- **Streaming:** Long code blocks, analysis, and multi-step tool use all stream fully to the UI without freezing. The Stop button disappears naturally when the response completes.
- **Hard refresh:** Pressing Cmd+R reloads the full message history for the current session, identical to navigating away and back via the sidebar.
- **Relay sessions:** Chat history shows only user-authored messages. Session titles in the sidebar reflect the actual first user message, not relay metadata.
- **Status bar:** Selecting a model, then opening the permission mode picker, shows the previously-selected model unchanged. Both fields are independent.

---

## Testing Strategy

### Fix 1: SSE Backpressure

**Unit test** (`apps/server/src/services/__tests__/stream-adapter.test.ts`):

```typescript
it('waits for drain before resolving when write returns false', async () => {
  // Purpose: verify that sendSSEEvent does not lose data when the socket buffer is full
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
  // Purpose: confirm no overhead added when backpressure is not triggered
  const mockRes = { write: vi.fn().mockReturnValue(true), once: vi.fn() };
  await sendSSEEvent(mockRes as unknown as Response, { type: 'done', data: {} });
  expect(mockRes.once).not.toHaveBeenCalled();
});
```

### Fix 2: Session ID Translation

**Unit test** (`apps/server/src/routes/__tests__/sessions.test.ts`):

```typescript
it('uses SDK session ID when fetching message history', async () => {
  // Purpose: verify GET /messages translates client-facing ID to SDK JSONL filename
  agentManager.getSdkSessionId.mockReturnValue('sdk-uuid-123');
  transcriptReader.readTranscript.mockResolvedValue({
    messages: [{ role: 'user', content: 'hi' }],
  });

  const res = await request(app).get('/api/sessions/client-uuid-456/messages');

  expect(transcriptReader.readTranscript).toHaveBeenCalledWith(expect.any(String), 'sdk-uuid-123');
  expect(res.body.messages).toHaveLength(1);
});

it('falls back to URL session ID when not in agentManager', async () => {
  // Purpose: verify sessions loaded from disk (sidebar navigation) still work
  agentManager.getSdkSessionId.mockReturnValue(undefined);
  transcriptReader.readTranscript.mockResolvedValue({ messages: [] });

  await request(app).get('/api/sessions/some-sdk-uuid/messages');

  expect(transcriptReader.readTranscript).toHaveBeenCalledWith(expect.any(String), 'some-sdk-uuid');
});
```

### Fix 3: relay_context Filter

**Unit test** (`apps/server/src/services/__tests__/transcript-parser.test.ts`):

```typescript
it('filters relay_context blocks from parsed messages', () => {
  // Purpose: confirm relay metadata never reaches the chat UI
  const jsonl = [
    JSON.stringify({
      type: 'user',
      message: { content: '<relay_context>\nAgent-ID: abc\n</relay_context>\n\nDo a thing' },
    }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } }),
  ].join('\n');

  const messages = parseTranscript(jsonl);
  const userMessages = messages.filter((m) => m.role === 'user');

  // relay_context block should be filtered; the actual content after \n\n should render
  expect(userMessages[0].content).toBe('Do a thing');
  expect(userMessages[0].content).not.toContain('<relay_context>');
});
```

**Unit test** (`apps/server/src/services/__tests__/transcript-reader.test.ts`):

```typescript
it('skips relay_context when extracting session title', async () => {
  // Purpose: session title should reflect the first real user message, not relay metadata
  const jsonl = [
    JSON.stringify({
      type: 'user',
      message: { content: '<relay_context>\nAgent-ID: abc\n</relay_context>\n\nAnalyze logs' },
    }),
  ].join('\n');

  mockFs.readFile.mockResolvedValue(Buffer.from(jsonl));
  const session = await reader.getSession('/cwd', 'session-id');

  expect(session.title).toBe('Analyze logs');
  expect(session.title).not.toContain('Agent-ID');
});
```

### Fix 4: TanStack Query Merge

**Unit test** (`apps/client/src/layers/entities/session/model/__tests__/use-session-status.test.ts`):

```typescript
it('preserves existing permissionMode when updating model', async () => {
  // Purpose: prove the merge strategy prevents cross-field reset
  const { result } = renderHook(() => useSessionStatus('session-1'), { wrapper: Wrapper });

  // Prime cache with both fields
  act(() =>
    queryClient.setQueryData(['session', 'session-1', undefined], {
      id: 'session-1',
      model: 'claude-haiku-4-5',
      permissionMode: 'acceptEdits',
    })
  );

  // Server returns only the updated field
  mockTransport.updateSession.mockResolvedValue({ id: 'session-1', model: 'claude-opus-4-6' });

  await act(() => result.current.updateSession({ model: 'claude-opus-4-6' }));

  const cached = queryClient.getQueryData(['session', 'session-1', undefined]);
  expect(cached).toMatchObject({
    model: 'claude-opus-4-6',
    permissionMode: 'acceptEdits', // must be preserved
  });
});
```

---

## Performance Considerations

- **Fix 1:** No overhead for responses under the highWaterMark. For long responses, the `drain` await is typically sub-millisecond (the socket processes buffered data). This change removes the current silent data loss that forces users to click Stop.
- **Fix 2:** `getSdkSessionId()` is an in-memory Map lookup — O(1), negligible cost.
- **Fix 3:** `text.startsWith('<relay_context>')` is a string prefix check — O(1).
- **Fix 4:** Object spread (`{ ...old, ...updated }`) is O(n) where n is session field count (< 15 fields). Negligible.

---

## Security Considerations

- **Fix 1:** No new attack surface. Drain handling is internal to the HTTP response lifecycle.
- **Fix 2:** Session ID translation uses in-memory state only — no new disk or network access. The `getSdkSessionId()` fallback to the URL param preserves existing path traversal protections in `transcript-reader.ts`.
- **Fix 3:** Filtering relay metadata at parse time reduces information leakage — relay session IDs, hop counts, and TTLs are no longer visible to anyone viewing the chat history.
- **Fix 4:** Cache merge is client-side only; no new data is sent to the server.

---

## Documentation

Update `contributing/architecture.md` to note that:

- `sendSSEEvent` is async and must be awaited
- `GET /api/sessions/:id/messages` applies `getSdkSessionId()` translation before JSONL lookup

No user-facing documentation changes needed; these are all internal reliability fixes.

---

## Implementation Phases

### Phase 1 — Core Fixes (P0 bugs)

1. Update `stream-adapter.ts` to make `sendSSEEvent` async with drain handling
2. Update all call sites of `sendSSEEvent` to `await` it
3. Update `routes/sessions.ts` GET `/messages` to translate session ID

### Phase 2 — Relay & UX Fixes (P1, P2 bugs)

4. Add `<relay_context>` filter to `transcript-parser.ts`
5. Add `<relay_context>` skip to `transcript-reader.ts` title extraction
6. Update `use-session-status.ts` `setQueryData` to use merge updater function

### Phase 3 — Tests & Documentation

7. Add unit tests for all four fixes
8. Update architecture docs for async `sendSSEEvent`

---

## Open Questions

- **Should the `done` event redirect be made unconditional?** Currently it only fires when `actualSdkId !== sessionId`. Making it unconditional (always including the SDK session ID in the `done` event) would make Fix 2 less necessary over time as clients always update their URL. However, Fix 2 (translate in GET /messages) is still needed for hard refresh before the first message.
- **Should `<relay_context>` content after the closing tag be rendered?** Currently a `<relay_context>` message like `<relay_context>...\n</relay_context>\n\nDo a thing` has the actual content on the same JSONL line after the closing tag. Fix 3 as specified `continue`s the entire message, dropping the `Do a thing` part too. The relay adapter dispatches the full user message separately — the `<relay_context>` line in the JSONL is the pre-pended header injected into the same message. We need to confirm whether the content after `</relay_context>` should be preserved as a rendered user message or dropped. See `claude-code-adapter.ts:782` for the exact format.

---

## Related ADRs

- **ADR-0003** (`decisions/0003-sdk-jsonl-as-single-source-of-truth.md`) — JSONL is source of truth; filtering happens at parse time (Fix 3 follows this pattern)
- **ADR-0005** (`decisions/0005-zustand-ui-state-tanstack-query-server-state.md`) — TanStack Query for server state; Fix 4 uses the updater-function pattern
- **ADR-0026** (`decisions/0026-receipt-plus-sse-console-protocol.md`) — SSE streaming protocol; Fix 1 makes the write path correct under backpressure
- **ADR-0029** (`decisions/0029-replace-message-receiver-with-claude-code-adapter.md`) — ClaudeCodeAdapter inserts relay_context; Fix 3 filters it at render time

---

## References

- Findings report: `plans/2026-03-05-chat-self-test-findings.md`
- Node.js backpressure guide: https://nodejs.org/en/docs/guides/backpressuring-in-streams/
- Node.js `response.write()` docs: https://nodejs.org/api/http.html#responsewritechunk-encoding-callback
- TanStack Query `setQueryData` updater: https://tanstack.com/query/latest/docs/reference/QueryClient#queryclientsetquerydata
- `apps/server/src/services/core/stream-adapter.ts` — SSE writer (Fix 1)
- `apps/server/src/routes/sessions.ts:126` — GET /messages handler (Fix 2)
- `apps/server/src/routes/sessions.ts:264` — done event redirect (Fix 2 context)
- `apps/server/src/services/session/transcript-parser.ts:226` — message filters (Fix 3)
- `apps/server/src/services/session/transcript-reader.ts:247` — title extraction (Fix 3)
- `apps/client/src/layers/entities/session/model/use-session-status.ts:84` — setQueryData (Fix 4)
- `packages/relay/src/adapters/claude-code-adapter.ts:782` — relay_context injection (Fix 3 context)
