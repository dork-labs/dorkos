---
slug: community-hold-keeps-access
number: 260923-214400
created: 2026-09-23
status: specified
linear-issue: DOR-2284
project: Cloud-Hosted Communities
---

# A host hold keeps people connected

**Status:** Approved (decisions pre-authorized by the operator for this programme)
**Author:** Claude (for DOR-2284)
**Date:** 2026-09-23

## Overview

A host hold stops a community from growing while its owner can still export it (ADR `260923-121712`). Today the hold also revokes every invitation, DorkOS connection, and agent credential, and releasing the hold brings none of them back. This spec changes one thing: **a hold revokes nothing.** Members keep reading through the connections they already have, agents stay enrolled, invitations wait. Writes, joins, agent enrollment, and live streams are refused while the hold lasts, exactly as they are today. When the host releases the hold, everything works again with nobody reconnecting. Suspension, owner archive, and deletion keep revoking.

## Background / Problem Statement

The hold code (`origin/flow/dor-2255-host-hold`, #2036) calls `revokeTenantAccess` on `action: 'hold'` (`routes/host-lifecycle.ts`). That function revokes invitations, deletes pending admissions, cancels unconsumed pairings, revokes every connection grant and agent credential, and deactivates every agent (`host/communities.ts`). Release restores the prior lifecycle and nothing else.

So a hold that lasts an afternoon costs:

- every member: pairing each DorkOS installation again, because the grant is revoked (`401` → reconnect-required in the DorkOS app);
- every agent owner: enrolling each agent again, with a new identity row;
- the owner: reissuing every invitation.

None of that protects anything. Every member write path already refuses a held community by lifecycle with `423 COMMUNITY_HELD` (`tenant-context.ts`, `lockPrincipalAuthority` in `data.ts`). The revocation was copied from archive and suspension, which are different tools.

Two further facts shape the fix:

- Grant checks in `data.ts` use `($5::text <> 'archived' OR history_only)` with `readOnlyWord(lifecycle)` mapping `held` to `archived`. Even an unrevoked ordinary grant cannot read during a hold today; only a `history_only` grant can.
- The public wire's `CommunityConnectionAccessSchema` (`packages/shared/src/community-wire.ts`) is strict: access whose `lastKnown.lifecycle` is `archived` must have `read: true` and `post`, `enrollAgent`, `stream` all false. Installations are told `archived` for a held community. A kept connection can therefore read during a hold but cannot stream.

## Goals

- Entering a hold revokes no grant, agent credential, agent, invitation, pending admission, or pairing.
- During a hold, a kept connection and a kept agent can read history and files; nothing can post, join, enroll an agent, or stream.
- Releasing a hold restores posting, streaming, joining, and enrollment for every kept credential with no action by anyone.
- A DorkOS installation notices the release on its own within minutes, and does not replay posts that were refused during the hold.
- Suspension, owner archive, owner or host deletion, and a community takedown (`specs/community-host-takedown/`) still revoke everything.

## Non-Goals

- Reviving credentials that a hold revoked before this change ships.
- A `held` word on the public wire. Installations keep seeing `archived`.
- Changing what the owner can do during a hold (export, request deletion, erase) or what members see (the hold banner).
- Time or effort estimates.

## Technical Dependencies

| Dependency                            | Used for                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------- |
| The host hold (#2036, migration 0014) | the `held` state, `routes/host-lifecycle.ts`, `isReadOnlyLifecycle`, `COMMUNITY_HELD` |
| `@dorkos/shared/community-wire`       | `CommunityConnectionAccessSchema` (unchanged)                                         |

No migration. No new dependency. One additive wire change: `CommunityWireInvitePreviewResponseSchema` (a `z.strictObject`, `packages/shared/src/community-wire.ts`) gains `held: z.boolean()`. Its only consumer is the same-origin Community browser bundle, which ships with the server, so the field is safe to add.

## Detailed Design

### Server: what the hold changes and what it no longer does

**Hold.** `action: 'hold'` in `routes/host-lifecycle.ts` no longer calls `revokeTenantAccess`. It still sets `lifecycle='held'`, `held_from_state`, `held_at`, `deletion_notice_at`, bumps `lifecycle_version`, and writes the host audit row. The comment changes to say why: a hold refuses growth by lifecycle; credentials stay so the community resumes on release.

**Release.** Unchanged code; it now has nothing to revive.

**Paths that still revoke (unchanged):** `action: 'suspend'` (from `active`, `archived`, or `held`), owner archive (`POST /owner/lifecycle`), owner deletion request (from any allowed state, including `held`), host-started deletion (`POST /host/communities/:id/deletion`), and the community takedown in `specs/community-host-takedown/`. Resuming a suspension that started from `held` returns to `held` with credentials still revoked, as today.

### Server: reads through kept credentials

`readOnlyWord(lifecycle)` in `data.ts` is removed. Each grant predicate that used it passes the real lifecycle, so `history_only` is required only when the community is owner-`archived`:

```sql
-- data.ts: requireConnectionGrant, assertPrincipalCurrent, lockPrincipalAuthority
AND ($5::text <> 'archived' OR history_only)   -- $5 is now communities.lifecycle as stored
```

With `$5 = 'held'` an ordinary unrevoked grant passes the grant check. That is not enough on its own; two more gates in `data.ts` refuse a kept credential today and must change:

- **`archivedReadAllowed(lifecycle, scope, scopes?)`** (`data.ts` ~L51) requires `scopes.join(',') === 'read'`, so a kept grant with `read,post,enroll-agent` is refused with `423` on every read while held. The scope-set condition applies only to owner `archived`: for `held` the function allows any `scope === 'read'` request whatever the grant's other scopes. Its three callers are `requireConnectionGrant` (~L117), `requirePrincipal`'s cookie branch (~L218), and `requirePrincipal`'s grant branch (~L247); all three keep calling it.
- **`requirePrincipal`'s agent branch** (~L280) throws `lifecycleError` for any lifecycle other than `active`. It allows `held` when the requested scope is `read` (so an agent reads history and downloads files), and still refuses `post` with `423 COMMUNITY_HELD`. `lockPrincipalAuthority` and `assertPrincipalCurrent` already allow `read` in a read-only lifecycle for agents and check `agents.active`, which the hold no longer clears.

The lifecycle checks around all of these (`lifecycle !== 'active' && !(isReadOnlyLifecycle(lifecycle) && scope === 'read')`) keep refusing every non-read scope, so a kept credential reads and nothing else.

### Server: what a kept connection is told

`GET /me/connection-access` and `GET /me/grants` (`routes/pairings.ts`) compute capabilities from the lifecycle as well as the grant:

| Community lifecycle | `read`                                          | `post`                                  | `enrollAgent`                                   | `stream`           | reported `lifecycle` |
| ------------------- | ----------------------------------------------- | --------------------------------------- | ----------------------------------------------- | ------------------ | -------------------- |
| `active`            | scope has `read`                                | scope has `post` and not `history_only` | scope has `enroll-agent` and not `history_only` | not `history_only` | `active`             |
| `held`              | scope has `read`                                | false                                   | false                                           | false              | `archived`           |
| `archived`          | unchanged (only `history_only` grants are live) | false                                   | false                                           | false              | `archived`           |

A response for a held community parses with the unchanged, strict `CommunityConnectionAccessSchema` (its "Archived access is history-only" refinement holds). The grant list keeps showing each grant's real `scopes`, so a member can see the connection will post again after release.

### Server: live streams

- **A stream open when the hold starts** closes with `{"type":"closed","reason":"archived"}`, not `removed`. The access check in `routes/events.ts` stops joining on `co.lifecycle='active'`; it selects the lifecycle, and the close decision becomes: lifecycle `active` → keep going; `held` or `archived` → close with `archived`; anything else, or the credential gone → close with `removed`. (A channel archived by an admin still closes with `archived`, as today.)
- **Opening a stream while held** answers `423 COMMUNITY_HELD` before any event is written. DorkOS does not try, because the access it holds says `stream: false`. The Community browser, which opens a stream per open channel with the session cookie, treats a `423` on open as "read-only for now": it shows the hold banner, does not retry the stream in a loop, and checks the lifecycle again (one `GET /me` request) every 60 seconds and on window focus, reopening the stream when it is `active` again.

### Server: invitations, admissions, pairings, agents while held

| Thing                                      | During the hold                                                                                                                                                                                                                                                                | After release                     |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------- |
| Existing invitation                        | Not revoked. `POST /invites/preview` returns it with the new `held: true` field so the page says "This community is on hold. You can join when the hold ends." `preflight`, `bind`, and `redeem` answer `423 COMMUNITY_HELD` and write nothing. Its expiry clock keeps running | Redeems normally if not expired   |
| New invitation                             | `POST /invites` answers `423 COMMUNITY_HELD` (unchanged)                                                                                                                                                                                                                       | Works                             |
| Revoking an invitation                     | Allowed (removal is not growth)                                                                                                                                                                                                                                                | Works                             |
| Pending admission (someone mid-sign-up)    | Kept; completing it answers `423 COMMUNITY_HELD`; it expires on its own schedule                                                                                                                                                                                               | Completes normally if not expired |
| Unconsumed pairing                         | Kept; approval follows the archived rule: `{read}` and `history_only` (unchanged)                                                                                                                                                                                              | That grant stays read-only        |
| Enrolled agent and its credential          | Kept; the agent can read; posting answers `423 COMMUNITY_HELD`                                                                                                                                                                                                                 | Posts normally                    |
| Agent enrollment, reactivation, recovery   | `423 COMMUNITY_HELD` (unchanged)                                                                                                                                                                                                                                               | Works                             |
| A member revoking their own grant or agent | Allowed                                                                                                                                                                                                                                                                        | Stays revoked                     |

A pairing approved during a hold stays read-only after release because it was issued as `history_only`. The pairing approval page says so while held: "The community is on hold, so this connection can only read. Connect again after the hold ends to post."

### DorkOS app

Two small changes in `apps/server/src/services/communities/remote/`:

1. **Notice a release, for connections nobody polls.** `RemoteRoomSubscriptionRuntime.reconcile()` already calls `RemoteCommunityPairingService.status()` (which runs `verify()`) every 5 seconds for every connection in `enrollments.activeConnections()`, that is, every connection with an enrolled agent (`apps/server/src/index.ts`, `resolveConnectionAccess`). Those connections notice a release on their own within seconds and need nothing new. Only a **member-only connection** (no enrolled agent, so not in `activeConnections()`) is never re-checked unless a person opens connection status. For those, a timer in the same runtime calls `status()` (not `verify()` directly, so the stored access updates the same way) every 5 minutes when the stored `lastKnown.lifecycle` is `archived`. A `401` marks the connection reconnect-required, as today.
2. **Do not replay refused posts.** `deliveryFailure()` in `community-adapter-outbox-delivery.ts` treats a `423` whose code is `COMMUNITY_HELD`, `COMMUNITY_ARCHIVED`, or `COMMUNITY_DELETION_PENDING` as permanent. Other `423`s keep retrying.
3. **Say why.** `apps/server/src/routes/remote-community-refusal.ts` (the `423` case, ~L133 on `main`) maps `COMMUNITY_HELD` to `{ status: 423, code: 'COMMUNITY_HELD', error: 'The host has put this community on hold. You can read it, but no one can post. Its owner can still export it.' }`. #2036 adds this mapping; if it has not landed, this task adds it. Without it a held community reads as "archived" to the person.

### Documents amended

- `specs/community-host-operator-api/02-specification.md`, "Hold", **Credentials** bullet: replaced by "Entering a hold revokes nothing; see `specs/community-hold-keeps-access/`." Its acceptance criterion "Holding revokes grants and agent credentials; release … revives none of them" is replaced by this spec's AC-1 and AC-2. A changelog line is added there.
- ADR `260923-121712`: its Status gains "Amended by `260923-214401` (a hold no longer revokes credentials)." ADR `260923-214401` records this decision.

### Code structure

| Path                                                                               | Change                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/community/src/routes/host-lifecycle.ts`                                      | hold stops calling `revokeTenantAccess`                                                                                                                                                              |
| `apps/community/src/data.ts`                                                       | remove `readOnlyWord`; pass the stored lifecycle to the three predicates; `archivedReadAllowed` checks the scope set only for `archived`; `requirePrincipal`'s agent branch allows `read` while held |
| `packages/shared/src/community-wire.ts`                                            | `CommunityWireInvitePreviewResponseSchema` gains `held`                                                                                                                                              |
| `apps/community/src/browser/` (stream client)                                      | `423` on stream open: banner, no retry loop, lifecycle check every 60 seconds                                                                                                                        |
| `apps/server/src/routes/remote-community-refusal.ts`                               | `COMMUNITY_HELD` mapping (if #2036 has not added it)                                                                                                                                                 |
| `apps/community/src/routes/pairings.ts`                                            | lifecycle-aware capabilities in connection access and grant list; held note on approval                                                                                                              |
| `apps/community/src/routes/events.ts`                                              | close reason `archived` for held; `423` on open                                                                                                                                                      |
| `apps/community/src/routes/invites.ts`                                             | preview shows the hold; preflight, bind, redeem, admission completion answer `423`                                                                                                                   |
| `apps/community/src/browser/` (invitation and pairing pages)                       | the two sentences above                                                                                                                                                                              |
| `apps/server/src/services/communities/remote/remote-room-subscription-runtime.ts`  | 5-minute `status()` for member-only connections whose last known lifecycle is `archived`                                                                                                             |
| `apps/server/src/services/communities/remote/community-adapter-outbox-delivery.ts` | `423` read-only codes are permanent                                                                                                                                                                  |

## User Experience

- **Members** see the existing hold banner and can keep reading in the browser and in DorkOS. DorkOS shows the room as read-only (it already does for `archived`). When the hold ends, posting and live updates come back without reconnecting.
- **Agent owners** keep their agents. An agent's post during a hold fails with "The host has put this community on hold. You can read it, but no one can post. Its owner can still export it." and is not sent later.
- **Invited people** who open a link during a hold see "This community is on hold. You can join when the hold ends." The same link works after release if it has not expired.
- **Owners** keep their invitations and see no change in Settings beyond the existing hold notice.
- **Host operators** see no change on the host page. The operations guide says that a hold keeps connections and that suspension is the tool for cutting them.

## Testing Strategy

Integration tests run on real PostgreSQL with the hold fixtures from #2036; DorkOS tests use the existing remote-community fakes. Each test has a purpose comment.

### Acceptance criteria that discriminate

- **AC-1 — A hold revokes nothing.** Seed community A with an ordinary grant G (`read`, `post`, `enroll-agent`), an agent X with a live credential, an unexpired invitation I, a pending admission, and an unconsumed pairing P. Hold A. Assert the `revoked_at`/`cancelled_at`/`active` columns of every one of those rows are unchanged and `pending_admissions` still has its row. Fails if the hold still calls `revokeTenantAccess`.
- **AC-2 — Held means read-only, release means everything back.** While held: G (scopes `read,post,enroll-agent`, not `history_only`) reads a channel's history and downloads a file (`200`, not `423`); G posts → `423 COMMUNITY_HELD`; X reads history (`200`), downloads a file with its agent credential through `GET /attachments/:id` (`200`), and posts → `423`; opening a stream with G → `423`; enrolling a new agent with G → `423`; `GET /me/connection-access` with G returns lifecycle `archived` and `{read:true, post:false, enrollAgent:false, stream:false}`, and the body parses with the unchanged `CommunityConnectionAccessSchema`. Release A. Then, with no new pairing or enrollment: G posts (`201`), X posts (`201`), G opens a stream (`200`), connection access returns `active` with every capability true, and I redeems (`201`). Fails if reads still require `history_only` or a read-only scope set in a hold (`archivedReadAllowed`), if the agent branch of `requirePrincipal` still refuses every non-active lifecycle, if capabilities ignore the lifecycle (schema parse fails), or if anything was revoked.
- **AC-3 — Streams close honestly.** A stream opened by G before the hold receives `closed` with reason `archived` within the revocation-check interval. Fails if the reason is `removed`.
- **AC-4 — Invitations wait.** During the hold, `preview` of I returns it with the held state; `preflight`, `bind`, and `redeem` answer `423` and insert no `members`, `invite_uses`, or `community_handles` row; `POST /invites` answers `423`; revoking I is allowed. Fails if the hold revokes I or lets someone join.
- **AC-5 — Still-revoking paths unchanged.** Suspending A from `held` revokes G, X's credential, and I; resuming returns A to `held` with them still revoked. Host-started deletion from `held` (notice passed) and the owner's deletion request from `held` revoke in their own transaction. Owner archive revokes. Fails if this change leaked into those paths.
- **AC-6 — Pairing during a hold.** P approved during the hold produces a `{read}` `history_only` grant that, after release, still cannot post (`403`). Fails if a pairing approved while held gains write scopes.
- **AC-7 — Isolation.** Community B, active, is unchanged by every hold and release of A (the two-community fixture).
- **AC-8 — DorkOS notices release.** With a fake clock: a member-only connection (no enrolled agent) whose stored `lastKnown.lifecycle` is `archived` calls `status()` again after 5 minutes and not before, and its stored access becomes `active` when the fake Community releases; a connection with an enrolled agent is not touched by the new timer (the existing reconcile already re-checks it every 5 seconds and resubscribes its rooms once `stream` is true); a member-only connection whose lifecycle is `active` is never polled. Fails if a member-only connection never learns of a release, or if the new timer double-polls agent connections.
- **AC-2b — The Community browser does not loop (browser test).** With the hold set, a member with a channel open sees the hold banner; the page makes one stream-open request that answers `423` and no further stream-open requests over 2 minutes (fake timers), only one `GET /me` per 60 seconds; after release the next check reopens the stream and a new message appears live. Fails on a retry loop or on a page that never resumes.
- **AC-2c — Invite preview.** `POST /invites/preview` for I while held returns `held: true` and parses with the updated strict schema; after release `held: false`.
- **AC-9 — DorkOS does not replay.** An outbox item refused with `423 COMMUNITY_HELD` is marked failed at once with the `COMMUNITY_HELD` reason from `remote-community-refusal.ts` (not the archived sentence); after the fake server switches to accepting posts, the item is not delivered. A `423` with another code still retries. Fails if held-era posts flood in on release.

### Other tests

- The existing hold and lifecycle matrix tests from #2036 run with the assertion "hold revokes" changed to AC-1.
- The tenancy isolation suites run unchanged.

## Performance Considerations

The hold transaction gets cheaper (no revocation updates). The DorkOS timer runs only for connections that are currently read-only, one request per connection per 5 minutes.

## Security Considerations

- A hold was never the tool for cutting access: a compromised agent or connection during a hold can read, exactly as a person can in the browser, and can write nothing. A host that needs to cut credentials suspends the community, which revokes everything; the operations guide says so.
- Reads during a hold use the same credentials and checks as before the hold; no new credential path is added.
- Release restores posting only for credentials that were live before the hold and not revoked by their owners since.

## Documentation

- `apps/community/OPERATIONS.md`: a hold keeps connections, agents, and invitations; suspend to cut access; holds made before this change keep their revocations.
- `apps/community/API.md`: capabilities while held; the stream close reason; invitation behaviour while held.
- `docs/guides/communities.mdx` (for people): "If the host puts a community on hold, you can still read it in DorkOS. Posting comes back when the hold ends."
- A changelog fragment in `changelog/unreleased/`.

## Implementation Phases

- **Phase 1, task 1.1 — Community server.** Everything under "Server", the two browser sentences, the amendments to the host-operator spec and ADR `260923-121712`, docs. AC-1 to AC-7.
- **Phase 1, task 1.2 — DorkOS app.** The member-only `status()` timer, the permanent `423`, and the `COMMUNITY_HELD` refusal mapping. AC-8, AC-9. Independent of 1.1 in code; useful only once 1.1 ships.

### Landing order with the other hosting gaps

This spec shares no machinery with the other three. It lands after #2036 (the hold). It has no migration, so it takes no migration number.

### Backout

Revert the code. Holds made while this was live keep their credentials; with the old code those credentials read as they did before this change (only `history_only` grants can read while held), and the next suspension or deletion revokes them as usual.

## Open Questions

None. Resolved while specifying:

- ~~Should a hold keep live streams open?~~ (RESOLVED) **Answer:** no; they close with reason `archived`, and opening one answers `423`. **Rationale:** the strict wire requires `stream: false` for archived access, which is how installations see a hold; nothing new is posted during a hold anyway.
- ~~Should a pairing approved during a hold become a full connection after release?~~ (RESOLVED) **Answer:** no; it stays read-only, as an archived-era pairing does. **Rationale:** a grant whose scopes change later is a new behaviour to reason about; reconnecting after release is one step.
- ~~Should agent posts queued in DorkOS during a hold be delivered after release?~~ (RESOLVED) **Answer:** no; they fail at once. **Rationale:** a message that arrives hours late, after a hold, is worse than a visible failure.
- ~~Revive credentials revoked by holds made before this ships?~~ (RESOLVED) **Answer:** no. **Rationale:** nothing recorded which revocations came from a hold versus a member's own action.

## Related ADRs

- `260923-214401` — A host hold keeps connections, agents, and invitations; only suspension and deletion revoke (accepted, from this spec; amends `260923-121712`)
- `260923-121712` — A host hold stops growth without blocking export, and host-started deletion follows only a noticed hold
- `260920-201101` — Separate community retention from permanent tenant deletion (archive still revokes)

## References

- DOR-2284 — this specification
- `specs/community-host-operator-api/02-specification.md` (DOR-2243), "Host hold and host-started deletion"
- #2036 (`origin/flow/dor-2255-host-hold`): `routes/host-lifecycle.ts`, `host/communities.ts`, `data.ts`, `tenant-context.ts`
- `apps/community/src/routes/pairings.ts`, `routes/events.ts`, `routes/invites.ts`
- `packages/shared/src/community-wire.ts` (`CommunityConnectionAccessSchema`)
- `apps/server/src/services/communities/remote/pairing-service.ts`, `remote-room-subscription-runtime.ts`, `community-adapter-outbox-delivery.ts`, `apps/server/src/routes/remote-community-refusal.ts`
