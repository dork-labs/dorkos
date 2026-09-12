---
slug: auto-mode-classifier-context
id: 260911-191245
created: 2026-09-12
status: specified
---

# Telling auto mode what it cannot see

**Status:** Specified
**Date:** 2026-09-12
**Ideation:** `specs/auto-mode-classifier-context/01-ideation.md`
**Decisions taken with the operator:** 2026-09-12

## Intent

Auto mode's classifier stops the agent for calls that deserve a stop. It knows
nothing about DorkOS tools, so it stops for calls DorkOS has already checked —
and a person who is asked twice about one decision stops reading approval cards
at all. DorkOS registers a `PostToolUse` hook that attaches a short note the
classifier reads: which tier the tool carries, and, where one exists, that a
person approved this exact call.

The rule that bounds the whole design: **DorkOS may assert only facts it
established itself, and an assertion widens nothing unless the classifier
decides it does.** This is not a list of tool names. ADR `260726-171347`
(DOR-519) is the record of what a name list did here, and the standing rule
since is that a list of names is never how DorkOS makes the runtime more
permissive.

## Resolved design

### 0. Gate — build the hook with its measurement

The operator first chose "measure first", then chose to build all four specs
now. The ruling: build the hook **with** its measurement in one piece of work.
The PR counts auto-mode stops on DorkOS tools before and after and reports the
before-number in its description; the kill switch in decision 6 is what makes
the after-measurement possible.

_Reason:_ the effect of a note depends on a classifier DorkOS does not control,
so shipping without a measurement means shipping a change nobody can evaluate.

### 1. Facts asserted — tier, and a recorded approval

Two facts and no others: the tool's tier, and "a person approved this exact
call" where the gate recorded an approval. Both are read from the DorkOS gate's
own record.

_Reason:_ these are the only two things DorkOS established itself; anything else
would be an opinion about content it did not verify.

### 2. The operator's power level is never named

No note ever mentions the configured trust level.

_Reason:_ the level decides what DorkOS asks; it is not evidence about the call,
and naming it invites the classifier to treat a setting as a permission.

### 3. Every DorkOS tool, from one derived table

The notes apply to every DorkOS tool, and the fact-to-sentence table is derived
from the gate's own tier table rather than from a hand-kept list of names.

_Reason:_ a hand-kept list drifts from the gate the first time a tier changes,
and a note that is no longer true is worse than no note.

### 4. Record — a debug log line, and a test that pins every sentence

Each assertion writes one debug log line. A test pins the complete set of
sentences DorkOS is able to emit: constant strings only, with nothing
interpolated from arguments, output or conversation. No per-call UI.

_Reason:_ the security property is structural, so it has to be enforced by a
test rather than by a convention, and it has to be readable afterwards.

### 5. No equivalent on the sessionless `/mcp` path

The external `/mcp` server gets no `classifierContext`. One sentence in the MCP
docs says so.

_Reason:_ that path has no session and no hook to hang a note on, and a
difference nobody documented is a difference somebody will discover the hard
way.

### 6. Off switch — one global environment variable

A single environment variable disables the hook. No config field, not per-agent.

_Reason:_ it is a kill switch for a mechanism that talks to a classifier we do
not own, and it is the control that makes the before/after measurement
possible.

### 7. Codex and OpenCode differ, and the docs say so

Neither runtime has this hook, so their auto mode keeps stopping where it stops
today. One line in the runtimes docs table records the difference.

_Reason:_ runtime parity is not owed here, but an undocumented behavior
difference is a support question waiting to happen.

## Measurement requirement

This is a required part of the work, not a follow-up.

- **Before:** count auto-mode stops that landed on DorkOS tools over a fixed
  recent window, read from session transcripts and events. The number and the
  window go in the PR description.
- **After:** with the hook on, count the same thing over a comparable window,
  broken down by tool. The claim to make is "these specific asks stopped
  happening", never "things feel smoother".
- **The kill switch is the control arm.** The environment variable in decision 6
  is what allows the same workload to be run with the hook off and compared.
