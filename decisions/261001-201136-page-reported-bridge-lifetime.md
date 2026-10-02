---
id: 261001-201136
title: 'Keep browser bridge evidence page-reported and bind its lifetime'
status: accepted
created: 2026-10-01
spec: canvas-bridge-lifetime
superseded-by: null
---

# 261001-201136. Keep browser bridge evidence page-reported and bind its lifetime

## Status

Accepted design, extracted from spec: canvas-bridge-lifetime. Independent design re-review by `/root/bridge_spec_adversarial` (GPT-6.1 Sol / Medium) found no remaining freeze blockers. This status records the decision, not completed implementation or runtime proof.

## Context

The browser capture shim executes in the preview page's JavaScript world. Source identity and origin checks identify its frame, not the script that authored a report. A page can observe initialization messages and imitate the shim, while delayed requests and batches can outlive the document/session they were issued under. Existing server bounds do not prevent unsolicited results from changing host recording state or screenshot storage.

## Decision

Treat console, network, outline, action and image results as explicitly untrusted page-reported evidence. Use a host-owned generation, eligible-frame resolution, browser-safe bounded payload projection and host pending-request admission to contain reports to their assigned lifetime. Bind generation-aware server waiters to client/document/generation while retaining request-ID lookup for canonical session rekey compatibility. A nonce or message port is correlation only; stronger script authenticity requires a separate execution world outside this scope. Reporting grants no DorkOS capability and is distinct from Doc Channel grants. Preserve old-open-host/new-shim interoperability through an explicit initial legacy ack mode; an updated host and a generation-bound shim cannot downgrade. Track one active-or-finishing recording job across generations, cancel and dispose it after every asynchronous boundary, and limit decoded dimensions separately from compressed bytes. A half-size encoding retry derives from retained normalized pixels after compressed input strings are released, replaces buffers sequentially, and never requires a second full decode or recapture.

## Consequences

### Positive

- Old asynchronous work, unrelated windows and unsolicited replies cannot change a new preview's buffers.
- Tools state the actual source of their evidence instead of implying independent verification.
- Parent and server limits apply before their respective retention/forwarding operations.
- Old-open-host telemetry, actions and captures, plus canonical session rekey, remain supported without downgrade of bound requests.

### Negative

- Current-page forgery and suppression remain possible and must stay disclosed.
- Generation, correlation and explicit legacy paths add ephemeral protocol state and temporal tests.
- A non-abortable finishing encoder holds its bounded job slot until it returns; new recording starts may be refused until disposal.
- Admission/buffer limits can drop evidence and need honest truncation reporting.
- Host validation cannot remove the browser's earlier structured-clone or hostile-page CPU cost.

- An old open host recording upload that omits its pinned document is refused rather than weakening bound upload admission. The compatibility matrix covers telemetry, actions and captures.
