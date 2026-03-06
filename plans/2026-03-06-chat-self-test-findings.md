# Chat Self-Test Findings — 2026-03-06 (Run 2)

## Test Config
- URL: `http://localhost:4241/?dir=/Users/doriancollier/Keep/temp/empty`
- Session ID (URL/Agent): `9c99edf1-47eb-46c3-aa6f-73e2a409b12d`
- Session ID (SDK/JSONL): `220131a7-b33e-48a0-bb1a-786a0f0e708f`
- Model: claude-haiku-4-5-20251001
- Permission mode: Accept Edits
- Relay enabled: yes
- Pulse enabled: yes
- Messages sent: 5
- API port: 4242 (via Vite proxy on 4241)
- Previous fix tested: `d62daa1 fix(relay): resolve SSE delivery pipeline causing ~40-50% message freezes`

## Summary

The relay SSE delivery pipeline fix (d62daa1) **significantly improved** the freeze rate — 4 of 5 messages completed without freezing (vs 3 of 5 freezing in run 1). However, **message 2 still exhibited a freeze regression**: the backend completed (JSONL) but the client's `done` event was not delivered. More critically, **history reload has severe rendering bugs**: all 5 user messages are missing, and internal Skill tool_result content leaks as user messages. A flood of **503 errors** on GET `/api/sessions/:id/messages` was observed during streaming.

## Issues Found

### 1. SSE `done` Event Not Delivered (Message 2) — Bug (P1)

**Observed:** Message 2 ("Add TypeScript types") completed on the backend — JSONL line 11 shows the full 2136-char response, lines 12-15 show the next message queued. The client displayed complete text (357 tokens) but the stop button persisted for 25+ seconds (two screenshots 10s apart showed identical content). Required manual stop button click to unblock.

**Expected:** Stop button should disappear within 1-2 seconds of backend completion.

**Root cause:** Despite the four-layer fix (stable EventSource lifecycle, subscribe-first handshake, pending buffer, terminal `done` in finally), the `done` event still failed to reach the client. The EventSource was stable (no reconnection), and `stream_ready` was received before POST. The failure likely occurs in the relay message writing path — `session-broadcaster.ts:182-224` uses a write queue with drain handling, but there may be an edge case where the `done` event's SSE write succeeds on the server but the EventSource doesn't fire the corresponding listener on the client (possibly a browser EventSource buffering issue or event type mismatch).

**Key files:**
- `apps/server/src/services/session/session-broadcaster.ts:182-224` — relay message SSE writing
- `packages/relay/src/adapters/claude-code-adapter.ts:480-490` — terminal done in finally
- `apps/client/src/layers/features/chat/model/use-chat-session.ts:217-252` — relay EventSource

**Recommendation:** Add end-to-end tracing for the `done` event: log when CCA publishes it, when RelayCore dispatches it, when SubscriptionRegistry delivers it, and when SessionBroadcaster writes it to SSE. Also add a client-side safety net: if no SSE events arrive for 15s after the last `text_delta`, check the session status via REST API and auto-transition to idle if the backend has completed.

---

### 2. User Messages Missing from History Reload — Bug (P0)

**Observed:** After page refresh, only 6 DOM elements rendered vs expected 10+. **All 5 user messages were completely absent.** The conversation started with the assistant's first response.

**Expected:** All user messages should render as user bubbles.

**Root cause:** `transcript-parser.ts:231-233` — the relay context filter:
```typescript
if (text.startsWith('<relay_context>')) {
  continue;  // Skips the ENTIRE message, including user content after </relay_context>
}
```

When Relay is enabled, `ClaudeCodeAdapter.formatPromptWithContext()` (relay/adapters/claude-code-adapter.ts:755-785) wraps user messages as:
```
<relay_context>
Agent-ID: 9c99edf1-...
...
</relay_context>

Write a JavaScript bubble sort function with comments
```

The parser skips the whole message because the string starts with `<relay_context>`. The actual user content after the closing tag is discarded.

**Test gap:** `transcript-reader.test.ts:562-597` only tests pure relay context (no trailing user content).

**Recommendation:** Fix the parser to strip `<relay_context>...</relay_context>` from the string and process the remaining content as the actual user message:
```typescript
if (text.startsWith('<relay_context>')) {
  const closingTag = '</relay_context>';
  const idx = text.indexOf(closingTag);
  if (idx !== -1) {
    const userContent = text.slice(idx + closingTag.length).trim();
    if (!userContent) continue; // Pure relay metadata, skip
    text = userContent; // Process the actual user message
  } else {
    continue; // Malformed, skip
  }
}
```

---

### 3. Skill Tool Result Leaks as User Message in History — Bug (P1)

**Observed:** On history reload, an internal tool_result appeared as a user message bubble showing: `/frontend-design:frontend-design minimal HTML page with h1 heading`. This is the SDK's internal Skill tool_result content leaking into the conversation.

**Expected:** Tool results should not appear as user messages. Skill invocations should show as collapsed tool call cards.

**Root cause:** `transcript-parser.ts:211-220` — when a user message contains both `tool_result` and `text` content blocks, the parser renders the text parts as a user message. The `pendingCommand` logic (lines 187-209) handles pure `tool_result` but doesn't handle the combined `tool_result + text` case from Skill expansions.

