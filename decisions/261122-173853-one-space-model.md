---
id: 261122-173853
title: One space model on the space store; a space holds its members' data, a computer holds execution state; the private space becomes a tenant after launch
status: accepted
created: 2026-11-22
spec: server-merge
superseded-by: null
amends: [261018-124422]
---

# 261122-173853. One space model on the space store; a space holds its members' data, a computer holds execution state; the private space becomes a tenant after launch

## Status

Accepted (operator decision, 2026-11-22: "go with changes", on the adversarial review of the "one space core, two storage plugs" plan, then revised the same day after Dorian rejected "SQLite keeps agents, sessions, runtimes, connections, settings" as Mac-only data).

**Amends** (each stays Accepted):

- [261018-124422](261018-124422-one-program-before-launch.md): its step 7 placement stands and is now the only placement. Its neutral note "a Mac hosting spaces (step 9, PGlite) stays after launch" gains a gate (a PGlite measurement on a real Mac) and a second use: the private space moves onto the same store. Everything else stands.
- Spec [`server-merge`](../specs/server-merge/02-specification.md) decision **D8** ("the space store's model becomes the one model after launch") is confirmed and given an order and an end state.
- **D2** stands in form (two stores, no layer over both) and is amended in substance: the machine store holds execution-bound state (workspaces, runtime transcripts and sign-ins, processes); the space store holds space data, agents included. The hub role already keeps agents with no runtime (`apps/server/src/startup/runtimes.ts:93-101`; `specs/everything-is-a-space/design-agent-computers.md:17-25`).
- **D4** and port rule 4 stand as a port rule and a hosting policy; see Decision.

**Retired, never adopted:**

- The "one space core with two storage plugs" plan (one shared room core over SQLite on the Mac and Postgres on a space server).
- Research S1 and challenge 1 in [`research/20261121_architecture-target-design.md`](../research/20261121_architecture-target-design.md): `apps/space` owning the space server's source.
- A `packages/space` core package.

## Context

DorkOS has two room systems. The Mac's rooms (`apps/server/src/services/rooms`, SQLite) serve one owner and run agent turns. The space server (`apps/server/src/services/spaces`, Postgres) serves many people with roles, invites, moderation and erasure, and runs no turns. Both sit behind one port, `CommunityAdapter`, and one wire contract, `@dorkos/shared/community-wire`. A plan to merge them into one core with two storage plugs would break D2. `RoomStore` is synchronous, and about 4,200 synchronous query calls across the server assume it. The space code relies on what SQLite does not have: `LISTEN/NOTIFY` for live streams, message numbering by a trigger at commit, and row locks. The hub already holds agents, memory, schedules, connections and settings and runs no turn, which shows those are space data, not execution state. Three placements for the space code had also been proposed in five weeks, which confuses every developer and reviewer.

## Decision

We will have **one model for a space: the space store's model** (`services/spaces`, Postgres). We will carry out server-merge D8 after launch. After launch, the private space on a person's computer becomes a tenant on that store, running on PGlite on the Mac. PGlite is adopted only after a measurement ticket on a real Mac passes (startup time, memory, write speed, bundle size), plus two more gates: startup to first reply on a cold Mac within PRINCIPLES 5's minute, and permission-gate reads (`agent.json`) no slower than today's file read; if the second fails, identity stays file-first (ADR-0043) with the store as its index. If PGlite fails, full Postgres is used only by people who host spaces, and the private space stays on the Mac's store until a store that passes exists.

**Two kinds of state, not two kinds of place.** Space data is members, agents, conversations, rules, memory, schedules, connections, settings, documents and extensions. Execution state is workspaces, runtime transcripts and sign-ins, and running processes. A space holds space data; the computer that runs turns holds execution state. Connections, provider keys and settings are owner-trusted space data: they live on the owner's hub or Mac, never on a shared host. D2's split moves to that line. The machine store keeps execution state and stays synchronous. No layer hides which store is underneath, and there is no storage plug. Anything a private space offers, every space offers, because it is built on space data; the only things a space cannot offer are those bound to a particular computer. A hub is a one-tenant space server, and the private space is a tenant.

