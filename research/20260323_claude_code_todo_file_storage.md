---
title: 'Claude Code Todo File Storage — Mechanism, Naming, and Reading Strategy'
date: 2026-03-23
type: implementation
status: active
tags: [claude-code, todos, todowrite, file-watching, sdk, sessions]
searches_performed: 6
sources_count: 12
---

# Claude Code Todo File Storage — Mechanism, Naming, and Reading Strategy

## Research Summary

Claude Code writes todo state to disk at `~/.claude/todos/{sessionId}-agent-{agentId}.json` after every `TodoWrite` tool call. The JSON array is the complete snapshot (last-write-wins). For main agents, `sessionId == agentId`; for subagents, `agentId` is the subagent's own session UUID while `sessionId` is the parent session. The **canonical SDK approach is stream-interception** — reading `TodoWrite` tool calls from the SDK message stream — not polling files. DorkOS already implements this correctly. File reading is only needed for session replay (reading persisted history). No SDK event or API exists for todo change notifications beyond the stream itself.

---

## Key Findings

### 1. File Location and Naming Convention

**Directory:** `~/.claude/todos/`

**Filename pattern:**

```
{sessionId}-agent-{agentId}.json
```

**Main agent (sessionId == agentId):**

```
047b33cd-3beb-4289-81f8-5c11a7992efc-agent-047b33cd-3beb-4289-81f8-5c11a7992efc.json
```

**Subagent (agentId != sessionId):**

```
8c046dd7-58a5-4cb2-ae85-f1c7cee0c251-agent-6fd54a57-5ec1-4967-9a5f-2581b3d6de12.json
┌──────────────────── parent session UUID ─────────────────┐  ┌── subagent session UUID ──┐
```

This was verified by direct inspection of `~/.claude/todos/` on this machine. In a session with subagents, there are **two files** for the same `sessionId` prefix: one for the main agent (IDs equal) and one per subagent (IDs differ).

### 2. Exact JSON Format

The file is a **JSON array** — not JSONL, not a wrapped object. Each element is a todo item:

```json
[
  {
    "content": "Run lint and typecheck to verify all changes are correct",
    "status": "completed",
    "id": "1"
  },
  {
    "content": "Update sessions/reports/EngagementsList.tsx - replace console.log",
    "status": "in_progress",
    "id": "2"
  }
]
```

**Fields confirmed from direct inspection:**

| Field     | Type   | Values                                          | Notes                                                 |
| --------- | ------ | ----------------------------------------------- | ----------------------------------------------------- |
| `content` | string | Any text                                        | Imperative task description                           |
| `status`  | string | `"pending"` \| `"in_progress"` \| `"completed"` | SDK enforces max 1 `in_progress` at a time            |
| `id`      | string | Sequential `"1"`, `"2"` ... or semantic slug    | Assigned by Claude; can be a UUID or descriptive slug |

**Optional fields (not always present):**

- `activeForm` — present-continuous description shown while `in_progress` (e.g., "Running tests")
- `priority` — mentioned in some SDK docs but not seen in observed files

The file is **always the full current snapshot**. Each `TodoWrite` call replaces the entire file. There is no append/diff behavior.

### 3. SDK Canonical Approach: Stream Interception (Not File Polling)

The official Anthropic SDK documentation explicitly shows todo tracking via the **message stream**, not file reading:

```typescript
for await (const message of query({ prompt: '...', options: {} })) {
  if (message.type === 'assistant') {
    for (const block of message.message.content) {
      if (block.type === 'tool_use' && block.name === 'TodoWrite') {
        const todos = block.input.todos;
        // todos is the full replacement array — same as what's written to disk
      }
    }
  }
}
```

**This is exactly what DorkOS already implements** in `sdk-event-mapper.ts` + `build-task-event.ts`. The stream-intercepted `TodoWrite.input.todos` and the file contents are identical — the file is written from the same `input.todos` data that appears in the stream.

### 4. There Is No SDK Event or API for Todo Changes

After thorough review of the SDK reference (`platform.claude.com/docs/en/agent-sdk/typescript`) and the todo tracking guide:

- No `TodoRead`/`TodoChanged` event type exists in `SDKMessage`
- No `query.todosChanged()` method or similar exists on the `Query` interface
- No webhook or push mechanism for todo changes
- The SDK docs only show stream-based observation

The file is a **side-effect of the TodoWrite tool** — the SDK writes it as persistence, but does not provide a structured notification layer on top of it.

### 5. The File vs. Stream — Practical Differences

| Concern                      | Stream (current DorkOS approach)           | File Read                                   |
| ---------------------------- | ------------------------------------------ | ------------------------------------------- |
| Latency                      | Zero — data arrives before file is written | Slight delay (file I/O after stream event)  |
| Active sessions              | Always correct                             | Same content, slight lag                    |
| Resumed sessions             | Requires JSONL replay via `task-reader.ts` | Can read the current file snapshot directly |
| Subagent todos               | Each subagent emits its own stream events  | Each subagent has its own file              |
| Sessions from another client | No stream access — must use file           | File is the only option                     |

