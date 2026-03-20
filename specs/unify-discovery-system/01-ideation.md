---
slug: unify-discovery-system
number: 94
created: 2026-03-06
status: ideation
---

# Unify Discovery System

**Slug:** unify-discovery-system
**Author:** Claude Code
**Date:** 2026-03-06
**Branch:** preflight/unify-discovery-system

---

## 1) Intent & Assumptions

- **Task brief:** Unify two separate agent discovery systems (onboarding SSE scan + mesh panel batch scan) into a single canonical implementation. Fix the critical bug where onboarding scans the wrong directory (project root instead of home). Eliminate DRY violations, make scan root resolution consistent, add SSE streaming to the Transport interface, and share scan state across features. Additionally, consolidate the three separate discovery UI experiences (onboarding checkbox selection, mesh "Discover Agents" button, mesh Discovery tab) into a single interaction model: per-agent approve/deny using `CandidateCard`. Delete the redundant `DiscoverAgentsSection` and onboarding `AgentCard`.

- **Assumptions:**
  - The mesh `discovery-engine.ts` strategy pattern and the standalone `discovery-scanner.ts` can be merged into a new unified scanner
  - The boundary (home dir) is an acceptable default scan root for onboarding
  - Adding `scan()` to the Transport interface is architecturally sound for both HttpTransport and DirectTransport
  - Shared Zustand state for discovery results is compatible with FSD layer rules (store lives in `entities/` or `shared/`)

- **Out of scope:**
  - Smart probing of common developer directories (~/Developer, ~/Projects, etc.) — future enhancement
  - requestAnimationFrame batching for high-frequency scan results — future optimization
  - Incremental re-scanning based on fs stat mtimes
  - Windows-specific developer directory paths
  - Per-root scan status in settings UI

## 2) Pre-reading Log

- `apps/server/src/services/discovery/discovery-scanner.ts`: Standalone BFS async generator (`scanForAgents`). Own `DiscoveryCandidate` type. 14 exclude patterns. No strategy pattern, no filtering of registered/denied agents.
- `packages/mesh/src/discovery-engine.ts`: BFS async generator (`scanDirectory`) with pluggable `DiscoveryStrategy` instances. Filters registered/denied paths. 11 exclude patterns (different from Scanner A). Supports symlink following, cycle detection.
- `packages/mesh/src/types.ts`: `DiscoveryStrategy` interface definition
- `apps/server/src/routes/discovery.ts`: SSE endpoint wrapping `scanForAgents`. Defaults to `DEFAULT_CWD` (the bug). Validates boundary.
- `apps/server/src/routes/mesh.ts`: Mesh routes including `POST /discover` (JSON, not SSE). Uses `meshCore.discover()`.
- `packages/mesh/src/mesh-core.ts`: `discover()` method wrapping `scanDirectory`. Handles multi-root scanning.
- `apps/client/src/layers/features/onboarding/model/use-discovery-scan.ts`: SSE hook using raw `fetch()` (bypasses Transport). Defines `ScanCandidate` type (third copy of the shape).
- `apps/client/src/layers/features/onboarding/ui/AgentDiscoveryStep.tsx`: Auto-starts `startScan()` with no root parameter on mount.
- `apps/client/src/layers/entities/mesh/model/use-mesh-discover.ts`: TanStack mutation using Transport. `useDiscoverAgents` — batch, not streaming.
- `apps/client/src/layers/entities/mesh/model/use-mesh-scan-roots.ts`: Reads `config.mesh.scanRoots`, falls back to boundary. The correct approach — but onboarding doesn't use it.
- `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx`: Mesh panel discovery UI with configurable roots + depth. Uses `useMeshScanRoots`.
- `packages/shared/src/transport.ts`: Transport interface has `discoverMeshAgents()` (batch JSON) but no SSE scan method.
- `apps/client/src/layers/shared/lib/http-transport.ts`: `discoverMeshAgents()` — simple POST JSON.
- `apps/client/src/layers/shared/lib/direct-transport.ts`: `discoverMeshAgents()` — throws "not supported in embedded mode".
- `packages/shared/src/mesh-schemas.ts`: `DiscoveryCandidateSchema` — the shared/canonical type.
- `packages/shared/src/config-schema.ts`: `mesh.scanRoots` is `z.array(z.string()).default([])`.
- `apps/server/src/lib/resolve-root.ts`: `DEFAULT_CWD` — prefers `DORKOS_DEFAULT_CWD`, falls back to repo root. Wrong default for discovery.
- `apps/server/src/lib/boundary.ts`: `initBoundary()` defaults to `os.homedir()` when not configured.
- `apps/server/src/services/core/mcp-tools/mesh-tools.ts`: `mesh_discover` MCP tool uses `meshCore.discover()` (Scanner B).
- `research/20260306_filesystem_discovery_unification.md`: Research on progressive vs batch UX, default roots, transport patterns, dedup strategies.

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                                     | Role                                                            |
| ------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `apps/server/src/services/discovery/discovery-scanner.ts`                | Scanner A — standalone BFS (to be replaced)                     |
| `packages/mesh/src/discovery-engine.ts`                                  | Scanner B — strategy-based BFS (to be replaced)                 |
| `apps/server/src/routes/discovery.ts`                                    | SSE discovery endpoint (to be updated)                          |
| `apps/server/src/routes/mesh.ts`                                         | Mesh routes incl. batch discover (discover route to be removed) |
| `apps/client/src/layers/features/onboarding/model/use-discovery-scan.ts` | Onboarding SSE hook (to be replaced)                            |
| `apps/client/src/layers/entities/mesh/model/use-mesh-discover.ts`        | Mesh batch discover hook (to be replaced)                       |
| `apps/client/src/layers/features/onboarding/ui/AgentDiscoveryStep.tsx`   | Onboarding UI (to be updated)                                   |
| `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx`              | Mesh discovery UI (to be updated)                               |
| `packages/shared/src/transport.ts`                                       | Transport interface (add scan method)                           |