**Recommendation:** When a user message contains `tool_result` blocks, suppress the `text` parts from rendering as user messages — they are internal SDK expansion content, not user-authored.

---

### 4. Flood of 503 on GET /messages During Streaming — Bug (P2)

**Observed:** Network log shows ~30+ GET `/api/sessions/:id/messages` returning 503 during active streaming. Mixed with successful 200 responses.

**Expected:** GET /messages should return 200 or 304, never 503.

**Root cause:** `session-broadcaster.ts:86,93` — SSE connection limits (10 per session, 500 global) in `registerClient()`. The 503 is triggered when the SSE registration path is hit. The GET /messages endpoint itself doesn't return 503, but TanStack Query's refetchInterval causes repeated GET /messages calls which in the network log may be interleaved with GET /stream SSE registrations that DO return 503.

Additionally, `sessions.ts:351` passes the Agent-ID (not SDK-Session-ID) to `registerClient()`, which could create duplicate watchers for the same JSONL file under different keys.

**Key files:**
- `apps/server/src/services/session/session-broadcaster.ts:83-101` — SSE limit enforcement
- `apps/server/src/config/constants.ts:29-34` — `SSE.MAX_CLIENTS_PER_SESSION: 10`
- `apps/server/src/routes/sessions.ts:351` — no Agent-ID → SDK-Session-ID translation for SSE

**Recommendation:** Add session ID translation in the SSE registration path. Investigate whether the client opens multiple EventSource connections for the same session. Consider increasing per-session limit or making it configurable.

---

### 5. No Progress Indicator During Skill Execution — UX Issue (P2)

**Observed:** Message 3 triggered the `frontend-design` Skill (JSONL line 17: `tool_use: Skill`). The client displayed partial text (318 tokens) with the stop button for 2+ minutes. No indication that a skill was actively running. From the user's perspective, the response appeared completely frozen.

**Expected:** UI should show a tool call card or progress indicator (e.g., "Using skill: frontend-design") during skill execution.

**Root cause:** The `tool_call_start` SSE event for the Skill tool call may not be forwarded through the relay pipeline. The client only sees `text_delta` events, missing the intermediate tool invocations. The JSONL clearly shows `tool_use: Skill` at line 17, but this was never rendered in the client.

**Recommendation:** Ensure `tool_call_start`/`tool_call_end` events for all tool types (including Skill) are forwarded through the relay SSE pipeline. This gives users visibility into agent activity during long operations.

---

### 6. Model Display Shows Full ID on History Reload — UX Issue (P3)

**Observed:** Live session shows "Haiku 4.5". After reload, shows `claude-haiku-4-5-20251001`.

**Expected:** Consistent friendly name in both modes.

**Recommendation:** Apply model ID → display name mapping in the history-loaded code path.

## Observations (No Issues)

- **Message 1 (bubble sort)**: Clean completion in ~13s, code block with syntax highlighting
- **Message 4 (TodoWrite)**: Tool call card rendered correctly with green checkmark, tasks listed with completed status
- **Message 5 (2+2)**: Clean completion in ~14s, "2 + 2 = **4**" rendered correctly
- **Code block rendering**: JS, TS, HTML all render with syntax highlighting, line numbers, copy/download buttons
- **Session creation**: New session flow works correctly
- **Model/permission selection**: Dropdowns work, status bar updates immediately
- **Sidebar**: Sessions appear with correct timestamps and SDK session IDs
- **Cost tracking**: Shows cumulative cost ($0.03-0.04) and cache percentage
- **TodoWrite card**: Renders with green checkmark, collapsible, tasks display correctly on both live and history
- **Multi-turn context**: Haiku correctly referenced prior messages

## Message-by-Message Results

| # | Message | Stream Time | Tokens | Freeze? | Notes |
|---|---------|------------|--------|---------|-------|
| 1 | Bubble sort | 13s | ~372 | No | Clean completion |
| 2 | TypeScript types | 22s text, 44s+ stop button | ~357 | **YES** | `done` event not delivered |
| 3 | HTML page | 2m+ (stopped manually) | ~318 | No (skill) | Agent triggered frontend-design skill |
| 4 | TodoWrite tasks | ~8s | — | No | Tool call + text, clean |
| 5 | 2+2 | 14s | ~3 | No | Clean completion |

## History Reload Results

| Check | Result |
|-------|--------|
| Message count | **FAIL** — 6 DOM elements vs expected 10+ |
| User messages | **FAIL** — All 5 user messages missing |
| Code blocks | PASS — Properly rendered |
| Tool call cards | **FAIL** — Skill tool_result leaks as user message |
| Task list | PASS — Tasks visible with correct status |
| Model display | MINOR — Shows full model ID |
| Scroll position | PASS — Near bottom |

## Comparison with Run 1

| Issue | Run 1 (pre-fix) | Run 2 (post-fix) | Status |
|-------|-----------------|-------------------|--------|
| SSE freeze rate | 3/5 messages (60%) | 1/5 messages (20%) | **Improved** |
| Freeze duration | 60-80+ seconds | 25+ seconds | **Improved** |
| User messages in history | Not tested | All missing | **New finding** |
| Tool result leak | Not tested | Confirmed | **New finding** |
| 503 errors | Not tested | ~30+ during session | **New finding** |
| Response truncation | Confirmed | Not observed | **Fixed** |
