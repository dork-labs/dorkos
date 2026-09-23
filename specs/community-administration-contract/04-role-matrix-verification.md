# Administration role matrix verification

Status: complete for the API role matrix. Refs DOR-2178. The matrix found one real gap, a closed community that still admitted people, and the same change fixes it (see the last section). The wider browser, concurrency and packaged Desktop proofs are separate.

The specification's verification matrix asks for a passing and a refused API test for every role on every administration action, including a host operator who is not a member. `apps/community/src/__tests__/administration-roles.integration.test.ts` is that test. It runs over real HTTP against a real PostgreSQL database.

## How it works

One table lists 43 administration actions, five of them against a community whose admission is closed. Each action is sent once as each of 9 roles:

| Role          | Who                                                                                |
| ------------- | ---------------------------------------------------------------------------------- |
| Owner         | owns community A; not a host operator                                              |
| Admin         | admin in A                                                                         |
| Member        | plain member of A                                                                  |
| Removed       | was a member of A and was removed; their browser session still works               |
| Signed out    | no session                                                                         |
| Host only     | a host operator with no membership anywhere                                        |
| Host + member | the first-install host operator; owns another community and is a plain member of A |
| Other owner   | owns community B only                                                              |
| Agent         | an agent credential enrolled by A's owner, sent as a bearer token                  |

