---
title: 'OpenClaw Scheduler Architecture Analysis'
date: 2026-02-17
type: internal-architecture
status: archived
tags: [scheduler, openclaw, croner, cron, gateway]
feature_slug: pulse-scheduler
---

# OpenClaw Scheduler Architecture Analysis

**Date:** 2026-02-17
**Repo:** `/Users/doriancollier/Keep/openclaw`
**Research depth:** Deep

---

## Research Summary

OpenClaw implements a fully custom, self-contained cron scheduler called the **Gateway Cron Service**. It lives entirely inside the Gateway Node.js process and uses the `croner` npm library (v10) for 5-field cron expression evaluation. Jobs survive restarts via a JSON file at `~/.openclaw/cron/jobs.json`. The scheduler supports three schedule kinds (one-shot timestamps, fixed intervals, and cron expressions), two execution modes (main-session system events and isolated agent turns), and multiple delivery modes (announce to a channel, webhook POST, or none/internal). All management is exposed via CLI commands (`openclaw cron ...`), a Gateway RPC API (`cron.*` methods), and a web UI panel.

---

## Key Findings

1. **Scheduler library**: Uses `croner` (npm package `croner@^10.0.1`) only for evaluating 5-field cron expression `nextRun()` computation. The timer/tick loop, job persistence, and execution logic are all hand-written in TypeScript.

2. **Three schedule types**: `at` (one-shot ISO 8601 timestamp), `every` (fixed interval in milliseconds with an anchor), and `cron` (5-field expression + optional IANA timezone). All are stored in `~/.openclaw/cron/jobs.json`.

3. **Jobs survive restarts**: Job definitions are fully persisted to disk (JSON) after every mutation. On startup, the service reloads the store, clears any stale `runningAtMs` markers, runs any missed past-due jobs, and re-arms the timer.

4. **Two execution modes**: `main` session jobs enqueue a system event and optionally immediately trigger a heartbeat run. `isolated` session jobs spawn a dedicated agent turn in a session named `cron:<jobId>` and deliver results via announce/webhook/none.

5. **Timer architecture**: A single `setTimeout`-based tick loop. The timer fires at the earliest `nextRunAtMs` across all enabled jobs, clamped to a maximum of 60 seconds to prevent schedule drift after pauses or clock jumps.

6. **Exponential backoff on failure**: After each consecutive error, the next run is delayed: 30s, 1m, 5m, 15m, then 60m. Backoff resets on the next successful run.

7. **Management surface**: CLI (`openclaw cron add/edit/run/runs/list`), Gateway RPC API (`cron.list`, `cron.status`, `cron.add`, `cron.update`, `cron.remove`, `cron.run`, `cron.runs`), and a Lit-based web UI panel.

8. **Run history**: Per-job JSONL files at `~/.openclaw/cron/runs/<jobId>.jsonl`, auto-pruned to 2 MB / 2000 lines.

---

## Detailed Analysis

### 1. Scheduler Library Choice

OpenClaw uses `croner` v10 (MIT license) as a dependency declared in `package.json`:

```json
"croner": "^10.0.1"
```

`croner` is used only in `src/cron/schedule.ts` for a single purpose: computing the next occurrence of a cron expression from a given `Date`:

```typescript
// src/cron/schedule.ts
import { Cron } from 'croner';

const cron = new Cron(expr, {
  timezone: resolveCronTimezone(schedule.tz),
  catch: false,
});
const next = cron.nextRun(new Date(nowMs));
```

All other scheduling logic — timers, job queuing, persistence, backoff — is hand-written. `croner` is not used as an autonomous job runner; it is purely a cron expression parser/calculator.

### 2. Three Schedule Kinds

Defined in `src/cron/types.ts`:

```typescript
export type CronSchedule =
  | { kind: 'at'; at: string } // One-shot, ISO 8601
  | { kind: 'every'; everyMs: number; anchorMs?: number } // Fixed interval
  | { kind: 'cron'; expr: string; tz?: string }; // 5-field cron expression
```

