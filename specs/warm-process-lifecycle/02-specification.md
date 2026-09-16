---
slug: warm-process-lifecycle
number: 260915-202248
created: 2026-09-15
status: specified
---

# A warm agent process keeps its background work

**Status:** Draft (revision 5, after review of `53d026c24`)
**Author:** DOR-2064, DOR-2065 (with FB-18)
**Date:** 2026-09-15

> Read off the tree at `2b638e122`. Incident evidence and the file:line map are in `01-ideation.md` §3–§4 and
> are not repeated here. Section numbers D1–D9 match the ideation's decision table row for row; D2a elaborates D2.

## Overview

On the persistent claude-code path, DorkOS kills background work the agent already started, drops what the
agent says between turns, and blames the crash on the harness. This spec fixes the lifecycle with five rules:

1. A process is relaunched, reaped or evicted **only when it is quiet**. Five named cases are the exception.
2. Everything the process says is **projected** into the session as a turn of its own, in the order it happened.
3. A dispatched turn on a freshly relaunched process **does not close before the agent answers**.
4. A message that needs a relaunch **waits in the queue**, and the decision to relaunch is made **before its turn
   starts**, in one synchronous step. Room mentions wait in a room-owned slot that Stop never touches.
5. When DorkOS stops live work on purpose, it **says so in plain words**, and the app shows, and lets the operator
   stop, whatever is still running.

## Background / Problem Statement

See ideation §4. Short form:

- **DOR-2064 is not a mid-turn kill.** Both replaces on 2026-09-15 came at DorkOS's idle boundary (63 ms and
  6.8 s after a `result`). `evict` tore down a process running background agents that `reap` would have refused.
- **The "stopped unexpectedly" notice is the empty-turn guard** (`pump-turn-stream.ts:236-243`), firing on the
  relaunched process's first window, which closed in ~2 s with zero content while the real answer ran after it.
- **DOR-2065's loss is a bounded hold overflowing, then a drained runtime window.** The idle reaper spares live
  `local_agent` helpers; record eviction (30 min after the last turn) spares nothing.
