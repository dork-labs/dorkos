---
title: 'Scheduler Feature Research: Comprehensive Comparison'
date: 2026-02-17
type: internal-architecture
status: archived
tags: [scheduler, comparison, croner, sqlite, nanoclaw, openclaw]
feature_slug: pulse-scheduler
---

# Scheduler Feature Research: Comprehensive Comparison

**Date**: 2026-02-17 (updated)
**Context**: DorkOS needs the ability to run AI agents at regular intervals via a scheduler
**Individual reports**: [OpenClaw analysis](openclaw-scheduler-analysis.md) | [NanoClaw analysis](nanoclaw-scheduler-analysis.md) | [General approaches](scheduling-approaches-analysis.md) | [SDK capabilities](claude-code-sdk-agent-capabilities.md)

---

## Executive Summary

We evaluated 8 scheduling approaches across two real-world implementations (OpenClaw, NanoClaw) and six general-purpose patterns. After a deep analysis of the DorkOS architecture — specifically the hard boundary between our Express API and the Claude Code SDK agent — our **revised recommendation is a file-based approach with SQLite for run history**.

The key architectural insight: **the Claude Code agent has zero awareness of DorkOS**. It cannot call our API, cannot query a database, and has no custom tools. It is a subprocess that only sees the user's prompt and standard filesystem tools. This fundamentally changes the persistence layer calculus.

### Recommendation: File-Based Jobs + SQLite Run History + SDK MCP Tools

| Layer               | Store                           | Purpose                                         |
| ------------------- | ------------------------------- | ----------------------------------------------- |
| Job definitions     | `~/.dork/schedules.json`        | Agent-readable, LLM-editable, human-debuggable  |
| Run history & state | SQLite (`~/.dork/scheduler.db`) | ACID audit trail, queryable, UI-friendly        |
| Agent interaction   | SDK in-process MCP tools        | Full CRUD for agents via `createSdkMcpServer()` |
| User interaction    | REST API + client UI            | CRUD, manual triggers, run history              |

---

## Critical Architecture Insight: The SDK Boundary

Before evaluating approaches, we need to understand DorkOS's unique constraint.

### The Data Flow

```
User (browser) → DorkOS React client
                     → HttpTransport.sendMessage()
                         → POST /api/sessions/:id/messages
                             → AgentManager.sendMessage()
                                 → SDK query({ prompt, options })
                                     → Claude Code subprocess
                                         ↑
                                 THIS AGENT CANNOT SEE DORKOS.
                                 It has no API access, no custom tools,
                                 no MCP servers, no system prompt append.
                                 It only has filesystem tools (Read, Edit, Bash, etc.)
```

### What the SDK Currently Receives

```typescript
// From agent-manager.ts — this is ALL that's passed to query()
const sdkOptions: Options = {
  cwd: effectiveCwd,
  includePartialMessages: true,
  settingSources: ['project', 'user'],
  pathToClaudeCodeExecutable: this.claudeCliPath,
  resume: session.sdkSessionId,       // for session continuity
  permissionMode: 'default',           // or bypassPermissions, plan, acceptEdits
  canUseTool: async (...) => { ... },  // approval callback
  // NO systemPrompt
  // NO mcpServers
  // NO agents
  // NO hooks (beyond canUseTool)
};
```

### What This Means for Scheduling

The agent that runs when a scheduled job fires is a standard Claude Code session. It can:

- `Read` files from the filesystem
- `Write` / `Edit` files
- Run `Bash` commands
- `Glob` / `Grep` for content
- Access `WebSearch` / `WebFetch`

It **cannot**:

