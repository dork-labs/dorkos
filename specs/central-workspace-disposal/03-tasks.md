# DOR-2429 implementation tasks

Canonical source: [03-tasks.json](03-tasks.json). Full decomposition of the frozen, independently reviewed [specification](02-specification.md).

## Phase 1: Bounded workspace adoption

Three checklist-only tasks; no promoted subissues. Critical path: 1.1 → 1.2 → 1.3. Use one implementation worker because all tasks share the workspace owner, root wiring and evidence. The built-in Task API is unavailable; JSON remains canonical, with tracker projection handled by the parent.

The first two tasks should be developed incrementally with their focused tests. Finish by checking mutation sensitivity, required gates and delivery. No installs/builds are authorized by decomposition given the shared disk constraint.

### Task 1.1: Implement and prove the sticky workspace lifetime owner

Size: medium. Priority: high. Dependencies: none.

Add a passive WorkspaceReconcilerLifecycle beside apps/server/src/services/workspace/workspace-reconciler.ts and export it through the workspace barrel. Use the existing WorkspaceReconciler, WorkspaceDisposeResult, logger and five-second class-local deadline; add no dependency or second timeout. Keep implementation with one worker because the owner, tests and root wiring share files.

start(reconciler) must refuse registration once terminal disposal begins, including disposal before a resource exists. Store the reference before calling reconciler.start() so a timer/start failure leaves the owner reachable for cleanup. Never silently replace an already owned reconciler; choose and test the simplest one-owner semantics.

dispose() must have a non-async outer boundary: synchronously close admission and invoke the real reconciler's disposal before returning. Memoize one promise and stable drained/timed-out outcome for concurrent and repeated callers, including an empty owner. Reuse the class's existing deadline and late-write fence. Report timed-out once through the logger; a deadline is not cancellation. Unexpected synchronous throw or rejection must remain a stable observable failure, never a drained result. Provide a small tested startup-failure cleanup seam only if necessary to log this disposal failure while retaining the original startup error.

Test the real owner and real reconciler with narrow fake stores, deferred checkout/manifest reads and fake timers. Prove passive and empty-owner behavior, disposal before registration rejecting late start with zero acquired timers, duplicate/replacement semantics, retained ownership after failed start, stable disposal promise identity, immediate write fencing, drain and exact five-second timeout, one timeout report, observed eventual rejection, concurrent cleanup joins and failed disposal preservation. Positive controls with no disposal must perform the intended cache writes. Do not rewrite the existing class or change its file-first semantics and five-minute cadence.

### Task 1.2: Adopt the owner in both root cleanup paths and pin actual wiring

Size: medium. Priority: high. Dependencies: 1.1.

Adopt WorkspaceReconcilerLifecycle only in the selected sections of apps/server/src/index.ts: workspace import, one passive module-scope owner, workspace bootstrap, shutdownServices entry and start().catch entry. Replace direct workspaceReconciler.start() with owner registration/start, retaining the reference before timer acquisition. Leave manager registration, configuration and allocation behavior intact.

Make await owner.dispose() the unconditional first operation in shutdownServices, before logging, account flush or any unrelated operation/await, and propagate unexpected disposal rejection. This fences synchronously and awaits the same bounded owner completion before existing teardown continues. Preserve every other closer's relative order and existing fail-fast behavior; do not introduce whole-sequence idempotency, a global timeout or cleanup continuation.

In start().catch, await the same owner before unrelated cleanup and contain only its disposal failure so that failure cannot replace the original startup error. Retain existing fixture cleanup and error reporting/exit behavior afterward. Unchanged fixture cleanup may still fail before reporting: do not claim preservation across every startup cleanup failure. Cleanup before workspace construction must still terminally close workspace admission. Correct an edited comment that falsely asserts all writers are quiescent without changing lock release behavior.

Add a focused AST wiring test using the installed TypeScript parser. Parse actual index.ts and verify that bootstrap and both cleanup paths use the same module-scope owner; ordinary cleanup unconditionally awaits disposal before any unrelated operation, with rejection propagation; startup failure awaits it first and contains only its disposal failure. Do not certify wiring with regex/comment matches. Execute owner/reconciler tests proving the fence is already active when a later cleanup step hangs, concurrent ordinary/startup cleanup joins the same completion, and original startup error identity survives workspace disposal failure. Clearly label AST evidence as structural wiring, not full server boot/exit proof.

Do not change Cloud/Community, authentication, runtime/transport, HTTP admission/listener handling, admin reset/restart exclusivity, schema/config, database closure, lock-release ordering, marketplace retention or CI. No broad startup extraction or lifecycle framework.

### Task 1.3: Verify mutation controls and deliver the scoped adoption

Size: medium. Priority: high. Dependencies: 1.2.

Verify the central-workspace-disposal delivery with focused new owner/wiring tests, adjacent workspace tests, server typecheck/lint and the appropriate affected gate. Inspect actual output before recording success. Shared disk space was approximately 1.1 GiB at decomposition; this task is not authorization to install dependencies or build broad packages. Use existing dependencies and coordinate a concrete prerequisite if required rather than consuming disk with speculative installs/builds.

Start mutation controls from a green suite with nonzero collected tests. Independently remove the sticky terminal-admission guard and prove the late-start test fails for an acquired timer or accepted owner. Independently remove the root disposal call, remove its await, and move it behind another await; every mutation must fail the AST wiring test for the intended missing/incorrect ordering. Restore exact source after every mutant and rerun green. Credit existing class late-write/overlap mutation evidence without repeating those unchanged concerns. No arbitrary sleeps, paid inference, real SDK turns or unrelated fixtures.

Record exact tests/counts, commands, intended mutation failures, restored green output and evidence limits in 04-verification.md. Commit the reviewed ownership inventory, scoped decisions, task plan and existing follow-on pointers. Link this central-adoption spec from the earlier pilot without rewriting historical non-goals. Add a narrowly worded changelog describing only workspace background reconciliation participating in root cleanup. No claim of complete shutdown/restart safety, canceled IO, all-writer quiescence or an aggregate server deadline.

Complete the current creating-pull-requests workflow: independently review the pushed branch under REVIEW.md before PR creation, converge on factual findings, attach the PR, resolve automated findings and pass the normal merge queue without bypass. Parent handles tracker projection through the resolved Flow adapter, closure only when actual DOR-2429 scope is delivered, and final coordination. Follow-ons for request admission/concurrency, all-owner error/budget/DB-lock/startup rollback and marketplace retention remain distinct; DOR-2344 stays open. After actual merge, inspect task-owned worktrees/processes and use supported archive cleanup only when eligible, preserving and reporting any registration limitation.
