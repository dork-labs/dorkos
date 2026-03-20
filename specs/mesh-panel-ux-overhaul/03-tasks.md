# Task Breakdown: Mesh Panel UI/UX Overhaul

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-02-25
**Mode:** Full decomposition

---

## Summary

8 tasks across 4 phases. Transforms the Mesh Panel from a passive, tab-heavy interface into a progressive disclosure system with two visual modes (Mode A: Discovery-only for zero agents, Mode B: full tabbed interface when agents exist).

| Phase | Name                    | Tasks | Size         |
| ----- | ----------------------- | ----- | ------------ |
| 1     | Config + API Foundation | 3     | 1S + 1S + 1M |
| 2     | Discovery Components    | 3     | 1M + 1S + 1L |
| 3     | MeshPanel Rewrite       | 1     | 1L           |
| 4     | Tests + Polish          | 2     | 1L + 1M      |

---

## Phase 1: Config + API Foundation

### 1.1 Add scanRoots to mesh config schema (S)

**File:** `packages/shared/src/config-schema.ts`

Extend the `mesh` config object to include `scanRoots: z.array(z.string()).default(() => [])`. When empty, the UI falls back to the server boundary as the initial root.

**Parallel with:** 1.2

---

### 1.2 Expose boundary in GET /api/config response (S)

**File:** `apps/server/src/routes/config.ts`

Import `getBoundary` from `lib/boundary.ts` and add `boundary: getBoundary()` to the GET handler response. This gives the client the resolved boundary path for pre-filling the Discovery input.

**Parallel with:** 1.1

---

### 1.3 Create useMeshScanRoots entity hook (M)

**New file:** `apps/client/src/layers/entities/mesh/model/use-mesh-scan-roots.ts`
**Modified:** `apps/client/src/layers/entities/mesh/index.ts` (add export)

Hook that reads saved scan roots from config via `transport.getConfig()` and provides the server boundary as a fallback default. Includes a `saveScanRoots` mutation that persists roots to config via `transport.updateConfig()`.

Returns: `{ defaultRoots, boundary, savedRoots, saveScanRoots }`

**Depends on:** 1.1, 1.2

---

## Phase 2: Discovery Components

### 2.1 Create ScanRootInput chip/tag component (M)

**New file:** `apps/client/src/layers/features/mesh/ui/ScanRootInput.tsx`
**New file:** `apps/client/src/layers/features/mesh/ui/__tests__/ScanRootInput.test.tsx`

Chip/tag input for managing scan root paths. Renders each root as a `Badge` with remove button. Supports adding paths via text input (Enter/comma) and via `DirectoryPicker`. Deduplicates paths silently.

**Depends on:** 1.3 | **Parallel with:** 2.2, 2.3

---

### 2.2 Create MeshEmptyState reusable component (S)

**New file:** `apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx`
**New file:** `apps/client/src/layers/features/mesh/ui/__tests__/MeshEmptyState.test.tsx`

Reusable empty state card with icon, headline, description, and optional CTA button. Used for contextual empty states in Agents tab ("No agents registered yet" + "Go to Discovery"), Denied tab ("No blocked paths"), and Access tab ("Cross-project access requires multiple namespaces").

**Parallel with:** 2.1, 2.3

---

### 2.3 Create DiscoveryView component extracted from MeshPanel (L)

**New file:** `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx`
**New file:** `apps/client/src/layers/features/mesh/ui/__tests__/DiscoveryView.test.tsx`

Extracted from the inline `DiscoveryTab` in MeshPanel. Supports two layouts via `fullBleed` prop:

- **Mode A (fullBleed):** Centered hero with Radar icon, headline, scan input, advanced options, results
- **Mode B (compact):** Just scan input and results

Uses `ScanRootInput` for path management and `useMeshScanRoots` for config persistence. Includes "Advanced options" progressive disclosure with scan depth slider (1-5, default 3).

**Depends on:** 1.3 | **Parallel with:** 2.1, 2.2

---

## Phase 3: MeshPanel Rewrite

### 3.1 Refactor MeshPanel for Mode A/B conditional rendering (L)

**Modified:** `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`
**Modified:** `apps/client/src/layers/features/mesh/index.ts` (add new exports)

Major rewrite of MeshPanel:

- **Mode A** (no agents): Renders `<DiscoveryView fullBleed />` only. No tabs, no stats header.
- **Mode B** (agents exist): Full tabbed interface with controlled tab state, AnimatePresence transitions, contextual empty states using `MeshEmptyState`.
- Controlled `Tabs` with `value={activeTab}` for CTA-driven tab switching (empty state "Go to Discovery" buttons).
- AnimatePresence wraps stats header + tab bar for Mode A to Mode B transition.

**Depends on:** 2.1, 2.2, 2.3

---

## Phase 4: Tests + Polish

### 4.1 Update MeshPanel tests for Mode A/B behavior (L)

**Modified:** `apps/client/src/layers/features/mesh/__tests__/MeshPanel.test.tsx`

Rewrite test suite to cover:

- Disabled state (unchanged)
- Mode A: No tablist, discovery headline visible, scan button visible
- Mode B: Tablist with 5 tabs, topology graph rendered
- Empty state CTAs: Contextual copy in Denied/Agents tabs
- Mocks for `useMeshScanRoots`, `motion/react`

**Depends on:** 3.1 | **Parallel with:** 4.2

---

### 4.2 Verify animation reduced-motion and config round-trip (M)

Final polish: verify `prefers-reduced-motion` is respected, config persistence round-trip works, and full monorepo checks pass (`pnpm typecheck`, `pnpm lint`, `pnpm test -- --run`).

**Depends on:** 3.1 | **Parallel with:** 4.1

---

## Dependency Graph

```
1.1 ──┐
      ├── 1.3 ──┬── 2.1 ──┐
1.2 ──┘         │          │
                ├── 2.3 ──┼── 3.1 ──┬── 4.1
                │          │         │
         2.2 ──────────────┘         ├── 4.2
```

## Files Changed

| File                                                                        | Action                   |
| --------------------------------------------------------------------------- | ------------------------ |
| `packages/shared/src/config-schema.ts`                                      | Modified (add scanRoots) |
| `apps/server/src/routes/config.ts`                                          | Modified (add boundary)  |
| `apps/client/src/layers/entities/mesh/model/use-mesh-scan-roots.ts`         | **New**                  |
| `apps/client/src/layers/entities/mesh/index.ts`                             | Modified (add export)    |
| `apps/client/src/layers/features/mesh/ui/ScanRootInput.tsx`                 | **New**                  |
| `apps/client/src/layers/features/mesh/ui/MeshEmptyState.tsx`                | **New**                  |
| `apps/client/src/layers/features/mesh/ui/DiscoveryView.tsx`                 | **New**                  |
| `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`                     | Modified (major rewrite) |
| `apps/client/src/layers/features/mesh/index.ts`                             | Modified (add exports)   |
| `apps/client/src/layers/features/mesh/__tests__/MeshPanel.test.tsx`         | Modified (rewrite)       |
| `apps/client/src/layers/features/mesh/ui/__tests__/ScanRootInput.test.tsx`  | **New**                  |
| `apps/client/src/layers/features/mesh/ui/__tests__/MeshEmptyState.test.tsx` | **New**                  |
| `apps/client/src/layers/features/mesh/ui/__tests__/DiscoveryView.test.tsx`  | **New**                  |
