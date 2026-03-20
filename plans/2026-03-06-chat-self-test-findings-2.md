# Chat Self-Test Findings — 2026-03-06 (Run 2)

## Test Config

- URL: `http://localhost:4241/?dir=/Users/doriancollier/Keep/temp/empty`
- Session ID (URL/Agent): `c5be542d-2388-4673-9868-9c18401983d4`
- Session ID (SDK/JSONL): `8bde9a1e-17ca-408a-91db-06ab4c93257c`
- Model: Haiku 4.5 (`claude-haiku-4-5-20251001`)
- Permission mode: Accept Edits
- Relay enabled: yes
- Pulse enabled: yes
- API port: 4242
- Messages sent: 5 (message 3 required retry due to freeze)

## Summary

The SSE stream freeze bug identified in Run 1 persists. **3 of 6 message sends** experienced SSE freezes (message 3 first attempt, message 3 retry worked, message 4 froze). The SDK processed all messages correctly (JSONL had 33 lines with complete exchanges), but the Relay SSE pipeline failed to deliver response chunks to the client. Additionally, a massive 503 flood on GET `/messages` continues due to Agent-ID/SDK-Session-ID mismatch in Relay mode. History reload correctly renders all messages including those lost during live streaming.

**Severity: P0** — The SSE freeze makes the chat partially unusable when Relay is enabled. Users must stop and resend messages ~50% of the time.

## Issues Found

### 1. SSE Stream Freeze Persists After Backpressure Fix — Bug (P0)

**Observed:** Messages 3 (first attempt) and 4 both froze: stop button remained visible for 60+ seconds, ~0 tokens shown, rotating status text ("Word to Your Mother", "Phat Trackin'", "Keepin' It Real", "Can You Dig It?", "Gettin' Jiggy", "Keepin' It Tight"), no response content rendered.

**Expected:** Response should stream within ~15s (as messages 1, 2, 5 did).

**Root cause:** `session-broadcaster.ts` lines 176-210 — the `subscribeToRelay()` method queues SSE events and calls `void flush()` (fire-and-forget). The `flush()` function awaits `drain` events, but because it's not awaited by the caller, the queue can stall when the socket buffer fills. The `done` event gets stuck behind buffered writes and never reaches the client.

Commits `ebea3a7` and `1352e31` added backpressure handling, but the fire-and-forget `void flush()` pattern at line 206 undermines the fix — the queue serialization breaks because multiple concurrent flushes can race.

**ADR context:** ADR-0026 (Receipt+SSE Protocol) notes "slightly more complex error handling when POST succeeds but no events arrive" as a known consequence.

**Recommendation:** Change `void flush()` to properly serialize queue processing. Either:

- Use a `flushing` guard to prevent concurrent flushes
- Or await `flush()` in the subscription callback (requires making the callback async)

---

### 2. Massive 503 Flood on GET /messages — Bug (P1)

**Observed:** 50+ requests to `GET /api/sessions/c5be542d.../messages` returned 503 during the session. The client polls this endpoint repeatedly with the Agent-ID, getting 503 each time.

**Expected:** Should return 200 with messages, or 404 if session not found.

**Root cause:** The route at `sessions.ts:124` tries `agentManager.getSdkSessionId(sessionId)` to translate Agent-ID → SDK-Session-ID, but this only works for sessions in AgentManager's in-memory index. Relay sessions created via ClaudeCodeAdapter may not be registered in AgentManager's index, so the translation fails and falls back to using the raw Agent-ID. The JSONL file is named by SDK Session ID, so the lookup fails.

The 503 (not 404) suggests the endpoint is hitting an error condition rather than a clean "not found" path — possibly a race condition where the session exists in some state but the transcript reader throws.

**Recommendation:** Ensure ClaudeCodeAdapter registers the Agent-ID → SDK-Session-ID mapping in a shared store that `sessions.ts` route handlers can access. Or add a reverse lookup in TranscriptReader that can find JSONL files by scanning recent modifications when the ID doesn't match a filename.

---

### 3. New Session Not in Sidebar Until First Response — UX Issue (P2)

