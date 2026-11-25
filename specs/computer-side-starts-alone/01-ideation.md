---
slug: computer-side-starts-alone
number: 261125-151223
created: 2026-11-25
status: specified
---

# A computer side that starts alone

**Slug:** computer-side-starts-alone
**Linear:** epic DOR-5152; the tool server out of Claude Code DOR-4926; one gate DOR-5183; the computer entry and its wall DOR-5158; role as a seam DOR-4927
**Decision:** ADR [`261124-150516`](../../decisions/261124-150516-space-side-and-computer-side-one-contract-two-entries.md)
**Roadmap:** `meta/ROADMAP.md` item 6. Needs item 5 (the turn port, spec [`turns-survive-restarts`](../turns-survive-restarts/02-specification.md)). Item 7 (the own-process test) and item 8 (the contract over the wire) need this.
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

ADR `261124-150516` gives DorkOS two sides in the code: the **space side** holds an agent's identity, rules, conversations and schedules and decides what an agent may do; the **computer side** runs turns. One program has two entries: a Mac runs both sides, and an agent computer runs the computer side alone.

Today the line exists only on paper. Computer-side code imports space-side code 522 times. The DorkOS tool server, the code that gives every agent its DorkOS tools, sits inside the Claude Code runtime's folder, and the external `/mcp` server cannot start unless the Claude Code runtime does. Nothing starts the computer side on its own: the agent-computer role is the whole server with a dozen branches switched off.

This step makes the line real on a Mac, inside one process, without the wire. When it is done, a computer entry boots with no space-side code, runs a turn against a stand-in for the space side, and stops. That is the proof item 7 and item 8 build on.

## What is built today

| Piece                                                       | State                                                                                                                               |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The turn port's door (space face, computer face, admission) | Built in item 5 (pull request #4401): `apps/server/src/services/runs/turn-port.ts`, `apps/server/src/services/session/turn-port/`   |
| The facts sink the computer side reports through            | Built (`services/session/turn-port/facts.ts`, registered by `services/runs`)                                                        |
| A lint ratchet in the space-to-turn direction               | Built with #4401 (`apps/server/eslint-rules/turn-port-boundary.js`)                                                                 |
| A wall in the computer-to-space direction                   | Only two narrow pairs (`session-runtimes-boundary.js`, `work-graph-boundary.js`)                                                    |
| A runtime-neutral tool listener                             | Built: the loopback listener in `services/runtimes/connector-mcp/` serves capabilities to Codex, OpenCode, Doe and `computer-local` |
| The 39 hand-registered tools                                | Claude Code only, behind a second gate and a second tier table                                                                      |
| `tools.list`, `tools.call`, `agents.sync`                   | Schema only (`packages/shared/src/session-relay-agent-computer.ts`)                                                                 |
| A computer entry                                            | Not built. One `index.ts` boots everything; `harness-boot.ts` is a hand-kept copy of part of it                                     |

## What the spec settles

- **Which code is which side**, folder by folder, in one side map that a lint rule and an import-graph test both read.
- **A wall with a baseline that only falls**, landed first, so no new crossing gets in while the seams are built.
- **One tools port** (`list` and `call`, plain data) that every runtime reaches the same way, with the 39 hand tools turned into capabilities and one gate for every call. Each call is bound to the run it belongs to; calls from background work follow a rule Security has signed. Codex, OpenCode and Doe are shown the former hand tools one group at a time, each with its own changelog fragment, and a runtime holds a call for a person's answer only where its tool client is shown to wait.
- **The other seams** that take the count to zero: records leave as facts, the per-turn rules copy, agent facts, pause through the turn port, asks, turn-start input, the computer tools kit, and a short list of moves.
- **The store, composition and roles**: one `dork.db` stays, with every table on one of two lists and computer code reading or writing only its own; startup steps become shared functions; one role policy; a second entry for the computer side.
- **Proofs and build steps**, each step one pull request series with what it removes from the count.

## What is left to later parts

- The wire and the forwarding runtime (item 8). The shapes here already fit the wire schema, so item 8 changes the transport only.
- The own-process test (item 7). The computer entry here runs inside tests; whether it runs as its own long-lived process on a Mac is item 7's question.
- An image target for agent computers (item 14).
- Splitting the database. Space tables leave SQLite when the private space becomes a tenant (item 16, ADR `261122-173853`).
