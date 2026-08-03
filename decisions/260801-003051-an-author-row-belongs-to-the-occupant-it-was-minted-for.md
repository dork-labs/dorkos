---
id: 260801-003051
title: An author row belongs to the occupant it was minted for — a reused directory starts a fresh author
status: accepted
created: 2026-08-01
spec: mesh-identity-integrity
superseded-by: null
---

# 260801-003051. An author row belongs to the occupant it was minted for — a reused directory starts a fresh author

## Status

Accepted (implemented 2026-08-01, main `818a95364`, PR #684). **Partially supersedes**
[260726-170126](260726-170126-author-identity-is-keyed-on-the-agents-directory.md) — one clause, as
recorded in the Status of that ADR.

## Context

ADR 260726-170126 keys room author identity on the agent's directory, never its manifest ULID, and accepts that a _moved_ agent splits in two. It left the inverse unhandled: `AuthorRegistry.resolve` mints purely on `(kind, naturalKey)` with no occupancy check, so registering a **new** agent in a previously-occupied directory silently inherits the previous agent's entire message history, `@handle` claims, and room memberships (DOR-790 H12). Ghost author rows are also never removed, so a stale row can claim a `@handle` and starve a live agent with the same display name — verified by execution during review: the ghost was advertised and the live agent was unreachable by mention.

## Decision

We stamp each agent-kind author row with the manifest ULID of the occupant it was minted for. This **partially supersedes** ADR 260726-170126's clause that the ULID is never written into an author column — deliberately, not as a side effect: that clause guarded against reconciler ULID churn, and no reconciler path mints ids in current code (an ADR-0043 rebuild reads ids back from the files that store them), so the one event that changes a manifest id — re-initializing it — is exactly the generation boundary this stamp detects. The directory remains the identity key; the stamp decides occupancy generations and is always derived by the registry from the `agents` table, never accepted from a caller. When a directory's live occupant differs from the stamp, the old row is retired (`retired_at`) and a fresh author is minted; the unique index becomes partial over active rows. A legacy row with no stamp adopts the current occupant. Without a live occupant at the path, nothing retires or mints — that is the ghost state, and ghosts claim no handles, advertise nothing, and receive no turns, while an `unreachable`-but-present agent keeps its name. History rendering is untouched.

## Consequences

### Positive

- A reused directory can no longer reattribute someone else's message history; old entries keep their true author forever.
- Ghost authors stop shadowing live agents in mention resolution, while rosters and history still render them.
- Author ids never change and rows never delete, so every existing `authors.id` consumer (entries, members, reactions, sessions, cursors) keeps resolving.

### Negative

- A schema migration (two columns, a partial unique index — every `(kind, naturalKey)` lookup must filter on active rows) and a second liveness condition in the handle/dispatch path.
- **Retirement drops the agent out of every room, loudly but really.** Memberships are deliberately not carried to the fresh author — room membership is an access fact a new occupant must not inherit — so re-initializing a manifest in place means re-inviting the agent everywhere; the retirement logs a structured warning naming both author ids and the memberships left behind. A deliberate re-init affordance that carries the author row is future work, the same shape as ADR 260726-170126's deferred rename affordance.