- **Allowed cell:** the exact success status, and the effect is checked in the database (the name changed, the community is archived, the member is inactive, and so on).
- **Refused cell:** the exact refusal status, and a snapshot of every row of every table is identical before and after. The only field left out is a grant's or credential's last-used time, which the app updates by design.
- **Reauthentication:** the six owner actions that need the current password are also sent by the owner with a wrong password. Each must return `403` and change nothing.
- **Every route is classified.** The test reads the routes the app registers. Each one must be either in the matrix or in a list of 35 routes outside administration, each with a reason (ordinary reading and posting, a person's own grants, pairing). Every route the host and administration modules register must be in the matrix. A new route fails the test until someone classifies it.

After every cell, A is put back to its starting state through the public API: resumed, deletion cancelled, restored, ownership returned, the spare member demoted, and admission back to invite-only.

Three kinds of fixture are seeded directly in the database, because no API exists for them or they are not under test: password accounts (there is no open sign-up), the second host operator (adding one is a separate host-operation contract), and the personal grant used to enroll agents (pairing is not under test). Every membership, role, community, claim and agent is created through the real routes.

## The matrix

✓ means allowed, with the success status shown in the Allowed column. A number is the refusal status.

| Action                                         | Allowed | Owner | Admin | Member | Removed | Signed out | Host only | Host + member | Other owner | Agent |
| ---------------------------------------------- | ------- | ----- | ----- | ------ | ------- | ---------- | --------- | ------------- | ----------- | ----- |
| List host communities                          | 200     | 403   | 403   | 403    | 403     | 401        | ✓         | ✓             | 403         | 401   |
| List own memberships                           | 200     | ✓     | ✓     | ✓      | ✓       | 401        | ✓         | ✓             | ✓           | 401   |
| Create a pending community                     | 201     | 403   | 403   | 403    | 403     | 401        | ✓         | ✓             | 403         | 401   |
| Reissue an owner claim                         | 200     | 403   | 403   | 403    | 403     | 401        | ✓         | ✓             | 403         | 401   |
| Revoke an owner claim                          | 204     | 403   | 403   | 403    | 403     | 401        | ✓         | ✓             | 403         | 401   |
| Delete an unclaimed community                  | 204     | 403   | 403   | 403    | 403     | 401        | ✓         | ✓             | 403         | 401   |
| Suspend                                        | 200     | 403   | 403   | 403    | 403     | 401        | ✓         | ✓             | 403         | 401   |
| Resume                                         | 200     | 403   | 403   | 403    | 403     | 401        | ✓         | ✓             | 403         | 401   |
| Open an owner claim (token holder)             | 200     | ✓     | ✓     | ✓      | ✓       | ✓          | ✓         | ✓             | ✓           | ✓     |
| Redeem an owner claim (signed-in token holder) | 200     | ✓     | ✓     | ✓      | ✓       | 401        | ✓         | ✓             | ✓           | 401   |
| Download the icon                              | 200     | ✓     | ✓     | ✓      | 403     | 401        | ✓         | ✓             | 403         | 401   |
| Read settings                                  | 200     | ✓     | ✓     | ✓      | 403     | 401        | 403       | ✓             | 403         | 401   |
| Edit name                                      | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Edit admission policy                          | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Edit description                               | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Replace icon                                   | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Clear icon                                     | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Transfer ownership \*                          | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Archive \*                                     | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Restore \*                                     | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Read deletion status                           | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Request permanent deletion \*                  | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Cancel permanent deletion \*                   | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Owner export \*                                | 201     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Download the owner export                      | 200     | ✓     | 404   | 404    | 403     | 401        | 403       | 404           | 403         | 401   |
| Member directory                               | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Change a member's role                         | 200     | ✓     | 403   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Remove a member                                | 204     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Create an invitation                           | 201     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| List invitations                               | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Revoke an invitation                           | 204     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Remove another member's agent                  | 204     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Put another member's agent in a channel        | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Take another member's agent out of a channel   | 204     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Create a channel                               | 201     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Edit a channel                                 | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Add a member to a channel                      | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| Remove a member from a channel                 | 200     | ✓     | ✓     | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| **Closed:** create an invitation               | none    | 409   | 409   | 403    | 403     | 401        | 403       | 403           | 403         | 401   |
| **Closed:** preview a surviving invitation     | none    | 409   | 409   | 409    | 409     | 409        | 409       | 409           | 409         | 409   |
| **Closed:** start joining with it              | none    | 409   | 409   | 409    | 409     | 409        | 409       | 409           | 409         | 409   |
| **Closed:** bind a surviving join attempt      | none    | 409   | 409   | 409    | 409     | 401        | 409       | 409           | 409         | 401   |
| **Closed:** redeem it (each role joins itself) | none    | 409   | 409   | 409    | 409     | 401        | 409       | 409           | 409         | 401   |

\* Also sent by the owner with a wrong password: `403`, nothing changed.

The closed rows are refused for everyone, and nothing changes. The first closes admission through the API. The other four close it directly in the database without revoking anything, which leaves a live invitation or join attempt behind: closing through the API would have revoked it, so this is the case of an invitation that somehow survived. Preview and start-joining need no sign-in, so every caller gets `409`; creating an invitation is still a role check first, so only the owner and admin reach the `409`. In the redeem row each role binds its own account, so an existing member, a removed member and an outsider are all refused, and the removed member stays removed.

The export download returns `404` to members of A who did not request the export, because the lookup is scoped to the requester; it returns `403` to accounts that are not members of A at all.

Totals: 387 role cells (87 allowed, 300 refused), 6 wrong-password cells, 4 race tests, one public-failure test and one route-classification test: **399 tests**.

### A made-up invitation learns nothing

The "closed" reason goes only to a link genuinely signed for this community. A signed-out caller sends three tokens to preview and to start joining: garbage, a well-formed token with a forged signature, and a real invitation signed for community B. The six refusals are recorded while A is open, all `403`, then again after A is closed. Status and body must be identical, which keeps the membership specification's same public failure shape.

### Closing while someone is invited or joining

Four tests hold A's row so that a close and an invitation (or a join) queue behind it in a chosen order, then release it. Postgres hands the row to waiters in arrival order, so each ordering runs on purpose rather than by luck. Both requests go through the real API.

| Order                            | Result                                                            |
| -------------------------------- | ----------------------------------------------------------------- |
| Close, then create an invitation | the invitation is refused (`409`); no open invitation remains     |
| Create an invitation, then close | the invitation is created (`201`) and the close revokes it        |
| Close, then redeem a bound join  | the join is refused (`409`); no member row is created             |
| Redeem a bound join, then close  | the person joins first and stays an active member after the close |

The agent credential is live while A is active. Suspend, archive and deletion already revoke every agent credential, so in the resume, restore and cancel rows it has been revoked by the step that set the row up.

## Verification

- The matrix file against a fresh PostgreSQL 17 container, one worker: **398 passed**, three runs in a row, no flakes (24 to 31 seconds each), then **399 passed** with the public-failure test added.
- Whole PostgreSQL suite: **15 files, 572 passed**, 4 declared skips. Community unit tests: **43 passed**. Community browser suite: **3 passed**. Packaged acceptance driver (`apps/community/acceptance/run.sh`), which joins through a real invitation: **passed** on the second run of the same image. The first run timed out much later in the journey, waiting for a local agent turn to be claimed; the invitation and join steps had already passed.
- Every role cell matched the specification. No role was allowed something the specification forbids, and none was refused something it allows. The one gap was not a role: a closed community still admitted people.
- The owned PostgreSQL container was stopped afterward. No live deployment or production data was touched.

Each check below was a temporary edit, run, then reverted. The source was clean again afterward.

| Temporary break                                                                                     | Result                                                                                    |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Settings update drops the owner-only check on name and admission policy                             | 2 fail: admin edits name, admin edits admission policy                                    |
| The host-operator request check accepts any signed-in account                                       | 5 fail: every non-operator account lists host communities                                 |
| That check and the in-transaction host-operator check both accept any account                       | 35 fail: every host action, for owner, admin, member, removed member and other owner      |
| Icon download no longer accepts a host operator                                                     | 1 fails: host-only icon download, an allowed cell                                         |
| Archive and restore accept an admin                                                                 | 2 fail: admin archives, admin restores                                                    |
| Role changes accept an admin                                                                        | 1 fails: admin changes a role                                                             |
| Administration reauthentication accepts any password                                                | 4 fail: wrong-password archive, restore, deletion request and deletion cancel             |
| The whole closed-admission fix removed (the code before this change)                                | 36 fail: every closed row for the roles that reach it, and two races                      |
| Creating an invitation drops the closed check                                                       | 3 fail: owner and admin create while closed, and the close-then-create race               |
| Preview and start-joining drop the closed check                                                     | 18 fail: every role in both rows                                                          |
| Binding drops the closed check                                                                      | 7 fail: every signed-in role                                                              |
| The closed check runs before the invitation's signature is verified (the first version of this fix) | 1 fails: the made-up-token test (made-up tokens got `409` while closed, `403` while open) |
| Redeeming drops the closed check                                                                    | 8 fail: every signed-in role, and the close-then-redeem race                              |

Every host mutation checks the operator twice, once per request and again inside the transaction. Removing only the first check turns only the list red; the mutations stay refused. The test proves the combined result.

## Where the code and the specification differed

- **A closed community still admitted people. Fixed here.** The settings model says changing the admission policy to `closed` revokes every outstanding invitation and pending admission. The code did that, but nothing checked the policy afterwards: with A closed, an admin created a new invitation (`201`) and a new account joined through it. Now, while a community is closed, creating an invitation, previewing one, starting to join, binding and redeeming are all refused with `409 STATE_CONFLICT` and the message "This community is closed to new members." The join steps check only after the invitation's signature is verified, so a made-up token gets the same `403` whether the community is open or closed. On the write paths the community row is already held in share mode in the same transaction, so each check serializes with the close, which takes that row for update before revoking. Existing members keep their access, and an owner claim for a new pending community still works: that is how a community gets its first owner, not an admission. In the app, the invite panel shows the reason instead of the Create invite button, and hides a link made before the close, which was revoked with it. Checked in the browser suite at desktop width and at 390 pixels.
- **The host list includes the description.** The management experience lists name, short ID, lifecycle state, owner-present and cleanup status for the host list. The API also returns the description, which owners and admins set. It holds no member, content or file data, which the matrix asserts. Left as it is.
