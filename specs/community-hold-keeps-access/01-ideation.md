---
slug: community-hold-keeps-access
number: 260923-214400
created: 2026-09-23
status: ideation
linear-issue: DOR-2284
project: Cloud-Hosted Communities
---

# A host hold keeps people connected

**Slug:** community-hold-keeps-access
**Author:** Claude (for DOR-2284)
**Date:** 2026-09-23

---

## 1) Intent & Assumptions

- **Task brief:** A host hold should keep read access, invitations (paused), DorkOS connections, and agents, instead of revoking everything. Only suspension and deletion revoke. Today entering a hold runs `revokeTenantAccess` and release revives nothing, so a hold of a few hours (an abuse report being looked into, a billing hiccup) forces every member to pair their DorkOS again, every owner to enroll their agents again, and the owner to reissue every invitation.
- **Source material:** `specs/community-host-operator-api/02-specification.md` ("Host hold and host-started deletion", the "Credentials" bullet), ADR `260923-121712`, and the hold code on `origin/flow/dor-2255-host-hold` (#2036, migration 0014), which is not on `main` yet.
- **Assumptions:**
  - The hold's purpose is "stop growth without cutting people off from their own data". Revoking credentials is not needed for that: every write path already refuses a held community by lifecycle (`423 COMMUNITY_HELD`).
  - The public wire is parsed strictly by DorkOS installations that update on their own schedule. `CommunityConnectionAccessSchema` requires that access reported as `archived` has `read` only, with `post`, `enrollAgent`, and `stream` false. A hold is reported to installations as `archived`. So a kept connection can read during a hold but cannot stream.
  - The operator pre-authorized decisions in this programme. Each decision below has a recommendation and is recorded.
- **Out of scope:**
  - Changing what suspension, owner archive, or deletion revoke. They keep revoking.
  - Reviving credentials that an earlier hold already revoked (before this change ships).
  - A new wire lifecycle word for `held`. Installations keep seeing `archived`.

## 2) Pre-reading Log

- `apps/community/src/routes/host-lifecycle.ts` (hold branch): `action: 'hold'` calls `revokeTenantAccess(client, row.id)` with the comment "A hold ends every live credential, as archive and suspension do; release revives none."
- `apps/community/src/host/communities.ts`: `revokeTenantAccess` revokes invites, deletes `pending_admissions`, cancels unconsumed pairings, revokes grants and agent credentials, deactivates agents.
- `apps/community/src/data.ts`: every grant check has the predicate `($5::text <> 'archived' OR history_only)` fed by `readOnlyWord(lifecycle)`, which maps `held` to `archived`. So even an unrevoked ordinary grant could not read during a hold; only `history_only` grants can.
- `apps/community/src/routes/pairings.ts`: `GET /me/connection-access` computes capabilities from the grant's scopes and `history_only` only, not from the lifecycle. With grants kept through a hold, it would report `post: true` beside lifecycle `archived`, which fails the strict schema's refinement.
- `apps/community/src/routes/events.ts`: the live-stream access check joins `communities ... AND co.lifecycle='active'`, so on a hold it finds no row and closes the stream with reason `removed`, which DorkOS maps to `access-revoked`.
- `packages/shared/src/community-wire.ts`: `CommunityConnectionAccessSchema` refinement "Archived access is history-only" (read true; post, enrollAgent, stream false).
- DorkOS app (`apps/server/src/services/communities/remote/`), traced read-only:
  - `pairing-service.ts` `verify()` re-fetches access only when something asks for connection status or the list (on demand, no timer). A `401` marks the connection reconnect-required; nothing treats `archived` as terminal.
  - `remote-room-subscription-runtime.ts` reconciles every 5 seconds from the stored `lastKnown`; when `effective.stream` is false it stops the room, and when it becomes true again it resubscribes on its own.
  - `community-adapter-outbox-delivery.ts` treats `401/403/409/413/415` as permanent and everything else, including `423`, as retry. An agent post refused during a hold is retried with backoff until the outbox item expires.

## 3) Codebase Map

- **Primary components:** `routes/host-lifecycle.ts` (hold, release), `host/communities.ts` (`revokeTenantAccess`), `data.ts` (grant checks, `readOnlyWord`), `routes/pairings.ts` (connection access, grant list, pairing approval), `routes/events.ts` (stream access), `routes/invites.ts` (preview, preflight, redeem while held), `routes/agents.ts` (enrollment refused while held).
- **DorkOS app:** `services/communities/remote/pairing-service.ts` (verify), `community-adapter-outbox-delivery.ts` (failure classes).
- **Data flow:** host `PATCH /host/communities/:id/lifecycle {action:'hold'}` → lifecycle `held` → every member write refuses with `423 COMMUNITY_HELD`; reads go through the grant checks above.
- **Feature flags/config:** none new.
- **Blast radius:** the hold and release transitions, the three grant predicates in `data.ts`, the access report, the stream close reason, and two DorkOS behaviours. Suspension, archive, and deletion paths are untouched.

## 5) Research

1. **Keep revoking (today).** Simple, but a short hold costs every member a re-pair and every owner a re-enrollment and a round of new invitations. It punishes the people a hold is meant to protect.
2. **Keep every credential; let lifecycle refuse writes (recommended).** Nothing is revoked on hold; reads keep working through the same grants and agent credentials; writes, joins, enrollment, and streaming are refused while held; release needs no revival because nothing was lost. Suspension and deletion still revoke, so a host that must cut access has a tool for it.
3. **Revoke, then revive on release.** Store what the hold revoked and restore it on release. More state, more ways to be wrong (a credential the member revoked on purpose during the hold must stay revoked), and no benefit over 2.

**Recommendation:** option 2.

## 6) Decisions

| #   | Decision                                                          | Choice                                                                                                                                                                                                                     | Rationale                                                                                                                              |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | What a hold revokes                                               | Nothing. Grants, agent credentials, agents, invitations, pending admissions, and unconsumed pairings all stay                                                                                                              | Lifecycle already refuses every write with `423 COMMUNITY_HELD`; revoking adds cost and no protection                                  |
| 2   | What a kept connection can do while held                          | Read history and files. No post, no agent enrollment, no live stream                                                                                                                                                       | The strict wire requires `archived` access to be read-only with `stream: false`; a held community reads as `archived` to installations |
| 3   | How an open stream ends when a hold starts                        | `closed` with reason `archived`, never `removed`                                                                                                                                                                           | `removed` means "your access was revoked" to DorkOS; the connection is intact                                                          |
| 4   | Invitations                                                       | Paused: not revoked; preview says the community is on hold; redemption and new invitations answer `423 COMMUNITY_HELD`; expiry keeps running; revoking one still works                                                     | Owners keep their invitations; nobody joins a community that cannot grow                                                               |
| 5   | A pairing approved during a hold                                  | Unchanged from today: approved as `{read}` and `history_only`, so it stays read-only after release                                                                                                                         | Matches the archive rule; the person reconnects after release to post. Simpler than a grant that changes its scopes later              |
| 6   | Release                                                           | Returns to the prior state with nothing to revive                                                                                                                                                                          | Nothing was revoked                                                                                                                    |
| 7   | Suspension, archive, deletion (owner or host), and a takedown     | Still revoke everything, as today                                                                                                                                                                                          | Those are the tools for cutting access                                                                                                 |
| 8   | DorkOS: noticing that a hold ended                                | Connections with an enrolled agent already re-check every 5 seconds (the subscription runtime calls `status()`); only member-only connections whose last known lifecycle is `archived` get a new 5-minute `status()` check | A member-only connection is otherwise re-checked only when a person opens connection status (corrected after review)                   |
| 9   | DorkOS: an agent post refused with `423` during a hold or archive | Fails at once with the read-only reason instead of retrying                                                                                                                                                                | Otherwise posts queued during a hold flood the community when it is released, long after they made sense                               |
| 10  | Holds that already revoked credentials before this ships          | Stay revoked; documented                                                                                                                                                                                                   | Nothing recorded what to revive                                                                                                        |
| 11  | Where this lands                                                  | Its own PR after #2036 merges. If #2036 is still open when this is built, the server change folds into it before merge instead                                                                                             | Keeps the hold PR's review scope; either way no migration is needed                                                                    |
