# Architecture improvement roadmap

**Recorded:** 2026-09-25. **Public source baseline:** `dbff5a6f6b3005d4e9815d1b3d485446528f2900`.

This preserves the five ranked recommendations from the September architecture review and turns them into independently selectable workstreams. The original assessment was 7.5/10: strong boundaries and direction, with contracts and lifecycle wiring that had grown too broad. That was a judgment at the time, not a measured score or a new audit result.

The [system architecture atlas](../contributing/system-architecture.md) describes the system. This roadmap records improvement rationale, scope and handoffs. Linear owns live status, assignments, dependencies and execution order. The evidence below is a dated snapshot, not a second status database.

**Coordination:** [DOR-2344](https://linear.app/dorkspace/issue/DOR-2344/coordinate-the-architecture-improvement-roadmap). Each workstream has a captured idea awaiting triage. None is automatically dispatchable; selecting a workstream is separate from saving it. Existing projects remain the delivery homes. There is no new catch-all architecture project.

## Original ranking and current interpretation

| Original rank | Recommendation and reason                                                                                                                                                           | Evidence at this baseline                                                                                                                                                                                                                                                                                                                                                                 | Next useful chunk                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 1             | Resolve Community identity and authorization end to end before expanding remote rooms. A local caller, acting member and remote tenant must agree on the same authorized operation. | Community has advanced: tenant-qualified pairing (DOR-2173), switching/isolation verification (DOR-2186), and revoked-credential reconciliation (DOR-2191) are recorded complete in Linear. Owner-qualified remote state and revocation hooks exist in [state.ts](../apps/server/src/services/communities/remote/state.ts). This is not a finding that authorization is currently broken. | Reconcile coverage and residual gaps against the existing Community programmes; do not rebuild shipped identity work.   |
| 2             | Narrow runtime and client interfaces around their consumers. Execution, history, interactions and lifecycle need different capabilities.                                            | [AgentRuntime](../packages/shared/src/agent-runtime.ts) still exposes `SseResponse` through `acquireLock` and optional `acquireRuntimeLock`. That is concrete coupling to investigate; it does not by itself prove a runtime defect.                                                                                                                                                      | Shape transport-independent lock ownership first; defer broader interface splitting until caller evidence justifies it. |
| 3             | Give server subsystems explicit construction, startup and disposal boundaries. Resources need owners, including when startup fails partway.                                         | [index.ts](../apps/server/src/index.ts) is 5,322 lines at this baseline and coordinates many services. Existing subsystem lifecycle helpers must be inventoried. File length is a complexity signal, not evidence of leaks or a reason for a wholesale rewrite.                                                                                                                           | Specify and prove one subsystem's lifecycle, then decide whether the pattern deserves broader adoption.                 |
| 4             | Finish the Cloud contract transition with exit criteria. Stable instance identity must survive credential changes without accidental identity sharing.                              | DOR-2025 records the public wire-contract work complete. [cloudInstanceRef](../apps/server/src/services/core/cloud/v1-client.ts) still derives a reference from the linked credential and explicitly identifies service-issued identity as a follow-up.                                                                                                                                   | Separate the stable-identity decision from the inventory and retirement of remaining legacy callers.                    |
| 5             | Make cross-boundary recovery guarantees explicit release gates. Users need predictable outcomes after disconnects, crashes and duplicate delivery.                                  | Existing recovery work includes DOR-1961 (hosted outage recovery), DOR-2178 (Community recovery verification), and DOR-2273 (marketplace crash-backup recovery). These completed tracker items are starting evidence, not proof that every recovery case is covered.                                                                                                                      | Build a scenario-to-test-and-owner matrix, then fill only demonstrated gaps in the owning domains.                      |

The ranking above is historical. See the dated updates below before selecting work. At the original baseline, **runtime lock ownership was the clearest bounded candidate to shape first**. Community reconciliation and the recovery matrix can be independent research sessions. Cloud work needs agreement at the public contract boundary; lifecycle work needs a small pilot before broader migration. A newly verified security or data-loss defect takes precedence over this suggested order.

## Workstream briefs

These are intake briefs, not frozen specifications. Acceptance below describes the first chunk's output; it does not authorize every possible follow-on change.

### A. Reconcile Community authority and isolation

**Tracker:** [DOR-2345](https://linear.app/dorkspace/issue/DOR-2345/reconcile-community-authority-and-isolation-coverage). **Home:** Community Membership Journeys; coordinate with Multi-Community Hosting, Community Navigation, Community Self-Hosting and Cloud-Hosted Communities.

**Outcome:** a source-backed matrix for local caller → saved connection → remote community → acting member → list/open/post/subscribe/attachment access/revocation. Include two owners, two tenants at one origin, independent origins, account switching, revoked membership and credential changes during a stream.

**Start with:** [Community next-phase roadmap](community-next-phase.md), [tenancy specification](../specs/community-tenancy-contract/02-specification.md), [membership specification](../specs/community-membership-journeys/02-specification.md), the remote services and route tests, and DOR-2173 / DOR-2186 / DOR-2191. Re-read linked acceptance evidence before crediting an invariant as verified.

**First-chunk acceptance:** every operation has an authority owner and a concrete test/evidence pointer, or an explicit unknown and a linked existing/new issue. Reuse an existing issue when it already owns the gap. No unknown may be represented as a passing security check.

**Exclusions:** no new identity model, provider migration or live paid deployment. Independent Community hosting and local accounts remain supported. Route actual gaps back to their existing projects. Next Flow step: TRIAGE, with a bounded research item if the evidence review remains uncertain.

### B. Separate runtime lock ownership from delivery transport

**Tracker:** [DOR-2346](https://linear.app/dorkspace/issue/DOR-2346/shape-transport-independent-runtime-lock-ownership). **Home:** Sessions & Runtimes.

**Outcome:** an ideation/specification for a minimal lock-ownership and cancellation contract that can serve HTTP-triggered, streamed and internal callers without passing a response object into the runtime port.

**Start with:** [AgentRuntime](../packages/shared/src/agent-runtime.ts), [Transport](../packages/shared/src/transport.ts), [MessageDispatcher](../apps/server/src/services/session/message-dispatcher.ts), every `acquireLock` / `acquireRuntimeLock` implementation and caller, and runtime conformance tests. Obsidian retirement shipped in PR #2126 (merge `535a642c2be407b14517258e4dd58fd74bfc2817`); it is no longer an in-flight prerequisite. DOR-2065 is adjacent runtime lifecycle work and must be checked for overlap.

**First-chunk acceptance:** caller inventory; explicit ownership, cancellation and stale-release semantics; compatibility/migration plan for each runtime; meaningful conformance cases for competing callers, stale completion, disconnect and replacement ownership. Identify any required ADR. A consumer capability map may recommend later interface splits, but do not manufacture interfaces solely to reduce file size.

**Exclusions:** no transcript-store unification, wire-protocol rewrite or all-at-once `Transport` split. Next Flow step: TRIAGE → IDEATE → SPECIFY; only then DECOMPOSE and EXECUTE.

### C. Prove explicit server lifecycle ownership

**Tracker:** [DOR-2347](https://linear.app/dorkspace/issue/DOR-2347/shape-a-bounded-server-lifecycle-ownership-pilot). **Home:** Maintenance.

**Outcome:** inventory resource ownership in server startup and select one bounded subsystem for a construction/start/disposal pilot. Record which resources already have a lifecycle and why the chosen subsystem benefits from a change.

**Start with:** [server composition](../apps/server/src/index.ts), [Express app](../apps/server/src/app.ts), timer/subscription registrations and existing stop/dispose helpers. Desktop process supervision (DOR-533) is useful precedent, but does not establish ownership inside the server process.

**First-chunk acceptance:** dependency and ownership map; deterministic startup/teardown ordering; partial-start rollback; bounded shutdown and idempotent disposal criteria; tests that can detect retained timers/listeners or resources after injected failure. Define the pilot before changing composition.

**Exclusions:** no dependency-injection framework or monolithic server rewrite. Coordinate any shared startup-file edits with other active sessions. Next Flow step: TRIAGE → IDEATE; pilot specification before implementation.

### D. Settle Cloud identity and migration exit criteria

**Tracker:** [DOR-2348](https://linear.app/dorkspace/issue/DOR-2348/define-cloud-instance-identity-and-contract-retirement-criteria). **Home:** DorkOS Cloud; public contract proposals carry `cloud-contract`.

**Outcome:** two separately scoped follow-ons: (1) establish the intended lifetime and authority of instance identity; (2) inventory public app callers and define when legacy contract paths can be retired.

**Start with:** [public Cloud client wrapper](../apps/server/src/services/core/cloud/v1-client.ts), its callers, public contract schemas/package declarations and DOR-2025. Coordinate with DOR-2086 (managed remote access) and DOR-1798 (Connections legacy retirement); their scopes must not be duplicated.

**First-chunk acceptance:** identity semantics for credential rotation, unlink/relink, reinstall, account transfer and deletion; migration behavior for existing links; caller/endpoint/version inventory with explicit retirement criteria and tests. Decide whether a service-issued identifier is needed through a public contract proposal. Do not reuse the opt-in telemetry identifier as an authentication or billing identifier.

**Exclusions:** no private control-plane implementation, commercial terms or deployment claims in this public roadmap. Public app builds and tests must remain independent of the private service. A public contract existing does not establish that its server side is deployed. Next Flow step: TRIAGE → IDEATE; split identity and migration into linked tasks/specs when their scope is settled.

### E. Map recovery guarantees to release evidence

**Tracker:** [DOR-2349](https://linear.app/dorkspace/issue/DOR-2349/map-cross-boundary-recovery-guarantees-to-release-evidence). **Home:** Green Main: CI, Gates & Test Health for the initial evidence matrix; domain projects own fixes.

**Outcome:** a matrix covering acceptance followed by crash, restart/reconnect, duplicate delivery, revocation during delivery, Cloud unavailable, and interrupted installation. Include local sessions, Community participation, managed services and marketplace installs where each scenario applies.

**Start with:** existing streaming, dispatcher, Community, marketplace and outage tests; DOR-1961 / DOR-2178 / DOR-2273 and their merged changes. Record what is durable, what may replay, what stops and what the user sees. Do not promise exactly-once behavior without a defined boundary and evidence.

**First-chunk acceptance:** each applicable cell has a behavioral guarantee, owning subsystem, executable evidence and current gate location, or an explicit gap. A missing test and a broken guarantee are different findings. Propose narrow missing cases rather than adding a second broad test suite.

**Exclusions:** no automatic expansion of required checks. Any subsequent CI change follows the CI Steward protocol and carries its required ledger evidence. Next Flow step: TRIAGE, then a bounded research/task outcome before domain implementation work.

## Hand a chunk to another session

1. Select one tracker item and read its live status, comments and typed relations. Search for successors or shipped work; this dated roadmap does not override them. Re-read current Flow configuration and the adapter skill.
2. Use the brief above as context, then run TRIAGE. Captured ideas are intentionally unassigned, unestimated and without `agent/ready`. Apply readiness only when deliberately selecting/routing work under Flow; saving this roadmap is not dispatch approval.
3. Pin a fresh base commit. Put every file change in an isolated worktree. Coordinate shared files with active sessions, including shared UI adoption. Obsidian retirement is complete; recheck other adjacent programmes live.
4. Use `specs/<specific-change>/` for ideation, specification, `03-tasks.json` and verification evidence when Flow calls for them. Keep small tasks in their owning issue/checklist. Create ADRs in `decisions/` only when an architectural decision has actually been made.
5. Put genuine prerequisites in typed blocking relations when tasks are decomposed. Original rank is not a dependency: none of these intake briefs has an established hard dependency on another. Shared evidence or related programmes use related links, not artificial blockers.
6. Require separate-agent review using `REVIEW.md`, relevant verification, reviewed PRs and merge-queue completion before reporting implementation shipped. Clean up only clean worktrees whose work is merged or otherwise safely preserved. Never close the coordination issue merely because the roadmap PR merges.

## Maintaining the record

Update this file when rationale, boundaries, evidence assumptions or workstream ownership change. Record the review date and source revision. Keep live status and detailed tasks in Linear and each spec; link superseding work instead of copying its checklist here. Link accepted ADRs and merged evidence back to the owning issue. Close the coordination record only after all five recommendations have an explicit disposition: shipped, superseded, rejected with rationale, or deliberately deferred with an owner and revisit condition.

## Local evidence and lifecycle shaping, 2026-09-26

Reviewed against `7168a5b7c69def16bb2cb48319b24285c9894a3f`. The [local marketplace evidence matrix](../research/20260926-local-marketplace-recovery-evidence.md) is the bounded DOR-2427 slice of DOR-2349. It credits shipped recovery tests and prior SIGKILL proof, documents update's uninstall/reinstall boundary, and records DOR-2340/DOR-2341 triage without changing approvals or discovery. DOR-2349 remains broader than this local delivery; Cloud, Community and shared reconnect guarantees are not certified here.

The [lifecycle ownership map and pilot specification](../specs/local-workspace-lifecycle/02-specification.md) deliver DOR-2347's shaping outcome. Ordered central teardown and the concurrent-signal guard already exist. The proposed local workspace reconciler pilot addresses tracked work and bounded disposal; implementation and adoption into central startup/shutdown remain separately selected follow-ups. The spec remains `specified`, not `implemented`.

This slice changes documentation only. Protected Cloud/Community work, authentication, runtime/transport contracts, shared UI, server composition and CI configuration remain outside its implementation scope. Live ownership and follow-up dispositions stay in the linked tracker records.

## Class-local pilot selection, 2026-09-27

At implementation baseline `4eb4d1f40b796253c7839990090626b6f79c75a9`, the operator selected [DOR-2428](https://linear.app/dorkspace/issue/DOR-2428) - Implement the class-local workspace reconciler lifecycle pilot. The [task plan](../specs/local-workspace-lifecycle/03-tasks.md) bounds production changes to the reconciler and focused adjacent tests. This supersedes only the local implementation deferral above. DOR-2429 central adoption, DOR-2340/DOR-2341 marketplace decisions and DOR-2344 coordination remain open or deferred under their existing owners. The server root does not call the new disposal API; no server-wide shutdown guarantee follows from this pilot.

## Cloud completion review, 2026-09-27

Public evidence is pinned to `5794f638160a68811382347356fd29b31ee2e911`. Initial Cloud implementation completion removes the blanket reason to wait for the service to be built. It does not establish that each deployment switch, app consumer or recovery scenario is complete. The [architecture atlas](../contributing/system-architecture.md#cloud-public-boundary) now separates these states and includes the [account handover diagram](../contributing/diagrams/architecture/accounts-handover.mmd).

The next useful Cloud architecture chunk is **DOR-2348: reconcile instance identity and caller migration against the implemented boundary**. The local app still mixes legacy and `/v1` paths, defaults its service origin to the website, and derives `cloudInstanceRef` from the linked credential. Credential rotation and stable identity therefore still need explicit semantics. Account forwarding is route-specific, not a blanket migration of all Cloud traffic.

Keep the remaining work in its existing homes:

| Work                           | Existing owner                                          | Completion condition                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Website account retirement     | [DOR-2442](https://linear.app/dorkspace/issue/DOR-2442) | Verified account handover before removing local account code; preserve forwarding for older app versions and keep the separate managed-connections path.                           |
| Managed connections migration  | [DOR-1798](https://linear.app/dorkspace/issue/DOR-1798) | Its own caller and operational verification; account forwarding does not complete it.                                                                                              |
| Managed remote access consumer | [DOR-2086](https://linear.app/dorkspace/issue/DOR-2086) | Wire and verify command-stream leases/acknowledgements, capability gating and credential rotation. The existing tunnel is a separate path.                                         |
| Cross-boundary recovery        | [DOR-2349](https://linear.app/dorkspace/issue/DOR-2349) | Extend the existing evidence matrix to Cloud unavailability, reconnect, duplicate batches and revocation; local marketplace evidence alone does not certify these.                 |
| Shared UI adoption             | [DOR-2342](https://linear.app/dorkspace/issue/DOR-2342) | Continue surface-by-surface adoption and visual/accessibility verification. Cloud completion creates a stable consumer to audit, not proof that its components are already shared. |

The hosted-community start/move UI and local relay already exist. Their archive upload goes directly from the local server to the returned Community target. Hosting management, Community content authority and ordinary membership remain separate. Verify destination import support and service availability before calling the move path end-to-end complete; do not reopen a broad hosting build under this roadmap.

The class-local lifecycle pilot shipped in [PR #2226](https://github.com/dork-labs/dorkos/pull/2226), completing DOR-2428. [DOR-2429](https://linear.app/dorkspace/issue/DOR-2429) remains the separately gated central adoption follow-up; the pilot does not prove server-wide disposal. This is a bounded local candidate that does not depend on Cloud rollout. No item becomes ready, and no coordination issue closes, solely because of this documentation refresh.

## Merged follow-through, 2026-09-28

Public source for this update is pinned to `710521034fbcfa9de43f0ae3a252b053a4b1db10`. This section supersedes the lifecycle implementation deferrals in the dated snapshots above; it does not certify deployment or close DOR-2344's wider programme.

- **Workspace lifecycle adoption:** [PR #2262](https://github.com/dork-labs/dorkos/pull/2262) completes DOR-2429. The server now retains a [workspace lifecycle owner](../apps/server/src/services/workspace/workspace-reconciler-lifecycle.ts) before starting reconciliation and awaits its terminal disposal first in shared service cleanup and startup-failure cleanup. Disposal prevents later registration, fences late cache writes and shares a bounded completion result. Timeout is not cancellation of pending I/O. The [verification record](../specs/central-workspace-disposal/04-verification.md) distinguishes executable owner tests from structural root-wiring checks; this is not a whole-server shutdown proof.
- **Community authority evidence:** [PR #2271](https://github.com/dork-labs/dorkos/pull/2271) adds route and remote-adapter tests that keep an already-open stream bound to its opening owner and origin while another caller opens a separate connection. Revoking one grant terminates its stream without terminating the other owner's stream. These tests strengthen evidence for the existing authority boundary; they introduce no new deployment topology.
- **Community restore evidence:** [PR #2272](https://github.com/dork-labs/dorkos/pull/2272) adds an [operator-run backup/restore rehearsal](../apps/community/scripts/rehearse-backup-restore.mjs) for two populated communities on disposable local resources. It verifies stable IDs, private history and replies, attachment bytes, cross-tenant denials, revoked member/grant denials, and unchanged source database/blob digests. This source-build rehearsal is separate from verification of a release image or a live deployment's backup and rollback readiness.
- **Managed remote design:** [PR #2263](https://github.com/dork-labs/dorkos/pull/2263) records the [draft app-consumer specification](../specs/managed-remote-app-consumer/02-specification.md). DOR-2086 remains gated on authenticated instance identity adoption, the person-enrollment ceremony and trusted ingress-proof contracts, plus deployed acceptance evidence. The merged draft is not a running Cloud command-stream consumer.
- **Shared UI:** [PR #2270](https://github.com/dork-labs/dorkos/pull/2270) merges source adoption. The `@dork-labs/ui@0.2.1` release is published, with the downloaded registry archive matching the tested artifact and passing a clean consumer install, build and browser checks. DOR-2342 still owns remaining consumer adoption; package verification does not establish adoption or deployment by every surface.

The lifecycle follow-ons remain independently selectable, **not selected by this refresh**: [DOR-2481](https://linear.app/dorkspace/issue/DOR-2481) for admission and exclusive reset/restart, [DOR-2482](https://linear.app/dorkspace/issue/DOR-2482) for shutdown outcomes and database/lock handoff, [DOR-2483](https://linear.app/dorkspace/issue/DOR-2483) for broader startup rollback and original-error preservation, and [DOR-2484](https://linear.app/dorkspace/issue/DOR-2484) for marketplace retention subscriptions and sweeps. The [root ownership inventory](../specs/central-workspace-disposal/root-ownership.md) preserves the earlier inspection baseline and the boundaries behind these follow-ons.

DOR-2348 identity adoption is not claimed by this update. Keep the September 27 Cloud snapshot above distinct from subsequent implementation evidence, and reconcile it when the identity work merges. DOR-2349 remains the cross-boundary recovery matrix; Community proofs do not certify every Cloud, session or marketplace recovery case.
