---
slug: auto-mode-classifier-context
number: 260911-191245
created: 2026-09-11
status: ideation
---

# Telling auto mode what it cannot see

**Slug:** auto-mode-classifier-context
**Date:** 2026-09-11
**Source:** `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/` — filed there as a product question rather than an adoption

---

## Problem statement

Auto mode is the setting where the agent gets on with its work and stops only for
the things that deserve a stop. Something on the runtime's side — a classifier —
looks at each tool call and decides whether a person should see it first.

That classifier knows what the model's own tools do. It knows nothing about
DorkOS. When an agent calls a DorkOS tool, the classifier sees an unfamiliar name
with some arguments, and it has to guess. Two failures follow from the same blind
spot:

- **It asks about things already answered.** DorkOS runs its own safety check on
  every one of its tools before the handler is allowed to run
  (`services/core/mcp-tool-gate.ts`). A call that will be refused or held by that
  check, and a call that already passed it, look identical from outside. So a
  person gets asked about a call that is already governed, then gets asked again
  by DorkOS when it matters — two stops for one decision.
- **It gets cautious in the middle of a flow.** Interrupting a run that was going
  well, for a call the product already understands, is the fastest way to make a
  person stop reading approval cards altogether. That erodes every card that
  actually matters.

Until now DorkOS had exactly one lever to make auto mode less cautious, and it
was the wrong one. ADR `260726-171347` (DOR-519) is the record of what happened
when this codebase reached for the runtime's auto-approval list: a toggle meant
to restrict what an agent could do turned out to hand the runtime a 31-name list
of tools that then skipped the prompt entirely, including two that delete things.
The list was deleted and the standing rule since then is that a list of names is
never how DorkOS makes the runtime more permissive.

So the problem has been unsolvable in the safe direction: no way to tell the
classifier anything true, and only an unsafe way to tell it to stop asking.

## What the SDK now offers

`@anthropic-ai/claude-agent-sdk` 0.3.236 adds one field:

- `PostToolUse` hook result → `hookSpecificOutput.classifierContext` — a short
  note, written by the host, that the **auto mode permission classifier** reads
  alongside the tool's result.

Changelog entry: `research/runtime-upgrades/claude-agent-sdk/0.3.224-to-0.3.268/changelog.md`,
Features → "Hooks", item 25. Impact assessment: same directory,
`impact-assessment.md`, "MEDIUM — `classifierContext` on `PostToolUse` hooks".

Three facts that shape any design:

- It is an **assertion, not a grant**. The note does not allow anything. It is
  input to a decision that still belongs to the classifier, and the classifier may
  ignore it. That is the whole reason it is the right shape where an
  auto-approval list was the wrong one.
- DorkOS registers **`PreToolUse` only** today (`messaging/launch-resolver.ts`),
  used for pre-edit baseline capture. A `PostToolUse` hook is new wiring, not a
  new field on something already running.
- The facts worth asserting already exist server-side. `mcp-tool-gate.ts` is one
  chokepoint that every hand-registered DorkOS tool passes through, with a
  declared tier per tool and a recorded approval for anything destructive. The
  note would restate what that gate already decided — not form a new opinion.

## Users

- **Priya** (`meta/personas/the-knowledge-architect.md`) — the reason to be
  careful about the shape. She reads the source before she trusts a tool, and the
  question she will ask is exactly the right one: does this note make the agent
  able to do more? The answer has to be provably no.
- **Kai** (`meta/personas/the-autonomous-builder.md`) — runs in auto mode across
  many sessions and feels every redundant stop. He is the one paying for the
  classifier's blind spot in attention.
- **Ikechi** (`meta/personas/the-ai-native-founder.md`) — never sees this. He
  benefits only in that he is asked less often about things nobody needed to ask
  about. Anything that widens what happens without him is a cost, not a win.

## Options

### Option 1 — Do nothing

Keep the classifier uninformed and keep DorkOS's own gate as the only check that
knows anything.

- **For:** no new trust surface, no new hook, nothing to maintain. The redundant
  asks are annoying, not dangerous.
- **Against:** leaves the only improvement path as the one DOR-519 closed. The
  double-stop problem gets worse as the number of DorkOS tools grows.
- **Effort:** none.

### Option 2 — Assert gate facts, and only gate facts

Register a `PostToolUse` hook that fires for DorkOS-owned tools and attaches a
short, fixed note describing what the DorkOS gate already did: which tier the tool
carries, that the tier check ran, and — where one applies — that a person approved
this exact call. The set of assertable facts is written in one place, every note
is composed from constant text, and nothing from the tool's arguments, its output,
or the conversation is ever interpolated into it.

- **For:** tells the truth, narrowly. It is the first mechanism that can make auto
  mode smarter without widening anything, and it is testable: a test can pin the
  complete set of sentences DorkOS is able to emit.
