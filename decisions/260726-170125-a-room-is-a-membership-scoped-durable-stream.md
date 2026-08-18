---
id: 260726-170125
title: A room is a membership-scoped durable stream, not a session
status: accepted
created: 2026-07-26
spec: rooms
superseded-by: null
---

# 260726-170125. A room is a membership-scoped durable stream, not a session

## Status

Accepted. **One clause is retired by**
[260728-022013](260728-022013-a-thread-is-a-relation-between-entries.md) (A thread is a relation
between entries, not a child room). **One READING of a second clause is retired by**
[260818-234541](260818-234541-a-busy-agents-message-is-held-not-refused.md) (A busy agent's message
is held, not refused) — see the note at the end of this section.

**Exactly one clause below is retired:** "A **thread is a child room** — the same entity with a
parent, one level deep." A thread is now a set of entries in the same room pointing at a common root
entry, with no room row, no roster and no place in a room list. The related Positive bullet
("Threads cost one nullable `parentId`") and the related Negative bullet ("A thread of a thread has
no representation") go with it. Read those three passages as history.

**Everything else here stands and is still the governing decision:** a room is a membership-scoped
durable stream; a room is not a session and N agents in a room are N sessions on one stream, each
keeping its own runtime binding; membership is where per-room state lives, carrying the
`(member, room)` read cursor and the `responseMode` override; the log is turn-atomic, DorkOS-owned
and never trimmed; rooms carry addressing and atomicity but never a concurrency primitive; a room
may reference a workspace; signing is reserved. **That is why this ADR stays `accepted` rather than
`superseded`:** the status tells a reader whether to rely on the document, and almost all of this
one is still load-bearing for the rooms programme. 260728-022013 records the reasoning in full.

**The second amendment retires an inference, not a sentence.**
[260818-234541](260818-234541-a-busy-agents-message-is-held-not-refused.md) retires the reading of
"**Rooms carry addressing and atomicity, never a concurrency primitive**" under which a room must
_refuse_ a message for an agent that is mid-turn in a different room. That clause's own words all
stand — no room-scoped write lock, no room turn policy, write coordination keyed on the resource —
and so does its DOR-500 conclusion that tree-sharing is the collision and the tree is what a lock
must be keyed on. What changes is only what the dispatcher does when a ceiling holds: the message is
now **held** for the agent's next free moment rather than refused with a line asking the person to
send it again. Holding takes no lock, starts no second turn, and orders no two agents against each
other; the Positive bullet "Rooms stay out of the concurrency business" is therefore unaffected.
Read `room-trigger.ts`'s old citation of this ADR for "refusing rather than queueing" as history.

## Context

Phase 1 of the multi-participant message list (DOR-455) gave every message an author, so the list can already render four participants correctly. What it cannot do is contain them. A conversation in DorkOS is still a **session**: one runtime, one working directory, one transcript, one human talking to one agent. Channels, DMs and threads all need a container that several participants belong to and that outlives any one of them.

The obvious move — make the container a session and multiplex participants inside it — does not survive contact with the codebase. Sessions are bound to a runtime at first write and the binding never changes (ADR-0255), and session storage is runtime-owned with no unified DorkOS transcript (ADR-0310). A room holding a Claude Code agent and a Codex agent cannot be one session, because there is no single runtime that could own it.

The shape below was settled by `research/20260724_multi-user-communities.md` and a six-document review exchange between two agents, during which three of the four most confidently asserted claims turned out to be wrong and were caught by reading source rather than by arguing. What survived is recorded here.

## Decision

We will model a **room** as a membership-scoped durable stream.

**Structure.** A room has an id, a `kind` (`channel` | `dm` | ~~`thread`~~), a roster of **memberships**, ~~an optional parent room,~~ and a durable append-only log. ~~A **thread is a child room** — the same entity with a parent, one level deep — so threads need no second model, and the "N replies" summary row is a projection of the child's log rather than a new storage concept.~~ **[Retired by [260728-022013](260728-022013-a-thread-is-a-relation-between-entries.md); struck through here rather than only in the Status above, because the Status note's own recorded risk was that this sentence would be quoted without it. A thread is a set of entries in one room pointing at a common root; `rooms.parent_id` and `rooms.root_entry_id` were dropped in migration 0038.]**

**A room is not a session; sessions post into it.** Three agents in a room are three sessions on one stream. Each session keeps its own runtime binding, working directory, context window and lifecycle; the room owns only the shared stream and the roster. This is what makes a mixed-runtime room possible at all, and it means a room can survive every session in it ending.

**Membership is where per-room state lives.** A membership binds an author to a room and carries the state that is meaningful only in that room: the read cursor, the join time, and the addressing override below. The **read cursor is keyed `(member, room)`** — not per client, not per session.

**Addressing is per membership.** `AgentBehaviorSchema.responseMode` (`packages/shared/src/mesh-schemas.ts:62`) already ships the right enum — `always | direct-only | mention-only | silent` — but it sits on `AgentManifestSchema.behavior` (`:137`), which makes it a single global property of the agent. One agent belonging to several rooms needs to be `always` in its own DM and `mention-only` in a busy channel. So **a membership carries a `responseMode` override and the manifest value is the default**. Same enum projected onto a second scope, not a second model. The override is written explicitly at join time — seeded from the manifest for a DM, seeded to `mention-only` for a channel — so the stored value is always inspectable and there is no dynamic rule to reason about.

**The log is turn-atomic, and the boundary already exists.** Three categories of thing travel through a room, and only the first is a log entry:

| Category                | Durable? | Examples                                                                                                                                  | Where it lives                           |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Turn-atomic log entries | yes      | a completed post by a member                                                                                                              | the room log                             |
| Ephemeral signals       | no       | typing, presence, read/delivery receipts, progress, backpressure (`SignalTypeSchema`, `packages/shared/src/relay-envelope-schemas.ts:21`) | live delivery only, dropped on replay    |
| Pending interactions    | yes      | approvals, questions (ADR-0262)                                                                                                           | their own store, projected into the room |

The entry granularity is the turn boundary DorkOS already synthesizes. `feedProjector` (`apps/server/src/services/session/session-event-normalizer.ts:478-520`) emits `turn_start` before ingesting an adapter's stream and closes with `turn_end`, for every runtime — no adapter decides where a turn begins or ends, and its own docstring says so. Terminal classification _is_ runtime-supplied (Codex attaches `terminalReason`), but the normalizer carries an error latch (`:488-500`) that fills an undefined reason for the OpenCode/Codex crash paths. So the room log inherits a boundary that is uniform across all three runtimes, and inherits exactly one gap: a hard process death with no `turn_end` at all, which is the same gap the session log already lives with.

**The room log reuses that boundary but is its own store.** It is not the session event log, and that is not a naming preference — the session log is not durable enough to be a room's record:

- `SessionEventStore` carries no history for claude-code — the default runtime. Its history is SDK JSONL and its `EventLog` is gap-replay overflow only (`apps/server/src/services/session/session-event-store.ts`, ADR 260710-024641). _(Amended by [260731-211050](260731-211050-a-room-driven-claude-code-turn-leaves-a-record.md): a room-driven claude-code session does now write to `session_events`, but only each turn's boundary and error events, as diagnostic evidence that a turn ran. Nothing reads them as history, so the conclusion below is unchanged.)_
- `EventLog` is in-memory and capped at `EVENT_LOG_MAX_EVENTS = 5000`, trimming oldest on overflow (`event-log.ts:26,33-38`), and `SessionEventStore` trims to the same cap per session (`:91,167-182`).

A room whose messages vanish after 5000 events, or that keeps no record at all on the default runtime, is not a room. So room entries land in a DorkOS-owned durable store, on the same reasoning that already puts reactions and the thread registry in a sidecar: DorkOS cannot write into runtime-owned storage, so anything DorkOS must guarantee has to live where DorkOS owns it. The session log stays what it is — the live transport for one session's turn — and a room entry is written at the same `turn_end` the persisted session store already flushes on (`appendTurn`).

The rule this encodes: **a room-log entry is what another member should be able to read later.** In-flight token deltas are not that.

**Rooms carry addressing and atomicity, never a concurrency primitive.** There is no room-scoped write lock and no room turn policy. Write coordination is keyed on the resource — a containment relation over paths — because the hazard is one working tree with many sessions, which a room-shaped lock neither covers nor bounds. DOR-500 measured this directly: at 6 concurrent agents on one tree, 57 / 6 / 18 canary lines of 360 survived across three runs, against 43 / 55 / 61 of 180 per tree when the same 6 agents were split across two trees. Halving agents-per-tree roughly doubles survival. **Tree-sharing is the collision, so the tree is what a lock must be keyed on.** (Read that number as an interleave rate, not a corruption rate — the canary is a deliberately non-atomic read-modify-write, and an atomic writer loses nothing on the same workload. See `research/20260725_q3-contention-preregistration.md`.)

**The room is a projection surface for state owned elsewhere.** A claim on a work item lives on the work item; the room renders it. A lock lives with the resource; the room renders it. Anything a room appears to own that outlives the conversation is owned somewhere else.

**A room may reference a workspace.** The association is a field on the room, not a new kind of thing — a channel-owned tree is still a tree that happens to have a channel attached. Mechanics are `specs/channel-workspace`.

**Signing is deferred but not designed out.** We reserve the envelope field and fix the canonical serialization now, so message signing (research decision 7) lands later without a migration.

## Consequences

### Positive

- A mixed-runtime room is possible, because the room never has to pick a runtime.
- Threads cost one nullable `parentId`, not a second conversation model, and thread-summary rows fall out as a projection.
- The atomicity boundary is inherited rather than invented, so rooms do not add a per-runtime concept and cannot drift from the session log.
- Addressing reuses a shipped enum on a new scope; an agent's room behavior is a stored, editable row rather than an emergent property of its manifest.
- The read cursor becomes meaningful for the first time: `(member, room)` is the thing an unread divider was always trying to express, and it survives changing clients.
- Rooms stay out of the concurrency business, which is where the measured hazard actually is and where a room-shaped answer would have been wrong.

### Negative

- **A room and a session are now two lifecycles that can disagree.** A room outlives its sessions by design, so "the conversation is alive but nothing in it is running" is a state the UI has to render honestly rather than hide.
- Membership rows duplicate a default that already exists on the manifest. Changing an agent's manifest `responseMode` does not retroactively change rooms it has already joined — correct, but it will surprise someone.
- The hard-process-death gap is now visible in a second place. It was tolerable for a session log a single person was watching; in a shared room, a turn that vanishes without a `turn_end` is a message another member never sees and cannot know they missed.
- One level of threading is a real ceiling, chosen to match Slack and Matrix. A thread of a thread has no representation and will eventually be asked for.
- Reserving a signature field costs a column and a canonicalization rule that nothing reads yet — dead weight until phase 4, and dead weight that must stay correct in the meantime.
