---
id: 260909-123910
title: A late approval verdict wakes the session that asked, as its own registered context kind
status: accepted
created: 2026-09-09
spec: approval-verdict-delivery
superseded-by: null
amends: null
---

# 260909-123910. A late approval verdict wakes the session that asked, as its own registered context kind

## Status

Accepted (extracted from spec: `approval-verdict-delivery`, DOR-1931). The implementation lands with
this record, so it is `accepted` rather than `proposed`.

## Context

A destructive tool call HOLDS while a person decides and resumes in the same turn (DOR-939,
DOR-1930). The hold caps at ten minutes; the approval window is two hours. An answer given at minute
twenty therefore reached nobody: the call had returned its poll payload and the turn had ended. An
operator approved four `mesh_unregister` cards and opened the agent's session to relay the decision
by hand.

Sizing the fix turned up two questions that are decisions rather than implementation details, which
is why the spec asked for this record.

**Delivering to a session that stopped waiting means starting a turn nobody asked for**, which
spends the person's tokens and may run long if the agent picks the work back up. `mcp-signin-resume`
made a similar trade once and refuses a busy session, on the reasoning that a "your server is
connected" nudge stops being useful the moment the agent gets on with the work anyway.

**And a verdict needs a new `ContextKind`.** Every runtime adapter renders kinds through its own
hand-written `switch` with a `default: JSON.stringify` arm, so a kind nobody teaches them degrades
rather than breaks — reading as a formatted block on claude-code and a raw dump on the other two.
The closest existing kind, `staged_context`, tells the agent "the person attached this ahead of
their message", which a server-authored security verdict is not.

The tempting cheap answer does not work: `takeStagedContext` is folded in exactly one place, inside
a dispatch, so a parked verdict lands only when somebody messages that session again. If the session
is idle, nothing fires and the person still has to go poke the agent — which is the original
complaint.

## Decision

We will deliver a late verdict by **waking the requesting session**, for a grant and a denial alike,
carrying the answer as a **new registered `approval_verdict` `ContextKind`** whose body is written
once in `runtimes/shared/` and rendered by all three adapters. A busy session **queues** rather than
refusing. Exactly one delivery is guaranteed by a **conditional write** (`notified_at`), claimed by
the in-session hold when it STARTS waiting, handed back if it gives up without a decision, and swept
at boot for the holds a restart killed.

A delivery address is **recorded server-side or not at all**. Only surfaces DorkOS binds to a session
itself record one; a session id arriving in a header is one an agent chose, and a delivery address an
agent chooses is a way to make DorkOS start a turn in somebody else's session.

## Consequences

### Positive

- The loop closes with nobody in the middle: the person answers once, wherever they are standing,
  and the agent is told.
- A security decision reads identically on claude-code, codex and opencode, because the body is
  written once rather than three times.
- Registering the kind in `CONTEXT_TAG` buys the transcript strip and the tag defusal for free; an
  invented tag would get neither (the `ui_action` precedent gets neither today).
- "Exactly once" is true by construction rather than by timing, so it survives a restart and a
  `settle()` that fires twice for one approval.

### Negative

- A delivery starts a turn nobody typed, which costs tokens. Bounded by the fact that a verdict
  answers something the agent ASKED for and is blocked on — a different thing from a nudge.
- Delivery reaches only the surfaces DorkOS binds to a session, which today is the in-session
  claude-code server. Codex and OpenCode reach DorkOS capabilities over the sessionless external
  `/mcp` server and keep the token/poll flow — required by the spec's own acceptance criterion 6,
  and the same structural boundary the in-session hold already has. Widening it means binding a
  session at injection time, server-side.
- Every future `ContextKind` carrying prose now owes a shared writer and three adapter cases. The
  `default: JSON.stringify` arms remain a trap for anyone who forgets.
