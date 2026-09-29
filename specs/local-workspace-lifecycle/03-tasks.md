# DOR-2428 implementation tasks

The user selected the class-local pilot on 2026-09-27 after the completed DOR-2347 design review. This full decomposition implements that selection; older deferred wording in the design records is historical. Central adoption (DOR-2429) remains deferred.

Canonical task source: [03-tasks.json](03-tasks.json). All tasks remain checklist-only on DOR-2428; no subissues.

## Phase 1: Class-local pilot

Critical path: 1.1 → 1.2 → 1.3. One production-file writer; implementation and proof are developed together, with verification and delivery following restored green tests.

### Task 1.1: Implement serialized reconciliation and bounded terminal disposal

Size: medium. Priority: high. Dependencies: none.

Implement DOR-2428 only in apps/server/src/services/workspace/workspace-reconciler.ts, with focused adjacent tests permitted. Preserve the existing constructor's store and optional cadence arguments, WorkspaceReconcileResult synced/removed counts, five-minute default cadence, file-first manifest authority, missing-checkout row removal and manifest-versus-row comparison. An optional class-local options argument may inject a named 5,000 ms disposal deadline and timer boundary; add no dependency, config, schema or shared interface.

Construction must perform no timer acquisition, read or write. start() acquires one interval and is idempotent while running; stop() synchronously clears the interval, is restartable, and does not promise to drain pending work. If timer acquisition or unref fails, clear an acquired handle, retain stopped state, and permit a valid later start. Terminal disposal refuses subsequent start() with an explicit misuse error.

Track at most one reconcile pass. Scheduled ticks skip pending work; concurrent manual reconcile() calls join the pending pass. Manual reconciliation remains allowed while stopped and is refused when disposal starts. Preserve the existing scheduled reconciliation error logger path without duplicate observation; clear tracked ownership on rejection so a later running pass recovers.

Add dispose() returning one stored promise for concurrent and repeated callers. On its first call, mark terminal, stop the interval and invalidate write generation before awaiting work. Check generation and terminal state before a pass and after each asynchronous checkoutExists/readManifest read before synchronous removeRow/upsertRow. Disposal must prevent late writes even when IO resolves after timeout; completed writes are not rolled back.

Resolve disposal with { status: 'drained' } when no work remains, including a failed pass whose error has been observed, or { status: 'timed-out' } at the injectable deadline. Idle disposal allocates no deadline timer. Drain-before-deadline clears its timeout. Timeout does not cancel IO: observe eventual rejection, fence eventual writes, and keep the original disposal outcome on repeated calls.

Do not edit root index.ts, workspace composition, workspace allocation/deletion policy, runtimes/transport, sessions/rooms, Cloud/Community, auth, UI or CI. This class-only change establishes no server-wide shutdown guarantee. DOR-2429 remains separately deferred.

### Task 1.2: Prove lifecycle races, recovery and unchanged cache semantics

Size: medium. Priority: high. Dependencies: 1.1.

Add focused tests adjacent to WorkspaceReconciler using the real class, fake timers, deferred checkout/manifest reads and a real or narrowly faked WorkspaceStore boundary. No arbitrary sleeps, server boot, SDK turns, paid inference, deployment or shared harness changes.

Prove passive construction; default five-minute cadence; duplicate start owns one interval; an actual pass occurs before stop; no new scheduled pass after stop; manual reconcile while stopped; stop/start resumes one timer without overlapping a prior pending pass. Hold a checkout read across multiple ticks and a manual call: assert exact pass/read counts, joined completion, no overlapping writer, then release it and prove a later tick runs.

For both checkout and manifest reads, dispose while pending, release afterward and assert exact zero late removeRow/upsertRow calls. Positive controls with the same rows/reads and no disposal must perform the intended removal/upsert and report exact counts. Cover unchanged/missing manifest behavior and completed pre-disposal writes so lifetime disposal cannot be mistaken for rollback.

Test idle disposal creates no deadline timer; a pending drain clears its timer; the result remains pending immediately before the exact default/injected deadline and becomes timed-out exactly at it. Late read resolution cannot write. Concurrent and repeated dispose calls must return the same promise and stable original outcome, including after late completion. No repeated cleanup or post-terminal admission is allowed.

Inject reconciliation rejection: verify one error observation for scheduled work, tracked ownership clears and a subsequent pass succeeds. Reject pending work after disposal timeout and prove it is observed without an unhandled rejection. Inject timer acquisition failure and unref failure separately; assert an acquired handle is cleared, stopped state survives and retry starts one valid interval.

First run the unmutated focused suite green with nonzero tests. Temporarily remove the late-write fence and prove the dedicated late-write test fails for its intended cache mutation. Restore it; temporarily remove overlap tracking and prove the overlap test fails for the intended extra pass. Restore implementation and rerun green. Keep mutation evidence in the verification receipt, never leave mutant code committed.

### Task 1.3: Verify and deliver the selected pilot without central adoption

Size: medium. Priority: high. Dependencies: 1.2.

Run focused reconciler and applicable workspace tests, server typecheck/lint and required affected project gates. Inspect actual output before success claims; fix task defects, diagnose stale dependencies separately, and avoid gratuitous full suites unless overlap or a concrete concern requires them. Record exact commands, counts, mutation failures and restored green results in specs/local-workspace-lifecycle/04-verification.md.

Update necessary Flow spec/status artifacts and release documentation to record that DOR-2428 was explicitly selected after completed DOR-2347 design review and delivered as a class-only pilot. Keep the historical audit baseline distinguishable from implementation evidence. State clearly that the server root still does not call dispose(), so this change does not prove server-wide restart/shutdown safety. DOR-2429 central adoption and marketplace DOR-2340/DOR-2341 remain deferred; DOR-2344 coordination stays open. No subissues are needed: all three tasks remain checklist entries on DOR-2428.

Follow the current creating-pull-requests workflow: review the pushed branch independently under REVIEW.md before opening a PR, resolve factual findings, provide the appropriate changelog/release fragment, attach the PR, address automated findings, and monitor required checks and the merge queue through actual merge without bypass. Tracker I/O uses only the resolved Flow adapter/account/team. Close DOR-2428 only after its actual bounded scope is complete.

All file writes stay in this isolated worktree. After merge and tracker closeout, inspect task artifacts and active processes and archive only task-owned eligible managed worktrees with the supported archive tool. Never alter the prior task's e247 checkout. If a managed checkout is not registered/exposed, preserve its clean merged state and record exact path, branch, evidence and cleanup revisit condition rather than shell-deleting it or creating a replacement. Send substantive decisions/blockers and final closeout to the authorized architecture coordination chat.
