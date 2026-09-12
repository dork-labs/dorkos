# Implementation Summary: Telling auto mode what it cannot see

**Created:** 2026-09-12
**Last Updated:** 2026-09-12
**Spec:** `specs/auto-mode-classifier-context/02-specification.md`
**Tracker:** none — shipped directly from the spec.

## Progress

**Status:** Implemented — all tasks shipped, all PRs merged.

## What shipped

**PR #1817** — Claude Code is now told which of DorkOS's three safety levels a tool sits
at, and that the call already passed DorkOS's own check. Auto mode asks about things
that were already decided less often, and can still ask about anything, any time.

### The note is an assertion, not a grant

It cannot allow anything; the decision stays with Claude Code. That is why this shape is
acceptable where an auto-approval list was not — ADR `260726-171347` (DOR-519) is this
repo's record of what handing the runtime a list of tool names did last time.

There are exactly **three sentences**, one per tier, chosen by tool name from one table:
read-only, a change a person can undo, and something that cannot be undone. Three things
make that list trustworthy rather than aspirational:

- **The builder is never handed the arguments.** `classifierContextFor(toolName)` takes a
  name and nothing else, so no byte of a call's input, its output, or the conversation
  can be interpolated into a note — not by this code and not by an edit to it later. The
  moment tool output could reach one, it becomes a channel content can use to talk to the
  permission classifier.
- **The tier comes from the gate's own table** (`MCP_TOOL_TIERS`), not a hand-kept list.
  A tool cannot be described here without being gated there, and retiering a tool changes
  its sentence with no edit.
- **Permission mode and trust level are never named.** The classifier is told what the
  tool is, not who is running it.

The test writes all three strings out by hand — a copy generated from the thing it checks
cannot fail — drives every tool the gate declares through the builder, and asserts each
note equals one of them byte for byte.

### Kill switch and counter

`DORKOS_CLASSIFIER_CONTEXT` is on by default; `0`, `false`, `no` or `off` in any case
turn it off. One global switch read once at boot, no config field and nothing per-agent,
and a free string rather than a strict flag on purpose — a kill switch that refuses to
boot over the spelling of "off" is a worse kill switch. Documented in `.env.example` and
the configuration reference. Only Claude Code has the hook; Codex and OpenCode have no
way to be told and keep asking exactly as they always have, and the sessionless external
`/mcp` server gets no equivalent either.

`GET /api/debug/auto-mode-stops` counts, in one module off one clock, the approval cards
auto mode caused on a DorkOS tool (per tool and per session, counted where the card is
raised rather than where it is answered) and the notes attached, split by tier. Both in
one place so the two can honestly be divided.

## The measured need

|                                     |       |
| ----------------------------------- | ----- |
| Local transcripts scanned           | 3,617 |
| `mcp__dorkos__*` tool calls in them | 580   |
| Permission stops on those calls     | 3     |
| Stops in an auto-mode session       | **0** |
| Sessions ever seen in auto mode     | 7     |

All three stops are a person reading a card and pressing no — the kind of stop this
feature must not remove. The before-reading is zero, not "small": auto mode has barely
been used on this machine, and a transcript can only record stops that ended badly. The
runtime counter records the ask itself, which is why it is here. Written up in
`research/20260912_auto-mode-stops-on-dorkos-tools-before.md`.

## Accepted deviations from the spec

- **The approvals half of open decision 1 is cut.** The decision was answered "tier, plus
  a person's approval where one was recorded", and both were built. The tier gate records
  nothing when it _allows_ a call, so asserting "a person approved this" needed a new side
  record — and that record was keyed by tool name and an argument hash, **not by session**.
  Review found a cross-session leak: one session's genuine approval could be spent on a
  different session's identical unapproved call, and a Codex or OpenCode approval left a
  record any matching claude-code call could claim inside the TTL. A false "a person
  approved this" in front of a permission classifier is the one failure this feature must
  not have, so nothing is asserted about approval at all. The tier sentences are what
  shipped.
- **Deferred, not abandoned.** The ids for a correct version exist on both sides already —
  the gate holds `ApprovalRequestingSession.sessionId` and the hook holds its launch's
  own — so the record can be keyed by session as well as by argument hash. The full
  write-up, including the cross-runtime case that has to be tested rather than reasoned
  about, is under **Out of scope** in `01-ideation.md`.
