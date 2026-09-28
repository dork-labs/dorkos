---
slug: central-workspace-disposal
number: 260928-001526
created: 2026-09-28
status: implemented
---

# Central adoption of workspace reconciliation disposal

**Status:** Implemented and independently reviewed; CI/delivery pending
**Work item:** DOR-2429 — Design safe central adoption of local resource disposal
**Baseline:** `5794f638160a68811382347356fd29b31ee2e911`

## Overview

Give the server root ownership of the already-proven WorkspaceReconciler lifetime. Deliver the broader design inventory but implement only workspace reconciliation adoption. No claim of whole-server shutdown safety follows from this change.

## Background / Problem Statement

The root starts a passive reconciler but retains no teardown reference. The class now supports terminal bounded disposal, yet ordinary shutdown and later startup failure never invoke it. A root reference alone also misses a signal received while startup is still awaiting an earlier step: the root can resume and start a timer after cleanup has begun.

The [ownership inventory](root-ownership.md) records the existing ordered teardown and its limits. Admin calls bypass the signal-only guard; HTTP admission remains open; many closers can reject or hang; database/lock handoff and startup rollback are incomplete across domains. These are follow-on decisions, not implied requirements to rewrite every owner here.

## Goals

- Retain the reconciler before timer acquisition and dispose it on ordinary cleanup and later startup failure.
- Close reconciler admission synchronously before any unrelated cleanup await.
- Refuse registration/start after terminal disposal, even if no resource existed when cleanup began.
- Join concurrent/repeated workspace disposal with one stable outcome and the existing five-second class deadline.
- Report timeout or failure honestly and preserve the original startup failure across workspace cleanup errors.
- Pin actual root wiring and test real reconciler behavior through the adopted owner.

## Non-Goals

No root-wide HTTP/stream admission policy, shared shutdown-sequence promise, admin reset/restart exclusivity, total server budget, database closure or lock-release redesign. No global startup rollback, retained marketplace sweep disposal, fatal exception policy, Cloud/Community/auth/runtime changes, shared contracts, UI, CI or dependency changes. No real SDK turns or paid inference. Do not infer filesystem cancellation from a drain timeout.

## Technical Dependencies

Use the existing WorkspaceReconciler and WorkspaceDisposeResult, logger, Vitest fake timers, and TypeScript parser already in the repository. Introduce no dependency. Honor the file-first derived-cache authority from ADR-0043.

## Detailed Design

### Workspace-specific lifetime owner

Place a small `WorkspaceReconcilerLifecycle` beside the reconciler and export it through the workspace barrel. Construct it at module scope in `index.ts`; construction is passive.

`start(reconciler)` rejects once terminal disposal has begun. It stores the reference before calling the class's `start()`, so a thrown timer-acquisition/start error does not make the owner unreachable. It must never silently replace a previously owned reconciler. The implementation should choose the simplest one-owner semantics and test them.

`dispose()` is non-async at its outer boundary, closes admission immediately, and invokes the real class's `dispose()` synchronously before returning. Memoize one promise for concurrent/repeated calls, including an owner with no resource. Preserve the class's `drained` versus `timed-out` outcome and its five-second default; do not add a second racing deadline. Timeout means the class has fenced late writes, not that its filesystem read was canceled.

Report a timed-out result once through the existing logger. An unexpected throw/rejection is a failed disposal, never a drained result; keep the failure observable and stable for all callers. Ordinary root shutdown remains fail-fast on such an unexpected failure, so this slice cannot accidentally make the later lock handoff look safe. No broad cleanup-continuation promise is introduced. During startup failure, log any disposal failure and preserve/report the original startup error rather than replacing it. A tiny tested failure-cleanup seam is acceptable if needed; do not extract the entire bootstrap to test one owner.

### Root placement

Only these central sections are selected:

1. Workspace import and one module-scope lifecycle owner.
2. Workspace bootstrap: replace direct `workspaceReconciler.start()` with owner registration/start. Leave manager registration, workspace configuration and allocation semantics intact.
3. `shutdownServices`: disposal is the first operation, before account flush or any other awaited closer. Await the same bounded owner completion before existing teardown continues. Thus a later unrelated closer cannot prevent this owner's fence/drain.
4. `start().catch`: dispose first, contain only its cleanup failure, then retain current fixture cleanup and original error reporting/exit behavior. This guarantees that workspace disposal failure cannot replace the original error; unchanged fixture cleanup can still reject before reporting it, and whole-startup error preservation remains a follow-on. A failure before workspace construction terminally closes its admission too.

Preserve every other closer's relative order, Cloud/Community composition, root lock release, admin behavior and HTTP listener handling. Correct any existing comment in an edited section that implies all writers are already proven quiescent.

### Data and APIs