**`at` (one-shot):**

- Runs exactly once at the given ISO 8601 timestamp.
- If `deleteAfterRun: true` (the default for `at` jobs), the job record is deleted after a successful run.
- If `deleteAfterRun: false`, the job is disabled after any terminal status (ok, error, skipped).
- One-shot jobs do NOT retry after failure.

**`every` (fixed interval):**

- The interval is stored as milliseconds (`everyMs`).
- An `anchorMs` epoch timestamp anchors the phase. The next run is computed as `anchor + N * everyMs` where N is the smallest integer such that the result is in the future.
- The anchor defaults to the job's `createdAtMs`, ensuring consistent drift-free phase across restarts.

**`cron` (cron expression):**

- Standard 5-field cron expressions (minute, hour, day-of-month, month, day-of-week).
- Optional IANA timezone (e.g., `America/Los_Angeles`). Falls back to the Gateway host's local timezone if omitted.
- After each run, a minimum 2-second gap is enforced (`MIN_REFIRE_GAP_MS = 2_000`) as a spin-loop guard against same-second rescheduling in edge cases.

### 3. Timer Architecture

**Single-timer loop** (`src/cron/service/timer.ts`):

```
armTimer()
  -> finds earliest nextRunAtMs across all enabled jobs
  -> clamps delay to MAX_TIMER_DELAY_MS (60 seconds)
  -> setTimeout → onTimer()

onTimer()
  -> if running: re-arm at 60s and return (non-blocking)
  -> find all due jobs (state.running = true)
  -> execute due jobs sequentially (maxConcurrentRuns defaults to 1)
  -> apply results, persist store
  -> state.running = false
  -> armTimer() (reschedule next tick)
```

Key design decisions:

- **Intentionally non-async timer callback**: The `setTimeout` callback is synchronous and spawns an async chain via `void onTimer(...).catch(...)`. This avoids blocking Vitest's fake timer helpers during testing.
- **Clamped maximum delay (60s)**: Even if the next job is hours away, the timer wakes every 60 seconds. This recovers quickly from wall-clock jumps (e.g., laptop sleep/wake) without relying on OS-level timer correction.
- **Non-blocking re-arm during execution**: If a job is still running when the 60s tick fires again, the timer immediately re-arms for another 60s instead of dropping the timer entirely. This prevents a long-running job from silently killing the scheduler.

### 4. Job Persistence

**Storage** (`src/cron/store.ts`):

- Default path: `~/.openclaw/cron/jobs.json` (configurable via `cron.store` in agent config).
- Format: `{ version: 1, jobs: CronJob[] }` (JSON, pretty-printed).
- Writes use atomic rename: write to a `.tmp` file, then `fs.rename()`. A `.bak` copy is made after each save.
- On every timer tick that needs to persist, the store is reloaded from disk first (`forceReload: true`) to detect external edits.

**Restart recovery** (`src/cron/service/ops.ts`, `start()`):

1. Load store from disk.
2. Clear any jobs with `runningAtMs` set (they were interrupted mid-run on the previous Gateway instance). These are collected into a `startupInterruptedJobIds` set so they are not re-run immediately as "missed" jobs.
3. Run any past-due jobs that were missed while the Gateway was down (`runMissedJobs`), skipping interrupted ones.
4. Recompute all `nextRunAtMs` values.
5. Persist updated store.
6. Arm the timer.

**Migration logic**: On load, `ensureLoaded()` applies a comprehensive in-place migration on each raw job record: normalizes `payload.kind` casing, migrates legacy delivery fields from payload to top-level `delivery`, converts `atMs` (number) to `at` (ISO string), infers missing `sessionTarget`, and writes back if anything mutated.

### 5. Execution Modes

#### Main session (system event)

