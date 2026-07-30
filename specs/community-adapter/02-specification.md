---
slug: community-adapter
id: 260727-221432
created: 2026-07-27
status: specified
linearIssue: DOR-591
---

# `CommunityAdapter` — one port for local rooms, Buzz, and `apps/community`

**Status:** Specified (frozen for DECOMPOSE)
**Author:** Claude (directed by Dorian), SPECIFY stage
**Date:** 2026-07-27
**Tracker:** DOR-591 · community program · **critical path** — `apps/community`, invites and agent admission all sit behind it
**Research basis:** `research/20260727_buzz-protocol-capability-spike.md` (Buzz @ `654f384906b5c7`), `research/20260727_agent-identity-in-communities.md`. Ideation: `specs/community-adapter/01-ideation.md`, inheriting `specs/community-server/01-ideation.md` D1–D9.

## Overview

DorkOS rooms are a shipped, membership-scoped durable stream backed by SQLite on one machine (ADR `260726-170125`). Communities make that stream a shared surface across several people, several machines and — one day — a foreign protocol. This spec defines the **server-side seam** that lets one local DorkOS server read and write rooms in more than one place, without the cockpit, the router or the session spine learning that more than one place exists.

One port, three backends:

```
client ──Transport──▶ your local DorkOS server ──CommunityAdapter──▶ ┌ local rooms   (SQLite, shipped today)
       (unchanged)                                    (new)          ├ Buzz relay    (Nostr/WS + NIP-98 HTTP, read-only)
                                                                     └ apps/community (Postgres)
```

The port is `packages/shared/src/community-adapter.ts`. Its behavioral gate is `communityConformance` in `@dorkos/test-utils`. Its dispatcher is a `CommunityRegistry` in `apps/server/src/services/communities/`, which aggregates across communities with **per-community degradation and `warnings[]`** — the shape ADR-0310 already established for session listing.

**No concrete adapter ships in this spec.** The deliverable is the contract and the suite that gates it. The three adapters are DOR-59x each, and the ordering (local → Buzz read-only → `apps/community`) is D5's, not this spec's to change.

## Background / Problem Statement

**An interface with one implementation is a fake abstraction.** `specs/community-server` D5 put a read-only Buzz adapter _second_, before our own Postgres server sets the interface in concrete, precisely so the contract is written against a backend we do not control. The spike then proved that instinct: it found **four places where the obvious interface satisfies both of our own backends and fails against Buzz**, and each is a case we would otherwise have discovered after the concrete had set.

| #   | Mismatch                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Why the obvious design fails                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **No monotonic sequence.** Our entire durable-stream design rests on a per-room `seq` allocated in an IMMEDIATE transaction (`packages/db/src/schema/rooms.ts:151-210`). Nostr filters page by wall-clock `created_at` (`handlers/req.rs:873-882`); the only tiebroken cursor is NIP-CW's `(until, before_id)` keyset, **available on HTTP `POST /query` only** — `handle_channel_window_filter` has no caller outside `bridge.rs`.                       | A cursor typed `number` bakes in an assumption one of three backends cannot meet, and a wall-clock cursor with no tiebreak silently drops entries that share a second across a page boundary.   |
| 2   | **Threads are arbitrarily deep.** Buzz stores NIP-10 `e` tags on messages _in the same channel_, with a `thread_metadata` table carrying a `depth` column and a module doc that says "infinitely nested threads" (`db/thread.rs:1-5,19-42`). Ours is an entry-level relation too, one level, refused at the service boundary — ADR `260728-022013` decided it and DOR-634 shipped it, so what is left of this mismatch is the **ceiling**, not the shape. | Neither model expresses the other without loss. Flattening a depth-3 Buzz reply into two levels discards ancestry.                                                                              |
| 3   | **Read cursors are private by construction.** NIP-RS kind:30078, `content` is a NIP-44 ciphertext whose conversation key is the user encrypting **to themselves**, keyed by a random per-installation slot id holding wall-clock timestamps. The relay validates only the envelope (`db/lib.rs:3672-3688`).                                                                                                                                               | A server-computed unread count, badge or digest is **impossible**, not merely unimplemented. Our `roomMembers.lastReadSeq` is a server-visible integer with no counterpart.                     |
| 4   | **No channel-level invite.** kind:9009 is dispatched to a handler that logs a warning and returns Ok (`side_effects.rs:157-163`). The real HTTP invites admit to the _community_ (`router.rs:95,111`).                                                                                                                                                                                                                                                    | "Offer a specific person a specific room" is not expressible. Buzz can only satisfy it by _adding_ the member (kind:9000) — a different act, with different consent semantics, requiring admin. |

Plus a fifth, which is less a mismatch than a correction to how we were thinking about joining at all: **joining a Buzz community is an admission event, not a connection.** The library defaults for `BUZZ_PUBKEY_ALLOWLIST` and `BUZZ_REQUIRE_RELAY_MEMBERSHIP` are both `false` (`config.rs:479-485`), but every deployment path Buzz publishes turns membership on — `deploy/compose/.env.example:17-18`, `deploy/charts/buzz/values.yaml:109,114` (commented "the production default"), `Justfile:318-319`. With it on, _"only pubkeys with a row for that community may use that community"_, and there is **no in-protocol way to request admission** — it is an operator action. That is closer to how `apps/community` will work than any anonymous-read model, so this spec treats out-of-band admission as a first-class connection outcome rather than a Buzz quirk.

## Decisions (LOCKED — inherited, do not relitigate)

`specs/community-server/01-ideation.md` D1–D9, in full. The four that bind hardest here:

1. **D2** — the adapter is **server-side**. Keys never touch the browser; there is one render path and one streaming model; ADR-0310 already solved the aggregation problem.
2. **D3** — zero user-facing keys, in every path. A secp256k1 keypair is **machine infrastructure in a `0600` file**, exactly as `resolveBetterAuthSecret` already treats the Better Auth secret.
3. **D8** — a member's agent gets its own identity in the community, vouched for by the member. Removing the human removes their agents; the agent inherits none of its owner's powers; admins can eject an agent without removing its owner.
4. **D9** (ADR `260727-184933`) — the community server never executes a member's agent. **No method on this port may accept or return an execution request**, and there is deliberately no `runTurn`, no `invokeAgent`, no session handle anywhere in the contract. The port carries conversation; compute stays on the member's machine.

## Decisions resolved in SPECIFY

Each of these was open at the end of ideation. The rationale matters as much as the answer, because every one of them is a place where the obvious choice weakens the contract. **The `OQ<n>` labels in this section are the parent's** — `specs/community-server/01-ideation.md` §7 — and are a different series from this document's own nine, which are answered in §Decisions resolved after SPECIFY.

- **OQ2 (parent §7) — what does `CommunityCapabilities` enumerate? RESOLVED: thirteen flags, §Detailed Design 2.** Derived from the spike's 11-row table, with three deliberate departures recorded there. (Thirteen counts the substantive flags in `CommunityCapabilitiesSchema` — its sixteen fields less `type`, `features` and the dependent `roomListPollIntervalMs`. It read "eleven" until 2026-07-28, which was the spike's row count rather than the schema's; §Decisions resolved after SPECIFY, OQ6 has since removed one more.)
- **The cursor's internal encoding is NOT a capability flag. RESOLVED: rejected `historyCursor: 'timestamp' | 'keyset' | 'sequence'`.** The spike proposed it; it is the right analysis and the wrong flag. The cursor is opaque by construction, so its encoding is precisely what no consumer may branch on — and a three-valued flag whose only consumer-visible consequence is two-valued invites exactly the branching the opacity exists to prevent. What a consumer genuinely needs to know is whether a resume is _offered_: `resume: 'gap-free' | 'none'`. The encoding stays adapter-internal and is documented per adapter. **Amended after SPECIFY — see §Decisions resolved after SPECIFY, OQ6: the `resume` flag is cut too.** The conclusion above stands and gets stronger — it turned out that even the two-valued "is a resume offered" flag has one value in practice, so the guarantee became a property of the port rather than a declaration on it.
- **There is no `hasRoster` flag. RESOLVED: `listMembers` is universal.** The parent ideation's premise that a Nostr relay has no roster is false — Buzz serves a per-channel roster as relay-signed kind:39002 events with a role per member (`side_effects.rs:1092-1107`). All three backends enumerate members, so a flag would be dead weight. **Roles are what differ**, and they get the flag.
- **OQ5 — how do roles work across backends that disagree? RESOLVED: an adapter-declared vocabulary with one portable predicate.** Not a shared three-value enum (Buzz has five, with `Bot` explicitly outside the hierarchy), and not a permission taxonomy. This is the `RuntimeCapabilities.permissionModes` precedent applied to roles: `{ supported, default?, values: CommunityRoleDescriptor[] }`, where each descriptor carries `id`, `label`, `administers: boolean` and `isOwner?: boolean`. The product branches only on `administers`/`isOwner`; the UI renders `label`. Local declares `supported: false, values: []` — honest today under D6 and honest forever.
- **OQ6 — tenancy addressing. RESOLVED: every room reference is `(community, roomId)`.** `TenantContext` is resolved from the HTTP Host at row zero and is deliberately not `Deserialize`-able (`core/tenant.rs:19-24,68-76`), so an adapter instance is **per-community, not per-server**, and joining two Buzz communities means two adapters over two hosts.
- **OQ3 — does `workspaceId` mean anything for a remote room? RESOLVED: no. It is not on the port.** `rooms.workspaceId` binds a room to a checkout on _this_ machine (`specs/channel-workspace/`); a remote community has no opinion about a path on someone's laptop, and putting one on the wire would be the same privacy defect `author-registry.ts` exists to prevent. It stays a **local-only column** the local cache carries beside a remote room, never a field the port speaks.
- **OQ4 — how does an agent authenticate to a remote community? RESOLVED at the port: it does not.** Under D2 an agent talks to its owner's own DorkOS server, and that server talks to the community; there is no agent-to-community credential in v1. What the port needs is the **admission** half: `admitAgent` mints the agent's own identity in the community, vouched by the connected member. `research/20260727_agent-identity-in-communities.md` §6.3 reaches the same conclusion and recommends refusing Buzz's mechanism (an unrevocable signed capability) while keeping its motivation.
- **Capability-gated methods are REQUIRED on the interface and throw when their capability is off.** Not optional methods. `AgentRuntime.executeCommandIntent` is the precedent: it is required, and `runtimeConformance` asserts _"dispatches per its declared support: supported → boundary/terminal, unsupported → throws"_. Optional methods let a backend silently omit a surface and the compiler stays quiet; a required method with a typed refusal cannot.
- **Connection failure is TYPED on the result, never thrown.** Verbatim `ConnectorProvider.pollConnect`'s doctrine — _"failure is TYPED on the result … never thrown across the port — callers branch on `status`, they do not catch."_ Whether a target deployment admits our key is a per-deployment fact we cannot discover before trying (spike §11a), so "not admitted" is a normal, user-actionable outcome, not a programming error.

## Goals

- **G1** — A Zod-first `CommunityAdapter` port in `packages/shared`, with `CommunityCapabilities`, two typed errors, and DTOs that carry no credential and no filesystem path. **[Amended 2026-07-30 (DOR-754): three typed errors — `subscribeRoom` gained `CommunityRoomNotFoundError`; see Amendment 3.]**
- **G2** — `communityConformance` in `@dorkos/test-utils`, capability-aware in the `connectorConformance` sense: every difference is a **declared flag with a branched assertion**, never a weakened one. Plus a `FakeCommunityAdapter` configurable across the whole flag matrix.
- **G3** — The four mismatches are expressible **without weakening**: an opaque cursor that is gap-free or refuses, universally and with no per-adapter opt-out; an entry-level thread relation; a three-valued read-cursor flag; a three-valued invite flag.
- **G4** — Out-of-band admission is a first-class connection outcome with a plain-language disclosure, distinguishable from a bad credential and from an unreachable host.
- **G5** — D8's four agent-admission properties are conformance assertions, not prose.
- **G6** — A `CommunityRegistry` that dispatches `(community, roomId)` and aggregates listing across communities with per-community degradation and `warnings[]` (ADR-0310).
- **G7** — A credential contract that satisfies D3: machine-managed, `0600`, generated on first use, never logged, never returned by any port method.

## Non-Goals

- **Not** any concrete adapter. Local, Buzz read-only and `apps/community` are DOR-59x each.
- **Not** the local cache migration. Adding `communityRef` to `rooms` and re-scoping `rooms_channel_slug_unique` belongs to the local-adapter ticket (§Data model changes records what it must do) — including the `'not-admitted'` invalidation §5 now requires of it, which after DOR-672 also deletes that community's message-index rows in the same transaction.
- **Not** posting to Buzz, and therefore not Nostr write-path key handling (deferred past v1 by D5).
- **Not** federation, message signing, reactions, or search. Buzz has the last two (kind:7 NIP-25; NIP-50 one-shot `REQ`); we do not, and adding them to the port before the local backend has them would be inventing a capability with one implementation. Reactions get one line of forward planning and no code: `roomEntries.id` (`packages/db/src/schema/rooms.ts:196`, unique per room at `:234`) is already the attach point, and a Nostr kind:7 points at an event id, so the day someone asks, the mismatch is a known shape rather than a discovery (OQ7). **[Amended 2026-07-28 (DOR-672) — the clause about search rests on a premise that expires; see Amendment 1 at the end of this document.]**
- **Not** presence/typing beyond a declared flag — the vocabulary is already `SignalTypeSchema`; nothing here forks it, and the flag is two-valued (OQ8).
- **Not** anything that touches `Transport` or the client. D2 is explicit: the client seam already exists and rooms are already on it.
- **Not** hosted agent execution, per D9 and ADR `260727-184933`.

