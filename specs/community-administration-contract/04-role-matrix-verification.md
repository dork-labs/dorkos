# Administration role matrix verification

Status: complete for the API role matrix. Refs DOR-2178. The browser, concurrency and packaged Desktop proofs are separate and are not covered here.

The specification's verification matrix asks for a passing and a refused API test for every role on every administration action, including a host operator who is not a member. `apps/community/src/__tests__/administration-roles.integration.test.ts` is that test. It runs over real HTTP against a real PostgreSQL database.

## How it works

One table lists 38 administration actions. Each action is sent once as each of 9 roles:

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
- **Every route is classified.** The test reads the routes the app registers. Each one must be either in the matrix or in a list of 39 routes outside administration, each with a reason (ordinary reading and posting, a person's own grants, pairing, joining). Every route the host and administration modules register must be in the matrix. A new route fails the test until someone classifies it.

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

\* Also sent by the owner with a wrong password: `403`, nothing changed.

The export download returns `404` to members of A who did not request the export, because the lookup is scoped to the requester; it returns `403` to accounts that are not members of A at all.

Totals: 342 role cells (87 allowed, 255 refused) plus 6 wrong-password cells, and one route-classification test: **349 tests**.

The agent credential is live while A is active. Suspend, archive and deletion already revoke every agent credential, so in the resume, restore and cancel rows it has been revoked by the step that set the row up.

## Verification

- The matrix file against a fresh PostgreSQL 17 container, one worker: **349 passed**, three runs in a row, no flakes (22 to 28 seconds each).
- Whole PostgreSQL suite: **15 files, 522 passed**, 4 declared skips.
- On unmodified code every cell matched the specification. No role was allowed something the specification forbids, and none was refused something it allows.
- The owned PostgreSQL container was stopped afterward. No live deployment or production data was touched.

Each check below was a temporary edit, run, then reverted. The source was clean again afterward.

| Temporary break                                                               | Result                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Settings update drops the owner-only check on name and admission policy       | 2 fail: admin edits name, admin edits admission policy                               |
| The host-operator request check accepts any signed-in account                 | 5 fail: every non-operator account lists host communities                            |
| That check and the in-transaction host-operator check both accept any account | 35 fail: every host action, for owner, admin, member, removed member and other owner |
| Icon download no longer accepts a host operator                               | 1 fails: host-only icon download, an allowed cell                                    |
| Archive and restore accept an admin                                           | 2 fail: admin archives, admin restores                                               |
| Role changes accept an admin                                                  | 1 fails: admin changes a role                                                        |
| Administration reauthentication accepts any password                          | 4 fail: wrong-password archive, restore, deletion request and deletion cancel        |

Every host mutation checks the operator twice, once per request and again inside the transaction. Removing only the first check turns only the list red; the mutations stay refused. The test proves the combined result.

## Where the code and the specification differ

- **Closing admission does not stop new invitations.** The settings model says changing the admission policy to `closed` revokes every outstanding invitation and pending admission, which the code does. But nothing checks the policy afterwards: with A set to `closed`, an admin created a new invitation (`201`) and a new account joined through it. The matrix does not encode this either way, and no code was changed.
- **The host list includes the description.** The management experience lists name, short ID, lifecycle state, owner-present and cleanup status for the host list. The API also returns the description, which owners and admins set. It holds no member, content or file data, which the matrix asserts.
