---
id: 260726-170126
title: Persisted author identity is an opaque id keyed on the agent's directory, never its ULID
status: accepted
created: 2026-07-26
spec: rooms
superseded-by: null
---

# 260726-170126. Persisted author identity is an opaque id keyed on the agent's directory, never its ULID

## Status

Accepted.

## Context

Phase 1 of the multi-participant message list gave every message an author, and it picked the obvious key: `resolve-message-author.ts:101-104` returns `{ kind: 'agent', id }` straight from `ctx.agent.id`. That id is the agent manifest's ULID — `AgentManifestSchema.id`, documented as "ULID assigned at registration" (`packages/shared/src/mesh-schemas.ts:128`).

Agent storage is file-first with a derived SQLite cache reconciled every five minutes (ADR-0043), and the reconciler may rebuild an agent's row under a **fresh ULID**. So the manifest id is stable enough to address an agent right now and not stable enough to name one forever.

This is latent today and only today. `MessageAuthor` is a client-derived view model — it is declared in `apps/client/src/layers/shared/model/chat-message-types.ts:46` and nothing persists it — and `build-list-rows.ts:178` only ever compares two authors within one render pass, so a re-minted ULID changes every message's author id together and the grouping still looks right. It stops being latent the instant anything writes an author id down: a reaction row, a room membership, a participant list, a read cursor. All four are in the room model (ADR 260726-170125), so this must be settled before that model persists anything.

DOR-446 already hit this and already introduced the answer: `agentPath`. `packages/db/src/schema/agent-identity.ts:18` describes it as "the stable filesystem identity the reconciler preserves," and `agents.project_path` is `NOT NULL UNIQUE` (`packages/db/src/schema/mesh.ts:9`), enforced by a migration test (`packages/db/src/__tests__/migrations.test.ts:109`).

## Decision

We will persist author identity as an **opaque `authorId`, minted once and resolved through a natural key**. For an agent, the natural key is its `agentPath`. The ULID is never written into an author column.

The indirection is doing real work and is not ceremony over the path:

- **A raw path is not a human's key.** Accounts land later and need the same column. One opaque id with a kind and a natural key holds humans, agents and the system; a path holds only agents.
- **A raw path leaks the filesystem into the wire format.** A room is a shared surface, and the community direction makes some of those rooms shared with other people. Every message, reaction and roster entry would otherwise carry `/Users/dorian/…` to every member. That is a privacy defect we would have to undo later under migration.
- **Mint-on-first-use is what makes it survive reconciliation.** When the reconciler rebuilds an agent under a fresh ULID, the `agentPath` is unchanged, the lookup hits the existing row, and every message that agent ever wrote still resolves to the same author.

We adopt `agentPath` rather than inventing a key because the codebase already made this choice once: agent identity tokens are keyed on it, and revocation is deliberately an `agentPath`-wide sweep rather than a single-row delete (`packages/db/src/schema/agent-identity.ts:27-31`). A second identity story for the same entity would be strictly worse than reusing the one that already survives the reconciler.

For the local human, v1 mints exactly one author row. Accounts do not exist yet, and `HUMAN_AUTHOR_ID` is a constant today (`resolve-message-author.ts:95`); the row gets an account binding when accounts land, without moving any message.

`session_metadata.agent_path` is already written on every session and read by nothing. This gives it its first reader.

## Consequences

### Positive

- Author identity survives the five-minute reconciler, which the ULID does not. This is the whole point.
- Rooms can persist memberships, reactions, participant lists and read cursors without inheriting a key that is documented to change.
- Humans, agents and the system share one column with one shape, so the schema does not have to be reshaped when accounts arrive.
- Nothing on the wire or in a shared room carries a home-directory path.
- One identity story for agents, matching the token store, rather than two.

### Negative

- **Moving an agent's directory creates a new author.** The old messages keep the old author and the agent keeps writing under a new one, so a moved agent silently splits in two. This is honest — `agents.project_path` is UNIQUE, so a moved directory already _is_ a different row — but it is a real failure mode, and a rename affordance that carries the author row is future work, not shipped here.
- The mint-on-first-use lookup is a write on a read path the first time any author is seen. It is one indexed upsert, but it is not free and it is on the message path.
- Author identity is now machine-local. Two installs that both have `~/agents/ana` mint unrelated authors, which is correct for single-player and is exactly the seam the community work will have to bridge.
- `resolve-message-author.ts` keeps deriving a _view model_ from `ctx.agent.id` for display. Two ids for one agent now coexist — the display path and the persistence path — and a future change that persists the view model would reintroduce the whole bug. The boundary needs to stay legible.
