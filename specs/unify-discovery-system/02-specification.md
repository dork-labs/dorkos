# Unify Discovery System

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-06
**Spec:** #94

---

## Overview

Unify the two separate agent discovery systems (onboarding SSE scan and mesh panel batch scan) into a single canonical implementation. Fix the critical bug where onboarding scans the wrong directory (project root instead of home directory), causing users to see "No agents found" on first run.

Consolidate the three separate discovery UI experiences — the onboarding `AgentDiscoveryStep` (checkbox selection), the mesh panel's inline `DiscoverAgentsSection` (checkbox selection via "Discover Agents" button), and the mesh panel's `DiscoveryView` tab (approve/deny per-agent) — into a single discovery interaction model. One way to discover agents. The best way.

## Background / Problem Statement

Two independent discovery scanners exist with overlapping functionality:

**Scanner A** (`apps/server/src/services/discovery/discovery-scanner.ts`):

- Standalone BFS async generator (`scanForAgents`)
- Own `DiscoveryCandidate` type (different from `@dorkos/shared/mesh-schemas`)
- 14 exclude patterns including `Library`, `AppData`, `.Trash`, `.npm`, `.nvm`, `.local`, `.cargo`, `.rustup`, `go/pkg`
- No strategy pattern, no registered/denied filtering
- Detects markers directly: `AGENTS.md`, `.claude`, `.cursor`, `.github/copilot`, `.dork/agent.json`
- Yields `ScanEvent` with `candidate`, `progress`, `complete` types
- Has timeout support (30s default)

**Scanner B** (`packages/mesh/src/discovery-engine.ts`):

- BFS async generator (`scanDirectory`) with pluggable `DiscoveryStrategy` instances
- Uses canonical `DiscoveryCandidate` from `@dorkos/shared/mesh-schemas`
- 11 exclude patterns including `__pycache__`, `.venv`, `venv`, `.tox`, `extensions`
- Filters registered and denied paths via `RegistryLike` / `DenialListLike` interfaces
- Supports symlink following with cycle detection via `realpathSync()`
- Auto-imports existing `.dork/agent.json` manifests
- No timeout, no progress events

