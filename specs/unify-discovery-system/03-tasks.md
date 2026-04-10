# Task Breakdown: Unify Discovery System

Generated: 2026-03-06
Source: specs/unify-discovery-system/02-specification.md
Last Decompose: 2026-03-06

## Overview

Unify two separate agent discovery scanners (onboarding SSE scan and mesh panel batch scan) into a single canonical implementation. Fixes the critical bug where onboarding scans the wrong directory (project root instead of home directory). Adds `scan()` to the Transport interface and shares discovery state across features via a Zustand store.

## Phase 1: Foundation

### Task 1.1: Create unified scanner types and exclude set

**Size**: Small | **Priority**: High | **Dependencies**: None | **Parallel with**: None

Create `packages/mesh/src/discovery/types.ts` with `ScanEvent`, `ScanProgress`, `UnifiedScanOptions` types and the `UNIFIED_EXCLUDE_PATTERNS` constant (superset of 20 patterns from both scanners). Create barrel at `packages/mesh/src/discovery/index.ts`.

### Task 1.2: Implement unified scanner async generator

**Size**: Large | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: None

Create `packages/mesh/src/discovery/unified-scanner.ts` combining Scanner B's strategy pattern, registry/denial filtering, and symlink cycle detection with Scanner A's timeout support, progress events (every 100 dirs), and complete event. BFS algorithm with EACCES/EPERM error handling. 10 unit tests covering candidates, auto-import, denied paths, maxDepth, progress, timeout, excludes, symlink cycles, and error handling.

### Task 1.3: Update MeshCore.discover() to use unified scanner

**Size**: Medium | **Priority**: High | **Dependencies**: 1.2 | **Parallel with**: None

Change `MeshCore.discover()` return type from `AsyncGenerator<DiscoveryCandidate>` to `AsyncGenerator<ScanEvent>`. Replace `scanDirectory` import with `unifiedScan`. Update `packages/mesh/src/index.ts` barrel exports.

### Task 1.4: Update discovery route to use meshCore and fix default root

**Size**: Medium | **Priority**: High | **Dependencies**: 1.3 | **Parallel with**: 1.5

Fix the critical bug: default scan root changes from `DEFAULT_CWD` to `getBoundary()` (home directory). Route factory now requires `meshCore` parameter. Support `roots: string[]` in request schema. Filter `auto-import` events from SSE output.

### Task 1.5: Update mesh route and MCP tool to filter ScanEvent

**Size**: Small | **Priority**: High | **Dependencies**: 1.3 | **Parallel with**: 1.4

Update `POST /api/mesh/discover` and `mesh_discover` MCP tool to filter `ScanEvent` for `candidate` type only, since `meshCore.discover()` now returns `ScanEvent` instead of `DiscoveryCandidate`.

### Task 1.6: Delete old scanners and their tests

**Size**: Small | **Priority**: High | **Dependencies**: 1.4, 1.5 | **Parallel with**: None

Delete Scanner A (`discovery-scanner.ts` + test), Scanner B (`discovery-engine.ts`). Remove stale imports. Verify typecheck and tests pass.

## Phase 2: Transport and Client Unification

### Task 2.1: Add scan types to shared schemas and Transport interface

**Size**: Small | **Priority**: High | **Dependencies**: 1.1 | **Parallel with**: None

Add `ScanProgressSchema`, `TransportScanEvent`, `TransportScanOptions` to `mesh-schemas.ts`. Add `scan()` method to the `Transport` interface in `transport.ts`.

### Task 2.2: Implement scan() in HttpTransport and DirectTransport

**Size**: Medium | **Priority**: High | **Dependencies**: 2.1, 1.6 | **Parallel with**: None

HttpTransport: SSE stream parsing with event/data line handling. DirectTransport: delegate to `meshCore.discover()` in-process. Update `createMockTransport()` with `scan` mock.

### Task 2.3: Create shared discovery entity with Zustand store and hook

**Size**: Medium | **Priority**: High | **Dependencies**: 2.1 | **Parallel with**: 2.2

Create `entities/discovery/` FSD module with Zustand store (`useDiscoveryStore`) tracking candidates, progress, isScanning, error, lastScanAt. Shared `useDiscoveryScan` hook wraps `transport.scan()` with AbortController support. 4 store unit tests.

### Task 2.4: Update onboarding UI to use shared discovery hook

**Size**: Medium | **Priority**: High | **Dependencies**: 2.3 | **Parallel with**: 2.5

Replace old `use-discovery-scan.ts` in onboarding with shared hook. Update `AgentCard` to use canonical `DiscoveryCandidate` type (derive name from `hints.name ?? basename(path)`, show strategy instead of markers). Delete old hook file.

### Task 2.5: Update mesh panel DiscoveryView to use shared discovery hook

**Size**: Medium | **Priority**: High | **Dependencies**: 2.3 | **Parallel with**: 2.4

Replace batch `useDiscoverAgents` with streaming `useDiscoveryScan`. Results now appear progressively. Add progress display. Delete old `use-mesh-discover.ts`. Shared state: onboarding scan results visible in mesh panel.

## Phase 3: Cleanup and Documentation

### Task 3.1: Remove unused imports, types, and update documentation

**Size**: Medium | **Priority**: Medium | **Dependencies**: 2.4, 2.5 | **Parallel with**: None

Final cleanup: remove stale references to deleted files, update AGENTS.md FSD layers table with `entities/discovery/`, update `contributing/architecture.md` with unified discovery system docs. Run full typecheck, test, and lint passes.
