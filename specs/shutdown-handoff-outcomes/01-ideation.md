---
slug: shutdown-handoff-outcomes
number: 260929-140932
created: 2026-09-29
status: ideation
---

# Design shutdown outcomes and resource handoff

**Work item:** DOR-2482. Design only; source implementation remains unselected.
**Initial audit base:** `50bb34cb34b8fff8807a0f2663ca2005e1ec154f`.
**Initial publication source:** `a874ad85f0d87c09ad4b4e38cf3110af198ffb87`
**Refreshed merged source:** `db220fef4c096643b9292c5c9e803f59459ee001`.
**Admission delivery:** [PR #2338](https://github.com/dork-labs/dorkos/pull/2338), merged 2026-09-29T14:04:54Z as `a874ad85f0d87c09ad4b4e38cf3110af198ffb87`.

## Intent and assumptions

Define when shutdown evidence permits closing a database, deleting reset data, releasing instance authority, launching a successor and exiting the old process. Preserve DOR-2429's bounded workspace write-fence guarantee and DOR-2551's admission-only exclusions. Acknowledgment, transport closure and timeout must not stand in for actual writer quiescence.

Under the operator's autonomous design authority, choose a proposed 30-second observation budget and fail-closed destructive handoff. This is a concrete reviewable default, not a measured shutdown SLO: when evidence is incomplete, keep terminal admission and required live resources held. Availability may remain interrupted until operator recovery. The budget limits first-decision observation, never forces drain or exit.

## Pre-reading and evidence

- Current root cleanup and concrete owner methods: [source census](root-ownership.md), with post-admission source revalidation.
- [Proposed contract](02-specification.md), including split-or-withhold composite closers and exact action permissions.
- Existing `specs/central-workspace-disposal/02-specification.md` and its receipt: one class-local fence adopted at root, not all-writer completion.
- Existing `specs/terminal-request-admission/02-specification.md` and ADR `260928-130908`: separate admission and exclusive terminal operation protocols.
- `apps/server/src/lib/instance-lock.ts`: authority is a JSON claim inside dorkHome, so recursive reset removal also removes the claim.
- REVIEW.md: positive controls, mutation sensitivity and recovery failures must be tested through real boundaries.

## Problem and codebase map

Root teardown combines timer stops, abort requests, bounded waits, logged failures and true awaited work into one void promise. The scheduler releases its leader lock before observing run completion; Relay can close its index after stop attempts that swallow errors. A root wrapper alone cannot withhold those internal effects. Admin reset currently closes DB and removes data after root releases the instance lock, and both admin actions restart even after cleanup rejection.

Admitted handlers, established SSE/WS, detached turns, separate listeners, late startup acquisitions and background sweeps can outlive transport boundaries. A valid reset/restart needs one owner for the entire terminal chain, then resource-specific positive evidence; sharing cleanup alone does not prevent competing delete/spawn/exit continuations.

## Reporting boundary discovered in review

The actual logger appends every file-reporter event to dorkHome/logs/dorkos.log (`apps/server/src/lib/logger.ts:100`; root supplies that directory). Post-release failure reporting therefore cannot use the normal logger. The design must fence/close protected reporters before filesystem handoff and retain the final receipt in memory; optional best-effort stderr requires explicit evidence its sink cannot touch handed-off resources. Unknown or protected-file stderr is skipped. Reporting failure is separate from the original operation failure and does not reopen/retry/delay an otherwise proven handoff; a protected reporter that cannot be fenced still blocks handoff. These are proposed requirements, not existing logger capabilities.

## Alternatives and decisions

| Alternative                                              | Decision and reason                                                                                                                                           |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Treat void cleanup completion as safe handoff            | Reject: swallowed failures and timeouts discard required facts.                                                                                               |
| Race the whole shutdown against a timeout and exit/spawn | Reject: timeout is not cancellation; child writers and supervisor restart can survive it.                                                                     |
| Catch every error and close everything anyway            | Reject: dependent resources may still be needed by unfinished writers. Continue only independent safe closures.                                               |
| Keep the current lock until recursive reset completes    | Insufficient: reset deletes the lock file itself. Automated reset remains unsupported by the proposed contract until deletion-compatible exclusion is proved. |
| Introduce a generic lifecycle framework now              | Reject: specify the contract and one laboratory proof first; no unused production abstraction.                                                                |
| Resource-scoped outcomes with explicit permissions       | Select: retain original/cleanup errors, known fences and pending work, and gate each irreversible action separately.                                          |

## Scope and staged direction

This delivery is a complete design contract and staged proof plan, not production adoption. Start, if separately selected, with real workspace reconciliation over disposable SQLite, a second held synthetic DB consumer, and fake listener/authority/successor effects. A workspace cache-write fence alone does not authorize DB reads/handles, filesystem deletion or global lock release. A later actual timer-only cohort remains deferred and unselected. Full handoff requires the complete writer census, explicit composite closer boundaries and exclusive terminal owner; Cloud/Community, broader startup rollback and marketplace retention retain their own scope.

## Resolution boundary

Policy choices are concrete in [02-specification.md](02-specification.md). Missing implementation evidence is expressed as a permission gate, not an unanswered policy placeholder. Source and tracker ownership were refreshed after admission delivery; independent requirements review found no substantive gaps. Implementation and laboratory tests remain unselected.
