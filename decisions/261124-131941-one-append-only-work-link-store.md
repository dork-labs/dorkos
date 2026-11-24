---
id: 261124-131941
title: One append-only edge store for the work graph, keyed by entity references and written at the moment of action
status: proposed
created: 2026-11-24
spec: null
superseded-by: null
amends: null
---

# 261124-131941. One append-only edge store for the work graph, keyed by entity references and written at the moment of action

## Status

Proposed (DOR-4968, W2 of the work graph DOR-4966). Drafted in [`research/20261121_architecture-target-design.md`](../research/20261121_architecture-target-design.md), "The work graph". The first table and its first two write sites (a chat's re-key and a fork) land with it. The PM accepts it once the later write sites are scheduled.

## Context

Chats start chats, open pull requests, claim tickets and make worktrees. Each fact is written in a different place or not at all. The parent link (`session_started_by`) is the only durable edge. Nothing on this computer records which pull request a chat opened. Two more facts come from the address design ([261122-124821](261122-124821-one-dork-reference-ids-for-machines-addresses-for-people.md)): a fork gets a new id, and a new chat's first id gives way to its runtime's ([ADR-0267](0267-canonical-session-id-in-url.md)). The in-memory redirect for that second one is lost on a restart, so an old reference in a PR body stops resolving.

## Decision

We will keep one append-only edge table, `work_links`, in this computer's SQLite store. Each row is one fact: from a reference, a relation, to a reference, when, the recording chat, and which code wrote it. Both ends are `EntityRef`s from `@dorkos/shared/entity-ref`, stored in one canonical text spelling that round-trips every kind. The relations are `started`, `claims`, `opened`, `works_on`, `belongs_to`, `produced`, `forked_from` and `rekeyed_from`; new ones are added, never reinterpreted. The code that performs an action records its edge at that moment. A failed write is logged and never fails the action. An exact repeat records nothing. Reads go through the store: by either end, and `resolveRekey`, which follows `rekeyed_from` edges to a chat's current id.

## What it does not change

- Transcripts stay runtime-owned ([ADR-0310](0310-runtime-owned-session-storage-aggregated-listing.md)), and agent identity stays file-first ([ADR-0043](0043-file-canonical-source-of-truth-for-mesh-registry.md)).
- The audit trail stays the record of actions. This table records their results.
- `work_claims` stays the claim lock. `session_started_by` stays the parent record until the lineage query (W3) reads both.
- The table holds ids and names only: no path, hostname or message text. A worktree is stored by its folder name.

## Consequences

### Positive

- One place answers "what did this chat make, and what does it work on", and later views (W3 to W5) read it without new tables.
- An old chat id still resolves after a restart.

### Negative

- Each later write site (a spin-off start, a PR opened, a claim, a worktree) is its own change, and the graph has gaps until they land.
- It lives in the machine store, which is the wrong home under the one space model ([261122-173853](261122-173853-one-space-model.md)). Its move to the space store is DOR-5139.
- Append-only means it only grows. Edges are small rows of ids, but pruning becomes a later decision.
- Open: whether a hub mirrors a Mac's pull request and ticket edges when the relay is on.
