---
id: 260825-232207
title: Sticky scheduled tasks resume one real SDK session across runs
status: accepted
created: 2026-08-25
spec: null
superseded-by: null
amends: null
---

# 260825-232207. Sticky scheduled tasks resume one real SDK session across runs

## Status

Proposed (DOR-1571).

## Context

Every scheduled-task fire starts a brand-new session whose id is the run's ULID
(`task-scheduler-service.ts` used `const sessionId = run.id`; the relay path keyed
`ensureSession(runId, …)`). No context carries between runs, so a task that wants to
report "since I last ran, here is what changed" has nothing to build on — each run
begins amnesiac. Users asked for a task that accumulates context across fires.

The runtime resumes a Claude Code session by id, but the id it resumes is not one the
caller gets to choose. The SDK mints its OWN session id on the first turn and the runtime
remaps the session to it (`system-event-mapper.ts`), writing the transcript on disk under
that UUID. Resume targets `session.sdkSessionId` (`launch-resolver.ts`), and a resume of an
id with no `{id}.jsonl` fails and silently retries as a brand-new session
(`message-sender.ts`, `isResumeFailure`). Sessions are idle-reaped after minutes and lost
on restart. So any resume scheme that reuses a caller-invented id works only while the
session is still warm in memory — i.e. essentially never for the hourly/daily schedules
sticky targets.

## Decision

Add an opt-in **`sticky`** flag on a scheduled task. When on, every fire RESUMES one
persistent session instead of starting fresh; when off (the default) behaviour is
byte-for-byte what it was — `sessionId = run.id`, started fresh.

1. **The resume target is the runtime's REAL SDK session id, captured from the prior run
   and persisted.** A first sticky fire runs fresh under the run's own id; when its turn is
   over the scheduler reads the id the SDK actually minted (`getInternalSessionId`) and
   writes it as that run's `TaskRun.sessionId`. Every later fire reads the most recent run's
   stored id (`latestStickySessionId`) and resumes THAT — an id whose `{id}.jsonl` exists on
   disk, so the runtime rehydrates it cold, across idle-reap and restart. A synthetic derived
   id (`sticky-<taskId>`) was tried first and rejected: it can never be the resume id because
   no transcript is ever written under it, so it degraded silently to fresh-every-run. The
   only new column is a boolean `sticky` on `pulse_schedules`, cached from the file's
   `schedule.sticky`; the resume id needs no column — it rides the run row we already write.

2. **Run history stays per-run, and the transcript link works cold.** Each fire still opens
   its own `TaskRun` row. Because a sticky run stores the runtime's real session id, clicking
   any sticky run in the history opens the actual transcript on disk — not a synthetic id that
   resolves to nothing after eviction.

3. **`hasStarted` is resolved from run history.** The scheduler's explicit `ensureSession`
   short-circuits `sendMessage`'s own transcript probe, so the resume decision has to be made
   and carried by the scheduler: resume when `latestStickySessionId` finds a prior run, start
   fresh otherwise. On the relay path the resolved resume id and this flag travel on
   `TaskDispatchPayload` (`sessionId`, `resumeSession`), because the receiver runs in another
   process and cannot see the history; the receiver captures the post-turn real id
   (`getSdkSessionId`) and writes it back to the run row the same way.

4. **One in-flight turn per sticky session.** A sticky task is effectively max-1 on its
   session: if a fire arrives while the previous run is still running, the scheduler writes a
   `skipped` run (reusing the exact at-cap claim/skip machinery) rather than opening a second
   concurrent turn that would corrupt the shared session. This serialization is task-keyed
   (`hasRunningRunForTask`) and single-process: it holds because scheduled firing is already
   confined to the one `dorkHome` leader (ADR-285). Sticky is the first feature whose
   CORRECTNESS — not just a dispatch count — leans on that single-leader assumption; a
   multi-writer scheduler would need a durable per-session lock instead.

5. **Both dispatch paths honour sticky** — direct (`executeRunDirect`) and relay
   (`relay/adapters/claude-code/task-handler.ts`) — resolved through one helper
   (`services/tasks/session/sticky-session.ts`) so they cannot drift.

We rejected a dedicated `sticky_sdk_session_id` column: the resume id is already the natural
content of the run row's `sessionId`, and storing it there fixes the transcript link in the
same stroke. We rejected letting sticky pick a specific EXISTING session — a larger surface
(a session dropdown), deferred as a follow-up.

## Consequences

### Positive

- A scheduled task accumulates context across runs with one toggle, and it survives
  eviction and restart because it resumes an id the runtime can genuinely rehydrate.
- Clicking any sticky run opens its real conversation, because the row now names the
  transcript on disk.
- No id column and no id migration; the one boolean column mirrors the existing file-first,
  write-through pattern.
- Concurrency is handled by the machinery that already exists for the global cap, so a slow
  sticky task degrades to a recorded `skipped`, never to two turns on one session.

### Negative

- The resume-target chain follows the SDK's re-mint: each fire persists the id its turn
  actually ran under, so a run that fails after starting a turn but before the SDK's init
  event records the fallback id (the resume target it was handed), and the next fire resumes
  that. Rare, and the runtime tolerates a missing transcript by starting fresh.
- "Which session did this run use" is now two answers depending on `sticky`, so any reader of
  `TaskRun.sessionId` must not assume it equals the run id.
- Sticky serialization inherits ADR-285's single-leader assumption (decision 4); it is not
  safe under a hypothetical multi-writer scheduler without a durable per-session lock.
- Marketplace/Shape/legacy schedules cannot declare `sticky` yet (their manifests have no
  field for it), so they are always isolated-per-run until a future change threads it through
  those authoring surfaces.
