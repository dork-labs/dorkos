---
title: 'NanoClaw Scheduler Architecture Analysis'
date: 2026-02-17
type: internal-architecture
status: archived
tags: [scheduler, nanoclaw, sqlite, cron, agent-runtime]
feature_slug: pulse-scheduler
---

# NanoClaw Scheduler Architecture Analysis

**Date**: 2026-02-17
**Source Repository**: `/Users/doriancollier/Keep/nanoclaw/repo`
**Research Mode**: Deep Research

---

## Research Summary

NanoClaw implements a bespoke, SQLite-backed scheduling system that runs three types of jobs (cron, interval, one-off) without any external scheduler library. A 60-second poll loop checks the database for due tasks and dispatches them as full Claude agent runs inside isolated Apple Container (Linux) VMs. Jobs are created exclusively via conversational NLP through a MCP server — the user asks Claude to schedule something, and Claude calls a structured MCP tool that writes a JSON IPC file, which the host process reads and persists to SQLite. This design trades scheduling precision (the 60-second granularity) for deep integration with the agent runtime and a zero-config, conversation-first UX.

---

## Key Findings

1. **No external scheduler library is used for dispatch**: Only `cron-parser` (npm package) is used — solely for parsing cron expressions and calculating the next `next_run` timestamp. There is no `node-cron`, `bull`, `agenda`, or similar job-runner.

2. **SQLite is the single source of truth**: All tasks, run logs, session IDs, and state are stored in `store/messages.db` (better-sqlite3). This means jobs survive restarts automatically with no extra persistence layer.

3. **Tasks are spawned as full agent containers**: Each scheduled task runs inside an Apple Container (Linux VM) with the same Claude Code agent stack the user interacts with in real-time. Tasks have access to all tools (Bash, WebSearch, file operations, browser automation).

4. **Jobs are created only through Claude (natural language → MCP)**: There is no CLI flag, API endpoint, or config file for scheduling. The user talks to the assistant, and Claude calls `mcp__nanoclaw__schedule_task` to create a task.

5. **Three schedule types are supported**: `cron` (standard 5-field cron expressions), `interval` (millisecond count), and `once` (ISO timestamp). One-off jobs auto-transition to `completed` status after running.

6. **The poll granularity is 60 seconds**: `SCHEDULER_POLL_INTERVAL = 60000` ms. This is a hard floor — sub-minute cron expressions will be attempted every 60 seconds at best.

