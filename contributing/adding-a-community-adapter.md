# Adding a Community Adapter

## Overview

This guide walks through adding a backend behind the `CommunityAdapter` port: the fourth swappable seam beside `AgentRuntime`, `Transport` and `ConnectorProvider`. A community adapter lets one local DorkOS server read and write rooms **somewhere other than this machine** — without the cockpit, the router or the session spine learning that more than one place exists.

```
client ──Transport──▶ your local DorkOS server ──CommunityAdapter──▶ ┌ local rooms   (SQLite, shipped today)
       (unchanged)                                                   ├ Buzz relay    (Nostr/WS, read-only)
                                                                     └ apps/community (Postgres)
```

The port mirrors `AgentRuntime` deliberately: one Zod-first contract, N backends, a server-side registry, capability flags, and a shared conformance suite that gates every implementation. If you have read [adding-a-runtime.md](adding-a-runtime.md) or [adding-a-connector.md](adding-a-connector.md), this will feel familiar.

**Two concrete adapters ship.** **Local rooms** (`apps/server/src/services/communities/local/`) are registered as `LOCAL_COMMUNITY` at startup. A **read-only Buzz relay** (`apps/server/src/services/communities/buzz/`) is built and passes the same suite but is not registered anywhere: it needs a relay URL from a user-config surface that does not exist yet. `apps/community` is the third. Read the local adapter alongside this guide — it is the worked example for everything below, including two things a fake cannot show you: what an honest capability declaration costs (it shipped declaring `signals: 'none'` — not because the local backend has no signal channel, but because the room signal envelope carried no presence payload to round-trip, which is what `'both'` means — and it stayed `'none'` for ten commits **after** that stopped being true, because a stale declaration fails quietly in the safe direction and nobody was looking; declare down, and then go back and check), and how a synchronous store is wrapped in a promise-returning port without letting a refusal escape as a synchronous throw.

