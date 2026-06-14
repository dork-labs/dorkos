---
number: 256
title: RuntimeCapabilities Shape — Booleans + Structured Permission Modes + `features` Extension Point
status: accepted
created: 2026-04-16
spec: codex-runtime-adapter-prework
superseded-by: null
---

# 0256. RuntimeCapabilities Shape — Booleans + Structured Permission Modes + `features` Extension Point

## Status

Accepted

## Context

`RuntimeCapabilities` currently is a flat boolean bag (`supportsPermissionModes`, `supportsToolApproval`, `supportsCostTracking`, `supportsResume`, `supportsMcp`, `supportsQuestionPrompt`). Research 20260315_agent_runtime_permission_modes found that Claude and Codex have demonstrably different permission-mode models — more than a boolean can express. Multiple future runtimes are expected beyond Codex, so the shape needs to be additive and extensible without forcing every runtime + client consumer to migrate simultaneously.

## Decision

Keep booleans for genuinely-boolean capabilities (`supportsResume`, `supportsMcp`, `supportsCostTracking`, `supportsToolApproval`, `supportsQuestionPrompt`). Promote `permissionModes` to a structured `{ supported: boolean, values: PermissionModeDescriptor[] }`. Add a typed `features: Record<string, unknown>` extension point for runtime-specific metadata that does not fit the common shape. Clients gate common behavior off common fields; runtime-specific UI reads `features` explicitly under a capability check.

## Consequences

### Positive

- Targeted richness where runtimes actually differ (permission modes), cheap expression elsewhere.
- The `features` escape hatch lets a 4th/Nth runtime declare runtime-specific metadata without a schema change on the shared contract.
- Migration to the new shape is additive; existing runtime implementations update incrementally.

### Negative

- `features` as a `Record<string, unknown>` sacrifices some type safety at the capability boundary; runtime-specific UI must validate what it reads.
- Two coexisting patterns (structured permission modes vs flat booleans) require documentation of when to promote a field vs leaving it as a boolean.
- Risk of the `features` hatch absorbing concerns that should have been first-class capability fields — needs occasional curation.
