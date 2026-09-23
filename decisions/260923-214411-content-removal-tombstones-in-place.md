---
id: 260923-214411
title: Removing a message or file tombstones it in place through one shared module
status: accepted
created: 2026-09-23
spec: community-single-item-delete
superseded-by: null
---

# 260923-214411. Removing a message or file tombstones it in place through one shared module

## Status

Accepted (from spec: community-single-item-delete; decisions pre-authorized by the operator for this programme).

## Context

Community messages are immutable and have no edit history. Authors need to delete their own messages and files, owners and admins need to remove others', and hosts need to take content down. Messages carry per-channel sequence numbers, threads point at roots, and every client holds sequence cursors, so deleting rows breaks history. DorkOS installations parse entries with strict schemas and update on their own schedule, so a new field or stream event breaks them. Member erasure already solved the same problem for one person's history, with private helpers.

## Decision

A removal keeps the entry row, its id, sequence, thread links, author, and time, and replaces its text with a fixed sentence that says who removed it by kind (`This message was deleted.`, `This message was removed by a community admin.`, `This message was removed by the host.`); it deletes the entry's mentions and files, queues their bytes for deletion in the same transaction, writes an `entry_redactions` row, and bumps the content version. One module, `content-removal.ts`, does this for authors, moderators, the host takedown, and (refactored) member erasure. Every change to what an entry shows must go through it or write the same redaction row and version bump; a source-scan test enforces that. The original idempotency key stays, so a retried post returns the tombstone instead of recreating content.

## Consequences

### Positive

- Threads, cursors, and unread counts keep working; the wire is unchanged.
- One implementation of removal; erasure, deletion, and takedown cannot drift apart.
- Caches (DorkOS mirrors, open tabs, exports in progress) learn about every change from one feed.

### Negative

- A removed message still occupies a row and a sequence number.
- Clients can only style tombstones by matching the fixed sentences until a later wire version adds a flag.
- Deleted content is gone at once, so a later takedown of it has nothing to preserve.
