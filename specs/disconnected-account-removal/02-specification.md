# DOR-1994 — Remove disconnected accounts

Owner-only **Remove from Accounts** hides a disconnected row without deleting usage, revoked grants, authentication history, or cleanup correlation. Removal requires durable external cleanup acknowledgement `complete` or `not_required`. Pending, failed, or unknown cleanup instead offers **Finish disconnecting** recovery. No personal account mutations are part of verification.

## Contract

`POST /api/connectors/connections/:id/remove` accepts an empty body and returns204, idempotently. Unknown/foreign targets return404; active/paused targets or unconfirmed cleanup return409. The transaction validates owner, disconnected state and cleanup acknowledgement, invalidates old flows, sets `removedAt`, and increments `cleanupGeneration`. Removed records are absent from owner, agent, session and legacy inventory; history readers retain them.

Connections gain `removedAt`, `externalCleanupState` and `cleanupGeneration`. The unique provider/external-reference index applies only to unremoved rows. Background inventory cannot create visible replacement from a removed-only reference. An explicit fresh owner sign-in can create a new stable ID with zero grants only after cleanup acknowledgement and matching generation checks. An old sign-in/poll cannot become eligible merely because cleanup later completes. Old cleanup cannot target a replacement: disconnect claims pending/increments generation before network work, and acknowledgements compare exact generation/reference. The durable managed outbox stores its cleanup generation for resumed acknowledgements.

Authentication claims record private `cleanupSnapshotJson` with acknowledged generations, without external references. Migration marks all historical disconnected rows `unknown`; it never infers credential cleanup from a local applied authority command. Historical pending flows receive NULL snapshot and must terminate safely; a new explicit empty snapshot is encoded as `{}` and remains distinguishable. Completed historical flows stay intact. Snapshot admission and revalidation cover both race orders, including a delayed older flow after a newer sign-in restores the same account.

## Ownership and verification

G owns schema/migration, removal service/route, store identity and query visibility. B/DOR-1993 owns cleanup retry/CAS, authentication flow snapshot guards, shared transport and client UI, and the combined integration PR. Lifecycle edits are combined by cherry-pick, not concurrent checkout edits. A independently reviews the final combined head against REVIEW.md before PR.

Real SQLite tests prove owner/state/cleanup gates, repeated removal, hidden inventory/detail, historical grants/usage retained, fresh replacement without inherited grants, passive no-resurrection, and migration defaults/index behavior. Cleanup-guard removal must fail its regression. The combined implementation includes deferred-cleanup/auth race tests, disconnected/reconnect/remove UI states, pending/error recovery, and transport authority checks. Verification results are recorded in `04-implementation.md`. No physical-history deletion or global identity framework is introduced.
