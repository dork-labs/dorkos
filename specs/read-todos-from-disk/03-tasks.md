# read-todos-from-disk -- Task Breakdown

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-03-23
**Mode:** Full
**Tasks:** 4 across 2 phases

---

## Phase 1: Core Implementation

### Task 1.1: Add readTodosFromFile(), getTodoFileETag(), and file-first readTasks() to TranscriptReader

**Size:** Medium | **Priority:** High | **Dependencies:** None

**File:** `apps/server/src/services/runtimes/claude-code/transcript-reader.ts`

Add three pieces of functionality:

1. **`readTodosFromFile(sessionId)`** -- Read `~/.claude/todos/{sessionId}-agent-{sessionId}.json`, parse JSON array, map `content` to `subject`, preserve `status`/`id`/`activeForm`. Return `null` on ENOENT or malformed JSON (with warning log). Return empty array for `[]`.

2. **`getTodoFileETag(sessionId)`** -- Stat the todo file, return `"${mtimeMs}-${size}"` string. Return `null` on ENOENT.

3. **Update `readTasks()`** -- Try `readTodosFromFile()` first. If it returns non-null (including empty array), use it. If null, fall back to existing JSONL-based `parseTasks()` logic.

---

### Task 1.2: Update getSessionETag() to combine transcript and todo file ETags

**Size:** Small | **Priority:** High | **Dependencies:** 1.1

**File:** `apps/server/src/services/runtimes/claude-code/claude-code-runtime.ts`

Update `getSessionETag()` (line 384) to call both `getTranscriptETag()` and `getTodoFileETag()`. When both exist, combine into single ETag `"transcriptMtime-transcriptSize-todoMtime-todoSize"`. When only one exists, return that one. When neither exists, return `null`.

---

## Phase 2: Testing

### Task 2.1: Unit tests for readTodosFromFile() and getTodoFileETag()

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1

**File:** `apps/server/src/services/runtimes/claude-code/__tests__/transcript-reader-todos.test.ts`

8 test cases covering:

- Valid file with field mapping verification
- Empty array returns `[]`
- ENOENT returns `null`
- Malformed JSON logs warning, returns `null`
- Missing `id` field generates sequential IDs
- Semantic slug IDs preserved as-is
- `getTodoFileETag()` returns mtime-size string
- `getTodoFileETag()` returns `null` when file missing

---

### Task 2.2: Integration tests for readTasks() fallback and getSessionETag() combination

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.2 | **Parallel with:** 2.1

**File:** `apps/server/src/services/runtimes/claude-code/__tests__/transcript-reader-todos.test.ts`

6 test cases covering:

- `readTasks()` uses todo file when it exists (JSONL parser not called)
- `readTasks()` falls back to JSONL when todo file is ENOENT
- `getSessionETag()` combines both ETags when both exist
- `getSessionETag()` returns transcript ETag only when todo file missing
- `getSessionETag()` returns todo ETag only when transcript missing
- `getSessionETag()` returns `null` when neither exists
- All existing tests pass (regression check)
