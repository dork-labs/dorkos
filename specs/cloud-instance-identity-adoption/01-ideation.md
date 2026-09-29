---
slug: cloud-instance-identity-adoption
number: 260928-001608
created: 2026-09-27
status: ideation
---

# Adopt authoritative Cloud instance identity

**Author:** Codex
**Work item:** DOR-2348
**Evidence baseline:** `5794f638160a68811382347356fd29b31ee2e911`

## 1) Intent & Assumptions

The operator selected DOR-2348 after the initial Cloud implementation. Define the identity lifecycle and remaining endpoint/origin boundaries, then implement a bounded first consumer: inference-token minting must use the identity the service assigns the presented credential. Existing local execution stays independent of Cloud.

The accepted direction from programme coordination is per-mint `/v1/session` introspection against an immutable credential/origin snapshot, without a persistent identity field, cache, config migration, new registration protocol, or telemetry access. This uses an existing public contract; deployment support remains a separate fact. Remote enrolment, paid-flag changes, global origin changes, Connections migration, account retirement, are outside this implementation. Programme coordination subsequently included bounded CloudLinkManager stale-response repairs as Phase 2.

## 2) Pre-reading Log

- `apps/server/src/services/core/cloud/v1-client.ts`: hashes the linked token as an instance reference; constructs each client with the configured origin and current token.
- `packages/cloud-api/src/session.ts`: `/v1/session` can report the authenticated credential's `instanceId`; a person session may omit it.
- `apps/server/src/services/core/auth/cloud-link-client.ts`: legacy heartbeat already returns a service-issued ID. Its response is cast, not schema-validated.
- `apps/server/src/services/core/auth/cloud-link.ts` and `packages/cli/src/commands/cloud-commands.ts`: discard the heartbeat ID; manage token lifetime independently.
- `apps/server/src/services/core/cloud/credits-inference.ts`: mint result stays in process memory; existing reads check expiry but not the current link.
- `packages/shared/src/config-schema.ts`: token/name/account-label only; no authoritative identity field.
- `apps/site/src/lib/instance-service.ts`: legacy device approval creates a registration; heartbeat resolves it from authenticated key metadata and verifies ownership.
- `apps/site/src/lib/cloud-accounts/forward.ts`: account handover is a route allowlist, not a `/v1` forwarding rule.
- `decisions/260727-182651-tier-1-telemetry-returns-to-opt-in.md`: telemetry identity cannot become an incidental authentication identifier.

## 3) Codebase Map

The bounded path is local `/api/cloud/credits/select` → Cloud client seam → `/v1/session` → `/v1/inference/tokens` → in-memory inference state → runtime launch environment. `DORKOS_CLOUD_CREDITS` remains read at module scope and must be enabled alongside a linked credential before any request. The implementation changes the server Cloud seam, credits state and route call, then guards CloudLinkManager lifecycle responses, with focused tests. No config, database, CLI or client schema changes are required.

The full baseline caller inventory and identity lifetime matrix are carried into the specification. Neither the public route catalog nor implementation elsewhere proves that a configured deployment serves a route.

## 4) Root Cause Analysis

At baseline, `cloudInstanceRef()` computes SHA-256 over the token and `/credits/select` supplies that digest as `instanceId`. Credential replacement changes it even if the service registration stays the same. The helper comment incorrectly claims no service response supplies an ID: legacy heartbeat does, and the current `/v1/session` schema also carries it. Separately, a minted inference token can remain ready after the local link changes because its stored state is not bound to the credential/origin that minted it.

## 5) Research

1. **Persist heartbeat identity:** obtains an already-returned ID and permits synchronous reads, but needs config migration, server/CLI parity, response validation and stale-write protection. It does not establish that the `/v1` deployment accepts the identity under the presented credential. Defer until a consumer needs persisted identity.
2. **Introspect per mint:** uses the existing `/v1/session` contract, proves identity for the exact credential/origin about to mint, and upgrades existing configs lazily. It costs an additional request and cannot mint during introspection outages. Selected for this bounded consumer.
3. **Keep token hash or reuse telemetry ID:** token hash identifies credential material, while telemetry identity has separate consent/lifetime semantics. Neither proves the service's registration. Reject both.

## 6) Decisions

| Decision             | Choice                                                               | Rationale                                                  |
| -------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------- |
| Authority            | Service-issued `instanceId` from authenticated `/v1/session`         | Uses the same authority and credential as minting          |
| Storage              | No new persistent ID or cache                                        | Avoid migration and stale identity recovery complexity     |
| Link changes         | Discard obsolete resolution/mint results and invalidate launch state | Prevent one account/origin's state surviving a new link    |
| Missing capability   | Fail closed for identity-dependent minting                           | Local execution remains available without guessed identity |
| Programme boundaries | Separate origins, legacy retirement and remote adoption              | Each has different owners and release evidence             |

No further clarification is needed for this bounded choice; programme coordination supplied the decision. Next stage: SPECIFY, followed by independent review and decomposition.
