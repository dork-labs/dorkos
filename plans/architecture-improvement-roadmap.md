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

The ranking above is historical. For a fresh implementation session, **runtime lock ownership is the clearest bounded candidate to shape first**. Community reconciliation and the recovery matrix can be independent research sessions. Cloud work needs agreement at the public contract boundary; lifecycle work needs a small pilot before broader migration. A newly verified security or data-loss defect takes precedence over this suggested order.

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

**Start with:** [AgentRuntime](../packages/shared/src/agent-runtime.ts), [Transport](../packages/shared/src/transport.ts), [MessageDispatcher](../apps/server/src/services/session/message-dispatcher.ts), every `acquireLock` / `acquireRuntimeLock` implementation and caller, and runtime conformance tests. Reconcile the separately requested Obsidian retirement before removing or redesigning client-facing interfaces; do not assume that retirement has shipped. DOR-2065 is adjacent runtime lifecycle work and must be checked for overlap.

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
3. Pin a fresh base commit. Put every file change in an isolated worktree. Coordinate shared files with active sessions, including shared UI adoption and Obsidian retirement. Neither adjacent programme is claimed complete here.
4. Use `specs/<specific-change>/` for ideation, specification, `03-tasks.json` and verification evidence when Flow calls for them. Keep small tasks in their owning issue/checklist. Create ADRs in `decisions/` only when an architectural decision has actually been made.
5. Put genuine prerequisites in typed blocking relations when tasks are decomposed. Original rank is not a dependency: none of these intake briefs has an established hard dependency on another. Shared evidence or related programmes use related links, not artificial blockers.
6. Require separate-agent review using `REVIEW.md`, relevant verification, reviewed PRs and merge-queue completion before reporting implementation shipped. Clean up only clean worktrees whose work is merged or otherwise safely preserved. Never close the coordination issue merely because the roadmap PR merges.

## Maintaining the record

Update this file when rationale, boundaries, evidence assumptions or workstream ownership change. Record the review date and source revision. Keep live status and detailed tasks in Linear and each spec; link superseding work instead of copying its checklist here. Link accepted ADRs and merged evidence back to the owning issue. Close the coordination record only after all five recommendations have an explicit disposition: shipped, superseded, rejected with rationale, or deliberately deferred with an owner and revisit condition.
