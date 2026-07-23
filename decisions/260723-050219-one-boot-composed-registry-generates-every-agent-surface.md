---
id: 260723-050219
title: One boot-composed capability registry generates every agent-facing surface
status: accepted
created: 2026-07-23
spec: capability-registry
superseded-by: null
---

# 260723-050219. One boot-composed capability registry generates every agent-facing surface

## Status

Accepted

## Context

ADR 260723-013233 committed to a Capability Registry subsuming phase 1's hand-registered tool tables. Phase 2 shipped it. The design questions settled during implementation: where composition happens, what handlers return, how the read-only security list is maintained, and how the static docs export relates to the live server.

## Decision

We will compose one immutable registry at boot (`composeDorkOsCapabilityRegistry`: operator + marketplace + self-description domains) with startup-throws on duplicate ids, duplicate surface names, domain-prefix mismatches, and missing domain deps. Capability `invoke` returns plain typed data; transport adapters own envelope wrapping (MCP `CallToolResult`, HTTP, CLI). `READ_ONLY_MCP_TOOL_NAMES` is derived from `readOnlyCarveOut` flags, never hand-listed. MCP annotations that vary within a tier (`openWorldHint`, `idempotentHint`) ride an explicit passthrough so generation is lossless. A parallel `composeCapabilityRegistryForDocs` (same domain constants, projection-only deps) feeds the static OpenAPI export; the conformance suite (`capabilityConformance` in `@dorkos/test-utils`, proven falsifiable by seeded-drift tests) asserts docs/boot parity, both-direction MCP surface equality, tier and carve-out consistency, and description quality on every PR.

## Consequences

### Positive

- Adding a capability is one `defineCapability` plus tests; MCP (both servers), OpenAPI, self-description, and CLI reachability appear by generation, and forgetting a projection fails CI.
- The hand-list class of security drift (the phase-1 near-miss) is structurally dead: the carve-out cannot disagree with the registry.

### Negative

- Two compositions (boot + docs) must keep importing the same domain constants; parity is test-enforced, not type-enforced.
- Most capability `output` schemas are still `z.unknown()` (empty response schemas in the catalog); tightening is tracked, per-capability work.
