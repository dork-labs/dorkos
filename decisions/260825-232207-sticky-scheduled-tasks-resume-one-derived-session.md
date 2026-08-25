---
id: 260825-232207
title: Sticky scheduled tasks resume one derived session across runs
status: proposed
created: 2026-08-25
spec: null
superseded-by: null
amends: null
---

# 260825-232207. Sticky scheduled tasks resume one derived session across runs

## Status

Proposed (DOR-1571).

## Context

Every scheduled-task fire starts a brand-new session whose id is the run's ULID
(`task-scheduler-service.ts` used `const sessionId = run.id`; the relay path keyed
`ensureSession(runId, …)`). No context carries between runs, so a task that wants to
report "since I last ran, here is what changed" has nothing to build on — each run
begins amnesiac. Users asked for a task that accumulates context across fires.

The runtime already supports resuming a session by a caller-chosen id: the scheduler's
explicit `ensureSession` seam takes a `hasStarted` flag, and the Claude Code runtime
resumes a session that has one. What was missing was a stable session id to reuse and the
concurrency discipline to keep one session coherent when a slow run overruns its interval.

## Decision

Add an opt-in **`sticky`** flag on a scheduled task. When on, every fire RESUMES one
persistent session instead of starting fresh; when off (the default) behaviour is
byte-for-byte what it was — `sessionId = run.id`, started fresh.

1. **The sticky session id is derived, not stored: `sticky-<taskId>`.** It is a pure
   function of the task, so it is identical on every run with no column to persist or
   reconcile, and it cannot collide with a real session id — an isolated run's id is a
   ULID (26-char uppercase Crockford base32, no `-`, no lowercase), so no ULID can equal a
   string beginning `sticky-`. The only new column is a boolean `sticky` on
   `pulse_schedules`, cached from the file's `schedule.sticky` like every other scheduling
   field; the session id itself is never stored.

2. **Run history stays per-run.** Each fire still opens its own `TaskRun` row with its own
   run id. A sticky run's `TaskRun.sessionId` points at the shared `sticky-<taskId>`
   session, so clicking any sticky run in the history opens the same growing transcript —
   the intended, desirable behaviour.

3. **`hasStarted` is resolved from run history.** The scheduler's explicit `ensureSession`
   short-circuits `sendMessage`'s own transcript probe, so the resume decision has to be
   made and carried by the scheduler. A sticky session resumes when a prior run has already
   written that session id onto its (terminal) run row — the first fire finds none and
   starts fresh, later fires resume. On the relay path the resolved session id and this
   flag travel on `TaskDispatchPayload` (`sessionId`, `resumeSession`), because the
   receiver runs in another process and cannot see the history.

4. **One in-flight turn per sticky session.** A sticky task is effectively max-1 on its
   session: if a fire arrives while the previous run is still running, the scheduler writes
   a `skipped` run (reusing the exact at-cap claim/skip machinery) rather than opening a
   second concurrent turn that would corrupt the shared session.

5. **Both dispatch paths honour sticky** — direct (`executeRunDirect`) and relay
   (`relay/adapters/claude-code/task-handler.ts`) — resolved through one helper
   (`services/tasks/sticky-session.ts`) so they cannot drift.

We rejected persisting a `stickySessionId` column: a derived id needs no column, no
migration for the id, and no reconciliation, and the ULID-collision argument makes it
safe. We rejected letting sticky pick a specific EXISTING session — that is a larger
surface (a session dropdown) and is deferred as a follow-up.

## Consequences

### Positive

- A scheduled task can accumulate context across runs with one toggle, and every run in its
  history opens the same conversation.
- No id column and no id migration; the one boolean column mirrors the existing
  file-first, write-through pattern.
- Concurrency is handled by the machinery that already exists for the global cap, so a
  slow sticky task degrades to a recorded `skipped`, never to two turns on one session.

### Negative

- A sticky run that fails after `ensureSession` but before writing any transcript still
  records its session id, so the next fire will try to resume a session with no transcript.
  This is rare (an instant failure inside the first turn) and the runtime tolerates it by
  starting fresh; noted rather than engineered around, because the alternative is threading
  a transcript reader into the scheduler.
- "Which session did this run use" is now two answers depending on `sticky`, so any reader
  of `TaskRun.sessionId` must not assume it equals the run id.
- Marketplace/Shape/legacy schedules cannot declare `sticky` yet (their manifests have no
  field for it), so they are always isolated-per-run until a future change threads it
  through those authoring surfaces.
