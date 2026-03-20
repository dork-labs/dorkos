# Ideation: DorkOS Pulse (Scheduler)

**Created:** 2026-02-18
**Spec Number:** 43
**Slug:** `pulse-scheduler`

## Vision

DorkOS Pulse is the heartbeat system that makes DorkOS alive. It's the autonomous execution loop — prompts that run on a schedule, in a given working directory, with full Claude Agent SDK capabilities. Pulse transforms DorkOS from a reactive chat interface into a proactive agent operating system.

From the brand foundation: "This is what makes DorkOS alive."

## Intent & Goals

### What Pulse Is

- **Scheduled agent jobs**: Cron-expression-driven prompts that execute at defined times
- **Project-scoped**: Each job runs in a specific CWD with full file/tool access
- **Agent-managed**: Claude can create, update, and cancel schedules via MCP tools during conversations
- **User-managed**: Web UI for viewing, creating, pausing, and monitoring scheduled jobs
- **Self-aware**: Running jobs know about the schedule system and can manage their own schedules

### What Pulse Is Not

- Not a distributed job queue (single-node, single-process)
- Not a CI/CD replacement (no build pipelines, artifact management)
- Not a task runner (no DAG dependencies between jobs)

### Goals

1. **Zero-config start**: `dorkos` starts with scheduler disabled; one toggle to enable
2. **Conversation-first creation**: "Run this prompt every day at 9am" → Claude creates the schedule via MCP tools
3. **Full observability**: Every run is logged with status, duration, output summary, and session linkage
4. **Graceful lifecycle**: Jobs can be paused, resumed, cancelled; runs can be aborted mid-flight
5. **Survive restarts**: Job definitions and run history persist across server restarts

## Architecture Overview

### Storage: `~/.dork/`

```
~/.dork/
├── config.json              # Existing — add scheduler section
├── schedules.json           # Job definitions (human-readable, agent-editable)
└── pulse.db                 # SQLite — run history, state tracking
```

**Why two stores?**

- `schedules.json`: Human-readable, git-friendly, agent can read/write via MCP tools. Contains job definitions only.
- `pulse.db`: SQLite for run history (potentially thousands of rows), atomic status transitions, indexed queries. Not meant to be human-edited.

### Core Components

```
┌─────────────────────────────────────────────────────┐
│                   DorkOS Server                      │
│                                                      │
│  ┌──────────────┐   ┌──────────────┐                │
│  │SchedulerSvc  │──▶│ AgentManager │                │
│  │  (poll loop) │   │  (SDK query) │                │
│  └──────┬───────┘   └──────────────┘                │
│         │                                            │
│  ┌──────▼───────┐   ┌──────────────┐                │
│  │ PulseStore   │   │ MCP Tools    │                │
│  │ (SQLite +    │   │ (schedule    │                │
│  │  JSON file)  │   │  CRUD)       │                │
│  └──────────────┘   └──────────────┘                │
│                                                      │
│  ┌──────────────┐   ┌──────────────┐                │
│  │ REST Routes  │   │ SSE Stream   │                │
│  │ /api/pulse/* │   │ (run updates)│                │
│  └──────────────┘   └──────────────┘                │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│                   DorkOS Client                      │
│                                                      │
│  ┌──────────────┐   ┌──────────────┐                │
│  │ PulsePanel   │   │ RunHistory   │                │
│  │ (schedule    │   │ (per-job     │                │
│  │  list + CRUD)│   │  run log)    │                │
│  └──────────────┘   └──────────────┘                │
└─────────────────────────────────────────────────────┘
```

## Job Model

### Schedule Definition (`schedules.json`)

```typescript
interface PulseSchedule {
  id: string; // UUID
  name: string; // Human-readable label
  prompt: string; // What Claude should do
  cron: string; // 5-field cron expression
  timezone: string; // IANA timezone (default: system)
  cwd: string; // Working directory for the job
  enabled: boolean; // Pause/resume toggle
  maxRuntime: number; // Timeout in ms (default: 10 minutes)
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
}
```

### Run Record (`pulse.db`)

```sql
CREATE TABLE runs (
  id TEXT PRIMARY KEY,           -- UUID
  schedule_id TEXT NOT NULL,     -- FK to schedules.json
  status TEXT NOT NULL,          -- 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  started_at TEXT,               -- ISO timestamp
  finished_at TEXT,              -- ISO timestamp
  duration_ms INTEGER,           -- Wall-clock duration
  output_summary TEXT,           -- First ~500 chars of agent output
  error TEXT,                    -- Error message if failed
  session_id TEXT,               -- SDK session ID (links to JSONL transcript)
  trigger TEXT NOT NULL,         -- 'scheduled' | 'manual'
  created_at TEXT NOT NULL       -- ISO timestamp
);

CREATE INDEX idx_runs_schedule ON runs(schedule_id, created_at DESC);
CREATE INDEX idx_runs_status ON runs(status);
```

