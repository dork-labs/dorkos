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

We will compose one immutable registry at boot (`composeDorkOsCapabilityRegistry`: operator + marketplace + self-description domains) with startup-throws on duplicate ids, duplicate surface names, domain-prefix mismatches, and missing domain deps. Capability `invoke` returns plain typed data; transport adapters own envelope wrapping (MCP `CallToolResult`, HTTP, CLI). `READ_ONLY_MCP_TOOL_NAMES` is derived from `readOnlyCarveOut` flags, never hand-listed. **(True only of the migrated domains; see Errata, 2026-07-26.)** MCP annotations that vary within a tier (`openWorldHint`, `idempotentHint`) ride an explicit passthrough so generation is lossless. A parallel `composeCapabilityRegistryForDocs` (same domain constants, projection-only deps) feeds the static OpenAPI export; the conformance suite (`capabilityConformance` in `@dorkos/test-utils`, proven falsifiable by seeded-drift tests) asserts docs/boot parity, both-direction MCP surface equality, tier and carve-out consistency, and description quality on every PR.

## Consequences

### Positive

- Adding a capability is one `defineCapability` plus tests; MCP (both servers), OpenAPI, self-description, and CLI reachability appear by generation, and forgetting a projection fails CI.
- The hand-list class of security drift (the phase-1 near-miss) is structurally dead: the carve-out cannot disagree with the registry. **(Overstated as written; see Errata, 2026-07-26.)**

### Negative

- Two compositions (boot + docs) must keep importing the same domain constants; parity is test-enforced, not type-enforced.
- Most capability `output` schemas are still `z.unknown()` (empty response schemas in the catalog); tightening is tracked, per-capability work.

## Errata (2026-07-26)

Two claims above describe an end state as though it had already arrived. The mechanism they describe is real, but it covers part of the surface, not all of it, and the difference is exactly the part a security reader cares about.

1. **"never hand-listed" is false of the constant as a whole.** `READ_ONLY_MCP_TOOL_NAMES` is a union of two sources (`apps/server/src/services/core/external-mcp/tool-security.ts:80-87`): the registry-derived names from the operator, marketplace, and self-description domains, and `LEGACY_READ_ONLY_TOOL_NAMES`, which is 18 tool names written out literally (`tool-security.ts:44-69`). The drift-guard test pins the whole set at 28 members (`__tests__/tool-security.test.ts:134`), so 18 of the 28 are hand-listed today. The domains still hand-registering their read-only tools are core, tasks, binding, agent-extension, mesh, and relay (`tool-security.ts:24-27`); derivation applies as claimed only to the domains already migrated onto the registry.

2. **"structurally dead" overstates what protects the carve-out.** For a hand-listed name, the carve-out and the live server can still disagree, so the drift is prevented by a test rather than made impossible by construction. What is true, and worth keeping: the failure is fail-closed, because a name absent from the set is treated as guarded and therefore requires a token (`tool-security.ts:11-15`), and the drift-guard test compares the constant against the live `tools/list` annotations in both directions, so a disagreement fails the build (`__tests__/tool-security.test.ts:137-169`). That is a maintained guard with a real backstop, not a structural impossibility, and the distinction should not be lost when someone cites this ADR to argue a new hand-listed tool is safe.

The decision itself stands. The claims become true for a domain as that domain migrates onto the registry, which is the tracked follow-up; until `LEGACY_READ_ONLY_TOOL_NAMES` is empty, describe the guard as hand-maintained and test-enforced.
