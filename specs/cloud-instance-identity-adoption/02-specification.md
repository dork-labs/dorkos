---
slug: cloud-instance-identity-adoption
number: 260928-001608
created: 2026-09-27
status: specified
---

# Adopt authoritative Cloud instance identity

**Status:** Approved for decomposition (programme direction; implementation still requires independent review)
**Author:** Codex
**Work item:** DOR-2348
**Evidence baseline:** `5794f638160a68811382347356fd29b31ee2e911`

## Overview

Resolve the linked instance through the existing `/v1/session` contract immediately before requesting an inference token. Bind introspection, minting and subsequent launch use to one credential/origin snapshot. Remove the credential-derived `cloudInstanceRef()` without adding config fields or an identity cache.

## Background / Problem Statement

The current reference is a token hash, so rotating a credential changes the apparent instance. A service registration is a different concept: the legacy heartbeat already returns an authoritative ID, and `/v1/session` can report the registration associated with a credential. The current caller discards the former and does not use the latter. A minted inference token also survives a local unlink or origin change until expiry because readiness checks only its timestamp.

## Goals

- Supply only the authenticated service-issued instance ID when minting inference credentials.
- Make identity resolution, mint response acceptance and runtime readiness reject obsolete local links.
- Preserve existing configs, local execution, explicit paid gating and honest capability absence.
- Record every current Cloud caller family and the evidence required before retiring compatibility routes.

## Non-Goals

- Persisting identity, minting a local installation ID, changing telemetry consent, or migrating config.
- Changing service origins, enabling paid flags, enrolling any machine, or adding remote-control consumers.
- Migrating Connections, deleting account code, changing Community transport or modifying CI.
- Claiming remote revocation merely because local state has been cleared.

## Technical Dependencies

Use the installed `@dork-labs/cloud-api` package's `SessionSchema`, `V1_ROUTES.session`, `InferenceTokenSchema` and existing client. No dependency upgrade or wire-contract extension is required. `GET /v1/session` must actually be deployed on the configured origin to use this capability; schema publication alone is insufficient evidence.

## Detailed Design

### Credential and origin context

Add a small server-only context seam beside `createCloudV1Client` in `services/core/cloud/v1-client.ts`. Capture the current nonempty linked token and resolved base URL exactly once; build the client from those captured values. Expose operations or a predicate that compare the captured values with current configuration, without exposing token material to routes, JSON, logs, browser state or telemetry. Origin comparison must use the same trailing-slash normalization as client construction; no origin rewrite or fallback host is added.

Resolve `GET /v1/session` using that captured client and `SessionSchema`. Require `authenticated === true` and a present nonempty `instanceId`. A person session, missing ID, absent route, malformed response, unauthorized response or transport failure cannot yield a usable instance context. Check currency after the asynchronous response. Keep identifiers opaque; never derive them from email, host metadata, a token hash or telemetry.

### Mint and launch

`primeCreditsInference` owns the resolution and accepts no caller-supplied instance ID. Check the module-scope paid flag before constructing a context or making requests. Resolve identity, check currency immediately before minting, and POST `{ instanceId }` to `/v1/inference/tokens` with the same client. Check currency again before retaining the response. A link that changes during either request makes the result unusable even when the remote request completed successfully.

Store the validated minted token with its captured context in process memory. Runtime environment reads and the credential-free readiness report require both a live token and a matching current context. On mismatch, discard stored state so unlink/relink or authority changes cannot keep the old token launchable. A refresh attempt must not retain a token belonging to an obsolete context; transient refresh failure may retain an unexpired token only if it still matches the current context. Prevent an older concurrent mint completion from replacing state from a newer selection attempt, using a monotonically increasing attempt generation or equivalent ordering guard.

`routes/cloud.ts` delegates selection to this function and removes its `cloudInstanceRef` import/call. Delete the hash helper and its stale comment. Existing ordinary readers of `createCloudV1Client` remain compatible. A future remote consumer may reuse the context seam, but this change adds no remote lifecycle behavior.

No local read can prove that a credential was revoked remotely since the last successful call. This implementation guarantees local-context invalidation and refuses observed authentication failures; remote revocation remains enforced by the service and later discovery by existing heartbeat. Do not claim instantaneous remote revocation or cancel already-running turns.

### Phase 2: link lifecycle generations