## Technical Dependencies

- `packages/shared` — new module `community-adapter.ts`, new `exports` subpath `@dorkos/shared/community-adapter` (the 47th; `packages/shared/package.json` has 46 today). Reuses `ResponseModeSchema` (`mesh-schemas.ts`) and `SignalTypeSchema` (`relay-envelope-schemas.ts`) rather than forking either, exactly as `room-schemas.ts` does.
- `packages/test-utils` — new `community-conformance.ts` + `fake-community-adapter.ts`, both re-exported from the barrel (`src/index.ts`) beside `connector-conformance` and `fake-connector-provider`.
- `apps/server` — new service domain `services/communities/` (registry, aggregation, credential resolution). A new domain directory is warranted under `.claude/rules/server-structure.md`: this is a cohesive area with several related services, not an orphan file.
- `lib/dork-home.ts` — the only source of the data directory for credential storage. `os.homedir()` is banned.
- **No new external dependency in this spec.** `nostr-tools` (or equivalent secp256k1/NIP-42) arrives with the Buzz adapter, and `@dorkos/db` changes arrive with the local adapter. The ULID minting §Decisions resolved after SPECIFY, OQ5 decided needs nothing new either: `ulidx` is already an `apps/server` dependency and already mints every room, entry and author id.

## Detailed Design

### 1. Addressing and identity

Buzz is one community per host. Our `rooms` table has no community column at all. So a bare room id is ambiguous the moment a second community exists, and every address on this port is a pair.

```typescript
/**
 * Opaque, locally-minted handle for ONE configured community connection. Branded
 * so a bare string cannot pass where a community is due.
 *
 * Minted as a ULID (`ulidx`, already a dependency of `apps/server` and already how
 * rooms (`room-service.ts:258`), entries (`:624`) and authors
 * (`author-registry.ts:168`) get their ids). The regex
 * is not decoration: this value becomes a directory name under
 * `<dorkHome>/communities/<ref>/` (§7), so it must never contain `/`, `.` or `..`.
 */
export const CommunityRefSchema = z
  .string()
  .regex(/^[0-9A-Za-z][0-9A-Za-z_-]*$/, 'A community ref must be path-safe')
  .brand('CommunityRef');
export type CommunityRef = z.infer<typeof CommunityRefSchema>;

/**
 * The reserved ref for this machine's own SQLite rooms. Every room that exists
 * today is addressed under it. A ULID is 26 characters of uppercase Crockford
 * base32, so no minted ref can ever collide with this lowercase literal.
 */
export const LOCAL_COMMUNITY: CommunityRef = 'local' as CommunityRef;

/**
 * A configured community as the registry knows it. The `label` is the legibility
 * a normalized host would have bought in a config file or a log line, kept beside
 * the ULID instead of inside it.
 */
export const CommunityDescriptorSchema = z.object({
  community: CommunityRefSchema,
  /** Person-supplied, freely renameable, never an identifier. */
  label: z.string().min(1),
  /** Mirrors `adapter.type`, so a list renders without asking every adapter. */
  type: z.string().min(1),
});
export type CommunityDescriptor = z.infer<typeof CommunityDescriptorSchema>;

/** A room reference. A bare room id is never sufficient — Buzz addresses channels by a UUID unique only within one host. */
export const RoomAddressSchema = z.object({
  community: CommunityRefSchema,
  roomId: z.string().min(1),
});
export type RoomAddress = z.infer<typeof RoomAddressSchema>;
```

`CommunityRef` is **minted locally at configure time and never supplied by a remote** — the same fence Buzz's `TenantContext` draws by refusing to derive `Deserialize`. One adapter instance serves exactly one community: `adapter.community` is readonly, and every address it emits must carry that value (a universal conformance assertion, §9 U3).

**It is a ULID, not a normalized host, and the label is what buys the legibility back.** A host is the one thing about a remote community that can change without the community changing: a relay moves, a deployment gets a real domain, `localhost:3000` becomes `buzz.example`. A ref derived from the host would then have to be migrated — and it is a directory name (`<dorkHome>/communities/<ref>/`, §7) and a foreign key on every cached room, so migrating it is the expensive kind of rename. A ULID survives all of that, is path-safe by construction, and sorts by mint time for free. What it costs is that nobody can read it, which is a real cost in a config file and in a log line — so **every community carries a `label` beside its ref**, and the two are never separated.

**The label lives on `CommunityDescriptor`, once per community, and nowhere else.** Not on `CommunityCapabilities`: §2's rule is that every flag there changes what a caller may do or what the suite asserts, and a display name changes neither — it is exactly the descriptive colour that section refuses. Not on `CommunityRoom` either: it is a per-community constant, and repeating it on every row of a list to save a map lookup the consumer already holds is the kind of denormalization that later disagrees with itself when someone renames a community. The one exception is `CommunityWarning` (§8), which must be renderable on its own precisely because it appears when the community is the thing that failed. The registry is given the label at registration (`register(adapter, label)`) rather than asking the adapter for it, so a rename never has to reach an adapter — and persisting it beside the rest of a community's configuration is a `~/.dork/config.json` schema change, which means a semver-keyed migration (`contributing/configuration.md`) owned by whichever ticket adds the configure-a-community surface.

**Member identity is D3's, unchanged.** A remote member's `naturalKey` is the opaque member id that community minted; only the opaque local `authorId` ever reaches the wire. The spike banked that this maps cleanly: a Buzz pubkey is a flawless `naturalKey` (stable, globally unique, never rebuilt) and their kind:0 profile sync is precisely our `displayName`/`emoji`/`color` render cache. **This part of the interface needs no capability flag.**

### 2. `CommunityCapabilities` — the full flag set

Derived from the spike's 11-row table. Genuinely-boolean differences stay booleans; anything with more than two honest states is an enum; `roles` is structured because backends expose materially different sets (the `RuntimeCapabilities.permissionModes` precedent, ADR-0256). Every flag below changes what a caller may do or what the suite asserts — none is descriptive colour.

**Mismatch 1 has no flag, and its absence is the load-bearing one here.** The obvious design gives history a `resume: 'gap-free' | 'none'` capability; §Decisions resolved after SPECIFY, OQ6 cuts it, because all three backends reach gap-free and a one-valued enum is a flag that describes nothing. The guarantee did not go anywhere — it moved from a per-adapter declaration to a **property of the port**: a resume is gap-free or it throws eagerly, for every adapter, always (§4 rule 3, conformance U6). Mismatch 1 is still absorbed; it is absorbed by the cursor's contract instead of by a flag a consumer would have to branch on.

```typescript
export const CommunityCapabilitiesSchema = z.object({
  /** Adapter type identifier, e.g. 'local' | 'buzz' | 'dorkos-community'. Must equal `adapter.type`. */
  type: z.string().min(1),

  // --- 1. Room discovery ----------------------------------------------------
  /**
   * How new rooms are learned. 'poll' is Buzz: kind:39000 discovery events are
   * stored CHANNEL-scoped, so a live global subscription never receives them by
   * fan-out (`subscription.rs:265-288`) and channel-created is never pushed.
   */
  roomList: z.enum(['push', 'poll']),
  /** Required when `roomList === 'poll'`; the interval the adapter polls at. Absent on 'push'. */
  roomListPollIntervalMs: z.number().int().positive().optional(),
  /**
   * 'slug' — `#general` is unique and archiving frees the name (our partial
   * unique index). 'opaque-id' — Buzz: a UUID with a freely-editable, non-unique
   * name (`side_effects.rs:1398-1410`). A slug-addressing UI must gate on this.
   */
  roomAddressing: z.enum(['slug', 'opaque-id']),

  // --- 2. Writing -----------------------------------------------------------
  /** Can this adapter post an entry? Read-only Buzz: false. */
  canPost: z.boolean(),
  /** Can it create, rename or archive a room? Read-only Buzz: false. */
  roomAdmin: z.boolean(),

  // --- 3. Membership --------------------------------------------------------
  /**
   * The backend's OWN role vocabulary. Not a shared enum: Buzz has five with
   * `Bot` explicitly outside the hierarchy, D7 gives the community server three,
   * and the local install has none (D6). Mirrors
   * `RuntimeCapabilities.permissionModes` exactly, `default` included.
   */
  roles: z.object({
    supported: z.boolean(),
    /** Role a newly-admitted member receives. Must reference a declared `values[].id`. */
    default: z.string().optional(),
    values: z.array(CommunityRoleDescriptorSchema),
  }),
  /**
   * How a new member gets in.
   * - 'open' — a valid credential is sufficient (local; a default-config relay).
   * - 'out-of-band' — the credential is valid but an operator must admit it, and
   *   there is NO in-protocol way to ask (every published Buzz deployment).
   * - 'invite' — the adapter can present a redeemable invite (`apps/community`).
   */
  admission: z.enum(['open', 'out-of-band', 'invite']),
  /**
   * What `createInvite` can offer (spike mismatch 4).
   * - 'room' — offer a specific person a specific room.
   * - 'community' — admit to the community only; a room-scoped request is REFUSED
   *   rather than silently widened.
   * - 'none' — no invite primitive.
   */
  invite: z.enum(['none', 'community', 'room']),
  /**
   * D8. 'owner-vouched' — an agent gets its own community identity, vouched for
   * by the member who brought it, and its admission is DERIVED from that member's
   * (re-evaluated, never copied into a row that must be kept in sync).
   * 'none' — this adapter cannot admit agents.
   */
  agentAdmission: z.enum(['none', 'owner-vouched']),

  // --- 4. Per-member state (spike mismatch 3) -------------------------------
  /**
   * - 'server' — the backend stores the cursor and can compute an unread count.
   * - 'client-opaque' — the backend stores a blob only this member can read
   *   (Buzz NIP-RS). The adapter round-trips its OWN cursor; a server-computed
   *   unread count is impossible, and no other member's cursor exists even in
   *   principle. `CommunityRoom.unreadCount` is `null` everywhere.
   * - 'none' — no cursor at all (read-only Buzz v1: writing one is a write).
   */
  readCursor: z.enum(['server', 'client-opaque', 'none']),
  /**
   * Whether a membership carries a per-room agent addressing override
   * (`ResponseModeSchema`). Ours does and Buzz has no counterpart; the fields are
   * orthogonal to roles, so they are separate optional fields on the member DTO
   * rather than one merged "permission" abstraction that would misrepresent both.
   */
  responseMode: z.boolean(),

  // --- 5. Threads (spike mismatch 2) ---------------------------------------
  /**
   * 1 — one level, enforced: a reply to an entry that is already inside a thread
   * is REFUSED (our shipped `NESTED_THREAD`). 'unbounded' — arbitrary depth
   * (Buzz's `thread_metadata.depth`, "infinitely nested").
   * The RELATION is entry-level on this port for every backend; only the ceiling
   * differs.
   */
  threadDepth: z.union([z.literal(1), z.literal('unbounded')]),

  // --- 6. Ephemeral ---------------------------------------------------------
  /**
   * 'both' — can emit and observe typing/presence. 'none' — neither.
   * There is deliberately no 'receive'. An adapter that can observe a remote
   * community's typing indicators but cannot post into it has nothing to show
   * anyone (§Decisions resolved after SPECIFY, OQ8); read-only Buzz declares
   * 'none' and gains a real capability the day it gains the write path.
   *
   * [Amended 2026-07-29 (room-presence): room working-presence rides this flag —
   * no separate `presence` capability is minted, and `publishSignal` gains a
   * structured payload. See Amendment 2 at the end of this document.]
   */
  signals: z.enum(['none', 'both']),

  // --- 7. Credential (D3) ---------------------------------------------------
  /**
   * - 'none' — local; nothing to hold.
   * - 'machine-managed' — the server mints and holds it in a `0600` file. Nothing
   *   user-facing exists; D3 is satisfied (Buzz's secp256k1 keypair).
   * - 'user-account' — the member signs in (email + password, Google, GitHub).
   *   Still no key (`apps/community`).
   */
  credential: z.enum(['none', 'machine-managed', 'user-account']),

  /** Adapter-specific metadata that does not merit a first-class field (cf. `RuntimeCapabilities.features`). Consumers must validate what they read. */
  features: z.record(z.string(), z.unknown()).default(() => ({})),
});
```

```typescript
/**
 * One role a backend declares. `administers` is the ONLY portable predicate the
 * product branches on — it is what makes five-into-three unnecessary. Buzz's
 * `Bot` declares `administers: false` and no rank, which is honest: their own
 * git policy layer says "Bot is a designation (what it is), not a permission
 * tier (what it can do)" (`api/git/policy.rs:380-386`).
 *
 * There is deliberately no `rank` and no ordering in v1 (§Decisions resolved
 * after SPECIFY, OQ4): `Bot` is the counter-example that shows a linear
 * hierarchy would have to lie about at least one declared role.
 */
export const CommunityRoleDescriptorSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  /** May this role invite, moderate, create or archive rooms, and eject members? */
  administers: z.boolean(),
  /** Exactly one role may set this. The irreducible one: they hold the database (D7). */
  isOwner: z.boolean().optional(),
});
```

**How the three backends declare, in full.** Written out because the point of the flag set is that all three fit without any of them being lied about:

| Flag              | local                                    | Buzz (read-only v1)                                               | `apps/community`                       |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `type`            | `'local'`                                | `'buzz'`                                                          | `'dorkos-community'`                   |
| `roomList`        | `push` (`eventFanOut` `room_created`)    | **`poll`**                                                        | `push`                                 |
| `roomAddressing`  | `slug`                                   | `opaque-id`                                                       | `slug`                                 |
| `canPost`         | `true`                                   | **`false`**                                                       | `true`                                 |
| `roomAdmin`       | `true`                                   | **`false`**                                                       | `true`                                 |
| `roles.supported` | **`false`**, `values: []`                | `true` — 5 values, `Bot` `administers:false`                      | `true` — 3 values, `default: 'member'` |
| `admission`       | `open`                                   | **`out-of-band`**                                                 | `invite`                               |
| `invite`          | `none`                                   | **`none`** (read-only; a write-capable Buzz would be `community`) | `room`                                 |
| `agentAdmission`  | `none` (D6: no second human to vouch to) | **`none`**                                                        | `owner-vouched`                        |
| `readCursor`      | `server`                                 | **`none`** (`client-opaque` when write lands)                     | `server`                               |
| `responseMode`    | `true`                                   | `false`                                                           | `true`                                 |
| `threadDepth`     | `1`                                      | **`unbounded`**                                                   | `1`                                    |
| `signals`         | `both` — see Amendment 2 §D              | **`none`**                                                        | `both`                                 |
| `credential`      | `none`                                   | `machine-managed`                                                 | `user-account`                         |

Two things this table makes visible. First, **read-only Buzz turns five flags off that our own two backends both leave on** — `canPost`, `roomAdmin`, `readCursor`, `responseMode` and `signals` (the last of these was briefly off on the shipped local adapter too, for an unrelated and temporary reason, and is back on now that the reason is gone: Amendment 2 §D) — and turns two more down, `roomList` to `poll` and `roomAddressing` to `opaque-id`. That is the whole reason D5 sequenced it second. Second, **capabilities describe the ADAPTER, not the protocol.** Buzz-the-protocol has NIP-RS read cursors, community invites, and kind:20001/20002 presence and typing that a read-only client can genuinely observe; the read-only v1 adapter declares `readCursor: 'none'`, `invite: 'none'` and `signals: 'none'` anyway, because two of those need a write and the third has no consumer without one (OQ8). Declaring what the protocol could theoretically do would make the flags a lie the conformance suite could not catch.

### 3. The port

```typescript
/**
 * Universal contract for a community backend — the fourth swappable seam beside
 * `AgentRuntime`, `Transport` and `ConnectorProvider`. Local rooms, a Buzz relay
 * and `apps/community` each implement it; `communityConformance` gates every one.
 *
 * ONE INSTANCE SERVES ONE COMMUNITY. Buzz resolves its tenant from the HTTP Host
 * at row zero, so "join two communities" means two adapters over two hosts, and
 * the registry keys on `community`, never on a room id.
 *
 * EVERY METHOD IS REQUIRED. A capability-gated method whose capability is off
 * rejects with `CommunityUnsupportedError` — never a silent no-op, never a
 * partial write. Optional methods would let a backend omit a surface with the
 * compiler silent; `AgentRuntime.executeCommandIntent` is the precedent for the
 * required-and-refusing shape.
 *
 * NOTHING HERE EXECUTES AN AGENT (D9, ADR 260727-184933). There is no turn, no
 * session handle and no invocation on this port, deliberately.
 */
export interface CommunityAdapter {
  /** Adapter type identifier; must equal `getCapabilities().type`. */
  readonly type: string;
  /** The one community this instance serves. Every address it emits carries this. */
  readonly community: CommunityRef;

  getCapabilities(): CommunityCapabilities;

  // --- Connection -----------------------------------------------------------
  /**
   * Establish the adapter's own connection, resolving its credential from the
   * server-side store (§7) — a credential is NEVER passed across this port.
   *
   * Failure is TYPED on the result, never thrown: whether a deployment admits us
   * is a per-deployment fact we cannot discover before trying, and "an operator
   * must admit you" is a user-actionable outcome rather than a bug.
   */
  connect(signal?: AbortSignal): Promise<CommunityConnection>;
  /** Tear down. Idempotent — disconnecting a never-connected adapter resolves. */
  disconnect(): Promise<void>;

  // --- Rooms ----------------------------------------------------------------
  /** Every room this identity may see. NEVER includes threads (§4). */
  listRooms(): Promise<CommunityRoom[]>;
  getRoom(roomId: string): Promise<CommunityRoom | null>;
  /**
   * Room lifecycle as a stream. A `roomList: 'poll'` adapter satisfies this by
   * polling at its declared interval — the difference is latency, not shape, so
   * the consumer has one code path.
   */
  subscribeRoomList(signal?: AbortSignal): AsyncIterable<CommunityRoomListEvent>;
  /** `roomAdmin` — create / patch (title, topic, archived). Otherwise refuses. */
  createRoom(input: CreateCommunityRoomInput): Promise<CommunityRoom>;
  updateRoom(roomId: string, patch: UpdateCommunityRoomInput): Promise<CommunityRoom>;

  // --- Entries --------------------------------------------------------------
  /**
   * The durable stream for one room: snapshot → gap-free replay → live.
   *
   * Throws `StaleCommunityCursorError` EAGERLY (at call time, before any
   * iteration) when `sinceCursor` cannot be served gap-free — it belongs to a
   * different room or community, or it is from a superseded epoch. Callers MUST
   * catch it and fall back to a cold snapshot. This is
   * `AgentRuntime.subscribeSession`'s contract, kept whole; the only change is
   * that our cursor is opaque where its `sinceCursor` is a number.
   *
   * Gap-free-or-throw is universal, not capability-gated: there is no flag that
   * lets an adapter offer a weaker resume (§Decisions resolved after SPECIFY, OQ6).
   *
   * [Amended 2026-07-30 (DOR-754): also throws `CommunityRoomNotFoundError`
   * eagerly when `roomId` is not a room this identity can stream — unknown and
   * invisible alike, indistinguishably. See Amendment 3 at the end of this
   * document.]
   */
  subscribeRoom(
    roomId: string,
    sinceCursor?: CommunityCursor,
    signal?: AbortSignal
  ): AsyncIterable<CommunityRoomEvent>;
  /**
   * A page of history, oldest-first within the page.
   *
   * `thread` omitted returns TOP-LEVEL entries only; `thread: <entryId>` returns
   * that thread's replies. This is Buzz's own NIP-CW `top_level` filter shape and
   * our child-room read, expressed once.
   */
  listEntries(roomId: string, opts: ListCommunityEntriesOpts): Promise<CommunityEntryPage>;
  /** `canPost` — commit an entry. `parentEntryId` makes it a threaded reply. */
  post(roomId: string, input: PostCommunityEntryInput): Promise<CommunityEntryRef>;

  // --- Roster ---------------------------------------------------------------
  /** Universal: all three backends enumerate a room's members. */
  listMembers(roomId: string): Promise<CommunityMember[]>;
  /** `roomAdmin` — add an existing community member to a room. */
  addMember(
    roomId: string,
    memberId: string,
    opts?: AddCommunityMemberOpts
  ): Promise<CommunityMember>;
  /** `roomAdmin` OR the member's own owner (D8) — remove from a room. Idempotent. */
  removeMember(roomId: string, memberId: string): Promise<void>;
  /** `responseMode` — set a membership's per-room agent addressing override. */
  setResponseMode(roomId: string, memberId: string, mode: ResponseMode): Promise<CommunityMember>;

  // --- Agent admission (D8) -------------------------------------------------
  /**
   * `agentAdmission: 'owner-vouched'` — mint this agent's OWN identity in the
   * community, vouched for by the connected member. Idempotent per agent.
   *
   * Three properties are contractual, not incidental: the returned member's
   * `ownerMemberId` is the connected identity; its role NEVER administers,
   * whatever its owner's role is; and its admission is DERIVED from its owner's,
   * re-evaluated on use rather than copied into a row a cleanup job must find.
   *
   * `AdmitAgentInput` deliberately carries no agent-side consent field: under D8
   * only a member adds their own agents, so there is no third party to refuse
   * (§Decisions resolved after SPECIFY, OQ3).
   */
  admitAgent(input: AdmitAgentInput): Promise<CommunityMember>;
  /** `agentAdmission: 'owner-vouched'` — revoke an agent's community identity entirely. Idempotent. */
  revokeAgent(memberId: string): Promise<void>;

  // --- Read cursor ----------------------------------------------------------
  /** `readCursor !== 'none'` — the connected identity's own cursor for one room. */
  getReadCursor(roomId: string): Promise<CommunityCursor | null>;
  setReadCursor(roomId: string, cursor: CommunityCursor): Promise<void>;

  // --- Invites --------------------------------------------------------------
  /**
   * `invite !== 'none'` — mint an invite.
   *
   * A `community`-scoped backend given a `roomId` REFUSES with
   * `CommunityUnsupportedError`. It must not silently widen to a community invite
   * and must not substitute "an admin adds you" (Buzz kind:9000): those are
   * different acts with different consent semantics, and papering over the
   * difference is exactly the weakening this port exists to prevent.
   */
  createInvite(input: CreateCommunityInviteInput): Promise<CommunityInvite>;

