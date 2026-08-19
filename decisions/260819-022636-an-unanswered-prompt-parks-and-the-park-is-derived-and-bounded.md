---
id: 260819-022636
title: An unanswered prompt parks instead of being refused, and the park is derived from elapsed time and bounded by a ceiling
status: proposed
created: 2026-08-18
extractedFrom: ask-parks-on-timeout
spec: ask-parks-on-timeout
superseded-by: null
---

# 260819-022636. An unanswered prompt parks instead of being refused, and the park is derived from elapsed time and bounded by a ceiling

## Status

Proposed. Extracted from `specs/ask-parks-on-timeout` (DOR-1350), which is the
approvals tier C follow-on ADR `260818-002803` named as its own known gap.

## Context

An SDK prompt an agent raises — a tool approval, a question, an MCP elicitation —
is auto-denied after ten minutes (`config/constants.ts:171`, enforced by three
`setTimeout`s in `interactive-handlers.ts` and one in `opencode/approvals.ts`).
The model is handed a refusal nobody gave, the agent carries on and guesses, and
the only surviving record is a `warn` line with `visibility: 'silent'`. In
DOR-784 two agents hit this twice each, invisibly, inside one forty-one minute
silence.

The ten minutes rested on a belief the Claude Agent SDK contradicts in its own
types: `sdk.d.ts:196-205` states that an unanswered permission prompt leaves the
tool "blocked indefinitely — permission prompts have no park deadline", and
`Query.reinitialize()` redelivers "control requests the loop is still blocked on"
after a transport gap. The deadline is entirely DorkOS's.

Three DorkOS bounds are not indefinite, and each would become immortal under an
unbounded hold: `hasPendingInteractions` bounds a pending entry precisely so a
stranded one cannot freeze the stall watchdog and the session write-lock
(DOR-782); a session record is evicted at thirty minutes; and a session parked on
a person declines every warm reap, so N parked sessions permanently shrink the
twelve-slot process ceiling and the thirteenth agent launch on the machine is
refused.

## Decision

We will make an unanswered prompt **park** rather than be refused. At
`INTERACTION_TIMEOUT_MS` the countdown ends, the agent says it is waiting, and the
`canUseTool` promise stays unresolved so the turn stays open. At a new
`SESSIONS.INTERACTION_PARK_CEILING_MS` of four hours it is finally refused, with
copy and a log line that say how long it waited. There is no suspend-and-resume:
answering resolves the decision the agent has been holding all along.

We will **derive** the parked state rather than announce it. A prompt is parked
when it has outlived the budget it declared, computed in
`listPendingInteractions` — the one selector that already decides what "still
pending" means for the wire, the stall watchdog and the write-lock. It ships as
one optional `parked` boolean on the DTO those three already share, with
`timeoutMs` dropped so no card draws a four-hour bar. No new event, no new
session-stream member, no normalizer or projector arm, and OpenCode reaches
parity from one constant.

We will exempt a session holding a live prompt from record eviction, bounded by
the same ceiling, and we will keep today's ten-minute refusal for an unattended
task run, which has nobody coming back to it.

## Consequences

### Positive

- The failure the ten minutes caused is gone: an agent whose person went to lunch
  is waiting when they return, instead of having guessed.
- The first ten minutes are untouched. The countdown, the urgency bands and the
  card a person at their desk sees are exactly as they were.
- One rule, one place. Raising the budget in the selector raises it identically
  for the fleet-wide card, the recovery snapshot, the stall watchdog and the
  write-lock, so the two answers to "what is pending" cannot fork — the property
  DOR-810 and DOR-1330 each cost once to learn.
- Every runtime that can raise a prompt parks, including OpenCode, without an
  adapter-shaped event seam that OpenCode's generator does not have.
- Nothing becomes immortal. Every widened window is still a window.

### Negative

- A parked session holds its subprocess and its MCP children for up to four hours
  instead of ten minutes, and twelve of them refuse every new agent launch on the
  machine. This is the cost that sets the ceiling, and it is why the ceiling is
  hours rather than days.
- A stranded interaction now pauses the stall watchdog for up to four hours
  rather than ten minutes. The window widens; it does not open.
- Two numbers where there was one, and a person who reads "waiting for you" as
  "forever" can still be surprised by the refusal four hours later.
- A park does not survive a server restart, because the held decision lives in a
  child process of this server. There is no way to make it durable without the
  runtime holding the loop across process boundaries.
- OpenCode parks without the "I am waiting here" transcript line claude-code
  gets, so one runtime is slightly more legible than the other. Whether the
  OpenCode sidecar expires an unanswered permission of its own accord is also
  still unverified — the adapter states the uncertainty rather than claiming a
  parity it has not earned, and one live turn settles it.
- **A relay-bound turn parks too, and its Ask reaches only the cockpit.**
  `core/unattended-autonomy` counts a binding as unattended; this decision
  deliberately does not, because a bridged agent's prompt IS listed fleet-wide
  and the person the room is talking to can answer it — which a scheduled run's
  prompt never can. The cost is that a Slack- or Telegram-bound agent can wait
  four hours while saying nothing on the surface that asked.
- **A room turn is still given up after `rooms.lateReplyCeilingMinutes`** (60 by
  default), a bound that was unreachable while every prompt settled in ten
  minutes. An Ask answered after that still runs its tool and still lands in the
  transcript; the room just gets no reply. Tying the two numbers together would
  redefine a setting somebody may already have tuned.

### Rejected alternatives

- **Park forever with a visible parked state.** The most direct sentence to say
  to a person, and it re-opens three separate "forever" states this codebase has
  removed elsewhere. The decisive one is the warm ceiling: the person refused a
  new agent launch is not the person who walked away from a prompt.
- **Suspend the turn and resume it later.** The SDK offers no re-issue primitive,
  the resumed turn would be a different conversation, and the transcript would
  carry a denial the person never gave, which is the bug being fixed.
- **Broadcast an `interaction_parked` event.** A second copy of a fact derivable
  from two numbers already on the wire, free to disagree with the first, costing a
  session-stream member, a normalizer arm, a projector arm and an injection seam
  OpenCode does not have.
