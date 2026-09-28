---
slug: local-workspace-lifecycle
number: 260926-193136
created: 2026-09-26
status: implemented
---

# Local workspace reconciler lifecycle pilot

**Status:** Class-local pilot implemented under DOR-2428 on 2026-09-27 after design review. Central adoption remains deferred.
**Design delivery:** [DOR-2347](https://linear.app/dorkspace/issue/DOR-2347) - Shape a bounded server lifecycle ownership pilot.
**Audit baseline:** `7168a5b7c69def16bb2cb48319b24285c9894a3f`, 2026-09-26. Paths and line numbers below refer to this revision.

## Overview

Make one local resource owner capable of stopping admission, tracking work and reporting bounded disposal. Prove the class contract before considering wider server adoption. The original document and ownership map completed the DOR-2347 shaping deliverable. DOR-2428 now implements the bounded class contract, with evidence recorded separately below the historical audit receipt.

## Background / Problem Statement

`WorkspaceReconciler.start()` owns an unref'd interval and `stop()` clears it. Each tick starts an async `reconcile()` without tracking it; a slow pass can overlap the next tick. Clearing the interval does not stop a pass already awaiting `checkoutExists` or `readManifest` from later writing the cache. The root starts this reconciler but does not retain it for teardown.

These are source-backed gaps, not a reproduced production data-loss incident. Existing central cleanup must be credited: `index.ts:5206–5303` defines ordered `shutdownServices`; `:5306–5316` guards concurrent SIGINT/SIGTERM entry. Neither implies every subsystem has a complete lifecycle contract.

## Goals

- Document construction, start and stop owners, including the limits of current proof.
- Specify one class-local pilot with passive construction, serialized work, restartable timer stop and terminal bounded disposal.
- Make partial-start failure, late completion and concurrent disposal observable in focused lifecycle tests.
- Keep adoption into the central shutdown sequence separate and explicit.

## Non-Goals

No changes to `index.ts`, shared runtime/transport interfaces, Cloud/Community, authentication, Connections, runtime/session/room behavior, UI, CI, workspace allocation/deletion policy or database schema. No dependency-injection framework, wholesale startup rewrite, paid inference or live deployment. DOR-2064/DOR-2065, DOR-2346 and DOR-2136 are not absorbed.

## Current Ownership Map

Paths other than `index.ts` are relative to `apps/server/src/`. This is a map of the root's major resource families and pilot candidates, not a claim that every hidden SDK handle has been inventoried. Protected domains are named only to preserve the scope boundary.

| Resource                               | Construction / start owner                                               | Disposal owner and order                                                                        | Evidence limit                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Instance lock                          | `index.ts:799`, `acquireInstanceLock`                                    | `index.ts:5301`, released last and reference cleared                                            | Later than all prior awaited closes; a rejection/hang can prevent release.                                                                                                                             |
| Consolidated database                  | `index.ts:894`, `createDb`                                               | No corresponding explicit close in `shutdownServices`                                           | Process exit does not prove closure before lock release.                                                                                                                                               |
| HTTP listener and upgrade handler      | `index.ts:4950,4958`                                                     | Listener not closed by `shutdownServices`                                                       | Admission stop/request drain is not established by this sequence.                                                                                                                                      |
| Workspace reconciler                   | `services/workspace/index.ts:54–82`; root starts at `index.ts:1455–1480` | Class `stop()` clears interval; root retains no shutdown reference                              | Unref prevents keeping the process alive; it does not drain writes. Selected pilot.                                                                                                                    |
| Search indexer                         | `index.ts:1907–1908`                                                     | `index.ts:5279`; class stops timer                                                              | Existing sweep overlap guard, no drain established by timer stop.                                                                                                                                      |
| Relay, messaging runtimes, trace store | `index.ts:1955–1965,2337,2451`                                           | `index.ts:5253–5264`: adapter manager, RelayCore, then trace store                              | Dependency-aware order already exists. No aggregate deadline or per-step catch here.                                                                                                                   |
| Mesh reconciliation                    | `index.ts:2008,2218`                                                     | `index.ts:5282–5285`: periodic stop then close                                                  | Explicit order; not a whole-server deadline.                                                                                                                                                           |
| Task scheduler                         | `index.ts:3420,5061`                                                     | `index.ts:5250`; `services/tasks/task-scheduler-service.ts:622–652`                             | Stops registration/timers/jobs, aborts direct runs, asks relay runs to stop, then waits. Its 30-second direct-run wait occurs after awaited `stopRelayRuns`; do not call total stop 30-second bounded. |
| Task watcher/reconciler                | `index.ts:3490,3496,3582`                                                | `index.ts:5266–5271`: watcher then reconciler                                                   | Scheduler clears started state before its awaits, guarding new registrations during stop.                                                                                                              |
| Skills watcher/turn-end subscription   | `index.ts:3603–3608`                                                     | `index.ts:5273–5277`: unsubscribe trigger first, then watcher                                   | Watcher clears interval/debounce handles, closes watchers and awaits projections; no timeout.                                                                                                          |
| Session-list broadcaster               | `index.ts:3810`                                                          | `index.ts:5249`; `services/session/session-list-broadcaster.ts:395–415`                         | Unsubscribes even after failed watcher startup; all-settled iterator close. No timeout; comment alone does not prove concurrent stop completion.                                                       |
| Marketplace cache retention            | `index.ts:4459–4467`                                                     | `services/marketplace/package-cache-retention.ts:348–350` starts sweep/listener; no stop method | Cache returns unsubscribe (`marketplace-cache.ts:602–605`), but retention discards it. Separate follow-up.                                                                                             |
| Terminal PTYs / preview listeners      | `index.ts:4621` and root registry                                        | `index.ts:5238–5240`: destroy PTYs, await preview close                                         | Explicit cleanup ownership; no global bound.                                                                                                                                                           |
| Root housekeeping intervals            | `index.ts:5068,5092,5107,5141,5149`                                      | `index.ts:5218–5231` clears handles                                                             | Timer removal does not drain in-flight callbacks; attachment sweep is fire-and-forget.                                                                                                                 |
| Runtime children                       | `index.ts:1334,1369,1413`                                                | `index.ts:5288–5292`: managed sidecar, then warm pumps                                          | Protected adjacent DOR-2064/DOR-2065; no redesign here.                                                                                                                                                |
| Protected service families             | Cloud, Community and Connections composition                             | Existing root cleanup calls remain unchanged                                                    | No contract, auth or deployment conclusions in this audit.                                                                                                                                             |

### Root-level guarantees and unknowns

The signal guard wraps `shutdown()`. The admin router receives `shutdownServices` directly (`index.ts:4302`); whole-sequence idempotency is not established by that signal guard. A rejecting or never-settling awaited closer can prevent later cleanup. There is no aggregate deadline or best-effort continuation in the inspected function.

Startup rollback is selective: `start().catch` (`index.ts:5347`) closes the offline fixture, logs and exits. It does not invoke a reverse resource stack or the general teardown function. Fatal exceptions are a separate path that flushes a crash report and exits (`:5321–5334`). Neither proves ordinary cleanup ran.

These findings require central lifecycle decisions before any root changes: stop admission first; define shared-call idempotency; decide failure collection vs fail-fast behavior; select a total budget; ensure writers have stopped before lock release; and define startup rollback order. This specification does not make those protected decisions on their owners' behalf.

## Technical Dependencies

Use the existing `WorkspaceStore`, `WorkspaceService`, logger, Node timers and Vitest. Add no package or shared interface. Relevant ADRs: file-first derived state [ADR-0043](../../decisions/0043-file-canonical-source-of-truth-for-mesh-registry.md) and the existing workspace implementation's own contracts. The pilot does not alter storage authority.

## Detailed Design

Implementation is confined to `apps/server/src/services/workspace/workspace-reconciler.ts` and a dedicated adjacent lifecycle test. Preserve the existing constructor call shape and `WorkspaceReconcileResult` counts. An optional internal options argument can supply the disposal timeout and testable timer boundary without a new user setting.

### State and admission

1. Construction is passive: no timer, read or write.
2. `start()` owns one interval. Duplicate start is a no-op. A stopped owner may start again; a terminally disposed owner may not (throw an explicit internal misuse error).
3. One tracked pass may run at a time. A scheduled tick skips if a pass is pending. Public `reconcile()` calls join that same pending pass rather than creating a second writer. A manually requested pass remains allowed while stopped, preserving current use, but is rejected once disposal starts.
4. `stop()` remains synchronous and restartable: clear the periodic interval and prevent later scheduled ticks. It does not claim to drain an already-started pass. `dispose()` is the terminal operation for that stronger contract.

### Terminal disposal and late writes

`dispose()` returns one stored promise/result to concurrent and repeated callers. Its first call marks the owner terminal, stops the interval and invalidates the current write generation before awaiting tracked work. Before each pass and after every async read, check the generation and terminal state before the next store mutation. Store writes are synchronous today; if that changes, this guarantee must be redesigned rather than inferred from a pre-await check.

Use a named default disposal deadline of 5,000 ms, injectable for tests. This is the proposed class-local budget, not a server shutdown budget. Clear its timeout handle when the pass settles first. Return an explicit `{ status: 'drained' }` or `{ status: 'timed-out' }` outcome. Repeated disposal returns the original outcome even if a timed-out read later resolves. A timeout cannot cancel filesystem IO; generation checks must prevent the late completion from reaching `removeRow` or `upsertRow`. Observe eventual rejection so a timed-out promise cannot become an unhandled rejection.

If no pass is pending, disposal resolves drained without allocating a deadline timer. If a pass fails while disposing, preserve the existing error observation and report drained once no work remains; a logged reconciliation failure is not a successful reconciliation. Disposal concerns resource lifetime, not a rollback of completed cache writes.

### Partial-start failure

If timer acquisition or unref setup fails, clear any acquired handle, leave the owner stopped and allow a later valid start. A passive constructor has no filesystem/DB side effects to roll back. No failed startup may publish a live interval that the owner no longer tracks.

### Data and interface boundaries

Do not change manifest comparison, missing-checkout handling or cache row semantics. No HTTP API, configuration, schema or shared interface changes. Do not edit root composition to call disposal in this pilot. That adoption requires the separately coordinated follow-up; until then the pilot is a reusable local guarantee only.

## User Experience

This design adds no UI or user-facing command. Future root adoption can make restarts more predictable, but this class-only pilot must not be announced as fixing server restart or shutdown. Reconciliation errors keep the existing logger path. A timeout is explicit to the caller rather than disguised as successful closure.

## Testing Strategy

Credit existing tests before adding any: session-list broadcaster startup retry/iterator return/stop-start tests; search-indexer timer stop and `sweep-guard` overlap tests; scheduler started/stopped, relay-stop and pruning tests; skills-watcher turn-end unsubscription; marketplace cache-retention trigger tests. Admin route tests mock shutdown and do not prove the real root sequence. No dedicated workspace reconciler lifecycle suite was found at this baseline.

Tests belong beside workspace tests and use fake timers, deferred reads and a real or narrowly faked store boundary. No arbitrary sleeps, server boot, SDK turn or shared harness change.

| Injected condition                                          | Required assertion / positive control                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Construct, duplicate start, stop/start                      | Zero construction work; one timer; a real pass occurs before stop; no new tick after stop; one timer after restart.          |
| Checkout read pending across multiple ticks and manual call | One tracked pass, no overlap, manual caller joins it. Release read and prove a later tick can run.                           |
| Dispose during checkout read or manifest read               | Release the read afterward; exact zero late `removeRow`/`upsertRow` calls, with non-disposed controls that do write.         |
| Read never settles before deadline                          | Fake clock reaches exact deadline; result is timed-out; late resolution still cannot write. No orphan deadline timer.        |
| Concurrent/repeated dispose                                 | Same completion promise and stable outcome; no repeated cleanup or new work admitted.                                        |
| Reconcile rejection                                         | One observed error; tracked ownership clears; next pass can recover while running. Late rejection after timeout is observed. |
| Timer or unref acquisition failure                          | Newly acquired handle cleared; stopped state retained; retry start succeeds without duplicate interval.                      |

When implemented, perform a targeted red/green mutation check: remove the generation fence and show the late-write test fails for the intended write. Remove overlap tracking and show the pending-pass test fails. No test should certify absence merely by observing zero subjects.

## Performance Considerations

Keep the existing five-minute cadence and one-pass memory footprint. Coalesce concurrent requests rather than queueing unbounded ticks. Deadline handling allocates at most one timeout per terminal disposal with pending work.

## Security Considerations

No auth, path-boundary or file authority changes. Never delete a checkout as cleanup. A timeout is not cancellation; the write fence prevents stale cache writes, not arbitrary filesystem activity or external effects.

## Documentation

Keep the ownership map and validation receipt with this spec. Future implementation must state class-only adoption limits. Root adoption must update its own ownership record and test real composition before claiming server-wide guarantees.

## Implementation Phases and Dispositions

1. **Design delivery, completed 2026-09-26:** audit, ideation, specification, independent review and merged documentation in PR #2160. DOR-2347 completed as shaping only; the manifest remained `specified` at that point.
2. **Local pilot, implemented ([DOR-2428](https://linear.app/dorkspace/issue/DOR-2428)):** explicitly selected by the operator on 2026-09-27 after the design merged. The [task plan](03-tasks.md) covers only the class, focused tests and delivery artifacts. [Implementation evidence](04-verification.md#class-local-pilot-verification) does not establish root adoption.
3. **Central adoption, deferred ([DOR-2429](https://linear.app/dorkspace/issue/DOR-2429)):** coordinate after overlapping root changes (open PRs #2117, #2118 and #2158 at audit) settle. Retain the reconciler at the root and design stop/admission/error/deadline/lock-release ordering together; this cannot be slipped into the class pilot.
4. **Other ownership gaps, deferred:** marketplace retention listener disposal and root-wide partial-start rollback remain in the DOR-2429 design inventory. Revisit individually with owning domains, without expanding into protected services.

## Open Questions

No unresolved question blocks the class-local design. Wider root admission, total budget, error policy and protected-domain adoption remain unselected design work, not hidden requirements of this pilot.

## Related ADRs

No new ADR is extracted: this specification proposes a bounded experiment and makes no repo-wide framework decision. Apply the ADR significance rubric after implementation evidence supports broader adoption.

## References

- [Local verification receipt](04-verification.md)

- [Architecture roadmap](../../plans/architecture-improvement-roadmap.md)
- [Ideation](01-ideation.md)
- [Workspace reconciler source](../../apps/server/src/services/workspace/workspace-reconciler.ts)
- [Warm-process lifecycle specification](../warm-process-lifecycle/02-specification.md)
- [Local marketplace recovery evidence](../../research/20260926-local-marketplace-recovery-evidence.md)

## Central adoption follow-up

DOR-2429 selects the separate [central workspace disposal](../central-workspace-disposal/02-specification.md) slice. The class-local pilot above remains its historical scope; the new specification covers root ownership and its evidence limits.