Add a process-local monotonic generation to CloudLinkManager. Advance it on starting/replacing a link and on local withdrawal; every heartbeat, managed request and poll completion captures its originating generation and credential. Success and refusal handling may mutate current link state only when both still match. Generation comparison is mandatory: token equality alone misses A → unlink → A when the same credential value is restored. Link operations should invalidate other in-flight lifecycle operations before any await; starting a new flow may preserve the existing usable credential until replacement, but must obsolete responses from the superseded flow.

On explicit unlink, capture the retiring credential, advance the generation, cancel the poll, stop heartbeat scheduling, clear the local token/label, reset the heartbeat timestamp and enter idle synchronously before awaiting any remote operation. Notify managed registration reconciliation after local withdrawal. Best-effort remote revoke uses only the captured retiring credential. Its eventual result cannot clear, change or reschedule a replacement link. Keep the existing acknowledgement semantics: this does not repair the legacy service's session-only revoke mismatch or assert remote revocation success.

Heartbeat success from an obsolete generation cannot write account label, timestamp or linked state. Obsolete heartbeat 401 and managed-request 401 cannot call an effective markUnlinked on the replacement generation. Cover both withManagedConnectorToken and the separately implemented authority-command submit/read paths. Poll completion and the heartbeat scheduling after it must similarly check generation before accepting a new token or starting a timer. Preserve transient-error retry behavior for the current generation and the current link's 401 withdrawal behavior.

The immutable inference context should include an observable local link generation where available, so a lifecycle A → unlink → A invalidates stored inference state even if no readiness read occurred while unlinked. Keep that generation process-local and server-only; do not add persistent config. Direct token changes outside the manager must also invalidate generations: ConfigManager.onChange exposes changed paths/sections, so a scoped listener can observe actual token changes and invalidate even A → null → A between reads. Combine that with explicit manager generation changes for same-token flow replacement. Register at most one listener per owning lifetime and unsubscribe on disposal or replacement; per-request listeners must always clean up on success, refusal and abort. Test repeated resolution for listener leaks. Direct origin changes must still be caught by value comparison. Startup/CLI reuse of a saved token does not resurrect process-local minted state after restart.

### Identity lifetime and compatibility

| Event                                  | Semantics and required behavior                                                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Token rotation                         | Service may retain the registration ID; re-introspect the new credential. Discard old minted state even if the ID is unchanged.                             |
| Unlink                                 | No current context; no inference readiness. Local token clearing does not prove remote revoke succeeded.                                                    |
| Relink                                 | Introspect the new credential. Never restore an old ID based on machine name or previous account label. Legacy approval creates a new registration.         |
| Restart or reinstall preserving config | Resolve lazily on the next explicitly gated mint. No persisted inference state is recovered.                                                                |
| Fresh install/config removal           | No link and no inferred continuity. Device approval is required.                                                                                            |
| Organization reassignment              | Public `instanceOrg` contract changes organization association; it is not account transfer. Resolve under the current credential.                           |
| Account transfer                       | No public local transfer protocol is assumed. A new credential must be introspected; names or telemetry cannot merge identity.                              |
| Account deletion/revocation            | Refuse observed invalid credentials; existing heartbeat clears local link on 401. Unobserved remote revocation is the service's enforcement responsibility. |
| Configured authority change            | Old context and mint become unusable; identity from one authority is never assumed valid at another.                                                        |
| Legacy service/no `/v1/session`        | Mint remains unavailable; no hash/heartbeat fallback silently widens compatibility.                                                                         |

### Baseline caller/endpoint/origin inventory

All paths here are public repository paths. `apps/server/src/env.ts:329` defaults `DORKOS_CLOUD_URL` to the website. `core/auth/cloud-link-client.ts:291` trims trailing slashes and supplies both legacy auth and current `/v1` clients. CLI device flow imports the same transport primitives.