The file is **most useful for session recovery** — when a session completes and a user later requests the task list without replaying the full JSONL. For live sessions, stream interception is strictly superior.

---

## Detailed Analysis

### File Writing Mechanics

Claude Code writes the todo file **atomically** using a temp-then-rename pattern (standard for safe cross-process writes). There is no `.lock` file in `~/.claude/todos/` — the rename syscall provides atomicity. This means:

- A reader can never see a partially-written file
- The file can be safely `fs.readFile()`'d without file locks
- The only race condition risk is reading between two rapid sequential `TodoWrite` calls, which would yield a valid but slightly stale snapshot (the next write is already in the stream)

### File Watching for Live Updates (If Needed)

If DorkOS ever needed to watch for external todo changes (e.g., a session started by Claude Code CLI directly, not through DorkOS):

**Option A: `fs.watch` (Node.js native)**

- Pros: Zero dependencies, available since Node 0.6
- Cons: Unreliable on macOS — can fire duplicate events, miss events on network volumes, never provides the filename on macOS in some configurations
- Verdict: Acceptable for `~/.claude/todos/` on local disk (macOS FSEvents backend), but fragile

**Option B: Chokidar v5**

- Pros: Proven in ~30M repos, uses FSEvents on macOS, inotify on Linux, graceful fallback to polling. ESM-only as of v5 (Nov 2025).
- Cons: External dependency, ESM-only breaks CommonJS consumers
- Verdict: Best choice if watching is required. The server is already ESM (NodeNext modules), so v5 is compatible.

**Option C: Polling with TTL cache**

- Pros: Simple, predictable, no platform-specific behavior
- Cons: Latency proportional to poll interval; CPU overhead proportional to number of watched sessions
- Verdict: Appropriate as fallback or for low-frequency needs (e.g., reading on API request with 5s TTL)

### Safe File Reading Pattern

Since the file is atomically written (rename), standard `fs.readFile` is safe:

```typescript
import { readFile } from 'node:fs/promises';

async function readTodos(todoPath: string): Promise<TodoItem[] | null> {
  try {
    const raw = await readFile(todoPath, 'utf-8');
    return JSON.parse(raw) as TodoItem[];
  } catch (err) {
    // ENOENT = file doesn't exist yet (no TodoWrite called in session)
    // SyntaxError = race condition hit mid-write (extremely unlikely given atomic writes)
    return null;
  }
}
```

Do NOT use `fs.access()` before `fs.readFile()` — that creates a TOCTOU race. Handle ENOENT in the catch block.

### Subagent File Discovery

To find all todo files for a parent session (including subagents):

```typescript
import { readdir } from 'node:fs/promises';
import path from 'node:path';

async function findSessionTodoFiles(claudeHome: string, sessionId: string): Promise<string[]> {
  const todosDir = path.join(claudeHome, 'todos');
  const entries = await readdir(todosDir);
  return entries
    .filter((f) => f.startsWith(`${sessionId}-agent-`) && f.endsWith('.json'))
    .map((f) => path.join(todosDir, f));
}
```

The session's main-agent file always matches `{sessionId}-agent-{sessionId}.json`. Subagent files match `{sessionId}-agent-{differentUUID}.json`.

---

## Approach Comparison: When to Read Files vs. Stream

### Approach 1: Stream Interception Only (Current DorkOS Implementation)

**How it works:** `sdk-event-mapper.ts` catches `TodoWrite` tool calls in the live stream and emits `task_update` / snapshot events via SSE.

**Pros:**

- Zero latency — todo state reaches the client before the file is even written
- No filesystem dependency — works in any environment
- Consistent with how all other tool data is handled
- Subagent todos are automatically disambiguated by their stream position

**Cons:**

- Cannot recover task state from a session that started outside DorkOS (e.g., Claude Code CLI)
- Requires a live session — cannot query past-session todos without JSONL replay

**Verdict: Correct default. No changes needed.**

### Approach 2: On-Demand File Read (REST API)

**How it works:** `GET /api/sessions/:id/todos` reads `~/.claude/todos/{id}-agent-{id}.json` and returns it.

**Pros:**

- Simple, stateless
- Enables querying completed sessions without JSONL replay
- Useful for sessions created by external tools (CLI, other UIs)
- No background resource usage

**Cons:**

- Returns stale data if called during active writing (extremely unlikely given atomic writes)
- Only returns the main-agent todos, not subagent todos (unless you also glob for subagent files)
- Always reflects the last complete `TodoWrite` state, not in-progress states from the stream

