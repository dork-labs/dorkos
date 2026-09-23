---
id: 260923-134614
title: Erasure tombstones a member's history in place and deletes everything else
status: proposed
created: 2026-09-23
spec: community-member-erasure
superseded-by: null
---

# 260923-134614. Erasure tombstones a member's history in place and deletes everything else

## Status

Proposed (from spec: community-member-erasure)

## Context

A Community member can leave or be removed, but their name, handle, account link, messages, files, and mentions stay forever. Hosts serving the EU or California must be able to erase a person. Entries are sequence-numbered per channel, threads point at their roots, and every client holds seq-based cursors, so deleting rows would break other people's history. Every DorkOS installation parses the entry and event wire with strict schemas and updates on its own schedule, so a new wire field or event type would make older installations reject every entry. Each installation also keeps its own mirror of the rooms it reads, indexed by message search.

## Decision

An erased entry keeps its row, id, seq, channel, parent, thread root, and time. Its text becomes `This message was erased.`, its author name `Erased member` or `Erased agent`, its idempotency key and payload hash are replaced, and its mentions and attachments are deleted. The member row and each of their agents become a de-identified husk (fixed name, random handle, no account link, inactive) so foreign keys and audit rows stay valid while leading to no one. The old handle is released, so every `@handle` token for the person or their agents in other people's messages is rewritten to `@[erased]`, which can never resolve as a mention. Attachments, connection grants and pairings, agent credentials, admission links, and every live export in the community are hard-deleted, blobs through the existing inventory. The wire is unchanged: a tombstone is an ordinary entry. A new pull-only redaction feed lists changed entries with their current projection, so DorkOS installations that know it replace their cached copies and re-index search; older ones never call it.

## Consequences

### Positive

- Threads, replies, cursors, and unread counts keep working for everyone else.
- Every installation, old or new, renders tombstones with no change.
- One idempotent procedure per member id serves self-service, owner requests, worker restarts, and re-application after a backup restore.
- The residue can be tested exhaustively by scanning every column the schema has.

### Negative

- Clients cannot style a tombstone differently until a later wire version adds a flag.
- Free-text names and quotes in other people's messages are not found.
- Open browser tabs keep old text until they reload; offline or old DorkOS installations keep their copies.
- `members.user_id` becomes nullable for erased husks, which every inner join to `"user"` must tolerate.
