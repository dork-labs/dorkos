---
slug: read-todos-from-disk
---

# Read Todos from Disk -- Implementation Specification

**Status:** Draft
**Authors:** Claude Code
**Date:** 2026-03-23

---

## Table of Contents

1. [Overview](#1-overview)
2. [Problem Statement](#2-problem-statement)
3. [Goals](#3-goals)
4. [Non-Goals](#4-non-goals)
5. [Technical Design](#5-technical-design)
6. [Testing Strategy](#6-testing-strategy)
7. [Performance](#7-performance)
8. [Security](#8-security)
9. [Implementation Phases](#9-implementation-phases)
10. [Open Questions](#10-open-questions)
11. [References](#11-references)

---

## 1. Overview

Read todo/task state from the Claude Code SDK's canonical todo file (`~/.claude/todos/{sessionId}-agent-{sessionId}.json`) instead of reconstructing it from JSONL `tool_use` blocks. This gives accurate task status even when subagents modify todos, since the SDK persists all updates -- including subagent writes -- to a single file via atomic rename.

**Architecture: file-primary with stream overlay.**

- **Historical/load path:** Read the JSON file directly (replaces JSONL parsing).
- **Live streaming path:** SSE `task_update` events overlay on top (unchanged).
- **Fallback:** If the JSON file doesn't exist, fall back to JSONL-based `parseTasks()` for backward compatibility.

---

## 2. Problem Statement

DorkOS currently parses `TodoWrite` / `TaskCreate` / `TaskUpdate` tool_use blocks from JSONL transcripts to reconstruct task state. This has two problems:

1. **Subagent invisibility.** Subagent `TodoWrite` calls appear in separate JSONL files (the subagent's transcript, not the parent's). The parent session's JSONL never contains these events, so subagent todo updates are invisible to the UI.

2. **Synthetic ID mismatch.** The reconstructed task IDs are synthetic (generated during parsing) and may not match the IDs in the SDK's canonical file. This creates inconsistencies when the client receives a `task_update` SSE event referencing an ID it doesn't recognize.

The Claude Code SDK already solves both problems. It persists a canonical todo file at `~/.claude/todos/{sessionId}-agent-{sessionId}.json` with this format:

```json
[
  { "content": "Task name", "status": "pending", "id": "1", "activeForm": "..." },
  { "content": "Another task", "status": "completed", "id": "2" }
]
```

This file is atomically written (via rename) and reflects updates from all agents in the session tree. It is the source of truth.

---

## 3. Goals

- Read task state from the SDK's canonical todo file when available.
- Preserve backward compatibility by falling back to JSONL parsing when the file doesn't exist.
- Update ETag computation to reflect the todo file's state for efficient client polling.
- Zero changes to the API contract or client code.

---

## 4. Non-Goals

- **File watching / push-based updates.** No `chokidar` or `fs.watch` on the todo file.
- **Subagent file aggregation.** Read only the main agent's todo file, not subagent-specific files.
- **Caching layer.** The file is small (< 1KB typically); no in-memory cache needed.
- **Client-side changes.** The `TaskItem[]` response shape is unchanged.

---

## 5. Technical Design

### 5.1 File Path Convention

The SDK writes todo files to:

```
~/.claude/todos/{sessionId}-agent-{sessionId}.json
```

Where `{sessionId}` is the SDK-internal session ID (UUID format). The route handler already translates DorkOS session IDs to SDK session IDs via `getInternalSessionId()`, so no new translation is needed.

### 5.2 Field Mapping

| Todo File Field | TaskItem Field | Notes                                                |
| --------------- | -------------- | ---------------------------------------------------- |
| `content`       | `subject`      | Rename                                               |
| `status`        | `status`       | Direct map (`pending` / `in_progress` / `completed`) |
| `id`            | `id`           | Preserve if present; generate sequential if missing  |
| `activeForm`    | `activeForm`   | Direct map (optional field)                          |

### 5.3 Files to Modify

#### `apps/server/src/services/runtimes/claude-code/transcript-reader.ts`

**New method: `readTodosFromFile(sessionId: string): Promise<TaskItem[] | null>`**

- Construct path: `path.join(os.homedir(), '.claude', 'todos', \`${sessionId}-agent-${sessionId}.json\`)`
- Read and parse the JSON array.
- Map each entry: `content` to `subject`, preserve `status`, `id` (generate sequential if missing), `activeForm`.
- On `ENOENT`: return `null` (signals fallback needed).
- On JSON parse error: log warning, return `null`.

**Updated method: `readTasks(vaultRoot, sessionId)`**

- Try `readTodosFromFile(sessionId)` first.
- If it returns `null`, fall back to the existing JSONL-based `parseTasks()` logic.

**New method: `getTodoFileETag(sessionId: string): Promise<string | null>`**

- `stat()` the todo JSON file, return an `"${mtime}-${size}"` string.
- On `ENOENT`: return `null`.

#### `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`

**Updated method: `getSessionETag()` (line ~384)**

- Try `transcriptReader.getTodoFileETag(sessionId)` first.
- If `null`, fall back to the existing `getTranscriptETag()`.
- Combine both ETags (transcript + todo file) if both exist, so changes to either invalidate the cache.

**`getSessionTasks()` (line ~379):** No change needed. It already delegates to `transcriptReader.readTasks()`, which handles the file-first logic internally.

### 5.4 Files NOT Modified

- `apps/server/src/routes/sessions.ts` -- API contract unchanged.
- `apps/client/` -- no changes; same `{ tasks: TaskItem[] }` response.
- `apps/server/src/services/runtimes/claude-code/build-task-event.ts` -- streaming path unchanged.
- `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` -- streaming path unchanged.

### 5.5 Data Flow

```
Client GET /api/sessions/:id/tasks
  → sessions.ts route handler
    → runtime.getSessionTasks(sessionId)
      → transcriptReader.readTasks(projectDir, sessionId)
        → readTodosFromFile(sessionId)     // NEW: try file first
          ├─ file exists → parse JSON → map to TaskItem[] → return
          └─ file missing → return null
        → (if null) parseTasks(projectDir)  // EXISTING: JSONL fallback
      → return TaskItem[]
```

### 5.6 Key Decisions

1. **File-primary with stream overlay** -- chosen over pure-streaming or pure-file approaches. The file gives accurate historical state; SSE gives real-time updates. Best of both worlds.
2. **Main agent file only** -- subagent files are not aggregated. The main agent's file already contains all tasks (the SDK consolidates them).

---

## 6. Testing Strategy

### Unit Tests: `readTodosFromFile()`

- **Valid file:** Parse a well-formed JSON array and verify field mapping (`content` to `subject`, status preserved, IDs preserved).
- **Empty array:** File contains `[]` -- return empty `TaskItem[]` (correct behavior: agent cleared all todos).
- **Missing file (`ENOENT`):** Return `null`.
- **Malformed JSON:** Log warning, return `null`.
- **Missing `id` field:** Generate sequential IDs (`"1"`, `"2"`, ...).
- **Semantic slug IDs:** Preserve as-is (e.g., `"fix-login-bug"`).

### Integration Tests: `readTasks()`

- **File exists:** Prefer file over JSONL parsing. Verify JSONL parser is not called.
- **File missing:** Fall back to JSONL-based `parseTasks()`. Verify JSONL parser is called.

### ETag Tests

- **Todo file exists:** `getTodoFileETag()` returns mtime-size string.
- **Todo file missing:** Returns `null`; runtime falls back to transcript ETag.
- **`getSessionETag()`:** Incorporates todo file ETag when available.

### Regression

- All existing tests must continue passing with no modifications.

---

## 7. Performance

- **Improvement over status quo.** Reads a single small JSON file (typically < 1KB) instead of parsing a potentially large JSONL transcript (can be megabytes for long sessions).
- **No caching needed.** File reads are fast for small files, and the ETag mechanism prevents unnecessary re-processing on the client.
- **Atomic writes.** The SDK writes via rename, so partial reads are not possible.

---

## 8. Security

- **Path construction.** The file path is constructed from a session ID in UUID format. No user-supplied path segments, no path traversal risk.
- **Trust boundary.** The todo file is in `~/.claude/`, the same directory as JSONL transcripts. No new trust boundary is crossed.
- **No new external inputs.** No network calls, no new API parameters, no user-facing file path inputs.

---

## 9. Implementation Phases

### Phase 1 (This Spec)

- Add `readTodosFromFile()` with JSONL fallback in `transcript-reader.ts`.
- Update `getTodoFileETag()` and integrate into `getSessionETag()`.
- Full test coverage per Section 6.

### Phase 2 (Future, Out of Scope)

- File watching for cross-client sync (push todo updates via SSE when the file changes on disk).
- Subagent file aggregation (if the SDK changes its consolidation behavior).

---

## 10. Open Questions

None. The design is straightforward and the SDK's file format is stable.

---

## 11. References

- [01-ideation.md](./01-ideation.md) -- Ideation document with alternatives considered.
- `apps/server/src/services/runtimes/claude-code/transcript-reader.ts` -- Current JSONL-based task parsing.
- `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts` -- Runtime task/ETag methods.
- `apps/server/src/services/runtimes/claude-code/build-task-event.ts` -- SSE streaming task events (unchanged).