- **Against:** new wiring on a hot path (a hook that runs after every matching
  tool call), and a fact-to-sentence table that must be kept honest as tiers
  change. It also depends on a classifier we do not control — the same note may be
  weighed differently after an upstream change.
- **Effort:** moderate.

### Option 3 — Describe results generally

Use the hook to summarize any tool's result for the classifier — that a read
returned nothing sensitive, that a command touched no tracked files, and so on.

- **For:** potentially the largest reduction in unnecessary stops.
- **Against:** unbounded. Every sentence is a judgment DorkOS would be making
  about content it did not verify, and the moment tool output flows into that
  sentence, the note becomes a channel a tool's output can write into. That is a
  prompt-injection surface built on purpose.
- **Effort:** large, and the security review is larger than the build.

## Recommendation

**Option 2.**

The argument is the trust boundary, and it is worth stating as the rule rather
than as a preference: **DorkOS may assert only facts it established itself, and
an assertion widens nothing unless the classifier decides it does.** Under that
rule the note is a statement of record — this call passed the check DorkOS runs —
and it can be verified by reading one table. Under Option 3 the note becomes an
opinion about content, which is a different kind of thing entirely and cannot be
audited by reading anything.

This is also the answer to "why not just list the tools". A list of names tells
the runtime to stop asking. A note tells it something true and lets it decide.
DOR-519 is the reason that distinction is not academic here.

## Open decisions

1. Which facts may be asserted — tier only, or tier plus "a person approved this
   exact call", plus "this tool cannot leave the machine"?
2. Does a note ever name the operator's configured power level, or is the level
   deliberately invisible to the classifier?
3. Do the notes apply to every DorkOS tool, or only to the tools whose redundant
   stops we can actually demonstrate?
4. Is what DorkOS asserted recorded anywhere a person can read it afterwards?
5. Does this stay in-session only, or does the sessionless external `/mcp` path
   need an equivalent — and if it cannot have one, is that stated in docs?
6. Is there an off switch, and is it per-agent or global?
7. Codex and OpenCode have no such hook. Is the difference in behavior between
   runtimes acceptable, or does it need saying somewhere?

## Dependencies

- `specs/claude-agent-sdk-upgrade-0.3.268/` — the version bump, PR **#1798**. The
  field does not exist below 0.3.236.
- ADR `260726-171347` (tool-group toggles gate context, not access) and its
  superseded predecessor ADR-0070 — the record of what a name list did here, and
  the reason this design is an assertion rather than a list.
- ADR-0240 (permission modes pass through to the runtime) — auto mode reaching the
  runtime at all is that decision.

## Out of scope

- The tier table itself. Which tools are `observe`, `act` or `destructive` is
  decided elsewhere and is not re-opened here.
- DorkOS's own approval cards and their hold/resume behavior.
- The tool-group toggles, which shape what an agent is told about and are not a
  safety boundary.
- Any change to what auto mode is allowed to do without a person.
- **Asserting that a person approved this exact call.** Open decision 1 answered
  "tier plus a person's approval", and the build attempted both. The approval
  half was cut in review and is deferred rather than abandoned, because the first
  attempt got the binding wrong in a way worth writing down. The tier gate records
  nothing when it ALLOWS a call, so a side record had to be added; it was keyed by
  tool name and a hash of the arguments and NOT by session, which made it a
  cross-session leak. One session's genuine approval could be spent on a different
  session's identical unapproved call, and a Codex or OpenCode approval — same
  gate, no hook — left a record any matching claude-code call could claim inside
  the TTL. A false "a person approved this" in front of a permission classifier is
  the one failure this feature must not have, so nothing is asserted about
  approval today. A safe version is possible: the ids exist on both sides already
  (`ApprovalRequestingSession.sessionId` where the gate records, and the hook's own
  `session_id` beside the DorkOS session id its launch closed over), so the record
  can be keyed by session as well as by argument hash. It needs its own work item,
  with the cross-runtime case tested rather than reasoned about.

## Risks

- **A note is text a model reads.** If any part of it is ever built from tool
  output or user input, it becomes a way for content to talk to the classifier.
  The mitigation is structural — constant strings only — and it must be pinned by
  a test, not by a convention.
- **Drift between the gate and the note.** If the gate's behavior changes and the
  sentence does not, DorkOS is asserting something that is no longer true. The two
  should be derived from one source.
- **The classifier is not ours.** An upstream change to how it weighs host
  context changes the effect of a note we did not touch. Whatever we ship should
  be measurable after the fact — how many stops disappeared, and which ones.
- **It makes the product quieter, which is also the risk.** Fewer stops is the
  goal and the danger in one sentence. Any reduction should be visible in testing
  as "these specific asks stopped happening", never as a general feeling that
  things got smoother.
