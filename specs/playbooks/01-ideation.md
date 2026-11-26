---
slug: playbooks
number: 261126-031049
created: 2026-11-25
status: specified
---

# Playbooks

**Slug:** playbooks
**Linear:** epic DOR-5156; spec ticket DOR-5181; the run record's playbook slot DOR-5187
**Decision:** ADR [`261124-152801`](../../decisions/261124-152801-a-playbook-sets-how-agents-work-together.md)
**Roadmap:** `meta/ROADMAP.md` item 18. Stage 1 needs item 17's seat work too (steps MS2 and MS3), because a placed thread runs in a seat of its own. Needs items 4 and 6 (every act of working together is a capability on every runtime, behind one gate; spec [`computer-side-starts-alone`](../computer-side-starts-alone/02-specification.md)), item 5 (the turn port and the run record; spec [`turns-survive-restarts`](../turns-survive-restarts/02-specification.md)) and, for work that moves, item 17 (every chat is a conversation; spec [`one-message-system`](../one-message-system/02-specification.md)).
**Status:** specified. The plan is [02-specification.md](02-specification.md).

## What and why

A founder wants to say how a team of agents works: answer fast and do longer work in the agent's own chat; or keep all work in the room it was asked in; or give each piece of work its own channel. Today that choice is not a thing anyone can pick. It is a paragraph of prompt text in two places, a tool only Claude Code agents have, and a few room settings that nothing groups.

ADR `261124-152801` settles the direction: a **playbook** is a named setting of a space with three parts (words the agents are told, rules DorkOS holds, defaults DorkOS applies), held at DorkOS's own gate and turn port, never in one runtime's hooks. A run keeps the playbook it started under. What DorkOS cannot hold, it says.

The heart of it is one question with the same answer on every runtime: when an agent starts a piece of work, where does that work happen, and where does it report? The first three playbooks are three answers to it.

## What is built today

| Piece                                | State                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Words about working together         | Fixed text: the room working rules every runtime gets, and a block about helpers and spin-off chats that only Claude Code gets    |
| Starting a spin-off chat             | A hand-registered tool, `session_start`, on Claude Code and the outside MCP server; item 6 makes it a capability on every runtime |
| Posting, messaging, making a room    | Capabilities on every runtime (`rooms.post`, `chat.send`, `rooms.create`)                                                         |
| The gate                             | One decision with two entry points; it can allow, ask, refuse or hold, and refuse early through a shared registration point       |
| Sending an act somewhere else        | Only inside rooms: another chat's post goes to the agent's seat                                                                   |
| The run record's playbook field      | A column and a start-request field, both always empty                                                                             |
| A setting that picks how agents work | None                                                                                                                              |
| A runtime's own helpers              | Started inside the runtime, seen by DorkOS through each runtime's events, never decided by DorkOS                                 |

## What the spec settles

- **A playbook as data**: words for each kind of place a turn runs in, rules of three kinds (place, report, route), defaults of two kinds (work channel, origin updates), an immutable version.
- **The three first playbooks**, written out in full: Quick answers (today's behaviour and today's words), Everything in rooms, and A channel for each piece of work.
- **Levels**: a space, a room, an agent's exception; the nearest wins, whole; one line says which and why.
- **The gate's fourth outcome**, "sent elsewhere", with its result for the agent, the audit record and the app.
- **The turn port**: admission stamps each run with one playbook version; continuations keep it.
- **A piece of work**: no new object; the place it happens, the run record's "who asked", and one record in the playbooks store, mirrored to the work graph as one new relation. A placed thread or channel works under the playbook that placed it, and a placed thread has a seat of its own, so the agent still answers in the room.
- **Storage, capabilities and who sets a playbook**: only a person. An agent that thinks another playbook would fit says so in its own words.
- **What a person sees**, and what DorkOS cannot hold, by runtime.
- **Stage 2, work that moves**, from a chat into a thread or a channel, once every chat is a conversation.

## What is left to later parts

- Playbooks from marketplace packages, and an editor for custom playbooks.
- A project level, since no project exists in code.
- Hosted and community spaces, after the Community Space opens.
- Tying a channel to a workspace.
- Loop limits between agents (DOR-2745).
- Onboarding or DorkBot proposing a playbook.