- A reduction that cannot be attributed to named tools is not evidence, and the
  measurement should say so rather than round it up.

## Affected files

- `apps/server/src/services/core/mcp-tool-gate.ts` — the chokepoint every
  hand-registered DorkOS tool passes through. It already knows the tool's tier
  (`action.tier`, line ~213) and mints the approval for a destructive call, so
  it is where the two assertable facts are recorded for the hook to read.
- `apps/server/src/services/core/mcp-tool-tiers.ts` — `gatedActionForMcpTool`,
  the single tier table the fact-to-sentence table is derived from.
- `apps/server/src/services/runtimes/claude-code/messaging/launch-resolver.ts` —
  `sdkOptions.hooks` (line ~511) registers `PreToolUse` only today. The
  `PostToolUse` hook is added here, matcher-confined to DorkOS-owned tools, and
  reads the kill-switch variable at module scope.
- `apps/server/src/services/core/capabilities/tier-enforcement.ts` — the shared
  `enforceCapabilityTier` both gate paths call; the assertion record has to be
  visible from both, not only from the hand-registered path.
- `docs/` — the MCP page gains the sentence from decision 5, and the runtimes
  table gains the line from decision 7.

## Acceptance criteria

1. A DorkOS tool call in an auto-mode session emits a `PostToolUse` note stating
   the tool's tier, drawn from the gate's tier table.
2. A DorkOS tool call that a person approved emits a note that also states a
   person approved this exact call. A call with no recorded approval never says
   so.
3. No note contains any text derived from the tool's arguments, its output, or
   the conversation. A test enumerates every sentence DorkOS can emit and fails
   if a new one appears unpinned.
4. No note names the operator's configured power level.
5. Changing a tool's tier in the tier table changes the note it produces, with
   no second edit anywhere.
6. Setting the kill-switch environment variable stops every note from being
   emitted, and the session otherwise behaves exactly as it does today.
7. Each assertion writes exactly one debug log line, and nothing appears in the
   UI.
8. A call through the external `/mcp` server produces no note, and the MCP docs
   say the path has no equivalent.
9. The runtimes docs table records that Codex and OpenCode have no such hook.
10. The PR description carries the before-count of auto-mode stops on DorkOS
    tools, its window, and the after-count.
11. DorkOS's own approval behavior is unchanged: a tool that needed approval
    before still needs it.

## Test plan

- **Unit, sentence set:** a test enumerates the complete set of emittable
  sentences and asserts each is a constant; a snapshot fails on any addition.
- **Unit, no interpolation:** call the hook with arguments and output containing
  injected instruction text; assert none of it appears in the note.
- **Unit, tier derivation:** change a tier in the table fixture and assert the
  note follows without any other edit.
- **Unit, approval fact:** a destructive call with a recorded approval asserts
  the approval sentence; the same call without one does not.
- **Unit, kill switch:** with the variable set, no hook output is produced; the
  variable is read at module scope so no other test's `vi.stubEnv` can blank it.
- **Unit, matcher confinement:** a non-DorkOS tool call produces no note.
- **Unit, unchanged gate:** a destructive tool still returns
  `approval_required`; the note never substitutes for the gate.
- **Docs:** the MCP sentence and the runtimes-table line are asserted by the
  existing docs coverage checks.

## Out of scope

- The tier table itself — which tools are `observe`, `act` or `destructive` is
  decided elsewhere.
- DorkOS's own approval cards and their hold/resume behavior.
- The tool-group toggles, which shape what an agent is told about and are not a
  safety boundary.
- Any change to what auto mode is allowed to do without a person.
- Summarizing tool results for the classifier (the ideation's Option 3), which
  would make tool output a channel into the note.

## Dependencies

- `specs/claude-agent-sdk-upgrade-0.3.268/` (PR #1798) — the field does not
  exist below 0.3.236.
- ADR `260726-171347` (DOR-519) — why this is an assertion and not a name list.
- ADR-0240 — permission modes pass through to the runtime.
