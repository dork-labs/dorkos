# DOR-2429 root lifecycle inventory

Read-only source inventory at pinned revision `5794f638160a68811382347356fd29b31ee2e911`. No server boot, mutations, or runtime proof. Rules read: AGENTS.md, REVIEW.md, conventions, server-structure, api, dork-home. References below are baseline line numbers.

## Current ownership and ordering

- `apps/server/src/index.ts:841–849`: the instance lock is acquired before opening the database; its release is retained at module scope. `:964` opens the consolidated database into a startup-local variable.
- `index.ts:1556–1601`: workspace bootstrap receives a reconciler, registers the manager and starts the reconciler, but keeps no teardown reference. `services/workspace/index.ts:54–82` constructs the class and returns it without starting it. The merged class disposal contract already fences synchronous cache writes after pending reads.
- `index.ts:4582–4589`: admin receives the raw `shutdownServices` function and a separate database closer.
- `index.ts:5251–5260`: the main HTTP server is local to startup; its upgrade router is attached when listening begins. The teardown function contains no main listener close, request admission gate, request drain or upgrade drain. Closing preview listeners at `:5549` is unrelated.
- `index.ts:5507–5526`: teardown first stops/flushes account usage, aborts the legacy sweep, stops remote community components, and awaits fixture/listener close. Most await failures terminate the sequence; only the usage flush has a local rejection catch.
- `index.ts:5527–5544`: housekeeping intervals and the approval sweep stop only after those early awaits. Clearing an interval is not a proof that previously launched work has drained.
- `index.ts:5546–5606`: existing dependency order covers terminal/preview handles, OAuth, reporters, broadcaster, scheduler, messaging runtimes before Relay, Relay before trace storage, task and skill watchers, search/mesh, runtime children, tunnel, Cloud link and observability. There is no aggregate deadline or best-effort continuation policy here. A rejection or non-settling closer can prevent later owners from being visited.
- `index.ts:5607–5611`: instance lock is released last in the normal path. The comment that nothing can still write is stronger than current evidence: HTTP admission is open, workspace reconciliation is unowned here, and other timer stops do not establish drain.
- `index.ts:5615–5625`: signal entry has a boolean guard. It does not guard admin's direct calls, does not return one shared completion to repeated callers, and leaves shutdown pending if a closer hangs. Rejection prevents the success exit; the process-level rejection handler logs it without exiting (`:5646–5653`).
- `routes/admin.ts:276–299`: admin sends its acknowledgment before deferred cleanup. Reset awaits cleanup, closes DB, removes the data directory, then restarts; restart awaits cleanup then restarts. Both catch cleanup failure and restart anyway. Reset DB closure happens after root lock release. Ordinary restart and signal shutdown do not explicitly close this DB handle.
- `routes/admin.ts:116–132`: production restart spawns a successor before exiting; development exits and relies on its watcher. Listener/lock/DB handoff therefore deserves an explicit policy rather than inferred ordering.
- `index.ts:5656–5673`: startup failure closes only the offline fixture, then logs and exits. No reverse acquisition stack or ordinary teardown is invoked. Direct exits for config failure (`:885`), bind policy (`:5245`) and bind conflict (`:5316`) bypass this catch. Fatal exception handling (`:5630–5643`) flushes its error report and exits, without ordinary cleanup.
- `index.ts:4744–4752` and `services/marketplace/package-cache-retention.ts:348–350`: retention starts a background sweep and subscribes to entry writes, discarding the returned unsubscribe. Its owner has no terminal disposal. Keep this separately scoped.

## Smallest defensible adoption slice

Retain workspace reconciliation in a small root-owned lifetime holder. Its terminal state must be sticky: disposal must prevent later startup from registering/starting a new reconciler if a signal arrived during an earlier awaited startup step. Register the reference before starting it, and clean it on partial-start failure. Call terminal disposal synchronously at shared teardown entry, before the first unrelated await, so the cache-write fence takes effect even when a later closer hangs. Await and report its `drained`/`timed-out` result explicitly. Reuse that same terminal operation in the startup catch for this owner alone.

Scope refinement agreed in review: coalesce only workspace disposal, leaving shared whole-sequence shutdown idempotency for a follow-on. One stored root cleanup promise could later coalesce admin and signal invocations while preserving the existing remaining teardown order, but its failure would remain the same failure for all callers; that would not establish best-effort continuation or successful shutdown. A shared cleanup promise also would not serialize the reset/restart actions performed after it: reset may still be deleting files while another continuation restarts. Keep that request-level exclusivity claim outside this slice unless it is expressly implemented and tested.

