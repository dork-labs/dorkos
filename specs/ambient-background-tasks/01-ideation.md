---
slug: ambient-background-tasks
number: 260911-191248
created: 2026-09-11
status: ideation
---

# Housekeeping tasks stay quiet

**Slug:** ambient-background-tasks
**Date:** 2026-09-11
**Source:** `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/` — filed there as a product question rather than an adoption

---

## Problem statement

While an agent works, DorkOS shows you what it is doing: a row of runners in the
session for tasks it started, a status line that says it is working, and a strip
that shows which of your agents are busy and where.

Not everything that moves deserves a mark. Some of what an agent runs is
housekeeping it does on its own behalf — work that exists to keep itself
oriented, not because you asked for anything. Today that work draws the same
figure, in the same row, with the same colour, as the task you are waiting for.
The effect is a screen that is always slightly busier than the work is, and a
person who stops reading it because it is always moving.

That is the exact failure `meta/agent-etiquette.md` was written about. Its
standard is "present, useful, and mostly quiet", and its most important finding
is that the constantly-present agent was the one people liked least. The document
is about what an agent says. The same rule applies to what it shows: an indicator
that moves for everything tells you nothing.

DorkOS already believes this in one place. The session's task bar hides a shell
command until it has been running five seconds, so a fast command never flashes
on screen (`features/chat/model/use-background-tasks.ts`). That rule was invented
by DorkOS from the outside, using duration as a stand-in for "did this matter".
The runtime can now answer the question directly.

## What the SDK now offers

Two additions, both on the background-task events DorkOS already maps:

- **`ambient`** (0.3.247) — on `task_started`, `task_notification` and
  `background_tasks_changed` entries. It marks housekeeping tasks that a host
  should **exclude from activity indicators**. Not a hint about importance in
  general; a specific statement that this one should not take up a slot on
  screen.
- **`is_backgrounded`** and **`spawn_depth`** (0.3.238) — on `task_started`, for
  subagent tasks; `is_backgrounded` also appears on background shell tasks.
  `spawn_depth` is how deeply nested the subagent is.

Changelog entries: `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/changelog.md`,
Features → "Background tasks and subagents", items 27 and 28. Impact assessment:
same directory, `impact-assessment.md`, "MEDIUM — `ambient`, `is_backgrounded`,
`spawn_depth` on task events".

Where they land. `sdk/event-mappers/system-event-mapper.ts` turns these messages
into the `background_task_started` / `_progress` / `_done` events that the rest
of DorkOS consumes. Those events are **shared across runtimes** — OpenCode maps
its own subagent parts onto the same three — so any new field is a field the
other runtimes will not set, and the interface has to read correctly when it is
absent.

One note on `spawn_depth`: DorkOS accepted the runtime's depth-1 default at the
previous upgrade, so in practice this number does not vary. A number that is
always the same is not information.

## Users

- **Ikechi** (`meta/personas/the-ai-native-founder.md`) — reads the screen as a
  whole rather than as a list of subsystems. Fewer moving marks is directly
  better for him, provided nothing he cares about disappears.
- **Kai** (`meta/personas/the-autonomous-builder.md`) — wants a calm screen by
  default and everything available when he goes looking. Hiding something from
  him permanently is worse than showing too much.
- **Priya** (`meta/personas/the-knowledge-architect.md`) — will accept omission
  and will not accept a wrong picture. The presence strip's own rule is the one
  she would apply here: omit rather than lie.

## Options

### Option 1 — Hide ambient tasks, and that is all

Drop tasks marked `ambient` from the session's task bar and from the working
status line. They never appear anywhere.

- **For:** simplest possible reading of the flag, and the quietest screen.
- **Against:** something is happening on the person's machine that no surface
  will ever show. When a housekeeping task hangs or fails, the only symptom is
  that the agent seems slow for no reason.
- **Effort:** small.

### Option 2 — Hide by default, keep them reachable