```
Job fires
  -> resolveJobPayloadTextForMain() extracts text from payload
  -> enqueueSystemEvent(text, { agentId, sessionKey }) injects into the main session's event queue
  -> if wakeMode === "now":
       runHeartbeatOnce() with retry (up to 2 min) if heartbeat is busy
  -> if wakeMode === "next-heartbeat":
       requestHeartbeatNow() signals a soon heartbeat
```

Main jobs can only use `payload.kind = "systemEvent"`. They run within the shared main session context, so they share conversation history.

#### Isolated session (agent turn)

```
Job fires
  -> runIsolatedAgentJob({ job, message }) is called (injected dependency)
     -> Spawns a dedicated agent turn in session "cron:<jobId>"
     -> Each run starts a fresh session (no carry-over context)
     -> Prompt is prefixed with "[cron:<jobId> <job name>]"
  -> After completion:
       if delivery.mode === "announce" and not already delivered:
         enqueueSystemEvent(summary) + optional requestHeartbeatNow()
       if delivery.mode === "webhook":
         POST finished event JSON to delivery.to URL
       if delivery.mode === "none":
         no delivery
```

Isolated jobs support model and thinking level overrides per job (`payload.model`, `payload.thinking`), allowing cheaper or more powerful models for specific tasks.

### 6. Error Handling and Backoff

**Exponential backoff for recurring job failures** (in `src/cron/service/timer.ts`):

```typescript
const ERROR_BACKOFF_SCHEDULE_MS = [
  30_000, // 1st error  -> 30s
  60_000, // 2nd error  -> 1 min
  5 * 60_000, // 3rd error  -> 5 min
  15 * 60_000, // 4th error  -> 15 min
  60 * 60_000, // 5th+ error -> 60 min
];
```

- Backoff is applied only to recurring jobs (`every` and `cron` kinds). One-shot (`at`) jobs are disabled immediately after any terminal status.
- The next run time is `max(naturalNextRun, endedAt + backoff)` — ensuring the backoff never shortens the natural interval.
- `job.state.consecutiveErrors` is reset to 0 on any successful run.
- Schedule computation errors (invalid cron expressions, etc.) are tracked separately in `scheduleErrorCount`. After 3 consecutive schedule computation errors, the job is auto-disabled.

**Job timeout**: Each job execution is wrapped in a `Promise.race()` against a timeout. Default is 10 minutes. Isolated jobs can override via `payload.timeoutSeconds`. Setting `timeoutSeconds <= 0` disables the timeout.

**Stuck run detection**: If a job has `runningAtMs` set for more than 2 hours, the marker is cleared (recovery from crash without clean shutdown).

### 7. Management Surface

#### CLI (`openclaw cron ...`)

Registered via `src/cli/cron-cli.ts`. Example commands (from `docs/automation/cron-jobs.md`):

```bash
# Add a one-shot job
openclaw cron add \
  --name "Reminder" \
  --at "2026-02-01T16:00:00Z" \
  --session main \
  --system-event "Check the cron docs" \
  --wake now \
  --delete-after-run

# Add a recurring isolated job
openclaw cron add \
  --name "Morning brief" \
  --cron "0 7 * * *" \
  --tz "America/Los_Angeles" \
  --session isolated \
  --message "Summarize overnight updates." \
  --announce \
  --channel slack \
  --to "channel:C1234567890"

# List, run, view history
openclaw cron list
openclaw cron run <job-id>
openclaw cron runs --id <job-id> --limit 50
openclaw cron edit <job-id> --message "Updated prompt"
```

The `--at` flag accepts both ISO 8601 timestamps and human durations like `"20m"` or `"2h"`.

#### Gateway RPC API

Handlers in `src/gateway/server-methods/cron.ts`. All operations go through the `context.cron` (a `CronService` instance) via JSON RPC-style `request("cron.add", params)` calls:

