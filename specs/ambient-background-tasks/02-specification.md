---
slug: ambient-background-tasks
id: 260911-191248
created: 2026-09-12
status: implemented
---

# Housekeeping tasks stay quiet

**Status:** Specified
**Date:** 2026-09-12
**Ideation:** `specs/ambient-background-tasks/01-ideation.md`
**Decisions taken with the operator:** 2026-09-12

## Intent

An agent's housekeeping — work it runs to keep itself oriented, not because
anybody asked — should not draw the same mark on screen as the task you are
waiting for. The runtime now marks those tasks `ambient`. DorkOS keeps them out
of every indicator, keeps them reachable in the expanded panel, and promotes any
that fail into the ordinary view. `meta/agent-etiquette.md` is the standard:
present, useful, and mostly quiet.

## Resolved design

### 1. Every indicator ignores ambient tasks — one rule

The session task bar, the working status line, and any indicator added later all
apply the same rule: an ambient task takes no slot, no colour and no count in
any collapsed surface.

_Reason:_ one field read differently by three surfaces is exactly the bug class
the presence strip's own module was written to avoid.

### 2. An all-ambient session does not look idle

"Working" is driven by the turn being in flight, not by the count of visible
tasks. A turn whose only activity is ambient still reads as working.

_Reason:_ "nothing is moving" and "nothing is happening" must not look the same.

### 3. A finished ambient task gets no completion mark

No celebration, no brief flash, nothing on completion.

_Reason:_ a mark for the end of something whose start was never shown is noise
about work nobody was tracking.

### 4. An ambient task that fails is promoted

A failed ambient task appears in the ordinary view like any other failure, with
the same treatment.

_Reason:_ hiding a broken housekeeping task converts visible noise into
invisible breakage, which is a strictly worse trade.

### 5. The hidden count shows only in the expanded panel

The collapsed bar never says how many ambient tasks are running; the expanded
panel does, and lists them.

_Reason:_ a count on the collapsed bar is a moving number, which is the thing
this change exists to remove.

### 6. No operator setting — expanding the panel is the control

There is no "show everything" toggle.

_Reason:_ the panel already answers the question, and a setting for it is an
element that could be removed without hurting anyone.

### 7. Codex and OpenCode never set the flag; absent means not ambient

The field is read as optional, and an event without it is treated as an ordinary
task. A note in the runtimes docs records that only claude-code sets it.

_Reason:_ the three background-task events are shared across runtimes, so the
interface has to read correctly when the field is absent.

### 8. The five-second rule for shell commands stays

The existing `BASH_VISIBILITY_THRESHOLD_MS` behavior is unchanged. Ambient and
"too fast to matter" are different questions and both filters apply.

_Reason:_ the runtime's flag answers "is this housekeeping", not "did this last
long enough to be worth drawing".

### 9. `spawn_depth` is read, logged, and shown nowhere

The field is carried through the mapper and written to the log. No surface
displays it.

_Reason:_ with the depth cap at one it is a constant, and a number on screen
that never changes makes every number beside it cheaper.

## Affected files

- `apps/server/src/services/runtimes/claude-code/sdk/event-mappers/system-event-mapper.ts` —
  the `task_started` / `task_progress` / `task_notification` branches (lines
  ~42–90) carry `ambient`, `is_backgrounded` and `spawn_depth` onto the
  `background_task_started` / `_progress` / `_done` events, and log
  `spawn_depth`.
- `packages/shared/src/schemas.ts` — the background-task part schemas (the event
  names at lines ~188–190) gain the three optional fields. Optional is
  load-bearing: OpenCode maps its own subagent parts onto the same three events
  and will never set them.
- `apps/client/src/layers/features/chat/model/use-background-tasks.ts` — the
  single place visibility is decided (`VisibleBackgroundTask`,
  `BASH_VISIBILITY_THRESHOLD_MS` at line ~40, the celebration set at line ~46).
  Ambient tasks are excluded from the returned list, excluded from celebrations,
  and surfaced separately as a hidden set with its own count; a failed ambient
  task rejoins the visible list.
- `apps/client/src/layers/features/chat/ui/tasks/BackgroundTaskBar.tsx` — the
  collapsed bar, which must show neither the tasks nor their count.
- `apps/client/src/layers/features/chat/ui/tasks/TaskListPanel.tsx` and
  `TaskDetailPanel.tsx` — the expanded panel, which shows the hidden count and
  lists the ambient tasks.
- The working status line, which reads the turn's in-flight state rather than
  the visible task list.

## Acceptance criteria

1. A running task marked `ambient` appears in no collapsed surface: not in the
   session task bar, not in its overflow count, not in the working status line.
2. During a turn whose only running tasks are ambient, the session still reads
   as working.
3. An ambient task that finishes normally produces no completion mark anywhere.
4. An ambient task that fails appears in the ordinary task view with the same
   treatment as any other failure.
5. Expanding the task panel shows how many ambient tasks are running and lists
   them; the collapsed bar shows neither.
6. There is no setting anywhere to show ambient tasks in the collapsed bar.
7. A background-task event with no `ambient` field is treated as an ordinary
   task, and an OpenCode subagent task renders exactly as it does today.
8. A shell command that finishes in under five seconds still never flashes on
   screen, whether or not it is ambient.
9. `spawn_depth` appears in the server log and in no rendered surface.
10. Every indicator agrees: no surface shows an ambient task while another hides
    it.

## Test plan

- **Unit, mapper:** SDK messages with and without `ambient`, `is_backgrounded`
  and `spawn_depth` map to events carrying the fields or omitting them; assert
  `spawn_depth` is logged.
- **Unit, schema:** the three fields are optional; an event without them parses.
- **Unit, `use-background-tasks`:** ambient running tasks are absent from the
  visible list and present in the hidden set with a correct count; an ambient
  task transitioning to failed moves into the visible list; a finishing ambient
  task produces no celebration.
- **Unit, five-second rule:** a fast non-ambient bash command is still hidden,
  and the two filters compose rather than replacing each other.
- **Component, `BackgroundTaskBar`:** the collapsed bar renders no ambient task
  and no ambient count.
- **Component, panel:** the expanded panel renders the count and the list.
- **Unit, working line:** an all-ambient turn still reports working.
- **Cross-runtime:** an OpenCode-shaped event set renders identically before and
  after the change.

## Out of scope

- What an agent posts in a room; this is about indicators, not messages.
- The presence strip's room claims, which come from DorkOS's own records rather
  than runtime task events.
- The activity feed, which records what DorkOS did, not what a model's subagent
  did inside a turn.
- Raising or lowering the subagent depth cap.
- Stopping or managing background tasks, which already has its own control.
- Any per-runtime ambient rule for Codex or OpenCode.

## Dependencies

- `specs/claude-agent-sdk-upgrade-0.3.268/` (PR #1798) — the fields do not exist
  below 0.3.247.
- `meta/agent-etiquette.md` — the standard this is measured against.
