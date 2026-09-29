---
slug: managed-remote-app-consumer
number: 260928-005336
created: 2026-09-28
status: draft
---

# Use managed remote access in the local app

**Work item:** DOR-2086

**Evidence baseline:** `5794f638160a68811382347356fd29b31ee2e911`

**Scope:** Public app and `@dork-labs/cloud-api` only. No service deployment, enrollment, spending, or rollout is implied.

## Intent

A person who has linked this DorkOS instance to Cloud can explicitly choose managed remote access on the machine that runs it. The app then opens, closes, recovers, and reports its managed tunnel while keeping the existing bring-your-own (BYO) ngrok path available. The person can withdraw managed access locally even when Cloud is unreachable. The app must never infer consent from a linked credential, an entitlement, or a saved BYO preference.

The current product has one ngrok manager and one BYO settings flow. `TunnelManager.start()` already calls `ngrok.forward`; the accepted Cloud handoff retains that call and supplies a different credential, domain, and lifecycle. A second ngrok implementation is unnecessary. The work is to make the choice and authority explicit around that call, let one managed mode own every hostname Cloud authorizes, then adapt the shared remote-access surfaces to the selected mode.

## Public evidence and current seams

- `packages/cloud-api/src/remote.ts` and `src/routes.ts` publish managed status, open/close, wake tokens, enrolment response and withdrawal response, canonical address, credential issue/confirm, SSE commands with lease acknowledgements, and idempotent activity batches. Rotation uses the command's `credentialId` as the issue idempotency key; `RemoteCredential.hosts`, when present, is the complete hostname set. The event batch key is an `Idempotency-Key` request header.
- `packages/cloud-api/src/session.ts` can identify the instance authenticated by the current Cloud credential. DOR-2348's accepted identity-context work is a prerequisite, not evidence that managed remote is already implemented or deployed.
- `apps/server/src/services/core/tunnel-manager.ts`, `config/tunnel-settings.ts`, `routes/tunnel.ts`, and `index.ts` own the current ngrok lifecycle. BYO autostart and its environment/config precedence must remain intact. `canExpose()` requires local login and an owner before either mode exposes the app.
- `apps/server/src/services/core/credential-provider.ts` has an encrypted, never-echo file credential store. Current `tunnel.authtoken` and `cloud.instanceToken` live in config; managed tunnel material needs its own encrypted reference and a semver-keyed config migration. It must not overwrite either existing token.
- `RemoteAccessTab` renders `TunnelPanel`; the Control Center row, beacon, panel, and command palette share `entities/tunnel`. All currently assume a BYO token and a single `TunnelStatus`. A managed state needs one shared client report and action path so these surfaces agree.
- `packages/cloud-api/README.md` deliberately excludes the closed-address browser page served while a machine sleeps. Its look and authorized reopen behavior require supplier acceptance, not a fabricated app route or new public schema.

## Alternatives considered

1. **Replace BYO with managed remote.** Rejected: it removes a working self-hosted path and would make Cloud availability a prerequisite for remote access.
2. **Run independent BYO and managed tunnel managers.** Rejected: the modes could compete over the app's exposure and give the UI conflicting truth. Extend the existing manager with an explicit mode and source of credential while keeping `ngrok.forward` as the forwarding operation. Managed mode may own more than one host-specific listener when Cloud's complete host set requires it.
3. **Build a generic remote framework before enrollment works.** Rejected: it creates security-sensitive, unexercised code. The first implementation slice must make an explicit local enrollment and withdrawal useful through a fake Cloud transport after the public enrollment and ingress-proof contracts are available.
4. **Treat linking or an entitlement as consent.** Rejected: neither proves a person on this machine requested exposure. Entitlement decides capability; consent is a separate local action and Cloud record.

## Decisions for specification

| Question                            | Direction                                                                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who may enroll?                     | A signed-in human on the machine, through a local-only, cookie-checked action. Cloud must separately receive the person-session consent its contract requires. The public request/ceremony is unresolved. |
| What owns the tunnel?               | One existing `TunnelManager`, with mutually exclusive BYO and managed operation and the same exposure guard. Managed mode serves every authorized host, with a listener per host if required.             |
| Where does the managed secret live? | One-time Cloud value in the encrypted local credential store; config stores only a reference and non-secret selection/recovery metadata.                                                                  |
| What if Cloud disappears?           | The app keeps local withdrawal available. A temporary command-stream outage does not silently relabel a live tunnel as off; observed revocation and context change disable managed operation.             |
| What does the browser know?         | Mode, state, URL, safe reason, timing, and capability only. No instance key, tunnel credential, lease token, proof secret, or Cloud bearer.                                                               |
| What establishes completion?        | Offline fake-transport/security tests first; deployed Cloud conformance and real closed-address behavior separately.                                                                                      |

## Exact supplier questions

1. `RemoteEnrolmentSchema` describes the response only. Publish the POST request schema and fixtures: how the request names or resolves the instance, where the consent text/version comes from, how a locally authenticated human completes the required Cloud person-session action, and the idempotent/recovery behavior after a lost response. Publish the authorization and target semantics for DELETE as well. An instance API key is not a substitute for a person session.
2. Publish the managed ingress proof contract shared between the Cloud edge and local app: header name, secret issue/rotation and storage, issuer verification, behavior when the header is absent, malformed, repeated, or supplied by an outside caller, and how the edge strips caller-supplied copies. No proof header or issuer is defined in the public package today.
3. The declared command transport is SSE. If the service also supports long polling, publish that mode's route, request/response, lease, and retry contract before the app implements it. SSE alone is enough to design the initial consumer. Confirm replay/lease-expiry behavior for a reconnect with an unacknowledged command; the app will make effects idempotent and persist pending acknowledgements regardless.
4. Confirm the active deployment serves the published routes and returns authenticated success and refusal examples, including enrollment, withdrawal, issue/confirm, command redelivery, and ingress-proof rejection. A route catalog or fixture alone is not deployment evidence.

The existing handoff says managed credentials and domains go to the current `ngrok.forward` call. This document does not reopen that transport choice. It also does not derive plan names or prices from entitlements.

## Cohesive delivery

The first shippable app slice joins explicit enrollment, encrypted credential issue/confirm, a minimal SSE `open`/`close` command and acknowledgement path, the guarded managed tunnel, local withdrawal, and a truthful shared UI. Enrollment alone does not open a listener: the Cloud command or a published person-session open action must request it. The enrollment route and its fake Cloud responses must wait for the published request/ceremony; neither may guess a body. After both the enrollment and ingress-proof contracts are published, build this slice against the agreed fake Cloud fixtures. Keep it unavailable to production users until deployed acceptance is complete. The next slice hardens durable acknowledgement and recovery and adds rotation/revocation, idle/drain, and activity reporting. Both slices must retain BYO behavior and prove cross-mode exclusion.

It is useful to land DOR-2348's identity-context repair independently. No DOR-2086 app-code slice is independently useful before the enrollment and ingress-proof contracts: a managed authority object, proof middleware, background poller, or config field alone would sit dormant while no person can enroll and exercise the path. These documents and the public contract questions are the useful work now. The specification defines the full app target so decomposition can follow the contract gates without losing the end-to-end behavior.