**Key insight**: Each run produces an SDK JSONL transcript file. The `session_id` column links the run to that transcript, so users can view the full conversation in the existing chat UI.

## Scheduler Engine

### Poll Loop

Simple `setInterval`-based poll (no external scheduler library needed):

1. Every 60 seconds, read `schedules.json`
2. For each enabled schedule, check if `next_run <= now()`
3. If due, dispatch the job to `AgentManager.sendMessage()` with the schedule's prompt and CWD
4. Record the run in `pulse.db`
5. On completion/failure, update the run record and calculate next run time

**Why not croner/node-cron?** The poll loop is simpler, has zero dependencies, and 60-second granularity is sufficient for the use case. Cron expression parsing is the only external need (`cron-parser` library, already battle-tested by NanoClaw).

### Concurrency Control

- **Max concurrent runs**: Configurable (default: 1). Prevents runaway resource usage.
- **Job overlap protection**: If a job is still running when its next scheduled time arrives, skip that tick and log a warning.
- **AbortController**: Each run gets an AbortController. Timeout and manual cancellation both use `abort()`.

### System Prompt Injection

When a Pulse job runs, the agent receives additional context via system prompt:

```
You are running as a DorkOS Pulse scheduled job.
Job: "{name}"
Schedule: {cron} ({timezone})
Working directory: {cwd}

You have access to schedule management tools (mcp__dorkos__*) to create, update, or cancel scheduled jobs.
```

This gives the agent awareness that it's running autonomously and can manage its own future executions.

## MCP Tools

Extending the existing `mcp-tool-server.ts`:

| Tool              | Description                    | Input Schema                                                      |
| ----------------- | ------------------------------ | ----------------------------------------------------------------- |
| `list_schedules`  | List all scheduled jobs        | `{ enabled_only?: boolean }`                                      |
| `create_schedule` | Create a new scheduled job     | `{ name, prompt, cron, cwd?, timezone?, maxRuntime? }`            |
| `update_schedule` | Update an existing schedule    | `{ id, name?, prompt?, cron?, enabled?, timezone?, maxRuntime? }` |
| `delete_schedule` | Delete a schedule permanently  | `{ id }`                                                          |
| `get_run_history` | Get recent runs for a schedule | `{ schedule_id, limit?: number }`                                 |

These tools let the agent manage schedules conversationally: "Schedule a daily code review at 9am" → agent calls `create_schedule`.

## REST API

### Endpoints

| Method   | Path                               | Description                      |
| -------- | ---------------------------------- | -------------------------------- |
| `GET`    | `/api/pulse/schedules`             | List all schedules               |
| `POST`   | `/api/pulse/schedules`             | Create a schedule                |
| `PATCH`  | `/api/pulse/schedules/:id`         | Update a schedule                |
| `DELETE` | `/api/pulse/schedules/:id`         | Delete a schedule                |
| `POST`   | `/api/pulse/schedules/:id/trigger` | Trigger a manual run             |
| `GET`    | `/api/pulse/runs`                  | List recent runs (all schedules) |
| `GET`    | `/api/pulse/runs/:id`              | Get a specific run               |
| `POST`   | `/api/pulse/runs/:id/cancel`       | Cancel a running job             |

### SSE Stream

`GET /api/pulse/stream` — Real-time updates for the Pulse UI:

- `run_started` — A scheduled job began executing
- `run_completed` — A job finished (success or failure)
- `schedule_updated` — A schedule was created/modified/deleted

## Client UI

### FSD Integration

```
apps/client/src/layers/
├── entities/
│   └── pulse/              # NEW
│       ├── index.ts
│       └── model/
│           ├── use-schedules.ts    # TanStack Query for schedules
│           └── use-runs.ts         # TanStack Query for run history
├── features/
│   └── pulse/              # NEW
│       ├── index.ts
│       └── ui/
│           ├── PulsePanel.tsx          # Main schedule list view
│           ├── CreateScheduleDialog.tsx # Create/edit schedule form
│           └── RunHistoryPanel.tsx      # Per-schedule run history
```

### UI Concept

**PulsePanel** (accessible from sidebar or settings):

- List of schedules with name, cron expression (human-readable), next run time, enabled toggle
- Status indicators: green (active), gray (paused), red (last run failed)
- "Run Now" button for manual triggers
- Click to expand → shows RunHistoryPanel

**RunHistoryPanel** (per-schedule):

- Recent runs in a timeline/table: status icon, timestamp, duration, output preview
- Click a run → navigates to the full session transcript in the existing chat view (using `session_id`)
- This reuses the entire existing chat UI — no need to build a separate log viewer

**CreateScheduleDialog**:

