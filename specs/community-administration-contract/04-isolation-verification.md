# Administration isolation verification

Status: in progress. Refs DOR-2178. This receipt covers two proofs, a strengthened deletion proof and a foreign-object matrix. It is not the full administration acceptance matrix.

The real HTTP/PostgreSQL deletion journey now keeps another active community populated with a private channel, a posted attachment, and an authenticated live stream while the target community is deleted. The existing journey includes an in-flight export, uncertain blob cleanup, an injected provider failure, and a later worker retry.

Before deletion, the test records every surviving-community row in every public table with a `community_id` column, plus its community row. After deletion, that manifest is identical. The same browser session can still read that community, its private file bytes are unchanged, and the already-open stream delivers a newly posted message. This strengthens the previous check, which only proved a second community row remained.

The content-free deletion receipt is also tested before and after its thirty-day expiry. The fixture moves the request, completion, and expiry together to preserve the database's time constraints.

Verification:

- Administration PostgreSQL suite: **12 passed** at this step (before the foreign-object test below was added), using one worker and the existing deadlines.
- Fault-injection sensitivity: deliberately deleting the surviving community's blob during the failed worker attempt makes the new download assertion fail (`404` rather than `200`). The original test source was restored afterward. This was re-run on `main` with the same result (see below). An earlier injection after an unreachable retry branch did not execute and is not counted as mutation evidence.
- The first expiry fixture changed only its expiry and correctly failed the database constraint. The corrected fixture preserves the required thirty-day relationship; the final suite passes.
- The owned local PostgreSQL container was stopped after verification.

Independent review of the deletion proof as first written (commit `b0b9d87c6`, before it was cherry-picked onto `main` unchanged): zero Important findings and zero Nits.

Remaining: composed acceptance with the final membership/navigation changes, the complete permission/upgrade matrix, and a coordinated backup/restore rehearsal. No live deployment or production data was changed by this proof.

## Foreign-object matrix

Refs DOR-2174 and DOR-2178. The administration suite also exercises one authenticated person who owns two active communities. Positive controls first read the second community's private channel, history, roster, committed attachment, export, and pairing through its correct qualified URL. Requests for those same objects through the first community return 404, including its event stream. Foreign channel edits, posts, joins, leaves, roster changes, member removal/role changes, and invitation deletion return 404. Foreign pairing approval returns the exact same generic 409 response as a nonexistent pairing.

A before/after snapshot of every tenant-keyed table for both communities proves that all rejected operations leave both unchanged. Final PostgreSQL administration run: **13 passed**. This extends the deletion proof; it does not yet claim the complete credential-family or populated-upgrade acceptance matrix.

The role change probe targets an ordinary member added to the second community, because owners can never be demoted: aimed at the owner, it would return 404 even without a tenant check. The member removal probe targets the second community's owner; without the tenant check it returns 403 instead of 404, so it still fails the test.

## Re-verification on `main`

Both commits were cherry-picked onto `main` without conflicts. Ignoring whitespace, the only lines they remove are Prettier line-wraps and a widened import, so no earlier assertion was lost.

- Administration file against a fresh PostgreSQL 17 container, one worker: **13 passed**, five runs in a row, no flakes. After the role change probe was moved to an ordinary member: **13 passed**, three more runs in a row.
- Whole PostgreSQL suite: **163 passed**, 4 declared inapplicable, across 13 files.
- Each check below was a temporary edit to the product code, run, then reverted; the file was green again afterward.
  - Deletion also wipes every tenant's `audit_events` rows: the new test fails on the surviving community's before/after comparison. The old test on `main` still passes (12 of 12), so it could not see this.
  - A pairing read ignores the community: the new test fails with `200` where it expects `404`. The old test still passes.
  - Revoking an invitation ignores the community: the new test fails with `204` where it expects `404`.
  - Removing the community check from the file download alone, or also from the channel lookup, does not turn the test red: a private channel still needs membership in the current community, which is a separate check. The test proves the combined result, not each layer on its own.
  - Role changes ignore the community: the new test fails with `200` where it expects `404`. Before the probe was moved to an ordinary member, this break went unnoticed.
  - The surviving community's file is deleted during the failed worker attempt: the new test fails with `404` where it expects `200` on the download.