| Caller                                                                  | Actual remote routes                                                                                                                                                                                                                               | Identity/authentication and origin                                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `core/auth/cloud-link-client.ts:331,392`                                | POST `/api/auth/device/code`, `/api/auth/device/token`                                                                                                                                                                                             | Device grant; configured Cloud base                                                                            |
| Same file `:450,754`                                                    | POST `/api/instances/heartbeat`, `/api/instances/revoke`                                                                                                                                                                                           | Instance bearer; heartbeat ID returned, currently discarded; revoke best-effort                                |
| Same file `:501–815`                                                    | `/api/instances/connectors/authority-commands` POST and ID GET; catalog GET; toolkit version/operations/events GET; connections list/detail GET; authentication-flows POST/detail GET; executions POST/detail GET; usage GET; events pull/ack POST | Instance bearer and legacy shared schemas; configured Cloud base                                               |
| `core/cloud/plan.ts:79–211`                                             | GET `/v1/entitlements`, `/balance`, `/usage`, `/nudge`, `/orgs`, `/orgs/:id/members`, `/orgs/:id/seats`; POST `/v1/seats/:id/assign`, `/release`                                                                                                   | Instance bearer; configured Cloud base                                                                         |
| `core/cloud/credits-inference.ts:114`                                   | POST `/v1/inference/tokens`; proposed preceding GET `/v1/session`                                                                                                                                                                                  | Explicit paid flag plus instance bearer; current hash replaced by authoritative ID                             |
| `core/cloud/hosted-communities.ts:102–313`                              | GET `/v1/entitlements`, `/communities`, `/communities/moves`, `/communities/name-check`, `/communities/moves/:id`; POST `/communities`, `/communities/:id/claim-link`, `/keep`, `/restore`, `/communities/moves`, `/communities/moves/:id/cancel`  | Instance bearer; configured Cloud base. Archive uploads go directly to Community, not through this Cloud path. |
| `core/feedback-reporter.ts:178,726`                                     | POST `/api/feedback`, GET `/api/feedback/mine`                                                                                                                                                                                                     | Website operations also use `DORKOS_CLOUD_URL`; feedback telemetry default separately fixed at `:64`           |
| `services/marketplace/install-counts.ts:31,110`, `updated-at.ts:35,114` | GET `/api/telemetry/install-counts`, `/api/telemetry/updated-at`                                                                                                                                                                                   | Website operations also use `DORKOS_CLOUD_URL`                                                                 |

Server service paths in this table are under `apps/server/src/services/`. Local browser `/api/cloud/*` routes are relays into these services, not additional service-origin callers. The full `packages/cloud-api/src/routes.ts` catalog includes contract-only surfaces; its presence does not establish application adoption. At baseline the app does not consume `/v1` instance management, managed Connections or managed remote command/enrolment routes.

`apps/site/src/lib/cloud-accounts/forward.ts:78–100` forwards account pages, `/api/auth/**`, `/api/account/**` and exactly `/api/instances`, `/heartbeat`, `/pending`, `/revoke`. It explicitly excludes managed Connections and does not include `/v1/**`. Browser navigation can redirect; bearer requests and API mutations proxy. Changing the global default origin would also reroute website feedback and marketplace reads, so origin separation is independent work.

### Retirement gates and ownership

- **DOR-1798:** reconcile current Connections programme ownership and shipped claims before adopting or deleting its legacy families. Each endpoint needs authenticated success/refusal fixtures, recovery evidence, actual deployment availability and an explicit compatibility window.
- **DOR-2442:** prepare inventory/fixtures now, but remove account implementation only after evidence of a full production release after handover with no rollback. Keep compatibility forwarding, managed Connections and retention cron until their own exit criteria are met. Unknown production evidence blocks deletion, not this bounded fix.
- **DOR-2086:** authoritative context can support later managed remote adoption. Command leases/acks, enrolment/withdrawal, credential rotation, capability gating and asleep UX still require their own implementation and negative/security tests.
- **DOR-2349:** credit this change for identity-bound local mint/read behavior and the focused stale-response/unlink lifecycle regressions; coordinate Community-owned recovery cells separately. Do not close the umbrella after one test suite or PR.
- Public contract proposals use `cloud-contract`. Implementation, app wiring, production rollout and end-to-end proof are four distinct evidence states; none substitutes for another.

## User Experience

The existing explicit credits selection action and report shape stay intact. With the paid flag off there are no Cloud requests. If identity cannot be resolved, the feature is not ready and local agent execution remains available. After unlink or a different link/origin, old credentials cannot make the UI report ready or populate a new launch environment. No new settings or machine enrolment prompt is introduced.

## Testing Strategy

Use deterministic fake transports and test-only state/context seams; no live service, real credential or paid flag may be enabled. Tests must fail on the old behavior and carry a purpose comment where the scenario is not self-evident.