- Name, prompt (multiline), cron expression with human-readable preview, CWD (directory picker), timezone selector
- "Test" button that does a dry run

## Logging Strategy

### Three-Tier Approach

1. **Run Records** (`pulse.db`): Structured metadata — status, duration, error summary. Used by the UI for the run history table.

2. **SDK Transcripts** (`~/.claude/projects/{slug}/{sessionId}.jsonl`): Full conversation transcript produced by every SDK `query()` call. This is the detailed log — every tool call, every text response. Already exists and works with the chat UI.

3. **Server Logs**: DorkOS server logging (existing infrastructure) captures scheduler lifecycle events: poll ticks, job dispatch, timeouts, errors.

**Key design decision**: We don't build a custom log viewer. The SDK transcript IS the log. Each run links to a session_id, and the existing chat UI renders it. This means users see the full agent conversation for every scheduled run — tool calls, file edits, everything.

### Retention

- `pulse.db` runs table: Keep last N runs per schedule (default: 100). Older runs are pruned on startup.
- SDK transcripts: Managed by SDK (no DorkOS intervention).
- Config: `scheduler.retentionCount` (default: 100).

## Configuration

### `~/.dork/config.json` Addition

```json
{
  "scheduler": {
    "enabled": false,
    "pollIntervalMs": 60000,
    "maxConcurrentRuns": 1,
    "timezone": null,
    "retentionCount": 100
  }
}
```

### CLI Flags

- `--pulse` / `--no-pulse`: Enable/disable scheduler at startup
- Precedence: CLI flag > env var (`DORKOS_PULSE_ENABLED`) > config > default (false)

## Resolved Decisions

1. **Session mode: New isolated session per run.** Each run gets a clean slate with its own JSONL transcript. The agent can check previous run results via the `get_run_history` MCP tool for continuity without accumulated state.

2. **Schedule scope: Global only.** All schedules live in `~/.dork/schedules.json`. Each schedule has a `cwd` field pointing to its project. Matches how `config.json` works today.

3. **Notifications: Web UI only for MVP.** Badge/indicator on the Pulse panel showing failed runs, plus a toast notification if the UI is open. External notifications (email, SMS, webhooks) deferred to the Channels feature on the roadmap.

4. **Resource limits: Timeout only.** Each schedule has a `maxRuntime` field (default: 10 minutes). AbortController cancels the SDK `query()` when time expires. No memory/CPU limits — the SDK subprocess manages its own resources.

5. **Authentication: Inherit tunnel auth.** If the tunnel has HTTP basic auth configured, it protects all `/api/*` routes including Pulse. No separate auth layer needed. Localhost-only users are already trusted.

## Ideas to Explore

- **"Pulse as a conversation"**: Instead of a separate UI, Pulse could be a special session that shows a timeline of all scheduled runs, with the ability to chat inline ("why did last night's run fail?")
- **Smart scheduling**: Claude suggests schedules based on natural language ("every morning" → `0 9 * * *`)
- **Chain reactions**: Job A completes → triggers Job B (DAG-like, but keep it simple)
- **Health check jobs**: Built-in "heartbeat" job that runs a simple health check, giving the system its literal pulse
- **Mobile push notifications**: When Pulse is running and a job completes/fails, push to mobile via tunnel

## Implementation Scope Estimate

### Phase 1: Core Engine (MVP)

- `PulseStore` (SQLite + JSON file management)
- `SchedulerService` (poll loop, dispatch, lifecycle)
- MCP tools (5 schedule management tools)
- REST routes (`/api/pulse/*`)
- Basic Pulse UI (schedule list, create dialog, run history)

### Phase 2: Polish

- SSE streaming for real-time UI updates
- "Run Now" manual trigger
- Cron expression human-readable preview
- Session linkage (click run → view transcript)
- Retention/pruning

### Phase 3: Advanced

- AbortController-based job cancellation
- Concurrency controls
- System prompt injection for self-aware jobs
- Settings UI integration (enable/disable toggle)
- CLI `--pulse` flag

## Prior Research

Six research documents inform this design:

- `research/scheduler-comparison.md` — Comparison of 8+ scheduling approaches; recommends file-based + SQLite + MCP tools
- `research/nanoclaw-scheduler-analysis.md` — Real-world SQLite-backed scheduler with 60s poll loop and cron-parser
- `research/openclaw-scheduler-analysis.md` — JSON file + croner scheduler with exponential backoff
- `research/scheduling-approaches-analysis.md` — Analysis of croner, toad-scheduler, node-schedule, Agenda, Bull, Bree, OS cron, Temporal
- `research/claude-code-sdk-agent-capabilities.md` — Full SDK Options reference including mcpServers, systemPrompt, hooks
- `research/mcp-tool-injection-patterns.md` — SDK constraints and architecture patterns for MCP tool injection