Ambient tasks do not take a runner slot, do not affect the overflow count and do
not change the working line. The task bar already expands into a detail panel;
ambient tasks live there, and the collapsed bar says how many there are only when
there are any. An ambient task that **fails** is promoted and shown like any
other failure.

- **For:** matches how this product treats omission everywhere else — quiet by
  default, complete when asked, and never silent about a failure. It also gives
  Kai the answer to "what is it actually doing" without giving Ikechi a busier
  screen.
- **Against:** more surface area than Option 1: a count, a panel section, and a
  promotion rule that has to be right. Three things to get wrong instead of one.
- **Effort:** moderate, mostly in the client.

### Option 3 — Show everything, mark ambient differently

Keep every task visible and give ambient ones a lighter treatment — dimmed,
smaller, no colour from the pool.

- **For:** nothing is hidden; the fix is purely visual.
- **Against:** does not solve the problem. The complaint is that the screen is
  always moving, and a dimmer moving thing is still a moving thing. It also
  spends the categorical colour palette on work nobody asked about.
- **Effort:** small.

## Recommendation

**Option 2**, with `spawn_depth` shown nowhere.

The deciding argument is the failure case. Hiding housekeeping is right, and
hiding a housekeeping task that broke is the same mistake as showing all of them —
a surface that does not reflect what is happening. Quiet by default with a way
back, and failures always audible, is the shape that satisfies both the etiquette
standard and the honesty filter.

`spawn_depth` should be read, logged, and shown to nobody. With the depth cap at
one it is a constant, and a number on screen that never changes is a thing people
learn to ignore — which makes every other number beside it cheaper too. If the
cap is ever raised, that decision can revisit this one.

## Open decisions

1. Does the working status line ("the agent is working") ignore ambient tasks
   too, or only the task bar?
2. When every running task is ambient, does the session look idle — and is that
   the right answer?
3. Does an ambient task that finishes get the same brief completion mark as a
   normal one, or nothing at all?
4. Is an ambient task that **fails** promoted into the ordinary view, or reported
   only where the person went looking?
5. Does the count of hidden tasks appear in the collapsed bar, or only inside the
   expanded panel?
6. Is there an operator setting for "show everything", or is expanding the panel
   the only control?
7. Codex and OpenCode will never set this flag, so their tasks all read as
   non-ambient. Is that acceptable as-is, or does each runtime owe a rule of its
   own eventually?
8. Does the five-second rule for shell commands stay once this exists, or does
   the runtime's own answer replace DorkOS's guess?

## Dependencies

- `specs/claude-agent-sdk-upgrade-0.3.268/` — the version bump, PR **#1798**. The
  fields do not exist below 0.3.247.
- `meta/agent-etiquette.md` — the standard this is measured against. If a
  mechanism here and that document disagree, the document wins or the document
  changes; it does not get ignored.

## Out of scope

- What the agent posts in a room. This is about indicators, not messages;
  etiquette's speaking rules are settled elsewhere.
- The presence strip's room claims, which come from DorkOS's own records rather
  than from runtime task events, and are not touched by this flag.
- The activity feed, which records what DorkOS did, not what a model's subagent
  did inside a turn.
- Raising or lowering the subagent depth cap.
- Stopping or managing background tasks, which already has its own control.

## Risks

- **A hidden failure is the worst outcome available here.** If the promotion rule
  for failures is wrong, this change converts visible noise into invisible
  breakage, which is a strictly worse trade.
- **`ambient` is the runtime's judgment, not ours.** If the runtime starts
  marking something as housekeeping that a person would consider real work, it
  vanishes from the screen and nothing in DorkOS will notice. Worth a way to spot
  the shift — a log line, or the panel count.
- **A quiet screen can read as a stalled one.** "Nothing is moving" and "nothing
  is happening" must not look the same, especially during a long turn whose only
  activity is ambient.
- **One field, several surfaces.** The task bar, the status line and any future
  indicator each decide separately what to do with this flag. If they do not
  agree, the session says one thing and the strip says another — which is the
  class of bug the presence strip's own module was written to avoid.
