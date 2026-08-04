---
id: 260804-093316
title: A bound external chat projects into a room, and the room log is its shared history
status: proposed
created: 2026-08-04
spec: chats-as-channels
superseded-by: null
---

# 260804-093316. A bound external chat projects into a room, and the room log is its shared history

## Status

Proposed. Extends ADR `260726-170125` (a room is a membership-scoped durable stream). To be accepted when the `chats-as-channels` spec reaches `implemented`.

## Context

A Telegram chat bound to an agent today is a private pipe: the inbound message goes to one session, that session answers, and nothing is visible to any other session, any other agent, or the cockpit. Bind a second agent or start a second session and the two know nothing of each other — the "many-sessions-one-chat" gap. Every surveyed product keys the session on the chat identifier ("the chat IS the thread") and so cannot let a second worker speak into that chat coherently. DorkOS already owns a durable, multi-participant, mixed-runtime stream, so the missing piece is plumbing, not a new primitive.

## Decision

We will make a bound chat **project into a DorkOS room**: inbound platform messages become room posts, the room's existing per-`(room, agent)` turn machinery answers them, and any session of the bound agent that posts into the room has its post delivered back out to the platform. The room log — durable, DorkOS-owned, never trimmed — is the single shared history every future turn reads before it speaks. Projection is one-directional with provenance, never a sync: the room is authoritative and the platform is one of its windows.

## Consequences

### Positive

- One durable history that every session of the bound agent reads, so a second worker can speak into the chat coherently — the gap no surveyed product closes.
- The chat is no longer invisible: a conversation with your own agent on your own machine now leaves a DorkOS-owned record.
- Rides shipped machinery (the durable room stream, the dispatcher, structured room context); no new wire schema, subject grammar, or runtime seam.

### Negative

- A new class of write path into rooms (the bridge) that must be held to the room's own invariants (membership, addressing, the untrusted fence).
- Storage grows by one entry plus one small ref per received message, and the log is never trimmed by design — bounded only by the ingest ceiling, which refuses rather than trims.