**The bug:** The onboarding flow (`AgentDiscoveryStep.tsx`) calls `startScan()` with no arguments. `use-discovery-scan.ts` sends an empty body to `POST /api/discovery/scan`. The route falls back to `DEFAULT_CWD` (the DorkOS project root, not the user's home directory). The scan completes in <1 second with zero results.

**Additional issues:**

- `use-discovery-scan.ts` uses raw `fetch()`, bypassing the Transport abstraction
- Three copies of the `DiscoveryCandidate` shape exist (Scanner A's type, shared schema, onboarding hook's `ScanCandidate`)
- Scan results are not shared between onboarding and mesh panel — each maintains separate state
- The Transport interface has `discoverMeshAgents()` (batch JSON) but no streaming scan method

**UI duplication — three discovery experiences with different interaction models:**

The mesh panel has _two_ entirely separate discovery surfaces, plus onboarding has a third:

1. **"Discover Agents" button** (inline `DiscoverAgentsSection` in `MeshPanel.tsx:143-253`) — Uses the onboarding `AgentCard` component with checkbox toggle. No deny action. Batch "Register N agents" button. Hidden behind a collapsible panel toggle.

2. **"Discovery" tab** (`DiscoveryView.tsx` with `CandidateCard`) — Explicit Approve/Deny buttons per agent. Cards animate away after action. Denied agents appear in the "Denied" tab. Advanced scan configuration (roots, depth). HoverCard on runtime badge shows detection strategy. Per-capability tooltips.

3. **Onboarding** (`AgentDiscoveryStep.tsx` with onboarding `AgentCard`) — All candidates auto-selected by default. Checkbox toggle to deselect. Batch confirm. No deny flow. Auto-starts on mount. Staggered entrance animations.

This violates the core design principle: _"Say no to a thousand things."_ Two discovery buttons in the same panel means the team couldn't commit to one approach. The checkbox model hides the deny concept entirely — you just "don't select" something, but nothing gets recorded in the denied list. The approve/deny model is more honest: it tells the user exactly what each action means.

## Goals

### Backend Unification

- Fix the onboarding scan to use the correct default root (boundary/home directory)
- Consolidate to a single scanner implementation combining the best of both
- Add `scan()` to the Transport interface for both HttpTransport and DirectTransport
- Share scan results across features via a Zustand store in `entities/discovery/`
- Eliminate duplicate type definitions — use canonical `DiscoveryCandidate` from `@dorkos/shared/mesh-schemas`
- Maintain SSE streaming for progressive results in all consumers
- Keep `POST /api/mesh/discover` as a backward-compatible thin wrapper

### UI Consolidation

- **Delete `DiscoverAgentsSection`** and the "Discover Agents" button from the mesh panel — the Discovery tab is the single entry point
- **Converge on the approve/deny interaction model** (`CandidateCard`) as the single discovery card — replaces the checkbox-selection `AgentCard` from onboarding
- **Update onboarding** to use `CandidateCard` with approve/deny instead of checkbox selection — registering an agent to your mesh deserves a deliberate per-agent decision
- **Eliminate the cross-feature import** of `AgentCard` from onboarding into mesh (`import { AgentCard as OnboardingAgentCard }`)
- **Preserve streaming UX** — candidates appear progressively as discovered (from onboarding's existing pattern), with staggered entrance animations

## Non-Goals

- Smart probing of common developer directories (~/Developer, ~/Projects, etc.) — follow-up feature
- `requestAnimationFrame` batching for high-frequency scan results — future optimization
- Incremental re-scanning based on filesystem stat mtimes
- Windows-specific developer directory paths
- Per-root scan status in settings UI
- Caching scan results with staleness tracking
- A "select all / batch register" mode — per-agent approve/deny is the deliberate interaction model

## Technical Dependencies

- `@dorkos/shared` — canonical `DiscoveryCandidate` type, Transport interface, Zod schemas
- `@dorkos/mesh` — discovery strategies, agent registry, denial list
- `zustand` — shared discovery store (already a project dependency)
- `@dorkos/db` — SQLite for mesh agent registry (existing)

No new external dependencies required.

## Detailed Design

### 1. Unified Scanner (`packages/mesh/src/discovery/unified-scanner.ts`)

The unified scanner combines Scanner B's strategy pattern and registry/denial filtering with Scanner A's comprehensive exclude list, timeout support, and progress events.

**New types (added to `packages/mesh/src/discovery/types.ts`):**

```typescript
/** Events yielded by the unified scanner. */
export type ScanEvent =
  | { type: 'candidate'; data: DiscoveryCandidate }
  | { type: 'auto-import'; data: { manifest: AgentManifest; path: string } }
  | { type: 'progress'; data: ScanProgress }
  | { type: 'complete'; data: ScanProgress & { timedOut: boolean } };

export interface ScanProgress {
  scannedDirs: number;
  foundAgents: number;
}

export interface UnifiedScanOptions {
  /** Root directory to scan. */
  root: string;
  /** Maximum BFS depth (default: 5). */
  maxDepth?: number;
  /** Scan timeout in ms (default: 30000). */
  timeout?: number;
  /** Follow symlinks with cycle detection (default: false). */
  followSymlinks?: boolean;
  /** Additional exclude patterns beyond the defaults. */
  extraExcludes?: string[];
  /** Logger for warnings. */
  logger?: import('@dorkos/shared/logger').Logger;
}
```

**Unified exclude set** (superset of both scanners):

```typescript
export const UNIFIED_EXCLUDE_PATTERNS = new Set([
  // From Scanner A
  'node_modules',
  '.git',
  'vendor',
  'Library',
  'AppData',
  '.Trash',
  'dist',
  'build',
  '.cache',
  '.npm',
  '.nvm',
  '.local',
  '.cargo',
  '.rustup',
  'go/pkg',
  // From Scanner B (additions)
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.DS_Store',
  'extensions',
]);
```

**Scanner function signature:**

```typescript
export async function* unifiedScan(
  options: UnifiedScanOptions,
  strategies: DiscoveryStrategy[],
  registry: RegistryLike,
  denialList: DenialListLike,
): AsyncGenerator<ScanEvent>
```

The scanner combines:

- Scanner B's strategy-based detection (`strategy.detect()` + `strategy.extractHints()`)
- Scanner B's registered/denied path filtering
- Scanner B's symlink cycle detection via `realpathSync()`
- Scanner B's auto-import of `.dork/agent.json` manifests
- Scanner A's timeout support
- Scanner A's periodic progress events (every 100 directories)
- Scanner A's `complete` event with `timedOut` flag
- The unified exclude set

### 2. MeshCore Integration

`MeshCore.discover()` will delegate to `unifiedScan()` instead of `scanDirectory()`:

```typescript
async *discover(
  roots: string[],
  options?: Partial<UnifiedScanOptions>,
): AsyncGenerator<ScanEvent> {
  for (const root of roots) {
    yield* unifiedScan(
      { root, ...options },
      this.strategies,
      this.registry,
      this.denialList,
    );
  }
}
```

The return type changes from `AsyncGenerator<DiscoveryCandidate>` to `AsyncGenerator<ScanEvent>`. This is a breaking change within the package but all callers are internal. The mesh route and MCP tool filter for `candidate` type events.

### 3. Transport Interface Extension

Add a `scan()` method to the `Transport` interface in `packages/shared/src/transport.ts`:

```typescript
// Add to mesh-schemas imports:
import type { ScanProgress } from './mesh-schemas.js';

// Add ScanEvent and ScanOptions to mesh-schemas.ts:
export const ScanProgressSchema = z.object({
  scannedDirs: z.number(),
  foundAgents: z.number(),
});
export type ScanProgress = z.infer<typeof ScanProgressSchema>;

export type TransportScanEvent =
  | { type: 'candidate'; data: DiscoveryCandidate }
  | { type: 'progress'; data: ScanProgress }
  | { type: 'complete'; data: ScanProgress & { timedOut: boolean } }
  | { type: 'error'; data: { error: string } };

export interface TransportScanOptions {
  roots: string[];
  maxDepth?: number;
  timeout?: number;
}

// Add to Transport interface:
export interface Transport {
  // ... existing methods ...

  /** Stream discovery scan results progressively. */
  scan(
    options: TransportScanOptions,
    onEvent: (event: TransportScanEvent) => void,
    signal?: AbortSignal
  ): Promise<void>;
}
```

Note: The transport-level `TransportScanEvent` omits `auto-import` (that's an internal mesh concern handled server-side). It adds `error` for transport-level error reporting.

**HttpTransport implementation** (`apps/client/src/layers/shared/lib/http-transport.ts`):

```typescript
async scan(
  options: TransportScanOptions,
  onEvent: (event: TransportScanEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const response = await fetch(`${this.baseUrl}/api/discovery/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options),
    signal,
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText }));
    throw new Error(body.error ?? `HTTP ${response.status}`);
  }

  // Parse SSE stream
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    let eventType = '';
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ') && eventType) {
        const data = JSON.parse(line.slice(6));
        onEvent({ type: eventType, data } as TransportScanEvent);
        eventType = '';
      }
    }
  }
}
```

**DirectTransport implementation** (`apps/client/src/layers/shared/lib/direct-transport.ts`):

```typescript
async scan(
  options: TransportScanOptions,
  onEvent: (event: TransportScanEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  // Import scanner directly for in-process execution
  for (const root of options.roots) {
    for await (const event of unifiedScan(
      { root, maxDepth: options.maxDepth, timeout: options.timeout },
      this.strategies,
      this.registry,
      this.denialList,
    )) {
      if (signal?.aborted) return;
      if (event.type !== 'auto-import') {
        onEvent(event as TransportScanEvent);
      }
    }
  }
}
```

### 4. Discovery Route Update (`apps/server/src/routes/discovery.ts`)

Update to use the unified scanner and fix the default root:

```typescript
import { getBoundary } from '../lib/boundary.js';

router.post('/scan', async (req, res) => {
  const data = parseBody(ScanRequestSchema, req.body, res);
  if (!data) return;

  // Default to boundary (home dir) instead of DEFAULT_CWD
  const roots = data.roots ?? (data.root ? [data.root] : [getBoundary()]);

  // ... boundary validation for each root ...

  // Use meshCore's unified scanner
  for await (const event of meshCore.discover(roots, {
    maxDepth: data.maxDepth,
    timeout: data.timeout,
  })) {
    if (res.writableEnded) break;
    // Filter auto-import events (internal to mesh)
    if (event.type === 'auto-import') continue;
    res.write(`event: ${event.type}\n`);
    res.write(`data: ${JSON.stringify(event.data)}\n\n`);
  }
});
```

The `ScanRequestSchema` is updated to accept `roots: string[]` (array) in addition to the existing `root: string` (single). Both default to the boundary when not provided.

The discovery route now requires a `MeshCore` dependency — `createDiscoveryRouter(meshCore)` instead of `createDiscoveryRouter()`.

### 5. Mesh Batch Endpoint (Thin Wrapper)

`POST /api/mesh/discover` stays as-is but now delegates to the same unified scanner via `meshCore.discover()`. The existing implementation already does this — the only change is that `meshCore.discover()` now returns `ScanEvent` instead of `DiscoveryCandidate`, so the route filters for `candidate` type:

```typescript
for await (const event of meshCore.discover(validatedRoots, options)) {
  if (event.type === 'candidate') {
    candidates.push(event.data);
  }
  if (candidates.length >= MAX_CANDIDATES) break;
}
```

### 6. Shared Discovery Store (`entities/discovery/`)

New FSD entity module at `apps/client/src/layers/entities/discovery/`:

```
entities/discovery/
├── model/
│   ├── discovery-store.ts   # Zustand store
│   └── use-discovery-scan.ts # Shared hook
├── index.ts                 # Barrel exports
```

**discovery-store.ts:**

```typescript
import { create } from 'zustand';
import type {
  DiscoveryCandidate,
  ScanProgress,
  TransportScanEvent,
} from '@dorkos/shared/mesh-schemas';

interface DiscoveryState {
  candidates: DiscoveryCandidate[];
  progress: ScanProgress | null;
  isScanning: boolean;
  error: string | null;
  lastScanAt: number | null;
}

interface DiscoveryActions {
  addCandidate: (candidate: DiscoveryCandidate) => void;
  setProgress: (progress: ScanProgress) => void;
  startScan: () => void;
  completeScan: (progress: ScanProgress) => void;
  setError: (error: string) => void;
  clear: () => void;
}

export const useDiscoveryStore = create<DiscoveryState & DiscoveryActions>((set) => ({
  candidates: [],
  progress: null,
  isScanning: false,
  error: null,
  lastScanAt: null,

  addCandidate: (candidate) => set((state) => ({ candidates: [...state.candidates, candidate] })),
  setProgress: (progress) => set({ progress }),
  startScan: () => set({ candidates: [], progress: null, error: null, isScanning: true }),
  completeScan: (progress) => set({ progress, isScanning: false, lastScanAt: Date.now() }),
  setError: (error) => set({ error, isScanning: false }),
  clear: () => set({ candidates: [], progress: null, error: null, lastScanAt: null }),
}));
```

**use-discovery-scan.ts:**

```typescript
import { useCallback, useRef } from 'react';
import { useTransport } from '@/layers/shared/model';
import { useMeshScanRoots } from '@/layers/entities/mesh';
import { useDiscoveryStore } from './discovery-store';

export function useDiscoveryScan() {
  const transport = useTransport();
  const { roots } = useMeshScanRoots();
  const store = useDiscoveryStore();
  const abortRef = useRef<AbortController | null>(null);

  const scan = useCallback(
    (overrideRoots?: string[], maxDepth?: number) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      store.startScan();

      const scanRoots = overrideRoots ?? roots;
      if (scanRoots.length === 0) {
        // No roots configured — server will use boundary default
      }

      void transport
        .scan(
          { roots: scanRoots, maxDepth },
          (event) => {
            switch (event.type) {
              case 'candidate':
                store.addCandidate(event.data);
                break;
              case 'progress':
                store.setProgress(event.data);
                break;
              case 'complete':
                store.completeScan(event.data);
                break;
              case 'error':
                store.setError(event.data.error);
                break;
            }
          },
          controller.signal
        )
        .catch((err) => {
          if (err.name !== 'AbortError') {
            store.setError(err.message);
          }
        });
    },
    [transport, roots, store]
  );

  return {
    candidates: store.candidates,
    isScanning: store.isScanning,
    progress: store.progress,
    error: store.error,
    lastScanAt: store.lastScanAt,
    scan,
  };
}
```

### 7. UI Consolidation — Single Discovery Experience

The UI consolidation eliminates two of the three discovery surfaces and converges on a single interaction model.

#### 7a. Delete `DiscoverAgentsSection` and "Discover Agents" button

Remove entirely from `MeshPanel.tsx`:

- The `DiscoverAgentsSection` component (lines 143-253) — deleted
- The `showQuickDiscover` state and toggle button (lines 299, 364-372)
- The `AnimatePresence` wrapper for the inline panel (lines 375-388)
- The `import { AgentCard as OnboardingAgentCard } from '@/layers/features/onboarding'` cross-feature import

The Discovery tab and Mode A fullbleed are sufficient entry points. Users who have registered agents access discovery via the tab. Users with zero agents see the fullbleed discovery view automatically.

#### 7b. Converge on approve/deny interaction model (`CandidateCard`)

`CandidateCard` becomes the single discovery card used everywhere:

1. **Move `CandidateCard` to `entities/discovery/`** — it's shared infrastructure, not a mesh-specific feature. The component itself is stateless and generic. New location: `apps/client/src/layers/entities/discovery/ui/CandidateCard.tsx`.

2. **Enhance `CandidateCard` for streaming context:**
   - Add staggered entrance animation (from onboarding's `AgentCard` pattern — `motion.div` with `initial={{ opacity: 0, y: 8 }}`)
   - Keep HoverCard on runtime badge and per-capability Tooltips (these are superior to onboarding's plain badges)

3. **Add a "Skip" action as alternative to "Deny"** — During onboarding, explicit denial may feel too aggressive for first-time users. Add a subtle "Skip" option that neither registers nor denies — just dismisses the card for this session. The `actedPaths` pattern from `DiscoveryView` handles this naturally (filter from visible list, but don't persist a denial record).

Updated `CandidateCard` props:

```typescript
interface CandidateCardProps {
  candidate: DiscoveryCandidate;
  onApprove: (candidate: DiscoveryCandidate) => void;
  onDeny?: (candidate: DiscoveryCandidate) => void;
  onSkip?: (candidate: DiscoveryCandidate) => void;
}
```

When `onDeny` is provided (mesh Discovery tab), show the red "Deny" button. When only `onSkip` is provided (onboarding), show a subtle "Skip" text button instead. When both are provided, show both. This lets the interaction adapt to context without requiring a mode prop or separate components.

#### 7c. Update onboarding `AgentDiscoveryStep`

Replace the checkbox-selection model with per-agent approve/skip:

```diff
- import { AgentCard } from './AgentCard';
+ import { CandidateCard } from '@/layers/entities/discovery';
```

**Before:** All candidates auto-selected. User deselects unwanted ones. Clicks "Register N agents" to batch-confirm. "Continue without registering" skips all.

**After:** Candidates stream in with staggered animation. Each card has "Approve" and "Skip" buttons. Approved agents register immediately (one-by-one, with a subtle success animation). Skipped cards dismiss. A "Continue" button appears when all candidates have been acted on (or at any time, to skip remaining).

This is more honest — each agent gets a deliberate decision. It also removes the cognitive overhead of "wait, are the checked ones the ones being registered or the ones being skipped?"

Changes to `AgentDiscoveryStep.tsx`:

- Remove `selectedPaths` state (no more checkbox tracking)
- Remove `handleToggle`, bulk select/deselect logic
- Add `actedPaths` state (same pattern as `DiscoveryView`)
- Replace `AgentCard` with `CandidateCard` in render
- Replace batch "Register N agents" button with a "Continue" button that appears when all candidates have been acted on, or always visible as "Skip remaining & continue"
- Keep auto-start scan on mount
- Keep staggered entrance animations
- Keep "No agents found" state with guided creation

#### 7d. Delete onboarding `AgentCard`

After convergence, the onboarding `AgentCard` component is no longer used:

- Delete `apps/client/src/layers/features/onboarding/ui/AgentCard.tsx`
- Remove from `apps/client/src/layers/features/onboarding/index.ts` barrel exports
- Also delete `useSpotlight` hook if it was only used by `AgentCard`

#### 7e. Update `DiscoveryView` hook imports

```diff
- import { useDiscoverAgents, useMeshScanRoots, ... } from '@/layers/entities/mesh';
+ import { useDiscoveryScan, CandidateCard } from '@/layers/entities/discovery';
+ import { useMeshScanRoots, ... } from '@/layers/entities/mesh';
```

The `discover()` mutation is replaced with `scan()` from the shared hook. Results come from the Zustand store (progressive) instead of a mutation response (batch). `CandidateCard` import moves from local to `entities/discovery/`.

### 8. File Changes Summary

**Files to CREATE:**
| File | Purpose |
|------|---------|
| `packages/mesh/src/discovery/unified-scanner.ts` | Unified BFS scanner |
| `packages/mesh/src/discovery/types.ts` | ScanEvent, ScanProgress, UnifiedScanOptions |
| `packages/mesh/src/discovery/index.ts` | Barrel exports |
| `apps/client/src/layers/entities/discovery/model/discovery-store.ts` | Zustand store |
| `apps/client/src/layers/entities/discovery/model/use-discovery-scan.ts` | Shared hook |
| `apps/client/src/layers/entities/discovery/ui/CandidateCard.tsx` | Unified discovery card (moved from mesh feature) |
| `apps/client/src/layers/entities/discovery/index.ts` | Barrel exports |

**Files to DELETE:**
| File | Reason |
|------|--------|
| `apps/server/src/services/discovery/discovery-scanner.ts` | Replaced by unified scanner |
| `apps/client/src/layers/features/onboarding/model/use-discovery-scan.ts` | Replaced by shared hook |
| `apps/client/src/layers/features/onboarding/ui/AgentCard.tsx` | Replaced by shared `CandidateCard` |
| `apps/client/src/layers/features/mesh/ui/CandidateCard.tsx` | Moved to `entities/discovery/` |
| `apps/client/src/layers/entities/mesh/model/use-mesh-discover.ts` | Replaced by shared hook |

**Files to MODIFY:**
| File | Change |
|------|--------|
| `packages/mesh/src/discovery-engine.ts` | Delete (logic moved to unified-scanner.ts) |
| `packages/mesh/src/mesh-core.ts` | `discover()` delegates to `unifiedScan()`, returns `ScanEvent` |
| `packages/mesh/src/index.ts` | Re-export from `discovery/` |
| `packages/shared/src/transport.ts` | Add `scan()` method to Transport interface |
| `packages/shared/src/mesh-schemas.ts` | Add `ScanProgress`, `TransportScanEvent`, `TransportScanOptions` |
| `apps/client/src/layers/shared/lib/http-transport.ts` | Implement `scan()` via SSE |
| `apps/client/src/layers/shared/lib/direct-transport.ts` | Implement `scan()` via direct import |
| `apps/server/src/routes/discovery.ts` | Use unified scanner via meshCore, fix default root |
| `apps/server/src/routes/mesh.ts` | Filter `ScanEvent` for `candidate` type in batch endpoint |
| `apps/client/src/layers/features/onboarding/ui/AgentDiscoveryStep.tsx` | Replace AgentCard with CandidateCard, remove checkbox model, use shared hook |
| `apps/client/src/layers/features/onboarding/index.ts` | Remove `AgentCard` export |
| `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx` | Delete `DiscoverAgentsSection`, remove "Discover Agents" button, remove `OnboardingAgentCard` import |
| `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx` | Use shared hook, import CandidateCard from entities/discovery |
| `apps/client/src/layers/entities/mesh/index.ts` | Remove `useDiscoverAgents` export |
| `apps/server/src/services/core/mcp-tools/mesh-tools.ts` | Filter `ScanEvent` for `candidate` type |
| `@dorkos/test-utils` | Add `createMockTransport` scan method |

## User Experience

### Onboarding (first-time user)

1. User starts DorkOS for the first time
2. Clicks "Get Started" in the onboarding flow
3. Scan auto-starts, searching from the home directory
4. Agent cards appear progressively as they're discovered (staggered entrance animation)
5. Progress indicator shows "Scanned N directories, found M agents"
6. Each card has **Approve** (green) and **Skip** (subtle) buttons — one agent at a time
7. Approved agents register immediately with a subtle success indicator
8. Skipped agents disappear from the list (no denial record — just session-local dismissal)
9. A "Continue" button is always visible ("Skip remaining & continue") and becomes primary when all candidates have been acted on
10. No "Select all" / batch mode — each agent deserves a deliberate decision

### Mesh Panel — Mode A (zero agents)

1. The fullbleed `DiscoveryView` is shown automatically — same card component, same interaction model
2. Each card has **Approve** (green) and **Deny** (red) buttons
3. Denied agents are persisted and appear in the "Denied" tab
4. Advanced scan configuration available (roots, depth)

### Mesh Panel — Mode B (has agents)

1. The Discovery **tab** is the single entry point for new discovery — no "Discover Agents" button
2. Same `CandidateCard` with Approve/Deny, same progressive streaming
3. Results from onboarding are immediately visible if the Zustand store still holds them

### Shared State

- Onboarding scan → results available in mesh panel without re-scan
- Mesh panel scan → results available if user navigates back to onboarding
- "Re-scan" in either UI clears and re-scans

### Interaction Model Summary

| Context        | Approve           | Reject          | Effect                                                              |
| -------------- | ----------------- | --------------- | ------------------------------------------------------------------- |
| Onboarding     | "Approve" (green) | "Skip" (subtle) | Approve registers immediately. Skip dismisses card (session-local). |
| Mesh Discovery | "Approve" (green) | "Deny" (red)    | Approve registers immediately. Deny persists a `DenialRecord`.      |

## Testing Strategy

### Unit Tests

**`packages/mesh/src/discovery/__tests__/unified-scanner.test.ts`:**

- Yields `candidate` events for directories matching strategies
- Yields `auto-import` events for directories with `.dork/agent.json`
- Skips denied paths entirely (no traversal)
- Skips registered paths as candidates (still traverses children)
- Respects `maxDepth` limit
- Emits `progress` events every 100 directories
- Emits `complete` event with `timedOut: true` when timeout exceeded
- Uses unified exclude set (all patterns from both scanners)
- Detects symlink cycles via realpath comparison
- Handles EACCES/EPERM errors gracefully (skip and continue)

**`apps/client/src/layers/entities/discovery/__tests__/use-discovery-scan.test.ts`:**

- Calls `transport.scan()` with provided roots
- Falls back to configured scan roots from `useMeshScanRoots`
- Updates Zustand store with candidate, progress, complete events
- Handles abort/cancel via AbortController
- Sets error state on transport failure

**`apps/client/src/layers/entities/discovery/__tests__/discovery-store.test.ts`:**

- `startScan()` clears previous results and sets `isScanning`
- `addCandidate()` appends to candidates array
- `completeScan()` sets `lastScanAt` and clears `isScanning`
- `clear()` resets all state

### Integration Tests

**`apps/server/src/routes/__tests__/discovery.test.ts`** (update existing):

- SSE stream uses unified scanner via meshCore
- Default root is boundary (home dir) when no root provided
- `roots` array parameter works
- Boundary validation rejects paths outside boundary

### Tests to Delete

- `apps/server/src/services/discovery/__tests__/discovery-scanner.test.ts` — Scanner A is deleted

### Mocking Strategy

- Server tests: mock `meshCore.discover()` as an async generator
- Client tests: mock `transport.scan()` to call `onEvent` with test events
- Discovery store tests: test Zustand store actions directly
- Test utils: `createMockTransport()` gets a `scan` method that accepts an array of events to emit

## Performance Considerations

- **Home directory scanning**: Scanning from `$HOME` can touch 5,000-50,000 directories. The 30-second timeout (from Scanner A) prevents indefinite scans. Progress events every 100 directories provide feedback.
- **Zustand store updates**: Each `addCandidate` call triggers a re-render. For fast scans yielding many results, this is acceptable — `requestAnimationFrame` batching is deferred as a future optimization.
- **Symlink cycle detection**: `realpathSync()` adds per-directory overhead but prevents infinite loops. This is inherited from Scanner B.
- **Memory**: The visited set grows with scanned directories but is bounded by timeout and maxDepth.

## Security Considerations

- All scan roots are validated against the directory boundary (`isWithinBoundary`)
- The boundary defaults to `os.homedir()`, preventing scans outside the user's home
- EACCES/EPERM errors are silently skipped (no information leakage about restricted directories)
- The scanner does not read file contents — only checks for marker existence via `fs.access()`

## Documentation

- Update `contributing/architecture.md` — document unified discovery system and Transport `scan()` method
- Update `AGENTS.md` — update the discovery-scanner and discovery-engine entries, add `entities/discovery/` to FSD layers table

## Implementation Phases

### Phase 1: Unified Scanner + Bug Fix

1. Create `packages/mesh/src/discovery/unified-scanner.ts` with unified exclude set, timeout, progress events
2. Create `packages/mesh/src/discovery/types.ts` and barrel
3. Update `MeshCore.discover()` to use `unifiedScan()`
4. Update `routes/discovery.ts` to use meshCore and default to boundary
5. Update `routes/mesh.ts` discover endpoint to filter `ScanEvent`
6. Delete Scanner A (`discovery-scanner.ts`)
7. Delete Scanner B (`discovery-engine.ts`)
8. Update MCP `mesh_discover` tool
9. Update server tests

### Phase 2: Transport + Client Unification

1. Add `TransportScanEvent`, `TransportScanOptions`, `ScanProgress` to shared schemas
2. Add `scan()` to Transport interface
3. Implement `scan()` in HttpTransport (SSE parsing)
4. Implement `scan()` in DirectTransport (direct scanner import)
5. Create `entities/discovery/` with Zustand store and shared hook
6. Move `CandidateCard` from `features/mesh/ui/` to `entities/discovery/ui/` — add `onSkip` prop, add staggered entrance animation
7. Update `DiscoveryView.tsx` to use shared hook and import CandidateCard from `entities/discovery/`
8. Delete old `use-discovery-scan.ts` and `use-mesh-discover.ts`
9. Update `createMockTransport()` with `scan` method
10. Update client tests

### Phase 3: UI Consolidation

1. Update `AgentDiscoveryStep.tsx` — replace `AgentCard` with `CandidateCard`, remove checkbox selection model, use per-agent approve/skip
2. Delete onboarding `AgentCard.tsx` and remove from barrel exports
3. Delete `DiscoverAgentsSection` from `MeshPanel.tsx` — remove "Discover Agents" button, `showQuickDiscover` state, `OnboardingAgentCard` import
4. Verify Discovery tab and Mode A fullbleed are the only discovery entry points
5. Update onboarding and mesh panel tests

### Phase 4: Cleanup

1. Remove unused imports and type definitions
2. Verify all tests pass
3. Update documentation

## Open Questions

_None — all decisions have been resolved during ideation._

## Related ADRs

- **ADR-0023**: Use Custom Async BFS for Agent Discovery — establishes the BFS async generator pattern
- **ADR-0055 (draft)**: Use SSE Streaming for Filesystem Discovery Results — establishes SSE streaming for discovery

## References

- Ideation: `specs/unify-discovery-system/01-ideation.md`
- Research: `research/20260306_filesystem_discovery_unification.md`
- Scanner A: `apps/server/src/services/discovery/discovery-scanner.ts`
- Scanner B: `packages/mesh/src/discovery-engine.ts`
- Transport interface: `packages/shared/src/transport.ts`
