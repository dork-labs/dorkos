---
id: 261125-191001
title: A mini app's message to an agent is not a wake; an outside event's words reach a chat only through the one wake
status: proposed
created: 2026-11-25
spec: one-wake-and-watchers
superseded-by: null
amends: [261124-150519]
---

# 261125-191001. A mini app's message to an agent is not a wake; an outside event's words reach a chat only through the one wake

## Status

Proposed (architect, 2026-11-25). It changes no decision. It states how one sentence of ADR [261124-150519](261124-150519-what-may-go-in-the-core-mini-apps-and-one-wake.md) is read, so that the specification for roadmap item 9 (`specs/one-wake-and-watchers/`) can be built on it. It is accepted when the first step of that specification that lets a mini app receive a connected app's events merges.

**Amends** [261124-150519](261124-150519-what-may-go-in-the-core-mini-apps-and-one-wake.md), which stays Accepted and stays as written.

## Context

ADR `261124-150519` says the core owns one wake, that every watcher and every connected-app event uses it, and that "Nothing else may start a turn from an outside event". It also says a message sent to an agent "is not an event, and keeps its own path".

A mini app can already talk to an agent: its server side sends a message with `ctx.agent.send`, and that message arrives marked as words from outside, inside the fence. Roadmap item 9 lets a mini app receive a connected app's events. So one question needs a plain answer before that is built: when a mini app holds the words of an outside event, which path may carry them to a chat?

## Decision

We read ADR `261124-150519` this way:

1. **A mini app's own conversation with an agent is a message, not a wake.** `ctx.agent.send` keeps its path and its rules. Its words stay marked as words from outside and inside the fence, as they are today.
2. **The words of an outside event reach a chat only through the one wake.** A chat asks a watcher to tell it about something. That makes a stored registration. When the thing happens, the watcher fires the wake for that registration, and the core delivers it as one turn. A mini app that receives a connected app's event does not start a turn for it any other way.
3. **A watcher's words are marked as words from outside unless a person has said otherwise for that watcher.** Nothing built so far gives a person a way to say otherwise, so today they are always marked and fenced. A way to say otherwise is its own decision, with Security's read.

## Consequences

### Positive

- One rule tells an author which path to use: talk to an agent with a message, tell a chat about an event with a wake.
- Every turn that an outside event starts is stored, survives a restart, and can be seen and removed by a person.

### Negative

- The rule for authors is a rule in the authoring guide and in review. Both paths mark their words as words from outside, so the level of care is the same on each.

## Alternatives considered

- **Edit ADR `261124-150519`.** Rejected: its decision does not change, and an accepted record is amended by a new record, not rewritten.
- **Retire `ctx.agent.send` in favour of the wake.** Rejected: a conversation between a mini app and an agent is not an event, and it works today.