| Method        | Description                                           |
| ------------- | ----------------------------------------------------- |
| `cron.list`   | List jobs (optional `includeDisabled`)                |
| `cron.status` | Status: enabled, job count, next wake time            |
| `cron.add`    | Add a new job                                         |
| `cron.update` | Patch an existing job (partial update)                |
| `cron.remove` | Delete a job                                          |
| `cron.run`    | Manually trigger a job (`"force"` or `"due"` mode)    |
| `cron.runs`   | Fetch run history for a job                           |
| `wake`        | Enqueue a system event + optional immediate heartbeat |

#### Web UI (`ui/src/ui/`)

A Lit-based web panel (`ui/src/ui/views/cron.ts`) renders:

- Scheduler status (enabled, job count, next wake time)
- New job creation form (all three schedule kinds, session target, payload kind, delivery mode)
- Job list with enable/disable, run, and delete actions
- Run history viewer (per job, last 50 runs)

The UI connects to the Gateway via `GatewayBrowserClient` and calls the same RPC methods as the CLI.

### 8. Run History

Per-job JSONL files at `~/.openclaw/cron/runs/<jobId>.jsonl`:

```typescript
// src/cron/run-log.ts
type CronRunLogEntry = {
  ts: number;
  jobId: string;
  action: 'finished';
  status?: 'ok' | 'error' | 'skipped';
  error?: string;
  summary?: string;
  sessionId?: string;
  sessionKey?: string;
  runAtMs?: number;
  durationMs?: number;
  nextRunAtMs?: number;
  model?: string;
  provider?: string;
  usage?: CronUsageSummary;
};
```

Pruning: Files are automatically pruned when they exceed 2 MB, keeping the most recent 2000 lines. Writes are serialized per file path via a `Map<string, Promise<void>>` to prevent concurrent append corruption.

### 9. Heartbeat vs Cron Distinction

OpenClaw distinguishes between two scheduling concepts (documented in `docs/automation/cron-vs-heartbeat.md`):

**Heartbeat**: A periodic polling loop that runs the agent in the main session at a configured interval (default 30 min). It is driven by a separate heartbeat mechanism, not the cron service. The agent reads a `HEARTBEAT.md` checklist and processes all items in one batched turn. If nothing needs attention, the agent replies `HEARTBEAT_OK` and no message is delivered.

**Cron**: Precise scheduling for exact-time jobs, standalone tasks that need session isolation, one-shot reminders, or tasks that require a different model. Cron jobs can optionally inject a system event into the main session to trigger a heartbeat run.

The two systems interact: `wakeMode: "now"` on a cron job causes the cron service to request an immediate heartbeat after enqueueing the system event.

### 10. Configuration

In the agent config file (`~/.openclaw/agents/<agentId>/config.json` or equivalent):

```json5
{
  cron: {
    enabled: true, // default: true
    store: '~/.openclaw/cron/jobs.json', // job store path
    maxConcurrentRuns: 1, // default: 1
    webhook: 'https://example.invalid/legacy', // deprecated legacy webhook
    webhookToken: 'bearer-token-for-webhook-delivery', // optional bearer token
  },
}
```

Disable cron:

- `cron.enabled: false` in config
- `OPENCLAW_SKIP_CRON=1` environment variable

### 11. Agent Binding

Jobs can be pinned to a specific agent via `agentId`. On startup, the service resolves session store paths per agent. If a job's `agentId` is missing or the agent is not found, it falls back to the default agent. The session reaper (which sweeps stale cron session data) runs per-agent based on which agents have active jobs.

---

## Architecture Diagram

