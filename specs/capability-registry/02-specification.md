---
slug: capability-registry
id: 260723-013455
created: 2026-07-23
status: specified
---

# Capability Registry — one source of truth, projected everywhere

**Status:** Approved
**Author:** Claude (directed by Dorian)
**Date:** 2026-07-23
**Tracker:** DOR-428 - Agents as First-Class Operators — program umbrella (phase 2)

## Overview

A typed Capability Registry where each service domain declares what agents (and users) can do exactly once — id, description written for models, Zod input/output schemas, permission tier, handler — and from which every agent-facing surface is generated: both MCP servers, the CLI operator verbs, OpenAPI paths, and a self-description surface (`GET /api/capabilities`, `dorkos capabilities`, MCP resource). Phase 2 builds the spine, migrates the operator and marketplace domains as proof, and adds a conformance suite that makes advertised-but-broken and implemented-but-unprojected structurally impossible.

## Background / Problem Statement

Phase 1 (spec `agents-as-operators`) closed the drift between four hand-maintained projections, but by hand: adding a capability still means touching a descriptor table, two MCP registrations, a CLI verb, and (usually not) the OpenAPI registry. ADR 260723-013233 records the commitment: hand-registration until the registry, then generation with the phase-1 names as frozen contract. The descriptor tables shipped in phase 1 are the registry's embryo — this spec grows them into the real thing. Additionally, agents still cannot ask a running DorkOS "what can I do here?"; self-description exists only as static skills and docs.

## Goals

- One `defineCapability` call per capability; every projection derives from it.
- Byte-compatible preservation of phase-1 public contracts: MCP tool names + input schemas, CLI verb names/flags/output shapes, HTTP paths.
- A live self-description surface agents can query (versioned catalog: id, title, description, tier, input JSON Schema).
- A conformance suite failing CI when any registry entry lacks a handler, a test, or a projection — or when a projection contains an entry the registry doesn't know.
- Every entry carries an observe/act/destructive tier (declared now, enforced in phase 3).

## Non-Goals

- Migrating all ~33 route domains (only operator + marketplace move now; sessions/relay/mesh/tasks follow in later hygiene rounds).
- Tier enforcement, agent identity, approvals (phase 3).
- Removing the hand-authored curated CLI UX (human-facing table output stays hand-written; only dispatch internals generate).
- Client cockpit consumption of the catalog (future; the catalog shape is designed to allow it).

## Technical Dependencies

All internal: Zod v4 (already the schema layer), `zod-to-openapi` (already used by `openapi-registry.ts`), the two phase-1 descriptor tables, `runtimeConformance` as the conformance-suite pattern, `@dorkos/shared` for catalog types.

## Detailed Design

### 2.1 Registry core

New `apps/server/src/services/core/capabilities/` domain:

```ts
interface CapabilityDefinition<In extends z.ZodType, Out extends z.ZodType> {
  id: `${string}.${string}`; // "config.get", "marketplace.install"
  title: string; // human-facing
  description: string; // model-facing, ACI style
  tier: 'observe' | 'act' | 'destructive';
  input: In;
  output: Out;
  /** Stable phase-1 aliases this entry answers to (MCP tool name, CLI verb). */
  surfaces: {
    mcp?: { toolName: string; servers: ('in-session' | 'external')[]; readOnlyCarveOut?: boolean };
    cli?: { verb: string; subcommand?: string };
    http?: { method: HttpMethod; path: string }; // for OpenAPI projection
  };
  invoke(deps: CapabilityDeps, input: z.infer<In>): Promise<z.infer<Out>>;
}
```

