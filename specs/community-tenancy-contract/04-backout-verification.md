# Task 1.4: single-community backout

Status: verification in progress. Refs DOR-2172; this slice does not complete authorization or multi-community rollout.

Worker: `/root`. Worktree: `/Users/doriancollier/.codex/worktrees/community-backout/dorkos`. Branch: `codex/community-backout`. Base: `f2c48aff63687173a884f9cddfd868a09ae68661`.

The supported path is restoring a coordinated pre-migration database/object snapshot into an isolated deployment of its original image. There is no destructive reverse migration or automatic production restore. `inspectBackout` only reports host eligibility; it does not certify backup completeness or writer quiescence.

Migration 0009 preserves a durable first-community identity without a foreign key. Creating another community latches a permanent refusal, including after either community is deleted. One locked singleton row serializes competing first insertions; an aborted transaction rolls its history back. Ordinary SQL cannot clear or remove the history. A privileged database operator could disable triggers, so this is a runtime invariant, not a defense against the database administrator.

The diagnostic fails closed on an empty host, multiple communities, any multiple-membership account, missing history, a mismatched first community, or a database error. All membership rows count, including inactive rows. The operations guide requires stopped writers and a second snapshot preserving the current state before rehearsing an older snapshot.

## Evidence

- Six real PostgreSQL cases cover eligible singleton/read-only behavior, deletion after second-community use, competing inserts, aborted creation, replacement after deletion, and attempts to clear/delete/truncate history.
- A populated version-four rehearsal took a real PostgreSQL 17 custom-format dump plus matching file bytes, applied migrations 5–9, and verified singleton eligibility. It preserved a second dump after a post-backup write, restored the original dump into a different empty database, and compared every public table and row against the original snapshot. Restored file bytes matched SHA-256 `3db0cce0cf9baea25ce3ab14b009d1f33fe2ac96ac5eb62e14bc4a24ac17f094`. The legacy singleton constraint rejected a second community. A second community in the upgraded source made the diagnostic refuse backout.
- The rehearsal deliberately confirmed that the post-backup write was absent in the restored database. The guide describes that loss rather than promising lossless rollback.
- This fixture proves schema/data/file recovery, not a packaged-image sign-in test. The earlier live-deployment recovery proof covers the existing image; the completed tenancy release still owes the populated upgrade and runtime compatibility gate in Task 4.2 before production deployment.
- Local evidence lives under `.temp/backout/` and must be archived with checksums before removing this tree. No production database, bucket, account, or process was used.

The first targeted run passed all nine assertions but exited red with four unhandled teardown errors. It used `pool.end()` followed by forced database drop, which can interrupt PostgreSQL connections before close acknowledgment. The new fixture now waits for all pool `remove` acknowledgments and drops without force; its six tests then passed without unhandled errors. Retain both results.

Targeted migration and backout verification passed 9/9. The permanent-history mutation test deliberately disabled the latch: after deleting the second community, the test failed because the diagnostic incorrectly returned eligible. Restoring the latch restores the refusal. Community build and typecheck passed; lint exited zero with existing warnings. Independent adversarial review and normal push gates are pending.