  // --- Ephemeral ------------------------------------------------------------
  /**
   * `signals: 'both'` — emit a typing/presence signal. Live only; never durable.
   * [Amended 2026-07-29 (room-presence): gains an optional structured presence
   * payload — see Amendment 2 at the end of this document.]
   */
  publishSignal(roomId: string, signal: SignalType): Promise<void>;
}
```

**Why every method earns its place.** `connect`/`disconnect` are the admission boundary the spike made first-class. `listRooms`/`getRoom`/`subscribeRoomList` are discovery, and the poll/push difference is absorbed inside `subscribeRoomList` so the consumer never forks. `subscribeRoom`/`listEntries` are the durable stream, split exactly as the shipped room API splits `GET /:id/events` from `GET /:id/entries`. `post` is the one write every non-read-only backend has. The roster four are D7/D8's surface. `admitAgent`/`revokeAgent` are D8's mechanism, kept separate from `addMember` because minting an identity and putting it in a room are two acts. Read cursor and invite are two of the four mismatches. `publishSignal` reuses `SignalTypeSchema` rather than forking it.

### 4. The cursor, and why threads are entry-level

**The cursor is an opaque, adapter-minted, community-scoped token.**

```typescript
/** Opaque resume token. Only the adapter that minted it may interpret it. */
export const CommunityCursorSchema = z.string().min(1).brand('CommunityCursor');
```

Four rules, all conformance-asserted:

1. **Only the minting adapter interprets it.** No consumer may parse, compare, order or arithmetic a cursor. This is why the encoding is not a capability flag.
2. **It is self-identifying.** A cursor must encode enough to reject one minted for a different room, a different community, or a superseded epoch. The shipped room stream already does exactly this — `parseResumeCursor(lastEventId, after, { resourceId: roomId })` plus `STREAM_EPOCH`, framed as `id: ${roomId}-${STREAM_EPOCH}-${seq}` (`routes/room-events-handler.ts:69-73,118`). A foreign cursor is a plausible value that would silently skip real entries, so it must be **rejected, not bounded**.
3. **Resume is gap-free or it throws**, eagerly, at call time. There is no best-effort, and — since §Decisions resolved after SPECIFY, OQ6 cut the `resume` flag — no per-adapter opt-out either: this is a property of the port that every adapter owes, not a capability one may decline. A backend that cannot serve a given cursor gap-free throws `StaleCommunityCursorError` for that cursor; one that could never serve any cursor gap-free does not belong behind this port until it can, and §6 shows what "with effort" looks like for the hardest of the three.
4. **Every entry carries the cursor that resumes after it** (`CommunityEntry.cursor`). That is what replaces `seq` for a consumer: you resume from an entry without knowing what is inside the token.

**Ordering and dedupe, since `seq` is gone.** Two invariants take its place, and both are asserted:

- **Order is the adapter's emission order.** History is emitted oldest-first; live is emitted in commit order. `createdAt` is for display, never for sorting — Buzz's is wall-clock and can tie or skew.
- **Dedupe is by entry `id`, never by cursor.** So entry ids must be stable and unique within a room. They already are on both sides: `room_entries` has `uniqueIndex(roomId, id)`, and a Nostr event id is a content hash. The shipped handler's `highestSent` numeric watermark (`room-events-handler.ts:132,155`) does not survive to remote rooms and must become an id set in the consumer.

**Exhaustion is declared, never inferred.**

```typescript
export const CommunityEntryPageSchema = z.object({
  entries: z.array(CommunityEntrySchema),
  /** `null` is the ONLY authority on exhaustion. Callers MUST NOT infer "no more" from `entries.length < limit`. */
  nextCursor: CommunityCursorSchema.nullable(),
});
```

Banked directly from Buzz: their kind:39006 window-bounds overlay's own doc says it is _"the only authority on exhaustion — clients must not infer `has_more` from row counts"_ (`core/kind.rs:377-380`), and their `limit` is clamped to 2000 server-side (`req.rs:25`), so a short page is routine.

**At the port, a thread is a relation between entries, and `listRooms` never returns one.** When this section was written that was the narrow claim, made against a storage model that disagreed: ADR `260726-170125` still said "a thread is a child room." ADR `260728-022013` has since superseded exactly that one clause — everything else in `260726-170125` stands — and cites this section among its reasons, so **storage and the port now agree by decision rather than by translation.** The port's claim is unchanged by the agreement; what changed is that it is no longer a divergence anyone has to maintain. The decision is made, and DOR-634 has since shipped the migration that makes the code agree.

```typescript
// on CommunityEntry
parentEntryId: z.string().nullable(),      // the entry this replies to
threadRootEntryId: z.string().nullable(),  // the entry that roots the thread
depth: z.number().int().min(0),            // 0 for top-level; >1 only when threadDepth === 'unbounded'
thread: z.object({ replyCount: z.number().int().min(0), lastReplyAt: z.string() }).optional(),
```

Three reasons this is the honest seam rather than a compromise:

- Buzz's threads genuinely are tags on messages in the same channel, arbitrarily deep. A room-level relation cannot represent that without inventing a synthetic child room per thread and discarding ancestry beyond level one.
- **Our own schema already carried half of it, and ADR `260728-022013` promotes it the rest of the way.** `rooms.rootEntryId` is "the parent entry this thread hangs off" — an entry-level pointer that exists today. That ADR's migration shape gives `room_entries` a nullable `parentEntryId` plus the root pointer this port already names, and retires `rooms.parentId`, `rooms.rootEntryId`, `idx_rooms_parent_id` and the `'thread'` member of `RoomKind`. Nothing is invented; a field that already exists is moved to where it always belonged. That migration has since landed, so the translation a local adapter would once have needed — projecting a thread room's entries with `threadRootEntryId = room.rootEntryId`, `parentEntryId = room.rootEntryId`, `depth = 1` — has expired unused: the columns hold those values directly now.
- Buzz's kind:39005 thread-summary overlay — `{reply_count, descendant_count, last_reply_at, participants}`, synthesized at query time and never stored — is the same object as our "N replies" projection, arrived at independently. Two designs converging on it is good evidence the seam is right.

**The cost that was, and what replaced it.** As written, this design's price was a permanent divergence: the local adapter's `listRooms` would have to filter `kind === 'thread'` out of today's `RoomService.listRooms` (which returns thread rooms as `RoomSummary`s), threads would be reachable only through `listEntries(roomId, { thread })`, and the cockpit's thread surfaces would have to be re-pointed at the entry relation. This section called that "the largest single consequence of the design."

**ADR `260728-022013` dissolved it rather than paying it.** Its Consequences → Positive records the outcome directly: "the local adapter no longer filters `kind === 'thread'` out of `listRooms`, the 'largest single consequence' of that spec's design disappears, and its open question about the cockpit's thread surfaces is answered rather than deferred." The local adapter is off the hook entirely, which is the part that matters here.

**The cockpit's thread surface was bigger than that ADR recorded, and it has since been retired outright.** When `260728-022013` was written on 2026-07-28 it inventoried a `?thread=` search param that four call sites read and "nothing in the client ever writes," plus one icon branch. That was already short by one feature: the command palette had gained `paletteRoomTarget` / `threadParentLabel` in `4300e7242` (PR #575) one day after the ADR, and `paletteRoomTarget` was the only thing in the client that ever WROTE `?thread=`. DOR-634 shipped in three parts and all of it is now gone — PR #597 retired `?thread=`, both palette functions and the `RoomAvatar` branch, and the migration in PR 3 dropped `rooms.parentId`, `rooms.rootEntryId` and the `'thread'` member of `RoomKind`. **The lesson worth keeping is the one about the inventory, not the list:** that ADR called its surface table "exhaustive by intent" and it was wrong in at least seven places across three reviews, which is why its own text now says so.

What is left is a real cost, but a different one, and it is not this port's. DOR-634 owns a schema migration, an entry-level `POST /api/rooms/:id/threads`, and the sharpest recorded negative of the move: **the parent room's unread count changes meaning, and the shipped mark-read path cannot clear it** — `countUnread` counts every entry above the cursor with no visibility predicate, while `useMarkRoomRead` only ever advances to the newest entry the open room rendered. That was a rooms problem with two candidate shapes named in the ADR; DOR-634 took a third — put the visibility predicate in the render only, and change neither the cursor path nor the count — and it is unchanged by anything in this contract. DOR-634 has landed, so the filter has nothing to filter. Either way the port's shape is the one all three backends share, which is why it was the right seam before the storage agreed with it.

### 5. Connection, admission, and the four outcomes

```typescript
export const CommunityConnectionSchema = z.object({
  /**
   * - 'connected'      — reading and (if `canPost`) writing.
   * - 'not-admitted'   — the credential is VALID and this community has not
   *                      admitted it. An operator action is required and there is
   *                      no in-protocol way to ask.
   * - 'unauthorized'   — the credential is wrong, expired, rejected, or banned.
   * - 'unreachable'    — the host did not answer.
   */
  status: z.enum(['connected', 'not-admitted', 'unauthorized', 'unreachable']),
  /** The connected identity as this community knows it. Present iff 'connected'. */
  identity: CommunityMemberRefSchema.optional(),
  /**
   * Plain-language "what happens next", REQUIRED on 'not-admitted'. e.g. "Ask
   * whoever runs this community to let you in — there is no way to request it
   * from here." Never a raw protocol string. The precedent is
   * `ConnectorCapabilities.custody`: an honest disclosure the UI can render.
   */
  disclosure: z.string().optional(),
  /** Diagnostic detail for the log, present on any non-connected status. Never rendered raw. */
  error: z.string().optional(),
});
```

**Why four and not a boolean.** The spike named three distinct failures the adapter must keep apart — _"wrong credential" / "credential fine, not admitted here" / "relay unreachable"_ — and collapsing them produces the worst possible UX: a person told to check a credential they cannot see, for a machine-managed key that is in fact perfectly valid. `'not-admitted'` is the outcome the whole community program hinges on, because it is also what `apps/community` does before an invite is redeemed.

**Admission is re-evaluated, never copied.** D8's "removing the human removes their agents" is the same property one level down, and `research/20260727_agent-identity-in-communities.md` §5.1 principle 2 states it generally: _"admission is derived from the owner and re-evaluated per connection, never copied into a row that must be kept in sync."_ Buzz's own removal path is the counter-example — no session teardown, no agent enumeration, no `WHERE agent_owner_pubkey = <owner>` query anywhere, so removal is purely prospective and, on an open relay, has no effect at all. We take the motivation and refuse the mechanism: a join at read time, not a signed capability the owner cannot revoke.

**`'not-admitted'` invalidates that community's cached rooms. This is normative, not the local adapter's discretion.** Removal is not a separate outcome — a member who is removed and a member who was never let in reach the same status on their next `connect()`, which is exactly why one rule covers both and is a no-op for the second. On `'not-admitted'`, the cached rooms for that `CommunityRef` are dropped rather than served, the community lists zero rooms, and the connection's required `disclosure` is what the surface renders in their place (§8). The alternative fails in the most misleading way available: a cache that outlives admission shows a person a list of rooms they can click, each of which fails on read, which reads as "DorkOS is broken" rather than "you are not in this one any more." **[Amended 2026-07-28 (DOR-672): this invalidation must also delete that community's message-index rows, in the same transaction — see Amendment 1.]**

**The other three statuses do not invalidate**, and the asymmetry is the point. `'unreachable'` is not evidence about membership, and the cache is the only thing that makes an install readable while a host is down. `'unauthorized'` is not evidence either — the credential is what is wrong, and a ban arrives inside it indistinguishably from an expiry, so acting on it would throw away a correct cache on a re-authentication. Nothing is leaked by the difference: **the cache is never the access boundary.** Every adapter re-checks membership on read (§Security), so a stale cached room is a row that renders and then refuses, not a room someone gets to read.

**The residual, stated rather than hidden.** A member removed while offline still learns on their next connect. There is no push and this spec invents none: the community cannot reach the member's install, which is D2 and D9 working as intended, and Buzz's removal path notifies nobody at all. The guarantee is that the first connection after a removal is honest — not that a removal is observed when it happens.

### 6. Room availability, eviction, and a correction to the framing

The brief for this spec said an adapter "must read `CLOSED "restricted: channel access revoked"` as _archived_, not _error_." **That is half right, and the wrong half matters.** Buzz emits that same reason from two different causes:

- archiving a channel evicts every live subscription (`evict_all_channel_subscriptions`, `side_effects.rs:119-128`, emitted at `:85`), and
- an **open → private flip evicts non-members the same way** (`side_effects.rs:95-116`).

So the reason string is genuinely ambiguous, and an adapter that reads it as "archived" will tell a member who just lost access that the room was put away. The contract is therefore about the **shape**, not the cause:

> A room that becomes unservable mid-subscription yields a **terminal `room_closed` event on the stream** — never a thrown error, never a silent end — carrying `reason: 'archived' | 'access-revoked' | 'unknown'`. An adapter MUST NOT guess: the Buzz adapter re-reads the room's kind:39000 metadata and reports `'archived'` only when the `["archived","true"]` tag is present; a room that is no longer listable at all is `'access-revoked'`; anything else is `'unknown'`.

`'unknown'` exists so an adapter can be honest instead of confident. The universal assertion is that the terminal event arrives at all; the reason is checked only where the fixture arranged a known cause.

**How the Buzz adapter stays gap-free.** Worth writing down because it is the load-bearing evidence for cutting the `resume` flag (§Decisions resolved after SPECIFY, OQ6): it is the one backend a reader would assume cannot resume, and the reason the port can demand gap-free from everyone rather than asking. The gap-free keyset cursor is HTTP-only (`handle_channel_window_filter` has no caller outside `bridge.rs`), so a single-transport adapter cannot do it. The adapter speaks both:

1. Open the WS `REQ` first, with a small `limit`. The relay registers the subscription **before** running its historical query (`req.rs:364-386`), so from that instant forward nothing is missed.
2. Page backwards over HTTP `POST /query` with the composite `(until, before_id)` keyset until it reaches the caller's cursor, reading exhaustion from the kind:39006 overlay.
3. Dedupe by entry id.

That is the same "subscribe first, then read, then dedupe" order `room-events-handler.ts:127-131` already uses. It is more work than a single-transport read, and that is the point: the effort is the adapter's, so no assertion has to be weakened for a backend that can manage it with effort. A future backend that genuinely cannot manage it does not get a flag to say so — it gets a `StaleCommunityCursorError` on every cursor and a cold snapshot every time, which is the same observable behavior a `resume: 'none'` declaration would have produced, minus a branch in every consumer.

### 7. Credentials (D3)

**No credential crosses this port.** Not as an argument, not on a DTO, not in `features`. An adapter resolves its own from a server-side store keyed on its `CommunityRef`.

The contract, modelled directly on `resolveBetterAuthSecret` (`apps/server/src/services/core/auth/secret.ts`) because that function already solved this problem for the Better Auth secret and its properties are exactly the ones D3 needs:

| Property                                                                                                                                                       | Where it comes from                                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Directory `<dorkHome>/communities/<communityRef>/`, mode `0700`                                                                                                | `lib/dork-home.ts` is the single source of the data directory; `os.homedir()` is banned |
| Precedence: env override → persisted file → generate-and-persist                                                                                               | `resolveBetterAuthSecret:78-110`                                                        |
| New material is `0600`, with `chmodSync` re-asserted after write (`writeFileSync`'s `mode` is ignored when the file exists, and is subject to umask on create) | `secret.ts:104-107`                                                                     |
| Lax permissions are **repaired and warned**, not rejected — locking the owner out of their own instance is the worse failure                                   | `repairSecretPermissions:124-142`                                                       |
| The value is never logged; only its path is                                                                                                                    | `secret.ts:95-108`                                                                      |
| Never surfaced in any UI, config file, or API response                                                                                                         | D3: "nothing to write down and nothing to lose"                                         |

Per backend: `credential: 'none'` (local) holds nothing; `'machine-managed'` (Buzz) holds a generated secp256k1 secret key; `'user-account'` (`apps/community`) holds a session/refresh token obtained through a sign-in the person actually performs. All three are the same file discipline.

**The one assertion the shared suite can make, and the one it cannot.** It can and does assert **no credential leakage** — a planted credential string must appear in nothing the port returns (§9 U12). It cannot assert file modes: that is filesystem-specific and belongs in the Buzz adapter's own tests. Saying so here stops someone adding an `fs` dependency to a suite that must also run against a fake.

### 8. The registry and per-community degradation

`apps/server/src/services/communities/registry.ts`, mirroring `runtimeRegistry`:

- `register(adapter, label)`, `get(ref)`, `list(): CommunityDescriptor[]`, `getCapabilities(): Record<CommunityRef, CommunityCapabilities>`.
- **The registry is where a ref becomes legible.** It holds the `label` (§1), so a ULID never has to be rendered, logged or matched by eye; the adapter is never asked for it and never has to be told about a rename.
- **Dispatch is on `community`, never on a room id** — a bare room id is ambiguous by construction, which is the strongest argument for the pair address.
- The `LOCAL_COMMUNITY` adapter is always registered; the others are additive and each may fail to construct without taking the server down (`registerOptionalRuntime`'s tolerance, and ADR-0310's per-backend degradation principle).

`aggregate-community-rooms.ts` is `aggregateSessionList` with the nouns changed, and deliberately so:

```typescript
export const LIST_ROOMS_TIMEOUT_MS = 2_000;

export async function aggregateCommunityRooms(opts: {
  /**
   * Each configured community, descriptor included — a warning has to name the
   * community that failed, and the label is the registry's to supply (§1).
   */
  communities: { descriptor: CommunityDescriptor; adapter: CommunityAdapter }[];
  timeoutMs?: number;
}): Promise<{ rooms: CommunityRoom[]; warnings: CommunityWarning[] }>;
```

```typescript
/**
 * One community that could not contribute to a listing. The `label` is here and
 * on no other payload in this section (§1): a warning is the one place the
 * community is itself the subject, so it must be renderable without a lookup
 * back into the registry.
 */
