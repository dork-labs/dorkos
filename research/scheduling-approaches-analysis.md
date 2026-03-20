---
title: 'Job Scheduler Approaches for Node.js/TypeScript Desktop Applications'
date: 2026-02-17
type: internal-architecture
status: archived
tags: [scheduler, nodejs, croner, sqlite, desktop, cron]
feature_slug: pulse-scheduler
---

# Job Scheduler Approaches for Node.js/TypeScript Desktop Applications

**Research Date**: 2026-02-17
**Scope**: Scheduling AI agent tasks at regular intervals in a desktop/CLI application (not cloud)
**Context**: DorkOS — Electron-compatible, macOS + Windows, TypeScript monorepo

---

## Research Summary

Six major scheduling paradigms exist for Node.js desktop applications. For a local desktop app running AI agent tasks, the most viable options are: **(1) in-process cron libraries** (croner or toad-scheduler) combined with **(2) a SQLite persistence layer** for job survival across restarts. Agenda/Bull/BullMQ are disqualified by their Redis/MongoDB dependencies. OS-level cron is macOS-only and breaks cross-platform requirements. Temporal is massively over-engineered. A hybrid approach — croner for runtime scheduling + SQLite for persistence + a JSON/YAML config layer for LLM-readability — hits the sweet spot for this use case.

---

## Key Findings

### 1. In-Process Cron Libraries Are the Right Core Primitive

Libraries like `croner`, `toad-scheduler`, and `node-schedule` run entirely inside the Node.js process with zero external dependencies. They handle cron expressions, intervals, and one-off dates natively. Their main limitation is no built-in persistence — jobs must be re-registered from a durable store on startup.

### 2. SQLite Is the Ideal Persistence Layer for Desktop

SQLite via `better-sqlite3` provides durable job storage (schedules, last run times, next run times) without a server process. It is file-based, zero-config, fast for single-process access, and trivially readable by LLMs and humans as a flat file. The combination of a cron library + SQLite is the standard pattern for desktop-class job schedulers.

### 3. Job Queue Libraries (Agenda, Bull, BullMQ) Are Over-Engineered for Desktop

Agenda requires MongoDB; Bull/BullMQ require Redis. Both are server processes inappropriate for a local desktop or CLI application. These tools are excellent in distributed cloud scenarios but add unnecessary infrastructure for a single-user tool.

### 4. OS-Level Schedulers Are Fragile and Non-Portable

`node-crontab` wraps macOS/Linux crontab and works well on Unix but has **no Windows support**. Windows Task Scheduler has a completely different API. Programmatic OS cron management is cross-platform only with significant platform-detection boilerplate, and jobs live outside the app's control (no audit trail, hard to update via UI).

### 5. The Sleep/Wake Problem Requires Explicit Handling

All in-process schedulers use JavaScript timers under the hood. When a macOS/Windows machine sleeps, timers freeze. On wake, either: (a) the timer fires immediately (catch-up), or (b) the scheduler recalculates the next fire time and skips the missed run. Neither behavior is correct for AI agent tasks without explicit policy. Solutions: `wake-event` npm package + SQLite last-run timestamps allow detecting and deciding on missed-run policy per job.

### 6. Croner Is the Top Cron Library for This Use Case

Croner has zero dependencies, full TypeScript support, browser + Node + Deno + Bun compatibility, is used in production by PM2 / ZWave JS / Uptime Kuma, supports the widest cron syntax (OCPS 1.4 including W modifier, L modifier, year field, `previousRuns()`), and has `pause()`/`resume()`/`trigger()` runtime controls. It is actively maintained with a v10 major release in 2025.

### 7. Human-Readable + LLM-Friendly Scheduling Format

Cron expressions are compact but cryptic. The best approach for LLM interaction is storing a **dual-format** representation: a human-readable label (e.g., `"Every weekday at 9am"`) alongside the cron string (`"0 9 * * 1-5"`). The `cronstrue` library converts any cron string to English. `croner`'s `nextRun()`/`nextRuns(n)` and `previousRuns()` make it easy to preview what a schedule will do, enabling UI confirmation flows.

---

## Detailed Analysis

### Approach 1: In-Process Cron Libraries

These libraries run inside your Node.js process as JavaScript timers. No daemons, no external services. The scheduler lives and dies with the process.

#### croner