```
Gateway Process (Node.js)
│
├── CronService (src/cron/service.ts)
│   ├── CronServiceState
│   │   ├── store: CronStoreFile | null      (in-memory cache)
│   │   ├── timer: NodeJS.Timeout | null     (single setTimeout handle)
│   │   └── running: boolean                 (execution lock)
│   │
│   ├── ops.ts          start/stop/list/add/update/remove/run/wakeNow
│   ├── timer.ts        armTimer/onTimer/executeJobCore/applyJobResult
│   ├── jobs.ts         computeJobNextRunAtMs/recomputeNextRuns/createJob/applyJobPatch
│   ├── store.ts        ensureLoaded/persist  (JSON file I/O)
│   └── locked.ts       serial operation queue (promise chain)
│
├── CronStore (~/.openclaw/cron/jobs.json)   (persisted job definitions)
├── CronRunLog (~/.openclaw/cron/runs/*.jsonl) (per-job run history)
│
├── Gateway RPC handlers (src/gateway/server-methods/cron.ts)
│   └── cron.list / cron.add / cron.update / cron.remove / cron.run / cron.runs / cron.status
│
└── CLI (src/cli/cron-cli/)
    └── openclaw cron add/edit/run/runs/list
```

```
Timer tick flow:
armTimer() → setTimeout(delay) → onTimer()
  │                                  │
  │                            find due jobs
  │                                  │
  │                         for each due job:
  │                           executeJobCore()
  │                             │
  │                     ┌───────┴───────┐
  │                  main session    isolated session
  │                enqueueSystemEvent  runIsolatedAgentJob()
  │                requestHeartbeatNow    │
  │                                      ├── announce delivery
  │                                      ├── webhook POST
  │                                      └── none
  │
  └── applyJobResult() → nextRunAtMs / backoff / delete
  └── persist()
  └── armTimer() ← loop
```

---

## Pros and Cons

### Pros

1. **Full persistence without a database**: Jobs survive process restarts via a single JSON file with atomic writes. No database dependency.

2. **Three schedule kinds cover the main use cases**: One-shot, fixed interval, and cron expressions with timezone support cover nearly all scheduling needs.

3. **Session isolation**: The `isolated` execution mode prevents cron jobs from polluting the main agent's conversation history, making it suitable for noisy or frequent background tasks.

4. **Delivery flexibility**: Per-job delivery configuration (announce to channel, webhook POST, or internal-only) means the same scheduling infrastructure covers both "notify me" and "background task" use cases.

5. **Model override per job**: Isolated jobs can use a cheaper or more powerful model independently of the main agent, allowing cost optimization for routine tasks.

6. **Robust restart recovery**: On startup, the service detects interrupted jobs, runs missed jobs, and correctly handles the case where the process was down for an extended period.

7. **Exponential backoff**: Automatic backoff after consecutive errors prevents retry storms while still recovering when the underlying issue clears.

8. **Well-tested**: The `src/cron/` directory contains extensive unit and regression tests covering edge cases (same-second rescheduling, restart recovery, daily skip bugs, stuck markers, delivery plan, etc.).

9. **Manual trigger**: `cron.run` with `mode: "force"` allows immediate testing of any job without waiting for its scheduled time.

10. **Integrated with heartbeat**: Cron jobs can request an immediate heartbeat wake, bridging cron (precise timing) with heartbeat (batched context-aware processing).

### Cons

1. **In-process scheduler**: The cron service lives inside the Gateway process. If the Gateway crashes or is restarted (e.g., for an update), cron is offline during the downtime. There is no separate, always-on scheduler daemon.

2. **No distributed execution**: The scheduler is strictly single-process. If multiple Gateway instances are run (unlikely in the single-user use case but possible in multi-tenant setups), they would each read/write the same `jobs.json` and potentially execute the same jobs simultaneously.

3. **Sequential job execution**: `maxConcurrentRuns` defaults to 1. Multiple due jobs execute one after the other. If one isolated job takes a long time, later due jobs are delayed. The 60-second re-arm keeps the scheduler alive, but concurrent execution is not supported.

4. **File-based locking, not OS-level**: The serialization is a promise chain (`locked.ts`) that only works within the same process. Cross-process safety relies on the single-process assumption plus atomic file renames.

