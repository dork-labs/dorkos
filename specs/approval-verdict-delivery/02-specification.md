---
slug: approval-verdict-delivery
number: 260909-012725
created: 2026-09-09
status: specified
---

# Telling an agent how its approval ended, after it stopped waiting

**Status:** Draft
**Author:** DOR-1931
**Date:** 2026-09-09

> Every claim about existing behavior below was read off the tree at `6007d83b0` (this branch's base) —
> the commit that merged DOR-1930. Where a claim rests on a line of code, the file and line are named.

## Overview

An operator approved four `mesh_unregister` cards and the agent that asked was never told. They opened the
agent's session and relayed the decision by hand.

DOR-1930 fixed the half that is fixable inside one turn: a destructive tool call now **holds** and resumes
when the person answers. But the hold caps at ten minutes (`CAPABILITY_APPROVAL_HOLD_CAP_MS`) and the
approval window is two hours. Answer at minute twenty and the agent is still never told — which is very
plausibly the operator's actual reported case, since a card sat unanswered while they were away.

This specifies the other half: delivering a verdict to a session that **stopped waiting**.

## Why this is a spec and not one more PR

The delivery mechanism looked like a small addition and is not. Sizing it turned up one fact that changes
the shape of the work, and two policy questions that deserve a decision rather than an implementation.

### The ripple: a verdict needs a new `ContextKind`, and three adapters render kinds by hand

`additionalContext` is on the runtime-neutral `AgentRuntime` interface
(`packages/shared/src/agent-runtime.ts:790`), and all three adapters consume it. That much carries no cost.

But a verdict needs a **new kind**, and every adapter renders kinds with its own `switch`:

- `apps/server/src/services/runtimes/claude-code/messaging/context-builder.ts:742`
- `apps/server/src/services/runtimes/codex/turn-input.ts:123`
- `apps/server/src/services/runtimes/opencode/messaging/turn-input.ts:86`

Each has `default: JSON.stringify(entry.data, null, 2)`, so an unhandled kind **degrades to raw JSON rather
than breaking** — which is why this is a quality threshold rather than a correctness one. Shipping a
security verdict that renders as a formatted block in claude-code and a JSON dump in the other two is not
the bar.

Adding a kind is therefore: the union member and its Zod schema in
`packages/shared/src/additional-context.ts`, a `CONTEXT_TAG` entry, a shared formatter, three adapter cases,
and the conformance tests around them.

### Why an existing kind cannot be reused

`staged_context` is the closest fit and its framing is wrong in a way that matters. Its formatter
(`apps/server/src/services/runtimes/shared/staged-context-block.ts:45-47`) tells the agent:

> "The person attached this ahead of their message — material to work with, not a new instruction they just
> typed"

A server-authored approval verdict is not something the person attached. Dressing one as the other is a
small lie in exactly the place — a security decision — where the codebase is most careful not to tell one.

### Why the tag has to be a real `CONTEXT_TAG`

`stripInjectedTagBlocks` (`packages/shared/src/additional-context.ts:866`) drives the transcript strip off
`Object.values(CONTEXT_TAG)`, so a registered kind is stripped from the rendered transcript **with no
further edit**, and `SYSTEM_TAGS` in the block formatters defuses it for free.

An invented tag gets neither. Worth knowing: `mcp-signin-resume` dispatches a `<ui_action>` message and
`ui_action` is **not** in `CONTEXT_TAG` — so it is not stripped. That is a precedent to understand before
copying, not to copy.

## Two policy questions this must answer

Neither is an implementation detail, and both are why this wants a decision record.

### 1. Waking an idle session spends the person's money

Delivering to a session that stopped waiting means **starting a turn nobody asked for**. That is tokens, and
possibly a long one if the agent resumes the work.

`mcp-signin-resume` already made this trade once and its reasoning is the starting point, not the answer:
it dispatches with `whenBusy: 'refuse'` (`mcp-signin-resume.ts:202`) and skips a locked session quietly,
because "a lock means a turn is already running, which is usually the agent doing the very work the resume
would ask for."

An approval verdict differs in one way that matters: a **denial** may need to reach an agent that is
mid-work on the assumption it was allowed.

Open: does a verdict wake an idle session unconditionally, only on `granted`, or never — leaving it to ride
the session's next turn as staged context?

### 2. The passive route alone does not solve the reported problem

Worth stating because it is the tempting cheap answer. `takeStagedContext` is folded in exactly one place —
`apps/server/src/services/session/trigger-turn.ts:737`, inside a dispatch. A parked verdict therefore lands
**only when somebody sends that session another message**. If the session is idle, nothing fires and the
operator still has to go poke the agent, which is the original complaint.

So the passive route is necessary (it covers the busy session, and it survives a restart) and **not
sufficient**. The active route is what closes the loop. A complete design uses both, each for what it is
good at.

## The parts that are already settled

Sizing produced working code for the storage and single-delivery halves before the ripple was found. That
code was **discarded rather than shipped** — columns nothing reads are the "declared, validated,
unreachable" defect this codebase treats as a bug — but the design is sound and should be picked up as-is.

### Schema (`packages/db/src/schema/approvals.ts`)

Three nullable columns, purely additive:

| Column                  | Why                                                                                                                                                                                                                                                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `requesting_session_id` | Which session asked. A **new** column: `connector_session_id` is preflight-frozen connector authority that an approval BINDS to, and overloading an authority field to mean two things is how a binding stops meaning anything.                                                                                                                 |
| `requesting_cwd`        | Where that session lives, so a cold start resumes in the right directory. Stored rather than looked up because the lookup is what fails: the projector registry empties on restart and an approval outlives one easily inside two hours. This is the DOR-981 lesson, which `mcp-signin-resume` records as `originCwd` for the identical reason. |
| `notified_at`           | The single-delivery claim. See below.                                                                                                                                                                                                                                                                                                           |

Null for every request that arrived without a session — the external `/mcp` server, the introspection stub
— which is exactly the set with nowhere to deliver to.

### `notified_at` is a claim, not a receipt

Two paths can deliver a verdict — the in-session hold that resumes the call, and the out-of-band deliverer —
and **both wake on the same `approval_resolved` broadcast**. A check-then-act lets both through.

The fix is the shape `markConsumed` already uses (`approval-service.ts:840`): a conditional update,
`WHERE id = ? AND notified_at IS NULL`, returning whether it changed a row. That makes "exactly one
delivery" true by construction.

**The hold claims when it STARTS waiting, not when it finishes.** A hold that is waiting _will_ deliver, so
the out-of-band path must be locked out for the whole wait; claiming at the decision is a race the person
can lose in either direction — two deliveries, or none. A hold that gives up **without** a decision releases
the claim in its `finally`, or a person answering at minute twenty would find the delivery spoken for by a
hold that has been gone for an hour.

Verified while sizing: `awaitDecision` never rejects — an abort resolves `'timeout'`
(`approval-service.ts:642`) — so the release path is reached on every non-decision ending.

### The subscription seam

`eventFanOut.subscribe()`, already used server-side by `awaitDecision`. One constraint from its own contract
(`event-fan-out.ts:179-187`): listeners run **synchronously on the broadcast write path**, and "work that is
not cheap belongs on a queue the listener owns." A delivery involves a database read, a runtime resolve, a
possible session cold-start and a dispatch. The listener must therefore do nothing but hand off — the
delivery itself is detached, with its own error handling.

That file also notes a second subscriber is a deliberate decision point rather than a free addition. This is
that decision.

### The active delivery path

`apps/server/src/services/mesh/mcp-signin-resume.ts` is the template, and every hop it uses is on the
neutral `AgentRuntime` interface:

1. `runtimeRegistry.resolveForSession(sessionId)`
2. `runtime.hasSession(sessionId)`, else `await runtime.getSession(cwd, sessionId)` to cold-start a stored
   session; give up with a log line if it is gone for good
3. render the verdict through the new context kind's formatter — server-authored throughout
   (capability title, outcome, when), so no caller-supplied string need appear at all
4. `dispatchMessage({ …, whenBusy: <policy question 1> })`

## Security requirements

- **System-attributed, never user-typed.** The verdict must not be readable as the operator's words. A
  registered `CONTEXT_TAG` gets the existing defusing (`neutralizeContextClosingTag`,
  `sanitizeContextScalar`) and the existing transcript strip for free; an invented tag gets neither.
- **Exactly one delivery per approval**, enforced by the `notified_at` claim rather than by a check.
- **No caller-controlled text in the block.** The verdict is composed from the registry's own capability
  title and the outcome. Nothing an agent supplied should be interpolated; if that ever changes, it is
  untrusted text and must be fenced as such.

## Acceptance

1. An approval granted after the hold cap reaches the requesting session, on all three runtimes, rendered as
   a formatted block rather than a JSON dump.
2. A denial reaches it with the same urgency as a grant.
3. Exactly one delivery per approval, proven by a test that races the hold against the out-of-band path.
4. A hold that times out releases its claim; one that decides keeps it.
5. A session that ended and cannot be cold-started fails with a log line, never a throw.
6. The external `/mcp` surface, which has no session, is byte-identical to today.

## Out of scope

Expiry (**DOR-1932**). An approval that lapses unanswered emits **no event at all** today — `settledOutcome`
(`approval-service.ts:690`) returns `'expired'` without settling or broadcasting, and `purgeExpired` only
deletes rows past 24h and runs once at boot. Making expiry observable means a settling timer, which changes
when `settle()` fires for every consumer including the escalation ladder it disarms. That is its own
decision record. This spec's seam is what would carry an expiry notice once one exists.