7. **Two execution context modes**: Tasks can run in `isolated` mode (fresh Claude session, no history) or `group` mode (resumes the group's existing Claude conversation, has access to prior chat context).

8. **Authorization is enforced at the IPC layer**: Non-main groups can only create/pause/cancel tasks for themselves. Only the "main" group (the owner's self-chat) can schedule tasks for other groups.

---

## Detailed Analysis

### Architecture Overview

```
WhatsApp Message
    │
    ▼
Claude Agent (in Apple Container)
    │ calls mcp__nanoclaw__schedule_task
    ▼
IPC MCP Server (ipc-mcp-stdio.ts, inside container)
    │ writes JSON file atomically to /workspace/ipc/{group}/tasks/
    ▼
Host IPC Watcher (ipc.ts, polls every 1 second)
    │ reads + deletes JSON file, calls processTaskIpc()
    ▼
SQLite (store/messages.db) — scheduled_tasks table
    │ task written with next_run timestamp
    ▼
Scheduler Loop (task-scheduler.ts, polls every 60 seconds)
    │ getDueTasks() — SELECT WHERE next_run <= NOW()
    ▼
GroupQueue.enqueueTask()
    │ respects MAX_CONCURRENT_CONTAINERS (default: 5)
    ▼
runContainerAgent() → Apple Container (Linux VM)
    │ Claude Code agent with full tool access
    ▼
Result → updateTaskAfterRun() → next_run recalculated
```

### Scheduler Library: `cron-parser`

**Package**: `cron-parser` v5.5.0 (`CronExpressionParser`)

This library is used in exactly two roles:

1. **Validation**: When a task is created (via IPC), the cron expression is parsed and if invalid, the task creation is rejected with an error returned to Claude.
2. **Next-run calculation**: After a task completes, `interval.next().toISOString()` calculates the next `next_run` timestamp.

`cron-parser` is **not** used as a scheduler. It does not call any callbacks, fire any timers, or manage job state. It is a pure expression parser/iterator.

Timezone support is present: `CronExpressionParser.parse(expr, { tz: TIMEZONE })`. `TIMEZONE` defaults to `process.env.TZ` or `Intl.DateTimeFormat().resolvedOptions().timeZone` (system local timezone). Tasks are documented to operate in the user's local timezone.

### Job Definitions

Jobs are defined via the `ScheduledTask` TypeScript interface (from `src/types.ts`):

```typescript
interface ScheduledTask {
  id: string; // "task-{timestamp}-{random}"
  group_folder: string; // Which group owns this task
  chat_jid: string; // WhatsApp JID for message delivery
  prompt: string; // What Claude should do when it runs
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string; // Cron expr, ms string, or ISO timestamp
  context_mode: 'group' | 'isolated'; // Session continuity mode
  next_run: string | null; // ISO timestamp, null for paused/completed
  last_run: string | null;
  last_result: string | null; // First 200 chars of last output
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}
```

The SQLite schema adds indexes on `next_run` and `status` for efficient polling:

```sql
CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);
```

### Schedule Types in Detail

#### Cron (`schedule_type: 'cron'`)

- **Value format**: Standard 5-field cron expression (e.g., `"0 9 * * 1"` = Mondays at 9am)
- **Next-run calculation**: After each run, `CronExpressionParser.parse(value, { tz: TIMEZONE }).next().toISOString()`
- **Timezone-aware**: Yes, uses system local timezone
- **Recurring**: Yes, indefinitely until paused or cancelled
- **Minimum granularity**: 60 seconds in practice (poll interval), though `*/1 * * * *` would be attempted

#### Interval (`schedule_type: 'interval'`)

- **Value format**: Milliseconds as a string (e.g., `"3600000"` = every hour)
- **Next-run calculation**: `new Date(Date.now() + ms).toISOString()` — calculated relative to task completion time, not scheduled start time. If a task runs late or takes a long time, the next run slides accordingly.
- **Recurring**: Yes, indefinitely until paused or cancelled
- **Minimum granularity**: Same 60-second poll floor

#### Once (`schedule_type: 'once'`)

- **Value format**: ISO 8601 timestamp without `Z` suffix (local time, e.g., `"2026-02-01T15:30:00"`)
- **Next-run calculation**: `null` after running — no recalculation
- **Status transition**: `updateTaskAfterRun()` sets `status = 'completed'` when `nextRun IS NULL`
- **Recurring**: No, runs once and auto-completes

The relevant `updateTaskAfterRun` SQL:

```sql
UPDATE scheduled_tasks
SET next_run = ?, last_run = ?, last_result = ?,
    status = CASE WHEN ? IS NULL THEN 'completed' ELSE status END
WHERE id = ?
```

### The Poll-Based Dispatch Loop

`startSchedulerLoop()` in `src/task-scheduler.ts` runs a self-rescheduling async loop:

```typescript
const loop = async () => {
  const dueTasks = getDueTasks(); // SELECT WHERE status='active' AND next_run <= NOW()
  for (const task of dueTasks) {
    const currentTask = getTaskById(task.id); // Re-read to check for concurrent changes
    if (!currentTask || currentTask.status !== 'active') continue;

    deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () => runTask(currentTask, deps));
  }
  setTimeout(loop, SCHEDULER_POLL_INTERVAL); // 60,000 ms
};
loop();
```

Key properties:

- **No cron daemon**: It is a plain `setTimeout` recursion, not a cron-style wake-up.
- **Double-check before dispatch**: `getTaskById()` re-reads from SQLite before dispatching, preventing races where a task was paused between the poll query and the dispatch.
- **Duplicate-safe queue**: `GroupQueue.enqueueTask()` checks if a task ID is already in the pending queue and skips re-enqueuing.
- **Single-process guard**: A module-level `schedulerRunning` boolean prevents double-starting the loop if `startSchedulerLoop()` is called twice.

### Job Persistence and Restart Behavior

**Jobs survive restarts**: Because all task state — including `next_run` — is stored in SQLite, a restart has zero impact. On the next poll after startup, `getDueTasks()` returns any tasks whose `next_run` was in the past.

**Catch-up behavior**: If the process was down for 2 hours and had 4 hourly cron tasks due, all 4 will fire in the first poll cycle after restart. There is no "skip missed runs" logic.

**Session continuity**: If a task uses `context_mode: 'group'`, it resumes the group's Claude conversation (identified by session ID in SQLite). If the container crashed mid-run previously, the session may be in an indeterminate state, but the host simply re-runs the task with the same session ID.

### How Jobs Are Triggered (Exclusively via Conversation)

There is no direct API, CLI, or config file path for creating scheduled tasks. The only path is:

1. **User sends a WhatsApp message** like "remind me every Monday at 9am to check metrics"
2. **Claude calls `mcp__nanoclaw__schedule_task`** via the NanoClaw MCP server
3. **MCP server writes an IPC JSON file** atomically to `/workspace/ipc/{group}/tasks/`
4. **Host IPC watcher** (polling every 1 second) reads and deletes the file, calls `processTaskIpc()`
5. **`createTask()`** persists the task to SQLite with the calculated `next_run`

The MCP tool schema (from `container/agent-runner/src/ipc-mcp-stdio.ts`):

```typescript
{
  prompt: z.string(),
  schedule_type: z.enum(['cron', 'interval', 'once']),
  schedule_value: z.string(),
  context_mode: z.enum(['group', 'isolated']).default('group'),
  target_group_jid: z.string().optional(), // Main group only
}
```

Claude has guidance in the tool description about when to use `group` vs `isolated` context mode.

Management operations (pause, resume, cancel) also go through MCP → IPC → host handler. The agent reads tasks via a snapshot file (`current_tasks.json`) written to the group's IPC directory before each agent run — not via a live database query from inside the container.

### Task Execution Architecture

When a task fires, `runTask()` in `task-scheduler.ts`:

1. **Verifies the group still exists** in `registeredGroups` (in-memory, loaded from SQLite at startup)
2. **Writes a tasks snapshot** to the IPC directory so the container can read current task state
3. **Resolves session ID** (for `group` context mode) or leaves undefined (for `isolated`)
4. **Sets up an idle timer** (`IDLE_TIMEOUT`, default 30 minutes): if the container produces no output for this long, `queue.closeStdin()` writes a `_close` sentinel file, signaling the container to exit
5. **Calls `runContainerAgent()`** — spawns `container run -i --rm --name nanoclaw-{group}-{ts} {IMAGE}` with all volume mounts
6. **Passes the prompt with a scheduled-task prefix** inside the container: `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]`
7. **Streams output back** via `OUTPUT_START_MARKER`/`OUTPUT_END_MARKER` delimited JSON on stdout
8. **Sends any result text** to the WhatsApp group via `deps.sendMessage()`
9. **Logs the run** to `task_run_logs` table
10. **Recalculates `next_run`** and calls `updateTaskAfterRun()`

The task inherits the group's full container setup: mounted group directory, global memory, per-group `.claude/` sessions dir, and the NanoClaw MCP server. It runs with `permissionMode: 'bypassPermissions'` and `allowDangerouslySkipPermissions: true`.

### Concurrency Control (GroupQueue)

`GroupQueue` (`src/group-queue.ts`) enforces two constraints:

1. **Global concurrency limit**: At most `MAX_CONCURRENT_CONTAINERS` (default: 5) containers running simultaneously across all groups
2. **Per-group serialization**: Only one container runs per group at a time. If a group already has an active container (e.g., answering a user message) and a scheduled task fires, the task is queued and runs after the active container finishes.

Task priority: within a group's queue, **tasks take priority over pending messages** (in `drainGroup()`):

```typescript
// Tasks first (they won't be re-discovered from SQLite like messages)
if (state.pendingTasks.length > 0) {
  const task = state.pendingTasks.shift()!;
  this.runTask(groupJid, task);
  return;
}
// Then pending messages
if (state.pendingMessages) { ... }
```

### Run Logging

Every task execution is recorded in `task_run_logs`:

```sql
CREATE TABLE task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  status TEXT NOT NULL,   -- 'success' | 'error'
  result TEXT,            -- truncated to 200 chars from ScheduledTask
  error TEXT,
  FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
);
```

The `last_result` column on `scheduled_tasks` stores the most recent result summary (first 200 chars of output, or `Error: {message}`).

Container execution logs are written to `groups/{folder}/logs/container-{timestamp}.log` on the host. These include input, mount config, stdout, and stderr in verbose mode or on error.

---

## Source File Map

| File                                          | Role                                                                                                          |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/task-scheduler.ts`                       | Scheduler loop, `runTask()`, next-run calculation                                                             |
| `src/ipc.ts`                                  | IPC watcher, `processTaskIpc()`, `createTask()` dispatch                                                      |
| `src/db.ts`                                   | All SQLite operations: `createTask`, `getDueTasks`, `updateTaskAfterRun`, `logTaskRun`, etc.                  |
| `src/group-queue.ts`                          | Concurrency management, per-group serialization                                                               |
| `src/container-runner.ts`                     | Container spawn, volume mounts, output streaming                                                              |
| `src/config.ts`                               | `SCHEDULER_POLL_INTERVAL=60000`, `TIMEZONE`, `IDLE_TIMEOUT`, `MAX_CONCURRENT_CONTAINERS`                      |
| `src/types.ts`                                | `ScheduledTask`, `TaskRunLog` interfaces                                                                      |
| `container/agent-runner/src/ipc-mcp-stdio.ts` | MCP server inside container — `schedule_task`, `list_tasks`, `pause_task`, `resume_task`, `cancel_task` tools |
| `container/agent-runner/src/index.ts`         | Agent runner entrypoint — receives prompt, runs `query()`, handles IPC, scheduled-task prefix injection       |

---

## Pros and Cons of the Approach

### Pros

1. **Zero external dependencies for scheduling**: No Redis, no message broker, no separate scheduler process. Just SQLite and `setTimeout`. Simple to operate and debug.

2. **Restart resilience is automatic**: SQLite durability means scheduled tasks survive crashes, restarts, and OS reboots without any special recovery logic. The first poll after restart catches up immediately.

3. **Conversation-first UX**: Users create, modify, and delete tasks through natural language. Claude interprets intent and handles parameter mapping. No scheduling DSL to learn.

4. **Full agent capability for every task**: Scheduled tasks are not lightweight function calls — they are full Claude agent runs with Bash, web search, file operations, and browser automation available. This enables extremely sophisticated background tasks.

5. **Group-aware execution**: Tasks run in the context of their group's filesystem and memory, optionally continuing the group's conversation. This makes tasks that reference "our discussion" or "my notes" work naturally.

6. **Security via IPC isolation**: Each group has a namespaced IPC directory. The host enforces that non-main groups can only schedule tasks for themselves. This prevents container escape-style cross-group privilege escalation.

7. **Idempotent task creation**: The MCP server validates the schedule expression before writing the IPC file, preventing invalid tasks from being stored.

8. **Run audit trail**: `task_run_logs` provides a complete history of executions with duration, status, and output.

### Cons

1. **60-second granularity floor**: `SCHEDULER_POLL_INTERVAL = 60000` ms. A cron expression like `*/5 * * * *` fires only on the 60-second poll boundary, not at the exact second. Sub-minute scheduling is architecturally blocked.

2. **No missed-run catch-up logic**: If the service is down for 3 hours, all missed runs for that period fire simultaneously on the first poll cycle after restart. For high-frequency tasks this could cause a thunderstorm of container spawns hitting `MAX_CONCURRENT_CONTAINERS`.

3. **No task-specific retry logic**: If a task container exits with an error, it is logged and the next run proceeds as scheduled. There is no per-task retry policy (unlike job queues like Bull that support configurable retry attempts with backoff).

4. **All-or-nothing task execution**: Tasks run as full agent containers (minimum overhead: Apple Container Linux VM startup, Node.js cold start, Claude Code SDK init). There is no concept of a lightweight cron job for simple operations.

5. **No task dependencies or DAGs**: Tasks are independent. There is no way to chain tasks, have one task trigger another, or define task A → B → C pipelines.

6. **Container startup latency**: Apple Container VM startup takes 1–5 seconds. For tasks with precise timing requirements (e.g., "send the message at exactly 9:00:00 AM"), the actual execution time will drift by this amount.

7. **Conversation-only task creation**: There is no programmatic API or config file for task creation. Integrating scheduled tasks into a deployment script or CI pipeline would require either hitting the WhatsApp interface or directly inserting into SQLite (which bypasses the MCP validation layer).

8. **No distributed/multi-instance support**: The scheduler runs as a singleton in a single Node.js process. There is no coordination mechanism for running multiple NanoClaw instances against the same SQLite database.

9. **Group must be registered for tasks to fire**: In `runTask()`, if the group is not found in `registeredGroups` (in-memory), the task logs an error and skips. This could cause silent failures if a group is unregistered while tasks for it still exist in SQLite.

10. **No backpressure on the scheduler**: If 20 tasks are due simultaneously but `MAX_CONCURRENT_CONTAINERS` is 5, 15 tasks are enqueued in-memory only. If the process crashes before they run, those queued-but-not-yet-executed tasks are dropped. The next poll cycle will re-detect them from SQLite (since `next_run` has not been updated yet), which provides eventual correctness, but there is a window where a crash causes a task to be re-run.

---

## Research Gaps and Limitations

- The `container/agent-runner/package.json` was not read (it has its own dependencies including `@anthropic-ai/claude-agent-sdk` and `@modelcontextprotocol/sdk`). These are the runtime dependencies inside the container, not the scheduler.
- No tests for `task-scheduler.ts` were observed in the file listing, though `db.test.ts` exists which likely covers CRUD operations.
- The `launchd/com.nanoclaw.plist` uses `KeepAlive: true`, so the macOS service manager will restart the process on crash — mitigating some of the in-memory task loss concern.

---

## Search Methodology

- Files examined: 12 source files
- Key search strategy: Started with `AGENTS.md` + `SPEC.md` for architecture overview, then read all scheduler-adjacent source files directly
- Primary information sources: Source code at `/Users/doriancollier/Keep/nanoclaw/repo/src/` and `/Users/doriancollier/Keep/nanoclaw/repo/container/`
- No web searches performed (all information available from local source files)
