---
id: 260808-140954
title: Threads are durable; sessions are engine runs beneath them
status: accepted
created: 2026-08-08
spec: team-room-home
superseded-by: null
amends: null
---

# 260808-140954. Threads are durable; sessions are engine runs beneath them

## Status

Accepted (2026-08-08) — documents the split that already exists in code; realized further by the team-room-home programme (P0 shipped RP3 cursor mechanics, DOR-665).

## Context

DorkOS has two conversation surfaces with different durability owners. Direct agent chats ride
the runtime-owned session transcript (ADR-0310). Rooms and DMs ride the append-only room log
(`room_entries`), with a session bound per `(room, agent)` underneath. This split already
exists in code, but nothing blesses it, and the team-room-home program makes the room log the
user's home surface — so who owns the durable conversation must be explicit.

## Decision

We will treat the split as the contract. In rooms and DMs, the **thread** (the room log) is the
durable conversation; the sessions beneath it are disposable engine runs that may be swapped or
lost — agents rebuild context from the log (RP3 push, later RP7 pull), anchored on the
membership cursor, which survives session swaps because it lives on the membership row. In
direct agent chat (`/session`), the **session** stays the durable thing — deliberately kept.
The where-you-reply rule routes continuation: the place you reply from decides what continues;
task-triggered and externally-originated sessions never hijack the home composer.

## Consequences

### Positive

- Session swaps under a room thread are invisible to users; context stales gracefully.
- No migration: documents what the code already does; direct chats untouched.
- One clear answer to "which conversation continues?" for every composer.

### Negative

- Two durability models coexist permanently; new features must ask "thread or session?" first.
- Fresh sessions under a thread need a bootstrap push window (a cursor alone is not enough).
