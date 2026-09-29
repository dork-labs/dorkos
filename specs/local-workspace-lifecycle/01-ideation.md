---
slug: local-workspace-lifecycle
number: 260926-193136
created: 2026-09-26
status: specified
---

# Shape local workspace lifecycle ownership

**Delivery:** [DOR-2347](https://linear.app/dorkspace/issue/DOR-2347) - Shape a bounded server lifecycle ownership pilot.
**Source baseline:** `7168a5b7c69def16bb2cb48319b24285c9894a3f`.

## 1) Intent & Assumptions

Deliver an ownership map and one bounded pilot specification. This is a design delivery, not authorization to rewrite server composition. The current root already has ordered teardown and a concurrent-signal guard. A useful pilot must establish a resource owner's local guarantees without claiming end-to-end server shutdown has been fixed.

Cloud, Community, Connections security, authentication, shared runtime/transport behavior, central startup/shutdown, shared UI and CI changes are excluded. No paid inference or deployment. Runtime lifecycle DOR-2064/DOR-2065, lock shaping DOR-2346 and escalation timer DOR-2136 retain their existing owners.

## 2) Pre-reading Log

- [Server root](../../apps/server/src/index.ts): explicit ordered `shutdownServices`, guarded signal entry, selective startup-failure cleanup; no whole-sequence deadline.
- [Workspace reconciler](../../apps/server/src/services/workspace/workspace-reconciler.ts): passive constructor, timer-owning start/stop, untracked async passes.
- [Workspace composition](../../apps/server/src/services/workspace/index.ts): constructs and returns the reconciler; root starts it without retaining a teardown reference.
- [Warm-process lifecycle](../warm-process-lifecycle/02-specification.md): adjacent runtime work; a workspace pilot avoids that ownership overlap.
- [Prior reset/restart research](../../research/20260301_settings_reset_restart.md): historical teardown precedent, not current authentication or shutdown proof.
- [Mesh registry integrity research](../../research/20260226_mesh_registry_integrity.md): file-first cache reconciliation precedent, not proof of resource disposal.
- [Review rubric](../../REVIEW.md): comments are claims; a recovery path must itself be tested under failure.

## 3) Codebase Map

The [specification's ownership map](02-specification.md#current-ownership-map) records the construction/start/stop owners and evidence limits. The pilot's only production module would be `services/workspace/workspace-reconciler.ts`; its dependencies are the existing local `WorkspaceStore`, `WorkspaceService.checkoutExists`, timer APIs and logger. It keeps file-first cache decisions unchanged.

## 4) Research and Alternatives

| Candidate                                  | Benefit                                                                           | Reason to select or defer                                                                              |
| ------------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Local workspace reconciler                 | Small owner, observable timer and async writes, no existing lifecycle suite found | Select for design. Can establish passive construction, admission, drain and timeout semantics locally. |
| Runtime children                           | High operational value                                                            | Defer to DOR-2064/DOR-2065 and runtime lock ownership work.                                            |
| Marketplace cache retention                | Existing listener unsubscribe is discarded                                        | Record as a follow-up; do not combine it with recovery evidence or this pilot.                         |
| Generic lifecycle framework / root rewrite | Could centralize all resource acquisition                                         | Reject for this pilot: too broad, touches protected work, and has no proven local pattern yet.         |

## 5) Decisions

| Decision     | Choice                                                                         | Rationale                                                                                                        |
| ------------ | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Delivery     | Ownership audit plus specified local pilot                                     | Matches the authorized shaping scope. Implementation stays separately selected.                                  |
| Pilot owner  | `WorkspaceReconciler`                                                          | Timer lifetime and writes after awaited reads can be tested without booting other domains.                       |
| Existing API | Preserve restartable `start`/`stop`; add terminal disposal only in future work | Avoid silently changing the meaning of existing calls.                                                           |
| Deadline     | Report drained vs timed out; fence late writes                                 | A deadline does not cancel filesystem IO. A timeout must not pretend everything closed.                          |
| Adoption     | Separate root-coordination follow-up                                           | Class-local guarantees alone cannot stop a resource the root never disposes.                                     |
| ADR          | None yet                                                                       | A bounded experiment is not adoption of a repo-wide architecture. Evaluate an ADR after the pilot proves useful. |

No product ambiguity prevents this bounded specification. Root-level admission, failure policy and shared shutdown changes remain explicitly deferred, with revisit conditions in the specification. Next step after design review is separate selection and decomposition of the pilot, not automatic execution.
