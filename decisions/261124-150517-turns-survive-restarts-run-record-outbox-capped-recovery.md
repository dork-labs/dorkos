---
id: 261124-150517
title: Turns survive restarts; a DorkOS-owned run record, follow-up work saved with the turn, and recovery with caps
status: accepted
created: 2026-11-24
spec: null
superseded-by: null
supersedes: '260929-140932'
amends: [0264, 260812-134510, 260818-234541]
---

# 261124-150517. Turns survive restarts; a DorkOS-owned run record, follow-up work saved with the turn, and recovery with caps

## Status

Accepted (operator decision, 2026-11-24: "Sometimes a server needs to restart entirely. Therefore, we will always need some type of recovery, even if agents run in a long lived process that can restart separately from other things."). Evidence: `research/20261124_architecture-direction-review.md`.

**Amends** (each stays Accepted):

- [0264](0264-server-owned-durable-resumable-session-stream.md): its consequence "in-flight turns are lost on server restart" is retired. The trigger-only POST and the one durable stream stand; "accepted" now also means the follow-up work is saved.
- [260812-134510](260812-134510-persistent-streaming-input-sessions.md): "the persistent process does not survive a DorkOS restart. This is deliberate" is retired as a design choice. Resume as the path taken after a crash, a restart or a cold start stands, and this record relies on it.
- [260818-234541](260818-234541-a-busy-agents-message-is-held-not-refused.md): "we will keep the hold in process memory" is retired. A held room trigger becomes outbox work. Hold, don't refuse; first in, first out; no ghost prompt in a composer: all stand.

**Supersedes** [260929-140932](260929-140932-authorize-terminal-effects-from-resource-specific-cleanup-evidence.md) (proposed, never adopted). Its two rules that still hold are carried into the Decision: a timeout is not proof that work has drained, and an effect whose outcome is unknown is never retried or replayed.

**Builds on, and changes nothing in:** ADR-0310 (transcripts are owned by each runtime), ADR-0255 (a chat is bound to one runtime at first write), [260811-184735](260811-184735-server-owned-durable-message-queue.md) (an accepted message is the server's responsibility from that moment), and [260823-021312](260823-021312-interrupt-receipts-are-a-typed-vocabulary.md) (DorkOS never invents a turn ending it did not see: a run whose process died gets its ending from what DorkOS observed, the process ending, so that rule holds).

**One dependency of the test below:** [260726-234122](260726-234122-one-server-per-data-directory.md) (one server per data folder). If the computer side becomes its own process on the same data folder, that record is amended to say which process owns what.

## Context

Every agent program DorkOS runs is a child of the server process, or runs inside it (Doe), and no new server ever takes one over. When the server restarts, crashes or updates, the running turn is lost. Queued messages and the event log survive, open asks expire, and interrupted beats and scheduled runs are marked failed. What should happen next lives in memory: a hand-off waiting to post, a report owed to a parent chat, a wake that was due. A whole family of bugs is one case each of "this was lost when DorkOS restarted", fixed one at a time. T3 Code met the same problem and rewrote its turn engine around it: its lesson is that saving events is not enough if the work that follows them is driven from memory.

## Decision

We will treat a restart as a normal event that every turn must survive, and build recovery as a permanent part of DorkOS.

- **A run record that DorkOS owns.** One small record per turn: its id, status, attempt number, which runtime chat it maps to, its place in the queue, and the run it continues, if any. The words stay in the runtime's own transcript. The run record is what every device reads to say what is happening. It points at the records that already exist for a chat's birth and its runtime binding and for the live turn's tool context (ADRs 261119-055020 and 261116-065134, both still proposed); it does not copy them, so there is one answer to "which turn is live".
- **Follow-up work is saved with the turn.** When a turn is accepted, the work that must follow it (start the runtime, deliver a hand-off, report to a parent, wake a waiting chat, continue after a restart) is written in the same write as the state change, in an outbox. A worker with leases carries it out and reports the result back. "Accepted" then means "saved, with what comes next".
- **One writer per chat.** Changes to one chat are applied one at a time, in order, so two arrivals cannot race.
- **Recovery with caps.** After a restart, work tied to a dead process is dropped, never replayed: an effect whose outcome is unknown is never run again, and a timeout is never taken as proof that work has finished. A turn continues only where its runtime can resume. It continues at most three times in a row. A turn that a person stopped, or that is waiting on a person, is never continued. The queue holds until it is safe to go on. The agent is told which background work died.
- **A spike, not a promise.** We will test whether the computer side (ADR 261124-150516) can run as its own long-lived process on a Mac, runtime by runtime, so that updating the rest of DorkOS stops ending turns. That would make restarts rarer. It does not remove them, so everything above ships either way.
- **No rewrite.** The run record, the outbox and the recovery rule land behind the existing turn path, one caller at a time.

## Consequences

### Positive

- A restart loses no accepted work, and the bugs of that family stop arriving one by one.
- Status is honest on every device, because it is read from a record and not rebuilt from a stream.
- Updates can ship at any time without asking "is anything running".
- Hand-offs and reports between agents get a delivery record, which the conversation model (ADR 261017-211859) already asks for.

### Negative

- Every place that starts follow-up work from memory has to move to the outbox, and until it does there are two paths.
- A second record of a turn sits beside the runtime's transcript, and the two must agree on where a turn begins and ends.
- A continued turn is a new attempt, not the old one: work in progress inside the runtime at the moment of the restart is still lost.
- The caps are judgment calls (three tries, what counts as "safe") and will need tuning from real use.

## Alternatives considered

- **Only make restarts rare** (a separate process for the computer side, nothing else). Rejected: a reboot, a crash or an update of that process still ends the turn.
- **Replay lost work from the event log.** Rejected: an effect such as "send this message" or "start this program" may already have happened, and running it twice is worse than dropping it.
- **A unified transcript store owned by DorkOS.** Rejected again, as in ADR-0310: the run record needs a few fields about a turn, not a copy of its words.
