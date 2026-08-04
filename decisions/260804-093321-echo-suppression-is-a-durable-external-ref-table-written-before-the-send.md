---
id: 260804-093321
title: Echo suppression is a durable external-ref table written before the send, never a heuristic
status: proposed
created: 2026-08-04
spec: chats-as-channels
superseded-by: null
---

# 260804-093321. Echo suppression is a durable external-ref table written before the send, never a heuristic

## Status

Proposed. To be accepted when the `chats-as-channels` spec reaches `implemented`.

## Context

Inbound messages become room posts and committed room posts get delivered to the platform, so without a suppression mechanism a stranger's message would be written to the room and then immediately sent back to the same chat. Heuristic suppression - text comparison, a time window, a recently-sent cache - fails on legitimate repeats, restarts, and races, and would occasionally send a message a person sees twice into someone else's chat, which is not recallable.

## Decision

We will suppress echoes structurally through a durable **external-ref table**: an entry written by `ingest` carries an `inbound` ref, and `deliver` skips any entry that already has a ref of either direction. `deliver` writes its `outbound` ref **before** calling the platform, with a null platform message id patched in after the send returns, so a crash between write and send yields a _suppressed retry_ (an entry that looks delivered and is not) rather than a _duplicate_ (a message a person sees twice). A row whose id is still null after the retry budget is surfaced by a `bridge_undelivered` notice, so the suppressed case is never silent, and `deliver` is idempotent on `entryId`.

## Consequences

### Positive

- No heuristic to tune or misfire: the ref table is the only mechanism, and it is exact.
- The write-before-send order fails on the recoverable side - a missing message is visible in the room and re-sendable by the person, where a duplicate in a stranger's chat is not.
- Re-bridging stays correct across archive/un-archive because the refs are never deleted, so reply targeting and echo suppression continue seamlessly.

### Negative

- A crash in the write-send window strands an entry as "delivered" until the retry budget resolves it into a visible `bridge_undelivered` notice - correct, but it means the honest failure is a delayed notice rather than an instant retry.
- Every received and every delivered message costs one small ref row, which the log carries forever by design.
