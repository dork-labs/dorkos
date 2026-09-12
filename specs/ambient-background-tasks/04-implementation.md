# Implementation Summary: Housekeeping tasks stay quiet

**Created:** 2026-09-12
**Last Updated:** 2026-09-12
**Spec:** `specs/ambient-background-tasks/02-specification.md`
**Tracker:** none — shipped directly from the spec.

## Progress

**Status:** Implemented — all tasks shipped, all PRs merged.

## What shipped

**PR #1820** — the bar above the chat box shows what an agent is doing. Some of what
runs there is not work anybody asked for; it is the agent keeping itself oriented. That
used to draw the same figure in the same row as the task the person is waiting on, so
the bar was always slightly busier than the work, and people stopped reading it.

Claude Code now says which tasks are that kind of chore, and DorkOS takes them at their
word:

- **Chores no longer crowd the bar.** No running figure, no dot, no slot in the count,
  no share of the stats, and no slot in the subagent count on the status line.
- **They are still there when you look.** The bar's detail panel lists them under a line
  saying how many there are.
- **When a chore is the only thing running**, the row empties out to just the arrow that
  opens that panel: quiet, but still a way in.
- **Anything that fails still shows up like any other failure.** Hiding a broken thing
  would be a worse trade than the noise this removes.
- **A finished chore gets no "done" mark**, and the session still reads as working while
  one runs — that follows the turn in flight, not this bar.

Codex and OpenCode do not mark their tasks, so nothing changes for them: absent means
not a chore.

## The one rule, in one place

`apps/client/src/layers/shared/lib/ambient-tasks.ts` holds `isAmbientTask`, and it
resolves the whole question — including the exception, that a chore which **failed**
reads as ordinary work again. One field read by several surfaces is how a session ends
up saying one thing and the status line another, so every reader goes through it:

| Surface                                                 | Where                                               |
| ------------------------------------------------------- | --------------------------------------------------- |
| Task bar (figures, dots, count, stats, overflow, panel) | `use-background-tasks.ts` → `BackgroundTaskBar.tsx` |
| Status line's subagent count and the session inspector  | `fold-active-subagents.ts`                          |
| The session's own running count, client side            | `session-stream-store.ts`                           |
| The same count, server side (`runningSubagentCount`)    | `session-state-projector.ts`                        |

Server side the chores stay in the projector's live set, so the liveness bound and the
stranding sweep still retire them; only the count looks away, and the retirements it
synthesizes carry the mark forward.

## The store fix adversarial review caught

The first cut tested the flag on each event as it arrived. But only the **start** and the
**terminal** update carry it — a progress report does not. So a chore's progress report
pushed it _into_ the running count, while its marked ending was skipped as a chore and
never took it out: the status line sat at one child for the rest of the turn with nothing
left to retire it.

The mark is now **remembered per session** (`ambientSubagentIds`) and every branch reads
the remembered answer, never the argument. Hydration seeds it from the snapshot's own
events, and a child marked only after it was already counted is dropped from the count
rather than pinned there.

## Notes on the decisions (taken with the operator, 2026-09-12)

- Every indicator ignores chores — one rule, no operator setting; expanding the panel is
  the control.
- The hidden count appears only inside the expanded panel, never in the collapsed row.
- The five-second rule for short shell commands stays: "too fast to matter" and "a chore"
  are different questions.
- `spawn_depth` and `is_backgrounded` are read and logged at debug in the mapper and
  shown nowhere. The depth cap is 1, so `spawn_depth` is a constant.

## Follow-ups

- **`SubagentBlock` inline cards are left as a follow-up.** This change covers the task
  bar, the status line and both running counts; the inline cards inside the transcript
  still render every task the same way.
