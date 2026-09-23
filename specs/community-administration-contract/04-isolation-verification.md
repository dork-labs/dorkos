# Administration isolation verification

Status: complete. Refs DOR-2178. This receipt covers two proofs, a strengthened deletion proof and a foreign-object matrix. The role matrix, every role on every administration action, has its own receipt in `04-role-matrix-verification.md`.

The real HTTP/PostgreSQL deletion journey now keeps another active community populated with a private channel, a posted attachment, and an authenticated live stream while the target community is deleted. The existing journey includes an in-flight export, uncertain blob cleanup, an injected provider failure, and a later worker retry.

Before deletion, the test records every surviving-community row in every public table with a `community_id` column, its community row, and every account and session. After deletion, that record is identical. The same browser session can still read that community, its private file bytes are unchanged, and the already-open stream delivers a newly posted message. This strengthens the previous check, which only proved a second community row remained.

The content-free deletion receipt is also tested before and after its thirty-day expiry. The fixture moves the request, completion, and expiry together to preserve the database's time constraints.

Verification:

- Administration PostgreSQL suite: **12 passed** at this step (before the foreign-object test below was added), using one worker and the existing deadlines.
- Fault-injection sensitivity: deliberately deleting the surviving community's blob during the failed worker attempt makes the new download assertion fail (`404` rather than `200`). The original test source was restored afterward. This was re-run on `main` with the same result (see below). An earlier injection after an unreachable retry branch did not execute and is not counted as mutation evidence.
- The first expiry fixture changed only its expiry and correctly failed the database constraint. The corrected fixture preserves the required thirty-day relationship; the final suite passes.
- The owned local PostgreSQL container was stopped after verification.

Independent review of the deletion proof as first written (commit `b0b9d87c6`, before it was cherry-picked onto `main` unchanged): zero Important findings and zero Nits.

Remaining: none for this receipt. The items once listed here have landed:

- Composed acceptance with the final membership and navigation changes: a two-Desktop acceptance run on `main` 30df6cdc2, 20/20 steps, after community switching landed (#1992).
- The upgrade matrix: a populated version-four host upgrades intact (#1994, `migrate.integration.test.ts`); the tenancy proof pack is in `specs/community-tenancy-contract/05-isolation-receipt.md` (#2000).
- The permission matrix: `04-role-matrix-verification.md` (#2001).
- The backup/restore rehearsal: `apps/community/scripts/rehearse-backup-restore.mjs` (#1988), run as described in `apps/community/OPERATIONS.md`.

The last item for the wider programme, administration with Cloud egress blocked, is now proven by `tenancy-egress.integration.test.ts` (see `04-implementation.md`). No live deployment or production data was changed by this proof.

## Foreign-object matrix

Refs DOR-2174 and DOR-2178. One signed-in person owns two active communities, A and B. The test creates objects in B through B's own URL: a private channel, entries, a committed file, an invitation, a pairing, an ordinary member, a connection grant, an agent, an export, and a join attempt started from an invitation. Positive controls read each of them through B first.

**The probe list is checked against the app itself.** The test reads the routes the app actually registers under `/api/v1/communities/:communityId`, 62 today. Every route must be either:

- probed: 36 routes, 42 probes, each passing a B id through A's URL, in the path or in the body. Where a route takes two ids, one probe pairs a foreign channel with anything, and another pairs A's own channel with the foreign id. That covers replies to a foreign entry, attaching a foreign file, adding a foreign member or agent, and the owner-transfer successor. Binding and redeeming an invitation take no id at all; they read the join attempt from a cookie, so they are probed with the cookie of a join attempt started in B.
- or checked separately: 1 route. Enrolling an agent looks up the caller's existing agent by its local id, and would reactivate it and replace its credentials. Sent from A with a local id that exists only in B, it must create a fresh agent in A and leave B's agent and credentials unchanged.
- or exempt: 25 routes, each with a written reason. All of them take no object id. They act on the caller, on the community named in the URL, or on something they create.

A route that is in no list, or in more than one, fails the test. So does a probe that never ran. A new route therefore has to be classified before the suite passes.

**What each probe must show.** The same request is sent twice, once with the B id and once with an id that exists nowhere. The two responses must match exactly, status and body, and must be a refusal. So a foreign id reveals nothing that a made-up id would not. A probe refused before any lookup fails too: one rejected by validation, by a missing sign-in (`401`), or by the cross-site check. So a malformed probe cannot pass by accident.

**Nothing changed.** A snapshot is compared before and after all probes. It covers every tenant table for both communities, both community rows, every account and every session. The list of 29 tenant tables is pinned: if the catalogue query returned nothing, the test would fail rather than compare two empty snapshots. One field is left out: a grant's last-used time, which the app updates by design whenever the grant signs a request.

One probe is weaker than the rest. File download and channel reads are guarded twice: once by the community check and again by channel membership in the current community. Removing only one of these checks does not turn the test red. The test proves the combined result.

## Re-verification on `main`

Both Codex commits were cherry-picked onto `main` without conflicts. Ignoring whitespace, the only lines they remove are Prettier line-wraps and a widened import, so no earlier assertion was lost. The matrix above then replaced Codex's hand-written list. The archive test's grant check now looks only at community A's grants, because the matrix adds a grant to B.

- Administration file against a fresh PostgreSQL 17 container, one worker: **13 passed**, three runs in a row, no flakes.
- Whole PostgreSQL suite: **173 passed**, 4 declared inapplicable, across 14 files.
- No probe found a real leak. Every foreign id was refused on unmodified code.
- Each check below was a temporary edit, run, then reverted. The file was green again afterward.

| Temporary break                                                            | Result                                                                                                         |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Enrolling an agent finds an existing agent by local id in any community    | fails: `409` instead of a new agent in A                                                                       |
| The agent-rotation probe is sent without credentials                       | fails: the probe is refused with `401` before any lookup                                                       |
| Binding a join attempt ignores the community                               | fails: `POST /invites/bind` returned `200`                                                                     |
| Revoking a grant ignores its owner and community                           | fails: `DELETE /me/grants/:id` returned `204`                                                                  |
| Owner transfer looks up the successor in any community                     | fails: `503` instead of the `404` a made-up id gets                                                            |
| Rotating an agent ignores its owner and community                          | fails: `503` instead of `404`                                                                                  |
| Adding an agent to a channel accepts an agent from any community           | fails: `503` instead of `404`                                                                                  |
| Role changes ignore the community                                          | fails: `200`                                                                                                   |
| A pairing read ignores the community                                       | fails: `200`                                                                                                   |
| Revoking an invitation ignores the community                               | fails: `204`                                                                                                   |
| Deletion also wipes every community's `audit_events` rows                  | the deletion test fails on the surviving community's before/after record. The test on `main` passes (12 of 12) |
| The surviving community's file is deleted during the failed worker attempt | the deletion test fails: the download returns `404`, expected `200`                                            |
| The tenant-table query returns nothing (`AND false`)                       | both the matrix and the deletion test fail on the pinned table list                                            |

The grant revoke and owner transfer breaks were first found by review. Both passed the whole PostgreSQL suite before this matrix existed.
