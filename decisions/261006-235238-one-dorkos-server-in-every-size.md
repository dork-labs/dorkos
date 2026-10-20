---
id: 261006-235238
title: One DorkOS server in every size; a space is a DorkOS server, and work moves between servers by push
status: accepted
created: 2026-10-06
spec: null
superseded-by: null
amends: [260727-184933, 260916-210001, 0319]
---

# 261006-235238. One DorkOS server in every size; a space is a DorkOS server, and work moves between servers by push

## Status

Accepted (operator decision, 2026-10-06; Linear DOR-2735). Direction: the merge starts before launch (Dorian, 2026-10-12), with a go/no-go on November 16. If its before-launch part is not ready by then, launch runs on today's space server and it finishes right after launch. Which parts land before launch and which after is in spec [`server-merge`](../specs/server-merge/02-specification.md). Until the merge lands, today's code still runs two servers.

**Amended by** [261018-124422](261018-124422-one-program-before-launch.md) (2026-10-18): the program merge (server-merge step 7) moves before launch. Steps 8 and 9 stay after launch.

**Amended by** [261015-042933](261015-042933-everything-is-a-space-hubs-space-servers-and-agent-computers.md) (everything is a space, 2026-10-15): an account may also have its own DorkOS in the cloud (a hub, made lazily, which runs no agents), and reaching your Mac from the web goes through a chats-only session relay into that hub, not through the app connecting to every server directly. One program and "only one place runs an agent at a time" stand; the after-launch step "one window" is replaced.

**Amends** (each stays Accepted):

- [260727-184933](260727-184933-the-community-server-never-runs-a-members-agent.md): retires "hosted DorkOS is three distinct products", "the community server never executes a member's agent", "presence follows the install" and the deliberately incomplete web client. Today's code still keeps the community server agent-free until the merge lands. Its single-person install is retired separately by [261006-235239](261006-235239-people-and-agents-hold-equal-accounts.md).
- [260916-210001](260916-210001-community-is-independent-hono-node-service.md): retires "independent" and "Do not migrate the local Express server". The Hono choice stands and becomes the direction for the local server too; the rest of the stack stands for `apps/community` until the merge.
- [0319](0319-account-first-cloud-identity-device-link.md): retires "identities are never migrated between local and cloud databases". The DorkOS account and the device link stand; pushing can now move an agent, with its identity, from one server to another.

## Context

DorkOS ships two servers: the local Express app on SQLite that runs agents, and `apps/community`, a Hono app on Postgres that holds shared rooms and must never run an agent. Every feature that touches both (identity, rooms, files, presence) is built twice or bridged. The 2026-07 rule that a community never runs an agent kept hosting cheap, but it also means a founder's agents vanish when the laptop sleeps, and hosted agents could never be offered.

## Decision

We will make **one DorkOS program** that runs at every size: a space is a DorkOS server with a public web address, and running it locally is a one-person space, free forever, with no required account. First the local server moves from Express to Hono, then it merges with the community server into one program and one app. Anything made locally can be **pushed** to another DorkOS server (DorkOS Cloud or one you host), like a git remote: publish a page, sync a doc, move an agent. **Only one place runs an agent at a time.**

## Consequences

### Positive

- One codebase, one app, one set of tests; features stop being built twice.
- Agents can keep working while a laptop is closed, on a server that is always on.
- Leaving the cloud is a push in the other direction, which keeps "local first, cloud optional" true.

### Negative

- The Express-to-Hono move and the merge are large, and the single-owner assumption is checked in many places (see the equal-accounts ADR, 261006-235239).
- A server that runs agents must isolate them and hold credentials safely; the community server avoided both by never running one.
- Moving an agent has to guarantee that two servers never run it at once, and some things will not travel with it; how is still to be designed.