Spec: [`specs/community-adapter/02-specification.md`](../specs/community-adapter/02-specification.md). Related ADRs: [0310](../decisions/0310-runtime-owned-session-storage-aggregated-listing.md) (aggregate-with-degradation, the shape the registry copies), [0256](../decisions/0256-runtime-capabilities-shape-booleans-plus-structured-plus-features.md) (structured capability fields over a flat bag), [`260726-170125`](../decisions/260726-170125-a-room-is-a-membership-scoped-durable-stream.md) (a room is a membership-scoped durable stream), [`260728-022013`](../decisions/260728-022013-a-thread-is-a-relation-between-entries.md) (a thread is a relation between entries), [`260727-184933`](../decisions/260727-184933-the-community-server-never-runs-a-members-agent.md) (the community server never runs a member's agent).

## Key Files

| Concept                  | Location                                                                                                                                         |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| The contract             | `packages/shared/src/community-adapter.ts` (port, schemas, all four typed errors)                                                                |
| Conformance suite        | `packages/test-utils/src/community-conformance.ts` (+ `-support`, `-universal`, `-branched`)                                                     |
| Reference implementation | `packages/test-utils/src/fake-community-adapter.ts` (`FakeCommunityAdapter`)                                                                     |
| First real adapter       | `apps/server/src/services/communities/local/` (adapter, cursor, projection, startup registration)                                                |
| The foreign adapter      | `apps/server/src/services/communities/buzz/` (WebSocket, NIP-42 identity, keyset cursor, polled room list, read-only)                            |
| Registry (dispatch)      | `apps/server/src/services/communities/registry.ts`                                                                                               |
| Cross-community listing  | `apps/server/src/services/communities/aggregate-community-rooms.ts`                                                                              |
| Credential discipline    | `apps/server/src/services/communities/credentials.ts`                                                                                            |
| Reused vocabularies      | `packages/shared/src/mesh-schemas.ts` (`ResponseMode`), `relay-envelope-schemas.ts` (`SignalType`), `room-schemas.ts` (`RoomKind`, `AuthorKind`) |
| The local room model     | `packages/db/src/schema/rooms.ts`, `apps/server/src/services/rooms/`                                                                             |

## Four rules that are not negotiable

1. **One instance serves one community.** `adapter.community` is readonly, and every address the adapter emits — rooms, entries, members, invites — carries that value. Joining two communities means two adapters.
2. **Every method is required.** A capability-gated method whose capability is off rejects with `CommunityUnsupportedError`. Never a silent no-op, never a partial write. Optional methods let a backend omit a surface with the compiler silent; a required method with a typed refusal cannot.
3. **No credential crosses the port** — not as an argument, not on a DTO, not in `features`. Resolve yours from `resolveCommunityCredential(dorkHome, community)`.
4. **Nothing executes an agent.** There is no turn, no session handle and no invocation on this port, deliberately. The port carries conversation; compute stays on the member's machine.

## Declare your capabilities honestly

`CommunityCapabilities` has thirteen substantive flags. **Capabilities describe the adapter, not the protocol.** If your protocol has read cursors but your v1 adapter does nothing with them, declare `readCursor: 'none'` — declaring what a protocol could theoretically do makes the flags a lie the conformance suite cannot catch.

| Flag             | Values                                      | What it changes                                                                                |
| ---------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `roomList`       | `push` / `poll`                             | Latency of `subscribeRoomList`, never its shape. `poll` must declare `roomListPollIntervalMs`. |
| `roomAddressing` | `slug` / `opaque-id`                        | Whether a slug-addressing UI may render `#name`                                                |
| `canPost`        | boolean                                     | `post`                                                                                         |
| `roomAdmin`      | boolean                                     | `createRoom`, `updateRoom`, `addMember`, `removeMember`                                        |
| `roles`          | `{ supported, default?, values[] }`         | Whether members carry a role, and which ids are legal                                          |
| `admission`      | `open` / `out-of-band` / `invite`           | How a new member gets in                                                                       |
| `invite`         | `none` / `community` / `room`               | `createInvite`, and whether a room-scoped request is refused                                   |
| `agentAdmission` | `none` / `owner-vouched`                    | `admitAgent`, `revokeAgent`                                                                    |
| `readCursor`     | `server` / `client-opaque` / `none`         | The cursor methods, and whether `unreadCount` can be a number                                  |
| `responseMode`   | boolean                                     | `setResponseMode`, and whether members carry one                                               |
| `threadDepth`    | `1` / `'unbounded'`                         | Whether a reply to a reply is refused                                                          |
| `signals`        | `none` / `both`                             | `publishSignal`                                                                                |
| `credential`     | `none` / `machine-managed` / `user-account` | What holding a credential means for this backend                                               |

**Presence crossing the port carries the verb and never the target.** A room's own presence signal can say what the turn is doing — `SessionActivity`, the tool's name plus its one human-relevant argument. That argument is a file's basename, a command's first line, a search pattern or a host: it is one person's work, and it stays inside the cockpit that person is looking at. `CommunityPresencePayloadSchema` has **no field for it**, and that is the enforcement rather than an oversight — a community backend cannot honestly do anything with a verb today, and adding the field would be the first half of a leak somebody completes later. `toCommunitySignal` in the local adapter is where the same rule is applied on the way out, with a test that fails if the projection ever starts carrying one (ADR `260819-022127`).

Two flags people reach for and will not find. There is **no resume flag**: a gap-free resume is a property of the port that every adapter owes (see below). There is **no roster flag**: all three backends enumerate members, so `listMembers` is universal — what differs is roles, and those have one.

## The cursor is the sharpest part of the contract

There is no `seq` on this port. A `CommunityCursor` is an opaque, adapter-minted, community-scoped token, and four rules govern it:

1. **Only the minting adapter interprets it.** No consumer may parse, compare, order or arithmetic one.
2. **It is self-identifying.** Encode enough to reject a cursor minted for a different room, a different community, or a superseded epoch. A foreign cursor is a plausible value that would silently skip real entries, so **reject it, do not bound it**.
3. **Resume is gap-free or it throws** `StaleCommunityCursorError`, **eagerly** — at call time, before the first `next()`. This is the trap most worth reading twice: an `async function*` cannot satisfy it, because its body does not run until the first pull. Write `subscribeRoom` as a plain method that validates and then returns a generator. The room itself rides the same discipline: check it first, and refuse an id you cannot stream with `CommunityRoomNotFoundError` **before you look at the cursor**. That order is contractual, not stylistic — see the trap below for what it leaks.
4. **Every entry carries the cursor that resumes after it.** That is what replaces `seq` for a consumer.

Two invariants take `seq`'s place, and both are asserted: order is the adapter's emission order (`createdAt` is for display, never for sorting — a wall clock can tie or skew), and **dedupe is by entry `id`**, so ids must be stable and unique within a room.

Exhaustion is **declared, never inferred**: `nextCursor === null` is the only authority. The converse holds too — a non-null cursor promises there is more, so never hand one back and then serve an empty page.

## Connection is four outcomes, typed on the result

`connect()` never throws for a connection outcome. It resolves to one of four statuses, and telling them apart is the whole point:

- `'connected'` — carries the `identity`.
- `'not-admitted'` — the credential is **valid** and this community has not admitted it. An operator action is required and there is no in-protocol way to ask. **Requires a plain-language `disclosure`.**
- `'unauthorized'` — the credential is wrong, expired, rejected, or banned.
- `'unreachable'` — the host did not answer.

Collapsing `'not-admitted'` into `'unauthorized'` produces the worst available UX: a person told to check a credential they cannot see, for a machine-managed key that is in fact perfectly valid.

**`'not-admitted'` invalidates that community's cached rooms.** This is normative. A member who was removed and a member who was never let in reach the same status on their next `connect()`, so one rule covers both. `aggregateCommunityRooms` already refuses to list a `'not-admitted'` community; **an adapter that keeps a local cache owes the other half — dropping the cached rows, and that community's message-index rows, in the same transaction.** A crash between the two leaves a searchable orphan whose room no longer exists to re-check membership against. The other three statuses deliberately do **not** invalidate: `'unreachable'` says nothing about membership, and `'unauthorized'` carries a ban indistinguishably from an expiry.

## Agent admission (four contractual properties)

`admitAgent` mints the agent's **own** identity in the community, vouched for by the connected member. Four properties are contractual, not incidental:

1. The admitted agent is a **distinct member** from its owner.
2. Its `ownerMemberId` is the connected identity.
3. Its role **never administers**, whatever its owner's role is. Capability does not flow owner → agent.
4. Its admission is **derived** from its owner's and re-evaluated on use — never copied into a row a cleanup job must find. Removing the human removes their agents.

`AdmitAgentInput` deliberately carries no agent-side consent field: only a member adds their own agents, so there is no third party to refuse.

## Step-by-step

### 1. Write the adapter

Put it in its own directory under `apps/server/src/services/communities/<backend>/`. Implement every method on `CommunityAdapter`; refuse the gated ones your capabilities turn off with `CommunityUnsupportedError`.

### 2. Resolve your credential

```typescript
import { resolveCommunityCredential } from '../credentials.js';

const secret = resolveCommunityCredential(dorkHome, this.community);
```

Precedence is environment override → persisted `0600` file → generate-and-persist. A lax file mode is **repaired and warned**, never rejected: locking the owner out of their own instance is the worse failure. The value is never logged; only its path is. Never return it from any port method.

### 3. Register the conformance suite

```typescript
import { communityConformance } from '@dorkos/test-utils';

communityConformance(() => new MyCommunityAdapter(/* ... */), {
  name: 'MyCommunityAdapter — conformance',
  plantedCredential: TEST_CREDENTIAL,
  seedRoom: async (adapter) => /* a readable room with at least two entries */,
  makeUnreachableAdapter: () => new MyCommunityAdapter({ host: 'http://127.0.0.1:1' }),
  // Optional, and each one you omit is a case that stops being tested — the
  // suite reports the skip by name rather than passing quietly.
  makeUnadmittedAdapter: ...,
  makeUnauthorizedAdapter: ...,
  revokeOwner: ...,
  makeEvictedRoom: ...,
  secondCommunity: ...,
});
```

`seedRoom` is required, and a read-only backend arranges it **out of band** with an admin tool. That is the honest cost of a read-only backend, not a reason to stop testing it.

A backend that needs a live server (a relay, a hosted community) gates its run on an env var and skips when absent — the pattern `runtimeConformance` already uses for a runtime whose binary is missing.

### 4. Register with the registry

```typescript
communityRegistry.register(adapter, 'Dork Labs');
```

The **label** is supplied here, not reported by the adapter, so a rename never has to reach one. Dispatch is on `community`, never on a room id — a bare room id is ambiguous by construction. An unregistered ref throws `CommunityNotRegisteredError` rather than falling back to local: masking a mismatch would answer a question about someone else's community with this machine's own rooms.

`LOCAL_COMMUNITY` is registered unconditionally by `registerLocalCommunity` at startup, so a caller can always reach this machine's own rooms. Every other community is additive and may fail to construct without taking the server down.

## What the foreign case cost, and what it changed

The Buzz adapter exists to keep the port honest — an interface with one implementation describes that implementation. Three things it hit are worth knowing **before** you write your own, because each is a place a plausible adapter goes quietly wrong:

- **A backend with no sequence needs a walked cursor, not a numbered one.** Nostr filters page by `created_at`: whole seconds, assigned by the writing client. A position has to be `(second, event id)` — the timestamp alone ties, and a page boundary landing inside a tie drops the rest of it. Worse, a relay's `limit` may keep the newest rows or the oldest, and no client can ask which, so `buzz-history.ts` probes for the answer instead of assuming it.
- **The conformance suite cannot catch a history read that silently truncates, and you should not expect it to.** This is worth stating plainly because it is the trap this adapter walked into first. The suite has no independent view of a room: U8 checks the adapter's paged walk against the adapter's own wide read, and U6 checks a resume against the same. A walk that drops half the room is _self-consistent_ across all of them and passes at any page size and any fixture depth — measured, by mutating the walk two ways and watching all 98 assertions stay green. Registering it with a small page size does make the walk RUN, which is worth doing, but running is not asserting. **The ground truth has to come from a fixture that knows what it wrote**: `buzz/__tests__/buzz-community-adapter.test.ts` seeds a channel with a known set of entries, ties included, and asserts the adapter reads back exactly those, under both `limit` semantics. Those are the assertions that redden — along with `buzz-history.test.ts`, which drives the walk directly. If your backend pages by anything other than a monotonic number, write that test; the shared suite will not write it for you.
- **"Read-only" is not "credential-free".** The premise this adapter started from — reads are unauthenticated in base NIP-01, so no keypair is needed — was wrong about the real backend, which refuses every unauthenticated subscription. The key is derived from the credential the server already mints, so `credential: 'machine-managed'` stays true and there is still nothing for a person to write down. Check what your backend does before you declare `credential: 'none'`.
- **`'unknown'` is a real answer.** Buzz emits one reason string for archiving a channel and for revoking access to it. `room_closed: 'unknown'` is what an honest adapter reports there, and the fixture asserts exactly that rather than a friendlier guess.

It also added a fourth typed error to the port. `CommunityMemberNotFoundError` was the alternative to each backend inventing its own answer for "there is nobody here by that id" — like `CommunityRoomNotFoundError`, it carries no reason, because unknown and not-in-this-room must be indistinguishable.

## Traps

- **`subscribeRoom` as an async generator.** The eager stale-cursor throw is impossible that way. Validate first, return a generator second.
- **Guessing why a room went away.** A room that becomes unservable mid-subscription yields a terminal `room_closed` with `reason: 'archived' | 'access-revoked' | 'unknown'`. A relay can emit one reason string for two different causes, so `'unknown'` exists to let an adapter be honest instead of confident. Telling a member who just lost access that the room was put away is the failure this prevents.
- **Rendering `unreadCount: 0` where none can be computed.** `null` means "not applicable here". A silent room and a room whose unread cannot be computed are different states.
- **Silently widening an invite.** A `'community'`-scoped backend given a `roomId` must **refuse**. It must not widen, and must not substitute "an admin adds you" — those are different acts with different consent semantics. Pass `CommunityUnsupportedError`'s fourth argument (`reason`) when you refuse for scope: the capability is _on_, just narrower than asked for, and the default message would send a reader looking for a flag that is already set.
- **Putting a filesystem path on the wire.** `workspaceId` is deliberately not on this port: it binds a room to a checkout on one machine, and a remote community has no opinion about a path on someone's laptop.
- **Answering an unknown room with a stream.** `subscribeRoom` on a room you cannot serve throws `CommunityRoomNotFoundError`, eagerly. The two shortcuts both fail a person: a stream that opens and never yields is indistinguishable from a quiet room, so the caller waits forever; an immediate `room_closed` reports that a room went away to a caller that never had one. `getRoom` answers `null` for the same pair because a nullable room has an empty value and a stream does not — the shapes differ, the disclosure does not.
- **Treating a room id as a capability.** `RoomAddress` is an address, not an authorization. Re-check membership on every read — the cache is never the access boundary. That extends to how you refuse: a room that does not exist and a room this identity cannot see get the **identical** `CommunityRoomNotFoundError`, message included. The error takes no `reason` argument precisely so there is nothing to differ, because any difference is a probe for somebody else's direct messages.
- **Validating the cursor before the room.** The subtlest way to re-open that probe, and it survives every assertion about either error's contents. A cursor is usually bounded against what the room holds, and a room that is not there holds nothing — so checking the cursor first answers `StaleCommunityCursorError` for a room that does not exist and `CommunityRoomNotFoundError` for one that exists and is hidden. **Two typed refusals that differ is the same leak as two messages that differ.** Check the room first; the local adapter's tests pin the order by asking for both rooms twice, once with a cursor and once without.
