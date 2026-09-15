---
slug: warm-process-lifecycle
number: 260915-202248
created: 2026-09-15
status: ideation
---

# A warm agent process keeps its background work

**Slug:** warm-process-lifecycle
**Author:** DOR-2064, DOR-2065 (with FB-18)
**Date:** 2026-09-15

> Every claim about existing behavior below was read off the tree at `2b638e122` (the base this branch was
> cut from). Every claim about the 2026-09-15 incident was read off `~/.dork/logs/dorkos.log` and the
> session's own JSONL transcript (`~/.claude/projects/-Users-doriancollier-Keep-dork-os-dorkos/0713ffca-….jsonl`),
> not off the ticket text. Where the two disagree, this document says so. Revised after an adversarial review
> (REVISE FIRST on `f2b89f347`); the decisions below supersede the first draft's.

---

## 1) Intent & Assumptions

**Brief.** Two tickets filed from one bad afternoon, shaped together because they are one lifecycle:

- **DOR-2064.** A queued message whose launch fingerprint differs (`cwd`, `agentIdentity`,
  `systemPromptAppend`) makes `decideProcessReuse` answer `replace`, the warm process is killed (exit 143),
  its background helpers die with it, and the operator sees "Claude Code stopped unexpectedly".
- **DOR-2065.** Model activity after a turn's `result` (background helpers finishing and waking the model) is
  dropped (`dropped a held message; no window has opened`, `dropped model output nobody could project`), and
  the process is later retired as idle. Also covers **FB-18**: running subagents vanish from the composer
  strip when the main reply ends and come back on the next message.

**Intent.** On the persistent (warm-process) claude-code path, work the agent has already started is never
thrown away by DorkOS's own bookkeeping, everything the agent says is shown, and when DorkOS does stop a
process on purpose it says so in plain words.

**Assumptions.**

- Scope is the claude-code **persistent** path (`runtimes.claudeCode.persistentSession` on, ADR 260812-134510).
  The resume-per-message path already projects post-`result` speech (DOR-1100) and holds stdin for live agents
  (DOR-1238), so it is the reference behavior, not a target.
- A session reached from both a room and direct chat will keep producing different fingerprints. That is
  legitimate (room turns run in the agent's home folder with room instructions; the operator chose another
  folder in chat) and is not the bug.
- Nothing in this work may spend real money to verify. The CLI's behavior is captured from logs and
  transcripts already on disk and replayed through fakes.

**Out of scope.** A durable hand-off primitive for helpers that outlive a session (research §5.2); unattended
permission asks (DOR-2060); Codex and OpenCode (no warm process); an agent-facing MCP read of another
session's background work (sessions are owner-only and reachable by no agent, AGENTS.md "Message search").

## 2) Pre-reading Log

- `AGENTS.md`; ADR `260812-134510` (persistent sessions, two-timer model, relaunch pin list) and its
  DOR-1309 amendment; `claude-code/NOTES.md` (pin verdicts).
- `specs/persistent-session-runtime/`, `specs/background-task-level-state/01-ideation.md`,
  `specs/ambient-background-tasks/`.
- ADRs `260823-000217` (per-agent turn counter) and `260823-000218` (room turn limits), for the room queue.
- `research/20260915_room-led-multi-repo-agent-setup-lessons.md` §5.2 — **not on `main`**; it lives on the
  unmerged branch `docs/research-room-led-multi-repo-setup`. §5.2 is about a missing durable hand-off
  primitive; its one line that applies here is "a room session ending should not kill background work the
  agent has already committed to".
- Code listed in §3. Log census for 2026-09-15 and the transcript timeline in §4.

## 3) Codebase Map

