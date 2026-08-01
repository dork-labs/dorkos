---
id: 260801-003051
title: An author row belongs to the occupant it was minted for — a reused directory starts a fresh author
status: proposed
created: 2026-08-01
spec: mesh-identity-integrity
superseded-by: null
---

# 260801-003051. An author row belongs to the occupant it was minted for — a reused directory starts a fresh author

## Status

Proposed

## Context

ADR 260726-170126 keys room author identity on the agent's directory, never its manifest ULID, and accepts that a _moved_ agent splits in two. It left the inverse unhandled: `AuthorRegistry.resolve` mints purely on `(kind, naturalKey)` with no occupancy check, so registering a **new** agent in a previously-occupied directory silently inherits the previous agent's entire message history, `@handle` claims, and room memberships (DOR-790 H12). Ghost author rows are also never removed, so a relocated agent's stale row keeps claiming its handle in rosters (H11).

## Decision

We stamp each agent-kind author row with the manifest ULID of the occupant it was minted for, and treat the stamp as a generation marker, never as identity: identity stays keyed on the directory (amending, not reversing, ADR 260726-170126). When the directory's current manifest id differs from the stamp, the old row is retired (`retired_at`) and a fresh author is minted; the unique index becomes partial over active rows, so one directory has one active author and any number of retired ones. Legacy rows with no stamp adopt the current occupant rather than retiring. Only authors whose directory resolves to a live agent — and whose stamp, when set, matches it — may claim handles or receive turns; history rendering is untouched.

## Consequences

### Positive

- A reused directory can no longer reattribute someone else's message history; old entries keep their true author forever.
- Ghost authors stop shadowing live agents in mention resolution, while rosters and history still render them.
- Author ids never change and rows never delete, so every existing `authors.id` consumer (entries, members, reactions, sessions, cursors) is unaffected.

### Negative

- A schema migration (two columns, a partial unique index) and a second liveness condition in the handle/dispatch path.
- Re-initializing an agent's manifest in place (new id, same directory, same intended agent) now splits its author history — the same accepted cost shape as the directory-move split in ADR 260726-170126.