export const CommunityWarningSchema = z.object({
  community: CommunityRefSchema,
  /** `CommunityDescriptor.label` — what a person calls this community. */
  label: z.string().min(1),
  /** Plain language, already safe to render. A `'not-admitted'` community carries its `disclosure` here. */
  message: z.string().min(1),
});
export type CommunityWarning = z.infer<typeof CommunityWarningSchema>;
```

`Promise.allSettled` with a per-community timeout; fulfilled listings merge and sort by `lastActivityAt` descending; a rejected or timed-out community contributes one `CommunityWarning` and zero rooms. **One unreachable community degrades to a warning, never a failed request and never a blank list.** A `'not-admitted'` community is not an error either — it lists zero rooms and carries its `disclosure` as a warning, because the honest thing to render is "you are not in this one yet", not a spinner. Its cached rooms are dropped rather than served stale, which §5 now requires of every `'not-admitted'` result and not only of a first connection.

### Code structure & file organization

```
packages/shared/src/community-adapter.ts          # the port, schemas, both typed errors
packages/shared/package.json                      # + "./community-adapter" export subpath
packages/test-utils/src/community-conformance.ts  # the suite
packages/test-utils/src/fake-community-adapter.ts # configurable across the whole flag matrix
packages/test-utils/src/index.ts                  # + two re-exports
apps/server/src/services/communities/
  index.ts                                        # barrel + factory (mirrors services/rooms/index.ts)
  registry.ts                                     # CommunityRegistry
  aggregate-community-rooms.ts                    # ADR-0310 shape
  credentials.ts                                  # the §7 contract, over dorkHome
  __tests__/
```

Both errors live in `community-adapter.ts`. (`StaleResumeCursorError` lives in `session-stream.ts` rather than `agent-runtime.ts` because the session stream is its own module; we have no such split, and one module is simpler.)

```typescript
/** Thrown EAGERLY by `subscribeRoom` when a cursor cannot be served gap-free. Callers fall back to a cold snapshot. */
export class StaleCommunityCursorError extends Error {
  /* community, roomId, reason */
}

/** Rejected by any capability-gated method whose capability is off. Never a silent no-op. */
export class CommunityUnsupportedError extends Error {
  /* community, capability, method */
}
```

### API changes

**None in this spec.** No route is added, changed or removed. The port is server-internal; `GET /api/rooms` and its siblings keep their current shapes, and the question of how a remote room reaches the cockpit belongs to the local-adapter and `apps/community` tickets.

### Data model changes

**None in this spec**, and the absence is deliberate: a schema change with no reader is a half-migration, which AGENTS.md forbids. What the **local-adapter** ticket must do is recorded here so it is not rediscovered:

- `rooms` gains `communityRef` (`NOT NULL DEFAULT 'local'`). It has no community column today.
- `rooms_channel_slug_unique` is a partial unique index over `(slug)` where `kind='channel' AND archived=0` — **global**. It must become `(communityRef, slug)`, or two communities' `#general` collide and the second one cannot be cached at all.
- `room_entries`' primary key `(roomId, seq)` and `room_entries_room_id_entry_id_unique` are per-room; with a community column, room ids are only unique within a community, so both must be re-scoped. **[Amended 2026-07-28 (DOR-672): the message index must survive this re-scoping, and it owes a delete — see Amendment 1.]**
- `authors.naturalKey` needs no change — D3 already established that a remote member is **additive**, a new `naturalKey` scheme minting opaque ids through the same path, not a migration of existing rows.
- `roomMembers` gains a nullable `role` only if a remote roster's roles are cached locally; whether they are is the local-adapter ticket's call.
- **Sequencing with DOR-634. Settled: it landed first.** That ticket touched the same two tables from the other side — `room_entries` gained `parentEntryId`, and `rooms.parentId` / `rooms.rootEntryId` / `idx_rooms_parent_id` retired (ADR `260728-022013`, migration `0038`). Neither migration blocked the other, but the warning was real and is worth keeping in general form: whichever of two migrations over one table lands second re-scopes or retires what the first just moved, so neither may be written in ignorance of the other.

## User Experience

The port has no UI. What it decides about UX is what a later surface is allowed to promise, and four of those are worth stating because they are easy to get wrong later:

- **An unread badge is not universal.** `unreadCount` is `number | null`, and `null` means "not applicable here" — exactly the semantic `RoomSummary.unreadCount` already carries for a non-member (`packages/shared/src/room-schemas.ts:178,187`). Any badge, digest or notification must gate on `readCursor === 'server'` or render nothing. It must never render `0`: a silent room and a room whose unread cannot be computed are different states, and conflating them tells the reader something false.
- **"You are not in this one yet" is a first-class state**, not an error toast. `status: 'not-admitted'` carries a `disclosure` written in plain language, and the community lists zero rooms without failing — including rooms it listed a minute ago, which are dropped rather than left clickable (§5).
- **A community has a name, never a ULID.** A `CommunityRef` is not for reading; `CommunityDescriptor.label` is the only thing a surface ever shows, and every warning carries it so a degraded community is nameable without a lookup (§1, §8).
- **A room that goes away says so.** `room_closed` with a reason, on the stream — a member who lost access is not told the room was archived, and a subscription never just stops.

## Testing Strategy

### 9. `communityConformance` — what it asserts

`communityConformance(makeAdapter, opts)` registers a `describe` block. Division of labour, copied verbatim from `connector-conformance.ts`: **this suite covers community BEHAVIOR; the TypeScript interface covers SHAPE** (an adapter omitting a method fails compilation). Legitimate differences are declared via flags and **branched**, never weakened.

**Required hooks** (required, in the spirit of `makeUnexposableAccount` — an optional hook is a hook a backend can decline until the case stops being tested):

| Hook                                             | Why required                                                                                                                                             |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `makeAdapter: () => CommunityAdapter`            | Fresh instance per test                                                                                                                                  |
| `seedRoom: (a) => Promise<string>`               | Every backend must be able to arrange one readable room. Read-only Buzz arranges it out of band (`buzz-admin`), which is the honest cost of that backend |
| `plantedCredential: string`                      | The leakage assertion has nothing to look for otherwise                                                                                                  |
| `makeUnreachableAdapter: () => CommunityAdapter` | The typed-failure branch. An adapter that throws instead of returning `unreachable` fails here                                                           |