**Observed:** After clicking "New Session", the new session did not appear in the sidebar. Only after the first message response completed did it show as "Session 8bde9a1e". The GET `/sessions/c5be542d.../` returned 404 (request #42, #46) because the session list is derived from JSONL files on disk, and no JSONL exists until the first SDK response.

**Expected:** New session should appear immediately in the sidebar, even before the first message.

**Root cause:** Session listing depends on JSONL file existence (`transcript-reader.ts` scans `~/.claude/projects/` for `.jsonl` files). New sessions created via Relay don't have a JSONL file until the SDK processes the first message.

**Recommendation:** Either create a stub JSONL on session creation, or maintain a separate "pending sessions" list in memory that merges with the JSONL-derived list.

---

### 4. Model Display Shows Full Model ID After History Reload — UX Issue (P3)

**Observed:** During live streaming, status bar shows friendly "Haiku 4.5". After page reload, it shows full model ID `claude-haiku-4-5-20251001`.

**Expected:** Consistent friendly name display.

**Root cause:** Same as Run 1 finding. Live mode uses user-selected display name from local state; history mode reads raw model ID from JSONL init message without mapping to friendly name.

**Recommendation:** Apply model ID → display name mapping consistently in both live and history code paths.

---

### 5. Session Title Shows SDK Session ID Instead of Descriptive Title — UX Issue (P3)

**Observed:** Session displays as "Session 8bde9a1e" throughout the test. No meaningful title generated despite 5 exchanges.

**Expected:** Title should reflect first user message (e.g., "Bubble Sort Function").

**Root cause:** User messages wrapped in `<relay_context>` XML in JSONL. Title extraction may fail to strip this wrapper and extract the actual user text.

**Recommendation:** Strip `<relay_context>` wrapper before extracting session titles in `transcript-parser.ts`.

## Observations (No Issues)

- **Code block rendering** — JavaScript, TypeScript, and HTML all render correctly with syntax highlighting, line numbers, and copy/download buttons in both live and history views.
- **Tool call cards** — TodoWrite card renders properly with spinner during streaming and green checkmark after completion. Expand/collapse chevron works.
- **Task list rendering** — After history reload, the 3 TodoWrite tasks are visible with checkmarks and "completed" status. (Not visible during live streaming due to SSE freeze.)
- **Multi-turn context** — Haiku correctly referenced prior messages (TypeScript types applied to previous bubble sort function).
- **Permission mode and model selectors** — Work correctly, dropdowns render, changes reflected in status bar immediately.
- **Cost tracking** — $0.02 displayed during session, context usage 0%.
- **Status bar** — Shows dir name, git status, permission mode, model, cost, context, and remote status.
- **Markdown rendering** — Bold text, bullet lists, inline code all render correctly.
- **History reload** — All messages (including those lost during SSE freezes) render correctly from JSONL after page refresh. This confirms the SDK/JSONL path is fully functional; the issue is isolated to the Relay SSE delivery.
- **Simple text response** — "2 + 2 = **4**" streamed and rendered correctly (message 5).

## Comparison with Run 1 (Earlier Today)

| Issue               | Run 1                              | Run 2                         | Status                                        |
| ------------------- | ---------------------------------- | ----------------------------- | --------------------------------------------- |
| SSE Stream Freeze   | 4/5 msgs froze                     | 2/5 msgs froze (+ 1 retry)    | **Still present**, possibly slightly improved |
| Response Truncation | "2+2" showed only "2"              | "2+2" showed full "2 + 2 = 4" | **Possibly improved**                         |
| Session ID Mismatch | Agent-ID in URL, SDK-ID in sidebar | Same                          | **Unchanged**                                 |
| API /messages Empty | Returns []                         | Returns 503 flood             | **Different symptom, same root cause**        |
| Session Title       | Never updates                      | Never updates                 | **Unchanged**                                 |
| Model Display       | Full ID after reload               | Full ID after reload          | **Unchanged**                                 |

## Verdict

The P0 SSE stream freeze is the dominant issue. Commits `ebea3a7` and `1352e31` partially addressed it but the `void flush()` fire-and-forget pattern still causes stalls. This is the same root cause identified in Run 1 and needs a more thorough fix to the queue serialization in `session-broadcaster.ts`.