5. **No built-in retry policy for one-shot jobs**: One-shot (`at`) jobs are permanently disabled after any failure. There is no built-in "retry N times before giving up" for time-specific reminders.

6. **`croner` only used for next-run computation**: The heavy cron ecosystem (job queuing, history, distributed locks) from libraries like `node-cron`, `bull`, `agenda`, or `cron` is not used. All supporting infrastructure is custom-built and must be maintained by the project.

7. **Manual edits to `jobs.json` are unsafe while Gateway is running**: The documentation warns that manual edits to the store file are only safe when the Gateway is stopped, because the in-memory store is the source of truth and is written back on every mutation.

8. **No timezone-aware "every" intervals**: The `every` schedule kind uses milliseconds and an anchor timestamp. There is no way to say "every day at midnight in my timezone" using `every` — that requires a `cron` expression.

---

## Sources & Evidence

- `"Cron is the Gateway's built-in scheduler. It persists jobs, wakes the agent at the right time..."` — `/Users/doriancollier/Keep/openclaw/docs/automation/cron-jobs.md`
- `"Jobs persist under ~/.openclaw/cron/"` — `/Users/doriancollier/Keep/openclaw/docs/automation/cron-jobs.md`, line 26
- `"croner": "^10.0.1"` — `/Users/doriancollier/Keep/openclaw/package.json`
- `import { Cron } from "croner";` — `/Users/doriancollier/Keep/openclaw/src/cron/schedule.ts`, line 1
- `MAX_TIMER_DELAY_MS = 60_000` — `/Users/doriancollier/Keep/openclaw/src/cron/service/timer.ts`, line 16
- `ERROR_BACKOFF_SCHEDULE_MS = [30_000, 60_000, 5*60_000, 15*60_000, 60*60_000]` — `/Users/doriancollier/Keep/openclaw/src/cron/service/timer.ts`, lines 45-51
- `DEFAULT_CRON_STORE_PATH = path.join(CONFIG_DIR, "cron", "jobs.json")` — `/Users/doriancollier/Keep/openclaw/src/cron/store.ts`, lines 8-9
- `await runMissedJobs(state, ...)` — `/Users/doriancollier/Keep/openclaw/src/cron/service/ops.ts`, line 49
- `resolveCronRunLogPath` → `runs/<jobId>.jsonl` — `/Users/doriancollier/Keep/openclaw/src/cron/run-log.ts`, lines 19-23

---

## Research Gaps & Limitations

- The actual `cron-cli/register.ts` file was not read (the `cron-cli.ts` was a one-line re-export). The CLI flag-to-API mapping was inferred from documentation and the cron-jobs doc examples rather than source.
- The `isolated-agent.ts` and `isolated-agent/run.ts` files were not read in full — the exact mechanism by which `runIsolatedAgentJob` spawns an agent turn is not detailed here, though the interface contract is clear from `state.ts`.
- Multi-agent scenarios (multiple agents each with their own cron jobs) were observed in the code but not traced in full detail.

---

## Search Methodology

- Files scanned: ~60+ source files in `/Users/doriancollier/Keep/openclaw/src/cron/`, `ui/src/ui/`, `docs/automation/`, and root `package.json`
- Key files read: `schedule.ts`, `service.ts`, `service/timer.ts`, `service/ops.ts`, `service/state.ts`, `service/jobs.ts`, `service/store.ts`, `store.ts`, `run-log.ts`, `types.ts`, `gateway/server-methods/cron.ts`, `ui/controllers/cron.ts`, `ui/views/cron.ts`, `ui/types.ts`, `docs/automation/cron-jobs.md`, `docs/automation/cron-vs-heartbeat.md`, `package.json`
- Search terms used: `cron`, `scheduler`, `schedule`, `recurring`, `interval`, `job`, `queue`, `croner`
- Primary sources: TypeScript source files (definitive), markdown docs (authoritative, maintained)