| Concern                | Where                                                                                                                                                               | What it does today                                                                                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reuse decision         | `sessions/pump-launch.ts:153-168`                                                                                                                                   | `decideProcessReuse`: pure; `replace` when a relaunch pin moved. Knows nothing about what the process is doing.                                                                                                                                                                                    |
| Replace                | `sessions/persistent-dispatch.ts:455-467`, `:1039-1042`                                                                                                             | `replaceProcess` → `registry.evict` → `pump.teardown()`, "no guards". Runs before any window opens, under the session write lock.                                                                                                                                                                  |
| Evict                  | `sessions/session-pump-registry.ts:251-258`                                                                                                                         | Unconditional teardown. Reached from `replaceProcess` **and** from record eviction (below); the registry's doc names only the first.                                                                                                                                                               |
| Record eviction        | `claude-code-runtime.ts:1653-1690`, `sessions/session-store.ts:1005-1020`                                                                                           | `checkSessionHealth` evicts a record 30 min (`SESSIONS.TIMEOUT_MS`) after `lastActivity`, which is stamped at creation and at each turn only. Exempts only `isWaitingOnPerson`. Then `pumps.evict` tears the process down unconditionally.                                                         |
| Reap                   | `sessions/session-pump.ts:451-489`                                                                                                                                  | Polite: declines when not WARM, parked on a person, or `liveness.liveAgentCount() > 0` (DOR-1238).                                                                                                                                                                                                 |
| Idle timer             | `sessions/session-pump-registry.ts:308-383`                                                                                                                         | Armed on the transition INTO `warm`, disarmed on any other transition. Output frames never touch it.                                                                                                                                                                                               |
| Liveness               | `messaging/turn-liveness.ts:140-208`                                                                                                                                | Level signal from `background_tasks_changed`; counts only `local_agent` tasks (`:26-28`: a `local_bash` shell is killed by the CLI when stdin ends); `owed` from `task_notification`; `observe` reports `SEGMENT_RUNNING` on post-result `system/init` or model frames.                            |
| Session lock           | `services/session/session-lock.ts:52-70`, `trigger-turn.ts:141-163`, `:646-667`                                                                                     | A lock expires after `LOCK_TTL_MS` (5 min, `config/constants.ts:258`) of inactivity; its only proof of life is `DetachedTurnLifecycle.lastActivityAt`, which stays fresh only while `waitingOnPerson`. `SessionTurnQueue.reserve` waits at most `LOCK_TTL_MS` for the same client's previous turn. |
| Room triggers          | `services/rooms/room-turn-runner.ts:937`, `:966-981`                                                                                                                | `whenBusy: 'refuse-foreign'`: a trigger meeting a lock held by another client is skipped with `unanswered: 'busy'` (log 15:26:54.894).                                                                                                                                                             |
| Windowing              | `sessions/session-turn-windows.ts`                                                                                                                                  | Opens on dispatch, closes on the correlated `result` (table `:56-63`). Frames outside a window are **held** (`hold`, `:1638-1647`, cap 500 `:245`); a `result` naming nothing sent opens a synthetic `origin:'runtime'` window (`:1320-1323`).                                                     |
| Runtime windows        | `sessions/persistent-dispatch.ts:107-127`, `:1000-1004`, `:1070-1106`                                                                                               | "Drained, never projected." Content-bearing drains log `dropped model output nobody could project` at ERROR.                                                                                                                                                                                       |
| Empty-turn guard       | `sessions/pump-turn-stream.ts:225-243`                                                                                                                              | A window closing with zero content events yields `emptyStreamError()`.                                                                                                                                                                                                                             |
| Failure notice         | `apps/client/.../status/TurnFailedNotice.tsx:62-67`                                                                                                                 | Renders "`<runtime>` stopped unexpectedly" for that error.                                                                                                                                                                                                                                         |
| Resume-path reopen     | `services/session/session-event-normalizer.ts:796-880`, `:1011-1030`                                                                                                | DOR-1100: model speech after `done` reopens a `turn_start{origin:'runtime'}` window **inside the same stream**. The pump path never reaches it: its generator ends with the window (`persistent-dispatch.ts:43-68`).                                                                               |
| Running children       | `services/session/session-state-projector.ts:896-906`                                                                                                               | `runningSubagents` is deliberately NOT cleared at `turn_end`; silence clock DOR-1104. Snapshot field `runningSubagentCount` (`packages/shared/src/session-stream.ts:211`) is a number only.                                                                                                        |
| Task types on the wire | `packages/shared/src/schemas.ts:1832`                                                                                                                               | `BackgroundTaskTypeSchema = z.enum(['agent', 'bash'])`. A Monitor or any other type has no representation, so the strip cannot show or stop it.                                                                                                                                                    |
| Queue advance          | `services/session/message-dispatcher.ts:2161-2169`                                                                                                                  | `noteTurnBoundary` on `turn_end` / `interaction_resolved` re-arms the next queued message.                                                                                                                                                                                                         |
| Stall guard            | `services/session/trigger-turn.ts:834-843`                                                                                                                          | 10 min (`SESSIONS.TURN_STALL_TIMEOUT_MS`, `config/constants.ts:351`); `isPaused` is only `waitingOnPerson`; on stall it calls `interruptQuery`.                                                                                                                                                    |
| Warm ceiling           | `config/constants.ts:341`, `session-pump-registry.ts:394-445`                                                                                                       | 12 processes; reclaim only reaps WARM pumps that accept the reap, else `PumpRefusedError('warm-ceiling')`.                                                                                                                                                                                         |
| Composer strip         | `widgets/session/ui/SessionComposer.tsx:504,682`, `features/chat/model/use-background-tasks.ts:9`                                                                   | Membership derived from `background_task` **message parts**; `taskType: 'agent' \| 'bash'`.                                                                                                                                                                                                        |
| History reload         | `sessions/transcript-parser.ts:801-815`; `features/chat/model/stream/stream-history-helpers.ts:128-145`                                                             | Parser rebuilds `background_task` parts only from legacy `subagent` blocks; the merge carries client-only task parts onto the positionally matched assistant message only.                                                                                                                         |
| Test doubles           | `sessions/__tests__/fake-persistent-cli.ts`, `fake-pump-query.ts`; `packages/test-utils/src/fake-agent-runtime.ts`, `runtime-conformance.ts`, `sse-test-helpers.ts` | A persistent fake CLI that correlates results by id; FakeAgentRuntime + `collectDurableEvents` for route/projector tests.                                                                                                                                                                          |

