---
id: 261124-150519
title: A three-question test for what may go in the core; everything else is a mini app, and the core owns one way to wake an agent
status: accepted
created: 2026-11-24
spec: null
superseded-by: null
supersedes: '0017'
amends: null
---

# 261124-150519. A three-question test for what may go in the core; everything else is a mini app, and the core owns one way to wake an agent

## Status

Accepted (operator decision, 2026-11-24: "I don't want to keep adding features to the existing DorkOS system and just have those things run in the same processes", settled on the architect's recommendation). Evidence: `research/20261124_architecture-direction-review.md`.

**Supersedes** [0017](0017-standardize-subsystem-integration-pattern.md) ("all new DorkOS subsystems follow the established Pulse integration pattern exactly"): a new feature no longer joins the server by default. It passes the test below or it is a mini app.

**Builds on:** [261006-235242](261006-235242-everything-is-a-plugin.md) (everything is a plugin) and ADR-0271 and ADR-0272 (first-party features built on the public author API, which a person can turn off).

**Read with** [261125-191001](261125-191001-a-mini-apps-message-to-an-agent-is-not-a-wake.md) (proposed 2026-11-25): a mini app's message to an agent is not a wake and keeps its path; the words of an outside event reach a chat only through the one wake. Nothing in this record changes.

## Context

The DorkOS server has 38 service domains and grows by adding more. Useful things that are not the product's core keep arriving: a watcher that tells agents when a pull request changes, a steward for the pipeline, trackers and dashboards. Built as server domains, each one makes every install heavier and every change riskier. DorkOS already has a second home for them: a mini app can run its server half as its own limited process, on a timer, with network access, and can start a turn. What is missing is a rule for which home a thing belongs in, and one shared way for a watcher to wake an agent. Today a mini app can wake only its own chat with an agent, not the chat that asked, and a connected app's events reach one chat per subscription and no mini app.

## Decision

We will decide where a feature lives with three questions, and give watchers one thing to call.

- **The test.** A feature goes in the core only if at least one is true: the core itself acts on it; only the core can see what it needs; a mini app cannot do it correctly even with care. If all three are false, it is a mini app, or a schedule with a skill. Some repetition between mini apps is an accepted price.
- **Watchers are mini apps.** A pull request watcher, a pipeline watcher and a steward are built on the same author API everyone else gets. DorkOS's own are first-party mini apps, which also tests the first thing DorkOS sells.
- **The core owns one wake.** "Wake this chat or this agent when X happens" is one durable capability: stored, safe across a restart (ADR 261124-150517), delivered through the normal turn path, and marked as outside words unless its owner said otherwise. Every watcher and every connected-app event uses it. Nothing else may start a turn from an outside event. A message sent to an agent (through a chat connection or the send capability of ADR 261124-150518) is not an event, and keeps its own path.
- **The author API closes its gaps first.** A wake can name the chat that asked. A mini app can receive a connected app's events. An event keeps its nested fields. An approval covers a watcher an agent built. These are to be filed as issues and come before the first watcher.

## Consequences

### Positive

- The server stops growing by one domain per idea, and an install carries only what its owner turned on.
- One place to make waking correct: order, restarts, limits and the outside-words mark.
- DorkOS's own team hits every gap in the author API before a founder does.

### Negative

- A first-party mini app is slower to build than a server domain until the author API's gaps are closed.
- A mini app runs with less reach than the core, so a few watchers will need a new, narrow capability from the core, and each one is a judgment call.
- The test is applied by people in review. Nothing checks it by code.

## Alternatives considered

- **Watchers in the core** (as T3 Code does). Rejected: it grows the one process for every user to serve a few, and DorkOS, unlike T3 Code, has an author API to build them on.
- **A separate service per watcher.** Rejected by ADR 261124-150516: a watcher has no different lifetime or trust level that a sandboxed mini app does not already give it.
- **A plugin for everything, runtimes included** (as Buzz 1.0 does). Rejected: runtimes sit behind the `AgentRuntime` port with a conformance suite, and the core test keeps them in.