**Repository**: [Hexagon/croner](https://github.com/Hexagon/croner)
**Weekly downloads**: ~800k (fast-growing)
**Dependencies**: 0
**TypeScript**: Native (written in TS)

```typescript
import { Cron } from 'croner';

// Recurring cron job
const job = new Cron('0 9 * * 1-5', { timezone: 'America/New_York' }, () => {
  runAgentTask();
});

// One-off at a specific date
const oneOff = new Cron(new Date('2026-03-01T10:00:00'), {}, () => {
  runOnce();
});

// Runtime controls
job.pause();
job.resume();
job.trigger(); // immediate manual fire
job.stop(); // stop and clean up

// Preview schedule
job.nextRuns(5); // next 5 fire dates
job.previousRuns(3); // last 3 fire dates (v10+)
```

**Scheduling formats**:

- Standard 5-field cron: `"0 9 * * *"`
- 6-field with seconds: `"30 0 9 * * *"` (enable with `hasSeconds: true`)
- 7-field with year: `"0 9 * * * * 2027"`
- W modifier (nearest weekday): `"0 12 15W * *"`
- L modifier (last day of month): `"0 12 L * *"`
- AND logic modifier: `"0 12 15 * +FRI"` (15th AND Friday only)
- Date object (one-off)

**Pros**:

- Zero deps, tiny bundle
- Most complete cron syntax of any library
- `match()` method to check if a date matches a pattern
- Full OCPS 1.4 compliance (v10+)
- Battle-tested in production (PM2, Uptime Kuma)
- Works in browser environments too (useful for Electron renderer)

**Cons**:

- No persistence (by design)
- No built-in job queue or concurrency management
- Must re-register jobs from persistent store on restart

#### toad-scheduler

**Repository**: [kibertoad/toad-scheduler](https://github.com/kibertoad/toad-scheduler)
**Weekly downloads**: ~61k
**Dependencies**: `croner` (for cron syntax)

```typescript
import { ToadScheduler, SimpleIntervalJob, CronJob, Task } from 'toad-scheduler';

const scheduler = new ToadScheduler();

// Interval-based job
const task = new Task('agent-heartbeat', () => {
  runTask();
});
const job = new SimpleIntervalJob({ minutes: 30 }, task);
scheduler.addSimpleIntervalJob(job);

// Cron-based job
const cronTask = new Task('daily-report', () => {
  runReport();
});
const cronJob = new CronJob({ cronExpression: '0 9 * * *' }, cronTask);
scheduler.addCronJob(cronJob);

// Start/stop individual jobs
scheduler.stopById('agent-heartbeat');
scheduler.startById('agent-heartbeat');
```

**Scheduling formats**:

- `SimpleIntervalJob`: `{ seconds, minutes, hours }` object
- `CronJob`: standard cron string (delegated to croner)
- No one-off date support natively

**Pros**:

- Clean TypeScript-first API
- Simple interval DSL (no cron required for basic intervals)
- Cluster-friendly (can configure to only run on one worker)
- Good for background processing tasks

**Cons**:

- No persistence
- Narrower feature set than using croner directly
- Delegates cron parsing to croner anyway
- Smaller community

#### node-schedule

**Repository**: [node-schedule/node-schedule](https://github.com/node-schedule/node-schedule)
**Weekly downloads**: ~1.5M

```typescript
import schedule from 'node-schedule';

// Cron string
const job = schedule.scheduleJob('0 9 * * 1-5', () => {
  run();
});

// Recurrence rule (object literal)
const rule = new schedule.RecurrenceRule();
rule.dayOfWeek = [1, 2, 3, 4, 5]; // Mon-Fri
rule.hour = 9;
rule.minute = 0;
schedule.scheduleJob(rule, () => {
  run();
});

// One-off date
schedule.scheduleJob(new Date('2026-03-15'), () => {
  runOnce();
});

// Cancel
job.cancel();
```

**Pros**:

- Long-standing library (very stable)
- Object literal scheduling (readable in code)
- One-off date support
- Timezone-aware

**Cons**:

- No persistence
- Incomplete cron syntax (missing W and L modifiers)
- Known sleep/wake drift issues on Windows (GitHub issue #278)
- Single timer architecture means only one job queued at a time

#### node-cron

**Repository**: [node-cron/node-cron](https://github.com/node-cron/node-cron)
**Weekly downloads**: ~1.7M

```typescript
import cron from 'node-cron';

const task = cron.schedule(
  '*/5 * * * *',
  () => {
    runEvery5Minutes();
  },
  { scheduled: true, timezone: 'America/New_York' }
);

task.stop();
task.start();
```

**Pros**: Simple API, very popular, good docs
**Cons**: No persistence, no job querying, no priority, less cron syntax coverage than croner

---

### Approach 2: Job Queue Libraries (Agenda / Bree / Bull)

#### Agenda

**Repository**: [agenda/agenda](https://github.com/agenda/agenda)
**Weekly downloads**: ~96k
**Backing store**: **MongoDB (required)**

```typescript
import Agenda from 'agenda';
const agenda = new Agenda({ db: { address: 'mongodb://...' } });

agenda.define('send-report', async (job) => {
  await sendReport(job.attrs.data);
});

await agenda.every('5 minutes', 'send-report');
await agenda.schedule('in 20 minutes', 'send-report', { userId: '123' });
await agenda.now('send-report');
await agenda.start();
```

**Scheduling formats**:

- Human-readable: `"every 5 minutes"`, `"in 20 minutes"`, `"at noon on tuesday"`
- Cron strings: `"0 9 * * *"`
- Date objects

**Pros**:

- Human-readable scheduling syntax (great for LLMs)
- Job persistence via MongoDB
- Agendash UI dashboard available
- Supports job priorities and concurrency limits
- `agenda-rest` package adds a REST API layer

**Cons**:

- **Requires MongoDB** — a running server process, unacceptable for desktop/CLI
- Heavyweight for single-user tools
- MongoDB adds ~100-200MB RAM overhead

#### BullMQ / Bull

**Repository**: [taskforcesh/bullmq](https://github.com/taskforcesh/bullmq)
**Weekly downloads**: ~500k
**Backing store**: **Redis (required)**

```typescript
import { Queue, Worker } from 'bullmq';

const queue = new Queue('agent-tasks', { connection: { host: 'localhost' } });
const worker = new Worker('agent-tasks', async (job) => {
  await runAgentTask(job.data);
});

// Repeatable (cron-based)
await queue.add(
  'daily-task',
  { userId: '123' },
  {
    repeat: { cron: '0 9 * * *' },
  }
);

// Delayed one-off
await queue.add('remind', {}, { delay: 60 * 60 * 1000 }); // in 1 hour
```

**Pros**:

- Industry-standard for distributed job queues
- Bull Board / Arena dashboard UIs
- Priorities, retries, rate limiting, concurrency
- Job event hooks (completed, failed, progress)

**Cons**:

- **Requires Redis** — a running server process, unacceptable for desktop/CLI
- Overkill for single-user applications
- Redis adds significant memory overhead and setup complexity

#### Bree

**Repository**: [breejs/bree](https://github.com/breejs/bree)
**Weekly downloads**: ~30k
**Backing store**: None required (optional)
**Node minimum**: v12.17.0+

```typescript
import Bree from 'bree';

const bree = new Bree({
  root: path.join(__dirname, 'jobs'),
  jobs: [
    {
      name: 'agent-task',
      interval: 'every 30 minutes',
    },
    {
      name: 'daily-report',
      cron: '0 9 * * *',
    },
    {
      name: 'one-off-task',
      date: new Date('2026-03-01'),
    },
  ],
});

await bree.start();
await bree.run('agent-task'); // manual trigger
await bree.stop('agent-task');
await bree.add({ name: 'new-job', interval: '5m' });
await bree.remove('agent-task');
```

**Job files** (`jobs/agent-task.js`) run in **worker threads** — fully sandboxed:

```javascript
// jobs/agent-task.js
const { workerData, parentPort } = require('worker_threads');
// ... do work
parentPort.postMessage({ done: true });
```

**Scheduling formats** (most flexible of all libraries):

- Cron strings: `"0 9 * * *"`
- Human-readable: `"every 30 minutes"`, `"at 10:15 am"`
- Date objects (one-off)
- Millisecond values: `5000`
- `ms` library strings: `"5m"`, `"2h"`

**Pros**:

- **No Redis or MongoDB required**
- Worker thread isolation prevents one job from blocking others
- Most flexible scheduling format (human + cron + ms + date)
- Dynamic job add/remove at runtime
- Good fit for desktop apps

**Cons**:

- Each job must be a **separate file** in a `jobs/` directory — friction for simple callbacks
- No built-in persistence (must implement yourself)
- Smaller community than Bull/Agenda
- Worker thread overhead for very lightweight tasks
- Directory structure feels complex for simple use cases

---

### Approach 3: OS-Level Schedulers

#### Unix crontab (macOS/Linux) via `node-crontab`

**Repository**: [dachev/node-crontab](https://github.com/dachev/node-crontab)
**License**: GPL3
**Windows**: Not supported

```typescript
import crontab from 'crontab';

crontab.load((err, tab) => {
  const job = tab.create('/path/to/my-script.js', '0 9 * * 1-5', 'Agent Task');
  job.minute().at(0);
  job.hour().between(9, 17);
  tab.save((err) => console.log('Saved'));
});
```

**How it works**: Reads the user's system crontab (`crontab -l`), manipulates entries as objects, writes back via `crontab -e` equivalent. Jobs run as OS-level cron entries that survive process restarts and even machine reboots.

**Pros**:

- Jobs persist independently of the application process
- Native OS behavior (reliable timing, wake scheduling on macOS)
- Standard cron syntax
- No Node.js process needs to be running for jobs to fire

**Cons**:

- **macOS/Linux only** — no Windows support whatsoever
- Jobs run in isolation — no access to app state or in-process libraries
- Difficult to build a UI around (must parse crontab output)
- GPL3 license is restrictive
- Must ship a Node.js script as the executed command
- No built-in retry or error handling

#### Windows Task Scheduler

No npm package provides a good cross-platform abstraction. Windows Task Scheduler uses COM/WMI APIs or XML task files, completely different from Unix cron.

An approach via PowerShell/schtasks exists but requires admin privileges for many operations, has a completely different API from macOS/Linux, and makes it hard to manage programmatically.

**Cross-platform OS scheduling verdict**: Not viable for a cross-platform desktop app without massive platform-detection boilerplate. Use in-process scheduling instead.

---

### Approach 4: File-Based Scheduling

A custom scheduler that reads job definitions from a JSON or YAML configuration file, then uses an in-process cron library to execute them.

#### JSON Config Design

```json
{
  "jobs": [
    {
      "id": "daily-digest",
      "name": "Daily Digest",
      "description": "Summarize activity from the last 24 hours",
      "schedule": "0 9 * * 1-5",
      "scheduleHuman": "Weekdays at 9am",
      "enabled": true,
      "command": "summarize-activity",
      "args": { "window": "24h" },
      "lastRunAt": null,
      "nextRunAt": "2026-02-18T14:00:00Z"
    },
    {
      "id": "weekly-review",
      "name": "Weekly Review",
      "schedule": "0 16 * * 5",
      "scheduleHuman": "Fridays at 4pm",
      "enabled": false
    }
  ]
}
```

#### YAML Config Design

```yaml
jobs:
  - id: daily-digest
    name: Daily Digest
    description: Summarize activity from the last 24 hours
    schedule: '0 9 * * 1-5'
    schedule_human: 'Weekdays at 9am'
    enabled: true
    command: summarize-activity
    args:
      window: 24h

  - id: weekly-review
    name: Weekly Review
    schedule: '0 16 * * 5'
    schedule_human: 'Fridays at 4pm'
    enabled: false
```

#### Implementation Pattern

```typescript
import { Cron } from 'croner';
import { readFile, writeFile } from 'fs/promises';
import { watch } from 'fs';

class FileBasedScheduler {
  private jobs = new Map<string, Cron>();
  private configPath: string;

  async load() {
    const raw = await readFile(this.configPath, 'utf-8');
    const config = JSON.parse(raw);

    for (const jobDef of config.jobs) {
      if (jobDef.enabled) {
        this.register(jobDef);
      }
    }

    // Hot-reload on file change
    watch(this.configPath, () => this.reload());
  }

  private register(jobDef: JobDefinition) {
    const cronJob = new Cron(jobDef.schedule, async () => {
      await this.execute(jobDef);
      await this.updateLastRun(jobDef.id);
    });
    this.jobs.set(jobDef.id, cronJob);
  }
}
```

**Pros**:

- Fully LLM-readable and LLM-editable (LLM can write the JSON/YAML directly)
- Human-readable configuration
- Version-controllable (can be committed to git)
- Hot-reloadable via `fs.watch`
- No database dependencies

**Cons**:

- No atomic updates (race conditions on concurrent writes)
- `lastRunAt` / `nextRunAt` must be updated back to the file — awkward dual-purpose file
- File conflicts if multiple processes edit simultaneously
- No transactional job state tracking
- Better suited as the _config layer_ on top of a database (not as the database itself)

---

### Approach 5: SQLite-Backed Scheduler

The most appropriate persistence model for a desktop app. SQLite provides ACID transactions, is file-based (no server process), and is trivially distributable with the app.

#### Schema Design

```sql
-- Job definitions (persistent configuration)
CREATE TABLE scheduled_jobs (
  id          TEXT PRIMARY KEY,           -- UUID or slug
  name        TEXT NOT NULL,
  description TEXT,
  cron        TEXT,                       -- cron expression OR NULL for one-off
  interval_ms INTEGER,                   -- alternative: interval in milliseconds
  cron_human  TEXT,                       -- human-readable label e.g. "Every weekday at 9am"
  command     TEXT NOT NULL,              -- command/handler identifier
  args        TEXT DEFAULT '{}',          -- JSON blob of arguments
  enabled     INTEGER DEFAULT 1,          -- boolean: 0 or 1
  timezone    TEXT DEFAULT 'UTC',
  created_at  TEXT DEFAULT (datetime('now')),
  updated_at  TEXT DEFAULT (datetime('now'))
);

-- Job run history (execution log)
CREATE TABLE job_runs (
  id            TEXT PRIMARY KEY,         -- UUID
  job_id        TEXT NOT NULL REFERENCES scheduled_jobs(id),
  status        TEXT DEFAULT 'pending',   -- pending | running | done | failed | skipped
  triggered_by  TEXT DEFAULT 'schedule', -- schedule | manual | api
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  output        TEXT,                     -- JSON result or error message
  error         TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

-- Scheduler state (next run tracking)
CREATE TABLE scheduler_state (
  job_id      TEXT PRIMARY KEY REFERENCES scheduled_jobs(id),
  last_run_at TEXT,
  next_run_at TEXT,
  run_count   INTEGER DEFAULT 0,
  fail_count  INTEGER DEFAULT 0
);

-- Performance indexes
CREATE INDEX idx_scheduler_state_next_run ON scheduler_state(next_run_at);
CREATE INDEX idx_job_runs_job_id ON job_runs(job_id);
CREATE INDEX idx_job_runs_status ON job_runs(status);
```

Key SQLite pragmas for production use:

- `PRAGMA journal_mode = WAL;` — enables concurrent readers during writes
- `PRAGMA synchronous = 1;` — optimizes transaction flushing without full fsync
- `PRAGMA busy_timeout = 5000;` — 5-second retry window for lock contention

Use `BEGIN IMMEDIATE TRANSACTION` (not `BEGIN TRANSACTION`) when reading then updating a job to prevent lock promotion deadlocks.

#### Implementation with better-sqlite3

```typescript
import Database from 'better-sqlite3';
import { Cron } from 'croner';
import cronstrue from 'cronstrue';

class SQLiteScheduler {
  private db: Database.Database;
  private activeCrons = new Map<string, Cron>();
  private handlers = new Map<string, (args: unknown) => Promise<unknown>>();

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = 1');
    this.initSchema();
  }

  registerHandler(command: string, fn: (args: unknown) => Promise<unknown>) {
    this.handlers.set(command, fn);
  }

  async loadAndStart() {
    const jobs = this.db
      .prepare('SELECT * FROM scheduled_jobs WHERE enabled = 1')
      .all() as ScheduledJob[];

    for (const job of jobs) {
      this.scheduleJob(job);
    }

    // Recover missed jobs from before last shutdown
    this.recoverMissedJobs();
  }

  private scheduleJob(job: ScheduledJob) {
    if (this.activeCrons.has(job.id)) {
      this.activeCrons.get(job.id)!.stop();
    }

    const cronJob = new Cron(job.cron, { timezone: job.timezone }, async () => {
      await this.executeJob(job);
    });

    this.activeCrons.set(job.id, cronJob);

    // Persist next run time
    const nextRun = cronJob.nextRun();
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO scheduler_state (job_id, next_run_at)
      VALUES (?, ?)
    `
      )
      .run(job.id, nextRun?.toISOString() ?? null);
  }

  private async executeJob(job: ScheduledJob) {
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();

    this.db
      .prepare(
        `
      INSERT INTO job_runs (id, job_id, status, triggered_by, started_at)
      VALUES (?, ?, 'running', 'schedule', ?)
    `
      )
      .run(runId, job.id, startedAt);

    try {
      const handler = this.handlers.get(job.command);
      if (!handler) throw new Error(`No handler registered for command: ${job.command}`);
      const result = await handler(JSON.parse(job.args));
      const finishedAt = new Date().toISOString();

      this.db
        .prepare(
          `
        UPDATE job_runs
        SET status = 'done', finished_at = ?, output = ?
        WHERE id = ?
      `
        )
        .run(finishedAt, JSON.stringify(result), runId);

      this.db
        .prepare(
          `
        UPDATE scheduler_state
        SET last_run_at = ?, run_count = run_count + 1, next_run_at = ?
        WHERE job_id = ?
      `
        )
        .run(startedAt, this.activeCrons.get(job.id)?.nextRun()?.toISOString(), job.id);
    } catch (err) {
      this.db
        .prepare(
          `
        UPDATE job_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?
      `
        )
        .run(new Date().toISOString(), String(err), runId);

      this.db
        .prepare(`UPDATE scheduler_state SET fail_count = fail_count + 1 WHERE job_id = ?`)
        .run(job.id);
    }
  }

  private recoverMissedJobs() {
    const missed = this.db
      .prepare(
        `
      SELECT ss.*, sj.missed_run_policy
      FROM scheduler_state ss
      JOIN scheduled_jobs sj ON ss.job_id = sj.id
      WHERE ss.next_run_at < datetime('now') AND sj.enabled = 1
    `
      )
      .all() as Array<SchedulerState & { missed_run_policy: string }>;

    for (const state of missed) {
      const job = this.db
        .prepare('SELECT * FROM scheduled_jobs WHERE id = ?')
        .get(state.job_id) as ScheduledJob;

      if (state.missed_run_policy === 'run_once') {
        this.executeJob(job).catch(console.error);
      }
      // 'skip' policy: just let the scheduler pick up from the next occurrence
    }
  }

  addJob(def: NewScheduledJob) {
    const human = cronstrue.toString(def.cron);
    this.db
      .prepare(
        `
      INSERT INTO scheduled_jobs (id, name, cron, cron_human, command, args, enabled, timezone)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `
      )
      .run(
        def.id,
        def.name,
        def.cron,
        human,
        def.command,
        JSON.stringify(def.args ?? {}),
        def.enabled ? 1 : 0,
        def.timezone ?? 'UTC'
      );

    if (def.enabled) {
      const job = this.db
        .prepare('SELECT * FROM scheduled_jobs WHERE id = ?')
        .get(def.id) as ScheduledJob;
      this.scheduleJob(job);
    }
  }

  removeJob(id: string) {
    this.activeCrons.get(id)?.stop();
    this.activeCrons.delete(id);
    this.db.prepare('UPDATE scheduled_jobs SET enabled = 0 WHERE id = ?').run(id);
  }
}
```

#### Using Drizzle ORM for Type Safety

```typescript
// schema.ts
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

export const scheduledJobs = sqliteTable('scheduled_jobs', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  cron: text('cron'),
  cronHuman: text('cron_human'),
  command: text('command').notNull(),
  args: text('args').default('{}'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  timezone: text('timezone').default('UTC'),
  missedRunPolicy: text('missed_run_policy', { enum: ['skip', 'run_once', 'run_all'] }).default(
    'skip'
  ),
  createdAt: text('created_at'),
  updatedAt: text('updated_at'),
});

export const jobRuns = sqliteTable('job_runs', {
  id: text('id').primaryKey(),
  jobId: text('job_id').references(() => scheduledJobs.id),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'skipped'] }),
  triggeredBy: text('triggered_by', { enum: ['schedule', 'manual', 'api'] }),
  startedAt: text('started_at'),
  finishedAt: text('finished_at'),
  durationMs: integer('duration_ms'),
  output: text('output'),
  error: text('error'),
});

export const schedulerState = sqliteTable('scheduler_state', {
  jobId: text('job_id')
    .primaryKey()
    .references(() => scheduledJobs.id),
  lastRunAt: text('last_run_at'),
  nextRunAt: text('next_run_at'),
  runCount: integer('run_count').default(0),
  failCount: integer('fail_count').default(0),
});
```

**Pros**:

- Full ACID persistence — jobs survive crashes and restarts
- Complete audit trail (job_runs table)
- Query-able history (missed runs visible in DB)
- File-based (single `.sqlite` file, no server)
- Works in Electron main process via better-sqlite3
- Fast synchronous API (no async/await overhead for DB ops)
- Drizzle ORM adds type-safe schema + migrations
- UI-friendly (can query state for dashboards)

**Cons**:

- Requires initial schema setup and migration strategy
- better-sqlite3 requires native compilation (Electron rebuild needed via `electron-rebuild` or `@electron/rebuild`)
- Not human-readable in raw form (binary file)
- Must keep SQLite state in sync with in-memory croner jobs
- Alternative for Electron without native modules: `sql.js` (pure JS WebAssembly, slower) or `@electric-sql/pglite`

---

### Approach 6: Temporal / Workflow Engines

Temporal, Prefect, Apache Airflow, and similar workflow orchestration engines are purpose-built for distributed, durable long-running workflows across clusters.

**Verdict: Definitively overkill for a desktop app.**

| Criterion               | Temporal                                        | DorkOS Need                   |
| ----------------------- | ----------------------------------------------- | ----------------------------- |
| Infrastructure          | Temporal server (separate process) + DB         | Zero external services        |
| Scale                   | Thousands of concurrent workflows               | Tens of scheduled jobs        |
| Determinism enforcement | Strict (no non-deterministic code in workflows) | Arbitrary AI agent code       |
| Setup complexity        | High (SDK + server + namespace)                 | Low (single npm install)      |
| Debugging               | Temporal Web UI, replay mechanism               | Simple log + SQLite query     |
| Use case                | Multi-step, long-running distributed workflows  | Run an LLM call on a schedule |

The only scenario where Temporal makes sense here is if individual agent tasks themselves become multi-step, multi-hour durable workflows with automatic retry and replay. Even then, the infrastructure burden is substantial.

**Conclusion**: Temporal is the wrong tool for local scheduled AI agent invocations.

---

## Scheduling Format Analysis: Cron vs. Natural Language vs. Interval

### Format Comparison

| Format            | Example                     | Human-Readable | LLM-Friendly | Precision | Complexity |
| ----------------- | --------------------------- | -------------- | ------------ | --------- | ---------- |
| Cron expression   | `0 9 * * 1-5`               | Low            | Medium       | High      | Medium     |
| Natural language  | `"every weekday at 9am"`    | High           | High         | Medium    | Low        |
| ISO 8601 interval | `PT30M` (every 30 min)      | Low            | Medium       | High      | Medium     |
| ms string         | `"30m"`, `"2h"`             | Medium         | High         | Medium    | Low        |
| Interval object   | `{ hours: 2, minutes: 30 }` | Medium         | High         | High      | Low        |
| Date + recurrence | `Date + RecurrenceRule`     | Medium         | Medium       | High      | High       |

### Recommendation: Dual-Format Storage

Store **both** a cron string and a human-readable label:

```json
{
  "cron": "0 9 * * 1-5",
  "cron_human": "Every weekday at 9am"
}
```

Use `cronstrue` to generate the human label from any cron expression:

```typescript
import cronstrue from 'cronstrue';
cronstrue.toString('0 9 * * 1-5'); // => "At 09:00 AM, Monday through Friday"
```

**For LLM interaction**: Natural language input, converted to cron via the LLM itself (Claude can convert "every Tuesday and Thursday at 2pm" to `"0 14 * * 2,4"` reliably), with `cronstrue` used to confirm the translation back to English for user verification.

### Cron Expression LLM Compatibility

Claude and other LLMs handle cron expression generation well for standard patterns. Edge cases (L modifier, W modifier, year field) require careful prompting. A validation step using `croner`'s `match()` is recommended before persisting any LLM-generated cron string.

---

## Handling Missed Runs (Sleep/Wake Problem)

### The Problem

When a macOS or Windows machine sleeps, all JavaScript timers freeze. On wake:

- **node-schedule**: Known sleep/wake drift on Windows (issue #278) — timers may fire at wrong times
- **croner**: Recalculates next run on wake, typically skips the missed window
- **node-cron**: Fires the missed invocation immediately on wake (catch-up behavior)

### Solutions

#### Option 1: wake-event / sleeptime Detection

```typescript
// sleeptime npm package detects wake from sleep
import sleeptime from 'sleeptime';

sleeptime.start((err, data) => {
  if (data.sleptMs > 0) {
    // System just woke from sleep; data.sleptMs = how long it slept
    checkMissedJobs();
  }
});

function checkMissedJobs() {
  const now = new Date();
  const missed = db
    .prepare(
      `
    SELECT ss.*, sj.*
    FROM scheduler_state ss
    JOIN scheduled_jobs sj ON ss.job_id = sj.id
    WHERE ss.next_run_at < ? AND sj.enabled = 1
  `
    )
    .all(now.toISOString());

  for (const job of missed) {
    if (job.missed_run_policy === 'run_once') {
      executeJob(job);
    }
    // 'skip': reschedule to next occurrence only
  }
}
```

In Electron specifically, use the built-in `powerMonitor` API instead of a third-party package:

```typescript
import { powerMonitor } from 'electron';

powerMonitor.on('resume', () => {
  checkMissedJobs();
});
```

#### Option 2: Per-Job Missed-Run Policy

Store a `missed_run_policy` field in the job definition:

- `"skip"` — if the scheduled time was missed, skip it and wait for the next occurrence (recommended for AI tasks)
- `"run_once"` — run once on wake regardless of how many times it was missed
- `"run_all"` — run once per missed occurrence (rarely appropriate for AI tasks)

#### Option 3: SQLite-Based Recovery on Startup

On every app start, check `scheduler_state.next_run_at` against `NOW()`. Any job with `next_run_at < NOW()` was missed. Apply the per-job policy. This handles missed runs from both sleep and process crashes.

---

## Evaluation Matrix

| Criterion                    | croner + SQLite       | Bree              | Agenda           | BullMQ           | OS Cron         | File-Based     |
| ---------------------------- | --------------------- | ----------------- | ---------------- | ---------------- | --------------- | -------------- |
| Regular scheduled jobs       | Yes                   | Yes               | Yes              | Yes              | Yes             | Yes            |
| One-off job support          | Yes                   | Yes               | Yes              | Yes              | Partial         | Partial        |
| Complex cron syntax          | Yes (OCPS 1.4)        | Yes               | Yes              | Yes              | Yes             | Yes            |
| Job survival across restarts | Yes (SQLite)          | No                | Yes (MongoDB)    | Yes (Redis)      | Yes (OS-level)  | Partial (file) |
| macOS compatibility          | Yes                   | Yes               | No (needs Mongo) | No (needs Redis) | Yes             | Yes            |
| Windows compatibility        | Yes                   | Yes               | No               | No               | No              | Yes            |
| LLM-readable config          | Partial (DB + export) | Yes               | Yes              | No               | No              | Yes            |
| Update via CLI/API           | Yes                   | Yes               | Yes              | Yes              | Partial         | Partial        |
| UI-buildable                 | Yes                   | Partial           | Yes (Agendash)   | Yes (Bull Board) | No              | Partial        |
| Custom LLM calls             | Yes                   | Yes (worker file) | Yes              | Yes              | Partial         | Yes            |
| Implementation complexity    | Medium                | Medium            | High (MongoDB)   | High (Redis)     | Low (Unix only) | Low            |
| Sleep/wake handling          | Manual + powerMonitor | Manual            | N/A              | N/A              | OS handles      | Manual         |
| External service required    | No                    | No                | MongoDB          | Redis            | No              | No             |
| Electron-compatible          | Yes (rebuild needed)  | Yes               | No               | No               | No              | Yes            |

---

## Recommended Architecture for DorkOS

### Primary Recommendation: croner + SQLite + JSON export

**Stack**:

- **Scheduler runtime**: `croner` (zero-dep, OCPS 1.4, TypeScript-native)
- **Persistence**: `better-sqlite3` with Drizzle ORM schema
- **Config layer**: JSON export of `scheduled_jobs` table for LLM editing
- **Human labels**: `cronstrue` for cron-to-English conversion
- **Sleep detection**: Electron `powerMonitor.on('resume')` + startup recovery query

**Architecture**:

```
┌─────────────────────────────────────────────┐
│              DorkOS Server                   │
│                                              │
│  ┌──────────────┐    ┌────────────────────┐  │
│  │   croner     │    │  SQLiteScheduler   │  │
│  │  (runtime)   │◄───│  (persistence)     │  │
│  └──────────────┘    └────────────────────┘  │
│         │                     │              │
│         ▼                     ▼              │
│  ┌──────────────┐    ┌────────────────────┐  │
│  │ AgentManager │    │   scheduled_jobs   │  │
│  │  (Claude SDK)│    │   job_runs         │  │
│  └──────────────┘    │   scheduler_state  │  │
│                      └────────────────────┘  │
│                               │              │
│                      ┌────────────────────┐  │
│                      │  REST API           │  │
│                      │  GET /schedules     │  │
│                      │  POST /schedules    │  │
│                      │  PATCH /schedules/:id│  │
│                      │  DELETE /schedules/:id│ │
│                      │  POST /schedules/:id/run│
│                      └────────────────────┘  │
└─────────────────────────────────────────────┘
```

**Key design decisions**:

1. **croner registers all enabled jobs from SQLite on startup** — no hardcoded schedules
2. **Every job execution is logged** to `job_runs` — full audit trail
3. **Missed job recovery** runs at startup and on sleep/wake events
4. **JSON export** of `scheduled_jobs` is LLM-readable for configuration via chat
5. **REST API** enables the client UI to CRUD schedules without touching SQLite directly
6. **Human labels** stored alongside cron expressions for UI display

### Secondary Option: Bree (if worker isolation is needed)

If agent tasks need true isolation (e.g., they import conflicting modules, or need separate process memory), Bree's worker thread model is the alternative. Add SQLite persistence manually on top.

### Avoid

- Agenda (requires MongoDB)
- BullMQ/Bull (requires Redis)
- OS crontab (Windows incompatible, GPL3 license)
- Temporal (infrastructure overkill)

---

## Best Practices for Desktop/Electron Scheduling

1. **Always persist job definitions externally** (SQLite or file) — in-memory schedulers lose all jobs on restart

2. **Use WAL mode for SQLite** (`PRAGMA journal_mode = WAL`) for concurrent reads during write operations

3. **Store `next_run_at` in UTC** — convert to local time only at display layer

4. **Define a `missed_run_policy` per job** — AI agent tasks typically want `"skip"` behavior (don't run stale data analysis from 3 hours ago)

5. **Implement startup recovery** — check for jobs where `next_run_at < NOW()` on every server start

6. **In Electron, use `powerMonitor.on('resume')`** for reactive sleep/wake handling in addition to startup recovery. In plain Node.js CLI, use the `sleeptime` package or `setInterval` drift detection.

7. **Validate cron expressions** before persisting — use `croner`'s built-in validation or `cronstrue` to confirm the parsed meaning

8. **Log every execution** — job_runs table enables debugging, auditing, and UI history views

9. **Separate "job definition" from "job execution"** — definitions are config (rarely change), executions are events (change constantly)

10. **Avoid native module issues in Electron** — `better-sqlite3` requires electron-rebuild (`@electron/rebuild`); alternatively use `sql.js` (pure WASM, slower) or `@electric-sql/pglite` (pure JS PostgreSQL)

---

## Research Gaps and Limitations

- `workmatic` (SQLite + job queue npm package) was found but has very low adoption — not enough production usage data to recommend
- `sleeptime` npm package was last published 8 years ago — may need a custom implementation using `setInterval` drift detection instead for non-Electron CLI use
- Bree's persistence story is intentionally minimal — no official SQLite integration pattern is documented
- Windows sleep/wake event detection in a plain Node.js CLI (non-Electron) is not well-documented; `powerMonitor` is Electron-only

---

## Contradictions and Disputes

- **Croner vs node-schedule download counts**: node-schedule has significantly more weekly downloads (~1.5M vs ~800k), but croner has more complete cron syntax support and zero dependencies. For new projects, croner is the better technical choice despite lower adoption.

- **Bree worker thread overhead**: Some sources cite worker threads as ideal for isolation; others note the per-file job requirement adds friction. For simple AI task invocations (just calling an async function), the overhead may outweigh the isolation benefit.

- **File-based vs SQLite for config**: File-based YAML/JSON is more LLM-friendly for reading/writing, but SQLite is more robust for runtime state. The best answer is both: SQLite as the database, with a JSON export/import feature for LLM interaction.

---

## Sources and Evidence

- [Schedulers in Node: A Comparison of the Top 10 Libraries | Better Stack](https://betterstack.com/community/guides/scaling-nodejs/best-nodejs-schedulers/) — Feature matrix across 10 libraries
- [Job Schedulers for Node: Bull or Agenda? | AppSignal Blog](https://blog.appsignal.com/2023/09/06/job-schedulers-for-node-bull-or-agenda.html) — Bull vs Agenda deep dive
- [Comparing the best Node.js schedulers - LogRocket Blog](https://blog.logrocket.com/comparing-best-node-js-schedulers/) — General comparison
- [Hexagon/croner - GitHub](https://github.com/Hexagon/croner) — Croner source, API docs, OCPS 1.4 compliance
- [breejs/bree - GitHub](https://github.com/breejs/bree) — Bree scheduling formats, worker thread architecture
- [node-schedule/node-schedule - GitHub](https://github.com/node-schedule/node-schedule) — Recurrence rule API
- [dachev/node-crontab - GitHub](https://github.com/dachev/node-crontab) — OS crontab management, Windows incompatibility
- [A SQLite Background Job System - JasonGorman](https://jasongorman.uk/writing/sqlite-background-job-system/) — Schema design, WAL mode, BEGIN IMMEDIATE TRANSACTION pattern
- [damoclark/node-persistent-queue - GitHub](https://github.com/damoclark/node-persistent-queue) — SQLite-backed queue for Node.js
- [workmatic - npm](https://www.npmjs.com/package/workmatic) — SQLite + job queue with zero external deps
- [timrach/sleeptime - GitHub](https://github.com/timrach/sleeptime) — Sleep/wake detection
- [wake-event - npm](https://www.npmjs.com/package/wake-event) — Browser/Electron wake detection
- [scheduleJob drifts when sleeping on Windows - GitHub Issue #278](https://github.com/node-schedule/node-schedule/issues/278) — Known sleep/wake bug in node-schedule
- [cronstrue - npm](https://www.npmjs.com/package/cronstrue) — Cron-to-English description library
- [Temporal Alternatives Analysis - ZenML Blog](https://www.zenml.io/blog/temporal-alternatives) — When Temporal is overkill
- [Node.js Job Scheduler Tutorial 2026 - ForwardEmail](https://forwardemail.net/en/blog/docs/node-js-job-scheduler-cron) — Bree practical usage
- [cron vs node-cron vs node-schedule vs toad-scheduler | npm trends](https://npmtrends.com/cron-vs-node-cron-vs-node-schedule-vs-toad-scheduler) — Download statistics

---

## Search Methodology

- Searches performed: 14
- Most productive search terms: `"croner TypeScript cron scheduler features"`, `"SQLite job scheduler Node.js persistent"`, `"missed job runs desktop sleep wake"`, `"node-crontab OS cron macOS Windows"`, `"Bree job scheduler worker threads no Redis"`
- Primary source types: GitHub READMEs, npm package pages, technical blog posts (Better Stack, LogRocket, AppSignal, JasonGorman)
- Research depth: Deep