## 4) Root Cause Analysis

### 4.1 What actually happened at 15:27 (session `0713ffca`)

Log (`dorkos.log`) and transcript, interleaved:

| Time (UTC)          | Source         | Event                                                                                                                                                                           |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 15:22:53.585        | log            | Direct-chat message `1c9635af` queued behind a 15-minute room turn.                                                                                                             |
| 15:26:49            | transcript     | Room turn's last words: "All three of your asks are done, and the rest is running on its own." Background helpers are live.                                                     |
| 15:26:54.888        | log            | `window done` for the room turn (1,770 content events).                                                                                                                         |
| 15:26:54.894        | log            | A new room trigger is skipped: `the session is busy`.                                                                                                                           |
| 15:26:54.951        | log            | **63 ms later**: `replacing a warm process`, reason `cwd, agentIdentity, systemPromptAppend changed`.                                                                           |
| 15:27:02.410        | log            | Old pid 64235 exits 143 (the teardown's SIGTERM).                                                                                                                               |
| 15:27:05.227        | transcript     | New (resumed) process: the CLI queues its own `<task-notification>`: "2 background agents didn't finish", status `stopped`.                                                     |
| 15:27:05.257        | transcript     | The dispatched message `1c9635af` lands.                                                                                                                                        |
| 15:27:07.168        | log            | Dispatched window closes after 1.9 s with **zero content** → `emptyStreamError` → "Claude Code stopped unexpectedly".                                                           |
| 15:27:19 – 15:30:44 | transcript     | The real reply: "Picking this back up. The previous session ended and took two background helpers with it…", many tool calls, `SendMessage` resuming both helpers, a room post. |
| 15:27:41 – 15:30:44 | log            | 848 × `dropped a held message; no window has opened`: that whole reply streamed with no window open and overflowed the 500-frame hold.                                          |
| 15:30:48.043        | log            | The reply's `result` opens a runtime window; drained and dropped: `dropped: 501, content: 491` (500 held + the result).                                                         |
| 15:30:54.875        | log            | A room turn arrives with the room fingerprint: `replacing a warm process` again, **6.8 s after that result**, killing the helpers the agent had just resumed.                   |
| 15:31:02.151        | log            | pid 40485 exits 143.                                                                                                                                                            |
| 15:31:05 – 15:31:09 | transcript/log | Next process queues task notifications for the killed helpers; the room's window closes with zero content; room reports `turn_failed`.                                          |

The same shape occurs on session `98f5dd7c` at 15:23:19 → 15:23:30 (zero-content first window after
`relaunching after the registry reaped this session`) → 15:24:12 (`dropped: 501, content: 387`).

Day census (2026-09-15, one log file): `dropped model output nobody could project` 12, `dropped a held message`
1,181, `window closed with zero content events` 7, `declined to reap a session running background agents` 11,
`retired an idle warm process` 47, `exited badly` 9.

### 4.2 Three defects, not two

1. **Replace ignores background work (DOR-2064).** Neither replace happened mid-turn by DorkOS's definition.
   The session write lock guarantees no window is open when `dispatch` reaches `decideProcessReuse`
   (`persistent-dispatch.ts:385-393`). What was running was the CLI's background agents and CLI-initiated
   segments, which `evict → teardown` ignores even though `reap` honors live agents (`session-pump.ts:476-483`).
   So the ticket's proposal ("`replace` never fires while a window is open") would have prevented **neither**
   incident.
2. **A relaunched process's first window closes early (new; the real source of the notice).** On a fresh
   process the CLI first drains its own queued notification. A `result` arrives within ~2 s, and the dispatched
   window closes on it with zero content. The frame that closed it was not logged: a row-1 close (it named
   the dispatch) and a row-2 close (it named nothing) are both silent (`session-turn-windows.ts:1245-1275`).
   The model's actual answer to the dispatched message then runs outside any window. **"Claude Code stopped
   unexpectedly" came from the empty-turn guard (`pump-turn-stream.ts:236-243`), not from the SIGTERM**: the
   exit-143 line (`tracked-spawn.ts:90`) is a server log warning nobody sees.
3. **Unwindowed model activity is held, then dropped (DOR-2065).** A segment the CLI starts by itself (a
   notification delivery, or the early-close tail above) has no window until its `result`. Its frames go to a
   500-frame hold that overflows, and when the `result` finally opens a runtime window it is drained, not
   projected. So more than 501 frames are lost per incident: the drain count, plus every overflow drop before it.

### 4.3 Where DOR-2065's description is imprecise, and two more killers it did not name

- "The process is reaped as idle 5 minutes later **while helpers run**": for `local_agent` helpers the reaper
  already declines (11 declines that day). The two 143 exits in the 15:2x incident were **replaces**, not
  idle reaps. The idle reap can still end live work: background shells and (unverified) Monitors are not
  counted, and a CLI segment running with no live agent is invisible to the idle timer, which only listens to
  state transitions (`session-pump-registry.ts:316-321`).
- **Record eviction kills helpers too.** `checkSessionHealth` evicts a record 30 minutes after its last turn,
  and eviction tears the process down with no quiet check (`claude-code-runtime.ts:1684`). A helper still
  running 30 minutes after the last turn dies there, whatever the reaper would have said.
- **A waiting turn loses its lock.** Nothing but a person-wait keeps a session lock alive past 5 minutes, so
  any new "wait for background work" must feed the lock's proof of life, or a second dispatch takes the session.
- None of the 47 idle retirements was proven to have killed live work; that is a gap in evidence, not a clean bill.
- "848 dropped held messages" is the overflow of a bounded buffer during one out-of-window segment, not 848
  independent post-result drops.

### 4.4 FB-18 (client)

The composer strip reads membership from message parts (`use-background-tasks.ts`). The turn-end history reload
replaces the streamed assistant message with canonical history, whose parser only rebuilds task parts from
legacy blocks (`transcript-parser.ts:801-815`); the merge rescues client-only task parts only for the
positionally matched assistant (`stream-history-helpers.ts:128-145`). The server projector and the client store
both already keep the session-level running set across `turn_end` (`session-state-projector.ts:896-906`,
`session-stream-store.ts` `applyRunningSubagent`), but the strip does not read it. Reproduce in a client test
before fixing; the mechanism is read from code, not watched.

## 5) Research

- Resume-path precedent: DOR-1100 reopens a runtime window on model speech after `done`; DOR-1238 holds stdin for
  live agents; DOR-1104 retires silent children. The pump path skipped all three because its stream ends with
  the window and runtime windows are drained.
- `specs/background-task-level-state`: the level signal (`background_tasks_changed`) is the self-correcting
  source of truth for "what is running", so a missed edge cannot wedge a hold forever.
- LIVE-VERIFY (not watched, and not to be bought with a paid run): whether Monitors appear in
  `background_tasks_changed` and with what `task_type`; the exact `result` that closes a relaunched process's
  first window; whether the SDK's task stop works for a non-agent task. Each is resolved in the safe direction
  and logged so the next real session answers it.

## 6) Decisions

Resolved here (operator and orchestrator pre-authorized). Full rationale in the specification, whose sections D1–D9
match these rows one for one (spec §D2a elaborates D2).

| #   | Question                                         | Decision                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | What holds a process awake, and when is it idle? | Helper agents, Monitors and any unknown task type, owed notifications (with their own 30 s clock on this path), an open turn or runtime turn, a person-wait. **Background shells do not.** Idle means quiet and no frame for `WARM_IDLE_MS`; record eviction skips a busy session; every hold is bounded by the 4-hour ceiling or a shorter named clock.                                                  |
| D2  | When may a relaunch happen?                      | When the process is quiet and has been silent for 2 s, decided **before the turn starts**: an async prepare outside the dispatch mutex, then a synchronous commit in `pumpLocked` that either begins retiring the process in the same tick or leaves the message **queued as a gated row** (no lock, no turn, "Switch now"; rows behind it wait; a room may pass it once).                                |
| D3  | What ends live work?                             | Exactly five: the operator stopping tasks, the operator choosing "Switch now", a credential change on the session's own account, the 4-hour background-work ceiling, and server shutdown. Record eviction and the idle reaper never do. Shutdown is the only one that says nothing. Work the level frame cannot see (scheduled wake-ups, hooks, MCP notifications) still ends with any replace, as today. |
| D4  | What does the operator see?                      | A waiting line with a plain reason and the action; a plain line when DorkOS stops work, naming how many helpers and shells stopped; each stopped task retired as `stopped`. Never the crash notice.                                                                                                                                                                                                       |
| D5  | Early close on a fresh process                   | A dispatched window that would close with zero content waits for a continuation, up to 30 s while the process shows life.                                                                                                                                                                                                                                                                                 |
| D6  | Post-result model activity                       | Opens a runtime window at its first model frame and becomes its own `turn_start{origin:'runtime'}` turn under a reserved `runtime:` lock holder, with the ordinary stall guard. It registers in the queue pump's `inFlight` at window open, and an owed delivery holds the queue head for at most 30 s, so it runs before the next queued message and nothing is dropped.                                 |
| D7  | Rooms                                            | A trigger that meets a gated relaunch or a runtime turn waits in a **room-owned slot** (never the chat queue, which Stop empties), keeping the earliest human trigger, re-checked against the dials when it runs, and may run ahead of a gated chat row when it rides the current process. One notice when it waits, one follow-up if it ends unanswered, including after a restart.                      |
| D8  | Exposing background work                         | The snapshot carries the running list; the strip reads it (FB-18) and can show and stop a task of any type. No agent-facing read.                                                                                                                                                                                                                                                                         |
| D9  | Account changes                                  | A running conversation keeps its own account; a default-account switch never touches it. Only a change to that account's own resolved credentials stops its process, at the configuration change.                                                                                                                                                                                                         |
| ADR | ADR?                                             | Yes, one, amending ADR 260812-134510.                                                                                                                                                                                                                                                                                                                                                                     |

**Recommended next step:** SPECIFY (done in `02-specification.md`), then DECOMPOSE.
