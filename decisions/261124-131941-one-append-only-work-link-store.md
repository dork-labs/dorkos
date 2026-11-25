---
id: 261124-131941
title: One append-only edge store for the work graph, keyed by entity references and written at the moment of action
status: accepted
created: 2026-11-24
spec: null
superseded-by: null
amends: null
---

# 261124-131941. One append-only edge store for the work graph, keyed by entity references and written at the moment of action

## Status

Accepted (2026-11-25; DOR-4968, W2 of the work graph DOR-4966). Drafted in [`research/20261121_architecture-target-design.md`](../research/20261121_architecture-target-design.md), "The work graph". The table and its first two write sites (a chat's re-key and a fork) are built, and the `/r/` link resolver reads it. Its condition for acceptance was that the later write sites be scheduled, and they are: a chat that starts a chat (DOR-5263), a pull request a chat opens and the tickets it names (DOR-5264), a worktree (DOR-5265), a to-do or a promise (DOR-5266) and claims (DOR-4972).

## Context

Chats start chats, open pull requests, claim tickets and make worktrees. Each fact is written in a different place or not at all. The parent link (`session_started_by`) is the only durable edge. Nothing on this computer records which pull request a chat opened. Two more facts come from the address design ([261122-124821](261122-124821-one-dork-reference-ids-for-machines-addresses-for-people.md)): a fork gets a new id, and a new chat's first id gives way to its runtime's ([ADR-0267](0267-canonical-session-id-in-url.md)). The in-memory redirect for that second one is lost on a restart, so an old reference in a PR body stops resolving.

## Decision

We will keep one append-only edge table, `work_links`, in this computer's SQLite store, with each row one fact: a reference, a relation, another reference, when, the recording chat and the code that wrote it. Both ends are `EntityRef`s from `@dorkos/shared/entity-ref`, stored in one canonical text column each, and database triggers refuse every update and delete. The code that performs an action records its edge at that moment; a failed write is logged and never fails the action, and an exact repeat records nothing. The store is space data; turn code reaches it only through hooks or events, so DOR-5139 is a store move, not a rewrite.

## Alternatives considered

- **A kind and an id column for each end.** It would follow `entity-ref`'s own advice for a branch or a worktree, which have no text spelling. We chose one canonical text column per end instead: one index per end serves "everything about this thing", and a stored ref reads the way it is written everywhere else (`dork:chat:<id>`, `DOR-1234`). The `branch:` and `worktree:` prefixes are a storage encoding private to the server's `work-link-ref.ts`, not a public spelling, and they round-trip losslessly; a test covers every kind.
- **Extending `session_started_by`.** It holds one parent per started chat and is the counter for an extension's start limits. Pull requests, tickets, forks and re-keys are not starts, and widening it would mix a limit's counter with a general record.
- **Using the audit trail.** It records actions, with an actor, outcome and visibility for each, and its rows are hash-chained. A graph query over "what this chat made" would have to parse those rows, and a re-key or a fork is a result, not an action anyone audits.

## What it does not change

- Transcripts stay runtime-owned ([ADR-0310](0310-runtime-owned-session-storage-aggregated-listing.md)), and agent identity stays file-first ([ADR-0043](0043-file-canonical-source-of-truth-for-mesh-registry.md)).
- The audit trail stays the record of actions. This table records their results.
- `work_claims` stays the claim lock. `session_started_by` stays the parent record until the lineage query (W3) reads both.
- The table holds ids and refs only, never message text. A worktree is stored by its folder name. A branch name is stored as given, so write sites must not pass private names.

## Consequences

### Positive

- One place answers "what did this chat make, and what does it work on", and later views (W3 to W5) read it without new tables.
- An old chat id can be resolved after a restart (`resolveRekey`). The `/r/` link resolver (DOR-5046) is its first reader.

### Negative

- Each later write site (a spin-off start, a PR opened, a claim, a worktree) is its own change, and the graph has gaps until they land.
- It lives in the machine store, which is the wrong home under the one space model ([261122-173853](261122-173853-one-space-model.md)). Its move to the space store is DOR-5139.
- Append-only means it only grows. Edges are small rows of ids, but pruning becomes a later decision.
- Open: whether a hub mirrors a Mac's pull request and ticket edges when the relay is on.