No HTTP API, configuration, schema or shared interface changes. The lifecycle owner is internal server composition. No cache rows or checkouts are deleted as cleanup; only the existing reconciler applies its established cache reconciliation policy.

## User Experience

No new interface or command. The workspace background check now participates in root teardown instead of outliving that boundary. Internal logs distinguish a drained pass, deadline expiry and failed cleanup. Do not describe this as a complete server restart/shutdown fix.

## Testing Strategy

Behavioral tests use the real owner and real reconciler, narrow fake stores, controlled checkout/manifest reads and fake timers. Each has a failure-detecting purpose:

- Passive/disabled ownership; disposal before registration; rejected late startup starts zero timers.
- Reference retained when start fails; later cleanup reaches that resource.
- A pending checkout read and manifest read cannot mutate after root-owned disposal, with positive non-disposed controls that do write.
- Disposal fences before another cleanup step can await; no pending reconciler write can land while that later step hangs.
- Drained and exact five-second timed-out outcomes, stable promise identity and one report; eventual rejection is observed.
- Concurrent shutdown/startup-failure cleanup joins the same workspace disposal.
- Unexpected disposal error stays failed; startup error identity survives cleanup failure.

A small AST wiring test must parse actual `index.ts`: the root owns the helper, bootstrap goes through it, and ordinary cleanup unconditionally awaits disposal on that same module-scope owner before any unrelated operation or await, propagating rejection. Startup failure awaits the same owner before unrelated cleanup and contains only its disposal failure. Avoid regex-only matches or assertions in a comment. Independently remove the root call, remove its await, and move it behind another await; each mutation must fail the wiring test. This is structural wiring evidence, not full server boot/exit proof.

Mutation controls should remove the sticky terminal admission guard and the root cleanup call independently, produce their intended failures, restore exact source, and pass again. Existing class late-write/overlap mutations remain evidence; do not repeat broad tests without a changed concern.

Run focused lifecycle/wiring and adjacent workspace tests, server typecheck/lint, then the appropriate affected gate. No arbitrary sleeps, paid inference or unrelated fixtures.

## Performance Considerations

One small lifetime object and memoized disposal promise. Preserve the five-minute reconciliation cadence. This owner adds at most the existing five-second drain to visited shutdown/startup-failure cleanup; no bound is claimed for the rest of the server.

## Security Considerations

Preserve all authorization, reset-token, data-directory, Cloud/Community and runtime boundaries. A timed-out real reconciler is fenced; an unexpected failed disposal must not be called safe. Existing other-writer/lock-handoff limitations remain explicit.

## Documentation

Commit the current ownership inventory, design decisions, task plan, verification receipt and scoped follow-on issue pointers. Link this spec from the earlier local pilot without rewriting its historical non-goals. Add a narrowly worded changelog only for the behavior delivered.

## Implementation Phases

1. Inventory and independent design critique; coordinate central sections with Cloud/Community owners.
2. Implement only the sticky workspace owner, root adoption and meaningful tests.
3. Verify/mutate, independently review pushed branch against REVIEW.md, converge, open PR, pass normal queue, close delivery and clean up safely.
4. Separate follow-ons: admission and request-level terminal coordination; all-owner error/budget/DB-lock policy and startup rollback; marketplace retention subscription/active-sweep lifetime. These are captured, not implemented by this phase.

## Open Questions

- ~~Whole-root disposal framework now?~~ **Resolved:** no; one proven local owner, because other domains lack cancellation/drain contracts.
- ~~Nullable reference or sticky owner?~~ **Resolved:** sticky owner is needed to reject startup that resumes after terminal cleanup. Independent review must still challenge its implementation complexity.
- ~~Failure continuation?~~ **Resolved:** ordinary cleanup retains failure; startup cleanup preserves the original startup error. Global best-effort continuation is a follow-on requiring lock/DB safety decisions.

## Related ADRs

ADR-0043 preserves file-canonical cache authority. No new ADR is warranted for a bounded local ownership helper; this establishes no repo-wide lifecycle framework.

## References

- [Class-local pilot](../local-workspace-lifecycle/02-specification.md)
- [Ownership inventory](root-ownership.md)
- DOR-2429; DOR-2428 / PR #2226; architecture coordination DOR-2344.

## Captured follow-ons

These are separate design/implementation decisions, not blockers or delivered guarantees of this workspace slice:

- [DOR-2481 — Design terminal request admission and exclusive reset/restart ownership](https://linear.app/dorkspace/issue/DOR-2481)
- [DOR-2482 — Design shutdown outcomes and safe database/lock handoff](https://linear.app/dorkspace/issue/DOR-2482)
- [DOR-2483 — Design root startup rollback that preserves the original failure](https://linear.app/dorkspace/issue/DOR-2483)
- [DOR-2484 — Own marketplace retention subscriptions and running sweeps](https://linear.app/dorkspace/issue/DOR-2484)
