# Cloud instance identity adoption — tasks

DOR-2348 checklist; no new issues. Canonical source: `03-tasks.json`. Implementation tasks are complete; independent review and merge verification remain in progress. Tracker projection is owned by the coordinating session.

### Task 1.1: Resolve authoritative identity with a captured context

- [x] Complete and verify.

Dependencies: none.

In apps/server/src/services/core/cloud/v1-client.ts capture one nonempty linked credential and normalized Cloud base URL, with a currency predicate that also incorporates a process-local link generation when available. Build a client from those exact values. Resolve V1_ROUTES.session with SessionSchema; require authenticated true and a nonempty instanceId. Reject person sessions, absent/malformed IDs, 401/404/network failure and obsolete responses; never consult telemetry or persist identity. Tests use deferred fake transport responses and show token/origin changes prevent usable resolution. Keep createCloudV1Client callers compatible. Remove cloudInstanceRef only when the credits caller is migrated. No config migration or external request is authorized. Observe token changes through ConfigManager.onChange or an equivalent shared generation source so A → null → A between reads is detected. Explicit manager generation invalidates same-token replacement. Own and dispose any change listener; repeated resolution must not accumulate listeners.

### Task 1.2: Bind inference minting and launch state to its context

- [x] Complete and verify.

Dependencies: 1.1.

Make primeCreditsInference accept no caller instanceId. Check module-scope DORKOS_CLOUD_CREDITS before any request. Resolve /v1/session then POST the authoritative instanceId to /v1/inference/tokens on the same captured client. Recheck currency before dispatch and before retaining results. Store minted token with its context; live readiness and creditsTurnEnv must discard mismatched or expired state. Ensure an earlier concurrent attempt cannot replace a newer selection. A failed refresh may retain an unexpired token only under the same current context. Remove cloudInstanceRef and update routes/cloud.ts to call the new seam. Tests prove exact identity/order/bearer, rejection without mint, in-flight relink/origin change rejection, out-of-order completions, disabled zero-network behavior and unchanged BYO behavior. Never arm a paid flag for tests.

### Task 2.1: Guard link responses with lifecycle generations

- [x] Complete and verify.

Dependencies: 1.2.

In apps/server/src/services/core/auth/cloud-link.ts add a monotonic process-local link generation. Advance it before awaits on flow supersession and withdrawal. Capture generation and credential for heartbeats, managed requests, authority-command submit/read and device polls; stale success/401/completion cannot change state, labels, token or timers. Preserve current-generation 401 withdrawal and transient retry. Include A → unlink → A: equal token values must not revive stale work. Make generation observable through a server-only seam for inference context; do not add config fields or modify server composition ownership. Deterministic deferred tests must cover old success/401 after new link, old managed and authority 401, old poll success, current refusal and transient failure.

### Task 2.2: Withdraw locally before awaiting remote revoke

- [x] Complete and verify.

Dependencies: 2.1.

On CloudLinkManager.unlink capture retiring credential, advance generation, cancel poll, stop timers, clear local config/timestamp and set idle before any await. Reconcile managed registration from withdrawn state. Send best-effort remote revoke with captured old credential; response must never clear or reschedule a replacement link. Hold revoke pending in tests and assert immediate local withdrawal, establish a new link, then settle revoke and prove new state survives. Repeat same-token replacement and assert stored inference state cannot return. Keep remote revoke protocol unchanged and document its legacy session-only mismatch; local clearing does not prove remote revocation. Credit these tests to DOR-2349 rather than duplicating a broad suite.

### Task 3.1: Verify and independently review the bounded adoption

- [ ] Complete and verify.

Dependencies: 2.2.

Run focused Cloud seam, credits, link-manager and route tests with fake transports, then appropriate server typecheck and lint. Inspect diff for telemetry access, private material, paid flags, new config fields and accidental origin changes. Obtain independent REVIEW.md review and resolve findings before PR creation. Update the proposed ADR only when implementation actually reflects it. Report exact tests and deployment limitations; use normal PR and merge queue, and do not claim DOR-1798/2442/2086/2349 complete from this slice. No production enrollment, deployment or spend is authorized by this task.