**Who runs a turn.** The conversation port carries no turn (port rule 4). Which servers register a runtime is a role setting read once (`lib/server-role.ts`); DorkOS's shared hosts register none. A self-hoster may run one process in both roles. What never changes: a shared host holds no member's credentials and no key to a member's computer, and the permission gate reads the agent's identity on a server its owner trusts.

**Until then,** the Mac's `services/rooms` is the agent computer's local store, and `CommunityAdapter` is the only way the app reads any space, local or remote.

**Placement.** The space code stays in `apps/server/src/services/spaces` (ADR 261018-124422 step 7). `apps/space` keeps only the image, the migrations and the test tiers.

**Gates, now.** The import wall between `rooms` and `spaces` already exists (`apps/server/eslint-rules/space-boundary.js`, both directions) and stays. Four gates join it, each a test or lint rule with no product code:

- **G1. One wire.** Every body a room or space route returns is shaped by a schema from `@dorkos/shared/community-wire` (or its admin and private siblings). It starts as a ratchet at today's count.
- **G2. Table placement.** No new SQLite table outside `packages/db/src/schema`, and no new Postgres table outside the space schema and `apps/space/migrations`. A new room-like table needs an allowlist entry with a reason.
- **G3. Capability first.** A new `CommunityAdapter` method or capability flag lands with a `communityConformance` case before any backend implements it.
- **G4. One role predicate.** Role checks go through `role-checks.ts`, so "this host runs agents" stays one predicate (research S5).

**Freeze.** Nothing under `services/spaces`, `apps/space`, `packages/shared/src/community-wire*` or `services/spaces/migrate.ts` changes for this work before the December 8 Community launch.

**Order after launch:**

1. A shared HTTP kit, so the two request chains share plumbing (research S2).
2. D8: the Mac's owner checks (`readOwnerAccount`, `isInstallOwner`) become per-space member checks ("may this member do this in this space").
3. The PGlite measurement, then PGlite under the space store on a Mac.
4. The private tenant moves onto that store, domain by domain (rooms, canvas, schedules, connections, settings, memory index, then agents), each going async as it moves.
5. `services/rooms` shrinks to execution concerns: turn dispatch, seats, worktrees and bridges; canvas moves with the tenant.

The UI follows the hub (ADR 261015-042933), not the store; one model does not mean rewriting the in-app rooms UI.

## Consequences

### Positive

- One answer to "what is a space": the model that already handles strangers, many spaces, roles, bans and erasure.
- Nothing is Mac-only by design. The same feature set reaches the private space, team spaces and self-hosted spaces, and "hosted spaces run no agents" is one role setting, not a second architecture.
- No all-at-once async rewrite of the Mac server. The synchronous calls retire one domain at a time as each domain becomes space data; what stays machine-bound stays synchronous.
- One placement for the space code, with the other two named as retired, so nobody starts `packages/space` or moves code into `apps/space/src`.
- The gates check things code can check (one wire schema, where tables live, conformance first, one role predicate) instead of a rule against "building things twice" that no linter can enforce.
- Nothing touches the December 8 image, its migrations or its compatibility id.

### Negative

- Two room systems live side by side until after launch. Until the move, a feature built on the Mac's store is private-space-only; nothing new may be built that way without a ticket naming its move.
- The private tenant's move is larger than rooms: agents, schedules, connections and settings go with it, and each goes async.
- The private space's move is a real data move: ULID ids and ISO times on SQLite become uuids and timestamps on the space store, and about 120 server files read the room tables directly.
- PGlite on the Mac is unproven. If it fails its gates, the private space stays on the Mac's store longer, and full Postgres is used only by people who host spaces.
- The research S1 benefits (one folder for the space server, fewer Docker and turbo special cases) are given up.
- G1 starts as a ratchet, so existing room routes that do not use the wire schemas stay that way until someone moves them.