- Resolve authoritative opaque ID and assert exact `/v1/session` → `/v1/inference/tokens` ordering, same bearer/origin, and mint body.
- Reject unauthenticated, person-only, missing/empty-ID, malformed, 404, 401 and network responses without a mint.
- Hold introspection/mint promises; change token, unlink or change origin; assert no obsolete mint dispatch/result/readiness/launch state.
- Resolve two concurrent attempts out of order; older completion cannot replace newer selection state.
- Rotate token while returning the same service ID; require new introspection and invalidate old launch state.
- Assert readiness and environment become unavailable on local-context mismatch, expiry and restart; failed refresh cannot revive obsolete state.
- Hold old heartbeat success/401 across relink and verify the new label, token, state and timer survive unchanged. Repeat A → unlink → A to prove the generation guard.
- Hold old managed-operation and authority-command 401 across relink; only a refusal from the current generation may withdraw its link.
- Hold remote revoke during explicit unlink; assert local withdrawal occurs before the promise settles, then establish a replacement link and verify revoke completion leaves it intact.
- Hold old device-poll completion across replacement/unlink and prove it cannot save credentials or schedule heartbeats. Preserve current-generation 401 and transient retry behavior.
- Assert the unarmed path performs zero introspection/mint requests, telemetry is never consulted, and BYO runtime behavior is unchanged.
- Preserve existing Cloud plan/route fixtures and targeted typecheck/lint checks. Independent REVIEW.md review precedes PR creation. No browser suite is necessary for unchanged UI structure; no CI change is proposed.

## Performance Considerations

One extra request per explicit mint is the deliberate cost of current authority confirmation. Runtime launch remains synchronous and network-free. No timer, background identity polling or persistent cache is added. Keep the existing request failure handling non-blocking for ordinary local work.

## Security Considerations

Capture credential and origin together; never combine identity obtained under one token with a later token. Treat returned identity as attribution under authenticated authority, never as a credential. Keep tokens and context predicates server-only. Preserve the module-scope paid decision and never use telemetry identity or host metadata as an authentication shortcut. Local context comparison cannot prove a remote revocation not yet observed, nor reverse a mint request already accepted by the service.

## Documentation

Keep this inventory and lifetime matrix with DOR-2348; update the stale helper comment by removing the obsolete helper. Proposed ADR `260928-001608` records the lasting authority/context distinction. Tracker completion notes must state which tests ran and which deployment/retirement gates remain unknown.

## Implementation Phases

1. Add context capture and authenticated session resolution with refusal/race tests.
2. Bind mint, memory state and readiness/launch reads to that context; remove caller-supplied identity/hash helper and update route tests.
3. Add CloudLinkManager generation guards and immediate local unlink with deterministic delayed-response tests. Credit these same tests to DOR-2349; do not create a duplicate recovery suite.
4. Run focused verification, independent review, normal PR/merge queue. Report the bounded slice separately from programme retirement work.

## Open Questions

- ~~Persist heartbeat ID or introspect per mint?~~ **(RESOLVED)** Per-mint session introspection, as selected by programme coordination. It needs no migration and confirms the `/v1` identity for the exact mint credential.
- ~~Reuse telemetry or token-derived identity during compatibility fallback?~~ **(RESOLVED)** Neither. Absence leaves this capability unavailable.
- ~~Retire old endpoints with this change?~~ **(RESOLVED)** No. The owner/release/deployment gates above are separate work; unresolved production evidence does not block the bounded client correction.

## Related ADRs

- [Resolve Cloud identity under the credential that will use it](../../decisions/260928-001608-resolve-cloud-identity-under-its-current-credential.md) — proposed by this specification.
- [Tier 1 telemetry returns to opt-in](../../decisions/260727-182651-tier-1-telemetry-returns-to-opt-in.md) — separate consent boundary remains intact.

## References

- [DOR-2348](https://linear.app/dorkspace/issue/DOR-2348)
- [Architecture roadmap](../../plans/architecture-improvement-roadmap.md), section D.
- [Public session contract](../../packages/cloud-api/src/session.ts)
- [Public instance contract](../../packages/cloud-api/src/instances.ts)
- [Cloud package contract documentation](../../packages/cloud-api/README.md)
