---
id: 261124-150518
title: Every agent can be messaged directly; one "send to an agent" capability, the same over the API, the CLI, MCP and A2A
status: accepted
created: 2026-11-24
spec: null
superseded-by: null
amends: [261004-235818]
---

# 261124-150518. Every agent can be messaged directly; one "send to an agent" capability, the same over the API, the CLI, MCP and A2A

## Status

Accepted as a direction (operator, 2026-11-24: "I like the idea of being able to send messages to individual agents directly through the CLI, API, etc. So, in theory, a DorkOS server would be able to just run a single agent"). The shapes below are settled in a spec before any of it is built. Evidence: `research/20261124_architecture-direction-review.md`.

**Amends** [261004-235818](261004-235818-started-chat-inherits-starter-level-as-ceiling.md): a caller with no chat (an outside program) is held to one fixed level today. When this capability is built, that fixed cap becomes the caller's own level, set by its owner. "Never higher than the starter" stands. Until the spec lands, the cap stands too.

**Supersedes** the archived ADR [0175](archive/0175-use-a2a-protocol-as-external-gateway-only.md) (A2A as an external gateway that publishes to Relay): A2A becomes one projection of this capability, and Relay is not the transport inside.

**To settle in the spec, with Security:** ADR [261006-225605](261006-225605-agents-are-trusted-by-default-outsiders-and-third-party-code-are-not.md) rule 4 says a turn started from outside gets no power, while `meta/PRINCIPLES.md` states the preview rule that an agent runs at the level its owner set, whoever sent the message. A program caller must land on one of them, on purpose.

Builds on: ADR 261122-124821 (the `dork:` reference and addresses), ADR 261123-170830 (a route is a projection of a capability), ADR 261009-171114 (a message from a chat carries its sender and its level), ADR 261017-211859 (a conversation is the shared log).

## Context

A program that wants to talk to one DorkOS agent has no plain way to do it. The A2A gateway gives each agent its own URL and returns the reply in the same call, but it is off by default, answers only on the same computer, gives up after two minutes and is missing from the API document. The REST API needs a chat first and refuses a script once an owner account exists. The CLI has no verb for it, the outside MCP server has no tool for it, and the address design names an agent but defines no way to send to one. Each of those paths also has its own answer to "who is calling, and at what level does the turn run".

## Decision

We will make every agent directly addressable, through one capability defined once.

- **One capability: send to an agent.** Its target is the agent, named by its `dork:` reference or address, never a chat. It is defined in the capability registry and projected, as every capability is, to a REST route, a CLI verb (`dorkos ask`), an MCP tool and the A2A gateway.
- **The caller may keep a thread.** An optional conversation key puts the message in the same conversation as the last one with that key. No key starts a new one. The agent's seat decides which chat runs the turn.
- **The reply comes back two ways.** As a stream on the same call, or later by the id the call returns. There is no fixed time limit on the work.
- **A program is its own kind of caller.** It has an identity of its own and a level its owner set. Its words reach the agent marked as outside words, as a stranger's would, unless the owner raised that caller. It is never mistaken for the person.
- **A server can run one agent.** Nothing in DorkOS may require a second agent to exist, so a small install can serve a single agent at its address.
- **A2A becomes one projection of this capability**, with the same defaults as the others, and joins the API document.

## Consequences

### Positive

- One way to reach an agent, with one answer to who is calling and at what level, whichever door is used.
- Scripts, other products and other people's agents can use a DorkOS agent without the app.
- An agent on another computer is reached the same way, because the address names the agent and not the machine.
- Email and other inbound channels in the address design get the send operation they were missing.

### Negative

- A new way in is a new thing to protect: rate limits, who may reach whom, and the outside-words mark must hold on every projection.
- Three paths that exist today (the A2A executor, the sessions route used as a send, the Relay message route) have to converge on it or be removed.
- "Which chat does this land in" becomes a rule people can observe, so it has to be simple and written down.

## Alternatives considered

- **One endpoint per agent, built by hand.** Rejected: it is a fifth authoring path beside the capability registry, and the address already tells a shared route which agent is meant.
- **Leave it to A2A.** Rejected: one protocol among several, off by default, and it would keep its own rules about the caller.
- **Address a chat, not an agent.** Rejected by ADR 261122-124821: a chat is one agent's private working context. It is linked and signed, never addressed.
