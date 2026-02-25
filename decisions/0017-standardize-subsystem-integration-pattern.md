---
number: 17
title: Standardize Subsystem Integration Pattern Following Pulse
status: proposed
created: 2026-02-24
spec: relay-server-client-integration
superseded-by: null
---

# 0017. Standardize Subsystem Integration Pattern Following Pulse

## Status

Proposed (auto-extracted from spec: relay-server-client-integration)

## Context

DorkOS is adding its second major subsystem (Relay) alongside the first (Pulse). Both subsystems need the same cross-cutting concerns: feature flags, conditional route mounting, MCP tool registration with guard functions, config schema extensions, and client-side entity hooks with feature UI. Without a consistent pattern, each subsystem would evolve its own approach to initialization, dependency injection, and lifecycle management, making the codebase harder to navigate and extend.

## Decision

All new DorkOS subsystems follow the established Pulse integration pattern exactly:

1. **Feature flag:** Module-level state holder (`{name}-state.ts`) with `set{Name}Enabled()`/`is{Name}Enabled()` functions
2. **Config schema:** Add section to `UserConfigSchema` with `enabled: boolean` + subsystem-specific fields
3. **Environment variable:** `DORKOS_{NAME}_ENABLED` in `turbo.json` `globalPassThroughEnv`
4. **Initialization:** Check env var OR config in `index.ts`, conditionally create service instance
5. **Dependency injection:** Add optional service to `McpToolDeps` interface, spread into `createDorkOsToolServer()`
6. **Route mounting:** `create{Name}Router(service)` factory function, conditionally mounted in `index.ts`
7. **MCP tools:** `require{Name}()` guard function returning structured error when disabled
8. **Config route:** Add `{name}: { enabled: is{Name}Enabled() }` to GET `/api/config` response
9. **Client entity:** `use{Name}Enabled()` hook reading from config query cache
10. **Client feature:** Panel component with disabled/loading/active states, rendered in `ResponsiveDialog`

## Consequences

### Positive

- New subsystems are predictable — developers know exactly where to find initialization, routes, tools, and UI
- Copy-paste bootstrapping reduces errors when adding new subsystems
- Consistent feature flag behavior across all subsystems

### Negative

- Locks in a specific architecture that may not suit all future subsystems equally well
- Pattern duplication across subsystems (similar but not identical code in each `*-state.ts`, route factory, etc.)
