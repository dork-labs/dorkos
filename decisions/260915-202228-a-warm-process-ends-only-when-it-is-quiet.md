---
id: 260915-202228
title: A warm process ends only when it is quiet, and everything it says is projected
status: accepted
created: 2026-09-15
spec: warm-process-lifecycle
superseded-by: null
amends: [260812-134510]
---

# 260915-202228. A warm process ends only when it is quiet, and everything it says is projected

## Status

Accepted. Amends [ADR 260812-134510](260812-134510-persistent-streaming-input-sessions.md), which stays accepted; its
Status section quotes each retired passage. In short: a relaunch pin change no longer replaces the process at the next
dispatch whatever it is doing; eviction no longer tears down a process holding background work; "a reap costs nothing
observable" now holds only for a quiet process; a process holding background work is not reclaimable for the warm
ceiling. This ADR also retires an implementation rule that was never in the parent's text: the
`persistent-dispatch.ts` module doc's "runtime windows are drained, never projected". The two-timer model, the warm
ceiling, the pin list and a conversation's fixed account stand.

## Context

A warm claude-code process keeps working after a turn's `result`. Background agents and Monitors run on, and notification
deliveries wake the model with no DorkOS turn open. On 2026-09-15 a room turn and a direct-chat message on one session
carried different relaunch pins. DorkOS replaced the process twice at its idle boundary and killed the helpers each time,
dropped a reply the agent wrote between turns, and showed "Claude Code stopped unexpectedly" for a turn that closed before
its answer (DOR-2064, DOR-2065). Record eviction would have killed the same helpers. The queue puts a turn on screen and
removes its row as the turn's first act and launches the next message the moment a turn ends, and the only deadline on an
owed notification lives in a stdin close the warm path never runs.

## Decision

We will end a warm process only when it is quiet: no turn or runtime turn open, no live helper agent, Monitor or unknown
task, no owed notification, nobody asked. Background shells will not hold a process. We will decide a relaunch before the
turn exists: an async prepare outside the dispatch mutex resolves the launch, and a synchronous commit inside the queue
pump, immediately before launch, retires a quiet process that has been silent for two seconds in that same tick, or leaves
the message queued as a gated row that holds no lock and opens no turn, with a "Switch now" action. Chat rows will never be
reordered; a room trigger that rides the current process may pass a gated row once per wait. A running conversation will
keep its own account; only a change to that account's own resolved credentials will stop its process, at the configuration
change. Owed notifications will get their own 30-second clock on the warm path, cancelled by a segment start and cleared
early when the CLI folds the delivery into a running turn. Record eviction and the idle reaper will skip a busy process for
up to a 4-hour ceiling, and every hold names its bound. Only five things will end live work: the operator stopping tasks,
Switch now, a changed credential on the session's own account, the ceiling, and server shutdown; all but shutdown will say
so. Unsolicited activity will become its own `origin: 'runtime'` turn, registered with the queue pump from the moment its
window opens and preceded by any owed delivery, with the ordinary stall guard. Room mentions that meet an agent-owned
reason not to run will wait in a room-owned slot that Stop never touches and get one follow-up if they end unanswered, even
across a restart.

## Consequences

### Positive

- Background work an agent started survives relaunches, idle reaps, warm-ceiling reclaims and record eviction.
- Every word a warm process produces reaches the durable stream, in its own turn and in order.
- The relaunch decision is never made about a turn already on screen.
- No queue hold is unbounded: an owed delivery that never arrives releases the queue after 30 seconds.
- A default-account switch never disturbs a running conversation, and a replaced credential stops what was using it.
- The crash notice again means a crash; room mentions are answered or explicitly declined.

### Negative

- A message that needs a relaunch can wait as long as the helpers run, up to 4 hours, and blocks the chat messages queued
  behind it until the operator reorders or switches.
- A queued message can wait up to 30 seconds for a notification that never arrives, and a replace waits two seconds of
  silence.
- Scheduled wake-ups, running hooks and MCP notifications are invisible to the quiet check and still end with any replace.
- Stop returns a gated message to the composer like any queued message.
- Helper-pinned processes hold warm slots; a host with twelve refuses a thirteenth session.
- Runtime turns hold the queue and the lock, up to the 10-minute stall guard for a silent one; room answers can arrive hours
  late.
- A credential change stops helpers mid-work; credential changes made outside DorkOS go undetected.
- A helper finishing inside a person's running turn is folded into that turn by the CLI.
- The queue pump, record eviction and the room runner depend on optional runtime ports, and the defensive `not_sent` path
  adds a terminal reason and a bubble withdrawal on live, replay and snapshot paths that should never run.

## Alternatives Considered

- **Only forbid `replace` while a window is open** (DOR-2064's proposal). Rejected: the write lock already guarantees it,
  and it prevented neither incident.
- **Wait inside the turn, holding the lock.** Rejected: defeats the lock TTL, stall guard and queue timeout, is emptied by
  Stop, and puts helper frames in the person's turn.
- **Decide the relaunch inside `dispatch` or `triggerTurn`.** Rejected: `turn_start` and the row's removal have already
  happened.
- **Reuse the resume path's owed-delivery deadline.** Rejected: it is armed by a stdin close the warm path never performs.
- **Reorder gated chat rows out of the way, or let rooms pass them freely.** Rejected: a person's queued messages are theirs
  to order, and a busy room would starve them.
- **Stop running conversations on a default-account switch.** Rejected: a conversation stays on the account that paid for it.
- **Relaunch after a fixed timeout; let shells hold the process; room triggers in the chat queue; a second process; raise the
  hold cap.** Rejected for the reasons in the spec.