Each domain exports `capabilities: CapabilityDefinition[]` (operator domain from `services/core/operator/`, marketplace from `services/marketplace-mcp/`). `composeRegistry(domains, deps)` builds the immutable runtime registry at boot; duplicate ids or duplicate surface names throw at startup. `CapabilityDeps` is the existing service-dependency bag pattern; domains receive only what they declare. Catalog types (the serializable subset: everything but `invoke`, schemas as JSON Schema via Zod's native conversion) live in `@dorkos/shared/capabilities` for CLI/client use.

### 2.2 Self-description

- `GET /api/capabilities/catalog` returns the catalog (errata 2026-07-23: the bare `/api/capabilities` path was already the per-runtime capability matrix, a live client contract; the catalog lives one segment deeper): `{ catalogVersion, generatedAt, capabilities: [{ id, title, description, tier, inputSchema, outputSchema, surfaces }] }`. `catalogVersion` is a content hash so agents can cache.
- `dorkos capabilities [--json]` renders it (table: id, tier, title; `--json` raw).
- MCP: `dorkos://capabilities` resource on the external server; a `list_capabilities` tool on both servers (observe tier).
- The `<dorkos_context>` system-prompt block and the `operating-dorkos` skill gain one line pointing at these (small follow-up edits, in scope).

### 2.3 MCP projection

`registerCapabilitiesAsMcpTools(registry, server, transport)` replaces the hand-walk of the two descriptor tables: for each entry with an `mcp` surface on that server, register `toolName` with the entry's description, Zod input, and an adapter from `invoke` to the `CallToolResult` shape (the phase-1 result-wrapping conventions preserved, including `sanitizedConfigSnapshot` semantics inside handlers — redaction stays in `invoke`, per ADR 260723-013236). The descriptor tables' content migrates into `CapabilityDefinition`s; the tables are then deleted (no tolerated legacy). `readOnlyCarveOut: true` GENERATES membership in `READ_ONLY_MCP_TOOL_NAMES` (the hand list becomes derived + drift-guard flips to asserting equality with the registry).

### 2.4 CLI projection

The operator verbs keep their exact command surface but dispatch through capability ids: each verb maps flags → capability input, calls the server, renders. A generic escape hatch `dorkos call <capability-id> [--input <json>|--input-file <path>] --json` invokes any registered capability (agents' universal path to capabilities without a curated verb). Human-facing rendering stays hand-written per verb.

### 2.5 OpenAPI projection

Registry entries with an `http` surface auto-register into the existing zod-to-openapi document (tag per domain). The operator domain's tools thereby appear in `/api/docs` for the first time. The legacy hand-registered paths are untouched; a follow-up hygiene item (tracked, not in scope) migrates them domain-by-domain.

### 2.6 Conformance suite

`capabilityConformance(registry)` in `@dorkos/test-utils` (pattern: `runtimeConformance`), asserting for every entry: invoke works against fakes (each domain supplies a deps fixture); both MCP servers expose exactly the declared tool surfaces (no more, no fewer — catches orphaned hand registrations); CLI verb map covers every declared cli surface; every entry has a tier and an ACI-style description (non-empty, imperative-lint heuristic); the read-only carve-out equals the registry derivation. Wired into the server test suite per-PR.

## User Experience

Unchanged for end users. For agents: `dorkos capabilities` / `list_capabilities` answers "what can I do here?" with live truth; `dorkos call` reaches every capability uniformly. For contributors: adding a capability is one `defineCapability` in the owning domain plus tests — MCP/CLI/OpenAPI/self-description appear automatically, and forgetting anything fails conformance in CI.

## Testing Strategy

- Unit: registry composition (dup detection, catalog serialization, hash stability), each migrated capability's invoke (existing handler tests re-pointed, not rewritten).
- Conformance: §2.6, per-PR.
- Regression: existing MCP tool tests (marketplace + operator, both servers) must pass unchanged against generated registration — they are the byte-compatibility proof.
- Evals: the quarantined operate-DorkOS cases run unchanged (tool names preserved); add one new quarantined case: agent asked "what can you do in DorkOS?" must invoke `list_capabilities` (discovery proof).

## Performance Considerations

Registry composes once at boot (microseconds); catalog serialization cached by content hash. Generated MCP registration is the same count of tools as today — no context change until curation work (later phase) uses tiers to slim the default set.

## Security Considerations

No new surface: generated tools inherit the exact auth posture of today (4-tier external MCP auth; carve-out now derived rather than hand-listed, which removes a failure mode where a mutating tool is accidentally hand-added to the read-only list). `dorkos call` is subject to the same server auth as every CLI verb. Tier declarations are inert metadata until phase 3 — they must not be presented as enforcement anywhere user-facing.

## Documentation

`contributing/agent-operator-surface.md` rewritten around the registry ("how to add a capability" becomes the defineCapability recipe); CLI reference gains `capabilities` + `call`; changelog fragments per PR.

## Implementation Phases

Single phase (this spec is itself phase 2 of the program); decomposition in `03-tasks.json`.

## Open Questions

- ~~Where do catalog types live?~~ **(RESOLVED)** `@dorkos/shared/capabilities` subpath. Rationale: CLI and (later) client need the serializable shape without server imports.
- ~~Does `dorkos call` bypass curated verbs' UX?~~ **(RESOLVED)** It complements them: curated verbs for humans, `call` for agents/scripts. Rationale: ACI principle — one canonical machine path, thin human sugar.
- ~~Migrate `READ_ONLY_MCP_TOOL_NAMES` or derive it?~~ **(RESOLVED)** Derive from `readOnlyCarveOut` flags; drift-guard asserts equality. Rationale: the hand list caused phase 1's critical near-miss class.

## Related ADRs

ADR 260723-013233 (CLI-first, registry commitment — this spec discharges it), 260723-013236 (redaction invariant — preserved inside invoke), 0227 (external MCP gating), ADR-0185 (knowledge injection — self-description pointer added).

## References

- `research/20260722_agents-as-first-class-operators.md` (Pillar 1; Home Assistant `async_get_tools` precedent)
- `specs/agents-as-operators/02-specification.md` (phase 1; frozen contracts)
- `apps/server/src/services/marketplace-mcp/marketplace-tool-descriptors.ts`, `apps/server/src/services/core/operator/operator-tool-descriptors.ts` (the embryo)
- `packages/test-utils/src/runtime-conformance.ts` (conformance pattern)
