---
slug: send-to-an-agent
number: 261125-193257
created: 2026-11-25
status: specified
---

# Send to an agent

**Slug:** send-to-an-agent
**Linear:** epic DOR-5155
**Decision:** ADR [`261124-150518`](../../decisions/261124-150518-every-agent-can-be-messaged-directly-one-send-capability.md), which amends ADR `261004-235818` and supersedes the archived ADR 0175
**Roadmap:** `meta/ROADMAP.md` item 10. Needs items 1 and 2 (one definition for every action, one name for every thing) and item 5 (spec [`turns-survive-restarts`](../turns-survive-restarts/02-specification.md): the turn port, `startKey`, the run record). Uses item 9's marks rule (spec [`one-wake-and-watchers`](../one-wake-and-watchers/02-specification.md), step O7) and item 8 (spec [`space-computer-contract`](../space-computer-contract/02-specification.md)) only for an agent on another computer. Runs beside items 6 to 9.
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

A script, another product or another person's agent that wants to talk to one DorkOS agent has no plain way to do it. There are four ways in today, and each one answers the same three questions differently: who is calling, at what level the turn runs, and which chat the words land in. The A2A gateway is off by default, works only on the same computer, gives up after two minutes and is missing from the API document. The REST API needs a chat first. The CLI has no verb for it. The outside MCP server has no tool for it.

ADR `261124-150518` settles the direction: one capability, "send to an agent", defined once and projected to every door. Its target is the agent, never a chat. A program is its own kind of caller, with a name and a level its owner set. A server can run with one agent.

## What is built today

| Piece                                                         | State                                                                                              |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| The turn port's space face, the run record, the outbox        | Built in item 5 (T2, T4, T5)                                                                       |
| `startKey` on a run                                           | A unique column no code sets; step 5's T7 adds it to the start input                               |
| A capability that sends words to an agent from outside a chat | None. `chat.send` takes an agent id but works only inside a chat                                   |
| The A2A gateway                                               | Off by default; publishes to Relay; a two-minute limit; not a capability; not in the API document  |
| `POST /api/sessions/:id/messages`                             | Needs a chat id; a caller that is not the person starts its turn with origin `agent-launch`        |
| `POST /api/relay/messages` to an agent subject                | Works; marked for a caller that is not the person                                                  |
| A CLI verb                                                    | None; `dorkos call` reaches capabilities only                                                      |
| A program's own identity                                      | An API key: a name in the key table, read as the owner's program; the audit record names the owner |
| Reading a run by its id                                       | None over HTTP; the space face has `get(runId)` in process                                         |
| A capability that streams                                     | None; streams are hand routes on the allowlist                                                     |
| A server with one agent                                       | DorkBot is created at every boot; nothing found requires a second agent of the person's own        |

## What the spec settles

- **The capability**, `agent.send`: its input, its answer at acceptance, its errors and every door (HTTP, `dorkos ask`, the outside MCP server, A2A).
- **Finding the agent**: one resolver for an id, a `dork:agent:` reference or an address, answering "not found" to a caller that may not send.
- **The seat rule**: one table from (agent, caller, conversation key) to a chat. A key is private to its caller.
- **A new turn origin**, `direct-send`, carrying the caller's kind, and its row in step 9's marks table.
- **A program's identity**: a name, a level and a "words are trusted" switch, set by the owner in the app, recorded in the audit trail as the program. The command line's own saved key always runs at the lowest level. The server, never the caller, says who is calling.
- **The level rule** by caller kind, put to Security as one question with a pick.
- **The reply**: read by id, and a stream of one run's status and reply words, with no fixed time limit. Whoever may read a run may stop it.
- **Who may send to an agent**, a setting on each agent, closed by default to everyone but its owner and the owner's own programs; limits counted for each caller.
- **A2A as a projection** of the capability, without Relay inside and without the two-minute limit.
- **The other paths converge**: the sessions route, the Relay message route and the outside MCP server.
- **A server with one agent**, including one with no DorkBot.

## What is left to later parts

- Inbound email, rooms and room mentions, and Telegram and Slack connections. None of them is a send.
- Retiring Relay as a whole. Only A2A's use of it and one route's use change here.
- Folding the five kept-chat stores into one. Two could fold onto the seat table later, as optional steps.
- Billing for sends beyond what a turn already costs.
- Sending between two DorkOS installs other than through A2A.
- A user interface beyond what an owner needs to name a program and set its level.
- Members of a shared space as callers. They arrive with items 12 and 15, which decide their checks.
- Moving the seat table and the program table to the private space when it becomes a tenant (item 16), each with its own ticket.