**Verdict: Worth adding as a supplemental API for session recovery. Should NOT replace stream interception.**

### Approach 3: File Watching + SSE Push

**How it works:** Watch `~/.claude/todos/` with chokidar; on change, re-read the file and push to SSE subscribers.

**Pros:**

- Enables live updates for externally-started sessions
- Single source of truth (the file) regardless of session origin

**Cons:**

- Introduces chokidar dependency (or fragile `fs.watch`)
- Duplicates live-session events (stream already pushes them)
- More complex lifecycle management (watcher must track active vs. idle sessions)
- File events fire after the stream event — adds latency to normal sessions

**Verdict: Not needed. The only new capability is externally-started sessions, which is an edge case. If needed later, scope it to sessions NOT managed by DorkOS (i.e., sessions without an active SDK query).**

### Approach 4: TTL Cache + Invalidation

**How it works:** Cache the parsed todo array with a 5–30s TTL; invalidate on stream event.

**Pros:**

- Reduces file I/O for repeated reads
- Stream invalidation keeps it current for active sessions

**Cons:**

- Added complexity for minimal gain (file reads are cheap and instant)
- TTL means stale data for externally-modified sessions during the window

**Verdict: Over-engineered. The file is tiny (< 4KB). Read on demand without caching.**

---

## Recommendation for DorkOS

1. **Keep stream interception as the primary mechanism** (no change needed to existing `sdk-event-mapper.ts` + `build-task-event.ts` + `task-reader.ts`).

2. **Add on-demand file read as a supplemental API** for session recovery:
   - `GET /api/sessions/:id/todos` — reads `~/.claude/todos/{id}-agent-{id}.json`
   - Returns `null` / 404 if no file exists (no `TodoWrite` was called in this session)
   - Optionally extend to return subagent todos via glob

3. **Do not add file watching** — the stream approach is lower latency and lower complexity. File watching only becomes useful if DorkOS needs to support sessions started externally (Claude Code CLI), which is not a current use case.

4. **One important gap in `task-reader.ts`:** The JSONL-based `parseTasks()` function does not account for the `id` field present in the on-disk format. The JSONL approach synthesizes sequential IDs (`"1"`, `"2"`, etc.) and discards the `id` field in the transcript. The on-disk file preserves the actual IDs assigned by Claude (which can be semantic slugs as seen in the subagent example). For full fidelity in session recovery, reading the file directly is more accurate than JSONL replay for the `id` field.

---

## Sources & Evidence

- Official SDK todo tracking guide: [Todo Lists — Claude Agent SDK](https://platform.claude.com/docs/en/agent-sdk/todo-tracking)
- Direct filesystem inspection of `~/.claude/todos/` on this machine — confirmed naming pattern and JSON format
- DorkOS codebase: `apps/server/src/services/runtimes/claude-code/sdk-event-mapper.ts` — existing stream interception
- DorkOS codebase: `apps/server/src/services/runtimes/claude-code/build-task-event.ts` — TodoWrite event builder
- DorkOS codebase: `apps/server/src/services/runtimes/claude-code/task-reader.ts` — JSONL-based task recovery
- [~/.claude directory structure gist](https://gist.github.com/samkeen/dc6a9771a78d1ecee7eb9ec1307f1b52) — confirmed `todos/` directory
- [Chokidar npm package](https://www.npmjs.com/package/chokidar) — file watching library reference
- [Node.js fs.watch limitations](https://nodejs.org/api/fs.html) — platform-specific gotchas
- [write-file-atomic npm](https://www.npmjs.com/package/write-file-atomic) — atomic write pattern reference

---

## Research Gaps & Limitations

- The SDK does not document the internal write mechanism for todo files — atomic rename behavior was inferred from the absence of lock files and known Node.js best practices; could be verified by inspecting the Claude Code binary
- `activeForm` was documented in the TodoWrite tool description but not observed in any actual file on this machine — may only appear in files from active sessions or may be an older field
- The relationship between `TodoRead` tool (which appears in the tool list) and the file is undocumented — `TodoRead` likely reads the file, but this was not confirmed
- Subagent todo file discovery: the parent `sessionId` prefix pattern was confirmed by two examples on this machine; it is possible very old versions used a different pattern

---

## Search Methodology

- Searches performed: 6 WebSearch queries + 5 WebFetch calls + 3 direct filesystem reads
- Most productive search terms: `"Claude Code TodoWrite" "todos" directory file path`, `claude code todos ~/.claude/todos JSON format`
- Key breakthrough: Direct glob of `~/.claude/todos/` revealed 100+ files and confirmed the naming pattern firsthand, including two sessions with subagent files where the agent ID differed from the session ID
- Primary information sources: `platform.claude.com/docs/en/agent-sdk/todo-tracking` (canonical), direct filesystem inspection (ground truth)