The selected design preserves unexpected disposal failure as a rejection during ordinary shutdown, so that failure cannot silently advance the existing lock handoff. Only the startup-failure path contains workspace cleanup failure and logs it before continuing with the original startup error. Failure is not `drained`, and the holder cannot claim that an unexpected exception established the class's write fence. Existing fixture cleanup can still fail later; preserving the original error across every cleanup owner is a separate follow-on. On partial start failure, retain the reconciler for later disposal or immediately initiate its disposal before discarding the reference.

Focused evidence should cross the actual root-owned helper used by bootstrap and teardown: enabled/disabled bootstrap; disposal before registration; start failure; pending checkout and manifest reads; terminal fence established before an unrelated hanging closer; drain and exact timeout; repeated disposal joining; startup failure after acquisition. Tests of the class alone or admin with a mocked shutdown function do not prove adoption. A small TypeScript-AST wiring test can pin the helper's root instance, bootstrap registration, and awaited disposal before other awaited cleanup in both `shutdownServices` and `start().catch`, without a huge root boot mock. Label this structural wiring evidence, not end-to-end server lifetime proof.

## Separate decisions required for broader claims

1. HTTP admission and all long-lived stream/upgrade ownership: stop new work first, define active-request cancellation/drain, and preserve the admin acknowledgment. Main `server.close()` alone is not an all-channel writer barrier.
2. Root error continuation and total budget: choose per-owner outcomes and a process-exit policy. Racing the existing teardown against a timeout does not cancel late work and cannot justify releasing the instance lock or closing the DB.
3. Database/lock/successor handoff: prove every relevant writer is quiescent before shared DB close and lock release. Decide reset/restart operation exclusivity and failed-cleanup behavior together.
4. Startup-wide rollback: inventory acquisitions, register closers immediately, reverse dependencies and account for direct exit paths. The workspace-only startup cleanup is not whole-root rollback.
5. Marketplace retention's listener and active/queued sweeps need their own disposal contract before root adoption.

This inventory supports a bounded workspace adoption claim only. It establishes no whole-server shutdown, restart, data-directory exclusivity, or rollback guarantee.

## Retention-specific evidence

# DOR-2429 bounded resource inventory

Read-only inspection at pinned base `5794f638160a68811382347356fd29b31ee2e911`, 2026-09-27, branch `codex/dor-2429-central-disposal`. No production or tracker writes by this inventory.

## Workspace owner: ready for narrow root adoption

- `apps/server/src/services/workspace/index.ts:54–82` constructs `WorkspaceReconciler(store)` and returns it. The only production factory call is `apps/server/src/index.ts:1583`; workspace-service integration tests use the same factory.
- Root destructures a block-local reconciler at `index.ts:1581`, starts it at `:1607`, and does not retain it for `shutdownServices` (`:5507`) or `start().catch` (`:5658`). The owner must be retained before calling start so later startup failures can find it.
- Merged `workspace-reconciler.ts` already provides passive construction, single pending pass, restartable stop, terminal generation fence, one stable disposal promise, explicit drained/timed-out outcome, 5-second default deadline, late rejection observation and synchronous cache-mutation fencing after awaited reads. No production class redesign is required for central adoption.
- `services/workspace/__tests__/workspace-reconciler-lifecycle.test.ts` proves these local contracts. The existing factory integration test is another seam for a real store and workspace owner without booting protected services.
- The merged spec intentionally records DOR-2428 as class-only and DOR-2429 as separately deferred. Selecting DOR-2429 now requires a new bounded adoption contract rather than assuming the old audit authorized an entire root rewrite.

## Recommended minimum slice

Retain the optional workspace reconciler in the root and invoke its terminal disposal before the first unrelated await in `shutdownServices`. Dispose fences admission and writes synchronously, so placing invocation after earlier potentially hanging closers would miss the intended guarantee. Await its bounded completion and explicitly warn on timed-out; retain its original outcome and reuse completion for concurrent shutdown callers. Keep existing non-workspace closer ordering unchanged and release the instance lock only after the workspace disposal outcome is known. A timed-out workspace read is safe from further cache writes because the class already fences both async read boundaries; do not call this IO cancellation.

Perform the same workspace cleanup when startup fails after acquisition. Capture the owner before start. No-owner / disabled workspace cleanup must be harmless. A failure in unrelated fixture cleanup must not prevent initiating the workspace fence, so initiate workspace disposal first and preserve the original startup error. Avoid introducing a general resource-registration framework for this one owner.

The shared signal/admin path matters: `shutdown()` has a signal-only boolean, but the admin router receives `shutdownServices` directly. Class disposal is already idempotent; choose explicitly whether this slice also coalesces the whole service sequence. If whole-sequence coalescing is selected, it changes a broader existing contract and needs independent failure/retry semantics and concurrent admin/signal tests. Do not accidentally claim whole-server idempotency merely because workspace disposal is stable.