- **FB-18** is the composer strip reading task membership from message parts the turn-end reload replaces.
- The turn and queue machinery assumes turns are short and start the moment they are launched:
  - `feedProjector` ingests `turn_start` (with the person's message) as its first act
    (`session-event-normalizer.ts:952-961`), and the dispatcher removes the queue row in that same beat
    (`message-dispatcher.ts:1238-1243`).
  - On `turn_end`, `noteTurnBoundary → schedulePump → pumpLocked` launches the queue head, gated only by pending
    interactions and `inFlight` (`:2111-2124`).
  - The lock TTL (5 min), the same-client queue wait (5 min), the stall guard (10 min), rooms skipping a busy session,
    and Stop emptying the chat queue (`routes/sessions.ts:1580-1587`).
- `TurnLiveness.owed` has **no deadline on the warm path**. It is a plain set, filled on every `task_notification` and
  cleared only by a `system/init` after a `result` (`turn-liveness.ts:164-190`). The 30 s deadline that bounds it lives
  in the resume path's stdin close (`stdin-hold.ts:119-137`), which a warm process never runs.

## Goals

- Nothing DorkOS does on its own ends a live helper agent, Monitor, unknown task, owed delivery or running segment,
  except the five cases in §D3.
- Every model frame a warm process produces reaches the durable session stream, in a turn that is truthfully the
  agent's own, in the order the process produced it.
- A dispatched message on a fresh process is answered inside its own turn.
- The relaunch decision never happens after a turn is on screen.
- No gate holds the queue without a clock, and every hold is bounded.
- The operator can tell "DorkOS stopped this on purpose, because X" from "it crashed", and can stop any running task.
- Verified with fakes and recorded shapes only. No paid run.

## Non-Goals

- Helpers that outlive their process (research §5.2's durable hand-off primitive).
- Keeping background **shells** alive past their process.
- Changing which values are relaunch pins, or making room and direct-chat turns share a fingerprint.
- Moving a running conversation to a different Claude account (§D9).
- Reordering a person's queued chat messages behind their back.
- The resume-per-message path, Codex, OpenCode.
- Steering into a runtime turn.
- Changing what Stop does to queued chat messages (it returns them to the composer, as today).
- An MCP or agent-facing read of another session's background work.

## Technical Dependencies

- `@anthropic-ai/claude-agent-sdk` at the pinned version (0.3.268): `background_tasks_changed`, `task_notification`,
  `user_message_uuid(s)`, `queued_turn_count`, the task-stop control.
- Existing seams: `TurnLiveness`; `holdForContinuation`; `feedProjector`; `noteTurnBoundary`, `schedulePump`,
  `pumpLocked`, `inFlight`, `withDispatchMutex` and the queue store; `DetachedTurnLifecycle`, `withStallGuard`;
  `SessionLockManager`; `checkSessionHealth`; `applyClaudeAccountChange` (`account-switch.ts:91`) and the account
  resolution in `launch-resolver.ts:276-285`; `QueuedMessageSchema` (`schemas.ts:759-772`); the room runner and notice
  log; turn limits (ADRs `260823-000217`, `260823-000218`).

## Detailed Design

### D1. Quiet: one predicate, owned by the pump

`SessionPump.quietness(): Quietness` (`sessions/session-pump.ts`), **synchronous**:

```ts
/** Why a process may not be relaunched, reaped or evicted right now, or that it may. */
type Quietness =
  | { quiet: true; shells: number; lastFrameAt: number }
  | {
      quiet: false;
      because:
        | 'turn-open'
        | 'runtime-turn-open'
        | 'background-work'
        | 'delivery-owed'
        | 'waiting-on-person';
      holding: { agents: number; other: number };
      shells: number;
      busySince: number;
    };
```

- `background-work`: `TurnLiveness.liveTaskCounts(): { agents; shells; other }` from the level frame. `local_agent` →
  agents, `local_bash` → shells, every other `task_type` → other. Agents and other hold the process; shells never do.
  `liveAgentCount()` stays for the resume path's stdin hold. (Each distinct `task_type` is logged once per process —
  **shipped in slice 1**, in `persistent-dispatch.ts`, not here.)
- `delivery-owed`: `owedCount() > 0`, bounded by the **owed-delivery clock** below.
- `waiting-on-person`: `hasPendingInteraction`. `turn-open`: pump `running`. `runtime-turn-open`: a runtime window is open.
  **`runtime-turn-open`, and the `hasRuntimeTurnOpen` seam that answers it, land in slice 3a together with their
  producer.** Slice 2 ships the other four: a union member nothing can ever return is dead code, and it invites a later
  reader to "fix" the gap into a bug.

**The owed-delivery clock (new on this path).** The warm path gets its own deadline, because the resume path's lives in
a stdin close the pump never runs:

- `SessionPump` arms `OWED_DELIVERY_TIMEOUT_MS = 30_000` (the same 30 s the resume path's deferred close uses) after every
  `result` observed while `owedCount() > 0`, **and** whenever `owedCount()` goes from zero to non-zero while no segment is
  running (a notification that arrives after a turn has ended, with no delivery segment following). An armed clock is
  not re-armed by further settles.
- The clock is **cancelled** when a segment starts (`TurnLiveness.observe` reports `SEGMENT_RUNNING` after that result);
  that segment's own `system/init` clears `owed` exactly as today.
- On **expiry**, `TurnLiveness.expireOwed()` clears `owed`, logs `[SessionPump] an owed delivery never arrived; releasing
the queue` at `info` with the task ids, and fires the gate re-arm (`onDispatchGateChange`), so a held queue head launches.
- **Folded in.** When a `task_notification` arrives while a window (dispatched or runtime) is open, the CLI may fold the
  delivery into that running segment instead of opening a new one. At that window's closing `result`, if
  `user_message_uuids` names an id DorkOS never sent (the CLI consumed a prompt of its own), the settles that arrived
  inside the window are cleared from `owed` at once. The frame that proves a fold is LIVE-VERIFY; the 30 s clock is the
  guarantee and the fold check only shortens the wait. Both paths are logged.

**Implementer notes (owed deliveries and commit retries).**

- The fold check clears **one settle per unsent `user_message_uuid`** on the closing `result`, oldest settle first, never
  every settle that arrived inside the window. Settles left over keep their clock.
- A delivery segment that starts **after** `expireOwed()` has fired is logged at `info`
  (`[SessionPump] a delivery arrived after its clock expired`) with how long after expiry it began, so the 30 s bound is
  measured in real sessions rather than assumed.
- A `retryAfterMs` answer from `commitDispatch` schedules one pump retry per session; a newer answer **replaces** the
  pending timer, never stacks a second one.

**Busy spell and ceiling.** `busySince` is set on leaving quiet and cleared after **60 s of continuous quiet**
(`SESSIONS.BACKGROUND_QUIET_RESET_MS`). `SESSIONS.BACKGROUND_WORK_PARK_CEILING_MS = 4 h` bounds a spell, as
`INTERACTION_PARK_CEILING_MS` bounds a person-wait (`constants.ts:308`).

**The reset needs no polling, because the elapsed quiet run is judged BEFORE the new observation is folded in.** A
purely lazy check — "am I quiet, and has it been 60 s" evaluated only when somebody asks — would keep the old spell
alive for a process that goes quiet, is asked about by nobody for an hour, and then starts a fresh helper: no
evaluation ever landed inside the quiet minute, so nothing cleared `busySince`. Each evaluation therefore first asks
whether the quiet run that has already elapsed reached the reset, and only then records the current observation. The
pump evaluates at every frame and at every state change as well, so the 60 s are noticed without any consumer polling.

**Consumers, and what bounds each.**

| Consumer                                    | Holds while                                                                    | Bounded by                                        |
| ------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------- |
| `reap()` and the warm-ceiling reclaim       | not quiet                                                                      | 4 h ceiling                                       |
| Idle (`onIdle`)                             | not quiet, or `lastFrameAt` younger than `WARM_IDLE_MS`                        | 4 h ceiling (not quiet); `WARM_IDLE_MS` (frames)  |
| Record eviction (`isHoldingBackgroundWork`) | `background-work`, `delivery-owed`, `runtime-turn-open`, or a gated row queued | 4 h ceiling                                       |
| `commitDispatch` gate (D2)                  | a replace against a process that is not quiet or not settled                   | 4 h ceiling; settle interval                      |
| `isSegmentPending` (D6)                     | `delivery-owed`                                                                | **30 s owed-delivery clock**, and the 4 h ceiling |

**`isHoldingBackgroundWork` is an optional probe PARAMETER, not a method on the store.** `SessionStore` knows nothing
about pumps, so `checkSessionHealth(lockManager, isHoldingBackgroundWork?)` takes the predicate and
`ClaudeCodeRuntime.checkSessionHealth` answers it from `pumps.peek(id)?.isHoldingBackgroundWork()`. Every other runtime
passes nothing, as does a claude-code session with no warm process, and both evict exactly as they did before.

`lastActivity` is stamped at a runtime turn's `turn_start` and `turn_end` — **in slice 3a**, which is where runtime
turns first exist. Slice 2 has nothing to stamp it from.

### D2. The relaunch decision is made before the turn starts

1. **Prepare (async, advisory).** When a row reaches the head of its session's queue, the dispatcher calls optional
   `AgentRuntime.prepareDispatch?(sessionId, messageOpts): Promise<PreparedDispatch>` **outside the dispatch mutex**. The
   claude-code runtime resolves the launch and returns a handle `sendMessage` reuses, tagged with the config generation.
   On settle it calls `schedulePump`.
2. **Commit (sync, authoritative).** Inside `pumpLocked`, after the existing gates and immediately before
   `head.launch(...)`, with no `await` between: `AgentRuntime.commitDispatch?(handle): CommitAnswer`.

```ts
type CommitAnswer =
  | { go: true }
  | { go: false; waitingOn: QueuedWaitingOn } // gated: keep the row
  | { go: false; retryAfterMs: number } // not settled yet: pump again after this
  | { go: false; reprepare: true }; // handle stale: prepare again
```

The claude-code runtime answers from `decideProcessReuse(bundle.fingerprint, handle.fingerprint)` and `quietness()`:

- `ride` or `adjust` → `go: true`.
- `replace`, not quiet → `waitingOn` (D2a).
- `replace`, quiet, but `now - lastFrameAt < COMMIT_SETTLE_MS` → `retryAfterMs` (the remainder); the dispatcher schedules
  the pump for then.
- `replace`, quiet and settled → `pump.beginRetire()` in the same tick (state `reaped`, held stdin closed); the teardown's
  awaited half finishes inside `dispatch`. `go: true`.

**`COMMIT_SETTLE_MS = 2_000`.** A tool call that spawns a helper and the level frame naming it arrive as part of the same
output burst, milliseconds apart; the trailing frames after a `result` (`tool_use_summary`, `rate_limit_event`,
`background_tasks_changed`, the post-result shapes listed at `session-event-normalizer.ts:830-840`) arrive within that
burst too. Two seconds of silence is far past any inter-frame gap inside a burst, so a process still flushing the tail of
its last segment is never read as settled. It is short against what a relaunch already costs (a cold boot and resume),
and a replace is the rare path.

**Why no gap remains.** A quiet, settled process has no open window, no running segment, no live holding task, no owed
delivery and no frame for two seconds, so it has nothing the level frame can see that could start new work except input
from DorkOS, and the commit closes that input in the same synchronous step. Work the level frame does not see is listed
under "What is not done".

**Defense in depth: `not_sent`.** If `dispatch` nevertheless meets a busy process it would have to replace, it throws
`PumpRefusedError('background-work')`, and:

- `explainRefusedDispatch` yields `session_status{terminalReason:'not_sent'}` + `done`. `'not_sent'` is added to the
  shared terminal-reason enum.
- The **server projector**, on `turn_end{terminalReason:'not_sent'}`, does not persist the turn, and the snapshot never
  includes it.
- The **dispatcher** re-inserts the row at its original position (the store keeps the removed row's position until the
  turn settles), marks it gated, and **calls `emitQueueUpdate`**, so every window sees it back.
- The **client store** removes that turn's user bubble on the live event **and when it applies the same events during
  `Last-Event-ID` replay and a snapshot build**, so a reconnect never resurrects it.
- Logged at `error`; a healthy run never takes this path.

**Implementer notes.** The only `await` in the gate is `prepareDispatch`, outside `withDispatchMutex`; commit is
synchronous and decides. A config write bumps the generation. Runtimes without warm processes implement neither port.

### D2a. Gated rows in the queue

- **Schema** (slice 4a): `QueuedMessageSchema` gains optional `waitingOn: { reason: 'background-work'; holding: { agents:
number; other: number }; pins: string[]; targetFolderName?: string; since: number; roomPassUsed: boolean }`, on every
  queue update.
- **Order is never changed**; a gated chat row **blocks the chat rows behind it** (disclosed). Edit, reorder, remove,
  **Switch now** and Stop stay available on every row.
- **Rendering:** the row shows the message with a muted line "Waiting for 2 helpers to finish before switching to the
  dorkos-cloud folder" and **Switch now** ("This stops 2 helpers.").
- **Re-arm:** `onDispatchGateChange(sessionId)` on quiet, on the ceiling, on the owed-delivery clock, on Switch now and on a
  stopping account change; the dispatcher calls `schedulePump`.
- **Switch now:** `POST /api/sessions/:id/process/switch` (owner only) → `switchWhenReady?(sessionId)`: the next commit
  treats the process as quiet and settled; the replace stops its holding tasks.
- **Rooms may pass a gated row once per gated wait** (D7): the first time a riding room trigger runs ahead of it,
  `roomPassUsed` becomes true; any later room trigger waits behind the gated row until it has run or been removed. So a
  busy room can delay a person's message by at most one room turn.

### D3. What ends live work (the complete list)

| Case                                                      | Stops             | Operator sees                                                 |
| --------------------------------------------------------- | ----------------- | ------------------------------------------------------------- |
| Operator stops a task                                     | that task         | the task settles `stopped` (today)                            |
| Operator chooses **Switch now**                           | all holding tasks | "switched" line in the turn that follows                      |
| The session's own account credentials stop matching (§D9) | everything        | account line                                                  |
| Background-work ceiling (4 h)                             | all tasks         | tasks retired `stopped` with a summary; line in the next turn |
| Server shutdown                                           | everything        | **nothing new**                                               |

Shells end whenever their process ends and are retired `stopped`. Record eviction and the idle reaper never end helper
agents, Monitors, unknown tasks or owed deliveries.

### D4. What the operator sees

Plain words (`writing-for-humans`), from `sessions/process-change-copy.ts` (new). Never "process", "restart" or "relaunch".

| Pin                    | Phrase                               |
| ---------------------- | ------------------------------------ |
| `cwd`                  | "work in the `<folder name>` folder" |
| `agentIdentity`        | "answer as a different agent"        |
| `systemPromptAppend`   | "pick up its new instructions"       |
| any other relaunch pin | "use its new settings"               |

- **Gated row:** "Waiting for 2 helpers to finish before switching to work in the dorkos-cloud folder." **Switch now**.
- **Switched now:** "Switched. 2 helpers were stopped."
- **Account (§D9):** "This chat's Claude sign-in changed, so DorkOS stopped the agent and 2 helpers that were using it."
- **Shells ended with a switch:** "1 background command was stopped when your agent switched."
- **Ceiling:** task summary "Stopped by DorkOS after 4 hours in the background."; next turn: "DorkOS stopped 2 helpers that
  had been running for 4 hours."
- **Not sent:** the message returns to the queue; no line.
- **Rooms** get only the D7 notices, which name no folder, instructions, account or task.
- **The crash notice is reserved for crashes.**

### D5. A dispatched window does not close before its answer

In `SessionTurnWindows.onResult` (`session-turn-windows.ts:1245-1275`): a `result` that would close a **dispatched** window
that has carried **zero content frames** defers through `holdForContinuation` with outlook `'empty-close'`: clock
`CONTINUATION_GRACE_MS`, extended by any frame to `EMPTY_CLOSE_CONTINUATION_CAP_MS = 30_000` (the incident's gap was
12.5 s). A frame that `beginsATurn` stops the clock and the window closes on the next `result`. Expiry closes on the held
`result` as today; an abort or error result never defers. The zero-content close logs `readTurnProvenance` at `warn`.
Stands alone.

### D6. Runtime activity is its own turn, in order

**Windowing:** with no window open, a `SEGMENT_RUNNING` frame opens a runtime window at once (the hold is flushed into it).
Bookkeeping frames are held as today. A runtime window closes on the next `result`. `drainUnprojected` is deleted.

**Channel size.** A runtime window's channel is **not capped**, so nothing is dropped while the runtime turn waits for the
previous holder's lock release. It carries a byte-size tripwire: when the buffered, not-yet-consumed frames exceed
`RUNTIME_WINDOW_BUFFER_WARN_BYTES = 8 MiB` (estimated from each frame's serialized length when pushed), it logs `error`
once per window with the session, frame count and byte estimate. It never drops. A healthy run never trips it: the buffer
exists only for the milliseconds between a `turn_end` and the next lock acquire.

**Port.** Optional `AgentRuntime.onRuntimeTurn?(listener: (sessionId, events) => void)`, mapped through `streamTurnWindow`
without the empty-turn guard.

**The queue pump sees runtime turns.**

- At runtime window **open**, the subscriber (`services/session/runtime-turn.ts`, new) registers the session in `inFlight`
  (`noteRuntimeTurnOpen`), synchronously from `onWindowOpen`; at `turn_end` it unregisters and calls `noteTurnBoundary`.
- **Pending segment:** `pumpLocked` also returns while `AgentRuntime.isSegmentPending?(sessionId)` is true. The claude-code
  runtime answers it from `quietness().because === 'delivery-owed'`, which is **bounded by the 30 s owed-delivery clock**
  (D1) and cleared early when a fold is detected. When the clock expires the re-arm launches the head.
- `SessionTurnWindows.dispatch` refuses to write stdin while a runtime window is open, as a last guard.

**Lock protocol.**

1. **Runtime window opens.** The subscriber acquires `SessionLockManager.acquireRuntimeLock(sessionKey)` (holder
   `runtime:<sessionKey>`) as soon as the previous holder releases, with a `DetachedTurnLifecycle` touched only by the
   segment's frames, and drives `feedProjector` with `origin: 'runtime'`.
2. **A dispatch arriving during a runtime turn** is held by `inFlight` (chat) or goes to the room slot (rooms).
3. **Frames while a dispatched window is open** belong to that turn, as today. **Disclosed limit:** a helper that finishes
   while a person's turn is running is folded into that turn by the CLI; T11 covers only segments that start after a `result`.
4. **A gated wait** opens no turn and holds no lock, so a helper wake-up during it is rule 1.
5. **Stall guard** applies unchanged (10 min). **Implementer note:** a silent runtime turn's lock expires at `LOCK_TTL_MS`
   (5 min) before the stall guard fires; queued work still waits on `inFlight`, but a caller that bypasses the dispatcher
   can take the lock and wait on the hung window, as today.
6. **Stop** interrupts a runtime turn and returns queued chat messages to the composer.
7. **Seq, replay, client, phone:** through the projector (monotonic `seq`, replay, persistence); appended without counting a
   user turn; push only when it produced content and the session is not focused.
8. **Reserved holder:** `SessionLockManager.acquireLock` rejects any `runtime:` client id from every caller.

### D7. Rooms: a room-owned pending slot

Room triggers never enter the chat queue.

- **`RoomPendingTriggers`** (`services/rooms/room-pending-triggers.ts`, new): one slot per (session, room). A trigger enters
  it when it meets an agent-owned reason not to run: a runtime turn, a pending segment, or a gated relaunch for its own
  fingerprint. A lock held by the operator's own live user turn is still refused and skipped, as today.
- **Passing a gated chat row, once.** When the chat head is gated, its `roomPassUsed` is false, and the room trigger's own
  commit answers `go: true` (it rides or adjusts the current process), the slot runs ahead of the gated row and sets
  `roomPassUsed`. After that, room triggers wait behind the gated row. Chat rows never reorder among themselves.
- **Otherwise runs** when the session is free and the chat queue is empty.
- **Coalescing:** a human-authored trigger is never replaced; an agent-authored one is replaced only by a later trigger that
  passes the dials at that moment. Dials are re-checked when the slot runs.
- **Notices:** first fill: "`<agent name>` is finishing some background work and will answer when it's free." Ending
  unanswered (ceiling, eviction, session gone, dial refusal): one follow-up, "`<agent name>` couldn't get to this. Mention
  them again if it still needs an answer."
- **Restart:** the "will answer" notice is written to the notice log as `pending_background` with the trigger's entry id; on
  boot, any with no later answer and no follow-up gets the follow-up once. The slot itself is not restored.
- **Stop** never reads or clears the slot.

### D8. Background work is visible and stoppable (FB-18)

- `BackgroundTaskTypeSchema` becomes `['agent', 'bash', 'other']`; `background_task_started` gains optional
  `runtimeTaskType`; the mapper maps unknown types to `'other'`. **Until slice 6, Monitors and unknown tasks show as
  background commands, as today.**
- Snapshot `runningSubagents` list beside `runningSubagentCount`; terminal updates with no turn open are applied.
- The strip takes running membership from the session-level set; `'other'` rows show their label and a stop button;
  `SubagentsItem` and `SessionInspector` read the same list.

### D9. Account changes: a running conversation keeps its account

A started session's account is `session.accountRoot`; the launch ladder runs only for a session that has none
(`launch-resolver.ts:276-285`, spec `claude-code-accounts` D3). **Switching the default account never moves or stops a
running conversation**, by design.

`applyClaudeAccountChange` (`account-switch.ts:91`, run on any change to `defaultAccount` or `accounts`) gains a fourth step,
`stopStaleAccountProcesses()`: re-resolve each warm session's account and credential pins and stop the process **only where
they differ** from what it launched with (helpers included), retire its tasks, queue the account line, fire the re-arm.

| Config change                                                       | Stops a running session's process?                              | Test |
| ------------------------------------------------------------------- | --------------------------------------------------------------- | ---- |
| Default account switched                                            | No (guard)                                                      | T27b |
| The session's own account's credentials changed under the same root | Yes                                                             | T27a |
| The session's own account removed from `accounts`                   | Only if the resolved pins move; slice 4b pins the actual answer | T27c |
| An unrelated account added or removed                               | No (guard)                                                      | T27d |

Runtime turns check the same pins before projecting (T28). Credential changes made outside DorkOS are out of scope.

## User Experience

- An agent that finishes its reply while helpers run keeps showing them; a helper's wake-up appears as a new turn, before
  any message queued after it.
- A message that needs the agent to switch folders or instructions while helpers run stays queued with a waiting line and
  **Switch now**; messages behind it wait too and can be reordered ahead of it; a busy room can slip in at most once.
- Changing the default Claude account does not disturb a running chat. If a chat's own sign-in changes, its agent stops right
  away and says how many helpers stopped.
- A room mention during background work is answered late after one short notice, or gets one short follow-up, even across a
  restart.
- "Claude Code stopped unexpectedly" appears only for a real failure.

## Testing Strategy

No test may spend money or read `ANTHROPIC_API_KEY`, `DORKOS_EVALS_*` or any flag in the AGENTS.md money table. Dispatcher
tests use the **real** `feedProjector`, queue store and `pumpLocked`. The fake CLI gains level frames of any `task_type`,
`task_notification` (between turns and mid-turn), unsolicited segments, early zero-content results, task-stop answers, a
hung segment and a `result` whose `user_message_uuids` names an id DorkOS never sent. `FakeAgentRuntime` gains
`prepareDispatch`, `commitDispatch`, `onDispatchGateChange`, `switchWhenReady`, `isSegmentPending` and `onRuntimeTurn`.

### Must fail on today's code

"Guard" rows pass today and pin behavior that must not break. Rows marked "mutation" guard a gate this spec adds: they are
shown to fail against the slice's build with that gate's bound removed.

| #    | Test                                                                                                                                                                                                                                                                                                                                   | File                                                                     | Slice   | Fails because                                      |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ------- | -------------------------------------------------- |
| T1   | Early zero-content close waits; answer lands in the dispatched window; no empty-turn error                                                                                                                                                                                                                                             | `session-turn-windows.test.ts`, `pump-turn-stream-*.test.ts`             | 1       | closes at once                                     |
| T2   | A genuinely empty turn still errors after the 30 s cap                                                                                                                                                                                                                                                                                 | `session-turn-windows.test.ts`                                           | 1       | guard                                              |
| T3   | `reap` declines for agent, Monitor-typed, unknown type, owed delivery; proceeds with only shells                                                                                                                                                                                                                                       | `session-pump.test.ts`                                                   | 2       | only agents decline                                |
| T4   | Idle timer re-arms while frames flow with no window                                                                                                                                                                                                                                                                                    | `session-pump-registry.test.ts`                                          | 2       | ignores frames                                     |
| T5   | Record eviction skips a session holding a helper past 30 min; evicts past the ceiling                                                                                                                                                                                                                                                  | `session-store-eviction.test.ts`                                         | 2       | person-waits only                                  |
| T6   | 30 s quiet does not reset the ceiling clock; 60 s does                                                                                                                                                                                                                                                                                 | `session-pump.test.ts`                                                   | 2       | no ceiling                                         |
| T7   | 12 helper-pinned sessions → 13th refused; shells-only reclaimed. **A guard row, and it only discriminates when the twelve are pinned by a Monitor-typed (or unknown) task** — pin them with `local_agent` and it passes on today's code too, because the old rule already counted subagents                                            | `session-pump-registry.test.ts`                                          | 2       | guard                                              |
| T35  | Owed-delivery clock: `task_notification`, `result`, no segment → `owed` expires at 30 s, logged, re-arm fired; a segment starting inside 30 s cancels it and its `system/init` clears `owed`; a further settle does not re-arm an armed clock; a delivery segment starting after expiry is logged with its lateness                    | `session-pump.test.ts`, `turn-liveness.test.ts`                          | 2       | `owed` never expires                               |
| T38  | **Notification while idle:** no turn open, a `task_notification` arrives (owed 0 → 1), no segment follows; a chat row is queued → the clock arms on the transition and the head launches within 30 s (fake timers), never later                                                                                                        | `session-pump.test.ts`, `message-dispatcher.test.ts` (real `pumpLocked`) | 3a      | mutation: head never launches without the idle arm |
| T8   | Unsolicited segment opens a runtime window at its first model frame                                                                                                                                                                                                                                                                    | `session-turn-windows.test.ts`                                           | 3a      | opens at `result`                                  |
| T9   | Runtime turn: `turn_start{origin:'runtime'}` … `turn_end`, persisted, `lastActivity`, `noteTurnBoundary`                                                                                                                                                                                                                               | `runtime-turn.test.ts`                                                   | 3a      | drained                                            |
| T10  | Dispatch during an open runtime window writes no stdin until it closes                                                                                                                                                                                                                                                                 | `runtime-turn.test.ts`                                                   | 3a      | dropped                                            |
| T11  | A segment after a dispatched `result` is its own turn; the person's turn holds none of its frames                                                                                                                                                                                                                                      | `runtime-turn.test.ts`                                                   | 3a      | drained                                            |
| T12  | Silent runtime turn interrupted at `TURN_STALL_TIMEOUT_MS`                                                                                                                                                                                                                                                                             | `runtime-turn.test.ts`                                                   | 3a      | no runtime turn                                    |
| T13  | Stop on a runtime turn interrupts it, returns queued chat, helpers keep running                                                                                                                                                                                                                                                        | `runtime-turn.test.ts`                                                   | 3a      | no runtime turn                                    |
| T14  | `acquireLock` rejects `runtime:` ids from any caller                                                                                                                                                                                                                                                                                   | `session-lock.test.ts`                                                   | 3a      | no guard                                           |
| T31  | Ordering: chat row queued; `result`, `task_notification`, notification segment. Head waits; no drop; runtime turn then person's turn                                                                                                                                                                                                   | `message-dispatcher.test.ts`, `runtime-turn.test.ts`                     | 3a      | head launches; segment dropped                     |
| T34  | **Folded notification does not wedge the queue:** `task_notification` arrives inside a running dispatched turn, the CLI folds it (no later `system/init`), the turn ends, a chat row is queued. (a) With a fold-proving `result`, the head launches at once. (b) Without one, the head launches within 30 s (fake timers), never later | `message-dispatcher.test.ts` (real `pumpLocked`), `session-pump.test.ts` | 3a      | mutation: head never launches without the clock    |
| T36  | Runtime channel over 8 MiB logs one `error` and drops nothing                                                                                                                                                                                                                                                                          | `session-turn-windows.test.ts`                                           | 3a      | no tripwire                                        |
| T15  | Room trigger during a runtime turn enters the slot, one notice, runs after `turn_end`                                                                                                                                                                                                                                                  | `room-pending-triggers.test.ts`                                          | 3b      | skipped `busy`                                     |
| T16  | Stop leaves the room slot intact                                                                                                                                                                                                                                                                                                       | `room-pending-triggers.test.ts`                                          | 3b      | no slot                                            |
| T17  | Coalescing keeps the earliest human; agent replaced only by a dial-passing trigger                                                                                                                                                                                                                                                     | `room-pending-triggers.test.ts`                                          | 3b      | no slot                                            |
| T18  | Slot ending unanswered (dial, eviction; ceiling in 4a) posts one follow-up                                                                                                                                                                                                                                                             | `room-pending-triggers.test.ts`                                          | 3b / 4a | silent                                             |
| T19  | Operator's own user turn still skips a room trigger                                                                                                                                                                                                                                                                                    | `room-turn-runner.test.ts`                                               | 3b      | guard                                              |
| T32  | Restart: unanswered `pending_background` notice gets one follow-up on boot; answered gets none                                                                                                                                                                                                                                         | `room-pending-triggers.test.ts`                                          | 3b      | no sweep                                           |
| T20  | Gated row: commit `waitingOn`; row stays with `waitingOn`; no lock, no `turn_start`; rows behind wait; re-arm dispatches it                                                                                                                                                                                                            | `message-dispatcher.test.ts`                                             | 4a      | replaces at once                                   |
| T21  | Commit precedes `turn_start`: a quiet, settled process is retired in the commit tick; pump `reaped` and stdin closed before `feedProjector` ingests `turn_start`; a later level frame cannot start work                                                                                                                                | `message-dispatcher.test.ts`, `persistent-dispatch.test.ts`              | 4a      | no commit                                          |
| T37  | **Settle interval:** a quiet process whose last frame is 500 ms old commits `retryAfterMs ≈ 1500`; nothing is retired; the pump retries and a helper level frame arriving meanwhile turns the answer into `waitingOn`                                                                                                                  | `message-dispatcher.test.ts`, `persistent-dispatch.test.ts`              | 4a      | no settle                                          |
| T21b | `not_sent`: dispatch meets a busy process after `turn_start`; turn settles `not_sent` and is not persisted; row back at its position with `waitingOn` and a queue update to a second window; the bubble is gone live, **after a reconnect with `Last-Event-ID` replay, and in a fresh snapshot**                                       | `message-dispatcher.test.ts`, projector test, client store test          | 4a      | replaces                                           |
| T21c | Stale handle → `reprepare`, no launch                                                                                                                                                                                                                                                                                                  | `message-dispatcher.test.ts`                                             | 4a      | no handle                                          |
| T22  | Helper wake-up during a gated wait is its own runtime turn; the queued message's turn has none of its frames                                                                                                                                                                                                                           | `runtime-turn.test.ts`                                                   | 4a      | no gate                                            |
| T23  | Stop during a gated wait returns the gated message to the composer and stops no task                                                                                                                                                                                                                                                   | route test                                                               | 4a      | no gate                                            |
| T24  | Switch now: next commit `go`, holding tasks stopped, switched line                                                                                                                                                                                                                                                                     | `persistent-dispatch.test.ts`, route test                                | 4a      | no action                                          |
| T25  | Eviction skips a session with a gated row; a ceiling stop during a gated wait re-arms and launches fresh                                                                                                                                                                                                                               | `session-store-eviction.test.ts`                                         | 4a      | no gate                                            |
| T26  | A room trigger needing the same relaunch waits in the slot; one that rides runs ahead of the gated chat row                                                                                                                                                                                                                            | `room-pending-triggers.test.ts`, `message-dispatcher.test.ts`            | 4a      | skipped                                            |
| T26b | **Room passes once:** a second riding room trigger during the same gated wait waits behind the gated row; after the gated row runs, the pass resets for the next gated wait                                                                                                                                                            | `room-pending-triggers.test.ts`, `message-dispatcher.test.ts`            | 4a      | no limit                                           |
| T33  | `waitingOn` survives a reload and reaches a second window; the row renders the line and Switch now                                                                                                                                                                                                                                     | schema test, client RTL                                                  | 4a      | no field                                           |
| T27a | The session's own account's credential env changes → process stopped, tasks retired, re-arm, account line                                                                                                                                                                                                                              | `account-switch.test.ts`                                                 | 4b      | nothing happens                                    |
| T27b | Default account switched → running session untouched                                                                                                                                                                                                                                                                                   | `account-switch.test.ts`                                                 | 4b      | guard                                              |
| T27c | Session's own account removed → pins the resolver's actual answer                                                                                                                                                                                                                                                                      | `account-switch.test.ts`                                                 | 4b      | pins behavior                                      |
| T27d | Unrelated account added/removed → untouched                                                                                                                                                                                                                                                                                            | `account-switch.test.ts`                                                 | 4b      | guard                                              |
| T28  | Runtime window on a process with a stale account pin is not projected; process stopped                                                                                                                                                                                                                                                 | `runtime-turn.test.ts`                                                   | 4b      | no check                                           |
| T29  | Ceiling stop retires tasks `stopped` with no turn open; next turn carries the line                                                                                                                                                                                                                                                     | `session-pump-registry.test.ts`, projector test                          | 5       | silent                                             |
| T30  | Strip keeps a helper through `turn_end` and a reload; shows and stops `'other'`                                                                                                                                                                                                                                                        | client RTL                                                               | 6       | strip empties                                      |

**Conformance:** optional-capability cases for `onRuntimeTurn`, `prepareDispatch`/`commitDispatch` (commit synchronous,
never throws) and `isSegmentPending` (never true forever: a driver asserts it goes false within its declared bound).

## Performance Considerations

- `lastFrameAt` is one assignment per frame; `quietness()` and `commitDispatch` are synchronous reads.
- `prepareDispatch` resolves the launch once per queue head; `sendMessage` reuses it.
- A replace waits at most `COMMIT_SETTLE_MS` extra after the last frame.
- The owed-delivery clock can hold the queue head up to 30 s when a delivery never arrives.
- Pinned processes hold warm slots up to the ceiling; shells do not. A gated head blocks the rows behind it.

## Security Considerations

- **Accounts:** a running conversation stays on the account that paid for it; a default-account switch never moves it. A
  change to that same account's credentials stops its process at the configuration change; runtime turns refuse a stale pin.
  `AccountPinViolationError` is unchanged.
- The boundary check still runs before any dispatch.
- Switch now is owner-only. Room notices name no folder, account, instructions or task; `waitingOn` is on the owner-only
  queue.
- The `runtime:` lock holder is refused inside `SessionLockManager.acquireLock` for every caller.

## Documentation

- ADR `260915-202228` (amends `260812-134510`).
- Module docs rewritten where they state retired rules: `persistent-dispatch.ts`, `session-turn-windows.ts`,
  `session-pump.ts` (owed-delivery clock, settle, `beginRetire`), `turn-liveness.ts` (`expireOwed`, the warm path has its own
  deadline), `session-pump-registry.ts`, `session-store.ts`, `room-turn-runner.ts`, `session-lock.ts`,
  `message-dispatcher.ts`, `account-switch.ts`.
- `contributing/adding-a-runtime.md`: the optional ports and their required bounds, the quiet predicate, D3.
- Changelog fragments on every slice.

## Implementation Phases

Each slice is one PR; each slice's tests depend only on earlier slices. Slices land in order 1, 2, 3a, 3b, 4a, 4b, 5;
slice 6 any time after slice 2. Between 3a and 3b a room trigger during a runtime turn is skipped with the existing visible
busy notice (DOR-621), which is today's behavior.

| #   | Slice                                                                                                                                                                        | Size | Touches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Tests                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 1   | **Empty turn waits for its answer, plus logging.** D5.                                                                                                                       | S    | `session-turn-windows.ts`, `persistent-dispatch.ts`, fake CLI, tests                                                                                                                                                                                                                                                                                                                                                                                                                                                    | T1–T2                                              |
| 2   | **Quiet predicate; reap, idle, warm ceiling, eviction; ceiling; owed-delivery clock.** D1.                                                                                   | M    | `turn-liveness.ts`, `session-pump.ts`, `session-pump-contract.ts`, `session-pump-registry.ts`, `session-store.ts`, `claude-code-runtime.ts`, `constants.ts`, tests                                                                                                                                                                                                                                                                                                                                                      | T3–T7, T35                                         |
| 3a  | **Runtime turns: early windows, projection, channel tripwire, lock protocol, `inFlight`, pending-segment gate with fold detection, stall guard, Stop, reserved holder.** D6. | M    | `session-turn-windows.ts`, `session-pump.ts`, `persistent-dispatch.ts`, `pump-turn-stream.ts`, `claude-code-runtime.ts`, `packages/shared/src/agent-runtime.ts` (`onRuntimeTurn?`, `isSegmentPending?`), `services/session/runtime-turn.ts` (new), `session-lock.ts`, `message-dispatcher.ts`, composition root, `fake-agent-runtime.ts`, `runtime-conformance.ts`, tests                                                                                                                                               | T8–T14, T31, T34, T36, T38                         |
| 3b  | **Room pending slot, notices, boot follow-up.** D7 (runtime-turn reasons).                                                                                                   | M    | `room-pending-triggers.ts` (new), `room-turn-runner.ts`, `rooms/notices/`, boot wiring, tests                                                                                                                                                                                                                                                                                                                                                                                                                           | T15–T19, T32                                       |
| 4a  | **Prepare/commit gate with settle interval, gated rows, room pass-once, Switch now, `not_sent`, client queue and store.** D2, D2a, D4 copy, D7 (gated reasons).              | L    | `message-dispatcher.ts`, queue store, `packages/shared/src/schemas.ts` (`waitingOn`, `'not_sent'`), `agent-runtime.ts` (`prepareDispatch?`, `commitDispatch?`, `onDispatchGateChange?`, `switchWhenReady?`), `persistent-dispatch.ts`, `session-pump.ts` (`beginRetire`), `pump-launch.ts`, `launch-fingerprint.ts`, `process-change-copy.ts` (new), `claude-code-runtime.ts`, `session-state-projector.ts` (`not_sent`), `routes/sessions.ts`, `room-pending-triggers.ts`, client queue panel and session store, tests | T18 (ceiling), T20–T26, T26b, T21b, T21c, T33, T37 |
| 4b  | **Account step.** D9.                                                                                                                                                        | S    | `account-switch.ts`, `claude-code-runtime.ts`, `runtime-turn.ts` (pin check), `process-change-copy.ts`, tests                                                                                                                                                                                                                                                                                                                                                                                                           | T27a–d, T28                                        |
| 5   | **Stopped-on-purpose lines.** D3/D4.                                                                                                                                         | S    | `session-pump-registry.ts`, `persistent-dispatch.ts`, `process-change-copy.ts`, `session-state-projector.ts`, tests                                                                                                                                                                                                                                                                                                                                                                                                     | T29                                                |
| 6   | **Running list, `'other'`, strip (FB-18).** D8.                                                                                                                              | M    | `schemas.ts`, `session-stream.ts`, `system-event-mapper.ts`, `session-state-projector.ts`, client store, `use-background-tasks.ts`, `BackgroundTaskBar`, `SessionComposer.tsx`, `SubagentsItem.tsx`, `SessionInspector.tsx`, tests                                                                                                                                                                                                                                                                                      | T30                                                |

**What is not done when all slices land:**

- Helpers, runtime turns and room slots are lost on a server restart (room notices get their follow-up).
- **Work the level frame does not see is still ended by any replace, as today:** scheduled wake-ups the agent set for itself,
  hooks still running, and in-flight MCP server notifications. The settle interval and the quiet predicate cannot observe
  them.
- A helper-pinned session still counts against `MAX_WARM_SESSIONS`.
- A gated chat row blocks the chat rows behind it until reordered; a room may pass it once.
- A helper finishing inside a person's running turn is folded into it by the CLI.
- A room mention during the operator's own live turn is still skipped.
- Credential changes made outside DorkOS are not detected.
- The Monitor task type, the non-agent task stop and the frame that proves a folded notification are logged, not verified.

Completion needs a browser-verified ending (`/chat:self-test` with the persistent flag on, the free fake runtime where
possible). A real-CLI check is the operator's to run on their own subscription, never a CI gate.

## Open Questions

1. ~~Where is the relaunch decided?~~ (RESOLVED, rev 4) In a synchronous commit in `pumpLocked`, before `head.launch`.
2. ~~How long must a process be silent before commit may retire it?~~ (RESOLVED, rev 5) `COMMIT_SETTLE_MS = 2_000`;
   **Rationale:** past any inter-frame gap inside an output burst, short against a relaunch's own cost.
3. ~~What bounds `delivery-owed` on the warm path?~~ (RESOLVED, rev 5) Its own 30 s clock after each `result`, cancelled by a
   segment start and short-circuited by fold detection. **Rationale:** the resume path's deadline lives in a stdin close the
   pump never runs.
4. ~~How often may a room pass a gated chat row?~~ (RESOLVED, rev 5) Once per gated wait. **Rationale:** no starvation.
5. ~~Wait inside the turn or in the queue?~~ (RESOLVED, rev 3) The queue.
6. ~~Does a default-account switch stop a running session?~~ (RESOLVED, rev 4) No.
7. ~~Should background shells hold a process?~~ (RESOLVED) No.
8. ~~Does a brief quiet reset the ceiling?~~ (RESOLVED) Only 60 s of continuous quiet.
9. ~~Stall-guard or lock exemption for runtime turns?~~ (RESOLVED) No.
10. ~~Second process for the new turn? Agent-facing read?~~ (RESOLVED) No; not here.

## Related ADRs

- `260812-134510` Persistent streaming-input sessions (amended).
- `260915-202228` A warm process ends only when it is quiet, and everything it says is projected (proposed).
- `260811-184735` durable message queue; `260823-000217`, `260823-000218` room turn limits; `260814-024249` thread context.

## References

- DOR-2064, DOR-2065, FB-18; DOR-621, DOR-782, DOR-1088, DOR-1100, DOR-1104, DOR-1149, DOR-1238, DOR-1242, DOR-1294,
  DOR-1314.
- `research/20260915_room-led-multi-repo-agent-setup-lessons.md` §5.2 (unmerged branch
  `docs/research-room-led-multi-repo-setup`).
- `specs/persistent-session-runtime`, `specs/background-task-level-state`, `specs/claude-code-accounts`.
