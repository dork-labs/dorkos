---
slug: read-todos-from-disk
created: 2026-03-23
status: ideation
---

# Read Todos from Disk (JSON File)

**Slug:** read-todos-from-disk
**Author:** Claude Code
**Date:** 2026-03-23

---

## 1) Intent & Assumptions

- **Task brief:** Read the canonical `~/.claude/todos/{sessionId}-agent-{sessionId}.json` file for task state instead of reconstructing it from JSONL tool_use blocks. This gives accurate status even when subagents modify todos.
- **Assumptions:**
  - The Claude Code SDK writes todo files atomically (confirmed: uses rename)
  - The `{sessionId}-agent-{sessionId}.json` naming convention is stable
  - Main agent's file is the authoritative state (subagent files are internal)
- **Out of scope:**
  - File watching / push-based updates (overkill for current use case)
  - Aggregating todos across subagent files
  - Caching layer (files are tiny, reads are instant)

## 2) Pre-reading Log

- `apps/server/src/services/runtimes/claude-code/transcript-reader.ts`: `readTasks()` method at line 350 reads full JSONL and calls `parseTasks()`. `getTranscriptsDir()` at line 36 resolves `~/.claude/projects/{slug}/`
- `apps/server/src/services/runtimes/claude-code/task-reader.ts`: `parseTasks()` reconstructs state from TodoWrite/TaskCreate/TaskUpdate tool_use blocks
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`: `getSessionTasks()` at line 379 delegates to `transcriptReader.readTasks()`. `getInternalSessionId()` at line 573 translates DorkOS UUID to SDK session ID
- `apps/server/src/routes/sessions.ts`: GET `/api/sessions/:id/tasks` at line 51 uses `getInternalSessionId()` before calling `getSessionTasks()`
- `apps/client/src/layers/features/chat/model/use-task-state.ts`: Loads tasks via TanStack Query, merges streaming `task_update` events
- `~/.claude/todos/`: Contains JSON files with format `[{content, status, id?, activeForm?}]`. Naming: `{sessionId}-agent-{sessionId}.json` for main agent

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/runtimes/claude-code/transcript-reader.ts` — reads JSONL, will add todo file reading
  - `apps/server/src/services/runtimes/claude-code/task-reader.ts` — JSONL parser (becomes fallback)
  - `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` — `getSessionTasks()` orchestrator
  - `apps/server/src/routes/sessions.ts` — HTTP endpoint
  - `apps/client/src/layers/features/chat/model/use-task-state.ts` — client state management

- **Shared dependencies:**
  - `packages/shared/src/schemas.ts` — `TaskItemSchema`, `TaskUpdateEventSchema`
  - `packages/shared/src/transport.ts` — `getTasks()` interface (line 166)
  - `apps/server/src/services/runtimes/claude-code/build-task-event.ts` — streaming path (unchanged)

- **Data flow:**
  - Historical: `GET /tasks` → `getSessionTasks()` → `readTasks()` → **read JSON file** (new) or `parseTasks()` (fallback) → `TaskItem[]`
  - Live: SDK stream → `sdk-event-mapper` → `task_update` SSE → `handleTaskEvent()` → overlay on file-loaded state

- **Potential blast radius:**
  - Direct: `transcript-reader.ts`, `claude-code-runtime.ts` (2 files)
  - Indirect: None — API contract unchanged (`{ tasks: TaskItem[] }`)
  - Tests: `sessions.test.ts`, new unit test for file reader

## 5) Research

**File storage mechanism (confirmed from filesystem inspection):**

- Location: `~/.claude/todos/{sessionId}-agent-{agentId}.json`
- Main agent: both UUIDs identical (`abc-agent-abc.json`)
- Subagents: different agentId (`abc-agent-def.json`)
- Format: `[{ content, status, id?, activeForm? }]`
- Each TodoWrite replaces the entire file (atomic rename, last-write-wins)

**Potential solutions:**

1. **File-primary with stream overlay (chosen)**
   - Read JSON file on page load for baseline state
   - During streaming, overlay `task_update` SSE events
   - Pros: Accurate historical state, catches subagent updates, real-time during streaming
   - Cons: Slightly more complex than single-source
   - Complexity: Low — one new method, small change to existing

2. **File-only, drop stream events**
   - Always read from file, ignore streaming task events
   - Pros: Simplest implementation
   - Cons: No real-time updates during streaming, tasks only appear after agent finishes

3. **Stream-primary, file fallback**
   - Current architecture + read file only when no stream events received
   - Pros: Minimal change
   - Cons: Still misses subagent updates during live sessions

**Recommendation:** Option 1 — file-primary with stream overlay. The file read replaces JSONL parsing for the historical/load path. Streaming SSE events still provide real-time updates during active sessions.

**Key finding:** The SDK has NO event/API for todo change notifications. Stream interception via `sdk-event-mapper.ts` is the correct approach for live updates (confirmed by SDK docs). File reading supplements this for historical state.

## 6) Decisions

| #   | Decision             | Choice                           | Rationale                                                                                                                    |
| --- | -------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Data source strategy | File-primary with stream overlay | File gives accurate baseline (catches subagent updates). Stream gives real-time. JSONL parsing becomes unnecessary fallback. |
| 2   | Subagent handling    | Main agent file only             | Main agent file reflects authoritative state. Subagent files are internal tracking. Avoids merge complexity.                 |

## 7) Implementation Sketch

### Server: New method in `transcript-reader.ts`

Add `readTodosFromFile(sessionId)` that reads `~/.claude/todos/{sessionId}-agent-{sessionId}.json`:

- Parse JSON array
- Map `content` → `subject` to match `TaskItem` schema
- Return `TaskItem[]`
- On `ENOENT`: return empty array (no file yet)

### Server: Update `readTasks()` or `getSessionTasks()`

Change the flow to:

1. Try `readTodosFromFile(sdkSessionId)` first
2. If file not found, fall back to JSONL-based `parseTasks()` (backward compat for old sessions)

### Server: Field mapping

Todo file uses `content`, DorkOS uses `subject`:

```
{ content: "Buy milk", status: "completed", id: "1" }
  →
{ id: "1", subject: "Buy milk", status: "completed" }
```

### Client: No changes needed

The API contract remains `{ tasks: TaskItem[] }`. The `use-task-state.ts` hook loads tasks on mount and overlays streaming events — this already works correctly.

### ETag caching

The existing ETag for tasks uses the JSONL file's mtime+size. Update to use the todo JSON file's mtime+size when reading from it.