## Meaningful verification for that slice

1. Use the real reconciler behind the production adoption seam. Start it, hold a checkout/manifest read, initiate shutdown, and prove the terminal fence fires before an unrelated deferred closer. Resolve the read; assert no cache write. Positive control must write before shutdown.
2. Prove the lock-release callback cannot run before the workspace disposal settles, including the exact 5-second timeout; then release the late read and assert zero writes. Assert the warning names timeout and is emitted once if wrapper coalescing promises that.
3. Two cleanup calls share completion, not merely call count, wherever the new contract promises it. No owner is a successful no-op. Already-drained owner allocates no timer.
4. Simulate startup acquisition followed by later startup failure. Prove the retained owner stops and its pending pass cannot write, original startup error survives, and an unrelated cleanup failure cannot skip initiating its fence.
5. If extracting a small production helper for executable testing, test that helper with the real reconciler plus controlled unrelated closer and lock callbacks, and separately verify root actually wires it into both paths. A source-text wiring assertion may supplement these tests; it is not proof that real root teardown executes. Mutation-check omitted adoption and reversed ordering so an inert helper cannot certify success.
6. Existing admin router tests inject `mockShutdownServices`, so they do not prove the real root. `session-pump-shutdown.integration.test.ts` has a shutdownServices describe title but calls `shutdownSessionPumps` directly; credit process cleanup evidence only, not root sequencing.

## Marketplace retention: separate lifecycle follow-on

- `PackageCacheRetention` is constructed at `index.ts:4744`, started at `:4753`, passed to the marketplace router at `:4821`, and otherwise remains local to startup. The other constructions are test fixtures.
- `package-cache-retention.ts:348–350` discards `MarketplaceCache.onEntryWritten`'s unsubscribe and immediately starts a background sweep. Duplicate starts create distinct subscriptions and repeat startup work. There is no stop/dispose API.
- `marketplace-cache.ts:602–607` stores callbacks in a Set and returns a synchronous delete closure. Existing `marketplace-cache.test.ts:727–755` exercises real cache entry notifications and unsubscribe with a positive control.
- Retention has a running pass and one coalesced queued pass (`sweep`, `:370–380`). Stopping the subscription alone leaves both admitted work and public manual `sweep()` requests active. The route calls sweep at `routes/marketplace.ts:1004` and reads status at `:975`.
- `sweepOnce`, `package-cache-retention.ts:444–451`, first asynchronously lists recorded installations, then awaits `cache.removeUnused`, then asynchronously rewrites project-install bookkeeping through `forgetProjectInstalls`.
- `marketplace-cache.ts:625–656` performs asynchronous `stat`, `rename`, directory-size reads and recursive `rm` during removal. Unlike workspace synchronous cache writes, an owner-level generation check before `removeUnused` cannot fence those internal late effects. Adding a short timeout and releasing the instance lock would falsely claim safety.
- Existing retention tests use a real filesystem/cache and cover scan failure preserving entries, pause/resume, project-record removal, startup sweep, cache-entry trigger, background failure and coalesced work. The deferred `removeUnused` test at `package-cache-retention.test.ts:500–533` is a ready seam for pending/queued drain tests.

Small independent follow-on: idempotent subscription ownership and explicit terminal admission/drain semantics, with no claim of bounded disposal unless cache mutation boundaries acquire their own cancellation protocol. Tests must trigger an actual entry before and after unsubscribe, hold both running and queued work, reject late manual requests, and prove what happens to already-started deletion/bookkeeping. Do not fold this storage-mutation design into workspace adoption.

## Other follow-ons remain distinct

Whole-server HTTP/upgrade admission, aggregate shutdown deadlines, per-step failure collection, lock release after all writers, whole-sequence concurrency and root-wide startup rollback are still broader design work. This workspace adoption can establish only the named owner's lifetime in the two root cleanup paths. It cannot certify Cloud/Community, sessions/rooms, marketplace retention or all server shutdown paths.

## Captured follow-ons

These are separate design/implementation decisions, not blockers or delivered guarantees of this workspace slice:

- [DOR-2481 — Design terminal request admission and exclusive reset/restart ownership](https://linear.app/dorkspace/issue/DOR-2481)
- [DOR-2482 — Design shutdown outcomes and safe database/lock handoff](https://linear.app/dorkspace/issue/DOR-2482)
- [DOR-2483 — Design root startup rollback that preserves the original failure](https://linear.app/dorkspace/issue/DOR-2483)
- [DOR-2484 — Own marketplace retention subscriptions and running sweeps](https://linear.app/dorkspace/issue/DOR-2484)
