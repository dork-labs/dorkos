---
slug: one-wake-and-watchers
number: 261125-180652
created: 2026-11-25
status: specified
---

# One wake, and watchers as mini apps

**Slug:** one-wake-and-watchers
**Linear:** epic DOR-5154; the wake DOR-3563; the six gaps a watcher hits DOR-5171; the pull request watcher DOR-5172
**Decision:** ADR [`261124-150519`](../../decisions/261124-150519-what-may-go-in-the-core-mini-apps-and-one-wake.md)
**Roadmap:** `meta/ROADMAP.md` item 9. Needs item 5 (spec [`turns-survive-restarts`](../turns-survive-restarts/02-specification.md): the `wake_chat` effect and its handler, step T7). Runs beside items 6 to 8.
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

An agent often has to wait for something outside DorkOS: a pull request to merge, checks to pass, a review to land. Today it has no good way to do that. It polls and spends tokens, or it ends its turn "watching" and never comes back. The only pull request watcher is a shell script that runs inside one chat's process, works only under Claude Code, and dies with that process or with a restart.

ADR `261124-150519` settles where this belongs. The core watches nothing outside itself. A watcher is a mini app: it watches something and, when it happens, asks the core to wake a chat. The core owns three things only: a stored **registration** ("this chat asked this watcher to tell it about X, until then"), the **delivery** of a fired wake as one ordinary turn through the turn port, and what a person can **see and cancel**.

## What is built today

| Piece                                                                       | State                                                                                                                |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| The run record, the outbox, admission, the turn port's door                 | Built in item 5 (T2, T4, T5)                                                                                         |
| The `wake_chat` effect                                                      | A slot in the outbox's list of kinds, with no handler and no writer                                                  |
| `start_key` on a run                                                        | A unique column with no writer                                                                                       |
| DorkOS's own wakes (approval verdicts, sign-ins, hand-backs, widget clicks) | On the old dispatcher paths; four of them are lost on a restart. Step 5's T7 moves them onto the port                |
| A way for a chat to wait on an outside condition                            | None, on any runtime                                                                                                 |
| A mini app's tool call tied to the chat that called it                      | No: it carries the agent's id only                                                                                   |
| A connected app's event                                                     | Reaches one chat per subscription, a room or a chat channel; nested fields are dropped; a mini app cannot receive it |
| The pull request watcher                                                    | A shell script in the `creating-pull-requests` skill                                                                 |

## What the spec settles

- **The registration**: its fields, states, limits and store, who may make, end and see one, and which chats may be woken (those a mini app's message may reach today; Security is asked about the rest).
- **Firing and delivery**: `fire` saves the wake in one transaction with a `wake_chat` effect, so a restart loses nothing and a repeat doubles nothing; delivery is step 5's.
- **A new turn origin for a watcher's wake.** Its words are marked as outside words and fenced; the space side records the mark on the run when it accepts it, and a computer may only add to it.
- **`ctx.wakes`** for a mini app's server half, and its manifest grants. A tool call carries a call id the core ties to its chat; the mini app never holds a chat id. The seam contract does not change.
- **What people and agents see**: a line in the chat, two capabilities to list and cancel, and the words a person reads.
- **The six gaps of DOR-5171**, one step each, with gap 4 left for Security's ruling.
- **The first-party pull request watcher**, which ships off, what a watch costs, and where it replaces the script.

## What is left to later parts

- Moving DorkOS's own wakes onto the port, and the wakes a restart loses today: step 5's T7, which this spec needs.
- A generic "wake me when" tool in the core. The core cannot see X, so a watcher's own tool asks for the wake.
- Waking an agent's beat from an outside source: gap 4, waiting on Security's ruling.
- A person registering a watch by hand, and a way for an owner to say a watcher's words are not outside words.
- A webhook product, a database for each mini app, and publishing the author API to npm (DOR-3544).
- The contract over the wire (item 8). This spec says only what a wake needs from it.
- Moving the registration tables to the private space when it becomes a tenant (item 16), with its own ticket.
