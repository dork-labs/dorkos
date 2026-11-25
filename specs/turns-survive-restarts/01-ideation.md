---
slug: turns-survive-restarts
number: 261124-194924
created: 2026-11-24
status: specified
---

# Turns survive restarts: ideation

**Linear:** DOR-5153 (epic), with DOR-5157, DOR-5159, DOR-5160 and DOR-5161. **Carries out:** ADR [`261124-150517`](../../decisions/261124-150517-turns-survive-restarts-run-record-outbox-capped-recovery.md). **Specification:** [02-specification.md](02-specification.md).

## The problem

Every agent program DorkOS runs is a child of the server, or runs inside it (Doe). When the server restarts, crashes or updates, the running turn dies with it. What DorkOS saved survives: queued messages (`session_message_queue`), the event log (`session_events`), and the rows of a few outboxes. What DorkOS meant to do next does not, because it lives in memory:

- a room trigger waiting for its agent (`held`, `apps/server/src/services/rooms/room-trigger.ts:274`), and every dispatch made with `whenBusy: 'refuse'` or `'refuse-foreign'` (`apps/server/src/services/session/message-dispatcher.ts:84-95`);
- the line a room gets when its agent stayed quiet (`apps/server/src/services/rooms/room-trigger/deliver.ts`), driven from the in-memory claim;
- a wake that was due: a hand-back (`services/session/local-browser/hand-back-wake/index.ts`), a sign-in resume (`services/mesh/mcp-signin-resume.ts:204`), an approval verdict after its claim;
- the turn itself, and anything a person would need to hear about it.

Each lost case has been fixed by hand, one at a time (DOR-3816, DOR-5087, DOR-3231, DOR-4626, DOR-4148). Status on a second device is rebuilt from a stream, so after a restart it can say "working" about a turn that died. Scheduled runs and the relay path start turns without the dispatcher at all (`services/tasks/task-scheduler-service.ts:1412`, `packages/relay/src/adapters/claude-code/agent-handler.ts:642`).

The operator's ruling (ADR `261124-150517`): restarts will always happen, so recovery is a permanent part of DorkOS, and it must not be a rewrite.

## Options weighed

1. **Make restarts rare.** Run the computer side as its own long-lived process so a DorkOS update does not end turns. Rejected as the answer (kept as the spike DOR-5162): a reboot, a crash or an update of that process still ends the turn, so recovery is needed anyway.
2. **Replay lost work from the event log.** Rejected: "start this program" or "send this message" may already have happened, and running it twice is worse than dropping it. The event log also does not hold intent, only what was streamed, and Claude Code chats do not persist to it at all (ADR `260710-024641`: claude-code opts out).
3. **T3 Code's rewrite.** One event-sourced orchestrator, a pure decider, a transactional outbox, per-thread serialization, capped recovery (`.temp/coord/architect/review-t3code.md`). The mechanisms are right; the delivery was not: one PR of +380,729 lines open four months, a one-way database copy, a 17,673-line decider, a lockstep protocol bump. Rejected as a method, mined for its rules.
4. **A unified DorkOS transcript store.** Rejected again, as in ADR-0310. A turn needs a few fields of state, not a copy of its words.
5. **A small run record, an outbox saved in the same write, capped recovery, landed behind today's turn path one caller at a time.** Chosen.

## Why this one

- **The pieces already exist in parts.** The room hand-off outbox recovers by marking claimed rows `interrupted` and never replaying them (`services/rooms/handoff/outbox/handoff-outbox-store.ts:171-182`). Private message receipts quarantine an attempt a previous boot may have sent as `outcome_unknown` (`services/session/private-messages/acceptance.ts:463-503`). The doc channel leases its batches (`packages/db/src/schema/canvas/channel.ts:145`). The dispatcher is already the single ingress for most turns, with a test that holds the line (`services/session/__tests__/dispatcher-single-ingress.test.ts`). The plan generalizes these instead of adding a parallel system.
- **One SQLite file, one process, today.** On a Mac the space side and the computer side share `dork.db`, so "saved in the same write" is one `better-sqlite3` transaction. Most follow-up effects (a room line, an inbox row, a new run) are writes to that same file, so today they can be done exactly once. That rests on one file, so every target row also gets a unique key that keeps the write safe to repeat once the run tables move to the space store.
- **It is the seam the next steps need.** The turn port is the in-process form of the contract for agent computers (`packages/shared/src/session-relay-agent-computer.ts`). Roadmap item 6 (a computer side that starts alone) needs it, and so do account failover at the turn port (DOR-5190), the memory budget (DOR-5192) and playbooks (DOR-5187).
- **Honest status.** Every device reads one record per turn. A turn whose process died says so, with the ending DorkOS observed (ADR `260823-021312`: never invent an ending).

## Decisions this spec makes (beyond the ADR)

- The run record's id is the `turn` kind of the `dork:` reference (`dork:turn:<id>`, `packages/shared/src/dork-ref.ts:33-44`). The `run` kind stays the task run's.
- The run record is space-side data kept in the machine store for now, behind a store only `services/runs` touches; its move to the space store is a named ticket.
- The outbox is one leased worker and one lease rule. Its generic store is one new table, `turn_effects`, which holds references and never a person's or agent's words. The two room outboxes join the same worker; the message queue stays where words wait.
- Claim only what works, and withdraw nothing that works. Two capabilities, named apart: `wakesForLostBackgroundWork` (today's Claude Code wake after a restart for a turn that had already ended, kept exactly as it is) and `continuesInterruptedTurn` (a turn killed mid-turn continues; `false` for every real runtime until its measured run is recorded). A mocked conformance case proves only DorkOS's plumbing.
- A person's queued message never expires by the clock; only follow-up effects carry a deadline.
- "In a row" means in one chain: an original turn and its continuations get at most three continuations in total, with no time window to reset the count.
- Words are held until the runtime's first event for the turn (`delivered`). If the server dies between the turn starting and that event, the words come back as a draft and are never replayed.
- The port's start carries the words inline, as the wire's `turn.start` does; waiting is decided on the space side before anything reaches a computer.