**Shared Dependencies:**

- `packages/shared/src/mesh-schemas.ts` — canonical `DiscoveryCandidate` type
- `apps/client/src/layers/entities/mesh/model/use-mesh-scan-roots.ts` — scan root resolution
- `apps/server/src/lib/boundary.ts` — boundary (home dir) resolution
- `packages/mesh/src/types.ts` — `DiscoveryStrategy` interface

**Data Flow (current — two separate flows):**

```
Flow A (Onboarding — broken):
  AgentDiscoveryStep → useDiscoveryScan → raw fetch POST /api/discovery/scan
    → discovery-scanner.ts (root = DEFAULT_CWD ❌) → SSE events

Flow B (Mesh — works):
  DiscoveryView → useMeshScanRoots + useDiscoverAgents → transport.discoverMeshAgents
    → POST /api/mesh/discover → meshCore.discover → discovery-engine.ts → JSON
```

**Data Flow (target — unified):**

```
Both UIs → shared useDiscoveryScan hook → transport.scan()
  HttpTransport: → POST /api/discovery/scan → unified scanner → SSE events
  DirectTransport: → scanner directly → async generator events
  → Zustand discovery store ← both UIs read from here
```

**Feature Flags/Config:**

- `mesh.scanRoots` — user-configured scan roots (persisted in `~/.dork/config.json`)
- Boundary — defaults to `os.homedir()`, configurable via `DORKOS_BOUNDARY`

**Potential Blast Radius:**

- **Direct:** ~12 files (scanners, routes, hooks, transport, UI components)
- **Indirect:** MCP mesh_discover tool, mesh-core.ts discover method, tests
- **Tests:** 7+ test files across server/client/mesh

## 4) Root Cause Analysis

- **Repro steps:**
  1. Start DorkOS (fresh install or cleared config)
  2. See onboarding welcome screen
  3. Click "Get Started"
  4. Immediately see "No agents found"

- **Observed:** Scan completes in <1 second with zero results
- **Expected:** Scan takes several seconds and finds agents across the user's machine

- **Evidence:**
  - `AgentDiscoveryStep.tsx:56` — `startScan()` called with no arguments
  - `use-discovery-scan.ts:61` — sends `options ?? {}` (empty body)
  - `routes/discovery.ts:48` — `root: data.root ?? DEFAULT_CWD`
  - `resolve-root.ts:16` — `DEFAULT_CWD` resolves to repo root, not home dir

- **Root-cause hypotheses:**
  1. **Wrong default scan root** — `DEFAULT_CWD` is the project root, not the user's machine (**confirmed**)
  2. Scanner bug filtering out results — no, scanner logic is correct when given the right root
  3. SSE parsing failure — no, parsing works correctly

- **Decision:** Root cause is #1. The onboarding scan root defaults to the DorkOS project's own directory instead of the user's home directory.

## 5) Research

Research saved to `research/20260306_filesystem_discovery_unification.md`.

**Potential Solutions:**

**1. New unified scanner (chosen)**

- Combine Scanner B's strategy pattern + registered/denied filtering with Scanner A's broader exclude patterns
- Single async generator in `packages/mesh/` (or a new shared location)
- Pros: Clean design, best of both, single source of truth
- Cons: More work than just fixing the root default

**2. Keep Scanner B, delete Scanner A**

- Wrap `discovery-engine.ts` in SSE for the discovery route
- Pros: Less code to write, strategy pattern already exists
- Cons: Different exclude patterns would be lost

**3. Minimal fix — just pass correct root**

- Change `DEFAULT_CWD` to boundary in `routes/discovery.ts`
- Pros: 1-line fix, ships in minutes
- Cons: Doesn't address any DRY violations, transport bypass, or state sharing

**Recommendation:** Solution 1 — new unified scanner. Research confirms progressive streaming should be the universal mode. The scanner should combine Scanner B's strategies with Scanner A's more comprehensive exclude patterns. The batch mesh endpoint becomes a thin wrapper.

## 6) Decisions

| #   | Decision                         | Choice                              | Rationale                                                                                                                                                                      |
| --- | -------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Which scanner to keep            | New unified scanner                 | Combines best of both: Scanner B's strategy pattern + Scanner A's comprehensive exclude list. Clean slate avoids inheriting either's quirks.                                   |
| 2   | Default scan root for onboarding | Boundary (home dir)                 | Simple, guaranteed to find everything. Smart directory probing can be added later as an optimization. Boundary already defaults to `os.homedir()`.                             |
| 3   | Transport abstraction            | Add `scan()` to Transport interface | Async generator method on Transport. HttpTransport wraps SSE, DirectTransport calls scanner directly. Enables Obsidian plugin support. Consistent with hexagonal architecture. |
| 4   | State management                 | Shared Zustand store                | Onboarding scan results persist — mesh panel shows them immediately without re-scanning. Store lives in `entities/discovery/` or `shared/model/`.                              |
