---
title: "Pulse Scheduler — Design Research"
date: 2026-02-18
type: internal-architecture
status: active
tags: [pulse, scheduler, sqlite, cron, ux, run-log, agent]
feature_slug: pulse-scheduler
---

# Pulse Scheduler — Design Research

**Date:** 2026-02-18
**Scope:** Deep research for the Pulse cron scheduler feature in DorkOS
**Mode:** Deep Research

---

## Research Summary

This document synthesizes industry best practices across five topics critical for implementing the Pulse scheduler feature: SQLite persistence, cron UX patterns, job execution lifecycle, run log design, and system prompt injection for scheduled agents. The overarching theme is that desktop-class schedulers (single-user, local process) can afford simplicity where server-class schedulers cannot, but must be more careful about graceful degradation since there is no ops team to recover from failures.

---

## Key Findings

1. **SQLite + WAL mode is battle-tested** for this workload. `better-sqlite3`'s synchronous API is a natural fit for scheduler control paths. Native module build gotchas exist but are not a concern for DorkOS's current target (standard Node.js), only if the CLI ever targets Electron.

2. **Cron UX has converged on three tiers**: raw expression input with inline human-readable translation, a visual tab-based builder, and natural language parsing. All three should surface next-N-run previews. The DorkOS UI should default to natural language with cron as a power-user escape hatch.

3. **Job execution lifecycle needs five states**: `scheduled`, `running`, `completed`, `failed`, `cancelled`. AbortController is the correct cancellation primitive for Node.js. Concurrency must be capped per-job (not globally) to prevent runaway agents.

4. **Run logs need both a structured header row and a streaming body**. Separate the run metadata (SQLite) from the log content (append-only SQLite rows). GitHub Actions' grouping model (`startGroup`/`endGroup`) is directly applicable to tool-call phases in agent runs.

5. **System prompt injection for scheduled agents** should use `{ type: 'preset', preset: 'claude_code', append: '...' }` and inject a structured job context block — job ID, name, schedule expression, human-readable schedule, current run ID, invocation timestamp, and any user-defined instructions.

---

## Detailed Analysis

### 1. SQLite in Node.js Desktop Apps (`better-sqlite3`)

#### Best Practices from Industry

**WAL Mode is non-negotiable for concurrent access.**

WAL (Write-Ahead Logging) allows reads and writes to proceed concurrently without blocking each other. The setup is a single pragma call immediately after opening the connection:

```typescript
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');   // safe with WAL; faster than FULL
db.pragma('busy_timeout = 5000');    // retry for 5s before throwing SQLITE_BUSY
db.pragma('foreign_keys = ON');
```

`synchronous = NORMAL` is safe with WAL mode — data is flushed at each checkpoint, not every commit, giving a major throughput gain with acceptable durability for a desktop app.

**WAL file growth must be managed.**

In long-running processes, the WAL file can grow without bound if concurrent reads prevent checkpointing ("checkpoint starvation"). Monitor the `.db-wal` file size and force a checkpoint if it exceeds a threshold:

```typescript
const WAL_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB
setInterval(() => {
  try {
    const stat = fs.statSync(`${DB_PATH}-wal`);
    if (stat.size > WAL_SIZE_LIMIT) {
      db.pragma('wal_checkpoint(RESTART)');
    }
  } catch { /* WAL file may not exist yet */ }
}, 30_000);
```

**`busy_timeout` prevents cascading failures.**

Without it, any write contention during concurrent job firing causes an immediate `SQLITE_BUSY` exception. Setting it to 5000ms lets SQLite retry internally before throwing.

**Use prepared statements everywhere.**

`better-sqlite3` prepared statements are reused across calls automatically. Pre-compile all hot queries (status updates, log inserts) at startup, not inside the run loop.

**Wrap bulk operations in transactions.**

Individual row inserts are ~50x slower than batched transactions in SQLite. Log line inserts during agent streaming should be batched (e.g., flush every 100 lines or 500ms, whichever comes first).

**Schema migrations via `user_version`.**

