---
id: 260829-115623
title: ROOM.md rides a pinned system-prompt append, and lives at the repo root
status: accepted
created: 2026-08-29
spec: project-rooms
superseded-by: null
amends: null
---

# 260829-115623. ROOM.md rides a pinned system-prompt append, and lives at the repo root

## Status

Accepted. Shipped 2026-08-28 (DOR-1593), after the conformance gate the spec made a precondition.

## Context

A room needs a way to tell every agent in it how work is done here — what the room is for, what to
merge, what not to. That text has to reach every member agent's turn, be cheap enough to send on every
turn, be unmistakably labelled as coming from the room's members rather than from the person running
DorkOS, and never change under a running turn.

Three seams could have carried it. `additionalContext` is per-turn and lands after the cacheable prefix,
so every turn pays full price for text that rarely changes. `systemPromptAppend` sits in the prefix that
prompt caching is built around — the same economics as `CLAUDE.md`, read once and then roughly a tenth
of the cost per turn (ADR-0273) — but it was **not known** to re-apply on the next turn of an already
running session, and claude-code in particular may be holding a warm process. Putting the text in a file
the agent is told to read is a third option that costs a tool call and can simply not happen.

Where the file lives was its own question. `.dork/` means DorkOS-owned metadata, and this file is
member-authored content — the room's front page, the thing a file explorer should pin the way it pins a
README.

## Decision

We will keep **`ROOM.md` at the room repo's root** and deliver it on **`systemPromptAppend`**, after the
DorkOS base append, as a tagged and provenance-labelled block:

```
<dorkos_room_conventions room="…" commit="…">
```

Four properties travel with it:

- **It is read from a commit, not from the checkout.** `git show main:ROOM.md`. An uncommitted edit in
  the integration tree reaches nobody.
- **The pin is resolved once, at turn start, and held for the whole turn.** A merge that changes
  `ROOM.md` mid-answer takes effect at the next turn boundary, never under a running agent — the
  session-snapshot discipline of ADR `260711-142049`. The composed block is cached on
  `(roomId, commitSha)`.
- **Over the byte cap, the block is replaced by a notice naming the overage — never truncated.** Half a
  rule reads like a whole one, so an oversized file sends none of itself and one sentence saying where to
  read it.
- **Precedence is stated as advisory, in the block itself.** Prohibitions from any layer are honoured;
  a direct conflict with the agent's own instructions resolves to the agent's own, and the agent says so.
  Enforced precedence across three runtimes is a claim DorkOS cannot honour, and saying so is the honest
  version.

**We made the seam question a gate rather than an assumption.** `runtimeConformance` grew a case that
runs two turns on one session with two different appends and reports what the _backend_ was handed each
time — SDK launch options for claude-code, the composed prompt for codex, the synthetic prompt part for
opencode — never the string the suite passed in. All three passed, so no fallback to `additionalContext`
was needed and none was added. A runtime that can prove neither must declare
`systemPromptAppendUnprovenReason` in a sentence, rather than skipping the case.

A room with no repo gets no block at all.

## Consequences

### Positive

- Room conventions cost roughly a cache hit per turn instead of a full re-read, so a room can afford real
  instructions rather than a slogan.
- The pin makes a turn's instructions stable for its whole duration. An agent cannot be halfway through
  following one version of the rules and finish under another.
- The provenance label is the mitigation that scales: an agent reading the block knows the text came from
  the room's members, so a room can never impersonate the operator.
- Over-cap is loud. Nobody follows two thirds of a convention believing it was all of it.
- The gate turned a design assumption into a measured fact for all three runtimes, and left behind a
  conformance case that will fail if a future runtime breaks it.

### Negative

- Changing `ROOM.md` costs one prompt-cache miss per participating agent. Frequent edits are genuinely
  more expensive than infrequent ones, and nothing warns an author about that.
- A merge landing mid-turn means the agent that was running finished under yesterday's rules. That is the
  intended trade, and it is still a real inconsistency window.
- The advisory precedence is honest but unenforceable. An agent that ignores the block is not stopped by
  anything here — only the layers below the instruction layer, which stay member-owned, actually bind.
- Codex has no native system-prompt channel, so its append is folded into the prompt. The three runtimes
  agree on behaviour and not on mechanism, which is one more place they can diverge.

## Alternatives rejected

- **`additionalContext`.** Correct, and outside the cacheable prefix; the per-turn cost is paid forever
  for text that changes rarely.
- **Telling the agent to read the file.** A tool call that can be skipped, and skipping it is silent.
- **`ROOM.md` under `.dork/`.** That directory means DorkOS-owned metadata; this file is the room's
  member-authored front page.
- **Truncating an over-cap file.** The failure mode is an agent confidently following a rule that had a
  second half.
- **Assuming the seam re-applies per turn.** It was the one claim the whole design rested on, and it was
  asked before anything was built on it.

## Related

- `specs/project-rooms/02-specification.md` §3.3; ideation decisions 10, 11, 14.
- ADR-0273 — structured context injection and its cache reasoning.
- ADR `260711-142049` — the session-snapshot discipline the per-turn pin follows.
- `260829-115625` — the merge that advances the pin.
