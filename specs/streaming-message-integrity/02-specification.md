# Streaming Message Integrity — Specification

**Spec #:** 150
**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-19
**Slug:** streaming-message-integrity

---

## Overview

Fix two bugs in the DorkOS chat UI caused by the post-stream history replace in `use-chat-session.ts`, extend the transcript parser to extract error/subagent/hook parts from JSONL, and implement server-echo ID to eliminate content/position-based message matching.

**Phase 1** (client-only) fixes both bugs immediately by skipping the post-stream replace and using tagged-message dedup. **Phase 2** (server-side) fixes data loss when loading past sessions from disk. **Phase 3** (client + server) replaces content/position matching with exact ID-based dedup via the `done` SSE event.

---

## Background / Problem Statement

### Bug 1: Message Flash on Stream Completion

When an agent finishes responding, all chat messages visibly flash — they disappear and reappear. This happens because `executeSubmission` (`use-chat-session.ts:434`) resets `historySeededRef.current = false` and invalidates queries (`use-chat-session.ts:439`). The seed effect then runs with **stale** history data (the refetch hasn't returned yet), performing a full `setMessages(history.map(mapHistoryMessage))` replace. Messages briefly vanish, then reappear when fresh data arrives.

### Bug 2: Disappearing Error Messages

Inline `ErrorMessageBlock` components (e.g., `execution_error` from hook validation failures) vanish permanently after the agent finishes responding. The error is visible during streaming (pushed to `currentPartsRef` at `stream-event-handler.ts:168-173`) but lost when the post-stream replace swaps the streaming assistant message for the server's version. The server's version lacks the error part because the transcript parser (`transcript-parser.ts`) only extracts `thinking`, `text`, and `tool_use` blocks.

### Why the Replace Exists

The post-stream replace solves an **ID mismatch problem**. During streaming, the client creates messages with `crypto.randomUUID()` IDs. The server's JSONL transcript uses different SDK-assigned IDs. Without the replace, both copies appear as duplicates (the incremental append path deduplicates by ID, so different IDs = different messages).

A secondary purpose: when the SDK assigns a different session ID than the client-generated one (session remap on first message), the done handler clears messages with `setMessages([])` and triggers a remap.

### Data Loss from History Replace

| Data Element       | In SSE Stream?         | In JSONL History? | Impact                 |
| ------------------ | ---------------------- | ----------------- | ---------------------- |
| Text response      | Yes                    | Yes               | No loss                |
| Thinking blocks    | Yes (with `elapsedMs`) | Text only         | Duration lost          |
| Tool calls         | Yes                    | Yes               | No loss                |
| **Error parts**    | Yes                    | **No**            | Errors vanish          |
| **Subagent parts** | Yes                    | **No**            | Multi-agent invisible  |
| **Hook parts**     | Yes                    | **No**            | Build/test output lost |
| **Tool progress**  | Yes                    | **No**            | Real-time output lost  |

---

## Goals

- Messages do NOT flash/disappear when the agent finishes responding
- Inline error messages persist after streaming ends
- Subagent and hook parts persist after streaming ends
- Cross-client sync and message polling continue to work correctly
- Session ID remap does not clear visible messages
- Loading a past session from disk shows error/subagent/hook parts
- Server-echo ID correctly remaps client IDs to server IDs via `done` event
- Fallback to tagged-dedup works when server doesn't provide `messageIds`

---

## Non-Goals

- Event-sourced chat model (correct long-term direction, overkill for these bugs)
- Moving streaming state from local React state into TanStack Query cache (deliberate architecture choice)
- Adopting SDK's `getSessionMessages()` API (returns `unknown`, doesn't solve data loss)
- Tool progress extraction from JSONL (SDK doesn't persist it — separate concern)
- Thinking `elapsedMs` timing recovery from JSONL (SDK stores text only)

---

## Technical Dependencies

| Dependency       | Version   | Role                                     |
| ---------------- | --------- | ---------------------------------------- |
| React            | 19        | Component state, effects                 |
| TanStack Query   | 5.x       | History polling, cache invalidation      |
| Zod              | 3.x       | Schema validation (MessagePartSchema)    |
| Vitest           | 3.x       | Unit testing                             |
| `@dorkos/shared` | workspace | MessagePart union, HistoryMessage schema |

No new external dependencies required.

---

## Detailed Design

### Phase 1: Tagged-Dedup (Client-Only — Fixes Both Bugs)

#### Step 1: Add `_streaming` flag to ChatMessage

Add an optional `_streaming` boolean to the `ChatMessage` interface in `chat-types.ts:3-13`. This follows the existing underscore-prefix convention for client-only fields (`_partId` in `StreamingTextPart` at `stream-event-types.ts:9-12`).

```typescript
// chat-types.ts
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  toolCalls?: ToolCallState[];
  parts: MessagePart[];
  timestamp: string;
  messageType?: 'command' | 'compaction';
  commandName?: string;
  commandArgs?: string;
  /** @internal Client-only tag for streaming messages awaiting server ID reconciliation. */
  _streaming?: boolean;
}
```

#### Step 2: Tag streaming messages on creation

**Optimistic user message** (`use-chat-session.ts:391-400`): Add `_streaming: true` to the message object.

```typescript
// use-chat-session.ts — inside executeSubmission
setMessages((prev) => [
  ...prev,
  {
    id: pendingUserId,
    role: 'user' as const,
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: new Date().toISOString(),
    _streaming: true,
  },
]);
```

**Streaming assistant message** (`stream-event-helpers.ts:74-84`): Add `_streaming: true` to the message created by `ensureAssistantMessage`.

```typescript
// stream-event-helpers.ts — inside ensureAssistantMessage
setMessages((prev) => [
  ...prev,
  {
    id: assistantId,
    role: 'assistant',
    content: '',
    toolCalls: [],
    parts: [],
    timestamp: new Date().toISOString(),
    _streaming: true,
  },
]);
```

#### Step 3: Stop resetting `historySeededRef` after streaming

Remove the post-stream reset sequence in `executeSubmission` (`use-chat-session.ts:431-439`):

```typescript
// BEFORE (lines 431-439):
// Reset seed flag so the next history fetch does a full replace instead of
// an incremental append. This prevents ID-mismatch duplicates: the streaming
// assistant has a client-generated UUID while history has an SDK-assigned UUID.
historySeededRef.current = false;
pendingUserIdRef.current = null;
// Invalidate broadly to cover session ID remaps (client UUID → SDK UUID).
// The old targetSessionId may differ from the SDK-assigned ID returned in
// the done event, so a narrow key would miss the active query.
queryClient.invalidateQueries({ queryKey: ['messages'] });
setStatus('idle');

// AFTER:
pendingUserIdRef.current = null;
setStatus('idle');
```

After streaming ends, the local messages stay as-is. No flash, no data loss. The existing polling interval (`refetchInterval` on the history query) handles eventual consistency.

#### Step 4: Smart dedup in the incremental append path

Rewrite the seed effect's Branch 2 (`use-chat-session.ts:299-306`) to handle tagged messages:

```typescript
// use-chat-session.ts — seed effect, Branch 2
if (historySeededRef.current && !isStreaming) {
  const currentIds = new Set(messagesRef.current.map((m) => m.id));
  const taggedMessages = messagesRef.current.filter((m) => m._streaming);

  // Find the tagged user message (if any) for content matching
  const taggedUser = taggedMessages.find((m) => m.role === 'user');
  const taggedAssistant = taggedMessages.find((m) => m.role === 'assistant');

  const newMessages: typeof history = [];
  let matchedUserIdx = -1;

  for (let i = 0; i < history.length; i++) {
    const serverMsg = history[i];
    if (currentIds.has(serverMsg.id)) continue;

    // Try to match tagged user message by exact content
    if (taggedUser && serverMsg.role === 'user' && serverMsg.content === taggedUser.content) {
      matchedUserIdx = i;
      // Replace tagged user with server version, clear tag
      setMessages((prev) =>
        prev.map((m) =>
          m.id === taggedUser.id ? { ...mapHistoryMessage(serverMsg), _streaming: false } : m
        )
      );
      continue;
    }

    // Match tagged assistant by position (immediately after matched user)
    if (
      taggedAssistant &&
      matchedUserIdx >= 0 &&
      i === matchedUserIdx + 1 &&
      serverMsg.role === 'assistant'
    ) {
      // Carry over client-only parts that the server version lacks
      const serverMapped = mapHistoryMessage(serverMsg);
      const clientOnlyParts = taggedAssistant.parts.filter(
        (p) => p.type === 'error' || p.type === 'subagent' || p.type === 'hook'
      );
      const mergedParts =
        clientOnlyParts.length > 0
          ? [...serverMapped.parts, ...clientOnlyParts]
          : serverMapped.parts;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === taggedAssistant.id
            ? { ...serverMapped, parts: mergedParts, _streaming: false }
            : m
        )
      );
      continue;
    }

    // No match — append as new message (existing behavior)
    newMessages.push(serverMsg);
  }

  if (newMessages.length > 0) {
    setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
  }
}
```

**Key properties:**

- The tagged set is bounded at 0-2 messages per streaming turn (one user, one assistant)
- Tags are cleared on match, so no unbounded growth
- User message matched by exact content (we submitted it — content is identical)
- Assistant message matched by position (immediately following the matched user in server history)
- Client-only parts (error, subagent, hook) are carried over to the server version since the transcript parser doesn't return them

#### Step 5: Handle session ID remap without clearing messages

In the done handler (`stream-event-handler.ts:256-267`), remove `setMessages([])` (line 265). Messages stay visible during remap:

```typescript
// BEFORE (lines 256-267):
case 'done': {
  const doneData = data as { sessionId?: string };
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    currentPartsRef.current = [];
    assistantCreatedRef.current = false;
    setMessages([]);
    onSessionIdChangeRef.current?.(doneData.sessionId);
  }
  // ...
}

// AFTER:
case 'done': {
  const doneData = data as { sessionId?: string; messageIds?: { user: string; assistant: string } };
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    currentPartsRef.current = [];
    assistantCreatedRef.current = false;
    // Keep messages on screen — tagged-dedup handles ID reconciliation
    onSessionIdChangeRef.current?.(doneData.sessionId);
  }
  // Phase 3: Handle server-echo IDs (see below)
  // ...
}
```

The session change effect + history fetch handle the transition. Tagged-message dedup prevents duplicates when the new session's history arrives.

---

### Phase 2: Transcript Parser Fix (Server-Side)

Extend `transcript-parser.ts` to extract error, subagent, and hook blocks from JSONL. The `MessagePartSchema` discriminated union in `packages/shared/src/schemas.ts` already defines all these types — the parser just needs to handle them.

#### Current parser behavior

The parser iterates JSONL content blocks and only handles three types:

```typescript
// Current: only thinking, text, tool_use
if (block.type === 'thinking') {
  /* ... */
}
if (block.type === 'text') {
  /* ... */
}
if (block.type === 'tool_use') {
  /* ... */
}
```

#### New block handlers

Add handlers for error, subagent, and hook blocks:

**Error blocks → `ErrorPart`** (schema at `schemas.ts:571-580`):

```typescript
if (block.type === 'error') {
  parts.push({
    type: 'error',
    errorType: block.error_type ?? 'unknown',
    message: block.message ?? '',
    category: block.category,
    details: block.details,
  });
}
```

**Subagent blocks → `SubagentPart`** (schema at `schemas.ts:545-558`):

```typescript
if (block.type === 'subagent') {
  parts.push({
    type: 'subagent',
    taskId: block.task_id ?? block.id ?? '',
    description: block.description ?? '',
    status: block.status ?? 'started',
    toolUses: block.tool_uses,
    lastToolName: block.last_tool_name,
    durationMs: block.duration_ms,
    summary: block.summary,
  });
}
```

**Hook blocks → `HookPart`** (schema at `schemas.ts:512-522`):

```typescript
if (block.type === 'hook') {
  parts.push({
    type: 'hook',
    hookId: block.hook_id ?? '',
    hookName: block.hook_name ?? '',
    hookEvent: block.hook_event ?? '',
    status: block.status ?? 'completed',
    stdout: block.stdout,
    stderr: block.stderr,
    exitCode: block.exit_code,
  });
}
```

**Note:** The exact JSONL block field names need to be confirmed against the SDK's actual output format. The parser should use defensive access (`block.field ?? fallback`) for any field that might be absent.

---

### Phase 3: Server-Echo ID (Client + Server)

Implement the industry-standard client-ID propagation pattern (Slack's `client_msg_id` → `ts` approach). This eliminates content/position matching by providing exact ID mapping.

#### Server changes

**1. Accept `clientMessageId` in streaming request body:**

The POST `/api/sessions/:id/messages` route (`sessions.ts:142-222`) already accepts `content` and `cwd` in the request body. Add an optional `clientMessageId` field:

```typescript
// sessions.ts — request body schema
const sendMessageSchema = z.object({
  content: z.string().min(1),
  cwd: z.string().optional(),
  clientMessageId: z.string().optional(),
});
```

**2. Extract JSONL-assigned message IDs after streaming:**

After the `for await` loop completes (line 208), read the JSONL transcript to extract the SDK-assigned IDs for the user and assistant messages:

```typescript
// sessions.ts — after streaming completes
const messageIds = await runtime.getLastMessageIds(sessionId);
```

The `getLastMessageIds` method reads the JSONL transcript and returns the IDs of the last user message and last assistant message. This is a new method on the `AgentRuntime` interface.

**3. Include `messageIds` in the `done` SSE event:**

```typescript
// sessions.ts — done event emission (lines 194-207)
if (event.type === 'done') {
  const actualInternalId = runtime.getInternalSessionId(sessionId);
  const lastMsgIds = await runtime.getLastMessageIds(actualInternalId ?? sessionId);
  const donePayload: Record<string, unknown> = {};

  if (actualInternalId && actualInternalId !== sessionId) {
    donePayload.sessionId = actualInternalId;
  }
  if (lastMsgIds) {
    donePayload.messageIds = lastMsgIds;
  }

  if (Object.keys(donePayload).length > 0) {
    await sendSSEEvent(res, { type: 'done', data: donePayload });
  }
}
```

**4. Implement `getLastMessageIds` in `ClaudeCodeRuntime`:**

```typescript
// claude-code-runtime.ts
async getLastMessageIds(
  sessionId: string,
): Promise<{ user: string; assistant: string } | null> {
  const messages = await this.transcriptParser.getMessages(sessionId);
  if (!messages?.length) return null;

  let lastUser: string | null = null;
  let lastAssistant: string | null = null;

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!lastAssistant && m.role === 'assistant') lastAssistant = m.id;
    if (!lastUser && m.role === 'user') lastUser = m.id;
    if (lastUser && lastAssistant) break;
  }

  if (!lastUser || !lastAssistant) return null;
  return { user: lastUser, assistant: lastAssistant };
}
```

**5. Add `getLastMessageIds` to the `AgentRuntime` interface:**

```typescript
// packages/shared/src/agent-runtime.ts
export interface AgentRuntime {
  // ... existing methods ...

  /**
   * Return the JSONL-assigned message IDs for the last user and assistant
   * messages in a session. Used for client-server ID reconciliation.
   *
   * @param sessionId - Session to query
   * @returns ID pair or null if not available
   */
  getLastMessageIds(sessionId: string): Promise<{ user: string; assistant: string } | null>;
}
```

#### Client changes

**1. Include client message IDs in the streaming request:**

In `executeSubmission`, pass the pending user ID and assistant ID in the request body:

```typescript
// use-chat-session.ts — inside executeSubmission
await transport.sendMessage(
  targetSessionId,
  finalContent,
  (event) => streamEventHandler(event.type, event.data, assistantIdRef.current),
  abortController.signal,
  selectedCwd ?? undefined,
  // Phase 3: include client IDs for server-echo
  { clientMessageId: pendingUserId }
);
```

This requires extending the `Transport.sendMessage` signature with an optional options parameter.

**2. Handle `messageIds` in the done event:**

In the done handler (`stream-event-handler.ts`), update in-memory message IDs when the server provides them:

```typescript
// stream-event-handler.ts — inside 'done' case
const doneData = data as {
  sessionId?: string;
  messageIds?: { user: string; assistant: string };
};

// Phase 3: Remap client IDs to server IDs
if (doneData.messageIds) {
  const { user: serverUserId, assistant: serverAssistantId } = doneData.messageIds;
  setMessages((prev) =>
    prev.map((m) => {
      if (m._streaming && m.role === 'user' && serverUserId) {
        return { ...m, id: serverUserId, _streaming: false };
      }
      if (m._streaming && m.role === 'assistant' && serverAssistantId) {
        return { ...m, id: serverAssistantId, _streaming: false };
      }
      return m;
    })
  );
}
```

After ID remap, the existing ID-based dedup in the seed effect works naturally — no content/position matching needed. The `_streaming` flag becomes transitional: set on creation, cleared on ID remap via done event.

**3. Backward compatibility:**

The `messageIds` field in the done event is optional. If absent (e.g., older server version), the client falls back to tagged-dedup (Phase 1 behavior). The `clientMessageId` in the request is also optional — the server ignores it if not present.

---

## User Experience

Users will not directly interact with this feature — it fixes existing bugs:

1. **No more flash**: When the agent finishes responding, messages stay stable on screen. No disappear/reappear cycle.
2. **Errors persist**: Inline error messages (hook failures, execution errors) remain visible in the conversation history after streaming ends.
3. **Session remap is seamless**: The first message in a new session no longer causes a blank flash during the SDK's session ID assignment.
4. **Past sessions show errors**: Opening a previous session from the sidebar shows error/subagent/hook parts that were previously lost (Phase 2).

---

## Testing Strategy

### Phase 1 Tests

**Update existing remap test** (`stream-event-handler-remap.test.ts`):

- Remove assertion that `setMessages([])` is called on remap
- Add assertion that messages are preserved during remap (setMessages NOT called with empty array)

**New tagged-dedup tests** (new file: `__tests__/tagged-dedup.test.ts`):

```typescript
describe('tagged-dedup in seed effect', () => {
  it('matches tagged user message by exact content', () => {
    // Setup: messagesRef has a tagged user message with client UUID
    // Action: seed effect receives server history with different ID but same content
    // Assert: tagged message replaced with server version, _streaming cleared
  });

  it('matches tagged assistant by position after matched user', () => {
    // Setup: messagesRef has tagged user + assistant
    // Action: server history has user (matched) followed by assistant
    // Assert: assistant replaced, _streaming cleared
  });

  it('carries over client-only parts on assistant match', () => {
    // Setup: tagged assistant has error part + subagent part
    // Action: server history assistant has no error/subagent parts
    // Assert: merged message has server content + client-only parts
  });

  it('does not match when content differs', () => {
    // Setup: tagged user with content "Hello"
    // Action: server history has user with content "Different"
    // Assert: no match — new message appended instead
  });

  it('appends unmatched server messages normally', () => {
    // Setup: no tagged messages
    // Action: server history has new messages
    // Assert: messages appended (existing behavior preserved)
  });

  it('clears _streaming flag on match', () => {
    // Assert: after match, the replaced message has _streaming: false (or undefined)
  });
});
```

**New post-stream stability test** (in `use-chat-session.test.ts` or new file):

```typescript
it('does not reset historySeededRef after streaming completes', () => {
  // Verify that historySeededRef stays true after executeSubmission resolves
  // This ensures the seed effect uses Branch 2 (incremental), not Branch 1 (full replace)
});
```

### Phase 2 Tests

**Transcript parser tests** (extend existing test file):

```typescript
describe('transcript-parser error/subagent/hook extraction', () => {
  it('extracts error blocks from JSONL as ErrorPart', () => {
    // Input: JSONL with an error content block
    // Assert: parsed message has ErrorPart in parts array
  });

  it('extracts subagent blocks from JSONL as SubagentPart', () => {
    // Input: JSONL with a subagent content block
    // Assert: parsed message has SubagentPart with correct fields
  });

  it('extracts hook blocks from JSONL as HookPart', () => {
    // Input: JSONL with a hook content block
    // Assert: parsed message has HookPart with stdout/stderr/exitCode
  });

  it('preserves existing text/thinking/tool_use extraction', () => {
    // Regression: ensure existing parsing still works
  });
});
```

### Phase 3 Tests

**Server-echo ID tests**:

```typescript
describe('done event with messageIds', () => {
  it('includes messageIds in done event when available', () => {
    // Setup: FakeAgentRuntime returns message IDs
    // Assert: done SSE event payload includes messageIds
  });

  it('omits messageIds when not available', () => {
    // Setup: FakeAgentRuntime returns null for getLastMessageIds
    // Assert: done event has no messageIds field
  });
});
```

**Client ID remap tests**:

```typescript
describe('client ID remap via done event', () => {
  it('updates message IDs when done event includes messageIds', () => {
    // Setup: tagged messages with client UUIDs
    // Action: done event fires with { messageIds: { user: 'sdk-1', assistant: 'sdk-2' } }
    // Assert: messages now have server IDs, _streaming cleared
  });

  it('falls back to tagged-dedup when messageIds absent', () => {
    // Setup: tagged messages
    // Action: done event fires without messageIds
    // Assert: tags remain, content/position dedup handles reconciliation on next poll
  });
});
```

---

## Performance Considerations

- **Tagged set is bounded**: 0-2 messages per streaming turn. Tags are cleared on match. No unbounded growth.
- **Dedup comparison**: O(n) where n = server messages per poll response, with a constant-factor check against the tagged set. Content string comparison only occurs against the user message (which is typically short).
- **Removed invalidation**: Removing `queryClient.invalidateQueries({ queryKey: ['messages'] })` after streaming eliminates one extra network request. The existing polling interval handles eventual consistency.
- **`getLastMessageIds`**: Reads the JSONL transcript once after streaming completes. The file is already in the OS page cache from the SDK writing it. Cost is negligible compared to the LLM inference that just completed.
- **No additional polling**: No new polling hooks or intervals introduced. Existing `refetchInterval` on the history query provides background sync.

---

## Security Considerations

- **`clientMessageId` in request body**: A free-form string from the client. The server does not use it for anything other than logging — it does not become a database key or file path. No injection risk.
- **`messageIds` in done event**: Server-generated IDs from the JSONL transcript. The client uses them to update in-memory state only (not for network requests or storage). No trust boundary issue.
- **Part preservation**: Client-only parts (error, subagent, hook) are carried over from in-memory messages to the merged version. These parts were already in client memory — no new data is introduced.

---

## Documentation

- Update `contributing/data-fetching.md` if it references the post-stream `invalidateQueries` pattern
- Update `contributing/architecture.md` if it documents the seed effect's three-branch structure
- The `_streaming` flag should be documented in the `ChatMessage` interface TSDoc (included in the code change)
- No external docs changes needed — this is an internal bug fix

---

## Implementation Phases

### Phase 1: Tagged-Dedup (Client-Only)

Fixes both bugs immediately. No server changes required. Can be shipped independently.

**Files changed:**
| File | Change |
|---|---|
| `chat-types.ts` | Add `_streaming?: boolean` to `ChatMessage` |
| `use-chat-session.ts` | Remove post-stream reset (lines 431-439); rewrite Branch 2 dedup; tag user message |
| `stream-event-helpers.ts` | Tag assistant message in `ensureAssistantMessage` |
| `stream-event-handler.ts` | Remove `setMessages([])` in remap; parse `messageIds` in done (prep for Phase 3) |

### Phase 2: Transcript Parser Fix (Server-Side)

Fixes data loss when loading past sessions from disk. Independent of Phase 1 — can be shipped in parallel.

**Files changed:**
| File | Change |
|---|---|
| `transcript-parser.ts` | Add error, subagent, hook block extraction |
| `transcript-parser.test.ts` | Add tests for new block types |

### Phase 3: Server-Echo ID (Client + Server)

Eliminates content/position matching. Depends on Phase 1 (uses `_streaming` flag infrastructure). Server changes can proceed independently of Phase 1 client changes.

**Files changed:**
| File | Change |
|---|---|
| `agent-runtime.ts` | Add `getLastMessageIds` to interface |
| `claude-code-runtime.ts` | Implement `getLastMessageIds` |
| `sessions.ts` | Include `messageIds` in done SSE event |
| `stream-event-handler.ts` | Handle `messageIds` in done event, remap IDs |
| `use-chat-session.ts` | Pass `clientMessageId` in streaming request |
| `transport.ts` | Extend `sendMessage` with options parameter |
| `FakeAgentRuntime` | Add `getLastMessageIds` stub |

---

## Open Questions

All questions from the ideation phase have been resolved. No remaining open questions.

---

## Related ADRs

| ADR      | Relevance                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------ |
| ADR-0018 | SSE event filtering — establishes SSE event type patterns                                              |
| ADR-0026 | Receipt + SSE protocol — server-to-client event delivery                                               |
| ADR-0091 | `watchSession` callback — session lifecycle monitoring                                                 |
| ADR-0093 | `queueMicrotask` for tool_result — event ordering in stream handler                                    |
| ADR-0104 | Client-side message queue — message ordering guarantees                                                |
| ADR-0114 | Client-only `_partId` field — establishes underscore-prefix convention for internal fields             |
| ADR-0117 | Client Direct SSE — POST body IS the SSE stream; separate persistent EventSource for cross-client sync |

---

## References

- [Ideation document](./01-ideation.md) — Full root cause analysis, codebase map, research synthesis
- [Pre-ideation summary](./00-summary.md) — Initial problem statement and alternatives considered
- [Research: Streaming message integrity patterns](../../research/20260319_streaming_message_integrity_patterns.md) — External research on Slack, TanStack Query, event sourcing, ID reassignment
- [Research: Fix chat streaming history consistency](../../research/20260307_fix_chat_streaming_history_consistency.md) — Prior research on auto-scroll and tool result orphans
- [Research: Fix chat stream remap bugs](../../research/20260312_fix_chat_stream_remap_bugs.md) — Prior research identifying server-echo ID as correct long-term fix
- [Real-time Messaging — Slack Engineering](https://slack.engineering/real-time-messaging/)
- [Optimistic Updates — TanStack Query Docs](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)
- [Streaming Updates — Redux Toolkit](https://redux-toolkit.js.org/rtk-query/usage/streaming-updates)