Store schema version in `PRAGMA user_version` (SQLite's built-in integer). Run migrations synchronously at startup before any queries:

```typescript
const CURRENT_VERSION = 3;
const version = db.pragma('user_version', { simple: true }) as number;

if (version < 1) db.exec(MIGRATION_V1);
if (version < 2) db.exec(MIGRATION_V2);
if (version < 3) db.exec(MIGRATION_V3);

db.pragma(`user_version = ${CURRENT_VERSION}`);
```

Each migration should be wrapped in `BEGIN IMMEDIATE` / `COMMIT` and be idempotent (use `IF NOT EXISTS`).

Libraries worth evaluating:
- `@blackglory/better-sqlite3-migrations` — Minimal, uses `user_version` directly
- `better-sqlite3-helper` — Includes `-- Up` / `-- Down` syntax in SQL files

#### Recommendation for DorkOS

Use a thin custom migration runner (30 lines of TypeScript) rather than a library dependency. The migration surface for Pulse is small and stable. Store the DB at `~/.dork/pulse.db`.

Singleton pattern: one `Database` instance per process, opened once at server startup, never closed until SIGTERM/SIGINT. Register a graceful shutdown handler:

```typescript
process.on('SIGINT', () => { db.close(); process.exit(0); });
process.on('SIGTERM', () => { db.close(); process.exit(0); });
```

**Proposed schema:**

```sql
-- jobs: one row per scheduled job definition
CREATE TABLE IF NOT EXISTS jobs (
  id          TEXT PRIMARY KEY,           -- UUID
  name        TEXT NOT NULL,
  description TEXT,
  cron        TEXT NOT NULL,              -- OCPS expression
  tz          TEXT NOT NULL DEFAULT 'UTC',
  enabled     INTEGER NOT NULL DEFAULT 1, -- BOOLEAN (0/1)
  prompt      TEXT NOT NULL,              -- user-defined task instruction
  cwd         TEXT,                       -- working directory override
  max_retries INTEGER NOT NULL DEFAULT 0,
  timeout_ms  INTEGER,                    -- NULL means no timeout
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

-- runs: one row per job execution attempt
CREATE TABLE IF NOT EXISTS runs (
  id          TEXT PRIMARY KEY,           -- UUID
  job_id      TEXT NOT NULL REFERENCES jobs(id),
  status      TEXT NOT NULL DEFAULT 'running',
  -- status: 'running' | 'completed' | 'failed' | 'cancelled'
  exit_code   INTEGER,
  error       TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  duration_ms INTEGER,
  trigger     TEXT NOT NULL DEFAULT 'scheduled',
  -- trigger: 'scheduled' | 'manual'
  retry_of    TEXT REFERENCES runs(id)   -- NULL if first attempt
);

CREATE INDEX IF NOT EXISTS idx_runs_job_id ON runs(job_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_runs_started_at ON runs(started_at DESC);

-- run_logs: ordered log lines for a run
CREATE TABLE IF NOT EXISTS run_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id     TEXT NOT NULL REFERENCES runs(id),
  seq        INTEGER NOT NULL,           -- monotonic sequence within run
  ts         TEXT NOT NULL,             -- ISO 8601
  level      TEXT NOT NULL DEFAULT 'info',
  -- level: 'info' | 'tool' | 'error' | 'system'
  content    TEXT NOT NULL,
  group_name TEXT                        -- for collapsible sections (tool calls)
);

CREATE INDEX IF NOT EXISTS idx_run_logs_run_id ON run_logs(run_id, seq);
```

#### Gotchas

- **Native module ABI mismatch**: `better-sqlite3` compiles a `.node` binary tied to the Node.js ABI version. If the DorkOS server ever ships as an Electron app or the CLI targets a different Node.js version, the binary must be rebuilt. Use `electron-rebuild` or prebuilt binaries via `@mapbox/node-pre-gyp`.
- **Worker thread incompatibility**: `better-sqlite3` cannot be loaded in worker threads by default (Electron issue #43513). All DB access must stay on the main thread or in a dedicated single worker that serializes all access.
- **ASAR packaging**: The `.node` binary cannot live inside an ASAR archive. Use `asarUnpack` in electron-builder config.
- **Single-process constraint**: `better-sqlite3` is not safe for multiple processes writing to the same DB simultaneously. If Pulse is ever split into a separate worker process, switch to an IPC channel that serializes writes through a single owner.

---

### 2. Cron Expression UX

#### Best Practices from Industry

The state of the art in cron UX (circa 2025-2026) has three layers:

**Tier 1 — Natural Language Input**

Users type "every weekday at 9am" and the UI parses it to `0 9 * * 1-5` and shows the translation. This is the primary entry point for non-technical users. Libraries: `later.js`, `nlcronjob`, or LLM-assisted parsing (since DorkOS already has Claude available, this is an obvious integration point).

**Tier 2 — Visual Tab Builder**

A five-tab or segmented control UI (Minute / Hour / Day of Month / Month / Day of Week) where each field has radio options:
- Every [unit]
- Every N [units]
- Specific [units] (checkboxes/multi-select)
- Range from/to

The expression is reconstructed live as the user adjusts each field.

**Tier 3 — Raw Expression**

Power users can type the cron expression directly. Inline validation shows field names and error highlights. Human-readable translation always shown below the input.

**Next-N-run preview (universal requirement):**

Every production scheduler (Vercel, Railway, Windmill, Cronicle) shows the next 3-5 scheduled times in plain language ("in 4 hours", "tomorrow at 9:00 AM"). This is the most important UX affordance — it closes the feedback loop between expression and intent.

**Human-readable translation:**

`croner` exposes `nextRuns(n)` to get future execution times. Pair this with a library like `cronstrue` (npm) to produce "At 09:00 AM, Monday through Friday" from `0 9 * * 1-5`.

**Examples from production tools:**

- **Vercel Cron**: Code-centric (vercel.json), shows last/next run in dashboard, 1-click manual trigger
- **Railway Cron**: Simple text field with live preview, one expression per service
- **Windmill**: Full visual builder with natural language, per-schedule timezone, next-run preview, run history inline
- **Cronicle** (self-hosted): Most feature-rich — custom categories, timeout settings, retry config, dependency chains

#### Recommendation for DorkOS

Use a two-panel schedule editor in the Pulse job form:

1. **Primary input**: Natural language text field (ask Claude to parse it server-side, since the agent SDK is already integrated). Fall through to croner's expression parser if no NL parse is available.
2. **Expression display**: Show the resulting cron expression as a read-only badge. Tapping it opens a raw expression editor.
3. **Next runs preview**: Always show the next 5 run times, computed client-side using `croner.nextRuns(5)` with the selected timezone.
4. **Timezone selector**: Default to system timezone. Always store UTC-relative expressions with an explicit `tz` field (never assume server timezone).

The `cron-builder-ui` React component (shadcn/ui patterns) on GitHub is worth evaluating as a starting point, though it may need customization to match DorkOS's design language.

#### Gotchas

- **Seconds vs 5-field cron**: `croner` supports a 6-field expression (with seconds) and a 5-field expression. Be explicit in the UI about which format is accepted — mixed user expectations cause silent errors.
- **DST transitions**: Cron expressions in non-UTC timezones can fire twice or skip during DST transitions. Always store the IANA timezone name (`America/New_York`, not `EST`) and let croner handle the math.
- **Year field (OCPS 1.4)**: Croner supports a 7-field expression with year. Exposing this in the UI is unnecessary complexity for DorkOS's use case.

---

### 3. Job Execution Lifecycle

#### Best Practices from Industry

**Five states are the minimum viable lifecycle:**

```
scheduled -> running -> completed
                     -> failed
                     -> cancelled
```

With optional `retrying` as a transient state if retry logic is implemented.

**AbortController is the correct cancellation primitive in Node.js.**

Pass an `AbortSignal` to the SDK `query()` call. AbortController cascades cancellation through the entire async tree:

```typescript
const controller = new AbortController();
const { signal } = controller;

// Store controller reference keyed by run ID for external cancellation
activeRuns.set(runId, controller);

try {
  for await (const event of query({
    prompt: job.prompt,
    options: { /* ... */ },
    signal,
  })) {
    // handle events
  }
  await updateRunStatus(runId, 'completed');
} catch (err: unknown) {
  const name = (err as Error).name;
  if (name === 'AbortError' || name === 'TimeoutError') {
    await updateRunStatus(runId, 'cancelled');
  } else {
    await updateRunStatus(runId, 'failed', (err as Error).message);
  }
} finally {
  activeRuns.delete(runId);
}
```

**Timeout via `AbortSignal.timeout()` and `AbortSignal.any()`:**

```typescript
const signals: AbortSignal[] = [controller.signal];
if (job.timeout_ms) {
  signals.push(AbortSignal.timeout(job.timeout_ms));
}
const signal = AbortSignal.any(signals);
```

**Overrun protection (croner built-in):**

Croner has built-in overrun protection — if a job is still running when its next scheduled time arrives, croner skips the new invocation rather than spawning a second instance. This is the correct default for AI agent jobs. Croner exposes `isBusy()` to check this state.

**Per-job concurrency cap:**

Don't allow more than one simultaneous run per job. Track running jobs in a `Map<jobId, AbortController>`. If a job's scheduled time fires and it is already running, either skip (croner's default) or queue (not recommended for AI jobs — the queue can back up unboundedly).

**Global concurrency cap:**

Cap total simultaneous agent runs to prevent resource exhaustion. A value of 3-5 simultaneous agents is reasonable for a desktop app. Implement as a simple semaphore counter:

```typescript
const MAX_CONCURRENT = 3;
let runningCount = 0;

async function tryStartRun(job: Job): Promise<void> {
  if (runningCount >= MAX_CONCURRENT) {
    // log skip; record a 'skipped' sentinel in run_logs
    return;
  }
  runningCount++;
  try {
    await executeRun(job);
  } finally {
    runningCount--;
  }
}
```

**Retry strategy:**

For AI agent jobs, automatic retries on failure are often counterproductive — the agent may repeat the same harmful action. Recommendation: no automatic retries by default, with a `max_retries` config that defaults to 0. Manual "re-run" via the UI is safer than automatic retry.

**Graceful shutdown:**

On SIGTERM, stop accepting new jobs, wait for running jobs to complete (with a 30s timeout), then close the DB. Never abruptly kill running agent sessions — they may be mid-file-write.

#### Recommendation for DorkOS

Maintain an `activeRuns: Map<string, AbortController>` in the `PulseScheduler` service. The service owns:
- Croner job registration (`Cron` instances keyed by job ID)
- Run lifecycle (create run row, update status, write logs)
- Cancellation (expose `cancelRun(runId)` which calls `controller.abort()`)
- Concurrency enforcement

The existing `agent-manager.ts` can be used as-is for the actual agent execution — Pulse becomes another caller of `query()` rather than going through the HTTP session endpoint.

#### Gotchas

- **Memory leak from never-cleaned `activeRuns`**: Always delete the entry in `finally`, even on unexpected errors.
- **Croner's overrun protection fires per `Cron` instance**: If the server restarts, croner loses all state. On startup, query the DB for any `running` status runs and mark them `failed` (they were interrupted mid-run).
- **AbortError vs TimeoutError**: `AbortSignal.timeout()` throws `DOMException` with name `TimeoutError`, not `AbortError`. Handle both in the catch block.
- **Process exit before DB write**: If the process terminates unexpectedly, pending SQLite writes may not flush. Register `process.on('uncaughtException')` to attempt status cleanup before exit.

---

### 4. Logging for Scheduled Jobs

#### Best Practices from Industry

**Separate structured metadata from log body.**

The `runs` table (see schema above) holds structured metadata: status, duration, exit code, trigger type. The `run_logs` table holds the timestamped line content. Never conflate these — structured fields enable queries like "show all runs that failed in the last 7 days" without parsing log text.

**Essential metadata per run:**

- `run_id` (UUID)
- `job_id`
- `trigger` (scheduled / manual)
- `started_at` / `finished_at` (ISO 8601 with milliseconds)
- `duration_ms`
- `status` (completed / failed / cancelled)
- `error` (exception message if failed)
- `retry_of` (run ID if this is a retry attempt)

**Essential metadata per log line:**

- `seq` (monotonic integer within run — enables pagination and ordering without relying on timestamp uniqueness)
- `ts` (ISO 8601 timestamp)
- `level` (`info` / `tool` / `error` / `system`)
- `content` (the log text)
- `group_name` (for collapsible sections, e.g., a tool call's input/output)

**GitHub Actions' grouping model is directly applicable.**

GitHub Actions uses `::group::Title` / `::endgroup::` markers to create collapsible sections in the log viewer. For DorkOS, tool calls are natural group boundaries:
- `group_name = 'tool:bash'` for a Bash tool execution
- `group_name = 'tool:read'` for a file read
- `group_name = null` for plain assistant text

The UI renders these as expandable cards, collapsed by default for tool results (which are often verbose), expanded for errors.

**GitHub Actions UI patterns:**

GitHub's log viewer (as described in their engineering blog) handles 50k+ lines via DOM virtualization — grouping log lines in clusters of N and swapping clusters rather than individual lines. For DorkOS this only matters if agent runs produce thousands of lines.

**Streaming vs batch log ingestion:**

Agent SDK events stream in real-time. Two options:
1. **Write-through**: Insert each log line immediately as it arrives. Simplest, but creates high write pressure (hundreds of DB writes per run).
2. **Buffer + flush**: Accumulate lines in memory, flush every 100 lines or 500ms. Reduces write pressure dramatically, with acceptable staleness for live log tailing.

For DorkOS, option 2 is recommended. Implement a `RunLogWriter` that auto-flushes and always force-flushes on run completion.

**Vercel's log metadata model (for reference):**

Each log row has: timestamp, execution duration, domain, HTTP status, function type, RequestId. The `RequestId` is the equivalent of `run_id` — it links all log lines to a single invocation.

**Log retention:**

Store run logs indefinitely by default (local disk is cheap), but provide a "Clean up logs older than N days" setting. For disk size estimates: an agent run producing 500 log lines at ~200 bytes each equals ~100KB per run. At 10 runs/day, that is ~365MB/year — well within SQLite's practical limits.

#### Recommendation for DorkOS

**Log writer service pattern:**

```typescript
class RunLogWriter {
  private buffer: RunLogLine[] = [];
  private seq = 0;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private runId: string,
    private insertMany: (rows: RunLogLine[]) => void
  ) {}

  append(level: LogLevel, content: string, groupName?: string): void {
    this.buffer.push({
      run_id: this.runId,
      seq: this.seq++,
      ts: new Date().toISOString(),
      level,
      content,
      group_name: groupName ?? null,
    });
    if (this.buffer.length >= 100) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 500);
    }
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.buffer.length === 0) return;
    const lines = this.buffer.splice(0);
    this.insertMany(lines);
  }

  close(): void {
    this.flush();
  }
}
```

**Log tailing via SSE:**

Expose `GET /api/pulse/runs/:runId/logs?after=<seq>` that returns log lines with `seq > after`. The client polls this at 1-2s intervals during active runs. On run completion, the SSE stream sends a `done` event and the client stops polling.

**Log viewer UI:**

Model after GitHub Actions — fixed-height scrollable container with virtualized rendering (react-virtual or similar) for runs with more than 1000 lines. Group tool calls behind a disclosure triangle. Show elapsed time per group. Highlight `error`-level lines in red.

#### Gotchas

- **SQLite text encoding**: Store log content as UTF-8 TEXT. ANSI escape codes from CLI output should be stripped server-side (use `strip-ansi`) before storage, and a separate rich-format field can optionally store the raw ANSI for terminal-faithful replay.
- **Log line ordering**: Never rely on `ts` alone for ordering — two lines within the same millisecond will have identical timestamps. The `seq` field is the canonical order.
- **Disk exhaustion**: If an agent runs amok and produces millions of log lines, it can fill the disk. Cap `run_logs` insertion at, say, 50,000 lines per run, then write a sentinel log line indicating truncation.
- **SQLite BLOB vs TEXT for large logs**: For very large runs, consider storing log content in a separate append-only file (one file per run) and only storing the file path in SQLite. This avoids SQLite page fragmentation from large TEXT values, though adds operational complexity.

---

### 5. System Prompt Injection for Scheduled Agents

#### Best Practices from Industry

**The Agent SDK's `append` field is the correct mechanism.**

Using `{ type: 'preset', preset: 'claude_code', append: '...' }` preserves all of Claude Code's built-in tool instructions, safety guidelines, and code formatting rules, while injecting job-specific context. Using a custom `systemPrompt` string requires reimplementing all of that from scratch.

**`settingSources` must be explicit.**

The `claude_code` preset does NOT automatically load `CLAUDE.md` files. To give scheduled agents access to project context, include `settingSources: ['project']` and ensure the job's `cwd` points to the relevant project directory.

**Context injection should answer: who am I, why am I running, what should I do?**

Scheduled agents lack the interactive context that human-initiated sessions have. Without explicit job context, the agent may:
- Not know it is running unattended (and stall waiting for user input instead of making autonomous decisions)
- Not know the purpose of the run
- Not know it should operate conservatively (no destructive actions without high confidence)
- Not report results in a structured way

**Security: prompt injection via job definitions.**

Job names, descriptions, and prompts are user-controlled data that gets injected into the system prompt. Sanitize these fields before injection — at minimum, validate they do not contain XML-like tag sequences or instruction-override patterns.

**Output styles provide reusable behavior across all Pulse runs.**

The SDK docs confirm that output styles stored in `~/.claude/output-styles/` are loaded when `settingSources: ['user']` is included. A Pulse-specific output style can enforce structured output formatting for all scheduled agent runs without repeating it in every job's prompt.

#### Recommendation for DorkOS

**Standard context block for all Pulse runs:**

```typescript
function buildPulseAppend(job: Job, run: Run): string {
  return [
    '---',
    '## PULSE SCHEDULER CONTEXT',
    '',
    'You are running as a scheduled agent in DorkOS Pulse.',
    '',
    '**Job Information:**',
    `- Job Name: ${job.name}`,
    `- Job ID: ${job.id}`,
    `- Schedule: ${job.cron} (${humanReadableCron(job.cron, job.tz)})`,
    `- Timezone: ${job.tz}`,
    `- Run ID: ${run.id}`,
    `- Triggered At: ${run.started_at}`,
    `- Trigger Type: ${run.trigger}`,
    `- Retry Attempt: ${run.retry_of ? 'Yes (previous run failed)' : 'No'}`,
    '',
    '**Execution Guidelines:**',
    '- You are running UNATTENDED. Do not prompt for user input or wait for confirmation.',
    '- If you encounter ambiguity, make a conservative decision and log your reasoning.',
    '- Prefer read and analyze operations. For write operations, proceed only if the job description clearly authorizes them.',
    '- Report your findings, actions, and results clearly in your final message.',
    '- If you cannot complete the task due to an error, describe what you tried and what failed.',
    '',
    '**User Instructions:**',
    sanitizeForPrompt(job.prompt),
    '---',
  ].join('\n');
}
```

**SDK call pattern:**

```typescript
for await (const event of query({
  prompt: `Execute the scheduled job: ${job.name}`,
  options: {
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildPulseAppend(job, run),
    },
    settingSources: job.cwd ? ['project', 'user'] : ['user'],
    cwd: job.cwd ?? process.env.DORKOS_DEFAULT_CWD,
  },
  signal,
})) {
  // handle events
}
```

**Permission mode considerations:**

- Default (approval required): Not viable for unattended runs. The agent stalls waiting for approval.
- `acceptEdits`: Allows file edits without approval. Safe for most maintenance jobs.
- `bypassPermissions`: Full autonomous mode. Reserve for explicitly trusted, well-scoped jobs.

Expose `permissionMode` as a per-job setting in the UI. Default to `acceptEdits`. Show a clear warning for `bypassPermissions` ("Allow this job to execute commands without approval").

**Output style for scheduled agents:**

Create `~/.claude/output-styles/pulse-job.md` that instructs Claude to:
- Always end with a `## Run Summary` section listing what was done
- Use structured format for findings that the Pulse UI can parse
- Keep status updates concise (no verbose progress narration)

This output style is loaded via `settingSources: ['user']`.

#### Gotchas

- **Context window exhaustion on long runs**: The `append` text is injected at the start of every session. For jobs that run on large codebases, keep the append text concise (under 500 tokens). The job instructions should be a task description, not a novel.
- **Re-runs inherit stale context**: The `started_at` timestamp in the append block is correct only for the initial session creation. Use the DB run start time, not `Date.now()` at message-send time.
- **Prompt injection via job.prompt**: Never interpolate `job.prompt` without validation. Apply a `sanitizeForPrompt()` function that strips or escapes XML-like tags and rejects patterns like "ignore previous instructions" before building the append block.
- **`settingSources` + CLAUDE.md interaction**: If `settingSources: ['project']` is set and the job's `cwd` points to a project with a CLAUDE.md that conflicts with the Pulse guidelines, the project CLAUDE.md may override the Pulse append. This is expected SDK behavior, but document it for users who configure Pulse jobs targeting projects with strong CLAUDE.md instructions.

---

## Security Considerations

- **Job file validation**: Job definitions stored in `~/.dork/` are JSON files. Validate against a strict Zod schema on load. Reject unknown fields.
- **Directory boundary enforcement**: Apply the same `lib/boundary.ts` boundary validation to the `cwd` field in job definitions. Scheduled jobs should not be able to target directories outside the configured boundary.
- **Prompt injection in job names/descriptions**: These fields appear in the system prompt append block. Apply `sanitizeForPrompt()` before injection. Reject payloads containing XML-like tag sequences or instruction-override patterns.
- **Permission mode default**: Default to `acceptEdits`, not `bypassPermissions`. Document this clearly in the UI with a warning for the bypass mode.
- **Tunnel exposure**: If the ngrok tunnel is enabled, the Pulse management API (create/edit/delete jobs, trigger runs) must require authentication. The `TUNNEL_AUTH` env var should be enforced on all Pulse routes.
- **Run log confidentiality**: Run logs may contain sensitive output (API keys found in files, personal data). The log viewer should not be publicly accessible if the tunnel is enabled without auth.
- **MCP tools for agent self-scheduling**: MCP tools that let agents manage their own schedules (create/modify/delete jobs) are a privilege escalation surface. Treat MCP-originated job mutations as untrusted and require human confirmation in the UI before they take effect.

---

## Performance Considerations

- **SQLite is not the bottleneck**: At the scale DorkOS targets (dozens of jobs, hundreds of runs/day), SQLite in WAL mode with prepared statements handles the load trivially. Optimize for developer ergonomics, not raw throughput.
- **Croner is in-memory only**: Croner does not persist state across restarts. On server startup, reload all enabled jobs from SQLite and re-register with croner. This is a cold start, not a migration.
- **Log write batching**: The `RunLogWriter` buffer (100 lines or 500ms) is the single most impactful performance optimization for log-heavy runs. Without it, a verbose agent producing 10 lines/second creates 600 DB writes/minute.
- **Run history pagination**: The runs list endpoint should paginate (default 50 per page, keyset pagination on `started_at`). Never load all runs for all jobs in a single query.
- **Concurrent agent resource usage**: Each running Claude Code session holds a context window and an active API connection. At 3 simultaneous runs (the recommended cap), this is 3 active API calls to Anthropic. Monitor token consumption — scheduled agents can be expensive if schedules are aggressive.
- **croner's `isBusy()` check**: Before starting a run, call `cronJob.isBusy()` to confirm the previous invocation has completed. This is redundant with the `activeRuns` map but is a cheap defensive check.

---

## Recommendation Summary

| Decision | Recommendation | Rationale |
|---|---|---|
| SQLite WAL mode | Enable immediately on DB open | Concurrency + performance |
| Schema migrations | Custom runner using `user_version` | Simple surface, no library overhead |
| DB location | `~/.dork/pulse.db` | Consistent with config dir |
| WAL checkpoint | Monitor and force-checkpoint at 10MB | Prevent unbounded WAL growth |
| Log storage | `run_logs` table with `seq` ordering | Supports pagination and grouping |
| Log batching | Buffer 100 lines or 500ms | Reduce write pressure |
| Cron UX | NL primary, raw expression secondary | Lower barrier for non-technical users |
| Next-run preview | Always show next 5 runs | Closes feedback loop |
| Timezone | Store IANA name, default to system TZ | DST safety |
| Job states | `scheduled`, `running`, `completed`, `failed`, `cancelled` | Minimum viable lifecycle |
| Cancellation | `AbortController` + `AbortSignal.any()` for timeout | Clean async cancellation |
| Retries | Default 0, manual re-run preferred | Prevent runaway agents |
| Concurrency | 1 per job + 3 global cap | Desktop resource limits |
| System prompt | `preset: 'claude_code'` with `append` context block | Preserve built-in safety |
| Permission mode | `acceptEdits` default, `bypassPermissions` opt-in | Conservative safe default |
| Prompt injection filter | Validate job.prompt before append | Security |
| Output style | Pulse-specific output style via `settingSources: ['user']` | Structured run summaries |

---

## Research Gaps and Limitations

- **Claude Agent SDK `signal` parameter**: The official SDK documentation does not confirm the exact parameter name for passing an AbortSignal to `query()`. Verify against the actual `@anthropic-ai/claude-agent-sdk` type definitions before implementing.
- **Croner + TypeScript strict mode**: No research was found on known type definition issues with croner in strict TypeScript environments. Test with `skipLibCheck: false`.
- **CLAUDE.md override behavior**: The exact precedence rules when both `append` and CLAUDE.md (via `settingSources`) are active is not documented beyond what the official SDK docs state. Empirical testing is needed.
- **better-sqlite3 with Turborepo**: No specific guidance was found for native module handling in Turborepo monorepos (vs. standard npm workspaces). Since DorkOS does not ship Electron for the server target, this is lower risk — the build target is the host Node.js, avoiding ABI mismatch issues.

---

## Contradictions and Disputes

- **Retry logic**: Some scheduler frameworks (Agenda, BullMQ) strongly advocate for automatic retry with exponential backoff. For traditional background jobs, this is correct. For AI agent jobs, the argument against automatic retry is stronger — a failing agent may be failing for a reason (permission denied, service down) that will not resolve on retry, and blindly retrying wastes tokens and can cause harm. DorkOS should default to no automatic retry but make manual re-run trivial.
- **Log storage (SQLite vs files)**: The "SQLite for everything" approach is operationally simple but creates large TEXT values in SQLite pages. The "flat file per run" approach (one `.log` file per run in `~/.dork/runs/<run-id>.log`) is more file-system native and easier to grep/tail externally, but adds a second storage system to manage. For DorkOS, SQLite wins on simplicity — the log tailing SSE endpoint is implemented with a simple `SELECT ... WHERE seq > ?` query.

---

## Search Methodology

- Searches performed: 12
- WebFetch calls: 3 (Anthropic SDK docs, croner overview, SQLite background job system article)
- Most productive search terms: "better-sqlite3 WAL mode long-running", "croner npm OCPS", "AbortController Node.js timeout cancellation 2024", "Claude Agent SDK modifying system prompts"
- Primary information sources: Official Anthropic SDK docs, croner documentation, GitHub Issues (better-sqlite3, Electron), BetterStack Node.js guides, SQLite forum, Databricks job system tables, GitHub Actions engineering blog
