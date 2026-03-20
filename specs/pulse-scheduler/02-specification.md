# Specification: DorkOS Pulse (Scheduler)

**Status:** Draft
**Authors:** Claude Code / Dorian Collier — 2026-02-18
**Spec Number:** 43
**Ideation:** `specs/pulse-scheduler/01-ideation.md`

---

## 1. Overview

DorkOS Pulse is the autonomous heartbeat system for DorkOS. It runs Claude Agent SDK prompts on cron schedules, each in a specified working directory, with full observability via a web UI. Pulse transforms DorkOS from a reactive chat interface into a proactive agent operating system.

Jobs are defined in `~/.dork/schedules.json` (human-readable, agent-editable). Run history is tracked in `~/.dork/pulse.db` (SQLite). Each run produces an SDK JSONL transcript, and the existing chat UI serves as the log viewer — no custom log viewer is needed.

## 2. Background / Problem Statement

DorkOS currently only responds to user-initiated messages. There is no way to schedule autonomous work — code reviews, dependency checks, report generation, or any recurring task. Users must manually trigger every interaction.

The brand foundation (spec 4.3) defines Pulse as the feature that makes DorkOS "alive" — an autonomous execution loop that can run per-project or system-wide. The Dynamic MCP Tool Injection architecture (spec #41, implemented) provides the foundation for agents to manage their own schedules via MCP tools.

## 3. Goals

- **Zero-config start**: Pulse is disabled by default; one toggle to enable
- **Conversation-first creation**: "Run this every day at 9am" leads to Claude creating the schedule via MCP tools
- **Full observability**: Every run logged with status, duration, output summary, and session linkage
- **Graceful lifecycle**: Jobs can be paused, resumed, cancelled; runs can be aborted mid-flight
- **Survive restarts**: Job definitions and run history persist across server restarts
- **Self-aware agents**: Running jobs know they are Pulse jobs and can manage their own schedules

## 4. Non-Goals

- **Distributed job queue**: Single-node, single-process only
- **CI/CD replacement**: No build pipelines, artifact management, or deployment
- **Task DAG**: No dependency chains between jobs (Job A triggers Job B)
- **Custom log viewer**: SDK transcripts rendered via existing chat UI
- **External notifications**: No email/SMS/webhook for MVP (deferred to Channels feature)
- **Per-project schedule files**: Schedules are global (`~/.dork/schedules.json`) only
- **Automatic retries**: Default 0 retries; manual re-run preferred for AI agent jobs
- **Domain restructuring**: Service count is at 20 (threshold), but restructuring is a separate effort

## 5. Technical Dependencies

| Dependency              | Version | Purpose                                                           |
| ----------------------- | ------- | ----------------------------------------------------------------- |
| `croner`                | ^9.x    | Cron scheduling with overrun protection, `isBusy()`, `nextRuns()` |
| `better-sqlite3`        | ^11.x   | Synchronous SQLite for run history persistence                    |
| `@types/better-sqlite3` | ^7.x    | Type definitions                                                  |
| `cronstrue`             | ^2.x    | Human-readable cron expression translation (client-side)          |

Existing dependencies used:

- `@anthropic-ai/claude-agent-sdk` — Agent execution via `query()`
- `zod` — Schema validation for all endpoints and MCP tools
- `conf` — Config management (existing `config-manager.ts`)
- `uuid` — ID generation

## 6. Detailed Design

### 6.1 Data Model

#### Schedule Definition (`~/.dork/schedules.json`)

```typescript
interface PulseSchedule {
  id: string; // UUID v4
  name: string; // Human-readable label
  prompt: string; // Agent instructions
  cron: string; // 5-field cron expression
  timezone: string; // IANA timezone (default: system)
  cwd: string; // Working directory for the job
  enabled: boolean; // Pause/resume toggle
  maxRuntime: number; // Timeout in ms (default: 600000 = 10min)
  permissionMode: 'acceptEdits' | 'bypassPermissions'; // Default: acceptEdits
  status: 'active' | 'paused' | 'pending_approval'; // Lifecycle state
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}
```

The file is a JSON array of `PulseSchedule` objects. Writes use atomic rename (write to `.tmp`, `rename`) to prevent corruption.

**Status semantics:**

- `active` — Schedule is enabled and will fire at cron times
- `paused` — Schedule exists but is skipped during poll
- `pending_approval` — Created by an agent via MCP; requires user approval to activate

#### Run Record (`~/.dork/pulse.db`)

```sql
CREATE TABLE IF NOT EXISTS runs (
  id            TEXT PRIMARY KEY,
  schedule_id   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'running',
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  output_summary TEXT,
  error         TEXT,
  session_id    TEXT,
  trigger       TEXT NOT NULL DEFAULT 'scheduled',
  created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_schedule_id ON runs(schedule_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
```

**Status values:** `running` | `completed` | `failed` | `cancelled`
**Trigger values:** `scheduled` | `manual`

The `session_id` column links to the SDK JSONL transcript at `~/.claude/projects/{slug}/{sessionId}.jsonl`, enabling the existing chat UI to render the full run conversation.

#### SQLite Configuration

```typescript
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
```

Schema migrations via `PRAGMA user_version`:

```typescript
const MIGRATIONS: string[] = [
  // v1: Initial schema
  `CREATE TABLE IF NOT EXISTS runs (...); CREATE INDEX IF NOT EXISTS ...;`,
];

function migrate(db: Database): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
  }
  db.pragma(`user_version = ${MIGRATIONS.length}`);
}
```

### 6.2 Architecture

```
DorkOS Server
+------------------------------------------------------------------+
|                                                                    |
|  SchedulerService -------> AgentManager                           |
|  (croner jobs)              (SDK query())                         |
|  (activeRuns Map)           (MCP tools included)                  |
|       |                                                            |
|  PulseStore                 MCP Tool Server                       |
|  (SQLite + JSON)            (+5 pulse tools)                      |
|                                                                    |
|  routes/pulse.ts            config-manager                        |
|  /api/pulse/*               scheduler config                     |
+------------------------------------------------------------------+

DorkOS Client
+------------------------------------------------------------------+
|  entities/pulse/            features/pulse/                       |
|  - use-schedules.ts         - PulsePanel.tsx                      |
|  - use-runs.ts              - CreateScheduleDialog.tsx            |
|                             - RunHistoryPanel.tsx                  |
+------------------------------------------------------------------+
```

### 6.3 Server Components

#### PulseStore (`apps/server/src/services/pulse-store.ts`)

Manages both the SQLite database and the JSON schedule file.

**Public API:**

```typescript
export class PulseStore {
  constructor(dorkHome: string);

  // Schedule CRUD (JSON file)
  getSchedules(): PulseSchedule[];
  getSchedule(id: string): PulseSchedule | undefined;
  createSchedule(input: CreateScheduleInput): PulseSchedule;
  updateSchedule(id: string, input: UpdateScheduleInput): PulseSchedule;
  deleteSchedule(id: string): void;

  // Run CRUD (SQLite)
  createRun(scheduleId: string, trigger: 'scheduled' | 'manual'): PulseRun;
  updateRun(id: string, update: Partial<PulseRun>): void;
  getRun(id: string): PulseRun | undefined;
  listRuns(opts?: { scheduleId?: string; limit?: number; offset?: number }): PulseRun[];
  getRunningRuns(): PulseRun[];
  countRuns(scheduleId?: string): number;

  // Maintenance
  pruneRuns(retentionCount: number): number;
  close(): void;
}
```

**Concurrency safety:** All schedule writes go through `PulseStore` which uses atomic file rename. SQLite handles concurrent read/write via WAL mode. The store is a singleton.

#### SchedulerService (`apps/server/src/services/scheduler-service.ts`)

Orchestrates the cron lifecycle and job dispatch.

**Public API:**

```typescript
export class SchedulerService {
  constructor(store: PulseStore, agentManager: AgentManager, config: SchedulerConfig);

  start(): void;
  stop(): Promise<void>;

  registerSchedule(schedule: PulseSchedule): void;
  unregisterSchedule(id: string): void;
  triggerManualRun(scheduleId: string): Promise<string>;

  cancelRun(runId: string): void;
  getActiveRunCount(): number;
}
```

**Startup sequence:**

1. Load schedules from `PulseStore`
2. Mark any `running` status runs as `failed` (interrupted by restart)
3. Register enabled + active schedules with croner (`protect: true`)
4. Start accepting dispatches

**Job dispatch flow:**

1. Croner fires callback for a schedule
2. Check global concurrency: if `activeRuns.size >= maxConcurrentRuns`, skip with warning log
3. Create run record in `PulseStore` with status `running`
4. Create `AbortController`; combine with `AbortSignal.timeout(maxRuntime)` via `AbortSignal.any()`
5. Store controller in `activeRuns` map keyed by run ID
6. Call `agentManager.sendMessage()` with schedule prompt, CWD, and permission mode
7. Consume the async generator, capturing first ~500 chars of text output as `output_summary`
8. On completion: update run status to `completed`, calculate duration
9. On error: update run status to `failed` with error message
10. On abort: update run status to `cancelled`
11. Always: remove from `activeRuns` map in `finally` block

**System prompt injection:**

```typescript
function buildPulseAppend(schedule: PulseSchedule, run: PulseRun): string {
  return [
    '---',
    '## PULSE SCHEDULER CONTEXT',
    '',
    'You are running as a scheduled agent in DorkOS Pulse.',
    '',
    `- Job: "${schedule.name}"`,
    `- Schedule: ${schedule.cron} (${schedule.timezone})`,
    `- Working Directory: ${schedule.cwd}`,
    `- Run ID: ${run.id}`,
    `- Trigger: ${run.trigger}`,
    '',
    'You are running UNATTENDED. Do not wait for user input.',
    'Make conservative decisions. Report findings clearly.',
    'You have access to schedule management tools (mcp__dorkos__*).',
    '---',
  ].join('\n');
}
```

Passed via `{ type: 'preset', preset: 'claude_code', append }` with `settingSources: ['project', 'user']`.

**Graceful shutdown:**

1. Stop all croner jobs (prevents new dispatches)
2. For each active run: call `abort()` on its controller
3. Wait up to 30 seconds for active runs to complete/abort
4. Call `pulseStore.close()` to flush and close SQLite

#### MCP Tools (extend `mcp-tool-server.ts`)

Five new tools added to the existing `createDorkOsToolServer()`:

| Tool              | Input Schema                                                                       | Returns                                       |
| ----------------- | ---------------------------------------------------------------------------------- | --------------------------------------------- |
| `list_schedules`  | `{ enabled_only?: boolean }`                                                       | Array of schedule objects                     |
| `create_schedule` | `{ name, prompt, cron, cwd?, timezone?, maxRuntime?, permissionMode? }`            | Created schedule (status: `pending_approval`) |
| `update_schedule` | `{ id, name?, prompt?, cron?, enabled?, timezone?, maxRuntime?, permissionMode? }` | Updated schedule                              |
| `delete_schedule` | `{ id }`                                                                           | Confirmation message                          |
| `get_run_history` | `{ schedule_id, limit? }`                                                          | Array of recent runs                          |

**Agent approval flow:** `create_schedule` always creates with `status: 'pending_approval'`. The schedule appears in the Pulse UI with a yellow indicator. User must approve (PATCH with `status: 'active'`) before croner registers it.

The `McpToolDeps` interface is extended:

```typescript
export interface McpToolDeps {
  transcriptReader: TranscriptReader;
  defaultCwd: string;
  pulseStore?: PulseStore; // Optional, only present when Pulse is enabled
}
```

Tools check `deps.pulseStore` and return a clear error if Pulse is disabled.

#### REST Routes (`apps/server/src/routes/pulse.ts`)

| Method   | Path                               | Description          | Request Body                   | Response                                    |
| -------- | ---------------------------------- | -------------------- | ------------------------------ | ------------------------------------------- |
| `GET`    | `/api/pulse/schedules`             | List all schedules   | —                              | `PulseSchedule[]` (with computed `nextRun`) |
| `POST`   | `/api/pulse/schedules`             | Create a schedule    | `CreateScheduleRequest`        | `PulseSchedule`                             |
| `PATCH`  | `/api/pulse/schedules/:id`         | Update a schedule    | `UpdateScheduleRequest`        | `PulseSchedule`                             |
| `DELETE` | `/api/pulse/schedules/:id`         | Delete a schedule    | —                              | `{ ok: true }`                              |
| `POST`   | `/api/pulse/schedules/:id/trigger` | Manual run trigger   | —                              | `{ runId: string }`                         |
| `GET`    | `/api/pulse/runs`                  | List runs            | `?schedule_id=&limit=&offset=` | `{ runs: PulseRun[], total: number }`       |
| `GET`    | `/api/pulse/runs/:id`              | Get a specific run   | —                              | `PulseRun`                                  |
| `POST`   | `/api/pulse/runs/:id/cancel`       | Cancel a running job | —                              | `{ ok: true }`                              |

All routes follow existing patterns: Zod validation, delegate to service, return consistent error responses. `GET /api/pulse/schedules` computes `nextRun` for each schedule using croner `nextRun()`.

### 6.4 Shared Schemas

**`packages/shared/src/config-schema.ts`** — New `scheduler` section:

```typescript
scheduler: z.object({
  enabled: z.boolean().default(false),
  maxConcurrentRuns: z.number().int().min(1).max(10).default(1),
  timezone: z.string().nullable().default(null),
  retentionCount: z.number().int().min(1).default(100),
}).default(() => ({
  enabled: false,
  maxConcurrentRuns: 1,
  timezone: null,
  retentionCount: 100,
}));
```

**`packages/shared/src/schemas.ts`** — New Pulse schemas:

- `PulseScheduleSchema` — Full schedule object with OpenAPI metadata
- `PulseRunSchema` — Run record with status enum
- `CreateScheduleRequestSchema` — POST body validation
- `UpdateScheduleRequestSchema` — PATCH body validation
- `ListRunsQuerySchema` — Query param validation (schedule_id, limit, offset)

### 6.5 Client UI

#### FSD Structure

```
apps/client/src/layers/
  entities/
    pulse/
      index.ts                    # Barrel: useSchedules, useRuns
      model/
        use-schedules.ts          # TanStack Query: CRUD for schedules
        use-runs.ts               # TanStack Query: run history
  features/
    pulse/
      index.ts                    # Barrel: PulsePanel, CreateScheduleDialog
      ui/
        PulsePanel.tsx            # Schedule list + run status overview
        CreateScheduleDialog.tsx  # Create/edit schedule form
        RunHistoryPanel.tsx       # Per-schedule run history table
```

#### PulsePanel

- Accessible via sidebar section or settings tab
- Lists all schedules: name, human-readable cron (via `cronstrue`), next run time, enabled toggle
- Status indicators: green dot (active), gray (paused), red (last run failed), yellow (pending_approval)
- "Run Now" button per schedule
- "New Schedule" button opens `CreateScheduleDialog`
- Click a schedule row expands `RunHistoryPanel` inline

#### CreateScheduleDialog

- **Name**: Text input
- **Prompt**: Multiline textarea
- **Cron expression**: Text input with live human-readable translation (via `cronstrue`)
- **Next 5 runs preview**: Computed from API response `nextRun` field
- **Working directory**: Reuse existing directory picker component
- **Timezone**: Select dropdown (IANA timezone list), default to system
- **Permission mode**: Radio — "Allow file edits" (`acceptEdits`) or "Full autonomy" (`bypassPermissions`) with warning
- **Max runtime**: Number input in minutes, default 10

#### RunHistoryPanel

- Table: status icon, trigger type, start time, duration, output preview
- Click a run navigates to `/chat?session={session_id}` for the full transcript
- "Cancel" button on running jobs
- Pagination for long histories

#### Approval UI

Schedules with `status: 'pending_approval'` show a yellow banner with "Approve" and "Reject" buttons. Approve sets `status: 'active'`; reject deletes the schedule.

### 6.6 Transport Interface Extension

Add Pulse methods to `packages/shared/src/transport.ts`:

```typescript
listSchedules(): Promise<PulseSchedule[]>;
createSchedule(input: CreateScheduleInput): Promise<PulseSchedule>;
updateSchedule(id: string, input: UpdateScheduleInput): Promise<PulseSchedule>;
deleteSchedule(id: string): Promise<{ ok: boolean }>;
triggerSchedule(id: string): Promise<{ runId: string }>;
listRuns(opts?: { scheduleId?: string; limit?: number; offset?: number }): Promise<{ runs: PulseRun[]; total: number }>;
getRun(id: string): Promise<PulseRun>;
cancelRun(id: string): Promise<{ ok: boolean }>;
```

Both `HttpTransport` and `DirectTransport` implement these methods.

### 6.7 Configuration and CLI

**Config section** in `~/.dork/config.json`:

```json
{
  "scheduler": {
    "enabled": false,
    "maxConcurrentRuns": 1,
    "timezone": null,
    "retentionCount": 100
  }
}
```

**CLI flags** (`packages/cli`):

- `--pulse` / `--no-pulse`: Enable/disable scheduler at startup
- Sets `DORKOS_PULSE_ENABLED` env var before importing server

**Precedence:** CLI flag > `DORKOS_PULSE_ENABLED` env var > `config.scheduler.enabled` > default (`false`)

### 6.8 Server Wiring (`index.ts`)

```typescript
// Conditional initialization based on config
const pulseEnabled =
  process.env.DORKOS_PULSE_ENABLED === 'true' || configManager.get('scheduler')?.enabled;

const pulseStore = pulseEnabled ? new PulseStore(dorkHome) : undefined;

const schedulerService = pulseStore
  ? new SchedulerService(pulseStore, agentManager, {
      maxConcurrentRuns: configManager.get('scheduler')?.maxConcurrentRuns ?? 1,
      timezone: configManager.get('scheduler')?.timezone ?? undefined,
      retentionCount: configManager.get('scheduler')?.retentionCount ?? 100,
    })
  : undefined;

// Pass to MCP tool server (pulseStore may be undefined)
const mcpToolServer = createDorkOsToolServer({
  transcriptReader,
  defaultCwd,
  pulseStore,
});

// Start scheduler after server binds
if (schedulerService) schedulerService.start();

// Graceful shutdown
async function shutdown() {
  if (schedulerService) await schedulerService.stop();
  // ... existing shutdown
}
```

## 7. User Experience

### Creating a Schedule via Conversation

User says "Run a code review of this project every weekday at 9am". Claude calls `mcp__dorkos__create_schedule` with the appropriate parameters. The schedule is created as `pending_approval`. Claude informs the user it needs approval in the Pulse panel.

### Creating a Schedule via UI

1. Click "Pulse" in sidebar
2. Click "New Schedule"
3. Fill in form (name, prompt, cron, CWD, permissions)
4. See live human-readable cron translation and next 5 run times
5. Click "Create" — schedule appears as active

### Viewing Run History

1. Click a schedule in PulsePanel
2. RunHistoryPanel expands showing recent runs
3. Click any run to navigate to the full agent transcript in the chat UI

### Approving Agent-Created Schedules

1. Agent creates schedule via MCP — yellow "Pending Approval" badge appears
2. User reviews details and clicks "Approve" or "Reject"

## 8. Testing Strategy

### Server Unit Tests

**`pulse-store.test.ts`:**

- Schedule CRUD operations on JSON file (create, read, update, delete)
- Run CRUD operations in SQLite (create, update, query, count)
- Atomic write prevents corruption on concurrent access
- Run retention pruning keeps only last N per schedule
- Schema migration runs idempotently
- Handles missing/corrupt files gracefully on startup

**`scheduler-service.test.ts`:**

- Registers croner jobs for enabled+active schedules on start
- Dispatches job when croner callback fires (mock croner)
- Respects global concurrency cap (skips when at limit)
- Skips overlapping runs (job still running when next tick fires)
- Timeout via AbortController sets run status to `cancelled`
- Agent error sets run status to `failed` with error message
- Marks interrupted runs as `failed` on startup
- Graceful shutdown waits for active runs (up to 30s)
- Manual trigger creates run with `trigger: 'manual'`
- `cancelRun` aborts the correct controller

**`mcp-tool-server.test.ts` (extend existing):**

- `create_schedule` creates with `pending_approval` status
- `list_schedules` with `enabled_only` filter
- `update_schedule` validates schedule exists, returns 404 if not
- `delete_schedule` removes schedule
- `get_run_history` returns runs in reverse chronological order
- All tools return error when `pulseStore` is undefined

**`pulse.test.ts` (routes):**

- CRUD endpoints return correct status codes and shapes
- Zod validation rejects invalid cron expressions and missing fields
- Trigger endpoint creates a manual run and returns run ID
- Cancel endpoint aborts a running job
- 404 for nonexistent schedule/run IDs
- Pagination works correctly for run listing

### Client Tests

**`use-schedules.test.ts`:**

- Fetches and caches schedule list
- Invalidates cache after mutations

**`PulsePanel.test.tsx`:**

- Renders schedule list with correct status indicators
- Enabled toggle calls update endpoint
- "Run Now" calls trigger endpoint
- Empty state shown when no schedules

**`CreateScheduleDialog.test.tsx`:**

- Required field validation
- Permission mode warning for bypassPermissions
- Submit calls create with correct payload

### Mocking Strategy

- **SQLite**: In-memory database (`:memory:`) for PulseStore tests
- **Croner**: Mock `Cron` class to control callback firing
- **AgentManager**: Mock `sendMessage()` to yield test StreamEvents
- **Transport**: `createMockTransport()` from `@dorkos/test-utils`
- **File system**: Mock `fs.writeFileSync`/`fs.readFileSync` for schedules.json

## 9. Performance Considerations

- **SQLite**: At dozens of jobs and hundreds of runs/day, WAL-mode SQLite is trivial
- **Croner**: In-memory only; re-registers all jobs on restart (< 10ms for hundreds)
- **Pagination**: Run list endpoints default to 50 per page with LIMIT/OFFSET
- **Prepared statements**: PulseStore pre-compiles all hot queries at init
- **Concurrency cap**: Default 1 concurrent agent prevents resource exhaustion
- **JSON file**: At 100 schedules (~50KB), atomic read/write is instant

## 10. Security Considerations

- **Directory boundary**: Apply `lib/boundary.ts` validation to schedule `cwd` field
- **Permission mode**: `acceptEdits` default; `bypassPermissions` requires explicit opt-in with UI warning
- **MCP approval gate**: Agent-created schedules start as `pending_approval`
- **Prompt injection defense**: Sanitize `schedule.name` and `schedule.prompt` before system prompt injection
- **Tunnel auth inheritance**: All `/api/pulse/*` routes protected by tunnel auth if configured
- **Run confidentiality**: SDK transcripts gated by same auth as session viewing

## 11. Documentation Updates

- **`CLAUDE.md`**: Update service count, add PulseStore and SchedulerService entries, add pulse route group, update CLI flags
- **`contributing/api-reference.md`**: Document `/api/pulse/*` endpoints
- **`contributing/configuration.md`**: Document `scheduler` config section and `--pulse` flag
- **`docs/`**: Add user-facing "Scheduled Jobs" guide
- **OpenAPI**: Register Pulse schemas in `openapi-registry.ts`

## 12. Implementation Phases

### Phase 1: Core Engine

- Install `better-sqlite3` and `croner` dependencies
- Add `scheduler` section to `UserConfigSchema`
- Add `PulseScheduleSchema`, `PulseRunSchema`, and request/response schemas
- Implement `PulseStore` (SQLite + JSON file management)
- Implement `SchedulerService` (croner, dispatch, lifecycle)
- Unit tests for PulseStore and SchedulerService

### Phase 2: Interfaces

- Add 5 MCP tools to `mcp-tool-server.ts`
- Extend `McpToolDeps` with optional `pulseStore`
- Create `routes/pulse.ts` with all 8 endpoints
- Mount routes in `app.ts`
- Wire PulseStore + SchedulerService in `index.ts`
- Graceful shutdown integration
- Tests for MCP tools and routes

### Phase 3: Client UI

- Add Transport interface methods for Pulse
- Implement `HttpTransport` pulse methods
- Create `entities/pulse/` hooks
- Create `features/pulse/` components
- Approval UI for `pending_approval` schedules
- Session linkage navigation
- Client component tests

### Phase 4: Polish

- `--pulse`/`--no-pulse` CLI flags
- System prompt injection (`buildPulseAppend`)
- `settingSources: ['project', 'user']` for CLAUDE.md loading
- Run retention pruning on startup
- `cronstrue` for human-readable cron display
- Update CLAUDE.md and contributing docs

## 13. Open Questions

1. **Croner `protect` behavior on restart**
   - When the server restarts, croner loses all state. Runs interrupted mid-execution are marked `failed` on startup. Should the scheduler offer a "re-run failed" bulk action?
   - Recommendation: Not for MVP. Manual re-run per job is sufficient.

2. **WAL checkpoint management**
   - Research recommends monitoring `.db-wal` file size and forcing checkpoint at 10MB. Should this be built into PulseStore?
   - Recommendation: Defer. Expected write volume (< 100 runs/day) makes WAL growth manageable.

3. **Obsidian plugin support**
   - Should scheduled jobs work inside Obsidian, or only in standalone mode?
   - Recommendation: `DirectTransport` stubs return "Pulse not available in Obsidian" errors. Full support deferred.

## 14. Related ADRs

- **ADR-0003: SDK JSONL as Single Source of Truth** — Pulse reuses SDK transcripts as run logs
- **ADR-0001: Hexagonal Architecture** — Pulse follows the Transport interface pattern

Consider creating:

- **ADR: SQLite for Local Persistence** — Rationale for `better-sqlite3` + `user_version` migrations
- **ADR: Agent Approval Gate for MCP Mutations** — Pattern for `pending_approval` on agent-created resources

## 15. References

- `specs/pulse-scheduler/01-ideation.md` — Ideation document with resolved decisions
- `research/pulse-scheduler-design.md` — Deep research (SQLite, cron UX, lifecycle, system prompt)
- `research/scheduler-comparison.md` — 8+ scheduling approaches compared
- `research/nanoclaw-scheduler-analysis.md` — Production SQLite scheduler reference
- `research/claude-code-sdk-agent-capabilities.md` — SDK Options reference
- `research/mcp-tool-injection-patterns.md` — MCP tool architecture patterns
- `meta/brand-foundation.md` — DorkOS Pulse brand positioning (spec 4.3)
- `specs/dynamic-mcp-tools/02-specification.md` — MCP tool injection (spec #41)
