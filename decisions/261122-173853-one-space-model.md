---
id: 261122-173853
title: One space model on the space store; the private space moves onto it after launch
status: accepted
created: 2026-11-22
spec: server-merge
superseded-by: null
amends: [261018-124422]
---

# 261122-173853. One space model on the space store; the private space moves onto it after launch

## Status

Accepted (operator decision, 2026-11-22: "go with changes", on the adversarial review of the "one space core, two storage plugs" plan).

**Amends** (each stays Accepted):

- [261018-124422](261018-124422-one-program-before-launch.md): its step 7 placement stands and is now the only placement. Its neutral note "a Mac hosting spaces (step 9, PGlite) stays after launch" gains a gate (a PGlite measurement on a real Mac) and a second use: the private space moves onto the same store. Everything else stands.
- Spec [`server-merge`](../specs/server-merge/02-specification.md) decision **D8** ("the space store's model becomes the one model after launch") is confirmed and given an order and an end state. **D2** ("two stores, split by what the data is about ... no layer that hides which database is underneath") stands unchanged; this ADR applies it to rooms.

**Retired, never adopted:**

- The "one space core with two storage plugs" plan (one shared room core over SQLite on the Mac and Postgres on a space server).
- Research S1 and challenge 1 in [`research/20261121_architecture-target-design.md`](../research/20261121_architecture-target-design.md): `apps/space` owning the space server's source.
- A `packages/space` core package.

## Context

DorkOS has two room systems. The Mac's rooms (`apps/server/src/services/rooms`, SQLite) serve one owner and run agent turns. The space server (`apps/server/src/services/spaces`, Postgres) serves many people with roles, invites, moderation and erasure, and runs no turns. Both sit behind one port, `CommunityAdapter`, and one wire contract, `@dorkos/shared/community-wire`. A plan to merge them into one core with two storage plugs would break D2. `RoomStore` is synchronous, and about 4,200 synchronous query calls across the server assume it. The space code relies on what SQLite does not have: `LISTEN/NOTIFY` for live streams, message numbering by a trigger at commit, and row locks. Three placements for the space code had also been proposed in five weeks, which confuses every developer and reviewer.

## Decision

We will have **one model for a space: the space store's model** (`services/spaces`, Postgres). We will carry out server-merge D8 after launch. After launch, the private space on a person's computer becomes a space on that store, running on PGlite on the Mac. PGlite is adopted only after a measurement ticket on a real Mac passes (startup time, memory, write speed, bundle size); if it fails, full Postgres is used only by people who host spaces, and the private space stays on the Mac's rooms until a store that passes exists.

**D2 stands.** SQLite keeps everything that only exists where agents run: agents, sessions, runtimes, connections, settings. There is no layer that hides which database is underneath, and no storage plug.

**Until then,** the Mac's `services/rooms` is the agent computer's local store, and `CommunityAdapter` is the only way the app reads any space, local or remote.

**Placement.** The space code stays in `apps/server/src/services/spaces` (ADR 261018-124422 step 7). `apps/space` keeps only the image, the migrations and the test tiers.

**Gates, now.** The import wall between `rooms` and `spaces` already exists (`apps/server/eslint-rules/space-boundary.js`, both directions) and stays. Three gates join it, each a test or lint rule with no product code:

- **G1. One wire.** Every body a room or space route returns is shaped by a schema from `@dorkos/shared/community-wire` (or its admin and private siblings). It starts as a ratchet at today's count.
- **G2. Table placement.** No new SQLite table outside `packages/db/src/schema`, and no new Postgres table outside the space schema and `apps/space/migrations`. A new room-like table needs an allowlist entry with a reason.
- **G3. Capability first.** A new `CommunityAdapter` method or capability flag lands with a `communityConformance` case before any backend implements it.

**Freeze.** Nothing under `services/spaces`, `apps/space`, `packages/shared/src/community-wire*` or `services/spaces/migrate.ts` changes for this work before the December 8 Community launch.

**Order after launch:**

1. A shared HTTP kit, so the two request chains share plumbing (research S2).
2. D8: the Mac's owner checks (`readOwnerAccount`, `isInstallOwner`) become per-space member checks ("may this member do this in this space").
3. The PGlite measurement, then PGlite under the space store on a Mac.
4. The private space moves onto that store.
5. `services/rooms` shrinks to agent-computer concerns: turns, worktrees, bridges to Telegram and Slack, and canvas.

The UI follows the hub (ADR 261015-042933), not the store; one model does not mean rewriting the in-app rooms UI.

## Consequences

### Positive

- One answer to "what is a space": the model that already handles strangers, many spaces, roles, bans and erasure.
- No async rewrite of the Mac server. The roughly 4,200 synchronous calls and the turn path stay as they are.
- One placement for the space code, with the other two named as retired, so nobody starts `packages/space` or moves code into `apps/space/src`.
- The gates check things code can check (one wire schema, where tables live, conformance first) instead of a rule against "building things twice" that no linter can enforce.
- Nothing touches the December 8 image, its migrations or its compatibility id.

### Negative

- Two room systems live side by side until after launch. Features both need (search, reactions, canvas) are either Mac-only or wait.
- The private space's move is a real data move: ULID ids and ISO times on SQLite become uuids and timestamps on the space store, and about 120 server files read the room tables directly.
- PGlite on the Mac is unproven. If the measurement fails, the private space stays on the Mac's rooms longer.
- The research S1 benefits (one folder for the space server, fewer Docker and turbo special cases) are given up.
- G1 starts as a ratchet, so existing room routes that do not use the wire schemas stay that way until someone moves them.