**Optional hooks:** `makeUnadmittedAdapter` (the `'not-admitted'` branch), `makeUnauthorizedAdapter`, `revokeOwner` (D8's derived-admission property), `makeEvictedRoom` (the `room_closed` reason), `secondCommunity` (cross-community isolation).

#### Universal — every adapter, no branch

| #       | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **U1**  | `getCapabilities()` parses `CommunityCapabilitiesSchema`; `capabilities.type === adapter.type`. When `roomList === 'poll'`, `roomListPollIntervalMs` is present. When `roles.supported`, `values` is non-empty and `roles.default` (if set) references a declared `values[].id`; when not, `values` is `[]`. (The last is `runtimeConformance`'s `permissionModes` assertion, kept identical.)                                                    |
| **U2**  | `connect()` resolves to a valid `CommunityConnection` and **never throws** — driven at least twice, once against the working fixture and once against `makeUnreachableAdapter`. `'connected'` carries an `identity`; every other status carries an `error`.                                                                                                                                                                                       |
| **U3**  | `adapter.community` parses `CommunityRefSchema` — so a ref that is not path-safe fails here, before it ever becomes a directory under `<dorkHome>/communities/` (§1, §7). Every `CommunityRoom` parses, and **every address it carries equals `adapter.community`**. `getRoom(id)` round-trips each id from `listRooms`, and returns `null` (never throws) for an unknown one.                                                                    |
| **U4**  | `listRooms()` returns **no threads**. Threads are entry-level on this port, so a room that is itself a thread is a leak of a storage model into the contract.                                                                                                                                                                                                                                                                                     |
| **U5**  | `subscribeRoom(roomId)` with no cursor yields a `snapshot` event first, carrying a `cursor`, before any `entry`.                                                                                                                                                                                                                                                                                                                                  |
| **U6**  | Resuming from that snapshot cursor is **gap-free or throws eagerly** — the throw must happen before the first `next()`, asserted by constructing the iterable and awaiting nothing. There is no third outcome; a resume that returns a partial stream fails. This is universal because §Decisions resolved after SPECIFY, OQ6 cut the `resume` flag: it absorbs what was a capability-branched row, and no adapter can declare its way out of it. |
| **U7**  | A cursor minted for room A, presented for room B — and, when `secondCommunity` is supplied, a cursor from another community — is **rejected** with `StaleCommunityCursorError`, never silently served.                                                                                                                                                                                                                                            |
| **U8**  | `listEntries` signals exhaustion **only** via `nextCursor === null`. A full page with more available carries a non-null cursor; paging to `null` visits every entry exactly once.                                                                                                                                                                                                                                                                 |
| **U9**  | Entry ids are stable and unique within a room, and a replay window overlapping a live window yields **no duplicates after id-dedupe**. This is what replaces `seq` as the ordering contract.                                                                                                                                                                                                                                                      |
| **U10** | Every entry's `authorId` is its actual author. An entry authored by an agent **never** carries its owner's id — `research/20260727_agent-identity-in-communities.md` §5.1 principle 1, and the cheapest invariant to lose.                                                                                                                                                                                                                        |
| **U11** | A room made unservable mid-subscription yields a terminal `room_closed` with a valid reason — never a throw, never a silent end. (Cause-specific reason checked only under `makeEvictedRoom`.)                                                                                                                                                                                                                                                    |
| **U12** | **No credential leakage.** `plantedCredential` appears in no serialization of anything the port returns — capabilities, rooms, members, entries, invites, connection.                                                                                                                                                                                                                                                                             |
| **U13** | **Every capability-gated method whose capability is off rejects with `CommunityUnsupportedError`** — iterated over the off flags, so a new flag is covered the day it is added. Never a silent no-op, and never a partial write (the store is re-read after each refusal and must be unchanged).                                                                                                                                                  |
| **U14** | `disconnect()` resolves and is idempotent, including on a never-connected adapter.                                                                                                                                                                                                                                                                                                                                                                |
| **U15** | `listMembers` returns well-formed members including the connected identity when it is a member; unknown room → `[]` or `null`, never a throw.                                                                                                                                                                                                                                                                                                     |
| **U16** | **[Added 2026-07-30 (DOR-754) — see Amendment 3.]** `subscribeRoom` on a room this identity cannot stream throws `CommunityRoomNotFoundError` **eagerly** — asserted by constructing the call and awaiting nothing, the U6/U7 shape. Universal and un-gated: every backend can be handed a fabricated room id, so nothing needs arranging and no capability governs it.                                                                           |

#### Capability-branched — the difference is declared, not weakened

| #       | Flag                                                       | True/`on` branch                                                                                                                                                                                                                                                                                                              | Off branch                                                                                                                                                                                                                                                                                                    |
| ------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1**  | `canPost`                                                  | `post` commits; the entry appears on the live subscription with `authorId === identity`; a second post is a distinct entry id                                                                                                                                                                                                 | `post` rejects `CommunityUnsupportedError`                                                                                                                                                                                                                                                                    |
| **C2**  | `roomAdmin`                                                | create → rename → archive round-trips; an archived room reports `archived: true` and is **not** an error                                                                                                                                                                                                                      | all three reject                                                                                                                                                                                                                                                                                              |
| **C3**  | `roles.supported`                                          | every member's `role` id is one of `roles.values`; at most one descriptor sets `isOwner`                                                                                                                                                                                                                                      | every member's `role` is `null`                                                                                                                                                                                                                                                                               |
| **C4**  | `readCursor: 'server'`                                     | set → get round-trips; `unreadCount` is a `number` for a joined room                                                                                                                                                                                                                                                          | —                                                                                                                                                                                                                                                                                                             |
| **C5**  | `readCursor: 'client-opaque'`                              | set → get round-trips the **own** cursor; `unreadCount` is `null` on **every** room                                                                                                                                                                                                                                           | —                                                                                                                                                                                                                                                                                                             |
| **C6**  | `readCursor: 'none'`                                       | —                                                                                                                                                                                                                                                                                                                             | both reject                                                                                                                                                                                                                                                                                                   |
| **C7**  | `invite: 'room'`                                           | `createInvite({ roomId })` returns an invite scoped to that room                                                                                                                                                                                                                                                              | —                                                                                                                                                                                                                                                                                                             |
| **C8**  | `invite: 'community'`                                      | `createInvite({})` succeeds                                                                                                                                                                                                                                                                                                   | **`createInvite({ roomId })` REJECTS** — no silent widening, no substituting "an admin adds you". The sharpest assertion in the suite                                                                                                                                                                         |
| **C9**  | `invite: 'none'`                                           | —                                                                                                                                                                                                                                                                                                                             | rejects                                                                                                                                                                                                                                                                                                       |
| **C10** | `agentAdmission: 'owner-vouched'`                          | **P1** the admitted agent is a distinct member from its owner; **P2** `ownerMemberId` is the connected identity; **P3** its role never `administers`, whatever the owner's role is; **P4** (under `revokeOwner`) after the owner is removed, the agent's next use is refused — asserted by **use**, not by a row disappearing | `admitAgent`/`revokeAgent` reject                                                                                                                                                                                                                                                                             |
| **C11** | `threadDepth: 1`                                           | `post` with a `parentEntryId` that is **already inside a thread** rejects; every entry's `depth <= 1`                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                             |
| **C12** | `threadDepth: 'unbounded'`                                 | a depth-2 reply is accepted and `listEntries({ thread })` returns it with `depth > 1`                                                                                                                                                                                                                                         | —                                                                                                                                                                                                                                                                                                             |
| **C13** | `roomList: 'push'`                                         | a room created during `subscribeRoomList` yields `room_added` promptly                                                                                                                                                                                                                                                        | —                                                                                                                                                                                                                                                                                                             |
| **C14** | `roomList: 'poll'`                                         | the same event arrives within a generous multiple of `roomListPollIntervalMs`. Shape is identical; only latency differs                                                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                                             |
| **C15** | `signals`                                                  | `'both'`: publish → receive on a second subscription                                                                                                                                                                                                                                                                          | `'none'`: publish rejects and no signal is ever yielded. There is no third branch — OQ8 cut `'receive'`. **[Amended 2026-07-29 (room-presence): the `'both'` branch also round-trips the presence payload — every field of it, on a second subscription, and without becoming durable. See Amendment 2 §C.]** |
| **C16** | `credential: 'machine-managed'`                            | `connect()` against a **fresh, empty** credential store reaches a terminal status with no interaction — the mechanical form of D3's "nothing to write down"                                                                                                                                                                   | —                                                                                                                                                                                                                                                                                                             |
| **C17** | `admission: 'out-of-band'` (under `makeUnadmittedAdapter`) | `connect()` returns `'not-admitted'` with a non-empty `disclosure` — **not `'unauthorized'`**. Collapsing them is the failure that would tell a person to fix a key they cannot see                                                                                                                                           | —                                                                                                                                                                                                                                                                                                             |
| **C18** | `responseMode`                                             | `setResponseMode` round-trips and appears on `listMembers`                                                                                                                                                                                                                                                                    | rejects; members carry no `responseMode`                                                                                                                                                                                                                                                                      |

**Where each suite runs.** `FakeCommunityAdapter` is driven across the whole matrix in `packages/test-utils/__tests__/`, so a flag combination none of the three real backends uses is still gated. Each real adapter registers the suite in its own test file. The Buzz adapter's run is env-gated on `BUZZ_RELAY_URL` and skipped when absent — the pattern `crates/buzz-test-client`'s own `#[ignore]` e2e tests use, and the one `runtimeConformance` already uses for a runtime whose binary is missing. **There is no public Buzz relay** (spike §9: every OSS-facing default is `ws://localhost:3000`, and the two hosted ones are Block-internal), so that ticket budgets a Docker Compose setup.

### Other tests

- **Unit:** `aggregateCommunityRooms` — merge order, per-community timeout, one rejecting community produces a warning and does not fail the aggregate, a `'not-admitted'` community lists zero rooms with its disclosure **and contributes none of the rooms it listed before** (§5's invalidation, which is the assertion that would otherwise be discovered by a person clicking a room they were removed from), every warning carries a `label`. Mirrors `aggregate-session-list`'s existing tests.
- **Unit:** `CommunityRegistry` — dispatch on `community`, an unregistered ref throws a named error rather than falling back to local (the `RuntimeNotRegisteredError` precedent: masking a mismatch hides a routing bug), `LOCAL_COMMUNITY` always present.
- **Unit:** credential resolution — env override wins; a persisted file is reused; a fresh generate is `0600`; a `0644` file is repaired and warned; the value never reaches a log line.
- **No e2e and no browser test in this spec.** There is no UI. `apps/e2e` gets its first community test when a surface exists to drive.

## Performance Considerations

- **Aggregation is fan-out with a budget.** `LIST_ROOMS_TIMEOUT_MS = 2_000` per community, `Promise.allSettled`, matching `LIST_SESSIONS_TIMEOUT_MS`. A cold or slow community must not stall the list.
- **Polling has a floor.** `roomListPollIntervalMs` is adapter-declared and must be sane (Buzz's `REQ {"kinds":[39000],"limit":500}` is one relay-signed event per accessible channel). The registry does not poll; the adapter does, once per community, and fans out internally — N subscribers must not become N polls.
- **The dual-transport backfill is bounded.** Buzz's WS `limit` is clamped to 2000 server-side; the HTTP keyset page size is the adapter's choice. Backfill is depth-bounded by the caller's cursor, so a resume costs pages proportional to the gap, not to room history.
- **Dedupe is a set, not a scan.** Id-based dedupe over the replay window is O(window), and the window is bounded by the resume gap.
- **No new hot path in `apps/server`.** Nothing in this spec runs per turn or per message on the existing session spine.

## Security Considerations

- **No credential crosses the port** (§7), and U12 makes that mechanically checkable rather than a convention.
- **No filesystem path crosses the port.** `authors.naturalKey` is server-only for a reason `author-registry.ts` states plainly — a raw `agentPath` _"would put `/Users/dorian/…` in front of every member of every room."_ The same applies to `workspaceId`, which is why §Decisions keeps it off the wire entirely.
- **Capability does not flow owner → agent (D8, C10/P3).** A member's admin-less agent is not an admin's agent; an agent admitted by an admin is still not an admin. Buzz enforces this by looking up the acting pubkey rather than the owner's; we enforce it by asserting it.
- **Quota must aggregate per owner, not per identity.** Not enforced by this port — but `CommunityMember.ownerMemberId` exists so the community server **can**. Buzz is the worked counter-example: quota keys carry no owner term and agents get a _higher_ budget than humans (120/min vs 60/min), so N agents buy `60 + 120N`. That is D8's stated hole and it must be closed at `apps/community`, not inherited.
- **A room id is not a capability.** `RoomAddress` is an address, not an authorization; every adapter re-checks membership on read, exactly as the shipped `requireVisibleRoom` reports the same `ROOM_NOT_FOUND` for "no such room" and "not visible to you" so a probe cannot distinguish them.
- **`'unknown'` is a legitimate reason.** An adapter that cannot tell archived from access-revoked must say so rather than assert the friendlier one.
- **The port is server-side, so D2's second reason holds:** a secp256k1 private key is a config file rather than a security defect in browser storage.

## Documentation

- `contributing/adding-a-community-adapter.md` — new, cut to the shape of `contributing/adding-a-runtime.md`: the flag matrix, the required conformance hooks, the credential contract, and the two typed errors. The single most valuable artifact for the three adapter tickets. **[Amended 2026-07-30 (DOR-754): three typed errors, and the guide now also carries the room-before-cursor ordering rule and the identical-refusal rule; see Amendment 3.]**
- `contributing/architecture.md` — one paragraph naming the fourth seam beside `AgentRuntime`, `Transport` and `ConnectorProvider`.
- `AGENTS.md` — one line in Architecture once the first adapter ships, not before (the demo-claim gate: nothing claims a surface works until it does).
- **No user-facing docs and no changelog fragment in this spec.** Nothing a person can see changes. **[Amended 2026-07-30 (DOR-592): the last sentence used to read "the changelog fragment lands with the first adapter", and the first adapter has now landed deliberately without one — wrapping local rooms behind this port changed no surface a person can reach, so the same "nothing a person can see" test that exempted the contract exempted its first implementation too. The fragment lands with the first adapter somebody can SEE, not the first one that exists.]**

## Implementation Phases

- **Phase 1 — the contract.** `packages/shared/src/community-adapter.ts`: schemas, capabilities, the port interface, both typed errors, the `exports` subpath. Typecheck-only; no behavior.
- **Phase 2 — the gate.** `FakeCommunityAdapter` across the whole flag matrix, then `communityConformance` with all fifteen universal and eighteen branched assertions, then the fake's own suite run. **The fake must be written before the suite** and must be able to declare every legal combination, or the suite can only assert what our own backends happen to do — which is the failure mode this whole design exists to prevent.
- **Phase 3 — the dispatcher.** `services/communities/`: registry, `aggregateCommunityRooms`, credential resolution, with unit tests. `LOCAL_COMMUNITY` registered; no real adapter behind it yet.

Phases 1–3 are this ticket. The three adapters are DOR-59x each, in D5's order, and each ships with its own `communityConformance` registration.

## Decisions resolved after SPECIFY

All nine of this document's own Open Questions have been answered, and the section that listed them is this one. They keep their original numbers — which are this spec's, not the parent ideation's numbering used in §Decisions resolved in SPECIFY — so anything that cited "open question 6" still resolves. The parent's series runs OQ1–OQ6, so a bare `OQ7`/`OQ8`/`OQ9` elsewhere in this document can only mean this one; `OQ1`–`OQ6` are always qualified where they appear. The standard is that section's: the rationale matters as much as the answer, and where an answer changed the body of this spec, the bullet says where.

- **OQ1 — does `listRooms` excluding threads break the cockpit's thread pane? DISSOLVED, and now shipped.** ADR `260728-022013`, written the day after this spec, supersedes the "a thread is a child room" clause of ADR `260726-170125` and puts the thread relation on the entry; DOR-634 implemented it in three PRs, the last of which dropped the columns and the `'thread'` room kind. There is no divergence left for a local adapter to translate, and no thread surface left to re-point: the client's `?thread=` param, its four readers, its one writer (`paletteRoomTarget`) and the `RoomAvatar` branch are all retired. The half of this question that survived the dissolution — "the ticket is larger than it looks" — turned out to be true of **DOR-634** rather than of the local adapter, and it was true for the reason recorded in §4: an inventory that called itself exhaustive was not. **Where it landed:** §4's opening thread paragraph, the "our own schema already carried half of it" bullet, and the cost paragraph (now "The cost that was, and what replaced it"); the mismatch table's row 2; §Related ADRs, which gains the new ADR; and the candidate-ADR list, which loses an entry because that decision is now written.
- **OQ2 — is `unreadCount` on `CommunityRoom` right, or should unread be a separate call? RESOLVED: it stays on the room.** The alternative, `getUnreadCounts(roomIds)`, buys a cleaner gate and pays a second call for every list — and, against a backend with no batch unread endpoint, one call per room. What it would avoid carrying is a field that is `null` on two of three backends, which is to say a field those two spend nothing to return. Meanwhile the shipped `RoomSummary` already carries it with exactly this `null`-means-not-applicable semantics (`packages/shared/src/room-schemas.ts:178,187`), so keeping it is one shape across local and remote instead of two, and the gate the separate call was supposed to buy is stated where a consumer meets it anyway (§User Experience; conformance C4/C5 assert both halves). It is reversible: no other part of the port depends on unread arriving with the room, so a measured-slow list can move it later without touching the contract.
- **OQ3 — should an agent's own consent to being conscripted into a room be on the port? RESOLVED: no, and this is a decision rather than a deferral.** D8 settles it: only a member adds their own agents, so the third party the consent would protect against does not exist, and an agent does not get to refuse its owner. Buzz's `channel_add_policy ∈ {anyone, owner_only, nobody}` answers a question their model has and ours does not — theirs is a relay where a stranger may add your bot. What an agent may do is **ask** to leave, by posting, like anyone else in the room. What it may never do is leave unilaterally: an agent that removes itself is indistinguishable, from the room's side, from one that broke, and `meta/agent-etiquette.md` E1 states the general principle — silence where a turn was owed "is not neutral, it reads as a failure." **Where it landed:** `admitAgent`'s TSDoc in §3, which records that `AdmitAgentInput` deliberately has no consent field — the place someone would otherwise add one.
- **OQ4 — does `roles` need `rank`? RESOLVED: no ordering in v1.** `administers` remains the only predicate the product branches on, and the evidence for stopping there is a backend's own: Buzz's `Bot` sits outside their five-role hierarchy, and their git policy layer had to restate it — "Bot is a designation (what it is), not a permission tier (what it can do)" (`api/git/policy.rs:380-386`). A `rank` would require every adapter to place every declared role on one line, and for at least one real backend there is no true answer to give. If a moderation UI or a role picker ever needs "is this role above that one," the shape to add is a partial order with an explicit incomparable case — a later decision, made with a real surface in front of it, rather than a guess made now that every adapter would have to honour. **Where it landed:** `CommunityRoleDescriptorSchema`'s TSDoc says the omission is deliberate and why.
- **OQ5 — what is a `CommunityRef` made of? RESOLVED: a locally-minted ULID, never supplied by a remote, with a human-readable `label` carried beside it.** The competing candidate was a normalized host, whose whole appeal is legibility — and a host is the one attribute of a remote community that changes without the community changing. Because the ref is a directory name (`<dorkHome>/communities/<ref>/`) and the foreign key on every cached room, a host-derived ref converts "the relay moved" into a rename across a filesystem and a schema. A ULID does not move, is path-safe by construction, sorts by mint time, and costs no new dependency: `ulidx` is already how rooms (`apps/server/src/services/rooms/room-service.ts:258`), entries (`:624`) and authors (`author-registry.ts:168`) get their ids. Its one real cost is that nobody can read it, which the `label` pays back — and `LOCAL_COMMUNITY = 'local'` stays reserved, safely, because a ULID is 26 characters of uppercase Crockford base32 and can never collide with a five-character lowercase literal. **The label lives on `CommunityDescriptor`**, once per community, given to the registry at registration rather than reported by the adapter: not on `CommunityCapabilities`, where §2 admits nothing that is merely descriptive, and not on `CommunityRoom`, where a per-community constant would be repeated per row and would be the thing that disagrees with itself after a rename. `CommunityWarning` is the one exception, because a warning is the one payload whose subject is the community itself. **Where it landed:** §1 (the schema now carries a path-safety regex and the new `CommunityDescriptorSchema`, plus two paragraphs of reasoning), §8 (`register(adapter, label)`, `list(): CommunityDescriptor[]`, `label` on every warning), §User Experience, and conformance U3, which now parses `adapter.community` so an unsafe ref fails in the suite rather than in a path.
- **OQ6 — should `resume: 'none'` exist at all? RESOLVED: cut — and the `resume` flag with it.** The question asked whether the `'none'` member earns its place. Following it honestly takes one more step: with `'none'` gone, `resume` is a one-valued enum, which is worse than no flag at all — a field every adapter must set, every fake must vary, and every consumer is invited to branch on, that can only ever say one thing. AGENTS.md's "every element justifies its existence" applies to a capability exactly as it applies to a component. So the guarantee moves from a declaration to a property of the port: **a resume is gap-free or it throws eagerly, on every adapter, always.** Nothing about refusal is lost. `StaleCommunityCursorError` still exists, still throws at call time, and U7 — a cursor from another room or another community is rejected, never silently served — is untouched; the stale-cursor path is not what was cut. What is cut is a backend's ability to announce in advance that it will always refuse, which at the consumer is indistinguishable from a backend that refuses every cursor it is handed. The evidence that this is safe is §6: the one backend a reader would bet against reaches gap-free through a dual transport, and it does so by the adapter working harder rather than by the port asking for less. **Every site touched:** the cursor bullet in §Decisions resolved in SPECIFY (amended in place, since it is a record of what SPECIFY decided); **G3**; §2's lead-in, which now explains the absence, and the deleted flag in `CommunityCapabilitiesSchema` (its comment sections renumber 1–7); the `resume` row of the three-backend table, deleted; `subscribeRoom`'s TSDoc in §3; **rule 3** in §4; §6's dual-transport paragraph, retitled "How the Buzz adapter stays gap-free" and with its closing sentence rewritten; conformance **U6**, which absorbs what was the positive branch of **C15**, and the C15 row itself, deleted (C16–C19 renumber to C15–C18); Phase 2's assertion count, now eighteen branched; and the first candidate ADR, restated around the property rather than the flag.
- **OQ7 — where do reactions land? RESOLVED: off the port in v1, with the attach point recorded.** Adding them now would invent a capability with zero implementations, which is the exact failure D5's sequencing exists to prevent — the local backend has no reactions, so the flag could only ever describe Buzz. What the question was right about is that leaving them out defers a mismatch rather than avoiding one, so the mismatch is written down instead of rediscovered: `roomEntries.id` is already the attach point (`packages/db/src/schema/rooms.ts:196`, unique per room at `:234`), and a Nostr kind:7 reaction points at an event id, so both sides already agree on what a reaction hangs off. The shape is known; only the demand is missing. **Where it landed:** the Non-Goals bullet that names reactions now names the attach point too.
- **OQ8 — is `signals: 'receive'` real? RESOLVED: no. The value is cut and `signals` is `'none' | 'both'`.** A read-only Buzz adapter genuinely can observe kind:20001/20002, so the flag was truthful about the protocol — and truthful about nothing anyone would use. Surfacing another community's typing indicators in a room we cannot post into shows a person that someone, somewhere, is about to say something they will read later; the presence half is no better. The flag was cheap and the product value was zero, and a capability with zero value is a branch in every consumer and a row in the conformance matrix, paid forever. This is the same point §2 already makes under the table: **capabilities describe the adapter, not the protocol.** Read-only Buzz declares `signals: 'none'` for the same reason it declares `readCursor: 'none'` and `invite: 'none'` — not because the protocol lacks it, but because this adapter does nothing with it — and it gains a real `'both'` the day the write path lands. **Every site touched:** the `signals` field in `CommunityCapabilitiesSchema` (enum narrowed, TSDoc rewritten); the three-backend table's Buzz cell, `receive` → **`none`**; the paragraph under that table, which now names `signals` alongside `readCursor` and `invite` as the third case of adapter-not-protocol (and states the five-off/two-down split precisely instead of "six flags"); the Non-Goals bullet on presence/typing; and conformance **C15** (formerly C16), which loses its `'receive'` branch and keeps two.
- **OQ9 — how does a member's local install learn it was removed from a community? RESOLVED, and it is normative here rather than deferred to a ticket.** **A `'not-admitted'` connection result invalidates that community's cached rooms** and surfaces the required `disclosure` in their place. Removal is not a distinct outcome to detect: a member who was removed and a member who was never let in reach the same status on their next `connect()`, so one rule covers both and is a no-op for the second. The rule is stated at the port rather than left to the local adapter because the failure it prevents is a product failure, not an implementation detail — a cache that outlives admission shows a person a list of rooms they can click, each of which fails on read, which reads as a broken product rather than as a changed membership. The three other statuses deliberately do **not** invalidate: `'unreachable'` says nothing about membership and the cache is what makes an install readable while a host is down, and `'unauthorized'` carries a ban indistinguishably from an expiry, so acting on it would discard a correct cache on a re-authentication. Nothing leaks by that asymmetry, because the cache is never the access boundary — every adapter re-checks membership on read (§Security), so a stale row renders and then refuses. **The residual, stated rather than hidden:** a member removed while offline still learns on next connect. There is no push and this spec invents none; the community cannot reach the member's install, which is D2 and D9 working as designed, and Buzz's own removal path notifies nobody at all. The guarantee is that the first connection after a removal is honest, not that a removal is observed when it happens. **Where it landed:** §5 (three paragraphs: the invalidation, the asymmetry, the residual), §8 (the registry's `'not-admitted'` sentence now says cached rooms are dropped), the Non-Goals bullet that hands the local cache to the local-adapter ticket, §User Experience, and the `aggregateCommunityRooms` unit test, which asserts a `'not-admitted'` community contributes none of the rooms it listed before.

## Related ADRs

**Constraining this spec:**

- ADR `260726-170125` — a room is a membership-scoped durable stream, not a session. Still governing, minus one clause: its "a thread is a child room" sentence was superseded the day after this spec was written.
- ADR `260728-022013` — a thread is a relation between entries, not a child room. **Written after this spec and partly because of it**: it cites §4's seam among its reasons, moves local storage to the same shape, and its Consequences → Positive records that the divergence §4 priced as "the largest single consequence of the design" disappears. It decides; DOR-634 implements. §4 is rewritten around it.
- ADR `260726-170127` — the room path carries its own cascade guard. Untouched: the guard is local and stays local. A remote entry that triggers a local agent enters through the shipped `RoomService.post` path and inherits the guard and the turn budget unchanged — which is worth noting, because a remote room is a new way to reach that path.
- ADR `260727-184933` — the community server never runs a member's agent. §3 states the mechanical consequence: no execution surface on the port.
- ADR-0310 — runtime-owned storage with registry-aggregated listing, per-backend degradation and `warnings[]`. §8 is that shape.
- ADR-0255 — per-session runtime binding, first-write-wins. The precedent for the registry's binding discipline.
- ADR-0256 — structured capability fields (`permissionModes`) over a flat `features` bag. `roles` follows it exactly.
- ADR-0043 — file-canonical source of truth with a derived cache. D1's truth↔cache framing, and what the local cache of remote rooms is.
- ADR `260725-133220` — identity is attribution, not authorization. Relevant when agent tokens later become an admission credential; `research/…agent-identity…` §6.2 flags that the two roles must be stated apart or the ADR reads as violated.

**Candidate ADRs to extract (deliberately NOT written here).** This spec was scoped to write only under `specs/community-adapter/`, so no `decisions/` files were created. **Three** decisions still clear the significance bar and should be extracted with `/adr:from-spec`:

1. **The community cursor is opaque and adapter-minted, and a gap-free resume is a property of the port rather than a capability.** Rejects the numeric `seq` assumption our entire durable-stream design rests on, rules out "best-effort" as a legal state, and — after §Decisions resolved after SPECIFY, OQ6 — rules out declaring your way out of the promise. The flag that was going to carry this is the interesting part of the decision, not a footnote to it.
2. **Roles are an adapter-declared vocabulary with one portable predicate (`administers`).** The alternative — a shared three-value enum — was rejected on Buzz's five-with-`Bot`-outside evidence. No `rank` in v1 (§Decisions resolved after SPECIFY, OQ4) belongs in the same ADR: it is the same evidence pointing one step further.
3. **Out-of-band admission is a first-class connection outcome.** Four statuses, typed on the result, `'not-admitted'` distinct from `'unauthorized'` — and, after OQ9, `'not-admitted'` invalidating that community's cached rooms while the other three statuses deliberately do not.

**A fourth was on this list and has since been written.** "A thread is an entry-level relation at the community port, not a room" was extracted as ADR `260728-022013`, in a wider form that also moves local storage — so it supersedes a clause of `260726-170125` rather than, as this list predicted, narrowing it at the seam without superseding anything. Do not extract it again.

## References

- `specs/community-server/01-ideation.md` (`260727-155419`) — D1–D9
- `specs/community-adapter/01-ideation.md` — what this inherits, and the three parent claims the spike falsified
- `specs/invites/02-specification.md` (`260727-161438`) — the invite token design that moves to `apps/community`; §14.6 is the quota hole D8 names
- `research/20260727_buzz-protocol-capability-spike.md` — the 11-row capability table and the seven mismatches
- `research/20260727_agent-identity-in-communities.md` — D8's mechanism; §5.1's eight principles that survive with no keys; §5.2's six Nostr artifacts to refuse
- `research/20260724_multi-user-communities.md`, `research/20260727_multi-user-review-exchange.md` — the architecture research and the review that produced the room model
- `packages/shared/src/agent-runtime.ts`, `packages/shared/src/connector-provider.ts` — the two precedents
- `packages/test-utils/src/runtime-conformance.ts`, `connector-conformance.ts` — the two suites (a third, `capability-conformance.ts`, gates registry composition rather than a backend, and is not a model for this one)
- `packages/db/src/schema/rooms.ts`, `apps/server/src/services/rooms/`, `apps/server/src/routes/rooms.ts`, `routes/room-events-handler.ts` — the room model this must serve
- `apps/server/src/services/session/aggregate-session-list.ts` — the degradation shape
- `apps/server/src/services/core/auth/secret.ts` — the credential-file discipline

- `specs/message-search/02-specification.md` (DOR-672) — **amends this document in three places, all dated 2026-07-28 and marked in place**: the Non-Goals search bullet (the one-implementation premise expires; search stays off the port for a trust reason instead), §5 (a `'not-admitted'` result deletes that community's index rows in the same transaction as the room cache), and §Data model changes (how the index's `origin_key` survives the `room_entries` re-scoping, and the same delete restated for the ticket that will implement it)

---

## Amendment 1 — the message index (2026-07-28, DOR-672)

`specs/message-search/02-specification.md` builds a local, derived message index. It amends this document in three places, each marked in place above and unchanged otherwise. This section is appended rather than inserted so every `file:line` citation into this document keeps resolving.

### A. Non-Goals — search stays off the port, for a different reason

- **Not** search on the port — and after DOR-672 the reason is a different one, which is why it gets its own bullet rather than a clause. `specs/message-search/02-specification.md` builds the local message index, so **"we do not have search" stops being true the moment it ships**: the local backend will have it, and the one-implementation argument above no longer applies. Search stays off the port anyway, deliberately: **searching a remote community means a server you do not control ranks results you cannot verify**, which is a different trust model and a different decision from the one this port is making. A relevance ranking is not a page of entries — a remote community choosing what you find, and what you do not, is a capability we would be accepting sight-unseen, and NIP-50's one-shot `REQ` gives no way to check the ranking or to know what was withheld. The forward plan, on the reactions precedent: **a `search` capability flag in `CommunityCapabilities` is where this would go**, gated exactly as §2's rule demands (it changes what a caller may do), with a `searchEntries` method that refuses under `CommunityUnsupportedError` when the flag is off — and the day someone asks, the shape is known rather than discovered. **Communities nevertheless get search, for free and from the other direction:** remote messages cached in `rooms` / `room_entries` are indexed by the same projection that indexes local rooms, because the index reads the cache and cannot tell where a cached row came from. §Data model changes records the obligation that arrives with that.

### B. §5 — a `'not-admitted'` result deletes that community's index rows

**Amended 2026-07-28 (DOR-672) — the invalidation must also delete that community's message-index rows, in the same transaction.** Once `specs/message-search/02-specification.md` ships, cached room entries are also rows in a searchable `messages` index. Dropping the room cache without dropping the index rows produces the same failure §5's invalidation rule exists to prevent, one surface further along and worse: **search would serve content from a community that ejected you, after the cache correctly dropped it** — and a search result is not a room the reader has to click into and be refused, it is the message body itself, already rendered, with a snippet around the match. So the delete of the cached rooms and the delete of their index rows are **one transaction, not two statements** — a crash between them leaves a searchable orphan whose room no longer exists to re-check membership against, which is precisely the "cache is never the access boundary" guarantee failing in the one place it was never tested. The index is derived and rebuildable, so the recovery is cheap; being derived is not a reason to let it lag, because a stale derived row is indistinguishable from a live one at the point of reading.

### C. §Data model changes — what the local-adapter ticket owes

- **Amended 2026-07-28 (DOR-672) — the message index must survive that re-scoping, and here is exactly how.** The index keys every row by `(source_id, origin_key, ordinal)`, where the room projection sets `origin_key = roomId` and `ordinal = seq` (`specs/message-search/02-specification.md`, §Data model). Note first what §Data model changes actually says and does not say: its `room_entries` bullet requires only that `(roomId, seq)` and `room_entries_room_id_entry_id_unique` **"be re-scoped"** — **the target triple `(communityRef, roomId, seq)` is nowhere stated in this document**, and `(communityRef, slug)` on the `rooms_channel_slug_unique` bullet is the only explicit target given anywhere. The index therefore must not depend on which shape is chosen. It does not, on one condition, which is the whole content of this bullet: **`origin_key` is a single opaque string the projection composes, never a foreign key and never a column the index parses.** When `communityRef` lands, the room projection composes `origin_key = \`${communityRef}:${roomId}\``and`ordinal`stays`seq`; nothing in the schema, the query, the ranking or the frontier table changes, because none of them ever read inside `origin_key`. **What the local-adapter ticket owes is one line in one projection plus a rebuild** — 8.25 s measured, not a migration — and it owes the rebuild rather than a backfill precisely because the index is derived. The two ways to get this wrong are worth naming, since both look reasonable: splitting `communityRef`into its own indexed column (which makes it a second thing to keep in sync, and re-indexes every row of a community when it is renamed), or leaving `origin_key = roomId`and relying on room ids being globally unique (which is the assumption §Data model changes'`room_entries` bullet exists to retire — the index would then merge two communities' rooms into one result list under one id, silently).
- **Amended 2026-07-28 (DOR-672) — and it owes the `'not-admitted'` index delete.** §5 now requires that a `'not-admitted'` connection delete that community's cached rooms **and** its message-index rows in the same transaction. That is the local-adapter ticket's to implement, because it owns the cache; it is stated here so it is not rediscovered by a person finding a message from a community they were ejected from.

---

## Amendment 2 — presence rides `signals`, and `publishSignal` learns to say what it means (2026-07-29, room-presence)

`specs/room-presence/02-specification.md` gives rooms a mechanical working indicator — published by the trigger dispatcher at claim and release, never model-chosen (its §1). It amends this document in three places, each marked in place above and unchanged otherwise; on the DOR-672 precedent, this section is appended rather than inserted so every `file:line` citation into this document keeps resolving.

### A. No `presence` capability flag is minted — the flag would be determined, and its third value has zero implementations

The room-presence work considered `presence: 'ephemeral' | 'reaction' | 'none'` and this document's own doctrine rejects it, twice. First, the rule of §Decisions resolved after SPECIFY, OQ6: a flag whose value is determined by the rest of the declaration is worse than no flag. For every backend this port has or plans, presence is fully determined by `signals` — local `'both'` → ephemeral, `apps/community` `'both'` → ephemeral, read-only Buzz `'none'` → none — so the field could only ever agree with `signals`, while costing a row in every fake and inviting a branch in every consumer. Second, the one-implementation rule from §Non-Goals: `'reaction'` — presence expressed as an emoji on the triggering entry, Buzz's 👀/💬 harness pattern — has **zero** implementations on this port. Slack and Telegram express presence that way, but they are relay adapters, not `CommunityAdapter`s; a write-capable Buzz adapter does not exist. **The forward shape, recorded so it is a step and not a discovery:** the day a reaction-native backend joins the port, a presence-idiom flag is minted _then_, alongside the reaction attach point OQ7 reserved (`roomEntries.id`), and its conformance rows arrive with the backend that can pass them.

### B. §3 — `publishSignal` gains an optional structured payload

What the port genuinely lacked was not a flag but a sentence: `publishSignal(roomId, signal)` can clear its throat and cannot say who is working, on what, or in which phase. The method becomes:

```typescript
/**
 * `signals: 'both'` — emit an ephemeral signal. Live only; never durable.
 * `payload` carries the room-presence lifecycle when `signal === 'progress'`:
 * who is working (`memberId`, the emitting side's member for that room),
 * on which entry, since when, and in which phase. Adapters map it to their
 * native idiom and MUST NOT persist it.
 */
publishSignal(
  roomId: string,
  signal: SignalType,
  payload?: {
    state: 'working' | 'working_late' | 'done';
    memberId?: string;
    entryId?: string;
    since?: string;
  }
): Promise<void>;
```

The shape mirrors the relay's own `Signal` envelope (`packages/shared/src/relay-envelope-schemas.ts:145–152`, `state` + `data`), so the port is not inventing a second vocabulary — it is finally carrying the one the relay already has. The parameter is optional and the change is additive: every existing conforming adapter remains conforming until C15 is run against the strengthened branch, at which point a `'both'` adapter must round-trip the payload.

### C. C15 — the `'both'` branch proves more; nothing is weakened

C15's `'both'` branch becomes: publish **with a presence payload** → the same signal, payload intact, arrives on a second subscription. The `'none'` branch is untouched: publish rejects, no signal is ever yielded. Conformance still branches on the capability and neither branch got easier — this is branching, not weakening, in exactly the sense §4's rules require. One boundary the suite deliberately does not assert here: _who_ may call `publishSignal`. The mechanical-honesty rule — a presence signal exists only while a real claim is held — is enforced at the one producer (the trigger dispatcher, `specs/room-presence/02-specification.md` §1) and tested there, because a port-level fake cannot know whether a claim was real.

**[Amended 2026-07-30 (room-presence §3.2), as built: two things the row proves beyond the sentence above.** First, the round trip is observed on a **second, separate subscription** rather than the publisher's own — a signal that reached only the stream its publisher happened to hold is not fan-out, and presence exists for the people who are not the one working. Second, "live only; never durable" is asserted in the one direction a port-level suite can see it: the signal does not become an entry, and a subscription opened **after** the publish is not told about it. The other direction — a backend that also wrote the payload into a table it never surfaces — is unassertable here, because no port method could read it back, and it is named in the suite's own not-asserted list rather than implied to be covered.

**And one thing the paragraph above no longer describes correctly.** "Enforced at the one producer" was true when the dispatcher was the only producer. `publishSignal` on a real adapter makes the port a **second** one, and `payload.memberId` lands verbatim on every subscriber's presence line — so on a backend whose identity model is our own, an unvalidated id publishes a working indicator for a member who is not working, or for nobody at all. `LocalCommunityAdapter` therefore **validates `memberId` against the room's roster** and refuses a stranger loudly, never falling back to the connected identity (a fallback would turn a caller's bad id into "the operator is working"). That is deliberately a roster check, not a claim check: it proves the subject **exists**, not that it is working, because the claim map lives in the dispatcher and nothing at this port can see it. **The residual is therefore real and bounded: one member of a room can publish presence about another.** It is tolerable only while every caller is server-side code that already knows what it started, so **claim-gating — or an explicit refusal of third-party `memberId`s — must land before `publishSignal` is reachable from a route, an MCP tool, or any caller the server did not write.** A backend with a foreign identity model has nothing to validate against and keeps the port's original latitude; the field is unvalidated at the PORT for that reason, and validated by the adapters that can.]

### D. The three-backend table's `local` row: `signals` was `'none'` for longer than the payload's absence justified [heading amended 2026-07-30; it read "is `'none'` until the payload lands"] (2026-07-30, DOR-592)

> **[Amended 2026-07-30 (room-presence §3.2): the cell is `both` again, and the heading above is corrected in place with it.** `LocalCommunityAdapter` declares `signals: 'both'`, publishes through `RoomService.publishSignal`, and maps every `signal` frame its broadcaster carries onto the port's stream. §2's cell is corrected too.
>
> **One factual correction to the section below, which its own author could not have made:** it reads as though the envelope had not yet been widened when `'none'` shipped. It had. `364d3a88e` (#623) added `state`, `entryId` and `since` to `RoomSignalEventSchema`, and `25aa7af15` (#624) — the commit that shipped `signals: 'none'` — is its **direct descendant**. #624 branched before #623 merged, so the declaration was honest when written and stale by the time it landed, and it then stayed stale for ten commits. The argument below is untouched by that and is why the flip was safe to wait for: **a flag must not out-run what the implementation actually maps.** What the timeline adds is the other half of the rule — a declaration made down is a debt, and nothing but a person re-reading it will collect.]

§2's table said the local adapter declares `signals: 'both'`, and §B above quietly made that false without changing the cell — **the amendment that redefined `'both'` did not update the row it invalidated.** The cell now reads `'none'`, and the reason is worth stating because it is not the reason read-only Buzz declares the same value.

Buzz declares `'none'` because that adapter does nothing with signals. The local adapter declares it because of a **missing field, not a missing feature**: `RoomService.publishSignal` and the SSE `signal` frame both ship, but `RoomSignalEventSchema` carries no structured payload, and after §B a `'both'` adapter must round-trip one. So the honest declaration for the local backend, at the commit that first put it behind this port, is `'none'` — and the conformance suite proves that is not a hedge: declaring `'both'` without the payload reds **U13** (a supported capability that refuses) and **C15**.

Two consequences, both deliberate:

- **`'none'` is enforced in both directions.** The adapter refuses `publishSignal` _and_ drops every `signal` frame its own room broadcaster carries. An adapter that declared `'none'` and still yielded signals would be lying in the direction the shared suite structurally cannot catch — no port method can provoke a backend-native signal — so it is pinned in the local adapter's own tests.
- **This flips with the payload, not separately.** `specs/room-presence/02-specification.md` §3.2 widens the room signal envelope and its §11 scope table assigns the port-side implementation to the local and server adapters. That change sets `signals: 'both'` in the adapter, restores the `signal` mapping in `LocalCommunityAdapter.subscribeRoom`, and returns this row's cell to `both`. Until it lands, the table and the shipped code agree. **[Done 2026-07-30: it landed exactly that way, and the flip was red-first — declaring `'both'` before the mapping existed reds U13 and C15, which is the proof this cell was never a hedge. The `'none'`-in-both-directions test above is now a round-trip test with the same discriminating shape: a signal published by the room's OWN producer, which no shared suite can provoke, reaches a port subscriber with its payload intact.]**

---

## Amendment 3 — `subscribeRoom` owes an unknown room a defined answer (2026-07-30, DOR-754)

This document contracted `getRoom` to answer `null` for a room that is unknown or not visible, and said nothing at all about what `subscribeRoom` owes the same pair. Two backends filled the silence two different ways, which is how the gap was found while building the first real adapter (DOR-592): the reference `FakeCommunityAdapter` threw a plain `Error`, `LocalCommunityAdapter` threw the rooms subsystem's own `RoomError('ROOM_NOT_FOUND')`, and no conformance row noticed either. Both now throw the port's error, and §9 gains the assertion that would have caught it. On the Amendment 1 precedent, this section is appended rather than inserted so every `file:line` citation into this document keeps resolving.

### A. §3 — a third typed error, thrown eagerly, identical for unknown and invisible

`subscribeRoom(roomId, …)` on a room this identity cannot stream throws **`CommunityRoomNotFoundError`**, **eagerly and synchronously** — at call time, before the first `next()`. That is the discipline `StaleCommunityCursorError` already carries (§4 rule 3), for the same reason and asserted the same way: an `async function*` cannot satisfy it, so the room is checked in a plain method that then returns a generator. The room check runs first, before the cursor is looked at.

**Unknown and invisible throw the identical refusal, message included**, and the class deliberately takes **no `reason` argument** where the other two errors do. That is §Security's "a room id is not a capability" made mechanical rather than restated: the shipped `requireVisibleRoom` already reports one `ROOM_NOT_FOUND` for both, and a `reason` field is precisely the crack a probe would widen into "does the operator have a DM with that agent?".

**The room is checked BEFORE the cursor, and that order is contractual rather than incidental.** A cursor's validity is usually a function of the room's own state — the local adapter bounds a resume against the room's `maxSeq`, and a room that is not there has none — so an adapter that validated the cursor first answers `StaleCommunityCursorError` for a room that does not exist and `CommunityRoomNotFoundError` for one that exists and is hidden. **Two typed refusals that differ IS the probe the identical message closes**, re-opened one line earlier and invisible to every assertion about either error's contents: neither message leaks it, only the order can. This is not hypothetical — reordering those two checks in the local adapter left the whole community suite green until the assertion below existed, which is why the rule is written at the port and pinned in a test rather than left to each author to rediscover.

**The asymmetry with `getRoom` is about what each return type can express, not about what either discloses.** A method whose return type has an empty value uses it — `getRoom` → `null`, `listMembers` → `[]` (U15), `listEntries` → an empty page. `subscribeRoom` returns a stream, and no stream means "no room": every **room** stream this port hands out opens with a snapshot **of** a room. (`subscribeRoomList` is the port's other stream and carries no snapshot at all — `CommunityRoomListEventSchema` has three members and none of them is one — which is exactly why the quantifier is narrowed: it is not about a room, so it has no room to refuse about either.) The three alternatives were considered and each is worse:

- **an immediate terminal `room_closed`** tells a caller a room went away when it never had one, and makes §6's terminal event ambiguous between "you lost access" and "there was never one to lose";
- **a stream that simply never yields** is indistinguishable from a quiet room, so the caller parks on it forever — the exact failure the eager-throw discipline exists to prevent, one method along;
- **a nullable return** puts a null check at every call site for a case the caller must handle as a throw anyway, since a room can vanish between `getRoom` and `subscribeRoom`.

What does **not** differ across those shapes is what the caller learns about why. `getRoom`'s `null` and this throw are equally silent; only the shape of the silence differs.

### B. §9 — a sixteenth universal row, and why universal is the right half

U16 is in the universal half rather than the branched one because it needs no arrangement and no declaration: **every backend can be handed a room id that does not exist**, so there is nothing to seed, no hook to decline, and no capability that could turn the case off. A backend that cannot be asked about an unknown room does not exist.

The one thing U16 does **not** assert is the collapse itself. Arranging a room that exists and is invisible needs a second identity, and the port has no method that mints one — so the suite proves the shape and each adapter proves the discretion where it can arrange it. `LocalCommunityAdapter`'s own tests do exactly that, against the visibility rule that ships: a non-owner author subscribing to a room it does not belong to gets the same error, **the same message and the same own properties**, once the id each was asked about is normalized away. That test asks twice — **once with no cursor and once with a cursor addressed to the room in question** — because the second is what pins §A's ordering rule, and a refusal that is identical only when no cursor is supplied is not identical.

### C. The typed-error count — two places marked, two left as recorded history

This document counts the port's typed errors in four places, and not in the same words: **G1** and **§Documentation** say "two typed errors", while **§Code structure & file organization** and **Phase 1** say "both typed errors". From this amendment the count is three, and the four are treated differently on purpose:

- **G1 and §Documentation are marked in place**, per this document's own convention — both prior amendments state that each change is "marked in place above", and Amendment 2 §D exists precisely because one amendment did not. G1 is a goal, which a reader checks the port against; §Documentation specifies the contents of `contributing/adding-a-community-adapter.md`, which this change edited.
- **§Code structure and Phase 1 are left as written.** The first is a line inside a fenced directory listing — a comment on a path, not a claim to check — and the second is the shipped-history log of what Phase 1 delivered, which really was two. Marking either would be amending a record of the past rather than a statement about the port.

**§Implementation Phases' "all fifteen universal"** is left for that second reason too: Phase 2 shipped fifteen, and §9's table — now sixteen rows — is where the contract lives rather than where its history does.