- Call DorkOS REST endpoints (it doesn't know they exist)
- Query a SQLite database directly (no DB tool)
- Access in-process services (it's a subprocess)
- Manage other schedules via API

This makes file-based storage significantly more valuable than originally assessed — **it's the only persistence format the agent can natively read and write**.

### Three Ways to Bridge the Gap

The SDK supports several mechanisms we don't currently use that could give the agent schedule-awareness:

#### Option A: File-Based (Agent Uses Read/Write)

The agent reads `~/.dork/schedules.json` with its built-in `Read` tool. Zero additional infrastructure.

```
Agent wants to see schedules → Read ~/.dork/schedules.json → done
Agent wants to create a job  → Edit ~/.dork/schedules.json → done
```

**Pros**: Works today with zero code changes to the SDK integration. Any Claude Code session (CLI, DorkOS, any client) can read/write schedules.
**Cons**: No validation on writes. File conflicts possible during concurrent access. Must handle JSON parse errors.

#### Option B: SDK MCP Tools (Agent Uses Custom Tools)

We define in-process MCP tools via `createSdkMcpServer()` + `tool()` and inject them into `query()`. The agent gets named tools like `mcp__dorkos__list_schedules`, `mcp__dorkos__create_schedule`.

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

const schedulerMcp = createSdkMcpServer({
  name: 'dorkos',
  version: '1.0.0',
  tools: [
    tool(
      'list_schedules',
      'List all scheduled jobs with their status and next run time',
      { enabled_only: z.boolean().optional() },
      async ({ enabled_only }) => {
        const jobs = schedulerService.listJobs({ enabledOnly: enabled_only });
        return { content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
      }
    ),
    tool(
      'create_schedule',
      'Create a new scheduled job',
      {
        name: z.string(),
        prompt: z.string().describe('What the agent should do when this job runs'),
        cron: z.string().describe("Cron expression (e.g. '0 9 * * 1-5')"),
        timezone: z.string().optional(),
        context_mode: z.enum(['isolated', 'continuing']).default('isolated'),
      },
      async (args) => {
        const job = schedulerService.createJob(args);
        return {
          content: [{ type: 'text', text: `Created schedule: ${job.name} (${job.cronHuman})` }],
        };
      }
    ),
    // ... update_schedule, delete_schedule, list_runs, etc.
  ],
});

// In AgentManager.sendMessage():
sdkOptions.mcpServers = { dorkos: schedulerMcp };
```

**Pros**: Zod validation on all inputs. Direct access to scheduler service (in-process, zero overhead). Agent gets clean tool descriptions. Type-safe.
**Cons**: Requires SDK MCP tool changes to agent-manager.ts. Only available in sessions started through DorkOS (not bare CLI). Requires `prompt` to be `AsyncIterable<SDKUserMessage>` (SDK constraint for in-process MCP).

#### Option C: System Prompt Append (Agent Reads Context)

We use `systemPrompt: { type: "preset", preset: "claude_code", append: "..." }` to tell the agent about its scheduling context — what job triggered it, what its schedule is, where to find schedule files.

```typescript
sdkOptions.systemPrompt = {
  type: 'preset',
  preset: 'claude_code',
  append: `You are running as a scheduled DorkOS agent.
Job: "${job.name}" | Schedule: ${job.cronHuman} | ID: ${job.id}
Schedule file: ~/.dork/schedules.json (you can Read this for context)
Run history: ~/.dork/runs/${job.id}.json (you can Read this for past results)`,
};
```

**Pros**: Agent understands its context. Combines naturally with file-based storage. Simple to implement.
**Cons**: Only provides context, not tools. Agent still needs file access for management.

### Recommended: All Three Combined

The approaches are complementary, not competing:

1. **File-based `schedules.json`** — always-available, LLM-readable, works in any session
2. **SDK MCP tools** — validated CRUD when running through DorkOS (injected into `query()`)
3. **System prompt append** — contextualizes scheduled job runs ("you are running because...")

The agent gets the **best path available**: MCP tools when present (DorkOS sessions), file read/write as fallback (CLI sessions), and always has context about why it's running.

---

## Approaches Evaluated

| #     | Approach                                                                | Real-world Example |
| ----- | ----------------------------------------------------------------------- | ------------------ |
| 1     | Custom scheduler + JSON file persistence                                | OpenClaw           |
| 2     | Custom scheduler + SQLite persistence                                   | NanoClaw           |
| 3     | In-process cron library (croner/node-cron/node-schedule)                | —                  |
| 4     | Job queue library (Agenda/Bull/BullMQ/Bree)                             | —                  |
| 5     | OS-level scheduler (crontab/Task Scheduler)                             | —                  |
| 6     | File-based config (JSON/YAML)                                           | —                  |
| 7     | croner + SQLite only (original recommendation)                          | —                  |
| 8     | Temporal/workflow engines                                               | —                  |
| **9** | **File-based jobs + SQLite history + SDK MCP (revised recommendation)** | —                  |

---

## Comparison Matrix

| Dimension                     | OpenClaw (JSON) | NanoClaw (SQLite)  | croner only | Bree         | Agenda       | BullMQ      | OS Cron    | File-based     | croner+SQLite   | **File+SQLite+MCP**              | Temporal      |
| ----------------------------- | --------------- | ------------------ | ----------- | ------------ | ------------ | ----------- | ---------- | -------------- | --------------- | -------------------------------- | ------------- |
| **Regular scheduled jobs**    | Yes             | Yes                | Yes         | Yes          | Yes          | Yes         | Yes        | Yes            | Yes             | **Yes**                          | Yes           |
| **One-off jobs**              | Yes (`at`)      | Yes (`once`)       | Yes (Date)  | Yes          | Yes          | Yes         | Partial    | Partial        | Yes             | **Yes**                          | Yes           |
| **Complex rules**             | 5-field + tz    | 5-field + tz       | OCPS 1.4    | Cron + human | Cron + human | Cron        | Cron       | Cron           | OCPS 1.4        | **OCPS 1.4**                     | DAGs          |
| **Survives restarts**         | Yes (JSON)      | Yes (SQLite)       | No          | No           | Yes (Mongo)  | Yes (Redis) | Yes (OS)   | Yes (file)     | Yes (SQLite)    | **Yes (file+SQLite)**            | Yes           |
| **macOS compatible**          | Yes             | Yes                | Yes         | Yes          | Needs Mongo  | Needs Redis | Yes        | Yes            | Yes             | **Yes**                          | Needs server  |
| **Windows compatible**        | Yes             | Yes                | Yes         | Yes          | Needs Mongo  | Needs Redis | No         | Yes            | Yes             | **Yes**                          | Needs server  |
| **Agent-readable**            | Yes (JSON)      | No (binary DB)     | N/A         | Job files    | No           | No          | No         | Yes            | No              | **Yes (JSON + MCP)**             | No            |
| **Agent-manageable**          | No              | Yes (MCP)          | No          | No           | No           | No          | No         | Partial (Edit) | No              | **Yes (MCP + file)**             | No            |
| **Job management interface**  | CLI + RPC + UI  | Conversation (MCP) | Code        | Code         | Code + REST  | Code        | CLI        | File edit      | CLI + REST + UI | **CLI + REST + UI + MCP + file** | Web UI        |
| **Easy to build UI around**   | Yes (RPC)       | No (MCP only)      | No          | Partial      | Yes          | Yes         | No         | Partial        | Yes (REST)      | **Yes (REST)**                   | Yes           |
| **Can trigger LLM calls**     | Yes             | Yes                | Yes         | Yes          | Yes          | Yes         | Yes        | Yes            | Yes             | **Yes**                          | Yes           |
| **Implementation complexity** | High            | Medium-High        | Low         | Medium       | High         | High        | Low        | Low            | Medium          | **Medium**                       | Very High     |
| **External services**         | None            | None               | None        | None         | MongoDB      | Redis       | None       | None           | None            | **None**                         | Temporal + DB |
| **Sleep/wake handling**       | 60s clamp       | SQLite catch-up    | No          | No           | N/A          | N/A         | OS handles | No             | Per-job policy  | **Per-job policy**               | N/A           |
| **Missed run recovery**       | Startup sweep   | Fires all          | No          | No           | Via Mongo    | Via Redis   | OS handles | No             | Configurable    | **Configurable**                 | Yes           |
| **Run history/audit**         | JSONL per job   | SQLite table       | None        | None         | MongoDB      | Redis       | None       | None           | SQLite          | **SQLite**                       | Built-in      |
| **Error backoff**             | Exponential     | None               | None        | None         | Config       | Config      | None       | None           | Config          | **Exponential**                  | Built-in      |

---

## Detailed Approach Summaries

### 1. OpenClaw: Custom Scheduler + JSON File

**How it works**: A single `setTimeout`-based tick loop clamped to 60 seconds drives execution. `croner` v10 is used only for cron expression next-run calculation. Jobs are stored in `~/.openclaw/cron/jobs.json` with atomic rename writes. Three schedule types: `at` (one-shot ISO timestamp), `every` (fixed ms interval with phase anchor), `cron` (5-field + timezone). Two execution modes: main session (system event injection) or isolated session (dedicated agent turn). Exponential backoff on failure (30s -> 1m -> 5m -> 15m -> 60m).

**Pros**: Full persistence without a database, three schedule kinds, session isolation, delivery flexibility (announce/webhook/none), model override per job, robust restart recovery, well-tested, manual trigger support.

**Cons**: In-process only (offline during restarts), no distributed execution, sequential job execution (max 1 concurrent), custom-built infrastructure maintenance burden, manual JSON edits unsafe while running.

### 2. NanoClaw: Custom Scheduler + SQLite

**How it works**: A 60-second `setTimeout` poll loop queries SQLite for due tasks (`WHERE next_run <= NOW()`). `cron-parser` v5 is used only for expression validation and next-run calculation. Jobs are created exclusively via natural language through MCP tools (user talks to Claude, Claude calls `schedule_task`). Each task runs as a full Claude agent in an isolated Apple Container Linux VM. Two context modes: `isolated` (fresh session) or `group` (continues conversation).

**Pros**: Zero external dependencies, automatic restart resilience via SQLite, conversation-first UX, full agent capability per task, group-aware execution, security via IPC isolation.

**Cons**: 60-second granularity floor, no missed-run catch-up logic, no retry policies, conversation-only task creation (no programmatic API), container startup latency.

### 3-6. General Approaches

See the [scheduling approaches analysis](scheduling-approaches-analysis.md) for detailed coverage of: in-process cron libraries (croner, toad-scheduler, node-schedule, node-cron), job queue libraries (Agenda, Bull, Bree), OS-level schedulers, and file-based scheduling.

**Key takeaways**:

- **Agenda/BullMQ**: Require MongoDB/Redis respectively — disqualified for desktop/CLI use
- **OS cron**: macOS/Linux only, no Windows support — disqualified for cross-platform
- **Temporal**: Massive infrastructure overkill for local scheduled agent invocations
- **Bree**: Viable secondary option if worker thread isolation is needed, but each job must be a separate file
- **croner**: Best cron library — zero deps, OCPS 1.4 compliance, TypeScript-native, used by PM2/Uptime Kuma

### 7. Original Recommendation: croner + SQLite Only

The original recommendation was croner + SQLite for everything — job definitions, run history, and scheduler state. While this is operationally robust, it suffers from a critical problem in DorkOS's architecture: **the Claude Code agent cannot read SQLite**. The agent has no database tool, no custom MCP tools, and no awareness of DorkOS APIs. An agent asked "what schedules exist?" would have no way to answer.

This approach would work for a system where only the server and UI manage schedules, but it fails the "agent self-awareness" requirement.

---

## Revised Recommendation: File-Based Jobs + SQLite History + SDK MCP Tools

### Why This Wins

The revised recommendation splits the data across two stores based on **who needs to read it**:

| Data                    | Store                         | Primary Reader                       | Why This Store                                  |
| ----------------------- | ----------------------------- | ------------------------------------ | ----------------------------------------------- |
| Job definitions         | `~/.dork/schedules.json`      | Agent (Read tool), Server, UI, Human | Must be LLM-readable without tooling            |
| Run history             | SQLite `~/.dork/scheduler.db` | Server, UI                           | Queryable, append-only, agents rarely need this |
| Scheduler runtime state | In-memory (croner instances)  | Server only                          | Ephemeral, rebuilt from JSON on startup         |

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│ DorkOS Server Process                                           │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │  SchedulerService                                         │  │
│  │                                                           │  │
│  │  ┌─────────────┐  ┌────────────────┐  ┌───────────────┐  │  │
│  │  │   croner     │  │ schedules.json │  │ scheduler.db  │  │  │
│  │  │  (runtime    │  │ (job defs —    │  │ (run history  │  │  │
│  │  │   timers)    │←─│  source of     │  │  & state —    │  │  │
│  │  │             │  │  truth)        │  │  audit trail) │  │  │
│  │  └──────┬──────┘  └───────┬────────┘  └───────┬───────┘  │  │
│  │         │                 │                    │           │  │
│  │         │   On job fire:  │   On mutation:     │           │  │
│  │         │   read prompt   │   atomic write     │           │  │
│  │         │   from JSON     │   + notify croner  │           │  │
│  │         │                 │                    │           │  │
│  └─────────┼─────────────────┼────────────────────┼───────────┘  │
│            │                 │                    │               │
│  ┌─────────┼─────────────────┼────────────────────┼───────────┐  │
│  │  When firing a job:       │                    │           │  │
│  │                           │                    │           │  │
│  │  AgentManager.sendMessage(jobPrompt, {         │           │  │
│  │    systemPrompt: { preset: "claude_code",      │           │  │
│  │      append: "You are a scheduled DorkOS agent.│           │  │
│  │              Job: Daily Digest                  │           │  │
│  │              Schedule: Weekdays at 9am..."      │           │  │
│  │    },                                          │           │  │
│  │    mcpServers: { dorkos: schedulerMcpServer }, ← in-process│  │
│  │    maxTurns: 25,        // runaway prevention  │           │  │
│  │    maxBudgetUsd: 1.00,  // cost cap per run    │           │  │
│  │  })                                            │           │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │  REST API (routes/schedules.ts)                            │  │
│  │                                                            │  │
│  │  GET    /api/schedules          → list jobs                │  │
│  │  POST   /api/schedules          → create job               │  │
│  │  PATCH  /api/schedules/:id      → update job               │  │
│  │  DELETE /api/schedules/:id      → delete job               │  │
│  │  POST   /api/schedules/:id/run  → manual trigger           │  │
│  │  GET    /api/schedules/:id/runs → run history              │  │
│  │  GET    /api/schedules/export   → raw JSON for LLM import  │  │
│  └────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘

The agent inside the SDK sees:
┌─────────────────────────────────────────────────────────────────┐
│ Claude Code Agent (SDK subprocess)                              │
│                                                                 │
│  Available via built-in tools:                                  │
│  • Read ~/.dork/schedules.json       ← always works, any session│
│  • Edit ~/.dork/schedules.json       ← modify jobs directly     │
│  • Read ~/.dork/runs/<jobId>.json    ← see own run history      │
│                                                                 │
│  Available via injected MCP tools (DorkOS sessions only):       │
│  • mcp__dorkos__list_schedules       ← validated, typed         │
│  • mcp__dorkos__create_schedule      ← Zod validation           │
│  • mcp__dorkos__update_schedule      ← safe partial updates     │
│  • mcp__dorkos__delete_schedule      ← cleanup                  │
│  • mcp__dorkos__trigger_schedule     ← manual run               │
│  • mcp__dorkos__list_runs            ← query run history        │
│                                                                 │
│  Available via system prompt (scheduled runs only):             │
│  • Knows its job name, schedule, and purpose                    │
│  • Knows where schedule files live                              │
│  • Knows it's running as a scheduled task                       │
└─────────────────────────────────────────────────────────────────┘
```

### The `schedules.json` File Format

Designed for maximum LLM readability:

```json
{
  "$schema": "https://dorkos.ai/schemas/schedules.json",
  "version": 1,
  "jobs": [
    {
      "id": "daily-digest",
      "name": "Daily Digest",
      "description": "Summarize git activity and open PRs from the last 24 hours",
      "prompt": "Review the git log for the last 24 hours and summarize what changed. Check for any open PRs that need attention.",
      "schedule": {
        "type": "cron",
        "cron": "0 9 * * 1-5",
        "cronHuman": "Every weekday at 9am",
        "timezone": "America/New_York"
      },
      "enabled": true,
      "contextMode": "isolated",
      "model": "sonnet",
      "maxTurns": 25,
      "maxBudgetUsd": 1.0,
      "missedRunPolicy": "skip",
      "cwd": "/Users/me/projects/myapp",
      "createdAt": "2026-02-17T10:00:00Z",
      "updatedAt": "2026-02-17T10:00:00Z"
    },
    {
      "id": "weekly-review",
      "name": "Weekly Code Review",
      "description": "Deep review of code quality trends",
      "prompt": "Analyze the codebase for code quality trends over the past week. Look at test coverage changes, new TODOs, and potential tech debt.",
      "schedule": {
        "type": "cron",
        "cron": "0 16 * * 5",
        "cronHuman": "Every Friday at 4pm",
        "timezone": "America/New_York"
      },
      "enabled": true,
      "contextMode": "isolated",
      "model": "opus",
      "maxTurns": 50,
      "maxBudgetUsd": 5.0,
      "missedRunPolicy": "run_once",
      "cwd": "/Users/me/projects/myapp",
      "createdAt": "2026-02-17T10:00:00Z",
      "updatedAt": "2026-02-17T10:00:00Z"
    },
    {
      "id": "reminder-deploy",
      "name": "Deploy Reminder",
      "prompt": "Remind me to deploy the staging build.",
      "schedule": {
        "type": "once",
        "at": "2026-02-20T14:00:00-05:00",
        "atHuman": "Thursday Feb 20 at 2pm EST"
      },
      "enabled": true,
      "contextMode": "isolated",
      "createdAt": "2026-02-17T10:00:00Z",
      "updatedAt": "2026-02-17T10:00:00Z"
    }
  ]
}
```

Key design decisions:

- **Flat JSON, not YAML** — matches DorkOS conventions (`config.json`, `manifest.json`)
- **Human-readable labels alongside machine values** — `cronHuman` next to `cron`
- **`prompt` field is the agent instruction** — this is what gets passed to `query()`
- **Schedule type union** — `cron`, `interval` (everyMs), `once` (ISO timestamp)
- **Per-job resource limits** — `maxTurns`, `maxBudgetUsd`, `model`
- **`contextMode`** — `isolated` (fresh session each run) or `continuing` (resumes a persistent session per job)
- **`missedRunPolicy`** — `skip` (default for AI tasks), `run_once`, `run_all`
- **`cwd`** — per-job working directory (agent operates in this context)

### Why File-Based for Job Definitions Is the Right Call

1. **The agent can read it natively** — `Read ~/.dork/schedules.json` works in any Claude Code session, whether started from DorkOS, the CLI, or any other client. No MCP tools needed.

2. **The agent can write it natively** — `Edit ~/.dork/schedules.json` lets the agent create or modify schedules. A user can say "schedule a daily code review at 9am" and the agent can do it by editing the file, even in a vanilla CLI session.

3. **LLMs understand JSON deeply** — an LLM can reliably read, reason about, and generate valid JSON. The format is self-documenting with descriptive field names and human labels.

4. **Human debuggable** — `cat ~/.dork/schedules.json | jq` shows everything. No database tools needed.

5. **Version controllable** — could be committed to a repo if desired (team schedules).

6. **Hot-reloadable** — `fs.watch` can detect changes and re-arm the scheduler. This means edits from any source (agent, CLI, UI, manual) are picked up automatically.

7. **OpenClaw validates this pattern** — their `jobs.json` approach works well in production. The key difference is we add SQLite alongside it (not instead of it) for the data that doesn't need to be agent-readable.

### Why SQLite for Run History Is Still Right

Run history is **write-heavy, append-only, and rarely read by agents**. It's the perfect SQLite workload:

- Thousands of run records over time — JSON would bloat
- Queries like "show me the last 10 runs of this job" are trivial in SQL
- ACID guarantees prevent corruption from concurrent writes
- The UI needs queryable, paginated history — SQLite delivers this
- Agents almost never need run history (and when they do, we can expose it via MCP tools or a per-job `~/.dork/runs/<jobId>.json` summary file)

### How the Scheduler Handles File Mutations

The OpenClaw problem of "manual edits unsafe while running" is solved by treating the file as an event source:

```typescript
class SchedulerService {
  private jobs = new Map<string, Cron>();
  private watcher: FSWatcher;

  async start() {
    // 1. Load jobs from file
    const config = await this.loadScheduleFile();
    for (const job of config.jobs) {
      if (job.enabled) this.armJob(job);
    }

    // 2. Watch for external changes (agent edits, CLI, manual)
    this.watcher = watch('~/.dork/schedules.json', { debounce: 200 }, () => {
      this.reconcile(); // diff file vs in-memory, add/remove/update croner jobs
    });
  }

  // All mutations go through this — writes JSON atomically, then reconciles
  async mutateJobs(fn: (jobs: ScheduleJob[]) => ScheduleJob[]) {
    const config = await this.loadScheduleFile();
    config.jobs = fn(config.jobs);
    await this.writeScheduleFile(config); // atomic write (tmp + rename)
    this.reconcile();
  }
}
```

Key properties:

- **File is always the source of truth** — in-memory state is a cache
- **Any writer is valid** — REST API, CLI, agent `Edit`, manual editor
- **Reconciliation** detects diffs between file and in-memory croner jobs
- **Atomic writes** prevent partial reads (write to `.tmp`, then `rename`)
- **Debounced watcher** prevents thrashing on rapid edits

### Addressing the OpenClaw JSON Concerns

OpenClaw's documented problems with JSON persistence and how we solve them:

| OpenClaw Problem                    | Our Solution                                                                                                      |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| "Manual edits unsafe while running" | File watcher + reconciliation. File is always source of truth, not in-memory state.                               |
| No atomic updates                   | `write tmp + rename` pattern (same as OpenClaw, but we don't fight against it)                                    |
| No transactional job state tracking | Run state goes to SQLite, not JSON. JSON only has definitions.                                                    |
| File conflicts on concurrent writes | Debounced watcher + last-write-wins with reconciliation. MCP tools use `mutateJobs()` for safe in-process writes. |

The core insight: OpenClaw's problems come from **using JSON for both definitions and runtime state**. By splitting definitions (JSON) from state (SQLite), we get the readability of files without the fragility of using files as a database.

---

## SDK MCP Tools Design

When running through DorkOS, the agent gets additional validated tools via `createSdkMcpServer()`:

```typescript
const schedulerMcpServer = createSdkMcpServer({
  name: 'dorkos',
  version: '1.0.0',
  tools: [
    tool(
      'list_schedules',
      'List all scheduled jobs with their status, schedule, and next run time',
      { enabled_only: z.boolean().optional().describe('Only show enabled jobs') },
      async ({ enabled_only }) => {
        const jobs = schedulerService.getJobs({ enabledOnly: enabled_only });
        return { content: [{ type: 'text', text: JSON.stringify(jobs, null, 2) }] };
      }
    ),

    tool(
      'create_schedule',
      'Create a new scheduled job that runs a Claude agent at specified times',
      {
        name: z.string().describe('Human-readable job name'),
        prompt: z.string().describe('Instructions for the agent when the job runs'),
        cron: z.string().describe("Cron expression, e.g. '0 9 * * 1-5' for weekdays at 9am"),
        timezone: z.string().optional().describe("IANA timezone, e.g. 'America/New_York'"),
        cwd: z.string().optional().describe('Working directory for the agent'),
        context_mode: z.enum(['isolated', 'continuing']).optional().default('isolated'),
        model: z.string().optional().describe("Model override, e.g. 'sonnet' or 'haiku'"),
        max_budget_usd: z.number().optional().describe('Maximum spend per run in USD'),
      },
      async (args) => {
        const job = await schedulerService.createJob(args);
        return {
          content: [
            {
              type: 'text',
              text:
                `Created schedule "${job.name}"\n` +
                `Schedule: ${job.schedule.cronHuman}\n` +
                `Next run: ${job.nextRunAt ?? 'pending'}`,
            },
          ],
        };
      }
    ),

    tool(
      'update_schedule',
      'Update an existing scheduled job',
      {
        id: z.string().describe('Job ID to update'),
        name: z.string().optional(),
        prompt: z.string().optional(),
        cron: z.string().optional(),
        enabled: z.boolean().optional(),
        // ... other updatable fields
      },
      async (args) => {
        const job = await schedulerService.updateJob(args.id, args);
        return { content: [{ type: 'text', text: `Updated schedule "${job.name}"` }] };
      }
    ),

    tool(
      'delete_schedule',
      'Delete a scheduled job',
      { id: z.string().describe('Job ID to delete') },
      async ({ id }) => {
        await schedulerService.deleteJob(id);
        return { content: [{ type: 'text', text: `Deleted schedule ${id}` }] };
      }
    ),

    tool(
      'trigger_schedule',
      'Manually trigger a scheduled job to run immediately',
      { id: z.string().describe('Job ID to trigger') },
      async ({ id }) => {
        const runId = await schedulerService.triggerJob(id);
        return { content: [{ type: 'text', text: `Triggered job ${id}, run ID: ${runId}` }] };
      }
    ),

    tool(
      'list_schedule_runs',
      'View run history for a scheduled job',
      {
        id: z.string().describe('Job ID'),
        limit: z.number().optional().default(10),
      },
      async ({ id, limit }) => {
        const runs = schedulerService.getRunHistory(id, limit);
        return { content: [{ type: 'text', text: JSON.stringify(runs, null, 2) }] };
      }
    ),
  ],
});
```

### When MCP Tools Are Injected

The MCP tools should be available in **every DorkOS session**, not just scheduled runs. This enables the user to say things like:

- "Schedule a daily code review at 9am"
- "What schedules do I have?"
- "Pause the weekly digest"
- "Show me the last 5 runs of my morning brief"

The injection point is in `AgentManager.sendMessage()`:

```typescript
const sdkOptions: Options = {
  ...existingOptions,
  mcpServers: {
    dorkos: schedulerMcpServer, // always available
  },
};
```

### MCP Tools vs File Access: When Each Is Used

| Scenario                                 | Agent Path                                                     | Why                             |
| ---------------------------------------- | -------------------------------------------------------------- | ------------------------------- |
| User says "schedule X" in DorkOS chat    | MCP tool `create_schedule`                                     | Validated, safe, immediate      |
| User says "schedule X" in CLI session    | `Edit ~/.dork/schedules.json`                                  | MCP tools not available in CLI  |
| Scheduled agent wants to see own config  | `Read ~/.dork/schedules.json`                                  | Simple, always available        |
| Scheduled agent wants to see run history | MCP tool `list_schedule_runs` OR `Read ~/.dork/runs/<id>.json` | MCP preferred, file as fallback |
| UI creates a schedule                    | REST API `POST /api/schedules`                                 | Goes through service layer      |
| Human debugging                          | `cat ~/.dork/schedules.json \| jq`                             | File is always readable         |

---

## What to Adopt From Each Project

### From OpenClaw

- Three schedule kinds (one-shot, interval, cron) with timezone support
- Exponential backoff on consecutive failures
- Per-job run history with size-based pruning
- Manual trigger capability
- 60-second timer clamp for sleep/wake recovery
- Session isolation option (isolated vs. continuing session)
- Model override per job (cost optimization)
- Atomic file writes (tmp + rename)

### From NanoClaw

- SQLite for run history (queryable, efficient for append-heavy workload)
- Simple task interface (prompt + schedule + context mode)
- Context mode (isolated vs. group/continuing)
- Full agent capability per scheduled task
- Per-job concurrency prevention

### Improvements Over Both

- **File-based job definitions + SQLite run history** (best of both persistence models)
- **SDK MCP tools** for validated in-process schedule management (neither project uses this)
- **System prompt append** for scheduled run context (neither project does this well)
- **Per-job missed-run policy** (neither project has configurable per-job policy)
- **REST API** for web UI (OpenClaw has RPC, NanoClaw has MCP-only)
- **Hot-reload via file watcher** for external edits (OpenClaw warns against this)
- **Per-job resource limits** (`maxTurns`, `maxBudgetUsd`) preventing runaway agent tasks
- **Zod schemas** for all job definitions (matching DorkOS validation patterns)
- **`cronstrue`** for auto-generated human-readable labels

---

## Specific Libraries

| Library          | Purpose                                         | Why This One                                                    |
| ---------------- | ----------------------------------------------- | --------------------------------------------------------------- |
| `croner` v10     | Cron expression parsing + in-process scheduling | Zero deps, OCPS 1.4, TypeScript-native, used by PM2/Uptime Kuma |
| `better-sqlite3` | Run history persistence                         | Synchronous API, WAL mode, fast single-process access           |
| `cronstrue`      | Cron-to-English conversion                      | Auto-generates `cronHuman` labels                               |
| `chokidar`       | File watcher for schedules.json                 | Already a DorkOS dependency (session-broadcaster uses it)       |

Note: `drizzle-orm` is optional for SQLite schema management. Raw `better-sqlite3` with prepared statements is simpler for the small schema involved.

---

## Management Surfaces

| Surface               | Operations             | Implementation                                              |
| --------------------- | ---------------------- | ----------------------------------------------------------- |
| **REST API**          | CRUD + trigger + runs  | `routes/schedules.ts` — Zod-validated, serves UI            |
| **SDK MCP tools**     | CRUD + trigger + runs  | `createSdkMcpServer()` — injected into every DorkOS session |
| **CLI**               | list, add, remove, run | `dorkos schedule list/add/remove/run` subcommands           |
| **Agent file access** | Read + Edit            | `~/.dork/schedules.json` — works in any session             |
| **Web UI**            | Full management panel  | Future — consumes REST API                                  |

---

## SQLite Schema (Run History Only)

```sql
CREATE TABLE job_runs (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',  -- pending | running | done | failed | skipped
  triggered_by  TEXT NOT NULL DEFAULT 'schedule',  -- schedule | manual | api
  prompt        TEXT,                              -- snapshot of prompt at run time
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  output        TEXT,                              -- summary of agent output
  error         TEXT,
  model         TEXT,
  cost_usd      REAL,
  turns_used    INTEGER,
  session_id    TEXT,                              -- SDK session ID for the run
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE scheduler_state (
  job_id        TEXT PRIMARY KEY,
  last_run_at   TEXT,
  next_run_at   TEXT,
  run_count     INTEGER NOT NULL DEFAULT 0,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_job_runs_job_id ON job_runs(job_id);
CREATE INDEX idx_job_runs_status ON job_runs(status);
CREATE INDEX idx_job_runs_created_at ON job_runs(created_at);
CREATE INDEX idx_scheduler_state_next_run ON scheduler_state(next_run_at);

PRAGMA journal_mode = WAL;
PRAGMA synchronous = 1;
PRAGMA busy_timeout = 5000;
```

Job definitions are NOT in SQLite — they live in `schedules.json`.

---

## Open Questions for Specification

1. **Should MCP tools be injected into every session or only when the scheduler is enabled?** (Recommendation: always, so users can manage schedules conversationally)

2. **Should agents in scheduled runs have `bypassPermissions` or require approval?** (Recommendation: configurable per job, default to `acceptEdits`)

3. **How should scheduled job output be delivered?** Options: write to a file, store in SQLite, push to session broadcaster, webhook, or silent. (Recommendation: all configurable per job)

4. **Should we support `continuing` context mode from day one?** It requires maintaining a persistent session ID per job across runs. (Recommendation: start with `isolated` only, add `continuing` later)

5. **Where does `~/.dork/schedules.json` live in the Obsidian plugin context?** The plugin uses a different vault root. (Recommendation: resolve via `ConfigManager` path)
